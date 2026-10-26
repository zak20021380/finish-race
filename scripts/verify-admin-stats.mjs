/**
 * verify-admin-stats.mjs — Playwright audit for the Admin Command Center's Stats tab.
 *
 * Serves ./dist over 127.0.0.1, stubs `GET /api/admin/metrics` with a payload the Worker really
 * frames, and walks the real user path: FAB → Command Center → Stats.
 *
 * Checks:
 *   1. the header: amber COMMAND CENTER kicker, embossed title and the sculpted close key;
 *   2. the authenticated read: the Mini App initData rides the metrics request, and every KPI and
 *      counter renders the payload — concurrency (activeRooms + queueLength), population
 *      (totalUsers / telegramUsers), matches, referrals, mines, logs, ping and environment;
 *   3. loading: a delayed read holds SYNCING, spins the refresh key and marks the panel aria-busy;
 *   4. 403 / 401: the Unauthorized Admin Access card replaces the board and no local or demo
 *      figure is substituted;
 *   5. outage: a 5xx with no reading shows OFFLINE, while a lost feed after a good read keeps the
 *      last genuine figures and marks them STALE;
 *   6. the 30s beat is installed and refreshes the visible Stats tab through the same door;
 *   7. close and reopen: focus returns to the FAB, and a fresh open reads the door again;
 *   8. layout at 360x640 and 430x932: no horizontal overflow, two-up KPI tiles, pinned chrome;
 *   9. zero script errors or warnings across the run (the induced 401/403/5xx resource errors are
 *      the point of the audit and are not application exceptions).
 *
 * Run: node scripts/verify-admin-stats.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DIST = path.join(ROOT, 'dist');
const SHOTS = path.join(ROOT, '.shots');

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core not found. Install it (or point NODE_PATH at an install) and retry.');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

/** A static dist server with the two public client feeds the app probes at boot. */
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(String(req.url).split('?')[0]);
      if (p === '/') p = '/index.html';
      if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (p === '/api/client/announcements/active') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }
      if (p === '/api/client/arena/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      if (p === '/admin/status' || (p.startsWith('/api/admin/') && p !== '/api/admin/metrics')) {
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

const INIT_DATA = 'auth_date=1761400000&user=%7B%22id%22%3A1350508522%2C%22first_name%22%3A%22Operator%22%7D&hash=deadbeef';

/** The exact frame `GET /api/admin/metrics` returns, plus the edge's round-trip ping. */
const METRICS = {
  ok: true,
  timestamp: 1761400000000,
  environment: 'production',
  pingMs: 42,
  activeRooms: 4,
  queueLength: 3,
  active1v1: 4,
  totalUsers: 1204,
  telegramUsers: 1180,
  matchesCompleted: 9876,
  minesPlaced: 12345,
  logsSpawned: 678,
  referrals: 57,
  referringPlayers: 23,
};

/** Telegram stub installed before the bundle: src/telegram.ts binds at load. */
const TG_STUB = `
  window.__tgCalls = [];
  const push = (...a) => window.__tgCalls.push(a);
  let stub;
  try { stub = window.Telegram?.WebApp || {}; } catch { stub = {}; }
  stub.initData = ${JSON.stringify(INIT_DATA)};
  stub.initDataUnsafe = { user: { id: 1350508522, first_name: 'Operator' } };
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
  window.__intervals = [];
  const realInterval = window.setInterval;
  window.setInterval = (fn, ms, ...args) => {
    window.__intervals.push({ fn, ms });
    return realInterval(fn, ms, ...args);
  };
`;

let metricsMode = 'ok';      // ok | 401 | 403 | 500 | abort
let metricsDelay = 0;
let sentInitData = '';

let failed = 0;
const expect = (name, ok, extra = '') => {
  if (ok) console.log(`PASS ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${extra ? ` :: ${extra}` : ''}`); }
};

/** Track script faults and unexpected network misses; induced refusals are expected. */
const problems = [];
function watch(pg, label) {
  pg.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
  pg.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'warning') problems.push(`${label} warning: ${text}`);
    else if (m.type() === 'error' && !text.includes('Failed to load resource')) {
      problems.push(`${label} error: ${text}`);
    }
  });
  pg.on('response', (r) => { if (r.status() === 404) problems.push(`${label} 404: ${r.url()}`); });
}

async function boot(browser, port, w, h, label) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.route('**/telegram-web-app.js**', (route) =>
    route.fulfill({ status: 200, body: '', contentType: 'application/javascript' }));
  await ctx.route('**/telegram.org/**', (route) =>
    route.fulfill({ status: 200, body: '', contentType: 'application/javascript' }));
  await ctx.addInitScript(TG_STUB);
  await ctx.route('**/api/admin/metrics', async (route) => {
    sentInitData = route.request().headers()['x-telegram-init-data'] ?? '';
    if (metricsDelay) await new Promise((r) => setTimeout(r, metricsDelay));
    if (metricsMode === 'abort') return route.abort('failed');
    if (metricsMode === '401' || metricsMode === '403' || metricsMode === '500') {
      return route.fulfill({
        status: Number(metricsMode),
        contentType: 'application/json',
        body: JSON.stringify({ error: 'induced audit refusal' }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(METRICS) });
  });
  const pg = await ctx.newPage();
  watch(pg, label);
  await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#btn-admin-fab', { state: 'visible', timeout: 20000 });
  await pg.waitForTimeout(700);
  return { ctx, pg };
}

const openAdmin = async (pg) => {
  await pg.click('#btn-admin-fab');
  await pg.waitForTimeout(450);
};

const waitLive = (pg) => pg.waitForFunction(
  () => document.getElementById('stat-conn')?.textContent?.trim() === 'LIVE',
  undefined,
  { timeout: 5000 },
);

const readDashboard = (pg) => pg.evaluate(() => {
  const t = (id) => document.getElementById(id)?.textContent?.trim() ?? '';
  return {
    active: t('stat-active'),
    liveRooms: t('stat-live-rooms'),
    dot: document.getElementById('stat-live-dot')?.dataset.live,
    players: t('stat-players'),
    dau: t('stat-dau'),
    matches: t('stat-matches'),
    modes: t('stat-modes'),
    referrals: t('stat-referrals'),
    referrers: t('stat-referrers'),
    duelP: t('stat-mode-1v1-p'),
    arenaP: t('stat-mode-arena-p'),
    mines: t('stat-mines'),
    logs: t('stat-logs'),
    refPlayers: t('stat-ref-players'),
    lat: t('stat-lat'),
    env: t('stat-env'),
    health: t('stat-health-chip'),
    conn: t('stat-conn'),
    updated: t('stat-updated'),
    alertHidden: document.getElementById('stat-alert')?.hidden,
    alertTitle: t('stat-alert-title'),
    alertBody: t('stat-alert-body'),
    busy: document.getElementById('stat-refresh')?.dataset.busy,
    ariaBusy: document.querySelector('[data-apanel="stats"]')?.getAttribute('aria-busy'),
    device: t('stat-device'),
  };
});

const srv = await serve();
const port = srv.address().port;
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--no-sandbox'],
});
fs.mkdirSync(SHOTS, { recursive: true });

try {
  /* ================= 360x640: the floor mark ================= */
  const { ctx, pg } = await boot(browser, port, 360, 640, '360');
  await openAdmin(pg);
  await waitLive(pg);

  /* ---- 1. header ---- */
  const head = await pg.evaluate(() => {
    const overlay = document.getElementById('overlay-admin');
    const kicker = overlay.querySelector('.admin-kicker');
    const title = overlay.querySelector('.admin-title');
    const closeBtn = document.getElementById('admin-close');
    const cs = closeBtn ? getComputedStyle(closeBtn) : null;
    const ks = kicker ? getComputedStyle(kicker) : null;
    return {
      devBadge: overlay.textContent.includes('DEV MODE') || !!document.getElementById('admin-badge'),
      kicker: kicker?.textContent?.trim() ?? '',
      kickerColor: ks?.color ?? '',
      kickerSpacing: ks ? parseFloat(ks.letterSpacing) : 0,
      title: title?.textContent?.trim() ?? '',
      closeW: closeBtn ? Math.round(closeBtn.getBoundingClientRect().width) : 0,
      closeH: closeBtn ? Math.round(closeBtn.getBoundingClientRect().height) : 0,
      closeRadius: cs ? parseFloat(cs.borderRadius) : 0,
      closeIcon: !!closeBtn?.querySelector('svg use[href="#i-close"]'),
      closeLabel: closeBtn?.getAttribute('aria-label') ?? '',
    };
  });
  expect('the DEV MODE badge is absent', !head.devBadge);
  expect('the COMMAND CENTER kicker keeps its amber tracking',
    head.kicker === 'COMMAND CENTER' && head.kickerSpacing >= 1.2 && head.kickerColor.startsWith('rgb(252, 211, 77)'));
  expect('the embossed Tactix Admin title is intact', head.title === 'Tactix Admin');
  expect('the sculpted 38x38 close key is present',
    head.closeW === 38 && head.closeH === 38 && head.closeRadius >= 10
    && head.closeIcon && head.closeLabel === 'Close Admin Command Center');

  /* ---- 2. authenticated live read ---- */
  const first = await readDashboard(pg);
  expect('the metrics request carries the active Telegram initData', sentInitData === INIT_DATA, sentInitData);
  expect('Live Concurrency = activeRooms + queueLength', first.active === '7', first.active);
  expect('concurrency breaks out rooms and queue', first.liveRooms === '4 rooms · 3 queued', first.liveRooms);
  expect('the live dot is lit', first.dot === 'true', first.dot);
  expect('Total Players shows totalUsers', first.players === '1,204', first.players);
  expect('the player subline shows telegramUsers', first.dau === '1,180 Telegram', first.dau);
  expect('Matches Completed shows matchesCompleted', first.matches === '9,876', first.matches);
  expect('the match subline shows active1v1', first.modes === '4 live 1v1', first.modes);
  expect('Referral Joins shows referrals', first.referrals === '57', first.referrals);
  expect('the referral subline shows referringPlayers', first.referrers === '23 referrers', first.referrers);
  expect('the live board mix shows the 1v1 count', first.duelP === '4 · 100%', first.duelP);
  expect('the live board mix shows the multi-seat count', first.arenaP === '0 · 0%', first.arenaP);
  expect('gameplay counters show mines', first.mines === '12,345', first.mines);
  expect('gameplay counters show logs', first.logs === '678', first.logs);
  expect('gameplay counters show referring players', first.refPlayers === '23', first.refPlayers);
  expect('health shows the real round trip', first.lat === '42 ms', first.lat);
  expect('health shows the environment', first.env === 'production', first.env);
  expect('the health chip reads ONLINE', first.health === 'ONLINE', first.health);
  expect('the connection lamp reads LIVE', first.conn === 'LIVE', first.conn);
  expect('the stamp names the reading time', /^Updated \d{2}:\d{2}:\d{2}$/.test(first.updated), first.updated);
  expect('no alert rides a good reading', first.alertHidden === true);
  expect('the refresh key is idle after a read', first.busy === 'false', first.busy);
  expect('the panel is not aria-busy after a read', first.ariaBusy === 'false', first.ariaBusy);
  expect('the device footnote is labelled as local',
    /^Device today: \d+ sessions · \d+ races · \d+ coins/.test(first.device), first.device);

  await pg.screenshot({ path: path.join(SHOTS, 'admin-stats-live-360x640.png') });

  /* ---- 3. loading ---- */
  metricsDelay = 450;
  await pg.click('#stat-refresh');
  await pg.waitForTimeout(100);
  const loading = await readDashboard(pg);
  expect('a delayed read shows SYNCING', loading.conn === 'SYNCING', loading.conn);
  expect('a delayed read spins the key', loading.busy === 'true', loading.busy);
  expect('a delayed read marks the panel aria-busy', loading.ariaBusy === 'true', loading.ariaBusy);
  await pg.waitForTimeout(650);
  const landed = await readDashboard(pg);
  expect('the delayed read lands live', landed.conn === 'LIVE' && landed.active === '7', landed.conn);
  metricsDelay = 0;

  /* ---- 4. refusals ---- */
  metricsMode = '403';
  await pg.click('#stat-refresh');
  await pg.waitForTimeout(250);
  const denied = await readDashboard(pg);
  await pg.screenshot({ path: path.join(SHOTS, 'admin-stats-locked-360x640.png') });
  expect('403 shows the Unauthorized Admin Access card',
    denied.alertHidden === false && denied.alertTitle === 'Unauthorized Admin Access', denied.alertTitle);
  expect('403 blanks every live counter',
    ['active', 'players', 'matches', 'referrals', 'mines', 'logs', 'lat', 'env', 'refPlayers']
      .every((k) => denied[k] === '—'),
    JSON.stringify({ active: denied.active, players: denied.players, matches: denied.matches, lat: denied.lat }));
  expect('403 substitutes no local or demo figure',
    denied.active === '—' && denied.players === '—' && denied.matches === '—');
  expect('403 marks the lamp and health LOCKED',
    denied.conn === 'LOCKED' && denied.health === 'LOCKED', `${denied.conn}/${denied.health}`);
  expect('403 explains the operator door', /operator Telegram account|metrics operator/.test(denied.alertBody), denied.alertBody);

  metricsMode = '401';
  await pg.click('#stat-refresh');
  await pg.waitForTimeout(250);
  const denied401 = await readDashboard(pg);
  expect('401 shows the same Unauthorized card',
    denied401.alertHidden === false && denied401.alertTitle === 'Unauthorized Admin Access', denied401.alertTitle);
  expect('401 keeps the board blank', denied401.active === '—' && denied401.conn === 'LOCKED',
    `${denied401.active}/${denied401.conn}`);

  /* ---- 5. outage, then a stale genuine reading ---- */
  metricsMode = '500';
  await pg.click('#stat-refresh');
  await pg.waitForTimeout(250);
  const offline = await readDashboard(pg);
  expect('500 with no reading shows Live Telemetry Unreachable',
    offline.alertHidden === false && offline.alertTitle === 'Live Telemetry Unreachable', offline.alertTitle);
  expect('500 with no reading shows OFFLINE', offline.conn === 'OFFLINE', offline.conn);
  expect('500 with no reading keeps the board blank', offline.active === '—' && offline.players === '—');

  metricsMode = 'ok';
  await pg.click('#stat-refresh');
  await waitLive(pg);
  const recovered = await readDashboard(pg);
  expect('a recovery lands a live reading again',
    recovered.conn === 'LIVE' && recovered.active === '7' && recovered.alertHidden === true, recovered.conn);

  metricsMode = 'abort';
  await pg.click('#stat-refresh');
  await pg.waitForTimeout(300);
  const stale = await readDashboard(pg);
  expect('a lost feed shows the Unreachable card',
    stale.alertHidden === false && stale.alertTitle === 'Live Telemetry Unreachable', stale.alertTitle);
  expect('a lost feed keeps the last genuine figures',
    stale.active === '7' && stale.players === '1,204' && stale.matches === '9,876',
    `${stale.active}/${stale.players}/${stale.matches}`);
  expect('a kept reading is marked STALE, not live',
    stale.conn === 'STALE' && stale.health === 'STALE', `${stale.conn}/${stale.health}`);
  expect('the stale card names the last reading time',
    /last genuine reading at \d{2}:\d{2}:\d{2}/.test(stale.alertBody), stale.alertBody);

  /* ---- 6. the 30s beat ---- */
  const hasBeat = await pg.evaluate(() => window.__intervals.some((i) => i.ms === 30000));
  expect('a 30s telemetry beat is installed', hasBeat);
  metricsMode = '403';
  const beforeBeat = sentInitData;
  await pg.evaluate(() => window.__intervals.filter((i) => i.ms === 30000).forEach((i) => i.fn()));
  await pg.waitForTimeout(300);
  const beat = await readDashboard(pg);
  expect('the beat refreshes the visible Stats tab through the same door',
    sentInitData === beforeBeat && beat.conn === 'LOCKED' && beat.alertTitle === 'Unauthorized Admin Access',
    `${beat.conn}/${beat.alertTitle}`);

  /* ---- 7. close and reopen ---- */
  metricsMode = 'ok';
  await pg.click('#admin-close');
  await pg.waitForTimeout(500);
  const closed = await pg.evaluate(() => ({
    hidden: document.getElementById('overlay-admin').hidden,
    openClass: document.getElementById('overlay-admin').classList.contains('open'),
    docClass: document.documentElement.className.includes('admin-open'),
    focusBack: document.activeElement?.id ?? '',
    homeShown: !!document.querySelector('[data-tab="home"]'),
  }));
  expect('the close key dismisses the Command Center cleanly',
    closed.hidden && !closed.openClass && !closed.docClass && closed.focusBack === 'btn-admin-fab');
  expect('Home is still underneath after the close', closed.homeShown);

  await openAdmin(pg);
  await waitLive(pg);
  const reopened = await readDashboard(pg);
  expect('a fresh open reads the door again', reopened.conn === 'LIVE' && reopened.active === '7', reopened.conn);
  await ctx.close();

  /* ---- 8. layout at the floor mark ---- */
  const { ctx: ctxNarrow, pg: pgNarrow } = await boot(browser, port, 360, 640, '360-layout');
  await openAdmin(pgNarrow);
  await waitLive(pgNarrow);
  const narrow = await pgNarrow.evaluate(() => {
    const overlay = document.getElementById('overlay-admin');
    const body = overlay.querySelector('.admin-body');
    const panel = overlay.querySelector('[data-apanel="stats"]');
    const bar = document.getElementById('stat-livebar').getBoundingClientRect();
    const cards = [...panel.querySelectorAll('.adm-card')].map((c) => Math.round(c.getBoundingClientRect().width));
    const wide = [...overlay.querySelectorAll('*')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > window.innerWidth + 1 || r.right > window.innerWidth + 1;
    });
    return {
      bodyScrollable: body.scrollHeight > body.clientHeight,
      bodyOverflowY: getComputedStyle(body).overflowY,
      bodyPadBottom: Math.round(parseFloat(getComputedStyle(body).paddingBottom)),
      pageScroll: document.documentElement.scrollHeight - window.innerHeight,
      pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
      wideElCount: wide.length,
      barW: Math.round(bar.width),
      barH: Math.round(bar.height),
      panelW: Math.round(panel.getBoundingClientRect().width),
      cards,
    };
  });
  expect('the dashboard scrolls between the pinned chrome at 360x640',
    narrow.bodyScrollable && narrow.bodyOverflowY === 'auto');
  expect('the body keeps its 80px dock tail', narrow.bodyPadBottom === 80, String(narrow.bodyPadBottom));
  expect('zero page scroll at 360x640', narrow.pageScroll <= 0, String(narrow.pageScroll));
  expect('zero horizontal overflow at 360x640', narrow.pageOverflowX <= 0 && narrow.wideElCount === 0,
    JSON.stringify(narrow));
  expect('the live bar spans the panel at 360x640',
    narrow.barW >= narrow.panelW - 2 && narrow.barH >= 40, JSON.stringify(narrow));
  expect('the four KPI tiles stay two-up at the floor mark',
    narrow.cards.length === 4 && Math.min(...narrow.cards) >= 140, JSON.stringify(narrow.cards));
  await ctxNarrow.close();

  /* ---- 8b. layout at the ceiling mark ---- */
  const { ctx: ctxBig, pg: pgBig } = await boot(browser, port, 430, 932, '430');
  await openAdmin(pgBig);
  await waitLive(pgBig);
  const big = await pgBig.evaluate(() => {
    const overlay = document.getElementById('overlay-admin');
    const headEl = overlay.querySelector('.admin-head').getBoundingClientRect();
    const body = overlay.querySelector('.admin-body');
    const nav = overlay.querySelector('.admin-nav').getBoundingClientRect();
    body.scrollTop = body.scrollHeight;
    let lowest = -Infinity;
    for (const el of overlay.querySelector('[data-apanel="stats"]').querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.height > 0) lowest = Math.max(lowest, r.bottom);
    }
    const tail = Math.round(nav.top - lowest);
    body.scrollTop = 0;
    const cards = [...overlay.querySelectorAll('.adm-card')].map((c) => Math.round(c.getBoundingClientRect().width));
    return {
      headTop: Math.round(headEl.top),
      navBottom: Math.round(nav.bottom),
      vh: window.innerHeight,
      pageScroll: document.documentElement.scrollHeight - window.innerHeight,
      pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
      tail,
      minCardW: Math.min(...cards),
    };
  });
  expect('header pinned at the stage top at 430x932', big.headTop >= 8, String(big.headTop));
  expect('dock pinned at the bottom at 430x932', big.navBottom >= big.vh - 40 && big.navBottom <= big.vh,
    `${big.navBottom}/${big.vh}`);
  expect('the dashboard tail clears the dock at 430x932', big.tail >= 0, String(big.tail));
  expect('zero page scroll at 430x932', big.pageScroll <= 0, String(big.pageScroll));
  expect('zero horizontal overflow at 430x932', big.pageOverflowX <= 0, String(big.pageOverflowX));
  expect('the four KPI tiles sit two-up with no squeezed column', big.minCardW >= 160, String(big.minCardW));
  await pgBig.screenshot({ path: path.join(SHOTS, 'admin-stats-live-430x932.png') });
  await ctxBig.close();
} finally {
  await browser.close();
  srv.close();
}

expect(`zero script errors/warnings and no page errors (${problems.length})`, problems.length === 0);
for (const p of problems) console.log(`  ${p}`);

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all admin stats checks passed');
