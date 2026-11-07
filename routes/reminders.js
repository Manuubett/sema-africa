// Class reminders by email and WhatsApp, about 24 hours and 1 hour before each booked lesson.
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

  // ── Teacher morning summary ───────────────────────────────────────────
  // Sent once a day to each teacher, from MORNING_HOUR (default 6:00) in the teacher's own time zone,
  // for up to three hours (so a server that was asleep still sends it when it wakes).
  // The same 10-minute timer that sends class reminders drives it, so no new timer is needed.
  const MORNING_HOUR = Number(process.env.MORNING_HOUR || 6);
  const DEFAULT_TZ = process.env.TIMEZONE || 'Africa/Nairobi';
  const DAY = 864e5;
  const p2 = n => String(n).padStart(2, '0');
  const okTz = z => { try { new Intl.DateTimeFormat('en-GB', { timeZone: z }); return !!z; } catch { return false; } };
  const parts = (ms, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).reduce((a, x) => (a[x.type] = x.value, a), {});
  const offset = (ms, tz) => { const p = parts(ms, tz); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms; };
  // Start of calendar day y-m-d in the time zone, as a UTC timestamp
  const sod = (y, m, d, tz) => { const t0 = Date.UTC(y, m - 1, d); const t1 = t0 - offset(t0, tz); return t0 - offset(t1, tz); };
  const dayOf = (ms, tz) => { const p = parts(ms, tz), y = +p.year, m = +p.month, d = +p.day; return { y, m, d, hour: +p.hour, start: sod(y, m, d, tz), end: sod(y, m, d + 1, tz) }; };
  const fmt = (o, tz) => ms => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...o }).format(new Date(ms));

  // Every teacher's lessons from 14 days back to 8 days ahead (one query, grouped here), plus their meeting links
  async function digestData(now) {
    const snap = await db.collection('lessons')
      .where('start', '>=', Timestamp.fromMillis(now - 14 * DAY))
      .where('start', '<=', Timestamp.fromMillis(now + 8 * DAY)).get();
    const by = {}, ids = [];
    snap.docs.forEach(d => {
      const l = d.data(); if (!l.teacherId) return;
      (by[l.teacherId] = by[l.teacherId] || []).push({ id: d.id, ...l });
      if ((l.status === 'open' || l.status === 'booked') && l.start.toMillis() >= now) ids.push(d.id);
    });
    const links = {};
    for (let i = 0; i < ids.length; i += 100) {
      const refs = ids.slice(i, i + 100).map(id => db.collection('lessonLinks').doc(id));
      (await db.getAll(...refs)).forEach(s => { if (s.exists) links[s.id] = s.data().meetLink; });
    }
    return { by, links };
  }

  function buildDigest(t, mine, links, now) {
    const tz = okTz(t.tz) ? t.tz : DEFAULT_TZ, day = dayOf(now, tz);
    const clock = fmt({ hour: '2-digit', minute: '2-digit' }, tz);
    const when = fmt({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, tz);
    const dayName = fmt({ weekday: 'long', day: 'numeric', month: 'long' }, tz)(now);
    const ms = l => l.start.toMillis(), linkOf = l => links[l.id] || l.meetLink || '';
    const live = mine.filter(l => (l.status === 'open' || l.status === 'booked') && ms(l) >= now);
    const todayBooked = mine.filter(l => l.status === 'booked' && ms(l) >= day.start && ms(l) < day.end).sort((a, b) => ms(a) - ms(b));
    const todayOpen = live.filter(l => l.status === 'open' && ms(l) < day.end).length;
    const noLink = live.filter(l => ms(l) < now + 7 * DAY && !linkOf(l)).sort((a, b) => ms(a) - ms(b));
    const toMark = mine.filter(l => l.status === 'booked' && ms(l) + (l.duration || 45) * 60000 < now).sort((a, b) => ms(b) - ms(a));
    const week = live.filter(l => ms(l) < now + 7 * DAY);
    const wb = week.filter(l => l.status === 'booked').length, wo = week.length - wb;
    const first = String(t.name || 'there').split(' ')[0];
    const what = l => [l.studentName || 'Open slot', l.courseName || l.type, l.topic].filter(Boolean).join(' · ');
    const more = (a, n) => a.length > n ? `+${a.length - n} more` : '';
    const attn = noLink.length + toMark.length, n = todayBooked.length;

    const subject = (n ? `Your day: ${n} lesson${n > 1 ? 's' : ''} today` : 'Your day: no lessons booked today') + (attn ? ` · ${attn} to check` : '');

    // plain text
    const tx = [`Hujambo ${first}!`, '', dayName, ''];
    tx.push(n ? `Today's lessons (${n}):` : 'No lessons are booked for today.');
    todayBooked.forEach(l => tx.push(`  ${clock(ms(l))}  ${what(l)} (${l.duration || ''} min)  ${linkOf(l) || 'NO MEETING LINK YET'}`));
    if (todayOpen) tx.push('', `${todayOpen} open slot${todayOpen > 1 ? 's' : ''} still free today.`);
    if (noLink.length) { tx.push('', `Needs a meeting link (${noLink.length}):`); noLink.slice(0, 8).forEach(l => tx.push(`  ${when(ms(l))}  ${what(l)}`)); if (noLink.length > 8) tx.push('  ' + more(noLink, 8)); }
    if (toMark.length) { tx.push('', `Waiting to be marked attended or absent (${toMark.length}):`); toMark.slice(0, 8).forEach(l => tx.push(`  ${when(ms(l))}  ${what(l)}`)); if (toMark.length > 8) tx.push('  ' + more(toMark, 8)); }
    tx.push('', `Next 7 days: ${wb} booked, ${wo} open slot${wo === 1 ? '' : 's'}.`, '', `Open your dashboard: ${SITE}/teacher.html`, 'You can turn this email off under Email settings in your dashboard.');

    // html
    const li = s => `<li style="margin:6px 0">${s}</li>`;
    const ul = a => `<ul style="padding-left:18px;margin:8px 0">${a.join('')}</ul>`;
    const h = s => `<h3 style="margin:22px 0 4px;font-size:16px">${s}</h3>`;
    let html = `<div style="font-family:Arial,sans-serif;color:#14213A;max-width:560px"><p style="margin:0 0 4px">Hujambo ${esc(first)}!</p><p style="margin:0;color:#555">${esc(dayName)}</p>`;
    html += h(n ? `Today's lessons (${n})` : 'Today');
    html += n ? ul(todayBooked.map(l => { const u = linkOf(l);
        return li(`<strong>${clock(ms(l))}</strong> · ${esc(what(l))} · ${l.duration || ''} min ` + (u ? `· <a href="${esc(u)}">Join</a>` : '· <span style="color:#C2374F">no meeting link yet</span>')); }))
      : '<p style="color:#555;margin:6px 0">No lessons are booked for today.</p>';
    if (todayOpen) html += `<p style="color:#555;margin:6px 0">${todayOpen} open slot${todayOpen > 1 ? 's' : ''} still free today.</p>`;
    if (noLink.length) html += h(`Needs a meeting link (${noLink.length})`) + ul(noLink.slice(0, 8).map(l => li(`${esc(when(ms(l)))} · ${esc(what(l))}`))) + (noLink.length > 8 ? `<p style="color:#555;margin:0">${more(noLink, 8)}</p>` : '');
    if (toMark.length) html += h(`Waiting to be marked attended or absent (${toMark.length})`) + ul(toMark.slice(0, 8).map(l => li(`${esc(when(ms(l)))} · ${esc(what(l))}`))) + (toMark.length > 8 ? `<p style="color:#555;margin:0">${more(toMark, 8)}</p>` : '');
    html += h('Next 7 days') + `<p style="margin:6px 0">${wb} booked, ${wo} open slot${wo === 1 ? '' : 's'}.</p>`;
    html += `<p style="margin:22px 0"><a href="${esc(SITE)}/teacher.html" style="background:#C42B5B;color:#fff;padding:10px 18px;border-radius:20px;text-decoration:none">Open my dashboard</a></p>`;
    html += '<p style="color:#777;font-size:12px">You can turn this email off under Email settings in your dashboard.</p></div>';

    // only worth sending when there is a lesson today or something that needs checking
    return { subject, text: tx.join('\n'), html, worth: n > 0 || attn > 0 };
  }

  let morningRunning = false;
  async function morning() {
    if (morningRunning) return { skipped: true };
    morningRunning = true;
    const out = { teachers: 0, sent: 0, errors: 0 };
    try {
      if (!N.emailReady()) return out;
      const now = Date.now();
      const due = [];
      (await db.collection('users').where('role', '==', 'teacher').get()).docs.forEach(d => {
        const t = d.data();
        if (t.morningEmail === false || !t.email) return;           // switched off, or no address
        const tz = okTz(t.tz) ? t.tz : DEFAULT_TZ, hr = dayOf(now, tz).hour;
        if (hr >= MORNING_HOUR && hr < MORNING_HOUR + 3) due.push({ id: d.id, ...t });
      });
      out.teachers = due.length;
      if (!due.length) return out;
      const { by, links } = await digestData(now);
      for (const t of due) {
        const tz = okTz(t.tz) ? t.tz : DEFAULT_TZ, day = dayOf(now, tz);
        const dg = buildDigest(t, by[t.id] || [], links, now);
        if (!dg.worth) continue;
        // one summary per teacher per day: the claim document can only be created once
        const ref = db.collection('morningDigests').doc(t.id + '_' + day.y + p2(day.m) + p2(day.d));
        try { await ref.create({ teacherId: t.id, at: FieldValue.serverTimestamp() }); }
        catch (e) { if (e.code !== 6 && !/already exists/i.test(e.message || '')) console.error('[morning:claim]', e.message); continue; }
        try { await N.sendEmail(t.email, dg.subject, dg.text, dg.html); out.sent++; }
        catch (e) { out.errors++; console.error('[morning:email]', e.message); await ref.delete().catch(() => {}); }   // let the next run retry
      }
    } finally { morningRunning = false; }
    return out;
  }

  async function requireUser(req, res, next) {
    try {
      const tok = (req.headers.authorization || '').replace('Bearer ', '');
      if (!tok) return res.status(401).json({ error: 'Please log in first' });
      req.uid = (await admin.auth().verifyIdToken(tok)).uid;
      next();
    } catch (e) { res.status(401).json({ error: 'Please log in again' }); }
  }
  // A teacher asks for a preview of their own summary (any time, even on a quiet day)
  r.post('/morning-test', requireUser, async (req, res) => {
    try {
      const u = await db.collection('users').doc(req.uid).get(), t = u.exists ? { id: u.id, ...u.data() } : null;
      if (!t || t.role !== 'teacher') return res.status(403).json({ error: 'Teachers only' });
      if (!t.email) return res.status(400).json({ error: 'Your account has no email address' });
      if (!N.emailReady()) return res.status(400).json({ error: 'Email is not set up on the server (BREVO_API_KEY and MAIL_FROM)' });
      const now = Date.now(), { by, links } = await digestData(now), dg = buildDigest(t, by[t.id] || [], links, now);
      await N.sendEmail(t.email, '[Preview] ' + dg.subject, dg.text, dg.html);
      res.json({ ok: true, to: t.email });
    } catch (e) { console.error('[morning-test]', e.message); res.status(500).json({ error: 'Could not send the preview' }); }
  });

  // A free timer service (such as cron-job.org) calls this every 10 minutes. It also keeps the server awake.
  // Prefer sending the secret in the x-cron-key header so it does not appear in logs.
  const same = (a, b) => { const h = s => crypto.createHash('sha256').update(String(s)).digest(); return crypto.timingSafeEqual(h(a), h(b)); };
  const guard = (req, res, next) => {
    const key = req.get('x-cron-key') || req.query.key || '';
    if (!process.env.CRON_SECRET || !same(key, process.env.CRON_SECRET)) return res.status(403).json({ error: 'Not allowed' });
    next();
  };
  r.get('/run', guard, async (req, res) => {
    try { res.json(await r.run()); } catch (e) { console.error('[reminders]', e.message); res.status(500).json({ error: 'Failed' }); }
  });
  // Send yourself a sample email to confirm the mail settings work: /api/reminders/test-email?to=you@example.com (with the x-cron-key header, or ?key=...)
  r.get('/test-email', guard, async (req, res) => {
    if (!N.emailReady()) return res.status(400).json({ error: 'Email settings (BREVO_API_KEY and MAIL_FROM) are not set' });
    try { await N.sendEmail(String(req.query.to || ''), 'SemaAfrica test email', 'Your reminder emails are working.', '<p>Your reminder emails are working.</p>'); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // The 10-minute timer sends class reminders and, in the morning hours, each teacher's summary
  r.run = async () => { const out = await run(); out.morning = await morning().catch(e => ({ error: e.message })); return out; };
  return r;
};
