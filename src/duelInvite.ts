/**
 * duelInvite.ts — the challenge the result capsule throws, and the door it opens for the rival.
 *
 * A win is only worth saying out loud if somebody answers it. So the result capsule's flex key stops
 * sharing the app and starts sharing a *seat*: it mints a room code, holds the challenger's chair
 * inside it, and hands out a link that lands the rival in that room and nowhere else
 * (`?startapp=duel_<code>`). The room is the friends lobby `gamemodes.ts` already runs — the duel
 * format's two seats, the worker's idle window, the countdown that fires the instant both chairs are
 * human — so a challenge adds no second matchmaking path, no second socket and no new server code.
 *
 * The two halves are deliberately asymmetric:
 *
 *  - the challenger taps, Telegram's own recipient picker opens over one of the taunt lines in
 *    `settings.ts`, and the lobby they come back to names what it is waiting for;
 *  - the rival taps and meets the duel before anything else: a veil over Home, one headline, one
 *    key. Accepting *is* the join — no seat is taken while the player has not agreed to play, which
 *    also holds the host's countdown until they do.
 *
 * The taunt's `{name}` is the sender's own face and `{tiq}` the number the HUD already prints, so a
 * challenge never claims a standing its author does not have. Nothing is ever interpolated into
 * markup: every line lands through `textContent`.
 */
import './duelinvite.css';
import { createRoomCode, getGameMode, openInviteRoom, setLobbyHint } from './gamemodes';
import { duelTaunts, motionReduced, t } from './settings';
import { duelShareUrl, impact, inviteDuelCode, notify, openTelegramShare, tgUser } from './telegram';
import { myTiq } from './matchmaking';
import { showToast } from './toast';
import type { Lobby } from './lobby';

/** The duel this device threw and is still waiting on, or '' while no challenge is armed. */
let armedCode = '';
/** True while the armed duel's rival seat is still empty — the toast fires on the way up, never twice. */
let armedRivalWaiting = false;
/** The veil this device is showing, and the room it is offering. */
let veil: HTMLElement | null = null;
let veilCode = '';

/**
 * An automated run never meets the veil: no node, no timer, no tap it cannot make. The same
 * contract `vsclash.ts` keeps, so a browser suite drives straight into the room.
 */
function bypassed(): boolean {
  if (typeof navigator !== 'undefined' && navigator.webdriver === true) return true;
  return document.documentElement.hasAttribute('data-txs-skip');
}

const el = (tag: string, cls: string, parent?: HTMLElement): HTMLElement => {
  const node = document.createElement(tag);
  node.className = cls;
  if (parent) parent.appendChild(node);
  return node;
};

const glyph = (id: string, parent: HTMLElement): void => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'dv-ico');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  parent.appendChild(svg);
};

/** A span carrying one line of copy — `textContent` only, so nothing that lands here can be markup. */
const text = (value: string, parent: HTMLElement): void => {
  const node = document.createElement('span');
  node.textContent = value;
  parent.appendChild(node);
};

/** The face the challenge is signed with: the same name the roster and the HUD print. */
export function senderName(): string {
  const u = tgUser();
  const name = (u?.first_name ?? '').trim() || (u?.username ?? '').trim();
  return name || t('you');
}

/** One taunt line, filled in. Random by design: the same taunt twice in a row reads as a script. */
function tauntLine(): string {
  const pool = duelTaunts();
  const raw = pool[Math.floor(Math.random() * pool.length)] ?? '';
  return raw.replace(/\{name\}/g, senderName()).replace(/\{tiq\}/g, String(myTiq()));
}

/**
 * How a duel is thrown. The room, the armed seat and the waiting lobby are one path for every
 * challenge; a caller that hands out a different link or a different line still reuses them, so a
 * second surface can never orphan a challenge already sitting in a friend's chat.
 */
export interface DuelThrow {
  /** The share link for this room. Defaults to the post-race `duel_<code>` door. */
  link?: (code: string, text: string) => string;
  /** The line the challenge is signed with. Defaults to a random taunt. */
  text?: string;
  /** What the lobby says while the rival seat stays empty. */
  waiting?: string;
  /** What the challenger is told once the link has left the device. */
  armed?: string;
}

/**
 * Throw the duel: hold the seat, arm the lobby's waiting caption, hand the link to Telegram's own
 * picker. False when there is no room to invite anybody to, which leaves the player where they were.
 */
export function throwDuelChallenge(over?: DuelThrow): boolean {
  /* A duel already armed on this device is reused, not replaced: a link that has already landed in a
     friend's chat must not die because the challenger tapped the key twice. The selection is what
     says whether that room still stands — leaving it, or launching it into a race, clears it. */
  const code = armedCode && getGameMode().roomCode === armedCode ? armedCode : createRoomCode();
  const url = (over?.link ?? duelShareUrl)(code, over?.text || tauntLine());
  if (!url) return false;
  /* The chair exists before the link leaves the device: a rival who taps twenty seconds later lands
     on a room that is already holding its host, not on a code nobody opened. */
  if (!openInviteRoom(code)) return false;
  armedCode = code;
  armedRivalWaiting = true;
  setLobbyHint(over?.waiting || t('duelWaitingRival'));
  openTelegramShare(url);
  showToast(over?.armed || t('duelArmed'), 'success');
  return true;
}

/** The veil is over: the room it offered is either taken or refused, and a board must not start under it. */
export function dismissDuelVeil(): void {
  if (!veil) return;
  veil.remove();
  veil = null;
  veilCode = '';
}

/**
 * Accept: join the challenged room. The drawer, the roster and the countdown are the lobby's own,
 * and so is every answer it gives — seated, full, expired. The veil steps out before the join for
 * exactly that reason: an offer still standing on screen would cover the line that explains itself.
 */
function acceptDuel(): void {
  const code = veilCode;
  impact('heavy');
  notify('success');
  dismissDuelVeil();
  if (code) openInviteRoom(code);
}

function buildVeil(code: string): void {
  veilCode = code;
  const host = el('div', 'dv');
  host.id = 'duel-veil';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-labelledby', 'dv-title');
  if (motionReduced()) host.classList.add('is-quiet');

  const card = el('div', 'dv-card', host);
  const kicker = el('p', 'dv-kicker', card);
  glyph('i-swords', kicker);
  text(t('duelKicker'), kicker);

  const title = el('h2', 'dv-title', card);
  title.id = 'dv-title';
  title.textContent = t('duelChallenged');
  el('p', 'dv-sub', card).textContent = t('duelSub');
  el('p', 'dv-room', card).textContent = t('modeRoomCode').replace('{code}', code);

  const accept = document.createElement('button');
  accept.className = 'dv-accept';
  accept.type = 'button';
  glyph('i-swords', accept);
  text(t('duelAccept'), accept);
  accept.addEventListener('click', acceptDuel);
  card.appendChild(accept);

  /* the backdrop is the polite way out: a player who is not in the mood for a duel leaves with a
     tap, and the room they never joined stays the challenger's own affair */
  host.addEventListener('click', (e) => { if (e.target === host) dismissDuelVeil(); });

  document.body.appendChild(host);
  veil = host;
  requestAnimationFrame(() => host.classList.add('is-in'));
  accept.focus({ preventScroll: true });
}

/**
 * The rival's door: a `duel_` payload greets the player with the duel instead of dropping them into
 * a lobby they have to read. False when this launch carries no challenge, which leaves the plain
 * room invite (`room_`) to the door that already handles it.
 */
export function openDuelDoor(): boolean {
  if (veil) return true;
  const code = inviteDuelCode();
  if (!code) return false;
  /* a headless run answers the challenge for you and goes straight in */
  if (bypassed()) return openInviteRoom(code);
  buildVeil(code);
  return true;
}

/**
 * Every repaint of a live roster, from the lobby. The armed challenger uses it for one thing: the
 * moment the challenged seat fills, the wait is over and the duel is on.
 */
export function noteDuelLobby(l: Lobby): void {
  if (!armedCode || !armedRivalWaiting || l.code !== armedCode) return;
  if (l.seats.some((s) => !!s && !s.bot && s.seat !== l.you)) {
    armedRivalWaiting = false;
    showToast(t('duelAccepted'), 'success');
    notify('success');
  }
}
