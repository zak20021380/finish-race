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
  /* The room path: the host starting early. Everything else a room seat sends is a MOVE or a
     RESIGN, exactly as a 1v1 seat sends them. */
  | { type: 'ROOM_START' };

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
    const msg = JSON.parse(raw) as { type?: unknown; wide?: unknown; action?: unknown };
    if (msg.type === 'QUEUE') return { type: 'QUEUE', wide: msg.wide === true };
    if (msg.type === 'WIDEN') return { type: 'WIDEN' };
    if (msg.type === 'CANCEL') return { type: 'CANCEL' };
    if (msg.type === 'RESIGN') return { type: 'RESIGN' };
    if (msg.type === 'ROOM_START') return { type: 'ROOM_START' };
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
  /** Rooms that have launched, by match id. */
  private rooms = new Map<string, LiveRoom>();
  /** Which room seat a socket is holding. A socket in here is not a queue entry. */
  private refs = new Map<WebSocket, RoomRef>();
  /** The admin's maintenance lock: nobody new gets in while it is on. */
  private maintenance = false;
  /** The live pairing bands — the defaults until `/admin/config` moves them. */
  private normalRadius = TIER_RADIUS;
  private wideRadius = WIDE_RADIUS;

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    /* The worker has already verified the caller on `/admin/*`; these never carry an upgrade. */
    if (url.pathname.startsWith('/admin/')) return this.admin(request, url);
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return json({ error: 'expected_upgrade', hint: 'GET /ws/matchmake with Upgrade: websocket' }, 426);
    }

    const identity = await authenticate(authRequestFrom(url), this.env);
    if (!identity) return json({ error: 'unauthorized', hint: 'valid Telegram initData required' }, 401);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    /* A room socket and a queue socket are two different things from the first frame: a room seat
       is never in the pairing queue, so a 4-seat room can never be broken up into a duel. */
    const roomSize = readRoomSize(url.searchParams.get('room'));
    if (roomSize) {
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
    this.rooms.set(live.matchId, live);
    this.rearm();

    for (const m of live.members) if (m) this.postTo(m.ws, this.roomFoundMessage(live, m.seat));
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
      seats: roster.seats.map((s, i) => ({
        side: i,
        name: s.name,
        bot: isAutomated(roster, i),
        difficulty: difficultyFor(roster, i),
      })),
    });
  }

  /** A frame from a seat in a room: the host's early start, a move, or a resignation. */
  private roomFrame(ref: RoomRef, msg: ClientMessage): void {
    const live = ref.live;
    if (!live.driver) {
      /* the room has not launched: a seat can start it early or walk away, and nothing else */
      if (msg.type === 'ROOM_START' && ref.seat === 0) this.launchRoom(live);
      else if (msg.type === 'CANCEL') this.roomLeave(ref);
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
    if (live.driver.state.winner !== null) this.rooms.delete(live.matchId);
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
    if (next.winner !== null) this.settle(race);
  }

  private refuse(seat: Waiter, reason: string): void {
    this.deliver(seat, JSON.stringify({ type: 'REJECT', reason }));
  }

  /** Forfeit: a resignation, or a socket that died mid-race. The seat opposite takes the win. */
  private endRace(race: Race, leaver: 0 | 1, why: 'RESIGN' | 'LEFT'): void {
    if (race.over) return;
    this.settle(race);
    const other = race.seats[leaver === 0 ? 1 : 0];
    this.deliver(other, JSON.stringify(why === 'RESIGN'
      ? { type: 'RESIGN', side: leaver }
      : { type: 'OPPONENT_LEFT', side: leaver }));
  }

  /** The race is done: stop routing frames through it, and forget the room. */
  private settle(race: Race): void {
    race.over = true;
    this.races.delete(race.matchId);
    for (const seat of race.seats) if (seat.race === race) seat.race = null;
  }
}
