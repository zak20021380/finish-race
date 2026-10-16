/**
 * verify-channel-cup.mjs — serves ./dist and drives the ARENA tab as the
 * 200 Stars Cup: a Telegram Stars championship whose one card reads two ways
 * through a clay switch in its header — CHANNELS (the squad ladder) and TOP
 * PLAYERS (the ten people the leading channel's pool actually pays).
 *
 *   npm run build
 *   node scripts/verify-channel-cup.mjs
 *
 * One phone, 360x640, because that is the fit the card has to hold:
 *  - the header is two compact rows, at or under 60px: the Star set into a dark jewel
 *    face behind a 1px gold rim, inline beside the silver clipped-metal wordmark
 *    "200 STARS CUP" (never clipping), with a live HH:MM:SS clock pinned right as a
 *    dark glass capsule with a gold hairline and a breathing gold bead, then the
 *    two-way switch (>=48px keys, sliding thumb, no clipped label) stretched across
 *    the full card and centred over the podium — no solid black box behind any
 *    header element, and gold reserved for the live/premium things so the CTA stays
 *    the only solid gold slab on the screen,
 *  - the channels podium is three CHANNELS (rank badge, verified channel mark,
 *    bare name, squad TIQ) with no @ sigil, no member count and no "tap to view
 *    roster" cue — the card itself is the door, and only #1 wears the pool,
 *  - two runner channels follow with a chevron, then the pinned squad row, then
 *    a >=48px PLAY FOR YOUR SQUAD key,
 *  - switching to TOP PLAYERS re-reads the same band as individuals: sphere +
 *    nation flag + TIQ + their own share of the cup's 45/30/22/19/17 ladder,
 *    stepping gold/silver/bronze, and no row is a roster door,
 *  - switching back restores the channels board and its single pool pill,
 *  - tapping a channel opens the roster sheet with exactly ten contributors,
 *    ranked 1..10, whose projected payouts sum to the 200-Star pool,
 *  - the stage never scrolls and nothing spills its box, and no blur or
 *    backdrop-filter is live on the screen or its sheet.
 *
 * `.shots/arena/` keeps `channel-cup-360x640.png`, `channel-cup-players.png`,
 * `channel-cup-roster.png` and `channel-cup-squad.png`.
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

  /* the header: two stacked rows — identity + clock, then the full-width switch */
  const head = document.querySelector('.stars-head');
  const titlebar = document.querySelector('.stars-titlebar');
  const nameEl = document.getElementById('stars-name');
  const tabsHost = document.getElementById('stars-tabs');
  const podiumEl = document.getElementById('stars-podium');
  const headBox = box(head), titlebarBox = box(titlebar), tabsHostBox = box(tabsHost), podiumHeadBox = box(podiumEl);
  const headFills = ['.stars-head', '.stars-titlebar', '.stars-emblem', '.stars-count', '#stars-tabs', '#stars-tabs .mode-thumb', '#stars-tabs .mode-seg']
    .map((sel) => { const el = document.querySelector(sel); return { sel, bg: el ? getComputedStyle(el).backgroundColor : null }; });
  const emblemCs = emblem ? getComputedStyle(emblem) : null;

  const pods = [...document.querySelectorAll('.stars-pod')].map((li) => ({
    rank: li.dataset.rank ?? '',
    metal: li.dataset.metal ?? '',
    role: li.getAttribute('role') ?? '',
    haspopup: li.getAttribute('aria-haspopup') ?? '',
    badge: li.querySelector('.stars-pod-rank')?.textContent?.trim() ?? '',
    mark: li.querySelector('.stars-ch-av .stars-ch-t, .stars-av .stars-av-t')?.textContent?.trim() ?? '',
    tick: !!li.querySelector('.stars-ch-verify use'),
    flag: !!li.querySelector('.stars-av-flag .fp'),
    name: li.querySelector('.stars-pod-name')?.textContent?.trim() ?? '',
    tiq: li.querySelector('.stars-pod-tiq')?.textContent?.trim() ?? '',
    pool: li.querySelector('.stars-pod-prize')?.textContent?.trim() ?? '',
    poolStar: !!li.querySelector('.stars-pod-prize img'),
    nameSpill: spill('.stars-pod-name', li),
    tiqSpill: spill('.stars-pod-tiq', li),
    h: +li.getBoundingClientRect().height.toFixed(1),
  }));

  const runs = [...document.querySelectorAll('.stars-run')].map((li) => ({
    rank: li.querySelector('.stars-run-rank')?.textContent?.trim() ?? '',
    mark: li.querySelector('.stars-ch-av .stars-ch-t, .stars-av .stars-av-t')?.textContent?.trim() ?? '',
    flag: !!li.querySelector('.stars-av-flag .fp'),
    name: li.querySelector('.stars-run-nm')?.textContent?.trim() ?? '',
    tiq: li.querySelector('.stars-run-tiq')?.textContent?.trim() ?? '',
    pay: li.querySelector('.stars-run-pay')?.textContent?.trim() ?? '',
    payStar: !!li.querySelector('.stars-run-star'),
    go: !!li.querySelector('.stars-run-go use'),
    role: li.getAttribute('role') ?? '',
    nameSpill: spill('.stars-run-nm', li),
    h: +li.getBoundingClientRect().height.toFixed(1),
  }));

  /* the board switch: two keys on a sliding clay thumb. The face is 30px here,
     so the ::after band is what has to carry the tap target to 48px. */
  const band = (el) => {
    const cs = getComputedStyle(el, '::after');
    const v = (p) => (cs[p] && cs[p] !== 'auto' ? -parseFloat(cs[p]) : 0);
    return +(el.getBoundingClientRect().height + v('top') + v('bottom')).toFixed(1);
  };
  const tabsEl = document.getElementById('stars-tabs');
  const tabs = {
    active: tabsEl?.dataset.active ?? '',
    keys: [...document.querySelectorAll('#stars-tabs .mode-seg')].map((b) => ({
      view: b.dataset.view ?? '',
      pressed: b.getAttribute('aria-pressed') ?? '',
      t: b.textContent.trim(),
      spill: spill(b),
      tap: band(b),
    })),
    thumb: !!tabsEl?.querySelector('.mode-thumb'),
  };

  const emblemImg = document.querySelector('.stars-emblem-img');
  const clockEl = document.querySelector('.stars-count');
  const thumbEl = document.querySelector('#stars-tabs .mode-thumb');
  const beadCs = clockEl ? getComputedStyle(clockEl, '::before') : null;
  const faceCs = emblem ? getComputedStyle(emblem, '::before') : null;
  const nameCs = nameEl ? getComputedStyle(nameEl) : null;
  const thumbCs = thumbEl ? getComputedStyle(thumbEl) : null;
  const gold = /245,\\s*158,\\s*11|251,\\s*191,\\s*36|252,\\s*211,\\s*77|253,\\s*230,\\s*138/;

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
    view: card?.dataset.view ?? '',
    tabs,
    count: txt('#stars-count'),
    emblem: {
      box: box(emblem), src: emblemImg ? emblemImg.getAttribute('src') : null,
      bg: emblemCs?.backgroundColor ?? null,
      border: emblemCs?.borderTopWidth ?? null,
      shadow: emblemCs?.boxShadow ?? null,
      /* the setting: a gradient gold rim on the element, a lit dark face on ::before */
      rim: emblemCs?.backgroundImage ?? null,
      face: faceCs?.backgroundImage ?? null,
      imgW: emblemImg ? +emblemImg.getBoundingClientRect().width.toFixed(1) : null,
      imgBlend: emblemImg ? getComputedStyle(emblemImg).mixBlendMode : null,
    },
    hero: {
      /* the wordmark is cool polished silver, not gold, and clipped out of a gradient */
      wordmark: {
        clip: nameCs?.webkitBackgroundClip ?? nameCs?.backgroundClip ?? null,
        img: nameCs?.backgroundImage ?? null,
        color: nameCs?.color ?? null,
        gold: nameCs ? gold.test(nameCs.backgroundImage) : false,
      },
      /* the clock is a dark glass capsule with a gold hairline and a breathing bead */
      clock: {
        bg: clockEl ? getComputedStyle(clockEl).backgroundColor : null,
        border: clockEl ? getComputedStyle(clockEl).borderTopColor : null,
        goldBorder: clockEl ? gold.test(getComputedStyle(clockEl).borderTopColor) : false,
        goldBloom: clockEl ? gold.test(getComputedStyle(clockEl).boxShadow) : false,
        bead: beadCs?.content ?? null,
        beadGold: beadCs ? gold.test(beadCs.backgroundImage) : false,
        beadAnim: beadCs?.animationName ?? null,
        w: clockEl ? +clockEl.getBoundingClientRect().width.toFixed(1) : null,
      },
      /* the lit key keeps a hairline gold rim without becoming a second gold slab */
      thumb: {
        rimGold: thumbCs ? gold.test(thumbCs.boxShadow) : false,
        bg: thumbCs?.backgroundColor ?? null,
        transition: thumbCs?.transitionProperty ?? null,
      },
    },
    header: {
      headH: +headBox.h.toFixed(1),
      headBox, titlebarBox, tabsHostBox, podiumHeadBox,
      /* the Star rides row one beside the title: same band, immediately left of it */
      inlineStar: !!emblem && Math.abs((box(emblem).t + box(emblem).b) / 2 - (box(nameEl).t + box(nameEl).b) / 2) <= 4
        && box(emblem).r <= box(nameEl).l + 0.5,
      /* row two spans the card and centres over the three-column podium */
      fullWidth: Math.abs(tabsHostBox.w - headBox.w) <= 1 && Math.abs(tabsHostBox.w - podiumHeadBox.w) <= 1,
      centered: Math.abs((tabsHostBox.l + tabsHostBox.r) / 2 - (podiumHeadBox.l + podiumHeadBox.r) / 2) <= 1,
      fills: headFills,
    },
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
      podMem: document.querySelectorAll('.stars-pod-mem').length,
      podHint: document.querySelectorAll('.stars-pod-hint').length,
      runMem: document.querySelectorAll('.stars-run-mem').length,
      rule: document.querySelectorAll('.stars-rule').length,
      hook: !!document.getElementById('stars-hook'),
    },
    scroll: {
      page: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      pageW: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      stage: stage.scrollHeight - stage.clientHeight,
      card: card.scrollHeight - card.clientHeight,
    },
    overflow: {
      card: over(card), head: over(document.querySelector('.stars-head')),
      tabs: over(document.getElementById('stars-tabs')), count: over(document.querySelector('.stars-count')),
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
/** `rgb()/rgba()` to channels — the header audit reads computed background fills. */
const rgba = (s) => {
  const p = (String(s).match(/[\d.]+/g) ?? []).map(Number);
  return { r: p[0] ?? 0, g: p[1] ?? 0, b: p[2] ?? 0, a: p.length > 3 ? p[3] : 1 };
};

const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true });
const pg = await ctx.newPage();
const errors = [];
pg.on('pageerror', (e) => errors.push(String(e)));
await pg.goto(base, { waitUntil: 'networkidle' });
await pg.waitForTimeout(400);
await pg.click('.tab[data-tab="arena"]');
await pg.waitForTimeout(1400);

const m = await pg.evaluate(PROBE);

/* 1 — header: two rows — the Star medallion inline with the silver wordmark + clock,
   then the switch. One palette rule: gold marks the live/premium things (the Star's
   setting, the clock's bead, the lit key's rim) and the wordmark stays cool silver, so
   the CTA below is still the only solid gold slab on the screen. */
if (m.title !== 'Arena') fail(`aria title reads "${m.title}"`);
if (m.name !== '200 STARS CUP') fail(`title reads "${m.name}"`);
if (!/^\d{2}:\d{2}:\d{2}$/.test(m.count ?? '')) fail(`bracket clock reads "${m.count}"`);
if (!m.emblem.box || m.emblem.box.w < 20 || m.emblem.box.w > 28) fail(`emblem is ${m.emblem.box?.w}px, want 20-28 inline with the title`);
if (Math.abs(m.emblem.box.w - m.emblem.box.h) > 1) fail(`emblem is not square (${m.emblem.box?.w}x${m.emblem.box?.h})`);
if (!/telegram_stars/i.test(m.emblem.src ?? '')) fail(`hero emblem is not the Telegram Star asset (${m.emblem.src})`);
if (!m.header.inlineStar) fail('the Star is not inline beside the title in row one');
if (m.header.headH > 60.5) fail(`the header is ${m.header.headH}px tall, want <= 60`);
if (!m.header.fullWidth) fail(`the switch spans ${m.header.tabsHostBox?.w}px of the ${m.header.headBox?.w}px header, want full width`);
if (!m.header.centered) fail('the switch is not centred over the podium');
/* the black-cutout audit: no header element paints a solid black fill, the
   wrappers stay bare, and the track and clock are translucent by construction */
for (const f of m.header.fills) {
  const c = rgba(f.bg);
  if (c.a >= 0.99 && Math.max(c.r, c.g, c.b) <= 24) fail(`the header cuts a solid black box (${f.sel} = ${f.bg})`);
}
const fillOf = (sel) => m.header.fills.find((f) => f.sel === sel)?.bg ?? 'rgb(0, 0, 0)';
if (rgba(fillOf('.stars-head')).a !== 0 || rgba(fillOf('.stars-titlebar')).a !== 0) {
  fail('a header wrapper paints a fill instead of sitting on the card');
}
if (rgba(fillOf('#stars-tabs')).a >= 0.99) fail(`the switch track is an opaque box (${fillOf('#stars-tabs')})`);
if (rgba(fillOf('.stars-count')).a >= 0.99) fail(`the clock cuts an opaque box (${fillOf('.stars-count')})`);

/* the Star's setting: a gradient gold rim on the element, a dark lit face on ::before,
   and the gold PNG set into it — but the element itself still paints no fill, so the
   medallion reads as set into the card rather than stuck on top of it */
if (m.emblem.bg !== 'rgba(0, 0, 0, 0)' || parseFloat(m.emblem.border) > 0) {
  fail(`the Star's setting paints an opaque box (${m.emblem.bg} / ${m.emblem.border})`);
}
if (!/gradient/.test(m.emblem.rim ?? '')) fail(`the Star has no gold rim (${m.emblem.rim})`);
if (!/gradient/.test(m.emblem.face ?? '')) fail(`the Star has no lit jewel face (${m.emblem.face})`);
if (!gold.test(m.emblem.shadow ?? '')) fail(`the Star carries no gold bloom (${m.emblem.shadow})`);
if (!m.emblem.imgW || m.emblem.imgW < m.emblem.box.w * 0.6 || m.emblem.imgW > m.emblem.box.w * 0.86) {
  fail(`the Star is ${m.emblem.imgW}px inside a ${m.emblem.box.w}px setting, want 60-86% so the rim stays a ring`);
}
if (m.emblem.imgBlend !== 'screen') fail(`the Star blends as "${m.emblem.imgBlend}", want screen`);

/* the wordmark: clipped metal gradient, and silver — never gold, or it competes
   with the CTA and with the Star it is supposed to sit beside */
if (m.hero.wordmark.clip !== 'text' || !/gradient/.test(m.hero.wordmark.img ?? '')) {
  fail(`the wordmark is not clipped metal (${m.hero.wordmark.clip} / ${m.hero.wordmark.img})`);
}
if (m.hero.wordmark.gold) fail(`the wordmark went gold (${m.hero.wordmark.img})`);

/* the clock: a dark glass capsule, a gold hairline, and the one thing in the band
   that moves — the bead */
if (m.hero.clock.bg === null || rgba(m.hero.clock.bg).a >= 0.99) fail(`the clock is an opaque capsule (${m.hero.clock.bg})`);
if (!m.hero.clock.goldBorder) fail(`the clock has no gold hairline (${m.hero.clock.border})`);
if (!m.hero.clock.goldBloom) fail(`the clock carries no warm bloom (${m.hero.clock.goldBloom})`);
if (m.hero.clock.bead === 'none' || !m.hero.clock.bead) fail('the clock has no pulse bead');
if (!m.hero.clock.beadGold) fail(`the clock's bead is not gold (${m.hero.clock.beadGold})`);
if (m.hero.clock.beadAnim !== 'cup-clock') fail(`the clock's bead does not breathe (${m.hero.clock.beadAnim})`);

if (m.view !== 'channels') fail(`the card opens on the "${m.view}" board, want channels`);
if (!m.tabs.thumb) fail('the board switch has no sliding clay thumb');
if (!m.hero.thumb.rimGold) fail('the lit key has no gold rim');
if (m.hero.thumb.bg !== 'rgba(0, 0, 0, 0)') fail(`the lit key is a flat fill, not a gradient cap (${m.hero.thumb.bg})`);
if (m.tabs.active !== 'channels') fail(`the switch is on "${m.tabs.active}"`);
if (m.tabs.keys.length !== 2) fail(`the switch has ${m.tabs.keys.length} keys, want 2`);
for (const k of m.tabs.keys) {
  if (k.spill > 0.5) fail(`the "${k.t}" key spills ${k.spill}px — a clipped label is what the switch replaced`);
  if (k.tap < 48) fail(`the "${k.t}" key is a ${k.tap}px tap target, want >=48`);
  if (k.pressed !== String(k.view === 'channels')) fail(`the "${k.t}" key reports aria-pressed="${k.pressed}"`);
}

/* 2 — the channels board: three squads, no sigils, no counts, no roster cues */
if (m.pods.length !== 3) fail(`podium shows ${m.pods.length} channels, want 3`);
const ranks = m.pods.map((p) => p.rank).sort().join(',');
if (ranks !== '1,2,3') fail(`podium ranks are ${ranks}`);
for (const p of m.pods) {
  if (p.badge !== p.rank) fail(`podium #${p.rank} badge reads "${p.badge}"`);
  if (p.role !== 'button' || p.haspopup !== 'dialog') fail(`podium #${p.rank} is not an openable button`);
  if (!p.mark || !p.tick) fail(`podium #${p.rank} has no channel mark or no verification tick`);
  if (!p.name) fail(`podium #${p.rank} names nothing`);
  if (p.name.startsWith('@')) fail(`podium #${p.rank} still wears the @ sigil ("${p.name}")`);
  if (!/^[\d,]+ TIQ$/.test(p.tiq)) fail(`podium #${p.rank} TIQ reads "${p.tiq}"`);
  if (p.flag) fail(`podium #${p.rank} (a channel) carries a player flag`);
  for (const [k, v] of Object.entries(p)) if (k.endsWith('Spill') && v > 0.5) fail(`podium #${p.rank} ${k} spills ${v}px`);
}
const first = m.pods.find((p) => p.rank === '1');
if (first?.metal !== 'gold') fail(`the leader wears ${first?.metal || 'no'} metal, want gold`);
if (!/^200\s*Pool$/.test(first?.pool ?? '')) fail(`the leader's pool pill reads "${first?.pool}"`);
if (!first?.poolStar) fail("the leader's pool pill has no real Star asset");
for (const p of m.pods.filter((x) => x.rank !== '1')) if (p.pool) fail(`#${p.rank} claims a pool ("${p.pool}") that only #1 holds`);
if (m.pods.length && Math.max(...m.pods.map((p) => p.h)) - Math.min(...m.pods.map((p) => p.h)) < 6) {
  fail('the champion is not raised above the other two');
}

/* 3 — the runners and the pinned squad row */
if (m.runs.length !== 2) fail(`${m.runs.length} runner channels, want 2`);
m.runs.forEach((r, i) => {
  if (r.rank !== String(i + 4)) fail(`runner ${i + 1} ranks "${r.rank}"`);
  if (r.name.startsWith('@')) fail(`runner ${i + 1} name "${r.name}" still wears the @ sigil`);
  if (!r.name) fail(`runner ${i + 1} names nothing`);
  if (!/^[\d,]+ TIQ$/.test(r.tiq)) fail(`runner ${i + 1} TIQ reads "${r.tiq}"`);
  if (!r.go) fail(`runner ${i + 1} has no chevron`);
  if (r.pay) fail(`runner ${i + 1} claims a Star share ("${r.pay}") — the pool pays channels, not runners`);
  if (r.h < 48) fail(`runner ${i + 1} is ${r.h}px tall, under the 48px target`);
  for (const [k, v] of Object.entries(r)) if (k.endsWith('Spill') && v > 0.5) fail(`runner ${i + 1} ${k} spills ${v}px`);
});
if (!m.squad.chip) fail('the squad row has no chip');
if (!m.squad.name) fail('the squad row names nothing');
if (m.squad.name.startsWith('@')) fail(`the squad row still wears the @ sigil ("${m.squad.name}")`);
if (m.squad.h < 48) fail(`the squad row is ${m.squad.h}px tall`);
for (const [k, v] of Object.entries(m.squad)) if (k.endsWith('Spill') && v > 0.5) fail(`squad row ${k} spills ${v}px`);

/* 3b — the switch re-reads the same band as the ten people the pool pays */
await pg.click('#stars-tabs [data-view="players"]');
await pg.waitForTimeout(1400);
const p = await pg.evaluate(PROBE);
if (p.view !== 'players') fail(`the switch left the card on "${p.view}"`);
if (p.tabs.active !== 'players') fail(`the switch thumb is still on "${p.tabs.active}"`);
if (p.tabs.keys.find((k) => k.view === 'players')?.pressed !== 'true') fail('the Top Players key never reports itself pressed');
if (p.pods.length !== 3 || p.runs.length !== 2) fail(`the players board shows ${p.pods.length}+${p.runs.length}, want 3+2`);
const paid = [...p.pods.map((x) => x.pool), ...p.runs.map((x) => x.pay)];
for (const [i, share] of paid.entries()) {
  const n = Number(String(share).replace(/[^\d]/g, ''));
  if (!n) fail(`players-board place ${i + 1} pays "${share}"`);
}
/* the cup's own ladder, read in order: 45 30 22 19 17 */
if (paid.map((s) => Number(String(s).replace(/[^\d]/g, ''))).join(',') !== '45,30,22,19,17') {
  fail(`the players board pays ${paid.join(',')} — not the cup's 45/30/22/19/17`);
}
for (const x of [...p.pods, ...p.runs]) {
  if (!x.mark) fail(`a players-board place has no avatar initials`);
  if (!x.flag) fail(`a players-board place has no nation flag`);
  if (x.tick) fail('a player is marked as a verified channel');
  if (x.role === 'button') fail('a player row is wired as a roster door — people are not channels');
  if (x.go) fail('a player row still carries the channel chevron');
  for (const [k, v] of Object.entries(x)) if (k.endsWith('Spill') && v > 0.5) fail(`players board ${k} spills ${v}px`);
}
if (p.pods[0]?.metal !== 'gold' || p.pods[1]?.metal !== 'silver' || p.pods[2]?.metal !== 'bronze') {
  fail('the players podium does not step gold/silver/bronze');
}
if (Math.max(...p.pods.map((x) => x.h)) - Math.min(...p.pods.map((x) => x.h)) < 12) {
  fail(`the players podium barely steps (${p.pods.map((x) => x.h).join('/')}px) — every place carries a pill, so the rise must come from the pillar`);
}
for (const [k, v] of Object.entries(p.scroll)) if (v > 1) fail(`the players board makes ${k} scroll by ${v}px`);
for (const [k, v] of Object.entries(p.overflow)) if (v > 0) fail(`the players board ${k} overflows by ${v}px`);
await pg.screenshot({ path: path.join(OUT, 'channel-cup-players.png') });
await pg.click('#stars-tabs [data-view="channels"]');
await pg.waitForTimeout(700);
const back = await pg.evaluate(PROBE);
if (back.view !== 'channels' || back.pods.map((x) => x.name).join(',') !== m.pods.map((x) => x.name).join(',')) {
  fail('switching back did not restore the channels board');
}
const backFirst = back.pods.find((x) => x.rank === '1');
if (!/^200\s*Pool$/.test(backFirst?.pool ?? '')) {
  fail(`the channels board lost its pool pill after a round trip ("${backFirst?.pool}")`);
}
if (back.pods.some((x) => x.pool && x.rank !== '1')) fail('a round trip left pool pills on the unled channels');
say(`players board: ${p.pods.map((x) => `${x.rank}:${x.name} ${x.tiq.replace(' TIQ', '')} ${x.pool}`).join('  |  ')}`);

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
// the sheet keeps the full @handle: inside it the entries are a channel's people.
if (r.head.name !== `@${gold.name}`) fail(`the sheet shows ${r.head.name} but @${gold.name} was tapped`);

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
if (bs.name !== 'NeonRacers · Rank 2') fail(`the squad row names "${bs.name}"`);
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
console.log(`layout 360x640  card ${m.fits.cardH}px  gap ${m.fits.gapToDock}px  header ${m.header.headH}px  clock "${m.count}"`);
console.log(`podium ${m.pods.map((p) => `${p.rank}:${p.name} ${p.tiq.replace(' TIQ', '')}`).join('  |  ')}`);
console.log(`runners ${m.runs.map((x) => `${x.rank}:${x.name}`).join('  |  ')}  squad "${m.squad.name}" "${m.squad.note}"`);
console.log(`roster  ${r.rows.length} contributors, payouts ${ladder.join('+')} = ${pool}`);

if (bad.length) {
  console.error(`\nFAIL — ${bad.length} problem(s):`);
  for (const b of bad) console.error(`  - ${b}`);
  process.exit(1);
}
console.log('\nChannel Cup verified: 360x640 fits with zero overflow and the roster sheet pays 200 Stars across ten.');
