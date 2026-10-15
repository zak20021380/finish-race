/**
 * play-actions-check.mjs — serves ./dist and drives a live race, to the pixel:
 *
 *   npm run build
 *   NODE_PATH="%TEMP%\opencode\pwcheck\node_modules" node scripts/play-actions-check.mjs
 *
 * Two things the board has to keep saying the same way, checked in the running app
 * rather than in the source:
 *
 *  1. The wall preview's two action chips. Arming a wall hangs a [✓] and a [✕] beside
 *     it; the chips are sampled off `#board`'s own pixels, so what is measured is what
 *     is painted — emerald confirm, crimson cancel, each carrying a white glyph, the
 *     confirm on the right. The same window is sampled with nothing armed first, so a
 *     board that simply always draws those colours cannot pass.
 *  2. The blitz clock. On a fresh turn the HUD numeral starts at 8 and steps down once
 *     a second, and the radial ring's dash offset is a fraction of 8 — not of some
 *     other allowance the economy may once have shipped with. The Command Center's own
 *     stepper is read too, so the default runtime and the clock are the same number.
 *
 * Screenshots land in .shots/play/.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const OUT = path.resolve(here, '..', '.shots', 'play');
fs.mkdirSync(OUT, { recursive: true });

const require = createRequire(path.resolve(here, '..', 'package.json'));
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core not found. Point NODE_PATH at a temp install, e.g.:\n' +
    '  NODE_PATH="%TEMP%\\opencode\\pwcheck\\node_modules" node scripts/play-actions-check.mjs');
  process.exit(2);
}
const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(String(req.url).split('?')[0]);
  if (p === '/') p = '/index.html';
  fs.readFile(path.join(DIST, p.slice(1)), (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`;

/* The two ramps `render.ts` paints the chips with, and the white glyph on top of them. */
const OK_RGB = [34, 197, 94];      // themes.ts OK_RAMP.mid  #22c55e
const NO_RGB = [239, 68, 68];      // themes.ts NO_RAMP.mid  #ef4444

/**
 * Count pixels matching an action chip's face inside one window of the canvas, and the
 * near-white pixels inside the cluster's own bounding box — a chip is a coloured disc
 * with a glyph punched through it, and either half missing is a failure.
 */
const SAMPLER = (rgb, box) => `(function () {
  const c = document.getElementById('board');
  const g = c.getContext('2d');
  const dpr = c.width / c.getBoundingClientRect().width;
  const x0 = Math.max(0, Math.round((${box.x0} - c.getBoundingClientRect().left) * dpr));
  const x1 = Math.min(c.width, Math.round((${box.x1} - c.getBoundingClientRect().left) * dpr));
  const y0 = Math.max(0, Math.round((${box.y0} - c.getBoundingClientRect().top) * dpr));
  const y1 = Math.min(c.height, Math.round((${box.y1} - c.getBoundingClientRect().top) * dpr));
  const w = x1 - x0;
  const d = g.getImageData(x0, y0, w, y1 - y0).data;
  const [R, G, B] = [${rgb[0]}, ${rgb[1]}, ${rgb[2]}];
  const TOL = 24;
  let n = 0, cx0 = 1e9, cx1 = -1, cy0 = 1e9, cy1 = -1;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i] - R) > TOL || Math.abs(d[i + 1] - G) > TOL || Math.abs(d[i + 2] - B) > TOL) continue;
    const px = (i / 4) % w, py = ((i / 4) / w) | 0;
    n++;
    if (px < cx0) cx0 = px; if (px > cx1) cx1 = px;
    if (py < cy0) cy0 = py; if (py > cy1) cy1 = py;
  }
  let white = 0;
  for (let py = cy0; py <= cy1; py++) {
    for (let px = cx0; px <= cx1; px++) {
      const i = (py * w + px) * 4;
      if (d[i] >= 232 && d[i + 1] >= 232 && d[i + 2] >= 232) white++;
    }
  }
  return { n, white, cx: (cx0 + cx1) / 2, box: [cx0, cy0, cx1, cy1] };
})()`;

const bad = [];
const rows = [];
const fail = (m) => { bad.push(m); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true });
const pg = await ctx.newPage();
const errors = [];
pg.on('pageerror', (e) => errors.push(String(e)));
await pg.goto(base, { waitUntil: 'networkidle' });
await pg.waitForTimeout(300);
await pg.click('#home-play');                 // straight into a race; no sheet in the way
await pg.waitForTimeout(900);
await pg.evaluate(() => {                     // the hint pill sits over the grid lines
  const hint = document.getElementById('hint');
  if (hint && !hint.hidden) document.getElementById('hint-x').click();
});

/* Where the canvas paints each grid line, exactly as verify-game-layout measures it. */
const geo = await pg.evaluate(`(function () {
  const c = document.getElementById('board');
  const w = c.clientWidth, h = c.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 3);
  const cell = Math.max(8, Math.floor(Math.min((w - 6) / 8, (h - 6) / 12) * dpr) / dpr);
  const r = c.getBoundingClientRect();
  return { x: r.left + Math.round(((w - 8 * cell) / 2) * dpr) / dpr,
           y: r.top + Math.round(((h - 12 * cell) / 2) * dpr) / dpr, cell,
           left: r.left, top: r.top, right: r.right, bottom: r.bottom };
})()`);
/* a 4-cell window around a candidate wall slot: wide enough for both chips, clear of the
   finish strip at row 0, so only the chips can paint these colours inside it */
const windowAt = (col, row) => ({
  x0: geo.x + (col - 1) * geo.cell, x1: geo.x + (col + 3) * geo.cell,
  y0: geo.y + (row - 2) * geo.cell, y1: geo.y + (row + 2) * geo.cell,
});

const yourTurn = () => pg.waitForFunction(() => {
  const c = document.getElementById('chip-0');
  return c.classList.contains('active') && !c.classList.contains('thinking');
}, null, { timeout: 20000 });

/* ---------- 1. the action chips, in pixels ---------- */

const slots = [[2, 4], [4, 3], [6, 5], [2, 6], [4, 7], [6, 8]];
let armed = null, before = null, after = null;
for (const [col, row] of slots) {
  await yourTurn();
  const win = windowAt(col, row);
  const pre = await pg.evaluate(SAMPLER(OK_RGB, win));
  const preNo = await pg.evaluate(SAMPLER(NO_RGB, win));
  const wx = geo.x + (col + 1) * geo.cell, wy = geo.y + row * geo.cell;
  await pg.mouse.click(wx, wy);               // one press: the preview arms, it does not commit
  await pg.waitForTimeout(140);
  const ok = await pg.evaluate(SAMPLER(OK_RGB, win));
  const no = await pg.evaluate(SAMPLER(NO_RGB, win));
  if (ok.n < 120 || no.n < 120) continue;     // that slot did not arm a preview; try the next
  armed = { col, row, wx, wy };
  before = { ok: pre, no: preNo };
  after = { ok, no };
  break;
}

if (!armed) {
  fail('chips: no wall slot armed a preview with both action chips painted');
} else {
  const tag = `chip @ ${armed.col},${armed.row}`;
  if (before.ok.n > 40 || before.no.n > 40) {
    fail(`${tag}: the board already paints those colours unarmed (emerald ${before.ok.n}px, crimson ${before.no.n}px)`);
  }
  if (after.ok.n < 120) fail(`${tag}: the confirm chip is too small to be an emerald disc (${after.ok.n}px)`);
  if (after.no.n < 120) fail(`${tag}: the cancel chip is too small to be a crimson disc (${after.no.n}px)`);
  if (after.ok.white < 8) fail(`${tag}: no white tick on the confirm chip (${after.ok.white} white px)`);
  if (after.no.white < 8) fail(`${tag}: no white cross on the cancel chip (${after.no.white} white px)`);
  if (!(after.ok.cx > after.no.cx)) {
    fail(`${tag}: the confirm chip is not to the right of the cancel chip (${after.ok.cx} vs ${after.no.cx})`);
  }
  await pg.screenshot({ path: path.join(OUT, 'chips-360x640.png') });
  rows.push(`chips  armed ${tag}: emerald ${after.ok.n}px (+${after.ok.n - before.ok.n}) ` +
    `crimson ${after.no.n}px (+${after.no.n - before.no.n}), glyphs ${after.ok.white}/${after.no.white} white px`);
}

/* ---------- 2. the blitz clock: 8s, ringed against 8s ---------- */

const readClock = () => pg.evaluate(() => {
  const chip = document.getElementById('chip-0');
  const fill = document.getElementById('timer-fill');
  return {
    n: document.getElementById('timer-n').textContent.trim(),
    timer: chip.getAttribute('data-timer'),
    timing: chip.classList.contains('timing'),
    offset: parseFloat(fill.style.strokeDashoffset || 'NaN'),
  };
});

if (armed) {
  /* commit the preview so the turn passes and a fresh clock starts on the way back */
  await pg.mouse.click(armed.wx, armed.wy);
  await pg.waitForTimeout(200);
}

await pg.waitForFunction(() => document.getElementById('chip-0').classList.contains('timing'),
  null, { timeout: 25000 });
const start = await readClock();
const RING_C = 2 * Math.PI * 21;
if (start.n !== '8') fail(`clock: the turn opened on ${start.n}s, not 8s`);
if (!near(start.offset, 0, 2)) fail(`clock: the ring starts at offset ${start.offset}, not a full arc`);

/* the tick, and the ring's own scale: at 7s the arc must be a fraction of *eight* seconds */
await pg.waitForFunction(() => document.getElementById('timer-n').textContent.trim() === '7',
  null, { timeout: 3000 }).catch(() => fail('clock: the countdown never reached 7s'));
const tick = await readClock();
const wantOffset = RING_C * (1 - Number(tick.n) / 8);
if (Number(tick.n) > 7 || Number(tick.n) < 6) fail(`clock: after the first tick the HUD reads ${tick.n}s`);
if (!near(tick.offset, wantOffset, 3)) {
  fail(`clock: at ${tick.n}s the ring is offset ${tick.offset.toFixed(1)}, which is ` +
    `${(1 - tick.offset / RING_C) * 100}% of an arc — not ${tick.n}/8 (want ${wantOffset.toFixed(1)})`);
}
if (tick.timer !== 'accent') fail(`clock: at ${tick.n}s the chip wears data-timer="${tick.timer}"`);
await pg.screenshot({ path: path.join(OUT, 'clock-360x640.png') });
rows.push(`clock  8s at turn start, ticked to ${tick.n}s, ring ${tick.offset.toFixed(1)}/${wantOffset.toFixed(1)} (of 8s), timer="${tick.timer}"`);

/* ---------- 3. the Command Center's own allowance ---------- */

const stepper = await pg.evaluate(() => {
  const fab = document.getElementById('btn-admin-fab');
  if (!fab) return { missing: true };
  fab.hidden = false;                          // the FAB ships hidden outside admin accounts
  fab.click();
  const val = document.querySelector('.adm-tune[data-step="blitz"] .adm-val');
  return { missing: !val, val: val ? val.textContent.trim() : null };
});
if (stepper.missing) fail('runtime: the Command Center carries no blitz stepper');
else if (stepper.val !== '8s') fail(`runtime: the Command Center allowance reads "${stepper.val}", not "8s"`);
else rows.push('runtime Command Center blitz stepper reads 8s');
await pg.screenshot({ path: path.join(OUT, 'command-center-blitz.png') });

if (errors.length) fail(`js: ${errors[0]}`);

await ctx.close();
await browser.close();
srv.close();
console.log(rows.join('\n'));
if (bad.length) { console.error('\nFAIL\n - ' + bad.join('\n - ')); process.exit(1); }
console.log('\nplay action checks passed');
