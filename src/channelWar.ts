/**
 * channelWar.ts — the Channel Wars Hub.
 *
 * One flagship sheet, four zones and no repeats: the prize rule and its clock, the friends-only
 * earning rule, the rankings with the admins' register door, and a single action bar that reads
 * the player's own state. Two sub-views live inside the same panel — the register flow an admin
 * came to enlist through, and the inspector a tap on any channel row opens — because a player who
 * went looking at a channel should never lose the tournament they were looking at it in.
 *
 * Every number here is a real one: the ladder is `getWarRanking()`, the TIQ is what settled
 * Play with Friends matches banked, the Telegram audience is what `getChatMemberCount` answered,
 * and the fighters are the roster's own rows. When nothing has scored yet the board says so
 * instead of inventing a field.
 *
 * Channel TIQ has exactly one source. A bot board, a practice race and a solo duel pay the
 * channel nothing: a machine that cannot lose is not an opponent, and a channel should never be
 * lifted by farming one.
 */
import { lang, onLang, t, type LangCode } from './settings';
import { impact, notify, openLink, openTelegramShare, tgInitData, tgUser } from './telegram';
import { showToast, showToastDetail } from './toast';
import type { Sheets } from './sheets';
import {
  ACTIVE_CUP_ID, cleanHandle, claimRegisteredSquad, displayNameOf, getMySquad, getSquadRanking,
  getWarRanking, handleIssue, hasWarEarnings, joinSquadLocally, myPlayerId, onSquadChange,
  squadAvatarUrl, squadMark, warEndsAt, warPointsOf,
  type RankedSquad, type SquadMember,
} from './squads';
import {
  botAdminInviteUrl, checkChannelMembership, joinSquadOnServer, refreshSquadBoard,
  registerSquadWithTelegram, syncChannelTiq, toSquad, verifySquadOwnership,
} from './squadRegister';
import { workerUrl } from './adminApi';
import { myTiq } from './matchmaking';
import { channelWarAppLink, telegramShareLink } from '../shared/config';
/* The authentic Telegram Stars mark — the same asset the shop and the vault carry, never a
   glyph, a sprite star or a typed emoji. Vite fingerprints it, so the path is never dangling. */
import telegramStarsUrl from './assets/images/telegram_stars.png';

/**
 * The Channel Wars switch. The tournament is PARKED, not deleted: every sheet, endpoint and
 * registry row stays here for a future re-enable, while the poster, the floating shield, the
 * invite link and every enlistment door read this one flag and stay shut.
 */
export const CHANNEL_WARS_ENABLED = false;

/**
 * The document-level projection of that one flag. `html[data-channel-wars]` is what the stylesheet
 * reads to keep the floating shield (and the in-board war strip) out of a parked build; index.html
 * ships the attribute `off`, so the shield can never flash before this runs, and this is the only
 * writer that can ever turn it back on.
 */
export function applyChannelWarsFlag(): void {
  const on = CHANNEL_WARS_ENABLED;
  document.documentElement.dataset.channelWars = on ? 'on' : 'off';
  if (on) return;
  /* A cached or legacy document can still carry the old corner key. Hide it at the source too, so
     a parked build never leaves a dead shield floating over the home hero even if a stylesheet
     hash is stale; the stylesheet rule also covers anything painted after this pass. */
  for (const el of document.querySelectorAll<HTMLElement>('#iv-war, .cw-war, .cw-fab, .cw-war-fab, .home-war-fab, .war-shield-fab, [data-war-shield]')) {
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
    el.style.display = 'none';
  }
}

/** The one line the parked hub says if it is ever reached (a stale link, a cached tap). */
const WARS_OFF_NOTE: Record<LangCode, string> = {
  fa: 'چالش کانال‌ها موقتاً غیرفعال است • به زودی برمی‌گردد',
  en: 'Channel Wars is paused • Back soon',
  ru: 'Channel Wars приостановлен • Скоро вернётся',
  ar: 'تحدي القنوات متوقف مؤقتاً • يعود قريباً',
  es: 'Channel Wars está en pausa • Vuelve pronto',
};

export interface ChannelWarApi {
  sheets: Sheets;
  /** The war queue. `channel_war` is what puts the war identity on the matchmaking stage. */
  queue(mode: 'pvp' | 'arena' | 'channel_war'): void;
  /**
   * The Play with Friends lobby: the one mode that earns Channel TIQ. The hub hands the player
   * straight to it rather than queueing them into a board that would pay their channel nothing.
   */
  openFriends(): void;
}

export interface ChannelWarHub {
  /** Raise the hub. `prefill` seeds the selection (a rally link names a channel). */
  open(prefill?: string): void;
  /** Repaint from the live store — called after a match settles. */
  refresh(): void;
  readonly isOpen: boolean;
}

const LADDER_MAX = 20;
const PICK_MAX = 6;

/* The bounty header's own micro-copy. It lives here, beside the surface that reads it, so the
   Championship card can carry a stronger voice without reaching into the shared dictionary. */
type CwCopyKey = 'eyebrow' | 'unit' | 'sub';
const CW_COPY: Record<LangCode, Record<CwCopyKey, string>> = {
  en: {
    eyebrow: '1ST PLACE BOUNTY',
    unit: 'STARS',
    sub: 'Winner-takes-all · Top 10 squad contributors split the prize',
  },
  fa: {
    eyebrow: 'جایزه قهرمانی',
    unit: 'استارز',
    sub: 'برنده همه را می‌برد · ده مشارکت‌کننده برتر جایزه تیم را تقسیم می‌کنند',
  },
  ru: {
    eyebrow: 'ПРИЗОВОЙ ФОНД',
    unit: 'ЗВЁЗД',
    sub: 'Победитель забирает всё · Топ-10 участников отряда делят приз',
  },
  ar: {
    eyebrow: 'جائزة المركز الأول',
    unit: 'نجوم',
    sub: 'الفائز يأخذ كل شيء · أفضل عشرة مساهمين في الفريق يتقاسمون الجائزة',
  },
  es: {
    eyebrow: 'RECOMPENSA DEL 1.er PUESTO',
    unit: 'ESTRELLAS',
    sub: 'El ganador se lo lleva todo · Los 10 mejores del escuadrón reparten el premio',
  },
};
const AVATAR_HUES = [198, 210, 232, 262, 288, 318, 24, 42, 158, 174];
const SVG_NS = 'http://www.w3.org/2000/svg';

const hash32 = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** Channel TIQ in Latin tabular figures, grouped: `1,450`. A score is a code, not prose. */
const TIQ_FMT = new Intl.NumberFormat('en-US');
const tiqLabel = (n: number): string => TIQ_FMT.format(Math.max(0, Math.floor(n)));

/* ---------- the weekly tournament score ----------
   The ladder prints the TIQ a channel earned **since it entered the running week**, never the
   lifetime balance it brought with it. The server owns the authoritative zero point —
   `baselineTiq` / `tournamentTiq` on the squad view — while this device keeps a matching
   snapshot for any row it paints before the next sync. A channel registered here therefore
   starts at exactly `0` TIQ, and a cached board from an old week can never resurrect a head
   start. */
const BASELINE_KEY = 'detour:channel-war:baselines.v1';

/** The optional weekly fields a squad view may carry (server-owned). */
interface WarScoreFields {
  baselineTiq?: number;
  tournamentTiq?: number;
}

type BaselineBook = Record<string, Record<string, number>>;

let baselineBook: BaselineBook | null = null;

/** Read the snapshot book, tolerating a missing store, private mode or a hand-edited blob. */
function readBaselineBook(): BaselineBook {
  try {
    const raw = window.localStorage.getItem(BASELINE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: BaselineBook = {};
    for (const [season, rows] of Object.entries(parsed as Record<string, unknown>)) {
      if (!season || !rows || typeof rows !== 'object' || Array.isArray(rows)) continue;
      const clean: Record<string, number> = {};
      for (const [id, value] of Object.entries(rows as Record<string, unknown>)) {
        const n = Number(value);
        if (id && Number.isFinite(n) && n >= 0) clean[id] = Math.floor(n);
      }
      out[season] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

function baselines(): BaselineBook {
  if (!baselineBook) baselineBook = readBaselineBook();
  return baselineBook;
}

/** The running week's key: the war clock's own end instant, so the book rolls with the timer. */
function warSeasonKey(): string {
  const end = warEndsAt();
  return Number.isFinite(end) && end > 0 ? `w${Math.floor(end)}` : 'w0';
}

function localBaselineOf(squadId: string): number | null {
  const stored = baselines()[warSeasonKey()]?.[squadId];
  return typeof stored === 'number' && Number.isFinite(stored) && stored >= 0 ? stored : null;
}

/** Remember one channel's zero point for this week, keeping the book to the running week only. */
function noteBaseline(squadId: string, baseline: number): void {
  if (!squadId) return;
  const value = Math.max(0, Math.floor(Number.isFinite(baseline) ? baseline : 0));
  const season = warSeasonKey();
  const book = baselines();
  for (const key of Object.keys(book)) if (key !== season) delete book[key];
  const rows = book[season] ?? (book[season] = {});
  if (rows[squadId] === value) return;
  rows[squadId] = value;
  try {
    window.localStorage.setItem(BASELINE_KEY, JSON.stringify(book));
  } catch { /* a device without writable storage still paints this session */ }
}

/**
 * The number one ladder row is ranked and painted by: tournament TIQ for the running week.
 *
 * The server figure wins whenever it is present. Absent it, the snapshot this device recorded is
 * subtracted from the channel's live total; the first sighting of a channel with neither starts
 * its week at `0` instead of borrowing its lifetime score.
 */
function warScoreOf(s: RankedSquad): number {
  const total = Math.max(0, Math.floor(warPointsOf(s)));
  const fields = s as unknown as WarScoreFields;
  const serverBaseline = Number(fields.baselineTiq);
  const hasBaseline = Number.isFinite(serverBaseline) && serverBaseline >= 0;
  const serverScore = Number(fields.tournamentTiq);
  if (Number.isFinite(serverScore) && serverScore >= 0) {
    const clean = Math.max(0, Math.floor(serverScore));
    if (hasBaseline) {
      noteBaseline(s.id, serverBaseline);
      /* The server figure is authoritative, but a total this device has already moved forward
         (a settled match the board has not re-read yet) must not appear to walk backwards. */
      return Math.min(total, Math.max(clean, total - Math.floor(serverBaseline)));
    }
    return Math.min(total, clean);
  }
  if (hasBaseline) {
    noteBaseline(s.id, serverBaseline);
    return Math.max(0, total - Math.floor(serverBaseline));
  }
  const local = localBaselineOf(s.id);
  if (local !== null) return Math.max(0, total - local);
  noteBaseline(s.id, total);
  return 0;
}

/** One ladder entry: the squad and the place its tournament score earns this week. */
interface WarLadderRow {
  squad: RankedSquad;
  place: number;
}

/** The ladder in tournament order — the score a row prints is the score it is ranked by. */
function warLadder(): WarLadderRow[] {
  return [...getWarRanking()]
    .sort((a, b) =>
      warScoreOf(b) - warScoreOf(a)
      || (a.name || a.handle).localeCompare(b.name || b.handle)
      || a.id.localeCompare(b.id))
    .map((squad, i) => ({ squad, place: i + 1 }));
}

/** The place one channel holds on this week's ladder, or 0 when it is not on it. */
function warPlaceOf(squadId: string): number {
  return squadId ? warLadder().find((row) => row.squad.id === squadId)?.place ?? 0 : 0;
}

/** The war clock, always in Latin figures: a countdown is a code, not a sentence. */
function warClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const mins = Math.floor((total % 3_600) / 60);
  return days > 0 ? `${days}d ${pad(hours)}h` : `${pad(hours)}h ${pad(mins)}m`;
}

const membersLabel = (n: number): string =>
  n <= 0 ? t('cwNoMembers') : n === 1 ? t('cwMemberOne') : t('cwMembers').replace('{n}', String(n));

/**
 * The member count, with every Latin figure isolated in its own LTR run.
 *
 * The count is a code, and the word after it is prose: in Arabic or Persian the sentence runs
 * right-to-left while `4` must still read left-to-right and never swap places with its noun.
 */
function memberRun(n: number): HTMLElement {
  const host = document.createElement('span');
  host.className = 'cw-row-members';
  host.setAttribute('dir', 'auto');
  const text = membersLabel(n);
  let cut = 0;
  for (const found of text.matchAll(/[0-9][0-9,]*/g)) {
    const at = found.index ?? 0;
    if (at > cut) host.append(text.slice(cut, at));
    const num = document.createElement('bdi');
    num.setAttribute('dir', 'ltr');
    num.textContent = found[0];
    host.append(num);
    cut = at + found[0].length;
  }
  if (cut < text.length) host.append(text.slice(cut));
  return host;
}

/** One inline monochrome glyph. Every icon in this sheet is drawn, never typed. */
function icon(id: string, cls = 'ico'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', id);
  svg.append(use);
  return svg;
}

/** The gold check, rendered only for `verified === true` — never for a pending claim. */
function verifiedBadge(cls = 'squad-vbadge'): HTMLElement {
  const badge = document.createElement('span');
  badge.className = cls;
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', t('squadVerifyBadge'));
  badge.title = t('squadVerifyBadge');
  badge.append(icon('#i-check', 'ico'));
  return badge;
}

/** The neutral `Unverified` pill: present on an unproven squad, never a checkmark. */
function unverifiedPill(cls = 'squad-unverified'): HTMLElement {
  const pill = document.createElement('span');
  pill.className = cls;
  pill.textContent = t('squadVerifyUnverifiedPill');
  return pill;
}

/**
 * The unit itself: the TIQ mark and its three letters in one isolated run.
 *
 * `TIQ` is a code, so it never takes the prose's direction and never inherits the digits' — a
 * Latin acronym beside an Arabic number is exactly where a bidi pass would otherwise shuffle.
 */
function tiqUnit(): HTMLElement {
  const unit = document.createElement('span');
  unit.className = 'cw-tiq-u';
  unit.setAttribute('dir', 'ltr');
  const word = document.createElement('span');
  word.className = 'cw-tiq-w';
  word.textContent = t('cwPts');
  unit.append(icon('#i-tiq', 'ico cw-tiq-ico'), word);
  return unit;
}

/**
 * `1,450 TIQ` — the figure, then the unit. `sign` prefixes the amount for a gain or a spend
 * (`+25 TIQ`); every character of the number stays Latin tabular.
 */
function tiqFigure(n: number, opts: { sign?: '+' | '−' | ''; cls?: string } = {}): HTMLElement {
  const host = document.createElement('span');
  host.className = opts.cls ?? 'cw-tiq';
  host.setAttribute('dir', 'ltr');
  const value = document.createElement('b');
  value.className = 'cw-tiq-n';
  value.textContent = `${opts.sign ?? ''}${tiqLabel(n)}`;
  host.append(value, tiqUnit());
  return host;
}

/** A Latin-digit template with its numbers isolated, so RTL prose never reorders them. */
function paintTemplate(host: HTMLElement, template: string, vars: Record<string, string>): void {
  host.textContent = '';
  let cut = 0;
  for (const found of template.matchAll(/\{\w+\}/g)) {
    const at = found.index ?? 0;
    if (at > cut) host.append(template.slice(cut, at));
    const value = vars[found[0].slice(1, -1)];
    if (value !== undefined) {
      const iso = document.createElement('bdi');
      iso.setAttribute('dir', 'auto');
      iso.textContent = value;
      host.append(iso);
    }
    cut = at + found[0].length;
  }
  if (cut < template.length) host.append(template.slice(cut));
}

/**
 * A clipboard write in an unfocused WebView can hang instead of rejecting, and the invite key must
 * never look dead while it waits. Whatever the clipboard does, the player gets an answer.
 */
function copyText(value: string): Promise<boolean> {
  const attempt = (async (): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch { /* fall through to the legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', 'true');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  })();
  return Promise.race([attempt, new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 1200))]);
}

/** Why a typed or pasted reference is not a Telegram username, as a message key. */
const handleErrorKey = (issue: string): string =>
  issue === 'empty' ? 'cwErrEmpty'
    : issue === 'short' ? 'cwErrShort'
      : issue === 'long' ? 'cwErrLong' : 'cwErrChars';

/**
 * The two shapes a Telegram private invite takes: `t.me/+hash` and `t.me/joinchat/hash`.
 *
 * A private channel has no public `@username` and no `t.me/s/` page, so Method 2 can never read
 * it. Catching it here — before the generic "letters and numbers only" refusal — is what lets the
 * founder be told the one thing that helps: use Method 1 for this channel.
 */
const PRIVATE_INVITE = /^(?:\+)|^(?:joinchat\/)/i;
const PRIVATE_LINK = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.(?:me|dog)\/(?:\+|joinchat\/)/i;

function looksPrivateInvite(raw: string): boolean {
  const value = raw.replace(/[\u0000-\u001f\u007f\s]+/g, '');
  return !!value && (PRIVATE_INVITE.test(value) || PRIVATE_LINK.test(value));
}

/* ---------- Method 2: the public-channel proof ----------
   The Channel Wars door is not the Ranks sheet's `#TX-XXXXX` flow, and it must not behave like it:
   a founder opening this pane has typed nothing yet, so a code that waits for a handle is a code
   that renders as a dash. Everything below is built so the pill always holds a real `TIQ-XXXXXX`
   — the device's own deterministic preview first, the Worker's signed code the instant it lands —
   and so the copy key works in a Telegram WebView that refuses `navigator.clipboard`. */

type CwM2Key =
  | 'codeLabel' | 'copied' | 'notFound' | 'private' | 'notPublic' | 'offline' | 'expired'
  | 'publicOnly' | 'checking' | 'registering';

const CW_M2: Record<LangCode, Record<CwM2Key, string>> = {
  en: {
    codeLabel: 'YOUR VERIFY CODE',
    copied: 'Copied ✓',
    notFound: 'Code not found in channel yet. Post the code in your public channel and try again.',
    private: 'Method 2 needs a public channel @username. For a private channel or a group, use Method 1.',
    notPublic: 'That channel was not found or is not public. Method 2 only reads public channels.',
    offline: "Couldn't reach the server. Check your connection and try again.",
    expired: 'That code is no longer valid. Here is a fresh one.',
    publicOnly: 'PUBLIC CHANNEL',
    checking: 'Checking the channel…',
    registering: 'Verifying…',
  },
  fa: {
    codeLabel: 'کد وریفای شما',
    copied: 'کپی شد ✓',
    notFound: 'کد هنوز در کانال پیدا نشد. مطمئن شوید کد را در کانال عمومی ارسال کرده‌اید و دوباره بزنید.',
    private: 'روش دوم فقط برای کانال عمومی با @username است. برای کانال خصوصی و گروه از روش اول استفاده کنید.',
    notPublic: 'این کانال پیدا نشد یا عمومی نیست. روش دوم فقط کانال‌های عمومی را می‌خواند.',
    offline: 'ارتباط با سرور برقرار نشد. اتصال را بررسی کنید و دوباره بزنید.',
    expired: 'این کد دیگر معتبر نیست. کد تازه آماده شد.',
    publicOnly: 'کانال عمومی',
    checking: 'در حال بررسی کانال…',
    registering: 'در حال تایید…',
  },
  ru: {
    codeLabel: 'ВАШ КОД',
    copied: 'Скопировано ✓',
    notFound: 'Код пока не найден в канале. Опубликуйте его в публичном канале и попробуйте снова.',
    private: 'Способ 2 работает только с публичным каналом @username. Для приватного канала или группы используйте способ 1.',
    notPublic: 'Канал не найден или не является публичным. Способ 2 читает только публичные каналы.',
    offline: 'Не удалось связаться с сервером. Проверьте соединение и повторите.',
    expired: 'Этот код больше не действует. Вот новый.',
    publicOnly: 'ПУБЛИЧНЫЙ КАНАЛ',
    checking: 'Проверяем канал…',
    registering: 'Проверяем…',
  },
  ar: {
    codeLabel: 'رمز التحقق الخاص بك',
    copied: 'تم النسخ ✓',
    notFound: 'لم يُعثر على الرمز في القناة بعد. انشر الرمز في قناتك العامة وحاول مرة أخرى.',
    private: 'الطريقة الثانية تحتاج قناة عامة بـ @username. للقناة الخاصة أو المجموعة استخدم الطريقة الأولى.',
    notPublic: 'لم يتم العثور على القناة أو أنها ليست عامة. الطريقة الثانية تقرأ القنوات العامة فقط.',
    offline: 'تعذّر الاتصال بالخادم. تحقّق من الاتصال وحاول مجددًا.',
    expired: 'هذا الرمز لم يعد صالحًا. هذا رمز جديد.',
    publicOnly: 'قناة عامة',
    checking: 'جارٍ فحص القناة…',
    registering: 'جارٍ التحقق…',
  },
  es: {
    codeLabel: 'TU CÓDIGO',
    copied: 'Copiado ✓',
    notFound: 'El código aún no aparece en el canal. Publícalo en tu canal público e inténtalo de nuevo.',
    private: 'El método 2 necesita un canal público @username. Para un canal privado o un grupo, usa el método 1.',
    notPublic: 'Ese canal no existe o no es público. El método 2 solo lee canales públicos.',
    offline: 'No se pudo contactar con el servidor. Revisa tu conexión e inténtalo otra vez.',
    expired: 'Ese código ya no es válido. Aquí tienes uno nuevo.',
    publicOnly: 'CANAL PÚBLICO',
    checking: 'Comprobando el canal…',
    registering: 'Verificando…',
  },
};

const m2 = (key: CwM2Key): string => (CW_M2[lang] ?? CW_M2.en)[key];

/** The code alphabet, identical to the Worker's: `A`–`Z` without `I`/`O`, then `2`–`9`. */
const CW_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CW_CODE_LEN = 6;

/**
 * The device's own code, for the half-second before the Worker answers.
 *
 * Seeded from this player's id and the running UTC day, so the pill holds a stable, unmistakable
 * `TIQ-XXXXXX` from the first frame instead of a dash. It is a *placeholder* and never a proof:
 * only the Worker's HMAC — signed with a secret this bundle cannot hold — is accepted by the
 * channel scan, and the real code replaces this one as soon as it lands.
 */
function previewWarCode(seed: string): string {
  let h = hash32(`${seed}:${Math.floor(Date.now() / 86_400_000)}`);
  let body = '';
  for (let i = 0; i < CW_CODE_LEN; i++) {
    body += CW_CODE_ALPHABET[h % CW_CODE_ALPHABET.length];
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return `TIQ-${body}`;
}

/** What the Worker answers about a channel row, as this sheet reads it. */
interface WarSquadPayload {
  id?: string;
  handle?: string;
  name?: string;
  kind?: 'channel' | 'group';
  avatar?: string;
  tag?: string;
  members?: number;
  subscribers?: number;
  telegramMembers?: number | null;
  creatorId?: string;
  ownerId?: string;
  cupId?: string;
  requireApproval?: boolean;
  verified?: boolean;
  roster?: Array<{
    id?: string; name?: string; tiq?: number; role?: string; joinedAt?: number;
    country?: string; username?: string; photo?: string;
  }>;
}

interface WarCodeWire {
  ok?: boolean;
  code?: string;
  error?: string;
  message?: string;
}

interface WarSquadWire {
  ok?: boolean;
  error?: string;
  message?: string;
  squad?: WarSquadPayload;
}

/** One POST to the Worker, with this Mini App's own identity attached. Never throws. */
async function warPost<T>(
  path: string,
  payload: Record<string, unknown>,
): Promise<{ data: T | null; ok: boolean } | null> {
  const url = workerUrl(path);
  if (!url) return null;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  const initData = tgInitData();
  if (initData) headers['x-telegram-init-data'] = initData;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(payload),
    });
    let data: T | null = null;
    try {
      data = (await response.json()) as T;
    } catch {
      data = null;
    }
    return { data, ok: response.ok };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/** This player's own numbers, in the shape every registry write reads. */
function warPlayerPayload(): Record<string, unknown> {
  const u = tgUser();
  const name = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim().slice(0, 24);
  const photo = (u?.photo_url ?? '').trim().slice(0, 300);
  const tiq = Math.max(0, Math.floor(myTiq()));
  return {
    name,
    username: (u?.username ?? '').slice(0, 32),
    /* The leader's real balance seeds the roster row **and** the week's baseline, so a channel
       that registers today starts the ladder at exactly `0` whatever it brought with it. */
    tiq,
    playerTiq: tiq,
    ...(/^https:\/\/[^\s]+$/i.test(photo) ? { photo } : {}),
    userTelegramId: u?.id === undefined ? '' : String(u.id),
  };
}

/** The Worker's signed `TIQ-XXXXXX` for this player and today, or why it could not be issued. */
async function requestWarCode(handle: string): Promise<{ ok: true; code: string } | { ok: false; message: string }> {
  const id = tgUser()?.id;
  const sent = await warPost<WarCodeWire>('/api/channel-war/code', {
    handle,
    userTelegramId: id === undefined ? '' : String(id),
  });
  if (!sent) return { ok: false, message: m2('offline') };
  const { data, ok } = sent;
  if (!ok || !data || data.ok !== true || typeof data.code !== 'string' || !data.code) {
    const code = typeof data?.error === 'string' ? data.error : '';
    if (code === 'unauthorized') return { ok: false, message: t('squadErrTelegram') };
    if (code === 'bot_token_missing') return { ok: false, message: t('enlistErrToken') };
    return { ok: false, message: m2('offline') };
  }
  return { ok: true, code: data.code.trim().toUpperCase() };
}

/** The one atomic Method 2 call: scan the channel, prove the code, write the verified row. */
async function registerWarChannel(input: {
  handle: string;
  code: string;
  squadId?: string;
  name?: string;
}): Promise<{ ok: true; payload: WarSquadPayload } | { ok: false; error: string; message: string }> {
  const sent = await warPost<WarSquadWire>('/api/channel-war/register', {
    handle: input.handle,
    verifyCode: input.code,
    ...(input.squadId ? { squadId: input.squadId } : {}),
    squadName: input.name ?? '',
    cupId: ACTIVE_CUP_ID,
    ...warPlayerPayload(),
  });
  if (!sent) return { ok: false, error: 'offline', message: m2('offline') };
  const { data, ok } = sent;
  if (ok && data && data.ok === true && data.squad) return { ok: true, payload: data.squad };
  const error = typeof data?.error === 'string' ? data.error : 'failed';
  switch (error) {
    case 'channel_private': return { ok: false, error, message: m2('private') };
    case 'channel_not_public': return { ok: false, error, message: m2('notPublic') };
    case 'POST_CODE_NOT_FOUND': return { ok: false, error, message: m2('notFound') };
    case 'verify_code_expired': return { ok: false, error, message: m2('expired') };
    case 'not_founder': return { ok: false, error, message: t('squadVerifyNotOwner') };
    case 'squad_banned': return { ok: false, error, message: t('squadErrBanned') };
    case 'unauthorized': return { ok: false, error, message: t('squadErrTelegram') };
    default: return { ok: false, error, message: m2('offline') };
  }
}

/**
 * Fold the Worker's answer into this device's own board.
 *
 * The registry already wrote the row, so this is the local half: a channel this device has never
 * seen is claimed and bound; one it already lists gets the registry's roster and badge, and the
 * player is bound to it without a second membership round trip.
 */
function absorbWarSquad(payload: WarSquadPayload): RankedSquad | null {
  const handle = cleanHandle(payload.handle ?? '');
  if (!handle) return null;
  const parsed = toSquad(payload);
  const claimed = claimRegisteredSquad({
    id: payload.id,
    handle,
    name: payload.name ?? handle,
    roster: parsed?.roster,
    members: typeof payload.members === 'number' ? payload.members : 0,
    subscribers: typeof payload.subscribers === 'number' ? payload.subscribers : undefined,
    telegramMembers: payload.telegramMembers,
    kind: payload.kind,
    avatar: payload.avatar,
    tag: payload.tag ?? '',
    ownerId: payload.creatorId ?? payload.ownerId,
    cupId: payload.cupId ?? ACTIVE_CUP_ID,
    requireApproval: payload.requireApproval,
    verified: payload.verified === true,
  });
  if (claimed.ok) return claimed.squad;
  const existing = getSquadRanking().find((s) => s.handle.toLowerCase() === handle.toLowerCase());
  if (!existing) return null;
  const bound = joinSquadLocally(existing.id, parsed?.roster, {
    subscribers: payload.subscribers,
    telegramMembers: payload.telegramMembers,
    ownerId: payload.creatorId ?? payload.ownerId,
    verified: payload.verified === true,
  });
  return bound === 'bad-handle' ? null : getMySquad() ?? existing;
}

/** What a Method 2 attempt answered, in the shape the panel paints. */
type WarVerifyOutcome =
  | { ok: true; squad?: RankedSquad }
  | { ok: false; message: string; expired?: boolean };

interface WarVerifyPanelOptions {
  /** `register` is the admin door's own block; `verify` adds the founder banner. */
  mode: 'register' | 'verify';
  /** Read the handle at tap time, so a field edited after mount is always the one verified. */
  handle: () => string;
  /** The field's own text, before cleaning — so a private invite is named as one, not as a typo. */
  rawHandle?: () => string;
  /** Present when the channel is already on the registry and only its badge is missing. */
  squadId?: string;
  /** Run the one atomic call: scan, prove, write. */
  onSubmit: (code: string) => Promise<WarVerifyOutcome>;
  onVerified?: (squad?: RankedSquad) => void;
  onError?: (message: string) => void;
  onNotice?: (message: string) => void;
}

interface WarVerifyPanel {
  el: HTMLElement;
  /** A field change clears the error; the code itself is player-bound and survives it. */
  handleChanged(): void;
  /** Drop the signed code and mint a fresh one — used when the Worker calls it stale. */
  resetCode(): void;
  /** Warm the code as the pane opens, before Method 2 is unfolded. */
  preload(): void;
}

/**
 * The dual-mode verification block, built for Channel Wars.
 *
 * Method 1 is the Ranks sheet's card, unchanged in look and in meaning. Method 2 is this sheet's
 * own: the code is asked for on mount, painted from the device's preview and swapped for the
 * Worker's signed one as it arrives, copied through whichever clipboard the WebView honours, and
 * proven by reading the channel's public page.
 */
function buildWarVerifyPanel(opts: WarVerifyPanelOptions): WarVerifyPanel {
  const root = document.createElement('section');
  root.className = 'sqv cw-m2';
  const body = document.createElement('div');
  body.className = 'sqv-body';

  let code = '';
  let codeReady = false;
  let fetching = false;
  let busy = false;
  let altOpen = false;
  let copyTimer = 0;
  const buttons: HTMLButtonElement[] = [];

  const button = (cls: string, label: string, run: () => void, withCheck = false): HTMLButtonElement => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = cls;
    if (withCheck) node.append(icon('#i-check', 'ico'));
    const text = document.createElement('span');
    text.textContent = label;
    node.append(text);
    node.addEventListener('click', run);
    buttons.push(node);
    return node;
  };

  const error = document.createElement('p');
  error.className = 'sqv-err';
  error.hidden = true;
  error.setAttribute('role', 'alert');

  const clearError = (): void => {
    error.hidden = true;
    error.textContent = '';
  };
  const showError = (message: string): void => {
    error.textContent = message;
    error.hidden = false;
    opts.onError?.(message);
  };

  const refreshDisabled = (): void => {
    const off = busy || fetching;
    for (const node of buttons) {
      node.disabled = off;
      node.setAttribute('aria-busy', String(off));
    }
  };

  /* ---------- Method 1 — the recommended card, exactly as the Ranks sheet draws it ---------- */

  const card = document.createElement('div');
  card.className = 'sqv-card';
  const cardTitle = document.createElement('b');
  cardTitle.className = 'sqv-title';
  cardTitle.textContent = t('squadVerifyMethod1Title');
  const cardSub = document.createElement('p');
  cardSub.className = 'sqv-sub';
  cardSub.textContent = t('squadVerifyMethod1Sub');
  const addRow = document.createElement('div');
  addRow.className = 'sqv-row';
  addRow.append(
    button('sqv-add', t('squadVerifyAddChannel'), () => openLink(botAdminInviteUrl('channel'))),
    button('sqv-add', t('squadVerifyAddGroup'), () => openLink(botAdminInviteUrl('group'))),
  );
  card.append(cardTitle, cardSub, addRow);
  if (opts.mode === 'verify') {
    card.append(button('sqv-go is-primary', t('squadVerifyBotVerify'), () => { void verifyBot(); }, true));
  }

  /* ---------- Method 2 — the folded alternative ---------- */

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'sqv-toggle cw-method2';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('dir', lang === 'fa' || lang === 'ar' ? 'rtl' : 'ltr');
  const badge = document.createElement('span');
  badge.className = 'cw-method2-icon';
  badge.setAttribute('aria-hidden', 'true');
  badge.append(icon('#i-globe', 'cw-method2-globe'));
  const labelRun = document.createElement('span');
  labelRun.className = 'cw-method2-label';
  /* The method number is a Latin digit and rides its own bdi, so RTL prose never moves it. */
  const methodLabel = t('squadVerifyMethod2Toggle');
  let offset = 0;
  for (const match of methodLabel.matchAll(/[0-9]+/g)) {
    const at = match.index ?? 0;
    if (at > offset) labelRun.append(methodLabel.slice(offset, at));
    const digits = document.createElement('bdi');
    digits.setAttribute('dir', 'ltr');
    digits.textContent = match[0];
    labelRun.append(digits);
    offset = at + match[0].length;
  }
  if (offset < methodLabel.length) labelRun.append(methodLabel.slice(offset));
  toggle.append(badge, labelRun, icon('#i-next', 'cw-method2-chevron'));

  const alt = document.createElement('div');
  alt.className = 'sqv-alt cw-m2-alt';
  alt.hidden = true;

  const hint = document.createElement('p');
  hint.className = 'sqv-hint cw-m2-hint';
  hint.textContent = t('squadVerifyCodeHint');

  const codeLabel = document.createElement('span');
  codeLabel.className = 'cw-m2-label';
  codeLabel.textContent = m2('codeLabel');

  const codeRow = document.createElement('div');
  codeRow.className = 'cw-m2-code-row';
  const codeBox = document.createElement('bdi');
  codeBox.className = 'cw-m2-code';
  codeBox.setAttribute('dir', 'ltr');
  /* The pill opens on the device's own deterministic code, never on a dash: a founder who unfolds
     this block sees a real `TIQ-XXXXXX` in the same frame, and the Worker's signed code replaces
     it silently when it lands. */
  codeBox.textContent = previewWarCode(myPlayerId() || 'anon');

  const copy = button('sqv-copy cw-m2-copy', t('squadVerifyCopyCode'), () => { void copyCode(); });
  const copyLabel = copy.querySelector('span');
  codeRow.append(codeBox, copy);

  const post = button('sqv-go cw-m2-go', t('squadVerifyPostCta'), () => { void verifyPost(); }, true);
  const postLabel = post.querySelector('span');

  alt.append(hint, codeLabel, codeRow, post, error);

  const paintCode = (value: string, signed: boolean): void => {
    codeBox.textContent = value;
    codeBox.classList.toggle('is-preview', !signed);
    codeBox.setAttribute('dir', 'ltr');
  };

  /**
   * The signed code, fetched once per mount.
   *
   * Never blocks the paint and never clears the pill: the preview stays on screen for the whole
   * round trip, so there is no frame in which this box is empty or reads as a dash. Concurrent
   * callers — the preload the pane opens with, the unfold, a tap on Verify — share one request
   * and all wait for it, so a fast tap can never read "not ready" while the answer is in flight.
   */
  let inflight: Promise<void> | null = null;

  async function ensureCode(silent = false): Promise<string> {
    if (codeReady && code) return code;
    if (inflight) {
      await inflight;
      return code;
    }
    inflight = (async () => {
      fetching = true;
      refreshDisabled();
      let result: { ok: true; code: string } | { ok: false; message: string };
      try {
        result = await requestWarCode(opts.handle().trim());
      } catch {
        result = { ok: false, message: m2('offline') };
      }
      fetching = false;
      refreshDisabled();
      if (!result.ok) {
        if (!silent) showError(result.message);
        return;
      }
      code = result.code;
      codeReady = true;
      paintCode(code, true);
      clearError();
    })();
    await inflight;
    inflight = null;
    return code;
  }

  /** `کپی شد ✓` for two seconds, then back to the key's own label. */
  function flashCopied(): void {
    if (!copyLabel) return;
    copyLabel.textContent = m2('copied');
    copy.classList.add('is-copied');
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copyLabel.textContent = t('squadVerifyCopyCode');
      copy.classList.remove('is-copied');
    }, 2_000);
  }

  async function copyCode(): Promise<void> {
    const value = (await ensureCode()).trim();
    if (!value) return;
    const copied = await copyText(value);
    if (!copied) {
      showError(t('linkCopyFailed'));
      return;
    }
    /* The spec's one haptic, through the same door every other success in this sheet uses. */
    notify('success');
    flashCopied();
    /* A copied preview is still a placeholder: say so rather than let the founder post a code the
       Worker will refuse. The pill keeps showing it, because an empty box is worse. */
    if (!codeReady) showError(m2('offline'));
  }

  async function verifyPost(): Promise<void> {
    if (busy) return;
    if (looksPrivateInvite(opts.rawHandle?.() ?? '')) {
      showError(m2('private'));
      return;
    }
    const handle = opts.handle().trim();
    if (!handle) {
      showError(t('enlistErrHandle'));
      return;
    }
    clearError();
    busy = true;
    refreshDisabled();
    if (postLabel) postLabel.textContent = m2('registering');
    const signed = await ensureCode();
    if (!codeReady) {
      busy = false;
      refreshDisabled();
      if (postLabel) postLabel.textContent = t('squadVerifyPostCta');
      showError(m2('offline'));
      return;
    }
    let result: WarVerifyOutcome;
    try {
      result = await opts.onSubmit(signed.trim());
    } catch {
      result = { ok: false, message: m2('offline') };
    }
    busy = false;
    refreshDisabled();
    if (postLabel) postLabel.textContent = t('squadVerifyPostCta');
    if (!result.ok) {
      if (result.expired) resetCode();
      showError(result.message);
      return;
    }
    opts.onNotice?.(t('squadVerifyDonePost'));
    opts.onVerified?.(result.squad);
  }

  async function verifyBot(): Promise<void> {
    if (busy) return;
    const handle = opts.handle().trim();
    if (!handle) {
      showError(t('enlistErrHandle'));
      return;
    }
    clearError();
    busy = true;
    refreshDisabled();
    const result = await verifySquadOwnership({ squadId: opts.squadId, handle, method: 'bot' });
    busy = false;
    refreshDisabled();
    if (!result.ok) {
      showError(result.message || t('enlistErrBot'));
      return;
    }
    opts.onNotice?.(t('squadVerifyDone'));
    if (result.squad) opts.onVerified?.(result.squad);
  }

  function resetCode(): void {
    code = '';
    codeReady = false;
    refreshDisabled();
    paintCode(previewWarCode(myPlayerId() || 'anon'), false);
    if (altOpen && !body.hidden) void ensureCode();
  }

  toggle.addEventListener('click', () => {
    altOpen = alt.hidden;
    alt.hidden = !altOpen;
    toggle.setAttribute('aria-expanded', String(altOpen));
    clearError();
    if (altOpen) void ensureCode();
  });

  /* In `verify` mode the block starts folded behind its founder banner; in `register` mode the
     form itself is the stage, so both methods are already visible. */
  if (opts.mode === 'verify') {
    const banner = document.createElement('button');
    banner.type = 'button';
    banner.className = 'sqv-banner';
    banner.append(icon('#i-check', 'ico'));
    const text = document.createElement('span');
    text.textContent = t('squadVerifyFounderCta');
    banner.append(text);
    banner.setAttribute('aria-expanded', 'false');
    body.hidden = true;
    banner.addEventListener('click', () => {
      body.hidden = !body.hidden;
      banner.setAttribute('aria-expanded', String(!body.hidden));
      if (!body.hidden) void ensureCode();
    });
    root.append(banner);
  }

  body.append(card, toggle, alt);
  root.append(body);
  refreshDisabled();

  return {
    el: root,
    handleChanged(): void {
      clearError();
      /* The code is bound to the player and the day, not to the handle: a field edit must not
         throw away a code the founder has already copied. */
      if (altOpen && !body.hidden && !codeReady) void ensureCode(true);
    },
    resetCode,
    preload(): void {
      void ensureCode(true);
    },
  };
}

/** Which pane of the sheet is on screen. */
type WarView = 'hub' | 'register' | 'detail';

export function createChannelWarHub(api: ChannelWarApi): ChannelWarHub {
  const root = document.getElementById('channel-war-modal');
  const mainView = document.getElementById('cw-main');
  const regView = document.getElementById('cw-register');
  const detailView = document.getElementById('cw-detail');
  const clock = document.getElementById('cw-countdown');
  const prizeRule = document.getElementById('cw-prize-rule');
  const boardList = document.getElementById('cw-board-list');
  const liveRegion = document.getElementById('cw-live-region');

  /* The Championship mark is the real Telegram Stars asset. The markup carries the element so the
     card never renders without its emblem, and this hands it the bundled URL — Vite's hashed
     path, never the raw `./src/...` string, so a built bundle can't ship a dangling reference. */
  root?.querySelectorAll<HTMLImageElement>('img.cw-star-ico').forEach((img) => {
    img.src = telegramStarsUrl;
  });

  const regOpen = document.getElementById('cw-reg-open');
  const regBack = document.getElementById('cw-reg-back');
  const regHandle = document.getElementById('cw-reg-handle') as HTMLInputElement | null;
  const regName = document.getElementById('cw-reg-name') as HTMLInputElement | null;
  const regErr = document.getElementById('cw-reg-err');
  const regGo = document.getElementById('cw-reg-go') as HTMLButtonElement | null;
  const regDone = document.getElementById('cw-reg-done');
  const regLink = document.getElementById('cw-reg-link');
  const regCopy = document.getElementById('cw-reg-copy');
  const regVerifyHost = document.getElementById('cw-reg-verify');
  const regSkip = document.getElementById('cw-reg-skip') as HTMLButtonElement | null;
  /** The dual-mode verification block mounted in the register view. */
  let regVerifyPanel: WarVerifyPanel | null = null;

  const pick = document.getElementById('cw-pick');
  const pickList = document.getElementById('cw-pick-list');
  const pickX = document.getElementById('cw-pick-x');

  const verify = document.getElementById('cw-verify');
  const verifyHandle = document.getElementById('cw-verify-h');
  const verifyOpen = document.getElementById('cw-verify-open');
  const verifyOpenT = document.getElementById('cw-verify-open-t');
  const verifyAgain = document.getElementById('cw-verify-again');

  const joinBtn = document.getElementById('cw-join') as HTMLButtonElement | null;
  const joinT = document.getElementById('cw-join-t');
  const inviteBtn = document.getElementById('cw-invite');

  /* the inspector */
  const detailBack = document.getElementById('cw-detail-back');
  const detailClose = document.getElementById('cw-detail-close');
  const detailBody = detailView?.querySelector<HTMLElement>('.cw-detail-body') ?? null;
  const detailAv = document.getElementById('cw-detail-av');
  const detailImg = document.getElementById('cw-detail-img') as HTMLImageElement | null;
  const detailMark = document.getElementById('cw-detail-mark');
  const detailName = document.getElementById('cw-detail-name');
  const detailHandle = document.getElementById('cw-detail-handle');
  const detailRank = document.getElementById('cw-detail-rank');
  const detailTiq = document.getElementById('cw-detail-tiq');
  const detailMembers = document.getElementById('cw-detail-members');
  const detailFightersN = document.getElementById('cw-detail-fighters-n');
  const detailList = document.getElementById('cw-detail-list');
  const detailNote = document.getElementById('cw-detail-note');
  const detailInvite = document.getElementById('cw-detail-invite');
  const detailPlay = document.getElementById('cw-detail-play');
  const detailPlayT = document.getElementById('cw-detail-play-t');
  const detailJoin = document.getElementById('cw-detail-join');
  const detailJoinT = document.getElementById('cw-detail-join-t');

  /** The squad chosen but not yet enrolled — a selection, never a membership. */
  let picked = '';
  /** The handle whose membership gate is open, or '' when there is nothing to ask. */
  let awaiting = '';
  /** A rally link that named a channel this device has not seen yet. */
  let rallyHandle = '';
  /** The channel the inspector is showing, or '' when it is closed. */
  let detailId = '';
  let view: WarView = 'hub';
  let joining = false;
  let checking = false;
  let registering = false;
  let boardRequest: Promise<void> | null = null;

  const isOpen = (): boolean => !!root && !root.hidden;
  /* A name spoken aloud rides the same bdi wrap as names on the board: RTL prose must not
     reorder a Latin channel title or handle that lands in the reader's ear. */
  const say = (text: string): void => {
    if (!liveRegion) return;
    const iso = document.createElement('bdi');
    iso.setAttribute('dir', 'auto');
    iso.textContent = text;
    liveRegion.textContent = '';
    liveRegion.append(iso);
  };

  const squadById = (id: string): RankedSquad | undefined => getSquadRanking().find((s) => s.id === id);
  /** The inspected channel, read through the war ladder so its rank and total are the board's own. */
  const detailSquad = (): RankedSquad | undefined =>
    detailId ? getWarRanking().find((s) => s.id === detailId) : undefined;

  /* ---------- painting ---------- */

  /** The crest: Telegram's public photo when it answers, the call sign when it does not. */
  function paintAvatar(img: HTMLImageElement | null, mark: HTMLElement | null, host: HTMLElement | null, s: RankedSquad): void {
    host?.style.setProperty('--cw-hue', String(AVATAR_HUES[hash32(s.handle) % AVATAR_HUES.length]));
    if (mark) mark.textContent = squadMark(s);
    const url = squadAvatarUrl(s);
    if (!img) return;
    if (!url) { img.hidden = true; img.removeAttribute('src'); return; }
    img.hidden = false;
    img.onerror = () => { img.hidden = true; };
    img.src = url;
  }

  /**
   * One ladder row: a collision-proof two-tier card — a leading cluster (rank crest, avatar, the
   * two-line identity) that owns every spare pixel, and a trailing cluster (the stacked Channel
   * TIQ readout and the door in) that never shrinks. Because the identity can truncate at every
   * level, the `YOUR TEAM` pill can never collide with the score on a narrow phone.
   *
   * In an RTL locale the flex row lays these out right-to-left, while `<bdi dir="auto">` keeps
   * every dynamic name and title bidi-contained — no mixed-script word gets chewed up mid-clip.
   *
   * `inspectable` makes the whole row a pointer target and gives it a real chevron key, so a
   * keyboard reaches the same place a thumb does. `selectable` turns the row into a choice in the
   * quick pick.
   */
  function buildRow(
    s: RankedSquad,
    opts: { you: boolean; selectable: boolean; inspectable?: boolean; place: number },
  ): HTMLLIElement {
    const tiq = warScoreOf(s);
    const scored = tiq > 0;
    const place = opts.place;
    const li = document.createElement('li');
    li.className = `cw-row${opts.you ? ' is-you' : ''}${scored && place === 1 ? ' is-lead' : ''}${picked === s.id ? ' is-selected' : ''}`;

    /* The leading cluster: everything that identifies the channel, in one shrinkable run. */
    const lead = document.createElement('span');
    lead.className = 'cw-row-lead';

    const rank = document.createElement('bdi');
    rank.className = `cw-rank${scored ? (place <= 3 ? ` is-${place}` : '') : ' is-none'}`;
    rank.setAttribute('dir', 'ltr');
    /* A channel nobody has scored for this week has no place to defend yet: it reads as a dash,
       never #4 — and a freshly enrolled channel starts exactly there, at 0 TIQ. */
    rank.textContent = scored ? `#${place}` : '—';

    const av = document.createElement('span');
    av.className = 'cw-av';
    const img = document.createElement('img');
    img.className = 'cw-av-img';
    img.alt = '';
    img.hidden = true;
    img.decoding = 'async';
    const mark = document.createElement('b');
    mark.className = 'cw-av-t';
    mark.setAttribute('aria-hidden', 'true');
    av.append(img, mark);
    paintAvatar(img, mark, av, s);

    const id = document.createElement('span');
    id.className = 'cw-row-id';

    /* Line 1 — the full-width title. Its own <bdi> isolates a mixed Persian/Latin name so the
       ellipsis lands cleanly at the end of the whole title instead of inside a Persian word. */
    const title = document.createElement('bdi');
    title.className = 'cw-row-title';
    title.setAttribute('dir', 'auto');
    title.textContent = s.name || displayNameOf(s.handle);
    const nameLine = document.createElement('span');
    nameLine.className = 'cw-row-nameline';
    nameLine.append(title);
    if (s.verified === true) nameLine.append(verifiedBadge('squad-vbadge cw-vbadge'));

    /* Line 2 — the clean metadata: the audience count, then the one tag that matters. No handle
       and no orphaned separator dot: the title owns line one and the inspector owns the handle. */
    const meta = document.createElement('span');
    meta.className = 'cw-row-meta';
    meta.append(memberRun(s.members));

    if (opts.you) {
      const pill = document.createElement('span');
      pill.className = 'cw-pill cw-you-pill';
      pill.textContent = t('cwYourTeam');
      meta.append(pill);
    } else if (opts.selectable) {
      /* The choice key rides the metadata line so the score column stays one clean readout. */
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cw-sel';
      btn.textContent = t('cwSelect');
      btn.dataset.select = s.id;
      btn.setAttribute('aria-pressed', String(picked === s.id));
      btn.setAttribute('aria-label', `${t('cwSelect')} ${s.name || s.handle}`);
      meta.append(btn);
    }
    id.append(nameLine, meta);
    lead.append(rank, av, id);

    /* The trailing cluster: a stacked readout — the figure over its unit — then the door in. */
    const side = document.createElement('span');
    side.className = 'cw-row-side';
    const score = document.createElement('span');
    score.className = `cw-row-score${scored ? '' : ' is-zero'}`;
    const value = document.createElement('bdi');
    value.className = 'cw-row-score-n';
    value.setAttribute('dir', 'ltr');
    value.textContent = tiqLabel(tiq);
    const unit = document.createElement('span');
    unit.className = 'cw-row-score-u';
    unit.setAttribute('dir', 'ltr');
    unit.textContent = t('cwPts');
    score.append(value, unit);
    side.append(score);

    if (opts.inspectable) {
      li.dataset.detail = s.id;
      li.classList.add('is-inspectable');
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'cw-row-go';
      go.dataset.detail = s.id;
      /* The key names its destination, not the row's contents: a screen reader already read those. */
      go.setAttribute('aria-label', t('cwOpenChannel').replace('{h}', s.handle));
      go.append(icon('#i-chevron-right', 'ico cw-row-go-ico'));
      side.append(go);
    }

    li.append(lead, side);
    return li;
  }

  function emptyRow(key: string): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'cw-empty';
    li.append(icon('#i-crown', 'ico'));
    const text = document.createElement('span');
    text.textContent = t(key);
    li.append(text);
    return li;
  }

  function paintBoard(): void {
    if (!boardList) return;
    const board = warLadder();
    const mine = getMySquad();
    /* Switching is only free while the channel has nothing to lose: a team that has actually
       fought is a team. The total itself is the roster's real TIQ sum, so the test reads the
       banked war column instead of locking every channel that merely has members. */
    const canSelect = !mine || !hasWarEarnings(mine);
    boardList.textContent = '';
    if (!board.length) {
      boardList.append(emptyRow('cwEmptyBoard'));
      return;
    }
    for (const { squad: s, place } of board.slice(0, LADDER_MAX)) {
      const you = !!mine && s.id === mine.id;
      boardList.append(buildRow(s, { you, selectable: canSelect && !you, inspectable: true, place }));
    }
    revealMyRow();
  }

  /**
   * Bring the player's own place under their thumb. It only works on a laid-out list, so the hub
   * calls it again once the sheet has actually opened — measuring a hidden panel scrolls nowhere.
   */
  function revealMyRow(): void {
    if (!boardList) return;
    const row = boardList.querySelector<HTMLElement>('.cw-row.is-you');
    if (!row || !boardList.clientHeight) return;
    boardList.scrollTop = Math.max(0, row.offsetTop - boardList.clientHeight / 2 + row.clientHeight / 2);
  }

  function paintPrize(): void {
    /* The header speaks in the tournament's own voice: a gold eyebrow, the crown's figure, and
       the winner-takes-all rule. The figure is its own `<bdi dir="ltr">` run so `200` never
       flips inside a Persian sentence, and every label follows the active language. */
    const copy = CW_COPY[lang] ?? CW_COPY.en;
    if (prizeRule) {
      prizeRule.textContent = '';
      const figure = document.createElement('bdi');
      figure.setAttribute('dir', 'ltr');
      figure.textContent = '200';
      const unit = document.createElement('span');
      unit.className = 'cw-prize-unit';
      unit.setAttribute('dir', 'auto');
      unit.textContent = copy.unit;
      prizeRule.append(figure, unit);
    }
    root?.querySelectorAll<HTMLElement>('[data-cw-copy]').forEach((node) => {
      const key = node.dataset.cwCopy as CwCopyKey | undefined;
      if (key) node.textContent = copy[key];
    });
  }

  function paintVerify(): void {
    if (!verify) return;
    verify.hidden = !awaiting;
    if (!awaiting) return;
    if (verifyHandle) verifyHandle.textContent = awaiting;
    if (verifyOpenT) paintTemplate(verifyOpenT, t('cwOpenChannel'), { h: awaiting });
  }

  /**
   * The one action bar. An enrolled fighter is not shown a queue key: the only board that pays
   * their channel is a Play with Friends room, so that is the door the key opens.
   */
  function paintCta(): void {
    if (!joinBtn || !joinT) return;
    const mine = getMySquad();
    const switching = !!picked && picked !== mine?.id;
    const playing = !!mine && !switching;
    joinT.textContent = t(playing ? 'cwPlayFriends' : 'cwJoinWar');
    const ready = playing || !!picked;
    joinBtn.setAttribute('aria-disabled', String(!ready));
    joinBtn.setAttribute('aria-busy', String(joining || checking));
    joinBtn.querySelector('use')?.setAttribute('href', playing ? '#i-users' : '#i-user-join');
    if (inviteBtn) inviteBtn.hidden = !playing;
  }

  function paint(): void {
    if (!root) return;
    if (clock) clock.textContent = warClock(warEndsAt() - Date.now());
    paintPrize();
    paintBoard();
    paintVerify();
    paintCta();
    if (pick && !pick.hidden) paintPick();
    if (view === 'detail') paintDetail();
  }

  function paintView(): void {
    if (mainView) mainView.hidden = view !== 'hub';
    if (regView) regView.hidden = view !== 'register';
    if (detailView) detailView.hidden = view !== 'detail';
  }

  /* ---------- the inspector ---------- */

  /** One fighter's row: place, face, name, and the real TIQ balance the channel total sums. */
  function buildFighter(m: SquadMember, place: number): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'cw-fighter';

    const rank = document.createElement('span');
    /* The pill always carries the place; the colour stays a prize: muted neutral when the fighter
       holds no TIQ, gold/silver/bronze when they do. */
    const balance = Math.max(0, Math.floor(m.tiq || 0));
    const scored = balance > 0;
    rank.className = `cw-fighter-rank${place <= 3 && scored ? ` is-${place}` : ''}`;
    rank.setAttribute('dir', 'ltr');
    rank.textContent = `#${place}`;

    const av = document.createElement('span');
    av.className = 'cw-fighter-av';
    av.style.setProperty('--cw-hue', String(AVATAR_HUES[hash32(m.id) % AVATAR_HUES.length]));
    const mark = document.createElement('b');
    mark.className = 'cw-fighter-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = (m.name || '?').trim().charAt(0).toUpperCase() || '?';
    av.append(mark);
    const photo = (m.photo ?? '').trim();
    if (/^https:\/\/[^\s]+$/i.test(photo)) {
      const img = document.createElement('img');
      img.className = 'cw-fighter-img';
      img.alt = '';
      img.decoding = 'async';
      img.onerror = () => { img.remove(); };
      img.src = photo;
      av.append(img);
    }

    const name = document.createElement('b');
    name.className = 'cw-fighter-name';
    const bdi = document.createElement('bdi');
    bdi.setAttribute('dir', 'auto');
    bdi.textContent = m.name || t('cwNoName');
    name.append(bdi);

    /* The balance itself, never a `+0` contribution delta: the card's label already says TIQ. */
    const tiq = document.createElement('b');
    tiq.className = 'cw-fighter-tiq';
    tiq.append(tiqFigure(balance));

    li.append(rank, av, name, tiq);
    return li;
  }

  function paintDetailFighters(s: RankedSquad): void {
    if (!detailList) return;
    const rows = [...s.roster].sort((a, b) =>
      Math.max(0, Math.floor(b.tiq || 0)) - Math.max(0, Math.floor(a.tiq || 0))
      || a.id.localeCompare(b.id));
    detailList.textContent = '';
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'cw-empty';
      li.append(icon('#i-users', 'ico'));
      const text = document.createElement('span');
      text.textContent = t('cwEmptyFighters');
      li.append(text);
      detailList.append(li);
      return;
    }
    rows.forEach((m, i) => detailList.append(buildFighter(m, i + 1)));
  }

  /**
   * The contextual foot. Your own channel invites and plays; a channel you could still join
   * offers the join; a channel you are already locked out of says why, once, instead of showing a
   * key that would refuse the tap.
   */
  function paintDetailActions(s: RankedSquad): void {
    const mine = getMySquad();
    const isMine = !!mine && mine.id === s.id;
    const canJoin = !isMine && (!mine || !hasWarEarnings(mine));
    const locked = !isMine && !canJoin;
    if (detailInvite) detailInvite.hidden = !isMine;
    if (detailPlay) detailPlay.hidden = !isMine;
    if (detailJoin) detailJoin.hidden = !canJoin;
    if (detailNote) {
      detailNote.hidden = !locked;
      detailNote.textContent = locked ? t('cwSwitchLocked') : '';
    }
    if (detailPlayT) detailPlayT.textContent = t('cwPlayFriends');
    if (detailJoinT) detailJoinT.textContent = t('cwJoinThis');
    detailJoin?.setAttribute('aria-busy', String(joining || checking));
  }

  function paintDetail(): void {
    const s = detailSquad();
    /* The channel left the registry under the inspector: the pane it belonged to is gone, so the
       sheet goes back to the ladder it came from rather than standing on an empty room. */
    if (!s) {
      if (detailId) { detailId = ''; view = 'hub'; paintView(); paint(); }
      return;
    }
    const place = warPlaceOf(s.id);
    paintAvatar(detailImg, detailMark, detailAv, s);
    if (detailName) detailName.textContent = s.name || displayNameOf(s.handle);
    if (detailHandle) detailHandle.textContent = s.handle;
    /* The strict gate lives beside the handle: a check only for a proven squad, and a quiet
       unverified pill otherwise. Rebuilt on every paint so it can never outlive a revoke. */
    const heroSub = detailHandle?.parentElement;
    if (heroSub) {
      heroSub.querySelectorAll('.squad-vbadge, .squad-unverified').forEach((node) => node.remove());
      heroSub.append(s.verified === true
        ? verifiedBadge('squad-vbadge cw-vbadge')
        : unverifiedPill('squad-unverified cw-unverified'));
    }
    const tiq = warScoreOf(s);
    if (detailRank) {
      const scored = tiq > 0;
      detailRank.className = `cw-hero-rank${scored ? (place <= 3 ? ` is-${place}` : '') : ' is-none'}`;
      /* `#1` is a code and reads LTR everywhere; the word for "no place yet" is prose and takes
         whatever direction the locale is already running in. */
      detailRank.setAttribute('dir', scored ? 'ltr' : 'auto');
      detailRank.textContent = scored ? `#${place}` : t('cwUnranked');
    }
    /* The metric in its own plain figure — the plate's label already says what the number is. */
    if (detailTiq) detailTiq.textContent = tiqLabel(tiq);
    /* Telegram's own audience. `null` is "the bot never got an answer" — a dash, never a zero. */
    if (detailMembers) {
      const audience = s.telegramMembers;
      detailMembers.textContent = typeof audience === 'number' && Number.isFinite(audience) && audience >= 0
        ? TIQ_FMT.format(Math.floor(audience))
        : '—';
      detailMembers.classList.toggle('is-unknown', typeof audience !== 'number');
    }
    if (detailFightersN) {
      const fighters = typeof s.botFightersCount === 'number' && Number.isFinite(s.botFightersCount)
        ? s.botFightersCount : s.members;
      detailFightersN.textContent = TIQ_FMT.format(Math.max(0, Math.floor(fighters)));
    }
    paintDetailFighters(s);
    paintDetailActions(s);

    /* The founder of an unverified channel gets the same dual-mode door as the drawer. Any
       other viewer, and every verified squad, sees no verification controls at all. */
    document.getElementById('cw-detail-verify')?.remove();
    const viewerId = myPlayerId();
    const isFounder = !!viewerId && (s.ownerId ?? '') === viewerId;
    if (s.verified !== true && isFounder && detailBody) {
      const host = document.createElement('section');
      host.id = 'cw-detail-verify';
      host.className = 'cw-verifybox';
      const fighters = detailBody.querySelector('.cw-fighters');
      detailBody.insertBefore(host, fighters ?? null);
      const panel = buildWarVerifyPanel({
        mode: 'verify',
        handle: () => s.handle,
        squadId: s.id,
        onSubmit: async (code) => {
          const result = await registerWarChannel({ handle: s.handle, code, squadId: s.id });
          if (!result.ok) return { ok: false, message: result.message, expired: result.error === 'verify_code_expired' };
          return { ok: true, squad: absorbWarSquad(result.payload) ?? undefined };
        },
        onVerified: () => {
          notify('success');
          showToast(t('squadVerifyDone'), 'success');
          void refreshSquadBoard().then(() => { if (isOpen()) paint(); });
        },
        onError: (message) => {
          notify('warning');
          showToast(message, 'warning');
        },
        onNotice: (message) => {
          notify('success');
          showToast(message, 'success');
        },
      });
      host.append(panel.el);
    }
  }

  function openDetail(id: string): void {
    if (!id || !detailView) return;
    detailId = id;
    view = 'detail';
    impact('light');
    closePick();
    paintDetail();
    paintView();
    if (detailBody) detailBody.scrollTop = 0;
    const s = detailSquad();
    say(s ? `${s.name || s.handle}` : t('cwDetailTitle'));
  }

  function closeDetail(): void {
    detailId = '';
    view = 'hub';
    paintView();
    paint();
    requestAnimationFrame(revealMyRow);
  }

  /**
   * Hand the player to the one mode that pays their channel.
   *
   * The hub closes first: the friends lobby is its own sheet, and two sheets stacked would leave
   * the drawer opening behind the tournament it was launched from.
   */
  function playFriends(): void {
    impact('heavy');
    api.sheets.close();
    api.openFriends();
  }

  /* ---------- the quick pick ---------- */

  function paintPick(): void {
    if (!pickList) return;
    const mine = getMySquad();
    const rows = warLadder().filter(({ squad }) => squad.id !== mine?.id).slice(0, PICK_MAX);
    pickList.textContent = '';
    if (!rows.length) { pickList.append(emptyRow('cwEmptyBoard')); return; }
    for (const { squad: s, place } of rows) {
      const li = buildRow(s, { you: false, selectable: true, place });
      li.dataset.select = s.id;
      pickList.append(li);
    }
  }

  function openPick(): void {
    if (!pick) return;
    paintPick();
    pick.hidden = false;
    boardList?.closest('.cw-board')?.classList.add('is-picking');
    impact('light');
  }

  function closePick(): void {
    if (pick) pick.hidden = true;
    boardList?.closest('.cw-board')?.classList.remove('is-picking');
  }

  function choose(id: string): void {
    if (!id) return;
    picked = id;
    awaiting = '';
    impact('light');
    closePick();
    paint();
    say(t('cwSelected'));
  }

  /* ---------- enrolment: the membership gate, then the roster ---------- */

  function welcome(s: RankedSquad): void {
    picked = '';
    awaiting = '';
    impact('medium');
    notify('success');
    paint();
    say(t('cwJoined'));
    showToastDetail(t('cwJoinedTitle'), `${s.name || displayNameOf(s.handle)} · ${s.handle}`, 'success');
  }

  async function enrol(squad: RankedSquad): Promise<void> {
    if (getMySquad()?.id === squad.id) { picked = ''; awaiting = ''; paint(); return; }
    joining = true;
    paintCta();
    const result = await joinSquadOnServer(squad.id);
    joining = false;
    if (!result.ok) {
      paintCta();
      notify('warning');
      showToast(result.message || t('cwJoinFailed'), 'warning');
      return;
    }
    if (result.pending) {
      picked = '';
      paint();
      notify('success');
      showToast(t('cwJoinPending'), 'success');
      say(t('cwJoinPending'));
      return;
    }
    welcome(result.squad ?? squad);
  }

  /**
   * Prove the player is inside the chat before putting them on its roster. A refusal is not an
   * error: it is the inline prompt above the CTA, with the channel's own door and a retry.
   */
  async function gate(squad: RankedSquad): Promise<void> {
    checking = true;
    paintCta();
    const verdict = await checkChannelMembership(squad.handle);
    checking = false;
    if (!verdict.isMember) {
      awaiting = squad.handle;
      paint();
      notify('warning');
      impact('light');
      say(t('cwVerifyLead'));
      return;
    }
    awaiting = '';
    await enrol(squad);
  }

  async function onJoin(): Promise<void> {
    if (joining || checking) return;
    const mine = getMySquad();
    const switching = !!picked && picked !== mine?.id;
    /* Enrolled and staying: the key is the friends lobby, not a queue. */
    if (mine && !switching) { playFriends(); return; }
    if (!picked) { openPick(); return; }
    const squad = squadById(picked);
    if (!squad) { picked = ''; paint(); return; }
    await gate(squad);
  }

  /**
   * Join the channel the inspector is showing. The gate runs exactly as it does from the hub —
   * a tap on this key is not a shortcut past the membership proof — and the sheet returns to the
   * ladder either way: a success lands the player's new team in the action bar, and a refusal
   * lands on the membership card, which is the one place that prompt lives.
   */
  async function joinFromDetail(): Promise<void> {
    const squad = detailSquad();
    if (!squad || joining || checking) return;
    picked = squad.id;
    await gate(squad);
    closeDetail();
  }

  /* ---------- the admin door ---------- */

  function setRegError(key: string): void {
    if (!regErr) return;
    regErr.textContent = key ? t(key) : '';
    regErr.hidden = !key;
  }

  function setRegErrorText(text: string): void {
    if (!regErr) return;
    regErr.textContent = text;
    regErr.hidden = !text;
  }

  function setRegBusy(on: boolean): void {
    if (regGo) {
      regGo.setAttribute('aria-busy', String(on));
      regGo.setAttribute('aria-disabled', String(on));
      const label = regGo.querySelector('b');
      if (label) label.textContent = t(on ? 'squadVerifyBusy' : 'squadVerifyBotCta');
    }
    if (regSkip) {
      regSkip.disabled = on;
      regSkip.setAttribute('aria-busy', String(on));
    }
    if (regHandle) regHandle.disabled = on;
    if (regName) regName.disabled = on;
  }

  /**
   * Mount the dual-mode verification block inside the admin door.
   *
   * The block is this sheet's own, not the Ranks sheet's: Method 2 here has to hold a real code
   * from the first frame, copy it through a WebView clipboard, and prove it against the channel's
   * public page. Method 1 stays the shared card, word for word and key for key.
   */
  function mountRegVerifyPanel(): void {
    if (!regVerifyHost) return;
    regVerifyHost.textContent = '';
    regVerifyPanel = buildWarVerifyPanel({
      mode: 'register',
      handle: () => cleanHandle(regHandle?.value ?? ''),
      rawHandle: () => regHandle?.value ?? '',
      onSubmit: (code) => submitPostRegister(code),
      onError: (message) => setRegErrorText(message),
      onNotice: (message) => {
        notify('success');
        showToast(message, 'success');
      },
    });
    regVerifyHost.append(regVerifyPanel.el);
    /* The code is asked for as the pane opens, not when the founder unfolds Method 2: by the time
       they read the hint, the signed `TIQ-XXXXXX` is already the one in the pill. */
    regVerifyPanel.preload();
  }

  function showInviteCard(handle: string): void {
    const link = channelWarAppLink(handle);
    if (regLink) regLink.textContent = link;
    if (regDone) regDone.hidden = !link;
  }

  function openRegister(prefill = ''): void {
    if (!CHANNEL_WARS_ENABLED) {
      showToast(WARS_OFF_NOTE[lang] ?? WARS_OFF_NOTE.en);
      return;
    }
    view = 'register';
    setRegError('');
    if (regDone) regDone.hidden = true;
    if (regLink) regLink.textContent = '';
    if (regHandle) regHandle.value = prefill;
    if (regName) regName.value = '';
    setRegBusy(false);
    mountRegVerifyPanel();
    paintView();
    requestAnimationFrame(() => regHandle?.focus({ preventScroll: true }));
  }

  function closeRegister(): void {
    view = 'hub';
    paintView();
    paint();
    requestAnimationFrame(revealMyRow);
  }

  /**
   * The registry already holds this chat. That is not a refusal — the admin wanted the channel in
   * the war and it is already in it — so the device joins the squad that exists instead.
   */
  async function adoptRegistered(handle: string): Promise<void> {
    await refreshSquadBoard();
    const known = getSquadRanking().find((s) => s.handle.toLowerCase() === handle.toLowerCase());
    if (!known) { setRegError('enlistErrAlready'); notify('warning'); return; }
    const result = await joinSquadOnServer(known.id);
    if (!result.ok) { setRegErrorText(result.message || t('cwJoinFailed')); notify('warning'); return; }
    welcome(result.squad ?? known);
    showInviteCard(handle);
  }

  async function submitRegister(method: 'bot' | 'none' = 'bot'): Promise<void> {
    if (registering) return;
    const issue = handleIssue(regHandle?.value ?? '');
    if (issue) {
      setRegError(handleErrorKey(issue));
      notify('warning');
      impact('light');
      regHandle?.focus();
      return;
    }
    const handle = cleanHandle(regHandle?.value ?? '');
    setRegError('');
    registering = true;
    setRegBusy(true);
    const result = await registerSquadWithTelegram(handle, {
      name: (regName?.value ?? '').trim().slice(0, 32),
      tag: '',
    }, undefined, { method });
    registering = false;
    setRegBusy(false);
    if (!result.ok) {
      if (result.error === 'already_registered') { await adoptRegistered(handle); return; }
      /* A verification refusal keeps the admin on this pane: the handle, the identity and the
         Method 1 / Method 2 cards are all still there to finish the job. */
      if (result.error === 'verify_code_expired') regVerifyPanel?.resetCode();
      setRegErrorText(result.message || t('cwJoinFailed'));
      notify('warning');
      return;
    }
    if (!result.squad) { setRegError('enlistErrAlready'); notify('warning'); return; }
    /* This device just enrolled the channel: snapshot its opening balance so an optimistic row
       starts at exactly `0` TIQ before the next server sync replaces the figure. */
    noteBaseline(result.squad.id, warPointsOf(result.squad));
    /* A verified enlistment already proved the player's admin seat, so the membership gate is
       answered; an unverified one is a normal registration that earns its badge later. */
    const verified = result.squad.verified === true;
    welcome(result.squad);
    showInviteCard(result.squad.handle);
    notify('success');
    if (verified) showToast(t('squadVerifyDone'), 'success');
  }

  /**
   * Method 2's one round trip: the Worker scans the public channel, finds the code, and writes the
   * verified row before it answers. This half folds that answer into the device and returns the
   * admin to the ladder the channel now stands on — at `0` TIQ, with its badge already earned.
   */
  async function submitPostRegister(code: string): Promise<WarVerifyOutcome> {
    if (registering) return { ok: false, message: t('squadVerifyBusy') };
    /* A private invite is refused with its own sentence, before the generic character check can
       turn it into "letters and numbers only" — which would tell the founder nothing. */
    if (looksPrivateInvite(regHandle?.value ?? '')) {
      const message = m2('private');
      setRegErrorText(message);
      notify('warning');
      regHandle?.focus();
      return { ok: false, message };
    }
    const issue = handleIssue(regHandle?.value ?? '');
    if (issue) {
      const message = t(handleErrorKey(issue));
      setRegError(handleErrorKey(issue));
      notify('warning');
      regHandle?.focus();
      return { ok: false, message };
    }
    const handle = cleanHandle(regHandle?.value ?? '');
    setRegError('');
    registering = true;
    setRegBusy(true);
    const result = await registerWarChannel({
      handle,
      code,
      name: (regName?.value ?? '').trim().slice(0, 32),
    });
    registering = false;
    setRegBusy(false);
    if (!result.ok) {
      setRegErrorText(result.message);
      notify('warning');
      return { ok: false, message: result.message, expired: result.error === 'verify_code_expired' };
    }
    const squad = absorbWarSquad(result.payload);
    if (!squad) {
      /* The registry took the channel but this device could not place it on its own board: the
         next board refresh will, so the admin is told to look rather than shown a false refusal. */
      void refreshSquadBoard().then(() => { if (isOpen()) paint(); });
      notify('success');
      showToast(t('squadVerifyDonePost'), 'success');
      closeRegister();
      return { ok: true };
    }
    noteBaseline(squad.id, warPointsOf(squad));
    notify('success');
    welcome(squad);
    closeRegister();
    return { ok: true, squad };
  }

  /* ---------- the invite link ---------- */

  function rally(): void {
    const mine = getMySquad();
    if (!mine) return;
    const url = channelWarAppLink(mine.handle);
    if (!url) { notify('warning'); showToast(t('cwRallyFailed'), 'warning'); return; }
    impact('medium');
    /* Inside Telegram the native picker is the whole action; the copy rides along as a convenience
       and never holds the share hostage. */
    if (typeof window.Telegram?.WebApp?.openTelegramLink === 'function') {
      void copyText(url);
      openTelegramShare(telegramShareLink(url, t('cwRallyShare').replace('{channel}', mine.name || mine.handle)));
      return;
    }
    void copyText(url).then((copied) => {
      notify(copied ? 'success' : 'warning');
      showToastDetail(
        copied ? t('cwInviteCopied') : t('cwRallyLink'),
        copied ? t('cwRallyCopiedBody') : url,
        copied ? 'success' : 'warning',
        5200,
      );
    });
  }

  /* ---------- the board behind the paint ---------- */

  function warmBoard(): void {
    if (boardRequest) return;
    /* The player's own balance is saved first: the board that comes back sums real TIQ, and the
       total for their channel must already include the number this device is holding. */
    boardRequest = syncChannelTiq()
      .then(() => refreshSquadBoard())
      .then(() => {
        if (!isOpen()) return;
        /* A rally link that named a channel this device had never seen becomes the selection the
           moment the registry names it. */
        if (rallyHandle) {
          const hit = getSquadRanking().find((s) => s.handle.toLowerCase() === rallyHandle.toLowerCase());
          if (hit) picked = hit.id;
          rallyHandle = '';
        }
        paint();
      })
      .catch(() => { /* the device's own board still paints */ })
      .finally(() => { boardRequest = null; });
  }

  const hub: ChannelWarHub = {
    open(prefill = '') {
      if (!CHANNEL_WARS_ENABLED) {
        /* Parked: every door that used to raise the hub says so once and stays shut. */
        notify('warning');
        showToast(WARS_OFF_NOTE[lang] ?? WARS_OFF_NOTE.en);
        return;
      }
      if (!root) { api.openFriends(); return; }
      const handle = prefill ? cleanHandle(prefill) : '';
      const known = handle
        ? getSquadRanking().find((s) => s.handle.toLowerCase() === handle.toLowerCase())
        : undefined;
      view = 'hub';
      detailId = '';
      picked = known?.id ?? '';
      awaiting = '';
      rallyHandle = known ? '' : handle;
      joining = false;
      checking = false;
      closePick();
      setRegError('');
      paintView();
      paint();
      api.sheets.open(root);
      requestAnimationFrame(revealMyRow);
      warmBoard();
      say(t('cwTitle'));
    },
    refresh() { if (isOpen()) paint(); },
    get isOpen() { return isOpen(); },
  };

  /* One clock for the life of the page: it only spends a tick while the hub is on screen. */
  window.setInterval(() => {
    if (!isOpen() || document.hidden || !clock) return;
    clock.textContent = warClock(warEndsAt() - Date.now());
  }, 1000);

  /* A rotation or a Telegram viewport change resizes the ladder, so the player's own place has to
     be brought back under their thumb rather than left wherever the old height put it. */
  window.addEventListener('resize', () => { if (isOpen()) revealMyRow(); });

  joinBtn?.addEventListener('click', () => { void onJoin(); });
  inviteBtn?.addEventListener('click', () => { rally(); });

  regOpen?.addEventListener('click', () => { impact('light'); openRegister(); });
  regBack?.addEventListener('click', () => { impact('light'); closeRegister(); });
  regGo?.addEventListener('click', () => { void submitRegister('bot'); });
  regSkip?.addEventListener('click', () => { void submitRegister('none'); });
  regHandle?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void submitRegister('bot');
  });
  regHandle?.addEventListener('input', () => {
    if (regErr && !regErr.hidden) setRegError('');
    regVerifyPanel?.handleChanged();
  });
  regCopy?.addEventListener('click', () => {
    const link = regLink?.textContent ?? '';
    if (!link) return;
    impact('medium');
    void copyText(link).then((copied) => {
      notify(copied ? 'success' : 'warning');
      showToastDetail(
        copied ? t('cwInviteCopied') : t('cwRallyLink'),
        copied ? t('cwRallyCopiedBody') : link,
        copied ? 'success' : 'warning',
        5200,
      );
    });
  });

  verifyOpen?.addEventListener('click', () => {
    if (!awaiting) return;
    impact('light');
    openLink(`https://t.me/${awaiting.replace(/^@+/, '')}`);
  });
  verifyAgain?.addEventListener('click', () => {
    const squad = squadById(picked);
    if (!squad || checking) return;
    void gate(squad);
  });

  detailBack?.addEventListener('click', () => { impact('light'); closeDetail(); });
  detailClose?.addEventListener('click', () => { impact('light'); closeDetail(); });
  detailPlay?.addEventListener('click', () => { playFriends(); });
  detailInvite?.addEventListener('click', () => { rally(); });
  detailJoin?.addEventListener('click', () => { void joinFromDetail(); });

  /* The ladder answers two taps: the inline Select key picks a squad, anywhere else on the row
     opens its inspector. The chevron is the same door for a keyboard. */
  boardList?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const sel = target?.closest<HTMLElement>('[data-select]');
    if (sel) { choose(sel.dataset.select ?? ''); return; }
    const row = target?.closest<HTMLElement>('[data-detail]');
    if (row?.dataset.detail) openDetail(row.dataset.detail);
  });
  /* The quick pick has one verb: a tap anywhere on a row is that row's selection. */
  pickList?.addEventListener('click', (event) => {
    const hit = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-select]');
    const id = hit?.dataset.select ?? '';
    if (id) choose(id);
  });
  pickX?.addEventListener('click', () => { impact('light'); closePick(); });

  /* A rally link is a prompt, not an enrolment: it raises the hub with the channel already
     selected, and the Join key is still the only thing that puts a player on a roster. */
  window.addEventListener('detour:channel-war-invite', (event) => {
    if (!CHANNEL_WARS_ENABLED) return;
    const handle = (event as CustomEvent<{ handle?: string }>).detail?.handle ?? '';
    if (handle) hub.open(handle);
  });

  onSquadChange(() => { if (isOpen()) paint(); });
  /* One repaint covers every pane: `paint()` re-reads the ladder and, when the inspector is the
     pane on screen, its hero, plates and roster too. The register view's verification cards are
     built from the dictionary, so a language flip remounts them. */
  onLang(() => {
    if (!isOpen()) return;
    if (view === 'register') mountRegVerifyPanel();
    paint();
  });

  return hub;
}
