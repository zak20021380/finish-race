/**
 * challenge.ts — the 7-Day "Most Wins" Race: unlimited weekly wins, the Top 3 split 50 Stars.
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
 * champions. The `TOTAL_PRIZE_POOL` is split across the podium by `PRIZE_BY_RANK`: 25 / 15 / 10.
 * The champions claim from the card; the new week starts every counter at 0. A settlement is
 * stored per week, so a claim is paid exactly once and a late boot landing on a boundary still
 * finds the standings it has to lock.
 *
 * Windows are exactly 7 days — 168 hours — counted from the season epoch that was stamped when
 * the tournament launched, not from a Monday 00:00 UTC calendar anchor. A launch-week window can
 * therefore never lose the days that already passed before the next Monday: week one opens on the
 * launch instant with a full week on the clock, and every later round starts exactly one
 * `WEEK_MS` after the one before. The countdown a client paints is the same for every player and
 * a counter can never be farmed across a boundary.
 */

export const CHALLENGE_KEY = 'challenge.v1';
export const CHALLENGE_DAYS = 7;
/** One exact tournament week: 7 days = 168 hours = 604,800,000 ms. */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const CHALLENGE_WINDOW_MS = WEEK_MS;
/**
 * The V2 launch stamp: November 25, 2026, 12:15 UTC — the instant the current 168-hour cycle was
 * re-anchored. It is the FLOOR of the season grid: any ledger read back from Durable Object
 * storage with an older (or missing) stamp is re-stamped on this instant, so testing that ran on
 * the retired V1 anchor can never leave the live card counting down a partial week.
 */
export const SEASON_EPOCH_V2 = Date.UTC(2026, 10, 25, 12, 15, 0);
/**
 * The launch stamp of the very first 168-hour window the live build runs on. The tournament
 * starts on the launch instant instead of the next calendar Monday, so the opening week keeps
 * the whole seven days. Every later round is this instant plus a whole number of `WEEK_MS`.
 */
export const CHALLENGE_SEASON_EPOCH = SEASON_EPOCH_V2;
/** Legacy name for the season epoch, kept for callers that still import the old anchor. */
export const CHALLENGE_WINDOW_ANCHOR = CHALLENGE_SEASON_EPOCH;
/**
 * The epoch the live room actually runs on. It defaults to the V2 launch stamp above; a ledger
 * read back from Durable Object storage may carry the stamp it was created with, and adopting it
 * keeps a reboot on the same 168-hour grid — but only when that stamp is on or after V2.
 */
let activeSeasonEpoch = CHALLENGE_SEASON_EPOCH;
/** True when the last `readChallengeState` had to re-anchor an older ledger onto V2. */
let seasonEpochMigrated = false;
/** The week's total prize pool, divided across the Top 3 finishers. */
export const TOTAL_PRIZE_POOL = 50;
/** The exact payout for each podium rank: 25 / 15 / 10, summing to the 50-Star pool. */
export const PRIZE_BY_RANK: Record<1 | 2 | 3, number> = { 1: 25, 2: 15, 3: 10 };
/** Legacy alias for the pool total (50), kept for callers that print the headline. */
export const CHALLENGE_STARS = TOTAL_PRIZE_POOL;
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
  /** Public handle the room keeps for the receipt/settlement lines, e.g. `@username`. */
  handle: string;
  /**
   * The printable name the standings show: the verified Telegram `first_name` + `last_name`
   * (never prefixed with `@`). Falls back to the stored handle or the id when no real name exists.
   */
  displayName: string;
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
  /**
   * The launch stamp this ledger belongs to. A ledger that carries it is resumed on the exact
   * same 168-hour grid; when the field is absent the fixed launch epoch above wins.
   */
  seasonEpoch: number;
}

/** One public row of the weekly board. The internal room id is never part of it. */
export interface ChallengeBoardRow {
  position: number;
  /** The seat's numeric Telegram user id, so a tap can open that player's profile. */
  userId: string;
  /** The seat's real Telegram display name — never an `@handle`, never empty. */
  displayName: string;
  handle: string;
  friendWins: number;
  hardBotWins: number;
  totalWins: number;
  /** The exact pool slice this position pays at week close: 25 / 15 / 10, else 0. */
  prizeStars: number;
  isMe: boolean;
  /**
   * The registry's ISO 3166-1 alpha-2 nation for this seat, or null when their profile never set
   * one. The row carries the code only: the client localises it, the room never guesses a nation.
   */
  country: string | null;
  /** The player-declared age from the registry, or null when their profile never set one. */
  age: number | string | null;
}

/**
 * The two registry profile fields a standings row mirrors. Resolved by the room from its own
 * player registry — never from the request body — so a board can neither invent nor edit an
 * identity. A null field is the honest reading: the seat never set that profile value.
 */
export interface ChallengeIdentity {
  country: string | null;
  age: number | string | null;
}

/** Resolve one seat's registry identity. Null means the room holds no profile for that seat. */
export type ChallengeIdentityLookup = (playerId: string) => ChallengeIdentity | null;

export interface ChallengeBoard {
  /** Every participant of the live week, zero wins included, in ranking order. */
  rows: ChallengeBoardRow[];
  /** The week's total prize pool (50). */
  totalPrizePool: number;
  /** The exact payout of each podium rank (25 / 15 / 10). */
  prizeByRank: Record<1 | 2 | 3, number>;
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

const readName = (raw: unknown, max: number): string =>
  typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().replace(/^@+/, '').slice(0, max).trim() : '';

/**
 * The printable name a standings row shows: the verified Telegram `first_name` + `last_name` when
 * the room holds one, then the sanitized handle (its `@` stripped, so a legacy row prints a name
 * rather than a handle), and the Telegram id only as the last resort. A returned value is never
 * empty and never carries a leading at-sign.
 */
export function challengeDisplayName(raw: unknown, handle: unknown = '', tgId: unknown = ''): string {
  const name = readName(raw, 64);
  if (name) return name;
  const fallbackHandle = readName(handle, 40);
  if (fallbackHandle && !/^[0-9]{1,20}$/.test(fallbackHandle)) return fallbackHandle;
  const id = readName(tgId, 20);
  return id || fallbackHandle || 'Player';
}

/** The exact Star payout for a podium rank; 0 for every position outside the Top 3. */
export function prizeForRank(rank: number): number {
  if (rank === 1) return PRIZE_BY_RANK[1];
  if (rank === 2) return PRIZE_BY_RANK[2];
  if (rank === 3) return PRIZE_BY_RANK[3];
  return 0;
}

/** `friendWins + hardBotWins`, uncapped for the week. */
export const challengeTotalWins = (entry: ChallengeEntry): number =>
  Math.max(0, entry.friendWins) + Math.max(0, entry.hardBotWins);

/** The season epoch every window calculation runs on. */
export function challengeSeasonEpoch(): number {
  return activeSeasonEpoch;
}

/**
 * Adopt a launch stamp read back from storage.
 *
 * The V2 launch stamp is a floor, not a preference: a stamp older than `SEASON_EPOCH_V2` belongs
 * to a retired/testing ledger, so it is overwritten with V2 on the spot (and the migration is
 * flagged, so the room writes that decision back immediately). A stamp on or after V2 is adopted
 * unchanged, which keeps a restart on the very same 168-hour grid.
 */
export function setChallengeSeasonEpoch(raw: unknown): number {
  const stamp = readStamp(raw);
  if (stamp >= SEASON_EPOCH_V2) {
    activeSeasonEpoch = stamp;
    seasonEpochMigrated = false;
    return activeSeasonEpoch;
  }
  activeSeasonEpoch = SEASON_EPOCH_V2;
  seasonEpochMigrated = true;
  return activeSeasonEpoch;
}

/** True when the last ledger read had to re-anchor a retired (or missing) season epoch on V2. */
export function challengeSeasonMigrated(): boolean {
  return seasonEpochMigrated;
}

/** The deterministic week index of `now` inside the season started by `epoch` (never negative). */
export function challengeWeekIndex(now: number, epoch: number = activeSeasonEpoch): number {
  return Math.max(0, Math.floor((now - epoch) / WEEK_MS));
}

/**
 * The exact 168-hour window that contains `now`:
 * `weekStart = epoch + floor((now - epoch) / WEEK_MS) * WEEK_MS`, `weekEnd = weekStart + WEEK_MS`.
 * Every round therefore advances on a whole-week boundary that is fixed at launch, never on a
 * calendar weekday, so the first week keeps its full seven days.
 */
export function challengeWindowAt(now: number, epoch: number = activeSeasonEpoch): { start: number; end: number } {
  const anchor = readStamp(epoch) || CHALLENGE_SEASON_EPOCH;
  const weekStart = anchor + challengeWeekIndex(now, anchor) * WEEK_MS;
  return { start: weekStart, end: weekStart + WEEK_MS };
}

/** A brand-new scorecard for the current window. */
export function newChallengeEntry(
  id: string,
  tgId: string,
  handle: string,
  now: number,
  displayName = '',
): ChallengeEntry {
  const window = challengeWindowAt(now);
  return {
    id,
    tgId,
    handle,
    displayName: challengeDisplayName(displayName, handle, tgId),
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
    displayName: challengeDisplayName(r.displayName, r.handle, r.tgId),
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
  const out: ChallengeState = { entries: [], settlements: [], seasonEpoch: activeSeasonEpoch };
  if (!raw || typeof raw !== 'object') return out;
  const state = raw as { entries?: unknown; settlements?: unknown; seasonEpoch?: unknown };
  /* Adopt the stored launch stamp BEFORE the rows are parsed: a row's fallback window must be
     computed on the season the ledger was written under, not on a different default. */
  out.seasonEpoch = setChallengeSeasonEpoch(state.seasonEpoch);
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

/**
 * Start a fresh cycle when the old window closed. Returns true when the entry was reset.
 *
 * A row is also re-anchored when its stored window is NOT the live 168-hour window of `now` (a
 * ledger written under the retired V1 epoch, or one whose boundary drifted while the room slept).
 * Without that re-anchor a stale card keeps printing a partial countdown — the `4d 11h` symptom —
 * even though the live week has already restarted on the V2 launch instant.
 */
export function rollChallengeEntry(entry: ChallengeEntry, now: number): boolean {
  const window = challengeWindowAt(now);
  const onLiveWindow = entry.windowStart === window.start && entry.windowEnd === window.end;
  if (onLiveWindow && now < entry.windowEnd) return false;
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
 * Close every window that has ended: lock the finished week's Top-3 and their 25 / 15 / 10 slices
 * of the 50-Star pool, then roll every scorecard into the live week. Pure over the rows it is
 * handed; the room owns the storage.
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
    stars: prizeForRank(at + 1),
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
 * the higher seat). Guest seats never participate, so they hold no row. The room's internal id and
 * the per-opponent ledger stay in the room; a row carries the numeric Telegram id, the printable
 * display name, the public handle, and the two profile fields the client localises (nation, age).
 *
 * `identity` is the room's own registry reader. It is optional so a pure caller (a rulebook test)
 * can rank a ledger with no registry at all: a missing reader simply leaves both fields null.
 */
export function challengeBoard(
  rows: ChallengeEntry[],
  selfId: string,
  now: number,
  identity: ChallengeIdentityLookup | null = null,
): ChallengeBoard {
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
    rows: live.map((row, index) => {
      const profile = identity ? identity(row.id) : null;
      return {
        position: index + 1,
        userId: row.tgId,
        displayName: row.displayName || challengeDisplayName('', row.handle, row.tgId),
        handle: row.handle || row.tgId,
        friendWins: row.friendWins,
        hardBotWins: row.hardBotWins,
        totalWins: challengeTotalWins(row),
        prizeStars: prizeForRank(index + 1),
        isMe: row.id === selfId,
        country: profile ? profile.country : null,
        age: profile ? profile.age : null,
      };
    }),
    totalPrizePool: TOTAL_PRIZE_POOL,
    prizeByRank: PRIZE_BY_RANK,
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
  /* The rank owns the payout: 25 / 15 / 10, regardless of any stored legacy value. Normalising
     before the state checks keeps even an already-claimed settlement's receipt exact. */
  settlement.stars = prizeForRank(settlement.rank);
  if (now < settlement.weekEnd) return 'not_complete';
  if (settlement.claimedAt > 0) return 'already_claimed';
  settlement.claimedAt = now;
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
  const prizeStars = board.myPosition ? prizeForRank(board.myPosition) : 0;
  /* The reader's own registry identity rides the card beside the board, so the client can paint a
     profile that the served standings did not happen to include (a brand-new seat still prints). */
  const self = board.rows.find((row) => row.isMe) ?? null;
  return {
    ok: true,
    tgId: entry.tgId,
    /** The reader's numeric Telegram id when verified; empty for a guest seat. */
    userId: entry.tgId,
    handle: entry.handle,
    /** The printable name the card's own seat prints — never an `@handle`. */
    displayName: entry.displayName || challengeDisplayName('', entry.handle, entry.tgId),
    /** The reader's own nation (ISO alpha-2) and age, or null when their profile never set one. */
    country: self ? self.country : null,
    age: self ? self.age : null,
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
    /** The overall pool and its exact Top-3 split, so the client never hard-codes a payout. */
    totalPrizePool: TOTAL_PRIZE_POOL,
    prizeByRank: PRIZE_BY_RANK,
    /** This seat's slice were the week to close at its current rank: 25 / 15 / 10, else 0. */
    prizeStars,
    stars: CHALLENGE_STARS,
    maxWinners: MAX_WINNERS,
    maxWinsPerFriend: MAX_WINS_PER_FRIEND,
    friendCount: Object.keys(entry.winsByOpponent).length,
    minSeconds: CHALLENGE_MIN_SECONDS,
    forfeitMinSeconds: CHALLENGE_FORFEIT_MIN_SECONDS,
    minMoves: CHALLENGE_MIN_MOVES,
    /** The rank this player can collect for the week that just closed, or null. */
    claimableRank: claimable ? claimable.rank : null,
    claimableStars: claimable ? prizeForRank(claimable.rank) : 0,
    claimableWeekEnd: claimable ? claimable.weekEnd : 0,
    /** The last podium they were on, claimed or not — the card's receipt line. */
    lastRank: latest ? latest.rank : null,
    lastStars: latest ? latest.stars : 0,
    claimed: !!latest && latest.claimedAt > 0,
    claimedAt: latest ? latest.claimedAt : 0,
  };
}

/**
 * A declared seat for a Telegram Desktop / external WebView session, where the signed `initData`
 * is absent, expired or fails its signature check. The join door accepts it for enrollment only:
 * it registers the declared positive Telegram id in the live window at zero wins and never
 * credits a counter from the body. The id is normalized to the same canonical `tg-<digits>` form
 * the verified door produces, and the body's `displayName` (the real first + last name the client
 * painted) becomes the seat's printable name; the declared handle is only the last fallback.
 */
export interface ChallengeFallbackSeat {
  playerId: string;
  tgId: string;
  name: string;
}

export function challengeFallbackSeat(raw: unknown): ChallengeFallbackSeat | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as { userId?: unknown; handle?: unknown; displayName?: unknown };
  const rawId = typeof body.userId === 'number'
    ? (Number.isSafeInteger(body.userId) ? String(body.userId) : '')
    : typeof body.userId === 'string' ? body.userId.trim() : '';
  /* A positive integer id only: no zero, no sign, no decimal, at most a Telegram-sized 20 digits. */
  if (!/^[1-9][0-9]{0,19}$/.test(rawId)) return null;
  const declared = typeof body.handle === 'string'
    ? body.handle.trim().replace(/^@+/, '').replace(/\s+/g, ' ').slice(0, 32).trim()
    : '';
  if (!declared) return null;
  /* The real name wins over the handle; the handle (its `@` stripped) is the fallback only. */
  return {
    playerId: 'tg-' + rawId,
    tgId: rawId,
    name: challengeDisplayName(body.displayName, declared, rawId),
  };
}
