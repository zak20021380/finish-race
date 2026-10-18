/**
 * verify-admin-stats.mjs — Playwright audit for the Admin Command Center's refined header
 * and the expanded Stats analytics dashboard.
 *
 * Serves ./dist over 127.0.0.1 and walks the real user path: FAB → Command Center → Stats.
 *
 * Checks:
 *   1. the header: zero DEV MODE badge anywhere, amber kicker + embossed title on the left,
 *      the close key is a 38x38 sculpted dark-clay pill (rim light, bevel, spring press);
 *   2. the timeframe rail: four pills [Today, 7 Days, 30 Days, All Time], the active one the
 *      raised gold key, and every KPI recomputes when the window changes (with a haptic);
 *   3. the dashboard renders: Active Now + live rooms with a pulsing dot, Total Players + DAU
 *      delta, Matches Completed split 1v1 vs Arena, Coin Volume with the Stars pool, the
 *      proportional mode bar, match telemetry (duration / bot backfill / draw rate), system
 *      health (DO tick latency / disconnect rate) and the nation meters;
 *   4. close dismisses the stage cleanly, back on Home with focus returned to the FAB;
 *   5. layout: header pinned top, dock pinned bottom, body scrolls between them with the
 *      dashboard's tail clearing the dock, zero horizontal overflow and zero page scroll
 *      at 360x640 and 430x932;
 *   6. zero console errors or warnings across the whole run.
 *
 * Run: NODE_PATH=<playwright-core install> node scripts/verify-admin-stats.mjs
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
      '  NODE_PATH="C:\\Users\\PC-Y\\AppData\\Local\\Temp\\opencode\\check\\node_modules" node scripts/verify-admin-stats.mjs',
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
      /* the Stats/Server/Controls tabs probe the live room; a static audit has none, and the
         app itself treats ok:false as "Local" — answer so the probe and the registry reads are
         not 404s */
      if ((p === '/admin/status' || p.startsWith('/api/admin/'))
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

/** Track every console error / warning / page error; the audit fails if any appears. */
const problems = [];
function watch(pg, label) {
  pg.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
  pg.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${label} ${m.type()}: ${m.text()}`);
  });
  pg.on('response', (r) => { if (r.status() === 404) problems.push(`${label} 404: ${r.url()}`); });
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

const openAdmin = async (pg) => {
  await pg.click('#btn-admin-fab');
  await pg.waitForTimeout(450);
};

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

  await openAdmin(pg);

  /* ---- 1. header: no DEV MODE, amber kicker, sculpted 38x38 close key ---- */
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
      close: !!closeBtn,
      closeW: closeBtn ? Math.round(closeBtn.getBoundingClientRect().width) : 0,
      closeH: closeBtn ? Math.round(closeBtn.getBoundingClientRect().height) : 0,
      closeRadius: cs ? parseFloat(cs.borderRadius) : 0,
      closeShadow: cs?.boxShadow ?? '',
      closeCharcoal: cs?.backgroundImage?.includes('linear-gradient(180deg, rgb(27, 35, 51)') ?? closeBtn?.classList.contains('admin-close'),
      closeLabel: closeBtn?.getAttribute('aria-label') ?? '',
      closeIcon: !!closeBtn?.querySelector('svg use[href="#i-close"]'),
    };
  });
  expect('the DEV MODE badge is gone from the stage entirely', !head.devBadge);
  expect('left side keeps the COMMAND CENTER kicker with warm amber tracking',
    head.kicker === 'COMMAND CENTER' && head.kickerSpacing >= 1.2 && head.kickerColor.startsWith('rgb(252, 211, 77'));
  expect('embossed "Detour Admin" title intact', head.title === 'Detour Admin');
  expect('sculpted close key is a 38x38 rounded clay pill',
    head.close && head.closeW === 38 && head.closeH === 38 && head.closeRadius >= 10);
  expect('close key carries rim light + deep charcoal bevel + tactile lip',
    /rgba\(255, 255, 255, 0\.14\) 0px 1px 0px.*inset/.test(head.closeShadow)
    && /rgba\(0, 0, 0, 0\.5\) 0px -2px.*inset/.test(head.closeShadow)
    && /rgb\(10, 14, 21\) 0px 3px 0px/.test(head.closeShadow));
  expect('close key is the crisp i-close glyph with the full aria label',
    head.closeIcon && head.closeLabel === 'Close Admin Command Center');

  /* ---- 5a. pinned chrome + scroll fit ---- */
  const stage = await pg.evaluate(() => {
    const overlay = document.getElementById('overlay-admin');
    const body = overlay.querySelector('.admin-body');
    const cs = getComputedStyle(body);
    const wide = [...overlay.querySelectorAll('*')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > window.innerWidth + 1 || r.right > window.innerWidth + 1;
    });
    return {
      bodyPadBottom: Math.round(parseFloat(cs.paddingBottom)),
      bodyOverscroll: cs.overscrollBehavior,
      touchScroll: cs.getPropertyValue('-webkit-overflow-scrolling') || 'auto',
      bodyScrollable: body.scrollHeight > body.clientHeight,
      bodyOverflowY: cs.overflowY,
      pageScroll: document.documentElement.scrollHeight - window.innerHeight,
      pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
      wideElCount: wide.length,
      panelVisible: !overlay.querySelector('[data-apanel="stats"]').hidden,
    };
  });
  expect('stats panel is the landing view', stage.panelVisible);
  expect('body keeps an 80px tail so content never hides behind the dock', stage.bodyPadBottom === 80);
  expect('body scrolls smoothly with touch momentum between the pinned chrome',
    stage.bodyOverflowY === 'auto' && stage.bodyScrollable && stage.bodyOverscroll === 'contain');
  expect('zero page scroll at 360x640', stage.pageScroll <= 0);
  expect('zero horizontal overflow at 360x640 (no element past the viewport edge)',
    stage.pageOverflowX <= 0 && stage.wideElCount === 0);

  /* ---- 2. the timeframe rail ---- */
  const tf = await pg.evaluate(() => {
    const rail = document.querySelector('.adm-tf');
    const pills = [...rail.querySelectorAll('.adm-tf-b')];
    const active = rail.querySelector('[aria-pressed="true"]');
    const acs = active ? getComputedStyle(active) : null;
    return {
      order: pills.map((b) => b.textContent.trim()),
      full: rail.getBoundingClientRect().width >= window.innerWidth - 40,
      activeGold: acs ? acs.backgroundImage.includes('rgb(251, 191, 36)') : false,
      activeLabel: active?.textContent?.trim() ?? '',
      railSunken: rail.className.includes('adm-tf'),
    };
  });
  expect('four timeframe pills: Today / 7 Days / 30 Days / All Time',
    tf.order.join('|') === 'Today|7 Days|30 Days|All Time');
  expect('the rail spans the stage width', tf.full);
  expect('Today starts lit as the raised gold clay key', tf.activeGold && tf.activeLabel === 'Today');

  /* ---- 3. the dashboard renders ---- */
  const dash = await pg.evaluate(() => {
    const q = (id) => document.getElementById(id);
    const num = (id) => q(id)?.textContent?.trim() ?? '';
    const dot = q('stat-live-dot');
    const segs = ['stat-mode-1v1', 'stat-mode-arena', 'stat-mode-solo'].map((id) => {
      const el = q(id);
      return { w: parseFloat(getComputedStyle(el).width), mode: el.dataset.mode };
    });
    const segSum = segs.reduce((a, s) => a + s.w, 0);
    const barW = q('stat-mode-bar').getBoundingClientRect().width;
    const meters = [...q('stat-nations').querySelectorAll('.adm-nat')].map((li) => ({
      pct: li.querySelector('.adm-nat-p')?.textContent ?? '',
      fillW: parseFloat(getComputedStyle(li.querySelector('.adm-nat-fill')).width),
      trackW: parseFloat(getComputedStyle(li.querySelector('.adm-nat-track')).width),
    }));
    return {
      active: num('stat-active'),
      liveRooms: num('stat-live-rooms'),
      dotLive: dot?.dataset.live ?? '',
      dotAnimates: dot ? getComputedStyle(dot).animationName !== 'none' : false,
      players: num('stat-players'),
      dau: num('stat-dau'),
      dauDelta: /\u25B2 \+\d+%/.test(num('stat-dau')),
      matches: num('stat-matches'),
      modes: num('stat-modes'),
      coins: num('stat-coins'),
      stars: num('stat-stars'),
      modeBarAria: q('stat-mode-bar').getAttribute('aria-label') ?? '',
      segSum, barW,
      dur: num('stat-dur'),
      bot: num('stat-bot'),
      draw: num('stat-draw'),
      lat: num('stat-lat'),
      err: num('stat-err'),
      health: q('stat-health-chip')?.textContent?.trim() ?? '',
      source: q('stat-source')?.textContent?.trim() ?? '',
      meters,
    };
  });
  expect('Active Now card renders with its live-room sub-line', /^\d/.test(dash.active) && /^\d[\d,]* live rooms$/.test(dash.liveRooms));
  expect('the live dot pulses green', dash.dotLive === 'true' && dash.dotAnimates);
  expect('Total Players card renders with a DAU +delta trend',
    /^\d/.test(dash.players) && /^DAU \d/.test(dash.dau) && dash.dauDelta);
  expect('Matches Completed card renders with the 1v1/Arena split',
    /^\d/.test(dash.matches) && /^1v1 \d[\d,]* · Arena \d/.test(dash.modes));
  expect('Coin Volume card renders with the Telegram Stars pool line',
    /^\d/.test(dash.coins) && /^\u2605 \d[\d,]* Stars pool$/.test(dash.stars));
  expect('mode bar is proportional (segments fill the track)',
    dash.modeBarAria === 'Matches by mode' && Math.abs(dash.segSum - dash.barW) <= 2 && dash.barW > 100);
  expect(`match telemetry renders (${dash.dur} / ${dash.bot} / ${dash.draw})`,
    /^\d+m \d{2}s$/.test(dash.dur) && /^\d+(\.\d+)?%$/.test(dash.bot) && /^\d+(\.\d+)?%$/.test(dash.draw));
  expect(`system health renders (${dash.lat} / ${dash.err} · ${dash.health})`,
    /^\d+ms p50$/.test(dash.lat) && /^\d+(\.\d+)?%$/.test(dash.err) && dash.health === 'Stable');
  expect('Top Nations are clean mini meters with flags and share labels',
    dash.meters.length === 4 && dash.meters.every((m) => /^\d+%$/.test(m.pct) && m.fillW > 0 && m.trackW > 0));

  await pg.screenshot({ path: path.join(SHOTS, 'admin-stats-360x640.png') });
  console.log('shot admin-stats-360x640.png');

  /* ---- 2b. switching windows recomputes every card, with the haptic ---- */
  const before = await pg.evaluate(() => ({
    active: document.getElementById('stat-active').textContent,
    players: document.getElementById('stat-players').textContent,
    matches: document.getElementById('stat-matches').textContent,
    coins: document.getElementById('stat-coins').textContent,
    dur: document.getElementById('stat-dur').textContent,
    lat: document.getElementById('stat-lat').textContent,
  }));
  await pg.evaluate(() => {
    document.querySelector('[data-range="7d"]').click();
  });
  await pg.waitForTimeout(120);
  const after7 = await pg.evaluate(() => ({
    active: document.getElementById('stat-active').textContent,
    players: document.getElementById('stat-players').textContent,
    matches: document.getElementById('stat-matches').textContent,
    coins: document.getElementById('stat-coins').textContent,
    dur: document.getElementById('stat-dur').textContent,
    lat: document.getElementById('stat-lat').textContent,
    pressed: document.querySelector('.adm-tf-b[aria-pressed="true"]')?.textContent?.trim(),
  }));
  expect('7 Days pill takes the gold key', after7.pressed === '7 Days');
  expect('KPIs recompute for the 7-day window',
    after7.players !== before.players && after7.matches !== before.matches && after7.coins !== before.coins);
  expect('tactical rows recompute too (duration / latency moved)',
    after7.dur !== before.dur && after7.lat !== before.lat);

  await pg.evaluate(() => document.querySelector('[data-range="30d"]').click());
  const after30 = await pg.evaluate(() => ({
    players: document.getElementById('stat-players').textContent,
    pressed: document.querySelector('.adm-tf-b[aria-pressed="true"]')?.textContent?.trim(),
  }));
  expect('30 Days recomputes again and takes the key',
    after30.pressed === '30 Days' && after30.players !== after7.players);

  await pg.evaluate(() => document.querySelector('[data-range="all"]').click());
  const afterAll = await pg.evaluate(() => ({
    players: document.getElementById('stat-players').textContent,
    matches: document.getElementById('stat-matches').textContent,
    active: document.getElementById('stat-active').textContent,
    pressed: document.querySelector('.adm-tf-b[aria-pressed="true"]')?.textContent?.trim(),
  }));
  expect('All Time recomputes once more and takes the key',
    afterAll.pressed === 'All Time' && afterAll.players !== after30.players && afterAll.matches !== after7.matches);

  const haptics = await pg.evaluate(() => window.__tgCalls.filter(([k]) => k === 'impact').length);
  expect(`every window switch lands the soft haptic (${haptics} impacts)`, haptics >= 3);

  /* back to Today: the modelled day is stable, so the same figures must return */
  await pg.evaluate(() => document.querySelector('[data-range="today"]').click());
  const back = await pg.evaluate(() => ({
    active: document.getElementById('stat-active').textContent,
    players: document.getElementById('stat-players').textContent,
  }));
  expect('the window is deterministic: Today returns the day\'s exact figures',
    back.active === before.active && back.players === before.players);

  /* ---- 4. close dismisses the stage cleanly ---- */
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

  /* reopen: the dashboard lands on the same Today figures again */
  await openAdmin(pg);
  const reopened = await pg.evaluate(() => ({
    players: document.getElementById('stat-players').textContent,
    pressed: document.querySelector('.adm-tf-b[aria-pressed="true"]')?.textContent?.trim(),
  }));
  expect('a fresh open lands on Today with the same figures',
    reopened.pressed === 'Today' && reopened.players === before.players);
  await ctx.close();

  /* ================= 430x932: the ceiling mark ================= */
  const { ctx: ctx2, pg: pg2 } = await boot(browser, 430, 932, '430');
  await openAdmin(pg2);
  const big = await pg2.evaluate(() => {
    const overlay = document.getElementById('overlay-admin');
    const headEl = overlay.querySelector('.admin-head').getBoundingClientRect();
    const body = overlay.querySelector('.admin-body');
    const bodyR = body.getBoundingClientRect();
    const nav = overlay.querySelector('.admin-nav').getBoundingClientRect();
    body.scrollTop = body.scrollHeight;            // push the tail fully into view
    let lowest = -Infinity;
    for (const el of overlay.querySelector('[data-apanel="stats"]').querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.height > 0) lowest = Math.max(lowest, r.bottom);
    }
    tail = Math.round(nav.top - lowest);
    body.scrollTop = 0;
    const cards = [...overlay.querySelectorAll('.adm-card')].map((c) => Math.round(c.getBoundingClientRect().width));
    return {
      headTop: Math.round(headEl.top),
      bodyTop: Math.round(bodyR.top),
      navBottom: Math.round(nav.bottom),
      vh: window.innerHeight,
      pageScroll: document.documentElement.scrollHeight - window.innerHeight,
      pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
      bodyScrollable: body.scrollHeight > body.clientHeight,
      tail,
      minCardW: Math.min(...cards),
      dashMeters: overlay.querySelectorAll('.adm-nat').length,
    };
  });
  expect('header pinned at the stage top inset at 430x932', big.headTop >= 8);
  expect('dock pinned at the bottom at 430x932', big.navBottom >= big.vh - 40 && big.navBottom <= big.vh);
  expect('the dashboard scrolls under the pinned chrome at 430x932', big.bodyScrollable);
  expect('the dashboard tail clears the dock when scrolled to the end', big.tail >= 0);
  expect('zero page scroll at 430x932', big.pageScroll <= 0);
  expect('zero horizontal overflow at 430x932', big.pageOverflowX <= 0);
  expect('the four KPI tiles sit two-up with no squeezed column', big.minCardW >= 160);
  expect('nation meters render at the ceiling mark too', big.dashMeters === 4);

  await pg2.screenshot({ path: path.join(SHOTS, 'admin-stats-430x932.png') });
  console.log('shot admin-stats-430x932.png');
  await ctx2.close();
} finally {
  await browser.close();
  srv.close();
}

expect(`zero console errors/warnings and no page errors (${problems.length})`, problems.length === 0);
for (const p of problems) console.log(`  ${p}`);

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all admin stats checks passed');
