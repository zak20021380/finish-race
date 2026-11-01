/**
 * telemetry.ts — the vocabulary shared by the match client, the Command Center and the Worker.
 *
 * A match is always one of three kinds: a local practice board against the machine, a live race
 * between people, or a tournament-cup race entered from the Arena. The tags travel on the wire in
 * both directions — a client report stamps them, and the metrics route filters by them — so the
 * three sides read the same three words.
 */

/** The match kinds the analytics dashboard can slice. */
export type MatchMode = 'bot' | 'pvp' | 'arena';

/** A query/UI slice: one match kind, or every kind together. */
export type MatchModeFilter = 'all' | MatchMode;

/** One match fields between two and four seats, however many the machine holds. */
export type PlayerCount = 2 | 3 | 4;

export const MATCH_MODES: readonly MatchMode[] = ['bot', 'pvp', 'arena'];

/** A stored or queried tag, or null when it is not one of the three modes. */
export function matchModeOf(value: unknown): MatchMode | null {
  return value === 'bot' || value === 'pvp' || value === 'arena' ? value : null;
}

/** The metrics query's slice: an unknown or absent tag is the aggregate reading. */
export function matchModeFilterOf(value: unknown): MatchModeFilter {
  return matchModeOf(value) ?? 'all';
}

/** A seat count clamped to a board the rules can actually start. */
export function playerCountOf(value: unknown): PlayerCount {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 2;
  return (n >= 2 && n <= 4 ? n : 2) as PlayerCount;
}

/** A whole duration the room can honestly bucket; anything longer than a day is not a match. */
export function durationSeconds(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.max(0, Math.min(86_400, n));
}

/** The dashboard's copy for each slice. */
export const MATCH_MODE_LABEL: Record<MatchModeFilter, string> = {
  all: 'All modes',
  bot: 'VS Bot',
  pvp: 'PvP',
  arena: 'Arena',
};
