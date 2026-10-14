/**
 * boardmode.ts — the board's action modes, as pure arithmetic. No DOM, no drawing, no state.
 *
 * A tap puts the board into exactly one mode: a ball in hand (its legal-move dots), a wall preview
 * (the dashed bar and its confirm caps), or the mine key. The three never share the board — picking
 * a ball drops any wall preview, and previewing a wall puts the ball back down — and that rule is
 * the whole of this module. It lives outside `main.ts` so it can be asserted without a browser.
 *
 * `preview` is opaque here: `main.ts` puts its `Ghost` in it, a test puts anything it likes.
 */

export interface BoardMode<P> {
  /** the ball in hand, by id — the only ball whose legal-move dots are drawn */
  selected: number | null;
  /** a live wall preview: a hovered groove or an armed slot. `null` = the board is not previewing */
  preview: P | null;
  /** the mine key is down: the whole board offers squares instead */
  mine: boolean;
}

/** Nothing in hand — what a fresh board and a settled turn both look like. */
export const BOARD_IDLE: BoardMode<never> = { selected: null, preview: null, mine: false };

/** A tap on one of your balls, or on empty space with `null`. Any wall preview goes with it. */
export const pickBall = <P>(m: BoardMode<P>, id: number | null): BoardMode<P> =>
  ({ ...m, selected: id, preview: null });

/**
 * A groove: the wall preview comes up and the ball in hand goes back down, so a dashed bar can never
 * be drawn under a selection ring. `null` — the pointer left the board — drops the bar alone, which
 * is what keeps a hover a preview rather than a commitment.
 */
export const previewWall = <P>(m: BoardMode<P>, preview: P | null): BoardMode<P> =>
  ({ ...m, preview, selected: preview === null ? m.selected : null });

/** The mine key owns the board: while it is down, both of the other modes stand down. */
export const holdMineKey = <P>(m: BoardMode<P>, on: boolean): BoardMode<P> =>
  ({ ...m, mine: on, selected: on ? null : m.selected, preview: on ? null : m.preview });

/** The dots are drawn only while a ball is in hand and nothing else owns the board. */
export const moveDots = <P>(m: BoardMode<P>): boolean =>
  m.selected !== null && m.preview === null && !m.mine;

/** The selection ring follows the dots: a previewing or mining board shows no ball as picked. */
export const selectionRing = <P>(m: BoardMode<P>, ballId: number): boolean =>
  moveDots(m) && m.selected === ballId;
