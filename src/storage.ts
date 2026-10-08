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

export interface Save {
  v: number;
  coins: number;
  owned: Record<CosKind, string[]>;
  equipped: Record<CosKind, string>;
  stats: Stats;
  /** ISO 3166-1 alpha-2, or null until the player picks one in Profile */
  country: string | null;
  teamId: string | null;
  /** every team this device knows about: the seeded clubs plus any you created or joined */
  teams: Team[];
}

/** The three starter items are owned before the first race; the wallet starts stocked for the demo. */
const STARTERS: Record<CosKind, string> = { ball: CLASSIC_BALL.id, wall: CLASSIC_WALL.id, board: CLASSIC_BOARD.id };
export const START_COINS = 1850;

function fresh(): Save {
  return {
    v: V,
    coins: START_COINS,
    owned: { ball: [STARTERS.ball], wall: [STARTERS.wall], board: [STARTERS.board] },
    equipped: { ...STARTERS },
    stats: { games: 0, wins: 0, losses: 0, streak: 0, best: 0, modes: {} },
    country: null,
    teamId: null,
    teams: seedTeams(),
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

  const teams = Array.isArray(raw.teams) ? raw.teams.filter(teamOk).slice(0, 40) : [];
  if (teams.length) s.teams = teams;
  const id = raw.teamId;
  if (typeof id === 'string' && s.teams.some((t) => t.id === id && inTeam(t))) s.teamId = id;
  else s.teamId = null;
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

export function payout(r: { difficulty: Difficulty; won: boolean }): number {
  return (r.won ? WIN : LOSS)[r.difficulty];
}

/** Settles one finished race: the tally, the streak and the wallet. */
export function recordGame(r: { difficulty: Difficulty; won: boolean }): number {
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
  const coins = payout(r);
  profile.coins += coins;
  flush();
  return coins;
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
