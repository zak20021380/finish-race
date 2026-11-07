/**
 * router.ts — the app's screen stack, with no library.
 *
 * A switch between the five main tabs is a plain visibility swap: no slide, no
 * timeout, and never two full-screen trees composited at once. Every other route
 * keeps the transform + opacity slide, where the motion carries real meaning.
 *
 * `RoutePhase.after` is the second half of a switch: data refreshes, list
 * patches and remote reads run one painted frame after the new screen is up, so
 * the tap itself never waits on them. Any newer route cancels that queue.
 */
import { motionReduced } from './settings';

/** The half of a route switch that runs after the new screen has painted. */
export interface RoutePhase {
  /** True when this was an instant main-tab swap (no slide, no timeout). */
  readonly tab: boolean;
  /** Queue work for the frame after the swap; dropped when another route starts. */
  after(work: () => void): void;
}

export interface Router {
  go(id: string, opts?: { replace?: boolean }): void;
  back(): boolean;
  /** unwind to a screen already on the stack — "quit to menu" without stacking copies of home */
  popTo(id: string): boolean;
  readonly current: string;
  readonly canGoBack: boolean;
  start(id: string): void;
}

const ENTER = ['in-fwd', 'in-back'];
const LEAVE = ['out-fwd', 'out-back'];
const MS = 280;

/** The five bottom-nav destinations: one tap moves between them instantly. */
const TABS: ReadonlySet<string> = new Set(['home', 'arena', 'ranks', 'shop', 'profile']);

/** Legacy route aliases: pre-split "compete" lands on Arena (its old default feed). */
const ALIAS: Record<string, string> = { compete: 'arena' };
const resolve = (id: string): string => ALIAS[id] ?? id;

export function createRouter(
  root: HTMLElement,
  onScreen: (id: string, prev: string | null, phase: RoutePhase) => void,
): Router {
  const screens = new Map<string, HTMLElement>();
  for (const el of root.querySelectorAll<HTMLElement>('.screen')) screens.set(el.dataset.screen ?? '', el);

  let stack: string[] = [];
  let settle: (() => void) | null = null;

  /* The current route's second half. One queue, cancelled wholesale: a rapid
     tap sequence must never leave an older tab's refresh painting over a newer
     one. */
  let afterFrame = 0;
  let afterFrame2 = 0;
  let afterWork: Array<() => void> = [];
  /** Identifies the live transition, so a phase object from an older route is inert. */
  let epoch = 0;

  function cancelAfter(): void {
    if (afterFrame) cancelAnimationFrame(afterFrame);
    if (afterFrame2) cancelAnimationFrame(afterFrame2);
    afterFrame = afterFrame2 = 0;
    afterWork = [];
  }

  function scheduleAfter(): void {
    if (!afterWork.length || afterFrame || afterFrame2) return;
    const work = afterWork;
    afterWork = [];
    /* Two frames: the first paints the newly shown panel, the second is the
       first moment it is safe to rebuild anything inside it. */
    afterFrame = requestAnimationFrame(() => {
      afterFrame = 0;
      afterFrame2 = requestAnimationFrame(() => {
        afterFrame2 = 0;
        for (const job of work) job();
      });
    });
  }

  function transition(fromId: string | null, toId: string, dir: 1 | -1) {
    const next = screens.get(toId);
    if (!next) return;
    const prev = fromId && fromId !== toId ? screens.get(fromId) : null;
    if (settle) settle();                       // land an in-flight slide before starting this one
    cancelAfter();
    const live = ++epoch;

    /* Every lobby-to-tab move is a visibility flip. Only the race board keeps a
       slide, because there the motion marks a stage change rather than a tab. */
    const tab = TABS.has(toId) && fromId !== 'game';
    const phase: RoutePhase = {
      tab,
      after(work) {
        if (live !== epoch) return;             // a nested route already replaced this one
        afterWork.push(work);
        scheduleAfter();
      },
    };

    if (tab || motionReduced()) {
      /* Strip anything a previous slide left behind before the panel is shown. */
      if (prev) {
        prev.classList.remove(...ENTER, ...LEAVE);
        prev.style.pointerEvents = '';
        prev.hidden = true;
      }
      next.classList.remove(...ENTER, ...LEAVE);
      next.style.pointerEvents = '';
      next.hidden = false;
      next.focus({ preventScroll: true });
      onScreen(toId, fromId, phase);
      return;
    }

    next.hidden = false;
    next.classList.add(dir > 0 ? 'in-fwd' : 'in-back');
    if (prev) {
      prev.classList.add(dir > 0 ? 'out-back' : 'out-fwd');
      prev.style.pointerEvents = 'none';
    }
    const done = () => {
      settle = null;
      next.classList.remove(...ENTER);
      if (!prev) return;
      prev.hidden = true;
      prev.classList.remove(...LEAVE);
      prev.style.pointerEvents = '';
    };
    settle = done;
    setTimeout(done, MS);
    next.focus({ preventScroll: true });
    onScreen(toId, fromId, phase);
  }

  return {
    go(id, opts) {
      const to = resolve(id);
      const from = stack[stack.length - 1] ?? null;
      if (!screens.has(to) || to === from) return;
      if (opts?.replace && from !== null) stack[stack.length - 1] = to;
      else stack.push(to);
      transition(from, to, 1);
    },
    back() {
      if (stack.length < 2) return false;
      const from = stack.pop() as string;
      const to = stack[stack.length - 1];
      transition(from, to, -1);
      return true;
    },
    popTo(id) {
      const to = resolve(id);
      const at = stack.lastIndexOf(to);
      const from = stack[stack.length - 1];
      if (at < 0 || from === to) return false;
      stack = stack.slice(0, at + 1);
      transition(from, to, -1);
      return true;
    },
    get current() { return stack[stack.length - 1] ?? ''; },
    get canGoBack() { return stack.length > 1; },
    start(id) {
      const to = resolve(id);
      stack = [to];
      cancelAfter();
      const live = ++epoch;
      if (settle) settle();
      for (const [name, el] of screens) {
        el.classList.remove(...ENTER, ...LEAVE);
        el.style.pointerEvents = '';
        el.hidden = name !== to;
      }
      const phase: RoutePhase = {
        tab: false,
        after(work) {
          if (live !== epoch) return;
          afterWork.push(work);
          scheduleAfter();
        },
      };
      onScreen(to, null, phase);
    },
  };
}
