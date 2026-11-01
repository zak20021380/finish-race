/**
 * vip.ts — Telegram Stars (XTR) checkout and the payment receipts that extend VIP.
 *
 * Two routes face the client:
 *
 *   - `POST /api/vip/invoice` proves the caller with their signed initData, prices the plan from
 *     the admin's live sheet in the room, and asks the Bot API for `createInvoiceLink` in XTR. The
 *     payload carries the payer id, the plan, its days and the price it was minted at; nothing the
 *     client can change is trusted later.
 *   - `GET /api/vip/plans` lists only the tiers the admin left on sale, at their live prices.
 *   - `GET /api/vip/me` reads the entitlement the room persisted for this player.
 *
 * Two updates face Telegram, delivered to the existing bot webhook:
 *
 *   - `pre_checkout_query` is answered before the payment sheet settles, and only for an invoice
 *     this bot priced (currency, amount, payload and payer all checked).
 *   - `successful_payment` is the receipt. It extends `vipUntil` on the player's durable record
 *     inside the singleton room — `Math.max(now, vipUntil) + days` — and is idempotent on the
 *     Telegram charge id, because Telegram retries a webhook it did not hear a 200 for.
 *
 * Outside Telegram, or on a deployment with no bot token, the client gets a reason it can read
 * (`telegram_required` / `stars_unavailable`) and falls back to its local preview pass. Nothing
 * here invents an entitlement the room would honour.
 */
import type { Env } from './env';
import { identifyAdminRequest, identifyPlayerRequest } from './auth';
import { json, reasonOf } from './http';
import {
  VIP_STARS_MAX, activeVipPlans, readVipPlanConfig, vipPlanOf,
  type VipPlan, type VipPlanConfig,
} from '../shared/vip';

const TELEGRAM_BASE = 'https://api.telegram.org/bot';
const LOBBY = 'global';

/** Same token-authenticated shape as the referral surface: no cookies, so a wildcard is enough. */
const VIP_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-telegram-init-data, authorization, x-detour-dev-player',
  'access-control-max-age': '86400',
};

const vipJson = (body: unknown, status = 200): Response => json(body, status, VIP_CORS);

class TelegramError extends Error {
  constructor(readonly description: string, readonly errorCode: number) {
    super(description);
  }
}

interface TelegramEnvelope<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

async function telegram<T>(token: string, method: string, params: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_BASE}${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(params),
    });
  } catch {
    throw new TelegramError('telegram unavailable', 0);
  }
  let data: TelegramEnvelope<T> | null = null;
  try {
    data = (await response.json()) as TelegramEnvelope<T>;
  } catch {
    data = null;
  }
  if (!response.ok || !data || data.ok !== true || data.result === undefined) {
    const described = typeof data?.description === 'string' ? data.description.slice(0, 160) : '';
    throw new TelegramError(
      described || `telegram ${method} failed`,
      typeof data?.error_code === 'number' ? data.error_code : response.status,
    );
  }
  return data.result;
}

/* ---------- the invoice payload ---------- */

/** The admin's live plan sheet, read from the singleton room; defaults while it cannot answer. */
async function roomVipConfig(env: Env): Promise<VipPlanConfig> {
  if (!env.MATCHMAKER) return readVipPlanConfig(null);
  try {
    const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
    const response = await lobby.fetch(new Request('https://vip.internal/internal/vip/config'));
    const body = (await response.json().catch(() => null)) as { ok?: unknown; config?: unknown } | null;
    if (!response.ok || !body || body.ok !== true) return readVipPlanConfig(null);
    return readVipPlanConfig(body.config);
  } catch {
    return readVipPlanConfig(null);
  }
}

interface InvoicePayload {
  v: 1;
  userId: string;
  planId: string;
  days: number;
  /** The Stars amount this invoice was created for. Absent on invoices issued before pricing. */
  stars?: number;
}

function encodePayload(userId: string, plan: VipPlan): string {
  const payload: InvoicePayload = { v: 1, userId, planId: plan.id, days: plan.days, stars: plan.stars };
  return JSON.stringify(payload);
}

/** The payload the bot wrote, read back strictly. Anything else is refused, never repriced. */
function readPayload(raw: string): InvoicePayload | null {
  try {
    const value = JSON.parse(raw) as Partial<InvoicePayload> | null;
    if (!value || value.v !== 1) return null;
    if (typeof value.userId !== 'string' || !/^[0-9-]{1,20}$/.test(value.userId)) return null;
    if (typeof value.planId !== 'string' || typeof value.days !== 'number') return null;
    let stars: number | undefined;
    if (value.stars !== undefined) {
      if (typeof value.stars !== 'number' || !Number.isInteger(value.stars)) return null;
      if (value.stars < 1 || value.stars > VIP_STARS_MAX) return null;
      stars = value.stars;
    }
    return { v: 1, userId: value.userId, planId: value.planId, days: value.days, ...(stars ? { stars } : {}) };
  } catch {
    return null;
  }
}

/**
 * A paid plan, only when the receipt's own plan, amount and days all agree with the invoice.
 * The amount is read from the signed-here payload, so an admin repricing the store later never
 * invalidates an invoice already in a payer's sheet; an older payload without a price is checked
 * against the canonical table it was minted from.
 */
function readPaidPlan(
  raw: string,
  currency: string,
  amount: number,
): { payload: InvoicePayload; plan: VipPlan; stars: number } | null {
  const payload = readPayload(raw);
  if (!payload) return null;
  const plan = vipPlanOf(payload.planId);
  if (!plan || plan.days !== payload.days) return null;
  const stars = payload.stars ?? plan.stars;
  if (currency !== 'XTR' || amount !== stars) return null;
  return { payload, plan, stars };
}

/* ---------- the room's entitlement write ---------- */

interface GrantResult {
  ok?: boolean;
  vipUntil?: number;
  error?: string;
}

async function grantVip(
  env: Env,
  args: { userId: string; plan: VipPlan; stars: number; chargeId: string; name: string; username: string },
): Promise<GrantResult | null> {
  if (!env.MATCHMAKER) return null;
  const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
  try {
    const response = await lobby.fetch(new Request('https://vip.internal/api/vip/grant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: `tg-${args.userId}`,
        tgId: args.userId,
        name: args.name,
        username: args.username,
        planId: args.plan.id,
        days: args.plan.days,
        stars: args.stars,
        chargeId: args.chargeId,
      }),
    }));
    return (await response.json().catch(() => null)) as GrantResult | null;
  } catch {
    return null;
  }
}

/* ---------- the client routes ---------- */

/** `POST /api/vip/invoice` — price the plan and let Telegram's own payment sheet sell it. */
async function invoiceRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return vipJson({ ok: false, error: 'method_not_allowed' }, 405);
  const auth = await identifyPlayerRequest(request, env);
  if (!auth) return vipJson({ ok: false, error: 'unauthorized' }, 401);
  if (!auth.tgId) return vipJson({ ok: false, error: 'telegram_required', code: 'preview' }, 403);

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const base = vipPlanOf(body.planId);
  if (!base) return vipJson({ ok: false, error: 'unknown_plan' }, 400);

  /* The admin's live sheet decides both the price and whether this tier is on sale at all. */
  const config = await roomVipConfig(env);
  const tier = config[base.id];
  if (!tier.enabled) return vipJson({ ok: false, error: 'plan_disabled' }, 409);
  const plan: VipPlan = { ...base, stars: tier.stars };

  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) return vipJson({ ok: false, error: 'stars_unavailable', code: 'preview' }, 503);

  try {
    const invoiceUrl = await telegram<string>(token, 'createInvoiceLink', {
      title: `Tactix VIP — ${plan.name}`,
      description: `${plan.days} days of unlimited post-match banter, the golden pawn aura, crown prestige and 4/4 daily TIQ recovery.`,
      payload: encodePayload(auth.tgId, plan),
      /* Stars are priced directly in XTR: Telegram expects no payment-provider token. */
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: `${plan.name} · ${plan.days} days`, amount: plan.stars }],
    });
    return vipJson({
      ok: true,
      invoiceUrl,
      planId: plan.id,
      days: plan.days,
      stars: plan.stars,
    });
  } catch (err) {
    const hint = err instanceof TelegramError ? err.description : reasonOf(err);
    const missing = err instanceof TelegramError && err.errorCode === 404;
    return vipJson({
      ok: false,
      error: missing ? 'stars_unavailable' : 'invoice_failed',
      hint,
      code: 'preview',
    }, missing ? 503 : 502);
  }
}

/** `GET /api/vip/me` — the entitlement the room holds, keyed by the verified player id. */
async function meRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return vipJson({ ok: false, error: 'method_not_allowed' }, 405);
  const auth = await identifyPlayerRequest(request, env);
  if (!auth) return vipJson({ ok: false, error: 'unauthorized' }, 401);
  if (!auth.tgId || !env.MATCHMAKER) {
    return vipJson({ ok: true, isVip: false, vipUntil: 0, planId: '' });
  }
  const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
  const headers = new Headers({ 'x-detour-player': auth.playerId });
  try {
    const response = await lobby.fetch(new Request('https://vip.internal/api/vip/me', { headers }));
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !body || body.ok !== true) {
      return vipJson({ ok: false, error: 'vip_unavailable', code: 'room' }, 503);
    }
    return vipJson(body);
  } catch (err) {
    return vipJson({ ok: false, error: 'vip_unavailable', hint: reasonOf(err), code: 'room' }, 503);
  }
}

/** `GET /api/vip/plans` — the cards the player's store paints, exactly as the admin left them. */
async function plansRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return vipJson({ ok: false, error: 'method_not_allowed' }, 405);
  const config = await roomVipConfig(env);
  const plans = activeVipPlans(config).map(({ id, days, stars, name }) => ({ id, days, stars, name }));
  return vipJson({ ok: true, plans });
}

/**
 * `/api/admin/vip/*` — the edge proves the admin credential, then hands the request to the
 * singleton room, which owns the plan sheet and the revenue ledger and re-checks the caller.
 */
export async function vipAdminRoutes(request: Request, env: Env): Promise<Response> {
  const admin = await identifyAdminRequest(request, env);
  if (!admin) {
    return vipJson({ ok: false, error: 'forbidden', hint: 'admin credentials required', code: 'admin_unauthorized' }, 403);
  }
  if (!env.MATCHMAKER) return vipJson({ ok: false, error: 'matchmaker_unbound' }, 503);
  const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
  try {
    return await lobby.fetch(request);
  } catch (err) {
    return vipJson({ ok: false, error: 'vip_admin_unavailable', hint: reasonOf(err) }, 503);
  }
}

export async function vipRoutes(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: VIP_CORS });
  if (url.pathname === '/api/vip/plans') return plansRoute(request, env);
  if (url.pathname === '/api/vip/invoice') return invoiceRoute(request, env);
  if (url.pathname === '/api/vip/me') return meRoute(request, env);
  return vipJson({ ok: false, error: 'not_found' }, 404);
}

/* ---------- the two Telegram updates ---------- */

export interface PreCheckoutQueryLike {
  id?: string;
  from?: { id?: number | string; first_name?: string };
  currency?: string;
  total_amount?: number;
  invoice_payload?: string;
}

export interface SuccessfulPaymentLike {
  currency?: string;
  total_amount?: number;
  invoice_payload?: string;
  telegram_payment_charge_id?: string;
}

const numericId = (value: number | string | undefined): string =>
  value === undefined || value === null ? '' : String(value).replace(/[^0-9-]/g, '').slice(0, 20);

/**
 * Answer `pre_checkout_query`. Telegram gives the bot ten seconds; a refusal is a sentence the
 * payer reads in the sheet, so it says what is wrong instead of failing silently.
 */
export async function answerPreCheckout(
  query: PreCheckoutQueryLike,
  token: string,
): Promise<void> {
  const id = typeof query.id === 'string' ? query.id : '';
  if (!id) return;
  const payer = numericId(query.from?.id);
  const paid = readPaidPlan(
    typeof query.invoice_payload === 'string' ? query.invoice_payload : '',
    typeof query.currency === 'string' ? query.currency : '',
    typeof query.total_amount === 'number' ? query.total_amount : -1,
  );
  const ok = !!paid && !!payer && paid.payload.userId === payer;
  try {
    await telegram<boolean>(token, 'answerPreCheckoutQuery', ok
      ? { pre_checkout_query_id: id, ok: true }
      : {
        pre_checkout_query_id: id,
        ok: false,
        error_message: 'This VIP invoice is no longer valid. Please reopen the store and try again.',
      });
  } catch {
    /* the payer's sheet has already timed out; nothing to retry into */
  }
}

/**
 * Persist a completed Stars payment. The extension is computed by the room on its own clock, and
 * the charge id makes a webhook retry a no-op instead of a second term.
 */
export async function handleSuccessfulPayment(
  payment: SuccessfulPaymentLike,
  payerId: number | string | undefined,
  env: Env,
  payerName = '',
  payerUsername = '',
): Promise<void> {
  const payer = numericId(payerId);
  if (!payer) return;
  const paid = readPaidPlan(
    typeof payment.invoice_payload === 'string' ? payment.invoice_payload : '',
    typeof payment.currency === 'string' ? payment.currency : '',
    typeof payment.total_amount === 'number' ? payment.total_amount : -1,
  );
  if (!paid || paid.payload.userId !== payer) return;
  const chargeId = typeof payment.telegram_payment_charge_id === 'string'
    ? payment.telegram_payment_charge_id.slice(0, 128)
    : '';
  if (!chargeId) return;
  const clean = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  await grantVip(env, {
    userId: payer,
    plan: paid.plan,
    stars: paid.stars,
    chargeId,
    name: clean(payerName),
    username: clean(payerUsername),
  });
}
