/**
 * hazards.ts — the rolling log: a 3-column lane that drops on the board without a moment's warning.
 *
 * The whole timetable is a pure function of (seed, hazard number), so the server and every online
 * client derive the identical schedule without exchanging it — nothing here depends on move history
 * or on a hidden PRNG stream. Rounds are 1-based and rounds 1 and 2 stay hazard-free. A race deploys
 * at most `MAX_LOGS` (2) rolling logs; the schedule stops there, so no seat can face a third.
 *
 * There is deliberately no telegraph any more: the lane is drawn from the schedule at the instant its
 * round closes, so a seat learns about a log the same moment it is announced — one second of strike
 * alert, during which nobody may act, and then it rolls. The old round-long pending window let every
 * player casually stroll out of the way; unpredictability is the whole point of the hazard.
 *
 * When it drops, the trunk sweeps from row 0 down all `width` columns simultaneously until a
 * horizontal wall blocking ANY lane column (or the bottom edge) stops it, and every ball above that
 * line across the lane — friend or foe — is shoved up to `HAZARD.knockback` cells straight down its
 * own column. A wall under a ball is a shield, and a shove never sets a mine off.
 *
 * `rules.ts` owns *when* this runs (every turn hand-off); this file owns *what* it does.
 */
import { COLS, ROWS } from './rules';
import type { Ball, GameState, Player, Pos, Wall } from './rules';

/** The hard cap on rolling logs in one race: a board never deploys more than two. */
export const MAX_LOGS = 2;

/** Engine tunables for the log, in one place so the server and the client never disagree. */
export const HAZARD = {
  /** The earliest round a log may drop in. */
  firstHitRound: 3,
  /** Rounds between two consecutive strikes. */
  minGap: 3,
  maxGap: 9,
  /** Cells a ball is shoved down the lane; shortened by a wall, the edge or another ball. */
  knockback: 3,
  /** Adjacent columns the wide trunk spans. */
  logWidth: 3,
  /** Rolling logs one race may deploy; after the second the clock keeps time but no trunk falls. */
  maxLogs: MAX_LOGS,
} as const;

/** Rounds 1..2 are safe whatever `firstHitRound` is tuned to. */
const SAFE_ROUNDS = 2;

/** The lane a log sweeps: its leftmost column and how many it covers. */
export interface Lane { left: number; width: number }
export interface LogMove { ballId: number; from: Pos; to: Pos }
/** What the log did, newest first-free: the UI animates it, the rules never read it back. */
export interface LogEvent { type: 'log'; left: number; width: number; stopRow: number; moves: LogMove[] }

export interface HazardPhase {
  on: true;
  /** Everything the schedule is derived from; two clients with the same seed see the same logs. */
  seed: number;
  /** 1-based; closes (and triggers a due log) when the hand-off wraps past the acting team. */
  round: number;
  /** Hazards dropped so far — the index the next lane and gap are drawn from. */
  emitted: number;
  /** The round the next log falls in. The lane itself is unknown until it does. */
  nextHitRound: number;
}

const cellKey = (p: Pos, cols: number) => p.r * cols + p.c;

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

/** Hazard k's lane and the round it falls in — which is also the round it strikes in. */
export function hazardAt(seed: number, k: number, cols: number = COLS): Lane & { hitRound: number } {
  const floor = Math.max(HAZARD.firstHitRound, SAFE_ROUNDS + 1);
  let left = 0;
  let hit = 0;
  for (let i = 0; i <= k; i++) {
    const r = prng(seed, i);
    const gap = randInt(r, HAZARD.minGap, HAZARD.maxGap);
    left = randInt(r, 0, Math.max(0, cols - HAZARD.logWidth));
    hit = Math.max(floor, hit + gap);
  }
  return { left, width: HAZARD.logWidth, hitRound: hit };
}

/** The first `count` hazards of a seed, capped at `MAX_LOGS` — the whole schedule a race can deploy. */
export function hazardSchedule(seed: number, count: number, cols: number = COLS): (Lane & { hitRound: number; k: number })[] {
  const n = Math.max(0, Math.min(count, MAX_LOGS));
  return Array.from({ length: n }, (_, k) => ({ k, ...hazardAt(seed, k, cols) }));
}

/** A fresh phase: round 1, nothing announced, hazard 0 already timed. */
export function initPhase(seed: number, cols: number = COLS): HazardPhase {
  return { on: true, seed, round: 1, emitted: 0, nextHitRound: hazardAt(seed, 0, cols).hitRound };
}

/** A horizontal wall on the line above row `r` that covers `col`. */
const blocksLane = (walls: readonly Wall[], col: number, r: number): boolean =>
  walls.some((w) => w.o === 'h' && w.y === r && (w.x === col || w.x + 1 === col));

/**
 * The last row the wide log reaches: the row above the first horizontal wall blocking ANY of its
 * lane columns, or the bottom edge. A partial obstruction halts the entire trunk. `rows` is the
 * board's own height, so the lane runs to the true bottom on either board size.
 */
export function logStopRow(
  walls: readonly Wall[],
  left: number,
  width: number = HAZARD.logWidth,
  rows: number = ROWS,
): number {
  let stop = 0;
  for (let r = 1; r < rows; r++) {
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
export function runLog(s: GameState, lane: Lane): { balls: Ball[]; event: LogEvent } {
  const stopRow = logStopRow(s.walls, lane.left, lane.width, s.rows);
  const hits = s.balls
    .filter((b) => b.pos.c >= lane.left && b.pos.c < lane.left + lane.width && b.pos.r <= stopRow)
    .sort((a, b) => b.pos.r - a.pos.r);
  const taken = new Set<number>(s.balls.map((b) => cellKey(b.pos, s.cols)));
  const moved = new Map<number, Pos>();
  const moves: LogMove[] = [];
  for (const b of hits) {
    taken.delete(cellKey(b.pos, s.cols));
    let r = b.pos.r;
    for (let i = 0; i < HAZARD.knockback && r + 1 <= stopRow; i++) {
      if (taken.has(cellKey({ c: b.pos.c, r: r + 1 }, s.cols))) break;
      r += 1;
    }
    taken.add(cellKey({ c: b.pos.c, r }, s.cols));
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
 * The round closes when the hand-off wraps past `played`, and if that round is the one the schedule
 * timed, the log drops right there — its lane is drawn from the seed at this instant, so nothing
 * earlier could have read it. The next strike is then timed for the round after it. A race deploys
 * at most `MAX_LOGS` trunks: once the second has fallen the clock still advances but is never armed
 * again, so no seat can be chased by a third log.
 */
export function tickHazard(s: GameState, played: Player): GameState {
  const hz = s.hazard;
  if (!hz || s.winner !== null) return s;
  if (!(s.turn !== played && s.turn <= played)) return s;   // the round is still open
  const next: HazardPhase = { ...hz, round: hz.round + 1 };
  if (next.emitted >= HAZARD.maxLogs) {
    next.nextHitRound = Number.POSITIVE_INFINITY;
    return { ...s, hazard: next };
  }
  if (next.round < next.nextHitRound) return { ...s, hazard: next };
  const swept = runLog(s, hazardAt(hz.seed, hz.emitted, s.cols));
  next.emitted += 1;
  next.nextHitRound = next.emitted >= HAZARD.maxLogs
    ? Number.POSITIVE_INFINITY
    : hazardAt(hz.seed, next.emitted, s.cols).hitRound;
  return { ...s, balls: swept.balls, hazard: next, lastEvent: swept.event };
}
