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

export interface PlayerRow {
  id: string;
  name: string;
  countryCode: string;
  points: number;
  wins: number;
  trend: Trend;
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

/** The championship behind the Arena screen. One cup, staged in full. */
export async function getGrandCup(): Promise<GrandCup> {
  await sleep(LATENCY);
  const cup = grandCupSeed();
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
