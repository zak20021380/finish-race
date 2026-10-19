/**
 * badges.ts — gamified player identity: Honor & Badges showcase.
 *
 * The catalogue is static; unlock state is derived from the live save so a
 * half-written localStorage blob can never smuggle a badge in. Only the
 * equipped badge id persists (profile.badge under detour.save.v2) — the same
 * single-key contract storage.ts already owns.
 *
 * Every badge is a two-key lock: its own achievement AND a Tactical IQ
 * milestone. The milestone is what the Honor sheet prints, so the ladder has a
 * visible number to grind for even before the achievement lands.
 *
 * The roster is the prestige ladder of historical masterminds, one per TIQ
 * milestone. Ids stay stable across the rename so an already-equipped badge
 * still resolves from the save (profile.badge is the only persisted key).
 *
 * Unlock rules (all local-first):
 * - early-adopter: Da Vinci's Vision — always unlocked, you are here at 0 TIQ.
 * - squad-warrior: Churchill's Bastion — squad/team bound, and 1,000 TIQ.
 * - streak-master: Sun Tzu's Shadow — best win streak of 3+, and 2,000 TIQ.
 * - cup-finalist: Napoleon's Crown — 5+ games played, and 3,000 TIQ.
 * - apex-immortal: Cyrus the Immortal — the 4,000 TIQ Apex lock itself.
 */

import { myTeam, profile } from './storage';
import { getMySquad } from './squads';
import { myTiq } from './matchmaking';

export interface BadgeDef {
  id: string;
  name: string;
  lore: string;
  criteria: string;
  /** Names the sculpted crest in index.html (#i-crest-<accent>) and its CSS aura. */
  accent: 'gold' | 'sky' | 'mint' | 'coral' | 'obsidian';
  /** Tactical IQ milestone the badge demands, on the same scale as myTiq(). */
  tiq: number;
}

export const BADGES: BadgeDef[] = [
  {
    id: 'early-adopter',
    name: "Da Vinci's Vision",
    lore: 'Reads three steps ahead. Master of board geometry.',
    criteria: 'Join the game — every pioneer begins with vision. No TIQ minimum.',
    accent: 'gold',
    tiq: 0,
  },
  {
    id: 'squad-warrior',
    name: "Churchill's Bastion",
    lore: 'Never surrender. Architect of impenetrable walls.',
    criteria: 'Bind a Telegram squad or join a team, and bank 1,000 TIQ.',
    accent: 'sky',
    tiq: 1000,
  },
  {
    id: 'streak-master',
    name: "Sun Tzu's Shadow",
    lore: 'Every battle is won before the first pawn moves.',
    criteria: 'Reach a 3-win streak in bot races and bank 2,000 TIQ.',
    accent: 'mint',
    tiq: 2000,
  },
  {
    id: 'cup-finalist',
    name: "Napoleon's Crown",
    lore: 'Relentless tempo. Conquers the board without mercy.',
    criteria: 'Finish 5 races and bank 3,000 TIQ.',
    accent: 'coral',
    tiq: 3000,
  },
  {
    id: 'apex-immortal',
    name: 'Cyrus the Immortal',
    lore: 'Supreme Tactical IQ. Sovereign of the Mind Ladder.',
    criteria: 'Bank 4,000 TIQ — the Apex lock. No other key opens it.',
    accent: 'obsidian',
    tiq: 4000,
  },
];

export const badgeById = (id: string | null | undefined): BadgeDef | null =>
  BADGES.find((b) => b.id === id) ?? null;

/** The badge's own achievement, ignoring its TIQ milestone. */
function achievementMet(id: string): boolean {
  switch (id) {
    case 'early-adopter':
      return true;
    case 'squad-warrior':
      return getMySquad() !== null || myTeam() !== null;
    case 'streak-master':
      return profile.stats.best >= 3;
    case 'cup-finalist':
      return profile.stats.games >= 5;
    case 'apex-immortal':
      return true;
    default:
      return false;
  }
}

export function isBadgeUnlocked(id: string): boolean {
  const def = badgeById(id);
  return !!def && achievementMet(def.id) && myTiq() >= def.tiq;
}

/** TIQ standing against the badge's milestone — the figure the honor cards print. */
export function badgeTiq(id: string): { tiq: number; got: number; pct: number; met: boolean } {
  const tiq = badgeById(id)?.tiq ?? 0;
  const got = Math.max(0, myTiq());
  return {
    tiq,
    got,
    pct: tiq > 0 ? Math.min(1, got / tiq) : 1,
    met: got >= tiq,
  };
}

/** Completion progress for locked badges (tooltip + sheet meter). */
export function badgeProgress(id: string): { got: number; need: number; label: string } {
  switch (id) {
    case 'squad-warrior':
      return getMySquad() !== null || myTeam() !== null
        ? { got: 1, need: 1, label: 'Squad bound' }
        : { got: 0, need: 1, label: 'Join a squad or team' };
    case 'streak-master': {
      const got = Math.min(profile.stats.best, 3);
      return { got, need: 3, label: `${got}/3 streak` };
    }
    case 'cup-finalist': {
      const got = Math.min(profile.stats.games, 5);
      return { got, need: 5, label: `${got}/5 races` };
    }
    default:
      return { got: 1, need: 1, label: 'Unlocked' };
  }
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
