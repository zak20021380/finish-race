/**
 * referral-check.mjs — Playwright verification for the Profile referral hub ("Invite Friends &
 * Earn"). No project dependencies: `playwright-core` is resolved at runtime only (see
 * scripts/verify-home-layout.mjs for the NODE_PATH recipe).
 *
 * Serves ./dist over 127.0.0.1 and checks, over the real user path (dock → Profile → card →
 * sheet):
 *   1. the compact invite card: gift well, live sub line (`Earn +500 Coins per invite`), the
 *      `Invite` pill, inside the pane, zero horizontal overflow, 54–70px tall;
 *   2. the sheet: engraved ✕, gold-bannered reward line fed by the REFERRAL_REWARD constant, the
 *      identity preview (`@Tactix_Robot` + `ref_<code>`), the direct-Mini-App link
 *      (`https://t.me/Tactix_Robot/play?startapp=ref_<code>`), Copy key, gold Share key, the two
 *      counters and the disabled mint Claim key;
 *   3. Copy: label swings to "Copied! ✔" with the .copied state and lands the link on the real
 *      clipboard, then reverts after ~1.4s;
 *   4. Share: openTelegramLink receives the t.me/share/url hop (URL + text) — no window.open;
 *   5. Claim: a seeded 3-join / 1,500-coin ledger shows `3 Invited` on the card, pays 1,850 →
 *      3,350 coins on the claim, zeroes the counter, disables the key, chimes + medium impact +
 *      success notification, shows the "+1,500 Coins · Referral rewards" toast, persists all of
 *      it, and shifts no layout (card rect and pane scrollTop identical);
 *   6. Server authority: a `?startapp=ref_...` launch with no Worker never mints coins locally
 *      (the Worker's ledger, not this device, pays the referral);
 *   7. zero document scroll and zero console errors at 360x640 and 430x932.
 * Screenshots: .shots/referral-*.png · exit 1 on any failure.
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
      '  NODE_PATH="C:\\\\Users\\\\PC-Y\\\\AppData\\\\Local\\\\Temp\\\\opencode\\\\check\\\\node_modules" node scripts/referral-check.mjs',
  );
  process.exit(2);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(String(req.url).split('?')[0]);
      if (p === '/favicon.ico') { res.writeHead(200, { 'Content-Type': 'image/x-icon' }); res.end(); return; }
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

const UID = 4242;
const CODE = 'a1b2c3d4e5f6';
const LINK = `https://t.me/Tactix_Robot/play?startapp=ref_${CODE}`;

/** Telegram WebApp stub installed BEFORE the bundle loads — src/telegram.ts binds its `tg`
 *  reference at module init, so a post-load stub would never receive the haptics. Locked so the
 *  (route-blocked) telegram-web-app.js could never replace it. `startParam` rides the real
 *  initDataUnsafe field the invite flow reads. */
const tgStub = (uid, startParam = '') => `
  window.__tgCalls = [];
  const push = (...a) => window.__tgCalls.push(a);
  let stub;
  try { stub = window.Telegram?.WebApp || {}; } catch { stub = {}; }
  stub.ready = stub.ready || (() => {});
  stub.expand = stub.expand || (() => {});
  stub.disableVerticalSwipe = stub.disableVerticalSwipe || (() => {});
  stub.disableVerticalSwipes = stub.disableVerticalSwipes || (() => {});
  stub.setHeaderColor = stub.setHeaderColor || (() => {});
  stub.setBackgroundColor = stub.setBackgroundColor || (() => {});
  stub.setColorScheme = stub.setColorScheme || (() => {});
  stub.isVersionAtLeast = stub.isVersionAtLeast || (() => true);
  stub.version = stub.version || '7.2';
  stub.platform = stub.platform || 'ios';
  stub.initDataUnsafe = { user: { id: ${uid}, first_name: 'Ada', language_code: 'en' }${startParam ? `, start_param: ${JSON.stringify(startParam)}` : ''} };
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
`;

async function makeContext(browser, w, h, uid, startParam = '') {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.route('**/telegram-web-app.js**', (route) => route.fulfill({ status: 200, body: '', contentType: 'application/javascript' }));
  await ctx.route('**/telegram.org/js/telegram-web-app.js**', (route) => route.fulfill({ status: 200, body: '', contentType: 'application/javascript' }));
  await ctx.addInitScript(tgStub(uid, startParam));
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${port}` });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  pg.on('pageerror', (e) => errors.push(String(e)));
  return { ctx, pg, errors };
}

const openProfile = async (pg) => {
  /* cache the server-issued code the way a real Mini App does after its first ledger read */
  await pg.addInitScript((code) => {
    try {
      const raw = localStorage.getItem('detour.save.v2');
      const save = raw ? JSON.parse(raw) : { v: 2 };
      if (save && save.v === 2) {
        save.referral = { ...(save.referral ?? {}), code };
        localStorage.setItem('detour.save.v2', JSON.stringify(save));
      }
    } catch { /* about:blank and friends have no storage */ }
  }, CODE);
  await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1200);
  await pg.click('.dock-nav .tab[data-tab="profile"]');
  await pg.waitForTimeout(700);
};

const seedReferral = async (pg, referral) => {
  /* seed through an INIT script: a plain pre-reload localStorage.write is clobbered by the
     app's own visibilitychange flush on the way out. Init scripts run before storage.ts boots. */
  await pg.addInitScript((r) => {
    try {
      const raw = localStorage.getItem('detour.save.v2');
      /* a fresh install has no blob at all; `{ v: 2 }` is a save whose every field folds to its
         fresh default in migrate(), so the minimal blob + the seeded ledger is a valid save */
      const save = raw ? JSON.parse(raw) : { v: 2 };
      if (save && save.v === 2) {
        save.referral = r;
        localStorage.setItem('detour.save.v2', JSON.stringify(save));
      }
    } catch { /* about:blank and friends have no storage */ }
  }, referral);
  await pg.reload({ waitUntil: 'networkidle' });
  await pg.waitForTimeout(1200);
  await pg.click('.dock-nav .tab[data-tab="profile"]');
  await pg.waitForTimeout(700);
};

const srv = await serve();
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args: ['--no-sandbox'] });

let failed = 0;
const expect = (name, ok) => {
  if (ok) console.log(`PASS ${name}`);
  else { failed += 1; console.log(`FAIL ${name}`); }
};

const profileSnapshot = (pg) => pg.evaluate(() => {
  const scr = document.getElementById('s-profile');
  const pane = scr.querySelector('.pf-pane');
  const card = document.getElementById('pf-invite');
  const r = card.getBoundingClientRect();
  const paneR = pane.getBoundingClientRect();
  let worst = 0;
  let worstCls = '';
  for (const el of scr.querySelectorAll('*')) {
    const er = el.getBoundingClientRect();
    if (er.width === 0 && er.height === 0) continue;
    const over = er.right - paneR.right;
    if (over > worst) { worst = over; worstCls = String(el.className || el.tagName).slice(0, 48); }
  }
  return {
    docScroll: document.documentElement.scrollHeight - window.innerHeight,
    paneOverX: pane.scrollWidth - pane.clientWidth,
    paneScrollTop: Math.round(pane.scrollTop),
    worstOverflow: Math.round(worst * 10) / 10,
    worstCls,
    card: {
      w: Math.round(r.width), h: Math.round(r.height),
      top: Math.round(r.top), left: Math.round(r.left),
      inPane: r.left >= paneR.left - 1 && r.right <= paneR.right + 1,
      overX: card.scrollWidth - card.clientWidth,
    },
    pill: document.getElementById('pf-invite-pill').textContent.trim(),
    sub: document.getElementById('pf-invite-s').textContent.trim(),
    gift: !!card.querySelector('use[href="#i-gift"]'),
  };
});

const sheetSnapshot = (pg) => pg.evaluate(() => {
  const sheet = document.getElementById('sheet-referral');
  const r = sheet.getBoundingClientRect();
  return {
    open: sheet.classList.contains('open') && !sheet.hidden,
    scrim: !document.getElementById('scrim').hidden,
    inView: r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1,
    overX: sheet.scrollWidth - sheet.clientWidth,
    title: document.getElementById('ref-title').textContent.trim(),
    close: !!sheet.querySelector('.referral-x'),
    banner: document.getElementById('ref-banner').textContent.trim(),
    link: document.getElementById('ref-link').value,
    handle: document.getElementById('ref-handle').textContent.trim(),
    code: document.getElementById('ref-code').textContent.trim(),
    copyLabel: document.querySelector('#ref-copy .ref-copy-t').textContent.trim(),
    shareLabel: document.querySelector('#ref-share span').textContent.trim(),
    claimLabel: document.querySelector('#ref-claim span').textContent.trim(),
    claimGift: !!sheet.querySelector('#ref-claim use[href="#i-gift"]'),
    joins: document.getElementById('ref-joins').textContent.trim(),
    unclaimed: document.getElementById('ref-unclaimed').textContent.trim(),
    claimDisabled: document.getElementById('ref-claim').disabled,
  };
});

try {
  /* ================= 360x640 — the mark every flow must hit ================= */
  {
    const { ctx, pg, errors } = await makeContext(browser, 360, 640, UID);
    await openProfile(pg);

    const prof = await profileSnapshot(pg);
    expect('invite card present with gift well', prof.gift && prof.card.w > 0);
    expect(`card sub = 'Earn +500 Coins per invite' (${prof.sub})`, prof.sub === 'Earn +500 Coins per invite');
    expect(`fresh card pill = Invite (${prof.pill})`, prof.pill === 'Invite');
    expect(`card sits inside the pane (${prof.card.w}px)`, prof.card.inPane && prof.card.overX <= 0);
    expect(`card is a compact slab (${prof.card.h}px, 54-70)`, prof.card.h >= 54 && prof.card.h <= 70);
    expect('zero document scroll at 360x640', prof.docScroll <= 0);
    expect(`zero horizontal overflow (${prof.worstOverflow}px · ${prof.worstCls})`, prof.worstOverflow <= 0.5 && prof.paneOverX <= 0);

    await pg.click('#pf-invite');
    await pg.waitForTimeout(600);
    const sheet = await sheetSnapshot(pg);
    expect('card opens the referral sheet (scrim up)', sheet.open && sheet.scrim);
    expect(`sheet title = Invite Friends & Earn (${sheet.title})`, sheet.title === 'Invite Friends & Earn');
    expect('engraved close button present', sheet.close);
    expect(`banner fed by the constant (${sheet.banner})`,
      sheet.banner === 'Get 500 Coins for you & your friend upon joining!');
    expect(`personal link = ${LINK}`, sheet.link === LINK);
    expect(`identity preview = @Tactix_Robot · ref_${CODE} (${sheet.handle} · ${sheet.code})`,
      sheet.handle === '@Tactix_Robot' && sheet.code === `ref_${CODE}`);
    expect(`copy key reads Copy (${sheet.copyLabel})`, sheet.copyLabel === 'Copy');
    expect(`share key reads Share Link via Telegram (${sheet.shareLabel})`, sheet.shareLabel === 'Share Link via Telegram');
    expect(`claim key present + disabled at zero (${sheet.claimLabel})`, sheet.claimGift && sheet.claimLabel === 'Claim Rewards' && sheet.claimDisabled);
    expect(`fresh counters are 0 / 0 (${sheet.joins} · ${sheet.unclaimed})`, sheet.joins === '0' && sheet.unclaimed === '0');
    expect('sheet wholly in view, zero horizontal', sheet.inView && sheet.overX <= 0);
    await pg.screenshot({ path: path.join(SHOTS, 'referral-sheet-360x640.png') });
    console.log('shot referral-sheet-360x640.png');

    /* copy → clipboard carry + the swung label */
    await pg.click('#ref-copy');
    await pg.waitForTimeout(150);
    const copied = await pg.evaluate(async () => ({
      label: document.querySelector('#ref-copy .ref-copy-t').textContent.trim(),
      cls: document.getElementById('ref-copy').classList.contains('copied'),
      clip: await navigator.clipboard.readText().catch(() => ''),
    }));
    expect(`copy lands on the clipboard (${JSON.stringify(copied.clip)})`, copied.clip === LINK);
    expect('copy key swings to Copied! ✔', copied.label === 'Copied! ✔' && copied.cls);
    await pg.waitForTimeout(1700);
    const reverted = await pg.evaluate(() => ({
      label: document.querySelector('#ref-copy .ref-copy-t').textContent.trim(),
      cls: document.getElementById('ref-copy').classList.contains('copied'),
    }));
    expect('copy key reverts to Copy', reverted.label === 'Copy' && !reverted.cls);

    /* share → the t.me/share hop through openTelegramLink, never window.open */
    const beforeShare = await pg.evaluate(() => window.__tgCalls.length);
    await pg.click('#ref-share');
    await pg.waitForTimeout(200);
    const shareCalls = await pg.evaluate((n) => window.__tgCalls.slice(n), beforeShare);
    const hop = shareCalls.find(([k]) => k === 'tglink')?.[1] ?? '';
    expect(`share → openTelegramLink(t.me/share/url…) `, hop.startsWith('https://t.me/share/url?url=')
      && hop.includes(encodeURIComponent(LINK)) && hop.includes('Tactix_Robot'));
    expect('share fires a medium haptic', shareCalls.some(([k, s]) => k === 'impact' && s === 'medium'));

    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(600);
    const closed = await pg.evaluate(() => !document.getElementById('sheet-referral').classList.contains('open'));
    expect('Escape closes the referral sheet', closed);

    /* the seeded ledger: 3 friends, 1,500 claimable */
    await seedReferral(pg, { joins: 3, unclaimed: 1500, earned: 1500, code: CODE, welcome: false, via: null });
    const seeded = await profileSnapshot(pg);
    expect(`seeded card pill = 3 Invited (${seeded.pill})`, seeded.pill === '3 Invited');
    await pg.click('#pf-invite');
    await pg.waitForTimeout(600);
    const due = await sheetSnapshot(pg);
    expect(`seeded counters = 3 / 1,500 (${due.joins} · ${due.unclaimed})`, due.joins === '3' && due.unclaimed === '1,500');
    expect('claim key wakes at a positive balance', !due.claimDisabled);

    const beforeClaim = await pg.evaluate(() => {
      const card = document.getElementById('pf-invite').getBoundingClientRect();
      const pane = document.querySelector('#s-profile .pf-pane');
      return { card: [Math.round(card.top), Math.round(card.left), Math.round(card.width), Math.round(card.height)], scroll: Math.round(pane.scrollTop), calls: window.__tgCalls.length };
    });
    await pg.click('#ref-claim');
    await pg.waitForTimeout(900);
    const after = await pg.evaluate(() => {
      const card = document.getElementById('pf-invite').getBoundingClientRect();
      const pane = document.querySelector('#s-profile .pf-pane');
      const save = JSON.parse(localStorage.getItem('detour.save.v2'));
      const toast = document.getElementById('pf-toast');
      return {
        card: [Math.round(card.top), Math.round(card.left), Math.round(card.width), Math.round(card.height)],
        scroll: Math.round(pane.scrollTop),
        coins: document.getElementById('pf-coins').textContent.trim(),
        unclaimed: document.getElementById('ref-unclaimed').textContent.trim(),
        claimDisabled: document.getElementById('ref-claim').disabled,
        open: document.getElementById('sheet-referral').classList.contains('open'),
        toastShown: !toast.hidden && toast.classList.contains('show'),
        toastText: document.getElementById('pf-toast-t').textContent.trim(),
        saveCoins: save.coins,
        saveRef: save.referral,
      };
    });
    const claimCalls = await pg.evaluate((n) => window.__tgCalls.slice(n), beforeClaim.calls);
    expect(`claim pays into the wallet (${after.coins})`, after.coins === '3,350');
    expect(`unclaimed drains to 0 and the key sleeps (${after.unclaimed})`, after.unclaimed === '0' && after.claimDisabled);
    expect('sheet stays open through the claim', after.open);
    expect(`toast confirms (${after.toastText})`, after.toastShown && after.toastText === '+1,500 Coins · Referral rewards');
    expect('claim fires impact(medium) + success notification',
      claimCalls.some(([k, s]) => k === 'impact' && s === 'medium')
      && claimCalls.some(([k, t]) => k === 'notify' && t === 'success'));
    expect(`claim persists to the save (${after.saveCoins} · ${JSON.stringify(after.saveRef)})`,
      after.saveCoins === 3350 && after.saveRef.unclaimed === 0 && after.saveRef.joins === 3);
    expect(`claim shifts no layout (${beforeClaim.card} vs ${after.card})`,
      JSON.stringify(beforeClaim.card) === JSON.stringify(after.card) && beforeClaim.scroll === after.scroll);
    await pg.screenshot({ path: path.join(SHOTS, 'referral-claimed-360x640.png') });
    console.log('shot referral-claimed-360x640.png');

    await pg.evaluate(() => document.querySelector('#sheet-referral .referral-x').click());
    await pg.waitForTimeout(600);
    const xClosed = await pg.evaluate(() => !document.getElementById('sheet-referral').classList.contains('open'));
    expect('engraved ✕ closes the sheet', xClosed);

    /* a centered shot of the profile card for the record */
    await pg.evaluate(() => {
      const pane = document.querySelector('#s-profile .pf-pane');
      pane.scrollTo(0, document.getElementById('pf-invite').offsetTop - 180);
    });
    await pg.waitForTimeout(300);
    await pg.screenshot({ path: path.join(SHOTS, 'referral-360x640.png') });
    console.log('shot referral-360x640.png');

    expect(`zero console errors @360 (${errors.slice(0, 2).join(' | ')})`, errors.length === 0);
    await ctx.close();
  }

  /* ================= 430x932 — the top of the range ================= */
  {
    const { ctx, pg, errors } = await makeContext(browser, 430, 932, 7777);
    await openProfile(pg);
    await seedReferral(pg, { joins: 2, unclaimed: 1000, earned: 1000, code: CODE, welcome: false, via: null });
    const prof = await profileSnapshot(pg);
    expect('430: card inside the pane, no horizontal overflow', prof.card.inPane && prof.worstOverflow <= 0.5 && prof.paneOverX <= 0);
    expect('430: zero document scroll', prof.docScroll <= 0);
    await pg.click('#pf-invite');
    await pg.waitForTimeout(600);
    const sheet = await sheetSnapshot(pg);
    expect(`430: sheet in view with a 1,000-coin ledger (${sheet.unclaimed})`, sheet.open && sheet.inView && sheet.unclaimed === '1,000' && !sheet.claimDisabled);
    await pg.click('#ref-claim');
    await pg.waitForTimeout(900);
    const after = await pg.evaluate(() => ({
      coins: document.getElementById('pf-coins').textContent.trim(),
      unclaimed: document.getElementById('ref-unclaimed').textContent.trim(),
    }));
    expect(`430: claim pays (${after.coins}, due ${after.unclaimed})`, after.coins === '2,850' && after.unclaimed === '0');
    await pg.screenshot({ path: path.join(SHOTS, 'referral-430x932.png') });
    console.log('shot referral-430x932.png');
    expect(`430: zero console errors (${errors.slice(0, 2).join(' | ')})`, errors.length === 0);
    await ctx.close();
  }

  /* ================= the invitee: a ref launch is server-authoritative ================= */
  {
    const { ctx, pg, errors } = await makeContext(browser, 360, 640, UID, 'ref_a1b2c3d4e5f6');
    await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(1200);
    const landed = await pg.evaluate(() => {
      const save = JSON.parse(localStorage.getItem('detour.save.v2'));
      return { coins: document.getElementById('p-coins').textContent.trim(), ref: save.referral, saveCoins: save.coins };
    });
    expect(`no Worker means no local welcome payout (${landed.coins})`,
      landed.coins === '1,850' && landed.saveCoins === 1850);
    expect('the ref launch does not mint a local welcome flag',
      landed.ref.welcome !== true && landed.ref.via === null);

    await pg.click('.dock-nav .tab[data-tab="profile"]');
    await pg.waitForTimeout(800);
    const toast = await pg.evaluate(() => ({
      shown: !document.getElementById('pf-toast').hidden,
      text: document.getElementById('pf-toast-t').textContent.trim(),
    }));
    expect('no referral toast is fabricated without the ledger', !toast.shown);

    await pg.reload({ waitUntil: 'networkidle' });
    await pg.waitForTimeout(1200);
    const again = await pg.evaluate(() => {
      const save = JSON.parse(localStorage.getItem('detour.save.v2'));
      return { coins: document.getElementById('p-coins').textContent.trim(), welcome: save.referral.welcome };
    });
    expect(`reload never pays a local bonus (${again.coins})`, again.coins === '1,850' && again.welcome !== true);
    expect(`zero console errors on the invitee path (${errors.slice(0, 2).join(' | ')})`, errors.length === 0);
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
console.log('all referral checks passed');
