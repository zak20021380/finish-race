/**
 * storage.ts — the app's save: who you are, where you are from, your team, coins, what you own, what
 * you are wearing, and how you have played.
 *
 * One module owns the schema and the only door to the device. Every read and write is wrapped,
 * because a Telegram webview can refuse storage outright (private mode, cookies off) and the race
 * still has to run: a save is a convenience, never a requirement.
 *
 * The save is owned, not merely stored: its key is namespaced by the Telegram account and the blob
 * names that account in `ownerTgId`, because one device can host several Telegram logins that all
 * share this origin.
 *
 * Swapping in Telegram CloudStorage means replacing `backend` with an async get/set and handing the
 * fetched text to `hydrate()` when it lands — `readJson`/`writeJson` below are the whole contract
 * either side has to honour, and `profile` stays the single live object either way.
 */
import type { Difficulty } from './bot';
import type { Mode } from './settings';
import { CLASSIC_BALL, CLASSIC_BOARD, CLASSIC_WALL, known, themeOf, type CosKind, type PieceColor, type Theme } from './themes';
import { knownCountry } from './countries';
import {
  addMember, cleanCode, cleanName, dropMember, inTeam, makeTeam, seedTeams, YOU, type Team,
} from './teams';
import { REFERRAL_CODE_RE, REFERRAL_REWARD as SHARED_REFERRAL_REWARD } from '../shared/config';

/* ---------- the door ---------- */

export interface Backend {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const backend: Backend = {
  get: (k) => { try { return window.localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* stay in memory */ } },
};

function drop(key: string) {
  try { window.localStorage.removeItem(key); } catch { /* stay in memory */ }
}

/* ---------- whose save is this? ----------
 * A Telegram webview shares one `localStorage` origin across every account logged into the device.
 * The save therefore has to be namespaced by the account Telegram just announced, and the blob has
 * to name its owner, or account B boots on account A's coins, TIQ and VIP record.
 *
 * The id is read synchronously at module evaluation: the SDK script is loaded before this module,
 * so `initDataUnsafe.user` is already populated here. `initData` is the fallback for a client that
 * does not expose the unsafe copy; both spellings carry the signed user id.
 */
const BASE_SAVE_KEY = 'detour.save.v2';
/** The account this device last ran a save for. Device-scoped on purpose: it names the owner of
 *  the pre-namespacing blob, never a save itself. */
const LAST_UID_KEY = 'tactix_last_tg_uid';

function telegramUserId(): string {
  try {
    const app = window.Telegram?.WebApp;
    const direct = app?.initDataUnsafe?.user?.id;
    if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return String(Math.trunc(direct));
    if (typeof direct === 'string' && /^\d{1,20}$/.test(direct)) return direct;

    const raw = app?.initData;
    if (raw) {
      const user = new URLSearchParams(raw).get('user');
      const id = user ? (JSON.parse(user) as { id?: unknown }).id : undefined;
      if (typeof id === 'number' && Number.isFinite(id) && id > 0) return String(Math.trunc(id));
      if (typeof id === 'string' && /^\d{1,20}$/.test(id)) return id;
    }
  } catch { /* no SDK, or a malformed initData */ }
  return '';
}

/**
 * The signed launch payload. The SDK script is loaded in ordinary browser tabs as well, so its
 * presence alone does not mean "inside Telegram"; non-empty `initData` does.
 */
const hasLaunchPayload = (): boolean => {
  try { return !!window.Telegram?.WebApp?.initData; } catch { return false; }
};

/**
 * The account every scoped key belongs to. A plain browser tab falls back to `guest`; a Telegram
 * client that cannot name its user gets its own bucket rather than sharing the browser's.
 */
export const activeTgId: string = telegramUserId() || (hasLaunchPayload() ? 'tg_unknown' : 'guest');

/** The per-account spelling of any storage key, localStorage or sessionStorage. */
export const userScopedKey = (base: string): string => `${base}_u_${activeTgId}`;
const scopedFor = (base: string, uid: string): string => `${base}_u_${uid}`;

/* ---------- the device's own guest seat ----------
 * A browser tab has no signed Telegram account, so the Worker seats it as a guest under whatever
 * id the client names. A random id per launch made every reload mint a new directory row — the
 * duplicate "users" the Command Center showed. The id is therefore minted once, kept on the
 * device, and reused for every later launch. A signed session still outranks it: the Worker keys
 * a Telegram account `tg-<user id>`, and this id then only tags the device.
 */
const GUEST_ID_KEY = 'tactix_guest_id';
const GUEST_ID_RE = /^guest-[0-9a-f]{8,32}$/;

function persistGuestId(id: string): string {
  backend.set(GUEST_ID_KEY, id);
  return id;
}

/** The stored guest id, or a freshly minted one that is written before it is handed out. */
function persistentGuestId(): string {
  const stored = backend.get(GUEST_ID_KEY)?.trim().toLowerCase() ?? '';
  if (GUEST_ID_RE.test(stored)) return stored;
  const bytes = new Uint8Array(8);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    /* a webview without a CSPRNG still needs a stable seat: the clock is unique enough here */
    return persistGuestId(`guest-${Date.now().toString(16).padStart(16, '0')}`);
  }
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return persistGuestId(`guest-${hex}`);
}

/** The persistent guest seat this device queues under; never regenerated once stored. */
export const guestId: string = persistentGuestId();

/** A well-formed account id: Telegram's numeric id, or one of the two local buckets. */
const cleanUid = (value: string): string =>
  /^\d{1,20}$/.test(value) || value === 'guest' || value === 'tg_unknown' ? value : '';

/**
 * The id the previous launch recorded, read before this boot overwrites the marker. It is what
 * decides whether an un-namespaced legacy blob may be adopted by the account opening now.
 */
const previousTgId = cleanUid(backend.get(LAST_UID_KEY) ?? '');

/**
 * True when the SDK now names an account other than the one this module keyed its save to. A
 * transient missing id is not a change; only a definite different user is. The boot layer uses
 * this to rebuild the whole storage scope rather than run the newcomer on the old in-memory save.
 */
export function accountChanged(): boolean {
  const live = telegramUserId();
  return live !== '' && live !== activeTgId;
}

/** Raw device read. Anything that belongs to a player must use `userScopedKey`/`adoptUserStorageKey`. */
export function readJson<T>(key: string): Partial<T> | null {
  try {
    const raw = backend.get(key);
    return raw ? (JSON.parse(raw) as Partial<T>) : null;
  } catch {
    return null;
  }
}

/** Raw device write, the pair to `readJson`; player-owned caches must pass a scoped key. */
export function writeJson(key: string, value: unknown) {
  backend.set(key, JSON.stringify(value));
}

/**
 * Adopt an un-namespaced auxiliary cache (squads, inbox, award claims, recovery budget) into the
 * active account's slot, then remove the global key. The move follows the save's evidence rule:
 * only the device's LAST account may inherit it; a newcomer files it under that account instead,
 * so cache from a previous account can never appear under the one opening now.
 */
export function adoptUserStorageKey(base: string): string {
  const key = userScopedKey(base);
  const legacyRaw = backend.get(base);
  if (legacyRaw === null) return key;
  if (backend.get(key) === null) {
    if (previousTgId === '' || previousTgId === activeTgId) {
      backend.set(key, legacyRaw);
    } else {
      const previousKey = scopedFor(base, previousTgId);
      if (backend.get(previousKey) === null) backend.set(previousKey, legacyRaw);
    }
  }
  drop(base);
  return key;
}

/* ---------- the operator's own read state ---------- */

/**
 * The moment this device's admin last opened the Command Center. `admin.ts` stamps it on the tap
 * that opens the stage and never rewrites it on close, so a cleared counter stays cleared: only a
 * row whose id the read set does not hold can raise it again. Stored as a bare epoch-ms scalar
 * (not JSON) and read back through a floor, so a half-written value can only ever mean "never
 * opened", which counts every pending row rather than hiding one.
 */
const ADMIN_VIEWED_KEY = 'detour.admin.viewed.v1';

/** 0 means this device has never opened the panel. */
export function adminViewedAt(): number {
  const raw = backend.get(ADMIN_VIEWED_KEY);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Move the watermark and hand the stamp back, so the caller never re-reads the key it wrote. */
export function markAdminViewed(at: number = Date.now()): number {
  const stamp = Number.isFinite(at) && at > 0 ? Math.floor(at) : Date.now();
  backend.set(ADMIN_VIEWED_KEY, String(stamp));
  return stamp;
}

/* ---------- the friend's room, held across first-time onboarding ---------- */

/**
 * The invite a brand-new player landed on, parked for the length of the language gate and the
 * lesson. Session storage is the right shelf for it: the promise belongs to this tab's launch,
 * not to the save. A webview that refuses sessionStorage still gets the same behaviour from the
 * in-memory copy underneath, so the redirect after the lesson never depends on storage at all.
 */
const PENDING_DUEL_KEY = userScopedKey('pendingDuelRoom');
let pendingDuelMemory = '';
const isDuelRoomCode = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}$/.test(value.trim());

/** Park the room code an invite named. An invalid code is ignored, never stored. */
export function rememberPendingDuelRoom(code: string): void {
  const clean = (code ?? '').trim();
  if (!/^\d{4}$/.test(clean)) return;
  pendingDuelMemory = clean;
  try { window.sessionStorage.setItem(PENDING_DUEL_KEY, clean); } catch { /* stay in memory */ }
}

/** The pending code without consuming it: boot asks before the lesson has ended. */
export function peekPendingDuelRoom(): string {
  try {
    const raw = window.sessionStorage.getItem(PENDING_DUEL_KEY);
    if (isDuelRoomCode(raw)) return raw.trim();
  } catch { /* stay in memory */ }
  return pendingDuelMemory;
}

/** Read the pending code once and forget it: the lesson has ended and is handing over. */
export function takePendingDuelRoom(): string {
  const code = peekPendingDuelRoom();
  pendingDuelMemory = '';
  if (!code) return '';
  try { window.sessionStorage.removeItem(PENDING_DUEL_KEY); } catch { /* stay in memory */ }
  return code;
}

/* ---------- the schema ---------- */

const KEY = userScopedKey(BASE_SAVE_KEY);
const V = 2;

export const KINDS: CosKind[] = ['ball', 'wall', 'board'];

export interface Stats {
  games: number;
  wins: number;
  losses: number;
  /** current win streak, and the best one ever reached */
  streak: number;
  best: number;
  /**
   * The live-PvP run: only wins whose seat still held its defense count, and a low-integrity
   * win breaks it exactly like a loss. Churchill's Bastion reads the high-water mark.
   */
  pvpStreak: number;
  pvpBest: number;
  /**
   * The PUBLIC career: strictly human-vs-human. A board the machine filled — a solo practice race,
   * a friends room backfilled with bots — never touches these four, so the competitive profile
   * cannot be inflated by farming the AI. `pvpRun` is the pure consecutive-win run (no defense
   * gate); the defense-gated `pvpBest` above stays the honor's own instrument.
   */
  pvpGames: number;
  pvpWins: number;
  pvpRun: number;
  pvpRunBest: number;
  modes: Partial<Record<Mode, number>>;
  /**
   * Machine-held boards, counted apart from the lifetime tally. A bot race is still a race that
   * happened, so `games`/`wins` record it — but the rating must never move on one, so
   * `ladderTally()` subtracts these two before `tiqFrom` reads the counters. Forward-only: a save
   * written before this pair existed starts at 0, which leaves its rating exactly as it was.
   */
  botGames: number;
  botWins: number;
}

/**
 * The referral / invite-to-earn record. The Worker's ledger is the authority: `code` is the
 * player's permanent server-owned code, and `earned` is the lifetime total the client has already
 * folded into the unclaimed pool. `joins` and `unclaimed` are what the Hub paints.
 */
export interface ReferralState {
  joins: number;
  unclaimed: number;
  /** Total coins the server has credited this player, already reflected in `unclaimed`. */
  earned: number;
  /** The server-created permanent code, cached so the link paints before the next read. */
  code: string | null;
  /** Legacy local-welcome fields: kept so older saves migrate without losing the blob. */
  welcome: boolean;
  via: string | null;
}

/** A server-confirmed edition, cached so the shelf can speak without the Worker. */
export interface EditionClaim {
  serial: number;
  cap: number;
  mintedAt: string;
}

/** The last global supply reading: the counts every locked card counts down. */
export interface EditionSupply {
  cap: number;
  minted: number;
  remaining: number;
}

export interface EditionsCache {
  claims: Record<string, EditionClaim>;
  supply: Record<string, EditionSupply>;
  /** Epoch ms of the last successful supply read; 0 means this device has never synced. */
  syncedAt: number;
}

export interface Save {
  v: number;
  /**
   * The Telegram account this blob belongs to, stored so a copied or mis-filed save can be
   * rejected on its own evidence rather than trusted because of where it was found.
   */
  ownerTgId: string | number;
  coins: number;
  owned: Record<CosKind, string[]>;
  equipped: Record<CosKind, string>;
  stats: Stats;
  /** ISO 3166-1 alpha-2, or null until the player picks one in Profile */
  country: string | null;
  /** Player-declared age, or null until set. Derived from `dob` once the birthdate is locked. */
  age: number | null;
  /** The locked birthdate as ISO `YYYY-MM-DD`, or null until confirmed once. Permanent: never cleared. */
  dob: string | null;
  /** One-time completion rewards: each flips to true the first time the field is set. */
  rewards: { country: boolean; age: boolean };
  teamId: string | null;
  /** every team this device knows about: the seeded clubs plus any you created or joined */
  teams: Team[];
  /** Equipped profile badge id (see badges.ts), or null until the player equips one. */
  badge: string | null;
  /** Tactile avatar frame id (default | auric | neon), persisted for the hero frame slot. */
  frame: string | null;
  /**
   * The player's chosen display name, or null to follow the Telegram profile
   * (first + last name, then @username, then "Player"). 3-16 characters when set.
   */
  displayName: string | null;
  /**
   * TIQ the player has been granted outside a race (Admin Command Center, future
   * events). Added on top of the ladder's own formula — `myTiq()` in matchmaking.ts.
   */
  tiqBonus: number;
  /**
   * Experience banked from settled races. A bot board pays only a win, at its difficulty's tier
   * (15 / 30 / 50); every bot loss, draw and forfeit pays zero. Human boards pay by the room.
   * Kept apart from `tiqBonus` so experience can never be mistaken for rating.
   */
  xp: number;
  /** Referral engine: invited friends, claimable referral coins, welcome-bonus state. */
  referral: ReferralState;
  /** Server-minted badge serials and the last live supply snapshot. */
  editions: EditionsCache;
  /**
   * The first-match coach marks. False until the player finishes or skips them; it rides the save
   * so a cleared race history is not the only thing that brings the tutorial back.
   */
  tutorialCompleted: boolean;
  /**
   * The player has explicitly chosen their language through the first-boot picker (or Settings).
   * False until a tap stamps it; once true it is permanent — no cloud hydrate, match exit or
   * Telegram `language_code` re-read may reopen the gate or overwrite the chosen locale.
   */
  langChosen: boolean;
  /**
   * The one-time "First Duel Welcome Bonus" (+200 coins) has been paid. A debut loss is the
   * likeliest churn moment, so the cushion is credited once on the first settled race, win or
   * lose, and never again — a late cloud hydrate must not make it payable twice.
   */
  firstDuelBonusClaimed: boolean;
  /**
   * The FTUE "guaranteed first-match victory" has been consumed. False on a fresh install and on
   * a profile that has only ever played the standalone scripted lesson; it flips to true the
   * instant the first match the onboarding controller governed settles (`recordGame`'s own flush).
   * Once true, every later race uses standard matchmaking and standard bot difficulty — the assist
   * is strictly one-shot and can never be re-armed by a stale cloud hydrate.
   */
  firstMatchWon: boolean;
  /**
   * The colour this screen paints its own pieces in. Local presentation only: the opponent takes
   * the opposite family on this device, and the rules never read this field.
   */
  pieceColor: PieceColor;
}

/** The three starter items are owned before the first race; the wallet starts stocked for the demo. */
const STARTERS: Record<CosKind, string> = { ball: CLASSIC_BALL.id, wall: CLASSIC_WALL.id, board: CLASSIC_BOARD.id };
export const START_COINS = 1850;
/** The edited display name's window; the Telegram fallback is shown whole. */
export const DISPLAY_NAME_MIN = 3;
export const DISPLAY_NAME_MAX = 16;
/** Completion reward paid once per identity field (country, age). */
export const IDENTITY_REWARD = 100;
export const AGE_MIN = 7;
export const AGE_MAX = 99;
/** The birthdate picker's earliest year; the latest year is derived from AGE_MIN, measured today. */
export const DOB_MIN_YEAR = 1940;
/** What one invited friend pays: the inviter banks it as unclaimed, the friend gets it on join. */
export const REFERRAL_REWARD = SHARED_REFERRAL_REWARD;
/** Legacy name for the same reward; kept so older code reads the shared constant. */
export const REFERRAL_WELCOME = SHARED_REFERRAL_REWARD;

function fresh(): Save {
  return {
    v: V,
    ownerTgId: activeTgId,
    coins: START_COINS,
    owned: { ball: [STARTERS.ball], wall: [STARTERS.wall], board: [STARTERS.board] },
    equipped: { ...STARTERS },
    stats: {
      games: 0, wins: 0, losses: 0, streak: 0, best: 0,
      pvpStreak: 0, pvpBest: 0, pvpGames: 0, pvpWins: 0, pvpRun: 0, pvpRunBest: 0,
      modes: {},
      botGames: 0, botWins: 0,
    },
    country: null,
    age: null,
    dob: null,
    rewards: { country: false, age: false },
    teamId: null,
    teams: seedTeams(),
    badge: null,
    frame: null,
    displayName: null,
    tiqBonus: 0,
    xp: 0,
    referral: { joins: 0, unclaimed: 0, earned: 0, code: null, welcome: false, via: null },
    editions: { claims: {}, supply: {}, syncedAt: 0 },
    tutorialCompleted: false,
    langChosen: false,
    firstDuelBonusClaimed: false,
    firstMatchWon: false,
    pieceColor: 'red',
  };
}

const whole = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const text = (s: unknown, max: number): s is string => typeof s === 'string' && s.length > 0 && s.length <= max;

const memberOk = (m: unknown): boolean => {
  const x = m as Partial<Team['members'][number]> | undefined;
  return !!x && text(x.id, 24) && text(x.name, 24) && whole(x.wins) && whole(x.games) && x.wins >= 0 && x.games >= x.wins;
};

/** A hand-edited or half-written team is dropped, never trusted: every field has to hold. */
function teamOk(t: unknown): t is Team {
  const x = t as Partial<Team> | undefined;
  return !!x && text(x.id, 40) && text(x.name, 20) && /^[A-Z0-9]{5}$/.test(x.code ?? '')
    && text(x.startParam, 40) && (x.chatId === null || text(x.chatId, 32))
    && typeof x.seed === 'boolean' && Array.isArray(x.members) && x.members.length > 0
    && x.members.length <= 64 && x.members.every(memberOk);
}

/* ---------- the birthdate: one calendar, validated once, then locked for good ---------- */

export interface Dob { y: number; m: number; d: number }

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const pad2 = (n: number) => String(n).padStart(2, '0');
const isoDob = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;

export const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** How many days a month has, February answering to the leap-year rule. */
export function daysInMonth(y: number, m: number): number {
  return m === 2 && isLeap(y) ? 29 : MONTH_DAYS[m - 1] ?? 0;
}

/**
 * The latest selectable birth year. It is AGE_MIN + 1 back from today, so every day of that year
 * still clears the age floor — 2026 gives 2018, which lets a late-2018 birthday stay 7 today.
 */
export function dobMaxYear(now: Date = new Date()): number {
  return now.getFullYear() - AGE_MIN - 1;
}

/** Age on `now` from a birthdate, counting the birthday itself as the step. */
export function ageFromDob(y: number, m: number, d: number, now: Date = new Date()): number {
  let a = now.getFullYear() - y;
  const md = now.getMonth() + 1 - m;
  if (md < 0 || (md === 0 && now.getDate() < d)) a--;
  return a;
}

/** A date the picker and the migration both accept: real calendar day, year window, age window. */
export function validDob(y: number, m: number, d: number, now: Date = new Date()): boolean {
  if (!whole(y) || !whole(m) || !whole(d)) return false;
  y = Math.floor(y); m = Math.floor(m); d = Math.floor(d);
  if (y < DOB_MIN_YEAR || y > dobMaxYear(now)) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > daysInMonth(y, m)) return false;
  const age = ageFromDob(y, m, d, now);
  return age >= AGE_MIN && age <= AGE_MAX;
}

function parseDob(raw: unknown): Dob | null {
  if (typeof raw !== 'string') return null;
  const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!mt) return null;
  const y = Number(mt[1]); const m = Number(mt[2]); const d = Number(mt[3]);
  return validDob(y, m, d) ? { y, m, d } : null;
}

/** The account a blob names, or '' for one written before saves carried an owner. */
function saveOwner(blob: Partial<Save> | null): string {
  const owner = blob?.ownerTgId;
  return owner === undefined || owner === null ? '' : String(owner);
}

/** Only the active account's blob (or an ownerless legacy one) may be folded into the live save. */
function ownedByActive(blob: Partial<Save> | null): boolean {
  const owner = saveOwner(blob);
  return owner === '' || owner === activeTgId;
}

/**
 * Anything that is not a recognised version starts clean; a v2 blob is folded field by field so a
 * half-written or hand-edited save can never smuggle an unknown item into `owned`. A blob that
 * names another Telegram account is rejected outright — no field of it is merged.
 */
function migrate(raw: Partial<Save> | null): Save {
  const s = fresh();
  if (!raw || raw.v !== V || !ownedByActive(raw)) return s;

  if (whole(raw.coins)) s.coins = Math.max(0, Math.floor(raw.coins));
  for (const k of KINDS) {
    const own = raw.owned?.[k];
    if (Array.isArray(own)) {
      s.owned[k] = [...new Set([STARTERS[k], ...own.filter((id) => typeof id === 'string' && known(k, id))])];
    }
    const eq = raw.equipped?.[k];
    if (typeof eq === 'string' && s.owned[k].includes(eq)) s.equipped[k] = eq;
  }
  const st = raw.stats;
  if (st) {
    for (const key of [
      'games', 'wins', 'losses', 'streak', 'best', 'pvpStreak', 'pvpBest',
      'pvpGames', 'pvpWins', 'pvpRun', 'pvpRunBest', 'botGames', 'botWins',
    ] as const) {
      if (whole(st[key])) s.stats[key] = Math.max(0, Math.floor(st[key] as number));
    }
    for (const m of ['bot', 'online'] as const) {
      if (whole(st.modes?.[m])) s.stats.modes[m] = Math.max(0, Math.floor(st.modes![m] as number));
    }
  }
  s.stats.best = Math.max(s.stats.best, s.stats.streak);
  s.stats.pvpBest = Math.max(s.stats.pvpBest, s.stats.pvpStreak);
  /* the public career can never claim more wins than duels, or a longer run than its own best */
  s.stats.pvpWins = Math.min(s.stats.pvpWins, s.stats.pvpGames);
  s.stats.pvpRunBest = Math.max(s.stats.pvpRunBest, s.stats.pvpRun);
  /* a bot win is always one of its bot games, and never more than the lifetime tally holds */
  s.stats.botGames = Math.min(s.stats.botGames, s.stats.games);
  s.stats.botWins = Math.min(s.stats.botWins, s.stats.wins, s.stats.botGames);

  if (knownCountry(raw.country ?? '')) s.country = (raw.country as string).toUpperCase();

  /* A locked birthdate is the source of truth; a pre-lock age-only save keeps its number. */
  const dob = parseDob(raw.dob);
  if (dob) {
    s.dob = isoDob(dob.y, dob.m, dob.d);
    s.age = ageFromDob(dob.y, dob.m, dob.d);
  } else if (whole(raw.age)) {
    const a = Math.floor(raw.age as number);
    if (a >= AGE_MIN && a <= AGE_MAX) s.age = a;
  }
  const rw = raw.rewards as Partial<Save['rewards']> | undefined;
  if (rw) {
    if (rw.country === true) s.rewards.country = true;
    if (rw.age === true) s.rewards.age = true;
  }
  /* A save from before rewards existed that already set a field keeps its
     completion state consistent: claimed only when the reward was paid.
     Do NOT auto-mark — the player still earns it once on next set. */

  const teams = Array.isArray(raw.teams) ? raw.teams.filter(teamOk).slice(0, 40) : [];
  if (teams.length) s.teams = teams;
  const id = raw.teamId;
  if (typeof id === 'string' && s.teams.some((t) => t.id === id && inTeam(t))) s.teamId = id;
  else s.teamId = null;
  /* equipped badge + avatar frame: plain string ids, validated against length only here;
     badges.ts / menu.ts decide whether the id is still a known badge/frame. */
  if (typeof raw.badge === 'string' && raw.badge.length > 0 && raw.badge.length <= 32) {
    s.badge = raw.badge;
  } else if (raw.badge === null) {
    s.badge = null;
  }
  if (typeof raw.frame === 'string' && raw.frame.length > 0 && raw.frame.length <= 24) {
    s.frame = raw.frame;
  } else if (raw.frame === null) {
    s.frame = null;
  }
  if (typeof raw.displayName === 'string') {
    const name = cleanDisplayName(raw.displayName);
    if (name.length >= DISPLAY_NAME_MIN) s.displayName = name;
  } else if (raw.displayName === null) {
    s.displayName = null;
  }
  if (whole(raw.tiqBonus)) s.tiqBonus = Math.max(0, Math.floor(raw.tiqBonus));
  if (whole(raw.xp)) s.xp = Math.max(0, Math.floor(raw.xp));
  if (raw.tutorialCompleted === true) s.tutorialCompleted = true;
  if (raw.langChosen === true) s.langChosen = true;
  /* A save that already raced or finished the lesson predates the language gate: its player is
     returning, not first-boot, so the gate must never nag them on their next launch. */
  else if (s.tutorialCompleted || s.stats.games > 0 || s.stats.pvpGames > 0) s.langChosen = true;
  if (raw.firstDuelBonusClaimed === true) s.firstDuelBonusClaimed = true;
  /* The debut assist is monotonic. A pre-field save that already recorded a race belongs to a
     RETURNING player, so it starts consumed; a save that explicitly carries `false` is a current
     build (fresh install, or a profile that has only run the scripted lesson) and stays eligible.
     That distinction is why the standalone FTUE lesson does not spend the debut: the first race a
     new player could actually lose is the one the controller has to govern. */
  if (raw.firstMatchWon === true) s.firstMatchWon = true;
  else if (raw.firstMatchWon === undefined && (s.stats.games > 0 || s.stats.pvpGames > 0)) {
    s.firstMatchWon = true;
  }
  if (raw.pieceColor === 'blue' || raw.pieceColor === 'red') s.pieceColor = raw.pieceColor;
  const ref = raw.referral as Partial<ReferralState> | undefined;
  if (ref) {
    /* A save from before the referral engine simply keeps the fresh zeroes. Anything hand-edited is
       clamped — a blob can only ever make the counters smaller, never mint an absurd payout. */
    if (whole(ref.joins)) s.referral.joins = Math.max(0, Math.min(99999, Math.floor(ref.joins)));
    if (whole(ref.unclaimed)) s.referral.unclaimed = Math.max(0, Math.min(99999999, Math.floor(ref.unclaimed)));
    if (whole(ref.earned)) s.referral.earned = Math.max(0, Math.min(99999999, Math.floor(ref.earned)));
    if (typeof ref.code === 'string' && REFERRAL_CODE_RE.test(ref.code)) s.referral.code = ref.code;
    if (ref.welcome === true) s.referral.welcome = true;
    if (typeof ref.via === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(ref.via)) s.referral.via = ref.via;
  }

  /* Edition cache: the Worker is the authority, so this is only the last confirmed reading.
     Ids are the catalogue's own snake_case keys; every number is clamped to a cap. */
  const editions = raw.editions as Partial<EditionsCache> | undefined;
  if (editions) {
    const claims = editions.claims;
    if (claims && typeof claims === 'object') {
      for (const [id, value] of Object.entries(claims)) {
        if (!/^[a-z0-9_]{1,32}$/.test(id)) continue;
        const c = value as Partial<EditionClaim> | null;
        if (!c || !whole(c.serial) || !whole(c.cap)) continue;
        const serial = Math.floor(c.serial);
        const cap = Math.floor(c.cap);
        if (serial < 1 || cap < 1 || cap > 100000 || serial > cap) continue;
        s.editions.claims[id] = {
          serial,
          cap,
          mintedAt: typeof c.mintedAt === 'string' ? c.mintedAt.slice(0, 40) : '',
        };
      }
    }
    const supply = editions.supply;
    if (supply && typeof supply === 'object') {
      for (const [id, value] of Object.entries(supply)) {
        if (!/^[a-z0-9_]{1,32}$/.test(id)) continue;
        const row = value as Partial<EditionSupply> | null;
        if (!row || !whole(row.cap) || !whole(row.minted) || !whole(row.remaining)) continue;
        const cap = Math.floor(row.cap);
        if (cap < 1 || cap > 100000) continue;
        const minted = Math.max(0, Math.min(cap, Math.floor(row.minted)));
        s.editions.supply[id] = {
          cap,
          minted,
          remaining: Math.max(0, Math.min(cap, Math.floor(row.remaining))),
        };
      }
    }
    if (whole(editions.syncedAt)) s.editions.syncedAt = Math.max(0, Math.floor(editions.syncedAt));
  }
  return s;
}

/**
 * Fold a pre-namespacing save into an account slot, then remove the global key. The blob is only
 * adopted by the account opening now when the device's last account agrees AND the blob does not
 * name a different owner. Otherwise it is filed under the account its owner field (or the device's
 * last id) names — never under the newcomer — so a second Telegram account can never inherit it.
 */
function adoptLegacySave(): void {
  const legacyRaw = backend.get(BASE_SAVE_KEY);
  if (legacyRaw === null) return;
  try {
    const blob = JSON.parse(legacyRaw) as Partial<Save>;
    if (!blob || typeof blob !== 'object' || blob.v !== V) return;
    const namedOwner = saveOwner(blob);
    const owner = cleanUid(namedOwner);
    const currentTaken = backend.get(KEY) !== null;
    const deviceMatches = previousTgId === '' || previousTgId === activeTgId;

    if (!currentTaken && deviceMatches && ownedByActive(blob)) {
      writeJson(KEY, { ...blob, ownerTgId: activeTgId });
    } else if (!currentTaken && owner !== '' && owner === namedOwner && owner !== activeTgId) {
      /* The blob names its own account. File it there, never into the account opening now. */
      const ownerKey = scopedFor(BASE_SAVE_KEY, owner);
      if (backend.get(ownerKey) === null) writeJson(ownerKey, { ...blob, ownerTgId: owner });
    } else if (!currentTaken && namedOwner === '' && previousTgId !== '' && previousTgId !== activeTgId) {
      /* No owner field, but the device remembers who last held the un-namespaced save. */
      const previousKey = scopedFor(BASE_SAVE_KEY, previousTgId);
      if (backend.get(previousKey) === null) writeJson(previousKey, { ...blob, ownerTgId: previousTgId });
    }
  } catch {
    /* A hand-edited legacy blob is not a save: dropping it is the only safe read. */
  } finally {
    /* Whether it was adopted or rejected, it must never be readable by a second account. */
    drop(BASE_SAVE_KEY);
  }
}

adoptLegacySave();
backend.set(LAST_UID_KEY, activeTgId);

const storedSave = readJson<Save>(KEY);
export const profile: Save = migrate(storedSave);
/* A rejected or ownerless blob is replaced on disk in the same boot: another account's JSON must
   not sit under this key, and every serialized save names its owner. */
if (storedSave && (storedSave.v !== V || saveOwner(storedSave) !== activeTgId)) writeJson(KEY, profile);

const watchers: (() => void)[] = [];

function flush() {
  profile.v = V;
  profile.ownerTgId = activeTgId;
  writeJson(KEY, profile);
  for (const w of watchers) w();
}

/** Called after every change to the save, and after a late cloud hydrate. */
export function onChange(w: () => void) { watchers.push(w); }

/**
 * Replace the live save from raw JSON — the seam a CloudStorage read resolves into.
 *
 * A blob that names another Telegram account is rejected before any field is read: there is no
 * monotonic merge across owners, because a shared device must never carry coins, TIQ or flags
 * from the account that used it last. The account's own save is reset instead, and the server may
 * then hydrate it from that account's record.
 */
export function hydrate(raw: string | null) {
  let parsed: Partial<Save> | null = null;
  try { parsed = raw ? (JSON.parse(raw) as Partial<Save>) : null; } catch { return; }

  if (parsed && !ownedByActive(parsed)) {
    Object.assign(profile, fresh());
    flush();
    return;
  }

  /* First-run onboarding is monotonic, but only against local state of the SAME account. An older
     cloud blob that still says `false` must never push a player who already finished or skipped
     the lesson back into the tutorial. Only resetTutorialState() may clear the flag. */
  const sameOwner = saveOwner(profile) === activeTgId;
  const wasCompleted = sameOwner && profile.tutorialCompleted === true;
  const wasBonusClaimed = sameOwner && profile.firstDuelBonusClaimed === true;
  const wasLangChosen = sameOwner && profile.langChosen === true;
  /* An older cloud blob cannot re-arm the debut assist on a device that already spent it. */
  const wasFirstMatchWon = sameOwner && profile.firstMatchWon === true;
  /* National allegiance is settled once per account: a stale cloud blob may never repaint it. */
  const settledCountry = sameOwner ? profile.country : null;
  const next = migrate(parsed);
  Object.assign(profile, next);
  profile.ownerTgId = activeTgId;
  if (settledCountry) profile.country = settledCountry;
  if (wasCompleted) profile.tutorialCompleted = true;
  /* An older cloud blob has no idea the welcome bonus was paid. Keep it paid, or the next
     settled race would mint a second +200 from a save that predates the field. */
  if (wasBonusClaimed) profile.firstDuelBonusClaimed = true;
  /* The locale lock is monotonic too: a cloud blob predating the gate must never reopen it for a
     player who already chose their language on this device. */
  if (wasLangChosen) profile.langChosen = true;
  if (wasFirstMatchWon) profile.firstMatchWon = true;
  /* A cloud save can carry a whole match history onto a device whose own cache is empty. That
     player has raced before, so stamp the lesson flag here too: a hydrate that lands AFTER boot
     must never leave a returning profile eligible for first-open onboarding. */
  reconcileTutorialFromHistory();
  flush();
}

/* ---------- cosmetics ---------- */

export type BuyResult = 'bought' | 'owned' | 'short' | 'unknown';

export const theme = (): Theme => themeOf(profile.equipped.ball, profile.equipped.wall, profile.equipped.board);
export const owns = (kind: CosKind, id: string) => profile.owned[kind].includes(id);
export const isEquipped = (kind: CosKind, id: string) => profile.equipped[kind] === id;

export function equip(kind: CosKind, id: string): boolean {
  if (!owns(kind, id) || profile.equipped[kind] === id) return false;
  profile.equipped[kind] = id;
  flush();
  return true;
}

/** Buying spends the coins, takes ownership and puts the item on — one tap, one result. */
export function buy(kind: CosKind, id: string, price: number): BuyResult {
  if (!known(kind, id)) return 'unknown';
  if (owns(kind, id)) return 'owned';
  if (profile.coins < price) return 'short';
  profile.coins -= price;
  profile.owned[kind] = [...profile.owned[kind], id];
  profile.equipped[kind] = id;
  flush();
  return 'bought';
}

/* ---------- economy ---------- */

/** A sharper bot is worth more because beating it says more. A human loss still pays a consolation. */
const WIN: Record<Difficulty, number> = { easy: 40, normal: 65, hard: 100 };
const LOSS: Record<Difficulty, number> = { easy: 12, normal: 18, hard: 25 };

/** A bot WIN pays its difficulty's XP tier. A bot loss, draw or forfeit pays nothing at all. */
const BOT_XP: Record<Difficulty, number> = { easy: 15, normal: 30, hard: 50 };
/** A human win pays by the room it was won in: friendly 25, ranked 60, party 70, arena 80. */
const PVP_XP = { friendly: 25, ranked: 60, party: 70, arena: 80 } as const;

export function payout(r: { difficulty: Difficulty; won: boolean }, mult = 1): number {
  const base = (r.won ? WIN : LOSS)[r.difficulty];
  const scale = Number.isFinite(mult) && mult > 0 ? mult : 1;
  return Math.max(0, Math.round(base * scale));
}

/** What one settled race paid: the wallet, the XP pool, and who was on the far side. */
export interface GameSettlement {
  coins: number;
  xp: number;
  /** True when the board was held by the machine, so the ladder owes it nothing. */
  bot: boolean;
}

/**
 * XP for one settled race. ONLY A FINISHED WIN PAYS: a bot win is worth its difficulty tier
 * (15 / 30 / 50), a human win its room (friendly 25, ranked 60, four-seat 70, arena 80). A loss,
 * a draw and a forfeit — against a bot or a person — are worth exactly zero.
 */
function xpForGame(r: {
  difficulty: Difficulty;
  won: boolean;
  mode?: 'bot' | 'pvp' | 'arena';
  forfeit?: boolean;
  seats?: number;
}, live: boolean, ranked: boolean): number {
  if (!r.won || r.forfeit === true) return 0;
  if (!live) return BOT_XP[r.difficulty] ?? 0;
  if (r.mode === 'arena') return PVP_XP.arena;
  if (Math.max(2, Math.floor(r.seats ?? 2)) > 2) return PVP_XP.party;
  if (ranked) return PVP_XP.ranked;
  return PVP_XP.friendly;
}

/** Settles one finished race: the tally, the streak, the wallet and the XP pool. */
export function recordGame(
  r: {
    difficulty: Difficulty;
    won: boolean;
    /** The board's tag; leaving it out keeps the historical practice-race reading. */
    mode?: 'bot' | 'pvp' | 'arena';
    /** Did this seat still hold at least half its defense when the race was decided? */
    defenseHeld?: boolean;
    /**
     * Ranked-only: true when the board came out of the matchmaker — the duel queue or an Arena
     * cup — with a person on the far side. A friends room, even one full of people, is a friendly
     * duel; a board with no live seat is practice. Both are `false`.
     */
    ranked?: boolean;
    /**
     * The race ended without a finish line (resign, drop, abandonment). A ranked run does not
     * survive one: the match is void, so the streak goes back to zero rather than banking a win
     * the board never earned.
     */
    forfeit?: boolean;
    /** Seats on the board: a four-player party pays more XP than a duel. */
    seats?: number;
  },
  mult = 1,
): GameSettlement {
  const s = profile.stats;
  const live = r.mode === 'pvp' || r.mode === 'arena';
  /* THE STREAK IS A RANKED INSTRUMENT. A friendly duel and a bot board are invisible to it: they
     can neither extend a run nor break one, so a friendly loss never wipes a ranked streak and a
     farmed AI seat never inflates one. Only the two run counters below are gated; the lifetime
     tally above still records every race that was actually played. */
  const ranked = live && r.ranked === true;
  s.games++;
  const mode: Mode = live ? 'online' : 'bot';
  s.modes[mode] = (s.modes[mode] ?? 0) + 1;
  if (r.won) {
    s.wins++;
    s.streak++;
    s.best = Math.max(s.best, s.streak);
  } else {
    s.losses++;
    s.streak = 0;
  }
  if (live) {
    /* THE PUBLIC CAREER. Only a board with a person on the far side reaches this block: `mode` is
       `bot` for a solo practice race and for a friends room the machine backfilled, so a farmed
       AI seat can never move a number the competitive profile prints. */
    s.pvpGames++;
    if (r.won) s.pvpWins++;
  }
  if (ranked) {
    /* The run the profile prints: ranked wins only. A voided race — a resignation, a drop, an
       abandoned board — is a defeat here whichever seat walked, and a loss of any kind is zero. */
    if (r.won && r.forfeit !== true) {
      s.pvpRun++;
      s.pvpRunBest = Math.max(s.pvpRunBest, s.pvpRun);
      /* A ranked win extends the defense-gated run only while the seat still held half its
         walls; a low-integrity win breaks it exactly like a loss, so the badge cannot be farmed
         by trading walls. */
      if (r.defenseHeld === true) {
        s.pvpStreak++;
        s.pvpBest = Math.max(s.pvpBest, s.pvpStreak);
      } else {
        s.pvpStreak = 0;
      }
    } else {
      s.pvpRun = 0;
      s.pvpStreak = 0;
    }
  }
  /* THE MACHINE IS NOT A LADDER OPPONENT. Its boards are counted apart (`botGames`/`botWins`) so
     `ladderTally()` can keep them out of the rating: a bot win, loss, resignation and timeout all
     leave TIQ exactly where it was. No bot board can mint a TIQ gain, and none can charge one. */
  if (!live) {
    s.botGames++;
    if (r.won) s.botWins++;
  }
  /* A bot board pays coins for a WIN only; a human board keeps its consolation for a loss. */
  const coins = live || r.won ? payout(r, mult) : 0;
  const xp = xpForGame(r, live, ranked);
  profile.coins += coins;
  profile.xp += xp;
  flush();
  return { coins, xp, bot: !live };
}

/**
 * The counters the rating is built from: the lifetime tally with the machine-held boards taken
 * back out. A bot race therefore cannot move TIQ — not on a win, and not on a loss, a resignation
 * or a timeout — while every board with a person on the far side keeps counting as before.
 */
export const ladderTally = (): { wins: number; games: number } => {
  const games = Math.max(0, profile.stats.games - (profile.stats.botGames ?? 0));
  /* wins can never outnumber the games they were won in, whatever a blob claims */
  const wins = Math.min(games, Math.max(0, profile.stats.wins - (profile.stats.botWins ?? 0)));
  return { wins, games };
};

/**
 * Read the saved lesson flag. STRICT: only the literal `true` counts as "returning player". A
 * missing or false flag (fresh install, older save, refused storage backend) is a first launch.
 */
export const hasCompletedTutorial = (): boolean => profile.tutorialCompleted === true;

/** The public competitive record: human-vs-human only, with the rate derived — never stored. */
export interface PvpCareer {
  matches: number;
  wins: number;
  /** `(pvpWins / pvpGames) * 100`, rounded; 0 when no duel has ever settled. */
  rate: number;
  /** The run in progress — broken by the next settled PvP loss. */
  run: number;
  /** The longest consecutive PvP win run this seat has ever strung together. */
  best: number;
}

export function pvpCareer(): PvpCareer {
  const s = profile.stats;
  const matches = Math.max(0, Math.floor(s.pvpGames));
  const wins = Math.min(matches, Math.max(0, Math.floor(s.pvpWins)));
  const best = Math.max(0, Math.floor(s.pvpRunBest));
  return {
    matches,
    wins,
    rate: matches > 0 ? Math.round((wins / matches) * 100) : 0,
    run: Math.min(best, Math.max(0, Math.floor(s.pvpRun))),
    best,
  };
}

/**
 * Every race this profile has ever settled, across the tally, the win/loss pair and the per-mode
 * counters. The three are cross-checked because a partial or older server blob may restore only
 * one of them — any one of them proves the player has been here before.
 */
export function totalMatchesPlayed(): number {
  const s = profile.stats;
  const n = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0;
  const byMode = Object.values(s.modes ?? {}).reduce<number>((sum, v) => sum + n(v), 0);
  return Math.max(n(s.games), n(s.wins) + n(s.losses), byMode);
}

/**
 * A TRUE first-time player: the lesson has never been finished or skipped AND not a single race
 * has been recorded. `main.ts` boot-reads this once to decide between a direct playable tutorial
 * and the ordinary Home/Lobby screen. Anything else — including a completed flag alone — is a
 * returning player and always boots on Home.
 */
export function isFirstTimePlayer(): boolean {
  return !hasCompletedTutorial() && totalMatchesPlayed() <= 0;
}

/**
 * Returning players on a fresh cache: a server/profile hydrate may restore match history without
 * the newer `tutorialCompleted` flag. Mark the lesson complete at once so they are NEVER forced
 * into onboarding. Returns true when this call promoted the profile to "returning".
 */
export function reconcileTutorialFromHistory(): boolean {
  if (hasCompletedTutorial() || totalMatchesPlayed() <= 0) return false;
  completeTutorial();
  return true;
}

/**
 * The colour this device paints its own pieces in. Kept beside the cosmetics because it is a
 * preference, not game state: no rules query and no network payload ever reads it.
 */
export const pieceColor = (): PieceColor => profile.pieceColor;

/** Choose red or blue for the local perspective; the opponent is painted in the other one. */
export function setPieceColor(color: PieceColor): boolean {
  const next: PieceColor = color === 'blue' ? 'blue' : 'red';
  if (profile.pieceColor === next) return false;
  profile.pieceColor = next;
  flush();
  return true;
}

/**
 * Persist completion in the one save. Called the INSTANT the lesson is finished or explicitly
 * skipped — a skip is still a decision to play, and re-showing the lesson on the next race would
 * be a nag, not help. The flush is immediate, so a reload or a fresh launch can never auto-trigger
 * the lesson for this profile. A manual replay (Pause / Settings) never clears the flag.
 */
export function completeTutorial(): void {
  if (profile.tutorialCompleted) return;
  profile.tutorialCompleted = true;
  flush();
}

/**
 * The locale lock. STRICT, like the lesson flag: only the literal `true` counts as "chosen", so a
 * fresh install, an older save or a refused storage backend all open the first-boot picker.
 */
export const hasChosenLanguage = (): boolean => profile.langChosen === true;

/**
 * Stamp the explicit choice in the one scoped save (`detour.save.v2_u_<id>`). Called the instant a
 * language is picked — from the first-boot gate or from Settings — so the lock survives match exits,
 * cloud hydrates and reloads. Idempotent: a second pick of the same locale never re-flushes.
 */
export function markLanguageChosen(): void {
  if (profile.langChosen) return;
  profile.langChosen = true;
  flush();
}

/**
 * `window.resetTutorial()`'s storage half: forget the saved flag (and the bare
 * `tutorial_completed` key older builds wrote) so the next local race starts the lesson again.
 */
export function resetTutorialState(): void {
  profile.tutorialCompleted = false;
  flush();
  try {
    window.localStorage.removeItem('tutorial_completed');
  } catch { /* storage denied: the in-memory flag is false for this session */ }
}

/** Tournament entries and daily rewards move the same wallet the shop reads. */
export function spendCoins(n: number): boolean {
  const cost = Math.max(0, Math.floor(n));
  if (profile.coins < cost) return false;
  profile.coins -= cost;
  flush();
  return true;
}

export function earnCoins(n: number): number {
  const gain = Math.max(0, Math.floor(n));
  profile.coins += gain;
  flush();
  return gain;
}

/* ---------- first-duel welcome cushion ---------- */

/** The endowment-effect grant paid once, on the first settled race, whether it was won or lost. */
export const FIRST_DUEL_BONUS = 200;

/** Read the one-time grant's flag. Only the literal `true` counts, exactly like the lesson flag. */
export const hasClaimedFirstDuelBonus = (): boolean => profile.firstDuelBonusClaimed === true;

/**
 * Stamp the flag and credit the wallet in ONE flush. Returns the coins actually paid (0 when the
 * bonus was already claimed), so the caller can decide whether to raise the celebratory badge.
 * Persisting the flag in the same write as the credit makes a reload mid-animation harmless: the
 * coins are already in the save and a second payout is impossible.
 */
export function claimFirstDuelBonus(): number {
  if (profile.firstDuelBonusClaimed) return 0;
  profile.firstDuelBonusClaimed = true;
  profile.coins += FIRST_DUEL_BONUS;
  flush();
  return FIRST_DUEL_BONUS;
}

/* ---------- the one-shot first-match onboarding assist ---------- */

/** STRICT, like every other one-time flag: only the literal `true` counts as "already spent". */
export const hasWonFirstOnboardingMatch = (): boolean => profile.firstMatchWon === true;

/**
 * Is this seat still owed its guaranteed debut? The dedicated flag is the authority, not
 * `stats.games`: the standalone first-boot lesson already settles a race (and increments `games`)
 * but is a scripted tutorial that cannot be lost, so it must NOT consume the debut. The first real
 * race — direct entry, the matchmaker queue or solo practice — is the one the controller governs.
 * Friendly invite rooms and server-verified Referral Hard Bot quests are excluded at the launch
 * door in `main.ts`, never here.
 */
export const isFirstOnboardingEligible = (): boolean => !hasWonFirstOnboardingMatch();

/**
 * Spend the debut in ONE flush. Called when the governed match settles (a win by construction), so
 * a reload mid-celebration cannot re-arm the assist, and no later hydrate can undo it.
 */
export function markFirstOnboardingWin(): void {
  if (profile.firstMatchWon) return;
  profile.firstMatchWon = true;
  flush();
}

/** Tournament prizes, event grants and the Admin Command Center move TIQ the same way. */
export function earnTiq(n: number): number {
  const gain = Math.max(0, Math.floor(n));
  profile.tiqBonus += gain;
  flush();
  return gain;
}

/* ---------- referral / invite-to-earn ---------- */

/**
 * Fold a server ledger reading into the save. The Worker owns the lifetime total (`earned`), so
 * only the *delta* since the last fold is added to the unclaimed pool — a local Claim can empty
 * the pool without the next poll paying the same coins again. `joins` only ever moves forward.
 * Returns true when the Hub's face actually changed.
 */
export function syncReferralLedger(reading: {
  code?: string | null;
  joins?: number;
  earned?: number;
}): boolean {
  let moved = false;
  const code = typeof reading.code === 'string' && REFERRAL_CODE_RE.test(reading.code) ? reading.code : '';
  if (code && profile.referral.code !== code) {
    profile.referral.code = code;
    moved = true;
  }
  const joins = typeof reading.joins === 'number' && Number.isFinite(reading.joins)
    ? Math.max(0, Math.min(99999, Math.floor(reading.joins)))
    : 0;
  if (joins > profile.referral.joins) {
    profile.referral.joins = joins;
    moved = true;
  }
  const earned = typeof reading.earned === 'number' && Number.isFinite(reading.earned)
    ? Math.max(0, Math.min(99999999, Math.floor(reading.earned)))
    : 0;
  if (earned > profile.referral.earned) {
    profile.referral.unclaimed += earned - profile.referral.earned;
    profile.referral.earned = earned;
    moved = true;
  }
  if (moved) flush();
  return moved;
}

/** The Hub's Claim tap: moves the whole unclaimed balance into the wallet in one flush. */
export function claimReferralRewards(): number {
  const due = profile.referral.unclaimed;
  if (due <= 0) return 0;
  profile.referral.unclaimed = 0;
  profile.coins += due;
  flush();
  return due;
}

/** The mode raced most, for the profile card. */
export function favouriteMode(): Mode | null {
  return (profile.stats.modes.bot ?? 0) > 0 ? 'bot' : null;
}

/* ---------- identity: level, country, team ---------- */

/**
 * Level is the record seen another way, so the bar on Home answers to races that actually happened:
 * a win is worth more than a game, and each step asks for a little more than the last.
 */
export function levelInfo() {
  let x = profile.stats.wins * 4 + profile.stats.games, n = 1, need = 10;
  while (x >= need) { x -= need; n++; need = 10 + 6 * (n - 1); }
  return { n, got: x, need };
}

/** True once the flag is set: national allegiance is a one-time choice, never a setting. */
export const countryLocked = (): boolean => profile.country !== null;

/**
 * The one-time national allegiance. The first choice is final: a save that already carries a
 * flag refuses every later write, so no edit path can repaint the nation the arena ranks you
 * under. Returns whether the save took the code.
 */
export function setCountry(code: string | null): boolean {
  if (profile.country !== null) return false;
  const next = code ? code.toUpperCase() : null;
  if (!next) return false;
  profile.country = next;
  flush();
  return true;
}

/** The locked birthdate, parsed back from the save, or null while the entry is still open. */
export function dobValue(): Dob | null {
  return parseDob(profile.dob);
}

/** True once the birthdate is confirmed: no edit path may ever reopen it. */
export const ageLocked = (): boolean => profile.dob !== null;

/**
 * The one-time lock. Validates the calendar date and writes the birthdate + derived age in one
 * flush. Returns false when the entry is already locked or the date is outside the window —
 * a locked birthdate can never be changed or cleared.
 */
export function setDob(y: number, m: number, d: number): boolean {
  if (profile.dob !== null) return false;
  if (!validDob(y, m, d)) return false;
  const yy = Math.floor(y); const mm = Math.floor(m); const dd = Math.floor(d);
  profile.dob = isoDob(yy, mm, dd);
  profile.age = ageFromDob(yy, mm, dd);
  flush();
  return true;
}

/** Legacy age-only writes stay open, but a locked birthdate refuses every one of them. */
export function setAge(n: number | null) {
  if (profile.dob !== null) return;
  if (n === null) { profile.age = null; flush(); return; }
  const v = Math.floor(n);
  if (!Number.isFinite(v)) return;
  profile.age = Math.max(AGE_MIN, Math.min(AGE_MAX, v));
  flush();
}

/** Equipped profile badge id (opaque here — badges.ts owns the catalogue). */
export function setBadge(id: string | null) {
  profile.badge = id && id.length > 0 && id.length <= 32 ? id : null;
  flush();
}

/** Cache the Worker's live edition supply so an offline shelf still counts down. */
export function cacheBadgeSupply(supply: Record<string, EditionSupply>, at: number) {
  profile.editions.supply = { ...supply };
  profile.editions.syncedAt = Math.max(0, Math.floor(at));
  flush();
}

/** Cache one server-confirmed serial. The mint endpoint is idempotent, so this is safe to rewrite. */
export function cacheBadgeClaim(id: string, claim: EditionClaim) {
  if (!/^[a-z0-9_]{1,32}$/.test(id)) return;
  profile.editions.claims[id] = { ...claim };
  flush();
}

/** Tactile avatar frame id (opaque here — menu.ts owns the frame catalogue). */
export function setFrame(id: string | null) {
  profile.frame = id && id.length > 0 && id.length <= 24 ? id : null;
  flush();
}

/* ---------- display name ---------- */

/**
 * The one normalisation every display name passes through: control characters out,
 * runs of whitespace folded to one space, ends trimmed, 16 characters maximum.
 * Emoji and non-Latin scripts are welcome; markup is just text here, because the
 * name is always written with `textContent`.
 */
export function cleanDisplayName(raw: string): string {
  return (raw ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DISPLAY_NAME_MAX);
}

/**
 * Set the player's own display name. Rejects anything under 3 characters after
 * normalisation, and returns whether the save took it.
 */
export function setDisplayName(raw: string): boolean {
  const name = cleanDisplayName(raw);
  if (name.length < DISPLAY_NAME_MIN) return false;
  profile.displayName = name;
  flush();
  return true;
}

export type IdentityKind = 'country' | 'age';

/**
 * Pays the one-time +100 completion reward for an identity field.
 * Returns the coins awarded (IDENTITY_REWARD) or 0 when already claimed.
 * The field itself must already be set — this only flips the claimed flag.
 */
export function claimIdentityReward(kind: IdentityKind): number {
  if (profile.rewards[kind]) return 0;
  const has = kind === 'country' ? !!profile.country : profile.dob !== null || profile.age !== null;
  if (!has) return 0;
  profile.rewards[kind] = true;
  profile.coins += IDENTITY_REWARD;
  flush();
  return IDENTITY_REWARD;
}

export const myTeam = (): Team | null => profile.teams.find((t) => t.id === profile.teamId) ?? null;

export type TeamResult = 'created' | 'joined' | 'left' | 'short-name' | 'no-code' | 'already-in' | 'full';

const swap = (id: string, next: Team) => { profile.teams = profile.teams.map((t) => (t.id === id ? next : t)); };

/** Teams are local for now: this is the one place that mutates the registry, so the server can own it later. */
export function createTeam(rawName: string, you: string): TeamResult {
  if (profile.teamId) return 'already-in';
  const name = cleanName(rawName);
  if (name.length < 2) return 'short-name';
  const taken = new Set(profile.teams.map((t) => t.code));
  const team = makeTeam(name, you || 'You', taken);
  if (!team) return 'full';
  profile.teams = [...profile.teams, team];
  profile.teamId = team.id;
  flush();
  return 'created';
}

export function joinTeam(rawCode: string, you: string): TeamResult {
  if (profile.teamId) return 'already-in';
  const code = cleanCode(rawCode);
  const team = profile.teams.find((t) => t.code === code);
  if (!team) return 'no-code';
  if (inTeam(team)) { profile.teamId = team.id; flush(); return 'joined'; }
  swap(team.id, addMember(team, cleanName(you).slice(0, 24) || 'You'));
  profile.teamId = team.id;
  flush();
  return 'joined';
}

/** Walking out: a seeded club keeps its roster, a team you made dissolves with you in it. */
export function leaveTeam(): TeamResult {
  const team = myTeam();
  if (!team) return 'no-code';
  if (team.seed) swap(team.id, dropMember(team));
  else profile.teams = profile.teams.filter((t) => t.id !== team.id);
  profile.teamId = null;
  flush();
  return 'left';
}
