/**
 * shop.ts — the Shop: ONE horizontal carousel of five equal cards.
 *
 * Card 1 is the flagship and a storefront, not a second till. Every price comes from the VIP
 * tiers the Worker serves (via premium.ts), and the one checkout is `purchaseVip()` — the same
 * verified Telegram Stars flow the VIP sheet uses. Cards 2-5 are previews only: a tap opens a
 * short toast and never touches coins, Stars or inventory. This module also owns the track's
 * pointer-drag layer and the five-dot rail under it.
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
import telegramStarsImg from './assets/images/telegram_stars.png';
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

/** The authentic Telegram Stars PNG, bundled and hashed by Vite — never a glyph, sprite or emoji.
 *  `draggable="false"` keeps a mouse drag from peeling the currency mark off the card. */
function starIcon(cls = 'tg-star-icon'): HTMLImageElement {
  const img = document.createElement('img');
  img.src = telegramStarsImg;
  img.className = cls;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.draggable = false;
  return img;
}

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
  const track = $<HTMLElement>('shop-carousel');
  const dots = $<HTMLElement>('shop-dots');

  let tiers: ShopVipTier[] = shopVipTiers();
  let selected: VipPlanId = tiers.some((tier) => tier.id === VIP_HERO_PLAN)
    ? VIP_HERO_PLAN
    : tiers[0]?.id ?? VIP_HERO_PLAN;
  let busy = false;
  let statusKey = '';
  let mounted = false;

  const planOf = (): ShopVipTier | null => tiers.find((tier) => tier.id === selected) ?? tiers[0] ?? null;

  /** Retire the last checkout note so an idle card shows no leftover copy under the CTA. */
  function clearStatus(): void {
    statusKey = '';
    if (!status) return;
    status.textContent = '';
    status.hidden = true;
  }

  /** The carousel's motion layer. Touch keeps its native pan-and-snap; a mouse or pen drag
   *  follows the pointer with easing, and anything past 6px cancels the tap toast. Capture is
   *  claimed only after the threshold, so a plain tap still reaches its button. The five-dot
   *  rail is a readout of the same scroll, never a second source of truth. */
  function mountCarousel(): void {
    if (!track || track.dataset.dragReady === '1') return;
    track.dataset.dragReady = '1';
    const rail = track;

    /* ---- the dots: one passive read per frame, one write only when the index moves ---- */
    const marks: HTMLElement[] = [];
    for (const node of Array.from(dots?.children ?? [])) {
      if (node instanceof HTMLElement) marks.push(node);
    }
    let dotRaf = 0;
    let activeDot = 0;

    /** The card nearest the scrollport's centre is the one on screen. Measured in viewport
     *  space, so RTL's negative scrollLeft (and any future change to it) cannot skew it. */
    const paintDot = (): void => {
      dotRaf = 0;
      const box = rail.getBoundingClientRect();
      const mid = box.left + box.width / 2;
      let best = 0;
      let closest = Infinity;
      for (let i = 0; i < rail.children.length; i += 1) {
        const card = rail.children[i];
        if (!(card instanceof HTMLElement)) continue;
        const rect = card.getBoundingClientRect();
        const gap = Math.abs(rect.left + rect.width / 2 - mid);
        if (gap < closest) {
          closest = gap;
          best = i;
        }
      }
      if (best === activeDot) return;
      activeDot = best;
      for (let i = 0; i < marks.length; i += 1) marks[i].classList.toggle('is-active', i === best);
    };

    if (marks.length) {
      rail.addEventListener('scroll', () => {
        if (!dotRaf) dotRaf = requestAnimationFrame(paintDot);
      }, { passive: true });
    }

    /* ---- the drag: touch keeps the native gesture, mouse and pen follow the pointer ---- */
    const DRAG_SLOP = 6;
    let pointerId: number | null = null;
    let captured = false;
    let startX = 0;
    let lastX = 0;
    let lastAt = 0;
    let velocity = 0;
    let moved = false;
    let suppressUntil = 0;
    let glide = 0;
    let glideAt = 0;
    let snapBefore = '';
    let behaviorBefore = '';
    /* Pixels of pointer travel per pixel of scrollLeft: -1 in LTR, +1 in RTL, where the
       scroll origin is the right edge and scrollLeft runs negative as you advance. */
    let axis = -1;

    const reducedMotion = (): boolean =>
      document.documentElement.classList.contains('reduced-motion')
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* Glide and drag used to share one accumulator: the glide `step` wrote `scrollLeft` on every
       frame, while a drag wrote it on every raw `pointermove`. Both paths now feed the same
       one-write-per-frame commit, and the write reads `scrollLeft` exactly once. */
    let dragRaf = 0;
    let pendingDx = 0;

    const commitScroll = (): void => {
      dragRaf = 0;
      const dx = pendingDx;
      pendingDx = 0;
      if (!dx) return;
      /* One read, one write. The old order read, wrote, then read again to test for an edge —
         each read after the write forced a synchronous layout flush. */
      const before = rail.scrollLeft;
      rail.scrollLeft = before + dx;
    };

    const queueDrag = (dx: number): void => {
      pendingDx += dx;
      if (!dragRaf) dragRaf = requestAnimationFrame(commitScroll);
    };

    const cancelDrag = (): void => {
      if (dragRaf) cancelAnimationFrame(dragRaf);
      dragRaf = 0;
      pendingDx = 0;
    };

    const stopGlide = (): void => {
      if (glide) cancelAnimationFrame(glide);
      glide = 0;
    };

    const settle = (): void => {
      cancelDrag();
      rail.style.scrollSnapType = snapBefore;
      rail.style.scrollBehavior = behaviorBefore;
    };

    const step = (now: number): void => {
      const frame = Math.min(33, Math.max(8, now - glideAt || 16));
      glideAt = now;
      velocity *= Math.pow(0.9, frame / 16);
      if (Math.abs(velocity) < 0.02) {
        glide = 0;
        settle();
        return;
      }
      const before = rail.scrollLeft;
      rail.scrollLeft = before + velocity * frame;
      glide = requestAnimationFrame(step);
    };

    rail.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'touch' || ev.button !== 0) return;
      stopGlide();
      cancelDrag();
      pointerId = ev.pointerId;
      startX = lastX = ev.clientX;
      lastAt = ev.timeStamp;
      velocity = 0;
      moved = false;
      axis = getComputedStyle(rail).direction === 'rtl' ? 1 : -1;
    });

    rail.addEventListener('pointermove', (ev) => {
      if (pointerId !== ev.pointerId) return;
      if (!moved && Math.abs(ev.clientX - startX) > DRAG_SLOP) {
        moved = true;
        captured = true;
        snapBefore = rail.style.scrollSnapType;
        behaviorBefore = rail.style.scrollBehavior;
        rail.style.scrollSnapType = 'none';
        rail.style.scrollBehavior = 'auto';
        rail.setPointerCapture(ev.pointerId);
        rail.classList.add('is-dragging');
      }
      if (!moved) return;
      ev.preventDefault();
      const dx = (ev.clientX - lastX) * axis;
      const dt = Math.max(1, ev.timeStamp - lastAt);
      /* The scroll itself is coalesced to one write per frame; the velocity keeps its per-event
         resolution so a fling still reads the true release speed. */
      queueDrag(dx);
      velocity = velocity * 0.35 + (dx / dt) * 0.65;
      velocity = Math.max(-3, Math.min(3, velocity));
      lastX = ev.clientX;
      lastAt = ev.timeStamp;
    });

    const release = (ev: PointerEvent): void => {
      if (pointerId !== ev.pointerId) return;
      pointerId = null;
      rail.classList.remove('is-dragging');
      if (captured && rail.hasPointerCapture(ev.pointerId)) rail.releasePointerCapture(ev.pointerId);
      captured = false;
      /* the trailing frame lands before the tap gate opens, so a suppressed click cannot be
         followed by a stray scroll step */
      cancelDrag();
      if (!moved) {
        settle();
        return;
      }
      suppressUntil = performance.now() + 300;
      /* a pause before release is a placement, not a fling */
      if (performance.now() - lastAt > 120) velocity = 0;
      if (!reducedMotion() && Math.abs(velocity) > 0.15) {
        glideAt = performance.now();
        glide = requestAnimationFrame(step);
        return;
      }
      settle();
    };
    rail.addEventListener('pointerup', release);
    rail.addEventListener('pointercancel', release);

    rail.addEventListener('click', (ev) => {
      if (performance.now() >= suppressUntil) return;
      ev.preventDefault();
      ev.stopPropagation();
      suppressUntil = 0;
    }, true);
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
      /* the bundled Telegram Stars artwork rides the price row at its own crisp size in every locale */
      price.append(bdi(String(tier.stars)), starIcon());

      button.append(days, price);
      return button;
    }));
  }

  function paintPerks(): void {
    if (!perks) return;
    /* The four promises are pure translated copy: a language that has not moved, and a plan
       snapshot that has not moved, owe the list no rebuild. */
    const key = PERKS.map((perk) => `${t(perk.label)}\u0001${t(perk.value)}`).join('|');
    if (key === perksKey) return;
    perksKey = key;
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
      ctaText.append(starIcon());
    }

    if (status) {
      status.hidden = !statusKey;
      status.textContent = statusKey ? t(statusKey) : '';
    }
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
    /* One delegated listener on the stable Shop root. The tier row is re-rendered on language
       and plan refreshes, so direct bindings would go stale; delegation keeps every tap live.
       The closest() walk also survives clicks landing on an inner icon or <bdi>. */
    const root = $<HTMLElement>('s-shop');
    root?.addEventListener('click', (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;

      const tier = target.closest<HTMLElement>('.vip-flag-tier');
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

      if (target.closest('[data-soon]')) {
        impact('light');
        showToast(t('shopSoonTap'), 'warning', 2600);
      }
    });
    mountCarousel();
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
