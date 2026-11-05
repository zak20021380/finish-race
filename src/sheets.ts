/**
 * sheets.ts — bottom sheets over a dimming scrim, one at a time.
 * A closed sheet leaves the DOM with `hidden`, so it can never take a tap; the slide itself
 * only animates transform/opacity.
 */
import { motionReduced } from './settings';
import { impact } from './telegram';

export interface Sheets {
  open(el: HTMLElement): void;
  close(): void;
  readonly isOpen: boolean;
}

/** Host hooks the sheets system reports back to. */
export interface SheetsOptions {
  /**
   * A sheet finished going away through `close()` — the scrim, Escape, a `[data-sheet-close]`
   * key or an explicit call — and nothing else has taken its place. Fired once the slide-out
   * has settled, so `isOpen` already reads false. The swap `open()` performs over the sheet
   * on screen never reports here: that sheet was replaced, not closed.
   */
  onClose?: (el: HTMLElement) => void;
}

const MS = 260;

export function createSheets(scrim: HTMLElement, opts: SheetsOptions = {}): Sheets {
  let panel: HTMLElement | null = null;
  let opener: HTMLElement | null = null;
  let timer = 0;

  const settle = (restoreFocus: boolean) => {
    clearTimeout(timer);
    if (!panel) return;
    panel.hidden = true;
    panel.classList.remove('open');
    panel.style.pointerEvents = '';
    scrim.hidden = true;
    scrim.classList.remove('open');
    panel = null;
    const back = opener;
    opener = null;
    if (restoreFocus) { try { back?.focus({ preventScroll: true }); } catch { /* gone already */ } }
  };

  const api: Sheets = {
    open(el) {
      const keep = panel ? opener : (document.activeElement as HTMLElement | null);
      settle(false);                        // swap sheets without bouncing focus around
      panel = el;
      opener = keep;
      el.hidden = false;
      scrim.hidden = false;
      void el.offsetWidth;                  // lay the sheet out at its closed position first
      el.classList.add('open');
      scrim.classList.add('open');
      /* the panel itself can hold the initial focus, so a sheet that opens on its own never
         paints a focus ring on a button the player has not reached for yet */
      const first = el.querySelector<HTMLElement>('[data-autofocus]') ?? (el.matches('[data-autofocus]') ? el : null);
      first?.focus({ preventScroll: true });
    },
    close() {
      if (!panel) return;
      const closing = panel;                 // reported back once the slide-out has settled
      panel.classList.remove('open');
      scrim.classList.remove('open');
      panel.style.pointerEvents = 'none';   // the slide-out must not swallow taps
      timer = window.setTimeout(() => {
        settle(true);
        opts.onClose?.(closing);
      }, motionReduced() ? 0 : MS);
    },
    get isOpen() { return panel !== null; },
  };

  scrim.addEventListener('click', () => { impact('light'); api.close(); });
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && t.closest('[data-sheet-close]')) { impact('light'); api.close(); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.close(); });

  return api;
}
