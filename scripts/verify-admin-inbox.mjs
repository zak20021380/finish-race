/**
 * verify-admin-inbox.mjs — Playwright audit for the Admin Command Center's tactile
 * bottom navigation and the Support Inbox / reply workflow.
 *
 * Serves ./dist over 127.0.0.1 and walks the real user path:
 *   dock → Profile → settings key → Contact Admin → support sheet → send a
 *   Bug Report ticket → back to Home → Admin FAB → Inbox tab → view, filter,
 *   reply to and resolve the ticket.
 *
 * Checks:
 *   1. the stage keeps its geometry: header pinned top, nav pinned bottom, the
 *      body scrolls between them, zero page scroll, every key >= 44px;
 *   2. six bottom tabs (Stats/Users/Controls/Server/Inbox/Tools) switch panels
 *      cleanly, with the springy pill riding the active tab;
 *   3. a ticket filed from the support sheet lands in the Inbox with the badge
 *      count at 1, the category, the relative stamp and the "New" pill;
 *   4. filter chips filter [All, Feedback, Bugs, Stars Help, Unresolved];
 *   5. the expanded card carries the profile, the recessed reply well, and
 *      Send Reply / Mark as Resolved move the ticket New → Replied → Resolved;
 *   6. zero console errors across the whole run, at 360x640 and 430x932.
 *
 * Run: node scripts/verify-admin-inbox.mjs   (playwright-core resolved at runtime)
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
      '  NODE_PATH="C:\\Users\\PC-Y\\AppData\\Local\\Temp\\opencode\\check\\node_modules" node scripts/verify-admin-inbox.mjs',
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
      /* the Server/Stats/Users/Inbox/Controls tabs probe the live room; a static audit has none,
         and the app itself treats ok:false as "Local"/"Local Index" — answer so the probe and the
         registry/history reads are not 404s */
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

const openAdmin = async (pg) => {
  await pg.click('#btn-admin-fab');
  await pg.waitForTimeout(450);
};

const MSG = 'The board wall vanished after my sixth move on the wide board.';

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
  const stage = await pg.evaluate(() => {
    const overlay = document.getElementById('overlay-admin');
    const head = overlay.querySelector('.admin-head').getBoundingClientRect();
    const body = overlay.querySelector('.admin-body');
    const bodyR = body.getBoundingClientRect();
    const nav = overlay.querySelector('.admin-nav').getBoundingClientRect();
    const tabs = [...overlay.querySelectorAll('[data-atab]')];
    return {
      open: overlay.classList.contains('open') && !overlay.hidden,
      headTop: Math.round(head.top),
      headBottom: Math.round(head.bottom),
      padTop: Math.round(parseFloat(getComputedStyle(overlay).paddingTop)),
      bodyTop: Math.round(bodyR.top),
      bodyBottom: Math.round(bodyR.bottom),
      bodyScrollable: body.scrollHeight >= body.clientHeight,
      bodyOverflow: getComputedStyle(body).overflowY,
      navTop: Math.round(nav.top),
      navBottom: Math.round(nav.bottom),
      vh: window.innerHeight,
      pageScroll: document.documentElement.scrollHeight - window.innerHeight,
      labels: tabs.map((t) => t.querySelector('.admin-tab-l')?.textContent?.trim() ?? ''),
      minTabH: Math.min(...tabs.map((t) => t.getBoundingClientRect().height)),
      minTabW: Math.min(...tabs.map((t) => t.getBoundingClientRect().width)),
      pill: !!overlay.querySelector('#admin-nav-pill'),
      badge: !!overlay.querySelector('#admin-inbox-badge'),
      badgeHidden: document.getElementById('admin-inbox-badge').hidden,
    };
  });
  expect('admin stage opens from the FAB', stage.open);
  expect(`header pinned at the stage's top inset (head ${stage.headTop}, inset ${stage.padTop})`,
    stage.headTop >= 8 && Math.abs(stage.headTop - stage.padTop) <= 2);
  expect('body sits under the header', stage.bodyTop >= stage.headBottom);
  expect('bottom dock pinned at the stage bottom', stage.navBottom >= stage.vh - 40 && stage.navTop >= stage.bodyBottom);
  expect('body scrolls between header and dock', stage.bodyOverflow === 'auto' && stage.bodyScrollable);
  expect('zero page scroll at 360x640', stage.pageScroll <= 0);
  expect('six tabs: Stats/Users/Controls/Server/Inbox/Tools',
    stage.labels.join('|') === 'Stats|Users|Controls|Server|Inbox|Tools');
  expect(`every tab key >= 44px (min ${Math.round(stage.minTabH)}h x ${Math.round(stage.minTabW)}w)`,
    stage.minTabH >= 44 && stage.minTabW >= 44);
  expect('springy gold pill present', stage.pill);
  expect('inbox badge starts hidden with no tickets', stage.badge && stage.badgeHidden);

  /* ---- every tab switches its panel, and the pill rides along ---- */
  const switches = await pg.evaluate(() => {
    const overlay = document.getElementById('overlay-admin');
    const out = [];
    for (const id of ['stats', 'users', 'controls', 'server', 'inbox', 'tools']) {
      overlay.querySelector(`[data-atab="${id}"]`).click();
      const shown = [...overlay.querySelectorAll('[data-apanel]')]
        .filter((p) => !p.hidden)
        .map((p) => p.dataset.apanel);
      const pill = document.getElementById('admin-nav-pill').style.transform;
      out.push({ id, shown: shown.join(','), pill });
    }
    return out;
  });
  expect('each tab lights exactly its own panel',
    switches.every((s) => s.shown === s.id));
  expect('the pill steps one slot per tab (0% → 500%)',
    switches.map((s) => s.pill).join('|')
      === 'translateX(0%)|translateX(100%)|translateX(200%)|translateX(300%)|translateX(400%)|translateX(500%)');

  await pg.evaluate(() => document.getElementById('atab-stats').click());
  await pg.screenshot({ path: path.join(SHOTS, 'admin-nav-360x640.png') });
  console.log('shot admin-nav-360x640.png');

  await pg.click('#admin-close');
  await pg.waitForTimeout(450);

  /* ---- file a ticket through the real Settings path ---- */
  await pg.click('.dock-nav .tab[data-tab="profile"]');
  await pg.waitForTimeout(700);
  await pg.click('#profile-settings');
  await pg.waitForTimeout(700);
  await pg.click('#admin-row');
  await pg.waitForTimeout(500);
  const sheetOpen = await pg.evaluate(() => document.getElementById('sheet-support').classList.contains('open'));
  expect('Contact Admin opens the in-app support sheet', sheetOpen);

  const sent = await pg.evaluate((msg) => {
    const sheet = document.getElementById('sheet-support');
    sheet.querySelector('.cat-pill[data-cat="bug"]').click();
    const area = document.getElementById('support-msg');
    area.value = msg;
    area.dispatchEvent(new Event('input', { bubbles: true }));
    const cat = sheet.querySelector('.cat-pill[aria-pressed="true"]')?.dataset.cat;
    document.getElementById('support-send').click();
    return { cat, count: document.getElementById('support-count').textContent.trim() };
  }, MSG);
  expect('Bug Report category is the one selected', sent.cat === 'bug');
  await pg.waitForTimeout(2600);                 /* the whole send → success → dismiss cycle */
  const stored = await pg.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('detour.support.v1') ?? 'null');
    return { count: raw?.tickets?.length ?? 0, status: raw?.tickets?.[0]?.status ?? '', cat: raw?.tickets?.[0]?.category ?? '' };
  });
  expect('the sheet wrote the ticket into the shared queue',
    stored.count === 1 && stored.status === 'new' && stored.cat === 'bug');

  /* ---- back to Home, into the Inbox ---- */
  await pg.click('.dock-nav .tab[data-tab="home"]');
  await pg.waitForTimeout(700);
  await openAdmin(pg);
  const badge = await pg.evaluate(() => {
    const b = document.getElementById('admin-inbox-badge');
    return { hidden: b.hidden, text: b.textContent.trim(), label: document.getElementById('atab-inbox').getAttribute('aria-label') };
  });
  expect('Inbox badge shows 1 unread right on open', !badge.hidden && badge.text === '1');
  expect('the Inbox tab announces the unread count', /1 unread ticket/.test(badge.label ?? ''));

  await pg.evaluate(() => document.getElementById('atab-inbox').click());
  await pg.waitForTimeout(300);
  const card = await pg.evaluate(() => {
    const li = document.querySelector('#adm-inbox-list .adm-ticket');
    if (!li) return null;
    return {
      cards: document.querySelectorAll('#adm-inbox-list .adm-ticket').length,
      cat: li.querySelector('.adm-ticket-cat')?.textContent?.trim(),
      who: li.querySelector('.adm-ticket-who')?.textContent?.trim(),
      when: li.querySelector('.adm-ticket-when')?.textContent?.trim(),
      status: li.querySelector('.adm-ticket-status')?.textContent?.trim(),
      snippet: li.querySelector('.adm-ticket-snip')?.textContent?.trim(),
      expanded: li.classList.contains('is-open'),
    };
  });
  expect('one ticket card in the Inbox', !!card && card.cards === 1);
  expect('card carries the Bug Report badge', card.cat === 'Bug Report');
  expect('card carries a user tag', /^(#|@)/.test(card.who ?? ''));
  expect(`card carries the relative stamp (${card.when})`, /ago$|just now|^\d{4}-/.test(card.when ?? ''));
  expect('card carries the New status pill', card.status === 'New');
  expect('card previews the message', (card.snippet ?? '').includes('board wall vanished'));
  expect('card starts collapsed', !card.expanded);

  /* ---- filter chips ---- */
  const filters = await pg.evaluate(() => {
    const out = {};
    const chip = (f) => document.querySelector(`[data-ifilter="${f}"]`);
    const set = (f) => { chip(f).click(); };
    const cards = () => document.querySelectorAll('#adm-inbox-list .adm-ticket').length;
    const empty = () => !document.getElementById('adm-inbox-empty').hidden;
    set('bug'); out.bug = [cards(), empty()];
    set('feedback'); out.feedback = [cards(), empty()];
    set('stars'); out.stars = [cards(), empty()];
    set('unresolved'); out.unresolved = [cards(), empty()];
    set('all'); out.all = [cards(), empty()];
    out.pressed = chip('all').getAttribute('aria-pressed');
    return out;
  });
  expect('Bugs filter keeps the ticket', filters.bug[0] === 1 && !filters.bug[1]);
  expect('Feedback filter shows the empty state', filters.feedback[0] === 0 && filters.feedback[1]);
  expect('Stars Help filter shows the empty state', filters.stars[0] === 0 && filters.stars[1]);
  expect('Unresolved filter keeps a New ticket', filters.unresolved[0] === 1 && !filters.unresolved[1]);
  expect('All filter restores the queue', filters.all[0] === 1 && filters.pressed === 'true');

  /* ---- expand, reply, resolve ---- */
  await pg.evaluate(() => document.querySelector('#adm-inbox-list .adm-ticket-main').click());
  await pg.waitForTimeout(250);
  const detail = await pg.evaluate(() => {
    const li = document.querySelector('#adm-inbox-list .adm-ticket');
    const area = li.querySelector('.adm-reply');
    return {
      expanded: li.classList.contains('is-open'),
      profile: li.querySelector('.adm-ticket-profile')?.textContent ?? '',
      full: li.querySelector('.adm-ticket-full')?.textContent ?? '',
      placeholder: area?.getAttribute('placeholder') ?? '',
      maxLength: area?.getAttribute('maxlength') ?? '',
      sendLabel: li.querySelector('.adm-send')?.textContent?.trim() ?? '',
      resolveLabel: li.querySelector('.adm-resolve')?.textContent?.trim() ?? '',
      resolvePressed: li.querySelector('.adm-resolve')?.getAttribute('aria-pressed'),
    };
  });
  expect('ticket expands into the detail card', detail.expanded);
  expect('detail carries id and exact timestamp', /id .+ · .+/.test(detail.profile));
  expect('detail shows the full inquiry', detail.full === MSG);
  expect('deeply recessed reply well with its own prompt',
    detail.placeholder === 'Type official admin reply...' && detail.maxLength === '400');
  expect('gold Send Reply key', detail.sendLabel === 'Send Reply');
  expect('subtle resolve toggle', detail.resolveLabel === 'Mark as Resolved' && detail.resolvePressed === 'false');

  /* empty send is refused, a typed one lands */
  const before = await pg.evaluate(() => {
    document.querySelector('.adm-send').click();
    return JSON.parse(localStorage.getItem('detour.support.v1')).tickets[0].status;
  });
  expect('an empty reply is refused, the ticket stays New', before === 'new');
  await pg.fill('#adm-inbox-list .adm-ticket .adm-reply', 'Thanks for the report — the wall replay is on our board now. Fixed in the next build.');
  await pg.click('#adm-inbox-list .adm-ticket .adm-send');
  await pg.waitForTimeout(350);
  const replied = await pg.evaluate(() => {
    const li = document.querySelector('#adm-inbox-list .adm-ticket');
    const raw = JSON.parse(localStorage.getItem('detour.support.v1')).tickets[0];
    const badge = document.getElementById('admin-inbox-badge');
    const calls = window.__tgCalls;
    return {
      status: li.querySelector('.adm-ticket-status')?.textContent?.trim(),
      prev: li.querySelector('.adm-ticket-prev')?.textContent ?? '',
      stored: raw.status,
      reply: raw.reply,
      badgeHidden: badge.hidden,
      haptic: calls.some(([k, s]) => k === 'impact' && s === 'medium') && calls.some(([k, t]) => k === 'notify' && t === 'success'),
    };
  });
  expect('sending moves the ticket to Replied', replied.status === 'Replied' && replied.stored === 'replied');
  expect('the reply is stored and shown back on the card', replied.prev.startsWith('Your reply: Thanks for the report'));
  expect('the unread badge clears once answered', replied.badgeHidden);
  expect('send fires the tactile haptic + success toast', replied.haptic);

  await pg.evaluate(() => document.querySelector('.adm-resolve').click());
  await pg.waitForTimeout(250);
  const resolved = await pg.evaluate(() => {
    const li = document.querySelector('#adm-inbox-list .adm-ticket');
    const raw = JSON.parse(localStorage.getItem('detour.support.v1')).tickets[0];
    return {
      status: li.querySelector('.adm-ticket-status')?.textContent?.trim(),
      resolveLabel: li.querySelector('.adm-resolve')?.textContent?.trim(),
      pressed: li.querySelector('.adm-resolve')?.getAttribute('aria-pressed'),
      stored: raw.status,
      resolvedAt: !!raw.resolvedAt,
    };
  });
  expect('Mark as Resolved closes the ticket',
    resolved.status === 'Resolved' && resolved.stored === 'resolved' && resolved.resolvedAt);
  expect('the toggle reports its pressed state', resolved.resolveLabel === 'Resolved' && resolved.pressed === 'true');

  const unresolved = await pg.evaluate(() => {
    document.querySelector('[data-ifilter="unresolved"]').click();
    const cards = document.querySelectorAll('#adm-inbox-list .adm-ticket').length;
    const empty = !document.getElementById('adm-inbox-empty').hidden;
    document.querySelector('[data-ifilter="all"]').click();
    return { cards, empty };
  });
  expect('a Resolved ticket leaves the Unresolved view', unresolved.cards === 0 && unresolved.empty);

  /* resolving twice reopens it — the toggle is honest both ways */
  await pg.evaluate(() => document.querySelector('.adm-resolve').click());
  await pg.waitForTimeout(200);
  const reopened = await pg.evaluate(() => JSON.parse(localStorage.getItem('detour.support.v1')).tickets[0].status);
  expect('tapping Resolved again reopens to Replied', reopened === 'replied');
  await pg.evaluate(() => document.querySelector('.adm-resolve').click());
  await pg.waitForTimeout(200);

  await pg.screenshot({ path: path.join(SHOTS, 'admin-inbox-360x640.png') });
  console.log('shot admin-inbox-360x640.png');
  await ctx.close();

  /* ================= 430x932: the ceiling mark ================= */
  const { ctx: ctx2, pg: pg2 } = await boot(browser, 430, 932, '430');
  await openAdmin(pg2);
  const big = await pg2.evaluate(() => {
    const overlay = document.getElementById('overlay-admin');
    const nav = overlay.querySelector('.admin-nav').getBoundingClientRect();
    const head = overlay.querySelector('.admin-head').getBoundingClientRect();
    return {
      navBottom: Math.round(nav.bottom),
      vh: window.innerHeight,
      headTop: Math.round(head.top),
      padTop: Math.round(parseFloat(getComputedStyle(overlay).paddingTop)),
      pageScroll: document.documentElement.scrollHeight - window.innerHeight,
      navWidth: Math.round(nav.width),
    };
  });
  expect('dock pinned at the bottom at 430x932', big.navBottom >= big.vh - 40 && big.navBottom <= big.vh);
  expect(`header pinned at the stage's top inset at 430x932 (head ${big.headTop}, inset ${big.padTop})`,
    big.headTop >= 8 && Math.abs(big.headTop - big.padTop) <= 2);
  expect('zero page scroll at 430x932', big.pageScroll <= 0);
  await pg2.evaluate(() => document.getElementById('atab-inbox').click());
  await pg2.waitForTimeout(250);
  await pg2.screenshot({ path: path.join(SHOTS, 'admin-inbox-430x932.png') });
  console.log('shot admin-inbox-430x932.png');
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
console.log('all admin inbox checks passed');
