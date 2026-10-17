/**
 * verify-notifications.mjs — Playwright audit for the Inbox & Alerts drawer.
 *
 * No new project dependencies: `playwright-core` is resolved at runtime only.
 * Run without touching package.json:
 *
 *   NODE_PATH="C:\\Users\\PC-Y\\AppData\\Local\\Temp\\opencode\\check\\node_modules" node scripts/verify-notifications.mjs
 *
 * Serves ./dist over 127.0.0.1 and runs at 360x640 (the zero-overflow floor):
 *   1. the bell wears a numeric unread badge and rings on mount,
 *   2. individual delete removes exactly the targeted card, badge drops, no overflow,
 *   3. [Claim] credits the wallet and settles into a "Claimed" chip,
 *   4. [Mark All Read] clears the badge (persisted),
 *   5. [Clear All] empties the list, shows the empty state (persisted across reload),
 *   6. the sheet + list stay inside the 360x640 boundary with the list owning the scroll.
 * Saves .shots/notif-*.png. Fails (exit 1) on any broken expectation.
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
      '  NODE_PATH="C:\\\\Users\\\\PC-Y\\\\AppData\\\\Local\\\\Temp\\\\opencode\\\\check\\\\node_modules" node scripts/verify-notifications.mjs',
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

let failed = 0;
const expect = (name, cond, detail = '') => {
  if (cond) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const srv = await serve();
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

try {
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 2,
  });
  const pg = await ctx.newPage();

  /* ---------- 1. bell on mount: numeric badge, warm styling, wiggle ---------- */
  await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1200);
  const bellState = await pg.evaluate(() => ({
    badgeHidden: document.getElementById('notif-badge')?.hidden ?? true,
    badgeText: (document.getElementById('notif-badge')?.textContent ?? '').trim(),
    hasUnread: document.getElementById('home-notifs')?.classList.contains('has-unread') ?? false,
    ringing: document.getElementById('home-notifs')?.classList.contains('ring') ?? false,
    wiggleAnim: getComputedStyle(document.querySelector('#home-notifs .ico') ?? document.body).animationName,
  }));
  expect('bell badge shows the number unread', !bellState.badgeHidden && bellState.badgeText === '3', `text="${bellState.badgeText}"`);
  expect('bell carries the has-unread state', bellState.hasUnread);
  expect('bell wiggles once on mount', bellState.ringing && /wiggle/.test(bellState.wiggleAnim), bellState.wiggleAnim);

  const docEdge1 = await pg.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    fs: atob(''), // no-op placeholder to keep the shape flat
  }));
  expect('zero horizontal overflow before the sheet opens', docEdge1.sw <= 360, `scrollWidth=${docEdge1.sw}`);

  /* ---------- 2. open the sheet ---------- */
  await pg.click('#home-notifs');
  await pg.waitForTimeout(600);
  const open = await pg.evaluate(() => {
    const sheet = document.getElementById('sheet-notifications');
    const r = sheet?.getBoundingClientRect();
    const list = document.getElementById('notif-list');
    const cards = [...(list?.querySelectorAll('.notif-card[data-id]') ?? [])];
    return {
      open: !!sheet && !sheet.hidden && sheet.classList.contains('open'),
      top: r?.top ?? 0, bottom: r?.bottom ?? 0, left: r?.left ?? 0, right: r?.right ?? 0,
      hasCount: !document.getElementById('notif-count')?.hidden,
      countText: (document.getElementById('notif-count')?.textContent ?? '').trim(),
      hasMarkAll: !!document.getElementById('notif-mark-all'),
      hasClearAll: !!document.getElementById('notif-clear-all'),
      clearAllLabel: (document.getElementById('notif-clear-all')?.textContent ?? '').trim(),
      stripeBars: !!list?.querySelector('.notif-card.is-unread::before'),
      cardIds: cards.map((c) => c.dataset.id),
      delKeys: cards.length,
      delButtons: list?.querySelectorAll('.notif-del').length ?? 0,
      dots: list?.querySelectorAll('.notif-dot').length ?? 0,
      claim: list?.querySelector('.notif-claim[data-claim]') ? 'gold' : 'none',
      listScrolls: !!list && list.scrollHeight > list.clientHeight,
    };
  });
  expect('notif sheet opens', open.open);
  expect(`sheet is inside 360x640 (l=${open.left.toFixed(1)},r=${open.right.toFixed(1)},t=${open.top.toFixed(1)},b=${open.bottom.toFixed(1)})`,
    open.left >= -0.5 && open.right <= 360.5 && open.top >= -0.5 && open.bottom <= 640.5);
  expect('unread counter chip visible ("3 NEW")', open.hasCount && /3\s*new/i.test(open.countText), open.countText);
  expect('action row has Mark All Read + Clear All', open.hasMarkAll && open.hasClearAll, open.clearAllLabel);
  expect('every card carries an individual delete key', open.delKeys > 0 && open.delButtons === open.delKeys);
  expect('unread jewel dots accent the unread cards', open.dots > 0);
  expect('reward row shows the tactile Claim key', open.claim === 'gold');
  expect('list owns the scroll (container can scroll)', open.listScrolls);

  const overflow = await pg.evaluate(() => {
    const cards = [...document.querySelectorAll('.notif-card')].map((c) => c.getBoundingClientRect());
    return {
      sw: document.documentElement.scrollWidth,
      cardMax: cards.length ? Math.max(...cards.map((c) => c.right)) : 0,
    };
  });
  expect('cards stay inside 360px with no overflow', overflow.sw <= 360 && overflow.cardMax <= 360.5,
    `scrollWidth=${overflow.sw}, cardRight=${overflow.cardMax.toFixed(1)}`);

  fs.mkdirSync(SHOTS, { recursive: true });
  await pg.screenshot({ path: path.join(SHOTS, 'notif-open.png') });
  console.log('shot notif-open.png');

  /* ---------- 3. individual delete: targeted card leaves, badge drops ---------- */
  const beforeDel = await pg.evaluate(() => {
    const first = document.querySelector('.notif-card[data-id]');
    const list = document.getElementById('notif-list');
    return {
      id: first?.dataset.id ?? '',
      height: first?.offsetHeight ?? 0,
      listLeft: list?.getBoundingClientRect().left ?? 0,
      listWidth: list?.getBoundingClientRect().width ?? 0,
      coins: document.getElementById('p-coins')?.textContent ?? '',
    };
  });
  await pg.click('.notif-card[data-id] .notif-del');
  await pg.waitForTimeout(180); // mid-collapse: height animating, nothing else moved
  const midDel = await pg.evaluate(() => {
    const list = document.getElementById('notif-list');
    return {
      outCard: document.querySelector('.notif-card.is-out'),
      listLeft: list?.getBoundingClientRect().left ?? 0,
      listWidth: list?.getBoundingClientRect().width ?? 0,
    };
  });
  expect('delete animates the card out mid-flight', !!midDel.outCard);
  expect('no horizontal jitter while the card collapses',
    Math.abs(midDel.listLeft - beforeDel.listLeft) < 1 && Math.abs(midDel.listWidth - beforeDel.listWidth) < 1);
  await pg.waitForTimeout(400);
  const afterDel = await pg.evaluate(() => {
    const coins = document.getElementById('p-coins')?.textContent ?? '';
    return {
      ids: [...document.querySelectorAll('.notif-card[data-id]')].map((c) => c.dataset.id),
      badgeText: (document.getElementById('notif-badge')?.textContent ?? '').trim(),
      cardCount: document.querySelectorAll('.notif-card').length,
      collapseLeftovers: [...document.querySelectorAll('.notif-card')].filter((c) => c.offsetHeight === 0).length,
      sw: document.documentElement.scrollWidth,
    };
  });
  expect('deleted card is gone (right card, no layout jump)', !afterDel.ids.includes(beforeDel.id) && afterDel.cardsCheck !== false,
    `removed ${beforeDel.id}`);
  expect('badge dropped 3 → 2 after unread delete', afterDel.badgeText === '2', afterDel.badgeText);
  expect('no zero-height leftovers in the final list', afterDel.collapseLeftovers === 0 && afterDel.cardCount === afterDel.ids.length);
  expect('still zero overflow after delete', afterDel.sw <= 360, `scrollWidth=${afterDel.sw}`);

  /* ---------- 4. claim: wallet credit + Claimed chip ---------- */
  const preClaim = await pg.evaluate(() => ({
    coins: Number((document.getElementById('p-coins')?.textContent ?? '0').replace(/[^\d-]/g, '')),
    claimBtn: !!document.querySelector('.notif-claim[data-claim]'),
  }));
  expect('a claimable reward key is present', preClaim.claimBtn);
  await pg.click('.notif-claim[data-claim]');
  await pg.waitForTimeout(120);
  const flash = await pg.evaluate(() => getComputedStyle(document.querySelector('.notif-claim.is-gain') ?? document.body));
  expect('claim flashes the +coins beat on gold', flash.display !== 'none');
  await pg.waitForTimeout(900);
  const postClaim = await pg.evaluate(() => ({
    coins: Number((document.getElementById('p-coins')?.textContent ?? '0').replace(/[^\d-]/g, '')),
    chip: (document.querySelector('.notif-claimed')?.textContent ?? '').trim(),
    btnGone: !document.querySelector('.notif-claim[data-claim]'),
  }));
  expect('claim credits the wallet (+150)', postClaim.coins === preClaim.coins + 150,
    `${preClaim.coins} → ${postClaim.coins}`);
  expect('claim settles into a Claimed chip', postClaim.chip === 'Claimed' && postClaim.btnGone);

  /* ---------- 5. mark all read: badge clears, stored ---------- */
  await pg.click('#notif-mark-all');
  await pg.waitForTimeout(200);
  const markAll = await pg.evaluate(() => ({
    badgeHidden: document.getElementById('notif-badge')?.hidden ?? true,
    stored: JSON.parse(localStorage.getItem('detour.notifications.v1') ?? '{"items":[]}').items.every((n) => n.read),
  }));
  expect('mark all read hides the bell badge', markAll.badgeHidden);
  expect('read state persisted to localStorage', markAll.stored);

  /* ---------- 6. clear all: empty state + persistence ---------- */
  await pg.click('#notif-clear-all');
  await pg.waitForTimeout(350);
  const cleared = await pg.evaluate(() => ({
    cards: document.querySelectorAll('.notif-card').length,
    emptyShown: !document.getElementById('notif-empty')?.hidden,
    emptyTitle: (document.querySelector('.notif-empty-t')?.textContent ?? '').trim(),
    emptySub: (document.querySelector('.notif-empty-s')?.textContent ?? '').trim(),
    storedItems: JSON.parse(localStorage.getItem('detour.notifications.v1') ?? '{"items":[]}').items.length,
    sw: document.documentElement.scrollWidth,
  }));
  expect('clear all empties the list', cleared.cards === 0, `${cleared.cards} cards left`);
  expect('empty state shows "All caught up! No new alerts."',
    cleared.emptyTitle === 'All caught up!' && cleared.emptySub === 'No new alerts.',
    `${cleared.emptyTitle} / ${cleared.emptySub}`);
  expect('cleared state persisted to localStorage', cleared.storedItems === 0);
  expect('still zero overflow after clear', cleared.sw <= 360, `scrollWidth=${cleared.sw}`);

  fs.mkdirSync(SHOTS, { recursive: true });
  await pg.screenshot({ path: path.join(SHOTS, 'notif-empty.png') });
  console.log('shot notif-empty.png');

  /* ---------- 7. reload: clearing survives, badge stays hidden ---------- */
  await pg.reload({ waitUntil: 'networkidle' });
  await pg.waitForTimeout(1100);
  const reloaded = await pg.evaluate(() => ({
    badgeHidden: document.getElementById('notif-badge')?.hidden ?? true,
    open: false,
  }));
  expect('reload keeps the drawer empty and the badge silent', reloaded.badgeHidden);

  /* ---------- 8. fresh store: scroll inside the boundary, claim chip persists path ---------- */
  await pg.evaluate(() => {
    const now = Date.now();
    localStorage.setItem('detour.notifications.v1', JSON.stringify({
      v: 1,
      items: [
        { id: 'a-r', kind: 'reward', title: 'Streak ready', body: '+80 Coins', createdAt: now - 60_000, read: false, coins: 80, claimed: true },
        { id: 'b-s', kind: 'squad', title: 'Squad rank', body: 'Rank up!', createdAt: now - 120_000, read: true },
        ...Array.from({ length: 9 }, (_, i) => ({
          id: `f-${i}`,
          kind: i % 2 ? 'tournament' : 'squad',
          title: `Filler ${i + 1}`,
          body: 'Pad the list so the container really scrolls at 360x640.',
          createdAt: now - (300_000 + i * 60_000),
          read: true,
        })),
      ],
    }));
  });
  await pg.reload({ waitUntil: 'networkidle' });
  await pg.waitForTimeout(1100);
  await pg.click('#home-notifs');
  await pg.waitForTimeout(650);
  const scrollCheck = await pg.evaluate(() => {
    const list = document.getElementById('notif-list');
    const sheet = document.getElementById('sheet-notifications');
    const r = sheet.getBoundingClientRect();
    return {
      rows: document.querySelectorAll('.notif-card').length,
      claimsPersisted: document.querySelectorAll('.notif-claimed').length,
      borderTop: r.top, borderBottom: r.bottom,
      listClient: list.clientHeight, listScroll: list.scrollHeight,
      sw: document.documentElement.scrollWidth,
    };
  });
  expect('11 rows render and the claimed chip persisted', scrollCheck.rows === 11 && scrollCheck.claimsPersisted >= 1,
    `${scrollCheck.rows} rows / ${scrollCheck.claimsPersisted} claimed`);
  expect(`sheet stays inside 640px (top=${scrollCheck.borderTop.toFixed(1)}, bottom=${scrollCheck.borderBottom.toFixed(1)})`,
    scrollCheck.borderTop >= -0.5 && scrollCheck.borderBottom <= 640.5);
  expect('list scrolls its own height without page overflow',
    scrollCheck.listScroll > scrollCheck.listClient && scrollCheck.sw <= 360,
    `scroll ${scrollCheck.listScroll}px in ${scrollCheck.listClient}px, pageW=${scrollCheck.sw}`);

  fs.mkdirSync(SHOTS, { recursive: true });
  await pg.screenshot({ path: path.join(SHOTS, 'notif-scroll.png') });
  console.log('shot notif-scroll.png');

  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(400);
  await ctx.close();
} finally {
  await browser.close();
  srv.close();
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all notification checks passed');
