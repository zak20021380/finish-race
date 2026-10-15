/**
 * verify-stars-arena.mjs — serves ./dist and drives the ARENA tab (the 200 Stars
 * Grand Cup showcase, drawn by src/compete.ts over the markup in index.html).
 *
 *   npm run build
 *   NODE_PATH="$TEMP/opencode/pwcheck/node_modules" node scripts/verify-stars-arena.mjs
 *
 * Layout, at 320x568 / 360x640 / 390x844:
 *  - the mock cup feed is gone: no cup names, no "… cups" kicker, no cup cards,
 *    no archive, no ticket pass and no mock-entry sheet left in the DOM,
 *  - the showcase is complete: official pill, engraved title, hook, the 200 Star
 *    vault, the 120/50/30 podium with its gold/silver/bronze rims, the three spec
 *    pills, "184 / 256 Contenders · Filling fast" over the fill meter and a live
 *    "Starts in HH:MM:SS" countdown,
 *  - the screen never scrolls (page, stage and card all stay inside the phone),
 *    the card fills the whole budget above the dock with no dead space, nothing
 *    overflows, and the CTA is a 52px key,
 *  - no backdrop-filter and no blur() anywhere inside #s-arena: clay only.
 *
 * Then, on 360x640, the seat flow: the CTA opens the confirmation drawer, the
 * drawer locks the seat, the key flips to SEAT LOCKED, the room fills by one, and
 * a reload still knows the seat. `.shots/arena/stars-<viewport>.png` is kept.
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
  const box = (el) => { const b = el.getBoundingClientRect();
    return { t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const over = (el) => el ? el.scrollWidth - el.clientWidth : 0;
  const txt = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
  const arena = document.getElementById('s-arena');
  const stage = document.getElementById('arena-scroll');
  const card = document.getElementById('stars-card');
  const dock = document.getElementById('tabs');
  const cta = document.getElementById('stars-cta');
  const meter = document.getElementById('stars-meter');
  const track = document.getElementById('stars-track');
  const cardBox = box(card), dockBox = box(dock);
  const pods = [...document.querySelectorAll('.stars-pod')];
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
    vault: txt('#stars-vault'),
    podium: pods.map((p) => ({
      cls: p.className,
      place: p.querySelector('.stars-pod-place')?.textContent?.trim() ?? '',
      stars: p.querySelector('.stars-pod-n')?.textContent?.trim() ?? '',
      crest: p.querySelector('.stars-pod-crest')?.textContent?.trim() ?? '',
    })),
    specs: [...document.querySelectorAll('.stars-spec')].map((s) => s.textContent.trim()),
    fill: txt('#stars-fill-seats'),
    mood: txt('#stars-mood'),
    count: txt('#stars-count'),
    cta: txt('#stars-cta'),
    meterPct: +(parseFloat(meter.style.width) || 0).toFixed(1),
    meterPainted: +((meter.getBoundingClientRect().width / track.getBoundingClientRect().width) * 100).toFixed(1),
    track: { now: track.getAttribute('aria-valuenow'), max: track.getAttribute('aria-valuemax'), text: track.getAttribute('aria-valuetext') },
    mockCups: /Neon Rush|Violet Rampart Open|Midnight Circuit|Dawn Sprint|Arena feed|cups\\b/i.test(text),
    legacy: {
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
      stageTop: stage.scrollTop,
      card: card.scrollHeight - card.clientHeight,
    },
    overflow: {
      card: over(card), head: over(document.querySelector('.stars-head')), vault: over(document.querySelector('.stars-vault')),
      podium: over(document.getElementById('stars-podium')), fillRow: over(document.querySelector('.stars-fill-row')),
      cta: over(cta), arena: over(arena), stage: over(stage),
    },
    fits: {
      card: cardBox, dock: dockBox,
      /* the card must land on the dock, not float above it and not slide under it */
      gapToDock: +(dockBox.t - cardBox.b).toFixed(1),
      specsInside: box(document.querySelector('.stars-specs')).r <= cardBox.r + 0.5,
      podiumInside: box(document.getElementById('stars-podium')).b <= cardBox.b + 0.5,
      ctaInside: box(cta).b <= cardBox.b + 0.5,
      vaultH: +document.querySelector('.stars-vault').getBoundingClientRect().height.toFixed(1),
      podiumH: +document.getElementById('stars-podium').getBoundingClientRect().height.toFixed(1),
      cardH: +cardBox.h.toFixed(1),
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

for (const [w, h] of [[320, 568], [360, 640], [390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  await pg.goto(base, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(500);
  await pg.click('.tab[data-tab="arena"]');
  await pg.waitForTimeout(700);
  const m = await pg.evaluate(PROBE);
  const tag = `${w}x${h}`;

  /* 1 — the mock cups are gone, and so is everything that carried them */
  if (m.mockCups) fail(`${tag}: a mock cup string is still on the page`);
  for (const [k, v] of Object.entries(m.legacy)) if (v) fail(`${tag}: legacy arena furniture left (${k})`);

  /* 2 — the showcase is complete */
  if (m.title !== 'Arena') fail(`${tag}: aria title reads "${m.title}"`);
  if (!/stars official/i.test(m.official ?? '')) fail(`${tag}: official pill reads "${m.official}"`);
  if (m.name !== '200 STARS GRAND CUP') fail(`${tag}: title reads "${m.name}"`);
  if (m.hook !== 'Outsmart the grid. Claim real Telegram Stars.') fail(`${tag}: hook reads "${m.hook}"`);
  if (!/200 TELEGRAM STARS/.test(m.vault ?? '')) fail(`${tag}: vault reads "${m.vault}"`);
  const wantStars = ['120', '50', '30'];
  const order = m.podium.map((p) => p.stars);
  if (order.join('|') !== wantStars.join('|')) fail(`${tag}: podium pays ${JSON.stringify(order)}`);
  for (const [i, metal] of ['gold', 'silver', 'bronze'].entries()) {
    if (!m.podium[i].cls.includes(`is-${metal}`)) fail(`${tag}: podium ${i + 1} lost its ${metal} rim (${m.podium[i].cls})`);
  }
  if (!/grandmaster/i.test(m.podium[0].crest)) fail(`${tag}: 1st place crest reads "${m.podium[0].crest}"`);
  if (m.specs.join('|') !== '1v1 Knockout|15s Blitz|Fair Matchmaking') fail(`${tag}: specs ${JSON.stringify(m.specs)}`);
  if (m.fill !== '184 / 256 Contenders') fail(`${tag}: fill label reads "${m.fill}"`);
  if (m.mood !== 'Filling fast') fail(`${tag}: mood reads "${m.mood}"`);
  if (!/^Starts in \d{2}:\d{2}:\d{2}$/.test(m.count ?? '')) fail(`${tag}: countdown reads "${m.count}"`);
  if (m.track.now !== '184' || m.track.max !== '256') fail(`${tag}: meter aria ${JSON.stringify(m.track)}`);
  if (Math.abs(m.meterPct - 71.9) > 0.2) fail(`${tag}: meter width ${m.meterPct}% (want 71.9)`);
  if (Math.abs(m.meterPainted - m.meterPct) > 2) fail(`${tag}: meter paints ${m.meterPainted}% for an inline ${m.meterPct}%`);
  if (m.cta !== 'REGISTER FOR ARENA') fail(`${tag}: CTA reads "${m.cta}"`);

  /* 3 — geometry: no scroll, no overflow, no void above the dock */
  if (m.scroll.page > 1 || m.scroll.pageW > 1) fail(`${tag}: the page scrolls (${JSON.stringify(m.scroll)})`);
  if (m.scroll.stage > 1) fail(`${tag}: the arena stage scrolls by ${m.scroll.stage}px`);
  if (m.scroll.card > 1) fail(`${tag}: the card overflows by ${m.scroll.card}px`);
  for (const [k, v] of Object.entries(m.overflow)) if (v > 0) fail(`${tag}: ${k} overflows by ${v}px`);
  if (m.fits.gapToDock < -0.5) fail(`${tag}: the card slides under the dock by ${-m.fits.gapToDock}px`);
  if (m.fits.gapToDock > 12) fail(`${tag}: ${m.fits.gapToDock}px of dead space above the dock`);
  for (const k of ['specsInside', 'podiumInside', 'ctaInside']) if (!m.fits[k]) fail(`${tag}: ${k} is false`);
  if (m.tap.ctaH < 48) fail(`${tag}: the CTA is ${m.tap.ctaH}px tall`);
  if (m.tap.ctaW < 48) fail(`${tag}: the CTA is ${m.tap.ctaW}px wide`);

  /* 4 — clay only */
  if (m.blurCount) fail(`${tag}: live blur inside #s-arena (${JSON.stringify(m.blurs)})`);

  if (errors.length) fail(`${tag}: js ${errors[0]}`);
  await pg.screenshot({ path: path.join(OUT, `stars-${tag}.png`) });
  rows.push(`layout ${tag}  card ${m.fits.cardH}px (vault ${m.fits.vaultH}, podium ${m.fits.podiumH})  gap ${m.fits.gapToDock}px  meter ${m.meterPainted}%  "${m.count}"`);
  await ctx.close();
}

/* ---------- the seat flow, one phone ---------- */

const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true });
const pg = await ctx.newPage();
const errors = [];
pg.on('pageerror', (e) => errors.push(String(e)));
await pg.goto(base, { waitUntil: 'networkidle' });
await pg.waitForTimeout(400);
await pg.click('.tab[data-tab="arena"]');
await pg.waitForTimeout(600);

const readCta = () => pg.evaluate(() => ({
  cta: document.getElementById('stars-cta').textContent.trim(),
  seats: document.getElementById('stars-fill-seats').textContent.trim(),
  now: document.getElementById('stars-track').getAttribute('aria-valuenow'),
  sheetOpen: !document.getElementById('sheet-stars').hidden,
}));
const before = await readCta();
if (before.sheetOpen) fail('seat: the drawer was already open on entry');

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
  yesDisabled: document.getElementById('stars-sheet-yes').disabled,
}));
if (!opened.open) fail('seat: the CTA did not open the confirmation drawer');
if (!/take your seat/i.test(opened.title)) fail(`seat: drawer title reads "${opened.title}"`);
if (!/200 Stars Grand Cup/.test(opened.desc)) fail(`seat: drawer copy reads "${opened.desc}"`);
if (!/free/i.test(opened.entry)) fail(`seat: entry row reads "${opened.entry}"`);
if (opened.seat !== '184 / 256') fail(`seat: drawer seat reads "${opened.seat}"`);
if (!/^\d{2}:\d{2}:\d{2}$/.test(opened.start)) fail(`seat: drawer countdown reads "${opened.start}"`);
if (!/lock my seat/i.test(opened.yes) || opened.yesDisabled) fail(`seat: confirm key reads "${opened.yes}" disabled=${opened.yesDisabled}`);
await pg.screenshot({ path: path.join(OUT, 'stars-drawer-360x640.png') });

await pg.click('#stars-sheet-yes');
await pg.waitForTimeout(600);
const after = await readCta();
if (after.sheetOpen) fail('seat: the drawer stayed open after locking the seat');
if (!/seat locked/i.test(after.cta)) fail(`seat: the key reads "${after.cta}" after locking`);
if (after.seats !== '185 / 256 Contenders') fail(`seat: the room reads "${after.seats}" after locking`);
if (after.now !== '185') fail(`seat: the meter reads ${after.now} after locking`);
await pg.screenshot({ path: path.join(OUT, 'stars-seated-360x640.png') });

/* a second visit still knows the seat: the key is not a one-shot */
await pg.reload({ waitUntil: 'networkidle' });
await pg.waitForTimeout(400);
await pg.click('.tab[data-tab="arena"]');
await pg.waitForTimeout(600);
const again = await readCta();
if (!/seat locked/i.test(again.cta)) fail(`seat: a reload forgot the seat (key reads "${again.cta}")`);
if (again.seats !== '185 / 256 Contenders') fail(`seat: after a reload the room reads "${again.seats}"`);
await pg.click('#stars-cta');
await pg.waitForTimeout(400);
const reopen = await pg.evaluate(() => ({
  open: !document.getElementById('sheet-stars').hidden,
  yes: document.getElementById('stars-sheet-yes').disabled,
  title: document.getElementById('stars-sheet-title').textContent.trim(),
}));
if (!reopen.open) fail('seat: a seated CTA no longer opens the confirmation');
if (!reopen.yes) fail('seat: the seated drawer still offers Lock my seat');
if (!/seat is locked/i.test(reopen.title)) fail(`seat: the seated drawer reads "${reopen.title}"`);
await pg.keyboard.press('Escape');
await pg.waitForTimeout(400);

if (errors.length) fail(`seat: js ${errors[0]}`);
rows.push(`seat  184 -> 185 contenders, key "${after.cta}", drawer text "${opened.title}" / "${opened.yes}"`);
await ctx.close();

await browser.close();
srv.close();
console.log(rows.join('\n'));
if (bad.length) { console.error('\nFAIL\n - ' + bad.join('\n - ')); process.exit(1); }
console.log('\nstars arena checks passed');
