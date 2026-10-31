/**
 * vsclash.ts — the pre-match face-off: every seat in the race, one crest, ~3.5 seconds.
 *
 * Every start path already funnels through `startGame()` in main.ts, so this is the one place a
 * match can be announced. The overlay is a *reveal gate*, not a pause: the board is staged the
 * moment `startGame()` returns and the route to it is handed back through `onReveal`, which fires
 * exactly once — when the crest shatters, when the player taps to skip, or when the watchdog runs
 * out. Nothing about the race itself changes.
 *
 * The grid is shaped by the seats the race actually holds: a duel stacks two full-width cards, a
 * three-way splits its rival row in two over a full-width local card, and a four-way balances two
 * over two. The crest never moves — only what it says about the format.
 *
 * The psychology is the point: a flag and a squad are things you defend, so a loss stops being
 * about a board and starts being about territory. Which is also why the automated bypass is
 * absolute — a browser suite gets no overlay and no delay at all, the same contract `splash.ts`
 * keeps with `data-txs-skip`, so no headless run ever waits on a cinematic or eats a stray tap.
 *
 * No player string is ever interpolated into markup: names, handles and squads go through
 * `textContent`, so a rival called `<img onerror=…>` is painted as a name and nothing else.
 */

import './vsclash.css';
import { flagPhoto } from './flags';
import { nameOf } from './countries';
import { getMySquad } from './squads';
import { myTier, myTiq, readFace, TIER_NAME, type MindTier } from './matchmaking';
import { profile } from './storage';
import { impact, languageCode } from './telegram';
import { lang, motionReduced } from './settings';
import { playSwoosh } from './audio';
import {
  botPersona, clashCopy, rivalPersona, resolveNation,
  type ClashCopy, type ClashTier,
} from './vsdata';

/** Cards are flying from 0; the crest lands here, and that is the beat the haptic answers to. */
const CLASH_AT_MS = 350;
/** How long the face-off stays readable after the crest lands: 2.7s to take in flags, squads and calls. */
const HOLD_MS = 2700;
/** The fly-away: the board is revealed under it, so the two overlap rather than queue. */
const EXIT_MS = 400;
/** The reduced-motion cut: the same information, none of the movement, but the same reading time. */
const QUIET_REVEAL_MS = 2800;
const QUIET_EXIT_MS = 80;
/** A tap before this does nothing: the matchup has not been on screen long enough to be seen. */
const SKIP_AFTER_MS = 1000;
/** One psychological line at a time, slow enough to read on a longer hold. */
const LINE_MS = 900;
/** If a webview throttles our timers, the race still has to start. */
const WATCHDOG_MS = 5000;
/** A board holds four seats, so three is the most rivals a face-off can ever paint. */
const MAX_FOES = 3;
/** The three shapes the grid resolves to, from the seats actually in the race. */
type Shape = 'duel' | 'trio' | 'quad';

/** A seat the local player may be facing. Bots carry their level, people carry their profile. */
export interface VsRival {
  /** Stable key the persona is hashed from: the seat id, or a synthesized bot slot. */
  id: string;
  name?: string;
  avatarUrl?: string | null;
  /** ISO alpha-2 when the seat broadcasts one. */
  country?: string | null;
  squad?: string | null;
  tiq?: number;
  /** The Mind Tier the seat announced, when it announced one. */
  tier?: MindTier | null;
  /** The machine's level at this seat, or null for a person. */
  bot?: ClashTier | null;
}

/** What the race is being played for, as the pill under the crest. */
export interface VsStakes {
  kind: 'ranked' | 'bot' | 'room';
  /** The machine's level, when a bot is in the race. */
  tier?: ClashTier;
  /** Seats at the table, so a four-way does not read as a duel. */
  seats?: number;
  /** Folded into a bot's seed: the same ladder slot, a different rival each race. */
  nonce?: number;
}

/** Whose card it is. Only two kinds of seat ever reach this screen. */
type Seat = 'you' | 'rival';
/** The local seat holds cyan; the hostile seats rotate through the obsidian end of the palette. */
type Accent = 'cyan' | 'crimson' | 'violet' | 'obsidian';

/** The order a multi-seat row wears its accents in, so no two rivals share one. */
const FOE_ACCENTS: readonly Exclude<Accent, 'cyan'>[] = ['crimson', 'violet', 'obsidian'];

interface Fighter {
  kind: Seat;
  accent: Accent;
  name: string;
  initial: string;
  avatarUrl: string | null;
  country: string;
  squad: string;
  tier: MindTier;
  tiq: number;
  /** A rating the seat actually carries. A rival nobody announced one for prints no row at all. */
  rankKnown: boolean;
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

/** One sprite glyph. The ids are ours, never a caller's, so `href` is safe as a literal. */
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

/** An automated run never meets the veil: no node, no timer, and the reveal lands synchronously. */
function bypassed(): boolean {
  if (typeof navigator !== 'undefined' && navigator.webdriver === true) return true;
  /* the same headless guard the boot screen honours, set before the bundle runs */
  return document.documentElement.hasAttribute('data-txs-skip');
}

const locales = (): string[] => {
  const out: string[] = [];
  try { out.push(languageCode()); } catch { /* no Telegram */ }
  try {
    out.push(navigator.language, ...(navigator.languages ?? []));
  } catch { /* headless */ }
  return out.filter(Boolean);
};

const zone = (): string => {
  try { return new Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''; } catch { return ''; }
};

function localFighter(copy: ClashCopy): Fighter {
  const face = readFace('You');
  const bound = getMySquad();
  return {
    kind: 'you',
    accent: 'cyan',
    name: face.name || 'You',
    initial: face.initial || 'P',
    avatarUrl: face.avatarUrl,
    /* the saved pick wins, then the client's own locale, then the device clock, then its tongue */
    country: resolveNation(profile.country, locales(), zone()),
    squad: bound ? bound.name : copy.loneSquad,
    tier: myTier(),
    tiq: myTiq(),
    rankKnown: true,
  };
}

/**
 * A seat as a fighter. A machine seat is dressed as a person — banner, callsign, elite squad and a
 * TIQ that sits in the band its level plays at — because "you are playing a Hard bot" fires nobody,
 * while "you are facing Kestrel of the Obsidian Cortex" does. Anything a real seat actually
 * broadcasts wins over the invented persona.
 */
function rivalFighter(r: VsRival, stakes: VsStakes, seat: number): Fighter {
  const bot = r.bot ?? null;
  const realName = (r.name ?? '').trim();
  const cc = (r.country ?? '').toUpperCase();
  /** A race that never announced a rating shows no rating: an invented one would be a lie about a person. */
  const announced = Math.max(0, Math.round(r.tiq ?? 0));
  /* the seat index offsets the persona hash, so two machines in one room never share a banner */
  const persona = bot
    ? botPersona(`${r.id}|${stakes.nonce ?? 0}`, bot, seat)
    : rivalPersona(r.id, realName || 'Rival', announced, seat);
  const name = !bot && realName ? realName : persona.name;
  const squad = (!bot && (r.squad ?? '').trim()) ? (r.squad as string).trim() : persona.squad;
  const tiq = bot ? persona.tiq : announced;
  return {
    kind: 'rival',
    accent: FOE_ACCENTS[seat % FOE_ACCENTS.length],
    name,
    initial: name.charAt(0).toUpperCase() || '?',
    avatarUrl: r.avatarUrl ?? null,
    country: !bot && /^[A-Z]{2}$/.test(cc) ? cc : persona.country,
    squad,
    tier: r.tier ?? persona.tier,
    tiq,
    rankKnown: !!bot || tiq > 0,
  };
}

/**
 * One fighter as a card: portrait with its flag pinned to the corner, then three tight lines —
 * name and TIQ, squad, tier and nation. No role tag and no ISO code: on this screen the accent
 * already says whose card it is, and the flag badge already says where they are from.
 *
 * `compact` is the half-width variant a three- or four-seat grid needs; the row is the same, just
 * tightened, so the reading order never changes between shapes.
 */
function paintCard(host: Element, f: Fighter, copy: ClashCopy, compact: boolean, slam: 'l' | 'r'): void {
  const card = el('div', `vsc-side vsc-side--${f.kind}`, host);
  card.dataset.tier = f.tier;
  card.dataset.accent = f.accent;
  card.dataset.compact = compact ? '1' : '0';
  card.dataset.slam = slam;
  /* the role is kept for a screen reader, never painted: it was the noisiest line on the card */
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', `${f.name} — ${f.kind === 'you' ? copy.youLabel : copy.rivalLabel}`);

  const orb = el('div', 'vsc-orb', card);
  el('span', 'vsc-aura', orb);
  el('span', 'vsc-shock', orb);
  const face = el('div', 'vsc-face', orb);
  if (f.avatarUrl) {
    const img = el('img', 'vsc-av', face) as HTMLImageElement;
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      img.remove();
      el('span', 'vsc-initial', face).textContent = f.initial;
    });
    img.src = f.avatarUrl;
  } else {
    el('span', 'vsc-initial', face).textContent = f.initial;
  }

  /* the flag is a micro-badge on the portrait's corner, not a text row: one glyph, no code */
  const flag = el('span', 'vsc-flag', orb);
  flag.appendChild(flagPhoto(f.country || null, 'vsc-flag-fp', 80));
  flag.title = f.country ? nameOf(f.country) : copy.noNation;

  const id = el('div', 'vsc-id', card);

  /* name and TIQ share the top line: the reading the ladder already prints, at a glance */
  const top = el('div', 'vsc-top', id);
  el('h3', 'vsc-name', top).textContent = f.name;
  if (f.rankKnown) {
    const rank = el('div', 'vsc-rank', top);
    rank.title = 'TIQ';
    glyph('i-brain', rank);
    label('vsc-tiq', f.tiq > 0 ? f.tiq.toLocaleString('en-US') : '0', rank);
  }

  /* squad: one shield and a name — the tribal bit, with the crest initials stripped out */
  const squad = el('div', 'vsc-squad', id);
  squad.dataset.kind = f.squad === copy.loneSquad ? 'lone' : 'bound';
  glyph('i-shield', squad, 'vsc-ico vsc-shield');
  el('span', 'vsc-squad-t', squad).textContent = f.squad;
  squad.title = f.squad;

  /* the tier is a three-bar icon with its word in whisper type; the nation is a name, not a code */
  if (f.rankKnown) {
    const meta = el('div', 'vsc-meta', id);
    const tier = el('span', 'vsc-tier', meta);
    tier.dataset.tier = f.tier;
    tier.title = TIER_NAME[f.tier];
    tier.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i += 1) el('i', 'vsc-pip', tier);
    label('vsc-tier-t', TIER_NAME[f.tier], meta);
    if (f.country) {
      el('span', 'vsc-meta-dot', meta);
      label('vsc-country', nameOf(f.country), meta);
    }
  }
}

/**
 * Runs the face-off. `onReveal` is called exactly once, and always: a tap past the skip window
 * fires it early, a throttled timer fires it from the watchdog, and an automated browser is
 * answered synchronously before this function returns.
 */
export function showVsClash(rivals: readonly VsRival[], stakes: VsStakes, onReveal: () => void): void {
  if (bypassed() || rivals.length === 0) { onReveal(); return; }

  const copy = clashCopy(lang);
  const you = localFighter(copy);
  /* every rival a seat actually holds is shown: a four-way that prints one opponent is a lie */
  const foes = rivals.slice(0, MAX_FOES).map((r, i) => rivalFighter(r, stakes, i));
  /* a duel stacks two rows; a trio puts its two rivals side by side over the local seat; a
     four-way balances two over two, with the crest on the seam between the rows */
  const shape: Shape = foes.length >= 3 ? 'quad' : foes.length === 2 ? 'trio' : 'duel';

  /* full-bleed: the clash is a cinematic, not a sheet, so it owns the viewport like the boot veil */
  const stage = document.body;
  const quiet = motionReduced();
  const revealAt = quiet ? QUIET_REVEAL_MS : CLASH_AT_MS + HOLD_MS;
  const exitAt = quiet ? QUIET_EXIT_MS : EXIT_MS;

  const host = el('div', 'vsc is-in');
  host.id = 'vs-clash';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-label', copy.versus);
  stage.appendChild(host);

  /* the stage: two auras split by one diagonal seam */
  const bg = el('div', 'vsc-bg', host);
  el('span', 'vsc-aura-you', bg);
  el('span', 'vsc-aura-rival', bg);
  el('span', 'vsc-seam', bg);
  el('span', 'vsc-grain', bg);

  const shake = el('div', 'vsc-shake', host);
  const grid = el('div', 'vsc-grid', shake);
  grid.dataset.shape = shape;

  /* top row: one rival in a duel, both rivals in a trio, the first two of three in a four-way */
  const topRow = el('div', 'vsc-row', grid);
  topRow.dataset.cols = shape === 'duel' ? '1' : '2';
  const topFoes = shape === 'duel' ? foes.slice(0, 1) : foes.slice(0, 2);
  const compactTop = topFoes.length > 1;
  topFoes.forEach((f, i) => paintCard(topRow, f, copy, compactTop, compactTop && i === 0 ? 'l' : 'r'));

  /* the crest owns the seam between the rows, whatever the shape */
  const core = el('div', 'vsc-core', grid);
  const crest = el('div', 'vsc-crest-holder', core);
  el('span', 'vsc-ring', crest);
  el('span', 'vsc-ring vsc-ring--late', crest);
  glyph('i-bolt', crest, 'vsc-crest-bolt vsc-crest-bolt--l');
  glyph('i-bolt', crest, 'vsc-crest-bolt vsc-crest-bolt--r');
  const mark = el('span', 'vsc-vs', crest);
  mark.textContent = shape === 'duel' ? 'VS' : `${shape === 'trio' ? 3 : 4}P`;
  if (shape !== 'duel') mark.dataset.shape = 'multi';
  crest.setAttribute('aria-hidden', 'true');
  /* the format is named under the crest, so a four-way never reads as a duel to anybody */
  if (shape !== 'duel') label('vsc-shape', shape === 'trio' ? copy.shapeTrio : copy.shapeQuad, core);

  /* one glass pill for the whole wager: mode · level · seats, and the mind gap only in a duel */
  const stakesPill = el('div', 'vsc-stakes', core);
  const seatWord = stakes.kind === 'ranked' ? copy.modeRanked
    : stakes.kind === 'bot' ? copy.modeBot : copy.modeRoom;
  const seats = stakes.seats ?? foes.length + 1;
  const bits: Array<[string, string]> = [[seatWord, 'vsc-stakes-mode']];
  /* the machine's level, named: "BOT DUEL · HARD" is a challenge, "BOT DUEL" is a setting */
  if (stakes.tier) bits.push([stakes.tier.toUpperCase(), 'vsc-stakes-tier']);
  if (seats > 2) bits.push([`${seats}P`, 'vsc-stakes-seats']);
  else if (foes[0] && foes[0].tiq > 0 && you.tiq > 0) {
    const gap = Math.abs(foes[0].tiq - you.tiq).toLocaleString('en-US');
    bits.push([`${copy.mindGap} ${gap}`, 'vsc-stakes-gap']);
  }
  bits.forEach(([text, cls], i) => {
    if (i) el('span', 'vsc-stakes-dot', stakesPill);
    label(cls, text, stakesPill);
  });

  /* bottom row: you alone in a duel or a trio (the ground being defended), the third rival and
     you side by side in a four-way, which is what makes it read as two rows of two */
  const bottomRow = el('div', 'vsc-row', grid);
  bottomRow.dataset.cols = shape === 'quad' ? '2' : '1';
  if (shape === 'quad' && foes[2]) paintCard(bottomRow, foes[2], copy, true, 'l');
  paintCard(bottomRow, you, copy, shape === 'quad', shape === 'quad' ? 'r' : 'l');

  /* the war cry and the skip key hold the bottom of the screen */
  const foot = el('div', 'vsc-foot', shake);
  const banner = el('div', 'vsc-banner', foot);
  const line = el('p', 'vsc-line', banner);
  line.dir = copy.dir;
  line.lang = lang;
  let index = 0;
  const paint = () => { line.textContent = copy.lines[index % copy.lines.length]; };
  paint();

  el('p', 'vsc-skip', foot).textContent = copy.skip;

  /* ---- the clock ---- */
  let fired = false;
  let cycle = 0;
  const timers: number[] = [];
  const later = (fn: () => void, ms: number): void => { timers.push(window.setTimeout(fn, ms)); };
  const clear = (): void => {
    for (const t of timers) window.clearTimeout(t);
    timers.length = 0;
    if (cycle) window.clearInterval(cycle);
  };
  const startedAt = Date.now();

  function reveal(): void {
    if (fired) return;
    fired = true;
    clear();
    /* the race first: the crest only shatters over a board that is already live underneath it */
    onReveal();
    host.classList.add('is-leaving');
    /* the board is live the instant the crest breaks: taps must reach it, not the fly-away */
    host.style.pointerEvents = 'none';
    const out = host.classList.contains('is-skipped') ? 150 : exitAt;
    window.setTimeout(() => host.remove(), out + 40);
  }

  /** The collision: weight, haptic and sound land on the same frame. */
  function clash(): void {
    host.classList.add('is-clash');
    impact('heavy');
    playSwoosh();
  }

  host.addEventListener('pointerdown', () => {
    if (fired || Date.now() - startedAt < SKIP_AFTER_MS) return;
    host.classList.add('is-skipped');
    reveal();
  });

  if (quiet) {
    host.classList.add('is-quiet', 'is-clash');
  } else {
    later(clash, CLASH_AT_MS);
    /* the banner keeps rotating only while the crest is still on screen */
    later(() => {
      if (fired) return;
      cycle = window.setInterval(() => {
        index += 1;
        if (fired || document.hidden) return;
        banner.classList.add('is-swapping');
        window.setTimeout(() => {
          if (fired) return;
          paint();
          banner.classList.remove('is-swapping');
        }, 180);
      }, LINE_MS);
    }, CLASH_AT_MS + 220);
  }
  later(reveal, revealAt);
  /* nothing may keep a race from starting, not even a suspended webview */
  later(reveal, WATCHDOG_MS);
}
