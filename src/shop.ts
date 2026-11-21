/**
 * shop.ts — the Shop: the Obsidian VIP flagship on top, then the locked preview shelves.
 *
 * The flagship is a storefront, not a second till. Every price comes from the VIP tiers the
 * Worker serves (via premium.ts), and the one checkout is `purchaseVip()` — the same verified
 * Telegram Stars flow the VIP sheet uses. The shelves below it are previews only: a tap opens a
 * short toast and never touches coins, Stars or inventory.
 */
import { profile } from './storage';
import { setBalance } from './coin';
import { onLang, t } from './settings';
import { showToast } from './toast';
import { impact, notify } from './telegram';
import {
  isPremiumUser, onVipChange, purchaseVip, refreshShopVipTiers, shopVipTiers, vipDaysLeft,
  type ShopVipTier,
} from './premium';
import { VIP_HERO_PLAN, type VipPlanId } from '../shared/vip';
import type { Sheets } from './sheets';

export interface ShopApi {
  sheets: Sheets;
  /** sheet ids come from the DOM so markup stays the single source of truth */
  sheet(id: string): HTMLElement | null;
}

export interface Shop {
  setRoute(id: string): void;
}

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

/** The four promises, each a title and a value pill; `ltr` pins 4/4, +50% and ×2. */
const PERKS: ReadonlyArray<{ ico: string; label: string; value: string; ltr: boolean }> = [
  { ico: '#i-chat', label: 'shopPerkChat', value: 'shopPerkChatVal', ltr: false },
  { ico: '#i-shield', label: 'shopPerkRecovery', value: 'shopPerkRecoveryVal', ltr: true },
  { ico: '#i-coins', label: 'shopPerkBoost', value: 'shopPerkBoostVal', ltr: true },
  { ico: '#i-bolt', label: 'shopPerkDouble', value: 'shopPerkDoubleVal', ltr: true },
];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Every figure on the card is a Latin island, so no locale can mirror or re-order it. */
const bdi = (text: string): HTMLElement => {
  const node = document.createElement('bdi');
  node.dir = 'ltr';
  node.textContent = text;
  return node;
};

function svg(href: string, cls: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const node = document.createElementNS(NS, 'svg');
  node.setAttribute('class', cls);
  node.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', href);
  node.append(use);
  return node;
}

/** Fill `{days}` / `{price}` slots with their own `<bdi dir="ltr">` islands. */
function write(root: HTMLElement, template: string, values: Record<string, string>): void {
  for (const part of template.split(/(\{\w+\})/)) {
    const key = part.startsWith('{') && part.endsWith('}') ? part.slice(1, -1) : '';
    if (key && values[key] !== undefined) root.append(bdi(values[key]));
    else if (part) root.append(document.createTextNode(part));
  }
}

export function createShop(api: ShopApi): Shop {
  const chip = $<HTMLElement>('shop-balance');
  const coins = $<HTMLSpanElement>('shop-coins');
  const tierRow = $<HTMLElement>('shop-vip-tiers');
  const perks = $<HTMLUListElement>('shop-vip-perks');
  const activePill = $<HTMLElement>('shop-vip-active');
  const activeText = $<HTMLElement>('shop-vip-active-t');
  const cta = $<HTMLButtonElement>('shop-vip-cta');
  const ctaText = $<HTMLElement>('shop-vip-cta-t');
  const status = $<HTMLElement>('shop-vip-status');

  let tiers: ShopVipTier[] = shopVipTiers();
  let selected: VipPlanId = tiers.some((tier) => tier.id === VIP_HERO_PLAN)
    ? VIP_HERO_PLAN
    : tiers[0]?.id ?? VIP_HERO_PLAN;
  let busy = false;
  let statusKey = '';
  let mounted = false;

  const planOf = (): ShopVipTier | null => tiers.find((tier) => tier.id === selected) ?? tiers[0] ?? null;

  function paintTiers(): void {
    if (!tierRow) return;
    tierRow.setAttribute('aria-label', t('vipPlansLabel'));
    tierRow.replaceChildren(...tiers.map((tier) => {
      const button = el('button', 'vip-flag-tier');
      button.type = 'button';
      button.dataset.plan = tier.id;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(tier.id === selected));
      button.setAttribute('aria-label', `${t('shopVipKicker')} · ${tier.days} ${t('vipPlanUnitDays')} · ${tier.stars}`);
      if (tier.id === VIP_HERO_PLAN) button.append(el('span', 'vip-flag-tier-badge', t('vipPlanProRibbon')));
      if (tier.id === '90d') {
        const tag = el('span', 'vip-flag-tier-tag');
        tag.append(bdi(t('vipPlanGrandTag')));
        button.append(tag);
      }

      const days = el('span', 'vip-flag-tier-days');
      days.append(bdi(String(tier.days)), el('span', 'vip-flag-tier-unit', t('vipPlanUnitDays')));
      const price = el('span', 'vip-flag-tier-price');
      /* #i-star-3d is a filled gold silhouette: crisp at price-row size in every locale. */
      price.append(bdi(String(tier.stars)), svg('#i-star-3d', 'vip-flag-tier-star'));

      button.append(days, price);
      return button;
    }));
  }

  function paintPerks(): void {
    if (!perks) return;
    perks.replaceChildren(...PERKS.map((perk) => {
      const row = el('li', 'vip-flag-perk');
      const mark = el('span', 'vip-flag-perk-ico');
      mark.append(svg(perk.ico, 'vip-flag-perk-svg'));
      const label = el('span', 'vip-flag-perk-label', t(perk.label));
      const value = el('span', 'vip-flag-perk-val');
      if (perk.ltr) value.append(bdi(t(perk.value)));
      else value.textContent = t(perk.value);
      row.append(mark, label, value);
      return row;
    }));
  }

  function paint(): void {
    const active = isPremiumUser();
    const days = vipDaysLeft();
    if (activePill && activeText) {
      activePill.hidden = !active;
      if (active) {
        activeText.replaceChildren();
        if (days > 0) write(activeText, t('shopVipActive'), { days: String(days) });
        else activeText.textContent = t('shopVipActiveShort');
      }
    }

    for (const button of tierRow?.querySelectorAll<HTMLButtonElement>('.vip-flag-tier') ?? []) {
      const on = button.dataset.plan === selected;
      button.classList.toggle('is-selected', on);
      button.setAttribute('aria-checked', String(on));
    }

    if (!cta || !ctaText) return;
    cta.disabled = busy || tiers.length === 0;
    cta.classList.toggle('is-busy', busy);
    ctaText.replaceChildren();
    const plan = planOf();
    if (busy) ctaText.textContent = t('vipCtaBusy');
    else if (plan) {
      write(ctaText, t(active ? 'shopVipRenew' : 'shopVipCta'), {
        days: String(plan.days),
        price: String(plan.stars),
      });
      ctaText.append(svg('#i-star', 'vip-flag-cta-star'));
    }

    if (status) {
      status.hidden = !statusKey;
      status.textContent = statusKey ? t(statusKey) : '';
    }
  }

  /** Re-read the admin's tiers; a failed read keeps the sheet already on screen. */
  function syncPlans(): void {
    void refreshShopVipTiers().then((ok) => {
      if (!ok) return;
      tiers = shopVipTiers();
      if (!tiers.some((tier) => tier.id === selected)) {
        selected = tiers.some((tier) => tier.id === VIP_HERO_PLAN) ? VIP_HERO_PLAN : tiers[0]?.id ?? selected;
      }
      paintTiers();
      paint();
    });
  }

  function buy(): void {
    if (busy) return;
    const plan = planOf();
    if (!plan) return;
    busy = true;
    statusKey = '';
    paint();
    impact('light');
    void purchaseVip(plan.id).then((result) => {
      busy = false;
      /* A confirmed (or preview) pass earns its toast inside premium.ts, never here. */
      if (result === 'paid' || result === 'preview') {
        paint();
        syncPlans();
        return;
      }
      statusKey = result === 'cancelled' ? 'vipStatusCancelled'
        : result === 'failed' ? 'vipStatusFailed' : 'vipStatusUnavailable';
      if (result !== 'cancelled') notify('error');
      paint();
    });
  }

  function mount(): void {
    if (mounted) return;
    mounted = true;
    paintTiers();
    paintPerks();
    paint();
    /* One delegated listener on the stable Shop root. Tiers and shelves are re-rendered on
       language and plan refreshes, so direct bindings would go stale; delegation keeps every
       tap live. The closest() walk also survives clicks landing on an inner icon or <bdi>. */
    const root = $<HTMLElement>('s-shop');
    root?.addEventListener('click', (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;

      const tier = target.closest<HTMLElement>('.vip-flag-tier');
      if (tier && tierRow?.contains(tier)) {
        const id = tier.dataset.plan as VipPlanId | undefined;
        if (id && id !== selected && !busy) {
          selected = id;
          impact('light');
          paint();
        }
        return;
      }

      if (target.closest('#shop-vip-cta')) {
        buy();
        return;
      }

      if (target.closest('[data-soon]')) {
        impact('light');
        showToast(t('shopSoonTap'), 'warning', 2600);
      }
    });
    onVipChange(() => paint());
    onLang(() => {
      paintTiers();
      paintPerks();
      paint();
    });
  }

  return {
    setRoute(id) {
      if (id !== 'shop') return;
      mount();
      if (coins) setBalance(coins, profile.coins);
      syncPlans();
      paint();
    },
  };
}
