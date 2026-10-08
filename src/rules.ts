/**
 * rules.ts — pure game logic. No DOM, no timers, no network.
 *
 * Coordinates: cell (c, r); c = 0..COLS-1 left→right, r = 0..ROWS-1 top→bottom.
 * Row 0 is FINISH.
 *
 * Teams: 1 to 3 teams of 1 to 3 balls each (max 3v3). Every team starts spread across the bottom
 * two rows and races any one of its balls to the top. Teams alternate turns; on its turn a team
 * moves ANY ONE of its balls one cell, or places a wall. Walls are unlimited.
 *
 * Walls sit ON grid lines and are 2 cells long:
 *   'h' wall {x, y}: horizontal, on the line above row y (y = 1..ROWS-1), covers columns x and x+1.
 *   'v' wall {x, y}: vertical, on the line left of column x (x = 1..COLS-1), covers rows y and y+1.
 * Walls may touch and cross, but never overlap along the same line.
 *
 * Multiplayer later: send an `Action` over the wire and feed whatever comes back into `apply()`.
 */

export const COLS = 8;
export const ROWS = 12;
/** Team and ball counts the rules accept; the start-layout helper fills the bottom two rows. */
export const MAX_TEAMS = 3;
export const MAX_BALLS = 3;

/** A team index — the seat a ball, wall, turn or win belongs to. */
export type Player = number;
export interface Pos { c: number; r: number }
export interface WallSpec { o: 'h' | 'v'; x: number; y: number }
export interface Wall extends WallSpec { owner: Player }

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
  | { kind: 'pass' };

export interface GameState {
  teams: TeamMeta[];
  balls: Ball[];
  walls: Wall[];
  turn: Player;
  winner: Player | null;
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

export function newGame(sizes: readonly number[] = [1, 1]): GameState {
  const n = sizes.slice(0, MAX_TEAMS).map(clampSize);
  const layout = startLayout(n);
  const balls: Ball[] = [];
  for (let t = 0; t < n.length; t++) {
    for (let i = 0; i < n[t]; i++) {
      balls.push({ id: balls.length, team: t, owner: t, pos: layout[t][i] });
    }
  }
  return {
    teams: n.map((balls) => ({ balls })),
    balls,
    walls: [],
    turn: 0,
    winner: null,
  };
}

export const ballsOf = (s: GameState, team: Player): Ball[] => s.balls.filter((b) => b.team === team);
export const ballById = (s: GameState, id: number): Ball | null => s.balls.find((b) => b.id === id) ?? null;
/** The team's i-th ball (first by default) — what the UI tracks when it only draws one per side. */
export const ballOf = (s: GameState, team: Player, index = 0): Ball => {
  let i = 0;
  for (const b of s.balls) if (b.team === team && i++ === index) return b;
  return s.balls[0];
};

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

/** Is this wall legal? In bounds, no overlap, and every ball keeps a path to FINISH. */
export function wallOk(s: GameState, w: Wall): boolean {
  if (s.winner !== null) return false;
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

/* ---------- transitions (return a new state, or null if illegal) ---------- */

function endTurn(s: GameState, played: Player): GameState {
  if (s.winner !== null) return s;
  const n = s.teams.length;
  const canAct = (t: Player) => reachable(s, t).length > 0;
  for (let i = 1; i < n; i++) {
    const next = (played + i) % n;
    if (canAct(next)) return { ...s, turn: next };
  }
  return { ...s, turn: canAct(played) ? played : (played + 1) % n };
}

export function doMove(s: GameState, to: Pos, ballId?: number): GameState | null {
  const team = s.turn;
  const opts = steps(s, team).filter((st) => st.to.c === to.c && st.to.r === to.r
    && (ballId === undefined || st.ball === ballId));
  if (!opts.length) return null;
  const chosen = opts[0].ball;
  const balls = s.balls.map((b) => (b.id === chosen ? { ...b, pos: { c: to.c, r: to.r } } : b));
  return endTurn({ ...s, balls, winner: to.r === 0 ? team : null }, team);
}

export function doWall(s: GameState, w: Wall): GameState | null {
  if (w.owner !== s.turn || !wallOk(s, w)) return null;
  return endTurn({ ...s, walls: [...s.walls, { ...w }] }, w.owner);
}

/** Single entry point for local input, the bot, or (later) messages from the network. */
export function apply(s: GameState, a: Action): GameState | null {
  switch (a.kind) {
    case 'move': return doMove(s, a.to, a.ball);
    case 'wall': return doWall(s, a.wall);
    case 'pass': return s.winner === null ? { ...s, turn: nextTeam(s, s.turn) } : null;
  }
}
