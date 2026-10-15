/**
 * verify-stars-arena.mjs — serves ./dist and drives the ARENA tab (the 200 Stars
 * Arena showcase, drawn by src/compete.ts over the markup in index.html).
 *
 *   npm run build
 *   NODE_PATH="$TEMP/opencode/pwcheck/node_modules" node scripts/verify-stars-arena.mjs
 *
 * Layout, at 320x568 / 360x640 / 390x844:
 *  - the mock cup feed is gone: no cup names, no "… cups" kicker, no cup cards,
 *    no archive, no ticket pass and no mock-entry sheet left in the DOM,
 *  - the three tall 1st/2nd/3rd podium boxes are gone with them, and so is the
 *    recessed vault row — the split now lives on one compact prize ribbon,
 *  - the emblem is a faceted star, not a cup: `#i-star-3d` carries ten angular
 *    facets over two shared light ramps and the header mounts it on a clay squircle,
 *  - the header is complete: official pill, engraved "200 STARS ARENA" title, the
 *    hook, a live `HH:MM:SS` bracket clock and the three format pills, the last of
 *    which counts the paid places out of the prize ladder rather than claiming ten,
 *  - the centrepiece is the live standings: five contender rows, each with a rank
 *    pill, a sphere avatar, a flag, a TIQ + streak tag and a projected payout, over
 *    a pinned "You" row whose place and gap are computed from the same numbers,
 *  - the screen never scrolls (page, stage and card all stay inside the phone), the
 *    card fills the whole budget above the dock with no dead space, nothing
 *    overflows, and the CTA is a 48px+ key reading ENTER ARENA · PLAY MATCH,
 *  - no backdrop-filter and no blur() anywhere inside #s-arena: clay only.
 *
 * Then, on 360x640, the entry flow: the CTA opens the confirmation drawer, the
 * drawer locks the seat, the room fills by one, the bracket queue opens, and a
 * reload knows the seat — so the key goes straight to the queue without the drawer.
 * `.shots/arena/stars-<viewport>.png` is kept.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const OUT = path.resolve(here, '..', '.shots', 'arena');
fs.mkdirSync(OUT, { recursive: true });

const require = createRequire(path.resolve(here, '..', 'package.json'));   // playwright-core, dev-only
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core not found. Point NODE_PATH at a temp install, e.g.:\n' +
    '  NODE_PATH="$TEMP/opencode/pwcheck/node_modules" node scripts/verify-stars-arena.mjs');
  process.exit(2);
}
const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(String(req.url).split('?')[0]);
  if (p === '/') p = '/index.html';
  fs.readFile(path.join(DIST, p.slice(1)), (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`;

/* Everything the showcase promises, measured in the live page. */
const PROBE = `(function () {
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const over = (el) => el ? el.scrollWidth - el.clientWidth : 0;
  const txt = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
  /* scrollWidth lies on an ellipsis box, so measure the text run itself */
  const spill = (e, host) => {
    const n = typeof e === 'string' ? (host ?? document).querySelector(e) : e;
    if (!n || getComputedStyle(n).display === 'none') return 0;
    const rg = document.createRange();
    rg.selectNodeContents(n);
    return +(rg.getBoundingClientRect().right - n.getBoundingClientRect().right).toFixed(1);
  };
  const arena = document.getElementById('s-arena');
  const stage = document.getElementById('arena-scroll');
  const card = document.getElementById('stars-card');
  const dock = document.getElementById('tabs');
  const cta = document.getElementById('stars-cta');
  const meter = document.getElementById('stars-meter');
  const track = document.getElementById('stars-track');
  const field = document.getElementById('stars-field');
  const you = document.getElementById('stars-you');
  const emblem = document.querySelector('.stars-emblem');
  const cardBox = box(card), dockBox = box(dock), fieldBox = box(field);

  /* the emblem is a gem, not a decal: ten facets and two shared light ramps */
  const gem = document.getElementById('i-star-3d');
  const emblemUse = emblem?.querySelector('use');

  const rows = [...field.querySelectorAll('.ac-row')].map((r) => ({
    metal: r.dataset.metal ?? '',
    rank: r.querySelector('.ac-rank')?.textContent?.trim() ?? '',
    av: r.querySelector('.ac-av')?.textContent?.trim() ?? '',
    name: r.querySelector('.ac-name')?.textContent?.trim() ?? '',
    sub: r.querySelector('.ac-sub')?.textContent?.trim() ?? '',
    pay: r.querySelector('.ac-pay')?.textContent?.trim() ?? '',
    zero: !!r.querySelector('.ac-pay.is-zero'),
    flag: !!r.querySelector('.ac-flag .fp'),
    nameSpill: spill('.ac-name', r),
    h: +r.getBoundingClientRect().height.toFixed(1),
    /* a row the scroller cannot reach is a row that does not exist */
    seen: r.getBoundingClientRect().bottom <= fieldBox.b + 0.5 && r.getBoundingClientRect().top >= fieldBox.t - 0.5,
  }));

  /* clay only: every painted node in the arena, checked for a live blur */
  const blurs = [];
  for (const el of [arena, ...arena.querySelectorAll('*')]) {
    const cs = getComputedStyle(el);
    const bf = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
    if (bf && bf !== 'none' && /blur|saturate|brightness/i.test(bf)) blurs.push(el.className || el.tagName);
    if (cs.filter && cs.filter !== 'none' && /blur\\(/i.test(cs.filter)) blurs.push((el.className || el.tagName) + ' filter');
  }
  const text = document.body.innerText;
  return {
    title: txt('#arena-title'),
    official: txt('#stars-official'),
    name: txt('#stars-name'),
    hook: txt('#stars-hook'),
    count: txt('#stars-count'),
    specs: [...document.querySelectorAll('.stars-spec')].map((s) => s.textContent.trim()),
    gem: {
      facets: gem ? gem.querySelectorAll('polygon').length : 0,
      lit: !!document.getElementById('s3d-lit'),
      shade: !!document.getElementById('s3d-shade'),
      mounted: !!emblemUse && (emblemUse.getAttribute('href') || emblemUse.getAttribute('xlink:href')) === '#i-star-3d',
      box: box(emblem),
    },
    pool: txt('#stars-pool-n'),
    cuts: [...document.querySelectorAll('.stars-cut')].map((c) => ({
      place: c.dataset.place ?? '',
      metal: c.dataset.metal ?? '',
      stars: c.querySelector('.stars-cut-n')?.textContent?.trim() ?? '',
    })),
    ribbonH: box(document.getElementById('stars-ribbon'))?.h ?? 0,
    seats: txt('#stars-seats'),
    mood: txt('#stars-mood'),
    moodShown: getComputedStyle(document.getElementById('stars-mood')).display !== 'none',
    standingsT: txt('#stars-standings-t'),
    rows,
    you: {
      rank: txt('#stars-you-rank'),
      note: txt('#stars-you-note'),
      pay: txt('#stars-you-pay'),
      paid: you.classList.contains('is-paid'),
    },
    cta: txt('#stars-cta'),
    meterPct: +(parseFloat(meter.style.width) || 0).toFixed(1),
    meterPainted: +((meter.getBoundingClientRect().width / track.getBoundingClientRect().width) * 100).toFixed(1),
    track: { now: track.getAttribute('aria-valuenow'), max: track.getAttribute('aria-valuemax'), text: track.getAttribute('aria-valuetext') },
    mockCups: /Neon Rush|Violet Rampart Open|Midnight Circuit|Dawn Sprint|Arena feed|cups\\b/i.test(text),
    /* the purged furniture must stay purged, not merely hidden */
    purged: {
      podBoxes: document.querySelectorAll('.stars-pod').length,
      podium: !!document.getElementById('stars-podium'),
      vault: !!document.getElementById('stars-vault'),
      fillRow: !!document.querySelector('.stars-fill-row'),
      flatGlyph: document.querySelectorAll('.stars-glyph').length,
      toolbar: !!document.getElementById('arena-toolbar'),
      feed: !!document.getElementById('arena-feed-t'),
      cups: document.querySelectorAll('.arena-card, .arena-archive, .arena-pass, .arena-pass-claim').length,
      tourneySheet: !!document.getElementById('sheet-tourney'),
      pane: !!document.getElementById('comp-tournaments'),
    },
    scroll: {
      page: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      pageW: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      stage: stage.scrollHeight - stage.clientHeight,
      card: card.scrollHeight - card.clientHeight,
      fieldY: field.scrollHeight - field.clientHeight,
    },
    overflow: {
      card: over(card), head: over(document.querySelector('.stars-head')),
      ribbon: over(document.getElementById('stars-ribbon')), split: over(document.getElementById('stars-split')),
      specs: over(document.querySelector('.stars-specs')), ladderH: over(document.querySelector('.stars-ladder-h')),
      field: over(field),
      you: over(you), youNote: over(document.getElementById('stars-you-note')),
      cta: over(cta), arena: over(arena), stage: over(stage),
    },
    clipped: {
      name: spill('#stars-name'), hook: spill('#stars-hook'), count: spill('#stars-count'),
      cta: spill('#stars-cta'), seats: spill('#stars-seats'), standings: spill('#stars-standings-t'),
      youNote: spill('#stars-you-note'), spec: spill('.stars-spec'), cut: spill('.stars-cut'),
    },
    fits: {
      card: cardBox, dock: dockBox,
      /* the card must land on the dock, not float above it and not slide under it */
      gapToDock: +(dockBox.t - cardBox.b).toFixed(1),
      specsInside: box(document.querySelector('.stars-specs')).r <= cardBox.r + 0.5,
      ribbonInside: box(document.getElementById('stars-ribbon')).b <= cardBox.b + 0.5,
      fieldInside: fieldBox.b <= cardBox.b + 0.5,
      youInside: box(you).b <= cardBox.b + 0.5,
      ctaInside: box(cta).b <= cardBox.b + 0.5,
      cardH: +cardBox.h.toFixed(1),
      fieldH: +fieldBox.h.toFixed(1),
    },
    tap: { ctaH: +cta.getBoundingClientRect().height.toFixed(1), ctaW: +cta.getBoundingClientRect().width.toFixed(1) },
    blurs: blurs.slice(0, 4),
    blurCount: blurs.length,
    js: window.__starsErrors ?? null,
  };
})()`;

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const rows = [];
const bad = [];
const fail = (m) => bad.push(m);

for (const [w, h] of [[320, 568], [360, 640], [390, 844], [430, 932]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  await pg.goto(base, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(500);
  await pg.click('.tab[data-tab="arena"]');
  await pg.waitForTimeout(1200);
  const m = await pg.evaluate(PROBE);
  const tag = `${w}x${h}`;

  /* 1 — the mock cups are gone, the podium boxes are gone, and so is everything that carried them */
  if (m.mockCups) fail(`${tag}: a mock cup string is still on the page`);
  for (const [k, v] of Object.entries(m.purged)) if (v) fail(`${tag}: purged arena furniture left (${k} = ${v})`);

  /* 2 — the header: faceted star, engraved title, live clock, honest format pills */
  if (m.title !== 'Arena') fail(`${tag}: aria title reads "${m.title}"`);
  if (!/stars official/i.test(m.official ?? '')) fail(`${tag}: official pill reads "${m.official}"`);
  if (m.name !== '200 STARS ARENA') fail(`${tag}: title reads "${m.name}"`);
  if (m.hook !== 'Outsmart the grid. Claim real Telegram Stars.') fail(`${tag}: hook reads "${m.hook}"`);
  if (m.gem.facets !== 10) fail(`${tag}: the star has ${m.gem.facets} facets, want 10`);
  if (!m.gem.lit || !m.gem.shade) fail(`${tag}: the star lost a light ramp (lit=${m.gem.lit} shade=${m.gem.shade})`);
  if (!m.gem.mounted) fail(`${tag}: the header emblem is not mounted on #i-star-3d`);
  if (!m.gem.box || m.gem.box.w < 38 || Math.abs(m.gem.box.w - m.gem.box.h) > 1) {
    fail(`${tag}: the emblem is not a >=38px square (${JSON.stringify(m.gem.box)})`);
  }
  if (!/^\d{2}:\d{2}:\d{2}$/.test(m.count ?? '')) fail(`${tag}: bracket clock reads "${m.count}"`);
  if (m.specs.join('|') !== '1v1|8s Blitz|Top 3 Paid') fail(`${tag}: specs ${JSON.stringify(m.specs)}`);

  /* 3 — the ribbon: the pool and its exact split, on one compact line */
  if (m.pool !== '200') fail(`${tag}: pool reads "${m.pool}"`);
  const wantCuts = [['1', 'gold', '120'], ['2', 'silver', '50'], ['3', 'bronze', '30']];
  if (m.cuts.length !== 3) fail(`${tag}: the ribbon pays ${m.cuts.length} places`);
  m.cuts.forEach((c, i) => {
    const [place, metal, stars] = wantCuts[i] ?? [];
    if (c.place !== place || c.metal !== metal || c.stars !== stars) {
      fail(`${tag}: ribbon step ${i + 1} reads ${JSON.stringify(c)}`);
    }
  });
  if (m.ribbonH > 56) fail(`${tag}: the prize ribbon is ${m.ribbonH}px tall, not compact`);

  /* 4 — the live standings: five real contenders and a pinned You row */
  if (!/arena standings/i.test(m.standingsT ?? '')) fail(`${tag}: standings heading reads "${m.standingsT}"`);
  if (m.seats !== '184/256 contenders') fail(`${tag}: seats label reads "${m.seats}"`);
  if (m.mood !== 'Filling fast') fail(`${tag}: mood reads "${m.mood}"`);
  if (w >= 360 && !m.moodShown) fail(`${tag}: the mood word is hidden on a ${w}px phone`);
  if (m.rows.length !== 5) fail(`${tag}: the field shows ${m.rows.length} contenders, want 5`);
  const seen = m.rows.filter((r) => r.seen).length;
  if (seen < 3) fail(`${tag}: only ${seen} contender rows are reachable in the scroller`);
  /* a half-cut row is a swipe cue on a 568px floor, and a bug on anything taller */
  if (h >= 640 && seen < m.rows.length) fail(`${tag}: ${m.rows.length - seen} contender row(s) hang below the scroller`);
  m.rows.forEach((r, i) => {
    if (r.rank !== `#${i + 1}`) fail(`${tag}: row ${i + 1} rank pill reads "${r.rank}"`);
    if (!r.name || !r.av) fail(`${tag}: row ${i + 1} has no avatar or name`);
    if (!r.flag) fail(`${tag}: row ${i + 1} (${r.name}) carries no flag badge`);
    if (!/^[\d,]+ TIQ · \d+W streak$/.test(r.sub)) fail(`${tag}: row ${i + 1} stats tag reads "${r.sub}"`);
    if (r.nameSpill > 0.5) fail(`${tag}: row ${i + 1} name "${r.name}" spills ${r.nameSpill}px`);
    const want = wantCuts[i]?.[2];
    if (want && r.pay.replace(/\D/g, '') !== want) fail(`${tag}: row ${i + 1} projects "${r.pay}", want ${want}`);
    if (!want && !r.zero) fail(`${tag}: row ${i + 1} is outside the paid places but does not read as zero`);
  });
  if (!/^#\d+$/.test(m.you.rank)) fail(`${tag}: the You row ranks as "${m.you.rank}"`);
  if (!/TIQ/.test(m.you.note) || !/prize pool|seat locked/.test(m.you.note)) {
    fail(`${tag}: the You row reads "${m.you.note}"`);
  }

  /* 5 — geometry: no scroll, no overflow, no void above the dock */
  if (m.cta !== 'ENTER ARENA · PLAY MATCH') fail(`${tag}: the key reads "${m.cta}"`);
  for (const [k, v] of Object.entries(m.clipped)) if (v > 0.5) fail(`${tag}: ${k} spills ${v}px past its box`);
  if (Math.abs(m.meterPct - 71.9) > 0.6) fail(`${tag}: meter width ${m.meterPct}% (want 71.9)`);
  if (Math.abs(m.meterPainted - m.meterPct) > 2) fail(`${tag}: meter paints ${m.meterPainted}% for an inline ${m.meterPct}%`);
  if (m.track.now !== '184' || m.track.max !== '256') fail(`${tag}: meter aria ${JSON.stringify(m.track)}`);
  if (m.scroll.page > 1 || m.scroll.pageW > 1) fail(`${tag}: the page scrolls (${JSON.stringify(m.scroll)})`);
  if (m.scroll.stage > 1) fail(`${tag}: the arena stage scrolls by ${m.scroll.stage}px`);
  if (m.scroll.card > 1) fail(`${tag}: the card overflows by ${m.scroll.card}px`);
  for (const [k, v] of Object.entries(m.overflow)) if (v > 0) fail(`${tag}: ${k} overflows by ${v}px`);
  if (m.fits.gapToDock < -0.5) fail(`${tag}: the card slides under the dock by ${-m.fits.gapToDock}px`);
  if (m.fits.gapToDock > 12) fail(`${tag}: ${m.fits.gapToDock}px of dead space above the dock`);
  for (const k of ['specsInside', 'ribbonInside', 'fieldInside', 'youInside', 'ctaInside']) if (!m.fits[k]) fail(`${tag}: ${k} is false`);
  if (m.tap.ctaH < 48) fail(`${tag}: the CTA is ${m.tap.ctaH}px tall`);
  if (m.tap.ctaW < 48) fail(`${tag}: the CTA is ${m.tap.ctaW}px wide`);

  /* 6 — clay only */
  if (m.blurCount) fail(`${tag}: live blur inside #s-arena (${JSON.stringify(m.blurs)})`);

  if (errors.length) fail(`${tag}: js ${errors[0]}`);
  await pg.screenshot({ path: path.join(OUT, `stars-${tag}.png`) });
  rows.push(`layout ${tag}  card ${m.fits.cardH}px (ribbon ${m.ribbonH}, field ${m.fits.fieldH}, ${seen}/${m.rows.length} rows seen)  gap ${m.fits.gapToDock}px  meter ${m.meterPainted}%  clock "${m.count}"  you ${m.you.rank} "${m.you.note}"`);
  await ctx.close();
}

/* ---------- the entry flow, one phone ---------- */

const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true });
const pg = await ctx.newPage();
const errors = [];
pg.on('pageerror', (e) => errors.push(String(e)));
await pg.goto(base, { waitUntil: 'networkidle' });
await pg.waitForTimeout(400);
await pg.click('.tab[data-tab="arena"]');
await pg.waitForTimeout(1200);

const readArena = () => pg.evaluate(() => ({
  cta: document.getElementById('stars-cta').textContent.trim(),
  seats: document.getElementById('stars-seats').textContent.trim(),
  now: document.getElementById('stars-track').getAttribute('aria-valuenow'),
  youNote: document.getElementById('stars-you-note').textContent.trim(),
  sheetOpen: !document.getElementById('sheet-stars').hidden,
  queueOpen: !document.getElementById('overlay-matchmaking').hidden,
}));
const before = await readArena();
if (before.sheetOpen) fail('entry: the drawer was already open on entry');
if (before.queueOpen) fail('entry: the queue was already open on entry');

await pg.click('#stars-cta');
await pg.waitForTimeout(400);
const opened = await pg.evaluate(() => ({
  open: !document.getElementById('sheet-stars').hidden && document.getElementById('sheet-stars').classList.contains('open'),
  title: document.getElementById('stars-sheet-title').textContent.trim(),
  desc: document.getElementById('stars-sheet-desc').textContent.trim(),
  entry: document.getElementById('stars-sheet-entry').textContent.trim(),
  seat: document.getElementById('stars-sheet-seat').textContent.trim(),
  start: document.getElementById('stars-sheet-start').textContent.trim(),
  yes: document.getElementById('stars-sheet-yes').textContent.trim(),
}));
if (!opened.open) fail('entry: the CTA did not open the confirmation drawer');
if (!/take your seat/i.test(opened.title)) fail(`entry: drawer title reads "${opened.title}"`);
if (!/200 Stars Arena/.test(opened.desc)) fail(`entry: drawer copy reads "${opened.desc}"`);
if (!/8s Blitz/.test(opened.desc) || !/Top 3 Paid/.test(opened.desc)) fail(`entry: drawer specs read "${opened.desc}"`);
if (!/free/i.test(opened.entry)) fail(`entry: entry row reads "${opened.entry}"`);
if (opened.seat !== '184 / 256') fail(`entry: drawer seat reads "${opened.seat}"`);
if (!/^\d{2}:\d{2}:\d{2}$/.test(opened.start)) fail(`entry: drawer countdown reads "${opened.start}"`);
if (!/lock seat & play/i.test(opened.yes)) fail(`entry: confirm key reads "${opened.yes}"`);
await pg.screenshot({ path: path.join(OUT, 'stars-drawer-360x640.png') });

/* locking the seat fills the room, marks the You row and walks into the bracket */
await pg.click('#stars-sheet-yes');
await pg.waitForTimeout(900);
const after = await readArena();
if (after.sheetOpen) fail('entry: the drawer stayed open after locking the seat');
if (!after.queueOpen) fail('entry: locking the seat did not open the bracket queue');
if (after.seats !== '185/256 contenders') fail(`entry: the room reads "${after.seats}" after locking`);
if (after.now !== '185') fail(`entry: the meter reads ${after.now} after locking`);
if (!/seat locked/.test(after.youNote)) fail(`entry: the You row reads "${after.youNote}" after locking`);
await pg.screenshot({ path: path.join(OUT, 'stars-queue-360x640.png') });
await pg.click('#mm-cancel');
await pg.waitForTimeout(500);

/* a second visit still knows the seat — and skips the drawer, because entering is done */
await pg.reload({ waitUntil: 'networkidle' });
await pg.waitForTimeout(400);
await pg.click('.tab[data-tab="arena"]');
await pg.waitForTimeout(1200);
const again = await readArena();
if (again.seats !== '185/256 contenders') fail(`entry: after a reload the room reads "${again.seats}"`);
if (!/seat locked/.test(again.youNote)) fail(`entry: a reload forgot the seat (You row reads "${again.youNote}")`);
await pg.click('#stars-cta');
await pg.waitForTimeout(700);
const replay = await readArena();
if (replay.sheetOpen) fail('entry: a seated key opened the drawer instead of the queue');
if (!replay.queueOpen) fail('entry: a seated key did not open the bracket queue');
await pg.click('#mm-cancel');
await pg.waitForTimeout(400);

if (errors.length) fail(`entry: js ${errors[0]}`);
rows.push(`entry  184 -> 185 contenders, You "${after.youNote}", drawer "${opened.title}" / "${opened.yes}", queue opened on both paths`);
await ctx.close();

await browser.close();
srv.close();
console.log(rows.join('\n'));
if (bad.length) { console.error('\nFAIL\n - ' + bad.join('\n - ')); process.exit(1); }
console.log('\nstars arena checks passed');
