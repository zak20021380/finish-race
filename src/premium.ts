/**
 * premium.ts — the one entitlement door AND the one VIP storefront.
 *
 * Three things can answer `isPremiumUser()`, in this order:
 *
 *  - **A purchased Stars term.** `vipUntil` is written by the Worker only after a verified
 *    Telegram `successful_payment` receipt. The client caches the timestamp for an instant paint,
 *    but every purchase refreshes it from `GET /api/vip/me`, so the room stays the authority.
 *  - **Telegram Premium.** `initDataUnsafe.user.is_premium` rides the signed initData and is
 *    honoured as a legacy pass; the store shows it as an active status rather than selling again.
 *  - **A preview pass.** Granted by the store inside a plain browser tab (or by `?vip=1`) so the
 *    surfaces can be reviewed outside Telegram. It never persists and never reaches the server.
 *
 * The store itself is global: `#vip-sheet` is a direct child of `<body>`, so the same dialog opens
 * over the lobby, Home or the settled result card. Its touchpoints (the lobby header pill, Home's
 * VIP pill and the post-match gate) all call `openVipSheet()`; the Arena road carries no VIP pill,
 * so that mount is optional. The sheet owns the focus trap, the inert background and the Stars
 * checkout, and the caller may hand it an `onUnlocked` callback that runs once the pass is live.
 */
import { workerUrl } from './adminApi';
import { activeTgId } from './storage';
import { onLang, t } from './settings';
import { showToast } from './toast';
import {
  impact, notify, openInvoice, tgInitData, tgUser, type InvoiceStatus,
} from './telegram';
import {
  VIP_DAY_MS, VIP_HERO_PLAN, VIP_PLAN_IDS, VIP_PLANS, activeVipPlans, readVipPlanConfig,
  vipPlanOf, vipPlanWithConfig,
  type VipPlan, type VipPlanConfig, type VipPlanId,
} from '../shared/vip';
import telegramStarsUrl from './assets/images/telegram_stars.png';

/* ---------- entitlement state ---------- */

const CACHE_PREFIX = 'detour.vip.until.v1.';
/* The same account id the save is keyed by: a client that exposes `initData` without the unsafe
   copy still gets its own VIP cache instead of sharing the browser guest's. */
const cacheKey = (): string => `${CACHE_PREFIX}${activeTgId}`;

function readCachedUntil(): number {
  try {
    const raw = window.localStorage.getItem(cacheKey());
    const value = raw ? Number(JSON.parse(raw)) : 0;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

function writeCachedUntil(value: number): void {
  try { window.localStorage.setItem(cacheKey(), JSON.stringify(value)); } catch { /* stay in memory */ }
}

let vipUntil = readCachedUntil();
let preview = false;
try {
  const query = new URLSearchParams(window.location.search);
  preview = query.get('vip') === '1' || window.location.hash.replace(/^#/, '') === 'vip';
} catch { /* no URL to read (headless) */ }

/** Where the entitlement came from — the store says a different sentence for each. */
export type VipSource = 'subscription' | 'telegram' | 'preview' | 'none';

export function vipSource(): VipSource {
  if (vipUntil > Date.now()) return 'subscription';
  if (tgUser()?.is_premium === true) return 'telegram';
  if (preview) return 'preview';
  return 'none';
}

/** The one question every gated surface asks. */
export const isPremiumUser = (): boolean => vipSource() !== 'none';

/** True inside a Mini App session: only there can Telegram sell the upgrade. */
export const insideTelegram = (): boolean => tgUser()?.id !== undefined;

/** Whole days left on a purchased term, or 0. */
export function vipDaysLeft(): number {
  return vipUntil > Date.now() ? Math.max(1, Math.ceil((vipUntil - Date.now()) / VIP_DAY_MS)) : 0;
}

/* ---------- change signal ---------- */

type VipWatcher = (source: VipSource) => void;
const watchers: VipWatcher[] = [];

export function onVipChange(w: VipWatcher): () => void {
  watchers.push(w);
  return () => {
    const i = watchers.indexOf(w);
    if (i >= 0) watchers.splice(i, 1);
  };
}

function emitVip(): void {
  const source = vipSource();
  for (const w of [...watchers]) { try { w(source); } catch { /* watcher threw */ } }
  try { window.dispatchEvent(new CustomEvent<VipSource>('detour:vip', { detail: source })); } catch { /* no window */ }
}

/** The browser demo's door. Never a purchase and never stored: a reload takes the pass away. */
export function grantVipPreview(): void {
  if (preview) return;
  preview = true;
  emitVip();
}

/* ---------- the room's reading ---------- */

let refreshing: Promise<boolean> | null = null;

/**
 * Re-read the purchased term from the Worker. Never throws; `false` means the reading did not
 * land, and the caller keeps whatever it already had. Concurrent callers share one request.
 */
export function refreshVip(): Promise<boolean> {
  if (refreshing) return refreshing;
  const url = workerUrl('/api/vip/me');
  const init = tgInitData();
  if (!url || !init) return Promise.resolve(false);

  refreshing = (async (): Promise<boolean> => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), 8000);
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'x-telegram-init-data': init },
        signal: abort.signal,
        cache: 'no-store',
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { ok?: unknown; vipUntil?: unknown } | null;
      if (!data || data.ok !== true) return false;
      const next = typeof data.vipUntil === 'number' && Number.isFinite(data.vipUntil)
        ? Math.max(0, Math.floor(data.vipUntil))
        : 0;
      const changed = next !== vipUntil;
      vipUntil = next;
      writeCachedUntil(next);
      if (changed) emitVip();
      return true;
    } catch {
      return false;
    } finally {
      window.clearTimeout(timer);
    }
  })().finally(() => { refreshing = null; });

  return refreshing;
}

/* ---------- checkout ---------- */

export type VipPurchaseResult = 'paid' | 'preview' | 'cancelled' | 'failed' | 'unavailable';

/**
 * Wait for the room to write the receipt. Telegram's webhook can land a few hundred milliseconds
 * after the payment sheet closes, so a single reading may still be the pre-payment entitlement.
 * Returns true only when the room reports a term longer than the one held before checkout, so a
 * renewing VIP's already-running pass is never mistaken for the new receipt.
 */
async function awaitVipReceipt(baselineUntil: number): Promise<boolean> {
  for (const delay of [0, 400, 800, 1200]) {
    if (delay > 0) await new Promise<void>((done) => { window.setTimeout(done, delay); });
    if (await refreshVip() && vipUntil > baselineUntil) return true;
  }
  return false;
}

/** Local work: a loopback host or Vite's own dev server. A deployed Mini App is never one. */
function localWork(): boolean {
  try {
    const env = import.meta.env as ImportMetaEnv | undefined;
    if (env?.DEV) return true;
  } catch { /* env not statically defined */ }
  const host = location.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

/**
 * The one door to a free local pass: a loopback host, *outside* Telegram, asked for explicitly with
 * `?vip=preview`. A Mini App never lands here, so a broken invoice can never be papered over with
 * an entitlement the room does not hold.
 */
function previewCheckout(): boolean {
  if (insideTelegram() || !localWork()) return false;
  try {
    return new URLSearchParams(window.location.search).get('vip') === 'preview';
  } catch {
    return false;
  }
}

/**
 * Outside Telegram only the explicit preview door may hand out a local pass; every other answer is
 * `unavailable`, so a deployed Mini App with a broken checkout never gets a free entitlement.
 */
function unavailableOrPreview(): VipPurchaseResult {
  if (!previewCheckout()) return 'unavailable';
  grantVipPreview();
  return 'preview';
}

/** Ask the Worker for a priced invoice link; null when it cannot price this plan. */
async function requestInvoice(initData: string, planId: VipPlanId): Promise<string | null> {
  const url = workerUrl('/api/vip/invoice');
  if (!url) return null;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-telegram-init-data': initData,
      },
      body: JSON.stringify({ planId, initData }),
      cache: 'no-store',
    });
    const data = (await response.json().catch(() => null)) as
      { ok?: unknown; invoiceUrl?: unknown } | null;
    return response.ok && data?.ok === true && typeof data.invoiceUrl === 'string'
      ? data.invoiceUrl
      : null;
  } catch {
    return null;
  }
}

/**
 * Reconcile a paid sheet with the room. The webhook can lag the sheet, so poll for a term longer
 * than the one the room reported before checkout: only that earns the toast. Without it, a locally
 * reported baseline earns a device-only extension so the payer is not left looking locked out —
 * and a failed pre-purchase read earns nothing, because it has no real term to extend.
 */
async function settleVipPurchase(
  plan: VipPlan,
  baselineUntil: number,
  baselineSynced: boolean,
): Promise<void> {
  if (await awaitVipReceipt(baselineUntil)) {
    showToast(t('vipActivatedToast'), 'success', 4600);
    return;
  }
  if (!baselineSynced) return;
  vipUntil = Math.max(vipUntil, Date.now()) + plan.days * VIP_DAY_MS;
  writeCachedUntil(vipUntil);
  emitVip();
}

/**
 * Buy one plan with Telegram Stars.
 *
 * The invoice link comes from the Worker (which prices the plan from the admin's live sheet), then
 * Telegram's own payment sheet takes over. `paid` settles against the room's reading before
 * resolving, so every surface that repaints on the change signal shows the room's number.
 */
export async function purchaseVip(planId: VipPlanId): Promise<VipPurchaseResult> {
  const plan = vipPlanOf(planId);
  if (!plan) return 'failed';

  const initData = tgInitData();
  if (!insideTelegram() || !initData) return unavailableOrPreview();

  const invoiceUrl = await requestInvoice(initData, planId);
  if (!invoiceUrl) return unavailableOrPreview();

  /* The term this seat already held, read from the room rather than this device's cache: a cold
     cache on an existing VIP holds 0 and would make any live pass look like a fresh receipt. An
     unanswered read leaves no baseline, which forbids both confirmation and a local extension. */
  const baselineSynced = await refreshVip();
  const baselineUntil = baselineSynced ? vipUntil : Number.POSITIVE_INFINITY;

  return new Promise<VipPurchaseResult>((resolve) => {
    const opened = openInvoice(invoiceUrl, (status: InvoiceStatus) => {
      if (status !== 'paid') {
        resolve(status === 'cancelled' ? 'cancelled' : 'failed');
        return;
      }
      notify('success');
      void settleVipPurchase(plan, baselineUntil, baselineSynced).then(() => resolve('paid'));
    });
    if (!opened) resolve('unavailable');
  });
}

/* ---------- the storefront ---------- */

type SheetReason = 'sell' | 'gate';
const PLAN_KEYS: Record<VipPlanId, { name: string; badge?: string }> = {
  '7d': { name: 'vipPlanTacticalName' },
  '30d': { name: 'vipPlanProName', badge: 'vipPlanProRibbon' },
  '90d': { name: 'vipPlanGrandName', badge: 'vipPlanGrandTag' },
};

/** The admin's live sheet; the bundled defaults until the first successful read. */
let planConfig: VipPlanConfig = readVipPlanConfig(null);
let plansRefreshing: Promise<boolean> | null = null;

const storePlans = (): VipPlan[] => activeVipPlans(planConfig);

export interface ShopVipTier {
  id: VipPlanId;
  days: number;
  stars: number;
}

/** The tiers on sale, for the Shop's flagship card. The admin's sheet is the only price source. */
export function shopVipTiers(): ShopVipTier[] {
  return storePlans().map((plan) => ({ id: plan.id, days: plan.days, stars: plan.stars }));
}

/** Re-read the admin's sheet before the Shop paints a price. Never throws. */
export function refreshShopVipTiers(): Promise<boolean> {
  return refreshPlans();
}

/** The tier on screen, moved to the first live card when the admin removed the selected one. */
function selectedPlan(): VipPlan | null {
  const plans = storePlans();
  if (plans.length === 0) return null;
  const chosen = plans.find((plan) => plan.id === selected);
  if (chosen) return chosen;
  const next = plans.find((plan) => plan.id === VIP_HERO_PLAN) ?? plans[0];
  selected = next.id;
  return next;
}

/**
 * Read `/api/vip/plans`. The route lists only the tiers on sale, so an absent tier is disabled;
 * a failed or offline read keeps the sheet already on screen and never invents a price.
 */
function refreshPlans(): Promise<boolean> {
  if (plansRefreshing) return plansRefreshing;
  const url = workerUrl('/api/vip/plans');
  if (!url) return Promise.resolve(false);

  plansRefreshing = (async (): Promise<boolean> => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), 6000);
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: abort.signal,
        cache: 'no-store',
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { ok?: unknown; plans?: unknown } | null;
      if (!data || data.ok !== true || !Array.isArray(data.plans)) return false;

      const next = readVipPlanConfig(null);
      for (const id of VIP_PLAN_IDS) next[id] = { ...next[id], enabled: false };
      for (const item of data.plans) {
        if (!item || typeof item !== 'object') continue;
        const raw = item as Record<string, unknown>;
        const base = vipPlanOf(raw.id);
        if (!base) continue;
        const stars = typeof raw.stars === 'number' && Number.isInteger(raw.stars) && raw.stars > 0
          ? raw.stars
          : next[base.id].stars;
        next[base.id] = { stars, enabled: true };
      }
      planConfig = next;
      return true;
    } catch {
      return false;
    } finally {
      window.clearTimeout(timer);
    }
  })().finally(() => { plansRefreshing = null; });

  return plansRefreshing;
}

export interface VipSheetOptions {
  /** Why it opened: the standing sell, or the send key / stash a free seat just tried. */
  reason?: SheetReason;
  /** Runs once, after a successful unlock (purchase or preview), with the sheet already closed. */
  onUnlocked?: () => void;
}

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function ico(href: string, cls = 'ico'): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', href);
  svg.append(use);
  return svg;
}

/** The authentic Telegram Stars PNG, bundled and hashed by Vite — never a glyph or an emoji. */
function vipStarIcon(): HTMLImageElement {
  const img = document.createElement('img');
  img.src = telegramStarsUrl;
  img.className = 'vip-star-icon';
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  return img;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Every locale reads Latin tabular digits: VIP prices, day counts and the 4/4 badge all use 0-9. */
function digits(n: number): string {
  return n.toLocaleString('en-US');
}

/** The four promises, in the order a player weighs them: a title, one crisp line and a value pill.
 *  `ltr` pins the numeric/symbol pills so 4/4, +50% and ×2 never mirror in a RTL store. */
const VIP_FEATURES: ReadonlyArray<{ ico: string; key: string; sub: string; val: string; ltr: boolean }> = [
  { ico: '#i-chat', key: 'vipFeatChat', sub: 'vipFeatChatSub', val: 'vipFeatChatVal', ltr: false },
  { ico: '#i-shield', key: 'vipFeatRecovery', sub: 'vipFeatRecoverySub', val: 'vipFeatRecoveryVal', ltr: true },
  { ico: '#i-coins', key: 'vipFeatBoost', sub: 'vipFeatBoostSub', val: 'vipFeatBoostVal', ltr: true },
  { ico: '#i-bolt', key: 'vipFeatDouble', sub: 'vipFeatDoubleSub', val: 'vipFeatDoubleVal', ltr: true },
];

interface StoreDom {
  sheet: HTMLDivElement;
  scrim: HTMLElement;
  card: HTMLElement;
  close: HTMLButtonElement;
  kicker: HTMLElement;
  title: HTMLElement;
  sub: HTMLElement;
  plans: HTMLElement;
  feats: HTMLUListElement;
  active: HTMLElement;
  activeT: HTMLElement;
  activeD: HTMLElement;
  status: HTMLElement;
  cta: HTMLButtonElement;
  ctaT: HTMLElement;
  homePill: HTMLButtonElement;
  homePillT: HTMLElement;
  homePillD: HTMLElement;
  arenaPill: HTMLButtonElement | null;
  arenaPillT: HTMLElement | null;
  arenaPillBadge: HTMLElement | null;
}

let dom: StoreDom | null = null;
let initialised = false;
let open = false;
let reason: SheetReason = 'sell';
let selected: VipPlanId = VIP_HERO_PLAN;
let busy = false;
let trigger: HTMLElement | null = null;
let unlocked: (() => void) | null = null;
let statusKey = '';

function paintEntryPoints(): void {
  if (!dom) return;
  const source = vipSource();
  const active = source !== 'none';
  const days = source === 'subscription' ? vipDaysLeft() : 0;
  let narrow = false;
  try { narrow = window.matchMedia('(max-width: 374px)').matches; } catch { /* fixed width */ }
  const label = !active
    ? t('vipPillOffer')
    : narrow
      ? days > 0 ? t('vipPillDays').replace('{days}', digits(days)) : t('vipPillActiveShort')
      : source === 'subscription' || source === 'telegram' ? t('vipPillActive') : t('vipPillPreview');
  const dayText = days > 0 ? t('vipPillDays').replace('{days}', digits(days)) : '';

  dom.homePill.classList.toggle('is-active', active);
  dom.homePill.classList.toggle('is-offer', !active);
  dom.homePillT.textContent = label;
  dom.homePillD.textContent = dayText;
  dom.homePillD.hidden = !dayText;
  dom.homePill.setAttribute(
    'aria-label',
    days > 0 ? t('vipPillAriaActive').replace('{days}', digits(days)) : t(active ? 'vipPillAriaOn' : 'vipPillAriaOffer'),
  );

  if (dom.arenaPill && dom.arenaPillT && dom.arenaPillBadge) {
    dom.arenaPill.classList.toggle('is-active', active);
    dom.arenaPillT.textContent = days > 0 ? t('vipArenaPillDays').replace('{days}', digits(days)) : t('vipArenaPill');
    dom.arenaPillBadge.textContent = `${digits(4)}/${digits(4)}`;
    dom.arenaPill.setAttribute('aria-label', t('vipArenaAria'));
  }
}

function paintPlanSelection(): void {
  if (!dom) return;
  /* normalize first: a refresh may have taken the previously selected tier off the store */
  const plan = selectedPlan();
  const buttons = dom.plans.querySelectorAll<HTMLButtonElement>('.vip-plan');
  for (const button of buttons) {
    const on = button.dataset.plan === selected;
    button.classList.toggle('is-selected', on);
    button.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  if (plan) {
    dom.ctaT.textContent = t('vipCtaUnlock')
      .replace('{days}', digits(plan.days))
      .replace('{price}', digits(plan.stars));
  }
}

function buildPlans(): void {
  if (!dom) return;
  const plans = storePlans();
  /* one, two or three live tiers: the grid contracts so a hidden plan leaves no dead track */
  dom.plans.dataset.count = String(plans.length);
  dom.plans.replaceChildren(...plans.map((plan) => {
    const keys = PLAN_KEYS[plan.id];
    const button = el('button', 'vip-plan');
    button.type = 'button';
    button.dataset.plan = plan.id;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    if (plan.id === VIP_HERO_PLAN) button.classList.add('is-hero');
    button.setAttribute(
      'aria-label',
      `${t(keys.name)} — ${digits(plan.days)} ${t('vipPlanUnitDays')} — ${digits(plan.stars)}`,
    );

    if (keys.badge) button.append(el('span', 'vip-plan-badge', t(keys.badge)));

    const days = el('span', 'vip-plan-days');
    days.append(el('b', 'vip-plan-n', digits(plan.days)), el('span', 'vip-plan-unit', t('vipPlanUnitDays')));
    days.setAttribute('dir', 'ltr');

    const price = el('span', 'vip-plan-price');
    price.append(vipStarIcon(), el('b', 'vip-plan-price-n', digits(plan.stars)));
    price.setAttribute('dir', 'ltr');

    button.append(days, price);
    button.addEventListener('click', () => {
      if (busy || selected === plan.id) return;
      selected = plan.id;
      impact('light');
      paintPlanSelection();
    });
    return button;
  }));
  paintPlanSelection();
}

function paintFeatures(): void {
  if (!dom) return;
  dom.feats.replaceChildren(...VIP_FEATURES.map((feature) => {
    const row = el('li', 'vip-feat');
    const mark = el('span', 'vip-feat-ico');
    mark.append(ico(feature.ico));
    const copy = el('span', 'vip-feat-copy');
    copy.append(el('b', 'vip-feat-t', t(feature.key)), el('span', 'vip-feat-d', t(feature.sub)));
    const val = el('span', 'vip-feat-val', t(feature.val));
    if (feature.ltr) val.setAttribute('dir', 'ltr');
    row.append(mark, copy, val);
    return row;
  }));
}

function paintSheet(): void {
  if (!dom) return;
  const source = vipSource();
  const active = source !== 'none';
  const gated = reason === 'gate' && !active;
  const plan = selectedPlan();
  const noPlans = !plan;
  const fallback = plan ?? vipPlanWithConfig(VIP_HERO_PLAN, planConfig) ?? VIP_PLANS[1];

  dom.sheet.classList.toggle('is-gate', gated);
  dom.sheet.classList.toggle('is-active', active);
  dom.plans.setAttribute('aria-label', t('vipPlansLabel'));
  dom.kicker.textContent = t('vipKicker');
  dom.title.textContent = t(gated ? 'vipGateTitle' : active ? 'vipActiveTitle' : 'vipTitle');
  /* the sell state has no paragraph at all; only the gate keeps one short line of instruction */
  dom.sub.hidden = !gated;
  dom.sub.textContent = gated ? t('vipGateSub') : '';

  buildPlans();
  paintFeatures();

  dom.plans.hidden = active || noPlans;
  dom.cta.hidden = active || noPlans;
  dom.active.hidden = !active;
  if (active) {
    const days = source === 'subscription' ? vipDaysLeft() : 0;
    dom.activeT.textContent = t('vipPillActive');
    dom.activeD.textContent = days > 0
      ? t('vipActiveDays').replace('{days}', digits(days))
      : source === 'telegram' ? t('vipActiveTelegram') : t('vipActivePreview');
  }

  if (!active && noPlans) {
    dom.status.hidden = false;
    dom.status.textContent = t('vipPlansEmpty');
    dom.status.classList.remove('is-error');
  } else {
    dom.status.hidden = !statusKey;
    dom.status.textContent = statusKey ? t(statusKey) : '';
    dom.status.classList.toggle('is-error', !!statusKey);
  }
  dom.cta.disabled = busy || noPlans;
  dom.cta.classList.toggle('is-busy', busy);
  dom.ctaT.textContent = busy
    ? t('vipCtaBusy')
    : t('vipCtaUnlock')
      .replace('{days}', digits(fallback.days))
      .replace('{price}', digits(fallback.stars));
  dom.close.setAttribute('aria-label', t('vipClose'));
}

function focusables(): HTMLElement[] {
  if (!dom) return [];
  return [...dom.card.querySelectorAll<HTMLElement>(
    'button:not([hidden]):not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )].filter((node) => node.offsetParent !== null && !node.closest('[hidden]'));
}

/** Open the one store over whatever screen is showing. Lazy-binds on the first call. */
export function openVipSheet(options: VipSheetOptions = {}): void {
  if (!initialised) initVipStore();
  if (!dom) return;
  /* the admin's sheet is read on every open: a tier may have been repriced or taken down */
  void refreshPlans().then(() => { if (open) paintSheet(); });
  if (open) {
    reason = options.reason ?? reason;
    if (options.onUnlocked) unlocked = options.onUnlocked;
    paintSheet();
    return;
  }
  open = true;
  reason = options.reason ?? 'sell';
  unlocked = options.onUnlocked ?? null;
  selected = VIP_HERO_PLAN;
  statusKey = '';
  busy = false;
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  paintSheet();
  dom.sheet.hidden = false;
  dom.sheet.classList.add('is-open');
  const app = document.getElementById('app');
  app?.setAttribute('inert', '');
  document.body.classList.add('vip-open');
  /* a pass bought on another device may already be waiting in the room: read it once on open */
  void refreshVip().then(() => { if (open) paintSheet(); });
  requestAnimationFrame(() => {
    if (!dom) return;
    const target = dom.sheet.classList.contains('is-active') || storePlans().length === 0
      ? dom.close
      : dom.plans.querySelector<HTMLButtonElement>('.vip-plan.is-selected') ?? dom.cta ?? dom.close;
    target?.focus({ preventScroll: true });
  });
}

/** Close the store; focus returns to whatever opened it (the send key, a pill, a card). */
export function closeVipSheet(): void {
  if (!open || !dom) return;
  open = false;
  busy = false;
  statusKey = '';
  dom.sheet.hidden = true;
  dom.sheet.classList.remove('is-open');
  dom.sheet.classList.remove('is-gate');
  document.getElementById('app')?.removeAttribute('inert');
  document.body.classList.remove('vip-open');
  const back = trigger;
  trigger = null;
  unlocked = null;
  back?.focus({ preventScroll: true });
}

/** Is the store on screen? The result tray uses it to keep its own state in step. */
export const vipSheetOpen = (): boolean => open;

async function buy(): Promise<void> {
  if (busy || !dom) return;
  const plan = selectedPlan();
  if (!plan) return;
  busy = true;
  statusKey = '';
  paintSheet();
  const result = await purchaseVip(plan.id);
  busy = false;

  if (result === 'paid' || result === 'preview') {
    const after = unlocked;
    unlocked = null;
    paintEntryPoints();
    closeVipSheet();
    try { after?.(); } catch { /* a caller's repaint threw; the pass is still live */ }
    return;
  }

  statusKey = result === 'cancelled' ? 'vipStatusCancelled'
    : result === 'failed' ? 'vipStatusFailed' : 'vipStatusUnavailable';
  if (result !== 'cancelled') notify('error');
  paintSheet();
  dom.cta.focus({ preventScroll: true });
}

function onKeydown(event: KeyboardEvent): void {
  if (!open || !dom) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeVipSheet();
    return;
  }
  if (event.key !== 'Tab') return;
  const list = focusables();
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  const where = document.activeElement;
  if (event.shiftKey && (where === first || !dom.card.contains(where))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (where === last || !dom.card.contains(where))) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Bind the global sheet and its three touchpoints. Called once from `main.ts` after the SDK has
 * initialised; `openVipSheet` also calls it lazily, so a gate can never open a dead dialog.
 */
export function initVipStore(): void {
  if (initialised) return;
  initialised = true;

  const sheet = $<HTMLDivElement>('vip-sheet');
  const card = $<HTMLElement>('vip-card');
  const close = $<HTMLButtonElement>('vip-close');
  const kicker = $<HTMLElement>('vip-kicker');
  const title = $<HTMLElement>('vip-sheet-title');
  const sub = $<HTMLElement>('vip-sub');
  const plans = $<HTMLElement>('vip-plans');
  const feats = $<HTMLUListElement>('vip-feats');
  const active = $<HTMLElement>('vip-active');
  const activeT = $<HTMLElement>('vip-active-t');
  const activeD = $<HTMLElement>('vip-active-d');
  const status = $<HTMLElement>('vip-status');
  const cta = $<HTMLButtonElement>('vip-cta');
  const ctaT = $<HTMLElement>('vip-cta-t');
  const ctaStar = $<HTMLImageElement>('vip-cta-star');
  const scrim = $<HTMLElement>('vip-scrim');
  const homePill = $<HTMLButtonElement>('home-vip');
  const homePillT = $<HTMLElement>('home-vip-t');
  const homePillD = $<HTMLElement>('home-vip-d');
  const arenaPill = $<HTMLButtonElement>('arena-vip');
  const arenaPillT = $<HTMLElement>('arena-vip-t');
  const arenaPillBadge = $<HTMLElement>('arena-vip-badge');

  if (
    !sheet || !card || !close || !kicker || !title || !sub || !plans || !feats
    || !active || !activeT || !activeD || !status || !cta || !ctaT || !scrim
    || !homePill || !homePillT || !homePillD
  ) return;

  dom = {
    sheet, scrim, card, close, kicker, title, sub, plans, feats, active, activeT, activeD,
    status, cta, ctaT, homePill, homePillT, homePillD, arenaPill, arenaPillT, arenaPillBadge,
  };
  /* the CTA's Star is a static <img> in the markup; point it at Vite's hashed asset URL */
  if (ctaStar) ctaStar.src = telegramStarsUrl;

  close.addEventListener('click', () => closeVipSheet());
  scrim.addEventListener('click', () => closeVipSheet());
  cta.addEventListener('click', () => { void buy(); });
  document.addEventListener('keydown', onKeydown);

  homePill.addEventListener('click', () => {
    impact('light');
    openVipSheet({ reason: 'sell' });
  });
  arenaPill?.addEventListener('click', () => {
    impact('light');
    openVipSheet({ reason: 'sell' });
  });

  onLang(() => {
    paintEntryPoints();
    if (open) paintSheet();
  });
  /* a term can end while the app is open. One quiet check a minute repaints every surface on
     the minute the source changes, instead of leaving a stale crown until the next reload. */
  let lastSource = vipSource();
  onVipChange((source) => {
    lastSource = source;
    paintEntryPoints();
    if (open) paintSheet();
  });

  paintEntryPoints();
  void refreshVip().then(() => paintEntryPoints());
  /* the header pill shortens its label on a 320px phone; an orientation flip re-reads the breakpoint */
  window.addEventListener('resize', () => paintEntryPoints());
  window.setInterval(() => {
    const now = vipSource();
    if (now === lastSource) return;
    lastSource = now;
    emitVip();
  }, 60_000);
}
