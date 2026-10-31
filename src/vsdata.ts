/**
 * vsdata.ts — the data behind the VS clash screen, with no DOM and no storage in it.
 *
 * Two reasons it is its own module: the pre-match overlay runs on a timer a browser suite cannot
 * wait on, so the parts that decide *what* the screen says (rival personas, the nationality
 * cascade, the warfare copy) are kept where Node can assert on them directly — and the overlay
 * file is left with nothing but animation and paint.
 *
 * Every pick here is a hash of an id, never `Math.random()`: a rival that is Brazil and "Obsidian
 * Cortex" on one entry must be the same on the next, or the face-off reads as a slot machine.
 */

export type ClashLang = 'en' | 'fa' | 'ru' | 'ar' | 'es';
export type ClashDir = 'ltr' | 'rtl';
/** The machine's three levels, kept as a local union so this file stays import-free. */
export type ClashTier = 'easy' | 'normal' | 'hard';

export interface ClashCopy {
  dir: ClashDir;
  /** Rotating psychological callout lines, one at a time on the banner. */
  lines: string[];
  /** The badge for a player who has not bound a squad yet. */
  loneSquad: string;
  /** Shown instead of a country name when nothing resolved. */
  noNation: string;
  /** The word over each fighter card. */
  youLabel: string;
  rivalLabel: string;
  /** Pill labels. `mindGap` is followed by the TIQ distance between the two seats. */
  modeRanked: string;
  modeBot: string;
  modeRoom: string;
  /** The crest caption under the format mark on a three-seat race. */
  shapeTrio: string;
  /** The crest caption under the format mark on a four-seat race. */
  shapeQuad: string;
  mindGap: string;
  skip: string;
  /** Screen-reader announcement for the face-off. */
  versus: string;
}

/**
 * EN/FA/AR are the three the brief dictates; ru and es ride along because the shell ships five
 * languages and a half-localised war cry is worse than a calm one.
 */
export const CLASH_COPY: Record<ClashLang, ClashCopy> = {
  en: {
    dir: 'ltr',
    lines: [
      'FIGHT FOR YOUR FLAG & SQUAD — NO SECOND CHANCES',
      'MIND VS MIND: OUTTHINK OR BE OUTPLAYED',
      'DEFEND YOUR TERRITORY. CONTROL THE BOARD.',
    ],
    loneSquad: '⚡ Lone Tactician',
    noNation: 'Unranked Territory',
    youLabel: 'Player',
    rivalLabel: 'Rival',
    modeRanked: 'RANKED 1V1',
    modeBot: 'BOT DUEL',
    modeRoom: 'PRIVATE ROOM',
    shapeTrio: '3-WAY CLASH',
    shapeQuad: 'FREE FOR ALL',
    mindGap: 'MIND GAP',
    skip: 'Tap to skip',
    versus: 'Match face-off',
  },
  fa: {
    dir: 'rtl',
    lines: [
      'به افتخار پرچم و اسکوادت بجنگ — جایی برای اشتباه نیست!',
      'نبرد ذهن‌ها: یا فریب بده، یا تسلیم شو!',
      'حواست رو جمع کن؛ حریف برای بردن اومده!',
    ],
    loneSquad: '⚡ تک‌تاز مستقل',
    noNation: 'سرزمین بدون رتبه',
    youLabel: 'تو',
    rivalLabel: 'حریف',
    modeRanked: 'تک‌نبرد رنکد',
    modeBot: 'نبرد با ربات',
    modeRoom: 'اتاق خصوصی',
    shapeTrio: 'نبرد سه‌نفره',
    shapeQuad: 'همه علیه همه',
    mindGap: 'اختلاف ذهن',
    skip: 'برای رد شدن بزن',
    versus: 'رویارویی پیش از نبرد',
  },
  ar: {
    dir: 'rtl',
    lines: [
      'قاتل من أجل علمك وفريقك — لا مجال للخطأ!',
      'معركة العقول: تفوّق بذكائك أو استسلم!',
      'ركّز جيداً؛ خصمك هنا لانتزاع الفوز!',
    ],
    loneSquad: '⚡ تكتيكي مستقل',
    noNation: 'أرض غير مصنّفة',
    youLabel: 'أنت',
    rivalLabel: 'الخصم',
    modeRanked: 'مبارزة ١ضد١ مصنّفة',
    modeBot: 'مبارزة الآلة',
    modeRoom: 'غرفة خاصة',
    shapeTrio: 'مواجهة ثلاثية',
    shapeQuad: 'الكل ضد الكل',
    mindGap: 'فارق الذكاء',
    skip: 'اضغط للتخطي',
    versus: 'مواجهة ما قبل المباراة',
  },
  ru: {
    dir: 'ltr',
    lines: [
      'СРАЖАЙСЯ ЗА ФЛАГ И СКВАД — ВТОРОГО ШАНСА НЕТ',
      'РАЗУМ ПРОТИВ РАЗУМА: ПЕРЕХИТРИ ИЛИ ПРОИГРАЙ',
      'ОБОРОНЯЙ ТЕРРИТОРИЮ. ЗАХВАТИ ДОСКУ.',
    ],
    loneSquad: '⚡ Тактик-одиночка',
    noNation: 'Без рейтинга',
    youLabel: 'Игрок',
    rivalLabel: 'Соперник',
    modeRanked: 'РЕЙТИНГ 1×1',
    modeBot: 'ДУЭЛЬ С БОТОМ',
    modeRoom: 'ЧАСТНАЯ КОМНАТА',
    shapeTrio: 'ТРОЙНОЕ СТОЛКНОВЕНИЕ',
    shapeQuad: 'КАЖДЫЙ ЗА СЕБЯ',
    mindGap: 'РАЗНИЦА TIQ',
    skip: 'Нажмите, чтобы пропустить',
    versus: 'Противостояние',
  },
  es: {
    dir: 'ltr',
    lines: [
      'LUCHA POR TU BANDERA Y TU ESCUADRA — SIN SEGUNDAS OPORTUNIDADES',
      'MENTE CONTRA MENTE: PIENSA MÁS RÁPIDO O SÉ ATRAPADO',
      'DEFIENDE TU TERRITORIO. CONTROLA EL TABLERO.',
    ],
    loneSquad: '⚡ Táctico Solitario',
    noNation: 'Territorio sin rango',
    youLabel: 'Jugador',
    rivalLabel: 'Rival',
    modeRanked: '1VS1 RANKEADO',
    modeBot: 'DUELO VS BOT',
    modeRoom: 'SALA PRIVADA',
    shapeTrio: 'CHOQUE A TRES',
    shapeQuad: 'TODOS CONTRA TODOS',
    mindGap: 'DISTANCIA MENTAL',
    skip: 'Toca para saltar',
    versus: 'Enfrentamiento de la partida',
  },
};

/** The clash speaks the app's language; an unknown code gets English, never a blank banner. */
export function clashCopy(code: string | null | undefined): ClashCopy {
  const base = ((code || '').toLowerCase().split(/[-_]/)[0]) as ClashLang;
  return CLASH_COPY[base] ?? CLASH_COPY.en;
}

/* ---------- deterministic picking ---------- */

/** FNV-1a: small, stable across engines, and good enough to spread 48 nations evenly. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Pick from a list by hash, with an offset so two seats of the same seed never collide. */
export function pickAt<T>(list: readonly T[], seed: string, offset = 0): T {
  const n = list.length;
  return list[((hashSeed(seed) + offset * 7) % n + n) % n];
}

/** A number in `[lo, hi]` from a hash, rounded to `step`. */
export function spread(seed: string, offset: number, lo: number, hi: number, step = 1): number {
  const span = Math.max(1, Math.floor((hi - lo) / step));
  const unit = (hashSeed(`${seed}#${offset}`) % span + span) % span;
  return lo + unit * step;
}

/* ---------- the nations the rivals come from ---------- */

/**
 * Alpha-2 codes only, every one of them in the ISO registry the picker ships, and every one with a
 * flag the CDN definitely draws. Deliberately mixed across regions — a ladder of five rivals that
 * are all Europe reads broken. Seats step through the list rather than sampling it, so a four-seat
 * room can never hand two players the same banner.
 */
export const RIVAL_NATIONS: readonly string[] = [
  'IR', 'SA', 'AE', 'EG', 'IQ', 'MA', 'DZ', 'JO', 'KW', 'QA', 'TR', 'AZ', 'KZ', 'UZ',
  'IN', 'PK', 'BD', 'ID', 'MY', 'PH', 'VN', 'TH', 'JP', 'KR', 'CN', 'AU', 'NZ',
  'RU', 'UA', 'PL', 'CZ', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'NO', 'DK', 'FI', 'CH', 'AT',
  'GB', 'IE', 'PT', 'GR', 'IL', 'BR', 'AR', 'MX', 'US', 'CA', 'NG', 'KE', 'ZA', 'CO', 'CL',
];

/** The machine's callsigns: short, radio-clean, and a mix of regions on purpose. */
export const BOT_HANDLES: readonly string[] = [
  'Kestrel', 'Vantor', 'Riven', 'Onyx', 'Zephyr', 'Kaido', 'Sable', 'Talon', 'Corvus', 'Nyx',
  'Quanta', 'Rook', 'Bishop', 'Voss', 'Farhad', 'Nour', 'Kian', 'Rostam', 'Ilyin', 'Azizi',
  'Leyla', 'Demir', 'Serrano', 'Okoye', 'Halvorsen', 'Marchetti', 'Berg', 'Danilo', 'Reza', 'Amari',
];

/**
 * Elite rival squads, one pool per tier: the easy machine leads a academy side, the hard one leads
 * something with a reputation. These are the *rival* squads — the player's own squad comes from
 * the compete/squads system.
 */
export const BOT_SQUADS: Record<ClashTier, readonly string[]> = {
  easy: ['Iron Cadets', 'Signal Recruits', 'Vector Academy'],
  normal: ['Neural Vanguard', 'Apex Strategists', 'Cobalt Protocol'],
  hard: ['Obsidian Cortex', 'Grandmaster Syndicate', 'Titan Directive'],
};

/** Squads an online rival carries when their seat broadcasts none. */
export const RIVAL_SQUADS: readonly string[] = [
  'Crimson Circuit', 'Null Pointer', 'Iron Compass', 'Deep Line Guild', 'Static Reign',
  'Onyx Directorate', 'Blue Shift', 'Fork Patrol', 'Last Rank Alliance',
];

/** TIQ bands per tier, so a Hard bot sits in the Strategist-to-Grandmaster range like a real one. */
const TIQ_BAND: Record<ClashTier, [number, number]> = { easy: [420, 980], normal: [1080, 1980], hard: [2150, 3450] };

export interface RivalPersona {
  name: string;
  /** Alpha-2 ISO code, always one of `RIVAL_NATIONS`. */
  country: string;
  squad: string;
  /** The Mind Tier word the crest wears. */
  tier: 'rookie' | 'tactician' | 'strategist' | 'grandmaster';
  tiq: number;
  initial: string;
}

const tierOfTiq = (tiq: number): RivalPersona['tier'] =>
  tiq >= 3000 ? 'grandmaster' : tiq >= 2000 ? 'strategist' : tiq >= 1000 ? 'tactician' : 'rookie';

/**
 * A machine seat as a person: handle, banner, squad and a TIQ that matches the tier it plays at.
 * `offset` is the seat index — it is what keeps two bots in one room from wearing the same flag.
 */
export function botPersona(id: string, tier: ClashTier, offset = 0): RivalPersona {
  const [lo, hi] = TIQ_BAND[tier];
  const tiq = spread(id, offset, lo, hi, 10);
  const name = pickAt(BOT_HANDLES, `${id}|${tier}`, offset);
  return {
    name,
    country: RIVAL_NATIONS[(hashSeed(`${id}|bot`) + offset * 11) % RIVAL_NATIONS.length],
    squad: pickAt(BOT_SQUADS[tier], `${id}|${tier}`, offset),
    tier: tierOfTiq(tiq),
    tiq,
    initial: name.charAt(0).toUpperCase(),
  };
}

/** An online rival's seat, dressed with a deterministic banner and squad when it broadcasts none. */
export function rivalPersona(id: string, name: string, tiq: number, offset = 0): RivalPersona {
  return {
    name,
    country: RIVAL_NATIONS[(hashSeed(`${id}|nat`) + offset * 11) % RIVAL_NATIONS.length],
    squad: pickAt(RIVAL_SQUADS, `${id}|squad`, offset),
    tier: tierOfTiq(tiq),
    tiq,
    initial: (name.trim().charAt(0) || '?').toUpperCase(),
  };
}

/* ---------- the local player's nation ---------- */

/**
 * Telegram hands us a `language_code` and never a country, and the profile only carries one if the
 * player picked it. The cascade is ordered by how much each source is worth trusting: an explicit
 * choice, then the client's own locale, then the clock the device keeps, then the browser tongue.
 */
const TZ_NATION: Record<string, string> = {
  'Asia/Tehran': 'IR', 'Asia/Riyadh': 'SA', 'Asia/Dubai': 'AE', 'Asia/Kuwait': 'KW',
  'Asia/Qatar': 'QA', 'Asia/Baghdad': 'IQ', 'Asia/Amman': 'JO', 'Asia/Beirut': 'LB',
  'Africa/Cairo': 'EG', 'Africa/Casablanca': 'MA', 'Africa/Algiers': 'DZ', 'Africa/Tunis': 'TN',
  'Europe/Istanbul': 'TR', 'Europe/Baku': 'AZ', 'Europe/Kyiv': 'UA', 'Europe/Moscow': 'RU',
  'Europe/London': 'GB', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL', 'Europe/Warsaw': 'PL', 'Europe/Stockholm': 'SE',
  'Asia/Karachi': 'PK', 'Asia/Dhaka': 'BD', 'Asia/Kolkata': 'IN', 'Asia/Jakarta': 'ID',
  'Asia/Bangkok': 'TH', 'Asia/Ho_Chi_Minh': 'VN', 'Asia/Manila': 'PH', 'Asia/Singapore': 'SG',
  'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Shanghai': 'CN', 'Asia/Almaty': 'KZ',
  'Australia/Sydney': 'AU', 'Pacific/Auckland': 'NZ', 'America/New_York': 'US',
  'America/Chicago': 'US', 'America/Los_Angeles': 'US', 'America/Toronto': 'CA',
  'America/Mexico_City': 'MX', 'America/Sao_Paulo': 'BR', 'America/Buenos_Aires': 'AR',
  'America/Bogota': 'CO', 'America/Santiago': 'CL', 'Africa/Lagos': 'NG', 'Africa/Nairobi': 'KE',
  'Africa/Johannesburg': 'ZA', 'Asia/Jerusalem': 'IL',
};

/** A zone's region subtag answers exactly; a bare tongue is only a hint, and the player confirms. */
export function nationFromTz(zone: string | null | undefined): string {
  return TZ_NATION[(zone || '').trim()] ?? '';
}

/**
 * The whole cascade, in trust order. Pass what you have — missing entries are skipped, not faked.
 * `''` means nothing resolved, and the clash then wears the neutral territory badge.
 */
export function resolveNation(explicit: string | null | undefined, locales: readonly (string | null | undefined)[], zone?: string | null): string {
  const picked = (explicit || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(picked)) return picked;
  for (const locale of locales) {
    const region = (locale || '').toLowerCase().split(/[-_]/)[1];
    if (region && /^[A-Z]{2}$/.test(region.toUpperCase())) return region.toUpperCase();
  }
  const fromTz = nationFromTz(zone);
  if (fromTz) return fromTz;
  for (const locale of locales) {
    const fromLang = guessNation((locale || '').toLowerCase().split(/[-_]/)[0]);
    if (fromLang) return fromLang;
  }
  return '';
}

/** Language → the nation it is mostly spoken in: a preselect for the badge, never a claim. */
export const LANG_NATION: Record<string, string> = {
  en: 'US', fa: 'IR', ar: 'SA', tr: 'TR', ru: 'RU', uk: 'UA', es: 'ES', fr: 'FR', de: 'DE',
  pt: 'BR', it: 'IT', id: 'ID', ms: 'MY', nl: 'NL', pl: 'PL', hi: 'IN', bn: 'BD', ur: 'PK',
  ta: 'IN', zh: 'CN', ja: 'JP', ko: 'KR', vi: 'VN', th: 'TH', el: 'GR', he: 'IL', sv: 'SE',
  nb: 'NO', da: 'DK', fi: 'FI', cs: 'CZ', sk: 'SK', hu: 'HU', ro: 'RO', bg: 'BG', hr: 'HR',
  sr: 'RS', sl: 'SI', az: 'AZ', kk: 'KZ', uz: 'UZ', sw: 'KE', am: 'ET', ha: 'NG', yo: 'NG',
  ka: 'GE', hy: 'AM', ne: 'NP', si: 'LK', km: 'KH', lo: 'LA', my: 'MM', ps: 'AF', tg: 'TJ',
  sq: 'AL', be: 'BY', is: 'IS', ga: 'IE', cy: 'GB',
};

export const guessNation = (base: string): string => LANG_NATION[(base || '').toLowerCase()] ?? '';

/** 2–3 letters off a squad name for the crest, e.g. "Obsidian Cortex" → "OC". */
export function squadTag(name: string): string {
  const words = (name || '').replace(/^@/, '').split(/[^A-Za-z0-9\u0600-\u06FF\u0400-\u04FF]+/).filter(Boolean);
  if (!words.length) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
}
