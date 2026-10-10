/**
 * verify-nations-cup.mjs — Playwright driver for scripts/nations-cup-check.js.
 *
 * No new project dependencies: `playwright-core` is resolved at runtime only.
 * Run without touching package.json:
 *
 *   NODE_PATH="C:\\Users\\PC-Y\\AppData\\Local\\Temp\\opencode\\check\\node_modules" node scripts/verify-nations-cup.mjs
 *
 * Serves ./dist over 127.0.0.1, then checks 320x640, 360x640 and 390x844 in
 * light + dark, with a long country name injected (ellipsis, no overflow):
 * country unset (CTA footer) and country set to DE (4th user row, real rank),
 * plus an NG pass (monogram fallback for the unvendored flag).
 * Saves .shots/nations-360x640-{light,dark}.png on success.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const SHOTS = path.resolve(here, '..', '.shots');
const CHECK_JS = path.resolve(here, 'nations-cup-check.js');

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error(
    'playwright-core not found. Run with NODE_PATH pointing at a temp install, e.g.:\n' +
      '  NODE_PATH="C:\\\\Users\\\\PC-Y\\\\AppData\\\\Local\\\\Temp\\\\opencode\\\\check\\\\node_modules" node scripts/verify-nations-cup.mjs',
  );
  process.exit(2);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

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
  [320, 640],
  [360, 640],
  [390, 844],
];
const THEMES = ['light', 'dark'];
const LONG_NAME = 'Antigua and Barbuda Is A Very Long Country Name For Ellipsis';

const checkSrc = fs.readFileSync(CHECK_JS, 'utf8');

const srv = await serve();
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

let failed = 0;
let ran = 0;

async function check(tag, w, h, theme, country) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
  if (country) {
    await ctx.addInitScript((code) => {
      try {
        window.localStorage.setItem('detour.save.v2', JSON.stringify({ v: 2, country: code }));
      } catch { /* stay in memory */ }
    }, country);
  } else {
    await ctx.addInitScript(() => {
      try {
        window.localStorage.removeItem('detour.save.v2');
      } catch { /* stay in memory */ }
    });
  }
  const pg = await ctx.newPage();
  await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1300);
  // Bring the Nations Cup slide into view: the dots overlay the active card,
  // so they are only comparable to the nations card while it is active.
  await pg.click('#home-dots .dot[data-dot="1"]');
  await pg.waitForTimeout(700);
  // Long country name: ellipsis must hold, nothing may spill out of the card.
  await pg.evaluate((name) => {
    const nm = document.querySelector('.nations-rank .nations-row .nm');
    if (nm) {
      nm.textContent = name;
      nm.title = name;
      nm.closest('li')?.setAttribute('aria-label', `#1 ${name} — 12,840 points, rising`);
    }
  }, LONG_NAME);
  await pg.waitForTimeout(150);
  const result = await pg.evaluate(`${checkSrc}\ncheckNationsCup()`);
  ran += 1;
  if (result.pass) {
    console.log(`PASS nations ${tag}`);
  } else {
    failed += 1;
    console.log(`FAIL nations ${tag}\n- ${result.fails.join('\n- ')}`);
  }
  return { ctx, pg };
}

try {
  for (const [w, h] of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const country of [null, 'DE']) {
        const tag = `${w}x${h} ${theme} country=${country ?? 'unset'}`;
        const { ctx } = await check(tag, w, h, theme, country);
        // Required screenshot: 360x640, CTA state (the clipped "Represent Your
        // Flag" case), after the long-name injection to prove the ellipsis.
        if (w === 360 && h === 640 && !country) {
          fs.mkdirSync(SHOTS, { recursive: true });
          const pg = ctx.pages()[0];
          await pg.screenshot({ path: path.join(SHOTS, `nations-360x640-${theme}.png`) });
          console.log(`shot nations-360x640-${theme}.png`);
        }
        await ctx.close();
      }
    }
  }
  // Monogram fallback: NG is not vendored — the user row must show initials,
  // never the 2-letter box, with no overflow.
  for (const theme of THEMES) {
    const tag = `360x640 ${theme} country=NG (monogram fallback)`;
    const { ctx } = await check(tag, 360, 640, theme, 'NG');
    await ctx.close();
  }
} finally {
  await browser.close();
  srv.close();
}

if (failed > 0) {
  console.error(`${failed} of ${ran} nations-cup check(s) failed`);
  process.exit(1);
}
console.log(`all ${ran} nations-cup checks passed`);
