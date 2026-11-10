/**
 * carousel.ts — the Home highlights track's one horizontal gesture.
 *
 * A single drag can never move more than one slide. The finger follows the track
 * 1:1 while it is down (clamped to a single step in either direction), and the
 * release commits to `currentIndex ± 1` only when the horizontal travel clears
 * 42px. Velocity is deliberately ignored: a fast flick and a slow drag resolve to
 * the same one-step decision, so momentum can never skip two or three cards.
 *
 * Vertical intent is handed straight back to the page (the axis lock), and a
 * second touch point ends the gesture so a pinch is never read as a swipe.
 * The dots and keyboard live in home.ts; this module owns touch only and reports
 * its decision through `goTo`, which clamps again on the way to the scroll.
 */

/** Horizontal travel (px) a drag must clear before it registers a slide switch. */
const SWIPE_THRESHOLD = 42;
/** Below this much travel the axis is still undecided; vertical wins past it. */
const AXIS_LOCK = 8;

export interface SwipeTrack {
  /** The scroll container whose `scrollLeft` the gesture drives. */
  el: HTMLElement;
  /** Number of slides currently in the track. */
  count(): number;
  /** The settled slide index, read from the live scroll offset. */
  index(): number;
  /** Commit to a slide (home.ts clamps and animates the scroll). */
  goTo(i: number): void;
  /** True when the user asked for reduced motion (instant snap, no follow). */
  reduced(): boolean;
}

export function bindSwipe(track: SwipeTrack): void {
  const { el } = track;
  let startX = 0;
  let startY = 0;
  let startIndex = 0;
  let step = 1;
  let baseLeft = 0;
  let dragging = false;
  let axis: 'none' | 'x' | 'y' = 'none';
  let travelled = 0;

  const measure = (): void => {
    const slides = el.querySelectorAll<HTMLElement>('.car-card');
    step = slides.length > 1
      ? slides[1].offsetLeft - slides[0].offsetLeft || el.clientWidth || 1
      : el.clientWidth || 1;
  };

  const onStart = (e: TouchEvent): void => {
    if (e.touches.length !== 1) { dragging = false; return; }
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    startIndex = track.index();
    measure();
    baseLeft = startIndex * step;
    dragging = true;
    axis = 'none';
    travelled = 0;
  };

  const onMove = (e: TouchEvent): void => {
    if (!dragging) return;
    if (e.touches.length !== 1) { dragging = false; return; }
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (axis === 'none') {
      if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
      axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      if (axis === 'y') { dragging = false; return; }
    }
    if (axis !== 'x') return;
    /* Horizontal intent: own the gesture so the browser's own pan / momentum
       cannot carry the track past the one step this drag is allowed to travel. */
    if (e.cancelable) e.preventDefault();
    travelled = dx;
    if (track.reduced()) return;
    const max = track.count() - 1;
    /* Finger follow, clamped to a single step either side of the start slide. */
    const lo = Math.max(0, startIndex - 1) * step;
    const hi = Math.min(max, startIndex + 1) * step;
    const target = Math.max(lo, Math.min(hi, baseLeft - dx));
    el.style.scrollBehavior = 'auto';
    el.style.scrollSnapType = 'none';
    el.scrollLeft = target;
  };

  const onEnd = (): void => {
    if (!dragging) return;
    dragging = false;
    el.style.scrollBehavior = '';
    el.style.scrollSnapType = '';
    if (axis !== 'x') return;
    const max = track.count() - 1;
    /* One step, never more: the sign of the travel picks the direction, the
       threshold decides whether it counts at all. Velocity is not consulted. */
    const dir = Math.abs(travelled) > SWIPE_THRESHOLD ? (travelled < 0 ? 1 : -1) : 0;
    const next = Math.max(0, Math.min(max, startIndex + dir));
    track.goTo(next);
  };

  el.addEventListener('touchstart', onStart, { passive: true });
  el.addEventListener('touchmove', onMove, { passive: false });
  el.addEventListener('touchend', onEnd, { passive: true });
  el.addEventListener('touchcancel', onEnd, { passive: true });
}