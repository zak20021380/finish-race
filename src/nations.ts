/**
 * nations.ts — the live Nations IQ feed.
 *
 * Home and the Ranks board read this one function, so the card and the cup table can never
 * disagree about a nation's standing. The Worker owns the ledger: a flag's score is the
 * top-ten representative TIQ of its qualified warriors — proven racers active inside the
 * current season window — so fresh accounts and dormant ghosts cannot drag a nation down.
 * The season's banked win points ride along as a separate award. A read carries the caller's
 * profile flag, so a country picked before the first race is folded into that registry, and
 * their own TIQ, so their seat is quoted back. This module validates the wire and remembers
 * each nation's previous rank, so a rise or fall is real movement between reads rather than a
 * seeded decoration.
 */
import { workerUrl } from './adminApi';
import { profile, readJson, writeJson } from './storage';
import { tgInitData } from './telegram';

export type NationTrend = 'up' | 'down' | 'same';

export interface NationRow {
  rank: number;
  /** ISO 3166-1 alpha-2; `name` is the registry spelling when the wire carries it. */
  code: string;
  /** The registry's display name for the flag, when the wire carried one. */
  name: string;
  /** Season TIQ the Worker banked for this nation's wins; an honest zero is still a row. */
  points: number;
  /** Every enrolled seat under this flag, qualified or not. */
  players: number;
  /** Qualified warriors in the average sample: proven, recently active human racers. */
  warriors: number;
  /** The TIQ every qualified warrior carries, added up. */
  totalTiq: number;
  /** The Worker's top-ten representative average; the number the board is ranked by. */
  avg: number;
  trend: NationTrend;
  /** Positive = climbed, negative = slipped, 0 without a previous reading. */
  delta: number;
}

export interface NationStanding {
  code: string;
  rank: number;
  /** What the caller personally earned for this flag this season. */
  points: number;
  /** The caller's own TIQ, which is what the contribution badge quotes back. */
  tiq: number;
  /** The nation's average TIQ, so a seat can see its own score against the flag's. */
  avg: number;
  total: number;
  pct: number;
}

export interface NationFeed {
  rows: NationRow[];
  total: number;
  standing: NationStanding | null;
  seasonNo: number;
  /** True only when the Worker answered; false means the caller keeps its last reading. */
  live: boolean;
}

export interface NationPlayer {
  rank: number;
  id: string;
  name: string;
  tiq: number;
  wins: number;
  isYou: boolean;
}

export interface NationRoster {
  country: string;
  total: number;
  rows: NationPlayer[];
  you: NationPlayer | null;
  live: boolean;
}

const RANK_KEY = 'detour.nations.ranks.v1';
/**
 * The Worker's public reads are cold sometimes: an isolate start plus the Durable Object's own
 * registry hydration is a multi-second round trip, so a 3s leash was aborting reads the backend
 * was still serving and painting a live cup as unavailable.
 */
const WIRE_TIMEOUT = 12_000;
const WIRE_ATTEMPTS = 2;
/** How long a rank snapshot is the baseline, so movement survives more than one poll. */
const REBASE_MS = 10 * 60_000;
const MAX_ROWS = 200;
const ROSTER_LIMIT = 20;

interface WireNation {
  code?: unknown;
  name?: unknown;
  points?: unknown;
  players?: unknown;
  warriorCount?: unknown;
  rank?: unknown;
  totalTiq?: unknown;
  averageTiq?: unknown;
}

interface WireYou {
  code?: unknown;
  points?: unknown;
  total?: unknown;
  tiq?: unknown;
  averageTiq?: unknown;
}

interface WireFeed {
  ok?: unknown;
  seasonNo?: unknown;
  nations?: unknown;
  you?: unknown;
}

interface WirePlayer {
  id?: unknown;
  name?: unknown;
  tiq?: unknown;
  wins?: unknown;
  isYou?: unknown;
  rank?: unknown;
}

interface WireRoster {
  ok?: unknown;
  country?: unknown;
  total?: unknown;
  rows?: unknown;
  you?: unknown;
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max).trim() : '');
const whole = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
const iso2 = (v: string): string => (/^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : '');

const offline = (): NationFeed => ({ rows: [], total: 0, standing: null, seasonNo: 0, live: false });
const offlineRoster = (country: string): NationRoster => ({ country, total: 0, rows: [], you: null, live: false });

interface RankMemory {
  season?: unknown;
  at?: unknown;
  ranks?: Record<string, number>;
}

interface RankSnapshot {
  season: number;
  at: number;
  ranks: Record<string, number>;
}

function readRanks(): RankSnapshot {
  const raw = readJson<RankMemory>(RANK_KEY);
  const ranks: Record<string, number> = {};
  const rows = raw?.ranks;
  if (rows && typeof rows === 'object') {
    for (const [code, rank] of Object.entries(rows)) {
      const n = whole(rank);
      if (/^[A-Z]{2}$/.test(code) && n > 0) ranks[code] = n;
    }
  }
  return { season: whole(raw?.season), at: whole(raw?.at), ranks };
}

function writeRanks(season: number, ranks: Record<string, number>): void {
  writeJson(RANK_KEY, { season, at: Date.now(), ranks });
}

/** Validate the wire, rank it, then stamp real movement against the last reading. */
function adopt(data: WireFeed): NationFeed | null {
  if (!data || data.ok !== true) return null;
  const seasonNo = whole(data.seasonNo);
  const rawRows = Array.isArray(data.nations) ? (data.nations as WireNation[]) : [];

  const seen = new Set<string>();
  const rows: NationRow[] = [];
  for (const raw of rawRows) {
    if (!raw || typeof raw !== 'object') continue;
    const code = iso2(text(raw.code, 2));
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const players = whole(raw.players);
    const totalTiq = whole(raw.totalTiq);
    /* An older Worker carries no warrior count; the full roster is the only honest stand-in. */
    const warriors = raw.warriorCount !== undefined ? whole(raw.warriorCount) : players;
    /* The Worker owns the average. A reply from before it carried one is still never painted at
       zero while its players hold TIQ, so the legacy per-head formula is applied to the wire. */
    const avg = raw.averageTiq !== undefined
      ? whole(raw.averageTiq)
      : Math.round(totalTiq / Math.max(1, players));
    rows.push({
      rank: whole(raw.rank),
      code,
      name: text(raw.name, 40),
      points: whole(raw.points),
      players,
      warriors,
      totalTiq,
      avg,
      trend: 'same',
      delta: 0,
    });
    if (rows.length >= MAX_ROWS) break;
  }
  if (!rows.length) return { rows: [], total: 0, standing: null, seasonNo, live: true };

  /* The Worker ranks ties by head-count, which the wire alone cannot reconstruct; its ranks are
     authoritative when they form one continuous 1..N sequence, otherwise rank the field here. */
  const ranked = rows.every((row) => row.rank >= 1)
    && new Set(rows.map((row) => row.rank)).size === rows.length;
  if (ranked) rows.sort((a, b) => a.rank - b.rank);
  else rows.sort((a, b) => (
    b.avg - a.avg
    || b.totalTiq - a.totalTiq
    || b.warriors - a.warriors
    || b.players - a.players
    || a.code.localeCompare(b.code)
  ));

  const previous = readRanks();
  const baseline = previous.season === seasonNo && previous.at > 0 ? previous.ranks : {};
  const next: Record<string, number> = {};
  rows.forEach((row, i) => {
    row.rank = i + 1;
    const before = baseline[row.code];
    if (before && before !== row.rank) {
      row.delta = before - row.rank;
      row.trend = row.delta > 0 ? 'up' : 'down';
    }
    next[row.code] = row.rank;
  });
  if (previous.season !== seasonNo || !previous.at || Date.now() - previous.at >= REBASE_MS) {
    writeRanks(seasonNo, next);
  }

  const mine = data.you && typeof data.you === 'object' ? (data.you as WireYou) : null;
  const wireCode = iso2(text(mine?.code, 2));
  const myCode = wireCode || iso2(profile.country ?? '');
  const hit = myCode ? rows.find((row) => row.code === myCode) : undefined;
  const standing = hit
    ? {
      code: hit.code,
      rank: hit.rank,
      points: wireCode === hit.code ? whole(mine?.points) : 0,
      /* The seat's own TIQ as the room holds it. A guest read has no verified seat, so this stays
         0 here and the caller substitutes the save's TIQ rather than showing an empty badge. */
      tiq: wireCode === hit.code ? whole(mine?.tiq) : 0,
      avg: hit.avg,
      total: rows.length,
      pct: Math.max(1, Math.min(100, Math.round((hit.rank / rows.length) * 100))),
    }
    : null;

  return { rows, total: rows.length, standing, seasonNo, live: true };
}

/** Read the board once, carrying the caller's profile flag so a chosen nation is enrolled. */
async function readBoard(url: string): Promise<NationFeed | null> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const init = tgInitData();
  if (init) headers['x-telegram-init-data'] = init;

  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), WIRE_TIMEOUT);
  try {
    const res = await fetch(url, { headers, signal: ac.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as WireFeed | null;
    return (data && adopt(data)) || null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * The nations ladder, ranked by the top-ten representative average TIQ each flag's qualified
 * warriors carry, plus the caller's standing. The read carries the caller's flag so a chosen
 * nation is enrolled, and their own TIQ so their seat is quoted back — never so a query string
 * can move a national score. Never throws.
 */
export async function fetchNationBoard(tiq: number): Promise<NationFeed> {
  const country = iso2(profile.country ?? '');
  const mine = Math.max(0, Math.floor(tiq) || 0);
  const params = new URLSearchParams();
  if (country) params.set('country', country);
  if (mine > 0) params.set('tiq', String(mine));
  const query = params.toString();
  const path = query ? `/api/nations/leaderboard?${query}` : '/api/nations/leaderboard';
  const url = workerUrl(path);
  if (!url) return offline();

  /* A cold Worker is one slow read, not an outage: retry once before keeping the last board. */
  for (let attempt = 0; attempt < WIRE_ATTEMPTS; attempt++) {
    const feed = await readBoard(url);
    if (feed) return feed;
  }
  return offline();
}

function readPlayer(raw: unknown): Omit<NationPlayer, 'rank'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as WirePlayer;
  const id = text(p.id, 64);
  const name = text(p.name, 40);
  if (!id || !name) return null;
  return { id, name, tiq: whole(p.tiq), wins: whole(p.wins), isYou: p.isYou === true };
}

/** The real top players behind one flag. Never throws; an unreachable Worker is `live: false`. */
export async function fetchNationRoster(country: string): Promise<NationRoster> {
  const cc = iso2(country);
  if (!cc) return offlineRoster(cc);
  const base = workerUrl('/api/nations/roster');
  if (!base) return offlineRoster(cc);

  const params = new URLSearchParams({ country: cc, limit: String(ROSTER_LIMIT) });
  const headers: Record<string, string> = { accept: 'application/json' };
  const init = tgInitData();
  if (init) headers['x-telegram-init-data'] = init;

  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), WIRE_TIMEOUT);
  try {
    const res = await fetch(`${base}?${params.toString()}`, { headers, signal: ac.signal, cache: 'no-store' });
    if (!res.ok) return offlineRoster(cc);
    const data = (await res.json()) as WireRoster | null;
    if (!data || data.ok !== true || iso2(text(data.country, 2)) !== cc) return offlineRoster(cc);

    const rows: NationPlayer[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(data.rows) ? data.rows : []) {
      const p = readPlayer(raw);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      rows.push({ rank: 0, ...p });
    }
    rows.sort((a, b) => b.tiq - a.tiq || b.wins - a.wins || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    rows.forEach((row, i) => { row.rank = i + 1; });

    const own = readPlayer(data.you);
    /* The wire carries the player's true rank, which may sit below the top slice. */
    const yourRank = data.you && typeof data.you === 'object'
      ? whole((data.you as WirePlayer).rank)
      : 0;
    const you = own ? { ...own, rank: yourRank } : null;

    return { country: cc, total: whole(data.total), rows, you, live: true };
  } catch {
    return offlineRoster(cc);
  } finally {
    window.clearTimeout(timer);
  }
}
