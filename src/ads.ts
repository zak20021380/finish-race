/**
 * ads.ts — the rewarded-video door: AdsGram's controller, one ad at a time, plus the two budgets
 * that keep a free reward from becoming a faucet.
 *
 * The SDK is a CDN `<script async>` in `index.html`, so it may never arrive at all (ad blocker,
 * offline cold start, a build with no block id). Nothing here may assume it exists: every entry
 * point answers safely with `no_sdk` instead of hanging on a promise that will not settle.
 *
 * The caller owns the payout. This module only says whether the view was completed — it never
 * grants TIQ or coins itself, so a reward can be granted exactly once by whoever asked for it.
 */

/* ---------- the vendor surface (AdsGram V1) ---------- */

/**
 * Every event a V1 controller emits. `onBannerNotFound` is the no-fill signal — it means the block
 * had nothing to serve, which is a different answer from "the player closed the video early".
 */
export type AdsgramEvent =
  | 'onStart'
  | 'onReward'
  | 'onEnd'
  | 'onError'
  | 'onSkip'
  | 'onBannerNotFound';

/**
 * What `show()` settles with. A completed view resolves `{ done: true }`; a dead one rejects with
 * `error: true` and, on most builds, a description we sniff for the no-fill case.
 */
export interface AdsgramShowResult {
  done?: boolean;
  error?: boolean;
  /** human-readable outcome, e.g. "No ads to show" — the only no-fill evidence on some builds */
  description?: string;
  /** some builds report a machine-readable state instead of a description */
  state?: string;
  /** the reject path occasionally carries its own reason */
  reason?: string;
}

export type AdsgramListener = (event?: AdsgramShowResult) => void;

export interface AdsgramController {
  show(): Promise<AdsgramShowResult>;
  addEventListener(event: AdsgramEvent, listener: AdsgramListener): void;
  removeEventListener(event: AdsgramEvent, listener: AdsgramListener): void;
  /** Releases the SDK's own DOM and listeners. Safe to call after a finished or failed view. */
  destroy(): void;
}

export interface AdsgramSdk {
  /** Builds a controller for one block. `debug` turns on the SDK's console logging. */
  init(options: { blockId: string; debug?: boolean }): AdsgramController;
}

declare global {
  interface Window {
    /** Present only once `sad.min.js` has loaded — see the `<script>` in `index.html`. */
    Adsgram?: AdsgramSdk;
  }
}

/* ---------- configuration ---------- */

export type Placement = 'recover_tiq' | 'double_coins';

/** A failed view, told apart so the UI can say the right thing (or say nothing at all). */
export type AdFailReason = 'no_sdk' | 'no_fill' | 'skipped' | 'error';

export interface AdOutcome {
  rewarded: boolean;
  /** absent on success */
  reason?: AdFailReason;
}

const envText = (value: string | undefined): string => (typeof value === 'string' ? value.trim() : '');

const SHARED_BLOCK_ID = envText(import.meta.env?.VITE_ADSGRAM_BLOCK_ID);
const RECOVER_BLOCK_ID = envText(import.meta.env?.VITE_ADSGRAM_RECOVER_BLOCK_ID) || SHARED_BLOCK_ID;
const COINS_BLOCK_ID = envText(import.meta.env?.VITE_ADSGRAM_COINS_BLOCK_ID) || SHARED_BLOCK_ID;

/** On in a staging build only: the SDK is chatty and the console is a user's phone. */
export const ADSGRAM_DEBUG = envText(import.meta.env?.VITE_ADSGRAM_DEBUG) === 'true';

/**
 * The block this placement serves. A dedicated block wins; otherwise both placements share the
 * one generic block, which is how a single-block account ships before it splits its inventory.
 * An empty string is the honest answer when nothing is configured — `playRewardedAd` reads it as
 * `no_sdk` rather than handing the SDK a nameless block.
 */
export function adBlockId(placement: Placement): string {
  return placement === 'double_coins' ? COINS_BLOCK_ID : RECOVER_BLOCK_ID;
}

/* ---------- the one-at-a-time guard ---------- */

/**
 * AdsGram owns a single fullscreen surface: a second `show()` while one is up is a broken overlay,
 * not a second reward. The flag is module-wide, so two buttons racing each other still serialise.
 */
let isShowingAd = false;

/** True while a rewarded video is on screen — the UI can freeze its taps on this. */
export const isAdPlaying = (): boolean => isShowingAd;

/* ---------- reading the SDK's answer ---------- */

const asResult = (value: unknown): AdsgramShowResult | null =>
  value !== null && typeof value === 'object' ? (value as AdsgramShowResult) : null;

/** No fill, in the several shapes the SDK and its CDN report it. */
const NO_FILL_RE = /no[\s_-]*(ad|ads|fill|banner)|not\s*found|banner[^a-z]*not|unavailable|empty/i;

const readsAsNoFill = (result: AdsgramShowResult | null): boolean => {
  if (!result) return false;
  return NO_FILL_RE.test(`${result.description ?? ''} ${result.state ?? ''} ${result.reason ?? ''}`);
};

/* ---------- the door ---------- */

/**
 * Plays one rewarded video for `placement` and reports whether it was completed.
 *
 * Resolves — never rejects. A missing SDK, an empty block id, a blocked CDN, an empty inventory
 * and an early close are all ordinary outcomes here; the caller decides what to say about them.
 *
 * Reward is granted on the `onReward` event OR on a `{ done: true, error: falsy }` resolution,
 * because builds differ on which one lands first. Listeners and the controller are released in
 * `finally`, so a thrown `show()` cannot leak the mutex and lock every later ad out.
 */
export async function playRewardedAd(placement: Placement): Promise<AdOutcome> {
  /* a tap that lands while a video is up is dropped, not queued: the first view is the one
     the player agreed to, and paying twice for it would be a bug in our favour */
  if (isShowingAd) return { rewarded: false, reason: 'skipped' };

  const sdk = typeof window === 'undefined' ? undefined : window.Adsgram;
  const blockId = adBlockId(placement);
  if (!sdk || !blockId) return { rewarded: false, reason: 'no_sdk' };

  isShowingAd = true;

  let controller: AdsgramController | null = null;
  let rewardedByEvent = false;
  let skipped = false;
  let noFill = false;

  const onReward: AdsgramListener = () => { rewardedByEvent = true; };
  const onSkip: AdsgramListener = () => { skipped = true; };
  const onBannerNotFound: AdsgramListener = () => { noFill = true; };

  /** Older builds throw on an event they do not know; a missing listener must not kill the ad. */
  const listen = (event: AdsgramEvent, listener: AdsgramListener) => {
    try { controller?.addEventListener(event, listener); } catch { /* unsupported event */ }
  };

  try {
    controller = sdk.init({ blockId, debug: ADSGRAM_DEBUG });
    listen('onReward', onReward);
    listen('onSkip', onSkip);
    listen('onBannerNotFound', onBannerNotFound);

    let result: AdsgramShowResult | null = null;
    try {
      result = asResult(await controller.show());
    } catch (err) {
      /* a rejection is still an answer: the payload carries done/error/description */
      result = asResult(err);
    }

    if (rewardedByEvent || (result !== null && result.done === true && !result.error)) {
      return { rewarded: true };
    }
    if (noFill || readsAsNoFill(result)) return { rewarded: false, reason: 'no_fill' };
    if (skipped) return { rewarded: false, reason: 'skipped' };
    /* a clean `done: false` is the SDK's own word for an incomplete view */
    if (result !== null && result.done === false && result.error !== true) {
      return { rewarded: false, reason: 'skipped' };
    }
    return { rewarded: false, reason: 'error' };
  } catch {
    /* init itself failed: the script is present but unusable (bad id, blocked frame) */
    return rewardedByEvent ? { rewarded: true } : { rewarded: false, reason: 'error' };
  } finally {
    try {
      controller?.removeEventListener('onReward', onReward);
      controller?.removeEventListener('onSkip', onSkip);
      controller?.removeEventListener('onBannerNotFound', onBannerNotFound);
    } catch { /* already torn down */ }
    try { controller?.destroy(); } catch { /* a second destroy is harmless */ }
    isShowingAd = false;
  }
}

/* ---------- the daily recovery budget ---------- */

/** Three free recoveries per rolling day. The fourth is the wall. */
export const TIQ_RECOVERY_MAX = 3;
/** The window is rolling, not midnight-to-midnight: a stamp ages out 24h after it was made. */
export const TIQ_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Its own key, outside the `detour.*` save: a rolling budget is not player progress. */
export const TIQ_RECOVERY_KEY = 'fr_tiq_recovery_log_v1';

/**
 * The live log. Hydrated from storage once, then held in memory so a webview that refuses
 * localStorage still enforces the limit for this session instead of handing out free recoveries.
 */
let log: number[] | null = null;

function readStoredLog(): number[] {
  try {
    const raw = window.localStorage.getItem(TIQ_RECOVERY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function persist(next: number[]) {
  try { window.localStorage.setItem(TIQ_RECOVERY_KEY, JSON.stringify(next)); } catch { /* stay in memory */ }
}

/**
 * The stamps still inside the window, oldest first. A stamp from the future (the device clock was
 * moved back) stays in: counting it is the safe direction, since it only ever costs the player.
 */
function liveLog(now: number): number[] {
  if (log === null) log = readStoredLog();
  log = log.filter((at) => now - at < TIQ_RECOVERY_WINDOW_MS).sort((a, b) => a - b);
  return log;
}

/** How many free TIQ recoveries are left in the rolling 24h window, 0 to 3. */
export function getRemainingTiqRecoveries(): number {
  const left = TIQ_RECOVERY_MAX - liveLog(Date.now()).length;
  return Math.max(0, Math.min(TIQ_RECOVERY_MAX, left));
}

/** Spend one recovery. Call it only after the ad actually paid — the stamp is the receipt. */
export function recordTiqRecovery(): void {
  const now = Date.now();
  const next = [...liveLog(now), now];
  log = next;
  persist(next);
}

/* ---------- per-match claims ---------- */

/**
 * What this race has already paid for. A match is a fresh budget: the same placement may pay once
 * per match even though the daily recovery log is still ticking, which is why these are separate.
 */
const matchClaims = new Set<string>();

/** True once this match has already paid for `placement` — the second tap must not pay twice. */
export function hasClaimedInMatch(placement: string): boolean {
  return matchClaims.has(placement);
}

export function markClaimedInMatch(placement: string): void {
  if (typeof placement === 'string' && placement.length > 0) matchClaims.add(placement);
}

/** Called when a fresh match starts: the claims belong to the race that made them. */
export function resetMatchClaims(): void {
  matchClaims.clear();
}
