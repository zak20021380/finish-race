/**
 * gamemodes.ts — Game Mode Selector: lobby state, bottom sheet wiring, custom rooms.
 *
 * The lobby stays clean: one tappable clay card (icon · title · status dot ·
 * short subtitle) that opens the drawer. The
 * `#sheet-game-modes` drawer holds exactly three rows — Quick match, Play with
 * friends and Practice vs Bot — plus one reward caption and one sticky Start.
 * Selecting a mode updates the lobby instantly and persists to the device; the
 * row that is open shows its options in place (1v1/2v2 or Easy/Normal/Hard).
 * 1v1 is the default: the 2v2 key ships disabled behind a "Soon" badge until
 * party matchmaking lands, so a stored party pick falls back to the duel.
 * The room UI lives on its own sub-screen behind a back arrow, never in the list.
 *
 * Rooms are local-first: Create mints a 4-digit code and reveals a 1-tap
 * "Invite via Telegram" deep-link (`t.me/<bot>?start=room_XXXX`). Join validates
 * a 4-digit code. Online races still start as local bot races with matching
 * sizes until netplay lands — the lobby is the contract, the starter is a stub.
 */
import { readJson, writeJson } from './storage';
import { menuState, saveMenu } from './settings';
import { BOT_HANDLE, impact, notify } from './telegram';
import type { Sheets } from './sheets';
import {
  MODE_LINE, canStart, isHost, occupied, openLobby,
  type Lobby, type LobbyHandle, type LobbyMode, type LobbyRace,
} from './lobby';

export type GameModeId = 'duel_1v1' | 'party_2v2' | 'bot' | 'room';

export interface GameModeSelection {
  id: GameModeId;
  roomCode: string | null;
}

/** What the launcher's status dot is reporting: a live queue, a bot, or a private room. */
export type LobbyStatus = 'online' | 'practice' | 'private';

export interface LobbyDisplay {
  id: GameModeId;
  title: string;
  status: LobbyStatus;
  icon: string;
  sub: string;
}

const KEY = 'detour.gamemode.v1';

/** 1v1 is the door everyone walks through: 2v2 is still a teaser in the drawer. */
const DEFAULT_SELECTION: GameModeSelection = { id: 'duel_1v1', roomCode: null };

/* ---- what the sheet renders: the DOM stays declarative, the labels live here ---- */

type QuickId = 'duel_1v1' | 'party_2v2';
/** The three rows: `online` owns both quick sizes, `room` owns the sub-screen. */
type RowId = 'online' | 'room' | 'bot';
/** Which pane of the drawer is showing. */
type SheetView = 'modes' | 'room' | 'lobby';

const ROW_OF: Record<GameModeId, RowId> = {
  duel_1v1: 'online',
  party_2v2: 'online',
  room: 'room',
  bot: 'bot',
};

/** Estimated matchmaking wait, shown beside the size segment. */
const WAIT: Record<QuickId, string> = { duel_1v1: '~5s', party_2v2: '~8s' };

const START_LABEL: Record<GameModeId, string> = {
  duel_1v1: 'Start 1v1 match',
  party_2v2: 'Start 2v2 match',
  bot: 'Start practice match',
  room: 'Start private match',
};

interface RewardLine {
  lead: string;
  /** `null` when the mode pays no trophies — practice has no ranking to lose. */
  trophy: string | null;
  coin: string;
}

const REWARD: Record<GameModeId, RewardLine> = {
  duel_1v1: { lead: 'Win', trophy: '+30', coin: '+65' },
  party_2v2: { lead: 'Win', trophy: '+50', coin: '+100' },
  bot: { lead: 'Practice', trophy: null, coin: '+65' },
  room: { lead: 'Win', trophy: '+30', coin: '+65' },
};

const isQuick = (id: GameModeId): id is QuickId => id === 'duel_1v1' || id === 'party_2v2';

function isGameModeId(v: unknown): v is GameModeId {
  return v === 'duel_1v1' || v === 'party_2v2' || v === 'bot' || v === 'room';
}

function cleanRoomCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const digits = v.replace(/\D/g, '').slice(0, 4);
  return /^\d{4}$/.test(digits) ? digits : null;
}

function load(): GameModeSelection {
  try {
    const raw = readJson<GameModeSelection>(KEY);
    if (!raw || !isGameModeId(raw.id)) return { ...DEFAULT_SELECTION };
    /* 2v2 is parked behind a disabled key for now: land the old pick on 1v1 */
    const id: GameModeId = raw.id === 'party_2v2' ? 'duel_1v1' : raw.id;
    const roomCode = id === 'room' ? cleanRoomCode(raw.roomCode) : null;
    return { id, roomCode };
  } catch {
    return { ...DEFAULT_SELECTION };
  }
}

let current: GameModeSelection = load();
/** The drawer opens on the list every time; the friends pane is a step away. */
let view: SheetView = 'modes';

const watchers: Array<() => void> = [];

function persist(): void {
  try {
    writeJson(KEY, current);
  } catch {
    /* stay in memory */
  }
  for (const w of [...watchers]) {
    try {
      w();
    } catch {
      /* watcher threw */
    }
  }
}

export function onGameModeChange(w: () => void): () => void {
  watchers.push(w);
  return () => {
    const i = watchers.indexOf(w);
    if (i >= 0) watchers.splice(i, 1);
  };
}

export function getGameMode(): GameModeSelection {
  return { ...current };
}

/** Sizes the local race starter uses until online play arrives. */
export function sizesForMode(id: GameModeId): [number, number] {
  if (id === 'party_2v2') return [2, 2];
  return [1, 1];
}

export function setGameMode(id: GameModeId, opts?: { roomCode?: string | null }): GameModeSelection {
  const roomCode = id === 'room' ? cleanRoomCode(opts?.roomCode ?? current.roomCode) : null;
  current = { id, roomCode };
  try {
    saveMenu({ mode: 'bot', sizes: sizesForMode(id) });
  } catch {
    /* stay in memory */
  }
  persist();
  paintLobby();
  paintSheetState();
  return getGameMode();
}

export function getLobbyDisplay(sel: GameModeSelection = current): LobbyDisplay {
  switch (sel.id) {
    case 'duel_1v1':
      return { id: sel.id, title: '1v1 Duel', status: 'online', icon: '#i-swords', sub: 'Ranked · ~5s queue' };
    case 'party_2v2':
      return { id: sel.id, title: '2v2 Party', status: 'online', icon: '#i-users', sub: 'Ranked · ~8s queue' };
    case 'bot':
      return { id: sel.id, title: 'vs Bot', status: 'practice', icon: '#i-bot', sub: 'Offline Practice' };
    case 'room':
      return {
        id: sel.id,
        title: sel.roomCode ? `Room ${sel.roomCode}` : 'Custom Room',
        status: 'private',
        icon: '#i-send',
        sub: sel.roomCode ? 'Private · Friends only' : 'Private · Create or join',
      };
  }
}

/* ---------- rooms: mint, share, join ---------- */

export function createRoomCode(): string {
  const n = 1000 + Math.floor(Math.random() * 9000);
  return String(n);
}

/** Mint a fresh room code and select it. The lobby screen takes over from here. */
export function createRoom(): GameModeSelection {
  const code = createRoomCode();
  return setGameMode('room', { roomCode: code });
}

export function joinRoomCode(raw: string): { ok: true; code: string } | { ok: false; error: string } {
  const code = cleanRoomCode(raw);
  if (!code) return { ok: false, error: 'Enter the 4-digit room code.' };
  setGameMode('room', { roomCode: code });
  return { ok: true, code };
}

/** Display form: `t.me/bot?start=room_XXXX` shape (uses the app bot handle). */
export function buildInviteDisplay(code: string): string {
  return `t.me/${BOT_HANDLE}?start=room_${code}`;
}

/** Full URL the Invite button opens / shares. */
export function buildInviteLink(code: string): string {
  return `https://t.me/${BOT_HANDLE}?start=room_${code}`;
}

export function buildShareUrl(code: string): string {
  const url = encodeURIComponent(buildInviteLink(code));
  const text = encodeURIComponent(`Join my Detour room ${code} — 1 tap to race!`);
  return `https://t.me/share/url?url=${url}&text=${text}`;
}

function openInvite(code: string): void {
  const href = buildInviteLink(code);
  try {
    const w = window as unknown as {
      Telegram?: { WebApp?: { openTelegramLink?: (u: string) => void; openLink?: (u: string) => void } };
    };
    const tg = w.Telegram?.WebApp;
    if (tg?.openTelegramLink) {
      tg.openTelegramLink(href);
      return;
    }
    if (tg?.openLink) {
      tg.openLink(buildShareUrl(code));
      return;
    }
  } catch {
    /* fall through to window.open */
  }
  try {
    window.open(buildShareUrl(code), '_blank', 'noopener');
  } catch {
    /* webview blocked — the code itself is still copyable */
  }
}

/** Clipboard write with a legacy fallback: the room invite and the referral hub share this door. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'true');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/* ---------- the home lobby card (same IDs home.ts owns) ---------- */

export function paintLobby(): void {
  const lobby = getLobbyDisplay();
  const card = document.getElementById('mode-hero');
  if (card) {
    card.setAttribute('data-gmode', lobby.id);
    card.setAttribute('aria-label', `Change game mode. Currently ${lobby.title} — ${lobby.sub}`);
  }
  const titleEl = document.getElementById('home-play-title');
  if (titleEl) titleEl.textContent = lobby.title;
  const dotEl = document.getElementById('mode-hero-dot');
  if (dotEl) dotEl.setAttribute('data-status', lobby.status);
  const useEl = document.getElementById('mode-hero-use') as unknown as SVGUseElement | null;
  if (useEl) useEl.setAttribute('href', lobby.icon);
  const subEl = document.getElementById('home-play-sub');
  if (subEl) subEl.textContent = lobby.sub;
  const play = document.getElementById('home-play') as HTMLButtonElement | null;
  if (play) play.setAttribute('aria-label', `Play ${lobby.title} — ${lobby.sub}`);
}

/* ---------- the lobby: one socket, one roster, one Start ---------- */

/** The lobby this screen is showing, or null outside one. */
let handle: LobbyHandle | null = null;
/** Bumped on every open/leave, so a late frame from a closed socket cannot repaint the new screen. */
let roomToken = 0;
/** The open well whose "+" was tapped: where the picker puts a bot. */
let pickSeat = -1;
/** What the last paint wrote into the grid. A rebuild only happens when this changes. */
let slotSig = '';
/** The drawer, kept module-level so a race arriving over the wire can close it. */
let sheetHost: Sheets | null = null;
/** The starter hooks, likewise: the socket callbacks outlive `initGameModes`. */
let hooks: GameModeInit = {};

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));

/** What the screen says when the server turns us away. One line each, no jargon. */
const LOBBY_ERROR: Record<string, string> = {
  room_not_found: 'No room with that code.',
  ROOM_NOT_FOUND: 'No room with that code.',
  room_full: 'That room is already full.',
  ROOM_FULL: 'That room is already full.',
  room_exists: 'That code is already open. Try joining it.',
  ROOM_EXISTS: 'That code is already open. Try joining it.',
  MAINTENANCE: 'Matchmaking is paused. Try again soon.',
  BANNED: 'This account cannot join rooms.',
};

const errorLine = (reason: string): string => LOBBY_ERROR[reason] ?? 'Could not join that room.';

/** One seat, as the grid paints it. Empty wells are the invite affordance. */
function slotMarkup(l: Lobby, seat: number): string {
  const s = l.seats[seat];
  if (!s) {
    return `<button class="lb-slot is-open" type="button" role="listitem" data-seat="${seat}"`
      + ` aria-label="Open seat ${seat + 1}: invite a friend">`
      + '<span class="lb-plus" aria-hidden="true">+</span>'
      + '<span class="lb-open-t">Invite</span></button>';
  }
  const role = s.host ? 'Host' : s.bot ? 'Bot' : s.seat === l.you ? 'You' : 'Ready';
  const team = s.team === 0 ? 'Blue' : 'Red';
  const tags = [
    s.host ? '<span class="lb-crown" role="img" aria-label="Host">👑</span>' : '',
    l.mode === 'team' ? `<span class="lb-team" data-team="${s.team}">${team}</span>` : '',
  ].filter(Boolean).join('');
  const cls = ['lb-slot', 'is-held'];
  if (s.host) cls.push('is-host');
  if (s.seat === l.you) cls.push('is-you');
  if (!s.connected) cls.push('is-away');
  /* the host can move any seat between the two teams: say so, or the pill looks decorative */
  const hint = l.mode === 'team' && isHost(l) ? ` title="Tap to switch ${esc(s.name)} to Team ${s.team === 0 ? 'Red' : 'Blue'}"` : '';
  const label = `${s.name}, ${role}${l.mode === 'team' ? `, Team ${team}` : ''}`;
  return `<button class="${cls.join(' ')}" type="button" role="listitem" data-seat="${seat}"`
    + ` aria-label="${esc(label)}"${hint}>`
    + `<span class="lb-av" aria-hidden="true">${esc(s.initial)}</span>`
    + `<span class="lb-slot-txt"><span class="lb-name">${esc(s.name)}</span>`
    + `<span class="lb-role">${role}</span></span>`
    + `<span class="lb-tags">${tags}</span></button>`;
}

/** Rebuild the grid only when the roster actually moved: a paint must never steal a tap. */
function paintSlots(l: Lobby): void {
  const sig = `${l.you}|${l.hostSeat}|${l.mode}|`
    + l.seats.map((s) => (s ? `${s.id}:${s.name}:${s.team}:${s.host}:${s.bot}:${s.connected}` : '-')).join(',');
  if (sig === slotSig) return;
  slotSig = sig;
  const grid = document.getElementById('lb-slots');
  if (!grid) return;
  grid.innerHTML = l.seats.map((_s, i) => slotMarkup(l, i)).join('');
}

/** Everything the lobby screen shows, from the value alone. */
function paintLobbyPane(l: Lobby): void {
  const codeEl = document.getElementById('lb-code');
  if (codeEl) codeEl.textContent = l.code;
  document.getElementById('lb-copy')?.setAttribute('aria-label', `Copy room code ${l.code}`);

  const count = document.getElementById('lb-count');
  if (count) count.textContent = `${occupied(l)}/${l.capacity} Players`;

  const host = isHost(l);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#lb-mode [data-mode]')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === l.mode));
    b.setAttribute('aria-disabled', String(!host));
    b.classList.toggle('is-locked', !host);
  }
  const sub = document.getElementById('lb-mode-sub');
  if (sub) sub.textContent = MODE_LINE[l.mode];

  paintSlots(l);

  const botKey = document.getElementById('lb-pick-bot');
  if (botKey) botKey.hidden = l.online;

  const start = document.getElementById('gm-start') as HTMLButtonElement | null;
  if (start) {
    start.textContent = host ? 'Start Match' : 'Waiting for host to start…';
    start.setAttribute('aria-disabled', String(!host || !canStart(l)));
    if (host && !canStart(l)) start.setAttribute('title', 'Need at least 2 players');
    else start.removeAttribute('title');
    start.classList.add('is-lobby');
    start.classList.toggle('is-waiting', !host);
    start.classList.toggle('is-idle', host && !canStart(l));
  }
}

/** Open a room's socket and land on the lobby. `host` mints the code; guests must be expected. */
function openRoom(code: string, host: boolean): void {
  const token = ++roomToken;
  handle?.leave();
  handle = null;
  slotSig = '';
  showView('lobby');
  handle = openLobby({
    code,
    host,
    onState: (l) => { if (token === roomToken) paintLobbyPane(l); },
    onRace: (race) => {
      if (token !== roomToken) return;
      /* the lobby's work is done: the board owns the socket from here */
      handle = null;
      roomToken++;
      sheetHost?.close();
      hooks.onRoomRace?.(race);
      setGameMode('room', { roomCode: null });
    },
    onError: (reason) => {
      if (token !== roomToken) return;
      handle = null;
      showView('room');
      showRoomError(errorLine(reason));
    },
  });
  handle.closed(() => {
    if (token !== roomToken) return;
    handle = null;
    showView('room');
    showRoomError('The room connection dropped. Try again.');
  });
}

/** Walk out of the lobby (the host's exit closes it for everyone). */
function leaveRoom(): void {
  roomToken++;
  handle?.leave();
  handle = null;
  slotSig = '';
  pickSeat = -1;
  const pick = document.getElementById('lb-pick');
  if (pick) pick.hidden = true;
  /* the lobby card goes back to "Custom Room": a code nobody is in is not a room */
  setGameMode('room', { roomCode: null });
}

function showPick(on: boolean): void {
  const el = document.getElementById('lb-pick');
  if (el) el.hidden = !on;
  if (!on) pickSeat = -1;
}

/* ---------- the drawer's panes ---------- */

/** Swap the drawer between the mode list, the friends entry and the live lobby. */
function showView(next: SheetView): void {
  view = next;
  const modes = document.getElementById('gm-view-modes');
  if (modes) modes.hidden = next !== 'modes';
  const room = document.getElementById('gm-view-room');
  if (room) room.hidden = next !== 'room';
  const lobbyEl = document.getElementById('gm-view-lobby');
  if (lobbyEl) lobbyEl.hidden = next !== 'lobby';
  const back = document.getElementById('gm-back');
  if (back) back.hidden = next === 'modes';
  const title = document.getElementById('gm-title');
  if (title) title.textContent = next === 'modes' ? 'Select Game Mode' : 'Play with Friends';
  const sub = document.getElementById('gm-sub');
  if (sub) {
    sub.textContent = next === 'modes' ? 'Pick how you want to race'
      : next === 'lobby' ? 'Invite friends, pick a format, start together'
      : 'Create a room or join with a code';
  }
  /* the entry pane owns its two actions; the foot belongs to the list and the lobby */
  const foot = document.getElementById('gm-foot');
  if (foot) foot.hidden = next === 'room';
  const rewards = document.getElementById('gm-rewards');
  if (rewards) rewards.hidden = next !== 'modes';
  const body = document.querySelector<HTMLElement>('.gm-body');
  if (body) body.scrollTop = 0;
  if (next === 'lobby' && handle) paintLobbyPane(handle.lobby);
  /* the list's Start label and its reward caption are written by `paintSheetState`, and the lobby
     borrowed the same key: coming back has to restore it, not leave "Start Match" behind */
  else if (next === 'modes') paintSheetState();
}

/** The drawer always opens on the three rows, never on a pane left behind. */
export function resetSheetView(): void {
  showView('modes');
}

/** Is a lobby still live? The friends row reopens it instead of starting a second one. */
function inLobby(): boolean {
  return !!handle && handle.lobby.status !== 'closed';
}

/**
 * One step of back: the lobby leaves the room, the friends pane returns to the list, and only then
 * does the drawer itself close. Returns false when there is nothing left to unwind here.
 */
export function gmBack(): boolean {
  const sheet = document.getElementById('sheet-game-modes');
  if (view === 'modes' || !sheet || sheet.hidden) return false;
  if (view === 'lobby') {
    leaveRoom();
    showView('room');
    return true;
  }
  showView('modes');
  return true;
}

export function paintSheetState(): void {
  const row = ROW_OF[current.id];

  for (const card of document.querySelectorAll<HTMLElement>('.gm-card[data-row]')) {
    const on = card.dataset.row === row;
    card.classList.toggle('is-active', on);
    card.querySelector<HTMLElement>('.gm-pick')?.setAttribute('aria-checked', String(on));
    /* the options for a mode only exist while that mode is the selected one */
    const seg = card.querySelector<HTMLElement>('.gm-seg');
    if (seg) seg.hidden = !on;
    /* the locked filters row rides with the quick-match options */
    const filters = card.querySelector<HTMLElement>('.gm-filters');
    if (filters) filters.hidden = !on;
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>('#sheet-game-modes [data-size]')) {
    b.setAttribute('aria-pressed', String(b.dataset.size === current.id));
  }
  const wait = document.getElementById('gm-wait');
  if (wait && isQuick(current.id)) wait.textContent = WAIT[current.id];

  for (const b of document.querySelectorAll<HTMLButtonElement>('#sheet-game-modes [data-diff]')) {
    b.setAttribute('aria-pressed', String(b.dataset.diff === menuState.difficulty));
  }

  /* one reward caption above Start, one Start label that names the mode */
  const reward = REWARD[current.id];
  const lead = document.getElementById('gm-lead');
  if (lead) lead.textContent = reward.lead;
  const trophy = document.getElementById('gm-rw-trophy');
  const trophyN = document.getElementById('gm-rw-trophy-n');
  if (trophy) {
    trophy.hidden = reward.trophy === null;
    if (reward.trophy) {
      if (trophyN) trophyN.textContent = reward.trophy;
      trophy.setAttribute('aria-label', `${reward.trophy.replace('+', '')} trophies`);
    }
  }
  const coinN = document.getElementById('gm-rw-coin-n');
  if (coinN) {
    coinN.textContent = reward.coin;
    coinN.closest('.gm-rw')?.setAttribute('aria-label', `${reward.coin.replace('+', '')} coins`);
  }
  /* the lobby owns the Start key while it is on screen: it must not be renamed out from under it */
  const start = document.getElementById('gm-start');
  if (start && view === 'modes') {
    start.textContent = START_LABEL[current.id];
    start.removeAttribute('aria-disabled');
    start.removeAttribute('title');
    start.classList.remove('is-lobby', 'is-idle', 'is-waiting');
  }
  if (view === 'lobby' && handle) paintLobbyPane(handle.lobby);
}

function showRoomError(msg: string): void {
  const el = document.getElementById('gm-err');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  notify('warning');
}

function clearRoomError(): void {
  const el = document.getElementById('gm-err');
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
}

/* ---------- wiring ---------- */

export interface GameModeInit {
  /** Starts a race with the sizes + difficulty the drawer just persisted. */
  onStart?: () => void;
  /** The host pressed Start in a lobby with no server behind it: play that roster locally. */
  onRoomStart?: (lobby: Lobby) => void;
  /** A synced room launched: the worker's race goes on the board. */
  onRoomRace?: (race: LobbyRace) => void;
}

export function initGameModes(sheets: Sheets, init?: GameModeInit): void {
  sheetHost = sheets;
  hooks = init ?? {};
  paintLobby();
  paintSheetState();
  showView('modes');

  /* rows: quick + practice select in place, friends open their own sub-screen */
  for (const pick of document.querySelectorAll<HTMLButtonElement>('.gm-pick[data-gmode]')) {
    pick.addEventListener('click', () => {
      const raw = pick.dataset.gmode;
      if (!isGameModeId(raw)) return;
      impact('light');
      if (raw === 'room') { showView(inLobby() ? 'lobby' : 'room'); return; }
      clearRoomError();
      setGameMode(raw);
    });
  }

  document.getElementById('gm-back')?.addEventListener('click', () => {
    impact('light');
    if (view === 'lobby') { leaveRoom(); showView('room'); return; }
    showView('modes');
  });

  /* in-row options: the size for Quick match, the level for Practice vs Bot */
  for (const b of document.querySelectorAll<HTMLButtonElement>('#sheet-game-modes [data-size]')) {
    b.addEventListener('click', () => {
      const raw = b.dataset.size;
      if (!isGameModeId(raw) || raw === 'room') return;
      impact('light');
      if (raw === current.id) return;
      clearRoomError();
      setGameMode(raw);
    });
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>('#sheet-game-modes [data-diff]')) {
    b.addEventListener('click', () => {
      const d = b.dataset.diff;
      if (d !== 'easy' && d !== 'normal' && d !== 'hard') return;
      impact('light');
      try {
        saveMenu({ difficulty: d });
      } catch {
        /* stay in memory */
      }
      paintSheetState();
    });
  }

  /* the locked filters row: a wiggle and a toast, never a queue change */
  const filters = document.getElementById('gm-filters') as HTMLButtonElement | null;
  const tip = filters?.querySelector<HTMLElement>('.gm-f-tip') ?? null;
  let tipTimer = 0;
  filters?.addEventListener('click', () => {
    impact('light');
    notify('warning');
    filters.classList.remove('shake');
    void filters.offsetWidth; /* restart the wiggle */
    filters.classList.add('shake');
    if (tip) {
      tip.hidden = false;
      void tip.offsetWidth;
      tip.classList.add('on');
    }
    window.clearTimeout(tipTimer);
    tipTimer = window.setTimeout(() => {
      if (tip) {
        tip.classList.remove('on');
        window.setTimeout(() => {
          tip.hidden = true;
        }, 200);
      }
    }, 1600);
  });
  filters?.addEventListener('animationend', () => {
    filters.classList.remove('shake');
  });

  /* ---- entry: create mints a code and walks straight into the lobby ---- */
  document.getElementById('gm-create')?.addEventListener('click', () => {
    impact('medium');
    clearRoomError();
    const sel = createRoom();
    notify('success');
    openRoom(sel.roomCode ?? createRoomCode(), true);
  });

  const joinInput = document.getElementById('gm-join-input') as HTMLInputElement | null;
  const joinBtn = document.getElementById('gm-join') as HTMLButtonElement | null;
  /** Join only lights up once the field holds a full 4-digit code. */
  const syncJoin = (): void => {
    if (!joinBtn) return;
    joinBtn.disabled = (joinInput?.value ?? '').replace(/\D/g, '').length !== 4;
  };
  syncJoin();

  const doJoin = (): void => {
    const input = joinInput;
    if (!input) return;
    const res = joinRoomCode(input.value);
    if (!res.ok) {
      impact('light');
      showRoomError(res.error);
      input.focus({ preventScroll: true });
      return;
    }
    impact('medium');
    clearRoomError();
    openRoom(res.code, false);
  };

  document.getElementById('gm-join')?.addEventListener('click', doJoin);
  joinInput?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    doJoin();
  });
  joinInput?.addEventListener('input', () => {
    clearRoomError();
    if (joinInput) joinInput.value = joinInput.value.replace(/\D/g, '').slice(0, 4);
    syncJoin();
  });

  /* ---- lobby: the code bar ---- */
  document.getElementById('lb-copy')?.addEventListener('click', async () => {
    const code = handle?.lobby.code;
    if (!code) return;
    impact('light');
    const ok = await copyText(buildInviteLink(code));
    notify(ok ? 'success' : 'warning');
    if (!ok) return;
    const t = document.getElementById('lb-copy-t');
    const btn = document.getElementById('lb-copy');
    if (!t || !btn) return;
    t.textContent = 'Copied! ✓';
    btn.classList.add('is-copied');
    window.setTimeout(() => {
      if (t.textContent !== 'Copied! ✓') return;
      t.textContent = 'Copy';
      btn.classList.remove('is-copied');
    }, 1400);
  });

  const invite = (): void => {
    const code = handle?.lobby.code;
    if (!code) return;
    impact('light');
    openInvite(code);
  };
  document.getElementById('lb-invite')?.addEventListener('click', invite);
  document.getElementById('lb-pick-invite')?.addEventListener('click', () => { showPick(false); invite(); });

  /* ---- lobby: the host's format switch (a guest's copy is view-only) ---- */
  for (const b of document.querySelectorAll<HTMLButtonElement>('#lb-mode [data-mode]')) {
    b.addEventListener('click', () => {
      const l = handle?.lobby;
      if (!l) return;
      if (!isHost(l)) { notify('warning'); return; }
      const mode: LobbyMode = b.dataset.mode === 'team' ? 'team' : 'ffa';
      if (mode === l.mode) return;
      impact('light');
      handle?.setMode(mode);
    });
  }

  /* ---- lobby: seats. An open well invites; a held one flips teams (host, 2v2 only) ---- */
  document.getElementById('lb-slots')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('.lb-slot');
    const l = handle?.lobby;
    if (!btn || !l) return;
    const seat = Number(btn.dataset.seat);
    if (!Number.isInteger(seat)) return;
    const s = l.seats[seat];
    if (!s) {
      pickSeat = seat;
      showPick(true);
      impact('light');
      return;
    }
    if (l.mode === 'team' && isHost(l)) {
      impact('light');
      handle?.setTeam(seat, s.team === 0 ? 1 : 0);
    }
  });

  document.getElementById('lb-pick-bot')?.addEventListener('click', () => {
    if (pickSeat < 0) return;
    impact('medium');
    handle?.addBot(pickSeat);
    showPick(false);
  });

  document.getElementById('lb-leave')?.addEventListener('click', () => {
    impact('light');
    leaveRoom();
    showView('room');
  });

  /* the sticky Start: the lobby's own key while the lobby is up, the mode's otherwise */
  document.getElementById('gm-start')?.addEventListener('click', () => {
    if (view === 'lobby') {
      const l = handle?.lobby;
      if (!l) return;
      if (!isHost(l)) { notify('warning'); return; }
      if (!canStart(l)) { notify('warning'); return; }
      impact('medium');
      if (!handle?.start()) return;
      if (l.online) return;                    // the worker answers with ROOM_FOUND
      handle = null;
      roomToken++;
      sheetHost?.close();
      hooks.onRoomStart?.(l);
      setGameMode('room', { roomCode: null });
      return;
    }
    impact('light');
    notify('success');
    try {
      saveMenu({ mode: 'bot', sizes: sizesForMode(current.id) });
    } catch {
      /* stay in memory */
    }
    sheets.close();
    init?.onStart?.();
  });

  onGameModeChange(() => {
    paintLobby();
    paintSheetState();
  });
}
