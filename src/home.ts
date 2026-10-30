/**
 * home.ts — Home: identity card, flexible highlights, then the single Play launcher.
 *
 * Home never scrolls vertically; the carousel is the one horizontal gesture
 * (CSS scroll-snap + `touch-action: pan-x`, `data-carousel` opts out of the
 * global touchmove guard in main.ts). Auto-advance is slow and pauses on touch.
 * Each slide is 100% of the viewport width inside an overflow-hidden wrap, so
 * only the active slide shows cleanly between the paging dots. `.is-active`
 * marks the slide in focus (state binding preserved, no visual peek).
 * Three slides, in this order: Channel War (index 0, the hero the Play tab
 * opens on), Nations Cup, The Mind Ladder.
 *
 * Mode selection is one split-action Play Dock: the left zone opens the "Select
 * Game Mode" drawer, the right zone launches whatever that zone names, in one tap
 * (see gamemodes.ts / main.ts `launchSelectedMode`). The legacy "Choose mode" sheet
 * is still wired for the team presets: a 2-column grid of preset cards with live
 * renderer previews, a Custom entry that opens the team builder and a sticky Start
 * button whose label updates live.
 */
import type { Difficulty } from './bot';
import { menuState, motionReduced, onLang, onSettings, saveMenu, t } from './settings';
import { nameOf } from './countries';
import { getCountryRanking, type CountryRow } from './data';
import { fetchMindLadder, type MindFeed, type MindRowData } from './minds';
import { myTiq } from './matchmaking';
import { onChange, profile, theme } from './storage';
import { impact } from './telegram';
import { flagPhoto } from './flags';
import { getSquadRanking } from './squads';
import { newGame } from './rules';
import { createRenderer, type View } from './render';
import type { Router } from './router';
import type { Sheets } from './sheets';
import { openEnlistSquad, type RaceSetup } from './menu';
import { onGameModeChange, paintLobby as paintGameLobby, paintSheetState as paintGameSheet, resetSheetView } from './gamemodes';
import starsImg from './assets/images/telegram_stars.png';

export interface HomeApi {
  router: Router;
  sheets: Sheets;
  start(setup: RaceSetup): void;
  /** The Play Dock's right zone: launch whatever mode the dock is showing, in one tap. */
  launch(): void;
}

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
  const carousel = $('home-carousel') as HTMLElement;
  const dots = [...document.querySelectorAll<HTMLButtonElement>('#home-dots .dot')];
  const slides = [...carousel.querySelectorAll<HTMLElement>('.car-card')];

  /* ---------- carousel: dots + slow auto-advance that pauses on touch ---------- */

  /* One card step is the distance between two slides. Slides are 100% of the
     viewport width with no gap/peek, so step === viewport width and exactly
     one active card fills the wrap between the paging dots. */
  const step = (): number => {
    if (slides.length < 2) return carousel.clientWidth || 1;
    return slides[1].offsetLeft - slides[0].offsetLeft || carousel.clientWidth || 1;
  };

  /* Index 0 is the 200 Stars Tournament: the track is authored in that order,
     so the boot state below simply agrees with the markup. */
  let currentSlideIndex = 0;

  const clampIndex = (i: number): number => Math.min(slides.length - 1, Math.max(0, i));

  const activeSlide = (): number =>
    clampIndex(Math.round(carousel.scrollLeft / step()));

  const paintDots = (): void => {
    const a = activeSlide();
    currentSlideIndex = a;
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
    const card = carousel.querySelector<HTMLElement>('.car-card.is-active') ?? slides[activeSlide()];
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

  const goSlide = (i: number): void => {
    const n = clampIndex(i);
    currentSlideIndex = n;
    const left = slides[n] ? slides[n].offsetLeft - slides[0].offsetLeft : 0;
    carousel.scrollTo({ left, behavior: motionReduced() ? 'auto' : 'smooth' });
  };

  for (const d of dots) {
    d.addEventListener('click', () => {
      impact('light');
      poke();
      goSlide(Number(d.dataset.dot));
    });
  }
  carousel.addEventListener('scroll', paintDots, { passive: true });

  let idleTimer = 0;
  let autoTimer = 0;
  const poke = (): void => {
    window.clearTimeout(idleTimer);
    window.clearInterval(autoTimer);
    autoTimer = 0;
    idleTimer = window.setTimeout(armAuto, 8000);
  };
  const armAuto = (): void => {
    // Reduced motion: no auto-advance; the carousel only moves on direct input.
    if (autoTimer || document.hidden || motionReduced()) return;
    autoTimer = window.setInterval(() => {
      if (document.hidden || motionReduced()) return;
      const s = $('s-home');
      if (s.hidden) return;
      goSlide((currentSlideIndex + 1) % slides.length);
    }, 6000);
  };
  onSettings(() => {
    if (motionReduced()) {
      window.clearInterval(autoTimer);
      autoTimer = 0;
      window.clearTimeout(idleTimer);
    } else poke();
  });
  for (const ev of ['pointerdown', 'touchstart', 'wheel'] as const) {
    carousel.addEventListener(ev, poke, { passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      window.clearInterval(autoTimer);
      autoTimer = 0;
    } else poke();
  });
  // Keep the inside-dots glued to the card bottom across resizes/rotations.
  try {
    new ResizeObserver(() => syncDots()).observe(carousel);
  } catch {
    /* ResizeObserver unavailable — CSS fallback + paintDots cover it */
  }
  window.addEventListener('resize', syncDots);

  /* ---------- Nations Cup: 30px rows + user row / pick-country CTA ----------
     Top 5 fill the card to the dots with no dead void (the 40px→30px row is
     layout only — the row recipe is identical for ranks 1-5). Layout only —
     data (getCountryRanking) and handlers (openCountryPicker) are unchanged.
     Flags come from the shared CDN resolver in a 28px circle — no vendored SVG
     table and no monogram guesswork. */

  const PODIUM_CLASS = ['gold', 'silver', 'bronze'] as const;
  /** The last nation board read — kept so a language switch can repaint the standing
   *  bar's labels without another round-trip. */
  let countryRows: CountryRow[] = [];

  const monogramOf = (name: string): string => {
    const parts = name.trim().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 0) return '•';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0].slice(0, 1) + parts[1].slice(0, 1)).toUpperCase();
  };

  /** Display-only magnitude for the "▲ N" trend (ranking has no move size). */
  const trendDeltaOf = (code: string): number => {
    const up = code.toUpperCase();
    const a: number = up.charCodeAt(0) || 65;
    const b: number = up.charCodeAt(1) || 65;
    return ((a + b) % 3) + 1;
  };

  const trendTextOf = (c: CountryRow): string => {
    if (c.trend === 'up') return `▲ ${trendDeltaOf(c.code)}`;
    if (c.trend === 'down') return `▼ ${trendDeltaOf(c.code)}`;
    return '•';
  };

  /** The TIQ brand mark worn by a nation's score: the neon brain sprite. */
  const brainIcon = (cls: string): SVGSVGElement => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('viewBox', '0 0 24 24');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-brain-neon');
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

  const rowEl = (c: CountryRow, me: boolean): HTMLLIElement => {
    const li = document.createElement('li');
    li.classList.add('nations-row');
    li.classList.add(`rank-${c.rank}`);
    if (me) li.classList.add('me');
    const pts = c.points.toLocaleString('en-US');
    const trendLabel = c.trend === 'up' ? 'rising' : c.trend === 'down' ? 'dropping' : 'steady';
    li.setAttribute('aria-label', `#${c.rank} ${c.name} — ${pts} TIQ, ${trendLabel}`);
    const rk = document.createElement('span');
    const podium = c.rank >= 1 && c.rank <= 3 ? PODIUM_CLASS[c.rank - 1] : '';
    rk.className = podium ? `rk rank-${c.rank} ${podium}` : `rk rank-${c.rank}`;
    rk.textContent = String(c.rank);
    rk.setAttribute('aria-hidden', 'true');
    const fl = document.createElement('span');
    fl.className = 'fl';
    fl.setAttribute('aria-hidden', 'true');
    fl.append(flagPhoto(c.code, 'fp-nation'));
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = c.name;
    nm.title = c.name;
    const pt = nationScore(pts);
    pt.title = `${pts} TIQ`;
    const tr = document.createElement('span');
    tr.className = `tr ${c.trend}`;
    tr.textContent = trendTextOf(c);
    tr.title = trendLabel;
    tr.setAttribute('aria-hidden', 'true');
    li.append(rk, fl, nm, tr, pt);
    return li;
  };

  /** The player's own national standing, painted into the 3-zone HUD bar.
   *  LEFT = flag + nation · CENTER = the percentile the nation sits in · RIGHT = the
   *  contribution, ending in the same brain token the rows above wear. Every zone is a
   *  separate node, so a long country name ellipsizes instead of shoving the pill or
   *  the score out of the bar. */
  const paintNationMine = (rows: CountryRow[]): void => {
    countryRows = rows;
    const bar = document.getElementById('home-nation-mine');
    if (!bar) return;
    const flag = document.getElementById('home-nation-flag');
    const name = document.getElementById('home-nation-name');
    const pill = document.getElementById('home-nation-pill');
    const pillK = document.getElementById('home-nation-pill-k');
    const pct = document.getElementById('home-nation-pct');
    const pts = document.getElementById('home-nation-pts');
    const contributed = profile.stats.wins * 140;
    const ptsText = `+${contributed.toLocaleString('en-US')}`;
    if (pts) pts.textContent = ptsText;
    const code = profile.country;
    if (!code) {
      if (flag) { flag.textContent = ''; flag.classList.add('is-off'); }
      if (name) { name.textContent = t('hudPickNation'); name.removeAttribute('title'); }
      if (pillK) pillK.textContent = t('hudYourNation');
      if (pct) { pct.hidden = true; pct.textContent = ''; }
      pill?.classList.add('is-off');
      bar.setAttribute('aria-label', `${t('hudYourNation')}: ${t('hudPickNation')}`);
      bar.removeAttribute('title');
      return;
    }
    const mine = rows.find((c) => c.code === code);
    const label = nameOf(code);
    if (flag) {
      flag.textContent = '';
      flag.classList.remove('is-off');
      flag.append(flagPhoto(code, 'hm-flag-plate'));
    }
    if (name) { name.textContent = label; name.title = label; }
    const share = mine && rows.length > 0
      ? Math.max(1, Math.round((mine.rank / rows.length) * 100))
      : 0;
    if (pillK) pillK.textContent = mine ? t('hudTop') : t('hudUnranked');
    if (pct) {
      pct.hidden = !mine;
      pct.textContent = mine ? `${share}%` : '';
    }
    pill?.classList.toggle('is-off', !mine);
    bar.setAttribute('aria-label', mine
      ? `${label} · #${mine.rank} · ${t('hudTop')} ${share}% · ${ptsText}`
      : `${label} · ${t('hudUnranked')} · ${ptsText}`);
    bar.setAttribute('title', mine
      ? `You fight for ${label} — rank #${mine.rank} of ${rows.length}`
      : `You fight for ${label}`);
  };

  const loadCountries = async (): Promise<void> => {
    const list = $('home-countries');
    try {
      const all = await getCountryRanking();
      const top5 = all.slice(0, 5);
      list.textContent = '';
      for (const c of top5) {
        list.append(rowEl(c, profile.country === c.code));
      }
      paintNationMine(all);
    } catch {
      list.textContent = '';
      const li = document.createElement('li');
      li.className = 'nations-row is-error';
      li.textContent = 'Rankings unavailable';
      list.append(li);
      /* the bar is a structure of zones, never a text node: repaint the last board we
         hold instead of overwriting it with a sentence. */
      paintNationMine(countryRows);
    }
  };

  document.getElementById('home-cup-table')?.addEventListener('click', () => {
    impact('light');
    poke();
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
     the rest stay as identical, dimmed "Awaiting Challenger" rows, so the band never collapses
     on a quiet server. The score lockup is [score] [TIQ] [brain], never a trophy. */

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

  const mindRow = (p: MindRowData): HTMLLIElement => {
    const li = document.createElement('li');
    li.className = 'mind-row';
    const score = p.tiq.toLocaleString('en-US');
    const trendWord = p.trend === 'up'
      ? `rising ${p.delta}`
      : p.trend === 'down'
        ? `dropping ${Math.abs(p.delta)}`
        : 'steady';
    li.setAttribute('aria-label', `#${p.rank} ${p.name} — ${score} TIQ, ${trendWord}`);
    const rk = document.createElement('span');
    rk.className = `mind-rank ${p.rank <= 3 ? PODIUM_CLASS[p.rank - 1] : 'slate'}`;
    rk.textContent = `#${p.rank}`;
    rk.setAttribute('aria-hidden', 'true');
    const av = document.createElement('span');
    av.className = 'mind-av';
    av.setAttribute('aria-hidden', 'true');
    const ini = document.createElement('b');
    ini.className = 'mind-ini';
    ini.textContent = monogramOf(p.name);
    av.append(ini, p.countryCode ? flagPhoto(p.countryCode, 'mind-flag') : globeFlag());
    const nm = document.createElement('span');
    nm.className = 'mind-nm';
    nm.textContent = p.name;
    nm.title = p.name;
    const tr = document.createElement('span');
    tr.className = `mind-trend ${p.trend}`;
    tr.textContent = p.trend === 'up' ? `▲ ${p.delta}` : p.trend === 'down' ? `▼ ${Math.abs(p.delta)}` : '•';
    tr.title = trendWord;
    tr.setAttribute('aria-hidden', 'true');
    li.append(rk, av, nm, tr, scoreCell(score, false));
    return li;
  };

  /** One unoccupied rank: the exact same row skeleton, dimmed — never a shorter row or a gap. */
  const emptyMindRow = (rank: number): HTMLLIElement => {
    const li = document.createElement('li');
    li.className = 'mind-row is-empty';
    li.setAttribute('aria-label', `#${rank} — Awaiting Challenger, no TIQ yet`);
    const rk = document.createElement('span');
    rk.className = 'mind-rank slate';
    rk.textContent = `#${rank}`;
    rk.setAttribute('aria-hidden', 'true');
    const av = document.createElement('span');
    av.className = 'mind-av mind-av-empty';
    av.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'mind-av-ico');
    svg.setAttribute('viewBox', '0 0 24 24');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-brain');
    svg.append(use);
    av.append(svg);
    const nm = document.createElement('span');
    nm.className = 'mind-nm';
    nm.textContent = 'Awaiting Challenger';
    const tr = document.createElement('span');
    tr.className = 'mind-trend same';
    tr.textContent = '•';
    tr.setAttribute('aria-hidden', 'true');
    li.append(rk, av, nm, tr, scoreCell('—', true));
    return li;
  };

  const paintMindTop = (feed: MindFeed | null): void => {
    const el = document.getElementById('mind-top');
    if (!el) return;
    if (feed?.live && feed.total > 0) {
      el.textContent = `${feed.total.toLocaleString('en-US')} ${feed.total === 1 ? 'Mind' : 'Minds'}`;
    } else {
      el.textContent = 'TIQ Live';
    }
  };

  /** The player's own global standing, painted into the same 3-zone HUD bar:
   *  LEFT = the glowing rank badge + YOU · CENTER = the percentile · RIGHT = the TIQ,
   *  right-aligned under the score column of rows #1–#5. */
  const paintMindMine = (feed: MindFeed | null): void => {
    const bar = document.getElementById('home-mind-mine');
    if (!bar) return;
    const name = document.getElementById('home-mind-name');
    const rankEl = document.getElementById('home-mind-rank');
    const pill = document.getElementById('home-mind-pill');
    const pillK = document.getElementById('home-mind-pill-k');
    const pct = document.getElementById('home-mind-pct');
    const tiqEl = document.getElementById('home-mind-tiq');
    const tiqText = myTiq().toLocaleString('en-US');
    if (name) name.textContent = t('hudYou');
    if (tiqEl) tiqEl.textContent = tiqText;
    const st = feed?.live ? feed.standing : null;
    if (st) {
      if (rankEl) { rankEl.textContent = `#${st.rank}`; rankEl.classList.remove('is-off'); }
      if (pillK) pillK.textContent = t('hudTop');
      if (pct) { pct.hidden = false; pct.textContent = `${st.pct}%`; }
      pill?.classList.remove('is-off');
      bar.setAttribute('aria-label', `${t('hudYou')} · #${st.rank} · ${tiqText} TIQ · ${t('hudTop')} ${st.pct}%`);
      bar.setAttribute('title', `Rank ${st.rank} of ${st.total.toLocaleString('en-US')} minds`);
      return;
    }
    if (rankEl) { rankEl.textContent = '—'; rankEl.classList.add('is-off'); }
    if (pillK) pillK.textContent = t('hudUnranked');
    if (pct) { pct.hidden = true; pct.textContent = ''; }
    pill?.classList.add('is-off');
    bar.setAttribute('aria-label', `${t('hudYou')} · ${t('hudUnranked')} · ${tiqText} TIQ`);
    if (feed?.live) bar.setAttribute('title', 'Your TIQ enters the ladder after your first live TIQ');
    else bar.removeAttribute('title');
  };

  const paintMinds = (feed: MindFeed | null): void => {
    const list = document.getElementById('home-minds');
    if (!list) return;
    list.textContent = '';
    const rows = feed?.rows ?? [];
    for (let i = 0; i < MIND_SLOTS; i++) {
      const row = rows[i];
      list.append(row ? mindRow(row) : emptyMindRow(i + 1));
    }
    paintMindTop(feed);
    paintMindMine(feed);
  };

  const loadMinds = async (): Promise<void> => {
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
    poke();
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

  /* ---------- Channel War: the hero slide's one door ----------
     The CTA hands the player to the Arena's own channel leaderboard and
     registration flow — the very #stars-cta that opens the "Play for your
     squad?" seat drawer, or jumps straight to the queue when this device
     already holds a seat. One registration path, one source of seat truth;
     Home never duplicates it.

     The Arena hydrates its cup asynchronously and that key is a no-op until
     the cup lands, so the hand-off knocks until it answers: it stops the
     moment the drawer opens, the moment a locked seat takes the player out of
     the Arena, and gives up after ~3s rather than knocking forever. */

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
    poke();
    openEnlistSquad();
  });

  document.getElementById('home-tournament-cta')?.addEventListener('click', () => {
    impact('medium');
    poke();
    try {
      api.router.go('arena');
    } catch {
      /* router unavailable */
    }
    const key = document.getElementById('stars-cta');
    let tries = 0;
    let landed = false;
    const handOver = (): void => {
      const arena = document.getElementById('s-arena');
      const sheet = document.getElementById('sheet-stars');
      const shown = !!arena && !arena.hidden;
      if (shown) landed = true;
      if ((sheet && !sheet.hidden) || (landed && !shown) || tries++ > 24) return;
      if (shown) key?.click();
      window.setTimeout(handOver, 125);
    };
    window.setTimeout(handOver, 125);
  });

  /* The leader ticker reads the same ranking feed the Arena's channel ladder
     ranks, so Home and the cup can never disagree about who leads. The static
     markup already holds @DogeSquad (the top seed), so this only ever repaints
     when a custom channel has actually overtaken it. */
  const leaderHandle = document.getElementById('tour-leader-handle');
  if (leaderHandle) {
    const top = getSquadRanking()[0];
    if (top) leaderHandle.textContent = top.handle;
  }

  /* The HUD's clock. Anchored to a real deadline 02h 45m out, so the capsule
     reads exactly as authored on arrival and then ticks honestly; it is only
     repainted while the tab is visible. */
  const tourClock = document.getElementById('tour-countdown');
  if (tourClock) {
    const endsAt = Date.now() + (2 * 60 + 45) * 60_000;
    const paintClock = (): void => {
      // Round up: 02h 45m out reads "02h 45m left", not "02h 44m left", on arrival.
      const totalMin = Math.max(0, Math.ceil((endsAt - Date.now()) / 60_000));
      const hh = Math.floor(totalMin / 60);
      const mm = totalMin % 60;
      tourClock.textContent = `${String(hh).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m left`;
    };
    paintClock();
    window.setInterval(() => {
      if (!document.hidden) paintClock();
    }, 1000);
  }

  /* ---------- launcher: one Play button + summary + sheet draft ---------- */

  const homePlay = $('home-play') as HTMLButtonElement;
  const modeHero = document.getElementById('mode-hero') as HTMLButtonElement | null;
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

  /** Game Mode Selector sheet: the whole mode card's one door (see gamemodes.ts). */
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

  modeHero?.addEventListener('click', () => {
    impact('light');
    openGameModes();
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

  /* The dock's launch key launches whatever mode its mode key names: quick match queues on
     the searching stage, practice and a private room open their roster first. `api.launch` is
     the same door the drawer's Start uses, so the label and the race can never disagree. */
  homePlay.addEventListener('click', () => {
    impact('medium');
    api.launch();
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

  /* A language switch repaints the two standing bars from the data already on screen:
     their labels are painted by JS, not by a `data-i18n` pass. */
  onLang(() => {
    paintNationMine(countryRows);
    paintMindMine(mindFeed);
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
  void loadCountries();
  void loadMinds();
  /* Boot on the hero slide. Index 0 is the tournament, and a browser that
     restores the track's scroll offset on reload must not land the Play tab
     halfway down the deck. Re-asserted once after layout, then left alone. */
  const bootHero = (): void => {
    if (carousel.scrollLeft !== 0) carousel.scrollLeft = 0;
    paintDots();
  };
  bootHero();
  requestAnimationFrame(bootHero);
  paintLauncher();
  paintSheet();
  armAuto();

  return {
    setRoute(id: string) {
      if (id !== 'home') return;
      paintDots();
      poke();
      paintLauncher();
      paintSheet();
      void loadCountries();
      void loadMinds();
    },
  };
}
