/**
 * shop.ts — the cosmetics screen: three tabs, one card per item, and a live miniature board on
 * each card painted by the race's own renderer rather than a picture of one.
 *
 * Coins here are mock and local: the only gate on a purchase is the balance in the header, which is
 * the same number Home shows and the same save the board reads. Buying spends, takes ownership and
 * puts the item on in one tap, so the card you just paid for is wearing it when the sheet closes.
 *
 * Showcase mode parks all of that: the tabs still browse, every card still previews the real
 * thing, but the only card that answers is the one you are already wearing. The rest wear an inert
 * "Not for sale" capsule, and the two doors to the wallet — the card and the confirm key — both
 * refuse before a coin moves. Nothing was deleted to get here: the Admin Command Center's "Shop
 * Sales Enabled" switch flips the whole till back on live (`salesOpen` in the ShopApi).
 */
import { ITEMS, themeOf, type CosKind, type Item, type Theme } from './themes';
import { createPreview, type Preview } from './render';
import { buy, equip, isEquipped, onChange, owns, profile } from './storage';
import { coinText, mountCoins, setBalance } from './coin';
import { motionReduced, onSettings } from './settings';
import { impact, notify } from './telegram';
import type { Sheets } from './sheets';

export interface ShopApi {
  sheets: Sheets;
  /** sheet ids come from the DOM so markup stays the single source of truth */
  sheet(id: string): HTMLElement | null;
  /** the board's own toast (`showNote` in main.ts): the shop refuses in the game's voice */
  note(msg: string, error: boolean, ttl: number): void;
  /** Is the till open? Read live, so the admin switch takes effect without a reload. */
  salesOpen(): boolean;
}

export interface Shop {
  setRoute(id: string): void;
  /** Repaint the cards and the header — the sales switch, or a grant, just moved. */
  refresh(): void;
}

/** What a shut till says: the catalogue is open, the wallet is not. */
const SHOWCASE_NOTE = 'Shop is temporarily disabled — items are not for sale.';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** One card: preview, name, price, and the single button whose label carries the state. */
const CARD = `<article class="cos"><canvas class="cos-pv" aria-hidden="true"></canvas>`
  + `<div class="cos-txt"><h3 class="cos-n"></h3><p class="cos-d"></p>`
  + `<div class="cos-foot"><span class="cos-price"><span class="coin" data-coin aria-hidden="true"></span><b></b></span>`
  + `<button class="cos-btn" type="button">`
  + `<svg class="cos-lock" aria-hidden="true"><use href="#i-lock" /></svg><span class="cos-lb"></span>`
  + `</button></div>`
  + `<p class="cos-note" hidden></p></div></article>`;

const make = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.firstElementChild as HTMLElement;
};

interface Card {
  el: HTMLElement; btn: HTMLButtonElement; label: HTMLElement;
  note: HTMLElement; item: Item; pv: Preview;
}

type State = 'buy' | 'owned' | 'equipped' | 'short' | 'locked';

export function createShop(api: ShopApi): Shop {
  const grid = $<HTMLElement>('shop-grid');
  const chip = $<HTMLElement>('shop-balance');
  const coins = $<HTMLSpanElement>('shop-coins');
  const tabs = [...document.querySelectorAll<HTMLElement>('[data-shop]')];
  const sheet = api.sheet('sheet-buy');
  const yes = $<HTMLButtonElement>('buy-yes');
  let kind: CosKind = 'ball';
  let cards: Card[] = [];
  let shown = false;
  let raf = 0;
  let flash = '';
  let pending: Item | null = null;
  let pvBuy: Preview | null = null;

  /** The item on its own, seen through whatever else is currently worn. */
  const themeFor = (it: Item): Theme => {
    const e = profile.equipped;
    return it.kind === 'ball' ? themeOf(it.id, e.wall, e.board)
      : it.kind === 'wall' ? themeOf(e.ball, it.id, e.board)
        : themeOf(e.ball, e.wall, it.id);
  };

  /** The card's state: the worn item is never locked, and while the till is shut nothing else answers. */
  const stateOf = (it: Item): State => {
    if (isEquipped(it.kind, it.id)) return 'equipped';
    if (!api.salesOpen()) return 'locked';
    if (owns(it.kind, it.id)) return 'owned';
    return profile.coins >= it.price ? 'buy' : 'short';
  };

  /* ---------- animation: only while the shop is the screen you are looking at ---------- */

  function loop(now: number) {
    for (const c of cards) c.pv.draw(now);
    if (pvBuy && sheet && !sheet.hidden) pvBuy.draw(now);
    raf = requestAnimationFrame(loop);
  }

  function sync() {
    const want = shown && !motionReduced() && !document.hidden;
    if (want && !raf) raf = requestAnimationFrame(loop);
    else if (!want && raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  /** Reduced motion, or a sheet that is not animating: one settled frame each. */
  function still() {
    if (raf) return;
    for (const c of cards) c.pv.settle();
    pvBuy?.settle();
  }

  /* ---------- cards ---------- */

  function build() {
    cards = ITEMS[kind].map((item) => {
      const el = make(CARD);
      el.dataset.id = item.id;
      const canvas = el.querySelector<HTMLCanvasElement>('canvas')!;
      const btn = el.querySelector<HTMLButtonElement>('button')!;
      const label = el.querySelector<HTMLElement>('.cos-lb')!;
      const note = el.querySelector<HTMLElement>('.cos-note')!;
      el.querySelector('.cos-n')!.textContent = item.name;
      // the description only earns its space on the wide card, where it fills the row
      el.querySelector('.cos-d')!.textContent = item.desc;
      // a starter item has no price to show, so it says what it is instead of "0"
      const price = el.querySelector<HTMLElement>('.cos-price')!;
      price.classList.toggle('free', item.price === 0);
      price.querySelector('b')!.textContent = item.price ? coinText(item.price) : 'Starter';
      mountCoins(el);
      btn.addEventListener('click', () => act(item));
      // a locked card refuses wherever it is tapped, not only on the capsule that says so
      el.addEventListener('click', (e) => {
        if (btn.contains(e.target as Node)) return;      // the capsule owns its own click
        if (isEquipped(item.kind, item.id)) return;      // the worn card is a no-op, as it always was
        refuse();
      });
      return { el, btn, label, note, item, pv: createPreview(canvas, item.kind, themeFor(item)) };
    });
    grid.textContent = '';
    for (const c of cards) grid.append(c.el);
    // an odd last card takes the whole row and lies on its side, so the grid never leaves a hole
    if (cards.length % 2) cards[cards.length - 1].el.classList.add('wide');
    size();
    paint();
    still();
  }

  function paint() {
    for (const c of cards) {
      const s = stateOf(c.item);
      const locked = s === 'locked';
      c.el.dataset.state = s;
      c.label.textContent = locked ? 'Not for sale'
        : s === 'equipped' ? 'Equipped' : s === 'owned' ? 'Equip' : 'Buy';
      c.btn.setAttribute('aria-label', locked
        ? `Not for sale: ${c.item.name} ${c.item.kind} — the shop is temporarily closed`
        : `${c.label.textContent}: ${c.item.name} ${c.item.kind}`);
      /* `aria-disabled`, not `disabled`: a locked capsule still has to take the tap that explains
         itself, and a real `disabled` button swallows the click before the guard can speak. */
      c.btn.disabled = !locked && (s === 'short' || s === 'equipped');
      c.btn.setAttribute('aria-disabled', String(locked || s === 'short' || s === 'equipped'));
      if (s === 'equipped') c.btn.setAttribute('aria-current', 'true');
      else c.btn.removeAttribute('aria-current');
      c.note.hidden = s !== 'short';
      if (s === 'short') c.note.textContent = `${coinText(c.item.price - profile.coins)} coins short`;
      c.pv.setTheme(themeFor(c.item));
    }
    setBalance(coins, profile.coins);
  }

  /** The one refusal the shop has: soft tap, one line, no state touched. */
  function refuse() {
    impact('light');
    api.note(SHOWCASE_NOTE, false, 2600);
  }

  function celebrate() {
    for (const c of cards) c.el.classList.toggle('just', c.item.id === flash);
  }

  function act(it: Item) {
    if (isEquipped(it.kind, it.id)) return;               // the worn item: nothing to do, same as ever
    if (!api.salesOpen()) { refuse(); return; }           // guard: no equip, no spend, no unlock
    if (owns(it.kind, it.id)) { impact('light'); equip(it.kind, it.id); return; }
    ask(it);
  }

  /* ---------- buying ---------- */

  function ask(it: Item) {
    if (!sheet || profile.coins < it.price) return;      // the card is already disabled; this is the second gate
    pending = it;
    $<HTMLElement>('buy-title').textContent = it.name;
    $<HTMLElement>('buy-desc').textContent = it.desc;
    $<HTMLElement>('buy-price').textContent = coinText(it.price);
    $<HTMLElement>('buy-have').textContent = coinText(profile.coins);
    $<HTMLElement>('buy-after').textContent = coinText(profile.coins - it.price);
    yes.textContent = `Buy for ${coinText(it.price)}`;
    const t = themeFor(it);
    if (!pvBuy) pvBuy = createPreview($<HTMLCanvasElement>('buy-pv'), it.kind, t);
    else pvBuy.setTheme(t);
    api.sheets.open(sheet);
    pvBuy.resize();                                      // the sheet only has a width once it is open
    impact('light');
    sync();
    still();
  }

  yes.addEventListener('click', () => {
    if (!pending) return;
    const it = pending;
    pending = null;
    api.sheets.close();
    // the last gate before the wallet: while the till is shut the confirm key refuses too
    if (!api.salesOpen()) { refuse(); return; }
    if (buy(it.kind, it.id, it.price) !== 'bought') { notify('warning'); return; }
    notify('success');
    impact('medium');
    flash = it.id;
    celebrate();
    setTimeout(() => { flash = ''; celebrate(); }, 1200);
  });

  /* ---------- tabs and sizing ---------- */

  function select(k: CosKind) {
    if (k === kind && cards.length) return;
    kind = k;
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.shop === k));
    grid.setAttribute('aria-labelledby', `tab-${k}`);
    impact('light');
    build();
  }

  for (const t of tabs) t.addEventListener('click', () => select(t.dataset.shop as CosKind));

  function size() {
    for (const c of cards) c.pv.resize();
    pvBuy?.resize();
    still();
  }

  new ResizeObserver(size).observe(grid);
  document.addEventListener('visibilitychange', sync);
  onSettings(sync);
  onChange(() => {
    paint();
    chip.classList.remove('bump');
    void chip.offsetWidth;
    if (!motionReduced()) chip.classList.add('bump');
    still();
  });

  return {
    setRoute(id) {
      shown = id === 'shop';
      if (shown && !cards.length) build();
      sync();
      if (shown) size();
    },
    /* The sales switch (or a grant) moved: repaint every card in place. Before the grid has ever
       been built there is nothing to repaint — `build()` paints on the way in anyway. */
    refresh() {
      if (!cards.length) return;
      paint();
      size();
    },
  };
}
