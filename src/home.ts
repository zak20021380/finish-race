/**
 * home.ts — Home: identity card, flexible highlights, then the mode launcher.
 *
 * Home never scrolls vertically; the carousel is the one horizontal gesture
 * (CSS scroll-snap + `touch-action: pan-x`, `data-carousel` opts out of the
 * global touchmove guard in main.ts). Auto-advance is slow and pauses on touch.
 * Each slide is 100% of the viewport width inside an overflow-hidden wrap, so
 * only the active slide shows cleanly between the paging dots. `.is-active`
 * marks the slide in focus (state binding preserved, no visual peek).
 */
import type { Difficulty } from './bot';
import { menuState, motionReduced, onSettings, saveMenu, type ModeTab } from './settings';
import { flagOf, nameOf } from './countries';
import {
  formatCountdown,
  getCountryRanking,
  getDailyChallenge,
  getFeaturedTournament,
  trendArrow,
  type CountryRow,
  type Tournament,
} from './data';
import { coinText, mountCoins } from './coin';
import { earnCoins, onChange, profile } from './storage';
import { impact, notify } from './telegram';
import type { Router } from './router';
import type { RaceSetup } from './menu';

export interface HomeApi {
  router: Router;
  start(setup: RaceSetup): void;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const DAILY_KEY = 'detour.daily.v1';

function claimedToday(): boolean {
  try {
    return window.localStorage.getItem(DAILY_KEY) === new Date().toDateString();
  } catch {
    return false;
  }
}

function markClaimed(): void {
  try {
    window.localStorage.setItem(DAILY_KEY, new Date().toDateString());
  } catch {
    /* in-memory only */
  }
}

const cap = (d: Difficulty): string => d.charAt(0).toUpperCase() + d.slice(1);

type ModeKind = 'bot' | 'teams' | 'custom';

function kindOfSizes(sizes: readonly [number, number] | readonly number[]): ModeKind {
  const a = sizes[0];
  const b = sizes[1];
  if (a === 1 && b === 1) return 'bot';
  if ((a === 2 && b === 2) || (a === 3 && b === 3) || (a === 2 && b === 1)) return 'teams';
  return 'custom';
}

/** "vs Bot · Normal" / "Teams 2v2 · Hard" / "Custom 2v1 · Easy" — the Play subtitle. */
export function lastModeLabel(): string {
  const d = cap(menuState.difficulty);
  const [a, b] = menuState.sizes;
  if (menuState.tab === 'solo') return `vs Bot · ${d}`;
  if (kindOfSizes(menuState.sizes) === 'custom') return `Custom ${a}v${b} · ${d}`;
  return `Teams ${a}v${b} · ${d}`;
}

function isDiff(v: string | undefined): v is Difficulty {
  return v === 'easy' || v === 'normal' || v === 'hard';
}

function parseSize(v: string | undefined): [number, number] | null {
  if (!v) return null;
  const [a, b] = v.split(',').map(Number);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  if (a < 1 || a > 3 || b < 1 || b > 3) return null;
  return [a, b];
}

export function createHome(api: HomeApi): { setRoute(id: string): void } {
  const carousel = $('home-carousel') as HTMLElement;
  const dots = [...document.querySelectorAll<HTMLButtonElement>('#home-dots .dot')];
  const slides = [...carousel.querySelectorAll<HTMLElement>('.car-card')];
  let featured: Tournament | null = null;
  let tick = 0;

  /* ---------- carousel: dots + slow auto-advance that pauses on touch ---------- */

  /* One card step is the distance between two slides. Slides are 100% of the
     viewport width with no gap/peek, so step === viewport width and exactly
     one active card fills the wrap between the paging dots. */
  const step = (): number => {
    if (slides.length < 2) return carousel.clientWidth || 1;
    return slides[1].offsetLeft - slides[0].offsetLeft || carousel.clientWidth || 1;
  };

  const activeSlide = (): number =>
    Math.min(slides.length - 1, Math.max(0, Math.round(carousel.scrollLeft / step())));

  const paintDots = (): void => {
    const a = activeSlide();
    for (const d of dots) {
      const on = Number(d.dataset.dot) === a;
      d.classList.toggle('on', on);
      d.setAttribute('aria-selected', String(on));
    }
    // contained slider: only the active slide is visible; mark it for state/CSS
    for (const c of slides) c.classList.toggle('is-active', Number(c.dataset.slide) === a);
  };

  const goSlide = (i: number): void => {
    const left = slides[i] ? slides[i].offsetLeft - slides[0].offsetLeft : 0;
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
      goSlide((activeSlide() + 1) % 3);
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

  /* ---------- featured tournament ---------- */

  const paintFeatured = (): void => {
    if (!featured) return;
    const badge = $('feat-badge');
    $('feat-name').textContent = featured.name;
    badge.textContent = featured.status === 'live' ? 'Live' : featured.status === 'upcoming' ? 'Upcoming' : 'Ended';
    badge.className = `pill ${featured.status}`;
    ($('feat-prize') as HTMLElement).textContent = coinText(featured.prizePool);
    $('feat-fee').textContent = featured.entryFee ? `${coinText(featured.entryFee)} entry` : 'Free entry';
    $('feat-count').textContent = featured.status === 'ended' ? 'Ended' : formatCountdown(featured.endsAt);
    $('feat-players').textContent = `${featured.players}/${featured.maxPlayers} players`;
    const join = $('feat-join') as HTMLButtonElement;
    join.disabled = featured.status === 'ended';
    join.textContent = featured.status === 'live' ? 'Join live' : featured.status === 'upcoming' ? 'Join' : 'Ended';
    join.setAttribute('aria-label', `${join.textContent}: ${featured.name}`);
    mountCoins(carousel);
  };

  const loadFeatured = async (): Promise<void> => {
    try {
      featured = await getFeaturedTournament();
    } catch {
      featured = null;
    }
    if (!featured) {
      $('feat-name').textContent = 'Tournaments unavailable';
      $('feat-count').textContent = '—';
      return;
    }
    paintFeatured();
  };

  $('feat-join').addEventListener('click', () => {
    impact('light');
    api.router.go('compete');
  });

  /* ---------- top countries: 3 rows + the user's row ---------- */

  const rowEl = (c: CountryRow, me: boolean): HTMLLIElement => {
    const li = document.createElement('li');
    if (me) li.classList.add('me');
    const rk = document.createElement('span');
    rk.className = 'rk';
    rk.textContent = String(c.rank);
    const fl = document.createElement('span');
    fl.className = 'fl';
    fl.textContent = flagOf(c.code);
    fl.setAttribute('aria-hidden', 'true');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = c.name;
    nm.title = c.name;
    const pt = document.createElement('span');
    pt.className = 'pt';
    pt.textContent = c.points.toLocaleString('en-US');
    const tr = document.createElement('span');
    tr.className = `tr ${c.trend}`;
    tr.textContent = trendArrow(c.trend);
    tr.setAttribute('aria-hidden', 'true');
    li.append(rk, fl, nm, pt, tr);
    return li;
  };

  const loadCountries = async (): Promise<void> => {
    const list = $('home-countries');
    try {
      const all = await getCountryRanking();
      const top3 = all.slice(0, 3);
      const mine = profile.country ? all.find((c) => c.code === profile.country) : undefined;
      list.textContent = '';
      for (const c of top3) {
        list.append(rowEl(c, profile.country === c.code));
      }
      if (mine && !top3.some((c) => c.code === mine.code)) {
        list.append(rowEl(mine, true));
      }
      const note = $('home-country-note');
      if (profile.country) {
        note.hidden = false;
        note.textContent = mine
          ? `You cheer for ${nameOf(profile.country)} (#${mine.rank})`
          : `Your country: ${nameOf(profile.country)}`;
      } else {
        note.hidden = false;
        note.textContent = 'Pick your country in Profile';
      }
    } catch {
      list.textContent = '';
      const li = document.createElement('li');
      li.textContent = 'Rankings unavailable';
      list.append(li);
    }
  };

  /* ---------- daily challenge ---------- */

  const loadDaily = async (): Promise<void> => {
    const streak = profile.stats.streak;
    ($('daily-streak') as HTMLElement).textContent = `🔥 ${streak}`;
    try {
      const d = await getDailyChallenge(streak);
      $('daily-title').textContent = d.detail;
      ($('daily-reward') as HTMLElement).textContent = coinText(d.reward);
      $('daily-detail').textContent = `Resets at midnight · chest ${coinText(d.reward)}`;
      paintClaim(d.reward);
    } catch {
      $('daily-detail').textContent = 'Come back tomorrow';
    }
  };

  const paintClaim = (reward: number): void => {
    const btn = $('daily-claim') as HTMLButtonElement;
    const done = claimedToday();
    btn.disabled = done;
    btn.textContent = done ? 'Claimed' : `Claim ${coinText(reward)}`;
  };

  $('daily-claim').addEventListener('click', () => {
    if (claimedToday()) return;
    const raw = ($('daily-reward') as HTMLElement).textContent ?? '';
    const reward = Number(raw.replace(/[^0-9]/g, '')) || 150;
    earnCoins(reward);
    markClaimed();
    notify('success');
    impact('medium');
    paintClaim(reward);
    void loadDaily();
  });

  /* ---------- launcher: one tier at a time, every pick lands in menuState ---------- */

  const tabTrack = document.querySelector<HTMLElement>('.mode-tabs');
  const sizeRow = document.getElementById('mctx-size');
  const tabBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-mode-tab]')];

  const paintLauncher = (): void => {
    const tab = menuState.tab;
    if (tabTrack) tabTrack.dataset.tab = tab;
    for (const b of tabBtns) {
      const on = b.dataset.modeTab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (sizeRow) sizeRow.classList.toggle('is-open', tab === 'party');
    for (const b of document.querySelectorAll<HTMLButtonElement>('.mode-chip[data-diff]')) {
      b.setAttribute('aria-pressed', String(b.dataset.diff === menuState.difficulty));
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('.mode-chip[data-size]')) {
      const p = parseSize(b.dataset.size);
      const on = p !== null && p[0] === menuState.sizes[0] && p[1] === menuState.sizes[1];
      b.setAttribute('aria-pressed', String(on));
    }
    // Hero PLAY is icon + PLAY only (sub-pill removed by design).
    // Binding preserved: if a sub element exists (legacy/tests), keep it in sync.
    const sub = document.getElementById('home-play-sub');
    if (sub) sub.textContent = lastModeLabel();
  };

  /** Solo is always one ball each, so the tier swap rewrites the size the race will use. */
  const setTab = (tab: ModeTab): void => {
    if (menuState.tab === tab) return;
    impact('light');
    saveMenu(tab === 'solo'
      ? { tab, sizes: [1, 1] }
      : { tab, sizes: kindOfSizes(menuState.sizes) === 'bot' ? [2, 2] : [...menuState.sizes] });
    paintLauncher();
  };

  /* ---------- identity shortcuts ---------- */

  const goProfile = (): void => {
    impact('light');
    api.router.go('profile');
  };
  $('avatar-btn').addEventListener('click', goProfile);
  $('home-profile-btn').addEventListener('click', goProfile);
  $('home-settings').addEventListener('click', () => {
    impact('light');
    api.router.go('settings');
  });

  /* ---------- launcher input ---------- */

  for (const b of tabBtns) {
    b.addEventListener('click', () => {
      const t = b.dataset.modeTab;
      if (t === 'solo' || t === 'party') setTab(t);
    });
  }
  /* the pill is a tablist, so the arrows walk it like a segmented control */
  tabTrack?.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next: ModeTab = menuState.tab === 'solo' ? 'party' : 'solo';
    setTab(next);
    tabBtns.find((b) => b.dataset.modeTab === next)?.focus();
  });

  for (const b of document.querySelectorAll<HTMLButtonElement>('.mode-chip[data-diff]')) {
    b.addEventListener('click', () => {
      const d = b.dataset.diff;
      if (!isDiff(d)) return;
      impact('light');
      saveMenu({ difficulty: d });
      paintLauncher();
    });
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>('.mode-chip[data-size]')) {
    b.addEventListener('click', () => {
      const p = parseSize(b.dataset.size);
      if (!p) return;
      impact('light');
      saveMenu({ sizes: p });
      paintLauncher();
    });
  }

  /* the team builder is its own screen — a way out of the launcher, not a fourth size */
  $('tile-custom').addEventListener('click', () => {
    impact('medium');
    api.router.go('custom');
  });

  $('home-play').addEventListener('click', () => {
    impact('light');
    saveMenu({ mode: 'bot' });
    api.start({ difficulty: menuState.difficulty, sizes: [...menuState.sizes] });
  });

  /* ---------- countdown ticker ---------- */

  const startTick = (): void => {
    if (tick) return;
    tick = window.setInterval(() => {
      if ($('s-home').hidden || !featured || featured.status === 'ended') return;
      $('feat-count').textContent = formatCountdown(featured.endsAt);
    }, 1000);
  };

  onChange(() => {
    void loadCountries();
    void loadDaily();
    paintLauncher();
  });

  void loadFeatured();
  void loadCountries();
  void loadDaily();
  paintDots();
  paintLauncher();
  armAuto();
  startTick();
  mountCoins(carousel);

  return {
    setRoute(id: string) {
      if (id !== 'home') return;
      /* the team builder can leave a multi-ball size behind a solo tier — it is a party race */
      if (menuState.tab === 'solo' && kindOfSizes(menuState.sizes) !== 'bot') {
        saveMenu({ tab: 'party' });
      }
      paintDots();
      poke();
      paintLauncher();
      void loadCountries();
    },
  };
}
