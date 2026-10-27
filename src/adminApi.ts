/**
 * adminApi.ts — the wire the Command Center and the announcement engine share.
 *
 * One Worker base, one set of admin headers, one short-leash fetch, one JSON reader. Kept in its
 * own module so the broadcast engine (`src/broadcasts.ts`) can read the public announcement feed
 * without importing the whole panel — which imports it back the moment it dispatches one.
 */
import { tgInitData } from './telegram';

/**
 * The Worker origin: `VITE_WS_URL` when the app was pointed at one, else this page's own origin.
 * The documented env value is the whole socket URL (`ws://host/ws/matchmake`), so only its origin
 * is kept — every backend route is root-relative.
 *
 * During `vite dev` the backend prefixes are proxied to `wrangler dev`, so admin calls always stay
 * same-origin: a direct loopback URL would otherwise be held up by browser CORS even when the
 * Worker is running. Production keeps honouring `VITE_WS_URL` for a separately hosted Worker.
 */
export function workerBase(): string {
  if (import.meta.env.DEV && location.host) return location.origin;
  const ws = import.meta.env?.VITE_WS_URL?.trim();
  if (ws) {
    try {
      const http = ws.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
      return new URL(http.startsWith('http') ? http : `https://${http}`).origin;
    } catch {
      return '';
    }
  }
  return location.host ? location.origin : '';
}

/** A Worker route, or `''` when there is no origin to hang one off. */
export function workerUrl(path: string): string {
  const base = workerBase();
  return base ? `${base}${path}` : '';
}

/**
 * What every admin call carries: the Mini App's own `initData` when Telegram handed one over, plus
 * the explicit developer marker. The Worker ignores the marker unless it is on a dev host and a
 * valid signature always wins over it, so sending both is safe and keeps local work possible.
 */
export function adminHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', 'x-admin': '1' };
  const init = tgInitData();
  if (init) headers['x-telegram-init-data'] = init;
  return headers;
}

/**
 * One admin call on a short leash: a Worker that is not there must never hold the panel up.
 * The extra headers the caller passed win over the defaults.
 */
export async function adminFetch(path: string, init: RequestInit = {}): Promise<Response | null> {
  const url = workerUrl(path);
  if (!url) return null;
  const extra = (init.headers ?? {}) as Record<string, string>;
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), 2500);
  try {
    return await fetch(url, { ...init, signal: ac.signal, headers: { ...adminHeaders(), ...extra } });
  } catch {
    return null;                              // offline, refused, or too slow: the same answer
  } finally {
    window.clearTimeout(timer);
  }
}

/** Read a JSON body off a response: null when it is missing, failed, or not JSON at all. */
export async function parseJson<T>(res: Response | null): Promise<T | null> {
  if (!res || !res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** One POST with a JSON body, deciding only whether the Worker accepted it. */
export async function postJson(path: string, body: unknown): Promise<Response | null> {
  return adminFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
