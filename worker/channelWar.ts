/**
 * channelWar.ts — the Channel Wars "Method 2" proof.
 *
 * Method 1 hands the bot an administrator seat and lets Telegram answer. Method 2 asks for no
 * rights at all: the founder posts a short code in the public channel and the room reads the
 * channel's own public preview at `t.me/s/<username>` to find it.
 *
 * Three facts make that door safe, and each one lives here:
 *
 *   1. The code is **derived, never stored**. `HMAC-SHA256(secret, "channel-war:v1:<user>:<day>")`
 *      cut down to six symbols of a thirty-two letter alphabet. The same player always gets the
 *      same `TIQ-XXXXXX` for the running UTC day, on every isolate, across a retry, a second tab
 *      or an eviction — so there is no row to race and nothing that can expire early. Only the
 *      player who can sign initData as that Telegram id can produce the code that matches.
 *   2. The **handle is read strictly**. `@name`, `t.me/name`, `t.me/s/name`, a trailing slash and a
 *      query string all collapse to one username; `+hash` and `joinchat/hash` are refused with
 *      their own reason, because a private invite has no public `@name` to scan.
 *   3. The **page is read fresh**. Cloudflare caches `t.me` hard, so the request carries
 *      `cacheTtl: 0` and a cache-busting query; a founder who posted a second ago must not be told
 *      their code is missing. The code is only looked for inside rendered message bubbles, never
 *      in the page's title or meta tags, so an echoed string cannot stand in for a real post.
 */

import type { Env } from './env';

const CW_CODE_PREFIX = 'TIQ-';
const CW_CODE_BODY = 6;
/**
 * The alphabet a code draws from: `A`–`Z` without `I` and `O` (the two that read as digits), then
 * `2`–`9`. Exactly thirty-two symbols — a power of two, so a byte maps onto it with no modulo bias.
 */
const CW_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** One code window is one UTC day: a code read in the morning still verifies that evening. */
export const CW_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The window an instant belongs to. Deterministic, so two isolates agree without any storage. */
export function cwWindow(at: number = Date.now()): number {
  return Math.floor(at / CW_WINDOW_MS);
}

/* ---------- the handle a founder typed ---------- */

export type CwHandleIssue = '' | 'empty' | 'private' | 'chars';

export interface CwHandleReading {
  /** `@username`, or '' when the input never named one. */
  handle: string;
  /** Why it named none: nothing typed, a private invite, or characters no username may hold. */
  issue: CwHandleIssue;
}

/**
 * Read whatever a founder typed or pasted as a public channel username.
 *
 * Everything a share sheet produces is accepted — the bare `@name`, `t.me/name`, `www.t.me/name`,
 * `https://telegram.me/name`, the `/s/` preview path, a post link with a trailing `/123`, a
 * trailing slash and a query string — and every one of them collapses to the same `@name`. A
 * private invite is not a username and is reported as such instead of being mangled into one.
 */
export function cwReadHandle(raw: unknown): CwHandleReading {
  const source = typeof raw === 'string' ? raw : '';
  /* Whitespace inside a pasted link is an artefact of the paste, never part of a username. */
  let value = source.replace(/[\u0000-\u001f\u007f\s]+/g, '').slice(0, 240);
  if (!value) return { handle: '', issue: 'empty' };

  /* `+abc123` and `joinchat/abc123` are the two shapes a private invite takes. Neither can be
     scanned publicly, so the caller is told to use Method 1 rather than chasing a dead end. */
  if (/^(?:\+)|^(?:joinchat\/)/i.test(value)) return { handle: '', issue: 'private' };
  if (/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.(?:me|dog)\/(?:\+|joinchat\/)/i.test(value)) {
    return { handle: '', issue: 'private' };
  }

  value = value.replace(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.(?:me|dog)\//i, '');
  /* The `/s/` preview path names the same channel the bare handle does. */
  value = value.replace(/^s\//i, '');
  value = value.replace(/^@+/, '');
  value = value.split(/[?#]/)[0] ?? '';
  value = value.replace(/\/+$/, '');
  /* `t.me/<name>/<post id>` is a link to one message in the channel the first segment names. */
  const first = value.split('/')[0] ?? '';
  if (!first) return { handle: '', issue: 'empty' };
  /* A username is 4–32 ASCII letters, digits or underscores, and is never all digits (that is a
     numeric chat id, not a name a person can post in). */
  if (!/^[A-Za-z0-9_]{4,32}$/.test(first) || /^[0-9]+$/.test(first)) {
    return { handle: '', issue: 'chars' };
  }
  return { handle: `@${first}`, issue: '' };
}

/* ---------- the code ---------- */

/**
 * The Worker's signing secret, best binding first.
 *
 * The bot token is already the room's identity secret — every signed Mini App payload is proved
 * with it — so it signs the code too. The webhook secret and the operator key are read afterwards
 * only so a deployment that bound one of those instead still issues codes; a deployment with none
 * of them cannot verify anybody anyway, and the door says so instead of minting a guessable code.
 */
export function cwSecret(env: Env | undefined): string {
  const source = (env ?? {}) as Record<string, unknown>;
  for (const name of [
    'TELEGRAM_BOT_TOKEN', 'BOT_TOKEN', 'TELEGRAM_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET', 'ADMIN_ACCESS_TOKEN',
  ]) {
    const value = typeof source[name] === 'string' ? (source[name] as string).trim() : '';
    if (value) return `${name}\u0000${value}`;
  }
  return '';
}

/** Six symbols of the alphabet, cut from the leading bytes of one HMAC signature. */
async function cwHmac(userId: string, window: number, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`channel-war:v1:${userId}:${window}`),
  );
  const bytes = new Uint8Array(signature);
  let body = '';
  for (let i = 0; i < CW_CODE_BODY; i++) body += CW_CODE_ALPHABET[bytes[i] % CW_CODE_ALPHABET.length];
  return `${CW_CODE_PREFIX}${body}`;
}

/** The one code a player may post in the running window, or '' when nothing can sign it. */
export async function cwCodeFor(
  userId: string,
  secret: string,
  at: number = Date.now(),
): Promise<string> {
  if (!userId || !secret) return '';
  return cwHmac(userId, cwWindow(at), secret);
}

/**
 * Every code that may still be accepted: the running window's and the one before it.
 *
 * A founder who reads their code at 23:59 and posts it at 00:01 has not done anything wrong, and
 * a day boundary is not an expiry — the previous window stays valid so the door never refuses a
 * code the panel itself just painted.
 */
export async function cwCodeCandidates(
  userId: string,
  secret: string,
  at: number = Date.now(),
): Promise<string[]> {
  if (!userId || !secret) return [];
  const window = cwWindow(at);
  const current = await cwHmac(userId, window, secret);
  const previous = await cwHmac(userId, window - 1, secret);
  return previous === current ? [current] : [current, previous];
}

/* ---------- the public page ---------- */

const CW_PAGE_TIMEOUT_MS = 8_000;
const CW_PAGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** What a public channel's preview page actually says about itself. */
export interface CwChannelPage {
  handle: string;
  /** Telegram's own title, decoded. */
  title: string;
  /** The channel photo Telegram serves, or '' when the page carries none. */
  avatar: string;
  /** The subscriber count the page prints, or `null` when it prints none. */
  members: number | null;
  /** The raw HTML, kept so the caller scans the very page the metadata came from. */
  html: string;
}

export type CwPageResult =
  | { ok: true; page: CwChannelPage }
  | { ok: false; reason: 'not_public' | 'unreachable' };

/** Decode the handful of entities Telegram's own markup emits. */
function decodeEntities(value: string): string {
  return value
    .replace(/&(?:amp|#0?38);/gi, '&')
    .replace(/&(?:lt|#0?60);/gi, '<')
    .replace(/&(?:gt|#0?62);/gi, '>')
    .replace(/&(?:quot|#0?34);/gi, '"')
    .replace(/&(?:apos|#0?39|#x27);/gi, "'")
    .replace(/&(?:nbsp|#0?160);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One `<meta property="…">` value, in either attribute order. */
function metaContent(html: string, property: string): string {
  const after = new RegExp(
    `<meta[^>]+property=["']${property}["'][^>]*content=["']([^"']*)["']`,
    'i',
  ).exec(html);
  if (after) return decodeEntities(after[1]);
  const before = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${property}["']`,
    'i',
  ).exec(html);
  return before ? decodeEntities(before[1]) : '';
}

/** `1.2K` / `12 345` / `1,234` — the counter as the page prints it, read as a number. */
function counterValue(raw: string): number | null {
  const clean = raw.replace(/[\s,]/g, '');
  const match = /^([0-9]+(?:\.[0-9]+)?)([KMB]?)$/i.exec(clean);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const scale = /^k$/i.test(match[2]) ? 1_000
    : /^m$/i.test(match[2]) ? 1_000_000
      : /^b$/i.test(match[2]) ? 1_000_000_000 : 1;
  return Math.max(0, Math.round(base * scale));
}

/** The channel's subscriber count, from the first counter that names subscribers. */
function subscriberCount(html: string): number | null {
  const counter = /<span class="counter_value">([^<]*)<\/span>[\s\S]{0,80}?<span class="counter_type">([^<]*)<\/span>/gi;
  let hit: RegExpExecArray | null;
  while ((hit = counter.exec(html)) !== null) {
    if (!/subscriber/i.test(hit[2])) continue;
    const value = counterValue(decodeEntities(hit[1]));
    if (value !== null) return value;
  }
  return null;
}

/** The channel's title, from the preview header when the meta tag is missing. */
function headerTitle(html: string): string {
  const header = /<div class="tgme_channel_info_header_title"[^>]*>([\s\S]{0,400}?)<\/div>/i.exec(html);
  if (!header) return '';
  return decodeEntities(header[1].replace(/<[^>]*>/g, ' '));
}

/**
 * Read a public channel's preview page.
 *
 * The response is checked for the two markers a real channel page always carries — the channel
 * info block and the page title — because `t.me/s/<name>` answers a *valid HTML page* for a name
 * that does not exist. Without that check a founder would be told "code not found" about a
 * channel that was never public in the first place.
 */
export async function cwFetchPage(handle: string): Promise<CwPageResult> {
  const name = handle.replace(/^@+/, '');
  if (!name) return { ok: false, reason: 'not_public' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CW_PAGE_TIMEOUT_MS);
  let html = '';
  let status = 0;
  try {
    const response = await fetch(
      `https://t.me/s/${encodeURIComponent(name)}?_=${Date.now()}`,
      {
        method: 'GET',
        headers: {
          'user-agent': CW_PAGE_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
        },
        /* Cloudflare caches `t.me` hard at the edge. A founder who posted one second ago must see
           their post, so this request opts out of every cache on the way in and on the way out. */
        cf: { cacheTtl: 0, cacheEverything: false },
        signal: controller.signal,
      } as unknown as RequestInit,
    );
    status = response.status;
    if (!response.ok) return { ok: false, reason: status === 404 ? 'not_public' : 'unreachable' };
    html = await response.text();
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }

  /* A missing or private channel answers a stub page: no channel info block, and no wall of
     messages behind a page title. Either marker alone is enough on a real channel preview, and
     neither is present on the "contact @name" stub Telegram serves for a name that does not
     exist — so a founder is told the channel is not public instead of being sent to hunt for a
     code in a page that has no posts at all. */
  const channelInfo = /tgme_channel_info/i.test(html);
  const messageWall = /tgme_page_title/i.test(html) && /tgme_widget_message/i.test(html);
  if (!channelInfo && !messageWall) return { ok: false, reason: 'not_public' };

  const title = metaContent(html, 'og:title') || headerTitle(html);
  const avatar = metaContent(html, 'og:image');
  return {
    ok: true,
    page: {
      handle: `@${name}`,
      title: title.slice(0, 80),
      avatar: /^https:\/\/[^\s"']+$/i.test(avatar) ? avatar.slice(0, 200) : '',
      members: subscriberCount(html),
      html,
    },
  };
}

/**
 * Does this page carry the code in a real message?
 *
 * Every rendered bubble carries `tgme_widget_message_text`; only those blocks are scanned, so a
 * code echoed in the page title, a meta description or a share card can never stand in for a post
 * the founder actually published. The match is case-insensitive and whitespace-tolerant, because
 * the founder may type it by hand into the Telegram composer.
 */
export function cwPageHasCode(html: string, code: string): boolean {
  const wanted = code.trim().toUpperCase();
  if (!wanted) return false;
  const plain = (chunk: string): string => chunk
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|#0?39|#x27|nbsp);/gi, ' ')
    .replace(/\s+/g, ' ')
    .toUpperCase();
  const marker = /tgme_widget_message_text[^>]*>/gi;
  let hit: RegExpExecArray | null;
  while ((hit = marker.exec(html)) !== null) {
    if (plain(html.slice(hit.index, hit.index + 6_000)).includes(wanted)) return true;
  }
  return false;
}
