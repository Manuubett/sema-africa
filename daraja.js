// Safaricom Daraja STK Push. Same environment variable names as your PayTrack server,
// so you can copy them across in Render.
const env = process.env;
const IS_PROD = /^(prod|production|live)$/i.test(env.DARAJA_ENV || '');
const BASE = IS_PROD ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
const SHORTCODE = env.DARAJA_SHORTCODE;
const PASSKEY = env.DARAJA_PASSKEY;
const TXN_TYPE = env.DARAJA_TRANSACTION_TYPE || 'CustomerPayBillOnline';
// Paybill: money goes to the shortcode. Till (Buy Goods): PartyB is the till number.
const PARTY_B = TXN_TYPE === 'CustomerBuyGoodsOnline' ? (env.DARAJA_TILL_NUMBER || SHORTCODE) : SHORTCODE;
const CALLBACK_URL = (env.DARAJA_CALLBACK_BASE_URL || '').replace(/\/+$/, '') + '/api/payments/callback';

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const password = ts => Buffer.from(SHORTCODE + PASSKEY + ts).toString('base64');

function assertConfigured() {
  const missing = ['DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET', 'DARAJA_SHORTCODE', 'DARAJA_PASSKEY', 'DARAJA_CALLBACK_BASE_URL'].filter(k => !env[k]);
  if (missing.length) throw new Error('Live payments need these settings: ' + missing.join(', '));
  console.log(`Daraja: ${IS_PROD ? 'PRODUCTION' : 'sandbox'} | ${TXN_TYPE} | callback ${CALLBACK_URL}`);
}

let tokenCache = { value: null, exp: 0 };
async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const auth = Buffer.from(`${env.DARAJA_CONSUMER_KEY}:${env.DARAJA_CONSUMER_SECRET}`).toString('base64');
  const r = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) throw new Error('Daraja login failed (HTTP ' + r.status + '). Check the key, secret and DARAJA_ENV.');
  tokenCache = { value: d.access_token, exp: Date.now() + 50 * 60 * 1000 };
  return d.access_token;
}

module.exports = {
  name: 'daraja',
  assertConfigured,

  // Sends the M-Pesa prompt to the student's phone
  async startStk({ amount, phone }) {
    const ts = stamp();
    const r = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: SHORTCODE, Password: password(ts), Timestamp: ts, TransactionType: TXN_TYPE,
        Amount: amount, PartyA: phone, PartyB: PARTY_B, PhoneNumber: phone, CallBackURL: CALLBACK_URL,
        AccountReference: 'SemaAfrica',      // Daraja allows 12 characters
        TransactionDesc: 'Swahili class',    // and 13 here
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.ResponseCode !== '0') throw Object.assign(new Error(d.errorMessage || d.ResponseDescription || 'Request rejected'), { status: 400 });
    return { checkoutId: d.CheckoutRequestID };
  },

  // Asks Safaricom whether this prompt really succeeded. This is the source of truth:
  // the callback is unsigned, so it only ever triggers this check and is never trusted alone.
  async query(checkoutId) {
    try {
      const ts = stamp();
      const r = await fetch(`${BASE}/mpesa/stkpushquery/v1/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ BusinessShortCode: SHORTCODE, Password: password(ts), Timestamp: ts, CheckoutRequestID: checkoutId }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.ResultCode !== undefined && d.ResultCode !== null) {
        return String(d.ResultCode) === '0' ? { state: 'paid' } : { state: 'failed', reason: d.ResultDesc || 'Code ' + d.ResultCode };
      }
      return { state: 'pending' };
    } catch (e) { console.error('[query]', e.message); return { state: 'pending' }; }
  },
};
