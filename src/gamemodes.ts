/**
 * gamemodes.ts — Game Mode Selector: lobby state, bottom sheet wiring, custom rooms.
 *
 * The lobby keeps one split-action Play Dock: a single continuous clay capsule whose
 * left section is the mode card (emblem · name · CHANGE badge) that opens the drawer,
 * joined at a molded seam to the one-tap launch, wearing the selected mode's win. The
 * `#sheet-game-modes` drawer holds exactly three rows — Quick match, Play with
 * friends and Practice vs Bot — plus one reward caption and one sticky Start.
 * Selecting a mode updates the lobby instantly and persists to the device; the
 * row that is open shows its options in place (1v1/2v2 or Easy/Normal/Hard).
 * 1v1 is the default: the 2v2 key ships disabled behind a "Soon" badge until
 * party matchmaking lands, so a stored party pick falls back to the duel.
 * The room UI lives on its own sub-screen behind a back arrow, never in the list.
 *
/**
 * Rooms are local-first: Create mints a 4-digit code and reveals a 1-tap
 * "Invite via Telegram" deep-link (`t.me/<bot>?startapp=room_XXXX`). Join validates
 * a 4-digit code. Online races still start as local bot races with matching
 * sizes until netplay lands — the lobby is the contract, the starter is a stub.
 *
 * Two doors lead into a room without a single tap: the deep link (`openInviteRoom`, driven by
 * `telegram.ts`'s start-param reader) and the room's own countdown (`armDuelCountdown`), which
 * fires the instant every seat the format fields is held by people. A room nobody had to press
 * anything to fill
 * is also a room nobody should have to press anything to start.
 */
import { readJson, writeJson } from './storage';
import { menuState, onLang, saveMenu, t } from './settings';
import { impact, notify, openTelegramShare, roomInviteUrl, roomShareUrl } from './telegram';
import { showToast } from './toast';
import type { Sheets } from './sheets';
import {
  canStart, humans, isHost, nextTeam, occupied, openLobby,
  type Lobby, type LobbyHandle, type LobbyRace, type LobbyFormat, type LobbySeat,
} from './lobby';
import { ROOM_IDLE_TTL_MS, isLobbyFormat, roomReady } from './room';

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

/** The sticky Start's label, in the player's language. */
const startLabel = (id: GameModeId): string => {
  switch (id) {
    case 'duel_1v1': return t('start1v1');
    case 'party_2v2': return t('start2v2');
    case 'bot': return t('startPractice');
    case 'room': return t('startPrivate');
  }
};

/**
 * The home Play Dock's left section: the mode the capsule will launch, named in one
 * crisp word (or two) so the tap that changes it is unmistakable. The section is
 * sized by its label, so FRIENDS, SOLO, BOT and the Persian labels never ellipsize.
 * The full title and status still live on the section's `aria-label`, which is what
 * a screen reader reads.
 */
const dockLabel = (id: GameModeId): string => {
  switch (id) {
    case 'duel_1v1': return t('dockQuick');
    case 'party_2v2': return t('dockParty');
    case 'bot': return t('dockPractice');
    case 'room': return t('dockFriends');
  }
};

/** The win line, split into its translated lead and the numbers that never change. */
const rewardLead = (id: GameModeId): string => (id === 'bot' ? t('practiceLead') : t('win'));

interface RewardLine {
  lead: string;
  /** `null` when the mode pays no trophies — practice has no ranking to lose. */
  trophy: string | null;
  coin: string;
}

const REWARD_AMOUNT: Record<GameModeId, { trophy: string | null; coin: string }> = {
  duel_1v1: { trophy: '+30', coin: '+65' },
  party_2v2: { trophy: '+50', coin: '+100' },
  bot: { trophy: null, coin: '+65' },
  room: { trophy: '+30', coin: '+65' },
};

const rewardFor = (id: GameModeId): RewardLine => ({ lead: rewardLead(id), ...REWARD_AMOUNT[id] });

const FORMAT_KEY: Record<LobbyFormat, string> = {
  duel: 'fmtDuel', '3p': 'fmt3p', '4p': 'fmt4p', '2v2': 'fmt2v2',
};
const formatLine = (format: LobbyFormat): string => t(FORMAT_KEY[format]);

/** The plain-language line under the roster, in the player's language. */
function hintText(l: Lobby): string {
  if (canStart(l)) return isHost(l) ? t('hintReadyHost') : t('hintWaitingHost');
  return t('hintInviteMore');
}

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

/* ---------- the room this client is holding ---------- */

/**
 * A room is a *membership*, not a drawer.
 *
 * The code, the crown and the socket outlive the sheet: closing the drawer to browse Home, or
 * hopping into a Telegram chat to send the invite, must not end the room a friend is about to
 * join. So the live membership is recorded here (and in `sessionStorage`, so a reload lands back
 * in it) and only two things ever clear it — an explicit `LEAVE`, or the match starting.
 */
interface RoomSession {
  code: string;
  /** True when this client minted the code and owns the crown. */
  host: boolean;
  /** True when the room was entered through somebody else's invite link. */
  invite: boolean;
  /** When the membership was last touched: the idle TTL is measured from here. */
  at: number;
}

const SESSION_KEY = 'detour.room.session.v1';
/** The code every invite door builds its URL from. Mirrors `session`, and the painted roster. */
let activeCode: string | null = null;
let session: RoomSession | null = null;

function readSession(): RoomSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<RoomSession>;
    const code = cleanRoomCode(v.code);
    const at = Number(v.at);
    if (!code || !Number.isFinite(at) || Date.now() - at > ROOM_IDLE_TTL_MS) return null;
    return { code, host: v.host === true, invite: v.invite === true, at };
  } catch {
    return null;
  }
}

function saveSession(next: RoomSession | null): void {
  session = next;
  activeCode = next?.code ?? null;
  try {
    if (next) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* stay in memory: a webview that refuses storage still plays */
  }
}

/** The membership is still live: refresh its clock so the TTL measures silence, not age. */
function touchSession(): void {
  if (!session) return;
  saveSession({ ...session, at: Date.now() });
}

session = readSession();
activeCode = session?.code ?? null;

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
      return { id: sel.id, title: t('modeDuel'), status: 'online', icon: '#i-swords', sub: t('subDuel') };
    case 'party_2v2':
      return { id: sel.id, title: t('modeParty'), status: 'online', icon: '#i-users', sub: t('subParty') };
    case 'bot':
      return { id: sel.id, title: t('modeBot'), status: 'practice', icon: '#i-bot', sub: t('subPractice') };
    case 'room':
      return {
        id: sel.id,
        title: sel.roomCode ? t('modeRoomCode').replace('{code}', sel.roomCode) : t('modeRoom'),
        status: 'private',
        icon: '#i-send',
        sub: sel.roomCode ? t('subRoomCode') : t('subRoom'),
      };
  }
}

/* ---------- rooms: mint, share, join ---------- */

/** The codes this tab has already handed out. A session never mints the same one twice. */
const ISSUED_KEY = 'detour.room.codes.v1';
const ISSUED_MAX = 48;

function issuedCodes(): string[] {
  try {
    const raw = window.sessionStorage.getItem(ISSUED_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list)
      ? list.filter((c): c is string => typeof c === 'string' && /^\d{4}$/.test(c))
      : [];
  } catch {
    return [];
  }
}

function rememberCode(code: string): void {
  try {
    const next = [...issuedCodes().filter((c) => c !== code), code].slice(-ISSUED_MAX);
    window.sessionStorage.setItem(ISSUED_KEY, JSON.stringify(next));
  } catch {
    /* stay in memory */
  }
}

/**
 * A room code this session has never used.
 *
 * Four digits is nine thousand rooms, and the worker refuses a code another host is already
 * holding — so the client's half of "unique" is the cheap half: never mint the same code twice in
 * one tab, and never mint the code the room we are sitting in is already using. The walk starts
 * at a random offset and steps through the whole space, so a collision is impossible rather than
 * unlikely.
 */
export function createRoomCode(): string {
  const used = new Set(issuedCodes());
  if (activeCode) used.add(activeCode);
  const start = Math.floor(Math.random() * 9000);
  for (let i = 0; i < 9000; i++) {
    const code = String(1000 + ((start + i) % 9000));
    if (used.has(code)) continue;
    rememberCode(code);
    return code;
  }
  return String(1000 + start);
}

/** Mint a fresh room code and select it. The lobby screen takes over from here. */
export function createRoom(): GameModeSelection {
  const code = createRoomCode();
  return setGameMode('room', { roomCode: code });
}

export function joinRoomCode(raw: string): { ok: true; code: string } | { ok: false; error: string } {
  const code = cleanRoomCode(raw);
  if (!code) return { ok: false, error: t('errCode') };
  setGameMode('room', { roomCode: code });
  return { ok: true, code };
}

/**
 * The code every invite door builds its link from: the room this client is actually sitting in,
 * falling back to the selection's own code. One value, read by all four doors — the badge, the
 * `Copy Link` key, the header `Invite` pill and the empty rival plate.
 */
function inviteCode(explicit?: string | null): string {
  return cleanRoomCode(explicit ?? activeCode ?? handle?.lobby.code ?? current.roomCode ?? '') ?? '';
}

/**
 * The canonical invite URL. `telegram.ts` owns the grammar (`?startapp=room_<code>`), this owns
 * *which* code — so a room can never hand out two different links for itself.
 */
export function inviteUrl(code?: string | null): string {
  return roomInviteUrl(inviteCode(code));
}

/** Display form: `t.me/<bot>?startapp=room_XXXX` (the shared config owns the handle). */
export function buildInviteDisplay(code?: string | null): string {
  return inviteUrl(code).replace(/^https:\/\//, '');
}

/** The one-tap joinable Mini App URL every invite carries. */
export function buildInviteLink(code?: string | null): string {
  return inviteUrl(code);
}

/** What the invite carries into Telegram's own share sheet. */
const SHARE_TEXT = '⚔️ Join my duel in Tactix! Tap the link to enter the room:';

/** Telegram's native share page for a room: the recipient picker opens on top of the chat. */
export function buildShareUrl(code?: string | null): string {
  return roomShareUrl(inviteCode(code), SHARE_TEXT);
}

/** The header pill and the open seat's plate: the same link, through Telegram's picker. */
function openInvite(code?: string | null): void {
  const url = buildShareUrl(code);
  if (!url) return;
  openTelegramShare(url);
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

/* ---------- the home Play Dock (same IDs home.ts owns) ---------- */

/**
 * Repaint both zones of the dock from the one selection: the left zone names the mode
 * it would switch to (emblem · label · the CHANGE chip) and the right zone wears the
 * win the launch pays. Nothing here reads the DOM as state — every value comes from
 * `getLobbyDisplay()` plus the drawer's own `REWARD` line.
 */
export function paintLobby(): void {
  const lobby = getLobbyDisplay();
  const card = document.getElementById('mode-hero');
  if (card) {
    card.setAttribute('data-gmode', lobby.id);
    card.setAttribute('aria-label', `${t('change')} · ${lobby.title} — ${lobby.sub}`);
  }
  const titleEl = document.getElementById('home-play-title');
  if (titleEl) titleEl.textContent = dockLabel(lobby.id);
  const useEl = document.getElementById('mode-hero-use') as unknown as SVGUseElement | null;
  if (useEl) useEl.setAttribute('href', lobby.icon);
  /* the mode's own line, kept as the dock's spoken description rather than a third row */
  const subEl = document.getElementById('home-play-sub');
  if (subEl) subEl.textContent = lobby.sub;

  const reward = rewardFor(lobby.id);
  const n = (v: string): string => v.replace('+', '');
  const rw = document.getElementById('home-play-rw');
  if (rw) {
    rw.setAttribute('aria-label', reward.trophy === null
      ? `${reward.lead} · ${n(reward.coin)} ${t('coinsUnit')}`
      : `${reward.lead} · ${n(reward.trophy)} TIQ · ${n(reward.coin)} ${t('coinsUnit')}`);
  }
  /* practice pays no trophies, so the chip leaves the face instead of reading "+0" */
  const trophy = document.getElementById('home-play-rw-trophy');
  const trophyN = document.getElementById('home-play-rw-trophy-n');
  if (trophy) {
    trophy.hidden = reward.trophy === null;
    if (reward.trophy && trophyN) trophyN.textContent = reward.trophy;
  }
  const coinN = document.getElementById('home-play-rw-coin-n');
  if (coinN) coinN.textContent = reward.coin;

  const play = document.getElementById('home-play') as HTMLButtonElement | null;
  if (play) play.setAttribute('aria-label', `${t('play')} · ${lobby.title} — ${lobby.sub}`);
}

/* ---------- the lobby: one socket, one roster, one Start ---------- */

/** The lobby this screen is showing, or null outside one. */
let handle: LobbyHandle | null = null;
/** Bumped on every open/leave, so a late frame from a closed socket cannot repaint the new screen. */
let roomToken = 0;
/** Who was sitting in the room when its roster was last painted: the arrival detector's baseline. */
let seenHumans = new Set<string>();
/** Reconnect attempts since the last frame the server actually answered. */
let resumeTries = 0;
/** Fresh codes minted after a collision with another host's room. */
let codeTries = 0;
/** The one pending reconnect. */
let resumeTimer = 0;
/**
 * A guest landed while the drawer could not come up (a board was being played). The arrival is
 * remembered rather than dropped: the room opens the moment the player is somewhere a drawer
 * belongs.
 */
let pendingReveal = false;
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

/** What the screen says when the server turns us away. One key each, no jargon. */
const LOBBY_ERROR_KEY: Record<string, string> = {
  room_not_found: 'errRoomNotFound',
  ROOM_NOT_FOUND: 'errRoomNotFound',
  room_full: 'errRoomFull',
  ROOM_FULL: 'errRoomFull',
  room_exists: 'errRoomExists',
  ROOM_EXISTS: 'errRoomExists',
  /* the code is spent: the match it opened has started, or its host disbanded it */
  room_consumed: 'errInviteExpired',
  room_started: 'errInviteExpired',
  ROOM_STARTED: 'errInviteExpired',
  /* the host closed a room we were already sitting in */
  room_closed: 'errRoomClosed',
  MAINTENANCE: 'errMaintenance',
  BANNED: 'errBanned',
};

const errorLine = (reason: string): string => t(LOBBY_ERROR_KEY[reason] ?? 'errJoinUnknown');

/**
 * The line a refused *invite* gets. A link that points at a match already under way, or at a room
 * its host disbanded, is the same thing to the person holding it: the invite is spent. Everything
 * else keeps its own reason.
 */
const inviteLine = (reason: string): string => (reason === 'room_consumed' || reason === 'room_started'
  || reason === 'ROOM_STARTED'
  ? t('errInviteExpired')
  : errorLine(reason));

/** The FFA badge colours, in seat order: every slot is told apart without a team label. */
const FFA_COLOR: readonly string[] = ['colorBlue', 'colorRed', 'colorGreen', 'colorYellow'];

/** Where a seat would sit if a new player joined right now — how empty wells pick their column. */
function plannedTeam(l: Lobby, index: number): 0 | 1 {
  const held = l.seats[index];
  if (held) return held.team;
  let blue = 0;
  let red = 0;
  for (let i = 0; i < l.seats.length; i++) {
    const s = l.seats[i];
    const team: 0 | 1 = s ? s.team : nextTeam(blue, red, l.format);
    if (i === index) return team;
    if (team === 0) blue++; else red++;
  }
  return 0;
}

/** One seat, as the compact roster paints it (3P, 4P, 2v2). Empty wells are the invite door. */
function slotMarkup(l: Lobby, seat: number, team: 0 | 1 | null): string {
  const s = l.seats[seat];
  if (!s) {
    return `<button class="lb-slot is-open" type="button" role="listitem" data-seat="${seat}"`
      + (team === null ? '' : ` data-team="${team}"`)
      + ` aria-label="${t('openSeatInvite').replace('{n}', String(seat + 1))}">`
      + '<span class="lb-plus" aria-hidden="true">+</span>'
      + `<span class="lb-open-t">${t('inviteFriend')}</span></button>`;
  }
  const role = s.host ? t('host') : s.bot ? t('bot') : s.seat === l.you ? t('you') : t('ready');
  const color = seat % FFA_COLOR.length;
  /* the host may move any seat between the teams; a player may move their own */
  const canMove = team !== null && (isHost(l) || s.seat === l.you);
  const tags = [
    s.host ? `<span class="lb-crown" role="img" aria-label="${t('host')}">👑</span>` : '',
    team === null ? `<span class="lb-color" data-color="${color}">${t(FFA_COLOR[color])}</span>` : '',
  ].filter(Boolean).join('');
  const cls = ['lb-slot', 'is-held'];
  if (s.host) cls.push('is-host');
  if (s.seat === l.you) cls.push('is-you');
  if (!s.connected) cls.push('is-away');
  const hint = canMove
    ? ` title="${t('switchTeamTo')
      .replace('{name}', esc(s.name))
      .replace('{team}', s.team === 0 ? t('teamOrange') : t('teamBlue'))}"`
    : '';
  const label = team === null
    ? `${s.name}, ${role}, ${t(FFA_COLOR[color])}`
    : `${s.name}, ${role}, ${s.team === 0 ? t('teamBlue') : t('teamOrange')}`;
  return `<button class="${cls.join(' ')}" type="button" role="listitem" data-seat="${seat}"`
    + (team === null ? ` data-color="${color}"` : ` data-team="${s.team}"`)
    + ` aria-label="${esc(label)}"${hint}>`
    + avatarMarkup(s)
    + `<span class="lb-slot-txt"><span class="lb-name">${esc(s.name)}</span>`
    + `<span class="lb-role">${role}</span></span>`
    + `<span class="lb-tags">${tags}</span></button>`;
}

/**
 * The seat's face: Telegram's own photo when the seat carries one, and the monogram under it as
 * the fallback. The `<b>` is painted first and the image sits on top, so a blocked CDN costs a
 * photo rather than a card — the error listener that removes a broken image is wired once, after
 * the roster is written, rather than as an inline handler (the app ships no inline script).
 */
function avatarMarkup(s: LobbySeat): string {
  const initial = esc((s.initial || s.name.charAt(0) || 'P').toUpperCase());
  if (!s.avatarUrl) return `<span class="lb-av" aria-hidden="true">${initial}</span>`;
  return '<span class="lb-av lb-av-photo" aria-hidden="true">'
    + `<b class="lb-av-fb">${initial}</b>`
    + `<img src="${esc(s.avatarUrl)}" alt="" decoding="async" loading="lazy">`
    + '</span>';
}

/**
 * The duel's crest: a chiselled gold core riding a vertical laser thread that fades into the
 * plates above and below it. Board furniture, never a control — `aria-hidden`, and nothing in it
 * is focusable, so it can never take a tap meant for a seat.
 */
const vsMarkup = (): string =>
  '<div class="lb-vs" aria-hidden="true">'
  + '<span class="lb-vs-thread"></span>'
  + '<span class="lb-vs-core">'
  + '<span class="lb-vs-aura"></span>'
  + '<svg class="lb-vs-swords" focusable="false"><use href="#i-swords" /></svg>'
  + '<b class="lb-vs-t">VS</b>'
  + '</span>'
  + '<span class="lb-vs-thread"></span>'
  + '</div>';

/**
 * One half of the duel: a holographic plate. The host's side is an obsidian slab under a cyan
 * laser border with a gold crown on its shoulder; the rival's side is the same plate in glass
 * until somebody takes it, and slams into place when they do. `side` is the plate's *position*,
 * not its occupant: an empty left plate is still the host's plate, waiting for the host.
 */
function duelPlate(l: Lobby, seat: number, side: 'host' | 'rival'): string {
  const s = l.seats[seat];
  if (!s) {
    return `<button class="lb-slot lb-plate is-open is-${side}" type="button" role="listitem"`
      + ` data-seat="${seat}" aria-label="${esc(t('openSeatInvite').replace('{n}', String(seat + 1)))}">`
      /* the dashed ring is drawn, not bordered: only a stroke can march its dashes */
      + '<svg class="lb-well-ring" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">'
      + '<rect x="1.5" y="1.5" width="97" height="97" rx="12" ry="12" /></svg>'
      + '<span class="lb-plus" aria-hidden="true">+</span>'
      + `<span class="lb-open-t">${esc(t('inviteFriendFull'))}</span>`
      + `<span class="lb-open-s">${esc(t('rivalWaiting'))}</span>`
      + '</button>';
  }
  const cls = ['lb-slot', 'lb-plate', 'is-held', `is-${side}`];
  if (s.host && side !== 'host') cls.push('is-host');
  if (s.seat === l.you) cls.push('is-you');
  if (!s.connected) cls.push('is-away');
  /* the rival's plate only reads "ready" once a person is actually sitting in it: a well the host
     filled with the machine is not somebody waiting to play */
  if (side === 'rival' && !s.bot) cls.push('is-rival', 'is-ready');
  const role = s.host ? t('host') : s.seat === l.you ? t('you') : s.bot ? t('bot') : t('rival');
  const label = `${s.name}, ${role}`;
  const badge = s.host
    ? `<span class="lb-badge lb-badge-host" role="img" aria-label="${esc(t('host'))}">`
      + '<svg class="ico" focusable="false"><use href="#i-crown" /></svg></span>'
    : s.bot ? '' : `<span class="lb-badge lb-badge-ready">${esc(t('ready'))}</span>`;
  return `<button class="${cls.join(' ')}" type="button" role="listitem" data-seat="${seat}"`
    + ` aria-label="${esc(label)}">`
    + `<span class="lb-plate-halo" aria-hidden="true"></span>`
    + badge
    + avatarMarkup(s)
    + `<span class="lb-slot-txt"><span class="lb-name">${esc(s.name)}</span>`
    + `<span class="lb-role">${role}</span></span>`
    + '</button>';
}

/** The duel: one prominent plate a side, the crest between them. Two seats, nothing to count. */
function duelMarkup(l: Lobby): string {
  return duelPlate(l, 0, 'host') + vsMarkup() + duelPlate(l, 1, 'rival');
}

/**
 * The 2v2 shape: Blue's column, the VS crest, Orange's column. Each side draws the seats the
 * format assigns it, in seat order, so the two columns always read as even sides.
 */
function teamMarkup(l: Lobby): string {
  const column = (team: 0 | 1): string => {
    const seats = l.seats.map((_s, i) => i).filter((i) => plannedTeam(l, i) === team);
    return `<div class="lb-team is-${team === 0 ? 'blue' : 'orange'}" data-team="${team}">`
      + `<p class="lb-team-h"><span class="lb-team-dot" aria-hidden="true"></span>`
      + `<span class="lb-team-t">${team === 0 ? t('teamBlue') : t('teamOrange')}</span></p>`
      + seats.map((seat) => slotMarkup(l, seat, team)).join('')
      + '</div>';
  };
  return column(0) + vsMarkup() + column(1);
}

/** Rebuild the roster only when it actually moved: a paint must never steal a tap. */
function paintSlots(l: Lobby): void {
  /* the face is part of the signature: a frame that swaps a monogram for a relayed photo has to
     rebuild the plate it belongs to, even when every other field on the seat is unchanged */
  const sig = `${l.you}|${l.hostSeat}|${l.format}|`
    + l.seats.map((s) => (s
      ? `${s.id}:${s.name}:${s.avatarUrl ?? ''}:${s.team}:${s.host}:${s.bot}:${s.connected}`
      : '-')).join(',');
  if (sig === slotSig) return;
  slotSig = sig;
  const grid = document.getElementById('lb-slots');
  if (!grid) return;
  /* the format owns the roster's shape: two plates and a crest, three compact cards, or four */
  grid.className = `lb-slots is-${l.format}`;
  grid.dataset.format = l.format;
  grid.dataset.state = canStart(l) ? 'ready' : 'open';
  grid.innerHTML = l.format === '2v2'
    ? teamMarkup(l)
    : l.format === 'duel'
      ? duelMarkup(l)
      : l.seats.map((_s, i) => slotMarkup(l, i, null)).join('');
  /* a photo that never arrives leaves the monogram underneath it, never a broken frame */
  for (const img of grid.querySelectorAll<HTMLImageElement>('.lb-av-photo img')) {
    img.addEventListener('error', () => img.remove(), { once: true });
  }
}

/** Everything the lobby screen shows, from the value alone. */
function paintLobbyPane(l: Lobby): void {
  /* The room on screen *is* the active room: every invite door below reads this one code, and
     the badge prints it beside the link it would copy. */
  if (l.code) activeCode = l.code;
  const url = inviteUrl(l.code);
  const codeEl = document.getElementById('lb-code');
  if (codeEl) codeEl.textContent = l.code;
  const codeTag = document.getElementById('lb-code-tag');
  if (codeTag) {
    codeTag.setAttribute('aria-label', t('roomCodeOf').replace('{code}', l.code));
    /* the badge carries the same URL the copy key writes: one room, one link */
    if (url) codeTag.setAttribute('data-invite', url);
    else codeTag.removeAttribute('data-invite');
  }
  document.getElementById('lb-copy-link')?.setAttribute('aria-label', t('copyInviteFor').replace('{code}', l.code));

  const count = document.getElementById('lb-count');
  if (count) count.textContent = `${occupied(l)}/${l.capacity} ${t('players')}`;

  const host = isHost(l);
  /* one row, four direct formats: the pressed chip is the room's shape, and the line under it
     says what that shape plays. A guest sees the same bar with every key locked. */
  for (const b of document.querySelectorAll<HTMLButtonElement>('#lb-formats [data-format]')) {
    b.setAttribute('aria-pressed', String(b.dataset.format === l.format));
    b.setAttribute('aria-disabled', String(!host));
    b.classList.toggle('is-locked', !host);
  }
  const sub = document.getElementById('lb-mode-sub');
  if (sub) sub.textContent = formatLine(l.format);

  paintSlots(l);

  const hint = document.getElementById('lb-hint');
  if (hint) {
    /* a socket that dropped and is being walked back says so: the roster is stale, not empty */
    hint.textContent = l.status === 'connecting' ? t('errReconnecting') : hintText(l);
    hint.classList.toggle('is-ready', l.status !== 'connecting' && canStart(l));
  }

  const botKey = document.getElementById('lb-pick-bot');
  if (botKey) botKey.hidden = l.online;

  const start = document.getElementById('gm-start') as HTMLButtonElement | null;
  if (start) {
    /* a room that is reconnecting cannot start: the frame would go nowhere */
    const ready = host && canStart(l) && l.status !== 'connecting';
    start.textContent = host ? t('startMatch') : t('waitingHost');
    start.setAttribute('aria-disabled', String(!ready));
    if (host && !canStart(l)) {
      start.setAttribute('title', t('hintInviteMore'));
    } else {
      start.removeAttribute('title');
    }
    start.classList.add('is-lobby');
    start.classList.toggle('is-waiting', !host);
    start.classList.toggle('is-idle', host && !canStart(l));
    start.classList.toggle('is-ready', ready);
  }

  /* The room's own state rides on the pane, so the CSS can dress a full duel differently from one
     still waiting for its rival — and so the countdown below has one place to read it from. */
  const pane = document.getElementById('gm-view-lobby');
  if (pane) pane.dataset.state = canStart(l) ? 'ready' : 'open';

  /* Last: a room every seat of which is held counts itself down and starts. Everything above has
     already painted, so the countdown never races the roster it is counting. */
  armDuelCountdown(l);
}

/* ---------- the duel countdown: 3 … 2 … 1 … FIGHT ---------- */

/** One beat a second, then the FIGHT flash, then the start. */
const COUNT_STEP_MS = 1000;
const COUNT_FIGHT_MS = 700;
/** A start the server never answers must not leave the veil up over a lobby. */
const COUNT_WATCHDOG_MS = 2800;

interface Countdown {
  /** Identifies *this* run, so a stale timer can never paint a room that has moved on. */
  token: number;
  /** The room + roster it was armed for. A changed roster is a different countdown. */
  key: string;
  left: number;
  timer: number;
}

/** The one live countdown, or null. Module-level: the socket callbacks outlive `initGameModes`. */
let countdown: Countdown | null = null;
/** Bumped per run so a timer from a cancelled countdown is recognised and dropped. */
let countToken = 0;
/**
 * The roster whose countdown is over — cancelled by the host, or already fired. Two people who
 * have had their countdown do not get a second one from the next roster frame; a changed roster
 * is a new key, so a rival leaving and rejoining still counts down again.
 */
let countdownSpent = '';
/** True while this client's countdown is what started the race — the board skips its face-off. */
let autoLaunched = false;

/** The identity of a countdown: the room, and exactly who is sitting in it. */
const countKey = (l: Lobby): string =>
  `${l.code}|${l.seats.map((s) => (s ? s.id : '-')).join(',')}`;

const botsIn = (l: Lobby): number => l.seats.reduce((n, s) => n + (s && s.bot ? 1 : 0), 0);

/** May this lobby count itself down? The host's own room, every seat held by people, on screen. */
function armedForCountdown(l: Lobby): boolean {
  return isHost(l) && l.status !== 'closed' && lobbyOnScreen()
    && roomReady(l.format, humans(l), botsIn(l));
}

function countNodes() {
  return {
    root: document.getElementById('duel-count'),
    ring: document.getElementById('dc-ring'),
    stage: document.getElementById('dc-stage'),
    kicker: document.getElementById('dc-kicker'),
    n: document.getElementById('dc-n'),
    line: document.getElementById('dc-line'),
  };
}

/** The countdown's static chrome, in the player's language: painted on init and on a language switch. */
function paintCountdownChrome(): void {
  const kicker = document.getElementById('dc-kicker');
  if (kicker) kicker.textContent = t('countdownKicker');
  const cancel = document.getElementById('dc-cancel-t');
  if (cancel) cancel.textContent = t('cancelMatch');
}

/** Show the veil on one tick: the numeral, the line under it, and the ring draining. */
function paintCountdown(n: number, fight: boolean): void {
  const { root, ring, stage, kicker, n: num, line } = countNodes();
  if (!root) return;
  root.hidden = false;
  root.classList.add('is-on');
  root.classList.toggle('is-fight', fight);
  if (kicker) kicker.textContent = t('countdownKicker');
  if (num) num.textContent = fight ? t('fight') : String(n);
  if (line) line.textContent = fight ? t('fightLine') : t('duelStartsIn').replace('{n}', String(n));
  /* the ring drains once per second; the numeral re-pops on the same beat */
  if (ring && !fight) {
    ring.classList.remove('is-tick');
    void ring.offsetWidth;
    ring.classList.add('is-tick');
  }
  if (stage) {
    stage.classList.remove('is-beat');
    void stage.offsetWidth;
    stage.classList.add('is-beat');
  }
}

function hideCountdown(): void {
  const { root } = countNodes();
  if (!root) return;
  root.classList.remove('is-on', 'is-fight');
  root.hidden = true;
}

/**
 * Stop whatever countdown is running. `spend` remembers the roster, so neither the paint that
 * follows a cancel nor the frame that follows a start can re-arm the countdown just refused.
 */
function abortCountdown(spend = false): void {
  const state = countdown;
  countdown = null;
  if (state) {
    window.clearTimeout(state.timer);
    if (spend) countdownSpent = state.key;
  }
  hideCountdown();
}

/** The start itself: the host asks the room to launch, and the board takes over from the race. */
function fireCountdown(): void {
  const state = countdown;
  const l = handle?.lobby;
  countdown = null;
  hideCountdown();
  if (!state || !l) return;
  /* spent either way: a frame that lands while the start is in flight must not restart the count */
  countdownSpent = state.key;
  if (!isHost(l) || !canStart(l)) return;
  /* the overlay is gone, the start is on its way: this is the one path that skips the face-off */
  autoLaunched = true;
  impact('heavy');
  notify('success');
  const ok = handle?.start() ?? false;
  if (!ok) { autoLaunched = false; return; }
  /* a room whose answer never lands leaves the player on the roster they can still start by hand */
  window.setTimeout(() => { hideCountdown(); autoLaunched = false; }, COUNT_WATCHDOG_MS);
}

/**
 * Arm the countdown for a lobby that just filled up. Idempotent: a repaint for the same
 * two players is the same countdown, and a roster that changed underneath one aborts it first —
 * a rival who leaves during the count must not be launched against.
 */
function armDuelCountdown(l: Lobby): void {
  const key = countKey(l);
  if (countdown) {
    if (countdown.key === key) return;
    abortCountdown();
  }
  if (!armedForCountdown(l) || key === countdownSpent) return;

  const token = ++countToken;
  const state: Countdown = { token, key, left: 3, timer: 0 };
  countdown = state;
  paintCountdown(3, false);
  impact('medium');

  const step = (): void => {
    if (countdown !== state || countdown.token !== token) return;
    if (state.left > 1) {
      state.left -= 1;
      paintCountdown(state.left, false);
      impact('medium');
      state.timer = window.setTimeout(step, COUNT_STEP_MS);
      return;
    }
    /* the "1" has had its second: FIGHT, and the start rides the flash */
    paintCountdown(1, true);
    impact('heavy');
    state.timer = window.setTimeout(fireCountdown, COUNT_FIGHT_MS);
  };
  state.timer = window.setTimeout(step, COUNT_STEP_MS);
}

/**
 * Did the countdown on this client start the race that is arriving now? Read once, by the one
 * caller that decides whether the board still owes the player a face-off.
 */
export function takeAutoLaunch(): boolean {
  const fired = autoLaunched;
  autoLaunched = false;
  return fired;
}

/**
 * Open a room's socket and land on the lobby. `host` mints the code; a guest arrives through an
 * invite and must be expected.
 *
 * The membership is recorded before the socket exists, so a room is never "open" in the UI and
 * forgotten by the session — the code survives the drawer closing, the app sleeping and a reload.
 */
function openRoom(code: string, host: boolean, opts?: { invite?: boolean }): void {
  saveSession({ code, host, invite: opts?.invite === true, at: Date.now() });
  resumeTries = 0;
  codeTries = 0;
  /* the socket first, the pane second: the drawer then paints the room it actually opened,
     never the one it is replacing */
  connect(code, host, opts?.invite === true, false);
  showView('lobby');
}

/**
 * The socket itself, with no opinion about the screen: `openRoom` uses it for a fresh room and
 * `resumeRoom` for one this client already holds. Every callback is guarded by the room token, so
 * a frame from a socket a later room replaced can never repaint the new one.
 */
function connect(code: string, host: boolean, invite: boolean, resume: boolean): void {
  const token = ++roomToken;
  abortCountdown();
  countdownSpent = '';
  /* a previous room is walked out of explicitly: its code is disbanded on the server, not left
     behind as a room nobody is in */
  if (!resume) handle?.leave();
  handle = null;
  slotSig = '';
  /* a resumed room keeps the roster it already knew: the guest who joined while the socket was
     away is an arrival, not part of the scenery */
  if (!resume) seenHumans = new Set();
  pendingReveal = false;
  handle = openLobby({
    code,
    host,
    /* an invited guest has no solo fallback: the room exists or the invite is refused */
    mustExist: invite && !resume,
    /* a resumed room is never traded for a solo race: its guests can still join it */
    keepAlive: resume,
    onState: (l) => {
      if (token !== roomToken) return;
      resumeTries = 0;
      touchSession();
      /* A guest landed while the drawer was closed: the room is not a secret, so it comes up —
         and the countdown that follows starts the match without a tap. Over a board being
         played it waits for the player to come back instead. */
      if (noteArrival(l) && !lobbyOnScreen()) {
        if (hooks.canPopLobby?.() ?? true) {
          revealLobby();
          notify('success');
          impact('medium');
        } else {
          pendingReveal = true;
        }
      }
      paintLobbyPane(l);
    },
    onRace: (race) => {
      if (token !== roomToken) return;
      /* the lobby's work is done: the board owns the socket, and the code is spent */
      handle = null;
      roomToken++;
      abortCountdown();
      pendingReveal = false;
      sheetHost?.close();
      saveSession(null);
      hooks.onRoomRace?.(race);
      setGameMode('room', { roomCode: null });
    },
    onError: (reason) => {
      if (token !== roomToken) return;
      handle = null;
      abortCountdown();
      /* Two hosts on one code would fight over the crown. The collision is ours to fix: mint a
         fresh code and try again, rather than asking the player to understand a room they cannot
         see. */
      if ((reason === 'room_exists' || reason === 'ROOM_EXISTS') && host && codeTries < 2) {
        codeTries++;
        const fresh = createRoomCode();
        saveSession({ code: fresh, host: true, invite: false, at: Date.now() });
        setGameMode('room', { roomCode: fresh });
        connect(fresh, true, false, false);
        return;
      }
      saveSession(null);
      /* an invite that cannot be honoured hands the player back to Home with the reason on screen */
      if (invite) { inviteRefused(inviteLine(reason)); return; }
      roomFailed(reason === 'room_consumed' || reason === 'room_started'
        ? t('errRoomExpired')
        : errorLine(reason));
    },
    /* the room could not take the host's size pick (every seat is held): a nudge, not an error */
    onNotice: () => { notify('warning'); },
    /* The socket died on a live lobby. The room outlives it on the server, so this is a pause,
       not an end: reconnect, and only give up after a handful of tries. */
    onDrop: () => {
      if (token !== roomToken) return;
      handle = null;
      abortCountdown();
      scheduleResume();
    },
  });
}

/** How long to wait before walking back into a room whose socket dropped, per attempt. */
const RESUME_STEPS = [300, 800, 1600, 3200, 5000] as const;

/**
 * Reconnect the room this client still holds. The host who stepped into a Telegram chat, or whose
 * webview slept through a call, comes back to the same code, the same seat and the same guests —
 * the server kept all three.
 */
export function resumeRoom(): void {
  /* A guest who landed while the board was up still gets their drawer the moment the player is
     somewhere a drawer belongs — the arrival is not lost, only postponed. */
  if (pendingReveal && handle && (hooks.canPopLobby?.() ?? true)) {
    pendingReveal = false;
    revealLobby();
    notify('success');
    impact('medium');
  }
  const held = session;
  if (!held || handle || resumeTimer) return;
  /* an app that is not on screen has nothing to reconnect to yet: `visibilitychange` calls back */
  if (document.hidden) return;
  if (resumeTries >= RESUME_STEPS.length) {
    /* the wire is gone for good: say so once, and stop holding a room nobody can reach */
    saveSession(null);
    abortCountdown();
    roomFailed(t('errDropped'));
    return;
  }
  resumeTries++;
  connect(held.code, held.host, held.invite, true);
}

function scheduleResume(): void {
  if (!session || resumeTimer) return;
  const wait = RESUME_STEPS[Math.min(resumeTries, RESUME_STEPS.length - 1)];
  resumeTimer = window.setTimeout(() => {
    resumeTimer = 0;
    resumeRoom();
  }, wait);
}

/** Is the lobby actually in front of the player? A countdown must never run behind a closed sheet. */
function lobbyOnScreen(): boolean {
  if (view !== 'lobby') return false;
  const sheet = document.getElementById('sheet-game-modes');
  return !!sheet && !sheet.hidden;
}

/**
 * Bring the drawer up on the lobby. Called when a guest lands in a room whose host had closed the
 * sheet: the membership never went away, so neither should the screen.
 */
function revealLobby(): void {
  const sheet = document.getElementById('sheet-game-modes');
  if (!sheetHost || !sheet) return;
  showView('lobby');
  if (sheet.hidden || !sheet.classList.contains('open')) sheetHost.open(sheet);
}

/**
 * Did somebody take a seat since the last paint? The first frame of a *fresh* room is only its
 * own roster (the host's own seat), so it sets the baseline — but a room this client is
 * *resuming* may already hold the guests who arrived while its socket was gone, and those are
 * exactly the arrivals the host must not miss.
 */
function noteArrival(l: Lobby): boolean {
  /* Only a frame the server actually answered is a roster. The placeholder a socket paints while
     it connects is not one, and counting it would invent an arrival on every reconnect. */
  if (l.status !== 'live') return false;
  const ids = new Set<string>();
  for (const s of l.seats) if (s && !s.bot) ids.add(s.id);
  const before = seenHumans;
  seenHumans = ids;
  if (!isHost(l)) return false;
  if (!before.size) return humans(l) >= 2;
  for (const id of ids) if (!before.has(id)) return true;
  return false;
}

/**
 * An invite that cannot be honoured: say why in one toast, close the drawer, and leave the player
 * on the home lobby exactly as they arrived. No half-open room, no dead-end pane.
 */
function inviteRefused(msg: string): void {
  saveSession(null);
  setGameMode('room', { roomCode: null });
  showView('modes');
  sheetHost?.close();
  showToast(msg, 'error');
  notify('error');
}

/**
 * The deep link's door: `?startapp=room_XXXX` lands in that room's lobby with no taps in between.
 *
 * False means the link cannot be honoured *here* — a code that is not a room code, or a shell with
 * no drawer yet. A room the server turns down is not a false: the join is attempted, and the
 * refusal comes back as a toast with the player at home.
 */
export function openInviteRoom(code: string): boolean {
  const clean = cleanRoomCode(code);
  if (!clean) {
    showToast(t('errRoomNotFound'), 'error');
    notify('error');
    return false;
  }
  const sheet = document.getElementById('sheet-game-modes');
  if (!sheetHost || !sheet) return false;
  /* already sitting in this very room: show it rather than opening a second socket on it */
  if (handle?.lobby.code === clean && handle.lobby.status !== 'closed') {
    revealLobby();
    return true;
  }
  /* a different room is left explicitly: its code is spent, not abandoned half-open */
  if (inLobby()) leaveRoom();
  clearRoomError();
  setGameMode('room', { roomCode: clean });
  /* the pane first, the sheet second: the drawer slides in already showing the room it was
     opened for, instead of flashing the mode list on its way there */
  openRoom(clean, false, { invite: true });
  /* a room the worker refused on the spot never gets a drawer: the toast has already said so */
  if (!handle) return false;
  sheetHost.open(sheet);
  return true;
}

/**
 * Walk out of the lobby for good — the one action that ends a room from this side.
 *
 * `LEAVE` is an explicit signal, not a dropped socket: the worker disbands a host's code (so the
 * link is spent) and gives a guest's seat back. Closing the drawer, tapping back or backgrounding
 * the app all go through `hideLobby` instead, which keeps every one of those alive.
 */
function leaveRoom(): void {
  roomToken++;
  window.clearTimeout(resumeTimer);
  resumeTimer = 0;
  resumeTries = 0;
  abortCountdown();
  countdownSpent = '';
  handle?.leave();
  handle = null;
  slotSig = '';
  seenHumans = new Set();
  pendingReveal = false;
  pickSeat = -1;
  const pick = document.getElementById('lb-pick');
  if (pick) pick.hidden = true;
  /* the code is spent on the server and forgotten here: a stale link must not resurrect it */
  saveSession(null);
  /* the lobby card goes back to "Custom Room": a code nobody is in is not a room */
  setGameMode('room', { roomCode: null });
}

/** Hide the drawer without ending the room. The socket, the code and every seat stay live. */
function hideLobby(): void {
  sheetHost?.close();
}

function showPick(on: boolean): void {
  const el = document.getElementById('lb-pick');
  if (el) el.hidden = !on;
  if (!on) pickSeat = -1;
}

/* ---------- the drawer's panes ---------- */

/** The drawer's own header copy, repainted on open and on a live language switch. */
function paintSheetHead(next: SheetView): void {
  const title = document.getElementById('gm-title');
  if (title) title.textContent = next === 'modes' ? t('selectGameMode') : t('playWithFriends');
  const sub = document.getElementById('gm-sub');
  if (sub) {
    sub.textContent = next === 'modes' ? t('pickHowRace')
      : next === 'lobby' ? t('friendsLobbySub')
      : t('friendsEntrySub');
  }
}

/** Swap the drawer between the mode list, the friends entry and the live lobby. */
function showView(next: SheetView): void {
  view = next;
  /* the countdown belongs to the roster it is counting: leaving that pane stops it */
  if (next !== 'lobby' && countdown) abortCountdown();
  const modes = document.getElementById('gm-view-modes');
  if (modes) modes.hidden = next !== 'modes';
  const room = document.getElementById('gm-view-room');
  if (room) room.hidden = next !== 'room';
  const lobbyEl = document.getElementById('gm-view-lobby');
  if (lobbyEl) lobbyEl.hidden = next !== 'lobby';
  const back = document.getElementById('gm-back');
  if (back) back.hidden = next === 'modes';
  paintSheetHead(next);
  /* the entry pane owns its two actions; the foot belongs to the list and the lobby */
  const foot = document.getElementById('gm-foot');
  if (foot) foot.hidden = next === 'room';
  /* the compact Leave lives beside Start only while a room is on screen */
  const leave = document.getElementById('lb-leave');
  if (leave) leave.hidden = next !== 'lobby';
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
 * One step of back. The friends entry returns to the list; the *lobby* is a live room, not a step,
 * so back hides the drawer and leaves the socket, the code and every seat exactly where they are.
 * Returns false when there is nothing left to unwind here — which is what makes the caller close
 * the sheet without ending the room.
 */
export function gmBack(): boolean {
  const sheet = document.getElementById('sheet-game-modes');
  if (view === 'modes' || !sheet || sheet.hidden) return false;
  if (view === 'lobby') return false;
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
  const reward = rewardFor(current.id);
  const lead = document.getElementById('gm-lead');
  if (lead) lead.textContent = reward.lead;
  const trophy = document.getElementById('gm-rw-trophy');
  const trophyN = document.getElementById('gm-rw-trophy-n');
  if (trophy) {
    trophy.hidden = reward.trophy === null;
    if (reward.trophy) {
      if (trophyN) trophyN.textContent = reward.trophy;
      trophy.setAttribute('aria-label', `${reward.trophy.replace('+', '')} ${t('trophiesUnit')}`);
    }
  }
  const coinN = document.getElementById('gm-rw-coin-n');
  if (coinN) {
    coinN.textContent = reward.coin;
    coinN.closest('.gm-rw')?.setAttribute('aria-label', `${reward.coin.replace('+', '')} ${t('coinsUnit')}`);
  }
  /* the lobby owns the Start key while it is on screen: it must not be renamed out from under it */
  const start = document.getElementById('gm-start');
  if (start && view === 'modes') {
    start.textContent = startLabel(current.id);
    start.removeAttribute('aria-disabled');
    start.removeAttribute('title');
    start.classList.remove('is-lobby', 'is-idle', 'is-waiting', 'is-ready');
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

/**
 * A room that is gone, said where the player can actually see it: in the friends pane when the
 * drawer is up, and as a toast when the room was living in the background. A hidden pane carrying
 * the only copy of an error is the same as no error at all.
 */
function roomFailed(msg: string): void {
  if (lobbyOnScreen()) {
    showView('room');
    showRoomError(msg);
    return;
  }
  showToast(msg, 'error');
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
  /**
   * May a guest's arrival bring the drawer up over whatever is on screen? False while a board is
   * being played: a popup over a live race is worse than a room that waits a beat.
   */
  canPopLobby?: () => boolean;
}

export function initGameModes(sheets: Sheets, init?: GameModeInit): void {
  sheetHost = sheets;
  hooks = init ?? {};
  paintLobby();
  paintSheetState();
  paintCountdownChrome();
  showView('modes');

  /* rows: quick + practice select in place, friends open their own sub-screen */
  for (const pick of document.querySelectorAll<HTMLButtonElement>('.gm-pick[data-gmode]')) {
    pick.addEventListener('click', () => {
      const raw = pick.dataset.gmode;
      if (!isGameModeId(raw)) return;
      impact('light');
      if (raw === 'room') {
        /* a room this client still holds reopens its lobby, even while it is reconnecting */
        const held = inLobby() || !!session;
        showView(held ? 'lobby' : 'room');
        if (held && !handle) resumeRoom();
        return;
      }
      clearRoomError();
      setGameMode(raw);
    });
  }

  document.getElementById('gm-back')?.addEventListener('click', () => {
    impact('light');
    /* the lobby's back hides the drawer; it never leaves the room — only `< LEAVE` does that */
    if (view === 'lobby') { hideLobby(); return; }
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

  /* ---- lobby: the code bar. Every door reads the same active code and the same URL ---- */
  document.getElementById('lb-copy-link')?.addEventListener('click', async () => {
    const url = buildInviteLink(handle?.lobby.code);
    if (!url) return;
    impact('light');
    const ok = await copyText(url);
    if (ok) {
      showToast(t('inviteLinkCopied'), 'success');
      return;
    }
    showToast(t('copyFailed'), 'error');
    notify('warning');
  });

  /* The badge is the room's name, not a key — the copy action sits beside it, named. It prints
     the very code `buildInviteLink` turns into the link, and carries that URL on `data-invite`,
     so the code on screen and the link every door copies are one value by construction. */

  /* the header pill and the empty rival plate: the same canonical link, through Telegram */
  const invite = (): void => { openInvite(handle?.lobby.code); };
  document.getElementById('lb-invite')?.addEventListener('click', invite);
  document.getElementById('lb-pick-invite')?.addEventListener('click', () => { showPick(false); invite(); });

  /* ---- lobby: the host's one-row format pick (a guest's copy is view-only) ---- */
  const pickFormat = (format: LobbyFormat): void => {
    const l = handle?.lobby;
    if (!l) return;
    if (!isHost(l)) { notify('warning'); return; }
    if (format === l.format) return;
    impact('light');
    /* the pure model refuses a pick nobody fits into; say so rather than leaving it dead */
    if (!handle?.setFormat(format)) notify('warning');
  };

  for (const b of document.querySelectorAll<HTMLButtonElement>('#lb-formats [data-format]')) {
    b.addEventListener('click', () => {
      const raw = b.dataset.format;
      if (isLobbyFormat(raw)) pickFormat(raw);
    });
  }

  /* ---- lobby: seats. An open well invites; a held one flips teams (2v2 only) ---- */
  document.getElementById('lb-slots')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('.lb-slot');
    const l = handle?.lobby;
    if (!btn || !l) return;
    const seat = Number(btn.dataset.seat);
    if (!Number.isInteger(seat)) return;
    const s = l.seats[seat];
    if (!s) {
      impact('light');
      /* an online room has no machine to add: the open well is simply the invite door */
      if (l.online) { invite(); return; }
      pickSeat = seat;
      showPick(true);
      return;
    }
    if (l.mode === 'team' && (isHost(l) || s.seat === l.you)) {
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

  /* the countdown's escape hatch: the host keeps the room and the rival stays seated, and the
     same two players are not counted down again until the roster changes */
  document.getElementById('dc-cancel')?.addEventListener('click', () => {
    impact('light');
    notify('warning');
    abortCountdown(true);
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
      /* the roster became a race: the invite code is spent here too, so a stale link cannot
         reopen a room whose board is already running */
      saveSession(null);
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

  onLang(() => {
    paintLobby();
    paintSheetHead(view);
    paintCountdownChrome();
    paintSheetState();
  });

  /* A reload lands back in the room it left. The code is on disk and the server still holds it,
     so the socket is reopened silently — the drawer stays closed until somebody joins it. */
  if (session) window.setTimeout(resumeRoom, 600);
}
