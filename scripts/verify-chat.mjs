/**
 * verify-chat.mjs — the tactical banter sheet's own audit: three psychological emote pods over a
 * balanced 2x3 grid of dark-clay taunt chips, a live EN | FA tongue pill in the header, and a snug
 * centred modal footprint.
 *
 *   npm run build
 *   node scripts/verify-chat.mjs
 *
 * Serves ./dist and drives a real duel at 360x640 and 430x932. Fails (exit 1) when:
 *  - the sheet does not hold exactly 3 emote buttons and 6 phrase buttons,
 *  - the header does not read "Tactical Banter" at 14px #F8FAFC, or the EN | FA pill is missing,
 *  - an emote pod is not the 88x72 recessed well, lacks layered art (>= 12 drawn shapes) or its
 *    micro-label, or a phrase chip is not a >= 44px 12px-radius dark-clay tile printing its line,
 *  - flipping EN/FA does not repaint every tile in place (a chip's box or the grid's box moves),
 *  - the sheet, its body, the pod row, the phrase grid, a pod or the page report a scrollbar or an
 *    overflow (scrollHeight > clientHeight / scrollWidth > clientWidth),
 *  - the sheet is wider than 340px, taller than 300px, or not centred on the screen,
 *  - tapping an emote does not raise the emote bubble and close the sheet,
 *  - tapping a phrase does not raise a text bubble carrying exactly that tongue's line and close the
 *    sheet, or the chosen tongue is not remembered on the next open.
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
const PILL_H = 44;                                  // the phrase tile's floor
const SHEET_W = 336;                                // the modal's foot: 320-340px by spec
const SHEET_MIN_W = 320;
const SHEET_MAX_W = 340;
const SHEET_MAX_H = 300;
const TITLE = 'Tactical Banter';
const PHRASES = {
  EN: [
    'Calculated.',
    'Right into my trap!',
    'Tick-tock, genius...',
    'All part of the plan.',
    'Predictable.',
    'Respect. Nice move!',
  ],
  FA: [
    'نقشه بود داداش!',
    'دقیقاً رفتی تو تله!',
    'فکر کن، عجله نکن...',
    'دستت رو خونده بودم!',
    'شانس آوردی!',
    'ایول، قشنگ بود!',
  ],
};
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

/* one pass over the open sheet: geometry, counts, the tongue pill, and every scroll/overflow pair */
const PROBE = `(function () {
  const box = (el) => { const b = el.getBoundingClientRect();
    return { t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1),
             w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const sc = (el) => el ? { v: el.scrollHeight - el.clientHeight, h: el.scrollWidth - el.clientWidth } : null;
  const sheet = document.getElementById('chat-sheet');
  if (!sheet) return { missing: true };
  const body = sheet.querySelector('.chat-body');
  const title = sheet.querySelector('.chat-sheet-t');
  const lang = sheet.querySelector('.chat-lang');
  const pods = [...sheet.querySelectorAll('.chat-emote-btn')];
  const pills = [...sheet.querySelectorAll('.chat-phrase')];
  const shape = (el) => el ? el.querySelectorAll('svg path, svg circle, svg ellipse, svg rect, svg polygon').length : 0;
  const chip = (el) => {
    const s = getComputedStyle(el);
    return { radius: s.borderRadius, bw: s.borderTopWidth, bc: s.borderTopColor, bg: s.backgroundImage };
  };
  const board = document.getElementById('board');
  const rows = pills.length ? [...new Set(pills.map((b) => Math.round(b.getBoundingClientRect().top)))] : [];
  return {
    open: !sheet.hidden && sheet.classList.contains('open'),
    view: { w: innerWidth, h: innerHeight },
    page: sc(document.documentElement),
    board: board ? box(board) : null,
    dockTop: document.getElementById('chip-0') ? box(document.getElementById('chip-0')).t : null,
    sheet: { box: box(sheet), sc: sc(sheet), host: box(sheet.parentElement) },
    title: title ? {
      text: title.textContent,
      size: getComputedStyle(title).fontSize,
      color: getComputedStyle(title).color,
    } : null,
    lang: lang ? {
      box: box(lang),
      active: lang.dataset.lang,
      keys: [...lang.querySelectorAll('.chat-lang-b')].map((b) => ({
        text: b.textContent, lang: b.dataset.lang, on: b.classList.contains('is-on'),
        pressed: b.getAttribute('aria-pressed'),
      })),
    } : null,
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
      tongue: sheet.querySelector('.chat-phrases').dataset.lang,
      rows: rows.length,
      pills: pills.map((b) => ({
        box: box(b), sc: sc(b), text: b.textContent, style: chip(b),
      })),
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
  if (m.missing) bad.push('the banter sheet is not in the document');
  else {
    /* 1 — exactly three pods and six tiles, with the right faces and lines on them */
    if (m.emotes.count !== 3) bad.push(`${m.emotes.count} emote buttons, want exactly 3`);
    if (m.phrases.count !== 6) bad.push(`${m.phrases.count} phrase buttons, want exactly 6`);
    if (m.phrases.rows !== 3) bad.push(`the phrase grid has ${m.phrases.rows} rows, want a 2x3 grid`);
    if (m.phrases.tongue !== 'EN') bad.push(`a fresh sheet speaks ${m.phrases.tongue}, want EN`);
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
      if (p.text !== PHRASES.EN[i]) bad.push(`phrase ${i} is ${JSON.stringify(p.text)}, want ${JSON.stringify(PHRASES.EN[i])}`);
      if (p.box.h < PILL_H - 1) bad.push(`phrase ${i} is only ${p.box.h}px tall, want a ${PILL_H}px tile`);
      if (p.style.radius !== '12px') bad.push(`phrase ${i} radius is ${p.style.radius}, want 12px`);
      if (p.style.bw !== '1px' || p.style.bc !== 'rgba(255, 255, 255, 0.08)') {
        bad.push(`phrase ${i} border is ${p.style.bw} ${p.style.bc}, want 1px rgba(255,255,255,.08)`);
      }
      if (!p.style.bg.includes('rgb(26, 35, 51)') || !p.style.bg.includes('rgb(16, 23, 37)')) {
        bad.push(`phrase ${i} background is ${JSON.stringify(p.style.bg)}, want the dark-clay gradient`);
      }
    });

    /* 2 — the header: title, tongue pill, close key */
    if (!m.title || m.title.text !== TITLE) bad.push(`the header reads ${JSON.stringify(m.title?.text)}, want ${JSON.stringify(TITLE)}`);
    if (m.title && m.title.size !== '14px') bad.push(`the title is ${m.title.size}, want 14px`);
    if (m.title && m.title.color !== 'rgb(248, 250, 252)') bad.push(`the title is ${m.title.color}, want #F8FAFC`);
    if (!m.lang) bad.push('the EN | FA tongue pill is missing');
    else {
      if (m.lang.active !== 'EN') bad.push(`the pill starts on ${m.lang.active}, want EN`);
      if (m.lang.keys.length !== 2 || m.lang.keys.map((k) => k.text).join('|') !== 'EN|FA') {
        bad.push(`the pill keys are ${JSON.stringify(m.lang.keys.map((k) => k.text))}, want EN|FA`);
      }
      if (!m.lang.keys[0]?.on || m.lang.keys[1]?.on) bad.push('the pill does not light EN on a fresh sheet');
      if (m.lang.keys[0]?.pressed !== 'true' || m.lang.keys[1]?.pressed !== 'false') {
        bad.push('the pill does not report aria-pressed for EN/FA');
      }
    }

    /* 3 — zero scrollbars, zero overflow, everywhere in the modal and the page */
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

    /* 4 — the modal is snug and centred: 320-340px wide, never over 300px tall, centred in the
       app's own screen region (the host the sheet is anchored in, not the raw viewport box) */
    if (m.sheet.box.w > SHEET_MAX_W + 0.5 || m.sheet.box.w < SHEET_MIN_W - 16) {
      bad.push(`the sheet is ${m.sheet.box.w}px wide, want ~${SHEET_W}px`);
    }
    if (m.sheet.box.h > SHEET_MAX_H + 0.5) bad.push(`the sheet is ${m.sheet.box.h}px tall, over ${SHEET_MAX_H}px`);
    const cx = (m.sheet.box.l + m.sheet.box.r) / 2;
    const cy = (m.sheet.box.t + m.sheet.box.b) / 2;
    const hx = (m.sheet.host.l + m.sheet.host.r) / 2;
    const hy = (m.sheet.host.t + m.sheet.host.b) / 2;
    if (Math.abs(cx - hx) > 1) bad.push(`the sheet is centred at x=${cx.toFixed(1)}, want ${hx.toFixed(1)}`);
    if (Math.abs(cy - hy) > 1) bad.push(`the sheet is centred at y=${cy.toFixed(1)}, want ${hy.toFixed(1)}`);
    if (m.sheet.box.t < m.sheet.host.t - 0.5 || m.sheet.box.b > m.sheet.host.b + 0.5) {
      bad.push('the sheet leaves the app screen region');
    }

    /* 5 — the arena never moves: a modal may cover the board, never reflow it */
    if (m.board) {
      for (const k of ['t', 'l', 'w', 'h']) {
        const d = m.board[k] - before[k];
        if (Math.abs(d) > 0.5) bad.push(`the board shifted ${k} by ${d.toFixed(1)}px when the sheet opened`);
      }
    }

    /* 6 — flipping the tongue repaints the tiles in place: no layout shift, no clipping */
    await pg.click('.chat-lang-b[data-lang="FA"]');
    await pg.waitForTimeout(260);
    const fa = await pg.evaluate(PROBE);
    if (fa.missing) bad.push('the sheet vanished on the FA flip');
    else {
      if (fa.phrases.tongue !== 'FA') bad.push(`after the flip the grid speaks ${fa.phrases.tongue}, want FA`);
      if (fa.lang?.active !== 'FA') bad.push(`after the flip the pill sits on ${fa.lang?.active}, want FA`);
      if (!fa.lang?.keys[1]?.on || fa.lang?.keys[0]?.on) bad.push('the pill did not light FA after the flip');
      fa.phrases.pills.forEach((p, i) => {
        if (p.text !== PHRASES.FA[i]) bad.push(`FA phrase ${i} is ${JSON.stringify(p.text)}, want ${JSON.stringify(PHRASES.FA[i])}`);
        if (p.sc && (p.sc.v > 0 || p.sc.h > 0)) bad.push(`FA phrase ${i} clips (${p.sc.v}v/${p.sc.h}h)`);
        const was = m.phrases.pills[i].box;
        if (Math.abs(p.box.t - was.t) > 0.5 || Math.abs(p.box.l - was.l) > 0.5
          || Math.abs(p.box.w - was.w) > 0.5 || Math.abs(p.box.h - was.h) > 0.5) {
          bad.push(`FA phrase ${i} moved: ${JSON.stringify(p.box)} vs ${JSON.stringify(was)}`);
        }
      });
      if (Math.abs(fa.phrases.grid.w - m.phrases.grid.w) > 0.5
        || Math.abs(fa.phrases.grid.h - m.phrases.grid.h) > 0.5) {
        bad.push('the phrase grid resized when the tongue flipped');
      }
      await pg.click('.chat-lang-b[data-lang="EN"]');
      await pg.waitForTimeout(220);
    }
  }
  if (errors.length) bad.push(`js: ${errors[0]}`);
  await pg.screenshot({ path: path.join(OUT, `chat-open-${tag}.png`) });

  /* 7 — an emote: punchy pod, floating face over the local card, sheet closed */
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

  /* 7b — the performance ends on its own: 2.2s of loop, then the fade takes the bubble away */
  await pg.waitForTimeout(2600);
  const gone = await pg.evaluate(BUBBLE);
  if (!gone.missing && !gone.hidden && gone.out !== true) {
    bad.push('the emote bubble neither faded nor hid after its 2.2s run');
  }

  /* 8 — a Persian phrase after the 1.5s cooldown: FA persists, the bubble is the FA line */
  await pg.waitForTimeout(1700);
  await pg.waitForFunction(() => {
    const k = document.getElementById('chat-toggle');
    return k && !k.disabled;
  }, null, { timeout: 15000 });
  await pg.click('#chat-toggle');
  await pg.waitForTimeout(360);
  await pg.click('.chat-lang-b[data-lang="FA"]');
  await pg.waitForTimeout(200);
  await pg.click('.chat-phrase');
  await pg.waitForTimeout(450);
  const ph = await pg.evaluate(BUBBLE);
  if (ph.missing) bad.push('tapping a phrase raised no bubble');
  else {
    if (!ph.show || ph.hidden) bad.push('the phrase bubble did not show');
    if (ph.text !== PHRASES.FA[0]) bad.push(`the FA phrase bubble reads ${JSON.stringify(ph.text)}`);
    if (ph.emote) bad.push('the phrase bubble was painted as an emote');
    if (ph.sheetOpen) bad.push('the sheet stayed open after a phrase');
  }
  await pg.screenshot({ path: path.join(OUT, `chat-phrase-${tag}.png`) });

  /* 9 — the tongue is remembered: reopen and the pill is still on FA, EN flips it back */
  await pg.waitForTimeout(1600);
  await pg.click('#chat-toggle');
  await pg.waitForTimeout(360);
  const back = await pg.evaluate(PROBE);
  if (back.missing) bad.push('the sheet did not reopen for the persistence check');
  else {
    if (back.lang?.active !== 'FA') bad.push(`the pill forgot the tongue: ${back.lang?.active}, want FA`);
    if (back.phrases.tongue !== 'FA') bad.push(`the grid forgot the tongue: ${back.phrases.tongue}, want FA`);
    await pg.click('.chat-lang-b[data-lang="EN"]');
    await pg.waitForTimeout(220);
    const en = await pg.evaluate(PROBE);
    if (en.phrases.tongue !== 'EN' || en.phrases.pills[0]?.text !== PHRASES.EN[0]) {
      bad.push('flipping back to EN did not restore the English tiles');
    }
  }
  await pg.keyboard.press('Escape');

  if (bad.length) failed++;
  rows.push(`${bad.length ? 'FAIL' : 'PASS'} ${tag}  emotes=${m.emotes?.count ?? '-'} phrases=${m.phrases?.count ?? '-'}`
    + ` sheet=${m.sheet?.box?.w ?? '-'}x${m.sheet?.box?.h ?? '-'} max=${SHEET_W}x${SHEET_MAX_H}`);
  if (bad.length) rows.push('  - ' + bad.join('\n  - '));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(rows.join('\n'));
if (failed) { console.error(`\n${failed} viewport(s) failed`); process.exit(1); }
console.log('\nbanter sheet checks passed');
