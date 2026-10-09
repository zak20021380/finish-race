/**
 * bot.ts — local stand-in for a remote opponent.
 * Works for any team size: it moves the ball closest to FINISH and walls only when it is worth
 * the wait. Difficulty decides how often it walls, how far it looks ahead and how much it wanders —
 * never the anti-stalemate invariant below, which every level obeys.
 */
import {
  COLS, allWalls, ballById, ballPath, distField, doWall, nextTeam, pathLen, steps,
  type Action, type GameState, type Pos, type Wall,
} from './rules';

export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard'];

interface Profile {
  /** odds of playing the best wall it found instead of just racing */
  wallRate: number;
  /** 1 = a wall is judged by the steps it costs; 2 = also demands the position stays level or ahead */
  lookahead: 1 | 2;
  /** odds of ignoring the shortest path for a random legal step */
  noise: number;
}

const PROFILES: Record<Difficulty, Profile> = {
  easy:   { wallRate: .25, lookahead: 1, noise: .4 },
  normal: { wallRate: .85, lookahead: 1, noise: .12 },
  hard:   { wallRate: 1,   lookahead: 2, noise: 0 },
};

/** How long the bot is seen to think: Hard looks sharp, Easy takes its time. */
export function botThinkMs(d: Difficulty): number {
  const span = d === 'hard' ? [380, 680] : d === 'easy' ? [780, 1480] : [650, 1100];
  return span[0] + Math.random() * (span[1] - span[0]);
}

/**
 * The bot spends its `WALL_LIMIT` walls only where they pay for themselves: it walls while the
 * opponent is level or ahead, and only with a wall that costs the opponent 2+ steps. Such a wall
 * always grows the opponent's distance, so the bot is ahead afterwards and stops walling — and the
 * budget runs out before the board could ever fill, so no wall-spam stalemate is possible.
 */
export function botAction(s: GameState, difficulty: Difficulty = 'normal'): Action {
  const p = PROFILES[difficulty];
  const me = s.turn, foe = nextTeam(s, me);
  const myD = pathLen(s, me), foeD = pathLen(s, foe);

  if (foeD <= myD && Math.random() < p.wallRate) {
    let best: Wall | null = null;
    let bestScore = 0;
    let bestSelf = Infinity;
    for (const w of allWalls(me)) {
      const t = doWall(s, w);
      if (!t) continue;
      const cost = pathLen(t, foe) - foeD;
      if (cost < 2) continue;
      const self = pathLen(t, me) - myD;
      // looking a ply further: keep the wall only if it still leaves the bot level or ahead
      if (p.lookahead > 1 && pathLen(t, me) > pathLen(t, foe)) continue;
      const score = cost - self * 2;
      if (!best || score > bestScore || (score === bestScore && self < bestSelf)) { best = w; bestScore = score; bestSelf = self; }
    }
    if (best) return { kind: 'wall', wall: best };
  }

  const mySteps = steps(s, me);
  if (mySteps.length) {
    if (p.noise > 0 && Math.random() < p.noise) {
      const st = mySteps[(Math.random() * mySteps.length) | 0];
      return { kind: 'move', ball: st.ball, to: st.to };
    }
    const d = distField(s.walls);
    const score = (q: Pos) => { const v = d[q.r * COLS + q.c]; return v < 0 ? 999 : v; };
    const min = Math.min(...mySteps.map((st) => score(st.to)));
    // among the cells that gain the most ground, play the ball that is already closest to the line
    const pool = mySteps.filter((st) => score(st.to) === min);
    const near = new Map<number, number>();
    for (const st of pool) {
      if (near.has(st.ball)) continue;
      const b = ballById(s, st.ball);
      if (b) near.set(st.ball, ballPath(s, b));
    }
    const lead = Math.min(...near.values());
    const leadPool = pool.filter((st) => near.get(st.ball) === lead);
    const pick = leadPool[(Math.random() * leadPool.length) | 0];
    return { kind: 'move', ball: pick.ball, to: pick.to };
  }

  for (const w of allWalls(me)) if (doWall(s, w)) return { kind: 'wall', wall: w };
  return { kind: 'pass' };
}
