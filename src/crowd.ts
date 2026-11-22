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

interface Fan {
  name: string;
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
  /** The two sides' own names, in camp order. An empty slot falls back to a localized label. */
  names: [string, string];
}

/* ---------- the persona pool ----------
 * Fifty names, Persian and international, each carrying its own gender so the avatar ring and the
 * copy feel like a person rather than a placeholder. Deliberately no duplicates: a match seats at
 * most 44 fans, so every spectator on a board is a distinct name. */
const NAMES: ReadonlyArray<readonly [string, Gender]> = [
  ['سارا', 'f'], ['امیر', 'm'], ['نیلوفر', 'f'], ['آرش', 'm'], ['مریم', 'f'],
  ['کیان', 'm'], ['هستی', 'f'], ['رضا', 'm'], ['ترانه', 'f'], ['پارسا', 'm'],
  ['لیلا', 'f'], ['بهرام', 'm'], ['نازنین', 'f'], ['سینا', 'm'], ['الهام', 'f'],
  ['سامان', 'm'], ['مهسا', 'f'], ['فرزاد', 'm'], ['شیرین', 'f'], ['کاوه', 'm'],
  ['آیدا', 'f'], ['مهدی', 'm'], ['رویا', 'f'], ['بابک', 'm'], ['غزل', 'f'],
  ['Sara', 'f'], ['Alex', 'm'], ['Elena', 'f'], ['Liam', 'm'], ['Maya', 'f'],
  ['Daniel', 'm'], ['Nora', 'f'], ['Kian', 'm'], ['Zara', 'f'], ['Leo', 'm'],
  ['Mia', 'f'], ['Noah', 'm'], ['Sofia', 'f'], ['Ethan', 'm'], ['Aisha', 'f'],
  ['Omar', 'm'], ['Yuki', 'f'], ['Diego', 'm'], ['Priya', 'f'], ['Lucas', 'm'],
  ['Amara', 'f'], ['Ivan', 'm'], ['Chloe', 'f'], ['Mateo', 'm'], ['Anya', 'f'],
];

const STAKES = [50, 100, 250, 500, 1000] as const;
/** Pastel and obsidian badge faces: [background, ink]. Chosen by the name, so a name keeps its badge. */
const PALETTES: ReadonlyArray<readonly [string, string]> = [
  ['#FDE2E4', '#9F1239'], ['#E0F2FE', '#075985'], ['#EDE9FE', '#5B21B6'],
  ['#DCFCE7', '#166534'], ['#FEF3C7', '#92400E'], ['#E0E7FF', '#3730A3'],
  ['#FCE7F3', '#9D174D'], ['#CCFBF1', '#115E59'], ['#1E293B', '#E2E8F0'],
  ['#0F172A', '#CBD5E1'],
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
    p1: 'Jugador 1', p2: 'Jugador 2',
    fan: 'A por {name}',
    wall: ['¡Muro decisivo de {name}!', '¡Ese muro frenó a {name}!', '¡Bloqueo inteligente — {name} no pasa!'],
    mine: ['¡La mina atrapó a {name}!', '¡Bum — directo a {name}!', '¡Vaya trampa para {name}!'],
    near: ['¡{name} a un paso de la META!', '¡Muy cerca para {name}!', '¡No parpadees — {name} en la recta final!'],
    back: '¡+{n} a por {name}!',
  },
};

const copy = (): CrowdCopy => COPY[lang] ?? COPY.en;

/* ---------- deterministic badge identity ---------- */
function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const initialOf = (name: string): string => Array.from(name)[0] ?? '?';

function paintAvatar(el: HTMLElement, fan: Fan): void {
  const palette = PALETTES[hashName(fan.name) % PALETTES.length]!;
  el.textContent = initialOf(fan.name);
  el.style.setProperty('--av-bg', palette[0]);
  el.style.setProperty('--av-ink', palette[1]);
  el.style.setProperty('--av-ring', fan.gender === 'f' ? 'rgba(244,114,182,.72)' : 'rgba(56,189,248,.66)');
}

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

/* ---------- the live simulation ---------- */
let match: MatchCrowd | null = null;
let toastTimer = 0;
let lastReactionAt = -Infinity;
let lastFocus: HTMLElement | null = null;

const REACTION_GAP_MS = 3400;
const TOAST_MS = 2600;

const pickIndex = (n: number): number => (n > 0 ? Math.floor(Math.random() * n) : 0);

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

function makeFan(name: string, gender: Gender, camp: Camp, teamMode: boolean): Fan {
  return {
    name,
    gender,
    camp,
    sideKey: teamMode ? (camp === 0 ? 'A' : 'B') : (camp === 0 ? 'p1' : 'p2'),
    stake: STAKES[pickIndex(STAKES.length)]!,
    decided: Math.random() < 0.58,
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
  if (a === b) return Math.random() < 0.5 ? 0 : 1;
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
  sheetSub: HTMLElement;
  list: HTMLElement;
  closeBtn: HTMLButtonElement;
  scrim: HTMLElement;
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
  const sheetSub = byId('crowd-sheet-sub');
  const list = byId('crowd-list');
  const closeBtn = byId<HTMLButtonElement>('crowd-sheet-close');
  const scrim = byId('crowd-sheet-scrim');
  /* The screen can be booted without this chrome (headless probes, a host that strips it):
     no refs means no painting, and every hook below is a no-op instead of a throw. */
  if (!pill || !count || !live || !bar || !title || !redName || !blueName || !redPct || !bluePct
    || !redStake || !blueStake || !redFill || !blueFill || !toast || !sheet || !sheetTitle
    || !sheetSub || !list || !closeBtn || !scrim) {
    return null;
  }
  ui = {
    pill, count, live, bar, title, redName, blueName, redPct, bluePct, redStake, blueStake,
    redFill, blueFill, toast, sheet, sheetTitle, sheetSub, list, closeBtn, scrim,
  };
  wire(ui);
  return ui;
}

/* ---------- painting ---------- */
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
  ui.count.textContent = formatNum(total);
  ui.title.textContent = c.odds;
  ui.live.textContent = c.live;

  ui.pill.setAttribute('aria-label', c.title);
  ui.pill.title = c.title;
  const summary = `${c.odds}: ${campName(0)} ${pctA}% · ${campName(1)} ${pctB}%`;
  ui.bar.setAttribute('aria-label', summary);
  ui.bar.title = summary;

  if (!ui.sheet.hidden) renderSheet();
}

/** Repaint everything the pill and the card own. Cheap: two small loops over ≤44 records. */
function paint(): void {
  paintBar();
}

function renderSheet(): void {
  if (!match || !ui) return;
  const c = copy();
  const [ca, cb] = campCounts(match.fans);
  const total = ca + cb;

  ui.sheetTitle.textContent = c.title;
  ui.closeBtn.setAttribute('aria-label', c.close);
  const sub = document.createDocumentFragment();
  sub.append(templateNodes(c.viewers, { n: formatNum(total) }, ['n']));
  sub.append(' · ');
  sub.append(templateNodes(
    c.split,
    { a: formatNum(ca), b: formatNum(cb), p1: campName(0), p2: campName(1) },
    ['a', 'b'],
    ['p1', 'p2'],
  ));
  ui.sheetSub.replaceChildren(sub);

  const frag = document.createDocumentFragment();
  for (const fan of match.fans) {
    const li = document.createElement('li');
    li.className = 'crowd-row';

    const av = document.createElement('span');
    av.className = 'crowd-av';
    av.setAttribute('aria-hidden', 'true');
    paintAvatar(av, fan);

    const nm = document.createElement('span');
    nm.className = 'crowd-nm';
    nm.dir = 'auto';
    nm.textContent = fan.name;

    const side = document.createElement('span');
    side.className = `crowd-side ${fan.camp === 0 ? 'is-red' : 'is-blue'}`;
    side.append(templateNodes(c.fan, { name: campName(fan.camp) }, [], ['name']));

    const stake = document.createElement('span');
    stake.className = 'crowd-stake';
    const coin = document.createElement('span');
    coin.className = 'coin';
    coin.setAttribute('data-coin', '');
    coin.setAttribute('aria-hidden', 'true');
    const num = document.createElement('bdi');
    num.dir = 'ltr';
    num.textContent = formatNum(fan.stake);
    stake.append(coin, num);

    li.append(av, nm, side, stake);
    frag.append(li);
  }
  ui.list.replaceChildren(frag);
  mountCoins(ui.list);
}

/* ---------- the sheet ---------- */
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

/** One-time listeners: the two triggers, the close key, the scrim and the language watcher. */
let wired = false;
function wire(refs: CrowdUi): void {
  if (wired) return;
  wired = true;
  refs.pill.addEventListener('click', openSheet);
  refs.bar.addEventListener('click', openSheet);
  refs.closeBtn.addEventListener('click', () => closeSheet());
  refs.scrim.addEventListener('click', () => closeSheet());
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
  name.textContent = fan.name;
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
  const canAdd = total < 44;
  const canRemove = total > 14 && Math.max(ca, cb) > 3;
  if (!canAdd && !canRemove) return false;
  const add = canAdd && (!canRemove || Math.random() < 0.55);
  if (add) {
    /* arrive on the side the room is already leaning toward, weighted by head count */
    const camp: Camp = ca === cb ? (Math.random() < 0.5 ? 0 : 1) : (ca > cb ? 0 : 1);
    const used = new Set(match.fans.map((f) => f.name));
    const pool = NAMES.filter(([name]) => !used.has(name));
    const [name, gender] = pool[pickIndex(pool.length)] ?? NAMES[pickIndex(NAMES.length)]!;
    match.fans.push(makeFan(name, gender, camp, match.teamMode));
  } else {
    const camp: Camp = ca === cb ? (Math.random() < 0.5 ? 0 : 1) : (ca > cb ? 0 : 1);
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
  const switched = shiftSupport(target, type === 'wall' ? 1 : Math.random() < 0.5 ? 1 : 2);
  const now = performance.now();
  if (now - lastReactionAt < REACTION_GAP_MS) return;
  const c = copy();

  /* A fresh switcher quotes their stake about half the time; the rest are pure crowd noise. */
  if (switched && Math.random() < 0.5) {
    lastReactionAt = now;
    showToast(switched, c.back, { n: formatNum(switched.stake), name: campName(target) }, ['name']);
    return;
  }
  const pool = type === 'wall' ? c.wall : type === 'mine' ? c.mine : c.near;
  const line = pool[pickIndex(pool.length)] ?? pool[0] ?? '';
  /* Prefer a fan on the leading camp: the reaction belongs to the side the play favors. */
  const fans = target === 0 ? match.fans.filter((f) => f.camp === 0) : match.fans.filter((f) => f.camp === 1);
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

  const total = 14 + Math.floor(Math.random() * 31);       // 14..44
  const redShare = 0.42 + Math.random() * 0.22;            // 42%..64%, never a static 50/50
  let red = Math.round(total * redShare);
  red = Math.min(total - 3, Math.max(3, red));
  const blue = total - red;

  const teamMode = setup.teamMode === true;
  const roster = shuffle(NAMES.slice());
  const fans: Fan[] = [];
  for (let i = 0; i < total; i++) {
    const [name, gender] = roster[i] ?? NAMES[i % NAMES.length]!;
    fans.push(makeFan(name, gender, i < red ? 0 : 1, teamMode));
  }
  match = {
    fans,
    teamMode,
    names: [(setup.p1Name ?? '').trim(), (setup.p2Name ?? '').trim()],
  };
  lastReactionAt = -Infinity;

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
      if (Math.random() < 0.1) driftCount();
      break;
    case 'move':
      if (Math.random() < 0.06) driftCount();
      break;
  }
}

/** End the simulation: hide the chrome, close the sheet, drop every timer. Idempotent. */
export function closeCrowd(): void {
  hideToast();
  closeSheet(false);
  match = null;
  lastReactionAt = -Infinity;
  const refs = ui;
  if (!refs) return;
  refs.pill.hidden = true;
  refs.bar.hidden = true;
  refs.list.replaceChildren();
}
