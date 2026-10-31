/**
 * config.ts — the one place the Telegram identity lives.
 *
 * Every deep link the app or the bot prints is built here: the client bundle (`src/`), the Worker
 * (`worker/`) and the harnesses (`scripts/`) all import this module, so renaming the bot is one
 * edit rather than a hunt for hardcoded `t.me/...` strings.
 */

/** The bot handle, without the `@`. This is the single source of truth for every deep link. */
export const BOT_HANDLE = 'Tactix_Robot';

/** The player-facing brand. */
export const BOT_NAME = 'Tactix';

/** The BotFather Mini App short name: the `/app` in `https://t.me/<bot>/app`. */
export const BOT_APP_SHORT_NAME = 'app';

/** The official community channel behind the forced-join gate and the Settings row. */
export const CHANNEL_HANDLE = 'detour_game';
export const CHANNEL_URL = `https://t.me/${CHANNEL_HANDLE}`;

/** The referral payout, in coins, paid to both sides of a credited invite. */
export const REFERRAL_REWARD = 500;

/** The `?startapp=` / `/start` payload prefix. */
export const REFERRAL_PREFIX = 'ref_';

/** Referral codes are random, lowercase base36, and long enough to resist enumeration. */
export const REFERRAL_CODE_LENGTH = 12;
export const REFERRAL_CODE_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export const REFERRAL_CODE_RE = new RegExp(`^[a-z0-9]{${REFERRAL_CODE_LENGTH}}$`);

/** Keep a start payload inside Telegram's own alphabet and length budget. */
export function cleanStartPayload(payload: string): string {
  return (payload ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

/** `https://t.me/Tactix_Robot/app?startapp=<payload>` — opens the Mini App directly. */
export function botAppLink(payload = ''): string {
  const clean = cleanStartPayload(payload);
  const base = `https://t.me/${BOT_HANDLE}/${BOT_APP_SHORT_NAME}`;
  return clean ? `${base}?startapp=${clean}` : base;
}

/**
 * The `?startapp=` payload prefix a squad invite carries. `squad_<id>` is the whole grammar: the
 * id is the registry's own, so a link lands on exactly one squad and can never be re-pointed by a
 * handle rename.
 */
export const SQUAD_PREFIX = 'squad_';

/** `https://t.me/Tactix_Robot/app?startapp=squad_<id>` — one tap into the squad's join door. */
export function squadAppLink(id: string): string {
  const clean = (id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
  return clean ? botAppLink(`${SQUAD_PREFIX}${clean}`) : '';
}

/** `https://t.me/Tactix_Robot?start=<payload>` — opens the bot chat first. */
export function botStartLink(payload = ''): string {
  const clean = cleanStartPayload(payload);
  return clean ? `https://t.me/${BOT_HANDLE}?start=${clean}` : `https://t.me/${BOT_HANDLE}`;
}

/** `https://t.me/Tactix_Robot?startapp=<payload>` — the main Mini App, one tap, no bot-chat hop. */
export function botMainAppLink(payload = ''): string {
  const clean = cleanStartPayload(payload);
  return clean ? `https://t.me/${BOT_HANDLE}?startapp=${clean}` : `https://t.me/${BOT_HANDLE}`;
}

/** `https://t.me/Tactix_Robot?startchannel=true&admin=...` — the channel-admin enlistment door. */
export function botChannelAdminLink(rights = 'invite_users+pin_messages'): string {
  return `https://t.me/${BOT_HANDLE}?startchannel=true&admin=${rights}`;
}

/** `https://t.me/share/url?url=...&text=...` — Telegram's own share sheet. */
export function telegramShareLink(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

/** A Telegram chat / channel URL from a handle (`@name`, `name`, or a full t.me link). */
export function telegramChatLink(handle: string): string {
  const raw = (handle ?? '').trim();
  const match = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([A-Za-z0-9_]{3,64})/i.exec(raw);
  const name = match?.[1] ?? raw.replace(/^@+/, '');
  return /^[A-Za-z0-9_]{3,64}$/.test(name) ? `https://t.me/${name}` : '';
}

/** The personal referral payload for a code. */
export function referralPayload(code: string): string {
  return `${REFERRAL_PREFIX}${code}`;
}

/** The direct Mini App referral link: `https://t.me/Tactix_Robot/app?startapp=ref_<code>`. */
export function referralAppLink(code: string): string {
  return botAppLink(referralPayload(code));
}

/** The bot-chat referral link: `https://t.me/Tactix_Robot?start=ref_<code>`. */
export function referralStartLink(code: string): string {
  return botStartLink(referralPayload(code));
}
