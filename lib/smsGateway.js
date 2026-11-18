// Pagpapadala ng SMS sa "SMS Gateway for Android" (Local o Cloud).
// May retry sa pansamantalang error, at hindi madadamay ang ibang numero kapag may isang maling numero.

// 0917 123 4567 / 09171234567 / 9171234567 / 639171234567  ->  +639171234567
function toIntl(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (/^09\d{9}$/.test(d)) return '+63' + d.slice(1);
  if (/^9\d{9}$/.test(d)) return '+63' + d;
  if (/^639\d{9}$/.test(d)) return '+' + d;
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TIMEOUT = +process.env.SMS_TIMEOUT_MS || 30000;   // dating 15s; sobrang bilis kaya nagkakaroon ng false error
const DELAYS = [1500, 4000];                            // ilang segundong hihintayin bago ulitin (max 3 subok)

// Isang POST sa gateway. kind: auth | notfound | busy | rejected | network
async function post(cfg, numbers, text) {
  const auth = Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64');
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(cfg.url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
      body: JSON.stringify({ textMessage: { text }, phoneNumbers: numbers })
    });
    if (r.ok) return { ok: true };
    const body = (await r.text().catch(() => '')).slice(0, 200);
    console.error(`SMS gateway ${r.status}:`, body);
    if (r.status === 401 || r.status === 403) return { ok: false, kind: 'auth', error: 'Mali ang username o password ng phone.' };
    if (r.status === 404) return { ok: false, kind: 'notfound', error: 'Hindi nahanap ang gateway (code 404).' };
    if (r.status === 429 || r.status >= 500) return { ok: false, kind: 'busy', error: `Abala o may error ang phone (code ${r.status}).` };
    return { ok: false, kind: 'rejected', error: `Tinanggihan ng phone (code ${r.status}).` };
  } catch (e) {
    console.error('SMS gateway error:', e.name === 'AbortError' ? 'timeout' : (e.cause && e.cause.code) || e.message);
    return { ok: false, kind: 'network', error: e.name === 'AbortError' ? 'Natagalan ang sagot ng phone (timeout).' : 'Hindi maabot ang phone. I-check ang internet/WiFi, ang IP, at kung tumatakbo ang SMS Gateway app.' };
  } finally { clearTimeout(t); }
}

// Subukan ulit kapag pansamantala lang ang problema (network, abala ang phone).
async function sendWithRetry(cfg, numbers, text, delays = DELAYS) {
  let r = await post(cfg, numbers, text);
  if (!r.ok && r.kind === 'notfound' && /\/message$/.test(cfg.url)) {   // ibang bersyon ng app: /messages
    cfg.url += 's'; r = await post(cfg, numbers, text);
  }
  for (let i = 0; !r.ok && (r.kind === 'network' || r.kind === 'busy') && i < delays.length; i++) {
    await sleep(delays[i]); r = await post(cfg, numbers, text);
  }
  return r;
}

// numbers: listahan ng +63... Ibinabalik ang Map(numero -> { ok, error }).
async function sendMany(cfg, numbers, text, { batch = 20, delays = DELAYS } = {}) {
  const out = new Map(), list = [...new Set(numbers)];   // iisang beses lang kada numero
  let stop = null;                                       // kapag mali ang password / hindi maabot ang phone, huwag nang ituloy
  for (let i = 0; i < list.length; i += batch) {
    const chunk = list.slice(i, i + batch);
    if (stop) { chunk.forEach(n => out.set(n, { ok: false, error: stop })); continue; }
    const r = await sendWithRetry(cfg, chunk, text, delays);
    if (r.ok) { chunk.forEach(n => out.set(n, { ok: true })); continue; }
    if (r.kind === 'auth' || r.kind === 'network') { stop = r.error; chunk.forEach(n => out.set(n, { ok: false, error: r.error })); continue; }
    if (chunk.length > 1) {                              // may isang numerong tinanggihan: isa-isahin para hindi madamay ang iba
      for (const n of chunk) { const one = await sendWithRetry(cfg, [n], text, delays); out.set(n, one.ok ? { ok: true } : { ok: false, error: one.error }); }
    } else out.set(chunk[0], { ok: false, error: r.error });
  }
  return out;
}

module.exports = { toIntl, sendMany, sendWithRetry };
