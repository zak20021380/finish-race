/**
 * coin.ts — the one coin graphic and the one balance readout.
 *
 * Every place that shows coins mounts `coinSvg()`: a gold radial body (#ffe9a3 → #f5b82e →
 * #b8760f), an embossed rim, an inner ring, a stamped "D", a specular highlight and a soft
 * shadow, drawn in one 24-unit viewBox so it stays crisp from 16 to 48 px. Balances go through
 * `setBalance()`, which formats with thousands separators and, unless motion is reduced, counts
 * up to the new value while a shine sweeps across the sibling coin.
 */
import { motionReduced } from './settings';

const GROUPS = new Intl.NumberFormat('en-US');

/** Thousands separators: the only formatting a coin amount ever needs. */
export const coinText = (n: number): string => GROUPS.format(Math.max(0, Math.round(n)));

let seq = 0;

/** One gold coin as inline SVG. Each call is a fresh element, so gradient ids never collide. */
export function coinSvg(): SVGSVGElement {
  const id = `coin${++seq}`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'coin');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = `
    <defs>
      <radialGradient id="${id}-body" cx="36%" cy="30%" r="80%">
        <stop offset="0" stop-color="#ffe9a3"/>
        <stop offset=".55" stop-color="#f5b82e"/>
        <stop offset="1" stop-color="#b8760f"/>
      </radialGradient>
      <linearGradient id="${id}-rim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffe9a3"/>
        <stop offset=".52" stop-color="#d99a1b"/>
        <stop offset="1" stop-color="#8a5c06"/>
      </linearGradient>
      <linearGradient id="${id}-sweep" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#fff" stop-opacity="0"/>
        <stop offset=".5" stop-color="#fff" stop-opacity=".9"/>
        <stop offset="1" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>
      <clipPath id="${id}-clip"><circle cx="12" cy="12" r="9.7"/></clipPath>
      <filter id="${id}-soft" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation=".65"/>
      </filter>
    </defs>
    <ellipse cx="12" cy="13.4" rx="9.2" ry="9.2" fill="#8a5c06" opacity=".3" filter="url(#${id}-soft)"/>
    <circle cx="12" cy="12" r="9.7" fill="url(#${id}-rim)"/>
    <circle cx="12" cy="12" r="8.6" fill="url(#${id}-body)"/>
    <circle cx="12" cy="12" r="8.6" fill="none" stroke="#8a5c06" stroke-opacity=".4" stroke-width=".7"/>
    <circle cx="12" cy="12" r="6.3" fill="none" stroke="#8a5c06" stroke-opacity=".34" stroke-width=".9"/>
    <path d="M9.1 7.8h3.2c2.9 0 4.9 1.8 4.9 4.2s-2 4.2-4.9 4.2H9.1Zm1.9 1.9v4.6h1.3c1.7 0 2.8-.9 2.8-2.3s-1.1-2.3-2.8-2.3Z"
      fill="#ffe9a3" opacity=".5" transform="translate(0 -.35)"/>
    <path d="M9.1 7.8h3.2c2.9 0 4.9 1.8 4.9 4.2s-2 4.2-4.9 4.2H9.1Zm1.9 1.9v4.6h1.3c1.7 0 2.8-.9 2.8-2.3s-1.1-2.3-2.8-2.3Z"
      fill="#8a5c06" opacity=".7" fill-rule="evenodd"/>
    <ellipse cx="8.3" cy="7.5" rx="3.1" ry="1.6" fill="#fff" opacity=".55" transform="rotate(-30 8.3 7.5)"/>
    <circle cx="10.7" cy="6.1" r=".85" fill="#fff" opacity=".8"/>
    <g clip-path="url(#${id}-clip)">
      <g transform="skewX(-18)"><g class="coin-sweep">
        <rect x="-14" y="-4" width="6" height="32" fill="url(#${id}-sweep)"/>
      </g></g>
    </g>`;
  return svg;
}

/** Fill every `[data-coin]` placeholder under `root` (once) with the shared coin SVG. */
export function mountCoins(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-coin]')) {
    if (!el.firstElementChild) el.append(coinSvg());
  }
}

/** Last value shown per element, so a change can count from where the reader last saw it. */
const shown = new WeakMap<HTMLElement, number>();

/**
 * Show a coin balance: thousands separators, and on change a count-up plus a shine sweep on the
 * coin beside the number — both skipped when motion is reduced. `el` sits inside a host that
 * holds the coin (`.id-coins`, `.balance`, `.reward`, `.cos-price`, `.row-v`).
 */
export function setBalance(el: HTMLElement, value: number): void {
  const to = Math.max(0, Math.round(value));
  const from = shown.get(el) ?? to;
  shown.set(el, to);
  const host = el.closest('.id-coins, .balance, .reward, .cos-price, .row-v') ?? el.parentElement;
  const coin = host?.querySelector<SVGSVGElement>('.coin') ?? null;
  const finish = () => { el.textContent = coinText(to); };
  if (from === to || motionReduced()) { finish(); return; }

  if (coin) {
    coin.classList.remove('sweep');
    void coin.getBoundingClientRect();          // reflow so the animation can restart
    coin.classList.add('sweep');
  }
  const t0 = performance.now();
  const DUR = 520;
  const tick = (now: number) => {
    const k = Math.min(1, (now - t0) / DUR);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = coinText(from + (to - from) * eased);
    if (k < 1) requestAnimationFrame(tick);
    else finish();
  };
  requestAnimationFrame(tick);
}
