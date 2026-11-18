const path = require('path');
const Setting = require('../models/Setting');
const LOGO = { filename: 'logo.png', path: path.join(__dirname, '..', 'public', 'logo-email.png'), cid: 'abisologo' };

// Email notification. Dalawang paraan:
//  - Gmail (SMTP + App Password): gumagana sa laptop/PC at sa hosting na hindi nagba-block ng SMTP.
//  - Brevo (HTTPS API, libre ang 300 email/araw): para sa libreng hosting (hal. Render) na nagba-block ng SMTP.
const BREVO_URL = process.env.BREVO_URL || 'https://api.brevo.com/v3/smtp/email';
const okMail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
let cached = null;

async function getCfg() {
  const d = await Setting.findOne({ key: 'email' }).lean(), v = (d && d.value) || {};
  return v.enabled && v.user && v.pass ? { provider: v.provider === 'brevo' ? 'brevo' : 'gmail', user: v.user, pass: v.pass } : null;
}
const FROM = 'ABISO Barangay Cambalo';

// Ipadala sa Brevo gamit ang HTTPS API (hindi SMTP kaya hindi na-block ng libreng hosting).
async function brevoSend(cfg, to, m) {
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(BREVO_URL, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'api-key': cfg.pass, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: FROM, email: cfg.user }, to: [{ email: to }], subject: m.subject, htmlContent: m.html, textContent: m.text })
    });
    if (r.ok) return;
    const j = await r.json().catch(() => ({})), e = new Error(j.message || 'HTTP ' + r.status); e.status = r.status; throw e;
  } finally { clearTimeout(t); }
}
// Isang padala, anuman ang provider.
async function deliver(cfg, to, m) {
  if (cfg.provider === 'brevo') return brevoSend(cfg, to, m);
  return makeTransport(cfg).sendMail({ from: `"${FROM}" <${cfg.user}>`, to, ...m });
}
function friendly(cfg, e) {
  const msg = String(e && e.message || e);
  if (cfg.provider === 'brevo') {
    if (/ip/i.test(msg) && /unrecogni|authori|not allowed/i.test(msg)) return 'The server’s IP address is blocked in Brevo. In Brevo, go to Security > Authorised IPs and deactivate IP blocking.';
    if (e.status === 401 || /key/i.test(msg)) return 'The Brevo API key is invalid.';
    if (/sender/i.test(msg)) return 'The sender email address has not yet been verified in Brevo. Open Senders, Domains & Dedicated IPs, then select Senders to verify it.';
    if (e.status === 402 || e.status === 429 || /limit|quota/i.test(msg)) return 'Naabot na ang daily limit ng Brevo (300/araw sa libre).';
    if (e.name === 'AbortError') return 'Natagalan ang sagot ng Brevo.';
    return 'Hindi naipadala: ' + msg;
  }
  return /Invalid login|Username and Password|535/i.test(msg) ? 'Mali ang Gmail o App Password.' : 'Hindi naipadala: ' + msg;
}
function makeTransport(cfg) {
  const nodemailer = require('nodemailer'); // kailangan ang: npm install
  const sig = cfg.user + cfg.pass;
  if (!cached || cached.sig !== sig) cached = { sig, tr: nodemailer.createTransport({ service: 'gmail', pool: true, maxConnections: 3, auth: { user: cfg.user, pass: cfg.pass } }) };
  return cached.tr;
}
const when = d => { try { return new Date(d).toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Manila' }); } catch (e) { return ''; } };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function build(a, { logo = true } = {}) {
  const lines = [a.message, '', a.eventDate ? 'Petsa/Oras: ' + when(a.eventDate) : '', a.location ? 'Lokasyon: ' + a.location : ''].filter((x, i) => x || i === 1);
  const text = lines.join('\n') + '\n\n— Barangay Cambalo (ABISO)';
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:34rem;margin:auto;border:1px solid #dcebe3;border-radius:12px;overflow:hidden">
    <div style="background:#2f6b57;color:#fff;padding:12px 18px"><table role="presentation" style="border:0"><tr>${logo ? '<td style="padding-right:12px"><img src="cid:abisologo" width="44" height="44" alt="" style="display:block"></td>' : ''}<td style="color:#fff"><b style="font-size:20px;letter-spacing:1px">ABISO</b><br><span style="font-size:12px;opacity:.85">Barangay Cambalo, Cajidiocan, Romblon</span></td></tr></table></div>
    <div style="padding:18px;color:#1c3029"><h2 style="margin:0 0 10px">${esc(a.title)}</h2><p style="white-space:pre-line">${esc(a.message)}</p>
    ${a.eventDate ? `<p><b>Petsa/Oras:</b> ${esc(when(a.eventDate))}</p>` : ''}${a.location ? `<p><b>Lokasyon:</b> ${esc(a.location)}</p>` : ''}</div>
    <div style="padding:10px 18px;background:#f3f8f5;color:#66807a;font-size:12px">Mensaheng ito ay mula sa Barangay Cambalo.</div></div>`;
  return { subject: 'ABISO: ' + a.title, text, html, ...(logo ? { attachments: [LOGO] } : {}) };
}

// Ipinapadala sa background (hindi hinihintay) para hindi bumagal ang pag-publish. Ibinabalik ang bilang ng may email.
exports.notifyHouseholds = async (households, a) => {
  const cfg = await getCfg(); if (!cfg) return 0;
  const to = [...new Set(households.map(h => h.head && h.head.email).filter(okMail).map(e => e.trim()))];
  if (!to.length) return 0;
  if (cfg.provider !== 'brevo') { try { makeTransport(cfg); } catch (e) { console.error('Email: wala ang nodemailer. Patakbuhin ang "npm install".'); return 0; } }
  const m = build(a, { logo: cfg.provider !== 'brevo' });
  (async () => {
    for (const addr of to) {
      try { await deliver(cfg, addr, m); }
      catch (e) {
        if (e.status >= 500 || e.name === 'AbortError') { try { await new Promise(r => setTimeout(r, 2000)); await deliver(cfg, addr, m); continue; } catch (e2) { e = e2; } }
        console.error('Email failed:', addr, friendly(cfg, e));
      }
    }
  })();
  return to.length;
};

exports.getConfig = async (req, res) => {
  const d = await Setting.findOne({ key: 'email' }).lean(), v = (d && d.value) || {};
  res.json({ provider: v.provider === 'brevo' ? 'brevo' : 'gmail', user: v.user || '', hasPass: !!v.pass, enabled: !!v.enabled });
};
exports.saveConfig = async (req, res) => {
  const { user, pass, enabled } = req.body, old = ((await Setting.findOne({ key: 'email' }).lean()) || {}).value || {};
  const provider = req.body.provider === 'brevo' ? 'brevo' : 'gmail', oldProv = old.provider === 'brevo' ? 'brevo' : 'gmail';
  const label = provider === 'brevo' ? 'sender email' : 'Gmail address';
  if (enabled && !okMail(user)) return res.status(400).json({ error: 'Ilagay ang tamang ' + label + '.' });
  const keep = provider === oldProv ? (old.pass || '') : '';   // magkaiba ang Gmail App Password at Brevo API key
  const clean = pass ? (provider === 'brevo' ? String(pass).trim() : String(pass).replace(/\s+/g, '')) : keep;
  const value = { provider, user: String(user || '').trim(), pass: clean, enabled: !!enabled };
  if (enabled && !value.pass) return res.status(400).json({ error: provider === 'brevo' ? 'Ilagay ang Brevo API key.' : 'Ilagay ang Gmail App Password.' });
  await Setting.findOneAndUpdate({ key: 'email' }, { value }, { upsert: true });
  res.json({ ok: true });
};
exports.test = async (req, res) => {
  const cfg = await getCfg(), to = String(req.body.email || '').trim();
  if (!cfg) return res.status(400).json({ error: 'Naka-off pa ang email. I-on at i-save muna ang settings.' });
  if (!okMail(to)) return res.status(400).json({ error: 'Maling email address.' });
  if (cfg.provider !== 'brevo') { try { makeTransport(cfg); } catch (e) { return res.status(500).json({ error: 'Wala pa ang nodemailer. Patakbuhin ang "npm install" sa folder ng app.' }); } }
  try { await deliver(cfg, to, build({ title: 'Test email', message: 'Gumagana ang email notification ng ABISO.' }, { logo: cfg.provider !== 'brevo' })); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: friendly(cfg, e) }); }
};
