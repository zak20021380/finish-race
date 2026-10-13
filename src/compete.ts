/**
 * compete.ts — Arena (Tournament Cups) + Ranks (dedicated Leaderboard).
 *
 * IA: Arena owns Live / Upcoming / Archive cups only. Ranks is "The Mind Ladder":
 * one three-way clay switch over Top Minds (solo champions), Intellect Guilds
 * (Telegram channels & groups) and Nations IQ (aggregate country score). Above
 * the ladder sits the Top 3 clay podium, so the list itself starts at #4; the
 * guild board carries its Join / Invite keys there. The squad dock ("My Squad
 * Standing" / join prompt) belongs EXCLUSIVELY to the guild board, and the
 * "Your Standing" module to the two IQ boards.
 * Identity: TIQ (Tactical IQ) is the hero metric — gold digits with the brain
 * glyph, on the HUD pills, the podium and the ladder. #i-cup is reserved for
 * season prizes. The four mind tiers (Rookie / Tactician / Strategist /
 * Grandmaster) are an aura colour driven off your TIQ, never a badge word.
 * Tournament cards are high-energy Dark Clay arena cards with per-status
 * hierarchy (live glow + ENTER ARENA, upcoming slate + Pre-register, ended
 * archive). The Hero cup is three flex rows — header · prizes & meta ·
 * capacity + CTA — and every card sizes to its own content: no fixed height,
 * no overflow clipping, no truncated line.
 */
import {
  formatCountdown,
  getCountryRanking,
  getPlayerRanking,
  getTournaments,
  trendArrow,
  type CountryRow,
  type PlayerRow,
  type Tournament,
  type Trend,
} from './data';
import { nameOf } from './countries';
import { coinSvg, coinText, mountCoins, setBalance } from './coin';
import { onChange, profile, spendCoins } from './storage';
import { motionReduced } from './settings';
import { bindSquadById, getMyContribution, getMySquad, getSquadRanking, onSquadChange, squadKind, squadLetter, type RankedSquad } from './squads';
import { impact, notify, tgUser } from './telegram';
import type { Router } from './router';
import type { Sheets } from './sheets';

export interface CompeteApi {
  router: Router;
  sheets: Sheets;
  sheet(id: string): HTMLElement | null;
}

type Board = 'minds' | 'guilds' | 'nations';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const JOINED_KEY = 'detour.tourneys.v1';

function joinedSet(): Set<string> {
  try {
    const raw = window.localStorage.getItem(JOINED_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set<string>();
  }
}

function saveJoined(s: Set<string>): void {
  try {
    window.localStorage.setItem(JOINED_KEY, JSON.stringify([...s]));
  } catch {
    /* in-memory only */
  }
}

const skel = (rows: number): string =>
  Array.from({ length: rows }, () => '<div class="skel-row"><span class="skel w20"></span><span class="skel w60"></span><span class="skel w15"></span></div>').join('');

const empty = (msg: string): string => `<div class="empty" role="status">${msg}</div>`;

const pctOf = (t: Tournament): number =>
  t.maxPlayers > 0 ? Math.min(100, Math.max(0, Math.round((t.players / t.maxPlayers) * 100))) : 0;

const moodOf = (t: Tournament): string => {
  const pct = pctOf(t);
  if (t.status === 'live') {
    if (pct >= 85) return 'Closing Soon';
    if (pct >= 50) return 'Filling fast';
    return 'Open';
  }
  if (pct >= 90) return 'Almost full';
  if (pct >= 50) return 'Filling fast';
  return 'Open';
};

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
function flagPhoto(code: string | null, cls: string): HTMLElement {
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
  const feedLabel = document.getElementById('arena-feed-t');
  const ranksStats = document.getElementById('ranks-stats');
  const boardSwitch = document.querySelector<HTMLElement>('.ranks-tabs');
  const ranksScreen = document.getElementById('s-ranks');
  const seasonChip = document.getElementById('ranks-season');
  const seasonText = seasonChip?.querySelector<HTMLElement>('.ml-season-t') ?? null;
  const arenaPane = pickEl('arena-tournaments', 'comp-tournaments');
  const podiumEl = document.getElementById('ranks-podium');
  const panes: Record<Board, HTMLElement | null> = {
    minds: document.getElementById('ranks-minds'),
    guilds: document.getElementById('ranks-guilds'),
    nations: document.getElementById('ranks-nations'),
  };

  let board: Board = 'minds';
  let loadedBoard: Partial<Record<Board, boolean>> = {};
  let loadedArena = false;
  /** Aggregate of the last ladder each solo board loaded — the stat chips quote it. */
  const boardStats: Record<'minds' | 'nations', { loaded: boolean; rows: number; points: number }> = {
    minds: { loaded: false, rows: 0, points: 0 },
    nations: { loaded: false, rows: 0, points: 0 },
  };
  let tournaments: Tournament[] = [];
  /** The live cup behind the Nations IQ event pill, fetched with the country board. */
  let natCup: Tournament | null = null;
  let joined = joinedSet();
  let pending: Tournament | null = null;
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
    paintFeedLabel();
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

  function paintFeedLabel(): void {
    if (!feedLabel) return;
    const live = tournaments.filter((t) => t.status === 'live').length;
    const up = tournaments.filter((t) => t.status === 'upcoming').length;
    if (!tournaments.length) {
      feedLabel.textContent = 'Arena feed';
      return;
    }
    const parts: string[] = [];
    if (live) parts.push(`${live} live`);
    if (up) parts.push(`${up} upcoming`);
    feedLabel.textContent = parts.length ? `${parts.join(' · ')} cups` : 'Arena feed';
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

  /* ---------- arena feed ---------- */

    /* ---------- arena pass (tickets + best finish) state ---------- */

  const PASS_KEY = 'detour.arena.pass.v1';

  interface PassState {
    tickets: number;
    /** YYYY-MM-DD of the last daily claim, local time */
    lastClaim: string;
    best: string;
  }

  function todayStr(): string {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function readPass(): PassState {
    const fallback: PassState = { tickets: 2, lastClaim: '', best: 'Top 4' };
    try {
      const raw = window.localStorage.getItem(PASS_KEY);
      if (!raw) return fallback;
      const p = JSON.parse(raw) as Partial<PassState>;
      return {
        tickets: typeof p.tickets === 'number' && Number.isFinite(p.tickets) ? Math.max(0, Math.min(9, Math.floor(p.tickets))) : fallback.tickets,
        lastClaim: typeof p.lastClaim === 'string' ? p.lastClaim : '',
        best: typeof p.best === 'string' && p.best.length > 0 && p.best.length <= 24 ? p.best : fallback.best,
      };
    } catch {
      return fallback;
    }
  }

  function writePass(s: PassState): void {
    try {
      window.localStorage.setItem(PASS_KEY, JSON.stringify(s));
    } catch {
      /* in-memory only */
    }
  }

  function bestFinishLabel(): string {
    // Persisted best finish; new devices start at the motivational default.
    // A real backend would compute this from tournament results.
    const stored = readPass().best;
    if (joined.size > 0) return stored || 'Top 4';
    if (profile.stats.games > 0) return stored || 'Top 4';
    return stored || 'Top 4';
  }

  function trophyPoolOf(t: Tournament): number {
    if (typeof t.trophyPool === 'number' && Number.isFinite(t.trophyPool)) return Math.max(0, Math.floor(t.trophyPool));
    return Math.max(0, Math.round(t.prizePool / 8));
  }

  function trophyEl(kind: 'neon' | 'steel' | 'dim'): HTMLElement {
    const t = document.createElement('span');
    t.className = `trophy trophy-${kind}`;
    t.setAttribute('aria-hidden', 'true');
    const badge = document.createElement('span');
    badge.className = 'trophy-badge';
    // Build SVG via DOM (no innerHTML) so no orphan text nodes can leak.
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(svgNS, 'use');
    use.setAttribute('href', '#i-cup');
    svg.append(use);
    badge.append(svg);
    t.append(badge);
    return t;
  }

  /** Dual prize pool — the shared coin SVG + trophies, no orphan spans, no truncation.
   *  Hero: two tactile chips, gold coins "5,000" + sky trophies "🏆 750".
   *  Upcoming (compact): one quiet line "5,000 · 🏆 150". */
  function prizePoolEl(t: Tournament, compact = false): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = compact ? 'arena-prizes is-compact' : 'arena-prizes is-hero-pool';
    const coins = coinText(t.prizePool);
    const trophies = trophyPoolOf(t).toLocaleString('en-US');
    wrap.setAttribute('aria-label', `Prize pool ${coins} coins plus ${trophies} trophies`);

    const coinHost = document.createElement('span');
    coinHost.className = 'arena-coin';
    coinHost.append(coinSvg());
    const amount = document.createElement('span');
    amount.className = 'arena-coin-amt';
    amount.textContent = coins;

    const cup = document.createElement('span');
    cup.className = 'arena-cup-emo';
    cup.textContent = '🏆';
    cup.setAttribute('aria-hidden', 'true');
    const trAmt = document.createElement('span');
    trAmt.className = 'arena-trophy-amt';
    trAmt.textContent = trophies;

    if (compact) {
      wrap.append(coinHost, amount, document.createTextNode(' · '), cup, trAmt);
    } else {
      const coinChip = document.createElement('span');
      coinChip.className = 'arena-prize-chip is-coins';
      coinChip.append(coinHost, amount);
      const trophyChip = document.createElement('span');
      trophyChip.className = 'arena-prize-chip is-trophies';
      trophyChip.append(cup, trAmt);
      wrap.append(coinChip, trophyChip);
    }
    return wrap;
  }

  function meterEl(t: Tournament): HTMLElement {
    const pct = pctOf(t);
    const wrap = document.createElement('div');
    wrap.className = 'cap-meter';
    const track = document.createElement('span');
    track.className = 'cap-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', `${t.name} capacity: ${t.players} of ${t.maxPlayers} entered`);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(pct));
    const fill = document.createElement('i');
    fill.className = 'cap-fill';
    fill.style.width = `${pct}%`;
    track.append(fill);
    wrap.append(track);
    return wrap;
  }

  /** Capacity head. Hero is spec-exact: "184/256 entered". Upcoming keeps the
   *  fill mood after it. Always a single line the card has room for — never clipped. */
  function capLabelEl(t: Tournament, hero = false): HTMLElement {
    const label = document.createElement('span');
    label.className = 'cap-label';
    label.append(document.createTextNode(hero ? `${t.players}/${t.maxPlayers} entered` : `${t.players}/${t.maxPlayers} entered · `));
    if (!hero) {
      const hot = document.createElement('span');
      hot.className = 'hot';
      hot.textContent = moodOf(t);
      label.append(hot);
    }
    label.setAttribute('aria-label', `${t.players} of ${t.maxPlayers} players entered${hero ? '' : `, ${moodOf(t)}`}`);
    return label;
  }

  function actionBtn(t: Tournament): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isJoined = joined.has(t.id);
    if (t.status === 'live') {
      btn.className = 'btn btn-coral arena-cta hero-cta';
      btn.disabled = isJoined;
      // Spec-exact primary CTA: bold tactile 3D "ENTER ARENA" (CSS uppercases visually).
      btn.textContent = isJoined ? 'Entered ✓' : 'ENTER ARENA';
      btn.dataset.hero = 'enter';
    } else {
      btn.className = 'btn btn-ghost arena-cta upcoming-cta';
      btn.disabled = isJoined;
      // Spec-exact secondary CTA: sleek tactile "Pre-register".
      if (isJoined) btn.textContent = t.entryFee ? 'Pre-registered ✓' : 'Reminder Set ✓';
      else btn.textContent = 'Pre-register';
    }
    btn.setAttribute('aria-label', `${btn.textContent}: ${t.name}`);
    btn.addEventListener('click', () => askJoin(t));
    return btn;
  }

  function buildLiveCard(t: Tournament): HTMLElement {
    const card = document.createElement('article');
    card.className = 'arena-card is-live is-hero';
    card.dataset.id = t.id;
    card.setAttribute('aria-label', `${t.name}, live tournament, prize pool ${coinText(t.prizePool)} plus ${trophyPoolOf(t)} trophies`);

    const glow = document.createElement('div');
    glow.className = 'arena-glow';
    glow.setAttribute('aria-hidden', 'true');
    card.append(glow);
    const backlight = document.createElement('div');
    backlight.className = 'arena-hero-backlight';
    backlight.setAttribute('aria-hidden', 'true');
    card.append(backlight);

    /* Row 1 — header: cup icon + cup name on the left, pulsing ● LIVE on the right. */
    const top = document.createElement('div');
    top.className = 'arena-top';
    const id = document.createElement('div');
    id.className = 'arena-id';
    id.append(trophyEl('neon'));
    const titles = document.createElement('div');
    titles.className = 'arena-titles';
    const name = document.createElement('h3');
    name.className = 'arena-name';
    name.textContent = t.name;
    titles.append(name);
    id.append(titles);
    const badge = document.createElement('span');
    badge.className = 'pill live pulse';
    badge.setAttribute('aria-label', 'Live tournament');
    const dot = document.createElement('i');
    dot.className = 'live-dot';
    dot.setAttribute('aria-hidden', 'true');
    // Spec-exact pulsing red "● LIVE" (dot + uppercase label, no orphan text).
    const liveLabel = document.createElement('b');
    liveLabel.className = 'live-label';
    liveLabel.textContent = 'LIVE';
    badge.append(dot, liveLabel);
    top.append(id, badge);
    card.append(top);

    /* Row 2 — prizes & meta: gold coins + trophies + entry info (+ time left). */
    const prizeRow = document.createElement('div');
    prizeRow.className = 'arena-prize-row hero-prizes';
    prizeRow.append(prizePoolEl(t, false));
    const entry = document.createElement('span');
    entry.className = 'arena-sub hero-entry';
    entry.textContent = t.entryFee ? `${coinText(t.entryFee)} entry · Free with ticket` : 'Free entry';
    prizeRow.append(entry);
    const time = document.createElement('span');
    time.className = 'arena-time hero-time';
    time.dataset.count = t.id;
    time.textContent = `${formatCountdown(t.endsAt)} left`;
    prizeRow.append(time);
    card.append(prizeRow);

    /* Row 3 — capacity & CTA: progress meter on the left, ENTER ARENA on the right. */
    const foot = document.createElement('div');
    foot.className = 'arena-foot hero-foot';
    const capBlock = document.createElement('div');
    capBlock.className = 'arena-cap-block';
    capBlock.append(capLabelEl(t, true), meterEl(t));
    foot.append(capBlock, actionBtn(t));
    card.append(foot);
    return card;
  }

  function buildUpcomingCard(t: Tournament): HTMLElement {
    const card = document.createElement('article');
    card.className = 'arena-card is-upcoming';
    card.dataset.id = t.id;
    card.setAttribute('aria-label', `${t.name}, upcoming tournament, prize pool ${coinText(t.prizePool)} plus ${trophyPoolOf(t)} trophies`);

    const top = document.createElement('div');
    top.className = 'arena-top';
    const id = document.createElement('div');
    id.className = 'arena-id';
    id.append(trophyEl('steel'));
    const titles = document.createElement('div');
    titles.className = 'arena-titles';
    const name = document.createElement('h3');
    name.className = 'arena-name';
    name.textContent = t.name;
    const sub = document.createElement('p');
    sub.className = 'arena-sub';
    sub.textContent = t.entryFee ? `${coinText(t.entryFee)} entry · Free with ticket` : 'Free entry · Reminder available';
    titles.append(name, sub);
    id.append(titles);
    const badge = document.createElement('span');
    badge.className = 'pill upcoming countdown-badge';
    badge.dataset.start = t.id;
    // Spec-exact uppercase countdown: "STARTS IN 1D 1H".
    badge.textContent = `STARTS IN ${formatCountdown(t.endsAt).toUpperCase()}`;
    top.append(id, badge);
    card.append(top);

    const prizeRow = document.createElement('div');
    prizeRow.className = 'arena-prize-row';
    prizeRow.append(prizePoolEl(t, true));
    const slots = document.createElement('span');
    slots.className = 'arena-slots';
    slots.textContent = `${t.maxPlayers - t.players} slots left`;
    prizeRow.append(slots);
    card.append(prizeRow);

    // Foot: capacity meter left, sleek tactile Pre-register right — never clipped.
    const foot = document.createElement('div');
    foot.className = 'arena-foot upcoming-foot';
    const capBlock = document.createElement('div');
    capBlock.className = 'arena-cap-block';
    capBlock.append(capLabelEl(t), meterEl(t));
    foot.append(capBlock, actionBtn(t));
    card.append(foot);
    return card;
  }

  function buildEndedCard(t: Tournament): HTMLElement {
    const card = document.createElement('article');
    card.className = 'arena-card is-ended';
    card.dataset.id = t.id;

    const top = document.createElement('div');
    top.className = 'arena-top';
    const id = document.createElement('div');
    id.className = 'arena-id';
    id.append(trophyEl('dim'));
    const titles = document.createElement('div');
    titles.className = 'arena-titles';
    const name = document.createElement('h3');
    name.className = 'arena-name';
    name.textContent = t.name;
    const sub = document.createElement('p');
    sub.className = 'arena-sub';
    sub.textContent = 'Final · archived';
    titles.append(name, sub);
    id.append(titles);
    const badge = document.createElement('span');
    badge.className = 'pill ended';
    badge.textContent = 'Final';
    top.append(id, badge);
    card.append(top);

    const champ = document.createElement('div');
    champ.className = 'arena-champ';
    const cup = document.createElement('span');
    cup.className = 'champ-cup';
    cup.textContent = '🏆';
    cup.setAttribute('aria-hidden', 'true');
    const who = document.createElement('span');
    who.className = 'champ-who';
    who.textContent = t.champion ?? 'Champion crowned';
    const meta = document.createElement('span');
    meta.className = 'champ-meta';
    const paid = t.championMeta ? `${t.championMeta} · ${coinText(t.prizePool)} paid` : `${coinText(t.prizePool)} distributed`;
    meta.textContent = paid;
    champ.append(cup, who, meta);
    champ.setAttribute('aria-label', `Winner ${who.textContent}, ${paid}`);
    card.append(champ);
    return card;
  }

  /** Player Arena Pass & Status: clean ticket bar (no orphans, no truncation).
   *  Left = icon + stacked "Tickets: 2" / "Best Finish: Top 4"; right = actions. */
  function buildPassWidget(): HTMLElement {
    const pass = readPass();
    const claimedToday = pass.lastClaim === todayStr();

    const card = document.createElement('section');
    card.className = 'arena-pass';
    card.setAttribute('aria-label', 'Player Arena Pass and status');

    const main = document.createElement('div');
    main.className = 'arena-pass-main';

    const left = document.createElement('div');
    left.className = 'arena-pass-left';
    const ico = document.createElement('span');
    ico.className = 'arena-pass-ico';
    ico.textContent = '🎟️';
    ico.setAttribute('aria-hidden', 'true');
    const titles = document.createElement('div');
    titles.className = 'arena-pass-titles';
    // Spec-exact clean balance: "Tickets: 2" (single text node, no emoji dup, no orphans).
    const count = document.createElement('b');
    count.className = 'arena-pass-count';
    count.textContent = `Tickets: ${pass.tickets}`;
    const sub = document.createElement('small');
    sub.className = 'arena-pass-sub';
    sub.textContent = `Best Finish: ${bestFinishLabel()}`;
    titles.append(count, sub);
    left.append(ico, titles);

    const actions = document.createElement('div');
    actions.className = 'arena-pass-actions';

    const claim = document.createElement('button');
    claim.type = 'button';
    claim.className = 'btn btn-primary sm arena-pass-claim';
    claim.disabled = claimedToday;
    claim.textContent = claimedToday ? 'Claimed ✓' : 'Claim +1 Free';
    claim.setAttribute('aria-label', claimedToday ? 'Daily ticket already claimed' : 'Claim free daily ticket');
    claim.addEventListener('click', () => {
      const cur = readPass();
      if (cur.lastClaim === todayStr()) return;
      cur.tickets = Math.min(9, cur.tickets + 1);
      cur.lastClaim = todayStr();
      writePass(cur);
      count.textContent = `Tickets: ${cur.tickets}`;
      claim.disabled = true;
      claim.textContent = 'Claimed ✓';
      claim.setAttribute('aria-label', 'Daily ticket already claimed');
      notify('success');
      impact('medium');
    });

    const history = document.createElement('button');
    history.type = 'button';
    history.className = 'btn btn-ghost sm arena-pass-history';
    history.textContent = 'History';
    history.setAttribute('aria-label', 'Open tournament history');
    history.addEventListener('click', () => {
      impact('light');
      const arch = arenaPane.querySelector<HTMLDetailsElement>('details.arena-archive');
      if (arch) {
        arch.open = true;
        const sum = arch.querySelector<HTMLElement>('summary');
        if (sum) sum.focus({ preventScroll: true });
        arch.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        api.router.go('ranks');
      }
    });

    actions.append(claim, history);
    main.append(left, actions);
    card.append(main);
    return card;
  }

  async function loadTournaments(): Promise<void> {
    const el = arenaPane;
    if (!el) return;
    if (!loadedArena) el.innerHTML = skel(3);
    try {
      tournaments = await getTournaments();
    } catch {
      el.innerHTML = empty('Tournaments unavailable. Check your connection and try again.');
      paintFeedLabel();
      return;
    }
    // Live first, upcoming next, ended last — the feed never mixes the archive in.
    tournaments.sort((a, b) => {
      const order = { live: 0, upcoming: 1, ended: 2 } as const;
      return order[a.status] - order[b.status];
    });
    if (!tournaments.length) {
      el.innerHTML = empty('No tournaments right now. Check back soon.');
      el.append(buildPassWidget());
      paintFeedLabel();
      return;
    }
    el.textContent = '';
    const live = tournaments.filter((t) => t.status === 'live');
    const up = tournaments.filter((t) => t.status === 'upcoming');
    const done = tournaments.filter((t) => t.status === 'ended');

    for (const t of live) el.append(buildLiveCard(t));
    for (const t of up) el.append(buildUpcomingCard(t));

    // Player status module sits right under the cups in the same flex column.
    el.append(buildPassWidget());

    if (done.length) {
      const arch = document.createElement('details');
      arch.className = 'arena-archive';
      const sum = document.createElement('summary');
      sum.className = 'arena-archive-sum';
      const t = document.createElement('span');
      t.textContent = `Archive · Recent Results (${done.length})`;
      const archChev: HTMLElement = document.createElement('span');
      archChev.className = 'arch-chev';
      archChev.textContent = '›';
      archChev.setAttribute('aria-hidden', 'true');
      sum.append(t, archChev);
      arch.append(sum);
      const list = document.createElement('div');
      list.className = 'arena-archive-list';
      for (const e of done) list.append(buildEndedCard(e));
      arch.append(list);
      el.append(arch);
    }

    mountCoins(el);
    loadedArena = true;
    paintFeedLabel();
    startTick();
  }

  function askJoin(t: Tournament): void {
    if (t.status === 'ended' || joined.has(t.id)) return;
    pending = t;
    ($('tourney-desc') as HTMLElement).textContent = `${t.name} · ${t.players}/${t.maxPlayers} players · ${formatCountdown(t.endsAt)} left`;
    ($('tourney-fee') as HTMLElement).textContent = coinText(t.entryFee);
    setBalance($('tourney-have') as HTMLElement, profile.coins);
    ($('tourney-after') as HTMLElement).textContent = coinText(Math.max(0, profile.coins - t.entryFee));
    const err = $('tourney-err');
    err.hidden = true;
    const yes = $('tourney-yes') as HTMLButtonElement;
    yes.textContent = t.entryFee ? `Join for ${coinText(t.entryFee)}` : 'Join free';
    yes.disabled = profile.coins < t.entryFee;
    if (profile.coins < t.entryFee) {
      err.hidden = false;
      err.textContent = `Not enough coins — ${coinText(t.entryFee - profile.coins)} short. Win a race to top up.`;
    }
    const sheet = api.sheet('sheet-tourney');
    if (sheet) {
      impact('light');
      api.sheets.open(sheet);
    }
  }

  ($('tourney-yes') as HTMLButtonElement).addEventListener('click', () => {
    if (!pending) return;
    const t = pending;
    pending = null;
    if (joined.has(t.id)) {
      api.sheets.close();
      return;
    }
    if (!spendCoins(t.entryFee)) {
      notify('warning');
      ($('tourney-err') as HTMLElement).hidden = false;
      ($('tourney-err') as HTMLElement).textContent = 'Not enough coins for that entry.';
      return;
    }
    joined.add(t.id);
    saveJoined(joined);
    notify('success');
    impact('medium');
    api.sheets.close();
    loadedArena = false;
    void loadTournaments();
  });

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
      if (!isArenaVisible()) return;
      for (const t of tournaments) {
        if (t.status === 'ended') continue;
        const time = arenaPane.querySelector<HTMLElement>(`[data-count="${t.id}"]`);
        if (time) time.textContent = `${formatCountdown(t.endsAt)} left`;
        const pill = arenaPane.querySelector<HTMLElement>(`[data-start="${t.id}"]`);
        if (pill) pill.textContent = `STARTS IN ${formatCountdown(t.endsAt).toUpperCase()}`;
      }
    }, 1000);
  }

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
    li.tabIndex = 0;
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
  function mindAxes(): { label: string; pct: number; hint: string }[] {
    const s = profile.stats;
    const g = Math.max(0, s.games);
    const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n * 100)));
    return [
      { label: 'Foresight', pct: clamp(g ? s.wins / g : 0), hint: 'Win rate across every race' },
      { label: 'Tempo', pct: clamp(g / 40), hint: 'Races played — 40 fills the bar' },
      { label: 'Traps', pct: clamp(g ? (s.modes.online ?? 0) / g : 0), hint: 'Share of races against real minds' },
      { label: 'Compose', pct: clamp(s.best + s.losses > 0 ? s.best / (s.best + s.losses) : 0), hint: 'Best streak held against losses' },
    ];
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

    /* ring: an SVG arc on pathLength=100, so the dash is literally the percentage */
    const ring = document.createElement('span');
    ring.className = 'mh-ring';
    ring.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'mh-arc');
    svg.setAttribute('viewBox', '0 0 44 44');
    const mk = (cls: string): SVGElement => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('class', cls);
      c.setAttribute('cx', '22');
      c.setAttribute('cy', '22');
      c.setAttribute('r', '19');
      c.setAttribute('fill', 'none');
      svg.append(c);
      return c;
    };
    mk('mh-arc-track');
    const arc = mk('mh-arc-fill');
    arc.setAttribute('pathLength', '100');
    arc.setAttribute('stroke-dasharray', `${onBoard ? pct : 0} 100`);
    const av = document.createElement('b');
    const h = youHandle() ?? 'Y';
    av.textContent = h.replace(/^@/, '').slice(0, 1).toUpperCase() || 'Y';
    ring.append(svg, av);

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

  /** A one-line event banner; the countdown is the live cup's own deadline. */
  const natPillText = (cup: Tournament | null): string =>
    cup
      ? `Nations Cup · ${formatCountdown(cup.endsAt)} · wins count double for your flag.`
      : 'Nations Cup · bracket opens soon · wins count double for your flag.';

  function nationsPill(cup: Tournament | null): HTMLElement {
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
    let cups: Tournament[];
    try {
      const pair = await Promise.all([getCountryRanking(), getTournaments()]);
      rows = pair[0];
      cups = pair[1];
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
    natCup = cups.find((c) => c.status === 'live') ?? null;
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
    paintPodium(rows.slice(0, 3).map((p, i) => ({
      rank: i + 1,
      name: p.name,
      score: p.points.toLocaleString('en-US'),
      code: p.countryCode,
      tier: tierOf(p.points),
      tierLabel: divisionOf(p.points).label,
      delta: deltaOf(p.id, p.points, p.trend),
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
    li.setAttribute('aria-label', `${label}, ${s.handle}, rank ${s.rank}, ${s.trophies.toLocaleString('en-US')} Tactical IQ. Press Enter for squad details.`);
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

    // The whole row opens squad details; the compact key joins / invites.
    li.addEventListener('click', () => {
      impact('light');
      openSquadSheet();
    });
    li.addEventListener('keydown', (e) => {
      if (e.target !== li) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        impact('light');
        openSquadSheet();
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
    loadedArena = false;
    if (isRanksVisible()) {
      paintRanks();
      void loadBoard(board);
    } else if (isArenaVisible()) {
      paintArena();
      void loadTournaments();
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
        void loadTournaments();
      } else if (id === 'ranks') {
        paintRanks();
        startTick();
        void loadBoard(board);
      }
    },
  };
}
