/**
 * matchmaking.ts — the 1v1 searching stage: radar, clock, match-found impact.
 *
 * Quick match no longer drops straight onto the board: the mode drawer hands the
 * seat to this module, which owns one full-viewport clay stage — the two-orb
 * arena (you on the left, the rival still a silhouette on the right), the synapse
 * line and its rings sweeping outward between them, the elapsed clock and the
 * cycling status line.
 *
 * `source` is the seam a transport plugs into: it takes an `AbortSignal` (plus the current `wide`
 * skill filter) and resolves with the `OpponentData` it found. `onlineSearch()` is the real one —
 * one socket to the Worker's matchmaker (`worker/`), which answers with the opponent and the
 * `{ matchId, seed, side, sizes }` the race will run on. With no Worker behind the page (a static
 * preview, a `file://` tab, a refused upgrade) that same socket call falls back to the
 * `simulatedSearch()` that has always answered after ~4s, so the stage is never left spinning. A
 * transport that rejects for its own reasons falls back the same way.
 *
 * A matched socket does not stop being useful at `MATCH_FOUND`: the SAME connection carries the
 * race. `onlineRace()` hands back the seat plus `send()`/`onMove()`/`onEnd()`, so `main.ts` plays
 * the move locally and lets the matchmaker hand it to the rival. A session the fallback never
 * opened is simply null, and the race runs against the local bot exactly as it always did.
 *
 * A queue that stays silent for `QUIET_MS` stops promising and asks: the stage
 * offers a widened radius (the same clock, a relaxed filter) and a seat against
 * the bot (`onPractice`), so nobody is left sweeping an empty radar.
 *
 * Contract with the shell: `onMatchFound(opponent)` fires after the 300ms impact
 * animation has locked the rival in — the caller starts the race and the stage
 * fades away behind the board. `onCancel` is the player aborting, which returns
 * them to mode selection. Motion is transform/opacity only; the global
 * reduced-motion block stills the rings, the pulse and the flash.
 */
import { COLS, ROWS, type Action } from './rules';
import { menuState, motionReduced, settings } from './settings';
import { profile } from './storage';
import { impact, notify, tgInitData, tgUser } from './telegram';

/* ---------- TIQ: the same reading the ladder prints ---------- */

export type MindTier = 'rookie' | 'tactician' | 'strategist' | 'grandmaster';

export const TIER_NAME: Record<MindTier, string> = {
  rookie: 'Rookie',
  tactician: 'Tactician',
  strategist: 'Strategist',
  grandmaster: 'Grandmaster',
};

/** TIQ bands, matching the ladder's aura colours in `compete.ts`. */
export function tierOf(tiq: number): MindTier {
  if (tiq >= 3000) return 'grandmaster';
  if (tiq >= 2000) return 'strategist';
  if (tiq >= 1000) return 'tactician';
  return 'rookie';
}

/** Your TIQ: a win is worth 120 and every race lands 20 — the ladder's own formula. */
export function myTiq(): number {
  return Math.max(0, profile.stats.wins * 120 + profile.stats.games * 20);
}

export interface OpponentData {
  /** Stable key for the seat, so a real transport can send a real id later. */
  id: string;
  name: string;
  tiq: number;
  tier: MindTier;
  avatarUrl: string | null;
  /** Drawn when the rival carries no photo. */
  initial: string;
}

/** What this attempt is asking for: `wide` is the relaxed skill filter. */
export interface MatchSourceOptions {
  /** True once the player widened the search after a quiet queue. */
  wide: boolean;
}

/** What a transport looks like: resolve with a match, or reject (abort/offline). */
export type MatchSource = (signal: AbortSignal, opts: MatchSourceOptions) => Promise<OpponentData>;

/* ---------- the waiting room: a seeded pool, no server required ---------- */

const RIVALS: ReadonlyArray<{ id: string; name: string; tiq: number }> = [
  { id: 'r-nadia', name: 'Nadia K.', tiq: 1240 },
  { id: 'r-rune', name: 'Rune', tiq: 1875 },
  { id: 'r-ivo', name: 'Ivo Petrov', tiq: 2140 },
  { id: 'r-mira', name: 'Mira', tiq: 2680 },
  { id: 'r-sable', name: 'Sable', tiq: 3150 },
  { id: 'r-kenji', name: 'Kenji', tiq: 980 },
  { id: 'r-lior', name: 'Lior', tiq: 1545 },
  { id: 'r-ada', name: 'Ada W.', tiq: 2360 },
];

const asOpponent = (r: { id: string; name: string; tiq: number }): OpponentData => ({
  id: r.id,
  name: r.name,
  tiq: r.tiq,
  tier: tierOf(r.tiq),
  avatarUrl: null,
  initial: (r.name.charAt(0) || '?').toUpperCase(),
});

/**
 * The closest three minds to your own — a believable queue, never a random blowout.
 * `wide` is the radius the stage asks for once the queue has gone quiet: every
 * rival is fair game, and a ±400 TIQ wobble keeps a widened search from landing on
 * the same nearest-three answer twice.
 */
export function pickRival(mine: number = myTiq(), wide = false): OpponentData {
  if (wide) {
    const pool = RIVALS.map((r) => ({ ...r, tiq: Math.max(0, r.tiq + Math.round((Math.random() - 0.5) * 800)) }));
    return asOpponent(pool[Math.floor(Math.random() * pool.length)]);
  }
  const near = [...RIVALS].sort((a, b) => Math.abs(a.tiq - mine) - Math.abs(b.tiq - mine)).slice(0, 3);
  return asOpponent(near[Math.floor(Math.random() * near.length)]);
}

const aborted = (): Error => {
  const e = new Error('matchmaking aborted');
  e.name = 'AbortError';
  return e;
};

/** A transport that answers after `waitMs`, honouring the stage's abort signal. */
export const simulatedSearch = (waitMs = 4000): MatchSource => (signal, opts) =>
  new Promise<OpponentData>((resolve, reject) => {
    const done = (fn: () => void) => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => done(() => reject(aborted()));
    const timer = window.setTimeout(() => done(() => resolve(pickRival(myTiq(), opts.wide))), waitMs);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });

/* ---------- the shell's own identity, read once per search ---------- */

const domText = (id: string, fallback: string): string => {
  const t = document.getElementById(id)?.textContent?.trim();
  return t ? t : fallback;
};

interface Face {
  name: string;
  initial: string;
  avatarUrl: string | null;
}

function readFace(fallbackName: string): Face {
  const img = document.getElementById('avatar-img') as HTMLImageElement | null;
  const u = tgUser();
  const name = (domText('p-name', '') || u?.first_name || u?.username || fallbackName).trim();
  const avatarUrl = (img && !img.hidden && img.src ? img.src : null) ?? u?.photo_url ?? null;
  const letter = domText('avatar-t', '') || name.charAt(0) || 'P';
  return { name, initial: letter.slice(0, 1).toUpperCase(), avatarUrl };
}

/* ---------- online transport: the Worker's waiting room, and the race it turns into ---------- */

/** What the upcoming online race runs on: the id both sides agree on, the shared seed, your side. */
export interface OnlineMatch {
  matchId: string;
  seed: number;
  side: 0 | 1;
  /** The board both seats asked for: two sides only ever race the same game. */
  sizes: [number, number];
}

/** Why a race ended before anyone reached FINISH. */
export interface RaceEnd {
  /** True when the win is yours. */
  win: boolean;
  /** The rival quit, the rival's socket died, or ours did. */
  why: 'resign' | 'left' | 'drop';
}

/**
 * A live online race. The socket that queued is the socket that plays: `send()` hands a move to the
 * matchmaker, which judges it against the real board and relays it to the rival.
 */
export interface OnlineSession extends OnlineMatch {
  opponent: OpponentData;
  socket: WebSocket;
  /** Send one legal move to the rival. False when the socket is gone. */
  send(action: Action): boolean;
  /** Forfeit: the rival wins immediately. */
  resign(): void;
  /** Let the socket go (no forfeit): the session is done being a race. */
  close(): void;
  /** A move the rival made, in the order the matchmaker accepted it. */
  onMove(cb: (action: Action, side: 0 | 1) => void): void;
  /** The race ended without a finish line. */
  onEnd(cb: (end: RaceEnd) => void): void;
  /** The matchmaker refused a move: the two boards have drifted apart. */
  onReject(cb: (reason: string) => void): void;
}

/** One frame the room can send (`worker/matchmaker.ts` is its only producer). */
type RaceFrame =
  | { type: 'MATCH_FOUND'; matchId: string; seed: number; side: 0 | 1; sizes: [number, number];
      opponent: { name: string; tiq: number; tier: string; flag: string } }
  | { type: 'MOVE'; side: 0 | 1; action: Action }
  | { type: 'REJECT'; reason: string }
  | { type: 'RESIGN' | 'OPPONENT_LEFT'; side: 0 | 1 };

/** An attempt the socket is answering. Only the newest one is allowed to settle. */
interface Seat {
  run: number;
  signal: AbortSignal;
  opts: MatchSourceOptions;
  resolve: (opponent: OpponentData) => void;
  reject: (error: Error) => void;
}

const TIERS: ReadonlyArray<MindTier> = ['rookie', 'tactician', 'strategist', 'grandmaster'];

/** Keep the socket's tier label if it is one we know; otherwise read it off the TIQ. */
const asTier = (value: string, tiq: number): MindTier =>
  (TIERS as readonly string[]).includes(value) ? (value as MindTier) : tierOf(tiq);

/** `VITE_WS_URL`, or same-origin `/ws/matchmake`. '' means there is no origin to hang one off. */
const WS_URL = import.meta.env.VITE_WS_URL?.trim() ?? '';

function socketUrl(): string {
  if (WS_URL) {
    if (WS_URL.startsWith('ws://') || WS_URL.startsWith('wss://')) return WS_URL;
    const base = WS_URL.startsWith('http') ? WS_URL : `https://${WS_URL}`;
    return base.replace(/^http/, 'ws');
  }
  return location.host ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/matchmake` : '';
}

/** Identity first, then the numbers the matchmaker filters on. */
function socketParams(wide: boolean): string {
  const tiq = myTiq();
  const params = new URLSearchParams();
  const init = tgInitData();
  if (init) params.set('initData', init);
  params.set('tiq', String(tiq));
  params.set('tier', tierOf(tiq));
  params.set('flag', profile.country ?? '');
  params.set('name', readFace('Player').name);
  params.set('wide', wide ? '1' : '0');
  /* the board this search is for: the matchmaker only pairs two seats playing the same game */
  params.set('sizes', menuState.sizes.join(','));
  return params.toString();
}

/** The board the room said both seats are playing, or the one this client asked for. */
function readBoard(raw: unknown): [number, number] {
  if (Array.isArray(raw) && raw.length === 2) {
    const pair = raw.map((n) => (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 3 ? n : NaN));
    if (pair.every((n) => !Number.isNaN(n))) return [pair[0], pair[1]];
  }
  return [menuState.sizes[0], menuState.sizes[1]];
}

const onBoard = (v: unknown): v is { c: number; r: number } => {
  const p = v as { c?: unknown; r?: unknown } | null;
  return !!p && Number.isInteger(p.c) && Number.isInteger(p.r)
    && (p.c as number) >= 0 && (p.c as number) < COLS && (p.r as number) >= 0 && (p.r as number) < ROWS;
};

/**
 * An action rebuilt from the wire, never trusted as it arrived — the same guards the room applies
 * on the way out, so a frame the matchmaker would refuse cannot break this board either.
 */
function readAction(raw: unknown, side: 0 | 1): Action | null {
  const a = raw as { kind?: unknown; ball?: unknown; to?: unknown; wall?: unknown; cell?: unknown } | null;
  if (!a || typeof a !== 'object') return null;
  if (a.kind === 'move') {
    if (!onBoard(a.to)) return null;
    if (a.ball !== undefined && !Number.isInteger(a.ball)) return null;
    const to = { c: a.to.c, r: a.to.r };
    return a.ball === undefined ? { kind: 'move', to } : { kind: 'move', to, ball: a.ball as number };
  }
  if (a.kind === 'wall') {
    const w = a.wall as { o?: unknown; x?: unknown; y?: unknown } | null;
    if (!w || (w.o !== 'h' && w.o !== 'v') || !Number.isInteger(w.x) || !Number.isInteger(w.y)) return null;
    return { kind: 'wall', wall: { o: w.o, x: w.x as number, y: w.y as number, owner: side } };
  }
  if (a.kind === 'mine') {
    if (!onBoard(a.cell)) return null;
    return { kind: 'mine', cell: { c: a.cell.c, r: a.cell.r } };
  }
  return a.kind === 'pass' ? { kind: 'pass' } : null;
}

function parseFrame(raw: string): RaceFrame | null {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (!msg || typeof msg !== 'object') return null;
    const side: 0 | 1 = msg.side === 1 ? 1 : 0;
    if (msg.type === 'MATCH_FOUND') {
      const o = msg.opponent as { name?: unknown; tiq?: unknown; tier?: unknown; flag?: unknown } | null;
      if (typeof msg.matchId !== 'string' || typeof msg.seed !== 'number') return null;
      if (!o || typeof o.name !== 'string' || typeof o.tiq !== 'number') return null;
      return {
        type: 'MATCH_FOUND',
        matchId: msg.matchId,
        seed: msg.seed,
        side,
        sizes: readBoard(msg.sizes),
        opponent: {
          name: o.name,
          tiq: o.tiq,
          tier: typeof o.tier === 'string' ? o.tier : '',
          flag: typeof o.flag === 'string' ? o.flag : '',
        },
      };
    }
    if (msg.type === 'MOVE') {
      const action = readAction(msg.action, side);
      return action ? { type: 'MOVE', side, action } : null;
    }
    if (msg.type === 'REJECT') return { type: 'REJECT', reason: typeof msg.reason === 'string' ? msg.reason : 'refused' };
    if (msg.type === 'RESIGN' || msg.type === 'OPPONENT_LEFT') return { type: msg.type, side };
    return null;
  } catch {
    return null;                       // not ours: a frame we cannot read is a frame we ignore
  }
}

/** The one waiting-room socket per page: a widened search widens this one instead of rejoining. */
let ws: WebSocket | null = null;
let wsWide = false;
let wsMatched = false;
let wsRuns = 0;
let teardownId = 0;
let seat: Seat | null = null;

/** The live race, and the handlers `main.ts` puts on it. One race at a time, by construction. */
let race: OnlineSession | null = null;
let raceMove: ((action: Action, side: 0 | 1) => void) | null = null;
let raceEnd: ((end: RaceEnd) => void) | null = null;
let raceReject: ((reason: string) => void) | null = null;
/** Moves that landed between the match and the race screen: replayed the moment it subscribes. */
let raceQueue: Array<{ action: Action; side: 0 | 1 }> = [];

/** The seat the stage just locked in, for the race that follows it. Null until there is one. */
export const onlineRace = (): OnlineSession | null => race;

function post(sock: WebSocket, payload: string): void {
  try {
    if (sock.readyState === 1) sock.send(payload);
  } catch {
    /* the socket is already gone: the close handler will settle the attempt */
  }
}

function forget(sock: WebSocket): void {
  if (race?.socket === sock) {
    race = null;
    raceMove = null;
    raceEnd = null;
    raceReject = null;
    raceQueue = [];
  }
  try {
    sock.close(1000, 'done');
  } catch {
    /* already closed */
  }
}

/** The race is over without a finish line: hand the reason to whoever is listening. */
function endRace(sock: WebSocket, win: boolean, why: RaceEnd['why']): void {
  if (race?.socket !== sock) return;
  const ended = raceEnd;
  race = null;
  raceMove = null;
  raceEnd = null;
  raceReject = null;
  raceQueue = [];
  ended?.({ win, why });
}

function makeSession(sock: WebSocket, found: Extract<RaceFrame, { type: 'MATCH_FOUND' }>): OnlineSession {
  return {
    matchId: found.matchId,
    seed: found.seed,
    side: found.side,
    sizes: found.sizes,
    opponent: onlineOpponent(found),
    socket: sock,
    send(action) {
      if (race?.socket !== sock || sock.readyState !== 1) return false;
      try {
        sock.send(JSON.stringify({ type: 'MOVE', action }));
        return true;
      } catch {
        return false;
      }
    },
    resign() {
      post(sock, JSON.stringify({ type: 'RESIGN' }));
    },
    close() {
      forget(sock);
    },
    onMove(cb) {
      raceMove = cb;
      const queued = raceQueue;             // a rival can be quick: nothing is dropped on the floor
      raceQueue = [];
      for (const move of queued) cb(move.action, move.side);
    },
    onEnd(cb) {
      raceEnd = cb;
    },
    onReject(cb) {
      raceReject = cb;
    },
  };
}

/** The matchmaker's payload, in the shape the stage paints. */
function onlineOpponent(msg: { matchId: string; opponent: { name: string; tiq: number; tier: string } }): OpponentData {
  const name = msg.opponent.name.trim() || 'Rival';
  return {
    id: `online-${msg.matchId}`,
    name,
    tiq: msg.opponent.tiq,
    tier: asTier(msg.opponent.tier, msg.opponent.tiq),
    avatarUrl: null,
    initial: name.charAt(0).toUpperCase(),
  };
}

/** The socket went away: mid-race that is a loss, mid-search it is the local search's turn. */
function socketGone(sock: WebSocket): void {
  if (race?.socket === sock) { endRace(sock, false, 'drop'); return; }
  if (sock !== ws) return;             // a socket this search already let go of
  ws = null;
  wsWide = false;
  const lost = seat;
  seat = null;
  if (!lost) return;
  if (lost.signal.aborted) { lost.reject(aborted()); return; }
  simulatedSearch()(lost.signal, lost.opts).then(lost.resolve, lost.reject);
}

function wire(sock: WebSocket): void {
  sock.addEventListener('open', () => post(sock, JSON.stringify({ type: 'QUEUE', wide: wsWide })));
  sock.addEventListener('message', (ev) => {
    const frame = parseFrame(String(ev.data));
    if (!frame) return;

    if (frame.type === 'MATCH_FOUND') {
      if (race?.socket === sock) return;      // one match per socket: a repeat is not a new race
      wsMatched = true;
      const session = makeSession(sock, frame);
      race = session;
      const answered = seat;
      seat = null;
      answered?.resolve(session.opponent);
      return;
    }

    if (race?.socket !== sock) return;        // race traffic on a socket that is not racing
    if (frame.type === 'MOVE') {
      if (raceMove) raceMove(frame.action, frame.side);
      else raceQueue.push({ action: frame.action, side: frame.side });
    } else if (frame.type === 'REJECT') {
      raceReject?.(frame.reason);
    } else {
      endRace(sock, true, frame.type === 'RESIGN' ? 'resign' : 'left');
    }
  });
  sock.addEventListener('close', () => socketGone(sock));
  sock.addEventListener('error', () => socketGone(sock));
}

/** A CANCEL, then the close. A socket that already carried a match belongs to the race: it stays. */
function closeSocket(cancel: boolean): void {
  window.clearTimeout(teardownId);
  teardownId = 0;
  const sock = ws;
  const matched = wsMatched;
  ws = null;
  wsWide = false;
  wsMatched = false;
  if (!sock || matched) return;
  if (cancel) post(sock, JSON.stringify({ type: 'CANCEL' }));
  try {
    sock.close(1000, cancel ? 'cancelled' : 'done');
  } catch {
    /* already closed */
  }
}

function onAbort(attempt: Seat): void {
  if (seat?.run === attempt.run) seat = null;
  attempt.reject(aborted());
  if (wsMatched) return;               // the race owns the socket now: nothing to clean up
  /* A widen aborts and re-queues in the same tick, so the teardown waits one turn of the loop:
     a socket that is about to be widened is never cancelled out from under the new search. */
  window.clearTimeout(teardownId);
  teardownId = window.setTimeout(() => closeSocket(true), 0);
}

/**
 * The online transport: the `MatchSource` the stage queues with. It opens one socket to the
 * matchmaker, says who you are and how wide the net is, and resolves with the opponent it pairs
 * you with — storing the `{ matchId, seed, side }` the race will need. When the socket never
 * answers — a static preview with no Worker behind it — it answers with the local search instead.
 */
export function onlineSearch(): MatchSource {
  return (signal, opts) => new Promise<OpponentData>((resolve, reject) => {
    const attempt: Seat = { run: ++wsRuns, signal, opts, resolve, reject };
    window.clearTimeout(teardownId);
    teardownId = 0;
    /* A new search ends whatever race was carried before it: one page, one live seat. */
    if (race) forget(race.socket);
    if (signal.aborted) { reject(aborted()); return; }
    signal.addEventListener('abort', () => onAbort(attempt), { once: true });

    const url = socketUrl();
    if (!url) { simulatedSearch()(signal, opts).then(resolve, reject); return; }

    /* Already in the waiting room: widen it in place. WIDEN keeps the place this player has
       already earned, where a fresh QUEUE would send them to the back of the line. */
    if (ws && !wsMatched && (ws.readyState === 0 || ws.readyState === 1)) {
      const widening = opts.wide && !wsWide;
      wsWide = wsWide || opts.wide;
      seat = attempt;
      if (ws.readyState === 1) post(ws, JSON.stringify(widening ? { type: 'WIDEN' } : { type: 'QUEUE', wide: opts.wide }));
      return;                          // a connecting socket queues with this flag when it opens
    }

    closeSocket(true);                 // whatever else was left over is not this search's socket
    let sock: WebSocket;
    try {
      sock = new WebSocket(`${url}?${socketParams(opts.wide)}`);
    } catch {
      simulatedSearch()(signal, opts).then(resolve, reject);
      return;
    }
    seat = attempt;
    ws = sock;
    wsWide = opts.wide;
    wsMatched = false;
    wire(sock);
  });
}

/* ---------- the triumphant tick (sound + haptic) ---------- */

/** E5 then B5, 90ms apart: a short rising pair, never a jingle. */
const NOTES: ReadonlyArray<readonly [number, number]> = [[659.25, 0], [987.77, 0.09]];

let audio: AudioContext | null = null;

/** Respects the Sound switch; a webview without WebAudio simply gets the haptic. */
function chime(): void {
  if (!settings.sound) return;
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audio ??= new Ctor();
    const ctx = audio;
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime;
    for (const [freq, at] of NOTES) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const t = t0 + at;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.13, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    }
  } catch {
    /* no audio in this webview */
  }
}

/* ---------- controller ---------- */

export interface MatchmakingInit {
  /** How a match arrives. Defaults to the ~4s simulated search. */
  source?: MatchSource;
  /** Fires once the rival is locked in: start the race here. */
  onMatchFound?: (opponent: OpponentData) => void;
  /** The player aborted: return to mode selection here. */
  onCancel?: () => void;
  /** The queue stayed quiet and the player chose the bot instead. */
  onPractice?: () => void;
}

export interface Matchmaking {
  open(): void;
  /** Player-initiated abort: light haptic, then back to mode selection. */
  cancel(): void;
  /** How a real socket hands its match over. Ignores the call unless searching. */
  resolveMatch(opponent: OpponentData): void;
  setSource(source: MatchSource): void;
  setOnMatchFound(cb: (opponent: OpponentData) => void): void;
  readonly isOpen: boolean;
}

/** The cycling lines under the arena; the live region only ever says one thing. */
const STATUS: ReadonlyArray<string> = [
  'Scanning tactical tier...',
  'Matching cognitive tempo...',
  'Expanding search radius...',
];
const STATUS_MS = 2500;
/** The impact animation that locks the rival in. */
const IMPACT_MS = 300;
/** The stage's own fade, which the board slides in behind. */
const EXIT_MS = 240;
/** How long a silent queue waits before the stage offers a way out. */
const QUIET_MS = 12000;
/** A widened search answers sooner: the point of widening is to stop waiting. */
const WIDE_MS = 2500;
const WIDE_AGAIN_MS = 1500;

type Stage = 'idle' | 'searching' | 'found';

export function createMatchmaking(init: MatchmakingInit = {}): Matchmaking {
  const root = document.getElementById('overlay-matchmaking') as HTMLElement | null;
  const you = document.getElementById('mm-you') as HTMLElement | null;
  const rival = document.getElementById('mm-rival') as HTMLElement | null;
  const youImg = document.getElementById('mm-you-img') as HTMLImageElement | null;
  const youT = document.getElementById('mm-you-t') as HTMLElement | null;
  const youName = document.getElementById('mm-you-name') as HTMLElement | null;
  const youTiq = document.getElementById('mm-you-tiq') as HTMLElement | null;
  const rivalImg = document.getElementById('mm-rival-img') as HTMLImageElement | null;
  const rivalScan = document.getElementById('mm-rival-scan') as HTMLElement | null;
  const rivalT = document.getElementById('mm-rival-t') as HTMLElement | null;
  const rivalName = document.getElementById('mm-rival-name') as HTMLElement | null;
  const rivalTiq = document.getElementById('mm-rival-tiq') as HTMLElement | null;
  const statusEl = document.getElementById('mm-status') as HTMLElement | null;
  const elapsedEl = document.getElementById('mm-elapsed') as HTMLElement | null;
  const cancelBtn = document.getElementById('mm-cancel') as HTMLButtonElement | null;
  const liveEl = document.getElementById('mm-live') as HTMLElement | null;
  const fallbackEl = document.getElementById('mm-fallback') as HTMLElement | null;
  const expandBtn = document.getElementById('mm-expand') as HTMLButtonElement | null;
  const practiceBtn = document.getElementById('mm-practice') as HTMLButtonElement | null;

  let source: MatchSource = init.source ?? simulatedSearch();
  let onMatchFound = init.onMatchFound;
  let state: Stage = 'idle';
  let run = 0;
  let started = 0;
  let statusIdx = 0;
  let clockId = 0;
  let statusId = 0;
  let liveId = 0;
  let foundId = 0;
  let hideId = 0;
  let quietId = 0;
  /** How many times the player has widened this search: the second pass is a short re-roll. */
  let widenings = 0;
  let ctrl: AbortController | null = null;

  const stillHere = (id: number): boolean => id === run && state === 'searching';

  /** `mm:ss`, tabular figures in the markup. */
  const clock = (ms: number): string => {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };

  function stopTimers(): void {
    window.clearInterval(clockId);
    window.clearInterval(statusId);
    window.clearTimeout(liveId);
    window.clearTimeout(quietId);
    clockId = statusId = liveId = quietId = 0;
  }

  /** Back to the silhouette: the stage can be reopened without a stale rival in it. */
  function resetStage(): void {
    rival?.classList.remove('is-locked');
    if (rival) rival.dataset.tier = 'rookie';
    if (rivalScan) rivalScan.hidden = false;
    if (rivalT) rivalT.hidden = true;
    if (rivalImg) {
      rivalImg.hidden = true;
      rivalImg.removeAttribute('src');
    }
    if (rivalName) rivalName.textContent = 'Scanning...';
    if (rivalTiq) rivalTiq.textContent = '—';
    rival?.setAttribute('aria-label', 'Waiting for an opponent');
    if (statusEl) {
      statusEl.classList.remove('swap');
      statusEl.textContent = STATUS[0];
    }
    if (elapsedEl) elapsedEl.textContent = '00:00';
    statusIdx = 0;
    widenings = 0;
    clearQuiet();
    root?.classList.remove('is-found');
  }

  function paintFace(
    img: HTMLImageElement | null,
    initial: HTMLElement | null,
    face: { initial: string; avatarUrl: string | null },
  ): void {
    if (img && face.avatarUrl) {
      img.src = face.avatarUrl;
      img.hidden = false;
      if (initial) initial.hidden = true;
      return;
    }
    if (img) {
      img.hidden = true;
      img.removeAttribute('src');
    }
    if (initial) {
      initial.textContent = face.initial;
      initial.hidden = false;
    }
  }

  function paintYou(): void {
    const face = readFace('You');
    const tiq = myTiq();
    if (you) you.dataset.tier = tierOf(tiq);
    if (youName) youName.textContent = face.name;
    if (youTiq) youTiq.textContent = String(tiq);
    paintFace(youImg, youT, face);
    you?.setAttribute('aria-label', `${face.name}, TIQ ${tiq}, ${TIER_NAME[tierOf(tiq)]}`);
  }

  function paintRival(o: OpponentData): void {
    if (rival) rival.dataset.tier = o.tier;
    if (rivalName) rivalName.textContent = o.name;
    if (rivalTiq) rivalTiq.textContent = String(o.tiq);
    if (rivalScan) rivalScan.hidden = true;
    paintFace(rivalImg, rivalT, o);
    rival?.setAttribute('aria-label', `${o.name}, TIQ ${o.tiq}, ${TIER_NAME[o.tier]}`);
  }

  /** One line of the sweep, with its own fade so two neighbours never cross-fade. */
  function setStatus(text: string): void {
    if (!statusEl) return;
    statusEl.textContent = text;
    if (motionReduced()) return;
    statusEl.classList.remove('swap');
    void statusEl.offsetWidth;          // restarting the fade needs a reflow in between
    statusEl.classList.add('swap');
  }

  function cycleStatus(): void {
    statusIdx = (statusIdx + 1) % STATUS.length;
    setStatus(STATUS[statusIdx]);
  }

  function startCycling(): void {
    stopCycling();
    statusId = window.setInterval(cycleStatus, STATUS_MS);
  }

  function stopCycling(): void {
    window.clearInterval(statusId);
    statusId = 0;
  }

  /**
   * The stage stops promising and asks. A quiet queue is nobody's fault, so both
   * ways out are offered at once: a wider net, or the bot.
   */
  function armQuiet(): void {
    window.clearTimeout(quietId);
    quietId = window.setTimeout(() => {
      if (state !== 'searching') return;
      stopCycling();
      setStatus('Queue is quiet — widen the search?');
      if (fallbackEl) {
        fallbackEl.hidden = false;
        fallbackEl.classList.add('on');
      }
      root?.classList.add('is-slow');
      if (liveEl) {
        liveEl.textContent = 'Search is taking longer than usual. Widen the search, or practice against the bot.';
      }
      notify('warning');
    }, QUIET_MS);
  }

  function clearQuiet(): void {
    window.clearTimeout(quietId);
    quietId = 0;
    fallbackEl?.classList.remove('on');
    if (fallbackEl) fallbackEl.hidden = true;
    root?.classList.remove('is-slow');
  }

  /**
   * Widen the net. The clock keeps running — it is the same search — but the
   * transport is asked for a relaxed radius, and the quiet timer re-arms.
   */
  function widen(): void {
    if (state !== 'searching') return;
    impact('light');
    widenings += 1;
    clearQuiet();
    ctrl?.abort();                       // the abandoned attempt must not answer into this one
    ctrl = new AbortController();
    const id = ++run;
    setStatus(widenings > 1 ? 'Second pass — every mind is fair game...' : 'Expanding search radius...');
    startCycling();
    if (liveEl) liveEl.textContent = 'Search widened — looking beyond your tier';
    const src = init.source ?? simulatedSearch(widenings > 1 ? WIDE_AGAIN_MS : WIDE_MS);
    queue(id, src, init.source ? 1 : 0, true);
    armQuiet();
  }

  /** No queue at all: hand the seat to the bot rather than leave a player waiting. */
  function practice(): void {
    if (state !== 'searching') return;
    impact('medium');
    teardown('Switching to practice');
    hide();
    init.onPractice?.();
  }

  /** The match: gold flash, the rival locked in, a triumphant tick, then the board. */
  function found(o: OpponentData): void {
    if (state !== 'searching') return;
    state = 'found';
    stopTimers();
    clearQuiet();
    paintRival(o);
    root?.classList.add('is-found');
    rival?.classList.add('is-locked');
    if (liveEl) liveEl.textContent = `Opponent found: ${o.name}, TIQ ${o.tiq}`;
    chime();
    impact('heavy');
    notify('success');

    ctrl?.abort();                       // stop caring about the transport we no longer need
    ctrl = null;
    run++;                               // any late answer is ignored now
    window.clearTimeout(foundId);
    /* no motion: the impact is stilled, so hold the locked-in rival a beat longer instead */
    const wait = motionReduced() ? 450 : IMPACT_MS;
    foundId = window.setTimeout(() => {
      state = 'idle';                    // the search is over: Back must not re-enter it
      hide();
      onMatchFound?.({ ...o });
    }, wait);
  }

  function hide(): void {
    window.clearTimeout(hideId);
    root?.classList.remove('open');
    if (motionReduced()) {
      if (root) root.hidden = true;
      return;
    }
    hideId = window.setTimeout(() => {
      if (root) root.hidden = true;
    }, EXIT_MS);
  }

  /** Walk the source, falling back to the local search when no socket answers. */
  function queue(id: number, src: MatchSource, tries: number, wide: boolean): void {
    const signal = ctrl?.signal;
    if (!signal) return;
    src(signal, { wide }).then(
      (o) => {
        if (stillHere(id)) found(o);
      },
      () => {
        if (!stillHere(id) || tries <= 0) return;
        queue(id, simulatedSearch(), tries - 1, wide);
      },
    );
  }

  function open(): void {
    if (!root || state === 'searching' || state === 'found') return;
    state = 'searching';
    window.clearTimeout(foundId);
    window.clearTimeout(hideId);
    resetStage();
    paintYou();
    root.hidden = false;
    void root.offsetWidth;               // lay the stage out at its closed position first
    root.classList.add('open');
    cancelBtn?.focus({ preventScroll: true });

    const id = ++run;
    started = performance.now();
    clockId = window.setInterval(() => {
      if (elapsedEl) elapsedEl.textContent = clock(performance.now() - started);
    }, 500);
    startCycling();
    armQuiet();

    /* announced after the region is live, so a screen reader hears it once */
    if (liveEl) liveEl.textContent = '';
    liveId = window.setTimeout(() => {
      if (liveEl && state === 'searching') liveEl.textContent = 'Searching for opponent';
    }, 120);

    ctrl = new AbortController();
    queue(id, source, init.source ? 1 : 0, false);
  }

  function cancel(): void {
    if (state === 'idle') return;
    impact('light');
    teardown('Search cancelled');
    hide();
    init.onCancel?.();
  }

  function teardown(message: string): void {
    stopTimers();
    window.clearTimeout(foundId);
    ctrl?.abort();
    ctrl = null;
    run++;
    state = 'idle';
    if (liveEl) liveEl.textContent = message;
  }

  cancelBtn?.addEventListener('click', () => cancel());
  expandBtn?.addEventListener('click', () => widen());
  practiceBtn?.addEventListener('click', () => practice());
  /* nothing to hand the seat to? then the queue only offers the wider net */
  if (practiceBtn && !init.onPractice) practiceBtn.hidden = true;

  const api: Matchmaking = {
    open,
    cancel,
    resolveMatch(o) {
      if (state === 'searching') found(o);
    },
    setSource(next) {
      source = next;
    },
    setOnMatchFound(cb) {
      onMatchFound = cb;
    },
    get isOpen() {
      return state !== 'idle';
    },
  };

  return api;
}
