/**
 * shared/nations.ts — the national ladder's arithmetic, shared by the Worker and the client.
 *
 * One sample rule and one divisor. A flag is carried by its best ten rated warriors, and the
 * divisor is always the number of warriors actually inside that sample — never a static floor,
 * never the whole enrolled roster. A nation carried by a single warrior is therefore quoted at
 * that warrior's own TIQ; it is not halved for being small, and it is not diluted by rookies
 * who have not scored yet.
 *
 * There is deliberately no founding roster, baseline array or fallback country here. The only
 * rows that exist on the board are flags the Worker folded from real, active registry seats.
 * A quiet database is an honest short list — one or two nations render as one or two rows.
 */

/** The representative sample: a flag is carried by its best ten warriors, not its whole roster. */
export const NATION_TOP_SAMPLE = 10;

/**
 * The mean of a flag's best `NATION_TOP_SAMPLE` scores.
 *
 * `count` is the size of the sample that was actually taken — so a one-warrior nation divides
 * by one and keeps its full rating. An empty sample has no average to quote and returns 0.
 */
export function representativeAverage(scores: readonly number[]): number {
  const count = Math.min(scores.length, NATION_TOP_SAMPLE);
  if (count <= 0) return 0;
  const top = [...scores].sort((a, b) => b - a).slice(0, count);
  let total = 0;
  for (const score of top) total += Math.max(0, score);
  return Math.round(total / count);
}
