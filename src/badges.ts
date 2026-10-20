/**
 * badges.ts — the Genius Triad: three prestige honors, one per player archetype.
 *
 * The catalogue is static and the unlock state is derived from the live save, so
 * a half-written localStorage blob can never smuggle a badge in. Only the
 * equipped badge id persists (profile.badge under detour.save.v2) — the same
 * single-key contract storage.ts already owns.
 *
 * Each archetype answers to a different proof:
 * - Churchill's Bastion  — Resilience: a 3-win streak, holding the line.
 * - Einstein's Singularity — Pure Intellect: the 1,500 TIQ threshold.
 * - Heisenberg's Formula — Calculated Precision: a 60% win rate over 5+ races.
 *
 * Ids are stable; the crest symbol and the CSS aura are both keyed by `accent`,
 * so a badge is one data row plus one #i-crest-<accent> in index.html.
 */

import { profile } from './storage';
import { myTiq } from './matchmaking';

export type BadgeAccent = 'titanium' | 'quantum' | 'frost';

export interface BadgeDef {
  id: string;
  name: string;
  /** The shortened archetype name printed on the shelf tile. */
  archetype: string;
  /** The psychological pillar the archetype represents. */
  pillar: string;
  /** One sentence of archetype copy, used by the pin spotlight and detail sheet. */
  description: string;
  /** Flavor — the legend the detail sheet prints under the title. */
  lore: string;
  /** The unlock requirement in player-facing words. */
  criteria: string;
  /** Names the sculpted crest (#i-crest-<accent>) and its CSS aura. */
  accent: BadgeAccent;
  /** The metal + aura palette, as metadata and as sheet copy. */
  palette: string;
}

export const GENIUS_TRIAD: readonly BadgeDef[] = [
  {
    id: 'churchill_bastion',
    name: "Churchill's Bastion",
    archetype: 'The Ironclad',
    pillar: 'Resilience',
    description: 'Unyielding defence and comeback mastery. Holds the line until the board breaks.',
    lore: 'Never surrender. The wall is not a tactic; it is a promise.',
    criteria: 'Reach a 3-win streak. High-resilience runs and clutch comebacks forge the Bastion.',
    accent: 'titanium',
    palette: 'Brushed Titanium #94A3B8 · Deep Cyan #06B6D4',
  },
  {
    id: 'einstein_singularity',
    name: "Einstein's Singularity",
    archetype: 'The Mastermind',
    pillar: 'Pure Intellect',
    description: 'Spatial foresight and zero-error calculation. Sees the whole board before the first move.',
    lore: 'The board is not a race. It is a proof.',
    criteria: 'Bank 1,500 Tactical IQ. Pure calculation bends the board into a single answer.',
    accent: 'quantum',
    palette: 'Deep Obsidian · Quantum Gold #F59E0B / #FDE047',
  },
  {
    id: 'heisenberg_formula',
    name: "Heisenberg's Formula",
    archetype: 'The Strategist',
    pillar: 'Calculated Precision',
    description: 'Flawless tactical execution and cold dominance. Wins before the race begins.',
    lore: 'No wasted moves. No luck. Only the formula.',
    criteria: 'Win 60% of at least 5 races. Ruthless precision, never chance.',
    accent: 'frost',
    palette: 'Cold Slate #334155 · Frost Emerald #10B981 / Cyan #38BDF8',
  },
];

/** Back-compat alias: the catalogue is the triad. */
export const BADGES = GENIUS_TRIAD;

export const badgeById = (id: string | null | undefined): BadgeDef | null =>
  BADGES.find((b) => b.id === id) ?? null;

const en = (n: number) => n.toLocaleString('en-US');

export interface BadgeProgress {
  got: number;
  need: number;
  /** 0..1, ready for meters and aria-valuenow ratios. */
  pct: number;
  /** The requirement's own unit, e.g. "2/3 win streak" or "62% win rate". */
  label: string;
  met: boolean;
}

/** Live progress against a badge's requirement — the same read the shelf and sheet use. */
export function badgeProgress(id: string): BadgeProgress {
  const s = profile.stats;
  switch (id) {
    case 'churchill_bastion': {
      const got = Math.min(Math.max(0, s.best), 3);
      return { got, need: 3, pct: got / 3, label: `${got}/3 win streak`, met: got >= 3 };
    }
    case 'einstein_singularity': {
      const need = 1500;
      const got = Math.max(0, myTiq());
      return {
        got,
        need,
        pct: Math.min(1, got / need),
        label: `${en(got)} / ${en(need)} TIQ`,
        met: got >= need,
      };
    }
    case 'heisenberg_formula': {
      if (s.games < 5) {
        const got = Math.min(Math.max(0, s.games), 5);
        return { got, need: 5, pct: got / 5, label: `${got}/5 races`, met: false };
      }
      const rate = Math.round((s.wins / s.games) * 100);
      return {
        got: rate,
        need: 60,
        pct: Math.min(1, rate / 60),
        label: `${rate}% / 60% wins`,
        met: rate >= 60,
      };
    }
    default:
      return { got: 0, need: 1, pct: 0, label: 'Locked', met: false };
  }
}

export function isBadgeUnlocked(id: string): boolean {
  return badgeById(id) !== null && badgeProgress(id).met;
}

export function unlockedCount(): number {
  return BADGES.filter((b) => isBadgeUnlocked(b.id)).length;
}

export function equippedBadge(): BadgeDef | null {
  if (!profile.badge) return null;
  const def = badgeById(profile.badge);
  if (!def) return null;
  return isBadgeUnlocked(def.id) ? def : null;
}
