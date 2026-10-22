/**
 * verify-tutorial.mjs — drives the real hands-on lesson on ./dist.
 *
 * Serves the build, starts a local bot race with a clean save, and completes all four units by
 * tapping the actual spotlight hole at 360, 390 and 430 CSS px. Fails (exit 1) when:
 *  - any Next/forward proxy button exists, or a step cannot be completed by its real target;
 *  - the spotlight is smaller than a 48px thumb, or the HUD card covers it;
 *  - the FINISH aid, wall groove aid, mine tile aid or gold celebration banner is missing;
 *  - a step-3 tap near the spotlight EDGE does not commit the wall in one tap;
 *  - the planted mine does not pull the rival two legal steps onto it and detonate before the banner;
 *  - the tutorial pointer is still the cartoon emoji, or is not the animated tactical SVG;
 *  - the client-side red/blue perspective does not swap both pawns and HUD chips, or the choice
 *    does not survive a reload;
 *  - the wall counter or mine counter does not move, or the save never records completion;
 *  - a completed save re-shows the lesson on the next local race;
 *  - Skip Tutorial is missing, covered, or does not persist completion.
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

const read = (pg) => pg.evaluate(() => {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  const root = document.getElementById('tutorial');
  const spot = document.getElementById('tut-spot');
  const aid = document.getElementById('tut-aid');
  const card = document.getElementById('tut-card');
  const skip = document.getElementById('tut-skip');
  const done = document.getElementById('tut-done');
  return {
    hidden: root.hidden,
    stage: root.dataset.stage ?? null,
    tone: root.dataset.tone ?? null,
    kicker: document.getElementById('tut-step').textContent,
    title: document.getElementById('tut-title').textContent,
    body: document.getElementById('tut-body').textContent,
    spot: spot.hidden ? null : rect(spot),
    aid: aid.hidden ? null : { kind: aid.dataset.kind, ...rect(aid) },
    card: rect(card),
    skip: rect(skip),
    skipEvents: getComputedStyle(skip).pointerEvents,
    doneHidden: done.hidden,
    doneText: done.textContent.replace(/\s+/g, ' ').trim(),
    mineDisabled: document.getElementById('mine-btn').disabled,
    mineCount: document.querySelector('#mine-n')?.textContent ?? null,
    wallCount: document.querySelector('#walls-0 .wall-n')?.textContent ?? null,
    note: document.getElementById('note')?.textContent ?? '',
    live: document.getElementById('tut-live')?.textContent ?? '',
    legacyButtons: document.querySelectorAll('#tut-next, #tut-forward').length,
    handCount: document.querySelectorAll('.tut-hand').length,
    tapSvg: !!document.querySelector('#tut-pointer .tut-tap'),
    tapFilter: document.querySelector('.tut-tap')
      ? getComputedStyle(document.querySelector('.tut-tap')).filter : '',
    tapAnim: document.querySelector('.tut-tap')
      ? getComputedStyle(document.querySelector('.tut-tap')).animationName : '',
    sonarAnim: document.querySelector('.tut-sonar i')
      ? getComputedStyle(document.querySelector('.tut-sonar i')).animationName : '',
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
  (want) => document.getElementById('tut-title')?.textContent === want, title, { timeout: 5000 },
);

let failed = 0;
const rows = [];
const check = async (label, fn) => {
  try { await fn(); rows.push(`  ok  ${label}`); }
  catch (e) { failed++; rows.push(`  FAIL ${label}\n       ${e.message.split('\n')[0]}`); }
};

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

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
await check('starts on SELECT YOUR PIECE (step 1 of 4)', () => {
    assert.equal(s1.stage, 'select');
    assert.equal(s1.kicker, 'STEP 1 OF 4');
    assert.equal(s1.title, 'SELECT YOUR PIECE');
    assert.equal(s1.body, 'Tap your glowing piece to start.');
    assert.equal(s1.legacyButtons, 0, 'a Next/forward proxy is back in the DOM');
  });
await check('the cartoon hand is gone and the animated tactical pointer is live', () => {
    assert.equal(s1.handCount, 0, 'the emoji hand is still in the tutorial DOM');
    assert.equal(s1.tapSvg, true, 'the tactical SVG pointer is missing');
    assert.match(s1.tapFilter, /drop-shadow/);
    assert.match(s1.tapFilter, /56,\s*189,\s*248/);
    assert.equal(s1.tapAnim, 'tutTapPress');
    assert.equal(s1.sonarAnim, 'tutPulseRing');
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
await check('spotlight is a 48px thumb target', () => {
    assert.ok(s1.spot && s1.spot.w >= 48 && s1.spot.h >= 48, `spot ${s1.spot?.w}×${s1.spot?.h}`);
  });
await check('the HUD card does not cover the spotlight', () => {
    assert.equal(overlaps(s1.spot, s1.card), false);
  });
await check('Skip Tutorial is present and interactive', () => {
    assert.equal(s1.skipEvents, 'auto');
    assert.ok(s1.skip.h >= 48 && s1.skip.y >= 0);
  });

  /* a tap outside the spotlight is swallowed and does not advance the lesson */
  await pg.mouse.click(8, Math.round(h * 0.42));
  await pg.waitForTimeout(180);
  const blocked = await read(pg);
await check('a wrong tap cannot advance or act', () => {
    assert.equal(blocked.stage, 'select');
    assert.equal(blocked.title, 'SELECT YOUR PIECE');
  });

  /* 1 — select the pawn */
  const tap1 = await read(pg);
  await pg.mouse.click(tap1.spot.cx, tap1.spot.cy);
  await waitTitle(pg, 'MOVE TO FINISH');
  await pg.waitForTimeout(80);
  const s2 = await read(pg);
await check('step 2 pulses the gold FINISH band', () => {
    assert.equal(s2.stage, 'move');
    assert.equal(s2.aid?.kind, 'finish');
    assert.ok(s2.aid.w > 100 && s2.aid.y < h * 0.4, 'FINISH aid is not the top band');
    assert.equal(overlaps(s2.spot, s2.card), false);
  });

  /* 2 — tap the glowing forward tile */
  const tap2 = await read(pg);
  await pg.mouse.click(tap2.spot.cx, tap2.spot.cy);
  await waitTitle(pg, 'PLACE A WALL');
  await pg.waitForTimeout(80);
  const s3 = await read(pg);
await check('step 3 highlights a wall groove in front of the rival', () => {
    assert.equal(s3.stage, 'wall');
    assert.equal(s3.aid?.kind, 'wall');
    assert.ok(s3.spot.h >= 48, 'the groove cut-out is under a thumb');
    assert.equal(overlaps(s3.spot, s3.card), false);
  });

  /* 3 — one tap anywhere inside the spotlight, near its padded top edge and well above the
     hairline groove: the forgiving hit zone must snap it onto the live target and commit */
  const tap3 = await read(pg);
  await pg.mouse.click(tap3.spot.cx, tap3.spot.y + 4);
  await waitTitle(pg, 'ARM A TRAP');
  await pg.waitForTimeout(80);
  const s4 = await read(pg);
await check('a single edge tap inside the spotlight places the wall (8 → 7)', () => {
    assert.equal(s4.stage, 'mine-arm');
    assert.equal(s4.kicker, 'STEP 4 OF 4');
    assert.equal(s4.wallCount, '7');
    assert.equal(s4.mineDisabled, false, 'the mine key is not armed for step 4A');
  });

  /* 4A — tap the real mine key in the dock */
  const tap4 = await read(pg);
  await pg.mouse.click(tap4.spot.cx, tap4.spot.cy);
  await waitTitle(pg, 'PLANT THE MINE');
  await pg.waitForTimeout(80);
  const s5 = await read(pg);
await check('step 4B points at a single glowing mine tile', () => {
    assert.equal(s5.aid?.kind, 'tile');
    assert.equal(s5.mineDisabled, true, 'the mine key should stand down once armed');
    assert.equal(overlaps(s5.spot, s5.card), false);
  });

  /* 4B — tap the real board tile, then watch the rival walk onto the charge */
  const tap5 = await read(pg);
  await pg.mouse.click(tap5.spot.cx, tap5.spot.cy);
  await waitTitle(pg, 'WATCH THIS!');
  const watch = await read(pg);
await check('planting the mine starts the WATCH THIS beat, not the banner', () => {
    assert.equal(watch.stage, 'mine-place');
    assert.equal(watch.doneHidden, true, 'the ready banner landed before the demonstration');
    assert.match(watch.body, /advancing into your trap/i);
    assert.equal(watch.mineCount, '2');
  });
  /* two scripted legal steps, 350ms apart, the second onto the mine */
  await pg.waitForFunction(
    () => /step 2 of 2/i.test(document.getElementById('tut-live')?.textContent ?? ''),
    null, { timeout: 6000 },
  );
  await pg.waitForFunction(
    () => /^Mine!/.test(document.getElementById('note')?.textContent ?? ''),
    null, { timeout: 6000 },
  );
  const blast = await read(pg);
await check('the rival\'s two-step advance detonates the mine before the banner', () => {
    assert.equal(blast.doneHidden, true, 'the banner covers the blast');
    assert.match(blast.note, /^Mine! .*thrown back \d+ cells?/);
    assert.match(blast.live, /step 2 of 2/i);
    assert.equal(blast.mineCount, '2');
  });

  await pg.waitForSelector('#tut-done:not([hidden])', { timeout: 6000 });
  const done = await read(pg);
await check('the 1.2s "YOU\'RE READY" banner is shown', () => {
    assert.equal(done.doneHidden, false);
    assert.match(done.doneText, /YOU'RE READY! REACH THE FINISH LINE!/);
  });

  await pg.waitForSelector('#tutorial', { state: 'hidden', timeout: 4000 });
  const after = await read(pg);
await check('the mine is really planted (3 → 2) and the lesson closes', () => {
    assert.equal(after.mineCount, '2');
    assert.equal(after.hidden, true);
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
    await check('Pause → Replay tutorial restarts the lesson on a fresh board', () => {
      assert.equal(replayVisible, true);
      assert.equal(replay.stage, 'select');
      assert.equal(replay.title, 'SELECT YOUR PIECE');
      assert.equal(replay.wallCount, '8');
      assert.equal(replay.mineCount, '3');
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

/* the skip door, on a clean save, also persists completion */
{
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const pg = await ctx.newPage();
  await pg.goto(base, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(900);
  await pg.click('#home-play');
  await pg.waitForSelector('#tutorial:not([hidden])', { timeout: 5000 });
  await pg.click('#tut-skip');
  await pg.waitForSelector('#tutorial', { state: 'hidden', timeout: 3000 });
  const raw = await pg.evaluate(() => JSON.parse(localStorage.getItem('detour.save.v2') || 'null'));
  rows.push('\n── skip ──');
await check('Skip Tutorial closes the lesson and marks it complete', () => {
    assert.equal(raw?.tutorialCompleted, true);
  });
  await ctx.close();
}

await browser.close();
srv.close();

console.log(rows.join('\n'));
console.log(failed ? `\n${failed} tutorial verification check(s) failed.` : '\nTutorial walkthrough passed at 360, 390 and 430.');
process.exit(failed ? 1 : 0);
