/**
 * chat.ts — quick chat: the top-bar key, its bottom sheet, and the bubbles over the dock.
 *
 * The vocabulary is closed (`data/phrases.ts`): every send is one of twelve taunts or one of eight
 * emotes, so there is no input, no parser and nothing a player can type. The transport is local —
 * a message is a bubble with a timer, a report is a toast, mute is a boolean that dies with the
 * page. Nothing here opens a socket.
 *
 * The board is read, never written. Bubbles sit in a layer over the board box, but each one is
 * measured against the canvas before it is placed: the layer's slot directly above a chip is the
 * first choice, and a slot with no saturated team pixels (a ball) is preferred, walking upward.
 * That is what keeps a message off a token without the renderer ever knowing chat exists.
 */
import './chat.css';
import type { GameState, Player } from './rules';
import { EMOTES, TAUNTS, type ChatEmote } from './data/phrases';

export interface ChatOptions {
  /** The 44px key in the top bar. */
  key: HTMLButtonElement;
  /** The bubble layer: a DOM overlay over the board, pointer-events none. */
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
  destroy(): void;
}

const BUBBLE_MS = 2500;
const SEND_GAP_MS = 3000;
const BOT_GAP_MS = 8000;
const HOLD_MS = 400;
const HOLD_SLOP = 8;
const POLL_MS = 200;
const MENU_W = 168;
/** Vertical gaps above the chip a bubble may try, nearest first. */
const BUBBLE_GAPS = [8, 30, 52, 74, 96, 118];
const SAMPLE_STEP = 4;

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
  const found = document.getElementById('board');
  const canvas = found instanceof HTMLCanvasElement ? found : null;

  /* ---------- the bubbles ---------- */

  const bubbles: Record<Side, HTMLElement> = {
    me: el('div', 'chat-bubble is-mine'),
    foe: el('div', 'chat-bubble is-foe'),
  };
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

  /** How many saturated red/blue pixels (a ball) sit under a page-space rectangle. */
  function ballUnder(left: number, top: number, w: number, h: number): number {
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || canvas.width < 1 || canvas.height < 1) return 0;
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const x0 = Math.max(0, Math.floor((left - rect.left) * sx));
    const y0 = Math.max(0, Math.floor((top - rect.top) * sy));
    const x1 = Math.min(canvas.width, Math.ceil((left + w - rect.left) * sx));
    const y1 = Math.min(canvas.height, Math.ceil((top + h - rect.top) * sy));
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (bw < 2 || bh < 2) return 0;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 0;
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(x0, y0, bw, bh).data;
    } catch {
      return 0;                        // a tainted canvas must not break the HUD
    }
    let hits = 0;
    for (let y = 0; y < bh; y += SAMPLE_STEP) {
      for (let x = 0; x < bw; x += SAMPLE_STEP) {
        const i = (y * bw + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const red = r > 120 && r - g > 45 && r - b > 30;
        const blue = b > 100 && b - r > 45 && b - g > 20;
        if (red || blue) hits++;
      }
    }
    return hits;
  }

  /** The first chip that is not yours — the seat a rival bubble belongs over. */
  function rivalSide(): Player {
    const local = o.localSide();
    for (let p = 0; p < o.chips.length; p++) if (p !== local) return p;
    return local === 0 ? 1 : 0;
  }

  /**
   * Put a bubble above a seat: centred on its ball, the nearest clear height first. The bubble's
   * bottom edge stays at least 8px clear of the chip, so it can never cover the chip itself.
   */
  function place(side: Side, seat: Player) {
    const bubble = bubbles[side];
    const chip = o.chips[seat];
    if (!chip) return;
    const laneBox = o.lane.getBoundingClientRect();
    const chipBox = chip.getBoundingClientRect();
    const w = bubble.offsetWidth || 120;
    const h = bubble.offsetHeight || 32;
    const anchor = chipBox.left + Math.min(30, chipBox.width / 2);
    const left = Math.min(Math.max(anchor - w / 2, laneBox.left + 4), laneBox.right - w - 4);
    let top = chipBox.top - BUBBLE_GAPS[0] - h;
    for (const gap of BUBBLE_GAPS) {
      const candidate = chipBox.top - gap - h;
      if (candidate < laneBox.top + 4) break;
      if (ballUnder(left, candidate, w, h) === 0) { top = candidate; break; }
    }
    const clampedTop = Math.max(top, laneBox.top + 4);
    bubble.style.left = `${left - laneBox.left}px`;
    bubble.style.top = `${clampedTop - laneBox.top}px`;
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
    node.hidden = false;                 // measurable before it is placed
    place(side, side === 'me' ? o.localSide() : rivalSide());
    void node.offsetWidth;
    node.classList.add('show');
    window.clearTimeout(bubbleTimers[side]);
    bubbleTimers[side] = window.setTimeout(() => hideBubble(side), BUBBLE_MS);
  }

  function emoteNode(emote: ChatEmote): HTMLElement {
    const box = el('span', 'chat-emote');
    box.innerHTML = emote.svg;           // first-party static markup, never a player's string
    return box;
  }

  /* ---------- the sheet (built from the closed vocabulary) ---------- */

  const scrim = el('div', 'chat-scrim');
  scrim.hidden = true;
  scrim.addEventListener('click', () => { closeSheet(false); closeMenu(); });

  const sheet = el('section', 'chat-sheet');
  sheet.hidden = true;
  sheet.tabIndex = -1;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Quick chat');

  const head = el('div', 'chat-sheet-head');
  const title = el('p', 'chat-sheet-t', 'Quick chat');
  const closeKey = el('button', 'chat-sheet-x');
  closeKey.type = 'button';
  closeKey.setAttribute('aria-label', 'Close quick chat');
  closeKey.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-close" /></svg>';
  closeKey.addEventListener('click', () => closeSheet());
  head.append(title, closeKey);

  const body = el('div', 'chat-body');
  const emoteRow = el('div', 'chat-emotes');
  emoteRow.setAttribute('role', 'group');
  emoteRow.setAttribute('aria-label', 'Emotes');
  const phraseList = el('div', 'chat-phrases');
  phraseList.setAttribute('data-scroll', '');        // the page never scrolls; this list may

  for (const emote of EMOTES) {
    const b = el('button', 'chat-emote-btn');
    b.type = 'button';
    b.setAttribute('aria-label', `Send emote: ${emote.label}`);
    b.title = emote.label;
    b.innerHTML = emote.svg;
    b.addEventListener('click', () => sendEmote(emote));
    emoteRow.appendChild(b);
  }
  for (const text of TAUNTS) {
    const b = el('button', 'chat-phrase', text);
    b.type = 'button';
    b.addEventListener('click', () => sendText(text));
    phraseList.appendChild(b);
  }
  body.append(emoteRow, phraseList);

  const wait = el('div', 'chat-wait');
  const waitN = el('b', 'chat-wait-n', '0');
  const waitL = el('span', 'chat-wait-l', 'One message every 3 seconds');
  wait.append(waitN, waitL);

  sheet.append(head, body, wait);
  root.append(scrim, sheet);

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

  let sheetOpen = false;
  let menuOpen = false;
  let muted = false;
  let lastSentAt = 0;
  let lastBotAt = 0;
  let prevState: GameState | null = null;
  let keyOff: boolean | null = null;
  let cooling = false;

  const canChat = (): boolean => o.live() && !o.busy();
  const isCooling = (): boolean => Date.now() < lastSentAt + SEND_GAP_MS;

  /* ---------- sending ---------- */

  function sendText(text: string) {
    if (!canChat() || isCooling()) return;
    lastSentAt = Date.now();
    setBubble('me', document.createTextNode(text));
    closeSheet(false);
    paintCool();
  }

  function sendEmote(emote: ChatEmote) {
    if (!canChat() || isCooling()) return;
    lastSentAt = Date.now();
    setBubble('me', emoteNode(emote), true);
    closeSheet(false);
    paintCool();
  }

  /** The machine's side — one line, eight seconds apart, silence while muted. */
  function botSay(line: string, now: number) {
    if (muted || !o.live()) return;
    if (now - lastBotAt < BOT_GAP_MS) return;
    lastBotAt = now;
    setBubble('foe', document.createTextNode(line));
  }

  /* The two fixed replies are looked up in the taunt list instead of being retyped here, so the
     bot can only ever say a phrase the sheet already offers. */
  const MINE_REPLY = TAUNTS.find((t) => t === 'Oops, my bad.') ?? null;
  const LOG_REPLY = TAUNTS.find((t) => t === 'Tick tock.') ?? null;

  function react(line: string | null, now: number) {
    if (!line) return;
    botSay(line, now);
  }

  /** What the board did since the last tick. */
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

    /* a log: `lastEvent` is a fresh object per roll */
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

  /* ---------- the sheet's open/close and cooldown ---------- */

  function paintCool() {
    const left = Math.max(0, lastSentAt + SEND_GAP_MS - Date.now());
    const next = left > 0;
    const secs = String(Math.ceil(left / 1000));
    if (waitN.textContent !== secs) waitN.textContent = secs;
    if (next !== cooling) {
      cooling = next;
      sheet.classList.toggle('cooling', cooling);
    }
  }

  function paintMenu() {
    muteItem.textContent = muted ? 'Unmute' : 'Mute';
  }

  function openWheel() {
    if (sheetOpen || !canChat()) return;
    sheetOpen = true;
    closeMenu();
    paintCool();
    sheet.hidden = false;
    scrim.hidden = false;
    void sheet.offsetWidth;              // settle the closed state before sliding up
    sheet.classList.add('open');
    scrim.classList.add('open');
    o.key.setAttribute('aria-expanded', 'true');
    sheet.focus({ preventScroll: true });
  }

  function closeSheet(restore = true) {
    if (!sheetOpen) return;
    sheetOpen = false;
    sheet.classList.remove('open');
    o.key.setAttribute('aria-expanded', 'false');
    window.setTimeout(() => { if (!sheetOpen) sheet.hidden = true; }, 210);
    maybeHideScrim();
    if (restore) o.key.focus({ preventScroll: true });
  }

  function maybeHideScrim() {
    if (sheetOpen || menuOpen) return;
    scrim.classList.remove('open');
    window.setTimeout(() => {
      if (!sheetOpen && !menuOpen) scrim.hidden = true;
    }, 180);
  }

  function openMenu(chip: HTMLElement) {
    closeSheet(false);
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
  o.key.addEventListener('click', () => { if (sheetOpen) closeSheet(); else openWheel(); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (menuOpen) { closeMenu(); return; }
    if (sheetOpen) closeSheet();
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
    if (sheetOpen && !canChat()) closeSheet(false);
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
      sheet.hidden = true;
      menu.hidden = true;
      toast.hidden = true;
    },
  };
}
