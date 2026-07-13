const nodemailer = require('nodemailer');
const { kv } = require('@vercel/kv');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

const ALLOWED_ORIGINS = [
  'https://dereksealcoating.com',
  'https://www.dereksealcoating.com',
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const VALID_SERVICES = [
  'Residential Sealcoating',
  'Commercial Sealcoating',
  'Crack Filling',
  'Line Striping',
  'Other',
];

function sanitize(val) {
  if (typeof val !== 'string') return '';
  return val.trim().replace(/[<>]/g, '').slice(0, 2000);
}

function formatEastern(ts) {
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function buildEmailHtml(fields, ts) {
  const { name, phone, email, address, service, message } = fields;
  const row = (label, val, link) =>
    `<tr>
      <td style="padding:.6rem 0;border-bottom:1px solid rgba(255,255,255,.06);color:#777;font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;font-weight:600;width:38%;vertical-align:top;">${label}</td>
      <td style="padding:.6rem 0 .6rem 1rem;border-bottom:1px solid rgba(255,255,255,.06);color:#F0F0EE;line-height:1.6;">${link ? `<a href="${link}" style="color:#FFD100;text-decoration:none;">${val}</a>` : val}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,sans-serif;background:#0A0A0A;color:#F0F0EE;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#1A1A1A;border-radius:12px;overflow:hidden;border:1px solid rgba(255,209,0,.25);">
    <div style="background:#0A0A0A;border-bottom:3px solid #FFD100;padding:1.25rem 1.75rem;">
      <p style="margin:0 0 .25rem;font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;color:#FFD100;font-weight:700;">New Lead · Derek's Sealcoating</p>
      <h1 style="margin:0;font-size:1.4rem;font-weight:700;color:#F0F0EE;">Estimate Request</h1>
    </div>
    <div style="padding:1.5rem 1.75rem;">
      <table style="width:100%;border-collapse:collapse;">
        ${row('Name', name)}
        ${row('Phone', phone, `tel:${phone.replace(/\D/g, '')}`)}
        ${row('Email', email, `mailto:${email}`)}
        ${row('Address', address)}
        ${row('Service', `<span style="background:rgba(255,209,0,.12);border:1px solid rgba(255,209,0,.3);border-radius:100px;padding:2px 12px;color:#FFD100;font-size:.85rem;">${service}</span>`)}
        ${message ? row('Message', message.replace(/\n/g, '<br>')) : ''}
      </table>
    </div>
    <div style="background:#0A0A0A;padding:.875rem 1.75rem;text-align:center;border-top:1px solid rgba(255,255,255,.06);">
      <p style="margin:0;font-size:.7rem;color:#555;">Submitted ${formatEastern(ts)} ET</p>
    </div>
  </div>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  const isAllowedOrigin =
    ALLOWED_ORIGINS.includes(origin) ||
    /^http:\/\/localhost(:\d+)?$/.test(origin);

  res.setHeader('Access-Control-Allow-Origin', isAllowedOrigin ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};

    // Honeypot — silent accept so bots think they succeeded
    if (body.website) {
      return res.status(200).json({ success: true });
    }

    const name = sanitize(body.name);
    const phone = sanitize(body.phone);
    const email = sanitize(body.email);
    const address = sanitize(body.address);
    const service = sanitize(body.service);
    const message = sanitize(body.message);

    // Server-side validation
    const errors = {};
    if (!name) errors.name = 'Name is required';
    if (!phone || phone.replace(/\D/g, '').length < 10) errors.phone = 'Valid phone number required (10 digits)';
    if (!email || !EMAIL_RE.test(email)) errors.email = 'Valid email address required';
    if (!address) errors.address = 'Property address is required';
    if (!service || !VALID_SERVICES.includes(service)) errors.service = 'Please select a valid service';

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Please check your form for errors.', fields: errors });
    }

    // Rate limiting via Vercel KV (5 submissions per IP per hour)
    const ip = ((req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown')
      .split(',')[0]
      .trim());

    try {
      const key = `rl:${ip}`;
      const count = await kv.incr(key);
      if (count === 1) await kv.expire(key, 3600);
      if (count > 5) {
        return res.status(429).json({
          error: 'Too many requests. Please wait a while and try again, or call us at 610-635-8830.',
        });
      }
    } catch (kvRateErr) {
      console.error('[submit-form] KV rate-limit error:', kvRateErr.message);
      // Non-fatal — continue processing
    }

    const ts = Date.now();
    const submission = { name, phone, email, address, service, message, ip, submittedAt: new Date(ts).toISOString() };

    // Backup to KV (90-day retention)
    try {
      await kv.set(`sub:${ts}`, JSON.stringify(submission), { ex: 60 * 60 * 24 * 90 });
    } catch (kvSaveErr) {
      console.error('[submit-form] KV backup save error:', kvSaveErr.message);
    }

    // Send email notification via Gmail SMTP
    try {
      await transporter.sendMail({
        from: `"Derek's Sealcoating" <${process.env.GMAIL_USER}>`,
        to: 'dereksealcoating@gmail.com',
        subject: `New Estimate Request — ${name} (${service})`,
        html: buildEmailHtml({ name, phone, email, address, service, message }, ts),
        replyTo: email,
      });
    } catch (emailErr) {
      console.error('[submit-form] Gmail send error:', emailErr.message);
      // Backup was already saved — tell the user but don't lose their submission
      return res.status(500).json({
        error: 'Your request was received but our notification system hit a snag. Please call us at 610-635-8830 to confirm.',
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[submit-form] Unhandled error:', err);
    return res.status(500).json({
      error: 'An unexpected error occurred. Please try again or call us at 610-635-8830.',
    });
  }
};
