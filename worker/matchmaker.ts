/**
 * matchmaker.ts — the waiting room, and the race that follows it.
 *
 * Pairing is a plain in-memory pass over the queue, cheapest fairness first:
 *
 *   1. two minds within 250 TIQ of each other always race, whoever is asking;
 *   2. if either side widened after a quiet wait, the net opens to 600 TIQ;
 *   3. if *both* have widened, anyone left is a fair race (nobody who kept the filter on is
 *      dragged into a lopsided one — they are still waiting for their own tier).
 *
 * Two sides of the same race must also be the same game, so a board size that does not match never
 * pairs: a 2v2 player waits for another 2v2 rather than being dropped onto a 1v1 board.
 *
 * A matched pair stays on the SAME socket they queued on — one connection carries the queue, the
 * match and then the race. The room itself is authoritative: it runs the shared rules
 * (`src/rules.ts`, the same module the client plays) from the match's seed, so every `MOVE` is
 * judged against the real board before it is relayed, the turn it arrives on is checked, and the
 * action the opponent receives is the one the server accepted — never a client's own wording of
 * it. A refused move answers `{ type: "REJECT", reason }` and changes nothing.
 *
 * Seats, sides and the seed all come out of the match id, so both players are told the same race
 * and a replay of the same pairing derives the same numbers. The queue is in memory: it is a
 * waiting room, not a record, and a socket that dies is a player who stopped waiting.
 *
 * ---------- rooms: 2 to 4 seats, humans and bots in any mix ----------
 *
 * A socket that asks for `?room=<n>` is not a queue entry at all: it takes a seat in a multi-seat
 * room, which is the same lobby model the client runs (`src/room.ts`). Seats fill as people arrive;
 * the moment the room is full it launches, and when the wait timer runs out first, every seat still
 * empty is backfilled with a bot. The timer is the object's own alarm — a Durable Object can be
 * evicted between messages, and an alarm is the one thing that survives that — so a room always
 * fills and always starts, whether or not anybody is still connected to say so.
 *
 * The race behind a room is a `RoomDriver`: it owns the authoritative board, judges every human
 * action, and plays every automated seat itself. A human's move and the machine's answer therefore
 * arrive as one batch, and a seat that was backfilled with a bot, or taken over when its person
 * left, needs no special case anywhere: the driver asks `isAutomated` and plays it.
 */
import {
  MAX_BALLS, MAX_TEAMS, apply, contendersIn, dimsFor, newGame, type Action, type GameState,
} from '../src/rules';
import {
  FORMAT_CAPACITY, FORMAT_MODE, ROOM_WAIT_MS, assignTeam, backfill, createRoom, createRoomDriver,
  defaultTeam, difficultyFor, formatOfMode, isAutomated, isLobbyFormat, launch, reflowRoom, seatHuman,
  sizesOf, type BotTier, type LobbyFormat, type Room, type RoomDriver, type RoomEvent,
} from '../src/room';
import {
  authenticate, authRequestFrom, identifyAdminRequest, isLocalhost, isMetricsMark, isSuperAdmin,
  METRICS_HEADER, verifiedTelegramUserId,
  type AdminIdentity, type AdminRole, type Identity, type MindTier,
} from './auth';
import { json, reasonOf } from './http';
import {
  normalizeChatHandle, readRegisteredSquad, verifyAndBuildSquad,
  type RegisteredSquad, type SquadVerification,
} from './squads';
import type { Env } from './env';

/* ---------- protocol ---------- */

type ClientMessage =
  | { type: 'QUEUE'; wide: boolean }
  | { type: 'WIDEN' }
  | { type: 'CANCEL' }
  | { type: 'MOVE'; action: Action }
  /* An emote off the quick-chat sheet (`src/data/phrases.ts`): relayed to the other seats as-is,
     never judged by the board — laughing does not spend a turn. */
  | { type: 'EMOTE'; emote: string }
  /* One of the six tactical lines, also off the sheet: a tongue plus a tile index, relayed as a
     pair and looked back up in the receiver's own closed table — no text crosses this wire. */
  | { type: 'PHRASE'; lang: string; index: number }
  | { type: 'RESIGN' }
  /* The room path: the host starting early, the host's size pick (2v2 / 2v1 / 3p / 4p), and a
     seat's team move — any seat may move itself, the host may move anyone. Everything else a room
     seat sends is a MOVE or a RESIGN. */
  | { type: 'ROOM_START' }
  | { type: 'SET_FORMAT'; format: LobbyFormat }
  | { type: 'SET_MODE'; mode: 'ffa' | 'team' }
  | { type: 'SET_TEAM'; side: number; team: 0 | 1 };

interface Waiter {
  ws: WebSocket;
  id: string;
  name: string;
  tiq: number;
  tier: MindTier;
  flag: string;
  /** The player asked for a wider net after a quiet queue. */
  wide: boolean;
  /** When they entered the queue: the order, and who takes side 0. */
  joinedAt: number;
  /** The board they are queuing for: both seats must be playing the same game. */
  sizes: [number, number];
  /** Set the moment they are paired: the race this socket now carries. */
  race: Race | null;
  side: 0 | 1;
}

/** A live 1v1: the two sockets, and the authoritative board they are playing. */
interface Race {
  matchId: string;
  seed: number;
  sizes: [number, number];
  /** Indexed by side: `seats[0]` opened the race. */
  seats: [Waiter, Waiter];
  /** The real state — every relayed move has been through it. */
  state: GameState;
  /** When the pairing was announced: the inspector's match clock starts here. */
  startedAt: number;
  over: boolean;
}

/* ---------- rooms ---------- */

/** One socket holding a seat in a room. A room seat never waits in the 1v1 queue. */
interface RoomMember {
  ws: WebSocket;
  /** The seat, which is also the team index the rules play it as. */
  seat: number;
  id: string;
  name: string;
  tiq: number;
  tier: MindTier;
  flag: string;
}

/**
 * A live multi-seat room: the lobby model from `src/room.ts`, the sockets holding its human seats,
 * and — once it has launched — the driver that owns the authoritative board.
 */
interface LiveRoom {
  /** The lobby: seats, the wait timer, the backfill. Frozen once `launched`. */
  room: Room;
  size: number;
  /** True once this board has been added to the durable completed-match counter. */
  counted: boolean;
  /** Indexed by seat: the socket holding it, or null while the machine holds it. */
  members: (RoomMember | null)[];
  /** Minted at launch, so both seats of every pairing derive the same numbers. */
  matchId: string;
  seed: number;
  /** When the board launched: the inspector's match clock starts here. 0 while still a lobby. */
  startedAt: number;
  /** The authoritative race. Null until the room launches. */
  driver: RoomDriver | null;
  /** The seat wearing the crown. A code lobby migrates it when the host walks out. */
  hostSeat: number;
  /** The host's size pick: 2v2 / 2v1 / 3p / 4p. `size`, `mode` and `teams` all follow it. */
  format: LobbyFormat;
  /** The format's race shape: everyone for themselves, or two teams. */
  mode: 'ffa' | 'team';
  /** Seat → team (0 blue, 1 red). Only read while `mode` is `team`. */
  teams: number[];
  /** True for a code-based friends lobby; false for the `?room=<n>` auto-pair room. */
  code: boolean;
}

/** Where a socket sits: which room, and which seat in it. */
interface RoomRef { live: LiveRoom; seat: number }

/** What a room's status row reports, on top of what a 1v1 room reports. */
export interface RoomSummary { players: number; bots: number }

/** The format a fixed-size auto-pair room reports. It never grows a selector; its size is the shape. */
const formatForSize = (size: number): LobbyFormat => (size === 3 ? '3p' : '4p');

/** The ordinary radius, and the number the room starts on. */
const TIER_RADIUS = 250;
/** The widened radius, once either side has asked for one. */
const WIDE_RADIUS = 600;

/**
 * The three knobs the Admin Command Center can move on a running server. They live on the room
 * itself, so `/admin/config` changes what the *next* pairing pass does rather than what some
 * client believes — the enforcement is here, not in the panel.
 */
export interface ServerConfig {
  /** New QUEUE attempts are refused, and everyone already waiting is sent home. */
  maintenance: boolean;
  /** The ordinary pairing band, in TIQ. */
  normalRadius: number;
  /** The relaxed band, once either side has widened. */
  wideRadius: number;
}

/* ---------- the arena & tournament state ---------- */

export type ArenaStatus = 'active' | 'maintenance' | 'finale';
export type ArenaTierId = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'challenger';

export interface ArenaDivisionRule {
  id: ArenaTierId;
  /** The lowest TIQ that wears this tier. */
  min: number;
}

export interface ArenaSnapshotEntry {
  rank: number;
  id: string;
  name: string;
  tiq: number;
  wins: number;
}

/** The final read of a season, banked on the room before the counter rolls. */
export interface ArenaSnapshot {
  seasonNo: number;
  seasonName: string;
  takenAt: number;
  total: number;
  entries: ArenaSnapshotEntry[];
}

/** One player's seasonal honor. The client claims `tiq` once per season. */
export interface SeasonAward {
  seasonNo: number;
  seasonName: string;
  rank: number;
  tiq: number;
  badge: string;
  awardedAt: number;
}

/**
 * The Admin Command Center's tournament board. Persisted under `arena` in the room's own
 * storage, so a season clock, a lock and a prize rollover survive an eviction. Matchmaking
 * reads `matchLocked` and `status` on every QUEUE — the panel only asks.
 */
export interface ArenaState {
  status: ArenaStatus;
  /** New queue entries are refused; races already under way resolve untouched. */
  matchLocked: boolean;
  seasonNo: number;
  seasonName: string;
  endsAt: number;
  divisions: ArenaDivisionRule[];
  updatedAt: number;
  lastSnapshot: ArenaSnapshot | null;
  awardsCount: number;
}

/** One seat waiting in the room, as `/admin/status` reports it. */
export interface QueuedPlayer {
  id: string;
  name: string;
  tiq: number;
  wide: boolean;
  /** How long this seat has been in the queue, in milliseconds. */
  waitedMs: number;
}

/** One live race, as `/admin/status` reports it. A room of more than two seats reports its size. */
export interface ActiveRoom {
  matchId: string;
  /** The first two display names, in seat order: `p0` opened the race. */
  p0: string;
  p1: string;
  /** Whose turn the authoritative board is on. */
  turn: number;
  /** How many seats the race fields — 2 for a duel, up to `MAX_TEAMS` for a room. */
  players?: number;
  /** How many of those seats the machine is holding. */
  bots?: number;
  /** `1v1` for a duel, `room` for a multi-seat board. */
  kind?: '1v1' | 'room';
  /** When the board started, in ms. The inspector ticks the match clock from this. */
  startedAt?: number;
  /** Watchers attached to the board. The engine has no spectator relay yet, so this is 0. */
  spectators?: number;
}

/** One room still filling its seats, as the Server tab's lobby inspector reports it. */
export interface OpenLobby {
  /** The 4-digit invite code. */
  code: string;
  /** Seats the room fields. */
  size: number;
  /** Seats a person is already holding. */
  joined: number;
  /** When the lobby opened, in ms. */
  openedAt: number;
  /** How long the lobby waits for more people. */
  waitMs: number;
  /** True for a code-based friends lobby, false for the auto-pair room. */
  friends: boolean;
}

export interface ServerStatus {
  ok: true;
  /** The room's clock when this reading was taken. */
  timestamp: number;
  queueCount: number;
  activeMatchesCount: number;
  /** Duels still being played. */
  active1v1: number;
  queuedPlayers: QueuedPlayer[];
  activeRooms: ActiveRoom[];
  /** Rooms that have not launched yet. */
  openLobbies: OpenLobby[];
  config: ServerConfig;
  arena: ArenaState;
}

/** The measured server-side telemetry `/api/admin/metrics` returns. Every number is real. */
export interface ServerMetrics {
  ok: true;
  /** The room's clock when the reading was taken. */
  timestamp: number;
  /** `production`, `development`, or the deployment's own `WORKER_ENV` label. */
  environment: string;
  /** Added by the worker edge: the real round trip through this Durable Object. */
  pingMs?: number;
  /** Launched boards: 1v1 races plus multi-seat rooms. */
  activeRooms: number;
  /** Seats sitting in the 1v1 pairing queue. */
  queueLength: number;
  /** 1v1 boards still being played. */
  active1v1: number;
  /** Rows the room currently holds in its player registry. */
  totalUsers: number;
  /** Distinct verified Telegram user ids in that registry. */
  telegramUsers: number;
  /** Boards that reached a winner since this counter was introduced. */
  matchesCompleted: number;
  /** Matches that settled in the rolling last 24 hours. */
  matches24h: number;
  /** Mine actions accepted by the authoritative board. */
  minesPlaced: number;
  /** Retired rolling-log counter; always 0. */
  logsSpawned: number;
  /** Referral joins reported across the registry. */
  referrals: number;
  /** Registry players credited with at least one referral. */
  referringPlayers: number;
  /** Players whose last activity falls inside the rolling last 24 hours. */
  dau: number;
  /** Players whose last activity falls inside the rolling last 7 days. */
  wau: number;
  /** Players whose last activity falls inside the rolling last 30 days. */
  mau: number;
  /** Active in the last 24 hours, first seen before that window: today's returning veterans. */
  returningUsersToday: number;
  /** `returningUsersToday` as a % of `dau` (0-100). */
  returningShare: number;
  /** Registry entries first seen in the rolling last 24 hours. */
  signupsToday: number;
  /** Registry entries first seen in the rolling last 7 days. */
  signupsWeek: number;
  /** Registry entries first seen in the rolling last 30 days. */
  signupsMonth: number;
  /**
   * Day-1 retention: % of players first seen at least 24 hours ago whose last activity came a
   * full day or more after that first sighting. Read from `firstSeen` / `lastSeen`, never modelled.
   */
  retentionRateD1: number;
  /** Completed matches per registered player, rounded to one decimal. */
  avgMatchesPerPlayer: number;
  /** % of registered players who finished at least one match (0-100). */
  activationRate: number;
  /** % of registered players who finished three or more matches (0-100). */
  coreRetention: number;
  /** DAU as a % of the registered playerbase (0-100). */
  dailyActiveRatio: number;
  /** Referral joins as a % of the registered playerbase, capped at 100. */
  viralShare: number;
  /** The last 24 hourly buckets, oldest first: the chart's Daily window. */
  series24h: SeriesPoint[];
  /** The last 7 daily buckets, oldest first: the chart's Weekly window. */
  series7d: SeriesPoint[];
  /** The last 30 daily buckets, oldest first: the chart's Monthly window. */
  series30d: SeriesPoint[];
  /** The sections of this reading that failed to compute and are reporting their own exact zeroes. */
  degraded: string[];
}

/**
 * Every population figure `/api/admin/metrics` reports, folded from the room's own player records.
 * Its own type because the reading is built behind a guard: a sweep that throws has to be
 * replaceable with the same shape of zeroes, not with an exception that shuts the endpoint down.
 */
type PopulationReading = Pick<
  ServerMetrics,
  | 'totalUsers' | 'telegramUsers' | 'referrals' | 'referringPlayers'
  | 'dau' | 'wau' | 'mau' | 'returningUsersToday' | 'returningShare'
  | 'signupsToday' | 'signupsWeek' | 'signupsMonth' | 'retentionRateD1'
  | 'avgMatchesPerPlayer' | 'activationRate' | 'coreRetention' | 'dailyActiveRatio' | 'viralShare'
>;

/** The population sweep, unread: exact zeroes, and no substituted number. */
const NO_POPULATION: PopulationReading = {
  totalUsers: 0,
  telegramUsers: 0,
  referrals: 0,
  referringPlayers: 0,
  dau: 0,
  wau: 0,
  mau: 0,
  returningUsersToday: 0,
  returningShare: 0,
  signupsToday: 0,
  signupsWeek: 0,
  signupsMonth: 0,
  retentionRateD1: 0,
  avgMatchesPerPlayer: 0,
  activationRate: 0,
  coreRetention: 0,
  dailyActiveRatio: 0,
  viralShare: 0,
};

/** The three growth windows, unbuilt: empty series plot an empty stretch, never a modelled one. */
const NO_SERIES: Pick<ServerMetrics, 'series24h' | 'series7d' | 'series30d'> = {
  series24h: [],
  series7d: [],
  series30d: [],
};

/**
 * One plotted bucket of the growth chart. Every count is a real measurement the room stamped or
 * folded from its own registry — a bucket the room never saw is an exact zero, never a model.
 */
export interface SeriesPoint {
  /** The bucket's opening edge in epoch ms: a UTC hour for `series24h`, a UTC day for the rest. */
  t: number;
  /** Players whose `firstSeen` falls in this bucket. */
  signups: number;
  /** Distinct players counted active in this bucket. */
  active: number;
  /** Boards that reached a verdict in this bucket. */
  matches: number;
}

/* ---------- durable gameplay counters ---------- */

/** The counters that outlive an eviction; empty storage means exact zeroes. */
interface GameMetrics {
  matchesCompleted: number;
  minesPlaced: number;
  /**
   * Match completions bucketed by UTC hour (`Math.floor(ms / 3600000)` as the key). The rolling
   * 24-hour figure is read back from these buckets, so the number is a genuine timestamped count
   * rather than a single "today" counter that forgets the previous afternoon.
   */
  matchesByHour: Record<string, number>;
}

const GAME_METRICS_KEY = 'game-metrics.v1';
/** The width of one match bucket, and how many hours of buckets stay in storage. */
const HOUR_MS = 3_600_000;
const MATCH_BUCKET_KEEP_HOURS = 8 * 24;

const zeroGameMetrics = (): GameMetrics => ({ matchesCompleted: 0, minesPlaced: 0, matchesByHour: {} });

/** A stored bucket map, clamped and pruned: only whole counts in the retained window survive. */
function readMatchHours(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const newestHour = Math.floor(Date.now() / HOUR_MS);
  const oldestHour = newestHour - MATCH_BUCKET_KEEP_HOURS;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{1,12}$/.test(key)) continue;
    const hour = Number(key);
    if (hour < oldestHour || hour > newestHour) continue;
    const count = whole(value);
    if (count > 0) out[String(hour)] = count;
  }
  return out;
}

/** A stored counter blob, clamped field by field; anything missing is zero. */
function readGameMetrics(raw: unknown): GameMetrics {
  const r = raw as Partial<GameMetrics> | null | undefined;
  return {
    matchesCompleted: whole(r?.matchesCompleted),
    minesPlaced: whole(r?.minesPlaced),
    matchesByHour: readMatchHours(r?.matchesByHour),
  };
}

/* ---------- the growth ring buffers: bounded time-series telemetry ---------- */

/**
 * One time-series bucket as three whole counts: `[signups, active, matches]`. A tuple keeps the
 * stored blob near half the size a keyed object would, which is what lets the whole series live
 * inside a couple of hundred bytes.
 */
type GrowthBucket = [number, number, number];

/**
 * The room's entire plotted history: 24 hourly rows plus 30 daily rows and nothing else. Both maps
 * are pruned on every write, so the blob is bounded by construction — it cannot grow with the
 * playerbase, and it stays well under 2 KB however many years the object lives.
 */
interface GrowthSeries {
  /** Keyed by UTC hour index (`Math.floor(ms / HOUR_MS)`); at most `HOURLY_KEEP` rows. */
  hourly: Record<string, GrowthBucket>;
  /** Keyed by UTC calendar day (`YYYY-MM-DD`); at most `DAILY_KEEP` rows. */
  daily: Record<string, GrowthBucket>;
}

const GROWTH_KEY = 'growth-series.v1';
const DAY_MS = 86_400_000;
/** The ring widths: one day of hours, one month of days. Anything older is dropped on write. */
const HOURLY_KEEP = 24;
const DAILY_KEEP = 30;

const zeroGrowth = (): GrowthSeries => ({ hourly: {}, daily: {} });

/** A UTC day index as the `YYYY-MM-DD` key the daily ring is stored under. */
const dayKeyOf = (index: number): string => new Date(index * DAY_MS).toISOString().slice(0, 10);

/** The UTC day index a timestamp falls in. */
const dayIndexOf = (ms: number): number => Math.floor(ms / DAY_MS);

/** A stored `YYYY-MM-DD` key back to its day index; a malformed key is `NaN` and gets pruned. */
function dayKeyIndex(key: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(key)
    ? Math.floor(Date.parse(`${key}T00:00:00Z`) / DAY_MS)
    : Number.NaN;
}

/** A stored bucket, clamped: only three finite whole counts ever come back out. */
function readBucket(raw: unknown): GrowthBucket | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  return [whole(raw[0]), whole(raw[1]), whole(raw[2])];
}

/**
 * Drop every row outside `[oldest, newest]`, then cap the map at `keep` rows by evicting the
 * oldest. The window check is what prunes in normal operation; the cap is the backstop that stops
 * a hand-edited or clock-skewed blob from ever outgrowing the ring.
 */
function trimRing(
  map: Record<string, GrowthBucket>,
  indexOf: (key: string) => number,
  oldest: number,
  newest: number,
  keep: number,
): void {
  for (const key of Object.keys(map)) {
    const index = indexOf(key);
    if (!Number.isFinite(index) || index < oldest || index > newest) delete map[key];
  }
  const surplus = Object.keys(map).length - keep;
  if (surplus <= 0) return;
  const ordered = Object.keys(map).sort((a, b) => indexOf(a) - indexOf(b));
  for (let i = 0; i < surplus; i++) delete map[ordered[i]];
}

/** A stored series blob, clamped and pruned to the retained window. */
function readGrowthSeries(raw: unknown, now = Date.now()): GrowthSeries {
  const r = raw as Partial<GrowthSeries> | null | undefined;
  const read = (source: unknown): Record<string, GrowthBucket> => {
    const out: Record<string, GrowthBucket> = {};
    if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      const bucket = readBucket(value);
      if (bucket && (bucket[0] || bucket[1] || bucket[2])) out[key.slice(0, 12)] = bucket;
    }
    return out;
  };
  const growth: GrowthSeries = { hourly: read(r?.hourly), daily: read(r?.daily) };
  pruneGrowth(growth, now);
  return growth;
}

/** Both rings trimmed against one clock reading, so a load and a write prune identically. */
function pruneGrowth(growth: GrowthSeries, now: number): void {
  const hour = Math.floor(now / HOUR_MS);
  trimRing(growth.hourly, Number, hour - HOURLY_KEEP + 1, hour, HOURLY_KEEP);
  const day = dayIndexOf(now);
  trimRing(growth.daily, dayKeyIndex, day - DAILY_KEEP + 1, day, DAILY_KEEP);
}

/* ---------- the player directory: who the room has seen ---------- */

/**
 * One player the room has met, as the Command Center's Users tab reads them. The record is the
 * registry entry the Worker persists into its own Durable Object storage, so the directory
 * survives an eviction the same way the room's alarm does. Race telemetry (matches, wins, losses,
 * streak) is incremented by the room itself the moment a board settles — the same authority that
 * judged the moves; the economy figures are the client's own telemetry, clamped on arrival.
 */
export interface PlayerRecord {
  /** The stable seat id: `tg-<user id>` for a verified Mini App player, `guest-<hex>` on the dev door. */
  id: string;
  /** The numeric Telegram user id, or '' for a guest seat. */
  tgId: string;
  name: string;
  username: string;
  /** ISO 3166-1 alpha-2, or ''. */
  country: string;
  /** Player-declared age, or 0 when their profile has never set one. */
  age: number;
  tiq: number;
  /** The first and last time the room saw this player, in ms. */
  firstSeen: number;
  lastSeen: number;
  /** When their last settled race ended, or 0 when they never finished one. */
  lastPlayed: number;
  matches: number;
  wins: number;
  losses: number;
  streak: number;
  best: number;
  coins: number;
  stars: number;
  referrals: number;
  /** The squad / channel handle the client reported, or ''. */
  squad: string;
  banned: boolean;
  muted: boolean;
  /** True while the player holds a seat on a live board or sits in a room that is filling. */
  inMatch: boolean;
  /** Seasonal honors the Command Center pushed, newest last (at most six). */
  awards?: SeasonAward[];
}

/** The directory views the Users tab's filter chips select. */
export type PlayerFilter = 'all' | 'active' | 'tiq' | 'flagged';

const FILTERS: readonly PlayerFilter[] = ['all', 'active', 'tiq', 'flagged'];

const filterOf = (raw: string | null): PlayerFilter =>
  (FILTERS as readonly string[]).includes(raw ?? '') ? (raw as PlayerFilter) : 'all';

/** The demographic cohorts behind the Age picker. `age` 0 never matches a named band. */
export type AgeBand = 'all' | 'u18' | '18-24' | '25-34' | '35p';

const AGE_BANDS: readonly AgeBand[] = ['all', 'u18', '18-24', '25-34', '35p'];

const ageBandOf = (raw: string | null): AgeBand =>
  (AGE_BANDS as readonly string[]).includes(raw ?? '') ? (raw as AgeBand) : 'all';

const inAgeBand = (age: number, band: AgeBand): boolean => {
  if (band === 'all') return true;
  if (age <= 0) return false;
  if (band === 'u18') return age < 18;
  if (band === '18-24') return age >= 18 && age <= 24;
  if (band === '25-34') return age >= 25 && age <= 34;
  return age >= 35;
};

/** How the directory orders the rows that survive its filters. */
export type PlayerSort = 'default' | 'lastPlayed' | 'joined' | 'tiq';

const SORTS: readonly PlayerSort[] = ['default', 'lastPlayed', 'joined', 'tiq'];

/** Null when the client sent no sort at all, so the filter's own legacy order can stand. */
const sortOf = (raw: string | null): PlayerSort | null =>
  (SORTS as readonly string[]).includes(raw ?? '') ? (raw as PlayerSort) : null;

/** One page of the directory: the window, its total, and the rows. */
export interface PlayersPage {
  ok: true;
  total: number;
  offset: number;
  limit: number;
  players: PlayerRecord[];
}

/** How many records the registry keeps before the oldest quiet one is forgotten. */
const PLAYERS_MAX = 2000;
/** The directory's own page ceiling: the panel asks for 40 at a time, a script could ask for more. */
const PLAYERS_LIMIT = 100;
/** The public Mind Ladder's read ceiling: one screen asks for five, the full board for a hundred. */
const MINDS_LIMIT = 100;
/** A day in ms: what "Active Today" means on both sides of the wire. */
const ACTIVE_MS = 24 * 60 * 60 * 1000;
/** A week in ms: the WAU / new-signup window. */
const WEEK_MS = 7 * ACTIVE_MS;
/** Thirty days in ms: the MAU / monthly-signup window. */
const MONTH_MS = 30 * ACTIVE_MS;

const whole = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

/** One decimal of a percentage, with an empty population reading exactly zero. */
const percentOf = (part: number, total: number): number =>
  total > 0 ? Math.min(100, Math.round((part / total) * 1000) / 10) : 0;

/** The numeric id behind a seat id, so the panel can search by the number a support ticket quotes. */
const tgIdOf = (id: string): string => (id.startsWith('tg-') ? id.replace(/[^0-9]/g, '').slice(0, 20) : '');

/** A seat's first registry entry. */
function freshPlayer(identity: Identity, now: number): PlayerRecord {
  return {
    id: identity.player.id,
    tgId: tgIdOf(identity.player.id),
    name: identity.player.name.slice(0, 40),
    username: identity.player.username.slice(0, 40),
    country: identity.flag.slice(0, 2),
    age: Math.min(120, Math.max(0, Math.floor(identity.age))),
    tiq: Math.max(0, Math.floor(identity.tiq)),
    firstSeen: now,
    lastSeen: now,
    lastPlayed: 0,
    matches: 0,
    wins: 0,
    losses: 0,
    streak: 0,
    best: 0,
    coins: identity.coins,
    stars: identity.stars,
    referrals: identity.referrals,
    squad: identity.squad,
    banned: false,
    muted: false,
    inMatch: false,
    awards: [],
  };
}

/** A hydrated record folded field by field: a hand-edited blob is clamped, never trusted. */
function readPlayer(raw: unknown): PlayerRecord | null {
  const r = raw as Partial<PlayerRecord> | null | undefined;
  if (!r || typeof r.id !== 'string' || !r.id) return null;
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    id: r.id.slice(0, 64),
    tgId: text(r.tgId, 20).replace(/[^0-9-]/g, ''),
    name: text(r.name, 40) || 'Player',
    username: text(r.username, 40),
    country: text(r.country, 2).toUpperCase(),
    age: Math.min(120, whole(r.age)),
    tiq: whole(r.tiq),
    firstSeen: whole(r.firstSeen),
    lastSeen: whole(r.lastSeen),
    lastPlayed: whole(r.lastPlayed),
    matches: whole(r.matches),
    wins: whole(r.wins),
    losses: whole(r.losses),
    streak: whole(r.streak),
    best: whole(r.best),
    coins: whole(r.coins),
    stars: whole(r.stars),
    referrals: whole(r.referrals),
    squad: text(r.squad, 24),
    banned: r.banned === true,
    muted: r.muted === true,
    /* a fresh instance has no live boards: nothing can be mid-match across an eviction */
    inMatch: false,
    awards: readAwards(r.awards),
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A request body, or an empty object when there is none / it is not JSON. Never throws. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/* ---------- the arena board: defaults, validation and the prize bands ---------- */

const ARENA_TIER_IDS: readonly ArenaTierId[] = [
  'bronze', 'silver', 'gold', 'platinum', 'diamond', 'challenger',
];
const ARENA_STATUSES: readonly ArenaStatus[] = ['active', 'maintenance', 'finale'];
const TIER_DEFAULTS: Record<ArenaTierId, number> = {
  bronze: 0, silver: 1_200, gold: 1_800, platinum: 2_400, diamond: 3_000, challenger: 4_000,
};
const SEASON_ANCHOR = Date.UTC(2026, 9, 16, 14, 0);
const SEASON_MS = 28 * 86400_000;
const SNAPSHOT_MAX = 50;
const AWARDS_KEEP = 6;

function arenaSeason(now: number): { no: number; endsAt: number } {
  const k = Math.ceil((now - SEASON_ANCHOR) / SEASON_MS);
  return { no: Math.max(1, 4 + k), endsAt: SEASON_ANCHOR + k * SEASON_MS };
}

function seasonNameFor(no: number): string {
  return `Season ${no}: Mind Clash`;
}

function defaultDivisions(): ArenaDivisionRule[] {
  return ARENA_TIER_IDS.map((id) => ({ id, min: TIER_DEFAULTS[id] }));
}

function defaultArena(now = Date.now()): ArenaState {
  const s = arenaSeason(now);
  return {
    status: 'active',
    matchLocked: false,
    seasonNo: s.no,
    seasonName: seasonNameFor(s.no),
    endsAt: s.endsAt,
    divisions: defaultDivisions(),
    updatedAt: 0,
    lastSnapshot: null,
    awardsCount: 0,
  };
}

const arenaText = (v: unknown, max: number): string => {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c !== 127) out += ch;
  }
  return out.trim().slice(0, max);
};

function readDivisions(raw: unknown, fallback = defaultDivisions()): ArenaDivisionRule[] {
  const rows = Array.isArray(raw) ? raw : [];
  let prev = 0;
  return ARENA_TIER_IDS.map((id, i) => {
    const found = rows.find((r) => r && typeof r === 'object' && (r as { id?: unknown }).id === id);
    const value = found ? (found as { min?: unknown }).min : undefined;
    const base = i === 0
      ? 0
      : Math.max(prev + 1, typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback[i].min);
    prev = base;
    return { id, min: clamp(base, 0, 1_000_000) };
  });
}

function readSnapshot(raw: unknown): ArenaSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ArenaSnapshot>;
  if (typeof r.seasonNo !== 'number' || !Number.isFinite(r.seasonNo)) return null;
  if (typeof r.takenAt !== 'number' || !Number.isFinite(r.takenAt)) return null;
  const entries: ArenaSnapshotEntry[] = [];
  for (const row of Array.isArray(r.entries) ? r.entries : []) {
    if (!row || typeof row !== 'object') continue;
    const e = row as Partial<ArenaSnapshotEntry>;
    if (typeof e.id !== 'string' || !e.id) continue;
    entries.push({
      rank: Math.max(1, whole(e.rank)),
      id: e.id.slice(0, 64),
      name: arenaText(e.name, 40) || 'Player',
      tiq: whole(e.tiq),
      wins: whole(e.wins),
    });
    if (entries.length >= SNAPSHOT_MAX) break;
  }
  const seasonNo = clamp(Math.floor(r.seasonNo), 1, 999);
  return {
    seasonNo,
    seasonName: arenaText(r.seasonName, 60) || seasonNameFor(seasonNo),
    takenAt: whole(r.takenAt),
    total: whole(r.total),
    entries,
  };
}

function readAward(raw: unknown): SeasonAward | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<SeasonAward>;
  if (typeof r.seasonNo !== 'number' || typeof r.tiq !== 'number') return null;
  const seasonNo = clamp(whole(r.seasonNo), 1, 999);
  return {
    seasonNo,
    seasonName: arenaText(r.seasonName, 60),
    rank: Math.max(1, whole(r.rank)),
    tiq: clamp(whole(r.tiq), 0, 1_000_000),
    badge: arenaText(r.badge, 40) || 'Contender',
    awardedAt: whole(r.awardedAt),
  };
}

function readAwards(raw: unknown): SeasonAward[] {
  const out: SeasonAward[] = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    const award = readAward(row);
    if (award) out.push(award);
  }
  return out.slice(-AWARDS_KEEP);
}

/** A stored board folded field by field; null when there is nothing trustworthy to fold. */
function readArena(raw: unknown): ArenaState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ArenaState>;
  const now = Date.now();
  const seasonNo = typeof r.seasonNo === 'number' && Number.isFinite(r.seasonNo)
    ? clamp(whole(r.seasonNo), 1, 999)
    : arenaSeason(now).no;
  return {
    status: ARENA_STATUSES.includes(r.status as ArenaStatus) ? (r.status as ArenaStatus) : 'active',
    matchLocked: r.matchLocked === true,
    seasonNo,
    seasonName: arenaText(r.seasonName, 60) || seasonNameFor(seasonNo),
    endsAt: typeof r.endsAt === 'number' && Number.isFinite(r.endsAt)
      ? clamp(whole(r.endsAt), 0, now + 10 * 366 * 86400_000)
      : arenaSeason(now).endsAt,
    divisions: readDivisions(r.divisions),
    updatedAt: whole(r.updatedAt),
    lastSnapshot: readSnapshot(r.lastSnapshot),
    awardsCount: whole(r.awardsCount),
  };
}

/** Only the fields the Command Center actually sent move; the rest of the board is untouched. */
function arenaPatch(base: ArenaState, raw: unknown, now = Date.now()): ArenaState {
  if (!raw || typeof raw !== 'object') return base;
  const p = raw as Partial<ArenaState>;
  const next: ArenaState = { ...base, divisions: [...base.divisions], updatedAt: now };
  if (ARENA_STATUSES.includes(p.status as ArenaStatus)) next.status = p.status as ArenaStatus;
  if (typeof p.matchLocked === 'boolean') next.matchLocked = p.matchLocked;
  if (typeof p.seasonName === 'string') {
    const name = arenaText(p.seasonName, 60);
    if (name) {
      next.seasonName = name;
      const m = /^s(?:eason)?\s*(\d+)/i.exec(name);
      if (m) next.seasonNo = clamp(Number(m[1]), 1, 999);
    }
  }
  if (typeof p.seasonNo === 'number' && Number.isFinite(p.seasonNo)) {
    next.seasonNo = clamp(whole(p.seasonNo), 1, 999);
  }
  if (typeof p.endsAt === 'number' && Number.isFinite(p.endsAt)) {
    next.endsAt = clamp(Math.floor(p.endsAt), 0, now + 10 * 366 * 86400_000);
  }
  if (Array.isArray(p.divisions)) next.divisions = readDivisions(p.divisions, base.divisions);
  return next;
}

function nextSeasonName(name: string, no: number): string {
  if (/^season\s+\d+/i.test(name)) return name.replace(/^season\s+\d+/i, `Season ${no}`);
  if (/^s\d+/i.test(name)) return name.replace(/^s\d+/i, `S${no}`);
  return `Season ${no}: ${name || 'Mind Clash'}`;
}

function rewardFor(rank: number): number {
  if (rank === 1) return 500;
  if (rank === 2) return 300;
  if (rank === 3) return 200;
  if (rank <= 10) return 100;
  if (rank <= 50) return 50;
  return 20;
}

function badgeFor(rank: number, seasonNo: number): string {
  if (rank === 1) return `Season ${seasonNo} Champion`;
  if (rank === 2) return 'Runner-up';
  if (rank === 3) return 'Third Place';
  if (rank <= 10) return 'Top 10';
  if (rank <= 50) return 'Top 50';
  return 'Contender';
}

/** FNV-1a, 32 bit: the match id and the race seed both have to be identical on both sides. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** `sizes=1,1` from the query: the board both seats asked for, or the plain 1v1. */
function readSizes(raw: string | null): [number, number] {
  const parts = (raw ?? '').split(',').map((n) => Number(n.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isInteger(n) || n < 1 || n > MAX_BALLS)) return [1, 1];
  return [parts[0], parts[1]];
}

/** `room=4` from the query: how many seats the socket is asking for. 0 means "not a room". */
function readRoomSize(raw: string | null): number {
  const n = Number((raw ?? '').trim());
  if (!Number.isInteger(n) || n < 2 || n > MAX_TEAMS) return 0;
  return n;
}

/** `roomcode=9786` from the query: the friends lobby this socket is joining. */
function readRoomCode(raw: string | null): string {
  const digits = (raw ?? '').replace(/\D/g, '').slice(0, 4);
  return digits.length === 4 ? digits : '';
}

/** `bottier=hard` from the query: the level a room hands its backfilled bots. */
function readBotTier(raw: string | null): BotTier {
  return raw === 'easy' || raw === 'normal' || raw === 'hard' ? raw : 'mixed';
}

const sameBoard = (a: Waiter, b: Waiter): boolean => a.sizes[0] === b.sizes[0] && a.sizes[1] === b.sizes[1];

const inBounds = (v: unknown, cols: number, rows: number): v is { c: number; r: number } => {
  const p = v as { c?: unknown; r?: unknown } | null;
  return !!p && Number.isInteger(p.c) && Number.isInteger(p.r)
    && (p.c as number) >= 0 && (p.c as number) < cols && (p.r as number) >= 0 && (p.r as number) < rows;
};

/**
 * An action, read from the wire and rebuilt here rather than trusted: a wall's owner is the seat
 * that sent it, never the number in the payload, and every coordinate has to be a square on THIS
 * board — the grid is sized by the number of contenders, so a 3- or 4-contender race is two columns
 * wider than a duel and a move into those columns is legal there.
 */
function readAction(raw: unknown, side: number, cols: number, rows: number): Action | null {
  const a = raw as { kind?: unknown; ball?: unknown; to?: unknown; wall?: unknown; cell?: unknown } | null;
  if (!a || typeof a !== 'object') return null;
  if (a.kind === 'move') {
    if (!inBounds(a.to, cols, rows)) return null;
    if (a.ball !== undefined && !Number.isInteger(a.ball)) return null;
    const to = { c: a.to.c, r: a.to.r };
    return a.ball === undefined ? { kind: 'move', to } : { kind: 'move', to, ball: a.ball as number };
  }
  if (a.kind === 'wall') {
    const w = a.wall as { o?: unknown; x?: unknown; y?: unknown } | null;
    if (!w || (w.o !== 'h' && w.o !== 'v') || !Number.isInteger(w.x) || !Number.isInteger(w.y)) return null;
    return { kind: 'wall', wall: { o: w.o, x: w.x as number, y: w.y as number, owner: side } };
  }
  if (a.kind === 'mine') {
    if (!inBounds(a.cell, cols, rows)) return null;
    return { kind: 'mine', cell: { c: a.cell.c, r: a.cell.r } };
  }
  return a.kind === 'pass' ? { kind: 'pass' } : null;
}

/** The board a socket is playing on: the live race's own grid, or the one its queue asked for. */
const boardOf = (waiter: Waiter): { cols: number; rows: number } =>
  waiter.race ? waiter.race.state : dimsFor(contendersIn(waiter.sizes));

/** The closed emote vocabulary, mirrored from `src/data/phrases.ts`: nothing else goes on the wire. */
const EMOTE_IDS: ReadonlySet<string> = new Set(['laugh', 'fury', 'impatient']);

/** The phrase vocabulary's shape, mirrored from `src/data/phrases.ts`: two tongues, six lines. */
const PHRASE_LANGS: ReadonlySet<string> = new Set(['EN', 'FA']);
const PHRASE_COUNT = 6;

function readMessage(raw: unknown, side: number, cols: number, rows: number): ClientMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const msg = JSON.parse(raw) as {
      type?: unknown; wide?: unknown; action?: unknown; mode?: unknown; side?: unknown; team?: unknown;
      format?: unknown; emote?: unknown; lang?: unknown; index?: unknown;
    };
    if (msg.type === 'QUEUE') return { type: 'QUEUE', wide: msg.wide === true };
    if (msg.type === 'WIDEN') return { type: 'WIDEN' };
    if (msg.type === 'CANCEL') return { type: 'CANCEL' };
    if (msg.type === 'RESIGN') return { type: 'RESIGN' };
    if (msg.type === 'ROOM_START') return { type: 'ROOM_START' };
    if (msg.type === 'SET_FORMAT') {
      return isLobbyFormat(msg.format) ? { type: 'SET_FORMAT', format: msg.format } : null;
    }
    if (msg.type === 'SET_MODE') return { type: 'SET_MODE', mode: msg.mode === 'team' ? 'team' : 'ffa' };
    if (msg.type === 'SET_TEAM') {
      const side = Number(msg.side);
      if (!Number.isInteger(side) || side < 0 || side >= MAX_TEAMS) return null;
      return { type: 'SET_TEAM', side, team: Number(msg.team) === 1 ? 1 : 0 };
    }
    if (msg.type === 'MOVE') {
      const action = readAction(msg.action, side, cols, rows);
      return action ? { type: 'MOVE', action } : null;
    }
    if (msg.type === 'EMOTE') {
      return typeof msg.emote === 'string' && EMOTE_IDS.has(msg.emote)
        ? { type: 'EMOTE', emote: msg.emote } : null;
    }
    if (msg.type === 'PHRASE') {
      return typeof msg.lang === 'string' && PHRASE_LANGS.has(msg.lang)
        && typeof msg.index === 'number' && Number.isInteger(msg.index)
        && msg.index >= 0 && msg.index < PHRASE_COUNT
        ? { type: 'PHRASE', lang: msg.lang, index: msg.index } : null;
    }
  } catch {
    /* not ours: a malformed frame is dropped, never fatal */
  }
  return null;
}

/** `MATCH_FOUND` as the client reads it: the seat, the shared race, and who is opposite. */
function foundMessage(matchId: string, seed: number, side: 0 | 1, opponent: Waiter, sizes: [number, number]): string {
  return JSON.stringify({
    type: 'MATCH_FOUND',
    matchId,
    seed,
    side,
    sizes,
    opponent: { name: opponent.name, tiq: opponent.tiq, tier: opponent.tier, flag: opponent.flag },
  });
}

/* ---------- the role registry & the broadcast engine ---------- */

/**
 * One appointed admin, as `GET /api/admin/roles` reports it. `root` marks the ids seeded from the
 * `ADMIN_IDS` allowlist: they are the server's owners and cannot be revoked from the panel.
 */
export interface AdminUser {
  id: string;
  name: string;
  username: string;
  role: AdminRole;
  addedAt: number;
  addedBy: string;
  root: boolean;
}

/** One registered squad, as the Command Center's Squads tab audits it. */
export interface SquadWarRow {
  id: string;
  chatId: string;
  handle: string;
  name: string;
  kind: 'channel' | 'group';
  avatar: string;
  tag: string;
  members: number;
  ownerId: string;
  /** Resolved from the player registry when that owner has connected; '' otherwise. */
  ownerName: string;
  ownerUsername: string;
  createdAt: number;
  verification: SquadVerification;
  verifiedAt: number;
  verifiedBy: string;
  revokedAt: number;
  banned: boolean;
  bannedAt: number;
  /** TIQ the registry's players contribute to this squad's war effort. */
  warTiq: number;
  /** How many registered players report this squad. */
  contributors: number;
}

/** The Squads tab's KPI pulse: bounded counts folded from the registry rows. */
export interface SquadTotals {
  total: number;
  channels: number;
  groups: number;
  verified: number;
  pending: number;
  revoked: number;
  banned: number;
  members: number;
  /** War TIQ from squads that have not been purged. */
  tiq: number;
  contributors: number;
}

/** `GET /api/admin/squads`: the whole registry and its aggregates, newest first. */
export interface SquadRegistry {
  ok: true;
  timestamp: number;
  totals: SquadTotals;
  squads: SquadWarRow[];
}

/**
 * The key a player's reported squad handle and a registered handle share. Player handles come in
 * as `@name` or a bare name, so both are folded to the same lower-case `@name` shape.
 */
function squadKeyOf(raw: string): string {
  const normalized = normalizeChatHandle(raw);
  if (normalized) return normalized.toLowerCase();
  const plain = raw.trim().replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9_]{4,32}$/.test(plain) ? `@${plain}` : '';
}

/** Who a spread announcement is aimed at. The server stores it; the client matches it. */
export interface BroadcastAudience {
  /** `all` — everyone; `country` — one ISO 3166-1 alpha-2 code; `minLevel` — a TIQ level floor. */
  kind: 'all' | 'country' | 'minLevel';
  /** The ISO code, the level as text, or '' for everyone. */
  value: string;
}

/** One announcement, as the composer dispatches it and the client popup reads it. */
export interface Broadcast {
  id: string;
  title: string;
  /** The body, plain text: the client renders a light markdown subset without ever touching HTML. */
  body: string;
  /** Empty when the announcement carries no call to action. */
  ctaLabel: string;
  ctaTarget: string;
  audience: BroadcastAudience;
  /** `urgent` pops a modal on clients; `feed` lands in the notification centre. */
  priority: 'urgent' | 'feed';
  status: 'active' | 'archived';
  createdAt: number;
  createdBy: string;
  archivedAt: number;
}

const ADMIN_ROLES: readonly AdminRole[] = ['superadmin', 'moderator'];
const AUDIENCE_KINDS: readonly BroadcastAudience['kind'][] = ['all', 'country', 'minLevel'];
const BROADCAST_MAX = 500;

/** A registry row folded field by field, so a hand-edited blob is never trusted as it stands. */
function readAdminUser(raw: unknown): AdminUser | null {
  const r = raw as Partial<AdminUser> | null | undefined;
  if (!r || typeof r.id !== 'string' || !r.id) return null;
  const role = ADMIN_ROLES.includes(r.role as AdminRole) ? (r.role as AdminRole) : 'moderator';
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    id: r.id.slice(0, 40),
    name: text(r.name, 40) || `Admin ${r.id.slice(0, 12)}`,
    username: text(r.username, 40),
    role,
    addedAt: whole(r.addedAt),
    addedBy: text(r.addedBy, 40),
    root: r.root === true,
  };
}

/** A broadcast folded field by field; a row without a title or body is dropped. */
function readBroadcast(raw: unknown): Broadcast | null {
  const r = raw as Partial<Broadcast> | null | undefined;
  if (!r || typeof r.id !== 'string' || !r.id) return null;
  if (typeof r.title !== 'string' || !r.title.trim()) return null;
  if (typeof r.body !== 'string' || !r.body.trim()) return null;
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
  const kind = AUDIENCE_KINDS.find((k) => k === r.audience?.kind) ?? 'all';
  return {
    id: r.id.slice(0, 64),
    title: text(r.title, 80),
    body: text(r.body, 600),
    ctaLabel: text(r.ctaLabel, 24),
    ctaTarget: text(r.ctaTarget, 200),
    audience: { kind, value: text(r.audience?.value, 8) },
    priority: r.priority === 'feed' ? 'feed' : 'urgent',
    status: r.status === 'archived' ? 'archived' : 'active',
    createdAt: whole(r.createdAt),
    createdBy: text(r.createdBy, 40),
    archivedAt: whole(r.archivedAt),
  };
}

/** An id the panel accepts for an appointment: a numeric Telegram id, or an `@handle`. The id
 *  length stays loose (1-20) so every id the legacy `ADMIN_IDS` door would admit also seeds. */
const HANDLE = /^@[A-Za-z0-9_]{3,32}$/;
const TELEGRAM_ID = /^[0-9]{1,20}$/;

/** Normalise whatever the panel typed into one registry id, or '' when it is neither shape. */
function adminIdOf(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  if (HANDLE.test(value)) return value.toLowerCase();
  if (TELEGRAM_ID.test(value)) return value;
  return '';
}

/* ---------- the Durable Object ---------- */

export class MatchmakerDO {
  private queue: Waiter[] = [];
  /** Pairings this object has announced: it keeps repeat pairings from reusing an id. */
  private paired = 0;
  /** Every race still being played, by match id. */
  private races = new Map<string, Race>();
  /** Rooms still filling their seats. They leave this list the moment they launch. */
  private openRooms: LiveRoom[] = [];
  /** Code-based friends lobbies, by their 4-digit code. A code lobby is never auto-paired. */
  private lobbies = new Map<string, LiveRoom>();
  /** Rooms that have launched, by match id. */
  private rooms = new Map<string, LiveRoom>();
  /** Which room seat a socket is holding. A socket in here is not a queue entry. */
  private refs = new Map<WebSocket, RoomRef>();
  /** The admin's maintenance lock: nobody new gets in while it is on. */
  private maintenance = false;
  /** The tournament board: season clock, divisions, lock and the last finalized snapshot. */
  private arena: ArenaState = defaultArena();
  /** The live pairing bands — the defaults until `/admin/config` moves them. */
  private normalRadius = TIER_RADIUS;
  private wideRadius = WIDE_RADIUS;
  /** Every player the room has met, by seat id — the Users tab's directory. */
  private players = new Map<string, PlayerRecord>();
  /** The moderation lock: a banned seat never reaches matchmaking again. */
  private banned = new Set<string>();
  /** A registry write is already scheduled: many touches, one flush. */
  private dirty = false;
  /** The appointed admins, by id — the Controls tab's Access Control List. */
  private admins = new Map<string, AdminUser>();
  /** Every announcement ever dispatched, active and archived — the broadcast history. */
  private broadcasts = new Map<string, Broadcast>();
  /** Roles were seeded from `ADMIN_IDS`: the next read persists them. */
  private rolesDirty = false;
  /** A broadcast write is already scheduled: many flips, one flush. */
  private broadcastsDirty = false;
  /** Registered Telegram channels and groups, by squad id. */
  private squads = new Map<string, RegisteredSquad>();
  private squadsDirty = false;
  /** Durable board counters, seeded from storage and written back as they move. */
  private gameMetrics: GameMetrics = zeroGameMetrics();
  /** The bounded growth rings behind the Stats tab's trend chart. */
  private growth: GrowthSeries = zeroGrowth();
  /** The last UTC day the rings formatted a key for, and the key itself. */
  private memoDayIndex = -1;
  private memoDayKey = '';
  /** A counter write is already scheduled: many moves, one flush. */
  private metricsDirty = false;

  constructor(private state: DurableObjectState, private env: Env) {
    /* The registry rides the object's own storage, so it survives eviction. A harness that drives
       the object without a storage backend simply starts empty. */
    const storage = this.state?.storage;
    if (storage && typeof this.state.blockConcurrencyWhile === 'function') {
      this.state.blockConcurrencyWhile(async () => {
        try {
          const rows = await storage.get<unknown[]>('players');
          if (Array.isArray(rows)) {
            for (const raw of rows) {
              const rec = readPlayer(raw);
              if (rec) this.players.set(rec.id, rec);
            }
          }
          const bans = await storage.get<unknown[]>('bans');
          if (Array.isArray(bans)) {
            for (const id of bans) if (typeof id === 'string' && id) this.banned.add(id);
          }
          const roles = await storage.get<unknown[]>('roles');
          if (Array.isArray(roles)) {
            for (const raw of roles) {
              const row = readAdminUser(raw);
              if (row) this.admins.set(row.id, row);
            }
          }
          const casts = await storage.get<unknown[]>('broadcasts');
          if (Array.isArray(casts)) {
            for (const raw of casts) {
              const row = readBroadcast(raw);
              if (row) this.broadcasts.set(row.id, row);
            }
          }
          const squads = await storage.get<unknown[]>('squads');
          if (Array.isArray(squads)) {
            for (const raw of squads) {
              const row = readRegisteredSquad(raw);
              if (row) this.squads.set(row.id, row);
            }
          }
          const arena = readArena(await storage.get<unknown>('arena'));
          if (arena) this.arena = arena;
          this.gameMetrics = readGameMetrics(await storage.get<unknown>(GAME_METRICS_KEY));
          this.growth = readGrowthSeries(await storage.get<unknown>(GROWTH_KEY));
          this.seedRoles();
          this.rearm();
        } catch {
          /* a store that refuses the read: the registry simply starts empty */
        }
      });
    }
    /* A harness without a storage backend still gets the seeded allowlist, synchronously. */
    if (!storage) this.seedRoles();
  }

  /**
   * The `ADMIN_IDS` allowlist is the root of trust: every id on it starts (and stays) a
   * SuperAdmin. The reconcile only *adds* roots the store is missing — an appointed admin is
   * never resurrected by a restart, and a revoked one (never a root) stays gone.
   */
  private seedRoles(): void {
    const now = Date.now();
    let added = false;
    for (const id of (this.env.ADMIN_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!TELEGRAM_ID.test(id)) continue;
      const existing = this.admins.get(id);
      if (existing?.root && existing.role === 'superadmin') continue;
      this.admins.set(id, {
        id,
        name: existing?.name ?? `Admin ${id.slice(0, 6)}`,
        username: existing?.username ?? '',
        role: 'superadmin',
        addedAt: existing?.addedAt ?? now,
        addedBy: 'ADMIN_IDS',
        root: true,
      });
      added = true;
    }
    if (!added) return;
    this.rolesDirty = true;
    this.persistRoles();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/squads/register') return this.registerSquad(request, url);
    /* The worker has authenticated the caller on `/admin/*` and `/api/admin/*`; the room below
       authorizes them against its registry. The one public announcement feed rides the same
       handler. None of these ever carry an upgrade. */
    if (
      url.pathname.startsWith('/admin/')
      || url.pathname.startsWith('/api/admin/')
      || url.pathname === '/api/client/announcements/active'
      || url.pathname === '/api/client/arena/state'
      || url.pathname === '/api/client/minds'
    ) {
      /* A throw anywhere in this surface would otherwise reach the edge as an opaque Durable
         Object failure, and the panel can only report that as telemetry being unavailable. Answer
         JSON with what actually broke, so the operator reads a reason instead of a guess. */
      try {
        return await this.admin(request, url);
      } catch (err) {
        return json({ error: 'room_error', hint: reasonOf(err) }, 500);
      }
    }
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return json({ error: 'expected_upgrade', hint: 'GET /ws/matchmake with Upgrade: websocket' }, 426);
    }

    const identity = await authenticate(authRequestFrom(url), this.env);
    if (!identity) return json({ error: 'unauthorized', hint: 'valid Telegram initData required' }, 401);
    /* The moderation lock is enforced here, not in the panel: a banned account never reaches
       matchmaking at all, however fresh its socket is. */
    if (this.restricted(identity.player.id)) {
      return json({ error: 'banned', hint: 'matchmaking is restricted for this account' }, 403);
    }
    this.touch(identity);

    /* The tournament gate sits before the queue, not inside the panel: a socket that connects
       while the arena is locked is told why and let go, while races already on a board resolve. */
    if (this.maintenance || this.arenaLocked()) {
      const gate = new WebSocketPair();
      const denied = gate[1];
      denied.accept();
      try {
        denied.send(JSON.stringify({
          type: 'ERROR',
          reason: this.maintenance ? 'MAINTENANCE' : 'MATCHING_LOCKED',
        }));
        denied.close(1000, 'locked');
      } catch {
        /* the socket is already gone */
      }
      return new Response(null, { status: 101, webSocket: gate[0] });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    /* A room socket and a queue socket are two different things from the first frame: a room seat
       is never in the pairing queue, so a 4-seat room can never be broken up into a duel. */
    const roomCode = readRoomCode(url.searchParams.get('roomcode'));
    const roomSize = readRoomSize(url.searchParams.get('room'));
    if (roomCode) {
      /* the friends lobby: a code the host minted, not a search for strangers */
      this.joinLobby(server, identity, roomCode, url.searchParams.get('host') === '1',
        readBotTier(url.searchParams.get('bottier')));
    } else if (roomSize) {
      this.joinRoom(server, identity, roomSize, readBotTier(url.searchParams.get('bottier')));
    } else {
      const waiter = this.enter(server, identity, url.searchParams.get('wide') === '1', readSizes(url.searchParams.get('sizes')));
      this.attach(waiter);
      this.pairNow();                          // the queue may already hold their match
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The wait timer. A room that has run out of patience fills its seats and starts. */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const live of [...this.openRooms]) {
      if (!live.driver && now - live.room.openedAt >= live.room.waitMs) this.launchRoom(live);
    }
    /* The season clock is an alarm too: at the boundary the arena closes itself and tells
       everyone, rather than waiting for the next admin to notice. */
    if (this.arena.status === 'active' && this.arena.endsAt <= now) {
      this.arena = { ...this.arena, status: 'finale', matchLocked: true, updatedAt: now };
      this.evictAll('SEASON_ENDED');
      this.persistArena();
      this.broadcastArena('SEASON_ENDED');
    }
    this.rearm();
  }

  /* ---------- registered squads ---------- */

  private async registerSquad(request: Request, url: URL): Promise<Response> {
    const body = await readBody(request);
    const rawHandle = typeof body.chatUsername === 'string' ? body.chatUsername : '';
    const handle = normalizeChatHandle(rawHandle);
    if (!handle) {
      return json({
        ok: false,
        error: 'invalid_handle',
        message: 'Enter a channel handle or link like @your_channel.',
      }, 400);
    }
    if ([...this.squads.values()].some((s) => s.handle.toLowerCase() === handle.toLowerCase())) {
      return json({
        ok: false,
        error: 'already_registered',
        message: 'This channel/group is already registered as a Squad.',
      }, 409);
    }

    const initData = request.headers.get('x-telegram-init-data') ?? '';
    let requester = await verifiedTelegramUserId(initData, this.env);
    if (!requester) {
      const dev = this.env.DEV_AUTH === 'true' || isLocalhost(url.hostname);
      if (dev) {
        requester = String(body.userTelegramId ?? '').replace(/[^0-9-]/g, '').slice(0, 20);
      }
    }
    if (!requester) {
      return json({
        ok: false,
        error: 'unauthorized',
        message: 'Telegram verification required.',
      }, 401);
    }

    const result = await verifyAndBuildSquad(rawHandle, requester, this.env, {
      name: typeof body.squadName === 'string' ? body.squadName : '',
      tag: typeof body.squadTag === 'string' ? body.squadTag : '',
    });
    if (!result.ok) {
      return json({ ok: false, error: result.code, message: result.message }, result.status);
    }
    if ([...this.squads.values()].some((s) => s.chatId === result.squad.chatId || s.handle.toLowerCase() === result.squad.handle.toLowerCase())) {
      return json({
        ok: false,
        error: 'already_registered',
        message: 'This channel/group is already registered as a Squad.',
      }, 409);
    }

    this.squads.set(result.squad.id, result.squad);
    this.squadsDirty = true;
    this.persistSquads();
    return json({ ok: true, squad: result.squad });
  }

  private persistSquads(): void {
    if (!this.squadsDirty || !this.state?.storage) return;
    const storage = this.state.storage;
    this.squadsDirty = false;
    void Promise.resolve().then(() => {
      try {
        void storage.put('squads', [...this.squads.values()]);
      } catch {
        /* a store that refuses the write: the registry stays in memory */
      }
    });
  }

  /** The war contribution of each registered handle: TIQ and how many players report it. */
  private squadWarIndex(): Map<string, { tiq: number; contributors: number }> {
    const war = new Map<string, { tiq: number; contributors: number }>();
    for (const p of this.players.values()) {
      const key = squadKeyOf(p.squad);
      if (!key) continue;
      const entry = war.get(key) ?? { tiq: 0, contributors: 0 };
      entry.tiq += Math.max(0, Math.floor(p.tiq));
      entry.contributors += 1;
      war.set(key, entry);
    }
    return war;
  }

  /** Owners are resolved through the player registry's Telegram ids, when they have connected. */
  private squadOwners(): Map<string, PlayerRecord> {
    const owners = new Map<string, PlayerRecord>();
    for (const p of this.players.values()) {
      if (p.tgId) owners.set(p.tgId, p);
    }
    return owners;
  }

  private squadRowOf(
    squad: RegisteredSquad,
    war: Map<string, { tiq: number; contributors: number }> = this.squadWarIndex(),
    owners: Map<string, PlayerRecord> = this.squadOwners(),
  ): SquadWarRow {
    const key = squadKeyOf(squad.handle);
    const contribution = key ? war.get(key) : undefined;
    const owner = owners.get(squad.ownerId);
    return {
      id: squad.id,
      chatId: squad.chatId,
      handle: squad.handle,
      name: squad.name,
      kind: squad.kind,
      avatar: squad.avatar,
      tag: squad.tag,
      members: squad.members,
      ownerId: squad.ownerId,
      ownerName: owner?.name ?? '',
      ownerUsername: owner?.username ?? '',
      createdAt: squad.createdAt,
      verification: squad.verification,
      verifiedAt: squad.verifiedAt,
      verifiedBy: squad.verifiedBy,
      revokedAt: squad.revokedAt,
      banned: squad.banned,
      bannedAt: squad.bannedAt,
      warTiq: contribution?.tiq ?? 0,
      contributors: contribution?.contributors ?? 0,
    };
  }

  /** The whole registry with its KPI aggregates. Empty state is exact zeroes. */
  private squadsView(): SquadRegistry {
    const war = this.squadWarIndex();
    const owners = this.squadOwners();
    const totals: SquadTotals = {
      total: 0, channels: 0, groups: 0, verified: 0, pending: 0, revoked: 0, banned: 0,
      members: 0, tiq: 0, contributors: 0,
    };
    const squads = [...this.squads.values()]
      .map((squad) => this.squadRowOf(squad, war, owners))
      .sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
    for (const row of squads) {
      totals.total++;
      if (row.kind === 'channel') totals.channels++;
      else totals.groups++;
      if (row.verification === 'verified') totals.verified++;
      else if (row.verification === 'revoked') totals.revoked++;
      else totals.pending++;
      if (row.banned) totals.banned++;
      totals.members += row.members;
      /* A purged squad stays in the audit list but contributes nothing to the war pool. */
      if (!row.banned) {
        totals.tiq += row.warTiq;
        totals.contributors += row.contributors;
      }
    }
    return { ok: true, timestamp: Date.now(), totals, squads };
  }

  /** Verify, revoke, purge or restore one squad. The caller is already a proven SuperAdmin. */
  private squadAction(
    body: Record<string, unknown>,
    me: AdminIdentity,
  ): { ok: boolean; error?: string; squad?: SquadWarRow } {
    const id = typeof body.id === 'string' ? body.id.trim().slice(0, 48) : '';
    const action = typeof body.action === 'string' ? body.action.trim().toUpperCase() : '';
    const squad = id ? this.squads.get(id) : undefined;
    if (!squad) return { ok: false, error: 'no_such_squad' };
    const now = Date.now();
    if (action === 'VERIFY') {
      squad.verification = 'verified';
      squad.verifiedAt = now;
      squad.verifiedBy = me.userId;
      squad.revokedAt = 0;
    } else if (action === 'REVOKE') {
      squad.verification = 'revoked';
      squad.revokedAt = now;
    } else if (action === 'BAN') {
      squad.banned = true;
      squad.bannedAt = now;
      squad.verification = 'revoked';
      squad.revokedAt = now;
    } else if (action === 'UNBAN') {
      squad.banned = false;
      squad.bannedAt = 0;
      /* A restored squad is not automatically trusted again: it re-enters the review queue. */
      squad.verification = 'pending';
      squad.revokedAt = 0;
    } else {
      return { ok: false, error: 'invalid_action' };
    }
    this.squadsDirty = true;
    this.persistSquads();
    return { ok: true, squad: this.squadRowOf(squad) };
  }

  /* ---------- the admin surface ---------- */

  /** The three live knobs, as the panel reads them back. */
  private config(): ServerConfig {
    return { maintenance: this.maintenance, normalRadius: this.normalRadius, wideRadius: this.wideRadius };
  }

  /** Everything a live server knows about itself: the queue, the rooms, the lobbies and the config. */
  private status(): ServerStatus {
    const now = Date.now();
    const lobbies: OpenLobby[] = [
      ...[...this.openRooms, ...this.lobbies.values()].map((live) => ({
        code: live.room.code,
        size: live.size,
        joined: live.members.reduce((n, m) => n + (m ? 1 : 0), 0),
        openedAt: live.room.openedAt,
        waitMs: live.room.waitMs,
        friends: live.code,
      })),
    ];
    return {
      ok: true,
      timestamp: now,
      queueCount: this.queue.length,
      activeMatchesCount: this.races.size + this.rooms.size,
      active1v1: this.races.size,
      queuedPlayers: this.queue.map((w) => ({
        id: w.id,
        name: w.name,
        tiq: w.tiq,
        wide: w.wide,
        waitedMs: Math.max(0, now - w.joinedAt),
      })),
      activeRooms: [
        ...[...this.races.values()].map((r) => ({
          matchId: r.matchId,
          p0: r.seats[0].name,
          p1: r.seats[1].name,
          turn: r.state.turn,
          players: 2,
          bots: 0,
          kind: '1v1' as const,
          startedAt: r.startedAt,
          spectators: 0,
        })),
        ...[...this.rooms.values()].map((live) => this.roomSummary(live)),
      ],
      openLobbies: lobbies,
      config: this.config(),
      arena: this.arena,
    };
  }

  /**
   * The measured telemetry reading, with every failure contained. Population figures come from the
   * registry, the live figures from the in-memory room maps, the match total from the durable
   * counter and the 24-hour window from its own timestamped hourly buckets; acquisition cohorts and
   * retention are folded from each record's `firstSeen` / `lastSeen`. Nothing is modelled.
   *
   * Each section is read behind its own guard, because one bad section used to be enough to shut
   * the operator's whole Stats tab: a throw here reaches the edge as a 500, and the edge can only
   * report it as telemetry being unavailable. A section that cannot be read reports its own exact
   * zeroes and names itself in `degraded`, so the panel still shows the rest of the truth.
   */
  private metrics(hostname: string): ServerMetrics {
    const now = Date.now();
    const degraded: string[] = [];
    const guarded = <T>(name: string, build: () => T, empty: T): T => {
      try {
        return build();
      } catch {
        degraded.push(name);
        return empty;
      }
    };
    const live = guarded('live', () => ({
      activeRooms: this.races.size + this.rooms.size,
      queueLength: this.queue.length,
      active1v1: this.races.size,
    }), { activeRooms: 0, queueLength: 0, active1v1: 0 });
    const counters = guarded('counters', () => ({
      matchesCompleted: this.gameMetrics.matchesCompleted,
      matches24h: this.matchesInWindow(ACTIVE_MS, now),
      minesPlaced: this.gameMetrics.minesPlaced,
    }), { matchesCompleted: 0, matches24h: 0, minesPlaced: 0 });
    const population = guarded('population', () => this.populationReading(now), NO_POPULATION);
    const series = guarded('series', () => this.growthWindows(now), NO_SERIES);
    const environment = this.env.WORKER_ENV?.trim()
      || (this.env.DEV_AUTH === 'true' || isLocalhost(hostname) ? 'development' : 'production');
    return {
      ok: true,
      timestamp: now,
      environment,
      ...live,
      ...population,
      ...counters,
      logsSpawned: 0,
      ...series,
      degraded,
    };
  }

  /** The registry sweep behind the population figures: one pass, every cohort, no allocation. */
  private populationReading(now: number): PopulationReading {
    const dayAgo = now - ACTIVE_MS;
    const weekAgo = now - WEEK_MS;
    const monthAgo = now - MONTH_MS;
    let referrals = 0;
    let referringPlayers = 0;
    let totalMatches = 0;
    let activatedPlayers = 0;
    let corePlayers = 0;
    let dau = 0;
    let wau = 0;
    let mau = 0;
    let returningUsersToday = 0;
    let retainedCohort = 0;
    let retainedD1 = 0;
    let signupsToday = 0;
    let signupsWeek = 0;
    let signupsMonth = 0;
    const telegram = new Set<string>();
    for (const p of this.players.values()) {
      if (p.tgId) telegram.add(p.tgId);
      if (p.referrals > 0) {
        referrals += p.referrals;
        referringPlayers++;
      }
      totalMatches += p.matches;
      if (p.matches >= 1) activatedPlayers++;
      if (p.matches >= 3) corePlayers++;
      if (p.lastSeen >= dayAgo) dau++;
      if (p.lastSeen >= weekAgo) wau++;
      if (p.lastSeen >= monthAgo) mau++;
      if (p.firstSeen > 0 && p.firstSeen < dayAgo) {
        if (p.lastSeen >= dayAgo) returningUsersToday++;
        /* the D1 cohort has had its full first day: did it ever come back a day later? */
        retainedCohort++;
        if (p.lastSeen >= p.firstSeen + ACTIVE_MS) retainedD1++;
      }
      if (p.firstSeen >= dayAgo) signupsToday++;
      if (p.firstSeen >= weekAgo) signupsWeek++;
      if (p.firstSeen >= monthAgo) signupsMonth++;
    }
    const totalUsers = this.players.size;
    return {
      totalUsers,
      telegramUsers: telegram.size,
      referrals,
      referringPlayers,
      dau,
      wau,
      mau,
      returningUsersToday,
      returningShare: percentOf(returningUsersToday, dau),
      signupsToday,
      signupsWeek,
      signupsMonth,
      retentionRateD1: percentOf(retainedD1, retainedCohort),
      avgMatchesPerPlayer: totalUsers ? Math.round((totalMatches / totalUsers) * 10) / 10 : 0,
      activationRate: percentOf(activatedPlayers, totalUsers),
      coreRetention: percentOf(corePlayers, totalUsers),
      dailyActiveRatio: percentOf(dau, totalUsers),
      viralShare: percentOf(Math.min(referrals, totalUsers), totalUsers),
    };
  }

  /** One launched room as a status row: the first two seats by name, and how many the machine holds. */
  private roomSummary(live: LiveRoom): ActiveRoom {
    const roster = live.driver?.room ?? live.room;
    let bots = 0;
    for (let i = 0; i < roster.seats.length; i++) if (isAutomated(roster, i)) bots++;
    return {
      matchId: live.matchId,
      p0: roster.seats[0]?.name ?? '',
      p1: roster.seats[1]?.name ?? '',
      turn: live.driver?.state.turn ?? 0,
      players: roster.seats.length,
      bots,
      kind: 'room',
      startedAt: live.startedAt || live.room.openedAt,
      spectators: 0,
    };
  }

  /** Every Command Center route: the public feed first, then the registry decides who is in. */
  private async admin(request: Request, url: URL): Promise<Response> {
    /* The two public routes in the set: the announcement popup, and the tournament clock. */
    if (url.pathname === '/api/client/announcements/active') return json(this.activeAnnouncements(), 200, {
      'cache-control': 'public, max-age=60',
    });
    if (url.pathname === '/api/client/arena/state') {
      return json(await this.clientArena(request), 200, { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/api/client/minds') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return json(await this.mindsBoard(request, url), 200, { 'cache-control': 'no-store' });
    }

    /* The private telemetry route: only a request the edge marked after the operator check. The
       mark names whoever was let through, so an appointed admin reads the same door the operator
       does - and a call the edge never marked stays shut here, whatever the client sent. */
    if (url.pathname === '/api/admin/metrics') {
      if (!isMetricsMark(request.headers.get(METRICS_HEADER) ?? '', this.env)) {
        return json({ error: 'unauthorized', hint: 'metrics operator required' }, 403);
      }
      return json(this.metrics(url.hostname));
    }

    /* The edge only proved the signature; membership is this room's call, registry in hand. */
    const me = await this.adminIdentity(request);
    if (!me) return json({ error: 'forbidden', hint: 'admin credentials required' }, 403);

    /* What a Moderator reads: the live room, the directory, the registry and the history. */
    if (url.pathname === '/admin/status') return json(this.status());
    /* The Server tab's dedicated telemetry door: the same live room, never cached. The edge has
       already authenticated the caller, and `adminIdentity` above checked the role registry. */
    if (url.pathname === '/api/admin/matchmaking') {
      return json(this.status(), 200, { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/admin/players') {
      return json(this.playersPage(url.searchParams), 200, { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/api/admin/roles') return json(this.rolesView(me));
    if (url.pathname === '/api/admin/broadcasts') return json(this.broadcastsView());
    if (url.pathname === '/api/admin/squads') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return json(this.squadsView(), 200, { 'cache-control': 'no-store' });
    }

    /* Everything below commands the server: SuperAdmin only. */
    if (url.pathname === '/admin/config') {
      if (!this.superDoor(me)) return json({ error: 'forbidden', hint: 'superadmin required' }, 403);
      const body = await readBody(request);
      return json({ ok: true, config: this.configure(body) });
    }

    if (url.pathname === '/admin/action') {
      if (!this.superDoor(me)) return json({ error: 'forbidden', hint: 'superadmin required' }, 403);
      const body = await readBody(request);
      const result = this.act(body);
      return json(result, result.ok ? 200 : 400);
    }

    /* The Arena tab: one state patch, or one of its two emergency commands. */
    if (url.pathname === '/admin/arena') {
      if (!this.superDoor(me)) return json({ error: 'forbidden', hint: 'superadmin required' }, 403);
      const body = await readBody(request);
      const result = this.arenaCommand(body);
      return json(result, result.ok ? 200 : 400);
    }

    /* The Users tab: one page of the player directory, then one player's moderation/coins. */
    if (url.pathname === '/admin/player') {
      if (!this.superDoor(me)) return json({ error: 'forbidden', hint: 'superadmin required' }, 403);
      const body = await readBody(request);
      const result = this.playerAction(body);
      return json(result, result.ok ? 200 : 400);
    }

    if (url.pathname === '/api/admin/roles/grant') {
      if (!this.superDoor(me)) return json({ error: 'forbidden', hint: 'superadmin required' }, 403);
      const body = await readBody(request);
      const result = this.grantRole(body, me);
      return json(result, result.ok ? 200 : 400);
    }

    if (url.pathname === '/api/admin/roles/revoke') {
      if (!this.superDoor(me)) return json({ error: 'forbidden', hint: 'superadmin required' }, 403);
      const body = await readBody(request);
      const result = this.revokeRole(body, me);
      return json(result, result.ok ? 200 : 400);
    }

    /* The Squads tab's audit actions: verify, revoke, purge or restore one registry row. */
    if (url.pathname === '/api/admin/squad-action') {
      if (!this.superDoor(me)) return json({ error: 'forbidden', hint: 'superadmin required' }, 403);
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      const body = await readBody(request);
      const result = this.squadAction(body, me);
      return json(result, result.ok ? 200 : 400);
    }

    if (url.pathname === '/api/admin/broadcasts/create') {
      if (!this.superDoor(me)) return json({ error: 'forbidden', hint: 'superadmin required' }, 403);
      const body = await readBody(request);
      const result = this.createBroadcast(body, me);
      return json(result, result.ok ? 200 : 400);
    }

    const archive = /^\/api\/admin\/broadcasts\/([^/]+)\/archive$/.exec(url.pathname);
    if (archive) {
      if (!this.superDoor(me)) return json({ error: 'forbidden', hint: 'superadmin required' }, 403);
      const body = await readBody(request);
      const result = this.archiveBroadcast(decodeURIComponent(archive[1]), body);
      return json(result, result.ok ? 200 : 400);
    }

    return json({ error: 'not_found' }, 404);
  }

  /* ---------- the role registry ---------- */

  /**
   * Who is behind this request: the credential is re-proven here (the room enforces its own
   * doors), and a Telegram caller must then be on the registry this object owns. The operator key
   * and the dev door need nothing more — the first only works with the secret set, the second only
   * opens for an explicit marker on a loopback host.
   */
  private async adminIdentity(request: Request): Promise<AdminIdentity | null> {
    const me = await identifyAdminRequest(request, this.env);
    if (!me) return null;
    if (me.door === 'dev' || me.door === 'key') return me;
    return this.admins.has(me.userId) ? me : null;
  }

  /** The authorization middleware: the dev door, or a stored `superadmin` role. */
  private superDoor(me: AdminIdentity): boolean {
    return isSuperAdmin(me, this.admins.get(me.userId));
  }

  /** The Access Control List the Controls tab reads, plus the roles it may appoint. */
  private rolesView(me: AdminIdentity): { ok: true; admins: AdminUser[]; roles: AdminRole[]; me: string; super: boolean } {
    const admins = [...this.admins.values()].sort(
      (a, b) => Number(b.root) - Number(a.root) || a.addedAt - b.addedAt,
    );
    return { ok: true, admins, roles: [...ADMIN_ROLES], me: me.userId, super: this.superDoor(me) };
  }

  /** Appoint (or re-role) one admin, immediately persisted. SuperAdmin only. */
  private grantRole(body: Record<string, unknown>, me: AdminIdentity): { ok: boolean; error?: string; admin?: AdminUser } {
    const id = adminIdOf(body.id);
    if (!id) return { ok: false, error: 'invalid_id' };
    const role = ADMIN_ROLES.includes(body.role as AdminRole) ? (body.role as AdminRole) : null;
    if (!role) return { ok: false, error: 'invalid_role' };
    const existing = this.admins.get(id);
    if (existing?.root && role !== 'superadmin') return { ok: false, error: 'root_admin' };
    const username = typeof body.username === 'string' ? body.username.replace(/^@/, '').slice(0, 40) : '';
    const name = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 40)
      : existing?.name ?? (id.startsWith('@') ? id.slice(1, 41) : `Admin ${id.slice(0, 6)}`);
    const row: AdminUser = existing
      ? { ...existing, role, name, username: username || existing.username }
      : { id, name, username, role, addedAt: Date.now(), addedBy: me.userId, root: false };
    this.admins.set(id, row);
    this.rolesDirty = true;
    this.persistRoles();
    return { ok: true, admin: row };
  }

  /** Revoke one appointed admin. A root id cannot go, and the last SuperAdmin never goes. */
  private revokeRole(body: Record<string, unknown>, _me: AdminIdentity): { ok: boolean; error?: string } {
    const id = typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
    const row = id ? this.admins.get(id) : undefined;
    if (!row) return { ok: false, error: 'no_such_admin' };
    if (row.root) return { ok: false, error: 'root_admin' };
    if (row.role === 'superadmin') {
      let supers = 0;
      for (const a of this.admins.values()) if (a.role === 'superadmin') supers++;
      if (supers <= 1) return { ok: false, error: 'last_superadmin' };
    }
    this.admins.delete(id);
    this.rolesDirty = true;
    this.persistRoles();
    return { ok: true };
  }

  /* ---------- the broadcast engine ---------- */

  /** The whole history, newest first, with how many are live. Any admin may read it. */
  private broadcastsView(): { ok: true; broadcasts: Broadcast[]; active: number } {
    const broadcasts = [...this.broadcasts.values()].sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, broadcasts, active: broadcasts.filter((b) => b.status === 'active').length };
  }

  /** Dispatch one announcement. SuperAdmin only; immediately persisted, immediately live. */
  private createBroadcast(
    body: Record<string, unknown>,
    me: AdminIdentity,
  ): { ok: boolean; error?: string; broadcast?: Broadcast } {
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : '';
    const text = typeof body.body === 'string' ? body.body.trim().slice(0, 600) : '';
    if (!title) return { ok: false, error: 'missing_title' };
    if (!text) return { ok: false, error: 'missing_body' };
    const kind = AUDIENCE_KINDS.find((k) => k === body.audienceKind) ?? 'all';
    let value = typeof body.audienceValue === 'string' ? body.audienceValue.trim().slice(0, 8) : '';
    if (kind === 'country') {
      value = value.toUpperCase();
      if (!/^[A-Z]{2}$/.test(value)) return { ok: false, error: 'invalid_country' };
    } else if (kind === 'minLevel') {
      const level = Number(value);
      if (!Number.isInteger(level) || level < 1 || level > 999) return { ok: false, error: 'invalid_level' };
      value = String(level);
    } else {
      value = '';
    }
    const ctaLabel = typeof body.ctaLabel === 'string' ? body.ctaLabel.trim().slice(0, 24) : '';
    const ctaTarget = typeof body.ctaTarget === 'string' ? body.ctaTarget.trim().slice(0, 200) : '';
    if ((ctaLabel && !ctaTarget) || (!ctaLabel && ctaTarget)) return { ok: false, error: 'incomplete_cta' };
    const row: Broadcast = {
      id: `bc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      body: text,
      ctaLabel,
      ctaTarget,
      audience: { kind, value },
      priority: body.priority === 'feed' ? 'feed' : 'urgent',
      status: 'active',
      createdAt: Date.now(),
      createdBy: me.userId,
      archivedAt: 0,
    };
    this.broadcasts.set(row.id, row);
    /* the history is a history, not a leak: the oldest archived rows fall off the end */
    if (this.broadcasts.size > BROADCAST_MAX) {
      const dead = [...this.broadcasts.values()]
        .filter((b) => b.status === 'archived')
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const old of dead) {
        if (this.broadcasts.size <= BROADCAST_MAX) break;
        this.broadcasts.delete(old.id);
      }
    }
    this.broadcastsDirty = true;
    this.persistBroadcasts();
    return { ok: true, broadcast: row };
  }

  /** Deactivate or restore one announcement. SuperAdmin only. */
  private archiveBroadcast(
    id: string,
    body: Record<string, unknown>,
  ): { ok: boolean; error?: string; broadcast?: Broadcast } {
    const row = this.broadcasts.get(id);
    if (!row) return { ok: false, error: 'no_such_broadcast' };
    const archived = typeof body.archived === 'boolean' ? body.archived : true;
    row.status = archived ? 'archived' : 'active';
    row.archivedAt = archived ? Date.now() : 0;
    this.broadcastsDirty = true;
    this.persistBroadcasts();
    return { ok: true, broadcast: row };
  }

  /** The client feed: every active broadcast, urgent first and newest first within a band. */
  private activeAnnouncements(): { ok: true; announcements: Broadcast[]; now: number } {
    const announcements = [...this.broadcasts.values()]
      .filter((b) => b.status === 'active')
      .sort((a, b) => Number(b.priority === 'urgent') - Number(a.priority === 'urgent') || b.createdAt - a.createdAt);
    return { ok: true, announcements, now: Date.now() };
  }

  /** Schedule a roles write. Many appointments in one turn still cost one flush. */
  private persistRoles(): void {
    if (!this.rolesDirty || !this.state?.storage) return;
    const storage = this.state.storage;
    this.rolesDirty = false;
    void Promise.resolve().then(() => {
      try {
        void storage.put('roles', [...this.admins.values()]);
      } catch {
        /* a store that refuses the write: the registry stays in memory */
      }
    });
  }

  /** Schedule a broadcasts write, the same one-flush contract the registry keeps. */
  private persistBroadcasts(): void {
    if (!this.broadcastsDirty || !this.state?.storage) return;
    const storage = this.state.storage;
    this.broadcastsDirty = false;
    void Promise.resolve().then(() => {
      try {
        void storage.put('broadcasts', [...this.broadcasts.values()]);
      } catch {
        /* a store that refuses the write: the history stays in memory */
      }
    });
  }

  /**
   * Apply a live config patch and answer with what is now in force. Only fields that actually
   * arrived are touched, so a panel that sends one switch never resets the radii it did not mean
   * to move. A widened band re-runs the search: people who were waiting may already be a pair.
   */
  private configure(body: Record<string, unknown>): ServerConfig {
    if (typeof body.maintenance === 'boolean') this.setMaintenance(body.maintenance);
    if (typeof body.normalRadius === 'number' && Number.isFinite(body.normalRadius)) {
      this.normalRadius = clamp(Math.round(body.normalRadius), 0, 2000);
    }
    if (typeof body.wideRadius === 'number' && Number.isFinite(body.wideRadius)) {
      this.wideRadius = clamp(Math.round(body.wideRadius), 0, 4000);
    }
    this.pairNow();
    return this.config();
  }

  /** Turning the lock on is the one config change that also has to empty the room. */
  private setMaintenance(on: boolean): void {
    if (on === this.maintenance) return;
    this.maintenance = on;
    if (on) this.evictAll('MAINTENANCE');
  }

  /** The two moderation actions the panel offers. */
  private act(body: Record<string, unknown>): { ok: boolean; error?: string; cleared?: number; aborted?: string } {
    if (body.action === 'CLEAR_QUEUE') {
      const cleared = this.queue.length;
      this.evictAll('CLEARED');
      return { ok: true, cleared };
    }
    if (body.action === 'ABORT_MATCH') {
      const matchId = typeof body.matchId === 'string' ? body.matchId : '';
      const race = this.races.get(matchId);
      if (race) { this.abort(race); return { ok: true, aborted: matchId }; }
      const room = this.rooms.get(matchId);
      if (room) { this.abortRoom(room); return { ok: true, aborted: matchId }; }
      return { ok: false, error: 'no_such_match' };
    }
    return { ok: false, error: 'unknown_action' };
  }

  /* ---------- the arena & tournament board ---------- */

  /** What any player reads: the clock and statuses, with only the snapshot's head exposed. */
  private arenaPublicView(): ArenaState {
    const snap = this.arena.lastSnapshot;
    return {
      ...this.arena,
      lastSnapshot: snap ? { ...snap, entries: snap.entries.slice(0, 3) } : null,
    };
  }

  /**
   * The public mirror. A valid initData signature names the seat whose award rides along; no
   * signature means the tournament clock only. The header alone can never claim an award.
   */
  private async clientArena(
    request: Request,
  ): Promise<{ ok: true; arena: ArenaState; award: SeasonAward | null }> {
    const init = request.headers.get('x-telegram-init-data') ?? '';
    const tgId = init ? await verifiedTelegramUserId(init, this.env) : '';
    const playerId = tgId ? `tg-${tgId}` : '';
    const awards = playerId ? this.players.get(playerId)?.awards ?? [] : [];
    return {
      ok: true,
      arena: this.arenaPublicView(),
      award: awards.length ? awards[awards.length - 1] : null,
    };
  }

  /**
   * The public Mind Ladder: the room's own TIQ registry, ranked live. A banned seat is never
   * published, and a zero-TIQ seat has not earned a place yet. The caller's own reading —
   * verified initData when the Mini App supplies one, or the explicit `tiq` the Home card
   * sends — is ranked by the same comparator, so the strip under the board and the rows above
   * it can never disagree.
   */
  private async mindsBoard(request: Request, url: URL): Promise<{
    ok: true;
    updatedAt: number;
    total: number;
    players: Array<{
      rank: number; id: string; name: string; country: string; tiq: number; wins: number; isYou: boolean;
    }>;
    you: { rank: number; tiq: number; total: number; inBoard: boolean } | null;
  }> {
    const askedLimit = url.searchParams.get('limit');
    const rawLimit = askedLimit === null ? 5 : Number(askedLimit);
    const limit = Number.isFinite(rawLimit) ? clamp(Math.floor(rawLimit), 1, MINDS_LIMIT) : 5;

    const init = request.headers.get('x-telegram-init-data') ?? '';
    const tgId = init ? await verifiedTelegramUserId(init, this.env) : '';
    const mineId = tgId ? `tg-${tgId}` : '';
    const mine = mineId ? this.players.get(mineId) : undefined;
    const rawTiq = Number(url.searchParams.get('tiq'));
    const reported = Number.isFinite(rawTiq) ? clamp(Math.floor(rawTiq), 0, 10_000_000) : 0;
    const myTiq = Math.max(0, Math.floor(mine?.tiq ?? 0), reported);
    const myWins = Math.max(0, Math.floor(mine?.wins ?? 0));
    const selfBanned = mineId ? this.banned.has(mineId) || mine?.banned === true : false;

    const field = [...this.players.values()]
      .filter((p) => !p.banned && !this.banned.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        country: p.country,
        wins: p.id === mineId ? myWins : p.wins,
        tiq: p.id === mineId ? myTiq : p.tiq,
      }))
      .filter((p) => p.tiq > 0)
      .sort((a, b) => b.tiq - a.tiq || b.wins - a.wins || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    const inField = !!mineId && field.some((p) => p.id === mineId);
    const total = field.length + (myTiq > 0 && !inField && !selfBanned ? 1 : 0);
    const players = field.slice(0, limit).map((p, i) => ({
      rank: i + 1,
      id: p.id,
      name: p.name,
      country: p.country,
      tiq: p.tiq,
      wins: p.wins,
      isYou: !!mineId && p.id === mineId,
    }));

    let you: { rank: number; tiq: number; total: number; inBoard: boolean } | null = null;
    if (myTiq > 0 && !selfBanned) {
      /* The caller's own live reading may be newer than the record the room last saw; rank it
         against the field rather than trusting its stored seat, then say whether that rank landed
         inside the rows just returned. */
      const ahead = field.filter(
        (p) => p.id !== mineId && (p.tiq > myTiq || (p.tiq === myTiq && p.wins > myWins)),
      ).length;
      you = { rank: ahead + 1, tiq: myTiq, total, inBoard: players.some((p) => p.isYou) };
    }

    return { ok: true, updatedAt: Date.now(), total, players, you };
  }

  /** The Arena tab's write door: one patch, or one of the two emergency commands. */
  private arenaCommand(body: Record<string, unknown>): {
    ok: boolean;
    error?: string;
    arena?: ArenaState;
    dismissed?: number;
    awards?: number;
    snapshot?: ArenaSnapshot;
  } {
    const action = typeof body.action === 'string' ? body.action : '';
    if (action === 'FORCE_STOP') return this.forceStop();
    if (action === 'SEASON_RESET') return this.resetSeason();
    if (action) return { ok: false, error: 'unknown_action' };
    const patch = body.patch && typeof body.patch === 'object' ? body.patch : body;
    return { ok: true, arena: this.configureArena(patch) };
  }

  /**
   * A season, lock or division edit. A lock stops new queue entries and dismisses everyone still
   * waiting, but never touches a race already under way: that is somebody's game.
   */
  private configureArena(raw: unknown): ArenaState {
    const wasLocked = this.arenaLocked();
    this.arena = arenaPatch(this.arena, raw);
    this.persistArena();
    if (!wasLocked && this.arenaLocked()) this.evictAll('MATCHING_LOCKED');
    if (!this.arenaLocked()) this.pairNow();
    this.rearm();
    this.broadcastArena('STATE');
    return this.arena;
  }

  /** Freeze the arena and pull every waiting seat, then tell every connected client why. */
  private forceStop(): { ok: true; arena: ArenaState; dismissed: number } {
    const dismissed = this.queue.length;
    this.arena = { ...this.arena, status: 'maintenance', matchLocked: true, updatedAt: Date.now() };
    this.evictAll('FORCE_STOP');
    this.persistArena();
    this.broadcastArena('FORCE_STOP');
    return { ok: true, arena: this.arena, dismissed };
  }

  /**
   * Finalize the season: rank the registry, bank the snapshot, push every player an award, and
   * roll the counter to N+1 with a fresh 28-day clock. The snapshot is the audit record; the
   * awards are what the client claims once per season.
   */
  private resetSeason(): { ok: true; arena: ArenaState; snapshot: ArenaSnapshot; awards: number } {
    const now = Date.now();
    const old = this.arena;
    const ranked = [...this.players.values()]
      .filter((p) => !p.banned)
      .sort((a, b) => b.tiq - a.tiq || b.wins - a.wins || a.id.localeCompare(b.id));
    const entries = ranked.slice(0, SNAPSHOT_MAX).map((p, i): ArenaSnapshotEntry => ({
      rank: i + 1,
      id: p.id,
      name: p.name,
      tiq: p.tiq,
      wins: p.wins,
    }));
    const snapshot: ArenaSnapshot = {
      seasonNo: old.seasonNo,
      seasonName: old.seasonName,
      takenAt: now,
      total: ranked.length,
      entries,
    };
    ranked.forEach((p, i) => {
      const rank = i + 1;
      const award: SeasonAward = {
        seasonNo: old.seasonNo,
        seasonName: old.seasonName,
        rank,
        tiq: rewardFor(rank),
        badge: badgeFor(rank, old.seasonNo),
        awardedAt: now,
      };
      p.awards = [...(p.awards ?? []), award].slice(-AWARDS_KEEP);
    });

    const nextNo = clamp(old.seasonNo + 1, 1, 999);
    this.arena = {
      ...old,
      status: 'active',
      matchLocked: false,
      seasonNo: nextNo,
      seasonName: nextSeasonName(old.seasonName, nextNo),
      endsAt: now + SEASON_MS,
      updatedAt: now,
      lastSnapshot: snapshot,
      awardsCount: ranked.length,
    };
    this.persist();
    this.persistArena();
    this.pairNow();
    this.rearm();
    this.broadcastArena('SEASON_RESET');
    return { ok: true, arena: this.arena, snapshot, awards: ranked.length };
  }

  private persistArena(): void {
    const storage = this.state?.storage;
    if (!storage) return;
    try {
      void storage.put('arena', this.arena);
    } catch {
      /* a store that refuses the write: the board stays in memory */
    }
  }

  /**
   * Tell every socket the board moved: waiters, live racers, and rooms still filling. Each frame
   * carries that seat's newest award, so a prize rollover lands mid-socket without waiting for the
   * next public read.
   */
  private broadcastArena(reason: string): void {
    const view = this.arenaPublicView();
    const sockets = new Map<WebSocket, string>();
    for (const w of this.queue) sockets.set(w.ws, w.id);
    for (const race of this.races.values()) for (const seat of race.seats) sockets.set(seat.ws, seat.id);
    for (const room of this.rooms.values()) for (const m of room.members) if (m) sockets.set(m.ws, m.id);
    for (const room of this.openRooms) for (const m of room.members) if (m) sockets.set(m.ws, m.id);
    for (const lobby of this.lobbies.values()) for (const m of lobby.members) if (m) sockets.set(m.ws, m.id);
    for (const [ws, id] of sockets) {
      const awards = this.players.get(id)?.awards ?? [];
      const payload = JSON.stringify({
        type: 'ARENA',
        arena: view,
        reason,
        award: awards.length ? awards[awards.length - 1] : null,
      });
      try {
        ws.send(payload);
      } catch {
        /* the socket is already gone */
      }
    }
  }

  /** The room's own gate: new entries stop, in-flight boards carry on. An expired clock is closed. */
  private arenaLocked(): boolean {
    return this.arena.matchLocked || this.arena.status !== 'active' || this.arena.endsAt <= Date.now();
  }

  /* ---------- the directory ---------- */

  /** Is this seat locked out of matchmaking? */
  private restricted(id: string): boolean {
    return this.banned.has(id) || this.players.get(id)?.banned === true;
  }

  /**
   * Move a seat's `lastSeen` forward and credit the growth rings for whichever buckets that just
   * carried it into. Every player-driven `lastSeen` write goes through here, so the rings can
   * never drift from the registry they are read back against. An admin action on a seat is not
   * player activity and deliberately does not.
   */
  private stampSeen(p: PlayerRecord, at: number): void {
    const prev = p.lastSeen;
    if (at <= prev) return;
    p.lastSeen = at;
    this.creditActive(prev, at);
  }

  /**
   * Fold a connection into the registry. The room is the authority for race telemetry, but the
   * profile and economy figures come from the seat's own client — the same query string that
   * seeded the queue. Figures only ever climb here: a stale client reporting a spent wallet must
   * not walk a granted balance back, and granting is the panel's job anyway.
   */
  private touch(identity: Identity): void {
    const now = Date.now();
    const id = identity.player.id;
    const isNew = !this.players.has(id);
    const p = this.players.get(id) ?? freshPlayer(identity, now);
    p.name = identity.player.name || p.name;
    p.username = identity.player.username || p.username;
    p.country = identity.flag || p.country;
    if (identity.age > 0) p.age = Math.min(120, Math.floor(identity.age));
    p.tiq = Math.max(0, Math.floor(identity.tiq));
    /* A first sighting is a signup and an active player at once, and `freshPlayer` has already
       stamped its clock; every later one just moves the seat forward through the rings. */
    if (isNew) {
      this.creditSignup(now);
      this.creditActive(0, now);
    } else {
      this.stampSeen(p, now);
    }
    p.coins = Math.max(p.coins, identity.coins);
    p.stars = Math.max(p.stars, identity.stars);
    p.referrals = Math.max(p.referrals, identity.referrals);
    p.squad = identity.squad || p.squad;
    p.banned = p.banned || this.banned.has(id);
    p.muted = p.muted || p.banned;
    if (!this.players.has(id)) {
      this.trim();
      this.players.set(id, p);
    }
    this.persist();
  }

  /**
   * Stamp one seat's activity the moment the room hears from it. `touch` only sees a socket
   * connect; a player who keeps the app open and plays for hours must not still read "Active 16h
   * ago" in the Command Center. Every queue move, room join, board move and finish comes through
   * here, and the write rides the same debounced flush as the rest of the registry.
   */
  private markActive(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    this.stampSeen(p, Date.now());
    this.persist();
  }

  /** The seat's board came to rest: count it. `winner` null means nobody won — an admin abort. */
  private verdict(id: string, won: boolean | null): void {
    const p = this.players.get(id);
    if (!p) return;
    p.inMatch = false;
    this.stampSeen(p, Date.now());
    if (won !== null) {
      p.matches++;
      p.lastPlayed = p.lastSeen;
      if (won) {
        p.wins++;
        p.streak++;
        p.best = Math.max(p.best, p.streak);
      } else {
        p.losses++;
        p.streak = 0;
      }
    }
    this.persist();
  }

  /** Mark a seat as holding a live board (or back on the market). */
  private setInMatch(id: string, on: boolean): void {
    const p = this.players.get(id);
    if (!p) return;
    p.inMatch = on;
    this.stampSeen(p, Date.now());
    this.persist();
  }

  /** Count what the authoritative board actually did between two states. */
  private countBoard(before: GameState, after: GameState): void {
    const mines = after.mines.length - before.mines.length;
    this.bumpMetrics({ minesPlaced: mines });
  }

  /**
   * Stamp completed matches into their UTC-hour buckets. Only the retained window is kept, so the
   * blob stays small while the rolling 24-hour figure stays exact.
   */
  private stampMatchesByHour(matches: number, now = Date.now()): void {
    if (matches <= 0) return;
    const hour = Math.floor(now / HOUR_MS);
    const key = String(hour);
    this.gameMetrics.matchesByHour[key] = whole(this.gameMetrics.matchesByHour[key]) + matches;
    const oldest = hour - MATCH_BUCKET_KEEP_HOURS;
    for (const stored of Object.keys(this.gameMetrics.matchesByHour)) {
      if (Number(stored) < oldest) delete this.gameMetrics.matchesByHour[stored];
    }
  }

  /** Matches stamped inside a rolling window, read back from the hourly buckets. */
  private matchesInWindow(windowMs: number, now = Date.now()): number {
    const oldest = Math.floor((now - windowMs) / HOUR_MS);
    const newest = Math.floor(now / HOUR_MS);
    let total = 0;
    for (const [key, value] of Object.entries(this.gameMetrics.matchesByHour)) {
      const hour = Number(key);
      if (hour >= oldest && hour <= newest) total += value;
    }
    return total;
  }

  /* ---------- the growth rings: what the Stats tab's trend chart plots ---------- */

  /**
   * Fold one real event into both rings. `slot` is the count it moves: 0 signups, 1 active,
   * 2 matches. `dedupeFrom` is the timestamp this seat was last counted at — a player only credits
   * `active` when the event carries them into a bucket they have not been counted in yet, so an
   * hour of continuous play reads as one active player rather than forty. That dedupe survives an
   * eviction because it reads the record's own persisted `lastSeen`, not an in-memory set.
   *
   * The rings are pruned whenever a bucket is first opened, which is the only moment they can
   * grow: 24 hourly rows and 30 daily rows is the ceiling, forever.
   */
  private creditGrowth(slot: 0 | 1 | 2, at: number, by = 1, dedupeFrom = -1): void {
    if (by <= 0) return;
    const hour = Math.floor(at / HOUR_MS);
    const day = dayIndexOf(at);
    const freshHour = dedupeFrom < 0 || Math.floor(dedupeFrom / HOUR_MS) !== hour;
    const freshDay = dedupeFrom < 0 || dayIndexOf(dedupeFrom) !== day;
    /* the hot path: a seat already counted in both buckets costs nothing at all, and no key is
       formatted — this runs on every board move, so allocation here would be pure waste */
    if (!freshHour && !freshDay) return;
    let opened = false;
    const stamp = (map: Record<string, GrowthBucket>, key: string): void => {
      const bucket = map[key];
      if (bucket) {
        bucket[slot] = whole(bucket[slot]) + by;
        return;
      }
      const row: GrowthBucket = [0, 0, 0];
      row[slot] = by;
      map[key] = row;
      opened = true;
    };
    if (freshHour) stamp(this.growth.hourly, String(hour));
    if (freshDay) stamp(this.growth.daily, this.growthDayKey(day));
    if (opened) pruneGrowth(this.growth, at);
    this.persistMetrics();
  }

  /** The UTC day key, memoised: the calendar turns once a day, board moves turn thousands of times. */
  private growthDayKey(index: number): string {
    if (index !== this.memoDayIndex) {
      this.memoDayIndex = index;
      this.memoDayKey = dayKeyOf(index);
    }
    return this.memoDayKey;
  }

  /** A first-time registration, counted in the bucket it actually landed in. */
  private creditSignup(at: number): void {
    this.creditGrowth(0, at);
  }

  /** A seat's `lastSeen` moving forward: one more active player in any bucket not yet credited. */
  private creditActive(prevSeen: number, at: number): void {
    this.creditGrowth(1, at, 1, prevSeen > 0 ? prevSeen : -1);
  }

  /** Boards that reached a verdict. Every one of them counts, so there is nothing to dedupe. */
  private creditMatches(matches: number, at = Date.now()): void {
    this.creditGrowth(2, at, matches);
  }

  /** Matches settled on one UTC day, summed from the eight-day-deep hourly match buckets. */
  private matchesOnDay(dayIndex: number): number {
    let total = 0;
    for (let hour = 0; hour < 24; hour++) {
      total += whole(this.gameMetrics.matchesByHour[String(dayIndex * 24 + hour)]);
    }
    return total;
  }

  /**
   * Signup and active counts folded straight out of the registry's own timestamps. `firstSeen`
   * never moves once written, so the signup column this produces is exact across the whole
   * retained window; `lastSeen` only survives a seat's most recent visit, so the active column is
   * a floor the ring buffers build on. A seat the room has already trimmed contributes nothing —
   * there is no estimate anywhere in here.
   */
  private foldRegistry(hour: number, day: number): {
    hourly: Map<number, GrowthBucket>;
    daily: Map<number, GrowthBucket>;
  } {
    const hourly = new Map<number, GrowthBucket>();
    const daily = new Map<number, GrowthBucket>();
    const oldestHour = hour - HOURLY_KEEP + 1;
    const oldestDay = day - DAILY_KEEP + 1;
    const credit = (
      map: Map<number, GrowthBucket>, index: number, oldest: number, newest: number, slot: 0 | 1,
    ): void => {
      if (index < oldest || index > newest) return;
      const bucket = map.get(index) ?? [0, 0, 0] as GrowthBucket;
      bucket[slot]++;
      map.set(index, bucket);
    };
    for (const p of this.players.values()) {
      if (p.firstSeen > 0) {
        credit(hourly, Math.floor(p.firstSeen / HOUR_MS), oldestHour, hour, 0);
        credit(daily, dayIndexOf(p.firstSeen), oldestDay, day, 0);
      }
      if (p.lastSeen > 0) {
        credit(hourly, Math.floor(p.lastSeen / HOUR_MS), oldestHour, hour, 1);
        credit(daily, dayIndexOf(p.lastSeen), oldestDay, day, 1);
      }
    }
    return { hourly, daily };
  }

  /**
   * The three ready-to-plot windows, oldest point first. Each bucket is the larger of two real
   * measurements: what the rings stamped as events arrived, and what the registry's own
   * timestamps (plus the hourly match buckets) fold back for the same span. Taking the larger
   * invents nothing — both sides are measured — and it is what lets the chart carry real history
   * on the very first reading after a deploy, before the rings have had any time to fill.
   */
  private growthWindows(now: number): Pick<ServerMetrics, 'series24h' | 'series7d' | 'series30d'> {
    const hour = Math.floor(now / HOUR_MS);
    const day = dayIndexOf(now);
    const folded = this.foldRegistry(hour, day);

    const series24h: SeriesPoint[] = [];
    for (let back = HOURLY_KEEP - 1; back >= 0; back--) {
      const index = hour - back;
      const stamped = this.growth.hourly[String(index)];
      const registry = folded.hourly.get(index);
      series24h.push({
        t: index * HOUR_MS,
        signups: Math.max(stamped?.[0] ?? 0, registry?.[0] ?? 0),
        active: Math.max(stamped?.[1] ?? 0, registry?.[1] ?? 0),
        matches: Math.max(stamped?.[2] ?? 0, whole(this.gameMetrics.matchesByHour[String(index)])),
      });
    }

    const series30d: SeriesPoint[] = [];
    for (let back = DAILY_KEEP - 1; back >= 0; back--) {
      const index = day - back;
      const stamped = this.growth.daily[dayKeyOf(index)];
      const registry = folded.daily.get(index);
      series30d.push({
        t: index * DAY_MS,
        signups: Math.max(stamped?.[0] ?? 0, registry?.[0] ?? 0),
        active: Math.max(stamped?.[1] ?? 0, registry?.[1] ?? 0),
        matches: Math.max(stamped?.[2] ?? 0, this.matchesOnDay(index)),
      });
    }

    return { series24h, series7d: series30d.slice(-7), series30d };
  }

  /** Add to the durable gameplay counters; a missing or negative delta is exactly zero. */
  private bumpMetrics(delta: Partial<GameMetrics>): void {
    const matches = whole(delta.matchesCompleted);
    const mines = whole(delta.minesPlaced);
    if (!matches && !mines) return;
    this.gameMetrics.matchesCompleted += matches;
    this.gameMetrics.minesPlaced += mines;
    if (matches) {
      this.stampMatchesByHour(matches);
      this.creditMatches(matches);
    }
    this.persistMetrics();
  }

  /** One completed room credits the match counter once, however it reached its winner. */
  private completeRoom(live: LiveRoom): void {
    if (live.counted) return;
    live.counted = true;
    this.bumpMetrics({ matchesCompleted: 1 });
  }

  /** Schedule a counter write; many moves in one turn still cost one flush. */
  private persistMetrics(): void {
    if (this.metricsDirty || !this.state?.storage) return;
    this.metricsDirty = true;
    void Promise.resolve().then(() => {
      this.metricsDirty = false;
      const storage = this.state.storage;
      if (!storage) return;
      try {
        /* one atomic write: the counters and the pruned rings land together, or not at all */
        void storage.put({
          [GAME_METRICS_KEY]: this.gameMetrics,
          [GROWTH_KEY]: this.growth,
        });
      } catch {
        /* a store that refuses the write: the counters stay live for this object's lifetime */
      }
    });
  }

  /**
   * Pull a banned seat out of matchmaking: any queue waiter is told why and let go, any room that
   * is still filling loses the seat and reopens it. A board already under way is somebody's game
   * and plays out untouched — only the next race is denied.
   */
  private kick(id: string, reason: string): void {
    for (const w of [...this.queue]) {
      if (w.id !== id) continue;
      const at = this.queue.indexOf(w);
      if (at !== -1) this.queue.splice(at, 1);
      this.deliver(w, JSON.stringify({ type: 'ERROR', reason }));
      try {
        w.ws.close(1000, reason.toLowerCase());
      } catch {
        /* the socket is already gone */
      }
    }
    for (const live of [...this.openRooms]) {
      for (const m of [...live.members]) {
        if (!m || m.id !== id) continue;
        this.postTo(m.ws, JSON.stringify({ type: 'ERROR', reason }));
        try {
          m.ws.close(1000, reason.toLowerCase());
        } catch {
          /* the socket is already gone */
        }
      }
    }
    this.setInMatch(id, false);
  }

  /** One page of the directory: filtered, sorted, and windowed. */
  private playersPage(params: URLSearchParams): PlayersPage {
    const q = (params.get('q') ?? '').trim().toLowerCase().slice(0, 64);
    const filter = filterOf(params.get('filter'));
    const countryRaw = (params.get('country') ?? '').trim().toUpperCase();
    const country = /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : '';
    const age = ageBandOf(params.get('age'));
    const sort = sortOf(params.get('sort')) ?? (filter === 'tiq' ? 'tiq' : 'default');
    const offset = Math.max(0, Math.floor(Number(params.get('offset')) || 0));
    const limit = Math.min(PLAYERS_LIMIT, Math.max(1, Math.floor(Number(params.get('limit')) || 40)));
    const now = Date.now();
    const tokens = q.split(/\s+/).filter(Boolean);
    let rows = [...this.players.values()];
    if (tokens.length) {
      rows = rows.filter((p) => {
        const hay = `${p.name} ${p.username} ${p.tgId} ${p.id}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      });
    }
    if (filter === 'active') rows = rows.filter((p) => p.inMatch || now - p.lastSeen <= ACTIVE_MS);
    if (filter === 'flagged') rows = rows.filter((p) => p.banned || p.muted);
    if (country) rows = rows.filter((p) => p.country === country);
    if (age !== 'all') rows = rows.filter((p) => inAgeBand(p.age, age));
    /* the default order reads like the room: flagged first when that is the view, else live boards,
       then the freshest seats. The three explicit sorts answer an audit question instead. */
    if (sort === 'lastPlayed') rows.sort((a, b) => b.lastPlayed - a.lastPlayed || b.lastSeen - a.lastSeen);
    else if (sort === 'joined') rows.sort((a, b) => b.firstSeen - a.firstSeen);
    else if (sort === 'tiq') rows.sort((a, b) => b.tiq - a.tiq || b.lastSeen - a.lastSeen);
    else if (filter === 'flagged') rows.sort((a, b) => Number(b.banned) - Number(a.banned) || b.lastSeen - a.lastSeen);
    else rows.sort((a, b) => Number(b.inMatch) - Number(a.inMatch) || b.lastSeen - a.lastSeen);
    const total = rows.length;
    return { ok: true, total, offset, limit, players: rows.slice(offset, offset + limit) };
  }

  /** BAN / UNBAN / GRANT_COINS on one seat, answering with the record as it now stands. */
  private playerAction(body: Record<string, unknown>): { ok: boolean; error?: string; player?: PlayerRecord } {
    const id = typeof body.id === 'string' ? body.id.slice(0, 64) : '';
    const action = typeof body.action === 'string' ? body.action : '';
    const p = id ? this.players.get(id) : undefined;
    if (!p) return { ok: false, error: 'no_such_player' };
    if (action === 'BAN') {
      p.banned = true;
      p.muted = true;
      this.banned.add(p.id);
      this.kick(p.id, 'BANNED');
    } else if (action === 'UNBAN') {
      p.banned = false;
      p.muted = false;
      this.banned.delete(p.id);
    } else if (action === 'GRANT_COINS') {
      const n = typeof body.coins === 'number' && Number.isFinite(body.coins) ? Math.round(body.coins) : 0;
      p.coins = clamp(p.coins + clamp(n, -1_000_000, 1_000_000), 0, 100_000_000);
    } else {
      return { ok: false, error: 'unknown_action' };
    }
    /* an admin's hand on a seat is not that player's own activity: the record's clock refreshes,
       but the growth rings are not told anything happened */
    p.lastSeen = Date.now();
    this.persist();
    return { ok: true, player: p };
  }

  /** Keep the registry a directory, not a leak: at the cap the oldest quiet seat is forgotten. */
  private trim(): void {
    if (this.players.size < PLAYERS_MAX) return;
    let oldest: PlayerRecord | null = null;
    for (const p of this.players.values()) {
      if (p.banned || p.muted || p.inMatch) continue;
      if (!oldest || p.lastSeen < oldest.lastSeen) oldest = p;
    }
    if (oldest) this.players.delete(oldest.id);
  }

  /** Schedule a registry write. Many touches in one turn still cost one flush. */
  private persist(): void {
    if (this.dirty || !this.state?.storage) return;
    this.dirty = true;
    void Promise.resolve().then(() => {
      this.dirty = false;
      const storage = this.state.storage;
      if (!storage) return;
      try {
        void storage.put('players', [...this.players.values()]);
        void storage.put('bans', [...this.banned]);
      } catch {
        /* a store that refuses the write: the registry stays in memory */
      }
    });
  }

  /** Every waiting seat is told why and let go. A race already under way is somebody's game. */
  private evictAll(reason: string): void {
    const waiting = this.queue;
    this.queue = [];
    for (const w of waiting) {
      this.deliver(w, JSON.stringify({ type: 'ERROR', reason }));
      try {
        w.ws.close(1000, reason.toLowerCase());
      } catch {
        /* the socket is already gone */
      }
    }
    /* a room still filling its seats is waiting too: nobody is locked into a board yet */
    for (const live of [...this.openRooms]) {
      for (const m of live.members) {
        if (!m) continue;
        this.refs.delete(m.ws);
        try {
          m.ws.send(JSON.stringify({ type: 'ERROR', reason }));
          m.ws.close(1000, reason.toLowerCase());
        } catch {
          /* the socket is already gone */
        }
      }
    }
    for (const live of [...this.lobbies.values()]) {
      for (const m of live.members) {
        if (!m) continue;
        this.refs.delete(m.ws);
        try {
          m.ws.send(JSON.stringify({ type: 'ERROR', reason }));
          m.ws.close(1000, reason.toLowerCase());
        } catch {
          /* the socket is already gone */
        }
      }
    }
    this.lobbies.clear();
    this.openRooms = [];
    this.rearm();
  }

  /** The admin pulls a stuck room: both seats are told, then the room stops existing. */
  private abort(race: Race): void {
    this.settle(race);
    for (const seat of race.seats) {
      this.deliver(seat, JSON.stringify({ type: 'ABORTED', matchId: race.matchId }));
      try {
        seat.ws.close(1000, 'aborted');
      } catch {
        /* the socket is already gone */
      }
    }
  }

  /** The admin pulls a multi-seat room: every seat still held by a person is told, then let go. */
  private abortRoom(live: LiveRoom): void {
    this.rooms.delete(live.matchId);
    for (const m of live.members) {
      if (!m) continue;
      this.refs.delete(m.ws);
      /* an admin pull is not a verdict: the seat is free, the record untouched */
      this.verdict(m.id, null);
      try {
        m.ws.send(JSON.stringify({ type: 'ABORTED', matchId: live.matchId }));
        m.ws.close(1000, 'aborted');
      } catch {
        /* the socket is already gone */
      }
    }
  }

  /* ---------- the queue ---------- */

  private enter(ws: WebSocket, identity: Identity, wide: boolean, sizes: [number, number]): Waiter {
    const waiter: Waiter = {
      ws,
      id: identity.player.id,
      name: identity.player.name,
      tiq: identity.tiq,
      tier: identity.tier,
      flag: identity.flag,
      wide,
      joinedAt: Date.now(),
      sizes,
      race: null,
      side: 0,
    };
    this.queue.push(waiter);
    return waiter;
  }

  private attach(waiter: Waiter): void {
    waiter.ws.addEventListener('message', (ev: MessageEvent) => {
      const board = boardOf(waiter);
      const msg = readMessage(ev.data, waiter.side, board.cols, board.rows);
      if (!msg) return;
      /* a paired socket is a race, not a queue: the same connection changes what it means */
      if (waiter.race) this.relay(waiter, msg);
      else if (msg.type === 'QUEUE') this.enqueue(waiter, msg.wide);
      else if (msg.type === 'WIDEN') this.widen(waiter);
      else if (msg.type === 'CANCEL') this.leave(waiter, true);
    });
    waiter.ws.addEventListener('close', () => this.leave(waiter, false));
    waiter.ws.addEventListener('error', () => this.leave(waiter, false));
  }

  /** QUEUE enters the player, or updates the filter of one already waiting, then looks for a race. */
  private enqueue(waiter: Waiter, wide: boolean): void {
    /* The maintenance lock is enforced here, not in the panel: a socket that asks anyway is told
       why and closed cleanly, so a client that never saw the toggle still cannot get in. */
    if (this.maintenance) {
      this.deliver(waiter, JSON.stringify({ type: 'ERROR', reason: 'MAINTENANCE' }));
      try {
        waiter.ws.close(1000, 'maintenance');
      } catch {
        /* the socket is already gone */
      }
      return;
    }
    if (this.arenaLocked()) {
      this.deliver(waiter, JSON.stringify({ type: 'ERROR', reason: 'MATCHING_LOCKED' }));
      try {
        waiter.ws.close(1000, 'locked');
      } catch {
        /* the socket is already gone */
      }
      return;
    }
    /* a socket that connected before the ban is told at the door too, not silently held */
    if (this.restricted(waiter.id)) {
      this.deliver(waiter, JSON.stringify({ type: 'ERROR', reason: 'BANNED' }));
      try {
        waiter.ws.close(1000, 'banned');
      } catch {
        /* the socket is already gone */
      }
      return;
    }
    /* a queue frame is live activity: stamp before pairing so a long queued seat reads fresh */
    this.markActive(waiter.id);
    const at = this.queue.indexOf(waiter);
    if (at === -1) {
      waiter.wide = wide;
      waiter.joinedAt = Date.now();
      this.queue.push(waiter);
    } else {
      this.queue[at].wide = wide;              // joinedAt stays: the wait you earned is yours
    }
    this.pairNow();
  }

  /** WIDEN flips the filter on a waiting player and re-runs the search — priority untouched. */
  private widen(waiter: Waiter): void {
    const at = this.queue.indexOf(waiter);
    if (at === -1) return;
    this.markActive(waiter.id);
    this.queue[at].wide = true;
    this.pairNow();
  }

  /** Out of the room. A CANCEL closes the socket; a dead socket is just forgotten — and either
   *  way a player who was racing hands the win to the seat opposite. */
  private leave(waiter: Waiter, close: boolean): void {
    this.markActive(waiter.id);
    const at = this.queue.indexOf(waiter);
    if (at !== -1) this.queue.splice(at, 1);
    if (waiter.race) this.endRace(waiter.race, waiter.side, 'LEFT');
    if (!close) return;
    try {
      waiter.ws.close(1000, 'cancelled');
    } catch {
      /* the socket is already gone */
    }
  }

  /* ---------- pairing ---------- */

  private pairNow(): void {
    if (this.maintenance || this.arenaLocked()) return;
    for (let next = this.take(); next; next = this.take()) this.announce(next[0], next[1]);
  }

  /** The next pair: the close ones first, then the widened net, then anyone at all. */
  private take(): [Waiter, Waiter] | null {
    return this.find(() => true, this.normalRadius)
      ?? this.find((a, b) => a.wide || b.wide, this.wideRadius)
      ?? this.find((a, b) => a.wide && b.wide, Infinity);
  }

  private find(allow: (a: Waiter, b: Waiter) => boolean, radius: number): [Waiter, Waiter] | null {
    const q = this.queue;
    for (let i = 0; i < q.length; i++) {
      for (let j = i + 1; j < q.length; j++) {
        if (q[i].id === q[j].id) continue;               // never race yourself: two tabs, one player
        if (!sameBoard(q[i], q[j])) continue;            // and never across two different games
        if (Math.abs(q[i].tiq - q[j].tiq) > radius) continue;
        if (!allow(q[i], q[j])) continue;
        return [q[i], q[j]];
      }
    }
    return null;
  }

  private announce(a: Waiter, b: Waiter): void {
    this.leave(a, false);
    this.leave(b, false);
    const first = a.joinedAt <= b.joinedAt ? a : b;      // the longer wait takes side 0
    const second = first === a ? b : a;
    const matchId = `m${hash(`${first.id}|${second.id}|${++this.paired}`).toString(36)}`;
    const seed = hash(matchId);                          // one 32-bit seed, both sides told the same
    const sizes = first.sizes;

    first.side = 0;
    second.side = 1;
    const race: Race = {
      matchId,
      seed,
      sizes,
      seats: [first, second],
      state: newGame(sizes),
      startedAt: Date.now(),
      over: false,
    };
    first.race = race;
    second.race = race;
    this.races.set(matchId, race);
    this.setInMatch(first.id, true);
    this.setInMatch(second.id, true);

    this.deliver(first, foundMessage(matchId, seed, 0, second, sizes));
    this.deliver(second, foundMessage(matchId, seed, 1, first, sizes));
  }

  private deliver(waiter: Waiter, payload: string): void {
    try {
      waiter.ws.send(payload);
    } catch {
      this.leave(waiter, false);                         // it closed between pairing and send
    }
  }

  /* ---------- rooms ---------- */

  /**
   * Take a seat in a room of `size`. A room that is still filling and matches the size is joined;
   * otherwise a new one is opened with this socket as the host. The moment every seat is taken the
   * room launches — nobody waits for a fourth when there are four already — and otherwise the wait
   * timer is armed so the machine fills the rest if nobody else turns up.
   */
  private joinRoom(ws: WebSocket, identity: Identity, size: number, tier: BotTier): void {
    if (this.maintenance) {
      this.postTo(ws, JSON.stringify({ type: 'ERROR', reason: 'MAINTENANCE' }));
      try {
        ws.close(1000, 'maintenance');
      } catch {
        /* the socket is already gone */
      }
      return;
    }
    if (this.arenaLocked()) { this.rejectSocket(ws, 'MATCHING_LOCKED'); return; }
    let live = this.openRooms.find((r) => !r.driver && r.size === size && this.freeSeat(r) >= 0);
    if (!live) {
      live = {
        room: createRoom({ code: this.mintRoomCode(), seats: size, waitMs: ROOM_WAIT_MS, botTier: tier, now: Date.now() }),
        size,
        counted: false,
        members: Array.from({ length: size }, () => null),
        matchId: '',
        seed: 0,
        startedAt: 0,
        driver: null,
        hostSeat: 0,
        format: formatForSize(size),
        mode: 'ffa',
        teams: Array.from({ length: size }, (_, i) => defaultTeam(i)),
        code: false,
      };
      this.openRooms.push(live);
    }
    const seat = this.freeSeat(live);
    if (seat < 0) return;                        // unreachable: the search only picks rooms with one
    live.members[seat] = {
      ws, seat, id: identity.player.id, name: identity.player.name,
      tiq: identity.tiq, tier: identity.tier, flag: identity.flag,
    };
    live.room = seatHuman(live.room, seat, {
      kind: 'human', id: identity.player.id, name: identity.player.name,
    });
    this.refs.set(ws, { live, seat });
    this.markActive(identity.player.id);

    ws.addEventListener('message', (ev: MessageEvent) => {
      const ref = this.refs.get(ws);
      if (!ref) return;
      const board = ref.live.driver
        ? ref.live.driver.state
        : dimsFor(contendersIn(sizesOf(ref.live.room)));
      const msg = readMessage(ev.data, ref.seat, board.cols, board.rows);
      if (msg) this.roomFrame(ref, msg);
    });
    ws.addEventListener('close', () => this.roomLeave(this.refs.get(ws)));
    ws.addEventListener('error', () => this.roomLeave(this.refs.get(ws)));

    /* a full room starts now; anything less waits, and the alarm fills it when the wait runs out */
    if (live.members.every((m) => m !== null)) this.launchRoom(live);
    else this.rearm();
  }

  /**
   * Take a seat in a code-based friends lobby. `host=1` mints the room; a guest has to be expected,
   * because a code nobody minted is a typo, not a room. Unlike the `?room=<n>` path this one never
   * fills on a timer: a private room waits for the people it invited, and the host decides when it
   * is time.
   */
  private joinLobby(ws: WebSocket, identity: Identity, code: string, host: boolean, tier: BotTier): void {
    if (this.maintenance) { this.rejectSocket(ws, 'MAINTENANCE'); return; }
    if (this.arenaLocked()) { this.rejectSocket(ws, 'MATCHING_LOCKED'); return; }
    let live = this.lobbies.get(code) ?? null;
    if (live?.driver) { this.rejectSocket(ws, 'room_started'); return; }
    if (!live) {
      if (!host) { this.rejectSocket(ws, 'room_not_found'); return; }
      const format: LobbyFormat = '4p';
      const size = FORMAT_CAPACITY[format];
      live = {
        room: createRoom({ code, seats: size, waitMs: ROOM_WAIT_MS, botTier: tier, now: Date.now() }),
        size,
        counted: false,
        members: Array.from({ length: size }, () => null),
        matchId: '',
        seed: 0,
        startedAt: 0,
        driver: null,
        hostSeat: 0,
        format,
        mode: FORMAT_MODE[format],
        teams: Array.from({ length: size }, (_, i) => defaultTeam(i)),
        code: true,
      };
      this.lobbies.set(code, live);
    } else if (host) {
      /* two hosts on one code would fight over the crown: the second one is told to join instead */
      this.rejectSocket(ws, 'room_exists');
      return;
    }
    const seat = this.freeSeat(live);
    if (seat < 0) { this.rejectSocket(ws, 'room_full'); return; }
    live.members[seat] = {
      ws, seat, id: identity.player.id, name: identity.player.name,
      tiq: identity.tiq, tier: identity.tier, flag: identity.flag,
    };
    live.room = seatHuman(live.room, seat, {
      kind: 'human', id: identity.player.id, name: identity.player.name,
    });
    this.refs.set(ws, { live, seat });
    this.markActive(identity.player.id);

    ws.addEventListener('message', (ev: MessageEvent) => {
      const ref = this.refs.get(ws);
      if (!ref) return;
      const board = ref.live.driver
        ? ref.live.driver.state
        : dimsFor(contendersIn(sizesOf(ref.live.room)));
      const msg = readMessage(ev.data, ref.seat, board.cols, board.rows);
      if (msg) this.roomFrame(ref, msg);
    });
    ws.addEventListener('close', () => this.roomLeave(this.refs.get(ws)));
    ws.addEventListener('error', () => this.roomLeave(this.refs.get(ws)));

    this.broadcastLobby(live);
  }

  /** One `LOBBY` frame, per seat: the roster, the crown, the format, and which seat is yours. */
  private lobbyMessage(live: LiveRoom, seat: number): string {
    const seats: unknown[] = [];
    for (let i = 0; i < live.members.length; i++) {
      const m = live.members[i];
      if (!m) continue;
      seats.push({
        side: i,
        id: m.id,
        name: m.name,
        host: i === live.hostSeat,
        bot: false,
        team: live.teams[i] ?? 0,
        connected: true,
      });
    }
    return JSON.stringify({
      type: 'LOBBY',
      code: live.room.code,
      host: live.hostSeat,
      format: live.format,
      mode: live.mode,
      you: seat,
      capacity: live.size,
      seats,
    });
  }

  /** Tell every seat what the room now looks like. The one write path for lobby state. */
  private broadcastLobby(live: LiveRoom): void {
    for (const m of live.members) {
      if (m) this.postTo(m.ws, this.lobbyMessage(live, m.seat));
    }
  }

  /**
   * A seat left a lobby that has not launched. The crown migrates to the lowest seat still held —
   * a room whose host walked out is still somebody's room — and the last person out closes it.
   */
  private lobbyDepart(live: LiveRoom, seat: number): void {
    if (!live.members.some((m) => m !== null)) {
      this.lobbies.delete(live.room.code);
      return;
    }
    if (live.hostSeat === seat) {
      const next = live.members.findIndex((m) => m !== null);
      if (next >= 0) live.hostSeat = next;
    }
    this.broadcastLobby(live);
  }

  /**
   * The host picked a new size. The seats are reflowed around the people already sitting in them —
   * never dropped — and when they do not all fit, the pick is bounced back to the host with the
   * room untouched. Capacity, race mode and the default Blue/Red split all move with the format.
   */
  private applyFormat(live: LiveRoom, format: LobbyFormat): void {
    if (live.driver || live.format === format) return;
    const capacity = FORMAT_CAPACITY[format];
    const reflowed = reflowRoom(live.room, capacity);
    if (!reflowed) {
      const host = live.members[live.hostSeat];
      if (host) this.postTo(host.ws, JSON.stringify({ type: 'FORMAT_DENIED', reason: 'room_full' }));
      this.broadcastLobby(live);
      return;
    }
    const members: (RoomMember | null)[] = Array.from({ length: capacity }, () => null);
    for (const { from, to } of reflowed.moves) {
      const m = live.members[from];
      if (!m) continue;
      const moved: RoomMember = { ...m, seat: to };
      members[to] = moved;
      const ref = this.refs.get(moved.ws);
      if (ref) ref.seat = to;
    }
    live.room = reflowed.room;
    live.members = members;
    live.size = capacity;
    live.format = format;
    live.mode = FORMAT_MODE[format];
    live.teams = Array.from({ length: capacity }, (_, i) => defaultTeam(i));
    this.broadcastLobby(live);
  }

  /** A lobby seat walked out on purpose: let the socket go, then settle the room. */
  private leaveLobby(ref: RoomRef): void {
    const live = ref.live;
    const member = live.members[ref.seat];
    if (member) {
      this.refs.delete(member.ws);
      try {
        member.ws.close(1000, 'left');
      } catch {
        /* the socket is already gone */
      }
      live.members[ref.seat] = null;
    }
    this.lobbyDepart(live, ref.seat);
  }

  /** A refusal is a decision, not a dead socket: say why, then let the socket go. */
  private rejectSocket(ws: WebSocket, reason: string): void {
    this.postTo(ws, JSON.stringify({ type: 'ERROR', reason }));
    try {
      ws.close(1000, 'refused');
    } catch {
      /* the socket is already gone */
    }
  }

  /** The lowest seat nobody is holding. */
  private freeSeat(live: LiveRoom): number {
    return live.members.findIndex((m) => m === null);
  }

  /** A room's 4-digit invite code, minted from the pairing counter so two rooms never collide. */
  private mintRoomCode(): string {
    return String(1000 + ((++this.paired * 7919) % 9000));
  }

  /**
   * Arm the object's clock for the earliest wait still running. A Durable Object can be evicted
   * between messages, and an alarm is the one thing that survives it, so the wait timer lives here
   * rather than in a `setTimeout` that would die with the instance.
   */
  private rearm(): void {
    const storage = this.state.storage;
    if (!storage) return;                        // a harness with no storage backend drives `alarm()` itself
    let soonest = Infinity;
    for (const live of this.openRooms) {
      if (live.driver) continue;
      soonest = Math.min(soonest, live.room.openedAt + live.room.waitMs);
    }
    if (this.arena.status === 'active') soonest = Math.min(soonest, this.arena.endsAt);
    if (soonest === Infinity) storage.deleteAlarm();
    else storage.setAlarm(soonest);
  }

  /**
   * Freeze the room and put it on the board: every seat still empty is backfilled with a bot, the
   * roster is told who is sitting where, and the machine plays any turn it already owns. From here
   * the room is a race, and the driver is the only thing that judges it.
   */
  private launchRoom(live: LiveRoom): void {
    if (live.driver) return;
    live.room = launch(backfill(live.room));
    live.seed = hash(`${live.room.code}|${live.members.map((m) => m?.id ?? 'bot').join('|')}|${this.paired}`);
    live.matchId = `r${hash(`${live.room.code}|${++this.paired}`).toString(36)}`;
    live.startedAt = Date.now();
    live.driver = createRoomDriver(live.room);
    this.openRooms = this.openRooms.filter((r) => r !== live);
    this.lobbies.delete(live.room.code);
    this.rooms.set(live.matchId, live);
    this.rearm();

    for (const m of live.members) {
      if (!m) continue;
      this.setInMatch(m.id, true);
      this.postTo(m.ws, this.roomFoundMessage(live, m.seat));
    }
    /* Seat 0 is the host, so a person normally opens — but a takeover or an odd roster can put the
       machine on turn before anybody has moved, and the room must not wait for a human to start it. */
    const opening = live.driver.state;
    this.pushRoomEvents(live, live.driver.runBots());
    this.countBoard(opening, live.driver.state);
  }

  /** `ROOM_FOUND`: the seat, the shared race, and every seat's name and owner. */
  private roomFoundMessage(live: LiveRoom, seat: number): string {
    const roster = live.driver?.room ?? live.room;
    return JSON.stringify({
      type: 'ROOM_FOUND',
      matchId: live.matchId,
      seed: live.seed,
      side: seat,
      sizes: sizesOf(roster),
      mode: live.mode,
      teams: live.teams,
      seats: roster.seats.map((s, i) => ({
        side: i,
        id: s.id || `seat:${i}`,
        name: s.name,
        bot: isAutomated(roster, i),
        team: live.teams[i] ?? 0,
        difficulty: difficultyFor(roster, i),
      })),
    });
  }

  /** A frame from a seat in a room: the host's early start, a move, or a resignation. */
  private roomFrame(ref: RoomRef, msg: ClientMessage): void {
    const live = ref.live;
    const member = live.members[ref.seat];
    if (member) this.markActive(member.id);
    if (!live.driver) {
      /* Before the launch the only vocabulary a lobby has is the host's start and size pick, and
         a seat's own team move. Any seat may leave at any time. */
      if (msg.type === 'CANCEL') { this.leaveLobby(ref); return; }
      if (msg.type === 'ROOM_START') {
        if (ref.seat !== live.hostSeat) return;
        /* A friends room needs its format's minimum before it is a race — two players, or all
           three for the 2v1's lone challenger. The auto-pair room does not, because its whole
           contract is that the machine fills whatever is left. */
        const held = live.members.filter((m) => m !== null).length;
        if (!live.code || held >= (live.format === '2v1' ? 3 : 2)) this.launchRoom(live);
        return;
      }
      if (msg.type === 'SET_FORMAT') {
        if (ref.seat === live.hostSeat) this.applyFormat(live, msg.format);
        return;
      }
      if (msg.type === 'SET_MODE') {
        if (ref.seat === live.hostSeat) this.applyFormat(live, formatOfMode(msg.mode));
        return;
      }
      if (msg.type === 'SET_TEAM') {
        if (live.mode !== 'team') return;
        if (ref.seat !== live.hostSeat && msg.side !== ref.seat) return;
        if (msg.side >= live.size) return;
        const next = assignTeam(
          live.teams,
          live.members.map((m) => m !== null),
          msg.side,
          msg.team,
          live.format,
        );
        if (!next) return;
        live.teams = next;
        this.broadcastLobby(live);
      }
      return;
    }
    if (msg.type === 'EMOTE') {
      /* Every other seat still in the race sees it; a lobby seat has no opponent bubble yet. */
      if (!live.driver) return;
      for (const m of live.members) {
        if (!m || m.seat === ref.seat) continue;
        this.postTo(m.ws, JSON.stringify({ type: 'EMOTE', side: ref.seat, emote: msg.emote }));
      }
      return;
    }
    if (msg.type === 'PHRASE') {
      /* A phrase rides the same way an emote does: every other seat, as the (lang, index) pair. */
      if (!live.driver) return;
      for (const m of live.members) {
        if (!m || m.seat === ref.seat) continue;
        this.postTo(m.ws, JSON.stringify({ type: 'PHRASE', side: ref.seat, lang: msg.lang, index: msg.index }));
      }
      return;
    }
    if (msg.type === 'RESIGN' || msg.type === 'CANCEL') { this.takeSeatOver(ref); return; }
    if (msg.type !== 'MOVE') return;
    const before = live.driver.state;
    const result = live.driver.submit(ref.seat, msg.action);
    if (!result.ok) {
      const member = live.members[ref.seat];
      if (member) this.postTo(member.ws, JSON.stringify({ type: 'REJECT', reason: result.reason }));
      return;
    }
    this.countBoard(before, live.driver.state);
    this.pushRoomEvents(live, result.events);
    if (live.driver.state.winner !== null) {
      this.finishRoom(live, live.driver.state.winner);
      this.rooms.delete(live.matchId);
    }
  }

  /**
   * The room's board came to rest: every person still holding a seat is counted, winner to the
   * seat that played it, and the rest take the loss. A seat backfilled with a bot was never in the
   * registry and claims nothing — the same rule the dock's standings already play by.
   */
  private finishRoom(live: LiveRoom, winner: number): void {
    this.completeRoom(live);
    for (let i = 0; i < live.members.length; i++) {
      const m = live.members[i];
      if (m) this.verdict(m.id, i === winner);
    }
  }

  /**
   * Hand every event to every human seat except the one that played it — that seat applied its own
   * action locally before it ever reached the wire. The machine's turns are in the same batch, so a
   * room of one person and three bots needs no second round trip to keep moving.
   */
  private pushRoomEvents(live: LiveRoom, events: readonly RoomEvent[]): void {
    if (!events.length) return;
    for (const m of live.members) {
      if (!m) continue;
      for (const ev of events) {
        if (ev.seat === m.seat) continue;
        this.postTo(m.ws, JSON.stringify({ type: 'MOVE', side: ev.seat, action: ev.action }));
      }
    }
  }

  /**
   * A seat's person left — a resignation, a CANCEL, or a socket that simply died. The seat is not
   * abandoned: the machine takes it over at the room's own tier, everyone else is told, and the race
   * carries on to a real finish instead of dissolving. Before the room launches there is no board to
   * carry on with, so the seat merely reopens for somebody else.
   */
  private takeSeatOver(ref: RoomRef): void {
    const live = ref.live;
    const member = live.members[ref.seat];
    if (member) {
      this.refs.delete(member.ws);
      try {
        member.ws.close(1000, 'left');
      } catch {
        /* the socket is already gone */
      }
      live.members[ref.seat] = null;
      /* a person who walked out of a live board counts as a loss: the machine finishes it for them */
      if (live.driver) this.verdict(member.id, false);
    }
    const driver = live.driver;
    if (!driver) { this.rearm(); return; }
    const roster = driver.room;
    driver.drop(ref.seat);
    const name = roster.seats[ref.seat]?.name ?? `Seat ${ref.seat}`;
    for (const m of live.members) {
      if (m) this.postTo(m.ws, JSON.stringify({ type: 'SEAT_BOT', side: ref.seat, name }));
    }
    const before = driver.state;
    this.pushRoomEvents(live, driver.runBots());
    this.countBoard(before, driver.state);
    if (driver.state.winner !== null) {
      this.completeRoom(live);
      this.rooms.delete(live.matchId);
    }
  }

  /** A socket went away. In a room that means the machine finishes the seat; in the queue, goodbye. */
  private roomLeave(ref: RoomRef | undefined): void {
    if (!ref) return;
    const member = ref.live.members[ref.seat];
    if (member) this.markActive(member.id);
    if (ref.live.driver) { this.takeSeatOver(ref); return; }
    if (member) this.refs.delete(member.ws);
    ref.live.members[ref.seat] = null;
    if (ref.live.code) {
      /* a friends lobby survives its host: the crown moves, and everyone is told */
      this.lobbyDepart(ref.live, ref.seat);
      return;
    }
    if (ref.live.members.every((m) => m === null)) {
      this.openRooms = this.openRooms.filter((r) => r !== ref.live);
    }
    this.rearm();
  }

  /** Send to a socket that may already be gone; a dead one is not this call's problem. */
  private postTo(ws: WebSocket, payload: string): void {
    try {
      ws.send(payload);
    } catch {
      /* the socket is already gone: its own close handler will settle the seat */
    }
  }

  /* ---------- the race ---------- */

  /** A frame from a player who is already racing: judged by the room, then handed to the rival. */
  private relay(seat: Waiter, msg: ClientMessage): void {
    const race = seat.race;
    if (!race || race.over) return;

    this.markActive(seat.id);
    if (msg.type === 'RESIGN') {
      this.endRace(race, seat.side, 'RESIGN');
      return;
    }
    if (msg.type === 'EMOTE') {
      /* An emote is chat, not a turn: relayed the moment it arrives, whatever the board is doing. */
      this.deliver(race.seats[seat.side === 0 ? 1 : 0],
        JSON.stringify({ type: 'EMOTE', side: seat.side, emote: msg.emote }));
      return;
    }
    if (msg.type === 'PHRASE') {
      /* A phrase is chat too: the rival looks the pair back up in the closed table on their side. */
      this.deliver(race.seats[seat.side === 0 ? 1 : 0],
        JSON.stringify({ type: 'PHRASE', side: seat.side, lang: msg.lang, index: msg.index }));
      return;
    }
    if (msg.type !== 'MOVE') return;                     // queue traffic on a paired socket: ignored
    if (race.state.winner !== null) return;
    if (race.state.turn !== seat.side) {
      this.refuse(seat, 'not_your_turn');
      return;
    }

    const before = race.state;
    let next: GameState | null = null;
    try {
      next = apply(before, msg.action);
    } catch {
      next = null;                                       // a frame shaped to throw is a frame refused
    }
    if (!next) {
      this.refuse(seat, 'illegal_action');
      return;
    }

    race.state = next;
    this.countBoard(before, next);
    this.deliver(race.seats[seat.side === 0 ? 1 : 0], JSON.stringify({ type: 'MOVE', side: seat.side, action: msg.action }));
    /* The board is decided: both clients can see the winner for themselves, so the room just
       stops being a race rather than guessing what the loser's screen does next. */
    if (next.winner !== null) this.settle(race, next.winner);
  }

  private refuse(seat: Waiter, reason: string): void {
    this.deliver(seat, JSON.stringify({ type: 'REJECT', reason }));
  }

  /** Forfeit: a resignation, or a socket that died mid-race. The seat opposite takes the win. */
  private endRace(race: Race, leaver: 0 | 1, why: 'RESIGN' | 'LEFT'): void {
    if (race.over) return;
    this.settle(race, leaver === 0 ? 1 : 0);
    const other = race.seats[leaver === 0 ? 1 : 0];
    this.deliver(other, JSON.stringify(why === 'RESIGN'
      ? { type: 'RESIGN', side: leaver }
      : { type: 'OPPONENT_LEFT', side: leaver }));
  }

  /**
   * The race is done: stop routing frames through it, forget the room, and write the verdict into
   * the directory. The room is the one authority that saw every move, so the win/loss counts are
   * recorded here — a client can claim anything, but only the board it played decides.
   */
  private settle(race: Race, winner: number | null = null): void {
    if (race.over) return;
    race.over = true;
    this.races.delete(race.matchId);
    /* An abort has no winner and is not a completed match; every other settle is. */
    if (winner !== null) this.bumpMetrics({ matchesCompleted: 1 });
    for (const seat of race.seats) {
      if (seat.race === race) seat.race = null;
      this.verdict(seat.id, winner === null ? null : seat.side === winner);
    }
  }
}
