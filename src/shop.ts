/**
 * shop.ts — the Shop: the VIP subscription ONLY, as one centered Royal Obsidian & 24K Gold card.
 *
 * There is no carousel, no coming-soon shelf and no other item: the screen is the single
 * VIP centerpiece. Every price comes from the VIP tiers the Worker serves (via premium.ts), and
 * the one checkout is `purchaseVip()` — the same verified Telegram Stars flow the VIP sheet uses.
 *
 * The screen is compacted to a single mobile viewport: a crown medallion head, a 3-column tier
 * row, a 2x2 perk bento and the gold CTA. Its scrollbars are hidden in CSS, so nothing shows a
 * browser track even on a short phone. Every figure is a Latin `<bdi dir="ltr">` island and every
 * Stars mark is the exact `telegram_stars.png` asset — no glyph, sprite star or emoji.
 */
import { profile } from './storage';
import { setBalance } from './coin';
import { onLang, t } from './settings';
import { impact, notify } from './telegram';
import {
  isPremiumUser, onVipChange, purchaseVip, refreshShopVipTiers, shopVipTiers, vipDaysLeft,
  type ShopVipTier,
} from './premium';
import { VIP_HERO_PLAN, type VipPlanId } from '../shared/vip';
import telegramStarsUrl from './assets/images/telegram_stars.png';
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

/** The four promises: label, value pill, and the crisp inline vector that leads each tile.
 *  `ltr` pins 4/4, +50% and ×2 so no RTL locale can mirror a figure. */
const PERKS: ReadonlyArray<{ label: string; value: string; ltr: boolean; ico: string }> = [
  { label: 'shopPerkChat', value: 'shopPerkChatVal', ltr: false, ico: '#shop-i-chat' },
  { label: 'shopPerkRecovery', value: 'shopPerkRecoveryVal', ltr: true, ico: '#shop-i-heal' },
  { label: 'shopPerkBoost', value: 'shopPerkBoostVal', ltr: true, ico: '#shop-i-boost' },
  { label: 'shopPerkDouble', value: 'shopPerkDoubleVal', ltr: true, ico: '#shop-i-gem' },
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

/** The exact Telegram Stars logo, bundled and hashed by Vite — never a glyph, sprite or emoji.
 *  It rides all three plan cards, the gold CTA and the checkout status banner. */
function starIcon(cls = 'shop-star-ico'): HTMLImageElement {
  const img = document.createElement('img');
  img.className = cls;
  img.src = telegramStarsUrl;
  img.alt = '';
  img.width = 17;
  img.height = 17;
  img.decoding = 'async';
  img.setAttribute('aria-hidden', 'true');
  return img;
}

/** A crisp inline vector from the Shop's own symbol set (crown, chat, shield, chevrons, gem). */
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
  const coins = $<HTMLElement>('shop-coins');
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

  /** The flagship's localized name. The whole title wears the metallic-gold foil in CSS. */
  function paintTitle(): void {
    const host = $<HTMLElement>('shop-vip-title');
    if (host) host.textContent = t('shopVipTitle');
  }

  const planOf = (): ShopVipTier | null => tiers.find((tier) => tier.id === selected) ?? tiers[0] ?? null;

  /** Retire the last checkout note so an idle card shows no leftover copy under the CTA. */
  function clearStatus(): void {
    statusKey = '';
    if (!status) return;
    status.replaceChildren();
    status.hidden = true;
  }

  /** One serialization of what the tier row is built from, so an unchanged plan snapshot never
   *  rebuilds its buttons. `paintTiers` records the key it painted; `syncPlans` compares. */
  const tierSignature = (): string =>
    tiers.map((tier) => `${tier.id}:${tier.days}:${tier.stars}`).join('|');
  let tiersKey = '';
  let perksKey = '';

  function paintTiers(): void {
    if (!tierRow) return;
    tiersKey = tierSignature();
    tierRow.setAttribute('aria-label', t('vipPlansLabel'));
    tierRow.replaceChildren(...tiers.map((tier) => {
      const button = el('button', 'shop-vip-tier');
      button.type = 'button';
      button.dataset.plan = tier.id;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(tier.id === selected));
      button.setAttribute('aria-label', `${t('shopVipKicker')} · ${tier.days} ${t('vipPlanUnitDays')} · ${tier.stars}`);
      /* the hero tier wears the crown pill; the long term wears its emerald savings badge */
      if (tier.id === VIP_HERO_PLAN) button.append(el('span', 'shop-vip-tier-badge', t('vipPlanProRibbon')));
      if (tier.id === '90d') {
        const tag = el('span', 'shop-vip-tier-tag');
        tag.append(bdi(t('vipPlanGrandTag')));
        button.append(tag);
      }

      const days = el('span', 'shop-vip-tier-days');
      days.append(bdi(String(tier.days)), el('span', 'shop-vip-tier-unit', t('vipPlanUnitDays')));
      const price = el('span', 'shop-vip-tier-price');
      /* the exact Telegram Stars PNG rides the price row at its own crisp size */
      price.append(starIcon(), bdi(String(tier.stars)));

      button.append(days, price);
      return button;
    }));
  }

  function paintPerks(): void {
    if (!perks) return;
    /* The four promises are pure translated copy: a language that has not moved, and a plan
       snapshot that has not moved, owe the grid no rebuild. */
    const key = PERKS.map((perk) => `${t(perk.label)}\u0001${t(perk.value)}`).join('|');
    if (key === perksKey) return;
    perksKey = key;
    perks.replaceChildren(...PERKS.map((perk) => {
      const tile = el('li', 'shop-vip-perk');
      const top = el('span', 'shop-vip-perk-top');
      const mark = el('span', 'shop-vip-perk-ico');
      mark.append(svg(perk.ico, 'shop-vip-perk-svg'));
      const value = el('span', 'shop-vip-perk-val');
      if (perk.ltr) value.append(bdi(t(perk.value)));
      else value.textContent = t(perk.value);
      top.append(mark, value);
      tile.append(top, el('span', 'shop-vip-perk-label', t(perk.label)));
      return tile;
    }));
  }

  /** The checkout note: the exact Stars mark followed by the localized result sentence. */
  function paintStatus(): void {
    if (!status) return;
    status.hidden = !statusKey;
    if (!statusKey) {
      status.replaceChildren();
      return;
    }
    status.replaceChildren(starIcon(), el('span', 'shop-vip-status-t', t(statusKey)));
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

    for (const button of tierRow?.querySelectorAll<HTMLButtonElement>('.shop-vip-tier') ?? []) {
      const on = button.dataset.plan === selected;
      button.classList.toggle('is-selected', on);
      button.setAttribute('aria-checked', String(on));
    }

    if (cta && ctaText) {
      cta.disabled = busy || tiers.length === 0;
      cta.classList.toggle('is-busy', busy);
      ctaText.replaceChildren();
      const plan = planOf();
      if (busy) ctaText.append(el('span', 'shop-vip-cta-label', t('vipCtaBusy')));
      else if (plan) {
        /* The sentence is one inline span so its words and its <bdi> figures flow as normal
           text; the exact Stars mark follows it as the second flex item. */
        const label = el('span', 'shop-vip-cta-label');
        write(label, t(active ? 'shopVipRenew' : 'shopVipCta'), {
          days: String(plan.days),
          price: String(plan.stars),
        });
        ctaText.append(label, starIcon());
      }
    }

    paintStatus();
  }

  /** Re-read the admin's tiers; a failed read keeps the sheet already on screen. The read itself
   *  is TTL-cached in premium.ts, and an unchanged snapshot skips both DOM rebuilds below. */
  function syncPlans(): void {
    void refreshShopVipTiers().then((changed) => {
      tiers = shopVipTiers();
      if (!tiers.some((tier) => tier.id === selected)) {
        selected = tiers.some((tier) => tier.id === VIP_HERO_PLAN) ? VIP_HERO_PLAN : tiers[0]?.id ?? selected;
      }
      /* `changed` is the prices moving under us; the local signature also catches a rebuild the
         first mount still owes, and a selection that had to move to a live card. */
      if (!changed && tiersKey === tierSignature()) {
        paint();
        return;
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
    /* a new checkout starts from a clean card: the previous attempt's note is retired */
    clearStatus();
    paint();
    impact('light');
    void purchaseVip(plan.id).then((result) => {
      busy = false;
      /* A confirmed (or preview) pass earns its toast inside premium.ts, never here. The
         entitlement change already repainted the badge; paint once more now that `busy` is
         false so the CTA immediately reads "extend" with the updated price. */
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
    paintTitle();
    paintTiers();
    paintPerks();
    paint();
    /* One delegated listener on the stable Shop root. The tier row is re-rendered on language
       and plan refreshes, so direct bindings would go stale; delegation keeps every tap live.
       The closest() walk also survives clicks landing on an inner icon or <bdi>. */
    const root = $<HTMLElement>('s-shop');
    root?.addEventListener('click', (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;

      const tier = target.closest<HTMLElement>('.shop-vip-tier');
      if (tier && tierRow?.contains(tier)) {
        const id = tier.dataset.plan as VipPlanId | undefined;
        if (id && id !== selected && !busy) {
          selected = id;
          /* a fresh pick retires the last checkout note: the idle card never keeps stale copy */
          clearStatus();
          impact('light');
          paint();
        }
        return;
      }

      if (target.closest('#shop-vip-cta')) {
        buy();
        return;
      }
    });
    onVipChange(() => paint());
    onLang(() => {
      paintTitle();
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
