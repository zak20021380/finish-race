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
  /** Player-declared age, or 0 when the profile has never asked. */
  age: number;
  /** True only when the guest door was used. */
  guest: boolean;
  /** Wallet reading the client reported for the directory, clamped. Never an authority. */
  coins: number;
  /** Telegram Stars volume the client reported, clamped. */
  stars: number;
  /** Friends invited, per the client's own referral hub. */
  referrals: number;
  /** Squad / channel handle the client is bound to, or ''. */
  squad: string;
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
  /** Profile age, already clamped to the same ceiling the directory filter reads. */
  age: number;
  name: string;
  /** Economy / social telemetry the client reports for the admin directory, all clamped. */
  coins: number;
  stars: number;
  refs: number;
  squad: string;
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

/** A telemetry figure, clamped to its sane ceiling — a query string can say anything. */
const capped = (value: string | null, hi: number): number => Math.min(hi, whole(value) ?? 0);

/** Everything the socket put in the query string, read once. */
export function authRequestFrom(url: URL): AuthRequest {
  const p = url.searchParams;
  return {
    initData: p.get('initData') ?? '',
    hostname: url.hostname,
    tiq: whole(p.get('tiq')),
    tier: p.get('tier') ?? '',
    flag: flagOf(p.get('flag') ?? ''),
    age: capped(p.get('age'), 120),
    name: cleanName(p.get('name') ?? ''),
    coins: capped(p.get('coins'), 100_000_000),
    stars: capped(p.get('stars'), 10_000_000),
    refs: capped(p.get('refs'), 100_000),
    squad: cleanName(p.get('squad') ?? ''),
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
    age: req.age,
    guest: true,
    coins: req.coins,
    stars: req.stars,
    referrals: req.refs,
    squad: req.squad,
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
        age: req.age,
        guest: false,
        coins: req.coins,
        stars: req.stars,
        referrals: req.refs,
        squad: req.squad,
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

/* ---------- the admin door ---------- */

/**
 * What admin verification needs from an inbound request — its URL and its headers. `Request`
 * satisfies this, and so does a plain object, which keeps the check testable without a runtime.
 */
export interface AdminRequestLike {
  url: string;
  headers: { get(name: string): string | null };
}

export interface AdminIdentity {
  /** The verified Telegram user id, or `dev` when the development door was the way in. */
  userId: string;
  door: 'tg' | 'dev';
}

/** The two levels the Command Center appoints: a Moderator reads metrics and users, a SuperAdmin commands. */
export type AdminRole = 'superadmin' | 'moderator';

/** The role-carrying slice of a registry row, as the authorization middleware reads it. */
export interface AdminRoleRow {
  role: AdminRole;
}

/**
 * The authorization middleware in front of every role-granting and broadcast mutation. The
 * development door is always enough — it only opens for an explicit marker on a loopback host —
 * while a Telegram admin has to carry a stored `superadmin` role. The registry itself lives with
 * the room (`MatchmakerDO`), which owns the state this reads.
 */
export function isSuperAdmin(identity: AdminIdentity | null, row: AdminRoleRow | null | undefined): boolean {
  if (!identity) return false;
  if (identity.door === 'dev') return true;
  return row?.role === 'superadmin';
}

/** The allowlist, read the way it is written: `ADMIN_IDS` split on commas, blanks dropped. */
export function adminIds(env: Env): string[] {
  return (env.ADMIN_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Headers that open the development door when the caller is already on a dev host. */
const DEV_ADMIN_HEADERS = ['x-detour-admin', 'x-admin'];

/** `1`, `true`, `yes`, `on` — anything but an explicit negative. */
function truthy(value: string | null): boolean {
  if (value === null) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * The signed initData a request carries, from wherever the caller put it: the
 * `X-Telegram-Init-Data` header, Telegram's `Authorization: tma <initData>`, or `?initData=`.
 */
export function initDataOf(request: AdminRequestLike): string {
  const header = request.headers.get('x-telegram-init-data')?.trim();
  if (header) return header;
  const auth = request.headers.get('authorization')?.trim() ?? '';
  const bearer = /^tma\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  try {
    return new URL(request.url).searchParams.get('initData') ?? '';
  } catch {
    return '';
  }
}

/** An explicit "this really is a developer" marker: a header, or `?admin=1`. */
function devMarker(request: AdminRequestLike): boolean {
  for (const name of DEV_ADMIN_HEADERS) if (truthy(request.headers.get(name))) return true;
  try {
    return truthy(new URL(request.url).searchParams.get('admin'));
  } catch {
    return false;
  }
}

/** The verified Telegram identity carried by an initData query string, or null. */
async function verifiedTelegramUser(initData: string, env: Env): Promise<{ id: string; name: string } | null> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!initData || !token) return null;
  const fields = await verify(initData, token);
  if (!fields) return null;
  const user = parseUser(fields.get('user'));
  if (user?.id === undefined || user?.id === null) return null;
  const id = String(user.id).replace(/[^0-9-]/g, '').slice(0, 20);
  return id ? { id, name: displayName(user, '') } : null;
}

/** The verified Telegram user id carried by an initData query string, or ''. */
export async function verifiedTelegramUserId(initData: string, env: Env): Promise<string> {
  return (await verifiedTelegramUser(initData, env))?.id ?? '';
}

/* ---------- the player door: badge minting and its progress ledger ---------- */

export interface PlayerAuth {
  /** `tg-<user id>` for a verified Mini App player, `guest-<name>` on the dev fallback. */
  playerId: string;
  tgId: string;
  guest: boolean;
  /** Public display name for the holder ledger; derived from verified initData, never a request body. */
  name: string;
}

/** The stable seat a local developer gets, optionally named to test two accounts at once. */
function devPlayer(request: AdminRequestLike): PlayerAuth {
  const raw = request.headers.get('x-detour-dev-player') ?? '';
  const id = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const seat = id || 'dev';
  return { playerId: `guest-${seat}`, tgId: '', guest: true, name: seat };
}

/**
 * Who may mint. A Telegram signature is the only identity a deployed host accepts — a forged
 * one is refused with 401 even on a development host. With no initData, the same guest door the
 * matchmaker uses opens on a loopback host (or `DEV_AUTH = "true"`); the optional
 * `x-detour-dev-player` header gives those guests distinct, stable seats for local tests.
 */
export async function identifyPlayerRequest(
  request: AdminRequestLike,
  env: Env,
): Promise<PlayerAuth | null> {
  const initData = initDataOf(request);
  if (initData) {
    const who = await verifiedTelegramUser(initData, env);
    return who ? { playerId: `tg-${who.id}`, tgId: who.id, guest: false, name: who.name } : null;
  }
  const dev = env.DEV_AUTH === 'true' || isLocalhost(hostOf(request.url));
  return dev ? devPlayer(request) : null;
}

/** The verified Telegram user id behind an admin request, or '' — the signature only, no allowlist. */
async function signedAdminId(request: AdminRequestLike, env: Env): Promise<string> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const initData = initDataOf(request);
  if (!initData || !token) return '';
  const fields = await verify(initData, token);
  if (!fields) return '';
  const user = parseUser(fields.get('user'));
  if (user?.id === undefined || user?.id === null) return '';
  return String(user.id).replace(/[^0-9-]/g, '').slice(0, 20);
}

/**
 * Authentication at the edge: a genuine Telegram signature, whoever it names — the role registry
 * lives with the room (`MatchmakerDO`), which is the only place that knows who is an admin. When
 * no signature holds, the explicitly marked development door still opens on a loopback host (or
 * `DEV_AUTH = "true"`). Anything else is refused.
 */
export async function identifyAdminRequest(request: AdminRequestLike, env: Env): Promise<AdminIdentity | null> {
  const id = await signedAdminId(request, env);
  if (id) return { userId: id, door: 'tg' };

  const dev = env.DEV_AUTH === 'true' || isLocalhost(hostOf(request.url));
  if (dev && devMarker(request)) return { userId: 'dev', door: 'dev' };
  return null;
}

/**
 * The legacy allowlist door in front of `/admin/*`. A valid Telegram signature naming an id on
 * the allowlist is always enough — that door wins over everything. Failing that, the development
 * door opens for a loopback host (or `DEV_AUTH = "true"`) that carries an explicit admin marker.
 * Anything else is refused, and the caller answers `403`.
 */
export async function verifyAdminRequest(request: AdminRequestLike, env: Env): Promise<AdminIdentity | null> {
  const id = await signedAdminId(request, env);
  if (id && adminIds(env).includes(id)) return { userId: id, door: 'tg' };

  const dev = env.DEV_AUTH === 'true' || isLocalhost(hostOf(request.url));
  if (dev && devMarker(request)) return { userId: 'dev', door: 'dev' };
  return null;
}
