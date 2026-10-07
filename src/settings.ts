/**
 * settings.ts — the switches and the last menu choice. Storage itself is `storage.ts`'s door:
 * every access there is wrapped, so a webview that refuses localStorage still gets a working app.
 */
import type { Difficulty } from './bot';
import { readJson, writeJson } from './storage';

export type Mode = 'bot' | 'local' | 'online';

export interface Settings {
  /** placeholder until the app actually has audio */
  sound: boolean;
  haptics: boolean;
  reducedMotion: boolean;
}

export interface MenuState {
  mode: Mode;
  difficulty: Difficulty;
}

const S_KEY = 'finish-race.settings.v1';
const M_KEY = 'finish-race.menu.v1';
const DEFAULT_SETTINGS: Settings = { sound: true, haptics: true, reducedMotion: false };
const DEFAULT_MENU: MenuState = { mode: 'bot', difficulty: 'normal' };

const motion = matchMedia('(prefers-reduced-motion: reduce)');
let systemReduce = motion.matches;
try { motion.addEventListener('change', (e) => { systemReduce = e.matches; }); } catch { /* fixed at load */ }

export const settings: Settings = { ...DEFAULT_SETTINGS, ...readJson<Settings>(S_KEY) };
export const menuState: MenuState = { ...DEFAULT_MENU, ...readJson<MenuState>(M_KEY) };
if (menuState.difficulty !== 'easy' && menuState.difficulty !== 'hard') menuState.difficulty = 'normal';
if (menuState.mode !== 'bot' && menuState.mode !== 'local') menuState.mode = 'bot';

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
