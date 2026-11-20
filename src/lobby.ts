/**
 * lobby.ts — the friends lobby: a live roster of up to four seats, the host's match format, and
 * the one socket that keeps every seat's copy of it identical.
 *
 * Three ideas hold the whole screen together:
 *
 *   1. **The roster is data, not DOM.** `Lobby` is a plain value, and every mutation is a pure
 *      function on it (`seatIn`, `vacate`, `setFormat`, `setTeam`). The sheet re-reads the value and
 *      repaints; nothing about a slot's look is stored in a closure. That is what lets the host
 *      migration below be a two-line rule instead of a screen rebuild.
 *
 *   2. **One host, one format.** The host seat owns the format — 1v1 / 3P / 4P / 2v2 — and with it
 *      the capacity, the race mode and the default Blue/Orange split. A guest's copy is read-only: it
 *      renders the same selectors, but they do nothing. A player may still move their own seat
 *      between the teams. Promotion is implicit — `vacate()` hands the crown to the lowest seat
 *      still held, so a lobby whose host walks out never becomes a room nobody can start.
 *
 *   3. **The wire is optional.** A room that cannot reach the worker is still a room: `openLobby`
 *      falls back to a *solo* lobby after a short connect window, where the host's own seat is
 *      filled and empty wells can be filled with the machine. The screen never dead-ends on a
 *      network that is not there — which matters most in the Telegram webview, where the socket is
 *      the first thing to go.
 *
 * The race itself is the worker's (`worker/matchmaker.ts` launches a `RoomDriver` and streams
 * `MOVE` frames); this module only hands `main.ts` a session shaped like the 1v1 one.
 */
import type { Action, GameState } from './rules';
import { PHRASE_COUNT, isChatEmoteId, isChatLang, type ChatEmoteId, type ChatLang } from './data/phrases';
import { isPostChatPreset, type PostChatLine } from './data/postchat';
import { chime, myTier, roomSocketUrl, tierOf, type MindTier, type OpponentData } from './matchmaking';
import {
  FORMAT_CAPACITY, FORMAT_LINE, FORMAT_MODE, assignTeam, defaultTeam, isLobbyFormat, reflowSeats,
  teamCapacity,
  type LobbyFormat,
} from './room';

/** How the room plays: everyone for themselves, or two teams. Derived from the format. */
export type LobbyMode = 'ffa' | 'team';

/** One held seat. A `null` in `Lobby.seats` is an open well. */
export interface LobbySeat {
  seat: number;
  /** The player's stable key on the wire; local fallbacks mint their own. */
  id: string;
  name: string;
  /** The avatar letter, so a slot never paints an empty circle. */
  initial: string;
  /** Telegram's profile photo for this seat, when the client or a frame carries one. */
  avatarUrl?: string | null;
  /** Real profile metadata relayed by the room; empty when the player never set one. */
  tiq?: number;
  nation?: string | null;
  guild?: string | null;
  host: boolean;
  /** True when the machine holds the seat (a backfilled bot, or one the host added). */
  bot: boolean;
  /** 0 = Team Blue, 1 = Team Orange. Only read in `team` mode. */
  team: 0 | 1;
  /** True while this seat's socket is open; a reserved host seat reads false and can still hold. */
  connected: boolean;
  /**
   * True while this seat's Mini App is actually on screen. A player who closed Telegram keeps the
   * chair but reads away here — and the room holds its countdown until every seat is back.
   */
  active: boolean;
  /** True while this person is already playing another board: a launch waits for them to finish. */
  busy: boolean;
}

export interface Lobby {
  code: string;
  capacity: number;
  /** The host's pick: 1v1 / 3P / 4P / 2v2. Capacity and mode derive from it. */
  format: LobbyFormat;
  mode: LobbyMode;
  /** The seat wearing the crown. Always a held seat while the lobby is open. */
  hostSeat: number;
  seats: (LobbySeat | null)[];
  /** My own seat, or -1 while the server has not answered yet. */
  you: number;
  /** True when the code was opened by a guest and the crown's chair is still waiting for its host. */
  pendingHost: boolean;
  /** True while a socket carries this lobby; false is the local fallback. */
  online: boolean;
  status: 'connecting' | 'live' | 'solo' | 'closed';
  /**
   * The worker's own instant for the pre-match 3 - 2 - 1, or 0 while the room is waiting. Every
   * numeral on screen is derived from this one number, never from a local timer.
   */
  countdownEndsAt: number;
}

/* ---------- the roster, as pure arithmetic ---------- */

export const occupied = (l: Lobby): number => l.seats.reduce((n, s) => n + (s ? 1 : 0), 0);

export const humans = (l: Lobby): number => l.seats.reduce((n, s) => n + (s && !s.bot ? 1 : 0), 0);

export const isHost = (l: Lobby): boolean => l.you >= 0 && l.you === l.hostSeat;

/** How many players a room needs before it may start: the smallest race the rules can play. */
export const MIN_START = 2;

export const canStart = (l: Lobby): boolean => occupied(l) >= MIN_START;

/** The plain-language line under the roster: what is missing, or that the room is ready. */
export function startHint(l: Lobby): string {
  if (canStart(l)) return isHost(l) ? 'All set — start the match' : 'Waiting for the host…';
  return 'Invite one more player to start';
}

/** Which team the next arrival takes, given the seats already counted: the emptier one with room. */
export const nextTeam = (blue: number, red: number, format: LobbyFormat): 0 | 1 =>
  blue < teamCapacity(format, 0) && blue <= red ? 0 : red < teamCapacity(format, 1) ? 1 : 0;

/** The team a fresh seat joins: the emptier one that still has room under the format. */
export const teamFor = (l: Lobby): 0 | 1 =>
  nextTeam(
    l.seats.reduce((n, s) => n + (s && s.team === 0 ? 1 : 0), 0),
    l.seats.reduce((n, s) => n + (s && s.team === 1 ? 1 : 0), 0),
    l.format,
  );

/** The seat a new arrival takes: the first open well, or -1 when the room is full. */
export const openSeat = (l: Lobby): number => l.seats.findIndex((s) => s === null);

/** Re-seat the crown: the lowest held seat that is not the one walking out. */
function crownAfter(l: Lobby, leaving: number): number {
  const next = l.seats.findIndex((s, i) => !!s && i !== leaving);
  return next;
}

/** Put a player in a seat. A full room comes back untouched. */
export function seatIn(l: Lobby, spec: Omit<LobbySeat, 'seat' | 'team' | 'host'>): Lobby {
  const at = openSeat(l);
  if (at < 0) return l;
  const seat: LobbySeat = { ...spec, seat: at, team: teamFor(l), host: false };
  const seats = l.seats.map((s, i) => (i === at ? seat : s));
  const hostSeat = l.hostSeat >= 0 && l.seats[l.hostSeat] ? l.hostSeat : at;
  const withCrown = seats.map((s, i) => (s ? { ...s, host: i === hostSeat } : s));
  return { ...l, seats: withCrown, hostSeat };
}

/**
 * A seat empties. The crown moves to the lowest seat still held — host migration, done where it
 * cannot be forgotten — and a room with nobody left is closed rather than left half-alive.
 */
export function vacate(l: Lobby, seat: number): Lobby {
  if (!l.seats[seat]) return l;
  const seats = l.seats.map((s, i) => (i === seat ? null : s));
  const next = crownAfter({ ...l, seats }, seat);
  if (next < 0) return { ...l, seats, hostSeat: -1, you: -1, status: 'closed' };
  const crowned = seats.map((s, i) => (s ? { ...s, host: i === next } : s));
  return { ...l, seats: crowned, hostSeat: next };
}

/**
 * The host's format switch. Capacity, race mode and the default Blue/Red split all move together,
 * and held seats are carried into the new layout — a seat that no longer fits is moved to the
 * lowest open well, and a change nobody fits into is refused by returning the lobby untouched.
 */
export function setFormat(l: Lobby, format: LobbyFormat): Lobby {
  if (l.format === format) return l;
  const capacity = FORMAT_CAPACITY[format];
  const held = l.seats.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  const mapped = reflowSeats(held, capacity);
  if (!mapped) return l;
  const mode = FORMAT_MODE[format];
  const seats: (LobbySeat | null)[] = Array.from({ length: capacity }, () => null);
  held.forEach((from, k) => {
    const to = mapped[k];
    const s = l.seats[from] as LobbySeat;
    seats[to] = { ...s, seat: to, team: mode === 'team' ? defaultTeam(to) : s.team };
  });
  const crown = held.indexOf(l.hostSeat);
  const mine = held.indexOf(l.you);
  return {
    ...l,
    format,
    mode,
    capacity,
    seats,
    hostSeat: crown >= 0 ? mapped[crown] : -1,
    you: mine >= 0 ? mapped[mine] : -1,
  };
}

/** Move one seat between Blue and Red, respecting the format's team sizes. */
export function setTeam(l: Lobby, seat: number, team: 0 | 1): Lobby {
  const next = assignTeam(
    l.seats.map((s) => s?.team ?? 0),
    l.seats.map((s) => !!s),
    seat,
    team,
    l.format,
  );
  if (!next) return l;
  return {
    ...l,
    seats: l.seats.map((x, i) => (x ? { ...x, team: next[i] === 1 ? 1 : 0 } : x)),
  };
}

/** The format's one-line promise, printed under the selector. */
export { FORMAT_LINE, FORMAT_MODE, type LobbyFormat };

/* ---------- the race, shaped like the 1v1 session `main.ts` already plays ---------- */

export interface LobbyRaceSeat {
  side: number;
  id: string;
  name: string;
  bot: boolean;
  team: 0 | 1;
  /** Real profile metadata, already held by the room when the board launched. */
  avatarUrl?: string | null;
  tiq?: number;
  nation?: string | null;
  guild?: string | null;
  difficulty?: string;
  /** The room's verdict on this seat's VIP entitlement. */
  vip: boolean;
  /** The chair was struck from the race after its player disconnected. */
  left?: boolean;
}

/**
 * A live room race. Structurally the same contract as `OnlineSession` — same `side`/`sizes`/`send`
 * /`onMove` shape — so `startGame()` runs it without a second code path. `opponent` is the seat the
 * HUD would otherwise paint as "the rival"; a room names all four from its roster, so it is only a
 * fallback for the two-seat case.
 */
/** One seat's answer in the post-match rematch consensus. */
export type RematchVote = 'pending' | 'accepted' | 'declined';

/**
 * The room's authoritative rematch consensus, exactly as `REMATCH_STATE` carries it. The server owns
 * the quorum — `requiredCount` is the number of seats still in the room and not declining — so a
 * client never decides for itself that a rematch started.
 */
export interface RematchState {
  /** Seat → that player's verdict. */
  votes: Record<number, RematchVote>;
  /** How many seats have accepted right now. */
  acceptedCount: number;
  /** How many are needed: the remaining active players, shrunk by every leave and decline. */
  requiredCount: number;
  /** `unavailable` means the room cannot play on (a rival left, declined, or too few people). */
  status: 'pending' | 'unavailable';
  /** `RIVAL_LEFT`, `RIVAL_DECLINED`, `NOT_ENOUGH_PLAYERS` — the reason the button is dead. */
  reason?: string;
  /** 1-based round of the rematch this consensus is collecting for. */
  round: number;
}

export interface LobbyRace {
  matchId: string;
  seed: number;
  side: number;
  sizes: number[];
  code: string;
  mode: LobbyMode;
  seats: LobbyRaceSeat[];
  opponent: OpponentData;
  send(action: Action): boolean;
  /** Send one emote to the other seats. False when the socket is gone. */
  sendEmote(emote: ChatEmoteId): boolean;
  /** Send one tactical line to the other seats, as its closed `(lang, index)` pair. */
  sendPhrase(lang: ChatLang, index: number): boolean;
  /** Send one in-match free-text line to the other seats (VIP only). False when the socket is gone. */
  sendChat(text: string): boolean;
  /** Send one post-match line to the other seats. False when the socket is gone. */
  sendPostMatchChat(line: PostChatLine): boolean;
  /** Send this seat's rematch vote to the room. False when the socket is gone. */
  sendRematchVote(vote: 'accepted' | 'declined'): boolean;
  /** The room's consensus changed: who accepted, how many are needed, and whether it is dead. */
  onRematchState(cb: (state: RematchState) => void): void;
  /** The quorum was reached: a fresh board is live and its snapshot is on its way. */
  onRematchStart(cb: (info: { round: number }) => void): void;
  /**
   * Tell the room this seat is walking out of a settled capsule (`MAIN MENU`), so the remaining
   * players' consensus updates on the same beat instead of waiting out a reconnect grace.
   */
  leaveRoom(): boolean;
  resign(): void;
  close(): void;
  onMove(cb: (action: Action, side: number) => void): void;
  /** An emote another seat sent. */
  onEmote(cb: (emote: ChatEmoteId, side: number) => void): void;
  /** A tactical line another seat sent, as the pair they tapped. */
  onPhrase(cb: (lang: ChatLang, index: number, side: number) => void): void;
  /** An in-match free-text line another seat sent (VIP), plus the room's VIP verdict. */
  onChat(cb: (text: string, side: number, vip: boolean) => void): void;
  /** A post-match line another seat sent from the result capsule, plus the room's VIP verdict. */
  onPostChat(cb: (line: PostChatLine, side: number, vip: boolean) => void): void;
  /** A peer's socket entered or left its reconnect grace window, or was taken over by a bot. */
  onPeerStatus(cb: (side: number, status: 'reconnecting' | 'online' | 'bot', graceMs: number, name: string) => void): void;
  /**
   * A seat was struck from the race: its player disconnected and the machine's two substitute
   * turns ran out. `name` is the full display name the banner has to print.
   */
  onSeatLeft(cb: (side: number, name: string) => void): void;
  /**
   * An explicit forfeit: the chair is struck for good and no machine plays it. The frame carries
   * the worker's verdict — the stake both sides moved, and the winner when that ended the race.
   */
  onForfeit(cb: (info: { side: number; name: string; deltas: Record<string, number>; winner: number | null }) => void): void;
  /** The room's authoritative board, sent after a resume, a refusal or an explicit sync request.
   *  `presence` is the room's own read of who is at their socket, so a snapshot clears any stale
   *  reconnecting pill on the same beat the board lands. */
  onSync(cb: (state: GameState, turnLeftMs: number, presence?: Array<{ seat: number; connected: boolean }>) => void): void;
  /** Ask the room to re-send its authoritative board. */
  requestSync(): void;
  /** The socket is gone after the board settled: the result capsule's live keys are dead. */
  onPostLeft(cb: () => void): void;
  /**
   * Seats whose person walked out and whose chair the machine finished for. On a two-seat board
   * that is exactly the rival leaving mid-race: the result capsule opens with its banter and
   * rematch already locked instead of talking into an empty room.
   */
  goneSides(): number[];
  /** Seats struck from the race after a disconnect. Their pawns are inert and their card is dim. */
  leftSides(): number[];
  onEnd(cb: (end: { win: boolean; why: 'resign' | 'left' | 'drop' | 'aborted' }) => void): void;
  onReject(cb: (reason: string) => void): void;
}

/* ---------- the wire ---------- */

export interface LobbyOptions {
  code: string;
  /** True when this client minted the code and owns seat 0. */
  host: boolean;
  /** The shape the room opens on: `1v1` (duel), `3p`, `4p` or `2v2`. */
  format?: LobbyFormat;
  /** Repaints the sheet. Called on every roster change, including the fallback to solo. */
  onState: (lobby: Lobby) => void;
  /** The room launched: `main.ts` puts this on the board. */
  onRace: (race: LobbyRace) => void;
  /** The server refused us (a code that does not exist, a full room, maintenance). */
  onError: (reason: string) => void;
  /**
   * The same refusal, named. `code` is the registry's verdict (`NOT_FOUND`, `ROOM_FULL`,
   * `CONSUMED`, `ROOM_EXISTS`) and `reason` is the lower-case line `onError` has always carried.
   * A screen that wants to say "that room does not exist" instead of "the room could not be
   * opened" reads this one; a screen that only needs a toast keeps reading `onError`.
   */
  onRefused?: (code: string, reason: string) => void;
  /**
   * The host asked the room to start and it could not: fewer than two people are at their
   * sockets, or the launch frame never left. The reason is the worker's (`player_offline`,
   * `waiting_for_players`) or `socket` when the send itself failed. The screen turns it into a
   * toast and re-arms the countdown.
   */
  onStartFailed?: (reason: string) => void;
  /** A format change the room could not take (every seat is held): a nudge, not an error. */
  onNotice?: (reason: string) => void;
  /**
   * True for a room this client was *invited* to rather than one it opened. A guest cannot fall
   * back to a solo lobby: an invite to a room that no longer exists is a refusal, not a private
   * race against the machine under a stranger's code. The connect window then ends in `onError`.
   */
  mustExist?: boolean;
  /**
   * Never trade this room for a solo race. A room this client already holds — resumed after a
   * chat switch, a sleeping webview or a reload — is a promise made to its guests: if the wire
   * cannot be reached, say the room is reconnecting instead of quietly playing the machine.
   */
  keepAlive?: boolean;
  /**
   * The socket died on a lobby that had already answered. Not a close: the room outlives its
   * socket on the server for the idle TTL, so the screen keeps the roster, says it is
   * reconnecting, and decides for itself when to try again (and when to give up).
   */
  onDrop?: () => void;
  /**
   * The crown removed this seat from the room. The membership is over — no reconnect may walk
   * back into it — so the screen closes the lobby and puts the player back Home with the reason.
   */
  onKicked?: () => void;
  /**
   * This seat was struck from the race while it was disconnected, and the room refused to hand it
   * back. The membership is over: the board must not mount, and the player lands Home with the
   * reason on screen.
   */
  onEliminated?: () => void;
}

export interface LobbyHandle {
  readonly lobby: Lobby;
  /** Host only, and only in a lobby with no server behind it. */
  addBot(seat: number): void;
  /** Host only: the format switch. False when the pick changes nothing or nobody would fit. */
  setFormat(format: LobbyFormat): boolean;
  /** The host may move any seat; a player may move their own. Team formats only. */
  setTeam(seat: number, team: 0 | 1): void;
  /**
   * Host only: remove a non-host seat from the room. Online the room is asked (the worker is the
   * one that enforces the crown); offline only a bot's chair can be cleared. False when the pick
   * is not the host's to make, or the frame never left the device.
   */
  kick(seat: number): boolean;
  /** Tell the room this seat is in another board, so its countdown holds. */
  setBusy(busy: boolean): void;
  /** Host only. False while the format's minimum player count is not met (two players). */
  start(): boolean;
  /**
   * Walk out for good. This is the *only* thing that ends a room from this side: closing the
   * drawer, tapping back or backgrounding the app never does. The server is told explicitly
   * (`LEAVE`), so a host's exit disbands the code instead of leaving it to expire.
   */
  leave(): void;
}

/** How long a lobby waits for a socket before it accepts that it is playing alone. */
const CONNECT_MS = 1400;
/** One heartbeat: a mobile webview throttles timers, so a steady 4s beat keeps every hop warm and
 *  lets the server tell a sleeping page from a dead link inside three missed beats. */
const HEARTBEAT_MS = 4_000;
/** No frame, not even a `PONG`, for this long means the socket is half-open: walk it back. */
const DEAD_MS = 12_000;

const faceOf = (name: string): string => (name.trim().charAt(0) || 'P').toUpperCase();

/**
 * The close code the worker uses for a room the OPERATOR pulled. Every other close — an edge
 * recycle, a sleeping webview, a carrier hand-off — is a transport event and must be retried
 * silently before the match is called over.
 */
const OP_CLOSE_CODE = 4001;

/** Reasons the server means as "this race cannot go on": no reconnect can change the answer. */
const HARD_DOWN: ReadonlySet<string> = new Set([
  'MAINTENANCE', 'BANNED', 'SEASON_ENDED', 'FORCE_STOP', 'CLEARED', 'MATCHING_LOCKED', 'SHUTDOWN',
]);

/** The name and the face this device races under — the same pair the 1v1 queue sends. */
function myFace(): { name: string; avatarUrl: string | null } {
  const el = document.getElementById('p-name')?.textContent?.trim();
  const tg = (window as unknown as { Telegram?: { WebApp?: { initDataUnsafe?: { user?: { first_name?: string; username?: string; photo_url?: string } } } } })
    .Telegram?.WebApp?.initDataUnsafe?.user;
  const name = (el || tg?.first_name || tg?.username || 'You').slice(0, 14);
  const avatarUrl = typeof tg?.photo_url === 'string' && /^https?:\/\//i.test(tg.photo_url) ? tg.photo_url : null;
  return { name, avatarUrl };
}

const myName = (): string => myFace().name;

/** A lobby with only the host in it: the challenger's well open, in the shape the format fields. */
export function hostLobby(code: string, name: string, online: boolean, format: LobbyFormat = 'duel'): Lobby {
  const face = myFace();
  const capacity = FORMAT_CAPACITY[format];
  const host: LobbySeat = {
    seat: 0,
    id: 'you',
    name,
    initial: faceOf(name),
    avatarUrl: face.name === name ? face.avatarUrl : null,
    host: true,
    bot: false,
    team: 0,
    connected: true,
    active: true,
    busy: false,
  };
  return {
    /* A create asks the server to mint the digits, so there is no code to print until the first
       `ROOM_STATE` lands. `''` is the honest answer: the sheet shows its joining line, never a
       number nobody has reserved. */
    code: /^\d{4}$/.test(code) ? code : '',
    capacity,
    format,
    mode: FORMAT_MODE[format],
    hostSeat: 0,
    seats: [host, ...Array.from({ length: capacity - 1 }, () => null)],
    you: 0,
    pendingHost: false,
    online,
    status: online ? 'connecting' : 'solo',
    countdownEndsAt: 0,
  };
}

/** One `ROOM_STATE` frame, folded back into the model. Unknown seats are dropped, never trusted. */
function readLobby(l: Lobby, raw: Record<string, unknown>): Lobby {
  /* The format is the authority for the roster's shape; a frame without one (or an older server)
     falls back to what the seats and mode imply. */
  const format: LobbyFormat = isLobbyFormat(raw.format) ? raw.format
    : raw.mode === 'team' ? '2v2'
    : raw.capacity === 2 ? 'duel'
    : raw.capacity === 3 ? '3p' : '4p';
  const capacity = FORMAT_CAPACITY[format];
  /* A create is answered with the code the registry minted. Until this frame arrives the client
     has no code at all — so the code the room actually holds is read here, once, and every invite
     door downstream (`Copy Link`, `Invite`, the deep link) prints this one. */
  const minted = typeof raw.code === 'string' && /^\d{4}$/.test(raw.code) ? raw.code : '';
  const rows = Array.isArray(raw.players) ? raw.players
    : Array.isArray(raw.seats) ? raw.seats : [];
  const seats: (LobbySeat | null)[] = Array.from({ length: capacity }, () => null);
  /* Which seat is mine is read before the roster, because my own face is the one thing this
     client already knows: a frame from a worker that predates the avatar relay must not blank it. */
  const mine = typeof raw.you === 'number' ? raw.you : l.you;
  const localFace = mine >= 0 ? l.seats[mine]?.avatarUrl ?? null : null;
  for (const r of rows) {
    const s = r as Record<string, unknown>;
    const at = typeof s.side === 'number' ? s.side : -1;
    if (at < 0 || at >= capacity) continue;
    const name = typeof s.name === 'string' ? s.name.slice(0, 14) : 'Player';
    const avatar = typeof s.avatar === 'string' && /^https?:\/\//i.test(s.avatar) ? s.avatar : null;
    seats[at] = {
      seat: at,
      id: typeof s.id === 'string' ? s.id : `seat:${at}`,
      name,
      initial: faceOf(name),
      avatarUrl: avatar ?? (at === mine ? localFace : null),
      tiq: typeof s.tiq === 'number' ? s.tiq : undefined,
      nation: typeof s.flag === 'string' && s.flag ? s.flag : null,
      guild: typeof s.guild === 'string' && s.guild ? s.guild : null,
      host: s.host === true || s.isHost === true,
      bot: s.bot === true,
      team: s.team === 1 ? 1 : 0,
      /* `online` is the worker's contract; `connected` is the older spelling, honoured too. */
      connected: s.online === false ? false : s.connected !== false,
      /* `active` is the foreground gate the worker owns. A frame from a build that predates it is
         judged on the socket alone, so an older room never paints every seat as away. */
      active: typeof s.active === 'boolean' ? s.active : (s.online !== false && s.connected !== false),
      busy: s.busy === true,
    };
  }
  const hostSeat = typeof raw.host === 'number' ? raw.host : seats.findIndex((s) => !!s?.host);
  const you = mine;
  return {
    ...l,
    code: minted || l.code,
    capacity,
    format,
    seats,
    hostSeat,
    mode: FORMAT_MODE[format],
    you,
    pendingHost: raw.pendingHost === true,
    online: true,
    status: 'live',
    /* Absent means no countdown: an older worker simply never counts down. */
    countdownEndsAt: typeof raw.countdownEndsAt === 'number' && Number.isFinite(raw.countdownEndsAt)
      ? Math.max(0, raw.countdownEndsAt) : 0,
  };
}

/** The one socket a lobby ever opens. Kept module-level so leaving always closes the last one. */
let link: WebSocket | null = null;

export function openLobby(opts: LobbyOptions): LobbyHandle {
  let lobby = hostLobby(opts.code, myName(), true, opts.format ?? 'duel');
  let sock: WebSocket | null = null;
  let settled = false;
  /** True once the screen has accepted that there is no socket: the close it causes is not a drop. */
  let solo = false;
  let race: LobbyRace | null = null;
  /** True once `leave()` ran: the close it causes is this screen's own doing, not a drop. */
  let left = false;
  /** The last instant the room said anything at all: a `LOBBY`, a `PONG`, any frame. */
  let aliveAt = Date.now();
  let beat = 0;

  const stopBeat = (): void => {
    if (!beat) return;
    globalThis.clearInterval(beat);
    beat = 0;
  };

  /**
   * The keepalive. A lobby seat is idle by nature — two people waiting for a third, a host who
   * stepped into a chat — and an idle socket is exactly what an intermediary reaps. A `PING` every
   * four seconds keeps the connection warm through a throttled webview, and its `PONG` is the proof
   * of life: silence past `DEAD_MS` means the socket is half-open, so it is closed on purpose and the
   * normal close path starts the reconnect instead of leaving a phantom seat behind.
   */
  const startBeat = (): void => {
    stopBeat();
    beat = globalThis.setInterval(() => {
      if (left || solo) { stopBeat(); return; }
      if (!sock) { stopBeat(); return; }
      if (sock.readyState !== 1) return;
      if (Date.now() - aliveAt > DEAD_MS) {
        try { sock.close(); } catch { /* already gone */ }
        return;
      }
      send({ type: 'PING', t: Date.now() });
    }, HEARTBEAT_MS);
  };

  /**
   * A webview that was asleep fires its timers late or not at all. Coming back to the foreground
   * is the moment to notice a socket that died while the page could not hear it: closing it makes
   * the close handler run, and the close handler is what reconnects. A live race also asks for a
   * fresh snapshot here, because the moves it missed while hidden are exactly the drift this is
   * meant to repair. An immediate `PING` proves liveness to the room on the same beat, so a seat the
   * silence sweep had marked away is restored before the next heartbeat would have fired.
   */
  const wake = (): void => {
    if (left || solo) return;
    if (race && !raceDead) {
      if (!sock) {
        if (raceTimer) {
          globalThis.clearTimeout(raceTimer);
          raceTimer = 0;
        }
        scheduleRaceResume();
        return;
      }
      if (sock.readyState === 1 && Date.now() - aliveAt > DEAD_MS) {
        try { sock.close(); } catch { /* already gone */ }
        return;
      }
      if (sock.readyState === 1) {
        send({ type: 'PING', t: Date.now() });
        send({ type: 'SYNC_REQ' });
      }
      return;
    }
    if (sock?.readyState === 1) {
      if (Date.now() - aliveAt > DEAD_MS) {
        try { sock.close(); } catch { /* already gone */ }
        return;
      }
      send({ type: 'PING', t: Date.now() });
    }
  };

  /**
   * Tell the room whether this Mini App is on screen. The launch gate is the worker's, and it can
   * only hold a countdown if it hears the instant a player backgrounds Telegram — so the `false`
   * goes out on the way out, while the socket is still open, and the `true` on the way back.
   */
  const reportPresence = (active: boolean): void => {
    if (left || solo || race) return;
    send({ type: 'LOBBY_PRESENCE', active });
  };

  const onVisible = (): void => {
    /* A hidden page fires this on the way out: the room must know before the webview freezes. */
    if (document.hidden) { reportPresence(false); return; }
    reportPresence(true);
    wake();
  };

  const onPageHide = (): void => { reportPresence(false); };
  const onPageShow = (): void => { reportPresence(true); wake(); };

  /** The OS network came back: the same wake-up, without waiting for a visibility change. */
  const onOnline = (): void => { wake(); };

  const teardown = (): void => {
    stopBeat();
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
  };

  const paint = (): void => opts.onState(lobby);
  const push = (l: Lobby): void => { lobby = l; paint(); };

  /* The session's subscribers. They live out here because `MOVE` frames arrive after `ROOM_FOUND`
     has handed the race to `main.ts`, and the board wires its handlers on the frame that creates it. */
  const raceMoves: Array<(a: Action, side: number) => void> = [];
  const raceEmotes: Array<(emote: ChatEmoteId, side: number) => void> = [];
  const racePhrases: Array<(lang: ChatLang, index: number, side: number) => void> = [];
  const raceChats: Array<(text: string, side: number, vip: boolean) => void> = [];
  const racePosts: Array<(line: PostChatLine, side: number, vip: boolean) => void> = [];
  /** The post-match rematch consensus: every `REMATCH_STATE`, and the quorum being reached. */
  const raceRematches: Array<(state: RematchState) => void> = [];
  const raceRematchStarts: Array<(info: { round: number }) => void> = [];
  /** Seats a person walked out of; `SEAT_BOT` is the machine taking the chair over. */
  const raceGone = new Set<number>();
  /** Seats struck from the race for good; `SEAT_LEFT` is the disconnect allowance running out. */
  const raceLeft = new Set<number>();
  const raceSeatLefts: Array<(side: number, name: string) => void> = [];
  /** Explicit forfeits, with the verdict the worker settled: seat, TIQ deltas, and the winner. */
  const raceForfeits: Array<(info: { side: number; name: string; deltas: Record<string, number>; winner: number | null }) => void> = [];
  const raceLefts: Array<() => void> = [];
  let racePostGone = false;
  const markPostGone = (): void => {
    if (racePostGone) return;
    racePostGone = true;
    for (const cb of raceLefts) cb();
  };
  /**
   * The board is over: the server said so in as many words (an operator's pull, or a second refusal
   * that leaves no room to walk back into). `aborted` is the one ending that is nobody's forfeit.
   */
  const endAborted = (): void => {
    if (raceDead) return;
    raceDead = true;
    if (raceTimer) {
      globalThis.clearTimeout(raceTimer);
      raceTimer = 0;
    }
    if (raceOpenTimer) {
      globalThis.clearTimeout(raceOpenTimer);
      raceOpenTimer = 0;
    }
    outbox.length = 0;
    markPostGone();
    for (const cb of raceEnds) cb({ win: false, why: 'aborted' });
  };
  const raceEnds: Array<(e: { win: boolean; why: 'resign' | 'left' | 'drop' | 'aborted' }) => void> = [];
  const raceRejects: Array<(r: string) => void> = [];
  const racePeers: Array<(side: number, status: 'reconnecting' | 'online' | 'bot', graceMs: number, name: string) => void> = [];
  const raceSyncs: Array<(state: GameState, turnLeftMs: number, presence?: Array<{ seat: number; connected: boolean }>) => void> = [];
  /** Moves made while the socket is away: flushed on the authoritative snapshot, never before. */
  const outbox: Array<Record<string, unknown>> = [];
  /** The highest state sequence this seat has applied: a relay above it plus one is a dropped packet. */
  let raceSeq = 0;
  /** The one move awaiting its ack: a turn-based seat never has two in flight at once. */
  let pendingMove: { moveId: string; action: Action; since: number } | null = null;
  let moveRetryTimer = 0;
  let moveCounter = 0;
  /** The live race's silent reconnect attempts, in the order they are spaced. */
  const RACE_RESUME_STEPS = [400, 1000, 2000] as const;
  /** The server holds the seat this long; keep trying at the last beat until it runs out. */
  const RACE_GRACE_MS = 20_000;
  /** An unacknowledged move is retried with the same id after this long; the room deduplicates it. */
  const MOVE_RETRY_MS = 1200;
  let raceTries = 0;
  let raceTimer = 0;
  let raceOpenTimer = 0;
  /** When the live race first lost its socket: the client-side mirror of the server grace. */
  let raceDroppedAt = 0;
  /** A refused or abandoned race must not raise another socket behind the player's back. */
  let raceDead = false;
  /** This seat pressed Leave and confirmed: the room's own strike is already answered by the quit. */
  let forfeiting = false;

  /** Drop to the local lobby: the host is alone and may fill wells with the machine. */
  const fallback = (): void => {
    if (settled) return;
    settled = true;
    solo = true;
    teardown();
    try { sock?.close(); } catch { /* already gone */ }
    sock = null;
    link = null;
    /* An invited guest has nowhere to fall back to, and neither has a room this client already
       holds. The worker opens or rehydrates any valid four-digit code, so a socket we could not
       open is a network pause — never proof that the room does not exist. Say "reconnecting" and
       let the screen's retry loop own the decision, instead of accusing a real room of being gone. */
    if (opts.mustExist || opts.keepAlive) {
      lobby = { ...lobby, status: 'connecting', online: true };
      paint();
      opts.onDrop?.();
      return;
    }
    const offline = hostLobby(opts.code, lobby.seats[0]?.name ?? myName(), false, lobby.format);
    lobby = setFormat(offline, lobby.format);
    paint();
  };

  const send = (msg: Record<string, unknown>): boolean => {
    if (!sock || sock.readyState !== 1) {
      /* A move made into a socket that is mid-reconnect is not lost: it waits for the room's
         authoritative snapshot, which is the only proof the new socket is seated. Anything else
         (a chat line, a resignation) is not worth replaying out of order. */
      if (race && !raceDead && !left && !solo && msg.type === 'MOVE') {
        outbox.push(msg);
        if (outbox.length > 8) outbox.shift();
        return true;
      }
      return false;
    }
    try {
      sock.send(JSON.stringify(msg));
      return true;
    } catch {
      /* The socket died between the readyState check and the write: keep the move for the next
         seated socket instead of leaving the optimistic board to explain itself. */
      if (race && !raceDead && !left && !solo && msg.type === 'MOVE') {
        outbox.push(msg);
        if (outbox.length > 8) outbox.shift();
        return true;
      }
      return false;
    }
  };

  /** The new socket is seated: replay what was waiting on it, now that the server agrees. */
  const flushOutbox = (): void => {
    if (!sock || sock.readyState !== 1) return;
    const queued = outbox.splice(0, outbox.length);
    for (const msg of queued) {
      try {
        sock.send(JSON.stringify(msg));
      } catch {
        outbox.unshift(msg);
        return;
      }
    }
  };

  /** The ack landed (or a snapshot superseded the move): stop retrying it. */
  const clearPendingMove = (): void => {
    pendingMove = null;
    if (moveRetryTimer) {
      globalThis.clearTimeout(moveRetryTimer);
      moveRetryTimer = 0;
    }
  };

  /**
   * Retry an unacknowledged move with the SAME id after `MOVE_RETRY_MS`. The room deduplicates by
   * id, so a retry that crossed a lost ack never plays the turn twice. While the socket is down the
   * outbox already holds the move for the next seated socket, so the retry only writes to an open one.
   */
  const armMoveRetry = (): void => {
    if (moveRetryTimer) return;
    moveRetryTimer = globalThis.setTimeout(() => {
      moveRetryTimer = 0;
      if (!pendingMove || !race || raceDead || left || solo) return;
      if (Date.now() - pendingMove.since > RACE_GRACE_MS) { clearPendingMove(); return; }
      if (sock && sock.readyState === 1) {
        try {
          sock.send(JSON.stringify({ type: 'MOVE', action: pendingMove.action, moveId: pendingMove.moveId }));
        } catch { /* the outbox holds it for the next seated socket */ }
      }
      armMoveRetry();
    }, MOVE_RETRY_MS);
  };

  /** Submit one move under a fresh idempotency key and arm its ack retry. */
  const sendMove = (a: Action): boolean => {
    const moveId = `m${++moveCounter}`;
    pendingMove = { moveId, action: a, since: Date.now() };
    const ok = send({ type: 'MOVE', action: a, moveId });
    armMoveRetry();
    return ok;
  };

  /** Fold one frame from the worker into the model. */
  const onFrame = (raw: unknown): void => {
    /* after an explicit leave nothing this socket still says matters: the screen is gone */
    if (left) return;
    /* Any frame is liveness — including the heartbeat's answer — and the watchdog reads this. */
    aliveAt = Date.now();
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'PONG':
        return;
      case 'KICKED': {
        /* The crown removed this seat: the room is not ours any more, and a reconnect must never
           walk back into it. Drop the socket here so its close is not mistaken for a network drop
           worth retrying, then hand the screen the news it has to say out loud. */
        left = true;
        solo = true;
        raceDead = true;
        if (raceTimer) {
          globalThis.clearTimeout(raceTimer);
          raceTimer = 0;
        }
        if (raceOpenTimer) {
          globalThis.clearTimeout(raceOpenTimer);
          raceOpenTimer = 0;
        }
        teardown();
        outbox.length = 0;
        try { sock?.close(); } catch { /* already gone */ }
        sock = null;
        link = null;
        push({ ...lobby, status: 'closed', online: false, you: -1 });
        opts.onKicked?.();
        return;
      }
      case 'SEAT_ELIMINATED': {
        /* The room refused this seat: it was struck while we were away, and there is no board to
           walk back into. Kill the socket here so its close is not read as a drop worth retrying,
           and hand the screen the news — it must not mount the race. */
        left = true;
        solo = true;
        raceDead = true;
        if (raceTimer) {
          globalThis.clearTimeout(raceTimer);
          raceTimer = 0;
        }
        if (raceOpenTimer) {
          globalThis.clearTimeout(raceOpenTimer);
          raceOpenTimer = 0;
        }
        teardown();
        outbox.length = 0;
        try { sock?.close(); } catch { /* already gone */ }
        sock = null;
        link = null;
        push({ ...lobby, status: 'closed', online: false, you: -1 });
        /* Our own confirmed forfeit: the quit path is already taking the screen Home, so there is
           no "you were removed" verdict to read. */
        if (forfeiting) { forfeiting = false; return; }
        opts.onEliminated?.();
        return;
      }
      case 'ROOM_STATE':
      case 'LOBBY':
        settled = true;
        push(readLobby(lobby, msg));
        return;
      case 'ROOM_ERROR': {
        /* The registry refused a room operation, by name: `NOT_FOUND` (no such room — never a
           fresh one opened in its place), `ROOM_FULL`, `CONSUMED` (the code's match already ran),
           `ROOM_EXISTS` (somebody else holds the crown on that code). `reason` is the older
           lower-case spelling; either one is enough to explain it. */
        const code = typeof msg.code === 'string' ? msg.code : '';
        const reason = typeof msg.reason === 'string' ? msg.reason : 'ERROR';
        if (race) {
          /* A room error is a verdict about this SEAT, and a worker that recycled its edge can
             answer an old socket with one that no longer applies. So the first refusal is not the
             end of the match: the socket is let go and the resume ladder asks again. A re-seated
             snapshot clears the question; a second refusal is the server saying it twice, and that
             is what ends the race. */
          if (raceTries === 0) {
            stopBeat();
            try { sock?.close(); } catch { /* already gone */ }
            return;
          }
          endAborted();
          return;
        }
        settled = true;
        solo = true;
        teardown();
        try { sock?.close(); } catch { /* gone */ }
        sock = null;
        link = null;
        push({ ...lobby, status: 'closed' });
        opts.onError(reason);
        opts.onRefused?.(code || reason, reason);
        return;
      }
      case 'START_FAILED':
        /* The host's tap reached a room that is not ready — a friend's socket went away between
           the paint and the press. Say why; the screen re-arms its countdown on the same news. */
        if (race) return;
        opts.onStartFailed?.(typeof msg.reason === 'string' ? msg.reason : 'start_failed');
        return;
      case 'FORMAT_DENIED':
        /* the room did not take the pick — usually every seat is held; the LOBBY that follows
           puts the selector back where the room says it is, and the nudge explains the bounce */
        opts.onNotice?.(typeof msg.reason === 'string' ? msg.reason : 'format_denied');
        return;
      case 'ROOM_FOUND': {
        /* A live board already owns its seat: this is the room re-announcing the chair after a
           reconnect, not a new match. The snapshot that follows repairs any drift; restarting the
           board here would throw away the race the player is already playing. */
        if (race) { raceTries = 0; return; }
        settled = true;
        raceDead = false;
        raceDroppedAt = 0;
        raceTries = 0;
        racePostGone = false;
        raceGone.clear();
        raceLeft.clear();
        clearPendingMove();
        raceSeq = typeof msg.seq === 'number' && Number.isFinite(msg.seq) ? msg.seq : 0;
        const seats = Array.isArray(msg.seats) ? msg.seats : [];
        const roster: LobbyRaceSeat[] = seats.map((r, i) => {
          const s = r as Record<string, unknown>;
          return {
            side: typeof s.side === 'number' ? s.side : i,
            id: typeof s.id === 'string' ? s.id : `seat:${i}`,
            name: typeof s.name === 'string' ? s.name : `Seat ${i + 1}`,
            bot: s.bot === true,
            team: s.team === 1 ? 1 : 0,
            avatarUrl: typeof s.avatar === 'string' && /^https?:\/\//i.test(s.avatar) ? s.avatar : null,
            tiq: typeof s.tiq === 'number' ? s.tiq : undefined,
            nation: typeof s.nation === 'string' && s.nation ? s.nation
              : typeof s.flag === 'string' && s.flag ? s.flag : null,
            guild: typeof s.guild === 'string' && s.guild ? s.guild : null,
            difficulty: typeof s.difficulty === 'string' ? s.difficulty : undefined,
            vip: s.vip === true,
            left: s.left === true,
          };
        });
        for (const s of roster) if (s.left) raceLeft.add(s.side);
        const mine = typeof msg.side === 'number' ? msg.side : lobby.you;
        const rival = roster.find((s) => s.side !== mine) ?? roster[0];
        const sizes = Array.isArray(msg.sizes) ? msg.sizes.map((n) => Number(n) || 1) : roster.map(() => 1);
        race = {
          matchId: typeof msg.matchId === 'string' ? msg.matchId : '',
          seed: typeof msg.seed === 'number' ? msg.seed : 0,
          side: mine,
          sizes,
          code: lobby.code,
          mode: msg.mode === 'team' ? 'team' : lobby.mode,
          seats: roster,
          opponent: {
            id: rival?.id ?? 'rival',
            name: rival?.name ?? 'Rival',
            /* the rival's own metadata, never this client's — a room card must not inherit my TIQ
               or my flag just because the seat omitted one */
            tiq: rival?.tiq ?? 0,
            tier: rival?.bot ? tierOf(rival.tiq ?? 0) : myTier(),
            avatarUrl: rival?.avatarUrl ?? null,
            initial: faceOf(rival?.name ?? 'R'),
            flag: rival?.nation ?? null,
            nation: rival?.nation ?? null,
            guild: rival?.guild ?? null,
            isBot: rival?.bot === true,
            vip: rival?.vip === true,
          },
          send: (a) => sendMove(a),
          sendEmote: (emote) => send({ type: 'EMOTE', emote }),
          sendPhrase: (lang, index) => send({ type: 'PHRASE', lang, index }),
          sendChat: (text) => send({ type: 'CHAT', text }),
          sendPostMatchChat: (line) => send({ type: 'POST_MATCH_CHAT', ...line }),
          sendRematchVote: (vote) => send({ type: 'REMATCH_VOTE', vote }),
          leaveRoom: () => send({ type: 'LEAVE_ROOM' }),
          resign: () => { forfeiting = true; send({ type: 'FORFEIT' }); },
          close: () => {
            /* This is the screen walking away from the race, not a network drop: no reconnect may
               raise a socket for a board the player has already left. */
            left = true;
            raceDead = true;
            race = null;
            clearPendingMove();
            outbox.length = 0;
            if (raceTimer) {
              globalThis.clearTimeout(raceTimer);
              raceTimer = 0;
            }
            if (raceOpenTimer) {
              globalThis.clearTimeout(raceOpenTimer);
              raceOpenTimer = 0;
            }
            teardown();
            try { sock?.close(); } catch { /* gone */ }
            sock = null;
            link = null;
          },
          onMove: (cb) => { raceMoves.push(cb); },
          onEmote: (cb) => { raceEmotes.push(cb); },
          onPhrase: (cb) => { racePhrases.push(cb); },
          onChat: (cb) => { raceChats.push(cb); },
          onPostChat: (cb) => { racePosts.push(cb); },
          onRematchState: (cb) => { raceRematches.push(cb); },
          onRematchStart: (cb) => { raceRematchStarts.push(cb); },
          onPeerStatus: (cb) => { racePeers.push(cb); },
          onSeatLeft: (cb) => { raceSeatLefts.push(cb); },
          onForfeit: (cb) => { raceForfeits.push(cb); },
          onSync: (cb) => { raceSyncs.push(cb); },
          requestSync: () => { send({ type: 'SYNC_REQ' }); },
          onPostLeft: (cb) => { raceLefts.push(cb); },
          goneSides: () => [...raceGone],
          leftSides: () => [...raceLeft],
          onEnd: (cb) => { raceEnds.push(cb); },
          onReject: (cb) => { raceRejects.push(cb); },
        };
        opts.onRace(race);
        return;
      }
      case 'ROOM_SYNC': {
        const next = msg.state as GameState | null;
        if (!next || typeof next !== 'object' || !Array.isArray(next.balls)) return;
        raceTries = 0;
        raceDroppedAt = 0;
        /* The snapshot is authoritative: its sequence supersedes anything this seat applied, and it
           supersedes the move awaiting an ack — the board already reflects it, or refused it. */
        if (typeof msg.seq === 'number' && Number.isFinite(msg.seq)) raceSeq = msg.seq;
        clearPendingMove();
        /* The snapshot is the authority on who is still in the race: a chair struck while this
           socket was away never delivered its own SEAT_LEFT, so the board rebuilds the list. */
        raceLeft.clear();
        for (const side of next.left ?? []) {
          raceLeft.add(side);
          raceGone.add(side);
        }
        const presence = Array.isArray(msg.presence)
          ? (msg.presence as Array<Record<string, unknown>>)
            .filter((p) => typeof p.seat === 'number')
            .map((p) => ({ seat: p.seat as number, connected: p.connected !== false }))
          : undefined;
        const leftMs = Number(msg.turnLeftMs);
        for (const cb of raceSyncs) cb(next, Number.isFinite(leftMs) ? Math.max(0, leftMs) : 0, presence);
        flushOutbox();
        return;
      }
      case 'MOVE_ACK': {
        /* The room accepted this seat's move: advance the sequence and stop retrying that id. */
        const seq = Number(msg.seq);
        if (Number.isFinite(seq) && seq > raceSeq) raceSeq = seq;
        if (pendingMove && typeof msg.moveId === 'string' && msg.moveId === pendingMove.moveId) {
          clearPendingMove();
        }
        return;
      }
      case 'PEER_STATUS': {
        const side = Number(msg.seat);
        if (!Number.isInteger(side) || side < 0) return;
        const status = msg.status === 'reconnecting' ? 'reconnecting' : msg.status === 'online' ? 'online' : null;
        if (!status) return;
        const graceMs = Number(msg.graceMs);
        const name = typeof msg.name === 'string' ? msg.name : '';
        for (const cb of racePeers) cb(side, status, Number.isFinite(graceMs) ? Math.max(0, graceMs) : 0, name);
        return;
      }
      case 'MOVE': {
        const side = Number(msg.side) || 0;
        const seq = Number(msg.seq);
        if (Number.isFinite(seq) && seq > 0) {
          /* A relay at or below the sequence already applied is a stale duplicate; one above the
             next expected tick means a packet was dropped — ask for the authoritative board rather
             than apply an action the local turn may not allow. */
          if (seq <= raceSeq) return;
          if (seq > raceSeq + 1) { send({ type: 'SYNC_REQ' }); return; }
          raceSeq = seq;
        }
        /* The room played a move FOR this seat (a turn-deadline fallback): that is its ack too. */
        if (race && side === race.side) clearPendingMove();
        for (const cb of raceMoves) cb(msg.action as Action, side);
        return;
      }
      case 'EMOTE':
        if (!isChatEmoteId(msg.emote)) return;
        for (const cb of raceEmotes) cb(msg.emote, Number(msg.side) || 0);
        return;
      case 'PHRASE': {
        const index = Number(msg.index);
        if (!isChatLang(msg.lang) || !Number.isInteger(index) || index < 0 || index >= PHRASE_COUNT) return;
        for (const cb of racePhrases) cb(msg.lang, index, Number(msg.side) || 0);
        return;
      }
      case 'CHAT': {
        /* the room cleared the sender as VIP before relaying; `vip` is that clearance */
        if (typeof msg.text !== 'string') return;
        const text = msg.text.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 40);
        if (!text) return;
        for (const cb of raceChats) cb(text, Number(msg.side) || 0, msg.vip === true);
        return;
      }
      case 'POST_MATCH_CHAT': {
        /* the room already resolved the gate: a preset arrives as its id, a custom line only from
           a seat it cleared as VIP — and `vip` is that clearance, not the sender's claim */
        const vip = msg.vip === true;
        if (isPostChatPreset(msg.preset)) {
          for (const cb of racePosts) cb({ preset: msg.preset }, Number(msg.side) || 0, vip);
          return;
        }
        if (typeof msg.text !== 'string') return;
        const text = msg.text.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 40);
        if (!text) return;
        for (const cb of racePosts) cb({ text }, Number(msg.side) || 0, vip);
        return;
      }
      case 'REMATCH_STATE': {
        /* The room's consensus, already judged: this client only paints it. Unknown seats are
           dropped and an unreadable status falls back to "still collecting". */
        const raw = (msg.votes && typeof msg.votes === 'object')
          ? msg.votes as Record<string, unknown> : {};
        const votes: Record<number, RematchVote> = {};
        for (const [key, value] of Object.entries(raw)) {
          const seat = Number(key);
          if (!Number.isInteger(seat) || seat < 0) continue;
          votes[seat] = value === 'accepted' ? 'accepted' : value === 'declined' ? 'declined' : 'pending';
        }
        const accepted = Number(msg.acceptedCount);
        const required = Number(msg.requiredCount);
        const round = Number(msg.round);
        const state: RematchState = {
          votes,
          acceptedCount: Number.isFinite(accepted) ? Math.max(0, accepted) : 0,
          requiredCount: Number.isFinite(required) ? Math.max(0, required) : 0,
          status: msg.status === 'unavailable' ? 'unavailable' : 'pending',
          reason: typeof msg.reason === 'string' ? msg.reason : undefined,
          round: Number.isFinite(round) && round >= 1 ? round : 1,
        };
        for (const cb of raceRematches) cb(state);
        return;
      }
      case 'REMATCH_START': {
        /* The quorum landed: the authoritative snapshot follows this frame on the same beat. */
        const round = Number(msg.round);
        const info = { round: Number.isFinite(round) && round >= 2 ? round : 2 };
        for (const cb of raceRematchStarts) cb(info);
        return;
      }
      case 'OPPONENT_LEFT':
        /* the rival left the result capsule (the board itself is already settled) */
        markPostGone();
        for (const cb of raceEnds) cb({ win: false, why: 'left' });
        return;
      case 'REJECT': {
        /* A refusal carries the authoritative board: reconcile first, then let the screen say why.
           The board is the truth, the toast is only the explanation. The refused move is not retried. */
        clearPendingMove();
        const next = msg.state as GameState | null;
        if (next && typeof next === 'object' && Array.isArray(next.balls)) {
          if (typeof msg.seq === 'number' && Number.isFinite(msg.seq)) raceSeq = msg.seq;
          const leftMs = Number(msg.turnLeftMs);
          for (const cb of raceSyncs) cb(next, Number.isFinite(leftMs) ? Math.max(0, leftMs) : 0);
          flushOutbox();
        }
        for (const cb of raceRejects) cb(typeof msg.reason === 'string' ? msg.reason : 'refused');
        return;
      }
      case 'PLAYER_FORFEITED': {
        /* An explicit Leave, confirmed: the chair is struck for good, no machine ever plays it, and
           the frame carries the whole verdict the worker settled — the name, the stake both sides
           moved, and whether that was the last contender standing. */
        const side = Number(msg.seat);
        if (!Number.isInteger(side) || side < 0) return;
        const name = typeof msg.fullName === 'string' ? msg.fullName : '';
        const raw = (msg.tiqDeltas && typeof msg.tiqDeltas === 'object') ? msg.tiqDeltas : {};
        const deltas: Record<string, number> = {};
        for (const [id, value] of Object.entries(raw)) {
          const n = Number(value);
          if (id && Number.isFinite(n) && n !== 0) deltas[id] = Math.trunc(n);
        }
        const winner = typeof msg.winner === 'number' && Number.isInteger(msg.winner) ? msg.winner : null;
        raceLeft.add(side);
        raceGone.add(side);
        /* The verdict first: the board's own strike may settle the race on the same frame, and the
           capsule has to open already knowing the stake it is about to pay. */
        for (const cb of raceForfeits) cb({ side, name, deltas, winner });
        for (const cb of raceSeatLefts) cb(side, name);
        return;
      }
      case 'SEAT_LEFT': {
        /* The disconnect allowance ran out: this chair is struck from the race for good. Its pawns
           go inert, its card dims, and the banner names the player who is gone. */
        const side = Number(msg.side);
        if (!Number.isInteger(side) || side < 0) return;
        const name = typeof msg.name === 'string' ? msg.name : '';
        raceLeft.add(side);
        raceGone.add(side);
        for (const cb of raceSeatLefts) cb(side, name);
        return;
      }
      case 'SEAT_BOT': {
        /* a seat's person left mid-race: the machine finished it, and the board already knows.
           Remember it so the result capsule can open with its rival-facing keys locked. */
        const side = Number(msg.side) || 0;
        raceGone.add(side);
        /* The grace ran out: the pill must not keep promising a reconnect that is not coming. */
        for (const cb of racePeers) cb(side, 'bot', 0, typeof msg.name === 'string' ? msg.name : '');
        return;
      }
      case 'ABORTED':
        /* The operator pulled the board: the server states it on this frame, so it is the one
           ending that needs no reconnect attempt. */
        if (race && !raceDead) endAborted();
        return;
      case 'ERROR': {
        const reason = typeof msg.reason === 'string' ? msg.reason : 'ERROR';
        if (race) {
          /* A hard-down answer (maintenance, a ban, a season stop) is the server stating the race
             cannot continue at all. Anything else — a setup error on a recycled edge, a refused
             handshake — gets the same one-retry treatment a room error does, so a transient blink
             never reads as an operator kick. */
          if (!HARD_DOWN.has(reason) && raceTries === 0) {
            stopBeat();
            try { sock?.close(); } catch { /* already gone */ }
            return;
          }
          endAborted();
          return;
        }
        settled = true;
        /* the room refused us: this instance is finished, and its own close must not read as a
           dropped connection worth retrying */
        solo = true;
        teardown();
        try { sock?.close(); } catch { /* gone */ }
        sock = null;
        link = null;
        push({ ...lobby, status: 'closed' });
        opts.onError(reason);
        return;
      }
      default:
        return;
    }
  };

  /* One socket, reused by the lobby and by a live race. The race path never tears the view down
     on a drop: the server holds the seat and the reconnect window is short, so the socket is
     swapped underneath a board that keeps playing. */
  const attachSocket = (ws: WebSocket): void => {
    sock = ws;
    link = ws;
    ws.addEventListener('message', (ev) => {
      /* Frames from a socket this seat no longer wears are stale: a reconnect may already have
         delivered a newer snapshot, and an old MOVE must not overwrite it. */
      if (ws !== sock) return;
      onFrame((ev as MessageEvent).data);
    });
    ws.addEventListener('open', () => {
      if (ws !== sock) return;
      if (raceOpenTimer) {
        globalThis.clearTimeout(raceOpenTimer);
        raceOpenTimer = 0;
      }
      aliveAt = Date.now();
      startBeat();
      /* A fresh lobby socket is this seat's presence: the room may count down again. */
      if (!race) reportPresence(true);
      /* A resumed race paints from its snapshot, not from a roster placeholder. */
      if (race || settled) return;
      /* An open socket is not a roster: only a `LOBBY` frame is (`readLobby` flips the status).
         Flipping it here would let the placeholder — one seat, minted locally — pass for a real
         roster, and the arrival detector would read every reconnect as somebody joining. */
      paint();
    });
    ws.addEventListener('error', () => {
      if (ws !== sock) return;
      if (!race) { fallback(); return; }
      /* An error on an open race socket is a dying link: close it so the close path owns the
         reconnect instead of leaving the board waiting on a socket that will never speak again. */
      if (!raceDead) {
        try { ws.close(); } catch { /* already gone */ }
      }
    });
    ws.addEventListener('close', (ev: CloseEvent) => {
      if (ws !== sock) return;
      if (raceOpenTimer) {
        globalThis.clearTimeout(raceOpenTimer);
        raceOpenTimer = 0;
      }
      if (race && !raceDead) {
        /* An operator's own close carries the private code the worker sends with it: that is a
           real pull and the only close that ends the board on the spot. Every other close is a
           link that went away — a Cloudflare edge recycling the object included — and the silent
           resume ladder gets its chance to walk back into the same seat first. */
        if (ev && ev.code === OP_CLOSE_CODE) {
          endAborted();
          return;
        }
        /* A live board outlives a blinking mobile link: the room keeps the seat for its grace
           window, so retry fast instead of ending a match the rival is still playing. */
        stopBeat();
        sock = null;
        link = null;
        if (!raceDroppedAt) raceDroppedAt = Date.now();
        scheduleRaceResume();
        return;
      }
      teardown();
      if (race) {
        if (raceDead) return;      // already ended by a refusal or an exhausted reconnect
        markPostGone();
        for (const cb of raceEnds) cb({ win: false, why: 'drop' });
        return;
      }
      if (!settled) { fallback(); return; }
      /* the fallback, or our own `leave()`, closed this socket: the screen already knows */
      if (solo || left) return;
      /* A lobby whose socket died is still a lobby — the server holds the code, the seats and the
         crown for ten minutes. Keep the roster, say we are reconnecting, and let the screen own
         the retry: it is the one that knows whether the app is even on screen. */
      push({ ...lobby, status: 'connecting', online: true });
      opts.onDrop?.();
    });
  };

  const openRaceSocket = (): void => {
    if (left || solo || raceDead || !race) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(roomSocketUrl(lobby.code || opts.code, opts.host, lobby.format));
    } catch {
      scheduleRaceResume();
      return;
    }
    attachSocket(ws);
    /* A dead mobile link can leave a socket in CONNECTING for far longer than the grace is worth.
       Treat a stalled handshake as a failed attempt so the next backoff can actually run. */
    raceOpenTimer = globalThis.setTimeout(() => {
      raceOpenTimer = 0;
      if (ws !== sock || ws.readyState !== 0) return;
      sock = null;
      link = null;
      if (!raceDroppedAt) raceDroppedAt = Date.now();
      try { ws.close(); } catch { /* already gone */ }
      scheduleRaceResume();
    }, 4000);
  };

  /** Backoff for a live race's socket: fast enough that a tunnel never reaches the board. */
  const scheduleRaceResume = (): void => {
    if (left || solo || raceDead || !race || raceTimer) return;
    let wait: number;
    if (raceTries < RACE_RESUME_STEPS.length) {
      wait = RACE_RESUME_STEPS[raceTries++];
    } else if (raceDroppedAt > 0 && Date.now() - raceDroppedAt < RACE_GRACE_MS) {
      /* The fast attempts are spent but the room still holds the seat: keep a slow beat until
         the same 25 seconds the server promised have run out. */
      wait = 2000;
    } else {
      raceDead = true;
      outbox.length = 0;
      teardown();
      markPostGone();
      for (const cb of raceEnds) cb({ win: false, why: 'drop' });
      return;
    }
    raceTimer = globalThis.setTimeout(() => {
      raceTimer = 0;
      openRaceSocket();
    }, wait);
  };

  try {
    attachSocket(new WebSocket(roomSocketUrl(lobby.code || opts.code, opts.host, lobby.format)));
  } catch {
    sock = null;
  }
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);

  /**
   * The connect window. A socket still in `CONNECTING` is a slow network, not a missing server —
   * a webview that was suspended in a Telegram chat can take seconds to open one, and the room
   * behind it is worth the wait. Only a socket that never even got made, or one that keeps
   * stalling, falls back; a host's room must not become a solo race while its guests can still
   * join it.
   */
  let waits = 0;
  function watch(): void {
    if (settled) return;
    if (sock?.readyState === 0 && waits++ < 2) {
      timer = globalThis.setTimeout(watch, CONNECT_MS);
      return;
    }
    fallback();
  }

  let timer = globalThis.setTimeout(watch, CONNECT_MS);

  paint();

  return {
    get lobby() { return lobby; },
    addBot(seat) {
      /* a bot only ever fills a well that is actually open, and only in a lobby with no server */
      if (lobby.online || seat < 0 || seat >= lobby.seats.length || lobby.seats[seat]) return;
      push({
        ...lobby,
        seats: lobby.seats.map((s, i) => (i === seat
          ? {
            seat, id: `bot:${i}`, name: i === 1 ? 'Bot' : `Bot ${i}`, initial: 'B',
            host: false, bot: true, team: teamFor(lobby), connected: true, active: true, busy: false,
          }
          : s)),
      });
    },
    setFormat(format) {
      if (!isHost(lobby)) return false;
      const next = setFormat(lobby, format);
      if (next === lobby) return false;
      push(next);
      send({ type: 'SET_FORMAT', format });
      return true;
    },
    setTeam(seat, team) {
      if (lobby.mode !== 'team') return;
      if (!isHost(lobby) && seat !== lobby.you) return;
      const next = setTeam(lobby, seat, team);
      if (next === lobby) return;
      push(next);
      send({ type: 'SET_TEAM', side: seat, team });
    },
    kick(seat) {
      if (!isHost(lobby)) return false;
      if (!Number.isInteger(seat) || seat < 0 || seat >= lobby.seats.length) return false;
      /* the crown's own chair is not the host's to remove: leaving it is `leave()` */
      if (seat === lobby.you || seat === lobby.hostSeat) return false;
      const target = lobby.seats[seat];
      if (!target) return false;
      if (lobby.online) return send({ type: 'KICK', side: seat });
      /* offline, the only removable chair is a bot the host seated: clear it locally */
      if (!target.bot) return false;
      push({ ...lobby, seats: lobby.seats.map((s, i) => (i === seat ? null : s)) });
      return true;
    },
    setBusy(busy) {
      if (!lobby.online) return;
      send({ type: 'BUSY', busy });
    },
    start() {
      if (!isHost(lobby) || !canStart(lobby)) return false;
      chime();
      if (lobby.online) {
        /* `START_MATCH` is the crisp tap the worker gates on presence; false means the frame never
           left the device (socket closed or still connecting), and the screen says so. */
        return send({ type: 'START_MATCH' });
      }
      return true;
    },
    leave() {
      globalThis.clearTimeout(timer);
      if (raceTimer) {
        globalThis.clearTimeout(raceTimer);
        raceTimer = 0;
      }
      if (raceOpenTimer) {
        globalThis.clearTimeout(raceOpenTimer);
        raceOpenTimer = 0;
      }
      left = true;
      clearPendingMove();
      outbox.length = 0;
      teardown();
      /* `LEAVE`, not `CANCEL`: a host's exit disbands the code on the server so a stale link is
         refused cleanly, while a guest's only gives their own seat back. */
      if (lobby.online) send({ type: 'LEAVE' });
      try { sock?.close(); } catch { /* gone */ }
      sock = null;
      link = null;
      lobby = { ...lobby, status: 'closed' };
    },
  };
}

/** Close whatever socket the last lobby left behind (a screen teardown, or a reload guard). */
export function closeLobbyLink(): void {
  try { link?.close(); } catch { /* already gone */ }
  link = null;
}
