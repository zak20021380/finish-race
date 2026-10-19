import type { Env } from './env';

export type SquadKind = 'channel' | 'group';

export interface RegisteredSquad {
  id: string;
  chatId: string;
  handle: string;
  name: string;
  members: number;
  kind: SquadKind;
  avatar: string;
  ownerId: string;
  createdAt: number;
}

export type SquadRegistration =
  | { ok: true; squad: RegisteredSquad }
  | { ok: false; status: number; code: string; message: string };

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
const HANDLE = /^@[A-Za-z0-9_]{4,32}$/;
const MEMBER_TEXT = 32;
const AVATAR_TEXT = 160;
let cachedBotId = '';

class TelegramError extends Error {
  constructor(readonly description: string, readonly errorCode: number) {
    super(description);
  }
}

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';

const memberStatus = (value: unknown): string => {
  const result = (value ?? {}) as TelegramMember;
  return typeof result.status === 'string' ? result.status : '';
};

export function normalizeChatHandle(raw: string): string {
  let value = text(raw, 200);
  if (!value) return '';
  value = value.split(/[?#]/)[0].replace(/\/+$/, '');
  const link = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([A-Za-z0-9_]{4,32})$/i.exec(value);
  if (link) value = link[1];
  value = value.replace(/^@+/, '');
  if (!HANDLE.test(`@${value}`)) return '';
  return `@${value}`;
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
    ownerId: text(row.ownerId, 24),
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? Math.floor(createdAt) : Date.now(),
  };
}

async function telegram<T>(
  token: string,
  method: string,
  params: Record<string, string | number>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_BASE}${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(params),
    });
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

export async function verifyAndBuildSquad(
  rawHandle: string,
  userId: string,
  env: Env,
): Promise<SquadRegistration> {
  const handle = normalizeChatHandle(rawHandle);
  if (!handle) {
    return { ok: false, status: 400, code: 'invalid_handle', message: 'Enter a channel handle or link like @your_channel.' };
  }
  const requester = text(userId, 24).replace(/[^0-9-]/g, '');
  if (!requester) {
    return { ok: false, status: 401, code: 'unauthorized', message: 'Telegram verification required.' };
  }
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) {
    return { ok: false, status: 503, code: 'unavailable', message: 'Squad registration is unavailable.' };
  }

  let chat: TelegramChat;
  try {
    chat = await telegram<TelegramChat>(token, 'getChat', { chat_id: handle });
  } catch (error) {
    if (error instanceof TelegramError && /chat not found|username not found|invalid/i.test(error.description)) {
      return { ok: false, status: 404, code: 'chat_not_found', message: 'Channel or group not found.' };
    }
    return { ok: false, status: 502, code: 'telegram_error', message: 'Telegram could not verify this chat.' };
  }

  const type = text(chat.type, 20);
  if (type !== 'channel' && type !== 'group' && type !== 'supergroup') {
    return { ok: false, status: 400, code: 'unsupported_chat', message: 'Only Telegram channels and groups can be registered.' };
  }

  const title = text(chat.title, MEMBER_TEXT) || handle;
  const chatId = chat.id === undefined || chat.id === null ? handle : String(chat.id).replace(/[^0-9-]/g, '').slice(0, 32);
  const canonical = normalizeChatHandle(chat.username ?? '') || handle;

  let requesterStatus: string;
  try {
    requesterStatus = await statusOf(token, chatId, requester);
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
    botStatus = await statusOf(token, chatId, botId);
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
    squad: {
      id: `sq-tg-${chatId.replace(/[^0-9]/g, '') || canonical.slice(1).toLowerCase()}`.slice(0, 48),
      chatId,
      handle: canonical,
      name: title,
      members,
      kind: type === 'channel' ? 'channel' : 'group',
      avatar: text(chat.photo?.small_file_id ?? chat.photo?.big_file_id, AVATAR_TEXT),
      ownerId: requester,
      createdAt: Date.now(),
    },
  };
}
