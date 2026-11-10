/**
 * carousel.ts — the Home highlights track's one horizontal gesture.
 *
 * The track is a GPU-composited flex row driven by `translate3d`; this module owns
 * the finger, home.ts owns the settled index and the 230ms snap. A drag follows the
 * finger 1:1 inside the track and can move at most one slide: the release commits
 * `currentIndex ± 1` only when the travel clears 40px or the flick beats 0.3px/ms,
 * so momentum can never skip two or three cards.
 *
 * Vertical intent is handed straight back to the page (the axis lock), and a second
 * touch point ends the gesture so a pinch is never read as a swipe. Listeners are
 * passive: `touch-action: pan-y pinch-zoom` already stops the browser from panning
 * the track, so horizontal travel never needs a preventDefault.
 */

/** Horizontal travel (px) a drag must clear before it registers a slide switch. */
const SWIPE_THRESHOLD = 40;
/** Flick speed (px/ms) that counts as intent even under the distance threshold. */
const FLICK_VELOCITY = 0.3;
/** Below this much travel the axis is still undecided; vertical wins past it. */
const AXIS_LOCK = 8;
/** Past the first / last slide the finger meets a soft wall instead of dead space. */
const EDGE_RESISTANCE = 0.28;

export interface SwipeTrack {
  /** The viewport that receives the touch. */
  el: HTMLElement;
  /** The composited layer home.ts translates to the settled slide. */
  track: HTMLElement;
  /** Number of slides currently in the track. */
  count(): number;
  /** The settled slide index, owned by home.ts. */
  index(): number;
  /** Commit to a slide (home.ts clamps and animates the transform). */
  goTo(i: number): void;
  /** True when the user asked for reduced motion (instant snap, no follow). */
  reduced(): boolean;
}

export function bindSwipe(t: SwipeTrack): void {
  const { el, track } = t;
  let startX = 0;
  let startY = 0;
  let startIndex = 0;
  let dragging = false;
  let axis: 'none' | 'x' | 'y' = 'none';
  let dx = 0;
  let lastX = 0;
  let lastTime = 0;
  let velocity = 0;
  /** True while the track sits at a finger offset instead of a settled slide. */
  let displaced = false;

  const follow = (offset: number): void => {
    displaced = true;
    track.style.transition = 'none';
    track.style.transform = `translate3d(calc(${-startIndex * 100}% + ${offset}px), 0, 0)`;
  };

  /* A gesture that dies under a second finger must never leave the track parked
     between slides: restore the settled index and let the 230ms transition snap. */
  const restore = (): void => {
    if (!displaced) return;
    displaced = false;
    t.goTo(t.index());
  };

  const onStart = (e: TouchEvent): void => {
    if (e.touches.length !== 1) { restore(); dragging = false; return; }
    const touch = e.touches[0];
    startX = lastX = touch.clientX;
    startY = touch.clientY;
    startIndex = t.index();
    dx = 0;
    velocity = 0;
    lastTime = e.timeStamp || performance.now();
    dragging = true;
    axis = 'none';
  };

  const onMove = (e: TouchEvent): void => {
    if (!dragging) return;
    if (e.touches.length !== 1) { restore(); dragging = false; return; }
    const touch = e.touches[0];
    dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (axis === 'none') {
      if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
      axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      if (axis === 'y') { dragging = false; return; }
    }
    if (axis !== 'x' || t.reduced()) return;

    const now = e.timeStamp || performance.now();
    const elapsed = now - lastTime;
    if (elapsed > 0) velocity = (touch.clientX - lastX) / elapsed;
    lastX = touch.clientX;
    lastTime = now;

    const max = t.count() - 1;
    const pastStart = startIndex <= 0 && dx > 0;
    const pastEnd = startIndex >= max && dx < 0;
    follow(pastStart || pastEnd ? dx * EDGE_RESISTANCE : dx);
  };

  const onEnd = (): void => {
    if (!dragging) { restore(); return; }
    dragging = false;
    if (axis !== 'x') { restore(); return; }

    /* A finger that has been resting is not a flick, however fast it last moved. */
    if (performance.now() - lastTime > 120) velocity = 0;
    const flicked = Math.abs(velocity) > FLICK_VELOCITY;
    const travelled = Math.abs(dx) > SWIPE_THRESHOLD;
    let dir = 0;
    if (flicked) dir = velocity < 0 ? 1 : -1;
    else if (travelled) dir = dx < 0 ? 1 : -1;

    const max = t.count() - 1;
    const next = Math.max(0, Math.min(max, startIndex + dir));
    displaced = false;
    t.goTo(next);
  };

  el.addEventListener('touchstart', onStart, { passive: true });
  el.addEventListener('touchmove', onMove, { passive: true });
  el.addEventListener('touchend', onEnd, { passive: true });
  el.addEventListener('touchcancel', onEnd, { passive: true });
}
