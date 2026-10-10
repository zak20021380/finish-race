/**
 * badges.ts — gamified player identity: Honor & Badges showcase.
 *
 * The catalogue is static; unlock state is derived from the live save so a
 * half-written localStorage blob can never smuggle a badge in. Only the
 * equipped badge id persists (profile.badge under detour.save.v2) — the same
 * single-key contract storage.ts already owns.
 *
 * Unlock rules (all local-first):
 * - early-adopter: always unlocked — you are here at the start.
 * - squad-warrior: bound to a Telegram squad OR in a team.
 * - streak-master: best win streak of 3+ (bot races).
 * - cup-finalist: 5+ games played (Arena-ready).
 */

import { myTeam, profile } from './storage';
import { getMySquad } from './squads';

export interface BadgeDef {
  id: string;
  name: string;
  lore: string;
  criteria: string;
  /** symbol id from index.html, e.g. #i-crown */
  icon: string;
  accent: 'gold' | 'sky' | 'mint' | 'coral';
}

export const BADGES: BadgeDef[] = [
  {
    id: 'early-adopter',
    name: 'Early Adopter',
    lore: 'One of the first racers to hit the slate. The clay still remembers your first tap.',
    criteria: 'Join the game — awarded to every pioneer.',
    icon: '#i-crown',
    accent: 'gold',
  },
  {
    id: 'squad-warrior',
    name: 'Squad Warrior',
    lore: 'You fight for more than yourself. Squad points, shared cups, shared glory.',
    criteria: 'Bind a Telegram squad or join a team.',
    icon: '#i-users',
    accent: 'sky',
  },
  {
    id: 'streak-master',
    name: 'Win Streak Master',
    lore: 'Three wins in a row against the machine. Cold, clean, relentless.',
    criteria: 'Reach a 3-win streak in bot races.',
    icon: '#i-swords',
    accent: 'mint',
  },
  {
    id: 'cup-finalist',
    name: 'Cup Finalist',
    lore: 'Five races deep. The Arena knows your name and the cup is watching.',
    criteria: 'Finish 5 races.',
    icon: '#i-cup',
    accent: 'coral',
  },
];

export const badgeById = (id: string | null | undefined): BadgeDef | null =>
  BADGES.find((b) => b.id === id) ?? null;

export function isBadgeUnlocked(id: string): boolean {
  switch (id) {
    case 'early-adopter':
      return true;
    case 'squad-warrior':
      return getMySquad() !== null || myTeam() !== null;
    case 'streak-master':
      return profile.stats.best >= 3;
    case 'cup-finalist':
      return profile.stats.games >= 5;
    default:
      return false;
  }
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
