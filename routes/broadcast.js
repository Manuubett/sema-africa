// Admin emails teachers. POST /api/admin/broadcast  { userIds: [...], subject, message }
const express = require('express');
const N = require('../lib/notify');

module.exports = (admin) => {
  const r = express.Router();
  const db = admin.firestore();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SITE = (process.env.SITE_URL || 'https://manuubett.github.io/sema-africa').replace(/\/+$/, '');

  async function requireAdmin(req, res, next) {
    try {
      const tok = (req.headers.authorization || '').replace('Bearer ', '');
      if (!tok) return res.status(401).json({ error: 'Please log in first' });
      const uid = (await admin.auth().verifyIdToken(tok)).uid;
      const u = (await db.collection('users').doc(uid).get()).data() || {};
      if (u.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
      req.uid = uid;
      next();
    } catch (e) { res.status(401).json({ error: 'Please log in again' }); }
  }

  r.post('/', requireAdmin, async (req, res) => {
    try {
      if (!N.emailReady()) return res.status(400).json({ error: 'Email is not set up on the server (BREVO_API_KEY and MAIL_FROM)' });
      const ids = [...new Set((Array.isArray(req.body.userIds) ? req.body.userIds : []).map(String))].slice(0, 300);
      const subject = String(req.body.subject || '').trim().slice(0, 120);
      const message = String(req.body.message || '').trim().slice(0, 3000);
      if (!ids.length || !subject || !message) return res.status(400).json({ error: 'Choose people and write a subject and a message' });

      const snaps = await db.getAll(...ids.map(id => db.collection('users').doc(id)));
      // Teachers only, and only people who have an email address
      const people = snaps.map(s => s.exists ? { id: s.id, ...s.data() } : null)
        .filter(u => u && u.role === 'teacher' && u.email);
      let sent = 0, failed = ids.length - people.length;

      const one = async u => {
        const first = String(u.name || 'there').split(' ')[0];
        const text = `Hujambo ${first}!\n\n${message}\n\nSemaAfrica\n${SITE}/teacher.html`;
        const html = `<div style="font-family:Arial,sans-serif;color:#14213A;max-width:560px"><p>Hujambo ${esc(first)}!</p>` +
          `<p style="white-space:pre-line">${esc(message)}</p>` +
          `<p><a href="${esc(SITE)}/teacher.html" style="background:#C42B5B;color:#fff;padding:10px 18px;border-radius:20px;text-decoration:none">Open my dashboard</a></p>` +
          `<p style="color:#777;font-size:12px">SemaAfrica</p></div>`;
        await N.sendEmail(u.email, subject, text, html);
      };
      for (let i = 0; i < people.length; i += 10) {
        const r2 = await Promise.allSettled(people.slice(i, i + 10).map(one));
        r2.forEach(x => { if (x.status === 'fulfilled') sent++; else { failed++; console.error('[broadcast]', x.reason && x.reason.message); } });
      }
      res.json({ sent, failed });
    } catch (e) { console.error('[broadcast]', e.message); res.status(500).json({ error: 'Could not send the emails' }); }
  });

  return r;
};
