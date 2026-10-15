/**
 * compete.ts — Arena (the 200 Stars Arena) + Ranks (dedicated Leaderboard).
 *
 * IA: Arena stages exactly ONE championship — the 200 Telegram Stars Arena — as a
 * single dark-clay showcase that fills the phone between the header and the bottom
 * dock: the faceted Star medallion with the engraved title and the live bracket
 * clock, the two format pills plus the paid-places pill, one compact prize ribbon
 * carrying the pool and its 120 / 50 / 30 split, the live standings of the head of
 * the field with a pinned "You" row, and the 50px ENTER ARENA key that takes a seat
 * and queues the match. There is no cup feed, no archive and no coin entry fee
 * anywhere on it: one championship, staged in full, hydrated from `getGrandCup()`.
 *
 * Ranks is "The Mind Ladder": one three-way clay switch over Top Minds (solo
 * champions), Intellect Guilds (Telegram channels & groups) and Nations IQ
 * (aggregate country score). Above the ladder sits the Top 3 clay podium, so the
 * list itself starts at #4; the guild board carries its Join / Invite keys there.
 * The squad dock ("My Squad Standing" / join prompt) belongs EXCLUSIVELY to the
 * guild board, and the "Your Standing" module to the two IQ boards.
 * Identity: TIQ (Tactical IQ) is the hero metric — gold digits with the brain
 * glyph, on the HUD pills, the podium and the ladder. #i-cup is reserved for
 * season prizes. The four mind tiers (Rookie / Tactician / Strategist /
 * Grandmaster) are an aura colour driven off your TIQ, never a badge word.
 */
import {
  formatCountdown,
  getArenaStandings,
  getCountryRanking,
  getGrandCup,
  getPlayerRanking,
  paidPlaces,
  trendArrow,
  type ContenderRow,
  type CountryRow,
  type GrandCup,
  type PlayerRow,
  type Trend,
} from './data';
import { nameOf } from './countries';
import { onChange, profile } from './storage';
import { motionReduced } from './settings';
import { bindSquadById, getMyContribution, getMySquad, getSquadRanking, onSquadChange, squadKind, squadLetter, type RankedSquad } from './squads';
import { impact, notify, tgUser } from './telegram';
import type { Router } from './router';
import type { Sheets } from './sheets';

export interface CompeteApi {
  router: Router;
  sheets: Sheets;
  sheet(id: string): HTMLElement | null;
  /** The one door every queue goes through — the Arena's PLAY MATCH key opens it. */
  queue(): void;
}

type Board = 'minds' | 'guilds' | 'nations';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const skel = (rows: number): string =>
  Array.from({ length: rows }, () => '<div class="skel-row"><span class="skel w20"></span><span class="skel w60"></span><span class="skel w15"></span></div>').join('');

const empty = (msg: string): string => `<div class="empty" role="status">${msg}</div>`;

/** Seat fill as a whole percent — the meter's width and the mood word both read it. */
const fillPctOf = (c: { players: number; maxPlayers: number }): number =>
  c.maxPlayers > 0 ? Math.min(100, Math.max(0, Math.round((c.players / c.maxPlayers) * 100))) : 0;

function pickEl(id: string, legacy: string): HTMLElement {
  return (document.getElementById(id) ?? document.getElementById(legacy)) as HTMLElement;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------- Mind Ladder identity: the season clock and the TIQ tiers ---------- */

/** Season 4 closes 2026-10-16 14:00Z. Anchoring to a fixed boundary and rolling it
 *  every 28 days keeps the scarcity chip a real countdown after that date instead
 *  of a frozen string that quietly stops matching the pulsing dot beside it. */
const SEASON_ANCHOR = Date.UTC(2026, 9, 16, 14, 0);
const SEASON_MS = 28 * 86400_000;

function seasonOf(t: number): { no: number; endsAt: number } {
  const k = Math.ceil((t - SEASON_ANCHOR) / SEASON_MS);
  return { no: 4 + k, endsAt: SEASON_ANCHOR + k * SEASON_MS };
}

/** TIQ bands. The tier is an aura colour, never a badge word on the ladder. */
type MindTier = 'rookie' | 'tactician' | 'strategist' | 'grandmaster';

const TIER_NAME: Record<MindTier, string> = {
  rookie: 'Rookie',
  tactician: 'Tactician',
  strategist: 'Strategist',
  grandmaster: 'Grandmaster',
};

/** Grandmaster tops out at 4000 rather than Infinity so its three divisions exist. */
const TIER_BAND: Record<MindTier, [number, number]> = {
  rookie: [0, 1000],
  tactician: [1000, 2000],
  strategist: [2000, 3000],
  grandmaster: [3000, 4000],
};

const DIVISION = ['I', 'II', 'III'];

function tierOf(tiq: number): MindTier {
  if (tiq >= 3000) return 'grandmaster';
  if (tiq >= 2000) return 'strategist';
  if (tiq >= 1000) return 'tactician';
  return 'rookie';
}

/**
 * Each aura is split into three visible steps, so "Tactician II" is a place you can
 * see yourself move inside the colour you already wear. `next` is 0 at the peak.
 */
function divisionOf(tiq: number): { tier: MindTier; label: string; next: number } {
  const tier = tierOf(tiq);
  const [lo, hi] = TIER_BAND[tier];
  const step = (hi - lo) / DIVISION.length;
  const div = Math.min(DIVISION.length - 1, Math.floor(Math.max(0, tiq - lo) / step));
  const next = div === DIVISION.length - 1 && tier === 'grandmaster' ? 0 : lo + step * (div + 1);
  return { tier, label: `${TIER_NAME[tier]} ${DIVISION[div]}`, next: Math.ceil(next) };
}

/** A win is worth 120 TIQ and it also lands a game (+20) — the same formula myTrophyScore uses. */
const TIQ_PER_WIN = 140;

/** FNV-1a over an ASCII key: stable across renders, so a seeded figure never jitters. */
function hashOf(key: string): number {
  let h = 216613261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return Math.abs(h);
}

/**
 * Seeded weekly TIQ delta: stable per player across renders and signed by their own
 * trend, so the chip can never contradict the arrow beside it. Real deltas arrive
 * with the backend; the Preview chip on the HUD already says this board is seeded.
 */
function deltaOf(key: string, points: number, trend: Trend): number {
  if (trend === 'same') return 0;
  const mag = 8 + (hashOf(key) % 71) + Math.round(points * 0.004);
  return trend === 'up' ? mag : -mag;
}

/**
 * The seeded country rows carry an aggregate and no roster, so each nation's field
 * is split across a stable head-count and the average is then arithmetic on those
 * two numbers — total, minds and AVG can never disagree. Real rosters land with the
 * backend, at which point this function and its caller both go away.
 */
function fieldOf(code: string, points: number): { minds: number; avg: number } {
  const target = 1100 + (hashOf(code) % 500);
  const minds = Math.max(3, Math.round(points / target));
  return { minds, avg: Math.round(points / minds) };
}

const signed = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toLocaleString('en-US')}`;

/* ---------- mind profile: the four axes, the form strip, the percentile ring ---------- */

/** One axis of the cognitive read: a bar, the number behind it, and where it came from. */
interface MindAxis {
  label: string;
  icon: string;
  pct: number;
  value: string;
  hint: string;
}

/** Newest on the right; `u` is a race the save genuinely does not remember. */
type FormCell = 'w' | 'l' | 'u';

const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n * 100)));

/** Each axis is a count against a fixed cap, so the bar and the number never disagree. */
const axisPct = (count: number, cap: number): number => clampPct(count / cap);

/**
 * A rival's axes, seeded once from their own key. The ladder holds no race log for
 * anybody but you, so these are the Preview chip's figures — stable across renders and
 * the only part of the sheet not read from real data.
 */
function rivalAxes(p: PlayerRow): MindAxis[] {
  const h = hashOf(p.id);
  const blocked = 3 + (h % 8);
  const mine = 14 + ((h >> 4) % 8);
  const field = mine + 6 + ((h >> 8) % 9);
  const baited = 2 + ((h >> 12) % 7);
  const back = 2 + ((h >> 16) % 9);
  return [
    { label: 'Foresight', icon: '#i-brain', pct: axisPct(blocked, 12), value: `${blocked} blocked paths`, hint: 'Walls read before committing · cap 12 a race · Season preview figure' },
    { label: 'Tempo', icon: '#i-move', pct: axisPct(field - mine, 14), value: `${mine} vs ${field} turns`, hint: `Their ${mine} turns against the field's ${field} · Season preview figure` },
    { label: 'Traps', icon: '#i-mine', pct: axisPct(baited, 9), value: `${baited} dead-ends baited`, hint: 'Dead-ends laid for the other side · cap 9 · Season preview figure' },
    { label: 'Compose', icon: '#i-shield', pct: axisPct(back, 12), value: `${back} comeback wins`, hint: 'Races won from behind · cap 12 · Season preview figure' },
  ];
}

/** Weighted by the trend already printed beside the name, so form never fights arrow. */
function rivalForm(key: string, trend: Trend): FormCell[] {
  const h = hashOf(key);
  const bias = trend === 'up' ? 72 : trend === 'down' ? 40 : 56;
  const out: FormCell[] = [];
  for (let i = 0; i < 5; i++) out.push((h >> (i * 3)) % 100 < bias ? 'w' : 'l');
  return out;
}

/** Sprite icon as a real element — the house artwork, never an emoji stand-in. */
function svgIcon(href: string, cls: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', href);
  svg.append(use);
  return svg;
}

/**
 * Percentile ring: one SVG arc on pathLength=100, so the dash *is* the percentage and
 * the mount animation only has to walk stroke-dashoffset from empty to its own value.
 */
function percentRing(pct: number, inner: HTMLElement, extraCls = ''): HTMLElement {
  const ring = document.createElement('span');
  ring.className = `mh-ring${extraCls ? ` ${extraCls}` : ''}`;
  ring.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'mh-arc');
  svg.setAttribute('viewBox', '0 0 44 44');
  const arc = (fill: boolean): void => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', fill ? 'mh-arc-fill' : 'mh-arc-track');
    c.setAttribute('cx', '22');
    c.setAttribute('cy', '22');
    c.setAttribute('r', '19');
    c.setAttribute('fill', 'none');
    if (fill) {
      c.setAttribute('pathLength', '100');
      c.setAttribute('stroke-dasharray', '100 100');
      c.style.strokeDashoffset = String(100 - Math.max(0, Math.min(100, pct)));
    }
    svg.append(c);
  };
  arc(false);
  arc(true);
  ring.append(svg, inner);
  return ring;
}

/* ---------- flag rendering pipeline ---------- */

/** Only a bare ISO alpha-2 may ever be interpolated into a URL — nothing else. */
const iso2 = (code: string | null | undefined): string | null =>
  code && /^[A-Za-z]{2}$/.test(code) ? code.toLowerCase() : null;

/**
 * circle-flags ships as an npm package, so the jsdelivr *gh* path in the brief
 * (…/gh/hats-scripts/circle-flags@latest/flags/us.svg) answers 404 at every casing
 * and ref; the npm resolution of the same library on the same CDN is what serves.
 */
const FLAG_SVG = (cc: string): string => `https://cdn.jsdelivr.net/npm/circle-flags/flags/${cc}.svg`;
const FLAG_PNG = (cc: string): string => `https://flagcdn.com/w80/${cc}.png`;

/**
 * Photo flag, three tiers: circle-flags SVG → flagcdn PNG → the clay ISO chip.
 * The chip is in the DOM from the start and the image is layered over it, so a
 * slow or blocked CDN shows a legible code instead of a hole, and a failure needs
 * no layout pass. Every image is lazy and decoded async.
 */
export function flagPhoto(code: string | null, cls: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = `fp ${cls}`;
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

  const img = document.createElement('img');
  img.className = 'fp-img';
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  let tier = 0;
  img.addEventListener('error', () => {
    if (tier === 0) { tier = 1; img.src = FLAG_PNG(cc); return; }
    tier = 2;
    img.remove();
    wrap.classList.add('is-chip');
  });
  img.addEventListener('load', () => wrap.classList.add('is-photo'));
  wrap.append(img);
  img.src = FLAG_SVG(cc);
  return wrap;
}

export function createCompete(api: CompeteApi): { setRoute(id: string): void } {
  const boardBtns = [...document.querySelectorAll<HTMLButtonElement>('.ranks-tabs [data-board]')];
  const ranksStats = document.getElementById('ranks-stats');
  const boardSwitch = document.querySelector<HTMLElement>('.ranks-tabs');
  const ranksScreen = document.getElementById('s-ranks');
  const seasonChip = document.getElementById('ranks-season');
  const seasonText = seasonChip?.querySelector<HTMLElement>('.ml-season-t') ?? null;
  /** The Arena showcase's own parts: one card, hydrated in place, never rebuilt. */
  const cupEls = {
    name: document.getElementById('stars-name'),
    hook: document.getElementById('stars-hook'),
    ribbon: document.getElementById('stars-ribbon'),
    pool: document.getElementById('stars-pool-n'),
    split: document.getElementById('stars-split'),
    specs: document.getElementById('stars-specs'),
    seats: document.getElementById('stars-seats'),
    mood: document.getElementById('stars-mood'),
    count: document.getElementById('stars-count'),
    track: document.getElementById('stars-track'),
    meter: document.getElementById('stars-meter'),
    field: document.getElementById('stars-field'),
    you: document.getElementById('stars-you'),
    youRank: document.getElementById('stars-you-rank'),
    youNote: document.getElementById('stars-you-note'),
    youPay: document.getElementById('stars-you-pay'),
    cta: document.getElementById('stars-cta') as HTMLButtonElement | null,
  };
  const podiumEl = document.getElementById('ranks-podium');
  const panes: Record<Board, HTMLElement | null> = {
    minds: document.getElementById('ranks-minds'),
    guilds: document.getElementById('ranks-guilds'),
    nations: document.getElementById('ranks-nations'),
  };

  let board: Board = 'minds';
  let loadedBoard: Partial<Record<Board, boolean>> = {};
  /** Aggregate of the last ladder each solo board loaded — the stat chips quote it. */
  const boardStats: Record<'minds' | 'nations', { loaded: boolean; rows: number; points: number }> = {
    minds: { loaded: false, rows: 0, points: 0 },
    nations: { loaded: false, rows: 0, points: 0 },
  };
  /** The staged championship. `null` until `getGrandCup()` answers — the markup
   *  already carries the showcase skeleton, so nothing has to be rebuilt. */
  let cup: GrandCup | null = null;
  /** The head of the Arena field, loaded with the cup and painted once. */
  let field: ContenderRow[] | null = null;
  /** The same cup behind the Nations IQ event pill, fetched with the country board. */
  let natCup: GrandCup | null = null;
  let tick = 0;

  /** Clean user handle: "@username" when Telegram provides one, else first name, else null. */
  const youHandle = (): string | null => {
    const u = tgUser();
    if (u?.username) {
      const h = u.username.trim().replace(/^@+/, '').slice(0, 32);
      if (h) return `@${h}`;
    }
    const full = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
    if (full && full.toLowerCase() !== 'you') return full.slice(0, 24);
    return null;
  };

  /** "You (@Username)" — never the glitchy "You · You". Falls back to plain "You". */
  const youLabel = (): string => {
    const h = youHandle();
    return h ? `You (${h})` : 'You';
  };

  const myTrophyScore = (): number =>
    Math.max(0, profile.stats.wins * 120 + profile.stats.games * 20);

  const myRecord = (): string =>
    `${profile.stats.wins}W · ${profile.stats.losses}L`;

  const soloStandingEl = (): HTMLElement | null =>
    document.getElementById('solo-standing');

  /* ---------- squad dock helpers ---------- */

  const squadDock = (): HTMLElement | null =>
    document.getElementById('ranks-dock') ?? document.getElementById('squad-dock');

  const openSquadSheet = (): void => {
    (document.getElementById('team-chip') as HTMLButtonElement | null)?.click();
  };

  const inviteSquad = (s: RankedSquad): void => {
    const text = `${s.handle} — join my squad in Detour!`;
    try {
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text).then(
          () => notify('success'),
          () => notify('warning'),
        );
      } else {
        notify('success');
      }
    } catch {
      notify('warning');
    }
    impact('medium');
  };

  /** 1240 -> "1.2k", 986 -> "986" — keeps the sub line on one row. */
  const compactCount = (n: number): string => {
    if (!Number.isFinite(n) || n < 0) return '0';
    if (n < 1000) return String(Math.floor(n));
    const v = n / 1000;
    const s = v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
    return `${s}k`;
  };

  /* ---------- top-level paint ---------- */

  const isRanksVisible = (): boolean => {
    const el = document.getElementById('s-ranks') ?? document.getElementById('s-compete');
    return !!el && !el.hidden;
  };

  const isArenaVisible = (): boolean => {
    const el = document.getElementById('s-arena') ?? document.getElementById('s-compete');
    return !!el && !el.hidden;
  };

  function paintArena(): void {
    if (cup) paintCup(cup);
  }

  function paintRanks(): void {
    paintSeason();
    for (const b of boardBtns) b.setAttribute('aria-selected', String(b.dataset.board === board));
    if (boardSwitch) boardSwitch.dataset.active = board;
    for (const k of Object.keys(panes) as Board[]) {
      const pane = panes[k];
      if (pane) pane.hidden = k !== board;
    }
    // "Your Standing" is a player fact — it belongs to the two IQ boards, never to a guild.
    const standing = soloStandingEl();
    if (standing) standing.hidden = board === 'guilds';
    paintRanksStats();
    // The squad banner belongs EXCLUSIVELY to the Intellect Guilds board.
    const dock = squadDock();
    if (dock) dock.hidden = board !== 'guilds';
    if (board === 'guilds') paintSquadDock();
    paintGuildHero();
  }

  /** One quick-stat chip: sprite icon + value over a muted label. */
  function setChip(key: 'a' | 'b' | 'c', icon: string, value: string, label: string): void {
    const chip = ranksStats?.querySelector<HTMLElement>(`[data-stat="${key}"]`);
    if (!chip) return;
    chip.querySelector('use')?.setAttribute('href', icon);
    const n = chip.querySelector<HTMLElement>('.rstat-n');
    const l = chip.querySelector<HTMLElement>('.rstat-l');
    if (n) n.textContent = value;
    if (l) l.textContent = label;
  }

  const quietChips = (): void => {
    setChip('a', '#i-brain', '—', 'Tactical Minds');
    setChip('b', '#i-brain', '—', 'Combined TIQ');
    setChip('c', '#i-star', '—', 'Your TIQ');
  };

  /**
   * The pills read as a headcount, a field total and your own number. Only the two
   * TIQ pills carry gold digits — the brain is the score's glyph now, so the cup is
   * free to mean a season prize alone. Which population each counts follows the
   * visible board: quoting guild totals while the user reads the solo ladder is what
   * the old single-sentence stat bar got wrong.
   */
  function paintRanksStats(): void {
    if (!ranksStats) return;
    if (ranksScreen) ranksScreen.dataset.tier = tierOf(myTrophyScore());
    // The coral rim means "this number is yours", so it can only sit on the pill that carries it.
    ranksStats.querySelector<HTMLElement>('[data-stat="c"]')?.classList.toggle('is-you', board !== 'guilds');
    if (board === 'guilds') {
      try {
        const rows = getSquadRanking();
        setChip('a', '#i-shield', String(rows.length), 'Mind Guilds');
        setChip('b', '#i-brain', compactCount(rows.reduce((n, s) => n + s.members, 0)), 'Tactical Minds');
        setChip('c', '#i-brain', compactCount(rows.reduce((n, s) => n + s.trophies, 0)), 'Combined TIQ');
      } catch {
        quietChips();
      }
      return;
    }
    const nations = board === 'nations';
    const st = boardStats[nations ? 'nations' : 'minds'];
    setChip('a', nations ? '#i-globe' : '#i-brain', st.loaded ? String(st.rows) : '—', nations ? 'Nations' : 'Tactical Minds');
    setChip('b', '#i-brain', st.loaded ? compactCount(st.points) : '—', 'Combined TIQ');
    setChip('c', '#i-star', compactCount(myTrophyScore()), 'Your TIQ');
  }

  /** The season capsule: "S4 · 3d 14h left", recomputed on entry and every tick. */
  function paintSeason(): void {
    if (!seasonText) return;
    const t = Date.now();
    const s = seasonOf(t);
    const left = formatCountdown(s.endsAt, t);
    seasonText.textContent = `S${s.no} · ${left} left`;
    seasonChip?.setAttribute('title', `Season ${s.no} closes in ${left}`);
  }

  function selectBoard(next: Board): void {
    if (next === board && loadedBoard[next]) {
      paintRanks();
      return;
    }
    board = next;
    // The podium is board data: blank it here so the incoming ladder never inherits
    // the previous board's top three while its rows are still loading.
    if (podiumEl) podiumEl.hidden = true;
    paintRanks();
    impact('light');
    void loadBoard(next);
    const sc = document.getElementById('ranks-scroll');
    if (sc) sc.scrollTo({ top: 0 });
  }

  for (const b of boardBtns) {
    b.addEventListener('click', () => {
      const v = b.dataset.board;
      if (v === 'minds' || v === 'guilds' || v === 'nations') selectBoard(v);
    });
  }

  /* ---------- arena: the 200 Stars Arena ----------
     One championship, staged in the markup and hydrated here. The showcase is a
     single clay card whose geometry (header · specs · prize ribbon · live standings
     · CTA) is what makes it fit 360x640 with no scroll, so this controller never
     rebuilds the card: it writes the live numbers in, ticks the countdown, paints
     the field and owns the seat. */

  /** A seat is a device fact, like every other mock in this app. */
  const SEAT_KEY = 'detour.arena.seat.v1';

  /** How many of the field the card shows before the pinned You row takes the rest. */
  const FIELD_ROWS = 5;

  interface Seat {
    /** the cup this device registered for */
    cup: string;
    /** ms epoch the seat was locked */
    at: number;
  }

  function readSeat(): Seat | null {
    try {
      const raw = window.localStorage.getItem(SEAT_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw) as Partial<Seat>;
      if (typeof s.cup !== 'string' || typeof s.at !== 'number' || !Number.isFinite(s.at)) return null;
      return { cup: s.cup, at: s.at };
    } catch {
      return null;
    }
  }

  function writeSeat(cupId: string): Seat {
    const s: Seat = { cup: cupId, at: Date.now() };
    try {
      window.localStorage.setItem(SEAT_KEY, JSON.stringify(s));
    } catch {
      /* in-memory only */
    }
    return s;
  }

  let seat: Seat | null = readSeat();

  const elOf = (id: string): HTMLElement | null => document.getElementById(id);

  /** Write only when it differs: a repaint must never thrash the layout. */
  const setText = (el: HTMLElement | null, text: string): void => {
    if (el && el.textContent !== text) el.textContent = text;
  };

  /** Grouped Latin digits, exactly the way the Mind Ladder quotes a score. */
  const num = (n: number): string => n.toLocaleString('en-US');

  /** Seat-fill word — 184 of 256 is "Filling fast", and it tracks the real number. */
  const moodOfFill = (pct: number): string =>
    pct >= 90 ? 'Almost full' : pct >= 70 ? 'Filling fast' : pct >= 35 ? 'Filling up' : 'Open seats';

  /** The bracket clock: `01:44:58` counting down, then the stage says so itself. */
  const startsText = (c: GrandCup, from: number): string =>
    c.startsAt - from <= 0 ? 'Bracket live' : formatCountdown(c.startsAt, from);

  /** The format pills: the data's own, plus the paid count read off the prize ladder. */
  const specWords = (c: GrandCup): string[] => [...c.specs, `Top ${paidPlaces(c)} Paid`];

  /** Metal for a bracket place — the three that get a rim, and nothing above them. */
  const metalOf = (place: number): string =>
    place === 1 ? 'gold' : place === 2 ? 'silver' : place === 3 ? 'bronze' : '';

  /** Two letters is all a 30px sphere holds without a second glyph crowding it. */
  const initials = (name: string): string => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
  };

  function paintSpecs(c: GrandCup): void {
    const pills = cupEls.specs?.querySelectorAll<HTMLElement>('.stars-spec');
    if (!pills) return;
    specWords(c).forEach((spec, i) => {
      const pill = pills[i];
      if (pill) setText(pill, spec);
    });
  }

  /** The ribbon: the pool on the left, the exact split on the right, so 120 + 50 + 30
   *  never has to be guessed and never has to be typed into the markup either. */
  function paintRibbon(c: GrandCup): void {
    setText(cupEls.pool, num(c.stars));
    const cuts = cupEls.split?.querySelectorAll<HTMLElement>('.stars-cut');
    c.prizes.forEach((prize, i) => {
      const cut = cuts?.[i];
      if (!cut) return;
      setText(cut.querySelector<HTMLElement>('.stars-cut-n'), num(prize.stars));
      cut.dataset.place = String(prize.place);
      cut.setAttribute('aria-label', `Place ${prize.place} pays ${num(prize.stars)} Telegram Stars`);
    });
    cupEls.ribbon?.setAttribute('aria-label',
      `Total pool ${num(c.stars)} Telegram Stars, paid ${c.prizes.map((p) => num(p.stars)).join(', ')}`);
  }

  /** One contender: rank · sphere + flag · name + stats · projected payout. */
  function contenderRow(r: ContenderRow): HTMLElement {
    const li = document.createElement('li');
    li.className = 'ac-row';
    const metal = metalOf(r.rank);
    if (metal) li.dataset.metal = metal;

    const rank = document.createElement('span');
    rank.className = 'ac-rank';
    rank.textContent = `#${r.rank}`;

    const av = document.createElement('span');
    av.className = 'ac-av';
    av.textContent = initials(r.name);
    av.setAttribute('aria-hidden', 'true');

    const flag = document.createElement('span');
    flag.className = 'ac-flag';
    flag.append(flagPhoto(r.countryCode, 'fp-badge'));

    const nameEl = document.createElement('span');
    nameEl.className = 'ac-name';
    nameEl.textContent = r.name;

    const nm = document.createElement('span');
    nm.className = 'ac-nm';
    nm.append(flag, nameEl);

    const tiq = document.createElement('b');
    tiq.textContent = `${num(r.tiq)} TIQ`;
    const sub = document.createElement('span');
    sub.className = 'ac-sub';
    sub.append(tiq, document.createTextNode(r.streak > 0 ? ` · ${r.streak}W streak` : ' · no streak'));

    const id = document.createElement('span');
    id.className = 'ac-id';
    id.append(nm, sub);

    const pay = document.createElement('span');
    pay.className = r.payout > 0 ? 'ac-pay' : 'ac-pay is-zero';
    pay.append(svgIcon('#i-star-3d', 'ico'));
    const payN = document.createElement('b');
    payN.textContent = r.payout > 0 ? num(r.payout) : '—';
    pay.append(payN);
    pay.title = r.payout > 0
      ? `Projects to pay ${num(r.payout)} Telegram Stars`
      : 'Outside the paid places — nothing to project';

    li.append(rank, av, id, pay);
    li.setAttribute('aria-label',
      `Place ${r.rank}: ${r.name}, ${num(r.tiq)} Tactical IQ, ${r.streak} win streak, ` +
      `${r.payout > 0 ? `projects to pay ${num(r.payout)} Stars` : 'outside the paid places'}`);
    return li;
  }

  /** The head of the field. Static bracket data, so it is built once per load. */
  function paintField(): void {
    const host = cupEls.field;
    if (!host) return;
    host.textContent = '';
    for (const r of field ?? []) host.append(contenderRow(r));
  }

  /**
   * The pinned local row. Every number on it is read off the save and the field the
   * card is actually showing — the rank counts the contenders above you in this list,
   * and the gap is the TIQ of the last paid place minus your own, converted with the
   * same TIQ-per-win the Mind Ladder uses. Nothing here is a motivational constant.
   */
  function paintYou(c: GrandCup): void {
    const you = cupEls.you;
    if (!you) return;
    const tiq = myTrophyScore();
    const rank = (field ? field.filter((r) => r.tiq > tiq).length : 0) + 1;
    const paid = paidPlaces(c);
    const cutoff = field && paid > 0 ? field[paid - 1]?.tiq ?? 0 : 0;
    const gap = cutoff - tiq;
    const inPaid = gap <= 0;
    const payout = inPaid ? c.prizes[rank - 1]?.stars ?? 0 : 0;
    const seated = seat?.cup === c.id;

    setText(cupEls.youRank, `#${rank}`);
    const note = cupEls.youNote;
    if (note) {
      note.textContent = '';
      const t = document.createElement('b');
      t.textContent = num(tiq) + ' TIQ';
      note.append(t, document.createTextNode(
        inPaid ? ' · in the prize pool' : ` · Win ${Math.ceil(gap / TIQ_PER_WIN)} more to enter prize pool`,
      ));
      if (seated) note.append(document.createTextNode(' · seat locked'));
    }
    const pay = cupEls.youPay;
    if (pay) {
      pay.classList.toggle('is-zero', payout <= 0);
      const b = pay.querySelector('b');
      if (b) b.textContent = payout > 0 ? num(payout) : '—';
    }
    you.classList.toggle('is-paid', inPaid);
    you.setAttribute('aria-label',
      `You: place ${rank} of the ${field?.length ?? 0} contenders shown, ${num(tiq)} Tactical IQ. ` +
      (inPaid ? 'Inside the paid places.' : `${Math.ceil(gap / TIQ_PER_WIN)} more wins to reach them.`) +
      (seated ? ' Your seat is locked.' : ''));
  }

  function paintCount(c: GrandCup, from: number): void {
    setText(cupEls.count, startsText(c, from));
  }

  /** The key always offers the same thing; the seat's state is stated on the You row
   *  rather than by recolouring the one loud action on the screen. */
  function paintCta(c: GrandCup): void {
    const btn = cupEls.cta;
    if (!btn) return;
    btn.setAttribute('aria-label', seat?.cup === c.id
      ? `${c.name}: your seat is locked. Play your match.`
      : `Enter the ${c.name} and play your match`);
  }

  /** Write the cup's own numbers into the standing geometry. Runs on every entry. */
  function paintCup(c: GrandCup): void {
    const pct = fillPctOf(c);
    setText(cupEls.name, c.name.toUpperCase());
    setText(cupEls.hook, c.hook);
    paintSpecs(c);
    paintRibbon(c);
    setText(cupEls.seats, `${c.players}/${c.maxPlayers} contenders`);
    setText(cupEls.mood, moodOfFill(pct));
    cupEls.track?.setAttribute('aria-valuemax', String(c.maxPlayers));
    cupEls.track?.setAttribute('aria-valuenow', String(c.players));
    cupEls.track?.setAttribute('aria-valuetext', `${c.players} of ${c.maxPlayers} contenders registered`);
    if (cupEls.meter) cupEls.meter.style.width = `${pct}%`;
    paintYou(c);
    paintCount(c, Date.now());
    paintCta(c);
  }

  /** The confirmation drawer, reached only from an unseated key: what a seat costs,
   *  which seat it is, and what locking it opens. */
  function openSeatSheet(): void {
    if (!cup) return;
    const sheet = api.sheet('sheet-stars');
    if (!sheet) return;
    setText(sheet.querySelector<HTMLElement>('#stars-sheet-title'), 'Take your seat?');
    setText(sheet.querySelector<HTMLElement>('#stars-sheet-desc'), `${cup.name} · ${specWords(cup).join(' · ')}`);
    setText(sheet.querySelector<HTMLElement>('#stars-sheet-entry'), cup.entry);
    setText(sheet.querySelector<HTMLElement>('#stars-sheet-seat'), `${cup.players} / ${cup.maxPlayers}`);
    setText(sheet.querySelector<HTMLElement>('#stars-sheet-start'), formatCountdown(cup.startsAt));
    impact('light');
    api.sheets.open(sheet);
  }

  /** Locking the seat fills the room by one on this device, then enters the bracket. */
  function lockSeat(): void {
    if (!cup) return;
    if (seat?.cup !== cup.id) {
      seat = writeSeat(cup.id);
      if (cup.players < cup.maxPlayers) cup.players += 1;
      paintCup(cup);
      impact('medium');
      notify('success');
    }
    api.sheets.close();
    api.queue();
  }

  cupEls.cta?.addEventListener('click', () => {
    impact('light');
    // Already entered: the key means play, so it does not route through a drawer first.
    if (cup && seat?.cup === cup.id) api.queue();
    else openSeatSheet();
  });
  elOf('stars-sheet-yes')?.addEventListener('click', lockSeat);

  function tickCup(): void {
    if (cup) paintCount(cup, Date.now());
  }

  /** Fetch the staged cup once, then keep repainting it: re-entry costs no rebuild. */
  async function loadCup(): Promise<void> {
    startTick();
    if (!cup) {
      try {
        cup = await getGrandCup();
      } catch {
        cup = null;
        return;
      }
      // A seat this device already holds is one of the contenders the seed counts
      // out: without this, a seated player would be told the room is a seat smaller
      // than it showed when they took it.
      if (seat?.cup === cup.id && cup.players < cup.maxPlayers) cup.players += 1;
      try {
        field = await getArenaStandings(cup, FIELD_ROWS);
      } catch {
        field = null;
      }
      paintField();
    }
    paintCup(cup);
  }

  function startTick(): void {
    if (tick) return;
    tick = window.setInterval(() => {
      if (isRanksVisible()) {
        paintSeason();
        if (board === 'nations' && natCup) {
          const pill = document.querySelector<HTMLElement>('[data-nat-cup]');
          if (pill) pill.textContent = natPillText(natCup);
        }
      }
      if (isArenaVisible()) tickCup();
    }, 1000);
  }

  /* ---------- IQ boards (Top Minds | Nations IQ) ----------
  /* ---------- IQ boards (Top Minds | Nations IQ) ----------
     No floating / absolute "you" bar. The user's standing lives in #solo-standing,
     an in-flow summary module directly under the board tabs. The ladder itself is a
     pure list: the podium owns #1-3, so its rows start at #4. */

  async function loadBoard(which: Board): Promise<void> {
    if (which === 'guilds') loadSquads();
    else if (which === 'nations') await loadNations();
    else await loadMinds();
    loadedBoard[which] = true;
  }

  const podiumOf = (rank: number): '' | 'gold' | 'silver' | 'bronze' =>
    rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';

  /** The ranks screen always has an ISO code in hand, so the emoji tier is skipped. */
  function flagBadge(code: string | null): HTMLElement {
    return flagPhoto(code, 'fp-badge');
  }

  /* ---------- Top 3 clay podium ---------- */

  interface PodiumEntry {
    rank: number;
    name: string;
    score: string;
    /** Nation entry: the flag photo, with the ISO chip as its own fallback. */
    code?: string;
    /** Guild / player entry: a single-letter clay medallion. */
    letter?: string;
    /** Mind tiers only exist on the personal boards — a guild's 18k is not a mind. */
    tier?: MindTier;
    tierLabel?: string;
    /** Weekly TIQ movement, rendered as a chip rather than left to the trend arrow. */
    delta?: number;
    /** The ladder no longer carries #1-3, so a board whose rows have actions must move them up here. */
    action?: HTMLElement;
    onTap?: () => void;
  }

  /**
   * Card order is avatar → name → tier → TIQ → delta → pillar. The pillar stays the
   * last child because it is the card's base: appending the join key after it floats
   * the step into the middle of the card.
   */
  function podiumCard(e: PodiumEntry): HTMLElement {
    const card = document.createElement('div');
    card.className = `pod-card ${podiumOf(e.rank)}`;
    card.dataset.rank = String(e.rank);
    if (e.tier) card.dataset.tier = e.tier;
    card.setAttribute('role', 'listitem');
    const said = [
      e.tierLabel ? `${e.tierLabel}, ` : '',
      `${e.score} Tactical IQ`,
      e.delta ? `${signed(e.delta)} this week` : '',
    ].join('');
    card.setAttribute('aria-label', `Rank ${e.rank}: ${e.name}, ${said}`);

    if (e.rank === 1) {
      const holo = document.createElement('span');
      holo.className = 'pod-holo';
      holo.setAttribute('aria-hidden', 'true');
      card.append(holo, svgIcon('#i-crown', 'pod-crown'));
    }

    const av = document.createElement('span');
    av.className = 'pod-av';
    av.setAttribute('aria-hidden', 'true');
    if (e.code) {
      av.append(flagBadge(e.code));
    } else {
      av.textContent = (e.letter ?? e.name).replace(/^@/, '').slice(0, 1).toUpperCase();
    }

    const nm = document.createElement('span');
    nm.className = 'pod-name';
    nm.textContent = e.name;
    nm.title = e.name;

    const tier = document.createElement('span');
    tier.className = 'pod-tier';
    tier.textContent = e.tierLabel ?? '';
    if (!e.tierLabel) tier.hidden = true;

    const iq = document.createElement('span');
    iq.className = 'pod-iq';
    iq.append(svgIcon('#i-brain', 'pod-tiq'));
    const iqN = document.createElement('b');
    iqN.textContent = e.score;
    iq.append(iqN);
    iq.title = `${e.score} Tactical IQ`;

    const delta = document.createElement('span');
    delta.className = e.delta ? `pod-delta ${e.delta > 0 ? 'up' : 'down'}` : 'pod-delta';
    delta.textContent = e.delta ? signed(e.delta) : '';
    if (!e.delta) delta.hidden = true;
    else delta.title = `${signed(e.delta)} Tactical IQ this week`;

    const step = document.createElement('span');
    step.className = 'pod-step';
    step.setAttribute('aria-hidden', 'true');
    const stepN = document.createElement('b');
    stepN.textContent = String(e.rank);
    step.append(stepN);

    card.append(av, nm, tier, iq);
    if (e.delta) card.append(delta);
    if (e.action) card.append(e.action);
    card.append(step);
    if (e.onTap) {
      card.classList.add('is-tappable');
      card.tabIndex = 0;
      card.addEventListener('click', e.onTap);
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          e.onTap?.();
        }
      });
    }
    return card;
  }

  /** "PEAK MINDS · SEASON 4" — the band's caption, kept outside the role=list it labels. */
  function podBand(): HTMLElement | null {
    const host = podiumEl;
    if (!host) return null;
    const existing = document.getElementById('pod-band');
    if (existing) return existing;
    const t = document.createElement('h2');
    t.id = 'pod-band';
    t.className = 'pod-band';
    host.parentNode?.insertBefore(t, host);
    return t;
  }

  function paintPodium(entries: PodiumEntry[]): void {
    const host = podiumEl;
    if (!host) return;
    host.textContent = '';
    const band = podBand();
    const top = entries.filter((e) => e.rank >= 1 && e.rank <= 3);
    if (!top.length) {
      host.hidden = true;
      if (band) band.hidden = true;
      return;
    }
    const boardName = board === 'guilds' ? 'Intellect Guilds' : board === 'nations' ? 'Nations IQ' : 'Top Minds';
    host.setAttribute('aria-label', `Top ${top.length} on ${boardName}`);
    if (band) {
      band.textContent = `Peak minds · Season ${seasonOf(Date.now()).no}`;
      band.hidden = false;
    }
    host.append(...top.map(podiumCard));
    host.hidden = false;
  }

  /** Shared ladder row: rank crest · identity · tabular score · right-edge action. */
  function rankCrest(rank: number): HTMLElement {
    const rk = document.createElement('span');
    rk.className = 'lb-rank';
    const n = document.createElement('b');
    n.textContent = String(rank);
    rk.append(n);
    return rk;
  }

  /** `delta` is optional so the squad ladder keeps its single-line score cell. */
  function scoreCell(points: string, title: string, delta = 0): HTMLElement {
    const pt = document.createElement('span');
    pt.className = 'lb-score';
    const line = document.createElement('span');
    line.className = 'lb-line';
    line.append(svgIcon('#i-brain', 'lb-tiq'));
    const num = document.createElement('b');
    num.textContent = points;
    line.append(num);
    pt.append(line);
    const d = document.createElement('small');
    d.className = delta ? `lb-delta ${delta > 0 ? 'up' : 'down'}` : 'lb-delta';
    d.textContent = delta ? signed(delta) : '';
    d.title = delta ? `${signed(delta)} Tactical IQ this week` : '';
    if (!delta) d.hidden = true;
    pt.append(d);
    pt.title = title;
    return pt;
  }

  interface LadderRow {
    rank: number;
    code: string;
    name: string;
    sub: string | null;
    points: string;
    /** The numeric TIQ behind `points`: the tier, the delta and the read all derive from it. */
    tiq: number;
    trend: Trend;
    me: boolean;
    /** Mind tiers describe a person, not a country aggregate, so boards opt in. */
    tiered?: boolean;
    /** Nations quote a per-mind average under the aggregate the board ranks by. */
    avg?: number;
    /** Stable key for the seeded weekly delta. */
    key?: string;
    /** The climber directly above, so inspection can name the gap it has to close. */
    above?: { name: string; tiq: number } | null;
    wins?: number;
    /** A mind opens its profile sheet; without this a row keeps the inline read. */
    onOpen?: () => void;
  }

  /**
   * Shared ladder row: rank crest · identity · tabular score · trend. Tap opens the
   * inspection read, which is assembled from the row's own numbers — nothing in it
   * is a placeholder waiting for a backend.
   */
  function row(r: LadderRow): HTMLLIElement {
    const { rank, code, name, points, trend, tiered = false } = r;
    const li = document.createElement('li');
    li.className = `rank-row lb-row${r.me ? ' is-you' : ''}`;
    li.dataset.rank = String(rank);
    const trendLabel = trend === 'up' ? 'rising' : trend === 'down' ? 'falling' : 'steady';
    const div = divisionOf(r.tiq);
    const delta = deltaOf(r.key ?? String(rank), r.tiq, trend);
    li.setAttribute('aria-label', `#${rank} ${name} — ${points} Tactical IQ, ${trendLabel}. Activate to inspect.`);
    if (r.me) li.setAttribute('aria-current', 'true');
    if (tiered) li.dataset.tier = div.tier;

    const id = document.createElement('span');
    id.className = 'lb-id';
    id.append(flagBadge(code));
    const txt = document.createElement('span');
    txt.className = 'lb-txt';
    const nmLine = document.createElement('span');
    nmLine.className = 'lb-nm';
    const nm = document.createElement('span');
    nm.className = 'lb-name';
    nm.textContent = name;
    nm.title = name;
    nmLine.append(nm);
    txt.append(nmLine);
    /* The tier rides the second line, ahead of the detail: at 320 the identity
       column is ~90px, and a clipped name is a worse trade than a clipped win count. */
    if (tiered || r.sub) {
      const s = document.createElement('span');
      s.className = 'lb-sub';
      if (tiered) {
        const tier = document.createElement('span');
        tier.className = 'lb-tier';
        tier.textContent = div.label;
        s.append(tier);
      }
      if (r.sub) {
        const st = document.createElement('span');
        st.className = 'lb-sub-t';
        st.textContent = r.sub;
        s.append(st);
      }
      txt.append(s);
    }
    id.append(txt);

    const act = document.createElement('span');
    act.className = 'lb-act';
    const tr = document.createElement('span');
    tr.className = `tr ${trend}`;
    tr.textContent = trendArrow(trend);
    tr.title = trendLabel;
    tr.setAttribute('aria-hidden', 'true');
    act.append(tr);

    const cell = scoreCell(points, `${points} Tactical IQ`, r.avg ? 0 : delta);
    if (r.avg) {
      const avg = document.createElement('small');
      avg.className = 'lb-avg';
      avg.textContent = `AVG ${r.avg.toLocaleString('en-US')}`;
      avg.title = `${r.avg.toLocaleString('en-US')} average Tactical IQ per mind`;
      cell.append(avg);
    }

    li.append(rankCrest(rank), id, cell, act);

    li.tabIndex = 0;

    /* A mind has a profile to open, so its row goes straight there. A nation does not —
       it is an aggregate — so that board keeps the inline inspection read instead. */
    if (r.onOpen) {
      const run = (): void => { r.onOpen?.(); };
      li.setAttribute('aria-label', `#${rank} ${name} — ${points} Tactical IQ, ${trendLabel}. Activate to open the mind profile.`);
      li.addEventListener('click', run);
      li.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          run();
        }
      });
      return li;
    }

    /* ---- inspection read: the four numbers a row can honestly tell you ---- */
    const peek = document.createElement('span');
    peek.className = 'lb-peek';
    peek.hidden = true;
    const facts: string[][] = [];
    if (tiered) facts.push(['Tier', div.label]);
    if (r.wins !== undefined) facts.push(['Wins', String(r.wins)]);
    if (r.wins && r.wins > 0) facts.push(['TIQ / win', Math.round(r.tiq / r.wins).toLocaleString('en-US')]);
    if (r.above && r.above.tiq > r.tiq) facts.push([`To pass ${r.above.name}`, (r.above.tiq - r.tiq).toLocaleString('en-US')]);
    facts.push(['Week', delta ? `${signed(delta)} TIQ` : 'flat']);
    for (const [k, v] of facts) {
      const cell = document.createElement('span');
      cell.className = 'lb-fact';
      const key = document.createElement('small');
      key.textContent = k;
      const val = document.createElement('b');
      val.textContent = v;
      cell.append(key, val);
      peek.append(cell);
    }
    li.append(peek);

    const open = (on: boolean): void => {
      li.classList.toggle('is-open', on);
      peek.hidden = !on;
      li.setAttribute('aria-expanded', String(on));
    };
    li.setAttribute('aria-expanded', 'false');
    li.addEventListener('click', () => { impact('light'); open(!li.classList.contains('is-open')); });
    li.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        impact('light');
        open(!li.classList.contains('is-open'));
      }
    });
    return li;
  }

  /** The compact "Your Standing" row — used by Nations IQ, where the hero strip is
      the nation's card and this one stays personal. */
  function paintSoloStanding(opts: {
    rankText: string;
    percentText: string | null;
    score: number;
    extraSub: string | null;
  }): void {
    const host = soloStandingEl();
    if (!host) return;
    host.hidden = false;
    host.textContent = '';
    // The compact row is the nations form; Top Minds paints the tall hero card.
    host.classList.remove('mh');

    const av = document.createElement('span');
    av.className = 'standing-avatar';
    av.setAttribute('aria-hidden', 'true');
    const h = youHandle() ?? 'Y';
    av.textContent = h.replace(/^@/, '').slice(0, 1).toUpperCase() || 'Y';

    const main = document.createElement('span');
    main.className = 'standing-main';
    const name = document.createElement('b');
    name.className = 'standing-name';
    name.textContent = youLabel();
    name.title = youLabel();
    const sub = document.createElement('small');
    sub.className = 'standing-sub';
    const detail = [opts.rankText !== '-' ? opts.rankText : '', opts.percentText ?? '', myRecord(), opts.extraSub ?? '']
      .filter((p) => p.length > 0)
      .join(' · ');
    sub.textContent = detail;
    main.append(name, sub);

    const score = document.createElement('span');
    score.className = 'standing-score';
    score.append(svgIcon('#i-brain', 'tiq'));
    const num = document.createElement('b');
    num.textContent = opts.score.toLocaleString('en-US');
    score.append(num);
    score.title = `${opts.score.toLocaleString('en-US')} Tactical IQ`;
    score.setAttribute('aria-label', `${opts.score.toLocaleString('en-US')} Tactical IQ, ${detail}`);

    host.append(av, main, score);
    host.setAttribute('aria-label', `Your Standing: ${youLabel()}, ${detail}, ${opts.score.toLocaleString('en-US')} Tactical IQ`);
  }

  /**
   * The four mind axes, each read from a signal the local save actually carries —
   * win rate, volume, how many of those races were against a person rather than the
   * bot, and how much streak survived the losses. `Traps` is the honest weak point:
   * the save counts opponents, not mines placed, so it is a proxy until the backend
   * reports hazard play.
   */
  function mindAxes(): MindAxis[] {
    const s = profile.stats;
    const g = Math.max(0, s.games);
    const online = s.modes.online ?? 0;
    return [
      { label: 'Foresight', icon: '#i-brain', pct: clampPct(g ? s.wins / g : 0), value: `${s.wins}/${g} races won`, hint: 'Win rate across every race' },
      { label: 'Tempo', icon: '#i-move', pct: clampPct(g / 40), value: `${g} races played`, hint: 'Races played — 40 fills the bar' },
      { label: 'Traps', icon: '#i-mine', pct: clampPct(g ? online / g : 0), value: `${online} vs a mind`, hint: 'Share of races against real minds' },
      { label: 'Compose', icon: '#i-shield', pct: clampPct(s.best + s.losses > 0 ? s.best / (s.best + s.losses) : 0), value: `${s.best}W streak · ${s.losses}L`, hint: 'Best streak held against losses' },
    ];
  }

  /**
   * Your last five, read from the only history the save keeps: a win streak is bounded
   * by the loss that ended the one before it, so everything past it is unrecorded
   * rather than invented.
   */
  function myForm(): FormCell[] {
    const s = profile.stats;
    const wins = Math.min(5, s.streak);
    const loss = s.losses > 0 && s.streak < s.games && wins < 5 ? 1 : 0;
    const known = wins + loss;
    const out: FormCell[] = [];
    for (let i = 5 - known; i > 0; i--) out.push('u');
    if (loss) out.push('l');
    for (let i = 0; i < wins; i++) out.push('w');
    return out;
  }

  /** Momentum, since the save has no weekly history of its own to quote. */
  const myTrend = (): Trend =>
    profile.stats.wins > profile.stats.losses ? 'up' : profile.stats.losses > profile.stats.wins ? 'down' : 'same';

  /** Jump the scroller to a rank and flash it, so a rival chip is a real link. */
  function spotRank(rank: number): void {
    const sc = document.getElementById('ranks-scroll');
    const target = sc?.querySelector<HTMLElement>(`[data-rank="${rank}"]`);
    if (!sc || !target) return;
    target.scrollIntoView({ block: 'center', behavior: motionReduced() ? 'auto' : 'smooth' });
    target.classList.add('is-spot');
    window.setTimeout(() => target.classList.remove('is-spot'), 1400);
    impact('light');
  }

  /**
   * The Top Minds hero card: who you are on this ladder (percentile ring · tier ·
   * TIQ), the four-axis read of your own play, the next division as a sentence you
   * can act on, and one coral key that leaves for the launcher.
   */
  function paintMindsStanding(rows: PlayerRow[] | null): void {
    const host = soloStandingEl();
    if (!host) return;
    host.textContent = '';
    host.classList.add('mh');
    host.hidden = false;

    const tiq = myTrophyScore();
    const div = divisionOf(tiq);
    const field = rows?.length ?? 0;
    const ahead = rows ? rows.filter((p) => p.points > tiq).length : 0;
    const onBoard = profile.stats.games > 0 && field > 0;
    const myRank = ahead + 1;
    const pct = onBoard ? Math.max(1, Math.round((myRank / (field + 1)) * 100)) : 100;
    const delta = deltaOf('you', tiq, myTrend());

    /* ring: one shared arc, so the hero card and the mind sheet fill the same way */
    const av = document.createElement('b');
    const h = youHandle() ?? 'Y';
    av.textContent = h.replace(/^@/, '').slice(0, 1).toUpperCase() || 'Y';
    const ring = percentRing(onBoard ? pct : 0, av);

    const idWrap = document.createElement('span');
    idWrap.className = 'mh-id';
    const line = document.createElement('b');
    line.className = 'mh-line';
    line.textContent = `You · ${div.label}`;
    const pctLine = document.createElement('small');
    pctLine.className = 'mh-pct';
    pctLine.textContent = !onBoard
      ? 'Unranked · play to climb'
      : pct >= 100
        ? `Below the top ${field}`
        : `Top ${pct}% of minds`;
    idWrap.append(line, pctLine);

    const score = document.createElement('span');
    score.className = 'mh-score';
    score.append(svgIcon('#i-brain', 'tiq'));
    const num = document.createElement('b');
    num.textContent = tiq.toLocaleString('en-US');
    score.append(num);
    if (delta) {
      const d = document.createElement('small');
      d.className = `lb-delta ${delta > 0 ? 'up' : 'down'}`;
      d.textContent = signed(delta);
      score.append(d);
    }
    score.title = `${tiq.toLocaleString('en-US')} Tactical IQ`;
    score.setAttribute('aria-label', `${tiq.toLocaleString('en-US')} Tactical IQ, ${signed(delta)} this week`);

    const top = document.createElement('span');
    top.className = 'mh-top';
    top.append(ring, idWrap, score);

    const axes = document.createElement('span');
    axes.className = 'mh-axes';
    for (const a of mindAxes()) {
      const cell = document.createElement('span');
      cell.className = 'mh-axis';
      cell.title = a.hint;
      const label = document.createElement('small');
      label.textContent = a.label;
      const track = document.createElement('span');
      track.className = 'mh-track';
      const fill = document.createElement('i');
      fill.style.width = `${a.pct}%`;
      track.append(fill);
      cell.append(label, track);
      cell.setAttribute('aria-label', `${a.label} ${a.pct} percent, ${a.hint}`);
      axes.append(cell);
    }

    /* progress to the next division, in wins — the unit the CTA can actually deliver */
    const gap = div.next > tiq ? div.next - tiq : 0;
    const wins = gap > 0 ? Math.ceil(gap / TIQ_PER_WIN) : 0;
    const span = div.next > 0 ? div.next - TIER_BAND[div.tier][0] : 1;
    const through = span > 0 ? Math.max(0, Math.min(100, Math.round(((tiq - TIER_BAND[div.tier][0]) / span) * 100))) : 100;
    const prog = document.createElement('span');
    prog.className = 'mh-prog';
    const pTrack = document.createElement('span');
    pTrack.className = 'mh-ptrack';
    const pFill = document.createElement('i');
    pFill.style.width = `${through}%`;
    pTrack.append(pFill);
    const pText = document.createElement('small');
    pText.className = 'mh-ptext';
    pText.textContent = wins
      ? `${wins} win${wins === 1 ? '' : 's'} to ${divisionOf(div.next).label} — your crest starts glowing.`
      : 'Peak division. Hold it against the ladder.';
    prog.append(pTrack, pText);

    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'mh-cta';
    cta.textContent = 'Climb now';
    cta.setAttribute('aria-label', 'Climb now — go and start a race');
    cta.addEventListener('click', () => {
      impact('medium');
      api.router.go('home');
    });

    host.append(top, axes, prog, cta);
    host.setAttribute('aria-label', `Your Standing: ${youLabel()}, ${div.label}, ${tiq.toLocaleString('en-US')} Tactical IQ, ${pctLine.textContent}`);

    /* Loss aversion: the single climber one rung above you, tappable to their row. */
    const rival = rows && ahead > 0 ? rows[ahead - 1] : null;
    const strip = rival && rival.points > tiq ? rivalStrip(rival, rival.points - tiq, ahead) : null;
    const pane = panes.minds;
    if (pane && strip) {
      const old = pane.querySelector('.rival');
      if (old) old.remove();
      pane.prepend(strip);
    }
  }

  /** The gap made personal, and one tap away from the row it names. */
  function rivalStrip(rival: PlayerRow, gap: number, rank: number): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rival';
    const dot = document.createElement('i');
    dot.className = 'rival-dot';
    dot.setAttribute('aria-hidden', 'true');
    const txt = document.createElement('span');
    txt.className = 'rival-t';
    txt.textContent = `${rival.name} is ${gap.toLocaleString('en-US')} TIQ sharper today — close the gap.`;
    const go = document.createElement('span');
    go.className = 'rival-go';
    go.textContent = 'Jump';
    b.append(dot, txt, go);
    b.setAttribute('aria-label', `Jump to rank ${rank}, ${rival.name}`);
    b.addEventListener('click', () => spotRank(rank));
    return b;
  }

  /* ---------- the mind sheet: one ladder name's cognitive profile (bottom clay sheet) ----------
     One panel, two shapes. A *mind* gets the four-axis read; a *guild* never does, because
     a channel's combined TIQ is not a mind — it gets density and its real join / invite key.
     Both shapes carry only actions the local backend can actually perform. */

  const msEls = {
    sheet: document.getElementById('sheet-mind'),
    av: document.getElementById('ms-av'),
    flag: document.getElementById('ms-flag'),
    name: document.getElementById('ms-name'),
    tier: document.getElementById('ms-tier'),
    body: document.getElementById('ms-body'),
    challenge: document.getElementById('ms-challenge') as HTMLButtonElement | null,
    guild: document.getElementById('ms-guild') as HTMLButtonElement | null,
  };

  /** The last field each board loaded — the percentile ring has to be a rank over something. */
  let mindsField: PlayerRow[] = [];
  let guildField: RankedSquad[] = [];
  /** What the two keys at the foot of the open sheet are allowed to do right now. */
  let msPending: { kind: 'mind'; name: string; tiq: number } | { kind: 'guild'; squad: RankedSquad } | null = null;

  function msHead(letter: string, code: string | null, name: string, tier: string): void {
    const { av, flag, name: nm, tier: tr } = msEls;
    if (av) av.textContent = letter;
    if (flag) {
      flag.textContent = '';
      if (code) flag.append(flagPhoto(code, 'fp-ms'));
    }
    if (nm) {
      nm.textContent = name;
      nm.title = name;
    }
    if (tr) {
      tr.textContent = tier;
      tr.title = tier;
    }
  }

  function msHero(points: string, delta: number, pct: number, sub: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'ms-hero';
    const col = document.createElement('span');
    col.className = 'ms-hero-id';
    const iq = document.createElement('span');
    iq.className = 'ms-iq';
    iq.append(svgIcon('#i-brain', 'tiq'));
    const num = document.createElement('b');
    num.textContent = points;
    iq.append(num);
    if (delta) {
      const d = document.createElement('small');
      d.className = `lb-delta ${delta > 0 ? 'up' : 'down'}`;
      d.textContent = signed(delta);
      iq.append(d);
    }
    const line = document.createElement('small');
    line.className = 'ms-hero-sub';
    line.textContent = sub;
    col.append(iq, line);
    const inner = document.createElement('b');
    inner.textContent = `${pct}%`;
    const ringCol = document.createElement('span');
    ringCol.className = 'ms-ring-col';
    const cap = document.createElement('small');
    cap.className = 'ms-ring-c';
    cap.textContent = 'Percentile';
    ringCol.append(percentRing(pct, inner, 'ms-ring'), cap);
    wrap.append(col, ringCol);
    return wrap;
  }

  /** Caption over content, in the same engraved-cap voice the podium band uses. */
  function msSection(title: string, ...kids: HTMLElement[]): HTMLElement {
    const wrap = document.createElement('section');
    wrap.className = 'ms-block';
    const h = document.createElement('h3');
    h.className = 'ms-h';
    h.textContent = title;
    wrap.append(h, ...kids);
    return wrap;
  }

  function msAxisList(axes: MindAxis[]): HTMLElement {
    const list = document.createElement('div');
    list.className = 'ms-axes';
    for (const a of axes) {
      const line = document.createElement('div');
      line.className = 'ms-axis';
      line.title = a.hint;
      const head = document.createElement('span');
      head.className = 'ms-axis-h';
      head.append(svgIcon(a.icon, 'ms-axis-ico'));
      const label = document.createElement('small');
      label.textContent = a.label;
      const value = document.createElement('b');
      value.textContent = a.value;
      head.append(label, value);
      const track = document.createElement('span');
      track.className = 'mh-track ms-track';
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-label', `${a.label}: ${a.value}`);
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(a.pct));
      const fill = document.createElement('i');
      fill.style.width = `${a.pct}%`;
      track.append(fill);
      line.append(head, track);
      list.append(line);
    }
    return list;
  }

  function msFormStrip(form: FormCell[], caption: string): HTMLElement {
    const rowEl = document.createElement('div');
    rowEl.className = 'ms-form';
    const dots = document.createElement('span');
    dots.className = 'ms-dots';
    const read = form.map((c) => (c === 'w' ? 'W' : c === 'l' ? 'L' : 'unrecorded')).join(', ');
    dots.setAttribute('aria-label', `Last five, newest on the right: ${read}.`);
    for (const c of form) {
      const d = document.createElement('i');
      d.className = `ms-dot ${c}`;
      d.textContent = c === 'w' ? 'W' : c === 'l' ? 'L' : '·';
      dots.append(d);
    }
    const cap = document.createElement('small');
    cap.className = 'ms-form-c';
    cap.textContent = caption;
    rowEl.append(dots, cap);
    return rowEl;
  }

  function msStats(pairs: [string, string][]): HTMLElement {
    const grid = document.createElement('div');
    grid.className = 'ms-stats';
    for (const [k, v] of pairs) {
      const cell = document.createElement('div');
      cell.className = 'ms-stat';
      const key = document.createElement('small');
      key.textContent = k;
      const val = document.createElement('b');
      val.textContent = v;
      cell.append(key, val);
      grid.append(cell);
    }
    return grid;
  }

  function msFine(text: string): HTMLElement {
    const p = document.createElement('p');
    p.className = 'fine ms-fine';
    p.textContent = text;
    return p;
  }

  /** The two clay keys never change shape — only what they can honestly do changes. */
  function msActions(kind: 'mind' | 'guild', label: string, hint: string): void {
    const ch = msEls.challenge;
    const gu = msEls.guild;
    if (ch) {
      const span = ch.querySelector<HTMLElement>('span');
      if (span) span.textContent = label;
      ch.setAttribute('aria-label', hint);
    }
    if (gu) {
      gu.setAttribute('aria-label', kind === 'guild' ? 'View this guild in the squad sheet' : 'View the Intellect Guilds board');
    }
  }

  function openMind(p: PlayerRow, rank: number): void {
    const el = msEls.sheet;
    const body = msEls.body;
    if (!el || !body) return;
    const div = divisionOf(p.points);
    const field = mindsField.length;
    const pct = field > 0 ? Math.max(1, Math.min(99, Math.round((rank / (field + 1)) * 100))) : 100;
    const tiq = p.points.toLocaleString('en-US');
    msPending = { kind: 'mind', name: p.name, tiq: p.points };
    el.dataset.tier = div.tier;
    msHead(p.name.slice(0, 1).toUpperCase() || '?', p.countryCode, p.name, div.label);
    el.setAttribute('aria-label', `Mind profile: ${p.name}, ${div.label}, ${tiq} Tactical IQ`);
    body.textContent = '';
    body.append(
      msHero(tiq, deltaOf(p.id, p.points, p.trend), pct, `#${rank} of ${field} minds · ${p.wins} wins`),
      msSection('Mind profile', msAxisList(rivalAxes(p))),
      msSection('Form', msFormStrip(rivalForm(p.id, p.trend), 'Season preview · newest on the right')),
      msFine(`Beat ${p.name}'s ${tiq} TIQ: Challenge mind starts a race, and every win is 140 TIQ.`),
    );
    msActions('mind', 'Challenge mind', `Challenge mind: start a race against ${p.name}'s ${tiq} TIQ`);
    impact('light');
    api.sheets.open(el);
  }

  function openGuild(s: RankedSquad): void {
    const el = msEls.sheet;
    const body = msEls.body;
    if (!el || !body) return;
    const mine = getMySquad()?.id === s.id;
    const act = squadAction(s, mine);
    const field = guildField.length;
    const pct = field > 0 ? Math.max(1, Math.min(99, Math.round((s.rank / (field + 1)) * 100))) : 100;
    const kind = squadKind(s);
    const label = s.name || s.handle.replace(/^@/, '');
    const contrib = mine ? getMyContribution() : 0;
    msPending = { kind: 'guild', squad: s };
    delete el.dataset.tier;
    msHead(squadLetter(s), null, label, `${kind === 'channel' ? 'Telegram channel' : 'Telegram group'} · #${s.rank}`);
    el.setAttribute('aria-label', `Guild profile: ${label}, ${s.trophies.toLocaleString('en-US')} combined Tactical IQ`);
    body.textContent = '';
    body.append(
      msHero(s.trophies.toLocaleString('en-US'), 0, pct, `#${s.rank} of ${field} guilds`),
      msSection(
        'Guild read',
        msStats([
          ['Members', s.members.toLocaleString('en-US')],
          ['AVG per mind', avgOf(s).toLocaleString('en-US')],
          ['Rank', `#${s.rank}`],
          ['Yours', contrib > 0 ? contrib.toLocaleString('en-US') : '—'],
        ]),
      ),
      msFine('A guild carries no mind tier — its TIQ is the sum of the minds inside it.'),
    );
    msActions('guild', act.label === 'Invite' ? 'Invite squad' : `Join ${label}`, act.hint);
    impact('light');
    api.sheets.open(el);
  }

  msEls.challenge?.addEventListener('click', () => {
    const p = msPending;
    if (!p) return;
    if (p.kind === 'mind') {
      impact('medium');
      api.sheets.close();
      api.router.go('home');
      return;
    }
    squadAction(p.squad, getMySquad()?.id === p.squad.id).run();
  });

  msEls.guild?.addEventListener('click', () => {
    const p = msPending;
    impact('light');
    if (p?.kind === 'guild') {
      openSquadSheet();
      return;
    }
    api.sheets.close();
    selectBoard('guilds');
  });

  /**
   * On Nations IQ the hero strip above already carries the flag, the rank and the
   * gap, so this card stops repeating them and states the only fact that is
   * genuinely personal: your own record and your own TIQ. With no country bound the
   * hero asks for one, so the card steps out entirely.
   */
  function paintNationsStanding(rows: CountryRow[] | null): void {
    const host = soloStandingEl();
    if (!host) return;
    const code = profile.country;
    const hit = code && rows ? rows.find((c) => c.code === code) : undefined;
    if (!code || !hit) {
      host.hidden = true;
      return;
    }
    paintSoloStanding({
      rankText: '-',
      percentText: null,
      score: myTrophyScore(),
      extraSub: null,
    });
  }

  /** A one-line event banner; the countdown is the Grand Cup's own kickoff. */
  const natPillText = (event: GrandCup | null): string =>
    event
      ? `Nations Cup · ${formatCountdown(event.startsAt)} to kickoff · wins count double for your flag.`
      : 'Nations Cup · bracket opens soon · wins count double for your flag.';

  function nationsPill(cup: GrandCup | null): HTMLElement {
    const p = document.createElement('p');
    p.className = 'nat-pill';
    const dot = document.createElement('i');
    dot.className = 'ml-pulse';
    dot.setAttribute('aria-hidden', 'true');
    const t = document.createElement('span');
    t.className = 'nat-pill-t';
    t.dataset.natCup = '1';
    t.textContent = natPillText(cup);
    p.append(dot, t);
    return p;
  }

  /**
   * Own-nation strip: where the flag sits, how far the nation above it is, and what
   * the bar means. With no country bound it asks for one rather than showing an
   * empty row — the same route the compact standing card uses.
   */
  function nationsHero(rows: CountryRow[]): HTMLElement {
    const card = document.createElement('section');
    card.className = 'nat-hero';
    const code = profile.country;

    if (!code) {
      card.append(flagPhoto(null, 'fp-lg'));
      const txt = document.createElement('span');
      txt.className = 'nat-hero-txt';
      const b = document.createElement('b');
      b.textContent = 'Your flag is not on the board yet';
      const s = document.createElement('small');
      s.textContent = 'Pick a country and every race you win starts counting for it.';
      txt.append(b, s);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nat-hero-btn';
      btn.textContent = 'Set flag';
      btn.setAttribute('aria-label', 'Pick your country in Profile');
      btn.addEventListener('click', () => { impact('light'); api.router.go('profile'); });
      card.append(txt, btn);
      return card;
    }

    const hit = rows.find((c) => c.code === code);
    const above = hit ? rows.find((c) => c.rank === hit.rank - 1) : undefined;
    const nm = nameOf(code) || code;

    card.append(flagPhoto(code, 'fp-lg'));
    const txt = document.createElement('span');
    txt.className = 'nat-hero-txt';
    const b = document.createElement('b');
    b.textContent = hit
      ? `${nm}'s minds rank #${hit.rank} — every win you take raises the average`
      : `${nm} is warming up — no ranked races yet`;
    const s = document.createElement('small');
    s.textContent = hit
      ? (above ? `${(above.points - hit.points).toLocaleString('en-US')} TIQ behind ${above.name}` : 'No nation above you — hold the line.')
      : 'Race to put your country on the ladder.';
    txt.append(b, s);
    card.append(txt);

    if (hit) {
      const bar = document.createElement('span');
      bar.className = 'mh-ptrack is-cyan';
      const fill = document.createElement('i');
      fill.style.width = above
        ? `${Math.max(4, Math.min(100, Math.round((hit.points / above.points) * 100)))}%`
        : '100%';
      bar.append(fill);
      bar.setAttribute('role', 'presentation');
      card.append(bar);
    }
    return card;
  }

  function nationsFoot(): HTMLElement {
    const p = document.createElement('p');
    p.className = 'nat-foot';
    p.textContent = 'Sharpest nations. Your flag needs your brain.';
    return p;
  }

  async function loadNations(): Promise<void> {
    const el = panes.nations;
    if (!el) return;
    if (!loadedBoard.nations) el.innerHTML = skel(6);
    let rows: CountryRow[];
    let event: GrandCup;
    try {
      const pair = await Promise.all([getCountryRanking(), getGrandCup()]);
      rows = pair[0];
      event = pair[1];
    } catch {
      el.innerHTML = empty('Rankings unavailable. Check your connection and try again.');
      paintNationsStanding(null);
      return;
    }
    if (!rows.length) {
      el.innerHTML = empty('No countries ranked yet.');
      paintNationsStanding([]);
      return;
    }
    natCup = event;
    paintPodium(rows.slice(0, 3).map((c) => ({
      rank: c.rank,
      name: c.name,
      score: c.points.toLocaleString('en-US'),
      code: c.code,
      delta: deltaOf(c.code, c.points, c.trend),
    })));
    el.textContent = '';
    el.append(nationsHero(rows), nationsPill(natCup));
    const ol = document.createElement('ol');
    ol.className = 'rank-list';
    for (const c of rows.slice(3)) {
      const up = rows[c.rank - 2];
      const f = fieldOf(c.code, c.points);
      const d = deltaOf(c.code, c.points, c.trend);
      ol.append(row({
        rank: c.rank,
        code: c.code,
        name: c.name,
        sub: `${compactCount(f.minds)} minds${d ? ` · ${signed(d)} wk` : ''}`,
        points: c.points.toLocaleString('en-US'),
        tiq: c.points,
        trend: c.trend,
        me: profile.country === c.code,
        avg: f.avg,
        key: c.code,
        above: up ? { name: up.name, tiq: up.points } : null,
      }));
    }
    el.append(ol, nationsFoot());
    boardStats.nations = { loaded: true, rows: rows.length, points: rows.reduce((n, c) => n + c.points, 0) };
    paintNationsStanding(rows);
    paintRanksStats();
  }

  async function loadMinds(): Promise<void> {
    const el = panes.minds;
    if (!el) return;
    if (!loadedBoard.minds) el.innerHTML = skel(6);
    let rows: PlayerRow[];
    try {
      rows = await getPlayerRanking();
    } catch {
      el.innerHTML = empty('Rankings unavailable. Check your connection and try again.');
      paintMindsStanding(null);
      return;
    }
    if (!rows.length) {
      el.innerHTML = empty('No players ranked yet.');
      paintMindsStanding(null);
      return;
    }
    mindsField = rows;
    paintPodium(rows.slice(0, 3).map((p, i) => ({
      rank: i + 1,
      name: p.name,
      score: p.points.toLocaleString('en-US'),
      code: p.countryCode,
      tier: tierOf(p.points),
      tierLabel: divisionOf(p.points).label,
      delta: deltaOf(p.id, p.points, p.trend),
      onTap: () => openMind(p, i + 1),
    })));
    el.textContent = '';
    const ol = document.createElement('ol');
    ol.className = 'rank-list';
    rows.slice(3).forEach((p, i) => {
      const up = rows[i + 2];
      ol.append(row({
        rank: i + 4,
        code: p.countryCode,
        name: p.name,
        sub: `${p.wins} wins`,
        points: p.points.toLocaleString('en-US'),
        tiq: p.points,
        trend: p.trend,
        me: false,
        tiered: true,
        key: p.id,
        wins: p.wins,
        above: up ? { name: up.name, tiq: up.points } : null,
        onOpen: () => openMind(p, i + 4),
      }));
    });
    el.append(ol);
    boardStats.minds = { loaded: true, rows: rows.length, points: rows.reduce((n, p) => n + p.points, 0) };
    paintMindsStanding(rows);
    paintRanksStats();
  }

  /* ---------- Intellect Guilds: Telegram channel / community ranking ---------- */

  /** Bind a guild (or copy an invite for your own) — one spec, used by the row and the podium. */
  function squadAction(s: RankedSquad, mine: boolean): { label: string; mine: boolean; hint: string; run: () => void } {
    if (mine) {
      return { label: 'Invite', mine: true, hint: `Invite to ${s.handle}: copy squad invite`, run: () => inviteSquad(s) };
    }
    return {
      label: 'Join',
      mine: false,
      hint: `Join ${s.handle}`,
      run: () => {
        impact('light');
        if (bindSquadById(s.id) === 'bad-handle') {
          notify('warning');
          return;
        }
        notify('success');
        impact('medium');
        loadSquads();
      },
    };
  }

  /** The compact glass-to-solid key; `cls` lets the ladder and the podium share the behaviour. */
  function squadKey(a: { label: string; mine: boolean; hint: string; run: () => void }, cls: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `${cls} ${a.mine ? 'is-invite' : 'is-join'}`;
    b.textContent = a.label;
    b.setAttribute('aria-label', a.hint);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      a.run();
    });
    return b;
  }

  /** Hexagonal clay crest: lip and face share one clip, two pixels apart, because
      clip-path throws away the box-shadow the rest of the sheet uses for depth. */
  function hexCrest(letter: string, cls: string): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = `hex ${cls}`;
    wrap.setAttribute('aria-hidden', 'true');
    const face = document.createElement('span');
    face.className = 'hex-face';
    const b = document.createElement('b');
    b.textContent = letter;
    face.append(b);
    wrap.append(face);
    return wrap;
  }

  /**
   * A stack of minds, not a roster of faces: the seeded guilds carry a member count
   * and no identities, so the discs read as density and the number says the rest.
   */
  function memberStack(members: number): HTMLElement {
    const s = document.createElement('span');
    s.className = 'gstack';
    s.setAttribute('aria-hidden', 'true');
    const shown = Math.max(1, Math.min(3, members));
    for (let i = 0; i < shown; i++) s.append(document.createElement('i'));
    const rest = document.createElement('b');
    rest.textContent = members > shown ? `+${compactCount(members - shown)}` : String(members);
    s.append(rest);
    return s;
  }

  /** The squad's own TIQ per mind — the density metric a head-count alone hides. */
  const avgOf = (s: { trophies: number; members: number }): number =>
    Math.round(s.trophies / Math.max(1, s.members));

  const guildHeroEl = (): HTMLElement | null => {
    const existing = document.getElementById('guild-hero');
    if (existing) return existing;
    const sc = document.getElementById('ranks-scroll');
    const parent = sc?.parentElement;
    if (!parent || !sc) return null;
    const el = document.createElement('section');
    el.id = 'guild-hero';
    el.className = 'gh';
    el.hidden = true;
    parent.insertBefore(el, sc);
    return el;
  };

  /**
   * Own-guild hero, pinned above the ladder as a flex sibling of the scroller — so
   * it never overlays a row. When a guild is bound it replaces the bottom dock: the
   * screen states your standing in one place, not two.
   */
  function paintGuildHero(): void {
    const host = guildHeroEl();
    if (!host) return;
    const me = isRanksVisible() && board === 'guilds' ? getMySquad() : null;
    if (!me) { host.hidden = true; return; }
    const dock = squadDock();
    if (dock) dock.hidden = true;
    host.hidden = false;
    host.textContent = '';

    const mine = getMyContribution();
    host.append(hexCrest(squadLetter(me), 'gh-crest'));

    const txt = document.createElement('span');
    txt.className = 'gh-txt';
    const top = document.createElement('span');
    top.className = 'gh-top';
    const kick = document.createElement('small');
    kick.className = 'gh-kick';
    kick.textContent = 'My guild';
    const rank = document.createElement('b');
    rank.className = 'gh-rank';
    rank.textContent = `#${me.rank}`;
    top.append(kick, rank);
    const nm = document.createElement('b');
    nm.className = 'gh-name';
    nm.textContent = me.name || me.handle.replace(/^@/, '');
    nm.title = `${me.name} · ${me.handle}`;
    const sub = document.createElement('span');
    sub.className = 'gh-sub';
    /* The stack already carries the head-count, so the density line says only what
       the count cannot: what one mind in this guild is worth on average. */
    const density = document.createElement('small');
    density.textContent = `AVG ${avgOf(me).toLocaleString('en-US')} TIQ per mind`;
    sub.append(memberStack(me.members), density);
    txt.append(top, nm, sub);

    const score = document.createElement('span');
    score.className = 'gh-score';
    const line = document.createElement('span');
    line.className = 'gh-line';
    line.append(svgIcon('#i-brain', 'tiq'));
    const num = document.createElement('b');
    num.textContent = me.trophies.toLocaleString('en-US');
    line.append(num);
    const csub = document.createElement('small');
    csub.textContent = mine > 0 ? `+${mine.toLocaleString('en-US')} yours` : 'fight to contribute';
    score.append(line, csub);
    score.title = `${me.trophies.toLocaleString('en-US')} combined Tactical IQ`;

    const acts = document.createElement('span');
    acts.className = 'gh-acts';
    const invite = document.createElement('button');
    invite.type = 'button';
    invite.className = 'gh-btn is-coral';
    invite.textContent = 'Invite';
    invite.setAttribute('aria-label', `Invite to ${me.handle}: copy squad invite`);
    invite.addEventListener('click', (e) => { e.stopPropagation(); inviteSquad(me); });
    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'gh-btn';
    view.textContent = 'View';
    view.setAttribute('aria-label', `View ${me.handle} squad details`);
    view.addEventListener('click', (e) => { e.stopPropagation(); impact('light'); openSquadSheet(); });
    acts.append(invite, view);

    host.append(txt, score, acts);
    host.setAttribute('aria-label', `My guild: ${me.name}, rank ${me.rank}, ${me.trophies.toLocaleString('en-US')} combined Tactical IQ, ${me.members.toLocaleString('en-US')} minds.`);
  }

  function squadRow(s: RankedSquad, mine: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `squad-row lb-row${mine ? ' is-you' : ''}`;
    li.tabIndex = 0;
    li.dataset.id = s.id;
    const label = s.name || s.handle.replace(/^@/, '');
    li.title = `${label} · ${s.handle}`;
    li.setAttribute('aria-label', `${label}, ${s.handle}, rank ${s.rank}, ${s.trophies.toLocaleString('en-US')} Tactical IQ. Activate to open the guild profile.`);
    if (mine) li.setAttribute('aria-current', 'true');

    /* Identity column: hex crest, then the name — which owns the flexible width.
       The @handle lives in the title and the accessible name: at 320 the identity
       column is ~86px, and handle + member stack together is what used to squeeze
       the guild name into "Doge…". */
    const id = document.createElement('span');
    id.className = 'lb-id';
    const av = hexCrest(squadLetter(s), 'lb-hex');
    const txt = document.createElement('span');
    txt.className = 'lb-txt';
    const nm = document.createElement('span');
    nm.className = 'lb-name';
    nm.textContent = label;
    nm.title = `${label} · ${s.handle}`;
    const sub = document.createElement('span');
    sub.className = 'lb-sub';
    const k = squadKind(s);
    sub.append(svgIcon(k === 'channel' ? '#i-send' : '#i-users', 'lb-kind'));
    const stack = memberStack(s.members);
    stack.title = `${k === 'channel' ? 'Telegram channel' : 'Telegram group'} · ${s.handle} · ${s.members.toLocaleString('en-US')} members`;
    sub.append(stack);
    txt.append(nm, sub);
    id.append(av, txt);

    /* Action column: one capsule pinned to the right edge — coral to invite your own
       guild, frosted clay to join somebody else's. Only one row per board is coral,
       so the ladder never becomes the wall of CTAs it used to be. */
    const act = document.createElement('span');
    act.className = 'lb-act';
    act.append(squadKey(squadAction(s, mine), 'lb-btn'));

    const cell = scoreCell(s.trophies.toLocaleString('en-US'), `${s.trophies.toLocaleString('en-US')} squad Tactical IQ`);
    const avg = document.createElement('small');
    avg.className = 'lb-avg';
    avg.textContent = `AVG ${avgOf(s).toLocaleString('en-US')}`;
    avg.title = `${avgOf(s).toLocaleString('en-US')} Tactical IQ per mind across ${s.members.toLocaleString('en-US')} members`;
    cell.append(avg);

    li.append(rankCrest(s.rank), id, cell, act);

    // The whole row opens the guild's profile sheet, which carries the real keys.
    li.addEventListener('click', () => { openGuild(s); });
    li.addEventListener('keydown', (e) => {
      if (e.target !== li) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openGuild(s);
      }
    });
    return li;
  }

  function paintSquadDock(): void {
    const dock = squadDock();
    if (!dock) return;
    // Squad dock is exclusive to the Intellect Guilds board — never on an IQ board.
    if (!isRanksVisible() || board !== 'guilds') {
      dock.hidden = true;
      return;
    }
    dock.hidden = false;
    const me = getMySquad();
    dock.textContent = '';
    dock.classList.toggle('member', !!me);

    if (!me) {
      const ico = document.createElement('span');
      ico.className = 'dock-av is-empty';
      ico.append(svgIcon('#i-brain', 'dock-ico'));
      ico.setAttribute('aria-hidden', 'true');

      const txt = document.createElement('span');
      txt.className = 'dock-txt';
      const t = document.createElement('b');
      t.className = 'dock-name';
      t.textContent = 'Join a guild to earn Tactical IQ';
      const s = document.createElement('small');
      s.className = 'dock-sub';
      s.textContent = 'Race points count for your channel or group';
      txt.append(t, s);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dock-btn is-primary';
      btn.textContent = 'Find Squad';
      btn.setAttribute('aria-label', 'Find Squad: open squad picker');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        impact('light');
        openSquadSheet();
      });

      const actions = document.createElement('span');
      actions.className = 'dock-actions';
      actions.append(btn);
      dock.append(ico, txt, actions);
      dock.setAttribute('aria-label', 'My Squad Standing: no squad bound. Find a guild to start earning Tactical IQ.');
      return;
    }

    const mine = getMyContribution();

    const av = document.createElement('span');
    av.className = 'dock-av';
    av.textContent = squadLetter(me);
    av.setAttribute('aria-hidden', 'true');

    const txt = document.createElement('span');
    txt.className = 'dock-txt';
    const top = document.createElement('span');
    top.className = 'dock-top';
    const kick = document.createElement('small');
    kick.className = 'dock-kicker';
    kick.textContent = 'My Squad';
    const rank = document.createElement('span');
    rank.className = 'dock-rank';
    rank.textContent = `#${me.rank}`;
    top.append(kick, rank);
    const nm = document.createElement('b');
    nm.className = 'dock-name';
    nm.textContent = me.handle;
    nm.title = `${me.name} · ${me.handle}`;
    txt.append(top, nm);

    const score = document.createElement('span');
    score.className = 'dock-score';
    score.append(svgIcon('#i-brain', 'dock-tiq'));
    const num = document.createElement('b');
    num.textContent = me.trophies.toLocaleString('en-US');
    const sub = document.createElement('small');
    sub.textContent = mine > 0 ? `+${mine.toLocaleString('en-US')} yours` : 'fight to contribute';
    score.append(num, sub);
    score.title = `${me.trophies.toLocaleString('en-US')} squad Tactical IQ`;

    const invite = document.createElement('button');
    invite.type = 'button';
    invite.className = 'dock-btn is-primary';
    invite.textContent = 'Invite';
    invite.setAttribute('aria-label', `Invite to ${me.handle}: copy squad invite`);
    invite.addEventListener('click', (e) => {
      e.stopPropagation();
      inviteSquad(me);
    });

    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'dock-btn';
    view.textContent = 'View';
    view.setAttribute('aria-label', `View ${me.handle} squad details`);
    view.addEventListener('click', (e) => {
      e.stopPropagation();
      impact('light');
      openSquadSheet();
    });

    const actions = document.createElement('span');
    actions.className = 'dock-actions';
    actions.append(invite, view);

    dock.append(av, txt, score, actions);
    dock.setAttribute('aria-label', `My Squad Standing: ${me.handle}, rank ${me.rank}, ${me.trophies.toLocaleString('en-US')} Tactical IQ.`);
  }

  function loadSquads(): void {
    const el = panes.guilds;
    if (!el) return;
    if (!loadedBoard.guilds) el.innerHTML = skel(5);
    const rows = getSquadRanking();
    if (!rows.length) {
      el.innerHTML = empty('No squads ranked yet.');
      paintPodium([]);
      paintSquadDock();
      paintRanksStats();
      return;
    }
    const me = getMySquad();
    guildField = rows;
    paintPodium(rows.slice(0, 3).map((s) => ({
      rank: s.rank,
      name: s.name || s.handle.replace(/^@/, ''),
      score: s.trophies.toLocaleString('en-US'),
      letter: squadLetter(s),
      action: squadKey(squadAction(s, me?.id === s.id), 'pod-btn'),
      onTap: () => {
        impact('light');
        openSquadSheet();
      },
    })));
    el.textContent = '';
    const ol = document.createElement('ol');
    ol.className = 'squad-list';
    for (const s of rows.slice(3)) {
      ol.append(squadRow(s, me?.id === s.id));
    }
    el.append(ol);
    paintSquadDock();
    paintGuildHero();
    paintRanksStats();
    loadedBoard.guilds = true;
  }

  onChange(() => {
    loadedBoard.nations = false;
    loadedBoard.minds = false;
    loadedBoard.guilds = false;
    if (isRanksVisible()) {
      paintRanks();
      void loadBoard(board);
    } else if (isArenaVisible()) {
      paintArena();
      void loadCup();
    }
  });

  onSquadChange(() => {
    loadedBoard.guilds = false;
    paintRanksStats();
    if (isRanksVisible() && board === 'guilds') {
      loadSquads();
    }
  });

  return {
    setRoute(id: string) {
      // Legacy "compete" route lands on Arena (its old default feed).
      if (id === 'compete') id = 'arena';
      if (id === 'arena') {
        paintArena();
        void loadCup();
      } else if (id === 'ranks') {
        paintRanks();
        startTick();
        void loadBoard(board);
      }
    },
  };
}
