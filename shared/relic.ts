/**
 * relic.ts — the one shelter clock both the client and the Worker read.
 *
 * The shield is derived, never stored: folding the honor's id and its serial into one hash gives
 * every device — and the matchmaker — the same verdict for serial #042 at the same instant. A
 * random per-device shield would let the same relic read as guarded to its holder and exposed to
 * a challenger, which is exactly the disagreement a challenge protocol cannot afford.
 */

const HOUR = 3_600_000;
/** One shelter cycle: a relic stands guarded for its own length, then exposed until the cycle turns. */
export const RELIC_SHELTER_CYCLE_MS = 72 * HOUR;

export interface RelicShelter {
  /** True while the holder is still under the shield — the relic cannot be called out. */
  sheltered: boolean;
  /** Whole hours left on the shield, rounded up; 0 once exposed. */
  hoursLeft: number;
}

/** FNV-1a over the honor and its serial — the same relic must never disagree with itself. */
function shelterSeed(seed: string, salt = ''): number {
  const text = `${seed}${salt}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function relicShelter(badgeId: string, serial: number, now = Date.now()): RelicShelter {
  const relic = `${badgeId}|${serial}`;
  const seed = shelterSeed(relic);
  /* the length comes off this hash and the phase off a second one over the same relic: folding both
     out of one 32-bit value would cap the phase at a fraction of the cycle, and every serial would
     land exposed (or guarded) at the same time of day rather than spreading across the clock */
  const length = (18 + (seed % 30)) * HOUR;
  const phase = shelterSeed(relic, 'phase') % RELIC_SHELTER_CYCLE_MS;
  const rel = (((now % RELIC_SHELTER_CYCLE_MS) - phase) % RELIC_SHELTER_CYCLE_MS + RELIC_SHELTER_CYCLE_MS)
    % RELIC_SHELTER_CYCLE_MS;
  return rel < length
    ? { sheltered: true, hoursLeft: Math.max(1, Math.ceil((length - rel) / HOUR)) }
    : { sheltered: false, hoursLeft: 0 };
}
