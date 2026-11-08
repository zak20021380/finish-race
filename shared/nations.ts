/**
 * shared/nations.ts — the national ladder's arithmetic, shared by the Worker and the client.
 *
 * One sample rule and one divisor. A flag is carried by its best ten rated warriors, and the
 * divisor is always the number of warriors actually inside that sample — never a static floor,
 * never the whole enrolled roster. A nation carried by a single warrior is therefore quoted at
 * that warrior's own TIQ; it is not halved for being small, and it is not diluted by rookies
 * who have not scored yet.
 *
 * The baseline is the second half of the contract: a flag with no rated warrior is still a
 * flag. The founding nations below are painted underneath the live board so the cup never
 * collapses to one solitary country while the registry is warming up. They are strictly a
 * floor — a baseline row always ranks below every real row that carries a score, so a seeded
 * flag can never hold the throne.
 */

/** The representative sample: a flag is carried by its best ten warriors, not its whole roster. */
export const NATION_TOP_SAMPLE = 10;

export interface NationBaseline {
  /** ISO 3166-1 alpha-2. */
  code: string;
  /** The baseline rating: a floor under the live board, never a claim on the podium. */
  base: number;
}

/**
 * The founding roster, in descending baseline order. These values sit below a live elite
 * average on purpose: a real warrior at 3,720 keeps the throne, and a seeded flag only ever
 * fills the space a quiet registry leaves behind.
 */
export const NATION_BASELINE: readonly NationBaseline[] = [
  { code: 'IR', base: 3360 },
  { code: 'GB', base: 3180 },
  { code: 'BR', base: 2960 },
  { code: 'DE', base: 2740 },
  { code: 'FR', base: 2580 },
  { code: 'TR', base: 2410 },
  { code: 'EG', base: 2260 },
  { code: 'SA', base: 2140 },
  { code: 'US', base: 2010 },
  { code: 'ID', base: 1880 },
  { code: 'IN', base: 1740 },
  { code: 'RU', base: 1620 },
  { code: 'MA', base: 1510 },
  { code: 'IQ', base: 1430 },
];

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
