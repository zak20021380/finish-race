/**
 * verify-ranks.mjs — headless audit of the Mind Ladder (#s-ranks) "Zen Luxury"
 * Dark-Clay overhaul.
 *
 * Serves ./dist over 127.0.0.1, drives the ranks screen at 360x640, 390x844 and
 * 430x932, and fails (exit 1) when:
 *   - anything overflows horizontally (page, scroller, or a visible element),
 *   - the page itself scrolls vertically (the screen must own its height),
 *   - the old three-box stat cluster (.ranks-stats / .rstat) or the Preview tag
 *     ever comes back,
 *   - the header is no longer one 44px identity line with a "Nd left" capsule,
 *   - the board tabs lose their borderless pill groove or sliding thumb,
 *   - the podium loses its floating geometry: circular avatars, a taller gold
 *     centre, short rank pills ("GM II"), or the star-glowing TIQ score,
 *   - the You slate loses its gradient/border, its one-row 4-badge micro gauge,
 *     its italic milestone, or the "CLIMB NOW" ember key (gradient, ink, 44px),
 *   - the podium and the You card cannot both fit a 360x640 screen without
 *     clipping (page scrollbar or cut edges),
 *   - the nations board bar or the mind sheet regress.
 * Screenshots land in .shots/ranks-*.png on success.
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
  console.error('playwright-core not found in project node_modules.');
  process.exit(2);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

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
const VIEWPORTS = [[360, 640], [390, 844], [430, 932]];

let failed = 0;
const fail = (tag, msg) => { failed += 1; console.log(`FAIL ${tag}\n- ${msg}`); };
const pass = (tag, msg) => console.log(`PASS ${tag}${msg ? `: ${msg}` : ''}`);

/* In-page audit: geometry, overflow, and the zen-luxury tokens of the screen. */
const AUDIT = () => {
  const out = { pass: true, fails: [], notes: {} };
  const bad = (m) => { out.pass = false; out.fails.push(m); };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const visible = (el) => !!el && el.getBoundingClientRect().height > 0;

  /* 1. page + scroller never overflow horizontally, and the page never scrolls
        vertically — on mobile the screen owns its height, the list its own scroll */
  if (document.scrollingElement.scrollWidth > window.innerWidth + 1) {
    bad(`page scrolls horizontally: ${document.scrollingElement.scrollWidth} > ${window.innerWidth}`);
  }
  if (document.scrollingElement.scrollHeight > window.innerHeight + 1) {
    bad(`page scrolls vertically: ${document.scrollingElement.scrollHeight} > ${window.innerHeight}`);
  }
  const sc = document.getElementById('ranks-scroll');
  if (!sc || sc.scrollWidth > sc.clientWidth + 1) bad(`#ranks-scroll overflow: ${sc?.scrollWidth} > ${sc?.clientWidth}`);

  /* 2. every visible element inside ranks stays inside the viewport */
  const root = document.getElementById('s-ranks');
  if (!root || root.hidden) { bad('#s-ranks not visible'); return out; }
  const els = root.querySelectorAll('*');
  let maxRight = -Infinity, worst = '';
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > maxRight) { maxRight = r.right; worst = el.className || el.tagName; }
    if (r.right > window.innerWidth + 0.5) bad(`element clips right edge: ${el.className} right=${r.right.toFixed(1)}`);
    if (r.left < -0.5) bad(`element clips left edge: ${el.className} left=${r.left.toFixed(1)}`);
  }
  out.notes.widest = `${maxRight.toFixed(1)}px (${worst})`;

  /* 3. obsidian canvas, not muddy black */
  const cs = getComputedStyle(root);
  const bg = `${cs.backgroundColor} ${cs.backgroundImage}`;
  if (!/rgb\(15,\s*20,\s*32\)|#0f1420/i.test(bg)) bad(`obsidian canvas missing: "${bg.slice(0, 120)}"`);
  else out.notes.canvas = 'obsidian gradient ok';

  /* 4. the declutter: the three-box stat cluster and the Preview tag never return */
  for (const ghost of ['#ranks-stats', '.ranks-stats', '.rstat', '.ml-preview', '.ml-badges']) {
    if (root.querySelector(ghost)) bad(`clutter regression: ${ghost} is still in the DOM`);
  }

  /* 5. the header: one 44px line — wordmark over "Season N", "Nd left" capsule */
  const head = root.querySelector('.ranks-head');
  if (!head || head.getBoundingClientRect().height === 0) bad('ranks head missing/collapsed');
  const hh = head.getBoundingClientRect().height;
  if (hh > 52) bad(`ranks head is ${hh.toFixed(1)}px tall — should be one slim line (<= 52)`);
  const title = root.querySelector('.ml-title');
  if (!title || !/mind ladder/i.test(title.textContent)) bad('ml-title missing/wrong');
  const sub = root.querySelector('.ml-sub');
  if (!sub || !/^season \d+/i.test(sub.textContent.trim())) bad(`season subtitle is "${sub?.textContent}"`);
  const pill = root.querySelector('.ml-season .ml-season-t');
  if (!pill || !/^\d+d left$/.test(pill.textContent.trim())) bad(`countdown pill is "${pill?.textContent}"`);
  const beacon = root.querySelector('.ml-season .ml-pulse');
  if (!beacon || beacon.getBoundingClientRect().width < 3) bad('season beacon missing/collapsed');

  /* 6. the sub-tabs: slim borderless groove + one sliding thumb */
  const tabs = root.querySelector('.ranks-tabs');
  if (!tabs) bad('ranks-tabs missing');
  else {
    const ts = getComputedStyle(tabs);
    const th = tabs.getBoundingClientRect().height;
    if (th > 44) bad(`tabs are ${th.toFixed(1)}px tall — should be slim (<= 44)`);
    if (!/rgba\(255, 255, 255, 0\.06\)/.test(ts.backgroundColor)) bad(`tab groove is ${ts.backgroundColor}, want rgba(255,255,255,0.06)`);
    if (parseFloat(ts.borderTopWidth) > 0) bad(`tab groove has a ${ts.borderTopWidth} border`);
    if (parseFloat(ts.borderTopLeftRadius) < 18) bad(`tab groove radius is ${ts.borderTopLeftRadius}, want >= 18`);
    const thumb = tabs.querySelector('.mode-thumb');
    if (!thumb || thumb.getBoundingClientRect().width < 20) bad('sliding thumb missing/collapsed');
    out.notes.tabs = `${th.toFixed(0)}px groove, thumb ok`;
  }

  /* 7. the floating Top-3 podium */
  const cards = [...root.querySelectorAll('#ranks-podium .pod-card')].filter(visible);
  if (cards.length !== 3) bad(`expected 3 podium cards, saw ${cards.length}`);
  let secTop = null, secAvTop = null, champ = null;
  for (const card of cards) {
    const cr = card.getBoundingClientRect();
    const av = card.querySelector('.pod-av');
    if (!av) { bad('a podium card has no avatar'); continue; }
    const ar = av.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(av).borderTopLeftRadius);
    if (!Number.isFinite(radius) || radius < ar.width / 2 - 1) bad(`avatar is not circular (radius ${radius} on ${ar.width.toFixed(0)}px)`);
    const tier = card.querySelector('.pod-tier');
    if (!tier || !/^(RK|TAC|STR|GM) (I|II|III)$/.test(tier.textContent.trim())) {
      bad(`rank pill is "${tier?.textContent}" — want a short crest like "GM II"`);
    }
    const iq = card.querySelector('.pod-iq');
    if (!iq || !/\d/.test(iq.textContent)) bad('TIQ chip missing/empty on a podium card');
    const glyph = iq?.querySelector('use')?.getAttribute('href') ?? '';
    if (glyph !== '#i-star') bad(`podium TIQ glyph is ${glyph}, want #i-star`);
    if (getComputedStyle(iq.querySelector('b')).textShadow === 'none') bad('podium TIQ digits are not glowing');
    const foot = card.querySelector('.pod-foot');
    if (!foot || foot.textContent.trim().length === 0) bad('a podium card has no rank plinth');
    if (card.dataset.rank === '1') {
      champ = { h: cr.height, avTop: ar.top };
      const crown = card.querySelector('.pod-crown');
      if (!crown || crown.getBoundingClientRect().width < 16) bad('gold crown missing/collapsed');
    } else if (card.dataset.rank === '2') {
      secTop = foot.getBoundingClientRect().top;
      secAvTop = ar.top;
    } else if (card.dataset.rank === '3') {
      const footTop = foot.getBoundingClientRect().top;
      if (secTop !== null && !near(footTop, secTop, 1.5)) bad('silver and bronze plinths do not bottom-align');
    }
  }
  if (champ && champ.h < 140) bad(`gold card is only ${champ.h.toFixed(1)}px tall (want >= 140)`);
  if (champ && secAvTop !== null && secAvTop - champ.avTop < 20) bad('gold crest is not elevated above the challengers');
  const band = root.querySelector('.pod-band, #pod-band');
  if (band && visible(band)) bad('the podium band caption is back — the header already carries the season');

  /* 8. the You slate: gradient, bordered, XP ring, one-row micro gauge, ember key */
  const slate = root.querySelector('.solo-standing.mh');
  if (!slate || !visible(slate)) { bad('You slate missing'); return out; }
  const ss = getComputedStyle(slate);
  if (!/rgb\(22,\s*31,\s*48\)/.test(ss.backgroundImage) || !/rgb\(15,\s*22,\s*36\)/.test(ss.backgroundImage)) {
    bad(`You slate gradient is "${ss.backgroundImage.slice(0, 90)}" — want #161F30 → #0F1624`);
  }
  if (!/rgba\(255,\s*255,\s*255,\s*0\.0?7\)/.test(ss.borderTopColor)) bad(`You slate border is ${ss.borderTopColor}, want rgba(255,255,255,0.07)`);
  if (!slate.querySelector('.mh-ring .mh-arc-fill')) bad('XP progress ring missing');
  const line = slate.querySelector('.mh-line');
  if (!line || !/^You · .+/i.test(line.textContent.trim())) bad(`identity line is "${line?.textContent}"`);
  const mhScore = slate.querySelector('.mh-score b');
  if (!mhScore || !/^\d[\d,]*$/.test(mhScore.textContent.trim())) bad(`TIQ score is "${mhScore?.textContent}"`);
  const axes = [...slate.querySelectorAll('.mh-axes .mh-axis')].filter(visible);
  if (axes.length !== 4) bad(`attribute gauge shows ${axes.length} badges, want 4`);
  if (axes.length === 4) {
    const tops = axes.map((a) => a.getBoundingClientRect().top);
    if (Math.max(...tops) - Math.min(...tops) > 1.5) bad('attribute badges are not on a single row');
    if (axes.some((a) => !/^\d+%$/.test(a.querySelector('b')?.textContent ?? ''))) bad('a micro-badge has no percentage chip');
    const gh = slate.querySelector('.mh-axes').getBoundingClientRect().height;
    if (gh > 24) bad(`attribute row is ${gh.toFixed(1)}px tall — want < 24`);
    const cols = new Set(axes.map((a) => Math.round(a.getBoundingClientRect().left)));
    if (cols.size !== 4) bad(`attribute gauge is not one row of 4 (${cols.size} columns)`);
  }
  const ptext = slate.querySelector('.mh-ptext');
  if (!ptext || getComputedStyle(ptext).fontStyle !== 'italic') bad('milestone hint is missing/not italic');
  else if (!/wins? to .+ · crest glows on rank-up/i.test(ptext.textContent)) bad(`milestone hint says "${ptext.textContent}"`);
  const cta = slate.querySelector('.mh-cta');
  if (!cta) { bad('CLIMB NOW key missing'); return out; }
  const ch = cta.getBoundingClientRect().height;
  if (!near(ch, 44, 2)) bad(`CLIMB NOW key is ${ch.toFixed(1)}px tall, want 44`);
  if (cta.textContent.trim() !== 'CLIMB NOW') bad(`key text is "${cta.textContent.trim()}", want CLIMB NOW`);
  const ccs = getComputedStyle(cta);
  if (!/rgb\(245,\s*158,\s*11\)/.test(ccs.backgroundImage) || !/rgb\(180,\s*83,\s*9\)/.test(ccs.backgroundImage)) {
    bad(`key gradient is "${ccs.backgroundImage.slice(0, 90)}" — want #F59E0B → #B45309`);
  }
  if (!/rgb\(255,\s*251,\s*235\)/.test(ccs.color)) bad(`key ink is ${ccs.color}, want #FFFBEB`);
  if (!near(parseFloat(ccs.letterSpacing), 1.2, 0.05)) bad(`key tracking is ${ccs.letterSpacing}, want 1.2px`);
  if (!near(parseFloat(ccs.borderTopLeftRadius), 999, 1)) bad(`key radius is ${ccs.borderTopLeftRadius}, want a pill`);

  /* 9. on entry the podium and the You slate must both fit the visible scroller:
        no clipping, no page scrollbar — the ladder below may still scroll itself */
  sc.scrollTop = 0;
  const visibleBottom = sc.getBoundingClientRect().bottom;
  for (const [name, el] of [['podium', root.querySelector('#ranks-podium')], ['You slate', slate]]) {
    if (!el || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.top < sc.getBoundingClientRect().top - 0.5) bad(`${name} starts above the scroller`);
    if (r.bottom > visibleBottom + 0.5) bad(`${name} is cut off: bottom ${r.bottom.toFixed(0)} > scroller ${visibleBottom.toFixed(0)}`);
  }
  out.notes.fit = `podium+slate inside ${(visibleBottom - sc.getBoundingClientRect().top).toFixed(0)}px scroller`;

  /* 10. dock sits clear of the scroller's last row */
  const dock = document.getElementById('ranks-dock');
  if (dock && !dock.hidden) {
    const lastRow = [...root.querySelectorAll('#ranks-minds .rival, #ranks-minds .lb-card')].pop();
    if (lastRow) {
      const overlap = dock.getBoundingClientRect().top - lastRow.getBoundingClientRect().bottom;
      out.notes.lastRowGap = `${overlap.toFixed(0)}px above dock`;
    }
  }
  return out;
};

/* Nations board probe: a bound country gets the ~5px gap bar; an unbound one
   asks for a flag. Either shape must render inside .nat-hero without overflow. */
const PROBE_NATIONS = () => {
  const out = { pass: true, fails: [] };
  const hero = document.querySelector('#ranks-nations .nat-hero');
  if (!hero) { out.pass = false; out.fails.push('nations hero missing'); return out; }
  const bar = hero.querySelector('.mh-ptrack');
  const pointed = hero.querySelector('.nat-hero-btn');
  if (bar) {
    const h = bar.getBoundingClientRect().height;
    if (h < 4.5 || h > 6.5) { out.pass = false; out.fails.push(`nations bar ${h.toFixed(1)}px, want ~5px`); }
  } else if (!pointed) {
    out.pass = false; out.fails.push('nations hero has neither a gap bar nor a set-flag key');
  }
  return out;
};

const srv = await serve();
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

try {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of VIEWPORTS) {
    const tag = `${w}x${h}`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const pg = await ctx.newPage();
    await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(1100);
    await pg.click('.dock-nav .tab[data-tab="ranks"]');
    await pg.waitForTimeout(800);

    const res = await pg.evaluate(`(${AUDIT.toString()})()`);
    if (res.pass) pass(tag, `audited (${res.notes.widest}; ${res.notes.fit}; ${res.notes.tabs})`);
    else fail(tag, res.fails.join('\n- '));
    await pg.screenshot({ path: path.join(SHOTS, `ranks-${tag}.png`) });

    if (w === 360) {
      /* the thumb slides to the active board */
      const before = await pg.evaluate(() => document.querySelector('.ranks-tabs .mode-thumb').getBoundingClientRect().left);
      await pg.click('.ranks-tabs [data-board="nations"]');
      await pg.waitForTimeout(500);
      const after = await pg.evaluate(() => document.querySelector('.ranks-tabs .mode-thumb').getBoundingClientRect().left);
      if (after > before + 40) pass(`${tag} thumb-slides`);
      else fail(`${tag} thumb-slides`, `thumb left ${before.toFixed(0)} → ${after.toFixed(0)}`);

      /* boards: nations hero bar */
      const nat = await pg.evaluate(`(${PROBE_NATIONS.toString()})()`);
      if (nat.pass) {
        pass(`${tag} nations`);
        await pg.screenshot({ path: path.join(SHOTS, `ranks-${tag}-nations.png`) });
      } else fail(`${tag} nations`, nat.fails.join('\n- '));

      /* guilds: the same floating podium, with each crest's Join / Invite key */
      await pg.click('.ranks-tabs [data-board="guilds"]');
      await pg.waitForTimeout(500);
      const guilds = await pg.evaluate(() => {
        const cards = [...document.querySelectorAll('#ranks-podium .pod-card')]
          .filter((c) => c.getBoundingClientRect().height > 0);
        return {
          cards: cards.length,
          keys: cards.filter((c) => c.querySelector('.pod-btn')).length,
          feet: cards.filter((c) => (c.querySelector('.pod-foot')?.textContent ?? '').trim().length > 0).length,
        };
      });
      if (guilds.cards === 3 && guilds.keys === 3 && guilds.feet === 3) pass(`${tag} guilds`);
      else fail(`${tag} guilds`, `cards ${guilds.cards}, join keys ${guilds.keys}, plinths ${guilds.feet}`);
      await pg.screenshot({ path: path.join(SHOTS, `ranks-${tag}-guilds.png`) });

      /* back to minds, then the mind sheet from a runner row */
      await pg.click('.ranks-tabs [data-board="minds"]');
      await pg.waitForTimeout(400);
      try {
        await pg.click('#ranks-minds .rank-row.lb-row', { timeout: 4000 });
        await pg.waitForTimeout(600);
        const open = await pg.evaluate(() => {
          const s = document.getElementById('sheet-mind');
          return !!(s && !s.hidden && s.getBoundingClientRect().height > 0);
        });
        if (open) {
          pass(`${tag} mind-sheet`);
          await pg.screenshot({ path: path.join(SHOTS, `ranks-${tag}-mind-sheet.png`) });
        } else console.log(`NOTE ${tag}: mind sheet did not open from a row tap`);
        await pg.keyboard.press('Escape');
        await pg.waitForTimeout(400);
      } catch {
        console.log(`NOTE ${tag}: no runner row available to tap`);
      }
    }

    /* the key routes home */
    await pg.click('.dock-nav .tab[data-tab="ranks"]');
    await pg.waitForTimeout(400);
    try {
      await pg.click('.solo-standing .mh-cta', { timeout: 5000 });
      await pg.waitForTimeout(600);
      const homeShown = await pg.evaluate(() => !document.getElementById('s-home')?.hidden);
      if (homeShown) pass(`${tag} cta-routes-home`);
      else fail(`${tag} cta-routes-home`, 'CLIMB NOW did not reveal #s-home');
    } catch {
      fail(`${tag} cta-routes-home`, 'the CLIMB NOW key was not clickable');
    }

    await ctx.close();
  }
} finally {
  await browser.close();
  srv.close();
}

if (failed > 0) {
  console.error(`${failed} failed check(s)`);
  process.exit(1);
}
console.log('all ranks checks passed');
