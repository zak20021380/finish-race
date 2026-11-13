/**
 * staging.ts — one signal: a mine is staged, and its ✓/✕ pair is live over the board.
 *
 * The guidance layers live in their own module entries — the board's toast in `main.ts`, the event
 * callouts in `callouts.ts`, the lesson's card in `tutorial.ts` — and none of them has a model of
 * the board, so none of them can see the two discs the player is being asked to tap. This module
 * is the one thing they can all read: the pair's own box, in viewport css px.
 *
 * `main.ts` is its only writer. `armCapsules()` is the only writer of `capsule`, so it is also the
 * only place the box is published — the signal exists exactly as long as a live pair does, and a
 * ghost that is dropped, buried or reset clears it on the same frame.
 *
 * Two rules ride on that box, and they are why it exists:
 *   · an instructional hint stands DOWN while the pair is up — the discs are the instruction once a
 *     square is staged, and a bubble repeating "tap again" only covers them; and
 *   · a hint that must stay — an event beat, a refusal — keeps `STAGE_CLEAR` px of daylight from
 *     the pair's rims, or does not paint at all.
 *
 * `capsuleStage()` is the same signal one level down, for either staged action (a wall's glass
 * toolbar or a mine's discs): the ✓ key on its own, and the pair together. The lesson rings the
 * first and cuts its input hole around the second.
 */

/** A viewport box, in css px. The same shape as a `TutorialRect`, deliberately. */
export interface StageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The two keys a staged action offers, in viewport css px: the ✓ on its own, and the pair together.
 * The hands-on lesson rings `confirm` and opens its input door around `pair`, so the ✕ beside it
 * stays a real way back instead of a disc the overlay swallows.
 */
export interface CapsuleStage {
  confirm: StageBox;
  pair: StageBox;
}

/** Daylight a surviving hint keeps from the pair's rims, in css px. */
export const STAGE_CLEAR = 20;

let box: StageBox | null = null;
let keys: CapsuleStage | null = null;

const sameBox = (a: StageBox | null, b: StageBox | null): boolean => a === b
  || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);

/** Publish the staged pair's box, or clear it with `null`. `main.ts` is the only caller. */
export function setMineStage(next: StageBox | null): void {
  if (sameBox(box, next)) return;
  box = next;
}

/** The pair's box in viewport css px, or `null` while no mine is staged. */
export const mineStage = (): StageBox | null => box;

/** Publish the ✓ key and the whole pair — wall toolbar or mine discs. Cleared with `null`. */
export function setCapsuleStage(next: CapsuleStage | null): void {
  if (keys === next) return;
  if (keys && next && sameBox(keys.confirm, next.confirm) && sameBox(keys.pair, next.pair)) return;
  keys = next;
}

/** The live ✓/✕ geometry, or `null` while no action is staged. */
export const capsuleStage = (): CapsuleStage | null => keys;

/** Would `r` (viewport css px) come within `pad` px of the pair? Never true while nothing is staged. */
export function stageOverlaps(r: StageBox, pad = STAGE_CLEAR): boolean {
  const b = box;
  if (!b) return false;
  return r.left - pad < b.left + b.width
    && r.left + r.width + pad > b.left
    && r.top - pad < b.top + b.height
    && r.top + r.height + pad > b.top;
}
