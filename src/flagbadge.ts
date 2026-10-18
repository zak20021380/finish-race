/**
 * flagbadge.ts — real vector national flags for the player command bar.
 *
 * Windows ships no regional-indicator glyphs, so a flag emoji comes out as two letters
 * ("GB", "US"). This module draws the flag as an SVG inside a 22x15 rounded frame with
 * multi-stripe fields and simplified crests/emblems, a 1px metallic rim, a diagonal glass
 * sheen and a soft drop shadow. One inline node, no sprite, no request, no text fallback.
 */

const NS = 'http://www.w3.org/2000/svg';

let seq = 0;

/** The frame the whole module draws in: a 22x15 flag plate with 3.5 radius corners. */
const W = 22;
const H = 15;
const RIM_R = 3.5;

const WHITE = '#F8FAFC';

/* ---------- primitives ---------- */

const rows = (...colors: string[]): string => {
  const h = H / colors.length;
  return colors
    .map((c, i) => `<rect x="0" y="${(i * h).toFixed(2)}" width="${W}" height="${(h + 0.05).toFixed(2)}" fill="${c}"/>`)
    .join('');
};

const cols = (...colors: string[]): string => {
  const w = W / colors.length;
  return colors
    .map((c, i) => `<rect x="${(i * w).toFixed(2)}" y="0" width="${(w + 0.05).toFixed(2)}" height="${H}" fill="${c}"/>`)
    .join('');
};

const star = (cx: number, cy: number, r: number, fill: string, points = 5, inner = 0.42): string => {
  const pts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const rr = i % 2 === 0 ? r : r * inner;
    pts.push(`${(cx + Math.cos(a) * rr).toFixed(2)},${(cy + Math.sin(a) * rr).toFixed(2)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
};

const circle = (cx: number, cy: number, r: number, fill: string, extra = ''): string =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${extra}/>`;

/* a five-pointed star grid, used by the Union Jack canton and the US canton */
const usStars = (() => {
  let s = '';
  for (let row = 0; row < 5; row++) {
    const cy = 1.05 + row * 1.45;
    const n = row % 2 === 0 ? 5 : 4;
    for (let i = 0; i < n; i++) {
      const cx = (row % 2 === 0 ? 1.05 : 2.1) + i * 2.05;
      s += star(cx, cy, 0.58, WHITE);
    }
  }
  return s;
})();

const unionJack = (): string =>
  `<rect x="0" y="0" width="${W}" height="${H}" fill="#012169"/>`
  + `<path d="M0 0 22 15M22 0 0 15" stroke="#F8FAFC" stroke-width="3.4"/>`
  + `<path d="M0 0 22 15M22 0 0 15" stroke="#C8102E" stroke-width="1.7"/>`
  + `<path d="M11 0v15M0 7.5h22" stroke="#F8FAFC" stroke-width="4.8"/>`
  + `<path d="M11 0v15M0 7.5h22" stroke="#C8102E" stroke-width="2.7"/>`;

/* ---------- the flags ---------- */

const ART: Record<string, string> = {
  /* --- the eight the HUD leans on --- */
  IR: rows('#239F40', WHITE, '#DA0000')
    + `<path d="M9.1 7.9c.5-1.2 1.2-1.8 1.9-1.8s1.4.6 1.9 1.8M11 8.7c-.6 0-1.1-.2-1.5-.5M11 8.7c.6 0 1.1-.2 1.5-.5" stroke="#DA0000" stroke-width=".7" fill="none" stroke-linecap="round"/>`,
  US: rows('#B22234', WHITE, '#B22234', WHITE, '#B22234', WHITE, '#B22234', WHITE, '#B22234', WHITE, '#B22234', WHITE, '#B22234')
    + `<rect x="0" y="0" width="10.6" height="8.08" fill="#3C3B6E"/>${usStars}`,
  GB: unionJack(),
  DE: rows('#15181D', '#DD0000', '#FFCE00'),
  TR: `<rect width="22" height="15" fill="#E30A17"/>`
    + circle(8.6, 7.5, 3.2, WHITE)
    + circle(9.8, 7.5, 2.55, '#E30A17')
    + star(14.2, 7.5, 2, WHITE),
  BR: `<rect width="22" height="15" fill="#009C3B"/>`
    + `<path d="M11 1.8 20.2 7.5 11 13.2 1.8 7.5Z" fill="#FFDF00"/>`
    + circle(11, 7.5, 2.9, '#002776')
    + `<path d="M8.4 6.6c1.8-.9 3.6-.6 5.1.5" stroke="${WHITE}" stroke-width=".7" fill="none" stroke-linecap="round"/>`,
  FR: cols('#0055A4', WHITE, '#EF4135'),
  RU: rows(WHITE, '#0039A6', '#D52B1E'),
  AE: `<rect x="0" y="0" width="6" height="15" fill="#EF3340"/>`
    + `<rect x="6" y="0" width="16" height="5" fill="#00843D"/>`
    + `<rect x="6" y="5" width="16" height="5" fill="${WHITE}"/>`
    + `<rect x="6" y="10" width="16" height="5" fill="#15181D"/>`,

  /* --- Europe --- */
  AL: `<rect width="22" height="15" fill="#E41E20"/>`
    + `<path d="M11 4.6c-.9.4-1.4 1-1.6 1.7.5-.2.9-.1 1.2.1-.5.3-.8.7-.9 1.2.4-.2.8-.1 1 .1l.3 1.6.3-1.6c.2-.2.6-.3 1-.1-.1-.5-.4-.9-.9-1.2.3-.2.7-.3 1.2-.1-.2-.7-.7-1.3-1.6-1.7Z" fill="#15181D"/>`,
  AT: rows('#ED2939', WHITE, '#ED2939'),
  BE: cols('#15181D', '#FDDA24', '#EF3340'),
  BG: rows(WHITE, '#00966E', '#D62612'),
  CH: `<rect width="22" height="15" fill="#DA291C"/>`
    + `<path d="M9.6 3.6h2.8v2.4h2.4v2.9h-2.4v2.5H9.6V8.9H7.2V6h2.4Z" fill="${WHITE}"/>`,
  CZ: `<rect width="22" height="7.5" fill="${WHITE}"/><rect y="7.5" width="22" height="7.5" fill="#D7141A"/>`
    + `<path d="M0 0 10.4 7.5 0 15Z" fill="#11457E"/>`,
  DK: `<rect width="22" height="15" fill="#C8102E"/>`
    + `<path d="M7 0v15M0 7.2h22" stroke="${WHITE}" stroke-width="2.6"/>`,
  EE: rows('#0072CE', '#15181D', WHITE),
  ES: `<rect width="22" height="15" fill="#AA151B"/><rect y="3.75" width="22" height="7.5" fill="#F1BF00"/>`
    + `<path d="M6.2 6.1h1.4v3.2H6.2Z" fill="#AA151B" opacity=".85"/><circle cx="6.9" cy="7.7" r=".75" fill="#F1BF00"/>`,
  FI: `<rect width="22" height="15" fill="${WHITE}"/>`
    + `<path d="M7 0v15M0 7.4h22" stroke="#002F6C" stroke-width="2.7"/>`,
  GR: `<rect width="22" height="15" fill="#0D5EAF"/>`
    + [1, 3, 5, 7, 9, 11, 13].map((y) => `<rect x="0" y="${y}" width="22" height="1.07" fill="${WHITE}"/>`).join('')
    + `<rect x="0" y="0" width="8.1" height="8.1" fill="#0D5EAF"/>`
    + `<path d="M4.05 0v8.1M0 4.05h8.1" stroke="${WHITE}" stroke-width="1.6"/>`,
  HR: rows('#FF0000', WHITE, '#171796')
    + `<path d="M8.6 5.2h4.8v3.1c0 1.7-1.2 2.6-2.4 3.1-1.2-.5-2.4-1.4-2.4-3.1Z" fill="#F7DB17"/>`
    + `<path d="M9.8 5.2h1.1v3.4H9.8Zm3.5 0h1.1v3.4h-1.1Z" fill="#FF0000"/>`,
  HU: rows('#CE2939', WHITE, '#477050'),
  IE: cols('#169B62', WHITE, '#FF883E'),
  IS: `<rect width="22" height="15" fill="#02529C"/>`
    + `<path d="M7 0v15M0 7.3h22" stroke="${WHITE}" stroke-width="3.6"/>`
    + `<path d="M7 0v15M0 7.3h22" stroke="#DC1E35" stroke-width="1.7"/>`,
  IT: cols('#009246', WHITE, '#CE2B37'),
  LT: rows('#FDB913', '#006A44', '#C1272D'),
  LV: `<rect width="22" height="15" fill="#9E3039"/><rect y="6" width="22" height="3" fill="${WHITE}"/>`,
  NL: rows('#AE1C28', WHITE, '#21468B'),
  NO: `<rect width="22" height="15" fill="#BA0C2F"/>`
    + `<path d="M6.6 0v15M0 7h22" stroke="${WHITE}" stroke-width="4"/>`
    + `<path d="M6.6 0v15M0 7h22" stroke="#00205B" stroke-width="2"/>`,
  PL: rows(WHITE, '#DC143C'),
  PT: `<rect width="22" height="15" fill="#DA291C"/><rect width="8.6" height="15" fill="#046A38"/>`
    + circle(8.6, 7.5, 2.6, '#FFE900') + circle(8.6, 7.5, 1.6, '#DA291C') + circle(8.6, 7.5, .8, WHITE),
  RO: cols('#002B7F', '#FCD116', '#CE1126'),
  RS: rows('#C6363C', '#0C4076', WHITE)
    + `<path d="M8.2 4.6h5.6v3.6c0 1.9-1.4 2.9-2.8 3.5-1.4-.6-2.8-1.6-2.8-3.5Z" fill="#C6363C" stroke="#EDB92E" stroke-width=".6"/>`,
  SE: `<rect width="22" height="15" fill="#006AA7"/>`
    + `<path d="M7 0v15M0 7.2h22" stroke="#FECC00" stroke-width="2.8"/>`,
  SI: rows(WHITE, '#005DA4', '#ED1C24')
    + `<path d="M7.8 4.2h6.4v4c0 2-1.6 3-3.2 3.6-1.6-.6-3.2-1.6-3.2-3.6Z" fill="#005DA4" stroke="${WHITE}" stroke-width=".5"/>`,
  SK: rows(WHITE, '#0B4EA2', '#EE1C25')
    + `<path d="M6.8 4.2h5.2v4.2c0 1.8-1.3 2.6-2.6 3.2-1.3-.6-2.6-1.4-2.6-3.2Z" fill="#EE1C25" stroke="${WHITE}" stroke-width=".55"/>`,
  UA: rows('#0057B7', '#FFD700'),

  /* --- the wider world --- */
  AR: rows('#74ACDF', WHITE, '#74ACDF') + circle(11, 7.5, 1.5, '#F6B40E'),
  AU: `<rect width="22" height="15" fill="#012169"/>`
    + `<g transform="scale(.5)">${unionJack()}</g>`
    + star(16.4, 4.2, 1.5, WHITE, 7, 0.45) + star(16.4, 11, 1, WHITE, 7, 0.45)
    + star(12.6, 7.5, .75, WHITE, 7, 0.45) + star(19.4, 7.5, .75, WHITE, 7, 0.45),
  BD: `<rect width="22" height="15" fill="#006A4E"/>` + circle(9.4, 7.5, 4, '#F42A41'),
  CA: `<rect width="22" height="15" fill="${WHITE}"/>`
    + `<rect x="0" width="5.4" height="15" fill="#D80621"/><rect x="16.6" width="5.4" height="15" fill="#D80621"/>`
    + `<path d="M11 3.4 11.7 5.4 13.1 4.8 12.5 6.6 14 7.4 12.2 8 12.4 9.4 10.9 8.7 11 11.6 10.1 11.6 10.2 8.7 8.7 9.4 8.9 8 7.1 7.4 8.6 6.6 8 4.8 9.4 5.4Z" fill="#D80621"/>`,
  CL: `<rect width="22" height="7.5" fill="${WHITE}"/><rect y="7.5" width="22" height="7.5" fill="#D52B1E"/>`
    + `<rect width="7.4" height="7.5" fill="#0039A6"/>` + star(3.7, 3.75, 2, WHITE),
  CN: `<rect width="22" height="15" fill="#EE1C25"/>`
    + star(4.8, 4.4, 2.4, '#FFDE00')
    + star(8.6, 2.3, .8, '#FFDE00') + star(10, 4.1, .8, '#FFDE00')
    + star(9.8, 6.3, .8, '#FFDE00') + star(8.2, 7.9, .8, '#FFDE00'),
  CO: rows('#FCD116', '#FCD116', '#003893', '#CE1126'),
  DZ: `<rect width="22" height="15" fill="#006233"/><rect x="11" width="11" height="15" fill="${WHITE}"/>`
    + circle(11, 7.5, 3, '#D21034') + circle(12.1, 7.5, 2.5, WHITE) + star(14.6, 7.5, 1.5, '#D21034'),
  EG: rows('#CE1126', WHITE, '#15181D')
    + `<path d="M11 6.2c1.6 0 2.6 1.1 2.6 2.3 0 .9-.5 1.5-1.2 1.9l-.5-1.6-1 .3.2 1.5c-1.5-.2-2.7-1.1-2.7-2.2 0-1.2 1-2.2 2.6-2.2Z" fill="#C09300"/>`,
  GH: rows('#CE1126', '#FCD116', '#006B3F') + star(11, 7.5, 1.8, '#15181D'),
  ID: rows('#CE1126', WHITE),
  IL: `<rect width="22" height="15" fill="${WHITE}"/>`
    + `<rect y="2" width="22" height="1.6" fill="#0038B8"/><rect y="11.4" width="22" height="1.6" fill="#0038B8"/>`
    + `<path d="M11 4.6 13.1 8.2H8.9Z" fill="none" stroke="#0038B8" stroke-width=".8"/>`
    + `<path d="M11 10.4 8.9 6.8h4.2Z" fill="none" stroke="#0038B8" stroke-width=".8"/>`,
  IN: rows('#FF9933', WHITE, '#138808')
    + circle(11, 7.5, 1.9, 'none', ' stroke="#000080" stroke-width=".7"')
    + circle(11, 7.5, .4, '#000080'),
  JP: `<rect width="22" height="15" fill="${WHITE}"/>` + circle(11, 7.5, 3.6, '#BC002D'),
  KE: rows('#15181D', WHITE, '#BB0000', WHITE, '#006600')
    + `<path d="M11 3.6c1 1.3 1.5 2.6 1.5 3.9s-.5 2.6-1.5 3.9c-1-1.3-1.5-2.6-1.5-3.9s.5-2.6 1.5-3.9Z" fill="#BB0000" stroke="${WHITE}" stroke-width=".5"/>`,
  KR: `<rect width="22" height="15" fill="${WHITE}"/>`
    + `<path d="M11 4.1a3.4 3.4 0 0 1 0 6.8 1.7 1.7 0 0 1 0-3.4 1.7 1.7 0 0 0 0-3.4Z" fill="#CD2E3A"/>`
    + `<path d="M11 10.9a3.4 3.4 0 0 1 0-6.8 1.7 1.7 0 0 1 0 3.4 1.7 1.7 0 0 0 0 3.4Z" fill="#0047A0"/>`,
  KZ: `<rect width="22" height="15" fill="#00AFCA"/>`
    + circle(11, 5.8, 1.9, '#FEC50C') + `<path d="M9.4 9.2c1 .8 2.2.8 3.2 0" stroke="#FEC50C" stroke-width=".7" fill="none"/>`,
  LK: `<rect width="22" height="15" fill="#FFB700"/><rect x="0" width="4.4" height="15" fill="#8D153A"/>`
    + `<rect x="4.4" width="4.4" height="15" fill="#FFB700"/><rect x="8.8" width="12" height="15" fill="#8D153A"/>`
    + `<rect x="10.2" y="1.6" width="9.4" height="11.8" fill="none" stroke="#FFB700" stroke-width=".7"/>`
    + `<circle cx="14.9" cy="7.5" r="1.5" fill="#FFB700"/>`,
  MA: `<rect width="22" height="15" fill="#C1272D"/>`
    + `<path d="M11 4.3 12.4 8.6 8.8 6.1h4.4L9.6 8.6Z" fill="none" stroke="#006233" stroke-width=".8"/>`,
  MX: cols('#006847', WHITE, '#CE1126') + circle(11, 7.5, 1.5, '#8B5A2B'),
  MY: `<rect width="22" height="15" fill="${WHITE}"/>`
    + [0, 2, 4, 6, 8, 10, 12].map((y) => `<rect y="${y}" width="22" height="1.07" fill="#CC0001"/>`).join('')
    + `<rect width="11" height="7.5" fill="#010066"/>`
    + circle(5.4, 3.75, 2.9, '#FFCC00') + circle(6.3, 3.75, 2.4, '#010066') + star(8.6, 3.75, 1.3, '#FFCC00'),
  NG: cols('#008751', WHITE, '#008751'),
  NP: `<rect width="22" height="15" fill="#DC143C"/>`
    + `<path d="M3 0.8 12.4 6 4.4 7.6l8 5.1L3 14.4Z" fill="#DC143C" stroke="#003893" stroke-width="1"/>`,
  NZ: `<rect width="22" height="15" fill="#012169"/>`
    + `<g transform="scale(.5)">${unionJack()}</g>`
    + star(16.4, 4.4, 1.2, '#C8102E', 5, 0.45) + star(19.2, 8.2, 1.2, '#C8102E', 5, 0.45)
    + star(14, 8.2, 1.2, '#C8102E', 5, 0.45) + star(16.4, 11.3, 1.2, '#C8102E', 5, 0.45),
  PE: cols('#D91023', WHITE, '#D91023'),
  PH: `<rect width="22" height="7.5" fill="#0038A8"/><rect y="7.5" width="22" height="7.5" fill="#CE1126"/>`
    + `<path d="M0 0 8.4 7.5 0 15Z" fill="${WHITE}"/>`
    + circle(2.7, 7.5, 1.5, '#FCD116')
    + [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
      const a = (i * Math.PI) / 4;
      return circle(2.7 + Math.cos(a) * 2.2, 7.5 + Math.sin(a) * 2.2, .4, '#FCD116');
    }).join(''),
  PK: `<rect width="22" height="15" fill="#01411C"/><rect width="4.4" height="15" fill="${WHITE}"/>`
    + circle(12.4, 7.2, 3.4, WHITE) + circle(13.9, 6.3, 2.9, '#01411C')
    + star(16.6, 4.4, 1.3, WHITE),
  SA: `<rect width="22" height="15" fill="#006C35"/>`
    + `<path d="M4.2 6.1h13.6" stroke="${WHITE}" stroke-width="1.15" stroke-linecap="round"/>`
    + `<path d="M5.4 9.9h11.2l-1.4 1.1H6.8Z" fill="${WHITE}"/>`,
  SG: `<rect width="22" height="7.5" fill="#EF3340"/><rect y="7.5" width="22" height="7.5" fill="${WHITE}"/>`
    + circle(5.2, 3.75, 2.6, WHITE) + circle(6.2, 3.75, 2.1, '#EF3340')
    + star(8.2, 2.1, .7, WHITE) + star(9.2, 3.7, .7, WHITE) + star(8.6, 5.3, .7, WHITE),
  TH: rows('#A51931', WHITE, '#2D2A4A', '#2D2A4A', WHITE, '#A51931'),
  TN: `<rect width="22" height="15" fill="#E70013"/>` + circle(11, 7.5, 3.4, WHITE)
    + circle(11, 7.5, 2.4, '#E70013') + circle(12.1, 7.5, 2, WHITE) + star(14.4, 7.5, 1.2, '#E70013'),
  VE: rows('#FFCC00', '#00247D', '#CF142B')
    + [0, 1, 2, 3, 4, 5, 6].map((i) => {
      const a = Math.PI * (0.15 + (i * 0.7) / 6);
      return star(11 + Math.cos(a) * 3.4, 6.1 - Math.sin(a) * 1.6, .5, WHITE);
    }).join(''),
  VN: `<rect width="22" height="15" fill="#DA251D"/>` + star(11, 7.5, 3.4, '#FFFF00'),
  ZA: `<rect width="22" height="15" fill="#007A4D"/>`
    + `<path d="M0 0h22v5H6.6Z" fill="#DE3831"/>`
    + `<path d="M0 15h22v-5H6.6Z" fill="#002395"/>`
    + `<path d="M0 2.4 10 7.5 0 12.6Z" fill="#15181D" stroke="#FFB612" stroke-width=".9"/>`,
};

/* ---------- the plate ---------- */

/** A sleek, wordless fallback for a code the table does not know yet. */
const FALLBACK = `<rect width="${W}" height="${H}" fill="#1E293B"/>`
  + `<path d="M0 10.6 10.4 4.2 22 6.2v8.8H0Z" fill="#273549"/>`
  + `<circle cx="11" cy="7.5" r="2.5" fill="none" stroke="#64748B" stroke-width=".9"/>`
  + `<path d="M8.5 7.5h5M11 5v5" stroke="#64748B" stroke-width=".7"/>`;

/**
 * `renderCountryFlagSvg('IR')` → a 22x15 inline `<svg>` plate: rounded clip, vector flag,
 * 1px metallic rim and a diagonal glass sheen. Unknown codes get the slate fallback.
 */
export function renderCountryFlagSvg(code: string): SVGSVGElement {
  const key = String(code || '').trim().toUpperCase();
  const art = ART[key] ?? FALLBACK;
  const id = `fb${++seq}`;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'flag-vector');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = `<defs>
      <clipPath id="${id}-clip"><rect x="0" y="0" width="${W}" height="${H}" rx="${RIM_R}" /></clipPath>
      <linearGradient id="${id}-sheen" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#FFFFFF" stop-opacity=".35" />
        <stop offset=".5" stop-color="#FFFFFF" stop-opacity="0" />
      </linearGradient>
    </defs>
    <g clip-path="url(#${id}-clip)">${art}</g>
    <rect x="0" y="0" width="${W}" height="${H}" rx="${RIM_R}" fill="url(#${id}-sheen)" />
    <rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="${RIM_R - 0.5}" fill="none"
      stroke="rgba(255,255,255,.28)" stroke-width="1" />`;
  return svg;
}

/** Every code with a hand-drawn flag (the tests use it to keep the table honest). */
export const FLAG_CODES: readonly string[] = Object.freeze(Object.keys(ART));
