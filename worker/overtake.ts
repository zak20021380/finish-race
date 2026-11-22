/**
 * overtake.ts — the rank-overtake push: one rival passed, one alert in the reader's own language.
 *
 * A settled board can move a player up the Mind Ladder, and the player it moved past is — by
 * definition — not looking at the ladder. That makes Telegram the only channel that can reach
 * them, and this module is the whole of it: the five localised cards, the HTML escaping, and the
 * one Bot API call. `matchmaker.ts` owns *when* a push is warranted, because only the room can see
 * the ladder before and after a settlement, and only the room knows who is already in the app.
 *
 * Three rules hold the copy together, and none of them is stylistic:
 *
 *   - Latin numerals only (`0-9`), in every language. A rank is a number the reader compares
 *     against the board they will open, so it has to be the same glyphs the board prints. `String()`
 *     is used rather than `toLocaleString()` for exactly that reason.
 *   - No emoji. This is a competitive notice, not a sticker: a bold headline, the rival's name,
 *     the new rank, and the way back.
 *   - The rival's name is escaped, never trusted. It arrives from a Telegram profile and is written
 *     into a `parse_mode: 'HTML'` body — a `<` in a display name must read as a character, not as
 *     markup the client will then try to render.
 *
 * The button is the repo's own Mini App deep link (`?startapp=ranks`), not a raw `web_app` URL: a
 * Durable Object has no request origin to hang the app off, and `botAppLink()` is already the one
 * place that grammar lives — the lobby nudge reaches for it for the same reason.
 */
import type { Env } from './env';
import { botAppLink } from '../shared/config';

/* ---------- the languages ---------- */

/** The five locales the Mini App ships. A bot card is written in one of them, never in a sixth. */
export type OvertakeLang = 'en' | 'fa' | 'ru' | 'ar' | 'es';

/** Every locale, in the order the app's own picker lists them. */
export const OVERTAKE_LANGS: readonly OvertakeLang[] = ['en', 'fa', 'ru', 'ar', 'es'];

/** What a seat with no language signal at all reads. */
export const DEFAULT_OVERTAKE_LANG: OvertakeLang = 'en';

/**
 * Telegram's `language_code` folded to one of the five: `fa` and `fa-IR` both answer `fa`, and a
 * locale the app does not ship (`de`, `tr`, …) answers `''` rather than a guess.
 *
 * `''` means "Telegram named no locale this time", which is deliberately not the same as `en`: a
 * caller keeps the language it already knew instead of resetting a Persian seat to English because
 * one connect arrived without the field.
 */
export function overtakeLangOf(raw: unknown): OvertakeLang | '' {
  const code = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 2) : '';
  return (OVERTAKE_LANGS as readonly string[]).includes(code) ? (code as OvertakeLang) : '';
}

/* ---------- the words ---------- */

/**
 * One language's card. The rank is already a Latin-digit string and the rival's name is already
 * escaped when these run, so a template is free to be nothing but the sentence it is.
 */
interface OvertakeCopy {
  text: (rival: string, newRank: string) => string;
  button: (oldRank: string) => string;
}

const COPY: Record<OvertakeLang, OvertakeCopy> = {
  en: {
    text: (rival, rank) =>
      `<b>Rank Alert</b>\n\n<b>${rival}</b> just passed you on the Top Minds ladder. `
      + `You dropped to <b>#${rank}</b>.\n\nJump back into the arena and reclaim your spot.`,
    button: (rank) => `Reclaim Rank #${rank}`,
  },
  fa: {
    text: (rival, rank) =>
      `<b>هشدار رتبه در TactiX</b>\n\n<b>${rival}</b> همین الان توی جدول ازت جلو زد و رتبه‌ت شد `
      + `<b>#${rank}</b>.\n\nبرگرد توی بازی و جات رو پس بگیر!`,
    button: (rank) => `پس گرفتن رتبه #${rank}`,
  },
  ru: {
    text: (rival, rank) =>
      `<b>Изменение в рейтинге</b>\n\n<b>${rival}</b> только что обошел вас в таблице лидеров. `
      + `Ваше новое место: <b>#${rank}</b>.\n\nВернитесь на арену и верните свою позицию.`,
    button: (rank) => `Вернуть место #${rank}`,
  },
  ar: {
    text: (rival, rank) =>
      `<b>تنبيه الترتيب في TactiX</b>\n\n<b>${rival}</b> تجاوزك للتو في لوحة المتصدرين وأصبح ترتيبك `
      + `<b>#${rank}</b>.\n\nعد إلى الساحة واستعد مركزك الآن.`,
    button: (rank) => `استعادة المركز #${rank}`,
  },
  es: {
    text: (rival, rank) =>
      `<b>Alerta de Clasificacion</b>\n\n<b>${rival}</b> acaba de superarte en la tabla. `
      + `Bajaste al puesto <b>#${rank}</b>.\n\nVuelve a la arena y recupera tu lugar.`,
    button: (rank) => `Recuperar Puesto #${rank}`,
  },
};

/* ---------- the card ---------- */

/** The `?startapp=` the button carries: the ladder's own door in the Mini App. */
export const RANKS_START_PAYLOAD = 'ranks';

/** A rank as the reader sees it: ASCII digits in every language, never a localised numeral. */
const latin = (value: number): string => String(Math.max(0, Math.trunc(value)));

/** A display name, safe to drop inside a `parse_mode: 'HTML'` body. */
function escapeHtml(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Everything one push needs: who to reach, in what language, and about which two ranks. */
export interface OvertakePush {
  /** The Telegram chat to reach — the numeric user id `chatIdOf()` reads off a seat. */
  chatId: string;
  lang: OvertakeLang;
  /** The seat that climbed past the reader. */
  rivalName: string;
  /** The reader's place now. */
  newRank: number;
  /** The place it just lost — what the button promises to win back. */
  oldRank: number;
}

/** The `sendMessage` body's two content fields, built together so they can never disagree. */
export interface OvertakeCard {
  text: string;
  reply_markup: {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
}

/**
 * One localised card. A language this module does not carry reads as English rather than as a
 * blank message: a notification with the wrong words still tells the player their rank moved.
 */
export function overtakeCard(push: OvertakePush): OvertakeCard {
  const copy = COPY[push.lang] ?? COPY[DEFAULT_OVERTAKE_LANG];
  const rival = escapeHtml((push.rivalName ?? '').trim().slice(0, 40)) || 'Player';
  return {
    text: copy.text(rival, latin(push.newRank)),
    reply_markup: {
      inline_keyboard: [[
        { text: copy.button(latin(push.oldRank)), url: botAppLink(RANKS_START_PAYLOAD) },
      ]],
    },
  };
}

/* ---------- the one call ---------- */

export interface OvertakeResult {
  /** The Bot API accepted the message. */
  ok: boolean;
  /**
   * The chat is closed to this bot for good — blocked, deleted, or never started. The caller
   * remembers that on the seat and never spends another round trip on it.
   */
  dead: boolean;
}

const TELEGRAM_BASE = 'https://api.telegram.org/bot';
/** A push never holds a settlement: the call gives up long before a player would notice it hung. */
const PUSH_TIMEOUT_MS = 6_000;

/** The deployment's bot token, in the order `env.ts` documents the bindings. */
export function botTokenOf(env: Env | undefined): string {
  return env?.TELEGRAM_BOT_TOKEN?.trim() || env?.BOT_TOKEN?.trim() || env?.TELEGRAM_TOKEN?.trim() || '';
}

/**
 * Send one card. Never throws and never rejects: the caller fires this from a settled board, and a
 * Bot API hiccup is not the race's problem.
 *
 * A refusal that means "this chat is gone" is reported as `dead` so the room can persist it — the
 * difference between a player who muted their notifications for an evening and a player who
 * blocked the bot is the difference between trying again tomorrow and never trying again.
 */
export async function pushOvertake(env: Env, push: OvertakePush): Promise<OvertakeResult> {
  const token = botTokenOf(env);
  if (!token) return { ok: false, dead: false };
  /* Only a numeric chat id is a Telegram user. A malformed one would be refused as `chat not
     found` and remembered as a dead conversation, which would be the wrong verdict on a live
     player — so it never leaves here. */
  if (!/^[0-9]{1,20}$/.test(push.chatId)) return { ok: false, dead: false };
  const card = overtakeCard(push);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const response = await fetch(`${TELEGRAM_BASE}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: push.chatId,
        text: card.text,
        parse_mode: 'HTML',
        reply_markup: card.reply_markup,
      }),
      signal: controller.signal,
    });
    if (response.ok) return { ok: true, dead: false };
    /* `403` is a block or a chat the bot may not open. A `400` on a body this module authored is a
       chat id Telegram cannot resolve (never started, account deleted, id reused) — the two ways a
       conversation stops existing. A `400` for anything else (a parse the client rejected) is our
       own bug, and marking a live player unreachable over it would be worse than retrying. */
    if (response.status === 403) return { ok: false, dead: true };
    if (response.status !== 400) return { ok: false, dead: false };
    let description = '';
    try {
      const body = await response.json() as { description?: unknown };
      description = typeof body?.description === 'string' ? body.description : '';
    } catch {
      /* a proxy or an HTML error page is not JSON: the status alone is what we have */
    }
    const gone = description === ''
      || /chat not found|chat_id|peer_id_invalid|user not found|bot was blocked|bot can't initiate/i.test(description);
    return { ok: false, dead: gone };
  } catch {
    /* A timeout or a dead link is not the reader's fault: nothing is remembered, and the next
       overtake — if there is one — tries again. */
    return { ok: false, dead: false };
  } finally {
    clearTimeout(timer);
  }
}
