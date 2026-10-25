/**
 * verify-vs-clash.mjs — the pre-match face-off's own audit.
 *
 *   npm run build
 *   npm test                    (or: node --experimental-strip-types scripts/verify-vs-clash.mjs)
 *
 * Two halves, because the feature keeps two very different contracts:
 *
 *   1. THE LEDGER (pure Node, no browser). The war cry must exist in every language the shell
 *      ships, in the right direction; a rival persona must be deterministic, international and
 *      inside its TIQ band; and the nationality cascade must prefer a saved pick over a locale
 *      region, and a region over a clock. `src/vsdata.ts` holds all of that precisely so it can be
 *      read here with no DOM.
 *   2. THE STAGE (real Chrome). The clash must mount for a person, carry a flag, a squad, a rating
 *      and a stakes pill for both fighters, spill no pixel sideways at 320px, hand the board over
 *      when it is done, answer a tap after 600ms, stay out of the way before it, and read as a
 *      high-contrast stage in BOTH finishes. Then the contract every other suite in this repo
 *      depends on: with `navigator.webdriver` untouched, Play must reach the board in under 50ms
 *      with no overlay node in the document at all.
 *
 * To see the stage at all, the human contexts here deliberately lie about `navigator.webdriver` and
 * seed a save that has finished the lesson — the one race the clash stands down for.
 * Screenshots land in .shots/vs-clash/.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, '.shots', 'vs-clash');
fs.mkdirSync(OUT, { recursive: true });

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core not found. Run with NODE_PATH pointing at an install of it.');
  process.exit(2);
}
const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/* ---------------------------------------------------------------- part 1: the ledger */

const D = await import(pathToFileURL(path.join(ROOT, 'src', 'vsdata.ts')).href);
const REGISTRY = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'countries.json'), 'utf8'))
  .map((c) => String(c.code).toUpperCase()));

const personaOk = (p) => typeof p.squad === 'string' && p.squad.trim().length > 2
  && typeof p.name === 'string' && p.name.trim().length > 2;

const COPY_KEYS = ['lines', 'loneSquad', 'noNation', 'youLabel', 'rivalLabel', 'modeRanked',
  'modeBot', 'modeRoom', 'mindGap', 'skip', 'versus', 'dir'];
const RTL = new Set(['fa', 'ar']);

for (const langCode of ['en', 'fa', 'ru', 'ar', 'es']) {
  const c = D.CLASH_COPY[langCode];
  assert.ok(c, `no clash copy for ${langCode}`);
  for (const key of COPY_KEYS) assert.ok(key in c, `${langCode} clash copy is missing "${key}"`);
  assert.equal(c.lines.length, 3, `${langCode} must carry three war-cry lines`);
  c.lines.forEach((line, i) => assert.ok(line.trim().length > 8, `${langCode} line ${i} is empty`));
  assert.equal(c.dir, RTL.has(langCode) ? 'rtl' : 'ltr', `${langCode} reads ${c.dir}`);
  for (const word of [c.loneSquad, c.modeRanked, c.modeBot, c.modeRoom, c.skip, c.versus]) {
    assert.ok(word.trim().length > 1, `${langCode} has a blank badge word`);
  }
}

/* the three lines the brief dictates, verbatim where it dictated them */
assert.ok(D.CLASH_COPY.en.lines.includes('FIGHT FOR YOUR FLAG & SQUAD — NO SECOND CHANCES'));
assert.ok(D.CLASH_COPY.fa.lines.some((l) => l.includes('به افتخار پرچم و اسکوادت بجنگ')));
assert.ok(D.CLASH_COPY.ar.lines.some((l) => l.includes('قاتل من أجل علمك وفريقك')));

assert.equal(D.clashCopy('pt-BR'), D.CLASH_COPY.en, 'an unknown tongue must fall back to English');
assert.equal(D.clashCopy('fa-IR'), D.CLASH_COPY.fa, 'a regional subtag must still land on Persian');
assert.equal(D.clashCopy(''), D.CLASH_COPY.en, 'an empty code must still land somewhere');

/* every banner the rivals wear is a real row in the registry the picker already ships */
assert.ok(D.RIVAL_NATIONS.length >= 40, `only ${D.RIVAL_NATIONS.length} rival nations — a ladder needs range`);
for (const code of D.RIVAL_NATIONS) {
  assert.match(code, /^[A-Z]{2}$/, `${code} is not an alpha-2 code`);
  assert.ok(REGISTRY.has(code), `${code} is not in the shipped country registry`);
}
assert.equal(new Set(D.RIVAL_NATIONS).size, D.RIVAL_NATIONS.length, 'the rival roster repeats a nation');
for (const tier of ['easy', 'normal', 'hard']) {
  assert.equal(D.BOT_SQUADS[tier].length, 3, `${tier} needs three elite squads`);
}

/* a persona is a promise, not a dice roll: the same seat, the same rival, every time */
const first = D.botPersona('bot:1|777', 'hard', 0);
assert.deepEqual(D.botPersona('bot:1|777', 'hard', 0), first, 'botPersona is not deterministic');
assert.notDeepEqual(D.botPersona('bot:2|777', 'hard', 1), first, 'two machine seats share one identity');
assert.ok(REGISTRY.has(first.country), `a bot wears ${first.country}, which is not a nation`);
assert.ok(/^[A-Z][a-z]/.test(first.name), `bad bot callsign ${first.name}`);
assert.ok(personaOk(first), 'a bot squad came back blank');

const BANDS = { easy: [400, 1000], normal: [1000, 2000], hard: [2100, 3500] };
for (const tier of ['easy', 'normal', 'hard']) {
  const [lo, hi] = BANDS[tier];
  for (let i = 0; i < 40; i++) {
    const p = D.botPersona(`seed-${i}|${tier}`, tier, i % 4);
    assert.ok(p.tiq >= lo && p.tiq <= hi, `${tier} bot ran out of its band with TIQ ${p.tiq}`);
    assert.ok(D.BOT_SQUADS[tier].includes(p.squad), `${tier} bot leads ${p.squad}, not a ${tier} squad`);
  }
}
/* hard is harder than easy, and the roster is genuinely international */
const avg = (tier) => Math.round(Array.from({ length: 60 }, (_, i) => D.botPersona(`h${i}`, tier, i).tiq)
  .reduce((a, b) => a + b, 0) / 60);
assert.ok(avg('hard') > avg('easy') * 2, `hard averages ${avg('hard')} against easy ${avg('easy')}`);
const nations = new Set(Array.from({ length: 60 }, (_, i) => D.botPersona(`n${i}`, 'normal', i).country));
assert.ok(nations.size >= 12, `60 bots wore only ${nations.size} nations`);
const squads = new Set(Array.from({ length: 60 }, (_, i) => D.botPersona(`q${i}`, 'hard', i).squad));
assert.ok(squads.size >= 3, `hard bots only led ${squads.size} squads`);

/* the nationality cascade, in trust order */
assert.equal(D.resolveNation('de', ['en-US'], 'Asia/Tehran'), 'DE', 'a saved pick must beat everything');
assert.equal(D.resolveNation(null, ['en-GB', 'fa'], 'Asia/Tehran'), 'GB', 'a locale region must beat the clock');
assert.equal(D.resolveNation(null, ['en', 'fa'], 'Asia/Tehran'), 'IR', 'the device clock must beat a bare tongue');
assert.equal(D.resolveNation(null, ['fa'], 'Europe/Berlin'), 'DE', 'a clock answers for the device it keeps');
assert.equal(D.resolveNation(null, ['fa'], 'Unknown/Nowhere'), 'IR', 'with no clock a Persian tongue decides');
assert.equal(D.resolveNation(null, ['ar'], null), 'SA', 'Arabic must land in the Arab world');
assert.equal(D.resolveNation(null, ['zz'], null), '', 'nothing may be invented out of an unknown tongue');
assert.equal(D.resolveNation('IRN', ['en'], null), 'US', 'a three-letter code is refused, so the tongue answers');
assert.equal(D.guessNation('fa'), 'IR');
assert.equal(D.squadTag('Obsidian Cortex'), 'OC');
assert.equal(D.squadTag('Kestrel'), 'KE');
assert.equal(D.squadTag('@DogeSquad'), 'DO');

console.log(`  ledger: copy x5, ${D.RIVAL_NATIONS.length} nations, personas deterministic, cascade ordered`);

/* ---------------------------------------------------------------- part 2: the stage */

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.json': 'application/json' };
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
const BASE = `http://127.0.0.1:${srv.address().port}/`;

/**
 * The lie that makes the cinematic visible: webdriver off before any module reads it, a save that
 * has finished the lesson, and a chosen language and finish so the RTL and pearl passes test what
 * they claim to.
 */
const seed = ({ lang, appearance }) => `(() => {
  try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }); } catch (e) {}
  try {
    localStorage.setItem('detour.lang.v1', ${JSON.stringify(lang)});
    localStorage.setItem('detour.save.v2', JSON.stringify({ v: 2, tutorialCompleted: true, displayName: 'Zak', country: 'IR' }));
    localStorage.setItem('detour.settings.v1', JSON.stringify({ sound: true, haptics: true, reducedMotion: false, appearance: ${JSON.stringify(appearance)} }));
    localStorage.setItem('detour.menu.v1', JSON.stringify({ mode: 'bot', tab: 'solo', difficulty: 'hard', sizes: [1, 1] }));
    localStorage.setItem('detour.squads.v1', JSON.stringify({ boundId: null, custom: [], bonus: {} }));
  } catch (e) {}
})()`;

const PROBE = `(() => {
  const h = document.getElementById('vs-clash');
  if (!h) return { missing: true };
  const text = (n) => (n && typeof n.textContent === 'string' ? n.textContent.trim() : null);
  const txt = (sel) => text(h.querySelector(sel));
  const side = (sel) => {
    const card = h.querySelector(sel);
    if (!card) return null;
    const flag = card.querySelector('.vsc-flag');
    const img = flag ? flag.querySelector('img.fp-img') : null;
    const b = card.getBoundingClientRect();
    return {
      tier: card.dataset.tier,
      role: text(card.querySelector('.vsc-role')),
      name: text(card.querySelector('.vsc-name')),
      cc: text(card.querySelector('.vsc-cc')),
      country: text(card.querySelector('.vsc-country')),
      photo: !!img, chip: text(flag ? flag.querySelector('.fp-chip') : null),
      squad: text(card.querySelector('.vsc-squad-t')),
      kind: card.querySelector('.vsc-squad') ? card.querySelector('.vsc-squad').dataset.kind : null,
      crest: text(card.querySelector('.vsc-crest-t')),
      shield: !!card.querySelector('.vsc-squad .vsc-crest svg'),
      tiq: text(card.querySelector('.vsc-tiq')),
      rankTier: text(card.querySelector('.vsc-tier')),
      box: { w: +b.width.toFixed(1), h: +b.height.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1) },
    };
  };
  const hb = h.getBoundingClientRect();
  const sb = h.querySelector('.vsc-shake').getBoundingClientRect();
  const center = document.elementFromPoint(hb.left + hb.width / 2, hb.top + hb.height / 2);
  return {
    aria: h.getAttribute('role'), modal: h.getAttribute('aria-modal'), label: h.getAttribute('aria-label'),
    host: document.body === h.parentElement ? 'body' : (h.parentElement.id || h.parentElement.className),
    you: side('.vsc-side--you'), rival: side('.vsc-side--rival'),
    vs: txt('.vsc-vs'), stakes: txt('.vsc-stakes'),
    line: txt('.vsc-line'), lineDir: h.querySelector('.vsc-line').dir, lineLang: h.querySelector('.vsc-line').lang,
    skip: txt('.vsc-skip'),
    clash: h.classList.contains('is-clash'), in: h.classList.contains('is-in'),
    pe: getComputedStyle(h).pointerEvents, z: +getComputedStyle(h).zIndex, pos: getComputedStyle(h).position,
    veil: getComputedStyle(h).backgroundImage,
    plate: getComputedStyle(h.querySelector('.vsc-side--you')).backgroundImage,
    ink: getComputedStyle(h.querySelector('.vsc-name')).color,
    crestOnSeam: (() => {
      /* layout boxes, not client rects: the slam and the land are mid-flight when this reads */
      const core = h.querySelector('.vsc-core');
      const r = h.querySelector('.vsc-side--rival');
      const y = h.querySelector('.vsc-side--you');
      const rivalBottom = r.offsetTop + r.offsetHeight;
      const youTop = y.offsetTop;
      return core.offsetTop >= rivalBottom - 1 && core.offsetTop + core.offsetHeight <= youTop + 1;
    })(),
    centerHit: center ? (center.id || center.className || center.tagName) : null,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    spill: sb.left < hb.left - 0.5 || sb.right > hb.right + 0.5,
    fits: sb.top >= hb.top - 0.5 && sb.bottom <= hb.bottom + 0.5,
  };
})()`;

/** `rgba(7, 11, 20, .93)` → perceived luminance, so "high contrast" is a number and not a hope. */
const firstRGB = (css) => {
  const m = /rgba?\(([^)]+)\)/.exec(css || '');
  if (!m) return null;
  const [r, g, b] = m[1].split(',').map((v) => parseFloat(v));
  return (r + g + b) / 3;
};

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const rows = [];

const open = async (pass) => {
  const ctx = await browser.newContext({ viewport: { width: pass.w, height: pass.h } });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  await pg.addInitScript(seed(pass));
  await pg.goto(BASE, { waitUntil: 'domcontentloaded' });
  /* lying about webdriver puts the boot veil back up, and a veil at z-index 3000 would eat every
     tap this file means for the clash — so wait for a genuinely interactive app, not just a DOM */
  await pg.waitForFunction(() => !document.getElementById('tactix-splash')
    && !document.getElementById('app').hasAttribute('inert')
    && !!document.getElementById('home-play'), null, { timeout: 25000 });
  return { ctx, pg, errors };
};

/* ---- A. the stage, in both finishes and both directions ---- */
for (const pass of [
  { tag: 'dark-en', w: 360, h: 640, lang: 'en', appearance: 'dark' },
  { tag: 'light-en', w: 390, h: 844, lang: 'en', appearance: 'light' },
  { tag: 'dark-fa', w: 320, h: 568, lang: 'fa', appearance: 'dark' },
  { tag: 'light-ar', w: 430, h: 932, lang: 'ar', appearance: 'light' },
]) {
  const { ctx, pg, errors } = await open(pass);
  const bad = [];
  await pg.click('#home-play');
  await pg.waitForFunction(() => {
    const h = document.getElementById('vs-clash');
    return !!h && h.classList.contains('is-clash');
  }, null, { timeout: 6000 }).catch(() => bad.push('the crest never reached its collision beat'));

  const m = await pg.evaluate(PROBE);
  if (m.missing) {
    bad.push('no #vs-clash node: the face-off did not mount for a human run');
  } else {
    for (const [who, f] of [['you', m.you], ['rival', m.rival]]) {
      if (!f) { bad.push(`${who} fighter is absent`); continue; }
      if (!f.name) bad.push(`${who} has no name`);
      if (!f.photo && !/^[A-Z]{2,3}$/.test(f.chip || '')) bad.push(`${who}'s flag is neither a photo nor an ISO chip`);
      if (!/^[A-Z]{2}$/.test(f.cc || '')) bad.push(`${who}'s country code is ${JSON.stringify(f.cc)}`);
      if (!f.country) bad.push(`${who} has no country name`);
      if (!f.squad) bad.push(`${who} has no squad banner`);
      if (!['bound', 'lone'].includes(f.kind)) bad.push(`${who}'s squad badge is kind ${f.kind}`);
      if (!f.tier) bad.push(`${who} has no rank band`);
      if (f.box.w < 120 || f.box.h < 52) bad.push(`${who}'s card is ${f.box.w}x${f.box.h}`);
    }
    if (m.you && m.you.kind !== 'lone') bad.push('a device with no bound squad must wear the Lone Tactician badge');
    if (m.rival) {
      if (m.rival.kind !== 'bound') bad.push('a machine rival came without an elite squad');
      if (!m.rival.shield || !/^[A-Z]{2}$/.test(m.rival.crest || '')) bad.push('the rival squad has no shield crest plate');
      if (!/^[\d,.]+$/.test(m.rival.tiq || '')) bad.push(`the machine rival shows no TIQ (${m.rival.tiq})`);
      if (!/^[A-Za-z]/.test(m.rival.name || '')) bad.push(`the machine rival is named ${m.rival.name}`);
    }
    if (m.vs !== 'VS') bad.push(`the crest reads ${JSON.stringify(m.vs)}`);
    if (!m.stakes) bad.push('no stakes pill under the crest');
    if (pass.lang === 'en' && !/DUEL|RANKED|ROOM/.test(m.stakes || '')) bad.push(`the pill reads ${JSON.stringify(m.stakes)}`);
    if (pass.lang === 'en' && !/HARD/.test(m.stakes || '')) bad.push(`the machine's level is not on the pill: ${JSON.stringify(m.stakes)}`);
    if (pass.lang === 'ar' && !/مبارزة|مصنّفة|غرفة/.test(m.stakes || '')) bad.push(`the pill did not localise: ${JSON.stringify(m.stakes)}`);
    if (!m.line) bad.push('the war-cry banner is empty');
    if (m.lineDir !== (pass.lang === 'en' ? 'ltr' : 'rtl')) bad.push(`copy runs ${m.lineDir} for ${pass.lang}`);
    if (m.lineLang !== pass.lang) bad.push(`the banner declares ${m.lineLang}, not ${pass.lang}`);
    if (pass.lang !== 'en' && !/[\u0600-\u06FF]/.test(m.line || '')) bad.push(`${pass.lang} banner is not in its own script`);
    if (!m.skip) bad.push('no tap-to-skip affordance');
    if (m.aria !== 'dialog' || m.modal !== 'true' || !m.label) bad.push('the face-off is not an announced modal dialog');
    if (m.host !== 'body') bad.push(`the stage mounted on "${m.host}", not full-bleed on the body`);
    if (m.pos !== 'fixed') bad.push(`the stage is ${m.pos}, not fixed`);
    if (m.pe !== 'auto') bad.push(`pointer-events is ${m.pe}: a tap would reach the board`);
    if (m.z < 100) bad.push(`z-index ${m.z} cannot clear the shell's sheets`);
    if (m.centerHit && !String(m.centerHit).includes('vsc')) bad.push(`the stage centre hits ${JSON.stringify(m.centerHit)}`);
    if (m.overflowX) bad.push('the page scrolls sideways');
    if (m.spill) bad.push('the stage spills out of its column');
    if (!m.fits) bad.push('the stage is taller than the viewport');
    if (!m.crestOnSeam) bad.push('the crest does not sit on the seam between the fighters');

    /* the finish has to reach the clash too: a pearl stage for a pearl board */
    const veilLum = firstRGB(m.veil);
    const inkLum = firstRGB(m.ink);
    if (veilLum === null || inkLum === null) bad.push('could not read the stage colours');
    else if (pass.appearance === 'dark' && (veilLum > 90 || inkLum < 170)) {
      bad.push(`dark stage: veil ${veilLum.toFixed(0)} / ink ${inkLum.toFixed(0)}`);
    } else if (pass.appearance === 'light' && (veilLum < 170 || inkLum > 90)) {
      bad.push(`pearl stage: veil ${veilLum.toFixed(0)} / ink ${inkLum.toFixed(0)}`);
    }
  }
  if (errors.length) bad.push(`js: ${errors[0]}`);
  rows.push({ tag: pass.tag, m, bad });
  await pg.screenshot({ path: path.join(OUT, `vs-clash-${pass.tag}.png`) });
  await ctx.close();
}

/* the two finishes must not be the same picture wearing different names */
const dark = rows.find((r) => r.tag === 'dark-en');
const pearl = rows.find((r) => r.tag === 'light-en');
for (const [a, b, note] of [[dark, pearl, 'veil and plate are identical in both finishes']]) {
  if (a.m && b.m && !a.bad.length && a.m.veil === b.m.veil && a.m.plate === b.m.plate) a.bad.push(note);
}

/* ---- B. the hand-off: the board takes over whether or not the player taps ---- */
{
  const { ctx, pg, errors } = await open({ lang: 'en', appearance: 'dark', w: 390, h: 844 });
  await pg.click('#home-play');
  /* a tap at 180ms is the tap that opened the drawer: it must not skip and must not reach the board */
  await pg.waitForTimeout(180);
  await pg.mouse.click(195, 420);
  if (!(await pg.evaluate(() => !!document.getElementById('vs-clash')))) {
    errors.push('a tap at 180ms skipped the face-off, before the 600ms window');
  }
  await pg.waitForFunction(() => !document.getElementById('vs-clash'), null, { timeout: 10000 })
    .catch(() => errors.push('the face-off never left the document'));
  const after = await pg.evaluate(() => ({
    game: !document.getElementById('s-game').hidden,
    leftover: document.querySelectorAll('.vsc').length,
    active: !!document.getElementById('chip-0') && document.getElementById('chip-0').classList.contains('active'),
  }));
  if (!after.game) errors.push('the board never came up after the face-off');
  if (after.leftover) errors.push('a finished face-off left its node behind');
  if (!after.active) errors.push('the race did not start: no seat is active');
  await pg.screenshot({ path: path.join(OUT, 'vs-clash-after.png') });
  rows.push({ tag: 'hand-off', bad: errors.slice() });
  await ctx.close();
}

/* ---- C. tap-to-skip, once the window opens ---- */
{
  const { ctx, pg, errors } = await open({ lang: 'en', appearance: 'dark', w: 390, h: 844 });
  await pg.click('#home-play');
  await pg.waitForFunction(() => !!document.getElementById('vs-clash'), null, { timeout: 6000 });
  const t0 = await pg.evaluate(() => performance.now());
  await pg.waitForTimeout(700);
  await pg.mouse.click(195, 420);
  const skipped = await pg.evaluate((start) => ({
    leaving: !document.getElementById('vs-clash')
      || document.getElementById('vs-clash').classList.contains('is-leaving'),
    game: !document.getElementById('s-game').hidden,
    ms: Math.round(performance.now() - start),
  }), t0);
  if (!skipped.leaving) errors.push(`a tap at ${skipped.ms}ms did not skip the face-off`);
  if (!skipped.game) errors.push('skipping left the player outside the board');
  if (skipped.ms > 1500) errors.push(`skipping took ${skipped.ms}ms to hand the board over`);
  rows.push({ tag: 'tap-to-skip', bad: errors.slice() });
  await ctx.close();
}

/* ---- D. reduced motion: the information, none of the cinema ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  await pg.addInitScript(seed({ lang: 'en', appearance: 'dark' }));
  await pg.goto(BASE, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => !document.getElementById('tactix-splash')
    && !document.getElementById('app').hasAttribute('inert')
    && !!document.getElementById('home-play'), null, { timeout: 25000 });
  await pg.click('#home-play');
  const quiet = await pg.evaluate(() => {
    const h = document.getElementById('vs-clash');
    if (!h) return { missing: true };
    return {
      quiet: h.classList.contains('is-quiet'),
      anim: getComputedStyle(h.querySelector('.vsc-side--you')).animationName,
      visible: getComputedStyle(h.querySelector('.vsc-name')).opacity,
    };
  });
  if (quiet.missing) errors.push('a reduced-motion run got no face-off at all — it should still be told who it faces');
  else if (!quiet.quiet || quiet.anim !== 'none' || +quiet.visible !== 1) {
    errors.push(`reduced motion left cinema on: ${JSON.stringify(quiet)}`);
  }
  await pg.waitForFunction(() => !document.getElementById('vs-clash'), null, { timeout: 10000 })
    .catch(() => errors.push('the reduced-motion face-off never lifted'));
  rows.push({ tag: 'reduced-motion', bad: errors });
  await ctx.close();
}

/* ---- E. the contract every other suite in this repo depends on ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await ctx.newPage();
  /* the same save as the human passes, minus the webdriver lie */
  await pg.addInitScript(`(() => {
    try {
      localStorage.setItem('detour.save.v2', JSON.stringify({ v: 2, tutorialCompleted: true, displayName: 'Zak', country: 'IR' }));
      localStorage.setItem('detour.menu.v1', JSON.stringify({ mode: 'bot', tab: 'solo', difficulty: 'hard', sizes: [1, 1] }));
    } catch (e) {}
  })()`);
  await pg.goto(BASE, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => !!document.getElementById('home-play'), null, { timeout: 20000 });
  const auto = await pg.evaluate(() => {
    const t0 = performance.now();
    document.getElementById('home-play').click();
    return {
      ms: +(performance.now() - t0).toFixed(2),
      webdriver: navigator.webdriver === true,
      clash: !!document.getElementById('vs-clash'),
      nodes: document.querySelectorAll('.vsc').length,
      game: !document.getElementById('s-game').hidden,
    };
  });
  const bad = [];
  if (!auto.webdriver) bad.push('this context is not webdriver, so the bypass was not tested');
  if (auto.clash || auto.nodes) bad.push('an automated run mounted the face-off');
  if (!auto.game) bad.push('an automated run did not reach the board');
  if (auto.ms > 50) bad.push(`the automated start took ${auto.ms}ms, want <50ms`);
  rows.push({ tag: 'automated', bad });
  await ctx.close();
}

await browser.close();
srv.close();

/* ---------------------------------------------------------------- report */

const pad = (s, n) => String(s).padEnd(n);
console.log('\n  stage pass           verdict');
console.log('  ' + '-'.repeat(58));
let red = 0;
for (const r of rows) {
  if (r.bad.length) red++;
  console.log(`  ${pad(r.tag, 19)} ${r.bad.length ? `FAIL: ${r.bad[0]}` : 'ok'}`);
  r.bad.slice(1).forEach((b) => console.log(`  ${pad('', 19)}      ${b}`));
}
console.log(`\n  frames: ${fs.readdirSync(OUT).length} in .shots/vs-clash`);
if (red) {
  console.log(`\nFAIL — ${red} vs-clash pass(es) red`);
  process.exit(1);
}
console.log('\nvs-clash: ledger and stage both green.');
