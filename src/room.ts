/**
 * room.ts — the lobby model for a multi-seat race, and the bot backfill that keeps it moving.
 *
 * A room is a fixed set of seats, 2 to `MAX_TEAMS`. A seat is either a person or the machine, and a
 * vacant seat is never a reason to stall: when the wait timer runs out — or the host starts early —
 * every seat still empty is backfilled with a bot. That is what lets a four-seat room launch with
 * any mix at all: 1 human + 3 bots, 2 + 2, 4 humans, or a solo host who never waited for anybody.
 *
 * Two questions the rest of the app asks, and this module is the only answer:
 *   - `isAutomated(room, seat)` — the ONE branch the turn dispatcher needs. A seat is automated when
 *     a bot was backfilled into it AND when a person walked out and the machine took the seat over,
 *     so nothing downstream has to know which of the two happened.
 *   - `rewardEligible(room, seat)` — false for every automated seat. A bot never claims a Star, a
 *     trophy or a rung on the ladder, and neither does a person who left a seat the machine had to
 *     finish for them.
 *
 * Everything here is pure and synchronous, and `tick()` takes the clock as an argument instead of
 * reading it, so a test and a live server drive the same room to the same answer. `RoomDriver` is
 * the authoritative race behind the room: it owns the board, and it plays every automated seat
 * itself, so a human's action and the machine's answer arrive as one atomic batch.
 */
import {
  MAX_TEAMS, apply, newGame, steps, view,
  type Action, type GameState, type Player,
} from './rules';
import { botAction, type Difficulty } from './bot';

/** A seat is a person or the machine. The kind is fixed at seat time; `takenOver` can change it. */
export type SeatKind = 'human' | 'bot';

/** The level a room hands its backfilled bots: one tier for all of them, or a ladder between two. */
export type BotTier = Difficulty | 'mixed';
export const BOT_TIERS: readonly BotTier[] = ['mixed', 'easy', 'normal', 'hard'];

/** How long a lobby holds open for more people before it fills the rest with bots. */
export const ROOM_WAIT_MS = 8000;
/** The level a room falls back on when nothing else is set. */
export const DEFAULT_BOT_TIER: BotTier = 'mixed';
/** The smallest and largest room the rules can play. */
export const MIN_SEATS = 2;
export const MAX_SEATS = MAX_TEAMS;

/* ---------- the lobby format: who plays whom, and how many seats that takes ---------- */

/**
 * The four shapes a friends lobby can take. Two team formats — a full 2v2, or two players against
 * one challenger — and two individual (FFA) sizes. The format is the *only* thing a host picks:
 * capacity, race mode and the default team layout all derive from it, so the selector and the
 * roster can never disagree about how many wells a room has.
 */
export type LobbyFormat = '2v2' | '2v1' | '3p' | '4p';

export const LOBBY_FORMATS: readonly LobbyFormat[] = ['2v2', '2v1', '3p', '4p'];

export const isLobbyFormat = (v: unknown): v is LobbyFormat =>
  v === '2v2' || v === '2v1' || v === '3p' || v === '4p';

/** How many seats a format fields. 2v1 is the one asymmetric team shape: three seats. */
export const FORMAT_CAPACITY: Record<LobbyFormat, number> = { '2v2': 4, '2v1': 3, '3p': 3, '4p': 4 };

/** What the board plays: the team formats share teams, the individual ones do not. */
export const FORMAT_MODE: Record<LobbyFormat, 'ffa' | 'team'> = {
  '2v2': 'team', '2v1': 'team', '3p': 'ffa', '4p': 'ffa',
};

/** How many seats each team may hold. Only read in team formats; FFA keeps everyone on Blue. */
export function teamCapacity(format: LobbyFormat, team: 0 | 1): number {
  if (FORMAT_MODE[format] === 'ffa') return FORMAT_CAPACITY[format];
  return format === '2v1' && team === 1 ? 1 : 2;
}

/** The team a seat starts on under a format: alternating down the seat order, Blue first. */
export const defaultTeam = (seat: number): 0 | 1 => (seat % 2 === 0 ? 0 : 1);

/** The format a mode opens on: the fullest team battle, or the four-seat free-for-all. */
export const formatOfMode = (mode: 'ffa' | 'team'): LobbyFormat => (mode === 'team' ? '2v2' : '4p');

/** The two-way size selector's labels, and the one-line promise printed under it. */
export const FORMAT_NAME: Record<LobbyFormat, string> = {
  '2v2': '2 vs 2', '2v1': '2 vs 1', '3p': '3 Players', '4p': '4 Players',
};

export const FORMAT_LINE: Record<LobbyFormat, string> = {
  '2v2': '2 vs 2 · Full team battle',
  '2v1': '2 vs 1 · Two players against one challenger',
  '3p': '3-player free-for-all · Everyone for themselves',
  '4p': '4-player free-for-all · Everyone for themselves',
};

/**
 * Reflow a set of held seat indices into a room of `capacity` seats. A seat that still fits keeps
 * its index; one that does not moves to the lowest free well. Null when everyone cannot fit — a
 * four-player room cannot become a three-seat one without somebody going.
 */
export function reflowSeats(held: readonly number[], capacity: number): number[] | null {
  if (held.length > capacity) return null;
  const taken = new Set(held.filter((i) => i >= 0 && i < capacity));
  const out: number[] = [];
  for (const from of held) {
    if (from >= 0 && from < capacity) { out.push(from); continue; }
    let at = 0;
    while (taken.has(at)) at++;
    if (at >= capacity) return null;
    taken.add(at);
    out.push(at);
  }
  return out;
}

export interface RoomReflow {
  room: Room;
  /** Where each held seat went, `from` → `to`, in the room's own seat order. */
  moves: Array<{ from: number; to: number }>;
}

/** Resize a room to `capacity`, carrying every held seat along. Null when they will not fit. */
export function reflowRoom(room: Room, capacity: number): RoomReflow | null {
  const held: number[] = [];
  for (let i = 0; i < room.seats.length; i++) {
    const s = room.seats[i];
    if (s.kind === 'bot' || isHuman(room, i)) held.push(i);
  }
  const mapped = reflowSeats(held, capacity);
  if (!mapped) return null;
  const seats: Seat[] = Array.from({ length: capacity }, (_, i) => vacantSeat(i, 'normal'));
  const moves = held.map((from, k) => ({ from, to: mapped[k] }));
  for (const { from, to } of moves) seats[to] = { ...room.seats[from], index: to };
  return { room: { ...room, seats }, moves };
}

/**
 * Move one seat to a team, with the team's capacity respected. When the destination is already
 * full the mover swaps places with the lowest seat on it — which is what makes "tap to switch"
 * feel right in a full 2v2, and the only way to re-pick the lone challenger in a 2v1. Null when
 * the move changes nothing or the seat is not held.
 */
export function assignTeam(
  teams: readonly number[],
  held: readonly boolean[],
  seat: number,
  team: 0 | 1,
  format: LobbyFormat,
): number[] | null {
  if (seat < 0 || seat >= teams.length || !held[seat] || teams[seat] === team) return null;
  const cap = teamCapacity(format, team);
  let count = 0;
  let first = -1;
  for (let i = 0; i < teams.length; i++) {
    if (held[i] && teams[i] === team) {
      count++;
      if (first < 0) first = i;
    }
  }
  const next = teams.slice();
  if (count < cap) { next[seat] = team; return next; }
  if (first < 0) return null;
  next[seat] = team;
  next[first] = teams[seat];
  return next;
}

export interface Seat {
  /** The seat's index in the room — which is also the team index the rules play it as. */
  index: number;
  kind: SeatKind;
  /** Stable key: a player id for a person, `bot:<index>` for the machine. */
  id: string;
  name: string;
  /** A human seat's own pick. A bot seat's is `difficultyFor`'s answer, kept here for display. */
  difficulty: Difficulty;
  /** A person left and the machine finished the race in their seat. Theirs again if they return. */
  takenOver: boolean;
  /** False once a person's socket drops. A bot seat is always connected. */
  connected: boolean;
}

export interface Room {
  /** The 4-digit code the invite carries. */
  code: string;
  seats: Seat[];
  /** How long the lobby waits for more people. */
  waitMs: number;
  /** The moment the room opened, on the caller's clock. */
  openedAt: number;
  /** True once the seats were frozen and the race started. */
  launched: boolean;
  botTier: BotTier;
}

/** Who a seat is when the room is minted. A human seat is the host's; the rest start vacant. */
export interface SeatSpec {
  kind: SeatKind;
  id: string;
  name: string;
  difficulty?: Difficulty;
}

export interface RoomInit {
  code: string;
  /** How many seats the room plays. Clamped to `MIN_SEATS`..`MAX_SEATS`. */
  seats: number;
  /** The host's own seat — seat 0 unless a caller says otherwise. */
  host?: SeatSpec;
  /** Who plays the rest. `null` leaves them vacant for the backfill to fill. */
  opponents?: ReadonlyArray<SeatSpec | null>;
  waitMs?: number;
  botTier?: BotTier;
  now?: number;
}

/* ---------- seats ---------- */

const clampSeats = (n: number): number =>
  Math.max(MIN_SEATS, Math.min(MAX_SEATS, Math.floor(n) || MIN_SEATS));

/** A vacant seat: a person's place, held open until the backfill takes it. */
function vacantSeat(index: number, difficulty: Difficulty): Seat {
  return { index, kind: 'human', id: '', name: '', difficulty, takenOver: false, connected: false };
}

/** A machine seat, backfilled into a vacancy. `Bot` for the first, then `Bot 2`, `Bot 3` — the same
 *  labels the dock has always given the extra seats a party adds. */
function botSeat(index: number, difficulty: Difficulty): Seat {
  return {
    index, kind: 'bot', id: `bot:${index}`, name: index === 1 ? 'Bot' : `Bot ${index}`,
    difficulty, takenOver: false, connected: true,
  };
}

export function createRoom(init: RoomInit): Room {
  const size = clampSeats(init.seats);
  const difficulty: Difficulty = 'normal';
  const seats: Seat[] = [];
  for (let i = 0; i < size; i++) {
    const spec = i === 0 ? init.host : init.opponents?.[i - 1] ?? null;
    if (!spec) { seats.push(vacantSeat(i, difficulty)); continue; }
    seats.push({
      index: i,
      kind: spec.kind,
      id: spec.id,
      name: spec.name,
      difficulty: spec.difficulty ?? difficulty,
      takenOver: false,
      connected: true,
    });
  }
  return {
    code: init.code,
    seats,
    waitMs: init.waitMs ?? ROOM_WAIT_MS,
    openedAt: init.now ?? 0,
    launched: false,
    botTier: init.botTier ?? DEFAULT_BOT_TIER,
  };
}

/** Is this seat played by the machine — backfilled with a bot, or taken over from a person? */
export const isAutomated = (room: Room, index: number): boolean => {
  const seat = room.seats[index];
  return !!seat && (seat.kind === 'bot' || seat.takenOver);
};

/**
 * Is a person holding this seat right now? Distinct from `!isAutomated`: a seat nobody has taken is
 * neither a person's nor the machine's, and the two questions have to stay apart — one decides who
 * wears a bot badge, the other decides who may play a turn.
 */
export const isHuman = (room: Room, index: number): boolean => {
  const seat = room.seats[index];
  return !!seat && seat.kind === 'human' && !seat.takenOver && seat.id !== '';
};

/** Seats nobody has taken yet. */
export const vacantSeats = (room: Room): number[] =>
  room.seats.filter((s) => s.kind === 'human' && s.id === '' && !s.takenOver).map((s) => s.index);

/** Seats a person is holding. A vacancy is not one of them, which is what the lobby caption counts. */
export const humanCount = (room: Room): number =>
  room.seats.reduce((n, _s, i) => n + (isHuman(room, i) ? 1 : 0), 0);

/** Seats the machine is holding: backfilled bots, plus every seat a person walked out of. */
export const botCount = (room: Room): number =>
  room.seats.reduce((n, _s, i) => n + (isAutomated(room, i) ? 1 : 0), 0);

/**
 * The tier the machine takes at a seat: the room's flat tier, or — on `mixed` — the next rung of the
 * ladder, counted off the machine seats already sitting *before* this one. Counting only what comes
 * before is what lets `backfill` hand out the rungs as it fills, seat by seat: the seat being filled
 * is still vacant at the moment its own tier is decided.
 */
function tierFor(room: Room, index: number): Difficulty {
  if (room.botTier !== 'mixed') return room.botTier;
  const before = room.seats.filter((s, i) => i < index && (s.kind === 'bot' || s.takenOver)).length;
  return before % 2 === 0 ? 'hard' : 'normal';
}

/**
 * The level a seat plays at. A person keeps their own pick. An automated seat takes the room's tier
 * — and on `mixed` it takes a rung of the ladder instead of a copy of one opponent: the first
 * machine seat is Hard, the next Normal, then Hard again. That is the "dynamic difficulty" a room
 * setting buys: a solo host filling three seats faces three different brains, not three of one.
 */
export function difficultyFor(room: Room, index: number): Difficulty {
  const seat = room.seats[index];
  if (!seat) return 'normal';
  return isAutomated(room, index) ? tierFor(room, index) : seat.difficulty;
}

/* ---------- the lobby lifecycle ---------- */

/**
 * A person took an open seat. Seats are only ever handed out while the room is open — a launched
 * roster is frozen — and never to a seat a bot already holds, so a late arrival cannot displace the
 * backfill. A no-op when the seat is not actually open, which keeps the caller free of guards.
 */
export function seatHuman(room: Room, index: number, spec: SeatSpec): Room {
  const seat = room.seats[index];
  if (!seat || room.launched || seat.kind === 'bot' || seat.id !== '') return room;
  const seats: Seat[] = room.seats.map((s, i) => (i === index
    ? { ...s, kind: 'human' as const, id: spec.id, name: spec.name, connected: true }
    : s));
  return { ...room, seats };
}

/** Freeze the seats: the race is on and the roster stops changing. */
export const launch = (room: Room): Room => (room.launched ? room : { ...room, launched: true });

/**
 * Fill every seat still empty with a bot. Idempotent — a room that is already full comes back
 * untouched — and it never touches a seat a person is holding, or one a person has been taken over
 * in. The seats are filled one at a time so each bot's own tier is resolved against the seats the
 * ones before it already took: that is what makes a `mixed` room come out Hard, Normal, Hard
 * instead of three copies of the first answer.
 */
export function backfill(room: Room): Room {
  let next = room;
  for (const i of vacantSeats(room)) {
    const seats = next.seats.map((s, j) => (j === i ? botSeat(i, tierFor(next, i)) : s));
    next = { ...next, seats };
  }
  return next;
}

/** The host pressed Start: fill the room and go, without waiting out the timer. */
export const startEarly = (room: Room): Room => launch(backfill(room));

/**
 * The clock moved. Once the wait has run out the room fills itself and launches — nobody is left
 * holding a seat for a stranger who is not coming. A launched room ignores the clock entirely.
 */
export function tick(room: Room, now: number): Room {
  if (room.launched) return room;
  return now - room.openedAt >= room.waitMs ? startEarly(room) : room;
}

/** How long the room still has to wait, in ms; 0 once it has launched. */
export const waitLeft = (room: Room, now: number): number =>
  room.launched ? 0 : Math.max(0, room.waitMs - (now - room.openedAt));

/**
 * A person left mid-race. The seat is not abandoned — it becomes the machine's, at the room's own
 * tier, so the other contenders finish the race they started instead of watching it die. The seat
 * keeps the leaver's name and id: it is still *their* seat, and they can take it back.
 */
export function takeover(room: Room, index: number): Room {
  const seat = room.seats[index];
  if (!seat || seat.kind === 'bot') return room;
  const seats = room.seats.map((s, i) => (i === index ? { ...s, takenOver: true, connected: false } : s));
  return { ...room, seats };
}

/** A person came back to a seat the machine was holding for them. */
export function reconnect(room: Room, index: number, id?: string): Room {
  const seat = room.seats[index];
  if (!seat || seat.kind === 'bot') return room;
  const seats = room.seats.map((s, i) => (i === index
    ? { ...s, takenOver: false, connected: true, id: id ?? s.id }
    : s));
  return { ...room, seats };
}

/* ---------- what the rest of the app reads ---------- */

/**
 * May this seat be paid a win? A Star, a trophy or a rung on the ladder only ever goes to a person
 * who was there to the end: a backfilled bot claims nothing, and a seat a person walked out of and
 * the machine finished is not a person's win either. This is the guard that keeps machine seats out
 * of the human standings.
 */
export const rewardEligible = (room: Room, index: number): boolean => {
  const seat = room.seats[index];
  return !!seat && seat.kind === 'human' && !seat.takenOver && seat.connected;
};

/** The seat's badge, or null for a person's own seat: what the dock paints the machine's seats with. */
export const seatBadge = (room: Room, index: number): 'bot' | 'takeover' | null => {
  const seat = room.seats[index];
  if (!seat) return null;
  if (seat.kind === 'bot') return 'bot';
  return seat.takenOver ? 'takeover' : null;
};

/** The seat's display name — a person's own, or the machine's numbered one. */
export const seatName = (room: Room, index: number): string => room.seats[index]?.name ?? '';

/** The board a room plays on: one ball per seat, in seat order. */
export const sizesOf = (room: Room): number[] => room.seats.map(() => 1);

/** What the lobby caption reads: `2 of 4 seats taken · bots fill the rest in 6s`. */
export function lobbyLine(room: Room, now: number): string {
  const humans = humanCount(room);
  const total = room.seats.length;
  if (room.launched) return `${total}-seat race · ${humans} human${humans === 1 ? '' : 's'}, ${botCount(room)} bot${botCount(room) === 1 ? '' : 's'}`;
  const left = Math.ceil(waitLeft(room, now) / 1000);
  return `${humans} of ${total} seats taken · bots fill the rest in ${left}s`;
}

/* ---------- the authoritative race behind a room ---------- */

/** One seat's action, as the driver accepted and played it. */
export interface RoomEvent { seat: Player; action: Action }

export type SubmitResult =
  | { ok: true; events: RoomEvent[] }
  | { ok: false; reason: 'over' | 'not_your_turn' | 'automated' | 'illegal' };

export interface RoomDriver {
  readonly state: GameState;
  /** Whose turn it is. */
  readonly turn: Player;
  /** Whether the machine owns the seat that is up. */
  readonly botTurn: boolean;
  /** A person's action. Refused unless it is their turn and the machine does not hold the seat. */
  submit(seat: Player, action: Action): SubmitResult;
  /** Play every automated seat that is due. Returns the turns it played, in order. */
  runBots(): RoomEvent[];
  /** A person dropped: the machine takes the seat over and the race carries on. */
  drop(seat: Player): boolean;
  /** A person came back. */
  resume(seat: Player, id?: string): boolean;
  /** May this seat be paid the win? */
  payable(seat: Player): boolean;
  /** The room, with any takeovers applied. */
  readonly room: Room;
}

/**
 * The most machine turns one `runBots()` call will play before handing back. Four seats means at
 * most three bots in a row, so this is a runaway guard rather than a limit anything reaches.
 */
export const BOT_TURN_BUDGET = 8;

/**
 * Put a room on the board. The driver owns the authoritative `GameState` — the same rules module
 * the clients run, from the same seed — so every action it accepts has already been judged.
 *
 * The one behaviour worth naming: `submit()` plays the machine's answer itself, in the same call.
 * A person's turn and the three bot turns that follow it arrive as one batch, so a room of four
 * never has to hand the turn back to a timer, a socket or a client to keep moving, and the clock
 * that governs a person's turn is never charged for the machine's.
 */
export function createRoomDriver(room: Room): RoomDriver {
  /* Launching here is deliberate: a driver is only ever asked for by a room that is about to be
     played, and a seat nobody took must be the machine's before a turn can land on it. */
  let current = backfill(launch(room));
  let state = newGame(sizesOf(current));

  const mineSeat = (seat: Player) => !isHuman(current, seat);

  /** The machine's turn for the seat that is up, from the seat's own side of the fog. */
  function botMove(seat: Player): Action {
    const level = difficultyFor(current, seat);
    const a = botAction(view(state, seat), level);
    if (apply(state, a)) return a;
    /* A bot only sees its own side of the fog, so the mine it picked can sit on a square a rival
       had already mined and the rules will refuse it. Carry on racing rather than throw the turn. */
    for (const action of fallbacks(state, seat)) if (apply(state, action)) return action;
    return { kind: 'pass' };
  }

  function fallbacks(s: GameState, seat: Player): Action[] {
    const out: Action[] = [];
    for (const st of steps(s, seat)) out.push({ kind: 'move', ball: st.ball, to: st.to });
    out.push({ kind: 'pass' });
    return out;
  }

  function playOne(seat: Player, action: Action): boolean {
    const next = apply(state, action);
    if (!next) return false;
    state = next;
    return true;
  }

  /** Play every automated seat that is due, bounded by `BOT_TURN_BUDGET`. */
  function runBots(): RoomEvent[] {
    const played: RoomEvent[] = [];
    for (let i = 0; i < BOT_TURN_BUDGET && state.winner === null && mineSeat(state.turn); i++) {
      const seat = state.turn;
      const action = botMove(seat);
      if (!playOne(seat, action)) break;
      played.push({ seat, action });
    }
    return played;
  }

  return {
    get state() { return state; },
    get turn() { return state.turn; },
    get botTurn() { return state.winner === null && mineSeat(state.turn); },
    get room() { return current; },
    submit(seat, action) {
      if (state.winner !== null) return { ok: false, reason: 'over' };
      if (seat !== state.turn) return { ok: false, reason: 'not_your_turn' };
      if (mineSeat(seat)) return { ok: false, reason: 'automated' };
      if (!playOne(seat, action)) return { ok: false, reason: 'illegal' };
      const events: RoomEvent[] = [{ seat, action }, ...runBots()];
      return { ok: true, events };
    },
    runBots,
    drop(seat) {
      if (state.winner !== null) return false;
      if (!isHuman(current, seat)) return false;
      current = takeover(current, seat);
      return true;
    },
    resume(seat, id) {
      if (!current.seats[seat] || current.seats[seat].kind === 'bot') return false;
      current = reconnect(current, seat, id);
      return true;
    },
    payable(seat) { return rewardEligible(current, seat); },
  };
}
