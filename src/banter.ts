/**
 * banter.ts — the post-match Quick Reaction tray and its floating bubbles.
 *
 * The tray sits directly above the rematch key in the Match Complete capsule: five one-tap
 * reactions on a single glass lane, with the custom-taunt composer parked behind the chat key so
 * the idle tray never costs a second storey. A tap broadcasts the emoji through the settled match
 * (or wakes a canned answer when the far seats are machines), pops the pressed face, and lands the
 * message on the row of the player who sent it.
 *
 * The wire is the only difference between opponents. Online, the reaction rides the same socket as
 * the race as `POST_MATCH_CHAT`; the rival's answer comes back through `onPostChat`. Against the
 * machine, the same emoji wakes a reply after 1.2s. When the rival walks out — a frame, a closed
 * socket — `opponentLeft()` locks the whole surface so a taunt never flies into an empty room.
 */
import './banter.css';
import { onLang, t } from './settings';
import { impact } from './telegram';

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
}

export interface BanterWiring {
  /** The live socket's post-match sender, or null for a race against the machine. */
  wire: () => ((text: string) => boolean) | null;
  /** The row bubble owned by a seat, or null when that seat is not on the ladder. */
  anchor: (side: number) => BanterAnchor | null;
}

export interface Banter {
  open(view: BanterView): void;
  close(): void;
  /** A line the rival sent, placed on the row of `side`. */
  inbound(text: string, side: number): void;
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
/** The five faces the tray offers, in a fixed order that never moves under a language flip. */
const REACTIONS = ['🤝', '🔥', '😭', '😂', '🤯'] as const;
const BOT_LINES = 4;

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
  const reacts = byId<HTMLDivElement>('banter-reacts');
  const form = byId<HTMLFormElement>('banter-form');
  const input = byId<HTMLInputElement>('banter-input');
  const send = byId<HTMLButtonElement>('banter-send');
  const toggle = byId<HTMLButtonElement>('banter-toggle');
  /* the <use> swaps between the chat bubble and the close glyph as the composer flips */
  const toggleIco = byId<HTMLElement>('banter-toggle-ico');
  const closeKey = byId<HTMLButtonElement>('banter-close');

  const reacts_: HTMLButtonElement[] = [];
  for (const face of REACTIONS) {
    const key = el('button', 'banter-react', face);
    key.type = 'button';
    key.dataset.emoji = face;
    key.addEventListener('click', () => {
      if (lockedNow() || cooling()) return;
      pop(key);
      say(face);
    });
    reacts.appendChild(key);
    reacts_.push(key);
  }

  let view: BanterView | null = null;
  let open = false;
  let locked = false;
  /** True while the composer is open under the faces. */
  let composing = false;
  let lastSentAt = 0;
  let coolTimer = 0;
  let botTimer = 0;
  let botTurn = 0;
  /** Lines that landed between the winning move and the card: replayed when the tray opens. */
  let pending: Array<{ text: string; side: number }> = [];
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

  /**
   * The composer is one slot under the faces: opening it grows the tray by one row in place rather
   * than replacing the reactions, so the faces stay one tap away while typing.
   */
  function setComposing(next: boolean, focus = false): void {
    composing = next;
    form.hidden = !next;
    toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    toggleIco.setAttribute('href', next ? '#i-close' : '#i-chat');
    toggle.setAttribute('aria-label', t(next ? 'banterComposeClose' : 'banterComposeOpen'));
    if (next) {
      if (focus && !locked) input.focus();
    } else {
      input.blur();
    }
  }

  function paintCopy(): void {
    if (!view) return;
    dock.setAttribute('aria-label', t('banterLabel'));
    label.textContent = t('banterTray');
    reacts.setAttribute('aria-label', t('banterReact'));
    input.setAttribute('aria-label', t('banterInputLabel'));
    send.setAttribute('aria-label', t('banterSendLabel'));
    closeKey.setAttribute('aria-label', t('banterComposeClose'));
    toggle.setAttribute('aria-label', t(composing ? 'banterComposeClose' : 'banterComposeOpen'));
    input.placeholder = locked ? t('banterLockedPlaceholder') : t('banterPlaceholder');
    alertText.textContent = t('banterOpponentLeft');
    for (const key of reacts_) {
      key.setAttribute('aria-label', t('banterReactSend').replace('{emoji}', key.dataset.emoji ?? ''));
    }
  }

  function paintCool(): void {
    const cool = cooling() && !locked;
    const off = cool || locked;
    for (const key of reacts_) key.disabled = off;
    send.disabled = off;
    toggle.disabled = locked;
    input.disabled = locked;
    dock.classList.toggle('is-cooling', cool);
    dock.classList.toggle('is-locked', locked);
  }

  function armCool(): void {
    window.clearTimeout(coolTimer);
    const left = Math.max(0, lastSentAt + COOLDOWN_MS - Date.now());
    coolTimer = window.setTimeout(paintCool, left + 20);
  }

  function showBubble(side: number, raw: string): void {
    const anchor = wiring.anchor(side);
    if (!anchor) return;
    window.clearTimeout(bubbleTimers.get(side));
    const emote = isEmote(raw);
    anchor.text.textContent = raw;
    anchor.node.classList.toggle('is-emote', emote);
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
    if (immediate) {
      anchor.node.classList.remove('is-live', 'is-out', 'is-emote');
      anchor.node.hidden = true;
      anchor.text.textContent = '';
      return;
    }
    anchor.node.classList.add('is-out');
    window.setTimeout(() => {
      const live = wiring.anchor(side);
      if (!live || !live.node.classList.contains('is-out')) return;   // a new line took the row back
      live.node.classList.remove('is-live', 'is-out', 'is-emote');
      live.node.hidden = true;
      live.text.textContent = '';
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

  function say(raw: string): void {
    if (lockedNow() || cooling() || !view) return;
    const text = clip(raw);
    if (!text) return;
    lastSentAt = Date.now();
    paintCool();
    armCool();
    impact('light');
    showBubble(view.localSide, text);
    const wire = wiring.wire();
    if (wire) {
      if (!wire(text)) opponentLeft();
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
    dock.classList.add('is-locked');
    alert.hidden = false;
    if (!alertText.textContent) alertText.textContent = t('banterOpponentLeft');
    if (open) {
      input.value = '';
      paintCopy();
      paintCool();
    }
  }

  function returnPending(): void {
    if (!pending.length || !open) return;
    const queued = pending;
    pending = [];
    for (const line of queued) inbound(line.text, line.side);
  }

  function inbound(text: string, side: number): void {
    const line = clip(text);
    if (!line) return;
    if (!open || !view) {
      pending = [...pending.slice(-3), { text: line, side }];
      return;
    }
    if (locked) return;
    showBubble(side, line);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    say(input.value);
  });

  toggle.addEventListener('click', () => {
    if (locked) return;
    setComposing(!composing, true);
  });

  closeKey.addEventListener('click', () => {
    setComposing(false);
    toggle.focus();
  });

  onLang(() => {
    if (open) {
      paintCopy();
      paintCool();
    }
  });

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
      setComposing(false);
      alertText.textContent = locked ? t('banterOpponentLeft') : '';
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
      setComposing(false);
      dock.hidden = true;
      dock.classList.remove('is-locked', 'is-cooling');
      alert.hidden = true;
      input.value = '';
    },
    inbound,
    opponentLeft,
  };
}
