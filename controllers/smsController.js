const SmsLog = require('../models/SmsLog');
const Household = require('../models/Household');
const Setting = require('../models/Setting');
const { toIntl, sendMany, sendWithRetry } = require('../lib/smsGateway');

// Dalawang mode:
//  1) REAL  - kapag may SMS_GATEWAY_URL sa .env: ipapadala sa Android phone (app: "SMS Gateway for Android")
//  2) DEMO  - kapag wala: simulated lang (random Delivered/Failed), walang totoong text
const GATEWAY = (process.env.SMS_GATEWAY_URL || '').trim();
const BATCH = +process.env.SMS_BATCH_SIZE || 20; // ilang numero kada request (para hindi ma-block ang SIM)

// Settings galing sa app (Settings > SMS Gateway). Kapag wala, .env ang gagamitin.
async function getCfg() {
  const d = await Setting.findOne({ key: 'sms' }).lean(), v = (d && d.value) || {};
  if (v.enabled && v.mode === 'cloud') return { url: 'https://api.sms-gate.app/3rdparty/v1/messages', user: v.user || '', pass: v.pass || '' };
  if (v.enabled && v.ip) return { url: `http://${v.ip}:${v.port || 8080}/message`, user: v.user || '', pass: v.pass || '' };
  if (!d && GATEWAY) return { url: GATEWAY, user: process.env.SMS_GATEWAY_USER || '', pass: process.env.SMS_GATEWAY_PASS || '' };
  return { url: '' };
}

async function sendTo(households, text) {
  const cfg = await getCfg();
  let logs;
  if (!cfg.url) {
    logs = households.map(h => ({
      household: h._id, householdId: h.householdId, name: h.name, phone: h.phone, group: h.group,
      text, status: Math.random() < 0.92 ? 'Delivered' : 'Failed'
    }));
  } else {
    const items = households.map(h => ({ h, num: toIntl(h.phone) }));
    const res = await sendMany(cfg, items.filter(i => i.num).map(i => i.num), text, { batch: BATCH });
    logs = items.map(({ h, num }) => {
      const r = num && res.get(num), ok = !!(r && r.ok);
      return { household: h._id, householdId: h.householdId, name: h.name, phone: h.phone, group: h.group, text,
        status: ok ? 'Sent' : 'Failed', error: ok ? '' : (!num ? 'Maling numero ng telepono.' : (r && r.error) || 'Hindi naipadala.') };
    });
  }
  if (logs.length) await SmsLog.insertMany(logs);
  return logs.length;
}

exports.getConfig = async (req, res) => {
  const d = await Setting.findOne({ key: 'sms' }).lean(), v = (d && d.value) || {};
  res.json({ mode: v.mode === 'cloud' ? 'cloud' : 'local', ip: v.ip || '', port: v.port || 8080, user: v.user || '', hasPass: !!v.pass, enabled: !!v.enabled, live: !!(await getCfg()).url });
};
exports.saveConfig = async (req, res) => {
  const { ip, port, user, pass, enabled, mode } = req.body, old = ((await Setting.findOne({ key: 'sms' }).lean()) || {}).value || {};
  const cleanIp = String(ip || '').trim().replace(/^https?:\/\//, '').replace(/:\d+.*$/, '').replace(/\/.*$/, '');
  const m = mode === 'cloud' ? 'cloud' : 'local';
  if (enabled && m === 'cloud' && (!String(user || '').trim() || !(pass || old.pass))) return res.status(400).json({ error: 'Ilagay ang username at password mula sa Cloud server ng app.' });
  if (enabled && m === 'local' && !/^[\w.\-]+$/.test(cleanIp)) return res.status(400).json({ error: 'Ilagay ang tamang IP ng phone (hal. 192.168.43.1).' });
  const p = +port || 8080; if (p < 1 || p > 65535) return res.status(400).json({ error: 'Maling port.' });
  const value = { mode: m, ip: cleanIp, port: p, user: String(user || '').trim(), pass: pass ? String(pass) : (old.pass || ''), enabled: !!enabled };
  await Setting.findOneAndUpdate({ key: 'sms' }, { value }, { upsert: true });
  res.json({ ok: true });
};
exports.test = async (req, res) => {
  const cfg = await getCfg(), num = toIntl(req.body.phone);
  if (!cfg.url) return res.status(400).json({ error: 'Naka-off pa ang SMS gateway. I-on at i-save muna ang settings.' });
  if (!num) return res.status(400).json({ error: 'Maling numero. Gamitin ang format na 09xx xxx xxxx.' });
  const r = await sendWithRetry(cfg, [num], 'ABISO: Test message. Gumagana ang SMS gateway ng barangay.');
  r.ok ? res.json({ ok: true }) : res.status(502).json({ error: r.error });
};
exports.sendTo = sendTo;

// Ipadala ulit ang mga "Failed" sa nakaraang 24 oras (hal. nawala ang WiFi ng phone noon).
exports.retryFailed = async (req, res) => {
  const cfg = await getCfg();
  if (!cfg.url) return res.status(400).json({ error: 'Naka-off pa ang SMS gateway. I-on at i-save muna ang settings.' });
  const logs = await SmsLog.find({ status: 'Failed', createdAt: { $gte: new Date(Date.now() - 864e5) } });
  const byText = new Map();
  for (const l of logs) { if (!toIntl(l.phone)) continue; if (!byText.has(l.text)) byText.set(l.text, []); byText.get(l.text).push(l); }
  let tried = 0, sent = 0;
  for (const [text, group] of byText) {
    const out = await sendMany(cfg, group.map(l => toIntl(l.phone)), text, { batch: BATCH });
    for (const l of group) {
      const r = out.get(toIntl(l.phone)); tried++;
      if (r && r.ok) { sent++; await SmsLog.updateOne({ _id: l._id }, { status: 'Sent', error: '' }); }
      else if (r) await SmsLog.updateOne({ _id: l._id }, { error: r.error || '' });
    }
  }
  res.json({ tried, sent });
};

exports.send = async (req, res) => {
  const { ids = [], text } = req.body;
  if (!ids.length || !text) return res.status(400).json({ error: 'Pumili ng households at magsulat ng mensahe.' });
  const n = await sendTo(await Household.find({ _id: { $in: ids } }), text);
  res.json({ sent: n });
};
exports.list = async (req, res) => res.json(await SmsLog.find().sort({ createdAt: -1 }).limit(300));
exports.stats = async (req, res) => {
  const [sent, delivered, failed] = await Promise.all([
    SmsLog.countDocuments(), SmsLog.countDocuments({ status: { $in: ['Delivered', 'Sent'] } }), SmsLog.countDocuments({ status: 'Failed' })]);
  res.json({ sent, delivered, failed });
};
