/** SemaAfrica server: payments, webhooks and discount codes (things the browser must never decide). */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Credentials: either ONE setting FIREBASE_SERVICE_ACCOUNT (the whole key file, or that file in base64, like PayTrack),
// or the three separate settings below.
let PROJECT_ID = '';
function loadCredential() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (raw) {
    try { const j = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')); PROJECT_ID = j.project_id || ''; return admin.credential.cert(j); }
    catch { console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON (or base64 of the JSON).'); process.exit(1); }
  }
  const missing = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error('Missing settings (Render > Environment): ' + missing.join(', ') + '. Or set FIREBASE_SERVICE_ACCOUNT instead.');
    process.exit(1);
  }
  PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
  return admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
}
admin.initializeApp({ credential: loadCredential() });
console.log('Firebase project:', PROJECT_ID, PROJECT_ID === 'semiafrica' ? '' : '  <-- WARNING: SemaAfrica logins belong to the "semiafrica" project, so payments will fail with "log in again"');

if (process.env.PAYMENTS_MODE === 'live') require('./providers/daraja').assertConfigured();   // stop at start-up if a setting is missing

const app = express();
app.disable('x-powered-by');
const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  .map(s => { try { return new URL(s).origin; } catch { return s.replace(/\/+$/, ''); } });   // tolerates a trailing slash or a path
console.log('Allowed origins:', allowed.join(', ') || '(NONE SET: add ALLOWED_ORIGINS in Render)');
app.use(cors({ origin: (o, cb) => {                                        // only your own sites
  const ok = !o || allowed.includes(o);
  if (!ok) console.warn('[cors] blocked origin:', o);
  cb(null, ok);
} }));

app.use(express.json({ limit: '100kb' }));

app.use('/api/payments', require('./routes/payments')(admin));
app.use('/api/lessons', require('./routes/lessons')(admin));
const reminders = require('./routes/reminders')(admin);
app.use('/api/reminders', reminders);
// Also check every 10 minutes while the server is awake (the timer service covers the times it is asleep)
setInterval(() => reminders.run().catch(e => console.error('[reminders]', e.message)), 10 * 60 * 1000);

// Health check only. Deliberately no endpoints that reveal env settings, database or file names.
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'semaafrica', mode: process.env.PAYMENTS_MODE || 'test', project: PROJECT_ID, cancelHours: Number(process.env.CANCEL_HOURS || 12) }));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error('[error]', err.message); res.status(500).json({ error: 'Server error' }); });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`SemaAfrica server on :${PORT} (payments mode: ${process.env.PAYMENTS_MODE || 'test'})`));
