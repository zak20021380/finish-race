/**
 * badges.ts — the Genius Triad: three prestige honors, one per player archetype.
 *
 * The catalogue is static and the unlock state is derived from the live save, so
 * a half-written localStorage blob can never smuggle a badge in. Only the
 * equipped badge id persists (profile.badge under detour.save.v2) — the same
 * single-key contract storage.ts already owns.
 *
 * Each archetype answers to a different proof:
 * - Churchill's Bastion  — Resilience: 10,000 TIQ and a 7-win live-PvP streak, defense held.
 * - Einstein's Singularity — Pure Intellect: the 1,500 TIQ threshold.
 * - Heisenberg's Formula — Calculated Precision: a 60% win rate over 5+ races.
 *
 * Each honor is also a numbered edition. The cap is fixed, and the serial is minted by
 * the Worker's singleton ledger (`GET /api/badges/supply`, `POST /api/badges/mint`) — never
 * invented on this device. The save only caches the last server-confirmed serial and supply
 * reading, so an offline shelf still shows the truth it last heard and a subtle syncing state
 * while it tries again.
 *
 * Ids are stable; the crest symbol and the CSS aura are both keyed by `accent`,
 * so a badge is one data row plus one #i-crest-<accent> in index.html. A badge
 * that ships rendered art paints that medallion instead, on every surface.
 */

import { cacheBadgeClaim, cacheBadgeSupply, guestId, ladderWins, profile, type EditionClaim, type EditionSupply } from './storage';
import { myTiq } from './matchmaking';
import { workerUrl } from './adminApi';
import { tgInitData, tgUser } from './telegram';
import churchillArt from './assets/images/Futuristic Churchill Steel Medallion.png';
import einsteinArt from './assets/images/einstein.png';
import heisenbergArt from './assets/images/Heisenberg Chrome Medallion.png';

/**
 * The three medallion renders, imported as static ES module URLs. Vite hashes and emits each PNG
 * and resolves the base path, so the URL is known synchronously and cannot be lost to a dropped
 * lazy chunk. The files are case-matched to these imports:
 *   Futuristic Churchill Steel Medallion.png / einstein.png / Heisenberg Chrome Medallion.png
 */
const medallionArt: Record<string, string> = {
  churchill: churchillArt,
  einstein: einsteinArt,
  heisenberg: heisenbergArt,
};

export type BadgeAccent = 'titanium' | 'quantum' | 'frost';

/** Collector copy written for each supported language; other locales read English. */
export interface BadgeText {
  en: string;
  fa: string;
}

/** One passive prestige an honor grants while it is worn, read on its certificate. */
export interface BadgePerk {
  /** The glyph printed in the perk row's own well. */
  icon: string;
  text: BadgeText;
}

/**
 * A privilege the relic's owner holds while it is worn. Unlike `perks`, these are the collector's
 * charter — profile aura, chat sigil, hall record — and only the honors that actually carry one
 * print the module. `{serial}` is stamped from the same ledger reading as the plaque.
 */
export interface BadgePrivilege {
  /** The shared glyph id painted in the privilege's own well, without the leading #. */
  icon: string;
  text: BadgeText;
}

/** The numeric gates behind an honor's mission, when one proof is not enough. */
export interface BadgeRequirement {
  minTiq?: number;
  /** Consecutive live-PvP wins, each one finished with defense at or above the floor. */
  pvpStreak?: number;
  /** Lowest share of a seat's wall budget (0..1) a win may end with and still extend the run. */
  minDefenseHealth?: number;
}

/** Mirrored by the mint gate in worker/badges.ts; the ids are the catalogue's own. */
export const BADGE_REQUIREMENTS = {
  churchill_bastion: { minTiq: 10000, pvpStreak: 7, minDefenseHealth: 0.50 },
} as const satisfies Record<string, BadgeRequirement>;

export interface BadgeDef {
  id: string;
  name: string;
  /** The character the medal carries: the card's first line. */
  figure: string;
  /** The shortened archetype name printed on the shelf tile. */
  archetype: string;
  /** The psychological pillar the archetype represents. */
  pillar: string;
  /** One sentence of archetype copy, used by the pin spotlight and shelf tiles. */
  description: string;
  /** The unlock mission in plain player-facing words. */
  criteria: BadgeText;
  /** Numeric gates behind the mission; the inspection card renders them as requirement chips. */
  requirement?: BadgeRequirement;
  /** The passive prestige this honor grants while worn; its certificate lists them. */
  perks: BadgePerk[];
  /** The owner's charter, printed on the collector card while the honor is held. */
  privileges?: BadgePrivilege[];
  /** Names the sculpted crest (#i-crest-<accent>), its CSS aura, and the art fallback. */
  accent: BadgeAccent;
  /** Vite-hashed URL of the rendered medallion; when set it replaces the vector crest. */
  art?: string;
  /** Hard edition cap. Mirrors `BADGE_CAPS` in worker/badges.ts; never mint above it. */
  cap: number;
}

export const GENIUS_TRIAD: readonly BadgeDef[] = [
  {
    id: 'churchill_bastion',
    name: "Churchill's Bastion",
    figure: 'Churchill',
    archetype: 'The Bastion',
    pillar: 'Resilience',
    description: 'Unyielding defence and comeback mastery. Holds the line until the board breaks.',
    criteria: {
      en: 'Requires 10,000+ TIQ. Win 7 consecutive live PvP battles while keeping defensive integrity above 50%. Hold the line.',
      fa: 'نیاز به حداقل ۱۰,۰۰۰ TIQ. کسب ۷ برد پیاپی در نبرد زنده PvP با حفظ بیش از ۵۰٪ استحکامات دفاعی. خط دفاعی رو حفظ کن!',
    },
    requirement: BADGE_REQUIREMENTS.churchill_bastion,
    perks: [
      {
        icon: '🛡️',
        text: {
          en: 'Unbroken Defense Aura in Live Arena',
          fa: 'هالهٔ دفاع شکست‌ناپذیر در آرینای زنده',
        },
      },
      {
        icon: '⚡',
        text: {
          en: '+5% Coin bonus on consecutive victories',
          fa: '+۵٪ سکهٔ اضافه روی بردهای پیاپی',
        },
      },
    ],
    accent: 'titanium',
    art: medallionArt.churchill,
    cap: 100,
  },
  {
    id: 'einstein_singularity',
    name: "Einstein's Singularity",
    figure: 'Einstein',
    archetype: 'The Singularity',
    pillar: 'Pure Intellect',
    description: 'Spatial foresight and zero-error calculation. Sees the whole board before the first move.',
    criteria: {
      en: 'Reach 1,500 TIQ in ranked matches.',
      fa: 'رسیدن به امتیاز ۱۵۰۰ با برد در مسابقات رتبه‌بندی.',
    },
    perks: [
      {
        icon: '🔭',
        text: {
          en: 'Board Foresight Aura in Ranked Qualifiers',
          fa: 'هالهٔ پیش‌نگری صفحه در مقدماتی رنکد',
        },
      },
      {
        icon: '⚡',
        text: {
          en: '+5% Coin bonus on a zero-error run',
          fa: '+۵٪ سکهٔ اضافه روی یک ران بی‌خطا',
        },
      },
    ],
    privileges: [
      {
        icon: 'i-crown',
        text: {
          en: 'Glowing gold avatar frame in rankings',
          fa: 'حاشیه طلایی درخشان دور آواتار در جدول رنکینگ',
        },
      },
      {
        icon: 'i-medal',
        text: {
          en: 'Official {serial} badge on your profile',
          fa: 'پلاک رسمی نشان ({serial}) روی پروفایل شما',
        },
      },
    ],
    accent: 'quantum',
    art: medallionArt.einstein,
    cap: 50,
  },
  {
    id: 'heisenberg_formula',
    name: "Heisenberg's Formula",
    figure: 'Heisenberg',
    archetype: 'The Formula',
    pillar: 'Calculated Precision',
    description: 'Flawless tactical execution and cold dominance. Wins before the race begins.',
    criteria: {
      en: 'Win 60% of at least 5 competitive races. No luck, no wasted moves—just cold execution.',
      fa: 'حداقل 5 مسابقهٔ رقابتی بازی کن و 60٪شون رو ببر. نه شانس، نه حرکت هدر؛ فقط اجرای سرد و دقیق.',
    },
    perks: [
      {
        icon: '🎯',
        text: {
          en: 'Cold Precision Marker in Live Arena',
          fa: 'نشانگر دقت سرد در آرینای زنده',
        },
      },
      {
        icon: '⚡',
        text: {
          en: '+5% Coin bonus on a flawless win',
          fa: '+۵٪ سکهٔ اضافه روی برد بی‌نقص',
        },
      },
    ],
    accent: 'frost',
    art: medallionArt.heisenberg,
    cap: 25,
  },
];

/** Back-compat alias: the catalogue is the triad. */
export const BADGES = GENIUS_TRIAD;

export const badgeById = (id: string | null | undefined): BadgeDef | null =>
  BADGES.find((b) => b.id === id) ?? null;

/** The catalogue copy in the active language; unsupported locales read the English edition. */
export const badgeText = (text: BadgeText, code: string): string =>
  (code === 'fa' ? text.fa : text.en);

/* ---------- rendered medallion art: eager img, retry with backoff, shimmer ---------- */

/**
 * Backoff schedule for a medallion that fails to paint. A crest starts on the plain hashed URL
 * (attempt 0); each failure adds a cache-busting `?r=N` and waits a little longer. Only after all
 * 3 retries fail does the clean vector silhouette show, so one transient WebView hiccup can never
 * strand a badge on its flat fallback.
 */
const ART_RETRY_DELAYS = [400, 1200, 2500] as const;
/** Preloaded images are held so the browser does not abandon the background fetch. */
const artPreloads: HTMLImageElement[] = [];

interface RetryImage extends HTMLImageElement {
  /** Pending retry timer, cleared when the crest is re-triggered. */
  badgeRetryTimer?: number;
}

/** Append a retry query param, keeping any query string already on the URL. */
const withRetry = (url: string, attempt: number): string =>
  `${url}${url.includes('?') ? '&' : '?'}r=${attempt}`;

/** Put a crest back into its loading state and ask the browser to fetch the plain URL again. */
function restartBadgeArt(img: HTMLImageElement): void {
  const frame = img.closest<HTMLElement>('.badge-art-frame');
  if (!frame) return;
  const retry = img as RetryImage;
  if (retry.badgeRetryTimer) {
    window.clearTimeout(retry.badgeRetryTimer);
    retry.badgeRetryTimer = undefined;
  }
  const base = img.dataset.badgeArtBase;
  if (!base) return;
  img.dataset.badgeArtAttempt = '0';
  frame.classList.remove('is-fallback', 'is-loaded');
  frame.classList.add('is-loading');
  img.src = base;
}

/** Schedule the next retry for a crest whose image just failed. */
function retryBadgeArt(img: HTMLImageElement): void {
  const frame = img.closest<HTMLElement>('.badge-art-frame');
  if (!frame) return;
  const attempt = Number(img.dataset.badgeArtAttempt ?? '0');
  if (attempt >= ART_RETRY_DELAYS.length) {
    /* All 3 retries failed: show the vector silhouette, but keep the img mounted so a later
       drawer open can warm it again through `reloadFailedBadgeArt`. */
    frame.classList.remove('is-loading', 'is-loaded');
    frame.classList.add('is-fallback');
    return;
  }
  const next = attempt + 1;
  img.dataset.badgeArtAttempt = String(next);
  frame.classList.add('is-loading');
  const retry = img as RetryImage;
  const base = img.dataset.badgeArtBase;
  if (!base) return;
  retry.badgeRetryTimer = window.setTimeout(() => {
    retry.badgeRetryTimer = undefined;
    if (!img.isConnected) return;
    img.src = withRetry(base, next);
  }, ART_RETRY_DELAYS[attempt]);
}

/** A crest has painted: drop the shimmer and keep the artwork visible. */
function badgeArtLoaded(img: HTMLImageElement): void {
  const frame = img.closest<HTMLElement>('.badge-art-frame');
  if (!frame) return;
  const retry = img as RetryImage;
  if (retry.badgeRetryTimer) {
    window.clearTimeout(retry.badgeRetryTimer);
    retry.badgeRetryTimer = undefined;
  }
  frame.classList.remove('is-loading', 'is-fallback');
  frame.classList.add('is-loaded');
}

if (typeof document !== 'undefined') {
  /* `load` and `error` do not bubble, so catch them in the capture phase on the document. That
     keeps the retry logic in one place even though every surface paints crests via innerHTML. */
  document.addEventListener('load', (e) => {
    const img = e.target as HTMLImageElement | null;
    if (img && img.tagName === 'IMG' && img.hasAttribute('data-badge-art-base')) badgeArtLoaded(img);
  }, true);
  document.addEventListener('error', (e) => {
    const img = e.target as HTMLImageElement | null;
    if (img && img.tagName === 'IMG' && img.hasAttribute('data-badge-art-base')) retryBadgeArt(img);
  }, true);
}

/**
 * Warm all three medallions in the background shortly after startup. Holding the Image objects —
 * not just setting src on a temporary — keeps the fetch alive until the browser has cached it.
 */
export function preloadBadgeArt(): void {
  if (typeof Image === 'undefined') return;
  for (const url of Object.values(medallionArt)) {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    artPreloads.push(img);
  }
}

/**
 * Called whenever the Profile shelf or a badges drawer is (re)opened: any crest already showing
 * its vector fallback, and any crest that never finished loading, is asked to load again from the
 * plain URL. A crest mid-retry is left alone so its backoff is never reset.
 */
export function reloadFailedBadgeArt(root: ParentNode = document): void {
  for (const frame of root.querySelectorAll<HTMLElement>('.badge-art-frame')) {
    const img = frame.querySelector<HTMLImageElement>('img[data-badge-art-base]');
    if (!img) continue;
    if (img.complete && img.naturalWidth > 0) {
      /* decoded from cache but the load event was missed: settle it now */
      badgeArtLoaded(img);
      continue;
    }
    const failed = frame.classList.contains('is-fallback');
    const stuck = !frame.classList.contains('is-loading') && img.complete && img.naturalWidth === 0;
    if (failed || stuck) restartBadgeArt(img);
  }
}

/**
 * The honor's crest as markup: its rendered medallion when one ships, else the
 * vector silhouette keyed by accent. Decorative — every host names the badge.
 *
 * A rendered crest is a circular, GPU-promoted frame with an eager <img>, a hidden vector
 * fallback and a subtle loading shimmer. The image load/error handlers above own the retry and
 * fallback states via the frame's `is-loading` / `is-loaded` / `is-fallback` classes.
 */
export function badgeCrestHtml(def: BadgeDef, className = 'badge-crest'): string {
  if (def.art) {
    const sheen = `<span class="medal-sheen" data-badge="${def.id}" aria-hidden="true"></span>`;
    const fallback = `<span class="badge-art-fallback" aria-hidden="true">`
      + `<svg class="${className}" viewBox="0 0 56 56" aria-hidden="true"><use href="#i-crest-${def.accent}" /></svg>`
      + `</span>`;
    return `<span class="badge-art-frame is-loading" aria-hidden="true">`
      + fallback
      + `<img class="${className} badge-crest-art" src="${def.art}" alt="" aria-hidden="true" draggable="false" loading="eager" decoding="async"`
      + ` data-badge="${def.id}" data-badge-art-base="${def.art}" data-badge-art-attempt="0" />`
      + `<span class="badge-art-shimmer"></span>`
      + `</span>` + sheen;
  }
  return `<svg class="${className}" viewBox="0 0 56 56" aria-hidden="true">`
    + `<use href="#i-crest-${def.accent}" /></svg>`;
}

const en = (n: number) => n.toLocaleString('en-US');

/** One row of a multi-gate mission, ready for a requirement chip. */
export interface BadgeRequirementProgress {
  kind: 'tiq' | 'streak';
  got: number;
  need: number;
  /** 0..1, ready for a meter or an aria-valuenow ratio. */
  pct: number;
  met: boolean;
}

export interface BadgeProgress {
  got: number;
  need: number;
  /** 0..1, ready for meters and aria-valuenow ratios. */
  pct: number;
  /** The requirement's own unit, e.g. "2/3 win streak" or "62% win rate". */
  label: string;
  met: boolean;
  /** Present when the honor gates on more than one proof, and rendered as chips. */
  requirements?: BadgeRequirementProgress[];
}

/** Live progress against a badge's requirement — the same read the shelf and sheet use. */
export function badgeProgress(id: string): BadgeProgress {
  const s = profile.stats;
  switch (id) {
    case 'churchill_bastion': {
      const req = BADGE_REQUIREMENTS.churchill_bastion;
      const tiq = Math.max(0, myTiq());
      const streak = Math.max(0, s.pvpBest);
      const requirements: BadgeRequirementProgress[] = [
        {
          kind: 'tiq',
          got: tiq,
          need: req.minTiq,
          pct: Math.min(1, tiq / req.minTiq),
          met: tiq >= req.minTiq,
        },
        {
          kind: 'streak',
          got: streak,
          need: req.pvpStreak,
          pct: Math.min(1, streak / req.pvpStreak),
          met: streak >= req.pvpStreak,
        },
      ];
      const hold = requirements.find((r) => !r.met);
      return {
        got: hold?.got ?? req.pvpStreak,
        need: hold?.need ?? req.pvpStreak,
        pct: Math.min(...requirements.map((r) => r.pct)),
        label: hold
          ? hold.kind === 'tiq'
            ? `${en(hold.got)} / ${en(hold.need)} TIQ`
            : `${hold.got}/${hold.need} PvP streak`
          : `${en(req.minTiq)} TIQ · ${streak} PvP streak`,
        met: requirements.every((r) => r.met),
        requirements,
      };
    }
    case 'einstein_singularity': {
      const need = 1500;
      const got = Math.max(0, myTiq());
      return {
        got,
        need,
        pct: Math.min(1, got / need),
        label: `${en(got)} / ${en(need)} TIQ`,
        met: got >= need,
      };
    }
    case 'heisenberg_formula': {
      if (s.games < 5) {
        const got = Math.min(Math.max(0, s.games), 5);
        return { got, need: 5, pct: got / 5, label: `${got}/5 races`, met: false };
      }
      const rate = Math.round((s.wins / s.games) * 100);
      return {
        got: rate,
        need: 60,
        pct: Math.min(1, rate / 60),
        label: `${rate}% / 60% wins`,
        met: rate >= 60,
      };
    }
    default:
      return { got: 0, need: 1, pct: 0, label: 'Locked', met: false };
  }
}

export function isBadgeUnlocked(id: string): boolean {
  return badgeById(id) !== null && badgeProgress(id).met;
}

/** The requirement's progress in the detail sheet's own words, localized. */
export function badgeProgressText(id: string, code: string = 'en'): string {
  const fa = code === 'fa';
  const p = badgeProgress(id);
  switch (id) {
    case 'churchill_bastion': {
      const req = BADGE_REQUIREMENTS.churchill_bastion;
      const tiq = Math.max(0, myTiq());
      const streak = Math.max(0, profile.stats.pvpBest);
      return fa
        ? `${en(tiq)} از ${en(req.minTiq)} هوش تاکتیکی · ${streak} از ${req.pvpStreak} برد پیاپی زنده`
        : `${en(tiq)} of ${en(req.minTiq)} Tactical IQ · ${streak} of ${req.pvpStreak} live PvP wins in a row`;
    }
    case 'einstein_singularity':
      return fa ? `${en(p.got)} از 1,500 هوش تاکتیکی` : `${en(p.got)} of 1,500 Tactical IQ`;
    case 'heisenberg_formula': {
      if (profile.stats.games < 5) {
        return fa ? `${p.got} از 5 مسابقه` : `${p.got} of 5 races`;
      }
      return fa ? `${p.got}٪ از 60٪ نرخ برد` : `${p.got}% of 60% wins`;
    }
    default:
      return fa ? 'قفل' : 'Locked';
  }
}

/** The next step in the requirement's own unit — "3 more wins in a row". */
export function badgeDelta(id: string, code: string = 'en'): string {
  const fa = code === 'fa';
  const p = badgeProgress(id);
  if (p.met) return fa ? 'شرط تکمیل شده' : 'Requirement met';
  switch (id) {
    case 'churchill_bastion': {
      const req = BADGE_REQUIREMENTS.churchill_bastion;
      const tiq = Math.max(0, myTiq());
      if (tiq < req.minTiq) {
        const n = Math.max(1, req.minTiq - tiq);
        return fa ? `${en(n)} امتیاز هوش تاکتیکی دیگه` : `${en(n)} more TIQ`;
      }
      const n = Math.max(1, req.pvpStreak - Math.max(0, profile.stats.pvpBest));
      return fa
        ? `${n} برد پیاپی دیگه در PvP زنده`
        : `${n} more consecutive live PvP win${n === 1 ? '' : 's'}`;
    }
    case 'einstein_singularity': {
      const n = Math.max(1, 1500 - Math.max(0, myTiq()));
      return fa ? `${en(n)} امتیاز هوش تاکتیکی دیگه` : `${en(n)} more TIQ`;
    }
    case 'heisenberg_formula': {
      const games = Math.max(0, profile.stats.games);
      const wins = Math.max(0, Math.min(games, profile.stats.wins));
      if (games < 5) {
        const n = 5 - games;
        return fa ? `${n} مسابقهٔ دیگه برای احراز شرایط` : `${n} more race${n === 1 ? '' : 's'} to qualify`;
      }
      /* A win without a loss closes the rate gap fastest: (wins+k)/(games+k) >= .6. */
      const k = Math.max(0, Math.ceil(games * 1.5 - wins * 2.5));
      if (k > 0) return fa ? `${k} برد پیاپی دیگه` : `${k} more win${k === 1 ? '' : 's'} in a row`;
      return fa ? 'شرط تکمیل شده' : 'Requirement met';
    }
    default:
      return fa ? 'قفل' : 'Locked';
  }
}

/* ---------- server-minted editions ---------- */

export type EditionSyncState = 'idle' | 'syncing' | 'live' | 'offline';

export interface EditionHolder {
  serial: number;
  /** Verified Telegram display name from the ledger. */
  name: string;
  /** The holder's matchmaker session id, when the ledger knows it — the challenge's address. */
  playerId?: string;
}

export interface BadgeEdition {
  cap: number;
  /** The player's server-confirmed serial, or null until the ledger answers. */
  serial: number | null;
  /** Serials already claimed globally, or null before the first supply reading. */
  minted: number | null;
  /** Unclaimed serials left in the edition, or null before the first supply reading. */
  remaining: number | null;
  /** A mint roundtrip is in flight for this honor. */
  minting: boolean;
  /** Earned locally, but this device has no confirmed serial yet. */
  awaiting: boolean;
  /** The ledger says every slot is gone and this player holds none of them. */
  exhausted: boolean;
}

interface WireSupplyRow { cap?: unknown; minted?: unknown; remaining?: unknown; holders?: unknown }
interface WireMint {
  success?: unknown;
  serial?: unknown;
  cap?: unknown;
  mintedAt?: unknown;
  minted?: unknown;
  error?: unknown;
}

const BADGE_TIMEOUT = 4000;
const pad3 = (n: number) => String(n).padStart(3, '0');

/** "#042" — the serial as every surface prints it. */
export const editionSerialLabel = (serial: number): string => `#${pad3(serial)}`;

let syncState: EditionSyncState = 'idle';
let inFlight: Promise<void> | null = null;
const minting = new Set<string>();
const exhausted = new Set<string>();
/** Honors verified by the Worker during this page's life, so a route revisit is not a re-mint. */
const confirmed = new Set<string>();
/** The public holder index from the last live supply reading; never persisted or invented. */
const liveHolders = new Map<string, EditionHolder[]>();
const listeners = new Set<() => void>();

/** Subscribe to cache/mint transitions; returns the unsubscribe. */
export function onEditionChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function editionChanged(): void {
  for (const cb of listeners) {
    try { cb(); } catch { /* one listener must not stop the rest */ }
  }
}

export const editionSyncState = (): EditionSyncState => syncState;

function readHolders(raw: unknown, cap: number): EditionHolder[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<number>();
  const rows: EditionHolder[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const row = value as { serial?: unknown; name?: unknown; playerId?: unknown };
    if (typeof row.serial !== 'number' || !Number.isInteger(row.serial) || row.serial < 1 || row.serial > cap) continue;
    if (seen.has(row.serial)) continue;
    seen.add(row.serial);
    const name = typeof row.name === 'string' ? row.name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) : '';
    const playerId = typeof row.playerId === 'string'
      ? row.playerId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
      : '';
    rows.push({ serial: row.serial, name: name || 'Unlisted', ...(playerId ? { playerId } : {}) });
  }
  return rows.sort((a, b) => a.serial - b.serial);
}

/** The same name the Worker derives from verified initData, so an optimistic row cannot disagree. */
function localHolderName(): string {
  const u = tgUser();
  const full = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
  return (full || u?.username || 'Player').slice(0, 20) || 'Player';
}

/** Add this player's fresh serial to a live index without waiting for the next supply read. */
function noteOwnHolder(id: string, serial: number): void {
  const current = liveHolders.get(id);
  if (!current || current.some((h) => h.serial === serial)) return;
  liveHolders.set(id, [...current, { serial, name: localHolderName() }].sort((a, b) => a.serial - b.serial));
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function claimOf(id: string): EditionClaim | null {
  const def = badgeById(id);
  if (!def) return null;
  const claim = profile.editions.claims[id];
  if (!claim || !Number.isFinite(claim.serial) || claim.serial < 1 || claim.serial > def.cap) return null;
  return claim;
}

function supplyOf(def: BadgeDef): EditionSupply | null {
  const row = profile.editions.supply[def.id];
  if (!row || !Number.isFinite(row.minted) || !Number.isFinite(row.remaining)) return null;
  return {
    cap: def.cap,
    minted: Math.max(0, Math.min(def.cap, Math.floor(row.minted))),
    remaining: Math.max(0, Math.min(def.cap, Math.floor(row.remaining))),
  };
}

export const hasEditionClaim = (id: string): boolean => claimOf(id) !== null;

/** When this device's own serial was minted, as the ledger reported it; '' when it never said. */
export function claimMintedAt(id: string): string {
  return claimOf(id)?.mintedAt ?? '';
}

/**
 * The public hall of fame for one honor, in serial order.
 *
 * Null means the ledger has never answered for this badge in this page's life — an empty array
 * is a different fact: the edition is confirmed unclaimed. Callers must not draw a conclusion
 * the supply reading did not give them.
 */
export function badgeHolders(id: string): EditionHolder[] | null {
  const holders = liveHolders.get(id);
  return holders ? [...holders] : null;
}

/** A live supply payload, folded to the catalogue; null when it held none of our three ids. */
function readSupply(raw: unknown): Record<string, EditionSupply> | null {
  const badges = raw && typeof raw === 'object' ? (raw as { badges?: unknown }).badges : null;
  if (!badges || typeof badges !== 'object' || Array.isArray(badges)) return null;
  const table = badges as Record<string, WireSupplyRow>;
  const out: Record<string, EditionSupply> = {};
  let found = false;
  for (const def of BADGES) {
    const row = table[def.id];
    if (!row || typeof row !== 'object') continue;
    const minted = num(row.minted);
    const remaining = num(row.remaining);
    if (minted === null && remaining === null) continue;
    const m = Math.max(0, Math.min(def.cap, Math.floor(minted ?? def.cap - (remaining ?? 0))));
    const r = Math.max(0, Math.min(def.cap, Math.floor(remaining ?? def.cap - m)));
    out[def.id] = { cap: def.cap, minted: m, remaining: r };
    const holders = readHolders(row.holders, def.cap);
    if (holders) liveHolders.set(def.id, holders);
    else liveHolders.delete(def.id);
    found = true;
  }
  return found ? out : null;
}

function readMinted(raw: unknown, cap: number): EditionClaim | null {
  const body = raw && typeof raw === 'object' ? (raw as WireMint) : null;
  const serial = num(body?.serial);
  if (serial === null || !Number.isInteger(serial) || serial < 1 || serial > cap) return null;
  return {
    serial,
    cap,
    mintedAt: typeof body?.mintedAt === 'string' ? body.mintedAt.slice(0, 40) : '',
  };
}

function writeSupplyRow(def: BadgeDef, minted: number) {
  const capped = Math.max(0, Math.min(def.cap, Math.floor(minted)));
  cacheBadgeSupply({
    ...profile.editions.supply,
    [def.id]: { cap: def.cap, minted: capped, remaining: def.cap - capped },
  }, profile.editions.syncedAt);
}

export function badgeEdition(id: string): BadgeEdition {
  const def = badgeById(id);
  if (!def) {
    return { cap: 0, serial: null, minted: null, remaining: null, minting: false, awaiting: false, exhausted: false };
  }
  const claim = claimOf(def.id);
  const supply = supplyOf(def);
  const unlocked = isBadgeUnlocked(def.id);
  const drained = exhausted.has(def.id) || (supply !== null && supply.remaining <= 0);
  return {
    cap: def.cap,
    serial: claim?.serial ?? null,
    minted: supply?.minted ?? null,
    remaining: supply?.remaining ?? null,
    minting: minting.has(def.id) || (syncState === 'syncing' && unlocked && !claim && !drained),
    awaiting: unlocked && !claim && !drained,
    exhausted: !claim && drained,
  };
}

export type BadgeStatusKind = 'equipped' | 'serial' | 'unlocked' | 'minting' | 'editions';

export interface BadgeStatus {
  kind: BadgeStatusKind;
  /** The card's third line: "EQUIPPED", "#042 / 100", "UNLOCKED" or "25 EDITIONS". */
  text: string;
}

/**
 * What the player holds, in the card's own words — never a network state.
 * Equipped outranks the serial; an earned honor with no confirmed mint reads
 * UNLOCKED, and an unowned one offers its edition cap as a rarity tag.
 */
export function badgeStatus(id: string, equipped: boolean): BadgeStatus {
  const def = badgeById(id);
  if (!def) return { kind: 'editions', text: '—' };
  if (equipped) return { kind: 'equipped', text: 'EQUIPPED' };
  const ed = badgeEdition(def.id);
  /* `№ 001 / 100` — the edition plate is a ledger code, so it keeps its Latin figures and its
     numero sign in every language; only the number is a number. */
  if (ed.serial !== null) return { kind: 'serial', text: `№ ${pad3(ed.serial)} / ${ed.cap}` };
  if (ed.minting) return { kind: 'minting', text: 'MINTING…' };
  if (isBadgeUnlocked(def.id)) return { kind: 'unlocked', text: 'UNLOCKED' };
  return { kind: 'editions', text: `${def.cap} EDITIONS` };
}

/** The same state, spelled for a screen reader. */
export function editionSpeech(ed: BadgeEdition): string {
  if (ed.serial !== null) return `Edition ${ed.serial} of ${ed.cap}.`;
  if (ed.minting) return `Minting your edition of ${ed.cap}.`;
  if (ed.exhausted) return `All ${ed.cap} editions are claimed.`;
  if (ed.remaining !== null) return `${ed.remaining} of ${ed.cap} editions remaining.`;
  if (ed.awaiting) return 'Edition not minted yet.';
  return 'Edition supply syncing.';
}

/* ---------- the wire ---------- */

interface BadgeReply { ok: boolean; status: number; body: unknown }

async function badgeCall(path: string, init: RequestInit): Promise<BadgeReply | null> {
  const url = workerUrl('/api/badges');
  if (!url) return null;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.headers) Object.assign(headers, init.headers as Record<string, string>);
  const initData = tgInitData();
  if (initData) headers['x-telegram-init-data'] = initData;
  headers['x-guest-id'] = guestId;

  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), BADGE_TIMEOUT);
  try {
    const res = await fetch(`${url}${path}`, { ...init, headers, signal: ac.signal });
    let body: unknown = null;
    let parsed = false;
    try { body = await res.json(); parsed = true; } catch { /* empty or not JSON */ }
    /* A static host's SPA fallback answers 200 with index.html; that is not a ledger. */
    return { ok: res.ok && parsed, status: res.status, body };
  } catch {
    return null;                // offline, refused, or too slow: cached state stays up
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Fetch the live supply, push this player's progress snapshot, then mint every locally
 * unlocked honor the Worker has not confirmed this session. A failed call only flips the
 * sync state; it never throws and never clears the cached snapshot.
 */
export async function refreshBadgeEditions(): Promise<void> {
  if (inFlight) return inFlight;
  syncState = 'syncing';
  editionChanged();

  const snapshot = {
    tiq: myTiq(),
    games: profile.stats.games,
    /* PvP-only: a bot victory must never mint a competitive honor on the server. */
    wins: ladderWins(),
    streak: profile.stats.streak,
    best: profile.stats.best,
    pvpBest: profile.stats.pvpBest,
  };

  inFlight = (async () => {
    const [supplyReply, progressReply] = await Promise.all([
      badgeCall('/supply', { method: 'GET' }),
      badgeCall('/progress', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshot),
      }),
    ]);

    let supplyLive = false;
    if (supplyReply?.ok) {
      const live = readSupply(supplyReply.body);
      if (live) {
        cacheBadgeSupply({ ...profile.editions.supply, ...live }, Date.now());
        supplyLive = true;
      }
    }

    const progressLive = progressReply?.ok
      && Boolean(progressReply.body && typeof progressReply.body === 'object'
        && (progressReply.body as { success?: unknown }).success === true);

    /* A refused mint is not a transport failure: 403 is the ledger's criteria answer and 409 is
       an edition that is simply gone. Anything else means the roundtrip itself did not land. */
    let mintBroken = false;

    if (progressLive) {
      for (const def of BADGES) {
        if (!isBadgeUnlocked(def.id) || confirmed.has(def.id) || exhausted.has(def.id)) continue;
        const supply = supplyOf(def);
        if (supply !== null && supply.remaining <= 0 && !claimOf(def.id)) {
          exhausted.add(def.id);
          continue;
        }

        minting.add(def.id);
        editionChanged();
        const reply = await badgeCall('/mint', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ badgeId: def.id }),
        });
        minting.delete(def.id);

        if (!reply) {
          mintBroken = true;
          editionChanged();
          break;
        }
        if (reply.ok) {
          const claim = readMinted(reply.body, def.cap);
          if (claim) {
            cacheBadgeClaim(def.id, claim);
            noteOwnHolder(def.id, claim.serial);
            confirmed.add(def.id);
            writeSupplyRow(def, Math.max(claim.serial, supplyOf(def)?.minted ?? 0));
          } else {
            mintBroken = true;          // a 200 that is not a serial cannot be trusted
          }
        } else if (reply.status === 409) {
          exhausted.add(def.id);
          writeSupplyRow(def, num((reply.body as WireMint | null)?.minted) ?? def.cap);
        } else if (reply.status !== 403) {
          mintBroken = true;
        }
        editionChanged();
      }
    }

    syncState = supplyLive && progressLive && !mintBroken ? 'live' : 'offline';
    editionChanged();
  })().catch(() => {
    syncState = 'offline';
    editionChanged();
  }).finally(() => {
    inFlight = null;
  });

  return inFlight;
}

export function unlockedCount(): number {
  return BADGES.filter((b) => isBadgeUnlocked(b.id)).length;
}

export function equippedBadge(): BadgeDef | null {
  if (!profile.badge) return null;
  const def = badgeById(profile.badge);
  if (!def) return null;
  return isBadgeUnlocked(def.id) ? def : null;
}

/** An honor as it is worn: the catalogue row plus the ledger's serial, when one exists. */
export interface WornEdition {
  def: BadgeDef;
  serial: number | null;
}

/** The honor this device wears, with its server-confirmed serial if the ledger has answered. */
export function wornEdition(): WornEdition | null {
  const def = equippedBadge();
  if (!def) return null;
  return { def, serial: claimOf(def.id)?.serial ?? null };
}

/** Generic ledger names that must never be mistaken for a ladder player. */
const HOLDER_SKIP = new Set(['', 'unlisted', 'player', 'you', 'available']);

/**
 * A ladder player's minted honor, read from the public holder index.
 *
 * The ledger publishes who holds which serial, not which honor is currently equipped,
 * so the rarest cap is the strongest honor it can honestly attribute to that name.
 * Returns null until a live supply reading has landed, or when no holder carries the name.
 */
export function holderEdition(name: string): WornEdition | null {
  const key = name.trim().toLowerCase();
  if (HOLDER_SKIP.has(key)) return null;
  let best: WornEdition | null = null;
  for (const def of BADGES) {
    const holders = liveHolders.get(def.id);
    if (!holders) continue;
    const hit = holders.find((h) => h.name.trim().toLowerCase() === key);
    if (!hit) continue;
    if (!best || def.cap < best.def.cap) best = { def, serial: hit.serial };
  }
  return best;
}
