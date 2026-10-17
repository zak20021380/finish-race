/**
 * chat.ts — quick chat for a live race: the wheel, the bubbles, the mute/report hold, and the
 * machine's three reactions.
 *
 * Two rules shape the whole file. First, the vocabulary is closed: every send comes from
 * `data/phrases.ts`, so there is no input, no parser and nothing a player can type. Second, it is
 * local: a message is a bubble with a timer, a report is a toast, and mute is a boolean that dies
 * with the page. Nothing here opens a socket.
 *
 * The game itself is read, never written: `state()` is the same value `main.ts` plays on, and the
 * only events chat knows are the ones the board already publishes — a triggered mine, `lastEvent`
 * from a rolling log, and the wall list growing. Polling the state rather than hooking the turn
 * loop is what keeps `main.ts` to a single wiring call.
 */
import './chat.css';
import type { GameState, Player } from './rules';
import { EMOTES, TAUNTS, type ChatEmote } from './data/phrases';

export interface ChatOptions {
  /** The 44px key in the dock. */
  key: HTMLButtonElement;
  /** The bubble lane beside it: bubbles live here, so they can never sit on the board. */
  lane: HTMLElement;
  /** The seat chips, in player order — index === Player. */
  chips: readonly HTMLElement[];
  state: () => GameState;
  localSide: () => Player;
  /** A log is rolling, or a mine is armed: chat is shut for both. */
  busy: () => boolean;
  /** The race screen is up, unpaused, with no result card over it. */
  live: () => boolean;
}

export interface Chat {
  /** Hides anything open and stops the watcher. */
  destroy(): void;
}

/** A bubble lives this long, then leaves on its own. */
const BUBBLE_MS = 2500;
/** One message every three seconds, whatever the source. */
const SEND_GAP_MS = 3000;
/** The machine reacts at most once every eight seconds. */
const BOT_GAP_MS = 8000;
/** Long-press on the rival's chip: 400ms, and a slide of 8px cancels it. */
const HOLD_MS = 400;
const HOLD_SLOP = 8;
/** The watcher's tick: fine enough for a 400ms hold, cheap enough to run for a whole race. */
const POLL_MS = 200;
const MENU_W = 168;

type Side = 'me' | 'foe';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createChat(o: ChatOptions): Chat {
  const root = o.lane.closest<HTMLElement>('.screen') ?? document.body;

  /* ---------- the bubbles ---------- */

  const bubbles: Record<Side, HTMLElement> = {
    me: el('div', 'chat-bubble is-mine'),
    foe: el('div', 'chat-bubble is-foe'),
  };
  /** The bubble's text lives in its own span: the face stays free for the tail, the text clamps. */
  const bubbleText: Record<Side, HTMLElement> = {
    me: el('span', 'chat-bubble-t'),
    foe: el('span', 'chat-bubble-t'),
  };
  const bubbleTimers: Record<Side, number> = { me: 0, foe: 0 };
  for (const side of ['me', 'foe'] as const) {
    bubbles[side].hidden = true;
    bubbles[side].appendChild(bubbleText[side]);
    o.lane.appendChild(bubbles[side]);
  }

  function hideBubble(side: Side) {
    window.clearTimeout(bubbleTimers[side]);
    bubbleTimers[side] = 0;
    const node = bubbles[side];
    node.classList.remove('show');
    window.setTimeout(() => {
      if (!node.classList.contains('show')) node.hidden = true;
    }, 180);
  }

  function setBubble(side: Side, content: Node, emote = false) {
    if (side === 'foe' && muted) return;
    const node = bubbles[side];
    node.classList.toggle('is-emote', emote);
    bubbleText[side].replaceChildren(content);
    node.hidden = false;
    void node.offsetWidth;               // the swap starts from the rail, not from mid-air
    node.classList.add('show');
    window.clearTimeout(bubbleTimers[side]);
    bubbleTimers[side] = window.setTimeout(() => hideBubble(side), BUBBLE_MS);
  }

  function emoteNode(emote: ChatEmote): HTMLElement {
    const box = el('span', 'chat-emote');
    box.innerHTML = emote.svg;           // first-party static markup, never a player's string
    return box;
  }

  /* ---------- the wheel (built from the closed vocabulary) ---------- */

  const scrim = el('div', 'chat-scrim');
  scrim.hidden = true;
  scrim.addEventListener('click', () => { closeWheel(false); closeMenu(); });

  const wheel = el('section', 'chat-wheel');
  wheel.hidden = true;
  wheel.tabIndex = -1;
  wheel.setAttribute('role', 'dialog');
  wheel.setAttribute('aria-modal', 'true');
  wheel.setAttribute('aria-label', 'Quick chat');

  const head = el('div', 'chat-wheel-head');
  const title = el('p', 'chat-wheel-t', 'Quick chat');
  const cool = el('span', 'chat-cool', 'Ready');
  const closeKey = el('button', 'chat-wheel-x');
  closeKey.type = 'button';
  closeKey.setAttribute('aria-label', 'Close quick chat');
  closeKey.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-close" /></svg>';
  closeKey.addEventListener('click', () => closeWheel());
  head.append(title, cool, closeKey);

  const emoteRow = el('div', 'chat-emotes');
  emoteRow.setAttribute('role', 'group');
  emoteRow.setAttribute('aria-label', 'Emotes');
  const phraseGrid = el('div', 'chat-phrases');
  phraseGrid.setAttribute('data-scroll', '');        // the page never scrolls; this list may
  const options: HTMLButtonElement[] = [];

  for (const emote of EMOTES) {
    const b = el('button', 'chat-emote-btn');
    b.type = 'button';
    b.setAttribute('aria-label', `Send emote: ${emote.label}`);
    b.title = emote.label;
    b.innerHTML = emote.svg;
    b.addEventListener('click', () => sendEmote(emote));
    options.push(b);
    emoteRow.appendChild(b);
  }
  for (const text of TAUNTS) {
    const b = el('button', 'chat-phrase', text);
    b.type = 'button';
    b.addEventListener('click', () => sendText(text));
    options.push(b);
    phraseGrid.appendChild(b);
  }

  wheel.append(head, emoteRow, phraseGrid);
  root.append(scrim, wheel);

  /* ---------- the report hold's menu ---------- */

  const menu = el('div', 'chat-menu');
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Opponent options');
  const muteItem = el('button', 'chat-menu-b', 'Mute');
  muteItem.type = 'button';
  muteItem.setAttribute('role', 'menuitem');
  const reportItem = el('button', 'chat-menu-b', 'Report');
  reportItem.type = 'button';
  reportItem.setAttribute('role', 'menuitem');
  menu.append(muteItem, reportItem);
  root.appendChild(menu);

  const toast = el('p', 'chat-toast');
  toast.hidden = true;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  root.appendChild(toast);

  let toastTimer = 0;
  function say(text: string) {
    toast.textContent = text;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 1900);
  }

  /* ---------- session state ---------- */

  let openPanel = false;
  let menuOpen = false;
  let muted = false;
  let lastSentAt = 0;
  let lastBotAt = 0;
  let prevState: GameState | null = null;
  let keyOff: boolean | null = null;
  let coolText = '';
  let cooling = false;

  const canChat = (): boolean => o.live() && !o.busy();
  const isCooling = (): boolean => Date.now() < lastSentAt + SEND_GAP_MS;

  /* ---------- sending ---------- */

  function sendText(text: string) {
    if (!canChat() || isCooling()) return;
    lastSentAt = Date.now();
    setBubble('me', document.createTextNode(text));
    closeWheel(false);
    paintCool();
  }

  function sendEmote(emote: ChatEmote) {
    if (!canChat() || isCooling()) return;
    lastSentAt = Date.now();
    setBubble('me', emoteNode(emote), true);
    closeWheel(false);
    paintCool();
  }

  /** The machine's side of the conversation — one line, eight seconds apart, silence while muted. */
  function botSay(line: string, now: number) {
    if (muted || !o.live()) return;
    if (now - lastBotAt < BOT_GAP_MS) return;
    lastBotAt = now;
    setBubble('foe', document.createTextNode(line));
  }

  /* The two fixed replies are looked up in the taunt list instead of being retyped here, so the
     bot can only ever say a phrase the wheel already offers. */
  const MINE_REPLY = TAUNTS.find((t) => t === 'Oops, my bad.') ?? null;
  const LOG_REPLY = TAUNTS.find((t) => t === 'Tick tock.') ?? null;

  function react(line: string | null, now: number) {
    if (!line) return;
    botSay(line, now);
  }

  /**
   * What the board did since the last tick. All three events are public information the HUD
   * already turns into speech and notes, so chat reads the same numbers and never the fog.
   */
  function scan(s: GameState) {
    const prev = prevState;
    prevState = s;
    if (!prev) return;
    const local = o.localSide();
    const now = Date.now();

    /* a rival's mine going off on your turn is you hitting it */
    if (prev.turn === local) {
      for (let i = 0; i < s.mines.length; i++) {
        const mine = s.mines[i];
        if (mine && mine.triggered && !prev.mines[i]?.triggered && mine.owner !== local) {
          react(MINE_REPLY, now);
        }
      }
    }

    /* a log: `lastEvent` is a fresh object per roll, exactly like the note's play-once flag */
    const log = s.lastEvent;
    if (log && log !== prev.lastEvent && log.type === 'log') {
      const shoved = log.moves.some((m) => s.balls.some((b) => b.id === m.ballId && b.team === local));
      if (shoved) react(LOG_REPLY, now);
    }

    /* a wall of yours went up */
    if (s.walls.length > prev.walls.length
      && s.walls.slice(prev.walls.length).some((w) => w.owner === local)) {
      react(TAUNTS[Math.floor(Math.random() * TAUNTS.length)] ?? null, now);
    }
  }

  /* ---------- the wheel's open/close and cooldown ---------- */

  function paintCool() {
    const left = Math.max(0, lastSentAt + SEND_GAP_MS - Date.now());
    const text = left > 0 ? `Wait ${Math.ceil(left / 1000)}s` : 'Ready';
    if (text !== coolText) {
      coolText = text;
      cool.textContent = text;
      cool.dataset.state = left > 0 ? 'wait' : 'ready';
    }
    const next = left > 0;
    if (next !== cooling) {
      cooling = next;
      for (const b of options) b.disabled = cooling;
    }
  }

  function paintMenu() {
    muteItem.textContent = muted ? 'Unmute' : 'Mute';
  }

  function openWheel() {
    if (openPanel || !canChat()) return;
    openPanel = true;
    closeMenu();
    paintCool();
    wheel.hidden = false;
    scrim.hidden = false;
    scrim.classList.add('open');
    o.key.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => { wheel.classList.add('open'); });
    wheel.focus({ preventScroll: true });
  }

  function closeWheel(restore = true) {
    if (!openPanel) return;
    openPanel = false;
    wheel.classList.remove('open');
    o.key.setAttribute('aria-expanded', 'false');
    window.setTimeout(() => { if (!openPanel) wheel.hidden = true; }, 180);
    maybeHideScrim();
    if (restore) o.key.focus({ preventScroll: true });
  }

  function maybeHideScrim() {
    if (openPanel || menuOpen) return;
    scrim.classList.remove('open');
    window.setTimeout(() => {
      if (!openPanel && !menuOpen) scrim.hidden = true;
    }, 180);
  }

  function openMenu(chip: HTMLElement) {
    closeWheel(false);
    menuOpen = true;
    paintMenu();
    menu.hidden = false;
    const box = root.getBoundingClientRect();
    const chipBox = chip.getBoundingClientRect();
    const left = Math.max(8, Math.min(chipBox.right - box.left - MENU_W, box.width - MENU_W - 8));
    menu.style.left = `${left}px`;
    menu.style.bottom = `${box.bottom - chipBox.top + 6}px`;
    scrim.hidden = false;
    scrim.classList.add('open');
  }

  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    menu.hidden = true;
    maybeHideScrim();
  }

  muteItem.addEventListener('click', () => {
    muted = !muted;
    if (muted) hideBubble('foe');
    paintMenu();
    closeMenu();
    say(muted ? 'Muted for this session' : 'Unmuted');
  });
  reportItem.addEventListener('click', () => {
    closeMenu();
    say('Thanks, reported');
  });

  o.key.setAttribute('aria-expanded', 'false');
  o.key.addEventListener('click', () => { if (openPanel) closeWheel(); else openWheel(); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (menuOpen) { closeMenu(); return; }
    if (openPanel) closeWheel();
  });

  /* ---------- long-press: 400ms on the rival's chip ---------- */

  o.chips.forEach((chip, index) => {
    let hold = 0;
    let x = 0;
    let y = 0;
    const cancel = () => {
      if (!hold) return;
      window.clearTimeout(hold);
      hold = 0;
    };
    chip.addEventListener('pointerdown', (e) => {
      if (index === o.localSide() || !o.live()) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      x = e.clientX;
      y = e.clientY;
      cancel();
      hold = window.setTimeout(() => {
        hold = 0;
        openMenu(chip);
      }, HOLD_MS);
    });
    chip.addEventListener('pointermove', (e) => {
      if (Math.abs(e.clientX - x) > HOLD_SLOP || Math.abs(e.clientY - y) > HOLD_SLOP) cancel();
    });
    chip.addEventListener('pointerup', cancel);
    chip.addEventListener('pointercancel', cancel);
    chip.addEventListener('pointerleave', cancel);
    chip.addEventListener('contextmenu', (e) => { if (index !== o.localSide()) e.preventDefault(); });
  });

  /* ---------- the watcher ---------- */

  function syncKey() {
    const off = !o.live() || o.busy();
    if (off === keyOff) return;
    keyOff = off;
    o.key.disabled = off;
  }

  function tick() {
    scan(o.state());
    syncKey();
    paintCool();
    if (openPanel && !canChat()) closeWheel(false);
  }

  syncKey();
  paintCool();
  const watcher = window.setInterval(tick, POLL_MS);

  return {
    destroy() {
      window.clearInterval(watcher);
      window.clearTimeout(bubbleTimers.me);
      window.clearTimeout(bubbleTimers.foe);
      window.clearTimeout(toastTimer);
      scrim.hidden = true;
      wheel.hidden = true;
      menu.hidden = true;
      toast.hidden = true;
    },
  };
}
