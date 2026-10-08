/**
 * teams.ts — team data and the local mock that stands in for the real thing.
 *
 * There is no server yet, so a team is a record in this device's save. What is *not* mock is the
 * shape: `code` is what a player types today, and `startParam` is exactly what a Telegram group link
 * will carry (`t.me/<bot>/detour?startapp=<startParam>`) once teams bind to a chat — `chatId` is the
 * slot the group's id goes into. `seed` teams are demo clubs you can join to see the flow; they are
 * painted as such, so nothing here pretends to be a roster that exists somewhere else.
 */

export interface TeamMember {
  /** `you` for this device's player; a telegram user id for a real one. */
  id: string;
  name: string;
  captain: boolean;
  wins: number;
  games: number;
}

export interface Team {
  id: string;
  name: string;
  /** 5-character join code, uppercase, typed in the team sheet. */
  code: string;
  /** the deep link value for a future "open the team group" affordance */
  startParam: string;
  /** reserved: the Telegram supergroup this team will one day be */
  chatId: string | null;
  seed: boolean;
  members: TeamMember[];
}

export const YOU = 'you';
const MAX_NAME = 20;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const member = (id: string, name: string, wins: number, games: number, captain = false): TeamMember =>
  ({ id, name, captain, wins, games });

export const cleanName = (raw: string): string => raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

export const cleanCode = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

function codeFor(name: string, taken: Set<string>): string {
  const letters = (name.toUpperCase().replace(/[^A-Z]/g, '') + 'XXXXX').slice(0, 4);
  for (let tries = 0; tries < 24; tries++) {
    let tail = '';
    for (let i = 0; i < 5 - letters.length; i++) tail += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    const code = letters + tail;
    if (!taken.has(code)) return code;
  }
  return '';
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 18);

/** A new team, owned by the player who made it. */
export function makeTeam(name: string, you: string, taken: Set<string>): Team | null {
  const code = codeFor(name, taken);
  if (!code) return null;
  return {
    id: `t-${Date.now().toString(36)}-${code}`,
    name,
    code,
    startParam: `team-${code.toLowerCase()}`,
    chatId: null,
    seed: false,
    members: [member(YOU, you, 0, 0, true)],
  };
}

/**
 * The clubs that exist before anyone creates one, so "join a team" has something to join and the
 * standings have something to rank.
 */
export function seedTeams(): Team[] {
  const rows: [string, string, TeamMember[]][] = [
    ['Night Circuits', 'NIGHT', [
      member('u1', 'Amara', 34, 51, true), member('u2', 'Tobias', 28, 44), member('u3', 'Kenji', 19, 31),
      member('u4', 'Lina', 15, 27), member('u5', 'Marco', 9, 22),
    ]],
    ['Violet Rampart', 'VIOL1', [
      member('u6', 'Sofia', 31, 47, true), member('u7', 'Daniil', 24, 40), member('u8', 'Noor', 21, 35),
      member('u9', 'Yusuf', 12, 24),
    ]],
    ['Bend Line', 'BEND2', [
      member('u10', 'Priya', 26, 43, true), member('u11', 'Owen', 23, 38), member('u12', 'Fatima', 14, 29),
    ]],
    ['Checkpoint Twelve', 'CHK12', [
      member('u13', 'Lucas', 22, 39, true), member('u14', 'Hana', 17, 33), member('u15', 'Ivan', 8, 19),
    ]],
    ['Open Road', 'OPEN3', [
      member('u16', 'Zara', 15, 28, true), member('u17', 'Felix', 11, 25),
    ]],
  ];
  return rows.map(([name, code, ms], i) => ({
    id: `seed-${i}`, name, code, startParam: `team-${slug(name)}`, chatId: null, seed: true, members: ms,
  }));
}

export const inTeam = (t: Team) => t.members.some((m) => m.id === YOU);

export function addMember(t: Team, you: string): Team {
  if (inTeam(t)) return t;
  return { ...t, members: [...t.members, member(YOU, you, 0, 0)] };
}

export function dropMember(t: Team): Team {
  const left = t.members.filter((m) => m.id !== YOU);
  // the seed clubs stay whole; your own team dissolves when you walk out of it
  const promote = left.length && !left.some((m) => m.captain)
    ? left.map((m, i) => (i === 0 ? { ...m, captain: true } : m))
    : left;
  return { ...t, members: promote };
}

export interface Standing { rank: number; team: Team; wins: number; games: number; size: number }

/** Wins across the roster, ranked — the number a real team leaderboard will one day compute. */
export function standings(teams: Team[]): Standing[] {
  const rows = teams.map((team) => ({
    team,
    wins: team.members.reduce((n, m) => n + m.wins, 0),
    games: team.members.reduce((n, m) => n + m.games, 0),
    size: team.members.length,
  }));
  rows.sort((a, b) => b.wins - a.wins || b.size - a.size || a.team.name.localeCompare(b.team.name));
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}
