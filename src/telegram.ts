/**
 * telegram.ts — everything Telegram, all of it optional. Outside the Mini App each helper is a
 * no-op, so the same build plays in a plain browser tab.
 */
import { settings } from './settings';
import { botAppLink, telegramShareLink } from '../shared/config';

export interface TgUser {
  /** Telegram's numeric user id — the key the admin allowlist matches on. */
  id?: number;
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
  /** Present since 6.0, so every client that can call anything can also answer this. */
  isVersionAtLeast?(version: string): boolean;
  viewportStableHeight?: number;
  openTelegramLink?(url: string): void;
  openLink?(url: string): void;
  onEvent?(e: string, cb: () => void): void;
}
declare global { interface Window { Telegram?: { WebApp?: TgWebApp } } }

const tg = window.Telegram?.WebApp;

/**
 * Whether the client actually supports an API introduced in `version`. Calling a newer method on
 * an older client does not throw — Telegram's SDK logs an "unsupported method" warning for every
 * call, which is what flooded a 6.0 client's console. Optional chaining alone cannot stop that:
 * the methods exist as warning stubs. A client that predates the check itself (or a test double
 * without one) answers by what it exposes, so nothing is switched off on it.
 */
function atLeast(version: string): boolean {
  const check = tg?.isVersionAtLeast;
  if (typeof check !== 'function') return !!tg;
  try { return check.call(tg, version); } catch { return false; }
}

/**
 * The Mini App's bot handle: what every deep link is built on. Re-exported from the shared config
 * so the client, the Worker and the harnesses can never drift apart.
 */
export { BOT_HANDLE } from '../shared/config';

/**
 * The one invite URL a room ever has: `https://t.me/<bot>/play?startapp=room_<code>`.
 *
 * This is the single source of truth for a room invite. The code badge, the `Copy Link` key, the
 * header `Invite` pill and the empty rival plate all read the same active code and hand it to this
 * one function, so the four doors can never print four different links for one room. Whatever
 * spelling the caller has — `1909`, `#1909`, `room_1909` — is reduced to the four digits the
 * reader above matches, which is what makes a round trip through Telegram land back on the room.
 */
export function roomInviteUrl(code: string): string {
  const digits = String(code ?? '').replace(/\D/g, '').slice(0, 4);
  return digits.length === 4 ? botAppLink(`room_${digits}`) : '';
}

/** The same invite URL, wrapped in Telegram's native share page. '' when the code is unusable. */
export function roomShareUrl(code: string, text: string): string {
  const url = roomInviteUrl(code);
  return url ? telegramShareLink(url, text) : '';
}

export const tgUser = (): TgUser | undefined => tg?.initDataUnsafe?.user;

/**
 * The raw Mini App `initData` query string, or '' outside Telegram. The matchmaker verifies it
 * server-side (`worker/auth.ts`), so the client only ever forwards it — it never trusts it.
 */
export const tgInitData = (): string => tg?.initData ?? '';

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

/** Every query key a start parameter is known to arrive on, in the order they are trusted. */
const START_KEYS = ['startapp', 'tgWebAppStartParam', 'start_param'] as const;

/**
 * `t.me/<bot>/play?startapp=<x>` — the payload a deep link carries.
 *
 * The Mini App answers with `initDataUnsafe.start_param`; a plain browser tab (or a client that
 * strips initData) has no such field, so the same value is read off the URL instead: the query
 * string Telegram rewrites into, then the hash, then the initData query string. A room invite
 * therefore survives being opened outside the client — which is what makes a shared link work.
 */
export function startParam(): string {
  const fromTg = tg?.initDataUnsafe?.start_param ?? tg?.startParam ?? tg?.start_param;
  if (typeof fromTg === 'string' && fromTg) return fromTg;

  const fromQuery = (raw: string): string => {
    try {
      const q = new URLSearchParams(raw.replace(/^[?#]/, ''));
      for (const k of START_KEYS) {
        const v = q.get(k);
        if (v) return v;
      }
    } catch { /* not a query string */ }
    return '';
  };

  try {
    const init = fromQuery(tg?.initData ?? '');
    if (init) return init;
  } catch { /* malformed initData */ }

  try {
    const q = fromQuery(window.location.search);
    if (q) return q;
    return fromQuery(window.location.hash);
  } catch { return ''; }
}

/**
 * The room a deep link points at, or ''. Three spellings name the same room — `room_1909` (what
 * the app shares), `#1909` (what people type) and a bare `1909` — and a payload with trailing junk
 * (`room_1909&ref=x`) still carries the code. Anything else in the start parameter (`ref_...`,
 * `team-...`) belongs to another feature and is left alone: exactly four digits after the room
 * prefix, or exactly four digits on their own.
 */
const ROOM_PREFIX = /^#?\s*room[\s_-]*(\d{4})(?!\d)/i;
const BARE_ROOM = /^#?\s*(\d{4})\s*$/;

/** One payload, read through the room grammar only. Junk after the digits never leaks into the code. */
function roomCodeOf(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  const match = ROOM_PREFIX.exec(value) ?? BARE_ROOM.exec(value);
  return match ? match[1] : '';
}

export function inviteRoomCode(): string {
  try {
    const fromStart = roomCodeOf(startParam());
    if (fromStart) return fromStart;
  } catch { /* fall through to the URL */ }
  /* A plain browser tab (or a link opened at the worker's own address) can carry the invite in
     the query instead: `?roomcode=1909` or `?room=1909`. Read through the same grammar, and only
     after the start parameter, so a normal Mini App launch is never overridden by URL debris. */
  try {
    const query = new URLSearchParams(window.location.search);
    return roomCodeOf(query.get('roomcode')) || roomCodeOf(query.get('room'));
  } catch {
    return '';
  }
}

/**
 * A squad invite payload: `squad_<id>`. The id is the registry's own, so the link cannot be
 * re-pointed by a handle rename, and a payload that is not exactly this shape is left alone
 * (`ref_...`, `room_...` and `team-...` belong to their own doors).
 */
const SQUAD_PAYLOAD = /^squad_([A-Za-z0-9_-]{1,48})$/i;

function squadIdOf(raw: string | null | undefined): string {
  const match = SQUAD_PAYLOAD.exec((raw ?? '').trim());
  return match ? match[1] : '';
}

/**
 * The squad a deep link points at, or ''. Read exactly like a room invite: the Mini App's start
 * parameter first, then the query string a plain browser tab carries (`?squad=`), so a shared
 * link still lands on the right squad outside Telegram.
 */
export function inviteSquadId(): string {
  try {
    const fromStart = squadIdOf(startParam());
    if (fromStart) return fromStart;
  } catch { /* fall through to the URL */ }
  try {
    /* A plain browser tab carries the same id in the query: `?squad=squad_<id>`, or the bare id
       (`?squad=<id>`) when a hand-made link is being tested. */
    const raw = (new URLSearchParams(window.location.search).get('squad') ?? '').trim();
    if (!raw) return '';
    return squadIdOf(raw) || (/^[A-Za-z0-9_-]{1,48}$/.test(raw) ? raw : '');
  } catch {
    return '';
  }
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

  /* The header/background/scheme setters arrived in 6.1; on an older client each call is just a
     warning in the console, and the page already paints its own light canvas. */
  if (atLeast('6.1')) {
    try { tg?.setHeaderColor?.(CANVAS); tg?.setBackgroundColor?.(CANVAS); tg?.setColorScheme?.('light'); } catch { /* outside Telegram */ }
  }
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
    /* 7.7 added the swipe lock; older clients log a warning per call and simply keep swiping. */
    if (atLeast('7.7')) tg?.disableVerticalSwipes?.();
  } catch { /* running outside Telegram */ }

  applyTheme();

  const setViewport = () => {
    const h = tg?.viewportStableHeight;
    if (h) document.documentElement.style.setProperty('--app-h', `${h}px`);
  };
  setViewport();
  /* Both events are 6.1 additions and warn one line each on every call below that. */
  if (atLeast('6.1')) {
    tg?.onEvent?.('viewportChanged', setViewport);
    tg?.onEvent?.('themeChanged', applyTheme);
  }
}

/**
 * Wire the native BackButton and hand back the visibility toggle the router needs.
 * Below 6.1 the button does not exist: every touch of it (including its click event) only logs
 * an unsupported-method warning, so the caller gets the same no-op as a browser tab. The app's
 * own back control stays in charge there.
 */
export function onBackPress(cb: () => void): (visible: boolean) => void {
  if (!atLeast('6.1')) return () => {};
  const bb = tg?.BackButton;
  if (!bb) return () => {};
  try { bb.onClick?.(cb); } catch { /* ignore */ }
  return (visible: boolean) => { try { if (visible) bb.show(); else bb.hide(); } catch { /* ignore */ } };
}

/** Haptic feedback is a 6.1 API; older clients expose warning stubs, so the version gate is the guard. */
const haptics = (): boolean => settings.haptics && atLeast('6.1');

export const impact = (s: 'light' | 'medium' | 'heavy') => {
  if (!haptics()) return;
  try { tg?.HapticFeedback?.impactOccurred(s); } catch { /* ignore */ }
};

/**
 * Open an external link the Telegram way when there is one available: a `t.me/…` hop rides
 * `openTelegramLink` (so bot-admin invites stay inside the client), anything else `openLink`;
 * outside Telegram — or on a client too old for both — the system browser takes it.
 */
export function openLink(url: string): void {
  try {
    if (url.includes('t.me/') && tg?.openTelegramLink) { tg.openTelegramLink(url); return; }
    if (tg?.openLink) { tg.openLink(url); return; }
  } catch { /* outside Telegram */ }
  try { window.open(url, '_blank', 'noopener'); } catch { /* webview blocked */ }
}

/**
 * Hand a `t.me/share/url` page to Telegram's own link handler, which answers with the native
 * recipient picker on mobile and desktop. Outside Telegram the browser takes the same URL.
 */
export function openTelegramShare(shareUrl: string): void {
  try {
    if (tg?.openTelegramLink) { tg.openTelegramLink(shareUrl); return; }
  } catch { /* outside Telegram */ }
  try { window.open(shareUrl, '_blank'); } catch { /* webview blocked */ }
}

export const notify = (t: 'success' | 'error' | 'warning') => {
  if (!haptics()) return;
  try { tg?.HapticFeedback?.notificationOccurred(t); } catch { /* ignore */ }
};

/** A mine going off: the hardest pattern Telegram offers, error buzz over a heavy impact, as one call. */
export const detonation = () => {
  if (!haptics()) return;
  try {
    tg?.HapticFeedback?.notificationOccurred('error');
    tg?.HapticFeedback?.impactOccurred('heavy');
  } catch { /* ignore */ }
};
