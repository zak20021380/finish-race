/**
 * arenaState.ts — the live tournament clock, in one place.
 *
 * The Worker owns the authoritative copy (`ArenaState` in worker/matchmaker.ts) and every client
 * folds it through here. With no Worker answering the same shape lives on this device, so the
 * Command Center still has a real switchboard: an admin edit paints immediately, the ladder's
 * countdown follows, and the next successful server read wins.
 */
import { earnTiq, readJson, writeJson } from './storage';
import { tgInitData } from './telegram';
import { workerUrl } from './adminApi';

export type ArenaStatus = 'active' | 'maintenance' | 'finale';
export type ArenaTierId = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'challenger';

export interface ArenaDivisionRule {
  id: ArenaTierId;
  /** The lowest TIQ that wears this tier. */
  min: number;
}

export interface ArenaSnapshotEntry {
  rank: number;
  id: string;
  name: string;
  tiq: number;
  wins: number;
}

export interface ArenaSnapshot {
  seasonNo: number;
  seasonName: string;
  takenAt: number;
  total: number;
  entries: ArenaSnapshotEntry[];
}

export interface SeasonAward {
  seasonNo: number;
  seasonName: string;
  rank: number;
  tiq: number;
  badge: string;
  awardedAt: number;
}

export interface ArenaState {
  status: ArenaStatus;
  /** New queue entries are refused; races already under way resolve normally. */
  matchLocked: boolean;
  seasonNo: number;
  seasonName: string;
  /** Epoch ms the season closes. */
  endsAt: number;
  divisions: ArenaDivisionRule[];
  updatedAt: number;
  lastSnapshot: ArenaSnapshot | null;
  awardsCount: number;
}

interface ArenaWire {
  ok?: boolean;
  arena?: unknown;
  award?: unknown;
}

const ARENA_KEY = 'detour.arena.v1';
const CLAIMS_KEY = 'detour.arena.claims.v1';

/** Season 4 closed 2026-10-16 14:00Z; every 28 days rolls the number without a static string. */
const SEASON_ANCHOR = Date.UTC(2026, 9, 16, 14, 0);
export const SEASON_LENGTH_MS = 28 * 86400_000;

export const ARENA_TIER_IDS: readonly ArenaTierId[] = [
  'bronze', 'silver', 'gold', 'platinum', 'diamond', 'challenger',
];

export const ARENA_TIER_NAMES: Record<ArenaTierId, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  platinum: 'Platinum',
  diamond: 'Diamond',
  challenger: 'Challenger',
};

export const ARENA_STATUS_LABEL: Record<ArenaStatus, string> = {
  active: 'Open',
  maintenance: 'Locked',
  finale: 'Finale',
};

const TIER_DEFAULTS: Record<ArenaTierId, number> = {
  bronze: 0,
  silver: 1_200,
  gold: 1_800,
  platinum: 2_400,
  diamond: 3_000,
  challenger: 4_000,
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

function defaultSeason(now: number): { no: number; endsAt: number } {
  const k = Math.ceil((now - SEASON_ANCHOR) / SEASON_LENGTH_MS);
  return { no: Math.max(1, 4 + k), endsAt: SEASON_ANCHOR + k * SEASON_LENGTH_MS };
}

export function seasonNameFor(no: number): string {
  return `Season ${no}: Mind Clash`;
}

function defaultDivisions(): ArenaDivisionRule[] {
  return ARENA_TIER_IDS.map((id) => ({ id, min: TIER_DEFAULTS[id] }));
}

export function defaultArena(now = Date.now()): ArenaState {
  const s = defaultSeason(now);
  return {
    status: 'active',
    matchLocked: false,
    seasonNo: s.no,
    seasonName: seasonNameFor(s.no),
    endsAt: s.endsAt,
    divisions: defaultDivisions(),
    updatedAt: 0,
    lastSnapshot: null,
    awardsCount: 0,
  };
}

/** Strictly rising thresholds; Bronze is the floor at zero whatever a hand-edited blob says. */
export function normalizeDivisions(raw: unknown, fallback = defaultDivisions()): ArenaDivisionRule[] {
  const rows = Array.isArray(raw) ? raw : [];
  let prev = 0;
  return ARENA_TIER_IDS.map((id, i) => {
    const found = rows.find((r) => r && typeof r === 'object' && (r as { id?: unknown }).id === id);
    const value = found ? (found as { min?: unknown }).min : undefined;
    const base = i === 0 ? 0 : Math.max(prev + 1, isNum(value) ? Math.floor(value) : fallback[i].min);
    prev = base;
    return { id, min: clamp(base, 0, 1_000_000) };
  });
}

function readSnapshot(raw: unknown): ArenaSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ArenaSnapshot>;
  if (!isNum(r.seasonNo) || !isNum(r.takenAt)) return null;
  const entries: ArenaSnapshotEntry[] = [];
  const rows = Array.isArray(r.entries) ? r.entries : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const e = row as Partial<ArenaSnapshotEntry>;
    if (!isNum(e.rank) || typeof e.id !== 'string' || !e.id) continue;
    entries.push({
      rank: Math.max(1, Math.floor(e.rank)),
      id: e.id.slice(0, 64),
      name: str(e.name, 40) || 'Player',
      tiq: isNum(e.tiq) ? Math.max(0, Math.round(e.tiq)) : 0,
      wins: isNum(e.wins) ? Math.max(0, Math.floor(e.wins)) : 0,
    });
    if (entries.length >= 50) break;
  }
  return {
    seasonNo: clamp(Math.floor(r.seasonNo), 1, 999),
    seasonName: str(r.seasonName, 60) || seasonNameFor(Math.floor(r.seasonNo)),
    takenAt: Math.max(0, Math.floor(r.takenAt)),
    total: isNum(r.total) ? Math.max(0, Math.floor(r.total)) : entries.length,
    entries,
  };
}

/** Fold a wire or storage copy field by field; anything a hand-edited blob invented is dropped. */
export function normalizeArena(raw: unknown, now = Date.now()): ArenaState {
  const d = defaultArena(now);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<ArenaState>;
  const status: ArenaStatus = r.status === 'maintenance' || r.status === 'finale' ? r.status : 'active';
  const seasonNo = isNum(r.seasonNo) ? clamp(Math.floor(r.seasonNo), 1, 999) : d.seasonNo;
  return {
    status,
    matchLocked: r.matchLocked === true,
    seasonNo,
    seasonName: str(r.seasonName, 60).trim() || d.seasonName,
    endsAt: isNum(r.endsAt) ? clamp(Math.floor(r.endsAt), 0, now + 10 * 366 * 86400_000) : d.endsAt,
    divisions: normalizeDivisions(r.divisions),
    updatedAt: isNum(r.updatedAt) ? Math.max(0, Math.floor(r.updatedAt)) : 0,
    lastSnapshot: readSnapshot(r.lastSnapshot),
    awardsCount: isNum(r.awardsCount) ? Math.max(0, Math.floor(r.awardsCount)) : 0,
  };
}

function loadLocal(): ArenaState {
  return normalizeArena(readJson<ArenaState>(ARENA_KEY));
}

let state: ArenaState = loadLocal();
const watchers: (() => void)[] = [];

export const arena = (): ArenaState => state;

export function onArena(cb: () => void): () => void {
  watchers.push(cb);
  return () => {
    const i = watchers.indexOf(cb);
    if (i >= 0) watchers.splice(i, 1);
  };
}

function notifyArena(): void {
  for (const cb of [...watchers]) {
    try {
      cb();
    } catch {
      /* one listener threw: the rest still get the reading */
    }
  }
}

/** The admin's own edit: paint at once, persist on this device, let the server catch up. */
export function setArenaLocal(patch: Partial<ArenaState>): ArenaState {
  const stamped = { ...state, ...patch, updatedAt: Date.now() };
  const next = normalizeArena(stamped);
  if (JSON.stringify(next) === JSON.stringify(state)) return state;
  state = next;
  writeJson(ARENA_KEY, state);
  notifyArena();
  return state;
}

/** A server reading. An older answer never walks a newer optimistic edit backwards. */
export function adoptArena(raw: unknown, force = false): ArenaState {
  const next = normalizeArena(raw);
  if (!force && next.updatedAt < state.updatedAt) return state;
  state = next;
  writeJson(ARENA_KEY, state);
  notifyArena();
  return state;
}

/** True when the arena is closed to new queue entries (an in-flight race still resolves). */
export const arenaLocked = (a: ArenaState = state): boolean =>
  a.matchLocked || a.status !== 'active' || a.endsAt <= Date.now();

/* ---------- the countdown, as the player sees it ---------- */

export type PillTone = 'live' | 'ending' | 'locked' | 'closed';

export interface CountdownPill {
  kicker: string;
  value: string;
  tone: PillTone;
  exact: string;
}

const pad2 = (n: number): string => String(Math.max(0, Math.floor(n))).padStart(2, '0');

/** The capsule on the Mind Ladder: days while there is room, hours and minutes under two days. */
export function countdownPill(a: ArenaState, now = Date.now()): CountdownPill {
  const left = a.endsAt - now;
  if (a.status === 'finale' || left <= 0) {
    return {
      kicker: a.status === 'finale' ? 'Finale' : 'Season',
      value: 'Standings locked',
      tone: 'closed',
      exact: 'Season closed',
    };
  }
  const tone: PillTone = a.matchLocked || a.status === 'maintenance'
    ? 'locked'
    : left <= 48 * 3600_000 ? 'ending' : 'live';
  if (left >= 48 * 3600_000) {
    const days = Math.max(1, Math.ceil(left / 86400_000));
    return { kicker: 'Ends in', value: `${days}d left`, tone, exact: `${days} days left` };
  }
  const total = Math.max(0, Math.floor(left / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const value = h > 0 ? `${pad2(h)}h ${pad2(m)}m` : `${pad2(m)}m ${pad2(s)}s`;
  return {
    kicker: 'Closing in',
    value,
    tone,
    exact: h > 0 ? `${h} hours ${m} minutes left` : `${m} minutes ${s} seconds left`,
  };
}

/** The admin's instrument: one monospaced line that actually moves every second. */
export function fullCountdown(a: ArenaState, now = Date.now()): string {
  const left = a.endsAt - now;
  if (left <= 0) return a.status === 'finale' ? 'Finale · standings locked' : 'Season closed';
  const total = Math.floor(left / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return d > 0 ? `${d}d ${pad2(h)}h ${pad2(m)}m ${pad2(s)}s` : `${pad2(h)}h ${pad2(m)}m ${pad2(s)}s`;
}

/** `Season 5: Mind Clash` when the admin typed the number, else `Season 5 · Mind Clash`. */
export function seasonLabel(a: ArenaState): string {
  return /^season\s+\d+/i.test(a.seasonName) ? a.seasonName : `Season ${a.seasonNo} · ${a.seasonName}`;
}

/** Replacing the season counter keeps a hand-written title: `Season 5: Mind Clash` → 6. */
export function nextSeasonName(name: string, no: number): string {
  const trimmed = name.trim();
  if (/^season\s+\d+/i.test(trimmed)) return trimmed.replace(/^season\s+\d+/i, `Season ${no}`);
  if (/^s\d+/i.test(trimmed)) return trimmed.replace(/^s\d+/i, `S${no}`);
  return `Season ${no}: ${trimmed || 'Mind Clash'}`;
}

/** The number behind a typed title, so one field can name the season and count it too. */
export function seasonNoFrom(name: string, fallback: number): number {
  const m = /^s(?:eason)?\s*(\d+)/i.exec(name.trim());
  return m ? clamp(Number(m[1]), 1, 999) : fallback;
}

export function datetimeLocalValue(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function parseDatetimeLocal(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/* ---------- the public mirror ---------- */

interface ClaimRow {
  seasonNo: number;
  tiq: number;
  badge: string;
  at: number;
}

type AwardListener = (award: SeasonAward) => void;
const awardWatchers: AwardListener[] = [];

export function onAward(cb: AwardListener): () => void {
  awardWatchers.push(cb);
  return () => {
    const i = awardWatchers.indexOf(cb);
    if (i >= 0) awardWatchers.splice(i, 1);
  };
}

function readAward(raw: unknown): SeasonAward | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<SeasonAward>;
  if (!isNum(r.seasonNo) || !isNum(r.tiq) || !isNum(r.rank)) return null;
  return {
    seasonNo: clamp(Math.floor(r.seasonNo), 1, 999),
    seasonName: str(r.seasonName, 60),
    rank: Math.max(1, Math.floor(r.rank)),
    tiq: clamp(Math.floor(r.tiq), 0, 1_000_000),
    badge: str(r.badge, 40) || 'Season Contender',
    awardedAt: isNum(r.awardedAt) ? Math.max(0, Math.floor(r.awardedAt)) : 0,
  };
}

function claims(): ClaimRow[] {
  const raw = readJson<{ claims?: unknown }>(CLAIMS_KEY);
  const rows = Array.isArray(raw?.claims) ? raw.claims : [];
  const out: ClaimRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Partial<ClaimRow>;
    if (!isNum(r.seasonNo) || !isNum(r.tiq)) continue;
    out.push({ seasonNo: Math.floor(r.seasonNo), tiq: Math.round(r.tiq), badge: str(r.badge, 40), at: isNum(r.at) ? Math.floor(r.at) : 0 });
  }
  return out;
}

function claimAward(award: SeasonAward): boolean {
  const rows = claims();
  if (rows.some((r) => r.seasonNo === award.seasonNo)) return false;
  const paid = earnTiq(award.tiq);
  rows.push({ seasonNo: award.seasonNo, tiq: paid, badge: award.badge, at: Date.now() });
  writeJson(CLAIMS_KEY, { claims: rows.slice(-12) });
  for (const cb of [...awardWatchers]) {
    try {
      cb(award);
    } catch {
      /* an award toast that throws never blocks the credit */
    }
  }
  return true;
}

/** The socket's prize push and the public mirror share one idempotent claim. */
export function claimArenaAward(raw: unknown): boolean {
  const award = readAward(raw);
  return award ? claimAward(award) : false;
}

let inflight: Promise<ArenaState | null> | null = null;

/** Read the public mirror; the latest server reading wins unless a newer local edit is waiting. */
export async function syncArena(): Promise<ArenaState | null> {
  if (inflight) return inflight;
  const url = workerUrl('/api/client/arena/state');
  if (!url) return null;
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), 3000);
  inflight = (async () => {
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      const init = tgInitData();
      if (init) headers['x-telegram-init-data'] = init;
      const res = await fetch(url, { headers, signal: ac.signal, cache: 'no-store' });
      if (!res.ok) return null;
      const data = (await res.json()) as ArenaWire;
      if (!data || data.ok !== true || !data.arena) return null;
      const next = adoptArena(data.arena);
      claimArenaAward(data.award);
      return next;
    } catch {
      return null;
    } finally {
      window.clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
}

let syncStarted = false;

/** Boot-time mirror: once now, then a slow poll and every return to the foreground. */
export function startArenaSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  void syncArena();
  window.setInterval(() => {
    if (!document.hidden) void syncArena();
  }, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void syncArena();
  });
}
