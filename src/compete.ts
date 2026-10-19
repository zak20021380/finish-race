/**
 * compete.ts — Arena (the 200 Stars Cup) + Ranks (dedicated Leaderboard).
 *
 * IA: Arena stages exactly ONE championship — the 200 Telegram Stars Cup — as a
 * single dark-clay showcase that fills the phone between the header and the
 * bottom dock: the faceted Star medallion with the engraved title over a two-way
 * clay switch, the live bracket clock, a Top-3 podium, two runners, the pinned
 * squad row and the 50px PLAY FOR YOUR SQUAD key.
 *
 * The switch re-reads the same band two ways without leaving the screen.
 * CHANNELS ranks the squads, and each card opens that channel's Top-10 roster
 * sheet. TOP PLAYERS lists the ten people the pool actually lands on — the
 * leading channel's own Top 10, place by place — because the cup funds no
 * individual outside that ten. Both boards therefore quote one set of numbers:
 * the ladder is `getSquadRanking()` and the players are `getChannelRoster()`.
 * There is no cup feed, no archive and no coin entry fee anywhere on it: one
 * championship, staged in full.
 *
 * The channel ladder is the SAME feed the Intellect Guilds board ranks
 * (`getSquadRanking()`), so the two screens can never disagree about who leads
 * the championship; only the roster members are seeded preview data.
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
  getChannelRoster,
  getCountryRanking,
  getGrandCup,
  getPlayerRanking,
  paidPlaces,
  trendArrow,
  type ChannelSeed,
  type CountryRow,
  type GrandCup,
  type PlayerRow,
  type RosterRow,
  type RosterYou,
  type Trend,
} from './data';
import { nameOf } from './countries';
import { onChange, profile } from './storage';
import { motionReduced } from './settings';
import { bindSquadById, getMyContribution, getMySquad, getSquadRanking, onSquadChange, squadKind, squadLetter, type RankedSquad } from './squads';
import { impact, notify, tgUser } from './telegram';
import type { Router } from './router';
import type { Sheets } from './sheets';
import starsImg from './assets/images/telegram_stars.png';

export interface CompeteApi {
  router: Router;
  sheets: Sheets;
  sheet(id: string): HTMLElement | null;
  /** The one door every queue goes through — the Arena's PLAY MATCH key opens it. */
  queue(): void;
}

type Board = 'minds' | 'guilds' | 'nations';

/** The Arena stages one cup but reads it two ways: by channel, or by the people
 *  the channel's Stars actually land on. */
type ArenaView = 'channels' | 'players';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const skel = (rows: number): string =>
  Array.from({ length: rows }, () => '<div class="skel-row"><span class="skel w20"></span><span class="skel w60"></span><span class="skel w15"></span></div>').join('');

const empty = (msg: string): string => `<div class="empty" role="status">${msg}</div>`;

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

/** The one-word crest of each tier — "GM II" is what fits a podium pill at 360. */
const TIER_ABBR: Record<MindTier, string> = {
  rookie: 'RK',
  tactician: 'TAC',
  strategist: 'STR',
  grandmaster: 'GM',
};

/** "Grandmaster II" → "GM II": the podium pill's budget is a rank, not a biography. */
function shortDivisionOf(tiq: number): string {
  const d = divisionOf(tiq);
  return `${TIER_ABBR[d.tier]} ${d.label.slice(d.label.lastIndexOf(' ') + 1)}`;
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
  const boardSwitch = document.querySelector<HTMLElement>('.ranks-tabs');
  const ranksScreen = document.getElementById('s-ranks');
  const seasonChip = document.getElementById('ranks-season');
  const seasonText = seasonChip?.querySelector<HTMLElement>('.ml-season-t') ?? null;
  const seasonSub = document.getElementById('ranks-sub');
  /** The Cup showcase's own parts: one card, hydrated in place, never rebuilt. */
  const cupEls = {
    card: document.getElementById('stars-card'),
    name: document.getElementById('stars-name'),
    emblem: document.getElementById('stars-emblem-img') as HTMLImageElement | null,
    tabs: document.getElementById('stars-tabs'),
    count: document.getElementById('stars-count'),
    podium: document.getElementById('stars-podium'),
    runners: document.getElementById('stars-runners'),
    squad: document.getElementById('stars-squad') as HTMLButtonElement | null,
    squadChip: document.getElementById('stars-squad-chip'),
    squadLetter: document.getElementById('stars-squad-letter'),
    squadName: document.getElementById('stars-squad-name'),
    squadNote: document.getElementById('stars-squad-note'),
    cta: document.getElementById('stars-cta') as HTMLButtonElement | null,
  };
  const viewBtns = [...document.querySelectorAll<HTMLButtonElement>('#stars-tabs [data-view]')];
  // One Star asset, two static mounts: the hero emblem and the roster's prize notice.
  // Every other Star on the Cup is built by `starImg()` as its row is painted.
  if (cupEls.emblem) cupEls.emblem.src = starsImg;
  const noticeStar = document.getElementById('sr-notice-star') as HTMLImageElement | null;
  if (noticeStar) noticeStar.src = starsImg;
  const podiumEl = document.getElementById('ranks-podium');
  const panes: Record<Board, HTMLElement | null> = {
    minds: document.getElementById('ranks-minds'),
    guilds: document.getElementById('ranks-guilds'),
    nations: document.getElementById('ranks-nations'),
  };

  let board: Board = 'minds';
  let loadedBoard: Partial<Record<Board, boolean>> = {};
  /** The staged championship. `null` until `getGrandCup()` answers — the markup
   *  already carries the showcase skeleton, so nothing has to be rebuilt. */
  let cup: GrandCup | null = null;
  /** The head of the channel ladder — the same five squads the Guilds board ranks. */
  let channels: RankedSquad[] = [];
  /** Which ladder the header switch is showing: the squads, or the ten people they pay. */
  let view: ArenaView = 'channels';
  /** The paid ten, fetched once per leading channel — the players board's rows. */
  let playerRows: RosterRow[] | null = null;
  let playerRowsFor: string | null = null;
  /** Rosters already fetched, keyed by channel + the TIQ they were merged against. */
  const rosters = new Map<string, Promise<RosterRow[]>>();
  /** The local player's row inside their own channel's roster, or null if unbound. */
  let myRoster: RosterRow[] | null = null;
  let myRosterKey: string | null = null;
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

  /** The bare name a roster row carries — a handle is not a name, and "You" is last. */
  const youName = (): string => {
    const u = tgUser();
    const full = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
    if (full && full.toLowerCase() !== 'you') return full.slice(0, 20);
    if (u?.username) return u.username.slice(0, 20);
    return 'You';
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
    // The screen's aura keys off your own TIQ, wherever on the ladder the eye is.
    if (ranksScreen) ranksScreen.dataset.tier = tierOf(myTrophyScore());
    // The squad banner belongs EXCLUSIVELY to the Intellect Guilds board.
    const dock = squadDock();
    if (dock) dock.hidden = board !== 'guilds';
    if (board === 'guilds') paintSquadDock();
    paintGuildHero();
  }

  /**
   * The season line and its capsule: the subtitle names the season, the pill counts
   * it down in days. Both are recomputed on entry and on every tick, so the beacon
   * never pulses beside a figure that has quietly gone stale.
   */
  function paintSeason(): void {
    const t = Date.now();
    const s = seasonOf(t);
    const days = Math.max(0, Math.ceil((s.endsAt - t) / 86400_000));
    if (seasonText) seasonText.textContent = `${days}d left`;
    if (seasonSub) seasonSub.textContent = `Season ${s.no}`;
    seasonChip?.setAttribute('title', `Season ${s.no} closes in ${formatCountdown(s.endsAt, t)}`);
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

  /* ---------- arena: the 200 Stars Cup ----------
     One championship, staged in the markup and hydrated here. The showcase is a
     single clay card whose geometry (header with the board switch · podium ·
     runners · squad row · CTA) is what makes it fit 360x640 with no scroll, so
     this controller never rebuilds the card: it writes the live numbers in,
     ticks the countdown, repaints the one band the switch moves and owns the
     seat. */

  /** A seat is a device fact, like every other mock in this app. */
  const SEAT_KEY = 'detour.arena.seat.v1';

  /** The head of the channel ladder the card shows: three on the podium, two below. */
  const FIELD_ROWS = 5;

  /** How many contributors a channel's roster sheet lists — the paid places, no more. */
  const ROSTER_ROWS = 10;

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

  /** The bracket clock: `01:44:58` counting down, then the stage says so itself. */
  const startsText = (c: GrandCup, from: number): string =>
    c.startsAt - from <= 0 ? 'Bracket live' : formatCountdown(c.startsAt, from);

  /** The format pills: the data's own, plus the paid count read off the prize ladder. */
  const specWords = (c: GrandCup): string[] => [...c.specs, `Top ${paidPlaces(c)} Paid`];

  /** Metal for a bracket place — the three that get a rim, and nothing above them. */
  const metalOf = (place: number): string =>
    place === 1 ? 'gold' : place === 2 ? 'silver' : place === 3 ? 'bronze' : '';

  /** The handle without its sigil: a card this small reads better as a name. */
  const bare = (handle: string): string => handle.replace(/^@+/, '');

  /** Two letters is all a 30px sphere holds without a second glyph crowding it. */
  const initials = (name: string): string => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
  };

  /** The official Telegram Star, mounted wherever the Arena pays or crowns. The PNG
   *  is RGBA gold, so `screen` blends the metal onto the clay with no box behind it. */
  function starImg(cls: string): HTMLImageElement {
    const img = document.createElement('img');
    img.className = cls;
    img.src = starsImg;
    img.alt = '';
    img.decoding = 'async';
    return img;
  }

  /** One player's ball: two initials over the sphere, the nation flag on its corner. */
  function sphere(r: { name: string; countryCode: string }, cls: string): HTMLElement {
    const av = document.createElement('span');
    av.className = cls;
    av.setAttribute('aria-hidden', 'true');
    const ini = document.createElement('b');
    ini.className = 'stars-av-t';
    ini.textContent = initials(r.name);
    const flag = document.createElement('span');
    flag.className = 'stars-av-flag';
    flag.append(flagPhoto(r.countryCode, 'fp-badge'));
    av.append(ini, flag);
    return av;
  }

  /* ---------- the channel ladder, and the roster behind each card ---------- */

  /** The Cup ranks the very same squads the Intellect Guilds board ranks. */
  const channelLadder = (): RankedSquad[] => getSquadRanking().slice(0, FIELD_ROWS);

  const seedOf = (s: RankedSquad): ChannelSeed =>
    ({ id: s.id, handle: s.handle, name: s.name, tiq: s.trophies });

  const kindWord = (s: RankedSquad): string => (squadKind(s) === 'channel' ? 'channel' : 'group');
  const kindLabel = (s: RankedSquad): string => `Telegram ${kindWord(s)}`;

  /** The local player only ever has a place in a roster they actually belong to. */
  function youIn(ch: ChannelSeed): RosterYou | null {
    const mine = getMySquad();
    if (!mine || mine.id !== ch.id) return null;
    return { name: youName(), countryCode: profile.country ?? '', tiq: myTrophyScore() };
  }

  /** A roster is fetched once per channel + TIQ pair, so re-entry never re-rolls it. */
  function rosterOf(ch: ChannelSeed): Promise<RosterRow[]> {
    const you = youIn(ch);
    const key = `${ch.id}|${you ? you.tiq : '-'}`;
    let hit = rosters.get(key);
    if (!hit) {
      hit = getChannelRoster(ch, you);
      rosters.set(key, hit);
    }
    return hit;
  }

  const tag = (cls: string, text?: string): HTMLElement => {
    const el = document.createElement('span');
    el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  /** A bold run inside a sentence — the digits carry the colour, the prose never does. */
  const strong = (text: string): HTMLElement => {
    const b = document.createElement('b');
    b.textContent = text;
    return b;
  };

  /** The channel's own mark: a clay squircle carrying the handle's letter. The old
   *  per-avatar Telegram tick was pure noise on a board where every entry is a
   *  channel — dropped, so the mark and its metal can breathe. */
  function channelAv(s: RankedSquad, cls: string): HTMLElement {
    const av = tag(`stars-ch-av${cls ? ` ${cls}` : ''}`);
    av.setAttribute('aria-hidden', 'true');
    const t = document.createElement('b');
    t.className = 'stars-ch-t';
    t.textContent = squadLetter(s);
    av.append(t);
    return av;
  }

  /** Every card on the Cup is a door: it opens that channel's Top-10 roster. */
  function openable(el: HTMLElement, s: RankedSquad, say: string): void {
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.setAttribute('aria-haspopup', 'dialog');
    el.setAttribute('aria-label', say);
    el.addEventListener('click', () => { void openRoster(s); });
    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void openRoster(s);
      }
    });
  }

  /** A podium channel: rank · mark · name · squad TIQ · the pool its Top 10 split. */
  function podChannel(s: RankedSquad, c: GrandCup): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'stars-pod';
    li.dataset.rank = String(s.rank);
    const metal = metalOf(s.rank);
    if (metal) li.dataset.metal = metal;

    const name = tag('stars-pod-name', bare(s.handle));
    name.title = s.name;

    const tiq = tag('stars-pod-tiq');
    tiq.append(strong(num(s.trophies)), document.createTextNode(' TIQ'));

    /* the champion wears the one crown on the board, set into its raised pedestal */
    if (s.rank === 1) li.append(svgIcon('#i-crown', 'stars-pod-crown'));
    li.append(tag('stars-pod-rank', String(s.rank)), channelAv(s, ''), name, tiq);

    if (s.rank === 1) {
      const prize = tag('stars-pod-prize');
      const pool = document.createElement('small');
      pool.textContent = 'Pool';
      prize.append(starImg('stars-pod-star'), strong(num(c.stars)), pool);
      prize.title = `The #1 channel's Top 10 split ${num(c.stars)} Telegram Stars`;
      li.append(prize);
    }

    openable(li, s, `${kindLabel(s)} ${s.handle}, rank ${s.rank} with ${num(s.trophies)} squad `
      + `Tactical IQ and ${s.members.toLocaleString('en-US')} members. Tap to view the Top ${ROSTER_ROWS} roster.`);
    return li;
  }

  /** A runner channel: place · mark · name · the TIQ pill · a chevron. */
  function runChannel(s: RankedSquad): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'stars-run';

    const id = tag('stars-run-id');
    const nm = document.createElement('b');
    nm.className = 'stars-run-nm';
    nm.textContent = bare(s.handle);
    nm.title = s.name;
    id.append(nm);

    const tiq = tag('stars-run-tiq');
    tiq.append(strong(num(s.trophies)), document.createTextNode(' TIQ'));

    li.append(tag('stars-run-rank', String(s.rank)), channelAv(s, 'stars-ch-sm'), id, tiq,
      svgIcon('#i-next', 'stars-run-go'));
    openable(li, s, `${kindLabel(s)} ${s.handle}, rank ${s.rank} with ${num(s.trophies)} squad `
      + `Tactical IQ and ${s.members.toLocaleString('en-US')} members. Tap to view the Top ${ROSTER_ROWS} roster.`);
    return li;
  }

  /* ---------- the players board: the ten people the pool actually pays ----------
     The cup funds no individual outside the leading channel's Top 10, so this is
     not a second leaderboard with invented numbers — it is the same roster the
     sheet shows, read place by place. TIQ, nation and payout all come from
     `getChannelRoster`, so the two views can never disagree. */

  /** A podium player: rank · ball + flag · name · TIQ banked · their own share. */
  function podPlayer(r: RosterRow): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'stars-pod';
    li.dataset.rank = String(r.rank);
    const metal = metalOf(r.rank);
    if (metal) li.dataset.metal = metal;

    const name = tag('stars-pod-name', r.name);
    name.title = r.name;

    const tiq = tag('stars-pod-tiq');
    tiq.append(strong(num(r.tiq)), document.createTextNode(' TIQ'));

    if (r.rank === 1) li.append(svgIcon('#i-crown', 'stars-pod-crown'));
    li.append(tag('stars-pod-rank', String(r.rank)), sphere(r, 'stars-av'), name, tiq);
    if (r.stars > 0) {
      const prize = tag('stars-pod-prize');
      prize.append(starImg('stars-pod-star'), strong(num(r.stars)));
      prize.title = `Projected share of the leading channel's pool: ${num(r.stars)} Telegram Stars`;
      li.append(prize);
    }
    li.setAttribute('aria-label', `Rank ${r.rank}: ${r.name}, ${num(r.tiq)} Tactical IQ contributed, `
      + (r.stars > 0 ? `projected ${num(r.stars)} Telegram Stars` : 'outside the paid places'));
    return li;
  }

  /** A runner player: place · ball + flag · name · TIQ · their own share. */
  function runPlayer(r: RosterRow): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'stars-run';

    const id = tag('stars-run-id');
    const nm = document.createElement('b');
    nm.className = 'stars-run-nm';
    nm.textContent = r.name;
    nm.title = r.name;
    id.append(nm);

    const tiq = tag('stars-run-tiq');
    tiq.append(strong(num(r.tiq)), document.createTextNode(' TIQ'));

    li.append(tag('stars-run-rank', String(r.rank)), sphere(r, 'stars-av'), id, tiq);
    if (r.stars > 0) {
      const pay = tag('stars-run-pay');
      pay.append(starImg('stars-run-star'), strong(num(r.stars)));
      pay.title = `Projected share of the pool: ${num(r.stars)} Telegram Stars`;
      li.append(pay);
    }
    li.setAttribute('aria-label', `Rank ${r.rank}: ${r.name}, ${num(r.tiq)} Tactical IQ contributed, `
      + (r.stars > 0 ? `projected ${num(r.stars)} Telegram Stars` : 'outside the paid places'));
    return li;
  }

  /** The band's loading state: the real card shapes, with the type shimmering. */
  function paintBoardSkel(): void {
    for (const [el, cls, n] of [[cupEls.podium, 'stars-pod', 3], [cupEls.runners, 'stars-run', 2]] as const) {
      if (!el) continue;
      el.textContent = '';
      for (let i = 0; i < n; i++) {
        const li = document.createElement('li');
        li.className = `${cls} is-skel`;
        const s = document.createElement('span');
        s.className = 'skel';
        li.append(s);
        el.append(li);
      }
    }
  }

  /** Fill the band from the leading channel's roster, fetching it once per leader. */
  async function paintPlayers(): Promise<void> {
    const lead = channels[0];
    if (!lead) return;
    if (playerRowsFor !== lead.id) {
      playerRowsFor = lead.id;
      playerRows = null;
      if (view === 'players') paintBoardSkel();
    }
    if (!playerRows) {
      try {
        playerRows = await rosterOf(seedOf(lead));
      } catch {
        playerRows = null;
        playerRowsFor = null;
        if (view === 'players') paintChannelBoard();
        return;
      }
    }
    // A slower roster must never overwrite a board the switch has already moved on.
    if (view !== 'players' || channels[0]?.id !== lead.id) return;
    const rows = playerRows;
    if (cupEls.podium) {
      cupEls.podium.textContent = '';
      cupEls.podium.setAttribute('aria-label', `Top three players of ${lead.handle}, whose Top ${ROSTER_ROWS} split the pool`);
      for (const r of rows.filter((x) => x.rank <= 3)) cupEls.podium.append(podPlayer(r));
    }
    if (cupEls.runners) {
      cupEls.runners.textContent = '';
      cupEls.runners.setAttribute('aria-label', `Players four and five of ${lead.handle}`);
      for (const r of rows.filter((x) => x.rank >= 4).slice(0, 2)) cupEls.runners.append(runPlayer(r));
    }
  }

  /** The head of the ladder, split: three channels on the podium, two runners below. */
  function paintChannelBoard(): void {
    const c = cup;
    if (!c) return;
    if (cupEls.podium) {
      cupEls.podium.textContent = '';
      for (const s of channels.filter((x) => x.rank <= 3)) cupEls.podium.append(podChannel(s, c));
    }
    if (cupEls.runners) {
      cupEls.runners.textContent = '';
      for (const s of channels.filter((x) => x.rank >= 4)) cupEls.runners.append(runChannel(s));
    }
  }

  /** Repaint the band for whichever board the header switch is on. */
  function paintBoard(): void {
    if (cupEls.card) cupEls.card.dataset.view = view;
    if (view === 'players') { void paintPlayers(); return; }
    if (cupEls.podium) cupEls.podium.setAttribute('aria-label', 'Top three channels');
    if (cupEls.runners) cupEls.runners.setAttribute('aria-label', 'Channels four and five');
    paintChannelBoard();
  }

  /** The switch never leaves the screen: it re-reads the same band a second way. */
  function selectView(next: ArenaView): void {
    if (next === view) return;
    view = next;
    impact('light');
    if (cupEls.tabs) cupEls.tabs.dataset.active = next;
    for (const b of viewBtns) b.setAttribute('aria-pressed', String(b.dataset.view === next));
    paintBoard();
  }

  for (const b of viewBtns) {
    b.addEventListener('click', () => {
      const v = b.dataset.view;
      if (v === 'channels' || v === 'players') selectView(v);
    });
  }

  /**
   * The pinned squad row: the channel this device rides for, where it sits in the
   * Cup, and where the player sits inside it. Every number is read off the local
   * squad registry and the same roster the sheet shows — an unbound device is told
   * so, and its key goes to the real join flow rather than to a placeholder.
   */
  function paintSquad(c: GrandCup): void {
    const row = cupEls.squad;
    if (!row) return;
    const mine = getMySquad();
    const paid = paidPlaces(c);

    if (!mine) {
      row.classList.add('is-unbound');
      row.removeAttribute('aria-haspopup');
      setText(cupEls.squadChip, 'JOIN ONE');
      setText(cupEls.squadLetter, '?');
      setText(cupEls.squadName, 'No channel bound');
      setText(cupEls.squadNote, 'Tap to join a squad');
      row.setAttribute('aria-label',
        `No channel bound. Tap to join a Telegram squad — its Top ${paid} players share the ${c.stars}-Star pool.`);
      return;
    }

    row.classList.remove('is-unbound');
    row.setAttribute('aria-haspopup', 'dialog');
    setText(cupEls.squadChip, 'YOUR SQUAD');
    setText(cupEls.squadLetter, squadLetter(mine));
    /* name line: the handle, then its cup rank as its own pill — the two facts sit
       side by side instead of running together into one ellipsised string */
    const name = cupEls.squadName;
    if (name) {
      name.textContent = '';
      name.append(document.createTextNode(bare(mine.handle)));
      const pos = tag('stars-squad-pos', `#${mine.rank}`);
      pos.title = `Rank ${mine.rank} in the ${c.name}`;
      name.append(pos);
    }

    const note = cupEls.squadNote;
    const you = myRoster?.find((r) => r.isYou) ?? null;
    if (note) {
      note.textContent = '';
      if (you && you.stars > 0) {
        note.append(document.createTextNode('You '), strong(`#${you.rank}`),
          document.createTextNode(' · earn '), starImg('stars-squad-star'), strong(num(you.stars)));
      } else if (you) {
        note.append(document.createTextNode('You '), strong(`#${you.rank}`),
          document.createTextNode(` · outside the paid ${paid}`));
      } else {
        note.append(strong(num(myTrophyScore())), document.createTextNode(' TIQ · tap for the roster'));
      }
    }
    row.setAttribute('aria-label', seat?.cup === c.id
      ? `Your squad ${mine.handle} is rank ${mine.rank} in the ${c.name}; your seat is locked. Tap to view the roster.`
      : `Your squad ${mine.handle} is rank ${mine.rank} in the ${c.name}. Tap to view the roster.`);
  }

  /** Which channel the sheet is showing: a slower fetch must not overwrite a newer tap. */
  let rosterOpen: string | null = null;

  function rosterRow(r: RosterRow): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `sr-row${r.isYou ? ' is-you' : ''}`;
    const metal = metalOf(r.rank);
    if (metal) li.dataset.metal = metal;

    const id = tag('sr-id-col');
    const nm = document.createElement('b');
    nm.className = 'sr-nm';
    nm.textContent = r.name;
    nm.title = r.name;
    const tiq = document.createElement('small');
    tiq.className = 'sr-tiq';
    tiq.append(strong(num(r.tiq)), document.createTextNode(' TIQ contributed'));
    id.append(nm, tiq);

    const pay = tag('sr-pay');
    if (r.stars > 0) pay.append(starImg('sr-pay-star'), strong(num(r.stars)));
    else {
      li.classList.add('is-outside');
      pay.textContent = '—';
    }

    li.append(tag('sr-medal', String(r.rank)), sphere(r, 'stars-av'), id);
    if (r.isYou) li.append(tag('sr-you-tag', 'YOU'));
    li.append(pay);
    li.setAttribute('aria-label', `Rank ${r.rank}: ${r.name}, ${num(r.tiq)} Tactical IQ contributed, `
      + (r.stars > 0 ? `projects ${num(r.stars)} Telegram Stars` : 'outside the paid places'));
    return li;
  }

  /** The roster sheet: one channel's head, then the ten people the Stars go to. */
  async function openRoster(s: RankedSquad): Promise<void> {
    const sheet = api.sheet('sheet-roster');
    if (!sheet) return;
    const list = sheet.querySelector<HTMLElement>('#sr-list');
    if (!list) return;

    rosterOpen = s.id;
    const metal = metalOf(s.rank);
    if (metal) sheet.dataset.metal = metal;
    else delete sheet.dataset.metal;

    setText(sheet.querySelector<HTMLElement>('#sr-letter'), squadLetter(s));
    setText(sheet.querySelector<HTMLElement>('#sr-rank'), String(s.rank));
    setText(sheet.querySelector<HTMLElement>('#sr-name'), s.handle);
    const sub = sheet.querySelector<HTMLElement>('#sr-sub');
    if (sub) {
      sub.textContent = '';
      sub.append(strong(num(s.trophies)), document.createTextNode(
        ` TIQ · ${s.members.toLocaleString('en-US')} members · ${kindWord(s)}`));
    }

    list.innerHTML = `<li class="sr-skel">${skel(6)}</li>`;
    impact('light');
    api.sheets.open(sheet);

    let rows: RosterRow[];
    try {
      rows = await rosterOf(seedOf(s));
    } catch {
      if (rosterOpen === s.id) list.innerHTML = empty('The roster did not load.');
      return;
    }
    if (rosterOpen !== s.id) return;
    list.textContent = '';
    for (const r of rows.slice(0, ROSTER_ROWS)) list.append(rosterRow(r));
  }

  /** One window of the clock: a unit of the countdown, the `44` in `01:44:58`. Units
   *  are nodes rather than characters because the readout is an instrument — each unit
   *  wants its own recessed face under the gold numerals. The face and the numerals are
   *  separate boxes on purpose: the numerals are clipped out of a metal gradient, and a
   *  text clip would otherwise clip the window's own face away with them. */
  function countUnit(digits: string): HTMLElement {
    const plate = document.createElement('b');
    const ink = document.createElement('span');
    ink.textContent = digits;
    plate.append(ink);
    return plate;
  }

  /** The colon between two units: still the real glyph, at the digits' own size, so it
   *  shares their line box and lands on their baseline with no nudging. */
  function countSep(): HTMLElement {
    const i = document.createElement('i');
    i.textContent = ':';
    return i;
  }

  /** `01:44:58` → three units; `44:58` → two. Anything else — the bracket opening, or
   *  a countdown quoted in days — is not a clock and is written as plain text. */
  const countUnits = (text: string): string[] | null => {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
    if (!m) return null;
    return m[3] ? [m[1], m[2], m[3]] : [m[1], m[2]];
  };

  /** The bracket clock, painted as an instrument: one plate per unit with the colon
   *  kept between them, so `01:44:58` reads as three windows instead of one run of
   *  eight glyphs. The shape is rebuilt only when it changes — never inside a bracket
   *  — so the once-a-second repaint rewrites two or three short strings and nothing
   *  else. The element's text still spells the countdown exactly as before, colons
   *  included, which is what a screen reader and every other reader of it gets. */
  function paintCount(c: GrandCup, from: number): void {
    const el = cupEls.count;
    if (!el) return;
    const text = startsText(c, from);
    const units = countUnits(text);
    const shape = units ? `u${units.length}` : 'text';
    if (el.dataset.shape !== shape) {
      el.dataset.shape = shape;
      el.textContent = '';
      if (!units) el.textContent = text;
      else units.forEach((u, i) => {
        if (i) el.append(countSep());
        el.append(countUnit(u));
      });
      return;
    }
    if (!units) {
      setText(el, text);
      return;
    }
    const plates = el.querySelectorAll<HTMLElement>('b > span');
    units.forEach((u, i) => setText(plates[i] ?? null, u));
  }

  /** The key always offers the same thing; the seat's state is stated on the squad
   *  row rather than by recolouring the one loud action on the screen. */
  function paintCta(c: GrandCup): void {
    const btn = cupEls.cta;
    if (!btn) return;
    btn.setAttribute('aria-label', seat?.cup === c.id
      ? `${c.name}: your seat is locked. Play your match and bank TIQ for your channel.`
      : `Enter the ${c.name} and play your match for your channel.`);
  }

  /** Write the cup's own numbers into the standing geometry. Runs on every entry. */
  function paintCup(c: GrandCup): void {
    setText(cupEls.name, c.name.toUpperCase());
    paintSquad(c);
    paintCount(c, Date.now());
    paintCta(c);
  }

  /** The confirmation drawer, reached only from an unseated key: what a seat costs,
   *  which seat it is, and what locking it opens. */
  function openSeatSheet(): void {
    if (!cup) return;
    const sheet = api.sheet('sheet-stars');
    if (!sheet) return;
    setText(sheet.querySelector<HTMLElement>('#stars-sheet-title'), 'Play for your squad?');
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

  /** The header's round key: the cup's three rules, one dark-clay sheet. */
  elOf('stars-info')?.addEventListener('click', () => {
    const sheet = api.sheet('sheet-rules');
    if (!sheet) return;
    impact('light');
    api.sheets.open(sheet);
  });

  /** Bound: the roster of your own channel. Unbound: the real join flow. */
  cupEls.squad?.addEventListener('click', () => {
    const mine = getMySquad();
    if (mine) void openRoster(mine);
    else openSquadSheet();
  });

  function tickCup(): void {
    if (cup) paintCount(cup, Date.now());
  }

  /** The local player's place inside their own channel, once per TIQ change. */
  async function loadMyRoster(): Promise<void> {
    const mine = getMySquad();
    if (!mine) {
      myRoster = null;
      myRosterKey = null;
      return;
    }
    const you = youIn(seedOf(mine));
    const key = `${mine.id}|${you ? you.tiq : '-'}`;
    if (key === myRosterKey) return;
    myRosterKey = key;
    try {
      myRoster = await rosterOf(seedOf(mine));
    } catch {
      myRoster = null;
    }
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
    }
    channels = channelLadder();
    paintBoard();
    paintCup(cup);
    await loadMyRoster();
    paintSquad(cup);
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
    /** The pill's short rank: "GM II". */
    tierLabel?: string;
    /** The spoken rank, spelled out: "Grandmaster II". */
    tierAria?: string;
    /** Weekly TIQ movement, rendered as a chip rather than left to the trend arrow. */
    delta?: number;
    /** The ladder no longer carries #1-3, so a board whose rows have actions must move them up here. */
    action?: HTMLElement;
    onTap?: () => void;
  }

  /**
   * Card order is avatar → name → tier → TIQ(+delta) → plinth. The plinth stays the
   * last child because it is the card's base: appending the join key after it
   * would float the base into the middle of the card.
   */
  function podiumCard(e: PodiumEntry): HTMLElement {
    const card = document.createElement('div');
    card.className = `pod-card ${podiumOf(e.rank)}`;
    card.dataset.rank = String(e.rank);
    if (e.tier) card.dataset.tier = e.tier;
    card.setAttribute('role', 'listitem');
    const tierSaid = e.tierAria ?? e.tierLabel;
    const said = [
      tierSaid ? `${tierSaid}, ` : '',
      `${e.score} Tactical IQ`,
      e.delta ? `${signed(e.delta)} this week` : '',
    ].join('');
    card.setAttribute('aria-label', `Rank ${e.rank}: ${e.name}, ${said}`);

    if (e.rank === 1) card.append(svgIcon('#i-crown', 'pod-crown'));

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
    iq.append(svgIcon('#i-star', 'pod-tiq'));
    const iqN = document.createElement('b');
    iqN.textContent = e.score;
    iq.append(iqN);
    iq.title = `${e.score} Tactical IQ`;

    /* the weekly movement rides inside the chip as "(+54)" — one chip, one read,
       so the meter row never stacks a second pill beside the score */
    const delta = document.createElement('small');
    delta.className = e.delta ? `pod-delta ${e.delta > 0 ? 'up' : 'down'}` : 'pod-delta';
    delta.textContent = e.delta ? `(${signed(e.delta)})` : '';
    if (!e.delta) delta.hidden = true;
    else delta.title = `${signed(e.delta)} Tactical IQ this week`;

    const step = document.createElement('span');
    step.className = 'pod-foot';
    step.setAttribute('aria-hidden', 'true');
    const stepN = document.createElement('b');
    stepN.textContent = String(e.rank);
    step.append(stepN);

    card.append(av, nm, tier, iq);
    if (e.delta) iq.append(delta);
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

  function paintPodium(entries: PodiumEntry[]): void {
    const host = podiumEl;
    if (!host) return;
    host.textContent = '';
    const top = entries.filter((e) => e.rank >= 1 && e.rank <= 3);
    if (!top.length) {
      host.hidden = true;
      return;
    }
    const boardName = board === 'guilds' ? 'Intellect Guilds' : board === 'nations' ? 'Nations IQ' : 'Top Minds';
    host.setAttribute('aria-label', `Top ${top.length} on ${boardName}`);
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
      const head = document.createElement('span');
      head.className = 'mh-axis-h';
      const label = document.createElement('small');
      label.textContent = a.label;
      const val = document.createElement('b');
      val.textContent = `${a.pct}%`;
      head.append(label, val);
      const track = document.createElement('span');
      track.className = 'mh-track';
      const fill = document.createElement('i');
      fill.style.width = `${a.pct}%`;
      track.append(fill);
      cell.append(head, track);
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
      ? `${wins} win${wins === 1 ? '' : 's'} to ${divisionOf(div.next).label} · crest glows on rank-up`
      : 'Peak division · hold it against the ladder';
    prog.append(pTrack, pText);

    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'mh-cta';
    cta.textContent = 'CLIMB NOW';
    cta.setAttribute('aria-label', 'Climb now — go and start a race');
    cta.addEventListener('pointerdown', () => impact('light'), { passive: true });
    cta.addEventListener('click', () => {
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
    paintNationsStanding(rows);
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
      tierLabel: shortDivisionOf(p.points),
      tierAria: divisionOf(p.points).label,
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
    paintMindsStanding(rows);
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
    if (isRanksVisible() && board === 'guilds') {
      loadSquads();
    }
    // The Cup ladder and your place in it read the same registry: bind a channel
    // anywhere and the Arena's podium, squad row and roster all move with it. The
    // players board reads that same roster, so its cache goes too — otherwise the
    // two boards would quote different TIQ for the same channel.
    rosters.clear();
    playerRows = null;
    playerRowsFor = null;
    myRosterKey = null;
    if (isArenaVisible()) void loadCup();
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
