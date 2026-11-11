/** Admin-only actions the browser cannot do: deleting a person's login (Firebase Auth) and their data. */
const express = require('express');

module.exports = (admin) => {
  const r = express.Router();
  const db = admin.firestore();
  const { Timestamp } = admin.firestore;

  async function requireAdmin(req, res, next) {
    try {
      const t = (req.headers.authorization || '').replace('Bearer ', '');
      if (!t) return res.status(401).json({ error: 'Please log in first' });
      req.uid = (await admin.auth().verifyIdToken(t)).uid;
    } catch (e) { return res.status(401).json({ error: 'Please log in again' }); }
    try {
      const u = await db.collection('users').doc(req.uid).get();
      if (!u.exists || u.data().role !== 'admin') return res.status(403).json({ error: 'Admins only' });
      next();
    } catch (e) { console.error('[admin]', e.message); res.status(500).json({ error: 'Server error' }); }
  }

  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
  async function deleteRefs(refs) {
    for (const c of chunks(refs, 400)) { const b = db.batch(); c.forEach(x => b.delete(x)); await b.commit(); }
  }
  const isUpcomingBooked = (d) => { const x = d.data(); return x.status === 'booked' && x.start && x.start.toMillis() > Date.now(); };

  // Deletes a student or teacher: their data, then their login, then their user document.
  // Payments are kept on purpose as financial records.
  r.post('/delete-user', requireAdmin, async (req, res) => {
    try {
      const id = String(req.body.userId || '');
      if (!id) throw bad('No user chosen');
      if (id === req.uid) throw bad('You cannot delete your own account');
      const us = await db.collection('users').doc(id).get();
      const u = us.exists ? us.data() : null;
      if (u && u.role === 'admin') throw bad('Admin accounts cannot be deleted here');
      const role = u ? u.role : 'student';
      let cancelled = 0;

      if (role === 'teacher') {
        const ls = await db.collection('lessons').where('teacherId', '==', id).get();
        const up = ls.docs.filter(isUpcomingBooked).length;
        if (up) throw bad('This teacher has ' + up + ' upcoming booked lesson' + (up > 1 ? 's' : '') + '. Cancel ' + (up > 1 ? 'them' : 'it') + ' first on the Bookings page so the students get their lessons back.');
        const refs = [];
        ls.docs.forEach(d => { if (['open', 'cancelled'].includes(d.data().status)) { refs.push(d.ref, db.collection('lessonLinks').doc(d.id)); } });
        refs.push(db.collection('teacherProfiles').doc(id));
        await deleteRefs(refs);
      } else {
        // Upcoming booked lessons of a deleted student are cancelled so the teacher's timetable stays right
        const ls = await db.collection('lessons').where('studentId', '==', id).get();
        const up = ls.docs.filter(isUpcomingBooked);
        for (const c of chunks(up, 400)) {
          const b = db.batch();
          c.forEach(d => b.update(d.ref, { status: 'cancelled', cancelledBy: 'admin', cancelledAt: Timestamp.now() }));
          await b.commit();
        }
        cancelled = up.length;
        const refs = [];
        for (const [col, field] of [['enrollments', 'userId'], ['progress', 'studentId'], ['quizAttempts', 'studentId']]) {
          (await db.collection(col).where(field, '==', id).get()).docs.forEach(d => refs.push(d.ref));
        }
        await deleteRefs(refs);
      }

      try { await admin.auth().deleteUser(id); }
      catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
      await db.collection('users').doc(id).delete();
      console.log('[admin] ' + req.uid + ' deleted ' + role + ' ' + id);
      res.json({ ok: true, role, cancelled });
    } catch (e) {
      console.error('[admin delete-user]', e.message);
      res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' });
    }
  });

  return r;
};
