/**
 * runtime.ts — the live economy knobs, split out of the Admin Command Center.
 *
 * These five numbers (the win reward, the coin multiplier, the blitz allowance and the two queue
 * radii) are read by the matchmaker and by every payout on the device, so they belong to the boot
 * graph. The panel that *edits* them does not: it is 290 KB of source that only an appointed
 * operator ever opens. Keeping the config here is what lets `admin.ts` be a lazily imported chunk
 * while `matchmaking.ts` still reads the same object the panel writes.
 *
 * `setRuntime` is the only writer, so a toggle in the panel takes effect everywhere the instant it
 * flips, with no reload and no second source of truth.
 */
import { readJson, writeJson } from './storage';
import { CONFIG } from './rules';

export interface AdminRuntime {
  /** TIQ a win is worth, race credit included. */
  winTiq: number;
  /** 1.0x / 1.5x / 2.0x — the coin payout scale. */
  coinMult: number;
  /** Seconds a seat gets before the blitz auto-move. */
  blitz: number;
  /** The ordinary queue radius, in TIQ. */
  radiusNormal: number;
  /** The widened radius, once a seat asks for more. */
  radiusWide: number;
}

/** The coin multiplier a Double-Coins event steps through. */
export const COIN_STEPS: readonly number[] = [1, 1.5, 2];
/**
 * The blitz allowances the stepper offers. The engine's own limit (`CONFIG.TURN_TIME_LIMIT`, 8s) is
 * the baseline and must always be one of them, so the default below can never be a value the panel
 * cannot step back to.
 */
export const BLITZ_STEPS: readonly number[] = [6, 8, 10, 12];

export const DEFAULT_RUNTIME: AdminRuntime = {
  winTiq: 140,
  coinMult: 1,
  blitz: CONFIG.TURN_TIME_LIMIT,
  radiusNormal: 250,
  radiusWide: 600,
};

const RUNTIME_KEY = 'detour.admin.v1';

/** Every finished race lands this much TIQ; a win adds the rest of `winTiq` on top of it. */
export const RACE_TIQ = 20;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pickNum = (v: unknown, fallback: number, lo: number, hi: number): number =>
  isNum(v) ? clamp(v, lo, hi) : fallback;
const pickOne = (list: readonly number[], v: unknown, fallback: number): number =>
  isNum(v) && list.includes(v) ? v : fallback;

/** A hand-edited or half-written blob is folded field by field, never trusted as it stands. */
function loadRuntime(): AdminRuntime {
  const raw = readJson<AdminRuntime>(RUNTIME_KEY);
  const d = DEFAULT_RUNTIME;
  if (!raw) return { ...d };
  return {
    winTiq: Math.round(pickNum(raw.winTiq, d.winTiq, 0, 1000)),
    coinMult: pickOne(COIN_STEPS, raw.coinMult, d.coinMult),
    blitz: pickOne(BLITZ_STEPS, raw.blitz, d.blitz),
    radiusNormal: Math.round(pickNum(raw.radiusNormal, d.radiusNormal, 50, 2000)),
    radiusWide: Math.round(pickNum(raw.radiusWide, d.radiusWide, 100, 4000)),
  };
}

/** The live config every module reads. Mutated only through `setRuntime`. */
export const runtime: AdminRuntime = loadRuntime();

const watchers: (() => void)[] = [];

/** Fires after every accepted change, so the app can repaint what the change touched. */
export function onRuntime(w: () => void): () => void {
  watchers.push(w);
  return () => {
    const i = watchers.indexOf(w);
    if (i >= 0) watchers.splice(i, 1);
  };
}

/** The one writer: patch, persist, then tell everyone. */
export function setRuntime(patch: Partial<AdminRuntime>): void {
  Object.assign(runtime, patch);
  writeJson(RUNTIME_KEY, runtime);
  for (const w of [...watchers]) {
    try {
      w();
    } catch {
      /* a watcher threw: the rest still get their turn */
    }
  }
}

/** Back to the shipped numbers, keeping whatever is not in the default set. */
export function resetRuntime(): void {
  setRuntime({ ...DEFAULT_RUNTIME });
}

/**
 * The ladder's own reading, so the admin's win reward and the matchmaker's TIQ agree by
 * construction. The win reward folds the race credit in, which is why the 140 default still
 * lands exactly the old 120-per-win + 20-per-race.
 */
export function tiqFrom(wins: number, games: number, bonus: number): number {
  return Math.max(0, wins * Math.max(0, runtime.winTiq - RACE_TIQ) + games * RACE_TIQ + bonus);
}
