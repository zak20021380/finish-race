/**
 * SIMULATED LIVE CROWD — in-match atmosphere, client-side only.
 *
 * This module is deliberately isolated from the economy, the rules and the wire. It never reads or
 * writes coins, Stars, TIQ or a match outcome; it never sends an action; it owns no server state.
 * It invents a believable audience for the board on screen, lets a few of those fans drift toward
 * whoever is ahead, and paints a live-viewers pill plus a crowd-odds card above the board, both of
 * which open one tappable sheet. Every label names the SEATS actually playing (`p1Name` / `p2Name`
 * from the host): a 1v1 reads as the two players, a 2v2 as the two duo labels.
 *
 * The audience itself is combinatorial, not a hardcoded roster: ~18 gender-tagged roots per gender
 * plus a tail table synthesise thousands of handles, so a 58-seat house never repeats a name. Every
 * metric that can be random is re-rolled per match — head count (7..58), the female/male mix, the
 * support split, each fan's side roll, the list order (Fisher–Yates) and the simulated stake.
 *
 * Design constraints that are part of the contract:
 *   · no `backdrop-filter`, no looping `@keyframes` — the arena's compositor belongs to the canvas;
 *   · at most ONE floating reaction pill exists at any moment (a second reaction retargets it);
 *   · every rendered number is Latin `0-9` inside a `<bdi dir="ltr">`, so RTL never mirrors a score;
 *   · every name is isolated in a `<bdi dir="auto">`, so a handle never reorders its sentence;
 *   · icons are inline SVG, never emoji.
 *
 * The DOM is static (`index.html`, inside `#s-game`); this module only reads it by id, fills it and
 * hides it when the match ends. `initMatchCrowd()` starts a fresh simulation, `onCrowdEvent()` is
 * the lifecycle hook `main.ts` calls after committed play, and `closeCrowd()` tears everything down.
 */
import { lang, onLang, type LangCode } from './settings';
import { mountCoins } from './coin';

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
  /** simulated fan coins, purely narrative */
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

/** Simulated stakes. Wide enough that the house reads as a crowd, never as one price point. */
const STAKES: readonly number[] = [
  25, 50, 75, 100, 150, 200, 250, 350, 500, 750, 1000, 1500,
];

/* ---------- copy ----------
 * Five locales, the same five the shell ships. Each template marks its numbers as `{n}` so the
 * renderer can isolate them in a `<bdi>`; `{a}` / `{b}` are the two camp totals in the sheet. */
interface CrowdCopy {
  title: string;
  viewers: string;
  split: string;
  close: string;
  /** the card's centre micro-title: what the meter actually measures */
  odds: string;
  /** the pill's small live tag */
  live: string;
  /** the sheet's filter row */
  all: string;
  filters: string;
  spectators: string;
  /** fallbacks when the host hands the crowd no seat name */
  p1: string;
  p2: string;
  /** a spectator row's own caption: `Backing {name}` */
  fan: string;
  wall: string[];
  mine: string[];
  near: string[];
  /** a fan's stake landing on a named side */
  back: string;
}

const COPY: Record<LangCode, CrowdCopy> = {
  en: {
    title: 'Live crowd & predictions',
    viewers: '{n} live spectators',
    split: '{a} backing {p1} · {b} backing {p2}',
    close: 'Close',
    odds: 'Crowd odds',
    live: 'LIVE',
    all: 'All',
    filters: 'Filter spectators',
    spectators: 'Spectators',
    p1: 'Player 1', p2: 'Player 2',
    fan: 'Backing {name}',
    wall: ['Clutch wall by {name}!', 'That wall shut {name} down!', 'Smart block — no way through for {name}!'],
    mine: ['Boom — right on {name}!', 'The mine caught {name}!', 'That trap was brutal on {name}!'],
    near: ['{name} is one step from FINISH!', 'So close for {name}!', "Don't blink — {name} is on the final stretch!"],
    back: '+{n} backing {name}!',
  },
  fa: {
    title: 'تماشاگران و پیش‌بینی‌ها',
    viewers: '{n} تماشاگر زنده',
    split: '{a} حمایت از {p1} · {b} حمایت از {p2}',
    close: 'بستن',
    odds: 'پیش‌بینی سکوها',
    live: 'زنده',
    all: 'همه',
    filters: 'فیلتر تماشاگران',
    spectators: 'تماشاگران',
    p1: 'بازیکن 1', p2: 'بازیکن 2',
    fan: 'حمایت از {name}',
    wall: ['عجب دیواری برای {name} بست!', 'این دیوار مسیر {name} رو بست!', 'دفاع حساب‌شده روی {name}!'],
    mine: ['مین کار خودش رو کرد روی {name}!', 'ترکید — مستقیم روی {name}!', 'این تله برای {name} بی‌رحمانه بود!'],
    near: ['{name} فقط دو قدم تا خط پایان!', '{name} خیلی نزدیک شد!', 'نفس‌ها برای {name} حبس شد!'],
    back: '+{n} روی {name}!',
  },
  ru: {
    title: 'Живая трибуна и прогнозы',
    viewers: '{n} зрителей онлайн',
    split: '{a} за {p1} · {b} за {p2}',
    close: 'Закрыть',
    odds: 'Прогноз трибун',
    live: 'ЭФИР',
    all: 'Все',
    filters: 'Фильтр зрителей',
    spectators: 'Зрители',
    p1: 'Игрок 1', p2: 'Игрок 2',
    fan: 'За {name}',
    wall: ['Отличный блок от {name}!', 'Эта стена остановила {name}!', 'Умная защита — {name} не пройдёт!'],
    mine: ['Мина сработала — {name} попался!', 'Бум — прямо по {name}!', 'Жёсткая ловушка для {name}!'],
    near: ['{name} в одном шаге от ФИНИША!', 'Совсем рядом для {name}!', 'Не моргай — {name} на финишной прямой!'],
    back: '+{n} за {name}!',
  },
  ar: {
    title: 'الجمهور المباشر والتوقعات',
    viewers: '{n} مشاهد مباشر',
    split: '{a} يدعم {p1} · {b} يدعم {p2}',
    close: 'إغلاق',
    odds: 'توقع الجمهور',
    live: 'مباشر',
    all: 'الكل',
    filters: 'تصفية الجمهور',
    spectators: 'الجمهور',
    p1: 'اللاعب 1', p2: 'اللاعب 2',
    fan: 'دعم {name}',
    wall: ['سدٌّ حاسم من {name}!', 'هذا السد أوقف {name}!', 'دفاع ذكي — لا مرور لـ {name}!'],
    mine: ['اللغم انفجر — {name} في الفخ!', 'بووم — مباشرة على {name}!', 'فخ قاسٍ لـ {name}!'],
    near: ['{name} على خطوة من النهاية!', 'قريب جداً لـ {name}!', 'لا ترمش — {name} في اللفة الأخيرة!'],
    back: '+{n} على {name}!',
  },
  es: {
    title: 'Público en vivo y pronósticos',
    viewers: '{n} espectadores en vivo',
    split: '{a} con {p1} · {b} con {p2}',
    close: 'Cerrar',
    odds: 'Cuotas del público',
    live: 'EN VIVO',
    all: 'Todos',
    filters: 'Filtrar espectadores',
    spectators: 'Espectadores',
    p1: 'Jugador 1', p2: 'Jugador 2',
    fan: 'A por {name}',
    wall: ['¡Muro decisivo de {name}!', '¡Ese muro frenó a {name}!', '¡Bloqueo inteligente — {name} no pasa!'],
    mine: ['¡La mina atrapó a {name}!', '¡Bum — directo a {name}!', '¡Vaya trampa para {name}!'],
    near: ['¡{name} a un paso de la META!', '¡Muy cerca para {name}!', '¡No parpadees — {name} en la recta final!'],
    back: '¡+{n} a por {name}!',
  },
};

const copy = (): CrowdCopy => COPY[lang] ?? COPY.en;

/* ---------- badge identity ---------- */
const initialOf = (name: string): string => Array.from(name)[0] ?? '?';

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

/* ---------- the two crisp gender marks ----------
 * Fixed inline vector paths: a Venus ring-and-cross and a Mars arrow-and-ring. No emoji, no font
 * dependency, no external asset — they inherit `currentColor` from their badge. */
const GENDER_ICON: Record<Gender, string> = {
  f: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
    + '<circle cx="8" cy="6" r="4.1" fill="none" stroke="currentColor" stroke-width="1.5"/>'
    + '<path d="M8 10.1v4.4M5.9 12.4h4.2" fill="none" stroke="currentColor" stroke-width="1.5"'
    + ' stroke-linecap="round"/></svg>',
  m: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
    + '<circle cx="6.6" cy="9.4" r="4.1" fill="none" stroke="currentColor" stroke-width="1.5"/>'
    + '<path d="M9.6 6.4 13.8 2.2M10.4 2.2h3.4v3.4" fill="none" stroke="currentColor" stroke-width="1.5"'
    + ' stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** Mount a gender badge (15×15 dark disc) into `host`. */
function paintGenderBadge(host: HTMLElement, gender: Gender): void {
  host.className = `crowd-gbadge is-${gender}`;
  /* A trusted constant, never host or user text: the only innerHTML in this module. */
  host.innerHTML = GENDER_ICON[gender];
}

/* ---------- the live simulation ---------- */
let match: MatchCrowd | null = null;
let filter: Filter = 'all';
let toastTimer = 0;
let lastReactionAt = -Infinity;
let lastFocus: HTMLElement | null = null;

const REACTION_GAP_MS = 3400;
const TOAST_MS = 2600;

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
    || !redStake || !blueStake || !redFill || !blueFill || !toast || !sheet || !sheetTitle
    || !sheetLive || !sheetCount || !sheetViewers || !list || !empty || !closeBtn || !scrim
    || !h2hRedName || !h2hBlueName || !h2hRedFans || !h2hBlueFans || !h2hRedStake || !h2hBlueStake
    || !h2hRedFill || !h2hBlueFill || !filterAll || !filterP1 || !filterP2) {
    return null;
  }
  ui = {
    pill, count, live, bar, title, redName, blueName, redPct, bluePct, redStake, blueStake,
    redFill, blueFill, toast, sheet, sheetTitle, sheetLive, sheetCount, sheetViewers, list, empty,
    closeBtn, scrim, h2hRedName, h2hBlueName, h2hRedFans, h2hBlueFans, h2hRedStake, h2hBlueStake,
    h2hRedFill, h2hBlueFill, filters: [filterAll, filterP1, filterP2],
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
/** Label the three filter keys with this board's own seat names. */
function paintFilterLabels(): void {
  if (!ui) return;
  const c = copy();
  ui.filters[0]!.replaceChildren(bdiNode(c.all, 'auto'));
  ui.filters[1]!.replaceChildren(bdiNode(campName(0), 'auto'));
  ui.filters[2]!.replaceChildren(bdiNode(campName(1), 'auto'));
  ui.filters[0]!.setAttribute('aria-label', c.all);
  ui.filters[1]!.setAttribute('aria-label', campName(0));
  ui.filters[2]!.setAttribute('aria-label', campName(1));
}

function paintBar(): void {
  if (!match || !ui) return;
  const c = copy();
  const [ca, cb] = campCounts(match.fans);
  const total = Math.max(1, ca + cb);
  const pctA = Math.round((ca / total) * 100);
  const pctB = 100 - pctA;
  const [sa, sb] = campStakes(match.fans);

  ui.redName.textContent = campName(0);
  ui.blueName.textContent = campName(1);
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
  ui.title.textContent = c.odds;
  ui.live.textContent = c.live;

  ui.pill.setAttribute('aria-label', c.title);
  ui.pill.title = c.title;
  const summary = `${c.odds}: ${campName(0)} ${pctA}% · ${campName(1)} ${pctB}%`;
  ui.bar.setAttribute('aria-label', summary);
  ui.bar.title = summary;

  if (!ui.sheet.hidden) renderSheet();
}

/** Repaint everything the pill and the card own. Cheap: two small loops over ≤58 records. */
function paint(): void {
  paintBar();
}

/** One spectator card: avatar + gender badge | identity stack | stake pill. */
function fanRow(fan: Fan): HTMLLIElement {
  const c = copy();
  const li = document.createElement('li');
  li.className = `crowd-row is-${fan.gender}`;

  /* column 1 — 36×36 avatar with its corner gender badge */
  const av = document.createElement('span');
  av.className = `crowd-av is-${fan.gender}`;
  av.setAttribute('aria-hidden', 'true');
  const ini = document.createElement('span');
  ini.className = 'crowd-av-ini';
  ini.textContent = initialOf(fan.handle);
  const badge = document.createElement('span');
  paintGenderBadge(badge, fan.gender);
  av.append(ini, badge);

  /* column 2 — handle + gender pill + VIP, then the side they back */
  const mid = document.createElement('span');
  mid.className = 'crowd-mid';

  const top = document.createElement('span');
  top.className = 'crowd-mid-top';
  top.append(bdiNode(fan.handle, 'ltr', 'crowd-handle'));
  const gPill = document.createElement('span');
  gPill.className = `crowd-gpill is-${fan.gender}`;
  gPill.textContent = fan.gender === 'f' ? '♀' : '♂';
  gPill.setAttribute('aria-hidden', 'true');
  top.append(gPill);
  if (fan.stake >= 500) {
    const vip = document.createElement('span');
    vip.className = 'crowd-vip';
    vip.textContent = 'VIP';
    vip.setAttribute('aria-hidden', 'true');
    top.append(vip);
  }

  const support = document.createElement('span');
  support.className = `crowd-support ${fan.camp === 0 ? 'is-red' : 'is-blue'}`;
  support.append(templateNodes(c.fan, { name: campName(fan.camp) }, [], ['name']));

  mid.append(top, support);

  /* column 3 — the staked coins */
  const stake = document.createElement('span');
  stake.className = 'crowd-stake';
  const coin = document.createElement('span');
  coin.className = 'coin';
  coin.setAttribute('data-coin', '');
  coin.setAttribute('aria-hidden', 'true');
  stake.append(coin, bdiNode(formatNum(fan.stake), 'ltr'));

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

  /* the head-to-head summary: both seat names, their head counts and their staked totals */
  ui.h2hRedName.textContent = campName(0);
  ui.h2hBlueName.textContent = campName(1);
  ui.h2hRedFans.textContent = formatNum(ca);
  ui.h2hBlueFans.textContent = formatNum(cb);
  ui.h2hRedStake.textContent = formatNum(sa);
  ui.h2hBlueStake.textContent = formatNum(sb);
  const wide = Math.min(94, Math.max(6, Math.round((ca / Math.max(1, total)) * 100)));
  ui.h2hRedFill.style.width = `${wide}%`;
  ui.h2hBlueFill.style.width = `${100 - wide}%`;

  /* the filter row, labelled with this board's own seat names */
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
  mountCoins(list);
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
  mountCoins(refs.sheet);
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
  });
}

/* ---------- the reaction pill ----------
 * There is exactly one. A second reaction retargets this element instead of stacking another. */
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

/* ---------- the simulation ---------- */
/**
 * Move a little undecided (or already-wandering) support toward `leader`. Returns the first fan who
 * switched, so the caller can quote their stake in the reaction line.
 */
function shiftSupport(leader: Camp, max: number): Fan | null {
  if (!match) return null;
  const undecided = match.fans.filter((f) => !f.decided && f.camp !== leader);
  const wandering = match.fans.filter((f) => f.bandwagon && f.camp !== leader);
  const pool = [...undecided, ...shuffle(wandering)];
  let first: Fan | null = null;
  for (let i = 0; i < Math.min(max, pool.length); i++) {
    const fan = pool[i]!;
    fan.camp = leader;
    fan.decided = true;
    fan.bandwagon = true;
    if (!first) first = fan;
  }
  if (first) paint();
  return first;
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
    const used = new Set(match.fans.map((f) => f.handle));
    const gender: Gender = rnd() < match.femaleShare ? 'f' : 'm';
    match.fans.push(makeFan(makeHandle(gender, used), gender, camp, match.teamMode));
  } else {
    const idx = match.fans.findIndex((f) => f.camp === camp);
    if (idx < 0) return false;
    match.fans.splice(idx, 1);
  }
  paint();
  return true;
}

/** A strategic play: bandwagon movement first, then (throttled) one localized live reaction. */
function bigPlay(type: 'wall' | 'mine' | 'near', leader: Camp | null): void {
  if (!match) return;
  const target = leader ?? leadingCamp();
  const switched = shiftSupport(target, type === 'wall' ? 1 : rnd() < 0.5 ? 1 : 2);
  const now = performance.now();
  if (now - lastReactionAt < REACTION_GAP_MS) return;
  const c = copy();

  /* A fresh switcher quotes their stake about half the time; the rest are pure crowd noise. */
  if (switched && rnd() < 0.5) {
    lastReactionAt = now;
    showToast(switched, c.back, { n: formatNum(switched.stake), name: campName(target) }, ['name']);
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
}

/**
 * The one lifecycle hook `main.ts` calls after committed play.
 *
 * `leader` is the camp the board currently favours (0 = crimson, 1 = cyan), or null when the race
 * is level. The hook never touches the rules: it only moves simulated fans and paints the pill.
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
      if (rnd() < 0.1) driftCount();
      break;
    case 'move':
      if (rnd() < 0.06) driftCount();
      break;
  }
}

/** End the simulation: hide the chrome, close the sheet, drop every timer. Idempotent. */
export function closeCrowd(): void {
  hideToast();
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
