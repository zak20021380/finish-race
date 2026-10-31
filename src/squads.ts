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
  /** Telegram photo file id, when the Bot API returned one */
  avatar?: string;
  /** 2–3 character call sign stamped on the squad crest */
  tag?: string;
  /**
   * ms epoch this community enlisted in the Channel War — the tournament's own
   * enrollment mark, written once when the squad is minted and never edited.
   * Absent on the seeded field and on every squad saved before enlistment
   * existed, so a legacy save still validates; the stamp records intent and is
   * never a ranking input (trophies alone move the board).
   */
  enlistedAt?: number;
}

export interface RankedSquad extends Squad {
  rank: number;
  /**
   * True when this device created the squad (a bound handle or a verified
   * Telegram claim). Custom squads live only on this device, so the local
   * player is their leader; seed squads belong to the wider community.
   */
  owned: boolean;
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
    && typeof x.handle === 'string' && /^@[A-Za-z0-9_]{3,32}$/.test(x.handle)
    && typeof x.name === 'string' && x.name.length > 0 && x.name.length <= 32
    && typeof x.members === 'number' && Number.isFinite(x.members) && x.members >= 0
    && typeof x.trophies === 'number' && Number.isFinite(x.trophies) && x.trophies >= 0
    && (x.trend === 'up' || x.trend === 'down' || x.trend === 'same')
    && (x.kind === undefined || x.kind === 'channel' || x.kind === 'group')
    && (x.avatar === undefined || (typeof x.avatar === 'string' && x.avatar.length <= 160))
    && (x.tag === undefined || (typeof x.tag === 'string' && /^[A-Z0-9]{2,3}$/.test(x.tag)))
    && (x.enlistedAt === undefined || (typeof x.enlistedAt === 'number' && Number.isFinite(x.enlistedAt) && x.enlistedAt > 0));
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

/** Telegram username floor and ceiling, in characters. */
export const HANDLE_MIN = 4;
export const HANDLE_MAX = 32;

/**
 * Telegram usernames: 4–32 characters, letters, digits or underscores.
 * The `i` flag is load-bearing — `computerScience55` is a legal username and
 * must never be refused for its capitals.
 */
export const HANDLE_RE = /^[a-z0-9_]{4,32}$/i;

export type HandleIssue = '' | 'empty' | 'short' | 'long' | 'chars';

/**
 * Fold a `t.me` link, a typed `@` and the surrounding whitespace down to the bare
 * username. Every entry point reads a handle through this first, so the same
 * string is judged by the same rule whether it was typed, pasted or linked.
 */
export function bareHandle(raw: string): string {
  let value = (raw ?? '').trim();
  const link = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(.+)$/i.exec(value);
  if (link) value = link[1].split(/[?#]/)[0].replace(/\/+$/, '');
  return value.replace(/^@+/, '').trim();
}

/**
 * Why a typed or pasted community reference is not a Telegram username, or '' when it is.
 * Links and a leading `@` are folded first, so the same rule applies to every entry point.
 */
export function handleIssue(raw: string): HandleIssue {
  const value = bareHandle(raw);
  if (!value) return 'empty';
  if (value.length < HANDLE_MIN) return 'short';
  if (value.length > HANDLE_MAX) return 'long';
  return HANDLE_RE.test(value) ? '' : 'chars';
}

/** Normalise free text to @Handle, or '' when it cannot be a channel username. */
export function cleanHandle(raw: string): string {
  const bare = bareHandle(raw);
  return bare && HANDLE_RE.test(bare) ? `@${bare}` : '';
}

/** Normalise a crest call sign to 2–3 uppercase alphanumerics, or '' when invalid. */
export function cleanTag(raw: string): string {
  const tag = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  return /^[A-Z0-9]{2,3}$/.test(tag) ? tag : '';
}

/** Accept a bare username, a typed `@name` or a `t.me` link; return the canonical @Handle. */
export function cleanChatReference(raw: string): string {
  return cleanHandle(raw);
}

export const displayNameOf = (handle: string): string => {
  const base = handle.slice(1).replace(/[_]+/g, ' ').trim() || 'Squad';
  return base.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').slice(0, 32);
};

/**
 * Public profile photo for a Telegram channel/group. Returns '' for malformed
 * handles; the CDN may still answer with an error or a 1x1 placeholder, so
 * callers must keep a monogram underneath.
 */
export function telegramAvatarUrl(handle: string): string {
  const clean = cleanHandle(handle);
  return clean ? `https://t.me/i/userpic/320/${clean.slice(1)}.jpg` : '';
}

/** The glyph on a squad crest: its call sign when registered, else the name's initial. */
export function squadMark(s: Pick<Squad, 'name' | 'handle' | 'tag'>): string {
  const tag = typeof s.tag === 'string' ? cleanTag(s.tag) : '';
  return tag || squadLetter(s);
}

/** Seeds + customs + earned bonus, sorted by trophies, ranked 1..n. Pure. */
export function getSquadRanking(): RankedSquad[] {
  const all: (Squad & { owned: boolean })[] = [
    ...SEEDS.map((s) => ({ ...s, trophies: s.trophies + (save.bonus[s.id] ?? 0), owned: false })),
    ...save.custom.map((s) => ({ ...s, trophies: s.trophies + (save.bonus[s.id] ?? 0), owned: true })),
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

export interface RegisteredSquadInput {
  id?: string;
  handle: string;
  name: string;
  members: number;
  kind?: SquadKind;
  avatar?: string;
  tag?: string;
}

export type ClaimResult =
  | { ok: true; squad: RankedSquad }
  | { ok: false; reason: 'bad-handle' | 'already' };

export function claimRegisteredSquad(input: RegisteredSquadInput): ClaimResult {
  const handle = cleanHandle(input.handle);
  if (!handle) return { ok: false, reason: 'bad-handle' };
  const existing = getSquadRanking().find((s) => s.handle.toLowerCase() === handle.toLowerCase());
  if (existing) return { ok: false, reason: 'already' };
  const fallbackId = `sq-${Date.now().toString(36)}-${handle.slice(1, 6).toLowerCase()}`;
  const id = (input.id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || fallbackId;
  if (getSquadRanking().some((s) => s.id === id)) return { ok: false, reason: 'already' };
  const name = (input.name || displayNameOf(handle)).trim().slice(0, 32) || displayNameOf(handle);
  const members = Number.isFinite(input.members) && input.members > 0 ? Math.floor(input.members) : 1;
  const tag = cleanTag(input.tag ?? '');
  const created: Squad = {
    id,
    handle,
    name,
    members,
    trophies: 0,
    trend: 'same',
    kind: input.kind === 'group' ? 'group' : 'channel',
    avatar: typeof input.avatar === 'string' ? input.avatar.slice(0, 160) : '',
    ...(tag ? { tag } : {}),
    enlistedAt: Date.now(),
  };
  save.custom = [...save.custom, created].slice(-20);
  save.boundId = id;
  flush();
  return { ok: true, squad: getMySquad() ?? { ...created, rank: getSquadRanking().length, owned: true } };
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
