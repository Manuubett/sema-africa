// SemaAfrica notifications
// Email: Brevo HTTPS API
// WhatsApp: Meta Cloud API

const env = process.env;

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

// ------------------------------------
// EMAIL CONFIGURATION
// ------------------------------------

function getSender() {
  const raw = String(env.MAIL_FROM || '').trim();

  // Supports: SemaAfrica <email@example.com>
  const match = raw.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);

  if (match) {
    return {
      name: match[1].replace(/^["']|["']$/g, '') || 'SemaAfrica',
      email: match[2].trim(),
    };
  }

  return {
    name: env.BREVO_SENDER_NAME || 'SemaAfrica',
    email: raw,
  };
}

const emailReady = () => {
  const sender = getSender();

  return !!(
    env.BREVO_API_KEY &&
    sender.email &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender.email)
  );
};

// Send email through Brevo API
async function sendEmail(to, subject, text, html) {
  if (!emailReady()) {
    throw new Error(
      'Brevo email settings missing. Check BREVO_API_KEY and MAIL_FROM.'
    );
  }

  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to).trim())) {
    throw new Error('Invalid recipient email address.');
  }

  if (typeof fetch !== 'function') {
    throw new Error('Node.js 18 or later is required for built-in fetch.');
  }

  const sender = getSender();

  const payload = {
    sender: {
      name: sender.name,
      email: sender.email,
    },
    to: [
      {
        email: String(to).trim(),
      },
    ],
    subject: String(subject || 'SemaAfrica Notification'),
    textContent: String(text || ''),
    htmlContent: String(html || ''),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(BREVO_URL, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': env.BREVO_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseText = await response.text();

    let result = {};

    try {
      result = responseText ? JSON.parse(responseText) : {};
    } catch {
      result = {};
    }

    if (!response.ok) {
      const message =
        result.message ||
        result.code ||
        `HTTP ${response.status}`;

      throw new Error(`Brevo API error (${response.status}): ${message}`);
    }

    console.log(
      '[email] Accepted by Brevo:',
      result.messageId || 'Message accepted'
    );

    return result;

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Brevo email request timed out.');
    }

    console.error('[email error]', error.message);
    throw error;

  } finally {
    clearTimeout(timeout);
  }
}

// ------------------------------------
// WHATSAPP CONFIGURATION
// ------------------------------------

const waReady = () =>
  !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID);

async function sendWhatsApp(to, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const r = await fetch(
      `https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_ID}/messages`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: 'Bearer ' + env.WHATSAPP_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: env.WHATSAPP_TEMPLATE || 'class_reminder',
            language: {
              code: env.WHATSAPP_LANG || 'en',
            },
            components: [
              {
                type: 'body',
                parameters: params.map(t => ({
                  type: 'text',
                  text: String(t).replace(/\s+/g, ' ').slice(0, 200),
                })),
              },
            ],
          },
        }),
      }
    );

    if (!r.ok) {
      const d = await r.json().catch(() => ({}));

      throw new Error(
        'WhatsApp: ' +
        ((d.error && d.error.message) || r.status)
      );
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('WhatsApp request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ------------------------------------
// PHONE NUMBER FORMATTING
// ------------------------------------

function waNumber(p) {
  let d = String(p || '').replace(/\D/g, '');

  // 00254712... (international "00" prefix) -> 254712...
  if (d.startsWith('00')) d = d.slice(2);

  if (d.startsWith('0')) {
    d = '254' + d.slice(1);
  } else if (/^[17]\d{8}$/.test(d)) {
    d = '254' + d;
  }

  return /^\d{9,15}$/.test(d) ? d : null;
}

// ------------------------------------
// LESSON DATE FORMATTING
// ------------------------------------

function formatWhen(date, tz) {
  const opts = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  };

  for (const z of [
    tz,
    env.TIMEZONE,
    'Africa/Nairobi',
  ]) {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        ...opts,
        timeZone: z || undefined,
      }).format(date);
    } catch {}
  }

  return date.toISOString();
}

// ------------------------------------
// EXPORT FUNCTIONS
// ------------------------------------

module.exports = {
  emailReady,
  waReady,
  sendEmail,
  sendWhatsApp,
  waNumber,
  formatWhen,
};
