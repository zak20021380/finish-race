/**
 * data/index.ts — seeded mock API behind a small async surface.
 *
 * Everything here is local preview data: no network, no dependency. Each getter
 * awaits a short delay so skeletons and empty states can be exercised like a
 * real fetch. Timestamps are relative to `Date.now()` so countdowns stay live.
 */

export type Trend = 'up' | 'down' | 'same';

/** One step of the Grand Cup podium: a place, its metal and the Stars it pays. */
export interface CupPrize {
  place: 1 | 2 | 3;
  metal: 'gold' | 'silver' | 'bronze';
  stars: number;
}

/**
 * The one tournament the Arena stages: the 200 Telegram Stars Arena.
 *
 * There is no cup feed here on purpose — a single championship is the whole
 * screen, so the shape carries exactly what the showcase renders: the pool, the
 * paid places, the two format pills and the seat count. `startsAt` is ms epoch
 * and anchored to `Date.now()`, so the countdown stays live.
 */
export interface GrandCup {
  id: string;
  name: string;
  /** the one-line hook under the engraved title */
  hook: string;
  /** the whole prize vault, in Telegram Stars */
  stars: number;
  /** exact distribution across the paid places, in place order */
  prizes: CupPrize[];
  /** the format pills — the paid-places pill is derived from `prizes`, so it is never typed here */
  specs: string[];
  players: number;
  maxPlayers: number;
  /** ms epoch the bracket opens */
  startsAt: number;
  /** what a seat costs — the Arena is free to enter */
  entry: string;
}

/**
 * One live contender in the Arena field.
 *
 * The showcase leaderboard needs more than `PlayerRow` carries: a projected
 * payout and a current win streak both belong to a tournament, not to the season
 * ladder, so they are stated here rather than inferred from a win total.
 */
export interface ContenderRow {
  rank: number;
  id: string;
  name: string;
  countryCode: string;
  /** Tactical IQ — the same number the Mind Ladder quotes for this player. */
  tiq: number;
  /** consecutive wins going into the bracket */
  streak: number;
  /** Stars this place projects to pay; 0 once the vault has run out. */
  payout: number;
}

export interface CountryRow {
  code: string;
  name: string;
  points: number;
  trend: Trend;
  rank: number;
}

export interface PlayerRow {
  id: string;
  name: string;
  countryCode: string;
  points: number;
  wins: number;
  trend: Trend;
}

export interface TeamRow {
  id: string;
  name: string;
  code: string;
  points: number;
  members: number;
  trend: Trend;
  rank: number;
}

export interface DailyChallenge {
  title: string;
  detail: string;
  streak: number;
  reward: number;
  /** ms epoch when the challenge resets */
  resetsAt: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const LATENCY = 380;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const now = (): number => Date.now();

/** The paid places are the ones the vault actually funds — 120 + 50 + 30 is all 200 Stars. */
const GRAND_CUP_PRIZES: CupPrize[] = [
  { place: 1, metal: 'gold', stars: 120 },
  { place: 2, metal: 'silver', stars: 50 },
  { place: 3, metal: 'bronze', stars: 30 },
];

/** How many places a cup pays. The spec pill quotes it, so the copy can never
 *  promise a payout the prize ladder does not fund. */
export const paidPlaces = (c: { prizes: CupPrize[] }): number =>
  c.prizes.filter((p) => p.stars > 0).length;

/** Consecutive wins each seeded mind is carrying into the bracket, by player id. */
const STREAKS: Record<string, number> = {
  'u-amara': 6, 'u-sofia': 4, 'u-kenji': 1, 'u-priya': 9,
  'u-lucas': 2, 'u-noor': 0, 'u-owen': 3, 'u-hana': 5,
};

function grandCupSeed(): GrandCup {
  const t = now();
  return {
    id: 'cup-200-stars',
    name: '200 Stars Arena',
    hook: 'Outsmart the grid. Claim real Telegram Stars.',
    stars: 200,
    prizes: GRAND_CUP_PRIZES.map((p) => ({ ...p })),
    specs: ['1v1', '8s Blitz'],
    players: 184,
    maxPlayers: 256,
    // 01:45:20 on the first paint; the controller ticks it down from here.
    startsAt: t + 1 * HOUR + 45 * MINUTE + 20_000,
    entry: 'Free entry',
  };
}

function seeding(): { cup: GrandCup; countries: CountryRow[]; players: PlayerRow[]; teams: TeamRow[] } {
  const cup = grandCupSeed();
  const countries: CountryRow[] = [
    { code: 'US', name: 'United States', points: 12840, trend: 'up', rank: 1 },
    { code: 'BR', name: 'Brazil', points: 11210, trend: 'up', rank: 2 },
    { code: 'JP', name: 'Japan', points: 10480, trend: 'down', rank: 3 },
    { code: 'DE', name: 'Germany', points: 9920, trend: 'same', rank: 4 },
    { code: 'IN', name: 'India', points: 9310, trend: 'up', rank: 5 },
    { code: 'FR', name: 'France', points: 8740, trend: 'down', rank: 6 },
    { code: 'GB', name: 'United Kingdom', points: 8120, trend: 'same', rank: 7 },
    { code: 'UA', name: 'Ukraine', points: 7650, trend: 'up', rank: 8 },
    { code: 'TR', name: 'Turkey', points: 7210, trend: 'down', rank: 9 },
    { code: 'ES', name: 'Spain', points: 6980, trend: 'same', rank: 10 },
  ];
  const players: PlayerRow[] = [
    { id: 'u-amara', name: 'Amara', countryCode: 'NG', points: 3420, wins: 34, trend: 'up' },
    { id: 'u-sofia', name: 'Sofia', countryCode: 'ES', points: 3180, wins: 31, trend: 'up' },
    { id: 'u-kenji', name: 'Kenji', countryCode: 'JP', points: 3050, wins: 29, trend: 'down' },
    { id: 'u-priya', name: 'Priya', countryCode: 'IN', points: 2910, wins: 26, trend: 'up' },
    { id: 'u-lucas', name: 'Lucas', countryCode: 'BR', points: 2740, wins: 22, trend: 'same' },
    { id: 'u-noor', name: 'Noor', countryCode: 'SA', points: 2610, wins: 21, trend: 'down' },
    { id: 'u-owen', name: 'Owen', countryCode: 'US', points: 2480, wins: 23, trend: 'same' },
    { id: 'u-hana', name: 'Hana', countryCode: 'KR', points: 2330, wins: 17, trend: 'up' },
  ];
  const teams: TeamRow[] = [
    { id: 'seed-0', name: 'Night Circuits', code: 'NIGHT', points: 5210, members: 5, trend: 'up', rank: 1 },
    { id: 'seed-1', name: 'Violet Rampart', code: 'VIOL1', points: 4870, members: 4, trend: 'down', rank: 2 },
    { id: 'seed-2', name: 'Bend Line', code: 'BEND2', points: 4310, members: 3, trend: 'up', rank: 3 },
    { id: 'seed-3', name: 'Checkpoint Twelve', code: 'CHK12', points: 3960, members: 3, trend: 'same', rank: 4 },
    { id: 'seed-4', name: 'Open Road', code: 'OPEN3', points: 3120, members: 2, trend: 'up', rank: 5 },
  ];
  return { cup, countries, players, teams };
}

/** The championship behind the Arena screen. One cup, staged in full. */
export async function getGrandCup(): Promise<GrandCup> {
  await sleep(LATENCY);
  const cup = seeding().cup;
  return { ...cup, prizes: cup.prizes.map((p) => ({ ...p })), specs: [...cup.specs] };
}

/**
 * The live head of the Arena field, in bracket order.
 *
 * Ranks come off the same seeded minds the ladder quotes, so the two screens can
 * never disagree about who is ahead; the payout is read straight out of the cup's
 * own prize ladder, which is why a fourth-place row pays nothing rather than a
 * made-up number.
 */
export async function getArenaStandings(cup: GrandCup, limit = 5): Promise<ContenderRow[]> {
  await sleep(LATENCY);
  const field = [...seeding().players].sort((a, b) => b.points - a.points).slice(0, limit);
  return field.map((p, i): ContenderRow => ({
    rank: i + 1,
    id: p.id,
    name: p.name,
    countryCode: p.countryCode,
    tiq: p.points,
    streak: STREAKS[p.id] ?? 0,
    payout: cup.prizes.find((z) => z.place === i + 1)?.stars ?? 0,
  }));
}

export async function getCountryRanking(): Promise<CountryRow[]> {
  await sleep(LATENCY);
  return seeding().countries.map((c) => ({ ...c }));
}

export async function getTopCountries(limit = 5): Promise<CountryRow[]> {
  const all = await getCountryRanking();
  return all.slice(0, limit);
}

export async function getPlayerRanking(): Promise<PlayerRow[]> {
  await sleep(LATENCY);
  return seeding().players.map((p) => ({ ...p }));
}

export async function getTeamRanking(): Promise<TeamRow[]> {
  await sleep(LATENCY);
  return seeding().teams.map((t) => ({ ...t }));
}

export async function getDailyChallenge(streak: number): Promise<DailyChallenge> {
  await sleep(240);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return {
    title: 'Daily Challenge',
    detail: 'Win 2 bot races today',
    streak,
    reward: 150,
    resetsAt: end.getTime(),
  };
}

/** "02:14:33" under a day, "2d 4h" above it, "—" when finished. Pure, so tests stay trivial. */
export function formatCountdown(endsAt: number, from: number = Date.now()): string {
  const ms = endsAt - from;
  if (ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

export const trendArrow = (t: Trend): string => (t === 'up' ? '▲' : t === 'down' ? '▼' : '•');
