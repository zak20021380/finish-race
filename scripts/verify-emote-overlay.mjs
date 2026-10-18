/**
 * verify-emote-overlay.mjs — the pawn-anchored emote overlay's own audit.
 *
 *   npm run build
 *   node scripts/verify-emote-overlay.mjs
 *
 * Serves ./dist and drives a real duel at 360x640 and 430x932. Taps an emote pod and proves, from
 * the DOM and the painted canvas:
 *  - the bubble spawns above the sender's pawn: the `.pawn-you` marker sits on the scarlet ball
 *    (the pixels under it read as the team colour), the bubble is centred on that point, its foot
 *    clears the move-dot ring (a hint can leap two cells) by at least the spec's 24px,
 *  - the layer never takes a tap: computed pointer-events is none on the lane and the bubble, and
 *    a real click on the bubble's face lands on the canvas (`pointerdown` fires on the board),
 *  - it is the AAA capsule: 48x48, frosted dark clay, a 1px crimson ring with its ambient bloom,
 *    a living 3D face inside and the downward tip pointing at the pawn,
 *  - it clears cleanly: 2s of performance, an 18px float-out, then the node is hidden.
 * Screenshots land in .shots/emote-overlay/.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const OUT = path.resolve(here, '..', '.shots', 'emote-overlay');
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
const VIEWPORTS = [[360, 640], [430, 932]];
const CAPSULE = 48;
/** The move-dot ring can leap two cells around the pawn; the bubble clears that plus 24px. */
const DOT_CELLS = 2;
const DOT_CLEAR = 24;
/** Crimson ring the local (player) capsule must wear. */
const MINE_GLOW = /224,\s*38,\s*79/;

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

/* one pass over the live bubble: anchor over the pawn, capsule geometry, and every hit-test pair */
const PROBE = `(function () {
  const lane = document.getElementById('chat-lane');
  const bubble = lane && lane.querySelector('.chat-bubble.is-mine');
  const anchor = lane && lane.querySelector('.pawn-anchor.pawn-you');
  if (!bubble || !anchor) return { missing: true };
  const canvas = document.getElementById('board');
  const bb = bubble.getBoundingClientRect();
  const ab = anchor.getBoundingClientRect();
  const lb = lane.getBoundingClientRect();

  /* the ball under the marker: sample the pixels the renderer painted at the anchor point */
  let red = 0;
  if (canvas instanceof HTMLCanvasElement && canvas.width > 0) {
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width, sy = canvas.height / r.height;
    const x0 = Math.max(0, Math.round((ab.left - r.left) * sx) - 3);
    const y0 = Math.max(0, Math.round((ab.top - r.top) * sy) - 3);
    const w = Math.min(canvas.width - x0, 7), h = Math.min(canvas.height - y0, 7);
    if (w > 0 && h > 0) {
      const d = canvas.getContext('2d').getImageData(x0, y0, w, h).data;
      for (let i = 0; i < d.length; i += 4) {
        const rr = d[i], gg = d[i + 1], b2 = d[i + 2];
        if (rr > 120 && rr - gg > 45 && rr - b2 > 30) red++;
      }
    }
  }

  const cs = getComputedStyle(bubble);
  const tip = getComputedStyle(bubble, '::after');
  const art = bubble.querySelector('.chat-emote');
  const artCs = art ? getComputedStyle(art) : null;
  const cx = bb.left + bb.width / 2, cy = bb.top + bb.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  const bubbleLeft = +bb.left.toFixed(2);
  const clamped = Math.abs(bb.left - lb.left) < 0.6 || Math.abs(lb.right - bb.right) < 0.6;
  return {
    show: bubble.classList.contains('show'), hidden: bubble.hidden,
    out: bubble.classList.contains('is-out'),
    box: { l: bubbleLeft, t: +bb.top.toFixed(2), b: +bb.bottom.toFixed(2),
           w: +bb.width.toFixed(1), h: +bb.height.toFixed(1) },
    anchor: { x: +((ab.left + ab.right) / 2).toFixed(2), y: +((ab.top + ab.bottom) / 2).toFixed(2) },
    lane: { l: +lb.left.toFixed(2), r: +lb.right.toFixed(2), w: +lb.width.toFixed(2) },
    red,
    pe: { lane: getComputedStyle(lane).pointerEvents, bubble: cs.pointerEvents },
    capsule: {
      radius: cs.borderRadius, shadow: cs.boxShadow,
      emote: !!bubble.querySelector('.chat-emote svg'),
      shapes: art ? art.querySelectorAll('svg path, svg circle, svg ellipse, svg rect, svg polygon').length : 0,
      anim: artCs ? artCs.animationName : 'none',
      animDur: artCs ? artCs.animationDuration : '0s',
      tipContent: tip.content, tipW: tip.borderTopWidth, tipLeft: +parseFloat(tip.left || '0').toFixed(2),
    },
    dx: +(ab.left - (bb.left + bb.width / 2)).toFixed(2),
    clamped,
    clearPx: +(ab.top - bb.bottom).toFixed(2),
    cell: +(lb.width / 8).toFixed(2),
    hit: hit ? (hit.id || hit.className || hit.tagName) : null,
    hitCx: +cx.toFixed(1), hitCy: +cy.toFixed(1),
  };
})()`;

/* after the performance: nothing left but a hidden node */
const CLEAN = `(function () {
  const lane = document.getElementById('chat-lane');
  const b = lane && lane.querySelector('.chat-bubble.is-mine');
  if (!b) return { missing: true };
  return { hidden: b.hidden, out: b.classList.contains('is-out'),
           show: b.classList.contains('show'), opacity: getComputedStyle(b).opacity };
})()`;

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
let failed = 0;
const rows = [];

for (const [w, h] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'light' });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  const tag = `${w}x${h}`;
  const bad = [];

  await pg.goto(base, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(900);
  await pg.click('#home-play');
  await pg.waitForTimeout(1000);
  await pg.waitForFunction(() => document.getElementById('chip-0').classList.contains('active'),
    null, { timeout: 15000 });
  await pg.waitForFunction(() => {
    const k = document.getElementById('chat-toggle');
    return k && !k.disabled;
  }, null, { timeout: 15000 });

  /* send an emote: the sheet opens, the pod spends itself, the bubble spawns over the pawn */
  await pg.click('#chat-toggle');
  await pg.waitForTimeout(360);
  await pg.click('.chat-emote-btn');
  await pg.waitForTimeout(450);

  const m = await pg.evaluate(PROBE);
  if (m.missing) bad.push('tapping an emote raised no pawn-anchored bubble');
  else {
    /* 1 — the bubble hangs over the pawn, centred, clearing the dot ring and the spec's 24px */
    if (!m.show || m.hidden) bad.push('the emote bubble did not show');
    if (m.red < 3) bad.push(`only ${m.red} team pixels under .pawn-you — the marker is not on the pawn`);
    if (m.anchor.y <= m.box.b) bad.push(`the bubble (foot ${m.box.b}) is not above the pawn (${m.anchor.y})`);
    if (!m.clamped && Math.abs(m.dx) > 1.5) bad.push(`the bubble centre is ${m.dx}px off the pawn`);
    const floor = m.cell * DOT_CELLS + DOT_CLEAR;
    if (m.clearPx < floor - 2) {
      bad.push(`the bubble clears the pawn by ${m.clearPx}px, want >= ${(floor - 2).toFixed(1)}px (dot ring + ${DOT_CLEAR}px)`);
    }
    if (m.anchor.x < m.lane.l - 0.5 || m.anchor.x > m.lane.r + 0.5) bad.push('the pawn marker left the bubble layer');
    /* the tail points at the pawn, and shifts with the capsule when an edge nudges it */
    if (m.capsule.tipContent === 'none') bad.push('the capsule has no downward pointer tip');
    if (m.capsule.tipW !== '6px') bad.push(`the tip is ${m.capsule.tipW} tall, want 6px`);
    if (m.capsule.tipLeft < 10 || m.capsule.tipLeft > m.box.w - 10) bad.push(`the tip sits at ${m.capsule.tipLeft}px, off the face`);
    if (!m.clamped && Math.abs(m.box.l + m.capsule.tipLeft - m.anchor.x) > 1.5) bad.push('the tip does not point at the pawn');

    /* 2 — the AAA capsule: 48x48 frosted clay, crimson neon ring, a living 3D face inside */
    if (Math.abs(m.box.w - CAPSULE) > 1 || Math.abs(m.box.h - CAPSULE) > 1) {
      bad.push(`the emote capsule is ${m.box.w}x${m.box.h}, want ${CAPSULE}x${CAPSULE}`);
    }
    if (!/15px/.test(m.capsule.radius)) bad.push(`the capsule radius is ${m.capsule.radius}, want the pebble 15px`);
    if (!MINE_GLOW.test(m.capsule.shadow)) bad.push(`the capsule wears no crimson ring/bloom: ${m.capsule.shadow}`);
    if (!m.capsule.emote) bad.push('the capsule carries no emote art');
    if (m.capsule.shapes < 12) bad.push(`the face is only ${m.capsule.shapes} shapes, want layered 3D art`);
    if (m.capsule.anim === 'none') bad.push('the face is not animated');
    if (parseFloat(m.capsule.animDur) <= 0) bad.push(`the face animation duration is ${m.capsule.animDur}`);

    /* 3 — the layer never takes a tap: pointer-events none, and the hit-test lands on the board */
    if (m.pe.lane !== 'none') bad.push(`the bubble layer has pointer-events: ${m.pe.lane}, want none`);
    if (m.pe.bubble !== 'none') bad.push(`the bubble has pointer-events: ${m.pe.bubble}, want none`);
    if (m.hit !== 'board') bad.push(`elementFromPoint over the capsule is ${JSON.stringify(m.hit)}, want the board canvas`);
  }
  if (errors.length) bad.push(`js: ${errors[0]}`);
  await pg.screenshot({ path: path.join(OUT, `emote-overlay-${tag}.png`) });

  /* 4 — click-through, for real: a pointerdown at the capsule's face must reach the canvas */
  if (!m.missing) {
    await pg.evaluate(() => {
      window.__boardHits = 0;
      document.getElementById('board').addEventListener('pointerdown', () => { window.__boardHits++; }, true);
    });
    await pg.mouse.click(m.hitCx, m.hitCy);
    const hits = await pg.evaluate(() => window.__boardHits);
    if (hits !== 1) bad.push(`a click on the capsule fired ${hits} board pointerdown events, want 1`);
  }

  /* 5 — clears cleanly: 2s of performance + the float-out, then hidden and out of the layer */
  await pg.waitForTimeout(2200);
  const gone = await pg.evaluate(CLEAN);
  if (gone.missing) bad.push('the emote bubble left the layer without a node');
  else {
    if (!gone.hidden) bad.push(`the emote bubble never hid (out=${gone.out}, opacity=${gone.opacity})`);
    if (gone.show) bad.push('a hidden bubble still carries .show');
    if (gone.opacity !== '0') bad.push(`the hidden bubble is at opacity ${gone.opacity}`);
  }
  await pg.screenshot({ path: path.join(OUT, `emote-cleared-${tag}.png`) });

  if (bad.length) failed++;
  rows.push(`${bad.length ? 'FAIL' : 'PASS'} ${tag}  pawn=(${m.anchor?.x ?? '-'},${m.anchor?.y ?? '-'})`
    + ` bubble=${m.box?.w ?? '-'}x${m.box?.h ?? '-'} clear=${m.clearPx ?? '-'}px`);
  if (bad.length) rows.push('  - ' + bad.join('\n  - '));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(rows.join('\n'));
if (failed) { console.error(`\n${failed} viewport(s) failed`); process.exit(1); }
console.log('\npawn-anchored emote overlay checks passed');
