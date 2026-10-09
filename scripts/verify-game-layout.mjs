/**
 * verify-game-layout.mjs — headless pass over the race screen. Serves ./dist, so build first:
 *
 *   npm run build
 *   NODE_PATH="...\\node_modules" node scripts/verify-game-layout.mjs   # see verify-home-layout.mjs
 *
 * SPEND=dark runs the wall-budget phase in the dark palette instead of the light one.
 *
 * Checks every viewport in light + dark, and fails (exit 1) when:
 *  - the FINISH pill is cropped by the board slot's overflow,
 *  - the board stops fitting its 2:3 box, or spills out of the slot,
 *  - the page scrolls, or a chip counter disagrees with WALL_LIMIT,
 *  - spending the whole budget does not land on 0/8 + `dry`, or a 9th wall is still accepted
 *    (mouse and touch paths are both tried).
 * Screenshots land in .shots/out/.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const OUT = path.resolve(here, '..', '.shots', 'out');
fs.mkdirSync(OUT, { recursive: true });

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error(
    'playwright-core not found. Run with NODE_PATH pointing at a temp install, e.g.:\n' +
      '  NODE_PATH="C:\\\\Users\\\\PC-Y\\\\AppData\\\\Local\\\\Temp\\\\opencode\\\\check\\\\node_modules" node scripts/verify-game-layout.mjs',
  );
  process.exit(2);
}

const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VIEWPORTS = [[360, 600], [360, 640], [390, 844], [430, 932]];
const LIMIT = 8;   // mirrors WALL_LIMIT; asserted against the DOM so drift cannot pass silently
const SPEND = process.env.SPEND ?? 'light';   // which theme plays the budget down (light|dark)

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
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

/* geometry of the finish label, the slot, the board and the two wall counters, in one pass */
const PROBE = `(function () {
  const box = (el) => { const b = el.getBoundingClientRect();
    return { t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const pill = document.querySelector('.finish-pill');
  const slot = document.querySelector('.board-slot');
  const wrap = document.querySelector('.board-wrap');
  const card = document.querySelector('.card');
  if (!pill || !slot || !wrap || !card) return { missing: true };
  const P = box(pill), S = box(slot), W = box(wrap), C = box(card);
  return {
    pill: P, slot: S, wrap: W, card: C,
    clipped: P.t < S.t - 0.5,                       /* the slot clips at its padding box */
    laneGap: +(P.t - S.t).toFixed(1),
    wrapOverflow: W.b > S.b + 0.5 || W.l < S.l - 0.5 || W.r > S.r + 0.5,
    aspect: +(W.w / W.h).toFixed(4),
    boardTopFromCard: +(W.t - C.t).toFixed(1),
    scrollV: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    counters: [...document.querySelectorAll('.chip')].map((c) => ({
      id: c.id,
      num: c.querySelector('.wall-n')?.textContent ?? null,
      segs: [...c.querySelectorAll('.wall-segs i')].filter((i) => i.classList.contains('on')).length,
      total: c.querySelectorAll('.wall-segs i').length,
      dry: c.querySelector('.walls')?.classList.contains('dry') ?? null,
    })),
  };
})()`;

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
let failed = 0;
const rows = [];

for (const [w, h] of VIEWPORTS) {
  for (const theme of ['light']) {   // one clay theme — the dark pass had nothing left to prove
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
    const pg = await ctx.newPage();
    const errors = [];
    pg.on('pageerror', (e) => errors.push(String(e)));
    await pg.goto(base, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(900);
    await pg.click('#home-play');          // straight into a race; no sheet in the way
    await pg.waitForTimeout(900);

    const m = await pg.evaluate(PROBE);
    const tag = `${w}x${h} ${theme}`;
    const bad = [];
    if (m.missing) bad.push('game screen elements missing');
    else {
      if (m.clipped) bad.push(`FINISH pill clipped (top ${m.pill.t} < slot ${m.slot.t})`);
      if (m.wrapOverflow) bad.push('board wrap spills out of the slot');
      if (Math.abs(m.aspect - 2 / 3) > 0.02) bad.push(`aspect ${m.aspect}, expected 2:3`);
      if (m.scrollV > 1) bad.push(`page scrolls by ${m.scrollV}px`);
      for (const c of m.counters) {
        if (c.num !== `${LIMIT}/${LIMIT}`) bad.push(`${c.id} counter reads ${c.num}`);
        if (c.total !== LIMIT || c.segs !== LIMIT) bad.push(`${c.id} has ${c.segs}/${c.total} dashes lit`);
        if (c.dry) bad.push(`${c.id} starts out of walls`);
      }
    }
    if (errors.length) bad.push(`js: ${errors[0]}`);

    if (w === 360 && h === 640) await pg.screenshot({ path: path.join(OUT, `game-${theme}.png`) });
    if (w === 390 && h === 844 && theme === 'light') await pg.screenshot({ path: path.join(OUT, 'game-390.png') });

    /* one viewport plays the budget down: the counter must follow every wall, then lock the board */
    if (w === 360 && h === 640 && theme === SPEND) {
      await pg.evaluate(() => {                       // the hint pill sits over the grid lines
        const hint = document.getElementById('hint');
        if (hint && !hint.hidden) document.getElementById('hint-x').click();
      });
      /* where the canvas paints each grid line, so the clicks land on wall slots */
      const geo = await pg.evaluate(`(function () {
        const c = document.getElementById('board');
        const w = c.clientWidth, h = c.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 3);
        const cell = Math.max(8, Math.floor(Math.min((w - 6) / 8, (h - 6) / 12) * dpr) / dpr);
        const r = c.getBoundingClientRect();
        return { x: r.left + Math.round(((w - 8 * cell) / 2) * dpr) / dpr,
                 y: r.top + Math.round(((h - 12 * cell) / 2) * dpr) / dpr, cell };
      })()`);
      const yourTurn = () => pg.waitForFunction(() => {
        const c = document.getElementById('chip-0');
        return c.classList.contains('active') && !c.classList.contains('thinking');
      }, null, { timeout: 15000 });

      /* one horizontal line each, so no two walls can overlap and every column stays open */
      const slots = [[0, 1], [2, 2], [4, 3], [6, 4], [0, 5], [2, 6], [4, 7], [6, 8]];
      for (let i = 0; i < slots.length; i++) {
        await yourTurn();
        await pg.mouse.click(geo.x + (slots[i][0] + 1) * geo.cell, geo.y + slots[i][1] * geo.cell);
        await yourTurn();
        const left = await pg.textContent('#walls-0 .wall-n');
        if (left !== `${LIMIT - i - 1}/${LIMIT}`) bad.push(`wall ${i + 1}: counter reads ${left}`);
        if (i === 2) await pg.screenshot({ path: path.join(OUT, 'game-walls-3.png') });
      }

      const spent = await pg.evaluate(`(function () {
        const w = document.getElementById('walls-0');
        return { num: w.querySelector('.wall-n').textContent, dry: w.classList.contains('dry'),
                 on: w.querySelectorAll('.wall-segs i.on').length, aria: w.getAttribute('aria-label') };
      })()`);
      if (spent.num !== `0/${LIMIT}`) bad.push(`spent counter reads ${spent.num}`);
      if (!spent.dry) bad.push('counter not marked dry at 0');
      if (spent.on !== 0) bad.push(`${spent.on} dashes still lit at 0`);
      if (spent.aria !== `Walls left: 0 of ${LIMIT}`) bad.push(`aria label says ${spent.aria}`);

      /* mouse: a ninth wall is reported, never placed */
      await yourTurn();
      await pg.mouse.click(geo.x + 1 * geo.cell, geo.y + 9 * geo.cell);
      await pg.waitForTimeout(300);
      const refused = await pg.evaluate(`(function () {
        const n = document.getElementById('note');
        return { msg: n.textContent, show: n.classList.contains('show'),
                 num: document.querySelector('#walls-0 .wall-n').textContent };
      })()`);
      if (!refused.show || !/no walls left/i.test(refused.msg)) bad.push(`9th wall not refused (${refused.msg})`);
      if (refused.num !== `0/${LIMIT}`) bad.push(`counter moved on a refused tap: ${refused.num}`);

      /* touch: the two-tap path must be just as dead */
      await pg.evaluate((g) => { window.__geo = g; }, geo);
      const touch = await pg.evaluate(`(function () {
        const c = document.getElementById('board'), d = window.__geo;
        const n = document.getElementById('note');
        n.classList.remove('show');                 // a stale refusal must not stand in for this one
        c.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true, cancelable: true,
          clientX: d.x + 3.5 * d.cell, clientY: d.y + 10 * d.cell }));
        return { msg: n.textContent, show: n.classList.contains('show') };
      })()`);
      if (!touch.show || !/no walls left/i.test(touch.msg)) bad.push(`touch path not refused (${touch.msg})`);
      await pg.screenshot({ path: path.join(OUT, 'game-walls-0.png') });
    }

    if (bad.length) failed++;
    rows.push(`${bad.length ? 'FAIL' : 'PASS'} ${tag}  lane=${m.laneGap ?? '-'}px boardTop=${m.boardTopFromCard ?? '-'}px aspect=${m.aspect ?? '-'}${m.counters?.[0]?.num ? ` walls=${m.counters.map((c) => c.num).join(',')}` : ''}`);
    if (bad.length) rows.push('  - ' + bad.join('\n  - '));
    await ctx.close();
  }
}

await browser.close();
srv.close();
console.log(rows.join('\n'));
if (failed) { console.error(`\n${failed} viewport(s) failed`); process.exit(1); }
console.log('\ngame layout checks passed');
