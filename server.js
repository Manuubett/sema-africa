/** SemaAfrica server: payments, webhooks and discount codes (things the browser must never decide). */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Credentials: either ONE setting FIREBASE_SERVICE_ACCOUNT (the whole key file, or that file in base64, like PayTrack),
// or the three separate settings below.
function loadCredential() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (raw) {
    try { return admin.credential.cert(JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'))); }
    catch { console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON (or base64 of the JSON).'); process.exit(1); }
  }
  const missing = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error('Missing settings (Render > Environment): ' + missing.join(', ') + '. Or set FIREBASE_SERVICE_ACCOUNT instead.');
    process.exit(1);
  }
  return admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
}
admin.initializeApp({ credential: loadCredential() });
console.log('Firebase project:', admin.app().options.projectId || '(from key file)');

if (process.env.PAYMENTS_MODE === 'live') require('./providers/daraja').assertConfigured();   // stop at start-up if a setting is missing

const app = express();
const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: (o, cb) => cb(null, !o || allowed.includes(o)) }));   // only your own sites

app.use(express.json({ limit: '100kb' }));

app.use('/api/payments', require('./routes/payments')(admin));

// Health check only. Deliberately no endpoints that reveal env settings, database or file names.
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'semaafrica', mode: process.env.PAYMENTS_MODE || 'test' }));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error('[error]', err.message); res.status(500).json({ error: 'Server error' }); });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`SemaAfrica server on :${PORT} (payments mode: ${process.env.PAYMENTS_MODE || 'test'})`));
