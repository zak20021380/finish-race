/**
 * verify-tutorial.mjs — drives the real hands-on lesson on ./dist.
 *
 * Serves the build, starts a local bot race with a clean save, and completes all four units by
 * tapping the actual spotlight hole at 360, 390 and 430 CSS px. Fails (exit 1) when:
 *  - any Next/forward proxy button exists, or a step cannot be completed by its real target;
 *  - the spotlight is smaller than a 48px thumb, or the HUD card covers it;
 *  - the FINISH aid, wall groove aid, mine tile aid or gold celebration banner is missing;
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
    legacyButtons: document.querySelectorAll('#tut-next, #tut-forward').length,
  };
});

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
  await pg.click('#home-play');
  await pg.waitForSelector('#tutorial:not([hidden])', { timeout: 5000 });
  await pg.waitForTimeout(520);   // the game screen is still sliding in; let the spotlight settle

  rows.push(`\n── ${w}×${h} ──`);
  const s1 = await read(pg);
await check('starts on SELECT YOUR PIECE (step 1 of 4)', () => {
    assert.equal(s1.stage, 'select');
    assert.equal(s1.kicker, 'STEP 1 OF 4');
    assert.equal(s1.title, 'SELECT YOUR PIECE');
    assert.equal(s1.body, 'Tap your glowing piece to start.');
    assert.equal(s1.legacyButtons, 0, 'a Next/forward proxy is back in the DOM');
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

  /* 3 — tap the glowing groove; the wall commits in one tutorial tap */
  const tap3 = await read(pg);
  await pg.mouse.click(tap3.spot.cx, tap3.spot.cy);
  await waitTitle(pg, 'ARM A TRAP');
  await pg.waitForTimeout(80);
  const s4 = await read(pg);
await check('the wall is really placed (8 → 7) before the mine steps', () => {
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

  /* 4B — tap the real board tile */
  const tap5 = await read(pg);
  await pg.mouse.click(tap5.spot.cx, tap5.spot.cy);
  await pg.waitForSelector('#tut-done:not([hidden])', { timeout: 3000 });
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
await check('a completed save never auto-shows the lesson again', () => {
      assert.equal(second.hidden, true);
      assert.equal(second.wallCount, '8');
      assert.equal(second.mineCount, '3');
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
