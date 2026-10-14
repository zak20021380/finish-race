/**
 * rules.ts — pure game logic. No DOM, no timers, no network.
 *
 * Coordinates: cell (c, r); c = 0..cols-1 left→right, r = 0..rows-1 top→bottom. Row 0 is FINISH.
 * `cols` and `rows` are NOT constants: the board grows with the race. Two contenders keep the
 * classic 8x12 duel board; three or four play the wider 10x12 one, which is what gives the extra
 * balls room to spread without traffic-jamming on turn 1. Every helper that walks the board takes
 * the dimensions it should walk (`s.cols` / `s.rows`), never a module constant — see `dimsFor`.
 *
 * Teams: 1 to 4 teams of 1 to 4 balls each. Every team starts spread across the bottom rows and
 * races any one of its balls to the top. Teams alternate turns; on its turn a team moves ANY ONE
 * of its balls one cell, places a wall from its budget of `wallBudget(contenders)`, or buries a
 * mine from its budget of `CONFIG.MINES_PER_TEAM` (see the mine section below).
 *
 * Walls sit ON grid lines and are 2 cells long:
 *   'h' wall {x, y}: horizontal, on the line above row y (y = 1..rows-1), covers columns x and x+1.
 *   'v' wall {x, y}: vertical, on the line left of column x (x = 1..cols-1), covers rows y and y+1.
 * A wall owns both of its edge segments and the vertex they hinge on, so two walls may meet at an
 * L-corner or a T-junction but never share an edge segment, and never cross through one shared
 * vertex into a `+`. See `wallsOverlap` / `wallsCross`.
 *
 * Mines are hidden traps: a team buries one on any cell that holds no ball and no live mine, never
 * in the top two or bottom two rows. They do not block movement — a ball that steps onto one sets
 * it off, is thrown `CONFIG.KNOCKBACK` cells straight down the column (shortened by a horizontal
 * wall, the bottom edge or another ball), and the mine is spent. The blast never chains.
 * Opponent mines are secret: clients get `view(state, team)`, never the raw state.
 *
 * The wide rolling log (opt-in: `newGame(sizes, { hazards: true, seed })`) is a public hazard on
 * a timetable derived from that seed alone — see `hazards.ts`. A round is one turn per team; rounds
 * 1 and 2 stay hazard-free. Nothing is telegraphed: when the last team of a timed round acts, the
 * lane is drawn from the seed and drops on the spot, shoving every ball above the first blocking
 * wall back down its own column. Ranked and normal play pass no `hazards` flag and behave exactly
 * as before.
 *
 * Multiplayer later: send an `Action` over the wire and feed whatever comes back into `apply()`.
 */
import { initPhase, tickHazard } from './hazards';
import type { HazardPhase, LogEvent } from './hazards';

export { HAZARD, logStopRow } from './hazards';
export type { HazardPhase, Lane, LogEvent, LogMove } from './hazards';


/** The classic duel board: 8 columns, 12 rows, FINISH on row 0. */
export const COLS = 8;
export const ROWS = 12;
/** The board three or more contenders race on: two columns wider, same height, same pacing. */
export const WIDE_COLS = 10;
export const WIDE_ROWS = 12;
/** Team and ball counts the rules accept; the start-layout helper fills the bottom rows. */
export const MAX_TEAMS = 4;
export const MAX_BALLS = 3;
/** Engine tunables, in one place so the server and the client never disagree. */
export const CONFIG = {
  /** Walls each team may place per race in a two-contender duel — the classic budget. */
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

/** How big a board is: the only two numbers that describe the grid. */
export interface Dims { cols: number; rows: number }

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
  /** How wide the board is: 8 in a duel, 10 once three or more contenders race. */
  cols: number;
  /** How tall the board is. Row 0 is FINISH, the bottom row is where the balls start. */
  rows: number;
  teams: TeamMeta[];
  balls: Ball[];
  walls: Wall[];
  /** Walls each team still has to place, indexed by player; starts at `wallBudget(contenders)`. */
  wallsLeft: number[];
  /** Every mine ever buried, including the spent ones; opponent mines are hidden by `view()`. */
  mines: Mine[];
  turn: Player;
  winner: Player | null;
  /** The rolling log's clock; absent unless the race was set up with `hazards`. */
  hazard?: HazardPhase;
  /** The log that last went off, kept so the UI can animate it. Public info, unlike `mines`. */
  lastEvent?: LogEvent | null;
}

export const nextTeam = (s: GameState, t: Player): number => (t + 1) % s.teams.length;

const clampSize = (n: number) => Math.max(1, Math.min(MAX_BALLS, Math.floor(n) || 1));

/* ---------- board size ---------- */

/**
 * How many balls a race puts on the board. This — not the number of seats — is what the grid is
 * sized to: it is the balls that traffic-jam, so a 2v2 needs the room a 4-way does.
 */
export const contendersIn = (sizes: readonly number[]): number =>
  sizes.slice(0, MAX_TEAMS).reduce((n, size) => n + clampSize(size), 0);

/**
 * The board a race is played on. Two contenders keep the classic duel board, so 1v1 pacing is
 * exactly what it always was; three or more move to the wider one, which is the breathing room
 * that lets the extra balls spread out instead of queueing behind each other on turn 1.
 */
export function dimsFor(contenders: number): Dims {
  return contenders >= 3 ? { cols: WIDE_COLS, rows: WIDE_ROWS } : { cols: COLS, rows: ROWS };
}

/** Walls each seat may place, by contenders on the board: 2 → 8, 3 → 6, 4 or more → 5. */
const WALL_TIERS: readonly number[] = [CONFIG.WALL_LIMIT, CONFIG.WALL_LIMIT, 6, 5];
export function wallBudget(contenders: number): number {
  const i = Math.max(0, Math.min(WALL_TIERS.length - 1, Math.floor(contenders) - 1));
  return WALL_TIERS[i];
}

/**
 * The columns `count` start squares sit on: spread evenly across the board with a lane between
 * them, so two balls never begin glued together in adjacent middle cells. Two balls keep the
 * widest gap — 2 and 5 on the classic eight-column board, with a two-tile hole in the middle —
 * while three and four fill in between (1, 5, 8 and 1, 3, 6, 8 on the ten-column one).
 */
export function spawnColumns(cols: number, count: number): number[] {
  if (count <= 0 || cols <= 0) return [];
  if (count === 1) return [Math.floor((cols - 1) / 2)];
  /* Two balls keep clear of the corners; a crowd cannot afford the margin and keeps its lanes instead. */
  const margin = count === 2 ? 2 : count <= 4 ? 1 : 0;
  const lo = Math.min(margin, cols - 1);
  const hi = Math.max(lo, cols - 1 - margin);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(lo + Math.round((i * (hi - lo)) / (count - 1)));
  return out;
}

/** `n` columns picked evenly out of an ascending list, never two of them side by side. */
function spreadOf(list: readonly number[], n: number): number[] {
  const out: number[] = [];
  if (n <= 0 || !list.length) return out;
  let prev = -1;
  for (let i = 0; i < n; i++) {
    let idx = n === 1 ? Math.floor((list.length - 1) / 2) : Math.round((i * (list.length - 1)) / (n - 1));
    if (idx <= prev) idx = prev + 1;                        // strictly forward: never a repeat
    if (prev >= 0 && idx < list.length && list[idx] - list[prev] < 2) idx++;   // and never beside it
    if (idx >= list.length) return out;                     // the list ran out
    out.push(list[idx]);
    prev = idx;
  }
  return out;
}

/**
 * Spread every ball across the bottom of the board: one row while the balls can still keep a lane
 * between them, more above that, evenly spaced and never glued together. Seats are filled in turn,
 * so the classic 1v1 lands on (2, rows-1) and (5, rows-1) — symmetric, with a two-tile gap where
 * the two balls used to sit shoulder to shoulder — and a 4-way spreads over columns 1, 3, 6 and 8.
 * Rows above the first draw from the columns the rows below left free, so no ball starts directly
 * above another one while the board has room for that.
 */
export function startLayout(sizes: readonly number[], cols: number = COLS, rows: number = ROWS): Pos[][] {
  const out: Pos[][] = sizes.map(() => []);
  const total = sizes.reduce((n, size) => n + Math.max(0, Math.floor(size) || 0), 0);
  if (total <= 0 || cols <= 0 || rows <= 0) return out;
  /* One row holds at most half the columns rounded up: past that the balls would have to touch. */
  const capacity = Math.max(1, Math.ceil(cols / 2));
  const rowCount = Math.min(rows, Math.max(1, Math.ceil(total / capacity)));
  const perRow = Math.ceil(total / rowCount);
  const slots: Pos[] = [];
  const used = new Set<number>();
  for (let j = 0; j < rowCount; j++) {
    const n = Math.min(perRow, total - j * perRow);
    if (n <= 0) break;
    const free: number[] = [];
    for (let c = 0; c < cols; c++) if (!used.has(c)) free.push(c);
    let pick = j === 0 ? spawnColumns(cols, n) : spreadOf(free, n);
    /* an over-crowded board cannot avoid reusing a column: fall back to the plain spread */
    if (pick.length < n) pick = spawnColumns(cols, n);
    for (const c of pick) {
      used.add(c);
      slots.push({ c, r: rows - 1 - j });
    }
  }
  const max = Math.max(...sizes, 1);
  let placed = 0;
  for (let i = 0; i < max; i++) {
    for (let t = 0; t < sizes.length; t++) {
      if (i >= sizes[t] || placed >= slots.length) continue;
      out[t].push({ ...slots[placed++] });
    }
  }
  return out;
}

export function newGame(sizes: readonly number[] = [1, 1], setup: GameSetup = {}): GameState {
  const n = sizes.slice(0, MAX_TEAMS).map(clampSize);
  const contenders = n.reduce((a, b) => a + b, 0);
  const { cols, rows } = dimsFor(contenders);
  const layout = startLayout(n, cols, rows);
  const balls: Ball[] = [];
  for (let t = 0; t < n.length; t++) {
    for (let i = 0; i < n[t]; i++) {
      balls.push({ id: balls.length, team: t, owner: t, pos: layout[t][i] });
    }
  }
  const budget = wallBudget(contenders);
  const s: GameState = {
    cols,
    rows,
    teams: n.map((balls) => ({ balls })),
    balls,
    walls: [],
    wallsLeft: n.map(() => budget),
    mines: [],
    turn: 0,
    winner: null,
    lastEvent: null,
  };
  if (setup.hazards) s.hazard = initPhase(setup.seed ?? 0, cols);
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

/**
 * The lattice wall edges and wall segments are keyed on: the largest board the rules lay out.
 * A key is then unique on every board, so the pure geometry predicates (`wallsClash` and friends)
 * need no dimensions at all — they compare walls that were always drawn on the same board.
 */
const LATTICE_C = Math.max(COLS, WIDE_COLS);
const LATTICE_R = Math.max(ROWS, WIDE_ROWS);

function blocks(walls: readonly Wall[]): Blocks {
  const h = new Set<number>();
  const v = new Set<number>();
  for (const w of walls) {
    if (w.o === 'h') { h.add(w.y * LATTICE_C + w.x); h.add(w.y * LATTICE_C + w.x + 1); }
    else { v.add(w.x * LATTICE_R + w.y); v.add(w.x * LATTICE_R + w.y + 1); }
  }
  return { h, v };
}

function canStep(b: Blocks, c: number, r: number, dc: number, dr: number, cols: number, rows: number): boolean {
  const nc = c + dc, nr = r + dr;
  if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) return false;
  if (dr === -1) return !b.h.has(r * LATTICE_C + c);
  if (dr === 1) return !b.h.has((r + 1) * LATTICE_C + c);
  if (dc === -1) return !b.v.has(c * LATTICE_R + r);
  return !b.v.has((c + 1) * LATTICE_R + r);
}

/**
 * BFS distance-to-FINISH for every cell (index = r*cols + c). -1 = unreachable. Balls are ignored.
 * The dimensions are the board's own, so the same walk serves the 8-column duel and the 10-column
 * three- and four-contender boards.
 */
export function distField(walls: readonly Wall[], cols: number, rows: number): Int16Array {
  const b = blocks(walls);
  const d = new Int16Array(cols * rows).fill(-1);
  const q: number[] = [];
  for (let c = 0; c < cols; c++) { d[c] = 0; q.push(c); }
  for (let i = 0; i < q.length; i++) {
    const id = q[i], c = id % cols, r = (id / cols) | 0;
    for (const [dc, dr] of DIRS) {
      if (!canStep(b, c, r, dc, dr, cols, rows)) continue;
      const n = (r + dr) * cols + c + dc;
      if (d[n] < 0) { d[n] = d[id] + 1; q.push(n); }
    }
  }
  return d;
}

/** Shortest path length from a cell to FINISH (Infinity if sealed in). */
export const pathOn = (d: Int16Array, pos: Pos, cols: number): number => {
  const v = d[pos.r * cols + pos.c];
  return v < 0 ? Infinity : v;
};

/**
 * Does every ball on the board still have a route to FINISH with `walls` standing? This is the
 * goal-path guard: a wall is only legal while this stays true, so no number of walls can ever
 * freeze a race, on either board size.
 */
export function hasPathToFinish(s: GameState, walls: readonly Wall[] = s.walls): boolean {
  const d = distField(walls, s.cols, s.rows);
  return s.balls.every((b) => d[b.pos.r * s.cols + b.pos.c] >= 0);
}

/** One ball's distance to FINISH (Infinity if sealed in). */
export function ballPath(s: GameState, ball: Ball): number {
  return pathOn(distField(s.walls, s.cols, s.rows), ball.pos, s.cols);
}

/** A team's distance to FINISH: its nearest ball — what a race is judged on. */
export function pathLen(s: GameState, team: Player): number {
  const d = distField(s.walls, s.cols, s.rows);
  let best = Infinity;
  for (const b of s.balls) if (b.team === team) best = Math.min(best, pathOn(d, b.pos, s.cols));
  return best;
}

/* ---------- wall geometry ---------- */

/**
 * A grid vertex: where the line left of column `x` crosses the line above row `y`. Walls are named
 * by cells, but they collide on the lattice of these vertices, so the lattice gets a name too.
 */
export interface Vertex { x: number; y: number }

/** The three vertices a wall spans — both ends and the hinge between them. */
export function wallVertices(w: WallSpec): [Vertex, Vertex, Vertex] {
  return w.o === 'h'
    ? [{ x: w.x, y: w.y }, { x: w.x + 1, y: w.y }, { x: w.x + 2, y: w.y }]
    : [{ x: w.x, y: w.y }, { x: w.x, y: w.y + 1 }, { x: w.x, y: w.y + 2 }];
}

/**
 * The vertex a wall's two segments hinge on — its midpoint, and the one point a perpendicular wall
 * could cross it at. An 'h' wall at (x, y) hinges on (x + 1, y); a 'v' wall at (x, y) on (x, y + 1).
 */
export const wallPivot = (w: WallSpec): Vertex =>
  (w.o === 'h' ? { x: w.x + 1, y: w.y } : { x: w.x, y: w.y + 1 });

/** Vertical edge segments are keyed above the horizontal ones, so the two families never collide. */
const SEG_V = LATTICE_C * LATTICE_R;

/** A wall's two edge segments as keys. `out` is written in place: the bot calls this in a loop. */
function wallSegments(w: WallSpec, out: [number, number]): [number, number] {
  out[0] = w.o === 'h' ? w.y * LATTICE_C + w.x : SEG_V + w.x * LATTICE_R + w.y;
  out[1] = out[0] + 1;
  return out;
}

const _segA: [number, number] = [0, 0];
const _segB: [number, number] = [0, 0];

/**
 * Do two walls share an edge segment? Only collinear walls can, and then they lie on top of each
 * other for one or both of their segments. Touching end to end (x and x + 2) is not an overlap.
 */
export function wallsOverlap(a: WallSpec, b: WallSpec): boolean {
  if (a.o !== b.o) return false;
  wallSegments(a, _segA);
  wallSegments(b, _segB);
  return _segA[0] === _segB[0] || _segA[0] === _segB[1] || _segA[1] === _segB[0] || _segA[1] === _segB[1];
}

/**
 * Do two perpendicular walls cross through the same vertex? Sharing a pivot is the illegal `+`:
 * both walls would run straight through the point instead of stopping at it. A T-junction and an
 * L-corner share a vertex but never a pivot — one wall ends where the other passes — so they stand.
 */
export function wallsCross(a: WallSpec, b: WallSpec): boolean {
  if (a.o === b.o) return false;
  const p = wallPivot(a), q = wallPivot(b);
  return p.x === q.x && p.y === q.y;
}

/** May these two walls stand on the board together? No shared edge, and no `+` through a vertex. */
export const wallsClash = (a: WallSpec, b: WallSpec): boolean => wallsOverlap(a, b) || wallsCross(a, b);

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
      if (!canStep(b, ball.pos.c, ball.pos.r, dc, dr, s.cols, s.rows)) continue;
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
    const k = to.r * s.cols + to.c;
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

/**
 * Is this wall legal? Within the owner's budget, in bounds for THIS board, clear of every wall
 * already standing (no shared edge segment, no `+` through a vertex) and every ball keeps a path.
 */
export function wallOk(s: GameState, w: Wall): boolean {
  if (s.winner !== null) return false;
  if (wallsRemaining(s, w.owner) <= 0) return false;
  if (w.o === 'h') {
    if (w.x < 0 || w.x > s.cols - 2 || w.y < 1 || w.y > s.rows - 1) return false;
  } else if (w.x < 1 || w.x > s.cols - 1 || w.y < 0 || w.y > s.rows - 2) return false;

  for (const o of s.walls) if (wallsClash(o, w)) return false;
  return hasPathToFinish(s, [...s.walls, w]);
}

/** Every wall position on the board (legal or not) for the given owner. */
export function allWalls(owner: Player, cols: number = COLS, rows: number = ROWS): Wall[] {
  const out: Wall[] = [];
  for (let y = 1; y < rows; y++) for (let x = 0; x <= cols - 2; x++) out.push({ o: 'h', x, y, owner });
  for (let x = 1; x < cols; x++) for (let y = 0; y <= rows - 2; y++) out.push({ o: 'v', x, y, owner });
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
  for (let r = MINE_ZONE; r < s.rows - MINE_ZONE; r++) {
    for (let c = 0; c < s.cols; c++) if (mineOk(s, { c, r }, owner)) out.push({ c, r });
  }
  return out;
}

/** Is this mine legal? Within the owner's budget, off the finish and the start, on an empty cell. */
export function mineOk(s: GameState, cell: Cell, owner: Player = s.turn): boolean {
  if (s.winner !== null) return false;
  if (minesLeft(s, owner) <= 0) return false;
  if (cell.c < 0 || cell.c >= s.cols || cell.r < MINE_ZONE || cell.r >= s.rows - MINE_ZONE) return false;
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
    if (!canStep(b, at.c, at.r, 0, 1, s.cols, s.rows)) break;
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
  const d = distField(s.walls, s.cols, s.rows);
  const to = (st: Step) => pathOn(d, st.to, s.cols);
  /** 0 = gaining ground on FINISH, 1 = holding position, 2 = giving it up. */
  const tier = (st: Step): number => {
    const ball = ballById(s, st.ball);
    const from = ball ? pathOn(d, ball.pos, s.cols) : Infinity;
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
