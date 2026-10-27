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
 * How long a Command Center call may take before the panel is allowed to say the Worker did not
 * answer. Measured cold round trips on the deployed Worker — isolate start plus the Durable
 * Object's `blockConcurrencyWhile` registry read — reach seven seconds, so the two-and-a-half
 * second leash this panel used to run was aborting requests the backend was still serving, and
 * every one of those aborts painted as OFFLINE.
 */
export const ADMIN_TIMEOUT_MS = 15_000;

/** Why an admin call produced no response at all. These three are not the same outage. */
export type AdminFailure = 'no-origin' | 'timeout' | 'offline';

/** An admin call that reports *why* it failed, for the routes that paint a connection state. */
export async function adminCall(
  path: string,
  init: RequestInit = {},
  timeoutMs = ADMIN_TIMEOUT_MS,
): Promise<{ res: Response } | { failure: AdminFailure }> {
  const url = workerUrl(path);
  if (!url) return { failure: 'no-origin' };
  const extra = (init.headers ?? {}) as Record<string, string>;
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), timeoutMs);
  try {
    return { res: await fetch(url, { ...init, signal: ac.signal, headers: { ...adminHeaders(), ...extra } }) };
  } catch {
    /* an abort is a slow Worker; anything else is a request that never left the device */
    return { failure: ac.signal.aborted ? 'timeout' : 'offline' };
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * One admin call on a leash long enough for a cold Worker. The extra headers the caller passed win
 * over the defaults; a null answer means there was no response to read, and says nothing about
 * *why* — callers that report a connection state use `adminCall` instead.
 */
export async function adminFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs = ADMIN_TIMEOUT_MS,
): Promise<Response | null> {
  const out = await adminCall(path, init, timeoutMs);
  return 'res' in out ? out.res : null;
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

/**
 * What a non-2xx answer actually said, in as many words as the Worker is willing to give: its own
 * `error` and `hint` when it has them, the bare status when it answered with HTML or nothing.
 */
export async function reasonOfResponse(res: Response): Promise<string> {
  const head = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string; hint?: string; code?: string };
    const detail = [body?.error, body?.hint].filter((part) => typeof part === 'string' && part).join(' · ');
    return detail ? `${head} ${detail}` : head;
  } catch {
    return head;
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
