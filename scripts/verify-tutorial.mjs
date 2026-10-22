/**
 * verify-tutorial.mjs — drives the real hands-on lesson on ./dist.
 *
 * Serves the build, starts a local bot race with a clean save, and completes the lesson by tapping
 * the actual spotlight hole at 360, 390 and 430 CSS px. Fails (exit 1) when:
 *  - step 1 is not the GOAL spotlighting the top FINISH banner, or cannot be taken by the banner
 *    itself AND by the card's Next key;
 *  - the pointer is not the standard 24px Material-style hand, or its fingertip is not anchored
 *    to the target centre;
 *  - any step cannot be completed by its real target, or the spotlight is smaller than a 48px thumb,
 *    or the HUD card covers it;
 *  - the wall needs more than ONE tap: a single tap near the spotlight edge must commit the wall
 *    (8 → 7) and close the overlay into live play. No wall-confirm stage may ever appear;
 *  - the mine lesson re-opens before the rival has actually gained two rows, or never re-opens;
 *  - the EN / فارسی / RU switcher is not above the input guard, does not repaint the current step
 *    instantly, does not persist `tactix_tut_lang`, or does not flip the card + ready toast to
 *    `dir="rtl"` with Vazirmatn / letter-spacing 0 / line-height 1.65 for Persian;
 *  - any language causes horizontal overflow at 360, 390 or 430 CSS px;
 *  - the mine step points at a tile behind the rival, and planting it does not close the lesson
 *    immediately and permanently (no WATCH THIS freeze);
 *  - the client-side red/blue perspective does not swap both pawns and HUD chips, or the choice
 *    does not survive a reload;
 *  - the wall counter or mine counter does not move, or the save never records completion;
 *  - a completed save re-shows the lesson on the next local race;
 *  - Skip / Пропустить / رد کردن آموزش is missing, covered, or does not persist completion.
 *
 * Run: npm run build && node scripts/verify-tutorial.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VIEWPORTS = [[360, 640], [390, 844], [430, 932]];
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

const box = (r) => ({ x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 });
const overlaps = (a, b) => !!a && !!b
  && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The live tutorial DOM and the board's exact cell geometry. The geometry mirrors render.ts's fit
 * (device-pixel quantised, 8×12 for a duel), so a cell can be clicked without guessing.
 */
const read = (pg) => pg.evaluate(() => {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  const canvas = document.getElementById('board');
  const cr = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const cols = 8, rows = 12;
  const fit = (m) => Math.max(1, Math.floor(Math.max(0, Math.min((W - 2 * m) / cols, (H - 2 * m) / rows)) * dpr) / dpr);
  let cell = fit(2);
  const pad = Math.max(2, Math.min(6, cell * 0.06));
  if (pad !== 2) cell = fit(pad);
  const ox = Math.round(((W - cols * cell) / 2) * dpr) / dpr;
  const oy = Math.round(((H - rows * cell) / 2) * dpr) / dpr;

  const root = document.getElementById('tutorial');
  const spot = document.getElementById('tut-spot');
  const aid = document.getElementById('tut-aid');
  const card = document.getElementById('tut-card');
  const skip = document.getElementById('tut-skip');
  const next = document.getElementById('tut-next');
  const tap = document.querySelector('.tut-tap');
  const hand = document.querySelector('.tut-tap .tut-hand');
  const pointer = document.getElementById('tut-pointer');
  const lang = document.getElementById('tut-lang');
  const langBtns = [...document.querySelectorAll('#tut-lang [data-tut-lang]')];
  const block = document.querySelector('.tut-block');
  const ready = document.getElementById('tut-ready');
  const readyTxt = document.getElementById('tut-ready-txt');
  const step = document.getElementById('tut-step');
  const title = document.getElementById('tut-title');
  const body = document.getElementById('tut-body');
  const bodyCs = getComputedStyle(body);
  /* layout offsets, not the live rect: the press animation translates the SVG every frame */
  const tip = (() => {
    if (!tap) return null;
    const cs = getComputedStyle(tap);
    return {
      dx: parseFloat(cs.left) + 11.5 / 24 * parseFloat(cs.width),
      dy: parseFloat(cs.top) + 5 / 24 * parseFloat(cs.height),
    };
  })();
  return {
    hidden: root.hidden,
    stage: root.dataset.stage ?? null,
    tone: root.dataset.tone ?? null,
    kicker: step.textContent,
    title: title.textContent,
    body: body.textContent,
    spot: root.hidden || spot.hidden ? null : rect(spot),
    aid: root.hidden || aid.hidden ? null : { kind: aid.dataset.kind, ...rect(aid) },
    card: rect(card),
    skip: rect(skip),
    skipEvents: getComputedStyle(skip).pointerEvents,
    skipText: skip.textContent.trim(),
    skipFont: getComputedStyle(skip).fontFamily,
    skipDir: skip.getAttribute('dir'),
    nextHidden: next.hidden,
    nextLabel: next.textContent.replace(/\s+/g, ' ').trim(),
    nextHeight: next.getBoundingClientRect().height,
    liveClass: document.body.classList.contains('tutorial-live'),
    mineDisabled: document.getElementById('mine-btn').disabled,
    mineCount: document.querySelector('#mine-n')?.textContent ?? null,
    wallCount: document.querySelector('#walls-0 .wall-n')?.textContent ?? null,
    note: document.getElementById('note')?.textContent ?? '',
    live: document.getElementById('tut-live')?.textContent ?? '',
    cardDir: card.getAttribute('dir'),
    cardLang: card.getAttribute('data-lang'),
    cardFont: getComputedStyle(card).fontFamily,
    kickerSpacing: getComputedStyle(step).letterSpacing,
    titleSpacing: getComputedStyle(title).letterSpacing,
    bodySpacing: bodyCs.letterSpacing,
    bodyLine: parseFloat(bodyCs.lineHeight) / parseFloat(bodyCs.fontSize),
    lang: lang ? {
      events: getComputedStyle(lang).pointerEvents,
      z: getComputedStyle(lang).zIndex,
      box: rect(lang),
      buttons: langBtns.map((b) => {
        const r = b.getBoundingClientRect();
        return {
          code: b.dataset.tutLang,
          pressed: b.getAttribute('aria-pressed'),
          x: r.x,
          w: r.width,
          h: r.height,
          font: getComputedStyle(b).fontFamily,
        };
      }),
    } : null,
    blockZ: block ? getComputedStyle(block).zIndex : '',
    readyText: readyTxt?.textContent ?? '',
    readyHidden: ready?.hidden ?? true,
    readyDir: ready?.getAttribute('dir') ?? null,
    readyLang: ready?.getAttribute('data-lang') ?? null,
    readyFont: ready ? getComputedStyle(ready).fontFamily : '',
    readyBox: ready && !ready.hidden ? rect(ready) : null,
    storedLang: (() => {
      try { return localStorage.getItem('tactix_tut_lang'); } catch { return null; }
    })(),
    scrollW: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    viewportW: window.innerWidth,
    legacyButtons: document.querySelectorAll('#tut-forward, #tut-skip-next').length,
    handCount: document.querySelectorAll('.tut-tap .tut-hand').length,
    handPathCount: document.querySelectorAll('.tut-tap path').length,
    handFingerCount: document.querySelectorAll('.tut-hand-finger').length,
    handGradient: /tutHandFill|tutHandShade|tutHandSilhouette/.test(tap?.outerHTML ?? ''),
    handStroke: hand?.getAttribute('stroke') ?? '',
    handFill: hand?.getAttribute('fill') ?? '',
    handStrokeWidth: Number(hand?.getAttribute('stroke-width') ?? 0),
    handJoin: hand?.getAttribute('stroke-linejoin') ?? '',
    handCyan: /38BDF8|0EA5E9|7DD3FC|0284C7/i.test(tap?.outerHTML ?? ''),
    tapSvg: !!tap,
    tapViewBox: tap?.getAttribute('viewBox') ?? '',
    pointer: pointer ? rect(pointer) : null,
    tapTip: tip,
    tapFilter: tap ? getComputedStyle(tap).filter : '',
    tapAnim: tap ? getComputedStyle(tap).animationName : '',
    aidLine: aid && !aid.hidden ? getComputedStyle(aid, '::before').height : '',
    sonarAnim: document.querySelector('.tut-sonar i')
      ? getComputedStyle(document.querySelector('.tut-sonar i')).animationName : '',
    board: { left: cr.left + ox, top: cr.top + oy, cell },
  };
});

/** The two sides as this client paints them: HUD tokens plus the actual canvas pawns. */
const colors = (pg) => pg.evaluate(() => {
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const cols = 8, rows = 12;           // a fresh tutorial race is always a 1v1 duel
  const fit = (m) => Math.max(1, Math.floor(Math.max(0, Math.min((W - 2 * m) / cols, (H - 2 * m) / rows)) * dpr) / dpr);
  let cell = fit(2);
  const pad = Math.max(2, Math.min(6, cell * 0.06));
  if (pad !== 2) cell = fit(pad);
  const ox = Math.round(((W - cols * cell) / 2) * dpr) / dpr;
  const oy = Math.round(((H - rows * cell) / 2) * dpr) / dpr;
  const sample = (c, r) => {
    const d = ctx.getImageData(
      Math.round((ox + (c + 0.5) * cell) * dpr),
      Math.round((oy + (r + 0.5) * cell) * dpr),
      1, 1,
    ).data;
    return [d[0], d[1], d[2]];
  };
  const tint = (id) => getComputedStyle(document.getElementById(id)).getPropertyValue('--tint').trim();
  return {
    localTint: tint('chip-0'),
    rivalTint: tint('chip-1'),
    localClass: document.getElementById('chip-0').className,
    rivalClass: document.getElementById('chip-1').className,
    localBall: sample(2, 11),          // the duel's left start square
    rivalBall: sample(5, 11),          // ...and its right one
  };
});

const isRed = ([r, , b]) => r > b * 1.3 + 8;
const isBlue = ([r, , b]) => b > r * 1.3 + 8;

const waitTitle = (pg, title) => pg.waitForFunction(
  (want) => document.getElementById('tut-title')?.textContent === want, title, { timeout: 6000 },
);
const waitHidden = (pg) => pg.waitForSelector('#tutorial', { state: 'hidden', timeout: 4000 });

/** Switch the live lesson language and read the repainted HUD. */
const pickLang = async (pg, code) => {
  await pg.click(`#tut-lang [data-tut-lang="${code}"]`);
  await pg.waitForTimeout(220);
  return read(pg);
};

const withinViewport = (r, w) => !!r && r.x >= -0.5 && r.x + r.w <= w + 0.5;

/** Chrome serialises a computed zero letter-spacing as `normal`; both mean no tracking. */
const tracking = (value) => (value === 'normal' ? 0 : parseFloat(value));

/** Zero horizontal overflow: the document and every live tutorial surface fit the viewport. */
const fitsViewport = (s) => s.scrollW <= s.viewportW
  && withinViewport(s.card, s.viewportW)
  && withinViewport(s.lang?.box, s.viewportW)
  && withinViewport(s.skip, s.viewportW)
  && (!s.readyBox || withinViewport(s.readyBox, s.viewportW));

/**
 * The local pawn's cell, read off the real canvas: the cell centre closest to this seat's own tint.
 * Used during the live-play intermission, where the player takes ordinary turns and the test has no
 * other way to know where the pawn walked to.
 */
const pawnCell = (pg) => pg.evaluate(() => {
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const cols = 8, rows = 12;
  const fit = (m) => Math.max(1, Math.floor(Math.max(0, Math.min((W - 2 * m) / cols, (H - 2 * m) / rows)) * dpr) / dpr);
  let cell = fit(2);
  const pad = Math.max(2, Math.min(6, cell * 0.06));
  if (pad !== 2) cell = fit(pad);
  const ox = Math.round(((W - cols * cell) / 2) * dpr) / dpr;
  const oy = Math.round(((H - rows * cell) / 2) * dpr) / dpr;
  const tint = getComputedStyle(document.getElementById('chip-0')).getPropertyValue('--tint').trim();
  const n = parseInt(tint.replace('#', ''), 16);
  const target = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  let best = null;
  for (let r = 1; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const d = ctx.getImageData(
        Math.round((ox + (c + 0.5) * cell) * dpr),
        Math.round((oy + (r + 0.5) * cell) * dpr),
        1, 1,
      ).data;
      const dist = Math.abs(d[0] - target[0]) + Math.abs(d[1] - target[1]) + Math.abs(d[2] - target[2]);
      if (!best || dist < best.dist) best = { c, r, dist };
    }
  }
  return best && best.dist < 210 ? best : null;
});

let failed = 0;
const rows = [];
const check = async (label, fn) => {
  try { await fn(); rows.push(`  ok  ${label}`); }
  catch (e) { failed++; rows.push(`  FAIL ${label}\n       ${e.message.split('\n').join('\n       ')}`); }
};

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

try {
for (const [w, h] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  await pg.goto(base, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(900);

  rows.push(`\n── ${w}×${h} ──`);
  let expected = 'red';                 // a clean save starts red
  if (w === 390) {
    /* the perspective is chosen on the real Settings screen, then every surface below is checked
       against that choice. 360 and 430 exercise the default red perspective instead. */
    await pg.click('.dock-nav .tab[data-tab="profile"]');
    await pg.waitForTimeout(600);
    await pg.click('#profile-settings');
    await pg.waitForTimeout(600);
    const pc0 = await pg.evaluate(() => {
      const keys = [...document.querySelectorAll('[data-pcolor]')];
      return {
        count: keys.length,
        heights: keys.map((k) => k.getBoundingClientRect().height),
        pressed: keys.map((k) => k.getAttribute('aria-pressed')),
        save: JSON.parse(localStorage.getItem('detour.save.v2') || 'null'),
      };
    });
await check('Settings offers a 48px red/blue perspective control (red default)', () => {
      assert.equal(pc0.count, 2);
      assert.ok(pc0.heights.every((x) => x >= 48), `keys ${pc0.heights.join('/')}`);
      assert.deepEqual(pc0.pressed, ['true', 'false']);
      assert.equal(pc0.save?.pieceColor ?? 'red', 'red');
    });
    await pg.click('[data-pcolor="blue"]');
    await pg.waitForTimeout(250);
    const pc1 = await pg.evaluate(() => ({
      pressed: [...document.querySelectorAll('[data-pcolor]')].map((k) => k.getAttribute('aria-pressed')),
      save: JSON.parse(localStorage.getItem('detour.save.v2') || 'null'),
    }));
await check('choosing blue persists it and leaves the game record alone', () => {
      assert.deepEqual(pc1.pressed, ['false', 'true']);
      assert.equal(pc1.save?.pieceColor, 'blue');
      assert.equal(pc1.save?.stats?.games, 0);
      assert.equal(pc1.save?.coins, 1850);
    });
    await pg.click('.dock-nav .tab[data-tab="home"]');
    await pg.waitForTimeout(600);
    expected = 'blue';
  }

  await pg.click('#home-play');
  await pg.waitForSelector('#tutorial:not([hidden])', { timeout: 5000 });
  await pg.waitForTimeout(520);   // the game screen is still sliding in; let the spotlight settle

  const s1 = await read(pg);
  const c1 = await colors(pg);
await check('step 1 is THE GOAL spotlighting the top FINISH banner', () => {
    assert.equal(s1.stage, 'goal');
    assert.equal(s1.kicker, 'STEP 1 OF 4');
    assert.equal(s1.title, 'THE GOAL');
    assert.equal(s1.body,
      'First player to reach the FINISH line at the top wins! Tap the FINISH line or Next to start.');
    assert.equal(s1.tone, 'goal');
    assert.equal(s1.aid?.kind, 'finish');
    assert.ok(s1.spot && s1.spot.w > 100, `spot ${s1.spot?.w}×${s1.spot?.h}`);
    assert.ok(s1.spot.cy < h * 0.4, `FINISH spotlight at y ${s1.spot?.cy}`);
    assert.equal(s1.legacyButtons, 0, 'a stale forward proxy is back in the DOM');
    assert.ok(fitsViewport(s1), `EN overflows: ${s1.scrollW}/${s1.viewportW}`);
  });
await check('the EN / فارسی / RU switcher sits above the input guard and starts on EN', () => {
    assert.ok(s1.lang, 'the language switcher is missing');
    assert.equal(s1.lang.events, 'auto');
    assert.ok(Number(s1.lang.z) > Number(s1.blockZ),
      `switcher z ${s1.lang.z} must beat the guard z ${s1.blockZ}`);
    assert.ok(s1.lang.box.h >= 44, `switcher pill ${s1.lang.box.h}px tall`);
    assert.deepEqual(s1.lang.buttons.map((b) => b.code), ['en', 'fa', 'ru']);
    assert.deepEqual(s1.lang.buttons.map((b) => b.pressed), ['true', 'false', 'false']);
    assert.ok(s1.lang.buttons.every((b) => b.h >= 38 && b.w >= 34),
      `segments ${s1.lang.buttons.map((b) => `${b.w}x${b.h}`).join(' ')}`);
    assert.match(s1.lang.buttons[1].font, /Vazirmatn/);
    assert.equal(s1.storedLang, null, 'a clean context must not carry a stored language');
  });
await check('the pointer is one standard 24px Material-style hand with a dark outline', () => {
    assert.equal(s1.tapSvg, true, 'the tutorial pointer SVG is missing');
    assert.equal(s1.tapViewBox, '0 0 24 24');
    assert.equal(s1.handCount, 1, 'the standard hand path is missing');
    assert.equal(s1.handPathCount, 1, 'the hand must be one clean silhouette, not a finger collage');
    assert.equal(s1.handFingerCount, 0, 'the old sausage-finger paths are back');
    assert.equal(s1.handGradient, false, 'the old multi-part hand gradients are back');
    assert.equal(s1.handFill.toUpperCase(), '#FFFFFF');
    assert.equal(s1.handStroke.toUpperCase(), '#0F172A');
    assert.equal(s1.handStrokeWidth, 1.5);
    assert.equal(s1.handJoin, 'round');
    assert.equal(s1.handCyan, false, 'cyan capsule colours are still in the pointer SVG');
    assert.match(s1.tapFilter, /drop-shadow/);
    assert.doesNotMatch(s1.tapFilter, /56,\s*189,\s*248/);
    assert.equal(s1.tapAnim, 'tutTapPress');
    assert.equal(s1.sonarAnim, 'tutPulseRing');
  });
await check('the index fingertip (11.5, 5) is anchored on the target centre', () => {
    assert.ok(s1.tapTip, 'the hand geometry is missing');
    assert.ok(Math.abs(s1.tapTip.dx) <= 0.25, `fingertip dx ${s1.tapTip.dx}px`);
    assert.ok(Math.abs(s1.tapTip.dy) <= 0.25, `fingertip dy ${s1.tapTip.dy}px`);
    assert.ok(s1.pointer && s1.spot, 'the pointer or its target is missing');
    assert.ok(Math.abs(s1.pointer.cx - s1.spot.cx) <= 2,
      `pointer x ${s1.pointer.cx} vs target ${s1.spot.cx}`);
    assert.ok(Math.abs(s1.pointer.cy - s1.spot.cy) <= 2,
      `pointer y ${s1.pointer.cy} vs target ${s1.spot.cy}`);
  });
await check(`the client-side perspective paints ${expected} local / the opposite rival`, () => {
    if (expected === 'blue') {
      assert.equal(c1.localTint, '#3057db');
      assert.equal(c1.rivalTint, '#e0264f');
      assert.ok(isBlue(c1.localBall), `local pawn ${c1.localBall.join(',')}`);
      assert.ok(isRed(c1.rivalBall), `rival pawn ${c1.rivalBall.join(',')}`);
      assert.match(c1.localClass, /\bblue\b/);
      assert.match(c1.rivalClass, /\bred\b/);
    } else {
      assert.equal(c1.localTint, '#e0264f');
      assert.equal(c1.rivalTint, '#3057db');
      assert.ok(isRed(c1.localBall), `local pawn ${c1.localBall.join(',')}`);
      assert.ok(isBlue(c1.rivalBall), `rival pawn ${c1.rivalBall.join(',')}`);
      assert.match(c1.localClass, /\bred\b/);
      assert.match(c1.rivalClass, /\bblue\b/);
    }
  });
await check('the spotlight is at least a 48px thumb target', () => {
    assert.ok(s1.spot && s1.spot.w >= 48 && s1.spot.h >= 48, `spot ${s1.spot?.w}×${s1.spot?.h}`);
  });
await check('step 1 carries the one Next key; the card does not cover the banner', () => {
    assert.equal(s1.nextHidden, false);
    assert.equal(s1.nextLabel, 'Next');
    assert.ok(s1.nextHeight >= 36, `Next key ${s1.nextHeight}px tall`);
    assert.equal(overlaps(s1.spot, s1.card), false);
  });
await check('Skip Tutorial is present and interactive', () => {
    assert.equal(s1.skipEvents, 'auto');
    assert.equal(s1.skipText, 'Skip Tutorial');
    assert.ok(s1.skip.h >= 48 && s1.skip.y >= 0);
  });

  /* ---- live language switching: Persian RTL first, Russian, then back to English ---- */
  const fa1 = await pickLang(pg, 'fa');
await check('فارسی repaints the current GOAL step instantly in true RTL', () => {
    assert.equal(fa1.stage, 'goal', 'a language switch must not move the stage');
    assert.equal(fa1.kicker, 'قدم ۱ از ۴');
    assert.equal(fa1.title, 'هدف بازی');
    assert.equal(fa1.body,
      'هرکی زودتر مهره‌ش رو به خط پایان (FINISH) اون بالا برسونه برنده‌ست! بزن بریم.');
    assert.equal(fa1.nextLabel, 'بزن بریم');
    assert.equal(fa1.skipText, 'رد کردن آموزش');
    assert.equal(fa1.readyText, 'حله، راه افتادی! حالا برو تا خط پایان!');
    assert.equal(fa1.cardDir, 'rtl');
    assert.equal(fa1.cardLang, 'fa');
    assert.equal(fa1.skipDir, 'rtl');
    assert.equal(fa1.readyDir, 'rtl');
    assert.equal(fa1.readyLang, 'fa');
    assert.equal(fa1.readyHidden, true, 'the ready toast must wait for the final tap');
    assert.match(fa1.cardFont, /Vazirmatn/);
    assert.match(fa1.skipFont, /Vazirmatn/);
    assert.match(fa1.readyFont, /Vazirmatn/);
    assert.equal(tracking(fa1.kickerSpacing), 0, `kicker spacing ${fa1.kickerSpacing}`);
    assert.equal(tracking(fa1.titleSpacing), 0, `title spacing ${fa1.titleSpacing}`);
    assert.equal(tracking(fa1.bodySpacing), 0, `body spacing ${fa1.bodySpacing}`);
    assert.ok(Math.abs(fa1.bodyLine - 1.65) < 0.05, `Persian body line-height ${fa1.bodyLine}`);
    assert.equal(fa1.storedLang, 'fa');
    assert.equal(fa1.lang.buttons.find((b) => b.code === 'fa').pressed, 'true');
    assert.equal(fa1.lang.buttons.find((b) => b.code === 'en').pressed, 'false');
    assert.ok(fitsViewport(fa1), `FA overflows: ${fa1.scrollW}/${fa1.viewportW}`);
  });

  const ru1 = await pickLang(pg, 'ru');
await check('RU repaints the same step with the Cyrillic stack and LTR flow', () => {
    assert.equal(ru1.stage, 'goal');
    assert.equal(ru1.kicker, 'ШАГ 1 ИЗ 4');
    assert.equal(ru1.title, 'ЦЕЛЬ ИГРЫ');
    assert.equal(ru1.body,
      'Тот, кто первым доведёт фишку до линии FINISH наверху — побеждает! Нажми далее.');
    assert.equal(ru1.nextLabel, 'Далее');
    assert.equal(ru1.skipText, 'Пропустить');
    assert.equal(ru1.readyText, 'ВСЁ ГОТОВО! ВПЕРЁД К ФИНИШУ!');
    assert.equal(ru1.cardDir, 'ltr');
    assert.equal(ru1.cardLang, 'ru');
    assert.equal(ru1.skipDir, 'ltr');
    assert.equal(ru1.readyDir, 'ltr');
    assert.match(ru1.cardFont, /Inter/);
    assert.match(ru1.cardFont, /Rubik/);
    assert.equal(ru1.storedLang, 'ru');
    assert.equal(ru1.lang.buttons.find((b) => b.code === 'en').pressed, 'false');
    assert.ok(fitsViewport(ru1), `RU overflows: ${ru1.scrollW}/${ru1.viewportW}`);
  });

  const en1 = await pickLang(pg, 'en');
await check('EN restores the exact English copy and LTR flow', () => {
    assert.equal(en1.stage, 'goal');
    assert.equal(en1.title, 'THE GOAL');
    assert.equal(en1.nextLabel, 'Next');
    assert.equal(en1.skipText, 'Skip Tutorial');
    assert.equal(en1.cardDir, 'ltr');
    assert.equal(en1.cardLang, 'en');
    assert.equal(en1.readyText, "YOU'RE READY! REACH THE FINISH LINE!");
    assert.equal(en1.storedLang, 'en');
    assert.ok(fitsViewport(en1), `EN overflows after switching: ${en1.scrollW}/${en1.viewportW}`);
  });

  /* a tap outside the spotlight is swallowed and does not advance the lesson */
  await pg.mouse.click(8, Math.round(h * 0.72));
  await pg.waitForTimeout(180);
  const blocked = await read(pg);
await check('a wrong tap cannot advance or act', () => {
    assert.equal(blocked.stage, 'goal');
    assert.equal(blocked.title, 'THE GOAL');
  });

  /* 1 — the banner itself on the narrowest phone, the card's Next key on the others */
  const goal = await read(pg);
  if (w === 360) await pg.mouse.click(goal.spot.cx, goal.spot.cy);
  else await pg.click('#tut-next');
  await waitTitle(pg, 'SELECT YOUR PIECE');
  await pg.waitForTimeout(120);
  const s2 = await read(pg);
await check('step 1 hands over to SELECT YOUR PIECE (step 2 of 4)', () => {
    assert.equal(s2.stage, 'select');
    assert.equal(s2.kicker, 'STEP 2 OF 4');
    assert.equal(s2.title, 'SELECT YOUR PIECE');
    assert.equal(s2.body, 'Tap your glowing piece to see where you can move.');
    assert.equal(s2.nextHidden, true, 'the Next key must belong to step 1 only');
    assert.equal(overlaps(s2.spot, s2.card), false);
  });

  /* 2A — select the pawn */
  await pg.mouse.click(s2.spot.cx, s2.spot.cy);
  await waitTitle(pg, 'MOVE FORWARD');
  await pg.waitForTimeout(80);
  const s3 = await read(pg);
await check('tapping the pawn moves the spotlight to the forward tile', () => {
    assert.equal(s3.stage, 'move');
    assert.equal(s3.kicker, 'STEP 2 OF 4');
    assert.equal(s3.title, 'MOVE FORWARD');
    assert.equal(s3.body, 'Tap the glowing tile ahead to move one step closer to FINISH!');
    assert.equal(s3.aid?.kind, 'finish');
    assert.ok(s3.aid.w > 100 && s3.aid.y < h * 0.4, 'FINISH aid is not the top band');
    assert.equal(overlaps(s3.spot, s3.card), false);
  });

  /* 2B — tap the glowing forward tile */
  const tap2 = await read(pg);
  await pg.mouse.click(tap2.spot.cx, tap2.spot.cy);
  await waitTitle(pg, 'PLACE A WALL');
  await pg.waitForTimeout(80);
  const s4 = await read(pg);
await check('step 3 highlights the groove between tiles for a single-tap wall', () => {
    assert.equal(s4.stage, 'wall');
    assert.equal(s4.kicker, 'STEP 3 OF 4');
    assert.equal(s4.title, 'PLACE A WALL');
    assert.equal(s4.body,
      'Tap the glowing line in front of your opponent to put up a wall and block their path!');
    assert.equal(s4.aid?.kind, 'wall');
    assert.ok(parseFloat(s4.aidLine) >= 2, `the seam highlight is ${s4.aidLine} tall`);
    assert.ok(s4.spot.h >= 48, 'the groove cut-out is under a thumb');
    assert.equal(overlaps(s4.spot, s4.card), false);
    assert.equal(s4.wallCount, '8', 'the wall must still be unspent when step 3 opens');
  });

  /* the switcher must be live on step 3 without spending the wall or moving the lesson */
  const faWall = await pickLang(pg, 'fa');
await check('the switcher is live on step 3 without spending the wall', () => {
    assert.equal(faWall.stage, 'wall');
    assert.equal(faWall.title, 'دیوار بکش!');
    assert.equal(faWall.body, 'رو این خطِ نورانی جلوی حریفت بزن تا یه دیوار بذاری و راهشو ببندی!');
    assert.equal(faWall.cardDir, 'rtl');
    assert.equal(faWall.wallCount, s4.wallCount, 'switching language spent a wall');
    assert.equal(faWall.hidden, false, 'switching language closed the lesson');
    assert.ok(faWall.spot && Math.abs(faWall.spot.cx - s4.spot.cx) <= 2,
      'the spotlight moved off the groove');
    assert.ok(fitsViewport(faWall), `FA wall overflows: ${faWall.scrollW}/${faWall.viewportW}`);
  });
  const enWall = await pickLang(pg, 'en');
await check('switching back restores the English wall step in place', () => {
    assert.equal(enWall.stage, 'wall');
    assert.equal(enWall.title, 'PLACE A WALL');
    assert.equal(enWall.kicker, 'STEP 3 OF 4');
    assert.equal(enWall.wallCount, '8');
    assert.equal(enWall.storedLang, 'en');
  });

  /* one forgiving tap near the spotlight's padded top edge commits the wall outright */
  const tap3 = await read(pg);
  await pg.mouse.click(tap3.spot.cx, tap3.spot.y + 4);
  await waitHidden(pg);
  const live = await read(pg);
await check('ONE tap commits the wall (8 → 7) and exits straight into live play', () => {
    assert.equal(live.hidden, true, 'the single wall tap did not close the overlay');
    assert.equal(live.stage, null);
    assert.equal(live.liveClass, false, 'the tutorial input guard is still latched');
    assert.equal(live.wallCount, '7');
    assert.equal(live.nextHidden, true);
  });
await check('live play is actually live (the mine key obeys normal turns)', async () => {
    /* on the rival's turn the key is disabled; the player's own live turn re-enables it */
    await pg.waitForFunction(() => !document.getElementById('mine-btn').disabled, null, { timeout: 8000 });
  });

  /* Now the player really plays: every live turn, walk the pawn forward. The rival is blocked by
     the wall the lesson just placed, so this intermission can run a few turns — the overlay must
     stay away until the rival has genuinely gained two rows, then re-open on its own. */
  const mineDeadline = Date.now() + 60000;
  let reopened = false;
  while (Date.now() < mineDeadline) {
    const st = await pg.evaluate(() => {
      const root = document.getElementById('tutorial');
      return {
        open: !!root && !root.hidden,
        stage: root?.dataset.stage ?? null,
        myTurn: (document.getElementById('chip-0')?.className || '').includes('active'),
        mine: document.getElementById('mine-btn').disabled,
      };
    });
    if (st.open) { reopened = st.stage === 'mine-arm'; break; }
    if (!st.myTurn || st.mine) { await pg.waitForTimeout(200); continue; }
    const pawn = await pawnCell(pg);
    if (!pawn) { await pg.waitForTimeout(200); continue; }
    const g = await read(pg);
    for (const [dc, dr] of [[0, -1], [-1, -1], [1, -1]]) {
      const c = pawn.c + dc, r = pawn.r + dr;
      if (c < 0 || c > 7 || r < 1) continue;
      await pg.mouse.click(g.board.left + (c + 0.5) * g.board.cell,
        g.board.top + (r + 0.5) * g.board.cell);
      await pg.waitForTimeout(260);
      const stillMine = await pg.evaluate(() =>
        (document.getElementById('chip-0')?.className || '').includes('active'));
      if (!stillMine) break;
    }
    await pg.waitForTimeout(180);
  }
  await check('the mine lesson re-opens by itself after two live rival rows', () => {
    assert.equal(reopened, true, 'the wall intermission never handed back to the mine lesson');
  });
  if (!reopened) throw new Error('the mine lesson never re-opened after the live-play intermission');
  await pg.waitForTimeout(120);
  const mine = await read(pg);
await check('the re-opened step is 4A on the mine key', () => {
    assert.equal(mine.stage, 'mine-arm');
    assert.equal(mine.kicker, 'STEP 4 OF 4');
    assert.equal(mine.title, 'ARM A TRAP');
    assert.equal(mine.body, 'Tap the Mine button below to prepare a hidden trap!');
    assert.equal(mine.liveClass, true);
    assert.equal(mine.mineDisabled, false, 'the mine key is not armed for 4A');
  });
await check('the HUD card does not cover the mine key spotlight', () => {
    assert.equal(overlaps(mine.spot, mine.card), false);
  });

  /* the switcher is live on step 4A too, and a repaint must not disarm the mine key */
  const ruMine = await pickLang(pg, 'ru');
await check('RU repaints step 4A without disturbing the armed mine key', () => {
    assert.equal(ruMine.stage, 'mine-arm');
    assert.equal(ruMine.kicker, 'ШАГ 4 ИЗ 4');
    assert.equal(ruMine.title, 'ПОДГОТОВЬ МИНУ');
    assert.equal(ruMine.body, 'Нажми на кнопку мины внизу, чтобы подготовить скрытую ловушку!');
    assert.equal(ruMine.cardDir, 'ltr');
    assert.equal(ruMine.mineDisabled, false);
    assert.equal(ruMine.mineCount, mine.mineCount);
    assert.ok(fitsViewport(ruMine), `RU mine overflows: ${ruMine.scrollW}/${ruMine.viewportW}`);
  });
  await pickLang(pg, 'en');

  /* 4A — tap the real mine key in the dock */
  const tap4 = await read(pg);
  await pg.mouse.click(tap4.spot.cx, tap4.spot.cy);
  await waitTitle(pg, 'PLANT THE MINE');
  await pg.waitForTimeout(80);
  const s5 = await read(pg);
  const tileRow = Math.round((s5.spot.cy - s5.board.top) / s5.board.cell - 0.5);
await check('step 4B points at a single tile ahead of the rival', () => {
    assert.equal(s5.stage, 'mine-place');
    assert.equal(s5.aid?.kind, 'tile');
    assert.equal(s5.title, 'PLANT THE MINE');
    assert.equal(s5.body,
      'Tap the glowing tile ahead of your opponent to hide the mine in their path!');
    assert.equal(s5.mineDisabled, true, 'the mine key should stand down once armed');
    assert.ok(s5.spot.w < s5.board.cell * 1.6, `mine tile spotlight ${s5.spot.w}px is not one cell`);
    /* two rows up from the duel's baseline is row 9: its forward path lands on row 8 or above */
    assert.ok(tileRow >= 0 && tileRow <= 8, `mine tile row ${tileRow} — the lesson ran too early`);
    assert.equal(overlaps(s5.spot, s5.card), false);
  });

  /* 4B — فارسی must repaint the final step and pre-language the ready toast */
  const faMine = await pickLang(pg, 'fa');
await check('فارسی repaints the final step and pre-languages the ready toast', () => {
    assert.equal(faMine.stage, 'mine-place');
    assert.equal(faMine.kicker, 'قدم ۴ از ۴');
    assert.equal(faMine.title, 'کاشتن مین!');
    assert.equal(faMine.body,
      'حالا رو خونه جلوی حریف بزن تا مین رو سر راهش قایم کنی! بره روش حسابی عقب می‌افته!');
    assert.equal(faMine.cardDir, 'rtl');
    assert.equal(faMine.readyText, 'حله، راه افتادی! حالا برو تا خط پایان!');
    assert.equal(faMine.readyDir, 'rtl');
    assert.equal(faMine.readyLang, 'fa');
    assert.equal(faMine.readyHidden, true);
    assert.equal(faMine.mineCount, '3', 'switching language planted a mine');
    assert.ok(fitsViewport(faMine), `FA mine overflows: ${faMine.scrollW}/${faMine.viewportW}`);
  });
  const enMine = await pickLang(pg, 'en');
await check('EN returns the final step to the exact English copy', () => {
    assert.equal(enMine.stage, 'mine-place');
    assert.equal(enMine.title, 'PLANT THE MINE');
    assert.equal(enMine.body,
      'Tap the glowing tile ahead of your opponent to hide the mine in their path!');
    assert.equal(enMine.cardDir, 'ltr');
    assert.equal(enMine.storedLang, 'en');
  });

  /* 4B — plant it: the overlay must be gone at once and stay gone, with no watch beat */
  const tap5 = await read(pg);
  const plantedAt = Date.now();
  await pg.mouse.click(tap5.spot.cx, tap5.spot.cy);
  await waitHidden(pg);
  const after = await read(pg);
await check('planting the mine closes the lesson immediately and permanently', async () => {
    assert.equal(after.hidden, true);
    assert.equal(after.stage, null);
    assert.equal(after.liveClass, false);
    assert.equal(after.mineCount, '2');
    assert.ok(Date.now() - plantedAt < 2500, 'the lesson did not close immediately');
    assert.equal(after.readyHidden, false, 'the ready toast never appeared');
    assert.equal(after.readyText, "YOU'RE READY! REACH THE FINISH LINE!");
    assert.equal(after.readyDir, 'ltr');
    assert.equal(after.readyLang, 'en');
    assert.ok(fitsViewport(after), `ready toast overflows: ${after.scrollW}/${after.viewportW}`);
    await pg.waitForTimeout(1200);
    const still = await read(pg);
    assert.equal(still.hidden, true, 'the overlay came back while the race was live');
  });
await check('the planted mine is armed on the board for the live rival', async () => {
    /* the live bot walks or answers on its own: the only requirement here is that the lesson has
       not frozen the board (the rival's turn resolves and the dock re-enables) */
    await pg.waitForFunction(() => !document.getElementById('mine-btn').disabled, null, { timeout: 8000 });
  });
await check('completion is persisted to the real save', async () => {
    const raw = await pg.evaluate(() => JSON.parse(localStorage.getItem('detour.save.v2') || 'null'));
    assert.equal(raw?.tutorialCompleted, true);
  });
await check('no page errors during the lesson', () => {
    assert.deepEqual(errors, []);
  });

  if (w === 390) {
    /* the visible replay door lives on the pause sheet of a local bot race */
    await pg.click('#menu-btn');
    await pg.waitForSelector('#sheet-pause:not([hidden])', { timeout: 3000 });
    const replayVisible = await pg.isVisible('#pause-tutorial');
    await pg.click('#pause-tutorial');
    await pg.waitForSelector('#tutorial:not([hidden])', { timeout: 4000 });
    await pg.waitForTimeout(520);
    const replay = await read(pg);
    await check('Pause → Replay tutorial restarts the lesson on the goal', () => {
      assert.equal(replayVisible, true);
      assert.equal(replay.stage, 'goal');
      assert.equal(replay.title, 'THE GOAL');
      assert.equal(replay.wallCount, '8');
      assert.equal(replay.mineCount, '3');
      assert.equal(replay.readyHidden, true, 'the old ready toast stayed over the replay');
    });
    await pg.click('#tut-skip');
    await pg.waitForSelector('#tutorial', { state: 'hidden', timeout: 3000 });

    await pg.reload({ waitUntil: 'networkidle' });
    await pg.waitForTimeout(900);
    await pg.click('#home-play');
    await pg.waitForTimeout(1200);
    const second = await read(pg);
    const secondColors = await colors(pg);
await check('a completed save never auto-shows the lesson again', () => {
      assert.equal(second.hidden, true);
      assert.equal(second.wallCount, '8');
      assert.equal(second.mineCount, '3');
    });
await check('the blue perspective survives a reload into the next race', () => {
      assert.equal(secondColors.localTint, '#3057db');
      assert.equal(secondColors.rivalTint, '#e0264f');
      assert.ok(isBlue(secondColors.localBall), `local pawn ${secondColors.localBall.join(',')}`);
      assert.ok(isRed(secondColors.rivalBall), `rival pawn ${secondColors.rivalBall.join(',')}`);
    });
  }

  await ctx.close();
}

/* the skip door, on a clean save, also persists the chosen language and completion */
{
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const pg = await ctx.newPage();
  await pg.goto(base, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(900);
  await pg.evaluate(() => localStorage.setItem('tactix_tut_lang', 'fa'));
  await pg.reload({ waitUntil: 'networkidle' });
  await pg.waitForTimeout(900);
  await pg.click('#home-play');
  await pg.waitForSelector('#tutorial:not([hidden])', { timeout: 5000 });
  await pg.waitForTimeout(520);
  const first = await read(pg);
  rows.push('\n── skip ──');
await check('a stored tactix_tut_lang reopens the lesson in فارسی RTL', () => {
    assert.equal(first.stage, 'goal');
    assert.equal(first.title, 'هدف بازی');
    assert.equal(first.cardDir, 'rtl');
    assert.equal(first.cardLang, 'fa');
    assert.equal(first.skipText, 'رد کردن آموزش');
    assert.equal(first.storedLang, 'fa');
    assert.match(first.cardFont, /Vazirmatn/);
    assert.ok(fitsViewport(first), `FA start overflows: ${first.scrollW}/${first.viewportW}`);
  });
  await pg.click('#tut-skip');
  await pg.waitForSelector('#tutorial', { state: 'hidden', timeout: 3000 });
  const raw = await pg.evaluate(() => JSON.parse(localStorage.getItem('detour.save.v2') || 'null'));
await check('رد کردن آموزش closes the lesson and marks it complete', () => {
    assert.equal(raw?.tutorialCompleted, true);
  });
  await ctx.close();
}

} catch (e) {
  rows.push(`\n  CRASH ${e.message.split('\n')[0]}`);
  try {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) rows.push(`  state ${JSON.stringify(await read(page))}`);
  } catch { /* the page is already gone */ }
} finally {
  await browser.close();
  srv.close();
  console.log(rows.join('\n'));
  console.log(failed ? `\n${failed} tutorial verification check(s) failed.` : '\nTutorial walkthrough passed at 360, 390 and 430.');
  process.exit(failed ? 1 : 0);
}
