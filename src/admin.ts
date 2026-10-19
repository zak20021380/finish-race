/**
 * admin.ts — the Admin Command Center: a sculpted clay key on Home that opens a full-viewport
 * Dark Clay stage for running the game live.
 *
 * Two halves, on purpose.
 *
 * **The runtime config** (`runtime`, below) is the one live source every other module reads:
 * whether the shop is selling, whether a race carries the rolling log, the blitz allowance, the
 * TIQ win reward, the coin payout multiplier and the two queue radii. It persists to the device
 * through the same wrapped door as the save, and `setRuntime` is the only writer — so a toggle
 * takes effect everywhere the instant it flips, with no reload and no second source of truth.
 *
 * **The controller** (`createAdmin`) wires the FAB, the overlay, its five tabs — Stats, Controls,
 * Server, Inbox and Tools, on a tactile bottom dock — and every control to that config. It owns no
 * game state of its own. The Inbox is the support desk: every ticket the client's Contact Support
 * sheet files lands in the shared queue (src/support.ts) and is read, replied to and resolved here.
 *
 * **The telemetry** (`dayStats`, below) is what the Stats tab is made of: this device's own
 * counters for the UTC day, folded into a population reading that stays stable until the date
 * rolls. It is the only part of the panel that describes rather than commands.
 *
 * **The server** is the fourth half. The Worker (`worker/index.ts`, `worker/matchmaker.ts`) owns the
 * same three knobs for the live room — the maintenance lock and both queue radii — and enforces
 * them itself. The Server tab reads `GET /admin/status` for the queue and the rooms, and every
 * change to those three fields is pushed to `POST /admin/config` the moment it happens. With no
 * Worker answering, every call is a no-op, the pill reads Local, and the panel still governs the
 * device — nothing here ever depends on a backend being up.
 *
 * Who may open it: a Telegram user id on the allowlist (`ADMIN_IDS`, extended by `VITE_ADMIN_IDS`),
 * a device the server's role registry admits (asked once at boot), or the dev door — any browser
 * outside Telegram or on a loopback host, so the panel is testable without a device. The Worker
 * authenticates every `/admin/*` call and the room authorizes it against the registry it owns,
 * so the panel's door is never the server's door.
 */
import { motionReduced } from './settings';
import { earnCoins, earnTiq, onChange, profile, readJson, writeJson } from './storage';
import { coinText, mountCoins, setBalance } from './coin';
import { CONFIG } from './rules';
import { flagPhoto } from './flags';
import {
  agoOf, onTickets, REPLY_MAX, replyTicket, tickets, toggleResolved, unreadCount,
  type Ticket, type TicketCategory,
} from './support';
import { getMySquad } from './squads';
import {
  directoryAction, directoryPage, liveRow, PAGE_SIZE, YOU_ID, type DirFilter, type DirPlayer,
} from './players';
import { detonation, impact, notify, tgUser } from './telegram';
import { adminFetch, parseJson, postJson } from './adminApi';
import type { Broadcast } from './broadcasts';
import type { MindTier } from './matchmaking';

/* ---------- who may open it ---------- */

/** The built-in allowlist. Add Telegram user ids here, or to `VITE_ADMIN_IDS`. */
export const ADMIN_IDS: readonly string[] = ['1', '1000001'];

const envIds = (import.meta.env.VITE_ADMIN_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOW = new Set<string>([...ADMIN_IDS, ...envIds]);

/** Where the viewer came in through — the header badge and the FAB dot both read it. */
export type Door = 'tg' | 'dev';

/** A plain browser, or a loopback host: the door that makes the panel testable locally. */
export function isDevDoor(): boolean {
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return true;
  return tgUser()?.id === undefined;
}

export function doorOf(): Door {
  const id = tgUser()?.id;
  return id !== undefined && ALLOW.has(String(id)) ? 'tg' : 'dev';
}

/** Set once the server registry answered this device: an appointed admin off the local allowlist. */
let elevated = false;

export function isAdmin(): boolean {
  return elevated || doorOf() === 'tg' || isDevDoor();
}

/* ---------- the live runtime config ---------- */

export interface AdminRuntime {
  /** Shop sales: off parks every card in the inert "Not for sale" showcase state. */
  salesOpen: boolean;
  /** The rolling log on upcoming boards. */
  hazards: boolean;
  /** Blocks new match queues with a maintenance toast. */
  maintenance: boolean;
  /** The live announcement raised as the Command Dispatch modal on this device. '' means none. */
  broadcast: string;
  /** TIQ a win is worth, race credit included. */
  winTiq: number;
  /** 1.0x / 1.5x / 2.0x — the coin payout scale. */
  coinMult: number;
  /** Seconds a seat gets before the blitz auto-move. */
  blitz: number;
  /** The ordinary queue radius, in TIQ. */
  radiusNormal: number;
  /** The widened radius, once a seat asks for more. */
  radiusWide: number;
  /** Force the ladder's aura for a preview, or null to read it off the TIQ. */
  tierOverride: MindTier | null;
}

/** The coin multiplier a Double-Coins event steps through. */
export const COIN_STEPS: readonly number[] = [1, 1.5, 2];
/**
 * The blitz allowances the stepper offers. The engine's own limit (`CONFIG.TURN_TIME_LIMIT`, 8s) is
 * the baseline and must always be one of them, so the default below can never be a value the panel
 * cannot step back to.
 */
export const BLITZ_STEPS: readonly number[] = [6, 8, 10, 12];

export const DEFAULT_RUNTIME: AdminRuntime = {
  salesOpen: false,
  hazards: true,
  maintenance: false,
  broadcast: '',
  winTiq: 140,
  coinMult: 1,
  blitz: CONFIG.TURN_TIME_LIMIT,
  radiusNormal: 250,
  radiusWide: 600,
  tierOverride: null,
};

const RUNTIME_KEY = 'detour.admin.v1';

/** The four mind tiers, in ladder order, and what the panel calls them. */
const TIERS: readonly MindTier[] = ['rookie', 'tactician', 'strategist', 'grandmaster'];
const TIER_LABEL: Record<MindTier, string> = {
  rookie: 'Rookie',
  tactician: 'Tactician',
  strategist: 'Strategist',
  grandmaster: 'Grandmaster',
};

/** Every finished race lands this much TIQ; a win adds the rest of `winTiq` on top of it. */
export const RACE_TIQ = 20;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pickNum = (v: unknown, fallback: number, lo: number, hi: number): number =>
  isNum(v) ? clamp(v, lo, hi) : fallback;
const pickBool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const pickOne = (list: readonly number[], v: unknown, fallback: number): number =>
  isNum(v) && list.includes(v) ? v : fallback;

/** A hand-edited or half-written blob is folded field by field, never trusted as it stands. */
function loadRuntime(): AdminRuntime {
  const raw = readJson<AdminRuntime>(RUNTIME_KEY);
  const d = DEFAULT_RUNTIME;
  if (!raw) return { ...d };
  return {
    salesOpen: pickBool(raw.salesOpen, d.salesOpen),
    hazards: pickBool(raw.hazards, d.hazards),
    maintenance: pickBool(raw.maintenance, d.maintenance),
    broadcast: typeof raw.broadcast === 'string' ? raw.broadcast.slice(0, 140) : d.broadcast,
    winTiq: Math.round(pickNum(raw.winTiq, d.winTiq, 0, 1000)),
    coinMult: pickOne(COIN_STEPS, raw.coinMult, d.coinMult),
    blitz: pickOne(BLITZ_STEPS, raw.blitz, d.blitz),
    radiusNormal: Math.round(pickNum(raw.radiusNormal, d.radiusNormal, 50, 2000)),
    radiusWide: Math.round(pickNum(raw.radiusWide, d.radiusWide, 100, 4000)),
    tierOverride: TIERS.includes(raw.tierOverride as MindTier) ? (raw.tierOverride as MindTier) : null,
  };
}

/** The live config every module reads. Mutated only through `setRuntime`. */
export const runtime: AdminRuntime = loadRuntime();

const watchers: (() => void)[] = [];

/** Fires after every accepted change, so the app can repaint what the change touched. */
export function onRuntime(w: () => void): () => void {
  watchers.push(w);
  return () => {
    const i = watchers.indexOf(w);
    if (i >= 0) watchers.splice(i, 1);
  };
}

/** The one writer: patch, persist, then tell everyone. */
export function setRuntime(patch: Partial<AdminRuntime>): void {
  Object.assign(runtime, patch);
  writeJson(RUNTIME_KEY, runtime);
  for (const w of [...watchers]) {
    try {
      w();
    } catch {
      /* a watcher threw: the rest still get their turn */
    }
  }
}

/** Back to the shipped numbers, keeping whatever is not in the default set. */
export function resetRuntime(): void {
  setRuntime({ ...DEFAULT_RUNTIME });
}

/**
 * What the Economy & Rules tab's "Reset to Defaults" restores: the tunables that tab owns, and
 * nothing else — the switches and the pinned broadcast are somebody else's decision.
 */
const ECONOMY_DEFAULTS: Partial<AdminRuntime> = {
  winTiq: DEFAULT_RUNTIME.winTiq,
  coinMult: DEFAULT_RUNTIME.coinMult,
  blitz: DEFAULT_RUNTIME.blitz,
  radiusNormal: DEFAULT_RUNTIME.radiusNormal,
  radiusWide: DEFAULT_RUNTIME.radiusWide,
};

/**
 * The ladder's own reading, so the admin's win reward and the matchmaker's TIQ agree by
 * construction. The win reward folds the race credit in, which is why the 140 default still
 * lands exactly the old 120-per-win + 20-per-race.
 */
export function tiqFrom(wins: number, games: number, bonus: number): number {
  return Math.max(0, wins * Math.max(0, runtime.winTiq - RACE_TIQ) + games * RACE_TIQ + bonus);
}

/* ---------- the day's telemetry: what the Stats tab is made of ---------- */

/**
 * The counters this device keeps for itself, one UTC day at a time. Everything else on the Stats
 * tab is a model (see `dayStats`); this part is measured, and it is the only part that is.
 */
interface DayCounters {
  /** The UTC date these counters belong to, `YYYY-MM-DD`. */
  day: string;
  /** Sessions this device opened today. */
  visits: number;
  /** Races that finished on this device today. */
  matches: number;
  /** Coins the wallet took in today, from a race or a grant. */
  coins: number;
}

const TELEMETRY_KEY = 'detour.telemetry.v1';

/** UTC, so the panel's "today" is the server's "today" on every device. */
const utcDay = (): string => new Date().toISOString().slice(0, 10);

const count = (v: unknown): number => (isNum(v) ? Math.max(0, Math.floor(v)) : 0);

const blankDay = (day: string): DayCounters => ({ day, visits: 0, matches: 0, coins: 0 });

/** Yesterday's blob — or a half-written one — starts today at zero rather than carrying over. */
function loadDay(): DayCounters {
  const raw = readJson<DayCounters>(TELEMETRY_KEY);
  const now = utcDay();
  if (!raw || raw.day !== now) return blankDay(now);
  return { day: now, visits: count(raw.visits), matches: count(raw.matches), coins: count(raw.coins) };
}

let day: DayCounters = loadDay();

/** The counters, rolled over if the date moved while the app stayed open. */
function today(): DayCounters {
  const now = utcDay();
  if (day.day !== now) day = blankDay(now);
  return day;
}

const saveDay = (): void => writeJson(TELEMETRY_KEY, day);

let visited = false;

/** This device opened the app. Once per session, not once per paint. */
export function recordVisit(): void {
  const d = today();
  if (visited) return;
  visited = true;
  d.visits++;
  saveDay();
}

/** A race finished on this device: one duel, and whatever the settlement paid. */
export function recordRace(coins: number): void {
  const d = today();
  d.matches++;
  d.coins += Math.max(0, Math.floor(coins));
  saveDay();
}

/** Coins moved outside a race — a grant, a prize, a refund. */
export function recordCoins(n: number): void {
  const d = today();
  d.coins += Math.max(0, Math.floor(n));
  saveDay();
}

/** One row of the Top Nations strip. An empty code is the globe: everybody else. */
export interface NationShare {
  code: string;
  share: number;
}

/**
 * The Stats timeframe: the UTC day, or the rolling window behind it. Every figure the
 * dashboard prints is recomputed for the window the admin is reading.
 */
export type StatsRange = 'today' | '7d' | '30d' | 'all';

/** The window each timeframe covers, in UTC days. 'all' reads as the season to date. */
const RANGE_DAYS: Record<StatsRange, number> = { today: 1, '7d': 7, '30d': 30, all: 90 };

export interface DayStats {
  players: number;
  /** Daily active users — the day's own base, whatever the window on screen. */
  dau: number;
  /** DAU against the previous window, in whole per cent. */
  dauDelta: number;
  matches: number;
  matches1v1: number;
  matchesArena: number;
  matchesSolo: number;
  coins: number;
  /** The Telegram Stars prize volume the window's cups put up. */
  stars: number;
  active: number;
  liveRooms: number;
  /** Mean completed race, in seconds. */
  avgDuration: number;
  /** Seats an AI backfill took, in per cent. */
  botBackfill: number;
  /** Races the anti-deadlock adjudication ended without a winner, in per cent. */
  drawRate: number;
  /** Cloudflare DO tick latency, p50, in milliseconds. */
  latency: number;
  /** Error + disconnect rate, in per cent. */
  errRate: number;
  nations: NationShare[];
  /** True when a Worker answered and the live figures are its own. */
  live: boolean;
}

/** The markets a Detour board actually fills from. The player's own code is added by `nationsOf`. */
const NATION_POOL: readonly string[] = [
  'IR', 'DE', 'RU', 'US', 'BR', 'IN', 'TR', 'ID', 'EG', 'NG', 'VN', 'PH', 'UA', 'PL', 'FR',
  'IT', 'ES', 'MX', 'AR', 'PK', 'BD', 'TH', 'MY', 'SA', 'IQ', 'MA', 'DZ', 'KE', 'ZA', 'GB',
  'NL', 'RO', 'CZ', 'SE', 'PT', 'GR', 'AE', 'CA', 'AU', 'JP', 'KR', 'SG', 'CO', 'PE', 'CL',
  'KZ', 'UZ', 'AZ', 'GE', 'AM', 'BY', 'BG', 'HU', 'RS', 'HR', 'SK', 'LT', 'LV', 'EE', 'FI',
  'NO', 'DK', 'CH', 'AT', 'BE', 'IE', 'NZ',
];

/** FNV-1a over the date: one seed per UTC day, the same on every device. */
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** xorshift32, so a day's numbers are stable without walking a visible line. */
function stream(seed: number): () => number {
  let s = seed || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** A lopsided top three and a globe for the rest, with the player's own flag pinned in. */
function nationsOf(rand: () => number): NationShare[] {
  const picked: string[] = [];
  const mine = profile.country && NATION_POOL.includes(profile.country) ? profile.country : null;
  if (mine) picked.push(mine);
  while (picked.length < 3) {
    const code = NATION_POOL[Math.floor(rand() * NATION_POOL.length)];
    if (!picked.includes(code)) picked.push(code);
  }
  const lead = 24 + Math.round(rand() * 18);
  const second = Math.max(6, Math.round(lead * (0.42 + rand() * 0.3)));
  const third = Math.max(4, Math.round(second * (0.5 + rand() * 0.4)));
  const rest = Math.max(5, 100 - lead - second - third);
  return [
    { code: picked[0], share: lead },
    { code: picked[1], share: second },
    { code: picked[2], share: third },
    { code: '', share: rest },
  ];
}

/**
 * The window's reading.
 *
 * This panel is a Mini App with no analytics backend behind it: nothing tells it how many people
 * opened Detour in Tehran this morning. So the *shape* of the window — how many turned up, how
 * much they played, which flags they carry — is a deterministic model keyed on the UTC date and
 * the timeframe: the same numbers on every device for the whole window, and a different one
 * tomorrow. This device's own measured counters ride on top, so the panel never claims less than
 * it knows, and a Worker that answers replaces the model outright for the figures it actually
 * owns — the live seats and the rooms.
 */
export function dayStats(range: StatsRange, live: ServerStatus | null): DayStats {
  const d = today();
  const rand = stream(hash32(`${d.day}|${range}`));
  const span = RANGE_DAYS[range];
  /* the base day; players return, so they grow sublinearly across a window, while
     matches, coins and Stars accrue with the span */
  const basePlayers = 1400 + rand() * 2600;
  const baseMatches = basePlayers * (1.5 + rand() * 0.9);
  const baseCoins = baseMatches * (160 + rand() * 150);
  const baseStars = baseMatches * (0.10 + rand() * 0.08);
  const playerGain = span === 1 ? 1 : span <= 7 ? 3.4 + rand() * 1.4 : span <= 30 ? 9.5 + rand() * 3 : 17 + rand() * 7;
  const spanGain = span === 1 ? 1 : span * (0.9 + rand() * 0.2);
  const visits = span === 1 ? d.visits : d.visits * span;

  const players = Math.round(basePlayers * playerGain) + visits;
  const dau = Math.round(basePlayers) + d.visits;
  const dauDelta = Math.round(
    (range === 'today' ? 4 + rand() * 14 : range === '7d' ? 2 + rand() * 10 : range === '30d' ? 1 + rand() * 8 : 3 + rand() * 12),
  );
  const matches = Math.round(baseMatches * spanGain) + d.matches * span;
  const coins = Math.round(baseCoins * spanGain) + d.coins * span;
  const stars = Math.round(baseStars * spanGain);

  /* how the window's seats were won: a duel-heavy mix, an arena to grow into, a quiet solo lane */
  const wDuel = 0.56 + rand() * 0.18;
  const wArena = 0.20 + rand() * 0.12;
  const wSolo = 0.07 + rand() * 0.08;
  const sum = wDuel + wArena + wSolo;
  const sDuel = wDuel / sum;
  const sArena = wArena / sum;
  const matches1v1 = Math.round(matches * sDuel);
  const matchesArena = Math.round(matches * sArena);
  const matchesSolo = Math.max(0, matches - matches1v1 - matchesArena);

  /* telemetry the board itself never measures out loud: it is a model, honestly badged */
  const avgDuration = Math.round(205 + rand() * 70);
  const botBackfill = 17 + rand() * 17;
  const drawRate = 1.1 + rand() * 3.4;
  const latency = 9 + rand() * 7;
  const errRate = 0.4 + rand() * 1.8;

  return {
    players,
    dau,
    dauDelta,
    matches,
    matches1v1,
    matchesArena,
    matchesSolo,
    coins,
    stars,
    /* a live room reports its own seats; the model assumes a few per cent are on a board */
    active: live ? live.queueCount + live.activeMatchesCount * 2 : Math.max(1, Math.round(basePlayers * (0.03 + rand() * 0.02))),
    liveRooms: live ? live.activeMatchesCount : Math.max(3, Math.round(basePlayers * (0.006 + rand() * 0.006))),
    avgDuration,
    botBackfill,
    drawRate,
    latency,
    errRate,
    nations: nationsOf(rand),
    live: !!live,
  };
}

/* ---------- the live server: the Worker is the other half of this panel ---------- */

/**
 * The three knobs `MatchmakerDO` enforces itself. They are the server's copy of the local runtime:
 * the panel pushes them, the room applies them to the next pairing pass, and `/admin/status` reads
 * them back so a second admin can see what is actually in force.
 */
export interface ServerConfig {
  maintenance: boolean;
  normalRadius: number;
  wideRadius: number;
}

/** One seat in the room's queue, as `/admin/status` reports it. */
export interface QueuedPlayer {
  id: string;
  name: string;
  tiq: number;
  wide: boolean;
  waitedMs: number;
}

/** One live 1v1, as `/admin/status` reports it. */
export interface ActiveRoom {
  matchId: string;
  p0: string;
  p1: string;
  turn: number;
  round: number;
}

export interface ServerStatus {
  ok: true;
  queueCount: number;
  activeMatchesCount: number;
  queuedPlayers: QueuedPlayer[];
  activeRooms: ActiveRoom[];
  config: ServerConfig;
}

/** The room's own reading of itself, or null when nothing answers. */
async function fetchStatus(): Promise<ServerStatus | null> {
  const data = await parseJson<ServerStatus>(await adminFetch('/admin/status'));
  return data && data.ok === true ? data : null;
}

/** Push a config patch to the live server. False when it could not be delivered. */
async function pushConfig(patch: ServerConfig): Promise<boolean> {
  const res = await postJson('/admin/config', patch);
  return !!res && res.ok;
}

/** One moderation action. False when the server refused it or never answered. */
async function serverAction(
  body: { action: 'CLEAR_QUEUE' } | { action: 'ABORT_MATCH'; matchId: string },
): Promise<boolean> {
  const res = await postJson('/admin/action', body);
  return !!res && res.ok;
}

/** One page of the Worker's player directory, as `GET /admin/players` frames it. */
interface PlayersPage {
  ok: true;
  total: number;
  offset: number;
  limit: number;
  players: DirPlayer[];
}

/** Read the Worker's directory; null when nothing answers, so the panel can fall back to the index. */
async function fetchPlayers(q: string, filter: DirFilter, offset: number, limit: number): Promise<PlayersPage | null> {
  const path = `/admin/players?q=${encodeURIComponent(q)}&filter=${filter}&offset=${offset}&limit=${limit}`;
  const data = await parseJson<PlayersPage>(await adminFetch(path));
  return data && data.ok === true && Array.isArray(data.players) ? data : null;
}

/* ---------- the role registry & the broadcast engine, over `/api/admin/*` ---------- */

/** The two levels the Command Center appoints. */
export type AdminRole = 'superadmin' | 'moderator';

/** One appointed admin, as `GET /api/admin/roles` reports it. */
export interface AdminRow {
  id: string;
  name: string;
  username: string;
  role: AdminRole;
  addedAt: number;
  addedBy: string;
  /** Seeded from the server's own `ADMIN_IDS` allowlist: never revocable from here. */
  root: boolean;
}

interface RolesPage {
  ok: true;
  admins: AdminRow[];
  roles: AdminRole[];
  /** The caller's own id, so the panel can point at its own row. */
  me: string;
  /** True when this viewer may appoint and revoke. */
  super: boolean;
}

/** The Access Control List, or null when the Worker is not answering. */
async function fetchRoles(): Promise<RolesPage | null> {
  const data = await parseJson<RolesPage>(await adminFetch('/api/admin/roles'));
  return data && data.ok === true && Array.isArray(data.admins) ? data : null;
}

/** A mutation's frame: `ok` decided by the Worker, `error` its code, null when it never answered. */
interface MutationResult {
  ok: boolean;
  error?: string;
  broadcast?: Broadcast;
}

async function adminMutation(path: string, body: unknown): Promise<MutationResult | null> {
  const res = await postJson(path, body);
  if (!res) return null;
  try {
    const data = (await res.json()) as { ok?: boolean; error?: string; broadcast?: Broadcast };
    return {
      ok: data.ok === true,
      error: typeof data.error === 'string' ? data.error : undefined,
      broadcast: data.broadcast,
    };
  } catch {
    return { ok: res.ok };
  }
}

/** Appoint (or re-role) one admin. The Worker answers the guards, this side only reports them. */
const grantRole = (id: string, role: AdminRole): Promise<MutationResult | null> =>
  adminMutation('/api/admin/roles/grant', { id, role });

/** Revoke one appointed admin. Root ids and the last SuperAdmin never go. */
const revokeRole = (id: string): Promise<MutationResult | null> =>
  adminMutation('/api/admin/roles/revoke', { id });

interface HistoryPage {
  ok: true;
  broadcasts: Broadcast[];
  active: number;
}

/** The broadcast history, newest first, or null when the Worker is not answering. */
async function fetchBroadcasts(): Promise<HistoryPage | null> {
  const data = await parseJson<HistoryPage>(await adminFetch('/api/admin/broadcasts'));
  return data && data.ok === true && Array.isArray(data.broadcasts) ? data : null;
}

/** What the composer hands the Worker; the server clamps every field again. */
export interface BroadcastDraft {
  title: string;
  body: string;
  ctaLabel: string;
  ctaTarget: string;
  audienceKind: 'all' | 'country' | 'minLevel';
  audienceValue: string;
  priority: 'urgent' | 'feed';
}

/** Dispatch one announcement. A `broadcast` in the answer is the stored row, already live. */
const dispatchBroadcast = (draft: BroadcastDraft): Promise<MutationResult | null> =>
  adminMutation('/api/admin/broadcasts/create', draft);

/** Archive or restore one announcement. */
const flipBroadcast = (id: string, archived: boolean): Promise<MutationResult | null> =>
  adminMutation(`/api/admin/broadcasts/${encodeURIComponent(id)}/archive`, { archived });

/** The Worker's refusal codes, in the panel's voice. */
const ROLE_ERROR: Record<string, string> = {
  invalid_id: 'That is neither a Telegram id nor an @handle.',
  invalid_role: 'Unknown role.',
  root_admin: 'Root admins come from the server allowlist and cannot be revoked.',
  last_superadmin: 'The last SuperAdmin cannot be revoked.',
  no_such_admin: 'That admin is no longer on the registry.',
  forbidden: 'SuperAdmin access required.',
};

const BROADCAST_ERROR: Record<string, string> = {
  missing_title: 'Give the broadcast a title first.',
  missing_body: 'Give the broadcast a message first.',
  invalid_country: 'Country must be a two-letter code, like US.',
  invalid_level: 'Level must be a whole number from 1 to 999.',
  incomplete_cta: 'A button needs both a label and a target.',
  no_such_broadcast: 'That broadcast is no longer on the server.',
  forbidden: 'SuperAdmin access required.',
};

/** `SuperAdmin` / `Moderator`, the way the badges read. */
const ROLE_LABEL = (r: AdminRole): string => (r === 'superadmin' ? 'SuperAdmin' : 'Moderator');

/** `Everyone` / `Country US` / `Level 10+` — one rendering for the history and the preview both. */
function audienceText(kind: Broadcast['audience']['kind'], value: string): string {
  if (kind === 'country') return `Country ${value.toUpperCase()}`;
  if (kind === 'minLevel') return `Level ${value}+`;
  return 'Everyone';
}

/** One moderation action on the Worker's registry. The row as the server now holds it, or null. */
async function pushPlayerAction(
  id: string,
  action: 'BAN' | 'UNBAN' | 'GRANT_COINS',
  coins = 0,
): Promise<DirPlayer | null> {
  const body = action === 'GRANT_COINS' ? { id, action, coins } : { id, action };
  const res = await adminFetch('/admin/player', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res || !res.ok) return null;
  try {
    const data = (await res.json()) as { ok?: boolean; player?: DirPlayer };
    return data?.ok === true && data.player ? data.player : null;
  } catch {
    return null;
  }
}

/* ---------- the controller ---------- */

export interface AdminApi {
  /** The board's own toast (`showNote` in main.ts): the panel speaks in the game's voice. */
  note(msg: string, error: boolean, ttl: number): void;
  /** The tier the ladder currently reads — the preview swatch falls back to it. */
  tier(): MindTier;
  /** The stage opened or closed: the shell shows the Telegram BackButton while it is up. */
  onToggle(open: boolean): void;
  /** A broadcast just left the Command Center: the client engine raises it on this device at once. */
  onBroadcast?(b: Broadcast): void;
  /** A broadcast was archived: the client engine pulls it from this device's store. */
  onBroadcastArchived?(id: string): void;
  /** The Controls tab's one-liner: raise it as the Command Dispatch modal on this device. */
  onDispatch?(text: string): void;
}

export interface Admin {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  /** Show the FAB for this viewer, paint every control and anchor the key above the dock. */
  mount(): void;
  /** The route moved: re-anchor the FAB (the launcher only has a height while Home is up). */
  relayout(): void;
}

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

/** One sprite glyph as a fresh `<svg><use>`, for rows the markup cannot pre-write. */
function icon(href: string, cls: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `ico${cls ? ` ${cls}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', href);
  svg.append(use);
  return svg;
}

/** One stepper: read the live value, compute the next, write it back, label it. */
interface Knob {
  get(): number;
  next(dir: number): number;
  apply(v: number): void;
  label(v: number): string;
}

const cycle = (list: readonly number[], cur: number, dir: number): number => {
  const i = list.indexOf(cur);
  return list[((i < 0 ? 0 : i) + dir + list.length) % list.length];
};

const KNOBS: Record<string, Knob> = {
  tiq: {
    get: () => runtime.winTiq,
    next: (d) => clamp(runtime.winTiq + d * 10, 0, 1000),
    apply: (v) => setRuntime({ winTiq: v }),
    label: (v) => String(v),
  },
  coin: {
    get: () => runtime.coinMult,
    next: (d) => cycle(COIN_STEPS, runtime.coinMult, d),
    apply: (v) => setRuntime({ coinMult: v }),
    label: (v) => `${v.toFixed(1)}x`,
  },
  blitz: {
    get: () => runtime.blitz,
    next: (d) => cycle(BLITZ_STEPS, runtime.blitz, d),
    apply: (v) => setRuntime({ blitz: v }),
    label: (v) => `${v}s`,
  },
  'radius-normal': {
    get: () => runtime.radiusNormal,
    next: (d) => clamp(runtime.radiusNormal + d * 50, 50, 2000),
    apply: (v) => setRuntime({ radiusNormal: v }),
    label: (v) => `±${v}`,
  },
  'radius-wide': {
    get: () => runtime.radiusWide,
    next: (d) => clamp(runtime.radiusWide + d * 50, 100, 4000),
    apply: (v) => setRuntime({ radiusWide: v }),
    label: (v) => `±${v}`,
  },
};

const TOGGLES = ['salesOpen', 'hazards', 'maintenance'] as const;
type ToggleKey = (typeof TOGGLES)[number];

export function createAdmin(api: AdminApi): Admin {
  const fab = $<HTMLButtonElement>('btn-admin-fab');
  const dot = $<HTMLElement>('admin-fab-dot');
  const stage = $<HTMLElement>('overlay-admin');
  const home = $<HTMLElement>('s-home');
  const closeBtn = $<HTMLButtonElement>('admin-close');
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-atab]')];
  const panels = [...document.querySelectorAll<HTMLElement>('[data-apanel]')];
  const sws = [...document.querySelectorAll<HTMLButtonElement>('[data-tog]')];
  /* every lookup below is scoped to the stage: the game-mode drawer carries its own
     `data-step` ball counters, and a bare `[data-step]` would drag them in with it */
  const stepBtns = [...(stage?.querySelectorAll<HTMLButtonElement>('[data-step] [data-dir]') ?? [])];
  const stepRows = [...(stage?.querySelectorAll<HTMLElement>('[data-step]') ?? [])];
  const bcInput = $<HTMLInputElement>('bc-input');
  const bcLive = $<HTMLElement>('bc-live');
  const tierRing = $<HTMLElement>('tool-tier-ring');
  const tierLabel = $<HTMLElement>('tool-tier-label');
  const coinsNow = $<HTMLElement>('tool-coins-now');
  const tiqNow = $<HTMLElement>('tool-tiq-now');
  const resetBtn = $<HTMLButtonElement>('tool-reset');
  const serverCard = $<HTMLElement>('adm-server');
  const serverChip = $<HTMLElement>('adm-server-chip');
  const serverQueue = $<HTMLElement>('srv-queue');
  const serverRooms = $<HTMLElement>('srv-rooms');
  const serverList = $<HTMLElement>('srv-list');
  const serverRefresh = $<HTMLButtonElement>('srv-refresh');
  const serverClear = $<HTMLButtonElement>('srv-clear');
  const statPlayers = $<HTMLElement>('stat-players');
  const statMatches = $<HTMLElement>('stat-matches');
  const statCoins = $<HTMLElement>('stat-coins');
  const statActive = $<HTMLElement>('stat-active');
  const statSource = $<HTMLElement>('stat-source');
  const statNations = $<HTMLElement>('stat-nations');
  const statLiveRooms = $<HTMLElement>('stat-live-rooms');
  const statLiveDot = $<HTMLElement>('stat-live-dot');
  const statDau = $<HTMLElement>('stat-dau');
  const statModes = $<HTMLElement>('stat-modes');
  const statStars = $<HTMLElement>('stat-stars');
  const modeBar = $<HTMLElement>('stat-mode-bar');
  const modeDuelP = $<HTMLElement>('stat-mode-1v1-p');
  const modeArenaP = $<HTMLElement>('stat-mode-arena-p');
  const modeSoloP = $<HTMLElement>('stat-mode-solo-p');
  const statDur = $<HTMLElement>('stat-dur');
  const statBot = $<HTMLElement>('stat-bot');
  const statDraw = $<HTMLElement>('stat-draw');
  const statLat = $<HTMLElement>('stat-lat');
  const statErr = $<HTMLElement>('stat-err');
  const healthChip = $<HTMLElement>('stat-health-chip');
  const tfBtns = [...(stage?.querySelectorAll<HTMLButtonElement>('.adm-tf-b[data-range]') ?? [])];
  const navPill = $<HTMLElement>('admin-nav-pill');
  const inboxBadge = $<HTMLElement>('admin-inbox-badge');
  const inboxList = $<HTMLElement>('adm-inbox-list');
  const inboxEmpty = $<HTMLElement>('adm-inbox-empty');
  const inboxChips = [...document.querySelectorAll<HTMLButtonElement>('[data-ifilter]')];
  const usersList = $<HTMLElement>('adm-users-list');
  const usersEmpty = $<HTMLElement>('adm-users-empty');
  const usersTotalEl = $<HTMLElement>('users-total');
  const usersSourceEl = $<HTMLElement>('users-source');
  const usersMore = $<HTMLButtonElement>('users-more');
  const usersQ = $<HTMLInputElement>('users-q');
  const usersQClear = $<HTMLButtonElement>('users-q-clear');
  const userChips = [...document.querySelectorAll<HTMLButtonElement>('[data-ufilter]')];
  /* Access control: the list, the add key, and the appointment drawer */
  const aclList = $<HTMLElement>('adm-acl-list');
  const aclEmpty = $<HTMLElement>('adm-acl-empty');
  const aclCount = $<HTMLElement>('acl-count');
  const aclAdd = $<HTMLButtonElement>('adm-acl-add');
  const aclDrawer = $<HTMLElement>('adm-acl-drawer');
  const aclDrawerX = $<HTMLButtonElement>('adm-acl-drawer-x');
  const aclCancel = $<HTMLButtonElement>('adm-acl-cancel');
  const aclId = $<HTMLInputElement>('adm-acl-id');
  const aclHint = $<HTMLElement>('adm-acl-id-hint');
  const aclRoles = $<HTMLElement>('adm-acl-role');
  const aclRoleBtns = [...(aclRoles?.querySelectorAll<HTMLButtonElement>('[data-role]') ?? [])];
  const aclGrant = $<HTMLButtonElement>('adm-acl-grant');
  /* The broadcast engine: the compose key, the history, the composer drawer */
  const bcCompose = $<HTMLButtonElement>('adm-bc-compose');
  const bcList = $<HTMLElement>('adm-bc-list');
  const bcEmpty = $<HTMLElement>('adm-bc-empty');
  const bcCount = $<HTMLElement>('adm-bc-count');
  const bcDrawer = $<HTMLElement>('adm-bc-drawer');
  const bcDrawerX = $<HTMLButtonElement>('adm-bc-drawer-x');
  const bcCancel = $<HTMLButtonElement>('adm-bc-cancel');
  const bcSend = $<HTMLButtonElement>('adm-bc-send');
  const bcTitle = $<HTMLInputElement>('adm-bc-title');
  const bcBody = $<HTMLTextAreaElement>('adm-bc-body');
  const bcCtaLabel = $<HTMLInputElement>('adm-bc-cta-label');
  const bcCtaTarget = $<HTMLInputElement>('adm-bc-cta-target');
  const bcAudWrap = $<HTMLElement>('adm-bc-audience');
  const bcAudBtns = [...(bcAudWrap?.querySelectorAll<HTMLButtonElement>('[data-aud]') ?? [])];
  const bcAudValueWrap = $<HTMLElement>('adm-bc-aud-value-wrap');
  const bcAudValueL = $<HTMLElement>('adm-bc-aud-value-l');
  const bcAudValue = $<HTMLInputElement>('adm-bc-aud-value');
  const bcPriWrap = $<HTMLElement>('adm-bc-priority');
  const bcPriBtns = [...(bcPriWrap?.querySelectorAll<HTMLButtonElement>('[data-pri]') ?? [])];
  const bcPvKicker = $<HTMLElement>('adm-bc-pv-kicker');
  const bcPvTitle = $<HTMLElement>('adm-bc-pv-title');
  const bcPvBody = $<HTMLElement>('adm-bc-pv-body');
  const bcPvCta = $<HTMLElement>('adm-bc-pv-cta');
  const bcCtaPanel = $<HTMLElement>('adm-bc-cta-panel');
  const bcCtaToggle = $<HTMLButtonElement>('adm-bc-cta-toggle');
  const bcCtaHint = $<HTMLElement>('adm-bc-cta-hint');
  const bcCtaGrid = $<HTMLElement>('adm-bc-cta-grid');
  /* Dispatch feedback: the sticky Dark-Clay banner and the spinner that rides the send key */
  const bcToast = $<HTMLElement>('adm-bc-toast');
  const bcToastTxt = $<HTMLElement>('adm-bc-toast-txt');
  const bcToastOk = $<HTMLElement>('adm-bc-toast-ok');
  const bcToastBad = $<HTMLElement>('adm-bc-toast-bad');
  const bcToastDone = $<HTMLButtonElement>('adm-bc-toast-done');
  const bcSendIco = $<HTMLElement>('adm-bc-send-ico');
  const bcSendSpin = $<HTMLElement>('adm-bc-spin');
  const bcSendLabel = $<HTMLElement>('adm-bc-send-label');
  /* The confirm dialog, shared by every destructive key in the stage */
  const confirmEl = $<HTMLElement>('adm-confirm');
  const confirmTitle = $<HTMLElement>('adm-confirm-title');
  const confirmBody = $<HTMLElement>('adm-confirm-body');
  const confirmNo = $<HTMLButtonElement>('adm-confirm-no');
  const confirmYes = $<HTMLButtonElement>('adm-confirm-yes');

  let open = false;
  let hideId = 0;
  let resetId = 0;
  let live = false;
  /** True once `/admin/status` has answered: the panel is governing a real room. */
  let serverOn = false;
  /** The last reading of the room, so the Stats tab can paint before the next fetch lands. */
  let lastStatus: ServerStatus | null = null;
  /** What the Worker was last told, so an unchanged toggle never sends a pointless call. */
  let lastPushed: ServerConfig | null = null;
  /** The Inbox view: which filter chip is lit, and which card is expanded. */
  let inboxFilter = 'all';
  let openTicket = '';
  /** The Stats timeframe the dashboard is reading: today by default. */
  let range: StatsRange = 'today';
  /** Text typed into a reply box survives the list being rebuilt for any reason. */
  const drafts = new Map<string, string>();

  /** The Users view: the filter chip, the search text, the rows held, and the open card. */
  let usersFilter: DirFilter = 'all';
  let usersQuery = '';
  let usersRows: DirPlayer[] = [];
  let usersTotal = 0;
  let usersLimit = PAGE_SIZE;
  /** True once `/admin/players` has answered this session: the panel is governing a real registry. */
  let usersOn = false;
  /** The tab has been opened at least once — the directory is read lazily, on first sight. */
  let usersAsked = false;
  /** The newest read is the only one allowed to paint: typing fires reads faster than they land. */
  let usersSeq = 0;
  let usersTimer = 0;
  let openPlayer = '';

  /** The Access Control view: the registry read, and whether this viewer may change it. */
  let aclRows: AdminRow[] = [];
  let aclOn = false;
  let aclCan = false;
  let aclAsked = false;
  let aclRole: AdminRole = 'moderator';
  let aclTimer = 0;
  /** The broadcast history: the read, and the composer's working state. */
  let bcRows: Broadcast[] = [];
  let bcOn = false;
  let bcAsked = false;
  let bcAud: Broadcast['audience']['kind'] = 'all';
  let bcPri: 'urgent' | 'feed' = 'urgent';
  let bcBusy = false;
  /** The optional action panel: on by default, and switching it off drops the pair for good. */
  let bcCtaOn = true;
  /** The dispatch banner's auto-close timer, so a success sweeps the drawer shut by itself. */
  let bcToastId = 0;
  /** What the confirm dialog's destructive key will run, when it is up. */
  let pendingConfirm: (() => void) | null = null;
  /** One close timer per drawer, so a reopen mid-fade never strands a hidden panel. */
  const drawerTimers = new Map<HTMLElement, number>();

  /* ---------- painting ---------- */

  function paintToggles() {
    for (const el of sws) {
      const key = el.dataset.tog as ToggleKey;
      if (TOGGLES.includes(key)) el.setAttribute('aria-checked', String(runtime[key]));
    }
  }

  function paintDot() {
    if (dot) dot.dataset.state = runtime.maintenance ? 'lock' : 'live';
  }

  function paintSteps() {
    for (const row of stepRows) {
      const k = KNOBS[row.dataset.step ?? ''];
      if (!k) continue;
      const out = row.querySelector<HTMLElement>('[data-val]');
      if (out) out.textContent = k.label(k.get());
    }
  }

  function paintBroadcast() {
    const text = runtime.broadcast;
    if (bcLive) {
      bcLive.textContent = text || 'Nothing dispatched';
      bcLive.dataset.on = String(!!text);
    }
  }

  function paintTier() {
    const forced = runtime.tierOverride;
    const t = forced ?? api.tier();
    if (tierRing) tierRing.dataset.tier = t;
    if (tierLabel) tierLabel.textContent = `${TIER_LABEL[t]}${forced ? ' · forced' : ' · from TIQ'}`;
  }

  function paintSave() {
    if (coinsNow) setBalance(coinsNow, profile.coins);
    if (tiqNow) tiqNow.textContent = String(tiqFrom(profile.stats.wins, profile.stats.games, profile.tiqBonus));
  }

  function paintAll() {
    paintToggles();
    paintDot();
    paintSteps();
    paintBroadcast();
    paintTier();
    paintSave();
    paintStats();
    paintInbox();
    paintUsers();
    paintAcl();
    paintBroadcasts();
  }

  /* ---------- the Stats tab ---------- */

  /** The figure the executive grid prints: grouped, never a raw run of digits. */
  const figure = (n: number): string => Math.max(0, Math.round(n)).toLocaleString('en-US');

  /** `3m 42s` — a duration in the unit a telemetry row is read in. */
  const durOf = (s: number): string => {
    const t = Math.max(0, Math.round(s));
    return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`;
  };

  /** The flag badge is compete.ts's own renderer, so a nation looks the same here as on the ladder. */
  function paintNations(nations: NationShare[]) {
    if (!statNations) return;
    statNations.textContent = '';
    for (const n of nations) {
      const li = document.createElement('li');
      li.className = 'adm-nat';
      if (n.code) {
        li.append(flagPhoto(n.code, 'fp-stat'));
      } else {
        const globe = document.createElement('span');
        globe.className = 'adm-nat-globe';
        globe.setAttribute('aria-hidden', 'true');
        globe.textContent = '🌎';
        li.append(globe);
      }
      const track = document.createElement('span');
      track.className = 'adm-nat-track';
      const fill = document.createElement('i');
      fill.className = 'adm-nat-fill';
      fill.style.width = `${n.share}%`;
      track.append(fill);
      const pct = document.createElement('b');
      pct.className = 'adm-nat-p';
      pct.textContent = `${n.share}%`;
      li.append(track, pct);
      li.setAttribute('aria-label', n.code ? `${n.code}, ${n.share} percent` : `Rest of the world, ${n.share} percent`);
      statNations.append(li);
    }
  }

  /** The timeframe pills, the KPI grid and every tactical row below them, from one reading. */
  function paintStats() {
    const s = dayStats(range, lastStatus);
    if (statActive) statActive.textContent = figure(s.active);
    if (statLiveRooms) statLiveRooms.textContent = `${figure(s.liveRooms)} live rooms`;
    if (statLiveDot) statLiveDot.dataset.live = String(s.liveRooms > 0);
    if (statPlayers) statPlayers.textContent = figure(s.players);
    if (statDau) {
      statDau.textContent = '';
      const dauTxt = document.createElement('span');
      dauTxt.textContent = `DAU ${figure(s.dau)}`;
      const delta = document.createElement('b');
      delta.textContent = `▲ +${s.dauDelta}%`;
      statDau.append(dauTxt, delta);
    }
    if (statMatches) statMatches.textContent = figure(s.matches);
    if (statModes) statModes.textContent = `1v1 ${figure(s.matches1v1)} · Arena ${figure(s.matchesArena)}`;
    if (statCoins) statCoins.textContent = figure(s.coins);
    if (statStars) statStars.textContent = `★ ${figure(s.stars)} Stars pool`;
    if (modeBar) {
      modeBar.style.setProperty('--w-duel', `${(s.matches1v1 / Math.max(1, s.matches)) * 100}%`);
      modeBar.style.setProperty('--w-arena', `${(s.matchesArena / Math.max(1, s.matches)) * 100}%`);
      modeBar.style.setProperty('--w-solo', `${(s.matchesSolo / Math.max(1, s.matches)) * 100}%`);
    }
    if (modeDuelP) modeDuelP.textContent = `${Math.round((s.matches1v1 / Math.max(1, s.matches)) * 100)}%`;
    if (modeArenaP) modeArenaP.textContent = `${Math.round((s.matchesArena / Math.max(1, s.matches)) * 100)}%`;
    if (modeSoloP) modeSoloP.textContent = `${Math.round((s.matchesSolo / Math.max(1, s.matches)) * 100)}%`;
    if (statDur) statDur.textContent = durOf(s.avgDuration);
    if (statBot) statBot.textContent = `${s.botBackfill.toFixed(1)}%`;
    if (statDraw) statDraw.textContent = `${s.drawRate.toFixed(1)}%`;
    if (statLat) statLat.textContent = `${Math.round(s.latency)}ms p50`;
    if (statErr) statErr.textContent = `${s.errRate.toFixed(1)}%`;
    if (healthChip) {
      const ok = s.latency < 25 && s.errRate < 3.5;
      healthChip.textContent = ok ? 'Stable' : 'Degraded';
      healthChip.dataset.on = String(ok);
    }
    if (statSource) {
      statSource.textContent = s.live ? 'Live feed' : 'Modelled';
      statSource.dataset.live = String(s.live);
    }
    paintNations(s.nations);
  }

  /* ---------- the Inbox: the support desk (src/support.ts) ---------- */

  const CAT_LABEL: Record<TicketCategory, string> = {
    feedback: 'Feedback',
    bug: 'Bug Report',
    stars: 'Stars Help',
  };

  const STATUS_LABEL: Record<Ticket['status'], string> = {
    new: 'New',
    replied: 'Replied',
    resolved: 'Resolved',
  };

  /** A ticket whose sender had no username shows its id; nobody is anonymous to the admin. */
  const whoOf = (t: Ticket): string => (t.username ? `@${t.username}` : `#${t.userId}`);

  /** `Apr 3, 14:05` — the precise stamp inside the expanded card. */
  const stamp = (ms: number): string =>
    new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  /** The pill on the Inbox tab, and the count the tab announces to a screen reader. */
  function paintInboxBadge() {
    const n = unreadCount();
    if (inboxBadge) {
      inboxBadge.textContent = n > 99 ? '99+' : String(n);
      inboxBadge.hidden = n === 0;
    }
    for (const t of tabs) {
      if (t.dataset.atab !== 'inbox') continue;
      t.setAttribute('aria-label', n === 1 ? 'Inbox, 1 unread ticket' : `Inbox, ${n} unread tickets`);
    }
  }

  /** One ticket card: the summary row, and — when expanded — the profile, the reply box and the keys. */
  function ticketCard(t: Ticket): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'adm-ticket';
    li.dataset.tid = t.id;
    li.dataset.status = t.status;
    const expanded = t.id === openTicket;
    if (expanded) li.classList.add('is-open');

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'adm-ticket-main';
    main.dataset.open = t.id;
    main.setAttribute('aria-expanded', String(expanded));

    const top = document.createElement('span');
    top.className = 'adm-ticket-top';
    const cat = document.createElement('span');
    cat.className = 'adm-ticket-cat';
    cat.dataset.cat = t.category;
    cat.textContent = CAT_LABEL[t.category];
    const who = document.createElement('span');
    who.className = 'adm-ticket-who';
    who.textContent = whoOf(t);
    const when = document.createElement('span');
    when.className = 'adm-ticket-when';
    when.textContent = agoOf(t.createdAt);
    const status = document.createElement('span');
    status.className = 'adm-ticket-status';
    status.dataset.status = t.status;
    status.textContent = STATUS_LABEL[t.status];
    top.append(cat, who, when, status);

    const snip = document.createElement('span');
    snip.className = 'adm-ticket-snip';
    snip.textContent = t.message;
    main.append(top, snip);
    li.append(main);

    if (!expanded) return li;

    const detail = document.createElement('div');
    detail.className = 'adm-ticket-detail';

    const profile = document.createElement('p');
    profile.className = 'adm-ticket-profile';
    profile.textContent = `${whoOf(t)} · id ${t.userId} · ${stamp(t.createdAt)}`;
    const full = document.createElement('p');
    full.className = 'adm-ticket-full';
    full.textContent = t.message;
    detail.append(profile, full);

    if (t.reply) {
      const prev = document.createElement('p');
      prev.className = 'adm-ticket-prev';
      prev.textContent = `Your reply: ${t.reply}`;
      detail.append(prev);
    }

    const field = document.createElement('label');
    field.className = 'adm-reply-field';
    const area = document.createElement('textarea');
    area.className = 'adm-reply';
    area.rows = 3;
    area.maxLength = REPLY_MAX;
    area.placeholder = 'Type official admin reply...';
    area.setAttribute('aria-label', `Reply to the ticket from ${whoOf(t)}`);
    area.value = drafts.get(t.id) ?? '';
    area.addEventListener('input', () => drafts.set(t.id, area.value));
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendReply(t.id);
      }
    });
    field.append(area);

    const actions = document.createElement('div');
    actions.className = 'adm-ticket-actions';
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'adm-btn adm-btn-gold adm-send';
    send.dataset.send = t.id;
    send.textContent = 'Send Reply';
    const resolve = document.createElement('button');
    resolve.type = 'button';
    resolve.className = 'adm-btn adm-resolve';
    resolve.dataset.resolve = t.id;
    resolve.setAttribute('aria-pressed', String(t.status === 'resolved'));
    resolve.textContent = t.status === 'resolved' ? 'Resolved' : 'Mark as Resolved';
    actions.append(send, resolve);
    detail.append(field, actions);
    li.append(detail);
    return li;
  }

  /** The list and the badge, read off the shared queue for the current filter. */
  function paintInbox() {
    paintInboxBadge();
    if (!inboxList) return;
    const shown = tickets().filter((t) => {
      if (inboxFilter === 'all') return true;
      if (inboxFilter === 'unresolved') return t.status !== 'resolved';
      return t.category === inboxFilter;
    });
    inboxList.textContent = '';
    for (const t of shown) inboxList.append(ticketCard(t));
    if (inboxEmpty) inboxEmpty.hidden = shown.length > 0;
  }

  /** Send the admin's reply: store it, toast it, and repaint the card as Replied. */
  function sendReply(id: string): void {
    const area = inboxList?.querySelector<HTMLTextAreaElement>(`.adm-ticket[data-tid="${id}"] .adm-reply`);
    const text = (drafts.get(id) ?? area?.value ?? '').trim();
    if (!text) {
      impact('light');
      area?.focus({ preventScroll: true });
      notify('error');
      api.note('Type a reply before sending.', true, 2200);
      return;
    }
    if (!replyTicket(id, text)) return;
    drafts.delete(id);
    impact('medium');
    notify('success');
    api.note('Reply sent.', false, 1800);
    paintInbox();
  }

  /** The resolve toggle: closing a ticket, or reopening one that was closed too early. */
  function resolveTicket(id: string): void {
    const t = toggleResolved(id);
    if (!t) return;
    impact('light');
    notify(t.status === 'resolved' ? 'success' : 'warning');
    api.note(t.status === 'resolved' ? 'Ticket resolved.' : 'Ticket reopened.', false, 1800);
    paintInbox();
  }

  /* ---------- the Users tab: the player directory ---------- */

  /** The live seat, folded the way the Worker folds a connection: save first, moderation second. */
  function liveSeat(): DirPlayer {
    const u = tgUser();
    return liveRow({
      name: (u?.first_name ?? u?.username ?? 'You').slice(0, 40),
      tiq: tiqFrom(profile.stats.wins, profile.stats.games, profile.tiqBonus),
      squad: getMySquad()?.handle ?? '',
    });
  }

  /** A handle when there is one, the Telegram id behind the seat otherwise. */
  const userWho = (p: DirPlayer): string =>
    (p.username ? `@${p.username}` : p.tgId ? `#${p.tgId}` : p.id === YOU_ID ? 'this device' : p.id);

  /** One small status sticker on a row: live, banned, or muted. */
  function userSticker(text: string, kind: 'live' | 'ban' | 'mute'): HTMLElement {
    const s = document.createElement('span');
    s.className = 'adm-user-st';
    s.dataset.st = kind;
    s.textContent = text;
    return s;
  }

  /** One telemetry cell inside the expanded card. */
  function userStat(v: string, l: string): HTMLElement {
    const s = document.createElement('span');
    s.className = 'adm-stat';
    const b = document.createElement('b');
    b.textContent = v;
    const t = document.createElement('span');
    t.className = 'adm-stat-l';
    t.textContent = l;
    s.append(b, t);
    return s;
  }

  /**
   * One directory row: the summary line always, the telemetry and moderation keys when the card
   * is the open one. The structure mirrors the Inbox card — one delegated listener, no per-row
   * handlers outliving a repaint.
   */
  function playerCard(p: DirPlayer): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'adm-user';
    li.dataset.uid = p.id;
    if (p.id === YOU_ID) li.classList.add('is-you');
    if (p.banned) li.classList.add('is-banned');
    if (p.inMatch) li.classList.add('is-live');
    const expanded = p.id === openPlayer;
    if (expanded) li.classList.add('is-open');

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'adm-user-main';
    main.dataset.uopen = p.id;
    main.setAttribute('aria-expanded', String(expanded));

    const av = document.createElement('span');
    av.className = 'adm-user-av';
    av.setAttribute('aria-hidden', 'true');
    av.textContent = (p.name.charAt(0) || '?').toUpperCase();

    const txt = document.createElement('span');
    txt.className = 'adm-user-txt';
    const nm = document.createElement('span');
    nm.className = 'adm-user-n';
    nm.textContent = p.name;
    if (p.id === YOU_ID) {
      const you = document.createElement('b');
      you.className = 'adm-user-you';
      you.textContent = 'YOU';
      nm.append(' ', you);
    }
    const sub = document.createElement('span');
    sub.className = 'adm-user-m';
    sub.textContent = `${userWho(p)} · TIQ ${figure(p.tiq)}`;
    txt.append(nm, sub);

    const side = document.createElement('span');
    side.className = 'adm-user-side';
    if (p.inMatch) side.append(userSticker('LIVE', 'live'));
    if (p.banned) side.append(userSticker('BANNED', 'ban'));
    else if (p.muted) side.append(userSticker('MUTED', 'mute'));
    side.append(icon('#i-next', 'adm-user-go'));

    main.append(av, txt, side);
    li.append(main);

    if (!expanded) return li;

    const detail = document.createElement('div');
    detail.className = 'adm-user-detail';

    const meta = document.createElement('p');
    meta.className = 'adm-user-id';
    meta.textContent = `id ${p.tgId || p.id} · first seen ${agoOf(p.firstSeen)} · last seen ${agoOf(p.lastSeen)}`;
    detail.append(meta);

    const grid = document.createElement('div');
    grid.className = 'adm-cells adm-user-cells';
    grid.append(
      userStat(figure(p.matches), 'Matches'),
      userStat(p.matches ? `${Math.round((p.wins / p.matches) * 100)}%` : '—', `Win Rate · ${p.wins}W ${p.losses}L`),
      userStat(String(p.streak), `Streak · best ${p.best}`),
      userStat(p.lastPlayed ? agoOf(p.lastPlayed) : 'never', 'Last Played'),
    );
    detail.append(grid);

    const wallet = document.createElement('div');
    wallet.className = 'adm-cells adm-user-cells';
    const coinsCell = document.createElement('span');
    coinsCell.className = 'adm-stat adm-user-wallet';
    const coinsB = document.createElement('b');
    coinsB.textContent = coinText(p.coins);
    const coinsL = document.createElement('span');
    coinsL.className = 'adm-stat-l';
    coinsL.textContent = 'Coins';
    coinsCell.append(coinsB, coinsL);
    wallet.append(
      coinsCell,
      userStat(`★ ${figure(p.stars)}`, 'Stars Won'),
      userStat(String(p.referrals), 'Invited Friends'),
      userStat(p.squad || '—', 'Squad'),
    );
    detail.append(wallet);

    const actions = document.createElement('div');
    actions.className = 'adm-user-actions';
    const ban = document.createElement('button');
    ban.type = 'button';
    ban.className = p.banned ? 'adm-btn adm-btn-danger adm-uban' : 'adm-btn adm-uban';
    ban.dataset.uban = p.id;
    ban.setAttribute('aria-pressed', String(p.banned));
    ban.textContent = p.banned ? 'Unban Player' : 'Ban Player';
    const grant = (n: number): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'adm-btn adm-ugrant';
      b.dataset.ugrant = String(n);
      b.dataset.uid = p.id;
      b.setAttribute('aria-label', `Grant ${n} coins to ${p.name}`);
      const c = document.createElement('span');
      c.className = 'coin';
      c.dataset.coin = '';
      b.append('+', String(n), ' ', c);
      return b;
    };
    actions.append(ban, grant(100), grant(500));
    detail.append(actions);
    li.append(detail);
    mountCoins(detail);
    return li;
  }

  /** The list, the count, the source chip and the Load More key, from the rows currently held. */
  function paintUsers() {
    if (usersSourceEl) {
      usersSourceEl.textContent = usersOn ? 'LIVE REGISTRY' : 'LOCAL INDEX';
      usersSourceEl.dataset.live = String(usersOn);
    }
    if (usersTotalEl) {
      usersTotalEl.textContent = usersRows.length
        ? `${figure(usersTotal)} ${usersTotal === 1 ? 'player' : 'players'}`
        : '—';
    }
    if (usersMore) usersMore.hidden = usersRows.length >= usersTotal;
    if (!usersList) return;
    usersList.textContent = '';
    for (const p of usersRows) usersList.append(playerCard(p));
    if (usersEmpty) usersEmpty.hidden = usersRows.length > 0;
  }

  /**
   * Read one window of the directory. The Worker's registry is asked first and wins when it
   * answers; with nothing behind the page the local index (players.ts) answers instead, so the
   * tab is never empty for want of a server. Only the newest read paints.
   */
  async function refreshUsers(reset: boolean): Promise<void> {
    const run = ++usersSeq;
    if (reset) usersLimit = PAGE_SIZE;
    const offset = reset ? 0 : usersRows.length;
    const live = await fetchPlayers(usersQuery, usersFilter, offset, usersLimit);
    if (run !== usersSeq) return;                 // a newer read has already been asked for
    usersOn = !!live;
    if (live) {
      usersRows = reset ? live.players : [...usersRows, ...live.players];
      usersTotal = live.total;
    } else {
      const page = directoryPage(
        { q: usersQuery, filter: usersFilter, offset: 0, limit: usersLimit },
        liveSeat(),
      );
      usersRows = page.players;
      usersTotal = page.total;
    }
    paintUsers();
  }

  /** BAN / UNBAN / GRANT_COINS, on the Worker when there is one, on the local index otherwise. */
  async function actOnPlayer(id: string, action: 'BAN' | 'UNBAN' | 'GRANT_COINS', coins = 0): Promise<void> {
    impact('medium');
    const row = usersRows.find((p) => p.id === id) ?? null;
    const name = row?.name ?? 'Player';
    const server = usersOn ? await pushPlayerAction(id, action, coins) : null;
    if (usersOn && !server) {
      /* the registry was there a moment ago and is not now: say so rather than pretend */
      usersOn = false;
      api.note('The Worker is not answering — moderation stayed local.', true, 2600);
      notify('error');
    }
    if (!server) {
      if (!directoryAction(id, action, coins)) return;
    }
    if (action === 'BAN') {
      notify('warning');
      api.note(`${name} banned from matchmaking.`, false, 2200);
    } else if (action === 'UNBAN') {
      notify('success');
      api.note(`${name} unbanned.`, false, 2000);
    } else {
      notify('success');
      api.note(`Granted ${coinText(coins)} coins to ${name}.`, false, 2200);
    }
    await refreshUsers(true);
    /* the live seat's wallet is the save's: a grant to `you` lands there, not in a registry copy */
    if (id === YOU_ID && action === 'GRANT_COINS') {
      earnCoins(coins);
      paintSave();
    }
  }

  /* ---------- Access control: the role registry (worker/matchmaker.ts) ---------- */

  function paintAcl() {
    if (aclCount) {
      aclCount.textContent = aclOn ? `${aclRows.length} admin${aclRows.length === 1 ? '' : 's'}` : '—';
      aclCount.dataset.on = String(aclOn);
    }
    if (!aclList) return;
    aclList.textContent = '';
    for (const a of aclRows) {
      const li = document.createElement('li');
      li.className = a.root ? 'adm-admin is-root' : 'adm-admin';
      li.dataset.aid = a.id;

      const av = document.createElement('span');
      av.className = 'adm-admin-av';
      av.setAttribute('aria-hidden', 'true');
      av.textContent = (a.name.charAt(0) || '?').toUpperCase();

      const txt = document.createElement('span');
      txt.className = 'adm-admin-txt';
      const nm = document.createElement('span');
      nm.className = 'adm-admin-name';
      nm.textContent = a.name || `Admin ${a.id.slice(0, 6)}`;
      const sub = document.createElement('span');
      sub.className = 'adm-admin-sub';
      sub.textContent = `${a.username ? `@${a.username} · ` : ''}#${a.id} · added ${stamp(a.addedAt)}`;
      txt.append(nm, sub);

      const role = document.createElement('span');
      role.className = 'adm-admin-role';
      role.dataset.role = a.root ? 'root' : a.role;
      role.textContent = a.root ? 'Owner' : a.role === 'superadmin' ? 'Super' : 'Mod';

      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'adm-admin-x';
      x.dataset.revoke = a.id;
      x.setAttribute('aria-label', `Revoke ${a.name || a.id}`);
      x.append(icon('#i-trash', ''));
      const locked = a.root || !aclCan;
      x.disabled = locked;
      if (a.root) x.title = 'Root admin — comes from the server allowlist';

      li.append(av, txt, role, x);
      aclList.append(li);
    }
    if (aclEmpty) aclEmpty.hidden = aclRows.length > 0;
    if (aclGrant) aclGrant.setAttribute('aria-disabled', String(!aclCan || !aclIdValid()));
  }

  /** True when the typed id is one of the two shapes the Worker accepts. */
  const aclIdValid = (): boolean => {
    const v = (aclId?.value ?? '').trim();
    return /^[0-9]{3,20}$/.test(v) || /^@[A-Za-z0-9_]{3,32}$/.test(v);
  };

  /** The hint under the id field: quiet while typing, then one verdict. */
  function paintAclHint() {
    if (!aclHint) return;
    const v = (aclId?.value ?? '').trim();
    if (!v) {
      aclHint.dataset.state = 'idle';
      aclHint.textContent = 'A numeric Telegram id, or an @handle to appoint by name.';
    } else if (aclIdValid()) {
      aclHint.dataset.state = 'ok';
      aclHint.textContent = /^@/.test(v) ? `Appointing the handle ${v.toLowerCase()}.` : `Appointing Telegram id ${v}.`;
    } else {
      aclHint.dataset.state = 'bad';
      aclHint.textContent = 'That is neither a Telegram id nor an @handle.';
    }
    if (aclGrant) aclGrant.setAttribute('aria-disabled', String(!aclCan || !aclIdValid()));
  }

  /** Read the registry; the rail keeps its last paint when nothing answers. */
  async function refreshAcl(): Promise<void> {
    const page = await fetchRoles();
    aclOn = !!page;
    aclRows = page?.admins ?? [];
    aclCan = page?.super ?? false;
    paintAcl();
  }

  /** Appoint the typed id with the picked role. */
  async function grantAdmin(): Promise<void> {
    const id = (aclId?.value ?? '').trim();
    if (!aclIdValid()) {
      impact('light');
      notify('error');
      aclId?.focus({ preventScroll: true });
      api.note('Type a Telegram id or an @handle first.', true, 2200);
      return;
    }
    if (!aclOn) {
      impact('light');
      notify('error');
      api.note('The server owns the role registry — no Worker answering.', true, 2400);
      return;
    }
    if (!aclCan) {
      impact('light');
      notify('error');
      api.note('SuperAdmin access required.', true, 2200);
      return;
    }
    impact('medium');
    const res = await grantRole(id, aclRole);
    if (!res) {
      markAclLocal();
      notify('error');
      api.note('No answer — the registry did not change.', true, 2400);
      return;
    }
    if (!res.ok) {
      notify('error');
      api.note(ROLE_ERROR[res.error ?? ''] ?? 'The Worker refused that appointment.', true, 2600);
      return;
    }
    notify('success');
    api.note(`${id} is now ${ROLE_LABEL(aclRole)}.`, false, 2200);
    hideDrawer(aclDrawer);
    if (aclId) aclId.value = '';
    paintAclHint();
    await refreshAcl();
  }

  /** Ask, then revoke. The confirm dialog carries the name so a mis-tap changes nothing. */
  function askRevoke(id: string): void {
    const a = aclRows.find((r) => r.id === id);
    if (!a) return;
    impact('light');
    openConfirm(
      'Revoke admin?',
      `${a.name || a.id} (#${a.id}) stops being ${ROLE_LABEL(a.role)} immediately. Their own device stays signed in until the next check.`,
      'Revoke',
      () => void doRevoke(a),
    );
  }

  async function doRevoke(a: AdminRow): Promise<void> {
    if (!aclOn || !aclCan) {
      notify('error');
      api.note('SuperAdmin access required.', true, 2200);
      return;
    }
    detonation();                      // the danger buzz: a revocation is not a toggle
    const res = await revokeRole(a.id);
    if (!res) {
      markAclLocal();
      notify('error');
      api.note('No answer — nothing was revoked.', true, 2400);
      return;
    }
    if (!res.ok) {
      notify('error');
      api.note(ROLE_ERROR[res.error ?? ''] ?? 'The Worker refused that revocation.', true, 2600);
      return;
    }
    notify('success');
    api.note(`${a.name || a.id} revoked.`, false, 2200);
    await refreshAcl();
  }

  /** Nothing answered: the Access Control list steps back to its local note. */
  function markAclLocal() {
    aclOn = false;
    aclCan = false;
    aclRows = [];
    paintAcl();
  }

  /* ---------- the broadcast engine: composer, history, archive ---------- */

  /** `Urgent` / `Feed`, and the audience, as one kicker line. */
  const bcKicker = (): string =>
    `${bcPri === 'urgent' ? 'Urgent' : 'Feed'} · ${audienceText(bcAud, (bcAudValue?.value ?? '').trim())}`;

  /** The dispatch banner: an emerald check on the way out, a crimson shield on the way back. */
  function showBcToast(state: 'ok' | 'bad', msg: string, done: boolean) {
    if (bcToastId) {
      window.clearTimeout(bcToastId);
      bcToastId = 0;
    }
    if (!bcToast) return;
    bcToast.dataset.state = state;
    if (bcToastTxt) bcToastTxt.textContent = msg;
    if (bcToastOk) bcToastOk.hidden = state !== 'ok';
    if (bcToastBad) bcToastBad.hidden = state !== 'bad';
    if (bcToastDone) bcToastDone.hidden = !done;
    bcToast.hidden = false;                  /* display:none -> flex also restarts the pop-in */
  }

  /** The banner leaves, and any auto-close it had queued with it. */
  function hideBcToast() {
    if (bcToastId) {
      window.clearTimeout(bcToastId);
      bcToastId = 0;
    }
    if (bcToast) bcToast.hidden = true;
  }

  /** The Dispatch key while the Worker is being asked: spinner in, label forward, taps swallowed. */
  function setBcBusy(busy: boolean) {
    bcBusy = busy;
    if (bcSend) {
      bcSend.dataset.busy = String(busy);
      bcSend.setAttribute('aria-disabled', 'true');   /* paintBcPreview() recomputes it after the wait */
    }
    if (bcSendIco) bcSendIco.hidden = busy;
    if (bcSendSpin) bcSendSpin.hidden = !busy;
    if (bcSendLabel) bcSendLabel.textContent = busy ? 'Dispatching...' : 'Dispatch';
  }

  /** The optional action button: off clears the pair, so a half-written CTA never ships. */
  function setCtaOn(on: boolean) {
    bcCtaOn = on;
    if (bcCtaPanel) bcCtaPanel.dataset.on = String(on);
    if (bcCtaToggle) bcCtaToggle.setAttribute('aria-checked', String(on));
    if (bcCtaGrid) bcCtaGrid.hidden = !on;
    if (bcCtaHint) {
      bcCtaHint.textContent = on
        ? 'Optional — leave both blanks and the player only gets a plain Dismiss key.'
        : 'Off — no action button; the player gets a plain Dismiss key.';
    }
    if (!on) {
      if (bcCtaLabel) bcCtaLabel.value = '';
      if (bcCtaTarget) bcCtaTarget.value = '';
    }
    paintBcPreview();
  }

  function paintBcPreview() {
    const title = (bcTitle?.value ?? '').trim();
    const body = (bcBody?.value ?? '').trim();
    const label = (bcCtaLabel?.value ?? '').trim();
    const target = (bcCtaTarget?.value ?? '').trim();
    if (bcPvKicker) bcPvKicker.textContent = bcKicker();
    if (bcPvTitle) bcPvTitle.textContent = title || 'Your title here';
    if (bcPvBody) bcPvBody.textContent = body || 'Your message here.';
    if (bcPvCta) {
      const has = !!label && !!target;
      bcPvCta.hidden = !has;
      bcPvCta.textContent = has ? label : '';
    }
    if (bcSend) bcSend.setAttribute('aria-disabled', String(bcBusy || !bcDraftValid()));
  }

  /** The composer's shape check, mirroring the Worker's own guards. */
  function bcDraftValid(): boolean {
    const title = (bcTitle?.value ?? '').trim();
    const body = (bcBody?.value ?? '').trim();
    const label = (bcCtaLabel?.value ?? '').trim();
    const target = (bcCtaTarget?.value ?? '').trim();
    if (!title || !body) return false;
    if (!!label !== !!target) return false;
    const value = (bcAudValue?.value ?? '').trim();
    if (bcAud === 'country' && !/^[A-Za-z]{2}$/.test(value)) return false;
    if (bcAud === 'minLevel') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 999) return false;
    }
    return true;
  }

  function paintBroadcasts() {
    const active = bcRows.filter((b) => b.status === 'active').length;
    if (bcCount) {
      bcCount.textContent = bcOn ? `${active} live / ${bcRows.length}` : '—';
      bcCount.dataset.on = String(active > 0);
    }
    if (!bcList) return;
    bcList.textContent = '';
    for (const b of bcRows) {
      const li = document.createElement('li');
      li.className = b.status === 'archived' ? 'adm-bc-card is-archived' : 'adm-bc-card';
      li.dataset.bcid = b.id;

      const top = document.createElement('div');
      top.className = 'adm-bc-top';
      const pri = document.createElement('span');
      pri.className = 'adm-bc-chip';
      pri.dataset.pri = b.priority;
      pri.textContent = b.priority === 'urgent' ? 'Urgent' : 'Feed';
      const aud = document.createElement('span');
      aud.className = 'adm-bc-chip';
      aud.textContent = audienceText(b.audience.kind, b.audience.value);
      if (b.status === 'archived') {
        const state = document.createElement('span');
        state.className = 'adm-bc-chip';
        state.dataset.state = 'archived';
        state.textContent = 'Archived';
        top.append(pri, aud, state);
      } else {
        top.append(pri, aud);
      }
      const title = document.createElement('span');
      title.className = 'adm-bc-title';
      title.textContent = b.title;
      top.append(title);
      li.append(top);

      const snip = document.createElement('span');
      snip.className = 'adm-bc-snip';
      snip.textContent = b.body;
      li.append(snip);

      const meta = document.createElement('p');
      meta.className = 'adm-bc-meta';
      meta.textContent = `${stamp(b.createdAt)} · by ${b.createdBy}${b.archivedAt ? ` · archived ${stamp(b.archivedAt)}` : ''}`;
      li.append(meta);

      const actions = document.createElement('div');
      actions.className = 'adm-bc-actions';
      const flip = document.createElement('button');
      flip.type = 'button';
      flip.className = b.status === 'archived' ? 'adm-btn is-restore' : 'adm-btn';
      flip.dataset.bcflip = b.id;
      flip.textContent = b.status === 'archived' ? 'Reactivate' : 'Archive';
      actions.append(flip);
      li.append(actions);
      bcList.append(li);
    }
    if (bcEmpty) bcEmpty.hidden = bcRows.length > 0;
  }

  /** Read the history; the rail keeps its last paint when nothing answers. */
  async function refreshBroadcasts(): Promise<void> {
    const page = await fetchBroadcasts();
    bcOn = !!page;
    bcRows = page?.broadcasts ?? [];
    paintBroadcasts();
  }

  /** Clear the composer back to its defaults, ready for the next dispatch. */
  function resetComposer() {
    if (bcTitle) bcTitle.value = '';
    if (bcBody) bcBody.value = '';
    if (bcCtaLabel) bcCtaLabel.value = '';
    if (bcCtaTarget) bcCtaTarget.value = '';
    if (bcAudValue) bcAudValue.value = '';
    if (bcAudValueWrap) bcAudValueWrap.hidden = true;
    if (bcAudValueL) bcAudValueL.textContent = 'Value';
    if (bcAudValue) bcAudValue.placeholder = '';
    bcAud = 'all';
    for (const b of bcAudBtns) b.setAttribute('aria-pressed', String(b.dataset.aud === 'all'));
    bcPri = 'urgent';
    for (const b of bcPriBtns) b.setAttribute('aria-pressed', String(b.dataset.pri === 'urgent'));
    setCtaOn(true);
    paintBcPreview();
  }

  /** Dispatch the composer's draft; on success, the client engine raises it right here too. */
  async function sendBroadcast(): Promise<void> {
    if (bcBusy || !bcDraftValid()) {
      impact('light');
      notify('error');
      showBcToast('bad', 'Failed to send: title and message are required — a button needs both halves.', false);
      return;
    }
    if (!bcOn) {
      impact('light');
      notify('error');
      showBcToast('bad', 'Failed to send: no Worker answering — the broadcast did not leave this device.', false);
      return;
    }
    hideBcToast();
    setBcBusy(true);
    const draft: BroadcastDraft = {
      title: (bcTitle?.value ?? '').trim(),
      body: (bcBody?.value ?? '').trim(),
      ctaLabel: (bcCtaLabel?.value ?? '').trim(),
      ctaTarget: (bcCtaTarget?.value ?? '').trim(),
      audienceKind: bcAud,
      audienceValue: (bcAudValue?.value ?? '').trim(),
      priority: bcPri,
    };
    const res = await dispatchBroadcast(draft);
    setBcBusy(false);
    if (!res) {
      markBcLocal();
      notify('error');
      showBcToast('bad', 'Failed to send: no answer — nothing was dispatched. Retry when you like.', false);
      paintBcPreview();
      return;
    }
    if (!res.ok) {
      notify('error');
      showBcToast('bad', `Failed to send: ${BROADCAST_ERROR[res.error ?? ''] ?? 'the Worker refused that broadcast.'}`, false);
      paintBcPreview();
      return;                            /* the draft is untouched, so a retry costs one tap */
    }
    impact('medium');
    notify('success');
    showBcToast('ok', 'Broadcast Dispatched Successfully! Delivered to online players.', true);
    resetComposer();
    await refreshBroadcasts();
    if (res.broadcast) api.onBroadcast?.(res.broadcast);
    bcToastId = window.setTimeout(() => {
      hideBcToast();
      hideDrawer(bcDrawer);
    }, 1200);                            /* the banner reads, then the composer sweeps itself away */
  }

  /** Archive or restore one announcement, and tell the client engine which way it went. */
  async function flipOne(id: string): Promise<void> {
    const b = bcRows.find((r) => r.id === id);
    if (!b) return;
    if (!bcOn) {
      notify('error');
      api.note('No Worker answering.', true, 2200);
      return;
    }
    impact('light');
    const archived = b.status !== 'archived';
    const res = await flipBroadcast(id, archived);
    if (!res) {
      markBcLocal();
      notify('error');
      api.note('No answer — the broadcast did not move.', true, 2400);
      return;
    }
    if (!res.ok) {
      notify('error');
      api.note(BROADCAST_ERROR[res.error ?? ''] ?? 'The Worker refused that change.', true, 2600);
      return;
    }
    notify('success');
    api.note(archived ? 'Broadcast archived.' : 'Broadcast is live again.', false, 2000);
    await refreshBroadcasts();
    if (res.broadcast) {
      if (res.broadcast.status === 'archived') api.onBroadcastArchived?.(id);
      else api.onBroadcast?.(res.broadcast);
    }
  }

  /** Nothing answered: the history steps back and says so. */
  function markBcLocal() {
    bcOn = false;
    bcRows = [];
    paintBroadcasts();
  }

  /* ---------- the overlays: drawers and the confirm dialog ---------- */

  function showDrawer(el: HTMLElement | null) {
    if (!el) return;
    const pending = drawerTimers.get(el);
    if (pending) {
      window.clearTimeout(pending);
      drawerTimers.delete(el);
    }
    el.hidden = false;
    void el.offsetWidth;
    el.classList.add('open');
  }

  function hideDrawer(el: HTMLElement | null) {
    if (!el || el.hidden) return;
    el.classList.remove('open');
    const done = () => {
      el.hidden = true;
      drawerTimers.delete(el);
    };
    if (motionReduced()) {
      done();
      return;
    }
    const id = window.setTimeout(done, 260);
    drawerTimers.set(el, id);
  }

  /** One question, one destructive key. `run` fires after the dialog is out of the way. */
  function openConfirm(title: string, body: string, yes: string, run: () => void) {
    pendingConfirm = run;
    if (confirmTitle) confirmTitle.textContent = title;
    if (confirmBody) confirmBody.textContent = body;
    if (confirmYes) confirmYes.textContent = yes;
    showDrawer(confirmEl);
    confirmYes?.focus({ preventScroll: true });
  }

  function closeConfirm() {
    pendingConfirm = null;
    hideDrawer(confirmEl);
  }

  /* ---------- the live server ---------- */

  /** The local runtime, in the three fields the Worker also enforces. */
  function serverConfig(): ServerConfig {
    return { maintenance: runtime.maintenance, normalRadius: runtime.radiusNormal, wideRadius: runtime.radiusWide };
  }

  const sameConfig = (a: ServerConfig | null, b: ServerConfig): boolean =>
    !!a && a.maintenance === b.maintenance && a.normalRadius === b.normalRadius && a.wideRadius === b.wideRadius;

  /** Nothing answered: the panel governs this device alone, and says so. */
  function markLocal() {
    serverOn = false;
    lastStatus = null;
    paintServer(null);
    paintStats();
  }

  /** `12s` / `1m 20s`: a wait in the unit somebody would actually say it in. */
  function waited(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function rosterRow(name: string, meta: string, matchId?: string): HTMLLIElement {
    const li = document.createElement('li');
    li.className = matchId ? 'adm-server-row is-room' : 'adm-server-row';
    const txt = document.createElement('span');
    txt.className = 'adm-server-txt';
    const n = document.createElement('span');
    n.className = 'adm-server-n';
    n.textContent = name;
    const m = document.createElement('span');
    m.className = 'adm-server-m';
    m.textContent = meta;
    txt.append(n, m);
    li.append(txt);
    if (matchId) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'adm-btn adm-btn-danger adm-abort';
      btn.dataset.abort = matchId;
      btn.textContent = 'Abort';
      btn.setAttribute('aria-label', `Abort room ${matchId}`);
      li.append(btn);
    }
    return li;
  }

  function emptyRow(text: string): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'adm-server-empty';
    li.textContent = text;
    return li;
  }

  /** The chip, the two counters and the roster, all from one status payload (or its absence). */
  function paintServer(status: ServerStatus | null) {
    if (serverCard) serverCard.dataset.state = status ? 'live' : 'local';
    if (serverChip) serverChip.textContent = status ? 'LIVE SERVER' : 'LOCAL MODE';
    if (serverQueue) serverQueue.textContent = status ? String(status.queueCount) : '—';
    if (serverRooms) serverRooms.textContent = status ? String(status.activeMatchesCount) : '—';
    if (!serverList) return;
    serverList.textContent = '';
    if (!status) {
      serverList.append(emptyRow('No telemetry — the Worker is not answering.'));
      return;
    }
    if (!status.queuedPlayers.length && !status.activeRooms.length) {
      serverList.append(emptyRow('Nobody is waiting, and no room is running.'));
      return;
    }
    for (const p of status.queuedPlayers) {
      serverList.append(rosterRow(p.name, `TIQ ${p.tiq} · ${p.wide ? 'wide' : 'normal'} · ${waited(p.waitedMs)}`));
    }
    for (const r of status.activeRooms) {
      serverList.append(rosterRow(
        `${r.p0} vs ${r.p1}`,
        `#${r.matchId} · turn ${r.turn} · round ${r.round}`,
        r.matchId,
      ));
    }
  }

  /** Read the room, paint it, and remember whether the Worker is really there. */
  async function refreshServer(): Promise<void> {
    const status = await fetchStatus();
    serverOn = !!status;
    lastStatus = status;
    paintServer(status);
    paintStats();
    if (serverOn) await syncConfig();
  }

  /**
   * Keep the Worker's own enforcement in step with the local runtime. Only the three fields the
   * server also owns travel; anything else the panel changes is a device-local matter. With no
   * Worker answering there is nothing to sync, and the panel simply stays in Local mode.
   */
  async function syncConfig(): Promise<void> {
    if (!serverOn) return;
    const want = serverConfig();
    if (sameConfig(lastPushed, want)) return;
    if (await pushConfig(want)) lastPushed = want;
    else markLocal();
  }

  /** Empty the room's queue on the server, then read it back so the roster agrees. */
  async function clearQueue(): Promise<void> {
    impact('medium');
    if (!(await serverAction({ action: 'CLEAR_QUEUE' }))) {
      markLocal();
      notify('error');
      api.note('Clear Queue failed — the Worker is not answering.', true, 2400);
      return;
    }
    notify('success');
    api.note('Queue cleared on the server.', false, 2000);
    await refreshServer();
  }

  /** Pull one stuck room: both seats are told, and the room stops existing. */
  async function abortMatch(matchId: string): Promise<void> {
    if (!matchId) return;
    impact('medium');
    if (!(await serverAction({ action: 'ABORT_MATCH', matchId }))) {
      markLocal();
      notify('error');
      api.note('Abort failed — the Worker is not answering.', true, 2400);
      return;
    }
    notify('success');
    api.note(`Room ${matchId} aborted.`, false, 2000);
    await refreshServer();
  }

  /* ---------- the FAB ---------- */

  /**
   * The registry is the door of record for appointed admins: a device the local allowlist does
   * not know asks the server once, and only a membership answer opens the Command Center. The
   * dev door and the local allowlist never wait on it, and no answer at all changes nothing.
   */
  async function probeDoor(): Promise<void> {
    if (isAdmin()) return;
    const page = await fetchRoles();
    if (!page) return;
    elevated = true;
    if (fab) fab.hidden = false;
  }

  /** Clear the launcher (mode card + PLAY) so the key never sits on top of either. */
  function placeFab() {
    if (!fab || !home) return;
    const launcher = home.querySelector<HTMLElement>('.launcher');
    if (!launcher) return;
    const hr = home.getBoundingClientRect();
    const lr = launcher.getBoundingClientRect();
    if (!hr.height || !lr.height) return;
    fab.style.bottom = `${Math.max(12, Math.round(hr.bottom - lr.top + 12))}px`;
  }

  /* ---------- open / close ---------- */

  function openStage() {
    if (!stage || open) return;
    open = true;
    window.clearTimeout(hideId);
    stage.hidden = false;
    void stage.offsetWidth;               // lay the stage out at its closed position first
    stage.classList.add('open');
    document.documentElement.classList.add('admin-open');
    paintAll();
    void refreshServer();                 // the Server KPI is read off `/admin/status`, not `/health`
    closeBtn?.focus({ preventScroll: true });
    api.onToggle(true);
    impact('medium');
  }

  function closeStage() {
    if (!stage || !open) return;
    open = false;
    stage.classList.remove('open');
    document.documentElement.classList.remove('admin-open');
    impact('light');
    api.onToggle(false);
    hideId = window.setTimeout(() => {
      if (!open) stage.hidden = true;
    }, motionReduced() ? 0 : 240);
    try {
      fab?.focus({ preventScroll: true });
    } catch {
      /* gone already */
    }
  }

  function selectTab(id: string) {
    let at = 0;
    for (const t of tabs) {
      const mine = t.dataset.atab === id;
      t.setAttribute('aria-selected', String(mine));
      if (mine) at = tabs.indexOf(t);
    }
    for (const p of panels) p.hidden = p.dataset.apanel !== id;
    /* the springy gold pill rides under the active tab; its own width is one step */
    if (navPill) navPill.style.transform = `translateX(${at * 100}%)`;
  }

  /* ---------- wiring ---------- */

  fab?.addEventListener('click', openStage);
  closeBtn?.addEventListener('click', closeStage);
  stage?.addEventListener('click', (e) => {
    // the backdrop below the stage's own column closes it, like every other full-viewport stage
    if (e.target === stage) closeStage();
  });
  for (const t of tabs) {
    t.addEventListener('click', () => {
      impact('light');
      const id = t.dataset.atab ?? 'stats';
      selectTab(id);
      /* both of these read the room: the roster and the live seat count are only ever as fresh
         as their last read, so landing on either one asks the Worker again */
      if (id === 'server' || id === 'stats') void refreshServer();
      /* the Inbox is device-local: a repaint keeps the relative timestamps honest, and the
         broadcast history is read on first sight like the directory */
      if (id === 'inbox') {
        paintInbox();
        if (!bcAsked) {
          bcAsked = true;
          void refreshBroadcasts();
        } else {
          paintBroadcasts();
        }
      }
      /* the directory is read on first sight, not at mount: a panel nobody opened never calls out */
      if (id === 'users') {
        if (!usersAsked) {
          usersAsked = true;
          void refreshUsers(true);
        } else {
          paintUsers();
        }
      }
      /* the role registry rides the same rule: first sight of Controls reads it */
      if (id === 'controls' && !aclAsked) {
        aclAsked = true;
        void refreshAcl();
      }
    });
  }

  for (const chip of inboxChips) {
    chip.addEventListener('click', () => {
      const next = chip.dataset.ifilter ?? 'all';
      if (next === inboxFilter) return;
      inboxFilter = next;
      for (const c of inboxChips) c.setAttribute('aria-pressed', String(c === chip));
      impact('light');
      paintInbox();
    });
  }

  /* the Users tab: the filter chips, the search field, the cards and Load More */
  for (const chip of userChips) {
    chip.addEventListener('click', () => {
      const next = (chip.dataset.ufilter ?? 'all') as DirFilter;
      if (next === usersFilter) return;
      usersFilter = next;
      openPlayer = '';
      for (const c of userChips) c.setAttribute('aria-pressed', String(c === chip));
      impact('light');
      void refreshUsers(true);
    });
  }

  /* typing is debounced once: a query read per keystroke would race the rows that are landing */
  usersQ?.addEventListener('input', () => {
    usersQuery = usersQ.value.trim().slice(0, 64);
    if (usersQClear) usersQClear.hidden = !usersQuery;
    window.clearTimeout(usersTimer);
    usersTimer = window.setTimeout(() => void refreshUsers(true), 180);
  });
  usersQClear?.addEventListener('click', () => {
    if (!usersQuery) return;
    usersQuery = '';
    if (usersQ) {
      usersQ.value = '';
      usersQ.focus({ preventScroll: true });
    }
    usersQClear.hidden = true;
    impact('light');
    void refreshUsers(true);
  });
  usersMore?.addEventListener('click', () => {
    impact('light');
    void refreshUsers(false);
  });

  /* one delegated listener for the whole directory: the list is rebuilt on every paint */
  usersList?.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const ban = el.closest<HTMLButtonElement>('[data-uban]');
    if (ban) {
      const id = ban.dataset.uban ?? '';
      const banned = ban.getAttribute('aria-pressed') === 'true';
      void actOnPlayer(id, banned ? 'UNBAN' : 'BAN');
      return;
    }
    const grant = el.closest<HTMLButtonElement>('[data-ugrant]');
    if (grant) {
      void actOnPlayer(grant.dataset.uid ?? '', 'GRANT_COINS', Number(grant.dataset.ugrant) || 0);
      return;
    }
    const main = el.closest<HTMLButtonElement>('[data-uopen]');
    if (!main) return;
    const id = main.dataset.uopen ?? '';
    openPlayer = openPlayer === id ? '' : id;
    impact('light');
    paintUsers();
  });
  usersList?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openPlayer) {
      /* the stage's own Escape must not close the whole panel while a card is open */
      e.stopPropagation();
      openPlayer = '';
      paintUsers();
    }
  });

  /* the timeframe row: one raised gold key on a recessed track, and a repaint of the dashboard */
  for (const btn of tfBtns) {
    btn.addEventListener('click', () => {
      const next = (btn.dataset.range ?? 'today') as StatsRange;
      if (next === range) return;
      range = next;
      for (const b of tfBtns) b.setAttribute('aria-pressed', String(b === btn));
      impact('light');                       // the soft haptic that says "the switch took"
      paintStats();
    });
  }

  /* one delegated listener: the list is rebuilt on every paint, so no handler outlives its card */
  inboxList?.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const send = el.closest<HTMLButtonElement>('[data-send]');
    if (send) {
      sendReply(send.dataset.send ?? '');
      return;
    }
    const resolve = el.closest<HTMLButtonElement>('[data-resolve]');
    if (resolve) {
      resolveTicket(resolve.dataset.resolve ?? '');
      return;
    }
    const main = el.closest<HTMLButtonElement>('[data-open]');
    if (!main) return;
    const id = main.dataset.open ?? '';
    openTicket = openTicket === id ? '' : id;
    impact('light');
    paintInbox();
  });
  inboxList?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openTicket) {
      /* the stage's own Escape must not close the whole panel while a card is open */
      e.stopPropagation();
      openTicket = '';
      paintInbox();
    }
  });

  serverRefresh?.addEventListener('click', () => {
    impact('light');
    void refreshServer();
  });
  serverClear?.addEventListener('click', () => { void clearQueue(); });
  /* every Abort is delegated: the roster is rebuilt on each read, so no handler outlives its row */
  serverList?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-abort]');
    if (btn) void abortMatch(btn.dataset.abort ?? '');
  });

  /* Escape closes one layer at a time: the confirm dialog, then a drawer, then the stage. */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !open || e.defaultPrevented) return;
    if (confirmEl && !confirmEl.hidden) {
      closeConfirm();
      return;
    }
    if (aclDrawer && !aclDrawer.hidden) {
      hideDrawer(aclDrawer);
      return;
    }
    if (bcDrawer && !bcDrawer.hidden) {
      hideDrawer(bcDrawer);
      return;
    }
    closeStage();
  });

  for (const el of sws) {
    const key = el.dataset.tog as ToggleKey;
    if (!TOGGLES.includes(key)) continue;
    el.addEventListener('click', () => {
      impact('light');
      setRuntime({ [key]: !runtime[key] } as Partial<AdminRuntime>);
      paintToggles();
      paintDot();
      const label = key === 'salesOpen' ? 'Shop Store' : key === 'hazards' ? 'Hazards' : 'Maintenance Lock';
      api.note(`${label}: ${runtime[key] ? 'on' : 'off'}`, false, 1800);
      notify(runtime[key] ? 'success' : 'warning');
    });
  }

  for (const btn of stepBtns) {
    btn.addEventListener('click', () => {
      const row = btn.closest<HTMLElement>('[data-step]');
      const k = row ? KNOBS[row.dataset.step ?? ''] : undefined;
      if (!k) return;
      const dir = btn.dataset.dir === '-1' ? -1 : 1;
      k.apply(k.next(dir));
      paintSteps();
      impact('light');
    });
  }

  $<HTMLButtonElement>('econ-reset')?.addEventListener('click', () => {
    setRuntime(ECONOMY_DEFAULTS);
    paintAll();
    impact('medium');
    notify('success');
    api.note('Economy reset to defaults.', false, 2000);
  });

  $<HTMLButtonElement>('bc-publish')?.addEventListener('click', () => {
    const text = (bcInput?.value ?? '').trim().slice(0, 140);
    if (!text) {
      api.note('Type a message before publishing.', true, 2200);
      notify('error');
      return;
    }
    setRuntime({ broadcast: text });
    paintBroadcast();
    api.onDispatch?.(text);
    impact('medium');
    notify('success');
    api.note('Command Dispatch raised on this device.', false, 2000);
  });

  $<HTMLButtonElement>('bc-clear')?.addEventListener('click', () => {
    setRuntime({ broadcast: '' });
    if (bcInput) bcInput.value = '';
    paintBroadcast();
    impact('light');
    api.note('Broadcast cleared.', false, 1800);
  });

  /* ---------- Access control: the add key, the drawer, the grant and the revoke ---------- */

  aclAdd?.addEventListener('click', () => {
    if (!aclOn || !aclCan) {
      impact('light');
      notify('error');
      api.note(
        aclOn ? 'SuperAdmin access required.' : 'The server owns the role registry — no Worker answering.',
        true,
        2400,
      );
      return;
    }
    impact('light');
    showDrawer(aclDrawer);
    paintAclHint();
    aclId?.focus({ preventScroll: true });
  });
  aclDrawerX?.addEventListener('click', () => hideDrawer(aclDrawer));
  aclCancel?.addEventListener('click', () => hideDrawer(aclDrawer));
  /* the id field validates on a short leash: one quiet beat after typing stops, never per keystroke */
  aclId?.addEventListener('input', () => {
    window.clearTimeout(aclTimer);
    if (aclHint) {
      aclHint.dataset.state = 'idle';
      aclHint.textContent = 'Checking…';
    }
    aclTimer = window.setTimeout(paintAclHint, 180);
  });
  for (const b of aclRoleBtns) {
    b.addEventListener('click', () => {
      const next: AdminRole = b.dataset.role === 'superadmin' ? 'superadmin' : 'moderator';
      if (next === aclRole) return;
      aclRole = next;
      for (const x of aclRoleBtns) x.setAttribute('aria-pressed', String(x === b));
      impact('light');
    });
  }
  aclGrant?.addEventListener('click', () => {
    if (aclGrant.getAttribute('aria-disabled') === 'true') {
      impact('light');
      notify('error');
      api.note('Type a Telegram id or an @handle first.', true, 2200);
      aclId?.focus({ preventScroll: true });
      return;
    }
    void grantAdmin();
  });
  /* one delegated listener: the list is rebuilt on every paint */
  aclList?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-revoke]');
    if (btn && !btn.disabled) askRevoke(btn.dataset.revoke ?? '');
  });

  /* ---------- the broadcast engine: compose, preview, dispatch, archive ---------- */

  bcCompose?.addEventListener('click', () => {
    impact('light');
    hideBcToast();
    showDrawer(bcDrawer);
    paintBcPreview();
  });
  bcDrawerX?.addEventListener('click', () => {
    hideBcToast();
    hideDrawer(bcDrawer);
  });
  bcCancel?.addEventListener('click', () => {
    hideBcToast();
    hideDrawer(bcDrawer);
  });
  bcCtaToggle?.addEventListener('click', () => {
    impact('light');
    setCtaOn(!bcCtaOn);
  });
  bcToastDone?.addEventListener('click', () => {
    impact('light');
    hideBcToast();
    hideDrawer(bcDrawer);
  });
  for (const el of [bcTitle, bcBody, bcCtaLabel, bcCtaTarget, bcAudValue]) {
    el?.addEventListener('input', () => paintBcPreview());
  }
  for (const b of bcAudBtns) {
    b.addEventListener('click', () => {
      const next = (b.dataset.aud ?? 'all') as Broadcast['audience']['kind'];
      if (next === bcAud) return;
      bcAud = next;
      for (const x of bcAudBtns) x.setAttribute('aria-pressed', String(x === b));
      if (bcAudValueWrap) bcAudValueWrap.hidden = next === 'all';
      if (bcAudValueL) bcAudValueL.textContent = next === 'country' ? 'Country code' : 'Minimum level';
      if (bcAudValue) {
        bcAudValue.value = '';
        bcAudValue.placeholder = next === 'country' ? 'US' : next === 'minLevel' ? '10' : '';
        if (next !== 'all') bcAudValue.focus({ preventScroll: true });
      }
      impact('light');
      paintBcPreview();
    });
  }
  for (const b of bcPriBtns) {
    b.addEventListener('click', () => {
      const next: 'urgent' | 'feed' = b.dataset.pri === 'feed' ? 'feed' : 'urgent';
      if (next === bcPri) return;
      bcPri = next;
      for (const x of bcPriBtns) x.setAttribute('aria-pressed', String(x === b));
      impact('light');
      paintBcPreview();
    });
  }
  bcSend?.addEventListener('click', () => {
    if (bcBusy) return;                    /* the spinner is up: this tap belongs to the Worker */
    if (bcSend.getAttribute('aria-disabled') === 'true') {
      impact('light');
      notify('error');
      showBcToast('bad', 'Failed to send: title and message are required — a button needs both halves.', false);
      return;
    }
    void sendBroadcast();
  });
  bcList?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-bcflip]');
    if (btn) void flipOne(btn.dataset.bcflip ?? '');
  });

  confirmNo?.addEventListener('click', () => closeConfirm());
  confirmYes?.addEventListener('click', () => {
    const run = pendingConfirm;
    closeConfirm();
    run?.();
  });
  confirmEl?.addEventListener('click', (e) => {
    if (e.target === confirmEl) closeConfirm();
  });

  $<HTMLButtonElement>('tool-coins')?.addEventListener('click', () => {
    const got = earnCoins(500);
    recordCoins(got);
    paintSave();
    paintStats();
    impact('medium');
    notify('success');
    api.note(`+${coinText(got)} coins granted.`, false, 2200);
  });

  $<HTMLButtonElement>('tool-tiq')?.addEventListener('click', () => {
    const got = earnTiq(200);
    paintSave();
    paintTier();
    impact('medium');
    notify('success');
    api.note(`+${got} TIQ granted.`, false, 2200);
  });

  $<HTMLButtonElement>('tool-tier')?.addEventListener('click', () => {
    const cur = runtime.tierOverride;
    const next = TIERS[((cur ? TIERS.indexOf(cur) : -1) + 1) % TIERS.length];
    setRuntime({ tierOverride: next });
    paintTier();
    impact('light');
    api.note(`Mind tier preview: ${TIER_LABEL[next]}.`, false, 2000);
  });

  resetBtn?.addEventListener('click', () => {
    if (resetId) {
      // second tap inside the window: the device-local save goes, the reload hands back defaults
      window.clearTimeout(resetId);
      resetId = 0;
      try {
        const doomed: string[] = [];
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith('detour.')) doomed.push(k);
        }
        for (const k of doomed) window.localStorage.removeItem(k);
      } catch {
        /* storage refused — the reload still gives defaults */
      }
      notify('success');
      api.note('Local save cleared — reloading.', false, 1200);
      window.setTimeout(() => window.location.reload(), 700);
      return;
    }
    resetBtn.classList.add('armed');
    resetBtn.textContent = 'Tap again to confirm';
    impact('light');
    api.note('Reset Local Save: tap once more to confirm.', true, 2600);
    resetId = window.setTimeout(() => {
      resetId = 0;
      resetBtn.classList.remove('armed');
      resetBtn.textContent = 'Reset Local Save';
    }, 3200);
  });

  // a balance or TIQ moved anywhere else in the app keeps the panel's readouts honest
  onChange(() => {
    if (!open) return;
    paintSave();
    /* the live seat's row reads the save: repaint it while the directory is the open tab */
    if (usersAsked && !$('apanel-users')?.hidden) paintUsers();
  });
  /* the support queue moved — from this panel, or from the Contact Support sheet */
  onTickets(() => {
    if (open) paintInbox();
    else paintInboxBadge();
  });
  onRuntime(() => {
    paintBroadcast();
    paintDot();
    /* Maintenance Lock and both radii are the server's too: the same flip that repaints the panel
       pushes the new values to `POST /admin/config`. Offline, `syncConfig` is a no-op. */
    void syncConfig();
  });

  const onResize = () => {
    if (live) placeFab();
  };
  window.addEventListener('resize', onResize);
  if (home) {
    const ro = new ResizeObserver(onResize);
    ro.observe(home);
    const launcher = home.querySelector<HTMLElement>('.launcher');
    if (launcher) ro.observe(launcher);
  }
  document.addEventListener('visibilitychange', onResize);

  return {
    open: openStage,
    close: closeStage,
    get isOpen() {
      return open;
    },
    mount() {
      if (fab) fab.hidden = !isAdmin();
      if (stage) mountCoins(stage);
      recordVisit();                       // the day's first sighting of this device
      paintAll();
      void probeDoor();                    // an appointed admin's device learns it here
      // the launcher only has a height once the home screen has been laid out
      requestAnimationFrame(() => {
        live = true;
        placeFab();
      });
    },
    relayout() {
      if (live) placeFab();
    },
  };
}
