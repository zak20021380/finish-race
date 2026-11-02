/**
 * vip.ts — the three Telegram Stars plans, their canonical prices, and the admin's live overrides.
 *
 * The table below names each duration and product; the Stars price and whether a tier is on sale
 * come from `VipPlanConfig`, which the room persists and the Command Center edits. The storefront
 * paints only active plans at the configured price, `POST /api/vip/invoice` bills that same price,
 * and the invoice payload records the amount it was minted for — so a later repricing never
 * changes what an open payment sheet charges or what its receipt grants.
 */

export type VipPlanId = '7d' | '30d' | '90d';

export interface VipPlan {
  id: VipPlanId;
  /** Days added to the entitlement, measured from whichever is later: now, or the current end. */
  days: number;
  /** Telegram Stars (XTR) owed for one purchase. Stars are whole units, never fractions. */
  stars: number;
  /** The product name inside a Telegram invoice. Display names live in `src/settings.ts`. */
  name: string;
}

export const VIP_DAY_MS = 86_400_000;

/** Default selected / hero tier: 30 days. */
export const VIP_HERO_PLAN: VipPlanId = '30d';

export const VIP_PLANS: readonly VipPlan[] = [
  { id: '7d', days: 7, stars: 75, name: 'Tactical Pass' },
  { id: '30d', days: 30, stars: 199, name: 'Pro Elite' },
  { id: '90d', days: 90, stars: 499, name: 'Grand Master' },
];

export const VIP_PLAN_IDS: readonly VipPlanId[] = VIP_PLANS.map((plan) => plan.id);

/** The plan a client asked for, or null. Membership only — an unknown id is never priced. */
export function vipPlanOf(value: unknown): VipPlan | null {
  if (typeof value !== 'string') return null;
  return VIP_PLANS.find((plan) => plan.id === value) ?? null;
}

/* ---------- the admin's live storefront ---------- */

/** One tier as the Command Center owns it: its Stars price and whether it is on sale. */
export interface VipPlanSettings {
  stars: number;
  enabled: boolean;
}

export type VipPlanConfig = Record<VipPlanId, VipPlanSettings>;

export const VIP_STARS_MIN = 1;
export const VIP_STARS_MAX = 1_000_000;

/** The canonical storefront, used until the room holds an admin's configuration. */
export const VIP_DEFAULT_CONFIG: VipPlanConfig = {
  '7d': { stars: 75, enabled: true },
  '30d': { stars: 199, enabled: true },
  '90d': { stars: 499, enabled: true },
};

export function defaultVipPlanConfig(): VipPlanConfig {
  return {
    '7d': { ...VIP_DEFAULT_CONFIG['7d'] },
    '30d': { ...VIP_DEFAULT_CONFIG['30d'] },
    '90d': { ...VIP_DEFAULT_CONFIG['90d'] },
  };
}

/**
 * One admin-supplied tier, read strictly: a whole Stars price above zero and an explicit
 * boolean. `price` is accepted as the admin API's spelling of `stars`.
 */
export function vipPlanSettingsOf(raw: unknown): VipPlanSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const price = row.stars ?? row.price;
  if (typeof price !== 'number' || !Number.isInteger(price)) return null;
  if (price < VIP_STARS_MIN || price > VIP_STARS_MAX) return null;
  if (typeof row.enabled !== 'boolean') return null;
  return { stars: price, enabled: row.enabled };
}

/**
 * A stored or wire config folded field by field. Anything missing or malformed keeps the
 * canonical price and stays enabled, so a half-written blob can never close the store.
 */
export function readVipPlanConfig(raw: unknown): VipPlanConfig {
  const config = defaultVipPlanConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return config;
  const source = raw as Record<string, unknown>;
  for (const id of VIP_PLAN_IDS) {
    const tier = vipPlanSettingsOf(source[id]);
    if (tier) config[id] = tier;
  }
  return config;
}

/** A plan with its current price, or null for an unknown id. */
export function vipPlanWithConfig(id: unknown, config: VipPlanConfig): VipPlan | null {
  const plan = vipPlanOf(id);
  return plan ? { ...plan, stars: config[plan.id].stars } : null;
}

/** The storefront's cards, in display order: exactly the tiers the admin left on sale. */
export function activeVipPlans(config: VipPlanConfig): VipPlan[] {
  return VIP_PLANS
    .filter((plan) => config[plan.id].enabled)
    .map((plan) => ({ ...plan, stars: config[plan.id].stars }));
}

/* ---------- the revenue ledger ---------- */

/** One successful Stars receipt, as the Command Center's audit table reads it. */
export interface VipPurchase {
  userId: string;
  username: string;
  planId: VipPlanId;
  stars: number;
  purchasedAt: number;
  expiresAt: number;
}

export interface VipTierRevenue {
  count: number;
  starsGrossed: number;
}

/** What `GET /api/admin/vip/stats` answers. */
export interface VipRevenueSummary {
  totalSubscribers: number;
  allTimePurchases: number;
  totalStarsEarned: number;
  tierBreakdown: Record<VipPlanId, VipTierRevenue>;
  recentPurchases: VipPurchase[];
}

/** Stacking extension: a renewal starts where the current term ends, never in the past. */
export function extendVipUntil(currentUntil: number, plan: VipPlan, now = Date.now()): number {
  const start = Number.isFinite(currentUntil) && currentUntil > now ? currentUntil : now;
  return start + plan.days * VIP_DAY_MS;
}

/* ---------- the admin directory's plan filter ---------- */

/**
 * The Users tab's plan axis. `free` is a seat without a running term (a never-subscriber or a
 * lapsed one), while `expired` is the narrower churn view of a term that has actually ended.
 */
export type VipPlanFilter = 'all' | 'free' | 'active' | VipPlanId | 'expired';

export const VIP_PLAN_FILTERS: readonly VipPlanFilter[] = [
  'all', 'free', 'active', ...VIP_PLAN_IDS, 'expired',
];

export function vipPlanFilterOf(raw: unknown): VipPlanFilter {
  return typeof raw === 'string' && (VIP_PLAN_FILTERS as readonly string[]).includes(raw)
    ? raw as VipPlanFilter
    : 'all';
}

/** Whole days left on a term, measured from now; 0 once it has ended. */
export function vipDaysLeftUntil(vipUntil: number, now = Date.now()): number {
  const until = Number.isFinite(vipUntil) ? vipUntil : 0;
  return until > now ? Math.max(1, Math.ceil((until - now) / VIP_DAY_MS)) : 0;
}

/** Does a seat, with its stored term and last plan id, belong in the selected plan view? */
export function vipMatchesPlanFilter(
  vipUntil: number,
  vipPlan: string,
  filter: VipPlanFilter,
  now = Date.now(),
): boolean {
  if (filter === 'all') return true;
  const until = Number.isFinite(vipUntil) ? Math.max(0, vipUntil) : 0;
  const active = until > now;
  if (filter === 'free') return !active;
  if (filter === 'active') return active;
  if (filter === 'expired') return until > 0 && !active;
  return active && vipPlan === filter;
}
