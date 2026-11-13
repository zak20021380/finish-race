/**
 * home.ts — Home: identity card, flexible highlights, then the single Play launcher.
 *
 * Home never scrolls vertically; the carousel is the one horizontal gesture
 * (a composited `translate3d` track + `touch-action: pan-y`), so a swipe runs on
 * the GPU. It only advances on direct input — no idle loop, no timer churn.
 * Each slide is locked to one shared fixed height inside an overflow-hidden
 * viewport, so only the active slide shows and switching can never shift the
 * container. `.is-active` marks the slide in focus (state binding preserved).
 * Three slides, in this order: Channel War (index 0, the hero the Play tab
 * opens on), Nations Cup, The Mind Ladder.
 *
 * The PLAY key opens the "Select Game Mode" drawer on the Practice card, already
 * expanded to its difficulty and seat pills; the drawer's bottom Start is the one
 * key that launches (see gamemodes.ts / main.ts `launchSelectedMode`). The legacy
 * "Choose mode" sheet is still wired for the team presets: a 2-column grid of
 * preset cards with live renderer previews, a Custom entry that opens the team
 * builder and a sticky Start button whose label updates live.
 */
import type { Difficulty } from './bot';
import { bindSwipe } from './carousel';
import { lang, menuState, motionReduced, onLang, saveMenu, t } from './settings';
import { nameOf } from './countries';
import { fetchNationBoard, type NationFeed, type NationRow } from './nations';
import { fetchMindLadder, type MindFeed, type MindRowData } from './minds';
import { myTiq } from './matchmaking';
import { formatCountdown, getGrandCup, paidPlaces, type GrandCup } from './data';
import { arena } from './arenaState';
import { adoptUserStorageKey, onChange, profile, theme } from './storage';
import { impact } from './telegram';
import { flagPhoto } from './flags';
import { getSquadRanking } from './squads';
import { newGame } from './rules';
import { createRenderer, type View } from './render';
import type { Router } from './router';
import type { Sheets } from './sheets';
import { openEnlistSquad, type RaceSetup } from './menu';
import {
  onGameModeChange, paintLobby as paintGameLobby, paintSheetState as paintGameSheet,
  resetSheetView, setGameMode,
} from './gamemodes';
import starsImg from './assets/images/telegram_stars.png';

export interface HomeApi {
  router: Router;
  sheets: Sheets;
  start(setup: RaceSetup): void;
  /** The Channel War seat drawer's one door: the arena queue. */
  queue(mode?: 'pvp' | 'arena'): void;
}

/** Persian figures for the countdown only: a ticking clock beside Persian copy reads as an error.
 *  The leaderboard carousel deliberately never calls this — its digits are Latin in every language. */
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const localDigits = (value: string, code: string): string =>
  code === 'fa' ? value.replace(/\d/g, (d) => FA_DIGITS[Number(d)]) : value;

/** Persian prose never zero-pads: "۰۲ ساعت" reads as a glitch, "۲ ساعت" reads as Farsi.
 *  The Latin clock keeps its padding because "02h 45m" is a code, not a sentence. */
const localNumber = (value: number, code: string): string =>
  localDigits(code === 'fa' ? String(value) : String(value).padStart(2, '0'), code);

/**
 * Paints a translated template that carries `{placeholders}` inside a right-to-left
 * sentence. Each substituted value gets its own `<bdi>`: a single flat text run lets
 * the bidi algorithm promote the digits to their own level and reorder them against
 * the prose, which is what stranded the hour at the far end of the countdown.
 */
const paintBidi = (host: HTMLElement, template: string, vars: Record<string, string>): void => {
  host.textContent = '';
  let cut = 0;
  for (const found of template.matchAll(/\{\w+\}/g)) {
    const at = found.index ?? 0;
    if (at > cut) host.append(template.slice(cut, at));
    const value = vars[found[0].slice(1, -1)];
    if (value) {
      const iso = document.createElement('bdi');
      iso.textContent = value;
      host.append(iso);
    }
    cut = at + found[0].length;
  }
  if (cut < template.length) host.append(template.slice(cut));
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const cap = (d: Difficulty): string => d.charAt(0).toUpperCase() + d.slice(1);

export type ModePreset = '1v1' | '2v2' | '3v3' | '2v1';
export type ModeId = ModePreset | 'custom';

export const PRESETS: Record<ModePreset, [number, number]> = {
  '1v1': [1, 1],
  '2v2': [2, 2],
  '3v3': [3, 3],
  '2v1': [2, 1],
};

const PRESET_ORDER: ModePreset[] = ['1v1', '2v2', '3v3', '2v1'];

export function modeIdOf(sizes: readonly [number, number] | readonly number[]): ModeId {
  const a = sizes[0];
  const b = sizes[1];
  if (a === 1 && b === 1) return '1v1';
  if (a === 2 && b === 2) return '2v2';
  if (a === 3 && b === 3) return '3v3';
  if (a === 2 && b === 1) return '2v1';
  return 'custom';
}

function sizesOf(preset: ModePreset): [number, number] {
  const s = PRESETS[preset];
  return [s[0], s[1]];
}

/** "1v1 · Normal" / "2v2 · Hard" / "Custom 2v1 · Easy" — the Play summary. */
export function lastModeLabel(): string {
  const d = cap(menuState.difficulty);
  const [a, b] = menuState.sizes;
  const id = modeIdOf(menuState.sizes);
  if (id === 'custom') return `Custom ${a}v${b} · ${d}`;
  return `${id} · ${d}`;
}

function isDiff(v: string | undefined): v is Difficulty {
  return v === 'easy' || v === 'normal' || v === 'hard';
}

function isPreset(v: string | undefined): v is ModePreset {
  return v === '1v1' || v === '2v2' || v === '3v3' || v === '2v1';
}

const DIFF_HINT: Record<Difficulty, string> = {
  easy: 'Relaxed pace — the bot rarely walls.',
  normal: 'Balanced play — the bot walls when it pays off.',
  hard: 'Sharpest play — the bot walls often and races cleanly.',
};

export function createHome(api: HomeApi): { setRoute(id: string): void } {
  const homeScreen = $('s-home');
  const carousel = $('home-carousel') as HTMLElement;
  const track = $('home-carousel-track') as HTMLElement;
  const dots = [...document.querySelectorAll<HTMLButtonElement>('#home-dots .dot')];
  const slides = [...track.querySelectorAll<HTMLElement>('.car-card')];

  /* ---------- carousel: one transform state + direct input only ---------- */

  /* The settled slide index is the only carousel state. The track is a composited
     flex row: every commit is one `translate3d(-index * 100%)`, so a swipe never
     touches layout and the three fixed-height slides cannot shift the container. */
  let activeIndex = 0;
  const clampIndex = (i: number): number => Math.min(slides.length - 1, Math.max(0, i));

  const activeSlide = (): number => activeIndex;

  const paintSlide = (index: number, animate: boolean): void => {
    if (animate && !motionReduced()) {
      track.style.transition = '';
      track.style.transform = `translate3d(${-index * 100}%, 0, 0)`;
    } else {
      track.style.transition = 'none';
      track.style.transform = `translate3d(${-index * 100}%, 0, 0)`;
    }
  };

  let paintedSlide = -1;

  const paintDots = (force = false): void => {
    const a = activeSlide();
    if (!force && a === paintedSlide) return;
    paintedSlide = a;
    for (const d of dots) {
      const on = Number(d.dataset.dot) === a;
      d.classList.toggle('on', on);
      d.setAttribute('aria-selected', String(on));
    }
    // contained slider: only the active slide is visible; mark it for state/CSS
    for (const c of slides) c.classList.toggle('is-active', Number(c.dataset.slide) === a);
    syncDots();
  };

  /* Dots sit inside the card, centered, 8px from its bottom edge. Every card
     stretches to the same carousel-row geometry, so one measurement per
     resize (cached — no scroll-time layout work) is enough. The CSS `bottom`
     stays as the no-JS fallback. */
  const dotsBox = document.getElementById('home-dots') as HTMLElement | null;
  const DOTS_H = 20;
  const DOTS_GAP = 8;
  let dotsTop = -1;
  const syncDots = (): void => {
    if (!dotsBox) return;
    const host = dotsBox.parentElement;
    const card = slides[activeSlide()];
    if (!host || !card) return;
    const hr = host.getBoundingClientRect();
    const crd = card.getBoundingClientRect();
    if (hr.height === 0 || crd.height === 0) return;
    const top = Math.max(0, crd.bottom - hr.top - DOTS_GAP - DOTS_H);
    if (Math.abs(top - dotsTop) > 0.5) {
      dotsTop = top;
      dotsBox.style.top = `${top}px`;
      dotsBox.style.bottom = 'auto';
    }
  };

  /* One eased step to the settled neighbour. The dots paint on release, before the
     230ms composited transform starts, so the pager never lags the finger. Reduced
     motion jumps straight there. */
  const goSlide = (i: number): void => {
    const n = clampIndex(i);
    activeIndex = n;
    paintDots(true);
    paintSlide(n, true);
  };

  for (const d of dots) {
    d.addEventListener('click', () => {
      impact('light');
      goSlide(Number(d.dataset.dot));
    });
  }

  /* The one horizontal gesture: a drag follows the finger 1:1 but can only ever
     commit to the neighbouring slide (see carousel.ts). The settled index above is
     the single source of truth for the transform and the pager. */
  bindSwipe({
    el: carousel,
    track,
    count: () => slides.length,
    index: activeSlide,
    goTo: goSlide,
    reduced: motionReduced,
  });

  // Keep the inside-dots glued to the card bottom across resizes/rotations.
  const remeasure = (): void => { syncDots(); };
  try {
    /* All three slides are locked to the same height, so the pager never moves on a
       swipe; observing keeps it exact through font swaps and language switches. */
    const observer = new ResizeObserver(remeasure);
    observer.observe(carousel);
    for (const slide of slides) observer.observe(slide);
  } catch {
    /* ResizeObserver unavailable — CSS fallback + paintDots cover it */
  }
  window.addEventListener('resize', remeasure);

  /* ---------- Nations Cup: a spacious Top-3 preview + standing bar / full-board CTA ----------
     The carousel slide is a PREVIEW, hard-limited to three 44px rows. The complete ladder
     lives only in the Ranks board behind `#home-cup-table` (`#sheet-nations` drawer). Data
     is the live Worker ledger (`fetchNationBoard`): real registered players grouped by
     country, strictly descending by calculated avgTiq, with no baseline, seed or filler —
     a registry holding two nations paints exactly two rows. Flags come from the shared CDN
     resolver in a 28px circle. The foot pill mirrors `nations[0]`, the reigning champion. */

  const PODIUM_CLASS = ['gold', 'silver', 'bronze'] as const;
  /** The last live board read — kept so a language switch or an offline poll can repaint the
   *  standing bar without inventing a number. */
  let nationFeed: NationFeed | null = null;

  const monogramOf = (name: string): string => {
    const parts = name.trim().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 0) return '•';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0].slice(0, 1) + parts[1].slice(0, 1)).toUpperCase();
  };

  /** Fit a one-line label inside its own box by scaling the type down a little.
   *  The country board must never render a mid-word ellipsis; this keeps the
   *  longest nation name on a single line without letting it paint over the score. */
  const fitOneLine = (el: HTMLElement, minPx = 9): void => {
    el.style.removeProperty('font-size');
    el.classList.remove('is-wrapped');
    el.style.whiteSpace = 'nowrap';
    const max = parseFloat(getComputedStyle(el).fontSize);
    if (!Number.isFinite(max) || el.clientWidth <= 0) return;
    let size = max;
    while (size > minPx && el.scrollWidth > el.clientWidth + 0.5) {
      size = Math.max(minPx, size - 0.5);
      el.style.fontSize = `${size}px`;
    }
    /* The floor still overflows: wrap at word boundaries rather than clip a country
       name. The row's 44px band holds three short lines at this fallback size. */
    if (el.scrollWidth > el.clientWidth + 0.5) {
      el.classList.add('is-wrapped');
      el.style.whiteSpace = 'normal';
      el.style.fontSize = `${Math.max(7.5, minPx - 0.5)}px`;
    }
  };

  /** The TIQ brand mark worn by a nation's score: the glowing brain sprite. */
  const brainIcon = (cls: string): SVGSVGElement => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('viewBox', '0 0 24 24');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-brain');
    svg.append(use);
    svg.setAttribute('aria-hidden', 'true');
    return svg;
  };

  /** The national rating as a branded lockup: value + TIQ unit + neon brain, never a bare number. */
  const nationScore = (pts: string): HTMLDivElement => {
    const wrap = document.createElement('div');
    wrap.className = 'nation-score-wrap';
    const val = document.createElement('span');
    val.className = 'score-val';
    val.textContent = pts;
    const unit = document.createElement('span');
    unit.className = 'score-tiq';
    unit.textContent = 'TIQ';
    unit.setAttribute('aria-hidden', 'true');
    wrap.append(val, unit, brainIcon('score-brain-icon'));
    return wrap;
  };

  const rowEl = (c: NationRow, me: boolean): HTMLLIElement => {
    const li = document.createElement('li');
    li.classList.add('nations-row');
    li.classList.add(`rank-${c.rank}`);
    if (me) li.classList.add('me');
    const label = c.name || nameOf(c.code);
    /* The board's figures are Latin integers in both languages: `en-US` grouping keeps the
       thousands separators, and the rounded value is the Worker's own representative average. */
    const avg = Math.round(c.avg);
    const pts = avg.toLocaleString('en-US');
    /* Every row is a real flag: the sample it quotes is the sample the Worker actually used. */
    const sample = Math.min(10, Math.max(1, c.warriors));
    const sampleText = `top ${sample} ${sample === 1 ? 'warrior' : 'warriors'}`;
    const trendLabel = c.trend === 'up'
      ? `rising ${Math.abs(c.delta)}`
      : c.trend === 'down' ? `dropping ${Math.abs(c.delta)}` : 'steady';
    const rosterText = `${c.warriors.toLocaleString('en-US')} rated warriors`;
    li.setAttribute('aria-label', `#${c.rank} ${label} — ${pts} average TIQ, ${rosterText}, ${trendLabel}`);
    const rk = document.createElement('span');
    const podium = c.rank >= 1 && c.rank <= 3 ? PODIUM_CLASS[c.rank - 1] : '';
    rk.className = podium ? `rk rank-${c.rank} ${podium}` : `rk rank-${c.rank}`;
    rk.textContent = String(c.rank);
    rk.dir = 'ltr';
    rk.setAttribute('aria-hidden', 'true');
    const fl = document.createElement('span');
    fl.className = 'fl';
    fl.setAttribute('aria-hidden', 'true');
    fl.append(flagPhoto(c.code, 'fp-nation'));
    const nm = document.createElement('span');
    nm.className = 'nm';
    /* the nation is a Latin token on this board: isolate it so it never reorders
       against the Persian copy around it */
    nm.dir = 'ltr';
    nm.textContent = label;
    nm.title = label;
    /* Flag + name are one middle zone, so the row is a clean 3-track grid:
       [ rank badge ] [ flag + country ] [ score lockup ]. The old trend column
       (a bare "•" on steady rows) is gone — no orphan dot between name and score. */
    const identity = document.createElement('span');
    identity.className = 'nation-id';
    identity.append(fl, nm);
    const pt = nationScore(pts);
    pt.dir = 'ltr';
    pt.title = `${pts} average TIQ · ${sampleText}`;
    li.append(rk, identity, pt);
    return li;
  };

  /** A clean empty state: no flag, no rank, no invented score. */
  const emptyNationRow = (message: string): HTMLLIElement => {
    const li = document.createElement('li');
    li.className = 'nations-row is-error';
    li.textContent = message;
    return li;
  };

  /** The player's own national standing, painted into the two-sided HUD bar.
   *  LEFT = flag + full country name, with the rank chip and the reigning-champion chip
   *  on a quiet second line. RIGHT = the flag's representative average TIQ, the exact
   *  figure the rows above are ranked by, ending in the same brain token they wear.
   *  The name owns its own line, so a long country can never be crushed into an ellipsis
   *  by the chips. No nation is ever authored here: the champion label, code and
   *  accessible text all come from row #1 of the live board. */
  let nationMineKey = '';
  const paintNationMine = (feed: NationFeed | null): void => {
    const code = (profile.country ?? '').trim().toUpperCase();
    const nations = feed?.rows ?? [];
    const mine = code ? nations.find((c) => c.code === code) : undefined;
    /* Rank #1 of the descending board is the reigning champion. Everything the bottom pill
       quotes is derived from that one row, so it can never disagree with the rows above it. */
    const champion = nations[0] ?? null;
    const championLabel = champion ? (champion.name || nameOf(champion.code)) : '';
    const championScore = champion ? Math.round(champion.avg).toLocaleString('en-US') : '0';
    const key = `${lang}|${profile.country ?? ''}|${feed?.live ? 1 : 0}|${nations.length}`
      + `|${mine?.rank ?? ''}/${mine?.avg ?? ''}/${mine?.warriors ?? ''}`
      + `|${champion?.code ?? ''}/${champion?.avg ?? ''}/${championLabel}`;
    if (key === nationMineKey) return;
    nationMineKey = key;
    const bar = document.getElementById('home-nation-mine');
    /* The card's one door reads the seat, not the board: a flagless player is asked to
       represent, a player who already represents is asked to read the standings. Both land
       on the Nations board, where the flag picker already lives. Only the label node is
       rewritten — the chevron chip is a sibling and must survive the repaint. */
    const cta = document.querySelector<HTMLElement>('#home-cup-table .slide-cta-t');
    if (cta) cta.textContent = profile.country ? t('countryViewNations') : t('countryCtaFlyFlag');
    if (!bar) return;
    const flag = document.getElementById('home-nation-flag');
    const name = document.getElementById('home-nation-name');
    const rank = document.getElementById('home-nation-rank');
    const pill = document.getElementById('home-nation-pill');
    const pillK = document.getElementById('home-nation-pill-k');
    const pct = document.getElementById('home-nation-pct');
    const pts = document.getElementById('home-nation-pts');
    /* The badge quotes the same representative average the rows and the drawer read. It is
       deliberately not the seat's own TIQ: two metrics on one card is exactly the desync this
       bar used to show. A flag whose rated warriors all sit at zero has no average to quote —
       the dash says so instead of printing a "+0" that reads like a broken counter. */
    const avg = mine ? Math.round(mine.avg) : 0;
    const avgText = mine && avg > 0 ? `+${avg.toLocaleString('en-US')}` : '—';
    if (pts) pts.textContent = avgText;
    const unit = bar.querySelector<HTMLElement>('.hm-u');
    if (unit) unit.textContent = 'AVG TIQ';

    /* The rank chip is the seat's own board position, never the champion's. It lives on
       the quiet second line beside the champion chip, so it can never squeeze the name. */
    if (rank) {
      rank.hidden = !mine;
      rank.textContent = mine ? t('countryRankTag').replace('{rank}', String(mine.rank)) : '';
      rank.title = mine ? `${t('countryRankTag').replace('{rank}', String(mine.rank))}` : '';
    }

    /* The bottom champion pill mirrors nations[0]. Its code is a Latin token, isolated so a
       Persian label cannot reorder it; the full name and score ride on the title/aria text. */
    if (pillK) pillK.textContent = champion ? t('countryLeading') : t('hudYourNation');
    if (pct) {
      pct.hidden = !champion;
      pct.textContent = champion?.code ?? '';
      pct.dir = 'ltr';
      pct.title = championLabel;
    }
    if (pill) {
      pill.classList.toggle('is-off', !champion);
      pill.title = champion
        ? `${t('countryTopNation')}: ${championLabel} · ${championScore} AVG TIQ`
        : '';
    }

    const total = nations.length;
    const share = mine && total > 0
      ? Math.max(1, Math.round((mine.rank / total) * 100))
      : 0;
    const standing = mine ? `rank #${mine.rank} of ${total}` : 'unranked';
    const championFact = champion
      ? ` · ${t('countryTopNation')}: ${championLabel} (${champion.code})`
      : '';
    if (!code) {
      if (flag) { flag.textContent = ''; flag.classList.add('is-off'); }
      if (name) {
        name.textContent = t('hudPickNation');
        name.removeAttribute('title');
        name.dir = 'auto';
        fitOneLine(name, 9);
      }
      bar.setAttribute('aria-label', `${t('hudYourNation')}: ${t('hudPickNation')}, ${avgText} AVG TIQ${championFact}`);
      bar.removeAttribute('title');
      return;
    }
    const label = nameOf(code);
    if (flag) {
      flag.textContent = '';
      flag.classList.remove('is-off');
      flag.append(flagPhoto(code, 'hm-flag-plate'));
    }
    if (name) {
      name.textContent = label;
      name.title = label;
      name.dir = 'ltr';
      fitOneLine(name, 9);
    }
    bar.setAttribute('aria-label', mine
      ? `${label} · #${mine.rank} · ${t('hudTop')} ${share}% · ${avgText} AVG TIQ${championFact}`
      : `${label} · ${avgText} AVG TIQ${championFact}`);
    bar.setAttribute('title', champion
      ? `You fight for ${label} — ${standing}. ${t('countryTopNation')}: ${championLabel} · ${championScore} average TIQ`
      : `You fight for ${label} — ${standing}`);
  };

  /** The carousel is a PREVIEW only: three spacious rows, or the honest empty line. The full
   *  ladder lives exclusively in the slide-out Nations board behind `#home-cup-table`.
   *  One painter for both the poll and a language switch, so the digits and the empty-state
   *  copy always match the language on screen. */
  let nationListKey = '';
  const paintNationList = (): void => {
    const nations = nationFeed?.rows ?? [];
    const preview = nations.slice(0, 3);
    const feedKey = nationFeed
      ? `${nationFeed.live ? 1 : 0}:${preview.map((c) => `${c.rank},${c.code},${c.avg},${c.warriors},${c.trend},${c.delta}`).join(';')}`
      : 'none';
    const key = `${lang}|${profile.country ?? ''}|${feedKey}`;
    if (key === nationListKey) return;
    nationListKey = key;
    const list = $('home-countries');
    list.textContent = '';
    if (!nationFeed) {
      list.append(emptyNationRow(t('countryBoardOffline')));
      return;
    }
    if (!nations.length) {
      list.append(emptyNationRow(t('countryBoardEmpty')));
      return;
    }
    /* A registry with one or two real countries paints one or two rows. Never pad to three. */
    const myCode = (profile.country ?? '').trim().toUpperCase();
    for (const c of preview) list.append(rowEl(c, myCode === c.code));
    /* The row is created after layout has settled, so measure once the browser has
       assigned the middle track its real width. Long names scale down instead of clipping. */
    requestAnimationFrame(() => {
      list.querySelectorAll<HTMLElement>('.nm').forEach((el) => fitOneLine(el, 9));
    });
  };

  /* Rotation or a split-screen resize changes the middle track; re-fit both the
     three preview names and the pinned country name without repainting the board. */
  window.addEventListener('resize', () => {
    document.querySelectorAll<HTMLElement>('#home-countries .nm').forEach((el) => fitOneLine(el, 9));
    const name = document.getElementById('home-nation-name');
    if (name) fitOneLine(name, 9);
  });

  /** Freshness gate for returning to the tab: a switch inside this window shows
   *  the mounted board as-is. Race results and saves already reload it via onChange. */
  const HOME_SYNC_MS = 20_000;
  let nationsSyncedAt = 0;
  let mindsSyncedAt = 0;

  const loadCountries = async (): Promise<void> => {
    nationsSyncedAt = Date.now();
    try {
      const feed = await fetchNationBoard(myTiq());
      /* A failed read keeps the last real board; a first read paints the clean waiting state. */
      if (feed.live) nationFeed = feed;
      paintNationList();
      paintNationMine(nationFeed);
    } catch {
      paintNationList();
      /* the bar is a structure of zones, never a text node: repaint the last board we
         hold instead of overwriting it with a sentence. */
      paintNationMine(nationFeed);
    }
  };

  document.getElementById('home-cup-table')?.addEventListener('click', () => {
    impact('light');
    try {
      api.router.go('ranks');
    } catch {
      /* router unavailable */
    }
    // Land on The Mind Ladder, then open the Nations IQ board — the cup table.
    window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>('.ranks-tabs [data-board="nations"]')?.click();
    }, 80);
  });

  /* ---------- The Mind Ladder: live TIQ telemetry + your cognitive standing ----------
     The card reads the Worker's own registry, so the mind on top of this card is the mind on
     top of the full ladder. Five slots are always painted: real players fill from rank 1 and
     the rest stay as frosted, dashed "Awaiting Challenger" slots, so the band never collapses
     on a quiet server. One row is one slab: [minted rank shield][ringed portrait][handle]
     [TIQ lockup] — the score column is the row's only right edge, and the trend is a bare
     tick on the handle instead of a capsule that ate the name's slack. */

  const MIND_SLOTS = 5;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  let mindFeed: MindFeed | null = null;
  let mindLoad = 0;

  /** The signature brain token: the same sprite the card's kicker wears. */
  const brainToken = (): HTMLElement => {
    const wrap = document.createElement('span');
    wrap.className = 'mind-brain';
    wrap.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'mind-brain-ico');
    svg.setAttribute('viewBox', '0 0 24 24');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-brain');
    svg.append(use);
    wrap.append(svg);
    return wrap;
  };

  /** A seat with no nation yet still wears an emblem: the tactix globe, not a blank chip. */
  const globeFlag = (): HTMLElement => {
    const flag = document.createElement('span');
    flag.className = 'mind-flag mind-flag-none';
    flag.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'mind-flag-ico');
    svg.setAttribute('viewBox', '0 0 24 24');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-globe');
    svg.append(use);
    flag.append(svg);
    return flag;
  };

  const scoreCell = (score: string, empty: boolean): HTMLElement => {
    const sc = document.createElement('span');
    sc.className = 'mind-score';
    sc.dir = 'ltr';
    sc.title = empty ? 'No TIQ yet' : `${score} TIQ`;
    const num = document.createElement('b');
    num.textContent = score;
    const unit = document.createElement('span');
    unit.className = 'mind-tiq-k';
    unit.textContent = 'TIQ';
    unit.setAttribute('aria-hidden', 'true');
    sc.append(num, unit, brainToken());
    return sc;
  };

  /** A minted rank shield. Gold #1 wears the micro-crown; silver and bronze their own metal;
   *  everything below the podium is slate. The numeral is bare — the shield already says rank. */
  const rankShield = (rank: number): HTMLElement => {
    const rk = document.createElement('span');
    const podium = rank >= 1 && rank <= 3 ? PODIUM_CLASS[rank - 1] : 'slate';
    rk.className = `mind-rank ${podium}`;
    rk.setAttribute('aria-hidden', 'true');
    if (rank === 1) {
      const crown = document.createElementNS(SVG_NS, 'svg');
      crown.setAttribute('class', 'mind-crown');
      crown.setAttribute('viewBox', '0 0 24 24');
      const use = document.createElementNS(SVG_NS, 'use');
      use.setAttribute('href', '#i-crown');
      crown.append(use);
      rk.append(crown);
    }
    const n = document.createElement('b');
    n.className = 'mind-rank-n';
    n.textContent = String(rank);
    rk.append(n);
    return rk;
  };

  const mindRow = (p: MindRowData): HTMLLIElement => {
    const li = document.createElement('li');
    li.className = 'mind-row';
    li.dataset.rank = String(p.rank);
    const score = p.tiq.toLocaleString('en-US');
    const trendWord = p.trend === 'up'
      ? `rising ${p.delta}`
      : p.trend === 'down'
        ? `dropping ${Math.abs(p.delta)}`
        : 'steady';
    li.setAttribute('aria-label', `#${p.rank} ${p.name} — ${score} TIQ, ${trendWord}`);
    const av = document.createElement('span');
    av.className = 'mind-av';
    av.setAttribute('aria-hidden', 'true');
    const ini = document.createElement('b');
    ini.className = 'mind-ini';
    ini.textContent = monogramOf(p.name);
    av.append(ini);
    if (/^https:\/\//i.test(p.avatar)) {
      const img = document.createElement('img');
      img.className = 'mind-av-img';
      img.alt = '';
      /* the podium is above the fold: fetched now. The rest of the band follows. */
      img.loading = p.rank <= 3 ? 'eager' : 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      if (p.rank <= 3) img.setAttribute('fetchpriority', 'high');
      img.addEventListener('error', () => img.remove());
      img.addEventListener('load', () => {
        if (img.naturalWidth <= 2 || img.naturalHeight <= 2) {
          img.remove();
          return;
        }
        img.classList.add('is-loaded');
      });
      img.src = p.avatar;
      av.append(img);
    }
    av.append(p.countryCode ? flagPhoto(p.countryCode, 'mind-flag') : globeFlag());
    /* the identity cell: the handle, then — only when the rank really moved — a bare
       delta tick. No capsule, so the name keeps every pixel of the row's slack. */
    const id = document.createElement('span');
    id.className = 'mind-id';
    const nm = document.createElement('span');
    nm.className = 'mind-nm';
    /* a handle is a Latin token: isolated so a leading @ or a trailing digit never
       swaps sides when the card is read in Persian */
    nm.dir = 'ltr';
    nm.textContent = p.name;
    nm.title = p.name;
    id.append(nm);
    if (p.trend !== 'same' && p.delta !== 0) {
      const d = document.createElement('i');
      d.className = `mind-delta ${p.trend}`;
      d.dir = 'ltr';
      d.textContent = p.trend === 'up'
        ? `▲${p.delta}`
        : `▼${Math.abs(p.delta)}`;
      d.title = trendWord;
      d.setAttribute('aria-hidden', 'true');
      id.append(d);
    }
    li.append(rankShield(p.rank), av, id, scoreCell(score, false));
    return li;
  };

  /** One unoccupied rank: the same row skeleton as a frosted dashed slot with a lock glyph,
   *  so an empty seat reads as reserved — never as a broken or collapsed row. */
  const emptyMindRow = (rank: number): HTMLLIElement => {
    const li = document.createElement('li');
    li.className = 'mind-row is-empty';
    li.dataset.rank = String(rank);
    li.setAttribute('aria-label', `#${rank} — Awaiting Challenger, no TIQ yet`);
    const av = document.createElement('span');
    av.className = 'mind-av mind-av-empty';
    av.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'mind-av-ico');
    svg.setAttribute('viewBox', '0 0 24 24');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-lock');
    svg.append(use);
    av.append(svg);
    const id = document.createElement('span');
    id.className = 'mind-id';
    const nm = document.createElement('span');
    nm.className = 'mind-nm';
    nm.textContent = t('ladderAwaitingChallenger');
    nm.title = nm.textContent;
    id.append(nm);
    li.append(rankShield(rank), av, id, scoreCell('—', true));
    return li;
  };

  const paintMindTop = (feed: MindFeed | null): void => {
    const el = document.getElementById('mind-top');
    if (!el) return;
    const season = document.getElementById('mind-season');
    const label = t('ladderSeason').replace('{season}', String(arena().seasonNo));
    if (season) season.textContent = label;
    const live = Boolean(feed?.live && feed.total > 0);
    el.classList.toggle('is-live', live);
    const total = feed?.total ?? 0;
    if (live) {
      const minds = t('ladderOfMinds').replace('{count}', total.toLocaleString('en-US'));
      el.setAttribute('title', `${label} · ${minds}`);
      el.setAttribute('aria-label', `${label} — ${minds}`);
      return;
    }
    el.setAttribute('title', `${label} · ladder offline`);
    el.setAttribute('aria-label', `${label} — ladder offline`);
  };

  /** The player's own global standing, painted into the same 3-zone HUD bar:
   *  LEFT = the glowing rank badge + YOU · CENTER = the field it is ranked inside
   *  ("of 1,204 minds") · RIGHT = the TIQ, right-aligned under the score column of #1–#5. */
  const paintMindMine = (feed: MindFeed | null): void => {
    const bar = document.getElementById('home-mind-mine');
    if (!bar) return;
    const name = document.getElementById('home-mind-name');
    const rankEl = document.getElementById('home-mind-rank');
    const pill = document.getElementById('home-mind-pill');
    const pillK = document.getElementById('home-mind-pill-k');
    const field = document.getElementById('home-mind-field');
    const fieldU = document.getElementById('home-mind-field-u');
    const tiqEl = document.getElementById('home-mind-tiq');
    const tiqText = myTiq().toLocaleString('en-US');
    if (name) name.textContent = t('ladderYouLabel');
    if (tiqEl) tiqEl.textContent = tiqText;
    const st = feed?.live ? feed.standing : null;
    if (st) {
      const total = st.total.toLocaleString('en-US');
      if (rankEl) { rankEl.textContent = `#${st.rank}`; rankEl.classList.remove('is-off'); }
      /* the field pill is one translated sentence split around the number, so the
         numeral keeps its own emphasized node whatever order the language puts it in */
      const parts = t('ladderOfMinds').split('{count}');
      if (pillK) pillK.textContent = (parts[0] ?? '').trim();
      if (field) { field.hidden = false; field.textContent = total; }
      if (fieldU) { fieldU.hidden = false; fieldU.textContent = (parts[1] ?? '').trim(); }
      pill?.classList.remove('is-off');
      bar.setAttribute('aria-label', `${t('ladderYouLabel')} · rank ${st.rank} of ${total} · ${tiqText} TIQ`);
      bar.setAttribute('title', `Rank ${st.rank} of ${total} minds`);
      return;
    }
    if (rankEl) { rankEl.textContent = '—'; rankEl.classList.add('is-off'); }
    if (pillK) pillK.textContent = t('hudUnranked');
    if (field) { field.hidden = true; field.textContent = ''; }
    if (fieldU) { fieldU.hidden = true; fieldU.textContent = ''; }
    pill?.classList.add('is-off');
    bar.setAttribute('aria-label', `${t('ladderYouLabel')} · ${t('hudUnranked')} · ${tiqText} TIQ`);
    if (feed?.live) bar.setAttribute('title', 'Your TIQ enters the ladder after your first live TIQ');
    else bar.removeAttribute('title');
  };

  let mindKey = '';
  const paintMinds = (feed: MindFeed | null): void => {
    const rows = feed?.rows ?? [];
    const key = `${lang}|${myTiq()}|${arena().seasonNo}|${feed?.live ? 1 : 0}|${feed?.total ?? 0}`
      + `|${feed?.standing ? `${feed.standing.rank}/${feed.standing.total}` : ''}`
      + `|${rows.slice(0, MIND_SLOTS)
        .map((p) => `${p.rank},${p.name},${p.tiq},${p.trend},${p.delta},${p.avatar},${p.countryCode}`)
        .join(';')}`;
    if (key === mindKey) return;
    mindKey = key;
    const list = document.getElementById('home-minds');
    if (!list) return;
    list.textContent = '';
    for (let i = 0; i < MIND_SLOTS; i++) {
      const row = rows[i];
      list.append(row ? mindRow(row) : emptyMindRow(i + 1));
    }
    paintMindTop(feed);
    paintMindMine(feed);
  };

  /* The season is local truth: stamp the crest now, so the header never flashes a
     placeholder number while the first ladder read is still on the wire. */
  paintMindTop(null);

  const loadMinds = async (): Promise<void> => {
    mindsSyncedAt = Date.now();
    const seq = ++mindLoad;
    if (mindFeed) paintMindMine(mindFeed);
    const next = await fetchMindLadder(myTiq(), MIND_SLOTS);
    if (seq !== mindLoad) return;
    /* A failed read keeps the last real board; a first read paints the five placeholder slots. */
    if (next.live || !mindFeed) {
      mindFeed = next;
      paintMinds(next);
      return;
    }
    paintMindMine(mindFeed);
  };

  document.getElementById('home-mind-cta')?.addEventListener('click', () => {
    impact('light');
    api.router.go('ranks');
  });

  /* The card stays fresh while it is on screen: a slow poll, plus the save watcher above which
     already fires after every race. A hidden tab costs no network. */
  window.setInterval(() => {
    const home = document.getElementById('s-home');
    if (!document.hidden && home && !home.hidden) void loadMinds();
  }, 30_000);
  document.addEventListener('visibilitychange', () => {
    const home = document.getElementById('s-home');
    if (!document.hidden && home && !home.hidden) void loadMinds();
  });

  /* ---------- Channel War: Home's hero slide is the one door ----------
     The Arena is a progression road now, so the tournament's only entry lives
     here. The CTA opens the same seat drawer the cup used to own and hands a
     locked seat straight to the arena queue; the Arena screen never links back
     to the channel bracket, a squad selector or a tournament ladder. */

  const CHANNEL_SEAT_KEY = adoptUserStorageKey('detour.arena.seat.v1');

  const channelSeatFor = (cupId: string): boolean => {
    try {
      const raw = window.localStorage.getItem(CHANNEL_SEAT_KEY);
      if (!raw) return false;
      const seat = JSON.parse(raw) as { cup?: unknown } | null;
      return seat?.cup === cupId;
    } catch {
      return false;
    }
  };

  const seatChannelWar = (cupId: string): void => {
    try {
      window.localStorage.setItem(CHANNEL_SEAT_KEY, JSON.stringify({ cup: cupId, at: Date.now() }));
    } catch {
      /* the queue still opens */
    }
  };

  let channelCup: GrandCup | null = null;
  let channelCupRequest: Promise<void> | null = null;

  const paintChannelSheet = (): void => {
    if (!channelCup) return;
    const cup = channelCup;
    const paid = paidPlaces(cup);
    const taken = Math.max(0, Math.min(cup.players, cup.maxPlayers));
    const pct = Math.round((taken / cup.maxPlayers) * 100);
    const format = cup.specs[cup.specs.length - 1] || '8s Blitz';
    setSheetText('stars-sheet-desc', `Represent your channel in the ${format} championship`);
    setSheetText('stars-sheet-prize', `${cup.stars} Stars reward`);
    setSheetText('stars-sheet-prize-note', `Top ${paid} contributors`);
    setSheetText('stars-sheet-entry', cup.entry);
    setSheetText('stars-sheet-start', formatCountdown(cup.startsAt));
    setSheetText('stars-sheet-seat', `${taken} / ${cup.maxPlayers}`);
    setSheetText('stars-sheet-pct', `${pct}% full`);
    setSheetText('stars-sheet-perk', `Top ${paid} contributors share the Star pool`);
    const left = cup.maxPlayers - taken;
    setSheetText('stars-sheet-seat-note', left > 0
      ? `${left} seats left before the field closes`
      : 'The field is full — wait for the next bracket');
    const meter = document.getElementById('stars-sheet-meter');
    if (meter) meter.style.width = `${pct}%`;
    const gauge = document.querySelector('#sheet-stars .tp-meter');
    if (gauge) gauge.setAttribute('aria-valuenow', String(pct));
  };

  /* The pass keeps its own clock: the countdown is the one figure on the card that
     moves, so it ticks once a second while the pass is raised and the tab is visible. */
  window.setInterval(() => {
    if (!channelCup || document.hidden) return;
    const sheet = document.getElementById('sheet-stars');
    if (!sheet || sheet.hidden) return;
    setSheetText('stars-sheet-start', formatCountdown(channelCup.startsAt));
  }, 1000);

  const loadChannelCup = (): Promise<void> => {
    if (channelCup) return Promise.resolve();
    if (!channelCupRequest) {
      channelCupRequest = getGrandCup()
        .then((cup) => {
          channelCup = cup;
          paintChannelSheet();
        })
        .catch(() => { /* the markup keeps its authored copy */ })
        .finally(() => { channelCupRequest = null; });
    }
    return channelCupRequest;
  };

  function setSheetText(id: string, text: string): void {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  document.getElementById('home-tournament-cta')?.addEventListener('click', (event) => {
    /* A scripted click is NOT a tap. The pass may only ever be raised by a real gesture on this
       banner, so no boot path, restore or synthetic trigger can cover someone's first screen. */
    if (!event.isTrusted) return;
    impact('medium');
    if (channelCup && channelSeatFor(channelCup.id)) {
      api.queue('arena');
      return;
    }
    void loadChannelCup();
    paintChannelSheet();
    const sheet = document.getElementById('sheet-stars');
    if (sheet) api.sheets.open(sheet);
    else api.queue('arena');
  });

  document.getElementById('stars-sheet-yes')?.addEventListener('click', () => {
    impact('medium');
    if (channelCup) seatChannelWar(channelCup.id);
    api.sheets.close();
    api.queue('arena');
  });

  /* Warm the drawer's numbers in the background so the first tap is already live. */
  void loadChannelCup();

  /* The hero's Star is the authentic Telegram Stars PNG, bundled by Vite (never a
     hotlinked URL) and mounted once; the glow, dish and levitation are pure CSS. */
  const tourStar = document.getElementById('tour-star-img') as HTMLImageElement | null;
  if (tourStar) tourStar.src = starsImg;

  /* The enlistment pod: the channel-admin growth door. It fires a light haptic and
     raises the Enlist Squad modal — the registration path that verifies the
     community with Telegram (type, public status, duplicates) and writes it
     through the Worker, no bot-chat hop in the way. */
  document.getElementById('home-tournament-admin')?.addEventListener('click', () => {
    impact('light');
    openEnlistSquad();
  });

  /* The leader ticker reads the same ranking feed Channel War ranks, so the hero
     slide's champion and the tournament can never disagree about who leads. With
     no seeded field the board starts empty, so the plaque flips to its war-dare
     state instead of standing as a neutral placeholder. */
  const leaderPlaque = document.getElementById('tour-champion-plaque');
  const leaderKicker = document.getElementById('tour-leader-kicker');
  const leaderHandle = document.getElementById('tour-leader-handle');
  /* Both lines are painted here (and on every language switch) rather than left
     in the markup for a `data-i18n` sweep to overwrite the live handle with. */
  const paintTourLeader = (): void => {
    const top = getSquadRanking()[0];
    leaderPlaque?.classList.toggle('is-reigning', Boolean(top));
    leaderPlaque?.classList.toggle('is-unclaimed', !top);
    if (leaderKicker) {
      leaderKicker.textContent = t(top ? 'carouselReigningChampion' : 'carouselUnclaimedThrone');
    }
    if (leaderHandle) {
      leaderHandle.textContent = top ? top.handle : t('carouselSeizeThrone');
      /* A handle is always LTR; the unclaimed dare follows its own script. */
      leaderHandle.dir = top ? 'ltr' : 'auto';
    }
  };
  paintTourLeader();

  /* The HUD's clock. Anchored to a real deadline 02h 45m out, so the capsule
     reads exactly as authored on arrival and then ticks honestly; it is only
     repainted while the tab is visible. */
  const tourClock = document.getElementById('tour-countdown');
  if (tourClock) {
    const endsAt = Date.now() + (2 * 60 + 45) * 60_000;
    const paintClock = (): void => {
      // Round up: 02h 45m out reads "02h 45m left", not "02h 44m left", on arrival.
      const totalMin = Math.max(0, Math.ceil((endsAt - Date.now()) / 60_000));
      paintBidi(tourClock, t('carouselTimeLeft'), {
        hours: localNumber(Math.floor(totalMin / 60), lang),
        mins: localNumber(totalMin % 60, lang),
      });
    };
    paintClock();
    /* The clock reads in whole minutes: a 30s beat keeps it honest without a
       wake-up every second, and a hidden Home panel paints nothing. */
    window.setInterval(() => {
      if (!document.hidden && !homeScreen.hidden) paintClock();
    }, 30_000);
    onLang(paintClock);
  }
  onLang(paintTourLeader);

  /* ---------- launcher: one Play button + summary + sheet draft ---------- */

  const homePlay = $('home-play') as HTMLButtonElement;
  const sheetMode = document.getElementById('sheet-mode') as HTMLElement | null;
  const modeCards = [...document.querySelectorAll<HTMLButtonElement>('.mode-card[data-mode]')];
  const diffBtns = [...document.querySelectorAll<HTMLButtonElement>('.seg-b[data-mdiff]')];
  const modeHint = document.getElementById('mode-hint') as HTMLElement | null;
  const modeStart = document.getElementById('mode-start') as HTMLButtonElement | null;
  const modeCustom = document.getElementById('mode-custom') as HTMLButtonElement | null;

  // Draft edited inside the sheet; committed to menuState on every tap so Home
  // and the sticky Start stay in sync even if the sheet is dismissed.
  let draftMode: ModePreset = '1v1';
  let draftDiff: Difficulty = 'normal';

  const syncDraftFromMenu = (): void => {
    const id = modeIdOf(menuState.sizes);
    draftMode = id === 'custom' ? '1v1' : id;
    // If the saved size is custom, keep showing it on Home but edit a preset.
    // When the saved size is a preset, the draft starts there.
    if (id !== 'custom') draftMode = id;
    draftDiff = menuState.difficulty;
  };

  const MODE_TITLES: Record<ModePreset, string> = {
    '1v1': '1v1 Duel',
    '2v2': '2v2 Party',
    '3v3': '3v3 Party',
    '2v1': '2v1 Clash',
  };

  const MODE_ICONS: Record<ModePreset | 'custom', string> = {
    '1v1': '#i-user',
    '2v2': '#i-users',
    '3v3': '#i-users',
    '2v1': '#i-users',
    custom: '#i-users',
  };

  // Game Mode Selector owns the lobby card: icon, title, status dot, subtitle.
  const paintLauncher = paintGameLobby;

  const paintSheet = (): void => {
    for (const b of modeCards) {
      const on = b.dataset.mode === draftMode;
      b.setAttribute('aria-checked', String(on));
    }
    for (const b of diffBtns) {
      b.setAttribute('aria-pressed', String(b.dataset.mdiff === draftDiff));
    }
    if (modeHint) modeHint.textContent = DIFF_HINT[draftDiff];
    if (modeStart) {
      const label = `Start ${draftMode} · ${cap(draftDiff)}`;
      modeStart.textContent = label;
      modeStart.setAttribute('aria-label', label);
    }
  };

  /* Mini board illustrations: the real renderer pointed at a 6x4 patch with
     each preset's ball counts. Your first ball wears the selection ring. */
  const previewRenderers = new Map<string, { resize(): void; draw(v: View, now: number): void; setTheme(t: ReturnType<typeof theme>): void }>();

  function modeView(preset: ModePreset): View {
    // Bottom-row spots on a 6x4 patch: room for 3v3 in one row, centred for smaller.
    const spots: Record<ModePreset, Array<{ team: 0 | 1; x: number }>> = {
      '1v1': [{ team: 0, x: 2.5 }, { team: 1, x: 3.5 }],
      '2v2': [{ team: 0, x: 1.5 }, { team: 0, x: 2.5 }, { team: 1, x: 3.5 }, { team: 1, x: 4.5 }],
      '3v3': [
        { team: 0, x: 0.5 }, { team: 0, x: 1.5 }, { team: 0, x: 2.5 },
        { team: 1, x: 3.5 }, { team: 1, x: 4.5 }, { team: 1, x: 5.5 },
      ],
      '2v1': [{ team: 0, x: 1.5 }, { team: 0, x: 2.5 }, { team: 1, x: 4.5 }],
    };
    const list = spots[preset];
    const y = 3.5;
    const s = newGame(sizesOf(preset));
    // Keep the race's team counts but show the patch positions.
    const balls = list.map((b, i) => ({ pos: { x: b.x, y }, team: b.team as 0 | 1, id: i, sel: i === 0 }));
    return {
      state: { ...s, turn: 0, winner: null },
      balls,
      hints: [],
      routes: [],
      ghost: null,
      last: [null, null],
      thinking: null,
      human: 0,
      mineHints: [],
      mineGhost: null,
      capsule: null,
    };
  }

  const paintPreviews = (): void => {
    if (!sheetMode || sheetMode.hidden) return;
    const t = theme();
    const now = performance.now();
    for (const preset of PRESET_ORDER) {
      const canvas = document.querySelector<HTMLCanvasElement>(`canvas[data-mode-pv=${JSON.stringify(preset)}]`);
      if (!canvas) continue;
      let r = previewRenderers.get(preset);
      if (!r) {
        r = createRenderer(canvas, { cols: 6, rows: 4, theme: () => theme() });
        previewRenderers.set(preset, r);
      } else {
        r.setTheme(t);
      }
      r.resize();
      const v = modeView(preset);
      r.draw(v, now);
      r.draw(v, now + 600);
    }
  };

  const openSheet = (): void => {
    if (!sheetMode) return;
    syncDraftFromMenu();
    paintSheet();
    api.sheets.open(sheetMode);
    // The canvas has no size while hidden; lay it out after the sheet opens.
    requestAnimationFrame(() => {
      paintPreviews();
      // One more frame after the slide settles for the final size.
      window.setTimeout(paintPreviews, 300);
    });
  };

  /** Game Mode Selector sheet: PLAY's one door (see gamemodes.ts). */
  const openGameModes = (): void => {
    const el = document.getElementById('sheet-game-modes') as HTMLElement | null;
    if (!el) {
      openSheet();
      return;
    }
    try {
      resetSheetView();          // always opens on the three rows
      paintGameSheet();
    } catch {
      /* paint on open anyway */
    }
    api.sheets.open(el);
    /* The Practice card is the selected one, so bring its difficulty and seat pills into
       view even on the shortest phones, where the three rows outgrow the drawer. */
    requestAnimationFrame(() => {
      el.querySelector<HTMLElement>('.gm-card[data-row="bot"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  };

  for (const b of modeCards) {
    b.addEventListener('click', () => {
      const m = b.dataset.mode;
      if (!isPreset(m)) return;
      draftMode = m;
      impact('light');
      // Persist immediately so Home's summary and the sticky Start stay live.
      try {
        saveMenu({ sizes: sizesOf(m), difficulty: draftDiff, mode: 'bot' });
      } catch {
        /* stay in memory */
      }
      paintSheet();
      paintLauncher();
      paintPreviews();
    });
  }

  for (const b of diffBtns) {
    b.addEventListener('click', () => {
      const d = b.dataset.mdiff;
      if (!isDiff(d)) return;
      draftDiff = d;
      impact('light');
      try {
        saveMenu({ difficulty: d, mode: 'bot' });
      } catch {
        /* stay in memory */
      }
      paintSheet();
      paintLauncher();
    });
  }

  modeCustom?.addEventListener('click', () => {
    impact('light');
    api.sheets.close();
    // Let the sheet slide out before the screen slides in.
    window.setTimeout(() => api.router.go('custom'), 60);
  });

  modeStart?.addEventListener('click', () => {
    impact('light');
    const sizes = sizesOf(draftMode);
    try {
      saveMenu({ mode: 'bot', sizes, difficulty: draftDiff });
    } catch {
      /* stay in memory */
    }
    paintSheet();
    paintLauncher();
    api.sheets.close();
    api.start({ difficulty: draftDiff, sizes: [...sizes] as [number, number] });
  });

  /* ---------- identity shortcuts ---------- */

  const goProfile = (): void => {
    impact('light');
    api.router.go('profile');
  };
  $('avatar-btn').addEventListener('click', goProfile);
  $('home-profile-btn').addEventListener('click', goProfile);
  document.getElementById('coin-btn')?.addEventListener('click', goProfile);
  /* Settings gear now lives in the Profile header — keep a guarded hook for legacy DOM. */
  document.getElementById('home-settings')?.addEventListener('click', () => {
    impact('light');
    api.router.go('settings');
  });

  /* ---------- launcher input ---------- */

  /* PLAY is the drawer's front door, never a direct launch: Practice is selected and
     expanded first, and only the drawer's bottom Start can put a race on the board. */
  homePlay.addEventListener('click', () => {
    impact('medium');
    setGameMode('bot');
    openGameModes();
  });

  /* The queue owns the dock's second state: while the searching stage is up the label reads
     SEARCHING, and a found match or a cancel lifts it back. The stage's own hidden flag is
     the one source of truth, so no queue callback has to remember to repaint the dock. */
  const mmStage = document.getElementById('overlay-matchmaking');
  if (mmStage) {
    const paintDockState = (): void => {
      homePlay.classList.toggle('is-searching', !mmStage.hidden);
    };
    new MutationObserver(paintDockState).observe(mmStage, { attributes: true, attributeFilter: ['hidden'] });
    paintDockState();
  }

  onChange(() => {
    void loadCountries();
    void loadMinds();
    paintLauncher();
    paintSheet();
    paintPreviews();
  });

  /* A language switch repaints both cards from the data already on screen: their standing
     labels and empty seats are painted by JS, not by a `data-i18n` pass, so the copy has to
     follow the switch rather than wait for the next poll. The figures themselves stay Latin
     in every language. */
  onLang(() => {
    paintNationList();
    paintNationMine(nationFeed);
    if (mindFeed) paintMinds(mindFeed);
    else paintMindTop(null);
  });

  onGameModeChange(() => {
    paintLauncher();
    paintSheet();
  });

  if (sheetMode) {
    new ResizeObserver(() => paintPreviews()).observe(sheetMode);
  }
  window.addEventListener('resize', paintPreviews);

  syncDraftFromMenu();
  /* Paint the chosen flag and a pending position badge immediately; the live read fills the rank. */
  paintNationMine(null);
  void loadCountries();
  void loadMinds();
  /* Boot on the hero slide. Index 0 is the tournament, and the transform is
     re-asserted after layout so a restored WebView can never strand the deck. */
  const bootHero = (): void => {
    activeIndex = 0;
    paintSlide(0, false);
    paintDots(true);
  };
  bootHero();
  requestAnimationFrame(bootHero);
  paintLauncher();
  paintSheet();

  return {
    setRoute(id: string) {
      if (id !== 'home') return;
      /* The panel itself is already mounted; only its chrome and a stale read are
         refreshed here, and the router runs this after the tab has painted. */
      paintDots(true);
      paintLauncher();
      paintSheet();
      const now = Date.now();
      if (now - nationsSyncedAt > HOME_SYNC_MS) void loadCountries();
      if (now - mindsSyncedAt > HOME_SYNC_MS) void loadMinds();
    },
  };
}
