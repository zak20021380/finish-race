/**
 * verify-settings.mjs — Playwright verification for the Settings overhaul.
 *
 * No new project dependencies: `playwright-core` is resolved at runtime only
 * (see scripts/verify-home-layout.mjs for the NODE_PATH recipe).
 *
 * Serves ./dist over 127.0.0.1 and checks, over the real user path
 * (dock → Profile → settings key):
 *   1. exactly two Dark Clay cards (Gameplay & Audio, Community & Support);
 *   2. the Reduced-motion toggle, the App & Storage card, the reset row and
 *      the reset sheet are all gone;
 *   3. Contact Admin is present (title + subtext + pill);
 *   4. the Official Telegram Channel row behind openTelegramLink;
 *   5. Contact Admin calls window.Telegram.WebApp.openTelegramLink on the
 *      configured admin handle, and falls back to window.open on desktop
 *      (no Telegram globals);
 *   6. the Sound / Haptics switches still toggle;
 *   7. zero vertical scroll at 360x640 (page and stack alike).
 * Screenshots: .shots/settings-{w}x{h}.png · exit 1 on any failure.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const SHOTS = path.resolve(here, '..', '.shots');

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error(
    'playwright-core not found. Run with NODE_PATH pointing at a temp install, e.g.:\n' +
      '  NODE_PATH="C:\\\\Users\\\\PC-Y\\\\AppData\\\\Local\\\\Temp\\\\opencode\\\\check\\\\node_modules" node scripts/verify-settings.mjs',
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
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const CHANNEL_URL = 'https://t.me/detour_game';
const ADMIN_URL = 'https://t.me/detour_support_bot';

/** Open the settings screen along the real user path and check its shape. */
async function openSettings(pg, w, h) {
  await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1200);
  await pg.click('.dock-nav .tab[data-tab="profile"]');
  await pg.waitForTimeout(700);
  await pg.click('#profile-settings');
  await pg.waitForTimeout(700);
  const state = await pg.evaluate(() => {
    const s = document.getElementById('s-settings');
    const visible = s && !s.hidden;
    const cards = [...s.querySelectorAll('.set-card')];
    const stack = s.querySelector('.set-stack');
    return {
      visible,
      cardCount: cards.length,
      heads: cards.map((c) => (c.querySelector('.set-card-h')?.textContent ?? '').trim()),
      reducedRow: !!s.querySelector('[data-set="reducedMotion"]'),
      resetRow: !!document.getElementById('reset-row'),
      resetSheet: !!document.getElementById('sheet-reset'),
      appStorage: [...s.querySelectorAll('.set-card-h')].some((h) => /app\s*&?\s*storage/i.test(h.textContent || '')),
      adminRow: !!document.getElementById('admin-row'),
      adminTitle: s.querySelector('#admin-row .row-t')?.textContent?.trim() ?? '',
      adminSub: s.querySelector('#admin-row .row-s')?.textContent?.trim() ?? '',
      adminPill: !!s.querySelector('#admin-row .admin-pill .ico'),
      headset: !!s.querySelector('#admin-row use[href="#i-headset"]'),
      pageScroll: document.documentElement.scrollHeight - window.innerHeight,
      stackScroll: stack ? stack.scrollHeight - stack.clientHeight : 1,
      rows: [...s.querySelectorAll('.set-rows .row')].length,
    };
  });
  return state;
}

const srv = await serve();
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args: ['--no-sandbox'] });

let failed = 0;
fs.mkdirSync(SHOTS, { recursive: true });
try {
  /* ---- 360x640: the mark every rewrite must hit ---- */
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 } });
  const pg = await ctx.newPage();
  const st = await openSettings(pg, 360, 640);
  const expect = (name, ok) => {
    if (ok) console.log(`PASS ${name}`);
    else { failed += 1; console.log(`FAIL ${name}`); }
  };
  expect('settings opens from profile', st.visible);
  expect('exactly 2 cards', st.cardCount === 2);
  expect('card heads = Gameplay & Audio / Community & Support', st.heads.join('|') === 'Gameplay & Audio|Community & Support');
  expect('no Reduced motion toggle', !st.reducedRow);
  expect('no Reset Local Data row', !st.resetRow);
  expect('no App & Storage card', !st.appStorage);
  expect('reset sheet removed', !st.resetSheet);
  expect('Contact Admin row present', st.adminRow && st.adminTitle === 'Contact Admin');
  expect('Contact Admin subtext', st.adminSub === 'Direct help, inquiries & feedback');
  expect('admin chat pill with icon', st.adminPill);
  expect('tactile headset icon', st.headset);
  expect('5 rows (3 gameplay + 2 community)', st.rows === 5);
  expect('zero page scroll at 360x640', st.pageScroll <= 0);
  expect('zero stack scroll at 360x640', st.stackScroll <= 0);

  /* Telegram route: stub the WebApp and click */
  const tgCalled = await pg.evaluate(() => {
    const calls = [];
    window.Telegram = { WebApp: { openTelegramLink: (u) => { calls.push(u); } } };
    document.getElementById('admin-row').click();
    document.getElementById('tg-channel').click();
    window.Telegram = undefined;
    return { admin: calls[0], channel: calls[1] };
  });
  expect('admin row → openTelegramLink(admin)', tgCalled.admin === ADMIN_URL);
  expect('channel row → openTelegramLink(channel)', tgCalled.channel === CHANNEL_URL);

  /* Desktop fallback: no Telegram global → window.open */
  const winOpen = await pg.evaluate((oil) => {
    const calls = [];
    const old = window.open;
    window.open = (u) => { calls.push(String(u)); return null; };
    document.getElementById('admin-row').click();
    window.open = old;
    return calls[0] === oil;
  }, ADMIN_URL);
  expect('admin row → window.open fallback (desktop)', winOpen);

  /* the switches still flip (aria-checked) */
  const toggled = await pg.evaluate(() => {
    const rows = [...document.querySelectorAll('.set-rows .row[aria-checked]')];
    const before = rows.map((r) => r.getAttribute('aria-checked'));
    rows[0].click();
    const flipped = rows[0].getAttribute('aria-checked') !== before[0];
    rows[0].click();
    const restored = rows[0].getAttribute('aria-checked') === before[0];
    return flipped && restored && rows.length === 2;
  });
  expect('Sound/Haptics switches still toggle', toggled);

  await pg.screenshot({ path: path.join(SHOTS, 'settings-360x640.png') });
  console.log('shot settings-360x640.png');
  await ctx.close();

  /* ---- 430x932: the top of the range — no scroll, no dead bottom ---- */
  const ctx2 = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const pg2 = await ctx2.newPage();
  const st2 = await openSettings(pg2, 430, 932);
  expect('zero page scroll at 430x932', st2.pageScroll <= 0);
  expect('zero stack scroll at 430x932', st2.stackScroll <= 0);
  const gap = await pg2.evaluate(() => {
    const s = document.getElementById('s-settings');
    const stack = s.querySelector('.set-stack').getBoundingClientRect();
    const cards = [...s.querySelectorAll('.set-card')].map((c) => c.getBoundingClientRect());
    const gap1 = cards[0].top - stack.top;
    const gap2 = cards[1].top - cards[0].bottom;
    const gap3 = stack.bottom - cards[1].bottom;
    return { gap1: Math.round(gap1), gap2: Math.round(gap2), gap3: Math.round(gap3) };
  });
  /* the three air slots sit within a third of each other: no bottom void */
  const slots = [gap.gap1, gap.gap2, gap.gap3];
  expect(`even air (top/mid/bottom slots = ${slots.join('/')})`,
    Math.max(...slots) - Math.min(...slots) <= Math.max(...slots) / 3);
  await pg2.screenshot({ path: path.join(SHOTS, 'settings-430x932.png') });
  console.log('shot settings-430x932.png');
  await ctx2.close();
} finally {
  await browser.close();
  srv.close();
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all settings checks passed');
