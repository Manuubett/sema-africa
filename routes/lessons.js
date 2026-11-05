// Cancelling and moving lessons. These run on the server so a student can never keep a credit they did not earn.
const express = require('express');

module.exports = (admin) => {
  const r = express.Router();
  const db = admin.firestore();
  const { FieldValue } = admin.firestore;
  const HOURS = Number(process.env.CANCEL_HOURS || 12);   // free changes up to this many hours before class

  const err = (m, s) => Object.assign(new Error(m), { status: s });
  const fail = (res, e) => { if (!e.status) console.error('[lessons]', e.message); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); };
  // What an unbooked slot looks like (matches how teachers create open slots).
  // reminders is cleared so the next student to book this slot gets their own reminders.
  const OPEN = () => ({ status: 'open', studentId: '', studentName: '', enrollmentId: FieldValue.delete(), reminders: FieldValue.delete() });
  const early = (d) => d.start.toDate().getTime() - Date.now() >= HOURS * 3600e3;

  async function requireUser(req, res, next) {
    try {
      const t = (req.headers.authorization || '').replace('Bearer ', '');
      if (!t) return res.status(401).json({ error: 'Please log in first' });
      req.uid = (await admin.auth().verifyIdToken(t)).uid;
      next();
    } catch (e) { console.error('[auth] token rejected:', e.code || e.message); res.status(401).json({ error: 'Please log in again' }); }
  }
  const log = (tx, lessonId, uid, action, refunded) =>
    tx.set(db.collection('lessonEvents').doc(), { lessonId, uid, action, refunded, at: FieldValue.serverTimestamp() });
  const giveBack = (tx, eref, e) => {
    if (e && e.exists) tx.update(eref, { lessonsLeft: Math.min((e.data().lessonsLeft || 0) + 1, e.data().lessonsTotal || 999) });
  };

  // A student cancels their own class
  r.post('/cancel', requireUser, async (req, res) => {
    try {
      res.json(await db.runTransaction(async tx => {
        const lref = db.collection('lessons').doc(String(req.body.lessonId || 'x'));
        const l = await tx.get(lref);
        if (!l.exists || l.data().studentId !== req.uid || l.data().status !== 'booked') throw err('That class cannot be cancelled', 400);
        const d = l.data();
        if (d.start.toDate() <= new Date()) throw err('That class has already started', 400);
        const ok = early(d);
        const eref = ok && d.enrollmentId ? db.collection('enrollments').doc(d.enrollmentId) : null;
        const e = eref ? await tx.get(eref) : null;                       // all reads happen before any write
        if (ok) { tx.update(lref, OPEN()); giveBack(tx, eref, e); }
        else tx.update(lref, { status: 'cancelled', cancelledBy: 'student', cancelledAt: FieldValue.serverTimestamp(), lateCancel: true });
        log(tx, lref.id, req.uid, 'student_cancel', ok);
        return { refunded: ok };
      }));
    } catch (e) { fail(res, e); }
  });

  // A student moves a class to another open time. The lesson is kept, nothing is spent or lost.
  r.post('/reschedule', requireUser, async (req, res) => {
    try {
      await db.runTransaction(async tx => {
        const oref = db.collection('lessons').doc(String(req.body.lessonId || 'x'));
        const nref = db.collection('lessons').doc(String(req.body.newLessonId || 'y'));
        const [o, n] = await Promise.all([tx.get(oref), tx.get(nref)]);
        if (!o.exists || o.data().studentId !== req.uid || o.data().status !== 'booked') throw err('That class cannot be moved', 400);
        if (!early(o.data())) throw err('It is too close to the class to move it. You can cancel, but the lesson will be used.', 400);
        if (!n.exists || n.data().status !== 'open' || n.data().start.toDate() <= new Date()) throw err('That time was just taken. Please pick another.', 409);
        const od = o.data();
        tx.update(nref, { status: 'booked', studentId: req.uid, studentName: od.studentName || '', reminders: FieldValue.delete(), ...(od.enrollmentId ? { enrollmentId: od.enrollmentId } : {}) });
        tx.update(oref, OPEN());
        log(tx, oref.id, req.uid, 'student_reschedule', false);
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // A teacher (their own lessons) or an admin (any lesson) cancels. A booked student always gets the lesson back.
  r.post('/staff-cancel', requireUser, async (req, res) => {
    try {
      const u = await db.collection('users').doc(req.uid).get();
      const role = u.exists ? u.data().role : '';
      if (role !== 'teacher' && role !== 'admin') throw err('Not allowed', 403);
      res.json(await db.runTransaction(async tx => {
        const lref = db.collection('lessons').doc(String(req.body.lessonId || 'x'));
        const l = await tx.get(lref);
        if (!l.exists) throw err('Lesson not found', 404);
        const d = l.data();
        if (role === 'teacher' && d.teacherId !== req.uid) throw err('Not allowed', 403);
        if (!['open', 'booked'].includes(d.status)) throw err('That lesson is already finished or cancelled', 400);
        const refund = d.status === 'booked' && d.enrollmentId;
        const eref = refund ? db.collection('enrollments').doc(d.enrollmentId) : null;
        const e = eref ? await tx.get(eref) : null;
        if (refund) giveBack(tx, eref, e);
        tx.update(lref, { status: 'cancelled', cancelledBy: role, cancelledAt: FieldValue.serverTimestamp() });
        log(tx, lref.id, req.uid, role + '_cancel', !!refund);
        return { refunded: !!refund };
      }));
    } catch (e) { fail(res, e); }
  });

  return r;
};
