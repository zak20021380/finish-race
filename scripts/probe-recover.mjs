import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const DIST = path.join(root, 'dist');
const OUT = path.join(root, '.shots', 'recover');
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(String(req.url).split('?')[0]);
  if (p === '/') p = '/index.html';
  fs.readFile(path.join(DIST, p.slice(1)), (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = path.join(root, '.tmp', 'cdp-recover-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9333', '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

for (let i = 0; i < 120; i++) {
  try { const r = await fetch('http://127.0.0.1:9333/json/version'); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 150));
}
const pageUrl = (await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json()).webSocketDebuggerUrl;

const ws = new WebSocket(pageUrl);
const waiters = new Map();
let seq = 0;
await new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  const w = waiters.get(msg.id);
  if (!w) return;
  waiters.delete(msg.id);
  msg.error ? w.reject(new Error(JSON.stringify(msg.error))) : w.resolve(msg.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; waiters.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
await send('Page.enable');
await send('Runtime.enable');
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

const report = [];
for (const [w, h] of [[320, 568], [360, 640], [390, 844], [430, 932]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
  await new Promise((r) => setTimeout(r, 2400));
  const setup = await ev(`(() => {
    const bank = document.getElementById('result-bank');
    const overlay = document.getElementById('overlay');
    const stake = document.getElementById('result-stake');
    const rec = document.getElementById('btn-recover-tiq');
    const dbl = document.getElementById('btn-double-coins');
    const tiq = document.getElementById('result-tiq-chip');
    if (!bank || !overlay) return { ok: false };
    for (const el of document.querySelectorAll('.screen')) el.hidden = el.dataset.screen !== 'game';
    for (let n = overlay; n && n !== document.body; n = n.parentElement) n.hidden = false;
    overlay.classList.add('result', 'lose'); overlay.classList.remove('win');
    const card = document.getElementById('result-card'); if (card) card.hidden = false;
    if (stake) stake.hidden = false;
    if (rec) { rec.hidden = false; rec.classList.remove('is-claimed','is-exhausted'); rec.removeAttribute('aria-disabled'); }
    if (tiq) tiq.hidden = true;
    if (dbl) { dbl.hidden = false; dbl.classList.remove('is-claimed'); }
    const q = document.getElementById('recover-tiq-quota'); if (q) { q.hidden = false; q.textContent = '3/3'; }
    const lbl = document.getElementById('recover-tiq-label'); if (lbl) lbl.textContent = 'RECOVER';
    const d = document.getElementById('double-coins-label'); if (d) d.textContent = '2×';
    return { ok: true };
  })()`);
  await ev(`(() => { const s=document.createElement('style'); s.textContent='*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.append(s); })()`);
  await new Promise((r) => setTimeout(r, 120));
  const m = await ev(`(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { w:+b.width.toFixed(2), h:+b.height.toFixed(2), cy:+(b.top+b.height/2).toFixed(2), left:+b.left.toFixed(2), right:+b.right.toFixed(2) }; };
    const rec = document.getElementById('btn-recover-tiq');
    const dbl = document.getElementById('btn-double-coins');
    const bank = document.getElementById('result-bank');
    const quota = document.getElementById('recover-tiq-quota');
    const label = document.getElementById('recover-tiq-label');
    const icon = rec && rec.querySelector('.ad-chip-ico');
    const out = {
      recover: r(rec), double: r(dbl), bank: r(bank), quota: r(quota), label: r(label), icon: r(icon),
      recCss: getComputedStyle(rec).height, dblCss: getComputedStyle(dbl).height,
      border: getComputedStyle(rec).borderColor,
      bankScrollW: bank.scrollWidth, bankClientW: bank.clientWidth,
      pageScrollW: document.documentElement.scrollWidth, pageClientW: document.documentElement.clientWidth,
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
    const a = rec.getBoundingClientRect(), b = dbl.getBoundingClientRect();
    out.heightDelta = +(a.height - b.height).toFixed(2);
    out.centreDelta = +((a.top+a.height/2) - (b.top+b.height/2)).toFixed(2);
    const c = (n) => { const q = n.getBoundingClientRect(); return q.top + q.height/2; };
    out.baselineSpread = +Math.abs(Math.max(c(icon),c(label),c(quota)) - Math.min(c(icon),c(label),c(quota))).toFixed(2);
    return out;
  })()`);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'bank-' + w + 'x' + h + '.png'), Buffer.from(shot.data, 'base64'));
  report.push({ viewport: w + 'x' + h, setup, m });
}
console.log(JSON.stringify(report, null, 2));
chrome.kill(); srv.close(); process.exit(0);
