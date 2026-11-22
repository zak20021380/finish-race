/**
 * ads.ts — the rewarded-video door: AdsGram's controller, one ad at a time, plus the two budgets
 * that keep a free reward from becoming a faucet.
 *
 * The SDK is a CDN `<script async>` in `index.html`, so it may never arrive at all (ad blocker,
 * offline cold start, a blocked CDN). Nothing here may assume it exists: every entry point answers
 * safely with `no_sdk` instead of hanging on a promise that will not settle. The block itself is
 * always configured — `DEFAULT_ADSGRAM_BLOCK_ID` is the production fallback — so the only question
 * the door has to answer is whether the script landed.
 *
 * The caller owns the payout. This module only says whether the view was completed — it never
 * grants TIQ or coins itself, so a reward can be granted exactly once by whoever asked for it.
 */
import { isPremiumUser } from './premium';
import { adoptUserStorageKey, guestId } from './storage';
import { tgInitData } from './telegram';
import { workerUrl } from './adminApi';

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

/** What the caller can tell the door before a video opens. */
export interface AdOptions {
  /**
   * Asked once, after the wait for the async tag and immediately before `show()`. A caller whose
   * surface has already closed answers false, so a slow CDN cannot open a fullscreen video over
   * the menu the player moved to. A refusal is `skipped`: the view never started.
   */
  stillWanted?: () => boolean;
}

const envText = (value: string | undefined): string => (typeof value === 'string' ? value.trim() : '');

/**
 * The live production block, and the floor every build falls back to. Shipping it as the default
 * rather than as a required setting is deliberate: a checkout with no `.env` still serves a real
 * ad, and an environment file only exists when a staging build wants a different inventory.
 */
export const DEFAULT_ADSGRAM_BLOCK_ID = '57100';

const SHARED_BLOCK_ID = envText(import.meta.env?.VITE_ADSGRAM_BLOCK_ID) || DEFAULT_ADSGRAM_BLOCK_ID;
const RECOVER_BLOCK_ID = envText(import.meta.env?.VITE_ADSGRAM_RECOVER_BLOCK_ID) || SHARED_BLOCK_ID;
const COINS_BLOCK_ID = envText(import.meta.env?.VITE_ADSGRAM_COINS_BLOCK_ID) || SHARED_BLOCK_ID;

/** On in a staging build only: the SDK is chatty and the console is a user's phone. */
export const ADSGRAM_DEBUG = envText(import.meta.env?.VITE_ADSGRAM_DEBUG) === 'true';

/**
 * The block this placement serves. A dedicated block wins; otherwise both placements share the
 * one generic block, which is how a single-block account ships before it splits its inventory.
 * `DEFAULT_ADSGRAM_BLOCK_ID` is the floor, so this is never empty in a real build — the door
 * still guards for it, because a build-time constant is not a runtime promise.
 */
export function adBlockId(placement: Placement): string {
  return placement === 'double_coins' ? COINS_BLOCK_ID : RECOVER_BLOCK_ID;
}

/* ---------- waiting for the tag ---------- */

/** How long a desktop tap waits for `sad.min.js` before it answers `no_sdk`. */
const SDK_WAIT_MS_DESKTOP = 3000;
/**
 * A phone gets a tight 1200ms window. The in-app consent card is already on screen with its
 * scrim, so a blocked CDN or a Telegram WebView that never hands control to the SDK must not
 * leave a dimmed screen and a spinning chip: after this beat the door answers `no_sdk`, the
 * caller's in-app modal fallback stays visible, and the spinner is released.
 */
const SDK_WAIT_MS_MOBILE = 1200;

/** The poll's beat while waiting: short enough that a script landing mid-wait feels instant. */
const SDK_POLL_MS = 100;

/** Phone-sized viewports use the fast fallback window; larger screens keep the leisurely one. */
function isMobileViewport(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 480px)').matches;
}

function sdkWaitMs(): number {
  return isMobileViewport() ? SDK_WAIT_MS_MOBILE : SDK_WAIT_MS_DESKTOP;
}

function sdkNow(): AdsgramSdk | undefined {
  return typeof window === 'undefined' ? undefined : window.Adsgram;
}

/**
 * The tag is `async`, so a player can reach the result card before the script does. A bounded wait
 * turns "the CDN was still loading" into a played video instead of a refusal: the chip's spinner is
 * already up, so the beat is legible, and a blocked CDN costs one wait per tap rather than a stuck
 * screen. The bound is the caller's (`sdkWaitMs()`: 1200ms on mobile, 3000ms elsewhere), and it
 * settles on whatever `window.Adsgram` says.
 */
async function waitForSdk(ms: number): Promise<AdsgramSdk | undefined> {
  const ready = sdkNow();
  if (ready) return ready;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => { setTimeout(resolve, SDK_POLL_MS); });
    const sdk = sdkNow();
    if (sdk) return sdk;
  }
  return sdkNow();
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

/* ---------- reporting the view: one receipt, however many retries ---------- */

/** Where a completed view is reported. The room verifies the seat and dedupes on `eventId`. */
const AD_REPORT_PATH = '/api/client/ads/watched';
/** A retry budget for a dropped response: the view already happened, so the count must land. */
const AD_REPORT_ATTEMPTS = 3;
/** The beat between attempts: long enough for a tunnel, short enough to finish before the app closes. */
const AD_REPORT_RETRY_MS = 1400;

/**
 * A fresh idempotency key for one completed view. Every retry of that view re-sends this same id,
 * which is exactly what lets the room fold a duplicated report into the single count it already
 * made. The fallback is not cryptographic — it only has to be unique per view on this device.
 */
function adEventId(): string {
  try {
    const crypto = globalThis.crypto;
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* an older webview: fall through to the stamped key */ }
  return `ad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The same identity headers the telemetry door uses: signed initData, plus the device's seat. */
function adReportHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  const init = tgInitData();
  if (init) headers['x-telegram-init-data'] = init;
  headers['x-guest-id'] = guestId;
  return headers;
}

/**
 * Tell the room that one rewarded video was completed.
 *
 * Fire-and-forget by design: the reward is already the caller's, so analytics may never delay the
 * result card or throw into it. A retry carries the SAME event id, so a response lost on the way
 * back cannot become a second count — the room answers it as a duplicate and the total stands.
 */
function reportAdWatched(placement: Placement, eventId: string): void {
  const url = workerUrl(AD_REPORT_PATH);
  if (!url) return;
  const body = JSON.stringify({ placement, eventId, timestamp: new Date().toISOString() });
  let headers: Record<string, string>;
  try {
    headers = adReportHeaders();
  } catch {
    return;
  }
  const attempt = (left: number): void => {
    try {
      void fetch(url, { method: 'POST', headers, body, keepalive: true })
        .then((res) => {
          /* A refusal is final: a 4xx means this view will never be accepted, so stop asking. */
          if (res.ok || (res.status >= 400 && res.status < 500)) return;
          if (left > 0) window.setTimeout(() => attempt(left - 1), AD_REPORT_RETRY_MS);
        })
        .catch(() => {
          if (left > 0) window.setTimeout(() => attempt(left - 1), AD_REPORT_RETRY_MS);
        });
    } catch {
      /* no fetch in this webview: the game plays on without analytics */
    }
  };
  attempt(AD_REPORT_ATTEMPTS - 1);
}

/* ---------- the door ---------- */

/**
 * Plays one rewarded video for `placement` and reports whether it was completed.
 *
 * Resolves — never rejects. A missing SDK (after one bounded wait for the async tag), a blocked
 * CDN, an empty inventory and an early close are all ordinary outcomes here; the caller decides
 * what to say about them.
 *
 * There is ONE claimable outcome: the promise settles `done === true` with no error, skip or no-fill
 * flag raised. An `onReward` event alone never pays — some builds emit it and still settle an
 * incomplete view, and a reward granted over a skip is worse than a lost one. Listeners and the
 * controller are released in `finally`, so a thrown `show()` cannot leak the mutex and lock every
 * later ad out.
 */
export async function playRewardedAd(
  placement: Placement,
  options: AdOptions = {},
): Promise<AdOutcome> {
  /* a tap that lands while a video is up is dropped, not queued: the first view is the one
     the player agreed to, and paying twice for it would be a bug in our favour */
  if (isShowingAd) return { rewarded: false, reason: 'skipped' };

  const blockId = adBlockId(placement);
  if (!blockId) return { rewarded: false, reason: 'no_sdk' };

  isShowingAd = true;

  let controller: AdsgramController | null = null;
  let skipped = false;
  let noFill = false;
  let errored = false;

  const onSkip: AdsgramListener = () => { skipped = true; };
  const onBannerNotFound: AdsgramListener = () => { noFill = true; };
  const onError: AdsgramListener = () => { errored = true; };

  /** Older builds throw on an event they do not know; a missing listener must not kill the ad. */
  const listen = (event: AdsgramEvent, listener: AdsgramListener) => {
    try { controller?.addEventListener(event, listener); } catch { /* unsupported event */ }
  };

  try {
    /* the tap may beat the async tag: wait a short beat, then answer honestly if it never lands.
       On mobile this is the 1200ms fallback window — past it the in-app modal remains the surface
       the player sees, and the `no_sdk` outcome lets the caller reset its spinner cleanly. */
    const sdk = await waitForSdk(sdkWaitMs());
    if (!sdk) return { rewarded: false, reason: 'no_sdk' };
    /* the wait is long enough for the player to leave: never open a video over another screen */
    if (options.stillWanted && !options.stillWanted()) return { rewarded: false, reason: 'skipped' };

    controller = sdk.init({ blockId, debug: ADSGRAM_DEBUG });
    listen('onSkip', onSkip);
    listen('onBannerNotFound', onBannerNotFound);
    listen('onError', onError);

    let result: AdsgramShowResult | null = null;
    try {
      result = asResult(await controller.show());
    } catch (err) {
      errored = true;
      result = asResult(err);
    }

    /* Denials win over any positive signal: a skip or an error must never pay, even when a
       build also resolves `done: true` on the same view. */
    if (noFill || readsAsNoFill(result)) return { rewarded: false, reason: 'no_fill' };
    if (skipped) return { rewarded: false, reason: 'skipped' };
    if (errored || (result !== null && result.error === true)) {
      return { rewarded: false, reason: 'error' };
    }
    if (result !== null && result.done === true) {
      /* The ONE claimable outcome, and the only place a view is ever reported: the SDK settled
         this one as complete, so it is a real watch — not an impression, a skip or a no-fill. The
         receipt rides along so a retried report can never count it twice. */
      reportAdWatched(placement, adEventId());
      return { rewarded: true };
    }
    /* a clean `done: false` is the SDK's own word for an incomplete view */
    if (result !== null && result.done === false) return { rewarded: false, reason: 'skipped' };
    /* no authoritative completion ever arrived */
    return { rewarded: false, reason: 'error' };
  } catch {
    /* init itself failed: the script is present but unusable (bad id, blocked frame) */
    return { rewarded: false, reason: 'error' };
  } finally {
    try {
      controller?.removeEventListener('onSkip', onSkip);
      controller?.removeEventListener('onBannerNotFound', onBannerNotFound);
      controller?.removeEventListener('onError', onError);
    } catch { /* already torn down */ }
    try { controller?.destroy(); } catch { /* a second destroy is harmless */ }
    isShowingAd = false;
  }
}

/* ---------- the daily recovery budget ---------- */

/** Three free recoveries per rolling day. The fourth is the wall for a free seat. */
export const TIQ_RECOVERY_MAX = 3;
/** A VIP pass carries one extra shield: four recoveries in the same rolling window. */
export const TIQ_RECOVERY_MAX_VIP = TIQ_RECOVERY_MAX + 1;
/** The window is rolling, not midnight-to-midnight: a stamp ages out 24h after it was made. */
export const TIQ_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Its own key, outside the `detour.*` save: a rolling budget is not player progress, but it is
 *  an economy limit, so it belongs to the Telegram account that spent it. */
export const TIQ_RECOVERY_KEY = adoptUserStorageKey('fr_tiq_recovery_log_v1');

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

/** How many recoveries this seat gets in a rolling day: 3 free, 4 for an active VIP. */
export function tiqRecoveryLimit(): number {
  return isPremiumUser() ? TIQ_RECOVERY_MAX_VIP : TIQ_RECOVERY_MAX;
}

/** How many free TIQ recoveries are left in the rolling 24h window, 0 to the seat's limit. */
export function getRemainingTiqRecoveries(): number {
  const limit = tiqRecoveryLimit();
  const left = limit - liveLog(Date.now()).length;
  return Math.max(0, Math.min(limit, left));
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
