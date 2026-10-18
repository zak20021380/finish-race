/**
 * verify-dock.mjs — the race HUD's own audit: the 34px circular chat orb, the two 46px obsidian
 * cards, the barricade wall glyph, the 38px tactical mine key, and the concealed rival stash.
 *
 *   npm run build
 *   node scripts/verify-dock.mjs
 *
 * Serves ./dist, drives a real duel, and fails (exit 1) when:
 *  - the chat key is not a 34x34 circular target, prints any text, leaves the dock, or overlaps
 *    the slab / a card,
 *  - a player card is taller than 48px, or the two cards are not the same width and height,
 *  - the wall pill does not carry the new 16x12 barricade glyph,
 *  - the mine key is not a cohesive 38x38 interactive pod at the card's right end, or its glyph
 *    is not the detailed multi-shape tactical mine, or its count is not a recessed micro-pill
 *    set into the key's base (bottom-centre, inside the key),
 *  - the opponent's key ever prints a number instead of the concealed mark, or the local key
 *    fails to print one,
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
const MAX_STRIP_H = 48;                           // the ultra-slim card's ceiling
const CHAT = 34;                                  // the circular chat key
const POD = 38;                                   // the tactical mine key

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
  const dock = document.getElementById('chips'), chat = document.getElementById('chat-toggle');
  const wrap = document.querySelector('.board-wrap'), slot = document.querySelector('.board-slot');
  const card = document.querySelector('.card');
  const w0 = document.getElementById('walls-0'), m0 = document.getElementById('mine-btn');
  const w1 = document.getElementById('walls-1'), f1 = chip1 && chip1.querySelector('.mine-fog');
  if (!chip0 || !chip1 || !dock || !chat || !wrap || !slot || !card || !w0 || !m0 || !w1 || !f1) {
    return { missing: true };
  }
  const B = (el) => box(el);
  const C0 = B(chip0), C1 = B(chip1), D = B(dock), K = B(chat), W = B(wrap), A = B(card);
  const glyph = (el) => {
    const svg = el && el.querySelector('svg.bomb-ico');
    const use = svg && svg.querySelector('use');
    return { svg: !!svg, href: use ? use.getAttribute('href') : null };
  };
  const wallHref = (el) => {
    const use = el && el.querySelector('use');
    return use ? use.getAttribute('href') : null;
  };
  const sym = document.getElementById('i-mine-tactical');
  const wallSym = document.getElementById('i-wall');
  const badge = m0.querySelector('#mine-n');
  const badgeBox = B(badge), podBox = B(m0);
  const centred = badgeBox && podBox
    ? +(((badgeBox.l + badgeBox.r) / 2) - ((podBox.l + podBox.r) / 2)).toFixed(1)
    : null;
  return {
    view: { w: innerWidth, h: innerHeight },
    scroll: {
      v: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      h: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    },
    card: A, dock: D, chat: K, wrap: W, slot: B(slot),
    chips: [C0, C1],
    chatHits: { slab: hits(K, W), card0: hits(K, C0), card1: hits(K, C1) },
    insideDock: K.l >= D.l - 0.5 && K.r <= D.r + 0.5 && K.t >= D.t - 0.5 && K.b <= D.b + 0.5,
    gapUnderSlab: +(K.t - W.b).toFixed(1),
    // symmetry: same card box, same wall pill box, same key box
    strips: { dw: +(C0.w - C1.w).toFixed(1), dh: +(C0.h - C1.h).toFixed(1) },
    walls: { dw: +(B(w0).w - B(w1).w).toFixed(1), dh: +(B(w0).h - B(w1).h).toFixed(1) },
    // the barricade: both cards carry the new fortress glyph, drawn on a 16x12 canvas
    wallGlyph: {
      href0: wallHref(w0), href1: wallHref(w1),
      viewBox: wallSym ? wallSym.getAttribute('viewBox') : null,
      shapes: wallSym ? wallSym.querySelectorAll('rect, path').length : 0,
    },
    // the tactical key: a cohesive 38x38 interactive pod with an integrated base badge
    pod: {
      box: podBox, fog: B(f1), tag: m0.tagName, disabled: m0.disabled,
      last0: chip0.lastElementChild === m0,
      last1: chip1.lastElementChild === f1,
      dw: +(podBox.w - B(f1).w).toFixed(1),
      dh: +(podBox.h - B(f1).h).toFixed(1),
      local: glyph(m0), rival: glyph(f1),
      parts: sym ? sym.querySelectorAll('path, circle, polygon').length : 0,
      badge: badgeBox ? {
        centred,
        insideX: badgeBox.l >= podBox.l && badgeBox.r <= podBox.r,
        insetFromBase: +(podBox.b - badgeBox.b).toFixed(1),
        onBase: badgeBox.t >= podBox.t + podBox.h / 2,
      } : null,
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
    // the chat key is a real control with zero text: one glyph, nothing else
    chatKey: {
      tag: chat.tagName, disabled: chat.disabled,
      expanded: chat.getAttribute('aria-expanded'),
      label: chat.getAttribute('aria-label'),
      overflow: chat.scrollWidth - chat.clientWidth,
      text: (chat.textContent || '').trim(),
      glyphs: chat.querySelectorAll('svg').length,
      square: Math.abs(K.w - K.h) <= 0.5,
      radius: getComputedStyle(chat).borderRadius,
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
    /* 1 — the chat key: an icon-only circular orb slotted between the two cards */
    if (Math.abs(m.chat.w - CHAT) > 0.5 || Math.abs(m.chat.h - CHAT) > 0.5) {
      bad.push(`chat key is ${m.chat.w}x${m.chat.h}, want ${CHAT}x${CHAT}`);
    }
    if (!m.chatKey.square) bad.push(`chat key is ${m.chat.w}x${m.chat.h}, not square`);
    if (!/50%/.test(m.chatKey.radius) && parseFloat(m.chatKey.radius) < CHAT / 2 - 0.5) {
      bad.push(`chat key is not circular: border-radius ${m.chatKey.radius}`);
    }
    if (m.chatKey.text !== '') bad.push(`chat key prints text: ${JSON.stringify(m.chatKey.text)}`);
    if (m.chatKey.glyphs !== 1) bad.push(`chat key carries ${m.chatKey.glyphs} svg glyphs, want exactly 1`);
    if (!m.insideDock) bad.push('chat key leaves the dock');
    if (m.chatHits.slab) bad.push('chat key overlaps the board slab');
    if (m.chatHits.card0 || m.chatHits.card1) bad.push('chat key overlaps a player card');
    if (m.gapUnderSlab < MINE_MARGIN) bad.push(`chat key only ${m.gapUnderSlab}px under the slab`);

    /* 2 — the two cards mirror each other, both ultra-slim */
    if (m.chips[0].h > MAX_STRIP_H || m.chips[1].h > MAX_STRIP_H) {
      bad.push(`a player card is ${m.chips[0].h}px tall, over ${MAX_STRIP_H}px`);
    }
    if (Math.abs(m.strips.dw) > 0.5) bad.push(`cards differ in width by ${m.strips.dw}px`);
    if (Math.abs(m.strips.dh) > 0.5) bad.push(`cards differ in height by ${m.strips.dh}px`);
    if (Math.abs(m.walls.dw) > 0.5) bad.push(`wall pills differ in width by ${m.walls.dw}px`);
    if (Math.abs(m.walls.dh) > 0.5) bad.push(`wall pills differ in height by ${m.walls.dh}px`);

    /* 3 — the barricade glyph: the new fortress course, not the old two pills */
    if (m.wallGlyph.href0 !== '#i-wall' || m.wallGlyph.href1 !== '#i-wall') {
      bad.push(`wall glyph is ${m.wallGlyph.href0}/${m.wallGlyph.href1}, want #i-wall on both cards`);
    }
    if (m.wallGlyph.viewBox !== '0 0 16 12') {
      bad.push(`wall glyph canvas is ${m.wallGlyph.viewBox}, want 0 0 16 12`);
    }
    if (m.wallGlyph.shapes < 12) {
      bad.push(`the barricade is only ${m.wallGlyph.shapes} shapes, want the detailed fortress glyph`);
    }

    /* 4 — the tactical mine key: a cohesive 38x38 pod with an integrated base pill */
    if (Math.abs(m.pod.box.w - POD) > 0.5 || Math.abs(m.pod.box.h - POD) > 0.5) {
      bad.push(`mine key is ${m.pod.box.w}x${m.pod.box.h}, want ${POD}x${POD}`);
    }
    if (m.pod.tag !== 'BUTTON') bad.push(`mine key is a ${m.pod.tag}, not a button`);
    if (Math.abs(m.pod.dw) > 0.5 || Math.abs(m.pod.dh) > 0.5) {
      bad.push(`the two keys differ by ${m.pod.dw}x${m.pod.dh}px`);
    }
    if (!m.pod.last0 || !m.pod.last1) bad.push('a mine key is not the card\'s right-hand end');
    if (!m.pod.local.svg || m.pod.local.href !== '#i-mine-tactical') {
      bad.push(`local key glyph is ${m.pod.local.href}, want #i-mine-tactical`);
    }
    if (!m.pod.rival.svg || m.pod.rival.href !== '#i-mine-tactical') {
      bad.push(`rival key glyph is ${m.pod.rival.href}, want #i-mine-tactical`);
    }
    if (m.pod.parts < 12) bad.push(`the mine glyph is only ${m.pod.parts} shapes, want the detailed tactical mine`);
    if (!m.pod.badge) bad.push('the local key has no count pill');
    else {
      if (Math.abs(m.pod.badge.centred) > 1.5) {
        bad.push(`the count pill is ${m.pod.badge.centred}px off the key's centre line`);
      }
      if (!m.pod.badge.insideX) bad.push('the count pill leaves the key horizontally');
      if (m.pod.badge.insetFromBase < 1 || m.pod.badge.insetFromBase > 6) {
        bad.push(`the count pill sits ${m.pod.badge.insetFromBase}px off the key base, want it set in`);
      }
      if (!m.pod.badge.onBase) bad.push('the count pill is not set into the key base');
    }

    /* 5 — fog of war */
    if (m.fog.digits) bad.push(`the rival's key prints a number: ${m.fog.text}`);
    if (m.fog.text !== '?') bad.push(`the rival's key reads ${JSON.stringify(m.fog.text)}, expected "?"`);
    if (!/concealed/i.test(m.fog.aria || '')) bad.push(`rival key aria says ${m.fog.aria}`);
    if (!m.fog.localDigits) bad.push(`the local key reads ${JSON.stringify(m.fog.local)}`);
    if (m.fog.local !== String(MINES)) bad.push(`the local key starts at ${m.fog.local}, expected ${MINES}`);

    /* 6 — geometry */
    if (m.scroll.v > 1) bad.push(`page scrolls vertically by ${m.scroll.v}px`);
    if (m.scroll.h > 1) bad.push(`page scrolls horizontally by ${m.scroll.h}px`);
    for (const [k, v] of Object.entries(m.overflow)) if (v > 1) bad.push(`${k} overflows by ${v}px`);
    if (!m.chatKey.label || m.chatKey.tag !== 'BUTTON') bad.push('chat key is not a labelled button');
  }
  if (errors.length) bad.push(`js: ${errors[0]}`);

  if (w === 360 && h === 640) await pg.screenshot({ path: path.join(OUT, 'dock-360.png') });

  /* 7 — the mine still works from its key, and burying one moves only your number */
  if (w === 360 && h === 640 && !m.missing) {
    await pg.waitForFunction(() => document.getElementById('chip-0').classList.contains('active'),
      null, { timeout: 15000 });
    await pg.click('#mine-btn');
    const armed = await pg.evaluate(() => document.getElementById('mine-btn').getAttribute('aria-pressed'));
    if (armed !== 'true') bad.push(`mine pod did not arm (aria-pressed=${armed})`);
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
    if (after.fog !== '?') bad.push(`the rival's pod stopped concealing after a placement: ${after.fog}`);
    if (after.pressed !== 'false') bad.push('the mine pod stayed armed after placing');
    await pg.screenshot({ path: path.join(OUT, 'dock-mine-placed.png') });

    /* the chat sheet still opens from the icon-only key */
    await pg.click('#chat-toggle');
    await pg.waitForTimeout(360);
    const sheet = await pg.evaluate(`(function () {
      const s = document.getElementById('chat-sheet');
      const k = document.getElementById('chat-toggle');
      return { open: !!s && !s.hidden && s.classList.contains('open'),
               expanded: k.getAttribute('aria-expanded') };
    })()`);
    if (!sheet.open) bad.push('the chat sheet did not open from the icon-only key');
    if (sheet.expanded !== 'true') bad.push('chat key did not report aria-expanded=true');
    await pg.screenshot({ path: path.join(OUT, 'dock-chat-open.png') });
  }

  if (bad.length) failed++;
  rows.push(`${bad.length ? 'FAIL' : 'PASS'} ${tag}  chat=${m.chat ? `${m.chat.w}x${m.chat.h}` : '-'}`
    + ` strips=${m.chips ? `${m.chips[0].w}x${m.chips[0].h}` : '-'}`
    + ` pod=${m.pod ? `${m.pod.box.w}x${m.pod.box.h}` : '-'}`
    + ` gap=${m.gapUnderSlab ?? '-'}px fog=${m.fog?.text ?? '-'}`);
  if (bad.length) rows.push('  - ' + bad.join('\n  - '));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(rows.join('\n'));
if (failed) { console.error(`\n${failed} viewport(s) failed`); process.exit(1); }
console.log('\ndock checks passed');
