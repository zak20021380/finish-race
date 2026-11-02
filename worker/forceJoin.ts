/**
 * forceJoin.ts — the mandatory-channel gate's configuration and its one Telegram call.
 *
 * The operator arms the gate from the Command Center (`POST /api/admin/force-join`) and the
 * player-facing reading (`GET /api/user/check-subscription`) answers three things at once:
 * whether the gate is armed, which channel it points at, and whether this player is inside it.
 * The config is durable — it rides `MatchmakerDO`'s own storage — so arming the gate is a single
 * serialized write rather than a deploy.
 *
 * The membership check fails open on purpose. A missing bot token, a channel the bot cannot read,
 * or an unreachable Bot API is a configuration fault, not a verdict about the player: it is logged
 * with the exact Telegram reason and reported as unavailable, so nobody is locked out of the arena
 * by an operator's mistake. Only an explicit "not a member" answer closes the gate.
 */
import type { Env } from './env';
import { CHANNEL_HANDLE, telegramChatLink } from '../shared/config';

export interface ForceJoinConfig {
  /** The master switch. Off by default: the arena stays open until an operator arms it. */
  forceJoinEnabled: boolean;
  /** `@handle` or a numeric channel id (`-100...`), exactly what `getChatMember` receives. */
  targetChannel: string;
}

export interface ForceJoinView extends ForceJoinConfig {
  /** The public join link derived from `targetChannel`, or '' when the id has no public form. */
  channelUrl: string;
}

export interface ChannelTarget {
  targetChannel: string;
  channelUrl: string;
}

export interface MembershipCheck {
  /** Telegram's answer. An unavailable check also reports `true`, so callers fail open. */
  member: boolean;
  /** The check itself could not be answered (no token, bad channel, bot not an admin). */
  unavailable: boolean;
  /** Telegram's own description, kept for the log line. */
  description: string;
}

const TELEGRAM_BASE = 'https://api.telegram.org/bot';
const TG_ID = /^[0-9]{1,20}$/;
const NUMERIC_CHANNEL = /^-100[0-9]{5,20}$/;
const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);
/** `t.me` paths that are Telegram features, not public channel handles. */
const RESERVED_HANDLES = new Set(['joinchat', 'share', 'addstickers', 'setlanguage', 'login', 'invoice', 'iv', 'contact']);

/** What the gate points at before an operator chooses: the deployment's own required channel. */
export function defaultForceJoinChannel(env: Env): string {
  const configured = (env.REQUIRED_CHANNEL ?? '').trim();
  if (configured) {
    return normalizeForceJoinChannel(configured)?.targetChannel ?? `@${CHANNEL_HANDLE}`;
  }
  return `@${CHANNEL_HANDLE}`;
}

/**
 * One spelling of a channel: `@handle`, a bare handle, a `t.me` link, or a numeric id. Anything
 * else — an invite link the Bot API cannot name, a stray sentence — is refused rather than stored.
 */
export function normalizeForceJoinChannel(raw: unknown): ChannelTarget | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;

  const numeric = value.replace(/\s+/g, '');
  if (NUMERIC_CHANNEL.test(numeric)) {
    return { targetChannel: numeric, channelUrl: `https://t.me/c/${numeric.slice(4)}` };
  }

  const link = telegramChatLink(value);
  if (!link) return null;
  const handle = link.replace(/^https:\/\/t\.me\//i, '');
  if (RESERVED_HANDLES.has(handle.toLowerCase())) return null;
  return { targetChannel: `@${handle}`, channelUrl: link };
}

/** A stored row, folded field by field. A half-written blob never arms a gate on its own. */
export function readForceJoinConfig(raw: unknown, fallbackChannel: string): ForceJoinConfig {
  const row = raw as { forceJoinEnabled?: unknown; targetChannel?: unknown } | null | undefined;
  const channel = normalizeForceJoinChannel(row?.targetChannel)?.targetChannel ?? fallbackChannel;
  return {
    forceJoinEnabled: row?.forceJoinEnabled === true && Boolean(channel),
    targetChannel: channel,
  };
}

/** The public link for a stored channel, or ''. */
export function forceJoinChannelUrl(channel: string): string {
  return normalizeForceJoinChannel(channel)?.channelUrl ?? '';
}

/** The one reading shape both the room and the edge answer with. */
export function forceJoinView(config: ForceJoinConfig): ForceJoinView {
  return { ...config, channelUrl: forceJoinChannelUrl(config.targetChannel) };
}

function botToken(env: Env): string {
  return (env.TELEGRAM_BOT_TOKEN ?? env.BOT_TOKEN ?? env.TELEGRAM_TOKEN ?? '').trim();
}

/**
 * Ask Telegram whether `userId` is inside `channel`.
 *
 * `creator`, `administrator` and `member` pass; a `restricted` user passes only when Telegram says
 * `is_member`. `left` and `kicked` are the honest "not joined" answers. Everything else — a broken
 * channel id, a bot that was never made an administrator, a transport failure — is a configuration
 * fault and fails open with a warning that names it.
 */
export async function checkChannelMembership(
  env: Env,
  userId: string,
  channel: string,
): Promise<MembershipCheck> {
  if (!TG_ID.test(userId) || !channel) {
    return { member: true, unavailable: true, description: 'no player identity or target channel' };
  }
  const token = botToken(env);
  if (!token) {
    console.warn(
      '[force-join] TELEGRAM_BOT_TOKEN is not set, so getChatMember cannot run. '
      + 'The gate fails open; set the secret with `npx wrangler secret put TELEGRAM_BOT_TOKEN`.',
    );
    return { member: true, unavailable: true, description: 'bot token missing' };
  }

  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_BASE}${token}/getChatMember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ chat_id: channel, user_id: userId }),
    });
  } catch (err) {
    const description = err instanceof Error ? err.message : String(err);
    console.warn(`[force-join] getChatMember(${channel}) transport failure: ${description}. Failing open.`);
    return { member: true, unavailable: true, description };
  }

  let data: {
    ok?: boolean;
    result?: { status?: string; is_member?: boolean };
    description?: string;
  } | null = null;
  try {
    data = await response.json();
  } catch {
    return { member: true, unavailable: true, description: 'Telegram sent a non-JSON answer' };
  }

  if (!response.ok || !data || data.ok !== true) {
    const description = typeof data?.description === 'string' ? data.description : `HTTP ${response.status}`;
    /* "user not found" is Telegram saying the id is not in the chat, not that the bot is misconfigured. */
    if (/user.*(?:not found|invalid)/i.test(description)) {
      return { member: false, unavailable: false, description };
    }
    console.warn(
      `[force-join] getChatMember(${channel}) refused: "${description}". `
      + 'The bot must be an administrator of the target channel; the gate fails open until it is.',
    );
    return { member: true, unavailable: true, description };
  }

  const status = data.result?.status ?? '';
  if (status === 'restricted') {
    return { member: data.result?.is_member === true, unavailable: false, description: status };
  }
  return { member: MEMBER_STATUSES.has(status), unavailable: false, description: status };
}

/**
 * The live config, read through the room's internal door. The public router never forwards
 * `/internal/*`, so this has no outside caller. Any failure answers the safe default: a disabled
 * gate on the deployment's required channel — never a lockout and never a guessed channel.
 */
export async function readForceJoin(env: Env): Promise<ForceJoinConfig> {
  const fallback = defaultForceJoinChannel(env);
  if (!env.MATCHMAKER) return { forceJoinEnabled: false, targetChannel: fallback };
  try {
    const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));
    const response = await lobby.fetch(new Request('https://force-join.internal/internal/force-join', {
      headers: { accept: 'application/json' },
    }));
    if (!response.ok) return { forceJoinEnabled: false, targetChannel: fallback };
    const data = await response.json() as { config?: unknown };
    return readForceJoinConfig(data?.config, fallback);
  } catch {
    return { forceJoinEnabled: false, targetChannel: fallback };
  }
}
