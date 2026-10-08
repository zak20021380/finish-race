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

/** Relative luminance, so an unusual `bg_color` still lands on the right palette. */
function darkAt(hexColor: string, fallback: boolean): boolean {
  if (!hexColor) return fallback;
  const h = hexColor.replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = parseInt(s, 16);
  if (Number.isNaN(n)) return fallback;
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum < 0.42;
}

const prefersDark = matchMedia('(prefers-color-scheme: dark)');
let systemDark = prefersDark.matches;
try { prefersDark.addEventListener('change', (e) => { systemDark = e.matches; applyTheme(); }); } catch { /* fixed at load */ }

/**
 * The SDK loads in an ordinary tab too, and there it answers `colorScheme: 'light'` with empty
 * themeParams — which would pin the app to light forever. Only a real client gets to declare one.
 */
const inTelegram = !!tg && !!tg.platform && tg.platform !== 'unknown';

export let isDark = false;

/**
 * themeParams decide the palette; the browser's own preference decides it when Telegram is absent.
 * Only the three surface colours Telegram actually describes are handed to CSS — brand hues stay
 * the app's, so a client with an odd accent still reads as Detour.
 */
export function applyTheme() {
  const p: TgThemeParams = tg?.themeParams ?? {};
  const bg = hex(p.secondary_bg_color) || hex(p.bg_color);
  const scheme = inTelegram && (tg?.colorScheme === 'light' || tg?.colorScheme === 'dark') ? tg.colorScheme : '';
  isDark = scheme ? scheme === 'dark' : darkAt(bg, systemDark);

  const r = document.documentElement;
  r.classList.toggle('dark', isDark);
  const set = (k: string, v: string) => { if (v) r.style.setProperty(k, v); else r.style.removeProperty(k); };
  set('--tg-bg', bg || hex(p.bg_color));
  set('--tg-ink', hex(p.text_color));
  set('--tg-soft', hex(p.hint_color));

  const chrome = isDark ? '#17171f' : '#eeeaf8';
  try { tg?.setHeaderColor?.(chrome); tg?.setBackgroundColor?.(chrome); tg?.setColorScheme?.(isDark ? 'dark' : 'light'); } catch { /* outside Telegram */ }
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isDark ? '#12121a' : '#eeeaf8');
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
