/**
 * tutorialDemo.ts — the pure half of the mine-impact demonstration.
 *
 * The coach beat is only convincing if the rival really walks onto the charge, so the lesson picks
 * a mine square the rival can reach in exactly two legal steps and replays those same steps through
 * `apply()`. This module owns the search; `main.ts` owns the timing and the VFX. It is pure and
 * takes the rules' `steps()` as a callback, so the Node suite can exercise it without a DOM.
 */
import type { Ball, Cell, GameState, Step } from './rules';

/** `steps(state, team)` from the rules, injected so this module stays DOM- and rules-load free. */
export type StepsFor = (state: GameState, team: number) => readonly Step[];

export interface MineDemoPlan {
  cell: Cell;
  /** The two legal moves the rival will make, the second one landing on the mine. */
  path: [Step, Step];
}

const keyOf = (c: Cell) => `${c.c},${c.r}`;

const moved = (state: GameState, ballId: number, to: Cell): GameState => ({
  ...state,
  balls: state.balls.map((b) => (b.id === ballId ? { ...b, pos: { c: to.c, r: to.r } } : b)),
});

/**
 * A legal two-step route for one ball to `target`. The first step is tried bottom-up (nearest the
 * finish first) so the demonstration reads as an advance, never a shuffle. A live mine on the way
 * is skipped; the destination itself is allowed because that is the charge being demonstrated.
 */
export function twoStepPath(
  state: GameState,
  ball: Ball,
  target: Cell,
  stepsFor: StepsFor,
): [Step, Step] | null {
  const live = new Set(state.mines.filter((m) => !m.triggered).map((m) => keyOf(m.cell)));
  const blocked = (cell: Cell, allowTarget: boolean) =>
    live.has(keyOf(cell)) && !(allowTarget && cell.c === target.c && cell.r === target.r);

  const first = stepsFor(state, ball.team)
    .filter((st) => st.ball === ball.id)
    .filter((st) => !(st.to.c === target.c && st.to.r === target.r))
    .filter((st) => !blocked(st.to, false))
    .sort((a, b) => a.to.r - b.to.r || Math.abs(a.to.c - ball.pos.c) - Math.abs(b.to.c - ball.pos.c));

  for (const a of first) {
    const after = moved(state, ball.id, a.to);
    const second = stepsFor(after, ball.team).find((st) => st.ball === ball.id
      && st.to.c === target.c && st.to.r === target.r && !blocked(st.to, true));
    if (second) return [a, second];
  }
  return null;
}

/**
 * Pick the mine square for step 4B. It must sit ahead of the rival and be reachable in exactly two
 * steps; a straight two-row advance wins over a diagonal detour, and the nearest column wins over a
 * long sideways walk. Returns null when no such square exists, so the caller can fall back.
 */
export function pickMineDemo(
  state: GameState,
  ball: Ball,
  cells: readonly Cell[],
  stepsFor: StepsFor,
): MineDemoPlan | null {
  let best: { plan: MineDemoPlan; score: number } | null = null;
  for (const cell of cells) {
    if (cell.r >= ball.pos.r) continue;
    const path = twoStepPath(state, ball, cell, stepsFor);
    if (!path) continue;
    const straight = path[0].to.c === ball.pos.c && path[1].to.c === ball.pos.c;
    const twoUp = path[0].to.r === ball.pos.r - 1 && path[1].to.r === ball.pos.r - 2;
    const score = (straight ? 0 : 60)
      + (twoUp ? 0 : 24)
      + Math.abs(cell.c - ball.pos.c) * 4
      + Math.abs(cell.r - (ball.pos.r - 2)) * 2;
    if (!best || score < best.score) best = { plan: { cell, path }, score };
  }
  return best?.plan ?? null;
}
