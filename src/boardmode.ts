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
 *
 * That same rule is why a *hover* may never reach here while a ball is in hand: `previewWall` puts
 * the ball back down, so a pointer travelling from a picked ball towards one of its legal-move dots
 * crosses a groove on the way, and each crossing would wipe the dots the player is aiming at. A
 * picked ball owns the pointer until it is put down or played — see `holdsBall`.
 */
export const previewWall = <P>(m: BoardMode<P>, preview: P | null): BoardMode<P> =>
  ({ ...m, preview, selected: preview === null ? m.selected : null });

/**
 * A ball is in hand — the one state a hover must never take away. `main.ts` asks this before it lets
 * a pointer move become a wall preview, so the dots stay up for the whole journey and only an
 * explicit tap on a groove that is not a legal-move target hands the board over to a wall.
 */
export const holdsBall = <P>(m: BoardMode<P>): boolean => m.selected !== null;

/** The mine key owns the board: while it is down, both of the other modes stand down. */
export const holdMineKey = <P>(m: BoardMode<P>, on: boolean): BoardMode<P> =>
  ({ ...m, mine: on, selected: on ? null : m.selected, preview: on ? null : m.preview });

/**
 * A tap on one of your own balls while the mine key is down: the key lets go and the ball comes to
 * hand in the same gesture. This is the board's own way out of the placement band — without it the
 * only escape is the key itself, and a player who taps their pawn is told nothing at all.
 */
export const pickBallFromMine = <P>(m: BoardMode<P>, id: number | null): BoardMode<P> =>
  ({ ...m, mine: false, preview: null, selected: id });

/** The dots are drawn only while a ball is in hand and nothing else owns the board. */
export const moveDots = <P>(m: BoardMode<P>): boolean =>
  m.selected !== null && m.preview === null && !m.mine;

/** The selection ring follows the dots: a previewing or mining board shows no ball as picked. */
export const selectionRing = <P>(m: BoardMode<P>, ballId: number): boolean =>
  moveDots(m) && m.selected === ballId;
