/**
 * boardpieces.ts — where the pawns are, in viewport css px, for the guidance layers.
 *
 * `callouts.ts` raises a "MINE!" / "WALL" beat over the grid and must never stand it on a ball, but
 * it has no model of the board: the pieces are canvas pixels, and asking the canvas meant a
 * `getImageData()` readback — twelve of them, inside a MutationObserver microtask, on the exact
 * tick the first explosion frame was due. That flushed the GPU pipeline and forced a synchronous
 * layout behind every detonation.
 *
 * So the board publishes its own answer instead. `main.ts` — the one owner of the state and of the
 * geometry — writes every live pawn's box here whenever the board changes; the overlay only has to
 * do arithmetic. Nothing in this module reads, measures or paints.
 */

/** A viewport box, in css px. The same shape as `StageBox` and `TutorialRect`, deliberately. */
export interface PieceBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The live pawns' footprints. Replaced wholesale, never mutated in place. */
let boxes: PieceBox[] = [];

/** Publish every live pawn's box. `main.ts` is the only caller. */
export function setPieceBoxes(next: PieceBox[]): void {
  boxes = next;
}

/** Would `r` come within `pad` px of a pawn? False on an empty board, and never a canvas read. */
export function pieceOverlaps(r: PieceBox, pad = 0): boolean {
  for (const b of boxes) {
    if (r.left - pad < b.left + b.width
      && r.left + r.width + pad > b.left
      && r.top - pad < b.top + b.height
      && r.top + r.height + pad > b.top) return true;
  }
  return false;
}
