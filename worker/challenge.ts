/**
 * challenge.ts — the 7-Day "Most Wins" Race: unlimited weekly wins, the Top 3 take 50 Stars each.
 *
 * This module is the server's whole rulebook, kept apart from the room so the anti-cheat can be
 * read (and tested) on its own. The room owns the clock, the receipts and the storage; nothing a
 * client posts can move a counter by itself.
 *
 * Track A — Hard Bot wins (`hardBotWins`). A local bot board never touches the room, so the room
 * issues a one-shot ticket when the board starts and only accepts a victory report that arrives at
 * least 45 seconds later with at least 10 moves played on a hard/1v1 board. The ticket is consumed
 * exactly once and lives in the current window only.
 *
 * Track B — online friend wins (`friendWins`). This counter is written ONLY by the room's own
 * settlement paths (a ranked 1v1 race or a friends lobby): the two seats must be distinct verified
 * Telegram accounts, the board must have lasted 45 seconds (60 when a seat forfeited) and have at
 * least 10 moves. A per-opponent map caps each friend at `MAX_WINS_PER_FRIEND` wins, so alts cannot
 * be farmed.
 *
 * Neither track has a ceiling: `totalWins = friendWins + hardBotWins` grows all week and the race is
 * decided by who stands highest when the 7-day timer ends. Ranking is total wins descending, then
 * `updatedAt` ascending (whoever reached that count first keeps the higher seat). `updatedAt` is
 * therefore only moved by a credited win and by a window roll — never by a read or a ticket.
 *
 * At `weekEndAt` the room locks the Top `MAX_WINNERS` contenders (`totalWins > 0`) as that week's
 * champions, each worth `CHALLENGE_STARS`. The champions claim from the card; the new week starts
 * every counter at 0. A settlement is stored per week, so a claim is paid exactly once and a late
 * boot landing on a boundary still finds the standings it has to lock.
 *
 * Windows are 7 days, aligned to a fixed Monday 00:00 UTC anchor, so the countdown a client paints
 * is the same for every player and a counter can never be farmed across a boundary.
 */

export const CHALLENGE_KEY = 'challenge.v1';
export const CHALLENGE_DAYS = 7;
export const CHALLENGE_WINDOW_MS = CHALLENGE_DAYS * 24 * 60 * 60 * 1000;
/** Fixed Monday 00:00 UTC: 2024-01-01, so every 7-day cycle starts on a Monday. */
export const CHALLENGE_WINDOW_ANCHOR = Date.UTC(2024, 0, 1);
/** What each of the week's champions is paid. */
export const CHALLENGE_STARS = 50;
/** The week's podium: positions 1..3 are paid, nobody else is. */
export const MAX_WINNERS = 3;
/** A hard-bot win must be at least this long on the ROOM's clock. */
export const CHALLENGE_MIN_SECONDS = 45;
/** A friend win that came from a forfeit must clear this much of the board first. */
export const CHALLENGE_FORFEIT_MIN_SECONDS = 60;
/** Both tracks require this many played moves. */
export const CHALLENGE_MIN_MOVES = 10;
/** Unique-opponent anti-farming cap: a single friend can only ever be worth 3 wins a week. */
export const MAX_WINS_PER_FRIEND = 3;
/** How long an issued Hard AI ticket stays usable. */
export const CHALLENGE_TICKET_TTL_MS = 3 * 60 * 60 * 1000;
/** Bounds so one busy room cannot grow an unbounded ledger. */
export const CHALLENGE_PLAYERS_MAX = 4000;
export const CHALLENGE_OPPONENTS_MAX = 200;
export const CHALLENGE_RECEIPTS_MAX = 96;
export const CHALLENGE_KEEP_MS = CHALLENGE_WINDOW_MS * 2;
/**
 * There is no weekly ceiling. This number only stops a corrupt or hostile stored value from
 * overflowing the counters; a real week cannot come close to it.
 */
export const CHALLENGE_WINS_MAX = 1_000_000;
/** Three settlements per week, kept for twenty weeks: enough history to always find a claim. */
export const CHALLENGE_SETTLEMENTS_MAX = 60;

/** One player's 7-day scorecard. Every field is written by the room, never by a request body. */
export interface ChallengeEntry {
  id: string;
  /** The verified numeric Telegram id; empty for a guest seat (which cannot compete). */
  tgId: string;
  /** Public handle the board prints: `@username` when the registry has one, else the id. */
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
  /** When this player reached the win count they hold — the ranking's one tie-breaker. */
  updatedAt: number;
}

/** One champion of a closed week: the payout record, and the proof the position was real. */
export interface ChallengeSettlement {
  /** The internal entry id. Never serialised to a client. */
  id: string;
  weekStart: number;
  weekEnd: number;
  /** 1..MAX_WINNERS. */
  rank: number;
  handle: string;
  tgId: string;
  totalWins: number;
  claimedAt: number;
  stars: number;
}

export interface ChallengeState {
  entries: ChallengeEntry[];
  settlements: ChallengeSettlement[];
}

/** One public row of the weekly board. The internal `id` is never part of it. */
export interface ChallengeBoardRow {
  position: number;
  handle: string;
  friendWins: number;
  hardBotWins: number;
  totalWins: number;
  isMe: boolean;
}

export interface ChallengeBoard {
  /** Every participant of the live week, zero wins included, in ranking order. */
  rows: ChallengeBoardRow[];
  /** 1-based live rank of the reader, or null while they hold no seat in the live week. */
  myPosition: number | null;
  totalWins: number;
  friendWins: number;
  hardBotWins: number;
  /** How many verified seats are registered in the live week (see totalParticipants). */
  contenders: number;
  /** The board's full population: every participant of the live week. */
  totalParticipants: number;
  /** True when the reader himself holds a live seat on this week's board. */
  isEnrolled: boolean;
}

/** Why a report or a claim was refused. Every value maps to one localised line on the card. */
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
  | 'not_complete'
  | 'already_claimed';

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

/** `friendWins + hardBotWins`, uncapped for the week. */
export const challengeTotalWins = (entry: ChallengeEntry): number =>
  Math.max(0, entry.friendWins) + Math.max(0, entry.hardBotWins);

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
    hardBotWins: clampInt(r.hardBotWins, CHALLENGE_WINS_MAX),
    friendWins: clampInt(r.friendWins, CHALLENGE_WINS_MAX),
    winsByOpponent: {},
    tickets: {},
    botReceipts: [],
    friendReceipts: [],
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

const readSettlement = (raw: unknown): ChallengeSettlement | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ChallengeSettlement>;
  const id = readText(r.id, 64);
  const tgId = /^[0-9]{1,20}$/.test(readText(r.tgId, 20)) ? readText(r.tgId, 20) : '';
  const weekStart = readStamp(r.weekStart);
  const weekEnd = readStamp(r.weekEnd);
  const rank = clampInt(r.rank, MAX_WINNERS);
  if (!id || !tgId || !weekStart || !weekEnd || rank < 1) return null;
  return {
    id,
    weekStart,
    weekEnd,
    rank,
    handle: readText(r.handle, 40) || tgId,
    tgId,
    totalWins: clampInt(r.totalWins, CHALLENGE_WINS_MAX),
    claimedAt: readStamp(r.claimedAt),
    stars: clampInt(r.stars, CHALLENGE_STARS),
  };
};

/** Defensive parse of the ledger: an unreadable row is skipped, never fatal. */
export function readChallengeState(raw: unknown): ChallengeState {
  const out: ChallengeState = { entries: [], settlements: [] };
  if (!raw || typeof raw !== 'object') return out;
  const state = raw as { entries?: unknown; settlements?: unknown };
  if (Array.isArray(state.entries)) {
    for (const row of state.entries) {
      const entry = readEntry(row);
      if (entry) out.entries.push(entry);
    }
  }
  if (Array.isArray(state.settlements)) {
    for (const row of state.settlements) {
      const settlement = readSettlement(row);
      if (settlement) out.settlements.push(settlement);
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
  entry.updatedAt = now;
  return true;
}

/**
 * The board's one ordering: total wins descending, then the earliest `updatedAt` — the player who
 * reached that count first holds the higher seat. `id` only keeps the sort total and stable.
 */
export function rankContenders(rows: ChallengeEntry[]): ChallengeEntry[] {
  return [...rows].sort((a, b) => {
    const byWins = challengeTotalWins(b) - challengeTotalWins(a);
    if (byWins !== 0) return byWins;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Close every window that has ended: lock the finished week's Top-3 (each worth 50 Stars) and roll
 * every scorecard into the live week. Pure over the rows it is handed; the room owns the storage.
 *
 * Only the week that ended at the current window's start is settled: an entry two weeks stale is
 * history and its undelivered claim is gone, which keeps the ledger from resurrecting old podiums.
 */
export function settleChallengeWeek(rows: ChallengeEntry[], now: number): ChallengeSettlement[] {
  const window = challengeWindowAt(now);
  const champions = rankContenders(rows.filter((row) => (
    row.windowEnd === window.start && !!row.tgId && challengeTotalWins(row) > 0
  ))).slice(0, MAX_WINNERS);
  const settlements: ChallengeSettlement[] = champions.map((row, at) => ({
    id: row.id,
    weekStart: row.windowStart,
    weekEnd: row.windowEnd,
    rank: at + 1,
    handle: row.handle || row.tgId,
    tgId: row.tgId,
    totalWins: challengeTotalWins(row),
    claimedAt: 0,
    stars: CHALLENGE_STARS,
  }));
  for (const row of rows) rollChallengeEntry(row, now);
  return settlements;
}

/**
 * The live weekly board for one reader, plus their own seat on it.
 *
 * Every verified Telegram seat registered in the active window is listed, even at zero wins, and
 * there is no row cutoff: the whole participating field is returned in the one ranking order
 * (total wins descending, then the earliest `updatedAt` — whoever reached that count first keeps
 * the higher seat). Guest seats never participate, so they hold no row. The internal ids and the
 * per-opponent ledger stay in the room; a row carries the public handle only.
 */
export function challengeBoard(rows: ChallengeEntry[], selfId: string, now: number): ChallengeBoard {
  const window = challengeWindowAt(now);
  const live = rankContenders(rows.filter((row) => (
    row.windowStart === window.start
    && row.windowEnd > now
    && !!row.tgId
  )));
  const mine = rows.find((row) => row.id === selfId) ?? null;
  const at = live.findIndex((row) => row.id === selfId);
  /* Every verified seat is enrolled automatically: the reader holds a row whenever he is on the
     live field, and a guest (whose card carries no Telegram id) can never hold one. */
  const isEnrolled = at >= 0;
  return {
    rows: live.map((row, index) => ({
      position: index + 1,
      handle: row.handle || row.tgId,
      friendWins: row.friendWins,
      hardBotWins: row.hardBotWins,
      totalWins: challengeTotalWins(row),
      isMe: row.id === selfId,
    })),
    myPosition: at >= 0 ? at + 1 : null,
    totalWins: mine ? challengeTotalWins(mine) : 0,
    friendWins: mine ? mine.friendWins : 0,
    hardBotWins: mine ? mine.hardBotWins : 0,
    contenders: live.length,
    totalParticipants: live.length,
    isEnrolled,
  };
}

/** Mint a one-shot Hard AI ticket. `draw` keeps this pure for a caller that owns randomness. */
export function issueBotTicket(entry: ChallengeEntry, now: number, draw: string): string {
  for (const [key, at] of Object.entries(entry.tickets)) {
    if (now - at > CHALLENGE_TICKET_TTL_MS) delete entry.tickets[key];
  }
  const keys = Object.keys(entry.tickets);
  if (keys.length >= 8) delete entry.tickets[keys[0]];
  entry.tickets[draw] = now;
  /* Issuing a ticket is not a win: `updatedAt` is the ranking's tie-breaker, so it must not move
     here or a player could lose a tied seat by simply starting another board. */
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
  /* No ceiling: every verified Hard AI win counts, for as long as the week runs. */
  entry.hardBotWins = Math.min(CHALLENGE_WINS_MAX, entry.hardBotWins + 1);
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
  /* No ceiling here either: the friend cap above is the only limit that matters. */
  entry.friendWins = Math.min(CHALLENGE_WINS_MAX, entry.friendWins + 1);
  entry.updatedAt = now;
  return null;
}

/**
 * Record a champion's payout claim. The settlement is the proof: it only exists for a finished
 * week's Top 3, so a claim needs no counter and can be paid exactly once.
 */
export function claimSettlement(settlement: ChallengeSettlement | null, now: number): ChallengeRefusal | null {
  if (!settlement) return 'not_complete';
  if (settlement.rank < 1 || settlement.rank > MAX_WINNERS) return 'not_complete';
  if (now < settlement.weekEnd) return 'not_complete';
  if (settlement.claimedAt > 0) return 'already_claimed';
  settlement.claimedAt = now;
  settlement.stars = CHALLENGE_STARS;
  return null;
}

/** The card's read model. Digits stay Latin; the client localises every label around them. */
export function challengeView(
  entry: ChallengeEntry,
  now: number,
  board: ChallengeBoard,
  claimable: ChallengeSettlement | null,
  latest: ChallengeSettlement | null,
): Record<string, unknown> {
  const window = challengeWindowAt(now);
  return {
    ok: true,
    tgId: entry.tgId,
    handle: entry.handle,
    windowStart: entry.windowStart || window.start,
    windowEnd: entry.windowEnd || window.end,
    endsInMs: Math.max(0, (entry.windowEnd || window.end) - now),
    hardBotWins: entry.hardBotWins,
    friendWins: entry.friendWins,
    totalWins: challengeTotalWins(entry),
    myPosition: board.myPosition,
    leaderboard: board.rows,
    contenders: board.contenders,
    totalParticipants: board.totalParticipants,
    isEnrolled: board.isEnrolled,
    stars: CHALLENGE_STARS,
    maxWinners: MAX_WINNERS,
    maxWinsPerFriend: MAX_WINS_PER_FRIEND,
    friendCount: Object.keys(entry.winsByOpponent).length,
    minSeconds: CHALLENGE_MIN_SECONDS,
    forfeitMinSeconds: CHALLENGE_FORFEIT_MIN_SECONDS,
    minMoves: CHALLENGE_MIN_MOVES,
    /** The rank this player can collect for the week that just closed, or null. */
    claimableRank: claimable ? claimable.rank : null,
    claimableStars: claimable ? CHALLENGE_STARS : 0,
    claimableWeekEnd: claimable ? claimable.weekEnd : 0,
    /** The last podium they were on, claimed or not — the card's receipt line. */
    lastRank: latest ? latest.rank : null,
    lastStars: latest ? latest.stars : 0,
    claimed: !!latest && latest.claimedAt > 0,
    claimedAt: latest ? latest.claimedAt : 0,
  };
}
