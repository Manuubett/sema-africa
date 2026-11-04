const express = require('express');
const crypto = require('crypto');
const getProvider = require('../providers');


module.exports = (admin) => {
  const r = express.Router();
  const db = admin.firestore();
  const { FieldValue, Timestamp } = admin.firestore;

  // ── helpers ────────────────────────────────────────────────────────────
  async function requireUser(req, res, next) {
    try {
      const t = (req.headers.authorization || '').replace('Bearer ', '');
      if (!t) return res.status(401).json({ error: 'Please log in first' });
      req.uid = (await admin.auth().verifyIdToken(t)).uid;
      next();
    } catch { res.status(401).json({ error: 'Please log in again' }); }
  }

  // 07xx / 01xx / +254… / 254…  ->  2547XXXXXXXX
  function normalisePhone(p) {
    let d = String(p || '').replace(/\D/g, '');
    if (d.startsWith('0')) d = '254' + d.slice(1);
    if (d.startsWith('7') || d.startsWith('1')) d = '254' + d;
    return /^254[17]\d{8}$/.test(d) ? d : null;
  }

  // Price always comes from Firestore, never from the browser
  async function priceFor(courseId, code) {
    const cs = await db.collection('courses').doc(String(courseId)).get();
    if (!cs.exists || cs.data().active === false) throw httpErr('That plan is not available', 400);
    const c = cs.data();
    let amount = Number(c.kes), discount = 0, codeDoc = null;
    if (code) {
      const id = String(code).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      const ks = await db.collection('discountCodes').doc(id).get();
      const k = ks.exists ? ks.data() : null;
      const ok = k && k.active && (!k.expires || k.expires.toDate() > new Date()) && (!k.maxUses || (k.usedCount || 0) < k.maxUses);
      if (!ok) throw httpErr('That discount code is not valid', 400);
      // Fixed discounts are in USD, so convert with the plan's own USD:KES ratio
      discount = k.type === 'percent' ? amount * k.value / 100 : k.value * (c.kes / c.usd);
      discount = Math.min(Math.round(discount), amount);
      amount -= discount; codeDoc = id;
    }
    return { course: c, amount, discount, code: codeDoc };
  }
  const httpErr = (m, s) => Object.assign(new Error(m), { status: s });
  const fail = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' });

  // Turns a pending payment into an enrolment, exactly once (safe if the callback arrives twice)
  async function settle(pendingId, result) {
    return db.runTransaction(async tx => {
      const pref = db.collection('payments_pending').doc(pendingId);
      const snap = await tx.get(pref);
      if (!snap.exists) return 'unknown';
      const p = snap.data();
      if (p.status !== 'pending') return p.status;                       // already handled
      if (!result.success) { tx.update(pref, { status: 'failed', reason: result.reason || '', settledAt: FieldValue.serverTimestamp() }); return 'failed'; }
      if (result.amount != null && Number(result.amount) < p.amount) {   // paid less than the price
        tx.update(pref, { status: 'amount_mismatch', paidAmount: Number(result.amount), settledAt: FieldValue.serverTimestamp() }); return 'amount_mismatch';
      }
      const cs = await tx.get(db.collection('courses').doc(p.courseId));
      const kref = p.code ? db.collection('discountCodes').doc(p.code) : null;
      const ks = kref ? await tx.get(kref) : null;                       // all reads are done before any write
      const c = cs.data(), now = new Date(), end = new Date(now.getTime() + 30 * 864e5);
      tx.set(db.collection('enrollments').doc(), {
        userId: p.uid, userName: p.userName, courseId: p.courseId, courseName: c.name, type: c.type,
        lessonsTotal: c.lessons, lessonsLeft: c.lessons, status: 'active',
        startDate: Timestamp.fromDate(now), expiresAt: c.type === 'Monthly' ? Timestamp.fromDate(end) : null,
      });
      tx.set(db.collection('payments').doc(), {
        userId: p.uid, userName: p.userName, courseId: p.courseId, courseName: c.name,
        amount: p.amount, currency: 'KES', method: 'M-Pesa', reference: result.receipt || p.reference,
        discountCode: p.code || '', createdAt: FieldValue.serverTimestamp(),
      });
      if (ks && ks.exists) tx.update(kref, { usedCount: FieldValue.increment(1) });
      tx.update(pref, { status: 'paid', receipt: result.receipt || '', settledAt: FieldValue.serverTimestamp() });
      return 'paid';
    });
  }

  // ── verifying with Safaricom ───────────────────────────────────────────
  const lastQuery = new Map();
  // Ask the provider whether this prompt really succeeded (the callback alone is never trusted)
  async function verify(pendingId, p, cb, force) {
    if (p.status !== 'pending' || !p.checkoutId) return p.status;
    const now = Date.now();
    if (!force && now - (lastQuery.get(pendingId) || 0) < 8000) return 'pending';
    lastQuery.set(pendingId, now); if (lastQuery.size > 2000) lastQuery.clear();
    const v = await getProvider().query(p.checkoutId);
    if (v.state === 'paid') {
      const items = (cb && cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
      const rec = items.find(i => i.Name === 'MpesaReceiptNumber');
      const receipt = rec && /^[A-Z0-9]{8,12}$/.test(String(rec.Value)) ? String(rec.Value) : '';   // label only
      return settle(pendingId, { success: true, receipt });
    }
    if (v.state === 'failed') return settle(pendingId, { success: false, reason: v.reason });
    return 'pending';
  }

  const attempts = new Map();   // max 3 prompts per person in 5 minutes
  function tooMany(key) {
    const now = Date.now(); if (attempts.size > 5000) attempts.clear();
    const recent = (attempts.get(key) || []).filter(t => now - t < 300000), blocked = recent.length >= 3;
    if (!blocked) recent.push(now); attempts.set(key, recent); return blocked;
  }
  function requireAdmin(req, res, next) {
    requireUser(req, res, async () => {
      const u = await db.collection('users').doc(req.uid).get();
      u.exists && u.data().role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });
    });
  }

  // ── routes ─────────────────────────────────────────────────────────────
  // Show the price (with any code) before the student pays
  r.post('/quote', requireUser, async (req, res) => {
    try { const q = await priceFor(req.body.courseId, req.body.code); res.json({ amount: q.amount, discount: q.discount, currency: 'KES' }); }
    catch (e) { fail(res, e); }
  });

  // Start a payment: saves a pending record, then sends the M-Pesa prompt
  r.post('/initiate', requireUser, async (req, res) => {
    let pref;
    try {
      const phone = normalisePhone(req.body.phone);
      if (!phone) throw httpErr('Enter a valid Kenyan M-Pesa number, like 0712 345 678', 400);
      if (tooMany(req.uid)) throw httpErr('Please wait a few minutes and try again', 429);
      const q = await priceFor(req.body.courseId, req.body.code);
      if (!Number.isInteger(q.amount) || q.amount < 1) throw httpErr('That price cannot be charged', 400);
      const us = await db.collection('users').doc(req.uid).get();
      const reference = 'SEMA-' + crypto.randomBytes(5).toString('hex').toUpperCase();
      pref = db.collection('payments_pending').doc();
      await pref.set({ uid: req.uid, userName: us.exists ? us.data().name : '', courseId: String(req.body.courseId), amount: q.amount,
        code: q.code || '', phone, reference, status: 'pending', createdAtMs: Date.now(), createdAt: FieldValue.serverTimestamp() });
      const out = await getProvider().startStk({ amount: q.amount, phone, reference });
      await pref.update({ checkoutId: out.checkoutId || '' });
      res.json({ paymentId: pref.id, amount: q.amount, reference });
    } catch (e) {
      if (pref) await pref.update({ status: 'failed', reason: e.message }).catch(() => {});
      console.error('[initiate]', e.message);
      e.status ? fail(res, e) : res.status(502).json({ error: 'Could not send the M-Pesa prompt. Please try again.' });
    }
  });

  // Safaricom calls this when the student pays or cancels. Acknowledge, then verify before crediting.
  r.post('/callback', (req, res) => {
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    const cb = req.body && req.body.Body && req.body.Body.stkCallback;
    const id = cb && String(cb.CheckoutRequestID || '');
    if (!id || !/^[A-Za-z0-9_-]{6,100}$/.test(id)) return;
    db.collection('payments_pending').where('checkoutId', '==', id).limit(1).get()
      .then(q => q.empty ? null : verify(q.docs[0].id, q.docs[0].data(), cb, true))
      .catch(e => console.error('[callback]', e.message));
  });

  // The browser polls this. If the callback never arrived, it asks Safaricom directly after 15 seconds.
  r.get('/status/:id', requireUser, async (req, res) => {
    try {
      const ref = db.collection('payments_pending').doc(req.params.id), s = await ref.get();
      if (!s.exists || s.data().uid !== req.uid) return res.status(404).json({ error: 'Not found' });
      let p = s.data();
      if (p.status === 'pending' && Date.now() - (p.createdAtMs || 0) > 15000) {
        await verify(s.id, p, null, false).catch(() => {});
        p = (await ref.get()).data();
      }
      res.json({ status: p.status, reason: p.reason || null });
    } catch (e) { fail(res, e); }
  });

  // Admin: re-check every payment stuck as pending for over a minute (missed callbacks)
  r.post('/recheck', requireAdmin, async (req, res) => {
    try {
      const snap = await db.collection('payments_pending').where('status', '==', 'pending').limit(30).get();
      let settled = 0;
      for (const d of snap.docs) {
        if (Date.now() - (d.data().createdAtMs || 0) < 60000) continue;
        if (await verify(d.id, d.data(), null, true).catch(() => 'pending') !== 'pending') settled++;
      }
      res.json({ checked: snap.size, settled });
    } catch (e) { fail(res, e); }
  });

  // TEST MODE ONLY: pretend the student paid, so the whole flow can be tried with no money
  r.post('/simulate/:id', requireUser, async (req, res) => {
    if (process.env.PAYMENTS_MODE === 'live') return res.status(404).json({ error: 'Not found' });
    const s = await db.collection('payments_pending').doc(req.params.id).get();
    if (!s.exists || s.data().uid !== req.uid) return res.status(404).json({ error: 'Not found' });
    res.json({ status: await settle(s.id, { success: true, receipt: 'TEST' + Date.now() }) });
  });

  return r;
};
