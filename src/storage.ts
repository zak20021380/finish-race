/**
 * storage.ts — the app's save: coins, what you own, what you are wearing, and how you have played.
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

const KEY = 'finish-race.save.v1';
const V = 1;

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
  };
}

const whole = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Anything that is not a recognised version starts clean; a v1 blob is folded field by field so a
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
    for (const m of ['bot', 'local', 'online'] as const) {
      if (whole(st.modes?.[m])) s.stats.modes[m] = Math.max(0, Math.floor(st.modes![m] as number));
    }
  }
  s.stats.best = Math.max(s.stats.best, s.stats.streak);
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
const PASS_PLAY = 20;

export function payout(r: { mode: Mode; difficulty: Difficulty; won: boolean }): number {
  if (r.mode === 'local') return PASS_PLAY;
  return (r.won ? WIN : LOSS)[r.difficulty];
}

/**
 * Settles one finished race: the tally, the streak and the wallet. Pass & Play has no "you", so it
 * counts the game and pays, but wins and losses stay the bot races' business.
 */
export function recordGame(r: { mode: Mode; difficulty: Difficulty; won: boolean }): number {
  const s = profile.stats;
  s.games++;
  s.modes[r.mode] = (s.modes[r.mode] ?? 0) + 1;
  if (r.mode !== 'local') {
    if (r.won) {
      s.wins++;
      s.streak++;
      s.best = Math.max(s.best, s.streak);
    } else {
      s.losses++;
      s.streak = 0;
    }
  }
  const coins = payout(r);
  profile.coins += coins;
  flush();
  return coins;
}

/** The mode raced most, for the profile card. */
export function favouriteMode(): Mode | null {
  const bot = profile.stats.modes.bot ?? 0, local = profile.stats.modes.local ?? 0;
  return bot === local ? (bot ? 'bot' : null) : bot > local ? 'bot' : 'local';
}
