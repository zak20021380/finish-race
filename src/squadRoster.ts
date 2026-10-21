/**
 * squadRoster.ts — the member list behind the squad hub.
 *
 * A squad stores its handle, headcount and a legacy points pool, but no roster and no per-member
 * ratings. The hub therefore derives a deterministic ladder of individual TIQs around the squad's
 * own standing: the local player is merged in at their real TIQ (the same `myTiq()` the Mind
 * Ladder prints) and every other row is a stable read of the squad id. The average the hub quotes
 * is the mean of the rows it actually paints, never a typed number.
 *
 * Arena standing is a second read of that same TIQ: a six-tier ladder with three divisions each
 * and a global place. It is presentation data for a local-first mock; a real tournament feed
 * replaces `arenaStandingOf()` without touching the roster shape.
 *
 * Only the player's own honor is worn from the real save; another row may show a medallion only
 * when the Worker's public holder index names that exact member.
 */

import { holderEdition, wornEdition, type WornEdition } from './badges';
import { ARENA_TIER_NAMES, arena, type ArenaTierId } from './arenaState';
import { myTiq } from './matchmaking';
import { getMyContribution, type RankedSquad } from './squads';
import { profile } from './storage';
import { tgUser } from './telegram';

export type SquadRole = 'leader' | 'admin' | 'member';
export type SquadRosterSort = 'tiq' | 'arena' | 'name';

export type ArenaTier = ArenaTierId;
export type ArenaDivision = 'I' | 'II' | 'III';

export interface ArenaStanding {
  tier: ArenaTier;
  tierName: string;
  division: ArenaDivision;
  /** "Diamond I" */
  divisionLabel: string;
  /** "Diamond Arena Div I" */
  badge: string;
  /** Global Arena place. 0 means the player has not scored a TIQ yet. */
  rank: number;
  /** Tournament wins this season, derived from the same TIQ. */
  wins: number;
}

export interface SquadMember {
  /** 0-based display rank in TIQ order; search/name sorts never overwrite it. */
  rank: number;
  id: string;
  name: string;
  role: SquadRole;
  /** The member's own Tactical IQ — the number the ladder ranks. */
  tiq: number;
  arena: ArenaStanding;
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
  /** Sum(Member TIQ) / Total Members, read off the rows above. */
  avgTiq: number;
  totalTiq: number;
  yourRank: number;
  yourTiq: number;
  /** Squad TIQ banked on this device this season. */
  yourContribution: number;
  yourRole: SquadRole;
  yourMedal: WornEdition | null;
  youName: string;
  yourArena: ArenaStanding;
  /** The tier the whole squad wears, read off `avgTiq`. */
  squadArena: ArenaStanding;
}

/** The championship the Arena stages; the card names it beside your place. */
export const ARENA_CUP = 'Grand Cup';

/** The #1 squad's average in the seeded field; every next rank is 85 TIQ lower. */
const AVG_TOP = 3_420;
const AVG_STEP = 85;
const AVG_FLOOR = 1_800;
const ARENA_FIELD = 250_000;

interface ArenaTierSpec {
  id: ArenaTier;
  name: string;
  hi: number;
  /** Upper TIQ of Div III and Div II; anything above the second cut is Div I. */
  cuts: readonly [number, number];
}

/**
 * The divisions the Command Center publishes, turned into the same six-band ladder.
 * A live edit to the thresholds re-cuts every tier's three divisions without a reload;
 * the last tier keeps a 1,000-TIQ spread because it has no upper neighbour.
 */
let tierCacheKey = '';
let tierCache: readonly ArenaTierSpec[] = [];

function arenaTierSpecs(): readonly ArenaTierSpec[] {
  const rules = arena().divisions;
  const key = rules.map((r) => r.min).join('|');
  if (key === tierCacheKey) return tierCache;
  tierCacheKey = key;
  tierCache = rules.map((rule, i) => {
    const next = rules[i + 1]?.min;
    const hi = next ?? Infinity;
    const span = Number.isFinite(hi) ? hi - rule.min : 1_000;
    return {
      id: rule.id,
      name: ARENA_TIER_NAMES[rule.id],
      hi,
      cuts: [rule.min + span / 3, rule.min + (span * 2) / 3] as const,
    };
  });
  return tierCache;
}

/**
 * The global Arena place for a TIQ. Anchored so the brief's reference mind (3,740) sits at
 * #42 and a 5,804 sits inside the top five; the tail is clamped to a 250k field.
 */
export function arenaRankOf(tiq: number): number {
  if (tiq <= 0) return 0;
  const place = 42 * Math.pow(3_740 / tiq, 5.35);
  if (!Number.isFinite(place)) return ARENA_FIELD;
  return Math.max(1, Math.min(ARENA_FIELD, Math.round(place)));
}

/** The tier + division a TIQ buys, plus the place and tourney wins that follow from it. */
export function arenaStandingOf(tiq: number): ArenaStanding {
  const value = Math.max(0, Math.floor(tiq));
  const tiers = arenaTierSpecs();
  const spec = tiers.find((t) => value < t.hi) ?? tiers[tiers.length - 1];
  const division: ArenaDivision = value < spec.cuts[0] ? 'III' : value < spec.cuts[1] ? 'II' : 'I';
  return {
    tier: spec.id,
    tierName: spec.name,
    division,
    divisionLabel: `${spec.name} ${division}`,
    badge: `${spec.name} Arena Div ${division}`,
    rank: arenaRankOf(value),
    wins: Math.max(0, Math.round((value - 1_000) / 170)),
  };
}

/** The average a squad is built around, by its global place in the seeded field. */
export function squadTargetAvg(rank: number): number {
  return Math.max(AVG_FLOOR, AVG_TOP - (Math.max(1, rank) - 1) * AVG_STEP);
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
 * A two-tier split of `total` TIQ over `count` synthetic members, in descending order.
 *
 * The top ~3% are the squad's stars: a linear tail whose mean is ~1.42x the squad average,
 * from ~1.7x down to ~1.13x. Everyone else is a tight core just under the average. That is
 * the shape a real top squad has — a few carriers and a large bench — and it makes the
 * personal Arena place (a smooth read of TIQ) land coherently inside the roster. A small
 * deterministic jitter keeps 1,200 rows from reading like a printed ruler; the rounding
 * remainder is handed back so the mean is exact before the local player is merged in.
 */
function splitTiq(squadId: string, total: number, count: number, fullCount: number): number[] {
  if (count <= 0 || total <= 0) return new Array<number>(Math.max(0, count)).fill(0);

  const elite = Math.min(count, Math.max(1, Math.round(fullCount * 0.03)));
  const bulk = count - elite;
  const eliteShare = bulk <= 0 ? 1 : (elite * 1.415) / fullCount;
  const eliteTotal = Math.round(total * eliteShare);
  const bulkTotal = total - eliteTotal;
  const eliteMean = eliteTotal / elite;
  const bulkMean = bulk > 0 ? bulkTotal / bulk : 0;

  const rows = new Array<number>(count).fill(0);
  for (let i = 0; i < elite; i++) {
    const t = elite === 1 ? 0 : i / (elite - 1);
    const shape = elite === 1 ? 1 : 1.2 - 0.4 * t;
    const jitter = 0.994 + ((hash32(`${squadId}|elite|${i}`) % 1000) / 1000) * 0.012;
    rows[i] = Math.max(0, Math.round(eliteMean * shape * jitter));
  }
  for (let i = 0; i < bulk; i++) {
    const t = bulk === 1 ? 0 : i / (bulk - 1);
    const shape = bulk === 1 ? 1 : 1.025 - 0.05 * t;
    const jitter = 0.996 + ((hash32(`${squadId}|core|${i}`) % 1000) / 1000) * 0.008;
    rows[elite + i] = Math.max(0, Math.round(bulkMean * shape * jitter));
  }
  rows.sort((a, b) => b - a);

  let placed = rows.reduce((sum, n) => sum + n, 0);
  let rest = total - placed;
  const guard = count * 3;
  for (let i = 0, n = 0; rest > 0 && n < guard; i = (i + 1) % count, n++, rest--) rows[i] += 1;
  for (let i = count - 1, n = 0; rest < 0 && n < guard; i = (i - 1 + count) % count, n++) {
    if (rows[i] > 0) { rows[i] -= 1; rest += 1; }
  }
  return rows;
}

/**
 * Arena places are a global ladder, so two squadmates may share a rounded place.
 * Resolve ties in TIQ order; the local player keeps the place the formula quotes.
 * Then swap a deterministic set of adjacent pairs — the podium and the player are
 * never swapped — so "sort by Arena rank" is a genuinely different order from
 * "sort by TIQ", and every place shown on a row is the place it sorts by.
 */
function settleArenaRanks(squadId: string, members: SquadMember[]): void {
  const used = new Set<number>();
  const you = members.find((m) => m.isYou);
  if (you && you.arena.rank > 0) used.add(you.arena.rank);

  let last = 0;
  for (const member of members) {
    if (member.isYou || member.arena.rank <= 0) continue;
    let rank = Math.max(member.arena.rank, last + 1);
    while (used.has(rank)) rank++;
    member.arena.rank = rank;
    used.add(rank);
    last = rank;
  }

  for (let i = 3; i + 1 < members.length; i += 2) {
    const a = members[i];
    const b = members[i + 1];
    if (a.isYou || b.isYou || a.rank <= 3 || b.rank <= 3) continue;
    if ((hash32(`${squadId}|swap|${a.id}`) & 1) === 1) continue;
    const rank = a.arena.rank;
    a.arena.rank = b.arena.rank;
    b.arena.rank = rank;
  }
}

function roleFor(index: number, playerRole: SquadRole): SquadRole {
  if (playerRole === 'leader') return index < 2 || index === 4 ? 'admin' : 'member';
  if (index === 0) return 'leader';
  return index === 1 || index === 4 ? 'admin' : 'member';
}

/** Count of synthetic TIQs strictly above the player's, in a descending table. */
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
  const yourTiq = Math.max(0, Math.floor(myTiq()));
  const yourContribution = Math.max(0, Math.floor(getMyContribution()));
  const syntheticCount = count - 1;
  const targetTotal = Math.round(squadTargetAvg(squad.rank) * count);
  const syntheticTotal = Math.max(0, targetTotal - yourTiq);
  const tiqs = splitTiq(squad.id, syntheticTotal, syntheticCount, count);
  const youAt = insertionIndex(tiqs, yourTiq);
  const tab = hash32(`${squad.id}|${squad.handle}`);
  const yourRole: SquadRole = squad.owned ? 'leader' : 'member';
  const youName = myName();
  const youKey = youName.trim().toLowerCase();

  const synthetic = tiqs.map((tiq, i): SquadMember => {
    const generated = nameOf(tab, i);
    // The local player is merged in separately; never print their name twice.
    const name = generated.toLowerCase() === youKey ? `${generated} 2` : generated;
    return {
      rank: 0,
      id: `${squad.id}:${i}`,
      name,
      role: roleFor(i, yourRole),
      tiq,
      arena: arenaStandingOf(tiq),
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
    tiq: yourTiq,
    arena: arenaStandingOf(yourTiq),
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
  settleArenaRanks(squad.id, members);

  const totalTiq = members.reduce((sum, m) => sum + m.tiq, 0);
  const avgTiq = Math.round(totalTiq / Math.max(1, members.length));

  return {
    members,
    count,
    avgTiq,
    totalTiq,
    yourRank: youAt + 1,
    yourTiq,
    yourContribution,
    yourRole,
    yourMedal: you.medal,
    youName,
    yourArena: you.arena,
    squadArena: arenaStandingOf(avgTiq),
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
  else if (sort === 'arena') {
    rows = rows.slice().sort((a, b) =>
      (a.arena.rank || Infinity) - (b.arena.rank || Infinity)
      || b.tiq - a.tiq
      || a.name.localeCompare(b.name));
  }
  return rows;
}
