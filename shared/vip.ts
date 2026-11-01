/**
 * vip.ts — the three Telegram Stars plans, shared by the storefront and the Worker.
 *
 * The price a button prints and the price an invoice charges must be the same number, and the
 * days a receipt grants must be the days the card promised. Keeping both on one table is what
 * makes that true: the client paints from it, `POST /api/vip/invoice` bills from it, and the
 * payment webhook extends the entitlement from it — never from a figure the client sent.
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

/** Stacking extension: a renewal starts where the current term ends, never in the past. */
export function extendVipUntil(currentUntil: number, plan: VipPlan, now = Date.now()): number {
  const start = Number.isFinite(currentUntil) && currentUntil > now ? currentUntil : now;
  return start + plan.days * VIP_DAY_MS;
}
