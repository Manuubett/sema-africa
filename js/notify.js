// Sending email (any SMTP provider) and WhatsApp (Meta Cloud API template messages).
const nodemailer = require('nodemailer');
const env = process.env;

const emailReady = () => !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
const waReady = () => !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID);

let transporter = null;
function mailer() {
  if (!transporter) transporter = nodemailer.createTransport({
    host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: Number(env.SMTP_PORT) === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return transporter;
}
const sendEmail = (to, subject, text, html) =>
  mailer().sendMail({ from: env.MAIL_FROM || env.SMTP_USER, to, subject, text, html });

// WhatsApp only allows business-started messages as pre-approved templates
async function sendWhatsApp(to, params) {
  const r = await fetch(`https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'template',
      template: { name: env.WHATSAPP_TEMPLATE || 'class_reminder', language: { code: env.WHATSAPP_LANG || 'en' },
        components: [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t).replace(/\s+/g, ' ').slice(0, 200) })) }] },
    }),
  });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error('WhatsApp: ' + ((d.error && d.error.message) || r.status)); }
}

// Accepts 07.., 7.., 254.. or an international number. Returns digits only, or null.
function waNumber(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '254' + d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
  return /^\d{9,15}$/.test(d) ? d : null;
}

// "Tue, 12 Nov, 16:00 GMT+3" in the learner's own time zone
function formatWhen(date, tz) {
  const opts = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' };
  for (const z of [tz, env.TIMEZONE, 'Africa/Nairobi']) {
    try { return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: z || undefined }).format(date); } catch {}
  }
  return date.toISOString();
}

module.exports = { emailReady, waReady, sendEmail, sendWhatsApp, waNumber, formatWhen };
