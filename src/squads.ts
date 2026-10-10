/**
 * squads.ts — Telegram Channel / Community Squads competition layer.
 *
 * Local-first mock shaped so a server can own it later: a squad is a channel
 * handle (@name) plus its trophy total. Binding is one squad per device,
 * persisted under `detour.squads.v1`. Seeded squads give the cup and the
 * leaderboard something to rank; binding an unknown @handle mints a local
 * squad so any channel name works today.
 *
 * Ranking is derived (seeds + customs + bonus), never stored sorted, so a
 * late hydrate or a trophy award only moves numbers, never the schema.
 */

import { readJson, writeJson } from './storage';

export type SquadTrend = 'up' | 'down' | 'same';

/** Unified community type: a Telegram Channel (broadcast) or Group (chat). */
export type SquadKind = 'channel' | 'group';

export interface Squad {
  id: string;
  /** canonical handle with leading @, e.g. @DogeSquad */
  handle: string;
  name: string;
  members: number;
  trophies: number;
  trend: SquadTrend;
  /** community type; optional so older saves without it still validate */
  kind?: SquadKind;
}

export interface RankedSquad extends Squad {
  rank: number;
}

const KEY = 'detour.squads.v1';

interface SquadSave {
  boundId: string | null;
  custom: Squad[];
  bonus: Record<string, number>;
}

const SEEDS: Squad[] = [
  { id: 'sq-doge', handle: '@DogeSquad', name: 'Doge Squad', members: 1240, trophies: 18420, trend: 'up', kind: 'channel' },
  { id: 'sq-neon', handle: '@NeonRacers', name: 'Neon Racers', members: 986, trophies: 16210, trend: 'up', kind: 'group' },
  { id: 'sq-turbo', handle: '@TurboTurtles', name: 'Turbo Turtles', members: 874, trophies: 14980, trend: 'down', kind: 'channel' },
  { id: 'sq-night', handle: '@NightCircuits', name: 'Night Circuits', members: 812, trophies: 13150, trend: 'same', kind: 'group' },
  { id: 'sq-violet', handle: '@VioletRampart', name: 'Violet Rampart', members: 640, trophies: 11240, trend: 'up', kind: 'channel' },
  { id: 'sq-bend', handle: '@BendLine', name: 'Bend Line', members: 512, trophies: 9680, trend: 'down', kind: 'group' },
  { id: 'sq-check', handle: '@Checkpoint12', name: 'Checkpoint 12', members: 388, trophies: 7410, trend: 'same', kind: 'channel' },
  { id: 'sq-open', handle: '@OpenRoad', name: 'Open Road', members: 246, trophies: 5230, trend: 'up', kind: 'group' },
];

function fresh(): SquadSave {
  return { boundId: null, custom: [], bonus: {} };
}

function squadOk(s: unknown): s is Squad {
  const x = s as Partial<Squad> | undefined;
  return !!x && typeof x.id === 'string' && x.id.length > 0 && x.id.length <= 48
    && typeof x.handle === 'string' && /^@[A-Za-z0-9_]{4,32}$/.test(x.handle)
    && typeof x.name === 'string' && x.name.length > 0 && x.name.length <= 32
    && typeof x.members === 'number' && Number.isFinite(x.members) && x.members >= 0
    && typeof x.trophies === 'number' && Number.isFinite(x.trophies) && x.trophies >= 0
    && (x.trend === 'up' || x.trend === 'down' || x.trend === 'same')
    && (x.kind === undefined || x.kind === 'channel' || x.kind === 'group');
}

/** Resolve the community type, defaulting deterministically for legacy saves. */
export function squadKind(s: Pick<Squad, 'id' | 'kind'>): SquadKind {
  if (s.kind === 'channel' || s.kind === 'group') return s.kind;
  let h = 0;
  for (let i = 0; i < s.id.length; i++) h = (h * 31 + s.id.charCodeAt(i)) >>> 0;
  return h % 2 === 0 ? 'channel' : 'group';
}

function migrate(raw: Partial<SquadSave> | null): SquadSave {
  const s = fresh();
  if (!raw || typeof raw !== 'object') return s;
  if (typeof raw.boundId === 'string') s.boundId = raw.boundId;
  if (Array.isArray(raw.custom)) {
    s.custom = raw.custom.filter(squadOk).map((c) => ({ ...c, kind: squadKind(c) })).slice(0, 20);
  }
  if (raw.bonus && typeof raw.bonus === 'object') {
    for (const [k, v] of Object.entries(raw.bonus)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1_000_000) s.bonus[k] = Math.floor(v);
    }
  }
  return s;
}

const save: SquadSave = migrate(readJson<SquadSave>(KEY));

const watchers: (() => void)[] = [];
function flush() {
  writeJson(KEY, save);
  for (const w of watchers) w();
}

/** Called after every bind / leave / trophy award. */
export function onSquadChange(w: () => void) { watchers.push(w); }

/** Normalise free text to @Handle, or '' when it cannot be a channel username. */
export function cleanHandle(raw: string): string {
  let h = (raw ?? '').trim().replace(/\s+/g, '');
  if (!h) return '';
  if (!h.startsWith('@')) h = `@${h}`;
  if (!/^@[A-Za-z0-9_]{4,32}$/.test(h)) return '';
  return h;
}

const displayNameOf = (handle: string): string => {
  const base = handle.slice(1).replace(/[_]+/g, ' ').trim() || 'Squad';
  return base.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').slice(0, 32);
};

/** Seeds + customs + earned bonus, sorted by trophies, ranked 1..n. Pure. */
export function getSquadRanking(): RankedSquad[] {
  const all: Squad[] = [
    ...SEEDS.map((s) => ({ ...s, trophies: s.trophies + (save.bonus[s.id] ?? 0) })),
    ...save.custom.map((s) => ({ ...s, trophies: s.trophies + (save.bonus[s.id] ?? 0) })),
  ];
  all.sort((a, b) => b.trophies - a.trophies || b.members - a.members || a.handle.localeCompare(b.handle));
  return all.map((s, i) => ({ ...s, rank: i + 1 }));
}

export function getMySquad(): RankedSquad | null {
  if (!save.boundId) return null;
  return getSquadRanking().find((s) => s.id === save.boundId) ?? null;
}

/** Personal trophy contribution banked for the bound squad this device. */
export function getMyContribution(): number {
  if (!save.boundId) return 0;
  const v = save.bonus[save.boundId] ?? 0;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export function searchSquads(q: string, limit = 6): RankedSquad[] {
  const needle = (q ?? '').trim().replace(/^@/, '').toLowerCase();
  const all = getSquadRanking();
  if (!needle) return all.slice(0, limit);
  return all.filter((s) =>
    s.handle.toLowerCase().includes(needle) || s.name.toLowerCase().includes(needle),
  ).slice(0, limit);
}

export type BindResult = 'bound' | 'switched' | 'bad-handle' | 'already';

export function bindSquad(rawHandle: string): BindResult {
  const handle = cleanHandle(rawHandle);
  if (!handle) return 'bad-handle';
  const ranking = getSquadRanking();
  const hit = ranking.find((s) => s.handle.toLowerCase() === handle.toLowerCase());
  if (hit) {
    if (save.boundId === hit.id) return 'already';
    const was = save.boundId ? 'switched' : 'bound';
    save.boundId = hit.id;
    flush();
    return was;
  }
  const id = `sq-${Date.now().toString(36)}-${handle.slice(1, 6).toLowerCase()}`;
  const created: Squad = { id, handle, name: displayNameOf(handle), members: 1, trophies: 0, trend: 'same', kind: 'channel' };
  save.custom = [...save.custom, created].slice(-20);
  const was = save.boundId ? 'switched' : 'bound';
  save.boundId = id;
  flush();
  return was;
}

export function bindSquadById(id: string): BindResult {
  const hit = getSquadRanking().find((s) => s.id === id);
  if (!hit) return 'bad-handle';
  if (save.boundId === id) return 'already';
  const was = save.boundId ? 'switched' : 'bound';
  save.boundId = id;
  flush();
  return was;
}

export function leaveSquad(): boolean {
  if (!save.boundId) return false;
  save.boundId = null;
  flush();
  return true;
}

/** Match points go to the bound channel; unbound players bank nothing for a squad. */
export function awardSquadPoints(n: number): RankedSquad | null {
  const me = getMySquad();
  if (!me) return null;
  const gain = Math.max(0, Math.floor(n));
  if (!gain) return me;
  save.bonus[me.id] = (save.bonus[me.id] ?? 0) + gain;
  const custom = save.custom.find((s) => s.id === me.id);
  if (custom) custom.members = Math.max(custom.members, 1);
  flush();
  return getMySquad();
}

export interface ChannelCup {
  prizePool: number;
  players: number;
  endsAt: number;
  top: RankedSquad | null;
}

/** The cup meta Home paints: fixed pool, live headcount, midnight reset, current leader. */
export function getChannelCup(): ChannelCup {
  const ranking = getSquadRanking();
  const players = ranking.reduce((n, s) => n + s.members, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { prizePool: 12500, players, endsAt: end.getTime(), top: ranking[0] ?? null };
}

/** One-letter avatar snippet for a clay badge — no network, no image. */
export function squadLetter(s: Pick<Squad, 'name' | 'handle'>): string {
  const from = (s.name || s.handle || '?').replace(/^@/, '').trim();
  return (from.charAt(0) || '?').toUpperCase();
}
