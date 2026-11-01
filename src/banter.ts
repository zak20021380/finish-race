/**
 * banter.ts — the post-match tray: quick reactions, the VIP sticker stash, the quick-chat
 * vocabulary and the composer behind them.
 *
 * The tray sits directly above the rematch key in the Match Complete capsule: five one-tap
 * reactions on a single glass lane, the VIP stash key, and the chat key. The chat key opens one
 * row in place — never a second storey — for everyone:
 *
 *  - the composer is open to every seat, and the mobile keyboard is never blocked. Typing is the
 *    hook, not the product: a free seat can write a full 40-character line and keep it;
 *  - the send key is where VIP begins. For a free seat it wears a micro-lock, and a tap fires the
 *    warning haptic, keeps the draft intact and opens the store with the broadcast hook. A preview
 *    or a real Premium seat returns with the same line one tap from the wire;
 *  - the four closed tactical lines sit under the composer while it is open, so a free seat's
 *    voice is never smaller than a tap.
 *
 * The stash is the same lane on its second page: five elite stickers that a VIP sends like any
 * other reaction, and that everybody else can see, tap, and be sold. A locked sticker is not
 * `disabled` — a dead key cannot explain itself — so it keeps its hitbox, fires the warning
 * haptic and opens the store.
 *
 * The wire is the only difference between opponents. Online, a line rides the same socket as the
 * race as `POST_MATCH_CHAT`; the rival's answer comes back through `onPostChat`, carrying the
 * room's verdict on whether its author is VIP (never the author's own claim). Against the machine,
 * the same tap wakes a reply after 1.2s. When the rival walks out — a frame, a closed socket —
 * `opponentLeft()` locks the whole surface so a taunt never flies into an empty room.
 */
import './banter.css';
import { onLang, t } from './settings';
import { impact, notify, openLink } from './telegram';
import { grantVipPreview, insideTelegram, isPremiumUser, vipSource } from './premium';
import {
  POST_CHAT_FREE_REACTIONS, POST_CHAT_PRESETS, postChatPresetText,
  type PostChatLine, type PostChatPresetId,
} from './data/postchat';

/** The outcome the tray is speaking over. */
export interface BanterView {
  localSide: number;
  /** The seat a canned reply can come from when no wire answers. */
  rivalSide: number;
  /** The rival already left: open the tray in its locked state. */
  locked: boolean;
}

/** A row's bubble anchor, resolved at send time because a language flip rebuilds the roster. */
export interface BanterAnchor {
  node: HTMLElement;
  text: HTMLElement;
  /** The crown a VIP line wears, or null when the row was painted without one. */
  badge: HTMLElement | null;
}

export interface BanterWiring {
  /** The live socket's post-match sender, or null for a race against the machine. */
  wire: () => ((line: PostChatLine) => boolean) | null;
  /** The row bubble owned by a seat, or null when that seat is not on the ladder. */
  anchor: (side: number) => BanterAnchor | null;
}

export interface Banter {
  open(view: BanterView): void;
  close(): void;
  /** A line the rival sent, placed on the row of `side`. */
  inbound(line: PostChatLine, side: number, vip?: boolean): void;
  /** The rival left the result: raise the alert and lock every control. */
  opponentLeft(): void;
}

/** One message lives this long before its graceful exit. */
const BUBBLE_MS = 4500;
/** The exit matches `.result-say.is-out` in banter.css. */
const LEAVE_MS = 300;
/** One message per player per two seconds — the anti-spam gate the brief asks for. */
const COOLDOWN_MS = 2000;
/** The machine thinks for a beat before answering. */
const BOT_MS = 1200;
const MAX_CHARS = 40;
/**
 * The five faces the tray offers, in a fixed order that never moves under a language flip. The
 * list lives beside the canned phrases because the room reads it too: a face is the one "text"
 * a seat without VIP is allowed to broadcast.
 */
const REACTIONS = POST_CHAT_FREE_REACTIONS;
const BOT_LINES = 4;

/**
 * The art behind each free face. The glyph stays the wire payload — the room only relays the five
 * pictographs it owns — while the tray and the bubble paint the vector token instead of the OS
 * emoji. Every token shares one recessed disc; the tone only changes the metal.
 */
const REACTION_ART: Record<string, { icon: string; tone: string }> = {
  '🤝': { icon: '#i-rx-alliance', tone: 'alliance' },
  '🔥': { icon: '#i-rx-ember', tone: 'heat' },
  '💀': { icon: '#i-rx-skull', tone: 'defeat' },
  '⚡': { icon: '#i-rx-volt', tone: 'spark' },
  '🧠': { icon: '#i-rx-mind', tone: 'mind' },
};

/**
 * The VIP stash: five elite badges behind the crown key. Each is a pictograph-only line, so it
 * lands as the round medal rather than a pill — a sticker, in the same visual grammar as a
 * reaction, which is exactly what makes the locked ones legible as "the good ones".
 *
 * Every glyph here is Emoji 1.0. A salute (🫡) was the brief's example, but it is Emoji 14 and
 * renders as an empty box on any client older than 2021 — in the one row that has to look
 * expensive. The medal says the same thing and renders everywhere.
 */
const VIP_STICKERS: ReadonlyArray<{ id: string; glyph: string; key: string }> = [
  { id: 'skull', glyph: '💀', key: 'banterStickerSkull' },
  { id: 'crown', glyph: '👑', key: 'banterStickerCrown' },
  { id: 'bolt', glyph: '⚡', key: 'banterStickerBolt' },
  { id: 'salute', glyph: '🎖️', key: 'banterStickerSalute' },
  { id: 'trophy', glyph: '🏆', key: 'banterStickerTrophy' },
];

/** The i18n key each closed preset paints from, in drawer order. */
const PRESET_KEYS: Record<PostChatPresetId, string> = {
  gg: 'banterCannedGg',
  rematch: 'banterCannedRematch',
  luck: 'banterCannedLuck',
  wp: 'banterCannedWp',
};

/** The store sheet's three promises, in the order a player weighs them. */
const VIP_FEATURES: ReadonlyArray<{ ico: string; key: string; sub: string }> = [
  { ico: '#i-chat', key: 'vipFeatChat', sub: 'vipFeatChatSub' },
  { ico: '#i-star', key: 'vipFeatStickers', sub: 'vipFeatStickersSub' },
  { ico: '#i-crown', key: 'vipFeatGold', sub: 'vipFeatGoldSub' },
];

/** Where Telegram itself sells the upgrade. Outside the client the sheet previews instead. */
const TELEGRAM_PREMIUM_URL = 'https://t.me/PremiumBot';

/**
 * A message made only of pictographs — no letters, no digits — is a reaction, not a sentence:
 * it renders as the round glass medal instead of a pill. Joiners, variation selectors, skin
 * tones and whitespace are allowed alongside the glyphs.
 */
const EMOTE_ONLY =
  /^(?:\p{Extended_Pictographic}|[\u200D\uFE0F\u20E3\u{1F3FB}-\u{1F3FF}]|\s)+$/u;
const HAS_PICTOGRAPH = /\p{Extended_Pictographic}/u;

const clip = (raw: string): string => {
  const clean = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return Array.from(clean).slice(0, MAX_CHARS).join('');
};

const isEmote = (text: string): boolean => HAS_PICTOGRAPH.test(text) && EMOTE_ONLY.test(text);

/** The drawer's copy for a preset, with the canonical line as the fallback. */
function presetLabel(id: PostChatPresetId): string {
  const key = PRESET_KEYS[id];
  const painted = t(key);
  return painted === key ? postChatPresetText(id) : painted;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** An inline sprite reference, never an interpolated string: the art is first-party markup. */
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

const byId = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`banter: #${id} is missing`);
  return node as T;
};

/** Which row is open under the faces: nothing, or the composer with its quick-chat vocabulary. */
type Drawer = 'none' | 'compose';
/** Why the store opened: the standing sell, or the send key the player just tried to use. */
type SheetReason = 'sell' | 'gate';

export function createBanter(wiring: BanterWiring): Banter {
  const dock = byId<HTMLDivElement>('result-banter');
  const label = byId<HTMLElement>('banter-label');
  const alert = byId<HTMLParagraphElement>('banter-alert');
  const alertText = byId<HTMLElement>('banter-alert-t');
  const reacts = byId<HTMLDivElement>('banter-reacts');
  const form = byId<HTMLFormElement>('banter-form');
  const input = byId<HTMLInputElement>('banter-input');
  const send = byId<HTMLButtonElement>('banter-send');
  const sendLock = byId<HTMLElement>('banter-send-lock');
  const toggle = byId<HTMLButtonElement>('banter-toggle');
  /* the <use> swaps between the chat bubble and the close glyph as the drawer flips */
  const toggleIco = byId<HTMLElement>('banter-toggle-ico');
  const closeKey = byId<HTMLButtonElement>('banter-close');
  const stashKey = byId<HTMLButtonElement>('banter-vip-key');
  const stashLock = byId<HTMLElement>('banter-vip-lock');
  const canned = byId<HTMLDivElement>('banter-canned');
  const cannedK = byId<HTMLElement>('banter-canned-k');
  const cannedGrid = byId<HTMLDivElement>('banter-canned-grid');
  const vipPill = byId<HTMLButtonElement>('banter-vip-pill');
  const vipPillT = byId<HTMLElement>('banter-vip-pill-t');
  const sheet = byId<HTMLDivElement>('vip-sheet');
  const sheetScrim = byId<HTMLElement>('vip-scrim');
  const sheetKicker = byId<HTMLElement>('vip-kicker');
  const sheetTitle = byId<HTMLElement>('vip-sheet-title');
  const sheetSub = byId<HTMLElement>('vip-sub');
  const sheetFeats = byId<HTMLUListElement>('vip-feats');
  const sheetCta = byId<HTMLButtonElement>('vip-cta');
  const sheetCtaIco = byId<HTMLElement>('vip-cta-ico');
  const sheetCtaT = byId<HTMLElement>('vip-cta-t');
  const sheetFine = byId<HTMLElement>('vip-fine');
  const sheetClose = byId<HTMLButtonElement>('vip-close');
  /* the capsule the sheet covers: inert while the store is up, so a tab never lands behind it */
  const resultCard = document.getElementById('result-card');

  /* ---------- the rail: two pages, five slots each ---------- */

  const freeKeys: HTMLButtonElement[] = [];
  const vipKeys: HTMLButtonElement[] = [];

  for (const face of REACTIONS) {
    const key = el('button', 'banter-react');
    const art = REACTION_ART[face];
    key.type = 'button';
    key.dataset.emoji = face;
    if (art) {
      key.dataset.tone = art.tone;
      key.append(ico(art.icon, 'banter-glyph'));
    } else {
      key.textContent = face;
    }
    key.addEventListener('click', () => {
      if (lockedNow() || cooling()) return;
      pop(key);
      say({ text: face });
    });
    reacts.appendChild(key);
    freeKeys.push(key);
  }

  for (const sticker of VIP_STICKERS) {
    const key = el('button', 'banter-react banter-sticker');
    key.type = 'button';
    key.dataset.glyph = sticker.glyph;
    key.dataset.vip = '1';
    key.hidden = true;
    key.append(el('span', 'banter-sticker-g', sticker.glyph));
    const lock = el('span', 'banter-sticker-lock');
    lock.append(ico('#i-lock'));
    key.append(lock);
    key.addEventListener('click', () => {
      if (lockedNow()) return;
      if (!isPremiumUser()) {
        /* the key keeps its hitbox precisely so it can say why: a `disabled` key cannot */
        notify('warning');
        denied();
        openSheet(key);
        return;
      }
      if (cooling()) return;
      pop(key);
      say({ text: sticker.glyph });
    });
    reacts.appendChild(key);
    vipKeys.push(key);
  }

  /* ---------- the canned drawer: four tiles and the pill ---------- */

  const cannedKeys: HTMLButtonElement[] = [];
  for (const preset of POST_CHAT_PRESETS) {
    const chip = el('button', 'banter-canned-chip');
    chip.type = 'button';
    chip.dataset.preset = preset.id;
    chip.addEventListener('click', () => {
      if (lockedNow() || cooling()) return;
      impact('light');
      say({ preset: preset.id });
    });
    cannedGrid.appendChild(chip);
    cannedKeys.push(chip);
  }

  let view: BanterView | null = null;
  let open = false;
  let locked = false;
  /** True while the rail shows the VIP page. */
  let vipPage = false;
  let drawer: Drawer = 'none';
  let lastSentAt = 0;
  let coolTimer = 0;
  let botTimer = 0;
  let botTurn = 0;
  let deniedTimer = 0;
  let sheetOpen = false;
  let sheetReason: SheetReason = 'sell';
  let sheetReturn: HTMLElement | null = null;
  /** Lines that landed between the winning move and the card: replayed when the tray opens. */
  let pending: Array<{ line: PostChatLine; side: number; vip: boolean }> = [];
  const bubbleTimers = new Map<number, number>();
  const popTimers = new WeakMap<HTMLButtonElement, number>();

  const cooling = (): boolean => Date.now() < lastSentAt + COOLDOWN_MS;
  const lockedNow = (): boolean => locked || !open || !view;

  /** The pressed face springs once; the message itself lands on the sender's row. */
  function pop(key: HTMLButtonElement): void {
    window.clearTimeout(popTimers.get(key));
    key.classList.remove('is-pop');
    void key.offsetWidth;
    key.classList.add('is-pop');
    popTimers.set(key, window.setTimeout(() => key.classList.remove('is-pop'), 360));
  }

  /** A refused tap: one gold pulse across the stash key, so the eye lands on the door. */
  function denied(): void {
    window.clearTimeout(deniedTimer);
    dock.classList.remove('is-denied');
    void dock.offsetWidth;
    dock.classList.add('is-denied');
    deniedTimer = window.setTimeout(() => dock.classList.remove('is-denied'), 520);
  }

  /**
   * The row under the faces is one slot: the composer and its quick-chat vocabulary grow the tray
   * in place rather than replacing the reactions, so the faces stay one tap away.
   */
  function setDrawer(next: Drawer, focus = false): void {
    drawer = next;
    const composing = next === 'compose';
    form.hidden = !composing;
    /* the quick-chat vocabulary sits under the composer, never in place of it */
    canned.hidden = !composing;
    toggle.setAttribute('aria-expanded', composing ? 'true' : 'false');
    toggleIco.setAttribute('href', composing ? '#i-close' : '#i-chat');
    toggle.setAttribute('aria-label', toggleLabel());
    if (composing && focus && !locked) input.focus();
    if (!composing) input.blur();
  }

  function toggleLabel(): string {
    if (locked) return t('banterComposeOpen');
    return drawer === 'compose' ? t('banterComposeClose') : t('banterComposeOpen');
  }

  /** Which page the rail is on, and the gold that says so. */
  function setVipPage(next: boolean): void {
    vipPage = next;
    for (const key of freeKeys) key.hidden = next;
    for (const key of vipKeys) key.hidden = !next;
    stashKey.setAttribute('aria-pressed', next ? 'true' : 'false');
    stashKey.classList.toggle('is-on', next);
    paintCopy();
    paintCool();
  }

  function paintVipKeys(): void {
    const vip = isPremiumUser();
    for (const key of vipKeys) {
      key.classList.toggle('is-locked', !vip);
      key.setAttribute('aria-disabled', vip ? 'false' : 'true');
      key.querySelector('.banter-sticker-lock')?.toggleAttribute('hidden', vip);
    }
    /* typing is free, so the chat key never wears the lock; the gate moved to send */
    send.classList.toggle('is-gated', !vip);
    sendLock.hidden = vip;
    stashKey.classList.toggle('is-gated', !vip);
    stashLock.hidden = vip;
    /* the pill is the seller; a VIP reading the quick-chat row has nothing to buy */
    vipPill.hidden = vip;
    dock.classList.toggle('is-vip', vip);
  }

  function paintCopy(): void {
    if (!view) return;
    dock.setAttribute('aria-label', t('banterLabel'));
    label.textContent = t(vipPage ? 'banterVipTray' : 'banterTray');
    reacts.setAttribute('aria-label', t(vipPage ? 'banterVipStash' : 'banterReact'));
    input.setAttribute('aria-label', t('banterInputLabel'));
    send.setAttribute('aria-label', t(isPremiumUser() ? 'banterSendLabel' : 'banterSendLocked'));
    closeKey.setAttribute('aria-label', t('banterComposeClose'));
    toggle.setAttribute('aria-label', toggleLabel());
    stashKey.setAttribute(
      'aria-label',
      t(!isPremiumUser() ? 'banterVipLocked' : vipPage ? 'banterVipBack' : 'banterVipStash'),
    );
    input.placeholder = locked ? t('banterLockedPlaceholder') : t('banterPlaceholder');
    alertText.textContent = t('banterOpponentLeft');
    cannedK.textContent = t('banterCannedK');
    vipPillT.textContent = t('banterVipPill');
    cannedGrid.setAttribute('aria-label', t('banterCannedK'));
    for (const key of freeKeys) {
      key.setAttribute('aria-label', t('banterReactSend').replace('{emoji}', key.dataset.emoji ?? ''));
    }
    for (const [index, key] of vipKeys.entries()) {
      const sticker = VIP_STICKERS[index];
      key.setAttribute('aria-label', isPremiumUser() ? t(sticker.key) : t('banterVipLocked'));
    }
    for (const chip of cannedKeys) {
      const id = chip.dataset.preset as PostChatPresetId | undefined;
      if (id) chip.textContent = presetLabel(id);
    }
  }

  function paintCool(): void {
    const cool = cooling() && !locked;
    const off = cool || locked;
    const vip = isPremiumUser();
    for (const key of freeKeys) key.disabled = off;
    /* a locked sticker must stay tappable (it is the upsell); a VIP one dims like a face */
    for (const key of vipKeys) key.disabled = locked || (vip && cool);
    for (const chip of cannedKeys) chip.disabled = off;
    send.disabled = off;
    toggle.disabled = locked;
    input.disabled = locked;
    vipPill.disabled = locked;
    stashKey.disabled = locked;
    dock.classList.toggle('is-cooling', cool);
    dock.classList.toggle('is-locked', locked);
    dock.classList.toggle('is-vip-page', vipPage);
  }

  function armCool(): void {
    window.clearTimeout(coolTimer);
    const left = Math.max(0, lastSentAt + COOLDOWN_MS - Date.now());
    coolTimer = window.setTimeout(paintCool, left + 20);
  }

  function showBubble(side: number, raw: string, vip = false): void {
    const anchor = wiring.anchor(side);
    if (!anchor) return;
    window.clearTimeout(bubbleTimers.get(side));
    const emote = isEmote(raw);
    const art = emote ? REACTION_ART[raw] : undefined;
    if (art) {
      /* the face travels as a pictograph, but neither tray nor bubble ever hands it to the OS */
      anchor.text.replaceChildren(ico(art.icon, 'banter-glyph'), el('span', 'sr-only', raw));
      anchor.node.dataset.tone = art.tone;
    } else {
      anchor.text.textContent = raw;
      delete anchor.node.dataset.tone;
    }
    anchor.node.classList.toggle('is-emote', emote);
    /* the crown is the room's word on the author, so it rides the bubble rather than the row —
       and a medal carries it as a gold ring instead, because a 12px badge has no room in a 30px
       circle */
    anchor.node.classList.toggle('is-vip', vip && !emote);
    anchor.node.classList.toggle('is-vip-emote', vip && emote);
    if (anchor.badge) anchor.badge.hidden = !vip || emote;
    anchor.node.hidden = false;
    anchor.node.classList.remove('is-out');
    /* re-arm the spring: dropping the live class and forcing a reflow makes a replacement pop */
    anchor.node.classList.remove('is-live');
    void anchor.node.offsetWidth;
    anchor.node.classList.add('is-live');
    bubbleTimers.set(side, window.setTimeout(() => hideBubble(side), BUBBLE_MS));
  }

  function hideBubble(side: number, immediate = false): void {
    window.clearTimeout(bubbleTimers.get(side));
    bubbleTimers.delete(side);
    const anchor = wiring.anchor(side);
    if (!anchor || anchor.node.hidden) return;
    const clear = (node: HTMLElement, badge: HTMLElement | null, text: HTMLElement) => {
      node.classList.remove('is-live', 'is-out', 'is-emote', 'is-vip', 'is-vip-emote');
      delete node.dataset.tone;
      if (badge) badge.hidden = true;
      text.replaceChildren();
      node.hidden = true;
    };
    if (immediate) {
      clear(anchor.node, anchor.badge, anchor.text);
      return;
    }
    anchor.node.classList.add('is-out');
    window.setTimeout(() => {
      const live = wiring.anchor(side);
      if (!live || !live.node.classList.contains('is-out')) return;   // a new line took the row back
      clear(live.node, live.badge, live.text);
    }, LEAVE_MS);
  }

  function clearTimers(): void {
    window.clearTimeout(coolTimer);
    window.clearTimeout(botTimer);
    coolTimer = 0;
    botTimer = 0;
    for (const side of [...bubbleTimers.keys()]) hideBubble(side, true);
  }

  function scheduleBotReply(): void {
    window.clearTimeout(botTimer);
    const pick = (botTurn++ % BOT_LINES) + 1;
    botTimer = window.setTimeout(() => {
      botTimer = 0;
      if (!open || locked || !view) return;
      showBubble(view.rivalSide, t(`banterBot${pick}`));
    }, BOT_MS);
  }

  /** The one sender. A preset travels as its id; a custom line travels as text and wears gold. */
  function say(line: PostChatLine): void {
    if (lockedNow() || cooling() || !view) return;
    const text = line.preset ? presetLabel(line.preset) : clip(line.text ?? '');
    if (!text) return;
    lastSentAt = Date.now();
    paintCool();
    armCool();
    impact('light');
    showBubble(view.localSide, text, !line.preset && isPremiumUser());
    const wire = wiring.wire();
    if (wire) {
      if (!wire(line)) opponentLeft();
    } else {
      scheduleBotReply();
    }
    if (input.value) input.value = '';
  }

  function opponentLeft(): void {
    if (locked) return;
    locked = true;
    window.clearTimeout(botTimer);
    botTimer = 0;
    closeSheet();
    setDrawer('none');
    dock.classList.add('is-locked');
    alert.hidden = false;
    if (!alertText.textContent) alertText.textContent = t('banterOpponentLeft');
    if (open) {
      input.value = '';
      paintCopy();
      paintCool();
    }
  }

  /* ---------- the store sheet ---------- */

  function paintSheet(): void {
    const source = vipSource();
    const gated = sheetReason === 'gate' && source === 'none';
    sheet.classList.toggle('is-gate', gated);
    sheetKicker.textContent = t('vipKicker');
    sheetTitle.textContent = t(
      gated ? 'vipGateTitle' : source === 'none' ? 'vipTitle' : 'vipActiveTitle',
    );
    sheetSub.textContent = t(
      gated ? 'vipGateSub'
        : source === 'telegram' ? 'vipActiveSub'
          : source === 'preview' ? 'vipPreviewSub' : 'vipSub',
    );
    sheetFeats.replaceChildren(...VIP_FEATURES.map((feat) => {
      const row = el('li', 'vip-feat');
      const mark = el('span', 'vip-feat-ico');
      mark.append(ico(feat.ico));
      const body = el('span', 'vip-feat-body');
      body.append(el('b', 'vip-feat-t', t(feat.key)), el('small', 'vip-feat-s', t(feat.sub)));
      row.append(mark, body);
      return row;
    }));
    const sell = source === 'none';
    sheetCta.hidden = !sell;
    if (sell) {
      const inTg = insideTelegram();
      sheetCtaT.textContent = t(inTg ? 'vipCtaTelegram' : 'vipCtaPreview');
      sheetCtaIco.setAttribute('href', inTg ? '#i-ext' : '#i-star');
      sheetFine.textContent = t(inTg ? 'vipFineTelegram' : 'vipFinePreview');
    } else {
      sheetFine.textContent = t('vipFineActive');
    }
    sheetClose.setAttribute('aria-label', t('vipClose'));
  }

  function openSheet(from: HTMLElement | null, reason: SheetReason = 'sell'): void {
    if (sheetOpen || !open) return;
    sheetOpen = true;
    sheetReason = reason;
    sheetReturn = from;
    paintSheet();
    sheet.hidden = false;
    resultCard?.setAttribute('inert', '');
    /* the sell key is the reason the sheet opened; a VIP reading it has only the close */
    if (sheetCta.hidden) sheetClose.focus({ preventScroll: true });
    else sheetCta.focus({ preventScroll: true });
  }

  function closeSheet(): void {
    if (!sheetOpen) return;
    sheetOpen = false;
    sheet.hidden = true;
    resultCard?.removeAttribute('inert');
    const back = sheetReturn;
    sheetReturn = null;
    back?.focus({ preventScroll: true });
  }

  sheetCta.addEventListener('click', () => {
    impact('light');
    if (insideTelegram()) {
      openLink(TELEGRAM_PREMIUM_URL);
      return;
    }
    /* the browser's door: a local preview pass, never a purchase and never stored */
    grantVipPreview();
    closeSheet();
    paintVipKeys();
    paintCopy();
    paintCool();
    /* the draft survived the gate; put the unlocked send key under the thumb */
    if (drawer === 'compose') send.focus({ preventScroll: true });
  });

  sheetClose.addEventListener('click', () => closeSheet());
  sheetScrim.addEventListener('click', () => closeSheet());
  document.addEventListener('keydown', (e) => {
    if (!sheetOpen || e.key !== 'Escape') return;
    e.preventDefault();
    closeSheet();
  });

  /* ---------- wiring ---------- */

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (lockedNow() || cooling()) return;
    if (!isPremiumUser()) {
      /* the typing trap: keep every keystroke, explain the gate, sell the transmitter */
      notify('warning');
      openSheet(send, 'gate');
      return;
    }
    say({ text: input.value });
  });

  toggle.addEventListener('click', () => {
    if (locked) return;
    impact('light');
    /* the keyboard is never behind a paywall: every seat gets the field */
    if (drawer === 'none') setDrawer('compose', true);
    else setDrawer('none');
  });

  closeKey.addEventListener('click', () => {
    setDrawer('none');
    toggle.focus();
  });

  stashKey.addEventListener('click', () => {
    if (locked) return;
    impact('light');
    setVipPage(!vipPage);
  });

  vipPill.addEventListener('click', () => {
    if (locked) return;
    impact('light');
    openSheet(vipPill);
  });

  onLang(() => {
    if (!open) return;
    paintCopy();
    paintCool();
    if (sheetOpen) paintSheet();
  });

  /** A line that beat the capsule: it waits with its author's verdict instead of vanishing. */
  function returnPending(): void {
    if (!pending.length || !open) return;
    const queued = pending;
    pending = [];
    for (const item of queued) inbound(item.line, item.side, item.vip);
  }

  function inbound(line: PostChatLine, side: number, vip = false): void {
    const text = line.preset ? presetLabel(line.preset) : clip(line.text ?? '');
    if (!text) return;
    if (!open || !view) {
      pending = [...pending.slice(-3), { line, side, vip }];
      return;
    }
    if (locked) return;
    showBubble(side, text, vip);
  }

  return {
    open(next) {
      view = next;
      open = true;
      locked = next.locked;
      lastSentAt = 0;
      clearTimers();
      closeSheet();
      dock.hidden = false;
      alert.hidden = !locked;
      input.value = '';
      setDrawer('none');
      setVipPage(false);
      alertText.textContent = locked ? t('banterOpponentLeft') : '';
      paintVipKeys();
      paintCopy();
      paintCool();
      /* a rival can react during the goal beat, before this capsule is on screen */
      returnPending();
    },
    close() {
      open = false;
      view = null;
      locked = false;
      pending = [];
      closeSheet();
      clearTimers();
      setDrawer('none');
      setVipPage(false);
      dock.hidden = true;
      dock.classList.remove('is-locked', 'is-cooling', 'is-denied', 'is-vip');
      alert.hidden = true;
      input.value = '';
    },
    inbound,
    opponentLeft,
  };
}
