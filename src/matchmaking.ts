/**
 * matchmaking.ts — the 1v1 searching stage: the Versus Arena.
 *
 * Quick match no longer drops straight onto the board: the mode drawer hands the
 * seat to this module, which owns one full-viewport clay stage — a telemetry rail
 * (seat, pairing radius, hazards), two extruded contender pods (you on a team-blue
 * sphere, the rival a live scanner on the right), the tactical radar core and its
 * VS medallion between them, then the search console, the stakes and a mind tip.
 *
 * `source` is the seam a transport plugs into: it takes an `AbortSignal` (plus the current `wide`
 * skill filter) and resolves with the `OpponentData` it found. `onlineSearch()` is the real one —
 * one socket to the Worker's matchmaker (`worker/`), which answers with the opponent and the
 * `{ matchId, seed, side, sizes }` the race will run on. With no Worker behind the page (a static
 * preview, a `file://` tab, a refused upgrade) that same socket call falls back to the
 * `simulatedSearch()` that has always answered after ~4s, so the stage is never left spinning. A
 * transport that rejects for its own reasons falls back the same way — with one exception. When
 * the matchmaker *refuses* the queue (`{ type: "ERROR" }`, which is what the Admin Command Center's
 * maintenance lock and its Clear Queue both send), that is a decision rather than a dead socket:
 * the search ends, `onRefused` says why, and no bot stands in for it.
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
 * reduced-motion block stills the sweep, the pulses and the flash.
 */
import { contendersIn, dimsFor, type Action } from './rules';
import { PHRASE_COUNT, isChatEmoteId, isChatLang, type ChatEmoteId, type ChatLang } from './data/phrases';
import { menuState, motionReduced, settings } from './settings';
import { audioContext } from './sound';
import { payout, profile } from './storage';
import { getMySquad } from './squads';
import { paintFlag } from './flags';
import { runtime, tiqFrom } from './admin';
import { adoptArena, arena, claimArenaAward, type ArenaState } from './arenaState';
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

/**
 * Your TIQ: the ladder's own formula, with the Admin Command Center's win reward and its TIQ
 * grants folded in. The 140 default still lands exactly the old 120-per-win + 20-per-race.
 */
export function myTiq(): number {
  return tiqFrom(profile.stats.wins, profile.stats.games, profile.tiqBonus);
}

/** The aura the ladder paints for you: the admin's forced preview, or read off the TIQ. */
export function myTier(): MindTier {
  return runtime.tierOverride ?? tierOf(myTiq());
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
  /** ISO alpha-2, when the seat carries one: the pod's corner flag. */
  flag?: string | null;
}

/** What this attempt is asking for: `wide` is the relaxed skill filter. */
export interface MatchSourceOptions {
  /** True once the player widened the search after a quiet queue. */
  wide: boolean;
}

/** What a transport looks like: resolve with a match, or reject (abort/offline). */
export type MatchSource = (signal: AbortSignal, opts: MatchSourceOptions) => Promise<OpponentData>;

/* ---------- the waiting room: a seeded pool, no server required ---------- */

/** The waiting room: a seeded pool, no server required. `flag` is the pod's corner badge. */
const RIVALS: ReadonlyArray<{ id: string; name: string; tiq: number; flag: string }> = [
  { id: 'r-nadia', name: 'Nadia K.', tiq: 1240, flag: 'PL' },
  { id: 'r-rune', name: 'Rune', tiq: 1875, flag: 'NO' },
  { id: 'r-ivo', name: 'Ivo Petrov', tiq: 2140, flag: 'BG' },
  { id: 'r-mira', name: 'Mira', tiq: 2680, flag: 'KZ' },
  { id: 'r-sable', name: 'Sable', tiq: 3150, flag: 'GB' },
  { id: 'r-kenji', name: 'Kenji', tiq: 980, flag: 'JP' },
  { id: 'r-lior', name: 'Lior', tiq: 1545, flag: 'IL' },
  { id: 'r-ada', name: 'Ada W.', tiq: 2360, flag: 'DE' },
];

const asOpponent = (r: { id: string; name: string; tiq: number; flag: string }): OpponentData => ({
  id: r.id,
  name: r.name,
  tiq: r.tiq,
  tier: tierOf(r.tiq),
  avatarUrl: null,
  initial: (r.name.charAt(0) || '?').toUpperCase(),
  flag: r.flag,
});

/**
 * The closest three minds to your own — a believable queue, never a random blowout.
 * `wide` is the radius the stage asks for once the queue has gone quiet: every
 * rival is fair game, and a wobble the size of the wide radius keeps a widened
 * search from landing on the same nearest-three answer twice.
 */
export function pickRival(mine: number = myTiq(), wide = false): OpponentData {
  if (wide) {
    const spread = Math.max(100, runtime.radiusWide);
    const pool = RIVALS.map((r) => ({ ...r, tiq: Math.max(0, r.tiq + Math.round((Math.random() - 0.5) * spread * 2)) }));
    return asOpponent(pool[Math.floor(Math.random() * pool.length)]);
  }
  /* the ordinary band, as the admin set it: only minds inside it, nearest first */
  const band = runtime.radiusNormal;
  const near = RIVALS.filter((r) => Math.abs(r.tiq - mine) <= band)
    .sort((a, b) => Math.abs(a.tiq - mine) - Math.abs(b.tiq - mine))
    .slice(0, 3);
  if (!near.length) {
    /* nobody inside the band: the closest mind still takes the seat, so a queue is never empty */
    const closest = [...RIVALS].sort((a, b) => Math.abs(a.tiq - mine) - Math.abs(b.tiq - mine));
    return asOpponent(closest[0]);
  }
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

export interface Face {
  name: string;
  initial: string;
  avatarUrl: string | null;
}

export function readFace(fallbackName: string): Face {
  const img = document.getElementById('avatar-img') as HTMLImageElement | null;
  const u = tgUser();
  const name = (domText('p-name', '') || u?.first_name || u?.username || fallbackName).trim();
  const avatarUrl = (img && !img.hidden && img.src ? img.src : null) ?? u?.photo_url ?? null;
  const letter = domText('avatar-t', '') || name.charAt(0) || 'P';
  return { name, initial: letter.slice(0, 1).toUpperCase(), avatarUrl };
}

/* ---------- the corner flag: the shared CDN cascade, kept live in one host ---------- */

/* `paintFlag` (flags.ts) builds the chip and image once; the scanner's five-a-
   second repaint only moves `src`, never the DOM. */

/* ---------- online transport: the Worker's waiting room, and the race it turns into ---------- */

/** What the upcoming online race runs on: the id both sides agree on, the shared seed, your side. */
export interface OnlineMatch {
  matchId: string;
  seed: number;
  /**
   * The seat this client plays. A duel is 0 or 1; a friends room seats up to four, and the room's
   * roster is the authority on which one is yours.
   */
  side: number;
  /**
   * The board: one ball count per seat, in seat order. A duel is `[1, 1]`, a four-seat room
   * `[1, 1, 1, 1]` — the same shape `newGame()` takes, so both transports start the same game.
   */
  sizes: number[];
}

/** Why a race ended before anyone reached FINISH. */
export interface RaceEnd {
  /** True when the win is yours. */
  win: boolean;
  /** The rival quit, the rival's socket died, ours did, or an operator pulled the room. */
  why: 'resign' | 'left' | 'drop' | 'aborted';
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
  /** Send one emote to the rival. False when the socket is gone. */
  sendEmote(emote: ChatEmoteId): boolean;
  /** Send one tactical line to the rival, as its closed `(lang, index)` pair. */
  sendPhrase(lang: ChatLang, index: number): boolean;
  /** Forfeit: the rival wins immediately. */
  resign(): void;
  /** Let the socket go (no forfeit): the session is done being a race. */
  close(): void;
  /** A move the rival made, in the order the matchmaker accepted it. */
  onMove(cb: (action: Action, side: number) => void): void;
  /** An emote the rival sent. */
  onEmote(cb: (emote: ChatEmoteId, side: number) => void): void;
  /** A tactical line the rival sent, as the pair they tapped. */
  onPhrase(cb: (lang: ChatLang, index: number, side: number) => void): void;
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
  | { type: 'EMOTE'; side: 0 | 1; emote: ChatEmoteId }
  | { type: 'PHRASE'; side: 0 | 1; lang: ChatLang; index: number }
  | { type: 'REJECT'; reason: string }
  | { type: 'RESIGN' | 'OPPONENT_LEFT'; side: 0 | 1 }
  /* The two the Admin Command Center's server half sends: a refused queue, and a pulled room. */
  | { type: 'ERROR'; reason: string }
  | { type: 'ABORTED'; matchId: string }
  | { type: 'ARENA'; arena: ArenaState; reason: string; award: unknown };

/**
 * A refusal is not a dead socket. A socket that dies means the local search may take over — that is
 * the whole fallback story. A server that answers `ERROR` has *decided* something (maintenance is
 * on, an operator emptied the queue), and quietly racing a bot instead would contradict it. So a
 * refusal travels as its own error kind and ends the search outright.
 */
const REFUSED = 'queue-refused';

function refused(reason: string): Error {
  const e = new Error(`queue refused: ${reason}`);
  e.name = REFUSED;
  (e as Error & { reason?: string }).reason = reason;
  return e;
}

/** The reason a refusal carried, or null when this was an ordinary failure. */
function refusalOf(e: unknown): string | null {
  if (!(e instanceof Error) || e.name !== REFUSED) return null;
  return (e as Error & { reason?: string }).reason ?? 'REFUSED';
}

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
const WS_URL = import.meta.env?.VITE_WS_URL?.trim() ?? '';

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
  params.set('tier', myTier());
  params.set('flag', profile.country ?? '');
  params.set('age', String(profile.age ?? 0));
  params.set('name', readFace('Player').name);
  params.set('wide', wide ? '1' : '0');
  /* the board this search is for: the matchmaker only pairs two seats playing the same game */
  params.set('sizes', menuState.sizes.join(','));
  /* economy / social telemetry for the Admin Command Center's directory. The room clamps every
     figure on arrival and never treats any of it as an authority — it is a reading, not a claim. */
  params.set('coins', String(profile.coins));
  params.set('refs', String(profile.referral.joins));
  params.set('squad', getMySquad()?.handle ?? '');
  return params.toString();
}

/**
 * The friends lobby's socket: the same origin and the same identity as the 1v1 queue, but carrying
 * a room code instead of a search. `host=1` mints the room; without it the worker answers a code it
 * does not know with `room_not_found`, which is exactly what a mistyped invite should say.
 */
export function roomSocketUrl(code: string, host: boolean): string {
  const base = socketUrl();
  if (!base) return '';
  const params = new URLSearchParams(socketParams(false));
  params.set('roomcode', code);
  if (host) params.set('host', '1');
  params.delete('wide');
  params.delete('sizes');
  return `${base}?${params.toString()}`;
}

/** The board the room said both seats are playing, or the one this client asked for. */
function readBoard(raw: unknown): [number, number] {
  if (Array.isArray(raw) && raw.length === 2) {
    const pair = raw.map((n) => (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 3 ? n : NaN));
    if (pair.every((n) => !Number.isNaN(n))) return [pair[0], pair[1]];
  }
  return [menuState.sizes[0], menuState.sizes[1]];
}

const onBoard = (v: unknown, cols: number, rows: number): v is { c: number; r: number } => {
  const p = v as { c?: unknown; r?: unknown } | null;
  return !!p && Number.isInteger(p.c) && Number.isInteger(p.r)
    && (p.c as number) >= 0 && (p.c as number) < cols && (p.r as number) >= 0 && (p.r as number) < rows;
};

/**
 * An action rebuilt from the wire, never trusted as it arrived — the same guards the room applies
 * on the way out, so a frame the matchmaker would refuse cannot break this board either. The bounds
 * are the board this race is actually played on: a 3- or 4-contender match runs on the wide grid,
 * so a column past the duel width is a legal square there and must not be dropped here.
 */
function readAction(raw: unknown, side: 0 | 1, cols: number, rows: number): Action | null {
  const a = raw as { kind?: unknown; ball?: unknown; to?: unknown; wall?: unknown; cell?: unknown } | null;
  if (!a || typeof a !== 'object') return null;
  if (a.kind === 'move') {
    if (!onBoard(a.to, cols, rows)) return null;
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
    if (!onBoard(a.cell, cols, rows)) return null;
    return { kind: 'mine', cell: { c: a.cell.c, r: a.cell.r } };
  }
  return a.kind === 'pass' ? { kind: 'pass' } : null;
}

/**
 * One frame off the socket. `sizes` is the board the race on this socket is played on, when there
 * is one: the grid the rules derive from it is what bounds an incoming move. A frame that arrives
 * before a match exists can carry no move, so the classic duel board is the safe default.
 */
function parseFrame(raw: string, sizes?: readonly number[]): RaceFrame | null {
  const { cols, rows } = dimsFor(sizes ? contendersIn(sizes) : 0);
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
      const action = readAction(msg.action, side, cols, rows);
      return action ? { type: 'MOVE', side, action } : null;
    }
    if (msg.type === 'EMOTE') return isChatEmoteId(msg.emote) ? { type: 'EMOTE', side, emote: msg.emote } : null;
    if (msg.type === 'PHRASE') {
      return isChatLang(msg.lang) && typeof msg.index === 'number' && Number.isInteger(msg.index)
        && msg.index >= 0 && msg.index < PHRASE_COUNT
        ? { type: 'PHRASE', side, lang: msg.lang, index: msg.index } : null;
    }
    if (msg.type === 'REJECT') return { type: 'REJECT', reason: typeof msg.reason === 'string' ? msg.reason : 'refused' };
    if (msg.type === 'RESIGN' || msg.type === 'OPPONENT_LEFT') return { type: msg.type, side };
    if (msg.type === 'ERROR') return { type: 'ERROR', reason: typeof msg.reason === 'string' ? msg.reason : 'REFUSED' };
    if (msg.type === 'ABORTED') return { type: 'ABORTED', matchId: typeof msg.matchId === 'string' ? msg.matchId : '' };
    if (msg.type === 'ARENA') {
      if (!msg.arena || typeof msg.arena !== 'object') return null;
      return {
        type: 'ARENA',
        arena: msg.arena as unknown as ArenaState,
        reason: typeof msg.reason === 'string' ? msg.reason : '',
        award: msg.award ?? null,
      };
    }
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
let raceEmote: ((emote: ChatEmoteId, side: number) => void) | null = null;
let racePhrase: ((lang: ChatLang, index: number, side: number) => void) | null = null;
/** Moves that landed between the match and the race screen: replayed the moment it subscribes. */
let raceQueue: Array<{ action: Action; side: 0 | 1 }> = [];
/** Same for an emote: a rival can laugh at the match-found flash before the board subscribes. */
let raceEmoteQueue: Array<{ emote: ChatEmoteId; side: number }> = [];
/** And same for a phrase: the line waits with its pair instead of being dropped. */
let racePhraseQueue: Array<{ lang: ChatLang; index: number; side: number }> = [];

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
    raceEmote = null;
    racePhrase = null;
    raceQueue = [];
    raceEmoteQueue = [];
    racePhraseQueue = [];
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
  raceEmote = null;
  racePhrase = null;
  raceQueue = [];
  raceEmoteQueue = [];
  racePhraseQueue = [];
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
    sendEmote(emote) {
      if (race?.socket !== sock || sock.readyState !== 1) return false;
      try {
        sock.send(JSON.stringify({ type: 'EMOTE', emote }));
        return true;
      } catch {
        return false;
      }
    },
    sendPhrase(lang, index) {
      if (race?.socket !== sock || sock.readyState !== 1) return false;
      try {
        sock.send(JSON.stringify({ type: 'PHRASE', lang, index }));
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
    onEmote(cb) {
      raceEmote = cb;
      const queued = raceEmoteQueue;
      raceEmoteQueue = [];
      for (const e of queued) cb(e.emote, e.side);
    },
    onPhrase(cb) {
      racePhrase = cb;
      const queued = racePhraseQueue;
      racePhraseQueue = [];
      for (const p of queued) cb(p.lang, p.index, p.side);
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
function onlineOpponent(msg: {
  matchId: string;
  opponent: { name: string; tiq: number; tier: string; flag: string };
}): OpponentData {
  const name = msg.opponent.name.trim() || 'Rival';
  return {
    id: `online-${msg.matchId}`,
    name,
    tiq: msg.opponent.tiq,
    tier: asTier(msg.opponent.tier, msg.opponent.tiq),
    avatarUrl: null,
    initial: name.charAt(0).toUpperCase(),
    flag: msg.opponent.flag,
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

/**
 * The room refused the queue. The socket is let go and the waiting seat is answered with a refusal
 * rather than an abort, so the caller can tell "the server said no" from "the socket went away" —
 * only the latter may fall back to the local search.
 */
function refuseSearch(sock: WebSocket, reason: string): void {
  if (sock !== ws) return;                    // a socket this search already let go of
  ws = null;
  wsWide = false;
  wsMatched = false;
  window.clearTimeout(teardownId);
  teardownId = 0;
  const lost = seat;
  seat = null;
  try {
    sock.close(1000, reason.toLowerCase());
  } catch {
    /* the server already closed it */
  }
  lost?.reject(refused(reason));
}

function wire(sock: WebSocket): void {
  sock.addEventListener('open', () => post(sock, JSON.stringify({ type: 'QUEUE', wide: wsWide })));
  sock.addEventListener('message', (ev) => {
    const frame = parseFrame(String(ev.data), race?.sizes);
    if (!frame) return;

    /* a tournament state broadcast: update the mirror even mid-race, without touching the board */
    if (frame.type === 'ARENA') {
      adoptArena(frame.arena);
      if (frame.award) claimArenaAward(frame.award);
      return;
    }

    if (frame.type === 'ERROR') {
      if (race?.socket === sock) endRace(sock, false, 'aborted');
      else refuseSearch(sock, frame.reason);
      return;
    }

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
    } else if (frame.type === 'EMOTE') {
      if (raceEmote) raceEmote(frame.emote, frame.side);
      else raceEmoteQueue.push({ emote: frame.emote, side: frame.side });
    } else if (frame.type === 'PHRASE') {
      if (racePhrase) racePhrase(frame.lang, frame.index, frame.side);
      else racePhraseQueue.push({ lang: frame.lang, index: frame.index, side: frame.side });
    } else if (frame.type === 'REJECT') {
      raceReject?.(frame.reason);
    } else if (frame.type === 'ABORTED') {
      endRace(sock, false, 'aborted');        // an operator pulled the room out from under both seats
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

/** Respects the Sound switch; the shared engine (`sound.ts`) is the app's only AudioContext. */
export function chime(): void {
  if (!settings.sound) return;
  try {
    const ctx = audioContext();
    if (!ctx) return;
    if (ctx.state !== 'running') void ctx.resume().catch(() => { /* still locked */ });
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
  /**
   * The server refused the queue outright — maintenance is on, or an operator emptied it. Fired
   * instead of any local fallback, because racing a bot would contradict the server's own answer.
   */
  onRefused?: (reason: string) => void;
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
/** The scanner's cadence: five candidate minds a second until the match lands. */
const SCAN_MS = 180;
/** The silhouettes it flicks through while the seat still has no face. */
const SCAN_FACES: ReadonlyArray<string> = ['#i-user', '#i-bot', '#i-users'];
/** How often the arena trades its coaching line. */
const TIP_MS = 4000;
/**
 * Every line here is a rule the board enforces: unlimited walls, the mine blast's
 * knockback (`rules.ts`), the 8s blitz hand-off, and a log that is never telegraphed
 * and locks input while it rolls (`hazards.ts`, `render.ts`).
 */
const TIPS: ReadonlyArray<string> = [
  'Walls are unlimited — seal the lane your rival needs, not the one they are standing in.',
  'A mine throws a ball straight down its column. Bury it where the rival must land.',
  'The blitz clock runs out and its auto-move will walk you straight into a mine.',
  'Nothing warns you about the rolling log. Rounds 1 and 2 are always clean — cross early.',
  'Input locks while a log rolls. Be where you want to be before the board starts to shake.',
  'The blast is aerial: a horizontal wall never shortens it. The mine throws the ball two rows back.',
];
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
  const scanGlyph = rivalScan?.querySelector('use') ?? null;
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
  const youTier = document.getElementById('mm-you-tier') as HTMLElement | null;
  const rivalTier = document.getElementById('mm-rival-tier') as HTMLElement | null;
  const youFlag = document.getElementById('mm-you-flag') as HTMLElement | null;
  const rivalFlag = document.getElementById('mm-rival-flag') as HTMLElement | null;
  const rangeChip = document.getElementById('mm-range') as HTMLElement | null;
  const rangeVal = rangeChip?.querySelector('b') ?? null;
  const tipEl = document.getElementById('mm-tip') as HTMLElement | null;
  const stakeEls = {
    tiq: document.getElementById('mm-stake-tiq') as HTMLElement | null,
    gold: document.getElementById('mm-stake-gold') as HTMLElement | null,
    season: document.getElementById('mm-stake-season') as HTMLElement | null,
  };

  let source: MatchSource = init.source ?? simulatedSearch();
  let onMatchFound = init.onMatchFound;
  let state: Stage = 'idle';
  let run = 0;
  let started = 0;
  let statusIdx = 0;
  let tipIdx = 0;
  let scanIdx = 0;
  let clockId = 0;
  let statusId = 0;
  let liveId = 0;
  let foundId = 0;
  let hideId = 0;
  let quietId = 0;
  let scanId = 0;
  let tipId = 0;
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
    window.clearInterval(scanId);
    window.clearInterval(tipId);
    window.clearTimeout(liveId);
    window.clearTimeout(quietId);
    clockId = statusId = liveId = quietId = scanId = tipId = 0;
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
    if (rivalTier) rivalTier.textContent = 'Unknown';
    if (rivalTiq) rivalTiq.textContent = '—';
    paintFlag(rivalFlag, null);
    rival?.setAttribute('aria-label', 'Waiting for an opponent');
    if (statusEl) {
      statusEl.classList.remove('swap');
      statusEl.textContent = STATUS[0];
    }
    if (elapsedEl) elapsedEl.textContent = '00:00';
    setRange(false);
    statusIdx = 0;
    scanIdx = 0;
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
    const tier = myTier();
    if (you) you.dataset.tier = tier;
    if (youName) youName.textContent = face.name;
    if (youTier) youTier.textContent = TIER_NAME[tier];
    if (youTiq) youTiq.textContent = tiq.toLocaleString('en-US');
    paintFace(youImg, youT, face);
    paintFlag(youFlag, profile.country);
    you?.setAttribute('aria-label', `${face.name}, TIQ ${tiq}, ${TIER_NAME[tier]}`);
  }

  function paintRival(o: OpponentData): void {
    if (rival) rival.dataset.tier = o.tier;
    if (rivalName) rivalName.textContent = o.name;
    if (rivalTier) rivalTier.textContent = TIER_NAME[o.tier];
    if (rivalTiq) rivalTiq.textContent = o.tiq.toLocaleString('en-US');
    if (rivalScan) rivalScan.hidden = true;
    paintFace(rivalImg, rivalT, o);
    paintFlag(rivalFlag, o.flag ?? null);
    rival?.setAttribute('aria-label', `${o.name}, TIQ ${o.tiq}, ${TIER_NAME[o.tier]}`);
  }

  /** The radius chip is the one number on the rail a widen actually moves. */
  function setRange(wide: boolean): void {
    if (rangeVal) rangeVal.textContent = wide ? `±${runtime.radiusWide} WIDE` : `±${runtime.radiusNormal}`;
    rangeChip?.classList.toggle('is-wide', wide);
  }

  /** What a win is worth here, read off the same two formulas the settlement uses. */
  function paintStakes(): void {
    if (stakeEls.tiq) stakeEls.tiq.textContent = String(runtime.winTiq);
    if (stakeEls.gold) {
      stakeEls.gold.textContent = String(payout({ difficulty: menuState.difficulty, won: true }, runtime.coinMult));
    }
    /* the same Command Center season the Mind Ladder capsule counts down */
    const season = `S${arena().seasonNo}`;
    if (stakeEls.season) {
      stakeEls.season.textContent = season;
      stakeEls.season.closest('.mm-stakes-c')?.toggleAttribute('hidden', season === '');
    }
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

  /**
   * One tick of the neural scanner: a different candidate face, flag and TIQ every
   * `SCAN_MS`, so the empty seat reads as a lock in progress rather than a wait.
   * The numbers stay inside the radius this search is asking for. Reduced motion
   * never starts it — the pod simply holds the ghost.
   */
  function scanTick(): void {
    if (!rivalTiq) return;
    scanIdx++;
    const near = pickRival(myTiq(), widenings > 0);
    const roll = Math.max(0, near.tiq + Math.round((Math.random() - 0.5) * 260));
    rivalTiq.textContent = roll.toLocaleString('en-US');
    paintFlag(rivalFlag, RIVALS[scanIdx % RIVALS.length].flag);
    scanGlyph?.setAttribute('href', SCAN_FACES[scanIdx % SCAN_FACES.length]);
  }

  /** The tip ticker: one coaching line at a time, traded every `TIP_MS`. */
  function cycleTip(): void {
    if (!tipEl) return;
    tipIdx = (tipIdx + 1) % TIPS.length;
    tipEl.textContent = TIPS[tipIdx];
    if (motionReduced()) return;
    tipEl.classList.remove('swap');
    void tipEl.offsetWidth;
    tipEl.classList.add('swap');
  }

  /**
   * A queue that has gone quiet has no candidates to lock onto, so the scanner stops
   * inventing them: the ghost and the dash come back, and the widen earns them again.
   */
  function startScan(): void {
    window.clearInterval(scanId);
    scanId = 0;
    if (motionReduced()) return;
    scanId = window.setInterval(scanTick, SCAN_MS);
  }

  function stopScan(): void {
    window.clearInterval(scanId);
    scanId = 0;
    if (rivalTiq) rivalTiq.textContent = '—';
    paintFlag(rivalFlag, null);
    scanGlyph?.setAttribute('href', SCAN_FACES[0]);
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
      stopScan();
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
    setRange(true);
    ctrl?.abort();                       // the abandoned attempt must not answer into this one
    ctrl = new AbortController();
    const id = ++run;
    setStatus(widenings > 1 ? 'Second pass — every mind is fair game...' : 'Expanding search radius...');
    startCycling();
    startScan();
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

  /** The server said no: end the search and say why, rather than quietly racing a bot instead. */
  function refusedStage(reason: string): void {
    teardown(`Queue refused: ${reason}`);
    hide();
    init.onRefused?.(reason);
  }

  /** Walk the source, falling back to the local search when no socket answers. */
  function queue(id: number, src: MatchSource, tries: number, wide: boolean): void {
    const signal = ctrl?.signal;
    if (!signal) return;
    src(signal, { wide }).then(
      (o) => {
        if (stillHere(id)) found(o);
      },
      (err) => {
        if (!stillHere(id)) return;
        const why = refusalOf(err);
        if (why !== null) { refusedStage(why); return; }   // a decision, not a dead socket
        if (tries <= 0) return;
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
    startScan();
    armQuiet();
    paintStakes();
    /* the tip ticker restarts from the top with every search, so a reopen never shows a stale line */
    tipIdx = 0;
    if (tipEl) tipEl.textContent = TIPS[0];
    window.clearInterval(tipId);
    tipId = window.setInterval(cycleTip, TIP_MS);

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
