// Class reminders by email and WhatsApp, about 24 hours and 1 hour before each booked lesson.
const express = require('express');
const crypto = require('crypto');
const N = require('../lib/notify');

module.exports = (admin) => {
  const r = express.Router();
  const db = admin.firestore();
  const { FieldValue, Timestamp } = admin.firestore;
  const SITE = (process.env.SITE_URL || 'https://manuubett.github.io/sema-africa').replace(/\/+$/, '');
  let running = false;

  // Mark a reminder as sent BEFORE sending, so it can never go out twice
  const claim = (lref, key) => db.runTransaction(async tx => {
    const s = await tx.get(lref), d = s.exists ? s.data() : null;
    if (!d || d.status !== 'booked' || (d.reminders && d.reminders[key])) return false;
    tx.update(lref, { ['reminders.' + key]: FieldValue.serverTimestamp() });
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
        let sent = false;

        if (u.remindEmail !== false && u.email && N.emailReady()) {
          const text = `Hujambo ${first}!\n\nYour SemaAfrica class ${soon}: ${when}.\nJoin here: ${link}\n\nNeed to move it? Open your dashboard at least 12 hours before class: ${SITE}/student.html\n\nKaribu sana!`;
          const html = `<p>Hujambo ${first.replace(/[<>&]/g, '')}!</p><p>Your SemaAfrica class ${soon}:<br><strong>${when}</strong></p><p><a href="${link}" style="background:#C42B5B;color:#fff;padding:10px 18px;border-radius:20px;text-decoration:none">Join class</a></p><p style="color:#555">Need to move it? <a href="${SITE}/student.html">Open your dashboard</a> at least 12 hours before class.</p><p>Karibu sana!</p>`;
          try { await N.sendEmail(u.email, key === 'r1' ? 'Your Swahili class starts in about an hour' : 'Reminder: your Swahili class on ' + when, text, html); sent = true; }
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
  const same = (a, b) => { const h = s => crypto.createHash('sha256').update(String(s)).digest(); return crypto.timingSafeEqual(h(a), h(b)); };
  const guard = (req, res, next) => {
    const key = req.query.key || req.get('x-cron-key') || '';
    if (!process.env.CRON_SECRET || !same(key, process.env.CRON_SECRET)) return res.status(403).json({ error: 'Not allowed' });
    next();
  };
  r.get('/run', guard, async (req, res) => {
    try { res.json(await run()); } catch (e) { console.error('[reminders]', e.message); res.status(500).json({ error: 'Failed' }); }
  });
  // Send yourself a sample email to confirm the mail settings work: /api/reminders/test-email?key=...&to=you@example.com
  r.get('/test-email', guard, async (req, res) => {
    if (!N.emailReady()) return res.status(400).json({ error: 'Email settings (BREVO_API_KEY and MAIL_FROM) are not set' });
    try { await N.sendEmail(String(req.query.to || ''), 'SemaAfrica test email', 'Your reminder emails are working.', '<p>Your reminder emails are working.</p>'); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  r.run = run;
  return r;
};
