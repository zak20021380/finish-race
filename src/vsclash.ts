/**
 * vsclash.ts — the pre-match face-off: two nations, two squads, one crest, ~3.5 seconds.
 *
 * Every start path already funnels through `startGame()` in main.ts, so this is the one place a
 * match can be announced. The overlay is a *reveal gate*, not a pause: the board is staged the
 * moment `startGame()` returns and the route to it is handed back through `onReveal`, which fires
 * exactly once — when the crest shatters, when the player taps to skip, or when the watchdog runs
 * out. Nothing about the race itself changes.
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
import { getMySquad, squadMark } from './squads';
import { myTier, myTiq, readFace, TIER_NAME, type MindTier } from './matchmaking';
import { profile } from './storage';
import { impact, languageCode } from './telegram';
import { lang, motionReduced } from './settings';
import { playSwoosh } from './audio';
import {
  botPersona, clashCopy, rivalPersona, resolveNation, squadTag,
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

interface Fighter {
  name: string;
  initial: string;
  avatarUrl: string | null;
  country: string;
  squad: string;
  /** A real squad gets a crest plate; the lone badge is the copy's own glyph, already spoken. */
  squadCrest: string | null;
  tier: MindTier;
  tiq: number;
  /** A rating the seat actually carries. A rival nobody announced one for prints no row at all. */
  rankKnown: boolean;
  /** A person before a machine, then the sharper mind. Picks the headliner in a multi-seat race. */
  score: number;
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
    name: face.name || 'You',
    initial: face.initial || 'P',
    avatarUrl: face.avatarUrl,
    /* the saved pick wins, then the client's own locale, then the device clock, then its tongue */
    country: resolveNation(profile.country, locales(), zone()),
    squad: bound ? bound.name : copy.loneSquad,
    squadCrest: bound ? squadMark(bound) : null,
    tier: myTier(),
    tiq: myTiq(),
    rankKnown: true,
    score: Number.POSITIVE_INFINITY,
  };
}

/**
 * A seat as a fighter. A machine seat is dressed as a person — banner, callsign, elite squad and a
 * TIQ that sits in the band its level plays at — because "you are playing a Hard bot" fires nobody,
 * while "you are facing Kestrel of the Obsidian Cortex" does. Anything a real seat actually
 * broadcasts wins over the invented persona.
 */
function rivalFighter(r: VsRival, stakes: VsStakes): Fighter {
  const bot = r.bot ?? null;
  const realName = (r.name ?? '').trim();
  const cc = (r.country ?? '').toUpperCase();
  /** A race that never announced a rating shows no rating: an invented one would be a lie about a person. */
  const announced = Math.max(0, Math.round(r.tiq ?? 0));
  const persona = bot
    ? botPersona(`${r.id}|${stakes.nonce ?? 0}`, bot, 0)
    : rivalPersona(r.id, realName || 'Rival', announced, 0);
  const name = !bot && realName ? realName : persona.name;
  const squad = (!bot && (r.squad ?? '').trim()) ? (r.squad as string).trim() : persona.squad;
  const tiq = bot ? persona.tiq : announced;
  return {
    name,
    initial: name.charAt(0).toUpperCase() || '?',
    avatarUrl: r.avatarUrl ?? null,
    country: !bot && /^[A-Z]{2}$/.test(cc) ? cc : persona.country,
    squad,
    squadCrest: squadTag(squad),
    tier: r.tier ?? persona.tier,
    tiq,
    rankKnown: !!bot || tiq > 0,
    /* a real person is the headline rival; between two of them, the sharper mind takes the slot */
    score: bot ? tiq : 1_000_000 + tiq,
  };
}

/**
 * One fighter as a row: portrait, then nation, squad and rating stacked beside it. A row rather than
 * a column because a 282px phone column cannot hold two side-by-side cards *and* a crest between
 * them — stacked, the rival owns the top, you own the bottom, and the crest sits on the seam.
 */
function paintSide(host: Element, side: 'you' | 'rival', f: Fighter, copy: ClashCopy): void {
  const card = el('div', `vsc-side vsc-side--${side}`, host);
  card.dataset.tier = f.tier;

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

  const id = el('div', 'vsc-id', card);

  /* the top line carries the role, the name and the number: the rank word sits under it */
  const top = el('div', 'vsc-top', id);
  label('vsc-role', side === 'you' ? copy.youLabel : copy.rivalLabel, top);
  el('h3', 'vsc-name', top).textContent = f.name;
  if (f.rankKnown) {
    const rank = el('div', 'vsc-rank', top);
    glyph('i-brain', rank);
    label('vsc-tiq', f.tiq > 0 ? f.tiq.toLocaleString('en-US') : '0', rank);
  }

  /* nation: the CDN flag with the ISO chip under it, so a blocked CDN costs a photo, not a row */
  const nation = el('div', 'vsc-nation', id);
  nation.appendChild(flagPhoto(f.country || null, 'vsc-flag', 80));
  label('vsc-cc', f.country || '—', nation);
  label('vsc-country', f.country ? nameOf(f.country) : copy.noNation, nation);

  /* squad: the shield plate is the tribal bit — one of these crests is about to be beaten */
  const squad = el('div', 'vsc-squad', id);
  squad.dataset.kind = f.squadCrest ? 'bound' : 'lone';
  if (f.squadCrest) {
    const plate = el('span', 'vsc-crest', squad);
    glyph('i-shield', plate);
    label('vsc-crest-t', f.squadCrest, plate);
    squad.title = f.squad;
  }
  el('span', 'vsc-squad-t', squad).textContent = f.squad;

  if (f.rankKnown) label('vsc-tier', TIER_NAME[f.tier], id);
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
  /* a four-seat room puts one headliner on the crest: a person before a machine, then the sharper mind */
  const rival = rivals
    .map((r) => rivalFighter(r, stakes))
    .reduce((best, f) => (f.score > best.score ? f : best));

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

  /* rival on top, you underneath, the crest on the seam between them — the brief's Top-Right and
     Bottom-Left split, turned into a stack because a phone column has no left and right to spare */
  paintSide(grid, 'rival', rival, copy);

  const core = el('div', 'vsc-core', grid);
  el('span', 'vsc-ring', core);
  el('span', 'vsc-ring vsc-ring--late', core);
  const crest = el('div', 'vsc-crest-holder', core);
  glyph('i-bolt', crest, 'vsc-crest-bolt vsc-crest-bolt--l');
  glyph('i-bolt', crest, 'vsc-crest-bolt vsc-crest-bolt--r');
  el('span', 'vsc-vs', crest).textContent = 'VS';
  crest.setAttribute('aria-hidden', 'true');

  /* the stakes ride directly under the crest, which is where a wager belongs */
  const stakesPill = el('div', 'vsc-stakes', core);
  const seatWord = stakes.kind === 'ranked' ? copy.modeRanked
    : stakes.kind === 'bot' ? copy.modeBot : copy.modeRoom;
  label('vsc-stakes-mode', seatWord, stakesPill);
  /* the machine's level, named: "Bot Duel · HARD" is a challenge, "Bot Duel" is a setting */
  if (stakes.tier) label('vsc-stakes-tier', stakes.tier.toUpperCase(), stakesPill);
  if ((stakes.seats ?? 2) > 2) label('vsc-stakes-seats', `${stakes.seats}P`, stakesPill);
  if (rival.tiq > 0 && you.tiq > 0) {
    el('span', 'vsc-stakes-dot', stakesPill);
    label('vsc-stakes-gap', `${copy.mindGap} ${Math.abs(rival.tiq - you.tiq).toLocaleString('en-US')}`, stakesPill);
  }

  /* your side takes the bottom half, the ground you are defending */
  paintSide(grid, 'you', you, copy);

  /* the war cry */
  const banner = el('div', 'vsc-banner', shake);
  const line = el('p', 'vsc-line', banner);
  line.dir = copy.dir;
  line.lang = lang;
  let index = 0;
  const paint = () => { line.textContent = copy.lines[index % copy.lines.length]; };
  paint();

  el('p', 'vsc-skip', shake).textContent = copy.skip;

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
