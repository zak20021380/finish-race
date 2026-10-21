/**
 * squadRoster.ts — the member list behind the squad hub.
 *
 * A squad only stores its handle, headcount and trophy total, so the roster is a
 * deterministic read of those three numbers: names, roles and contributions are
 * derived from a per-squad seed and never persisted. The local player is merged in
 * at their real banked contribution (`getMyContribution`), and every other row's
 * contribution is sliced from the trophies the squad has not earned on this device.
 * Reloading, rebinding or leaving therefore never re-rolls the table.
 *
 * Only the player's own honor is worn from the real save; another row may show a
 * medallion only when the Worker's public holder index names that exact member.
 */

import { holderEdition, wornEdition, type WornEdition } from './badges';
import { getMyContribution, type RankedSquad } from './squads';
import { profile } from './storage';
import { tgUser } from './telegram';

export type SquadRole = 'leader' | 'admin' | 'member';
export type SquadRosterSort = 'trophies' | 'name';

export interface SquadMember {
  /** 0-based display rank in contribution order; search/name sorts never overwrite it. */
  rank: number;
  id: string;
  name: string;
  role: SquadRole;
  /** Trophies this member banked for the squad. */
  contribution: number;
  isYou: boolean;
  initials: string;
  /** Avatar tint, picked from a restrained palette so 1,200 rows stay calm. */
  hue: number;
  /** A server-confirmed honor, or null when no ledger entry names this member. */
  medal: WornEdition | null;
}

export interface SquadRoster {
  members: SquadMember[];
  /** The headcount the hub quotes (at least one: the player). */
  count: number;
  /** Sum of every row's contribution. */
  trophies: number;
  yourRank: number;
  yourContribution: number;
  yourRole: SquadRole;
  yourMedal: WornEdition | null;
  youName: string;
}

const FIRSTS = [
  'Amara', 'Sofia', 'Kenji', 'Priya', 'Lucas', 'Noor', 'Owen', 'Hana',
  'Viktor', 'Lena', 'Mateo', 'Aiko', 'Zara', 'Diego', 'Nina', 'Omar',
  'Yuki', 'Ivan', 'Sara', 'Kwame', 'Elif', 'Pavel', 'Mei', 'Tariq',
  'Anouk', 'Ravi', 'Chloe', 'Bilal', 'Nour', 'Marco', 'Dana', 'Leila',
  'Hugo', 'Mila', 'Arjun', 'Freya', 'Rafael', 'Sana', 'Theo', 'Ines',
] as const;

const LASTS = [
  'Okafor', 'Laurent', 'Tanaka', 'Sharma', 'Almeida', 'Haddad', 'Bennett', 'Kim',
  'Volkov', 'Weber', 'Castillo', 'Sato', 'Rahman', 'Silva', 'Kowalski', 'Osei',
  'Demir', 'Novak', 'Chen', 'Malik', 'Visser', 'Patel', 'Moreau', 'Toure',
  'Rossi', 'Levi', 'Nakamura', 'Cruz', 'Ivanov', 'Green', 'Mensah', 'Kaya',
  'Park', 'Duarte', 'Ellis', 'Yamada',
] as const;

const AVATAR_HUES = [198, 208, 218, 232, 246, 262, 278, 296, 318, 340, 24, 42, 158, 174];
const NAME_COMBOS = FIRSTS.length * LASTS.length;
/** Coprime with NAME_COMBOS, so the first lap of names is a permutation, not a repeat. */
const NAME_STEP = 149;

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const initialsOf = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
  return letters.toUpperCase();
};

function myName(): string {
  const custom = (profile.displayName || '').trim();
  if (custom) return custom.slice(0, 24);
  const u = tgUser();
  const full = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
  if (full && full.toLowerCase() !== 'you') return full.slice(0, 24);
  const username = (u?.username || '').trim();
  return username ? username.slice(0, 24) : 'You';
}

function nameOf(seed: number, index: number): string {
  const k = (seed + index * NAME_STEP) % NAME_COMBOS;
  const base = `${FIRSTS[k % FIRSTS.length]} ${LASTS[Math.floor(k / FIRSTS.length) % LASTS.length]}`;
  const lap = Math.floor(index / NAME_COMBOS);
  return lap ? `${base} ${lap + 1}` : base;
}

/**
 * A long-tail split of `total` over `count` members. Every row has at least one
 * trophy when the squad can afford it, the first rows carry the bulk, and the
 * floors plus the leftover are handed back so the row sum is exactly `total`.
 */
function splitContributions(total: number, count: number): number[] {
  const rows = new Array<number>(count).fill(0);
  if (count <= 0 || total <= 0) return rows;

  const weights = new Float64Array(count);
  let weightSum = 0;
  for (let i = 0; i < count; i++) {
    const w = 1 / Math.pow(i + 1, 1.4);
    weights[i] = w;
    weightSum += w;
  }

  const floor = total >= count ? 1 : 0;
  const free = total - floor * count;
  let placed = 0;
  for (let i = 0; i < count; i++) {
    const share = Math.floor((free * weights[i]) / weightSum);
    rows[i] = floor + share;
    placed += share;
  }

  let rest = free - placed;
  for (let i = 0; rest > 0; i++, rest--) rows[i] += 1;
  return rows;
}

function roleFor(index: number, playerRole: SquadRole): SquadRole {
  if (playerRole === 'leader') return index < 2 || index === 4 ? 'admin' : 'member';
  if (index === 0) return 'leader';
  return index === 1 || index === 4 ? 'admin' : 'member';
}

/** Count of synthetic contributions strictly above the player's, in a descending table. */
function insertionIndex(rows: number[], value: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid] > value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function buildSquadRoster(squad: RankedSquad): SquadRoster {
  const count = Math.max(1, Math.floor(squad.members) || 1);
  const yourContribution = Math.max(0, Math.floor(getMyContribution()));
  const syntheticCount = count - 1;
  const syntheticTotal = Math.max(0, Math.floor(squad.trophies) - yourContribution);
  const contributions = splitContributions(syntheticTotal, syntheticCount);
  const youAt = insertionIndex(contributions, yourContribution);
  const tab = hash32(`${squad.id}|${squad.handle}`);
  const yourRole: SquadRole = squad.owned ? 'leader' : 'member';
  const youName = myName();
  const youKey = youName.trim().toLowerCase();

  const synthetic = contributions.map((contribution, i): SquadMember => {
    const generated = nameOf(tab, i);
    // The local player is merged in separately; never print their name twice.
    const name = generated.toLowerCase() === youKey ? `${generated} 2` : generated;
    return {
      rank: 0,
      id: `${squad.id}:${i}`,
      name,
      role: roleFor(i, yourRole),
      contribution,
      isYou: false,
      initials: initialsOf(name),
      hue: AVATAR_HUES[hash32(`${squad.id}:${name}`) % AVATAR_HUES.length],
      medal: holderEdition(name),
    };
  });

  const you: SquadMember = {
    rank: 0,
    id: `${squad.id}:you`,
    name: youName,
    role: yourRole,
    contribution: yourContribution,
    isYou: true,
    initials: initialsOf(youName),
    hue: 198,
    medal: wornEdition(),
  };

  const members: SquadMember[] = [];
  for (let i = 0; i <= synthetic.length; i++) {
    if (i === youAt) members.push(you);
    if (i < synthetic.length) members.push(synthetic[i]);
  }
  for (let i = 0; i < members.length; i++) members[i].rank = i + 1;

  return {
    members,
    count,
    trophies: yourContribution + contributions.reduce((sum, n) => sum + n, 0),
    yourRank: youAt + 1,
    yourContribution,
    yourRole,
    yourMedal: you.medal,
    youName,
  };
}

/** The rows a given query/sort should paint, in display order. Ranks stay canonical. */
export function arrangeRoster(
  roster: SquadRoster,
  sort: SquadRosterSort,
  query: string,
): SquadMember[] {
  const needle = query.trim().toLowerCase();
  let rows = roster.members;
  if (needle) rows = rows.filter((m) => m.name.toLowerCase().includes(needle));
  if (sort === 'name') rows = rows.slice().sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}
