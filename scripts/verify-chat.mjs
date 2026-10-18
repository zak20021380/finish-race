/**
 * verify-chat.mjs — the quick chat modal's own audit: three psychological emote pods over a
 * compact 2x2 tactical taunt grid, in the bottom half of the screen, with zero scrolling.
 *
 *   npm run build
 *   node scripts/verify-chat.mjs
 *
 * Serves ./dist and drives a real duel at 360x640 and 430x932. Fails (exit 1) when:
 *  - the sheet does not hold exactly 3 emote buttons and 4 phrase buttons,
 *  - an emote pod is not the 88x72 recessed well, lacks layered art (>= 12 drawn shapes) or its
 *    micro-label, or a phrase is not a >= 44px pill printing one of the four tactical one-liners,
 *  - the sheet, its body, the pod row, the phrase grid, a pod or the page report a scrollbar or
 *    an overflow (scrollHeight > clientHeight / scrollWidth > clientWidth),
 *  - the sheet is taller than half the viewport or does not sit flush in the bottom half,
 *  - tapping an emote does not raise the emote bubble and close the sheet,
 *  - tapping a phrase does not raise a text bubble carrying exactly that phrase and close the
 *    sheet.
 * Screenshots land in .shots/chat/.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const OUT = path.resolve(here, '..', '.shots', 'chat');
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
const POD_W = 88;                                   // the emote pod's face
const POD_H = 72;
const PILL_H = 44;                                  // the phrase pill's floor
const PHRASES = ['Boom! Nice step.', 'Path closed.', 'Tick tock...', 'Outplayed.'];
const MICROS = ['Haha!', 'Grrr!', 'Hurry!'];
/* the keyframe family each face is wired to, in pod order */
const MOTIONS = ['haha', 'grrr', 'hurry'];
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

/* one pass over the open sheet: geometry, counts, and every scroll/overflow pair that must be 0 */
const PROBE = `(function () {
  const box = (el) => { const b = el.getBoundingClientRect();
    return { t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1),
             w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const sc = (el) => el ? { v: el.scrollHeight - el.clientHeight, h: el.scrollWidth - el.clientWidth } : null;
  const sheet = document.getElementById('chat-sheet');
  if (!sheet) return { missing: true };
  const body = sheet.querySelector('.chat-body');
  const pods = [...sheet.querySelectorAll('.chat-emote-btn')];
  const pills = [...sheet.querySelectorAll('.chat-phrase')];
  const shape = (el) => el ? el.querySelectorAll('svg path, svg circle, svg ellipse, svg rect, svg polygon').length : 0;
  const board = document.getElementById('board');
  return {
    open: !sheet.hidden && sheet.classList.contains('open'),
    view: { w: innerWidth, h: innerHeight },
    page: sc(document.documentElement),
    board: board ? box(board) : null,
    dockTop: document.getElementById('chip-0') ? box(document.getElementById('chip-0')).t : null,
    sheet: { box: box(sheet), sc: sc(sheet) },
    body: sc(body),
    emotes: {
      count: pods.length,
      sc: sc(sheet.querySelector('.chat-emotes')),
      row: box(sheet.querySelector('.chat-emotes')),
      pods: pods.map((b) => {
        const art = b.querySelector('.chat-emote-art');
        return {
          box: box(b), sc: sc(b), art: !!art && !!art.querySelector('svg'),
          shapes: shape(b), micro: (b.querySelector('.chat-emote-micro') || {}).textContent ?? null,
          label: b.getAttribute('aria-label'), kind: b.className,
          motion: art ? art.className : '',
          anim: art ? getComputedStyle(art).animationName : 'none',
          animDur: art ? getComputedStyle(art).animationDuration : '0s',
        };
      }),
    },
    phrases: {
      count: pills.length,
      sc: sc(sheet.querySelector('.chat-phrases')),
      grid: box(sheet.querySelector('.chat-phrases')),
      pills: pills.map((b) => ({ box: box(b), sc: sc(b), text: b.textContent })),
    },
  };
})()`;

/* the bubble a send leaves over the local card */
const BUBBLE = `(function () {
  const lane = document.getElementById('chat-lane');
  const b = lane && lane.querySelector('.chat-bubble.is-mine');
  if (!b) return { missing: true };
  const s = document.getElementById('chat-sheet');
  const k = document.getElementById('chat-toggle');
  const chip = document.getElementById('chip-0');
  const art = b.querySelector('.chat-emote');
  const r = b.getBoundingClientRect();
  return {
    show: b.classList.contains('show'), hidden: b.hidden,
    out: b.classList.contains('is-out'),
    text: (b.querySelector('.chat-bubble-t') || {}).textContent ?? null,
    emote: !!b.querySelector('.chat-emote svg'),
    shapes: art ? art.querySelectorAll('svg path, svg circle, svg ellipse, svg rect, svg polygon').length : 0,
    motion: art ? art.className : '',
    anim: art ? getComputedStyle(art).animationName : 'none',
    opacity: art ? getComputedStyle(b).opacity : '0',
    box: { w: +r.width.toFixed(1), h: +r.height.toFixed(1), t: +r.top.toFixed(1), b: +r.bottom.toFixed(1) },
    chipTop: chip ? +chip.getBoundingClientRect().top.toFixed(1) : null,
    sheetOpen: !!s && !s.hidden && s.classList.contains('open'),
    expanded: k.getAttribute('aria-expanded'),
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
  /* the board's box before the modal exists — opening a sheet must not move a single pixel of it */
  const before = await pg.evaluate(() => {
    const b = document.getElementById('board');
    const r = b.getBoundingClientRect();
    return {
      t: +r.top.toFixed(1), l: +r.left.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
    };
  });
  await pg.click('#chat-toggle');
  await pg.waitForTimeout(360);

  const m = await pg.evaluate(PROBE);
  if (m.missing) bad.push('the quick chat sheet is not in the document');
  else {
    /* 1 — exactly three pods and four pills, with the right faces on them */
    if (m.emotes.count !== 3) bad.push(`${m.emotes.count} emote buttons, want exactly 3`);
    if (m.phrases.count !== 4) bad.push(`${m.phrases.count} phrase buttons, want exactly 4`);
    m.emotes.pods.forEach((p, i) => {
      if (Math.abs(p.box.w - POD_W) > 1 || Math.abs(p.box.h - POD_H) > 1) {
        bad.push(`emote ${i} is ${p.box.w}x${p.box.h}, want ${POD_W}x${POD_H}`);
      }
      if (!p.art) bad.push(`emote ${i} carries no art`);
      if (p.shapes < 12) bad.push(`emote ${i} is only ${p.shapes} shapes, want layered art`);
      if (p.micro !== MICROS[i]) bad.push(`emote ${i} micro-label is ${JSON.stringify(p.micro)}, want ${JSON.stringify(MICROS[i])}`);
      if (!p.label || !/emote/i.test(p.label)) bad.push(`emote ${i} has no labelled button`);
      if (!/is-(laugh|fury|impatient)/.test(p.kind)) bad.push(`emote ${i} carries no tone class: ${p.kind}`);
      /* the face must be alive in the sheet, not a still */
      if (!new RegExp(`emote-${MOTIONS[i]}`).test(p.motion)) {
        bad.push(`emote ${i} art carries no motion class: ${JSON.stringify(p.motion)}`);
      }
      if (p.anim === 'none') bad.push(`emote ${i} art has no running CSS animation`);
      if (parseFloat(p.animDur) <= 0) bad.push(`emote ${i} animation duration is ${p.animDur}`);
    });
    m.phrases.pills.forEach((p, i) => {
      if (p.text !== PHRASES[i]) bad.push(`phrase ${i} is ${JSON.stringify(p.text)}, want ${JSON.stringify(PHRASES[i])}`);
      if (p.box.h < PILL_H - 1) bad.push(`phrase ${i} is only ${p.box.h}px tall, want a ${PILL_H}px pill`);
    });

    /* 2 — zero scrollbars, zero overflow, everywhere in the modal and the page */
    const spots = [
      ['page', m.page], ['sheet', m.sheet.sc], ['body', m.body],
      ['emote row', m.emotes.sc], ['phrase grid', m.phrases.sc],
      ...m.emotes.pods.map((p, i) => [`emote ${i}`, p.sc]),
      ...m.phrases.pills.map((p, i) => [`phrase ${i}`, p.sc]),
    ];
    for (const [name, s] of spots) {
      if (!s) continue;
      if (s.v > 0) bad.push(`${name} scrolls vertically by ${s.v}px`);
      if (s.h > 0) bad.push(`${name} overflows horizontally by ${s.h}px`);
    }

    /* 3 — the sheet lives, whole, in the bottom half of the viewport */
    if (m.sheet.box.h > m.view.h / 2 + 0.5) {
      bad.push(`the sheet is ${m.sheet.box.h}px tall, over half of ${m.view.h}px`);
    }
    if (m.sheet.box.t < m.view.h / 2 - 0.5) bad.push(`the sheet starts at ${m.sheet.box.t}px, above the bottom half`);
    if (m.sheet.box.b > m.view.h + 0.5) bad.push(`the sheet leaves the viewport at ${m.sheet.box.b}px`);
    if (m.view.h - m.sheet.box.b > 16.5) bad.push(`the sheet floats ${(m.view.h - m.sheet.box.b).toFixed(1)}px off the app's bottom edge`);

    /* 3b — the arena never moves: a modal may cover the board, never reflow it */
    if (m.board) {
      for (const k of ['t', 'l', 'w', 'h']) {
        const d = m.board[k] - before[k];
        if (Math.abs(d) > 0.5) bad.push(`the board shifted ${k} by ${d.toFixed(1)}px when the sheet opened`);
      }
    }
  }
  if (errors.length) bad.push(`js: ${errors[0]}`);
  await pg.screenshot({ path: path.join(OUT, `chat-open-${tag}.png`) });

  /* 4 — an emote: punchy pod, floating face over the local card, sheet closed */
  await pg.click('.chat-emote-btn');
  await pg.waitForTimeout(450);
  const em = await pg.evaluate(BUBBLE);
  if (em.missing) bad.push('tapping an emote raised no bubble');
  else {
    if (!em.show || em.hidden) bad.push('the emote bubble did not show');
    if (!em.emote) bad.push('the emote bubble carries no art');
    if (em.shapes < 12) bad.push(`the bubble's face is only ${em.shapes} shapes`);
    if (!/emote-haha/.test(em.motion)) bad.push(`the bubble carries no motion class: ${JSON.stringify(em.motion)}`);
    if (em.anim === 'none') bad.push('the bubble face is not animating');
    if (em.opacity !== '1') bad.push(`the bubble face is at opacity ${em.opacity}`);
    /* it is anchored above the dock, not over it and not floating in the middle of the board */
    if (em.chipTop !== null && em.box.b > em.chipTop + 0.5) {
      bad.push(`the bubble's foot (${em.box.b}) sits below the chip top (${em.chipTop})`);
    }
    if (em.box.h < 48) bad.push(`the emote bubble is only ${em.box.h}px tall`);
    if (em.sheetOpen) bad.push('the sheet stayed open after an emote');
    if (em.expanded !== 'false') bad.push(`the chat key still says aria-expanded=${em.expanded}`);
  }
  await pg.screenshot({ path: path.join(OUT, `chat-emote-${tag}.png`) });

  /* 4b — the performance ends on its own: 2.2s of loop, then the fade takes the bubble away */
  await pg.waitForTimeout(2600);
  const gone = await pg.evaluate(BUBBLE);
  if (!gone.missing && !gone.hidden && gone.out !== true) {
    bad.push('the emote bubble neither faded nor hid after its 2.2s run');
  }

  /* 5 — a phrase, after the 3s cooldown: a text bubble, sheet closed again */
  await pg.waitForTimeout(3300);
  await pg.waitForFunction(() => {
    const k = document.getElementById('chat-toggle');
    return k && !k.disabled;
  }, null, { timeout: 15000 });
  await pg.click('#chat-toggle');
  await pg.waitForTimeout(360);
  const reopened = await pg.evaluate(PROBE);
  if (!reopened.open) bad.push('the sheet did not reopen for the phrase check');
  if (reopened.emotes && reopened.emotes.count !== 3) bad.push(`reopened with ${reopened.emotes.count} emotes`);
  await pg.click('.chat-phrase');
  await pg.waitForTimeout(450);
  const ph = await pg.evaluate(BUBBLE);
  if (ph.missing) bad.push('tapping a phrase raised no bubble');
  else {
    if (!ph.show || ph.hidden) bad.push('the phrase bubble did not show');
    if (ph.text !== PHRASES[0]) bad.push(`the phrase bubble reads ${JSON.stringify(ph.text)}`);
    if (ph.emote) bad.push('the phrase bubble was painted as an emote');
    if (ph.sheetOpen) bad.push('the sheet stayed open after a phrase');
  }
  await pg.screenshot({ path: path.join(OUT, `chat-phrase-${tag}.png`) });

  if (bad.length) failed++;
  rows.push(`${bad.length ? 'FAIL' : 'PASS'} ${tag}  emotes=${m.emotes?.count ?? '-'} phrases=${m.phrases?.count ?? '-'}`
    + ` sheet=${m.sheet?.box?.h ?? '-'}px half=${m.view ? m.view.h / 2 : '-'}px`);
  if (bad.length) rows.push('  - ' + bad.join('\n  - '));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(rows.join('\n'));
if (failed) { console.error(`\n${failed} viewport(s) failed`); process.exit(1); }
console.log('\nquick chat checks passed');
