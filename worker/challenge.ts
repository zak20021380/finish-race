/**
 * challenge.ts — the 7-Day Dual-Track Tournament: 20 friend wins + 20 Hard AI wins for 50 Stars.
 *
 * This module is the server's whole rulebook, kept apart from the room so the anti-cheat can be
 * read (and tested) on its own. The room owns the clock, the receipts and the storage; nothing a
 * client posts can move a counter by itself.
 *
 * Track A — Hard Bot wins (`hardBotWins` / 20). A local bot board never touches the room, so the
 * room issues a one-shot ticket when the board starts and only accepts a victory report that
 * arrives at least 45 seconds later with at least 10 moves played. The ticket is consumed exactly
 * once and lives in the current window only.
 *
 * Track B — online friend wins (`friendWins` / 20). This counter is written ONLY by the room's own
 * settlement paths (a ranked 1v1 race or a friends lobby): the two seats must be distinct verified
 * Telegram accounts, the board must have lasted 45 seconds (60 when a seat forfeited) and have at
 * least 10 moves. A per-opponent map caps each friend at `MAX_WINS_PER_FRIEND` wins, so 20 friend
 * wins need at least 7 distinct opponents.
 *
 * First to Complete wins: the first player to reach 20 / 20 claims 50 Stars, and that claim locks
 * the verified Telegram id and handle as the tournament winner. Later claims are refused with the
 * winner's identity, never with a second prize.
 *
 * Windows are 7 days, aligned to a fixed Monday 00:00 UTC anchor, so the countdown a client paints
 * is the same for every player and a counter can never be farmed across a boundary.
 */

export const CHALLENGE_KEY = 'challenge.v1';
export const CHALLENGE_DAYS = 7;
export const CHALLENGE_WINDOW_MS = CHALLENGE_DAYS * 24 * 60 * 60 * 1000;
/** Fixed Monday 00:00 UTC: 2024-01-01, so every 7-day cycle starts on a Monday. */
export const CHALLENGE_WINDOW_ANCHOR = Date.UTC(2024, 0, 1);
export const CHALLENGE_TARGET = 20;
export const CHALLENGE_STARS = 50;
/** A hard-bot win must be at least this long on the ROOM's clock. */
export const CHALLENGE_MIN_SECONDS = 45;
/** A friend win that came from a forfeit must clear this much of the board first. */
export const CHALLENGE_FORFEIT_MIN_SECONDS = 60;
/** Both tracks require this many played moves. */
export const CHALLENGE_MIN_MOVES = 10;
/** Unique-opponent anti-farming cap: 20 friend wins therefore need at least 7 friends. */
export const MAX_WINS_PER_FRIEND = 3;
/** How long an issued Hard AI ticket stays usable. */
export const CHALLENGE_TICKET_TTL_MS = 3 * 60 * 60 * 1000;
/** Bounds so one busy room cannot grow an unbounded ledger. */
export const CHALLENGE_PLAYERS_MAX = 4000;
export const CHALLENGE_OPPONENTS_MAX = 200;
export const CHALLENGE_RECEIPTS_MAX = 96;
export const CHALLENGE_KEEP_MS = CHALLENGE_WINDOW_MS * 2;

/** One player's 7-day scorecard. Every field is written by the room, never by a request body. */
export interface ChallengeEntry {
  id: string;
  /** The verified numeric Telegram id; empty for a guest seat (which cannot compete). */
  tgId: string;
  /** Public handle for the winner lock: `@username` when the registry has one, else the id. */
  handle: string;
  windowStart: number;
  windowEnd: number;
  hardBotWins: number;
  friendWins: number;
  /** opponent Telegram id -> counted wins against that person (capped). */
  winsByOpponent: Record<string, number>;
  /** Open Hard AI tickets: ticket -> issued-at (ms), on the room's clock. */
  tickets: Record<string, number>;
  /** Consumed Hard AI tickets, a retry tombstone, bounded to the newest receipts. */
  botReceipts: string[];
  /** Friend match ids already credited, so a replayed settlement cannot count twice. */
  friendReceipts: string[];
  claimedAt: number;
  claimStars: number;
  updatedAt: number;
}

export interface ChallengeWinner {
  id: string;
  tgId: string;
  handle: string;
  claimedAt: number;
}

export interface ChallengeState {
  entries: ChallengeEntry[];
  winner: ChallengeWinner | null;
}

/** Why a report was refused. Every value maps to one localised line on the card. */
export type ChallengeRefusal =
  | 'telegram_required'
  | 'not_won'
  | 'wrong_track'
  | 'no_ticket'
  | 'ticket_expired'
  | 'duplicate'
  | 'not_enough_time'
  | 'not_enough_moves'
  | 'self_opponent'
  | 'friend_cap'
  | 'already_complete'
  | 'not_complete'
  | 'already_claimed'
  | 'winner_taken';

const clampInt = (raw: unknown, max: number): number => {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
  return Math.max(0, Math.min(max, n));
};

const clampSeconds = (raw: unknown): number => clampInt(raw, 24 * 60 * 60);

const readText = (raw: unknown, max: number): string =>
  typeof raw === 'string' ? raw.trim().slice(0, max) : '';

const readStamp = (raw: unknown): number => {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
  return n > 0 ? n : 0;
};

/** The 7-day window that contains `now`. */
export function challengeWindowAt(now: number): { start: number; end: number } {
  const elapsed = Math.max(0, now - CHALLENGE_WINDOW_ANCHOR);
  const start = CHALLENGE_WINDOW_ANCHOR + Math.floor(elapsed / CHALLENGE_WINDOW_MS) * CHALLENGE_WINDOW_MS;
  return { start, end: start + CHALLENGE_WINDOW_MS };
}

/** A brand-new scorecard for the current window. */
export function newChallengeEntry(id: string, tgId: string, handle: string, now: number): ChallengeEntry {
  const window = challengeWindowAt(now);
  return {
    id,
    tgId,
    handle,
    windowStart: window.start,
    windowEnd: window.end,
    hardBotWins: 0,
    friendWins: 0,
    winsByOpponent: {},
    tickets: {},
    botReceipts: [],
    friendReceipts: [],
    claimedAt: 0,
    claimStars: 0,
    updatedAt: now,
  };
}

const readEntry = (raw: unknown): ChallengeEntry | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ChallengeEntry>;
  const id = readText(r.id, 64);
  if (!id) return null;
  const now = Date.now();
  const window = challengeWindowAt(now);
  const entry: ChallengeEntry = {
    id,
    tgId: /^[0-9]{1,20}$/.test(readText(r.tgId, 20)) ? readText(r.tgId, 20) : '',
    handle: readText(r.handle, 40),
    windowStart: readStamp(r.windowStart) || window.start,
    windowEnd: readStamp(r.windowEnd) || window.end,
    hardBotWins: clampInt(r.hardBotWins, CHALLENGE_TARGET),
    friendWins: clampInt(r.friendWins, CHALLENGE_TARGET),
    winsByOpponent: {},
    tickets: {},
    botReceipts: [],
    friendReceipts: [],
    claimedAt: readStamp(r.claimedAt),
    claimStars: clampInt(r.claimStars, CHALLENGE_STARS),
    updatedAt: readStamp(r.updatedAt) || now,
  };
  const wins = r.winsByOpponent;
  if (wins && typeof wins === 'object') {
    for (const key of Object.keys(wins).slice(0, CHALLENGE_OPPONENTS_MAX)) {
      if (!/^[0-9]{1,20}$/.test(key)) continue;
      const n = clampInt((wins as Record<string, unknown>)[key], MAX_WINS_PER_FRIEND);
      if (n > 0) entry.winsByOpponent[key] = n;
    }
  }
  const tickets = r.tickets;
  if (tickets && typeof tickets === 'object') {
    for (const key of Object.keys(tickets).slice(0, CHALLENGE_RECEIPTS_MAX)) {
      const at = readStamp((tickets as Record<string, unknown>)[key]);
      if (at > 0) entry.tickets[key] = at;
    }
  }
  if (Array.isArray(r.botReceipts)) {
    for (const v of r.botReceipts.slice(-CHALLENGE_RECEIPTS_MAX)) {
      const t = readText(v, 64);
      if (t) entry.botReceipts.push(t);
    }
  }
  if (Array.isArray(r.friendReceipts)) {
    for (const v of r.friendReceipts.slice(-CHALLENGE_RECEIPTS_MAX)) {
      const t = readText(v, 64);
      if (t) entry.friendReceipts.push(t);
    }
  }
  return entry;
};

/** Defensive parse of the ledger: an unreadable row is skipped, never fatal. */
export function readChallengeState(raw: unknown): ChallengeState {
  const out: ChallengeState = { entries: [], winner: null };
  if (!raw || typeof raw !== 'object') return out;
  const state = raw as { entries?: unknown; winner?: unknown };
  if (Array.isArray(state.entries)) {
    for (const row of state.entries) {
      const entry = readEntry(row);
      if (entry) out.entries.push(entry);
    }
  }
  const winner = state.winner;
  if (winner && typeof winner === 'object') {
    const w = winner as Partial<ChallengeWinner>;
    const id = readText(w.id, 64);
    const tgId = /^[0-9]{1,20}$/.test(readText(w.tgId, 20)) ? readText(w.tgId, 20) : '';
    const claimedAt = readStamp(w.claimedAt);
    if (id && tgId && claimedAt > 0) {
      out.winner = { id, tgId, handle: readText(w.handle, 40) || tgId, claimedAt };
    }
  }
  return out;
}

/** Start a fresh cycle when the old window closed. Returns true when the entry was reset. */
export function rollChallengeEntry(entry: ChallengeEntry, now: number): boolean {
  if (now < entry.windowEnd) return false;
  const window = challengeWindowAt(now);
  entry.windowStart = window.start;
  entry.windowEnd = window.end;
  entry.hardBotWins = 0;
  entry.friendWins = 0;
  entry.winsByOpponent = {};
  entry.tickets = {};
  entry.botReceipts = [];
  entry.friendReceipts = [];
  entry.claimedAt = 0;
  entry.claimStars = 0;
  entry.updatedAt = now;
  return true;
}

/** Mint a one-shot Hard AI ticket. `draw` keeps this pure for a caller that owns randomness. */
export function issueBotTicket(entry: ChallengeEntry, now: number, draw: string): string {
  for (const [key, at] of Object.entries(entry.tickets)) {
    if (now - at > CHALLENGE_TICKET_TTL_MS) delete entry.tickets[key];
  }
  const keys = Object.keys(entry.tickets);
  if (keys.length >= 8) delete entry.tickets[keys[0]];
  entry.tickets[draw] = now;
  entry.updatedAt = now;
  return draw;
}

export interface HardBotReport {
  ticket: string;
  won: boolean;
  moves: number;
  difficulty: string;
  format: string;
}

/** Apply a Hard AI victory, or return the reason it was refused. */
export function applyHardBotWin(entry: ChallengeEntry, now: number, report: HardBotReport): ChallengeRefusal | null {
  if (rollChallengeEntry(entry, now)) return 'ticket_expired';
  if (!report.won) return 'not_won';
  if (report.difficulty !== 'hard' || report.format !== '1v1') return 'wrong_track';
  if (entry.hardBotWins >= CHALLENGE_TARGET) return 'already_complete';
  const issuedAt = entry.tickets[report.ticket];
  if (!issuedAt) return entry.botReceipts.includes(report.ticket) ? 'duplicate' : 'no_ticket';
  if (now - issuedAt > CHALLENGE_TICKET_TTL_MS) {
    delete entry.tickets[report.ticket];
    return 'ticket_expired';
  }
  if (now - issuedAt < CHALLENGE_MIN_SECONDS * 1000) return 'not_enough_time';
  if (Math.floor(report.moves) < CHALLENGE_MIN_MOVES) return 'not_enough_moves';
  delete entry.tickets[report.ticket];
  entry.botReceipts.push(report.ticket);
  if (entry.botReceipts.length > CHALLENGE_RECEIPTS_MAX) entry.botReceipts.splice(0, entry.botReceipts.length - CHALLENGE_RECEIPTS_MAX);
  entry.hardBotWins = Math.min(CHALLENGE_TARGET, entry.hardBotWins + 1);
  entry.updatedAt = now;
  return null;
}

export interface FriendWinReport {
  matchId: string;
  opponentTgId: string;
  durationSec: number;
  moves: number;
}

/**
 * Apply a room-settled friend win. The caller must already have proven both seats are distinct
 * verified Telegram accounts and computed the duration/moves from its own board.
 */
export function applyFriendWin(entry: ChallengeEntry, now: number, report: FriendWinReport): ChallengeRefusal | null {
  rollChallengeEntry(entry, now);
  if (!entry.tgId || !/^[0-9]{1,20}$/.test(report.opponentTgId)) return 'self_opponent';
  if (report.opponentTgId === entry.tgId) return 'self_opponent';
  if (!report.matchId || entry.friendReceipts.includes(report.matchId)) return 'duplicate';
  if (entry.friendWins >= CHALLENGE_TARGET) return 'already_complete';
  if (clampSeconds(report.durationSec) < CHALLENGE_MIN_SECONDS) return 'not_enough_time';
  if (Math.floor(report.moves) < CHALLENGE_MIN_MOVES) return 'not_enough_moves';
  const beaten = entry.winsByOpponent[report.opponentTgId] ?? 0;
  if (beaten >= MAX_WINS_PER_FRIEND) return 'friend_cap';
  if (Object.keys(entry.winsByOpponent).length >= CHALLENGE_OPPONENTS_MAX
    && !(report.opponentTgId in entry.winsByOpponent)) return 'friend_cap';
  entry.friendReceipts.push(report.matchId);
  if (entry.friendReceipts.length > CHALLENGE_RECEIPTS_MAX) {
    entry.friendReceipts.splice(0, entry.friendReceipts.length - CHALLENGE_RECEIPTS_MAX);
  }
  entry.winsByOpponent[report.opponentTgId] = beaten + 1;
  entry.friendWins = Math.min(CHALLENGE_TARGET, entry.friendWins + 1);
  entry.updatedAt = now;
  return null;
}

/** 20 / 20 on both tracks: the claim key's only gate. */
export const challengeComplete = (entry: ChallengeEntry): boolean =>
  entry.hardBotWins >= CHALLENGE_TARGET && entry.friendWins >= CHALLENGE_TARGET;

/** Record the winner's claim. The global first-to-complete lock is the caller's (the room's). */
export function claimChallenge(entry: ChallengeEntry, now: number, winner: ChallengeWinner | null): ChallengeRefusal | null {
  rollChallengeEntry(entry, now);
  if (entry.claimedAt > 0) return 'already_claimed';
  if (!challengeComplete(entry)) return 'not_complete';
  if (winner && winner.id !== entry.id) return 'winner_taken';
  entry.claimedAt = now;
  entry.claimStars = CHALLENGE_STARS;
  entry.updatedAt = now;
  return null;
}

/** The card's read model. Digits stay Latin; the client localises every label around them. */
export function challengeView(entry: ChallengeEntry, now: number): Record<string, unknown> {
  const window = challengeWindowAt(now);
  return {
    ok: true,
    tgId: entry.tgId,
    handle: entry.handle,
    windowStart: entry.windowEnd ? entry.windowStart : window.start,
    windowEnd: entry.windowEnd || window.end,
    endsInMs: Math.max(0, (entry.windowEnd || window.end) - now),
    hardBotWins: entry.hardBotWins,
    friendWins: entry.friendWins,
    target: CHALLENGE_TARGET,
    stars: CHALLENGE_STARS,
    maxWinsPerFriend: MAX_WINS_PER_FRIEND,
    friendCount: Object.keys(entry.winsByOpponent).length,
    minSeconds: CHALLENGE_MIN_SECONDS,
    minMoves: CHALLENGE_MIN_MOVES,
    complete: challengeComplete(entry),
    claimed: entry.claimedAt > 0,
    claimedAt: entry.claimedAt,
    claimStars: entry.claimStars,
  };
}
