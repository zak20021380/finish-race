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
import type { Action } from './rules';
import { PHRASE_COUNT, isChatEmoteId, isChatLang, type ChatEmoteId, type ChatLang } from './data/phrases';
import { chime, myTier, myTiq, roomSocketUrl, type MindTier, type OpponentData } from './matchmaking';
import { profile } from './storage';
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
  host: boolean;
  /** True when the machine holds the seat (a backfilled bot, or one the host added). */
  bot: boolean;
  /** 0 = Team Blue, 1 = Team Orange. Only read in `team` mode. */
  team: 0 | 1;
  /** True while this seat's socket is open; a reserved host seat reads false and can still hold. */
  connected: boolean;
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
}

/**
 * A live room race. Structurally the same contract as `OnlineSession` — same `side`/`sizes`/`send`
 * /`onMove` shape — so `startGame()` runs it without a second code path. `opponent` is the seat the
 * HUD would otherwise paint as "the rival"; a room names all four from its roster, so it is only a
 * fallback for the two-seat case.
 */
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
  resign(): void;
  close(): void;
  onMove(cb: (action: Action, side: number) => void): void;
  /** An emote another seat sent. */
  onEmote(cb: (emote: ChatEmoteId, side: number) => void): void;
  /** A tactical line another seat sent, as the pair they tapped. */
  onPhrase(cb: (lang: ChatLang, index: number, side: number) => void): void;
  onEnd(cb: (end: { win: boolean; why: 'resign' | 'left' | 'drop' | 'aborted' }) => void): void;
  onReject(cb: (reason: string) => void): void;
}

/* ---------- the wire ---------- */

export interface LobbyOptions {
  code: string;
  /** True when this client minted the code and owns seat 0. */
  host: boolean;
  /** Repaints the sheet. Called on every roster change, including the fallback to solo. */
  onState: (lobby: Lobby) => void;
  /** The room launched: `main.ts` puts this on the board. */
  onRace: (race: LobbyRace) => void;
  /** The server refused us (a code that does not exist, a full room, maintenance). */
  onError: (reason: string) => void;
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
}

export interface LobbyHandle {
  readonly lobby: Lobby;
  /** Host only, and only in a lobby with no server behind it. */
  addBot(seat: number): void;
  /** Host only: the format switch. False when the pick changes nothing or nobody would fit. */
  setFormat(format: LobbyFormat): boolean;
  /** The host may move any seat; a player may move their own. Team formats only. */
  setTeam(seat: number, team: 0 | 1): void;
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

const faceOf = (name: string): string => (name.trim().charAt(0) || 'P').toUpperCase();

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

/** A lobby with only the host in it: a 1v1 room, the challenger's well open. */
export function hostLobby(code: string, name: string, online: boolean): Lobby {
  const face = myFace();
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
    busy: false,
  };
  return {
    code,
    capacity: 2,
    format: 'duel',
    mode: 'ffa',
    hostSeat: 0,
    seats: [host, null],
    you: 0,
    pendingHost: false,
    online,
    status: online ? 'connecting' : 'solo',
  };
}

/** One `LOBBY` frame, folded back into the model. Unknown seats are dropped, never trusted. */
function readLobby(l: Lobby, raw: Record<string, unknown>): Lobby {
  /* The format is the authority for the roster's shape; a frame without one (or an older server)
     falls back to what the seats and mode imply. */
  const format: LobbyFormat = isLobbyFormat(raw.format) ? raw.format
    : raw.mode === 'team' ? '2v2'
    : raw.capacity === 2 ? 'duel'
    : raw.capacity === 3 ? '3p' : '4p';
  const capacity = FORMAT_CAPACITY[format];
  const rows = Array.isArray(raw.seats) ? raw.seats : [];
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
      host: s.host === true || s.isHost === true,
      bot: s.bot === true,
      team: s.team === 1 ? 1 : 0,
      /* `online` is the worker's contract; `connected` is the older spelling, honoured too. */
      connected: s.online === false ? false : s.connected !== false,
      busy: s.busy === true,
    };
  }
  const hostSeat = typeof raw.host === 'number' ? raw.host : seats.findIndex((s) => !!s?.host);
  const you = mine;
  return {
    ...l,
    capacity,
    format,
    seats,
    hostSeat,
    mode: FORMAT_MODE[format],
    you,
    pendingHost: raw.pendingHost === true,
    online: true,
    status: 'live',
  };
}

/** The one socket a lobby ever opens. Kept module-level so leaving always closes the last one. */
let link: WebSocket | null = null;

export function openLobby(opts: LobbyOptions): LobbyHandle {
  let lobby = hostLobby(opts.code, myName(), true);
  let sock: WebSocket | null = null;
  let settled = false;
  /** True once the screen has accepted that there is no socket: the close it causes is not a drop. */
  let solo = false;
  let race: LobbyRace | null = null;
  /** True once `leave()` ran: the close it causes is this screen's own doing, not a drop. */
  let left = false;

  const paint = (): void => opts.onState(lobby);
  const push = (l: Lobby): void => { lobby = l; paint(); };

  /* The session's subscribers. They live out here because `MOVE` frames arrive after `ROOM_FOUND`
     has handed the race to `main.ts`, and the board wires its handlers on the frame that creates it. */
  const raceMoves: Array<(a: Action, side: number) => void> = [];
  const raceEmotes: Array<(emote: ChatEmoteId, side: number) => void> = [];
  const racePhrases: Array<(lang: ChatLang, index: number, side: number) => void> = [];
  const raceEnds: Array<(e: { win: boolean; why: 'resign' | 'left' | 'drop' | 'aborted' }) => void> = [];
  const raceRejects: Array<(r: string) => void> = [];

  /** Drop to the local lobby: the host is alone and may fill wells with the machine. */
  const fallback = (): void => {
    if (settled) return;
    settled = true;
    solo = true;
    try { sock?.close(); } catch { /* already gone */ }
    sock = null;
    link = null;
    /* An invited guest has nowhere to fall back to: the room they were promised is the room or
       nothing, and "nothing" has to be said out loud rather than dressed as a solo race. */
    if (opts.mustExist) {
      lobby = { ...lobby, status: 'closed', online: false };
      paint();
      opts.onError('room_not_found');
      return;
    }
    /* A resumed room is the same promise, made to the guests who can still join it: report the
       drop and let the screen try the wire again rather than quietly playing the machine. */
    if (opts.keepAlive) {
      lobby = { ...lobby, status: 'connecting', online: true };
      paint();
      opts.onDrop?.();
      return;
    }
    const offline = hostLobby(opts.code, lobby.seats[0]?.name ?? myName(), false);
    lobby = setFormat(offline, lobby.format);
    paint();
  };

  const send = (msg: Record<string, unknown>): boolean => {
    if (!sock || sock.readyState !== 1) return false;
    try {
      sock.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  };

  /** Fold one frame from the worker into the model. */
  const onFrame = (raw: unknown): void => {
    /* after an explicit leave nothing this socket still says matters: the screen is gone */
    if (left) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'LOBBY':
        settled = true;
        push(readLobby(lobby, msg));
        return;
      case 'FORMAT_DENIED':
        /* the room did not take the pick — usually every seat is held; the LOBBY that follows
           puts the selector back where the room says it is, and the nudge explains the bounce */
        opts.onNotice?.(typeof msg.reason === 'string' ? msg.reason : 'format_denied');
        return;
      case 'ROOM_FOUND': {
        settled = true;
        const seats = Array.isArray(msg.seats) ? msg.seats : [];
        const roster: LobbyRaceSeat[] = seats.map((r, i) => {
          const s = r as Record<string, unknown>;
          return {
            side: typeof s.side === 'number' ? s.side : i,
            id: typeof s.id === 'string' ? s.id : `seat:${i}`,
            name: typeof s.name === 'string' ? s.name : `Seat ${i + 1}`,
            bot: s.bot === true,
            team: s.team === 1 ? 1 : 0,
          };
        });
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
            tiq: myTiq(),
            tier: myTier(),
            avatarUrl: null,
            initial: faceOf(rival?.name ?? 'R'),
            flag: profile.country ?? null,
          },
          send: (a) => send({ type: 'MOVE', action: a }),
          sendEmote: (emote) => send({ type: 'EMOTE', emote }),
          sendPhrase: (lang, index) => send({ type: 'PHRASE', lang, index }),
          resign: () => { send({ type: 'RESIGN' }); },
          close: () => { try { sock?.close(); } catch { /* gone */ } },
          onMove: (cb) => { raceMoves.push(cb); },
          onEmote: (cb) => { raceEmotes.push(cb); },
          onPhrase: (cb) => { racePhrases.push(cb); },
          onEnd: (cb) => { raceEnds.push(cb); },
          onReject: (cb) => { raceRejects.push(cb); },
        };
        opts.onRace(race);
        return;
      }
      case 'MOVE':
        for (const cb of raceMoves) cb(msg.action as Action, Number(msg.side) || 0);
        return;
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
      case 'REJECT':
        for (const cb of raceRejects) cb(typeof msg.reason === 'string' ? msg.reason : 'refused');
        return;
      case 'SEAT_BOT':
        /* a seat's person left mid-race: the machine finished it, and the board already knows */
        return;
      case 'ERROR': {
        const reason = typeof msg.reason === 'string' ? msg.reason : 'ERROR';
        if (race) {
          for (const cb of raceEnds) cb({ win: false, why: 'aborted' });
          return;
        }
        settled = true;
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

  /* The frame lists are module-level so `MOVE` can reach the session `ROOM_FOUND` just built. */
  try {
    sock = new WebSocket(roomSocketUrl(opts.code, opts.host));
    link = sock;
    sock.addEventListener('message', (ev) => onFrame((ev as MessageEvent).data));
    sock.addEventListener('open', () => {
      if (settled || !sock) return;
      /* An open socket is not a roster: only a `LOBBY` frame is (`readLobby` flips the status).
         Flipping it here would let the placeholder — one seat, minted locally — pass for a real
         roster, and the arrival detector would read every reconnect as somebody joining. */
      paint();
    });
    sock.addEventListener('error', () => { if (!race) fallback(); });
    sock.addEventListener('close', () => {
      if (race) { for (const cb of raceEnds) cb({ win: false, why: 'drop' }); return; }
      if (!settled) { fallback(); return; }
      /* the fallback, or our own `leave()`, closed this socket: the screen already knows */
      if (solo || left) return;
      /* A lobby whose socket died is still a lobby — the server holds the code, the seats and the
         crown for ten minutes. Keep the roster, say we are reconnecting, and let the screen own
         the retry: it is the one that knows whether the app is even on screen. */
      push({ ...lobby, status: 'connecting', online: true });
      opts.onDrop?.();
    });
  } catch {
    sock = null;
  }

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
            host: false, bot: true, team: teamFor(lobby), connected: true, busy: false,
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
    setBusy(busy) {
      if (!lobby.online) return;
      send({ type: 'BUSY', busy });
    },
    start() {
      if (!isHost(lobby) || !canStart(lobby)) return false;
      chime();
      if (lobby.online) {
        send({ type: 'ROOM_START' });
        return true;
      }
      return true;
    },
    leave() {
      globalThis.clearTimeout(timer);
      left = true;
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
