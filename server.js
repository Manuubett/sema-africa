/** SemaAfrica server: payments, webhooks and discount codes (things the browser must never decide). */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  }),
});

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
