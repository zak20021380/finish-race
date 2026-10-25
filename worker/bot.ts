/**
 * bot.ts — the Telegram Bot's own chat surface: the webhook that reads updates, and the one route
 * that registers it with Telegram.
 *
 * This is the conversation a player has *before* the Mini App opens, so it is deliberately stateless
 * where it can be. Every callback string carries its own language (`menu:rules:fa`), so a menu can
 * be redrawn by a worker that has never met the player. The map below is only a convenience: it
 * remembers a language so a bare `/rules` answers in it, and it remembers the `?startapp=` a player
 * arrived on so a referral survives the hop from the bot's PLAY button into the game. It is bounded
 * and lives in memory because losing it costs a re-prompt and nothing else — unlike the queue and
 * the ledger, it holds no authority, so it gets no Durable Object.
 *
 * Three rules shape the rest:
 *
 *   - The webhook answers `200` for anything it can parse, always. A non-2xx makes Telegram retry and
 *     eventually back off, which reads to a player as a dead bot; a blocked account or a body we
 *     cannot read is not worth that. The one thing it refuses is a wrong `secret_token`, because
 *     that means somebody else is delivering updates for this bot.
 *   - An outbound failure that is *normal* — a blocked player, a screen that already shows exactly
 *     this — is swallowed where it happens, so one dead conversation cannot fail a whole delivery.
 *     Every other reply, though, is awaited: `sendMessage` before the webhook answers, so a worker
 *     is never killed with a half-sent menu.
 *   - `/telegram/setup-webhook` registers the webhook at its *own* origin: calling it on
 *     `finish-race.deadeye-game.workers.dev` wires up that host, calling it on `127.0.0.1:8787`
 *     wires up a local worker, and neither needs a config edit.
 *
 * Replies go out as HTML (`render()` in `bot-copy.ts`) for the reason given there: the invite link
 * this bot prints contains characters legacy Markdown would have had to escape.
 */
import type { Env } from './env';
import { isLocalhost, verifyAdminRequest } from './auth';
import { json } from './http';
import {
  COPY, GREETING, type BotLang, commandScope, inviteLink, inviteMenu, isBotLang,
  langFromTelegramCode, launchCard, launchUrl, languagePicker, mainMenu, playOnly, render, rulesMenu,
  shareUrl, type Keyboard,
} from './bot-copy';

const TELEGRAM_BASE = 'https://api.telegram.org/bot';

/** The deployed Mini App. `WEBAPP_URL` overrides it; a loopback request overrides that. */
const LIVE_APP_URL = 'https://finish-race.deadeye-game.workers.dev';

/** Mirrors `BOT_HANDLE` in `src/telegram.ts`. Replaced by `getMe` every time setup runs. */
let botHandle = 'detour_game_bot';

/* ---------- what Telegram sends, narrowed to the fields this bot reads ---------- */

interface TgUserLike {
  id?: number | string;
  language_code?: string;
  is_bot?: boolean;
}

interface TgChatLike {
  id?: number | string;
  type?: string;
}

interface TgMessageLike {
  message_id?: number;
  chat?: TgChatLike;
  from?: TgUserLike;
  text?: string;
}

interface TgCallbackLike {
  id?: string;
  data?: string;
  from?: TgUserLike;
  message?: TgMessageLike;
}

interface TgInlineQueryLike {
  id?: string;
  from?: TgUserLike;
}

interface TgUpdate {
  message?: TgMessageLike;
  callback_query?: TgCallbackLike;
  inline_query?: TgInlineQueryLike;
}

interface TelegramEnvelope<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

class TelegramError extends Error {
  constructor(readonly description: string, readonly errorCode: number) {
    super(description);
  }
}

/* ---------- the API client ---------- */

async function api<T>(token: string, method: string, params: Record<string, unknown>): Promise<T> {
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
    const described = typeof data?.description === 'string' ? data.description.slice(0, 160) : '';
    throw new TelegramError(described || `telegram ${method} failed`,
      typeof data?.error_code === 'number' ? data.error_code : response.status);
  }
  return data.result;
}

/** The screen already shows exactly this: not a failure worth resending for. */
function isUnchanged(error: unknown): boolean {
  return error instanceof TelegramError && error.errorCode === 400 && /not modified/i.test(error.description);
}

/** A player who blocked the bot, or a chat that is gone. Retrying either one is a wasted round trip. */
function isUnreachable(error: unknown): boolean {
  return error instanceof TelegramError
    && (error.errorCode === 403 || error.errorCode === 400)
    && /bot was blocked|chat not found|chat is unavailable|user is deactivated/i.test(error.description);
}

/* ---------- the two memories, bounded ---------- */

interface Seat {
  lang: BotLang;
  /** The `?startapp=` / `/start <payload>` this player arrived on, referral codes among them. */
  startParam: string;
}

const MEMORY_MAX = 20_000;
const memory = new Map<string, Seat>();

/** What this player last told us, or a reasonable guess from the language their client reports. */
function seatOf(userId: string, languageCode: string): Seat {
  return memory.get(userId) ?? { lang: langFromTelegramCode(languageCode), startParam: '' };
}

function remember(userId: string, patch: Partial<Seat>, languageCode = ''): Seat {
  if (!userId) return { lang: patch.lang ?? 'en', startParam: patch.startParam ?? '' };
  const seat = { ...seatOf(userId, languageCode), ...patch };
  memory.set(userId, seat);
  /* Oldest seat out: a bot this shallow never keeps every player in RAM. */
  if (memory.size > MEMORY_MAX) {
    const oldest = memory.keys().next();
    if (!oldest.done) memory.delete(oldest.value);
  }
  return seat;
}

/* ---------- ids, commands and the launch url ---------- */

/** Telegram ids arrive as numbers and go back as strings; only digits and a leading minus survive. */
function idOf(value: number | string | undefined): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[^0-9-]/g, '').slice(0, 32);
}

/** A start payload is a code, not a sentence: `ref_u123`, `team-AB12`, nothing messier. */
function payloadOf(text: string): string {
  const arg = text.trim().split(/\s+/).slice(1).join(' ');
  return /^[A-Za-z0-9_-]{1,64}$/.test(arg) ? arg : '';
}

/** `/rules`, `/rules@detour_game_bot` — the handle a group appends is not part of the command. */
const COMMAND = /^\/([A-Za-z_]{1,32})(?:@\w{3,64})?/;

function commandOf(text: string): string {
  const name = COMMAND.exec((text ?? '').trim())?.[1];
  return (name ?? '').toLowerCase();
}

function appUrl(env: Env, origin: string): string {
  const configured = (env.WEBAPP_URL ?? '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  try {
    /* Local work against a local worker: the button should open the app being edited. */
    const url = new URL(origin);
    if (isLocalhost(url.hostname)) return origin.replace(/\/+$/, '');
  } catch { /* an origin we cannot parse is not a Mini App */ }
  return LIVE_APP_URL;
}

/** The Mini App a `web_app` button opens, carrying this player's referral through into the game. */
function playUrlFor(env: Env, origin: string, seat: Seat): string {
  return launchUrl(appUrl(env, origin), seat.startParam);
}

/* ---------- the two ways a screen reaches the player ---------- */

async function send(token: string, chatId: string, text: string, keyboard: Keyboard): Promise<void> {
  await api(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: keyboard });
}

/**
 * Redraw in place when we can — a menu that stacks fresh messages is a mess — and answer afresh when
 * the message we were handed to edit is gone.
 */
async function show(
  token: string,
  chatId: string,
  messageId: number | undefined,
  text: string,
  keyboard: Keyboard,
): Promise<void> {
  if (!messageId) {
    await send(token, chatId, text, keyboard);
    return;
  }
  try {
    await api(token, 'editMessageText', {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: keyboard,
    });
  } catch (error) {
    if (isUnchanged(error) || isUnreachable(error)) return;
    await send(token, chatId, text, keyboard);
  }
}

/** The spinner on the player's button stops here, whatever the menu below it goes on to do. */
async function ack(token: string, callbackId: string | undefined): Promise<void> {
  if (!callbackId) return;
  try {
    await api(token, 'answerCallbackQuery', { callback_query_id: callbackId });
  } catch { /* an ack that does not land is one the client has already timed out on */ }
}

/* ---------- the webhook ---------- */

export async function telegramWebhook(request: Request, env: Env): Promise<Response> {
  const secret = (env.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
  if (secret && request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return json({ ok: false, error: 'bad_webhook_secret' }, 403);
  }

  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) return json({ ok: false, error: 'no_bot_token' }, 503);

  let update: TgUpdate | null = null;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    update = null;
  }
  if (!update || typeof update !== 'object') return json({ ok: true, ignored: 'unparseable' });

  try {
    await dispatch(update, token, originOf(request.url), env);
  } catch (error) {
    if (isUnreachable(error)) return json({ ok: true, ignored: 'unreachable' });
    console.warn('telegram webhook:', error instanceof Error ? error.message : error);
  }
  return json({ ok: true });
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return LIVE_APP_URL;
  }
}

async function dispatch(update: TgUpdate, token: string, origin: string, env: Env): Promise<void> {
  if (update.callback_query) return handleCallback(update.callback_query, token, origin, env);
  if (update.inline_query) return handleInlineQuery(update.inline_query, token, origin, env);
  if (update.message) return handleMessage(update.message, token, origin, env);
  /* Channel posts, new-chat-member notices, poll answers: none is a conversation with a player. */
}

async function handleMessage(message: TgMessageLike, token: string, origin: string, env: Env): Promise<void> {
  const chatId = idOf(message.chat?.id);
  const userId = idOf(message.from?.id);
  if (!chatId || !userId || message.from?.is_bot) return;

  const raw = (message.text ?? '').trim();
  const command = commandOf(raw);
  const seat = seatOf(userId, message.from?.language_code ?? '');
  const copy = COPY[seat.lang];
  const play = playUrlFor(env, origin, seat);

  if (command === 'start') {
    /* A `/start ref_u123` off a friend's link: bank the code now, so the PLAY button can carry it
       into the Mini App after this player picks a language. */
    const payload = payloadOf(raw);
    if (payload) remember(userId, { startParam: payload }, message.from?.language_code ?? '');
    await send(token, chatId, render(GREETING), languagePicker());
    return;
  }

  if (command === 'lang') {
    await send(token, chatId, render(GREETING), languagePicker());
    return;
  }

  if (command === 'play') {
    await send(token, chatId, render(copy.launch), launchCard(seat.lang, play));
    return;
  }

  if (command === 'rules') {
    await send(token, chatId, render(copy.rules), rulesMenu(seat.lang, play));
    return;
  }

  /* Any other word in a private chat is a player looking for the menu; a group is not a lobby. */
  if (!command && message.chat?.type === 'private') {
    await send(token, chatId, render(copy.welcome), mainMenu(seat.lang, play));
  }
}

/* ---------- the callback grammar ---------- */

type Screen =
  | { kind: 'greeting' }
  | { kind: 'menu'; lang: BotLang }
  | { kind: 'rules'; lang: BotLang }
  | { kind: 'invite'; lang: BotLang };

/**
 * What a button asks for. An unrecognised string is not an error — it is a button from a build of
 * this menu that no longer exists, and the caller still owes the player an answer.
 */
function screenOf(data: string): Screen | null {
  if (data === 'menu:lang') return { kind: 'greeting' };

  const menu = /^lang:([a-z]{2})$/.exec(data)?.[1];
  if (menu && isBotLang(menu)) return { kind: 'menu', lang: menu };

  const detail = /^menu:(rules|invite):([a-z]{2})$/.exec(data);
  const lang = detail?.[2];
  if (detail && lang && isBotLang(lang)) return { kind: detail[1] === 'rules' ? 'rules' : 'invite', lang };
  return null;
}

async function handleCallback(callback: TgCallbackLike, token: string, origin: string, env: Env): Promise<void> {
  const chatId = idOf(callback.message?.chat?.id);
  const userId = idOf(callback.from?.id);
  const screen = screenOf((callback.data ?? '').trim());

  /* Every callback is answered before anything else, so the player's button stops spinning even on
     a screen the bot cannot draw. */
  await ack(token, callback.id);
  if (!screen || !chatId) return;

  /* Only a button that names a language changes which language this player is remembered in. */
  const seat = screen.kind === 'greeting'
    ? seatOf(userId, callback.from?.language_code ?? '')
    : remember(userId, { lang: screen.lang });
  const play = playUrlFor(env, origin, seat);
  const copy = COPY[seat.lang];
  const invite = inviteLink(botHandle, userId);

  const text = screen.kind === 'greeting' ? render(GREETING)
    : screen.kind === 'menu' ? render(copy.welcome)
      : screen.kind === 'rules' ? render(copy.rules)
        : render(copy.invite).replace('{link}', invite);
  const keyboard = screen.kind === 'greeting' ? languagePicker()
    : screen.kind === 'menu' ? mainMenu(screen.lang, play)
      : screen.kind === 'rules' ? rulesMenu(screen.lang, play)
        : inviteMenu(screen.lang, shareUrl(invite, copy.pitch), copy.pitch);

  await show(token, chatId, callback.message?.message_id, text, keyboard);
}

async function handleInlineQuery(query: TgInlineQueryLike, token: string, origin: string, env: Env): Promise<void> {
  if (!query.id) return;
  const userId = idOf(query.from?.id);
  const seat = seatOf(userId, query.from?.language_code ?? '');
  const copy = COPY[seat.lang];
  const invite = inviteLink(botHandle, userId);
  try {
    await api(token, 'answerInlineQuery', {
      inline_query_id: query.id,
      cache_time: 300,
      results: [{
        type: 'article',
        id: `detour-${userId || 'guest'}`,
        title: copy.challengeBtn,
        description: copy.pitch.slice(0, 64),
        /* The card a player drops into any chat: the pitch, the link under it, and one button that
           opens the race. The invitee's own `/start ref_…` is what pays the referral later. */
        input_message_content: { message_text: render(`**${copy.pitch}**\n${invite}`), parse_mode: 'HTML' },
        reply_markup: playOnly(seat.lang, playUrlFor(env, origin, seat)),
      }],
    });
  } catch { /* an inline answer nobody waited for is not worth a retry storm */ }
}

/* ---------- the operator's setup door ---------- */

interface StepResult {
  ok: boolean;
  detail?: string;
}

async function attempt(token: string, method: string, params: Record<string, unknown>): Promise<StepResult> {
  try {
    const result = await api<unknown>(token, method, params);
    const detail = typeof result === 'object' ? JSON.stringify(result) : String(result);
    return { ok: true, detail: detail.slice(0, 300) };
  } catch (error) {
    return { ok: false, detail: error instanceof TelegramError ? error.description : 'failed' };
  }
}

/**
 * `GET|POST /telegram/setup-webhook` — points this bot at this origin's webhook and tells Telegram
 * what to show a player: the localised `/` command list, and a chat menu button that opens the Mini
 * App directly. Every step is reported rather than thrown, so one rejected call still leaves the
 * operator knowing which step failed and which landed. Behind the same `ADMIN_IDS` door as `/admin/*`.
 */
export async function telegramSetup(request: Request, env: Env): Promise<Response> {
  const admin = await verifyAdminRequest(request, env);
  if (!admin) {
    return json({
      error: 'forbidden',
      hint: 'signed initData for an id on ADMIN_IDS, or the dev door on loopback',
    }, 403);
  }

  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) return json({ error: 'no_bot_token', hint: 'wrangler secret put TELEGRAM_BOT_TOKEN' }, 503);

  const origin = originOf(request.url);
  const webhook = `${origin}/telegram/webhook`;
  const app = appUrl(env, origin);
  const secret = (env.TELEGRAM_WEBHOOK_SECRET ?? '').trim();

  const webhookParams: Record<string, unknown> = { url: webhook, drop_pending_updates: false };
  /* An empty secret_token is a rejected one, so the field goes only when the operator set it. */
  if (secret) webhookParams.secret_token = secret;

  const steps: Record<string, StepResult> = {
    setWebhook: await attempt(token, 'setWebhook', webhookParams),
  };

  /* The handle every invite link is built on, read from the bot itself rather than trusted from a
     var: one setup call fixes every link if the bot is ever renamed. */
  try {
    const me = await api<{ username?: string }>(token, 'getMe', {});
    const clean = (me.username ?? '').replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '');
    if (clean) botHandle = clean;
    steps.getMe = { ok: true, detail: botHandle };
  } catch (error) {
    steps.getMe = { ok: false, detail: error instanceof TelegramError ? error.description : 'failed' };
  }

  /* The unscoped list answers every language the bot has no copy for; fa and ar override it in the
     player's own client, where the `/` autocomplete is drawn. */
  steps.setMyCommands = await attempt(token, 'setMyCommands', {
    ...commandScope('en'),
    scope: { type: 'all_private_chats' },
  });
  for (const lang of ['fa', 'ar'] as BotLang[]) {
    steps[`setMyCommands_${lang}`] = await attempt(token, 'setMyCommands', {
      ...commandScope(lang),
      language_code: lang,
      scope: { type: 'all_private_chats' },
    });
  }

  steps.setChatMenuButton = await attempt(token, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: COPY.en.play, web_app: { url: app } },
  });

  steps.getWebhookInfo = await attempt(token, 'getWebhookInfo', {});

  const failed = Object.entries(steps).filter(([, step]) => !step.ok).map(([name]) => name);
  return json({
    ok: failed.length === 0,
    bot: botHandle,
    webhook,
    app_url: app,
    admin: admin.userId,
    steps,
    ...(failed.length ? { failed } : {}),
  }, failed.length ? 502 : 200);
}
