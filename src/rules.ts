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
 * Collisions: a ball may not walk into another ball. An OPPONENT's ball is a solid obstacle, exactly
 * like a wall: its square stops movement in that direction outright, so the mover can never jump
 * over, phase through, or land on any square behind it. Move dots are derived from the same rule, so
 * an occupied tile never shows a destination beyond it.
 *
 * A team's own balls are stepping stones, not walls: the mover lands on the square behind one when
 * the board leaves that square open, and hops to one of its flanks when a wall, the perimeter or a
 * third ball closes it. That keeps a one-wide corridor from deadlocking a team against itself. The
 * leap is never offered over a rival.
 *
 * Anti-oscillation: `repeat` is a small deterministic ledger of the boards the last few turns left
 * behind. Once a race shuffles back onto a board it has already been in `REPEAT_LIMIT` turns
 * running, `steps()` narrows to the steps that actually gain ground; if that still cannot break the
 * cycle, the race is adjudicated — the ball nearest FINISH takes it. Both are pure functions of the
 * state, so every seat and the server reach the same verdict from the same board.
 *
 * Walls sit ON grid lines and are 2 cells long:
 *   'h' wall {x, y}: horizontal, on the line above row y (y = 1..rows-1), covers columns x and x+1.
 *   'v' wall {x, y}: vertical, on the line left of column x (x = 1..cols-1), covers rows y and y+1.
 * A wall owns both of its edge segments and the vertex they hinge on, so two walls may meet at an
 * L-corner or a T-junction but never share an edge segment, and never cross through one shared
 * vertex into a `+`. See `wallsOverlap` / `wallsCross`.
 *
 * Mines are hidden traps: a team buries one on any cell that holds no ball and no live mine, never
 * in the bottom two start rows. Every row above them is legal, the finish line included — a charge
 * planted on the line can throw a ball back off it. They do not block movement — a ball that steps
 * onto one sets it off and the aerial shockwave throws it `CONFIG.KNOCKBACK` rows down the column.
 * The blast is aerial: horizontal walls are jumped, never a stop. The bottom edge clamps the throw,
 * and only a body on the landing square bends it — first to `r + 1`, then to `r + 3`, then to the
 * nearest free flank — so a detonation never leaves the ball standing on the charge. The mine is
 * spent and the blast never chains. Opponent mines are secret: clients get `view(state, team)`,
 * never the raw state.
 *
 * Multiplayer later: send an `Action` over the wire and feed whatever comes back into `apply()`.
 */
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
  MINES_PER_TEAM: 2,
  /** Rows the aerial mine blast throws a ball down its column, jumped clear over any wall. */
  KNOCKBACK: 2,
  /**
   * Seconds a seat gets to act before `getAutoMove()` plays the turn for it. 8 is the canonical
   * blitz turn: the Command Center's allowance (`DEFAULT_RUNTIME.blitz` in admin.ts) is seeded from
   * this number and its stepper can only pick from `BLITZ_STEPS`, so the clock cannot drift from
   * the engine's own limit.
   */
  TURN_TIME_LIMIT: 8,
} as const;
/** A mine may not be buried in the bottom this-many rows: no point-blank traps on the start line. */
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
  /** True when the win came from the anti-oscillation adjudication, not from a ball crossing FINISH. */
  adjudicated?: boolean;
  /** The anti-oscillation ledger. Public to every seat — it carries no hidden information. */
  repeat?: RepeatTrack;
}

/* ---------- anti-oscillation ---------- */

/**
 * How many turns in a row may land on a board the race has already been in before `steps()` stops
 * offering steps that give ground back. Three is long enough that a genuine two-ball dance round a
 * wall is never mistaken for a shuffle, and short enough that a real one is caught inside a round.
 */
export const REPEAT_LIMIT = 3;
/** Consecutive repeated boards at which the race is decided on the board rather than by shuffling. */
export const REPEAT_ADJUDICATE = REPEAT_LIMIT * 2;
/** How many recent boards the ledger remembers: the window a repetition is recognised inside. */
export const REPEAT_WINDOW = 16;

/**
 * The shuffle ledger. `seen` is the fingerprint of each of the last few boards, newest last; a
 * fingerprint that is already in the window is a board the race has been in before, and `streak`
 * counts how many turns in a row have done that. Two balls stepping back and forth in a pocket
 * reproduce the same fingerprint every other turn, so the streak climbs; a wall, a mine, a ball
 * moving anywhere new, or a ball crossing FINISH changes the fingerprint and resets it.
 */
export interface RepeatTrack {
  seen: number[];
  streak: number;
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

export function newGame(sizes: readonly number[] = [1, 1]): GameState {
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
  };
  s.repeat = { seen: [boardFingerprint(s)], streak: 0 };
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

/**
 * The two edge sets, reused. Nothing in this module holds a `Blocks` across another `blocks()`
 * call — the walk that reads it finishes before the next one starts — and a bot turn runs this
 * dozens of times over, so two fresh `Set`s per call was pure garbage.
 */
const _blocks: Blocks = { h: new Set<number>(), v: new Set<number>() };

function blocks(walls: readonly Wall[]): Blocks {
  const { h, v } = _blocks;
  h.clear();
  v.clear();
  for (const w of walls) {
    if (w.o === 'h') { h.add(w.y * LATTICE_C + w.x); h.add(w.y * LATTICE_C + w.x + 1); }
    else { v.add(w.x * LATTICE_R + w.y); v.add(w.x * LATTICE_R + w.y + 1); }
  }
  return _blocks;
}

function canStep(b: Blocks, c: number, r: number, dc: number, dr: number, cols: number, rows: number): boolean {
  const nc = c + dc, nr = r + dr;
  if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) return false;
  if (dr === -1) return !b.h.has(r * LATTICE_C + c);
  if (dr === 1) return !b.h.has((r + 1) * LATTICE_C + c);
  if (dc === -1) return !b.v.has(c * LATTICE_R + r);
  return !b.v.has((c + 1) * LATTICE_R + r);
}

/** The two directions at right angles to `(dc, dr)` — the ways an own-team leap can sidestep. */
function flanksOf(dc: number, dr: number): ReadonlyArray<readonly [number, number]> {
  return dc === 0
    ? [[-1, 0] as const, [1, 0] as const]
    : [[0, -1] as const, [0, 1] as const];
}

/** Is this square on the board and free of every ball? The own-team leap's landing test. */
function cellFree(s: GameState, c: number, r: number, body?: Uint8Array): boolean {
  if (c < 0 || c >= s.cols || r < 0 || r >= s.rows) return false;
  if (body) return body[r * s.cols + c] === 0;
  for (const o of s.balls) if (o.pos.c === c && o.pos.r === r) return false;
  return true;
}

/**
 * Where a ball leaping over a TEAM-MATE in direction `(dc, dr)` comes down, given the body standing
 * on the square that direction leads to. The straight leap — over the body, onto the square directly
 * behind it — is the whole rule while that square is free. When a wall, the board's edge or a third
 * ball closes it, the leap becomes a sidestep: the mover hops to one of the two squares flanking the
 * body, so long as the board leaves that flank open and no wall runs between the body and it. Nothing
 * at all when the body is hemmed in on all three sides. Rivals never reach this helper: an opponent
 * is a solid obstacle and blocks the vector before a landing is considered.
 *
 * The landings are reported to a sink rather than collected into an array: `stepField` walks every
 * cell of the board with this, and a landing list per body was the single largest source of garbage
 * in a bot turn. `body` is the same occupancy test as a mask, for that walk.
 */
function eachLeapTarget(
  s: GameState, b: Blocks, over: Pos, dc: number, dr: number,
  sink: (c: number, r: number) => void, body?: Uint8Array,
): void {
  const bc = over.c + dc, br = over.r + dr;
  if (cellFree(s, bc, br, body) && canStep(b, over.c, over.r, dc, dr, s.cols, s.rows)) {
    sink(bc, br);
    return;                                       // the straight leap lands: no sidestep is offered
  }
  for (const [pc, pr] of flanksOf(dc, dr)) {
    const fc = over.c + pc, fr = over.r + pr;
    if (!cellFree(s, fc, fr, body)) continue;
    if (!canStep(b, over.c, over.r, pc, pr, s.cols, s.rows)) continue;
    sink(fc, fr);
  }
}

/** The same rule, as a list — what `steps()` reads, where a leap is rare and clarity is worth more. */
function leapTargets(s: GameState, b: Blocks, over: Pos, dc: number, dr: number): Pos[] {
  const out: Pos[] = [];
  eachLeapTarget(s, b, over, dc, dr, (c, r) => out.push({ c, r }));
  return out;
}

/**
 * BFS distance-to-FINISH for every cell (index = r*cols + c). -1 = unreachable. Balls are ignored.
 * The dimensions are the board's own, so the same walk serves the 8-column duel and the 10-column
 * three- and four-contender boards. The queue is shared scratch — the walk finishes before the
 * field it returns is read — because a bot turn runs this once per wall it prices.
 */
let _bfsQ = new Int32Array(0);

export function distField(walls: readonly Wall[], cols: number, rows: number): Int16Array {
  const b = blocks(walls);
  const n = cols * rows;
  const d = new Int16Array(n).fill(-1);
  if (_bfsQ.length < n) _bfsQ = new Int32Array(n);
  const q = _bfsQ;
  let tail = 0;
  for (let c = 0; c < cols; c++) { d[c] = 0; q[tail++] = c; }
  for (let head = 0; head < tail; head++) {
    const id = q[head], c = id % cols, r = (id / cols) | 0;
    for (const [dc, dr] of DIRS) {
      if (!canStep(b, c, r, dc, dr, cols, rows)) continue;
      const nn = (r + dr) * cols + c + dc;
      if (d[nn] < 0) { d[nn] = d[id] + 1; q[tail++] = nn; }
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

/**
 * The same wall turned 90° about its centre vertex. The centre and the pivot stay put, so a
 * horizontal bar at (x, y) becomes the vertical one crossing that same point, and vice versa:
 * every legal wall rotates to another in-bounds wall on the same board.
 */
export const rotateWall = (w: WallSpec): WallSpec =>
  (w.o === 'h' ? { o: 'v', x: w.x + 1, y: w.y - 1 } : { o: 'h', x: w.x - 1, y: w.y + 1 });

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

/**
 * Every step a team's balls have on the bare board: each ball's 4-neighbourhood, with walls and the
 * board's edge blocking. The walk is deliberately incremental: the adjacent tile is inspected first,
 * and an opponent standing there stops that vector outright — no straight leap, no flank hop, and
 * therefore no dot on the far side. Only a team-mate may be used as a stepping stone. No
 * anti-oscillation filter — this is the raw move set `steps()` narrows.
 */
function rawSteps(s: GameState, team: Player): Step[] {
  const b = blocks(s.walls);
  const out: Step[] = [];
  for (const ball of s.balls) {
    if (ball.team !== team) continue;
    for (const [dc, dr] of DIRS) {
      if (!canStep(b, ball.pos.c, ball.pos.r, dc, dr, s.cols, s.rows)) continue;
      const to: Pos = { c: ball.pos.c + dc, r: ball.pos.r + dr };
      let blocker: Ball | null = null;
      for (const o of s.balls) {
        if (o.id !== ball.id && o.pos.c === to.c && o.pos.r === to.r) { blocker = o; break; }
      }
      if (!blocker) { out.push({ ball: ball.id, to }); continue; }
      /* An opponent is a solid obstacle, exactly like a wall: stop here and offer nothing beyond. */
      if (blocker.team !== ball.team) continue;
      for (const land of leapTargets(s, b, to, dc, dr)) out.push({ ball: ball.id, to: land });
    }
  }
  return out;
}

/**
 * Every legal step for the team: each ball's 4-neighbourhood — walls and opponent balls block, a
 * team-mate in the way may be leapt — or, while the race is caught in a repetition (`REPEAT_LIMIT`),
 * only the steps that actually gain ground on FINISH. The narrowing is the anti-oscillation rule,
 * and it lives here so that every door into the engine (a tap, the bot, the blitz auto-move, a
 * message off the wire) obeys it without having to know about it. A team with no forward step keeps
 * the plain set, so the rule can slow a shuffle but never freeze a race.
 */
export function steps(s: GameState, team: Player = s.turn): Step[] {
  if (s.winner !== null) return [];
  const all = rawSteps(s, team);
  if (!all.length || !forcing(s)) return all;
  const d = distField(s.walls, s.cols, s.rows);
  const fwd = all.filter((st) => {
    const ball = ballById(s, st.ball);
    return ball !== null && pathOn(d, st.to, s.cols) < pathOn(d, ball.pos, s.cols);
  });
  return fwd.length ? fwd : all;
}

/* ---------- the step graph, as reusable scratch ---------- */

/**
 * The most predecessors one cell can have in the step graph: four plain neighbours, four cells that
 * leap straight over a team-mate into it, and eight that sidestep into it. Nothing can exceed it.
 */
const REV_CAP = 16;
let _revOff = new Int32Array(0);
let _revPre = new Int32Array(0);
let _stepDist = new Int16Array(0);
let _stepQ = new Int32Array(0);
let _body = new Uint8Array(0);
let _bodyTeam = new Uint8Array(0);

/** Grow the scratch to fit a board of `n` cells. Done once per board size, never per call. */
function growStepScratch(n: number): void {
  if (_stepDist.length >= n) return;
  _revOff = new Int32Array(n + 1);
  _revPre = new Int32Array((n + 1) * REV_CAP);
  _stepDist = new Int16Array(n);
  _stepQ = new Int32Array(n);
  _body = new Uint8Array(n);
  _bodyTeam = new Uint8Array(n);
}

/**
 * Distance to FINISH measured in *actions* rather than cells, with every ball on the board standing
 * where it is: the BFS walks exactly the same step graph `steps()` offers. An opponent's ball is a
 * solid obstacle, so it seals the vector it stands on; a team-mate may be stepped over, and a
 * corridor two team-mates are wedged in is one action wide instead of sealed. Walls, opponent balls
 * and the board's edge are the only things that shut a lane, which is what the bot needs to judge a
 * move honestly. Every ball is a body, the mover's own included, and a body's own cell is a source
 * like any other — a mover looks out *from* where it stands — but never a target, because a mover
 * may not walk into a body, only over a team-mate. -1 = out of reach.
 *
 * The graph is built backwards, one bucket per cell, because a sidestep is a one-way edge: it lands
 * the mover beside a body and nothing walks it back the same way. The field is a shared scratch
 * buffer reused on the next call — read it, do not keep it.
 */
export function stepField(s: GameState, team: Player = s.turn): Int16Array {
  const { cols, rows } = s;
  const n = cols * rows;
  const b = blocks(s.walls);

  growStepScratch(n);
  const body = _body;
  const bodyTeam = _bodyTeam;
  body.fill(0, 0, n);
  bodyTeam.fill(255, 0, n);
  for (const o of s.balls) {
    const at = o.pos.r * cols + o.pos.c;
    body[at] = 1;
    bodyTeam[at] = o.team;
  }

  _revOff.fill(0, 0, n + 1);
  /** File `from` among `to`'s predecessors — the reverse of one legal step. */
  const link = (from: number, to: number): void => {
    const at = _revOff[to];
    if (at >= REV_CAP) return;                    // provably unreachable; never overrun a bucket
    _revPre[to * REV_CAP + at] = from;
    _revOff[to] = at + 1;
  };
  /**
   * One cell's outgoing edges, filed backwards. A body is never a target — only a team-mate is
   * something to leap. An opponent's body ends the vector: no edge, exactly as `rawSteps` refuses it.
   */
  const edges = (from: number, c: number, r: number): void => {
    for (const [dc, dr] of DIRS) {
      if (!canStep(b, c, r, dc, dr, cols, rows)) continue;
      const nc = c + dc, nr = r + dr;
      const over = nr * cols + nc;
      if (!body[over]) { link(from, over); continue; }
      if (bodyTeam[over] !== team) continue;      // opponent: a solid obstacle, never a bridge
      eachLeapTarget(s, b, { c: nc, r: nr }, dc, dr, (lc, lr) => link(from, lr * cols + lc), body);
    }
  };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) edges(r * cols + c, c, r);

  const d = _stepDist, q = _stepQ;
  d.fill(-1, 0, n);
  let head = 0, tail = 0;
  for (let c = 0; c < cols; c++) { d[c] = 0; q[tail++] = c; }
  while (head < tail) {
    const id = q[head++];
    const step = d[id] + 1;
    const base = id * REV_CAP, count = _revOff[id];
    for (let k = 0; k < count; k++) {
      const p = _revPre[base + k];
      if (d[p] < 0) { d[p] = step; q[tail++] = p; }
    }
  }
  return d;
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

/** Mines still in the ground — the spent ones are kept for the record but no longer count. */
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
  for (let r = 0; r < s.rows - MINE_ZONE; r++) {
    for (let c = 0; c < s.cols; c++) if (mineOk(s, { c, r }, owner)) out.push({ c, r });
  }
  return out;
}

/** Is this mine legal? Within budget, on the board (the finish row included), on an empty cell. */
export function mineOk(s: GameState, cell: Cell, owner: Player = s.turn): boolean {
  if (s.winner !== null) return false;
  if (minesLeft(s, owner) <= 0) return false;
  if (cell.c < 0 || cell.c >= s.cols || cell.r < 0 || cell.r >= s.rows - MINE_ZONE) return false;
  if (s.balls.some((b) => b.pos.c === cell.c && b.pos.r === cell.r)) return false;
  return mineAt(s, cell) === null;
}

/* ---------- transitions (return a new state, or null if illegal) ---------- */

/**
 * The fingerprint of a board: whose turn it is, how many walls stand, and where every ball is. It
 * deliberately ignores the walls' identities and the mines — a wall may only ever be added, and a
 * mine may only ever be spent, so a board that repeats this fingerprint has repeated the only part
 * of itself that can move backwards: the balls. FNV-1a over small integers, allocation-free, so a
 * simulated turn pays for it like it pays for a comparison. Public, because the ledger it feeds is
 * public: two seats that disagree about a repetition would disagree about the race.
 */
export function boardFingerprint(s: GameState): number {
  let h = (2166136261 ^ s.turn ^ Math.imul(s.walls.length, 2654435761) ^ Math.imul(s.mines.length, 40503)) >>> 0;
  for (const b of s.balls) h = Math.imul(h ^ (b.pos.r * 16 + b.pos.c), 16777619) >>> 0;
  return h >>> 0;
}

/** Is the engine forcing forward steps? Only while the race is caught in a repetition. */
const forcing = (s: GameState): boolean => (s.repeat?.streak ?? 0) >= REPEAT_LIMIT;

/**
 * File the board this turn just left behind. A fingerprint already in the window is a shuffle and
 * the streak climbs; anything new — a ball that moved somewhere it has not been, a wall that went
 * up, a mine that went off — resets it. Always returns a fresh track: the state is never mutated,
 * and a caller's `seen` array is never written through.
 */
function noteBoard(s: GameState): RepeatTrack {
  const key = boardFingerprint(s);
  const seen = s.repeat?.seen ?? [];
  const streak = seen.includes(key) ? (s.repeat?.streak ?? 0) + 1 : 0;
  const kept = seen.length >= REPEAT_WINDOW ? seen.slice(seen.length - REPEAT_WINDOW + 1) : seen.slice();
  kept.push(key);
  return { seen: kept, streak };
}

/**
 * The stalemate backstop. A race that has repeated itself this long has stopped being a race, and
 * the board still says who was winning it: the team whose nearest ball stands closest to FINISH
 * takes it. Deterministic and instant — no clock, no random, no seat can argue with it.
 */
function adjudicate(s: GameState, track: RepeatTrack): GameState {
  if (track.streak < REPEAT_ADJUDICATE || s.winner !== null) return s;
  const d = distField(s.walls, s.cols, s.rows);
  let best: Player | null = null, bestV = Infinity;
  for (let t = 0; t < s.teams.length; t++) {
    let v = Infinity;
    for (const b of s.balls) if (b.team === t) v = Math.min(v, pathOn(d, b.pos, s.cols));
    if (v < bestV) { bestV = v; best = t; }
  }
  return best === null ? s : { ...s, winner: best, adjudicated: true };
}

/**
 * Hand the turn to the next side that can act. The board the turn leaves behind goes into the
 * shuffle ledger on the way out.
 */
function endTurn(s: GameState, played: Player): GameState {
  if (s.winner !== null) return s;
  const n = s.teams.length;
  const canAct = (t: Player) => reachable(s, t).length > 0;
  let handoff: GameState | null = null;
  for (let i = 1; i < n; i++) {
    const next = (played + i) % n;
    if (canAct(next)) { handoff = { ...s, turn: next }; break; }
  }
  handoff ??= { ...s, turn: canAct(played) ? played : (played + 1) % n };
  return recordTurn(handoff, played);
}

/**
 * File the board. A `pass` never comes through here: it is a seat declining, not a board the race
 * has been in, and filing it would let a table of passers trip the anti-oscillation rule without a
 * single ball having moved.
 */
function recordTurn(s: GameState, played: Player): GameState {
  const track = noteBoard(s);
  return adjudicate({ ...s, repeat: track }, track);
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
    landed = blownTo({ ...s, balls }, to, chosen);
    balls = balls.map((b) => (b.id === chosen ? { ...b, pos: landed } : b));
    mines = s.mines.map((m) => (m === hit ? { ...m, triggered: true } : m));
  }
  return endTurn({ ...s, balls, mines, winner: landed.r === 0 ? team : null }, team);
}

/**
 * Where a ball lands after the blast at `from`: the shockwave is aerial, so it throws the ball
 * `CONFIG.KNOCKBACK` rows straight down its own column — over any horizontal wall — with the bottom
 * edge clamping the throw. Only a body can bend it: when the landing square is taken the wave
 * shortens to `r + 1`, stretches to `r + 3` while the board leaves that open, then spills into the
 * nearest free square one column to either side — nearest, so `r + 1` before the landing row. A
 * detonation therefore never leaves the ball standing on the charge; the absolute backstop below
 * only lets it stay if every downward square on the board is occupied. `s` must already hold the
 * ball standing on the mine, which is exempt from the occupancy test along with its own id. The
 * landing square is never re-checked for a second mine.
 */
function blownTo(s: GameState, from: Pos, ballId: number): Pos {
  const last = s.rows - 1;
  const free = (c: number, r: number): boolean =>
    c >= 0 && c < s.cols && r >= 0 && r < s.rows
    && !s.balls.some((o) => o.id !== ballId && o.pos.c === c && o.pos.r === r);

  const target = Math.min(from.r + CONFIG.KNOCKBACK, last);
  if (free(from.c, target)) return { c: from.c, r: target };
  if (free(from.c, from.r + 1)) return { c: from.c, r: from.r + 1 };
  if (free(from.c, from.r + 3)) return { c: from.c, r: from.r + 3 };
  /* the column is body-blocked: the wave spills sideways to the nearest free square below */
  for (const r of [from.r + 1, target]) {
    if (free(from.c - 1, r)) return { c: from.c - 1, r };
    if (free(from.c + 1, r)) return { c: from.c + 1, r };
  }
  /* the backstop: a legal charge is never at the bottom row, so a board that is not literally
     full still has a square below to take — the nearest over both columns and rows */
  for (let dr = 1; from.r + dr <= last; dr++) {
    if (free(from.c, from.r + dr)) return { c: from.c, r: from.r + dr };
    for (let dc = 1; dc < s.cols; dc++) {
      if (free(from.c - dc, from.r + dr)) return { c: from.c - dc, r: from.r + dr };
      if (free(from.c + dc, from.r + dr)) return { c: from.c + dc, r: from.r + dr };
    }
  }
  return from;
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
    case 'pass': return s.winner === null ? { ...s, turn: nextTeam(s, s.turn) } : null;
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
 * still a valid `GameState` the client can run the same queries against.
 *
 * SECURITY: the server must only ever send `view(state, team)` to a client — never the raw state,
 * which carries the hidden mines.
 */
export function view(s: GameState, team: Player): GameState {
  return { ...s, mines: s.mines.filter((m) => m.owner === team || m.triggered) };
}
