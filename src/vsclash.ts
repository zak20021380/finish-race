/**
 * vsclash.ts — the pre-match face-off: every real seat in the race, one crest, a fraction of a
 * second. It is a reveal gate, not a pause: the board is staged the moment `startGame()` returns
 * and the route is handed back through `onReveal`, which fires exactly once — on the short timer,
 * on a tap to skip, or on the watchdog. Nothing about the race itself changes.
 *
 * There are no fabricated opponents. A card shows the metadata a seat actually carries: a real
 * player's name, avatar, TIQ, nation and guild, all from memory, or — for a machine seat — an
 * unmistakable BOT label, its real difficulty, and nothing else. A missing nation or guild hides
 * its row instead of inventing one, and every dynamic name is wrapped in `<bdi>` so RTL locales
 * never scramble it. No flag image is fetched here: the nation is printed as text only.
 */

import './vsclash.css';
import { nameOf } from './countries';
import { getMySquad } from './squads';
import { myTiq, readFace } from './matchmaking';
import { profile } from './storage';
import { impact, languageCode } from './telegram';
import { lang, motionReduced, t } from './settings';
import { clashCopy, type ClashTier } from './vsdata';

/** Short, non-blocking beats: the board is live underneath before the crest even lands. */
const CLASH_AT_MS = 110;
const HOLD_MS = 620;
const EXIT_MS = 140;
const QUIET_REVEAL_MS = 320;
const QUIET_EXIT_MS = 60;
/** A tap before this does nothing: the matchup has not been on screen long enough to be seen. */
const SKIP_AFTER_MS = 220;
/** A throttled webview still starts the race. */
const WATCHDOG_MS = 1500;
/** A board holds four seats, so three is the most rivals a face-off can ever paint. */
const MAX_FOES = 3;

type Shape = 'duel' | 'trio' | 'quad';

/** One seat on the other side of the crest. All fields are real room/match metadata. */
export interface VsRival {
  /** Stable key for the seat; never hashed into a persona. */
  id: string;
  /** A human's exact display name. */
  name?: string;
  avatarUrl?: string | null;
  /** ISO alpha-2, only when the profile actually set one. */
  nation?: string | null;
  /** The real guild/squad name, only when the player bound one. */
  guild?: string | null;
  /** The real TIQ, only when the seat announced one. */
  tiq?: number | null;
  /** True for a machine seat — it is labelled BOT, never dressed as a person. */
  isBot?: boolean;
  /** The machine's actual difficulty. */
  difficulty?: ClashTier | null;
}

/** What the race is being played for, as the small pill under the crest. */
export interface VsStakes {
  kind: 'ranked' | 'bot' | 'room';
  /** Seats at the table, so a four-way never reads as a duel. */
  seats?: number;
}

type Accent = 'cyan' | 'crimson' | 'violet' | 'obsidian';
const FOE_ACCENTS: readonly Exclude<Accent, 'cyan'>[] = ['crimson', 'violet', 'obsidian'];

interface Fighter {
  kind: 'you' | 'rival' | 'bot';
  accent: Accent;
  name: string;
  initial: string;
  avatarUrl: string | null;
  /** Empty when the player never chose a nation. */
  nation: string;
  /** Empty when the player never bound a squad. */
  guild: string;
  /** 0 when the seat carries no rating. */
  tiq: number;
  difficulty: ClashTier | null;
}

const el = (tag: string, cls: string, parent?: Element): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

const label = (cls: string, text: string, parent: Element): void => {
  el('span', cls, parent).textContent = text;
};

/** One glyph from the app's own sprite sheet. The ids are literals, never caller input. */
function glyph(id: string, parent: Element, cls = 'vsc-ico'): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  parent.appendChild(svg);
  return svg;
}

/** An automated run never meets the veil: no node, no timer, reveal lands synchronously. */
function bypassed(): boolean {
  if (typeof navigator !== 'undefined' && navigator.webdriver === true) return true;
  return document.documentElement.hasAttribute('data-txs-skip');
}

/** The local seat: only the user's own saved and signed-in data. No guessing from clock or locale. */
function localFighter(): Fighter {
  const face = readFace('You');
  const squad = getMySquad();
  return {
    kind: 'you',
    accent: 'cyan',
    name: face.name || t('vsYou'),
    initial: face.initial || 'P',
    avatarUrl: face.avatarUrl,
    nation: profile.country ?? '',
    guild: squad?.name ?? '',
    tiq: Math.max(0, Math.round(myTiq())),
    difficulty: null,
  };
}

/** A rival seat: real profile data for a person, an honest BOT card for a machine. */
function rivalFighter(r: VsRival, seat: number): Fighter {
  const accent = FOE_ACCENTS[seat % FOE_ACCENTS.length];
  if (r.isBot) {
    return {
      kind: 'bot', accent,
      name: t('vsBot'),
      initial: '', avatarUrl: null,
      nation: '', guild: '', tiq: 0,
      difficulty: r.difficulty ?? 'normal',
    };
  }
  const name = (r.name ?? '').trim() || t('vsRival');
  const cc = (r.nation ?? '').trim().toUpperCase();
  return {
    kind: 'rival', accent,
    name,
    initial: name.charAt(0).toUpperCase() || '?',
    avatarUrl: r.avatarUrl ?? null,
    nation: /^[A-Z]{2}$/.test(cc) ? cc : '',
    guild: (r.guild ?? '').trim(),
    tiq: Math.max(0, Math.round(r.tiq ?? 0)),
    difficulty: null,
  };
}

/** The difficulty word a machine seat actually plays at. */
const difficultyLabel = (tier: ClashTier | null): string =>
  tier === 'easy' ? t('vsEasy') : tier === 'hard' ? t('vsHard') : t('vsNormal');

/**
 * One fighter as a card: portrait, then name, then only the rows that carry real data.
 * A bot shows its icon, the BOT name and its difficulty — no flag, guild or TIQ at all.
 * Every dynamic string is painted through `textContent` inside `<bdi>`: safe and RTL-clean.
 */
function paintCard(host: Element, f: Fighter, compact: boolean, slam: 'l' | 'r'): void {
  const card = el('div', `vsc-side vsc-side--${f.kind === 'you' ? 'you' : 'rival'}`, host);
  card.dataset.accent = f.accent;
  card.dataset.compact = compact ? '1' : '0';
  card.dataset.slam = slam;
  card.dataset.kind = f.kind;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', `${f.name} — ${f.kind === 'you' ? t('vsYou') : f.kind === 'bot' ? t('vsBot') : t('vsRival')}`);

  const face = el('div', 'vsc-face', card);
  if (f.kind === 'bot') {
    glyph('i-bot', face, 'vsc-bot-ico');
  } else if (f.avatarUrl) {
    const img = el('img', 'vsc-av', face) as HTMLImageElement;
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener('error', () => {
      img.remove();
      el('bdi', 'vsc-initial', face).textContent = f.initial;
    });
    img.src = f.avatarUrl;
  } else {
    el('bdi', 'vsc-initial', face).textContent = f.initial;
  }

  const id = el('div', 'vsc-id', card);
  const top = el('div', 'vsc-top', id);
  el('bdi', 'vsc-name', top).textContent = f.name;

  if (f.kind === 'bot') {
    /* the one and only subtitle on a bot card: its real difficulty */
    el('bdi', 'vsc-sub-t', el('div', 'vsc-sub', id)).textContent = difficultyLabel(f.difficulty);
    return;
  }

  if (f.tiq > 0) {
    const rank = el('div', 'vsc-rank', top);
    rank.title = 'TIQ';
    glyph('i-brain', rank);
    label('vsc-tiq', f.tiq.toLocaleString('en-US'), rank);
  }
  /* a guild line only when the player actually bound one */
  if (f.guild) {
    const squad = el('div', 'vsc-squad', id);
    glyph('i-shield', squad, 'vsc-ico vsc-shield');
    el('bdi', 'vsc-squad-t', squad).textContent = f.guild;
  }
  /* a nation name only when the player actually chose one — no flag request, no placeholder */
  if (f.nation) {
    el('bdi', 'vsc-country', el('div', 'vsc-meta', id)).textContent = nameOf(f.nation);
  }
}

/** Runs the short face-off; `onReveal` is called exactly once and always. */
export function showVsClash(rivals: readonly VsRival[], stakes: VsStakes, onReveal: () => void): void {
  if (bypassed() || rivals.length === 0) { onReveal(); return; }

  const you = localFighter();
  const foes = rivals.slice(0, MAX_FOES).map((r, i) => rivalFighter(r, i));
  const shape: Shape = foes.length >= 3 ? 'quad' : foes.length === 2 ? 'trio' : 'duel';
  const quiet = motionReduced();
  const revealAt = quiet ? QUIET_REVEAL_MS : CLASH_AT_MS + HOLD_MS;
  const exitAt = quiet ? QUIET_EXIT_MS : EXIT_MS;

  const host = el('div', 'vsc is-in');
  host.id = 'vs-clash';
  host.dir = clashCopy(languageCode()).dir;
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-label', t('vsVersus'));
  document.body.appendChild(host);

  const shake = el('div', 'vsc-shake', host);
  const grid = el('div', 'vsc-grid', shake);
  grid.dataset.shape = shape;

  const topRow = el('div', 'vsc-row', grid);
  topRow.dataset.cols = shape === 'duel' ? '1' : '2';
  const topFoes = shape === 'duel' ? foes.slice(0, 1) : foes.slice(0, 2);
  topFoes.forEach((f, i) => paintCard(topRow, f, topFoes.length > 1, topFoes.length > 1 && i === 0 ? 'l' : 'r'));

  const core = el('div', 'vsc-core', grid);
  const mark = el('span', 'vsc-vs', core);
  mark.textContent = shape === 'duel' ? 'VS' : `${shape === 'trio' ? 3 : 4}P`;
  if (shape !== 'duel') {
    mark.dataset.shape = 'multi';
    label('vsc-shape', shape === 'trio' ? t('vsTrio') : t('vsQuad'), core);
  }

  const seats = stakes.seats ?? foes.length + 1;
  const pill = el('div', 'vsc-stakes', core);
  label('vsc-stakes-mode', stakes.kind === 'ranked' ? t('vsModeRanked')
    : stakes.kind === 'bot' ? t('vsModeBot') : t('vsModeRoom'), pill);
  if (seats > 2) {
    el('span', 'vsc-stakes-dot', pill);
    label('vsc-stakes-seats', `${seats}P`, pill);
  }

  const bottomRow = el('div', 'vsc-row', grid);
  bottomRow.dataset.cols = shape === 'quad' ? '2' : '1';
  if (shape === 'quad' && foes[2]) paintCard(bottomRow, foes[2], true, 'l');
  paintCard(bottomRow, you, shape === 'quad', shape === 'quad' ? 'r' : 'l');

  label('vsc-skip', t('vsSkip'), el('div', 'vsc-foot', shake));

  let fired = false;
  const timers: number[] = [];
  const later = (fn: () => void, ms: number): void => { timers.push(window.setTimeout(fn, ms)); };
  const clear = (): void => { for (const timer of timers) window.clearTimeout(timer); timers.length = 0; };
  const startedAt = Date.now();

  function reveal(): void {
    if (fired) return;
    fired = true;
    clear();
    /* the race first: the visual exit plays over a board that is already live underneath */
    onReveal();
    host.classList.add('is-leaving');
    /* taps must reach the board, not the fly-away */
    host.style.pointerEvents = 'none';
    window.setTimeout(() => host.remove(), quiet ? QUIET_EXIT_MS + 40 : EXIT_MS + 40);
  }

  host.addEventListener('pointerdown', () => {
    if (fired || Date.now() - startedAt < SKIP_AFTER_MS) return;
    host.classList.add('is-skipped');
    reveal();
  });

  if (quiet) {
    host.classList.add('is-quiet', 'is-clash');
  } else {
    later(() => { host.classList.add('is-clash'); impact('light'); }, CLASH_AT_MS);
  }
  later(reveal, revealAt);
  later(reveal, WATCHDOG_MS);
}
