import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  collection, getDocs, getDoc, doc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCmplauoxq5qHpof-8xc8VyGM3G5aqDxPM",
  authDomain: "semiafrica.firebaseapp.com",
  projectId: "semiafrica",
  storageBucket: "semiafrica.firebasestorage.app",
  messagingSenderId: "255406669877",
  appId: "1:255406669877:web:36cdab226a87a90fc3717c",
  measurementId: "G-M1QZD0EE13"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Firestore, set up once for every page:
// - long polling is chosen automatically when the network blocks Firestore's streaming connection
//   (this is what causes the "unavailable" error)
// - a copy of the data is kept in the browser, so pages open faster and still show data when offline
export const db = (() => {
  try {
    return initializeFirestore(app, {
      experimentalAutoDetectLongPolling: true,
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
  } catch (e) {
    // Browsers that block IndexedDB (private mode, some in-app browsers) use a memory cache instead
    return initializeFirestore(app, {
      experimentalAutoDetectLongPolling: true,
      localCache: memoryLocalCache()
    });
  }
})();

// ── Read cache: each collection or document is read once, then reused for 10 minutes ──
// Use col("lessons") instead of getDocs(collection(db,"lessons")), and one("settings","reminders")
// instead of getDoc(doc(db,...)). Call clearCache() after you save something.
const mem = new Map(), TTL = 10 * 60 * 1000;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function retry(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (e.code !== "unavailable" || i >= 2) throw e; await wait(1200 * (i + 1)); }
  }
}
export async function col(name, { fresh = false } = {}) {
  const m = mem.get("c:" + name);
  if (m && !fresh && Date.now() - m.t < TTL) return m.v;
  const v = await retry(async () => (await getDocs(collection(db, name))).docs.map(d => ({ id: d.id, ...d.data() })));
  mem.set("c:" + name, { v, t: Date.now() });
  return v;
}
export async function one(c, id, { fresh = false } = {}) {
  const k = "d:" + c + "/" + id, m = mem.get(k);
  if (m && !fresh && Date.now() - m.t < TTL) return m.v;
  const s = await retry(() => getDoc(doc(db, c, id)));
  const v = s.exists() ? s.data() : null;
  mem.set(k, { v, t: Date.now() });
  return v;
}
// For any other read (for example a query with where()). fn must return the data to keep.
export async function cached(key, fn, { fresh = false } = {}) {
  const k = "x:" + key, m = mem.get(k);
  if (m && !fresh && Date.now() - m.t < TTL) return m.v;
  const v = await retry(fn);
  mem.set(k, { v, t: Date.now() });
  return v;
}
export const clearCache = () => mem.clear();

// Your Cloudflare Worker (file uploads and downloads).
export const WORKER_URL = "https://semaafrica-files.bettemanuel49.workers.dev";

// Your server on Render (payments, lesson cancellation). The free plan sleeps
// when idle, so the first request after a pause can take up to a minute.
export const SERVER_URL = "https://sema-africa.onrender.com";

// Where each role lands after login
export const HOME = { student: "student.html", teacher: "teacher.html", admin: "admin.html" };
