/**
 * telemetry.ts — the device's half of the analytics loop.
 *
 * Two events leave this module and nothing else: a heartbeat that keeps the seat inside the
 * Worker's ACTIVE window, and one match report when a board reaches its result. The report carries
 * the match type, the seat count and the wall-clock duration, so a local bot race counts exactly
 * like a live pairing — the server never had to see the board to know it happened.
 */
import { workerUrl } from './adminApi';
import { guestId } from './storage';
import { tgInitData, tgUser } from './telegram';
import { playerCountOf, type MatchMode, type PlayerCount } from '../shared/telemetry';

/** One heartbeat a minute: short enough to stay inside the rolling day, long enough to be free. */
const HEARTBEAT_MS = 60_000;

/**
 * The Live Registry's own label for a settled board. It is deliberately finer than `MatchMode`:
 * the Command Center's history strip names the level a practice race was played at, which the
 * three analytics tags cannot. Mirrors `RegistryMatchMode` in `worker/matchmaker.ts`.
 */
export type RegistryMatchMode = 'bot_easy' | 'bot_medium' | 'bot_hard' | 'pvp' | 'friend';

export interface MatchStart {
  mode: MatchMode;
  players: number;
  matchId?: string;
}

interface ActiveMatch extends MatchStart {
  players: PlayerCount;
  startedAt: number;
  reported: boolean;
}

let current: ActiveMatch | null = null;
let started = false;

function headers(): Record<string, string> {
  const out: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  const init = tgInitData();
  if (init) out['x-telegram-init-data'] = init;
  /* The device seat rides every report: the room keys an unsigned session to one row, so a
     heartbeat or a stats report can never mint a second `guest-*` directory entry. */
  out['x-guest-id'] = guestId;
  return out;
}

/** Fire-and-forget: telemetry must never hold up a result card or throw into a game loop. */
function send(path: string, body: Record<string, unknown>): void {
  const url = workerUrl(path);
  if (!url) return;
  try {
    void fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => { /* a dropped report is dropped; the next heartbeat still lands */ });
  } catch {
    /* no fetch in this webview: the game plays on without telemetry */
  }
}

/** The current match type, or null when the player is on a menu rather than a board. */
function liveMode(): MatchMode | null {
  return current?.mode ?? null;
}

export function heartbeat(): void {
  if (document.hidden) return;
  send('/api/client/telemetry/heartbeat', {
    matchType: liveMode(),
    timestamp: new Date().toISOString(),
  });
}

/** A board is about to start: stamp its clock and tell the room this seat is active in its mode. */
export function beginMatch(start: MatchStart): void {
  current = {
    mode: start.mode,
    players: playerCountOf(start.players),
    matchId: start.matchId,
    startedAt: Date.now(),
    reported: false,
  };
  heartbeat();
}

/** The board reached its result: report it once, then leave the mode clock idle. */
export function finishMatch(): void {
  const match = current;
  if (!match || match.reported) return;
  match.reported = true;
  const durationSec = Math.max(0, Math.round((Date.now() - match.startedAt) / 1000));
  send('/api/client/telemetry/match', {
    matchType: match.mode,
    playersCount: match.players,
    durationSec,
    timestamp: new Date().toISOString(),
    ...(match.matchId ? { matchId: match.matchId } : {}),
  });
  current = null;
}

/** The player left the board before a verdict: nothing to report, and no live mode to credit. */
export function setIdle(): void {
  current = null;
}

/* ---------- the server-authoritative match session ---------- */

/**
 * The three kinds of board the room records. Only `pvp` is worth a ladder point — `friendly` and
 * `ai` are recorded so a played board is still a played board, and pay in currency only.
 */
export type MatchSessionMode = 'pvp' | 'friendly' | 'ai';

/**
 * The board's open session. `matchId` is a promise because the POST is background: a board never
 * waits on the network to start, and a device that is offline simply has no id to settle with.
 */
interface OpenSession {
  mode: MatchSessionMode;
  /** The rival's seat id, or '' when nobody was named (a practice board names `ai`). */
  opponentId: string;
  startedAt: number;
  matchId: Promise<string>;
}

let session: OpenSession | null = null;

/** This seat's own room id, or '' outside Telegram. */
function ownSeat(): string {
  const user = tgUser();
  const id = user?.id;
  return id === undefined || id === null ? '' : `tg-${String(id)}`;
}

/** One JSON POST to the room, resolving to its body or null. Never throws at the caller. */
async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const url = workerUrl(path);
  if (!url) return null;
  try {
    const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

/**
 * Open the room's record of this board. `POST /api/match/start` mints the id and stamps the
 * server's clock — the clock the 15-second floor is measured against, so a client cannot shorten
 * a board by lying about when it began.
 *
 * Called once per board from `restart()`. The previous session, if any, is simply dropped: a board
 * that was replaced before it settled has no result worth filing.
 */
export function openMatchSession(mode: MatchSessionMode, opponentId = ''): void {
  session = {
    mode,
    opponentId,
    startedAt: Date.now(),
    matchId: post('/api/match/start', { mode, opponentId })
      .then((body) => (body && typeof body.matchId === 'string' ? body.matchId : '')),
  };
}

/**
 * The board reached its result: settle it, then file the registry echo under the SAME match id.
 *
 * The winner is a seat, never a score. On a win it is this device's own verified seat; on a loss
 * it is the rival's — `ai` for a practice board, so the room never has to guess who won a board
 * with one human on it.
 *
 * `recorded !== true` is the honest answer for a refused settlement (too fast, replayed, or a
 * board the room already judged), and in that case nothing is echoed: the registry door only
 * folds in a match the room itself settled, so an echo without one would be refused anyway.
 */
export function settleMatchSession(won: boolean, registryMode: RegistryMatchMode, moves: number): void {
  const live = session;
  session = null;
  if (!live) return;
  const durationSec = Math.max(0, Math.round((Date.now() - live.startedAt) / 1000));
  const moveCount = Math.max(0, Math.floor(moves) || 0);
  void (async () => {
    const matchId = await live.matchId;
    if (!matchId) return;
    const winnerId = won ? ownSeat() : (live.opponentId || 'ai');
    if (!winnerId) return;
    const answer = await post('/api/match/end', { matchId, winnerId, moves: moveCount });
    if (!answer || answer.recorded !== true) return;
    send('/api/registry/match', {
      mode: registryMode,
      result: won ? 'W' : 'L',
      durationSec,
      moves: moveCount,
      matchId,
    });
  })();
}

/** The level behind a practice board, folded onto the registry's own labels. */
export function registryModeOfBot(level: string): RegistryMatchMode {
  return level === 'easy' ? 'bot_easy' : level === 'hard' ? 'bot_hard' : 'bot_medium';
}

/** Start the heartbeat once per page. The first beat is immediate, so an idle app is still seen. */
export function initTelemetry(): void {
  if (started) return;
  started = true;
  heartbeat();
  window.setInterval(heartbeat, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) heartbeat();
  });
}
