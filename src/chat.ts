/**
 * chat.ts — quick chat: the key above the dock, its bottom sheet, and the floating bubbles.
 *
 * The vocabulary is closed (`data/phrases.ts`): every send is one of four tactical one-liners or
 * one of three psychological emotes, so there is no input, no parser and nothing a player can
 * type. The transport is local —
 * a message is a bubble with a timer, a report is a toast, mute is a boolean that dies with the
 * page. Nothing here opens a socket.
 *
 * The board is read, never written. A message no longer hangs off the sender's HUD card: it
 * spawns in the gameplay zone, centred over the sender's pawn. The renderer owns the only true
 * pawn position, so `pawn()` hands chat the live screen point of a seat's ball; chat drops the
 * `.pawn-you` / `.pawn-bot` marker on that point and hangs the bubble above it, clearing the
 * move-dot ring (a hint can leap two cells) by the spec's 24px. The layer and every mark in it
 * are `pointer-events: none`, so the grid underneath keeps every tile tap.
 */
import './chat.css';
import type { GameState, Player } from './rules';
import { EMOTES, TAUNTS, type ChatEmote, type ChatEmoteId } from './data/phrases';
import { playLaugh, playAngrySound } from './audio';
import { impact, notify } from './telegram';

/** A seat's pawn on screen: its animated centre in viewport px, plus the board's live cell. */
export interface PawnPoint {
  x: number;
  y: number;
  /** the board's own cell size in css px — the metric the move dots are drawn from */
  cell: number;
}

export interface ChatOptions {
  /** The recessed pill in the dock's console rail: the one slot chat has ever needed. */
  key: HTMLButtonElement;
  /** The bubble layer: a DOM overlay over the board, pointer-events none. */
  lane: HTMLElement;
  /** The seat chips, in player order — index === Player. */
  chips: readonly HTMLElement[];
  state: () => GameState;
  localSide: () => Player;
  /** The live screen point over a seat's pawn, or null while no ball of that seat is drawn. */
  pawn: (seat: Player) => PawnPoint | null;
  /** A log is rolling, or a mine is armed: chat is shut for both. */
  busy: () => boolean;
  /** The race screen is up, unpaused, with no result card over it. */
  live: () => boolean;
  /** The wire: an emote this player sent, for an online race to relay. Absent offline. */
  onEmote?: (id: ChatEmoteId) => void;
}

export interface Chat {
  /** An emote the rival sent over the wire: pop their bubble over their pawn, and give it a voice. */
  inboundEmote(id: ChatEmoteId): void;
  destroy(): void;
}

const BUBBLE_MS = 2500;
/** An emote is a performance: the face loops at full energy for 2s, then the bubble floats out. */
const EMOTE_MS = 2000;
/** The exit: opacity 1 -> 0 while the bubble drifts up 18px. Matches the transition in chat.css. */
const LEAVE_MS = 360;
const SEND_GAP_MS = 3000;
const BOT_GAP_MS = 8000;
const HOLD_MS = 400;
const HOLD_SLOP = 8;
const POLL_MS = 200;
const MENU_W = 168;
/** How far above the pawn the move-dot ring can reach, in cells: a hint may leap over a body two
 *  cells away, plus the dot's own halo. The spec's 24px sits above that. */
const DOT_REACH_CELLS = 2.4;
const DOT_CLEAR_PX = 24;
/** The fallback lift when a race has no drawn pawn yet: the bubble still clears the chip it names. */
const CHIP_GAP_PX = 44;

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
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

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
  /* the pawn markers: invisible points the bubbles hang from, one per side. They carry no box at
     all, so the layer can map them without the renderer ever knowing chat exists. */
  const pawnAnchors: Record<Side, HTMLElement> = {
    me: el('i', 'pawn-anchor pawn-you'),
    foe: el('i', 'pawn-anchor pawn-bot'),
  };
  for (const side of ['me', 'foe'] as const) {
    pawnAnchors[side].setAttribute('aria-hidden', 'true');
    bubbles[side].hidden = true;
    bubbles[side].appendChild(bubbleText[side]);
    o.lane.append(pawnAnchors[side], bubbles[side]);
  }

  /** The first chip that is not yours — the seat a rival bubble belongs over. */
  function rivalSide(): Player {
    const local = o.localSide();
    for (let p = 0; p < o.chips.length; p++) if (p !== local) return p;
    return local === 0 ? 1 : 0;
  }

  /**
   * Hang a bubble over its sender's pawn. `o.pawn()` gives the live screen point of the seat's
   * ball; the `.pawn-you`/`.pawn-bot` marker is dropped exactly there, and the bubble is centred
   * on it, its foot `DOT_REACH_CELLS` cells plus 24px above the point — clear of the move-dot ring
   * a hint can draw around the pawn. The tail tracks the pawn even when the capsule is nudged off
   * centre at a board edge. A race with no drawn ball falls back to a fixed lift over the seat's
   * HUD chip, so a message always has a mark to hang from.
   */
  function place(side: Side, seat: Player) {
    const bubble = bubbles[side];
    const anchor = pawnAnchors[side];
    const laneBox = o.lane.getBoundingClientRect();
    const w = bubble.offsetWidth || 120;
    const h = bubble.offsetHeight || 32;
    const at = o.pawn(seat);
    if (at) {
      anchor.style.left = `${at.x - laneBox.left}px`;
      anchor.style.top = `${at.y - laneBox.top}px`;
    } else {
      const chip = o.chips[seat];
      if (!chip) return;
      const chipBox = chip.getBoundingClientRect();
      anchor.style.left = `${chipBox.left + Math.min(30, chipBox.width / 2) - laneBox.left}px`;
      anchor.style.top = `${chipBox.top - laneBox.top}px`;
    }
    const ax = Number.parseFloat(anchor.style.left) || 0;
    const ay = Number.parseFloat(anchor.style.top) || 0;
    const foot = at ? ay - (at.cell * DOT_REACH_CELLS + DOT_CLEAR_PX) : ay - CHIP_GAP_PX;
    const left = clamp(ax - w / 2, 4, Math.max(4, laneBox.width - w - 4));
    const top = Math.max(4, foot - h);
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    /* the tail points at the pawn: it shifts with the capsule when a board edge pushes it */
    bubble.style.setProperty('--tip', `${clamp(ax - left, 10, w - 10)}px`);
  }

  /**
   * The exit is a fade, not a cut: `is-out` swaps the visible state for `opacity: 0` plus an 18px
   * float, and the node is only hidden once that transition has landed.
   */
  function hideBubble(side: Side) {
    window.clearTimeout(bubbleTimers[side]);
    bubbleTimers[side] = 0;
    const node = bubbles[side];
    if (node.hidden) return;
    node.classList.add('is-out');
    window.setTimeout(() => {
      if (!node.classList.contains('is-out')) return;   // a fresh message took the slot back
      node.classList.remove('show', 'is-out');
      node.hidden = true;
    }, LEAVE_MS);
  }

  function setBubble(side: Side, content: Node, emote = false) {
    if (side === 'foe' && muted) return;
    const node = bubbles[side];
    window.clearTimeout(bubbleTimers[side]);
    node.classList.remove('is-out');     // a new message cancels a fade in flight
    node.classList.toggle('is-emote', emote);
    bubbleText[side].replaceChildren(content);
    node.hidden = false;                 // measurable before it is placed
    place(side, side === 'me' ? o.localSide() : rivalSide());
    /* re-arm the spring: dropping `show` and forcing a reflow restarts the pop keyframes, so a
       second message pops exactly like the first instead of sliding in from wherever it was */
    node.classList.remove('show');
    void node.offsetWidth;
    node.classList.add('show');
    /* a rival's line warms the chat slot until it is opened: the key is where the reply lives */
    if (side === 'foe') o.key.classList.add('is-ping');
    bubbleTimers[side] = window.setTimeout(() => hideBubble(side), emote ? EMOTE_MS : BUBBLE_MS);
  }

  function emoteNode(emote: ChatEmote): HTMLElement {
    /* the same `.emote-*` family the pod uses, so the face keeps performing in the bubble */
    const box = el('span', `chat-emote emote-${emote.motion}`);
    box.innerHTML = emote.svg;           // first-party static markup, never a player's string
    return box;
  }

  /**
   * The rival's emote, arrived over the wire (or played back by the machine): the bubble pops over
   * their pawn on this frame, and the two faces with a voice — the laugh and the growl — ring with
   * it. A muted opponent is as silent as they are invisible, so the whole call is dropped while muted.
   */
  function inboundEmote(id: ChatEmoteId): void {
    if (!o.live() || muted) return;
    const emote = EMOTES.find((e) => e.id === id);
    if (!emote) return;
    if (id === 'laugh') playLaugh();
    else if (id === 'fury') playAngrySound();
    setBubble('foe', emoteNode(emote), true);
  }

  /* ---------- the sheet (built from the closed vocabulary) ---------- */

  const scrim = el('div', 'chat-scrim');
  scrim.hidden = true;
  scrim.addEventListener('click', () => { closeSheet(false); closeMenu(); });

  const sheet = el('section', 'chat-sheet');
  sheet.id = 'chat-sheet';
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
  phraseList.setAttribute('role', 'group');
  phraseList.setAttribute('aria-label', 'Taunts');

  /* three large emote pods: a recessed obsidian well, the layered art, the feeling in one word */
  for (const emote of EMOTES) {
    const b = el('button', `chat-emote-btn is-${emote.id}`);
    b.type = 'button';
    b.setAttribute('aria-label', `Send emote: ${emote.label}`);
    b.title = emote.label;
    b.dataset.motion = emote.motion;
    /* the art wrapper — never the button — carries the loop, so the tap's own bounce can layer
       on top of it without the two fighting over one transform */
    const art = el('span', `chat-emote-art emote-${emote.motion}`);
    art.innerHTML = emote.svg;         // first-party static markup, never a player's string
    b.append(art, el('span', 'chat-emote-micro', emote.micro));
    b.addEventListener('click', () => sendEmote(emote, b));
    emoteRow.appendChild(b);
  }
  /* four taunt pills in a 2x2 grid: terse, scannable, one tap each */
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
    impact('light');                     // a soft tap: the line is short, the jolt should be too
    setBubble('me', document.createTextNode(text));
    closeSheet(false);
    paintCool();
  }

  function sendEmote(emote: ChatEmote, btn: HTMLButtonElement) {
    if (!canChat() || isCooling()) return;
    lastSentAt = Date.now();
    /* the face is the message, so it lands three times: the "Haha!" / "Grrr!" itself, a success
       chime in the hand, then the thump — and the wire carries the same id to the rival's screen */
    if (emote.id === 'laugh') playLaugh();
    else if (emote.id === 'fury') playAngrySound();
    impact('medium');
    notify('success');
    /* the pod bounces once on the tap that spent it; the class is re-armed on every press */
    btn.classList.remove('is-tapped');
    void btn.offsetWidth;
    btn.classList.add('is-tapped');
    window.setTimeout(() => btn.classList.remove('is-tapped'), 420);
    setBubble('me', emoteNode(emote), true);
    o.onEmote?.(emote.id);               // the wire, when there is one: the rival sees the same face
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

  /* The three fixed replies are looked up in the taunt list instead of being retyped here, so the
     bot can only ever say a phrase the sheet already offers. */
  const MINE_REPLY = TAUNTS.find((t) => t === 'Boom! Nice step.') ?? null;
  const LOG_REPLY = TAUNTS.find((t) => t === 'Tick tock...') ?? null;
  const WALL_REPLY = TAUNTS.find((t) => t === 'Path closed.') ?? null;

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
      react(WALL_REPLY, now);
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
    o.key.classList.remove('is-ping');   // the reply is being written: the slot goes quiet
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
  o.key.setAttribute('aria-controls', sheet.id);
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
    inboundEmote,
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
