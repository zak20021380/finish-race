/**
 * verify-home-layout.mjs — Playwright driver for scripts/home-layout-check.js.
 *
 * No new project dependencies: `playwright-core` is resolved at runtime only.
 * Run without touching package.json:
 *
 *   NODE_PATH="C:\\Users\\PC-Y\\AppData\\Local\\Temp\\opencode\\check\\node_modules" node scripts/verify-home-layout.mjs
 *   # or: npx -p playwright-core node scripts/verify-home-layout.mjs
 *
 * Serves ./dist over 127.0.0.1, then checks 360x600, 360x640, 390x844, 430x932
 * in light + dark. Fails (exit 1) when:
 *  - document scrollHeight > innerHeight,
 *  - any element bottom passes the tab bar top,
 *  - any text/card is clipped (see home-layout-check.js).
 * Saves .shots/home-360x640.png on success.
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
  [360, 600],
  [360, 640],
  [390, 844],
  [430, 932],
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
      const result = await pg.evaluate(`${checkSrc}\ncheckHomeLayout()`);
      const tag = `${w}x${h} ${theme}`;
      if (result.pass) {
        console.log(`PASS ${tag}`);
      } else {
        failed += 1;
        console.log(`FAIL ${tag}\n- ${result.fails.join('\n- ')}`);
      }
      if (w === 360 && h === 640 && theme === 'light' && result.pass) {
        fs.mkdirSync(SHOTS, { recursive: true });
        await pg.screenshot({ path: path.join(SHOTS, 'home-360x640.png') });
        console.log(`shot ${path.join(SHOTS, 'home-360x640.png')}`);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  srv.close();
}

if (failed > 0) {
  console.error(`${failed} viewport(s) failed`);
  process.exit(1);
}
console.log('all home layout checks passed');
