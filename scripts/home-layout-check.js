/**
 * home-layout-check.js — DOM check for the Home screen + Choose mode sheet.
 * Paste into the browser console on any viewport, or run via
 * scripts/verify-home-layout.mjs which drives it with Playwright.
 *
 * Fails when:
 *  - document scrollHeight > innerHeight (page scrolls),
 *  - #s-home scrollHeight > clientHeight (column overflows),
 *  - any element's bottom edge goes past the tab bar's top edge,
 *  - any .car-card / .id-card / .btn-hero / .play-summary / .change-pill clips,
 *  - any leaf text overflows its box without ellipsis truncation,
 *  - "Solo" or "Party" appears in Home or Choose-mode text,
 *  - Play / summary / Change pill missing or malformed,
 *  - mode cards missing, short (<96px), or Online not disabled with Soon,
 *  - key targets <44px.
 *
 * Returns { pass, fails[] }.
 */
function checkHomeLayout() {
  const fails = [];
  const tabs = document.getElementById('tabs');
  if (!tabs) fails.push('missing #tabs');
  const tabTop = tabs ? tabs.getBoundingClientRect().top : Number.POSITIVE_INFINITY;

  if (document.documentElement.scrollHeight > window.innerHeight + 1) {
    fails.push(
      `doc scrollHeight ${document.documentElement.scrollHeight} > innerHeight ${window.innerHeight}`,
    );
  }
  const home = document.getElementById('s-home');
  if (home && home.scrollHeight > home.clientHeight + 2) {
    fails.push(`#s-home scrollHeight ${home.scrollHeight} > clientHeight ${home.clientHeight}`);
  }

  if (home && tabs) {
    for (const el of home.querySelectorAll('*')) {
      if (el.closest('#tabs')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom > tabTop + 1) {
        const cls = (el.className && el.className.toString ? el.className.toString() : '').slice(0, 60);
        fails.push(
          `behind tab bar: <${el.tagName.toLowerCase()} class="${cls}"> bottom ${Math.round(r.bottom)} > tabTop ${Math.round(tabTop)}`,
        );
        break;
      }
    }
  }

  for (const el of document.querySelectorAll(
    '#s-home .car-card, #s-home .id-card, #s-home .launcher, #s-home .btn-hero, #s-home .play-summary, #s-home .change-pill',
  )) {
    const band = getComputedStyle(el, '::after');
    const over = band.position === 'absolute' ? Math.max(0, -(parseFloat(band.bottom) || 0)) : 0;
    if (el.scrollHeight > el.clientHeight + 3 + over) {
      fails.push(
        `clipped vertically: .${el.className.toString().split(' ')[0]} scrollH ${el.scrollHeight} > clientH ${el.clientHeight}`,
      );
    }
    if (el.scrollWidth > el.clientWidth + 3 + (band.position === 'absolute' ? Math.max(0, -(parseFloat(band.right) || 0)) : 0)) {
      fails.push(
        `clipped horizontally: .${el.className.toString().split(' ')[0]} scrollW ${el.scrollWidth} > clientW ${el.clientWidth}`,
      );
    }
  }

  for (const el of document.querySelectorAll('#s-home *')) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.scrollWidth <= el.clientWidth + 2) continue;
    if (el.classList.contains('carousel')) continue;
    const cs = getComputedStyle(el);
    if (cs.textOverflow === 'ellipsis') continue;
    if (el.children.length === 0 && (el.textContent || '').trim().length > 0) {
      fails.push(
        `text clipped without ellipsis: <${el.tagName.toLowerCase()} class="${el.className}"> "${el.textContent.trim().slice(0, 32)}"`,
      );
    }
  }

  // ---- new Play block ----
  const play = document.getElementById('home-play');
  const sub = document.getElementById('home-play-sub');
  const change = document.getElementById('mode-change');
  if (!play) fails.push('missing #home-play');
  if (!sub) fails.push('missing #home-play-sub');
  if (!change) fails.push('missing #mode-change');
  if (sub) {
    const t = (sub.textContent || '').trim();
    if (!/^((1v1|2v2|3v3|2v1) · (Easy|Normal|Hard)|Custom \d+v\d+ · (Easy|Normal|Hard))$/.test(t)) {
      fails.push(`bad summary "${t}" — want "2v2 · Normal" style`);
    }
  }
  if (play) {
    const bg = getComputedStyle(play).backgroundImage || '';
    if (/255,\s*82,\s*43|ff522b|ff5a36/i.test(bg)) {
      fails.push('Play still uses the orange gradient — want the single brand gradient');
    }
  }

  // ---- banned words in visible mode UI ----
  const banned = /\b(Solo|Party)\b/;
  for (const sel of ['#s-home', '#sheet-mode']) {
    const root = document.querySelector(sel);
    if (!root) continue;
    // Skip hidden sheet unless it was opened at least once (canvases need layout).
    if (sel === '#sheet-mode' && root.hidden) continue;
    const text = root.innerText || root.textContent || '';
    const m = text.match(banned);
    if (m) fails.push(`banned word "${m[0]}" in ${sel} — mode names are only 1v1/2v2/3v3/2v1/Custom/Online`);
  }

  // ---- Choose mode sheet structure (checked when present in DOM, even hidden) ----
  const sheet = document.getElementById('sheet-mode');
  if (!sheet) {
    fails.push('missing #sheet-mode');
  } else {
    const cards = [...sheet.querySelectorAll('.mode-card[data-mode]')];
    const want = ['1v1', '2v2', '3v3', '2v1'];
    for (const w of want) {
      if (!cards.some((c) => c.dataset.mode === w)) fails.push(`missing preset card ${w}`);
    }
    for (const c of cards) {
      const h = c.getBoundingClientRect().height;
      // Hidden sheet has 0 height — only enforce when visible.
      if (!sheet.hidden && h > 0 && h < 95) {
        fails.push(`mode card ${c.dataset.mode} height ${Math.round(h)} < 96px`);
      }
      const pv = c.querySelector('canvas.mode-pv');
      if (!pv) fails.push(`preset ${c.dataset.mode} missing canvas.mode-pv (must use the real renderer)`);
      const desc = (c.querySelector('.mode-desc')?.textContent || '').trim();
      if (!desc) fails.push(`preset ${c.dataset.mode} missing one-line description`);
    }
    const custom = document.getElementById('mode-custom');
    if (!custom) fails.push('missing #mode-custom');
    const online = sheet.querySelector('.mode-card.off, .mode-card[disabled]');
    if (!online) fails.push('missing disabled Online card');
    else {
      const badge = online.querySelector('.badge.soon, .badge');
      const bt = (badge?.textContent || '').trim().toLowerCase();
      if (!/soon/.test(bt)) fails.push('Online card missing "Soon" badge');
      if (!(online.disabled || online.getAttribute('aria-disabled') === 'true')) {
        fails.push('Online card must be disabled');
      }
    }
    const seg = [...sheet.querySelectorAll('.seg-b[data-mdiff]')];
    if (seg.length !== 3) fails.push(`Bot level seg wants 3 buttons, found ${seg.length}`);
    const hint = document.getElementById('mode-hint');
    if (!hint) fails.push('missing #mode-hint');
    const start = document.getElementById('mode-start');
    if (!start) fails.push('missing #mode-start');
    else if (!/^Start (1v1|2v2|3v3|2v1) · (Easy|Normal|Hard)$/.test((start.textContent || '').trim())) {
      fails.push(`bad sheet Start label "${(start.textContent || '').trim()}"`);
    }
    const title = document.getElementById('mode-title');
    if (!title || (title.textContent || '').trim() !== 'Choose mode') {
      fails.push('sheet title must be "Choose mode"');
    }
  }

  // ---- targets >= 44px (visible Home only; sheet checked when open) ----
  const target = (el, name) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    if (r.height < 43.5) fails.push(`target <44px: ${name} height ${Math.round(r.height)}`);
  };
  target(play, '#home-play');
  target(change, '#mode-change');
  if (sheet && !sheet.hidden) {
    for (const c of sheet.querySelectorAll('.mode-card')) target(c, `.mode-card ${c.dataset.mode || 'ghost'}`);
    for (const b of sheet.querySelectorAll('.seg-b')) target(b, `.seg-b ${b.textContent.trim()}`);
    target(document.getElementById('mode-start'), '#mode-start');
  }

  return { pass: fails.length === 0, fails };
}

// Browser-console usage
if (typeof window !== 'undefined' && new URLSearchParams(location.search).has('assert')) {
  const r = checkHomeLayout();
  if (!r.pass) throw new Error(`home layout:\n- ${r.fails.join('\n- ')}`);
}
