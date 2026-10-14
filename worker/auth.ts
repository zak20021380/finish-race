/**
 * auth.ts — who is asking to queue, and are they really from Telegram?
 *
 * Telegram Mini Apps hand the client a signed `initData` query string. The bot-token check is the
 * documented one, and it is done here with nothing but Web Crypto (`crypto.subtle`):
 *
 *   secret    = HMAC_SHA256(key = "WebAppData", data = <bot token>)
 *   signature = HMAC_SHA256(key = secret, data = <every field except `hash`, sorted, joined by \n>)
 *   signature must equal `hash` (hex, lowercase)
 *
 * Verified fields beat anything the client claims, so `user.id` and `user.first_name` come from
 * Telegram. `tiq`, `tier`, `flag` and `name` are client-supplied — they seed the queue and the
 * console, and are only trusted on the development fallback (below).
 *
 * Development fallback: with `DEV_AUTH = "true"`, or on a loopback host with no valid `initData`,
 * a guest identity is minted so `npm run dev` works in an ordinary browser tab with no Mini App
 * and no bot token. A *valid* signature always wins, even in development.
 */
import type { Env } from './env';

/* ---------- the four bands, mirroring `tierOf` in src/matchmaking.ts ---------- */

export type MindTier = 'rookie' | 'tactician' | 'strategist' | 'grandmaster';

export function tierOf(tiq: number): MindTier {
  if (tiq >= 3000) return 'grandmaster';
  if (tiq >= 2000) return 'strategist';
  if (tiq >= 1000) return 'tactician';
  return 'rookie';
}

const isTier = (value: string): value is MindTier =>
  value === 'rookie' || value === 'tactician' || value === 'strategist' || value === 'grandmaster';

export interface Player {
  /** `tg-<user id>` for a verified Mini App player, `guest-<random>` on the dev fallback. */
  id: string;
  name: string;
  username: string;
  /** ISO 3166-1 alpha-2 as declared in the app's profile, or `''`. */
  flag: string;
}

export interface Identity {
  player: Player;
  tiq: number;
  tier: MindTier;
  flag: string;
  /** True only when the guest door was used. */
  guest: boolean;
}

/* ---------- what the client sends with the upgrade ---------- */

export interface AuthRequest {
  /** The Mini App init data query string, exactly as Telegram handed it over. */
  initData: string;
  /** Hostname of the incoming request, so the guest fallback can be scoped to loopback. */
  hostname: string;
  /** Client-supplied starting TIQ, tier, country and display name. */
  tiq: number | null;
  tier: string;
  flag: string;
  name: string;
}

/* ---------- parsing ---------- */

const encoder = new TextEncoder();

const whole = (value: string | null): number | null => {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
};

/** Two letters, or nothing: a flag is cosmetic, never a place to smuggle a string. */
const flagOf = (raw: string): string => (/^[a-z]{2}$/i.test(raw) ? raw.toUpperCase() : '');

const cleanName = (raw: string): string => raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);

/** Everything the socket put in the query string, read once. */
export function authRequestFrom(url: URL): AuthRequest {
  const p = url.searchParams;
  return {
    initData: p.get('initData') ?? '',
    hostname: url.hostname,
    tiq: whole(p.get('tiq')),
    tier: p.get('tier') ?? '',
    flag: flagOf(p.get('flag') ?? ''),
    name: cleanName(p.get('name') ?? ''),
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** `localhost`, `127.0.0.1`, `::1`, `*.localhost` — the addresses a local browser reaches. */
export function isLocalhost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK.has(h) || h.endsWith('.localhost');
}

/* ---------- the Telegram check ---------- */

function hex(buffer: ArrayBuffer): string {
  let out = '';
  for (const byte of new Uint8Array(buffer)) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Length-independent of data, length-constant in time: never an early exit on a mismatch. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(keyBytes: BufferSource, data: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, encoder.encode(data));
}

/** The verified field map, or null when the signature does not hold. */
async function verify(initData: string, botToken: string): Promise<URLSearchParams | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]+$/i.test(hash)) return null;
  params.delete('hash');                      // everything else is signed, in key order
  params.sort();
  const rows: string[] = [];
  params.forEach((value, key) => { rows.push(`${key}=${value}`); });
  const secret = await hmac(encoder.encode('WebAppData'), botToken);
  const signature = await hmac(new Uint8Array(secret), rows.join('\n'));
  return sameHex(hex(signature), hash.toLowerCase()) ? params : null;
}

/* ---------- identity ---------- */

interface TgUser {
  id?: number | string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

function parseUser(raw: string | null): TgUser | null {
  if (!raw) return null;
  try {
    const user = JSON.parse(raw) as TgUser;
    return user && typeof user === 'object' ? user : null;
  } catch {
    return null;
  }
}

function displayName(user: TgUser | null, fallback: string): string {
  const full = cleanName(`${user?.first_name ?? ''} ${user?.last_name ?? ''}`);
  return full || cleanName(user?.username ?? '') || fallback || 'Player';
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return hex(a.buffer as ArrayBuffer);
}

/** The development door: a distinct, throwaway seat per connection. */
function guestSeat(req: AuthRequest, tier: MindTier): Identity {
  return {
    player: { id: `guest-${randomHex(4)}`, name: req.name || 'Guest', username: '', flag: req.flag },
    tiq: req.tiq ?? 0,
    tier,
    flag: req.flag,
    guest: true,
  };
}

/**
 * Resolve the seat behind a socket request. Returns null when the caller must be refused (a bad
 * signature on a real host, or no credentials and no development door open).
 */
export async function authenticate(req: AuthRequest, env: Env): Promise<Identity | null> {
  const tiq = req.tiq ?? 0;
  const tier = isTier(req.tier) ? req.tier : tierOf(tiq);
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const dev = env.DEV_AUTH === 'true' || isLocalhost(req.hostname);

  if (req.initData && token) {
    const fields = await verify(req.initData, token);
    if (fields) {
      const user = parseUser(fields.get('user'));
      const id = user?.id === undefined || user?.id === null ? null : String(user.id).replace(/[^0-9-]/g, '').slice(0, 20);
      return {
        player: {
          id: id ? `tg-${id}` : `tg-anon-${randomHex(4)}`,
          name: displayName(user, req.name),
          username: cleanName(user?.username ?? ''),
          flag: req.flag,
        },
        tiq,
        tier,
        flag: req.flag,
        guest: false,
      };
    }
    /* A signature that does not hold is a signature that does not hold — but a developer
       running a local Worker may simply be sending a stale initData, so the dev door stays open. */
    if (!dev) return null;
  } else if (!dev) {
    return null;                              // nothing to verify with, and nowhere to fall back to
  }

  return guestSeat(req, tier);
}
