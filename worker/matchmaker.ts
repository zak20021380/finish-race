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
 *
 * A friends lobby is also durable. Its roster, crown, format and spent codes are written to
 * `room_state`, because the object that minted a code and the object that serves the friend who
 * taps its link may not be the same instance: an eviction between the two must rehydrate the
 * room, not answer "no room with this code". Codes are canonical everywhere — `1909`, `#1909` and
 * `room_1909` are one room — and a code is only ever refused when it was genuinely spent.
 */
import {
  CONFIG, MAX_BALLS, MAX_TEAMS, apply, contendersIn, dimsFor, newGame, steps, type Action, type GameState,
} from '../src/rules';
import {
  FORMAT_CAPACITY, FORMAT_MODE, ROOM_IDLE_TTL_MS, ROOM_SEAT_HOLD_MS, ROOM_WAIT_MS, assignTeam,
  backfill, createRoom, createRoomDriver, defaultTeam, difficultyFor, formatOfMode, isAutomated,
  isLobbyFormat, launch, reflowRoom, seatHuman, sizesOf, takeover, unseat,
  type BotTier, type LobbyFormat, type Room, type RoomDriver, type RoomEvent,
} from '../src/room';
import {
  authenticate, authRequestFrom, identifyAdminRequest, identifyPlayerRequest, initDataOf, isLocalhost, isMetricsMark,
  isSuperAdmin, METRICS_HEADER, verifiedTelegramUserId,
  type AdminIdentity, type AdminRole, type Identity, type MindTier, type PlayerAuth,
} from './auth';
import { json, reasonOf } from './http';
import {
  checkChannelMembership, defaultForceJoinChannel, forceJoinChannelUrl, forceJoinView,
  normalizeForceJoinChannel, readForceJoinConfig, type ForceJoinConfig,
} from './forceJoin';
import {
  MATCH_MODES, durationSeconds, matchModeFilterOf, matchModeOf, playerCountOf,
  type MatchMode, type MatchModeFilter, type PlayerCount,
} from '../shared/telemetry';
import {
  VIP_PLAN_IDS, VIP_STARS_MAX, VIP_STARS_MIN, extendVipUntil, readVipPlanConfig,
  vipMatchesPlanFilter, vipPlanFilterOf, vipPlanOf,
  vipPlanSettingsOf, type VipPlanConfig, type VipPlanId, type VipPurchase, type VipRevenueSummary,
  type VipTierRevenue,
} from '../shared/vip';
import {
  ACTIVE_CUP_ID, applicantFromRequest, cupField, cupPlayerBoard, cupSquadIds,
  isSquadAdmin, normalizeChatHandle, readRegisteredSquad, removeSquadMember, roleOf,
  SQUAD_ALREADY_ENLISTED, squadViewOf, squadWarTiq, telegramPhotoUrl, upsertSquadMember,
  verifyAndBuildSquad, verifySquadChat,
  type RegisteredSquad, type SquadAnnouncementRow, type SquadVerification,
} from './squads';
import { botAppLink, squadAppLink } from '../shared/config';
import { REFERRAL_CONFIG, arenaRankOf, utcDayKey, utcMonthKey } from '../shared/referralConfig';
import { referralBinding } from './referrals';
import { NATION_TOP_SAMPLE, representativeAverage } from '../shared/nations';
import { relicShelter } from '../shared/relic';
import {
  isPostChatFreeReaction, isPostChatPreset, postChatPresetForText, type PostChatPresetId,
} from '../src/data/postchat';
import countryRegistry from '../src/data/countries.json';
import type { Env } from './env';

/* ---------- protocol ---------- */

/** The telemetry door is token-authenticated, so a wildcard origin is enough for a split host. */
const TELEMETRY_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-telegram-init-data, x-detour-dev-player',
  'access-control-max-age': '86400',
};

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
  /* The result capsule's banter. Two shapes reach this wire and only one of them carries text:
     `preset` names one of the closed quick-chat lines (`src/data/postchat.ts`) and is relayed as
     that ID, while `text` is the VIP custom line — checked against the seat's signed entitlement
     in `relayPostChat`, so a free seat cannot type its way past the gate. */
  | { type: 'POST_MATCH_CHAT'; text?: string; preset?: string }
  | { type: 'RESIGN' }
  /* The room path: the host starting early, the host's format pick (1v1 / 3P / 4P / 2v2), and a
     seat's team move — any seat may move itself, the host may move anyone. Everything else a room
     seat sends is a MOVE or a RESIGN. */
  | { type: 'ROOM_START' }
  /* The seat is already in another board: the room still holds it, but nobody counts it down and
     nobody launches into it until it says otherwise. Persisted on the member, echoed in `LOBBY`. */
  | { type: 'BUSY'; busy: boolean }
  | { type: 'SET_FORMAT'; format: LobbyFormat }
  | { type: 'SET_MODE'; mode: 'ffa' | 'team' }
  | { type: 'SET_TEAM'; side: number; team: 0 | 1 }
  /* Keepalive: a lobby seat that is still there says so, and the room answers `PONG`. The reply is
     also what lets a client notice a half-open socket before the browser does. */
  | { type: 'PING' }
  /* Walking out for good. Distinct from `CANCEL` on purpose: a lobby's socket closing is a
     host who stepped into Telegram, while `LEAVE` is a host who is done — it disbands the code
     (so a stale link is refused cleanly) instead of leaving it to the idle TTL. */
  | { type: 'LEAVE' }
  /* A live friend-room seat asks the room to re-send its authoritative board. Sent after a
     reconnect, after a relayed move arrived on the wrong turn, and after any refusal that could
     have left the two replicas apart. */
  | { type: 'SYNC_REQ' }
  /* ---- relic duels: the in-game challenge lane (no Telegram share, no lobby) ---- */
  | { type: 'RELIC_CHALLENGE_SEND'; targetUserId: string; relicId: string; relicSerial: number }
  | { type: 'RELIC_CHALLENGE_ACCEPT'; challengeId: string }
  | { type: 'RELIC_CHALLENGE_DECLINE'; challengeId: string };

/* ---------- relic duels ---------- */

/** The honors a relic duel may be thrown over, with the same caps the ledger mints against. */
const RELIC_CAPS: Readonly<Record<string, number>> = {
  churchill_bastion: 100,
  einstein_singularity: 50,
  heisenberg_formula: 25,
};
/** How long the challenged seat has to answer, measured by the same clock the modal paints. */
const RELIC_CHALLENGE_TTL_MS = 25_000;
/** How long a spent challenge stays in the mailbox so a later boot can still explain it. */
const RELIC_CHALLENGE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const RELIC_CHALLENGE_MAX = 200;
const RELIC_CHALLENGES_KEY = 'relic_challenges';

type RelicChallengeStatus = 'pending' | 'accepted' | 'declined' | 'expired';

interface RelicChallenge {
  id: string;
  challengerId: string;
  challengerName: string;
  challengerAvatar: string;
  challengerTiq: number;
  targetUserId: string;
  relicId: string;
  relicSerial: number;
  expiresAt: number;
  roomId: string;
  status: RelicChallengeStatus;
  createdAt: number;
}

/** One seat id, bounded to the alphabet the registry mints (`tg-…`, `guest-…`, `you`). */
const readSeatId = (raw: unknown): string =>
  typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : '';

const readRelicId = (raw: unknown): string =>
  typeof raw === 'string' && Object.prototype.hasOwnProperty.call(RELIC_CAPS, raw) ? raw : '';

/** A stored challenge, folded field by field; a corrupt row is dropped rather than trusted. */
function readRelicChallenge(raw: unknown): RelicChallenge | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<RelicChallenge>;
  const id = readSeatId(r.id);
  const challengerId = readSeatId(r.challengerId);
  const targetUserId = readSeatId(r.targetUserId);
  const relicId = readRelicId(r.relicId);
  const relicSerial = Number(r.relicSerial);
  const expiresAt = Number(r.expiresAt);
  const createdAt = Number(r.createdAt);
  const roomId = readSeatId(r.roomId);
  const status = r.status;
  if (!id || !challengerId || !targetUserId || !relicId || !roomId) return null;
  if (!Number.isInteger(relicSerial) || relicSerial < 1) return null;
  if (!Number.isFinite(expiresAt) || !Number.isFinite(createdAt)) return null;
  if (status !== 'pending' && status !== 'accepted' && status !== 'declined' && status !== 'expired') return null;
  return {
    id,
    challengerId,
    challengerName: typeof r.challengerName === 'string' ? r.challengerName.slice(0, 40) : 'Player',
    challengerAvatar: typeof r.challengerAvatar === 'string' ? r.challengerAvatar.slice(0, 512) : '',
    challengerTiq: Number.isFinite(Number(r.challengerTiq)) ? Math.max(0, Math.floor(Number(r.challengerTiq))) : 0,
    targetUserId,
    relicId,
    relicSerial,
    expiresAt,
    roomId,
    status,
    createdAt,
  };
}

interface Waiter {
  ws: WebSocket;
  id: string;
  name: string;
  tiq: number;
  tier: MindTier;
  flag: string;
  /** The signed `user.photo_url` this seat arrived with, or `''`. Relayed to a relic challenger. */
  avatar: string;
  /** The player asked for a wider net after a quiet queue. */
  wide: boolean;
  /** When they entered the queue: the order, and who takes side 0. */
  joinedAt: number;
  /** The board they are queuing for: both seats must be playing the same game. */
  sizes: [number, number];
  /** The queue they entered from: `arena` when the cup's PLAY MATCH key opened it. */
  mode: 'pvp' | 'arena';
  /**
   * The VIP entitlement this seat arrived with, decided by `authenticate` from the signed payload.
   * The post-match lane reads it to decide whether a custom line may cross this wire at all.
   */
  premium: boolean;
  /** End of a purchased VIP term in ms, or 0. Relayed so a rival's board can wear the gold aura. */
  vipUntil: number;
  /** Set the moment they are paired: the race this socket now carries. */
  race: Race | null;
  side: 0 | 1;
}

/** A live 1v1: the two sockets, and the authoritative board they are playing. */
interface Race {
  matchId: string;
  seed: number;
  sizes: [number, number];
  /** How this pairing is counted: a cup race when either seat entered from the Arena. */
  mode: 'pvp' | 'arena';
  /**
   * Where the pairing came from. Only `queue` is random matchmaking; a `relic` duel is a challenge
   * one player threw at another, so the Stars Vault treats it like the custom lobby it is.
   */
  origin: 'queue' | 'relic';
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
  /** The signed `user.photo_url` this seat arrived with, or `''`. Relayed to the other seats. */
  avatar: string;
  /** The VIP entitlement behind this seat, decided by `authenticate` from the signed payload. */
  premium: boolean;
  /**
   * False while the socket is gone but the seat is still held for its player. A code lobby keeps
   * the seat warm for the idle TTL (the host) or the shorter hold (a guest), so the app resuming
   * after a chat switch lands back on the same chair instead of finding somebody else in it.
   */
  connected: boolean;
  /** When the socket dropped, or 0 while it is up. The hold clock reads this. */
  droppedAt: number;
  /**
   * True while this person is playing another board. The room keeps the chair, but a countdown
   * waits: launching somebody into a second race is how a stable seat becomes an abandoned one.
   */
  busy: boolean;
  /**
   * When this seat last answered a heartbeat, or 0 if its client never sent one. A socket can die
   * without a close frame (a killed webview, a dropped mobile link); a seat that stops answering
   * `PING` for a few beats is away, and the room says so instead of painting a phantom card.
   */
  lastPingAt: number;
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
  /**
   * When the seat that is up must act, on the server's wall clock; 0 when the machine is playing
   * or the race is settled. The alarm reads it, so a stalled or disconnected human can never
   * freeze the board — the room plays a fallback move once the limit plus its network grace
   * has passed.
   */
  turnDeadlineMs: number;
  /** The seat wearing the crown. A code lobby migrates it when the host walks out. */
  hostSeat: number;
  /** The host's format pick: 1v1 / 3P / 4P / 2v2. `size`, `mode` and `teams` all follow it. */
  format: LobbyFormat;
  /** The format's race shape: everyone for themselves, or two teams. */
  mode: 'ffa' | 'team';
  /** Seat → team (0 blue, 1 red). Only read while `mode` is `team`. */
  teams: number[];
  /** True for a code-based friends lobby; false for the `?room=<n>` auto-pair room. */
  code: boolean;
  /** When a socket last held this lobby: the idle TTL is measured from here, not from `openedAt`. */
  lastSeenAt: number;
  /**
   * True when a guest opened the room before its host did: the crown's seat is held for whoever
   * arrives with `host=1`, and nobody else may sit in it. Cleared the moment the host lands.
   */
  hostPending: boolean;
}

/** Where a socket sits: which room, and which seat in it. */
interface RoomRef { live: LiveRoom; seat: number }

/**
 * One friends-lobby seat as the room is written to storage: who it belongs to and whether they
 * were still at their socket when the snapshot was taken. The socket itself is never stored — a
 * rehydrated seat is always `connected: false` until its player opens the app again.
 */
interface StoredMember {
  seat: number;
  id: string;
  name: string;
  tiq: number;
  tier: MindTier;
  flag: string;
  avatar: string;
  /** The VIP entitlement this seat held: persisted so a rehydrated room keeps its gold bubbles. */
  premium: boolean;
  busy: boolean;
  droppedAt: number;
}

/** A code lobby's durable shape: the roster, the crown, the format, and both idle clocks. */
interface StoredLobby {
  code: string;
  size: number;
  format: LobbyFormat;
  teams: number[];
  hostSeat: number;
  hostPending: boolean;
  openedAt: number;
  waitMs: number;
  botTier: BotTier;
  lastSeenAt: number;
  members: StoredMember[];
}

/** Everything a revived object needs to put its friends lobbies back exactly as they were. */
interface StoredLobbyState {
  rooms: StoredLobby[];
  /** The tombstones: a spent code must still read as spent after an eviction. */
  retired: Array<[string, number]>;
}

/** The storage key the lobby state survives an eviction under. */
const ROOM_STATE_KEY = 'room_state';

/** The admin's live storefront, and the Stars receipts the revenue tab audits. */
const VIP_CONFIG_KEY = 'vip-config';
const VIP_SALES_KEY = 'vip-sales';
/** The mandatory channel gate's durable row: the switch and the channel it points at. */
const FORCE_JOIN_KEY = 'force-join.v1';
/** How many receipts the ledger keeps; the audit table reads the newest fifteen. */
const VIP_RECENT_MAX = 60;
const VIP_RECENT_REPORT = 15;

/** The canonical map key for a code lobby: `room_1909`, never `1909` and never `#1909`. */
const lobbyKey = (code: string): string => canonicalRoomId(code);

/**
 * The stand-in socket a rehydrated seat wears. Such a seat is always `connected: false`, so no
 * frame is ever sent to it for real — but every cleanup path (broadcast, eviction, disband) can
 * still walk a `LiveRoom` without a null check.
 */
const parkedSocket = (): WebSocket => ({
  send(): void { /* nobody is at the other end */ },
  close(): void { /* nothing to close */ },
} as unknown as WebSocket);

/** What a room's status row reports, on top of what a 1v1 room reports. */
export interface RoomSummary { players: number; bots: number }

/** The format a fixed-size auto-pair room reports. It never grows a selector; its size is the shape. */
const formatForSize = (size: number): LobbyFormat => (size === 2 ? 'duel' : size === 3 ? '3p' : '4p');

/** The ordinary radius, and the number the room starts on. */
const TIER_RADIUS = 250;
/** The widened radius, once either side has asked for one. */
const WIDE_RADIUS = 600;

/**
 * A spent room code is remembered this long. Long enough that the friend who taps yesterday's
 * link gets "already used or expired" rather than a fresh empty room under a dead code; short
 * enough that the four-digit space does not fill with tombstones.
 */
const RETIRED_TTL_MS = 30 * 60 * 1000;

/**
 * How long one room waits before pinging the same absent player again. A guest tapping in and out
 * of the webview must not turn one lobby into a stream of Telegram messages.
 */
const NOTIFY_COOLDOWN_MS = 30_000;
/**
 * How long a seat may go without answering a heartbeat before the room calls it away. Only a
 * client that has spoken at least one `PING` is judged by this clock — a build that predates the
 * heartbeat is never mistaken for a dead one.
 */
const SEAT_SILENCE_MS = 70_000;
/**
 * A live friend-room seat whose socket drops is held this long before the machine finishes it.
 * Long enough for a phone that slept, a carrier hand-off or a brief tunnel; short enough that the
 * surviving rival is never left staring at a frozen board. Inside the window the returning
 * player gets their exact seat, their board and their turn back.
 */
const RECONNECT_GRACE_MS = 25_000;
/** The server's own turn allowance, plus the network slack a move's last hop may need. */
const TURN_LIMIT_MS = CONFIG.TURN_TIME_LIMIT * 1000;
const TURN_GRACE_MS = 1_500;
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
  /** The match-type slice this reading was folded for. */
  mode: MatchModeFilter;
  /** Boards that reached a winner since this counter was introduced, every type included. */
  matchesCompleted: number;
  /** Matches that settled in the rolling last 24 hours, filtered by `mode`. */
  matches24h: number;
  /** Matches inside the rolling 24 hours, one count per match type. */
  matchesByMode24h: Record<MatchMode, number>;
  /** Matches inside the rolling 24 hours, one count per seat count. */
  matchesByPlayers24h: Record<'2' | '3' | '4', number>;
  /** Distinct players active inside the requested slice in the rolling last 24 hours. */
  active24h: number;
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
  /** The same hourly buckets, cut by the match type that was played. */
  matchesByModeHour: Record<MatchMode, Record<string, number>>;
  /** The same hourly buckets again, cut by how many seats the board fielded. */
  matchesByPlayersHour: Record<'2' | '3' | '4', Record<string, number>>;
}

/** The two tags every completed match carries into the bucket counters. */
interface MatchTag {
  mode: MatchMode;
  players: PlayerCount;
}

const GAME_METRICS_KEY = 'game-metrics.v1';
/** The width of one match bucket, and how many hours of buckets stay in storage. */
const HOUR_MS = 3_600_000;
const MATCH_BUCKET_KEEP_HOURS = 8 * 24;

const zeroGameMetrics = (): GameMetrics => ({
  matchesCompleted: 0,
  minesPlaced: 0,
  matchesByHour: {},
  matchesByModeHour: { bot: {}, pvp: {}, arena: {} },
  matchesByPlayersHour: { '2': {}, '3': {}, '4': {} },
});

/* ---------- the Nations Cup ledger ---------- */

/** The default ladder award for a win: 120 for the win plus the 20 the race itself banks. */
const NATION_WIN_TIQ = 140;
/**
 * A settled match count is the proof a seat races. Below it a seat is enrolled but not yet
 * proven — its current TIQ still carries the flag, it is simply not preferred over a proven
 * sample. There is no hard drop and no penalty multiplier: a country is never deleted for
 * being young, and a lone warrior is never halved for being alone.
 */
const NATION_MIN_MATCHES = 3;
/** A rolling 30-day competitive window — one full arena season plus the rollover's grace. */
const NATION_ACTIVE_MS = 30 * 86400_000;

/**
 * One season's national war chest, persisted under `nations_s<season>_scores`. Points are only
 * ever written by `creditNation` when the authoritative board settles with a winner, so the
 * standings can never contain a seeded, simulated or client-supplied figure. `byPlayer` keeps
 * each seat's own share, which is what the "your nation" strip quotes back to them.
 */
interface NationLedger {
  seasonNo: number;
  /** ISO alpha-2 → points banked by that nation's players this season. */
  points: Record<string, number>;
  /** Seat id → the points it earned, broken down by the nation it earned them for. */
  byPlayer: Record<string, Record<string, number>>;
}

const nationLedgerKey = (seasonNo: number): string => `nations_s${seasonNo}_scores`;

const emptyNationLedger = (seasonNo: number): NationLedger => ({ seasonNo, points: {}, byPlayer: {} });

/** The same ISO registry the picker renders, so the wire carries the display name too. */
const COUNTRY_NAME = new Map(
  (countryRegistry as Array<{ code: string; name: string }>).map((c) => [c.code, c.name]),
);
const countryName = (code: string): string => COUNTRY_NAME.get(code) ?? code;

/** Names and case carry no meaning in a country: fold both before any lookup. */
const foldCountryName = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

/** Reverse registry index: every display name, folded, back to its ISO alpha-2 code. */
const COUNTRY_BY_NAME = new Map(
  (countryRegistry as Array<{ code: string; name: string }>).map((c) => [foldCountryName(c.name), c.code]),
);

/** Spellings the ISO dataset does not publish under `name`, so a hand-typed nation still resolves. */
const COUNTRY_NAME_ALIASES: Record<string, string> = {
  turkey: 'TR',
  burma: 'MM',
  holland: 'NL',
  'czech republic': 'CZ',
  'cape verde': 'CV',
  'east timor': 'TL',
  'republic of korea': 'KR',
  'korea, south': 'KR',
  'republic of moldova': 'MD',
  'syrian arab republic': 'SY',
  'viet nam': 'VN',
  'russian federation': 'RU',
  'united states of america': 'US',
  usa: 'US',
  uk: 'GB',
  'great britain': 'GB',
  uae: 'AE',
  macedonia: 'MK',
  swaziland: 'SZ',
  'ivory coast': 'CI',
  congo: 'CG',
};

/** Regional indicators ("🇮🇷") → the code they spell, for a flag that arrives as a glyph. */
function codeFromFlagGlyph(raw: string): string {
  const marks = [...raw];
  if (marks.length !== 2) return '';
  let out = '';
  for (const mark of marks) {
    const offset = mark.codePointAt(0) ?? 0;
    if (offset < 0x1f1e6 || offset > 0x1f1ff) return '';
    out += String.fromCharCode(65 + (offset - 0x1f1e6));
  }
  return out;
}

/**
 * The one country normaliser the ledger and every board read pass through. A seat's nation is
 * stored as two letters, so an identity that arrives as a code in either case, a flag glyph or a
 * full name has to be resolved before the standings are cut — anything unrecognised is '' and the
 * player is left off the board rather than folded into a neighbour on a lucky prefix.
 */
export function normalizeCountry(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (!value) return '';
  if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  const glyph = codeFromFlagGlyph(value);
  if (glyph) return glyph;
  const folded = foldCountryName(value);
  const code = COUNTRY_NAME_ALIASES[folded] ?? COUNTRY_BY_NAME.get(folded) ?? '';
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

/** A stored ledger is clamped field by field; a different season never lends its points forward. */
function readNationLedger(raw: unknown, seasonNo: number): NationLedger {
  const r = raw as Partial<NationLedger> | null | undefined;
  if (!r || whole(r.seasonNo) !== seasonNo) return emptyNationLedger(seasonNo);
  const points: Record<string, number> = {};
  if (r.points && typeof r.points === 'object' && !Array.isArray(r.points)) {
    for (const [code, value] of Object.entries(r.points)) {
      const cc = code.toUpperCase();
      const pts = whole(value);
      if (/^[A-Z]{2}$/.test(cc) && pts > 0) points[cc] = pts;
    }
  }
  const byPlayer: Record<string, Record<string, number>> = {};
  if (r.byPlayer && typeof r.byPlayer === 'object' && !Array.isArray(r.byPlayer)) {
    for (const [id, perNation] of Object.entries(r.byPlayer)) {
      if (!id || !perNation || typeof perNation !== 'object' || Array.isArray(perNation)) continue;
      const shares: Record<string, number> = {};
      for (const [code, value] of Object.entries(perNation)) {
        const cc = code.toUpperCase();
        const pts = whole(value);
        if (/^[A-Z]{2}$/.test(cc) && pts > 0) shares[cc] = pts;
      }
      if (Object.keys(shares).length) byPlayer[id] = shares;
    }
  }
  return { seasonNo, points, byPlayer };
}

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
  const byMode = (mode: MatchMode): Record<string, number> =>
    readMatchHours(r?.matchesByModeHour?.[mode]);
  const byPlayers = (key: '2' | '3' | '4'): Record<string, number> =>
    readMatchHours(r?.matchesByPlayersHour?.[key]);
  return {
    matchesCompleted: whole(r?.matchesCompleted),
    minesPlaced: whole(r?.minesPlaced),
    matchesByHour: readMatchHours(r?.matchesByHour),
    matchesByModeHour: {
      bot: byMode('bot'),
      pvp: byMode('pvp'),
      arena: byMode('arena'),
    },
    matchesByPlayersHour: {
      '2': byPlayers('2'),
      '3': byPlayers('3'),
      '4': byPlayers('4'),
    },
  };
}

/* ---------- the growth ring buffers: bounded time-series telemetry ---------- */

/**
 * One time-series bucket as three whole counts: `[signups, active, matches]`. A tuple keeps the
 * stored blob near half the size a keyed object would, which is what lets the whole series live
 * inside a couple of hundred bytes.
 */
type GrowthBucket = [number, number, number];

/** One match-type bucket as two counts: `[active, matches]`. Signups are never mode-specific. */
type ModeGrowthBucket = [number, number];

/**
 * The room's entire plotted history: 24 hourly rows plus 30 daily rows for the aggregate, and the
 * same window again for each of the three match types. Every ring is pruned on write, so the blob
 * is bounded by construction — it cannot grow with the playerbase, however many years the object
 * lives.
 */
interface GrowthSeries {
  /** Keyed by UTC hour index (`Math.floor(ms / HOUR_MS)`); at most `HOURLY_KEEP` rows. */
  hourly: Record<string, GrowthBucket>;
  /** Keyed by UTC calendar day (`YYYY-MM-DD`); at most `DAILY_KEEP` rows. */
  daily: Record<string, GrowthBucket>;
  /** The same two windows, one ring per match type. */
  modes: Record<MatchMode, ModeGrowthSeries>;
}

interface ModeGrowthSeries {
  hourly: Record<string, ModeGrowthBucket>;
  daily: Record<string, ModeGrowthBucket>;
}

const GROWTH_KEY = 'growth-series.v1';
const DAY_MS = 86_400_000;
/** The ring widths: one day of hours, one month of days. Anything older is dropped on write. */
const HOURLY_KEEP = 24;
const DAILY_KEEP = 30;

const zeroModeGrowth = (): ModeGrowthSeries => ({ hourly: {}, daily: {} });

const zeroGrowth = (): GrowthSeries => ({
  hourly: {},
  daily: {},
  modes: { bot: zeroModeGrowth(), pvp: zeroModeGrowth(), arena: zeroModeGrowth() },
});

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

/** A stored match-type bucket: `[active, matches]`, clamped the same way. */
function readModeBucket(raw: unknown): ModeGrowthBucket | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  return [whole(raw[0]), whole(raw[1])];
}

/**
 * Drop every row outside `[oldest, newest]`, then cap the map at `keep` rows by evicting the
 * oldest. The window check is what prunes in normal operation; the cap is the backstop that stops
 * a hand-edited or clock-skewed blob from ever outgrowing the ring.
 */
function trimRing<T>(
  map: Record<string, T>,
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
  const readMode = (source: unknown): ModeGrowthSeries => {
    const s = source as Partial<ModeGrowthSeries> | null | undefined;
    const rows = (value: unknown): Record<string, ModeGrowthBucket> => {
      const out: Record<string, ModeGrowthBucket> = {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
      for (const [key, stored] of Object.entries(value as Record<string, unknown>)) {
        const bucket = readModeBucket(stored);
        if (bucket && (bucket[0] || bucket[1])) out[key.slice(0, 12)] = bucket;
      }
      return out;
    };
    return { hourly: rows(s?.hourly), daily: rows(s?.daily) };
  };
  const modes = (r?.modes ?? {}) as Partial<Record<MatchMode, unknown>>;
  const growth: GrowthSeries = {
    hourly: read(r?.hourly),
    daily: read(r?.daily),
    modes: {
      bot: readMode(modes.bot),
      pvp: readMode(modes.pvp),
      arena: readMode(modes.arena),
    },
  };
  pruneGrowth(growth, now);
  return growth;
}

/** Every ring trimmed against one clock reading, so a load and a write prune identically. */
function pruneGrowth(growth: GrowthSeries, now: number): void {
  const hour = Math.floor(now / HOUR_MS);
  const day = dayIndexOf(now);
  const oldestHour = hour - HOURLY_KEEP + 1;
  const oldestDay = day - DAILY_KEEP + 1;
  trimRing(growth.hourly, Number, oldestHour, hour, HOURLY_KEEP);
  trimRing(growth.daily, dayKeyIndex, oldestDay, day, DAILY_KEEP);
  for (const mode of MATCH_MODES) {
    const ring = growth.modes[mode];
    trimRing(ring.hourly, Number, oldestHour, hour, HOURLY_KEEP);
    trimRing(ring.daily, dayKeyIndex, oldestDay, day, DAILY_KEEP);
  }
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
  /** The signed `user.photo_url` the seat authenticated with, or ''. */
  avatar: string;
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
  /** End of the purchased VIP term in ms, or 0. Written only by a verified Stars receipt. */
  vipUntil: number;
  /** The plan id behind the current term, for the store's status copy. */
  vipPlan: string;
  /** Telegram charge ids already applied, so a webhook retry cannot grant a second term. */
  vipCharges: string[];
  banned: boolean;
  muted: boolean;
  /** True while the player holds a seat on a live board or sits in a room that is filling. */
  inMatch: boolean;
  /** Seasonal honors the Command Center pushed, newest last (at most six). */
  awards?: SeasonAward[];
  /**
   * When this seat was last counted active in each match type, in ms. The per-type trend needs its
   * own dedupe clock: playing a bot race and a PvP race in the same hour is two active slices, but
   * one read of `lastSeen`.
   */
  modeSeen: Record<MatchMode, number>;
}

/** The directory views the Users tab's filter chips select. */
export type PlayerFilter = 'all' | 'active' | 'tiq' | 'flagged' | 'stars';

const FILTERS: readonly PlayerFilter[] = ['all', 'active', 'tiq', 'flagged', 'stars'];

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
export type PlayerSort = 'default' | 'lastPlayed' | 'joined' | 'tiq' | 'stars' | 'stars_asc';

const SORTS: readonly PlayerSort[] = ['default', 'lastPlayed', 'joined', 'tiq', 'stars', 'stars_asc'];

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

/** The numeric id a bot can message, or `''` for a guest/anon seat — never just the digits of a name. */
const chatIdOf = (id: string): string => {
  const match = /^tg-([0-9]{1,20})$/.exec(id);
  return match ? match[1] : '';
};

const zeroModeSeen = (): Record<MatchMode, number> => ({ bot: 0, pvp: 0, arena: 0 });

/** A seat's first registry entry. */
function freshPlayer(identity: Identity, now: number): PlayerRecord {
  return {
    id: identity.player.id,
    tgId: tgIdOf(identity.player.id),
    name: identity.player.name.slice(0, 40),
    username: identity.player.username.slice(0, 40),
    country: normalizeCountry(identity.flag),
    avatar: identity.player.avatar,
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
    vipUntil: 0,
    vipPlan: '',
    vipCharges: [],
    banned: false,
    muted: false,
    inMatch: false,
    awards: [],
    modeSeen: zeroModeSeen(),
  };
}

/** A stored photo is decoration: only an absolute https URL may reach another player's `<img>`. */
function storedAvatar(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const url = raw.slice(0, 512).trim();
  return /^https:\/\/[^\s]+$/i.test(url) ? url : '';
}

/** A hydrated record folded field by field: a hand-edited blob is clamped, never trusted. */
function readPlayer(raw: unknown): PlayerRecord | null {
  const r = raw as Partial<PlayerRecord> | null | undefined;
  if (!r || typeof r.id !== 'string' || !r.id) return null;
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
  const seen = (r.modeSeen && typeof r.modeSeen === 'object' ? r.modeSeen : {}) as Partial<Record<MatchMode, unknown>>;
  return {
    id: r.id.slice(0, 64),
    tgId: text(r.tgId, 20).replace(/[^0-9-]/g, ''),
    name: text(r.name, 40) || 'Player',
    username: text(r.username, 40),
    country: normalizeCountry(r.country),
    avatar: storedAvatar(r.avatar),
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
    vipUntil: whole(r.vipUntil),
    vipPlan: text(r.vipPlan, 12),
    vipCharges: Array.isArray(r.vipCharges)
      ? r.vipCharges.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(-20)
      : [],
    banned: r.banned === true,
    muted: r.muted === true,
    /* a fresh instance has no live boards: nothing can be mid-match across an eviction */
    inMatch: false,
    awards: readAwards(r.awards),
    modeSeen: {
      bot: whole(seen.bot),
      pvp: whole(seen.pvp),
      arena: whole(seen.arena),
    },
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/* ---------- the VIP revenue ledger ---------- */

interface VipSalesLedger {
  totalPurchases: number;
  totalStars: number;
  tiers: Record<VipPlanId, VipTierRevenue>;
  /** Newest first, bounded: the audit table never asks the store for an unbounded row set. */
  recent: VipPurchase[];
}

function emptyVipTiers(): Record<VipPlanId, VipTierRevenue> {
  return {
    '7d': { count: 0, starsGrossed: 0 },
    '30d': { count: 0, starsGrossed: 0 },
    '90d': { count: 0, starsGrossed: 0 },
  };
}

function emptyVipSales(): VipSalesLedger {
  return { totalPurchases: 0, totalStars: 0, tiers: emptyVipTiers(), recent: [] };
}

/** A stored ledger folded field by field: counters are whole numbers, never a trusted blob. */
function readVipSales(raw: unknown): VipSalesLedger {
  const ledger = emptyVipSales();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ledger;
  const source = raw as Record<string, unknown>;
  ledger.totalPurchases = whole(source.totalPurchases);
  ledger.totalStars = whole(source.totalStars);
  const tiers = source.tiers && typeof source.tiers === 'object'
    ? source.tiers as Record<string, unknown>
    : {};
  for (const id of VIP_PLAN_IDS) {
    const row = tiers[id] as Record<string, unknown> | null | undefined;
    if (!row || typeof row !== 'object') continue;
    ledger.tiers[id] = { count: whole(row.count), starsGrossed: whole(row.starsGrossed) };
  }
  const recent = Array.isArray(source.recent) ? source.recent : [];
  for (const rawRow of recent) {
    const row = rawRow as Partial<VipPurchase> | null;
    if (!row || typeof row !== 'object') continue;
    const plan = vipPlanOf(row.planId);
    const userId = typeof row.userId === 'string' ? row.userId.slice(0, 64) : '';
    const stars = whole(row.stars);
    if (!plan || !userId || stars <= 0) continue;
    ledger.recent.push({
      userId,
      username: typeof row.username === 'string' ? row.username.slice(0, 40) : '',
      planId: plan.id,
      stars,
      purchasedAt: whole(row.purchasedAt),
      expiresAt: whole(row.expiresAt),
    });
    if (ledger.recent.length >= VIP_RECENT_MAX) break;
  }
  return ledger;
}

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

/** One query value, read so no socket ever dies on a malformed URL: missing reads as `''`. */
function queryValue(url: URL, name: string): string {
  try {
    return url.searchParams.get(name) ?? '';
  } catch {
    return '';
  }
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

/**
 * The one canonical room id, whatever spelling arrived: `1909`, `#1909`, `room_1909`, `ROOM-1909`
 * or an invite payload with junk after the digits all resolve to `room_1909`. Every route and every
 * map key goes through here, so a deep link can never address a different room than the one the
 * host minted.
 */
function canonicalRoomId(raw: string | null): string {
  const digits = (raw ?? '').replace(/\D/g, '').slice(0, 4);
  return digits.length === 4 ? `room_${digits}` : '';
}

/** `roomcode=9786` from the query: the four digits of a friends lobby, or `''`. */
function readRoomCode(raw: string | null): string {
  const id = canonicalRoomId(raw);
  return id ? id.slice('room_'.length) : '';
}

/**
 * A deep-link payload that names a room. Only the room grammar is honoured here — `ref_...`,
 * `team-...` and every other start parameter belong to their own feature and must never be read
 * as somebody's lobby.
 */
function readInviteRoomCode(raw: string | null): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  if (/^#?\s*\d{4}$/.test(value)) return readRoomCode(value);
  if (/^room[\s_-]*\d{4}(?:\D|$)/i.test(value)) return readRoomCode(value);
  return '';
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

/** The result capsule's line: the same 40-character ceiling the composer enforces. */
const POST_CHAT_MAX = 40;
/** How long two settled seats may still trade taunts after the board is done. */
const POST_CHAT_TTL_MS = 90_000;

/** Clamp a post-match line to printable, single-spaced text the composer's own limit allows. */
function readPostChatText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (!clean) return null;
  return Array.from(clean).slice(0, POST_CHAT_MAX).join('');
}

function readMessage(raw: unknown, side: number, cols: number, rows: number): ClientMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const msg = JSON.parse(raw) as {
      type?: unknown; wide?: unknown; action?: unknown; mode?: unknown; side?: unknown; team?: unknown;
      format?: unknown; emote?: unknown; lang?: unknown; index?: unknown; busy?: unknown; text?: unknown;
      preset?: unknown; targetUserId?: unknown; relicId?: unknown; relicSerial?: unknown; challengeId?: unknown;
    };
    if (msg.type === 'QUEUE') return { type: 'QUEUE', wide: msg.wide === true };
    if (msg.type === 'WIDEN') return { type: 'WIDEN' };
    if (msg.type === 'CANCEL') return { type: 'CANCEL' };
    if (msg.type === 'LEAVE') return { type: 'LEAVE' };
    if (msg.type === 'SYNC_REQ') return { type: 'SYNC_REQ' };
    if (msg.type === 'RESIGN') return { type: 'RESIGN' };
    if (msg.type === 'PING') return { type: 'PING' };
    /* `START_MATCH` is the crisp name the lobby screen sends; `ROOM_START` is the older spelling
       every shipped client still uses. They are the same tap and reach the same gate. */
    if (msg.type === 'ROOM_START' || msg.type === 'START_MATCH') return { type: 'ROOM_START' };
    if (msg.type === 'BUSY') return { type: 'BUSY', busy: msg.busy === true };
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
    if (msg.type === 'POST_MATCH_CHAT') {
      /* Both shapes are read here and judged later: `preset` against the closed table, `text`
         against the seat's entitlement. Neither is trusted by this parser. */
      const preset = isPostChatPreset(msg.preset) ? msg.preset : undefined;
      const text = readPostChatText(msg.text) ?? undefined;
      return preset || text ? { type: 'POST_MATCH_CHAT', preset, text } : null;
    }
    if (msg.type === 'RELIC_CHALLENGE_SEND') {
      const targetUserId = readSeatId(msg.targetUserId);
      const relicId = readRelicId(msg.relicId);
      const relicSerial = Number(msg.relicSerial);
      if (!targetUserId || !relicId) return null;
      if (!Number.isInteger(relicSerial) || relicSerial < 1 || relicSerial > 999) return null;
      return { type: 'RELIC_CHALLENGE_SEND', targetUserId, relicId, relicSerial };
    }
    if (msg.type === 'RELIC_CHALLENGE_ACCEPT' || msg.type === 'RELIC_CHALLENGE_DECLINE') {
      const challengeId = readSeatId(msg.challengeId);
      if (!challengeId) return null;
      return { type: msg.type, challengeId };
    }
  } catch {
    /* not ours: a malformed frame is dropped, never fatal */
  }
  return null;
}

/** `MATCH_FOUND` as the client reads it: the seat, the shared race, and who is opposite. */
function foundMessage(
  matchId: string, seed: number, side: 0 | 1, me: Waiter, opponent: Waiter,
  sizes: [number, number], mode: 'pvp' | 'arena',
): string {
  return JSON.stringify({
    type: 'MATCH_FOUND',
    matchId,
    seed,
    side,
    sizes,
    mode,
    /* The caller's own entitlement and the rival's, both judged by the room before it paired. */
    isVip: me.premium,
    vipUntil: me.vipUntil,
    opponent: {
      name: opponent.name,
      tiq: opponent.tiq,
      tier: opponent.tier,
      flag: opponent.flag,
      avatar: opponent.avatar,
      vip: opponent.premium,
      vipUntil: opponent.vipUntil,
    },
  });
}

/** `DUEL_START` carries the same seat payload a queued pair receives, plus the room id. */
function duelStartMessage(
  roomId: string, seed: number, side: 0 | 1, me: Waiter, opponent: Waiter, sizes: [number, number],
): string {
  return JSON.stringify({
    type: 'DUEL_START',
    roomId,
    matchId: roomId,
    seed,
    side,
    sizes,
    mode: 'pvp',
    isVip: me.premium,
    vipUntil: me.vipUntil,
    opponent: {
      name: opponent.name,
      tiq: opponent.tiq,
      tier: opponent.tier,
      flag: opponent.flag,
      avatar: opponent.avatar,
      vip: opponent.premium,
      vipUntil: opponent.vipUntil,
    },
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

/**
 * The one global squad registry. Every enlistment appends here and every admin read folds it,
 * inside the singleton `MATCHMAKER` object (`LOBBY = 'global'` in `worker/index.ts`), so the
 * enlistment worker and the Command Center can never split across storage namespaces.
 */
const SQUADS_KEY = 'squads';

/** The one state an admin filters on: the three audit states, with a purge collapsed into `banned`. */
export type SquadStatus = SquadVerification | 'banned';

/** One registered squad, as the Command Center's Squads tab audits it. */
export interface SquadWarRow {
  id: string;
  chatId: string;
  handle: string;
  name: string;
  kind: 'channel' | 'group';
  avatar: string;
  tag: string;
  /** Joined mini-app players — the roster's length, never the Telegram audience. */
  members: number;
  /** The Telegram chat's own audience, shown beside the roster as an external stat. */
  subscribers: number;
  /** The enlisting player: the squad's leader. */
  creatorId: string;
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
  /** TIQ the joined players contribute to this squad's war effort. */
  warTiq: number;
  /** How many players are on the roster (the same number as `members`). */
  contributors: number;
  /* The canonical registry shape, so an admin client never has to know the storage's legacy
     field names. Each one is the single source of truth above, under its registry name. */
  title: string;
  type: 'channel' | 'group';
  /** When the squad was enlisted (the registry's `createdAt`). */
  enlistedAt: number;
  /** Who enlisted it: the owner's @username when resolved, else their Telegram id. */
  enlistedBy: string;
  membersCount: number;
  /** War TIQ (`warTiq`, under the registry's name). */
  tiq: number;
  status: SquadStatus;
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

/* ---------- the Stars Vault: the two-stage invite programme ----------
 *
 * The ledger next door (`worker/referrals.ts`) owns the permanent 1-to-1 link and the coin credit
 * the join gate pays. This owns the *Stars* campaign that link feeds: what an invited friend has
 * actually played, which of the two stages that unlocks, and the balance their inviter may ask to
 * be paid out.
 *
 * Every number here is written by the room from a board it refereed. The client sends no counters,
 * no stage flags and no balances — it asks for a view and paints it. A stage, once credited, is
 * never taken back: a friend who later loses or quits has already earned their inviter's Stars.
 *
 * State lives under its own key, never on `PlayerRecord`: the directory is a 2000-row LRU and a
 * balance must not be evicted with a stale socket.
 */
const STARS_VAULT_KEY = 'stars-vault.v1';
/** Distinct UTC days and distinct opponents a friend row remembers. Stage 1 asks for 3 and 2. */
const VAULT_RING = 48;
/** Rows the vault keeps before it sheds the oldest fully-paid friend. */
const VAULT_FRIENDS_MAX = 4000;
const VAULT_PAYOUTS_MAX = 600;
/** Friends the Profile card lists; the rest are still counted, just not painted. */
const VAULT_FRIENDS_SHOWN = 25;

/** One invited friend, and the server's own reading of what they have played. */
interface VaultFriend {
  id: string;
  inviterId: string;
  name: string;
  avatar: string;
  /** Valid matches: >= 25s, random matchmaking, every seat a person. */
  matches: number;
  /** Distinct UTC days those matches landed on, newest last. */
  days: string[];
  /** The subset of `matches` that were two-person duels. */
  pvpMatches: number;
  /** Distinct human opponents across those duels. */
  opponents: string[];
  /** Random-matchmaking duels this friend WON. */
  pvpWins: number;
  /** The Arena realm their standing has reached. */
  arena: number;
  /** Matches where every opponent was the inviter or a fellow invitee. */
  clusterMatches: number;
  stage1: boolean;
  stage2: boolean;
  /** Held for an admin: the cluster ratio says these two are playing each other, not the game. */
  flagged: boolean;
  /** An admin reviewed the ring and cleared it: the ratio stops re-flagging this friend. */
  cleared: boolean;
  /** Stars released into the inviter's vault. */
  creditedStars: number;
  /** Stars earned but held for next month's pool. */
  queuedStars: number;
  /** The month this friend first counted against the inviter's cap, or ''. */
  creditMonth: string;
  updatedAt: number;
}

/** One inviter's vault. `earnedStars` only ever climbs; `paidOutStars` is what the owner settled. */
interface VaultAccount {
  id: string;
  name: string;
  starterBonus: number;
  earnedStars: number;
  paidOutStars: number;
  queuedStars: number;
  monthKey: string;
  monthQualified: number;
  updatedAt: number;
}

/** A manual payout request. The app never transfers anything; the owner marks it paid. */
interface VaultPayout {
  requestId: string;
  playerId: string;
  playerName: string;
  amount: number;
  createdAt: number;
  status: 'waiting' | 'paid' | 'rejected';
  decidedAt: number;
}

interface VaultState {
  accounts: VaultAccount[];
  friends: VaultFriend[];
  payouts: VaultPayout[];
  budget: { monthKey: string; spent: number };
}

/** One friend as the Profile card paints them: two pills and a total out of 5. */
export interface VaultFriendView {
  id: string;
  name: string;
  avatar: string;
  matches: number;
  days: number;
  pvpMatches: number;
  opponents: number;
  pvpWins: number;
  arena: number;
  stage1: boolean;
  stage2: boolean;
  flagged: boolean;
  credited: number;
  queued: number;
}

/** The whole card, server-side. Nothing in here is a client claim. */
export interface VaultView {
  ok: true;
  starterBonus: number;
  earnedStars: number;
  paidOutStars: number;
  vaultBalance: number;
  pendingFriendsCount: number;
  qualifiedFriendsCount: number;
  threshold: number;
  canPayout: boolean;
  /** A request is already with the owner: the balance it locked is not spendable twice. */
  waiting: boolean;
  queuedStars: number;
  budgetLeft: number;
  monthKey: string;
  friends: VaultFriendView[];
}

/** A flagged friend as the Command Center's review list paints them. */
export interface VaultFlagView {
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

export interface VaultAdminView {
  ok: true;
  totals: {
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
  };
  requests: VaultPayout[];
  flagged: VaultFlagView[];
}

const VAULT_EMPTY: VaultState = { accounts: [], friends: [], payouts: [], budget: { monthKey: '', spent: 0 } };

const vaultText = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** The vault is token-authenticated, so a wildcard origin is enough for a split host. */
const VAULT_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-telegram-init-data, x-detour-dev-player, x-detour-device',
  'access-control-max-age': '86400',
};

/** A ring of distinct keys, newest last, bounded so one row can never grow without limit. */
function ringPush(ring: string[], key: string): void {
  if (!key || ring.includes(key)) return;
  ring.push(key);
  if (ring.length > VAULT_RING) ring.splice(0, ring.length - VAULT_RING);
}

function readVaultFriend(raw: unknown): VaultFriend | null {
  const r = raw as Partial<VaultFriend> | null;
  if (!r || typeof r.id !== 'string' || !r.id || typeof r.inviterId !== 'string' || !r.inviterId) return null;
  if (r.id === r.inviterId) return null;
  const strings = (value: unknown): string[] => (Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && !!v).slice(-VAULT_RING)
    : []);
  return {
    id: r.id.slice(0, 64),
    inviterId: r.inviterId.slice(0, 64),
    name: vaultText(r.name, 48),
    avatar: vaultText(r.avatar, 300),
    matches: whole(r.matches),
    days: strings(r.days),
    pvpMatches: whole(r.pvpMatches),
    opponents: strings(r.opponents),
    pvpWins: whole(r.pvpWins),
    arena: Math.min(4, whole(r.arena)),
    clusterMatches: whole(r.clusterMatches),
    stage1: r.stage1 === true,
    stage2: r.stage2 === true,
    flagged: r.flagged === true,
    cleared: r.cleared === true,
    creditedStars: whole(r.creditedStars),
    queuedStars: whole(r.queuedStars),
    creditMonth: typeof r.creditMonth === 'string' ? r.creditMonth.slice(0, 7) : '',
    updatedAt: whole(r.updatedAt),
  };
}

function readVaultAccount(raw: unknown): VaultAccount | null {
  const r = raw as Partial<VaultAccount> | null;
  if (!r || typeof r.id !== 'string' || !r.id) return null;
  return {
    id: r.id.slice(0, 64),
    name: vaultText(r.name, 48),
    /* The gift is a campaign constant, not credit the player earned: a ledger written under an
       older gift follows the config on the next read, so every vault shows the same opening fill. */
    starterBonus: REFERRAL_CONFIG.STARTER_VAULT_GIFT_STARS,
    earnedStars: whole(r.earnedStars),
    paidOutStars: whole(r.paidOutStars),
    queuedStars: whole(r.queuedStars),
    monthKey: typeof r.monthKey === 'string' ? r.monthKey.slice(0, 7) : '',
    monthQualified: whole(r.monthQualified),
    updatedAt: whole(r.updatedAt),
  };
}

function readVaultPayout(raw: unknown): VaultPayout | null {
  const r = raw as Partial<VaultPayout> | null;
  if (!r || typeof r.requestId !== 'string' || !r.requestId) return null;
  if (typeof r.playerId !== 'string' || !r.playerId) return null;
  const amount = whole(r.amount);
  if (amount <= 0) return null;
  return {
    requestId: r.requestId.slice(0, 40),
    playerId: r.playerId.slice(0, 64),
    playerName: vaultText(r.playerName, 48),
    amount,
    createdAt: whole(r.createdAt),
    status: r.status === 'paid' ? 'paid' : r.status === 'rejected' ? 'rejected' : 'waiting',
    decidedAt: whole(r.decidedAt),
  };
}

function readVaultState(raw: unknown): VaultState {
  const r = raw as Partial<VaultState> | null;
  if (!r) return { ...VAULT_EMPTY, budget: { monthKey: '', spent: 0 } };
  const accounts: VaultAccount[] = [];
  const friends: VaultFriend[] = [];
  const payouts: VaultPayout[] = [];
  if (Array.isArray(r.accounts)) for (const row of r.accounts) {
    const acc = readVaultAccount(row);
    if (acc) accounts.push(acc);
  }
  if (Array.isArray(r.friends)) for (const row of r.friends) {
    const friend = readVaultFriend(row);
    if (friend) friends.push(friend);
  }
  if (Array.isArray(r.payouts)) for (const row of r.payouts) {
    const pay = readVaultPayout(row);
    if (pay) payouts.push(pay);
  }
  const budget = r.budget;
  return {
    accounts,
    friends,
    payouts,
    budget: {
      monthKey: typeof budget?.monthKey === 'string' ? budget.monthKey.slice(0, 7) : '',
      spent: whole(budget?.spent),
    },
  };
}

/* ---------- the Durable Object ---------- */

export class MatchmakerDO {
  private queue: Waiter[] = [];
  /**
   * The ambient relic-duel sockets, one per player: they never enter the pairing queue, but they
   * are the address a rival's challenge is pushed to and the socket a direct duel is played on.
   */
  private sessions = new Map<string, Waiter>();
  /** The live socket behind each pending challenge, so an accept can reach its challenger. */
  private challengeSeats = new Map<string, Waiter>();
  /** Every live and recently spent relic challenge, keyed by its id. */
  private relicChallenges = new Map<string, RelicChallenge>();
  /** A mailbox write is already scheduled: many challenge changes, one flush. */
  private relicDirty = false;
  /* ---- the Stars Vault: balances, friend progress and the manual payout queue ---- */
  private vaultAccounts = new Map<string, VaultAccount>();
  private vaultFriends = new Map<string, VaultFriend>();
  private vaultPayouts = new Map<string, VaultPayout>();
  private vaultBudget = { monthKey: '', spent: 0 };
  private vaultDirty = false;
  /** playerId -> the inviter they arrived behind ('' = nobody). Resolved once per isolate. */
  private vaultInviters = new Map<string, string>();
  /** Pairings this object has announced: it keeps repeat pairings from reusing an id. */
  private paired = 0;
  /** Every race still being played, by match id. */
  private races = new Map<string, Race>();
  /** Rooms still filling their seats. They leave this list the moment they launch. */
  private openRooms: LiveRoom[] = [];
  /** Code-based friends lobbies, by their 4-digit code. A code lobby is never auto-paired. */
  private lobbies = new Map<string, LiveRoom>();
  /**
   * Codes that are spent, and when they were spent. A code leaves the market the moment its match
   * launches, its host disbands it, or its room idles out — and a link that still carries it must
   * be refused with a reason the client can say out loud, never quietly minted again.
   */
  private retired = new Map<string, number>();
  /** Rooms that have launched, by match id. */
  private rooms = new Map<string, LiveRoom>();
  /** Which room seat a socket is holding. A socket in here is not a queue entry. */
  private refs = new Map<WebSocket, RoomRef>();
  /**
   * The post-match banter lane: a socket whose board has settled, plus the seats still reading
   * their result capsules. It lives outside `races` because a settled race is forgotten the moment
   * it produces a verdict, yet the capsules stay open and still expect to talk. A duel has one
   * peer; a 3- or 4-seat party has every other human. Entries expire on their own, and a leaver
   * removes itself from every remaining lane and tells each peer `OPPONENT_LEFT`.
   */
  private postChat = new Map<WebSocket, {
    peers: WebSocket[]; side: number; at: number; lastAt: number;
    /** The sender's seat id, so entitlement is re-read live when a line is relayed. */
    id: string;
    /** The sender's verified VIP entitlement at connect time; the live record may have moved. */
    premium: boolean;
  }>();
  /** `room:chatId` → the last time that room pinged that player. The push cooldown's ledger. */
  private notified = new Map<string, number>();
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
  /** Handles with an enlistment in flight. Two taps cannot both pass the duplicate gate. */
  private enlisting = new Set<string>();
  /** Durable board counters, seeded from storage and written back as they move. */
  private gameMetrics: GameMetrics = zeroGameMetrics();
  /** The admin's live plan sheet: prices and which tiers the storefront offers. */
  private vipConfig: VipPlanConfig = readVipPlanConfig(null);
  /** The mandatory channel gate: off until an operator arms it. */
  private forceJoin: ForceJoinConfig;
  /** Lifetime VIP sales, folded into the Command Center's revenue tab. */
  private vipSales: VipSalesLedger = emptyVipSales();
  /** The current season's banked nation points, credited only by settled wins. */
  private nations: NationLedger = emptyNationLedger(0);
  /** The bounded growth rings behind the Stats tab's trend chart. */
  private growth: GrowthSeries = zeroGrowth();
  /** The last UTC day the rings formatted a key for, and the key itself. */
  private memoDayIndex = -1;
  private memoDayKey = '';
  /** A counter write is already scheduled: many moves, one flush. */
  private metricsDirty = false;

  constructor(private state: DurableObjectState, private env: Env) {
    /* Safe before the store answers: a disabled gate on the deployment's required channel. */
    this.forceJoin = { forceJoinEnabled: false, targetChannel: defaultForceJoinChannel(env) };
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
          const squads = await storage.get<unknown[]>(SQUADS_KEY);
          if (Array.isArray(squads)) {
            for (const raw of squads) {
              const row = readRegisteredSquad(raw);
              if (row) this.squads.set(row.id, row);
            }
          }
          const arena = readArena(await storage.get<unknown>('arena'));
          if (arena) this.arena = arena;
          this.nations = readNationLedger(
            await storage.get<unknown>(nationLedgerKey(this.arena.seasonNo)),
            this.arena.seasonNo,
          );
          this.gameMetrics = readGameMetrics(await storage.get<unknown>(GAME_METRICS_KEY));
          this.growth = readGrowthSeries(await storage.get<unknown>(GROWTH_KEY));
          this.vipConfig = readVipPlanConfig(await storage.get<unknown>(VIP_CONFIG_KEY));
          this.vipSales = readVipSales(await storage.get<unknown>(VIP_SALES_KEY));
          this.forceJoin = readForceJoinConfig(
            await storage.get<unknown>(FORCE_JOIN_KEY),
            defaultForceJoinChannel(this.env),
          );
          /* The friends lobbies are durable: an eviction between "host creates a room" and "guest
             taps the link" must not turn a valid code into "no room with this code". */
          this.restoreLobbies(await storage.get<unknown>(ROOM_STATE_KEY));
          const storedChallenges = await storage.get<unknown>(RELIC_CHALLENGES_KEY);
          if (Array.isArray(storedChallenges)) {
            const now = Date.now();
            for (const raw of storedChallenges) {
              const row = readRelicChallenge(raw);
              if (!row) continue;
              if (row.status === 'pending' && row.expiresAt <= now) row.status = 'expired';
              if (now - row.createdAt <= RELIC_CHALLENGE_KEEP_MS) this.relicChallenges.set(row.id, row);
            }
          }
          /* The Stars Vault keeps its own key, and its own try: a corrupt balance must never stop
             the role registry or the alarm from arming below. */
          try {
            const vault = readVaultState(await storage.get<unknown>(STARS_VAULT_KEY));
            for (const acc of vault.accounts) this.vaultAccounts.set(acc.id, acc);
            for (const friend of vault.friends) this.vaultFriends.set(friend.id, friend);
            for (const pay of vault.payouts) this.vaultPayouts.set(pay.requestId, pay);
            this.vaultBudget = vault.budget;
          } catch { /* a vault that refuses the read starts empty */ }
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
    /* The edge's own entitlement calls. Only this class can reach a Durable Object stub, and the
       worker entry never forwards these two paths from the public router, so they have no outside
       door: `/api/vip/me` is keyed by a header the edge sets after verifying initData, and the
       grant is minted only by a Telegram receipt the bot webhook validated. */
    if (url.pathname === '/api/vip/me' && request.method === 'GET') return this.vipMe(request);
    if (url.pathname === '/api/vip/grant' && request.method === 'POST') return this.vipGrant(request);
    /* The edge's storefront reads this path to price invoices and paint `/api/vip/plans`.
       The worker entry never forwards it, so the config has no outside door. */
    if (url.pathname === '/internal/vip/config' && request.method === 'GET') {
      return json({ ok: true, config: this.vipConfig }, 200, { 'cache-control': 'no-store' });
    }
    /* The edge reads the gate's durable row before it settles a referral. Like the VIP config,
       the public router never forwards `/internal/*`, so there is no outside door. */
    if (url.pathname === '/internal/force-join' && request.method === 'GET') {
      return json({ ok: true, config: this.forceJoin }, 200, { 'cache-control': 'no-store' });
    }
    /* The player's own gate reading: the signed initData (or the marked dev door) names the
       caller; a query-string id may never speak for somebody else. */
    if (url.pathname === '/api/user/check-subscription') {
      return this.checkSubscription(request, url);
    }
    /* Match and heartbeat telemetry from a player's own device. It is the only way a bot race the
       server never saw can reach the growth rings; the player door is proven inside. */
    if (url.pathname === '/api/client/telemetry/heartbeat' || url.pathname === '/api/client/telemetry/match') {
      try {
        return await this.telemetry(request, url);
      } catch (err) {
        return json({ ok: false, error: 'telemetry_failed', hint: reasonOf(err) }, 500, TELEMETRY_CORS);
      }
    }
    if (url.pathname === '/api/squads/verify') return this.verifySquad(request, url);
    if (url.pathname === '/api/squads/register') return this.registerSquad(request, url);
    /* Squad membership: the roster is written only here, and only by the player it names. */
    if (url.pathname === '/api/squads/join' || url.pathname === '/api/squads/sync') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return this.squadJoinOrSync(request, url, url.pathname === '/api/squads/join');
    }
    if (url.pathname === '/api/squads/leave') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return this.squadLeave(request, url);
    }
    if (url.pathname === '/api/squads/kick') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return this.squadKick(request, url);
    }
    /* Leader administration: the join-approval lock, the pending queue and squad announcements.
       The edge only routes these — the room proves the caller is this squad's leader first. */
    if (url.pathname === '/api/squads/request') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return this.squadRequestJoin(request, url);
    }
    if (url.pathname === '/api/squads/admin/requests') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return this.squadAdminRequests(request, url);
    }
    if (
      url.pathname === '/api/squads/admin/lock'
      || url.pathname === '/api/squads/admin/decide'
      || url.pathname === '/api/squads/admin/broadcast'
    ) {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return this.squadAdminAction(request, url);
    }
    if (url.pathname === '/api/squads/board' || url.pathname === '/api/squads/squad') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return url.pathname === '/api/squads/board' ? this.squadBoard() : this.squadRead(url);
    }
    /* The cup's own board: the registered field, and only the players it carries. */
    if (url.pathname === '/api/squads/cup') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return this.squadCupBoard(url);
    }
    /* The worker has authenticated the caller on `/admin/*` and `/api/admin/*`; the room below
       authorizes them against its registry. The one public announcement feed rides the same
       handler. None of these ever carry an upgrade. */
    if (
      url.pathname.startsWith('/admin/')
      || url.pathname.startsWith('/api/admin/')
      || url.pathname === '/api/client/announcements/active'
      || url.pathname === '/api/client/arena/state'
      || url.pathname === '/api/client/minds'
      || url.pathname === '/api/nations/leaderboard'
      || url.pathname === '/api/nations/roster'
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
    /* The Stars Vault: the Profile card's server-owned balance, and the manual payout request.
       Identity is proven from the signed initData inside, exactly like the telemetry door. */
    if (url.pathname === '/api/stars/vault' || url.pathname === '/api/stars/payout') {
      try {
        return url.pathname === '/api/stars/vault'
          ? await this.starsVault(request)
          : await this.starsPayout(request);
      } catch (err) {
        return json({ ok: false, error: 'vault_failed', hint: reasonOf(err) }, 500, VAULT_CORS);
      }
    }
    /* The relic-duel mailbox: a challenge filed while its target was away is read here on the
       next boot. Identity is proven from the signed initData, exactly like a socket handshake. */
    if (url.pathname === '/api/client/relic/challenges') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return this.relicMailbox(request);
    }
    /* The upgrade header is a token list in principle (`keep-alive, Upgrade`), so compare the
       tokens, never the raw header. Cloudflare only hands us a WebSocket when it is present. */
    const upgrade = (request.headers.get('Upgrade') ?? '').toLowerCase();
    if (!upgrade.split(',').some((token) => token.trim() === 'websocket')) {
      return json({ error: 'expected_upgrade', hint: 'GET /ws/matchmake with Upgrade: websocket' }, 426);
    }

    const identity = await authenticate(authRequestFrom(url), this.env);
    if (!identity) return json({ error: 'unauthorized', hint: 'valid Telegram initData required' }, 401);
    /* A Stars receipt is durable, a socket is not: every fresh seat re-reads the term the room
       already wrote, so a reload after checkout keeps its crown without another round trip. */
    this.hydrateVip(identity);
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
       is never in the pairing queue, so a 4-seat room can never be broken up into a duel. Every
       value below defaults on its own, so an empty `flag=`/`squad=` or a partial `sizes=` can
       never take the handshake down; the try/catch is the last line of defence for anything the
       parsers did not anticipate. */
    try {
      /* Every spelling of an invite is the same room: `roomcode=1909`, `?room=#1909`,
         `?startapp=room_1909` and a shared `room_1909` payload all read as 1909. `room=` stays a
         seat count when it is one (2-4); a four-digit `room=` is an invite, not a size. */
      const roomSize = readRoomSize(queryValue(url, 'room'));
      const roomCode = readRoomCode(queryValue(url, 'roomcode'))
        || readInviteRoomCode(queryValue(url, 'startapp'))
        || readInviteRoomCode(queryValue(url, 'start_param'))
        || readInviteRoomCode(queryValue(url, 'code'))
        || (roomSize ? '' : readRoomCode(queryValue(url, 'room')));
      if (roomCode) {
        /* the friends lobby: a code the host minted, not a search for strangers */
        this.joinLobby(server, identity, roomCode, queryValue(url, 'host') === '1',
          readBotTier(queryValue(url, 'bottier')));
      } else if (roomSize) {
        this.joinRoom(server, identity, roomSize, readBotTier(queryValue(url, 'bottier')));
      } else if (queryValue(url, 'session') === '1') {
        /* The ambient duel channel: a seated identity with no queue entry. It receives pushed
           challenges, and an accepted one turns this same socket into the live race. */
        const waiter = this.enter(server, identity, false, readSizes(queryValue(url, 'sizes')), 'pvp', false);
        this.attach(waiter, true);
        this.registerSession(waiter);
      } else {
        const waiter = this.enter(server, identity, queryValue(url, 'wide') === '1',
          readSizes(queryValue(url, 'sizes')), queryValue(url, 'mode') === 'arena' ? 'arena' : 'pvp');
        this.attach(waiter);
        this.pairNow();                        // the queue may already hold their match
      }
    } catch {
      /* The socket is already accepted, so an HTTP error page would reach the browser as an
         anonymous "connection failed". Answer inside the socket instead, then let it go. */
      try {
        server.send(JSON.stringify({ type: 'ERROR', reason: 'SERVER_ERROR' }));
        server.close(1011, 'setup_failed');
      } catch {
        /* the socket is already gone */
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The wait timer. A room that has run out of patience fills its seats and starts. */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.expireRelicChallenges(now);
    for (const live of [...this.openRooms]) {
      if (!live.driver && now - live.room.openedAt >= live.room.waitMs) this.launchRoom(live);
    }
    /* The friends lobbies' own clocks: a dropped guest's chair goes back on the market, and a
       room nobody has held for ten minutes is retired so its code can be reused. */
    this.sweepLobbies(now);
    this.sweepRacedRooms(now);
    this.sweepRetired();
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

  /** Any registry row already holding this chat id or username. Case-insensitive by handle. */
  private squadConflict(chatId: string, handle: string): boolean {
    const key = handle.toLowerCase();
    for (const squad of this.squads.values()) {
      if (squad.handle.toLowerCase() === key) return true;
      if (chatId && squad.chatId === chatId) return true;
    }
    return false;
  }

  /** The signed Mini App user, or the dev door's reported id on a loopback/DEV_AUTH host. */
  private async squadRequester(request: Request, url: URL, body: Record<string, unknown>): Promise<string> {
    const initData = request.headers.get('x-telegram-init-data') ?? '';
    const verified = await verifiedTelegramUserId(initData, this.env);
    if (verified) return verified;
    const dev = this.env.DEV_AUTH === 'true' || isLocalhost(url.hostname);
    if (!dev) return '';
    return String(body.userTelegramId ?? '').replace(/[^0-9-]/g, '').slice(0, 20);
  }

  /**
   * The blur/tap preview: resolve the handle with `getChat`, prove its type against the selected
   * tab and refuse a squad the registry already holds. Nothing is written here.
   */
  private async verifySquad(request: Request, url: URL): Promise<Response> {
    const body = await readBody(request);
    const requestedKind = body.kind === 'channel' || body.kind === 'group' ? body.kind : '';
    if (!requestedKind) {
      return json({ ok: false, error: 'invalid_kind', message: 'Choose Channel or Group.' }, 400);
    }
    const requester = await this.squadRequester(request, url, body);
    if (!requester) {
      return json({ ok: false, error: 'unauthorized', message: 'Telegram verification required.' }, 401);
    }
    await this.syncSquadsFromStorage();

    const result = await verifySquadChat(
      typeof body.chatUsername === 'string' ? body.chatUsername : '',
      requestedKind,
      this.env,
    );
    if (!result.ok) {
      /* The refusal the player sees is one sentence; `wrangler tail` needs the rest. */
      console.warn(`[squad-verify] /api/squads/verify → ${result.status} ${result.code}: ${result.message}`);
      return json({
        ok: false,
        error: result.code,
        message: result.message,
        ...(result.kind ? { kind: result.kind } : {}),
      }, result.status);
    }
    if (this.squadConflict(result.chat.chatId, result.chat.handle)) {
      return json({ ok: false, error: 'already_registered', message: SQUAD_ALREADY_ENLISTED }, 409);
    }
    return json({ ok: true, chat: result.chat });
  }

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

    const requester = await this.squadRequester(request, url, body);
    if (!requester) {
      return json({
        ok: false,
        error: 'unauthorized',
        message: 'Telegram verification required.',
      }, 401);
    }
    /* The duplicate gate reads the canonical store, not a possibly partial in-memory copy. */
    await this.syncSquadsFromStorage();
    if (this.squadConflict('', handle)) {
      return json({ ok: false, error: 'already_registered', message: SQUAD_ALREADY_ENLISTED }, 409);
    }

    /* Checked and set in the same synchronous turn: a second enlistment of the same handle can
       not slip between the duplicate gate and the registry write while Telegram is answering. */
    const reservation = handle.toLowerCase();
    if (this.enlisting.has(reservation)) {
      return json({
        ok: false,
        error: 'enlist_in_progress',
        message: 'An enlistment for this squad is already in progress.',
      }, 409);
    }
    this.enlisting.add(reservation);
    try {
      const requestedKind = body.kind === 'channel' || body.kind === 'group' ? body.kind : undefined;
      const result = await verifyAndBuildSquad(rawHandle, requester, this.env, {
        name: typeof body.squadName === 'string' ? body.squadName : '',
        tag: typeof body.squadTag === 'string' ? body.squadTag : '',
        kind: requestedKind,
        /* An enlistment is filed under the cup it names; a client that names none is filing for
           the championship that is running. */
        cupId: typeof body.cupId === 'string' ? body.cupId : ACTIVE_CUP_ID,
        memberName: typeof body.memberName === 'string'
          ? body.memberName
          : typeof body.name === 'string' ? body.name : '',
        username: typeof body.username === 'string' ? body.username : '',
        photo: typeof body.photo === 'string' ? body.photo : '',
      });
      if (!result.ok) {
        return json({
          ok: false,
          error: result.code,
          message: result.message,
          ...(result.kind ? { kind: result.kind } : {}),
        }, result.status);
      }
      if (this.squadConflict(result.squad.chatId, result.squad.handle)) {
        return json({ ok: false, error: 'already_registered', message: SQUAD_ALREADY_ENLISTED }, 409);
      }

      this.squads.set(result.squad.id, result.squad);
      this.squadsDirty = true;
      await this.persistSquads();
      /* The public view, not the storage row: the client never needs the audit fields, and this
         is the shape every other squad answer uses. */
      return json({ ok: true, squad: squadViewOf(result.squad) });
    } finally {
      this.enlisting.delete(reservation);
    }
  }

  /* ---------- squad membership: the roster is the only source of members ---------- */

  /** The squad a request names, hydrated from the canonical store first. */
  private async squadNamed(id: string): Promise<RegisteredSquad | undefined> {
    await this.syncSquadsFromStorage();
    return id ? this.squads.get(id) : undefined;
  }

  /**
   * Join or refresh. A join is the only door that may add a row; a sync only ever updates one that
   * exists, so simply launching the app can never enrol a player who never tapped Join.
   *
   * A player holds one squad at a time — the client has a single bound id — so joining removes
   * them from every other roster in the same turn. That is what keeps every count honest: no
   * squad can keep counting a player who moved on.
   */
  private async squadJoinOrSync(request: Request, url: URL, join: boolean): Promise<Response> {
    const body = await readBody(request);
    const requester = await this.squadRequester(request, url, body);
    if (!requester) {
      return json({ ok: false, error: 'unauthorized', message: 'Telegram verification required.' }, 401);
    }
    const id = typeof body.squadId === 'string' ? body.squadId.trim().slice(0, 48) : '';
    const squad = await this.squadNamed(id);
    if (!squad) {
      return json({ ok: false, error: 'no_such_squad', message: 'That squad is no longer enlisted.' }, 404);
    }
    if (squad.banned) {
      return json({ ok: false, error: 'squad_banned', message: 'This squad was removed from the competition.' }, 403);
    }
    /* The leader's lock is enforced here too, not only in the client: a join that slipped past
       an older app version still becomes a request, never a roster row. The applicant keeps
       their current squad until the leader actually approves them. */
    if (join && squad.requireApproval && !squad.roster.some((m) => m.id === requester)) {
      this.squadQueueRequest(squad, requester, body);
      await this.persistSquads();
      return json({ ok: true, joined: false, pending: true, role: '', squad: squadViewOf(squad) });
    }

    if (join) {
      for (const other of this.squads.values()) {
        if (other.id === squad.id) continue;
        if (removeSquadMember(other, requester)) this.squadsDirty = true;
      }
    }

    const added = upsertSquadMember(squad, {
      id: requester,
      name: typeof body.name === 'string' ? body.name : '',
      tiq: typeof body.tiq === 'number' ? body.tiq : Number(body.tiq),
      country: typeof body.country === 'string' ? body.country : '',
      username: typeof body.username === 'string' ? body.username : '',
      photo: typeof body.photo === 'string' ? body.photo : '',
    }, join);
    const role = roleOf(squad, requester);
    if (!added && !role) {
      return json({
        ok: false,
        error: 'not_a_member',
        message: 'Join this squad before syncing your score.',
      }, 409);
    }
    this.squadsDirty = true;
    await this.persistSquads();
    return json({ ok: true, joined: added, role, squad: squadViewOf(squad) });
  }

  /**
   * Leave a squad.
   *
   * A member simply drops off the roster. A leader cannot leave a squad that still has players —
   * there would be nobody to run it — so the crown passes to the longest-serving remaining member
   * in the same turn; a leader who is the last player disbands the squad, and the row leaves the
   * registry rather than lingering as an empty shell.
   */
  private async squadLeave(request: Request, url: URL): Promise<Response> {
    const body = await readBody(request);
    const requester = await this.squadRequester(request, url, body);
    if (!requester) {
      return json({ ok: false, error: 'unauthorized', message: 'Telegram verification required.' }, 401);
    }
    const id = typeof body.squadId === 'string' ? body.squadId.trim().slice(0, 48) : '';
    const squad = await this.squadNamed(id);
    if (!squad) return json({ ok: false, error: 'no_such_squad' }, 404);

    if (squad.creatorId === requester) {
      const others = squad.roster.filter((m) => m.id !== requester);
      if (!others.length) {
        this.squads.delete(squad.id);
        this.squadsDirty = true;
        await this.persistSquads();
        return json({ ok: true, disbanded: true });
      }
      const heir = others.sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))[0];
      squad.creatorId = heir.id;
      squad.ownerId = heir.id;
      heir.role = 'leader';
    }
    if (!removeSquadMember(squad, requester)) {
      return json({ ok: false, error: 'member_not_found', message: 'You are not on this squad.' }, 404);
    }
    this.squadsDirty = true;
    await this.persistSquads();
    return json({ ok: true, squad: squadViewOf(squad) });
  }

  /** Remove another player. Leader (or a promoted officer) only; never the leader themself. */
  private async squadKick(request: Request, url: URL): Promise<Response> {
    const body = await readBody(request);
    const requester = await this.squadRequester(request, url, body);
    if (!requester) {
      return json({ ok: false, error: 'unauthorized', message: 'Telegram verification required.' }, 401);
    }
    const id = typeof body.squadId === 'string' ? body.squadId.trim().slice(0, 48) : '';
    const squad = await this.squadNamed(id);
    if (!squad) return json({ ok: false, error: 'no_such_squad' }, 404);
    if (!isSquadAdmin(squad, requester)) {
      return json({ ok: false, error: 'not_admin', message: 'Only the squad leader can remove members.' }, 403);
    }
    const target = typeof body.memberId === 'string' ? body.memberId.trim().slice(0, 24) : '';
    if (!target) return json({ ok: false, error: 'invalid_member', message: 'Choose a member to remove.' }, 400);
    if (target === requester) {
      return json({ ok: false, error: 'cannot_kick_self', message: 'You cannot remove yourself.' }, 409);
    }
    if (target === squad.creatorId) {
      return json({ ok: false, error: 'cannot_kick_leader', message: 'The squad leader cannot be removed.' }, 409);
    }
    if (!removeSquadMember(squad, target)) {
      return json({ ok: false, error: 'member_not_found', message: 'That player is not on this squad.' }, 404);
    }
    this.squadsDirty = true;
    await this.persistSquads();
    return json({ ok: true, squad: squadViewOf(squad) });
  }

  /* ---------- leader administration: the lock, the queue and squad announcements ---------- */

  /** File one join request. Idempotent by player id; a roster member never becomes an applicant. */
  private squadQueueRequest(
    squad: RegisteredSquad,
    requester: string,
    body: Record<string, unknown>,
  ): void {
    if (squad.pending.some((a) => a.id === requester)) return;
    const applicant = applicantFromRequest({
      id: requester,
      name: typeof body.name === 'string' ? body.name : '',
      tiq: typeof body.tiq === 'number' ? body.tiq : Number(body.tiq),
      country: typeof body.country === 'string' ? body.country : '',
      username: typeof body.username === 'string' ? body.username : '',
      photo: typeof body.photo === 'string' ? body.photo : '',
    });
    squad.pending = [applicant, ...squad.pending].slice(0, 60);
    this.squadsDirty = true;
  }

  /** `POST /api/squads/request` — the cross-device twin of the client's local queue. */
  private async squadRequestJoin(request: Request, url: URL): Promise<Response> {
    const body = await readBody(request);
    const requester = await this.squadRequester(request, url, body);
    if (!requester) {
      return json({ ok: false, error: 'unauthorized', message: 'Telegram verification required.' }, 401);
    }
    const id = typeof body.squadId === 'string' ? body.squadId.trim().slice(0, 48) : '';
    const squad = await this.squadNamed(id);
    if (!squad) return json({ ok: false, error: 'no_such_squad' }, 404);
    if (squad.banned) return json({ ok: false, error: 'squad_banned' }, 403);
    if (squad.roster.some((m) => m.id === requester)) {
      return json({ ok: true, joined: true, squad: squadViewOf(squad) });
    }
    this.squadQueueRequest(squad, requester, body);
    await this.persistSquads();
    return json({ ok: true, pending: true, squad: squadViewOf(squad) });
  }

  /** A dev-origin read has no JSON body to carry the reported id, so the query may hold it. */
  private async squadAdminRequester(
    request: Request,
    url: URL,
    body: Record<string, unknown>,
  ): Promise<string> {
    const signed = await this.squadRequester(request, url, body);
    if (signed) return signed;
    const dev = this.env.DEV_AUTH === 'true' || isLocalhost(url.hostname);
    return dev
      ? (url.searchParams.get('userTelegramId') ?? '').replace(/[^0-9-]/g, '').slice(0, 20)
      : '';
  }

  /** Every leader action passes the same gate: signed caller, known squad, actual leader. */
  private async squadAdminGate(
    request: Request,
    url: URL,
    body: Record<string, unknown>,
  ): Promise<{ requester: string; squad: RegisteredSquad } | { response: Response }> {
    const requester = await this.squadAdminRequester(request, url, body);
    if (!requester) {
      return { response: json({ ok: false, error: 'unauthorized', message: 'Telegram verification required.' }, 401) };
    }
    const id = typeof body.squadId === 'string'
      ? body.squadId.trim().slice(0, 48)
      : (url.searchParams.get('squadId') ?? '').trim().slice(0, 48);
    const squad = await this.squadNamed(id);
    if (!squad) return { response: json({ ok: false, error: 'no_such_squad' }, 404) };
    if (!isSquadAdmin(squad, requester)) {
      return { response: json({ ok: false, error: 'not_admin', message: 'Only the squad leader can manage this squad.' }, 403) };
    }
    return { requester, squad };
  }

  /** The leader's pending queue — never published on the board or in a public squad read. */
  private async squadAdminRequests(request: Request, url: URL): Promise<Response> {
    const gate = await this.squadAdminGate(request, url, {});
    if ('response' in gate) return gate.response;
    const requests = [...gate.squad.pending].sort((a, b) => b.requestedAt - a.requestedAt);
    return json({ ok: true, requests });
  }

  /** Lock toggle, approve/reject, or a broadcast. One authenticated door, three actions. */
  private async squadAdminAction(request: Request, url: URL): Promise<Response> {
    const body = await readBody(request);
    const gate = await this.squadAdminGate(request, url, body);
    if ('response' in gate) return gate.response;
    const { requester, squad } = gate;

    if (url.pathname === '/api/squads/admin/lock') {
      const on = body.requireApproval === true;
      squad.requireApproval = on;
      this.squadsDirty = true;
      await this.persistSquads();
      return json({ ok: true, requireApproval: on, squad: squadViewOf(squad) });
    }

    if (url.pathname === '/api/squads/admin/decide') {
      const applicantId = typeof body.applicantId === 'string' ? body.applicantId.trim().slice(0, 24) : '';
      const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : '';
      if (!applicantId || !decision) {
        return json({ ok: false, error: 'invalid_member', message: 'Choose a request and a decision.' }, 400);
      }
      const at = squad.pending.findIndex((a) => a.id === applicantId);
      if (at < 0) return json({ ok: false, error: 'member_not_found' }, 404);
      const applicant = squad.pending[at];
      squad.pending.splice(at, 1);
      if (decision === 'approve') {
        /* An approved player holds one squad at a time, exactly like a direct join. */
        for (const other of this.squads.values()) {
          if (other.id === squad.id) continue;
          if (removeSquadMember(other, applicant.id)) this.squadsDirty = true;
        }
        upsertSquadMember(squad, {
          id: applicant.id,
          name: applicant.name,
          tiq: applicant.tiq,
          country: applicant.country,
          username: applicant.username,
          photo: applicant.photo,
        }, true);
      }
      this.squadsDirty = true;
      await this.persistSquads();
      return json({ ok: true, decision, squad: squadViewOf(squad) });
    }

    const message = (typeof body.text === 'string' ? body.text : '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 280);
    if (!message) return json({ ok: false, error: 'invalid_message', message: 'Write a message first.' }, 400);
    const row: SquadAnnouncementRow = {
      id: `cast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      text: message,
      authorId: requester,
      createdAt: Date.now(),
      recipients: 0,
    };
    row.recipients = this.notifySquadMembers(squad, message);
    squad.announcements = [row, ...squad.announcements].slice(0, 20);
    this.squadsDirty = true;
    await this.persistSquads();
    return json({ ok: true, recipients: row.recipients, announcement: row, squad: squadViewOf(squad) });
  }

  /**
   * Deliver one announcement through @Tactix_Robot. Only real Telegram ids can be messaged, and
   * a Bot API hiccup is fire-and-forget: the announcement is already stored and the leader's own
   * in-app notification already landed, so a slow push never holds the response hostage.
   */
  private notifySquadMembers(squad: RegisteredSquad, message: string): number {
    const token = this.env.TELEGRAM_BOT_TOKEN?.trim() || this.env.BOT_TOKEN?.trim() || '';
    if (!token) return 0;
    const targets = squad.roster
      .filter((m) => m.id !== squad.creatorId && /^[0-9]{1,20}$/.test(m.id))
      .map((m) => m.id);
    if (!targets.length) return 0;
    const link = squadAppLink(squad.id);
    const text = `📢 ${squad.name}\n\n${message}`;
    for (const chatId of targets) {
      const call = fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          ...(link ? { reply_markup: { inline_keyboard: [[{ text: 'Open Squad', url: link }]] } } : {}),
        }),
      }).then(() => undefined).catch(() => undefined);
      const ctx = this.state as unknown as { waitUntil?: (p: Promise<unknown>) => void };
      if (ctx.waitUntil) ctx.waitUntil(call);
      else void call;
    }
    return targets.length;
  }

  /**
   * The public board: every live squad, ranked by the TIQ its joined players actually banked.
   *
   * This is what discovery reads now that the seeded field is gone. It carries no chat token and
   * no audit notes — identity, the real counts, the audience as a separate stat, and the top three
   * names so a card can show a face before it is opened.
   */
  private async squadBoard(): Promise<Response> {
    await this.syncSquadsFromStorage();
    const squads = [...this.squads.values()]
      .filter((squad) => !squad.banned && squad.verification !== 'revoked')
      .map((squad) => {
        /* The board names the community, not its Telegram chat id. */
        const { chatId: _chatId, ...view } = squadViewOf(squad);
        return view;
      })
      .sort((a, b) => b.tiq - a.tiq || b.members - a.members || a.handle.localeCompare(b.handle));
    return json({ ok: true, timestamp: Date.now(), squads });
  }

  /** One squad's live view: identity, the full roster and the derived counts. */
  private async squadRead(url: URL): Promise<Response> {
    const id = (url.searchParams.get('id') ?? '').trim().slice(0, 48);
    if (!id) return json({ ok: false, error: 'invalid_squad' }, 400);
    const squad = await this.squadNamed(id);
    if (!squad) return json({ ok: false, error: 'no_such_squad' }, 404);
    if (squad.banned) return json({ ok: false, error: 'squad_banned' }, 403);
    return json({ ok: true, squad: squadViewOf(squad) });
  }

  /**
   * The cup's own leaderboard: the registered field, and the players it carries.
   *
   * This is the server's copy of the rule the Arena paints. A squad that did not enlist for the
   * cup is not in the field; a player is only ever listed through a squad that is. The
   * `squadIds` array is published with it so a client can apply the same test to its own rows
   * instead of re-deriving who counts as a contender.
   */
  private async squadCupBoard(url: URL): Promise<Response> {
    await this.syncSquadsFromStorage();
    const asked = (url.searchParams.get('cup') ?? '').trim().slice(0, 48);
    const cupId = asked || ACTIVE_CUP_ID;
    const rawLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(rawLimit) ? clamp(Math.floor(rawLimit), 1, 100) : 10;
    const field = cupField(this.squads.values(), cupId);
    return json({
      ok: true,
      cupId,
      timestamp: Date.now(),
      squadIds: [...cupSquadIds(this.squads.values(), cupId)],
      /* The board names the community, not its Telegram chat id. */
      squads: field.map((squad) => {
        const { chatId: _chatId, ...view } = squadViewOf(squad);
        return view;
      }),
      players: cupPlayerBoard(this.squads.values(), cupId, limit),
    });
  }

  /**
   * Fold any registry rows the in-memory map is missing back in from the canonical key. The
   * constructor's hydration is allowed to fail (a store that refuses a read starts the room
   * empty), so every write and every admin read reconciles first: a later registration can then
   * never overwrite rows this isolate did not happen to hold.
   */
  private async syncSquadsFromStorage(): Promise<void> {
    const storage = this.state?.storage;
    if (!storage) return;
    try {
      const rows = await storage.get<unknown[]>(SQUADS_KEY);
      if (!Array.isArray(rows)) return;
      for (const raw of rows) {
        const row = readRegisteredSquad(raw);
        if (!row) continue;
        const held = this.squads.get(row.id);
        /* A row already in memory may be newer than the store (a join that has not flushed yet);
           keep the in-memory roster, but never resurrect a row the store does not have. */
        if (!held) this.squads.set(row.id, row);
      }
    } catch {
      /* a store that refuses the read: the rows already in memory still answer */
    }
  }

  /**
   * Flush the whole global registry under one key. The write is awaited by every caller before
   * its response leaves the room: a registration that answered `ok` must survive eviction, and
   * the admin query must never read an older list than the one the enlistment just acknowledged.
   */
  private async persistSquads(): Promise<void> {
    const storage = this.state?.storage;
    if (!storage || !this.squadsDirty) return;
    this.squadsDirty = false;
    try {
      await this.syncSquadsFromStorage();
      /* The live map is read after the merge and after every await, so two enlistments that
         overlap on storage still land in one list holding both rows. */
      await storage.put(SQUADS_KEY, [...this.squads.values()]);
    } catch {
      /* a refused write stays dirty: the next mutation retries the whole registry */
      this.squadsDirty = true;
    }
  }

  /**
   * The war contribution of each registered squad: the TIQ its joined players actually banked.
   *
   * This used to fold every player record that merely *reported* a squad handle, which counted
   * people who never joined and quoted a number no roster could account for. The roster is now
   * the only source: a squad's war total is the sum of its members' own Tactical IQ.
   */
  private squadWarIndex(): Map<string, { tiq: number; contributors: number }> {
    const war = new Map<string, { tiq: number; contributors: number }>();
    for (const squad of this.squads.values()) {
      const key = squadKeyOf(squad.handle);
      if (!key) continue;
      war.set(key, { tiq: squadWarTiq(squad), contributors: squad.roster.length });
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
    const owner = owners.get(squad.creatorId);
    const warTiq = contribution?.tiq ?? squadWarTiq(squad);
    const members = squad.roster.length;
    return {
      id: squad.id,
      chatId: squad.chatId,
      handle: squad.handle,
      name: squad.name,
      kind: squad.kind,
      avatar: squad.avatar,
      tag: squad.tag,
      members,
      subscribers: squad.subscribers,
      creatorId: squad.creatorId,
      ownerId: squad.creatorId,
      ownerName: owner?.name ?? '',
      ownerUsername: owner?.username ?? '',
      createdAt: squad.createdAt,
      verification: squad.verification,
      verifiedAt: squad.verifiedAt,
      verifiedBy: squad.verifiedBy,
      revokedAt: squad.revokedAt,
      banned: squad.banned,
      bannedAt: squad.bannedAt,
      warTiq,
      contributors: contribution?.contributors ?? members,
      title: squad.name,
      type: squad.kind,
      enlistedAt: squad.createdAt,
      enlistedBy: owner?.username ? `@${owner.username}` : squad.creatorId,
      membersCount: members,
      tiq: warTiq,
      status: squad.banned ? 'banned' : squad.verification,
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
  private async squadAction(
    body: Record<string, unknown>,
    me: AdminIdentity,
  ): Promise<{ ok: boolean; error?: string; squad?: SquadWarRow }> {
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
    await this.persistSquads();
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
  private metrics(hostname: string, mode: MatchModeFilter = 'all'): ServerMetrics {
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
      matches24h: this.matchesInWindow(ACTIVE_MS, now, mode === 'all' ? undefined : mode),
      matchesByMode24h: {
        bot: this.matchesInWindow(ACTIVE_MS, now, 'bot'),
        pvp: this.matchesInWindow(ACTIVE_MS, now, 'pvp'),
        arena: this.matchesInWindow(ACTIVE_MS, now, 'arena'),
      },
      matchesByPlayers24h: {
        '2': this.matchesInWindowForPlayers(ACTIVE_MS, now, '2'),
        '3': this.matchesInWindowForPlayers(ACTIVE_MS, now, '3'),
        '4': this.matchesInWindowForPlayers(ACTIVE_MS, now, '4'),
      },
      minesPlaced: this.gameMetrics.minesPlaced,
      active24h: mode === 'all' ? this.activeInWindow(now) : this.activeInWindow(now, mode),
    }), {
      matchesCompleted: 0,
      matches24h: 0,
      matchesByMode24h: { bot: 0, pvp: 0, arena: 0 },
      matchesByPlayers24h: { '2': 0, '3': 0, '4': 0 },
      minesPlaced: 0,
      active24h: 0,
    });
    const population = guarded('population', () => this.populationReading(now), NO_POPULATION);
    const series = guarded('series', () => this.growthWindows(now, mode), NO_SERIES);
    const environment = guarded('environment', () => this.envLabel(hostname), 'unknown');
    return {
      ok: true,
      timestamp: now,
      environment,
      mode,
      ...live,
      ...population,
      ...counters,
      logsSpawned: 0,
      ...series,
      degraded,
    };
  }

  /** Distinct players whose last sighting falls inside the rolling day, for one slice. */
  private activeInWindow(now: number, mode?: MatchMode): number {
    const since = now - ACTIVE_MS;
    let total = 0;
    for (const p of this.players.values()) {
      const at = mode ? p.modeSeen[mode] : p.lastSeen;
      if (at >= since) total++;
    }
    return total;
  }

  /** `production`, `development`, or the deployment's own `WORKER_ENV` label. */
  private envLabel(hostname: string): string {
    try {
      return this.env.WORKER_ENV?.trim()
        || (this.env.DEV_AUTH === 'true' || isLocalhost(hostname) ? 'development' : 'production');
    } catch {
      return 'unknown';
    }
  }

  /**
   * A last-resort reading for the impossible case: the fold itself threw before any section guard
   * could catch it. It is still a complete, well-formed `ServerMetrics` — every figure an exact
   * zero — and it names the failure in `degraded` instead of answering a 500 the panel can only
   * paint as a broken reply. The full reason also goes to the Worker log.
   */
  private metricsFallback(hostname: string, err: unknown, mode: MatchModeFilter = 'all'): ServerMetrics {
    console.error('metrics_failed', reasonOf(err));
    return {
      ok: true,
      timestamp: Date.now(),
      environment: this.envLabel(hostname),
      mode,
      activeRooms: 0,
      queueLength: 0,
      active1v1: 0,
      ...NO_POPULATION,
      matchesCompleted: 0,
      matches24h: 0,
      matchesByMode24h: { bot: 0, pvp: 0, arena: 0 },
      matchesByPlayers24h: { '2': 0, '3': 0, '4': 0 },
      active24h: 0,
      minesPlaced: 0,
      logsSpawned: 0,
      ...NO_SERIES,
      degraded: ['telemetry', reasonOf(err)],
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

  /**
   * The player telemetry surface. A heartbeat keeps the seat inside the ACTIVE window; a match
   * report buckets one completed board under its type and seat count. A board with a `matchId`
   * was settled by the room already, so that report only refreshes the seat's activity clocks;
   * a client-only bot race carries no id and is counted here.
   */
  private async telemetry(request: Request, url: URL): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: TELEMETRY_CORS });
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'method_not_allowed' }, 405, TELEMETRY_CORS);
    }
    const who = await identifyPlayerRequest(request, this.env);
    if (!who) return json({ ok: false, error: 'unauthorized' }, 401, TELEMETRY_CORS);
    if (this.restricted(who.playerId)) {
      return json({ ok: false, error: 'banned' }, 403, TELEMETRY_CORS);
    }

    const now = Date.now();
    const body = await readBody(request);

    if (url.pathname === '/api/client/telemetry/heartbeat') {
      const mode = matchModeOf(body.matchType);
      this.telemetryPlayer(who, now);
      this.markActive(who.playerId, mode ?? undefined);
      return json({
        ok: true,
        active: true,
        matchType: mode,
        timestamp: new Date(now).toISOString(),
      }, 200, TELEMETRY_CORS);
    }

    const matchType = matchModeOf(body.matchType);
    if (!matchType) {
      return json({ ok: false, error: 'invalid_match_type' }, 400, TELEMETRY_CORS);
    }
    this.telemetryPlayer(who, now);
    const players = playerCountOf(body.playersCount);
    const durationSec = durationSeconds(body.durationSec);
    /* A report that names a match the room itself settled must not be counted twice: the
       authoritative board already bucketed it, whatever the client called the mode. */
    const settledByRoom = typeof body.matchId === 'string' && body.matchId.trim() !== '';
    const counted = matchType === 'bot' && !settledByRoom;

    this.markActive(who.playerId, matchType);
    if (counted) this.bumpMetrics({ matchesCompleted: 1 }, { mode: matchType, players }, now);

    return json({
      ok: true,
      recorded: true,
      counted,
      matchType,
      playersCount: players,
      durationSec,
      timestamp: new Date(now).toISOString(),
    }, 200, TELEMETRY_CORS);
  }

  /** The registry row behind a telemetry report, created on the first bot-only session. */
  private telemetryPlayer(who: PlayerAuth, now: number): PlayerRecord {
    const existing = this.players.get(who.playerId);
    if (existing) {
      const name = who.name.slice(0, 40);
      if (name && existing.name !== name) {
        existing.name = name;
        this.persist();
      }
      return existing;
    }
    if (this.players.size >= PLAYERS_MAX) this.trim();
    const record = freshPlayer({
      player: {
        id: who.playerId, name: who.name.slice(0, 40) || 'Player', username: '', flag: '', avatar: '',
      },
      tiq: 0,
      tier: 'rookie',
      flag: '',
      age: 0,
      guest: who.guest,
      premium: false,
      vipUntil: 0,
      coins: 0,
      stars: 0,
      referrals: 0,
      squad: '',
    }, now);
    this.players.set(record.id, record);
    this.creditSignup(now);
    this.creditActive(0, now);
    this.persist();
    return record;
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
    /* The public Nations IQ board: every flag with qualified warriors, ranked by a top-ten
       representative average TIQ so the board is a competitive measure, not a raw pile. */
    if (url.pathname === '/api/nations/leaderboard') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return json(await this.nationsBoard(request, url), 200, { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/api/nations/roster') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return json(await this.nationRoster(request, url), 200, { 'cache-control': 'no-store' });
    }

    /* The private telemetry route: only a request the edge marked after proving a credential.
       The mark names whoever was let through, and the door is the union the Command Center
       promises — the deployment's operator set, or a role this room appointed. A call the edge
       never marked stays shut here, whatever the client sent. */
    if (url.pathname === '/api/admin/metrics') {
      if (!this.metricsMarked(request.headers.get(METRICS_HEADER) ?? '')) {
        return json({ error: 'unauthorized', hint: 'metrics operator required' }, 403);
      }
      const mode = matchModeFilterOf(url.searchParams.get('mode'));
      try {
        return json(this.metrics(url.hostname, mode), 200, { 'cache-control': 'no-store' });
      } catch (err) {
        /* The reading is already folded per section; this is the last line of defence. Answer a
           complete all-zero reading that names the failure, never a 500 the panel paints as a
           broken reply. */
        return json(this.metricsFallback(url.hostname, err, mode));
      }
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
      /* Reconcile with the canonical key first: the admin list is the registry, not whichever
         subset this isolate happened to hydrate. */
      await this.syncSquadsFromStorage();
      return json(this.squadsView(), 200, { 'cache-control': 'no-store' });
    }

    /* The Stars Vault payout queue: a Moderator may audit what was earned and what is waiting;
       only a SuperAdmin may mark a request paid or clear a collusion flag. */
    if (url.pathname === '/api/admin/vault') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return json(this.vaultAdminView(), 200, { 'cache-control': 'no-store' });
    }

    /* The VIP storefront: Moderators may audit sales and read the live sheet; only a SuperAdmin
       may reprice a tier or take it off the store. */
    if (url.pathname === '/api/admin/vip/stats') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return json({ ok: true, ...this.vipStatsView() }, 200, { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/api/admin/vip/config') {
      if (request.method === 'GET') {
        return json({ ok: true, config: this.vipConfig }, 200, { 'cache-control': 'no-store' });
      }
      if (request.method === 'POST') {
        if (!this.superDoor(me)) return json({ error: 'forbidden', hint: 'superadmin required' }, 403);
        const result = this.saveVipConfig(await readBody(request));
        return json(result, result.ok ? 200 : 400);
      }
      return json({ error: 'method_not_allowed' }, 405);
    }

    /* The mandatory channel gate. A Moderator may read the live row; only a SuperAdmin may arm
       it, re-point it, or turn it off. */
    if (url.pathname === '/api/admin/force-join') {
      if (request.method === 'GET') {
        return json({ ok: true, config: forceJoinView(this.forceJoin) }, 200, { 'cache-control': 'no-store' });
      }
      if (request.method === 'POST') {
        if (!this.superDoor(me)) return json({ error: 'forbidden', hint: 'superadmin required' }, 403);
        const result = await this.saveForceJoin(await readBody(request));
        return json(result, result.ok ? 200 : 400);
      }
      return json({ error: 'method_not_allowed' }, 405);
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
      const result = await this.squadAction(body, me);
      return json(result, result.ok ? 200 : 400);
    }

    if (url.pathname === '/api/admin/vault/action') {
      if (!this.superDoor(me)) return json({ error: 'forbidden', hint: 'superadmin required' }, 403);
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      const result = this.vaultAdminAction(await readBody(request));
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
   * May this edge-verified mark read server telemetry?
   *
   * Two doors, unioned. The deployment's operator set (`ADMIN_IDS` plus the historic operator id)
   * always wins, so a cold, reset or unreadable registry can never lock the owners out of their
   * own counters — that is the env failsafe. Failing that, the id must hold a role this room
   * appointed: `superadmin` or `moderator`, the two lanes the Command Center hands out, both of
   * which are documented to read metrics and users.
   *
   * The mark is never a credential on its own: the edge only writes it after proving an initData
   * signature, the operator key, or the allowlist reading that is itself allowlist-gated.
   */
  private metricsMarked(mark: string): boolean {
    if (!mark) return false;
    if (isMetricsMark(mark, this.env)) return true;
    const row = this.admins.get(mark);
    return row?.role === 'superadmin' || row?.role === 'moderator';
  }

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

  /* ---------- the mandatory channel gate ---------- */

  /**
   * The player's own reading. A signed session may only ask about itself; `userId` is accepted as
   * a convenience for the dev door, where there is no signature to name the caller. No identity at
   * all fails open: a browser outside the Mini App has no gate to meet.
   */
  private async checkSubscription(request: Request, url: URL): Promise<Response> {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const base = {
      ok: true,
      forceJoinEnabled: this.forceJoin.forceJoinEnabled,
      targetChannel: this.forceJoin.targetChannel,
      channelUrl: forceJoinChannelUrl(this.forceJoin.targetChannel),
    };
    if (!this.forceJoin.forceJoinEnabled) {
      return json({ ...base, isMember: true }, 200, { 'cache-control': 'no-store' });
    }

    const init = initDataOf(request);
    const signedId = init ? await verifiedTelegramUserId(init, this.env) : '';
    const asked = (url.searchParams.get('userId') ?? '').replace(/[^0-9]/g, '').slice(0, 20);
    if (signedId && asked && asked !== signedId) {
      return json({ ok: false, error: 'user_mismatch', hint: 'userId does not match the signed session' }, 403);
    }
    const dev = this.env.DEV_AUTH === 'true' || isLocalhost(url.hostname);
    const userId = signedId || (dev ? asked : '');

    if (!userId) {
      /* Nothing to check against: fail open rather than pretend the player is outside. */
      return json({ ...base, isMember: true, unavailable: true }, 200, { 'cache-control': 'no-store' });
    }
    const check = await checkChannelMembership(this.env, userId, this.forceJoin.targetChannel);
    return json({
      ...base,
      isMember: check.member,
      ...(check.unavailable ? { unavailable: true } : {}),
    }, 200, { 'cache-control': 'no-store' });
  }

  /**
   * One config write. The channel is normalized to the spelling `getChatMember` accepts, and a
   * gate cannot be armed while pointing at nothing. The row is awaited before the answer leaves,
   * so the next read (and the gate itself) sees exactly what the operator saved.
   */
  private async saveForceJoin(
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string; config?: ReturnType<typeof forceJoinView> }> {
    const next: ForceJoinConfig = {
      forceJoinEnabled: typeof body.forceJoinEnabled === 'boolean'
        ? body.forceJoinEnabled
        : this.forceJoin.forceJoinEnabled,
      targetChannel: this.forceJoin.targetChannel,
    };
    if (body.targetChannel !== undefined) {
      const channel = normalizeForceJoinChannel(body.targetChannel);
      if (!channel) return { ok: false, error: 'invalid_channel' };
      next.targetChannel = channel.targetChannel;
    }
    if (next.forceJoinEnabled && !next.targetChannel) return { ok: false, error: 'channel_required' };
    this.forceJoin = next;
    const storage = this.state?.storage;
    if (storage) await storage.put(FORCE_JOIN_KEY, this.forceJoin);
    return { ok: true, config: forceJoinView(this.forceJoin) };
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
      rank: number; id: string; name: string; country: string; avatar: string;
      tiq: number; wins: number; isYou: boolean;
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
        /* The seat's signed `photo_url` wins; a seat cached before that field existed
           still gets Telegram's public userpic derived from its own username. */
        avatar: p.avatar || telegramPhotoUrl(p.username),
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
      avatar: p.avatar,
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

  /**
   * The Nations Cup: every enrolled flag, ranked by a top-ten representative average TIQ. A flag
   * is never dropped for being young or quiet — its rated seats carry it, and a country the
   * registry has not produced yet is filled from the founding baseline. Proven warriors (three
   * settled races, a human-vs-human clock inside the rolling season window) form the preferred
   * sample; everyone else still carries the flag with their current TIQ. The season's banked win
   * points ride along as a separate award, and the caller's own row quotes both their personal
   * TIQ and the nation's average back.
   */
  private async nationsBoard(request: Request, url: URL): Promise<{
    ok: true;
    seasonNo: number;
    updatedAt: number;
    total: number;
    nations: Array<{
      rank: number;
      code: string;
      name: string;
      points: number;
      players: number;
      warriorCount: number;
      totalTiq: number;
      /** The calculated representative TIQ: the figure the whole board is sorted by. */
      averageTiq: number;
    }>;
    you: { code: string; rank: number; points: number; tiq: number; averageTiq: number; total: number } | null;
  }> {
    /* A board read carries the caller's profile flag, so a nation chosen in Profile is enrolled
       before the standings are cut — a player who has not queued yet still has a country. */
    const mineId = await this.boardSeat(request, url);
    const seasonNo = this.arena.seasonNo;
    const ledger = this.nations.seasonNo === seasonNo ? this.nations : emptyNationLedger(seasonNo);

    /* The caller's own live reading is quoted back on their seat, but it is deliberately never
       folded into the national sample: the query string is caller-controlled, and a ranking read
       must not be able to move a flag's score. The registry record is the only input. */
    const mine = mineId ? this.players.get(mineId) : undefined;
    const rawTiq = Number(url.searchParams.get('tiq'));
    const myTiq = Math.max(0, Math.floor(mine?.tiq ?? 0), Number.isFinite(rawTiq) ? Math.floor(rawTiq) : 0);

    const nations = this.nationStandings(ledger).map((row, i) => ({
      rank: i + 1,
      code: row.code,
      name: row.name,
      players: row.players,
      warriorCount: row.warriorCount,
      points: row.points,
      totalTiq: row.totalTiq,
      averageTiq: row.averageTiq,
    }));

    const myCode = normalizeCountry(mine?.country);
    const hit = myCode ? nations.find((n) => n.code === myCode) ?? null : null;
    const you = hit && mineId
      ? {
        code: myCode,
        rank: hit.rank,
        points: Math.max(0, whole(ledger.byPlayer[mineId]?.[myCode])),
        tiq: myTiq,
        averageTiq: hit.averageTiq,
        total: nations.length,
      }
      : null;

    return { ok: true, seasonNo, updatedAt: Date.now(), total: nations.length, nations, you };
  }

  /**
   * The caller's verified seat, with their profile country folded into the registry first. The
   * profile is the one place a nation choice lives before the socket ever opens; the write is
   * idempotent, touches only the caller's own record, and a banned seat is never enrolled.
   */
  private async boardSeat(request: Request, url: URL): Promise<string> {
    const who = await identifyPlayerRequest(request, this.env);
    if (!who || this.restricted(who.playerId)) return '';
    const cc = normalizeCountry(url.searchParams.get('country'));
    if (!cc) return who.playerId;

    const now = Date.now();
    const existing = this.players.get(who.playerId);
    if (existing) {
      if (existing.country !== cc) {
        existing.country = cc;
        this.persist();
      }
      return existing.id;
    }

    if (this.players.size >= PLAYERS_MAX) this.trim();
    const p = freshPlayer({
      player: { id: who.playerId, name: who.name.slice(0, 40) || 'Player', username: '', flag: cc, avatar: '' },
      tiq: 0,
      tier: 'rookie',
      flag: cc,
      age: 0,
      guest: who.guest,
      /* a directory row built from a nickname has no entitlement to inherit */
      premium: false,
      vipUntil: 0,
      coins: 0,
      stars: 0,
      referrals: 0,
      squad: '',
    }, now);
    this.players.set(p.id, p);
    this.creditSignup(now);
    this.creditActive(0, now);
    this.persist();
    return p.id;
  }

  /**
   * Every enrolled flag, folded from the registry, ranked by its representative average TIQ.
   *
   * The board is a census first and a contest second: a seat that has picked a flag is on the
   * ladder before its first settled race, so a country cannot vanish because its players are
   * new, quiet, or playing alone. The average is cut from the flag's best ten rated warriors —
   * the proven sample (three settled races, a human-vs-human clock inside the season window)
   * when there is one, and every rated seat as the honest fallback when there is not. The
   * divisor is the size of that sample, so a nation carried by one warrior is quoted at that
   * warrior's own TIQ; it is never halved for being small.
   *
   * There is no baseline and no filler: a flag exists only because at least one active,
   * unbanned registry seat carries it. A thin registry returns a thin array — two real
   * countries produce exactly two rows, never a padded field.
   *
   * The order is strictly descending by the calculated representative average TIQ, so rank
   * #1 always holds the highest score. Only genuinely equal scores are broken by total TIQ
   * (a deeper rated pool ranks higher), then the sample size, then head-count, then the flag
   * whose earliest player registered first. Banked season points are an award, not the
   * ranking metric. The code is the final, deterministic tie-break.
   */
  private nationStandings(
    ledger: NationLedger,
    now = Date.now(),
  ): Array<{
    code: string; name: string; points: number; players: number; warriorCount: number;
    totalTiq: number; averageTiq: number; since: number;
  }> {
    const activeSince = now - NATION_ACTIVE_MS;
    const enrolled = new Map<string, {
      players: number;
      totalTiq: number;
      since: number;
      /** Every rated seat under the flag: the fallback sample. */
      scores: number[];
      /** Seats with a proven record: the preferred sample. */
      proven: number[];
    }>();
    for (const p of this.players.values()) {
      const cc = normalizeCountry(p.country);
      if (!cc || p.banned || this.banned.has(p.id)) continue;
      const since = p.firstSeen > 0 ? p.firstSeen : Number.MAX_SAFE_INTEGER;
      let row = enrolled.get(cc);
      if (!row) {
        row = { players: 0, totalTiq: 0, since, scores: [], proven: [] };
        enrolled.set(cc, row);
      }
      row.players += 1;
      if (since < row.since) row.since = since;

      /* A zero-TIQ seat is a spectator wearing a flag: it counts in the census, never in the
         average, so a fresh signup cannot drag its country's rating down. */
      const tiq = Math.max(0, whole(p.tiq));
      if (tiq <= 0) continue;
      row.totalTiq += tiq;
      row.scores.push(tiq);

      /* Proven is a preference, not a gate: a seat still warming up its record keeps its
         current TIQ in the fallback sample instead of being dropped from the nation. */
      const humanRace = p.modeSeen.pvp > 0 || p.modeSeen.arena > 0;
      if (humanRace && p.matches >= NATION_MIN_MATCHES && p.lastSeen >= activeSince) {
        row.proven.push(tiq);
      }
    }

    const live = [...enrolled.entries()].map(([code, row]) => {
      const sample = row.proven.length > 0 ? row.proven : row.scores;
      return {
        code,
        name: countryName(code),
        players: row.players,
        warriorCount: Math.min(sample.length, NATION_TOP_SAMPLE),
        totalTiq: row.totalTiq,
        averageTiq: representativeAverage(sample),
        points: Math.max(0, whole(ledger.points[code])),
        since: row.since,
      };
    });

    /* Strictly descending by the calculated average: rank #1 is always the highest score.
       Everything after the first term only orders exact ties, it can never promote a lower
       average above a higher one. `live` is already the complete board — no rows are added. */
    return live.sort((a, b) => (
      b.averageTiq - a.averageTiq
      || b.totalTiq - a.totalTiq
      || b.warriorCount - a.warriorCount
      || b.players - a.players
      || a.since - b.since
      || a.code.localeCompare(b.code)
    ));
  }

  /**
   * The real top players behind one flag, ranked by the TIQ each has accumulated. Only registry
   * seats are returned, so the sheet can never invent a name or a score; the caller's own seat
   * rides along even when it sits below the top slice.
   */
  private async nationRoster(request: Request, url: URL): Promise<{
    ok: true;
    country: string;
    total: number;
    rows: Array<{ rank: number; id: string; name: string; tiq: number; wins: number; isYou: boolean }>;
    you: { rank: number; id: string; name: string; tiq: number; wins: number; isYou: boolean } | null;
  } | { ok: false; error: string }> {
    const country = normalizeCountry(url.searchParams.get('country'));
    if (!country) return { ok: false, error: 'bad_country' };
    const askedLimit = url.searchParams.get('limit');
    const rawLimit = askedLimit === null ? 20 : Number(askedLimit);
    const limit = Number.isFinite(rawLimit) ? clamp(Math.floor(rawLimit), 1, 50) : 20;

    const init = request.headers.get('x-telegram-init-data') ?? '';
    const tgId = init ? await verifiedTelegramUserId(init, this.env) : '';
    const mineId = tgId ? `tg-${tgId}` : '';

    const field = [...this.players.values()]
      .filter((p) => !p.banned && !this.banned.has(p.id) && normalizeCountry(p.country) === country)
      .sort((a, b) => b.tiq - a.tiq || b.wins - a.wins || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    const asRow = (p: PlayerRecord, rank: number) => ({
      rank,
      id: p.id,
      name: p.name,
      tiq: Math.max(0, whole(p.tiq)),
      wins: Math.max(0, whole(p.wins)),
      isYou: !!mineId && p.id === mineId,
    });

    const rows = field.slice(0, limit).map((p, i) => asRow(p, i + 1));
    const mineIndex = mineId ? field.findIndex((p) => p.id === mineId) : -1;
    const you = mineIndex >= 0 ? asRow(field[mineIndex], mineIndex + 1) : null;

    return { ok: true, country, total: field.length, rows, you };
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
    /* The finished season keeps its own key as the audit record; the new one opens at zero. */
    this.nations = emptyNationLedger(nextNo);
    this.persistNations();
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

  /** Is this seat's purchased VIP term still running? Read live, never from a connect-time stamp. */
  private vipActive(id: string): boolean {
    return (this.players.get(id)?.vipUntil ?? 0) > Date.now();
  }

  /** Fold the durable term into a fresh seat before it takes a queue or a room. */
  private hydrateVip(identity: Identity): void {
    const until = this.players.get(identity.player.id)?.vipUntil ?? 0;
    if (until <= Date.now()) return;
    identity.premium = true;
    identity.vipUntil = until;
  }

  /** `GET /api/vip/me` from the edge: the entitlement this verified player currently holds. */
  private vipMe(request: Request): Response {
    const id = request.headers.get('x-detour-player') ?? '';
    if (!/^tg-[0-9]{1,20}$/.test(id)) return json({ ok: false, error: 'player_required' }, 400);
    const record = this.players.get(id);
    const vipUntil = record?.vipUntil ?? 0;
    const active = vipUntil > Date.now();
    return json({
      ok: true,
      isVip: active,
      vipUntil,
      planId: active ? record?.vipPlan ?? '' : '',
    });
  }

  /**
   * `POST /api/vip/grant` from the bot webhook: one paid Stars receipt, applied once.
   *
   * The plan is re-read from the shared table (never the days on the wire), the extension starts
   * at `max(now, currentVipUntil)` so a renewal stacks rather than resets, and the charge id is
   * kept on the record so Telegram's retry of the same update is a no-op. The amount the receipt
   * actually charged is recorded in the revenue ledger; a duplicate never earns twice.
   */
  private async vipGrant(request: Request): Promise<Response> {
    const body = await readBody(request);
    const plan = vipPlanOf(body.planId);
    if (!plan) return json({ ok: false, error: 'unknown_plan' }, 400);
    const tgId = typeof body.tgId === 'string' ? body.tgId.replace(/[^0-9]/g, '').slice(0, 20) : '';
    const playerId = typeof body.playerId === 'string' ? body.playerId.slice(0, 64) : tgId ? `tg-${tgId}` : '';
    const chargeId = typeof body.chargeId === 'string' ? body.chargeId.slice(0, 128) : '';
    if (!tgId || playerId !== `tg-${tgId}` || !chargeId) {
      return json({ ok: false, error: 'invalid_grant' }, 400);
    }
    const wireStars = typeof body.stars === 'number' && Number.isFinite(body.stars)
      ? Math.floor(body.stars)
      : 0;
    const stars = wireStars >= 1 && wireStars <= VIP_STARS_MAX ? wireStars : plan.stars;
    const clean = (value: unknown): string => (typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40)
      : '');
    const payerName = clean(body.name);
    const payerUsername = clean(body.username);

    const now = Date.now();
    let record = this.players.get(playerId);
    if (!record) {
      record = {
        id: playerId,
        tgId,
        name: payerName || 'Player',
        username: payerUsername,
        country: '',
        avatar: '',
        age: 0,
        tiq: 0,
        firstSeen: now,
        lastSeen: now,
        lastPlayed: 0,
        matches: 0,
        wins: 0,
        losses: 0,
        streak: 0,
        best: 0,
        coins: 0,
        stars: 0,
        referrals: 0,
        squad: '',
        vipUntil: 0,
        vipPlan: '',
        vipCharges: [],
        banned: false,
        muted: false,
        inMatch: false,
        awards: [],
        modeSeen: zeroModeSeen(),
      };
      this.players.set(playerId, record);
      this.trim();
      this.creditSignup(now);
      this.creditActive(0, now);
    } else if (payerUsername && !record.username) {
      record.username = payerUsername;
    }
    if (record.vipCharges.includes(chargeId)) {
      return json({ ok: true, duplicate: true, isVip: record.vipUntil > now, vipUntil: record.vipUntil });
    }
    record.vipUntil = extendVipUntil(record.vipUntil, plan, now);
    record.vipPlan = plan.id;
    record.vipCharges = [...record.vipCharges, chargeId].slice(-20);
    record.lastSeen = now;
    this.recordVipSale({
      userId: playerId,
      username: record.username || record.name || 'Player',
      planId: plan.id,
      stars,
      purchasedAt: now,
      expiresAt: record.vipUntil,
    });
    this.persist();
    return json({ ok: true, isVip: true, vipUntil: record.vipUntil, planId: plan.id });
  }

  /* ---------- the VIP revenue reads and the admin's plan sheet ---------- */

  private persistVipConfig(): void {
    const storage = this.state?.storage;
    if (!storage) return;
    try {
      void storage.put(VIP_CONFIG_KEY, this.vipConfig);
    } catch {
      /* a store that refuses the write: the config stays live in this isolate */
    }
  }

  private persistVipSales(): void {
    const storage = this.state?.storage;
    if (!storage) return;
    try {
      void storage.put(VIP_SALES_KEY, this.vipSales);
    } catch {
      /* a store that refuses the write: the ledger stays live in this isolate */
    }
  }

  /** One receipt, folded into both the lifetime counters and the newest-first audit rows. */
  private recordVipSale(purchase: VipPurchase): void {
    const ledger = this.vipSales;
    ledger.totalPurchases = Math.min(Number.MAX_SAFE_INTEGER, ledger.totalPurchases + 1);
    ledger.totalStars = Math.min(Number.MAX_SAFE_INTEGER, ledger.totalStars + purchase.stars);
    const tier = ledger.tiers[purchase.planId];
    tier.count += 1;
    tier.starsGrossed += purchase.stars;
    ledger.recent = [purchase, ...ledger.recent].slice(0, VIP_RECENT_MAX);
    this.persistVipSales();
  }

  /** `GET /api/admin/vip/stats`: live subscribers beside the lifetime Stars ledger. */
  private vipStatsView(): VipRevenueSummary {
    const now = Date.now();
    let totalSubscribers = 0;
    for (const record of this.players.values()) {
      if (record.vipUntil > now) totalSubscribers++;
    }
    return {
      totalSubscribers,
      allTimePurchases: this.vipSales.totalPurchases,
      totalStarsEarned: this.vipSales.totalStars,
      tierBreakdown: {
        '7d': { ...this.vipSales.tiers['7d'] },
        '30d': { ...this.vipSales.tiers['30d'] },
        '90d': { ...this.vipSales.tiers['90d'] },
      },
      recentPurchases: this.vipSales.recent.slice(0, VIP_RECENT_REPORT).map((row) => ({ ...row })),
    };
  }

  /**
   * `POST /api/admin/vip/config`. Accepts one tier (`planId` + `stars`/`price` + `enabled`) or a
   * map of tiers, validates every supplied tier strictly, and merges onto the stored sheet so a
   * single row's save never resets the other two.
   */
  private saveVipConfig(body: Record<string, unknown>):
  { ok: true; config: VipPlanConfig } | { ok: false; error: string; hint?: string } {
    const invalid = {
      ok: false as const,
      error: 'invalid_config',
      hint: `each plan needs stars between ${VIP_STARS_MIN} and ${VIP_STARS_MAX} and a boolean enabled`,
    };
    const next: VipPlanConfig = {
      '7d': { ...this.vipConfig['7d'] },
      '30d': { ...this.vipConfig['30d'] },
      '90d': { ...this.vipConfig['90d'] },
    };
    let touched = 0;

    const directId = typeof body.planId === 'string' ? body.planId : '';
    if (directId) {
      const plan = vipPlanOf(directId);
      if (!plan) return { ok: false, error: 'unknown_plan' };
      const tier = vipPlanSettingsOf({ stars: body.stars ?? body.price, enabled: body.enabled });
      if (!tier) return invalid;
      next[plan.id] = tier;
      touched++;
    } else {
      const source = body.plans ?? body.config ?? body;
      if (!source || typeof source !== 'object' || Array.isArray(source)) return invalid;
      const rows = source as Record<string, unknown>;
      for (const id of VIP_PLAN_IDS) {
        if (!(id in rows)) continue;
        const tier = vipPlanSettingsOf(rows[id]);
        if (!tier) return invalid;
        next[id] = tier;
        touched++;
      }
    }

    if (!touched) return { ok: false, error: 'invalid_config', hint: 'no plan settings supplied' };
    this.vipConfig = next;
    this.persistVipConfig();
    return { ok: true, config: next };
  }

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
    p.country = normalizeCountry(identity.flag) || p.country;
    p.avatar = storedAvatar(identity.player.avatar) || p.avatar;
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
  private markActive(id: string, mode?: MatchMode): void {
    const p = this.players.get(id);
    if (!p) return;
    const now = Date.now();
    this.stampSeen(p, now);
    if (mode) this.stampModeSeen(p, mode, now);
    this.persist();
  }

  /** Move one match-type clock forward, crediting its ring for a bucket the seat had not entered. */
  private stampModeSeen(p: PlayerRecord, mode: MatchMode, at: number): void {
    const prev = p.modeSeen[mode] ?? 0;
    if (at <= prev) return;
    p.modeSeen[mode] = at;
    this.creditModeActive(mode, prev > 0 ? prev : -1, at);
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
        this.creditNation(p);
      } else {
        p.losses++;
        p.streak = 0;
      }
    }
    this.persist();
  }

  /**
   * Bank one settled win for the winner's chosen nation. The room is the only writer: a win the
   * board did not judge never reaches this ledger, so a nation's points are exactly the TIQ its
   * players earned in real online races this season.
   */
  private creditNation(p: PlayerRecord): void {
    const cc = normalizeCountry(p.country);
    if (!cc) return;
    const seasonNo = this.arena.seasonNo;
    if (this.nations.seasonNo !== seasonNo) this.nations = emptyNationLedger(seasonNo);
    this.nations.points[cc] = Math.max(0, whole(this.nations.points[cc])) + NATION_WIN_TIQ;
    const shares = this.nations.byPlayer[p.id] ?? {};
    shares[cc] = Math.max(0, whole(shares[cc])) + NATION_WIN_TIQ;
    this.nations.byPlayer[p.id] = shares;
    this.persistNations();
  }

  /** One win, one write: the ledger is small, and a banked point must survive eviction. */
  private persistNations(): void {
    const storage = this.state?.storage;
    if (!storage) return;
    try {
      void storage.put(nationLedgerKey(this.nations.seasonNo), this.nations);
    } catch {
      /* a store that refuses the write: the ledger stays live for this object's lifetime */
    }
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
   * Stamp completed matches into their UTC-hour buckets, once for the aggregate and once for each
   * tag it carries. Only the retained window is kept, so the blob stays small while the rolling
   * 24-hour figures stay exact.
   */
  private stampMatchesByHour(matches: number, tag?: MatchTag, now = Date.now()): void {
    if (matches <= 0) return;
    const hour = Math.floor(now / HOUR_MS);
    const key = String(hour);
    const add = (map: Record<string, number>): void => {
      map[key] = whole(map[key]) + matches;
    };
    add(this.gameMetrics.matchesByHour);
    if (tag) {
      add(this.gameMetrics.matchesByModeHour[tag.mode]);
      add(this.gameMetrics.matchesByPlayersHour[String(tag.players) as '2' | '3' | '4']);
    }
    const oldest = hour - MATCH_BUCKET_KEEP_HOURS;
    const prune = (map: Record<string, number>): void => {
      for (const stored of Object.keys(map)) {
        if (Number(stored) < oldest) delete map[stored];
      }
    };
    prune(this.gameMetrics.matchesByHour);
    for (const mode of MATCH_MODES) prune(this.gameMetrics.matchesByModeHour[mode]);
    for (const seats of ['2', '3', '4'] as const) prune(this.gameMetrics.matchesByPlayersHour[seats]);
  }

  /** Matches stamped inside a rolling window for one slice, read back from hourly buckets. */
  private matchesInWindow(windowMs: number, now = Date.now(), mode?: MatchMode): number {
    const oldest = Math.floor((now - windowMs) / HOUR_MS);
    const newest = Math.floor(now / HOUR_MS);
    const buckets = mode ? this.gameMetrics.matchesByModeHour[mode] : this.gameMetrics.matchesByHour;
    let total = 0;
    for (const [key, value] of Object.entries(buckets)) {
      const hour = Number(key);
      if (hour >= oldest && hour <= newest) total += value;
    }
    return total;
  }

  /** Matches inside a rolling window for one seat count. */
  private matchesInWindowForPlayers(windowMs: number, now: number, players: '2' | '3' | '4'): number {
    const oldest = Math.floor((now - windowMs) / HOUR_MS);
    const newest = Math.floor(now / HOUR_MS);
    let total = 0;
    for (const [key, value] of Object.entries(this.gameMetrics.matchesByPlayersHour[players])) {
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

  /**
   * The same fold for one match-type ring. `slot` is 0 active or 1 matches; the signup count is
   * never repeated here because a registration belongs to the whole app, not to a game mode.
   */
  private creditModeGrowth(
    slot: 0 | 1, mode: MatchMode, at: number, by = 1, dedupeFrom = -1,
  ): void {
    if (by <= 0) return;
    const ring = this.growth.modes[mode];
    const hour = Math.floor(at / HOUR_MS);
    const day = dayIndexOf(at);
    const freshHour = dedupeFrom < 0 || Math.floor(dedupeFrom / HOUR_MS) !== hour;
    const freshDay = dedupeFrom < 0 || dayIndexOf(dedupeFrom) !== day;
    if (!freshHour && !freshDay) return;
    let opened = false;
    const stamp = (map: Record<string, ModeGrowthBucket>, key: string): void => {
      const bucket = map[key];
      if (bucket) {
        bucket[slot] = whole(bucket[slot]) + by;
        return;
      }
      const row: ModeGrowthBucket = [0, 0];
      row[slot] = by;
      map[key] = row;
      opened = true;
    };
    if (freshHour) stamp(ring.hourly, String(hour));
    if (freshDay) stamp(ring.daily, this.growthDayKey(day));
    if (opened) pruneGrowth(this.growth, at);
    this.persistMetrics();
  }

  /** A first-time registration, counted in the bucket it actually landed in. */
  private creditSignup(at: number): void {
    this.creditGrowth(0, at);
  }

  /** A seat's `lastSeen` moving forward: one more active player in any bucket not yet credited. */
  private creditActive(prevSeen: number, at: number): void {
    this.creditGrowth(1, at, 1, prevSeen > 0 ? prevSeen : -1);
  }

  /** A seat's match-type clock moving forward: one active player in that slice. */
  private creditModeActive(mode: MatchMode, prevSeen: number, at: number): void {
    this.creditModeGrowth(0, mode, at, 1, prevSeen);
  }

  /** Boards that reached a verdict. Every one of them counts, so there is nothing to dedupe. */
  private creditMatches(matches: number, at = Date.now()): void {
    this.creditGrowth(2, at, matches);
  }

  /** The same verdict, credited to the match type it was played in. */
  private creditModeMatches(mode: MatchMode, matches: number, at = Date.now()): void {
    this.creditModeGrowth(1, mode, at, matches);
  }

  /** Matches settled on one UTC day, summed from the eight-day-deep hourly match buckets. */
  private matchesOnDay(dayIndex: number, mode?: MatchMode): number {
    const buckets = mode ? this.gameMetrics.matchesByModeHour[mode] : this.gameMetrics.matchesByHour;
    let total = 0;
    for (let hour = 0; hour < 24; hour++) {
      total += whole(buckets[String(dayIndex * 24 + hour)]);
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
  private foldRegistry(hour: number, day: number, mode?: MatchMode): {
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
      const activeAt = mode ? p.modeSeen[mode] : p.lastSeen;
      if (activeAt > 0) {
        credit(hourly, Math.floor(activeAt / HOUR_MS), oldestHour, hour, 1);
        credit(daily, dayIndexOf(activeAt), oldestDay, day, 1);
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
   *
   * A mode slice replaces the active and match columns with that mode's own rings and buckets;
   * signups stay aggregate because a registration is not a match type.
   */
  private growthWindows(
    now: number, mode: MatchModeFilter = 'all',
  ): Pick<ServerMetrics, 'series24h' | 'series7d' | 'series30d'> {
    const hour = Math.floor(now / HOUR_MS);
    const day = dayIndexOf(now);
    const slice = mode === 'all' ? null : mode;
    const folded = this.foldRegistry(hour, day, slice ?? undefined);
    const modeHourly = slice ? this.growth.modes[slice].hourly : null;
    const modeDaily = slice ? this.growth.modes[slice].daily : null;

    const series24h: SeriesPoint[] = [];
    for (let back = HOURLY_KEEP - 1; back >= 0; back--) {
      const index = hour - back;
      const key = String(index);
      const stamped = this.growth.hourly[key];
      const sliceStamped = modeHourly?.[key];
      const registry = folded.hourly.get(index);
      series24h.push({
        t: index * HOUR_MS,
        signups: Math.max(stamped?.[0] ?? 0, registry?.[0] ?? 0),
        active: slice
          ? Math.max(sliceStamped?.[0] ?? 0, registry?.[1] ?? 0)
          : Math.max(stamped?.[1] ?? 0, registry?.[1] ?? 0),
        matches: slice
          ? Math.max(sliceStamped?.[1] ?? 0, whole(this.gameMetrics.matchesByModeHour[slice][key]))
          : Math.max(stamped?.[2] ?? 0, whole(this.gameMetrics.matchesByHour[key])),
      });
    }

    const series30d: SeriesPoint[] = [];
    for (let back = DAILY_KEEP - 1; back >= 0; back--) {
      const index = day - back;
      const key = dayKeyOf(index);
      const stamped = this.growth.daily[key];
      const sliceStamped = modeDaily?.[key];
      const registry = folded.daily.get(index);
      series30d.push({
        t: index * DAY_MS,
        signups: Math.max(stamped?.[0] ?? 0, registry?.[0] ?? 0),
        active: slice
          ? Math.max(sliceStamped?.[0] ?? 0, registry?.[1] ?? 0)
          : Math.max(stamped?.[1] ?? 0, registry?.[1] ?? 0),
        matches: slice
          ? Math.max(sliceStamped?.[1] ?? 0, this.matchesOnDay(index, slice))
          : Math.max(stamped?.[2] ?? 0, this.matchesOnDay(index)),
      });
    }

    return { series24h, series7d: series30d.slice(-7), series30d };
  }

  /** Add to the durable gameplay counters; a missing or negative delta is exactly zero. */
  private bumpMetrics(delta: Partial<GameMetrics>, tag?: MatchTag, now = Date.now()): void {
    const matches = whole(delta.matchesCompleted);
    const mines = whole(delta.minesPlaced);
    if (!matches && !mines) return;
    this.gameMetrics.matchesCompleted += matches;
    this.gameMetrics.minesPlaced += mines;
    if (matches) {
      this.stampMatchesByHour(matches, tag, now);
      this.creditMatches(matches, now);
      if (tag) this.creditModeMatches(tag.mode, matches, now);
    }
    this.persistMetrics();
  }

  /**
   * How a room's board is counted: a real PvP match once two people were ever seated, else a bot
   * race. A seat the machine took over mid-match still belongs to the person who started in it.
   */
  private roomModeOf(live: LiveRoom): MatchMode {
    const roster = live.driver?.room ?? live.room;
    let humans = 0;
    for (const seat of roster.seats) {
      if (seat && seat.kind === 'human' && seat.id) humans++;
    }
    return humans >= 2 ? 'pvp' : 'bot';
  }

  /** One completed room credits the match counter once, however it reached its winner. */
  private completeRoom(live: LiveRoom): void {
    if (live.counted) return;
    live.counted = true;
    const roster = live.driver?.room ?? live.room;
    const mode = this.roomModeOf(live);
    for (const member of live.members) if (member) this.markActive(member.id, mode);
    this.bumpMetrics(
      { matchesCompleted: 1 },
      { mode, players: playerCountOf(roster.seats.length) },
    );
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
    const plan = vipPlanFilterOf(params.get('plan'));
    const sort = sortOf(params.get('sort')) ?? (filter === 'tiq' ? 'tiq' : filter === 'stars' ? 'stars' : 'default');
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
    if (filter === 'stars') rows = rows.filter((p) => p.stars > 0);
    if (country) rows = rows.filter((p) => p.country === country);
    if (age !== 'all') rows = rows.filter((p) => inAgeBand(p.age, age));
    if (plan !== 'all') rows = rows.filter((p) => vipMatchesPlanFilter(p.vipUntil, p.vipPlan, plan, now));
    /* the default order reads like the room: flagged first when that is the view, else live boards,
       then the freshest seats. The three explicit sorts answer an audit question instead. */
    /* The card prints `max(lastSeen, lastPlayed)`, so that is the key "Last played" sorts on:
       a seat that just opened the app must never sit under one whose last race is older. */
    if (sort === 'lastPlayed') rows.sort((a, b) =>
      Math.max(b.lastSeen, b.lastPlayed) - Math.max(a.lastSeen, a.lastPlayed)
      || b.lastSeen - a.lastSeen || a.id.localeCompare(b.id));
    else if (sort === 'joined') rows.sort((a, b) => b.firstSeen - a.firstSeen);
    else if (sort === 'tiq') rows.sort((a, b) => b.tiq - a.tiq || b.lastSeen - a.lastSeen);
    else if (sort === 'stars') rows.sort((a, b) => b.stars - a.stars || b.tiq - a.tiq || b.lastSeen - a.lastSeen);
    else if (sort === 'stars_asc') rows.sort((a, b) => a.stars - b.stars || a.tiq - b.tiq || b.lastSeen - a.lastSeen);
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
    this.persistLobbies();
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

  private enter(
    ws: WebSocket, identity: Identity, wide: boolean, sizes: [number, number], mode: 'pvp' | 'arena',
    queued = true,
  ): Waiter {
    const waiter: Waiter = {
      ws,
      id: identity.player.id,
      name: identity.player.name,
      tiq: identity.tiq,
      tier: identity.tier,
      flag: identity.flag,
      avatar: identity.player.avatar,
      wide,
      joinedAt: Date.now(),
      sizes,
      mode,
      premium: identity.premium || this.vipActive(identity.player.id),
      vipUntil: Math.max(identity.vipUntil, this.players.get(identity.player.id)?.vipUntil ?? 0),
      race: null,
      side: 0,
    };
    if (queued) this.queue.push(waiter);
    return waiter;
  }

  private attach(waiter: Waiter, session = false): void {
    waiter.ws.addEventListener('message', (ev: MessageEvent) => {
      const board = boardOf(waiter);
      const msg = readMessage(ev.data, waiter.side, board.cols, board.rows);
      if (!msg) return;
      if (msg.type === 'PING') {
        try {
          waiter.ws.send(JSON.stringify({ type: 'PONG' }));
        } catch {
          /* the socket is already gone */
        }
        return;
      }
      /* the relic-duel lane exists on every seat, queue or ambient */
      if (msg.type === 'RELIC_CHALLENGE_SEND') { this.sendRelicChallenge(waiter, msg); return; }
      if (msg.type === 'RELIC_CHALLENGE_ACCEPT') { this.acceptRelicChallenge(waiter, msg.challengeId); return; }
      if (msg.type === 'RELIC_CHALLENGE_DECLINE') { this.declineRelicChallenge(waiter, msg.challengeId); return; }
      /* a paired socket is a race, not a queue: the same connection changes what it means */
      if (msg.type === 'POST_MATCH_CHAT') { this.relayPostChat(waiter.ws, msg); return; }
      if (waiter.race) this.relay(waiter, msg);
      else if (msg.type === 'QUEUE') this.enqueue(waiter, msg.wide);
      else if (msg.type === 'WIDEN') this.widen(waiter);
      else if (msg.type === 'CANCEL') this.leave(waiter, true);
    });
    waiter.ws.addEventListener('close', () => {
      if (session && this.sessions.get(waiter.id) === waiter) {
        this.sessions.delete(waiter.id);
        this.dropChallengesFor(waiter.id);
      }
      this.leave(waiter, false);
    });
    waiter.ws.addEventListener('error', () => {
      if (session && this.sessions.get(waiter.id) === waiter) {
        this.sessions.delete(waiter.id);
        this.dropChallengesFor(waiter.id);
      }
      this.leave(waiter, false);
    });
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
    this.markActive(waiter.id, waiter.mode);
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
    this.markActive(waiter.id, waiter.mode);
    this.queue[at].wide = true;
    this.pairNow();
  }

  /** Out of the room. A CANCEL closes the socket; a dead socket is just forgotten — and either
   *  way a player who was racing hands the win to the seat opposite. */
  private leave(waiter: Waiter, close: boolean): void {
    this.markActive(waiter.id, waiter.race?.mode ?? waiter.mode);
    /* a settled seat walking out ends the banter lane before the socket closes */
    this.dropPostChat(waiter.ws, true);
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

  /* ---------- relic duels: send, accept, decline, expire ---------- */

  /** Bind an ambient socket to its player and hand it any challenge filed while they were away. */
  private registerSession(waiter: Waiter): void {
    this.sessions.set(waiter.id, waiter);
    const now = Date.now();
    let changed = false;
    for (const challenge of this.relicChallenges.values()) {
      if (challenge.targetUserId !== waiter.id || challenge.status !== 'pending') continue;
      if (challenge.expiresAt <= now) {
        challenge.status = 'expired';
        changed = true;
        this.postToPlayer(challenge.challengerId, JSON.stringify({
          type: 'CHALLENGE_EXPIRED', challengeId: challenge.id,
        }));
        continue;
      }
      this.postRelic(waiter, this.relicIncomingPayload(challenge));
    }
    if (changed) this.persistRelics();
    this.rearm();
  }

  private relicIncomingPayload(challenge: RelicChallenge): string {
    return JSON.stringify({
      type: 'RELIC_CHALLENGE_INCOMING',
      challengeId: challenge.id,
      challengerId: challenge.challengerId,
      challengerName: challenge.challengerName,
      challengerAvatar: challenge.challengerAvatar,
      challengerTiq: challenge.challengerTiq,
      relicId: challenge.relicId,
      relicSerial: challenge.relicSerial,
      expiresAt: challenge.expiresAt,
      roomId: challenge.roomId,
    });
  }

  private postRelic(waiter: Waiter, payload: string): boolean {
    try {
      waiter.ws.send(payload);
      return true;
    } catch {
      return false;
    }
  }

  private socketAlive(ws: WebSocket): boolean {
    try {
      return ws.readyState === 1;
    } catch {
      return false;
    }
  }

  private refuseRelic(waiter: Waiter, reason: string): void {
    this.postRelic(waiter, JSON.stringify({ type: 'RELIC_CHALLENGE_REFUSED', reason }));
  }

  /**
   * A challenge is filed, then pushed if the holder has a live session. An offline holder keeps
   * the row in the durable mailbox, which their next boot reads — the same 25s window, no link.
   */
  private sendRelicChallenge(
    waiter: Waiter,
    msg: Extract<ClientMessage, { type: 'RELIC_CHALLENGE_SEND' }>,
  ): void {
    if (this.maintenance) { this.refuseRelic(waiter, 'MAINTENANCE'); return; }
    if (this.restricted(waiter.id)) { this.refuseRelic(waiter, 'BANNED'); return; }
    if (msg.targetUserId === waiter.id || msg.targetUserId === 'you') {
      this.refuseRelic(waiter, 'SELF');
      return;
    }
    const cap = RELIC_CAPS[msg.relicId];
    if (!cap || msg.relicSerial > cap) { this.refuseRelic(waiter, 'UNKNOWN_RELIC'); return; }
    /* the shield is the server's own verdict, read off the shared clock — never the client's */
    if (relicShelter(msg.relicId, msg.relicSerial).sheltered) {
      this.refuseRelic(waiter, 'SHIELDED');
      return;
    }
    /* A live board — a queue race or a friends room — owns the seat, whatever socket it is on. */
    if (waiter.race || this.players.get(waiter.id)?.inMatch || this.inRoom(waiter.id)) {
      this.refuseRelic(waiter, 'BUSY');
      return;
    }

    const now = Date.now();
    const duplicate = [...this.relicChallenges.values()].find((c) =>
      c.status === 'pending' && c.challengerId === waiter.id && c.targetUserId === msg.targetUserId
      && c.expiresAt > now);
    if (duplicate) {
      this.postRelic(waiter, JSON.stringify({
        type: 'RELIC_CHALLENGE_SENT',
        challengeId: duplicate.id,
        expiresAt: duplicate.expiresAt,
        online: !!this.sessions.get(duplicate.targetUserId),
      }));
      return;
    }

    const target = this.sessions.get(msg.targetUserId) ?? null;
    if (target?.race || this.players.get(msg.targetUserId)?.inMatch || this.inRoom(msg.targetUserId)) {
      this.refuseRelic(waiter, 'TARGET_BUSY');
      return;
    }

    const challengeId = `rc${hash(
      `${waiter.id}|${msg.targetUserId}|${msg.relicId}|${msg.relicSerial}|${now}|${++this.paired}`,
    ).toString(36)}`;
    const roomId = `d${hash(`relic-duel|${challengeId}|${now}`).toString(36)}`;
    const challenge: RelicChallenge = {
      id: challengeId,
      challengerId: waiter.id,
      challengerName: waiter.name,
      challengerAvatar: waiter.avatar,
      challengerTiq: waiter.tiq,
      targetUserId: msg.targetUserId,
      relicId: msg.relicId,
      relicSerial: msg.relicSerial,
      expiresAt: now + RELIC_CHALLENGE_TTL_MS,
      roomId,
      status: 'pending',
      createdAt: now,
    };
    this.relicChallenges.set(challengeId, challenge);
    this.challengeSeats.set(challengeId, waiter);
    this.trimRelics(now);
    this.persistRelics();
    this.rearm();

    const online = !!target && this.postRelic(target, this.relicIncomingPayload(challenge));
    this.postRelic(waiter, JSON.stringify({
      type: 'RELIC_CHALLENGE_SENT',
      challengeId,
      expiresAt: challenge.expiresAt,
      online,
    }));
  }

  private acceptRelicChallenge(waiter: Waiter, challengeId: string): void {
    const challenge = this.relicChallenges.get(challengeId);
    if (!challenge || challenge.targetUserId !== waiter.id) {
      this.refuseRelic(waiter, 'NOT_YOURS');
      return;
    }
    if (challenge.status !== 'pending') return;
    const now = Date.now();
    if (challenge.expiresAt <= now) {
      this.expireChallenge(challenge);
      this.refuseRelic(waiter, 'EXPIRED');
      return;
    }
    if (waiter.race || this.players.get(waiter.id)?.inMatch || this.inRoom(waiter.id)) {
      this.refuseRelic(waiter, 'BUSY');
      return;
    }
    if (relicShelter(challenge.relicId, challenge.relicSerial, now).sheltered) {
      this.refuseRelic(waiter, 'SHIELDED');
      return;
    }

    const seat = this.challengeSeats.get(challengeId) ?? null;
    const session = this.sessions.get(challenge.challengerId) ?? null;
    const challenger = seat && this.socketAlive(seat.ws) ? seat : session;
    if (
      !challenger || !this.socketAlive(challenger.ws) || challenger.race
      || this.players.get(challenger.id)?.inMatch || this.inRoom(challenger.id)
    ) {
      challenge.status = 'expired';
      this.challengeSeats.delete(challengeId);
      this.persistRelics();
      this.postRelic(waiter, JSON.stringify({
        type: 'RELIC_CHALLENGE_CLOSED', challengeId, reason: 'CHALLENGER_LEFT',
      }));
      this.rearm();
      return;
    }

    challenge.status = 'accepted';
    this.challengeSeats.delete(challengeId);
    /* Both players leave the ordinary market before the duel board exists, whatever socket each
       of them happened to be waiting on. */
    this.queue = this.queue.filter((seat) => seat.id !== challenger.id && seat.id !== waiter.id);
    this.persistRelics();
    this.postRelic(challenger, JSON.stringify({ type: 'RELIC_CHALLENGE_ACCEPTED', challengeId }));
    this.startRelicDuel(challenge, challenger, waiter);
  }

  private declineRelicChallenge(waiter: Waiter, challengeId: string): void {
    const challenge = this.relicChallenges.get(challengeId);
    if (!challenge || challenge.targetUserId !== waiter.id) return;
    if (challenge.status !== 'pending') return;
    challenge.status = 'declined';
    this.challengeSeats.delete(challengeId);
    this.persistRelics();
    this.postToPlayer(challenge.challengerId, JSON.stringify({
      type: 'RELIC_CHALLENGE_DECLINED', challengeId,
    }));
    this.rearm();
  }

  /**
   * The accepted challenge becomes a real 1v1 on the two live sockets. No lobby, no room code:
   * both clients are told `DUEL_START` with their side, and each one routes straight to the board.
   */
  private startRelicDuel(challenge: RelicChallenge, challenger: Waiter, target: Waiter): void {
    const roomId = challenge.roomId;
    const seed = hash(roomId);
    const sizes: [number, number] = [1, 1];
    challenger.side = 0;
    target.side = 1;
    challenger.sizes = sizes;
    target.sizes = sizes;
    const race: Race = {
      matchId: roomId,
      seed,
      sizes,
      mode: 'pvp',
      origin: 'relic',
      seats: [challenger, target],
      state: newGame(sizes),
      startedAt: Date.now(),
      over: false,
    };
    challenger.race = race;
    target.race = race;
    this.races.set(roomId, race);
    this.setInMatch(challenger.id, true);
    this.setInMatch(target.id, true);

    this.postRelic(challenger, duelStartMessage(roomId, seed, 0, challenger, target, sizes));
    this.postRelic(target, duelStartMessage(roomId, seed, 1, target, challenger, sizes));
  }

  /** Mark one pending challenge expired and tell both ends, so neither keeps waiting on it. */
  private expireChallenge(challenge: RelicChallenge): void {
    if (challenge.status !== 'pending') return;
    challenge.status = 'expired';
    this.challengeSeats.delete(challenge.id);
    this.persistRelics();
    this.postToPlayer(challenge.challengerId, JSON.stringify({
      type: 'CHALLENGE_EXPIRED', challengeId: challenge.id,
    }));
    this.postToPlayer(challenge.targetUserId, JSON.stringify({
      type: 'RELIC_CHALLENGE_CLOSED', challengeId: challenge.id, reason: 'EXPIRED',
    }));
    this.rearm();
  }

  private expireRelicChallenges(now: number): void {
    for (const challenge of [...this.relicChallenges.values()]) {
      if (challenge.status === 'pending' && challenge.expiresAt <= now) this.expireChallenge(challenge);
    }
    this.trimRelics(now);
  }

  /** A session socket went away: any challenge it threw can no longer be accepted. */
  private dropChallengesFor(playerId: string): void {
    let changed = false;
    for (const challenge of this.relicChallenges.values()) {
      if (challenge.challengerId !== playerId || challenge.status !== 'pending') continue;
      challenge.status = 'expired';
      this.challengeSeats.delete(challenge.id);
      changed = true;
      this.postToPlayer(challenge.targetUserId, JSON.stringify({
        type: 'RELIC_CHALLENGE_CLOSED', challengeId: challenge.id, reason: 'CHALLENGER_LEFT',
      }));
    }
    if (changed) {
      this.persistRelics();
      this.rearm();
    }
  }

  private postToPlayer(playerId: string, payload: string): boolean {
    const waiter = this.sessions.get(playerId);
    return waiter ? this.postRelic(waiter, payload) : false;
  }

  /** A seat held in a friends lobby is not free for a duel, even before its board launches. */
  private inRoom(playerId: string): boolean {
    for (const ref of this.refs.values()) {
      const member = ref.live.members[ref.seat];
      if (member?.id === playerId) return true;
    }
    return false;
  }

  /** Bound the mailbox: an old challenge is history, not a leak. */
  private trimRelics(now: number): void {
    for (const [id, challenge] of [...this.relicChallenges]) {
      if (now - challenge.createdAt > RELIC_CHALLENGE_KEEP_MS) this.relicChallenges.delete(id);
    }
    if (this.relicChallenges.size <= RELIC_CHALLENGE_MAX) return;
    const oldest = [...this.relicChallenges.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const challenge of oldest.slice(0, this.relicChallenges.size - RELIC_CHALLENGE_MAX)) {
      this.relicChallenges.delete(challenge.id);
    }
  }

  private persistRelics(): void {
    if (this.relicDirty || !this.state?.storage) return;
    this.relicDirty = true;
    void Promise.resolve().then(() => {
      this.relicDirty = false;
      const storage = this.state.storage;
      if (!storage) return;
      try {
        void storage.put(RELIC_CHALLENGES_KEY, [...this.relicChallenges.values()]);
      } catch {
        /* a store that refuses the write: the mailbox stays live for this object's lifetime */
      }
    });
  }

  /** `GET /api/client/relic/challenges` — the next-boot half of an offline challenge. */
  private async relicMailbox(request: Request): Promise<Response> {
    const who = await identifyPlayerRequest(request, this.env);
    if (!who) return json({ error: 'unauthorized', hint: 'signed initData required' }, 401);
    const now = Date.now();
    this.expireRelicChallenges(now);
    const rows = [...this.relicChallenges.values()]
      .filter((challenge) => challenge.targetUserId === who.playerId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 12)
      .map((challenge) => ({
        challengeId: challenge.id,
        challengerId: challenge.challengerId,
        challengerName: challenge.challengerName,
        challengerAvatar: challenge.challengerAvatar,
        challengerTiq: challenge.challengerTiq,
        relicId: challenge.relicId,
        relicSerial: challenge.relicSerial,
        expiresAt: challenge.expiresAt,
        roomId: challenge.roomId,
        status: challenge.status,
        createdAt: challenge.createdAt,
      }));
    return json({ challenges: rows }, 200, { 'cache-control': 'no-store' });
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
      mode: first.mode === 'arena' || second.mode === 'arena' ? 'arena' : 'pvp',
      origin: 'queue',
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

    this.deliver(first, foundMessage(matchId, seed, 0, first, second, sizes, race.mode));
    this.deliver(second, foundMessage(matchId, seed, 1, second, first, sizes, race.mode));
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
      const now = Date.now();
      live = {
        room: createRoom({ code: this.mintRoomCode(), seats: size, waitMs: ROOM_WAIT_MS, botTier: tier, now }),
        size,
        counted: false,
        members: Array.from({ length: size }, () => null),
        matchId: '',
        seed: 0,
        startedAt: 0,
        driver: null,
        turnDeadlineMs: 0,
        hostSeat: 0,
        format: formatForSize(size),
        mode: 'ffa',
        teams: Array.from({ length: size }, (_, i) => defaultTeam(i)),
        code: false,
        lastSeenAt: now,
        hostPending: false,
      };
      this.openRooms.push(live);
    }
    const seat = this.freeSeat(live);
    if (seat < 0) return;                        // unreachable: the search only picks rooms with one
    live.members[seat] = {
      ws, seat, id: identity.player.id, name: identity.player.name,
      tiq: identity.tiq, tier: identity.tier, flag: identity.flag, avatar: identity.player.avatar,
      premium: identity.premium || this.vipActive(identity.player.id),
      connected: true, droppedAt: 0, busy: false, lastPingAt: 0,
    };
    live.room = seatHuman(live.room, seat, {
      kind: 'human', id: identity.player.id, name: identity.player.name,
    });
    this.refs.set(ws, { live, seat });
    /* A lobby is presence, not a mode yet: the board's own frames and its completion carry the tag. */
    this.markActive(identity.player.id);

    this.watchRoomSocket(live, ws);

    /* a full room starts now; anything less waits, and the alarm fills it when the wait runs out */
    if (live.members.every((m) => m !== null)) this.launchRoom(live);
    else this.rearm();
  }

  /**
   * Take a seat in a code-based friends lobby.
   *
   * The code is the room, not the socket. A host who mints `room_1234` and steps into a Telegram
   * chat to send the link still owns `room_1234` when they come back, and a friend who taps that
   * link in the meantime is seated instead of being told the room does not exist. So:
   *
   *   - a missing room is opened by whoever arrives first, host or guest — a guest's copy simply
   *     waits with the crown's seat held open for the host;
   *   - a room whose board has already launched, or a code that is spent, is refused as
   *     `room_consumed` (the client says "this invite has already been used or expired");
   *   - a player returning to a seat they still hold is reattached, never turned away;
   *   - `host=1` reclaims the crown when it is empty or held by a dropped socket, and only a
   *     second *live* host on one code is refused (`room_exists`).
   */
  private joinLobby(ws: WebSocket, identity: Identity, code: string, host: boolean, tier: BotTier): void {
    if (this.maintenance) { this.rejectSocket(ws, 'MAINTENANCE'); return; }
    if (this.arenaLocked()) { this.rejectSocket(ws, 'MATCHING_LOCKED'); return; }
    this.sweepRetired();
    /* The code the socket said, in its one canonical spelling. `1909`, `#1909` and `room_1909` all
       land on the same key, so a link cannot address a room its host never minted. */
    const digits = readRoomCode(code);
    const key = lobbyKey(digits);
    const live = key ? this.lobbies.get(key) ?? null : null;
    if (!key) { this.rejectSocket(ws, 'room_not_found'); return; }
    /* A launched race whose seat this socket already owns is a reconnect, not an invite. The code
       is spent for strangers, but the player whose identity still holds a seat walks back into
       the exact board they left — until the reconnect grace expires and the machine takes it. */
    const running = this.launchedRoomByCode(key);
    if (running) { this.resumeLaunchedRoom(ws, identity, running); return; }
    if (live?.driver || (!live && this.retired.has(key))) {
      /* the match this code opened is under way, or its host is done with it */
      this.rejectSocket(ws, 'room_consumed');
      return;
    }
    let room = live;
    if (!room) {
      const format: LobbyFormat = 'duel';
      const size = FORMAT_CAPACITY[format];
      const now = Date.now();
      room = {
        room: createRoom({ code: digits, seats: size, waitMs: ROOM_WAIT_MS, botTier: tier, now }),
        size,
        counted: false,
        members: Array.from({ length: size }, () => null),
        matchId: '',
        seed: 0,
        startedAt: 0,
        driver: null,
        turnDeadlineMs: 0,
        hostSeat: 0,
        format,
        mode: FORMAT_MODE[format],
        teams: Array.from({ length: size }, (_, i) => defaultTeam(i)),
        code: true,
        lastSeenAt: now,
        /* a guest opened it: the crown waits for the host, not for the next arrival */
        hostPending: !host,
      };
      this.lobbies.set(key, room);
    }

    const pick = this.seatFor(room, identity, host);
    if (!pick.ok) { this.rejectSocket(ws, pick.reason); return; }
    const seat = pick.seat;

    /* The chair's previous socket, if any, is this same player's ghost: forget it before it can
       settle the seat the new socket is about to take. */
    if (pick.replaces && pick.replaces !== ws) {
      this.refs.delete(pick.replaces);
      try {
        pick.replaces.close(1000, 'replaced');
      } catch {
        /* the socket is already gone */
      }
    }

    room.members[seat] = {
      ws, seat, id: identity.player.id, name: identity.player.name,
      tiq: identity.tiq, tier: identity.tier, flag: identity.flag, avatar: identity.player.avatar,
      premium: identity.premium || this.vipActive(identity.player.id),
      connected: true, droppedAt: 0, busy: false, lastPingAt: 0,
    };
    room.room = seatHuman(room.room, seat, {
      kind: 'human', id: identity.player.id, name: identity.player.name,
    });
    if (host && seat === room.hostSeat) room.hostPending = false;
    room.lastSeenAt = Date.now();
    this.refs.set(ws, { live: room, seat });
    this.markActive(identity.player.id);

    this.watchRoomSocket(room, ws);

    this.broadcastLobby(room);
    /* A friend who walks in while the other chair is empty at the socket — but not in the room —
       gets a Telegram nudge. It is scheduled on the object's own ctx so the socket answer never
       waits for the Bot API round trip. */
    this.notifyAway(room, seat);
    this.rearm();
  }

  /**
   * The external nudge for a reserved, disconnected chair: `sendMessage` to the seated player who
   * is not here right now, with an inline keyboard that reopens this exact room.
   *
   * Only a real Telegram seat can be messaged, so a guest seat is skipped rather than guessed at.
   * The cooldown is per room *and* target, so one busy friend cannot turn a lobby into a stream of
   * pushes while still hearing about a genuinely new arrival half a minute later.
   */
  private notifyAway(live: LiveRoom, arrivalSeat: number): void {
    if (!live.code) return;
    const arrival = live.members[arrivalSeat];
    const token = this.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!arrival || !token) return;
    const now = Date.now();
    const link = botAppLink(`room_${live.room.code}`);
    for (const other of live.members) {
      if (!other || other.seat === arrivalSeat || other.connected) continue;
      const chatId = chatIdOf(other.id);
      if (!chatId) continue;
      const key = `${live.room.code}:${chatId}`;
      if (now - (this.notified.get(key) ?? 0) < NOTIFY_COOLDOWN_MS) continue;
      this.notified.set(key, now);
      const body = JSON.stringify({
        chat_id: chatId,
        text: `⚔️ ${arrival.name} is waiting for you in Lobby #${live.room.code}! Tap below to jump straight into the match!`,
        reply_markup: {
          inline_keyboard: [[{ text: `⚔️ Join Lobby #${live.room.code}`, url: link }]],
        },
      });
      const call = fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }).then(() => undefined).catch(() => undefined);
      /* The push must never hold the join frame hostage: a Bot API hiccup is not the lobby's. */
      const ctx = this.state as unknown as { waitUntil?: (p: Promise<unknown>) => void };
      if (ctx.waitUntil) ctx.waitUntil(call);
      else void call;
    }
    if (this.notified.size > 256) {
      for (const [key, at] of this.notified) {
        if (now - at >= NOTIFY_COOLDOWN_MS) this.notified.delete(key);
      }
    }
  }

  /**
   * Which seat this arrival takes. A returning player gets their own seat back — the same
   * Telegram id, sitting disconnected, is the app resuming, not a second person asking for the
   * same chair. A host takes the crown; a guest takes the first free well that is not the
   * crown's reserved one.
   */
  private seatFor(
    live: LiveRoom,
    identity: Identity,
    host: boolean,
  ): { ok: true; seat: number; replaces?: WebSocket } | { ok: false; reason: 'room_exists' | 'room_full' } {
    /* The same account, already seated: this is that player coming back — after a chat switch, a
       reload, or a socket the server has not noticed dying yet. The newest socket wins the chair,
       and the old one is closed, so a reconnect can never be answered with `room_full` or
       `room_exists` because of its own ghost. */
    const mine = live.members.findIndex((m) => !!m && m.id === identity.player.id);
    if (mine >= 0) {
      const held = live.members[mine];
      return { ok: true, seat: mine, replaces: held?.ws };
    }

    if (host) {
      const crown = live.members[live.hostSeat];
      /* a live host on this code is somebody else's room: two crowns would fight over the format */
      if (crown && crown.connected) return { ok: false, reason: 'room_exists' };
      /* a dropped crown that belonged to another account is still that account's chair */
      if (crown && crown.id !== identity.player.id) return { ok: false, reason: 'room_exists' };
      return { ok: true, seat: live.hostSeat };
    }

    const free = this.freeSeat(live);
    return free >= 0 ? { ok: true, seat: free } : { ok: false, reason: 'room_full' };
  }

  /** Wire one socket into a room's frame path. Used at seat time and again on every resume. */
  private watchRoomSocket(live: LiveRoom, ws: WebSocket): void {
    ws.addEventListener('message', (ev: MessageEvent) => {
      const ref = this.refs.get(ws);
      if (!ref) return;
      const board = ref.live.driver
        ? ref.live.driver.state
        : dimsFor(contendersIn(sizesOf(ref.live.room)));
      const msg = readMessage(ev.data, ref.seat, board.cols, board.rows);
      if (msg) this.roomFrame(ref, msg);
    });
    ws.addEventListener('close', () => this.roomLeave(this.refs.get(ws), ws));
    ws.addEventListener('error', () => this.roomLeave(this.refs.get(ws), ws));
  }

  /** The live race behind a spent code, if one is still running. */
  private launchedRoomByCode(key: string): LiveRoom | null {
    for (const live of this.rooms.values()) {
      if (live.code && live.driver && lobbyKey(live.room.code) === key) return live;
    }
    return null;
  }

  /**
   * Rebind a returning seat to its new socket. The identity check is the gate: only a player the
   * room already seated may walk into a launched board, so the spent code stays spent for
   * everybody else. The authoritative state travels with the acknowledgement, which is what makes
   * a phone that missed a few relays land back on the exact board everyone else is playing.
   */
  private resumeLaunchedRoom(ws: WebSocket, identity: Identity, live: LiveRoom): void {
    const seat = live.members.findIndex((m) => !!m && m.id === identity.player.id);
    if (seat < 0) { this.rejectSocket(ws, 'room_consumed'); return; }
    const member = live.members[seat];
    if (!member) { this.rejectSocket(ws, 'room_consumed'); return; }
    /* The chair's previous socket, if it is still around, is this same player's ghost. Forget it
       before its close handler can settle the seat the new socket is about to hold. */
    if (member.ws !== ws) {
      this.refs.delete(member.ws);
      try {
        member.ws.close(1000, 'replaced');
      } catch {
        /* the socket is already gone */
      }
    }
    member.ws = ws;
    member.connected = true;
    member.droppedAt = 0;
    member.lastPingAt = 0;
    live.lastSeenAt = Date.now();
    this.refs.set(ws, { live, seat });
    live.driver?.resume(seat);
    this.watchRoomSocket(live, ws);
    this.markActive(identity.player.id, this.roomModeOf(live));
    /* The rival sees the seat come back before the board snapshot, so the pill can go quiet on
       the same beat the first post-reconnect frame lands. */
    this.broadcastPeerStatus(live, seat, 'online');
    this.postTo(ws, this.roomFoundMessage(live, seat));
    this.postTo(ws, this.roomSyncMessage(live));
    this.rearm();
  }

  /** The authoritative board, plus the active seat's remaining wall-clock turn. */
  private roomSyncMessage(live: LiveRoom): string {
    return JSON.stringify({
      type: 'ROOM_SYNC',
      matchId: live.matchId,
      state: live.driver?.state ?? null,
      turnDeadlineMs: live.turnDeadlineMs,
      turnLeftMs: live.turnDeadlineMs > 0 ? Math.max(0, live.turnDeadlineMs - Date.now()) : 0,
    });
  }

  /** Tell every still-connected seat that one chair changed socket state. */
  private broadcastPeerStatus(
    live: LiveRoom,
    seat: number,
    status: 'reconnecting' | 'online',
    graceMs = 0,
  ): void {
    const frame = JSON.stringify({ type: 'PEER_STATUS', seat, status, graceMs });
    for (const m of live.members) {
      if (m && m.connected) this.postTo(m.ws, frame);
    }
  }

  /**
   * One `LOBBY` frame, per seat: the roster, the crown, the format, and which seat is yours.
   *
   * Every seat carries its `avatar` — the signed `user.photo_url` it authenticated with, or `''`.
   * It is relayed from the member record rather than from anything a socket said, so a seat can
   * only ever show the face its own Telegram account signed for. The client treats a missing or
   * refused URL as a monogram, which is why `''` is a complete answer rather than an omission.
   */
  private lobbyMessage(live: LiveRoom, seat: number): string {
    const seats: unknown[] = [];
    for (let i = 0; i < live.members.length; i++) {
      const m = live.members[i];
      if (!m) continue;
      seats.push({
        side: i,
        id: m.id,
        name: m.name,
        avatar: m.avatar,
        flag: m.flag,
        host: i === live.hostSeat,
        isHost: i === live.hostSeat,
        bot: false,
        team: live.teams[i] ?? 0,
        /* A seat held for a socket that is not here: the roster shows it as away, not as gone.
           `online` is the contract; `connected` stays for clients that learned the older name. */
        online: m.connected,
        connected: m.connected,
        busy: m.busy,
      });
    }
    return JSON.stringify({
      type: 'LOBBY',
      /* `code` is the four digits every invite prints; `roomId` is the canonical id this object
         keys the room by. They name the same room, and a client may use either. */
      code: live.room.code,
      roomId: lobbyKey(live.room.code),
      host: live.hostSeat,
      format: live.format,
      mode: live.mode,
      you: seat,
      capacity: live.size,
      /* A guest who landed first owns the room without owning the crown: the host's plate is
         reserved, not offered to the next arrival. */
      pendingHost: live.hostPending && !live.members[live.hostSeat],
      seats,
    });
  }

  /** Tell every seat what the room now looks like. The one write path for lobby state. */
  private broadcastLobby(live: LiveRoom): void {
    for (const m of live.members) {
      if (m && m.connected) this.postTo(m.ws, this.lobbyMessage(live, m.seat));
    }
    this.persistLobbies();
  }

  /**
   * A seat left a lobby that has not launched. The crown migrates to the lowest seat still held —
   * a room whose host walked out is still somebody's room — and the last person out closes it.
   */
  private lobbyDepart(live: LiveRoom, seat: number): void {
    if (!live.members.some((m) => m !== null)) {
      this.lobbies.delete(lobbyKey(live.room.code));
      this.retire(live.room.code);
      this.rearm();
      return;
    }
    if (live.hostSeat === seat) {
      const next = live.members.findIndex((m) => m !== null);
      if (next >= 0) live.hostSeat = next;
      live.hostPending = false;
    }
    this.broadcastLobby(live);
    this.rearm();
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

  /**
   * A lobby seat walked out on purpose (`LEAVE`, or a legacy `CANCEL`): let the socket go, free
   * the chair, then settle the room. A host's exit disbands the code for everybody; a guest's
   * only gives their own seat back.
   */
  private leaveLobby(ref: RoomRef, disband = false): void {
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
      /* the room's own model has to let the chair go too, or the next arrival finds it taken */
      live.room = unseat(live.room, ref.seat);
    }
    /* only a code lobby has a code to spend: an auto-pair room has no invite to revoke */
    if (disband && live.code && ref.seat === live.hostSeat) { this.disbandLobby(live); return; }
    this.lobbyDepart(live, ref.seat);
  }

  /**
   * The host is done with the room: the code is spent, every guest is told why, and the sockets
   * are let go. From here on the invite link answers `room_consumed`, which is the cleanest thing
   * a stale link can be told — it is not a room any more, and it is never coming back.
   */
  private disbandLobby(live: LiveRoom): void {
    const code = live.room.code;
    this.lobbies.delete(lobbyKey(code));
    this.retire(code);
    for (const m of live.members) {
      if (!m) continue;
      this.refs.delete(m.ws);
      this.postTo(m.ws, JSON.stringify({ type: 'ERROR', reason: 'room_closed' }));
      try {
        m.ws.close(1000, 'disbanded');
      } catch {
        /* the socket is already gone */
      }
    }
    live.members = live.members.map(() => null);
    this.rearm();
  }

  /** A code is spent: remember it for a while so a link that carries it is answered, not revived. */
  private retire(code: string): void {
    const key = lobbyKey(code);
    if (!key) return;
    this.retired.set(key, Date.now());
    /* A reused code is a different room: its push cooldown must not remember this one. */
    const digits = key.slice('room_'.length);
    for (const notified of this.notified.keys()) {
      if (notified.startsWith(`${digits}:`)) this.notified.delete(notified);
    }
    this.sweepRetired();
    this.persistLobbies();
  }

  private sweepRetired(): void {
    const now = Date.now();
    for (const [code, at] of this.retired) if (now - at >= RETIRED_TTL_MS) this.retired.delete(code);
  }

  /**
   * The idle clock. A dropped guest's seat is held for `ROOM_SEAT_HOLD_MS` and then goes back on
   * the market; a lobby nobody is connected to is retired after `ROOM_IDLE_TTL_MS`, which is the
   * ten minutes a host gets for sharing the invite in another app.
   */
  private sweepLobbies(now: number): void {
    let touched = false;
    for (const live of [...this.lobbies.values()]) {
      if (live.driver) continue;
      let changed = false;
      for (let i = 0; i < live.members.length; i++) {
        const m = live.members[i];
        if (!m) continue;
        /* A socket that stopped answering its heartbeat is gone even if the close frame never
           came: mark the seat away the moment its silence proves it, so the other side is never
           left looking at a phantom player. */
        if (m.connected && m.lastPingAt > 0 && now - m.lastPingAt >= SEAT_SILENCE_MS) {
          m.connected = false;
          m.droppedAt = now;
          changed = true;
          continue;
        }
        if (m.connected || i === live.hostSeat) continue;
        if (now - m.droppedAt < ROOM_SEAT_HOLD_MS) continue;
        /* A chair whose socket is still registered was only marked quiet, not closed: its player
           may walk back in with the very next frame, so the seat is not put back on the market. */
        const ref = this.refs.get(m.ws);
        if (ref && ref.live === live && ref.seat === i) continue;
        live.members[i] = null;
        live.room = unseat(live.room, i);
        changed = true;
      }
      const held = live.members.some((m) => !!m && m.connected);
      if (!held && now - live.lastSeenAt >= ROOM_IDLE_TTL_MS) {
        this.lobbies.delete(lobbyKey(live.room.code));
        this.retire(live.room.code);
        continue;
      }
      /* A room somebody is still sitting in is not idle: move its clock so the next alarm cannot
         fire on an already-expired instant while the lobby is plainly alive. */
      if (held) { live.lastSeenAt = now; touched = true; }
      if (changed) this.broadcastLobby(live);
    }
    if (touched) this.persistLobbies();
  }

  /* ---------- the durable lobby ---------- */

  /**
   * Write the friends lobbies to `room_state`, so a Durable Object that is evicted while its host
   * is sharing the link comes back with the same rooms, the same seats and the same spent codes.
   * Only code lobbies live here: the auto-pair rooms are a matchmaking detail with no invite that
   * could outlive the object, and a launched board is owned by its sockets.
   */
  private persistLobbies(): void {
    const storage = this.state?.storage;
    if (!storage) return;
    const state: StoredLobbyState = {
      rooms: [...this.lobbies.values()].filter((live) => !live.driver).map((live) => ({
        code: live.room.code,
        size: live.size,
        format: live.format,
        teams: live.teams.slice(0, live.size),
        hostSeat: live.hostSeat,
        hostPending: live.hostPending,
        openedAt: live.room.openedAt,
        waitMs: live.room.waitMs,
        botTier: live.room.botTier,
        lastSeenAt: live.lastSeenAt,
        members: live.members.flatMap((m, seat) => (m ? [{
          seat,
          id: m.id,
          name: m.name,
          tiq: m.tiq,
          tier: m.tier,
          flag: m.flag,
          avatar: m.avatar,
          premium: m.premium,
          busy: m.busy,
          droppedAt: m.connected ? 0 : m.droppedAt,
        }] : [])),
      })),
      retired: [...this.retired],
    };
    try {
      const write = storage.put(ROOM_STATE_KEY, state);
      if (write && typeof (write as Promise<void>).catch === 'function') {
        (write as Promise<void>).catch(() => undefined);
      }
    } catch {
      /* a store that refuses the write: the live map is still this instance's authority */
    }
  }

  /**
   * Put the stored lobbies back. Every seat comes back disconnected — its player's socket died
   * with the old instance — and the crown stays exactly where it was. A room past its idle TTL is
   * not revived; its code is retired instead, so the link is answered rather than resurrected.
   */
  private restoreLobbies(raw: unknown): void {
    const stored = raw as Partial<StoredLobbyState> | null;
    if (!stored || typeof stored !== 'object') return;
    const now = Date.now();
    if (Array.isArray(stored.retired)) {
      for (const row of stored.retired) {
        if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'number') continue;
        const key = lobbyKey(row[0]);
        if (!key || now - row[1] >= RETIRED_TTL_MS) continue;
        this.retired.set(key, row[1]);
      }
    }
    if (!Array.isArray(stored.rooms)) return;
    for (const item of stored.rooms) {
      const row = item as Partial<StoredLobby> | null;
      if (!row || typeof row !== 'object') continue;
      const code = readRoomCode(typeof row.code === 'string' ? row.code : '');
      const key = lobbyKey(code);
      const format = isLobbyFormat(row.format) ? row.format : 'duel';
      const size = FORMAT_CAPACITY[format];
      const lastSeenAt = Number(row.lastSeenAt);
      if (!code || !key || this.lobbies.has(key) || !Number.isFinite(lastSeenAt)) continue;
      if (now - lastSeenAt >= ROOM_IDLE_TTL_MS) {
        /* the room is past its idle TTL: its code is spent from now, not from the last frame,
           so a link that still carries it is answered instead of resurrected */
        this.retired.set(key, now);
        continue;
      }
      const openedAt = Number.isFinite(row.openedAt) ? Number(row.openedAt) : lastSeenAt;
      const waitMs = Number.isFinite(row.waitMs) ? Number(row.waitMs) : ROOM_WAIT_MS;
      const botTier: BotTier = row.botTier === 'easy' || row.botTier === 'normal' || row.botTier === 'hard'
        ? row.botTier : 'mixed';
      let room = createRoom({ code, seats: size, waitMs, botTier, now: openedAt });
      const members: (RoomMember | null)[] = Array.from({ length: size }, () => null);
      const seatRows = Array.isArray(row.members) ? row.members : [];
      for (const seatRow of seatRows) {
        const m = seatRow as Partial<StoredMember> | null;
        if (!m || typeof m !== 'object') continue;
        const seat = Number(m.seat);
        if (!Number.isInteger(seat) || seat < 0 || seat >= size || members[seat]) continue;
        if (typeof m.id !== 'string' || !m.id || typeof m.name !== 'string' || !m.name) continue;
        members[seat] = {
          ws: parkedSocket(),
          seat,
          id: m.id,
          name: m.name,
          tiq: typeof m.tiq === 'number' ? m.tiq : 0,
          tier: m.tier === 'tactician' || m.tier === 'strategist' || m.tier === 'grandmaster'
            ? m.tier : 'rookie',
          flag: typeof m.flag === 'string' ? m.flag : '',
          avatar: typeof m.avatar === 'string' ? m.avatar : '',
          premium: m.premium === true,
          connected: false,
          droppedAt: typeof m.droppedAt === 'number' && m.droppedAt > 0 ? m.droppedAt : now,
          /* Entering a friends lobby is always ready/idle: a seat that was merely away must not
             hold the whole room's Start behind a stale busy flag. */
          busy: false,
          lastPingAt: 0,
        };
        room = seatHuman(room, seat, { kind: 'human', id: m.id, name: m.name });
      }
      if (!members.some((m) => m !== null)) continue;
      const hostSeat = Number.isInteger(row.hostSeat) && (row.hostSeat as number) >= 0 && (row.hostSeat as number) < size
        ? row.hostSeat as number : 0;
      const teams = Array.isArray(row.teams) && row.teams.length === size
        ? row.teams.map((team) => (team === 1 ? 1 : 0))
        : Array.from({ length: size }, (_, i) => defaultTeam(i));
      this.lobbies.set(key, {
        room,
        size,
        counted: false,
        members,
        matchId: '',
        seed: 0,
        startedAt: 0,
        driver: null,
        turnDeadlineMs: 0,
        hostSeat,
        format,
        mode: FORMAT_MODE[format],
        teams,
        code: true,
        lastSeenAt,
        hostPending: row.hostPending === true && !members[hostSeat],
      });
    }
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

  /** The lowest seat nobody is holding. The crown's seat is not free while it is being held open. */
  private freeSeat(live: LiveRoom): number {
    return live.members.findIndex((m, i) => m === null
      && !(live.code && live.hostPending && i === live.hostSeat));
  }

  /** A room's 4-digit invite code, minted from the pairing counter so two rooms never collide. */
  private mintRoomCode(): string {
    return String(1000 + ((++this.paired * 7919) % 9000));
  }

  /**
   * Start (or clear) the active seat's clock. Called after launch, after every accepted move, and
   * after every machine batch; a settled board or a machine turn has no deadline of its own.
   */
  private armRoomTurn(live: LiveRoom): void {
    const driver = live.driver;
    live.turnDeadlineMs = driver && driver.state.winner === null && !driver.botTurn
      ? Date.now() + TURN_LIMIT_MS
      : 0;
  }

  /**
   * The alarm's room clock: one human seat past its limit plus the network grace is played for,
   * so a stalled tab or a dropped phone can never freeze the race. The fallback is the board's
   * own auto-move, with a pass as the last resort; either way the turn advances and the machine
   * seats behind it are played in the same batch.
   */
  private enforceRoomTurn(live: LiveRoom, now: number): void {
    const driver = live.driver;
    if (!driver) return;
    if (driver.state.winner !== null) { live.turnDeadlineMs = 0; return; }
    if (driver.botTurn) {
      const before = driver.state;
      this.pushRoomEvents(live, driver.runBots());
      this.countBoard(before, driver.state);
      this.armRoomTurn(live);
      if (driver.state.winner !== null) {
        live.turnDeadlineMs = 0;
        this.finishRoom(live, driver.state.winner);
        this.rooms.delete(live.matchId);
      }
      return;
    }
    if (!live.turnDeadlineMs || now < live.turnDeadlineMs + TURN_GRACE_MS) return;
    const seat = driver.state.turn;
    const action = this.roomFallbackAction(driver.state, seat);
    const before = driver.state;
    const result = driver.submit(seat, action);
    if (!result.ok) return;
    this.countBoard(before, driver.state);
    this.pushRoomEvents(live, result.events, seat);
    this.armRoomTurn(live);
    if (driver.state.winner !== null) {
      live.turnDeadlineMs = 0;
      this.finishRoom(live, driver.state.winner);
      this.rooms.delete(live.matchId);
    }
  }

  /** A legal action for a seat whose clock ran out: the first step the board accepts, then a pass. */
  private roomFallbackAction(state: GameState, seat: number): Action {
    const legal = this.legalSteps(state, seat);
    if (legal.length) return { kind: 'move', ball: legal[0].ball, to: legal[0].to };
    return { kind: 'pass' };
  }

  /** The engine's steps for a seat, narrowed to actions this exact board accepts. */
  private legalSteps(state: GameState, seat: number): Array<{ ball: number; to: { c: number; r: number } }> {
    const out: Array<{ ball: number; to: { c: number; r: number } }> = [];
    for (const st of steps(state, seat)) {
      if (apply(state, { kind: 'move', ball: st.ball, to: st.to })) out.push({ ball: st.ball, to: st.to });
    }
    return out;
  }

  /** The raced rooms' own clocks: turn deadlines, then the reconnect grace on every dropped seat. */
  private sweepRacedRooms(now: number): void {
    for (const live of [...this.rooms.values()]) {
      if (!live.driver) continue;
      /* A socket that stopped answering its heartbeat is gone even if no close frame ever came:
         a killed webview or a mobile link that went quiet behind a proxy. Marking it away here is
         what starts the same grace a real close would — the rival must not wait forever. */
      for (let i = 0; i < live.members.length; i++) {
        const m = live.members[i];
        if (!m || !m.connected) continue;
        if (m.lastPingAt > 0 && now - m.lastPingAt >= SEAT_SILENCE_MS) {
          m.connected = false;
          m.droppedAt = now;
          this.broadcastPeerStatus(live, i, 'reconnecting', RECONNECT_GRACE_MS);
        }
      }
      this.enforceRoomTurn(live, now);
      for (let i = 0; i < live.members.length; i++) {
        const m = live.members[i];
        if (!m || m.connected) continue;
        if (m.droppedAt <= 0 || now - m.droppedAt < RECONNECT_GRACE_MS) continue;
        /* the grace is over: the machine finishes the seat and the drop is recorded */
        this.takeSeatOver({ live, seat: i });
      }
    }
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
    /* A code lobby has two clocks: the idle TTL that retires it, and the shorter hold that frees
       a dropped guest's chair. Both are alarms, because a Durable Object can be evicted between
       messages and a `setTimeout` would die with the instance. */
    for (const live of this.lobbies.values()) {
      if (live.driver) continue;
      soonest = Math.min(soonest, live.lastSeenAt + ROOM_IDLE_TTL_MS);
      for (let i = 0; i < live.members.length; i++) {
        const m = live.members[i];
        if (!m) continue;
        /* A seat answering the heartbeat still owes the next one: the alarm is what turns its
           silence into an away badge on the other side. */
        if (m.connected && m.lastPingAt > 0) {
          soonest = Math.min(soonest, m.lastPingAt + SEAT_SILENCE_MS);
        }
        if (!m.connected && i !== live.hostSeat) {
          soonest = Math.min(soonest, m.droppedAt + ROOM_SEAT_HOLD_MS);
        }
      }
    }
    if (this.arena.status === 'active') soonest = Math.min(soonest, this.arena.endsAt);
    /* A pending relic challenge is a clock too: the alarm is what turns 25 seconds of silence
       into CHALLENGE_EXPIRED, and it must survive eviction like every other wait. */
    for (const challenge of this.relicChallenges.values()) {
      if (challenge.status === 'pending') soonest = Math.min(soonest, challenge.expiresAt);
    }
    /* A launched room has two clocks of its own: the active seat's turn deadline (plus the
       network grace) and every dropped seat's reconnect window. Both must survive eviction, so
       both live on the alarm rather than on a `setTimeout`. */
    for (const live of this.rooms.values()) {
      if (!live.driver) continue;
      if (live.driver.state.winner === null && live.turnDeadlineMs > 0 && !live.driver.botTurn) {
        soonest = Math.min(soonest, live.turnDeadlineMs + TURN_GRACE_MS);
      }
      for (const m of live.members) {
        if (!m) continue;
        if (m.connected && m.lastPingAt > 0) {
          soonest = Math.min(soonest, m.lastPingAt + SEAT_SILENCE_MS);
        }
        if (!m.connected && m.droppedAt > 0) {
          soonest = Math.min(soonest, m.droppedAt + RECONNECT_GRACE_MS);
        }
      }
    }
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
    /* A chair held for a socket that is not here is the machine's for the race: a human seat
       nobody is sitting in would stall the board waiting for a turn that never comes. */
    for (let i = 0; i < live.members.length; i++) {
      const m = live.members[i];
      if (m && !m.connected) live.room = takeover(live.room, i);
    }
    live.room = launch(backfill(live.room));
    live.seed = hash(`${live.room.code}|${live.members.map((m) => m?.id ?? 'bot').join('|')}|${this.paired}`);
    live.matchId = `r${hash(`${live.room.code}|${++this.paired}`).toString(36)}`;
    live.startedAt = Date.now();
    live.driver = createRoomDriver(live.room);
    this.openRooms = this.openRooms.filter((r) => r !== live);
    this.lobbies.delete(lobbyKey(live.room.code));
    /* the code did its job: the board is running, so the invite is spent from this moment on */
    if (live.code) this.retire(live.room.code);
    this.rooms.set(live.matchId, live);
    this.armRoomTurn(live);
    this.rearm();

    for (const m of live.members) {
      if (!m) continue;
      if (!m.connected) continue;                // a chair held for an absent socket gets no board
      this.setInMatch(m.id, true);
      this.postTo(m.ws, this.roomFoundMessage(live, m.seat));
    }
    /* Seat 0 is the host, so a person normally opens — but a takeover or an odd roster can put the
       machine on turn before anybody has moved, and the room must not wait for a human to start it. */
    const opening = live.driver.state;
    this.pushRoomEvents(live, live.driver.runBots());
    this.countBoard(opening, live.driver.state);
    this.armRoomTurn(live);
    this.rearm();
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
      turnDeadlineMs: live.turnDeadlineMs,
      turnLeftMs: live.turnDeadlineMs > 0 ? Math.max(0, live.turnDeadlineMs - Date.now()) : 0,
      seats: roster.seats.map((s, i) => ({
        side: i,
        id: s.id || `seat:${i}`,
        name: s.name,
        bot: isAutomated(roster, i),
        team: live.teams[i] ?? 0,
        difficulty: difficultyFor(roster, i),
        /* the seat's entitlement, as the room judged it — bots and empty chairs are never VIP */
        vip: !!live.members[i] && (live.members[i]!.premium || this.vipActive(live.members[i]!.id)),
      })),
    });
  }

  /** A frame from a seat in a room: the host's early start, a move, or a resignation. */
  private roomFrame(ref: RoomRef, msg: ClientMessage): void {
    const live = ref.live;
    const member = live.members[ref.seat];
    if (member) this.markActive(member.id, live.driver ? this.roomModeOf(live) : undefined);
    /* The seat may have been marked away by the heartbeat sweep while its webview was merely
       throttled in the background. Any frame proves the socket is still here, so the player is
       back in the chair before the frame is handled — no reconnect, no lost seat. */
    if (member && !member.connected) {
      member.connected = true;
      member.droppedAt = 0;
      live.lastSeenAt = Date.now();
      /* Any frame proves the heartbeat is flowing again: without this a revived seat would be
         marked away by the very next sweep on its old ping timestamp. */
      if (member.lastPingAt > 0) member.lastPingAt = Date.now();
      if (live.driver) {
        /* The heartbeat sweep had called this seat away; the frame proves it is here. Tell the
           rival the pill can go, and hand the seat the board it missed while it was marked away. */
        this.broadcastPeerStatus(live, ref.seat, 'online');
        this.postTo(member.ws, this.roomSyncMessage(live));
      } else {
        this.broadcastLobby(live);
      }
    }
    if (msg.type === 'PING') {
      /* A seat that is still there is worth answering: the `PONG` is how the client tells a
         sleeping webview from a live room, and it keeps every hop between us from idling out. */
      if (member) {
        member.lastPingAt = Date.now();
        this.postTo(member.ws, JSON.stringify({ type: 'PONG' }));
      }
      return;
    }
    if (msg.type === 'POST_MATCH_CHAT') {
      /* only a settled room has a lane; a live board ignores the frame like any other chat */
      if (member) this.relayPostChat(member.ws, msg);
      return;
    }
    if (msg.type === 'SYNC_REQ') {
      /* A seat that suspects drift asks for the board; the answer is the same authoritative
         snapshot a reconnect receives, so one repair path serves both. */
      if (member && live.driver) this.postTo(member.ws, this.roomSyncMessage(live));
      return;
    }
    if (!live.driver) {
      /* Before the launch the only vocabulary a lobby has is the host's start and size pick, and
         a seat's own team move. Any seat may leave at any time. */
      if (msg.type === 'CANCEL' || msg.type === 'LEAVE') { this.leaveLobby(ref, true); return; }
      if (msg.type === 'BUSY') {
        if (member) member.busy = msg.busy;
        this.broadcastLobby(live);
        return;
      }
      if (msg.type === 'ROOM_START') {
        if (ref.seat !== live.hostSeat) return;
        /* A friends room launches the moment two people are actually at their sockets. A stale
           `busy` flag must never freeze the host's Start: being seated in this lobby is the whole
           of "ready", and the server is the one that decides who is here. */
        const online = live.members.filter((m) => !!m && m.connected).length;
        const seated = live.members.filter((m) => !!m).length;
        if (live.code) {
          for (const m of live.members) if (m) m.busy = false;
        }
        if (!live.code || online >= 2) { this.launchRoom(live); return; }
        /* Say why nothing happened, then repaint: a silent refusal is the frozen Start button. */
        const reason = seated >= 2 ? 'player_offline' : 'waiting_for_players';
        if (member) this.postTo(member.ws, JSON.stringify({ type: 'START_FAILED', reason }));
        this.broadcastLobby(live);
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
      if (member) {
        /* A refusal means the two replicas disagreed about the turn (a queued move that crossed a
           server timeout, a stale optimistic board). The snapshot is the repair, not the toast:
           without it the client would keep a board nobody else is playing. */
        this.postTo(member.ws, JSON.stringify({
          type: 'REJECT',
          reason: result.reason,
          state: live.driver.state,
          turnDeadlineMs: live.turnDeadlineMs,
          turnLeftMs: live.turnDeadlineMs > 0 ? Math.max(0, live.turnDeadlineMs - Date.now()) : 0,
        }));
      }
      return;
    }
    this.countBoard(before, live.driver.state);
    this.pushRoomEvents(live, result.events);
    this.armRoomTurn(live);
    this.rearm();
    if (live.driver.state.winner !== null) {
      live.turnDeadlineMs = 0;
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
    const humans: RoomMember[] = [];
    for (let i = 0; i < live.members.length; i++) {
      const m = live.members[i];
      /* a chair held for an absent socket was the machine's race, not that player's */
      if (m && m.connected) {
        this.verdict(m.id, i === winner);
        humans.push(m);
      }
    }
    /* Every human still at the capsule gets the lane: a party's reactions reach all of them. */
    if (humans.length > 1) {
      this.armPostMatch(humans.map((m) => ({ ws: m.ws, side: m.seat, premium: m.premium, id: m.id })));
    }
    /* A code lobby is an arrangement between friends, not random matchmaking: it earns no Stars. */
    if (!live.code) this.observeVaultMatch(this.vaultRoomSeats(live, winner), live.startedAt, true);
  }

  /**
   * Hand every event to every human seat except the one that played it — that seat applied its own
   * action locally before it ever reached the wire. The machine's turns are in the same batch, so a
   * room of one person and three bots needs no second round trip to keep moving.
   */
  private pushRoomEvents(live: LiveRoom, events: readonly RoomEvent[], includeSeat = -1): void {
    if (!events.length) return;
    for (const m of live.members) {
      if (!m || !m.connected) continue;
      for (const ev of events) {
        /* The seat that played a move applied it locally already — except an event the server
           played FOR it (a turn-deadline fallback), which that seat has to receive too. */
        if (ev.seat === m.seat && ev.seat !== includeSeat) continue;
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
      /* a seat walking out of a settled board also closes the banter lane */
      this.dropPostChat(member.ws, true);
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
    this.armRoomTurn(live);
    if (driver.state.winner !== null) {
      live.turnDeadlineMs = 0;
      this.completeRoom(live);
      /* The machine finished the board after a resignation: the survivor still played a real
         match, so the vault hears about it here too, not only through `finishRoom`. */
      if (!live.code) {
        this.observeVaultMatch(this.vaultRoomSeats(live, driver.state.winner), live.startedAt, true);
      }
      this.rooms.delete(live.matchId);
    }
    this.rearm();
  }

  /**
   * A live seat's socket went away. The chair is *held* for the reconnect grace window instead of
   * being handed to the machine on the spot: a phone changing networks is not a resignation. The
   * room keeps the code, the identity and the board, and the rival is told exactly how long the
   * hold lasts; only an expiry in `sweepRacedRooms` converts the seat.
   */
  private roomDrop(ref: RoomRef, member: RoomMember, ws?: WebSocket): void {
    /* A close frame from a socket the seat no longer wears is a ghost: the player already
       reconnected on a newer socket and this one must not mark them away. */
    if (ws && member.ws !== ws) return;
    const wasConnected = member.connected;
    this.refs.delete(member.ws);
    if (wasConnected) {
      member.connected = false;
      member.droppedAt = Date.now();
    }
    ref.live.lastSeenAt = Date.now();
    if (wasConnected) {
      this.broadcastPeerStatus(ref.live, ref.seat, 'reconnecting', RECONNECT_GRACE_MS);
    }
    this.rearm();
  }

  /** A socket went away. In a live race it opens the reconnect window; in the queue, goodbye. */
  private roomLeave(ref: RoomRef | undefined, ws?: WebSocket): void {
    if (!ref) return;
    const live = ref.live;
    const member = live.members[ref.seat];
    if (member) this.markActive(member.id, live.driver ? this.roomModeOf(live) : undefined);
    if (live.driver) {
      if (member) this.roomDrop(ref, member, ws);
      return;
    }
    if (!member) return;
    if (ws && member.ws !== ws) return;
    this.refs.delete(member.ws);
    if (live.code) {
      /* The room outlives its socket. The chair is held — the crown for the whole idle TTL, a
         guest for the shorter hold — so the host who stepped into Telegram, or the friend whose
         webview slept through a chat switch, walks back into the same seat. The alarm retires
         the room if nobody ever does. */
      member.connected = false;
      member.droppedAt = Date.now();
      live.lastSeenAt = Date.now();
      this.broadcastLobby(live);
      this.rearm();
      return;
    }
    live.members[ref.seat] = null;
    if (live.members.every((m) => m === null)) {
      this.openRooms = this.openRooms.filter((r) => r !== live);
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

  /**
   * Open the post-match lane for the seats whose board has settled. Only a natural finish or a
   * resignation reaches here — an operator abort has no result capsule worth filling — and every
   * socket is still live, so any seat may react while the others are still reading the verdict.
   */
  private armPostMatch(
    members: ReadonlyArray<{ ws: WebSocket; side: number; premium: boolean; id: string }>,
  ): void {
    const at = Date.now();
    for (const member of members) {
      const peers = members.filter((m) => m.ws !== member.ws).map((m) => m.ws);
      this.postChat.set(member.ws, {
        peers, side: member.side, at, lastAt: 0, id: member.id, premium: member.premium,
      });
    }
  }

  /**
   * Relay one settled-board line to every other seat in the lane, if it is still open.
   *
   * This is the gate the whole VIP layer rests on, and it is deliberately the last word rather
   * than the client's: a `preset` is resolved out of the closed table here, so the text that
   * reaches a rival is one we chose; a custom `text` only crosses when the SENDER's seat carries a
   * verified entitlement. A free seat that hand-rolls a frame is not refused with an error — it is
   * folded back onto the canned vocabulary when the line happens to be one of ours, and dropped
   * otherwise, which is exactly what a client that never shipped the gate would send anyway.
   */
  private relayPostChat(from: WebSocket, msg: { text?: string; preset?: string }): void {
    const box = this.postChat.get(from);
    if (!box) return;
    const now = Date.now();
    if (now - box.at > POST_CHAT_TTL_MS) {
      this.dropPostChat(from, false);
      return;
    }
    /* the composer already throttles at 2s; this floor only stops a hand-rolled flood */
    if (now - box.lastAt < 250) return;

    /* The receipt may have landed while the result card was open: the record is the authority,
       so a seat that bought VIP after the board settled can still fire the draft it kept. */
    const entitled = box.premium || this.vipActive(box.id);
    let line: { preset: PostChatPresetId } | { text: string };
    if (isPostChatPreset(msg.preset)) {
      line = { preset: msg.preset };
    } else {
      const text = readPostChatText(msg.text);
      if (!text) return;
      if (entitled) {
        line = { text };
      } else {
        /* No entitlement: the line survives only if it is something we already own — one of the
           closed quick-chat lines, or one of the five free faces a shipped client may still send
           (a bare pictograph says nothing a seat has to be trusted with). Anything else is a
           custom line, and a custom line is the thing VIP buys. */
        const asPreset = postChatPresetForText(text);
        if (asPreset) line = { preset: asPreset };
        else if (isPostChatFreeReaction(text)) line = { text };
        else return;
      }
    }

    box.lastAt = now;
    /* only a custom line can be gold: a canned tile is the same four words whoever sends it */
    const vip = 'text' in line ? entitled : false;
    const frame = JSON.stringify({
      type: 'POST_MATCH_CHAT', side: box.side, vip, ...line,
    });
    for (const peer of box.peers) this.postTo(peer, frame);
  }

  /**
   * A lane is closing: the socket left the result (menu, rematch, a killed tab) or its lease ran
   * out. Every remaining seat is told so its rematch key and reaction tray can go quiet instead of
   * talking into an empty room; the leaver is removed from each peer's own list, and a peer with
   * nobody left loses its entry too.
   */
  private dropPostChat(ws: WebSocket, notify: boolean): void {
    const box = this.postChat.get(ws);
    if (!box) return;
    this.postChat.delete(ws);
    for (const peerWs of box.peers) {
      const peer = this.postChat.get(peerWs);
      if (!peer) continue;
      peer.peers = peer.peers.filter((p) => p !== ws);
      if (notify) this.postTo(peerWs, JSON.stringify({ type: 'OPPONENT_LEFT', side: box.side }));
      if (!peer.peers.length) this.postChat.delete(peerWs);
    }
  }

  /** A frame from a player who is already racing: judged by the room, then handed to the rival. */
  private relay(seat: Waiter, msg: ClientMessage): void {
    const race = seat.race;
    if (msg.type === 'PING') {
      this.deliver(seat, JSON.stringify({ type: 'PONG' }));
      return;
    }
    if (!race || race.over) return;

    this.markActive(seat.id, race.mode);
    if (msg.type === 'RESIGN') {
      this.endRace(race, seat.side, 'RESIGN');
      /* the resignation is a verdict too: both capsules are up, so the lane opens for as long as
         the leaver keeps their socket around */
      this.armPostMatch(race.seats.map((s) => ({ ws: s.ws, side: s.side, premium: s.premium, id: s.id })));
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
       stops being a race rather than guessing what the loser's screen does next. The post-match
       lane opens at the same beat, because both result capsules stay up and may speak. */
    if (next.winner !== null) {
      this.settle(race, next.winner);
      this.armPostMatch(race.seats.map((s) => ({ ws: s.ws, side: s.side, premium: s.premium, id: s.id })));
    }
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
    if (winner !== null) {
      this.bumpMetrics({ matchesCompleted: 1 }, { mode: race.mode, players: 2 });
    }
    for (const seat of race.seats) {
      if (seat.race === race) seat.race = null;
      this.markActive(seat.id, race.mode);
      this.verdict(seat.id, winner === null ? null : seat.side === winner);
    }
    /* Only the pairing queue is random matchmaking. A relic duel is a challenge one player threw
       at another, so the vault treats it like the custom lobby it is. */
    if (winner !== null && race.origin === 'queue') {
      this.observeVaultMatch(race.seats.map((seat) => ({ id: seat.id, won: seat.side === winner })), race.startedAt, true);
    }
  }

  /* ---------- the Stars Vault ----------
   *
   * Everything below is written by the room from a board it refereed. The client asks for a view
   * and paints it; it never sends a counter, a stage flag or a balance.
   */

  /** One atomic write: balances, progress and the payout queue land together, or not at all. */
  private persistVault(): void {
    if (this.vaultDirty || !this.state?.storage) return;
    this.vaultDirty = true;
    void Promise.resolve().then(() => {
      this.vaultDirty = false;
      const storage = this.state.storage;
      if (!storage) return;
      try {
        this.vaultTrim();
        const state: VaultState = {
          accounts: [...this.vaultAccounts.values()],
          friends: [...this.vaultFriends.values()],
          payouts: [...this.vaultPayouts.values()],
          budget: this.vaultBudget,
        };
        void storage.put(STARS_VAULT_KEY, state);
      } catch { /* a store that refuses the write: the vault stays live in this isolate */ }
    });
  }

  /** Shed the oldest settled rows past the caps. A waiting request is never shed. */
  private vaultTrim(): void {
    if (this.vaultPayouts.size > VAULT_PAYOUTS_MAX) {
      const settled = [...this.vaultPayouts.values()]
        .filter((p) => p.status !== 'waiting')
        .sort((a, b) => a.createdAt - b.createdAt);
      let over = this.vaultPayouts.size - VAULT_PAYOUTS_MAX;
      for (const p of settled) {
        if (over <= 0) break;
        this.vaultPayouts.delete(p.requestId);
        over--;
      }
    }
    if (this.vaultFriends.size > VAULT_FRIENDS_MAX) {
      /* Only a friend whose Stars are already banked may go: the account keeps the credit. */
      const done = [...this.vaultFriends.values()]
        .filter((f) => f.stage1 && f.stage2 && f.queuedStars === 0)
        .sort((a, b) => a.updatedAt - b.updatedAt);
      let over = this.vaultFriends.size - VAULT_FRIENDS_MAX;
      for (const f of done) {
        if (over <= 0) break;
        this.vaultFriends.delete(f.id);
        over--;
      }
    }
  }

  /**
   * A new calendar month resets the pool and every inviter's cap, then releases what last month
   * queued. Runs before any read or credit, so a month boundary never needs its own alarm.
   */
  private vaultRollMonth(now: number): void {
    const key = utcMonthKey(now);
    if (this.vaultBudget.monthKey === key) return;
    this.vaultBudget = { monthKey: key, spent: 0 };
    for (const acc of this.vaultAccounts.values()) {
      acc.monthKey = key;
      acc.monthQualified = 0;
    }
    for (const friend of this.vaultFriends.values()) {
      if (friend.queuedStars <= 0) continue;
      const acc = this.vaultAccounts.get(friend.inviterId);
      if (!acc) continue;
      const held = friend.queuedStars;
      if (this.vaultTryCredit(acc, friend, held, now)) {
        friend.queuedStars = 0;
        acc.queuedStars = Math.max(0, acc.queuedStars - held);
      }
    }
    this.persistVault();
  }

  /**
   * Release Stars into the vault, or refuse because a cap is reached. The per-inviter cap counts
   * *friends* rewarded this month, so a friend already counted may still finish their second stage.
   */
  private vaultTryCredit(acc: VaultAccount, friend: VaultFriend, stars: number, now: number): boolean {
    if (stars <= 0) return false;
    const key = utcMonthKey(now);
    const newFriend = friend.creditMonth !== key;
    if (newFriend && acc.monthQualified >= REFERRAL_CONFIG.MAX_QUALIFIED_PER_INVITER_MONTH) return false;
    if (this.vaultBudget.spent + stars > REFERRAL_CONFIG.GLOBAL_MONTHLY_BUDGET_STARS) return false;
    this.vaultBudget.spent += stars;
    if (newFriend) {
      friend.creditMonth = key;
      acc.monthQualified += 1;
    }
    friend.creditedStars += stars;
    acc.earnedStars += stars;
    acc.updatedAt = now;
    return true;
  }

  /** A stage qualified. Credit it now, or hold it for next month's pool — it is never lost. */
  private vaultAward(acc: VaultAccount, friend: VaultFriend, stars: number, now: number): void {
    this.vaultRollMonth(now);
    if (this.vaultTryCredit(acc, friend, stars, now)) {
      this.persistVault();
      return;
    }
    friend.queuedStars += stars;
    acc.queuedStars += stars;
    acc.updatedAt = now;
    this.persistVault();
  }

  /** Every vault starts with the same pre-filled gift, so the meter is never empty on first paint. */
  private vaultAccount(id: string, now: number): VaultAccount {
    const existing = this.vaultAccounts.get(id);
    if (existing) {
      const name = this.players.get(id)?.name;
      if (name) existing.name = name.slice(0, 48);
      return existing;
    }
    const acc: VaultAccount = {
      id,
      name: (this.players.get(id)?.name ?? '').slice(0, 48),
      starterBonus: REFERRAL_CONFIG.STARTER_VAULT_GIFT_STARS,
      earnedStars: 0,
      paidOutStars: 0,
      queuedStars: 0,
      monthKey: utcMonthKey(now),
      monthQualified: 0,
      updatedAt: now,
    };
    this.vaultAccounts.set(id, acc);
    this.persistVault();
    return acc;
  }

  private vaultFriendRow(id: string, inviterId: string, now: number): VaultFriend {
    const existing = this.vaultFriends.get(id);
    if (existing) return existing;
    const friend: VaultFriend = {
      id,
      inviterId,
      name: '',
      avatar: '',
      matches: 0,
      days: [],
      pvpMatches: 0,
      opponents: [],
      pvpWins: 0,
      arena: 1,
      clusterMatches: 0,
      stage1: false,
      stage2: false,
      flagged: false,
      cleared: false,
      creditedStars: 0,
      queuedStars: 0,
      creditMonth: '',
      updatedAt: now,
    };
    this.vaultFriends.set(id, friend);
    this.vaultAccount(inviterId, now);
    return friend;
  }

  /** Keep the painted name, avatar and Arena realm current from the room's own directory. */
  private vaultRefreshFriend(friend: VaultFriend): void {
    const p = this.players.get(friend.id);
    if (!p) return;
    if (p.name) friend.name = p.name.slice(0, 48);
    if (p.avatar) friend.avatar = p.avatar.slice(0, 300);
    friend.arena = Math.max(friend.arena, arenaRankOf(p.tiq));
  }

  /** The permanent link, asked of the ledger once per isolate. '' means nobody invited them. */
  private async vaultInviterOf(playerId: string): Promise<string> {
    const cached = this.vaultInviters.get(playerId);
    if (cached !== undefined) return cached;
    const tgId = this.players.get(playerId)?.tgId
      ?? (playerId.startsWith('tg-') ? playerId.slice(3) : '');
    if (!TELEGRAM_ID.test(tgId)) {
      this.vaultInviters.set(playerId, '');
      return '';
    }
    const binding = await referralBinding(this.env, tgId);
    /* An unreachable ledger is not an answer: leave the slot open so the next match asks again. */
    if (!binding) return '';
    const inviter = binding.inviterId && binding.inviterId !== tgId ? `tg-${binding.inviterId}` : '';
    this.vaultInviters.set(playerId, inviter);
    return inviter;
  }

  /**
   * The gate every observed board passes: random matchmaking, at least two people, and a match
   * long enough to have been played. An instant quit under 25s counts for nothing.
   */
  private observeVaultMatch(seats: Array<{ id: string; won: boolean }>, startedAt: number, random: boolean): void {
    if (!random || seats.length < 2) return;
    const now = Date.now();
    if (now - startedAt < REFERRAL_CONFIG.MIN_VALID_MATCH_DURATION_MS) return;
    void this.vaultApplyMatch(seats, now).catch(() => undefined);
  }

  /** The room's eligible seats: a person who stayed, never a bot or a chair the machine finished. */
  private vaultRoomSeats(live: LiveRoom, winner: number | null): Array<{ id: string; won: boolean }> {
    const roster = live.driver?.room ?? live.room;
    const seats: Array<{ id: string; won: boolean }> = [];
    for (let i = 0; i < live.members.length; i++) {
      const m = live.members[i];
      if (!m || !m.connected) continue;
      const seat = roster.seats[i];
      if (!seat || seat.kind !== 'human' || seat.takenOver) continue;
      seats.push({ id: m.id, won: winner !== null && i === winner });
    }
    return seats;
  }

  /**
   * One refereed board, folded into every invited friend who sat at it. A friend who was never
   * invited still counts as an opponent, which is what makes the cluster ratio meaningful.
   */
  private async vaultApplyMatch(seats: Array<{ id: string; won: boolean }>, now: number): Promise<void> {
    const duel = seats.length === 2;
    const day = utcDayKey(now);
    const inviters = new Map<string, string>();
    for (const seat of seats) inviters.set(seat.id, await this.vaultInviterOf(seat.id));

    let touched = false;
    for (const seat of seats) {
      const inviterId = inviters.get(seat.id) ?? '';
      if (!inviterId) continue;
      const friend = this.vaultFriendRow(seat.id, inviterId, now);
      const acc = this.vaultAccounts.get(inviterId);
      if (!acc) continue;
      this.vaultRefreshFriend(friend);

      const rivals = seats.filter((other) => other.id !== seat.id);
      /* Inside the cluster: every rival is the inviter, or another friend the same inviter brought. */
      const clustered = rivals.length > 0 && rivals.every((other) => (
        other.id === inviterId || this.vaultFriends.get(other.id)?.inviterId === inviterId
      ));

      friend.matches += 1;
      ringPush(friend.days, day);
      if (clustered) friend.clusterMatches += 1;
      if (duel) {
        friend.pvpMatches += 1;
        for (const other of rivals) ringPush(friend.opponents, other.id);
        if (seat.won) friend.pvpWins += 1;
      }
      friend.updatedAt = now;
      touched = true;

      /* A ratio needs a denominator worth reading: one internal duel is not a ring. */
      const ratio = friend.clusterMatches / friend.matches;
      if (!friend.cleared && friend.matches >= REFERRAL_CONFIG.STAGE1_MIN_MATCHES
        && ratio >= REFERRAL_CONFIG.MAX_COLLUSION_RATIO) {
        friend.flagged = true;
      }
      this.vaultEvaluate(friend, acc, now);
    }
    if (touched) this.persistVault();
  }

  /** The two stages, in order. A flag holds both; a credited stage is never revisited. */
  private vaultEvaluate(friend: VaultFriend, acc: VaultAccount, now: number): void {
    if (friend.flagged) return;
    const C = REFERRAL_CONFIG;
    if (!friend.stage1) {
      const ready = friend.matches >= C.STAGE1_MIN_MATCHES
        && friend.days.length >= C.STAGE1_MIN_DAYS
        && friend.pvpMatches >= C.STAGE1_MIN_PVP_MATCHES
        && friend.opponents.length >= C.STAGE1_MIN_DISTINCT_OPPONENTS;
      if (!ready) return;
      friend.stage1 = true;
      this.vaultAward(acc, friend, C.STAGE1_REWARD_STARS, now);
    }
    if (friend.stage2) return;
    const beaten = friend.pvpWins >= C.STAGE2_MIN_RANKED_PVP_WINS || friend.arena >= C.STAGE2_ALT_ARENA_UNLOCK;
    if (!beaten) return;
    friend.stage2 = true;
    this.vaultAward(acc, friend, C.STAGE2_REWARD_STARS, now);
  }

  /** What a waiting request has locked: the same Stars cannot be asked for twice. */
  private vaultWaitingFor(playerId: string): VaultPayout | null {
    for (const p of this.vaultPayouts.values()) {
      if (p.playerId === playerId && p.status === 'waiting') return p;
    }
    return null;
  }

  private vaultBalanceOf(acc: VaultAccount): number {
    const locked = this.vaultWaitingFor(acc.id)?.amount ?? 0;
    return Math.max(0, acc.starterBonus + acc.earnedStars - acc.paidOutStars - locked);
  }

  /** The Profile card's whole face. A read also re-checks the Arena alternative to Stage 2. */
  private vaultView(playerId: string): VaultView {
    const now = Date.now();
    this.vaultRollMonth(now);
    const acc = this.vaultAccount(playerId, now);
    const mine: VaultFriend[] = [];
    for (const friend of this.vaultFriends.values()) {
      if (friend.inviterId !== playerId) continue;
      this.vaultRefreshFriend(friend);
      this.vaultEvaluate(friend, acc, now);
      mine.push(friend);
    }
    /* Still in progress first, then the most recently active: the rows a player can move. */
    mine.sort((a, b) => {
      const done = (f: VaultFriend) => (f.stage1 && f.stage2 ? 1 : 0);
      return done(a) - done(b) || b.updatedAt - a.updatedAt;
    });
    const waiting = this.vaultWaitingFor(playerId);
    const balance = this.vaultBalanceOf(acc);
    const pending = mine.filter((f) => !(f.stage1 && f.stage2)).length;
    this.persistVault();
    return {
      ok: true,
      starterBonus: acc.starterBonus,
      earnedStars: acc.earnedStars,
      paidOutStars: acc.paidOutStars,
      vaultBalance: balance,
      pendingFriendsCount: pending,
      qualifiedFriendsCount: mine.length - pending,
      threshold: REFERRAL_CONFIG.MIN_PAYOUT_THRESHOLD_STARS,
      canPayout: !waiting && balance >= REFERRAL_CONFIG.MIN_PAYOUT_THRESHOLD_STARS,
      waiting: Boolean(waiting),
      queuedStars: acc.queuedStars,
      budgetLeft: Math.max(0, REFERRAL_CONFIG.GLOBAL_MONTHLY_BUDGET_STARS - this.vaultBudget.spent),
      monthKey: this.vaultBudget.monthKey,
      friends: mine.slice(0, VAULT_FRIENDS_SHOWN).map((f) => ({
        id: f.id,
        name: f.name,
        avatar: f.avatar,
        matches: f.matches,
        days: f.days.length,
        pvpMatches: f.pvpMatches,
        opponents: f.opponents.length,
        pvpWins: f.pvpWins,
        arena: f.arena,
        stage1: f.stage1,
        stage2: f.stage2,
        flagged: f.flagged,
        credited: f.creditedStars,
        queued: f.queuedStars,
      })),
    };
  }

  /** File a manual payout request. The app moves no currency; the owner settles it by hand. */
  private vaultRequestPayout(playerId: string): { ok: boolean; error?: string; view?: VaultView } {
    const now = Date.now();
    this.vaultRollMonth(now);
    const acc = this.vaultAccount(playerId, now);
    if (this.vaultWaitingFor(playerId)) return { ok: false, error: 'already_waiting' };
    const amount = this.vaultBalanceOf(acc);
    if (amount < REFERRAL_CONFIG.MIN_PAYOUT_THRESHOLD_STARS) return { ok: false, error: 'below_threshold' };
    let requestId = '';
    for (let attempt = 0; attempt < 8 && !requestId; attempt++) {
      const candidate = `vp${hash(`${playerId}|${now}|${attempt}|${this.vaultPayouts.size}`).toString(36)}`;
      if (!this.vaultPayouts.has(candidate)) requestId = candidate;
    }
    if (!requestId) return { ok: false, error: 'request_id_failed' };
    this.vaultPayouts.set(requestId, {
      requestId,
      playerId,
      playerName: acc.name || (this.players.get(playerId)?.name ?? '').slice(0, 48),
      amount,
      createdAt: now,
      status: 'waiting',
      decidedAt: 0,
    });
    this.persistVault();
    return { ok: true, view: this.vaultView(playerId) };
  }

  /** The Command Center's read: what was earned, what was paid, what is waiting, what is held. */
  private vaultAdminView(): VaultAdminView {
    const now = Date.now();
    this.vaultRollMonth(now);
    let earned = 0;
    let paid = 0;
    let queued = 0;
    for (const acc of this.vaultAccounts.values()) {
      earned += acc.earnedStars;
      paid += acc.paidOutStars;
      queued += acc.queuedStars;
    }
    const requests = [...this.vaultPayouts.values()].sort((a, b) => {
      const rank = (p: VaultPayout) => (p.status === 'waiting' ? 0 : 1);
      return rank(a) - rank(b) || b.createdAt - a.createdAt;
    });
    const waiting = requests.filter((p) => p.status === 'waiting');
    const flagged: VaultFlagView[] = [];
    for (const friend of this.vaultFriends.values()) {
      if (!friend.flagged) continue;
      flagged.push({
        id: friend.id,
        name: friend.name,
        inviterId: friend.inviterId,
        inviterName: this.vaultAccounts.get(friend.inviterId)?.name ?? '',
        matches: friend.matches,
        clusterMatches: friend.clusterMatches,
        ratio: friend.matches > 0 ? Math.round((friend.clusterMatches / friend.matches) * 100) : 0,
        pvpWins: friend.pvpWins,
        stage1: friend.stage1,
        stage2: friend.stage2,
        /* What the inviter would still be owed if this friend were genuine. */
        heldStars: Math.max(0, REFERRAL_CONFIG.TOTAL_PER_FRIEND_STARS - friend.creditedStars),
      });
    }
    flagged.sort((a, b) => b.ratio - a.ratio || b.matches - a.matches);
    return {
      ok: true,
      totals: {
        earned,
        paid,
        waiting: waiting.length,
        waitingStars: waiting.reduce((sum, p) => sum + p.amount, 0),
        queued,
        inviters: this.vaultAccounts.size,
        friends: this.vaultFriends.size,
        flagged: flagged.length,
        budget: REFERRAL_CONFIG.GLOBAL_MONTHLY_BUDGET_STARS,
        budgetSpent: this.vaultBudget.spent,
        budgetLeft: Math.max(0, REFERRAL_CONFIG.GLOBAL_MONTHLY_BUDGET_STARS - this.vaultBudget.spent),
        monthKey: this.vaultBudget.monthKey,
      },
      requests,
      flagged,
    };
  }

  /** Mark a request paid or rejected, or clear / raise a collusion flag. SuperAdmin only. */
  private vaultAdminAction(body: Record<string, unknown>): { ok: boolean; error?: string; view?: VaultAdminView } {
    const id = typeof body.id === 'string' ? body.id.slice(0, 64) : '';
    const action = typeof body.action === 'string' ? body.action.toUpperCase() : '';
    if (!id) return { ok: false, error: 'bad_id' };
    const now = Date.now();

    const request = this.vaultPayouts.get(id);
    if (request) {
      if (action !== 'PAID' && action !== 'REJECT') return { ok: false, error: 'bad_action' };
      if (request.status !== 'waiting') return { ok: false, error: 'already_decided' };
      request.status = action === 'PAID' ? 'paid' : 'rejected';
      request.decidedAt = now;
      if (action === 'PAID') {
        const acc = this.vaultAccount(request.playerId, now);
        acc.paidOutStars += request.amount;
        acc.updatedAt = now;
      }
      this.persistVault();
      return { ok: true, view: this.vaultAdminView() };
    }

    const friend = this.vaultFriends.get(id);
    if (friend) {
      if (action !== 'CLEAR' && action !== 'FLAG') return { ok: false, error: 'bad_action' };
      friend.flagged = action === 'FLAG';
      /* A cleared ring stays cleared: the admin's review outranks the ratio that raised it. */
      friend.cleared = action === 'CLEAR';
      friend.updatedAt = now;
      if (!friend.flagged) {
        const acc = this.vaultAccounts.get(friend.inviterId);
        if (acc) this.vaultEvaluate(friend, acc, now);
      }
      this.persistVault();
      return { ok: true, view: this.vaultAdminView() };
    }
    return { ok: false, error: 'not_found' };
  }

  /** `GET /api/stars/vault` — the Profile card's server-owned balance and friend progress. */
  private async starsVault(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: VAULT_CORS });
    if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405, VAULT_CORS);
    const who = await identifyPlayerRequest(request, this.env);
    if (!who) return json({ ok: false, error: 'unauthorized' }, 401, VAULT_CORS);
    if (this.restricted(who.playerId)) return json({ ok: false, error: 'banned' }, 403, VAULT_CORS);
    return json(this.vaultView(who.playerId), 200, VAULT_CORS);
  }

  /** `POST /api/stars/payout` — file the manual request. Nothing is transferred here. */
  private async starsPayout(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: VAULT_CORS });
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, VAULT_CORS);
    const who = await identifyPlayerRequest(request, this.env);
    if (!who) return json({ ok: false, error: 'unauthorized' }, 401, VAULT_CORS);
    if (this.restricted(who.playerId)) return json({ ok: false, error: 'banned' }, 403, VAULT_CORS);
    const result = this.vaultRequestPayout(who.playerId);
    if (!result.ok) return json({ ok: false, error: result.error ?? 'refused' }, 400, VAULT_CORS);
    return json(result.view ?? this.vaultView(who.playerId), 200, VAULT_CORS);
  }
}
