/**
 * chat.ts — quick chat: the key above the dock, its centred banter sheet, and the floating bubbles.
 *
 * The vocabulary is closed (`data/phrases.ts`): every send is one of six tactical one-liners — in
 * English or Persian, whichever way the header's EN | FA pill is leaning — or one of three
 * psychological emotes, so there is no input, no parser and nothing a player can type. A phrase
 * rides the wire as a `(lang, index)` pair and is looked back up in the same closed table on the
 * far side; an emote rides as its own id. The sheet's tongue lives in the save (`activeChatLang`),
 * so it is the same tongue the next time it opens.
 *
 * The board is read, never written. A message no longer hangs off the sender's HUD card: it
 * spawns in the gameplay zone, centred over the sender's pawn. The renderer owns the only true
 * pawn position, so `pawn()` hands chat the live screen point, radius and colour family of a
 * seat's ball; chat drops the `.pawn-you` / `.pawn-bot` marker on that point and hangs the bubble
 * a tight 10px above the token's upper edge. The tail then points straight back down at the ball,
 * and the rim/aura take the same red or blue the pawn is painted in. The layer and every mark in
 * it are `pointer-events: none`, so the grid underneath keeps every tile tap.
 */
import './chat.css';
import type { GameState, Player } from './rules';
import {
  CHAT_LANGS, CHAT_PHRASES, EMOTES, PHRASE_COUNT, isChatLang, phraseLine,
  type ChatEmote, type ChatEmoteId, type ChatLang,
} from './data/phrases';
import { playLaugh, playAngrySound } from './audio';
import { impact, notify } from './telegram';
import { readJson, writeJson } from './storage';

/** A seat's pawn on screen: its animated centre in viewport px, its radius, and its colour. */
export interface PawnPoint {
  x: number;
  y: number;
  /** the solid token's radius in css px: the bubble's tail stops just above this circle */
  radius: number;
  /** the family the ball wears on this client, so the bubble can borrow the same neon */
  color: 'red' | 'blue';
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
  /** A mine is armed: chat is shut while the board owns the tap. */
  busy: () => boolean;
  /** The race screen is up, unpaused, with no result card over it. */
  live: () => boolean;
  /** The wire: an emote this player sent, for an online race to relay. Absent offline. */
  onEmote?: (id: ChatEmoteId) => void;
  /** The wire: a phrase this player sent, as its `(lang, index)`. Absent offline. */
  onPhrase?: (lang: ChatLang, index: number) => void;
}

export interface Chat {
  /** An emote the rival sent over the wire: pop their bubble over their pawn, and give it a voice. */
  inboundEmote(id: ChatEmoteId): void;
  /** A phrase the rival sent: the closed table turns `(lang, index)` back into a line and pops it. */
  inboundPhrase(lang: ChatLang, index: number): void;
  destroy(): void;
}

/** Every message, emote or phrase, holds for the same beat before its graceful exit. */
const BUBBLE_MS = 2500;
/** The exit: opacity 1 -> 0 while the bubble settles inward. Matches the transition in chat.css. */
const LEAVE_MS = 340;
/** The anti-spam gate: one message per player per 1.5s, so a phrase cannot machine-gun the wire. */
const SEND_GAP_MS = 1500;
const BOT_GAP_MS = 8000;
const HOLD_MS = 400;
const HOLD_SLOP = 8;
const POLL_MS = 200;
const MENU_W = 168;
/** Where the sheet's tongue is remembered: the save's own wrapped door, so a webview with no
 *  localStorage still gets a working toggle (it just forgets between pages). */
const LANG_KEY = 'detour.chat.lang.v1';
/** The tight daylight between the bubble's chassis and the top of the solid pawn. */
const PAWN_GAP_PX = 10;
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

/** The tongue the sheet last spoke, out of the save; EN when nothing (or nonsense) is stored. */
function readChatLang(): ChatLang {
  const raw = readJson<{ lang?: unknown }>(LANG_KEY);
  return isChatLang(raw?.lang) ? raw.lang : 'EN';
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
  /* the last seat each slot spoke for, so a live placement tick can follow that pawn as it moves */
  const bubbleSeats: Record<Side, Player> = { me: 0, foe: 1 };
  /* the pawn family last seen for each slot; the chip's own red/blue class is the no-ball fallback */
  const bubbleTints: Record<Side, 'red' | 'blue'> = { me: 'red', foe: 'blue' };
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
   * Hang a bubble over its sender's pawn. `o.pawn()` gives the live screen point, radius and
   * colour of the seat's ball; the `.pawn-you`/`.pawn-bot` marker is dropped exactly there, the
   * bubble is centred on it, and its chassis stops `PAWN_GAP_PX` above the token's upper edge.
   * The tail tracks the pawn even when the capsule is nudged off centre at a board edge, and the
   * rim adopts the same red or blue family the ball wears. A race with no drawn ball falls back
   * to a fixed lift over the seat's HUD chip, so a message always has a mark to hang from.
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
      bubbleTints[side] = at.color;
    } else {
      const chip = o.chips[seat];
      if (!chip) return;
      const chipBox = chip.getBoundingClientRect();
      anchor.style.left = `${chipBox.left + Math.min(30, chipBox.width / 2) - laneBox.left}px`;
      anchor.style.top = `${chipBox.top - laneBox.top}px`;
      if (chip.classList.contains('blue')) bubbleTints[side] = 'blue';
      else if (chip.classList.contains('red')) bubbleTints[side] = 'red';
    }
    bubble.classList.toggle('is-red', bubbleTints[side] === 'red');
    bubble.classList.toggle('is-blue', bubbleTints[side] === 'blue');
    const ax = Number.parseFloat(anchor.style.left) || 0;
    const ay = Number.parseFloat(anchor.style.top) || 0;
    const foot = at ? ay - at.radius - PAWN_GAP_PX : ay - CHIP_GAP_PX;
    const left = clamp(ax - w / 2, 4, Math.max(4, laneBox.width - w - 4));
    const top = Math.max(4, foot - h);
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    /* the tail points at the pawn: it shifts with the capsule when a board edge pushes it */
    bubble.style.setProperty('--tip', `${clamp(ax - left, 10, w - 10)}px`);
  }

  /**
   * The exit is a fade, not a cut: `is-out` swaps the visible state for `opacity: 0` plus a small
   * settle, and the node leaves the DOM entirely once that transition has landed.
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
      node.remove();                                     // the message is gone, not just unseen
    }, LEAVE_MS);
  }

  function setBubble(side: Side, content: Node, emote = false) {
    if (side === 'foe' && muted) return;
    const node = bubbles[side];
    const seat = side === 'me' ? o.localSide() : rivalSide();
    bubbleSeats[side] = seat;
    window.clearTimeout(bubbleTimers[side]);
    node.classList.remove('is-out');     // a new message cancels a fade in flight
    node.classList.toggle('is-emote', emote);
    bubbleText[side].replaceChildren(content);
    if (!node.isConnected) o.lane.appendChild(node);
    node.hidden = false;                 // measurable before it is placed
    place(side, seat);
    /* re-arm the spring: dropping `show` and forcing a reflow restarts the pop keyframes, so a
       second message pops exactly like the first instead of sliding in from wherever it was */
    node.classList.remove('show');
    void node.offsetWidth;
    node.classList.add('show');
    /* a rival's line warms the chat slot until it is opened: the key is where the reply lives */
    if (side === 'foe') o.key.classList.add('is-ping');
    bubbleTimers[side] = window.setTimeout(() => hideBubble(side), BUBBLE_MS);
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

  /**
   * The rival's phrase, arrived over the wire: their `(lang, index)` pair is looked back up in the
   * same closed table — no text ever crosses the socket — and popped over their pawn. A muted
   * opponent is as silent as they are invisible, so the whole call is dropped while muted.
   */
  function inboundPhrase(lang: ChatLang, index: number): void {
    if (!o.live() || muted) return;
    const line = phraseLine(lang, index);
    if (!line) return;
    setBubble('foe', document.createTextNode(line));
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
  sheet.setAttribute('aria-label', 'Tactical banter');

  const head = el('div', 'chat-sheet-head');
  const title = el('p', 'chat-sheet-t', 'Tactical Banter');
  /* the tongue pill: a recessed two-slot track with the sliding thumb, sat between the title and
     the close key. It repaints the six tiles in place — same grid, same tiles, new words. */
  const langPill = el('div', 'chat-lang');
  langPill.setAttribute('role', 'group');
  langPill.setAttribute('aria-label', 'Chat language');
  const langKeys = {} as Record<ChatLang, HTMLButtonElement>;
  for (const lang of CHAT_LANGS) {
    const b = el('button', 'chat-lang-b', lang);
    b.type = 'button';
    b.dataset.lang = lang;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => setChatLang(lang));
    langKeys[lang] = b;
    langPill.appendChild(b);
  }
  const langSlide = el('span', 'chat-lang-slide');
  langSlide.setAttribute('aria-hidden', 'true');
  langPill.appendChild(langSlide);
  const closeKey = el('button', 'chat-sheet-x');
  closeKey.type = 'button';
  closeKey.setAttribute('aria-label', 'Close tactical banter');
  closeKey.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-close" /></svg>';
  closeKey.addEventListener('click', () => closeSheet());
  head.append(title, langPill, closeKey);

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
  /* six taunt tiles in a balanced 2x3 grid: every line has a slot in both tongues, so the toggle
     only rewrites textContent and the grid never moves a pixel */
  const phraseKeys: HTMLButtonElement[] = [];
  for (let i = 0; i < PHRASE_COUNT; i++) {
    const b = el('button', 'chat-phrase');
    b.type = 'button';
    b.dir = 'auto';
    b.dataset.index = String(i);
    b.addEventListener('click', () => sendPhrase(i));
    phraseKeys.push(b);
    phraseList.appendChild(b);
  }
  body.append(emoteRow, phraseList);

  const wait = el('div', 'chat-wait');
  const waitN = el('b', 'chat-wait-n', '0');
  const waitL = el('span', 'chat-wait-l', 'One message every 1.5 seconds');
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
  /* The tongue the six tiles speak. It starts from the save and is written back on every flip, so
     the pill is exactly where the player left it the next time the sheet opens. */
  let activeChatLang: ChatLang = readChatLang();

  const canChat = (): boolean => o.live() && !o.busy();
  const isCooling = (): boolean => Date.now() < lastSentAt + SEND_GAP_MS;

  /* ---------- the tongue ---------- */

  /** Repaint the six tiles out of the active tongue's set, in place: same slots, new words. */
  function paintPhrases() {
    phraseList.dataset.lang = activeChatLang;
    for (let i = 0; i < phraseKeys.length; i++) {
      const line = CHAT_PHRASES[activeChatLang][i] ?? '';
      if (phraseKeys[i].textContent !== line) phraseKeys[i].textContent = line;
    }
  }

  /** The pill itself: the slide lands on the active slot and the two keys swap their lit state. */
  function paintLang() {
    langPill.dataset.lang = activeChatLang;
    sheet.dataset.lang = activeChatLang;
    for (const lang of CHAT_LANGS) {
      const b = langKeys[lang];
      const on = lang === activeChatLang;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  function setChatLang(lang: ChatLang) {
    if (lang === activeChatLang) return;
    activeChatLang = lang;
    writeJson(LANG_KEY, { lang });
    paintLang();
    paintPhrases();
  }

  /* ---------- sending ---------- */

  /**
   * A phrase tile: the line goes up locally, and online the same `(lang, index)` pair rides the
   * wire — the rival's client looks it back up in the same closed table, so no text crosses over.
   */
  function sendPhrase(index: number) {
    if (!canChat() || isCooling()) return;
    const line = phraseLine(activeChatLang, index);
    if (!line) return;
    lastSentAt = Date.now();
    impact('light');                     // a soft tap: the line is short, the jolt should be too
    setBubble('me', document.createTextNode(line));
    o.onPhrase?.(activeChatLang, index); // the wire, when there is one
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

  /**
   * The machine's three fixed replies are looked up in the same closed vocabulary, in whichever
   * tongue the sheet is currently speaking, so the bot can only ever say a line the player could
   * have tapped: 1 the trap, 2 the clock, 3 the blueprint.
   */
  const botReply = (index: number): string | null => phraseLine(activeChatLang, index);

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
          react(botReply(1), now);
        }
      }
    }

    /* a wall of yours went up */
    if (s.walls.length > prev.walls.length
      && s.walls.slice(prev.walls.length).some((w) => w.owner === local)) {
      react(botReply(3), now);
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
    /* a visible bubble keeps following its pawn's animated centre, so the tail never drifts away
       when the token slides to a new tile during the message's short life */
    for (const side of ['me', 'foe'] as const) {
      const node = bubbles[side];
      if (node.hidden || node.classList.contains('is-out')) continue;
      place(side, bubbleSeats[side]);
    }
    if (sheetOpen && !canChat()) closeSheet(false);
  }

  syncKey();
  paintCool();
  paintLang();
  paintPhrases();
  const watcher = window.setInterval(tick, POLL_MS);

  return {
    inboundEmote,
    inboundPhrase,
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
