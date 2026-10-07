/**
 * sheets.ts — bottom sheets over a dimming scrim, one at a time.
 * A closed sheet leaves the DOM with `hidden`, so it can never take a tap; the slide itself
 * only animates transform/opacity.
 */
import { motionReduced } from './settings';

export interface Sheets {
  open(el: HTMLElement): void;
  close(): void;
  readonly isOpen: boolean;
}

const MS = 260;

export function createSheets(scrim: HTMLElement): Sheets {
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
      el.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    },
    close() {
      if (!panel) return;
      panel.classList.remove('open');
      scrim.classList.remove('open');
      panel.style.pointerEvents = 'none';   // the slide-out must not swallow taps
      timer = setTimeout(() => settle(true), motionReduced() ? 0 : MS);
    },
    get isOpen() { return panel !== null; },
  };

  scrim.addEventListener('click', () => api.close());
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && t.closest('[data-sheet-close]')) api.close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.close(); });

  return api;
}
