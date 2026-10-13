/**
 * rules.ts — pure game logic. No DOM, no timers, no network.
 *
 * Coordinates: cell (c, r); c = 0..COLS-1 left→right, r = 0..ROWS-1 top→bottom.
 * Row 0 is FINISH.
 *
 * Teams: 1 to 3 teams of 1 to 3 balls each (max 3v3). Every team starts spread across the bottom
 * two rows and races any one of its balls to the top. Teams alternate turns; on its turn a team
 * moves ANY ONE of its balls one cell, places a wall from its budget of `CONFIG.WALL_LIMIT`, or
 * buries a mine from its budget of `CONFIG.MINES_PER_TEAM` (see the mine section below).
 *
 * Walls sit ON grid lines and are 2 cells long:
 *   'h' wall {x, y}: horizontal, on the line above row y (y = 1..ROWS-1), covers columns x and x+1.
 *   'v' wall {x, y}: vertical, on the line left of column x (x = 1..COLS-1), covers rows y and y+1.
 * Walls may touch and cross, but never overlap along the same line.
 *
 * Mines are hidden traps: a team buries one on any cell that holds no ball and no live mine, never
 * in the top two or bottom two rows. They do not block movement — a ball that steps onto one sets
 * it off, is thrown `CONFIG.KNOCKBACK` cells straight down the column (shortened by a horizontal
 * wall, the bottom edge or another ball), and the mine is spent. The blast never chains.
 * Opponent mines are secret: clients get `view(state, team)`, never the raw state.
 *
 * The wide rolling log (opt-in: `newGame(sizes, { hazards: true, seed })`) is a public hazard on
 * a timetable derived from that seed alone — see `hazards.ts`. A round is one turn per team; rounds
 * 1 and 2 stay hazard-free. A 3-column lane is telegraphed for a whole round and the log rolls down
 * all its columns at once when the last team of that round has acted, shoving every ball above the
 * first blocking wall back down its own column. Ranked and normal play pass no `hazards` flag and
 * behave exactly as before.
 *
 * Multiplayer later: send an `Action` over the wire and feed whatever comes back into `apply()`.
 */
import { initPhase, tickHazard } from './hazards';
import type { HazardPhase, LogEvent } from './hazards';

export { HAZARD, logStopRow } from './hazards';
export type { HazardPhase, LogEvent, LogMove, Pending } from './hazards';


export const COLS = 8;
export const ROWS = 12;
/** Team and ball counts the rules accept; the start-layout helper fills the bottom two rows. */
export const MAX_TEAMS = 3;
export const MAX_BALLS = 3;
/** Engine tunables, in one place so the server and the client never disagree. */
export const CONFIG = {
  /** Walls each team may place per race. */
  WALL_LIMIT: 8,
  /** Mines each team may bury per race. */
  MINES_PER_TEAM: 3,
  /** Cells a ball is thrown straight down the column when it sets off a mine. */
  KNOCKBACK: 3,
  /** Seconds a seat gets to act before `getAutoMove()` plays the turn for it. */
  TURN_TIME_LIMIT: 8,
} as const;
/** A mine may not be buried in the top or bottom this-many rows: no free wins, no point-blank traps. */
const MINE_ZONE = 2;

/** A team index — the seat a ball, wall, turn or win belongs to. */
export type Player = number;
export interface Pos { c: number; r: number }
/** A board square named for what sits on it rather than for a ball that is standing there. */
export type Cell = Pos;
export interface WallSpec { o: 'h' | 'v'; x: number; y: number }
export interface Wall extends WallSpec { owner: Player }
export interface Mine { cell: Cell; owner: Player; triggered: boolean }

export interface Ball {
  id: number;
  team: Player;
  /** who controls the ball; today the team itself, a user id when play goes online */
  owner: Player;
  pos: Pos;
}

export interface TeamMeta { balls: number }

/** What a seat may ask for when the race is set up. Every switch defaults to plain, ranked play. */
export interface GameSetup {
  /** Opt the race into the rolling log. Off keeps the rules byte-for-byte the old ones. */
  hazards?: boolean;
  /** The log timetable is derived from this alone, so a server and its clients can agree on it. */
  seed?: number;
}

export type Action =
  | { kind: 'move'; ball?: number; to: Pos }
  | { kind: 'wall'; wall: Wall }
  | { kind: 'mine'; cell: Cell }
  | { kind: 'pass' };

export interface GameState {
  teams: TeamMeta[];
  balls: Ball[];
  walls: Wall[];
  /** Walls each team still has to place, indexed by player; starts at `CONFIG.WALL_LIMIT`. */
  wallsLeft: number[];
  /** Every mine ever buried, including the spent ones; opponent mines are hidden by `view()`. */
  mines: Mine[];
  turn: Player;
  winner: Player | null;
  /** The rolling log's clock and telegraph; absent unless the race was set up with `hazards`. */
  hazard?: HazardPhase;
  /** The log that last went off, kept so the UI can animate it. Public info, unlike `mines`. */
  lastEvent?: LogEvent | null;
}

export const nextTeam = (s: GameState, t: Player): number => (t + 1) % s.teams.length;

const clampSize = (n: number) => Math.max(1, Math.min(MAX_BALLS, Math.floor(n) || 1));

/**
 * Spread each team's balls over the bottom two rows, centre columns first and alternating
 * between teams — the classic 1v1 lands on (3, ROWS-1) and (4, ROWS-1), exactly as always.
 */
export function startLayout(sizes: readonly number[]): Pos[][] {
  const slots: Pos[] = [];
  const centre = [3, 4, 2, 5, 1, 6, 0, 7];
  for (const r of [ROWS - 1, ROWS - 2]) for (const c of centre) slots.push({ c, r });
  const out: Pos[][] = sizes.map(() => []);
  const max = Math.max(...sizes, 1);
  let placed = 0;
  for (let i = 0; i < max; i++) {
    for (let t = 0; t < sizes.length; t++) {
      if (i >= sizes[t]) continue;
      out[t].push({ ...slots[placed++] });
    }
  }
  return out;
}

export function newGame(sizes: readonly number[] = [1, 1], setup: GameSetup = {}): GameState {
  const n = sizes.slice(0, MAX_TEAMS).map(clampSize);
  const layout = startLayout(n);
  const balls: Ball[] = [];
  for (let t = 0; t < n.length; t++) {
    for (let i = 0; i < n[t]; i++) {
      balls.push({ id: balls.length, team: t, owner: t, pos: layout[t][i] });
    }
  }
  const s: GameState = {
    teams: n.map((balls) => ({ balls })),
    balls,
    walls: [],
    wallsLeft: n.map(() => CONFIG.WALL_LIMIT),
    mines: [],
    turn: 0,
    winner: null,
    lastEvent: null,
  };
  if (setup.hazards) s.hazard = initPhase(setup.seed ?? 0);
  return s;
}

export const ballsOf = (s: GameState, team: Player): Ball[] => s.balls.filter((b) => b.team === team);
export const ballById = (s: GameState, id: number): Ball | null => s.balls.find((b) => b.id === id) ?? null;
/** The team's i-th ball (first by default) — what the UI tracks when it only draws one per side. */
export const ballOf = (s: GameState, team: Player, index = 0): Ball => {
  let i = 0;
  for (const b of s.balls) if (b.team === team && i++ === index) return b;
  return s.balls[0];
};

/** The team's first ball, or null when it has none on the board — the turn's default pick. */
export const firstBall = (s: GameState, team: Player): Ball | null =>
  s.balls.find((b) => b.team === team) ?? null;

/* ---------- edge blocking ---------- */

interface Blocks { h: Set<number>; v: Set<number> }

const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]] as const;

function blocks(walls: readonly Wall[]): Blocks {
  const h = new Set<number>();
  const v = new Set<number>();
  for (const w of walls) {
    if (w.o === 'h') { h.add(w.y * COLS + w.x); h.add(w.y * COLS + w.x + 1); }
    else { v.add(w.x * ROWS + w.y); v.add(w.x * ROWS + w.y + 1); }
  }
  return { h, v };
}

function canStep(b: Blocks, c: number, r: number, dc: number, dr: number): boolean {
  const nc = c + dc, nr = r + dr;
  if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) return false;
  if (dr === -1) return !b.h.has(r * COLS + c);
  if (dr === 1) return !b.h.has((r + 1) * COLS + c);
  if (dc === -1) return !b.v.has(c * ROWS + r);
  return !b.v.has((c + 1) * ROWS + r);
}

/** BFS distance-to-FINISH for every cell (index = r*COLS + c). -1 = unreachable. Balls are ignored. */
export function distField(walls: readonly Wall[]): Int16Array {
  const b = blocks(walls);
  const d = new Int16Array(COLS * ROWS).fill(-1);
  const q: number[] = [];
  for (let c = 0; c < COLS; c++) { d[c] = 0; q.push(c); }
  for (let i = 0; i < q.length; i++) {
    const id = q[i], c = id % COLS, r = (id / COLS) | 0;
    for (const [dc, dr] of DIRS) {
      if (!canStep(b, c, r, dc, dr)) continue;
      const n = (r + dr) * COLS + c + dc;
      if (d[n] < 0) { d[n] = d[id] + 1; q.push(n); }
    }
  }
  return d;
}

/** Shortest path length from a cell to FINISH (Infinity if sealed in). */
export const pathOn = (d: Int16Array, pos: Pos): number => {
  const v = d[pos.r * COLS + pos.c];
  return v < 0 ? Infinity : v;
};

/** One ball's distance to FINISH (Infinity if sealed in). */
export function ballPath(s: GameState, ball: Ball): number {
  return pathOn(distField(s.walls), ball.pos);
}

/** A team's distance to FINISH: its nearest ball — what a race is judged on. */
export function pathLen(s: GameState, team: Player): number {
  const d = distField(s.walls);
  let best = Infinity;
  for (const b of s.balls) if (b.team === team) best = Math.min(best, pathOn(d, b.pos));
  return best;
}

/* ---------- queries ---------- */

export interface Step { ball: number; to: Pos }

/** Every legal step for the team: each ball's 4-neighbourhood, walls and all balls block. */
export function steps(s: GameState, team: Player = s.turn): Step[] {
  if (s.winner !== null) return [];
  const b = blocks(s.walls);
  const out: Step[] = [];
  for (const ball of s.balls) {
    if (ball.team !== team) continue;
    for (const [dc, dr] of DIRS) {
      if (!canStep(b, ball.pos.c, ball.pos.r, dc, dr)) continue;
      const to = { c: ball.pos.c + dc, r: ball.pos.r + dr };
      if (s.balls.some((o) => o.pos.c === to.c && o.pos.r === to.r)) continue;
      out.push({ ball: ball.id, to });
    }
  }
  return out;
}

/** Distinct cells the team can step into — the dots the UI shows. */
export function reachable(s: GameState, team: Player = s.turn): Pos[] {
  const seen = new Set<number>();
  const out: Pos[] = [];
  for (const { to } of steps(s, team)) {
    const k = to.r * COLS + to.c;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(to);
  }
  return out;
}

/** Legal steps for one ball of the team. */
export function reachableBall(s: GameState, ballId: number): Pos[] {
  const ball = ballById(s, ballId);
  if (!ball) return [];
  return steps(s, ball.team).filter((st) => st.ball === ballId).map((st) => st.to);
}

/** Walls a side still has to place: the budget minus what it has spent, never below zero. */
export function wallsRemaining(s: GameState, team: Player): number {
  const left = s.wallsLeft[team];
  return left === undefined ? 0 : Math.max(0, left);
}

/** Is this wall legal? Within the owner's budget, in bounds, no overlap, and every ball keeps a path. */
export function wallOk(s: GameState, w: Wall): boolean {
  if (s.winner !== null) return false;
  if (wallsRemaining(s, w.owner) <= 0) return false;
  if (w.o === 'h') {
    if (w.x < 0 || w.x > COLS - 2 || w.y < 1 || w.y > ROWS - 1) return false;
  } else if (w.x < 1 || w.x > COLS - 1 || w.y < 0 || w.y > ROWS - 2) return false;

  for (const o of s.walls) {
    if (o.o !== w.o) continue;
    if (w.o === 'h' ? o.y === w.y && Math.abs(o.x - w.x) < 2 : o.x === w.x && Math.abs(o.y - w.y) < 2) return false;
  }
  const d = distField([...s.walls, w]);
  return s.balls.every((ball) => d[ball.pos.r * COLS + ball.pos.c] >= 0);
}

/** Every wall position on the board (legal or not) for the given owner. */
export function allWalls(owner: Player): Wall[] {
  const out: Wall[] = [];
  for (let y = 1; y < ROWS; y++) for (let x = 0; x <= COLS - 2; x++) out.push({ o: 'h', x, y, owner });
  for (let x = 1; x < COLS; x++) for (let y = 0; y <= ROWS - 2; y++) out.push({ o: 'v', x, y, owner });
  return out;
}

/* ---------- mines ---------- */

/** Mines still in the ground — the spent ones are kept for the log but no longer count. */
export const liveMines = (s: GameState): Mine[] => s.mines.filter((m) => !m.triggered);

/** The live mine buried on a cell, if any. */
export const mineAt = (s: GameState, cell: Cell): Mine | null =>
  s.mines.find((m) => !m.triggered && m.cell.c === cell.c && m.cell.r === cell.r) ?? null;

/** Mines a side still has to bury: the budget minus what it has spent, never below zero. */
export function minesLeft(s: GameState, team: Player): number {
  let used = 0;
  for (const m of s.mines) if (m.owner === team) used++;
  return Math.max(0, CONFIG.MINES_PER_TEAM - used);
}

/** Cells a team may bury a mine in right now — the squares the UI can offer. */
export function mineCells(s: GameState, owner: Player = s.turn): Cell[] {
  if (s.winner !== null || minesLeft(s, owner) <= 0) return [];
  const out: Cell[] = [];
  for (let r = MINE_ZONE; r < ROWS - MINE_ZONE; r++) {
    for (let c = 0; c < COLS; c++) if (mineOk(s, { c, r }, owner)) out.push({ c, r });
  }
  return out;
}

/** Is this mine legal? Within the owner's budget, off the finish and the start, on an empty cell. */
export function mineOk(s: GameState, cell: Cell, owner: Player = s.turn): boolean {
  if (s.winner !== null) return false;
  if (minesLeft(s, owner) <= 0) return false;
  if (cell.c < 0 || cell.c >= COLS || cell.r < MINE_ZONE || cell.r >= ROWS - MINE_ZONE) return false;
  if (s.balls.some((b) => b.pos.c === cell.c && b.pos.r === cell.r)) return false;
  return mineAt(s, cell) === null;
}

/* ---------- transitions (return a new state, or null if illegal) ---------- */

/**
 * Hand the turn to the next side that can act, then let the log clock move with it: a hand-off that
 * wraps past the acting team closes the round, and closing a round is what brings down a warning.
 */
function endTurn(s: GameState, played: Player): GameState {
  if (s.winner !== null) return s;
  const n = s.teams.length;
  const canAct = (t: Player) => reachable(s, t).length > 0;
  for (let i = 1; i < n; i++) {
    const next = (played + i) % n;
    if (canAct(next)) return tickHazard({ ...s, turn: next }, played);
  }
  return tickHazard({ ...s, turn: canAct(played) ? played : (played + 1) % n }, played);
}

export function doMove(s: GameState, to: Pos, ballId?: number): GameState | null {
  const team = s.turn;
  const opts = steps(s, team).filter((st) => st.to.c === to.c && st.to.r === to.r
    && (ballId === undefined || st.ball === ballId));
  if (!opts.length) return null;
  const chosen = opts[0].ball;
  let balls = s.balls.map((b) => (b.id === chosen ? { ...b, pos: { c: to.c, r: to.r } } : b));
  let mines = s.mines;
  let landed = to;
  const hit = mineAt(s, to);
  if (hit) {
    landed = blownTo({ ...s, balls }, to);
    balls = balls.map((b) => (b.id === chosen ? { ...b, pos: landed } : b));
    mines = s.mines.map((m) => (m === hit ? { ...m, triggered: true } : m));
  }
  return endTurn({ ...s, balls, mines, winner: landed.r === 0 ? team : null }, team);
}

/**
 * Where a ball lands after the blast at `from`: up to `CONFIG.KNOCKBACK` cells straight down the
 * column, cut short by a horizontal wall, the bottom edge or another ball. `s` must already hold
 * the ball standing on the mine. The landing square is never re-checked for a second mine.
 */
function blownTo(s: GameState, from: Pos): Pos {
  const b = blocks(s.walls);
  let at = from;
  for (let i = 0; i < CONFIG.KNOCKBACK; i++) {
    const next: Pos = { c: at.c, r: at.r + 1 };
    // canStep already refuses the bottom edge and a horizontal wall on the line below.
    if (!canStep(b, at.c, at.r, 0, 1)) break;
    if (s.balls.some((o) => o.pos.c === next.c && o.pos.r === next.r)) break;
    at = next;
  }
  return at;
}

export function doWall(s: GameState, w: Wall): GameState | null {
  if (w.owner !== s.turn || !wallOk(s, w)) return null;
  const wallsLeft = s.wallsLeft.map((n, t) => (t === w.owner ? Math.max(0, n - 1) : n));
  return endTurn({ ...s, walls: [...s.walls, { ...w }], wallsLeft }, w.owner);
}

/** Bury a mine for the team on turn. The cell is the whole payload; the seat comes from the state. */
export function doMine(s: GameState, cell: Cell, owner: Player = s.turn): GameState | null {
  if (owner !== s.turn || !mineOk(s, cell, owner)) return null;
  return endTurn({ ...s, mines: [...s.mines, { cell: { ...cell }, owner, triggered: false }] }, owner);
}

/** Single entry point for local input, the bot, or (later) messages from the network. */
export function apply(s: GameState, a: Action): GameState | null {
  switch (a.kind) {
    case 'move': return doMove(s, a.to, a.ball);
    case 'wall': return doWall(s, a.wall);
    case 'mine': return doMine(s, a.cell);
    case 'pass': return s.winner === null
      ? tickHazard({ ...s, turn: nextTeam(s, s.turn) }, s.turn)
      : null;
  }
}

/**
 * The turn the engine plays for a seat whose clock ran out. Progress first: among the steps that
 * shorten a ball's path to FINISH, the one coming to rest closest to the line — so a wall that
 * forces a detour is walked around rather than answered with a sideways shuffle. A team with
 * nothing to gain takes the step that costs it least, and only passes when it cannot move at all.
 */
export function getAutoMove(s: GameState, team: Player = s.turn): Action {
  const opts = steps(s, team);
  if (!opts.length) return { kind: 'pass' };
  const d = distField(s.walls);
  const to = (st: Step) => pathOn(d, st.to);
  /** 0 = gaining ground on FINISH, 1 = holding position, 2 = giving it up. */
  const tier = (st: Step): number => {
    const ball = ballById(s, st.ball);
    const from = ball ? pathOn(d, ball.pos) : Infinity;
    const land = to(st);
    return land < from ? 0 : land === from ? 1 : 2;
  };
  const better = (a: Step, b: Step) => (tier(a) !== tier(b) ? tier(a) < tier(b) : to(a) < to(b));
  let best = opts[0];
  for (const st of opts) if (better(st, best)) best = st;
  return { kind: 'move', ball: best.ball, to: best.to };
}

/* ---------- fog of war ---------- */

/**
 * The state as one team is allowed to see it: its own mines plus the ones already set off, with
 * every opponent mine still in the ground stripped out. Nothing else changes, so the projection is
 * still a valid `GameState` the client can run the same queries against. The log is the opposite of
 * a mine — `hazard` and `lastEvent` are public and go to every seat untouched.
 *
 * SECURITY: the server must only ever send `view(state, team)` to a client — never the raw state,
 * which carries the hidden mines.
 */
export function view(s: GameState, team: Player): GameState {
  return { ...s, mines: s.mines.filter((m) => m.owner === team || m.triggered) };
}
