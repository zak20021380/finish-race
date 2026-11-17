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
 * spawns in the gameplay zone: the local line in the quadrant of the sender's pawn the board still
 * has room for, the rival's line on the right flank of its ball so it never reaches back across the
 * player's own ball or movement rings. The renderer owns the only true pawn position, so `pawn()`
 * hands chat the live screen point,
 * radius, tile metric and colour family of a seat's ball; chat drops the `.pawn-you` / `.pawn-bot`
 * marker on that point and hangs the chassis near it. The chassis never crosses the four cardinal
 * move-dot halos, and its tail is aimed, not bolted to a corner: chat recomputes the wedge's root
 * on the face and its angle every frame, so the tip lands on that one token's crown however an edge
 * clamp slid the box. The layer and every mark in it are `pointer-events: none`, so the grid
 * underneath keeps every tile tap.
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
import { isPremiumUser, onVipChange, openVipSheet } from './premium';
import { onLang, t } from './settings';

/**
 * The neon family a seat wears on THIS client, out of the same plan that tints the board and the
 * HUD chip: the two chosen families for the duel, then solar gold and amethyst for the seats a
 * party adds.
 */
export type PawnTint = 'red' | 'blue' | 'gold' | 'amethyst';

/** A seat's pawn on screen: its animated centre, radius, tile metric and colour. */
export interface PawnPoint {
  x: number;
  y: number;
  /** the solid token's radius in css px */
  radius: number;
  /** the board's cell size in css px — the distance from the pawn to a cardinal move dot */
  cell: number;
  /** the family the ball wears on this client, so the bubble can borrow the same neon */
  color: PawnTint;
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
  /**
   * The hands-on lesson owns this match: every rival line, emote, phrase and unread ping is
   * dropped and the key is dead, so a first-time player has exactly one thing to look at.
   */
  silent?: () => boolean;
  /** The wire: an emote this player sent, for an online race to relay. Absent offline. */
  onEmote?: (id: ChatEmoteId) => void;
  /** The wire: a phrase this player sent, as its `(lang, index)`. Absent offline. */
  onPhrase?: (lang: ChatLang, index: number) => void;
  /** The wire: a free-text line this VIP player typed in match. Absent offline. */
  onCustom?: (text: string) => void;
}

export interface Chat {
  /**
   * An emote the rival sent over the wire: pop their bubble over their pawn, and give it a voice.
   * `seat` is the sender's own seat as the room reported it — without it a party race would have to
   * guess, and the guess lands the bubble on whichever rival chip comes first.
   */
  inboundEmote(id: ChatEmoteId, seat?: Player): void;
  /** A phrase the rival sent: the closed table turns `(lang, index)` back into a line and pops it. */
  inboundPhrase(lang: ChatLang, index: number, seat?: Player): void;
  /** A free-text line a VIP rival sent: popped over their pawn, gold when the room vouched for it. */
  inboundCustom(text: string, seat?: Player, vip?: boolean): void;
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
/** How far up-left of the pawn's centre the bubble's nearest corner parks, in cells. */
const PAWN_OFFSET_CELLS = 0.55;
const PAWN_OFFSET_MIN_PX = 18;
/** The cardinal move-dot halo plus daylight: the chassis may never enter this radius. */
const DOT_CLEAR_CELLS = 0.4;
const DOT_CLEAR_MIN_PX = 15;
/** The rival's bubble parks with its left edge this far left of the ball's centre, so the body
 *  opens toward the board's right flank and its tail root lands on the bottom-left corner. */
const FOE_LEFT_OVERHANG_PX = 6;
/** The rival bubble's daylight above its own ball crown, in cells then px: a readable tail. */
const FOE_LIFT_CELLS = 0.72;
const FOE_LIFT_MIN_PX = 28;
/** The rival's bubble keeps this much daylight off the player's ball itself. */
const FOE_KEEPOUT_GAP_PX = 5;
/** ...and this much off the whole cluster when it has to slide clear of the player's rings. */
const FOE_CLUSTER_GAP_PX = 6;
/** The fallback lift when a race has no drawn pawn yet: the bubble still clears the chip it names. */
const CHIP_GAP_PX = 44;
/** The lane's own margin: a clamped bubble keeps this much board between its box and the frame. */
const LANE_EDGE_PX = 8;
/** The tail's tip stands this far off the token's skin, measured from its centre. */
const TAIL_TIP_GAP_PX = 4;
/** The wedge's exposed length. The floor keeps a stub readable; the ceiling is the spike guard for
 *  the rare box an edge clamped far from its pawn. A root sits inside the face, so a big board puts
 *  the token about 30px away and the tip still has to reach it. */
const TAIL_MIN_PX = 5;
const TAIL_MAX_PX = 30;
/** How far inside the face the tail's root sits, so it never rests on a rounded corner. */
const TAIL_FACE_INSET_PX = 9;
/** The neon families a seat can wear, in the order the bubble paints its classes. */
const TINTS: readonly PawnTint[] = ['red', 'blue', 'gold', 'amethyst'];

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

/** The VIP composer's ceiling: the same 40 printable characters the post-match line allows. */
const CUSTOM_MAX = 40;
function clipCustom(raw: string): string {
  const clean = (raw ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return Array.from(clean).slice(0, CUSTOM_MAX).join('');
}

export function createChat(o: ChatOptions): Chat {
  const root = o.lane.closest<HTMLElement>('.screen') ?? document.body;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

  /* ---------- the bubbles ---------- */

  const bubbles: Record<Side, HTMLElement> = {
    me: el('div', 'chat-bubble is-mine board-chat-bubble'),
    foe: el('div', 'chat-bubble is-foe board-chat-bubble bot-speech-bubble'),
  };
  const bubbleText: Record<Side, HTMLElement> = {
    me: el('span', 'chat-bubble-t'),
    foe: el('span', 'chat-bubble-t'),
  };
  const bubbleTimers: Record<Side, number> = { me: 0, foe: 0 };
  /* the last seat each slot spoke for, so a live placement tick can follow that pawn as it moves */
  const bubbleSeats: Record<Side, Player> = { me: 0, foe: 1 };
  /* the pawn family last seen for each slot; the chip's own colour class is the no-ball fallback */
  const bubbleTints: Record<Side, PawnTint> = { me: 'red', foe: 'blue' };
  /* the wedge that points at the sender's token: chat.ts aims it, chat.css draws it */
  const bubbleTails: Record<Side, HTMLElement> = {
    me: el('i', 'chat-bubble-tail'),
    foe: el('i', 'chat-bubble-tail'),
  };
  /* the pawn markers: invisible points the bubbles hang from, one per side. They carry no box at
     all, so the layer can map them without the renderer ever knowing chat exists. */
  const pawnAnchors: Record<Side, HTMLElement> = {
    me: el('i', 'pawn-anchor pawn-you'),
    foe: el('i', 'pawn-anchor pawn-bot'),
  };
  for (const side of ['me', 'foe'] as const) {
    pawnAnchors[side].setAttribute('aria-hidden', 'true');
    bubbleTails[side].setAttribute('aria-hidden', 'true');
    bubbles[side].hidden = true;
    bubbles[side].append(bubbleTails[side], bubbleText[side]);
    o.lane.append(pawnAnchors[side], bubbles[side]);
  }

  /** The first chip that is not yours — the seat a rival bubble belongs over. */
  function rivalSide(): Player {
    const local = o.localSide();
    for (let p = 0; p < o.chips.length; p++) if (p !== local) return p;
    return local === 0 ? 1 : 0;
  }

  /**
   * Hang a bubble beside its sender. `o.pawn()` gives the live screen point, radius, cell and colour
   * of the seat's ball; the `.pawn-you`/`.pawn-bot` marker is dropped exactly on the token, and the
   * box parks in the quadrant nearest it — north-west first, the corner the board was always read
   * from. A quadrant only counts when the whole box fits the lane and its corner stays outside every
   * cardinal move-dot halo, which leaves the upward tile and all four dots fully visible. When the
   * edges leave no clean quadrant, the north-west intent is clamped in and pushed clear.
   *
   * The rival's line is different: it opens to the RIGHT of the blue ball, clamped inside the right
   * inner edge, because a bubble that grew leftward from a blue pawn parked beside the player is
   * exactly what used to swallow the red ball's movement rings. Its keep-out set is the player's
   * ball plus that ball's four cardinal target rings, so no slot is taken until it is proven clear
   * of them. Either way `aimTail` re-points the wedge afterward: the tip still lands on this
   * token's crown, and for the rival that root sits on the bubble's bottom-left corner.
   */
  function place(side: Side, seat: Player) {
    const bubble = bubbles[side];
    const anchor = pawnAnchors[side];
    const laneBox = o.lane.getBoundingClientRect();
    const w = bubble.offsetWidth || 120;
    const h = bubble.offsetHeight || 32;
    const at = o.pawn(seat);
    let radius = 0;
    if (at) {
      anchor.style.left = `${at.x - laneBox.left}px`;
      anchor.style.top = `${at.y - laneBox.top}px`;
      bubbleTints[side] = at.color;
      radius = at.radius;
    } else {
      const chip = o.chips[seat];
      if (!chip) return;
      const chipBox = chip.getBoundingClientRect();
      anchor.style.left = `${chipBox.left + Math.min(30, chipBox.width / 2) - laneBox.left}px`;
      anchor.style.top = `${chipBox.top - laneBox.top}px`;
      for (const tint of TINTS) if (chip.classList.contains(tint)) bubbleTints[side] = tint;
    }
    for (const tint of TINTS) bubble.classList.toggle(`is-${tint}`, bubbleTints[side] === tint);
    const ax = Number.parseFloat(anchor.style.left) || 0;
    const ay = Number.parseFloat(anchor.style.top) || 0;
    const maxLeft = Math.max(LANE_EDGE_PX, laneBox.width - w - LANE_EDGE_PX);
    const maxTop = Math.max(LANE_EDGE_PX, laneBox.height - h - LANE_EDGE_PX);
    let left: number;
    let top: number;
    if (at) {
      const offset = Math.max(PAWN_OFFSET_MIN_PX, at.cell * PAWN_OFFSET_CELLS);
      const clear = Math.max(DOT_CLEAR_MIN_PX, at.cell * DOT_CLEAR_CELLS);
      /* the four legal-move dots sit one cell out on each axis; their halos are the keep-out
         circles the chassis must never enter */
      const dotBlockers: Array<readonly [number, number, number]> = [
        [ax, ay - at.cell, clear], [ax, ay + at.cell, clear],
        [ax - at.cell, ay, clear], [ax + at.cell, ay, clear],
      ];
      /** Does the box touch a keep-out disc? Measured to the nearest point of the rect. */
      const hits = (
        l: number, t: number, blockers: ReadonlyArray<readonly [number, number, number]>,
      ): boolean => {
        for (const [cx, cy, rad] of blockers) {
          const nx = clamp(cx, l, l + w);
          const ny = clamp(cy, t, t + h);
          if ((nx - cx) ** 2 + (ny - cy) ** 2 < rad * rad) return true;
        }
        return false;
      };
      const fits = (l: number, t: number): boolean => l >= LANE_EDGE_PX && t >= LANE_EDGE_PX
        && l + w <= laneBox.width - LANE_EDGE_PX && t + h <= laneBox.height - LANE_EDGE_PX;
      if (side === 'foe') {
        /* RIGHT FLANK: the rival's line opens over the right side of its own ball. The player's
           ball and its four cardinal target rings are the keep-out set, so the lane the player is
           about to tap can never be covered, however close the two tokens stand. */
        const player = o.pawn(o.localSide());
        const blockers: Array<readonly [number, number, number]> = [];
        let cluster: { top: number; right: number } | null = null;
        if (player && seat !== o.localSide()) {
          const px = player.x - laneBox.left;
          const py = player.y - laneBox.top;
          const ring = Math.max(DOT_CLEAR_MIN_PX, player.cell * DOT_CLEAR_CELLS);
          const skin = player.radius + FOE_KEEPOUT_GAP_PX;
          blockers.push([px, py, skin]);
          blockers.push(
            [px, py - player.cell, ring], [px, py + player.cell, ring],
            [px - player.cell, py, ring], [px + player.cell, py, ring],
          );
          const pad = Math.max(ring, skin);
          cluster = { top: py - player.cell - pad, right: px + player.cell + pad };
        }
        const lift = Math.max(FOE_LIFT_MIN_PX, at.cell * FOE_LIFT_CELLS);
        /* the left edge starts at the ball's centre-left, so the body grows rightward and the tail
           root comes to rest on the bubble's bottom-left corner, alongside the blue pawn */
        const openRight = clamp(ax - FOE_LEFT_OVERHANG_PX, LANE_EDGE_PX, maxLeft);
        const above = clamp(ay - lift - h, LANE_EDGE_PX, maxTop);
        const clearAbove = clamp(
          cluster ? cluster.top - FOE_CLUSTER_GAP_PX - h : above, LANE_EDGE_PX, maxTop,
        );
        const rightOfCluster = cluster
          ? clamp(cluster.right + FOE_CLUSTER_GAP_PX, LANE_EDGE_PX, maxLeft)
          : openRight;
        const candidates: Array<[number, number]> = [
          [openRight, above],
          [openRight, clearAbove],
          [rightOfCluster, above],
          [rightOfCluster, clearAbove],
          [maxLeft, above],
          [maxLeft, clearAbove],
        ];
        const pick = candidates.find(([l, t]) => !hits(l, t, blockers));
        if (pick) {
          left = pick[0];
          top = pick[1];
        } else {
          /* a cramped board with the two tokens touching: stand the box off above the cluster; the
             aimed tail still points down onto the blue pawn */
          left = openRight;
          top = clamp(Math.min(above, clearAbove), LANE_EDGE_PX, maxTop);
        }
      } else {
        /* The local player's line parks in the quadrant nearest its ball — north-west first, the
           corner the board was always read from. Taking the next corner when an edge is in the way
           keeps the box off the token — and off the pawn parked beside it — instead of clamping the
           bubble back onto the cluster. */
        const corners: Array<[number, number]> = [
          [ax - offset - w, ay - offset - h],
          [ax + offset, ay - offset - h],
          [ax - offset - w, ay + offset],
          [ax + offset, ay + offset],
        ];
        const clean = corners.find(([l, t]) => fits(l, t) && !hits(l, t, dotBlockers));
        if (clean) {
          left = clean[0];
          top = clean[1];
        } else {
          left = clamp(ax - offset - w, LANE_EDGE_PX, maxLeft);
          top = clamp(ay - offset - h, LANE_EDGE_PX, maxTop);
          if (hits(left, top, dotBlockers)) {
            /* an edge clamp pushed the bubble back toward the pawn: lift it clear above the up dot,
               or, when the top edge is already there, slide it clear of the left, down and right */
            const above = clamp(ay - at.cell - clear - h, LANE_EDGE_PX, maxTop);
            const below = clamp(ay + at.cell + clear, LANE_EDGE_PX, maxTop);
            const leftOf = clamp(ax - at.cell - clear - w, LANE_EDGE_PX, maxLeft);
            const rightOf = clamp(ax + at.cell + clear, LANE_EDGE_PX, maxLeft);
            const candidates = [
              { left, top: above },
              { left: leftOf, top },
              { left: leftOf, top: above },
              { left, top: below },
              { left: rightOf, top },
              { left: rightOf, top: above },
            ];
            for (const c of candidates) {
              if (!hits(c.left, c.top, dotBlockers)) { left = c.left; top = c.top; break; }
            }
          }
        }
      }
    } else {
      const foot = ay - CHIP_GAP_PX;
      left = clamp(ax - w / 2, LANE_EDGE_PX, maxLeft);
      top = clamp(foot - h, LANE_EDGE_PX, maxTop);
    }
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    aimTail(side, left, top, w, h, ax, ay, radius);
  }

  /**
   * Aim the tail at the sender's token and at nothing else. Its root is the point of the face
   * closest to the pawn, pulled inside the rounded corners; its tip stops on that token's crown —
   * `radius + 4` from the centre — on the straight line between the two. Both are recomputed from
   * the pawn *after* the box is clamped, so an edge that slides the bubble sideways moves the root
   * along the face and re-angles the wedge rather than letting the tip drift onto a neighbour. The
   * root doubles as the pop's hinge, so the bubble still grows out of the point facing its sender.
   */
  function aimTail(
    side: Side, left: number, top: number, w: number, h: number,
    px: number, py: number, radius: number,
  ) {
    const bubble = bubbles[side];
    /* A floating emote has no chassis to hang a pointer from: never arm the wedge, so no box or
       tail can appear behind the sticker. Reset the hinge to its centre as well — a previous text
       message may have left an inline transform-origin on this same reused node. chat.css also
       forces the tail off for .is-emote as a second line of defence. */
    if (bubble.classList.contains('is-emote')) {
      bubble.classList.remove('has-tail');
      bubble.style.transformOrigin = '50% 50%';
      return;
    }
    const inset = Math.min(TAIL_FACE_INSET_PX, w / 2, h / 2);
    const dx = px - clamp(px, left + inset, left + w - inset);
    const dy = py - clamp(py, top + inset, top + h - inset);
    const len = Math.hypot(dx, dy) - radius - TAIL_TIP_GAP_PX;
    if (len < TAIL_MIN_PX) {
      /* the face is already on the token: a wedge here would point through the ball it names */
      bubble.classList.remove('has-tail');
      return;
    }
    const rx = (px - dx - left).toFixed(2);
    const ry = (py - dy - top).toFixed(2);
    bubble.style.setProperty('--tail-x', `${rx}px`);
    bubble.style.setProperty('--tail-y', `${ry}px`);
    bubble.style.setProperty('--tail-len', `${Math.min(len, TAIL_MAX_PX).toFixed(2)}px`);
    /* the wedge is drawn pointing down; swinging the down vector onto (dx, dy) is atan2(-dx, dy) */
    bubble.style.setProperty('--tail-rot', `${(Math.atan2(-dx, dy) * (180 / Math.PI)).toFixed(2)}deg`);
    bubble.style.transformOrigin = `${rx}px ${ry}px`;
    bubble.classList.add('has-tail');
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

  /** Whose pawn a rival bubble belongs over: the seat the wire named, else the first rival chip. */
  function senderSeat(from?: Player): Player {
    return from !== undefined && o.chips[from] ? from : rivalSide();
  }

  function setBubble(side: Side, content: Node, emote = false, lang: ChatLang = 'EN', from?: Player, vip = false) {
    if (side === 'foe' && (muted || o.silent?.())) return;
    const node = bubbles[side];
    const seat = side === 'me' ? o.localSide() : senderSeat(from);
    bubbleSeats[side] = seat;
    window.clearTimeout(bubbleTimers[side]);
    node.classList.remove('is-out');     // a new message cancels a fade in flight
    node.classList.toggle('is-emote', emote);
    /* a VIP free-text line wears gold and reads in its own direction; a closed phrase keeps the
       tongue it was tapped in — a Persian one needs `rtl`, or its closing mark is thrown to the
       far edge of the sentence instead of ending it */
    node.classList.toggle('is-vip', vip);
    const text = bubbleText[side];
    text.dir = vip ? 'auto' : (lang === 'FA' ? 'rtl' : 'ltr');
    text.classList.toggle('is-rtl', !vip && lang === 'FA');
    text.replaceChildren(content);
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
  function inboundEmote(id: ChatEmoteId, seat?: Player): void {
    if (!o.live() || muted || o.silent?.()) return;
    const emote = EMOTES.find((e) => e.id === id);
    if (!emote) return;
    if (id === 'laugh') playLaugh();
    else if (id === 'fury') playAngrySound();
    setBubble('foe', emoteNode(emote), true, 'EN', seat);
  }

  /**
   * The rival's phrase, arrived over the wire: their `(lang, index)` pair is looked back up in the
   * same closed table — no text ever crosses the socket — and popped over their pawn, in the tongue
   * *they* chose. A muted opponent is as silent as they are invisible, so the whole call is dropped
   * while muted.
   */
  function inboundPhrase(lang: ChatLang, index: number, seat?: Player): void {
    if (!o.live() || muted || o.silent?.()) return;
    const line = phraseLine(lang, index);
    if (!line) return;
    setBubble('foe', document.createTextNode(line), false, lang, seat);
  }

  /**
   * A VIP rival's free-text line, arrived over the wire: popped over their pawn in its own
   * direction, wearing gold only when the room vouched for the sender's entitlement. A muted
   * opponent is as silent as they are invisible, so the whole call is dropped while muted.
   */
  function inboundCustom(text: string, seat?: Player, vip = false): void {
    if (!o.live() || muted || o.silent?.()) return;
    const clean = clipCustom(text);
    if (!clean) return;
    setBubble('foe', document.createTextNode(clean), false, 'EN', seat, vip);
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
  /* ---- the VIP free-text composer ----
     An entitled seat gets a 40-character field and a send key; a free seat sees the same row
     behind a locked door that opens the store instead of a keyboard. The preset tiles above stay
     available to everyone — custom text is the thing VIP buys. */
  const custom = el('div', 'chat-custom');
  const customForm = el('form', 'chat-custom-form');
  customForm.noValidate = true;
  const customInput = el('input', 'chat-input');
  customInput.type = 'text';
  customInput.maxLength = CUSTOM_MAX;
  customInput.autocomplete = 'off';
  customInput.setAttribute('enterkeyhint', 'send');
  customInput.dir = 'auto';
  const customSend = el('button', 'chat-send');
  customSend.type = 'submit';
  customSend.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-send" /></svg>';
  customForm.append(customInput, customSend);
  const customGate = el('button', 'chat-custom-gate');
  customGate.type = 'button';
  customGate.innerHTML =
    '<svg class="ico chat-custom-crown" aria-hidden="true"><use href="#i-crown" /></svg>'
    + '<span class="chat-custom-gate-t"></span>'
    + '<span class="chat-custom-vip" aria-hidden="true">VIP</span>'
    + '<span class="chat-custom-lock" aria-hidden="true"><svg class="ico"><use href="#i-lock" /></svg></span>';
  const customGateT = customGate.querySelector('.chat-custom-gate-t') as HTMLElement;
  custom.append(customForm, customGate);
  body.append(emoteRow, phraseList, custom);

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

  const canChat = (): boolean => o.live() && !o.busy() && !o.silent?.();
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
    setBubble('me', document.createTextNode(line), false, activeChatLang);
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

  /* ---------- the VIP free-text composer ---------- */

  /** The composer's entitlement face: a live field for a VIP, a locked door for a free seat. */
  function paintCustomVip() {
    const vip = isPremiumUser();
    customForm.hidden = !vip;
    customGate.hidden = vip;
    custom.classList.toggle('is-vip', vip);
  }

  function paintCustomCopy() {
    customInput.placeholder = t('banterPlaceholder');
    customInput.setAttribute('aria-label', t('banterInputLabel'));
    customSend.setAttribute('aria-label', t('banterSendLabel'));
    customGateT.textContent = t('banterCustomLocked');
    customGate.setAttribute('aria-label', t('banterCustomLockedAria'));
  }

  /** After a successful unlock the same seat lands in the live field, one tap from the wire. */
  function unlockCustom() {
    paintCustomVip();
    paintCustomCopy();
    if (sheetOpen && canChat()) customInput.focus({ preventScroll: true });
  }

  /**
   * A typed line: sanitized and clamped, popped over the local pawn in gold, and handed to the
   * wire. The room judges the entitlement again on its side, so a free seat that hand-rolls a
   * frame never reaches a rival — the client gate is the courtesy, the server gate is the law.
   */
  function sendCustom(raw: string) {
    if (!canChat() || isCooling()) return;
    if (!isPremiumUser()) {
      notify('warning');
      openVipSheet({ reason: 'gate', onUnlocked: unlockCustom });
      return;
    }
    const text = clipCustom(raw);
    if (!text) return;
    lastSentAt = Date.now();
    impact('light');
    setBubble('me', document.createTextNode(text), false, activeChatLang, undefined, true);
    o.onCustom?.(text);
    customInput.value = '';
    closeSheet(false);
    paintCool();
  }

  customForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendCustom(customInput.value);
  });
  customGate.addEventListener('click', () => {
    if (!canChat()) return;
    notify('warning');
    openVipSheet({ reason: 'gate', onUnlocked: unlockCustom });
  });

  /** The machine's side — one line, eight seconds apart, silence while muted. */
  function botSay(line: string, now: number) {
    if (muted || !o.live() || o.silent?.()) return;
    if (now - lastBotAt < BOT_GAP_MS) return;
    lastBotAt = now;
    setBubble('foe', document.createTextNode(line), false, activeChatLang);
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
    customSend.disabled = cooling;
  }

  function paintMenu() {
    muteItem.textContent = muted ? 'Unmute' : 'Mute';
  }

  function openWheel() {
    if (sheetOpen || !canChat()) return;
    sheetOpen = true;
    closeMenu();
    paintCool();
    paintCustomVip();
    paintCustomCopy();
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
    customInput.blur();
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
    const off = !canChat();
    if (off === keyOff) return;
    keyOff = off;
    o.key.disabled = off;
  }

  function tick() {
    /* the lesson's silence is absolute: a line that landed before it started leaves too, and the
       unread ping never warms a key the player cannot press */
    if (o.silent?.()) {
      if (!bubbles.foe.hidden) hideBubble('foe');
      o.key.classList.remove('is-ping');
    }
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
  paintCustomVip();
  paintCustomCopy();
  /* a pass bought mid-race (or a language flip) repaints the composer without reopening the sheet */
  const offVip = onVipChange(() => {
    if (!sheetOpen) return;
    paintCustomVip();
    paintCustomCopy();
  });
  const offLang = onLang(() => {
    if (!sheetOpen) return;
    paintCustomCopy();
  });
  const watcher = window.setInterval(tick, POLL_MS);

  return {
    inboundEmote,
    inboundPhrase,
    inboundCustom,
    destroy() {
      window.clearInterval(watcher);
      offVip();
      offLang();
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
