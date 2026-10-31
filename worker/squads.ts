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
/** What a 403 from `getChat` earns: only a chat with a public username can be enlisted. */
const CHAT_NOT_PUBLIC = 'Channel must be public. Only public channels and groups can enlist.';
/** The one answer a Worker without a token can give, and the fix it names. */
const TOKEN_MISSING_MESSAGE =
  'Telegram bot token is not configured on this Worker. Set TELEGRAM_BOT_TOKEN '
  + '(`npx wrangler secret put TELEGRAM_BOT_TOKEN`) and redeploy.';
/**
 * Every Bot API call is bounded. A hung connection used to hold the enlist modal until the
 * *browser* gave up, which read as "verification is unavailable" with nothing in the Worker log;
 * eight seconds leaves room for Telegram's slowest `getChat` and still answers in time.
 */
const TELEGRAM_TIMEOUT_MS = 8_000;
/**
 * Where the bot token may arrive, best first. `TELEGRAM_BOT_TOKEN` is the documented secret —
 * `wrangler.toml`, `.dev.vars`, the README and every harness use it — while the two shorter
 * spellings are read as fallbacks so a deployment that bound one of them does not silently lose
 * squad verification (see `botToken`).
 */
const TOKEN_BINDINGS = ['TELEGRAM_BOT_TOKEN', 'BOT_TOKEN', 'TELEGRAM_TOKEN'] as const;
let cachedBotId = '';
/** One diagnostic line per isolate: a missing token should be loud, not repeated on every call. */
let tokenDiagnosed = false;

/** How a Bot API call failed — the difference between "no chat" and "we never reached Telegram". */
type TelegramFailure = 'api' | 'unreachable' | 'timeout' | 'bad_response';

class TelegramError extends Error {
  constructor(
    readonly description: string,
    readonly errorCode: number,
    /** The HTTP status Telegram (or the edge) answered with; `0` when there was no response. */
    readonly httpStatus = 0,
    readonly kind: TelegramFailure = 'api',
  ) {
    super(description);
  }
}

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';

/** A token, safe to print: enough to identify which bot answered, never enough to use it. */
function maskToken(token: string): string {
  if (!token) return '(empty)';
  if (token.length <= 8) return `${token.slice(0, 2)}***`;
  return `${token.slice(0, 4)}***${token.slice(-4)} (len ${token.length})`;
}

/** An outgoing Bot API URL with the token replaced by its masked form. */
function maskedUrl(url: string): string {
  return url.replace(/(\/bot)([^/]+)(\/)/, (_all, head: string, token: string, tail: string) =>
    `${head}${token.slice(0, 4)}***${tail}`);
}

/**
 * The bot token, from whichever binding the deployment actually set.
 *
 * The documented name is `TELEGRAM_BOT_TOKEN` (a secret); `BOT_TOKEN` and `TELEGRAM_TOKEN` are
 * accepted afterwards because a Worker that bound one of those is working code with a wrong
 * constant, not a missing secret. Whichever binding answered is logged once per isolate, and an
 * absent token is a loud `console.warn` naming the fix — never a silent `unavailable` that the
 * player can only read as "Telegram is down".
 */
function botToken(env: Env | undefined): { token: string; binding: string } {
  const source = (env ?? {}) as Record<string, unknown>;
  for (const binding of TOKEN_BINDINGS) {
    const value = typeof source[binding] === 'string' ? (source[binding] as string).trim() : '';
    if (!value) continue;
    if (!tokenDiagnosed) {
      tokenDiagnosed = true;
      if (binding !== 'TELEGRAM_BOT_TOKEN') {
        console.warn(
          `[squad-verify] bot token found on "${binding}"; rename the binding to `
          + '"TELEGRAM_BOT_TOKEN" (the documented secret) so every route reads the same value.',
        );
      }
      console.log(`[squad-verify] bot token bound via "${binding}" (${maskToken(value)})`);
    }
    return { token: value, binding };
  }
  if (!tokenDiagnosed) {
    tokenDiagnosed = true;
    console.warn(
      `[squad-verify] no bot token in the Worker environment: none of `
      + `${TOKEN_BINDINGS.map((name) => `"${name}"`).join(', ')} is set. `
      + 'Squad verification cannot call getChat until one is — '
      + '`npx wrangler secret put TELEGRAM_BOT_TOKEN`, then redeploy (a secret is not a [vars] entry).',
    );
  }
  return { token: '', binding: '' };
}

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
 *
 * Every call is bounded and every failure is classified, because the three ways this can go
 * wrong are not the same thing to the player: Telegram said no (`api`), Telegram never answered
 * (`unreachable`/`timeout`), or the answer was not JSON (`bad_response`). The URL is logged with
 * the token masked, and Telegram's own `description`/`error_code` is logged verbatim so an
 * operator can read the real reason in `wrangler tail` instead of guessing.
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
  const url = verb === 'GET' ? `${endpoint}?${query}` : endpoint;
  const init: RequestInit = verb === 'GET'
    ? { method: 'GET', headers: { accept: 'application/json' } }
    : {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(params),
    };

  if (!token) {
    /* Reached only if a caller skipped the token gate: say so here rather than sending `/bot/`. */
    throw new TelegramError('no bot token configured', 0, 0, 'unreachable');
  }
  console.log(`[squad-verify] telegram ${method} → ${maskedUrl(url)}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const aborted = controller.signal.aborted;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[squad-verify] telegram ${method} ${aborted ? 'timed out' : 'connection failed'} `
      + `after ${TELEGRAM_TIMEOUT_MS}ms budget: ${reason}`,
    );
    throw new TelegramError(
      aborted ? `telegram ${method} timed out` : `telegram ${method} unreachable`,
      0,
      0,
      aborted ? 'timeout' : 'unreachable',
    );
  } finally {
    clearTimeout(timer);
  }

  /* The raw text first: a proxy or an HTML error page is not JSON, and `response.json()` would
     hide that behind a bare SyntaxError. */
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    raw = '';
  }
  let data: TelegramEnvelope<T> | null = null;
  try {
    data = raw ? (JSON.parse(raw) as TelegramEnvelope<T>) : null;
  } catch {
    data = null;
  }

  const description = text(data?.description, 240);
  console.log(
    `[squad-verify] telegram ${method} ← HTTP ${response.status}`
    + `${data?.error_code === undefined ? '' : ` (error_code ${data.error_code})`}`
    + `${description ? ` — ${description}` : ''}`,
  );

  if (!response.ok || !data || data.ok !== true || data.result === undefined) {
    /* A body that does not parse is not "Telegram is down" — we reached something, it just was
       not the Bot API (a proxy, a WAF page, a truncated response). `unreachable`/`timeout` are
       reserved for a transport that never answered at all, which is classified at the fetch. */
    const kind: TelegramFailure = data ? 'api' : 'bad_response';
    if (data) {
      console.warn(
        `[squad-verify] telegram ${method} refused: HTTP ${response.status}, `
        + `error_code ${data.error_code ?? '(none)'}, description ${JSON.stringify(description || '(none)')}`,
      );
    } else {
      console.warn(
        `[squad-verify] telegram ${method} returned a non-JSON body (HTTP ${response.status}): `
        + JSON.stringify(raw.slice(0, 240) || '(empty)'),
      );
    }
    throw new TelegramError(
      description || `telegram ${method} failed`,
      typeof data?.error_code === 'number' ? data.error_code : response.status,
      response.status,
      kind,
    );
  }
  return data.result;
}

/**
 * What a failed `getChat` should tell the player. The classification is by Telegram's own
 * answer, then by its HTTP status, then by transport: 400/404 is "no such chat", 403 is
 * "that chat is not public", and a transport failure says so instead of blaming the handle.
 */
function chatFailure(error: TelegramError): ChatFailure {
  const description = error.description;
  if (error.kind === 'timeout') {
    return {
      ok: false,
      status: 504,
      code: 'telegram_timeout',
      message: 'Telegram did not answer in time. Check the Worker network and try again.',
    };
  }
  if (error.kind === 'unreachable') {
    return {
      ok: false,
      status: 502,
      code: 'telegram_unreachable',
      message: `Could not reach Telegram (${description || 'connection failed'}). Try again shortly.`,
    };
  }
  if (error.kind === 'bad_response') {
    return {
      ok: false,
      status: 502,
      code: 'telegram_bad_response',
      message: 'Telegram returned an unreadable answer. Try again shortly.',
    };
  }
  /* A token check answers 401; that is a deployment problem, never the player's handle. */
  if (error.errorCode === 401 || error.httpStatus === 401) {
    return {
      ok: false,
      status: 503,
      code: 'telegram_unauthorized',
      message: TOKEN_MISSING_MESSAGE,
    };
  }
  if (error.errorCode === 403 || error.httpStatus === 403) {
    return { ok: false, status: 403, code: 'chat_private', message: CHAT_NOT_PUBLIC };
  }
  if (
    error.errorCode === 400 || error.errorCode === 404
    || error.httpStatus === 400 || error.httpStatus === 404
    || /chat not found|username not found|chat_id_invalid|invalid/i.test(description)
  ) {
    return { ok: false, status: 404, code: 'chat_not_found', message: CHAT_NOT_FOUND };
  }
  if (/private|not enough rights|not a member|kicked|not found/i.test(description)) {
    return { ok: false, status: 403, code: 'chat_private', message: CHAT_NOT_PUBLIC };
  }
  return { ok: false, status: 502, code: 'telegram_error', message: `Telegram could not verify this chat (${description || 'unknown error'}).` };
}

/**
 * A failed membership probe. A transport failure (timeout, DNS, TLS, a 5xx) is an outage and says
 * so; a refusal Telegram actually sent — a bot that was never added to the chat answers
 * `not enough rights` / `chat not found` on `getChatMember` — stays the bot-not-admin verdict.
 */
function membershipFailure(error: unknown, call: string): ChatFailure {
  if (isTransportFailure(error) && error instanceof TelegramError) {
    console.warn(`[squad-verify] ${call} transport failure: ${error.description}`);
    return chatFailure(error);
  }
  const description = error instanceof TelegramError ? error.description : String(error);
  console.warn(`[squad-verify] ${call} refused: ${description || 'no description'}`);
  return {
    ok: false,
    status: 400,
    code: 'bot_not_admin',
    message: 'Bot is not added as an administrator to this chat.',
  };
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

/** A transport failure is not "this user is not a member": it is an outage, and must be reported. */
const isTransportFailure = (error: unknown): boolean =>
  error instanceof TelegramError && error.kind !== 'api';

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
    if (error instanceof TelegramError) return chatFailure(error);
    console.error('[squad-verify] unexpected getChat failure:', error);
    return {
      ok: false,
      status: 502,
      code: 'telegram_error',
      message: 'Telegram could not verify this chat. Try again shortly.',
    };
  }

  const type = text(chat.type, 20);
  if (type !== 'channel' && type !== 'group' && type !== 'supergroup') {
    return { ok: false, status: 400, code: 'unsupported_chat', message: 'Only Telegram channels and groups can be registered.' };
  }

  const canonical = normalizeChatHandle(chat.username ?? '');
  if (!canonical) {
    return { ok: false, status: 403, code: 'chat_private', message: CHAT_NOT_PUBLIC };
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

/** The refusal a deployment without a token gives: named, logged, and impossible to misread. */
const noToken = (): ChatFailure => ({
  ok: false,
  status: 503,
  code: 'bot_token_missing',
  message: TOKEN_MISSING_MESSAGE,
});

/** The preview door: getChat, the chosen tab's type check, and nothing written to the registry. */
export async function verifySquadChat(
  rawHandle: string,
  requestedKind: SquadKind,
  env: Env,
): Promise<SquadChatCheck> {
  const { token, binding } = botToken(env);
  if (!token) return noToken();
  console.log(
    `[squad-verify] verifying "${normalizeChatHandle(rawHandle) || rawHandle}" with binding "${binding}"`,
  );
  const resolved = await resolveChat(rawHandle, token);
  if (!resolved.ok) {
    console.warn(`[squad-verify] getChat refused: ${resolved.code} (HTTP ${resolved.status}) — ${resolved.message}`);
    return resolved;
  }
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
  const { token } = botToken(env);
  if (!token) {
    return {
      ok: false,
      status: 503,
      code: 'bot_token_missing',
      message: TOKEN_MISSING_MESSAGE,
    };
  }

  const resolved = await resolveChat(handle, token);
  if (!resolved.ok) return resolved;
  const chat = resolved.chat;

  const expectedKind = identity?.kind === 'channel' ? 'channel' : identity?.kind === 'group' ? 'group' : '';
  if (expectedKind && chat.kind !== expectedKind) return kindMismatch(chat.kind);

  let requesterStatus: string;
  try {
    requesterStatus = await statusOf(token, chat.chatId, requester);
  } catch (error) {
    return membershipFailure(error, 'getChatMember(requester)');
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
  } catch (error) {
    return membershipFailure(error, 'getMe');
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
  } catch (error) {
    return membershipFailure(error, 'getChatMember(bot)');
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
