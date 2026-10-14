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
 */
import { COLS, MAX_BALLS, ROWS, apply, newGame, type Action, type GameState } from '../src/rules';
import { authenticate, authRequestFrom, type Identity, type MindTier } from './auth';
import { json } from './http';
import type { Env } from './env';

/* ---------- protocol ---------- */

type ClientMessage =
  | { type: 'QUEUE'; wide: boolean }
  | { type: 'WIDEN' }
  | { type: 'CANCEL' }
  | { type: 'MOVE'; action: Action }
  | { type: 'RESIGN' };

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

/** The ordinary radius. */
const TIER_RADIUS = 250;
/** The widened radius, once either side has asked for one. */
const WIDE_RADIUS = 600;

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

const sameBoard = (a: Waiter, b: Waiter): boolean => a.sizes[0] === b.sizes[0] && a.sizes[1] === b.sizes[1];

const inBounds = (v: unknown): v is { c: number; r: number } => {
  const p = v as { c?: unknown; r?: unknown } | null;
  return !!p && Number.isInteger(p.c) && Number.isInteger(p.r)
    && (p.c as number) >= 0 && (p.c as number) < COLS && (p.r as number) >= 0 && (p.r as number) < ROWS;
};

/**
 * An action, read from the wire and rebuilt here rather than trusted: a wall's owner is the seat
 * that sent it, never the number in the payload, and every coordinate has to be a square on the
 * board. Anything else is refused before it can reach the rules.
 */
function readAction(raw: unknown, side: 0 | 1): Action | null {
  const a = raw as { kind?: unknown; ball?: unknown; to?: unknown; wall?: unknown; cell?: unknown } | null;
  if (!a || typeof a !== 'object') return null;
  if (a.kind === 'move') {
    if (!inBounds(a.to)) return null;
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
    if (!inBounds(a.cell)) return null;
    return { kind: 'mine', cell: { c: a.cell.c, r: a.cell.r } };
  }
  return a.kind === 'pass' ? { kind: 'pass' } : null;
}

function readMessage(raw: unknown, side: 0 | 1): ClientMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const msg = JSON.parse(raw) as { type?: unknown; wide?: unknown; action?: unknown };
    if (msg.type === 'QUEUE') return { type: 'QUEUE', wide: msg.wide === true };
    if (msg.type === 'WIDEN') return { type: 'WIDEN' };
    if (msg.type === 'CANCEL') return { type: 'CANCEL' };
    if (msg.type === 'RESIGN') return { type: 'RESIGN' };
    if (msg.type === 'MOVE') {
      const action = readAction(msg.action, side);
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

  constructor(_state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return json({ error: 'expected_upgrade', hint: 'GET /ws/matchmake with Upgrade: websocket' }, 426);
    }

    const identity = await authenticate(authRequestFrom(url), this.env);
    if (!identity) return json({ error: 'unauthorized', hint: 'valid Telegram initData required' }, 401);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const waiter = this.enter(server, identity, url.searchParams.get('wide') === '1', readSizes(url.searchParams.get('sizes')));
    this.attach(waiter);
    this.pairNow();                            // the queue may already hold their match
    return new Response(null, { status: 101, webSocket: client });
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
      const msg = readMessage(ev.data, waiter.side);
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
    return this.find(() => true, TIER_RADIUS)
      ?? this.find((a, b) => a.wide || b.wide, WIDE_RADIUS)
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
