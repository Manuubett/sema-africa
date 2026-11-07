// Class reminders by email and WhatsApp, about 24 hours and 1 hour before each booked lesson.
// Also: teacher morning summary (preview button).
const express = require('express');
const crypto = require('crypto');
const N = require('../lib/notify');

module.exports = (admin) => {
  const r = express.Router();
  const db = admin.firestore();
  const { FieldValue, Timestamp } = admin.firestore;
  const SITE = (process.env.SITE_URL || 'https://manuubett.github.io/sema-africa').replace(/\/+$/, '');
  const HOURS = Number(process.env.CANCEL_HOURS || 12);   // same setting the cancel/reschedule rules use
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let running = false;

  // Mark a reminder as sent BEFORE sending, so it can never go out twice.
  // The claim stores the student's id, so if the slot is freed and booked by someone else,
  // the new student still gets their own reminders.
  const claim = (lref, key) => db.runTransaction(async tx => {
    const s = await tx.get(lref), d = s.exists ? s.data() : null;
    if (!d || d.status !== 'booked' || (d.reminders && d.reminders[key] === d.studentId)) return false;
    tx.update(lref, { ['reminders.' + key]: d.studentId });
    return true;
  });

  async function run() {
    if (running) return { skipped: true };
    running = true;
    const out = { checked: 0, sent: 0, errors: 0 };
    try {
      const now = Date.now();
      const snap = await db.collection('lessons')
        .where('start', '>=', Timestamp.fromMillis(now))
        .where('start', '<=', Timestamp.fromMillis(now + 24 * 3600e3)).get();
      for (const doc of snap.docs) {
        const l = doc.data();
        if (l.status !== 'booked' || !l.studentId) continue;
        out.checked++;
        const key = l.start.toMillis() - now <= 3600e3 ? 'r1' : 'r24';
        if (!(await claim(doc.ref, key))) continue;

        const u = (await db.collection('users').doc(l.studentId).get()).data() || {};
        const when = N.formatWhen(l.start.toDate(), u.tz);
        const first = String(u.name || 'there').split(' ')[0];
        const ls = await db.collection('lessonLinks').doc(doc.id).get();
        const link = (ls.exists && ls.data().meetLink) || l.meetLink || SITE + '/student.html';
        const soon = key === 'r1' ? 'starts in about an hour' : 'is coming up';
        const late = key === 'r1';   // too close to move the class, so don't mention moving it
        let sent = false;

        if (u.remindEmail !== false && u.email && N.emailReady()) {
          const text = `Hujambo ${first}!\n\nYour SemaAfrica class ${soon}: ${when}.\nJoin here: ${link}` +
            (late ? '' : `\n\nNeed to move it? Open your dashboard at least ${HOURS} hours before class: ${SITE}/student.html`) +
            `\n\nKaribu sana!`;
          const html = `<p>Hujambo ${esc(first)}!</p><p>Your SemaAfrica class ${soon}:<br><strong>${esc(when)}</strong></p>` +
            `<p><a href="${esc(link)}" style="background:#C42B5B;color:#fff;padding:10px 18px;border-radius:20px;text-decoration:none">Join class</a></p>` +
            (late ? '' : `<p style="color:#555">Need to move it? <a href="${esc(SITE)}/student.html">Open your dashboard</a> at least ${HOURS} hours before class.</p>`) +
            `<p>Karibu sana!</p>`;
          try { await N.sendEmail(u.email, late ? 'Your Swahili class starts in about an hour' : 'Reminder: your Swahili class on ' + when, text, html); sent = true; }
          catch (e) { out.errors++; console.error('[reminder:email]', e.message); }
        }
        if (u.remindWhatsapp && u.phone && N.waReady()) {
          const to = N.waNumber(u.phone);
          if (to) try { await N.sendWhatsApp(to, [first, when, link]); sent = true; }
          catch (e) { out.errors++; console.error('[reminder:whatsapp]', e.message); }
        }
        if (sent) out.sent++;
      }
    } finally { running = false; }
    return out;
  }

  // A free timer service (such as cron-job.org) calls this every 10 minutes. It also keeps the server awake.
  // Prefer sending the secret in the x-cron-key header so it does not appear in logs.
  const same = (a, b) => { const h = s => crypto.createHash('sha256').update(String(s)).digest(); return crypto.timingSafeEqual(h(a), h(b)); };
  const guard = (req, res, next) => {
    const key = req.get('x-cron-key') || req.query.key || '';
    if (!process.env.CRON_SECRET || !same(key, process.env.CRON_SECRET)) return res.status(403).json({ error: 'Not allowed' });
    next();
  };
  r.get('/run', guard, async (req, res) => {
    try { res.json(await run()); } catch (e) { console.error('[reminders]', e.message); res.status(500).json({ error: 'Failed' }); }
  });
  // Send yourself a sample email to confirm the mail settings work: /api/reminders/test-email?to=you@example.com (with the x-cron-key header, or ?key=...)
  r.get('/test-email', guard, async (req, res) => {
    if (!N.emailReady()) return res.status(400).json({ error: 'Email settings (BREVO_API_KEY and MAIL_FROM) are not set' });
    try { await N.sendEmail(String(req.query.to || ''), 'SemaAfrica test email', 'Your reminder emails are working.', '<p>Your reminder emails are working.</p>'); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---- Teacher morning summary ----
  const tkey = (d, tz) => d.toLocaleDateString('en-CA', { timeZone: tz });            // e.g. 2026-11-07
  const tclock = (d, tz) => d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });

  async function morningSummary(uid, t) {
    const tz = t.tz || 'Africa/Nairobi';
    const now = new Date(), today = tkey(now, tz);
    const snap = await db.collection('lessons').where('teacherId', '==', uid).get();
    const lessons = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.start.toMillis() - b.start.toMillis());
    const links = {};
    (await db.collection('lessonLinks').where('teacherId', '==', uid).get()).forEach(d => links[d.id] = d.data().meetLink);
    const link = l => links[l.id] || l.meetLink || '';

    const live = l => ['open', 'booked'].includes(l.status);
    const todays = lessons.filter(l => live(l) && tkey(l.start.toDate(), tz) === today);
    const noLink = lessons.filter(l => live(l) && l.start.toMillis() >= now.getTime() && !link(l));
    const unmarked = lessons.filter(l => l.status === 'booked' && l.start.toMillis() < now.getTime());
    const label = l => `${tclock(l.start.toDate(), tz)} · ${l.studentName || 'Open slot'} · ${l.courseName || l.type || 'Lesson'}`;
    const when = l => `${tkey(l.start.toDate(), tz)} ${tclock(l.start.toDate(), tz)}`;

    const quiet = !todays.length && !noLink.length && !unmarked.length;
    let text = `Hujambo ${String(t.name || 'teacher').split(' ')[0]}!\n\n`, html = `<p>Hujambo ${esc(String(t.name || 'teacher').split(' ')[0])}!</p>`;
    if (todays.length) {
      text += "Today's lessons:\n" + todays.map(l => `- ${label(l)}${link(l) ? '\n  Join: ' + link(l) : ' (no link yet)'}`).join('\n') + '\n\n';
      html += "<h3>Today's lessons</h3><ul>" + todays.map(l => `<li>${esc(label(l))}${link(l) ? ` – <a href="${esc(link(l))}">Join</a>` : ' (no link yet)'}</li>`).join('') + '</ul>';
    }
    if (noLink.length) {
      text += `Lessons that still need a meeting link (${noLink.length}):\n` + noLink.map(l => `- ${when(l)} · ${l.studentName || 'Open slot'}`).join('\n') + '\n\n';
      html += `<h3>Need a meeting link (${noLink.length})</h3><ul>` + noLink.map(l => `<li>${esc(when(l))} · ${esc(l.studentName || 'Open slot')}</li>`).join('') + '</ul>';
    }
    if (unmarked.length) {
      text += `Waiting to be marked attended or absent (${unmarked.length}):\n` + unmarked.map(l => `- ${when(l)} · ${l.studentName || ''}`).join('\n') + '\n\n';
      html += `<h3>Mark attended or absent (${unmarked.length})</h3><ul>` + unmarked.map(l => `<li>${esc(when(l))} · ${esc(l.studentName || '')}</li>`).join('') + '</ul>';
    }
    if (quiet) { text += 'Nothing to report today.\n\n'; html += '<p>Nothing to report today.</p>'; }
    text += `Open your dashboard: ${SITE}/teacher.html`;
    html += `<p><a href="${esc(SITE)}/teacher.html">Open your dashboard</a></p>`;
    return { subject: 'Your SemaAfrica day: ' + today, text, html, quiet };
  }

  // The teacher's "Send preview" button: sends the summary to the logged-in teacher
  r.post('/morning-test', async (req, res) => {
    try {
      const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
      if (!m) return res.status(401).json({ error: 'Please log in again' });
      let dec; try { dec = await admin.auth().verifyIdToken(m[1]); } catch { return res.status(401).json({ error: 'Please log in again' }); }
      const t = (await db.collection('users').doc(dec.uid).get()).data() || {};
      if (t.role !== 'teacher') return res.status(403).json({ error: 'Teachers only' });
      if (!t.email) return res.status(400).json({ error: 'Your account has no email address' });
      if (!N.emailReady()) return res.status(400).json({ error: 'Email settings (BREVO_API_KEY and MAIL_FROM) are not set on the server' });
      const s = await morningSummary(dec.uid, t);
      await N.sendEmail(t.email, s.subject, s.text, s.html);
      res.json({ ok: true, to: t.email });
    } catch (e) { console.error('[morning-test]', e.message); res.status(500).json({ error: 'Could not send the preview' }); }
  });

  r.run = run;
  return r;
};
