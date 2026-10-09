/**
 * home.ts — Home: identity card, flexible highlights, then the mode launcher.
 *
 * Home never scrolls vertically; the carousel is the one horizontal gesture
 * (CSS scroll-snap + `touch-action: pan-x`, `data-carousel` opts out of the
 * global touchmove guard in main.ts). Auto-advance is slow and pauses on touch.
 * The active slide gets `.is-active` so CSS can hold it full size while the
 * peeking cards recede.
 */
import type { Difficulty } from './bot';
import { menuState, motionReduced, onSettings, saveMenu } from './settings';
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
import type { Sheets } from './sheets';
import type { RaceSetup } from './menu';

export interface HomeApi {
  router: Router;
  sheets: Sheets;
  sheet(id: string): HTMLElement | null;
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
  const kind = kindOfSizes(menuState.sizes);
  if (kind === 'bot') return `vs Bot · ${d}`;
  if (kind === 'teams') return `Teams ${a}v${b} · ${d}`;
  return `Custom ${a}v${b} · ${d}`;
}

function isDiff(v: string | undefined): v is Difficulty {
  return v === 'easy' || v === 'normal' || v === 'hard';
}

function parsePreset(v: string | undefined): [number, number] | null {
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

  /* ---------- quick-start local picks (committed on Start) ---------- */
  let qbDiff: Difficulty = menuState.difficulty;
  let qtDiff: Difficulty = menuState.difficulty;
  let qtSizes: [number, number] = (() => {
    const k = kindOfSizes(menuState.sizes);
    return k === 'teams' ? [...menuState.sizes] as [number, number] : [2, 2];
  })();

  /* ---------- carousel: dots + slow auto-advance that pauses on touch ---------- */

  /* One card step is the distance between two slides, not the viewport width:
     the cards peek, so a viewport holds a card plus a sliver of the next. */
  const step = (): number => {
    if (slides.length < 2) return carousel.clientWidth || 1;
    return slides[1].offsetLeft - slides[0].offsetLeft || 1;
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
    // only the card in focus sits at full size; the rest recede behind it
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

  /* ---------- Play subtitle + tile selection ---------- */

  const paintPlay = (): void => {
    const sub = document.getElementById('home-play-sub');
    if (sub) sub.textContent = lastModeLabel();
    const kind = kindOfSizes(menuState.sizes);
    const bot = document.getElementById('tile-bot');
    const teams = document.getElementById('tile-teams');
    const custom = document.getElementById('tile-custom');
    if (bot) bot.setAttribute('aria-pressed', String(kind === 'bot'));
    if (teams) teams.setAttribute('aria-pressed', String(kind === 'teams'));
    if (custom) custom.setAttribute('aria-pressed', String(kind === 'custom'));
  };

  const paintQuickSegs = (): void => {
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-qb-diff]')) {
      b.setAttribute('aria-pressed', String(b.dataset.qbDiff === qbDiff));
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-qt-diff]')) {
      b.setAttribute('aria-pressed', String(b.dataset.qtDiff === qtDiff));
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-qt-preset]')) {
      const p = parsePreset(b.dataset.qtPreset);
      const on = p !== null && p[0] === qtSizes[0] && p[1] === qtSizes[1];
      b.setAttribute('aria-pressed', String(on));
    }
  };

  const syncQuickFromMenu = (): void => {
    qbDiff = menuState.difficulty;
    qtDiff = menuState.difficulty;
    qtSizes = kindOfSizes(menuState.sizes) === 'teams'
      ? [...menuState.sizes] as [number, number]
      : [2, 2];
    paintQuickSegs();
    paintPlay();
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

  /* ---------- mode tiles + quick sheets + Play ---------- */

  for (const el of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    el.addEventListener('click', () => {
      const m = el.dataset.mode;
      if (m === 'online') return;
      impact('light');
      if (m === 'bot') {
        qbDiff = menuState.difficulty;
        paintQuickSegs();
        const sh = api.sheet('sheet-quick-bot');
        if (sh) api.sheets.open(sh);
        return;
      }
      if (m === 'teams') {
        qtDiff = menuState.difficulty;
        qtSizes = kindOfSizes(menuState.sizes) === 'teams'
          ? [...menuState.sizes] as [number, number]
          : [2, 2];
        paintQuickSegs();
        const sh = api.sheet('sheet-quick-teams');
        if (sh) api.sheets.open(sh);
        return;
      }
      if (m === 'custom') {
        api.router.go('custom');
        return;
      }
    });
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-qb-diff]')) {
    b.addEventListener('click', () => {
      const d = b.dataset.qbDiff;
      if (!isDiff(d)) return;
      qbDiff = d;
      paintQuickSegs();
      impact('light');
    });
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-qt-diff]')) {
    b.addEventListener('click', () => {
      const d = b.dataset.qtDiff;
      if (!isDiff(d)) return;
      qtDiff = d;
      paintQuickSegs();
      impact('light');
    });
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-qt-preset]')) {
    b.addEventListener('click', () => {
      const p = parsePreset(b.dataset.qtPreset);
      if (!p) return;
      qtSizes = p;
      paintQuickSegs();
      impact('light');
    });
  }

  const qbStart = document.getElementById('qb-start');
  qbStart?.addEventListener('click', () => {
    impact('light');
    saveMenu({ mode: 'bot', difficulty: qbDiff, sizes: [1, 1] });
    paintPlay();
    api.sheets.close();
    // Close is animated; start on next frame so the sheet never covers the board.
    window.setTimeout(() => api.start({ difficulty: qbDiff, sizes: [1, 1] }), 60);
  });

  const qtStart = document.getElementById('qt-start');
  qtStart?.addEventListener('click', () => {
    impact('light');
    const sizes: [number, number] = [...qtSizes] as [number, number];
    saveMenu({ mode: 'bot', difficulty: qtDiff, sizes });
    paintPlay();
    api.sheets.close();
    window.setTimeout(() => api.start({ difficulty: qtDiff, sizes }), 60);
  });

  $('home-play').addEventListener('click', () => {
    impact('light');
    const d = menuState.difficulty;
    const sizes: [number, number] = [...menuState.sizes] as [number, number];
    saveMenu({ mode: 'bot' });
    api.start({ difficulty: d, sizes });
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
    paintPlay();
  });

  void loadFeatured();
  void loadCountries();
  void loadDaily();
  paintDots();
  syncQuickFromMenu();
  armAuto();
  startTick();
  mountCoins(carousel);

  return {
    setRoute(id: string) {
      if (id === 'home') {
        paintDots();
        poke();
        syncQuickFromMenu();
        void loadCountries();
      }
    },
  };
}
