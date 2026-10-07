/**
 * bot.ts — local stand-in for a remote opponent.
 * Walks the shortest path to FINISH and sometimes drops the wall that hurts you most.
 * Replace with network messages later; main.ts only needs `think(state) => Promise<Action>`.
 */
import {
  COLS, allWalls, distField, doWall, other, pathLen, reachable,
  type Action, type GameState, type Pos, type Wall,
} from './rules';

export function botAction(s: GameState): Action {
  const me = s.turn, foe = other(me);
  const myD = pathLen(s, me), foeD = pathLen(s, foe);

  // Consider a wall when the opponent is ahead or level, or occasionally for fun.
  if (s.wallsLeft[me] > 0 && (foeD <= myD || Math.random() < 0.15)) {
    let best: Wall | null = null;
    let bestGain = 0;
    for (const w of allWalls(me)) {
      const t = doWall(s, w);
      if (!t) continue;
      const gain = (pathLen(t, foe) - foeD) - (pathLen(t, me) - myD);
      if (gain > bestGain || (gain === bestGain && gain > 0 && Math.random() < 0.3)) {
        best = w;
        bestGain = gain;
      }
    }
    if (best && (bestGain >= 2 || (bestGain >= 1 && foeD <= myD && Math.random() < 0.5))) {
      return { kind: 'wall', wall: best };
    }
  }

  const moves = reachable(s, me);
  if (moves.length) {
    const d = distField(s.walls);
    const score = (p: Pos) => { const v = d[p.r * COLS + p.c]; return v < 0 ? 999 : v; };
    const min = Math.min(...moves.map(score));
    const pool = moves.filter((m) => score(m) === min);
    return { kind: 'move', to: pool[Math.floor(Math.random() * pool.length)] };
  }

  for (const w of allWalls(me)) if (doWall(s, w)) return { kind: 'wall', wall: w };
  return { kind: 'pass' };
}
