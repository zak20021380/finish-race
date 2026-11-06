/**
 * banter.ts — the post-match reaction tray: five calibrated quick-chat pills and the VIP line.
 *
 * Every seat can broadcast the five pills. They travel as preset IDs, so the receiver paints its
 * own language from the closed table and no free-form text crosses the wire. The custom capsule is
 * the VIP door: a free seat sees a frosted lock that opens #vip-sheet instead of a keyboard, while
 * an entitled seat gets a 40-character field whose sanitized line lands as a gold bubble.
 *
 * A tapped pill or a sent line lands on the speaker's standings row as an absolutely positioned
 * bubble, so the ladder never reflows. The bubble expires after 4.5s and the next one restarts the
 * spring. When the rival walks out — a frame, a closed socket — `opponentLeft()` locks the whole
 * surface so a quick chat never flies into an empty room.
 */
import './banter.css';
import { lang, langDef, onLang, t } from './settings';
import { impact, notify } from './telegram';
import { isPremiumUser, onVipChange, openVipSheet } from './premium';
import {
  POST_CHAT_QUICK_CHATS, postChatPresetText,
  type PostChatLine, type PostChatPresetId, type PostChatQuickId,
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
const BOT_LINES = 4;

/** The i18n key each active pill paints from, in carousel order. */
const QUICK_KEYS: Record<PostChatQuickId, string> = {
  rematch: 'banterQuickRematch',
  respect: 'banterQuickRespect',
  banter: 'banterQuickBanter',
  vengeance: 'banterQuickVengeance',
  admire: 'banterQuickAdmire',
};

const clip = (raw: string): string => {
  const clean = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return Array.from(clean).slice(0, MAX_CHARS).join('');
};

/** A preset's copy, with the canonical line as the fallback. */
function presetLabel(id: PostChatPresetId): string {
  const key = QUICK_KEYS[id as PostChatQuickId];
  if (key) {
    const painted = t(key);
    if (painted !== key) return painted;
  }
  /* the dictionary is the paint; the table is the floor a lagging locale lands on, so a key the
     Persian table has not caught up on costs a translation and never the player's voice */
  return postChatPresetText(id, lang);
}

/**
 * A line's closing token — the one or two pictographs that end it.
 *
 * Splitting it off is what makes a pill survive a narrow screen: the words are the only thing
 * allowed to give way, so a Persian sentence that outgrows the capsule loses its tail to an
 * ellipsis while the emoji stays whole at the terminal edge. Isolating the token also stops a
 * bidi-neutral emoji from dragging the line's final punctuation to the wrong end.
 */
const TRAILING_TOKEN = /^([\s\S]*?)\s*((?:\p{Extended_Pictographic}|\uFE0F|\u200D|\u20E3)+)\s*$/u;

/**
 * Paints a closed line into its pill: words in one box, token in another.
 *
 * The accessible name is set from the whole label rather than left to the two boxes, so a
 * screen reader still hears one sentence and the split stays a purely visual affair.
 */
function paintChip(chip: HTMLButtonElement, label: string): void {
  const words = el('span', 'banter-chip-t');
  const match = TRAILING_TOKEN.exec(label);
  /* a line that is nothing but a token has no words to protect: leave it in one box */
  if (match && match[1].trim()) {
    words.textContent = match[1];
    const token = el('span', 'banter-chip-e', match[2]);
    token.setAttribute('aria-hidden', 'true');
    chip.replaceChildren(words, token);
  } else {
    words.textContent = label;
    chip.replaceChildren(words);
  }
  chip.setAttribute('aria-label', label);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const byId = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`banter: #${id} is missing`);
  return node as T;
};

export function createBanter(wiring: BanterWiring): Banter {
  const dock = byId<HTMLDivElement>('result-banter');
  const label = byId<HTMLElement>('banter-label');
  const alert = byId<HTMLParagraphElement>('banter-alert');
  const alertText = byId<HTMLElement>('banter-alert-t');
  const quick = byId<HTMLDivElement>('banter-quick');
  const form = byId<HTMLFormElement>('banter-form');
  const input = byId<HTMLInputElement>('banter-input');
  const send = byId<HTMLButtonElement>('banter-send');
  const gate = byId<HTMLButtonElement>('banter-gate');
  const gateText = byId<HTMLElement>('banter-gate-t');

  /* ---------- the pills: five closed lines, one tap each ---------- */

  const chips: HTMLButtonElement[] = [];
  for (const preset of POST_CHAT_QUICK_CHATS) {
    const chip = el('button', 'banter-chip');
    chip.type = 'button';
    chip.dataset.preset = preset.id;
    chip.addEventListener('click', () => {
      if (lockedNow() || cooling()) return;
      pop(chip);
      impact('light');
      say({ preset: preset.id });
    });
    quick.appendChild(chip);
    chips.push(chip);
  }

  let view: BanterView | null = null;
  let open = false;
  let locked = false;
  let lastSentAt = 0;
  let coolTimer = 0;
  let botTimer = 0;
  let botTurn = 0;
  let deniedTimer = 0;
  /** Lines that landed between the winning move and the card: replayed when the tray opens. */
  let pending: Array<{ line: PostChatLine; side: number; vip: boolean }> = [];
  const bubbleTimers = new Map<number, number>();
  const popTimers = new WeakMap<HTMLButtonElement, number>();

  const cooling = (): boolean => Date.now() < lastSentAt + COOLDOWN_MS;
  const lockedNow = (): boolean => locked || !open || !view;

  /** The pressed pill springs once; the message itself lands on the sender's row. */
  function pop(key: HTMLButtonElement): void {
    window.clearTimeout(popTimers.get(key));
    key.classList.remove('is-pop');
    void key.offsetWidth;
    key.classList.add('is-pop');
    popTimers.set(key, window.setTimeout(() => key.classList.remove('is-pop'), 360));
  }

  /** A refused tap: one gold pulse across the locked capsule, so the eye lands on the door. */
  function denied(): void {
    window.clearTimeout(deniedTimer);
    dock.classList.remove('is-denied');
    void dock.offsetWidth;
    dock.classList.add('is-denied');
    deniedTimer = window.setTimeout(() => dock.classList.remove('is-denied'), 520);
  }

  /** The transmitter is the entitlement: a free seat gets a locked preview, a VIP gets the field. */
  function paintVipState(): void {
    const vip = isPremiumUser();
    form.hidden = !vip;
    gate.hidden = vip;
    dock.classList.toggle('is-vip', vip);
  }

  function paintCopy(): void {
    if (!view) return;
    const dir = langDef(lang).dir;
    dock.dir = dir;
    dock.setAttribute('aria-label', t('banterLabel'));
    label.textContent = t('banterTray');
    quick.setAttribute('aria-label', t('banterQuickChat'));
    quick.dir = dir;
    form.dir = dir;
    gate.dir = dir;
    input.setAttribute('aria-label', t('banterInputLabel'));
    input.placeholder = locked ? t('banterLockedPlaceholder') : t('banterPlaceholder');
    send.setAttribute('aria-label', t('banterSendLabel'));
    gateText.textContent = t('banterCustomLocked');
    gate.setAttribute('aria-label', t('banterCustomLockedAria'));
    alertText.textContent = t('banterOpponentLeft');
    for (const chip of chips) {
      const id = chip.dataset.preset as PostChatQuickId | undefined;
      if (!id) continue;
      const text = presetLabel(id);
      paintChip(chip, text);
      chip.setAttribute('aria-label', t('banterQuickSend').replace('{text}', text));
    }
  }

  function paintCool(): void {
    const cool = cooling() && !locked;
    const off = cool || locked;
    for (const chip of chips) chip.disabled = off;
    send.disabled = off;
    input.disabled = locked;
    /* the locked capsule stays tappable while the tray is live: it is the storefront */
    gate.disabled = locked;
    dock.classList.toggle('is-cooling', cool);
    dock.classList.toggle('is-locked', locked);
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
    anchor.text.textContent = raw;
    anchor.text.setAttribute('dir', 'auto');
    /* the bubble's own direction drives the logical tail, not the document's */
    anchor.node.setAttribute('dir', langDef(lang).dir);
    anchor.node.classList.toggle('is-vip', vip);
    if (anchor.badge) anchor.badge.hidden = !vip;
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
      node.classList.remove('is-live', 'is-out', 'is-vip');
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
    input.value = '';
  }

  function opponentLeft(): void {
    if (locked) return;
    locked = true;
    window.clearTimeout(botTimer);
    botTimer = 0;
    dock.classList.add('is-locked');
    alert.hidden = false;
    if (open) {
      input.value = '';
      input.blur();
      paintCopy();
      paintCool();
    }
  }

  /* ---------- the storefront gate ---------- */

  /**
   * The composer's gold door. The locked preview never focuses a field, so no keyboard can open
   * behind the store; after a successful unlock the same seat lands in the live field, one tap
   * from the wire.
   */
  function unlockAndFocus(): void {
    paintVipState();
    paintCopy();
    paintCool();
    if (!locked) input.focus({ preventScroll: true });
  }

  /* ---------- wiring ---------- */

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (lockedNow() || cooling()) return;
    if (!isPremiumUser()) {
      notify('warning');
      denied();
      openVipSheet({ reason: 'gate', onUnlocked: unlockAndFocus });
      return;
    }
    say({ text: input.value });
  });

  gate.addEventListener('click', () => {
    if (lockedNow()) return;
    notify('warning');
    denied();
    openVipSheet({ reason: 'gate', onUnlocked: unlockAndFocus });
  });

  onLang(() => {
    if (!open) return;
    paintCopy();
    paintCool();
  });
  onVipChange(() => {
    if (!open) return;
    paintVipState();
    paintCopy();
    paintCool();
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
      dock.hidden = false;
      alert.hidden = !locked;
      input.value = '';
      alertText.textContent = locked ? t('banterOpponentLeft') : '';
      paintVipState();
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
      clearTimers();
      input.value = '';
      input.blur();
      dock.hidden = true;
      dock.classList.remove('is-locked', 'is-cooling', 'is-denied', 'is-vip');
      alert.hidden = true;
    },
    inbound,
    opponentLeft,
  };
}
