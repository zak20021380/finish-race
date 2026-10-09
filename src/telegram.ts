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

/** Only the colours the shell actually paints from. */
export interface TgThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  secondary_bg_color?: string;
}

interface TgBackButton {
  show(): void;
  hide(): void;
  onClick?(cb: () => void): void;
}

interface TgInitDataUnsafe {
  user?: TgUser;
  language_code?: string;
  start_param?: string;
}

interface TgWebApp {
  ready(): void;
  expand(): void;
  initData?: string;
  initDataUnsafe?: TgInitDataUnsafe;
  languageCode?: string;
  language_code?: string;
  startParam?: string;
  start_param?: string;
  colorScheme?: 'light' | 'dark';
  themeParams?: TgThemeParams;
  platform?: string;
  BackButton?: TgBackButton;
  HapticFeedback?: {
    impactOccurred(s: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(t: 'error' | 'success' | 'warning'): void;
  };
  setHeaderColor?(c: string): void;
  setBackgroundColor?(c: string): void;
  setColorScheme?(c: 'light' | 'dark'): void;
  disableVerticalSwipes?(): void;
  viewportStableHeight?: number;
  onEvent?(e: string, cb: () => void): void;
}
declare global { interface Window { Telegram?: { WebApp?: TgWebApp } } }

const tg = window.Telegram?.WebApp;

export const tgUser = (): TgUser | undefined => tg?.initDataUnsafe?.user;

/**
 * The client's language, e.g. `fa` or `pt-BR`. Telegram puts it in the initData query string rather
 * than next to the user, so try the documented spots and then the query string before the browser.
 */
export function languageCode(): string {
  const fromTg = tg?.initDataUnsafe?.language_code ?? tg?.languageCode ?? tg?.language_code;
  if (fromTg) return fromTg;
  try {
    const raw = tg?.initData;
    if (raw) {
      const p = new URLSearchParams(raw);
      const lc = p.get('language_code');
      if (lc) return lc;
    }
  } catch { /* malformed initData */ }
  return navigator.language || '';
}

/** `t.me/<bot>/detour?startapp=<x>` — what a team invite link carries, for when teams go online. */
export function startParam(): string {
  const fromTg = tg?.initDataUnsafe?.start_param ?? tg?.startParam ?? tg?.start_param;
  if (fromTg) return fromTg;
  try { return new URLSearchParams(tg?.initData ?? '').get('startapp') ?? ''; } catch { return ''; }
}

/* ---------- theme ---------- */

const hex = (v: unknown): string => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : '');

/** The canvas the clay sits on. Chrome, the OS tab and Telegram's background all take it. */
const CANVAS = '#f1f5f9';

/**
 * The SDK loads in an ordinary tab too, and there it answers `colorScheme: 'light'` with empty
 * themeParams. Which no longer matters: the app ships one light-clay theme, so a client in night
 * mode gets the same surfaces as one in day mode. Only the client's accent is read, and it tints
 * the secondary brand ramp — never a fill that carries white type.
 */
export function applyTheme() {
  const p: TgThemeParams = tg?.themeParams ?? {};
  const r = document.documentElement;
  r.classList.remove('dark');
  r.style.colorScheme = 'light';

  const accent = hex(p.button_color);
  if (accent) {
    r.style.setProperty('--brand-1', accent);
    r.style.setProperty('--brand-2', accent);
  } else {
    r.style.removeProperty('--brand-1');
    r.style.removeProperty('--brand-2');
  }

  try { tg?.setHeaderColor?.(CANVAS); tg?.setBackgroundColor?.(CANVAS); tg?.setColorScheme?.('light'); } catch { /* outside Telegram */ }
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', CANVAS);
    const cs = document.querySelector('meta[name="color-scheme"]');
    if (cs) cs.setAttribute('content', 'light');
  } catch { /* no head */ }
}

export function initTelegram() {
  try {
    tg?.ready();
    tg?.expand();
    tg?.disableVerticalSwipes?.();
  } catch { /* running outside Telegram */ }

  applyTheme();

  const setViewport = () => {
    const h = tg?.viewportStableHeight;
    if (h) document.documentElement.style.setProperty('--app-h', `${h}px`);
  };
  setViewport();
  tg?.onEvent?.('viewportChanged', setViewport);
  tg?.onEvent?.('themeChanged', applyTheme);
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
