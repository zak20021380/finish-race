/**
 * minds.ts — the live Mind Ladder feed.
 *
 * Home and the Ranks board read this one function, so the mind on top of the card is the mind
 * on top of the full ladder. The Worker owns the registry; this module only validates the wire,
 * remembers each id's previous rank (so a delta is real movement between reads, never a seeded
 * number), and folds the local player's own live reading into the five slots when its rank lands
 * inside them.
 */
import { workerUrl } from './adminApi';
import { profile, readJson, writeJson } from './storage';
import { tgInitData, tgUser } from './telegram';

export type MindTrend = 'up' | 'down' | 'same';

export interface MindRowData {
  rank: number;
  id: string;
  name: string;
  countryCode: string;
  tiq: number;
  wins: number;
  trend: MindTrend;
  /** Positive = climbed, negative = slipped, 0 without a previous reading. */
  delta: number;
  isYou: boolean;
}

export interface MindStanding {
  rank: number;
  tiq: number;
  total: number;
  pct: number;
}

export interface MindFeed {
  rows: MindRowData[];
  total: number;
  standing: MindStanding | null;
  /** True only when the Worker answered; false means the caller keeps its last reading. */
  live: boolean;
}

const LIMIT = 5;
const MAX_LIMIT = 100;
const RANK_KEY = 'detour.minds.ranks.v1';
const WIRE_TIMEOUT = 3000;

interface WireRow {
  id?: unknown;
  name?: unknown;
  country?: unknown;
  tiq?: unknown;
  wins?: unknown;
  isYou?: unknown;
}

interface WireYou {
  rank?: unknown;
  tiq?: unknown;
  total?: unknown;
}

interface WireFeed {
  ok?: unknown;
  total?: unknown;
  players?: unknown;
  you?: unknown;
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max).trim() : '');
const whole = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
const iso2 = (v: string): string => (/^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : '');

const offline = (): MindFeed => ({ rows: [], total: 0, standing: null, live: false });

interface RankMemory {
  at?: unknown;
  ranks?: Record<string, number>;
}

interface RankSnapshot {
  at: number;
  ranks: Record<string, number>;
}

/** What counts as "recent movement": poll twice a minute without losing the delta. */
const REBASE_MS = 10 * 60_000;

function readRanks(): RankSnapshot {
  const raw = readJson<RankMemory>(RANK_KEY);
  const ranks: Record<string, number> = {};
  const rows = raw?.ranks;
  if (rows && typeof rows === 'object') {
    for (const [id, rank] of Object.entries(rows)) {
      const n = whole(rank);
      if (id && n > 0) ranks[id] = n;
    }
  }
  return { at: whole(raw?.at), ranks };
}

function writeRanks(ranks: Record<string, number>): void {
  const entries = Object.entries(ranks);
  const kept = entries.length > 120 ? entries.slice(entries.length - 120) : entries;
  writeJson(RANK_KEY, { at: Date.now(), ranks: Object.fromEntries(kept) });
}

function myName(): string {
  const u = tgUser();
  const full = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
  const picked = profile.displayName?.trim() || full || u?.username?.trim() || 'You';
  return picked.slice(0, 40);
}

function myCountry(): string {
  return iso2(profile.country ?? '');
}

function readStanding(raw: unknown, fallbackTiq: number): MindStanding | null {
  if (!raw || typeof raw !== 'object') return null;
  const you = raw as WireYou;
  const rank = whole(you.rank);
  const total = whole(you.total);
  const tiq = whole(you.tiq) || whole(fallbackTiq);
  if (rank <= 0 || total <= 0 || tiq <= 0) return null;
  const clamped = Math.min(rank, total);
  return {
    rank: clamped,
    tiq,
    total,
    pct: Math.max(1, Math.min(100, Math.round((clamped / total) * 100))),
  };
}

function localRow(standing: MindStanding): MindRowData {
  return {
    rank: 0,
    id: 'you',
    name: myName(),
    countryCode: myCountry(),
    tiq: standing.tiq,
    wins: Math.max(0, Math.floor(profile.stats.wins)),
    trend: 'same',
    delta: 0,
    isYou: true,
  };
}

/** Validate the wire, put the caller in its own top slots, then stamp real rank movement. */
function adopt(data: WireFeed, tiq: number, limit: number): MindFeed {
  const rawRows = Array.isArray(data.players) ? (data.players as WireRow[]) : [];
  const rows: MindRowData[] = [];
  for (const raw of rawRows) {
    if (!raw || typeof raw !== 'object') continue;
    const id = text(raw.id, 64);
    const name = text(raw.name, 40);
    const score = whole(raw.tiq);
    if (!id || !name || score <= 0 || rows.some((r) => r.id === id)) continue;
    rows.push({
      rank: 0,
      id,
      name,
      countryCode: iso2(text(raw.country, 3)),
      tiq: score,
      wins: whole(raw.wins),
      trend: 'same',
      delta: 0,
      isYou: raw.isYou === true,
    });
  }
  rows.sort((a, b) => b.tiq - a.tiq || b.wins - a.wins || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  rows.length = Math.min(rows.length, limit);

  const total = Math.max(rows.length, whole(data.total));
  const standing = readStanding(data.you, tiq);

  /* A verified seat is already in the Worker's field. An unranked seat (or a browser without
     initData) is ranked relative to the field, so it takes its slot here — exactly where the
     strip says it stands. */
  if (standing && standing.rank <= limit && standing.rank <= rows.length + 1 && !rows.some((r) => r.isYou)) {
    rows.splice(Math.min(standing.rank - 1, rows.length), 0, localRow(standing));
    if (rows.length > limit) rows.length = limit;
  }

  const snapshot = readRanks();
  const next: Record<string, number> = { ...snapshot.ranks };
  rows.forEach((row, i) => {
    row.rank = i + 1;
    const before = snapshot.ranks[row.id];
    if (before && before !== row.rank) {
      row.delta = before - row.rank;
      row.trend = row.delta > 0 ? 'up' : 'down';
    }
    next[row.id] = row.rank;
  });
  /* Keep the comparison baseline for a while: the card fetches on boot, route entry and poll,
     and a delta that vanished on the second read would never be seen. */
  if (!snapshot.at || Date.now() - snapshot.at >= REBASE_MS) writeRanks(next);

  return { rows, total: Math.max(total, rows.length), standing, live: true };
}

/**
 * The top `limit` minds by TIQ, plus the caller's live standing. Never throws: an unreachable
 * Worker resolves to `live: false` with no rows, and the card keeps whatever it painted last.
 */
export async function fetchMindLadder(tiq: number, limit = LIMIT): Promise<MindFeed> {
  const base = workerUrl('/api/client/minds');
  if (!base) return offline();
  const wanted = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || LIMIT));
  const mine = Math.max(0, Math.floor(tiq) || 0);
  const params = new URLSearchParams({ limit: String(wanted) });
  if (mine > 0) params.set('tiq', String(mine));

  const headers: Record<string, string> = { accept: 'application/json' };
  const init = tgInitData();
  if (init) headers['x-telegram-init-data'] = init;

  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), WIRE_TIMEOUT);
  try {
    const res = await fetch(`${base}?${params.toString()}`, { headers, signal: ac.signal, cache: 'no-store' });
    if (!res.ok) return offline();
    const data = (await res.json()) as WireFeed | null;
    if (!data || data.ok !== true) return offline();
    return adopt(data, mine, wanted);
  } catch {
    return offline();
  } finally {
    window.clearTimeout(timer);
  }
}
