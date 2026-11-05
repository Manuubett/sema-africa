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

// Your Cloudflare Worker (file uploads and downloads).
export const WORKER_URL = "https://semaafrica-files.bettemanuel49.workers.dev";

// Your server on Render (payments, lesson cancellation). The free plan sleeps
// when idle, so the first request after a pause can take up to a minute.
export const SERVER_URL = "https://sema-africa.onrender.com";

// Where each role lands after login
export const HOME = { student: "student.html", teacher: "teacher.html", admin: "admin.html" };
