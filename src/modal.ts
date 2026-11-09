/**
 * modal.ts — one modal sheet over its own blurred scrim.
 *
 * The Profile's Stars Vault is the first tenant: a compact tile opens a single obsidian sheet that
 * holds the whole programme, and its two footer keys open child sheets above it. The controller owns
 * what a modal must own — the scrim, the close key, Escape, the page scroll lock and the focus
 * hand-back — so the screen opening it only paints its own content. A closed sheet stays in the DOM
 * behind `hidden`, which is exactly what keeps it from taking a tap, and every timer is cleared, so
 * opening and closing never stacks listeners.
 *
 * Sheets stack: the page stays locked until the last one closes, and Escape belongs to the topmost
 * sheet alone, so dismissing the guide never dismisses the vault underneath it.
 */
import { motionReduced } from './settings';
import { impact } from './telegram';

export interface ModalOptions {
  /** Fired once the closing animation has settled and the sheet is hidden again. */
  onClose?: () => void;
}

export interface ModalHandle {
  /** Show the sheet, remembering `opener` for the focus hand-back. */
  open(opener?: HTMLElement | null): void;
  close(): void;
  isOpen(): boolean;
}

/** Matches the sheet's own slide-out transition. */
const CLOSE_MS = 240;
/** `.vault-modal` sits at 40 in the stylesheet; each sheet above it takes the next rung. */
const BASE_Z = 40;

/** The open sheets, outermost first. */
const stack: ModalHandle[] = [];
let savedOverflow: string | null = null;

function lockScroll(): void {
  if (savedOverflow !== null) return;
  savedOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  document.documentElement.classList.add('modal-open');
}

function unlockScroll(): void {
  if (savedOverflow === null) return;
  document.body.style.overflow = savedOverflow;
  savedOverflow = null;
  document.documentElement.classList.remove('modal-open');
}

export function createModal(root: HTMLElement, options: ModalOptions = {}): ModalHandle {
  const sheet = root.querySelector<HTMLElement>('[role="dialog"]') ?? root;
  let opener: HTMLElement | null = null;
  let timer = 0;

  const isOpen = (): boolean => !root.hidden;

  /** The one place the sheet goes away: focus back to its opener, scroll released. */
  function settle(): void {
    timer = 0;
    root.hidden = true;
    root.classList.remove('open', 'closing');
    root.style.removeProperty('z-index');
    const at = stack.indexOf(handle);
    if (at >= 0) stack.splice(at, 1);
    if (stack.length === 0) unlockScroll();
    const back = opener;
    opener = null;
    if (back && back.isConnected) {
      try { back.focus({ preventScroll: true }); } catch { /* opener is gone */ }
    }
    options.onClose?.();
  }

  const handle: ModalHandle = {
    open(source) {
      window.clearTimeout(timer);
      timer = 0;
      /* Re-opened mid-close: keep its rung in the stack and simply cancel the slide-out. */
      if (stack.includes(handle)) {
        root.classList.remove('closing');
        root.classList.add('open');
        return;
      }
      lockScroll();
      opener = source ?? (document.activeElement as HTMLElement | null);
      stack.push(handle);
      root.style.zIndex = String(BASE_Z + stack.length - 1);
      root.hidden = false;
      root.classList.remove('closing');
      void root.offsetWidth;                 // lay the sheet out at its closed position first
      root.classList.add('open');
      try { sheet.focus({ preventScroll: true }); } catch { /* nothing focusable */ }
    },
    close() {
      if (!isOpen() || root.classList.contains('closing')) return;
      root.classList.remove('open');
      root.classList.add('closing');
      window.clearTimeout(timer);
      timer = window.setTimeout(settle, motionReduced() ? 0 : CLOSE_MS);
    },
    isOpen,
  };

  /* One delegated tap: the scrim, the close key and the drag handle all carry this marker. */
  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target || !target.closest('[data-modal-close]')) return;
    impact('light');
    handle.close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isOpen()) return;
    if (stack[stack.length - 1] !== handle) return;
    event.preventDefault();
    handle.close();
  });

  return handle;
}