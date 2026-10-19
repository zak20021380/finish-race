/**
 * countries.ts — the country picker's registry, sourced from one standardized
 * ISO 3166-1 alpha-2 dataset (`data/countries.json`) instead of a hand-typed list.
 *
 * The JSON is generated from the maintained mledoze/countries dataset and ships
 * as a static asset, so the app stays offline-first: 250 nations and territories,
 * one schema `{ code, name, dialCode? }`, no network call at runtime.
 *
 * Telegram never tells us where a player is (`initData` has a `language_code`,
 * not a country), so the app lets the player pick one in Profile and remembers.
 * Two details matter on real devices: flags are rendered by the shared CDN
 * resolver (`flags.ts`), and the language hint is only a *preselect*, never a
 * silent answer — `pt` may be Brazil or Portugal, and the player decides.
 */

import registry from './data/countries.json';

export interface Country {
  code: string;
  name: string;
  /** E.164 calling code, present when the source dataset publishes one. */
  dialCode?: string;
}

/** The full ISO-3166-1 registry, alphabetical by English name. */
export const COUNTRIES: Country[] = registry as Country[];

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

export const knownCountry = (code: unknown): code is string =>
  typeof code === 'string' && BY_CODE.has(code.toUpperCase());

export const nameOf = (code: string): string => BY_CODE.get(code.toUpperCase())?.name ?? code;

/** Regional indicators: U+1F1E6 + the letter's offset from A, per half of the code. */
export function flagOf(code: string): string {
  const up = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(up)) return '';
  let out = '';
  for (let i = 0; i < 2; i++) out += String.fromCodePoint(0x1f1e6 + (up.charCodeAt(i) - 65));
  return out;
}

/**
 * Windows ships no flag glyphs at all: a regional-indicator pair comes out as two
 * letters. This guard now only serves the language picker's emoji flags — every
 * country flag is a CDN image from `flags.ts` and never depends on emoji support.
 */
export function flagsRender(): boolean {
  const ua = `${navigator.userAgent ?? ''} ${navigator.platform ?? ''}`;
  if (/Windows|Win32|Win64|Win16/i.test(ua)) return false;
  try {
    const c = document.createElement('canvas').getContext('2d');
    if (!c) return false;
    c.font = '48px sans-serif';
    const w = (s: string) => c.measureText(s).width;
    for (const code of ['AQ', 'BR', 'JP']) {
      const pair = w(flagOf(code));
      if (!pair || pair > w(code) * 0.98) return false;      // two letters, not one flag
    }
    return true;
  } catch {
    return false;
  }
}

/** Marks the document so CSS swaps every flag glyph for its code chip on platforms that cannot draw one. */
export function applyFlagSupport() {
  document.documentElement.classList.toggle('no-flags', !flagsRender());
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Common English spellings that are not the dataset's `name.common` (Ivory
 * Coast / Côte d'Ivoire, Türkiye / Turkey, …). They are search aliases only —
 * the registry itself stays exactly the standardized ISO snapshot.
 */
const SEARCH_ALIASES: Record<string, readonly string[]> = {
  CI: ["Côte d'Ivoire", 'Cote dIvoire'],
  TR: ['Turkey'],
  CD: ['Democratic Republic of the Congo', 'Congo-Kinshasa'],
  CG: ['Republic of the Congo', 'Congo-Brazzaville'],
  KR: ['Republic of Korea', 'Korea, South'],
  KP: ["Democratic People's Republic of Korea", 'Korea, North'],
  RU: ['Russian Federation'],
  SY: ['Syrian Arab Republic'],
  VN: ['Viet Nam'],
  BO: ['Plurinational State of Bolivia'],
  VE: ['Bolivarian Republic of Venezuela'],
  TZ: ['United Republic of Tanzania'],
  MD: ['Republic of Moldova'],
  LA: ["Lao People's Democratic Republic"],
  IR: ['Islamic Republic of Iran'],
  US: ['USA', 'United States of America'],
  GB: ['UK', 'Great Britain'],
  AE: ['UAE'],
  CZ: ['Czech Republic'],
  SZ: ['Swaziland'],
  MK: ['Macedonia'],
  MM: ['Burma'],
  CV: ['Cape Verde'],
  TL: ['East Timor'],
  NL: ['Holland'],
};

/**
 * Names, codes and common spellings all answer to the search box. The full
 * registry is returned by default — the picker filters the complete world, not
 * a truncated first page.
 */
export function search(q: string, limit = COUNTRIES.length): Country[] {
  const raw = q.trim();
  if (!raw) return COUNTRIES.slice(0, limit);
  const k = fold(raw);
  const up = raw.toUpperCase();
  const scored: { c: Country; rank: number }[] = [];
  for (const c of COUNTRIES) {
    const name = fold(c.name);
    const aliases = (SEARCH_ALIASES[c.code] ?? []).map(fold);
    const rank = c.code === up ? 0
      : name.startsWith(k) ? 1
        : aliases.some((a) => a.startsWith(k)) ? 2
          : c.code.startsWith(up) ? 3
            : name.includes(k) ? 4
              : aliases.some((a) => a.includes(k)) ? 5
                : c.dialCode === raw ? 6
                  : 99;
    if (rank < 99) scored.push({ c, rank });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, limit).map((x) => x.c);
}

/**
 * Language → the country that language is most spoken in, only to land the picker on a sensible row.
 * A language with a region subtag (`pt-BR`) answers exactly; a bare one guesses, and the player
 * confirms.
 */
const LANG_COUNTRY: Record<string, string> = {
  en: 'US', fa: 'IR', ar: 'SA', tr: 'TR', ru: 'RU', uk: 'UA', es: 'ES', fr: 'FR', de: 'DE',
  pt: 'BR', it: 'IT', id: 'ID', ms: 'MY', nl: 'NL', pl: 'PL', hi: 'IN', bn: 'BD', ur: 'PK',
  ta: 'IN', zh: 'CN', ja: 'JP', ko: 'KR', vi: 'VN', th: 'TH', el: 'GR', he: 'IL', sv: 'SE',
  nb: 'NO', no: 'NO', da: 'DK', fi: 'FI', cs: 'CZ', sk: 'SK', hu: 'HU', ro: 'RO', bg: 'BG',
  hr: 'HR', sr: 'RS', sl: 'SI', az: 'AZ', kk: 'KZ', uz: 'UZ', tl: 'PH', sw: 'KE', am: 'ET',
  ha: 'NG', yo: 'NG', ig: 'NG', rw: 'RW', so: 'SO', ku: 'IQ', ka: 'GE', hy: 'AM', ne: 'NP',
  si: 'LK', km: 'KH', lo: 'LA', my: 'MM', ps: 'AF', tg: 'TJ', et: 'EE', lv: 'LV', lt: 'LT',
  mk: 'MK', sq: 'AL', be: 'BY', gl: 'ES', ca: 'ES', eu: 'ES', is: 'IS', ga: 'IE', mt: 'MT',
  cy: 'GB', gd: 'GB', tt: 'RU',
};

export function guessCountry(lang: string): string {
  const raw = (lang || '').trim().toLowerCase();
  if (!raw) return '';
  const parts = raw.split(/[-_]/);
  if (parts[1] && parts[1].length === 2 && BY_CODE.has(parts[1].toUpperCase())) return parts[1].toUpperCase();
  return LANG_COUNTRY[parts[0]] ?? '';
}
