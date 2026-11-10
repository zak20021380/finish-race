/**
 * referralConfig.ts — every tunable of the Stars Vault invite programme, in one object.
 *
 * The Worker is the only thing that reads these to decide a reward; the client reads the same
 * object to paint a target it can never move. Changing a number here changes the campaign on
 * both sides at once, so a progress bar can never promise a threshold the server does not honour.
 *
 * Stars are promotional credit, not Telegram Stars (XTR): nothing in here transfers currency.
 * A balance only ever raises a manual payout request the owner settles by hand.
 */

export const REFERRAL_CONFIG = {
  /** Pre-filled gift sitting in every vault from the first paint, so the meter is never empty. */
  STARTER_VAULT_GIFT_STARS: 5,
  /** Legacy stage allocation, retained for already-earned Stars. */
  STAGE1_REWARD_STARS: 2,
  /** Legacy second-stage allocation; the quest now awards the remaining total at once. */
  STAGE2_REWARD_STARS: 3,
  /** What one fully qualified friend is worth: 2 + 3. */
  TOTAL_PER_FRIEND_STARS: 5,

  /** Quest lifetime from the referral ledger's immutable firstSeenAt. */
  QUEST_DURATION_MS: 72 * 60 * 60 * 1000,
  /** Ad-verified HardBot 1v1 matches accepted per UTC day. */
  QUEST_DAILY_MATCH_CAP: 10,

  /** Quest completion: ad-verified HardBot matches (legacy key retained). */
  STAGE1_MIN_MATCHES: 10,
  /** Legacy display/audit setting only; no longer a quest requirement. */
  STAGE1_MIN_DAYS: 3,
  /** Stage 1: random-matchmaking duels against another person. */
  STAGE1_MIN_PVP_MATCHES: 3,
  /** Stage 1: distinct human opponents across those duels. */
  STAGE1_MIN_DISTINCT_OPPONENTS: 2,

  /** Quest alternative: ad-verified HardBot wins (legacy key retained). */
  STAGE2_MIN_RANKED_PVP_WINS: 5,
  /** Stage 2 alternative: reaching this Arena realm unlocks it without the win count. */
  STAGE2_ALT_ARENA_UNLOCK: 3,

  /** Vault balance needed before "Request Payout" wakes up. */
  MIN_PAYOUT_THRESHOLD_STARS: 50,
  /** Friends one inviter may be rewarded for in a calendar month. */
  MAX_QUALIFIED_PER_INVITER_MONTH: 20,
  /** The game-wide pool for one calendar month. Past it, rewards queue for the next month. */
  GLOBAL_MONTHLY_BUDGET_STARS: 2000,

  /** A match shorter than this is an instant quit and counts for nothing. */
  MIN_VALID_MATCH_DURATION_MS: 25_000,
  /** At or above this share of duels inside the invite cluster, the friend is held for review. */
  MAX_COLLUSION_RATIO: 0.75,
} as const;

/**
 * The TIQ behind each Arena realm, lowest first — the same ladder the Arena Road paints.
 * `STAGE2_ALT_ARENA_UNLOCK` is a realm number, so the server needs this to turn the player's
 * standing into one. Kept beside the rest of the campaign so the gate is a single edit.
 */
export const ARENA_RANK_TIQ: readonly number[] = [0, 1200, 2800, 5000];

/** The realm a TIQ total has reached: 1 at the foot of the road, 4 past the apex. */
export function arenaRankOf(tiq: number): number {
  const value = Number.isFinite(tiq) ? Math.max(0, Math.floor(tiq)) : 0;
  let rank = 1;
  for (let i = 0; i < ARENA_RANK_TIQ.length; i++) if (value >= ARENA_RANK_TIQ[i]) rank = i + 1;
  return rank;
}

/** `2026-11-09` — the UTC day a match landed on. Distinct days are what Stage 1 counts. */
export function utcDayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** `2026-11` — the calendar month the budget and the per-inviter cap are keyed to. */
export function utcMonthKey(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}