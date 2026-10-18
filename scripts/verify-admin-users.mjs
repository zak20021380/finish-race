/**
 * verify-admin-users.mjs — Playwright audit for the Admin Command Center's Users tab:
 * the player directory, its search, its filter chips, and the deep inspection card
 * with the ban toggle and the two coin grants.
 *
 * Serves ./dist over 127.0.0.1 with a static `/admin/players` that answers ok:false,
 * so the panel exercises its real fallback story: the local index in `src/players.ts`
 * answers for the absent Worker. Walks the real user path: FAB → Users tab → search,
 * filter, expand, ban, unban, grant.
 *
 * Checks:
 *   1. the tab opens the directory: source chip on LOCAL INDEX, a full first page,
 *      the live seat pinned as row 0 with its YOU chip;
 *   2. the search field filters by name/handle tokens, the clear key restores the
 *      page, and a nonsense query reaches the empty state;
 *   3. the filter chips narrow the view honestly (Flagged carries only banned/muted
 *      rows, Top TIQ is sorted by the printed number, Active Today stays populated);
 *   4. a card expands into the telemetry grid, the id/stamps line, the ban key and
 *      the two coin grants — the coin count on the card moves by exactly the grant;
 *   5. the ban toggle flips the row, writes through to localStorage, and unbans;
 *   6. stage geometry stays honest at 360x640 and 430x932: zero page scroll, zero
 *      horizontal overflow, zero console errors and zero 404s.
 *
 * Run: node scripts/verify-admin-users.mjs   (playwright-core resolved at runtime)
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
      '  NODE_PATH="C:\\Users\\PC-Y\\AppData\\Local\\Temp\\opencode\\check\\node_modules" node scripts/verify-admin-users.mjs',
  );
  process.exit(2);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(String(req.url).split('?')[0]);
      if (p === '/') p = '/index.html';
      if (p === '/favicon.ico') { res.writeHead(200, { 'Content-Type': 'image/x-icon' }); res.end(); return; }
      /* the Stats/Server/Users/Controls tabs probe the live room; a static audit has none, and the
         app treats ok:false as "Local"/"Local Index" — answer so the probe and the registry reads
         are not 404s */
      if ((p === '/admin/status' || p === '/admin/players' || p.startsWith('/api/admin/'))
        && (req.method === 'GET' || req.method === 'POST')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no live worker in the static audit' }));
        return;
      }
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

/** Telegram stub installed before the bundle: src/telegram.ts binds at load. */
const TG_STUB = `
  window.__tgCalls = [];
  const push = (...a) => window.__tgCalls.push(a);
  let stub;
  try { stub = window.Telegram?.WebApp || {}; } catch { stub = {}; }
  stub.ready = stub.ready || (() => {});
  stub.expand = stub.expand || (() => {});
  stub.disableVerticalSwipes = stub.disableVerticalSwipes || (() => {});
  stub.setHeaderColor = stub.setHeaderColor || (() => {});
  stub.setBackgroundColor = stub.setBackgroundColor || (() => {});
  stub.setColorScheme = stub.setColorScheme || (() => {});
  stub.isVersionAtLeast = stub.isVersionAtLeast || (() => true);
  stub.version = stub.version || '7.2';
  stub.platform = stub.platform || 'ios';
  stub.openTelegramLink = (u) => push('tglink', u);
  stub.openLink = (u) => push('link', u);
  stub.HapticFeedback = {
    impactOccurred: (s) => push('impact', s),
    notificationOccurred: (t) => push('notify', t),
    selectionChanged: () => {},
  };
  try { Object.freeze(stub.HapticFeedback); Object.freeze(stub); } catch { /* fine */ }
  try { Object.defineProperty(window, 'Telegram', { value: { WebApp: stub }, writable: false, configurable: false }); }
  catch { window.Telegram = { WebApp: stub }; }
  try { Object.defineProperty(window, '__tgCalls', { value: window.__tgCalls, writable: true, configurable: false }); }
  catch { /* fine */ }
`;

let failed = 0;
const expect = (name, ok) => {
  if (ok) console.log(`PASS ${name}`);
  else { failed += 1; console.log(`FAIL ${name}`); }
};

/** Track every console error / page error; the audit fails if any appears. */
const errors = [];
function watch(pg, label) {
  pg.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  pg.on('response', (r) => { if (r.status() === 404) errors.push(`${label} 404: ${r.url()}`); });
}

async function boot(browser, w, h, label) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.route('**/telegram-web-app.js**', (route) =>
    route.fulfill({ status: 200, body: '', contentType: 'application/javascript' }));
  await ctx.route('**/telegram.org/js/telegram-web-app.js**', (route) =>
    route.fulfill({ status: 200, body: '', contentType: 'application/javascript' }));
  await ctx.addInitScript(TG_STUB);
  const pg = await ctx.newPage();
  watch(pg, label);
  await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1100);
  return { ctx, pg };
}

const openUsers = async (pg) => {
  await pg.click('#btn-admin-fab');
  await pg.waitForTimeout(450);
  await pg.evaluate(() => document.getElementById('atab-users').click());
  await pg.waitForTimeout(500);                 // the lazy first read + local fallback paint
};

/** The rows as the DOM holds them: the summary pieces each check reads. */
const readRows = (pg) => pg.evaluate(() => [...document.querySelectorAll('#adm-users-list .adm-user')].map((li) => ({
  id: li.dataset.uid,
  name: li.querySelector('.adm-user-n')?.textContent?.trim() ?? '',
  sub: li.querySelector('.adm-user-m')?.textContent?.trim() ?? '',
  stickers: [...li.querySelectorAll('.adm-user-st')].map((s) => s.textContent.trim()),
  banned: li.classList.contains('is-banned'),
  you: li.classList.contains('is-you'),
  open: li.classList.contains('is-open'),
  tiq: Number(((li.querySelector('.adm-user-m')?.textContent ?? '').match(/TIQ ([\d,]+)/)?.[1] ?? '-1').replace(/,/g, '')),
})));

const srv = await serve();
const port = srv.address().port;
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--no-sandbox'],
});
fs.mkdirSync(SHOTS, { recursive: true });

try {
  /* ================= 360x640: the floor mark ================= */
  const { ctx, pg } = await boot(browser, 360, 640, '360');
  await openUsers(pg);

  /* ---- 1. the directory opens ---- */
  const head = await pg.evaluate(() => ({
    source: document.getElementById('users-source').textContent.trim(),
    sourceLive: document.getElementById('users-source').dataset.live,
    total: document.getElementById('users-total').textContent.trim(),
    panel: !document.getElementById('apanel-users').hidden,
    rows: document.querySelectorAll('#adm-users-list .adm-user').length,
    more: !document.getElementById('users-more').hidden,
    emptyHidden: document.getElementById('adm-users-empty').hidden,
    scrollX: document.documentElement.scrollWidth - window.innerWidth,
    pageScroll: document.documentElement.scrollHeight - window.innerHeight,
    minRowH: Math.min(...[...document.querySelectorAll('#adm-users-list .adm-user-main')].map((b) => b.getBoundingClientRect().height)),
  }));
  expect('the Users tab lights its own panel', head.panel);
  expect('source chip reads LOCAL INDEX without a Worker', head.source === 'LOCAL INDEX' && head.sourceLive === 'false');
  expect(`a full first page lands (${head.rows} rows)`, head.rows === 40);
  expect(`the roster count is printed (${head.total})`, /\d+ players/.test(head.total));
  expect('Load More is offered while the roster has more', head.more);
  expect('the empty state is hidden with rows on screen', head.emptyHidden);
  expect(`every directory row is >= 48px (min ${Math.round(head.minRowH)}px)`, head.minRowH >= 48);
  expect('zero page scroll at 360x640', head.pageScroll <= 0);
  expect('zero horizontal overflow at 360x640', head.scrollX <= 1);

  const first = await readRows(pg);
  expect('the live seat is pinned as row 0 with its YOU chip', first[0]?.you === true && first[0]?.stickers.length === 0);
  expect('row 0 carries the live telemetry line', /TIQ \d+/.test(first[0]?.sub ?? ''));
  expect('the directory never races itself: every row id is unique',
    new Set(first.map((r) => r.id)).size === first.length);

  /* ---- 2. the search field ---- */
  const token = (first[1]?.name ?? 'A').split(/\s+/)[0].toLowerCase();
  await pg.fill('#users-q', token);
  await pg.waitForTimeout(500);
  const searched = await readRows(pg);
  expect(`search "${token}" keeps only matching rows (${searched.length})`,
    searched.length >= 1 && searched.every((r) => `${r.name} ${r.sub}`.toLowerCase().includes(token)));
  await pg.fill('#users-q', 'zzzznopezzzz');
  await pg.waitForTimeout(500);
  const emptyState = await pg.evaluate(() => ({
    rows: document.querySelectorAll('#adm-users-list .adm-user').length,
    empty: !document.getElementById('adm-users-empty').hidden,
    clearShown: !document.getElementById('users-q-clear').hidden,
  }));
  expect('a nonsense query reaches the empty state', emptyState.rows === 0 && emptyState.empty);
  expect('the clear key appears while there is a query', emptyState.clearShown);
  await pg.click('#users-q-clear');
  await pg.waitForTimeout(500);
  const cleared = await pg.evaluate(() => ({
    value: document.getElementById('users-q').value,
    rows: document.querySelectorAll('#adm-users-list .adm-user').length,
    clearHidden: document.getElementById('users-q-clear').hidden,
  }));
  expect('the clear key restores the full page', cleared.value === '' && cleared.rows === 40 && cleared.clearHidden);

  /* ---- 3. the filter chips ---- */
  await pg.evaluate(() => document.querySelector('[data-ufilter="flagged"]').click());
  await pg.waitForTimeout(500);
  const flagged = await readRows(pg);
  expect(`Flagged carries only banned or muted rows (${flagged.length})`,
    flagged.length >= 1 && flagged.every((r) => r.banned || r.stickers.some((s) => s === 'BANNED' || s === 'MUTED')));
  await pg.evaluate(() => document.querySelector('[data-ufilter="tiq"]').click());
  await pg.waitForTimeout(500);
  const top = await readRows(pg);
  expect(`Top TIQ sorts by the printed number (${top[0]?.tiq} → ${top[1]?.tiq})`,
    top.length === 40 && top.every((r, i) => i === 0 || top[i - 1].tiq >= r.tiq));
  await pg.evaluate(() => document.querySelector('[data-ufilter="active"]').click());
  await pg.waitForTimeout(500);
  const active = await readRows(pg);
  expect(`Active Today stays populated (${active.length} rows)`, active.length >= 1);
  await pg.evaluate(() => document.querySelector('[data-ufilter="all"]').click());
  await pg.waitForTimeout(500);

  /* ---- 4. the deep inspection card ---- */
  await pg.evaluate(() => document.querySelectorAll('#adm-users-list .adm-user-main')[1].click());
  await pg.waitForTimeout(300);
  const card = await pg.evaluate(() => {
    const li = document.querySelector('#adm-users-list .adm-user.is-open');
    if (!li) return null;
    return {
      cells: li.querySelectorAll('.adm-user-cells .adm-stat').length,
      idLine: li.querySelector('.adm-user-id')?.textContent ?? '',
      banLabel: li.querySelector('.adm-uban')?.textContent?.trim() ?? '',
      banPressed: li.querySelector('.adm-uban')?.getAttribute('aria-pressed'),
      coins: li.querySelector('.adm-user-wallet b')?.textContent?.trim() ?? '',
      grants: [...li.querySelectorAll('.adm-ugrant')].map((b) => b.textContent.trim()),
      coinsSvg: li.querySelectorAll('.adm-ugrant .coin svg').length,
      live: li.classList.contains('is-live'),
    };
  });
  expect('the card expands into the telemetry grid', !!card && card.cells === 8);
  expect('the id/stamps line carries the seat id', /^id .+ · first seen .+ · last seen .+/.test(card.idLine));
  expect('the ban key starts on Ban Player', card.banLabel === 'Ban Player' && card.banPressed === 'false');
  expect('the two coin grants are offered', card.grants.length === 2 && card.grants[0].startsWith('+100') && card.grants[1].startsWith('+500'));
  expect('each grant carries the shared coin graphic', card.coinsSvg === 2);

  /* ---- 5. grant coins, ban, unban ---- */
  const coinsBefore = Number(card.coins.replace(/[^\d]/g, ''));
  await pg.click('#adm-users-list .adm-user.is-open .adm-ugrant[data-ugrant="500"]');
  await pg.waitForTimeout(700);
  const afterGrant = await pg.evaluate(() => {
    const li = document.querySelector('#adm-users-list .adm-user.is-open');
    return {
      coins: Number((li.querySelector('.adm-user-wallet b')?.textContent ?? '0').replace(/[^\d]/g, '')),
      id: li.dataset.uid,
      toast: window.__tgCalls.some(([k, t]) => k === 'notify' && t === 'success'),
    };
  });
  expect(`a +500 grant moves the wallet by exactly 500 (${coinsBefore} → ${afterGrant.coins})`,
    afterGrant.coins === coinsBefore + 500);
  expect('the grant fires the success toast', afterGrant.toast);

  await pg.click('#adm-users-list .adm-user.is-open .adm-uban');
  await pg.waitForTimeout(700);
  const banned = await pg.evaluate((id) => {
    const li = document.querySelector('#adm-users-list .adm-user.is-open');
    const raw = JSON.parse(localStorage.getItem('detour.players.v1') ?? 'null');
    const row = raw?.players?.find((p) => p.id === id) ?? null;
    return {
      label: li?.querySelector('.adm-uban')?.textContent?.trim(),
      pressed: li?.querySelector('.adm-uban')?.getAttribute('aria-pressed'),
      rowBanned: li?.classList.contains('is-banned'),
      sticker: [...(li?.querySelectorAll('.adm-user-st') ?? [])].map((s) => s.textContent.trim()),
      stored: row ? row.banned === true && row.muted === true : false,
      localIndex: document.getElementById('users-source').textContent.trim(),
    };
  }, afterGrant.id);
  expect('banning flips the key to Unban Player', banned.label === 'Unban Player' && banned.pressed === 'true');
  expect('the row wears the BANNED sticker and the red slab', banned.rowBanned && banned.sticker.includes('BANNED'));
  expect('the ban is written through to the local index', banned.stored);
  expect('moderation stays on the LOCAL INDEX without a Worker', banned.localIndex === 'LOCAL INDEX');

  await pg.click('#adm-users-list .adm-user.is-open .adm-uban');
  await pg.waitForTimeout(700);
  const unbanned = await pg.evaluate((id) => {
    const li = document.querySelector('#adm-users-list .adm-user.is-open');
    const raw = JSON.parse(localStorage.getItem('detour.players.v1') ?? 'null');
    const row = raw?.players?.find((p) => p.id === id) ?? null;
    return {
      label: li?.querySelector('.adm-uban')?.textContent?.trim(),
      rowBanned: li?.classList.contains('is-banned'),
      stored: row?.banned ?? true,
    };
  }, afterGrant.id);
  expect('unbanning restores the row', unbanned.label === 'Ban Player' && !unbanned.rowBanned && unbanned.stored === false);

  /* the filter chips follow the moderation: Flagged is a live view, not a snapshot */
  await pg.evaluate(() => document.querySelector('[data-ufilter="flagged"]').click());
  await pg.waitForTimeout(500);
  const flaggedAfter = await readRows(pg);
  expect('the unbanned row leaves the Flagged view', flaggedAfter.every((r) => r.id !== afterGrant.id));
  await pg.evaluate(() => document.querySelector('[data-ufilter="all"]').click());
  await pg.waitForTimeout(500);

  await pg.screenshot({ path: path.join(SHOTS, 'admin-users-360x640.png') });
  console.log('shot admin-users-360x640.png');
  await ctx.close();

  /* ================= 430x932: the ceiling mark ================= */
  const { ctx: ctx2, pg: pg2 } = await boot(browser, 430, 932, '430');
  await openUsers(pg2);
  const big = await pg2.evaluate(() => ({
    rows: document.querySelectorAll('#adm-users-list .adm-user').length,
    scrollX: document.documentElement.scrollWidth - window.innerWidth,
    pageScroll: document.documentElement.scrollHeight - window.innerHeight,
    bodyTop: Math.round(document.querySelector('.admin-body').getBoundingClientRect().top),
    navTop: Math.round(document.querySelector('.admin-nav').getBoundingClientRect().top),
  }));
  expect(`the directory fills at 430x932 (${big.rows} rows)`, big.rows === 40);
  expect('zero horizontal overflow at 430x932', big.scrollX <= 1);
  expect('zero page scroll at 430x932', big.pageScroll <= 0);
  expect('the dock stays pinned under the body at 430x932', big.navTop >= big.bodyTop);

  await pg2.evaluate(() => document.querySelectorAll('#adm-users-list .adm-user-main')[0].click());
  await pg2.waitForTimeout(250);
  await pg2.screenshot({ path: path.join(SHOTS, 'admin-users-430x932.png') });
  console.log('shot admin-users-430x932.png');
  await ctx2.close();
} finally {
  await browser.close();
  srv.close();
}

expect(`zero console/page errors (${errors.length})`, errors.length === 0);
for (const e of errors) console.log(`  ${e}`);

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all admin users checks passed');
