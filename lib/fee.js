// lib/fee.js: which teachers have paid the one-time service fee.
// Use it in routes/reminders.js (run(), /notify, /morning-test):
//   const { paidTeacherIds } = require('../lib/fee')(admin);
//   const paid = await paidTeacherIds();
//   lessons = lessons.filter(l => paid.has(l.teacherId));   // unpaid teachers never get emails
//
// Teachers are few, so we filter in memory. This avoids a composite Firestore index.
module.exports = (admin) => {
  const db = admin.firestore();
  let cache = { at: 0, ids: new Set() };
  async function paidTeacherIds() {
    if (Date.now() - cache.at < 60000) return cache.ids;
    const s = await db.collection('users').where('role', '==', 'teacher').get();
    const ids = s.docs
      .filter(d => { const t = d.data().feePaidUntil; return t && t.toMillis && t.toMillis() > Date.now(); })
      .map(d => d.id);
    cache = { at: Date.now(), ids: new Set(ids) };
    return cache.ids;
  }
  return { paidTeacherIds };
};
