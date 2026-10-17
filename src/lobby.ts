/**
 * lobby.ts — the friends lobby: a live roster of up to four seats, the host's match format, and
 * the one socket that keeps every seat's copy of it identical.
 *
 * Three ideas hold the whole screen together:
 *
 *   1. **The roster is data, not DOM.** `Lobby` is a plain value, and every mutation is a pure
 *      function on it (`seatIn`, `vacate`, `setMode`, `setTeam`). The sheet re-reads the value and
 *      repaints; nothing about a slot's look is stored in a closure. That is what lets the host
 *      migration below be a two-line rule instead of a screen rebuild.
 *
 *   2. **One host, one format.** The host seat owns `mode` and every seat's `team`. A guest's copy
 *      is read-only: it renders the same segmented switch, but the switch does nothing. Promotion is
 *      implicit — `vacate()` hands the crown to the lowest seat still held, so a lobby whose host
 *      walks out never becomes a room nobody can start.
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
import { MAX_TEAMS, type Action } from './rules';
import { chime, myTier, myTiq, roomSocketUrl, type MindTier, type OpponentData } from './matchmaking';
import { profile } from './storage';

/** How the room plays: everyone for themselves, or two teams. */
export type LobbyMode = 'ffa' | 'team';

/** One held seat. A `null` in `Lobby.seats` is an open well. */
export interface LobbySeat {
  seat: number;
  /** The player's stable key on the wire; local fallbacks mint their own. */
  id: string;
  name: string;
  /** The avatar letter, so a slot never paints an empty circle. */
  initial: string;
  host: boolean;
  /** True when the machine holds the seat (a backfilled bot, or one the host added). */
  bot: boolean;
  /** 0 = Team Blue, 1 = Team Red. Only read in `team` mode. */
  team: 0 | 1;
  connected: boolean;
}

export interface Lobby {
  code: string;
  capacity: number;
  mode: LobbyMode;
  /** The seat wearing the crown. Always a held seat while the lobby is open. */
  hostSeat: number;
  seats: (LobbySeat | null)[];
  /** My own seat, or -1 while the server has not answered yet. */
  you: number;
  /** True while a socket carries this lobby; false is the local fallback. */
  online: boolean;
  status: 'connecting' | 'live' | 'solo' | 'closed';
}

/* ---------- the roster, as pure arithmetic ---------- */

export const occupied = (l: Lobby): number => l.seats.reduce((n, s) => n + (s ? 1 : 0), 0);

export const humans = (l: Lobby): number => l.seats.reduce((n, s) => n + (s && !s.bot ? 1 : 0), 0);

export const isHost = (l: Lobby): boolean => l.you >= 0 && l.you === l.hostSeat;

/** Two players is the smallest race the rules can play, so it is the smallest a lobby may start. */
export const canStart = (l: Lobby): boolean => occupied(l) >= 2;

/** The team a fresh seat joins: the emptier one, so a 2v2 fills Blue/Red/Blue/Red. */
export function teamFor(l: Lobby): 0 | 1 {
  const blue = l.seats.reduce((n, s) => n + (s && s.team === 0 ? 1 : 0), 0);
  const red = l.seats.reduce((n, s) => n + (s && s.team === 1 ? 1 : 0), 0);
  return blue <= red ? 0 : 1;
}

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

/** The host's format switch. Guests never reach this: the sheet gates it on `isHost`. */
export const setMode = (l: Lobby, mode: LobbyMode): Lobby => (l.mode === mode ? l : { ...l, mode });

/** Move one seat between Blue and Red. Host only, and only meaningful in `team` mode. */
export function setTeam(l: Lobby, seat: number, team: 0 | 1): Lobby {
  const s = l.seats[seat];
  if (!s || s.team === team) return l;
  return { ...l, seats: l.seats.map((x, i) => (i === seat && x ? { ...x, team } : x)) };
}

/** Alternate Blue/Red down the seat order: the one-tap way out of a lopsided 2v2. */
export function balanceTeams(l: Lobby): Lobby {
  let n = 0;
  return {
    ...l,
    seats: l.seats.map((s) => {
      if (!s) return s;
      const team = (n++ % 2) as 0 | 1;
      return s.team === team ? s : { ...s, team };
    }),
  };
}

/** The mode's one-line promise, printed under the switch. */
export const MODE_LINE: Record<LobbyMode, string> = {
  ffa: 'Free-for-all: last player standing wins',
  team: 'Team Battle: work together to reach the goal',
};

export const MODE_NAME: Record<LobbyMode, string> = { ffa: 'Individual', team: 'Team Match' };

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
  resign(): void;
  close(): void;
  onMove(cb: (action: Action, side: number) => void): void;
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
}

export interface LobbyHandle {
  readonly lobby: Lobby;
  /** Host only, and only in a lobby with no server behind it. */
  addBot(seat: number): void;
  setMode(mode: LobbyMode): void;
  setTeam(seat: number, team: 0 | 1): void;
  /** Host only. False when the race cannot start yet (fewer than two seats). */
  start(): boolean;
  leave(): void;
  /** The socket died mid-race: tell the board the room is gone. */
  closed(cb: () => void): void;
}

/** How long a lobby waits for a socket before it accepts that it is playing alone. */
const CONNECT_MS = 1400;

const faceOf = (name: string): string => (name.trim().charAt(0) || 'P').toUpperCase();

/** The name this device races under — the same one the 1v1 queue sends. */
function myName(): string {
  const el = document.getElementById('p-name')?.textContent?.trim();
  const tg = (window as unknown as { Telegram?: { WebApp?: { initDataUnsafe?: { user?: { first_name?: string; username?: string } } } } })
    .Telegram?.WebApp?.initDataUnsafe?.user;
  return (el || tg?.first_name || tg?.username || 'You').slice(0, 14);
}

/** A lobby with only the host in it: seat 0 held, three wells open. */
export function hostLobby(code: string, name: string, online: boolean): Lobby {
  const host: LobbySeat = {
    seat: 0, id: 'you', name, initial: faceOf(name), host: true, bot: false, team: 0, connected: true,
  };
  return {
    code,
    capacity: MAX_TEAMS,
    mode: 'ffa',
    hostSeat: 0,
    seats: [host, null, null, null],
    you: 0,
    online,
    status: online ? 'connecting' : 'solo',
  };
}

/** One `LOBBY` frame, folded back into the model. Unknown seats are dropped, never trusted. */
function readLobby(l: Lobby, raw: Record<string, unknown>): Lobby {
  const rows = Array.isArray(raw.seats) ? raw.seats : [];
  const seats: (LobbySeat | null)[] = Array.from({ length: l.capacity }, () => null);
  for (const r of rows) {
    const s = r as Record<string, unknown>;
    const at = typeof s.side === 'number' ? s.side : -1;
    if (at < 0 || at >= l.capacity) continue;
    const name = typeof s.name === 'string' ? s.name.slice(0, 14) : 'Player';
    seats[at] = {
      seat: at,
      id: typeof s.id === 'string' ? s.id : `seat:${at}`,
      name,
      initial: faceOf(name),
      host: s.host === true,
      bot: s.bot === true,
      team: s.team === 1 ? 1 : 0,
      connected: s.connected !== false,
    };
  }
  const hostSeat = typeof raw.host === 'number' ? raw.host : seats.findIndex((s) => !!s?.host);
  const mode: LobbyMode = raw.mode === 'team' ? 'team' : 'ffa';
  const you = typeof raw.you === 'number' ? raw.you : l.you;
  return {
    ...l,
    seats,
    hostSeat,
    mode,
    you,
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
  let onClosed: (() => void) | null = null;

  const paint = (): void => opts.onState(lobby);
  const push = (l: Lobby): void => { lobby = l; paint(); };

  /* The session's subscribers. They live out here because `MOVE` frames arrive after `ROOM_FOUND`
     has handed the race to `main.ts`, and the board wires its handlers on the frame that creates it. */
  const raceMoves: Array<(a: Action, side: number) => void> = [];
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
    lobby = { ...hostLobby(opts.code, lobby.seats[0]?.name ?? myName(), false), mode: lobby.mode };
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
          resign: () => { send({ type: 'RESIGN' }); },
          close: () => { try { sock?.close(); } catch { /* gone */ } },
          onMove: (cb) => { raceMoves.push(cb); },
          onEnd: (cb) => { raceEnds.push(cb); },
          onReject: (cb) => { raceRejects.push(cb); },
        };
        opts.onRace(race);
        return;
      }
      case 'MOVE':
        for (const cb of raceMoves) cb(msg.action as Action, Number(msg.side) || 0);
        return;
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
      lobby = { ...lobby, status: 'live' };
      paint();
    });
    sock.addEventListener('error', () => { if (!race) fallback(); });
    sock.addEventListener('close', () => {
      if (race) { for (const cb of raceEnds) cb({ win: false, why: 'drop' }); return; }
      if (!settled) { fallback(); return; }
      /* the fallback closed this socket itself: the screen is already a solo lobby */
      if (solo) return;
      /* a lobby whose socket died mid-session is no longer a lobby: hand the screen back */
      push({ ...lobby, status: 'closed', online: false });
      onClosed?.();
    });
  } catch {
    sock = null;
  }

  const timer = globalThis.setTimeout(() => { if (!settled) fallback(); }, CONNECT_MS);

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
            host: false, bot: true, team: teamFor(lobby), connected: true,
          }
          : s)),
      });
    },
    setMode(mode) {
      if (!isHost(lobby)) return;
      const next = setMode(lobby, mode);
      if (next === lobby) return;
      push(next);
      send({ type: 'SET_MODE', mode });
    },
    setTeam(seat, team) {
      if (!isHost(lobby)) return;
      const next = setTeam(lobby, seat, team);
      if (next === lobby) return;
      push(next);
      send({ type: 'SET_TEAM', side: seat, team });
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
      if (lobby.online) send({ type: 'CANCEL' });
      try { sock?.close(); } catch { /* gone */ }
      sock = null;
      link = null;
      lobby = { ...lobby, status: 'closed' };
    },
    closed(cb) { onClosed = cb; },
  };
}

/** Close whatever socket the last lobby left behind (a screen teardown, or a reload guard). */
export function closeLobbyLink(): void {
  try { link?.close(); } catch { /* already gone */ }
  link = null;
}
