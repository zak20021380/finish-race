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

/** The level behind a practice board, folded onto the registry's own labels. */
export function registryModeOfBot(level: string): RegistryMatchMode {
  return level === 'easy' ? 'bot_easy' : level === 'hard' ? 'bot_hard' : 'bot_medium';
}

/**
 * The board settled: file it in the Live Registry.
 *
 * The result capsule is the one moment a race is finished and the app is still awake, so this is
 * where every match — a practice board the room never saw, a friend duel, a queue pairing —
 * reaches the directory. The clock and the room's match id come off the same `current` record
 * `beginMatch()` opened, which is what lets the server dedupe a PvP board the room already
 * settled against this client's echo of it.
 *
 * Fire-and-forget, exactly like the telemetry above: a dropped report must never hold up the
 * result card, and a lesson (no clock open) files nothing at all.
 */
export function reportRegistryMatch(
  mode: RegistryMatchMode,
  result: 'W' | 'L',
  moves: number,
): void {
  const match = current;
  if (!match) return;
  const durationSec = Math.max(0, Math.round((Date.now() - match.startedAt) / 1000));
  const user = tgUser();
  const name = [user?.first_name, user?.last_name].filter((part): part is string => !!part).join(' ');
  send('/api/registry/match', {
    userId: user?.id === undefined || user?.id === null ? '' : String(user.id),
    displayName: name.slice(0, 40),
    username: user?.username ?? '',
    mode,
    result,
    durationSec,
    moves: Math.max(0, Math.floor(moves) || 0),
    ts: Date.now(),
    ...(match.matchId ? { matchId: match.matchId } : {}),
  });
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
