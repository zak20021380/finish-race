/**
 * settings.ts — the switches and the last menu choice. Storage itself is `storage.ts`'s door:
 * every access there is wrapped, so a webview that refuses localStorage still gets a working app.
 */
import type { Difficulty } from './bot';
import { readJson, writeJson } from './storage';

export type Mode = 'bot' | 'online';
/** Which tier of the launcher is showing: a solo race, or two sides. */
export type ModeTab = 'solo' | 'party';

export interface Settings {
  /** placeholder until the app actually has audio */
  sound: boolean;
  haptics: boolean;
  reducedMotion: boolean;
}

export interface MenuState {
  mode: Mode;
  tab: ModeTab;
  difficulty: Difficulty;
  /** balls per side for a race, 1 to 3 each — the solo tier always holds [1, 1] */
  sizes: [number, number];
}

const S_KEY = 'detour.settings.v1';
const M_KEY = 'detour.menu.v1';
const DEFAULT_SETTINGS: Settings = { sound: true, haptics: true, reducedMotion: false };
const DEFAULT_MENU: MenuState = { mode: 'bot', tab: 'solo', difficulty: 'normal', sizes: [1, 1] };

const motion = matchMedia('(prefers-reduced-motion: reduce)');
let systemReduce = motion.matches;
try { motion.addEventListener('change', (e) => { systemReduce = e.matches; }); } catch { /* fixed at load */ }

export const settings: Settings = { ...DEFAULT_SETTINGS, ...readJson<Settings>(S_KEY) };
export const menuState: MenuState = { ...DEFAULT_MENU, ...readJson<MenuState>(M_KEY) };
if (menuState.difficulty !== 'easy' && menuState.difficulty !== 'hard') menuState.difficulty = 'normal';
if (menuState.mode !== 'bot') menuState.mode = 'bot';
if (menuState.tab !== 'party') menuState.tab = 'solo';

/** Two sides of 1 to 3 balls: the mode select writes this, the race reads it. */
const clampSize = (n: unknown) => Math.max(1, Math.min(3, typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 1));
menuState.sizes = Array.isArray(menuState.sizes) && menuState.sizes.length === 2
  ? [clampSize(menuState.sizes[0]), clampSize(menuState.sizes[1])]
  : [...DEFAULT_MENU.sizes];
/* a save from before the tiers existed only said how many balls each side had */
if (menuState.tab === 'solo' && (menuState.sizes[0] !== 1 || menuState.sizes[1] !== 1)) menuState.tab = 'party';

const watchers: ((s: Settings) => void)[] = [];

/** The system preference always wins; the toggle can only ask for more restraint. */
export const motionReduced = () => systemReduce || settings.reducedMotion;

export function applyMotion() {
  document.documentElement.classList.toggle('rm', motionReduced());
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings[key] = value;
  writeJson(S_KEY, settings);
  applyMotion();
  for (const w of watchers) w(settings);
}

export function onSettings(w: (s: Settings) => void) { watchers.push(w); }

export function saveMenu(patch: Partial<MenuState>) {
  Object.assign(menuState, patch);
  writeJson(M_KEY, menuState);
}

applyMotion();
