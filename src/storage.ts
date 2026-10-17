/**
 * storage.ts — the app's save: who you are, where you are from, your team, coins, what you own, what
 * you are wearing, and how you have played.
 *
 * One module owns the schema and the only door to the device. Every read and write is wrapped,
 * because a Telegram webview can refuse storage outright (private mode, cookies off) and the race
 * still has to run: a save is a convenience, never a requirement.
 *
 * Swapping in Telegram CloudStorage means replacing `backend` with an async get/set and handing the
 * fetched text to `hydrate()` when it lands — `readJson`/`writeJson` below are the whole contract
 * either side has to honour, and `profile` stays the single live object either way.
 */
import type { Difficulty } from './bot';
import type { Mode } from './settings';
import { CLASSIC_BALL, CLASSIC_BOARD, CLASSIC_WALL, known, themeOf, type CosKind, type Theme } from './themes';
import { knownCountry } from './countries';
import {
  addMember, cleanCode, cleanName, dropMember, inTeam, makeTeam, seedTeams, YOU, type Team,
} from './teams';

/* ---------- the door ---------- */

export interface Backend {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const backend: Backend = {
  get: (k) => { try { return window.localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* stay in memory */ } },
};

export function readJson<T>(key: string): Partial<T> | null {
  try {
    const raw = backend.get(key);
    return raw ? (JSON.parse(raw) as Partial<T>) : null;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown) {
  backend.set(key, JSON.stringify(value));
}

/* ---------- the schema ---------- */

const KEY = 'detour.save.v2';
const V = 2;

export const KINDS: CosKind[] = ['ball', 'wall', 'board'];

export interface Stats {
  games: number;
  wins: number;
  losses: number;
  /** current win streak, and the best one ever reached */
  streak: number;
  best: number;
  modes: Partial<Record<Mode, number>>;
}

/**
 * The referral / invite-to-earn record. It rides the save so the counters persist exactly like the
 * wallet does, and it is what the Profile's Referral Hub reads and writes: friends who joined
 * through this player's link, the referral coins credited but not yet claimed into the wallet, the
 * one-time welcome bonus flag for arriving through someone else's link, and that inbound code.
 */
export interface ReferralState {
  joins: number;
  unclaimed: number;
  /** The invitee's side: the welcome bonus is paid once, on the launch that carried the link. */
  welcome: boolean;
  /** The inbound referral code this device joined through, or null. */
  via: string | null;
}

export interface Save {
  v: number;
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
   * TIQ the player has been granted outside a race (Admin Command Center, future
   * events). Added on top of the ladder's own formula — `myTiq()` in matchmaking.ts.
   */
  tiqBonus: number;
  /** Referral engine: invited friends, claimable referral coins, welcome-bonus state. */
  referral: ReferralState;
}

/** The three starter items are owned before the first race; the wallet starts stocked for the demo. */
const STARTERS: Record<CosKind, string> = { ball: CLASSIC_BALL.id, wall: CLASSIC_WALL.id, board: CLASSIC_BOARD.id };
export const START_COINS = 1850;
/** Completion reward paid once per identity field (country, age). */
export const IDENTITY_REWARD = 100;
export const AGE_MIN = 7;
export const AGE_MAX = 99;
/** The birthdate picker's earliest year; the latest year is derived from AGE_MIN, measured today. */
export const DOB_MIN_YEAR = 1940;
/** What one invited friend pays: the inviter banks it as unclaimed, the friend gets it on join. */
export const REFERRAL_REWARD = 500;
export const REFERRAL_WELCOME = 500;

function fresh(): Save {
  return {
    v: V,
    coins: START_COINS,
    owned: { ball: [STARTERS.ball], wall: [STARTERS.wall], board: [STARTERS.board] },
    equipped: { ...STARTERS },
    stats: { games: 0, wins: 0, losses: 0, streak: 0, best: 0, modes: {} },
    country: null,
    age: null,
    dob: null,
    rewards: { country: false, age: false },
    teamId: null,
    teams: seedTeams(),
    badge: null,
    frame: null,
    tiqBonus: 0,
    referral: { joins: 0, unclaimed: 0, welcome: false, via: null },
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

/**
 * Anything that is not a recognised version starts clean; a v2 blob is folded field by field so a
 * half-written or hand-edited save can never smuggle an unknown item into `owned`.
 */
function migrate(raw: Partial<Save> | null): Save {
  const s = fresh();
  if (!raw || raw.v !== V) return s;

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
    for (const key of ['games', 'wins', 'losses', 'streak', 'best'] as const) {
      if (whole(st[key])) s.stats[key] = Math.max(0, Math.floor(st[key] as number));
    }
    for (const m of ['bot', 'online'] as const) {
      if (whole(st.modes?.[m])) s.stats.modes[m] = Math.max(0, Math.floor(st.modes![m] as number));
    }
  }
  s.stats.best = Math.max(s.stats.best, s.stats.streak);

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
  if (whole(raw.tiqBonus)) s.tiqBonus = Math.max(0, Math.floor(raw.tiqBonus));
  const ref = raw.referral as Partial<ReferralState> | undefined;
  if (ref) {
    /* A save from before the referral engine simply keeps the fresh zeroes. Anything hand-edited is
       clamped — a blob can only ever make the counters smaller, never mint an absurd payout. */
    if (whole(ref.joins)) s.referral.joins = Math.max(0, Math.min(99999, Math.floor(ref.joins)));
    if (whole(ref.unclaimed)) s.referral.unclaimed = Math.max(0, Math.min(99999999, Math.floor(ref.unclaimed)));
    if (ref.welcome === true) s.referral.welcome = true;
    if (typeof ref.via === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(ref.via)) s.referral.via = ref.via;
  }
  return s;
}

export const profile: Save = migrate(readJson<Save>(KEY));

const watchers: (() => void)[] = [];

function flush() {
  profile.v = V;
  writeJson(KEY, profile);
  for (const w of watchers) w();
}

/** Called after every change to the save, and after a late cloud hydrate. */
export function onChange(w: () => void) { watchers.push(w); }

/** Replace the live save from raw JSON — the seam a CloudStorage read resolves into. */
export function hydrate(raw: string | null) {
  try {
    const next = migrate(raw ? (JSON.parse(raw) as Partial<Save>) : null);
    Object.assign(profile, next);
  } catch {
    /* keep what we already had */
    return;
  }
  for (const w of watchers) w();
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

/** A sharper bot is worth more because beating it says more. A loss still pays something. */
const WIN: Record<Difficulty, number> = { easy: 40, normal: 65, hard: 100 };
const LOSS: Record<Difficulty, number> = { easy: 12, normal: 18, hard: 25 };

export function payout(r: { difficulty: Difficulty; won: boolean }, mult = 1): number {
  const base = (r.won ? WIN : LOSS)[r.difficulty];
  const scale = Number.isFinite(mult) && mult > 0 ? mult : 1;
  return Math.max(0, Math.round(base * scale));
}

/** Settles one finished race: the tally, the streak and the wallet. */
export function recordGame(r: { difficulty: Difficulty; won: boolean }, mult = 1): number {
  const s = profile.stats;
  s.games++;
  s.modes.bot = (s.modes.bot ?? 0) + 1;
  if (r.won) {
    s.wins++;
    s.streak++;
    s.best = Math.max(s.best, s.streak);
  } else {
    s.losses++;
    s.streak = 0;
  }
  const coins = payout(r, mult);
  profile.coins += coins;
  flush();
  return coins;
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

/** Tournament prizes, event grants and the Admin Command Center move TIQ the same way. */
export function earnTiq(n: number): number {
  const gain = Math.max(0, Math.floor(n));
  profile.tiqBonus += gain;
  flush();
  return gain;
}

/* ---------- referral / invite-to-earn ---------- */

/**
 * One friend joined through this player's link: the joins counter moves and the payout is banked
 * as unclaimed, never straight into the wallet — the Hub's Claim key is the only door into coins.
 * Returns the coins credited to the unclaimed balance.
 */
export function creditReferralJoin(n = 1): number {
  const joins = Math.max(0, Math.min(99999, Math.floor(n)));
  if (!joins) return 0;
  profile.referral.joins += joins;
  profile.referral.unclaimed += joins * REFERRAL_REWARD;
  flush();
  return joins * REFERRAL_REWARD;
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

/**
 * The invitee's side of a `ref_` link, paid once per save: the caller passes the inbound code and
 * gets back the welcome coins, or 0 when there was no code or the bonus was already paid.
 */
export function markReferralWelcome(via: string): number {
  if (profile.referral.welcome) return 0;
  profile.referral.welcome = true;
  profile.referral.via = /^[A-Za-z0-9_-]{1,32}$/.test(via) ? via : null;
  profile.coins += REFERRAL_WELCOME;
  flush();
  return REFERRAL_WELCOME;
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

export function setCountry(code: string | null) {
  profile.country = code ? code.toUpperCase() : null;
  flush();
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

/** Tactile avatar frame id (opaque here — menu.ts owns the frame catalogue). */
export function setFrame(id: string | null) {
  profile.frame = id && id.length > 0 && id.length <= 24 ? id : null;
  flush();
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
