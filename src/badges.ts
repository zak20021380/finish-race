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
 * Each honor is also a numbered edition. The cap is fixed; the claimed ledger is
 * the sealed launch figure this build ships with, and this device mints the next
 * serial the moment the requirement is met. Without a mint server, the serial is
 * derived from the catalogue rather than assigned by a network, so it stays
 * stable across reloads and never needs a second storage key.
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
  /** The character the medal carries: the card's first line. */
  figure: string;
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
  /** Hard edition cap. The serial is minted inside this number, never above it. */
  cap: number;
}

export const GENIUS_TRIAD: readonly BadgeDef[] = [
  {
    id: 'churchill_bastion',
    name: "Churchill's Bastion",
    figure: 'Churchill',
    archetype: 'The Bastion',
    pillar: 'Resilience',
    description: 'Unyielding defence and comeback mastery. Holds the line until the board breaks.',
    lore: 'Never surrender. The wall is not a tactic; it is a promise.',
    criteria: 'Reach a 3-win streak. High-resilience runs and clutch comebacks forge the Bastion.',
    accent: 'titanium',
    palette: 'Brushed Titanium #94A3B8 · Deep Cyan #06B6D4',
    cap: 100,
  },
  {
    id: 'einstein_singularity',
    name: "Einstein's Singularity",
    figure: 'Einstein',
    archetype: 'The Singularity',
    pillar: 'Pure Intellect',
    description: 'Spatial foresight and zero-error calculation. Sees the whole board before the first move.',
    lore: 'The board is not a race. It is a proof.',
    criteria: 'Bank 1,500 Tactical IQ. Pure calculation bends the board into a single answer.',
    accent: 'quantum',
    palette: 'Deep Obsidian · Amber #F59E0B / Champagne #FDE047',
    cap: 50,
  },
  {
    id: 'heisenberg_formula',
    name: "Heisenberg's Formula",
    figure: 'Heisenberg',
    archetype: 'The Formula',
    pillar: 'Calculated Precision',
    description: 'Flawless tactical execution and cold dominance. Wins before the race begins.',
    lore: 'No wasted moves. No luck. Only the formula.',
    criteria: 'Win 60% of at least 5 races. Ruthless precision, never chance.',
    accent: 'frost',
    palette: 'Matte Graphite · Frost Emerald #10B981 / #34D399',
    cap: 25,
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

/**
 * The claimed ledger sealed into this build. The next serial is one past the last
 * claimed number, which is why the honors mint at #042 / 100, #018 / 50 and
 * #007 / 25 — and why a locked card can count the slots this ledger has left.
 */
const CLAIMED_EDITIONS: Record<BadgeAccent, number> = {
  titanium: 41,
  quantum: 17,
  frost: 6,
};

export interface BadgeEdition {
  cap: number;
  /** The player's minted serial once earned, else null. */
  serial: number | null;
  /** Unclaimed serials left before this device mints its own. */
  remaining: number;
}

export function badgeEdition(id: string): BadgeEdition {
  const def = badgeById(id);
  if (!def) return { cap: 0, serial: null, remaining: 0 };
  const claimed = CLAIMED_EDITIONS[def.accent];
  const serial = isBadgeUnlocked(def.id) ? claimed + 1 : null;
  return {
    cap: def.cap,
    serial,
    remaining: Math.max(0, def.cap - claimed - (serial !== null ? 1 : 0)),
  };
}

const pad3 = (n: number) => String(n).padStart(3, '0');

/** The card's third line: "#042 / 100" once minted, "59 / 100 REMAINING" until then. */
export function editionLabel(ed: BadgeEdition): string {
  return ed.serial !== null
    ? `#${pad3(ed.serial)} / ${ed.cap}`
    : `${ed.remaining} / ${ed.cap} REMAINING`;
}

/** The same state, spelled for a screen reader. */
export function editionSpeech(ed: BadgeEdition): string {
  return ed.serial !== null
    ? `Edition ${ed.serial} of ${ed.cap}.`
    : `${ed.remaining} of ${ed.cap} editions remaining.`;
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
