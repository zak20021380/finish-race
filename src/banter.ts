/**
 * banter.ts — the post-match banter dock and its two speech bubbles.
 *
 * The dock sits above the rematch key in the Match Complete capsule: a carousel of taunts that
 * change with the outcome, six emoji beats, and a 40-character line. Every message lands on its
 * sender's own podium card: the champion's bubble is emerald/cyan, the fallen seat's is
 * crimson/violet, and each one springs in, replaces itself gracefully and leaves after 4.5s.
 *
 * The wire is the only difference between opponents. Online, a line rides the same socket as the
 * race, as `POST_MATCH_CHAT`, and the rival's line comes back through `onPostChat`. Against the
 * machine, the same line wakes a canned reply after 1.2s. When the rival walks out — a frame, a
 * closed socket — `opponentLeft()` locks the whole surface so a taunt never flies into an empty
 * room: the alert is raised, the pills and input go quiet, and the caller locks the rematch key.
 */
import './banter.css';
import { onLang, t } from './settings';
import { impact } from './telegram';

/** The outcome the dock is speaking to. */
export interface BanterView {
  /** True when this screen won: the winner's taunt set is offered. */
  won: boolean;
  localSide: number;
  /** The seat that took the crown — bubbles are placed by card, not by sender. */
  winnerSide: number;
  /** False for a 3- or 4-seat party, where there is no single rival to talk to. */
  enabled: boolean;
  /** The rival already left: open the dock in its locked state. */
  locked: boolean;
}

export interface BanterWiring {
  /** The live socket's post-match sender, or null for a race against the machine. */
  wire: () => ((text: string) => boolean) | null;
}

export interface Banter {
  open(view: BanterView): void;
  close(): void;
  /** A line the rival sent, placed on the card for `side`. */
  inbound(text: string, side: number): void;
  /** The rival left the result: raise the alert and lock every control. */
  opponentLeft(): void;
}

/** One message lives this long before its graceful exit. */
const BUBBLE_MS = 4500;
/** The fade matches `banter-say-out` in banter.css. */
const LEAVE_MS = 300;
/** One message per player per two seconds — the anti-spam gate the brief asks for. */
const COOLDOWN_MS = 2000;
/** The machine thinks for a beat before answering. */
const BOT_MS = 1200;
const MAX_CHARS = 40;
/** The six faces the tray offers, in a fixed order that never moves under a language flip. */
const REACTIONS = ['🧠', '🔥', '👑', '🎲', '😤', '🤝'] as const;
const TAUNTS = 5;
const BOT_LINES = 4;

type Card = 'win' | 'lose';

const clip = (raw: string): string => {
  const clean = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return Array.from(clean).slice(0, MAX_CHARS).join('');
};

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
  const alert = byId<HTMLParagraphElement>('banter-alert');
  const alertText = byId<HTMLElement>('banter-alert-t');
  const rail = byId<HTMLDivElement>('banter-rail');
  const reacts = byId<HTMLDivElement>('banter-reacts');
  const form = byId<HTMLFormElement>('banter-form');
  const input = byId<HTMLInputElement>('banter-input');
  const send = byId<HTMLButtonElement>('banter-send');

  interface Bubble { node: HTMLElement; text: HTMLElement; timer: number }
  const bubbles: Record<Card, Bubble> = {
    win: { node: byId('result-top-say'), text: byId('result-top-say-t'), timer: 0 },
    lose: { node: byId('result-bottom-say'), text: byId('result-bottom-say-t'), timer: 0 },
  };

  const pills: HTMLButtonElement[] = [];
  for (let i = 0; i < TAUNTS; i++) {
    const pill = el('button', 'banter-pill');
    pill.type = 'button';
    pill.dir = 'auto';
    pill.dataset.pill = String(i);
    pill.addEventListener('click', () => say(t(pillKey(i))));
    rail.appendChild(pill);
    pills.push(pill);
  }

  const reacts_: HTMLButtonElement[] = [];
  for (const face of REACTIONS) {
    const key = el('button', 'banter-react', face);
    key.type = 'button';
    key.dataset.emoji = face;
    key.addEventListener('click', () => say(face));
    reacts.appendChild(key);
    reacts_.push(key);
  }

  let view: BanterView | null = null;
  let open = false;
  let locked = false;
  let lastSentAt = 0;
  let coolTimer = 0;
  let botTimer = 0;
  let botTurn = 0;
  /** Lines that landed between the winning move and the card: replayed when the dock opens. */
  let pending: Array<{ text: string; side: number }> = [];

  const pillKey = (i: number): string => `${view?.won ? 'banterWin' : 'banterLose'}${i + 1}`;
  const cooling = (): boolean => Date.now() < lastSentAt + COOLDOWN_MS;
  const lockedNow = (): boolean => locked || !open || !view?.enabled;

  function paintCopy(): void {
    if (!view) return;
    dock.setAttribute('aria-label', t('banterLabel'));
    rail.setAttribute('aria-label', t('banterQuick'));
    reacts.setAttribute('aria-label', t('banterReact'));
    input.setAttribute('aria-label', t('banterInputLabel'));
    send.setAttribute('aria-label', t('banterSendLabel'));
    input.placeholder = locked ? t('banterLockedPlaceholder') : t('banterPlaceholder');
    alertText.textContent = t('banterOpponentLeft');
    for (let i = 0; i < pills.length; i++) {
      const line = t(pillKey(i));
      if (pills[i].textContent !== line) pills[i].textContent = line;
    }
    for (const key of reacts_) {
      key.setAttribute('aria-label', t('banterReactSend').replace('{emoji}', key.dataset.emoji ?? ''));
    }
  }

  function paintCool(): void {
    const cool = cooling() && !locked;
    const off = cool || locked;
    for (const pill of pills) pill.disabled = off;
    for (const key of reacts_) key.disabled = off;
    send.disabled = off;
    input.disabled = locked;
    dock.classList.toggle('is-cooling', cool);
    dock.classList.toggle('is-locked', locked);
  }

  function armCool(): void {
    window.clearTimeout(coolTimer);
    const left = Math.max(0, lastSentAt + COOLDOWN_MS - Date.now());
    coolTimer = window.setTimeout(paintCool, left + 20);
  }

  function showBubble(card: Card, text: string): void {
    const bubble = bubbles[card];
    window.clearTimeout(bubble.timer);
    bubble.text.textContent = text;
    bubble.node.hidden = false;
    bubble.node.parentElement?.classList.add('is-speaking');
    bubble.node.classList.remove('is-out');
    /* re-arm the spring: dropping the live class and forcing a reflow makes a replacement pop */
    bubble.node.classList.remove('is-live');
    void bubble.node.offsetWidth;
    bubble.node.classList.add('is-live');
    bubble.timer = window.setTimeout(() => hideBubble(card), BUBBLE_MS);
  }

  function hideBubble(card: Card, immediate = false): void {
    const bubble = bubbles[card];
    window.clearTimeout(bubble.timer);
    bubble.timer = 0;
    if (bubble.node.hidden) return;
    if (immediate) {
      bubble.node.classList.remove('is-live', 'is-out');
      bubble.node.hidden = true;
      bubble.text.textContent = '';
      bubble.node.parentElement?.classList.remove('is-speaking');
      return;
    }
    bubble.node.classList.add('is-out');
    window.setTimeout(() => {
      if (!bubble.node.classList.contains('is-out')) return;   // a new line took the card back
      bubble.node.classList.remove('is-live', 'is-out');
      bubble.node.hidden = true;
      bubble.text.textContent = '';
      bubble.node.parentElement?.classList.remove('is-speaking');
    }, LEAVE_MS);
  }

  function clearTimers(): void {
    window.clearTimeout(coolTimer);
    window.clearTimeout(botTimer);
    coolTimer = 0;
    botTimer = 0;
    hideBubble('win', true);
    hideBubble('lose', true);
  }

  function scheduleBotReply(): void {
    window.clearTimeout(botTimer);
    const pick = (botTurn++ % BOT_LINES) + 1;
    botTimer = window.setTimeout(() => {
      botTimer = 0;
      if (!open || locked || !view) return;
      showBubble(rivalCard(), t(`banterBot${pick}`));
    }, BOT_MS);
  }

  const localCard = (): Card => (view && view.localSide === view.winnerSide ? 'win' : 'lose');
  const rivalCard = (): Card => (localCard() === 'win' ? 'lose' : 'win');

  function say(raw: string): void {
    if (lockedNow() || cooling()) return;
    const text = clip(raw);
    if (!text || !view) return;
    lastSentAt = Date.now();
    paintCool();
    armCool();
    impact('light');
    showBubble(localCard(), text);
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
    if (!pending.length || !view || !open) return;
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
    showBubble(side === view.winnerSide ? 'win' : 'lose', line);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    say(input.value);
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
      dock.hidden = !next.enabled;
      alert.hidden = !locked;
      input.value = '';
      if (locked) alertText.textContent = t('banterOpponentLeft');
      else alertText.textContent = '';
      paintCopy();
      paintCool();
      /* a rival can taunt during the goal beat, before this capsule is on screen */
      returnPending();
    },
    close() {
      open = false;
      view = null;
      locked = false;
      pending = [];
      clearTimers();
      dock.hidden = true;
      dock.classList.remove('is-locked', 'is-cooling');
      alert.hidden = true;
      input.value = '';
    },
    inbound,
    opponentLeft,
  };
}
