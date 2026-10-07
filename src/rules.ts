/**
 * rules.ts — pure game logic. No DOM, no timers, no network.
 *
 * Coordinates: cell (c, r); c = 0..COLS-1 left→right, r = 0..ROWS-1 top→bottom.
 * Row 0 is FINISH.
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

export type Player = 0 | 1; // 0 = red (you), 1 = blue (opponent)
export interface Pos { c: number; r: number }
export interface WallSpec { o: 'h' | 'v'; x: number; y: number }
export interface Wall extends WallSpec { owner: Player }

export type Action =
  | { kind: 'move'; to: Pos }
  | { kind: 'wall'; wall: Wall }
  | { kind: 'pass' };

export interface GameState {
  pawns: [Pos, Pos];
  walls: Wall[];
  turn: Player;
  winner: Player | null;
}

export const other = (p: Player): Player => (p === 0 ? 1 : 0);

export function newGame(): GameState {
  return {
    // "column 4 / column 5" (1-based) = the two centre columns
    pawns: [{ c: 3, r: ROWS - 1 }, { c: 4, r: ROWS - 1 }],
    walls: [],
    turn: 0,
    winner: null,
  };
}

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

/** BFS distance-to-FINISH for every cell (index = r*COLS + c). -1 = unreachable. Pawns are ignored. */
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

/** Shortest path length to FINISH for a player (Infinity if sealed in). */
export function pathLen(s: GameState, p: Player): number {
  const pos = s.pawns[p];
  const d = distField(s.walls)[pos.r * COLS + pos.c];
  return d < 0 ? Infinity : d;
}

/* ---------- queries ---------- */

/** Cells the player's pawn can step to right now (4-neighbourhood, walls and the other pawn block). */
export function reachable(s: GameState, p: Player = s.turn): Pos[] {
  if (s.winner !== null) return [];
  const b = blocks(s.walls);
  const me = s.pawns[p], foe = s.pawns[other(p)];
  const out: Pos[] = [];
  for (const [dc, dr] of DIRS) {
    if (!canStep(b, me.c, me.r, dc, dr)) continue;
    const n = { c: me.c + dc, r: me.r + dr };
    if (n.c === foe.c && n.r === foe.r) continue;
    out.push(n);
  }
  return out;
}

/** Is this wall legal? In bounds, no overlap, and both pawns keep a path to FINISH. */
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
  return s.pawns.every((p) => d[p.r * COLS + p.c] >= 0);
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
  const next = other(played);
  const canAct = (p: Player) => reachable(s, p).length > 0;
  return { ...s, turn: !canAct(next) && canAct(played) ? played : next };
}

export function doMove(s: GameState, to: Pos): GameState | null {
  const p = s.turn;
  if (!reachable(s, p).some((m) => m.c === to.c && m.r === to.r)) return null;
  const pawns: [Pos, Pos] = [s.pawns[0], s.pawns[1]];
  pawns[p] = { c: to.c, r: to.r };
  return endTurn({ ...s, pawns, winner: to.r === 0 ? p : null }, p);
}

export function doWall(s: GameState, w: Wall): GameState | null {
  if (w.owner !== s.turn || !wallOk(s, w)) return null;
  return endTurn({ ...s, walls: [...s.walls, { ...w }] }, w.owner);
}

/** Single entry point for local input, the bot, or (later) messages from the network. */
export function apply(s: GameState, a: Action): GameState | null {
  switch (a.kind) {
    case 'move': return doMove(s, a.to);
    case 'wall': return doWall(s, a.wall);
    case 'pass': return s.winner === null ? { ...s, turn: other(s.turn) } : null;
  }
}
