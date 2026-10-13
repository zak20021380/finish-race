/**
 * hazards.ts — the rolling log: a telegraphed lane that sweeps down the board when a round ends.
 *
 * The whole timetable is a pure function of (seed, hazard number), so the server and every online
 * client derive the identical schedule without exchanging it — nothing here depends on move history
 * or on a hidden PRNG stream. Rounds are 1-based and rounds 1 and 2 stay hazard-free, so every seat
 * sees the board before the first warning. A warning is public for the whole round it lands in, and
 * the log rolls the instant that round's last team has acted: from row 0 down all `logWidth`
 * columns simultaneously until a horizontal wall blocking ANY lane column (or the bottom edge)
 * stops it, and every ball above that line across the lane — friend or foe — is shoved up to
 * `HAZARD.knockback` cells straight down its own column. A wall under a ball is a shield,
 * and a shove never sets a mine off.
 *
 * `rules.ts` owns *when* this runs (every turn hand-off); this file owns *what* it does.
 */
import { COLS, ROWS } from './rules';
import type { Ball, GameState, Player, Pos, Wall } from './rules';

/** Engine tunables for the log, in one place so the server and the client never disagree. */
export const HAZARD = {
  /** The earliest round a log may be warned in. */
  firstWarningRound: 3,
  /** Rounds between two consecutive warnings. */
  minGap: 3,
  maxGap: 9,
  /** Cells a ball is shoved down the lane; shortened by a wall, the edge or another ball. */
  knockback: 3,
  /** Adjacent columns the wide trunk spans. */
  logWidth: 3,
} as const;

/** Rounds 1..2 are safe whatever `firstWarningRound` is tuned to. */
const SAFE_ROUNDS = 2;

/** The lane a warning has put on the board, and the round whose end brings it down. */
export interface Pending { left: number; width: number; hitRound: number }
export interface LogMove { ballId: number; from: Pos; to: Pos }
/** What the log did, newest first-free: the UI animates it, the rules never read it back. */
export interface LogEvent { type: 'log'; left: number; width: number; stopRow: number; moves: LogMove[] }

export interface HazardPhase {
  on: true;
  /** Everything the schedule is derived from; two clients with the same seed see the same logs. */
  seed: number;
  /** 1-based; closes (and triggers a due log) when the hand-off wraps past the acting team. */
  round: number;
  /** Hazards warned so far — the index the next lane and gap are drawn from. */
  emitted: number;
  pending: Pending | null;
  nextWarningRound: number;
}

const cellKey = (p: Pos) => p.r * COLS + p.c;

/** mulberry32 keyed by a fixed mix of (seed, k), so the stream is reproducible and stateless. */
function prng(seed: number, k: number): () => number {
  let a = (Math.imul(seed + 1, 0x9e3779b9) ^ Math.imul(k + 2, 0x85ebca6b)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** lo..hi inclusive; `r` is drawn in a fixed order so hazard k always yields the same pair. */
const randInt = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/** Hazard k's lane and the round it is warned in — which is also the round it lands in. */
export function hazardAt(seed: number, k: number): { left: number; width: number; warnRound: number } {
  const floor = Math.max(HAZARD.firstWarningRound, SAFE_ROUNDS + 1);
  let left = 0;
  let warn = 0;
  for (let i = 0; i <= k; i++) {
    const r = prng(seed, i);
    const gap = randInt(r, HAZARD.minGap, HAZARD.maxGap);
    left = randInt(r, 0, COLS - HAZARD.logWidth);
    warn = Math.max(floor, warn + gap);
  }
  return { left, width: HAZARD.logWidth, warnRound: warn };
}

/** The first `count` hazards of a seed — the whole schedule, recomputed any time, identically. */
export function hazardSchedule(seed: number, count: number): { k: number; left: number; width: number; warnRound: number }[] {
  return Array.from({ length: count }, (_, k) => ({ k, ...hazardAt(seed, k) }));
}

/** A fresh phase: round 1, nothing telegraphed, hazard 0 already timed. */
export function initPhase(seed: number): HazardPhase {
  return { on: true, seed, round: 1, emitted: 0, pending: null, nextWarningRound: hazardAt(seed, 0).warnRound };
}

/** A horizontal wall on the line above row `r` that covers `col`. */
const blocksLane = (walls: readonly Wall[], col: number, r: number): boolean =>
  walls.some((w) => w.o === 'h' && w.y === r && (w.x === col || w.x + 1 === col));

/**
 * The last row the wide log reaches: the row above the first horizontal wall blocking ANY of its
 * lane columns, or the bottom edge. A partial obstruction halts the entire trunk.
 */
export function logStopRow(walls: readonly Wall[], left: number, width: number = HAZARD.logWidth): number {
  let stop = 0;
  for (let r = 1; r < ROWS; r++) {
    let blocked = false;
    for (let c = left; c < left + width; c++) {
      if (blocksLane(walls, c, r)) { blocked = true; break; }
    }
    if (blocked) break;
    stop = r;
  }
  return stop;
}

/**
 * Roll the wide log down all lane columns simultaneously and shove everything it touches: every
 * ball across all lane columns at `row <= stopRow` is hit, a ball below the blocking wall is
 * shielded, and the bottom-most ball moves first so the one above it can take the cell it vacated.
 * A shove stops at the lane's shared stop line, the edge, or a cell still occupied — and never
 * arms a mine on the way.
 */
export function runLog(s: GameState, lane: Pending): { balls: Ball[]; event: LogEvent } {
  const stopRow = logStopRow(s.walls, lane.left, lane.width);
  const hits = s.balls
    .filter((b) => b.pos.c >= lane.left && b.pos.c < lane.left + lane.width && b.pos.r <= stopRow)
    .sort((a, b) => b.pos.r - a.pos.r);
  const taken = new Set<number>(s.balls.map((b) => cellKey(b.pos)));
  const moved = new Map<number, Pos>();
  const moves: LogMove[] = [];
  for (const b of hits) {
    taken.delete(cellKey(b.pos));
    let r = b.pos.r;
    for (let i = 0; i < HAZARD.knockback && r + 1 <= stopRow; i++) {
      if (taken.has(cellKey({ c: b.pos.c, r: r + 1 }))) break;
      r += 1;
    }
    taken.add(cellKey({ c: b.pos.c, r }));
    if (r !== b.pos.r) {
      moved.set(b.id, { c: b.pos.c, r });
      moves.push({ ballId: b.id, from: { c: b.pos.c, r: b.pos.r }, to: { c: b.pos.c, r } });
    }
  }
  const balls = s.balls.map((b) => {
    const p = moved.get(b.id);
    return p ? { ...b, pos: p } : b;
  });
  return { balls, event: { type: 'log', left: lane.left, width: lane.width, stopRow, moves } };
}

/**
 * One turn hand-off: `s` already carries the next `turn` and `played` is the seat that just acted.
 * The round closes when the hand-off wraps past `played`, which is the instant a due log lands; the
 * next hazard is then armed if its round has begun. At most one lane is ever on the board.
 */
export function tickHazard(s: GameState, played: Player): GameState {
  const hz = s.hazard;
  if (!hz || s.winner !== null) return s;
  const wrapped = s.turn !== played && s.turn <= played;
  const next: HazardPhase = { ...hz, round: hz.round + (wrapped ? 1 : 0) };
  let balls = s.balls;
  let event = s.lastEvent ?? null;
  if (next.pending && wrapped) {
    const swept = runLog(s, next.pending);
    balls = swept.balls;
    event = swept.event;
    next.pending = null;
    next.nextWarningRound = hazardAt(hz.seed, next.emitted).warnRound;
  }
  if (!next.pending && next.round === next.nextWarningRound) {
    const due = hazardAt(hz.seed, next.emitted);
    next.pending = { left: due.left, width: due.width, hitRound: next.round };
    next.emitted += 1;
  }
  return { ...s, balls, hazard: next, lastEvent: event };
}
