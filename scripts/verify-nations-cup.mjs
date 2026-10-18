/**
 * verify-nations-cup.mjs — Playwright driver for scripts/nations-cup-check.js,
 * which now covers the whole 3-slide Home carousel: Channel War
 * (slide 0), Nations Cup (slide 1) and The Mind Ladder (slide 2).
 *
 * No new project dependencies: `playwright-core` is resolved at runtime only.
 *
 *   node scripts/verify-nations-cup.mjs
 *
 * Serves ./dist over 127.0.0.1, then checks 320x640, 360x640 and 390x844 in
 * light + dark, with a long country name injected on the Nations slide
 * (ellipsis, no overflow). Each viewport runs the check on ALL THREE slides —
 * dot 0 (Channel War), dot 1 (Nations Cup) and dot 2 (The Mind Ladder) — plus a
 * country-set (DE) pass and an NG pass (monogram/flag-chip fallback). Saves
 * .shots/nations-360x640-{light,dark}.png on success.
 *
 * One extra pass at 360x640 audits slide 0's interactivity headlessly: the hero
 * is the bundled telegram_stars.png (naturalWidth > 0, star-float live), the
 * enlistment pod fires its t.me bot-admin deeplink (window.open captured), and
 * the gold key lands on the Arena lobby.
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
      '  NODE_PATH="C:\\\\\\\\Users\\\\\\\\PC-Y\\\\\\\\AppData\\\\\\\\Local\\\\\\\\Temp\\\\\\\\opencode\\\\\\\\check\\\\\\\\node_modules" node scripts/verify-nations-cup.mjs',
  );
  process.exit(2);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

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

async function check(tag, w, h, theme, country, slide) {
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
  // Land on the slide under test; the dots overlay the active card, so their
  // geometry is only comparable while that card is the active one.
  await pg.click(`#home-dots .dot[data-dot="${slide}"]`);
  await pg.waitForTimeout(700);
  // Long country name on the Nations slide: the ellipse must hold, nothing may
  // spill out of the card.
  if (slide === 1) {
    await pg.evaluate((name) => {
      const nm = document.querySelector('.nations-rank .nations-row .nm');
      if (nm) {
        nm.textContent = name;
        nm.title = name;
        nm.closest('li')?.setAttribute('aria-label', `#1 ${name} — 12,840 points, rising`);
      }
    }, LONG_NAME);
    await pg.waitForTimeout(150);
  }
  const result = await pg.evaluate(`${checkSrc}\ncheckHomeCarousel()`);
  ran += 1;
  if (result.pass) {
    console.log(`PASS carousel ${tag}`);
  } else {
    failed += 1;
    console.log(`FAIL carousel ${tag}\n- ${result.fails.join('\n- ')}`);
  }
  return { ctx, pg };
}

try {
  for (const [w, h] of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const country of [null, 'DE']) {
        for (const slide of [0, 1, 2]) {
          const tag = `${w}x${h} ${theme} country=${country ?? 'unset'} slide=${slide}`;
          const { ctx } = await check(tag, w, h, theme, country, slide);
          if (w === 360 && h === 640 && !country && slide === 1) {
            fs.mkdirSync(SHOTS, { recursive: true });
            const pg = ctx.pages()[0];
            await pg.screenshot({ path: path.join(SHOTS, `nations-360x640-${theme}.png`) });
            console.log(`shot nations-360x640-${theme}.png`);
          }
          await ctx.close();
        }
      }
    }
  }
  // Flag fallback: NG has no vendored local SVG on the Nations slide, so its
  // flag resolves through the CDN cascade — the row must still render a badge.
  for (const theme of THEMES) {
    const tag = `360x640 ${theme} country=NG (flag fallback) slide=1`;
    const { ctx } = await check(tag, 360, 640, theme, 'NG', 1);
    await ctx.close();
  }

  /* ---- Channel War interaction audit: the hero asset is a real bundled PNG, and
     both CTAs answer a click — the enlistment pod fires the t.me bot-admin deeplink
     (captured by stubbing window.open), the gold key routes to the Arena. ---- */
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true });
    await ctx.addInitScript(() => {
      window.__hops = [];
      window.open = (u) => { window.__hops.push(String(u)); return null; };
    });
    const pg = await ctx.newPage();
    await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(1300);
    await pg.click('#home-dots .dot[data-dot="0"]');
    await pg.waitForTimeout(600);

    const asset = await pg.evaluate(() => {
      const img = document.querySelector('.tour-star-img');
      if (!img) return null;
      const cs = getComputedStyle(img);
      return {
        src: img.currentSrc || img.src,
        complete: img.complete,
        nw: img.naturalWidth,
        nh: img.naturalHeight,
        anim: cs.animationName,
      };
    });
    ran += 1;
    if (asset && /telegram_stars/i.test(asset.src) && asset.complete && asset.nw > 0 && asset.nh > 0) {
      console.log(`PASS hero asset — ${asset.src.split('/').pop()} ${asset.nw}x${asset.nh}, animation=${asset.anim}`);
    } else {
      failed += 1;
      console.log(`FAIL hero asset — ${JSON.stringify(asset)}`);
    }

    /* The bundle carries its own Telegram SDK shim, and in a plain browser its
       `openTelegramLink` leaves the page via location.href — so the deeplink is
       captured at the SDK boundary too, not only at the `window.open` fallback. */
    await pg.evaluate(() => {
      const w = window.Telegram && window.Telegram.WebApp;
      window.__hops = window.__hops || [];
      if (w) {
        w.openTelegramLink = (u) => { window.__hops.push(String(u)); };
        w.openLink = (u) => { window.__hops.push(String(u)); };
      }
    });

    await pg.click('#home-tournament-admin');
    await pg.waitForTimeout(250);
    const hops = await pg.evaluate(() => window.__hops || []);
    ran += 1;
    if (hops.some((u) => /^https:\/\/t\.me\/[^/]+\?startchannel/.test(u))) {
      console.log(`PASS admin enlistment deeplink — ${hops[hops.length - 1]}`);
    } else {
      failed += 1;
      console.log(`FAIL admin enlistment deeplink — hops=${JSON.stringify(hops)}`);
    }

    await pg.click('#home-tournament-cta');
    await pg.waitForTimeout(1800);
    const arena = await pg.evaluate(() => {
      const s = document.getElementById('s-arena');
      const sheet = document.getElementById('sheet-stars');
      return { arena: !!s && !s.hidden, sheet: !!sheet && !sheet.hidden && sheet.classList.contains('open') };
    });
    ran += 1;
    if (arena.arena) {
      console.log(`PASS player CTA routed to the battle lobby (seat drawer ${arena.sheet ? 'open' : 'pending'})`);
    } else {
      failed += 1;
      console.log(`FAIL player CTA — arena=${JSON.stringify(arena)}`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  srv.close();
}

if (failed > 0) {
  console.error(`${failed} of ${ran} carousel check(s) failed`);
  process.exit(1);
}
console.log(`all ${ran} carousel checks passed`);
