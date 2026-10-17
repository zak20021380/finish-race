/**
 * verify-dock.mjs — the race HUD's own audit: the chat slot, the two cards, the sealed mine cell.
 *
 *   npm run build
 *   node scripts/verify-dock.mjs
 *
 * Serves ./dist, drives a real duel, and fails (exit 1) when:
 *  - the chat key is not a >=38x38 target, leaves the dock, or overlaps the slab / a card,
 *  - the two cards are not the same width and height, or their resource cells are not the same
 *    size and on the same line (the "symmetric cockpit" promise),
 *  - the opponent's mine cell ever prints a number instead of the concealed mark, or the local
 *    seat's cell fails to print one,
 *  - arming the mine and burying one does not move the local count,
 *  - the page scrolls, or the HUD spills horizontally at 360x640 / 360x600 / 390x844 / 430x932.
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
  console.error('playwright-core not found. Run with NODE_PATH pointing at an install of it.');
  process.exit(2);
}

const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VIEWPORTS = [[360, 640], [360, 600], [390, 844], [430, 932]];
const MINES = 3;                                  // CONFIG.MINES_PER_TEAM
const MINE_MARGIN = 8;                            // the clear band the slab keeps under the board box

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

const PROBE = `(function () {
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1),
             w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const hits = (a, b) => !!a && !!b && a.l < b.r - 0.5 && a.r > b.l + 0.5 && a.t < b.b - 0.5 && a.b > b.t + 0.5;
  const chip0 = document.getElementById('chip-0'), chip1 = document.getElementById('chip-1');
  const dock = document.getElementById('chips'), chat = document.getElementById('chat-btn');
  const wrap = document.querySelector('.board-wrap'), slot = document.querySelector('.board-slot');
  const card = document.querySelector('.card');
  const w0 = document.getElementById('walls-0'), m0 = document.getElementById('mine-btn');
  const w1 = document.getElementById('walls-1'), f1 = chip1 && chip1.querySelector('.mine-fog');
  const res0 = document.getElementById('res-0'), res1 = document.getElementById('res-1');
  if (!chip0 || !chip1 || !dock || !chat || !wrap || !slot || !card || !w0 || !m0 || !w1 || !f1) {
    return { missing: true };
  }
  const B = (el) => box(el);
  const C0 = B(chip0), C1 = B(chip1), D = B(dock), K = B(chat), W = B(wrap), S = B(slot), A = B(card);
  return {
    view: { w: innerWidth, h: innerHeight },
    scroll: {
      v: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      h: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    },
    card: A, dock: D, chat: K, wrap: W, slot: S,
    chips: [C0, C1],
    chatHits: { slab: hits(K, W), card0: hits(K, C0), card1: hits(K, C1) },
    insideDock: K.l >= D.l - 0.5 && K.r <= D.r + 0.5 && K.t >= D.t - 0.5 && K.b <= D.b + 0.5,
    gapUnderSlab: +(K.t - W.b).toFixed(1),
    // symmetry: same card box, same cell boxes, same left offset inside their card
    cards: { dw: +(C0.w - C1.w).toFixed(1), dh: +(C0.h - C1.h).toFixed(1) },
    cells: {
      wall0: B(w0), mine0: B(m0),
      wall1: B(w1), mine1: B(f1),
      dw0: +(B(w0).w - B(w1).w).toFixed(1),
      dh0: +(B(w0).h - B(w1).h).toFixed(1),
      dh1: +(B(m0).h - B(f1).h).toFixed(1),
      pair0: +(B(w0).h - B(m0).h).toFixed(1),
      pair1: +(B(w1).h - B(f1).h).toFixed(1),
      line0: +(B(w0).t - B(m0).t).toFixed(1),
      line1: +(B(w1).t - B(f1).t).toFixed(1),
      inset0: +(B(w0).l - C0.l).toFixed(1),
      inset1: +(B(w1).l - C1.l).toFixed(1),
    },
    // the order inside the dock is walls then mines on both cards
    order: {
      zero: (res0 && res0.children[0].id === 'walls-0' && res0.children[1].id === 'mine-btn'),
      one: (res1 && res1.children[0].id === 'walls-1' && !!res1.children[1].classList.contains('mine-fog')),
    },
    // fog of war: a mark, never a count
    fog: {
      text: (f1.querySelector('.fog-n') || {}).textContent ?? null,
      digits: /[0-9]/.test((f1.querySelector('.fog-n') || {}).textContent || ''),
      aria: f1.getAttribute('aria-label'),
      state: f1.dataset.fog,
      local: (m0.querySelector('#mine-n') || {}).textContent ?? null,
      localDigits: /^[0-9]+$/.test((m0.querySelector('#mine-n') || {}).textContent || ''),
    },
    // the chat pill is a real control, not a decoration
    chatKey: {
      tag: chat.tagName, disabled: chat.disabled,
      expanded: chat.getAttribute('aria-expanded'),
      label: chat.getAttribute('aria-label'),
      overflow: chat.scrollWidth - chat.clientWidth,
    },
    overflow: {
      card: A ? document.querySelector('.card').scrollWidth - document.querySelector('.card').clientWidth : 0,
      dock: dock.scrollWidth - dock.clientWidth,
      chip0: chip0.scrollWidth - chip0.clientWidth,
      chip1: chip1.scrollWidth - chip1.clientWidth,
    },
  };
})()`;

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
let failed = 0;
const rows = [];

for (const [w, h] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'light' });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  await pg.goto(base, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(900);
  await pg.click('#home-play');
  await pg.waitForTimeout(1000);

  const m = await pg.evaluate(PROBE);
  const bad = [];
  const tag = `${w}x${h}`;
  if (m.missing) bad.push('dock elements missing');
  else {
    /* 1 — the chat slot */
    if (m.chat.w < 38 || m.chat.h < 38) bad.push(`chat key is ${m.chat.w}x${m.chat.h}, under 38x38`);
    if (!m.insideDock) bad.push('chat key leaves the dock');
    if (m.chatHits.slab) bad.push('chat key overlaps the board slab');
    if (m.chatHits.card0 || m.chatHits.card1) bad.push('chat key overlaps a player card');
    if (m.gapUnderSlab < MINE_MARGIN) bad.push(`chat key only ${m.gapUnderSlab}px under the slab`);

    /* 2 — the two cards mirror each other */
    if (Math.abs(m.cards.dw) > 0.5) bad.push(`cards differ in width by ${m.cards.dw}px`);
    if (Math.abs(m.cards.dh) > 0.5) bad.push(`cards differ in height by ${m.cards.dh}px`);
    if (Math.abs(m.cells.dw0) > 0.5) bad.push(`wall cells differ in width by ${m.cells.dw0}px`);
    if (Math.abs(m.cells.dh0) > 0.5) bad.push(`wall cells differ in height by ${m.cells.dh0}px`);
    if (Math.abs(m.cells.dh1) > 0.5) bad.push(`mine cells differ in height by ${m.cells.dh1}px`);
    if (Math.abs(m.cells.pair0) > 0.5) bad.push(`local wall/mine cells are ${m.cells.pair0}px out of line`);
    if (Math.abs(m.cells.pair1) > 0.5) bad.push(`rival wall/mine cells are ${m.cells.pair1}px out of line`);
    if (Math.abs(m.cells.line0) > 0.5) bad.push(`local cells sit ${m.cells.line0}px apart vertically`);
    if (Math.abs(m.cells.line1) > 0.5) bad.push(`rival cells sit ${m.cells.line1}px apart vertically`);
    if (Math.abs(m.cells.inset0 - m.cells.inset1) > 0.5) {
      bad.push(`the two resource docks start ${Math.abs(m.cells.inset0 - m.cells.inset1)}px apart`);
    }
    if (!m.order.zero || !m.order.one) bad.push('resource cells are not walls-then-mines on both cards');

    /* 3 — fog of war */
    if (m.fog.digits) bad.push(`the rival's mine cell prints a number: ${m.fog.text}`);
    if (m.fog.text !== '?') bad.push(`the rival's mine cell reads ${JSON.stringify(m.fog.text)}, expected "?"`);
    if (!/concealed/i.test(m.fog.aria || '')) bad.push(`rival mine aria says ${m.fog.aria}`);
    if (!m.fog.localDigits) bad.push(`the local mine cell reads ${JSON.stringify(m.fog.local)}`);
    if (m.fog.local !== String(MINES)) bad.push(`the local mine cell starts at ${m.fog.local}, expected ${MINES}`);

    /* 4 — geometry */
    if (m.scroll.v > 1) bad.push(`page scrolls vertically by ${m.scroll.v}px`);
    if (m.scroll.h > 1) bad.push(`page scrolls horizontally by ${m.scroll.h}px`);
    for (const [k, v] of Object.entries(m.overflow)) if (v > 1) bad.push(`${k} overflows by ${v}px`);
    if (!m.chatKey.label || m.chatKey.tag !== 'BUTTON') bad.push('chat key is not a labelled button');
  }
  if (errors.length) bad.push(`js: ${errors[0]}`);

  if (w === 360 && h === 640) await pg.screenshot({ path: path.join(OUT, 'dock-360.png') });

  /* 5 — the mine still works from its new cell, and burying one moves only your number */
  if (w === 360 && h === 640 && !m.missing) {
    await pg.waitForFunction(() => document.getElementById('chip-0').classList.contains('active'),
      null, { timeout: 15000 });
    await pg.click('#mine-btn');
    const armed = await pg.evaluate(() => document.getElementById('mine-btn').getAttribute('aria-pressed'));
    if (armed !== 'true') bad.push(`mine key did not arm (aria-pressed=${armed})`);
    await pg.screenshot({ path: path.join(OUT, 'dock-mine-armed.png') });

    /* a cell in the middle band: off the finish, off the start, off both balls */
    const geo = await pg.evaluate(`(function () {
      const c = document.getElementById('board');
      const w = c.clientWidth, h = c.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 3);
      const cell = Math.max(8, Math.floor(Math.min((w - 6) / 8, (h - 6) / 12) * dpr) / dpr);
      const r = c.getBoundingClientRect();
      return { x: r.left + Math.round(((w - 8 * cell) / 2) * dpr) / dpr,
               y: r.top + Math.round(((h - 12 * cell) / 2) * dpr) / dpr, cell };
    })()`);
    const tx = geo.x + 3.5 * geo.cell;
    const ty = geo.y + 5.5 * geo.cell;
    await pg.mouse.click(tx, ty);
    await pg.mouse.click(tx, ty);
    await pg.waitForTimeout(700);
    const after = await pg.evaluate(`(function () {
      const n = document.querySelector('#mine-btn #mine-n');
      const f = document.querySelector('#chip-1 .mine-fog .fog-n');
      return { mine: n ? n.textContent : null, fog: f ? f.textContent : null,
               pressed: document.getElementById('mine-btn').getAttribute('aria-pressed') };
    })()`);
    if (after.mine !== String(MINES - 1)) bad.push(`burying a mine left the count at ${after.mine}`);
    if (after.fog !== '?') bad.push(`the rival's cell stopped concealing after a placement: ${after.fog}`);
    if (after.pressed !== 'false') bad.push('the mine key stayed armed after placing');
    await pg.screenshot({ path: path.join(OUT, 'dock-mine-placed.png') });

    /* the chat sheet still opens from its new slot */
    await pg.click('#chat-btn');
    await pg.waitForTimeout(360);
    const sheet = await pg.evaluate(`(function () {
      const s = document.getElementById('chat-sheet');
      const k = document.getElementById('chat-btn');
      return { open: !!s && !s.hidden && s.classList.contains('open'),
               expanded: k.getAttribute('aria-expanded') };
    })()`);
    if (!sheet.open) bad.push('the chat sheet did not open from the console slot');
    if (sheet.expanded !== 'true') bad.push('chat key did not report aria-expanded=true');
    await pg.screenshot({ path: path.join(OUT, 'dock-chat-open.png') });
  }

  if (bad.length) failed++;
  rows.push(`${bad.length ? 'FAIL' : 'PASS'} ${tag}  chat=${m.chat ? `${m.chat.w}x${m.chat.h}` : '-'}`
    + ` cards=${m.chips ? `${m.chips[0].w}x${m.chips[0].h}` : '-'}`
    + ` gap=${m.gapUnderSlab ?? '-'}px fog=${m.fog?.text ?? '-'}`);
  if (bad.length) rows.push('  - ' + bad.join('\n  - '));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(rows.join('\n'));
if (failed) { console.error(`\n${failed} viewport(s) failed`); process.exit(1); }
console.log('\ndock checks passed');
