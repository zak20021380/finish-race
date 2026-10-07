/**
 * telegram.ts — everything Telegram, all of it optional. Outside the Mini App each helper is a
 * no-op, so the same build plays in a plain browser tab.
 */
import { settings } from './settings';

export interface TgUser {
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

interface TgBackButton {
  show(): void;
  hide(): void;
  onClick?(cb: () => void): void;
}

interface TgWebApp {
  ready(): void;
  expand(): void;
  initDataUnsafe?: { user?: TgUser };
  BackButton?: TgBackButton;
  HapticFeedback?: {
    impactOccurred(s: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(t: 'error' | 'success' | 'warning'): void;
  };
  setHeaderColor?(c: string): void;
  setBackgroundColor?(c: string): void;
  disableVerticalSwipes?(): void;
  viewportStableHeight?: number;
  onEvent?(e: string, cb: () => void): void;
}
declare global { interface Window { Telegram?: { WebApp?: TgWebApp } } }

const tg = window.Telegram?.WebApp;

export const tgUser = (): TgUser | undefined => tg?.initDataUnsafe?.user;

export function initTelegram() {
  try {
    tg?.ready();
    tg?.expand();
    tg?.disableVerticalSwipes?.();
    tg?.setHeaderColor?.('#eeeaf8');
    tg?.setBackgroundColor?.('#eeeaf8');
  } catch { /* running outside Telegram */ }

  const setViewport = () => {
    const h = tg?.viewportStableHeight;
    if (h) document.documentElement.style.setProperty('--app-h', `${h}px`);
  };
  setViewport();
  tg?.onEvent?.('viewportChanged', setViewport);
}

/**
 * Wire the native BackButton and hand back the visibility toggle the router needs.
 * Returns a no-op when Telegram gives us no BackButton, so callers stay unconditional.
 */
export function onBackPress(cb: () => void): (visible: boolean) => void {
  const bb = tg?.BackButton;
  if (bb) {
    try { bb.onClick?.(cb); } catch { /* ignore */ }
    return (visible: boolean) => { try { if (visible) bb.show(); else bb.hide(); } catch { /* ignore */ } };
  }
  tg?.onEvent?.('backButtonClicked', cb);   // pre-BackButton clients
  return () => {};
}

export const impact = (s: 'light' | 'medium') => {
  if (!settings.haptics) return;
  try { tg?.HapticFeedback?.impactOccurred(s); } catch { /* ignore */ }
};

export const notify = (t: 'success' | 'error' | 'warning') => {
  if (!settings.haptics) return;
  try { tg?.HapticFeedback?.notificationOccurred(t); } catch { /* ignore */ }
};
