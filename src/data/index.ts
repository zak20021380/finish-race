/**
 * data/index.ts — seeded mock API behind a small async surface.
 *
 * Everything here is local preview data: no network, no dependency. Each getter
 * awaits a short delay so skeletons and empty states can be exercised like a
 * real fetch. Timestamps are relative to `Date.now()` so countdowns stay live.
 */

export type Trend = 'up' | 'down' | 'same';
export type TourneyStatus = 'live' | 'upcoming' | 'ended';

export interface Tournament {
  id: string;
  name: string;
  status: TourneyStatus;
  prizePool: number;
  entryFee: number;
  /** ms epoch when a live tourney ends or an upcoming one starts */
  endsAt: number;
  players: number;
  maxPlayers: number;
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

const HOUR = 3600_000;
const now = (): number => Date.now();

function seeding(): { tournaments: Tournament[]; countries: CountryRow[]; players: PlayerRow[]; teams: TeamRow[] } {
  const t = now();
  const tournaments: Tournament[] = [
    { id: 't-neon', name: 'Neon Rush Cup', status: 'live', prizePool: 5000, entryFee: 120, endsAt: t + 2 * HOUR + 14 * 60_000, players: 184, maxPlayers: 256 },
    { id: 't-violet', name: 'Violet Rampart Open', status: 'upcoming', prizePool: 2500, entryFee: 60, endsAt: t + 26 * HOUR, players: 96, maxPlayers: 128 },
    { id: 't-midnight', name: 'Midnight Circuit', status: 'upcoming', prizePool: 1200, entryFee: 30, endsAt: t + 3 * 24 * HOUR + 5 * HOUR, players: 41, maxPlayers: 64 },
    { id: 't-dawn', name: 'Dawn Sprint', status: 'ended', prizePool: 800, entryFee: 0, endsAt: t - 5 * HOUR, players: 64, maxPlayers: 64 },
  ];
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
  return { tournaments, countries, players, teams };
}

export async function getTournaments(): Promise<Tournament[]> {
  await sleep(LATENCY);
  return seeding().tournaments.map((t) => ({ ...t }));
}

export async function getFeaturedTournament(): Promise<Tournament> {
  await sleep(LATENCY);
  const all = seeding().tournaments;
  return { ...(all.find((t) => t.status === 'live') ?? all[0]) };
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
