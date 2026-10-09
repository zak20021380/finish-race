/**
 * shop.ts — the cosmetics screen: three tabs, one card per item, and a live miniature board on
 * each card painted by the race's own renderer rather than a picture of one.
 *
 * Coins here are mock and local: the only gate on a purchase is the balance in the header, which is
 * the same number Home shows and the same save the board reads. Buying spends, takes ownership and
 * puts the item on in one tap, so the card you just paid for is wearing it when the sheet closes.
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
}

export interface Shop {
  setRoute(id: string): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** One card: preview, name, price, and the single button whose label carries the state. */
const CARD = `<article class="cos"><canvas class="cos-pv" aria-hidden="true"></canvas>`
  + `<div class="cos-txt"><h3 class="cos-n"></h3><p class="cos-d"></p>`
  + `<div class="cos-foot"><span class="cos-price"><span class="coin" data-coin aria-hidden="true"></span><b></b></span>`
  + `<button class="cos-btn" type="button"></button></div>`
  + `<p class="cos-note" hidden></p></div></article>`;

const make = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.firstElementChild as HTMLElement;
};

interface Card { el: HTMLElement; btn: HTMLButtonElement; note: HTMLElement; item: Item; pv: Preview }

type State = 'buy' | 'owned' | 'equipped' | 'short';

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

  const stateOf = (it: Item): State =>
    isEquipped(it.kind, it.id) ? 'equipped'
      : owns(it.kind, it.id) ? 'owned'
        : profile.coins >= it.price ? 'buy' : 'short';

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
      return { el, btn, note, item, pv: createPreview(canvas, item.kind, themeFor(item)) };
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
      c.el.dataset.state = s;
      c.btn.textContent = s === 'equipped' ? 'Equipped' : s === 'owned' ? 'Equip' : 'Buy';
      c.btn.setAttribute('aria-label', `${c.btn.textContent}: ${c.item.name} ${c.item.kind}`);
      c.btn.disabled = s === 'short' || s === 'equipped';
      c.btn.setAttribute('aria-disabled', String(c.btn.disabled));
      if (s === 'equipped') c.btn.setAttribute('aria-current', 'true');
      else c.btn.removeAttribute('aria-current');
      c.note.hidden = s !== 'short';
      if (s === 'short') c.note.textContent = `${coinText(c.item.price - profile.coins)} coins short`;
      c.pv.setTheme(themeFor(c.item));
    }
    setBalance(coins, profile.coins);
  }

  function celebrate() {
    for (const c of cards) c.el.classList.toggle('just', c.item.id === flash);
  }

  function act(it: Item) {
    if (isEquipped(it.kind, it.id)) return;
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
  };
}
