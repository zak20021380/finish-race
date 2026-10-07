/**
 * bot.ts — local stand-in for a remote opponent.
 * Walks the shortest path to FINISH and walls only when it is worth the wait.
 * Replace with network messages later; main.ts only needs `think(state) => Promise<Action>`.
 */
import {
  COLS, allWalls, distField, doWall, other, pathLen, reachable,
  type Action, type GameState, type Pos, type Wall,
} from './rules';

/**
 * Walls are unlimited, so the bot self-limits or the board fills up and nobody races:
 * it only walls while the opponent is level or ahead, and only with a wall that costs the
 * opponent 2+ steps. Such a wall always grows the opponent's distance, so the bot is ahead
 * afterwards and stops walling — no wall-spam stalemate is possible.
 */
export function botAction(s: GameState): Action {
  const me = s.turn, foe = other(me);
  const myD = pathLen(s, me), foeD = pathLen(s, foe);

  if (foeD <= myD) {
    let best: Wall | null = null;
    let bestCost = 0;
    let bestSelf = Infinity;
    for (const w of allWalls(me)) {
      const t = doWall(s, w);
      if (!t) continue;
      const cost = pathLen(t, foe) - foeD;
      if (cost < 2) continue;
      const self = pathLen(t, me) - myD;
      if (!best || cost > bestCost || (cost === bestCost && self < bestSelf)) { best = w; bestCost = cost; bestSelf = self; }
    }
    if (best) return { kind: 'wall', wall: best };
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
