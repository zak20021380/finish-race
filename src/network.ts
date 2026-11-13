/**
 * network.ts — the ambient relic-duel channel.
 *
 * Badge challenges never leave the game client. One extra WebSocket (`?session=1`) stays connected
 * while the app is open; it is not a queue seat and never pairs anybody. The matchmaker pushes a
 * `RELIC_CHALLENGE_INCOMING` frame to it, the modal answers with ACCEPT/DECLINE, and an accepted
 * challenge turns the same socket into the live 1v1 (`DUEL_START`). A later mailbox read covers the
 * case where the holder was away: the challenge is still theirs when the app boots again.
 *
 * The socket reconnects with a bounded backoff, because a Mini App can sleep through a network
 * change. It is deliberately separate from the queue socket in `matchmaking.ts`: a search may come
 * and go, while the challenge channel must stay listening.
 */
import { workerUrl } from './adminApi';
import {
  adoptDuelRace, applyRaceFrame, noteDuelSocketClosed, onlineRace, readRaceFrame,
  sessionSocketUrl, type OnlineSession,
} from './matchmaking';
import { guestId } from './storage';
import { tgInitData } from './telegram';

export interface RelicChallenge {
  challengeId: string;
  challengerId: string;
  challengerName: string;
  challengerAvatar: string;
  challengerTiq: number;
  relicId: string;
  relicSerial: number;
  expiresAt: number;
  roomId: string;
}

export type RelicChallengeStatus = 'pending' | 'accepted' | 'declined' | 'expired';

export interface RelicMailboxItem extends RelicChallenge {
  status: RelicChallengeStatus;
  createdAt: number;
}

export interface RelicChannelInit {
  /** A rival challenged this seat for a relic; the modal is the answer. */
  onIncoming(challenge: RelicChallenge): void;
  /** The accepted challenge is now a live race; route straight to the board. */
  onStart(session: OnlineSession): void;
  onSent?(info: { challengeId: string; expiresAt: number; online: boolean }): void;
  onDeclined?(challengeId: string): void;
  onExpired?(challengeId: string): void;
  onClosed?(challengeId: string, reason: string): void;
  onRefused?(reason: string): void;
}

const HEARTBEAT_MS = 20_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 15_000;
const MAILBOX_TIMEOUT_MS = 4_000;

let init: RelicChannelInit | null = null;
let sock: WebSocket | null = null;
let heartbeat = 0;
let retryTimer = 0;
let retryDelay = RETRY_MIN_MS;
let stopped = false;

const safeText = (raw: unknown, max: number): string =>
  typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : '';

const safeAvatar = (raw: unknown): string => {
  const url = safeText(raw, 512).replace(/["'\\]/g, '');
  return /^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(url) ? url : '';
};

const whole = (raw: unknown): number =>
  typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;

function readChallenge(raw: unknown): RelicChallenge | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<RelicChallenge>;
  const challengeId = safeText(r.challengeId, 64);
  const challengerId = safeText(r.challengerId, 64);
  const relicId = safeText(r.relicId, 48);
  const roomId = safeText(r.roomId, 64);
  const relicSerial = Number(r.relicSerial);
  const expiresAt = Number(r.expiresAt);
  if (!challengeId || !challengerId || !relicId || !roomId) return null;
  if (!Number.isInteger(relicSerial) || relicSerial < 1) return null;
  if (!Number.isFinite(expiresAt)) return null;
  return {
    challengeId,
    challengerId,
    challengerName: safeText(r.challengerName, 40) || 'Player',
    challengerAvatar: safeAvatar(r.challengerAvatar),
    challengerTiq: whole(r.challengerTiq),
    relicId,
    relicSerial,
    expiresAt,
    roomId,
  };
}

function post(payload: unknown): boolean {
  if (!sock || sock.readyState !== 1) return false;
  try {
    sock.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function stopHeartbeat(): void {
  if (!heartbeat) return;
  window.clearInterval(heartbeat);
  heartbeat = 0;
}

function scheduleRetry(): void {
  if (stopped || retryTimer) return;
  const delay = retryDelay;
  retryDelay = Math.min(RETRY_MAX_MS, Math.round(retryDelay * 1.7));
  retryTimer = window.setTimeout(() => {
    retryTimer = 0;
    connect();
  }, delay);
}

function handleFrame(socket: WebSocket, raw: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'PONG':
      return;
    case 'RELIC_CHALLENGE_INCOMING': {
      const challenge = readChallenge(msg);
      if (challenge) init?.onIncoming?.(challenge);
      return;
    }
    case 'RELIC_CHALLENGE_SENT': {
      const challengeId = safeText(msg.challengeId, 64);
      const expiresAt = Number(msg.expiresAt);
      if (!challengeId || !Number.isFinite(expiresAt)) return;
      init?.onSent?.({ challengeId, expiresAt, online: msg.online === true });
      return;
    }
    case 'RELIC_CHALLENGE_ACCEPTED':
      return;
    case 'RELIC_CHALLENGE_DECLINED': {
      const challengeId = safeText(msg.challengeId, 64);
      if (challengeId) init?.onDeclined?.(challengeId);
      return;
    }
    case 'CHALLENGE_EXPIRED': {
      const challengeId = safeText(msg.challengeId, 64);
      if (challengeId) init?.onExpired?.(challengeId);
      return;
    }
    case 'RELIC_CHALLENGE_CLOSED': {
      const challengeId = safeText(msg.challengeId, 64);
      if (challengeId) init?.onClosed?.(challengeId, safeText(msg.reason, 32) || 'CLOSED');
      return;
    }
    case 'RELIC_CHALLENGE_REFUSED':
      init?.onRefused?.(safeText(msg.reason, 32) || 'REFUSED');
      return;
    case 'DUEL_START': {
      const frame = readRaceFrame(raw);
      if (!frame || frame.type !== 'MATCH_FOUND' || !frame.duel) return;
      const session = adoptDuelRace(socket, frame);
      init?.onStart?.(session);
      return;
    }
    default:
      break;
  }

  /* Once the duel owns this socket, every move, emote and verdict is the race lane's. */
  const frame = readRaceFrame(raw);
  if (frame && onlineRace()?.socket === socket) applyRaceFrame(socket, frame);
}

function connect(): void {
  if (stopped) return;
  const url = sessionSocketUrl();
  if (!url) return;
  let next: WebSocket;
  try {
    next = new WebSocket(url);
  } catch {
    scheduleRetry();
    return;
  }
  sock = next;
  next.addEventListener('open', () => {
    if (sock !== next) return;
    retryDelay = RETRY_MIN_MS;
    stopHeartbeat();
    heartbeat = window.setInterval(() => {
      if (!sock || sock.readyState !== 1) return;
      post({ type: 'PING' });
    }, HEARTBEAT_MS);
  });
  next.addEventListener('message', (ev) => {
    if (sock === next) handleFrame(next, String(ev.data));
  });
  next.addEventListener('close', () => {
    if (sock !== next) return;
    sock = null;
    stopHeartbeat();
    noteDuelSocketClosed(next);
    scheduleRetry();
  });
  next.addEventListener('error', () => {
    if (sock !== next) return;
    /* a close event follows; the reconnect is armed there, and this only settles the race */
    noteDuelSocketClosed(next);
  });
}

/** Start (or lazily restart) the ambient channel. Safe to call once at boot. */
export function startRelicChannel(callbacks: RelicChannelInit): void {
  init = callbacks;
  stopped = false;
  if (sock && (sock.readyState === 0 || sock.readyState === 1)) return;
  connect();
}

export function sendRelicChallenge(input: {
  targetUserId: string;
  relicId: string;
  relicSerial: number;
}): boolean {
  return post({
    type: 'RELIC_CHALLENGE_SEND',
    targetUserId: input.targetUserId,
    relicId: input.relicId,
    relicSerial: input.relicSerial,
  });
}

export function acceptRelicChallenge(challengeId: string): boolean {
  return post({ type: 'RELIC_CHALLENGE_ACCEPT', challengeId });
}

export function declineRelicChallenge(challengeId: string): boolean {
  return post({ type: 'RELIC_CHALLENGE_DECLINE', challengeId });
}

/** Stop listening for challenges. The socket closes and no retry is armed. */
export function stopRelicChannel(): void {
  stopped = true;
  window.clearTimeout(retryTimer);
  retryTimer = 0;
  stopHeartbeat();
  const dead = sock;
  sock = null;
  if (dead) {
    try { dead.close(1000, 'stopped'); } catch { /* already gone */ }
  }
}

/** The next-boot mailbox: challenges filed for this seat while no session socket was listening. */
export async function fetchRelicMailbox(): Promise<RelicMailboxItem[]> {
  const base = workerUrl('/api/client/relic/challenges');
  if (!base) return [];
  const headers: Record<string, string> = { accept: 'application/json' };
  const initData = tgInitData();
  if (initData) headers['x-telegram-init-data'] = initData;
  headers['x-guest-id'] = guestId;
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), MAILBOX_TIMEOUT_MS);
  try {
    const res = await fetch(base, { headers, signal: ac.signal, cache: 'no-store' });
    if (!res.ok) return [];
    const body = (await res.json()) as { challenges?: unknown } | null;
    if (!body || !Array.isArray(body.challenges)) return [];
    const out: RelicMailboxItem[] = [];
    for (const raw of body.challenges) {
      const challenge = readChallenge(raw);
      if (!challenge) continue;
      const r = raw as Record<string, unknown>;
      const status = r.status;
      if (status !== 'pending' && status !== 'accepted' && status !== 'declined' && status !== 'expired') continue;
      out.push({ ...challenge, status, createdAt: whole(r.createdAt) });
    }
    return out;
  } catch {
    return [];
  } finally {
    window.clearTimeout(timer);
  }
}
