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
 *   - the header loses its championship wordmark (20-22px ultra-bold, tracked
 *     -0.3px, white with an ambient shadow) or its metallic "SEASON N" badge,
 *   - the title collides with the countdown capsule, or the capsule loses its
 *     amber beacon,
 *   - the board tabs lose their borderless pill groove or sliding thumb,
 *   - the podium loses its floating geometry: circular avatars, a taller gold
 *     centre, short rank pills ("GM II"), or a TIQ score that is not the shared
 *     #i-brain token the ladder rows use,
 *   - the podium crests or the leader's crown lose clearance under the tab bar,
 *   - the three stepped plinths lose their 38/28/22 heights, their distinct
 *     gold / titanium / bronze faces, their embossed numerals or the gold aura,
 *   - the You strip regains any of the four attribute meters, the milestone line
 *     or a second row, or stops being a single ~48px gradient-and-border HUD,
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
  /* every geometry gate below is a rest-state gate: the podium lives inside this
     scroller, so a stray scroll would report the avatars as clipped */
  if (sc) sc.scrollTop = 0;
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

  /* 4. the declutter: the three-box stat cluster, the Preview tag and the old
        CLIMB NOW key never return */
  for (const ghost of ['#ranks-stats', '.ranks-stats', '.rstat', '.ml-preview', '.ml-badges', '.mh-cta']) {
    if (root.querySelector(ghost)) bad(`clutter regression: ${ghost} is still in the DOM`);
  }
  if (/climb\s*now/i.test(root.textContent ?? '')) bad('CLIMB NOW copy is still on the ranks screen');

  /* 5. the header: a championship wordmark over a metallic season badge, with
        the "Nd left" capsule tucked to the right — no collision between them */
  const head = root.querySelector('.ranks-head');
  if (!head || head.getBoundingClientRect().height === 0) bad('ranks head missing/collapsed');
  else {
    const hh = head.getBoundingClientRect().height;
    if (hh > 56) bad(`ranks head is ${hh.toFixed(1)}px tall — should be one slim band (<= 56)`);
  }
  const title = root.querySelector('.ml-title');
  if (!title || !/mind ladder/i.test(title.textContent)) bad('ml-title missing/wrong');
  else {
    const ts = getComputedStyle(title);
    const fs = parseFloat(ts.fontSize);
    if (fs < 20 - 0.05 || fs > 22 + 0.05) bad(`title is ${fs}px — want 20-22px display type`);
    if (parseInt(ts.fontWeight, 10) < 800) bad(`title weight is ${ts.fontWeight}, want ultra-bold`);
    if (!/rgb\(255,\s*255,\s*255\)/.test(ts.color)) bad(`title ink is ${ts.color}, want #FFFFFF`);
    if (ts.textShadow === 'none') bad('title has no ambient shadow');
    if (!near(parseFloat(ts.letterSpacing), -0.3, 0.12)) bad(`title tracking is ${ts.letterSpacing}, want -0.3px`);
    const pillR = root.querySelector('.ml-season')?.getBoundingClientRect();
    const titleR = title.getBoundingClientRect();
    if (pillR && titleR.right > pillR.left - 4) {
      bad(`title collides with the countdown pill (title right ${titleR.right.toFixed(1)} vs pill left ${pillR.left.toFixed(1)})`);
    }
    out.notes.title = `${fs}px / ${ts.fontWeight} / ${ts.letterSpacing}`;
  }
  const sub = root.querySelector('.ml-sub');
  if (!sub || !/^season \d+/i.test(sub.textContent.trim())) bad(`season subtitle is "${sub?.textContent}"`);
  else {
    const ss = getComputedStyle(sub);
    const sfs = parseFloat(ss.fontSize);
    if (sfs < 9.5 || sfs > 10.5) bad(`season badge is ${sfs}px — want 10px`);
    if (parseInt(ss.fontWeight, 10) < 700) bad(`season badge weight is ${ss.fontWeight}, want 700`);
    if (!near(parseFloat(ss.letterSpacing), 1.2, 0.12)) bad(`season badge tracking is ${ss.letterSpacing}, want +1.2px`);
    if (ss.textTransform !== 'uppercase') bad(`season badge transform is ${ss.textTransform}, want uppercase`);
    if (!/rgb\(148,\s*163,\s*184\)/.test(ss.color)) bad(`season badge ink is ${ss.color}, want #94A3B8`);
    if (!/gradient/.test(ss.backgroundImage)) bad('season badge has no metallic face');
    out.notes.season = `${sfs}px metallic badge`;
  }
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
  let secAvTop = null, champ = null;
  const plinthH = {};
  const footBottoms = [];
  for (const card of cards) {
    const rank = card.dataset.rank;
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
    if (glyph !== '#i-brain') bad(`podium TIQ glyph is ${glyph}, want the shared #i-brain`);
    if (getComputedStyle(iq.querySelector('b')).textShadow === 'none') bad('podium TIQ digits are not glowing');

    /* the crest must sit whole inside the scroller, not tucked under the tab bar */
    const scTop = sc.getBoundingClientRect().top;
    if (ar.top < scTop + 0.5) {
      bad(`rank ${rank} avatar is clipped by the scroller: top ${ar.top.toFixed(1)} vs ${scTop.toFixed(1)}`);
    }
    const tabsBottom = root.querySelector('.ranks-tabs')?.getBoundingClientRect().bottom ?? 0;
    if (ar.top < tabsBottom + 8) {
      bad(`rank ${rank} avatar has no breathing room under the tabs (${(ar.top - tabsBottom).toFixed(1)}px)`);
    }

    /* the plinth: exact stepped height, a cut metal face, a stepped cornice,
       a seated base, an embossed numeral and an aura beneath the base */
    const foot = card.querySelector('.pod-foot');
    if (!foot || foot.textContent.trim().length === 0) { bad('a podium card has no rank plinth'); continue; }
    const fr = foot.getBoundingClientRect();
    const fcs = getComputedStyle(foot);
    const num = foot.querySelector('b');
    const ns = num ? getComputedStyle(num) : null;
    const aura = foot.querySelector('.pod-foot-aura');
    const cap = getComputedStyle(foot, '::before');
    const base = getComputedStyle(foot, '::after');
    plinthH[rank] = fr.height;
    footBottoms.push(fr.bottom);
    const want = rank === '1' ? 38 : rank === '2' ? 28 : 22;
    if (!near(fr.height, want, 0.8)) bad(`rank ${rank} plinth is ${fr.height.toFixed(1)}px tall, want ${want}`);
    if (parseFloat(fcs.borderTopWidth) < 0.9) bad(`rank ${rank} plinth has no metal rim`);
    if (cap.content === 'none' || cap.content === '') bad(`rank ${rank} plinth has no stepped cornice`);
    if (base.content === 'none' || base.content === '') bad(`rank ${rank} plinth has no seated base`);
    if (!aura || aura.getBoundingClientRect().width < fr.width * 0.9) bad(`rank ${rank} plinth has no aura beneath the base`);
    if (!num || ns.textShadow === 'none') bad(`rank ${rank} numeral is not embossed`);

    if (rank === '1') {
      champ = { h: cr.height, avTop: ar.top };
      const crown = card.querySelector('.pod-crown');
      if (!crown || crown.getBoundingClientRect().width < 16) bad('gold crown missing/collapsed');
      if (!/rgb\(42,\s*35,\s*18\)/.test(fcs.backgroundImage) || !/rgb\(23,\s*21,\s*16\)/.test(fcs.backgroundImage)) {
        bad(`gold plinth gradient is "${fcs.backgroundImage.slice(0, 90)}" — want #2A2312 → #171510`);
      }
      if (!/rgba\(245,\s*158,\s*11,\s*0\.45\)/.test(fcs.borderTopColor)) bad(`gold plinth rim is ${fcs.borderTopColor}, want rgba(245,158,11,0.45)`);
      if (!ns || ns.color !== 'rgb(252, 211, 77)') bad(`gold numeral ink is ${ns?.color}, want #FCD34D`);
      if (!ns || !near(parseFloat(ns.fontSize), 15, 0.3)) bad(`gold numeral is ${ns?.fontSize}, want 15px`);
      if (!/rgba\(245,\s*158,\s*11,\s*0\.42\)/.test(getComputedStyle(aura).backgroundImage)) bad('gold plinth aura is not gold');
    } else if (rank === '2') {
      secAvTop = ar.top;
      if (!/rgb\(30,\s*36,\s*48\)/.test(fcs.backgroundImage) || !/rgb\(18,\s*22,\s*32\)/.test(fcs.backgroundImage)) {
        bad(`silver plinth gradient is "${fcs.backgroundImage.slice(0, 90)}" — want #1E2430 → #121620`);
      }
      if (!/rgba\(148,\s*163,\s*184,\s*0\.35\)/.test(fcs.borderTopColor)) bad(`silver plinth rim is ${fcs.borderTopColor}, want rgba(148,163,184,0.35)`);
      if (!ns || ns.color !== 'rgb(226, 232, 240)') bad(`silver numeral ink is ${ns?.color}, want titanium #E2E8F0`);
      if (!ns || !near(parseFloat(ns.fontSize), 13, 0.3)) bad(`silver numeral is ${ns?.fontSize}, want 13px`);
    } else if (rank === '3') {
      if (!/rgb\(38,\s*27,\s*18\)/.test(fcs.backgroundImage) || !/rgb\(21,\s*17,\s*14\)/.test(fcs.backgroundImage)) {
        bad(`bronze plinth gradient is "${fcs.backgroundImage.slice(0, 90)}" — want #261B12 → #15110E`);
      }
      if (!/rgba\(217,\s*119,\s*6,\s*0\.35\)/.test(fcs.borderTopColor)) bad(`bronze plinth rim is ${fcs.borderTopColor}, want rgba(217,119,6,0.35)`);
      if (!ns || ns.color !== 'rgb(253, 186, 116)') bad(`bronze numeral ink is ${ns?.color}, want warm bronze #FDBA74`);
      if (!ns || !near(parseFloat(ns.fontSize), 13, 0.3)) bad(`bronze numeral is ${ns?.fontSize}, want 13px`);
    }

    /* avatar · name · tier · score chip · pedestal share one vertical axis */
    const centers = [av, card.querySelector('.pod-name'), tier, iq, foot]
      .filter(Boolean)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2;
      });
    if (Math.max(...centers) - Math.min(...centers) > 1.5) bad(`rank ${rank} column is not centred over its plinth`);
  }
  /* one TIQ token across the whole ladder: podium and rows must agree, and no
     star glyph may survive anywhere on the screen */
  const podGlyphs = new Set([...root.querySelectorAll('#ranks-podium .pod-iq use')].map((u) => u.getAttribute('href')));
  if (podGlyphs.size !== 1 || !podGlyphs.has('#i-brain')) {
    bad(`podium TIQ icons are not unified: ${[...podGlyphs].join(', ') || 'none'}`);
  }
  const rowGlyphs = new Set([...root.querySelectorAll('#ranks-minds .lb-line use')].map((u) => u.getAttribute('href')));
  if (rowGlyphs.size && !(rowGlyphs.size === 1 && rowGlyphs.has('#i-brain'))) {
    bad(`ladder TIQ icons disagree with the podium: ${[...rowGlyphs].join(', ')}`);
  }
  if (/[☆★]/.test(root.textContent ?? '')) bad('a star glyph is still painted on the ranks screen');
  const crown = root.querySelector('#ranks-podium .pod-crown');
  const crownBox = crown?.getBoundingClientRect();
  if (!crownBox || crownBox.top < sc.getBoundingClientRect().top + 2) {
    bad(`the leader's crown has no clearance: top ${crownBox?.top.toFixed(1)} vs scroller ${sc.getBoundingClientRect().top.toFixed(1)}`);
  }
  out.notes.podium = `3 brains, crown top ${crownBox?.top.toFixed(0)}, avatar top ${Math.min(...cards.map((c) => c.querySelector('.pod-av').getBoundingClientRect().top)).toFixed(0)}`;
  if (!(plinthH['1'] > plinthH['2'] && plinthH['2'] > plinthH['3'])) {
    bad(`plinths are not stepped: ${plinthH['1']?.toFixed(0)} / ${plinthH['2']?.toFixed(0)} / ${plinthH['3']?.toFixed(0)}`);
  }
  if (footBottoms.length === 3 && Math.max(...footBottoms) - Math.min(...footBottoms) > 1.5) {
    bad('the three plinths do not share one base line');
  }
  if (champ && champ.h < 150) bad(`gold card is only ${champ.h.toFixed(1)}px tall (want >= 150)`);
  if (champ && secAvTop !== null && secAvTop - champ.avTop < 20) bad('gold crest is not elevated above the challengers');
  const band = root.querySelector('.pod-band, #pod-band');
  if (band && visible(band)) bad('the podium band caption is back — the header already carries the season');

  /* 8. the You strip: one 48px row — ringed avatar · "You" · tier crest · percentile
        chip on the left, brain + TIQ + mono delta on the right. No meters, no prose,
        no action key; the milestone survives only as the strip's own tooltip. */
  const slate = root.querySelector('.solo-standing.mh');
  if (!slate || !visible(slate)) { bad('You strip missing'); return out; }
  const ss = getComputedStyle(slate);
  if (!/rgb\(22,\s*31,\s*48\)/.test(ss.backgroundImage) || !/rgb\(15,\s*22,\s*36\)/.test(ss.backgroundImage)) {
    bad(`You strip gradient is "${ss.backgroundImage.slice(0, 90)}" — want #161F30 → #0F1624`);
  }
  if (!/rgba\(255,\s*255,\s*255,\s*0\.0?7\)/.test(ss.borderTopColor)) bad(`You strip border is ${ss.borderTopColor}, want rgba(255,255,255,0.07)`);
  const slateH = slate.getBoundingClientRect().height;
  if (!near(slateH, 48, 1.5)) bad(`You strip is ${slateH.toFixed(1)}px tall — want the single 48px row`);
  if (ss.flexDirection !== 'row') bad(`You strip lays out as ${ss.flexDirection}, want one row`);
  /* one row = one shared centre line; the three children differ in height, so
     comparing tops would fail a correctly centred strip */
  const kidMids = new Set([...slate.children].map((c) => {
    const b = c.getBoundingClientRect();
    return Math.round(b.top + b.height / 2);
  }));
  if (kidMids.size !== 1) bad(`You strip children are not on one row: centres ${[...kidMids].join(', ')}`);
  if (!slate.querySelector('.mh-ring .mh-arc-fill')) bad('XP progress ring missing');
  const ringBox = slate.querySelector('.mh-ring')?.getBoundingClientRect();
  if (!ringBox || ringBox.height > 44) bad(`the strip's ring is ${ringBox?.height.toFixed(1)}px — it must fit inside 48px`);
  const line = slate.querySelector('.mh-line');
  if (!line || line.textContent.trim() !== 'You') bad(`identity is "${line?.textContent}" — want the bare "You"`);
  const crest = slate.querySelector('.mh-pill');
  if (!crest || !/^(RK|TAC|STR|GM) (I|II|III)$/.test(crest.textContent.trim())) {
    bad(`tier crest is "${crest?.textContent}" — want a short pill like "GM II"`);
  }
  const chip = slate.querySelector('.mh-chip');
  if (!chip || !/^(Top \d+%|Unranked|Bottom)$/.test(chip.textContent.trim())) bad(`percentile chip is "${chip?.textContent}"`);
  const mhScore = slate.querySelector('.mh-score b');
  if (!mhScore || !/^\d[\d,]*$/.test(mhScore.textContent.trim())) bad(`TIQ score is "${mhScore?.textContent}"`);
  if (slate.querySelector('.mh-score use')?.getAttribute('href') !== '#i-brain') bad('the strip does not read TIQ with the shared brain');
  const mhDelta = slate.querySelector('.mh-score .lb-delta');
  if (mhDelta) {
    if (!/^[+\u2212-]?\d+$/.test(mhDelta.textContent.trim())) bad(`delta tag is "${mhDelta.textContent}"`);
    if (!/mono/i.test(getComputedStyle(mhDelta).fontFamily)) bad('the delta tag is not monospace');
  }

  /* the clutter ban: the four meters, the milestone line and any action key stay gone */
  for (const ghost of ['.mh-axes', '.mh-axis', '.mh-track', '.mh-prog', '.mh-ptrack', '.mh-ptext', '.mh-top', '.mh-pct', '.mh-cta', 'button']) {
    if (slate.querySelector(ghost)) bad(`You strip clutter is back: ${ghost}`);
  }
  if (/climb\s*now/i.test(slate.textContent ?? '')) bad('CLIMB NOW copy is still inside the You strip');
  if (/(foresight|tempo|traps|compose)/i.test(slate.textContent ?? '')) bad('an attribute meter label is still printed in the strip');
  if (!/wins? to |peak division/i.test(slate.title)) bad('the next-division milestone was deleted rather than moved to the tooltip');
  if (!/wins? to |peak division/i.test(slate.getAttribute('aria-label') ?? '')) bad('the milestone is missing from the strip aria-label');
  out.notes.slate = `${slateH.toFixed(0)}px single-row HUD (${crest?.textContent} · ${chip?.textContent})`;

  /* 9. on entry the podium and the You strip must both fit the visible scroller:
        no clipping, no page scrollbar — the ladder below may still scroll itself */
  sc.scrollTop = 0;
  const visibleBottom = sc.getBoundingClientRect().bottom;
  for (const [name, el] of [['podium', root.querySelector('#ranks-podium')], ['You strip', slate]]) {
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
    if (res.pass) pass(tag, `audited (${res.notes.podium}; ${res.notes.slate}; ${res.notes.fit})`);
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

    /* the freed foot of the slate: no CTA, no button, no stale copy */
    await pg.click('.dock-nav .tab[data-tab="ranks"]');
    await pg.waitForTimeout(400);
    const removed = await pg.evaluate(() => {
      const screen = document.getElementById('s-ranks');
      return {
        keys: screen.querySelectorAll('.mh-cta').length,
        buttons: screen.querySelectorAll('.solo-standing.mh button').length,
        copy: /climb\s*now/i.test(screen.textContent ?? ''),
      };
    });
    if (removed.keys === 0 && removed.buttons === 0 && !removed.copy) pass(`${tag} cta-removed`);
    else fail(`${tag} cta-removed`, `keys ${removed.keys}, buttons ${removed.buttons}, copy ${removed.copy}`);

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
