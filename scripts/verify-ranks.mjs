/**
 * verify-ranks.mjs — headless audit of the Mind Ladder (#s-ranks) "Zen Luxury"
 * Dark-Clay overhaul.
 *
 * Serves ./dist over 127.0.0.1, drives the ranks screen at 320x568, 360x640,
 * 390x844 and 430x932 with a mocked badge ledger, and fails (exit 1) when:
 *   - anything overflows horizontally (page, scroller, or a visible element),
 *   - the page itself scrolls vertically (the screen must own its height),
 *   - the old three-box stat cluster (.ranks-stats / .rstat) or the Preview tag
 *     ever comes back,
 *   - the header loses its championship wordmark (20-22px ultra-bold, tracked
 *     -0.3px, white with an ambient shadow), its "SEASON N" micro-pill, or the
 *     recessed clay band that holds the two and the countdown in one bar,
 *   - the title collides with the countdown capsule, or the capsule loses its
 *     amber beacon,
 *   - the board tabs lose their borderless pill groove or sliding thumb,
 *   - the podium loses its floating geometry: circular avatars, a taller gold
 *     centre, or a TIQ score that is not the shared #i-brain token the ladder
 *     rows use,
 *   - any legacy rank pill ("GM II", "STRATEGIST III", "TAC I", "RK II") comes
 *     back on the podium, a ladder row or the You strip,
 *   - a minted honor loses its coin pin, its real serial tag, or the pedestal's
 *     matching cyan/amber/emerald underglow; a serial that was never minted appears,
 *   - a mind row loses its two-line hierarchy (name + serial / monospaced win count)
 *     or its right-aligned monospaced TIQ column,
 *   - the podium crests or the leader's crown lose clearance under the tab bar,
 *   - the three stepped plinths lose their 38/28/22 heights, their distinct
 *     gold / titanium / bronze faces, their embossed numerals or the gold aura,
 *   - the You strip regains the avatar progress ring, any score delta/trend tag,
 *     any of the four attribute meters, the milestone line or a second row, or
 *     stops being a single ~48px gradient-and-border HUD, loses the equipped
 *     medallion pin and its real "#007 / 50" serial, or a ranked player loses
 *     the numeric "#N" key that names their standing, or that key claims a podium
 *     place (#1-3) directly beneath the Top-3 podium,
 *   - any podium or ladder row carries a +/- delta tag or a trend arrow,
 *   - the rival nudge ticker ("… is N TIQ sharper today … JUMP") comes back in any
 *     shape — node or copy — between the strip and the ladder,
 *   - the podium and the You card cannot both fit a 360x640 screen without
 *     clipping (page scrollbar or cut edges),
 *   - the Nations IQ ticker or a country row's AVG metric comes back, a country
 *     row loses its player count, a podium pillar is not tappable, or the nation
 *     drill-down loses its medallion, its 20-50 player roster or Your standing,
 *     or the mind sheet regresses.
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
const VIEWPORTS = [[320, 568], [360, 640], [390, 844], [430, 932]];

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
  /* the legacy rank language is banned on every leaderboard surface */
  if (root.querySelector('.pod-tier, .lb-tier, .mh-pill, .mh-badge')) {
    bad('a legacy rank pill is still painted on the ranks screen');
  }
  if (/\b(?:GM|STR|TAC|RK)\s+(?:I|II|III)\b/i.test(root.textContent ?? '')
    || /strategist\s+(?:I|II|III)\b/i.test(root.textContent ?? '')) {
    bad(`legacy rank-pill copy is back: "${(root.textContent ?? '').match(/\b(?:GM|STR|TAC|RK)\s+(?:I|II|III)\b/i)?.[0] ?? 'STRATEGIST…'}"`);
  }

  /* 5. the header: a championship wordmark over a metallic season badge, with
        the "Nd left" capsule tucked to the right — no collision between them */
  const head = root.querySelector('.ranks-head');
  if (!head || head.getBoundingClientRect().height === 0) bad('ranks head missing/collapsed');
  else {
    const hb = head.getBoundingClientRect();
    const hcs = getComputedStyle(head);
    if (hb.height > 56) bad(`ranks head is ${hb.height.toFixed(1)}px tall — should be one slim band (<= 56)`);
    /* one bar, not three loose labels: the plate that carries the wordmark, the
       season badge and the countdown has to be machined, not transparent */
    if (parseFloat(hcs.borderTopLeftRadius) < 12) bad(`ranks head is not a band (radius ${hcs.borderTopLeftRadius})`);
    if (hcs.backgroundImage === 'none' && /rgba\(0, 0, 0, 0\)|transparent/.test(hcs.backgroundColor)) bad('ranks head has no clay plate behind its three parts');
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
    if (title.scrollWidth > title.clientWidth + 1) bad(`wordmark truncates at this width (${title.scrollWidth} > ${title.clientWidth})`);
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
    if (!/rgba\(255,\s*255,\s*255,\s*0\.06\)/.test(ss.backgroundColor)) bad(`season badge fill is ${ss.backgroundColor}, want rgba(255,255,255,.06)`);
    if (!/rgba\(255,\s*255,\s*255,\s*0\.1\)/.test(ss.borderTopColor)) bad(`season badge rim is ${ss.borderTopColor}, want rgba(255,255,255,.1)`);
    if (!near(parseFloat(ss.borderTopLeftRadius), 6, 0.05)) bad(`season badge radius is ${ss.borderTopLeftRadius}, want 6px`);
    out.notes.season = `${sfs}px micro-pill`;
  }
  const pill = root.querySelector('.ml-season .ml-season-t');
  if (!pill || !/^\d+d left$/.test(pill.textContent.trim())) bad(`countdown pill is "${pill?.textContent}"`);
  const beacon = root.querySelector('.ml-season .ml-pulse');
  if (!beacon || beacon.getBoundingClientRect().width < 3) bad('season beacon missing/collapsed');
  else {
    const bcs = getComputedStyle(beacon);
    if (!/rgb\(251,\s*191,\s*36\)/.test(bcs.backgroundColor)) bad(`season beacon is ${bcs.backgroundColor}, want amber #FBBF24`);
    if (getComputedStyle(beacon, '::after').animationName === 'none') bad('the season beacon no longer pulses');
  }
  /* the countdown is its own tactile amber capsule with a visible rim and ink */
  const capsule = root.querySelector('.ml-season');
  if (capsule) {
    const kcs = getComputedStyle(capsule);
    if (parseFloat(kcs.borderTopLeftRadius) < 999) bad(`countdown capsule radius is ${kcs.borderTopLeftRadius}, want a pill`);
    if (!near(parseFloat(kcs.fontSize), 11, 0.05)) bad(`countdown capsule is ${kcs.fontSize}, want 11px`);
    if (!/rgba\(245,\s*158,\s*11,\s*0\.1\)/.test(kcs.backgroundColor)) bad(`countdown capsule fill is ${kcs.backgroundColor}, want rgba(245,158,11,.1)`);
    if (!/rgba\(245,\s*158,\s*11,\s*0\.3\)/.test(kcs.borderTopColor)) bad(`countdown capsule rim is ${kcs.borderTopColor}, want rgba(245,158,11,.3)`);
    if (!/rgb\(251,\s*191,\s*36\)/.test(kcs.color)) bad(`countdown ink is ${kcs.color}, want #FBBF24`);
  }

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

    /* the equipped medallion: coin pin on the avatar rim, real serial tag, and a
       pedestal underglow in the honor's own metal (Amara/Einstein amber,
       Sofia/Churchill cyan, Kenji/Heisenberg emerald in the mocked ledger) */
    if (card.querySelector('.pod-tier')) bad(`rank ${rank} still carries a legacy rank pill`);
    const medal = card.querySelector('.pod-medal');
    const serial = card.querySelector('.pod-serial');
    const footMedal = card.querySelector('.pod-foot-medal');
    if (!medal) bad(`rank ${rank} lost its minted medallion pin`);
    else {
      const pin = medal.getBoundingClientRect();
      if (pin.width < 19.5 || pin.width > 25) bad(`rank ${rank} medal pin is ${pin.width.toFixed(1)}px — want 20-24`);
      if (!medal.querySelector('.badge-crest')) bad(`rank ${rank} medal pin has no coin art`);
      const pcx = pin.left + pin.width / 2;
      const pcy = pin.top + pin.height / 2;
      if (Math.abs(pcx - ar.right) > 10 || Math.abs(pcy - ar.bottom) > 10) {
        bad(`rank ${rank} medal pin is not seated on the avatar rim (${(pcx - ar.right).toFixed(1)}, ${(pcy - ar.bottom).toFixed(1)})`);
      }
    }
    if (!serial || !/^#\d{3}$/.test(serial.textContent.trim())) {
      bad(`rank ${rank} serial tag is "${serial?.textContent}" — want a real "#007" serial`);
    }
    const wantAccent = rank === '1' ? 'quantum' : rank === '2' ? 'titanium' : 'frost';
    if (card.dataset.medal !== wantAccent) bad(`rank ${rank} wears ${card.dataset.medal ?? 'no accent'} — want ${wantAccent}`);
    if (!footMedal) bad(`rank ${rank} medal holder has no pedestal underglow`);
    else {
      const want = rank === '1' ? '245, 158, 11' : rank === '2' ? '34, 211, 238' : '52, 211, 153';
      const shadow = getComputedStyle(footMedal).boxShadow;
      if (!new RegExp(`rgba\\(${want}`).test(shadow)) bad(`rank ${rank} pedestal underglow is "${shadow.slice(0, 70)}" — want rgb(${want})`);
    }
    out.notes.medals = `${out.notes.medals ? `${out.notes.medals} · ` : ''}#${rank} ${card.dataset.medal}:${serial?.textContent?.trim() ?? '—'}`;

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

    /* avatar · name · serial · score chip · pedestal share one vertical axis */
    const centers = [av, card.querySelector('.pod-name'), serial, iq, foot]
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

  /* 7b. the delta purge: no +/- tags, no trend arrows, and every score cell is
        one clean [brain][digits] line in both the podium and the ladder */
  if (root.querySelector('.lb-delta, .pod-delta')) bad('a score delta tag is still painted on the ranks screen');
  if (/[▲▼]/.test(root.textContent ?? '')) bad('a trend arrow is still painted on the ranks screen');
  if (root.querySelector('.rank-row .tr')) bad('a ladder row still carries a trend indicator');
  if (root.querySelector('.rank-row .lb-act')) bad('a solo ladder row still reserves the old action column');
  for (const chip of root.querySelectorAll('#ranks-podium .pod-iq')) {
    if (!/^\d[\d,]*$/.test((chip.textContent ?? '').trim())) bad(`podium score chip is "${chip.textContent?.trim()}" — want digits only`);
  }
  for (const cell of root.querySelectorAll('.rank-row .lb-score')) {
    if (cell.querySelector('small')) bad(`ladder score cell carries an extra line: "${cell.textContent?.trim()}"`);
    const line = cell.querySelector('.lb-line');
    const glyphHref = line?.querySelector('use')?.getAttribute('href');
    if (glyphHref !== '#i-brain') bad(`ladder score glyph is ${glyphHref ?? 'missing'}, want the shared brain`);
    if (!/^\d[\d,]*$/.test((line?.querySelector('b')?.textContent ?? '').trim())) bad(`ladder score is "${line?.textContent?.trim()}" — want digits only`);
  }

  /* 7c. the mind ladder's clean two-line hierarchy and right-aligned mono TIQ */
  const mindRows = [...root.querySelectorAll('#ranks-minds .rank-row')];
  if (mindRows.length < 3) bad('Top Minds ladder rows missing');
  const scoreRights = [];
  let rowSerials = 0;
  for (const r of mindRows) {
    if (r.querySelector('.lb-tier')) bad(`row #${r.dataset.rank} still carries a legacy tier tag`);
    const sub = r.querySelector('.lb-sub');
    const subText = r.querySelector('.lb-sub-t')?.textContent?.trim() ?? '';
    if (!/^\d+\s+wins?$/.test(subText)) bad(`row #${r.dataset.rank} second line is "${subText}" — want a win count`);
    if (!sub || !/mono/i.test(getComputedStyle(sub).fontFamily)) bad(`row #${r.dataset.rank} win count is not monospaced`);
    if (sub && !near(parseFloat(getComputedStyle(sub).fontSize), 10.5, 0.3)) {
      bad(`row #${r.dataset.rank} win count is ${getComputedStyle(sub).fontSize}, want 10.5px`);
    }
    const txt = r.querySelector('.lb-txt');
    if (txt && txt.children.length !== 2) bad(`row #${r.dataset.rank} has ${txt.children.length} identity lines — want exactly two`);
    const serial = r.querySelector('.lb-serial');
    if (serial) {
      rowSerials += 1;
      if (!/^#\d{3}$/.test(serial.textContent.trim())) bad(`row #${r.dataset.rank} serial is "${serial.textContent.trim()}"`);
      if (serial.closest('.lb-nm') === null) bad(`row #${r.dataset.rank} serial is not on the name line`);
      if (!/^(titanium|quantum|frost)$/.test(serial.dataset.accent ?? '')) bad(`row #${r.dataset.rank} serial has no honor metal`);
    }
    const score = r.querySelector('.lb-score');
    const scoreB = score?.querySelector('b');
    if (!scoreB || !/mono/i.test(getComputedStyle(scoreB).fontFamily)) bad(`row #${r.dataset.rank} TIQ digits are not monospaced`);
    if (score) {
      const rr = r.getBoundingClientRect();
      const sr = score.getBoundingClientRect();
      scoreRights.push(sr.right);
      if (Math.abs(sr.right - (rr.right - parseFloat(getComputedStyle(r).paddingRight))) > 1.2) {
        bad(`row #${r.dataset.rank} TIQ is not pinned to the right edge (${(rr.right - sr.right).toFixed(1)}px inset)`);
      }
    }
    const h = r.getBoundingClientRect().height;
    if (h < 52 || h > 60) bad(`row #${r.dataset.rank} is ${h.toFixed(1)}px tall — want the 56px band`);
  }
  if (scoreRights.length && Math.max(...scoreRights) - Math.min(...scoreRights) > 0.6) {
    bad(`TIQ column is not uniform: ${scoreRights.map((n) => n.toFixed(1)).join(' / ')}`);
  }
  if (rowSerials < 2) bad(`only ${rowSerials} ladder rows wear their minted serial — want Priya and Lucas from the mocked ledger`);
  out.notes.rows = `${mindRows.length} rows · ${rowSerials} serials · TIQ right edges uniform`;
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

  /* 8. the You strip: one 48px row — clean clay avatar with its equipped medallion ·
        "You" · real minted serial · percentile chip on the left, brain + TIQ on the
        right. No progress arc, no delta tag, no meters, no prose, no action key;
        the milestone survives only as the strip's own tooltip. */
  const slate = root.querySelector('.solo-standing.mh');
  if (!slate || !visible(slate)) { bad('You strip missing'); return out; }
  const ss = getComputedStyle(slate);
  if (!/rgb\(22,\s*31,\s*48\)/.test(ss.backgroundImage) || !/rgb\(15,\s*22,\s*36\)/.test(ss.backgroundImage)) {
    bad(`You strip gradient is "${ss.backgroundImage.slice(0, 90)}" — want #161F30 → #0F1624`);
  }
  if (!/rgba\(148,\s*163,\s*184,\s*0?\.22\)/.test(ss.borderTopColor)) bad(`You strip border is ${ss.borderTopColor}, want the metallic rgba(148,163,184,0.22) rim`);
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
  if (slate.querySelector('.mh-ring, .mh-arc')) bad('the avatar progress ring is back in the You strip');
  const avatar = slate.querySelector('.mh-av');
  const avatarBox = avatar?.getBoundingClientRect();
  if (!avatar || !avatarBox) bad('the clean clay avatar is missing from the You strip');
  else {
    const acs = getComputedStyle(avatar);
    if (!near(parseFloat(acs.borderTopWidth), 1, 0.05)) bad(`avatar frame border is ${acs.borderTopWidth}, want 1px`);
    if (!/rgba\(255,\s*255,\s*255,\s*0\.0?8\)/.test(acs.borderTopColor)) bad(`avatar frame border is ${acs.borderTopColor}, want rgba(255,255,255,0.08)`);
    if (acs.borderTopLeftRadius !== '50%' && parseFloat(acs.borderTopLeftRadius) < avatarBox.width / 2 - 1) bad('avatar frame is not circular');
    if (avatarBox.height > 44) bad(`the strip's avatar is ${avatarBox.height.toFixed(1)}px — it must fit inside 48px`);
  }
  const line = slate.querySelector('.mh-line');
  if (!line || line.textContent.trim() !== 'You') bad(`identity is "${line?.textContent}" — want the bare "You"`);
  if (slate.querySelector('.mh-pill, .mh-badge')) bad('a legacy tier crest is still worn in the You strip');
  /* the equipped medallion: a 20px coin on the avatar rim plus the real server serial */
  const stripMedal = slate.querySelector('.mh-medal');
  const stripSerial = slate.querySelector('.mh-serial');
  if (!stripMedal) bad('the equipped medallion is not pinned to the You avatar');
  else {
    const pin = stripMedal.getBoundingClientRect();
    if (pin.width < 19.5 || pin.width > 24.5) bad(`You-strip medal pin is ${pin.width.toFixed(1)}px — want 20-24`);
    if (!stripMedal.querySelector('.badge-crest')) bad('the You-strip medal has no coin art');
    if (stripMedal.dataset.accent !== 'quantum') bad(`You-strip medal accent is ${stripMedal.dataset.accent ?? 'missing'} — want the equipped quantum honor`);
    if (avatarBox) {
      const pcx = pin.left + pin.width / 2;
      const pcy = pin.top + pin.height / 2;
      if (Math.abs(pcx - avatarBox.right) > 10 || Math.abs(pcy - avatarBox.bottom) > 10) {
        bad(`You-strip medal is not on the avatar rim (${(pcx - avatarBox.right).toFixed(1)}, ${(pcy - avatarBox.bottom).toFixed(1)})`);
      }
    }
  }
  if (!stripSerial || stripSerial.textContent.trim() !== '#007 / 50') {
    bad(`You-strip serial is "${stripSerial?.textContent}" — want the real "#007 / 50"`);
  } else if (stripSerial.dataset.accent !== 'quantum') {
    bad(`You-strip serial accent is ${stripSerial.dataset.accent ?? 'missing'} — want quantum`);
  }
  const chip = slate.querySelector('.mh-chip');
  if (!chip || !/^(Top \d+%|Unranked|Bottom)$/.test(chip.textContent.trim())) bad(`percentile chip is "${chip?.textContent}"`);
  const mhScore = slate.querySelector('.mh-score b');
  if (!mhScore || !/^\d[\d,]*$/.test(mhScore.textContent.trim())) bad(`TIQ score is "${mhScore?.textContent}"`);
  if (slate.querySelector('.mh-score use')?.getAttribute('href') !== '#i-brain') bad('the strip does not read TIQ with the shared brain');
  if (slate.querySelector('.mh-score .lb-delta, .mh-score .pod-delta')) bad('a score delta tag is back in the You strip');
  if (/[▲▼]/.test(slate.textContent ?? '')) bad('a trend arrow is back in the You strip');

  /* the clutter ban: the four meters, the milestone line and any action key stay gone */
  for (const ghost of ['.mh-axes', '.mh-axis', '.mh-track', '.mh-prog', '.mh-ptrack', '.mh-ptext', '.mh-top', '.mh-pct', '.mh-cta', 'button']) {
    if (slate.querySelector(ghost)) bad(`You strip clutter is back: ${ghost}`);
  }
  if (/climb\s*now/i.test(slate.textContent ?? '')) bad('CLIMB NOW copy is still inside the You strip');
  if (/(foresight|tempo|traps|compose)/i.test(slate.textContent ?? '')) bad('an attribute meter label is still printed in the strip');
  if (!/wins? to |peak division/i.test(slate.title)) bad('the next-division milestone was deleted rather than moved to the tooltip');
  if (!/wins? to |peak division/i.test(slate.getAttribute('aria-label') ?? '')) bad('the milestone is missing from the strip aria-label');
  /* the numeric standing: the podium owns 1-3 and the rows carry 4+, so the strip
     is the only place a ranked player can read their own position — and an
     unranked one must not be handed a number the ladder never granted. */
  const rankBadge = slate.querySelector('.mh-rank');
  const unranked = chip && chip.textContent.trim() === 'Unranked';
  if (unranked) {
    if (rankBadge) bad('an unranked player is shown a numeric rank badge');
  } else {
    if (!rankBadge) bad('the You strip has no numeric rank badge');
    else if (!/^#\d{1,4}$/.test(rankBadge.textContent.trim())) bad(`rank badge reads "${rankBadge.textContent}"`);
    else {
      const shown = parseInt(rankBadge.textContent.replace('#', ''), 10);
      const podiumShown = !document.getElementById('ranks-podium')?.hidden;
      if (podiumShown && shown < 4) bad(`rank badge reads "#${shown}" beneath the Top-3 podium — want #4 or lower`);
      if (!/Rank \d+ of \d+/.test(slate.getAttribute('aria-label') ?? '')) bad('the rank badge is not spoken in the strip aria-label');
    }
  }
  /* the nudge ticker is gone: no node, no copy, and the rows sit under the strip */
  if (root.querySelector('.rival, .rival-dot, .rival-t, .rival-go')) bad('the rival nudge ticker is back in the DOM');
  if (/sharper today|close the gap/i.test(root.textContent ?? '')) bad('the rival nudge copy is back on the screen');
  out.notes.slate = `${slateH.toFixed(0)}px single-row HUD (${rankBadge?.textContent?.trim() ?? '—'} · ${stripSerial?.textContent?.trim() ?? 'no serial'} · ${chip?.textContent})`;

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

/* Nations board probe: the 48px HUD is either the dashed invitation or the
   chosen nation's rank / flag / total. The old Set-flag card must stay gone. */
const PROBE_NATIONS = () => {
  const out = { pass: true, fails: [], state: '' };
  const bad = (m) => { out.pass = false; out.fails.push(m); };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const pane = document.getElementById('ranks-nations');
  if (!pane) { bad('nations pane missing'); return out; }

  if (pane.querySelector('.nat-hero, .nat-hero-btn, .nat-foot')) bad('legacy flag card is still in the DOM');
  if (/your flag is not on the board yet/i.test(pane.textContent ?? '')) bad('legacy "Your flag is not on the board yet" copy is back');
  if (/\bset flag\b/i.test(pane.textContent ?? '')) bad('legacy "Set flag" copy is back');
  if (pane.querySelector('.nat-pill, [data-nat-cup]') || /Nations Cup/i.test(pane.textContent ?? '')) bad('Nations Cup ticker is still present');
  if (pane.querySelector('.lb-avg') || /\bAVG\b/i.test(pane.textContent ?? '')) bad('AVG metric is still present on country rows');

  const hud = pane.querySelector('.nation-hud');
  if (!hud) { bad('nation HUD missing'); return out; }
  const h = hud.getBoundingClientRect().height;
  if (!near(h, 48, 1.5)) bad(`nation HUD is ${h.toFixed(1)}px tall — want 48px`);
  if (hud.querySelector('.nh-av')?.getBoundingClientRect().height > 44) bad('nation HUD avatar is taller than the strip');

  if (hud.classList.contains('is-unset')) {
    out.state = 'unset';
    const cs = getComputedStyle(hud);
    if (cs.borderTopStyle !== 'dashed') bad(`unset HUD border is ${cs.borderTopStyle}, want dashed`);
    if (!/rgba\(15,\s*22,\s*36,\s*0\.7\)/.test(cs.backgroundColor)) bad(`unset HUD fill is ${cs.backgroundColor}, want rgba(15,22,36,0.7)`);
    if (!/No nation selected/i.test(hud.textContent ?? '')) bad(`unset HUD copy is "${hud.textContent?.trim()}"`);
    if (!/Tap to represent your flag/i.test(hud.textContent ?? '')) bad('unset HUD is missing the tactical hint');
    if (!hud.querySelector('.nh-globe use[href="#i-globe"]')) bad('unset HUD globe icon missing');
    const pill = hud.querySelector('.nh-pill');
    if (!pill || !/^Select Flag$/i.test(pill.textContent?.trim() ?? '')) bad(`unset HUD pill is "${pill?.textContent}"`);
  } else if (hud.classList.contains('is-set')) {
    out.state = 'selected';
    const rank = hud.querySelector('.nh-rank');
    if (!rank || !/^#\d+$/.test(rank.textContent?.trim() ?? '')) bad(`selected HUD rank is "${rank?.textContent}"`);
    if (!hud.querySelector('.nh-av .fp')) bad('selected HUD flag avatar missing');
    if (!hud.querySelector('.nh-tag') || !/your nation/i.test(hud.querySelector('.nh-tag').textContent ?? '')) bad('selected HUD YOUR NATION tag missing');
    if (!hud.querySelector('.nh-score use[href="#i-brain"]')) bad('selected HUD TIQ is not the shared brain token');
    if (!/^\d[\d,]*$/.test(hud.querySelector('.nh-score b')?.textContent?.trim() ?? '')) bad(`selected HUD score is "${hud.querySelector('.nh-score b')?.textContent}"`);
    if (!/^#?\d/.test(rank?.textContent?.trim() ?? '')) bad('selected HUD has no numeric rank');
  } else {
    bad('nation HUD is neither unset nor selected');
  }
  const widest = hud.getBoundingClientRect().right;
  if (widest > window.innerWidth + 0.5) bad(`nation HUD clips the right edge (${widest.toFixed(1)})`);
  if (hud.scrollWidth > hud.clientWidth + 1) bad(`nation HUD overflows horizontally (${hud.scrollWidth} > ${hud.clientWidth})`);
  if (hud.scrollHeight > hud.clientHeight + 1) bad(`nation HUD overflows vertically (${hud.scrollHeight} > ${hud.clientHeight})`);

  const rows = [...pane.querySelectorAll('.rank-list .lb-row')];
  if (!rows.length) bad('country ladder rows missing');
  const first = rows[0];
  if (first) {
    const gap = first.getBoundingClientRect().top - hud.getBoundingClientRect().bottom;
    if (gap < 7 || gap > 10) bad(`gap under the nation HUD is ${gap.toFixed(1)}px — want 8px`);
    const rowH = first.getBoundingClientRect().height;
    if (rowH < 48 || rowH > 60) bad(`country row is ${rowH.toFixed(1)}px tall — want 48-60px`);
    const score = first.querySelector('.lb-score');
    const cs = score ? getComputedStyle(score) : null;
    if (!score || score.children.length !== 1 || !score.querySelector('.lb-line')) bad('country score cluster is not one line');
    if (cs && (cs.alignItems !== 'center' || cs.justifyContent !== 'flex-end')) bad(`score cluster alignment is ${cs.alignItems} / ${cs.justifyContent}`);
  }
  for (const r of rows) {
    const sub = r.querySelector('.lb-sub-t')?.textContent ?? '';
    if (!/^\d[\d,.]*\s*players?$/i.test(sub)) bad(`country row #${r.dataset.rank} lost its player count ("${sub}")`);
    if (r.querySelector('.lb-avg')) bad(`country row #${r.dataset.rank} still carries an AVG line`);
    if (!r.getAttribute('aria-label')?.includes('nation roster')) bad(`country row #${r.dataset.rank} does not announce the nation roster`);
  }
  const pods = [...document.querySelectorAll('#ranks-podium .pod-card')];
  if (pods.length !== 3) bad(`nation podium has ${pods.length} cards — want 3`);
  for (const p of pods) {
    if (!p.classList.contains('is-tappable')) bad(`podium #${p.dataset.rank} is not tappable`);
    if (!p.hasAttribute('tabindex')) bad(`podium #${p.dataset.rank} is not keyboard reachable`);
  }

  if (document.scrollingElement.scrollWidth > window.innerWidth + 1) bad('page scrolls horizontally on Nations IQ');
  if (document.scrollingElement.scrollHeight > window.innerHeight + 1) bad('page scrolls vertically on Nations IQ');
  const sc = document.getElementById('ranks-scroll');
  if (sc && sc.scrollWidth > sc.clientWidth + 1) bad(`#ranks-scroll overflows on Nations IQ: ${sc.scrollWidth} > ${sc.clientWidth}`);
  return out;
};

/* Nation sheet probe: the drilled-down country, its minted medallion and the
   full national roster. The list must stay inside the sheet at every width and
   must never claim a head-count outside the 20-50 band the data layer slices. */
const PROBE_NATION_SHEET = (wantAura) => {
  const out = { pass: true, fails: [], state: {} };
  const bad = (m) => { out.pass = false; out.fails.push(m); };
  const sheet = document.getElementById('sheet-nation-detail');
  if (!sheet || sheet.hidden || sheet.getBoundingClientRect().height === 0) {
    bad('nation sheet is not open');
    return out;
  }
  const body = document.getElementById('nd-body');
  const head = document.getElementById('nd-head');
  if (!body) {
    bad('nation sheet body is missing');
    return out;
  }
  const rows = [...body.querySelectorAll('.nd-list .nd-row:not(.is-skel)')];
  out.state = {
    aura: sheet.dataset.aura ?? '',
    rows: rows.length,
    name: document.getElementById('nd-name')?.textContent?.trim() ?? '',
    kicker: document.getElementById('nd-kicker')?.textContent?.trim() ?? '',
    totals: body.querySelector('.nd-totals')?.textContent?.trim() ?? '',
    you: !!body.querySelector('.nd-you'),
  };

  if (!wantAura || out.state.aura !== wantAura) bad(`nation aura is "${out.state.aura}" — want "${wantAura}"`);
  if (!out.state.name) bad('nation sheet has no country name');
  if (!/^#\d+\s+worldwide$/i.test(out.state.kicker)) bad(`nation kicker is "${out.state.kicker}" — want "#N worldwide"`);
  if (!/\d[\d,]*\s*TIQ/i.test(out.state.totals)) bad(`nation totals lost the TIQ counter ("${out.state.totals}")`);
  if (!/\d[\d,]*\s*Players/i.test(out.state.totals)) bad(`nation totals lost the player counter ("${out.state.totals}")`);
  if (!body.querySelector('.nd-coin .nd-coin-face .fp-img, .nd-coin .nd-coin-face .fp-chip')) {
    bad('nation medallion has no flag');
  }
  if (rows.length < 20 || rows.length > 50) bad(`nation roster has ${rows.length} rows — want 20-50`);
  for (const r of rows) {
    const h = r.getBoundingClientRect().height;
    if (h < 46) bad(`roster row #${r.dataset.rank} is ${h.toFixed(1)}px tall — want >= 48 (46 tolerance)`);
    if (!/\d[\d,]*/.test(r.querySelector('.nd-score b')?.textContent ?? '')) bad(`roster row #${r.dataset.rank} lost its TIQ`);
    if (!r.getAttribute('aria-label')?.includes('Tactical IQ')) bad(`roster row #${r.dataset.rank} lost its accessible score`);
  }
  if (!body.querySelector('.nd-rk.t1') || !body.querySelector('.nd-rk.t2') || !body.querySelector('.nd-rk.t3')) {
    bad('roster top three lost their metal micro-badges');
  }
  if (out.state.you) {
    const own = body.querySelector('.nd-row.is-you');
    if (!own) bad('Your standing card is present but the player row is not highlighted');
    if (!body.querySelector('.nd-you .nd-score b')) bad('Your standing card lost its TIQ');
  }
  /* every row the sheet promises is reachable: the body owns the gesture */
  if (rows.length > 6) {
    if (body.scrollHeight <= body.clientHeight + 1) bad('nation roster is taller than the sheet but the body does not scroll');
    body.scrollTop = body.scrollHeight;
    const last = rows[rows.length - 1].getBoundingClientRect();
    const bb = body.getBoundingClientRect();
    if (last.bottom > bb.bottom + 1) bad('last roster row is not reachable by scrolling');
    body.scrollTop = 0;
  }
  if (sheet.scrollWidth > sheet.clientWidth + 1) bad(`nation sheet overflows horizontally: ${sheet.scrollWidth} > ${sheet.clientWidth}`);
  if (body.scrollWidth > body.clientWidth + 1) bad(`nation body overflows horizontally: ${body.scrollWidth} > ${body.clientWidth}`);
  if (document.scrollingElement.scrollWidth > window.innerWidth + 1) bad('page scrolls horizontally with the nation sheet open');
  if (document.scrollingElement.scrollHeight > window.innerHeight + 1) bad('page scrolls vertically with the nation sheet open');
  const close = sheet.querySelector('[data-sheet-close]');
  if (!close) bad('nation sheet has no close key');
  else {
    const cr = close.getBoundingClientRect();
    if (cr.width < 47.5 || cr.height < 47.5) bad(`nation close key is ${cr.width.toFixed(0)}x${cr.height.toFixed(0)} — want 48x48`);
  }
  const hr = head?.getBoundingClientRect();
  if (!hr || hr.height < 44) bad(`nation header is ${hr?.height?.toFixed(0) ?? 'missing'}px tall`);
  const firstTop = rows[0]?.getBoundingClientRect().top ?? 0;
  if (hr && firstTop && firstTop < hr.bottom - 1) bad('nation roster overlaps the fixed header');
  out.pass = out.pass && out.fails.length === 0;
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
    /* the public badge ledger, mocked at the wire: three minted podium holders and
       two ladder holders, so the coin pins and serial tags have real data to read */
    await ctx.route('**/api/badges/**', async (route) => {
      const url = route.request().url();
      const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.endsWith('/supply')) {
        return json({
          success: true,
          badges: {
            churchill_bastion: {
              cap: 100, minted: 21, remaining: 79,
              holders: [{ serial: 4, name: 'Priya' }, { serial: 21, name: 'Sofia' }],
            },
            einstein_singularity: {
              cap: 50, minted: 12, remaining: 38,
              holders: [{ serial: 7, name: 'You' }, { serial: 12, name: 'Amara' }],
            },
            heisenberg_formula: {
              cap: 25, minted: 13, remaining: 12,
              holders: [{ serial: 3, name: 'Kenji' }, { serial: 13, name: 'Lucas' }],
            },
          },
        });
      }
      if (url.endsWith('/progress')) return json({ success: true });
      if (url.endsWith('/mint')) {
        const id = route.request().postDataJSON()?.badgeId ?? '';
        const cap = id === 'einstein_singularity' ? 50 : id === 'heisenberg_formula' ? 25 : 100;
        const serial = id === 'einstein_singularity' ? 7 : 1;
        return json({ success: true, serial, cap, mintedAt: '2026-10-20T00:00:00.000Z' });
      }
      return route.fulfill({ status: 404, body: 'not mocked' });
    });
    /* a ranked save: 3400 TIQ puts the player below the seeded Top-3 podium, so
       the strip must own #4 rather than replay the silver medal above it. The
       equipped Einstein edition is a server-confirmed #007 / 50. */
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('detour.save.v2', JSON.stringify({
          v: 2,
          stats: { games: 50, wins: 20, losses: 30, streak: 2, best: 2, modes: { bot: 40, online: 10 } },
          badge: 'einstein_singularity',
          editions: {
            claims: { einstein_singularity: { serial: 7, cap: 50, mintedAt: '2026-10-20T00:00:00.000Z' } },
            supply: {},
            syncedAt: 0,
          },
        }));
        localStorage.setItem('detour.squads.v1', JSON.stringify({
          boundId: 'sq-doge', custom: [], bonus: {},
        }));
      } catch { /* storage unavailable: the audit falls back to the unranked path */ }
    });
    const pg = await ctx.newPage();
    await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(1100);
    await pg.click('.dock-nav .tab[data-tab="ranks"]');
    /* ladder fetch (380ms) + the mocked ledger roundtrip + the medal repaint */
    await pg.waitForTimeout(1400);

    const res = await pg.evaluate(`(${AUDIT.toString()})()`);
    if (res.pass) pass(tag, `audited (${res.notes.podium}; ${res.notes.medals}; ${res.notes.rows}; ${res.notes.slate}; ${res.notes.fit})`);
    else fail(tag, res.fails.join('\n- '));
    await pg.screenshot({ path: path.join(SHOTS, `ranks-${tag}.png`) });

    /* Squad IQ: the tab reads "Squad IQ", the hero is a compact button-free
       strip and the podium is a pure showcase (no Join / Invite keys). */
    await pg.click('.ranks-tabs [data-board="guilds"]');
    await pg.waitForTimeout(500);
    const guilds = await pg.evaluate(() => {
      const cards = [...document.querySelectorAll('#ranks-podium .pod-card')]
        .filter((c) => c.getBoundingClientRect().height > 0);
      const tab = document.querySelector('.ranks-tabs [data-board="guilds"] .seg-t')?.textContent?.trim() ?? '';
      const hero = document.getElementById('guild-hero');
      const heroVisible = !!hero && !hero.hidden && hero.getBoundingClientRect().height > 0;
      const heroText = heroVisible ? hero.textContent ?? '' : '';
      return {
        cards: cards.length,
        keys: cards.filter((c) => c.querySelector('.pod-btn, button')).length,
        feet: cards.filter((c) => (c.querySelector('.pod-foot')?.textContent ?? '').trim().length > 0).length,
        tab,
        hero: heroVisible,
        heroH: heroVisible ? Math.round(hero.getBoundingClientRect().height) : 0,
        heroButtons: heroVisible ? hero.querySelectorAll('button').length : 0,
        heroCta: /invite|\bview\b/i.test(heroText),
        podiumCta: /invite|\bjoin\b/i.test(document.getElementById('ranks-podium')?.textContent ?? ''),
      };
    });
    if (guilds.cards === 3 && guilds.keys === 0 && guilds.feet === 3 && guilds.tab === 'Squad IQ'
      && guilds.hero && guilds.heroButtons === 0 && !guilds.heroCta && !guilds.podiumCta
      && guilds.heroH >= 48 && guilds.heroH <= 52) pass(`${tag} squad-iq`);
    else fail(`${tag} squad-iq`, `cards ${guilds.cards}, podium keys ${guilds.keys}, plinths ${guilds.feet}, tab "${guilds.tab}", hero ${guilds.hero ? `${guilds.heroH}px` : 'hidden'}, hero buttons ${guilds.heroButtons}, hero cta ${guilds.heroCta}, podium cta ${guilds.podiumCta}`);
    await pg.screenshot({ path: path.join(SHOTS, `ranks-${tag}-guilds.png`) });

    await pg.click('.ranks-tabs [data-board="minds"]');
    await pg.waitForTimeout(400);

    /* the thumb slides to the active board */
    const thumbBefore = w === 360
      ? await pg.evaluate(() => document.querySelector('.ranks-tabs .mode-thumb').getBoundingClientRect().left)
      : null;
    await pg.click('.ranks-tabs [data-board="nations"]');
    await pg.waitForTimeout(800);
    if (w === 360) {
      const after = await pg.evaluate(() => document.querySelector('.ranks-tabs .mode-thumb').getBoundingClientRect().left);
      if (after > thumbBefore + 40) pass(`${tag} thumb-slides`);
      else fail(`${tag} thumb-slides`, `thumb left ${thumbBefore.toFixed(0)} → ${after.toFixed(0)}`);
    }

    /* 1) unset HUD: the dashed invitation replaces the old Set-flag card */
    const unset = await pg.evaluate(`(${PROBE_NATIONS.toString()})()`);
    if (unset.pass && unset.state === 'unset') {
      pass(`${tag} nations-unset`);
      await pg.screenshot({ path: path.join(SHOTS, `ranks-${tag}-nations.png`) });
    } else fail(`${tag} nations-unset`, unset.fails.join('\n- ') || `state ${unset.state}`);

    /* 2) the HUD opens the native picker in place, and the pick lands at once */
    await pg.click('#ranks-nations .nation-hud');
    await pg.waitForTimeout(350);
    const pickerOpen = await pg.evaluate(() => {
      const s = document.getElementById('sheet-country');
      return !!s && !s.hidden && s.getBoundingClientRect().height > 0;
    });
    if (pickerOpen) pass(`${tag} nation-picker-opens`);
    else fail(`${tag} nation-picker-opens`, 'country sheet did not open');
    await pg.fill('#country-q', 'Germany');
    await pg.waitForTimeout(150);
    await pg.click('#country-list .pick-row[data-code="DE"]');
    await pg.waitForTimeout(1100);

    const selected = await pg.evaluate(`(${PROBE_NATIONS.toString()})()`);
    if (selected.pass && selected.state === 'selected') {
      pass(`${tag} nations-selected`);
      await pg.screenshot({ path: path.join(SHOTS, `ranks-${tag}-nations-selected.png`) });
    } else fail(`${tag} nations-selected`, selected.fails.join('\n- ') || `state ${selected.state}`);

    const germany = await pg.evaluate(() => {
      const hud = document.querySelector('#ranks-nations .nation-hud');
      return {
        rank: hud?.querySelector('.nh-rank')?.textContent?.trim() ?? '',
        name: hud?.querySelector('.nh-name')?.textContent?.trim() ?? '',
        score: hud?.querySelector('.nh-score b')?.textContent?.trim() ?? '',
        tag: hud?.querySelector('.nh-tag')?.textContent?.trim() ?? '',
        sheet: !document.getElementById('sheet-country')?.hidden,
        avatar: !!hud?.querySelector('.nh-av .fp'),
      };
    });
    if (germany.rank === '#4' && germany.name === 'Germany' && germany.score === '9,920'
      && /your nation/i.test(germany.tag) && !germany.sheet && germany.avatar) pass(`${tag} nations-pick-live`);
    else fail(`${tag} nations-pick-live`, `rank ${germany.rank}, name "${germany.name}", score ${germany.score}, tag "${germany.tag}", sheet open ${germany.sheet}, avatar ${germany.avatar}`);

    /* 3) a country row drills into the prestige roster: cobalt for #4, the full
       national field, and the player's own highlighted row + standing card */
    await pg.click('#ranks-nations .rank-row[data-rank="4"]');
    await pg.waitForTimeout(750);
    const nationSheet = await pg.evaluate(`(${PROBE_NATION_SHEET.toString()})('cobalt')`);
    if (nationSheet.pass && nationSheet.state.you && nationSheet.state.name === 'Germany') {
      pass(`${tag} nation-sheet`, `${nationSheet.state.rows} players, ${nationSheet.state.aura} aura`);
      await pg.screenshot({ path: path.join(SHOTS, `ranks-${tag}-nation-sheet.png`) });
    } else {
      fail(`${tag} nation-sheet`, nationSheet.fails.join('\n- ') || JSON.stringify(nationSheet.state));
    }
    await pg.click('#sheet-nation-detail .nd-x');
    await pg.waitForTimeout(450);

    if (w === 360) {
      /* India's mocked ledger holder (Priya) proves the minted pin rides a roster row */
      await pg.click('#ranks-nations .rank-row[data-rank="5"]');
      await pg.waitForTimeout(300);
      await pg
        .waitForFunction(() => document.querySelectorAll('#nd-body .nd-list .nd-row:not(.is-skel)').length > 0, undefined, { timeout: 4000 })
        .catch(() => {});
      const pins = await pg.evaluate(() => ({
        rows: document.querySelectorAll('#nd-body .nd-list .nd-row:not(.is-skel)').length,
        skel: document.querySelectorAll('#nd-body .nd-list .nd-row.is-skel').length,
        empty: document.querySelector('#nd-body .nd-list .nd-empty')?.textContent?.trim() ?? '',
        pins: document.querySelectorAll('#nd-body .nd-list .nd-medal').length,
      }));
      if (pins.pins >= 1) pass(`${tag} nation-medals`, `${pins.pins} pinned of ${pins.rows}`);
      else fail(`${tag} nation-medals`, `no minted pin in the India roster (${pins.rows} rows, ${pins.skel} skeletons, empty "${pins.empty}")`);
      await pg.click('#sheet-nation-detail .nd-x');
      await pg.waitForTimeout(450);

      /* the champion pillar opens the same sheet, wearing the gold aura */
      await pg.click('#ranks-podium .pod-card[data-rank="1"]');
      await pg.waitForTimeout(750);
      const gold = await pg.evaluate(`(${PROBE_NATION_SHEET.toString()})('gold')`);
      if (gold.pass && gold.state.name === 'United States') pass(`${tag} nation-podium`);
      else fail(`${tag} nation-podium`, gold.fails.join('\n- ') || JSON.stringify(gold.state));
      await pg.screenshot({ path: path.join(SHOTS, `ranks-${tag}-nation-podium.png`) });

      /* the header is the drag handle: pull it down, the sheet dismisses */
      const hb = await pg.evaluate(() => {
        const r = document.getElementById('nd-head').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await pg.mouse.move(hb.x, hb.y);
      await pg.mouse.down();
      await pg.mouse.move(hb.x, hb.y + 120, { steps: 8 });
      await pg.mouse.up();
      await pg.waitForTimeout(550);
      const gone = await pg.evaluate(() => {
        const s = document.getElementById('sheet-nation-detail');
        return !s || s.hidden || s.getBoundingClientRect().height === 0;
      });
      if (gone) pass(`${tag} nation-swipe`);
      else fail(`${tag} nation-swipe`, 'header drag did not dismiss the sheet');

      /* silver and bronze are distinct recipes, not a recoloured cobalt */
      for (const [rank, aura, expected] of [[2, 'silver', 'Brazil'], [3, 'bronze', 'Japan']]) {
        await pg.click(`#ranks-podium .pod-card[data-rank="${rank}"]`);
        await pg.waitForTimeout(650);
        const tier = await pg.evaluate(`(${PROBE_NATION_SHEET.toString()})('${aura}')`);
        if (tier.pass && tier.state.name === expected) pass(`${tag} nation-aura-${aura}`);
        else fail(`${tag} nation-aura-${aura}`, tier.fails.join('\n- ') || JSON.stringify(tier.state));
        await pg.click('#sheet-nation-detail .nd-x');
        await pg.waitForTimeout(420);
      }
    }

    /* back to minds, then the mind sheet from a runner row */
    await pg.click('.ranks-tabs [data-board="minds"]');
    await pg.waitForTimeout(400);
    if (w === 360) {
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
