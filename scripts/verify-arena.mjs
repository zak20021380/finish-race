/**
 * verify-arena.mjs — serves ./dist and drives the redesigned race screen (Phase 3).
 *
 *   npm run build
 *   NODE_PATH="...\\node_modules" node scripts/verify-arena.mjs   # see verify-game-layout.mjs
 *
 * The name is a leftover: this file checks the RACE (the board, its chips and the
 * mine key), not the Arena tab. The Arena tab — the 200 Stars Grand Cup showcase —
 * is covered by scripts/verify-stars-arena.mjs.
 *
 * Layout, at 320x568 / 320x640 / 360x640 / 390x844:
 *  - the old action dock is gone; the turn pill and the chip mine key are there,
 *  - nothing overflows (page, card, chips, status, head) and every tap target is >= 44px,
 *  - the board keeps its 2:3 box and the FINISH pill is never cropped,
 *  - the equipped board paints an indigo clay slab (sampled off the canvas).
 *
 * Direct play, on 390x844, checked through the DOM *and* the pixels the board actually paints:
 *  - tap a ball -> the ring lights up and its legal cells get dots; tap a dot -> the ball moves,
 *  - tap a groove -> the ghost bar paints on that line; tap it again -> the wall goes up,
 *  - arm the chip's mine key -> the band paints, a square tap drops in the ghost mine, a second
 *    tap buries it and the key disarms,
 *  - walk a ball onto its own mine -> the trigger flash, the board shake and the knockback toast.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const OUT = path.resolve(here, '..', '.shots', 'arena');
fs.mkdirSync(OUT, { recursive: true });

const require = createRequire(path.resolve(here, '..', 'package.json'));   // playwright-core, dev-only
const { chromium } = require('playwright-core');
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

const PROBE = `(function () {
  const box = (el) => { const b = el.getBoundingClientRect();
    return { t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const over = (el) => el.scrollWidth - el.clientWidth;
  const tap = (el) => el ? Math.min(el.getBoundingClientRect().width, el.getBoundingClientRect().height) : -1;
  const wrap = document.querySelector('.board-wrap'), slot = document.querySelector('.board-slot');
  const card = document.querySelector('.card'), chip = document.getElementById('chip-0');
  const status = document.getElementById('status'), pill = document.querySelector('.finish-pill');
  const btn = document.getElementById('mine-btn'), turn = document.getElementById('turn');
  const c = document.getElementById('board');
  const ctx = c.getContext('2d');
  return {
    dock: !!document.getElementById('dock'),
    move: !!document.getElementById('act-move'),
    botKey: !!document.querySelector('#chip-1 .mine-btn'),
    pips: document.querySelectorAll('#mine-pips i.on').length,
    mineBtn: !!btn, turnText: document.getElementById('turn-text')?.textContent ?? null,
    turnTint: turn?.style.getPropertyValue('--turn') ?? null,
    pressed: btn?.getAttribute('aria-pressed') ?? null,
    disabled: btn?.disabled ?? null,
    status: status?.textContent ?? null,
    scrollV: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    overflow: { card: over(card), chip: over(chip), status: over(status), head: over(document.querySelector('.g-head')) },
    tap: { menu: tap(document.getElementById('menu-btn')), mine: tap(btn) },
    aspect: +(wrap.getBoundingClientRect().width / wrap.getBoundingClientRect().height).toFixed(4),
    clipped: pill.getBoundingClientRect().top < slot.getBoundingClientRect().top - 0.5,
    slab: Array.from(ctx.getImageData(Math.floor(c.width * 0.5), Math.floor(c.height * 0.5), 1, 1).data),
  };
})()`;

/* The longest status line the race can show, and the chip while the mine key is lit. */
const ARMED = `(function () {
  const over = (el) => el.scrollWidth - el.clientWidth;
  const chip = document.getElementById('chip-0'), status = document.getElementById('status');
  const btn = document.getElementById('mine-btn');
  const b = btn.getBoundingClientRect();
  return {
    pressed: btn.getAttribute('aria-pressed'),
    status: document.getElementById('status-text').textContent,
    overflow: { card: over(document.querySelector('.card')), chip: over(chip), status: over(status) },
    tap: Math.min(b.width, b.height),
    mineVisible: b.right <= innerWidth + 0.5 && b.left >= -0.5,
  };
})()`;

/* Where the renderer paints each cell — canvas-local for pixels, + the rect for taps. */
const GEO = `(function () {
  const c = document.getElementById('board');
  const w = c.clientWidth, h = c.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 3);
  const cell = Math.max(8, Math.floor(Math.min((w - 6) / 8, (h - 6) / 12) * dpr) / dpr);
  const r = c.getBoundingClientRect();
  const ox = Math.round(((w - 8 * cell) / 2) * dpr) / dpr, oy = Math.round(((h - 12 * cell) / 2) * dpr) / dpr;
  return { x: r.left + ox, y: r.top + oy, ox, oy, cell, dpr };
})()`;

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const rows = [];
const bad = [];
const fail = (m) => bad.push(m);
const lum = (p) => (p[0] + p[1] + p[2]) / 3;
const warm = (p) => p[0] - p[2];
const rgb = (p) => `rgb(${p.slice(0, 3)})`;

/* ---------- layout ---------- */

for (const [w, h] of [[320, 568], [320, 640], [360, 640], [390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  await pg.goto(base, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(700);
  await pg.click('#home-play');
  await pg.waitForTimeout(700);
  const m = await pg.evaluate(PROBE);
  const tag = `${w}x${h}`;
  if (m.dock || m.move) fail(`${tag}: the old action dock is still in the DOM`);
  if (!m.mineBtn) fail(`${tag}: the chip mine key is missing`);
  if (m.botKey) fail(`${tag}: the opponent chip carries a mine key`);
  if (m.pips !== 3) fail(`${tag}: the key shows ${m.pips} of 3 pips`);
  if (!m.turnText) fail(`${tag}: the turn indicator is missing`);
  if (m.scrollV > 1) fail(`${tag}: page scrolls by ${m.scrollV}px`);
  for (const [k, v] of Object.entries(m.overflow)) if (v > 0) fail(`${tag}: ${k} overflows by ${v}px`);
  if (m.tap.menu < 44 || m.tap.mine < 44) fail(`${tag}: tap target under 44px (${JSON.stringify(m.tap)})`);
  if (Math.abs(m.aspect - 2 / 3) > 0.02) fail(`${tag}: board aspect ${m.aspect}`);
  if (m.clipped) fail(`${tag}: FINISH pill cropped by the board slot`);
  const [r, g, b2] = m.slab;
  if (!(b2 > r && b2 > g && r + g + b2 < 320)) fail(`${tag}: board slab is not indigo clay (${m.slab})`);
  /* the mine key armed: the longest status line, and the lit key, still inside the phone */
  await pg.click('#mine-btn');
  await pg.waitForTimeout(250);
  const a = await pg.evaluate(ARMED);
  if (a.pressed !== 'true') fail(`${tag}: the mine key would not arm`);
  if (!/bury a mine/i.test(a.status)) fail(`${tag}: armed status reads "${a.status}"`);
  for (const [k, v] of Object.entries(a.overflow)) if (v > 0) fail(`${tag}: ${k} overflows by ${v}px while armed`);
  if (a.tap < 44 || !a.mineVisible) fail(`${tag}: the lit mine key is squeezed (${JSON.stringify(a)})`);
  await pg.screenshot({ path: path.join(OUT, `armed-${tag}.png`) });

  if (errors.length) fail(`${tag}: js ${errors[0]}`);
  await pg.screenshot({ path: path.join(OUT, `game-${tag}.png`) });
  rows.push(`layout ${tag}  slab ${rgb(m.slab)}  aspect ${m.aspect}  turn "${m.turnText}" @ ${m.turnTint}  armed ok`);
  await ctx.close();
}

/* ---------- direct play, one phone, one game ---------- */

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const pg = await ctx.newPage();
const errors = [];
pg.on('pageerror', (e) => errors.push(String(e)));
await pg.goto(base, { waitUntil: 'networkidle' });
await pg.waitForTimeout(700);
await pg.click('#home-play');
await pg.waitForTimeout(900);
await pg.evaluate(() => { const h = document.getElementById('hint'); if (h && !h.hidden) document.getElementById('hint-x').click(); });

const geo = await pg.evaluate(GEO);
await pg.evaluate((g) => { window.__g = g; }, geo);
const tap = (cx, cy) => pg.evaluate((p) => {
  document.getElementById('board').dispatchEvent(new PointerEvent('pointerdown', {
    pointerType: 'touch', bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
  }));
}, { x: geo.x + cx * geo.cell, y: geo.y + cy * geo.cell });
/**
 * What the board painted around a point, in board units: the pixel in a 13x13 box that scores
 * highest for `key` — 'lum' for white rings and ghost bars, 'warm' (red minus blue) for team
 * marks, mine ghosts and the trigger flash. A box, not a single pixel, so a couple of pixels of
 * rounding can never turn a drawn mark into a miss.
 */
const probe = async (bx, by, key, wait = 140) => {
  if (wait) await pg.waitForTimeout(wait);            // let the frame loop paint the new state
  return pg.evaluate((p) => {
    const g = window.__g, c = document.getElementById('board');
    const x0 = Math.round((g.ox + p.bx * g.cell) * g.dpr) - 6, y0 = Math.round((g.oy + p.by * g.cell) * g.dpr) - 6;
    const d = c.getContext('2d').getImageData(x0, y0, 13, 13).data;
    let best = null;
    for (let i = 0; i < d.length; i += 4) {
      const pix = [d[i], d[i + 1], d[i + 2], d[i + 3]];
      const score = p.key === 'lum' ? pix[0] + pix[1] + pix[2] : pix[0] - pix[2];
      if (!best || score > best[0]) best = [score, pix];
    }
    return best[1];
  }, { bx, by, key });
};
const yourTurn = () => pg.waitForFunction(() => {
  const c = document.getElementById('chip-0');
  return c.classList.contains('active') && !c.classList.contains('thinking');
}, null, { timeout: 20000 });
const state = () => pg.evaluate(() => ({
  status: document.getElementById('status-text').textContent,
  note: document.getElementById('note').classList.contains('show') ? document.getElementById('note').textContent : '',
  walls0: document.getElementById('walls-0').querySelector('.wall-n').textContent,
  depleted: document.getElementById('walls-0').classList.contains('depleted'),
  pips: document.querySelectorAll('#mine-pips i.on').length,
  pressed: document.getElementById('mine-btn').getAttribute('aria-pressed'),
  shake: document.querySelector('.board-wrap').classList.contains('shake'),
}));
const wallsOf = (t) => Number(t);

await yourTurn();
const s = await state();

/* 1 — direct move: the ball is at 3,11. Its ring and its dots must appear, then the dot moves it. */
const ringBefore = await probe(3.98, 11.5, 'lum');
const dotBefore = await probe(3.5, 10.5, 'warm');
await tap(3.5, 11.5);
const picked = await state();
if (!/your move/i.test(picked.status)) fail(`move: tapping a ball did not light it up (${picked.status})`);
const ringAfter = await probe(3.98, 11.5, 'lum');
const dotAfter = await probe(3.5, 10.5, 'warm');
if (lum(ringAfter) < lum(ringBefore) + 60) fail(`move: no selection ring (${rgb(ringBefore)} -> ${rgb(ringAfter)})`);
if (warm(dotAfter) < warm(dotBefore) + 20 || lum(dotAfter) < lum(dotBefore) + 15) {
  fail(`move: no legal-move dot (${rgb(dotBefore)} -> ${rgb(dotAfter)})`);
}
await tap(3.5, 10.5);
await pg.waitForTimeout(400);
const moved = await state();
if (wallsOf(moved.walls0) !== wallsOf(s.walls0)) fail(`move: a move changed the wall budget (${s.walls0} -> ${moved.walls0})`);
if (/pick one of your balls|your move/i.test(moved.status)) fail(`move: the turn never passed (${moved.status})`);
rows.push(`move  walls ${s.walls0} -> ${moved.walls0}, ring lum ${lum(ringBefore) | 0}->${lum(ringAfter) | 0}, dot lum ${lum(dotBefore) | 0}->${lum(dotAfter) | 0}`);

/* 2 — direct wall: the groove above the ball. First tap paints the ghost, second puts it up. */
await yourTurn();
const grooveBefore = await probe(4, 9, 'lum');
await tap(3.5, 9);
const armed = await state();
const grooveGhost = await probe(4, 9, 'lum');
if (!/tap again to place/i.test(armed.note)) fail(`wall: first groove tap did not arm a ghost (${JSON.stringify(armed)})`);
if (lum(grooveGhost) < lum(grooveBefore) + 60) fail(`wall: no ghost bar on the groove (${rgb(grooveBefore)} -> ${rgb(grooveGhost)})`);
await pg.screenshot({ path: path.join(OUT, 'wall-armed.png') });
await tap(3.5, 9);
await pg.waitForTimeout(500);
const walled = await state();
const grooveWall = await probe(4, 9, 'lum');
if (/tap again to place/i.test(walled.note)) fail('wall: the ghost never confirmed');
if (wallsOf(walled.walls0) !== wallsOf(moved.walls0) - 1) fail(`wall: the budget never dropped (${moved.walls0} -> ${walled.walls0})`);
rows.push(`wall  ghost ${rgb(grooveGhost)} -> placed ${rgb(grooveWall)}, walls ${moved.walls0} -> ${walled.walls0}`);

/* 3 — the chip's mine key: the band paints, a tap drops the ghost in, a second tap buries it. */
await yourTurn();
const bandBefore = await probe(1.5, 5.5, 'warm');
await pg.click('#mine-btn');
const armedMine = await state();
const bandAfter = await probe(1.5, 5.5, 'warm');
if (armedMine.pressed !== 'true') fail('mine: the key did not arm');
if (!/bury a mine/i.test(armedMine.status)) fail(`mine: status while armed reads ${armedMine.status}`);
if (warm(bandAfter) < warm(bandBefore) + 3) fail(`mine: the band never painted (${rgb(bandBefore)} -> ${rgb(bandAfter)})`);
await pg.screenshot({ path: path.join(OUT, 'mine-armed.png') });
const cellBefore = await probe(6.5, 5.5, 'warm');
await tap(6.5, 5.5);
const ghost = await state();
const cellGhost = await probe(6.5, 5.5, 'warm');
if (!/tap again to bury/i.test(ghost.note)) fail(`mine: first square tap did not arm a ghost (${JSON.stringify(ghost)})`);
if (warm(cellGhost) < 20) fail(`mine: no ghost mine in the square (${rgb(cellBefore)} -> ${rgb(cellGhost)})`);
await pg.screenshot({ path: path.join(OUT, 'mine-ghost.png') });
await tap(6.5, 5.5);
await pg.waitForTimeout(500);
const buried = await state();
const cellMine = await probe(6.5, 5.5, 'warm');
if (buried.pressed !== 'false') fail('mine: the key stayed armed after the mine went down');
if (/bury a mine/i.test(buried.status)) fail(`mine: status after burying reads ${buried.status}`);
if (warm(cellMine) < 15) fail(`mine: nothing buried in the square (${rgb(cellMine)})`);
await yourTurn();
const spent = await state();
if (spent.pips !== 2) fail(`mine: the budget still reads ${spent.pips} of 3 after one mine`);
rows.push(`mine  band ${rgb(bandAfter)} ghost ${rgb(cellGhost)} buried ${rgb(cellMine)}, budget ${spent.pips}/3`);

/* 4 — re-tapping the key hands direct play straight back */
await pg.click('#mine-btn');
const on2 = await state();
await pg.click('#mine-btn');
const off2 = await state();
if (on2.pressed !== 'true' || off2.pressed !== 'false') fail('mine: re-tapping the key did not disarm it');
rows.push(`mine  key toggles ${on2.pressed} -> ${off2.pressed}`);

/* 5 — the trigger: bury one right above the ball, then walk onto it.
       The flash is sampled at once; the burst's light is sampled later, once the ball has been
       thrown clear of the square and only the FX is left on it. */
await pg.click('#mine-btn');
await tap(3.5, 9.5);
await tap(3.5, 9.5);
await pg.waitForTimeout(300);
await yourTurn();
await tap(3.5, 10.5);                       // pick up the ball on 3,10
await tap(3.5, 9.5);                        // step onto the mine
const boom = await state();
const flash = await probe(3.5, 9.5, 'lum', 0);    // the flash is only up for the first fifth
await pg.screenshot({ path: path.join(OUT, 'blast.png') });
const burst = await probe(3.5, 9.5, 'warm');       // …and the burst's light outlives it
await pg.screenshot({ path: path.join(OUT, 'blast-late.png') });
if (!/^Mine!/.test(boom.note)) fail(`blast: no trigger toast (${JSON.stringify(boom)})`);
if (!/thrown back 2 cells/.test(boom.note)) fail(`blast: toast reads "${boom.note}"`);
if (!boom.shake) fail('blast: the board never shook');
if (lum(flash) < 150) fail(`blast: no flash on the mine square (${rgb(flash)})`);
if (warm(burst) < -10) fail(`blast: the burst's light is gone too early (${rgb(burst)})`);
rows.push(`blast toast "${boom.note}", shake ${boom.shake}, flash lum ${lum(flash) | 0}, burst ${rgb(burst)}`);

await pg.waitForTimeout(1200);
await pg.screenshot({ path: path.join(OUT, 'play.png') });
if (errors.length) fail(`js: ${errors[0]}`);

/* ---------- the same renderer paints every shop and profile preview ---------- */

/* only canvases that are really on screen: a hidden screen is still in the DOM, unpainted */
const painted = (root) => pg.evaluate((sel) => {
  const out = [];
  for (const c of document.querySelectorAll(`${sel} canvas.cos-pv`)) {
    if (!c.offsetWidth) continue;
    const d = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height * 0.7), 1, 1).data;
    out.push([d[0], d[1], d[2], d[3]]);
  }
  return { n: out.length, painted: out.filter((p) => p[3] > 0).length, first: out[0] ?? null };
}, root);

/* leave the race first: the bottom nav only belongs to the menu screens */
await pg.click('#menu-btn');
await pg.waitForTimeout(350);
await pg.click('#pause-quit');
await pg.waitForTimeout(300);
await pg.click('#quit-yes');
await pg.waitForTimeout(600);
await pg.click('.tab[data-tab="shop"]');
await pg.waitForTimeout(500);
await pg.click('[data-shop="board"]');
await pg.waitForTimeout(600);
const shop = await painted('#s-shop');
await pg.screenshot({ path: path.join(OUT, 'shop-boards.png') });
if (shop.n < 4) fail(`shop: only ${shop.n} board cards (the catalog lost one)`);
if (shop.painted !== shop.n) fail(`shop: ${shop.n - shop.painted} board previews came out blank`);
rows.push(`shop  ${shop.n} board previews, all painted, first ${rgb(shop.first)}`);

await pg.click('.tab[data-tab="profile"]');
await pg.waitForTimeout(600);
const prof = await painted('#s-profile');
if (prof.n && prof.painted !== prof.n) fail('profile: an equipped preview came out blank');
rows.push(`profile  ${prof.n} previews, ${prof.painted} painted`);

/* the board's own theme is the one equipped in the shop, so the two can never disagree */
await pg.click('.tab[data-tab="home"]');
await pg.waitForTimeout(400);
await pg.click('#home-play');
await pg.waitForTimeout(700);
const back = await pg.evaluate(PROBE);
if (back.slab[3] === 0) fail('game: the board came back blank after a tour of the shop');
rows.push(`game  back from the shop with slab ${rgb(back.slab)}`);
if (errors.length) fail(`js: ${errors[0]}`);
await ctx.close();

await browser.close();
srv.close();
console.log(rows.join('\n'));
if (bad.length) { console.error('\nFAIL\n - ' + bad.join('\n - ')); process.exit(1); }
console.log('\narena checks passed');
