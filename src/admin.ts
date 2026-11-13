/**
 * admin.ts — the Admin Command Center: a sculpted clay key on Home that opens a full-viewport
 * Dark Clay stage for running the game live.
 *
 * Two halves, on purpose.
 *
 * **The runtime config** (`runtime`, below) is the one live source every other module reads:
 * the blitz allowance, the TIQ win reward, the coin payout multiplier and the two queue radii.
 * It persists to the device
 * through the same wrapped door as the save, and `setRuntime` is the only writer — so a toggle
 * takes effect everywhere the instant it flips, with no reload and no second source of truth.
 *
 * **The controller** (`createAdmin`) wires the FAB, the overlay, its five tabs — Stats, Controls,
 * Server, Inbox and Tools, on a tactile bottom dock — and every control to that config. It owns no
 * game state of its own. The Inbox is the support desk: every ticket the client's Contact Support
 * sheet files lands in the shared queue (src/support.ts) and is read, replied to and resolved here.
 *
 * **The telemetry** is the Worker's own measured reading: `GET /api/admin/metrics` answers the
 * live room counts, the registry population, the durable gameplay counters and the real round
 * trip through the Durable Object. The Stats tab refreshes it on demand and on a slow beat. That
 * door is stricter than the rest of the admin surface — one Telegram id, no development fallback
 * — so a refusal shows the Unauthorized card and never substitutes a local or demo figure. The
 * device's own UTC-day counters still ride beneath the dashboard, labelled as such.
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
import { motionReduced, onLang, t } from './settings';
import {
  adminViewedAt, earnCoins, earnTiq, ladderTally, markAdminViewed, onChange, profile, readJson, writeJson,
} from './storage';
import { coinText, mountCoins, setBalance } from './coin';
import { CONFIG } from './rules';
import { flagPhoto } from './flags';
import {
  agoOf, onTickets, REPLY_MAX, replyTicket, tickets, toggleResolved, unreadCount,
  type Ticket, type TicketCategory,
} from './support';
import { getMySquad, squadMark, telegramAvatarUrl } from './squads';
import {
  directoryAction, directoryCountries, directoryPage, liveRow, PAGE_SIZE, YOU_ID,
  type AgeBand, type DirFilter, type DirPlayer, type DirSort,
} from './players';
import { nameOf } from './countries';
import { detonation, impact, notify, tgInitData, tgUser } from './telegram';
import { telegramChatLink } from '../shared/config';
import {
  MATCH_MODE_LABEL, matchModeFilterOf, type MatchMode, type MatchModeFilter,
} from '../shared/telemetry';
import {
  adminCall, adminFetch, bodySnippet, parseJson, postJson, reasonOfResponse,
  ADMIN_TIMEOUT_MS,
  type AdminFailure,
} from './adminApi';
import {
  VIP_PLAN_IDS, readVipPlanConfig, vipDaysLeftUntil, vipPlanFilterOf, vipPlanOf,
  type VipPlanConfig, type VipPlanFilter, type VipPlanId, type VipPurchase,
  type VipRevenueSummary, type VipTierRevenue,
} from '../shared/vip';
import {
  ARENA_TIER_IDS, SEASON_LENGTH_MS, adoptArena, arena, arenaLocked, countdownPill,
  datetimeLocalValue, fullCountdown, nextSeasonName, onArena, parseDatetimeLocal, seasonLabel,
  seasonNoFrom, setArenaLocal, syncArena,
  type ArenaDivisionRule, type ArenaSnapshot, type ArenaState, type ArenaStatus,
} from './arenaState';

/* ---------- who may open it ---------- */

/** The built-in allowlist. Add Telegram user ids here, or to `VITE_ADMIN_IDS`. */
export const ADMIN_IDS: readonly string[] = ['1350508522', '1', '1000001'];

const rawAdminIds =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ADMIN_IDS) || '';

const envIds = rawAdminIds
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
  winTiq: 140,
  coinMult: 1,
  blitz: CONFIG.TURN_TIME_LIMIT,
  radiusNormal: 250,
  radiusWide: 600,
};

const RUNTIME_KEY = 'detour.admin.v1';

/** Every finished race lands this much TIQ; a win adds the rest of `winTiq` on top of it. */
export const RACE_TIQ = 20;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pickNum = (v: unknown, fallback: number, lo: number, hi: number): number =>
  isNum(v) ? clamp(v, lo, hi) : fallback;
const pickOne = (list: readonly number[], v: unknown, fallback: number): number =>
  isNum(v) && list.includes(v) ? v : fallback;

/** A hand-edited or half-written blob is folded field by field, never trusted as it stands. */
function loadRuntime(): AdminRuntime {
  const raw = readJson<AdminRuntime>(RUNTIME_KEY);
  const d = DEFAULT_RUNTIME;
  if (!raw) return { ...d };
  return {
    winTiq: Math.round(pickNum(raw.winTiq, d.winTiq, 0, 1000)),
    coinMult: pickOne(COIN_STEPS, raw.coinMult, d.coinMult),
    blitz: pickOne(BLITZ_STEPS, raw.blitz, d.blitz),
    radiusNormal: Math.round(pickNum(raw.radiusNormal, d.radiusNormal, 50, 2000)),
    radiusWide: Math.round(pickNum(raw.radiusWide, d.radiusWide, 100, 4000)),
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
 * nothing else — the switches are somebody else's decision.
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

/* ---------- the device's own day: a labelled footnote under the live dashboard ---------- */

/**
 * The counters this device keeps for itself, one UTC day at a time. They never feed the executive
 * KPI grid — that grid is the Worker's measured reading — and the footnote under it names the
 * device as their source. A figure neither side measures prints as an em dash.
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

/** One live 1v1, as the matchmaking telemetry reports it. */
export interface ActiveRoom {
  matchId: string;
  p0: string;
  p1: string;
  turn: number;
  /** How many seats the race fields — 2 for a duel, up to four for a room. */
  players?: number;
  /** How many of those seats the machine is holding. */
  bots?: number;
  /** `1v1` for a duel, `room` for a multi-seat board. */
  kind?: '1v1' | 'room';
  /** When the board started, in ms; the inspector ticks its clock from here. */
  startedAt?: number;
  /** Watchers attached to the board. The engine has no spectator relay yet, so 0. */
  spectators?: number;
}

/** One room still filling its seats, as the lobby inspector reports it. */
export interface OpenLobby {
  code: string;
  size: number;
  joined: number;
  openedAt: number;
  waitMs: number;
  friends: boolean;
}

export interface ServerStatus {
  ok: true;
  /** The Worker's clock when the reading was taken. */
  timestamp?: number;
  queueCount: number;
  activeMatchesCount: number;
  /** Duels still being played. */
  active1v1?: number;
  queuedPlayers: QueuedPlayer[];
  activeRooms: ActiveRoom[];
  /** Rooms that have not launched yet. */
  openLobbies?: OpenLobby[];
  config: ServerConfig;
  arena: ArenaState;
}

/**
 * What "there is no response to read" means, kept in three pieces because the remedies differ:
 * no origin to call, a Worker that is thinking too long, and a request that never left the device.
 */
const failureText = (failure: AdminFailure, timeoutMs = ADMIN_TIMEOUT_MS): string => {
  if (failure === 'no-origin') return 'this page has no Worker origin to call';
  if (failure === 'timeout') return `the Worker did not answer within ${Math.round(timeoutMs / 1000)}s`;
  return 'the request never reached the Worker (network)';
};

/** A failed call, named by the route it tried, why it failed, and what the client itself threw. */
const routeFailure = (route: string, failure: AdminFailure, thrown?: string): string =>
  [`${route} → ${failureText(failure)}`, thrown].filter((part): part is string => !!part).join(' · ');

/**
 * How a metrics or status attempt failed. These have to stay apart: `timeout` is a live Worker
 * behind a cold start, `offline` and `no-origin` are the only cases that may be called unreachable,
 * and `http` or `bad-body` are a Worker that answered and was wrong.
 */
type FailureReason = AdminFailure | 'http' | 'bad-body';

/**
 * The state lamp for a failed reading. A last genuine figure still on the board reads SLOW or
 * STALE rather than OFFLINE, because this Worker was answering moments ago.
 */
const connStateOf = (held: boolean, reason: FailureReason): string => {
  if (!held) return reason === 'offline' || reason === 'no-origin' ? 'offline' : 'error';
  return reason === 'timeout' ? 'slow' : 'stale';
};

/** A reason the Worker wrote, made safe to open a sentence with. */
const capFirst = (text: string): string => (text ? text[0].toUpperCase() + text.slice(1) : text);

/** One telemetry read: the live room and its round trip, a refusal, or no answer and why. */
type ServerReading =
  | { state: 'ok'; status: ServerStatus; pingMs: number }
  | { state: 'denied'; detail: string }
  | { state: 'error'; reason: AdminFailure | 'http'; detail: string };

/**
 * The room's own reading of itself. The dedicated `/api/admin/matchmaking` door is tried first:
 * it is the Server tab's live telemetry, never cached. `/admin/status` remains the fallback for a
 * Worker deployed before that route existed.
 *
 * A 401/403 is the registry refusing this session and a 404 is a route this deployment never
 * had; neither is an outage, and none of them may paint the offline card that tells the operator
 * to start `wrangler dev`. Only a call that never got an answer is.
 */
async function fetchStatus(): Promise<ServerReading> {
  const started = Date.now();
  const first = await adminCall('/api/admin/matchmaking', { cache: 'no-store' });
  /* No response at all: do not burn a second timeout on the older door behind it. */
  if ('failure' in first) {
    return { state: 'error', reason: first.failure, detail: routeFailure('GET /api/admin/matchmaking', first.failure, first.detail) };
  }
  const res = first.res;
  /* A refusal is a decision, not an outage: do not ask the older door behind it. */
  if (res.status === 401 || res.status === 403) {
    return { state: 'denied', detail: await reasonOfResponse(res, 'GET /api/admin/matchmaking') };
  }
  let data = await parseJson<ServerStatus>(res);
  if (!data || data.ok !== true) {
    const legacy = await adminCall('/admin/status', { cache: 'no-store' });
    if ('failure' in legacy) {
      return { state: 'error', reason: legacy.failure, detail: routeFailure('GET /admin/status', legacy.failure, legacy.detail) };
    }
    if (legacy.res.status === 401 || legacy.res.status === 403) {
      return { state: 'denied', detail: await reasonOfResponse(legacy.res, 'GET /admin/status') };
    }
    if (legacy.res.status === 404) {
      return { state: 'error', reason: 'http', detail: await reasonOfResponse(legacy.res, 'GET /admin/status') };
    }
    data = await parseJson<ServerStatus>(legacy.res);
    if (!data || data.ok !== true) {
      return { state: 'error', reason: 'http', detail: await reasonOfResponse(legacy.res, 'GET /admin/status') };
    }
  }
  return { state: 'ok', status: data, pingMs: Math.max(0, Date.now() - started) };
}

/**
 * The Worker's measured telemetry, exactly as `GET /api/admin/metrics` frames it. The route is
 * stricter than `/admin/*`: an id on the operator set, proven by a real credential, with no
 * development fallback. Every field is measured server-side; empty state is exact zeroes.
 */
export interface ServerMetrics {
  ok: true;
  /** The room's clock when the reading was taken. */
  timestamp: number;
  /** `production`, `development`, or the deployment's own label. */
  environment: string;
  /** The real round trip through the Durable Object, added by the Worker edge. */
  pingMs?: number;
  /** The match-type slice this reading was folded for. */
  mode: MatchModeFilter;
  activeRooms: number;
  queueLength: number;
  active1v1: number;
  totalUsers: number;
  telegramUsers: number;
  matchesCompleted: number;
  /** Matches that settled in the rolling last 24 hours, filtered by `mode`. */
  matches24h: number;
  /** Matches inside the rolling 24 hours, one count per match type. */
  matchesByMode24h: Record<MatchMode, number>;
  /** Matches inside the rolling 24 hours, one count per seat count. */
  matchesByPlayers24h: Record<'2' | '3' | '4', number>;
  /** Distinct players active in the requested slice in the rolling last 24 hours. */
  active24h: number;
  minesPlaced: number;
  /** Retired rolling-log counter; the Worker always reports 0. */
  logsSpawned: number;
  referrals: number;
  referringPlayers: number;
  /** Players whose last activity falls inside the rolling last 24 hours. */
  dau: number;
  /** Players whose last activity falls inside the rolling last 7 days. */
  wau: number;
  /** Players whose last activity falls inside the rolling last 30 days. */
  mau: number;
  /** Active in the last 24 hours, first seen before that window: today's returning veterans. */
  returningUsersToday: number;
  /** `returningUsersToday` as a % of `dau`. */
  returningShare: number;
  /** Registry entries first seen in the rolling last 24 hours. */
  signupsToday: number;
  /** Registry entries first seen in the rolling last 7 days. */
  signupsWeek: number;
  /** Registry entries first seen in the rolling last 30 days. */
  signupsMonth: number;
  /** % of players first seen 24h+ ago who came back a full day or more after their first visit. */
  retentionRateD1: number;
  /** Completed matches per registered player, rounded to one decimal. */
  avgMatchesPerPlayer: number;
  /** % of registered players who finished at least one match. */
  activationRate: number;
  /** % of registered players who finished three or more matches. */
  coreRetention: number;
  /** DAU as a % of the registered playerbase. */
  dailyActiveRatio: number;
  /** Referral joins as a % of the registered playerbase, capped at 100. */
  viralShare: number;
  /** The last 24 hourly buckets, oldest first: the trend chart's Daily window. */
  series24h: SeriesPoint[];
  /** The last 7 daily buckets, oldest first: the trend chart's Weekly window. */
  series7d: SeriesPoint[];
  /** The last 30 daily buckets, oldest first: the trend chart's Monthly window. */
  series30d: SeriesPoint[];
  /** Sections the room could not read, each reporting its own exact zeroes. Empty when all is well. */
  degraded?: string[];
}

/**
 * One plotted bucket of the trend chart. The Worker folds these from its own bounded ring buffers
 * and the registry's real `firstSeen` / `lastSeen` timestamps; a bucket nothing happened in is an
 * exact zero, so an empty stretch of the chart means an empty stretch of the game.
 */
export interface SeriesPoint {
  /** The bucket's opening edge in epoch ms: a UTC hour for `series24h`, a UTC day for the rest. */
  t: number;
  signups: number;
  active: number;
  matches: number;
}

/** The answers the operator's telemetry door can give this panel, and how it failed when it did. */
type MetricsResult =
  | { state: 'ok'; metrics: ServerMetrics }
  | { state: 'unauthorized'; detail: string }
  | { state: 'error'; reason: AdminFailure | 'http' | 'bad-body'; detail: string };

/**
 * A finite count, or the exact zero this dashboard shows for a section that reported nothing.
 * Telemetry is additive: a Worker that has not shipped one of these fields yet must cost that
 * field alone, never the whole reading.
 */
const metricCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** One plotted series, reconciled point by point; a non-array is an empty chart, not a failure. */
const metricSeries = (value: unknown): SeriesPoint[] =>
  Array.isArray(value)
    ? value
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row))
      .map((row) => ({
        t: metricCount(row.t),
        signups: metricCount(row.signups),
        active: metricCount(row.active),
        matches: metricCount(row.matches),
      }))
    : [];

/** The three match-type counters, reconciled one key at a time. */
const metricModeCounts = (value: unknown): Record<MatchMode, number> => {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { bot: metricCount(row.bot), pvp: metricCount(row.pvp), arena: metricCount(row.arena) };
};

/** The three seat-count counters, reconciled the same way. */
const metricPlayerCounts = (value: unknown): Record<'2' | '3' | '4', number> => {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { '2': metricCount(row['2']), '3': metricCount(row['3']), '4': metricCount(row['4']) };
};

/** The fields a genuine reading always carries; at least one must be present to accept a body. */
const METRIC_FIELDS = ['timestamp', 'activeRooms', 'totalUsers', 'matchesCompleted', 'series24h'] as const;

/**
 * Reconcile an answered body against `ServerMetrics`. The Worker owns every field and its own
 * shape, but the panel must not reject a whole reading because one field is missing, null or a
 * string: each falls back to its exact-zero / empty equivalent, and only a body that does not
 * look like telemetry at all is refused.
 */
function normalizeMetrics(raw: unknown): ServerMetrics | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const shaped = row.ok === true || METRIC_FIELDS.some((field) => field in row);
  if (row.ok === false || !shaped) return null;
  return {
    ok: true,
    timestamp: metricCount(row.timestamp) || Date.now(),
    environment: typeof row.environment === 'string' && row.environment ? row.environment : 'unknown',
    pingMs: typeof row.pingMs === 'number' && Number.isFinite(row.pingMs) ? row.pingMs : undefined,
    mode: matchModeFilterOf(row.mode),
    activeRooms: metricCount(row.activeRooms),
    queueLength: metricCount(row.queueLength),
    active1v1: metricCount(row.active1v1),
    totalUsers: metricCount(row.totalUsers),
    telegramUsers: metricCount(row.telegramUsers),
    matchesCompleted: metricCount(row.matchesCompleted),
    matches24h: metricCount(row.matches24h),
    matchesByMode24h: metricModeCounts(row.matchesByMode24h),
    matchesByPlayers24h: metricPlayerCounts(row.matchesByPlayers24h),
    active24h: metricCount(row.active24h),
    minesPlaced: metricCount(row.minesPlaced),
    logsSpawned: metricCount(row.logsSpawned),
    referrals: metricCount(row.referrals),
    referringPlayers: metricCount(row.referringPlayers),
    dau: metricCount(row.dau),
    wau: metricCount(row.wau),
    mau: metricCount(row.mau),
    returningUsersToday: metricCount(row.returningUsersToday),
    returningShare: metricCount(row.returningShare),
    signupsToday: metricCount(row.signupsToday),
    signupsWeek: metricCount(row.signupsWeek),
    signupsMonth: metricCount(row.signupsMonth),
    retentionRateD1: metricCount(row.retentionRateD1),
    avgMatchesPerPlayer: metricCount(row.avgMatchesPerPlayer),
    activationRate: metricCount(row.activationRate),
    coreRetention: metricCount(row.coreRetention),
    dailyActiveRatio: metricCount(row.dailyActiveRatio),
    viralShare: metricCount(row.viralShare),
    series24h: metricSeries(row.series24h),
    series7d: metricSeries(row.series7d),
    series30d: metricSeries(row.series30d),
    degraded: Array.isArray(row.degraded)
      ? row.degraded.filter((part): part is string => typeof part === 'string' && part !== '')
      : [],
  };
}

/**
 * Read the Worker's measured telemetry. `adminHeaders` already carries the Mini App's signed
 * `initData` (and the dev marker, which this route ignores), and every call goes through
 * `adminCall`, so the credential rides this route exactly as it rides the rest of the panel. A
 * 401/403 is the admin door refusing this account — never a cue to fall back to a demo reading.
 *
 * The ways this call fails are separate facts and the panel says which one happened: a Worker that
 * answered 500 is live and broken, a Worker that answered 404 has no such route, a Worker that took
 * too long is behind a cold Durable Object, and only a request that never got a response is an
 * outage. Collapsing all four into "unreachable" is what made a live backend read as OFFLINE.
 *
 * The whole read is guarded: the endpoint, the status and the body it actually sent travel in
 * every failure detail, and a client-side throw is caught here rather than escaping as an opaque
 * "the panel could not complete the reading".
 */
const METRICS_ROUTE = 'GET /api/admin/metrics';
const METRICS_PATH = '/api/admin/metrics';
const METRICS_TIMEOUT_MS = 20_000;

/** The route as the error card names it: the slice is part of what was called. */
const metricsRoute = (mode: MatchModeFilter): string =>
  mode === 'all' ? METRICS_ROUTE : `${METRICS_ROUTE}?mode=${mode}`;

async function fetchMetrics(mode: MatchModeFilter = 'all'): Promise<MetricsResult> {
  const route = metricsRoute(mode);
  const path = mode === 'all' ? METRICS_PATH : `${METRICS_PATH}?mode=${mode}`;
  try {
    const called = await adminCall(path, { cache: 'no-store' }, METRICS_TIMEOUT_MS);
    if ('failure' in called) {
      return {
        state: 'error',
        reason: called.failure,
        detail: routeFailure(route, called.failure, called.detail),
      };
    }
    const res = called.res;
    /* Reading the body consumes it, so each branch reads it exactly once. */
    if (res.status === 401 || res.status === 403) {
      return { state: 'unauthorized', detail: await reasonOfResponse(res, route) };
    }
    if (res.status !== 200) {
      return { state: 'error', reason: 'http', detail: await reasonOfResponse(res, route) };
    }
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* a stream that broke before its body arrived: the empty text is reported below */
    }
    let raw: unknown = null;
    try {
      raw = text ? JSON.parse(text) : null;
    } catch {
      return {
        state: 'error',
        reason: 'bad-body',
        detail: `${route} → HTTP 200 · the body is not JSON${text ? ` · ${bodySnippet(text)}` : ' (empty body)'}`,
      };
    }
    const metrics = normalizeMetrics(raw);
    return metrics
      ? { state: 'ok', metrics }
      : {
        state: 'error',
        reason: 'bad-body',
        detail: `${route} → HTTP 200 · the body carries no metrics payload${text ? ` · ${bodySnippet(text)}` : ' (empty body)'}`,
      };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      state: 'error',
      reason: 'bad-body',
      detail: `${route} → the panel could not complete the reading (${bodySnippet(reason)})`,
    };
  }
}

/**
 * Push a config patch to the live server. `denied` is the role registry refusing a Moderator —
 * the Worker is still live, so it must never be painted as offline. `error` is no answer at all.
 */
type ConfigPush =
  | { state: 'ok'; config: ServerConfig }
  | { state: 'denied' }
  | { state: 'error' };

async function pushConfig(patch: ServerConfig): Promise<ConfigPush> {
  const res = await postJson('/admin/config', patch);
  if (!res) return { state: 'error' };
  if (res.status === 401 || res.status === 403) return { state: 'denied' };
  const data = await parseJson<{ ok?: boolean; config?: ServerConfig }>(res);
  return data?.ok === true && data.config
    ? { state: 'ok', config: data.config }
    : { state: 'error' };
}

/* ---------- the mandatory channel gate ---------- */

/** The gate's durable row, as `GET/POST /api/admin/force-join` frames it. */
export interface ForceJoinConfig {
  forceJoinEnabled: boolean;
  targetChannel: string;
  /** Derived by the Worker: the public `t.me` link for `targetChannel`. */
  channelUrl?: string;
}

function readForceJoinConfig(raw: unknown): ForceJoinConfig | null {
  const row = raw as { forceJoinEnabled?: unknown; targetChannel?: unknown; channelUrl?: unknown } | null;
  if (!row || typeof row.forceJoinEnabled !== 'boolean' || typeof row.targetChannel !== 'string') return null;
  return {
    forceJoinEnabled: row.forceJoinEnabled,
    targetChannel: row.targetChannel,
    channelUrl: typeof row.channelUrl === 'string' ? row.channelUrl : '',
  };
}

/** The live row; null when nothing answered, so the card keeps what it has. */
async function fetchForceJoin(): Promise<ForceJoinConfig | null> {
  const res = await adminFetch('/api/admin/force-join', { cache: 'no-store' });
  if (!res || !res.ok) return null;
  const data = await parseJson<{ ok?: unknown; config?: unknown }>(res);
  return data?.ok === true ? readForceJoinConfig(data.config) : null;
}

type ForceJoinPush =
  | { state: 'ok'; config: ForceJoinConfig }
  | { state: 'denied'; detail: string }
  | { state: 'error'; detail: string };

/** Commit the switch and the channel. Only a SuperAdmin may write; the room says so itself. */
async function pushForceJoin(config: ForceJoinConfig): Promise<ForceJoinPush> {
  const res = await postJson('/api/admin/force-join', {
    forceJoinEnabled: config.forceJoinEnabled,
    targetChannel: config.targetChannel,
  });
  if (!res) return { state: 'error', detail: 'The Worker did not answer.' };
  if (res.status === 401 || res.status === 403) {
    return { state: 'denied', detail: await reasonOfResponse(res, 'POST /api/admin/force-join') };
  }
  if (!res.ok) {
    return { state: 'error', detail: await reasonOfResponse(res, 'POST /api/admin/force-join') };
  }
  const data = await parseJson<{ ok?: unknown; config?: unknown }>(res);
  const next = data?.ok === true ? readForceJoinConfig(data.config) : null;
  if (!next) return { state: 'error', detail: 'The Worker sent no gate configuration.' };
  return { state: 'ok', config: next };
}

/** The Arena tab's answer: the board as the room now holds it, or the refusal code. */
interface ArenaReply {
  ok?: boolean;
  error?: string;
  arena?: ArenaState;
  dismissed?: number;
  awards?: number;
  snapshot?: ArenaSnapshot;
}

/** One arena patch or emergency command. Null when the Worker never answered. */
async function pushArena(body: unknown): Promise<ArenaReply | null> {
  const res = await postJson('/admin/arena', body);
  if (!res) return null;
  try {
    return (await res.json()) as ArenaReply;
  } catch {
    return { ok: res.ok };
  }
}

/**
 * One moderation action. `denied` is the SuperAdmin door refusing this account, `refused` is the
 * room rejecting the command (a board may have closed since the last poll) — both mean the Worker
 * is live. Only `error` is no answer at all.
 */
type ActionReply = 'ok' | 'denied' | 'refused' | 'error';

async function serverAction(
  body: { action: 'CLEAR_QUEUE' } | { action: 'ABORT_MATCH'; matchId: string },
): Promise<ActionReply> {
  const res = await postJson('/admin/action', body);
  if (!res) return 'error';
  if (res.status === 401 || res.status === 403) return 'denied';
  return res.ok ? 'ok' : 'refused';
}

/** One page of the Worker's player directory, as `GET /admin/players` frames it. */
interface PlayersPage {
  ok: true;
  total: number;
  offset: number;
  limit: number;
  players: DirPlayer[];
}

/** Read the Worker's directory; null when nothing answers, so the panel can show the device's own seat. */
async function fetchPlayers(
  q: string,
  filter: DirFilter,
  country: string,
  age: AgeBand,
  plan: VipPlanFilter,
  sort: DirSort,
  offset: number,
  limit: number,
): Promise<PlayersPage | null> {
  const params = new URLSearchParams({ q, filter, country, age, plan, sort });
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  const data = await parseJson<PlayersPage>(
    await adminFetch(`/admin/players?${params.toString()}`, { cache: 'no-store' }),
  );
  return data && data.ok === true && Array.isArray(data.players) ? data : null;
}

/* ---------- the role registry, over `/api/admin/*` ---------- */

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
}

async function adminMutation(path: string, body: unknown): Promise<MutationResult | null> {
  const res = await postJson(path, body);
  if (!res) return null;
  try {
    const data = (await res.json()) as { ok?: boolean; error?: string };
    return {
      ok: data.ok === true,
      error: typeof data.error === 'string' ? data.error : undefined,
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

/** The Worker's refusal codes, in the panel's voice. */
const ROLE_ERROR: Record<string, string> = {
  invalid_id: 'That is neither a Telegram id nor an @handle.',
  invalid_role: 'Unknown role.',
  root_admin: 'Root admins come from the server allowlist and cannot be revoked.',
  last_superadmin: 'The last SuperAdmin cannot be revoked.',
  no_such_admin: 'That admin is no longer on the registry.',
  forbidden: 'SuperAdmin access required.',
};

/** `SuperAdmin` / `Moderator`, the way the badges read. */
const ROLE_LABEL = (r: AdminRole): string => (r === 'superadmin' ? 'SuperAdmin' : 'Moderator');

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

/**
 * The directory prune: forget zero-game guest ghosts a random-seat build left behind. The
 * Worker answers the number it removed; null means no live registry answered the call.
 */
async function pruneGhostPlayers(): Promise<number | null> {
  const data = await parseJson<{ ok?: boolean; pruned?: number }>(
    await adminFetch('/admin/players/prune', { method: 'POST' }),
  );
  return data?.ok === true && typeof data.pruned === 'number' ? data.pruned : null;
}

/* ---------- the squad registry, over `/api/admin/squads` ---------- */

export type SquadChatKind = 'channel' | 'group';
export type SquadVerification = 'verified' | 'pending' | 'revoked';
export type SquadMemberRole = 'leader' | 'admin' | 'member';

/** One real mini-app player on the squad's in-game roster. */
export interface SquadMemberRow {
  id: string;
  name: string;
  tiq: number;
  role: SquadMemberRole;
  joinedAt: number;
  country: string;
  username: string;
  photo: string;
}

/** The Telegram audience bands the Squads tab can filter on. */
export type SquadRealBand = 'all' | 'lt1k' | '1k-10k' | '10k-100k' | '100k';
/** The in-game roster bands the Squads tab can filter on. */
export type SquadGameBand = 'all' | 'zero' | '1-9' | '10-49' | '50';

const SQUAD_REAL_LABEL: Record<SquadRealBand, string> = {
  all: 'Any audience',
  lt1k: 'Under 1K',
  '1k-10k': '1K – 10K',
  '10k-100k': '10K – 100K',
  '100k': '100K+',
};

const SQUAD_GAME_LABEL: Record<SquadGameBand, string> = {
  all: 'Any roster',
  zero: 'No players (0)',
  '1-9': '1 – 9',
  '10-49': '10 – 49',
  '50': '50+',
};

/** The closed interval [min, max] each band accepts. `Infinity` is the open top. */
const SQUAD_REAL_RANGE: Record<SquadRealBand, readonly [number, number]> = {
  all: [0, Infinity],
  lt1k: [0, 999],
  '1k-10k': [1000, 9999],
  '10k-100k': [10000, 99999],
  '100k': [100000, Infinity],
};

const SQUAD_GAME_RANGE: Record<SquadGameBand, readonly [number, number]> = {
  all: [0, Infinity],
  zero: [0, 0],
  '1-9': [1, 9],
  '10-49': [10, 49],
  '50': [50, Infinity],
};

const asSquadRealBand = (value: string): SquadRealBand =>
  value === 'lt1k' || value === '1k-10k' || value === '10k-100k' || value === '100k'
    ? value
    : 'all';

const asSquadGameBand = (value: string): SquadGameBand =>
  value === 'zero' || value === '1-9' || value === '10-49' || value === '50'
    ? value
    : 'all';

/** One registered squad, exactly as the Worker frames it for the Squads tab. */
export interface SquadRow {
  id: string;
  chatId: string;
  handle: string;
  name: string;
  kind: SquadChatKind;
  avatar: string;
  tag: string;
  /** Joined mini-app players — the roster's length, never the Telegram audience. */
  members: number;
  /** The Telegram chat's own audience, kept as an external stat beside the roster. */
  subscribers: number;
  /** The in-game roster, leader first then by TIQ. */
  roster: SquadMemberRow[];
  ownerId: string;
  ownerName: string;
  ownerUsername: string;
  createdAt: number;
  verification: SquadVerification;
  verifiedAt: number;
  verifiedBy: string;
  revokedAt: number;
  banned: boolean;
  bannedAt: number;
  warTiq: number;
  contributors: number;
}

/** The four KPI tiles' source figures. */
export interface SquadTotals {
  total: number;
  channels: number;
  groups: number;
  verified: number;
  pending: number;
  revoked: number;
  banned: number;
  members: number;
  tiq: number;
  contributors: number;
}

/** Fold rows into aggregates, so the pulse always agrees with the cards on screen. */
function foldSquadTotals(rows: readonly SquadRow[]): SquadTotals {
  const totals: SquadTotals = {
    total: 0, channels: 0, groups: 0, verified: 0, pending: 0, revoked: 0, banned: 0,
    members: 0, tiq: 0, contributors: 0,
  };
  for (const row of rows) {
    totals.total++;
    if (row.kind === 'channel') totals.channels++;
    else totals.groups++;
    if (row.verification === 'verified') totals.verified++;
    else if (row.verification === 'revoked') totals.revoked++;
    else totals.pending++;
    if (row.banned) totals.banned++;
    totals.members += row.members;
    if (!row.banned) {
      totals.tiq += row.warTiq;
      totals.contributors += row.contributors;
    }
  }
  return totals;
}

const squadText = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
    : '';

const squadCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** One in-game roster row from the Worker: every field folded and bounded. */
function readSquadMember(raw: unknown): SquadMemberRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<SquadMemberRow>;
  const id = squadText(r.id, 24);
  if (!id) return null;
  const role: SquadMemberRole =
    r.role === 'leader' || r.role === 'admin' ? r.role : 'member';
  const country = squadText(r.country, 2).toUpperCase();
  const photo = squadText(r.photo, 300);
  return {
    id,
    name: squadText(r.name, 24),
    tiq: squadCount(r.tiq),
    role,
    joinedAt: squadCount(r.joinedAt),
    country: /^[A-Z]{2}$/.test(country) ? country : '',
    username: squadText(r.username, 32).replace(/^@+/, ''),
    photo: /^https:\/\/[^\s]+$/i.test(photo) ? photo : '',
  };
}

/** Read the roster the Worker sends, keeping the leader at the head and TIQ descending. */
function readSquadRoster(raw: unknown): SquadMemberRow[] {
  if (!Array.isArray(raw)) return [];
  const roster: SquadMemberRow[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const member = readSquadMember(entry);
    if (!member || seen.has(member.id)) continue;
    seen.add(member.id);
    roster.push(member);
    if (roster.length >= 5000) break;
  }
  return roster.sort((a, b) =>
    Number(b.role === 'leader') - Number(a.role === 'leader')
    || b.tiq - a.tiq
    || a.joinedAt - b.joinedAt);
}

/**
 * A registry row folded field by field: a missing or hand-edited entry is never trusted. The
 * Worker's canonical registry names (`title`, `type`, `enlistedAt`, `enlistedBy`, `membersCount`,
 * `tiq`, `status`) win; the legacy names stay readable so an older Worker deployment still paints.
 */
function readSquadRow(raw: unknown): SquadRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<SquadRow> & {
    title?: unknown;
    type?: unknown;
    enlistedAt?: unknown;
    enlistedBy?: unknown;
    membersCount?: unknown;
    tiq?: unknown;
    status?: unknown;
  };
  const id = squadText(r.id, 48);
  const handle = squadText(r.handle, 64);
  if (!id || !handle) return null;
  const status = typeof r.status === 'string' ? r.status : '';
  const verification: SquadVerification =
    status === 'verified' || status === 'pending' || status === 'revoked'
      ? status
      : r.verification === 'verified' || r.verification === 'revoked'
        ? r.verification
        : 'pending';
  const enlistedBy = squadText(r.enlistedBy, 40);
  const byHandle = enlistedBy.startsWith('@');
  const roster = readSquadRoster(r.roster);
  return {
    id,
    chatId: squadText(r.chatId, 32),
    handle,
    name: squadText(r.title, 64) || squadText(r.name, 64) || handle,
    kind: r.type === 'channel' || r.kind === 'channel' ? 'channel' : 'group',
    avatar: squadText(r.avatar, 160),
    tag: squadText(r.tag, 8),
    members: squadCount(r.membersCount) || squadCount(r.members) || roster.length,
    subscribers: squadCount((r as { subscribers?: unknown }).subscribers),
    roster,
    ownerId: squadText(r.ownerId, 24) || (byHandle ? '' : enlistedBy),
    ownerName: squadText(r.ownerName, 40),
    ownerUsername: squadText(r.ownerUsername, 40) || (byHandle ? enlistedBy.slice(1, 41) : ''),
    createdAt: squadCount(r.enlistedAt) || squadCount(r.createdAt) || Date.now(),
    verification,
    verifiedAt: squadCount(r.verifiedAt),
    verifiedBy: squadText(r.verifiedBy, 40),
    revokedAt: squadCount(r.revokedAt),
    banned: status === 'banned' || r.banned === true,
    bannedAt: squadCount(r.bannedAt),
    warTiq: squadCount(r.tiq) || squadCount(r.warTiq),
    contributors: squadCount(r.contributors),
  };
}

interface SquadRegistryPage {
  ok: true;
  timestamp: number;
  totals: SquadTotals;
  squads: SquadRow[];
}

/** The whole registry, or null when the Worker is not answering. */
async function fetchSquads(): Promise<SquadRegistryPage | null> {
  const data = await parseJson<{ ok?: boolean; timestamp?: number; squads?: unknown[] }>(
    await adminFetch('/api/admin/squads', { cache: 'no-store' }),
  );
  if (!data || data.ok !== true || !Array.isArray(data.squads)) return null;
  const squads: SquadRow[] = [];
  for (const raw of data.squads) {
    const row = readSquadRow(raw);
    if (row) squads.push(row);
  }
  const timestamp = typeof data.timestamp === 'number' && Number.isFinite(data.timestamp)
    ? data.timestamp
    : Date.now();
  return { ok: true, timestamp, totals: foldSquadTotals(squads), squads };
}

type SquadAction = 'VERIFY' | 'REVOKE' | 'BAN' | 'UNBAN';

/** One audit action's answer: the updated row, a refusal code, or no answer at all. */
type SquadActionResult =
  | { state: 'ok'; squad: SquadRow }
  | { state: 'denied' }
  | { state: 'refused'; error: string }
  | { state: 'error' };

async function pushSquadAction(id: string, action: SquadAction): Promise<SquadActionResult> {
  const res = await postJson('/api/admin/squad-action', { id, action });
  if (!res) return { state: 'error' };
  if (res.status === 401 || res.status === 403) return { state: 'denied' };
  try {
    const data = (await res.json()) as { ok?: boolean; error?: string; squad?: SquadRow };
    if (data?.ok === true && data.squad) return { state: 'ok', squad: data.squad };
    return { state: 'refused', error: typeof data?.error === 'string' ? data.error : '' };
  } catch {
    return { state: 'refused', error: '' };
  }
}

/* ---------- the Stars Vault payout queue, over `/api/admin/vault*` ----------
 *
 * The room owns every figure: what the invite programme earned, what the owner has already
 * settled, which requests are waiting, and which accounts are held for collusion review. This
 * reads that ledger and posts one decision at a time — it never computes a balance locally.
 */

type VaultStatus = 'waiting' | 'paid' | 'rejected';
type VaultFilter = 'all' | VaultStatus;
type VaultAction = 'PAID' | 'REJECT' | 'CLEAR' | 'FLAG';

interface VaultRequest {
  requestId: string;
  playerId: string;
  playerName: string;
  amount: number;
  createdAt: number;
  status: VaultStatus;
  decidedAt: number;
}

interface VaultFlag {
  id: string;
  name: string;
  inviterId: string;
  inviterName: string;
  matches: number;
  clusterMatches: number;
  ratio: number;
  pvpWins: number;
  stage1: boolean;
  stage2: boolean;
  heldStars: number;
}

interface VaultTotals {
  earned: number;
  paid: number;
  waiting: number;
  waitingStars: number;
  queued: number;
  inviters: number;
  friends: number;
  flagged: number;
  budget: number;
  budgetSpent: number;
  budgetLeft: number;
  monthKey: string;
}

interface VaultPage {
  totals: VaultTotals;
  requests: VaultRequest[];
  flagged: VaultFlag[];
}

const vaultNum = (v: unknown): number => (
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0
);
const vaultStr = (v: unknown, max = 64): string => (typeof v === 'string' ? v.slice(0, max) : '');

function readVaultRequest(raw: unknown): VaultRequest | null {
  const r = raw as Partial<VaultRequest> | null;
  if (!r || typeof r.requestId !== 'string' || !r.requestId) return null;
  const amount = vaultNum(r.amount);
  if (amount <= 0) return null;
  return {
    requestId: r.requestId.slice(0, 40),
    playerId: vaultStr(r.playerId),
    playerName: vaultStr(r.playerName, 48),
    amount,
    createdAt: vaultNum(r.createdAt),
    status: r.status === 'paid' ? 'paid' : r.status === 'rejected' ? 'rejected' : 'waiting',
    decidedAt: vaultNum(r.decidedAt),
  };
}

function readVaultFlag(raw: unknown): VaultFlag | null {
  const r = raw as Partial<VaultFlag> | null;
  if (!r || typeof r.id !== 'string' || !r.id) return null;
  return {
    id: r.id.slice(0, 64),
    name: vaultStr(r.name, 48),
    inviterId: vaultStr(r.inviterId),
    inviterName: vaultStr(r.inviterName, 48),
    matches: vaultNum(r.matches),
    clusterMatches: vaultNum(r.clusterMatches),
    ratio: Math.min(100, vaultNum(r.ratio)),
    pvpWins: vaultNum(r.pvpWins),
    stage1: r.stage1 === true,
    stage2: r.stage2 === true,
    heldStars: vaultNum(r.heldStars),
  };
}

function readVaultTotals(raw: unknown): VaultTotals {
  const r = (raw ?? {}) as Partial<VaultTotals>;
  return {
    earned: vaultNum(r.earned),
    paid: vaultNum(r.paid),
    waiting: vaultNum(r.waiting),
    waitingStars: vaultNum(r.waitingStars),
    queued: vaultNum(r.queued),
    inviters: vaultNum(r.inviters),
    friends: vaultNum(r.friends),
    flagged: vaultNum(r.flagged),
    budget: vaultNum(r.budget),
    budgetSpent: vaultNum(r.budgetSpent),
    budgetLeft: vaultNum(r.budgetLeft),
    monthKey: vaultStr(r.monthKey, 7),
  };
}

function readVaultPage(data: { totals?: unknown; requests?: unknown; flagged?: unknown }): VaultPage {
  const requests: VaultRequest[] = [];
  const flagged: VaultFlag[] = [];
  if (Array.isArray(data.requests)) {
    for (const raw of data.requests) {
      const row = readVaultRequest(raw);
      if (row) requests.push(row);
    }
  }
  if (Array.isArray(data.flagged)) {
    for (const raw of data.flagged) {
      const row = readVaultFlag(raw);
      if (row) flagged.push(row);
    }
  }
  return { totals: readVaultTotals(data.totals), requests, flagged };
}

async function fetchVault(): Promise<VaultPage | null> {
  const data = await parseJson<{ ok?: boolean; totals?: unknown; requests?: unknown; flagged?: unknown }>(
    await adminFetch('/api/admin/vault', { cache: 'no-store' }),
  );
  if (!data || data.ok !== true || !Array.isArray(data.requests)) return null;
  return readVaultPage(data);
}

/** One decision's answer: the whole re-read ledger, a refusal code, or no answer at all. */
type VaultActionResult =
  | { state: 'ok'; page: VaultPage }
  | { state: 'denied' }
  | { state: 'refused'; error: string }
  | { state: 'error' };

async function pushVaultAction(id: string, action: VaultAction): Promise<VaultActionResult> {
  const res = await postJson('/api/admin/vault/action', { id, action });
  if (!res) return { state: 'error' };
  if (res.status === 401 || res.status === 403) return { state: 'denied' };
  try {
    const data = (await res.json()) as { ok?: boolean; error?: string; view?: { ok?: boolean; totals?: unknown; requests?: unknown; flagged?: unknown } };
    if (data?.ok === true && data.view?.ok === true) return { state: 'ok', page: readVaultPage(data.view) };
    return { state: 'refused', error: typeof data?.error === 'string' ? data.error : '' };
  } catch {
    return { state: 'refused', error: '' };
  }
}

/* ---------- the VIP storefront & revenue, over `/api/admin/vip/*` ---------- */

const vipCount = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;

const emptyVipTiers = (): Record<VipPlanId, VipTierRevenue> => ({
  '7d': { count: 0, starsGrossed: 0 },
  '30d': { count: 0, starsGrossed: 0 },
  '90d': { count: 0, starsGrossed: 0 },
});

function readVipStats(raw: unknown): VipRevenueSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  if (body.ok !== true) return null;
  const tiers = emptyVipTiers();
  const tierRows = body.tierBreakdown && typeof body.tierBreakdown === 'object'
    ? body.tierBreakdown as Record<string, unknown>
    : {};
  for (const id of VIP_PLAN_IDS) {
    const row = tierRows[id];
    if (!row || typeof row !== 'object') continue;
    const fields = row as Record<string, unknown>;
    tiers[id] = { count: vipCount(fields.count), starsGrossed: vipCount(fields.starsGrossed) };
  }

  const recentPurchases: VipPurchase[] = [];
  const recent = Array.isArray(body.recentPurchases) ? body.recentPurchases : [];
  for (const rawRow of recent) {
    if (!rawRow || typeof rawRow !== 'object') continue;
    const row = rawRow as Record<string, unknown>;
    const planId = typeof row.planId === 'string' && (VIP_PLAN_IDS as readonly string[]).includes(row.planId)
      ? row.planId as VipPlanId
      : null;
    const stars = vipCount(row.stars);
    if (!planId || stars <= 0) continue;
    recentPurchases.push({
      userId: typeof row.userId === 'string' ? row.userId.slice(0, 64) : '',
      username: typeof row.username === 'string' ? row.username.slice(0, 40) : '',
      planId,
      stars,
      purchasedAt: vipCount(row.purchasedAt),
      expiresAt: vipCount(row.expiresAt),
    });
    if (recentPurchases.length >= 15) break;
  }

  return {
    totalSubscribers: vipCount(body.totalSubscribers),
    allTimePurchases: vipCount(body.allTimePurchases),
    totalStarsEarned: vipCount(body.totalStarsEarned),
    tierBreakdown: tiers,
    recentPurchases,
  };
}

async function fetchVipConfig(): Promise<VipPlanConfig | null> {
  const data = await parseJson<{ ok?: unknown; config?: unknown }>(
    await adminFetch('/api/admin/vip/config', { cache: 'no-store' }),
  );
  if (!data || data.ok !== true || !data.config) return null;
  return readVipPlanConfig(data.config);
}

async function fetchVipStats(): Promise<VipRevenueSummary | null> {
  const data = await parseJson<unknown>(await adminFetch('/api/admin/vip/stats', { cache: 'no-store' }));
  return readVipStats(data);
}

/** Save one tier. The Worker merges it onto the sheet, so the other two keep their prices. */
async function pushVipConfig(
  planId: VipPlanId,
  stars: number,
  enabled: boolean,
): Promise<{ config: VipPlanConfig | null; detail: string }> {
  const res = await postJson('/api/admin/vip/config', { planId, stars, enabled });
  if (!res) return { config: null, detail: 'The Worker did not answer.' };
  if (!res.ok) return { config: null, detail: await reasonOfResponse(res, 'POST /api/admin/vip/config') };
  const data = await parseJson<{ ok?: unknown; config?: unknown }>(res);
  if (!data || data.ok !== true || !data.config) {
    return { config: null, detail: 'The Worker sent no plan configuration.' };
  }
  return { config: readVipPlanConfig(data.config), detail: '' };
}

/* ---------- the Live Activity feed: the FAB's counter and its two card tiers ---------- */

/**
 * One incoming event. Both tiers are folded from readings the Command Center already trusts:
 * a New Member is a directory row's `firstSeen`, and a VIP purchase is a row from the Worker's
 * Stars ledger. Nothing here is seeded — an empty feed is an honest empty feed.
 */
export interface AdminActivityEvent {
  /** A stable dedupe key; the read watermark is a set of these, never a drifting timestamp. */
  id: string;
  kind: 'join' | 'vip';
  at: number;
  /** An LTR-isolated @handle (or #id when the player has no handle). */
  handle: string;
  /** VIP only: the plan's display name and the Stars paid. */
  plan?: string;
  stars?: number;
}

const ACTIVITY_KEY = 'detour.admin.events.v1';
/** The feed shows the newest dozen; the counter counts unread rows within that window. */
const ACTIVITY_MAX = 12;
/** A bounded watermark: old ids are dropped before the save grows without limit. */
const SEEN_MAX = 240;

function readSeenEvents(): Set<string> {
  const raw = readJson<string[]>(ACTIVITY_KEY);
  const list = Array.isArray(raw) ? raw : [];
  return new Set(
    list.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length < 160)
      .slice(-SEEN_MAX),
  );
}

/* ---------- the controller ---------- */

export interface AdminApi {
  /** The board's own toast (`showNote` in main.ts): the panel speaks in the game's voice. */
  note(msg: string, error: boolean, ttl: number): void;
  /** The stage opened or closed: the shell shows the Telegram BackButton while it is up. */
  onToggle(open: boolean): void;
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

/** One row of a custom select: a value, its printed label, and at most one leading visual. */
interface CustomSelectOption {
  value: string;
  label: string;
  /** Sprite glyph href for a leading icon (globe, bolt, brain...). */
  icon?: string;
  /** ISO alpha-2 for a leading circular flag. */
  flag?: string;
  /** Short code printed between the flag and the full name. */
  code?: string;
  /** Small pill printed in place of an icon (the age buckets). */
  chip?: string;
}

interface CustomSelectHandle {
  /** Repaint the selected checkmarks after the owning state changes. */
  refresh(): void;
  close(returnFocus?: boolean): void;
}

/** The one open menu across the toolbar pods: opening another closes this one first. */
let closeActiveMenu: (() => void) | null = null;

/**
 * A select-only listbox: a clay trigger and a floating menu. The menu is moved out to `host`
 * (the Admin stage), so the scrolling panel body can never clip it. It is then absolutely
 * positioned against the stage, flips above the trigger near the floor, follows scroll/resize,
 * and closes on outside press, Esc, Tab or blur.
 */
function makeCustomSelect(
  host: HTMLElement | null,
  cfg: {
    trigger: HTMLButtonElement;
    menu: HTMLElement;
    options: () => CustomSelectOption[];
    selected: () => string;
    onPick: (value: string) => void;
  },
): CustomSelectHandle {
  const { trigger, menu } = cfg;
  const root = trigger.closest<HTMLElement>('.adm-fn');
  let items: HTMLButtonElement[] = [];
  let open = false;
  let openFrame = 0;
  let moveFrame = 0;
  let hideTimer = 0;

  if (host && menu.parentElement !== host) host.append(menu);

  const closeSelf = (): void => close(false);

  function optionNode(opt: CustomSelectOption, index: number): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'custom-select-item';
    b.dataset.value = opt.value;
    b.id = `${menu.id}-opt-${index}`;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(opt.value === cfg.selected()));
    b.tabIndex = -1;

    if (opt.flag) {
      const flag = document.createElement('span');
      flag.className = 'custom-select-flag';
      flag.append(flagPhoto(opt.flag, ''));
      b.append(flag);
    } else if (opt.icon) {
      b.append(icon(opt.icon, 'custom-select-ico'));
    }
    if (opt.code) {
      const code = document.createElement('span');
      code.className = 'custom-select-code';
      code.textContent = opt.code;
      b.append(code);
    }
    if (opt.chip) {
      const chip = document.createElement('span');
      chip.className = 'custom-select-chip';
      chip.textContent = opt.chip;
      b.append(chip);
    }
    const label = document.createElement('span');
    label.className = 'custom-select-label';
    label.textContent = opt.label;
    b.append(label);

    const check = document.createElement('span');
    check.className = 'custom-select-check';
    check.setAttribute('aria-hidden', 'true');
    check.append(icon('#i-check', ''));
    b.append(check);
    return b;
  }

  function build(): void {
    items = cfg.options().map(optionNode);
    menu.textContent = '';
    menu.append(...items);
  }

  function focusItem(index: number): void {
    const item = items[index];
    if (!item) return;
    item.focus({ preventScroll: true });
    item.scrollIntoView({ block: 'nearest' });
  }

  function step(delta: number): void {
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = at < 0 ? (delta > 0 ? 0 : items.length - 1) : (at + delta + items.length) % items.length;
    focusItem(next);
  }

  /** Anchor under the trigger, clamped to the stage; flip above when the floor is nearer. */
  function position(): void {
    if (!host || !open) return;
    const sr = host.getBoundingClientRect();
    const tr = trigger.getBoundingClientRect();
    if (tr.bottom < sr.top || tr.top > sr.bottom) {
      close(false);
      return;
    }

    const edge = 8;
    const gap = 6;
    const width = Math.min(264, Math.max(0, sr.width - edge * 2));
    menu.style.width = `${width}px`;
    menu.style.maxHeight = '';

    const natural = menu.offsetHeight;
    const below = sr.bottom - tr.bottom - gap - edge;
    const above = tr.top - sr.top - gap - edge;
    let side: 'below' | 'above';
    if (below >= natural) side = 'below';
    else if (above >= natural) side = 'above';
    else side = above > below ? 'above' : 'below';

    const room = Math.max(0, side === 'below' ? below : above);
    const cap = Math.min(260, room);
    menu.style.maxHeight = `${cap}px`;
    const height = Math.min(natural, cap);

    const left = Math.min(Math.max(edge, tr.left - sr.left), Math.max(edge, sr.width - width - edge));
    const rawTop = side === 'below'
      ? tr.bottom - sr.top + gap
      : tr.top - sr.top - gap - height;
    const top = Math.min(Math.max(edge, rawTop), Math.max(edge, sr.height - height - edge));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.dataset.flip = String(side === 'above');
  }

  function onViewportChange(): void {
    if (!open) return;
    cancelAnimationFrame(moveFrame);
    moveFrame = requestAnimationFrame(position);
  }

  function onPointerDown(e: PointerEvent): void {
    const target = e.target as Node | null;
    if (target && (menu.contains(target) || trigger.contains(target))) return;
    close(false);
  }

  function onBlur(): void {
    close(false);
  }

  function close(returnFocus = false): void {
    if (!open) return;
    open = false;
    if (closeActiveMenu === closeSelf) closeActiveMenu = null;
    menu.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    root?.removeAttribute('data-open');
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('blur', onBlur);
    cancelAnimationFrame(openFrame);
    cancelAnimationFrame(moveFrame);
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (!open) menu.hidden = true;
    }, motionReduced() ? 0 : 150);
    if (returnFocus) trigger.focus({ preventScroll: true });
  }

  function openMenu(end?: 'last'): void {
    if (open) return;
    closeActiveMenu?.();
    open = true;
    closeActiveMenu = closeSelf;
    window.clearTimeout(hideTimer);
    build();
    menu.hidden = false;
    menu.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    root?.setAttribute('data-open', 'true');
    position();
    const selected = items.findIndex((item) => item.dataset.value === cfg.selected());
    focusItem(end === 'last' ? items.length - 1 : Math.max(0, selected));
    openFrame = requestAnimationFrame(() => {
      if (open) menu.classList.add('is-open');
    });
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('blur', onBlur);
  }

  function choose(value: string): void {
    const changed = value !== cfg.selected();
    close(true);
    if (changed) cfg.onPick(value);
  }

  menu.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLButtonElement>('.custom-select-item');
    if (!item || !menu.contains(item)) return;
    choose(item.dataset.value ?? '');
  });

  menu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusItem(items.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const active = document.activeElement as HTMLElement | null;
      if (active && menu.contains(active)) active.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      /* tab out of the listbox, not through 250 hidden options: continue from the trigger */
      close(true);
    }
  });

  trigger.addEventListener('click', () => {
    if (open) close(true);
    else openMenu();
  });

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openMenu();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu('last');
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      close(true);
    }
  });

  return {
    refresh(): void {
      if (!open) return;
      for (const item of items) {
        item.setAttribute('aria-selected', String(item.dataset.value === cfg.selected()));
      }
    },
    close,
  };
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

export function createAdmin(api: AdminApi): Admin {
  const fab = $<HTMLButtonElement>('btn-admin-fab');
  const stage = $<HTMLElement>('overlay-admin');
  const home = $<HTMLElement>('s-home');
  /* the Profile tab's own door to the stage, so the Command Center is reachable off Home too */
  const profileSec = $<HTMLElement>('pf-admin-sec');
  const profileBtn = $<HTMLButtonElement>('pf-admin');
  const closeBtn = $<HTMLButtonElement>('admin-close');
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-atab]')];
  const panels = [...document.querySelectorAll<HTMLElement>('[data-apanel]')];
  const ctrlTabs = [...(stage?.querySelectorAll<HTMLButtonElement>('[data-ctrl-tab]') ?? [])];
  const ctrlViews = [...(stage?.querySelectorAll<HTMLElement>('[data-ctrl-view]') ?? [])];
  /* every lookup below is scoped to the stage: the game-mode drawer carries its own
     `data-step` ball counters, and a bare `[data-step]` would drag them in with it */
  const stepBtns = [...(stage?.querySelectorAll<HTMLButtonElement>('[data-step] [data-dir]') ?? [])];
  const stepRows = [...(stage?.querySelectorAll<HTMLElement>('[data-step]') ?? [])];
  const coinsNow = $<HTMLElement>('tool-coins-now');
  const tiqNow = $<HTMLElement>('tool-tiq-now');
  const resetBtn = $<HTMLButtonElement>('tool-reset');
  const serverPanel = stage?.querySelector<HTMLElement>('[data-apanel="server"]') ?? null;
  const serverCard = $<HTMLElement>('adm-server');
  const serverChip = $<HTMLElement>('adm-server-chip');
  const serverState = $<HTMLElement>('srv-state');
  const serverStateSub = $<HTMLElement>('srv-state-sub');
  const serverPing = $<HTMLElement>('srv-ping');
  const serverQueue = $<HTMLElement>('srv-queue');
  const serverRooms = $<HTMLElement>('srv-rooms');
  const serverTotalRooms = $<HTMLElement>('srv-total-rooms');
  const serverLobbies = $<HTMLElement>('srv-lobbies');
  const serverList = $<HTMLElement>('srv-list');
  const serverRefresh = $<HTMLButtonElement>('srv-refresh');
  const serverRefreshLabel = $<HTMLElement>('srv-refresh-label');
  const serverClear = $<HTMLButtonElement>('srv-clear');
  const serverMaintenance = $<HTMLButtonElement>('srv-maintenance');
  const serverMaintState = $<HTMLElement>('srv-maintenance-state');
  const serverOffline = $<HTMLElement>('srv-offline');
  const serverMeta = $<HTMLElement>('srv-meta');
  /* Arena & tournament board */
  const arenaRoot = $<HTMLElement>('adm-arena');
  const seasonRoot = $<HTMLElement>('adm-season');
  const arenaHeadChip = $<HTMLElement>('arena-head-chip');
  const arenaStateSub = $<HTMLElement>('arena-state-sub');
  const arenaStateKeys = [...(stage?.querySelectorAll<HTMLButtonElement>('[data-arena-state]') ?? [])];
  const arenaLockBtn = stage?.querySelector<HTMLButtonElement>('[data-arena-lock]') ?? null;
  const arenaSeasonName = $<HTMLInputElement>('arena-season-name');
  const arenaSeasonChip = $<HTMLElement>('arena-season-chip');
  const arenaDivInputs = [...(stage?.querySelectorAll<HTMLInputElement>('[data-div-min]') ?? [])];
  const arenaCount = $<HTMLElement>('arena-count');
  const arenaClockZone = $<HTMLElement>('arena-clock-zone');
  const arenaPresets = [...(stage?.querySelectorAll<HTMLButtonElement>('[data-preset]') ?? [])];
  const arenaEnds = $<HTMLInputElement>('arena-ends');
  const arenaEndsApply = $<HTMLButtonElement>('arena-ends-apply');
  const arenaPvPill = $<HTMLElement>('arena-pv-pill');
  const arenaPvKicker = $<HTMLElement>('arena-pv-kicker');
  const arenaPvValue = $<HTMLElement>('arena-pv-value');
  const arenaPvSeason = $<HTMLElement>('arena-pv-season');
  const arenaPvNote = $<HTMLElement>('arena-pv-note');
  const arenaSnapCard = $<HTMLElement>('arena-snap-card');
  const arenaSnapMeta = $<HTMLElement>('arena-snap-meta');
  const arenaSnapList = $<HTMLElement>('arena-snap-list');
  const arenaAwardsMeta = $<HTMLElement>('arena-awards-meta');
  const arenaResetBtn = $<HTMLButtonElement>('arena-reset');
  const arenaStopBtn = $<HTMLButtonElement>('arena-stop');
  /* the Stats dashboard: the strict live reading from `GET /api/admin/metrics` */
  const statsPanel = stage?.querySelector<HTMLElement>('[data-apanel="stats"]') ?? null;
  const statActive = $<HTMLElement>('stat-active');
  const statLiveRooms = $<HTMLElement>('stat-live-rooms');
  const statLiveDot = $<HTMLElement>('stat-live-dot');
  const statDau = $<HTMLElement>('stat-dau');
  const statMau = $<HTMLElement>('stat-mau');
  const statNewToday = $<HTMLElement>('stat-new-today');
  const statNewWeek = $<HTMLElement>('stat-new-week');
  const statNewMonth = $<HTMLElement>('stat-new-month');
  const statReturning = $<HTMLElement>('stat-returning');
  const statReturningPct = $<HTMLElement>('stat-returning-pct');
  const statD1 = $<HTMLElement>('stat-d1');
  const statD1Bar = $<HTMLElement>('stat-d1-bar');
  const statD1Fill = $<HTMLElement>('stat-d1-fill');
  const statGrowthMeta = $<HTMLElement>('stat-growth-meta');
  /* the trend chart: the Worker's bounded growth rings, drawn as native inline SVG */
  const statTrendMetricTitle = $<HTMLElement>('stat-trend-metric');
  const statTrendMetricRange = $<HTMLElement>('stat-trend-metric-range');
  const statTrendWindow = $<HTMLElement>('stat-trend-window');
  const statTrendKeys = [...(stage?.querySelectorAll<HTMLButtonElement>('[data-grange]') ?? [])];
  const statTrendSeries = [...(stage?.querySelectorAll<HTMLButtonElement>('[data-gseries]') ?? [])];
  const statTrendModes = [...(stage?.querySelectorAll<HTMLButtonElement>('[data-gmode]') ?? [])];
  const statTrendSvg = document.getElementById('stat-trend-svg') as unknown as SVGSVGElement | null;
  const statTrendRead = $<HTMLElement>('stat-trend-read');
  const statTrendEmpty = $<HTMLElement>('stat-trend-empty');
  /* the slab carries `data-mode` and `data-metric`, so the plot, the pods and the inspector
     all read one shared state, and the grid can close to two columns without a class per chip */
  const statTrendSlab = statTrendRead?.closest<HTMLElement>('.adm-trend') ?? null;
  const statTrendTs = $<HTMLElement>('stat-trend-ts');
  const statTrendTok = $<HTMLElement>('stat-trend-tok');
  const statCore = $<HTMLElement>('stat-core');
  const statCoreBar = $<HTMLElement>('stat-core-bar');
  const statCoreFill = $<HTMLElement>('stat-core-fill');
  const statLat = $<HTMLElement>('stat-lat');
  const statEnv = $<HTMLElement>('stat-env');
  const statConn = $<HTMLElement>('stat-conn');
  const statUpdated = $<HTMLElement>('stat-updated');
  const statRefresh = $<HTMLButtonElement>('stat-refresh');
  const statAlert = $<HTMLElement>('stat-alert');
  const statAlertIco = $<HTMLElement>('stat-alert-ico');
  const statAlertTitle = $<HTMLElement>('stat-alert-title');
  const statAlertBody = $<HTMLElement>('stat-alert-body');
  /* the VIP storefront: the revenue chips, the plan sheet and the receipts audit */
  const vipKpiActive = $<HTMLElement>('vip-kpi-active');
  const vipKpiStars = $<HTMLElement>('vip-kpi-stars');
  const vipKpiOrders = $<HTMLElement>('vip-kpi-orders');
  const vipAdminState = $<HTMLElement>('vip-admin-state');
  const vipRecentBody = $<HTMLElement>('vip-recent-body');
  const vipRecentEmpty = $<HTMLElement>('vip-recent-empty');
  const vipRecentMeta = $<HTMLElement>('vip-recent-meta');
  const vipPlanRows = [...(stage?.querySelectorAll<HTMLElement>('[data-vip-plan]') ?? [])];
  /* the mandatory channel gate: the switch, the channel and its live pill */
  const fjToggle = $<HTMLButtonElement>('fjadm-toggle');
  const fjChannel = $<HTMLInputElement>('fjadm-channel');
  const fjPill = $<HTMLElement>('fjadm-pill');
  const fjPillLabel = fjPill?.querySelector<HTMLElement>('span') ?? null;
  const fjState = $<HTMLElement>('fjadm-state');
  const fjNote = $<HTMLElement>('fjadm-note');
  const fjSave = $<HTMLButtonElement>('fjadm-save');
  const navPill = $<HTMLElement>('admin-nav-pill');
  const inboxBadge = $<HTMLElement>('admin-inbox-badge');
  const inboxList = $<HTMLElement>('adm-inbox-list');
  const inboxEmpty = $<HTMLElement>('adm-inbox-empty');
  const inboxChips = [...document.querySelectorAll<HTMLButtonElement>('[data-ifilter]')];
  /* the live activity hub: the Home key's counter, and the feed at the head of the Inbox */
  const fabBadge = $<HTMLElement>('admin-fab-badge');
  const inboxPanel = stage?.querySelector<HTMLElement>('[data-apanel="inbox"]') ?? null;
  const activityHead = $<HTMLElement>('admin-activity-h');
  const activityLive = $<HTMLElement>('admin-events-live-t');
  const activityUnread = $<HTMLElement>('admin-events-unread');
  const activityFeed = $<HTMLElement>('admin-event-feed');
  const activityEmpty = $<HTMLElement>('admin-events-empty');
  const usersList = $<HTMLElement>('adm-users-list');
  const usersEmpty = $<HTMLElement>('adm-users-empty');
  const usersTotalEl = $<HTMLElement>('users-total');
  const usersSourceEl = $<HTMLElement>('users-source');
  const usersRefresh = $<HTMLButtonElement>('users-refresh');
  const usersPrune = $<HTMLButtonElement>('users-prune');
  const usersMore = $<HTMLButtonElement>('users-more');
  const usersQ = $<HTMLInputElement>('users-q');
  const usersQClear = $<HTMLButtonElement>('users-q-clear');
  const userChips = [...document.querySelectorAll<HTMLButtonElement>('[data-ufilter]')];
  const usersVipChip = $<HTMLButtonElement>('users-vip-chip');
  const usersPlanEl = $<HTMLSelectElement>('adm-filter-plan');
  const usersPlanV = $<HTMLElement>('adm-filter-plan-v');
  const usersCountryTrig = $<HTMLButtonElement>('users-country-trigger');
  const usersAgeTrig = $<HTMLButtonElement>('users-age-trigger');
  const usersSortTrig = $<HTMLButtonElement>('users-sort-trigger');
  const usersCountryMenu = $<HTMLElement>('users-country-menu');
  const usersAgeMenu = $<HTMLElement>('users-age-menu');
  const usersSortMenu = $<HTMLElement>('users-sort-menu');
  const usersCountryFlag = $<HTMLElement>('users-country-flag');
  const usersCountryV = $<HTMLElement>('users-country-v');
  const usersAgeV = $<HTMLElement>('users-age-v');
  const usersSortV = $<HTMLElement>('users-sort-v');
  const usersReset = $<HTMLButtonElement>('users-reset');
  const usersAdvPods = [...document.querySelectorAll<HTMLElement>('[data-uadv]')];
  let usersCountrySelect: CustomSelectHandle | null = null;
  let usersAgeSelect: CustomSelectHandle | null = null;
  let usersSortSelect: CustomSelectHandle | null = null;
  /* Squads: the registry KPI pulse, the real-time filter bar and the audit cards */
  const squadsPanel = stage?.querySelector<HTMLElement>('[data-apanel="squads"]') ?? null;
  const squadsList = $<HTMLElement>('adm-squads-list');
  const squadsEmpty = $<HTMLElement>('adm-squads-empty');
  const squadsTotalEl = $<HTMLElement>('squads-total');
  const squadsSourceEl = $<HTMLElement>('squads-source');
  const squadsRefresh = $<HTMLButtonElement>('squads-refresh');
  const squadsQ = $<HTMLInputElement>('squads-q');
  const squadsQClear = $<HTMLButtonElement>('squads-q-clear');
  const squadsReset = $<HTMLButtonElement>('squads-reset');
  const squadTypeChips = [...document.querySelectorAll<HTMLButtonElement>('[data-sqtype]')];
  const squadStatusChips = [...document.querySelectorAll<HTMLButtonElement>('[data-sqstatus]')];
  const squadKpiTotal = $<HTMLElement>('squad-kpi-total');
  const squadKpiTotalSub = $<HTMLElement>('squad-kpi-total-sub');
  const squadKpiTypes = $<HTMLElement>('squad-kpi-types');
  const squadKpiTypesSub = $<HTMLElement>('squad-kpi-types-sub');
  const squadKpiVerified = $<HTMLElement>('squad-kpi-verified');
  const squadKpiVerifiedSub = $<HTMLElement>('squad-kpi-verified-sub');
  const squadKpiMembers = $<HTMLElement>('squad-kpi-members');
  const squadKpiMembersSub = $<HTMLElement>('squad-kpi-members-sub');
  const squadsRealFilter = $<HTMLSelectElement>('squads-real-filter');
  const squadsRealV = $<HTMLElement>('squads-real-v');
  const squadsRealPod = document.querySelector<HTMLElement>('[data-sqadv="real"]');
  const squadsGameFilter = $<HTMLSelectElement>('squads-game-filter');
  const squadsGameV = $<HTMLElement>('squads-game-v');
  const squadsGamePod = document.querySelector<HTMLElement>('[data-sqadv="game"]');
  /* The Stars Vault payout queue: four KPIs, the request list, and the collusion review slab */
  const vaultList = $<HTMLElement>('adm-vault-list');
  const vaultEmpty = $<HTMLElement>('adm-vault-empty');
  const vaultFlags = $<HTMLElement>('adm-vault-flags');
  const vaultFlagEmpty = $<HTMLElement>('vault-flag-empty');
  const vaultFlagMeta = $<HTMLElement>('vault-flag-meta');
  const vaultTotalEl = $<HTMLElement>('vault-total');
  const vaultSourceEl = $<HTMLElement>('vault-source');
  const vaultRefresh = $<HTMLButtonElement>('vault-refresh');
  const vaultMonthEl = $<HTMLElement>('vaultadm-month');
  const vaultChips = [...document.querySelectorAll<HTMLButtonElement>('[data-vfilter]')];
  const vaultKpiEarned = $<HTMLElement>('vault-kpi-earned');
  const vaultKpiEarnedSub = $<HTMLElement>('vault-kpi-earned-sub');
  const vaultKpiPaid = $<HTMLElement>('vault-kpi-paid');
  const vaultKpiPaidSub = $<HTMLElement>('vault-kpi-paid-sub');
  const vaultKpiWaiting = $<HTMLElement>('vault-kpi-waiting');
  const vaultKpiWaitingSub = $<HTMLElement>('vault-kpi-waiting-sub');
  const vaultKpiBudget = $<HTMLElement>('vault-kpi-budget');
  const vaultKpiBudgetSub = $<HTMLElement>('vault-kpi-budget-sub');
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
  /** True once the matchmaking telemetry door has answered: the panel is governing a real room. */
  let serverOn = false;
  /** The registry refused this session: telemetry is gated, but the Worker is not offline. */
  let serverDenied = false;
  /** Whatever the Server door last said when it did not answer with a room: shown, never guessed. */
  let serverDetail = '';
  /** The last reading got no answer at all — the one case that may be painted OFFLINE. */
  let serverUnreachable = false;
  /** The last reading of the room, so the Server tab can paint before the next fetch lands. */
  let lastStatus: ServerStatus | null = null;
  /** The last measured round trip to the Worker, in ms. */
  let serverPingMs: number | null = null;
  /** One telemetry read at a time: the manual key and the live beat share this flag. */
  let serverBusy = false;
  /** The Server tab's live beat, alive only while the stage is open. */
  let serverTimer = 0;
  /** What the Worker was last told, so an unchanged toggle never sends a pointless call. */
  let lastPushed: ServerConfig | null = null;
  /** The Inbox view: which filter chip is lit, and which card is expanded. */
  let inboxFilter = 'all';
  let openTicket = '';
  /* Live Activity: two real sources, one folded feed, and one persisted read watermark. */
  let activityPlayers: DirPlayer[] = [];
  let activityPurchases: readonly VipPurchase[] = [];
  let activityEvents: AdminActivityEvent[] = [];
  const seenEvents = readSeenEvents();
  /** The last open of this stage: a row stamped at or before it was already in front of the
   *  operator, so the counter must not come back wearing it. Persisted, never reset on close. */
  let viewedAt = adminViewedAt();
  /**
   * The live telemetry: the last completed reading, the latest attempt's verdict, and the slow
   * beat that keeps the Stats tab honest while it is open. `lastMetrics` is only ever a payload
   * the Worker actually answered — a refusal clears it rather than leaving a comfortable memory.
   */
  let lastMetrics: ServerMetrics | null = null;
  let metricsPhase: 'idle' | 'ok' | 'unauthorized' | 'error' = 'idle';
  /** Why the last metrics attempt failed, in the Worker's own words where it had any. */
  let metricsDetail = '';
  /** And which kind of failure that was, so the lamp never has to guess between slow and gone. */
  let metricsReason: FailureReason = 'offline';
  let metricsBusy = false;
  /** A read asked for while one was already in flight: the filter moved, so run it once after. */
  let metricsQueued = false;
  let metricsTimer = 0;
  /** Text typed into a reply box survives the list being rebuilt for any reason. */
  const drafts = new Map<string, string>();

  /** The Users view: the filter chip, the search text, the rows held, and the open card. */
  let usersFilter: DirFilter = 'all';
  let usersQuery = '';
  let usersCountry = '';
  let usersAge: AgeBand = 'all';
  let usersPlan: VipPlanFilter = 'all';
  let usersSort: DirSort = 'default';
  let usersRows: DirPlayer[] = [];
  /**
   * "Last played" re-applied on this side too: the list on screen is always in the order the
   * operator picked, even when the Worker behind the page is an older build. The key is the same
   * activity stamp the card prints — the freshest of a sighting and a settled race.
   */
  const orderByActivity = (rows: DirPlayer[]): DirPlayer[] => [...rows].sort((a, b) =>
    Math.max(b.lastSeen, b.lastPlayed) - Math.max(a.lastSeen, a.lastPlayed)
    || b.lastSeen - a.lastSeen || a.id.localeCompare(b.id));
  let usersTotal = 0;
  /** True once `/admin/players` has answered this session: the panel is governing a real registry. */
  let usersOn = false;
  /** The Worker has been asked at least once; after a refusal every filter stays on the device's own directory. */
  let usersProbed = false;
  /** The tab has been opened at least once — the directory is read lazily, on first sight. */
  let usersAsked = false;
  /** At least one read has landed: before that the panel shows "—" rather than a false empty state. */
  let usersReady = false;
  /** The newest read is the only one allowed to paint: typing fires reads faster than they land. */
  let usersSeq = 0;
  /** Reads in flight: the refresh key spins while any one of them is still out. */
  let usersPending = 0;
  let usersTimer = 0;
  let usersAdvTimer = 0;
  let openPlayer = '';

  /** The Squads view: the registry read, the two filter axes, the search, and the last answer. */
  let squadsRows: SquadRow[] = [];
  let squadsTotals: SquadTotals | null = null;
  let squadsType: 'all' | SquadChatKind = 'all';
  let squadsStatus: 'all' | SquadVerification = 'all';
  let squadsReal: SquadRealBand = 'all';
  let squadsGame: SquadGameBand = 'all';
  let squadsQuery = '';
  let openSquad = '';
  let squadsOn = false;
  let squadsReady = false;
  let squadsBusy = false;

  /** The Stars Vault: the last ledger a read answered, the status filter, and whether work is out. */
  let vaultPage: VaultPage | null = null;
  let vaultFilter: VaultFilter = 'waiting';
  let vaultOn = false;
  let vaultReady = false;
  let vaultBusy = false;

  /** The VIP storefront: the last sheet and ledger a read answered, and whether work is out. */
  let vipConfig: VipPlanConfig = readVipPlanConfig(null);
  let vipStats: VipRevenueSummary | null = null;
  let vipLoading = false;
  let vipBusy = false;
  /** The newest read is the only one allowed to paint over a save that landed after it left. */
  let vipSeq = 0;

  /** The mandatory channel gate: the last row the Worker answered, and the edit in flight. */
  let forceJoin: ForceJoinConfig = { forceJoinEnabled: false, targetChannel: '', channelUrl: '' };
  let forceJoinLoaded = false;
  let forceJoinFailed = false;
  let forceJoinBusy = false;
  let forceJoinDirty = false;

  /** The Access Control view: the registry read, and whether this viewer may change it. */
  let aclRows: AdminRow[] = [];
  let aclOn = false;
  let aclCan = false;
  let aclAsked = false;
  let aclRole: AdminRole = 'moderator';
  let aclTimer = 0;
  /** The arena clock ticks only while the stage is up, and one mutation is in flight at a time. */
  let arenaTimer = 0;
  let arenaBusy = false;
  /** Every arena edit gets a ticket: an older reply never walks a newer edit backwards. */
  let arenaSeq = 0;
  /** What the confirm dialog's destructive key will run, when it is up. */
  let pendingConfirm: (() => void) | null = null;
  /** One close timer per drawer, so a reopen mid-fade never strands a hidden panel. */
  const drawerTimers = new Map<HTMLElement, number>();

  /* ---------- painting ---------- */

  function paintSteps() {
    for (const row of stepRows) {
      const k = KNOBS[row.dataset.step ?? ''];
      if (!k) continue;
      const out = row.querySelector<HTMLElement>('[data-val]');
      if (out) out.textContent = k.label(k.get());
    }
  }

  function paintSave() {
    if (coinsNow) setBalance(coinsNow, profile.coins);
    if (tiqNow) {
      /* the ladder's own counters: machine-held boards are already taken back out */
      const tally = ladderTally();
      tiqNow.textContent = String(tiqFrom(tally.wins, tally.games, profile.tiqBonus));
    }
  }

  /* ---------- Arena & tournament ---------- */

  const ARENA_STATE_COPY: Record<ArenaStatus, string> = {
    active: 'Open · new matches queue',
    maintenance: 'Locked · queue dismissed',
    finale: 'Finale · standings frozen',
  };

  /** The beacon, chip and subtitle; also called by the tick so an expiring clock flips live. */
  function paintArenaStatus(a: ArenaState) {
    const expired = a.status === 'active' && a.endsAt <= Date.now();
    const locked = arenaLocked(a);
    for (const root of [arenaRoot, seasonRoot]) {
      if (!root) continue;
      root.dataset.state = expired ? 'finale' : a.status;
      root.dataset.lock = String(a.matchLocked);
    }
    if (arenaHeadChip) {
      arenaHeadChip.textContent = expired
        ? 'CLOSED'
        : locked
          ? a.status === 'finale' ? 'FINALE' : 'LOCKED'
          : 'OPEN';
      arenaHeadChip.dataset.on = String(!locked);
    }
    if (arenaStateSub) {
      arenaStateSub.textContent = expired
        ? 'Season closed · reset or extend'
        : a.matchLocked && a.status === 'active'
          ? 'Open · matchmaking locked'
          : ARENA_STATE_COPY[a.status];
    }
  }

  /** The instrument and the player capsule, both off the same tick. */
  function paintArenaClock(now = Date.now()) {
    const a = arena();
    paintArenaStatus(a);
    if (arenaCount) arenaCount.textContent = fullCountdown(a, now);
    if (!arenaPvPill) return;
    const pill = countdownPill(a, now);
    arenaPvPill.dataset.tone = pill.tone;
    arenaPvPill.title = `${seasonLabel(a)} — ${pill.exact}`;
    if (arenaPvKicker) arenaPvKicker.textContent = pill.kicker;
    if (arenaPvValue) arenaPvValue.textContent = pill.value;
    if (arenaPvSeason) arenaPvSeason.textContent = seasonLabel(a);
    if (arenaPvNote) {
      arenaPvNote.textContent = a.status === 'maintenance'
        ? 'Locked tone: players see the capsule in crimson. Live races still resolve.'
        : a.status === 'finale'
          ? 'Finale tone: the ladder is locked and the capsule reads final.'
          : pill.tone === 'ending'
            ? 'Closing-in tone: under 48 hours the capsule counts hours and minutes.'
            : 'What players see on the Mind Ladder right now.';
    }
  }

  function paintArenaSnapshot(snap: ArenaSnapshot | null) {
    if (arenaSnapCard) arenaSnapCard.hidden = !snap;
    if (arenaSnapList) arenaSnapList.textContent = '';
    if (!snap) return;
    if (arenaSnapMeta) {
      const when = new Date(snap.takenAt).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      arenaSnapMeta.textContent = `S${snap.seasonNo} · ${snap.total.toLocaleString('en-US')} ranked · ${when}`;
    }
    if (!arenaSnapList) return;
    for (const row of snap.entries.slice(0, 5)) {
      const li = document.createElement('li');
      li.className = 'adm-snap-row';
      const rank = document.createElement('b');
      rank.className = 'adm-snap-rank';
      rank.textContent = `#${row.rank}`;
      const name = document.createElement('span');
      name.className = 'adm-snap-name';
      name.textContent = row.name;
      const tiq = document.createElement('b');
      tiq.className = 'adm-snap-tiq';
      tiq.textContent = row.tiq.toLocaleString('en-US');
      li.title = `${row.name} · ${row.wins.toLocaleString('en-US')} wins`;
      li.append(rank, name, tiq);
      arenaSnapList.append(li);
    }
  }

  function paintArena() {
    const a = arena();
    paintArenaStatus(a);
    for (const key of arenaStateKeys) {
      key.setAttribute('aria-checked', String(key.dataset.arenaState === a.status));
    }
    arenaLockBtn?.setAttribute('aria-checked', String(a.matchLocked));
    if (arenaSeasonName && document.activeElement !== arenaSeasonName) arenaSeasonName.value = a.seasonName;
    if (arenaSeasonChip) arenaSeasonChip.textContent = `Season ${a.seasonNo}`;
    for (const input of arenaDivInputs) {
      const row = a.divisions.find((d) => d.id === input.dataset.divMin);
      if (row && document.activeElement !== input) input.value = String(row.min);
    }
    if (arenaEnds && document.activeElement !== arenaEnds) arenaEnds.value = datetimeLocalValue(a.endsAt);
    if (arenaClockZone) {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time';
      arenaClockZone.textContent = `${zone} · local`;
    }
    if (arenaAwardsMeta) {
      arenaAwardsMeta.textContent = a.awardsCount
        ? `${a.awardsCount.toLocaleString('en-US')} awards pushed`
        : 'No prizes pushed';
    }
    paintArenaClock();
    paintArenaSnapshot(a.lastSnapshot);
  }

  function startArenaClock() {
    stopArenaClock();
    paintArenaClock();
    arenaTimer = window.setInterval(() => {
      if (open) paintArenaClock();
    }, 1000);
  }

  function stopArenaClock() {
    if (!arenaTimer) return;
    window.clearInterval(arenaTimer);
    arenaTimer = 0;
  }

  function paintAll() {
    paintSteps();
    paintSave();
    paintArena();
    paintStats();
    paintInbox();
    paintActivity();
    paintUsers();
    paintSquads();
    paintVault();
    paintVipAdmin();
    paintAcl();
  }

  /* ---------- the Stats tab ---------- */

  /** The figure the executive grid prints: grouped, never a raw run of digits. */
  const figure = (n: number): string => Math.max(0, Math.round(n)).toLocaleString('en-US');

  /** A server-computed percentage, printed as a whole number. */
  const rateText = (n: number): string => `${Math.max(0, Math.min(100, Math.round(n)))}%`;

  /** `14:05:22` — the exact clock of a reading, in this device's timezone. */
  const clockOf = (ms: number): string => new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });

  /* ---------- the trend chart: one bounded window, one series at a time, plain inline SVG ---------- */

  /** The windows the switch selects; each maps to its own ready-to-plot array from the Worker. */
  type TrendRange = '24h' | '7d' | '30d';

  /** The one series the plot draws; the pods are the switch that picks it. */
  type TrendSeries = 'active' | 'signups' | 'matches';

  /**
   * The slices the filter can actually ask for. `MatchModeFilter` also carries `arena`, but the
   * cup has no segment on this card any more: narrowing the type here means no code path can
   * start an arena read from the chart, whatever the markup says.
   */
  type TrendMode = Exclude<MatchModeFilter, 'arena'>;

  const TREND_W = 320;
  const TREND_H = 154;
  const TREND_PAD = { l: 28, r: 8, t: 10, b: 20 };
  const TREND_IW = TREND_W - TREND_PAD.l - TREND_PAD.r;
  const TREND_IH = TREND_H - TREND_PAD.t - TREND_PAD.b;
  /** The zero line: every series is a count, so nothing is ever drawn below it. */
  const TREND_BASE = TREND_PAD.t + TREND_IH;

  /**
   * The chart reads in Tehran time (UTC+3:30), the operator's own clock, rather than the UTC days
   * the Worker keys its buckets by. One zone-aware formatter is built once and reused: the
   * inspector repaints on every pointer move, and building an `Intl` object per frame is a real
   * cost on a phone.
   */
  const TREND_ZONE = 'Asia/Tehran';
  /** The suffix the inspector prints after a timestamp, instead of the old hardcoded `UTC`. */
  const TREND_ZONE_LABEL = 'Tehran';

  const trendZoneFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TREND_ZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  /** Every field of `ms` exactly as `Asia/Tehran` reads it, keyed by part type, in one pass. */
  function trendZoneParts(ms: number): Map<string, string> {
    const out = new Map<string, string>();
    for (const part of trendZoneFmt.formatToParts(new Date(ms))) out.set(part.type, part.value);
    return out;
  }

  /**
   * `Fri Oct 9` — the Tehran day a daily bucket opens on. The pieces are joined by hand so the
   * readout never inherits whatever punctuation an engine's `en-US` pattern happens to carry.
   */
  function trendDayLabel(ms: number): string {
    const parts = trendZoneParts(ms);
    return `${parts.get('weekday') ?? ''} ${parts.get('month') ?? ''} ${parts.get('day') ?? ''}`.trim();
  }

  /** `14:05` — the Tehran wall clock of an instant, minutes included, from one parsed stamp. */
  const trendClockOf = (parts: Map<string, string>): string =>
    `${parts.get('hour') ?? '00'}:${parts.get('minute') ?? '00'}`;

  /**
   * `Fri 14:05` — the Tehran instant an hourly bucket opens on. The minutes are read off the
   * stamp, never assumed: the Worker keys its buckets to UTC hours, and Tehran runs at +03:30, so
   * every real bucket edge lands on `:30`. Printing a hardcoded `:00` silently shifted the whole
   * axis half an hour behind the data it was labelling.
   */
  function trendTimeLabel(ms: number): string {
    const parts = trendZoneParts(ms);
    return `${parts.get('weekday') ?? ''} ${trendClockOf(parts)}`.trim();
  }

  /** `Fri 14:05 – 15:05` — the bucket's own span, for the tooltip rather than the narrow pill. */
  function trendTimeSpan(ms: number, spanMs: number): string {
    return `${trendTimeLabel(ms)} – ${trendClockOf(trendZoneParts(ms + spanMs))}`;
  }

  const TREND_WINDOW: Record<TrendRange, string> = {
    '24h': 'Daily · last 24 hours',
    '7d': 'Weekly · last 7 days',
    '30d': 'Monthly · last 30 days',
  };

  /** The short name each series carries in the inspector. */
  const TREND_METRIC_LABEL: Record<TrendSeries, string> = {
    active: 'Active',
    signups: 'Signups',
    matches: 'Matches',
  };

  /** The headline for the whole board, where the series name alone says enough. */
  const TREND_METRIC_TITLE: Record<TrendSeries, string> = {
    active: 'Active Players',
    signups: 'New Signups',
    matches: 'Matches Played',
  };

  /**
   * The card headline: the one series actually on the canvas, of the one slice actually filtered.
   * A tagged slice names its own count — `PvP Matches`, `VS Bot Activity` — because the dual
   * `Signups & Active Players` it replaces was never true of a filtered reading.
   */
  const trendTitle = (mode: TrendMode, metric: TrendSeries): string => {
    if (mode === 'all') return TREND_METRIC_TITLE[metric];
    if (metric === 'active') return `${MATCH_MODE_LABEL[mode]} Activity`;
    return `${MATCH_MODE_LABEL[mode]} Matches`;
  };

  /** How wide one bucket is, so the inspector can name the span it actually covers. */
  const TREND_BUCKET_MS: Record<TrendRange, number> = {
    '24h': 3_600_000,
    '7d': 86_400_000,
    '30d': 86_400_000,
  };

  let trendRange: TrendRange = '24h';
  /** The match-type slice on screen: aggregate, the people, or the practice board. */
  let trendMode: TrendMode = 'all';
  /** The one series on the canvas: a pod click replaces the curve, it does not add a second one. */
  let trendMetric: TrendSeries = 'active';
  /** The bucket under the pointer, or -1 while nothing is being inspected. */
  let trendFocus = -1;
  /** The window actually on screen, kept so a pointer move can price it without a repaint. */
  let trendData: SeriesPoint[] = [];
  /** The Y ceiling that window was scaled to; the cursor layer has to agree with the line. */
  let trendCeil = 4;
  /** The three series, in the order the pods list them. */
  const TREND_SERIES_KEYS: TrendSeries[] = ['active', 'signups', 'matches'];

  /**
   * The series a slice can answer with. Signups is a global account event: the Worker folds it
   * from each player's `firstSeen`, never from a mode ring, so a `PvP` or `VS Bot` reading carries
   * the whole board's signup count. Those slices therefore have no signup series to show, and the
   * pod is taken away rather than labelled with a number that is not theirs.
   */
  const trendMetricsOf = (mode: TrendMode): TrendSeries[] =>
    mode === 'all' ? TREND_SERIES_KEYS : ['active', 'matches'];

  /** The series a pod carries, or null when the markup has drifted from this list. */
  const trendSeriesKey = (raw: string | undefined): TrendSeries | null =>
    raw === 'active' || raw === 'signups' || raw === 'matches' ? raw : null;

  /** Two decimals, no trailing zeroes: small numbers keep the SVG markup small. */
  const fx = (n: number): string => String(Math.round(n * 100) / 100);

  /**
   * A Y-axis label, abbreviated once it would no longer fit the left gutter. The gutter is a fixed
   * slice of a fixed viewBox, so a five-figure peak has to read `12k` rather than push the plot off
   * the canvas — the exact counts are on the legend chips and in the bucket readout.
   */
  const axisNum = (v: number): string => {
    const n = Math.max(0, Math.round(v));
    if (n < 1000) return String(n);
    if (n < 10_000) return `${Math.round(n / 100) / 10}k`;
    return `${Math.round(n / 1000)}k`;
  };

  /** The x of bucket `i` out of `n`, spread edge to edge across the plot band. */
  const trendX = (i: number, n: number): number =>
    TREND_PAD.l + (n <= 1 ? TREND_IW / 2 : (TREND_IW * i) / (n - 1));

  /** The y of a count against a ceiling. Clamped, so a line can never leave the plot band. */
  const trendY = (v: number, ceil: number): number =>
    TREND_BASE - (Math.max(0, Math.min(v, ceil)) / ceil) * TREND_IH;

  /**
   * A Y ceiling on a round number, so the peak / mid / zero labels are all whole counts. An empty
   * window still gets a short axis rather than a divide by zero.
   */
  function trendCeilOf(peak: number): number {
    if (peak <= 0) return 4;
    const mag = 10 ** Math.floor(Math.log10(peak));
    for (const step of [1, 2, 5, 10]) {
      const candidate = step * mag;
      if (candidate >= peak) return candidate % 2 === 0 ? candidate : candidate + 1;
    }
    return 10 * mag;
  }

  /**
   * A smooth cubic path through the plotted points: Catmull-Rom tangents flattened to Bezier
   * control points. Every control point is clamped back inside the band, because a lone spike
   * would otherwise bulge the curve past the axis it is drawn against.
   */
  function trendPath(pts: readonly { x: number; y: number }[]): string {
    if (pts.length === 0) return '';
    if (pts.length === 1) return `M${fx(pts[0].x)},${fx(pts[0].y)}`;
    let d = `M${fx(pts[0].x)},${fx(pts[0].y)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] ?? p2;
      const c1y = Math.min(TREND_BASE, Math.max(TREND_PAD.t, p1.y + (p2.y - p0.y) / 6));
      const c2y = Math.min(TREND_BASE, Math.max(TREND_PAD.t, p2.y - (p3.y - p1.y) / 6));
      d += `C${fx(p1.x + (p2.x - p0.x) / 6)},${fx(c1y)}`
        + ` ${fx(p2.x - (p3.x - p1.x) / 6)},${fx(c2y)}`
        + ` ${fx(p2.x)},${fx(p2.y)}`;
    }
    return d;
  }

  /** The same curve closed down onto the zero line: the soft fill under the plotted series. */
  function trendArea(pts: readonly { x: number; y: number }[]): string {
    const line = trendPath(pts);
    if (!line || pts.length < 2) return line;
    return `${line}L${fx(pts[pts.length - 1].x)},${fx(TREND_BASE)}`
      + `L${fx(pts[0].x)},${fx(TREND_BASE)}Z`;
  }

  /**
   * The X-axis ticks for the window on screen. The hourly window is labelled against the span
   * (`-24h .. Now`); the daily windows name the buckets themselves, on the Tehran calendar the
   * operator reads the plot against.
   */
  function trendTicks(points: readonly SeriesPoint[]): { x: number; text: string; anchor: string }[] {
    const n = points.length;
    const anchorAt = (k: number, count: number): string =>
      k === 0 ? 'start' : k === count - 1 ? 'end' : 'middle';
    if (trendRange === '24h') {
      const labels = ['-24h', '-18h', '-12h', '-6h', 'Now'];
      return labels.map((text, k) => ({
        x: TREND_PAD.l + (TREND_IW * k) / (labels.length - 1),
        text,
        anchor: anchorAt(k, labels.length),
      }));
    }
    if (n < 1) return [];
    const count = Math.max(2, Math.min(trendRange === '7d' ? 7 : 5, n));
    const out: { x: number; text: string; anchor: string }[] = [];
    for (let k = 0; k < count; k++) {
      const f = k / (count - 1);
      const ms = points[Math.min(n - 1, Math.round(f * (n - 1)))].t;
      const parts = trendZoneParts(ms);
      out.push({
        x: TREND_PAD.l + TREND_IW * f,
        text: trendRange === '7d'
          ? parts.get('weekday') ?? ''
          : `${parts.get('month') ?? ''} ${parts.get('day') ?? ''}`.trim(),
        anchor: anchorAt(k, count),
      });
    }
    return out;
  }

  /** The window's own array, or an empty one: a Worker that predates the series must not throw. */
  function trendPoints(m: ServerMetrics | null): SeriesPoint[] {
    if (!m || m.mode !== trendMode) return [];
    const list = trendRange === '24h' ? m.series24h : trendRange === '7d' ? m.series7d : m.series30d;
    if (!Array.isArray(list)) return [];
    /** A missing, null or non-finite count is a measured zero, never a reason to break the chart. */
    const countOf = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0;
    const points: SeriesPoint[] = [];
    for (const row of list as unknown[]) {
      if (!row || typeof row !== 'object') continue;
      const p = row as Partial<SeriesPoint>;
      if (typeof p.t !== 'number' || !Number.isFinite(p.t)) continue;
      points.push({
        t: p.t,
        signups: countOf(p.signups),
        active: countOf(p.active),
        matches: countOf(p.matches),
      });
    }
    return points;
  }

  /** What the empty plot says instead of a line: the reason there is nothing to draw. */
  function trendEmptyText(m: ServerMetrics | null): string {
    if (metricsPhase === 'unauthorized') return 'The metrics door refused this session — no trend to plot.';
    if (m && m.mode === trendMode) {
      return trendMode === 'all'
        ? 'The Worker reported no buckets for this window yet.'
        : `The Worker reported no ${MATCH_MODE_LABEL[trendMode]} buckets for this window yet.`;
    }
    if (metricsPhase === 'error') {
      return metricsReason === 'offline' || metricsReason === 'no-origin'
        ? 'The Worker never answered — no trend to plot.'
        : metricsReason === 'timeout'
          ? 'The Worker did not answer in time — no trend to plot.'
          : 'The Worker answered without a reading — no trend to plot.';
    }
    if (m) return `Reading the ${MATCH_MODE_LABEL[trendMode]} slice…`;
    return "Awaiting the Worker's first reading.";
  }

  /**
   * Draw the window: one slice, one series, one curve. The static half (grid, axes, line, dots) is
   * rebuilt only when the data, the range or the chosen series change; a pointer move repaints the
   * cursor layer on its own, so hovering a phone-width chart never re-renders the whole SVG.
   */
  function renderTrend() {
    if (!statTrendSvg) return;
    const m = lastMetrics;
    const points = trendPoints(m);
    trendData = points;

    const allowed = trendMetricsOf(trendMode);

    for (const key of statTrendKeys) {
      key.setAttribute('aria-pressed', String(key.dataset.grange === trendRange));
    }
    for (const chip of statTrendSeries) {
      const series = trendSeriesKey(chip.dataset.gseries);
      /* a pod this slice cannot fill is taken away, not dimmed: there is no number under it */
      chip.hidden = !series || !allowed.includes(series);
      chip.setAttribute('aria-pressed', String(series === trendMetric));
    }
    for (const key of statTrendModes) {
      key.setAttribute('aria-pressed', String(key.dataset.gmode === trendMode));
    }
    if (statTrendWindow) {
      statTrendWindow.textContent = trendMode === 'all'
        ? TREND_WINDOW[trendRange]
        : `${TREND_WINDOW[trendRange]} · ${MATCH_MODE_LABEL[trendMode]}`;
    }
    if (statTrendMetricTitle) statTrendMetricTitle.textContent = trendTitle(trendMode, trendMetric);
    if (statTrendMetricRange) statTrendMetricRange.textContent = trendRange.toUpperCase();
    if (statTrendSlab) {
      statTrendSlab.dataset.mode = trendMode;
      statTrendSlab.dataset.metric = trendMetric;
    }
    /* a bucket past the end of a shorter window is not on screen any more */
    if (trendFocus >= points.length) trendFocus = -1;

    const drawn = points.length > 0;
    if (statTrendEmpty) {
      /* An empty window still draws its zero baseline beneath this note; it is never a blank card. */
      statTrendEmpty.hidden = drawn;
      if (!drawn) statTrendEmpty.textContent = trendEmptyText(m);
    }
    statTrendSvg.classList.remove('is-blank');
    statTrendSvg.setAttribute('aria-label', drawn
      ? `${TREND_WINDOW[trendRange]}: ${trendTotalsText(points)}.`
      : trendEmptyText(m));

    const n = points.length;
    /* the domain is the one curve on screen and nothing else: two series sharing a ceiling used to
       leave the shorter one flat against its own baseline */
    let peak = 0;
    for (const p of points) peak = Math.max(peak, p[trendMetric]);
    trendCeil = trendCeilOf(peak);

    const pts = points.map((p, i) => ({ x: trendX(i, n), y: trendY(p[trendMetric], trendCeil) }));

    const yLabel = (v: number): string =>
      `<text class="adm-trend-y" x="${TREND_PAD.l - 5}" y="${fx(trendY(v, trendCeil) + 3)}"`
      + ` text-anchor="end">${axisNum(v)}</text>`;
    const gridLine = (v: number): string =>
      `<line x1="${TREND_PAD.l}" y1="${fx(trendY(v, trendCeil))}"`
      + ` x2="${fx(TREND_PAD.l + TREND_IW)}" y2="${fx(trendY(v, trendCeil))}" />`;

    /* the fill takes its hue from `--plot-tone`, which the slab sets from `data-metric`: one
       gradient in the markup, so the area can never disagree with the line it sits under */
    const parts: string[] = [
      '<defs>',
      '<linearGradient id="adm-trend-fill" x1="0" y1="0" x2="0" y2="1">',
      '<stop class="adm-trend-stop" offset="0%" stop-opacity=".20" />',
      '<stop class="adm-trend-stop" offset="46%" stop-opacity=".07" />',
      '<stop class="adm-trend-stop" offset="100%" stop-opacity="0" />',
      '</linearGradient>',
      '</defs>',
      `<g class="adm-trend-grid">${gridLine(0)}${gridLine(trendCeil / 2)}${gridLine(trendCeil)}</g>`,
      `<g class="adm-trend-axis">${yLabel(0)}${yLabel(trendCeil / 2)}${yLabel(trendCeil)}</g>`,
    ];

    if (drawn) {
      const line = trendPath(pts);
      parts.push(`<path class="adm-trend-fill" fill="url(#adm-trend-fill)" d="${trendArea(pts)}" />`);
      /* the ambient glow is the same curve laid down as one wide, faint stroke rather than an SVG
         blur: a filter would be re-rasterised on every pointer move over the plot, a stroke is not. */
      parts.push(`<path class="adm-trend-halo" d="${line}" />`);
      parts.push(`<path class="adm-trend-line" data-s="${trendMetric}" d="${line}" />`);
      /* the nodes are the curve's own markers, so a flat zero stretch still reads as measured */
      parts.push('<g class="adm-trend-dots">' + pts.map((p) =>
        `<circle cx="${fx(p.x)}" cy="${fx(p.y)}" r="1.9" />`).join('') + '</g>');
    }

    const ticks = trendTicks(points);
    parts.push('<g class="adm-trend-axis">' + ticks.map((tick) =>
      `<text class="adm-trend-x" x="${fx(tick.x)}" y="${TREND_H - 6}" text-anchor="${tick.anchor}">${tick.text}</text>`
    ).join('') + '</g>');

    /* the inspection layer, kept last so the guide and the marker sit over the line */
    parts.push('<g class="adm-trend-cursor"></g>');
    /* one transparent target the pointer can hit anywhere in the band, including the flat parts */
    parts.push(`<rect class="adm-trend-hit" x="${TREND_PAD.l}" y="${TREND_PAD.t}"`
      + ` width="${TREND_IW}" height="${TREND_IH}" />`);

    statTrendSvg.innerHTML = parts.join('');
    paintTrendTotals(points);
    paintTrendCursor();
  }

  /**
   * The chart's guarded door. A malformed reading, a missing node or any unexpected DOM error must
   * never escape into the Stats refresh and leave the whole tab locked on its loading state.
   */
  function paintTrend(): void {
    try {
      renderTrend();
    } catch {
      trendData = [];
      trendFocus = -1;
      trendCeil = 4;
      try {
        if (statTrendSvg) {
          statTrendSvg.classList.remove('is-blank');
          statTrendSvg.innerHTML = '<g class="adm-trend-grid">'
            + `<line x1="${TREND_PAD.l}" y1="${fx(TREND_BASE)}"`
            + ` x2="${fx(TREND_PAD.l + TREND_IW)}" y2="${fx(TREND_BASE)}" />`
            + '</g>';
          statTrendSvg.setAttribute('aria-label', 'No chart data available.');
        }
        if (statTrendEmpty) {
          statTrendEmpty.hidden = false;
          statTrendEmpty.textContent = 'No chart data available.';
        }
        paintTrendTotals([]);
        paintTrendRead();
      } catch {
        /* a chart that cannot be drawn still must not lock the rest of the panel */
      }
    }
  }

  /** The window's three sums, from the buckets on screen and nothing else. */
  function trendTotals(points: readonly SeriesPoint[]): { signups: number; active: number; matches: number } {
    let signups = 0;
    let active = 0;
    let matches = 0;
    const countOf = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0;
    for (const p of points) {
      signups += countOf(p.signups);
      active += countOf(p.active);
      matches += countOf(p.matches);
    }
    return { signups, active, matches };
  }

  /**
   * What the plot is read out as: the curve on screen, over the buckets on screen. The other
   * series of the same window are not named here — the pods carry those, and a filtered slice has
   * no signup sum of its own to name.
   */
  const trendTotalsText = (points: readonly SeriesPoint[]): string => {
    const t = trendTotals(points);
    const slice = trendMode === 'all' ? '' : `${MATCH_MODE_LABEL[trendMode]} · `;
    const span = trendRange === '24h' ? 'hourly' : 'daily';
    return `${slice}${figure(t[trendMetric])} ${TREND_METRIC_LABEL[trendMetric].toLowerCase()}`
      + ` across ${points.length} ${span} buckets`;
  };

  /** The pods: each series' own sum across the window that is on screen. */
  function paintTrendTotals(points: readonly SeriesPoint[]): void {
    const t = trendTotals(points);
    for (const chip of statTrendSeries) {
      const slot = chip.querySelector<HTMLElement>('[data-gtotal]');
      if (!slot) continue;
      const key = trendSeriesKey(chip.dataset.gseries);
      slot.textContent = key && points.length ? figure(t[key]) : '—';
    }
  }

  /** The guide line and the enlarged marker over the bucket being inspected. */
  function paintTrendCursor(): void {
    /* looked up rather than held: a rebuild replaces the node, and a stale ref would draw nothing */
    const cursor = statTrendSvg?.querySelector<SVGGElement>('.adm-trend-cursor') ?? null;
    if (!cursor) return;
    const p = trendFocus >= 0 ? trendData[trendFocus] : undefined;
    if (!p) {
      cursor.textContent = '';
      paintTrendRead();
      return;
    }
    const x = fx(trendX(trendFocus, trendData.length));
    cursor.innerHTML = `<line class="adm-trend-guide" x1="${x}" y1="${TREND_PAD.t}"`
      + ` x2="${x}" y2="${fx(TREND_BASE)}" />`
      + `<circle class="adm-trend-mark" data-s="${trendMetric}" cx="${x}"`
      + ` cy="${fx(trendY(p[trendMetric], trendCeil))}" r="4.6" />`;
    paintTrendRead();
  }

  /**
   * The inspector strip under the pods. It exists only while a bucket is held: at rest its numbers
   * would be the pods' own sums a second time, which is exactly the row this card used to carry.
   * Holding one gives the Tehran hour or day the bucket opens on and the plotted series' count in
   * it, from the same real buckets the curve is drawn from.
   */
  function paintTrendRead(): void {
    if (!statTrendRead || !statTrendTs || !statTrendTok) return;
    const p = trendFocus >= 0 ? trendData[trendFocus] : undefined;
    statTrendRead.hidden = !p;
    statTrendTs.title = '';
    if (!p) return;

    /* the bucket's opening edge is an epoch stamp, so the zone conversion happens at format
       time alone: no manual offset arithmetic, and no day-shift around midnight Tehran. */
    statTrendTs.textContent = `${trendRange === '24h' ? trendTimeLabel(p.t) : trendDayLabel(p.t)}`
      + ` ${TREND_ZONE_LABEL}`;
    /* the pill has room for one instant; the tooltip carries the whole bucket it opens */
    statTrendTs.title = trendRange === '24h'
      ? `${trendTimeSpan(p.t, TREND_BUCKET_MS[trendRange])} ${TREND_ZONE_LABEL}`
      : `${trendDayLabel(p.t)} · 24h bucket · ${TREND_ZONE_LABEL}`;

    /* the token is the plotted series, so its hue, its word and its number all come from one key */
    statTrendTok.dataset.gtok = trendMetric;
    const label = statTrendTok.querySelector<HTMLElement>('.adm-trend-tok-l');
    const value = statTrendTok.querySelector<HTMLElement>('.adm-trend-tok-v');
    if (label) label.textContent = TREND_METRIC_LABEL[trendMetric];
    if (value) value.textContent = figure(p[trendMetric]);
  }

  /**
   * The bucket a pointer is on, in the plot's own space — the viewBox is the only system the drawn
   * line lives in. Null off the band or before the Worker has reported anything.
   */
  function trendBucketAt(clientX: number): number | null {
    const svg = statTrendSvg;
    const n = trendData.length;
    if (!svg || n < 1 || svg.classList.contains('is-blank')) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = ((clientX - rect.left) / rect.width) * TREND_W;
    const i = Math.round(((x - TREND_PAD.l) / TREND_IW) * (n - 1));
    return i < 0 || i > n - 1 ? null : i;
  }

  function setTrendFocus(index: number): void {
    if (index === trendFocus) return;
    trendFocus = index;
    paintTrendCursor();
  }

  /** One pass of the pointer over the plot: the bucket it is on, or none. */
  function trendInspect(clientX: number): void {
    setTrendFocus(trendBucketAt(clientX) ?? -1);
  }

  function setTrendRange(range: TrendRange): void {
    if (range === trendRange) return;
    trendRange = range;
    trendFocus = -1;
    impact('light');
    paintTrend();
  }

  /** The one curve on the canvas. The pods are a radio row, not three independent switches. */
  function setTrendMetric(metric: TrendSeries): void {
    if (metric === trendMetric) return;
    trendMetric = metric;
    impact('light');
    paintTrend();
  }

  /**
   * The match-type filter. The Worker folds the series for one slice per reading, so the pill
   * starts a fresh read; the old reading is deliberately not relabelled, and the plot says it is
   * waiting rather than showing another mode's numbers under this one's name. Only the two tagged
   * modes the card still offers can arrive here — the arena slice has no control to reach it.
   */
  function setTrendMode(mode: TrendMode): void {
    if (mode === trendMode) return;
    trendMode = mode;
    /* the slice decides which series exist at all: a signup curve is the whole board's, never one
       mode's, so a reading that was on signups moves to the count the filter was asked for */
    if (!trendMetricsOf(mode).includes(trendMetric)) trendMetric = 'matches';
    trendFocus = -1;
    impact('light');
    paintTrend();
    void refreshMetrics();
  }

  /**
   * The live bar, the alert card and every counter, from the last completed reading. A Worker
   * that refused the credential clears the board; one that is slow, broken or gone keeps the last
   * genuine reading and says which of the three it is. Nothing is ever modelled or substituted.
   */
  function paintStats() {
    const m = lastMetrics;
    const pending = metricsBusy && !m;
    const denied = metricsPhase === 'unauthorized';
    const failed = metricsPhase === 'error';
    const isSlow = metricsReason === 'timeout';
    const isGone = metricsReason === 'offline' || metricsReason === 'no-origin';
    const metric = (n: number | null | undefined): string =>
      n == null ? (pending ? '…' : '—') : figure(n);

    if (statsPanel) statsPanel.setAttribute('aria-busy', String(metricsBusy));

    /* ---- pulse: live concurrency, then the two active-population windows ---- */
    const concurrency = m ? m.activeRooms + m.queueLength : null;
    if (statActive) statActive.textContent = metric(concurrency);
    if (statLiveRooms) {
      statLiveRooms.textContent = m
        ? `${figure(m.activeRooms)} rooms · ${figure(m.queueLength)} queued`
        : '— rooms · — queued';
    }
    if (statLiveDot) statLiveDot.dataset.live = String(!!m && (m.activeRooms > 0 || m.queueLength > 0));
    if (statDau) statDau.textContent = metric(m?.dau);
    if (statMau) statMau.textContent = metric(m?.mau);

    /* ---- acquisition: rolling first-seen cohorts, plus the registry size for context ---- */
    if (statGrowthMeta) statGrowthMeta.textContent = m ? `${figure(m.totalUsers)} registered` : '— registered';
    if (statNewToday) statNewToday.textContent = metric(m?.signupsToday);
    if (statNewWeek) statNewWeek.textContent = metric(m?.signupsWeek);
    if (statNewMonth) statNewMonth.textContent = metric(m?.signupsMonth);

    /* ---- engagement: today's returners, next-day return, hooked share ---- */
    if (statReturning) statReturning.textContent = metric(m?.returningUsersToday);
    if (statReturningPct) {
      statReturningPct.textContent = m && m.returningShare != null
        ? `${rateText(m.returningShare)} of today's active`
        : "— of today's active";
    }

    const paintRate = (
      value: HTMLElement | null,
      bar: HTMLElement | null,
      fill: HTMLElement | null,
      pct: number | undefined,
      readText: string,
    ): void => {
      const live = m != null && pct != null && Number.isFinite(pct);
      const clipped = live ? Math.max(0, Math.min(100, pct)) : 0;
      if (value) value.textContent = live ? rateText(clipped) : pending ? '…' : '—';
      if (bar) {
        bar.dataset.empty = String(!live || clipped <= 0);
        bar.setAttribute('aria-valuenow', String(Math.round(clipped)));
        bar.setAttribute('aria-valuetext', live ? `${rateText(clipped)} — ${readText}` : 'No reading yet');
      }
      if (fill) fill.style.width = `${clipped}%`;
    };
    paintRate(
      statD1, statD1Bar, statD1Fill,
      m?.retentionRateD1, 'share of new players returning the next day',
    );
    paintRate(
      statCore, statCoreBar, statCoreFill,
      m?.coreRetention, 'share of players with three or more matches',
    );

    if (statLat) {
      statLat.textContent = m && m.pingMs != null ? `${Math.round(m.pingMs)} ms` : pending ? '…' : '—';
    }
    if (statEnv) statEnv.textContent = m ? m.environment : '—';

    if (statConn) {
      const state = metricsBusy ? 'loading'
        : denied ? 'locked'
          : metricsPhase === 'ok' && m ? 'live'
            : metricsPhase === 'error' ? connStateOf(!!m, metricsReason)
              : 'idle';
      statConn.dataset.state = state;
      statConn.textContent = state === 'loading' ? 'SYNCING'
        : state === 'live' ? 'LIVE'
          : state === 'locked' ? 'LOCKED'
            : state === 'stale' ? 'STALE'
              : state === 'slow' ? 'SLOW'
                : state === 'error' ? 'ERROR'
                  : state === 'offline' ? 'OFFLINE' : 'CONNECTING';
    }

    if (statUpdated) {
      /* A reading the room could only build in part says which part is missing. */
      const partial = m?.degraded?.length ? ` · partial: ${m.degraded.join(', ')}` : '';
      statUpdated.textContent = m
        ? `${metricsBusy ? 'Syncing · last reading' : 'Updated'} ${clockOf(m.timestamp)}${partial}`
        : metricsBusy ? 'Reading the Worker…'
          : denied ? 'No live reading'
            : metricsPhase === 'error'
              ? metricsReason === 'timeout' ? 'Worker slow, not gone'
                : metricsReason === 'offline' || metricsReason === 'no-origin' ? 'Worker unreachable'
                  : 'Worker answered with an error'
              : 'Awaiting telemetry';
    }

    if (statRefresh) {
      statRefresh.dataset.busy = String(metricsBusy);
      statRefresh.setAttribute('aria-disabled', String(metricsBusy));
    }

    if (statAlert) {
      statAlert.hidden = !(denied || failed);
      if (denied || failed) {
        statAlert.dataset.kind = denied ? 'denied' : isSlow ? 'offline' : 'error';
        statAlertIco?.setAttribute('href', denied ? '#i-lock' : isSlow ? '#i-restart' : isGone ? '#i-help' : '#i-bolt');
        const title = denied ? 'Unauthorized Admin Access'
          : isSlow ? 'Telemetry Still In Flight'
            : isGone ? 'Live Telemetry Unreachable'
              : 'Worker Answered With An Error';
        const body = denied
          ? (tgInitData()
            ? `The metrics door refused this session (${metricsDetail || 'no reason given'}). Live telemetry is restricted to the operator allowlist and to the SuperAdmins and Moderators appointed in this Command Center — open the Mini App as one of those accounts. The live counters stay blank; no demo or modelled figures are substituted.`
            : 'Telegram initData is missing. Open this Command Center inside Telegram as an appointed admin to read live telemetry; no demo or modelled figures are substituted.')
          : failed
            ? `${capFirst(metricsDetail || 'the call produced no answer')}. ${
                isGone
                  ? (m
                    ? `The figures above are its last genuine reading at ${clockOf(m.timestamp)}. Refresh to try again.`
                    : 'There are no live figures to show until one answers.')
                  : (m
                    ? `The figures above are its last genuine reading at ${clockOf(m.timestamp)}. It is deployed and running: refresh, then read the route's own reply.`
                    : 'The Worker is deployed and running — this is a broken reply, not a missing one. Refresh, then read the route\'s own reply.')
              }`
            : '';
        /* role=alert announces a text change, so an unrelated repaint must not repeat it */
        if (statAlertTitle && statAlertTitle.textContent !== title) statAlertTitle.textContent = title;
        if (statAlertBody && statAlertBody.textContent !== body) statAlertBody.textContent = body;
      }
    }

    paintTrend();
  }

  /**
   * One telemetry attempt. A refusal clears the board and shows the Unauthorized card; an
   * unreachable Worker keeps the last genuine reading, marked stale. Nothing is invented. The
   * busy flag is released in `finally`, so no timeout or render fault can leave the tab syncing.
   */
  async function refreshMetrics(): Promise<void> {
    if (metricsBusy) {
      /* the filter can move while a read is in flight: one more read, for the newest slice */
      metricsQueued = true;
      return;
    }
    metricsBusy = true;
    const asked = trendMode;
    try {
      paintStats();
    } catch {
      /* a render fault must not prevent the fetch below from running */
    }
    try {
      const result = await fetchMetrics(asked);
      /* a reply for a slice the operator already left is stale: the queued read owns the panel */
      if (asked !== trendMode) return;
      metricsDetail = result.state === 'ok' ? '' : result.detail;
      if (result.state === 'ok') {
        lastMetrics = result.metrics;
        metricsPhase = 'ok';
      } else if (result.state === 'unauthorized') {
        lastMetrics = null;
        metricsPhase = 'unauthorized';
      } else {
        metricsPhase = 'error';
        metricsReason = result.reason;
      }
    } catch (err) {
      /* fetchMetrics already catches; this is the last line of defence for the UI lock */
      metricsPhase = 'error';
      metricsReason = 'bad-body';
      const thrown = err instanceof Error ? err.message : String(err);
      metricsDetail = `${metricsRoute(asked)} → the panel could not complete the reading (${bodySnippet(thrown)})`;
    } finally {
      metricsBusy = false;
      try {
        paintStats();
      } catch {
        /* never leave SYNCING / READING THE WORKER... pinned by a paint failure */
      }
      if (metricsQueued) {
        metricsQueued = false;
        void refreshMetrics();
      }
    }
  }

  /** A slow beat, alive only while the stage is open, that polls only the visible Stats tab. */
  function startTelemetry() {
    stopTelemetry();
    metricsTimer = window.setInterval(() => {
      if (!open || document.hidden || statsPanel?.hidden) return;
      void refreshMetrics();
    }, 30_000);
  }

  function stopTelemetry() {
    if (!metricsTimer) return;
    window.clearInterval(metricsTimer);
    metricsTimer = 0;
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

  /* ---------- Live Activity: the FAB's unread counter and the dual-tier event feed ---------- */

  /** A wall-clock stamp, always LTR-isolated so a joined script never reflows the digits. */
  const activityClock = (ms: number): string => {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    const d = new Date(ms);
    return Number.isNaN(d.getTime())
      ? '—'
      : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  /** `{n}` is the only interpolation the activity copy needs. */
  const activityText = (key: string, n: number): string => t(key).replace('{n}', String(n));

  const activityVisible = (): boolean => !!open && !!inboxPanel && !inboxPanel.hidden;
  /**
   * A row is unread until the read set holds its id — and never while the feed that shows it is
   * on screen, because the open watermark already covers everything a fetch lands with. The
   * stage marks the whole feed read on the tap (see `openStage`), so nothing here can restore a
   * cleared count on close: only a row id the set has not seen can raise it again.
   */
  const unreadActivity = (): AdminActivityEvent[] =>
    activityEvents.filter((e) =>
      !seenEvents.has(e.id)
      && !(activityVisible() && viewedAt > 0 && e.at > 0 && e.at <= viewedAt));

  function saveSeenEvents(): void {
    const kept = [...seenEvents].slice(-SEEN_MAX);
    seenEvents.clear();
    for (const id of kept) seenEvents.add(id);
    writeJson(ACTIVITY_KEY, kept);
  }

  /** Watching the feed is what reads it: a row that lands on screen never returns as unread. */
  function markActivityRead(): void {
    let changed = false;
    for (const e of activityEvents) {
      if (!seenEvents.has(e.id)) { seenEvents.add(e.id); changed = true; }
    }
    if (changed) saveSeenEvents();
  }

  /** How long the pill takes to scale away: the CSS exit transition, plus a frame of slack. */
  const BADGE_OUT_MS = 220;
  /** The exit's own handle, so a count that arrives mid-fade cancels the collapse. */
  let badgeOutId = 0;

  /**
   * The badge's whole state is one read of the unread set: `data-count` carries the figure,
   * `data-state` picks the pill (obsidian crimson, or royal amber when a VIP purchase is in the
   * set), and `hidden` is the rest state at zero. Clearing is an EXIT, not a blink: the count
   * drops to zero on the very frame the stage opens, the pill scales away, and only then does it
   * leave the layout — so opening the panel visibly dismisses the counter instead of snapping it
   * out. An author `display` would beat `[hidden]`, so the CSS kills the rest state outright.
   */
  function paintFabBadge(): void {
    const unread = unreadActivity();
    const n = unread.length;
    const hasVip = unread.some((e) => e.kind === 'vip');
    window.clearTimeout(badgeOutId);
    if (fabBadge) {
      fabBadge.textContent = n > 99 ? '99+' : String(n);
      fabBadge.dataset.count = String(n);
      fabBadge.dataset.state = n === 0 ? 'empty' : hasVip ? 'vip' : 'normal';
      fabBadge.setAttribute('aria-label', t('adminFabBadgeAria'));
      if (n > 0) {
        const wasHidden = fabBadge.hidden;
        fabBadge.hidden = false;
        fabBadge.classList.remove('is-out');
        /* the pop belongs to an arrival: a repaint at the same count must not re-bounce */
        if (wasHidden) {
          fabBadge.classList.remove('is-in');
          void fabBadge.offsetWidth;             // restarting the animation needs a reflow
          fabBadge.classList.add('is-in');
        }
      } else if (!fabBadge.hidden) {
        fabBadge.classList.remove('is-in');
        fabBadge.classList.add('is-out');
        badgeOutId = window.setTimeout(() => {
          if (fabBadge.dataset.count !== '0') return;   // a new row arrived during the exit
          fabBadge.hidden = true;
          fabBadge.classList.remove('is-out');
        }, motionReduced() ? 0 : BADGE_OUT_MS);
      }
    }
    fab?.setAttribute('aria-label', n > 0 ? activityText('adminFabUnread', n) : t('adminFabAria'));
    if (activityUnread) {
      activityUnread.hidden = n === 0;
      activityUnread.textContent = activityText('adminActivityUnread', n);
    }
  }

  /** One LTR-isolated token: handles, amounts and timestamps each own their run. */
  function activityToken(text: string, cls: string): HTMLElement {
    const el = document.createElement('span');
    el.className = cls;
    el.setAttribute('dir', 'ltr');
    el.textContent = text;
    return el;
  }

  function activityLabel(text: string): HTMLElement {
    const el = document.createElement('span');
    el.className = 'event-k';
    el.textContent = text;
    return el;
  }

  /** A label/value pair stays welded together when a narrow meta row wraps. */
  function activityPair(label: string, value: HTMLElement): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'event-pair';
    wrap.append(activityLabel(label), value);
    return wrap;
  }

  function activityIcon(href: string): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', href);
    svg.append(use);
    return svg;
  }

  /** Tier A — New User Joined: a cyan/mint minimal card with a user-node medallion. */
  function joinCard(ev: AdminActivityEvent): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `event-card event-card-join${seenEvents.has(ev.id) ? '' : ' is-unread'}`;

    const medal = document.createElement('span');
    medal.className = 'event-medallion';
    medal.setAttribute('aria-hidden', 'true');
    medal.append(activityIcon('#i-user-join'));

    const body = document.createElement('div');
    body.className = 'event-body';
    const top = document.createElement('div');
    top.className = 'event-top';
    const title = document.createElement('p');
    title.className = 'event-title';
    title.textContent = t('adminEventJoinTitle');
    const tier = document.createElement('span');
    tier.className = 'event-tier';
    tier.textContent = t('adminEventJoinTier');
    top.append(title, tier);

    const meta = document.createElement('div');
    meta.className = 'event-meta';
    meta.append(
      activityToken(ev.handle, 'event-ltr event-handle'),
      activityLabel('·'),
      activityToken(activityClock(ev.at), 'event-ltr event-time'),
    );
    body.append(top, meta);
    li.append(medal, body);
    return li;
  }

  /** Tier B — VIP Purchase: beveled crown, a gold monetary pill, jewel and sheen. */
  function vipCard(ev: AdminActivityEvent): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `event-card event-card-vip${seenEvents.has(ev.id) ? '' : ' is-unread'}`;

    const jewel = document.createElement('span');
    jewel.className = 'event-jewel';
    jewel.setAttribute('aria-hidden', 'true');

    const medal = document.createElement('span');
    medal.className = 'event-medallion';
    medal.setAttribute('aria-hidden', 'true');
    medal.textContent = '👑';

    const body = document.createElement('div');
    body.className = 'event-body';
    const top = document.createElement('div');
    top.className = 'event-top';
    const title = document.createElement('p');
    title.className = 'event-title';
    title.textContent = t('adminEventVipTitle');
    const tier = document.createElement('span');
    tier.className = 'event-tier';
    tier.textContent = t('adminEventVipTier');
    top.append(title, tier);

    const amount = document.createElement('span');
    amount.className = 'event-amount event-ltr';
    amount.setAttribute('dir', 'ltr');
    const value = document.createElement('b');
    value.textContent = figure(ev.stars ?? 0);
    const unit = document.createElement('span');
    unit.className = 'event-amount-u';
    unit.textContent = `★ ${t('adminEventStars')}`;
    amount.append(value, unit);

    const meta = document.createElement('div');
    meta.className = 'event-meta';
    meta.append(
      activityPair(t('adminEventPlan'), activityToken(ev.plan ?? 'VIP', 'event-ltr event-handle')),
      activityPair(t('adminEventPaid'), amount),
      activityPair(t('adminEventBuyer'), activityToken(ev.handle, 'event-ltr event-handle')),
      activityPair(t('adminEventActivated'), activityToken(activityClock(ev.at), 'event-ltr event-time')),
    );
    body.append(top, meta);
    li.append(jewel, medal, body);
    return li;
  }

  function paintActivity(): void {
    if (activityHead) activityHead.textContent = t('adminActivityKicker');
    if (activityLive) activityLive.textContent = t('adminActivityLive');
    if (activityEmpty) activityEmpty.textContent = t('adminActivityEmpty');
    if (activityFeed) {
      activityFeed.replaceChildren(
        ...activityEvents.map((e) => (e.kind === 'vip' ? vipCard(e) : joinCard(e))),
      );
      activityFeed.setAttribute('aria-label', t('adminActivityKicker'));
    }
    if (activityEmpty) activityEmpty.hidden = activityEvents.length > 0;
    paintFabBadge();
  }

  /** Fold the two real readings into one newest-first window. No row is invented. */
  function foldActivity(): void {
    const out: AdminActivityEvent[] = [];
    for (const p of activityPlayers) {
      if (!Number.isFinite(p.firstSeen) || p.firstSeen <= 0) continue;
      out.push({ id: `join:${p.id}`, kind: 'join', at: p.firstSeen, handle: userWho(p) });
    }
    for (const r of activityPurchases) {
      if (!Number.isFinite(r.purchasedAt) || r.purchasedAt <= 0) continue;
      const handle = r.username
        ? `@${r.username.replace(/^@/, '')}`
        : r.userId ? `#${r.userId}` : '—';
      out.push({
        id: `vip:${r.userId}:${r.purchasedAt}:${r.stars}`,
        kind: 'vip',
        at: r.purchasedAt,
        handle,
        plan: VIP_PLAN_LABEL[r.planId],
        stars: r.stars,
      });
    }
    const ids = new Set<string>();
    activityEvents = out
      .filter((e) => {
        if (ids.has(e.id)) return false;
        ids.add(e.id);
        return true;
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, ACTIVITY_MAX);
    /* events that land while the feed is on screen are already seen */
    /* rows that land while the stage is up are already in front of the operator: reading them
       here is what keeps a cleared counter cleared once the stage closes again */
    if (open) markActivityRead();
    paintActivity();
  }

  /** The operator's own verified term is a real local receipt when the Worker has no ledger. */
  function localVipPurchase(): VipPurchase | null {
    const seat = liveSeat();
    const plan = vipPlanOf(seat.vipPlan);
    if (!plan || seat.vipUntil <= 0) return null;
    return {
      userId: 'you',
      username: tgUser()?.username ?? '',
      planId: plan.id,
      stars: vipConfig[plan.id].stars,
      purchasedAt: Math.max(0, seat.vipUntil - plan.days * 86_400_000),
      expiresAt: seat.vipUntil,
    };
  }

  /**
   * One live read of both sources. A refusal never invents a figure: the on-device directory
   * and this device's own VIP term are the honest fallbacks, exactly as the Users tab falls back.
   */
  async function refreshActivity(): Promise<void> {
    let players: DirPlayer[] = [];
    try {
      const page = await fetchPlayers('', 'all', '', 'all', 'all', 'joined', 0, ACTIVITY_MAX);
      if (page && Array.isArray(page.players)) players = page.players;
    } catch { /* no Worker answering */ }
    if (players.length === 0) {
      players = directoryPage(
        {
          q: '', filter: 'all', country: '', age: 'all', plan: 'all',
          sort: 'joined', offset: 0, limit: ACTIVITY_MAX,
        },
        liveSeat(),
      ).players;
    }
    activityPlayers = players;

    let purchases: readonly VipPurchase[] = vipStats?.recentPurchases ?? [];
    if (purchases.length === 0) {
      try {
        const stats = await fetchVipStats();
        if (stats) { vipStats = stats; purchases = stats.recentPurchases; }
      } catch { /* no ledger: fall through to the device's own term */ }
    }
    if (purchases.length === 0) {
      const own = localVipPurchase();
      purchases = own ? [own] : [];
    }
    activityPurchases = purchases;
    foldActivity();
  }

  /* ---------- the Users tab: the player directory ---------- */

  /** The live seat, folded the way the Worker folds a connection: save first, moderation second. */
  function liveSeat(): DirPlayer {
    const u = tgUser();
    const tally = ladderTally();
    return liveRow({
      name: (u?.first_name ?? u?.username ?? 'You').slice(0, 40),
      tiq: tiqFrom(tally.wins, tally.games, profile.tiqBonus),
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

  /** A row's VIP term, folded to a non-negative number; a hand-edited row never breaks a badge. */
  const vipUntilOf = (p: DirPlayer): number =>
    (typeof p.vipUntil === 'number' && Number.isFinite(p.vipUntil) ? Math.max(0, p.vipUntil) : 0);

  /**
   * The obsidian-gold VIP badge: the running term's duration tier, or the muted silver mark
   * carried only by the Expired VIP view so the rest of the directory stays calm.
   */
  function userVipBadge(p: DirPlayer, now: number): HTMLElement | null {
    const vipUntil = vipUntilOf(p);
    if (vipUntil <= 0) return null;
    const active = vipUntil > now;
    if (!active && usersPlan !== 'expired') return null;
    const plan = vipPlanOf(p.vipPlan);
    const badge = document.createElement('span');
    badge.className = 'adm-user-vip';
    if (!active) {
      badge.dataset.plan = 'expired';
      badge.textContent = 'VIP Expired';
      badge.title = `VIP term ended ${new Date(vipUntil).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })}`;
      return badge;
    }
    badge.dataset.plan = plan?.id ?? 'active';
    const days = vipDaysLeftUntil(vipUntil, now);
    const crown = document.createElement('span');
    crown.className = 'adm-user-vip-crown';
    crown.setAttribute('aria-hidden', 'true');
    crown.textContent = '👑';
    badge.append(crown, document.createTextNode(plan ? ` VIP ${plan.id.toUpperCase()}` : ' VIP'));
    badge.title = `${plan ? `${plan.days}-day ` : ''}Obsidian VIP · ${days} ${days === 1 ? 'day' : 'days'} left`;
    return badge;
  }

  /** The remaining-days stamp that rides the row's metadata line beside the TIQ pill. */
  function userVipDays(p: DirPlayer, now: number): HTMLElement | null {
    const vipUntil = vipUntilOf(p);
    if (vipUntil <= now) return null;
    const days = vipDaysLeftUntil(vipUntil, now);
    const chip = document.createElement('span');
    chip.className = 'adm-user-vip-left';
    chip.textContent = `${days}d left`;
    chip.title = `VIP expires ${new Date(vipUntil).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })}`;
    return chip;
  }

  /** One bento telemetry tile inside the expanded card: a bold readout over a micro label. */
  function userStat(v: string, l: string, glyph?: 'coin' | 'star'): HTMLElement {
    const s = document.createElement('span');
    s.className = 'adm-stat';
    const b = document.createElement('b');
    b.className = 'adm-stat-v';
    if (glyph === 'coin') {
      const coin = document.createElement('span');
      coin.className = 'coin';
      coin.dataset.coin = '';
      b.append(coin);
    } else if (glyph === 'star') {
      b.append(icon('#i-star', 'adm-stat-i'));
    }
    const value = document.createElement('span');
    value.className = 'adm-stat-vt';
    value.textContent = v;
    b.append(value);
    const t = document.createElement('span');
    t.className = 'adm-stat-l';
    t.textContent = l;
    s.append(b, t);
    return s;
  }

  /* ---- the advanced toolbar: country, age and the explicit audit sort ---- */

  const AGE_LABEL: Record<AgeBand, string> = {
    all: 'All ages', u18: 'Under 18', '18-24': '18–24', '25-34': '25–34', '35p': '35+',
  };
  const AGE_CHIP: Record<AgeBand, string> = {
    all: 'All', u18: '<18', '18-24': '18-24', '25-34': '25-34', '35p': '35+',
  };
  const PLAN_LABEL: Record<VipPlanFilter, string> = {
    all: 'All Users',
    free: 'Free (Non-VIP)',
    active: 'All Active VIP',
    '7d': 'VIP: 7 Days',
    '30d': 'VIP: 30 Days',
    '90d': 'VIP: 90 Days',
    expired: 'Expired VIP',
  };
  const SORT_LABEL: Record<DirSort, string> = {
    default: 'Default', lastPlayed: 'Last played', joined: 'Newest', tiq: 'Top TIQ',
    stars: 'Stars ↓', stars_asc: 'Stars ↑',
  };
  const SORT_MENU: Record<DirSort, { label: string; icon: string }> = {
    default: { label: 'Default order', icon: '#i-tune' },
    lastPlayed: { label: 'Last played', icon: '#i-bolt' },
    joined: { label: 'Newest joined', icon: '#i-calendar' },
    tiq: { label: 'Highest TIQ', icon: '#i-brain' },
    stars: { label: 'Most Stars (high → low)', icon: '#i-star-3d' },
    stars_asc: { label: 'Least Stars (low → high)', icon: '#i-star-3d' },
  };
  const AGE_BANDS = Object.keys(AGE_LABEL) as AgeBand[];
  const SORTS = Object.keys(SORT_LABEL) as DirSort[];

  const ageOf = (p: DirPlayer): number =>
    (typeof p.age === 'number' && Number.isFinite(p.age) ? Math.max(0, Math.floor(p.age)) : 0);

  /** The two-letter codes the picker can offer honestly: the index plus whatever the live page shows. */
  function countryOptions(): CustomSelectOption[] {
    const codes = new Set(directoryCountries());
    for (const p of usersRows) if (/^[A-Z]{2}$/.test(p.country)) codes.add(p.country);
    if (profile.country && /^[A-Z]{2}$/i.test(profile.country)) codes.add(profile.country.toUpperCase());
    if (usersCountry) codes.add(usersCountry);
    const list = [...codes].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    return [
      { value: '', label: 'Every country', icon: '#i-globe' },
      ...list.map((code) => ({ value: code, label: nameOf(code), code, flag: code })),
    ];
  }

  /** Keep the three closed faces (and the gold "filter is on" rims) in step with the state. */
  function syncAdvanced(): void {
    if (usersCountryFlag && usersCountryFlag.dataset.cc !== usersCountry) {
      usersCountryFlag.textContent = '';
      usersCountryFlag.append(
        usersCountry ? flagPhoto(usersCountry, 'fp-adm-sel') : icon('#i-globe', 'adm-fn-globe'),
      );
      usersCountryFlag.dataset.cc = usersCountry;
    }
    if (usersCountryV) usersCountryV.textContent = usersCountry || 'ALL';
    if (usersAgeV) usersAgeV.textContent = AGE_LABEL[usersAge];
    if (usersSortV) usersSortV.textContent = SORT_LABEL[usersSort];
    if (usersPlanEl) {
      if (usersPlanEl.value !== usersPlan) usersPlanEl.value = usersPlan;
      usersPlanEl.setAttribute('aria-label', `Plan: ${PLAN_LABEL[usersPlan]}`);
    }
    if (usersPlanV) usersPlanV.textContent = PLAN_LABEL[usersPlan];
    usersCountryTrig?.setAttribute(
      'aria-label', `Country: ${usersCountry ? nameOf(usersCountry) : 'all countries'}`,
    );
    usersAgeTrig?.setAttribute('aria-label', `Age: ${AGE_LABEL[usersAge]}`);
    usersSortTrig?.setAttribute('aria-label', `Sort: ${SORT_LABEL[usersSort]}`);
    usersCountrySelect?.refresh();
    usersAgeSelect?.refresh();
    usersSortSelect?.refresh();
    for (const pod of usersAdvPods) {
      const key = pod.dataset.uadv;
      const on = key === 'country' ? !!usersCountry
        : key === 'age' ? usersAge !== 'all'
          : key === 'plan' ? usersPlan !== 'all'
            : usersSort !== 'default';
      pod.dataset.on = String(on);
    }
  }

  type Recency = 'live' | 'hot' | 'warm' | 'cold';

  const recencyOf = (ms: number, now: number): Recency => {
    const age = now - ms;
    return age <= 60 * 60 * 1000 ? 'hot' : age <= 24 * 60 * 60 * 1000 ? 'warm' : 'cold';
  };

  /**
   * The Users row's activity line, measured against the real clock at paint time. Flooring each
   * band keeps "just now" to a true minute and stops 59 minutes reading as "1h ago" early.
   */
  function activeAgo(ms: number, now = Date.now()): string {
    const s = Math.max(0, Math.floor((now - ms) / 1000));
    if (s < 60) return 'Active just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `Active ${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `Active ${h}h ago`;
    const d = Math.floor(h / 24);
    return d < 30 ? `Active ${d}d ago` : `Active ${Math.floor(d / 30)}mo ago`;
  }

  /**
   * The relative activity stamp the card prints: the freshest of the last sighting and the last
   * settled race, so a registry written by an older Worker still reads honestly.
   */
  function activityOf(p: DirPlayer): { text: string; tone: Recency; at: number } {
    const now = Date.now();
    const seen = Math.max(p.lastSeen, p.lastPlayed);
    if (seen > 0) {
      return {
        text: activeAgo(seen, now),
        tone: p.inMatch ? 'live' : recencyOf(seen, now),
        at: seen,
      };
    }
    return { text: 'No activity yet', tone: 'cold', at: 0 };
  }

  /**
   * One directory row: the summary line always, the telemetry and moderation keys when the card
   * is the open one. The structure mirrors the Inbox card — one delegated listener, no per-row
   * handlers outliving a repaint.
   */
  function playerCard(p: DirPlayer): HTMLLIElement {
    const now = Date.now();
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

    const nameRow = document.createElement('span');
    nameRow.className = 'adm-user-nr';
    const flag = document.createElement('span');
    flag.className = 'adm-user-fl';
    if (/^[A-Z]{2}$/.test(p.country)) flag.append(flagPhoto(p.country, 'fp-adm'));
    else flag.append(icon('#i-globe', 'adm-user-fl-i'));

    const nm = document.createElement('span');
    nm.className = 'adm-user-n';
    nm.textContent = p.name;
    if (p.id === YOU_ID) {
      const you = document.createElement('b');
      you.className = 'adm-user-you';
      you.textContent = 'YOU';
      nm.append(' ', you);
    }
    nameRow.append(flag, nm);
    if (p.tgId) {
      const verified = document.createElement('span');
      verified.className = 'adm-user-vb';
      verified.title = 'Telegram identity linked';
      verified.setAttribute('role', 'img');
      verified.setAttribute('aria-label', 'Telegram identity linked');
      verified.append(icon('#i-check', 'adm-user-vb-i'));
      nameRow.append(verified);
    }
    const vipBadge = userVipBadge(p, now);
    if (vipBadge) nameRow.append(vipBadge);

    const sub = document.createElement('span');
    sub.className = 'adm-user-m';
    const handle = document.createElement('span');
    handle.className = 'adm-user-h';
    handle.textContent = userWho(p);
    handle.title = handle.textContent;
    const tiqPill = document.createElement('span');
    tiqPill.className = 'adm-user-tiq';
    tiqPill.append(icon('#i-brain', 'adm-user-tiq-i'));
    const tiqValue = document.createElement('span');
    tiqValue.className = 'adm-user-tiq-v';
    tiqValue.textContent = `TIQ ${figure(p.tiq)}`;
    tiqPill.append(tiqValue);
    sub.append(handle, document.createTextNode(' '), tiqPill);
    const vipDays = userVipDays(p, now);
    if (vipDays) sub.append(document.createTextNode(' '), vipDays);

    /* the economy at a glance: every row carries its Stars next to TIQ, dimmed at zero so the
       funded accounts stand out in the collapsed list without opening a single card */
    const stars = Math.max(0, Math.floor(p.stars || 0));
    const starsBadge = document.createElement('span');
    starsBadge.className = 'adm-user-stars-badge';
    starsBadge.title = stars === 1 ? '1 Star' : `${figure(stars)} Stars`;
    if (stars === 0) starsBadge.dataset.zero = 'true';
    starsBadge.append(icon('#i-star-3d', 'ico-star-3d'));
    const starsValue = document.createElement('b');
    starsValue.className = 'adm-user-stars-v';
    starsValue.textContent = figure(stars);
    starsBadge.append(starsValue);
    sub.append(document.createTextNode(' '), starsBadge);

    const activity = activityOf(p);
    const act = document.createElement('span');
    act.className = 'adm-user-act';
    act.dataset.tone = activity.tone;
    if (activity.at) act.title = new Date(activity.at).toISOString();
    const actDot = document.createElement('i');
    actDot.className = 'adm-user-act-dot';
    actDot.setAttribute('aria-hidden', 'true');
    const actText = document.createElement('span');
    actText.textContent = activity.text;
    act.append(actDot, actText);

    txt.append(nameRow, sub, act);

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
    const age = ageOf(p);
    const stamps: [string, string][] = [
      ['id', p.tgId || p.id],
      ['first seen', agoOf(p.firstSeen)],
      ['last seen', agoOf(p.lastSeen)],
    ];
    if (age) stamps.push(['age', String(age)]);
    const vipUntil = vipUntilOf(p);
    if (vipUntil > 0) {
      const vipPlan = vipPlanOf(p.vipPlan);
      stamps.push([
        'vip',
        vipUntil > now
          ? `${vipPlan ? `VIP ${vipPlan.id.toUpperCase()} · ` : ''}${vipDaysLeftUntil(vipUntil, now)}d left`
          : 'expired',
      ]);
    }
    stamps.forEach(([label, value], i) => {
      const group = document.createElement('span');
      group.className = 'adm-user-id-group';
      const chip = document.createElement('span');
      chip.className = 'adm-user-id-chip';
      const key = document.createElement('span');
      key.className = 'adm-user-id-k';
      key.textContent = label;
      const val = document.createElement('span');
      val.className = 'adm-user-id-v';
      val.textContent = value;
      chip.append(key, document.createTextNode(' '), val);
      group.append(chip);
      if (i < stamps.length - 1) {
        const dot = document.createElement('span');
        dot.className = 'adm-user-id-dot';
        dot.setAttribute('aria-hidden', 'true');
        dot.textContent = ' · ';
        group.append(dot);
      }
      meta.append(group);
    });
    detail.append(meta);

    const grid = document.createElement('div');
    grid.className = 'adm-cells adm-user-cells';
    const rate = p.matches ? Math.round((p.wins / p.matches) * 100) : 0;
    const coinsCell = userStat(coinText(p.coins), 'Total Coins', 'coin');
    coinsCell.classList.add('adm-user-wallet');
    grid.append(
      userStat(figure(p.matches), 'Matches Played'),
      userStat(`${rate}% · ${p.wins}W ${p.losses}L`, 'Win Rate · Record'),
      userStat(`${p.streak} · ${p.best}`, 'Streak · Best'),
      userStat(p.lastPlayed ? agoOf(p.lastPlayed) : 'Never', 'Last Played'),
      coinsCell,
      userStat(figure(p.stars), 'Stars Won', 'star'),
      userStat(figure(p.referrals), 'Invited Friends'),
      userStat(p.squad || '—', 'Squad / Channel'),
    );
    detail.append(grid);

    const actions = document.createElement('div');
    actions.className = 'adm-user-actions';
    const ban = document.createElement('button');
    ban.type = 'button';
    ban.className = 'adm-user-ban adm-uban';
    ban.dataset.uban = p.id;
    ban.dataset.banned = String(p.banned);
    ban.setAttribute('aria-pressed', String(p.banned));
    ban.textContent = p.banned ? 'Unban Player' : 'Ban Player';
    const grant = (n: number): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'adm-ugrant';
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
      usersSourceEl.textContent = usersOn ? 'LIVE REGISTRY' : 'NO REGISTRY';
      usersSourceEl.dataset.live = String(usersOn);
    }
    if (usersTotalEl) {
      usersTotalEl.textContent = usersReady
        ? `${figure(usersTotal)} ${usersTotal === 1 ? 'player' : 'players'}`
        : '—';
    }
    if (usersMore) usersMore.hidden = !usersReady || usersRows.length >= usersTotal;
    syncAdvanced();
    if (!usersList) return;
    usersList.textContent = '';
    const frag = document.createDocumentFragment();
    for (const p of usersRows) frag.append(playerCard(p));
    usersList.append(frag);
    if (usersEmpty) usersEmpty.hidden = !usersReady || usersRows.length > 0;
  }

  /** The refresh key: a spinner while any read is still out, and no spam clicks behind it. */
  function syncUsersRefresh(): void {
    if (!usersRefresh) return;
    const busy = usersPending > 0;
    usersRefresh.dataset.busy = String(busy);
    usersRefresh.disabled = busy;
    usersRefresh.setAttribute('aria-busy', String(busy));
    usersRefresh.setAttribute('aria-label', busy ? 'Refreshing player directory' : 'Refresh player directory');
    usersRefresh.title = busy ? 'Refreshing player directory…' : 'Refresh player directory';
    if (usersPrune) {
      usersPrune.disabled = busy || !usersOn;
      usersPrune.title = usersOn ? 'Prune duplicate zero-game guest records' : 'Prune needs a live registry';
    }
  }

  /**
   * Read one window of the directory. The Worker's registry is asked first and wins when it
   * answers; with nothing behind the page, players.ts can still show this device's own seat.
   * Only the newest read paints.
   */
  async function refreshUsers(reset: boolean, force = false): Promise<void> {
    const run = ++usersSeq;
    const offset = reset ? 0 : usersRows.length;
    usersPending++;
    syncUsersRefresh();

    try {
      /* Both sources page the same way: one PAGE_SIZE window at the rows already held. That keeps
         Load More honest instead of re-reading the first window forever. */
      const paintLocal = () => {
        const page = directoryPage(
          {
            q: usersQuery, filter: usersFilter, country: usersCountry, age: usersAge,
            plan: usersPlan, sort: usersSort, offset, limit: PAGE_SIZE,
          },
          liveSeat(),
        );
        usersRows = reset ? page.players : [...usersRows, ...page.players];
        usersTotal = page.total;
        usersReady = true;
        paintUsers();
      };

      /* Once the Worker has refused, the on-device directory is the authority. Filtering it is a
         synchronous pass over the rows the device actually holds, so every toolbar move repaints
         inside a frame instead of waiting on a fetch that has already failed this session. A
         manual refresh forces one fresh probe, because "on demand" must still try the Worker. */
      if (!force && usersProbed && !usersOn) {
        paintLocal();
        return;
      }

      const live = await fetchPlayers(
        usersQuery, usersFilter, usersCountry, usersAge, usersPlan, usersSort, offset, PAGE_SIZE,
      );
      if (run !== usersSeq) return;                 // a newer read has already been asked for
      usersProbed = true;
      usersOn = !!live;
      if (live) {
        const rows = reset ? live.players : [...usersRows, ...live.players];
        usersRows = usersSort === 'lastPlayed' ? orderByActivity(rows) : rows;
        usersTotal = live.total;
        usersReady = true;
        paintUsers();
        return;
      }
      paintLocal();
    } finally {
      usersPending = Math.max(0, usersPending - 1);
      syncUsersRefresh();
    }
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

  /** The prune key: forget the directory's zero-game guest ghosts, then repaint from the registry. */
  async function pruneGhosts(): Promise<void> {
    if (usersPending > 0) return;
    impact('medium');
    usersPending++;
    syncUsersRefresh();
    try {
      const pruned = await pruneGhostPlayers();
      if (pruned === null) {
        usersOn = false;
        usersProbed = true;
        paintUsers();
        notify('error');
        api.note('The Worker is not answering — there is no live registry to prune.', true, 2600);
        return;
      }
      notify('success');
      api.note(
        pruned > 0
          ? `Pruned ${pruned} duplicate guest ${pruned === 1 ? 'record' : 'records'}.`
          : 'No duplicate guest records to prune.',
        false,
        2600,
      );
      await refreshUsers(true, true);
    } finally {
      usersPending = Math.max(0, usersPending - 1);
      syncUsersRefresh();
    }
  }

  /* ---------- Squads: the registered channels & groups at war (worker/matchmaker.ts) ---------- */
  const SQUAD_ACTION_ERROR: Record<string, string> = {
    no_such_squad: 'That squad is no longer on the registry.',
    invalid_action: 'The Worker did not recognise that command.',
    forbidden: 'SuperAdmin access required.',
  };

  const SQUAD_STATUS_TEXT: Record<SquadVerification, string> = {
    verified: 'Verified Admin',
    pending: 'Pending Review',
    revoked: 'Revoked',
  };

  const SQUAD_ROLE_TEXT: Record<SquadMemberRole, string> = {
    leader: 'Leader',
    admin: 'Officer',
    member: 'Member',
  };

  const squadsEmptyTitle = squadsEmpty?.querySelector<HTMLElement>('.adm-users-empty-t') ?? null;
  const squadsEmptySub = squadsEmpty?.querySelector<HTMLElement>('.adm-users-empty-s') ?? null;

  /** True when a row survives the type, verification, member-range and search filters. */
  function squadMatches(row: SquadRow): boolean {
    if (squadsType !== 'all' && row.kind !== squadsType) return false;
    if (squadsStatus !== 'all' && row.verification !== squadsStatus) return false;
    const realRange = SQUAD_REAL_RANGE[squadsReal];
    if (row.subscribers < realRange[0] || row.subscribers > realRange[1]) return false;
    const gameRange = SQUAD_GAME_RANGE[squadsGame];
    if (row.members < gameRange[0] || row.members > gameRange[1]) return false;
    const q = squadsQuery.trim().toLowerCase();
    if (!q) return true;
    return [row.name, row.handle, row.chatId, row.ownerId, row.ownerName, row.ownerUsername]
      .some((value) => value.toLowerCase().includes(q));
  }

  function squadCell(value: string, label: string, title = ''): HTMLElement {
    const cell = document.createElement('span');
    cell.className = 'adm-squad-cell';
    const figureEl = document.createElement('b');
    figureEl.textContent = value;
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    cell.append(figureEl, labelEl);
    if (title) cell.title = title;
    return cell;
  }

  /** `Oct 31, 2026 · 17:59` — Latin digits, one compact registration stamp. */
  function squadDate(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    const at = new Date(ms);
    const day = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${day} · ${time}`;
  }

  /** `Oct 31, 2026` — the date half, for a roster row's joined stamp. */
  function squadDay(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /** Copy a chat id: the clipboard API where the webview offers one, the selection path otherwise. */
  async function copySquadText(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* a webview that refuses the API still gets the selection path */ }
    try {
      const well = document.createElement('textarea');
      well.value = text;
      well.setAttribute('readonly', '');
      well.style.position = 'fixed';
      well.style.inset = '0';
      well.style.opacity = '0';
      document.body.append(well);
      well.select();
      const ok = document.execCommand('copy');
      well.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /** One in-game roster row: portrait, identity, role/join line and the player's own TIQ. */
  function squadMemberRow(member: SquadMemberRow): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'adm-squad-member';
    li.dataset.role = member.role;
    li.title = `Telegram ID ${member.id}`;

    const av = document.createElement('span');
    av.className = 'adm-squad-mav';
    av.setAttribute('aria-hidden', 'true');
    av.textContent = (member.name || member.username || member.id).charAt(0).toUpperCase() || '?';
    if (member.photo) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.src = member.photo;
      img.addEventListener('error', () => img.remove());
      av.append(img);
    }

    const txt = document.createElement('span');
    txt.className = 'adm-squad-mtxt';
    const name = document.createElement('b');
    name.className = 'adm-squad-mname';
    name.dir = 'auto';
    name.textContent = member.name || (member.username ? `@${member.username}` : `Player ${member.id}`);
    const meta = document.createElement('span');
    meta.className = 'adm-squad-mmeta';
    const bits = [SQUAD_ROLE_TEXT[member.role]];
    if (member.username) bits.push(`@${member.username}`);
    if (member.country) bits.push(nameOf(member.country));
    if (member.joinedAt) bits.push(`joined ${squadDay(member.joinedAt)}`);
    meta.textContent = bits.join(' · ');
    txt.append(name, meta);

    const tiq = document.createElement('span');
    tiq.className = 'adm-squad-mtiq';
    tiq.textContent = `TIQ ${figure(member.tiq)}`;
    li.append(av, txt, tiq);
    return li;
  }

  /** The in-game roster drawer: leader first, then TIQ order, scrollable inside the card. */
  function squadRoster(row: SquadRow): HTMLElement {
    const wrap = document.createElement('section');
    wrap.className = 'adm-squad-roster';
    wrap.setAttribute('aria-label', `In-game roster for ${row.name}`);

    const head = document.createElement('div');
    head.className = 'adm-squad-roster-h';
    const title = document.createElement('b');
    title.textContent = 'In-Game Roster';
    const total = document.createElement('span');
    const listed = row.roster.length;
    total.textContent = listed === row.members
      ? `${figure(listed)} ${listed === 1 ? 'player' : 'players'}`
      : `${figure(listed)} of ${figure(row.members)} players`;
    head.append(title, total);
    wrap.append(head);

    if (!row.roster.length) {
      const empty = document.createElement('p');
      empty.className = 'adm-squad-roster-empty';
      empty.textContent = row.members > 0
        ? 'The roster is not available in this registry read.'
        : 'No player has joined this squad in the game yet.';
      wrap.append(empty);
      return wrap;
    }

    const list = document.createElement('ul');
    list.className = 'adm-squad-roster-list';
    for (const member of row.roster) list.append(squadMemberRow(member));
    wrap.append(list);
    return wrap;
  }

  /**
   * One registry row, closed by default: identity, the two member counts and the audit badge.
   * Opening it reveals the ownership line, the real audience and the full in-game roster.
   */
  function squadCard(row: SquadRow): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'adm-squad';
    li.dataset.squad = row.id;
    li.dataset.banned = String(row.banned);
    const expanded = row.id === openSquad;
    if (expanded) li.classList.add('is-open');

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'adm-squad-main';
    main.dataset.squadOpen = row.id;
    main.setAttribute('aria-expanded', String(expanded));
    main.title = expanded ? `Collapse ${row.name}` : `Expand ${row.name}`;

    /* A Telegram photo is a bonus: the crest mark is painted underneath and stays when the CDN
       answers a private chat with a 404 or a 1x1 placeholder. */
    const glyph = document.createElement('span');
    glyph.className = 'adm-squad-ico';
    glyph.setAttribute('aria-hidden', 'true');
    const mark = document.createElement('b');
    mark.className = 'adm-squad-mark';
    mark.textContent = squadMark({ name: row.name, handle: row.handle, tag: row.tag });
    const photo = document.createElement('img');
    photo.className = 'adm-squad-av';
    photo.alt = '';
    photo.decoding = 'async';
    photo.referrerPolicy = 'no-referrer';
    photo.hidden = true;
    photo.addEventListener('load', () => {
      photo.hidden = photo.naturalWidth <= 2 || photo.naturalHeight <= 2;
    });
    photo.addEventListener('error', () => { photo.hidden = true; });
    const photoUrl = telegramAvatarUrl(row.handle);
    if (photoUrl) photo.src = photoUrl;
    glyph.append(mark, photo);

    const txt = document.createElement('span');
    txt.className = 'adm-squad-txt';
    const name = document.createElement('span');
    name.className = 'adm-squad-name';
    /* A title can arrive as two scripts around a pipe or a mixed fa/en phrase. `dir=auto` plus
       `unicode-bidi: isolate` keeps every run whole, and the two-line clamp replaces the old
       single-line ellipsis that used to cut Persian titles mid-word. */
    name.dir = 'auto';
    name.textContent = row.name || row.handle;
    const sub = document.createElement('span');
    sub.className = 'adm-squad-sub';
    const handle = document.createElement('span');
    handle.className = 'adm-squad-handle';
    handle.dir = 'ltr';
    handle.textContent = row.handle;
    handle.title = row.handle;
    const kind = document.createElement('span');
    kind.className = 'adm-squad-kind';
    kind.dataset.kind = row.kind;
    kind.textContent = row.kind === 'channel' ? 'Channel' : 'Group';

    /* Both member readings sit in the closed row: the real Telegram audience and the joined
       in-game roster. The labels stay explicit so neither number can be mistaken for the other. */
    const counts = document.createElement('span');
    counts.className = 'adm-squad-counts';
    const count = (value: number, label: string): HTMLSpanElement => {
      const part = document.createElement('span');
      const figureEl = document.createElement('b');
      figureEl.textContent = figure(value);
      part.append(figureEl, document.createTextNode(` ${label}`));
      return part;
    };
    counts.append(
      count(row.members, 'in-game'),
      document.createTextNode(' · '),
      count(row.subscribers, 'real'),
    );
    counts.title = `${figure(row.members)} joined player${row.members === 1 ? '' : 's'} in the game`
      + ` · ${figure(row.subscribers)} Telegram subscribers`;
    sub.append(handle, kind, counts);
    txt.append(name, sub);

    const side = document.createElement('span');
    side.className = 'adm-squad-side';
    const badges = document.createElement('span');
    badges.className = 'adm-squad-badges';
    const status = document.createElement('span');
    status.className = 'adm-squad-st';
    status.dataset.status = row.verification;
    status.textContent = SQUAD_STATUS_TEXT[row.verification];
    status.title = row.verification === 'revoked'
      ? 'Revoked / mismatch — ownership is no longer confirmed'
      : row.verification === 'pending'
        ? 'Pending review / unverified — an admin has not audited this claim'
        : 'Confirmed through the Telegram Bot API or an admin decision';
    badges.append(status);
    if (row.banned) {
      const purged = document.createElement('span');
      purged.className = 'adm-squad-purged';
      purged.textContent = 'Purged';
      badges.append(purged);
    }
    side.append(badges, icon('#i-chevron-down', 'adm-squad-chev'));

    main.append(glyph, txt, side);
    li.append(main);
    if (!expanded) return li;

    const body = document.createElement('div');
    body.className = 'adm-squad-body';

    /* The enlisted line, structured: who owns it, which chat it is, and when it registered. */
    const meta = document.createElement('div');
    meta.className = 'adm-squad-meta';

    const ownerTag = document.createElement('span');
    ownerTag.className = 'adm-squad-tag adm-squad-tag-owner';
    ownerTag.title = row.ownerId ? `Owner ID ${row.ownerId}` : 'Owner ID unavailable';
    ownerTag.append(icon('#i-user', 'adm-squad-tag-ico'));
    const ownerName = document.createElement('b');
    ownerName.dir = 'auto';
    ownerName.textContent = row.ownerName
      || (row.ownerUsername ? `@${row.ownerUsername}` : 'Unknown owner');
    ownerTag.append(ownerName);
    if (row.ownerName && row.ownerUsername) {
      const ownerHandle = document.createElement('span');
      ownerHandle.className = 'adm-squad-owner-h';
      ownerHandle.dir = 'ltr';
      ownerHandle.textContent = `(@${row.ownerUsername})`;
      ownerTag.append(ownerHandle);
    }

    const idValue = row.chatId || row.ownerId;
    const idTag = document.createElement('button');
    idTag.type = 'button';
    idTag.className = 'adm-squad-tag adm-squad-id';
    idTag.dataset.copyId = idValue;
    idTag.disabled = !idValue;
    idTag.title = idValue ? 'Copy chat ID' : 'This chat has no id on record';
    idTag.setAttribute('aria-label', idValue ? `Copy chat ID ${idValue}` : 'Chat id unavailable');
    const idText = document.createElement('span');
    idText.dir = 'ltr';
    idText.textContent = `ID: ${idValue || '—'}`;
    idTag.append(idText, icon('#i-copy', 'adm-squad-tag-ico adm-squad-id-ico'));
    idTag.addEventListener('click', () => {
      const value = idTag.dataset.copyId ?? '';
      if (!value) return;
      impact('light');
      void copySquadText(value).then((ok) => {
        if (ok) {
          notify('success');
          api.note(`Chat ID ${value} copied.`, false, 1800);
        } else {
          notify('error');
          api.note('Could not copy the chat ID — select it from the row.', true, 2400);
        }
      });
    });

    const dateTag = document.createElement('span');
    dateTag.className = 'adm-squad-tag adm-squad-tag-date';
    dateTag.title = 'Registration date';
    dateTag.append(icon('#i-clock', 'adm-squad-tag-ico'));
    const dateText = document.createElement('span');
    dateText.dir = 'ltr';
    dateText.textContent = squadDate(row.createdAt);
    dateTag.append(dateText);

    meta.append(ownerTag, idTag, dateTag);

    const avgTiq = row.members ? Math.round(row.warTiq / row.members) : 0;
    const cells = document.createElement('div');
    cells.className = 'adm-squad-cells';
    cells.append(
      squadCell(
        figure(row.subscribers),
        'Real Members',
        `${row.subscribers.toLocaleString('en-US')} Telegram subscribers — the channel's own audience`,
      ),
      squadCell(
        figure(row.members),
        'In-Game Members',
        `${row.members.toLocaleString('en-US')} player${row.members === 1 ? '' : 's'} joined the squad in the game`,
      ),
      squadCell(
        figure(row.warTiq),
        'War TIQ',
        `${row.warTiq.toLocaleString('en-US')} TIQ from ${row.contributors} contributor${row.contributors === 1 ? '' : 's'}`,
      ),
      squadCell(
        figure(avgTiq),
        'Squad IQ',
        `${avgTiq.toLocaleString('en-US')} average TIQ across the in-game roster`,
      ),
    );

    /* Two balanced columns for the audited keys, one full-width row for the war verdict: the
       destructive key can never be squeezed into a third of the card and clipped. */
    const actions = document.createElement('div');
    actions.className = 'adm-squad-actions';
    const openKey = (full: boolean): HTMLAnchorElement => {
      const link = document.createElement('a');
      link.className = `adm-btn adm-squad-open${full ? ' is-full' : ''}`;
      const href = telegramChatLink(row.handle);
      if (href) link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const label = document.createElement('span');
      label.textContent = 'Open Channel';
      link.append(icon('#i-ext', 'adm-squad-act-ico'), label);
      return link;
    };
    if (!row.banned) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = row.verification === 'verified'
        ? 'adm-btn adm-squad-verify'
        : 'adm-btn adm-btn-primary adm-squad-verify';
      toggle.dataset.squadAction = row.verification === 'verified' ? 'REVOKE' : 'VERIFY';
      toggle.textContent = row.verification === 'verified' ? 'Revoke Verification' : 'Verify Admin';
      toggle.disabled = squadsBusy;
      actions.append(toggle, openKey(false));

      const purge = document.createElement('button');
      purge.type = 'button';
      purge.className = 'adm-btn adm-squad-purge';
      purge.dataset.squadAction = 'BAN';
      purge.textContent = 'Purge from War';
      purge.disabled = squadsBusy;
      actions.append(purge);
    } else {
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'adm-btn adm-btn-primary adm-squad-verify adm-squad-restore';
      restore.dataset.squadAction = 'UNBAN';
      restore.textContent = 'Restore to War';
      restore.disabled = squadsBusy;
      actions.append(openKey(true), restore);
    }

    body.append(meta, cells, squadRoster(row), actions);
    li.append(body);
    return li;
  }

  /** Paint the KPI pulse, the filter state, the source chip and the visible cards. */
  function paintSquads(): void {
    if (squadsPanel) squadsPanel.setAttribute('aria-busy', String(squadsBusy));
    const t = squadsTotals;
    const pending = squadsBusy && !squadsReady;
    const figureOr = (value: number | undefined): string =>
      value == null ? (pending ? '…' : '—') : figure(value);

    if (squadKpiTotal) squadKpiTotal.textContent = figureOr(t?.total);
    if (squadKpiTotalSub) {
      squadKpiTotalSub.textContent = t
        ? t.banned > 0 ? `${figure(t.banned)} purged` : 'all in the war'
        : '—';
    }
    if (squadKpiTypes) {
      squadKpiTypes.textContent = t ? `${figure(t.channels)} / ${figure(t.groups)}` : (pending ? '…' : '—');
    }
    if (squadKpiTypesSub) {
      squadKpiTypesSub.textContent = t
        ? `${figure(t.channels)} channels · ${figure(t.groups)} groups`
        : '—';
    }
    if (squadKpiVerified) squadKpiVerified.textContent = figureOr(t?.verified);
    if (squadKpiVerifiedSub) {
      squadKpiVerifiedSub.textContent = t
        ? `${figure(t.pending)} pending · ${figure(t.revoked)} revoked`
        : '—';
    }
    if (squadKpiMembers) squadKpiMembers.textContent = figureOr(t?.members);
    if (squadKpiMembersSub) {
      squadKpiMembersSub.textContent = t ? `${figure(t.tiq)} war TIQ` : '—';
      squadKpiMembersSub.title = t ? `${figure(t.contributors)} contributors across the war` : '';
    }

    for (const chip of squadTypeChips) {
      chip.setAttribute('aria-pressed', String((chip.dataset.sqtype ?? 'all') === squadsType));
    }
    for (const chip of squadStatusChips) {
      chip.setAttribute('aria-pressed', String((chip.dataset.sqstatus ?? 'all') === squadsStatus));
    }

    const realLabel = SQUAD_REAL_LABEL[squadsReal];
    if (squadsRealV) squadsRealV.textContent = realLabel;
    if (squadsRealFilter) {
      if (squadsRealFilter.value !== squadsReal) squadsRealFilter.value = squadsReal;
      squadsRealFilter.setAttribute('aria-label', `Real Telegram members: ${realLabel}`);
    }
    if (squadsRealPod) squadsRealPod.dataset.on = String(squadsReal !== 'all');

    const gameLabel = SQUAD_GAME_LABEL[squadsGame];
    if (squadsGameV) squadsGameV.textContent = gameLabel;
    if (squadsGameFilter) {
      if (squadsGameFilter.value !== squadsGame) squadsGameFilter.value = squadsGame;
      squadsGameFilter.setAttribute('aria-label', `In-game squad members: ${gameLabel}`);
    }
    if (squadsGamePod) squadsGamePod.dataset.on = String(squadsGame !== 'all');

    if (squadsQClear) squadsQClear.hidden = !squadsQuery;

    if (squadsSourceEl) {
      squadsSourceEl.textContent = squadsBusy && !squadsReady
        ? 'READING…'
        : squadsOn ? 'LIVE REGISTRY' : 'NO REGISTRY';
      squadsSourceEl.dataset.live = String(squadsOn);
    }
    if (squadsRefresh) {
      squadsRefresh.dataset.busy = String(squadsBusy);
      squadsRefresh.disabled = squadsBusy;
      squadsRefresh.setAttribute('aria-busy', String(squadsBusy));
      squadsRefresh.setAttribute('aria-label', squadsBusy ? 'Refreshing squad registry' : 'Refresh squad registry');
      squadsRefresh.title = squadsBusy ? 'Refreshing squad registry…' : 'Refresh squad registry';
    }

    const visible = squadsRows.filter(squadMatches);
    if (squadsTotalEl) {
      squadsTotalEl.textContent = !squadsReady
        ? '—'
        : visible.length === squadsRows.length
          ? `${figure(squadsRows.length)} ${squadsRows.length === 1 ? 'squad' : 'squads'}`
          : `${figure(visible.length)} of ${figure(squadsRows.length)} squads`;
    }

    if (squadsList) {
      squadsList.textContent = '';
      const frag = document.createDocumentFragment();
      for (const row of visible) frag.append(squadCard(row));
      squadsList.append(frag);
    }

    if (squadsEmpty) {
      const show = !squadsReady || visible.length === 0;
      squadsEmpty.hidden = !show;
      squadsEmpty.setAttribute('aria-busy', String(squadsBusy));
      if (show) {
        if (!squadsReady) {
          if (squadsEmptyTitle) {
            squadsEmptyTitle.textContent = squadsBusy
              ? 'Reading the squad registry…'
              : 'Squad registry unavailable';
          }
          if (squadsEmptySub) {
            squadsEmptySub.textContent = squadsBusy
              ? 'The Worker is being asked for its live registry.'
              : 'The Worker did not answer. No local or demo registry is substituted — refresh once it is reachable.';
          }
        } else {
          if (squadsEmptyTitle) squadsEmptyTitle.textContent = 'No squads in this view';
          if (squadsEmptySub) {
            squadsEmptySub.textContent = squadsRows.length === 0
              ? 'No channel or group has enlisted yet. The first registration lands here.'
              : 'Widen the type, verification or member-count filter, or clear the search.';
          }
        }
        if (squadsReset) squadsReset.hidden = !squadsReady;
      }
    }
  }

  /** Read the whole registry. The last good rows stay on screen when nothing answers. */
  async function refreshSquads(announce = false): Promise<boolean> {
    if (squadsBusy) return false;
    squadsBusy = true;
    paintSquads();
    try {
      const page = await fetchSquads();
      squadsOn = !!page;
      if (page) {
        squadsRows = page.squads;
        squadsTotals = page.totals;
        squadsReady = true;
      }
      if (!page && announce) {
        notify('error');
        api.note('The squad registry is not answering — no local or demo rows are substituted.', true, 3000);
      }
      return !!page;
    } finally {
      squadsBusy = false;
      paintSquads();
    }
  }

  /** One audit command: the row updates in place, then the pulse folds from the rows held. */
  async function runSquadAction(id: string, action: SquadAction): Promise<void> {
    if (squadsBusy) return;
    const row = squadsRows.find((s) => s.id === id);
    if (!row) return;
    squadsBusy = true;
    impact('medium');
    paintSquads();
    try {
      const result = await pushSquadAction(id, action);
      if (result.state === 'ok') {
        squadsRows = squadsRows.map((s) => (s.id === result.squad.id ? result.squad : s));
        squadsTotals = foldSquadTotals(squadsRows);
        squadsOn = true;
        squadsReady = true;
        if (action === 'VERIFY') {
          notify('success');
          api.note(`${row.name} verified — admin ownership confirmed.`, false, 2600);
        } else if (action === 'REVOKE') {
          notify('warning');
          api.note(`${row.name} verification revoked. War TIQ keeps counting until purged.`, false, 3000);
        } else if (action === 'BAN') {
          notify('warning');
          api.note(`${row.name} purged from the Channel War.`, false, 2600);
        } else {
          notify('success');
          api.note(`${row.name} restored to the war — back in the pending review queue.`, false, 3000);
        }
      } else {
        notify('error');
        if (result.state === 'denied') {
          api.note('SuperAdmin access required — this session can read the registry only.', true, 3200);
        } else if (result.state === 'refused') {
          api.note(SQUAD_ACTION_ERROR[result.error] ?? 'The Worker refused that command.', true, 3000);
        } else {
          api.note('The Worker is not answering — no change was made.', true, 3000);
        }
      }
    } finally {
      squadsBusy = false;
      paintSquads();
    }
  }

  /** Ban and revoke ask first; verify and restore are one tap. */
  function requestSquadAction(id: string, action: SquadAction): void {
    const row = squadsRows.find((s) => s.id === id);
    if (!row || squadsBusy) return;
    if (action === 'BAN') {
      openConfirm(
        'Purge squad from war?',
        `${row.name} will stop contributing War TIQ immediately. The registry row stays for the audit trail.`,
        'Purge from War',
        () => void runSquadAction(id, action),
      );
      return;
    }
    if (action === 'REVOKE') {
      openConfirm(
        'Revoke verification?',
        `The verified admin badge on ${row.name} will be revoked. Its War TIQ keeps counting until you purge it.`,
        'Revoke Verification',
        () => void runSquadAction(id, action),
      );
      return;
    }
    void runSquadAction(id, action);
  }

  function resetSquadFilters(): void {
    squadsType = 'all';
    squadsStatus = 'all';
    squadsReal = 'all';
    squadsGame = 'all';
    squadsQuery = '';
    openSquad = '';
    if (squadsQ) squadsQ.value = '';
    if (squadsQClear) squadsQClear.hidden = true;
    if (squadsRealFilter) squadsRealFilter.value = 'all';
    if (squadsGameFilter) squadsGameFilter.value = 'all';
    impact('light');
    paintSquads();
  }

  /* ---------- Stars Vault & Payouts (worker/matchmaker.ts) ---------- */

  const VAULT_STATUS_TEXT: Record<VaultStatus, string> = {
    waiting: 'Waiting',
    paid: 'Paid',
    rejected: 'Rejected',
  };

  const VAULT_ACTION_ERROR: Record<string, string> = {
    bad_id: 'That request id is not one the ledger holds.',
    bad_action: 'The Worker does not know that command.',
    already_decided: 'That request was already settled — the queue has moved on.',
    not_found: 'No request or flagged account with that id.',
  };

  /** `Nov 9, 14:05` — when a request was filed or settled, in this device's timezone. */
  const vaultWhen = (ms: number): string => (ms > 0
    ? new Date(ms).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    })
    : '—');

  function vaultCell(value: string, label: string): HTMLElement {
    const cell = document.createElement('span');
    cell.className = 'adm-vault-cell';
    const b = document.createElement('b');
    b.dir = 'ltr';
    b.textContent = value;
    const k = document.createElement('span');
    k.textContent = label;
    cell.append(b, k);
    return cell;
  }

  function vaultRequestCard(row: VaultRequest): HTMLElement {
    const li = document.createElement('li');
    li.className = 'adm-vault-req';
    li.dataset.vault = row.requestId;
    li.dataset.status = row.status;

    const head = document.createElement('div');
    head.className = 'adm-vault-h';
    const who = document.createElement('span');
    who.className = 'adm-vault-who';
    const name = document.createElement('b');
    name.className = 'adm-vault-name';
    name.dir = 'auto';
    name.textContent = row.playerName || row.playerId;
    const id = document.createElement('span');
    id.className = 'adm-vault-id';
    id.dir = 'ltr';
    id.textContent = row.playerId;
    who.append(name, id);
    const status = document.createElement('span');
    status.className = 'adm-vault-st';
    status.dataset.status = row.status;
    status.textContent = VAULT_STATUS_TEXT[row.status];
    head.append(who, status);

    const cells = document.createElement('div');
    cells.className = 'adm-vault-cells';
    cells.append(
      vaultCell(`${figure(row.amount)} Stars`, 'Amount'),
      vaultCell(vaultWhen(row.createdAt), 'Requested'),
    );
    if (row.status !== 'waiting') cells.append(vaultCell(vaultWhen(row.decidedAt), 'Settled'));

    li.append(head, cells);

    if (row.status === 'waiting') {
      const actions = document.createElement('div');
      actions.className = 'adm-vault-actions';
      const pay = document.createElement('button');
      pay.type = 'button';
      pay.className = 'adm-btn adm-btn-gold';
      pay.dataset.vaultAction = 'PAID';
      pay.textContent = 'Mark Paid';
      pay.disabled = vaultBusy;
      pay.title = 'Record that you have settled this request yourself. Nothing is transferred here.';
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'adm-btn adm-btn-danger';
      reject.dataset.vaultAction = 'REJECT';
      reject.textContent = 'Reject';
      reject.disabled = vaultBusy;
      reject.title = 'Refuse the request and return its Stars to the player’s vault balance.';
      actions.append(pay, reject);
      li.append(actions);
    }
    return li;
  }

  function vaultFlagCard(row: VaultFlag): HTMLElement {
    const li = document.createElement('li');
    li.className = 'adm-vault-flag';
    li.dataset.vault = row.id;

    const head = document.createElement('div');
    head.className = 'adm-vault-h';
    const who = document.createElement('span');
    who.className = 'adm-vault-who';
    const name = document.createElement('b');
    name.className = 'adm-vault-name';
    name.dir = 'auto';
    name.textContent = row.name || row.id;
    const by = document.createElement('span');
    by.className = 'adm-vault-id';
    by.dir = 'auto';
    by.textContent = row.inviterName ? `invited by ${row.inviterName}` : row.inviterId;
    who.append(name, by);
    const ratio = document.createElement('span');
    ratio.className = 'adm-vault-st';
    ratio.dataset.status = 'revoked';
    ratio.dir = 'ltr';
    ratio.textContent = `${figure(row.ratio)}% inside`;
    ratio.title = 'Share of this account’s valid matches played against its own inviter or fellow invitees.';
    head.append(who, ratio);

    const cells = document.createElement('div');
    cells.className = 'adm-vault-cells';
    cells.append(
      vaultCell(figure(row.matches), 'Matches'),
      vaultCell(figure(row.clusterMatches), 'In cluster'),
      vaultCell(`${figure(row.heldStars)} Stars`, 'Held'),
    );

    const actions = document.createElement('div');
    actions.className = 'adm-vault-actions';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'adm-btn';
    clear.dataset.vaultAction = 'CLEAR';
    clear.textContent = 'Clear Flag';
    clear.disabled = vaultBusy;
    clear.title = 'Accept the review: release the held stages and stop the ratio re-flagging this account.';
    actions.append(clear);

    li.append(head, cells, actions);
    return li;
  }

  function paintVault(): void {
    const totals = vaultPage?.totals ?? null;
    const pending = vaultBusy && !vaultReady;
    const figureOr = (v: number | undefined): string => (v == null ? (pending ? '…' : '—') : figure(v));

    if (vaultKpiEarned) vaultKpiEarned.textContent = figureOr(totals?.earned);
    if (vaultKpiEarnedSub) {
      vaultKpiEarnedSub.textContent = totals
        ? `${figure(totals.inviters)} vaults · ${figure(totals.queued)} Stars queued`
        : '—';
    }
    if (vaultKpiPaid) vaultKpiPaid.textContent = figureOr(totals?.paid);
    if (vaultKpiPaidSub) vaultKpiPaidSub.textContent = totals ? 'settled by hand' : '—';
    if (vaultKpiWaiting) vaultKpiWaiting.textContent = figureOr(totals?.waiting);
    if (vaultKpiWaitingSub) {
      vaultKpiWaitingSub.textContent = totals ? `${figure(totals.waitingStars)} Stars to settle` : '—';
    }
    if (vaultKpiBudget) vaultKpiBudget.textContent = figureOr(totals?.budgetLeft);
    if (vaultKpiBudgetSub) {
      vaultKpiBudgetSub.textContent = totals
        ? `${figure(totals.budgetSpent)} / ${figure(totals.budget)} spent`
        : '—';
    }
    if (vaultMonthEl) vaultMonthEl.textContent = totals?.monthKey || '—';

    for (const chip of vaultChips) {
      chip.setAttribute('aria-pressed', String((chip.dataset.vfilter ?? 'waiting') === vaultFilter));
    }
    if (vaultSourceEl) {
      vaultSourceEl.textContent = pending ? 'READING…' : vaultOn ? 'LIVE LEDGER' : 'NO LEDGER';
      vaultSourceEl.dataset.live = String(vaultOn);
    }
    if (vaultRefresh) {
      vaultRefresh.dataset.busy = String(vaultBusy);
      vaultRefresh.disabled = vaultBusy;
    }

    const rows = vaultPage?.requests ?? [];
    const visible = vaultFilter === 'all' ? rows : rows.filter((r) => r.status === vaultFilter);
    if (vaultTotalEl) {
      vaultTotalEl.textContent = pending
        ? 'Reading the payout queue…'
        : `${figure(visible.length)} of ${figure(rows.length)} requests`;
    }
    if (vaultList) {
      vaultList.textContent = '';
      const frag = document.createDocumentFragment();
      for (const row of visible) frag.append(vaultRequestCard(row));
      vaultList.append(frag);
    }
    if (vaultEmpty) {
      vaultEmpty.hidden = visible.length > 0;
      vaultEmpty.textContent = pending
        ? 'Reading the payout queue…'
        : vaultOn
          ? 'No payout requests in this view.'
          : 'The Stars Vault ledger is not answering — no local or demo rows are substituted.';
    }

    const flags = vaultPage?.flagged ?? [];
    if (vaultFlagMeta) {
      vaultFlagMeta.textContent = totals ? `${figure(flags.length)} held` : '—';
    }
    if (vaultFlags) {
      vaultFlags.textContent = '';
      const frag = document.createDocumentFragment();
      for (const row of flags) frag.append(vaultFlagCard(row));
      vaultFlags.append(frag);
    }
    if (vaultFlagEmpty) vaultFlagEmpty.hidden = flags.length > 0;
  }

  async function refreshVault(announce = false): Promise<boolean> {
    if (vaultBusy) return false;
    vaultBusy = true;
    paintVault();
    try {
      const page = await fetchVault();
      vaultOn = !!page;
      if (page) {
        vaultPage = page;
        vaultReady = true;
      }
      if (!page && announce) {
        notify('error');
        api.note('The Stars Vault ledger is not answering — no local or demo rows are substituted.', true, 3000);
      }
      return !!page;
    } finally {
      vaultBusy = false;
      paintVault();
    }
  }

  async function runVaultAction(id: string, action: VaultAction): Promise<void> {
    if (vaultBusy) return;
    vaultBusy = true;
    impact('medium');
    paintVault();
    try {
      const result = await pushVaultAction(id, action);
      if (result.state === 'ok') {
        vaultPage = result.page;
        vaultOn = true;
        vaultReady = true;
        if (action === 'PAID') {
          notify('success');
          api.note('Marked paid — record the transfer yourself; the app moved no Stars.', false, 3000);
        } else if (action === 'REJECT') {
          notify('warning');
          api.note('Request rejected — its Stars are back in the player’s vault balance.', false, 3000);
        } else {
          notify('success');
          api.note('Flag cleared — the held stages are released and the ratio will not re-raise it.', false, 3000);
        }
      } else {
        notify('error');
        if (result.state === 'denied') {
          api.note('SuperAdmin access required — this session can read the payout queue only.', true, 3200);
        } else if (result.state === 'refused') {
          api.note(VAULT_ACTION_ERROR[result.error] ?? 'The Worker refused that command.', true, 3000);
        } else {
          api.note('The Worker is not answering — no change was made.', true, 3000);
        }
      }
    } finally {
      vaultBusy = false;
      paintVault();
    }
  }

  /** Both settling keys ask first: one records a payment, the other gives Stars back. */
  function requestVaultAction(id: string, action: VaultAction): void {
    const row = vaultPage?.requests.find((r) => r.requestId === id);
    if (action === 'PAID' && row) {
      openConfirm(
        'Mark this payout settled?',
        `${row.playerName || row.playerId} asked for ${figure(row.amount)} Stars. Confirm only once you have paid them yourself — the app transfers nothing.`,
        'Mark Paid',
        () => void runVaultAction(id, action),
      );
      return;
    }
    if (action === 'REJECT' && row) {
      openConfirm(
        'Reject this payout?',
        `${figure(row.amount)} Stars returns to ${row.playerName || row.playerId}’s vault balance and they may ask again.`,
        'Reject Request',
        () => void runVaultAction(id, action),
      );
      return;
    }
    if (action === 'CLEAR') {
      const flag = vaultPage?.flagged.find((f) => f.id === id);
      openConfirm(
        'Clear this collusion flag?',
        `${flag?.name || id} played ${figure(flag?.ratio ?? 0)}% of valid matches inside their own invite cluster. Clearing releases up to ${figure(flag?.heldStars ?? 0)} Stars and stops the ratio re-flagging them.`,
        'Clear Flag',
        () => void runVaultAction(id, action),
      );
      return;
    }
    void runVaultAction(id, action);
  }

  /* ---------- VIP Storefront & Revenue (worker/matchmaker.ts) ---------- */

  const VIP_PLAN_LABEL: Record<VipPlanId, string> = {
    '7d': '7 Days',
    '30d': '30 Days',
    '90d': '90 Days',
  };

  const isVipPlanId = (value: string | undefined): value is VipPlanId =>
    value !== undefined && (VIP_PLAN_IDS as readonly string[]).includes(value);

  function vipRowOf(id: VipPlanId): HTMLElement | null {
    return vipPlanRows.find((row) => row.dataset.vipPlan === id) ?? null;
  }

  function paintVipState(text: string, tone: 'idle' | 'ok' | 'bad' = 'idle'): void {
    if (!vipAdminState) return;
    vipAdminState.textContent = text;
    vipAdminState.dataset.tone = tone;
  }

  function paintVipToggle(id: VipPlanId): void {
    const row = vipRowOf(id);
    if (!row) return;
    const toggle = row.querySelector<HTMLButtonElement>('[data-vip-toggle]');
    const label = row.querySelector<HTMLElement>('[data-vip-toggle-label]');
    const enabled = vipConfig[id].enabled;
    row.dataset.on = String(enabled);
    if (toggle) toggle.setAttribute('aria-checked', String(enabled));
    if (label) label.textContent = enabled ? 'ON' : 'OFF';
  }

  function paintVipRow(id: VipPlanId): void {
    const row = vipRowOf(id);
    if (!row) return;
    const input = row.querySelector<HTMLInputElement>('[data-vip-price]');
    if (input) input.value = String(vipConfig[id].stars);
    paintVipToggle(id);
  }

  function paintVipRows(ids: readonly VipPlanId[] = VIP_PLAN_IDS): void {
    for (const id of ids) paintVipRow(id);
  }

  /** One transaction row: monogram + name, tier, Stars, date and whether that term still runs. */
  function vipPurchaseRow(row: VipPurchase): HTMLTableRowElement {
    const tr = document.createElement('tr');
    const who = document.createElement('td');
    const user = document.createElement('span');
    user.className = 'vipadm-user';
    const monogram = document.createElement('span');
    monogram.className = 'vipadm-mono';
    const display = row.username || row.userId;
    monogram.textContent = (display.replace(/^@/, '').trim().charAt(0) || '?').toUpperCase();
    const name = document.createElement('span');
    name.className = 'vipadm-user-t';
    name.textContent = display;
    name.title = display;
    user.append(monogram, name);
    who.append(user);

    const plan = document.createElement('td');
    plan.textContent = VIP_PLAN_LABEL[row.planId];

    const stars = document.createElement('td');
    stars.className = 'vipadm-num';
    stars.textContent = vipFigure(row.stars);
    stars.title = figure(row.stars);

    const date = document.createElement('td');
    date.className = 'vipadm-date';
    date.textContent = row.purchasedAt > 0
      ? new Date(row.purchasedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '—';

    const status = document.createElement('td');
    const pill = document.createElement('span');
    const active = row.expiresAt > Date.now();
    pill.className = 'vipadm-status';
    pill.dataset.state = active ? 'on' : 'off';
    pill.textContent = active ? 'Active' : 'Expired';
    status.append(pill);

    tr.append(who, plan, stars, date, status);
    return tr;
  }

  function paintVipPurchases(rows: readonly VipPurchase[]): void {
    if (vipRecentMeta) vipRecentMeta.textContent = rows.length ? `Last ${rows.length}` : 'No receipts';
    if (vipRecentEmpty) vipRecentEmpty.hidden = rows.length > 0;
    if (!vipRecentBody) return;
    vipRecentBody.replaceChildren(...rows.map(vipPurchaseRow));
  }

  /** A revenue figure that stays inside a narrow chip; the exact count rides its tooltip. */
  const vipFigure = (n: number): string => {
    const value = Math.max(0, Math.round(n));
    if (value < 100_000) return figure(value);
    if (value < 1_000_000) return `${Math.round(value / 100) / 10}k`;
    if (value < 1_000_000_000) return `${Math.round(value / 100_000) / 10}M`;
    return `${Math.round(value / 100_000_000) / 10}B`;
  };

  function paintVipFigure(el: HTMLElement | null, value: number): void {
    if (!el) return;
    el.textContent = vipFigure(value);
    el.title = figure(value);
  }

  function paintVipStats(): void {
    if (!vipStats) return;
    paintVipFigure(vipKpiActive, vipStats.totalSubscribers);
    paintVipFigure(vipKpiStars, vipStats.totalStarsEarned);
    paintVipFigure(vipKpiOrders, vipStats.allTimePurchases);
    for (const row of vipPlanRows) {
      const id = row.dataset.vipPlan;
      if (!isVipPlanId(id)) continue;
      const tier = vipStats.tierBreakdown[id];
      paintVipFigure(row.querySelector<HTMLElement>('[data-vip-sold]'), tier.count);
      paintVipFigure(row.querySelector<HTMLElement>('[data-vip-gross]'), tier.starsGrossed);
    }
    paintVipPurchases(vipStats.recentPurchases);
  }

  function paintVipAdmin(): void {
    paintVipRows();
    paintVipStats();
  }

  /**
   * Read the sheet and the ledger together. The controls stay usable during the read, and a
   * refusal leaves the last answered values on screen rather than painting a comfortable zero.
   */
  async function refreshVipAdmin(announce = false): Promise<void> {
    if (vipLoading) return;
    vipLoading = true;
    const seq = ++vipSeq;
    paintVipState('Syncing…');
    try {
      const [config, stats] = await Promise.all([fetchVipConfig(), fetchVipStats()]);
      if (seq !== vipSeq) return;
      if (config) {
        vipConfig = config;
        paintVipRows();
      }
      if (stats) {
        vipStats = stats;
        paintVipStats();
        /* a receipt that lands while the stage is up refreshes the live feed as well */
        if (stats.recentPurchases.length > 0) {
          activityPurchases = stats.recentPurchases;
          foldActivity();
        }
      }
      if (config && stats) paintVipState('Synced · live', 'ok');
      else if (config) paintVipState('Sheet synced · sales unavailable');
      else if (stats) paintVipState('Sales synced · sheet unavailable');
      else paintVipState('Unavailable', 'bad');
      if (announce) {
        if (config && stats) api.note('VIP revenue synced with the Worker.', false, 2000);
        else api.note('The VIP revenue read did not answer. Nothing was changed.', true, 2600);
      }
    } finally {
      vipLoading = false;
    }
  }

  /**
   * Persist one tier — its price and its storefront switch — and echo the room's saved sheet.
   * A toggle-only save keeps the last saved price when the input is mid-edit, so flipping the
   * switch can never be blocked by a half-typed number.
   */
  async function saveVipPlan(id: VipPlanId, toggleOnly = false): Promise<void> {
    if (vipBusy) return;
    const row = vipRowOf(id);
    const input = row?.querySelector<HTMLInputElement>('[data-vip-price]');
    const toggle = row?.querySelector<HTMLButtonElement>('[data-vip-toggle]');
    const saveBtn = row?.querySelector<HTMLButtonElement>('[data-vip-save]');
    if (!row || !input || !toggle) return;

    const draft = Number(input.value);
    let stars = draft;
    if (toggleOnly) {
      if (!Number.isInteger(draft) || draft < 1) stars = vipConfig[id].stars;
    } else if (!Number.isInteger(stars) || stars < 1) {
      impact('light');
      notify('error');
      api.note('Enter a whole Stars price of at least 1.', true, 2600);
      input.focus({ preventScroll: true });
      return;
    }
    const enabled = toggle.getAttribute('aria-checked') === 'true';

    vipSeq++;
    vipBusy = true;
    paintVipState('Saving…');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.classList.add('is-busy');
    }
    try {
      const result = await pushVipConfig(id, stars, enabled);
      if (!result.config) {
        paintVipToggle(id);
        paintVipState('Save failed', 'bad');
        notify('error');
        api.note(`Plan not saved — ${result.detail}`, true, 3600);
        return;
      }
      vipConfig = result.config;
      vipSeq++;
      paintVipRow(id);
      paintVipState('Saved · live', 'ok');
      notify('success');
      api.note(
        `${VIP_PLAN_LABEL[id]} saved · ${stars} Stars · ${enabled ? 'on sale' : 'hidden from the store'}.`,
        false,
        2600,
      );
    } finally {
      vipBusy = false;
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.classList.remove('is-busy');
      }
    }
  }

  /* ---------- the mandatory channel gate ---------- */

  function paintForceJoin(): void {
    if (fjToggle) {
      fjToggle.setAttribute('aria-checked', String(forceJoin.forceJoinEnabled));
      fjToggle.disabled = forceJoinBusy;
    }
    /* Never clobber a channel the operator is still typing into. */
    if (fjChannel && document.activeElement !== fjChannel) fjChannel.value = forceJoin.targetChannel;
    if (fjPill) {
      fjPill.dataset.on = String(forceJoin.forceJoinEnabled);
      if (fjPillLabel) fjPillLabel.textContent = forceJoin.forceJoinEnabled ? 'ACTIVE' : 'DISABLED';
    }
    if (fjSave) fjSave.disabled = forceJoinBusy;
    if (fjNote) {
      fjNote.textContent = forceJoinBusy
        ? 'Saving to the Worker…'
        : forceJoinLoaded
          ? forceJoin.forceJoinEnabled
            ? 'Live · a player outside the channel meets the gate.'
            : 'Off · the arena is open to everyone.'
          : forceJoinFailed
            ? 'The Worker did not answer — the gate state is unknown.'
            : 'Reading the Worker…';
    }
  }

  /** Read the Worker's row. A failed read leaves the last answered state on screen. */
  async function refreshForceJoin(): Promise<void> {
    if (forceJoinBusy || forceJoinDirty) return;
    const next = await fetchForceJoin();
    /* A draft typed while the read was in flight outranks its answer. */
    if (forceJoinBusy || forceJoinDirty) return;
    if (!next) {
      forceJoinFailed = true;
      if (fjState) {
        fjState.textContent = 'Unavailable';
        fjState.dataset.tone = 'off';
      }
      paintForceJoin();
      return;
    }
    forceJoin = next;
    forceJoinLoaded = true;
    forceJoinFailed = false;
    if (fjState) {
      fjState.textContent = 'Synced · live';
      fjState.dataset.tone = 'ok';
    }
    paintForceJoin();
  }

  /** Commit the draft. Only a SuperAdmin may write; the room answers the refusal itself. */
  async function saveForceJoin(): Promise<void> {
    if (forceJoinBusy) return;
    const channel = (fjChannel?.value ?? forceJoin.targetChannel).trim();
    if (!channel) {
      notify('error');
      api.note('Enter the target channel before saving the gate.', true, 2800);
      fjChannel?.focus({ preventScroll: true });
      return;
    }

    forceJoinBusy = true;
    forceJoinDirty = true;
    if (fjState) {
      fjState.textContent = 'Saving…';
      fjState.dataset.tone = '';
    }
    paintForceJoin();

    const result = await pushForceJoin({ ...forceJoin, targetChannel: channel });
    forceJoinBusy = false;

    if (result.state === 'denied') {
      notify('error');
      api.note('SuperAdmin access required to change the channel gate.', true, 2800);
      if (fjState) {
        fjState.textContent = 'Denied';
        fjState.dataset.tone = 'warn';
      }
      paintForceJoin();
      return;
    }
    if (result.state === 'error') {
      notify('error');
      api.note(`The channel gate was not saved — ${result.detail}`, true, 3400);
      if (fjState) {
        fjState.textContent = 'Save failed';
        fjState.dataset.tone = 'warn';
      }
      paintForceJoin();
      return;
    }

    forceJoin = result.config;
    forceJoinLoaded = true;
    forceJoinFailed = false;
    forceJoinDirty = false;
    if (fjChannel) fjChannel.value = result.config.targetChannel;
    if (fjState) {
      fjState.textContent = 'Saved · live';
      fjState.dataset.tone = 'ok';
    }
    paintForceJoin();
    notify(result.config.forceJoinEnabled ? 'warning' : 'success');
    api.note(
      result.config.forceJoinEnabled
        ? `Channel gate ACTIVE · ${result.config.targetChannel} is now mandatory.`
        : 'Channel gate disabled · the arena is open.',
      false,
      3000,
    );
  }

  fjToggle?.addEventListener('click', () => {
    if (forceJoinBusy) return;
    forceJoin = { ...forceJoin, forceJoinEnabled: !forceJoin.forceJoinEnabled };
    forceJoinDirty = true;
    impact('light');
    if (fjState) {
      fjState.textContent = 'Unsaved';
      fjState.dataset.tone = 'warn';
    }
    paintForceJoin();
  });
  fjChannel?.addEventListener('input', () => {
    if (forceJoinBusy) return;
    forceJoin = { ...forceJoin, targetChannel: fjChannel.value };
    forceJoinDirty = true;
    if (fjState) {
      fjState.textContent = 'Unsaved';
      fjState.dataset.tone = 'warn';
    }
    paintForceJoin();
  });
  fjChannel?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void saveForceJoin();
  });
  fjSave?.addEventListener('click', () => { void saveForceJoin(); });

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

  /** The values to push: the Worker's current maintenance state and this device's queue radii. */
  function serverConfig(): ServerConfig {
    return {
      maintenance: lastStatus?.config.maintenance ?? false,
      normalRadius: runtime.radiusNormal,
      wideRadius: runtime.radiusWide,
    };
  }

  const sameConfig = (a: ServerConfig | null, b: ServerConfig): boolean =>
    !!a && a.maintenance === b.maintenance && a.normalRadius === b.normalRadius && a.wideRadius === b.wideRadius;

  /** Nothing answered: the panel governs this device alone, and says what the call really did. */
  function markLocal(detail = serverDetail) {
    serverOn = false;
    serverDenied = false;
    serverDetail = detail;
    lastStatus = null;
    serverPingMs = null;
    paintServer(null);
  }

  /** The registry refused this session: show the refusal, never the "start wrangler dev" card. */
  function markDenied(detail = '') {
    serverOn = false;
    serverDenied = true;
    serverDetail = detail;
    lastStatus = null;
    serverPingMs = null;
    paintServer(null);
  }

  /** `12s` / `1m 20s`: a wait in the unit somebody would actually say it in. */
  function waited(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  const ICON_NS = 'http://www.w3.org/2000/svg';

  /** One sprite glyph as a live node, for the rows built outside the static HTML. */
  function iconNode(id: string): SVGSVGElement {
    const svg = document.createElementNS(ICON_NS, 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(ICON_NS, 'use');
    use.setAttribute('href', `#${id}`);
    svg.append(use);
    return svg;
  }

  /** The glyph that reads a roster line's kind at a glance. */
  function rosterIcon(cls: string, matchId?: string): string {
    if (matchId) return cls === 'is-multi' ? 'i-users' : 'i-swords';
    if (cls === 'is-lobby') return 'i-globe';
    return 'i-target';
  }

  /** One roster line: a kind glyph, a name, a metadata line, and the Abort key for a live match. */
  function rosterRow(name: string, meta: string, matchId?: string, cls = ''): HTMLLIElement {
    const li = document.createElement('li');
    li.className = ['adm-server-row', matchId ? 'is-room' : '', cls].filter(Boolean).join(' ');
    const icon = document.createElement('span');
    icon.className = 'adm-server-i';
    icon.setAttribute('aria-hidden', 'true');
    icon.append(iconNode(rosterIcon(cls, matchId)));
    const txt = document.createElement('span');
    txt.className = 'adm-server-txt';
    const n = document.createElement('span');
    n.className = 'adm-server-n';
    n.textContent = name;
    const m = document.createElement('span');
    m.className = 'adm-server-m';
    m.textContent = meta;
    txt.append(n, m);
    li.append(icon, txt);
    if (matchId) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'adm-btn adm-abort';
      btn.dataset.abort = matchId;
      btn.textContent = 'Abort';
      btn.setAttribute('aria-label', `Abort room ${matchId}`);
      li.append(btn);
    }
    return li;
  }

  /** A non-interactive heading inside the inspector well, with its own count. */
  function groupRow(label: string, count: number, tone: 'mint' | 'sky' | 'honey' = 'mint'): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'adm-server-group';
    li.dataset.tone = tone;
    li.setAttribute('role', 'presentation');
    const t = document.createElement('span');
    t.textContent = label;
    const b = document.createElement('b');
    b.textContent = String(count);
    li.append(t, b);
    return li;
  }

  /** The well's quiet state: one emblem, one plain sentence of what it means. */
  function emptyRow(title: string, body: string, icon = 'i-bolt'): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'adm-server-empty';
    const chip = document.createElement('span');
    chip.className = 'adm-server-empty-i';
    chip.setAttribute('aria-hidden', 'true');
    chip.append(iconNode(icon));
    const b = document.createElement('b');
    b.textContent = title;
    const p = document.createElement('span');
    p.className = 'adm-server-empty-b';
    p.textContent = body;
    li.append(chip, b, p);
    return li;
  }

  /** The Refresh key's spinner and label, on the one flag both the key and the beat share. */
  function paintServerBusy() {
    if (serverRefresh) {
      serverRefresh.dataset.busy = String(serverBusy);
      serverRefresh.setAttribute('aria-disabled', String(serverBusy));
    }
    if (serverRefreshLabel) serverRefreshLabel.textContent = serverBusy ? 'Refreshing…' : 'Refresh';
  }

  /**
   * The whole Server tab from one reading (or its absence): the glowing LIVE WORKER lamp, the
   * round trip, the four counters, the maintenance switch and the room/lobby/queue inspector.
   */
  function paintServer(status: ServerStatus | null, pingMs: number | null = serverPingMs) {
    const live = !!status;
    const denied = !live && !serverBusy && serverDenied;
    /* A Worker that answered at all - even to refuse or to fail - is a live Worker. */
    const gone = !live && !denied && !serverBusy && serverUnreachable;
    const maint = status ? status.config.maintenance : false;
    if (serverCard) {
      serverCard.dataset.state = live ? 'live' : denied ? 'denied' : serverBusy ? 'connecting' : 'offline';
      serverCard.dataset.maint = String(maint);
    }
    if (serverChip) {
      serverChip.textContent = live ? 'LIVE'
        : denied ? 'DENIED'
          : serverBusy ? 'CONNECTING'
            : gone ? 'OFFLINE' : 'ERROR';
    }
    if (serverOffline) serverOffline.hidden = live || serverBusy || denied;

    if (serverState) {
      serverState.textContent = live
        ? (status.config.maintenance ? 'Matchmaking paused' : 'Accepting players')
        : denied ? 'Admin access required'
          : serverBusy ? 'Connecting…'
            : gone ? 'Worker offline' : 'Worker answered with an error';
    }
    if (serverStateSub) {
      serverStateSub.textContent = live
        ? `Updated ${clockOf(status.timestamp ?? Date.now())}`
        : denied
          ? `The role registry refused this session${serverDetail ? ` (${serverDetail})` : ''} — sign in as an administrator.`
          : serverBusy
            ? 'Reading the Durable Object…'
            : serverDetail
              ? capFirst(serverDetail)
              : 'No telemetry from the Durable Object';
    }
    if (serverPing) {
      serverPing.textContent = live && pingMs !== null ? String(Math.max(0, Math.round(pingMs))) : '—';
      serverPing.dataset.tone = !live || pingMs === null ? 'off' : pingMs < 80 ? 'good' : pingMs < 220 ? 'warm' : 'bad';
    }

    const oneVsOne = status
      ? (status.active1v1 ?? (status.activeRooms ?? []).filter((r) => (r.kind ?? ((r.players ?? 2) > 2 ? 'room' : '1v1')) === '1v1').length)
      : null;
    if (serverQueue) serverQueue.textContent = status ? String(status.queueCount) : '—';
    if (serverRooms) serverRooms.textContent = oneVsOne !== null ? String(oneVsOne) : '—';
    if (serverTotalRooms) serverTotalRooms.textContent = status ? String(status.activeMatchesCount) : '—';
    if (serverLobbies) serverLobbies.textContent = status ? String(status.openLobbies?.length ?? 0) : '—';

    if (serverMaintenance) {
      serverMaintenance.setAttribute('aria-checked', String(maint));
      serverMaintenance.dataset.on = String(maint);
    }
    if (serverMaintState) serverMaintState.textContent = maint ? 'On' : 'Off';
    if (serverMeta) {
      const lobbyCount = status?.openLobbies?.length ?? 0;
      serverMeta.textContent = live
        ? `${status.activeRooms?.length ?? 0} live · ${lobbyCount} ${lobbyCount === 1 ? 'lobby' : 'lobbies'} · ${status.queueCount} queued`
        : denied
          ? 'Access denied'
          : 'Offline';
    }

    if (!serverList) return;
    serverList.textContent = '';
    if (!status) {
      if (denied) serverList.append(emptyRow('Access denied', 'Live telemetry requires an administrator session.', 'i-lock'));
      else if (serverBusy) serverList.append(emptyRow('Reading the room…', 'Waiting for the Durable Object to answer.', 'i-restart'));
      else serverList.append(emptyRow('No signal yet', 'The inspector wakes when the Worker answers.'));
      return;
    }

    const rooms = status.activeRooms ?? [];
    const lobbies = status.openLobbies ?? [];
    const queue = status.queuedPlayers ?? [];
    if (!rooms.length && !lobbies.length && !queue.length) {
      serverList.append(emptyRow('Engine idle', 'No live rooms, open lobbies, or waiting players.'));
      return;
    }

    if (rooms.length) {
      serverList.append(groupRow('Live rooms', rooms.length));
      const now = Date.now();
      for (const r of rooms) {
        const kind = r.kind ?? ((r.players ?? 2) > 2 ? 'room' : '1v1');
        const started = r.startedAt ?? status.timestamp ?? now;
        const seats = r.players && r.players > 2 ? `${r.players}p` : '1v1';
        const bots = r.bots ? ` · ${r.bots} bot${r.bots === 1 ? '' : 's'}` : '';
        const head = `${r.p0} vs ${r.p1}${r.players && r.players > 2 ? ` +${r.players - 2}` : ''}`;
        serverList.append(rosterRow(
          head,
          `#${r.matchId} · ${seats} · ${waited(Math.max(0, now - started))} · ${r.spectators ?? 0} watching · turn ${r.turn}${bots}`,
          r.matchId,
          kind === 'room' ? 'is-multi' : 'is-duel',
        ));
      }
    }

    if (lobbies.length) {
      serverList.append(groupRow('Open lobbies', lobbies.length, 'honey'));
      const now = Date.now();
      for (const l of lobbies) {
        serverList.append(rosterRow(
          `${l.friends ? 'Friends lobby' : 'Auto room'} ${l.code}`,
          `${l.joined}/${l.size} seats · open ${waited(Math.max(0, now - l.openedAt))} · fills in ${waited(Math.max(0, l.openedAt + l.waitMs - now))}`,
          undefined,
          'is-lobby',
        ));
      }
    }

    if (queue.length) {
      serverList.append(groupRow('Queue', queue.length, 'sky'));
      for (const p of queue) {
        serverList.append(rosterRow(
          p.name,
          `TIQ ${p.tiq} · ${p.wide ? 'wide net' : 'normal net'} · waiting ${waited(p.waitedMs)}`,
          undefined,
          'is-queue',
        ));
      }
    }
  }

  /** Read the room, paint it, and remember whether the Worker is really there. */
  async function refreshServer(): Promise<void> {
    if (serverBusy) return;
    serverBusy = true;
    paintServerBusy();
    if (!lastStatus) paintServer(null, null);       // connecting, not yet a dead Worker
    const reading = await fetchStatus();
    serverBusy = false;
    paintServerBusy();
    if (reading.state === 'denied') {
      serverUnreachable = false;
      markDenied(reading.detail);
      /* the admin door may be shut while the public mirror is open: read the clock anyway */
      void syncArena().then(() => paintArena());
      return;
    }
    if (reading.state === 'error') {
      serverUnreachable = reading.reason === 'offline' || reading.reason === 'no-origin';
      markLocal(reading.detail);
      void syncArena().then(() => paintArena());
      return;
    }
    serverOn = true;
    serverDenied = false;
    serverUnreachable = false;
    lastStatus = reading.status;
    serverPingMs = reading.pingMs;
    paintServer(reading.status, reading.pingMs);
    if (reading.status.arena) {
      adoptArena(reading.status.arena, true);
      paintArena();
    } else {
      void syncArena().then(() => paintArena());
    }
    await syncConfig();
  }

  /**
   * Keep the Worker's own enforcement in step with the local runtime. Only the three fields the
   * server also owns travel; anything else the panel changes is a device-local matter. With no
   * Worker answering there is nothing to sync, and the panel simply stays offline.
   */
  async function syncConfig(): Promise<void> {
    if (!serverOn) return;
    const want = serverConfig();
    if (sameConfig(lastPushed, want)) return;
    const applied = await pushConfig(want);
    if (applied.state === 'ok') {
      lastPushed = applied.config;
      if (lastStatus) lastStatus = { ...lastStatus, config: applied.config };
    } else if (applied.state === 'denied') {
      /* A Moderator cannot change the Worker's knobs, but the Worker is still answering: keep the
         live reading and remember the attempt so the beat does not retry the same refused patch. */
      lastPushed = want;
    } else {
      markLocal();
    }
  }

  /** The Server tab's live beat. It only reads while the stage is open and this panel is visible. */
  function startServerPolling() {
    stopServerPolling();
    serverTimer = window.setInterval(() => {
      if (!open || document.hidden || serverPanel?.hidden) return;
      void refreshServer();
    }, 5_000);
  }

  function stopServerPolling() {
    if (!serverTimer) return;
    window.clearInterval(serverTimer);
    serverTimer = 0;
  }

  /** Pause or resume the Worker's matchmaker. This is a server-only control. */
  async function toggleServerMaintenance(): Promise<void> {
    const current = lastStatus?.config.maintenance ?? false;
    const next = !current;
    if (!serverOn && serverDenied) {
      notify('error');
      api.note('SuperAdmin access required to change the maintenance lock.', true, 2800);
      return;
    }
    if (!serverOn) {
      notify('error');
      api.note('The Worker is offline — the maintenance lock is unchanged.', true, 2800);
      paintServer(lastStatus, serverPingMs);
      return;
    }
    if (serverBusy) return;
    impact(next ? 'medium' : 'light');
    serverBusy = true;
    paintServerBusy();
    const applied = await pushConfig({ ...serverConfig(), maintenance: next });
    serverBusy = false;
    paintServerBusy();
    if (applied.state === 'denied') {
      notify('error');
      api.note('SuperAdmin access required to change the maintenance lock.', true, 2800);
      paintServer(lastStatus, serverPingMs);
      return;
    }
    if (applied.state === 'error') {
      markLocal();
      notify('error');
      api.note('The maintenance lock did not reach the Worker.', true, 2800);
      return;
    }
    lastPushed = applied.config;
    if (lastStatus) lastStatus = { ...lastStatus, config: applied.config };
    paintServer(lastStatus, serverPingMs);
    notify(applied.config.maintenance ? 'warning' : 'success');
    api.note(
      applied.config.maintenance
        ? 'Maintenance ON — new queues are paused and waiting seats dismissed.'
        : 'Maintenance OFF — matchmaking resumed.',
      false,
      2800,
    );
    await refreshServer();
  }

  /** Empty the room's queue on the server, then read it back so the roster agrees. */
  async function clearQueue(): Promise<void> {
    impact('medium');
    const result = await serverAction({ action: 'CLEAR_QUEUE' });
    if (result === 'denied') {
      notify('error');
      api.note('SuperAdmin access required to flush the queue.', true, 2800);
      paintServer(lastStatus, serverPingMs);
      return;
    }
    if (result === 'refused') {
      notify('warning');
      api.note('The Worker refused the queue flush.', true, 2400);
      await refreshServer();
      return;
    }
    if (result === 'error') {
      markLocal();
      notify('error');
      api.note('Flush Queue failed — the Worker is not answering.', true, 2400);
      return;
    }
    notify('success');
    api.note('Queue flushed on the server.', false, 2000);
    await refreshServer();
  }

  /** Pull one stuck room: both seats are told, and the room stops existing. */
  async function abortMatch(matchId: string): Promise<void> {
    if (!matchId) return;
    impact('medium');
    const result = await serverAction({ action: 'ABORT_MATCH', matchId });
    if (result === 'denied') {
      notify('error');
      api.note('SuperAdmin access required to abort a room.', true, 2800);
      paintServer(lastStatus, serverPingMs);
      return;
    }
    if (result === 'refused') {
      notify('warning');
      api.note('That room is no longer live — the board has already closed.', false, 2400);
      await refreshServer();
      return;
    }
    if (result === 'error') {
      markLocal();
      notify('error');
      api.note('Abort failed — the Worker is not answering.', true, 2400);
      return;
    }
    notify('success');
    api.note(`Room ${matchId} aborted.`, false, 2000);
    await refreshServer();
  }

  /* ---------- the arena & tournament board ---------- */

  const ARENA_ERROR: Record<string, string> = {
    forbidden: 'SuperAdmin access required.',
    unknown_action: 'The Worker did not recognize that command.',
  };

  /**
   * One arena edit: optimistic on this device, then the Worker is told. Offline is a real mode —
   * the panel still governs this device and says so, exactly like every other switch here.
   */
  async function commitArena(patch: Partial<ArenaState>, success = '', quiet = false): Promise<boolean> {
    const seq = ++arenaSeq;
    setArenaLocal(patch);
    paintArena();
    if (!serverOn) {
      if (!quiet) api.note('Saved on this device — the Worker is not answering.', false, 2400);
      return false;
    }
    const reply = await pushArena({ patch });
    if (seq !== arenaSeq) return false;
    if (reply?.ok && reply.arena) {
      adoptArena(reply.arena, true);
      paintArena();
      if (success) api.note(success, false, 2000);
      return true;
    }
    if (!reply) {
      markLocal();
      if (!quiet) api.note('Saved on this device — the Worker did not answer.', true, 2600);
    } else {
      if (lastStatus?.arena) adoptArena(lastStatus.arena, true);
      paintArena();
      api.note(ARENA_ERROR[reply.error ?? ''] ?? 'The Worker refused the change.', true, 2600);
    }
    return false;
  }

  /** The season as the on-device directory sees it, for a reset with no Worker behind the page. */
  function localSeasonReset(): ArenaReply & { ok: true } {
    const page = directoryPage({
      q: '', filter: 'all', country: '', age: 'all', plan: 'all', sort: 'tiq', offset: 0, limit: 50,
    }, liveSeat());
    const order = [...page.players].sort((a, b) => b.tiq - a.tiq || b.wins - a.wins || a.id.localeCompare(b.id));
    const old = arena();
    const now = Date.now();
    const nextNo = Math.min(999, old.seasonNo + 1);
    const snapshot: ArenaSnapshot = {
      seasonNo: old.seasonNo,
      seasonName: old.seasonName,
      takenAt: now,
      total: page.total,
      entries: order.slice(0, 50).map((p, i) => ({
        rank: i + 1, id: p.id, name: p.name, tiq: p.tiq, wins: p.wins,
      })),
    };
    setArenaLocal({
      status: 'active',
      matchLocked: false,
      seasonNo: nextNo,
      seasonName: nextSeasonName(old.seasonName, nextNo),
      endsAt: now + SEASON_LENGTH_MS,
      updatedAt: now,
      lastSnapshot: snapshot,
      awardsCount: page.total,
    });
    paintArena();
    return { ok: true, arena: arena(), snapshot, awards: page.total };
  }

  /** Finalize, snapshot, award, roll. The confirm has already been answered. */
  async function resetSeasonNow(): Promise<void> {
    if (arenaBusy) return;
    arenaBusy = true;
    impact('medium');
    notify('warning');
    const before = arena();
    try {
      if (!serverOn) {
        const local = localSeasonReset();
        notify('success');
        api.note(`Season ${before.seasonNo} rolled to ${local.arena?.seasonNo ?? before.seasonNo + 1} on this device — no Worker to push prizes.`, false, 3400);
        return;
      }
      const reply = await pushArena({ action: 'SEASON_RESET' });
      if (reply?.ok && reply.arena) {
        adoptArena(reply.arena, true);
        paintArena();
        notify('success');
        const next = reply.arena.seasonNo;
        const awards = reply.awards ?? reply.arena.awardsCount;
        api.note(
          `Season ${before.seasonNo} finalized — snapshot banked, ${awards.toLocaleString('en-US')} awards pushed. Season ${next} is open.`,
          false,
          3800,
        );
      } else if (!reply) {
        markLocal();
        api.note('Reset failed — the Worker did not answer. Nothing was rolled.', true, 3000);
      } else {
        api.note(ARENA_ERROR[reply.error ?? ''] ?? 'The Worker refused the reset.', true, 3000);
      }
    } finally {
      arenaBusy = false;
    }
  }

  /** Freeze the arena now: no new entries, the queue dismissed, every socket told. */
  async function forceStopNow(): Promise<void> {
    if (arenaBusy) return;
    arenaBusy = true;
    impact('medium');
    notify('warning');
    setArenaLocal({ status: 'maintenance', matchLocked: true });
    paintArena();
    try {
      if (!serverOn) {
        api.note('Arena frozen on this device — no Worker means no clients to notify.', true, 3200);
        return;
      }
      const reply = await pushArena({ action: 'FORCE_STOP' });
      if (reply?.ok && reply.arena) {
        adoptArena(reply.arena, true);
        paintArena();
        const n = reply.dismissed ?? 0;
        api.note(
          `Arena frozen. ${n} waiting ${n === 1 ? 'seat' : 'seats'} dismissed; every connected client was notified.`,
          false,
          3200,
        );
      } else if (!reply) {
        markLocal();
        api.note('Force-stop reached this device only — the Worker did not answer.', true, 3000);
      } else {
        api.note(ARENA_ERROR[reply.error ?? ''] ?? 'The Worker refused the force-stop.', true, 3000);
      }
    } finally {
      arenaBusy = false;
    }
  }

  /* ---------- the FAB ---------- */

  /** Show or hide every Command Center door this viewer is entitled to. */
  function paintDoor(): void {
    const allowed = isAdmin();
    if (fab) fab.hidden = !allowed;
    if (profileSec) profileSec.hidden = !allowed;
    if (profileBtn) profileBtn.hidden = !allowed;
  }

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
    paintDoor();
    /* the registry just opened the door: the counter starts reading from this moment */
    void refreshActivity();
  }

  /**
   * Rest the key on the Play Dock's top edge, right-aligned. The dock is the anchor —
   * close enough that the shield reads as part of the bottom action stack rather than
   * floating in whatever gap the column happens to leave above it.
   */
  function placeFab() {
    if (!fab || !home) return;
    const launcher = home.querySelector<HTMLElement>('.launcher');
    if (!launcher) return;
    const hr = home.getBoundingClientRect();
    const lr = launcher.getBoundingClientRect();
    if (!hr.height || !lr.height) return;
    fab.style.bottom = `${Math.max(4, Math.round(hr.bottom - lr.top + 4))}px`;
  }

  /* ---------- open / close ---------- */

  function openStage() {
    if (!stage || open) return;
    open = true;
    /* Opening the Command Center IS reading it: the watermark moves and the counter drops to
       zero on the tap itself, before a single fetch lands. Nothing restores it on close. */
    viewedAt = markAdminViewed();
    markActivityRead();
    window.clearTimeout(hideId);
    stage.hidden = false;
    void stage.offsetWidth;               // lay the stage out at its closed position first
    stage.classList.add('open');
    document.documentElement.classList.add('admin-open');
    paintAll();
    startArenaClock();
    startTelemetry();
    startServerPolling();
    void refreshMetrics();                // the Stats tab reads the strict metrics door
    void refreshServer();                 // the Server tab reads `/api/admin/matchmaking`
    void refreshForceJoin();              // the channel gate's durable row
    void refreshActivity();               // the directory + Stars ledger behind the FAB counter
    /* The stage reopens on whichever tab was last selected; a registry view must not reopen on a
       snapshot that predates the latest enlistment. */
    const lastTab = tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.atab;
    if (lastTab === 'squads') void refreshSquads();
    if (lastTab === 'controls') { void refreshVipAdmin(); void refreshVault(); }
    closeBtn?.focus({ preventScroll: true });
    api.onToggle(true);
    impact('medium');
  }

  /** A stage close or a tab move must never leave a menu floating over the next panel. */
  function closeCustomSelects(): void {
    usersCountrySelect?.close(false);
    usersAgeSelect?.close(false);
    usersSortSelect?.close(false);
  }

  function closeStage() {
    if (!stage || !open) return;
    closeCustomSelects();
    stopArenaClock();
    stopTelemetry();
    stopServerPolling();
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
    closeCustomSelects();
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

  /* ---------- Controls sub-tabs: general, arena, season ---------- */

  type CtrlTabId = 'switches' | 'arena' | 'season';
  const CTRL_TAB_KEY = 'detour.admin.ctrl.v1';
  const isCtrlTab = (v: string | undefined): v is CtrlTabId =>
    v === 'switches' || v === 'arena' || v === 'season';

  function readCtrlTab(): CtrlTabId {
    try {
      const raw = window.sessionStorage.getItem(CTRL_TAB_KEY) ?? '';
      return isCtrlTab(raw) ? raw : 'switches';
    } catch {
      return 'switches';
    }
  }

  /** One view at a time; every panel's bindings stay live because the DOM is never rebuilt. */
  function selectCtrlTab(id: CtrlTabId): void {
    for (const t of ctrlTabs) {
      const on = t.dataset.ctrlTab === id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
    for (const view of ctrlViews) {
      const on = view.dataset.ctrlView === id;
      if (on) {
        view.hidden = false;
        view.classList.remove('is-visible');
        void view.offsetWidth;              // restart the fade on every entry
        view.classList.add('is-visible');
      } else {
        view.hidden = true;
        view.classList.remove('is-visible');
      }
    }
    try {
      window.sessionStorage.setItem(CTRL_TAB_KEY, id);
    } catch {
      /* storage refused: the view still switches */
    }
  }

  for (const t of ctrlTabs) {
    t.addEventListener('click', () => {
      const id = t.dataset.ctrlTab;
      if (!isCtrlTab(id)) return;
      impact('light');
      selectCtrlTab(id);
    });
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const i = ctrlTabs.indexOf(t);
      const step = e.key === 'ArrowRight' ? 1 : -1;
      const next = ctrlTabs[(i + step + ctrlTabs.length) % ctrlTabs.length];
      const nextId = next?.dataset.ctrlTab;
      if (!next || !isCtrlTab(nextId)) return;
      next.focus();
      selectCtrlTab(nextId);
    });
  }
  selectCtrlTab(readCtrlTab());

  /* ---------- wiring ---------- */

  fab?.addEventListener('click', openStage);
  profileBtn?.addEventListener('click', () => {
    impact('light');
    openStage();
  });
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
      /* the Server tab reads the roster; the Stats tab reads the strict telemetry route */
      if (id === 'server') void refreshServer();
      if (id === 'stats') {
        paintStats();
        void refreshMetrics();
      }
      /* the Inbox is device-local: a repaint keeps the relative timestamps honest */
      if (id === 'inbox') {
        paintInbox();
        /* opening the activity feed is what reads its rows */
        markActivityRead();
        paintActivity();
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
      /* The squad registry is re-read on every entry: an enlistment made after an earlier,
         empty or refused read must appear without a manual refresh. */
      if (id === 'squads') {
        paintSquads();
        void refreshSquads();
      }
      /* the role registry rides the same rule: first sight of Controls reads it */
      if (id === 'controls') {
        if (!aclAsked) {
          aclAsked = true;
          void refreshAcl();
        }
        void refreshVipAdmin();
        void refreshForceJoin();
        void refreshVault();
      }
    });
  }

  /* the VIP plan sheet: a price edit saves with its tier's key, the switch flips the draft */
  for (const row of vipPlanRows) {
    const id = row.dataset.vipPlan;
    if (!isVipPlanId(id)) continue;
    const toggle = row.querySelector<HTMLButtonElement>('[data-vip-toggle]');
    toggle?.addEventListener('click', () => {
      if (vipBusy) return;
      const next = toggle.getAttribute('aria-checked') !== 'true';
      toggle.setAttribute('aria-checked', String(next));
      row.dataset.on = String(next);
      const label = row.querySelector<HTMLElement>('[data-vip-toggle-label]');
      if (label) label.textContent = next ? 'ON' : 'OFF';
      impact('light');
      void saveVipPlan(id, true);
    });
    row.querySelector<HTMLButtonElement>('[data-vip-save]')?.addEventListener('click', () => {
      void saveVipPlan(id);
    });
    row.querySelector<HTMLInputElement>('[data-vip-price]')?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void saveVipPlan(id);
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

  /* the Users tab: the filter chips, the advanced toolbar, the search, the cards and Load More */
  const paintChipState = () => {
    for (const c of userChips) {
      const pressed = usersPlan === 'all' && (c.dataset.ufilter ?? 'all') === usersFilter;
      c.setAttribute('aria-pressed', String(pressed));
    }
    usersVipChip?.setAttribute('aria-pressed', String(usersPlan === 'active'));
  };

  /** A toolbar move repaints on the local index immediately; the zero-delay task only folds doubles. */
  const scheduleAdvRefresh = () => {
    window.clearTimeout(usersAdvTimer);
    usersAdvTimer = window.setTimeout(() => void refreshUsers(true), 0);
  };

  function resetUserFilters(): void {
    usersFilter = 'all';
    usersQuery = '';
    usersCountry = '';
    usersAge = 'all';
    usersPlan = 'all';
    usersSort = 'default';
    openPlayer = '';
    window.clearTimeout(usersTimer);
    window.clearTimeout(usersAdvTimer);
    if (usersQ) usersQ.value = '';
    if (usersQClear) usersQClear.hidden = true;
    paintChipState();
    syncAdvanced();
    impact('light');
    void refreshUsers(true);
  }

  for (const chip of userChips) {
    chip.addEventListener('click', () => {
      const next = (chip.dataset.ufilter ?? 'all') as DirFilter;
      if (next === usersFilter && usersPlan === 'all') return;
      const previous = usersFilter;
      usersFilter = next;
      /* the standard chips are whole views: a plan left over from the VIP shortcut or the
         dropdown clears with them, so one chip is always the view on screen */
      usersPlan = 'all';
      if (next === 'tiq' || next === 'stars') usersSort = next;
      else if (previous === 'tiq' || previous === 'stars') usersSort = 'default';
      openPlayer = '';
      paintChipState();
      syncAdvanced();
      impact('light');
      void refreshUsers(true);
    });
  }

  /* the gold chip is the one-tap shortcut for All Active VIP: it lights while that view holds */
  usersVipChip?.addEventListener('click', () => {
    const next: VipPlanFilter = usersPlan === 'active' ? 'all' : 'active';
    usersPlan = next;
    if (next === 'active') usersFilter = 'all';
    openPlayer = '';
    paintChipState();
    syncAdvanced();
    impact('light');
    void refreshUsers(true);
  });

  /* the native plan selector: one duration tier, active/free, or an ended term */
  usersPlanEl?.addEventListener('change', () => {
    const next = vipPlanFilterOf(usersPlanEl.value);
    usersPlan = next;
    /* the plan dropdown is a whole view: a quick activity chip yields to it */
    if (next !== 'all') usersFilter = 'all';
    openPlayer = '';
    paintChipState();
    syncAdvanced();
    impact('light');
    scheduleAdvRefresh();
  });

  /* the three advanced pods: custom listboxes whose menus live in the stage, never in the scroll body */
  if (usersCountryTrig && usersCountryMenu) {
    usersCountrySelect = makeCustomSelect(stage, {
      trigger: usersCountryTrig,
      menu: usersCountryMenu,
      options: countryOptions,
      selected: () => usersCountry,
      onPick: (value) => {
        const code = value.trim().toUpperCase();
        usersCountry = /^[A-Z]{2}$/.test(code) ? code : '';
        openPlayer = '';
        impact('light');
        syncAdvanced();
        scheduleAdvRefresh();
      },
    });
  }

  if (usersAgeTrig && usersAgeMenu) {
    usersAgeSelect = makeCustomSelect(stage, {
      trigger: usersAgeTrig,
      menu: usersAgeMenu,
      options: () => AGE_BANDS.map((value) => ({ value, label: AGE_LABEL[value], chip: AGE_CHIP[value] })),
      selected: () => usersAge,
      onPick: (value) => {
        const next = value as AgeBand;
        usersAge = AGE_BANDS.includes(next) ? next : 'all';
        openPlayer = '';
        impact('light');
        syncAdvanced();
        scheduleAdvRefresh();
      },
    });
  }

  if (usersSortTrig && usersSortMenu) {
    usersSortSelect = makeCustomSelect(stage, {
      trigger: usersSortTrig,
      menu: usersSortMenu,
      options: () => SORTS.map((value) => ({ value, label: SORT_MENU[value].label, icon: SORT_MENU[value].icon })),
      selected: () => usersSort,
      onPick: (value) => {
        const next = value as DirSort;
        usersSort = SORTS.includes(next) ? next : 'default';
        /* the Top TIQ and Top Stars chips are only shortcuts: choosing another order leaves them for All Players */
        if (usersFilter === 'tiq' && usersSort !== 'tiq') {
          usersFilter = 'all';
          paintChipState();
        }
        if (usersFilter === 'stars' && usersSort !== 'stars' && usersSort !== 'stars_asc') {
          usersFilter = 'all';
          paintChipState();
        }
        openPlayer = '';
        impact('light');
        syncAdvanced();
        scheduleAdvRefresh();
      },
    });
  }

  usersReset?.addEventListener('click', resetUserFilters);

  /* typing is debounced once: a query read per keystroke would race the rows that are landing */
  usersQ?.addEventListener('input', () => {
    usersQuery = usersQ.value.trim().slice(0, 64);
    if (usersQClear) usersQClear.hidden = !usersQuery;
    openPlayer = '';
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
  /* the directory's own refresh key: one full first-page read, never a second click mid-flight */
  usersRefresh?.addEventListener('click', () => {
    if (usersPending > 0) return;
    window.clearTimeout(usersTimer);
    window.clearTimeout(usersAdvTimer);
    impact('light');
    void refreshUsers(true, true);
  });
  usersPrune?.addEventListener('click', () => {
    void pruneGhosts();
  });
  syncUsersRefresh();

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

  /* the Squads tab: real-time search, four filter axes, and one delegated audit listener */
  squadsQ?.addEventListener('input', () => {
    squadsQuery = squadsQ.value.slice(0, 80);
    if (squadsQClear) squadsQClear.hidden = !squadsQuery;
    openSquad = '';
    paintSquads();
  });
  squadsQClear?.addEventListener('click', () => {
    squadsQuery = '';
    if (squadsQ) {
      squadsQ.value = '';
      squadsQ.focus({ preventScroll: true });
    }
    if (squadsQClear) squadsQClear.hidden = true;
    openSquad = '';
    impact('light');
    paintSquads();
  });
  for (const chip of squadTypeChips) {
    chip.addEventListener('click', () => {
      const next = chip.dataset.sqtype;
      if (next !== 'all' && next !== 'channel' && next !== 'group') return;
      if (next === squadsType) return;
      squadsType = next;
      openSquad = '';
      impact('light');
      paintSquads();
    });
  }
  for (const chip of squadStatusChips) {
    chip.addEventListener('click', () => {
      const next = chip.dataset.sqstatus;
      if (next !== 'all' && next !== 'verified' && next !== 'pending' && next !== 'revoked') return;
      if (next === squadsStatus) return;
      squadsStatus = next;
      openSquad = '';
      impact('light');
      paintSquads();
    });
  }

  /* the two member-count selectors: the real Telegram audience and the joined in-game roster */
  squadsRealFilter?.addEventListener('change', () => {
    const next = asSquadRealBand(squadsRealFilter.value);
    if (next === squadsReal) return;
    squadsReal = next;
    openSquad = '';
    impact('light');
    paintSquads();
  });
  squadsGameFilter?.addEventListener('change', () => {
    const next = asSquadGameBand(squadsGameFilter.value);
    if (next === squadsGame) return;
    squadsGame = next;
    openSquad = '';
    impact('light');
    paintSquads();
  });

  squadsReset?.addEventListener('click', resetSquadFilters);
  squadsRefresh?.addEventListener('click', () => {
    if (squadsBusy) return;
    impact('light');
    void refreshSquads(true);
  });
  squadsList?.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const btn = el.closest<HTMLButtonElement>('[data-squad-action]');
    if (btn) {
      const card = btn.closest<HTMLElement>('[data-squad]');
      const action = btn.dataset.squadAction;
      if (!card || (action !== 'VERIFY' && action !== 'REVOKE' && action !== 'BAN' && action !== 'UNBAN')) return;
      requestSquadAction(card.dataset.squad ?? '', action);
      return;
    }
    const open = el.closest<HTMLButtonElement>('[data-squad-open]');
    if (!open) return;
    const id = open.dataset.squadOpen ?? '';
    if (!id) return;
    openSquad = openSquad === id ? '' : id;
    impact('light');
    paintSquads();
  });
  squadsList?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openSquad) {
      /* the stage's own Escape must not close the whole panel while a row is open */
      e.stopPropagation();
      openSquad = '';
      paintSquads();
    }
  });

  /* The payout queue and the review slab: both lists are rebuilt on every paint, so one delegated
     listener each is all that ever holds — no handler outlives its card. */
  const vaultActionFrom = (e: Event): void => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-vault-action]');
    if (!btn) return;
    const card = btn.closest<HTMLElement>('[data-vault]');
    const action = btn.dataset.vaultAction;
    if (!card || (action !== 'PAID' && action !== 'REJECT' && action !== 'CLEAR' && action !== 'FLAG')) return;
    requestVaultAction(card.dataset.vault ?? '', action);
  };
  vaultList?.addEventListener('click', vaultActionFrom);
  vaultFlags?.addEventListener('click', vaultActionFrom);
  for (const chip of vaultChips) {
    chip.addEventListener('click', () => {
      const next = chip.dataset.vfilter;
      if (next !== 'all' && next !== 'waiting' && next !== 'paid' && next !== 'rejected') return;
      vaultFilter = next;
      impact('light');
      paintVault();
    });
  }
  vaultRefresh?.addEventListener('click', () => {
    if (vaultBusy) return;
    impact('light');
    void refreshVault(true);
  });

  /* the telemetry key: one reading at a time, with the spinner riding the same flag */
  statRefresh?.addEventListener('click', () => {
    if (metricsBusy) return;
    impact('light');
    void refreshMetrics();
  });

  /* the trend chart: a timeframe switch, a metric row, a slice filter and one pointer over the plot */
  for (const key of statTrendKeys) {
    key.addEventListener('click', () => {
      const range = key.dataset.grange;
      if (range === '24h' || range === '7d' || range === '30d') setTrendRange(range);
    });
  }
  for (const chip of statTrendSeries) {
    chip.addEventListener('click', () => {
      const key = trendSeriesKey(chip.dataset.gseries);
      /* a pod the current slice cannot fill is not on screen, so it cannot be pressed either */
      if (!key || !trendMetricsOf(trendMode).includes(key)) return;
      setTrendMetric(key);
    });
  }
  for (const key of statTrendModes) {
    key.addEventListener('click', () => {
      /* the group carries three segments; anything else in `data-gmode` is markup drift, not a
         slice this card can read */
      const raw = key.dataset.gmode;
      if (raw !== 'all' && raw !== 'pvp' && raw !== 'bot') return;
      setTrendMode(raw);
    });
  }
  statTrendSvg?.addEventListener('pointerdown', (e) => trendInspect(e.clientX));
  statTrendSvg?.addEventListener('pointermove', (e) => trendInspect(e.clientX));
  statTrendSvg?.addEventListener('pointerleave', (e) => {
    /* a lifted finger leaves its reading on screen; only a mouse leaving the plot clears it */
    if (e.pointerType === 'mouse') setTrendFocus(-1);
  });
  statTrendSvg?.addEventListener('pointercancel', () => setTrendFocus(-1));

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
  serverMaintenance?.addEventListener('click', () => { void toggleServerMaintenance(); });
  /* every Abort is delegated: the roster is rebuilt on each read, so no handler outlives its row */
  serverList?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-abort]');
    if (btn) void abortMatch(btn.dataset.abort ?? '');
  });

  /* ---------- Arena & tournament wiring ---------- */

  for (const key of arenaStateKeys) {
    key.addEventListener('click', () => {
      const status = key.dataset.arenaState as ArenaStatus | undefined;
      const current = arena();
      if (!status) return;
      /* Active is also the unlock key: it only counts as a no-op when the queue is already open. */
      if (status === current.status && (status !== 'active' || !current.matchLocked)) return;
      impact(status === 'active' ? 'light' : 'medium');
      /* Active is the one state that also reopens the queue; the other two close it. */
      void commitArena(
        { status, matchLocked: status !== 'active' },
        status === 'active' ? 'Arena open — matchmaking resumed.' : status === 'finale' ? 'Season finale — entries closed.' : 'Arena locked — new entries stopped.',
      );
    });
  }

  arenaLockBtn?.addEventListener('click', () => {
    const next = !arena().matchLocked;
    impact(next ? 'medium' : 'light');
    notify(next ? 'warning' : 'success');
    void commitArena(
      { matchLocked: next },
      next ? 'Matchmaking locked.' : arena().status === 'active' ? 'Matchmaking reopened.' : 'Lock switch released; the arena state still holds entries closed.',
    );
  });

  function applySeasonName(): void {
    const raw = (arenaSeasonName?.value ?? '').trim();
    const a = arena();
    if (raw.length < 2) {
      api.note('Give the season a title first.', true, 2200);
      paintArena();
      return;
    }
    const no = seasonNoFrom(raw, a.seasonNo);
    if (raw === a.seasonName && no === a.seasonNo) return;
    void commitArena({ seasonName: raw, seasonNo: no }, `Season ${no} saved.`);
  }

  arenaSeasonName?.addEventListener('change', applySeasonName);
  arenaSeasonName?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      arenaSeasonName.blur();
    }
  });

  function applyDivisions(): void {
    const rows: ArenaDivisionRule[] = [];
    let prev = -1;
    for (const id of ARENA_TIER_IDS) {
      const input = arenaDivInputs.find((el) => el.dataset.divMin === id);
      const value = id === 'bronze' ? 0 : Math.floor(Number(input?.value));
      if (!Number.isFinite(value) || value <= prev || value > 1_000_000) {
        impact('light');
        notify('error');
        api.note('Division thresholds must rise, from Bronze upward.', true, 2800);
        paintArena();
        return;
      }
      rows.push({ id, min: value });
      prev = value;
    }
    void commitArena({ divisions: rows }, 'Arena division thresholds saved.');
  }

  for (const input of arenaDivInputs) {
    input.addEventListener('change', applyDivisions);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
    });
  }

  const HUMAN_HOURS: Record<string, string> = { '6': '6 hours', '24': '24 hours', '72': '3 days', '168': '7 days' };
  for (const btn of arenaPresets) {
    btn.addEventListener('click', () => {
      const hours = Number(btn.dataset.preset);
      if (!Number.isFinite(hours) || hours <= 0) return;
      impact('light');
      const base = Math.max(Date.now(), arena().endsAt);
      void commitArena({ endsAt: base + hours * 3600_000 }, `Season extended by ${HUMAN_HOURS[String(hours)] ?? `${hours} hours`}.`);
    });
  }

  function applyExactEnd(): void {
    const ms = parseDatetimeLocal(arenaEnds?.value ?? '');
    if (ms === null) {
      api.note('Pick an exact end date and time.', true, 2400);
      arenaEnds?.focus({ preventScroll: true });
      return;
    }
    if (ms <= Date.now()) {
      api.note('The season end must be in the future.', true, 2600);
      arenaEnds?.focus({ preventScroll: true });
      return;
    }
    const when = new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    void commitArena({ endsAt: ms }, `Season now ends ${when}.`);
  }

  arenaEndsApply?.addEventListener('click', applyExactEnd);
  arenaEnds?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyExactEnd();
    }
  });

  arenaResetBtn?.addEventListener('click', () => {
    impact('medium');
    const a = arena();
    const title = a.seasonName.trim().toLowerCase().startsWith('season')
      ? a.seasonName
      : `Season ${a.seasonNo} — ${a.seasonName}`;
    const scope = serverOn
      ? 'every registered player is ranked, sent a TIQ award and a season badge'
      : 'the Worker is offline, so the snapshot and rollover stay on this device';
    openConfirm(
      'Force season reset?',
      `${title} closes immediately. A top-50 snapshot is banked, ${scope}, and Season ${Math.min(999, a.seasonNo + 1)} opens with a fresh 28-day clock. This cannot be undone.`,
      'Reset Season',
      () => void resetSeasonNow(),
    );
  });

  arenaStopBtn?.addEventListener('click', () => {
    impact('medium');
    openConfirm(
      'Emergency force-stop?',
      'New matchmaking stops immediately and every waiting seat is dismissed. Every connected client is told over the live socket. Races already on a board play out.',
      'Force-Stop',
      () => void forceStopNow(),
    );
  });

  /* Escape closes one layer at a time: the confirm dialog, then a drawer, then the stage. */
  onArena(() => {
    if (open) paintArena();
  });

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
    closeStage();
  });

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
    impact('medium');
    notify('success');
    api.note(`+${got} TIQ granted.`, false, 2200);
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
  /* every activity string is built from t(): a language change rebuilds the cards and
     the FAB's spoken label rather than leaving one translated surface behind */
  onLang(() => paintActivity());
  onRuntime(() => {
    /* Both queue radii are the server's too: a local change pushes the new values to
       `POST /admin/config`. Offline, `syncConfig` is a no-op. */
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
  document.addEventListener('visibilitychange', () => {
    onResize();
    /* coming back to the Mini App: spend one read rather than trusting a reading from minutes ago */
    if (document.visibilityState !== 'visible' || !open) return;
    if (!statsPanel?.hidden) void refreshMetrics();
    if (!serverPanel?.hidden) void refreshServer();
  });

  return {
    open: openStage,
    close: closeStage,
    get isOpen() {
      return open;
    },
    mount() {
      paintDoor();
      if (stage) mountCoins(stage);
      recordVisit();                       // the day's first sighting of this device
      paintAll();
      /* Only an entitled viewer reads the admin routes: a player who never sees the FAB
         must never fire `/admin/players` or `/api/admin/vip/stats` at app boot. */
      if (isAdmin()) void refreshActivity();
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
