/**
 * badges.ts — the server half of the Genius Triad's numbered editions.
 *
 * One singleton Durable Object owns the whole mint: the three hard caps, the sequential
 * serial counters, and every player's claim. Its event loop is single-threaded and every
 * mutation below passes through one promise queue, so a read-check-increment-write can never
 * interleave with another mint. The counter and the claim are committed in one atomic
 * `storage.put(entries)`; a fresh instance rehydrates its counters before answering.
 *
 * Eligibility is a server decision. The app's solo races are settled locally, so the client
 * reports a progress snapshot to `/api/badges/progress` (authenticated by the Worker's
 * Telegram check); the object keeps the high-water mark of those figures and mints only when
 * the stored progress meets the badge's rule. A replay-signed race ledger does not exist in
 * this build, so the snapshot is monotonic telemetry rather than a cryptographic proof — but
 * the caps, serials and claims themselves are entirely server-authoritative.
 */
import { json } from './http';
import type { Env } from './env';

/* ---------- the catalogue's server half ---------- */

/* Deliberately mirrored in `GENIUS_TRIAD[].cap` (src/badges.ts): the client bundle must never
   import the Worker, so the two constants are kept in lockstep by hand and by the badge suite. */
export const BADGE_CAPS = {
  churchill_bastion: 100,
  einstein_singularity: 50,
  heisenberg_formula: 25,
} as const;

export type BadgeId = keyof typeof BADGE_CAPS;

const BADGE_IDS = Object.keys(BADGE_CAPS) as BadgeId[];

export const isBadgeId = (value: unknown): value is BadgeId =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(BADGE_CAPS, value);

/* ---------- progress + eligibility ---------- */

export interface BadgeProgress {
  tiq: number;
  games: number;
  wins: number;
  streak: number;
  best: number;
}

const COUNT_MAX = 10_000_000;

const count = (value: unknown, hi = COUNT_MAX): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(hi, Math.max(0, Math.floor(value)))
    : 0;

/** A stored or submitted snapshot, folded field by field. Never throws. */
export function readProgress(raw: unknown): BadgeProgress {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<BadgeProgress>;
  const games = count(r.games);
  const wins = Math.min(games, count(r.wins));
  const streak = Math.min(games, count(r.streak));
  return {
    tiq: count(r.tiq),
    games,
    wins,
    streak,
    best: Math.max(streak, Math.min(games, count(r.best))),
  };
}

/**
 * The same three rules the shelf prints, evaluated here rather than by the caller:
 * a 3-win best streak, 1,500 TIQ, or a 60% win rate over at least five races.
 */
export function meetsCriteria(badgeId: BadgeId, p: BadgeProgress): boolean {
  switch (badgeId) {
    case 'churchill_bastion':
      return p.best >= 3;
    case 'einstein_singularity':
      return p.tiq >= 1500;
    case 'heisenberg_formula':
      return p.games >= 5 && p.wins / p.games >= 0.6;
  }
}

/**
 * Progress only moves forward: a later report may raise games, wins, TIQ and the best streak,
 * while the current streak is the latest observation. That keeps a losing run from revoking a
 * badge that was already earned, and lets a fresh client hydrate an old ledger safely.
 */
export function mergeProgress(previous: BadgeProgress, next: BadgeProgress): BadgeProgress {
  const games = Math.max(previous.games, next.games);
  const wins = Math.min(games, Math.max(previous.wins, next.wins));
  const streak = Math.min(games, next.streak);
  return {
    tiq: Math.max(previous.tiq, next.tiq),
    games,
    wins,
    streak,
    best: Math.max(previous.best, next.best, streak),
  };
}

/* ---------- persisted shapes ---------- */

interface StoredClaim {
  serial: number;
  cap: number;
  mintedAt: string;
}

const readClaim = (raw: unknown, cap: number): StoredClaim | null => {
  const r = (raw && typeof raw === 'object' ? raw : null) as Partial<StoredClaim> | null;
  if (!r) return null;
  if (typeof r.serial !== 'number' || !Number.isInteger(r.serial) || r.serial < 1) return null;
  if (r.serial > cap) return null;
  return {
    serial: r.serial,
    cap,
    mintedAt: typeof r.mintedAt === 'string' ? r.mintedAt.slice(0, 40) : '',
  };
};

interface StoredHolder {
  serial: number;
  /** Verified Telegram name; '' when the claim predates the holder index. */
  name: string;
}

interface SupplyRow {
  cap: number;
  minted: number;
  remaining: number;
  /** Serial + holder name, ascending. A public hall of fame, never a player id. */
  holders: StoredHolder[];
}

type Storage = NonNullable<DurableObjectState['storage']>;

const counterKey = (id: BadgeId) => `badge:counter:${id}`;
const claimKey = (id: BadgeId, player: string) => `badge:claim:${id}:${player}`;
const claimPrefix = (id: BadgeId) => `badge:claim:${id}:`;
const holdersKey = (id: BadgeId) => `badge:holders:${id}`;
const progressKey = (player: string) => `badge:progress:${player}`;

/** A display name safe to publish: one line, no markup, bounded to 20 characters. */
const holderName = (raw: unknown): string =>
  typeof raw === 'string'
    ? raw.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20)
    : '';

const readHolders = (raw: unknown, cap: number): StoredHolder[] => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const rows: StoredHolder[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const row = value as { serial?: unknown; name?: unknown };
    const serial = row.serial;
    if (typeof serial !== 'number' || !Number.isInteger(serial) || serial < 1 || serial > cap) continue;
    if (seen.has(serial)) continue;
    seen.add(serial);
    rows.push({ serial, name: holderName(row.name) || 'Unlisted' });
  }
  return rows.sort((a, b) => a.serial - b.serial);
};

/** What the Worker's edge puts on the request after it has verified initData. */
const playerOf = (request: Request): string =>
  (request.headers.get('x-detour-player') ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

/** The edge's URI-encoded holder name; malformed escapes and markup never reach storage. */
const playerNameOf = (request: Request): string => {
  const raw = request.headers.get('x-detour-player-name') ?? '';
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep the raw header */ }
  return holderName(decoded);
};

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/* ---------- the object ---------- */

export class BadgeMintDO {
  private readonly storage: Storage | null;
  /** Minted serials per badge, loaded before the first request is answered. */
  private readonly counters = new Map<BadgeId, number>();
  /** Claims and progress read during this instance's life; storage remains the authority. */
  private readonly claims = new Map<string, StoredClaim>();
  private readonly progress = new Map<string, BadgeProgress>();
  /** The public holder index per badge, built lazily for ledgers written before it existed. */
  private readonly holders = new Map<BadgeId, StoredHolder[]>();
  /** Initialization gate: no request may read a zero counter before storage has spoken. */
  private readonly ready: Promise<void>;
  /** One tail for every mutation: the whole object is a single critical section. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly state: DurableObjectState, _env: Env) {
    this.storage = state.storage ?? null;
    this.ready = this.storage && typeof state.blockConcurrencyWhile === 'function'
      ? state.blockConcurrencyWhile(() => this.load()).then(() => undefined)
      : Promise.resolve();
  }

  private async load(): Promise<void> {
    const storage = this.storage;
    if (!storage) return;
    for (const id of BADGE_IDS) {
      const raw = await storage.get<unknown>(counterKey(id));
      const n = typeof raw === 'number' && Number.isFinite(raw)
        ? Math.min(BADGE_CAPS[id], Math.max(0, Math.floor(raw)))
        : 0;
      this.counters.set(id, n);

      const index = await storage.get<unknown>(holdersKey(id));
      if (Array.isArray(index)) {
        this.holders.set(id, readHolders(index, BADGE_CAPS[id]));
      } else if (n > 0) {
        /* Ledgers written before the holder index still deserve a hall of fame; name the
           serials we can, and let the next mint persist the rebuilt index. */
        this.holders.set(id, await this.holdersFromClaims(id));
      }
    }
  }

  private async holdersFromClaims(id: BadgeId): Promise<StoredHolder[]> {
    const storage = this.storage;
    if (!storage || typeof storage.list !== 'function') return [];
    const cap = BADGE_CAPS[id];
    const listed = await storage.list<unknown>({ prefix: claimPrefix(id), limit: cap + 25 });
    const rows: StoredHolder[] = [];
    for (const value of listed.values()) {
      const claim = readClaim(value, cap);
      if (!claim) continue;
      rows.push({ serial: claim.serial, name: holderName((value as { name?: unknown } | null)?.name) || 'Unlisted' });
    }
    return rows.sort((a, b) => a.serial - b.serial);
  }

  /** Run a mutation after every earlier one, whether that one settled or failed. */
  private sequence<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private supply(): Record<BadgeId, SupplyRow> {
    const out = {} as Record<BadgeId, SupplyRow>;
    for (const id of BADGE_IDS) {
      const cap = BADGE_CAPS[id];
      const minted = this.counters.get(id) ?? 0;
      out[id] = {
        cap,
        minted,
        remaining: Math.max(0, cap - minted),
        holders: (this.holders.get(id) ?? []).map((h) => ({ serial: h.serial, name: h.name })),
      };
    }
    return out;
  }

  private async progressOf(player: string): Promise<BadgeProgress | null> {
    const cached = this.progress.get(player);
    if (cached) return cached;
    const raw = this.storage ? await this.storage.get<unknown>(progressKey(player)) : undefined;
    if (!raw) return null;
    const progress = readProgress(raw);
    this.progress.set(player, progress);
    return progress;
  }

  private async claimOf(player: string, badgeId: BadgeId): Promise<StoredClaim | null> {
    const key = claimKey(badgeId, player);
    const cached = this.claims.get(key);
    if (cached) return cached;
    const raw = this.storage ? await this.storage.get<unknown>(key) : undefined;
    const claim = readClaim(raw, BADGE_CAPS[badgeId]);
    if (claim) this.claims.set(key, claim);
    return claim;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.ready;
    } catch {
      return json({ error: 'storage_unavailable' }, 500);
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/badges/supply') {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
        return json({ badges: this.supply() });
      }

      const player = playerOf(request);
      if (url.pathname === '/api/badges/mint' || url.pathname === '/api/badges/progress') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        if (!player) return json({ success: false, error: 'UNAUTHORIZED' }, 401);
      } else {
        return json({ error: 'not_found' }, 404);
      }

      if (url.pathname === '/api/badges/progress') {
        const body = await readBody(request);
        const incoming = readProgress(body);
        return await this.sequence(async () => {
          const previous = await this.progressOf(player);
          const merged = previous ? mergeProgress(previous, incoming) : incoming;
          if (this.storage) await this.storage.put(progressKey(player), merged);
          this.progress.set(player, merged);
          return json({ success: true });
        });
      }

      const body = await readBody(request);
      const badgeId = body.badgeId;
      if (!isBadgeId(badgeId)) return json({ success: false, error: 'UNKNOWN_BADGE' }, 400);
      return await this.sequence(() => this.mint(player, badgeId, playerNameOf(request)));
    } catch {
      return json({ error: 'storage_unavailable' }, 500);
    }
  }

  private async mint(player: string, badgeId: BadgeId, name: string): Promise<Response> {
    const cap = BADGE_CAPS[badgeId];

    /* Idempotency wins over everything: a player who already holds this honor always gets
       the same serial back, even if the cap has filled or their progress has since lapsed. */
    const existing = await this.claimOf(player, badgeId);
    if (existing) {
      return json({
        success: true,
        badgeId,
        serial: existing.serial,
        cap,
        mintedAt: existing.mintedAt,
      });
    }

    const progress = await this.progressOf(player);
    if (!progress || !meetsCriteria(badgeId, progress)) {
      return json({ success: false, error: 'CRITERIA_NOT_MET' }, 403);
    }

    const minted = this.counters.get(badgeId) ?? 0;
    if (minted >= cap) {
      return json({ success: false, error: 'CAP_EXHAUSTED', badgeId, cap, minted }, 409);
    }

    const serial = minted + 1;
    const claim: StoredClaim = { serial, cap, mintedAt: new Date().toISOString() };
    const nextHolders = [...(this.holders.get(badgeId) ?? []), { serial, name: name || 'Unlisted' }]
      .sort((a, b) => a.serial - b.serial);
    if (this.storage) {
      await this.storage.put({
        [counterKey(badgeId)]: serial,
        [claimKey(badgeId, player)]: claim,
        [holdersKey(badgeId)]: nextHolders,
      });
    }
    this.counters.set(badgeId, serial);
    this.claims.set(claimKey(badgeId, player), claim);
    this.holders.set(badgeId, nextHolders);

    return json({
      success: true,
      badgeId,
      serial,
      cap,
      mintedAt: claim.mintedAt,
    });
  }
}
