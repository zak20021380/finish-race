/**
 * router.ts — the app's screen stack, with no library.
 *
 * Only transform and opacity animate, so the compositor does the work and the canvas never
 * re-lays-out mid-slide; under reduced motion the swap is instant.
 */
import { motionReduced } from './settings';

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

export function createRouter(root: HTMLElement, onScreen: (id: string, prev: string | null) => void): Router {
  const screens = new Map<string, HTMLElement>();
  for (const el of root.querySelectorAll<HTMLElement>('.screen')) screens.set(el.dataset.screen ?? '', el);

  let stack: string[] = [];
  let settle: (() => void) | null = null;

  function transition(fromId: string | null, toId: string, dir: 1 | -1, instant: boolean) {
    const next = screens.get(toId);
    if (!next) return;
    const prev = fromId && fromId !== toId ? screens.get(fromId) : null;
    if (settle) settle();                       // land an in-flight slide before starting this one

    if (instant || motionReduced()) {
      if (prev) prev.hidden = true;
      next.hidden = false;
      next.focus({ preventScroll: true });
      onScreen(toId, fromId);
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
    onScreen(toId, fromId);
  }

  return {
    go(id, opts) {
      const from = stack[stack.length - 1] ?? null;
      if (!screens.has(id) || id === from) return;
      if (opts?.replace && from !== null) stack[stack.length - 1] = id;
      else stack.push(id);
      transition(from, id, 1, false);
    },
    back() {
      if (stack.length < 2) return false;
      const from = stack.pop() as string;
      const to = stack[stack.length - 1];
      transition(from, to, -1, false);
      return true;
    },
    popTo(id) {
      const at = stack.lastIndexOf(id);
      const from = stack[stack.length - 1];
      if (at < 0 || from === id) return false;
      stack = stack.slice(0, at + 1);
      transition(from, id, -1, false);
      return true;
    },
    get current() { return stack[stack.length - 1] ?? ''; },
    get canGoBack() { return stack.length > 1; },
    start(id) {
      stack = [id];
      for (const [name, el] of screens) el.hidden = name !== id;
      onScreen(id, null);
    },
  };
}
