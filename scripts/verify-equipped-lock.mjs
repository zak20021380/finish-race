/**
 * verify-equipped-lock.mjs — Playwright driver for scripts/equipped-lock-check.js.
 *
 * Serves ./dist over 127.0.0.1, opens Profile, scrolls the pane to the EQUIPPED
 * section and asserts the locked-slab contract at 360x640 (and 390x844):
 *  - the three preview cards are inert (pointer-events: none) and frosted,
 *  - the obsidian scrim is the exact radial gradient, clipped to the 20px radius,
 *  - the bronze crest renders centred on the slab, pod 44x44, chip "COMING SOON" 9px/1.2px,
 *  - the overlay adds zero height, bleeds nowhere and the page never scrolls,
 *  - a tap only nudges: toast appears, the save is untouched.
 *
 * Saves .shots/equipped-lock-<w>x<h>.png. Exits 1 on any failure.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const SHOTS = path.resolve(here, '..', '.shots');
const CHECK_JS = path.resolve(here, 'equipped-lock-check.js');

const require = createRequire(path.resolve(here, '..', 'package.json'));   // playwright-core, dev-only
const { chromium } = require('playwright-core');
const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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

const checkSrc = fs.readFileSync(CHECK_JS, 'utf8');
const VIEWPORTS = [
  [360, 640],
  [390, 844],
];

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
let failed = 0;
try {
  for (const [w, h] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'dark' });
    const pg = await ctx.newPage();
    await pg.goto(base, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(1200);
    await pg.click('.dock-nav .tab[data-tab="profile"]');
    await pg.waitForTimeout(700);
    await pg.evaluate(() => {
      const pane = document.querySelector('#s-profile .pf-pane');
      if (pane) pane.scrollTop = pane.scrollHeight;
    });
    await pg.waitForTimeout(300);

    const result = await pg.evaluate(`${checkSrc}\ncheckEquippedLock()`);
    const tag = `${w}x${h}`;
    if (result.pass) {
      console.log(`PASS equipped lock ${tag}`);
    } else {
      failed += 1;
      console.log(`FAIL equipped lock ${tag}\n- ${result.fails.join('\n- ')}`);
    }

    // the check's tap summons the toast; let it fade before the clean frame
    await pg.waitForTimeout(2800);
    fs.mkdirSync(SHOTS, { recursive: true });
    await pg.screenshot({ path: path.join(SHOTS, `equipped-lock-${w}x${h}.png`) });
    console.log(`shot equipped-lock-${w}x${h}.png`);
    await ctx.close();
  }
} finally {
  await browser.close();
  srv.close();
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all equipped-lock checks passed');
