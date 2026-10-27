/**
 * data/index.ts — seeded mock API behind a small async surface.
 *
 * Everything here is local preview data: no network, no dependency. Each getter
 * awaits a short delay so skeletons and empty states can be exercised like a
 * real fetch. Timestamps are relative to `Date.now()` so countdowns stay live.
 */

export type Trend = 'up' | 'down' | 'same';

/** One step of the Channel Cup payout: a place in the #1 channel's Top 10. */
export interface CupPrize {
  place: number;
  metal: 'gold' | 'silver' | 'bronze' | null;
  stars: number;
}

/**
 * The one tournament the Arena stages: the 200 Telegram Stars Cup.
 *
 * There is no cup feed here on purpose — a single championship is the whole
 * screen, so the shape carries exactly what the showcase renders: the pool, the
 * paid places, the two format pills and the seat count. `startsAt` is ms epoch
 * and anchored to `Date.now()`, so the countdown stays live.
 */
export interface GrandCup {
  id: string;
  name: string;
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
 * The channel whose roster the Arena opens: the squad's own handle plus the
 * squad TIQ the Guilds ladder already quotes, so the two screens can never
 * disagree about who leads the championship.
 */
export interface ChannelSeed {
  id: string;
  handle: string;
  name: string;
  tiq: number;
}

/** The local player, merged into the roster of the squad or nation they belong to. */
export interface RosterYou {
  name: string;
  countryCode: string;
  tiq: number;
  /** The real win count when the caller has it; derived from TIQ otherwise. */
  wins?: number;
}

/**
 * One contributor inside a channel roster.
 *
 * `stars` is the payout that place projects to — the pool only ever funds the
 * Top 10, so a row ranked below the ladder pays nothing rather than a made-up
 * number.
 */
export interface RosterRow {
  rank: number;
  name: string;
  countryCode: string;
  /** TIQ this member banked for the channel. */
  tiq: number;
  stars: number;
  isYou: boolean;
}

export interface CountryRow {
  code: string;
  name: string;
  points: number;
  trend: Trend;
  rank: number;
}

/**
 * One contributor inside a nation's roster. The nation aggregate has no real
 * per-player feed yet, so these rows are seeded around the country's own TIQ;
 * the ladder's real players are folded in where the seed has one.
 */
export interface NationMember {
  rank: number;
  id: string;
  name: string;
  tiq: number;
  wins: number;
  isYou: boolean;
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

/**
 * The whole vault, spread over the Top 10 contributors of the #1 channel.
 * 45+30+22+19+17+16+15+14+12+10 is exactly the 200 Stars the cup promises, so
 * "Top 10 Paid" is arithmetic and not marketing.
 */
const GRAND_CUP_PRIZES: CupPrize[] = [
  { place: 1, metal: 'gold', stars: 45 },
  { place: 2, metal: 'silver', stars: 30 },
  { place: 3, metal: 'bronze', stars: 22 },
  { place: 4, metal: null, stars: 19 },
  { place: 5, metal: null, stars: 17 },
  { place: 6, metal: null, stars: 16 },
  { place: 7, metal: null, stars: 15 },
  { place: 8, metal: null, stars: 14 },
  { place: 9, metal: null, stars: 12 },
  { place: 10, metal: null, stars: 10 },
];

/** How many places a cup pays. The spec pill quotes it, so the copy can never
 *  promise a payout the prize ladder does not fund. */
export const paidPlaces = (c: { prizes: CupPrize[] }): number =>
  c.prizes.filter((p) => p.stars > 0).length;

function grandCupSeed(): GrandCup {
  const t = now();
  return {
    id: 'cup-200-stars',
    name: '200 Stars Cup',
    stars: 200,
    prizes: GRAND_CUP_PRIZES.map((p) => ({ ...p })),
    specs: ['Channels', '8s Blitz'],
    players: 184,
    maxPlayers: 256,
    // 01:45:20 on the first paint; the controller ticks it down from here.
    startsAt: t + 1 * HOUR + 45 * MINUTE + 20_000,
    entry: 'Free entry',
  };
}

function seeding(): { cup: GrandCup; countries: CountryRow[]; teams: TeamRow[] } {
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
  const teams: TeamRow[] = [
    { id: 'seed-0', name: 'Night Circuits', code: 'NIGHT', points: 5210, members: 5, trend: 'up', rank: 1 },
    { id: 'seed-1', name: 'Violet Rampart', code: 'VIOL1', points: 4870, members: 4, trend: 'down', rank: 2 },
    { id: 'seed-2', name: 'Bend Line', code: 'BEND2', points: 4310, members: 3, trend: 'up', rank: 3 },
    { id: 'seed-3', name: 'Checkpoint Twelve', code: 'CHK12', points: 3960, members: 3, trend: 'same', rank: 4 },
    { id: 'seed-4', name: 'Open Road', code: 'OPEN3', points: 3120, members: 2, trend: 'up', rank: 5 },
  ];
  return { cup, countries, teams };
}

/** The championship behind the Arena screen. One cup, staged in full. */
export async function getGrandCup(): Promise<GrandCup> {
  await sleep(LATENCY);
  const cup = seeding().cup;
  return { ...cup, prizes: cup.prizes.map((p) => ({ ...p })), specs: [...cup.specs] };
}

/* ---------- channel rosters ----------
   The Arena ranks channels, but a channel is only ever as loud as the ten
   contributors that carry it. Their TIQ is a fixed slice of the squad's own
   total, so a roster can never quote a top mind that outweighs the ladder it
   came from, and the payout column is the cup's prize ladder read in order. */

/** Share of the squad TIQ held by each of the top ten contributors. */
const ROSTER_SHARE = [.14, .11, .092, .078, .066, .056, .048, .041, .035, .03];

/** Name + nation pool. Purely cosmetic — the TIQ is always derived from the squad. */
const ROSTER_MINDS: ReadonlyArray<readonly [string, string]> = [
  ['Viktor', 'UA'], ['Lena', 'DE'], ['Mateo', 'ES'], ['Aiko', 'JP'],
  ['Zara', 'SA'], ['Diego', 'BR'], ['Nina', 'PL'], ['Omar', 'EG'],
  ['Yuki', 'JP'], ['Ivan', 'KZ'], ['Sara', 'IR'], ['Kwame', 'GH'],
  ['Elif', 'TR'], ['Pavel', 'CZ'], ['Mei', 'CN'], ['Tariq', 'PK'],
  ['Anouk', 'NL'], ['Ravi', 'IN'], ['Chloe', 'FR'], ['Bilal', 'MA'],
  ['Hana', 'KR'], ['Nour', 'MA'], ['Marco', 'IT'], ['Dana', 'IL'],
];

/** FNV-1a. A channel's roster is stable across taps, reloads and repaints. */
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * The stable head-count behind a nation's aggregate. One function feeds both the
 * "N players" label under a country row and the roster sheet, so the count and
 * the rows painted can never disagree. Only real rosters from the backend should
 * replace this; until then the split targets 280-379 TIQ per player, which keeps
 * every seeded nation between 20 and 50 contributors.
 */
export function nationPlayersOf(code: string, points: number): number {
  const target = 280 + (hash32(code) % 100);
  return Math.max(20, Math.min(50, Math.round(points / target)));
}

/** National name pool; the seed is the country code, so a roster never re-rolls. */
const NATION_FIRSTS = [
  'Aarav', 'Elif', 'Mateo', 'Lena', 'Kwame', 'Yuki', 'Noor', 'Diego', 'Mira', 'Tomas',
  'Aiko', 'Omar', 'Anouk', 'Ravi', 'Zara', 'Felix', 'Ines', 'Pavel', 'Sana', 'Theo',
  'Mila', 'Hugo', 'Leila', 'Jonas', 'Imani', 'Ivan', 'Amara', 'Nina', 'Marco', 'Freya',
  'Arjun', 'Dana', 'Bilal', 'Chloe', 'Rafael', 'Mei', 'Nils', 'Alba', 'Tariq', 'Ida',
] as const;

const NATION_LASTS = [
  'Okafor', 'Weber', 'Silva', 'Tanaka', 'Sharma', 'Haddad', 'Novak', 'Kim', 'Rossi', 'Moreau',
  'Kowalski', 'Patel', 'Mensah', 'Sato', 'Cruz', 'Visser', 'Demir', 'Duarte', 'Park', 'Ali',
] as const;

const NATION_COMBOS = NATION_FIRSTS.length * NATION_LASTS.length;

function nationName(seed: number, index: number): string {
  const k = (seed + index * 131) % NATION_COMBOS;
  return `${NATION_FIRSTS[k % NATION_FIRSTS.length]} ${NATION_LASTS[Math.floor(k / NATION_FIRSTS.length)]}`;
}

/**
 * A descending TIQ curve across `count` players whose sum is the nation points
 * not already held by real ladder names. A Zipf-shaped field gives a national
 * ladder its real cliff — the top player is roughly a quarter of the aggregate,
 * the next half of that, then a long tail — instead of a flat roster whose top
 * score cannot compete with the real names on the ladder.
 */
function splitNationTiq(code: string, total: number, count: number): number[] {
  if (count <= 0) return [];
  const weights: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const shape = 1 / Math.pow(i + 1, 1.1);
    const jitter = 0.97 + ((hash32(`${code}|tiq|${i}`) % 1000) / 1000) * 0.06;
    const w = shape * jitter;
    weights.push(w);
    sum += w;
  }
  const rows = weights.map((w) => Math.max(40, Math.round((Math.max(0, total) * w) / sum)));
  let rest = Math.max(0, total) - rows.reduce((a, b) => a + b, 0);
  for (let i = 0; rest > 0 && i < rows.length * 4; i = (i + 1) % rows.length, rest--) rows[i] += 1;
  for (let i = rows.length - 1; rest < 0 && i >= 0; i--) {
    if (rows[i] > 40) { rows[i] -= 1; rest += 1; }
  }
  return rows;
}

/**
 * The contributors behind one channel, ranked by TIQ.
 *
 * Ten rows is what the sheet shows, but the local player is merged in at their
 * real personal TIQ and the full list comes back — a squad member sitting at
 * #11 has to be able to see that they are outside the paid ten, not be dropped
 * from the feed and left with a rank nobody computed.
 */
export async function getChannelRoster(ch: ChannelSeed, you: RosterYou | null = null): Promise<RosterRow[]> {
  await sleep(LATENCY);
  const h = hash32(ch.id);
  const rows = ROSTER_SHARE.map((share, i): RosterRow => {
    const [name, countryCode] = ROSTER_MINDS[(h + i * 7) % ROSTER_MINDS.length];
    return {
      rank: 0, name, countryCode,
      tiq: Math.max(1, Math.round(ch.tiq * share)),
      stars: 0, isYou: false,
    };
  });
  if (you) {
    rows.push({
      rank: 0, name: you.name, countryCode: you.countryCode,
      tiq: Math.max(0, Math.round(you.tiq)), stars: 0, isYou: true,
    });
  }
  rows.sort((a, b) => b.tiq - a.tiq || Number(b.isYou) - Number(a.isYou));
  return rows.map((r, i): RosterRow => ({ ...r, rank: i + 1, stars: GRAND_CUP_PRIZES[i]?.stars ?? 0 }));
}

/**
 * The top players behind one nation: a stable split of the nation's aggregate, with the local
 * player joined at their own TIQ when the country is theirs and always kept inside the quoted
 * count. The real player registry lives on the Worker; this national board has no per-player
 * feed yet, so it never dresses another screen's seed up as a real head.
 */
export async function getNationRoster(country: CountryRow, you: RosterYou | null = null): Promise<NationMember[]> {
  await sleep(240);
  const count = nationPlayersOf(country.code, country.points);
  const mine = you && you.countryCode === country.code ? you : null;
  const mineKey = mine?.name.trim().toLowerCase() ?? '';
  const tiqs = splitNationTiq(country.code, country.points, count);
  const seed = hash32(country.code);
  const taken = new Set<string>();
  if (mineKey) taken.add(mineKey);

  const rows: NationMember[] = [];
  for (let i = 0; i < count; i++) {
    let name = nationName(seed, i);
    for (let lap = 2; taken.has(name.toLowerCase()); lap++) name = `${nationName(seed, i)} ${lap}`;
    taken.add(name.toLowerCase());
    const tiq = tiqs[i] ?? 0;
    rows.push({
      rank: 0,
      id: `n-${country.code.toLowerCase()}-${i}`,
      name,
      tiq,
      wins: Math.max(1, Math.round(tiq / 145)),
      isYou: false,
    });
  }

  if (mine) {
    rows.push({
      rank: 0,
      id: `n-${country.code.toLowerCase()}-you`,
      name: mine.name,
      tiq: Math.max(0, Math.round(mine.tiq)),
      wins: mine.wins ?? Math.max(0, Math.round(mine.tiq / 145)),
      isYou: true,
    });
  }

  rows.sort((a, b) => b.tiq - a.tiq || a.name.localeCompare(b.name));
  const kept = rows.slice(0, count);
  if (mine && !kept.some((r) => r.isYou)) {
    kept[kept.length - 1] = rows.find((r) => r.isYou) ?? kept[kept.length - 1];
  }
  kept.forEach((r, i) => { r.rank = i + 1; });
  return kept;
}

export async function getCountryRanking(): Promise<CountryRow[]> {
  await sleep(LATENCY);
  return seeding().countries.map((c) => ({ ...c }));
}

export async function getTopCountries(limit = 5): Promise<CountryRow[]> {
  const all = await getCountryRanking();
  return all.slice(0, limit);
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
