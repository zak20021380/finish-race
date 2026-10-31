/**
 * squadRoster.ts — the member list behind the squad hub.
 *
 * This used to *invent* a ladder: a deterministic spread of names and TIQs around the squad's
 * standing, so a channel with 1,240 Telegram subscribers appeared to have 1,240 players. None of
 * those people existed. The roster is now a projection of the squad's real roster — the players
 * who actually tapped Join — and every number on it is one of theirs.
 *
 * Arena standing stays a read of the member's own TIQ (a six-tier ladder with three divisions and
 * a global place), so the hub and the Mind Ladder can never disagree about a player's rank.
 */

import { holderEdition, wornEdition, type WornEdition } from './badges';
import { ARENA_TIER_NAMES, arena, type ArenaTierId } from './arenaState';
import { myTiq } from './matchmaking';
import {
  myRosterId, myPlayerName, squadRosterOf, type RankedSquad, type SquadMember as SquadRow,
  type SquadRole,
} from './squads';
import { profile } from './storage';
import { t } from './settings';
import { tgUser } from './telegram';

export type SquadRosterSort = 'tiq' | 'arena' | 'name';

/** Re-exported so a caller can name the role without reaching into the store module. */
export type { SquadRole } from './squads';

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
  /** ISO 3166-1 alpha-2 for the flag badge; the loaded save wins for the local player. */
  country: string;
  arena: ArenaStanding;
  isYou: boolean;
  initials: string;
  /** Avatar tint, picked from a restrained palette so a long roster stays calm. */
  hue: number;
  /** A server-confirmed honor, or null when no ledger entry names this member. */
  medal: WornEdition | null;
}

export interface SquadRoster {
  members: SquadMember[];
  /** The headcount the hub quotes: the roster's own length, at least one (the player). */
  count: number;
  /** Sum(Member TIQ) / Total Members, read off the rows above. */
  avgTiq: number;
  totalTiq: number;
  yourRank: number;
  yourTiq: number;
  yourRole: SquadRole;
  yourMedal: WornEdition | null;
  youName: string;
  yourArena: ArenaStanding;
  /** The tier the whole squad wears, read off `avgTiq`. */
  squadArena: ArenaStanding;
  /** The Telegram chat's audience, when the Worker reported one. An external stat. */
  subscribers: number;
}

/** The championship the Arena stages; the card names it beside your place. */
export const ARENA_CUP = 'Grand Cup';

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

const AVATAR_HUES = [198, 208, 218, 232, 246, 262, 278, 296, 318, 340, 24, 42, 158, 174];

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
  const fromTg = myPlayerName();
  if (fromTg) return fromTg;
  const u = tgUser();
  return (u?.username || 'You').slice(0, 24);
}

/** The save's own alpha-2 wins for the local player; another row keeps what they reported. */
function countryOf(row: SquadRow, isYou: boolean): string {
  if (isYou) {
    const saved = profile.country;
    if (saved && /^[A-Za-z]{2}$/.test(saved)) return saved.toUpperCase();
  }
  return /^[A-Za-z]{2}$/.test(row.country) ? row.country.toUpperCase() : '';
}

/**
 * The roster the hub paints. Every row is a player who joined; the local player's row reads
 * `myTiq()` so the score they see is the one their games earned. A one-member squad is a normal,
 * fully-supported state — it is what every squad looks like on the day it is founded.
 */
export function buildSquadRoster(squad: RankedSquad): SquadRoster {
  const me = myRosterId();
  const rows = squadRosterOf(squad);
  const yourTiq = Math.max(0, Math.floor(myTiq()));

  const members: SquadMember[] = rows.map((row, i) => {
    const isYou = row.id === me;
    const tiq = isYou ? yourTiq : Math.max(0, Math.floor(row.tiq));
    /* An enlisting player who never sent a name still gets a readable row: the role is the name
       the roster knows them by. Nothing is invented beyond that. */
    const name = row.name || (isYou ? myName() : row.role === 'leader' ? t('squadLeader') : '');
    return {
      rank: i + 1,
      id: row.id,
      name,
      role: row.role,
      tiq,
      country: countryOf(row, isYou),
      arena: arenaStandingOf(tiq),
      isYou,
      initials: initialsOf(name || '?'),
      hue: AVATAR_HUES[hash32(`${squad.id}:${row.id}`) % AVATAR_HUES.length],
      medal: isYou ? wornEdition() : row.name ? holderEdition(row.name) : null,
    };
  });

  const you = members.find((m) => m.isYou);
  const totalTiq = members.reduce((sum, m) => sum + m.tiq, 0);
  const avgTiq = members.length ? Math.round(totalTiq / members.length) : 0;
  const yourRole: SquadRole = you?.role ?? (squad.owned ? 'leader' : 'member');

  return {
    members,
    count: members.length,
    avgTiq,
    totalTiq,
    yourRank: you?.rank ?? 0,
    yourTiq,
    yourRole,
    yourMedal: you?.medal ?? wornEdition(),
    youName: you?.name || myName(),
    yourArena: arenaStandingOf(yourTiq),
    squadArena: arenaStandingOf(avgTiq),
    subscribers: Math.max(0, Math.floor(squad.subscribers ?? 0)),
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
