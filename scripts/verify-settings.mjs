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
 *   5. Contact Admin opens the IN-APP support bottom sheet (no external hop):
 *      header + engraved ✕, the three category pills, the recessed 300-char
 *      textarea, the gold Send key — then the full send flow (busy spinner →
 *      success badge → auto-dismiss), Escape close and tap-outside close;
 *   6. the Sound / Haptics switches still toggle;
 *   7. zero vertical scroll at 360x640 and 430x932 (page and stack alike);
 *   8. the snug top-aligned rhythm: header→card 14–16, card→card 12–14,
 *      badge 16–20 under the last card, zero dead air between the cards.
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
const MSG = 'Board wall vanished on move 6';

/** Telegram WebApp stub installed BEFORE the bundle loads — src/telegram.ts binds its
 *  `tg` reference at module init, so a post-load stub would never receive the haptics.
 *  The property is LOCKED (writable: false) so the remote telegram-web-app.js cannot
 *  replace it out from under the audit; outside the client that script only no-ops. */
const TG_STUB = `
  window.__tgCalls = [];
  const push = (...a) => window.__tgCalls.push(a);
  let stub;
  try {
    stub = window.Telegram?.WebApp || {};
  } catch { stub = {}; }
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
  try { Object.freeze(stub.HapticFeedback); Object.freeze(stub); } catch { /* still fine */ }
  try {
    Object.defineProperty(window, 'Telegram', { value: { WebApp: stub }, writable: false, configurable: false });
  } catch { window.Telegram = { WebApp: stub }; }
  try { Object.defineProperty(window, '__tgCalls', { value: window.__tgCalls, writable: true, configurable: false }); } catch { /* ok */ }
`;

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
  /* the real telegram-web-app.js must never run here: outside the client it only
     no-ops haptics and re-points Telegram.WebApp, killing the traps. Serve an
     empty body so the init-script stub is the one and only WebApp. */
  await ctx.route('**/telegram-web-app.js**', (route) => route.fulfill({ status: 200, body: '', contentType: 'application/javascript' }));
  await ctx.route('**/telegram.org/js/telegram-web-app.js**', (route) => route.fulfill({ status: 200, body: '', contentType: 'application/javascript' }));
  await ctx.addInitScript(TG_STUB);
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
  expect('6 rows (4 gameplay + 2 community)', st.rows === 6);
  expect('zero page scroll at 360x640', st.pageScroll <= 0);
  expect('zero stack scroll at 360x640', st.stackScroll <= 0);

  /* ---- the in-app support sheet: Contact Admin must NEVER link out ---- */
  await pg.click('#admin-row');
  await pg.waitForTimeout(500);
  const modal = await pg.evaluate(() => {
    const sheet = document.getElementById('sheet-support');
    const open = !!sheet && sheet.classList.contains('open');
    const scrimOpen = !document.getElementById('scrim').hidden;
    return {
      open, scrimOpen,
      title: sheet?.querySelector('.support-title')?.textContent?.trim() ?? '',
      closeBtn: !!sheet?.querySelector('.support-x'),
      pills: [...(sheet?.querySelectorAll('.cat-pill') ?? [])].map((p) => ({
        label: p.textContent.trim(), active: p.getAttribute('aria-pressed') === 'true',
      })),
      textarea: !!sheet?.querySelector('.support-input'),
      placeholder: sheet?.querySelector('.support-input')?.getAttribute('placeholder') ?? '',
      send: sheet?.querySelector('#support-send .send-t')?.textContent?.trim() ?? '',
      maxLen: sheet?.querySelector('.support-input')?.getAttribute('maxlength') ?? '',
      count: sheet?.querySelector('.support-count')?.textContent?.trim() ?? '',
    };
  });
  expect('admin row opens the in-app support sheet', modal.open && modal.scrimOpen);
  expect('sheet title = Contact Support', modal.title === 'Contact Support');
  expect('engraved close button present', modal.closeBtn);
  expect('three category pills, Feedback active',
    modal.pills.length === 3 && modal.pills[0].label === 'Feedback' && modal.pills[0].active
    && modal.pills[1].label === 'Bug Report' && modal.pills[2].label === 'Stars Help');
  expect('recessed 300-char textarea', modal.textarea && modal.maxLen === '300');
  expect('crisp placeholder', modal.placeholder.startsWith('Write your message'));
  expect('gold Send Message key', modal.send === 'Send Message');
  expect('char meter starts at 300', modal.count === '300');

  /* escape close (the sheets system owns it), taps-outside close */
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(600);
  const goneViaEscape = await pg.evaluate(() => {
    const sheet = document.getElementById('sheet-support');
    return !sheet.classList.contains('open') && document.getElementById('scrim').hidden;
  });
  expect('Escape closes the support sheet', goneViaEscape);

  const reopenTaps = await pg.evaluate(() => { document.getElementById('admin-row').click(); });
  await pg.waitForTimeout(450);
  const reOpen = await pg.evaluate(() => {
    const sheet = document.getElementById('sheet-support');
    const open = sheet.classList.contains('open');
    document.getElementById('scrim').click();          /* tap-outside-to-close */
    return { open, empty: document.getElementById('support-msg').value === '' };
  });
  await pg.waitForTimeout(600);
  const goneViaScrim = await pg.evaluate(() => !document.getElementById('sheet-support').classList.contains('open'));
  expect('sheet reopened with a fresh form', reOpen.open && reOpen.empty);
  expect('tap-outside (scrim) closes the support sheet', goneViaScrim);

  /* reopen and run the live send flow. An empty message must refuse to enter
     the busy state; a typed one runs spinner → haptic + badge → auto-dismiss,
     with zero links out. The haptic + hop traps live in the init-script stub
     (window.__tgCalls) because src/telegram.ts binds its reference at load. */
  const traps = await pg.evaluate((msg) => {
    document.getElementById('admin-row').click();
    const btn = document.getElementById('support-send');
    btn.click();
    const emptyRefused = !btn.classList.contains('sending');
    const msgEl = document.getElementById('support-msg');
    msgEl.value = msg;
    msgEl.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();
    return { emptyRefused, counter: document.getElementById('support-count').textContent.trim() };
  }, MSG);
  await pg.waitForTimeout(350);
  const busyPhase = await pg.evaluate(() => ({
    busy: document.getElementById('support-send').classList.contains('sending'),
    stillOpen: document.getElementById('sheet-support').classList.contains('open'),
    badgeHidden: document.getElementById('support-ok').hidden,
  }));
  await pg.waitForTimeout(800);
  const badgePhase = await pg.evaluate(() => {
    const sheet = document.getElementById('sheet-support');
    return {
      stillOpen: sheet.classList.contains('open'),
      badgeShown: !document.getElementById('support-ok').hidden,
      badgeText: sheet.querySelector('#support-ok span')?.textContent?.trim() ?? '',
    };
  });
  await pg.waitForTimeout(2400);
  const settled = await pg.evaluate(() => ({
    stillOpen: document.getElementById('sheet-support').classList.contains('open'),
    scrimOpen: !document.getElementById('scrim').hidden,
    busyReset: !document.getElementById('support-send').classList.contains('sending'),
    sendLabel: document.querySelector('#support-send .send-t')?.textContent?.trim() ?? '',
    formCleared: document.getElementById('support-msg').value === '',
  }));
  const tgCalls = await pg.evaluate(() => window.__tgCalls);
  const hops = tgCalls.filter(([k]) => k === 'tglink' || k === 'link' || k === 'open');
  expect('empty send is refused, never busy', traps.emptyRefused);
  expect(`char meter counts down (${traps.counter})`, traps.counter === String(300 - MSG.length));
  expect('send key shows the spinner state', busyPhase.busy && busyPhase.stillOpen && busyPhase.badgeHidden);
  expect('haptic impact on send + success notification',
    tgCalls.some(([k, s]) => k === 'impact' && s === 'medium')
    && tgCalls.some(([k, t]) => k === 'notify' && t === 'success'));
  expect(`zero external hops (${JSON.stringify(hops)})`, hops.length === 0);
  expect('success badge = Message sent to admins!', badgePhase.badgeShown
    && badgePhase.badgeText === 'Message sent to admins!' && badgePhase.stillOpen);
  expect('sheet auto-dismisses, panel hidden', !settled.stillOpen && !settled.scrimOpen);
  expect('busy + form reset after dismiss', settled.busyReset && settled.sendLabel === 'Send Message' && settled.formCleared);

  /* the channel row keeps its external behavior: Telegram-first hop */
  const beforeChannel = await pg.evaluate(() => window.__tgCalls.length);
  await pg.evaluate(() => document.getElementById('tg-channel').click());
  const channelCalls = await pg.evaluate((n) => window.__tgCalls.slice(n), beforeChannel);
  expect('channel row → openTelegramLink(channel)',
    channelCalls.some(([k, u]) => k === 'tglink' && u === CHANNEL_URL));

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
  const rhythm = await pg2.evaluate(() => {
    const s = document.getElementById('s-settings');
    const head = s.querySelector('.set-head').getBoundingClientRect();
    const stack = s.querySelector('.set-stack').getBoundingClientRect();
    const cards = [...s.querySelectorAll('.set-card')].map((c) => c.getBoundingClientRect());
    const badge = s.querySelector('.set-notes').getBoundingClientRect();
    return {
      headCard: Math.round(cards[0].top - head.bottom),   /* header -> card: 14 -> 16 */
      cardCard: Math.round(cards[1].top - cards[0].bottom), /* card -> card: 12 -> 14 */
      cardBadge: Math.round(badge.top - cards[1].bottom), /* card -> badge: 16 -> 20 */
      cardAtTop: Math.round(cards[0].top - stack.top),     /* card pinned to the stack's top */
    };
  });
  expect(`header->card gap = ${rhythm.headCard} (14-16)`, rhythm.headCard >= 14 && rhythm.headCard <= 16);
  expect(`card->card gap = ${rhythm.cardCard} (12-14)`, rhythm.cardCard >= 12 && rhythm.cardCard <= 14);
  expect(`card->badge gap = ${rhythm.cardBadge} (16-20)`, rhythm.cardBadge >= 16 && rhythm.cardBadge <= 20);
  expect('cards pinned to the top of the stack', rhythm.cardAtTop <= 3);
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
