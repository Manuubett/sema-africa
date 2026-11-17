// IntaSend hosted checkout (card payments in USD). Secrets come from environment variables only.
const crypto = require('crypto');
const env = process.env;
const LIVE = /^(prod|production|live)$/i.test(env.INTASEND_ENV || '');
const BASE = LIVE ? 'https://payment.intasend.com' : 'https://sandbox.intasend.com';
const TARIFF = env.INTASEND_CARD_TARIFF || 'BUSINESS-PAYS';   // or CUSTOMER-PAYS (the student pays IntaSend's fee on top)

function assertConfigured() {
  const missing = ['INTASEND_PUBLISHABLE_KEY', 'INTASEND_SECRET_KEY', 'INTASEND_WEBHOOK_CHALLENGE', 'APP_URL'].filter(k => !env[k]);
  if (missing.length) throw new Error('Live card payments need these settings: ' + missing.join(', '));
  console.log(`IntaSend: ${LIVE ? 'LIVE' : 'sandbox'} | card tariff ${TARIFF}`);
}

async function call(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.INTASEND_SECRET_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}

// Constant-time comparison of the webhook challenge
function challengeOk(c) {
  const want = env.INTASEND_WEBHOOK_CHALLENGE || '';
  if (!want || typeof c !== 'string') return false;
  const h = s => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(c), h(want));
}

module.exports = {
  name: 'intasend',
  assertConfigured,
  challengeOk,

  // Creates a hosted checkout page. The student pays on IntaSend's page, so card details never touch our server.
  async createCheckout({ amount, currency, email, name, reference, redirectUrl }) {
    const [first, ...rest] = String(name || 'Student').trim().split(/\s+/);
    const { ok, status, d } = await call('/api/v1/checkout/', {
      public_key: env.INTASEND_PUBLISHABLE_KEY,
      amount, currency, email,
      first_name: first || 'Student', last_name: rest.join(' ') || '-',
      api_ref: reference,            // comes back in the webhook, so we can match it to our pending record
      redirect_url: redirectUrl,
      method: 'CARD-PAYMENT',
      card_tarrif: TARIFF,
    });
    if (!ok || !d.url) {
      console.error('[intasend] checkout failed', status, JSON.stringify(d).slice(0, 300));
      throw Object.assign(new Error('Could not start the card payment'), { status: 502 });
    }
    return { checkoutId: d.id || '', url: d.url };
  },

  // The source of truth. The webhook only triggers this; it is never trusted on its own.
  async queryInvoice(invoiceId) {
    try {
      const { ok, d } = await call('/api/v1/payment/status/', { invoice_id: invoiceId });
      const inv = d && d.invoice;
      if (!ok || !inv) return { state: 'pending' };
      const base = { apiRef: inv.api_ref, value: Number(inv.value), currency: inv.currency };
      if (inv.state === 'COMPLETE') return { state: 'paid', ...base };
      if (inv.state === 'FAILED') return { state: 'failed', reason: inv.failed_reason || 'The card payment failed', ...base };
      return { state: 'pending', ...base };
    } catch (e) { console.error('[intasend query]', e.message); return { state: 'pending' }; }
  },
};
