/**
 * verify-dob-lock.mjs — Playwright verification for the Date of Birth overhaul.
 *
 * No new project dependencies: `playwright-core` is resolved at runtime only
 * (see scripts/verify-settings.mjs for the NODE_PATH recipe).
 *
 * Serves ./dist over 127.0.0.1 and checks, over the real user path
 * (Profile → Age row → date sheet):
 *   1. the three dropdowns are gone: DD / MM / YYYY are dedicated numeric
 *      inputs (inputmode=numeric, pattern=[0-9]*, maxlength 2/2/4) in
 *      recessed dark-clay wells;
 *   2. non-digit keystrokes never land, two digits auto-advance DD → MM → YYYY,
 *      and Backspace on an empty well walks the focus back one step;
 *   3. bad digits are never wiped: an out-of-range well keeps its value, wears
 *      the coral .is-invalid rim, plays the 250ms clay-shake, fires one error
 *      haptic and explains itself in the inline chip — day (/month limit), month
 *      and year each with their own copy; editing the value clears all of it;
 *   4. the CTA stays disabled on muted clay until the date is 100% valid, then
 *      illuminates and carries the "Confirm Birthdate" label;
 *   5. the one-time callout is the sculpted clay badge: SVG lock with an amber
 *      gradient stroke, amber rim (rgba(245,158,11,.15)), 11px header, 12px slate
 *      subtext — no emoji, no yellow-bordered box;
 *   6. the CTA raises the "Lock this birthdate permanently?" confirm prompt,
 *      Cancel restores the CTA, Confirm writes the birthdate, pays +100 coins,
 *      plays the success haptic and raises the reward toast;
 *   7. the locked Profile row shows the age, the birthdate subtitle and the
 *      🔒 LOCKED badge, hides the reward chip + chevron and refuses to open
 *      the sheet again — across a reload too;
 *   8. zero layout overflow at 360x640 and 430x932, error chip shown or not.
 * Screenshots: .shots/dob-lock-360x640.png · .shots/dob-locked-profile-360x640.png
 * exit 1 on any failure.
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
      '  NODE_PATH="C:\\\\Users\\\\PC-Y\\\\AppData\\\\Local\\\\Temp\\\\opencode\\\\check\\\\node_modules" node scripts/verify-dob-lock.mjs',
  );
  process.exit(2);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(String(req.url).split('?')[0]);
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

/** Telegram WebApp stub installed before the bundle loads: haptics land in __tgCalls. */
const TG_STUB = `
  window.__tgCalls = [];
  const push = (...a) => window.__tgCalls.push(a);
  let stub;
  try {
    stub = window.Telegram?.WebApp || {};
  } catch { stub = {}; }
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

const BIRTH = { y: 2004, m: 2, d: 29 };      // leap day — exercises the calendar rule
const now = new Date();
let EXPECT_AGE = now.getFullYear() - BIRTH.y;
if (now.getMonth() + 1 < BIRTH.m || (now.getMonth() + 1 === BIRTH.m && now.getDate() < BIRTH.d)) EXPECT_AGE--;
const EXPECT_MAX_YEAR = now.getFullYear() - 8;   // AGE_MIN(7) + 1: every day of that year clears the floor

const srv = await serve();
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args: ['--no-sandbox'] });

let failed = 0;
const expect = (name, ok) => {
  if (ok) console.log(`PASS ${name}`);
  else { failed += 1; console.log(`FAIL ${name}`); }
};
fs.mkdirSync(SHOTS, { recursive: true });

const readSave = (pg) => pg.evaluate(() => JSON.parse(localStorage.getItem('detour.save.v2') || 'null'));

async function openProfileAge(pg) {
  await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1200);
  await pg.click('.dock-nav .tab[data-tab="profile"]');
  await pg.waitForTimeout(700);
  await pg.click('#pf-age');
  await pg.waitForTimeout(600);
}

try {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 } });
  await ctx.route('**/telegram-web-app.js**', (route) => route.fulfill({ status: 200, body: '', contentType: 'application/javascript' }));
  await ctx.route('**/telegram.org/js/telegram-web-app.js**', (route) => route.fulfill({ status: 200, body: '', contentType: 'application/javascript' }));
  await ctx.addInitScript(TG_STUB);
  const pg = await ctx.newPage();

  const state = () => pg.evaluate(() => ({
    day: document.getElementById('dob-day').value,
    month: document.getElementById('dob-month').value,
    year: document.getElementById('dob-year').value,
    active: document.activeElement?.id ?? '',
    disabled: document.getElementById('age-save').disabled,
    lit: document.getElementById('age-save').classList.contains('lit'),
    label: document.getElementById('age-save').textContent.trim(),
  }));
  const clearDob = () => pg.evaluate(() => {
    for (const el of document.querySelectorAll('#sheet-age .dob-in')) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  const probeLayout = () => pg.evaluate(() => {
    const sheet = document.getElementById('sheet-age');
    const rect = sheet.getBoundingClientRect();
    const wells = [...sheet.querySelectorAll('.dob-in')].map((el) => el.getBoundingClientRect());
    const grid = sheet.querySelector('.dob-grid').getBoundingClientRect();
    const warnEl = sheet.querySelector('.dob-warn').getBoundingClientRect();
    const errEl = document.getElementById('dob-err').getBoundingClientRect();
    const cta = document.getElementById('age-save').getBoundingClientRect();
    const inside = (r) => r.left >= -0.5 && r.right <= window.innerWidth + 0.5;
    return {
      pageW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      innerH: window.innerHeight,
      overflowY: sheet.scrollHeight - sheet.clientHeight,
      gridLeft: Math.round(grid.left),
      gridRight: Math.round(grid.right),
      minWellW: Math.round(Math.min(...wells.map((s) => s.width))),
      inside: wells.every(inside) && inside(warnEl) && inside(errEl) && inside(cta),
      ctaBottom: Math.round(cta.bottom),
    };
  });

  await openProfileAge(pg);

  /* ---- 1. the sheet's shape: three numeric wells, no select, no stepper ---- */
  const shell = await pg.evaluate(() => {
    const sheet = document.getElementById('sheet-age');
    const open = sheet.classList.contains('open') && !document.getElementById('scrim').hidden;
    const text = sheet.textContent || '';
    const fields = ['dob-day', 'dob-month', 'dob-year'].map((id) => document.getElementById(id));
    return {
      open,
      cols: sheet.querySelectorAll('.dob-col').length,
      inputs: fields.map((el) => ({
        input: el instanceof HTMLInputElement,
        mode: el?.inputMode ?? '',
        pattern: el?.getAttribute('pattern') ?? '',
        max: el?.maxLength ?? 0,
        placeholder: el?.placeholder ?? '',
      })),
      selects: sheet.querySelectorAll('select').length,
      stepper: !!sheet.querySelector('.age-stepper, #age-minus, #age-plus, #age-n'),
      clear: !!sheet.querySelector('#age-clear') || /\bClear\b/.test(text),
      oldCopy: text.includes('You can clear it any time'),
      title: sheet.querySelector('#age-title')?.textContent?.trim() ?? '',
      focused: document.activeElement?.id ?? '',
    };
  });
  expect('age sheet opens from the Profile row', shell.open);
  expect('three clay columns: Day / Month / Year', shell.cols === 3);
  expect('no dropdowns remain in the sheet', shell.selects === 0);
  expect('all three dedicated numeric inputs present',
    shell.inputs.every((f) => f.input && f.mode === 'numeric' && f.pattern === '[0-9]*'));
  expect('maxlengths are 2 / 2 / 4',
    shell.inputs[0].max === 2 && shell.inputs[1].max === 2 && shell.inputs[2].max === 4);
  expect('placeholders read DD / MM / YYYY',
    shell.inputs.map((f) => f.placeholder).join('/') === 'DD/MM/YYYY');
  expect('stepper gone', !shell.stepper);
  expect('Clear key and its copy gone', !shell.clear && !shell.oldCopy);
  expect('sheet titled "Your date of birth"', shell.title === 'Your date of birth');
  expect('the day well takes the opening focus', shell.focused === 'dob-day');

  /* ---- 2. the callout: sculpted clay, SVG lock, exact hierarchy ---- */
  const warn = await pg.evaluate(() => {
    const el = document.querySelector('#sheet-age .dob-warn');
    const r = el?.getBoundingClientRect();
    const ico = el?.querySelector('.dob-warn-ico');
    const svgG = el?.querySelector('.dob-warn-ico svg g');
    const head = el?.querySelector('.dob-warn-h');
    const para = el?.querySelector('.dob-warn-p');
    const cs = head ? getComputedStyle(head) : null;
    const ps = para ? getComputedStyle(para) : null;
    const ws = el ? getComputedStyle(el) : null;
    return {
      there: !!el,
      visible: !!el && r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight,
      emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(ico?.textContent ?? 'x'),
      hasSvg: !!el?.querySelector('.dob-warn-ico svg'),
      grad: svgG?.getAttribute('stroke') ?? '',
      head: head?.textContent?.trim() ?? '',
      desc: para?.textContent?.trim() ?? '',
      headSize: cs?.fontSize ?? '',
      headWeight: cs?.fontWeight ?? '',
      descSize: ps?.fontSize ?? '',
      descColor: ps?.color ?? '',
      rim: ws?.boxShadow.includes('rgba(245, 158, 11, 0.15)') ?? false,
      radius: ws?.borderRadius ?? '',
    };
  });
  expect('one-time callout visible in the sheet', warn.there && warn.visible);
  expect('sculpted SVG lock, zero emoji', warn.hasSvg && !warn.emoji);
  expect('lock stroke wears the amber gradient', warn.grad === 'url(#dob-lock-grad)');
  expect('header = "One-Time Entry", 11px / 600',
    warn.head === 'One-Time Entry' && warn.headSize === '11px' && warn.headWeight === '600');
  expect('subtext exact, 12px soft slate',
    warn.desc === 'This date locks permanently upon confirmation and cannot be modified.'
    && warn.descSize === '12px' && warn.descColor === 'rgb(148, 163, 184)');
  expect('amber rim highlight + soft corners', warn.rim && parseFloat(warn.radius) >= 12);

  /* ---- 3. keystroke rejection: non-digits never land ---- */
  await pg.click('#dob-day');
  await pg.keyboard.type('abc-e.');
  expect('letters and punctuation are rejected outright', (await state()).day === '');
  await pg.keyboard.type('7');
  await pg.keyboard.type('xy');
  expect('a digit lands, the following letters do not', (await state()).day === '7');

  /* ---- 3b. the wells: recessed clay, centered bold numerals, amber focus ring ---- */
  const well = await pg.evaluate(() => {
    const day = document.getElementById('dob-day');
    const cs = getComputedStyle(day);
    return {
      align: cs.textAlign,
      color: cs.color,
      weight: cs.fontWeight,
      shadow: cs.boxShadow,
      ring: cs.boxShadow.includes('rgba(245, 158, 11'),
    };
  });
  expect('wells are recessed clay with inset depth',
    well.shadow.includes('inset') && well.align === 'center' && well.weight === '800'
    && well.color === 'rgb(248, 250, 252)' && well.ring);
  await pg.evaluate(() => document.getElementById('dob-day').blur());
  const wellIdle = await pg.evaluate(() => getComputedStyle(document.getElementById('dob-day')).boxShadow);
  expect('quiet wells drop the amber ring but keep the groove', wellIdle.includes('inset') && !wellIdle.includes('245, 158, 11'));

  /* ---- 4. auto-advance DD → MM → YYYY and the CTA gate ---- */
  await clearDob();
  await pg.click('#dob-day');
  await pg.keyboard.type('2');
  expect('one day digit keeps the focus', (await state()).active === 'dob-day');
  await pg.keyboard.type('9');
  let s = await state();
  expect('two day digits advance to MM', s.active === 'dob-month' && s.day === '29');
  expect('CTA stays disabled with month + year empty', s.disabled);
  await pg.keyboard.type('0');
  await pg.keyboard.type('2');
  s = await state();
  expect('two month digits advance to YYYY', s.active === 'dob-year' && s.month === '02');
  expect('CTA stays disabled with the year empty', s.disabled);
  await pg.keyboard.type('2004');
  s = await state();
  expect('a full leap date enables the CTA (29 Feb 2004)', s.year === '2004' && !s.disabled);
  expect('CTA reads "Confirm Birthdate" and lights up', s.label === 'Confirm Birthdate' && s.lit);

  /* ---- 5. Backspace walks back from an empty well ---- */
  await clearDob();
  await pg.click('#dob-month');
  await pg.keyboard.press('Backspace');
  expect('Backspace on an empty MM focuses DD', (await state()).active === 'dob-day');
  await pg.click('#dob-month');
  await pg.keyboard.type('02');
  await pg.click('#dob-month');
  await pg.keyboard.press('Backspace');
  let bs = await state();
  expect('Backspace clears a selected month first', bs.month === '');
  await pg.keyboard.press('Backspace');
  bs = await state();
  expect('a second Backspace steps focus back to DD', bs.active === 'dob-day');

  /* ---- 6. no silent wiping: bad digits stay, flagged, explained ---- */
  const errCount = () => pg.evaluate(() => window.__tgCalls.filter(([k, t]) => k === 'notify' && t === 'error').length);
  const chip = () => pg.evaluate(() => {
    const el = document.getElementById('dob-err');
    const day = document.getElementById('dob-day');
    const cs = getComputedStyle(day);
    return {
      msg: document.getElementById('dob-err-t').textContent.trim(),
      shown: !el.hidden && el.classList.contains('on'),
      dayClass: day.classList.contains('is-invalid'),
      aria: day.getAttribute('aria-invalid'),
      anim: cs.animationName,
      ring: cs.boxShadow.includes('rgba(239, 68, 68'),
    };
  });

  await clearDob();
  const errs0 = await errCount();
  await pg.click('#dob-day');
  await pg.keyboard.type('33');
  await pg.waitForTimeout(300);       // the clay-shake and the coral transition both settle
  s = await state();
  let c = await chip();
  expect('day 33 keeps the typed digits, focus stays on the well', s.day === '33' && s.active === 'dob-day');
  expect('the well wears the coral verdict with the clay-shake',
    c.dayClass && c.aria === 'true' && c.anim === 'clay-shake' && c.ring);
  expect('chip reads "Day must be between 1 and 31"', c.shown && c.msg === 'Day must be between 1 and 31');
  expect('CTA stays disabled on an impossible day', s.disabled);
  expect('the error haptic fired exactly once', (await errCount()) === errs0 + 1);

  await pg.keyboard.press('Backspace');
  await pg.keyboard.press('Backspace');
  await pg.keyboard.type('22');
  s = await state();
  c = await chip();
  expect('editing 33 → 22 clears the flag and advances to MM', s.day === '22' && s.active === 'dob-month' && !c.dayClass);
  expect('the chip fades out with the fix', !c.shown);

  await clearDob();
  await pg.click('#dob-month');
  await pg.keyboard.type('13');
  s = await state();
  c = await chip();
  expect('month 13 is kept, flagged and explained',
    s.month === '13' && s.disabled && c.shown && c.msg === 'Month must be between 01 and 12');
  await pg.click('#dob-month', { clickCount: 3 });
  await pg.keyboard.type('4');
  await pg.keyboard.press('Tab');
  s = await state();
  expect('13 → 4 pads to 04 and clears the chip', s.month === '04' && !(await chip()).shown);
  await pg.click('#dob-month');
  await pg.keyboard.type('0');
  await pg.keyboard.press('Tab');
  s = await state();
  expect('a lone 0 pads to 00 and is flagged, never wiped',
    s.month === '00' && (await chip()).msg === 'Month must be between 01 and 12');

  await clearDob();
  await pg.click('#dob-year');
  await pg.keyboard.type('1939');
  s = await state();
  c = await chip();
  expect('year 1939 is kept, flagged and explained',
    s.year === '1939' && s.disabled && c.shown && c.msg === `Year must be between 1940 and ${EXPECT_MAX_YEAR}`);
  await pg.click('#dob-year', { clickCount: 3 });
  await pg.keyboard.type(String(EXPECT_MAX_YEAR + 1));
  s = await state();
  expect(`year ${EXPECT_MAX_YEAR + 1} is kept and flagged`,
    s.year === String(EXPECT_MAX_YEAR + 1) && (await chip()).msg === `Year must be between 1940 and ${EXPECT_MAX_YEAR}`);

  await clearDob();
  await pg.click('#dob-day');
  await pg.keyboard.type('31');
  s = await state();
  expect('day 31 is kept while the month is unknown', s.day === '31');
  await pg.keyboard.type('04');
  s = await state();
  c = await chip();
  expect('a 31 in April stays typed but flagged',
    s.day === '31' && s.month === '04' && s.disabled && c.shown && c.msg === 'April has up to 30 days');
  await pg.keyboard.type('2004');
  expect('the year alone does not clear an impossible April day', (await state()).disabled);
  await pg.click('#dob-day');
  await pg.keyboard.type('30');
  s = await state();
  expect('editing 31 → 30 clears the flag and unlocks the CTA', s.day === '30' && !s.disabled);

  await clearDob();
  await pg.click('#dob-year');
  await pg.keyboard.type('2004');
  await pg.click('#dob-month');
  await pg.keyboard.type('02');
  await pg.click('#dob-day');
  await pg.keyboard.type('29');
  s = await state();
  expect('Feb 2004 (leap) keeps day 29', s.day === '29' && s.month === '02' && s.year === '2004' && !s.disabled);
  await pg.click('#dob-year');
  await pg.keyboard.type('2003');
  s = await state();
  c = await chip();
  expect('Feb 2003 keeps the typed 29 and flags "February has up to 28 days"',
    s.day === '29' && s.disabled && c.shown && c.msg === 'February has up to 28 days');
  await pg.click('#dob-year', { clickCount: 3 });
  await pg.keyboard.type('2004');
  s = await state();
  expect('restoring the leap year clears the flag and unlocks the CTA',
    s.year === '2004' && !s.disabled && !(await chip()).shown);

  /* ---- 6b. the error state never breaks the frame, 360x640 → 430x932 ---- */
  await clearDob();
  await pg.click('#dob-day');
  await pg.keyboard.type('33');
  let lay = await probeLayout();
  expect(`error state: zero page overflow (${lay.pageW}/${lay.innerW})`, lay.pageW <= lay.innerW);
  expect(`error state: sheet fits 360x640 (top ${lay.top}, bottom ${lay.bottom}/${lay.innerH})`,
    lay.top >= 0 && lay.bottom <= lay.innerH + 1 && lay.overflowY <= 1 && lay.inside);
  await pg.setViewportSize({ width: 430, height: 932 });
  await pg.waitForTimeout(350);
  lay = await probeLayout();
  expect(`error state: zero overflow at 430x932 (page ${lay.pageW}/${lay.innerW}, sheet ${lay.bottom}/${lay.innerH})`,
    lay.pageW <= lay.innerW && lay.top >= 0 && lay.bottom <= lay.innerH + 1 && lay.overflowY <= 1 && lay.inside);
  await pg.setViewportSize({ width: 360, height: 640 });
  await pg.waitForTimeout(350);

  /* ---- 7. CTA states: muted clay when locked, warm gold when lit ---- */
  await clearDob();
  await pg.waitForTimeout(300);       // let the clay transition settle before reading computed styles
  const ctaOff = await pg.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('age-save'));
    return { color: cs.color, opacity: cs.opacity, shadow: cs.boxShadow, cursor: cs.cursor };
  });
  expect('disabled CTA wears muted clay (slate type, no gold glow, full opacity)',
    ctaOff.color === 'rgb(91, 107, 132)' && ctaOff.opacity === '1'
    && !ctaOff.shadow.includes('245, 158, 11') && ctaOff.cursor === 'default');
  await pg.click('#dob-day');
  await pg.keyboard.type('29022004');
  await pg.waitForTimeout(300);       // the warm-up animation owns the shadow; the face settles first
  const ctaOn = await pg.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('age-save'));
    return { color: cs.color, shadow: cs.boxShadow, bg: cs.backgroundImage };
  });
  s = await state();
  expect('typing straight through the row fills DD / MM / YYYY', s.day === '29' && s.month === '02' && s.year === '2004');
  expect('enabled CTA glows gold', ctaOn.color === 'rgb(16, 20, 29)'
    && ctaOn.shadow.includes('245, 158, 11') && ctaOn.bg.includes('linear-gradient'));

  /* ---- 8. layout: zero overflow at 360x640 ---- */
  const layout = await probeLayout();
  expect(`zero page overflow (${layout.pageW}/${layout.innerW})`, layout.pageW <= layout.innerW);
  expect(`sheet fits the viewport (top ${layout.top}, bottom ${layout.bottom}/${layout.innerH})`,
    layout.top >= 0 && layout.bottom <= layout.innerH + 1);
  expect(`no vertical clipping inside the sheet (${layout.overflowY}px)`, layout.overflowY <= 1);
  expect(`wells stay inside the frame (${layout.gridLeft}..${layout.gridRight}, min ${layout.minWellW}px)`,
    layout.gridLeft >= 0 && layout.gridRight <= layout.innerW && layout.minWellW >= 60);
  expect('every surface hugs the frame at 360x640', layout.inside && layout.ctaBottom <= layout.innerH);
  await pg.setViewportSize({ width: 430, height: 932 });
  await pg.waitForTimeout(350);
  const tall = await probeLayout();
  expect(`zero overflow at 430x932 (page ${tall.pageW}/${tall.innerW}, sheet ${tall.bottom}/${tall.innerH})`,
    tall.pageW <= tall.innerW && tall.top >= 0 && tall.bottom <= tall.innerH + 1 && tall.overflowY <= 1 && tall.inside);
  await pg.setViewportSize({ width: 360, height: 640 });
  await pg.waitForTimeout(350);
  await pg.screenshot({ path: path.join(SHOTS, 'dob-lock-360x640.png') });
  console.log('shot dob-lock-360x640.png');

  /* ---- 9. the confirm pulse, then the permanent lock ---- */
  const before = await readSave(pg);
  /* a fresh save lives in memory until the first flush, so null is the fresh state too */
  expect('fresh save: no dob, +100 unclaimed', before === null || (before.dob === null && before.rewards.age === false && before.coins === 1850));

  await pg.click('#age-save');
  await pg.waitForTimeout(350);
  const pulse = await pg.evaluate(() => ({
    confirmShown: !document.getElementById('dob-confirm').hidden,
    ctaHidden: document.getElementById('age-save').hidden,
    prompt: document.querySelector('#dob-confirm .dob-confirm-t')?.textContent?.trim() ?? '',
    cancel: !!document.getElementById('dob-cancel'),
    lock: !!document.getElementById('dob-lock'),
  }));
  expect('CTA raises the "Lock this birthdate permanently?" prompt', pulse.confirmShown && pulse.ctaHidden && pulse.prompt === 'Lock this birthdate permanently?');
  expect('prompt carries Cancel + Confirm keys', pulse.cancel && pulse.lock);

  await pg.click('#dob-cancel');
  await pg.waitForTimeout(250);
  const cancelled = await pg.evaluate(() => ({
    confirmHidden: document.getElementById('dob-confirm').hidden,
    ctaShown: !document.getElementById('age-save').hidden,
  }));
  expect('Cancel restores the CTA', cancelled.confirmHidden && cancelled.ctaShown);

  await pg.click('#age-save');
  await pg.waitForTimeout(250);
  await pg.click('#dob-lock');
  await pg.waitForTimeout(600);

  const after = await readSave(pg);
  const haptics = await pg.evaluate(() => window.__tgCalls);
  const closed = await pg.evaluate(() => !document.getElementById('sheet-age').classList.contains('open') && document.getElementById('scrim').hidden);
  const toast = await pg.evaluate(() => ({
    hidden: document.getElementById('pf-toast').hidden,
    text: document.getElementById('pf-toast-t').textContent.trim(),
  }));
  expect('sheet closes on confirm', closed);
  expect(`birthdate stored as ${BIRTH.y}-0${BIRTH.m}-${BIRTH.d}`, after.dob === `${BIRTH.y}-0${BIRTH.m}-${BIRTH.d}`);
  expect(`derived age = ${EXPECT_AGE}`, after.age === EXPECT_AGE);
  expect('reward claimed, +100 coins paid (1850 → 1950)', after.rewards.age === true && after.coins === 1950);
  expect('success haptic + medium impact fired',
    haptics.some(([k, t]) => k === 'notify' && t === 'success') && haptics.some(([k, s]) => k === 'impact' && s === 'medium'));
  expect('reward toast says +100 Coins · Birthdate locked', !toast.hidden && toast.text === '+100 Coins · Birthdate locked');

  /* ---- 10. the Profile row is sealed ---- */
  await pg.waitForTimeout(700);   // balance count-up settles
  const row = await pg.evaluate(() => {
    const el = document.getElementById('pf-age');
    const chev = el.querySelector('.chev');
    return {
      value: document.getElementById('pf-age-v').textContent.trim(),
      sub: document.getElementById('pf-age-s').textContent.trim(),
      lockShown: !document.getElementById('pf-age-done').hidden,
      lockText: document.getElementById('pf-age-done').textContent.trim(),
      rewardHidden: document.getElementById('pf-age-reward').hidden,
      lockedClass: el.classList.contains('locked'),
      editClass: el.classList.contains('edit'),
      aria: el.getAttribute('aria-disabled'),
      chev: chev ? getComputedStyle(chev).display : 'missing',
      coins: document.getElementById('pf-coins').textContent.trim(),
    };
  });
  expect(`row shows the verified age (${row.value})`, row.value === `${EXPECT_AGE} yrs`);
  expect('row subtitle = Born 29 Feb 2004', row.sub === 'Born 29 Feb 2004');
  expect('🔒 LOCKED clay badge shown, reward chip gone', row.lockShown && row.lockText.includes('LOCKED') && row.lockText.includes('🔒') && row.rewardHidden);
  expect('row inert: locked, no edit, chevron hidden, aria-disabled', row.lockedClass && !row.editClass && row.chev === 'none' && row.aria === 'true');
  expect(`wallet shows 1,950 coins (${row.coins})`, row.coins === '1,950');
  await pg.screenshot({ path: path.join(SHOTS, 'dob-locked-profile-360x640.png') });
  console.log('shot dob-locked-profile-360x640.png');

  const reopen = await pg.evaluate(() => { document.getElementById('pf-age').click(); });
  void reopen;
  await pg.waitForTimeout(450);
  const stayedShut = await pg.evaluate(() => !document.getElementById('sheet-age').classList.contains('open'));
  expect('locked row refuses to reopen the sheet', stayedShut);

  /* ---- 11. persistence across a reload: still locked, never editable ---- */
  await pg.reload({ waitUntil: 'networkidle' });
  await pg.waitForTimeout(1200);
  await pg.click('.dock-nav .tab[data-tab="profile"]');
  await pg.waitForTimeout(700);
  await pg.evaluate(() => document.getElementById('pf-age').click());
  await pg.waitForTimeout(450);
  const persisted = await pg.evaluate(() => {
    const el = document.getElementById('pf-age');
    const save = JSON.parse(localStorage.getItem('detour.save.v2') || 'null');
    return {
      sheetShut: !document.getElementById('sheet-age').classList.contains('open'),
      locked: el.classList.contains('locked'),
      value: document.getElementById('pf-age-v').textContent.trim(),
      dob: save?.dob, age: save?.age, coins: save?.coins,
      lockShown: !document.getElementById('pf-age-done').hidden,
    };
  });
  expect('after reload: dob + age + wallet persist', persisted.dob === `${BIRTH.y}-0${BIRTH.m}-${BIRTH.d}` && persisted.age === EXPECT_AGE && persisted.coins === 1950);
  expect('after reload: row still locked and the sheet still refuses', persisted.sheetShut && persisted.locked && persisted.lockShown && persisted.value === `${EXPECT_AGE} yrs`);

  await ctx.close();
} finally {
  await browser.close();
  srv.close();
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all dob lock checks passed');
