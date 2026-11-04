import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
export const db = getFirestore(app);

// Your Cloudflare Worker address (printed after you run: npx wrangler deploy).
// Leave as is until the Worker is deployed; pages load, but file uploads won't work yet.
export const WORKER_URL = "https://semaafrica-files.YOUR_SUBDOMAIN.workers.dev";

// Your payments server on Render (shown on its dashboard), your Render server
export const SERVER_URL = "https://sema-africa.onrender.com";

// Where each role lands after login
export const HOME = { student: "student.html", teacher: "teacher.html", admin: "admin.html" };
