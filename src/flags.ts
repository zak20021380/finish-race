/**
 * flags.ts — the one automated flag resolver for the whole app.
 *
 * Zero hand-drawn flags: every nation is an image from a public CDN, keyed by
 * the ISO-3166 alpha-2 code. The cascade is deliberately resilient:
 *
 *   1. flagcdn.com/w80/{cc}.png — the high-resolution PNG the brief asks for
 *   2. circle-flags SVG          — a vector mirror on a second CDN
 *   3. the clay ISO chip, then 🌐 if even that fails
 *
 * The chip is always underneath the image, so a slow or blocked CDN costs a
 * photo, never a layout shift. Consumers get either a ready-made node
 * (`flagPhoto`) or an incremental painter (`paintFlag`) for hosts that are
 * repainted several times a second.
 */

/** Only a bare ISO alpha-2 may ever be interpolated into a URL — nothing else. */
export const iso2 = (code: string | null | undefined): string | null =>
  code && /^[A-Za-z]{2}$/.test(code) ? code.toLowerCase() : null;

/** Primary CDN: the exact pattern from the flag brief. */
export const flagPngUrl = (cc: string): string => `https://flagcdn.com/w80/${cc}.png`;
/** Vector fallback: MIT circle-flags served from jsDelivr. */
export const flagSvgUrl = (cc: string): string => `https://cdn.jsdelivr.net/npm/circle-flags/flags/${cc}.svg`;

const GLOBE = '🌐';

/** A fresh image walking the PNG → SVG → globe cascade. */
function makeImage(cc: string, wrap: HTMLElement, chip: HTMLElement, px: number): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'fp-img';
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.draggable = false;
  img.dataset.cc = cc;
  img.dataset.tier = '0';
  img.addEventListener('error', () => {
    const cur = img.dataset.cc ?? '';
    if (img.dataset.tier !== '1') {
      img.dataset.tier = '1';
      img.src = flagSvgUrl(cur);
      return;
    }
    img.remove();
    wrap.dataset.fallback = '1';
    wrap.classList.remove('is-photo');
    wrap.classList.add('is-chip', 'is-fallback');
    chip.textContent = GLOBE;
  });
  img.addEventListener('load', () => wrap.classList.add('is-photo'));
  img.src = px > 80 ? `https://flagcdn.com/w${px}/${cc}.png` : flagPngUrl(cc);
  return img;
}

/**
 * A complete flag node: `.fp` wrapper, clay ISO chip underneath, photo on top.
 * `cls` is the consumer's size/variant hook (e.g. `fp-badge`, `fp-country`);
 * `px` opts into a wider CDN source for a hero medallion (80 is the row size).
 */
export function flagPhoto(code: string | null | undefined, cls: string, px = 80): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = `fp ${cls}`.trim();
  wrap.setAttribute('aria-hidden', 'true');

  const chip = document.createElement('span');
  chip.className = 'fp-chip';
  chip.textContent = (code ?? '').slice(0, 3).toUpperCase() || '—';
  wrap.append(chip);

  const cc = iso2(code);
  if (!cc) {
    wrap.classList.add('is-chip');
    return wrap;
  }
  wrap.append(makeImage(cc, wrap, chip, px));
  return wrap;
}

/**
 * Paint a flag into a host that may be rewritten often (the matchmaking scanner
 * runs five times a second). The chip and image are built once and only their
 * `src`/text move; an unchanged code is a comparison, not a re-fetch.
 */
export function paintFlag(host: HTMLElement | null, code: string | null | undefined): void {
  if (!host) return;
  host.classList.add('fp');
  let chip = host.querySelector<HTMLElement>('.fp-chip');
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'fp-chip';
    host.append(chip);
  }
  const cc = iso2(code);
  chip.textContent = (code ?? '').slice(0, 3).toUpperCase() || '—';
  if (!cc) {
    host.querySelector('.fp-img')?.remove();
    host.dataset.cc = '';
    host.classList.remove('is-photo');
    host.classList.add('is-chip');
    return;
  }
  if (host.dataset.cc === cc && (host.querySelector('.fp-img') || host.dataset.fallback === '1')) return;

  host.dataset.cc = cc;
  delete host.dataset.fallback;
  host.classList.remove('is-photo', 'is-chip', 'is-fallback');
  chip.textContent = code!.slice(0, 2).toUpperCase();
  let img = host.querySelector<HTMLImageElement>('.fp-img');
  if (!img) {
    img = makeImage(cc, host, chip, 80);
    host.append(img);
    return;
  }
  img.dataset.cc = cc;
  img.dataset.tier = '0';
  img.src = flagPngUrl(cc);
}
