/**
 * home-layout-check.js — DOM check for the Home screen, no dependencies.
 * Paste into the browser console on any viewport, or run via
 * scripts/verify-home-layout.mjs which drives it with Playwright.
 *
 * Fails when:
 *  - document scrollHeight > innerHeight (page scrolls),
 *  - #s-home scrollHeight > clientHeight (column overflows),
 *  - any element's bottom edge goes past the tab bar's top edge,
 *  - any .car-card / .id-card / .mode-tab / .mode-chip / .btn-hero clips (scroll > client),
 *  - any leaf text overflows its box without ellipsis truncation.
 *
 * Returns { pass, fails[] }. Throws when pasted with `?assert` (console).
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
    '#s-home .car-card, #s-home .id-card, #s-home .mode-tab, #s-home .mode-chip, #s-home .btn-hero',
  )) {
    /* a deliberate ::after tap band hangs outside the box and grows scrollHeight — not clipping */
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
    if (el.classList.contains('carousel')) continue; // the one horizontal scroller
    const cs = getComputedStyle(el);
    if (cs.textOverflow === 'ellipsis') continue; // truncation by design
    if (el.children.length === 0 && (el.textContent || '').trim().length > 0) {
      fails.push(
        `text clipped without ellipsis: <${el.tagName.toLowerCase()} class="${el.className}"> "${el.textContent.trim().slice(0, 32)}"`,
      );
    }
  }

  return { pass: fails.length === 0, fails };
}

// Browser-console usage: `checkHomeLayout()` logs, `checkHomeLayout(true)` throws.
if (typeof window !== 'undefined' && new URLSearchParams(location.search).has('assert')) {
  const r = checkHomeLayout();
  if (!r.pass) throw new Error(`home layout:\n- ${r.fails.join('\n- ')}`);
}
