import type { Env } from './env';

export type SquadKind = 'channel' | 'group';

/** The audit state the Command Center shows: confirmed admin, awaiting review, or pulled. */
export type SquadVerification = 'verified' | 'pending' | 'revoked';

export interface RegisteredSquad {
  id: string;
  chatId: string;
  handle: string;
  name: string;
  members: number;
  kind: SquadKind;
  avatar: string;
  /** 2–3 character call sign stamped on the squad crest. */
  tag: string;
  ownerId: string;
  createdAt: number;
  /** `verified` — the bot proved the submitter is an admin; `pending` — awaits an audit. */
  verification: SquadVerification;
  verifiedAt: number;
  verifiedBy: string;
  revokedAt: number;
  /** Pulled from the Channel War by an admin. The row stays for the audit trail. */
  banned: boolean;
  bannedAt: number;
}

export type SquadRegistration =
  | { ok: true; squad: RegisteredSquad }
  | { ok: false; status: number; code: string; message: string; kind?: SquadKind };

interface TelegramChat {
  id?: number | string;
  type?: string;
  title?: string;
  username?: string;
  photo?: { small_file_id?: string; big_file_id?: string };
  members_count?: number;
}

interface TelegramMember {
  status?: string;
  user?: { id?: number | string };
}

interface TelegramEnvelope<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

const TELEGRAM_BASE = 'https://api.telegram.org/bot';
/** A canonical handle: `@` + 4–32 ASCII letters, digits or underscores, any case. */
const HANDLE = /^@[a-z0-9_]{4,32}$/i;
const MEMBER_TEXT = 32;
const AVATAR_TEXT = 160;
/** The refusal every enlistment door gives for a chat that is already on the board. */
export const SQUAD_ALREADY_ENLISTED = 'This squad is already enlisted in the competition!';
const KIND_MISMATCH_GROUP = 'Handle belongs to a group, not a channel. Switch to the GROUP tab.';
const KIND_MISMATCH_CHANNEL = 'Handle belongs to a channel, not a group. Switch to the CHANNEL tab.';
const CHAT_NOT_FOUND = 'Channel or group not found on Telegram.';
let cachedBotId = '';

class TelegramError extends Error {
  constructor(readonly description: string, readonly errorCode: number) {
    super(description);
  }
}

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';

const stampOf = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * A stored audit state is one of the three known values. A row persisted before the audit fields
 * existed was Telegram-verified at registration, so it keeps the verified badge; an unrecognised
 * value is treated as an un-reviewed claim rather than silently trusted.
 */
const verificationOf = (value: unknown): SquadVerification => {
  if (value === 'verified' || value === 'pending' || value === 'revoked') return value;
  return value === undefined ? 'verified' : 'pending';
};

const memberStatus = (value: unknown): string => {
  const result = (value ?? {}) as TelegramMember;
  return typeof result.status === 'string' ? result.status : '';
};

export function normalizeChatHandle(raw: string): string {
  let value = text(raw, 200);
  if (!value) return '';
  /* A link's query/fragment is not part of the username, but a bare handle with one is
     malformed — only the link shape is allowed to carry a suffix. */
  const link = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([A-Za-z0-9_]{4,32})\/?(?:[?#].*)?$/i.exec(value);
  if (link) value = link[1];
  value = value.replace(/^@+/, '').trim();
  if (!HANDLE.test(`@${value}`)) return '';
  return `@${value}`;
}

export function normalizeSquadTag(raw: unknown): string {
  const tag = text(raw, 8).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  return /^[A-Z0-9]{2,3}$/.test(tag) ? tag : '';
}

export function readRegisteredSquad(raw: unknown): RegisteredSquad | null {
  const row = raw as Partial<RegisteredSquad> | null | undefined;
  if (!row) return null;
  const id = text(row.id, 48);
  const handle = normalizeChatHandle(text(row.handle, 64));
  const name = text(row.name, MEMBER_TEXT);
  if (!id || !handle || !name) return null;
  const members = Number(row.members);
  const createdAt = Number(row.createdAt);
  return {
    id,
    chatId: text(row.chatId, 32),
    handle,
    name,
    members: Number.isFinite(members) && members >= 0 ? Math.floor(members) : 0,
    kind: row.kind === 'channel' ? 'channel' : 'group',
    avatar: text(row.avatar, AVATAR_TEXT),
    tag: normalizeSquadTag(row.tag),
    ownerId: text(row.ownerId, 24),
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? Math.floor(createdAt) : Date.now(),
    verification: verificationOf(row.verification),
    verifiedAt: stampOf(row.verifiedAt),
    verifiedBy: text(row.verifiedBy, 40),
    revokedAt: stampOf(row.revokedAt),
    banned: row.banned === true,
    bannedAt: stampOf(row.bannedAt),
  };
}

/**
 * One Bot API call. Reads ride GET with the chat id in the query string — the shape the
 * docs publish for `getChat` (`/bot<token>/getChat?chat_id=@handle`) — while writes and
 * membership probes stay POST/JSON. Both answer the same `{ ok, result }` envelope.
 */
async function telegram<T>(
  token: string,
  method: string,
  params: Record<string, string | number>,
  verb: 'GET' | 'POST' = 'POST',
): Promise<T> {
  const endpoint = `${TELEGRAM_BASE}${token}/${method}`;
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)] as [string, string]),
  ).toString();
  const init: RequestInit = verb === 'GET'
    ? { method: 'GET', headers: { accept: 'application/json' } }
    : {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(params),
    };
  let response: Response;
  try {
    response = await fetch(verb === 'GET' ? `${endpoint}?${query}` : endpoint, init);
  } catch {
    throw new TelegramError('telegram unavailable', 0);
  }
  let data: TelegramEnvelope<T> | null = null;
  try {
    data = (await response.json()) as TelegramEnvelope<T>;
  } catch {
    data = null;
  }
  if (!response.ok || !data || data.ok !== true || data.result === undefined) {
    throw new TelegramError(
      text(data?.description, 160) || `telegram ${method} failed`,
      typeof data?.error_code === 'number' ? data.error_code : response.status,
    );
  }
  return data.result;
}

async function botUserId(token: string, env: Env): Promise<string> {
  const configured = (env.TELEGRAM_BOT_ID ?? '').replace(/[^0-9]/g, '').slice(0, 20);
  if (configured) return configured;
  if (cachedBotId) return cachedBotId;
  const me = await telegram<{ id?: number | string }>(token, 'getMe', {});
  const id = String(me?.id ?? '').replace(/[^0-9]/g, '').slice(0, 20);
  if (id) cachedBotId = id;
  return id;
}

function memberFailure(error: unknown): boolean {
  if (!(error instanceof TelegramError)) return false;
  return /user.*(?:not found|invalid)|user_id_invalid|participant/i.test(error.description);
}

async function statusOf(token: string, chatId: string, userId: string): Promise<string> {
  try {
    return memberStatus(await telegram<TelegramMember>(token, 'getChatMember', {
      chat_id: chatId,
      user_id: userId,
    }));
  } catch (error) {
    if (memberFailure(error)) return '';
    throw error;
  }
}

export interface SquadChatPreview {
  chatId: string;
  handle: string;
  name: string;
  kind: SquadKind;
  avatar: string;
  members: number;
}

export type SquadChatCheck =
  | { ok: true; chat: SquadChatPreview }
  | { ok: false; status: number; code: string; message: string; kind?: SquadKind };

interface ResolvedChat {
  chatId: string;
  handle: string;
  title: string;
  kind: SquadKind;
  avatar: string;
  members: number;
}

type ChatFailure = { ok: false; status: number; code: string; message: string; kind?: SquadKind };

/**
 * `getChat` is the one source of truth for a community's existence, type, title, photo and
 * audience. It only ever answers for the username that was asked for, and a chat without a
 * public username is refused as private — a handle that resolves must be public by definition.
 */
async function resolveChat(rawHandle: string, token: string): Promise<{ ok: true; chat: ResolvedChat } | ChatFailure> {
  const handle = normalizeChatHandle(rawHandle);
  if (!handle) {
    return { ok: false, status: 400, code: 'invalid_handle', message: 'Enter a channel handle or link like @your_channel.' };
  }

  let chat: TelegramChat;
  try {
    /* The single source of truth: does this username exist, what type is it, what is it
       called, and does it have a photo. Nothing about a squad is trusted before this. */
    chat = await telegram<TelegramChat>(token, 'getChat', { chat_id: handle }, 'GET');
  } catch (error) {
    if (error instanceof TelegramError) {
      if (error.errorCode === 403 || /private|not enough rights|not a member|kicked/i.test(error.description)) {
        return { ok: false, status: 403, code: 'chat_private', message: 'This community is private. Only public channels and groups can enlist.' };
      }
      /* Telegram answers an unknown username with 400 `chat not found`; a missing chat id
         answers 404. Both mean the same thing to the player. */
      if (error.errorCode === 400 || error.errorCode === 404 || /chat not found|username not found|chat_id_invalid|invalid/i.test(error.description)) {
        return { ok: false, status: 404, code: 'chat_not_found', message: CHAT_NOT_FOUND };
      }
    }
    return { ok: false, status: 502, code: 'telegram_error', message: 'Telegram could not verify this chat.' };
  }

  const type = text(chat.type, 20);
  if (type !== 'channel' && type !== 'group' && type !== 'supergroup') {
    return { ok: false, status: 400, code: 'unsupported_chat', message: 'Only Telegram channels and groups can be registered.' };
  }

  const canonical = normalizeChatHandle(chat.username ?? '');
  if (!canonical) {
    return { ok: false, status: 403, code: 'chat_private', message: 'This community is private. Only public channels and groups can enlist.' };
  }
  /* A username resolves to exactly one chat; never accept an answer for a different handle. */
  if (canonical.toLowerCase() !== handle.toLowerCase()) {
    return { ok: false, status: 404, code: 'chat_not_found', message: CHAT_NOT_FOUND };
  }

  const chatId = chat.id === undefined || chat.id === null ? handle : String(chat.id).replace(/[^0-9-]/g, '').slice(0, 32);
  let members = 0;
  try {
    const count = await telegram<number>(token, 'getChatMemberCount', { chat_id: chatId });
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) members = Math.floor(count);
  } catch {
    const fallback = Number(chat.members_count);
    if (Number.isFinite(fallback) && fallback >= 0) members = Math.floor(fallback);
  }

  return {
    ok: true,
    chat: {
      chatId,
      handle: canonical,
      title: text(chat.title, MEMBER_TEXT) || canonical,
      kind: type === 'channel' ? 'channel' : 'group',
      avatar: text(chat.photo?.small_file_id ?? chat.photo?.big_file_id, AVATAR_TEXT),
      members,
    },
  };
}

const kindMismatch = (actual: SquadKind): ChatFailure => ({
  ok: false,
  status: 409,
  code: 'kind_mismatch',
  kind: actual,
  message: actual === 'group' ? KIND_MISMATCH_GROUP : KIND_MISMATCH_CHANNEL,
});

/** The preview door: getChat, the chosen tab's type check, and nothing written to the registry. */
export async function verifySquadChat(
  rawHandle: string,
  requestedKind: SquadKind,
  env: Env,
): Promise<SquadChatCheck> {
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) {
    return { ok: false, status: 503, code: 'unavailable', message: 'Squad registration is unavailable.' };
  }
  const resolved = await resolveChat(rawHandle, token);
  if (!resolved.ok) return resolved;
  if (resolved.chat.kind !== requestedKind) return kindMismatch(resolved.chat.kind);
  return {
    ok: true,
    chat: {
      chatId: resolved.chat.chatId,
      handle: resolved.chat.handle,
      name: resolved.chat.title,
      kind: resolved.chat.kind,
      avatar: resolved.chat.avatar,
      members: resolved.chat.members,
    },
  };
}

export async function verifyAndBuildSquad(
  rawHandle: string,
  userId: string,
  env: Env,
  identity?: { name?: string; tag?: string; kind?: SquadKind },
): Promise<SquadRegistration> {
  const handle = normalizeChatHandle(rawHandle);
  if (!handle) {
    return { ok: false, status: 400, code: 'invalid_handle', message: 'Enter a channel handle or link like @your_channel.' };
  }
  const wantedTag = typeof identity?.tag === 'string' ? identity.tag : '';
  const tag = normalizeSquadTag(wantedTag);
  if (wantedTag.trim() && !tag) {
    return { ok: false, status: 400, code: 'invalid_tag', message: 'Tag must be 2–3 letters or numbers.' };
  }
  const requester = text(userId, 24).replace(/[^0-9-]/g, '');
  if (!requester) {
    return { ok: false, status: 401, code: 'unauthorized', message: 'Telegram verification required.' };
  }
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) {
    return { ok: false, status: 503, code: 'unavailable', message: 'Squad registration is unavailable.' };
  }

  const resolved = await resolveChat(handle, token);
  if (!resolved.ok) return resolved;
  const chat = resolved.chat;

  const expectedKind = identity?.kind === 'channel' ? 'channel' : identity?.kind === 'group' ? 'group' : '';
  if (expectedKind && chat.kind !== expectedKind) return kindMismatch(chat.kind);

  let requesterStatus: string;
  try {
    requesterStatus = await statusOf(token, chat.chatId, requester);
  } catch {
    return { ok: false, status: 502, code: 'telegram_error', message: 'Telegram could not verify this chat.' };
  }
  if (requesterStatus !== 'creator' && requesterStatus !== 'administrator') {
    return {
      ok: false,
      status: 403,
      code: 'not_admin',
      message: 'Access Denied: You must be an administrator of this channel/group.',
    };
  }

  let botId = '';
  try {
    botId = await botUserId(token, env);
  } catch {
    return { ok: false, status: 502, code: 'telegram_error', message: 'Telegram could not verify this chat.' };
  }
  if (!botId) {
    return {
      ok: false,
      status: 400,
      code: 'bot_not_admin',
      message: 'Bot is not added as an administrator to this chat.',
    };
  }
  let botStatus: string;
  try {
    botStatus = await statusOf(token, chat.chatId, botId);
  } catch {
    return { ok: false, status: 502, code: 'telegram_error', message: 'Telegram could not verify this chat.' };
  }
  if (botStatus !== 'creator' && botStatus !== 'administrator') {
    return {
      ok: false,
      status: 400,
      code: 'bot_not_admin',
      message: 'Bot is not added as an administrator to this chat.',
    };
  }

  return {
    ok: true,
    squad: {
      id: `sq-tg-${chat.chatId.replace(/[^0-9]/g, '') || chat.handle.slice(1).toLowerCase()}`.slice(0, 48),
      chatId: chat.chatId,
      handle: chat.handle,
      name: text(identity?.name, MEMBER_TEXT) || chat.title,
      members: chat.members,
      kind: chat.kind,
      avatar: chat.avatar,
      tag,
      ownerId: requester,
      createdAt: Date.now(),
      /* The bot just proved both sides against Telegram, so a fresh registration starts verified. */
      verification: 'verified',
      verifiedAt: Date.now(),
      verifiedBy: 'telegram',
      revokedAt: 0,
      banned: false,
      bannedAt: 0,
    },
  };
}
