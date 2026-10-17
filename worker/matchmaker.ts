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
  ROOM_WAIT_MS, backfill, createRoom, createRoomDriver, difficultyFor, isAutomated, launch,
  seatHuman, sizesOf, type BotTier, type Room, type RoomDriver, type RoomEvent,
} from '../src/room';
import { authenticate, authRequestFrom, type Identity, type MindTier } from './auth';
import { json } from './http';
import type { Env } from './env';

/* ---------- protocol ---------- */

type ClientMessage =
  | { type: 'QUEUE'; wide: boolean }
  | { type: 'WIDEN' }
  | { type: 'CANCEL' }
  | { type: 'MOVE'; action: Action }
  | { type: 'RESIGN' }
  /* The room path: the host starting early, and the two knobs only the host may turn — the match
     format and a seat's team. Everything else a room seat sends is a MOVE or a RESIGN. */
  | { type: 'ROOM_START' }
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
  /** Indexed by seat: the socket holding it, or null while the machine holds it. */
  members: (RoomMember | null)[];
  /** Minted at launch, so both seats of every pairing derive the same numbers. */
  matchId: string;
  seed: number;
  /** The authoritative race. Null until the room launches. */
  driver: RoomDriver | null;
  /** The seat wearing the crown. A code lobby migrates it when the host walks out. */
  hostSeat: number;
  /** The format the host picked: everyone for themselves, or two teams. */
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
  /** The hazard round the room is in; 1 when the board runs no rolling log. */
  round: number;
  /** How many seats the race fields — 2 for a duel, up to `MAX_TEAMS` for a room. */
  players?: number;
  /** How many of those seats the machine is holding. */
  bots?: number;
}

export interface ServerStatus {
  ok: true;
  queueCount: number;
  activeMatchesCount: number;
  queuedPlayers: QueuedPlayer[];
  activeRooms: ActiveRoom[];
  config: ServerConfig;
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
}

/** The directory views the Users tab's filter chips select. */
export type PlayerFilter = 'all' | 'active' | 'tiq' | 'flagged';

const FILTERS: readonly PlayerFilter[] = ['all', 'active', 'tiq', 'flagged'];

const filterOf = (raw: string | null): PlayerFilter =>
  (FILTERS as readonly string[]).includes(raw ?? '') ? (raw as PlayerFilter) : 'all';

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
/** A day in ms: what "Active Today" means on both sides of the wire. */
const ACTIVE_MS = 24 * 60 * 60 * 1000;

const whole = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

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

function readMessage(raw: unknown, side: number, cols: number, rows: number): ClientMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const msg = JSON.parse(raw) as {
      type?: unknown; wide?: unknown; action?: unknown; mode?: unknown; side?: unknown; team?: unknown;
    };
    if (msg.type === 'QUEUE') return { type: 'QUEUE', wide: msg.wide === true };
    if (msg.type === 'WIDEN') return { type: 'WIDEN' };
    if (msg.type === 'CANCEL') return { type: 'CANCEL' };
    if (msg.type === 'RESIGN') return { type: 'RESIGN' };
    if (msg.type === 'ROOM_START') return { type: 'ROOM_START' };
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
  /** The live pairing bands — the defaults until `/admin/config` moves them. */
  private normalRadius = TIER_RADIUS;
  private wideRadius = WIDE_RADIUS;
  /** Every player the room has met, by seat id — the Users tab's directory. */
  private players = new Map<string, PlayerRecord>();
  /** The moderation lock: a banned seat never reaches matchmaking again. */
  private banned = new Set<string>();
  /** A registry write is already scheduled: many touches, one flush. */
  private dirty = false;

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
        } catch {
          /* a store that refuses the read: the registry simply starts empty */
        }
      });
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    /* The worker has already verified the caller on `/admin/*`; these never carry an upgrade. */
    if (url.pathname.startsWith('/admin/')) return this.admin(request, url);
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
    this.rearm();
  }

  /* ---------- the admin surface ---------- */

  /** The three live knobs, as the panel reads them back. */
  private config(): ServerConfig {
    return { maintenance: this.maintenance, normalRadius: this.normalRadius, wideRadius: this.wideRadius };
  }

  /** Everything a live server knows about itself: the queue, the rooms, and the config. */
  private status(): ServerStatus {
    const now = Date.now();
    return {
      ok: true,
      queueCount: this.queue.length,
      activeMatchesCount: this.races.size + this.rooms.size,
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
          round: r.state.hazard?.round ?? 1,
        })),
        ...[...this.rooms.values()].map((live) => this.roomSummary(live)),
      ],
      config: this.config(),
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
      round: live.driver?.state.hazard?.round ?? 1,
      players: roster.seats.length,
      bots,
    };
  }

  /** The `/admin/*` routes, already authenticated by the worker in front of this object. */
  private async admin(request: Request, url: URL): Promise<Response> {
    if (url.pathname === '/admin/status') return json(this.status());

    if (url.pathname === '/admin/config') {
      const body = await readBody(request);
      return json({ ok: true, config: this.configure(body) });
    }

    if (url.pathname === '/admin/action') {
      const body = await readBody(request);
      const result = this.act(body);
      return json(result, result.ok ? 200 : 400);
    }

    /* The Users tab: one page of the player directory, then one player's moderation/coins. */
    if (url.pathname === '/admin/players') return json(this.playersPage(url.searchParams));

    if (url.pathname === '/admin/player') {
      const body = await readBody(request);
      const result = this.playerAction(body);
      return json(result, result.ok ? 200 : 400);
    }

    return json({ error: 'not_found' }, 404);
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

  /* ---------- the directory ---------- */

  /** Is this seat locked out of matchmaking? */
  private restricted(id: string): boolean {
    return this.banned.has(id) || this.players.get(id)?.banned === true;
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
    const p = this.players.get(id) ?? freshPlayer(identity, now);
    p.name = identity.player.name || p.name;
    p.username = identity.player.username || p.username;
    p.country = identity.flag || p.country;
    p.tiq = Math.max(0, Math.floor(identity.tiq));
    p.lastSeen = now;
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

  /** The seat's board came to rest: count it. `winner` null means nobody won — an admin abort. */
  private verdict(id: string, won: boolean | null): void {
    const p = this.players.get(id);
    if (!p) return;
    p.inMatch = false;
    p.lastSeen = Date.now();
    if (won === null) return;
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
    this.persist();
  }

  /** Mark a seat as holding a live board (or back on the market). */
  private setInMatch(id: string, on: boolean): void {
    const p = this.players.get(id);
    if (!p) return;
    p.inMatch = on;
    p.lastSeen = Date.now();
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
    /* flagged first when the filter asks for it; otherwise live boards, then the freshest seats */
    if (filter === 'flagged') rows.sort((a, b) => Number(b.banned) - Number(a.banned) || b.lastSeen - a.lastSeen);
    else if (filter === 'tiq') rows.sort((a, b) => b.tiq - a.tiq || b.lastSeen - a.lastSeen);
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
    this.queue[at].wide = true;
    this.pairNow();
  }

  /** Out of the room. A CANCEL closes the socket; a dead socket is just forgotten — and either
   *  way a player who was racing hands the win to the seat opposite. */
  private leave(waiter: Waiter, close: boolean): void {
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
      /* The room plays the same deterministic board the clients do, from the same seed — that is
         what makes an authoritative relay possible at all. */
      state: newGame(sizes, { hazards: true, seed }),
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
    let live = this.openRooms.find((r) => !r.driver && r.size === size && this.freeSeat(r) >= 0);
    if (!live) {
      live = {
        room: createRoom({ code: this.mintRoomCode(), seats: size, waitMs: ROOM_WAIT_MS, botTier: tier, now: Date.now() }),
        size,
        members: Array.from({ length: size }, () => null),
        matchId: '',
        seed: 0,
        driver: null,
        hostSeat: 0,
        mode: 'ffa',
        teams: Array.from({ length: size }, (_, i) => i % 2),
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
    let live = this.lobbies.get(code) ?? null;
    if (live?.driver) { this.rejectSocket(ws, 'room_started'); return; }
    if (!live) {
      if (!host) { this.rejectSocket(ws, 'room_not_found'); return; }
      const size = MAX_TEAMS;
      live = {
        room: createRoom({ code, seats: size, waitMs: ROOM_WAIT_MS, botTier: tier, now: Date.now() }),
        size,
        members: Array.from({ length: size }, () => null),
        matchId: '',
        seed: 0,
        driver: null,
        hostSeat: 0,
        mode: 'ffa',
        teams: Array.from({ length: size }, (_, i) => i % 2),
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
    live.driver = createRoomDriver(live.room, { hazards: true, seed: live.seed });
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
    this.pushRoomEvents(live, live.driver.runBots());
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
    if (!live.driver) {
      /* Before the launch the only authority is the host's: start, format, team. Any seat may
         leave, and that is the whole vocabulary of a lobby. */
      if (msg.type === 'CANCEL') { this.leaveLobby(ref); return; }
      if (ref.seat !== live.hostSeat) return;
      if (msg.type === 'ROOM_START') {
        /* A friends room needs a second player before it is a race; the auto-pair room does not,
           because its whole contract is that the machine fills whatever is left. */
        if (!live.code || live.members.filter((m) => m !== null).length >= 2) this.launchRoom(live);
        return;
      }
      if (msg.type === 'SET_MODE') {
        live.mode = msg.mode;
        this.broadcastLobby(live);
        return;
      }
      if (msg.type === 'SET_TEAM') {
        if (msg.side < live.size) live.teams[msg.side] = msg.team;
        this.broadcastLobby(live);
      }
      return;
    }
    if (msg.type === 'RESIGN' || msg.type === 'CANCEL') { this.takeSeatOver(ref); return; }
    if (msg.type !== 'MOVE') return;
    const result = live.driver.submit(ref.seat, msg.action);
    if (!result.ok) {
      const member = live.members[ref.seat];
      if (member) this.postTo(member.ws, JSON.stringify({ type: 'REJECT', reason: result.reason }));
      return;
    }
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
    this.pushRoomEvents(live, driver.runBots());
    if (driver.state.winner !== null) this.rooms.delete(live.matchId);
  }

  /** A socket went away. In a room that means the machine finishes the seat; in the queue, goodbye. */
  private roomLeave(ref: RoomRef | undefined): void {
    if (!ref) return;
    if (ref.live.driver) { this.takeSeatOver(ref); return; }
    const member = ref.live.members[ref.seat];
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

    if (msg.type === 'RESIGN') {
      this.endRace(race, seat.side, 'RESIGN');
      return;
    }
    if (msg.type !== 'MOVE') return;                     // queue traffic on a paired socket: ignored
    if (race.state.winner !== null) return;
    if (race.state.turn !== seat.side) {
      this.refuse(seat, 'not_your_turn');
      return;
    }

    let next: GameState | null = null;
    try {
      next = apply(race.state, msg.action);
    } catch {
      next = null;                                       // a frame shaped to throw is a frame refused
    }
    if (!next) {
      this.refuse(seat, 'illegal_action');
      return;
    }

    race.state = next;
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
    race.over = true;
    this.races.delete(race.matchId);
    for (const seat of race.seats) {
      if (seat.race === race) seat.race = null;
      this.verdict(seat.id, winner === null ? null : seat.side === winner);
    }
  }
}
