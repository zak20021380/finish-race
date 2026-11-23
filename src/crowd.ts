/**
 * SIMULATED LIVE CROWD — in-match atmosphere, client-side only.
 *
 * This module is deliberately isolated from the economy, the rules and the wire. It never reads or
 * writes the player's real coins, Stars or TIQ; it never sends an action; it owns no server state.
 * It invents a believable audience for the board on screen, lets those fans bet simulated Telegram
 * Stars on whether YOU WIN or YOU LOSE, and paints a live-viewers pill plus a crowd-odds card above
 * the board, both of which open one tappable sheet.
 *
 * The audience itself is combinatorial, not a hardcoded roster: ~18 gender-tagged roots per gender
 * plus a tail table synthesise thousands of handles, so a 58-seat house never repeats a name. Every
 * metric that can be random is re-rolled per match — head count (7..58), the female/male mix, the
 * support split, each fan's side roll, the list order (Fisher–Yates) and the simulated Star wager.
 *
 * The house is alive for the whole race, not just on a big play. Every committed action flips a
 * couple of fans toward the side the board favours (a wall or a mine flips more than a routine
 * turn), a few new faces arrive or leave, and a 2.0s ambient tick keeps one pledge or one seat
 * moving while both players are still thinking. The odds rail and the two Star totals therefore
 * fluctuate constantly by themselves.
 *
 * A match also opens with one brief kickoff banner — how many fans staked how many Stars on the
 * dominant camp — which is pointer-transparent, auto-dismissing and owned by the same module.
 *
 * Design constraints that are part of the contract:
 *   · no `backdrop-filter`, no looping `@keyframes` — the arena's compositor belongs to the canvas;
 *   · at most ONE floating reaction pill exists at any moment (a second reaction retargets it);
 *   · every rendered number is Latin `0-9` inside a `<bdi dir="ltr">`, so RTL never mirrors a score;
 *   · every name is isolated in a `<bdi dir="auto">`, so a handle never reorders its sentence;
 *   · a gender reads as a circular two-tone vector portrait, never as a word or a glyph;
 *   · the only Star mark is the authentic Telegram Stars asset (`telegram_stars.png`);
 *   · icons are vectors or that PNG, never emoji.
 *
 * The DOM is static (`index.html`, inside `#s-game`); this module only reads it by id, fills it and
 * hides it when the match ends. `initMatchCrowd()` starts a fresh simulation, `onCrowdEvent()` is
 * the lifecycle hook `main.ts` calls after committed play, and `closeCrowd()` tears everything down.
 */
import { lang, onLang, type LangCode } from './settings';
import telegramStarsUrl from './assets/images/telegram_stars.png';

export type CrowdEventType = 'move' | 'wall' | 'mine' | 'near_finish' | 'turn';

export interface CrowdSetup {
  /** `true` for a 2v2 board, where a fan is tagged as team A/B rather than p1/p2. */
  teamMode?: boolean;
  /** The seats actually on this board: a player name, or a duo label (`Name1 & Name2`). */
  p1Name?: string;
  p2Name?: string;
}

type Camp = 0 | 1;
type Gender = 'f' | 'm';
type SideKey = 'p1' | 'p2' | 'A' | 'B';
/** The sheet's filter: the whole mixed house, or one camp's supporters. */
type Filter = 'all' | Camp;

interface Fan {
  /** a synthesised gamer handle, unique inside this match */
  handle: string;
  /** derived from the root pool the handle was built from */
  gender: Gender;
  /** 0 = the crimson camp (seat 0's side), 1 = the cyan camp. */
  camp: Camp;
  sideKey: SideKey;
  /** simulated Telegram Star wager, purely narrative */
  stake: number;
  /** a fan who has made up their mind; an undecided one is the bandwagon's raw material */
  decided: boolean;
  /** a fan this simulation already moved once — they may move again */
  bandwagon: boolean;
}

interface MatchCrowd {
  fans: Fan[];
  teamMode: boolean;
  /** the female share rolled for this match, reused when a spectator joins mid-game */
  femaleShare: number;
  /** The two sides' own names, in camp order. An empty slot falls back to a localized label. */
  names: [string, string];
}

/* ---------- entropy ----------
 * `crypto.getRandomValues` where the host offers it, `Math.random` otherwise. Every random draw in
 * this module goes through `rnd()`, so a match's mix can never be a static 50/50 by accident. */
function rnd(): number {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return (buf[0] ?? 0) / 4_294_967_296;
  }
  return Math.random();
}

const pickIndex = (n: number): number => (n > 0 ? Math.floor(rnd() * n) : 0);

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = pickIndex(i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Break any run of three same-gender portraits after the shuffle. The sheet deals the array from the
 * top, so the head of the list is what a reader sees first: one pass that swaps the next fan of the
 * other gender into a third same-gender slot keeps the rose and sky portraits naturally interleaved
 * instead of opening on a streak. In place, pure swaps — the house's mix is untouched.
 */
function interleaveGenders(fans: Fan[]): void {
  for (let i = 2; i < fans.length; i++) {
    const gender = fans[i]!.gender;
    if (fans[i - 1]!.gender !== gender || fans[i - 2]!.gender !== gender) continue;
    for (let j = i + 1; j < fans.length; j++) {
      if (fans[j]!.gender === gender) continue;
      const tmp = fans[i]!;
      fans[i] = fans[j]!;
      fans[j] = tmp;
      break;
    }
  }
}

/* ---------- the procedural handle generator ----------
 * Two compact root pools, each entry carrying its own gender, plus a tail table. Clean display form,
 * tailed form and two-digit numeric form give every root ~120 readable variants: 36 roots therefore
 * synthesise thousands of distinct handles from a few hundred bytes of source, and the caller's
 * `Set` guarantees a seat never repeats a handle. */
const FEMALE_ROOTS: readonly string[] = [
  'sara', 'nilo', 'maya', 'hasti', 'nika', 'ava', 'lina', 'ruya', 'yara',
  'sana', 'tara', 'dina', 'aya', 'elena', 'zara', 'mia', 'sofia', 'leila',
];

const MALE_ROOTS: readonly string[] = [
  'amir', 'kian', 'arash', 'alex', 'parsa', 'sina', 'saman', 'kaveh', 'babak',
  'omid', 'reza', 'dani', 'leo', 'noah', 'ethan', 'omar', 'diego', 'ivan',
];

const HANDLE_TAILS: readonly string[] = [
  '_x', '.gg', '77', '021', '99', '.pro', 'tx', '07', 'v2', '24', 'star', '88', '11', 'ir',
];

/** Synthesise one unused handle for `gender`. Falls back to a numeric tail after 48 collisions. */
function makeHandle(gender: Gender, used: Set<string>): string {
  const roots = gender === 'f' ? FEMALE_ROOTS : MALE_ROOTS;
  for (let attempt = 0; attempt < 48; attempt++) {
    const root = roots[pickIndex(roots.length)] ?? 'fan';
    const roll = rnd();
    let handle: string;
    if (roll < 0.16) {
      /* clean capitalized display form: `Sara`, `Amir` */
      handle = root.charAt(0).toUpperCase() + root.slice(1);
    } else if (roll < 0.76) {
      /* a tail: `sara.gg`, `hasti_x`, `arash07`, `nilo.pro` */
      handle = root + (HANDLE_TAILS[pickIndex(HANDLE_TAILS.length)] ?? '');
    } else {
      /* a two-digit numeric tail: `maya77`, `kian24` */
      handle = root + String(10 + pickIndex(90));
    }
    if (!used.has(handle)) return handle;
  }
  let fallback = '';
  do {
    const root = roots[pickIndex(roots.length)] ?? 'fan';
    fallback = root + String(100 + pickIndex(900));
  } while (used.has(fallback));
  return fallback;
}

/** Simulated Telegram Star wagers. Wide enough to read as a crowd, never one price point. */
const STAKES: readonly number[] = [
  5, 10, 15, 25, 50, 75, 100, 150, 250, 500,
];

/* ---------- copy ----------
 * Five locales, the same five the shell ships. Each template marks its numbers as `{n}` so the
 * renderer can isolate them in a `<bdi>`; `{a}` / `{b}` are the two camp totals in the sheet. */
interface CrowdCopy {
  title: string;
  viewers: string;
  close: string;
  /** the pill's small live tag */
  live: string;
  /** the sheet's filter row */
  all: string;
  filters: string;
  spectators: string;
  /** fallbacks when the host hands the crowd no seat name */
  p1: string;
  p2: string;
  /** the two betting camps, short tag first, then the provocative headline */
  winTag: string;
  loseTag: string;
  winHead: string;
  loseHead: string;
  /** the prediction card's live centre call: `{p}` carries the dominant share, percent included */
  winCall: string;
  loseCall: string;
  /** the kickoff banner: how many fans staked how many Stars on the dominant camp */
  kickoffWin: string;
  kickoffLose: string;
  /** a spectator row's full bet badge, crimson or sky */
  betWin: string;
  betLose: string;
  wall: string[];
  mine: string[];
  near: string[];
}

const COPY: Record<LangCode, CrowdCopy> = {
  en: {
    title: 'Live crowd & predictions',
    viewers: '{n} live spectators',
    close: 'Close',
    live: 'LIVE',
    all: 'All',
    filters: 'Filter spectators',
    spectators: 'Spectators',
    p1: 'Player 1', p2: 'Player 2',
    winTag: 'YOU WIN', loseTag: 'YOU LOSE',
    winHead: 'Betting you WIN', loseHead: 'Betting you LOSE',
    winCall: '{p} bet you WIN!', loseCall: '{p} bet you LOSE!',
    kickoffWin: '{n} fans staked {s} Stars betting you WIN!',
    kickoffLose: '{n} fans staked {s} Stars betting you LOSE!',
    betWin: 'Bet: you WIN', betLose: 'Bet: you LOSE',
    wall: ['Clutch wall by {name}!', 'That wall shut {name} down!', 'Smart block — no way through for {name}!'],
    mine: ['Boom — right on {name}!', 'The mine caught {name}!', 'That trap was brutal on {name}!'],
    near: ['{name} is one step from FINISH!', 'So close for {name}!', "Don't blink — {name} is on the final stretch!"],
  },
  fa: {
    title: 'تماشاگران و پیش‌بینی‌ها',
    viewers: '{n} تماشاگر زنده',
    close: 'بستن',
    live: 'زنده',
    all: 'همه',
    filters: 'فیلتر تماشاگران',
    spectators: 'تماشاگران',
    p1: 'بازیکن 1', p2: 'بازیکن 2',
    winTag: 'می‌بری', loseTag: 'می‌بازی',
    winHead: 'شرط بستن تو می‌بری', loseHead: 'شرط بستن تو می‌بازی',
    winCall: '{p} شرط بستن تو می‌بری!', loseCall: '{p} شرط بستن تو می‌بازی!',
    kickoffWin: '{n} نفر با {s} استارز شرط بستن تو می‌بری!',
    kickoffLose: '{n} نفر با {s} استارز شرط بستن تو می‌بازی!',
    betWin: 'شرط: تو می‌بری', betLose: 'شرط: تو می‌بازی',
    wall: ['عجب دیواری برای {name} بست!', 'این دیوار مسیر {name} رو بست!', 'دفاع حساب‌شده روی {name}!'],
    mine: ['مین کار خودش رو کرد روی {name}!', 'ترکید — مستقیم روی {name}!', 'این تله برای {name} بی‌رحمانه بود!'],
    near: ['{name} فقط دو قدم تا خط پایان!', '{name} خیلی نزدیک شد!', 'نفس‌ها برای {name} حبس شد!'],
  },
  ru: {
    title: 'Живая трибуна и прогнозы',
    viewers: '{n} зрителей онлайн',
    close: 'Закрыть',
    live: 'ЭФИР',
    all: 'Все',
    filters: 'Фильтр зрителей',
    spectators: 'Зрители',
    p1: 'Игрок 1', p2: 'Игрок 2',
    winTag: 'ТЫ ПОБЕДИШЬ', loseTag: 'ТЫ ПРОИГРАЕШЬ',
    winHead: 'Ставят на твою победу', loseHead: 'Ставят на твой проигрыш',
    winCall: '{p} ставят на твою победу!', loseCall: '{p} ставят на твой проигрыш!',
    kickoffWin: '{n} зрителей поставили {s} звёзд на твою победу!',
    kickoffLose: '{n} зрителей поставили {s} звёзд на твой проигрыш!',
    betWin: 'Ставка: ты победишь', betLose: 'Ставка: ты проиграешь',
    wall: ['Отличный блок от {name}!', 'Эта стена остановила {name}!', 'Умная защита — {name} не пройдёт!'],
    mine: ['Мина сработала — {name} попался!', 'Бум — прямо по {name}!', 'Жёсткая ловушка для {name}!'],
    near: ['{name} в одном шаге от ФИНИША!', 'Совсем рядом для {name}!', 'Не моргай — {name} на финишной прямой!'],
  },
  ar: {
    title: 'الجمهور المباشر والتوقعات',
    viewers: '{n} مشاهد مباشر',
    close: 'إغلاق',
    live: 'مباشر',
    all: 'الكل',
    filters: 'تصفية الجمهور',
    spectators: 'الجمهور',
    p1: 'اللاعب 1', p2: 'اللاعب 2',
    winTag: 'ستفوز', loseTag: 'ستخسر',
    winHead: 'يراهنون أنك ستفوز', loseHead: 'يراهنون أنك ستخسر',
    winCall: '{p} يراهنون أنك ستفوز!', loseCall: '{p} يراهنون أنك ستخسر!',
    kickoffWin: '{n} مشجعاً راهنوا بـ {s} نجمة على فوزك!',
    kickoffLose: '{n} مشجعاً راهنوا بـ {s} نجمة على خسارتك!',
    betWin: 'رهان: ستفوز', betLose: 'رهان: ستخسر',
    wall: ['سدٌّ حاسم من {name}!', 'هذا السد أوقف {name}!', 'دفاع ذكي — لا مرور لـ {name}!'],
    mine: ['اللغم انفجر — {name} في الفخ!', 'بووم — مباشرة على {name}!', 'فخ قاسٍ لـ {name}!'],
    near: ['{name} على خطوة من النهاية!', 'قريب جداً لـ {name}!', 'لا ترمش — {name} في اللفة الأخيرة!'],
  },
  es: {
    title: 'Público en vivo y pronósticos',
    viewers: '{n} espectadores en vivo',
    close: 'Cerrar',
    live: 'EN VIVO',
    all: 'Todos',
    filters: 'Filtrar espectadores',
    spectators: 'Espectadores',
    p1: 'Jugador 1', p2: 'Jugador 2',
    winTag: 'GANAS', loseTag: 'PIERDES',
    winHead: 'Apuestan a que GANAS', loseHead: 'Apuestan a que PIERDES',
    winCall: '{p} apuestan a que GANAS!', loseCall: '{p} apuestan a que PIERDES!',
    kickoffWin: '¡{n} fans apostaron {s} Stars a que GANAS!',
    kickoffLose: '¡{n} fans apostaron {s} Stars a que PIERDES!',
    betWin: 'Apuesta: GANAS', betLose: 'Apuesta: PIERDES',
    wall: ['¡Muro decisivo de {name}!', '¡Ese muro frenó a {name}!', '¡Bloqueo inteligente — {name} no pasa!'],
    mine: ['¡La mina atrapó a {name}!', '¡Bum — directo a {name}!', '¡Vaya trampa para {name}!'],
    near: ['¡{name} a un paso de la META!', '¡Muy cerca para {name}!', '¡No parpadees — {name} en la recta final!'],
  },
};

const copy = (): CrowdCopy => COPY[lang] ?? COPY.en;

/* ---------- number formatting ----------
 * `en-US` guarantees Latin digits and thousands separators even when the shell is Persian. */
const formatNum = (n: number): string => Math.round(n).toLocaleString('en-US');

/**
 * Turn a localized template into DOM nodes: every numeric placeholder becomes a
 * `<bdi dir="ltr">`, every name placeholder a `<bdi dir="auto">` (so a handle never reorders the
 * sentence around it), and everything else is appended as a text node — never parsed as markup.
 */
function templateNodes(
  template: string,
  vars: Record<string, string>,
  digitalKeys: readonly string[],
  nameKeys: readonly string[] = [],
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const re = /\{(\w+)\}/g;
  let last = 0;
  for (let m = re.exec(template); m; m = re.exec(template)) {
    if (m.index > last) frag.append(template.slice(last, m.index));
    const key = m[1] ?? '';
    const value = vars[key] ?? '';
    if (digitalKeys.includes(key)) {
      const b = document.createElement('bdi');
      b.dir = 'ltr';
      b.textContent = value;
      frag.append(b);
    } else if (nameKeys.includes(key)) {
      /* A player handle keeps its own direction and never reorders the sentence around it. */
      const b = document.createElement('bdi');
      b.dir = 'auto';
      b.className = 'crowd-name-inline';
      b.textContent = value;
      frag.append(b);
    } else {
      frag.append(value);
    }
    last = m.index + m[0].length;
  }
  if (last < template.length) frag.append(template.slice(last));
  return frag;
}

/** The name a camp fights under: the host's own seat name, or a localized placeholder. */
function campName(camp: Camp): string {
  const raw = match?.names[camp]?.trim() ?? '';
  if (raw) return raw;
  const c = copy();
  return camp === 0 ? c.p1 : c.p2;
}

/**
 * The one Telegram Star mark: the authentic PNG asset, never a hand-drawn polygon, a sprite or a
 * glyph. Every stake display in this module — odds rail, kickoff banner, reaction pill, head-to-head
 * box and every spectator row — mounts this same `crowd-star-ico` image.
 */
function starIcon(): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'crowd-star-ico';
  img.src = telegramStarsUrl;
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;
  img.setAttribute('aria-hidden', 'true');
  return img;
}

/**
 * Point every static `crowd-star-ico` in the markup at Vite's hashed asset URL, so the dev server
 * and the built bundle both resolve the same Stars PNG and no image is ever left broken.
 */
function hydrateStars(): void {
  const host = document.getElementById('s-game');
  if (!host) return;
  for (const img of host.querySelectorAll<HTMLImageElement>('img.crowd-star-ico')) {
    if (img.getAttribute('src') === telegramStarsUrl) continue;
    img.src = telegramStarsUrl;
  }
}

/* ---------- the two refined vector portraits ----------
 * Fixed inline vector paths, never emoji, never a font glyph: a rose feminine portrait and a sky
 * masculine portrait, each built as three clean layers — hair contour at a soft opacity, a sculpted
 * face, then a collar/shoulders mass — inside the 38×38 circular frame their gradient tint lives in. */
const PORTRAIT: Record<Gender, string> = {
  f: '<svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">'
    + '<path d="M20 4.6c-7.7 0-12.4 5-12.4 12.2v9.4c0 1.7-.7 3.2-1.9 4.3 2.7.6 5.6-.4 7.4-2.6l1.3-1.6V16.9c0-1.1.3-2 .9-2.6 1.5.9 3.2 1.4 5 1.4s3.5-.5 5-1.4c.6.6.9 1.5.9 2.6v9.4l1.3 1.6c1.8 2.2 4.7 3.2 7.4 2.6-1.2-1.1-1.9-2.6-1.9-4.3v-9.4C32.4 9.6 27.7 4.6 20 4.6Z"'
    + ' fill="#f472b6" opacity="0.75"/>'
    + '<path d="M20 9.4c-4 0-6.8 2.6-6.8 6.6v2.6c0 3.9 2.7 7 6.8 7s6.8-3.1 6.8-7V16c0-4-2.8-6.6-6.8-6.6Z"'
    + ' fill="#fce7f3"/>'
    + '<path d="M20 8.5c-3.9 0-6.7 2.1-7.2 5.3 1.4-1.6 4-2.6 7.2-2.6s5.8 1 7.2 2.6c-.5-3.2-3.3-5.3-7.2-5.3Z"'
    + ' fill="#f472b6" opacity="0.55"/>'
    + '<path d="M20 26.4c-5.6 0-10.1 2.9-10.1 6.5 0 1.6 1 2.6 2.5 2.6h15.2c1.5 0 2.5-1 2.5-2.6 0-3.6-4.5-6.5-10.1-6.5Z"'
    + ' fill="#fbcfe8"/></svg>',
  m: '<svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">'
    + '<path d="M20 5.1c-6.4 0-10.4 4.1-10.4 10.1 0 .6 0 1.2.1 1.8 1-3.1 4.7-5.2 10.3-5.2s9.3 2.1 10.3 5.2c.1-.6.1-1.2.1-1.8 0-6-4-10.1-10.4-10.1Z"'
    + ' fill="#38bdf8" opacity="0.78"/>'
    + '<path d="M20 9.6c-4 0-6.8 2.6-6.8 6.6v2.4c0 3.9 2.7 7 6.8 7s6.8-3.1 6.8-7v-2.4c0-4-2.8-6.6-6.8-6.6Z"'
    + ' fill="#e0f2fe"/>'
    + '<path d="M20 26.4c-6 0-10.9 3-10.9 6.6 0 1.6 1 2.5 2.5 2.5h16.8c1.5 0 2.5-.9 2.5-2.5 0-3.6-4.9-6.6-10.9-6.6Z"'
    + ' fill="#bae6fd"/>'
    + '<path d="M16.7 26.9 20 30.3l3.3-3.4" fill="none" stroke="#e0f2fe" stroke-width="1.1"'
    + ' stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** Mount the circular portrait avatar: the gender reads as a portrait, never as a word. */
function paintPortrait(host: HTMLElement, gender: Gender): void {
  host.className = `crowd-av is-${gender}`;
  /* A trusted constant, never host or user text. */
  host.innerHTML = PORTRAIT[gender];
}

/* ---------- the live simulation ---------- */
let match: MatchCrowd | null = null;
let filter: Filter = 'all';
let toastTimer = 0;
let kickoffShowTimer = 0;
let kickoffHideTimer = 0;
let ambientTimer = 0;
let lastReactionAt = -Infinity;
let lastFocus: HTMLElement | null = null;

const REACTION_GAP_MS = 4000;
/* Generous read time: a reaction sits at the top of the arena for 3.8s, and the gap above is wider
   than the pill's own life so a second reaction never cuts the first one short mid-sentence. */
const TOAST_MS = 3800;
/* The kickoff banner lands once the board is actually on screen, then clears itself after 4.5s. */
const KICKOFF_DELAY_MS = 350;
const KICKOFF_MS = 4500;
/* The house never stands still: one pledge or one seat moves on this beat. */
const AMBIENT_MS = 2000;

/* The house band. A match rolls its own head count inside it; joins and leaves stay inside it. */
const MIN_SEATS = 7;
const MAX_SEATS = 58;

function makeFan(handle: string, gender: Gender, camp: Camp, teamMode: boolean): Fan {
  return {
    handle,
    gender,
    camp,
    sideKey: teamMode ? (camp === 0 ? 'A' : 'B') : (camp === 0 ? 'p1' : 'p2'),
    stake: STAKES[pickIndex(STAKES.length)]!,
    decided: rnd() < 0.58,
    bandwagon: false,
  };
}

const campCounts = (fans: readonly Fan[]): [number, number] => {
  let a = 0;
  for (const f of fans) if (f.camp === 0) a++;
  return [a, fans.length - a];
};

const campStakes = (fans: readonly Fan[]): [number, number] => {
  let a = 0;
  for (const f of fans) if (f.camp === 0) a += f.stake;
  return [a, fans.reduce((sum, f) => sum + f.stake, 0) - a];
};

/** The camp the simulation currently reads as ahead, by head count. Used when the board is level. */
function leadingCamp(): Camp {
  if (!match) return 0;
  const [a, b] = campCounts(match.fans);
  if (a === b) return rnd() < 0.5 ? 0 : 1;
  return a > b ? 0 : 1;
}

/* ---------- DOM references (resolved once, never trusted blindly) ---------- */
interface CrowdUi {
  pill: HTMLButtonElement;
  count: HTMLElement;
  live: HTMLElement;
  bar: HTMLButtonElement;
  title: HTMLElement;
  redName: HTMLElement;
  blueName: HTMLElement;
  redPct: HTMLElement;
  bluePct: HTMLElement;
  redStake: HTMLElement;
  blueStake: HTMLElement;
  redFill: HTMLElement;
  blueFill: HTMLElement;
  toast: HTMLElement;
  /** the brief kickoff banner: how many fans backed seat 1 */
  kickoff: HTMLElement;
  sheet: HTMLElement;
  sheetTitle: HTMLElement;
  sheetLive: HTMLElement;
  sheetCount: HTMLElement;
  sheetViewers: HTMLElement;
  list: HTMLElement;
  empty: HTMLElement;
  closeBtn: HTMLButtonElement;
  scrim: HTMLElement;
  h2hRedName: HTMLElement;
  h2hBlueName: HTMLElement;
  h2hRedFans: HTMLElement;
  h2hBlueFans: HTMLElement;
  h2hRedStake: HTMLElement;
  h2hBlueStake: HTMLElement;
  h2hRedFill: HTMLElement;
  h2hBlueFill: HTMLElement;
  filters: HTMLButtonElement[];
}

let ui: CrowdUi | null = null;

const byId = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function resolveUi(): CrowdUi | null {
  if (ui) return ui;
  /* The static Star images in index.html carry no src: point them at the bundled asset first. */
  hydrateStars();
  const pill = byId<HTMLButtonElement>('crowd-pill');
  const count = byId('crowd-count');
  const live = byId('crowd-live');
  const bar = byId<HTMLButtonElement>('crowd-bar');
  const title = byId('crowd-bar-title');
  const redName = byId('crowd-bar-red-name');
  const blueName = byId('crowd-bar-blue-name');
  const redPct = byId('crowd-pct-red');
  const bluePct = byId('crowd-pct-blue');
  const redStake = byId('crowd-stake-red');
  const blueStake = byId('crowd-stake-blue');
  const redFill = byId('crowd-fill-red');
  const blueFill = byId('crowd-fill-blue');
  const toast = byId('crowd-toast');
  const kickoff = byId('crowd-kickoff');
  const sheet = byId('crowd-sheet');
  const sheetTitle = byId('crowd-sheet-title');
  const sheetLive = byId('crowd-sheet-live');
  const sheetCount = byId('crowd-sheet-count');
  const sheetViewers = byId('crowd-sheet-viewers');
  const list = byId('crowd-list');
  const empty = byId('crowd-empty');
  const closeBtn = byId<HTMLButtonElement>('crowd-sheet-close');
  const scrim = byId('crowd-sheet-scrim');
  const h2hRedName = byId('crowd-h2h-red-name');
  const h2hBlueName = byId('crowd-h2h-blue-name');
  const h2hRedFans = byId('crowd-h2h-red-fans');
  const h2hBlueFans = byId('crowd-h2h-blue-fans');
  const h2hRedStake = byId('crowd-h2h-red-stake');
  const h2hBlueStake = byId('crowd-h2h-blue-stake');
  const h2hRedFill = byId('crowd-h2h-fill-red');
  const h2hBlueFill = byId('crowd-h2h-fill-blue');
  const filterAll = byId<HTMLButtonElement>('crowd-filter-all');
  const filterP1 = byId<HTMLButtonElement>('crowd-filter-p1');
  const filterP2 = byId<HTMLButtonElement>('crowd-filter-p2');
  /* The screen can be booted without this chrome (headless probes, a host that strips it):
     no refs means no painting, and every hook below is a no-op instead of a throw. */
  if (!pill || !count || !live || !bar || !title || !redName || !blueName || !redPct || !bluePct
    || !redStake || !blueStake || !redFill || !blueFill || !toast || !kickoff || !sheet
    || !sheetTitle || !sheetLive || !sheetCount || !sheetViewers || !list || !empty || !closeBtn
    || !scrim || !h2hRedName || !h2hBlueName || !h2hRedFans || !h2hBlueFans || !h2hRedStake
    || !h2hBlueStake || !h2hRedFill || !h2hBlueFill || !filterAll || !filterP1 || !filterP2) {
    return null;
  }
  ui = {
    pill, count, live, bar, title, redName, blueName, redPct, bluePct, redStake, blueStake,
    redFill, blueFill, toast, kickoff, sheet, sheetTitle, sheetLive, sheetCount, sheetViewers,
    list, empty, closeBtn, scrim, h2hRedName, h2hBlueName, h2hRedFans, h2hBlueFans, h2hRedStake,
    h2hBlueStake, h2hRedFill, h2hBlueFill, filters: [filterAll, filterP1, filterP2],
  };
  wire(ui);
  return ui;
}

/** A `<bdi>` that carries a label without ever joining the surrounding bidi run. */
function bdiNode(text: string, dir: 'ltr' | 'auto', className?: string): HTMLElement {
  const el = document.createElement('bdi');
  el.dir = dir;
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

/* ---------- painting ---------- */
/** Label the three filter keys: the mixed house, then the two betting camps. */
function paintFilterLabels(): void {
  if (!ui) return;
  const c = copy();
  ui.filters[0]!.replaceChildren(bdiNode(c.all, 'auto'));
  ui.filters[1]!.replaceChildren(bdiNode(c.winTag, 'auto'));
  ui.filters[2]!.replaceChildren(bdiNode(c.loseTag, 'auto'));
  ui.filters[0]!.setAttribute('aria-label', c.all);
  ui.filters[1]!.setAttribute('aria-label', c.winHead);
  ui.filters[2]!.setAttribute('aria-label', c.loseHead);
}

function paintBar(): void {
  if (!match || !ui) return;
  const c = copy();
  const [ca, cb] = campCounts(match.fans);
  const total = Math.max(1, ca + cb);
  const pctA = Math.round((ca / total) * 100);
  const pctB = 100 - pctA;
  const [sa, sb] = campStakes(match.fans);

  ui.redName.textContent = c.winTag;
  ui.blueName.textContent = c.loseTag;
  ui.redPct.textContent = `${pctA}%`;
  ui.bluePct.textContent = `${pctB}%`;
  ui.redStake.textContent = formatNum(sa);
  ui.blueStake.textContent = formatNum(sb);
  /* Keep 6% of the rail alive for a swept side, and let the leader stop at 94%: the two widths
     always sum to 100, so the meter can never paint a third of a pixel of background. */
  const wide = Math.min(94, Math.max(6, pctA));
  ui.redFill.style.width = `${wide}%`;
  ui.blueFill.style.width = `${100 - wide}%`;
  ui.count.textContent = formatNum(ca + cb);
  ui.live.textContent = c.live;

  /* The card's centre call is the dominant camp, updated on every single beat. */
  const dominant: Camp = ca >= cb ? 0 : 1;
  const call = dominant === 0 ? c.winCall : c.loseCall;
  const dominantPct = dominant === 0 ? pctA : pctB;
  ui.title.replaceChildren(templateNodes(call, { p: `${dominantPct}%` }, ['p']));

  ui.pill.setAttribute('aria-label', c.title);
  ui.pill.title = c.title;
  const summary = `${c.winHead} ${pctA}% · ${c.loseHead} ${pctB}%`;
  ui.bar.setAttribute('aria-label', summary);
  ui.bar.title = summary;

  if (!ui.sheet.hidden) renderSheet();
}

/** Repaint everything the pill and the card own. Cheap: two small loops over ≤58 records. */
function paint(): void {
  paintBar();
}

/** One spectator card: portrait | handle + bet badge | Star stake. */
function fanRow(fan: Fan): HTMLLIElement {
  const c = copy();
  const li = document.createElement('li');
  li.className = `crowd-row is-${fan.gender}`;

  /* column 1 — the circular portrait silhouette, the only place gender is rendered */
  const av = document.createElement('span');
  av.setAttribute('aria-hidden', 'true');
  paintPortrait(av, fan.gender);

  /* column 2 — handle (+ VIP), then the side they actually bet on */
  const mid = document.createElement('span');
  mid.className = 'crowd-mid';

  const top = document.createElement('span');
  top.className = 'crowd-mid-top';
  top.append(bdiNode(fan.handle, 'ltr', 'crowd-handle'));
  if (fan.stake >= 500) {
    const vip = document.createElement('span');
    vip.className = 'crowd-vip';
    vip.textContent = 'VIP';
    vip.setAttribute('aria-hidden', 'true');
    top.append(vip);
  }

  const bet = document.createElement('span');
  bet.className = `crowd-bet ${fan.camp === 0 ? 'is-red' : 'is-blue'}`;
  bet.dir = 'auto';
  bet.textContent = fan.camp === 0 ? c.betWin : c.betLose;

  mid.append(top, bet);

  /* column 3 — the staked Telegram Stars */
  const stake = document.createElement('span');
  stake.className = 'crowd-stake';
  stake.append(starIcon(), bdiNode(formatNum(fan.stake), 'ltr'));

  li.append(av, mid, stake);
  return li;
}

function renderSheet(): void {
  if (!match || !ui) return;
  const c = copy();
  const [ca, cb] = campCounts(match.fans);
  const total = ca + cb;
  const [sa, sb] = campStakes(match.fans);

  ui.sheetTitle.textContent = c.title;
  ui.sheetLive.textContent = c.live;
  ui.sheetCount.textContent = formatNum(total);
  ui.sheetViewers.setAttribute('aria-label', c.viewers.replace('{n}', formatNum(total)));
  ui.closeBtn.setAttribute('aria-label', c.close);

  /* the head-to-head summary: both betting camps, their head counts and their staked Stars */
  ui.h2hRedName.textContent = c.winTag;
  ui.h2hBlueName.textContent = c.loseTag;
  ui.h2hRedFans.textContent = formatNum(ca);
  ui.h2hBlueFans.textContent = formatNum(cb);
  ui.h2hRedStake.textContent = formatNum(sa);
  ui.h2hBlueStake.textContent = formatNum(sb);
  const wide = Math.min(94, Math.max(6, Math.round((ca / Math.max(1, total)) * 100)));
  ui.h2hRedFill.style.width = `${wide}%`;
  ui.h2hBlueFill.style.width = `${100 - wide}%`;

  /* the filter row, labelled with the two betting camps */
  paintFilterLabels();

  const list = ui.list;
  /* A live event re-renders the board under the reader: keep their place in the list. */
  const keepScroll = list.scrollTop;
  const shown = filter === 'all' ? match.fans : match.fans.filter((f) => f.camp === filter);
  const frag = document.createDocumentFragment();
  for (const fan of shown) frag.append(fanRow(fan));
  list.replaceChildren(frag);
  list.setAttribute('aria-label', c.spectators);
  list.hidden = shown.length === 0;
  ui.empty.hidden = shown.length > 0;
  ui.empty.textContent = c.filters;
  list.scrollTop = keepScroll;
}

/* ---------- the sheet ---------- */
function applyFilter(next: Filter): void {
  if (filter === next) return;
  filter = next;
  if (ui) {
    for (const btn of ui.filters) {
      const on = btn.dataset['crowdFilter'] === String(next);
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  if (match && ui && !ui.sheet.hidden) {
    renderSheet();
    /* a different filter is a different list: start it at the top */
    ui.list.scrollTop = 0;
  }
}

function openSheet(): void {
  if (!match) return;
  const refs = resolveUi();
  if (!refs || !refs.sheet.hidden) return;
  lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  renderSheet();
  refs.sheet.hidden = false;
  refs.pill.setAttribute('aria-expanded', 'true');
  refs.bar.setAttribute('aria-expanded', 'true');
  refs.closeBtn.focus({ preventScroll: true });
  document.addEventListener('keydown', onSheetKey, true);
}

function closeSheet(restoreFocus = true): void {
  const refs = ui;
  if (!refs || refs.sheet.hidden) return;
  refs.sheet.hidden = true;
  refs.pill.setAttribute('aria-expanded', 'false');
  refs.bar.setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', onSheetKey, true);
  if (restoreFocus && lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}

function onSheetKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  /* The sheet is the topmost surface: Escape closes it and is not also read as "open pause". */
  e.stopPropagation();
  closeSheet();
}

/** One-time listeners: the two triggers, the close key, the scrim, the filters, the language. */
let wired = false;
function wire(refs: CrowdUi): void {
  if (wired) return;
  wired = true;
  refs.pill.addEventListener('click', openSheet);
  refs.bar.addEventListener('click', openSheet);
  refs.closeBtn.addEventListener('click', () => closeSheet());
  refs.scrim.addEventListener('click', () => closeSheet());
  for (const btn of refs.filters) {
    btn.addEventListener('click', () => {
      const raw = btn.dataset['crowdFilter'] ?? 'all';
      applyFilter(raw === '0' ? 0 : raw === '1' ? 1 : 'all');
    });
  }
  /* A language flip repaints the labels in place; the simulation itself is language-neutral. */
  onLang(() => {
    if (!match) return;
    paint();
    if (!ui?.sheet.hidden) renderSheet();
    /* A toast on screen belongs to the previous language: take it down rather than mix tongues. */
    hideToast();
    /* The kickoff banner is copy, not state: redraw it in the new language while it is up. */
    if (ui?.kickoff.classList.contains('is-on')) showKickoff();
  });
}

/* ---------- the reaction pill ----------
 * There is exactly one. It lives in the top-arena banner slot (see `.crowd-toasts` in style.css),
 * directly under the top match bar: the player's primary line of sight, and pointer-transparent so
 * it can never steal a board tap. A second reaction retargets this element instead of stacking. */
function hideToast(): void {
  window.clearTimeout(toastTimer);
  toastTimer = 0;
  if (ui) ui.toast.classList.remove('is-on');
}

function showToast(
  fan: Fan,
  template: string,
  vars: Record<string, string> = {},
  nameKeys: readonly string[] = [],
  starValue?: number,
): void {
  const refs = resolveUi();
  if (!refs) return;
  window.clearTimeout(toastTimer);
  const frag = document.createDocumentFragment();
  const name = document.createElement('bdi');
  name.dir = 'auto';
  name.className = 'crowd-toast-name';
  name.textContent = fan.handle;
  frag.append(name, ': ');
  if (starValue !== undefined) {
    const badge = document.createElement('span');
    badge.className = 'crowd-toast-stake';
    badge.append(starIcon(), bdiNode(formatNum(starValue), 'ltr'));
    frag.append(badge, ' ');
  }
  const text = document.createElement('span');
  text.className = 'crowd-toast-txt';
  text.append(templateNodes(template, vars, ['n'], nameKeys));
  frag.append(text);
  refs.toast.replaceChildren(frag);
  refs.toast.classList.add('is-on');
  toastTimer = window.setTimeout(() => {
    refs.toast.classList.remove('is-on');
    toastTimer = 0;
  }, TOAST_MS);
}

/* ---------- the kickoff banner ----------
 * One announcement per match, right as the board settles: how many of this house backed seat 1.
 * It is pointer-transparent, it never opens anything, and it takes itself down after 4.5s — long
 * enough to read both figures and the side they were staked on without hurrying. */
function clearKickoff(): void {
  window.clearTimeout(kickoffShowTimer);
  window.clearTimeout(kickoffHideTimer);
  kickoffShowTimer = 0;
  kickoffHideTimer = 0;
  if (ui) ui.kickoff.classList.remove('is-on');
}

function showKickoff(): void {
  const refs = ui;
  if (!refs || !match) return;
  const c = copy();
  const [ca, cb] = campCounts(match.fans);
  const [sa, sb] = campStakes(match.fans);
  /* Announce the camp the room is actually on at kickoff, with both its head count and its Stars. */
  const dominant: Camp = ca >= cb ? 0 : 1;
  const n = dominant === 0 ? ca : cb;
  const s = dominant === 0 ? sa : sb;
  const icon = document.createElement('span');
  icon.className = 'crowd-kickoff-ico';
  icon.setAttribute('aria-hidden', 'true');
  icon.append(starIcon());
  const text = document.createElement('span');
  text.className = 'crowd-kickoff-txt';
  text.append(templateNodes(
    dominant === 0 ? c.kickoffWin : c.kickoffLose,
    { n: formatNum(n), s: formatNum(s) },
    ['n', 's'],
  ));
  refs.kickoff.replaceChildren(icon, text);
  refs.kickoff.classList.add('is-on');
}

/** Arm the kickoff banner: a short settle delay (the board must be visible first), then 4.5s on. */
function scheduleKickoff(): void {
  clearKickoff();
  kickoffShowTimer = window.setTimeout(() => {
    kickoffShowTimer = 0;
    showKickoff();
    kickoffHideTimer = window.setTimeout(() => {
      kickoffHideTimer = 0;
      if (ui) ui.kickoff.classList.remove('is-on');
    }, KICKOFF_MS);
  }, KICKOFF_DELAY_MS);
}

/* ---------- the ambient tick ----------
 * The house breathes even while both players think: one pledge or one seat moves every 3.5s.
 * Cleared by `closeCrowd()`, so no timer ever outlives its match. */
function startAmbient(): void {
  stopAmbient();
  ambientTimer = window.setInterval(ambientTick, AMBIENT_MS);
}

function stopAmbient(): void {
  window.clearInterval(ambientTimer);
  ambientTimer = 0;
}

function ambientTick(): void {
  if (!match) {
    stopAmbient();
    return;
  }
  const roll = rnd();
  if (roll < 0.5) {
    /* two or three fans switch sides — a clearly visible head-count move every beat */
    liveShift(null, 3);
    return;
  }
  if (roll < 0.82) {
    if (!bumpPledge()) liveShift(null, 1);
    return;
  }
  driftCount();
}

/* ---------- the simulation ---------- */
/**
 * Flip up to `max` fans to `target`, preferring the undecided and the ones who already wandered
 * once, then filling from the camp's settled regulars. Never empties a camp: a filter that can
 * only ever show an empty board is a broken filter. Returns the first fan who switched, so the
 * caller can quote their stake in the reaction line.
 */
function shiftSupport(target: Camp, max: number): Fan | null {
  if (!match) return null;
  const [ca, cb] = campCounts(match.fans);
  const other: Camp = target === 0 ? 1 : 0;
  const movable = Math.max(0, (other === 0 ? ca : cb) - 1);
  const want = Math.min(max, movable);
  if (want <= 0) return null;

  const pool = match.fans.filter((f) => f.camp === other);
  const willing = pool.filter((f) => !f.decided || f.bandwagon);
  const regulars = pool.filter((f) => f.decided && !f.bandwagon);
  const order = [...shuffle(willing), ...shuffle(regulars)];
  let first: Fan | null = null;
  for (let i = 0; i < want; i++) {
    const fan = order[i];
    if (!fan) break;
    fan.camp = target;
    fan.sideKey = match.teamMode ? (target === 0 ? 'A' : 'B') : (target === 0 ? 'p1' : 'p2');
    fan.decided = true;
    fan.bandwagon = true;
    if (!first) first = fan;
  }
  if (first) paint();
  return first;
}

/** One new face in the house, on the side the room is already leaning toward. */
function addFans(count: number): number {
  if (!match) return 0;
  const [ca, cb] = campCounts(match.fans);
  const room = MAX_SEATS - (ca + cb);
  if (room <= 0) return 0;
  const n = Math.min(count, room);
  const camp: Camp = ca === cb ? (rnd() < 0.5 ? 0 : 1) : (ca > cb ? 0 : 1);
  const used = new Set(match.fans.map((f) => f.handle));
  for (let i = 0; i < n; i++) {
    const gender: Gender = rnd() < match.femaleShare ? 'f' : 'm';
    const handle = makeHandle(gender, used);
    used.add(handle);
    match.fans.push(makeFan(handle, gender, camp, match.teamMode));
  }
  return n;
}

/** One fan tops up or trims their pledge: the Star totals move, the head count does not. */
function bumpPledge(): boolean {
  if (!match || match.fans.length === 0) return false;
  const fan = match.fans[pickIndex(match.fans.length)];
  if (!fan) return false;
  const at = STAKES.indexOf(fan.stake);
  const step = rnd() < 0.5 ? -1 : 1;
  const next = STAKES[Math.min(STAKES.length - 1, Math.max(0, at + step))];
  if (next === undefined || next === fan.stake) return false;
  fan.stake = next;
  paint();
  return true;
}

/** The camp a beat should drift toward: the board's leader, weighted by how split the house still
 *  is. Bandwagon pressure fades as one side sweeps the room, so the rail hovers and breathes
 *  instead of ratcheting to its 94/6 clamp and dying there. */
function driftTarget(leader: Camp | null): Camp {
  const lead = leader ?? leadingCamp();
  const [ca, cb] = match ? campCounts(match.fans) : [0, 0];
  const total = ca + cb;
  const imbalance = total > 0 ? Math.abs(ca - cb) / total : 0;
  const p = Math.max(0.16, 0.8 - imbalance * 0.7);
  return rnd() < p ? lead : (lead === 0 ? 1 : 0);
}

/** One beat of crowd movement: 1..`max` fans flip, and on a minority of beats the house itself
 *  changes shape (one or two fresh arrivals, or one spectator calling it a night). The flip count
 *  is capped at ~9% of the house, so a 7-seat room never swings like a 58-seat one. */
function liveShift(leader: Camp | null, max: number): Fan | null {
  if (!match) return null;
  const cap = Math.max(1, Math.min(max, Math.round(match.fans.length * 0.11)));
  const switched = shiftSupport(driftTarget(leader), cap);
  const roll = rnd();
  if (roll < 0.14) {
    addFans(rnd() < 0.35 ? 2 : 1);
    paint();
  } else if (roll < 0.24) {
    driftCount();
  }
  return switched;
}

/** +/- one spectator, quietly, and only inside the believable band. */
function driftCount(): boolean {
  if (!match) return false;
  const [ca, cb] = campCounts(match.fans);
  const total = ca + cb;
  const canAdd = total < MAX_SEATS;
  const canRemove = total > MIN_SEATS && Math.max(ca, cb) > 2;
  if (!canAdd && !canRemove) return false;
  const add = canAdd && (!canRemove || rnd() < 0.55);
  /* arrive on the side the room is already leaning toward, weighted by head count */
  const camp: Camp = ca === cb ? (rnd() < 0.5 ? 0 : 1) : (ca > cb ? 0 : 1);
  if (add) {
    addFans(1);
  } else {
    const idx = match.fans.findIndex((f) => f.camp === camp);
    if (idx < 0) return false;
    match.fans.splice(idx, 1);
  }
  paint();
  return true;
}

/** A strategic play: a wide bandwagon swing first, then (throttled) one localized live reaction.
 *  A wall or a mine moves the room harder than a routine turn or a near-finish tease. */
function bigPlay(type: 'wall' | 'mine' | 'near', leader: Camp | null): void {
  if (!match) return;
  const target = leader ?? leadingCamp();
  const budget = type === 'near' ? 2 : 2 + pickIndex(3); /* wall / mine: 2..4 */
  const switched = liveShift(target, budget);
  const now = performance.now();
  if (now - lastReactionAt < REACTION_GAP_MS) return;
  const c = copy();

  /* A fresh switcher quotes their Stars most of the time; the rest are pure crowd noise.
     The line names the camp the fan actually moved to, which is usually — not always — the
     side the play favours. */
  if (switched && rnd() < 0.6) {
    lastReactionAt = now;
    showToast(
      switched,
      switched.camp === 0 ? c.winHead : c.loseHead,
      {},
      [],
      switched.stake,
    );
    return;
  }
  const pool = type === 'wall' ? c.wall : type === 'mine' ? c.mine : c.near;
  const line = pool[pickIndex(pool.length)] ?? pool[0] ?? '';
  /* Prefer a fan on the leading camp: the reaction belongs to the side the play favors. */
  const fans = match.fans.filter((f) => f.camp === target);
  const fan = fans[pickIndex(fans.length)] ?? match.fans[pickIndex(match.fans.length)];
  if (!fan || !line) return;
  lastReactionAt = now;
  showToast(fan, line, { name: campName(target) }, ['name']);
}

/** Start a fresh audience for the board that is about to be played. */
export function initMatchCrowd(setup: CrowdSetup = {}): void {
  closeCrowd();
  const refs = resolveUi();
  if (!refs) return;

  /* Every metric is re-rolled: head count 7..58, a 30%..70% female mix, a 22%..78% support lean.
     Each fan's side is then an independent weighted roll, never a block transfer, and the finished
     list is shuffled so both camps and both genders interleave across the whole card. */
  const total = MIN_SEATS + pickIndex(MAX_SEATS - MIN_SEATS + 1);
  const redShare = 0.22 + rnd() * 0.56;
  const femaleShare = 0.3 + rnd() * 0.4;
  const teamMode = setup.teamMode === true;

  const used = new Set<string>();
  const fans: Fan[] = [];
  for (let i = 0; i < total; i++) {
    const gender: Gender = rnd() < femaleShare ? 'f' : 'm';
    const handle = makeHandle(gender, used);
    used.add(handle);
    const camp: Camp = rnd() < redShare ? 0 : 1;
    fans.push(makeFan(handle, gender, camp, teamMode));
  }

  /* Keep both camps populated: a filter that can only ever show an empty board is a broken filter. */
  let [ca] = campCounts(fans);
  const need = Math.min(2, Math.floor(total / 2));
  for (let i = 0; i < fans.length && ca < need; i++) {
    const fan = fans[i]!;
    if (fan.camp === 1) {
      fan.camp = 0;
      fan.sideKey = teamMode ? 'A' : 'p1';
      ca++;
    }
  }
  for (let i = 0; i < fans.length && total - ca < need; i++) {
    const fan = fans[i]!;
    if (fan.camp === 0) {
      fan.camp = 1;
      fan.sideKey = teamMode ? 'B' : 'p2';
      ca--;
    }
  }

  shuffle(fans);
  /* …then break any same-gender streak left at the head of the dealt list. */
  interleaveGenders(fans);

  match = {
    fans,
    teamMode,
    femaleShare,
    names: [(setup.p1Name ?? '').trim(), (setup.p2Name ?? '').trim()],
  };
  lastReactionAt = -Infinity;
  filter = 'all';
  paintFilterLabels();
  for (const btn of refs.filters) {
    const on = btn.dataset['crowdFilter'] === 'all';
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  refs.pill.hidden = false;
  refs.bar.hidden = false;
  refs.sheet.hidden = true;
  refs.pill.setAttribute('aria-expanded', 'false');
  refs.bar.setAttribute('aria-expanded', 'false');
  hideToast();
  paint();
  /* The board is on screen from here: announce the house, then keep it breathing. */
  scheduleKickoff();
  startAmbient();
}

/**
 * The one lifecycle hook `main.ts` calls after committed play.
 *
 * `leader` is the camp the board currently favours (0 = crimson, 1 = cyan), or null when the race
 * is level. Every beat moves the room: a wall or a mine swings it hardest, a near-finish teases it,
 * and a routine turn nudges a single fan. The hook never touches the rules.
 */
export function onCrowdEvent(type: CrowdEventType, leader: 0 | 1 | null = null): void {
  if (!match) return;
  switch (type) {
    case 'wall':
      bigPlay('wall', leader);
      break;
    case 'mine':
      bigPlay('mine', leader);
      break;
    case 'near_finish':
      bigPlay('near', leader);
      break;
    case 'turn':
      liveShift(leader, 1);
      break;
    case 'move':
      liveShift(leader, rnd() < 0.5 ? 1 : 2);
      break;
  }
}

/** End the simulation: hide the chrome, close the sheet, drop every timer. Idempotent. */
export function closeCrowd(): void {
  hideToast();
  clearKickoff();
  stopAmbient();
  closeSheet(false);
  match = null;
  filter = 'all';
  lastReactionAt = -Infinity;
  const refs = ui;
  if (!refs) return;
  refs.pill.hidden = true;
  refs.bar.hidden = true;
  refs.list.replaceChildren();
}
