/**
 * matches.ts — the server's own record of a match, and the only door a point can come through.
 *
 * A client can say anything: who it is, who won, how long the board lasted. None of that is worth
 * a point on its own. So the room mints the match, stamps the clock, and remembers the row:
 *
 *   POST /api/match/start  →  { matchId, player1Id, player2Id, mode, status:'active', startedAt }
 *   POST /api/match/end    →  the three gates below, then one atomic flip to `completed`
 *
 * The three gates, in order, and why each one exists:
 *
 *   1. PARTICIPANT — the caller's verified seat must be `player1Id` or `player2Id` of that exact
 *      row. A match id is not a capability: knowing somebody else's id buys nothing.
 *   2. ACTIVE — the row must still be `active`. A completed row is a spent receipt, so replaying
 *      the same call answers `not_active` instead of paying twice. An `expired` row is the same
 *      answer for a tab that was closed overnight.
 *   3. CLOCK — `now - startedAt >= MATCH_MIN_MS` (15 s) on the ROOM's clock, never the client's.
 *      An instant submission is a script, not a board. The mirror gate (`MATCH_MAX_AGE_MS`) stops
 *      a stale tab from redeeming a board nobody remembers.
 *
 * The flip happens BEFORE the payout is computed, and it is the caller's `status === 'active'`
 * read that makes it atomic: `MatchmakerDO` is a single-threaded Durable Object, so the read and
 * the write of that one field cannot interleave with a second request. Whoever flips it first is
 * the only caller that ever reaches `completeMatch`.
 *
 * Rewards are FIXED and server-side. The body cannot scale them, and only a `pvp` win is worth
 * leaderboard points — `friendly` and `ai` pay coins and XP (things that cannot buy a rank) and
 * nothing else, so a friend or a bot can never be farmed into the tournament.
 */
import type { Env } from './env';

/* ---------- vocabulary ---------- */

/**
 * The three kinds of board the room records. `pvp` is ranked matchmaking, `friendly` is a
 * code-lobby duel between people who know each other, `ai` is a practice board against a bot.
 * Only `pvp` is worth ladder points; the other two exist so a board can still be *recorded*
 * (played count, history strip, streaks) without touching the tournament.
 */
export type MatchMode = 'pvp' | 'friendly' | 'ai';

/** `active` until somebody settles it; `expired` is a row the sweeper closed unpaid. */
export type MatchStatus = 'active' | 'completed' | 'expired';

/** The only three kinds of match row the room writes. Anything else is refused at the door. */
export function matchKindOf(raw: unknown): MatchMode | null {
  return raw === 'pvp' || raw === 'friendly' || raw === 'ai' ? raw : null;
}

/** A second name for the mode, for callers that already import a `MatchMode` of their own. */
export type MatchKind = MatchMode;

/** True only for the one mode that may move a tournament/leaderboard counter. */
export function countsForLeaderboard(mode: MatchMode): boolean {
  return mode === 'pvp';
}

/* ---------- the clock ---------- */

/**
 * The floor a board must clear before its result is worth anything: 15 seconds on the room's
 * clock. A script that starts and finishes in the same breath is refused here, and a real board
 * always clears it by a wide margin.
 */
export const MATCH_MIN_MS = 15_000;
/** A row older than this is a closed tab, not a live board: it can no longer be settled. */
export const MATCH_MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** Rows kept after settlement, so a late replay still finds its spent receipt. */
export const MATCH_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard bound on the ledger: a busy room cannot grow it without limit. */
export const MATCHES_MAX = 4000;
/** How many unsettled rows one seat may hold. A script cannot open a thousand boards. */
export const MATCH_OPEN_MAX = 3;
/** A friendly pairing may be worth at most this many boards per UTC day. */
export const FRIENDLY_PAIR_DAILY_MAX = 2;
/**
 * A ranked pairing may be worth at most this many WINS per UTC day.
 *
 * This is the two-account farm gate. `pvp` is the one mode that pays a ladder point, so a script
 * with two Telegram accounts would otherwise meet itself all afternoon and climb. Three wins
 * against one rival is generous for real play — two friends queueing together rarely meet more
 * often than that in a day — and it caps what a single alt can ever be worth.
 */
export const PVP_PAIR_DAILY_MAX = 3;

/* ---------- the reward ---------- */

/** What one settled board pays. Fixed by the server; the body never contributes a figure. */
export interface MatchReward {
  /** Leaderboard points. Non-zero only for a `pvp` win. */
  tiq: number;
  coins: number;
  xp: number;
}

/** A defeat pays nothing: a loss that paid would be the cheapest farm in the game. */
export const MATCH_NO_REWARD: MatchReward = { tiq: 0, coins: 0, xp: 0 };

/**
 * The exact payout of one win, by mode. The `pvp` line is the ONLY place a leaderboard point is
 * minted; the other two pay in currency, which buys cosmetics and never a rank.
 */
export const MATCH_REWARD: Record<MatchMode, MatchReward> = {
  pvp: { tiq: 25, coins: 40, xp: 30 },
  friendly: { tiq: 0, coins: 12, xp: 10 },
  ai: { tiq: 0, coins: 6, xp: 6 },
};

/** The payout of one result: the mode's win line, or nothing at all. */
export function rewardFor(mode: MatchMode, won: boolean): MatchReward {
  if (!won) return MATCH_NO_REWARD;
  const line = MATCH_REWARD[mode] ?? MATCH_NO_REWARD;
  return { tiq: line.tiq, coins: line.coins, xp: line.xp };
}

/* ---------- the row ---------- */

/** One match, exactly as the room remembers it. Every field is written by the room. */
export interface MatchRecord {
  matchId: string;
  /** The seat that opened the session, `tg-<digits>` (or a guest seat on a dev host). */
  player1Id: string;
  /** The rival seat, or `'ai'` for a practice board, or `''` when nobody was named. */
  player2Id: string;
  mode: MatchMode;
  status: MatchStatus;
  /** The room's clock at `match/start`. The 15-second gate reads this and nothing else. */
  startedAt: number;
  /** The room's clock at settlement; 0 while the row is still open. */
  completedAt: number;
  /** The winning seat, or `''` while the row is open. Always one of the participants. */
  winnerId: string;
  /** The depth the client reported, kept for the audit trail — never a gate on its own. */
  moves: number;
  /** What this settlement paid. Zero on a loss, and zero on any non-`pvp` leaderboard line. */
  reward: MatchReward;
}

/** The persisted shape: the rows plus the friendly-pair quota that keeps a duo from farming. */
export interface MatchLedgerState {
  matches: MatchRecord[];
  /** `pairKey|day` → how many friendly boards that pair has already been paid for. */
  friendly: Record<string, number>;
}

/** Why a settlement was refused. Every value maps to one line a client can log or localise. */
export type MatchRefusal =
  | 'unknown_match'
  | 'not_participant'
  | 'not_active'
  | 'too_fast'
  | 'expired'
  | 'bad_winner'
  | 'self_opponent'
  | 'friendly_cap';

/* ---------- reading a stored row ---------- */

const readText = (raw: unknown, max: number): string =>
  typeof raw === 'string' ? raw.trim().slice(0, max) : '';

const readStamp = (raw: unknown): number => {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
  return n > 0 ? n : 0;
};

const readWhole = (raw: unknown, max: number): number => {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
  return Math.max(0, Math.min(max, n));
};

/** A seat id as the room spells it: `tg-<digits>`, a `guest-<hex>` seat, or the literal `ai`. */
export const SEAT_RE = /^(tg-[0-9]{1,20}|guest-[0-9a-f]{8,32}|ai)$/;

/** Normalize one seat id, or '' when it is not a shape this room ever writes. */
export function matchSeatOf(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === 'ai') return 'ai';
  if (/^[1-9][0-9]{0,19}$/.test(text)) return `tg-${text}`;
  return SEAT_RE.test(text) ? text : '';
}

/** The defensive parse of one stored row: an unreadable row is dropped, never fatal. */
export function readMatchRecord(raw: unknown): MatchRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<MatchRecord>;
  const matchId = readText(r.matchId, 64);
  const player1Id = matchSeatOf(r.player1Id);
  const mode = matchKindOf(r.mode);
  const startedAt = readStamp(r.startedAt);
  if (!matchId || !player1Id || !mode || !startedAt) return null;
  const status: MatchStatus = r.status === 'completed' || r.status === 'expired' ? r.status : 'active';
  const reward = r.reward && typeof r.reward === 'object' ? r.reward : MATCH_NO_REWARD;
  return {
    matchId,
    player1Id,
    player2Id: matchSeatOf(r.player2Id),
    mode,
    status,
    startedAt,
    completedAt: readStamp(r.completedAt),
    winnerId: matchSeatOf(r.winnerId),
    moves: readWhole(r.moves, 100_000),
    reward: {
      tiq: readWhole(reward.tiq, 100_000),
      coins: readWhole(reward.coins, 100_000_000),
      xp: readWhole(reward.xp, 100_000),
    },
  };
}

/** The defensive parse of the whole ledger. */
export function readMatchLedger(raw: unknown): MatchLedgerState {
  const out: MatchLedgerState = { matches: [], friendly: {} };
  if (!raw || typeof raw !== 'object') return out;
  const state = raw as { matches?: unknown; friendly?: unknown };
  if (Array.isArray(state.matches)) {
    for (const row of state.matches) {
      const record = readMatchRecord(row);
      if (record) out.matches.push(record);
    }
  }
  const friendly = state.friendly;
  if (friendly && typeof friendly === 'object') {
    for (const key of Object.keys(friendly).slice(0, 2000)) {
      const n = readWhole((friendly as Record<string, unknown>)[key], 1000);
      if (n > 0) out.friendly[key.slice(0, 96)] = n;
    }
  }
  return out;
}

/* ---------- opening a session ---------- */

/**
 * Mint one open row. The id is the room's (`crypto.randomUUID`), the clock is the room's, and the
 * only thing the caller contributed is which mode it wants and who it is playing.
 */
export function newMatchRecord(
  matchId: string,
  player1Id: string,
  player2Id: string,
  mode: MatchMode,
  now: number,
): MatchRecord {
  return {
    matchId,
    player1Id,
    player2Id: matchSeatOf(player2Id),
    mode,
    status: 'active',
    startedAt: now,
    completedAt: 0,
    winnerId: '',
    moves: 0,
    reward: MATCH_NO_REWARD,
  };
}

/* ---------- the three gates ---------- */

/**
 * The settlement gate. `null` means every check passed and the row may be completed; anything
 * else is the exact reason it may not.
 *
 * The order is deliberate. Participation is checked before status so a stranger probing a match
 * id learns nothing about whether it is live. Status is checked before the clock so a replay of
 * a settled board reads as `not_active` (a spent receipt) rather than `too_fast` (a suspicious
 * one) — the honest answer for the common case.
 */
export function matchFinishGate(
  record: MatchRecord | null,
  actorId: string,
  winnerId: string,
  now: number,
): MatchRefusal | null {
  if (!record) return 'unknown_match';
  if (actorId !== record.player1Id && actorId !== record.player2Id) return 'not_participant';
  if (record.status !== 'active') return 'not_active';
  const elapsed = now - record.startedAt;
  if (elapsed < MATCH_MIN_MS) return 'too_fast';
  if (elapsed > MATCH_MAX_AGE_MS) return 'expired';
  if (winnerId !== record.player1Id && winnerId !== record.player2Id) return 'bad_winner';
  if (record.player2Id && record.player2Id === record.player1Id) return 'self_opponent';
  return null;
}

/**
 * Complete one row. THE CALLER MUST HAVE PASSED `matchFinishGate` AND MUST HOLD THE ONLY
 * REFERENCE TO AN `active` ROW — this is the atomic half of the flip, not the check.
 *
 * The winner's payout is computed here, from the mode and the row, so a settlement that reached
 * this line is already known to be worth exactly what `MATCH_REWARD` says.
 */
export function completeMatch(record: MatchRecord, winnerId: string, now: number): MatchRecord {
  record.status = 'completed';
  record.completedAt = now;
  record.winnerId = winnerId;
  record.reward = rewardFor(record.mode, winnerId === record.player1Id);
  return record;
}

/** Close an unpaid row the sweeper found stale. It keeps its receipt, it just never pays. */
export function expireMatch(record: MatchRecord, now: number): MatchRecord {
  if (record.status !== 'active') return record;
  record.status = 'expired';
  record.completedAt = now;
  record.reward = MATCH_NO_REWARD;
  return record;
}

/* ---------- the pairing quota ---------- */

/** The order-independent key for a pairing: one duel, one row, whichever seat opened it. */
export function friendlyPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** The UTC day a timestamp falls in, so the quota rolls at midnight and nowhere else. */
export function utcDay(now: number): number {
  return Math.floor(now / 86_400_000);
}

/** The two kinds of pairing allowance: boards for a friendly duel, wins for a ranked one. */
export type PairKind = 'friendly' | 'pvp';

/** The allowance each kind grants one pairing per UTC day. */
export const PAIR_DAILY_MAX: Record<PairKind, number> = {
  friendly: FRIENDLY_PAIR_DAILY_MAX,
  pvp: PVP_PAIR_DAILY_MAX,
};

/** The ledger key for one pairing, of one kind, on one day. */
export function friendlyQuotaKey(pairKey: string, day: number, kind: PairKind = 'friendly'): string {
  return `${kind}:${pairKey}|${day}`;
}

/** Has this pairing already been paid for its allowed boards/wins today? */
export function friendlyQuotaSpent(
  friendly: Record<string, number>,
  pairKey: string,
  day: number,
  kind: PairKind = 'friendly',
): boolean {
  return (friendly[friendlyQuotaKey(pairKey, day, kind)] ?? 0) >= PAIR_DAILY_MAX[kind];
}

/** Charge one board (or one win) to the pairing's daily allowance. */
export function chargeFriendlyQuota(
  friendly: Record<string, number>,
  pairKey: string,
  day: number,
  kind: PairKind = 'friendly',
): void {
  const key = friendlyQuotaKey(pairKey, day, kind);
  friendly[key] = Math.min(1000, (friendly[key] ?? 0) + 1);
}

/** Drop yesterday's quota rows: the counter is a day's allowance, not a lifetime total. */
export function trimFriendlyQuota(friendly: Record<string, number>, day: number): void {
  for (const key of Object.keys(friendly)) {
    if (!key.endsWith(`|${day}`)) delete friendly[key];
  }
}

/* ---------- the ledger sweep ---------- */

/**
 * Keep the ledger bounded and honest: drop rows past `MATCH_KEEP_MS`, then expire anything still
 * open past `MATCH_MAX_AGE_MS` (an abandoned board never becomes payable later), then — only if
 * still over the cap — forget the oldest settled rows first.
 */
export function trimMatchLedger(state: MatchLedgerState, now: number): void {
  state.matches = state.matches.filter((row) => now - (row.completedAt || row.startedAt) <= MATCH_KEEP_MS);
  for (const row of state.matches) {
    if (row.status === 'active' && now - row.startedAt > MATCH_MAX_AGE_MS) expireMatch(row, now);
  }
  const over = state.matches.length - MATCHES_MAX;
  if (over <= 0) return;
  const settled = state.matches
    .filter((row) => row.status !== 'active')
    .sort((a, b) => (a.completedAt || a.startedAt) - (b.completedAt || b.startedAt));
  const drop = new Set(settled.slice(0, over).map((row) => row.matchId));
  if (drop.size === 0) return;
  state.matches = state.matches.filter((row) => !drop.has(row.matchId));
}

/** How many rows this seat still holds open. Bounded by `MATCH_OPEN_MAX`. */
export function openMatchesOf(matches: Iterable<MatchRecord>, seat: string): number {
  let open = 0;
  for (const row of matches) {
    if (row.status !== 'active') continue;
    if (row.player1Id === seat || row.player2Id === seat) open += 1;
  }
  return open;
}

/* ---------- the per-user rate window ---------- */

/** One endpoint's allowance: `limit` calls inside a rolling `windowMs`. */
export interface RateRule {
  limit: number;
  windowMs: number;
}

/**
 * The two doors a script hammers. Both are per-seat, not per-IP: a farm behind one Telegram
 * account is the thing worth stopping, and a shared NAT is not a crime.
 */
export const MATCH_RATE: Record<'start' | 'end', RateRule> = {
  /* A human opens a board every couple of minutes at most; twelve a minute is already generous. */
  start: { limit: 12, windowMs: 60_000 },
  /* The finish door is retried on a lost answer, so it gets a little more room. */
  end: { limit: 24, windowMs: 60_000 },
};

/** What a refused call is told: whether it may retry, and when. */
export interface RateVerdict {
  ok: boolean;
  retryAfterMs: number;
}

/**
 * A sliding window of timestamps per key. Bounded by construction — each key keeps at most
 * `limit` stamps — and swept on write, so a burst of unique keys cannot leak.
 */
export class RateWindow {
  private hits = new Map<string, number[]>();

  /**
   * Spend one unit of `key`'s allowance. Refused calls are NOT recorded: a hammering client is
   * throttled by its own refusal, not by growing the window it is already outside of.
   */
  take(key: string, rule: RateRule, now: number): RateVerdict {
    const since = now - rule.windowMs;
    const stamps = (this.hits.get(key) ?? []).filter((at) => at > since);
    if (stamps.length >= rule.limit) {
      this.hits.set(key, stamps);
      /* The oldest stamp inside the window is the one whose expiry frees a slot. */
      return { ok: false, retryAfterMs: Math.max(0, stamps[0] + rule.windowMs - now) };
    }
    stamps.push(now);
    this.hits.set(key, stamps);
    if (this.hits.size > 4000) this.prune(now);
    return { ok: true, retryAfterMs: 0 };
  }

  /** Forget every key whose newest stamp has aged out of the widest window this room uses. */
  prune(now: number): void {
    const widest = Math.max(MATCH_RATE.start.windowMs, MATCH_RATE.end.windowMs);
    for (const [key, stamps] of this.hits) {
      const last = stamps[stamps.length - 1] ?? 0;
      if (now - last > widest) this.hits.delete(key);
    }
  }

  /** Test seam: forget everything. */
  clear(): void {
    this.hits.clear();
  }
}

/* ---------- who is not on the board ---------- */

/**
 * Is this seat an operator? Admins and support read every number in the game and can grant
 * themselves anything, so their rows are excluded from every public ladder — a rank they hold is
 * not a rank anybody can compete for.
 *
 * `ADMIN_IDS` is the deployment's root allowlist and is checked first (a cold role registry must
 * never let a root back onto the board); the room's appointed roles are the second door, passed
 * in by the caller because the registry lives there.
 */
export function isOperatorSeat(
  seat: string,
  env: Env,
  appointed: ReadonlySet<string>,
): boolean {
  const numeric = seat.startsWith('tg-') ? seat.slice(3) : '';
  if (!numeric) return appointed.has(seat);
  const roots = (env.ADMIN_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (roots.includes(numeric)) return true;
  return appointed.has(numeric) || appointed.has(seat);
}
