/**
 * verify-home-layout.mjs — Playwright driver for scripts/home-layout-check.js.
 *
 * No new project dependencies: `playwright-core` is resolved at runtime only.
 * Run without touching package.json:
 *
 *   NODE_PATH="C:\\Users\\PC-Y\\AppData\\Local\\Temp\\opencode\\check\\node_modules" node scripts/verify-home-layout.mjs
 *
 * Serves ./dist over 127.0.0.1, then checks 360x640 and 390x844 in light + dark.
 * Fails (exit 1) when the DOM check fails, a target is small, or a screenshot
 * cannot be saved. Saves .shots/home-*.png and .shots/sheet-*.png on success.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const SHOTS = path.resolve(here, '..', '.shots');
const CHECK_JS = path.resolve(here, 'home-layout-check.js');

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error(
    'playwright-core not found. Run with NODE_PATH pointing at a temp install, e.g.:\n' +
      '  NODE_PATH="C:\\\\Users\\\\PC-Y\\\\AppData\\\\Local\\\\Temp\\\\opencode\\\\check\\\\node_modules" node scripts/verify-home-layout.mjs',
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

const srv = await serve();
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

let failed = 0;
try {
  for (const [w, h] of VIEWPORTS) {
    for (const theme of THEMES) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        colorScheme: theme,
      });
      const pg = await ctx.newPage();
      await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
      await pg.waitForTimeout(1300);
      // Home check with sheet still closed (targets only Home).
      const homeResult = await pg.evaluate(`${checkSrc}\ncheckHomeLayout()`);
      const tag = `${w}x${h} ${theme}`;
      if (homeResult.pass) {
        console.log(`PASS home ${tag}`);
      } else {
        failed += 1;
        console.log(`FAIL home ${tag}\n- ${homeResult.fails.join('\n- ')}`);
      }
      // Open the sheet and re-check (now includes card heights + targets).
      await pg.click('#mode-change');
      await pg.waitForTimeout(700);
      const sheetVisible = await pg.evaluate(() => {
        const s = document.getElementById('sheet-mode');
        return s && !s.hidden && s.classList.contains('open');
      });
      if (!sheetVisible) {
        failed += 1;
        console.log(`FAIL sheet open ${tag}\n- #sheet-mode did not open`);
      } else {
        // Click 2v2 then Hard to prove the sticky Start updates live.
        await pg.click('.mode-card[data-mode="2v2"]');
        await pg.waitForTimeout(200);
        await pg.click('.seg-b[data-mdiff="hard"]');
        await pg.waitForTimeout(300);
        const live = await pg.evaluate(() => ({
          start: document.getElementById('mode-start')?.textContent?.trim() ?? '',
          sub: document.getElementById('home-play-sub')?.textContent?.trim() ?? '',
          canvases: [...document.querySelectorAll('canvas.mode-pv')].map((c) => ({ w: c.width, h: c.height })),
        }));
        if (live.start !== 'Start 2v2 · Hard') {
          failed += 1;
          console.log(`FAIL sheet live ${tag}\n- Start label "${live.start}" want "Start 2v2 · Hard"`);
        } else {
          console.log(`PASS sheet live ${tag}: "${live.start}" / home "${live.sub}"`);
        }
        const emptyCanvas = live.canvases.filter((c) => c.w === 0 || c.h === 0);
        if (emptyCanvas.length > 0) {
          failed += 1;
          console.log(`FAIL sheet canvas ${tag}\n- ${emptyCanvas.length} preview canvas(es) have 0 size`);
        }
        const sheetResult = await pg.evaluate(`${checkSrc}\ncheckHomeLayout()`);
        if (sheetResult.pass) {
          console.log(`PASS sheet ${tag}`);
        } else {
          failed += 1;
          console.log(`FAIL sheet ${tag}\n- ${sheetResult.fails.join('\n- ')}`);
        }
        fs.mkdirSync(SHOTS, { recursive: true });
        // Reset to a deterministic 1v1 Normal for the screenshots.
        await pg.click('.mode-card[data-mode="1v1"]');
        await pg.click('.seg-b[data-mdiff="normal"]');
        await pg.waitForTimeout(400);
        await pg.evaluate(() => {
          document.querySelector('#sheet-mode .sheet-body')?.scrollTo({ top: 0 });
          (document.activeElement)?.blur?.();
        });
        await pg.waitForTimeout(200);
        await pg.screenshot({ path: path.join(SHOTS, `sheet-${w}x${h}-${theme}.png`) });
        console.log(`shot sheet-${w}x${h}-${theme}.png`);
        await pg.keyboard.press('Escape');
        await pg.waitForTimeout(400);
        await pg.evaluate(() => { (document.activeElement)?.blur?.(); });
        await pg.waitForTimeout(200);
      }
      // Home screenshot (sheet closed) for the required pair.
      fs.mkdirSync(SHOTS, { recursive: true });
      await pg.screenshot({ path: path.join(SHOTS, `home-${w}x${h}-${theme}.png`) });
      console.log(`shot home-${w}x${h}-${theme}.png`);
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
console.log('all home layout checks passed');
