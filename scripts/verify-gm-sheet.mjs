/**
 * verify-gm-sheet.mjs â€” Playwright driver for scripts/gm-sheet-check.js.
 *
 * No new project dependencies: `playwright-core` is resolved at runtime only.
 * Run without touching package.json:
 *
 *   NODE_PATH="C:\\Users\\PC-Y\\AppData\\Local\\Temp\\opencode\\check\\node_modules" node scripts/verify-gm-sheet.mjs
 *
 * Serves ./dist over 127.0.0.1, then checks 360x640 and 390x844 in light + dark:
 * the main sheet (with the size segment open), then the friends sub-screen, then
 * the create-room state. Fails (exit 1) on any DOM failure or a missing screenshot.
 *
 * Screenshots: .shots/gm-main-{w}x{h}-{theme}.png and .shots/gm-room-{w}x{h}-{theme}.png
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const SHOTS = path.resolve(here, '..', '.shots');
const CHECK_JS = path.resolve(here, 'gm-sheet-check.js');

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error(
    'playwright-core not found. Run with NODE_PATH pointing at a temp install, e.g.:\n' +
      '  NODE_PATH="C:\\\\Users\\\\PC-Y\\\\AppData\\\\Local\\\\Temp\\\\opencode\\\\check\\\\node_modules" node scripts/verify-gm-sheet.mjs',
  );
  process.exit(2);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(String(req.url).split('?')[0]);
      if (p === '/') p = '/index.html';
      const fp = path.join(DIST, p.slice(1));
      fs.readFile(fp, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VIEWPORTS = [
  [360, 640],
  [390, 844],
];
const THEMES = ['light', 'dark'];

const checkSrc = fs.readFileSync(CHECK_JS, 'utf8');
const boot = (pane) => `${checkSrc}\ncheckGmSheet(${JSON.stringify(pane)})`;

const srv = await serve();
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

let failed = 0;
const report = (label, res) => {
  if (res.pass) {
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL ${label}\n- ${res.fails.join('\n- ')}`);
  }
};
const expect = (label, ok, detail) => {
  if (ok) {
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL ${label}${detail ? `\n- ${detail}` : ''}`);
  }
};

try {
  for (const [w, h] of VIEWPORTS) {
    for (const theme of THEMES) {
      const tag = `${w}x${h} ${theme}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
      const pg = await ctx.newPage();
      await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
      await pg.waitForTimeout(1300);

      await pg.click('#mode-change');
      await pg.waitForTimeout(700);
      const open = await pg.evaluate(
        () => {
          const s = document.getElementById('sheet-game-modes');
          return !!s && !s.hidden && s.classList.contains('open');
        },
      );
      expect(`open ${tag}`, open, '#sheet-game-modes did not open');
      if (!open) {
        await ctx.close();
        continue;
      }

      /* ---- interactions: rows, in-row options, the live Start label ---- */
      await pg.click('.gm-pick[data-gmode="duel_1v1"]');
      await pg.waitForTimeout(250);
      const quick = await pg.evaluate(() => ({
        start: document.getElementById('gm-start')?.textContent?.trim(),
        wait: document.getElementById('gm-wait')?.textContent?.trim(),
        active: document.querySelector('.gm-card[data-row="online"]')?.classList.contains('is-active'),
        size: document.querySelector('#sheet-game-modes [data-size="duel_1v1"]')?.getAttribute('aria-pressed'),
      }));
      expect(
        `quick 1v1 ${tag}`,
        quick.start === 'Start 1v1 match' && quick.wait === '~5s' && quick.active === true && quick.size === 'true',
        JSON.stringify(quick),
      );

      await pg.click('.gm-pick[data-gmode="bot"]');
      await pg.waitForTimeout(250);
      const practice = await pg.evaluate(() => ({
        start: document.getElementById('gm-start')?.textContent?.trim(),
        seg: !document.querySelector('.gm-card[data-row="bot"] .gm-seg')?.hidden,
        lead: document.getElementById('gm-lead')?.textContent?.trim(),
        trophy: document.getElementById('gm-rw-trophy')?.hidden,
      }));
      expect(
        `practice ${tag}`,
        practice.start === 'Start practice match' && practice.seg === true && practice.lead === 'Practice' && practice.trophy === true,
        JSON.stringify(practice),
      );
      /* the practice row is the last one, so it is the tallest arrangement to fit */
      report(`practice sheet ${tag}`, await pg.evaluate(boot('modes')));
      if (w === 360 && theme === 'light') {
        await pg.evaluate(() => document.activeElement && document.activeElement.blur());
        await pg.waitForTimeout(150);
        await pg.screenshot({ path: path.join(SHOTS, `gm-practice-${w}x${h}-${theme}.png`) });
        console.log(`shot gm-practice-${w}x${h}-${theme}.png`);
      }
      await pg.click('#sheet-game-modes .seg-b[data-diff="hard"]');
      await pg.waitForTimeout(150);
      const hard = await pg.evaluate(
        () => document.querySelector('.seg-b[data-diff="hard"]')?.getAttribute('aria-pressed'),
      );
      expect(`difficulty ${tag}`, hard === 'true', `aria-pressed=${hard}`);

      await pg.click('.gm-pick[data-gmode="duel_1v1"]');
      await pg.waitForTimeout(150);
      await pg.click('#sheet-game-modes [data-size="party_2v2"]');
      await pg.waitForTimeout(250);
      const party = await pg.evaluate(() => ({
        start: document.getElementById('gm-start')?.textContent?.trim(),
        wait: document.getElementById('gm-wait')?.textContent?.trim(),
        coin: document.getElementById('gm-rw-coin-n')?.textContent?.trim(),
        trophy: document.getElementById('gm-rw-trophy-n')?.textContent?.trim(),
        label: document.getElementById('gm-rw-trophy')?.getAttribute('aria-label'),
      }));
      expect(
        `quick 2v2 ${tag}`,
        party.start === 'Start 2v2 match' && party.wait === '~8s' && party.coin === '+100' && party.trophy === '+50'
          && party.label === '50 trophies',
        JSON.stringify(party),
      );

      /* back to 1v1 so the screenshots match the spec's example */
      await pg.click('#sheet-game-modes [data-size="duel_1v1"]');
      await pg.waitForTimeout(250);

      report(`main sheet ${tag}`, await pg.evaluate(boot('modes')));
      fs.mkdirSync(SHOTS, { recursive: true });
      await pg.evaluate(() => document.activeElement && document.activeElement.blur());
      await pg.waitForTimeout(150);
      await pg.screenshot({ path: path.join(SHOTS, `gm-main-${w}x${h}-${theme}.png`) });
      console.log(`shot gm-main-${w}x${h}-${theme}.png`);

      /* ---- friends sub-screen ---- */
      await pg.click('.gm-pick[data-gmode="room"]');
      await pg.waitForTimeout(350);
      const pane = await pg.evaluate(() => ({
        title: document.getElementById('gm-title')?.textContent?.trim(),
        back: !document.getElementById('gm-back')?.hidden,
        room: !document.getElementById('gm-view-room')?.hidden,
        list: !document.getElementById('gm-view-modes')?.hidden,
        joinOff: document.getElementById('gm-join')?.disabled,
      }));
      expect(
        `friends pane ${tag}`,
        pane.title === 'Play with friends' && pane.back === true && pane.room === true && pane.list === false && pane.joinOff === true,
        JSON.stringify(pane),
      );
      report(`friends sheet ${tag}`, await pg.evaluate(boot('room')));
      await pg.evaluate(() => document.activeElement && document.activeElement.blur());
      await pg.waitForTimeout(150);
      await pg.screenshot({ path: path.join(SHOTS, `gm-room-${w}x${h}-${theme}.png`) });
      console.log(`shot gm-room-${w}x${h}-${theme}.png`);

      /* ---- create a room: the invite block must still fit ---- */
      await pg.click('#gm-create');
      await pg.waitForTimeout(350);
      const created = await pg.evaluate(() => ({
        invite: !document.getElementById('gm-invite')?.hidden,
        code: document.getElementById('gm-code')?.textContent?.trim(),
        input: document.getElementById('gm-join-input')?.value,
        joinOn: !document.getElementById('gm-join')?.disabled,
        checked: document.querySelector('.gm-pick[data-gmode="room"]')?.getAttribute('aria-checked'),
      }));
      expect(
        `create room ${tag}`,
        created.invite === true && /^\d{4}$/.test(created.code || '') && created.input === created.code
          && created.joinOn === true && created.checked === 'true',
        JSON.stringify(created),
      );
      report(`room with invite ${tag}`, await pg.evaluate(boot('room')));

      /* ---- back arrow, then the sticky Start ---- */
      await pg.click('#gm-back');
      await pg.waitForTimeout(300);
      const backed = await pg.evaluate(() => ({
        title: document.getElementById('gm-title')?.textContent?.trim(),
        list: !document.getElementById('gm-view-modes')?.hidden,
        back: document.getElementById('gm-back')?.hidden,
      }));
      expect(
        `back arrow ${tag}`,
        backed.title === 'Select Game Mode' && backed.list === true && backed.back === true,
        JSON.stringify(backed),
      );
      report(`after back ${tag}`, await pg.evaluate(boot('modes')));

      await pg.click('#gm-start');
      await pg.waitForTimeout(700);
      const started = await pg.evaluate(() => ({
        sheet: document.getElementById('sheet-game-modes')?.hidden,
        game: document.getElementById('s-game')?.hidden,
      }));
      expect(`start ${tag}`, started.sheet === true && started.game === false, JSON.stringify(started));

      await ctx.close();
    }
  }
} finally {
  await browser.close();
  srv.close();
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all game mode sheet checks passed');
