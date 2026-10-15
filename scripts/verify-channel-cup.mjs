/**
 * verify-channel-cup.mjs — serves ./dist and drives the ARENA tab as the
 * 200 Stars CHANNEL CUP: a Telegram channel/squad championship whose one card
 * opens into that channel's Top-10 roster sheet.
 *
 *   npm run build
 *   node scripts/verify-channel-cup.mjs
 *
 * One phone, 360x640, because that is the fit the pivot has to hold:
 *  - the header carries the Star emblem, "200 STARS CHANNEL CUP" and the rule
 *    badge that explains where the pool actually goes, over a live HH:MM:SS clock,
 *  - the podium is three CHANNELS (rank badge, verified channel mark, handle,
 *    squad TIQ, member count, roster cue) and only #1 wears the 200-Star pool,
 *  - two runner channels follow, each with a chevron, then the pinned squad row,
 *    then a >=48px PLAY FOR YOUR SQUAD key,
 *  - tapping a channel opens the roster sheet with exactly ten contributors,
 *    ranked 1..10, whose projected payouts sum to the 200-Star pool; the close
 *    key and the backdrop both shut it,
 *  - the stage never scrolls and nothing spills its box, and no blur or
 *    backdrop-filter is live on the screen or its sheet.
 *
 * `.shots/arena/channel-cup-360x640.png` and `channel-cup-roster.png` are kept.
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

const require = createRequire(path.resolve(here, '..', 'package.json'));
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core not found. Install it, or point NODE_PATH at a copy.');
  process.exit(2);
}
const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

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
  const squad = document.getElementById('stars-squad');
  const emblem = document.querySelector('.stars-emblem');
  const cardBox = box(card), dockBox = box(dock);

  const pods = [...document.querySelectorAll('.stars-pod')].map((li) => ({
    rank: li.dataset.rank ?? '',
    metal: li.dataset.metal ?? '',
    role: li.getAttribute('role') ?? '',
    haspopup: li.getAttribute('aria-haspopup') ?? '',
    badge: li.querySelector('.stars-pod-rank')?.textContent?.trim() ?? '',
    mark: li.querySelector('.stars-ch-av .stars-ch-t')?.textContent?.trim() ?? '',
    tick: !!li.querySelector('.stars-ch-verify use'),
    name: li.querySelector('.stars-pod-name')?.textContent?.trim() ?? '',
    tiq: li.querySelector('.stars-pod-tiq')?.textContent?.trim() ?? '',
    mem: li.querySelector('.stars-pod-mem')?.textContent?.trim() ?? '',
    pool: li.querySelector('.stars-pod-prize')?.textContent?.trim() ?? '',
    hint: li.querySelector('.stars-pod-hint')?.textContent?.trim() ?? '',
    nameSpill: spill('.stars-pod-name', li),
    tiqSpill: spill('.stars-pod-tiq', li),
    memSpill: spill('.stars-pod-mem', li),
    hintSpill: spill('.stars-pod-hint', li),
    h: +li.getBoundingClientRect().height.toFixed(1),
  }));

  const runs = [...document.querySelectorAll('.stars-run')].map((li) => ({
    rank: li.querySelector('.stars-run-rank')?.textContent?.trim() ?? '',
    name: li.querySelector('.stars-run-nm')?.textContent?.trim() ?? '',
    mem: li.querySelector('.stars-run-mem')?.textContent?.trim() ?? '',
    tiq: li.querySelector('.stars-run-tiq')?.textContent?.trim() ?? '',
    go: !!li.querySelector('.stars-run-go use'),
    nameSpill: spill('.stars-run-nm', li),
    memSpill: spill('.stars-run-mem', li),
    h: +li.getBoundingClientRect().height.toFixed(1),
  }));

  const emblemImg = document.querySelector('.stars-emblem-img');

  /* clay only: every painted node on the screen and its sheet */
  const blurs = [];
  for (const root of [arena, document.getElementById('sheet-roster')]) {
    if (!root) continue;
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const cs = getComputedStyle(el);
      const bf = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
      if (bf && bf !== 'none' && /blur|saturate|brightness/i.test(bf)) blurs.push(el.className || el.tagName);
      if (cs.filter && cs.filter !== 'none' && /blur\\(/i.test(cs.filter)) blurs.push((el.className || el.tagName) + ' filter');
    }
  }

  return {
    title: txt('#arena-title'),
    name: txt('#stars-name'),
    hook: txt('#stars-hook'),
    count: txt('#stars-count'),
    emblem: { box: box(emblem), src: emblemImg ? emblemImg.getAttribute('src') : null },
    pods, runs,
    squad: {
      chip: txt('#stars-squad-chip'),
      name: txt('#stars-squad-name'),
      note: txt('#stars-squad-note'),
      mark: txt('#stars-squad-letter'),
      nameSpill: spill('#stars-squad-name'),
      noteSpill: spill('#stars-squad-note'),
      h: +squad.getBoundingClientRect().height.toFixed(1),
    },
    cta: txt('#stars-cta'),
    ctaBox: box(cta),
    purged: {
      contenderRows: document.querySelectorAll('.ac-row').length,
      ribbon: !!document.getElementById('stars-ribbon'),
      meter: !!document.getElementById('stars-meter'),
      youRow: !!document.getElementById('stars-you'),
      flatGlyph: document.querySelectorAll('.stars-glyph').length,
    },
    scroll: {
      page: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      pageW: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      stage: stage.scrollHeight - stage.clientHeight,
      card: card.scrollHeight - card.clientHeight,
    },
    overflow: {
      card: over(card), head: over(document.querySelector('.stars-head')),
      rule: over(document.querySelector('.stars-rule-t')), count: over(document.querySelector('.stars-count')),
      podium: over(document.getElementById('stars-podium')), runners: over(document.getElementById('stars-runners')),
      squad: over(squad), cta: over(cta), arena: over(arena), stage: over(stage),
    },
    clipped: {
      name: spill('#stars-name'), count: spill('#stars-count'),
      cta: spill('#stars-cta'), chip: spill('#stars-squad-chip'),
    },
    fits: {
      gapToDock: +(dockBox.t - cardBox.b).toFixed(1),
      podInside: [...document.querySelectorAll('.stars-pod')].every((p) => box(p).b <= cardBox.b + 0.5),
      squadInside: box(squad).b <= cardBox.b + 0.5,
      ctaInside: box(cta).b <= cardBox.b + 0.5,
      cardH: +cardBox.h.toFixed(1),
      viewportH: innerHeight,
    },
    blurs: blurs.slice(0, 4),
    blurCount: blurs.length,
  };
})()`;

const ROSTER = `(function () {
  const sheet = document.getElementById('sheet-roster');
  const box = (el) => { const b = el.getBoundingClientRect(); return { t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), h: +b.height.toFixed(1), w: +b.width.toFixed(1) }; };
  const rows = [...sheet.querySelectorAll('.sr-row')].map((li) => ({
    rank: li.querySelector('.sr-medal')?.textContent?.trim() ?? '',
    av: li.querySelector('.stars-av-t')?.textContent?.trim() ?? '',
    flag: !!li.querySelector('.stars-av-flag .fp'),
    name: li.querySelector('.sr-nm')?.textContent?.trim() ?? '',
    tiq: li.querySelector('.sr-tiq')?.textContent?.trim() ?? '',
    pay: li.querySelector('.sr-pay')?.textContent?.trim() ?? '',
    star: !!li.querySelector('.sr-pay-star'),
    you: !!li.querySelector('.sr-you-tag'),
  }));
  const list = document.getElementById('sr-list');
  return {
    open: !sheet.hidden && sheet.classList.contains('open'),
    head: {
      rank: document.getElementById('sr-rank')?.textContent?.trim() ?? '',
      name: document.getElementById('sr-name')?.textContent?.trim() ?? '',
      sub: document.getElementById('sr-sub')?.textContent?.trim() ?? '',
      mark: document.getElementById('sr-letter')?.textContent?.trim() ?? '',
    },
    notice: document.getElementById('sr-notice')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
    noticeStar: document.getElementById('sr-notice-star')?.getAttribute('src'),
    close: { w: +document.querySelector('.roster-sheet .ms-x').getBoundingClientRect().width.toFixed(1),
             h: +document.querySelector('.roster-sheet .ms-x').getBoundingClientRect().height.toFixed(1) },
    rows,
    sheet: box(sheet),
    list: { scroll: list.scrollHeight - list.clientHeight, box: box(list) },
    scrimOpen: !document.getElementById('scrim').hidden,
  };
})()`;

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const notes = [];
const bad = [];
const fail = (m) => bad.push(m);
const say = (m) => notes.push(m);

const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true });
const pg = await ctx.newPage();
const errors = [];
pg.on('pageerror', (e) => errors.push(String(e)));
await pg.goto(base, { waitUntil: 'networkidle' });
await pg.waitForTimeout(400);
await pg.click('.tab[data-tab="arena"]');
await pg.waitForTimeout(1400);

const m = await pg.evaluate(PROBE);

/* 1 — header: the emblem, the title, and the rule that makes the cup spread */
if (m.title !== 'Arena') fail(`aria title reads "${m.title}"`);
if (m.name !== '200 STARS CHANNEL CUP') fail(`title reads "${m.name}"`);
if (m.hook !== '200 Stars split across Top 10 players of #1 Channel') fail(`rule badge reads "${m.hook}"`);
if (!/^\d{2}:\d{2}:\d{2}$/.test(m.count ?? '')) fail(`bracket clock reads "${m.count}"`);
if (!m.emblem.box || m.emblem.box.w < 56 || m.emblem.box.w > 60) fail(`emblem is ${m.emblem.box?.w}px, want 56-60`);
if (!/telegram_stars/i.test(m.emblem.src ?? '')) fail(`hero emblem is not the Telegram Star asset (${m.emblem.src})`);

/* 2 — the podium ranks CHANNELS, and only the leader holds the pool */
if (m.pods.length !== 3) fail(`podium shows ${m.pods.length} channels, want 3`);
const ranks = m.pods.map((p) => p.rank).sort().join(',');
if (ranks !== '1,2,3') fail(`podium ranks are ${ranks}`);
for (const p of m.pods) {
  if (p.badge !== p.rank) fail(`podium #${p.rank} badge reads "${p.badge}"`);
  if (p.role !== 'button' || p.haspopup !== 'dialog') fail(`podium #${p.rank} is not an openable button`);
  if (!p.mark || !p.tick) fail(`podium #${p.rank} has no channel mark or no verification tick`);
  if (!p.name.startsWith('@')) fail(`podium #${p.rank} name "${p.name}" is not a Telegram handle`);
  if (!/^[\d,]+ TIQ$/.test(p.tiq)) fail(`podium #${p.rank} TIQ reads "${p.tiq}"`);
  if (!/^[\d.]+k? players$/.test(p.mem)) fail(`podium #${p.rank} member count reads "${p.mem}"`);
  if (!/roster/i.test(p.hint)) fail(`podium #${p.rank} has no roster cue ("${p.hint}")`);
  for (const [k, v] of Object.entries(p)) if (k.endsWith('Spill') && v > 0.5) fail(`podium #${p.rank} ${k} spills ${v}px`);
}
const first = m.pods.find((p) => p.rank === '1');
if (first?.metal !== 'gold') fail(`the leader wears ${first?.metal || 'no'} metal, want gold`);
if (!/^200\s*Pool$/.test(first?.pool ?? '')) fail(`the leader's pool pill reads "${first?.pool}"`);
for (const p of m.pods.filter((x) => x.rank !== '1')) if (p.pool) fail(`#${p.rank} claims a pool ("${p.pool}") that only #1 holds`);
if (m.pods.length && Math.max(...m.pods.map((p) => p.h)) - Math.min(...m.pods.map((p) => p.h)) < 6) {
  fail('the champion is not raised above the other two');
}

/* 3 — the runners and the pinned squad row */
if (m.runs.length !== 2) fail(`${m.runs.length} runner channels, want 2`);
m.runs.forEach((r, i) => {
  if (r.rank !== String(i + 4)) fail(`runner ${i + 1} ranks "${r.rank}"`);
  if (!r.name.startsWith('@')) fail(`runner ${i + 1} name "${r.name}" is not a handle`);
  if (!/^[\d,]+ TIQ$/.test(r.tiq)) fail(`runner ${i + 1} TIQ reads "${r.tiq}"`);
  if (!r.go) fail(`runner ${i + 1} has no chevron`);
  if (r.h < 48) fail(`runner ${i + 1} is ${r.h}px tall, under the 48px target`);
  for (const [k, v] of Object.entries(r)) if (k.endsWith('Spill') && v > 0.5) fail(`runner ${i + 1} ${k} spills ${v}px`);
});
if (!m.squad.chip) fail('the squad row has no chip');
if (!m.squad.name) fail('the squad row names nothing');
if (m.squad.h < 48) fail(`the squad row is ${m.squad.h}px tall`);
for (const [k, v] of Object.entries(m.squad)) if (k.endsWith('Spill') && v > 0.5) fail(`squad row ${k} spills ${v}px`);

/* 4 — the individual leaderboard is gone, and so is the furniture that carried it */
for (const [k, v] of Object.entries(m.purged)) if (v) fail(`purged arena furniture left (${k} = ${v})`);

/* 5 — geometry: the screen fits 360x640 with nothing scrolling or spilling */
for (const [k, v] of Object.entries(m.clipped)) if (v > 0.5) fail(`${k} spills ${v}px past its box`);
for (const [k, v] of Object.entries(m.overflow)) if (v > 0) fail(`${k} overflows by ${v}px`);
if (m.scroll.page > 1 || m.scroll.pageW > 1) fail(`the page scrolls (${JSON.stringify(m.scroll)})`);
if (m.scroll.stage > 1) fail(`the arena stage scrolls by ${m.scroll.stage}px`);
if (m.scroll.card > 1) fail(`the card overflows by ${m.scroll.card}px`);
if (m.fits.gapToDock < -0.5) fail(`the card slides under the dock by ${-m.fits.gapToDock}px`);
if (m.fits.gapToDock > 14) fail(`${m.fits.gapToDock}px of dead space above the dock`);
for (const k of ['podInside', 'squadInside', 'ctaInside']) if (!m.fits[k]) fail(`${k} is false`);
if (m.cta !== 'PLAY FOR YOUR SQUAD') fail(`the key reads "${m.cta}"`);
if (m.ctaBox.h < 48) fail(`the CTA is ${m.ctaBox.h}px tall, want >=48`);
if (m.ctaBox.w < 48) fail(`the CTA is ${m.ctaBox.w}px wide`);

/* 6 — clay only */
if (m.blurCount) fail(`live blur on the Cup (${JSON.stringify(m.blurs)})`);

await pg.screenshot({ path: path.join(OUT, 'channel-cup-360x640.png') });

/* ---------- 7 — a channel tap opens its Top-10 roster ---------- */

const gold = m.pods.find((p) => p.rank === '1');
await pg.click('.stars-pod[data-rank="1"]');
await pg.waitForTimeout(900);
const r = await pg.evaluate(ROSTER);

if (!r.open) fail('tapping the leader did not open the roster sheet');
if (!r.scrimOpen) fail('the roster opened without its backdrop');
if (!r.head.name.startsWith('@')) fail(`roster header names "${r.head.name}"`);
if (r.head.rank !== '1') fail(`roster header rank badge reads "${r.head.rank}"`);
if (!/^[\d,]+ TIQ · [\d,]+ members · (channel|group)$/.test(r.head.sub)) fail(`roster header sub reads "${r.head.sub}"`);
if (!/Top 10 Contributors win 200 Telegram Stars/.test(r.notice)) fail(`prize notice reads "${r.notice}"`);
if (!/telegram_stars/i.test(r.noticeStar ?? '')) fail('the prize notice carries no real Star asset');
if (r.close.w < 48 || r.close.h < 48) fail(`the close key is ${r.close.w}x${r.close.h}, want >=48`);
if (r.rows.length !== 10) fail(`the roster lists ${r.rows.length} contributors, want 10`);
if (r.head.name !== gold.name) fail(`the sheet shows ${r.head.name} but ${gold.name} was tapped`);

let pool = 0;
r.rows.forEach((row, i) => {
  const want = String(i + 1);
  if (row.rank !== want) fail(`roster row ${want} carries medal "${row.rank}"`);
  if (!row.av || !row.name) fail(`roster row ${want} has no avatar or name`);
  if (!row.flag) fail(`roster row ${want} (${row.name}) carries no flag`);
  if (!/^[\d,]+ TIQ contributed$/.test(row.tiq)) fail(`roster row ${want} TIQ reads "${row.tiq}"`);
  if (!row.star) fail(`roster row ${want} pays "${row.pay}" with no Star asset`);
  const n = Number(row.pay.replace(/[^\d]/g, ''));
  if (!Number.isFinite(n) || n <= 0) fail(`roster row ${want} pays "${row.pay}"`);
  pool += n;
});
if (pool !== 200) fail(`the roster's projected payouts total ${pool}, want the 200-Star pool`);
const ladder = r.rows.map((x) => Number(x.pay.replace(/[^\d]/g, '')));
if (ladder.some((v, i) => i > 0 && v > ladder[i - 1])) fail(`payout ladder is not monotone: ${ladder.join(',')}`);
if (r.sheet.h > 640) fail(`the roster sheet is ${r.sheet.h}px tall on a 640px phone`);
if (r.list.scroll < 0) fail('the roster list reports a negative scroll');

await pg.screenshot({ path: path.join(OUT, 'channel-cup-roster.png') });

/* the close key shuts it, and so does the backdrop */
await pg.click('.roster-sheet .ms-x');
await pg.waitForTimeout(500);
if (!(await pg.evaluate(() => document.getElementById('sheet-roster').hidden))) fail('the close key left the sheet open');

await pg.click('.stars-pod[data-rank="2"]');
await pg.waitForTimeout(900);
const r2 = await pg.evaluate(ROSTER);
if (!r2.open) fail('tapping the silver channel did not open the roster');
if (r2.head.rank !== '2') fail(`the silver channel's sheet is ranked "${r2.head.rank}"`);
if (r2.rows.length !== 10) fail(`the silver roster lists ${r2.rows.length} contributors, want 10`);
await pg.mouse.click(180, 90);          // the backdrop above the sheet
await pg.waitForTimeout(500);
if (!(await pg.evaluate(() => document.getElementById('sheet-roster').hidden))) fail('the backdrop left the sheet open');

/* ---------- 8 — the squad row is a real door, not a sticker ---------- */
const squadRow = await pg.evaluate(() => ({
  haspopup: document.getElementById('stars-squad').getAttribute('aria-haspopup'),
  label: document.getElementById('stars-squad').getAttribute('aria-label'),
}));
if (!squadRow.label) fail('the squad row says nothing to a screen reader');
if (squadRow.haspopup === 'dialog') {
  await pg.click('#stars-squad');
  await pg.waitForTimeout(900);
  const rs = await pg.evaluate(ROSTER);
  if (!rs.open) fail('the squad row did not open its own channel roster');
  const yours = rs.rows.filter((x) => x.you).length;
  say(`squad roster: ${rs.head.name} #${rs.head.rank}, ${yours ? 'you are on the ten' : 'you are outside the paid ten'}`);
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(400);
} else {
  // Unbound must be a real door, not a dead row: it opens the join sheet.
  await pg.click('#stars-squad');
  await pg.waitForTimeout(600);
  const joined = await pg.evaluate(() => !document.getElementById('sheet-squad').hidden);
  if (!joined) fail('the unbound squad row opened neither a roster nor the join sheet');
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(400);
  say('squad row is unbound and routes to the join sheet');
}

if (errors.length) fail(`js: ${errors[0]}`);

await ctx.close();

/* ---------- 9 — a bound device: the squad row, and its place inside its own ten ------
   12 wins / 20 games is 1,840 TIQ, which sits between @NeonRacers' #1 (2,269) and
   #2 (1,783) — so the row must read rank 2 and project the 30-Star second place. */

const bctx = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true });
await bctx.addInitScript(() => {
  const save = {
    v: 2, coins: 1850, owned: {}, equipped: {},
    stats: { games: 20, wins: 12, losses: 3, streak: 0, best: 0, modes: {} },
    country: 'PT', rewards: { country: true, age: true },
    teamId: null, teams: [], badge: null, frame: null, tiqBonus: 0,
  };
  window.localStorage.setItem('detour.save.v2', JSON.stringify(save));
  window.localStorage.setItem('detour.squads.v1', JSON.stringify({ boundId: 'sq-neon', custom: [], bonus: {} }));
});
const bpg = await bctx.newPage();
const bErrors = [];
bpg.on('pageerror', (e) => bErrors.push(String(e)));
await bpg.goto(base, { waitUntil: 'networkidle' });
await bpg.waitForTimeout(400);
await bpg.click('.tab[data-tab="arena"]');
await bpg.waitForTimeout(1600);

const bs = await bpg.evaluate(() => {
  const row = document.getElementById('stars-squad');
  const note = document.getElementById('stars-squad-note');
  const rg = document.createRange();
  rg.selectNodeContents(note);
  return {
    chip: document.getElementById('stars-squad-chip').textContent.trim(),
    mark: document.getElementById('stars-squad-letter').textContent.trim(),
    name: document.getElementById('stars-squad-name').textContent.trim(),
    note: note.textContent.trim(),
    noteSpill: +(rg.getBoundingClientRect().right - note.getBoundingClientRect().right).toFixed(1),
    star: !!note.querySelector('img'),
    haspopup: row.getAttribute('aria-haspopup'),
    label: row.getAttribute('aria-label'),
    unbound: row.classList.contains('is-unbound'),
    stageScroll: document.getElementById('arena-scroll').scrollHeight - document.getElementById('arena-scroll').clientHeight,
  };
});
if (bs.unbound) fail('a bound device still reads the squad row as unbound');
if (bs.chip !== 'YOUR SQUAD') fail(`the squad chip reads "${bs.chip}"`);
if (bs.name !== '@NeonRacers · Rank 2') fail(`the squad row names "${bs.name}"`);
if (!bs.star) fail('the squad row pays with a text glyph, not the real Star asset');
if (bs.noteSpill > 0.5) fail(`the squad note spills ${bs.noteSpill}px`);
if (bs.haspopup !== 'dialog') fail('a bound squad row no longer opens a dialog');
if (bs.stageScroll > 1) fail(`the bound squad row makes the stage scroll by ${bs.stageScroll}px`);

await bpg.click('#stars-squad');
await bpg.waitForTimeout(1000);
const br = await bpg.evaluate(ROSTER);
if (!br.open) fail('the squad row did not open its own channel roster');
if (br.head.name !== '@NeonRacers') fail(`the squad roster shows "${br.head.name}"`);
const you = br.rows.find((x) => x.you);
if (!you) fail('the bound player is missing from their own channel roster');
else {
  if (you.rank !== '2') fail(`the bound player is rostered at #${you.rank}, want #2`);
  if (!/30/.test(you.pay)) fail(`the bound player's row pays "${you.pay}", want the 30-Star place`);
  if (Number(br.rows.find((x) => x.rank === '2')?.pay.replace(/\D/g, '')) !== 30) fail('the YOU row is not the #2 place');
}
await bpg.screenshot({ path: path.join(OUT, 'channel-cup-squad.png') });
if (bErrors.length) fail(`js (bound): ${bErrors[0]}`);
say(`bound squad row: "${bs.name}" — "${bs.note}" → roster #${you?.rank} pays ${you?.pay}`);

await bctx.close();
await browser.close();
srv.close();

for (const n of notes) console.log(`  · ${n}`);
console.log(`layout 360x640  card ${m.fits.cardH}px  gap ${m.fits.gapToDock}px  clock "${m.count}"`);
console.log(`podium ${m.pods.map((p) => `${p.rank}:${p.name} ${p.tiq.replace(' TIQ', '')} ${p.mem}`).join('  |  ')}`);
console.log(`runners ${m.runs.map((x) => `${x.rank}:${x.name}`).join('  |  ')}  squad "${m.squad.name}" "${m.squad.note}"`);
console.log(`roster  ${r.rows.length} contributors, payouts ${ladder.join('+')} = ${pool}`);

if (bad.length) {
  console.error(`\nFAIL — ${bad.length} problem(s):`);
  for (const b of bad) console.error(`  - ${b}`);
  process.exit(1);
}
console.log('\nChannel Cup verified: 360x640 fits with zero overflow and the roster sheet pays 200 Stars across ten.');
