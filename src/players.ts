/**
 * players.ts — the Admin Command Center's player directory, held on the device.
 *
 * The Users tab reads the matchmaker's own registry when a Worker is behind the page
 * (`GET /admin/players`). When there is none — a static preview, a `file://` tab, a refused
 * request — the tab still has to be a working directory, so this module stands in for the server:
 * one deterministic roster of a thousand-odd players, generated from a fixed seed (the same page
 * load shows the same court twice), persisted to localStorage so moderation survives a reload.
 *
 * The shape of a record is deliberately the Worker's `PlayerRecord`, field for field — `admin.ts`
 * renders both sources through one card, and a row that arrives from the wire lands here without
 * translation. The device's own player rides the roster as row `you`, folded in by the caller so
 * the directory always shows the operator what everyone else would see.
 */
import { profile, readJson, writeJson } from './storage';

/** One row of the directory. Mirrors `PlayerRecord` in `worker/matchmaker.ts`. */
export interface DirPlayer {
  id: string;
  tgId: string;
  name: string;
  username: string;
  country: string;
  /** Player-declared age, or 0 when their profile has never set one. */
  age: number;
  tiq: number;
  firstSeen: number;
  lastSeen: number;
  lastPlayed: number;
  matches: number;
  wins: number;
  losses: number;
  streak: number;
  best: number;
  coins: number;
  stars: number;
  referrals: number;
  squad: string;
  banned: boolean;
  muted: boolean;
  inMatch: boolean;
}

/** The four directory views behind the filter chips. */
export type DirFilter = 'all' | 'active' | 'tiq' | 'flagged';

/** The demographic cohorts behind the Age picker. `age` 0 never matches a named band. */
export type AgeBand = 'all' | 'u18' | '18-24' | '25-34' | '35p';

/** How the directory orders the rows that survive its filters. */
export type DirSort = 'default' | 'lastPlayed' | 'joined' | 'tiq';

export interface DirQuery {
  q: string;
  filter: DirFilter;
  /** ISO 3166-1 alpha-2, or '' for every country. */
  country: string;
  age: AgeBand;
  sort: DirSort;
  offset: number;
  limit: number;
}

function inAgeBand(age: number, band: AgeBand): boolean {
  if (band === 'all') return true;
  if (!(age > 0)) return false;
  if (band === 'u18') return age < 18;
  if (band === '18-24') return age >= 18 && age <= 24;
  if (band === '25-34') return age >= 25 && age <= 34;
  return age >= 35;
}

export interface DirPage {
  total: number;
  offset: number;
  limit: number;
  players: DirPlayer[];
}

/** The device's own seat id: stable across reloads, distinct from every seeded row. */
export const YOU_ID = 'you';

const KEY = 'detour.players.v1';
const V = 1;
const ROSTER = 1160;
const PAGE = 40;
const ACTIVE_MS = 24 * 60 * 60 * 1000;

const FIRST = [
  'Nadia', 'Rune', 'Ivo', 'Mira', 'Sable', 'Kenji', 'Lior', 'Ada', 'Tomas', 'Anya',
  'Diego', 'Priya', 'Omar', 'Lena', 'Kofi', 'Yuki', 'Mateo', 'Zoya', 'Felix', 'Ines',
  'Aarav', 'Noor', 'Emil', 'Talia', 'Hugo', 'Sana', 'Ravi', 'Elsa', 'Bram', 'Mei',
  'Jonas', 'Dalia', 'Piet', 'Nia', 'Cem', 'Alba', 'Raj', 'Liv', 'Nils', 'Farah',
  'Oskar', 'Rania', 'Theo', 'Vera', 'Malik', 'Ida', 'Sami', 'June', 'Arno', 'Leila',
] as const;

const LAST = [
  'K.', 'Petrov', 'W.', 'N.', 'Silva', 'Okafor', 'Haddad', 'Tanaka', 'Novak', 'Berg',
  'Costa', 'Ivanov', 'Kaur', 'Moreau', 'Sato', 'Lindqvist', 'Diallo', 'Weiss', 'Reyes', 'Vargas',
] as const;

const COUNTRY = [
  'IR', 'PL', 'NO', 'BG', 'KZ', 'GB', 'JP', 'IL', 'DE', 'BR',
  'IN', 'NG', 'TR', 'FR', 'ES', 'IT', 'SE', 'NL', 'FI', 'UA',
  'RO', 'PT', 'GR', 'EG', 'ZA', 'KE', 'MA', 'AE', 'SA', 'ID',
  'PH', 'KR', 'VN', 'TH', 'AU', 'NZ', 'CA', 'US', 'MX', 'AR',
  'CL', 'PK', 'BD',
] as const;

const SQUADS = [
  'claycourt', 'hazardclub', 'wallbuilders', 'closed_lines', 'finalgate', 'minewatch',
  'nightligue', 'firstblood', 'the_commons', 'detour_daily', 'northblock', 'stonegarden',
] as const;

/** A small deterministic generator: the same seed draws the same court on every load. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rnd: () => number, pool: readonly T[]): T => pool[Math.floor(rnd() * pool.length)];

/** A plausible roster minted from the seed, newest faces first. */
function generate(now: number): DirPlayer[] {
  const rnd = mulberry32(0x0d37_0a17);
  const rows: DirPlayer[] = [];
  for (let i = 0; i < ROSTER; i++) {
    const first = pick(rnd, FIRST);
    const last = rnd() < 0.45 ? ` ${pick(rnd, LAST)}` : '';
    const name = `${first}${last}`;
    const username = rnd() < 0.72 ? `${first.toLowerCase()}${last ? last.trim().replace('.', '').toLowerCase() : ''}${Math.floor(rnd() * 90) + 10}` : '';
    /* the age mix a global board actually gets: a young tail, a 25–34 centre, older veterans */
    const ageRoll = rnd();
    const age = ageRoll < 0.13
      ? 13 + Math.floor(rnd() * 5)
      : ageRoll < 0.40
        ? 18 + Math.floor(rnd() * 7)
        : ageRoll < 0.77
          ? 25 + Math.floor(rnd() * 10)
          : 35 + Math.floor(rnd() * 24);
    const tiq = Math.round(130 + Math.pow(rnd(), 1.8) * 3320);
    const matches = Math.floor(Math.pow(rnd(), 1.4) * 420);
    const wins = Math.min(matches, Math.round(matches * (0.32 + rnd() * 0.44)));
    const losses = matches - wins;
    const streak = rnd() < 0.6 ? Math.floor(rnd() * Math.min(14, wins + 1)) : 0;
    const lastSeen = now - Math.floor(Math.pow(rnd(), 2.2) * 40 * 24 * 3600 * 1000) - (rnd() < 0.05 ? 0 : Math.floor(rnd() * 3600 * 1000));
    const banned = rnd() < 0.03;
    rows.push({
      id: `lp-${(i + 1).toString(36)}-${Math.floor(rnd() * 1e6).toString(36)}`,
      tgId: String(Math.floor(1e8 + rnd() * 2e9)),
      name,
      username,
      country: rnd() < 0.92 ? pick(rnd, COUNTRY) : '',
      age,
      tiq,
      firstSeen: lastSeen - Math.floor(rnd() * 180 * 24 * 3600 * 1000),
      lastSeen,
      lastPlayed: matches > 0 ? lastSeen - Math.floor(rnd() * 3 * 24 * 3600 * 1000) : 0,
      matches,
      wins,
      losses,
      streak,
      best: Math.max(streak, Math.floor(rnd() * Math.min(24, wins + 1))),
      coins: Math.round(150 + Math.pow(rnd(), 1.6) * 52000),
      stars: rnd() < 0.35 ? Math.floor(Math.pow(rnd(), 2) * 2400) : 0,
      referrals: rnd() < 0.4 ? Math.floor(rnd() * 34) : 0,
      squad: rnd() < 0.3 ? pick(rnd, SQUADS) : '',
      banned,
      muted: banned,
      inMatch: !banned && rnd() < 0.02,
    });
  }
  return rows;
}

/* ---------- the store ---------- */

const whole = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Fold a stored or hand-edited row field by field; bad rows are dropped, never trusted. */
function readRow(raw: unknown): DirPlayer | null {
  const r = raw as Partial<DirPlayer> | null | undefined;
  if (!r || typeof r.id !== 'string' || !r.id) return null;
  return {
    id: r.id.slice(0, 64),
    tgId: text(r.tgId, 20).replace(/[^0-9-]/g, ''),
    name: text(r.name, 40) || 'Player',
    username: text(r.username, 40),
    country: text(r.country, 2).toUpperCase(),
    age: Math.min(120, whole(r.age)),
    tiq: whole(r.tiq),
    firstSeen: whole(r.firstSeen),
    lastSeen: whole(r.lastSeen),
    lastPlayed: whole(r.lastPlayed),
    matches: whole(r.matches),
    wins: whole(r.wins),
    losses: whole(r.losses),
    streak: whole(r.streak),
    best: whole(r.best),
    coins: whole(r.coins),
    stars: whole(r.stars),
    referrals: whole(r.referrals),
    squad: text(r.squad, 24),
    banned: r.banned === true,
    muted: r.muted === true,
    inMatch: r.inMatch === true,
  };
}

/**
 * A deterministic age for a roster written before the demographic filter existed. Keeps the
 * installed rows (and the moderation on them) instead of re-seeding the whole directory.
 */
function seededAge(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 33) + id.charCodeAt(i)) >>> 0;
  const r = h % 100;
  if (r < 13) return 13 + (h % 5);
  if (r < 40) return 18 + (h % 7);
  if (r < 77) return 25 + (h % 10);
  return 35 + (h % 25);
}

function load(): DirPlayer[] {
  const raw = readJson<{ v: number; players: unknown[] }>(KEY);
  if (raw && raw.v === V && Array.isArray(raw.players) && raw.players.length >= 100) {
    const rows = raw.players.map(readRow).filter((p): p is DirPlayer => p !== null);
    if (rows.length >= 100) {
      const hadNoAge = raw.players.some((r) => typeof (r as { age?: unknown } | null)?.age !== 'number');
      if (hadNoAge) {
        for (const p of rows) if (!p.age) p.age = seededAge(p.id);
        writeJson(KEY, { v: V, players: rows });
      }
      return rows;
    }
  }
  const fresh = generate(Date.now());
  writeJson(KEY, { v: V, players: fresh });
  return fresh;
}

const store = load();

/** The row behind an id, or null. The live seat reads its own ban state through this. */
export function directoryPlayer(id: string): DirPlayer | null {
  return store.find((p) => p.id === id) ?? null;
}

/** The country codes the directory can honestly offer, with the operator's own profile folded in. */
export function directoryCountries(): string[] {
  const set = new Set<string>();
  for (const p of store) if (/^[A-Z]{2}$/.test(p.country)) set.add(p.country);
  if (profile.country && /^[A-Z]{2}$/i.test(profile.country)) set.add(profile.country.toUpperCase());
  return [...set].sort();
}

/**
 * BAN / UNBAN / GRANT_COINS on one row, exactly as `/admin/player` plays them. Returns the row as
 * it now stands, or null when the id is not in the directory.
 */
export function directoryAction(id: string, action: string, coins = 0): DirPlayer | null {
  const p = store.find((row) => row.id === id);
  if (!p) return null;
  if (action === 'BAN') {
    p.banned = true;
    p.muted = true;
    p.inMatch = false;
  } else if (action === 'UNBAN') {
    p.banned = false;
    p.muted = false;
  } else if (action === 'GRANT_COINS') {
    const n = Number.isFinite(coins) ? Math.round(coins) : 0;
    p.coins = Math.min(100_000_000, Math.max(0, p.coins + Math.max(-1_000_000, Math.min(1_000_000, n))));
  } else {
    return null;
  }
  p.lastSeen = Date.now();
  writeJson(KEY, { v: V, players: store });
  return p;
}

/* ---------- reading the directory ---------- */

/**
 * Fold the live seat into the roster. Its identity and race record come from the save the moment
 * it is asked for — the operator sees the same numbers the rest of the app does — while its
 * moderation flags stay the stored row's, so a ban survives a reload.
 */
function withLive(rows: DirPlayer[], live: DirPlayer | null): DirPlayer[] {
  if (!live) return rows;
  const stored = rows.find((p) => p.id === live.id);
  const merged: DirPlayer = stored
    ? { ...live, banned: stored.banned, muted: stored.muted }
    : live;
  const rest = rows.filter((p) => p.id !== live.id);
  if (!stored) {
    store.unshift(readRow(live) ?? merged);
    writeJson(KEY, { v: V, players: store });
  }
  return [merged, ...rest];
}

/**
 * One page of the directory: the query is the chip's filter and the search box's tokens, the
 * window is what the panel asked for. Ordering puts live boards first, then the freshest seats —
 * a directory that reads like the room does. A TIQ filter ranks by the number instead.
 */
export function directoryPage(query: DirQuery, live: DirPlayer | null): DirPage {
  const rows = withLive(store, live);
  const tokens = query.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const now = Date.now();
  const rawCountry = (query.country ?? '').trim().toUpperCase();
  const country = /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : '';
  const age = query.age ?? 'all';
  /* the Top TIQ chip is a sort shortcut, but an explicit pick from the Sort control wins */
  const sort = query.filter === 'tiq' && query.sort === 'default' ? 'tiq' : (query.sort ?? 'default');
  let out = rows;
  if (tokens.length) {
    out = out.filter((p) => {
      const hay = `${p.name} ${p.username} ${p.tgId} ${p.id}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }
  if (query.filter === 'active') out = out.filter((p) => p.inMatch || now - p.lastSeen <= ACTIVE_MS);
  if (query.filter === 'flagged') out = out.filter((p) => p.banned || p.muted);
  if (country) out = out.filter((p) => p.country === country);
  if (age !== 'all') out = out.filter((p) => inAgeBand(p.age, age));
  const rank = [...out];
  if (sort === 'lastPlayed') rank.sort((a, b) => b.lastPlayed - a.lastPlayed || b.lastSeen - a.lastSeen);
  else if (sort === 'joined') rank.sort((a, b) => b.firstSeen - a.firstSeen);
  else if (sort === 'tiq') rank.sort((a, b) => b.tiq - a.tiq || b.lastSeen - a.lastSeen);
  else if (query.filter === 'flagged') rank.sort((a, b) => Number(b.banned) - Number(a.banned) || b.lastSeen - a.lastSeen);
  else rank.sort((a, b) => Number(b.inMatch) - Number(a.inMatch) || b.lastSeen - a.lastSeen);
  /* the operator's own seat leads the untouched default view: it is the row they look for first */
  if (query.filter === 'all' && sort === 'default' && !country && age === 'all') {
    const me = rank.findIndex((p) => p.id === YOU_ID);
    if (me > 0) rank.unshift(rank.splice(me, 1)[0]);
  }
  const offset = Math.max(0, Math.floor(query.offset) || 0);
  const limit = Math.max(1, Math.min(200, Math.floor(query.limit) || PAGE));
  return { total: rank.length, offset, limit, players: rank.slice(offset, offset + limit) };
}

/** The page size the panel's first screen asks for; "Load more" adds another. */
export const PAGE_SIZE = PAGE;

/** The device's save, folded into a directory row the panel can show as the live seat. */
export function liveRow(face: { name: string; tiq: number; squad: string }): DirPlayer {
  const s = profile.stats;
  const stored = directoryPlayer(YOU_ID);
  const now = Date.now();
  return {
    id: YOU_ID,
    tgId: '',
    name: face.name || 'You',
    username: '',
    country: profile.country ?? '',
    age: profile.age ?? 0,
    tiq: face.tiq,
    firstSeen: stored?.firstSeen || now,
    lastSeen: now,
    lastPlayed: s.games > 0 ? now : 0,
    matches: s.games,
    wins: s.wins,
    losses: s.losses,
    streak: s.streak,
    best: s.best,
    coins: profile.coins,
    stars: stored?.stars ?? 0,
    referrals: profile.referral.joins,
    squad: face.squad,
    banned: stored?.banned === true,
    muted: stored?.muted === true,
    inMatch: false,
  };
}
