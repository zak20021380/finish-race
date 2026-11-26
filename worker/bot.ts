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
  answerPreCheckout, handleSuccessfulPayment,
  type PreCheckoutQueryLike, type SuccessfulPaymentLike,
} from './vip';
import {
  checkChannelMembership, OFFICIAL_CHANNEL_HANDLE, OFFICIAL_CHANNEL_URL,
} from './forceJoin';
import { BOT_HANDLE } from '../shared/config';
import {
  ensureReferralCode, readReferralPayload, referralContact, touchReferralUser,
} from './referrals';
import {
  COPY, GREETING, type BotLang, commandScope, inviteLink, inviteMenu, isBotLang,
  langFromTelegramCode, launchCard, launchUrl, languagePicker, mainMenu, playOnly, render, rulesMenu,
  shareUrl, type Keyboard,
} from './bot-copy';

const TELEGRAM_BASE = 'https://api.telegram.org/bot';

/** The deployed Mini App. `WEBAPP_URL` overrides it; a loopback request overrides that. */
const LIVE_APP_URL = 'https://finish-race.deadeye-game.workers.dev';

/* ---------- what Telegram sends, narrowed to the fields this bot reads ---------- */

interface TgUserLike {
  id?: number | string;
  language_code?: string;
  first_name?: string;
  username?: string;
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
  /** The receipt for a Stars invoice this bot issued. */
  successful_payment?: SuccessfulPaymentLike;
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

/** Telegram's notice that this bot's own seat in a chat changed — Method 1's auto-detection. */
interface TgChatMemberUpdatedLike {
  chat?: TgChatLike & { username?: string; title?: string };
  from?: TgUserLike;
  new_chat_member?: { status?: string };
}

interface TgUpdate {
  message?: TgMessageLike;
  callback_query?: TgCallbackLike;
  inline_query?: TgInlineQueryLike;
  /** The bot was added to, promoted in, or removed from a chat. */
  my_chat_member?: TgChatMemberUpdatedLike;
  /** A Stars invoice sheet waiting for the bot's yes/no. */
  pre_checkout_query?: PreCheckoutQueryLike;
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

/** A start payload is a code, not a sentence: `ref_ab12cd34ef56`, `team-AB12`, nothing messier. */
function payloadOf(text: string): string {
  const arg = text.trim().split(/\s+/).slice(1).join(' ');
  return /^[A-Za-z0-9_-]{1,64}$/.test(arg) ? arg : '';
}

/** `/rules`, `/rules@<bot>` — the handle a group appends is not part of the command. */
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

/* ---------- the localized join gate ---------- */

/** Everything the bot says when a player is outside the official channel. */
interface JoinGateCopy {
  text: string;
  joinBtn: string;
  verifyBtn: string;
  notJoined: string;
  verified: string;
  unavailable: string;
}

const JOIN_GATE: Record<BotLang, JoinGateCopy> = {
  en: {
    text: '🔒 **One Step Left to Enter the Arena!**\n\nJoin the official **TactiX** channel to unlock matchmaking, weekly tournaments, and rewards (verifying here also unlocks the Mini App automatically):',
    joinBtn: '📢 Join Official TactiX Channel',
    verifyBtn: '✅ I Joined • Play Now',
    notJoined: "❌ You haven't joined @Tactix_Official yet! Tap the Join button first, then verify.",
    verified: '✅ Channel verified — welcome to the arena!',
    unavailable: '✅ You are in — opening the arena!',
  },
  fa: {
    text: '🔒 **یک قدم تا ورود به میدان نبرد!**\n\nبرای شروع بازی، شرکت در تورنمنت‌های هفتگی و دریافت جوایز، ابتدا در کانال رسمی **TactiX** عضو شو (با عضویت در اینجا، داخل خود بازی هم بدون معطلی وارد می‌شی):',
    joinBtn: '📢 عضویت در کانال رسمی TactiX',
    verifyBtn: '✅ عضو شدم • ورود به بازی',
    notJoined: '❌ هنوز عضو کانال @Tactix_Official نشدی! ابتدا روی دکمه عضویت بزن و بعد دوباره تایید کن.',
    verified: '✅ عضویتت تایید شد — خوش آمدی به میدان نبرد!',
    unavailable: '✅ وارد بازی شو!',
  },
  ar: {
    text: '🔒 **خطوة واحدة لدخول ساحة التحدي!**\n\nانضم إلى قناة **TactiX** الرسمية لفتح اللعب والبطولات الأسبوعية والمكافآت (الانضمام هنا يفتح اللعبة تلقائياً أيضاً):',
    joinBtn: '📢 الانضمام إلى قناة TactiX الرسمية',
    verifyBtn: '✅ تم الانضمام • ابدأ اللعب',
    notJoined: '❌ لم تنضم إلى قناة @Tactix_Official بعد! اضغط على زر الانضمام أولاً ثم تحقق مرة أخرى.',
    verified: '✅ تم التحقق من عضويتك — مرحباً بك في الساحة!',
    unavailable: '✅ تفضل بالدخول إلى الساحة!',
  },
};

/** The callback that re-checks membership; the start payload rides along when it fits. */
function joinCallback(lang: BotLang, startParam: string): string {
  const clean = (startParam ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
  return clean ? `join:${lang}:${clean}` : `join:${lang}`;
}

function joinKeyboard(seat: Seat): Keyboard {
  const copy = JOIN_GATE[seat.lang];
  return {
    inline_keyboard: [
      [{ text: copy.joinBtn, url: OFFICIAL_CHANNEL_URL }],
      [{ text: copy.verifyBtn, callback_data: joinCallback(seat.lang, seat.startParam) }],
    ],
  };
}

/** Cache a verified membership in the player registry so the Mini App never asks again. */
async function syncChannelJoined(env: Env, userId: string): Promise<void> {
  if (!userId || !env.MATCHMAKER) return;
  try {
    const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));
    const response = await lobby.fetch(new Request('https://room/internal/channel-joined', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    }));
    if (!response.ok) {
      console.warn(`[bot] channel membership cache write refused: HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn('[bot] channel membership cache write failed:',
      error instanceof Error ? error.message : error);
  }
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

/** Answer with a visible toast — the alert the join card uses when the player is still outside. */
async function answer(
  token: string,
  callbackId: string | undefined,
  text: string,
  showAlert = false,
): Promise<void> {
  if (!callbackId) return;
  try {
    await api(token, 'answerCallbackQuery', {
      callback_query_id: callbackId,
      text,
      ...(showAlert ? { show_alert: true } : {}),
    });
  } catch { /* an answer that does not land is one the client has already timed out on */ }
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
  /* The Stars lane opens before any conversation branch: a donation or invoice update is not a
     chat message, and it must be answered on the same delivery Telegram is waiting on. */
  if (update.pre_checkout_query) return answerPreCheckout(update.pre_checkout_query, token);
  /* Method 1's auto-detection: the bot just became an administrator of a chat, so a squad that
     registered for it can be verified without the founder tapping anything in the Mini App. */
  if (update.my_chat_member) return handleMyChatMember(update.my_chat_member, env);
  if (update.callback_query) return handleCallback(update.callback_query, token, origin, env);
  if (update.inline_query) return handleInlineQuery(update.inline_query, token, origin, env);
  if (update.message) {
    if (update.message.successful_payment) {
      await handleSuccessfulPayment(
        update.message.successful_payment,
        update.message.from?.id,
        env,
        update.message.from?.first_name ?? '',
        update.message.from?.username ?? '',
      );
      return;
    }
    return handleMessage(update.message, token, origin, env);
  }
  /* Channel posts, new-chat-member notices, poll answers: none is a conversation with a player. */
}

/**
 * Forward the bot's own membership change to the one room that owns the squad registry. The
 * update names the person who added the bot; the room re-proves that actor with `getChatMember`
 * before any badge moves, so a Telegram notice alone never verifies a community.
 */
async function handleMyChatMember(update: TgChatMemberUpdatedLike, env: Env): Promise<void> {
  const status = (update.new_chat_member?.status ?? '').toLowerCase();
  if (status !== 'administrator' && status !== 'creator') return;
  const chatId = idOf(update.chat?.id);
  const actorId = idOf(update.from?.id);
  if (!chatId || !actorId || !env.MATCHMAKER) return;
  const handle = (update.chat?.username ?? '').trim().replace(/^@+/, '').slice(0, 32);
  /* `global` is the singleton lobby `worker/index.ts` binds every squad route to. `/internal/*`
     has no public door: the edge never forwards it. */
  const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));
  try {
    await lobby.fetch(new Request('https://room/internal/squad-bot-admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, handle, actorId }),
    }));
  } catch {
    /* The badge will still be earned the moment the founder presses Verify in the drawer. */
  }
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

  /* Any command is contact: a player who knew this bot before the link can never become a new
     invitee later. `/start` does the same inside its own branch, with a ref payload when present. */
  if (command !== 'start') await touchReferralUser(env, userId).catch(() => '');

  if (command === 'start') {
    /* A `/start ref_<code>` off a friend's link: bind the pending referral server-side now, so
       both launch paths (bot chat and `?startapp=`) resolve to the same attribution. A start
       without a payload still records that this player existed before any later link arrives. */
    const payload = payloadOf(raw);
    if (payload) {
      remember(userId, { startParam: payload }, message.from?.language_code ?? '');
      const ref = readReferralPayload(payload);
      if (ref) await referralContact(env, userId, ref).catch(() => null);
      else await touchReferralUser(env, userId).catch(() => '');
    } else {
      await touchReferralUser(env, userId).catch(() => '');
    }
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
  | { kind: 'invite'; lang: BotLang }
  | { kind: 'join'; lang: BotLang; payload: string };

/**
 * What a button asks for. An unrecognised string is not an error — it is a button from a build of
 * this menu that no longer exists, and the caller still owes the player an answer.
 */
function screenOf(data: string): Screen | null {
  if (data === 'menu:lang') return { kind: 'greeting' };

  const menu = /^lang:([a-z]{2})$/.exec(data)?.[1];
  if (menu && isBotLang(menu)) return { kind: 'menu', lang: menu };

  /* The verify button carries its language and, when it fits, the deep-link payload it arrived on. */
  const join = /^join:([a-z]{2})(?::([A-Za-z0-9_-]{1,48}))?$/.exec(data);
  const joinLang = join?.[1];
  if (joinLang && isBotLang(joinLang)) return { kind: 'join', lang: joinLang, payload: join?.[2] ?? '' };

  const detail = /^menu:(rules|invite):([a-z]{2})$/.exec(data);
  const lang = detail?.[2];
  if (detail && lang && isBotLang(lang)) return { kind: detail[1] === 'rules' ? 'rules' : 'invite', lang };
  return null;
}

async function handleCallback(callback: TgCallbackLike, token: string, origin: string, env: Env): Promise<void> {
  const chatId = idOf(callback.message?.chat?.id);
  const userId = idOf(callback.from?.id);
  const screen = screenOf((callback.data ?? '').trim());

  if (!screen || !chatId) {
    await ack(token, callback.id);
    return;
  }

  /* The verify button owns its own answer: it must be able to raise a localized alert. */
  if (screen.kind === 'join') {
    await handleJoinVerify(callback, screen, token, origin, env, chatId, userId);
    return;
  }

  /* Every other callback is answered before anything else, so the player's button stops spinning
     even on a screen the bot cannot draw. */
  await ack(token, callback.id);

  /* A language tap now runs the silent membership pre-check before any menu is painted. */
  if (screen.kind === 'menu') {
    await handleLanguageChoice(callback, screen.lang, token, origin, env, chatId, userId);
    return;
  }

  /* Only a button that names a language changes which language this player is remembered in. */
  const seat = screen.kind === 'greeting'
    ? seatOf(userId, callback.from?.language_code ?? '')
    : remember(userId, { lang: screen.lang });
  const play = playUrlFor(env, origin, seat);
  const copy = COPY[seat.lang];
  /* The code is the ledger's random, server-owned code — never the Telegram id. */
  const code = await ensureReferralCode(env, userId).catch(() => '');
  const invite = inviteLink(code);

  const text = screen.kind === 'greeting' ? render(GREETING)
    : screen.kind === 'rules' ? render(copy.rules)
      : render(copy.invite).replace('{link}', invite);
  const keyboard = screen.kind === 'greeting' ? languagePicker()
    : screen.kind === 'rules' ? rulesMenu(screen.lang, play)
      : inviteMenu(screen.lang, shareUrl(invite, copy.pitch), copy.pitch);

  await show(token, chatId, callback.message?.message_id, text, keyboard);
}

/**
 * A language was chosen. Check the official channel silently and paint exactly one next screen:
 * the welcome + Play Now card for a member, or the localized join card for everyone else.
 */
async function handleLanguageChoice(
  callback: TgCallbackLike,
  lang: BotLang,
  token: string,
  origin: string,
  env: Env,
  chatId: string,
  userId: string,
): Promise<void> {
  const seat = remember(userId, { lang }, callback.from?.language_code ?? '');
  const play = playUrlFor(env, origin, seat);
  const copy = COPY[seat.lang];

  /* Mint the player's permanent invite code on first contact, exactly as the picker always did. */
  const [membership] = await Promise.all([
    checkChannelMembership(env, userId, `@${OFFICIAL_CHANNEL_HANDLE}`),
    ensureReferralCode(env, userId).catch(() => ''),
  ]);

  if (membership.member) {
    if (membership.unavailable) {
      console.warn(`[bot] channel check unavailable for ${userId || 'unknown'}: ${membership.description}. Allowing launch.`);
    } else {
      await syncChannelJoined(env, userId);
    }
    await show(token, chatId, callback.message?.message_id, render(copy.welcome), mainMenu(seat.lang, play));
    return;
  }

  await show(token, chatId, callback.message?.message_id, render(JOIN_GATE[seat.lang].text), joinKeyboard(seat));
}

/**
 * The `✅ I Joined` button: re-read Telegram, alert a player who is still outside, and unlock the
 * welcome card for a verified member. The callback carries the start payload when it fits, so a
 * friend invite, duel or squad link survives even a cold worker between the two taps.
 */
async function handleJoinVerify(
  callback: TgCallbackLike,
  screen: { kind: 'join'; lang: BotLang; payload: string },
  token: string,
  origin: string,
  env: Env,
  chatId: string,
  userId: string,
): Promise<void> {
  if (!userId) {
    await ack(token, callback.id);
    return;
  }

  const seat = remember(userId, {
    lang: screen.lang,
    ...(screen.payload ? { startParam: screen.payload } : {}),
  }, callback.from?.language_code ?? '');
  const copy = JOIN_GATE[seat.lang];
  const membership = await checkChannelMembership(env, userId, `@${OFFICIAL_CHANNEL_HANDLE}`);

  if (!membership.member) {
    await answer(token, callback.id, copy.notJoined, true);
    return;
  }

  /* Answer before the cache write: the toast must land while the tap is still alive. */
  await answer(token, callback.id, membership.unavailable ? copy.unavailable : copy.verified);

  if (membership.unavailable) {
    console.warn(`[bot] channel re-check unavailable for ${userId}: ${membership.description}. Allowing launch.`);
  } else {
    await syncChannelJoined(env, userId);
  }

  const play = playUrlFor(env, origin, seat);
  await show(token, chatId, callback.message?.message_id, render(COPY[seat.lang].welcome), mainMenu(seat.lang, play));
}

async function handleInlineQuery(query: TgInlineQueryLike, token: string, origin: string, env: Env): Promise<void> {
  if (!query.id) return;
  const userId = idOf(query.from?.id);
  const seat = seatOf(userId, query.from?.language_code ?? '');
  const copy = COPY[seat.lang];
  const code = await ensureReferralCode(env, userId).catch(() => '');
  const invite = inviteLink(code);
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

  /* `my_chat_member` is what tells squad verification the bot was just made an administrator;
     naming the set explicitly keeps that update coming even where defaults change. */
  const webhookParams: Record<string, unknown> = {
    url: webhook,
    drop_pending_updates: false,
    allowed_updates: ['message', 'callback_query', 'inline_query', 'pre_checkout_query', 'my_chat_member'],
  };
  /* An empty secret_token is a rejected one, so the field goes only when the operator set it. */
  if (secret) webhookParams.secret_token = secret;

  const steps: Record<string, StepResult> = {
    setWebhook: await attempt(token, 'setWebhook', webhookParams),
  };

  /* Read the live username for the operator's report, but never let it rewrite the links: the
     shared config is the single source of truth for every deep link. */
  try {
    const me = await api<{ username?: string }>(token, 'getMe', {});
    const live = (me.username ?? '').replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '');
    steps.getMe = {
      ok: true,
      detail: live && live !== BOT_HANDLE ? `${live} (links use ${BOT_HANDLE})` : BOT_HANDLE,
    };
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
    bot: BOT_HANDLE,
    webhook,
    app_url: app,
    admin: admin.userId,
    steps,
    ...(failed.length ? { failed } : {}),
  }, failed.length ? 502 : 200);
}
