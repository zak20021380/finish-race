/**
 * home.ts — the redesigned Home: identity card, swipeable highlights, Play + mode grid.
 *
 * Home never scrolls vertically; the carousel is the one horizontal gesture
 * (CSS scroll-snap + `touch-action: pan-x`, `data-carousel` opts out of the
 * global touchmove guard in main.ts). Auto-advance is slow and pauses on touch.
 */
import type { Difficulty } from './bot';
import { menuState, saveMenu } from './settings';
import { flagOf, nameOf } from './countries';
import {
  formatCountdown,
  getDailyChallenge,
  getFeaturedTournament,
  getTopCountries,
  trendArrow,
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

export function createHome(api: HomeApi): { setRoute(id: string): void } {
  const carousel = $('home-carousel') as HTMLElement;
  const dots = [...document.querySelectorAll<HTMLButtonElement>('#home-dots .dot')];
  let featured: Tournament | null = null;
  let tick = 0;

  /* ---------- carousel: dots + slow auto-advance that pauses on touch ---------- */

  const activeSlide = (): number => {
    const w = carousel.clientWidth || 1;
    return Math.min(2, Math.max(0, Math.round(carousel.scrollLeft / w)));
  };

  const paintDots = (): void => {
    const a = activeSlide();
    for (const d of dots) {
      const on = Number(d.dataset.dot) === a;
      d.classList.toggle('on', on);
      d.setAttribute('aria-selected', String(on));
    }
  };

  const goSlide = (i: number): void => {
    const w = carousel.clientWidth;
    carousel.scrollTo({ left: i * w, behavior: 'smooth' });
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
    if (autoTimer || document.hidden) return;
    autoTimer = window.setInterval(() => {
      if (document.hidden) return;
      const s = $('s-home');
      if (s.hidden) return;
      goSlide((activeSlide() + 1) % 3);
    }, 6000);
  };
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

  /* ---------- top countries mini list ---------- */

  const loadCountries = async (): Promise<void> => {
    const list = $('home-countries');
    try {
      const top = await getTopCountries(5);
      list.textContent = '';
      for (const c of top) {
        const li = document.createElement('li');
        if (profile.country === c.code) li.classList.add('me');
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
        const pt = document.createElement('span');
        pt.className = 'pt';
        pt.textContent = c.points.toLocaleString('en-US');
        const tr = document.createElement('span');
        tr.className = `tr ${c.trend}`;
        tr.textContent = trendArrow(c.trend);
        li.append(rk, fl, nm, pt, tr);
        list.append(li);
      }
      const note = $('home-country-note');
      const mine = profile.country;
      if (mine) {
        const hit = top.find((c) => c.code === mine);
        note.hidden = false;
        note.textContent = hit ? `You are cheering for ${nameOf(mine)} (#${hit.rank})` : `Your country: ${nameOf(mine)} — keep climbing`;
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

  /* ---------- identity shortcuts + mode grid ---------- */

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

  for (const el of document.querySelectorAll<HTMLButtonElement>('[data-bot-diff]')) {
    el.addEventListener('click', () => {
      const d = el.dataset.botDiff as Difficulty;
      if (d !== 'easy' && d !== 'normal' && d !== 'hard') return;
      impact('light');
      saveMenu({ mode: 'bot', difficulty: d });
      api.start({ difficulty: d, sizes: [...menuState.sizes] });
    });
  }

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
  });

  void loadFeatured();
  void loadCountries();
  void loadDaily();
  paintDots();
  armAuto();
  startTick();
  mountCoins(carousel);

  return {
    setRoute(id: string) {
      if (id === 'home') {
        paintDots();
        poke();
        void loadCountries();
      }
    },
  };
}
