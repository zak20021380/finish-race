/**
 * countries.ts — the country picker's data, with no dependency and no network call.
 *
 * Telegram never tells us where a player is (`initData` has a `language_code`, not a country), so the
 * app asks once and remembers. Two details matter on real devices: flag emojis are not drawn on
 * Windows, so every flag has a two-letter code fallback; and the language hint is only a *preselect*,
 * never a silent answer — `pt` may be Brazil or Portugal, and the player is the one who decides.
 */

/** ISO 3166-1 alpha-2 + English name. The code is also the flag: regional indicators are derived. */
const LIST = `
AD Andorra
AE United Arab Emirates
AF Afghanistan
AG Antigua and Barbuda
AI Anguilla
AL Albania
AM Armenia
AO Angola
AQ Antarctica
AR Argentina
AS American Samoa
AT Austria
AU Australia
AW Aruba
AX Åland Islands
AZ Azerbaijan
BA Bosnia and Herzegovina
BB Barbados
BD Bangladesh
BE Belgium
BF Burkina Faso
BG Bulgaria
BH Bahrain
BI Burundi
BJ Benin
BL Saint Barthélemy
BM Bermuda
BN Brunei
BO Bolivia
BQ Caribbean Netherlands
BR Brazil
BS Bahamas
BT Bhutan
BV Bouvet Island
BW Botswana
BY Belarus
BZ Belize
CA Canada
CC Cocos (Keeling) Islands
CD DR Congo
CF Central African Republic
CG Congo
CH Switzerland
CI Côte d'Ivoire
CK Cook Islands
CL Chile
CM Cameroon
CN China
CO Colombia
CR Costa Rica
CU Cuba
CV Cabo Verde
CW Curaçao
CX Christmas Island
CY Cyprus
CZ Czechia
DE Germany
DJ Djibouti
DK Denmark
DM Dominica
DO Dominican Republic
DZ Algeria
EC Ecuador
EE Estonia
EG Egypt
EH Western Sahara
ER Eritrea
ES Spain
ET Ethiopia
FI Finland
FJ Fiji
FK Falkland Islands
FM Micronesia
FO Faroe Islands
FR France
GA Gabon
GB United Kingdom
GD Grenada
GE Georgia
GF French Guiana
GH Ghana
GI Gibraltar
GL Greenland
GM Gambia
GN Guinea
GP Guadeloupe
GQ Equatorial Guinea
GR Greece
GS South Georgia
GT Guatemala
GU Guam
GW Guinea-Bissau
GY Guyana
HK Hong Kong SAR
HN Honduras
HR Croatia
HT Haiti
HU Hungary
ID Indonesia
IE Ireland
IL Israel
IM Isle of Man
IN India
IQ Iraq
IR Iran
IS Iceland
IT Italy
JE Jersey
JM Jamaica
JO Jordan
JP Japan
KE Kenya
KG Kyrgyzstan
KH Cambodia
KI Kiribati
KM Comoros
KN Saint Kitts and Nevis
KP North Korea
KR South Korea
KW Kuwait
KY Cayman Islands
KZ Kazakhstan
LA Laos
LB Lebanon
LC Saint Lucia
LI Liechtenstein
LK Sri Lanka
LR Liberia
LS Lesotho
LT Lithuania
LU Luxembourg
LV Latvia
LY Libya
MA Morocco
MC Monaco
MD Moldova
ME Montenegro
MF Saint Martin
MG Madagascar
MH Marshall Islands
MK North Macedonia
ML Mali
MM Myanmar
MN Mongolia
MO Macau SAR
MP Northern Mariana Islands
MQ Martinique
MR Mauritania
MS Montserrat
MT Malta
MU Mauritius
MV Maldives
MW Malawi
MX Mexico
MY Malaysia
MZ Mozambique
NA Namibia
NC New Caledonia
NE Niger
NF Norfolk Island
NG Nigeria
NI Nicaragua
NL Netherlands
NO Norway
NP Nepal
NR Nauru
NU Niue
NZ New Zealand
OM Oman
PA Panama
PE Peru
PF French Polynesia
PG Papua New Guinea
PH Philippines
PK Pakistan
PL Poland
PM Saint Pierre and Miquelon
PN Pitcairn Islands
PR Puerto Rico
PS Palestine
PT Portugal
PW Palau
PY Paraguay
QA Qatar
RE Réunion
RO Romania
RS Serbia
RU Russia
RW Rwanda
SA Saudi Arabia
SB Solomon Islands
SC Seychelles
SD Sudan
SE Sweden
SG Singapore
SH Saint Helena
SI Slovenia
SK Slovakia
SL Sierra Leone
SM San Marino
SN Senegal
SO Somalia
SR Suriname
SS South Sudan
ST São Tomé and Príncipe
SV El Salvador
SX Sint Maarten
SY Syria
SZ Eswatini
TC Turks and Caicos Islands
TD Chad
TF French Southern Territories
TG Togo
TH Thailand
TJ Tajikistan
TK Tokelau
TL Timor-Leste
TM Turkmenistan
TN Tunisia
TO Tonga
TR Turkey
TT Trinidad and Tobago
TV Tuvalu
TW Taiwan
TZ Tanzania
UA Ukraine
UG Uganda
UM US Outlying Islands
US United States
UY Uruguay
UZ Uzbekistan
VA Vatican City
VC Saint Vincent and the Grenadines
VE Venezuela
VG British Virgin Islands
VI US Virgin Islands
VN Vietnam
VU Vanuatu
WF Wallis and Futuna
WS Samoa
XK Kosovo
YE Yemen
YT Mayotte
ZA South Africa
ZM Zambia
ZW Zimbabwe
`.trim();

export interface Country { code: string; name: string }

export const COUNTRIES: Country[] = LIST.split('\n').map((line) => ({
  code: line.slice(0, 2),
  name: line.slice(3),
}));

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
 * Windows ships no flag glyphs at all: a regional-indicator pair comes out as two letters, and no
 * amount of measuring tells you that reliably (the fallback font is narrower than the letters it
 * stands for). So the platform decides, and the width test is only the backstop for an exotic
 * Android without Noto Color Emoji. Either way the two-letter chip below it always reads.
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

/** Marks the document so CSS swaps every flag for its code chip on platforms that cannot draw one. */
export function applyFlagSupport() {
  document.documentElement.classList.toggle('no-flags', !flagsRender());
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Names, codes and common spellings all answer to the search box. */
export function search(q: string, limit = 40): Country[] {
  const k = fold(q.trim());
  if (!k) return COUNTRIES.slice(0, limit);
  const hits: Country[] = [];
  for (const c of COUNTRIES) {
    if (fold(c.name).includes(k) || c.code === k || c.code.startsWith(k)) hits.push(c);
    if (hits.length >= limit) break;
  }
  return hits;
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
