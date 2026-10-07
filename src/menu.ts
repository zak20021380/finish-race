/**
 * menu.ts — everything around the board: home, mode select, settings and the two placeholders.
 * It holds no game logic; the only thing it decides is which race to ask main.ts to start.
 */
import { DIFFICULTIES, type Difficulty } from './bot';
import { menuState, saveMenu, settings, setSetting, onSettings, type Mode, type Settings } from './settings';
import { favouriteMode, KINDS, onChange, profile, theme } from './storage';
import { createPreview, type Preview } from './render';
import type { CosKind } from './themes';
import type { Router } from './router';
import type { Sheets } from './sheets';
import { impact, tgUser } from './telegram';

export interface MenuApi {
  router: Router;
  sheets: Sheets;
  /** sheet ids come from the DOM so markup stays the single source of truth */
  sheet(id: string): HTMLElement | null;
  start(mode: Mode, difficulty: Difficulty): void;
  onBack(): void;
}

export interface Menu {
  setRoute(id: string): void;
}

/** Level is still a mock: there is no XP curve behind it yet. Coins and results are not — they come
 *  from the save, so the wallet on Home and the one in the Shop can never disagree. */
const LEVEL = 7;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const en = (n: number) => n.toLocaleString('en-US');

export function createMenu(api: MenuApi): Menu {
  const tabs = [...document.querySelectorAll<HTMLElement>('.tab[data-tab]')];
  const segs = [...document.querySelectorAll<HTMLElement>('.seg-b[data-diff]')];
  const rows = [...document.querySelectorAll<HTMLElement>('.row[data-set]')];
  const tabbar = $<HTMLElement>('tabs');

  /* ---- who is playing ---- */
  const u = tgUser();
  const full = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
  const name = (full || u?.username || 'Player').slice(0, 18);
  const initials = (full ? full.split(/\s+/).map((w) => w[0]).join('') : name.slice(0, 2))
    .replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 2) || 'PL';
  for (const [av, nm] of [['avatar', 'p-name'], ['pf-avatar', 'pf-name']] as const) {
    $(av).textContent = initials;
    $(nm).textContent = name;
  }
  $('p-level').textContent = String(LEVEL);
  $('pf-level').textContent = String(LEVEL);

  /* ---- the record, and what is worn: re-painted whenever the save changes ---- */
  const pfScreen = $<HTMLElement>('s-profile');
  const eqPv = new Map<CosKind, Preview>();
  const paintProfile = () => {
    const s = profile.stats;
    $('p-coins').textContent = en(profile.coins);
    $('p-streak').textContent = en(s.streak);
    $('pf-coins').textContent = en(profile.coins);
    $('pf-games').textContent = en(s.games);
    $('pf-wins').textContent = en(s.wins);
    $('pf-losses').textContent = en(s.losses);
    $('pf-best').textContent = en(s.best);
    $('pf-streak').textContent = en(s.streak);
    const fav = favouriteMode();
    $('pf-fav').textContent = fav === 'local' ? 'Pass & Play' : fav === 'bot' ? 'vs Bot' : '—';
    $('pf-fav-sub').textContent = s.games ? `${en(s.modes.bot ?? 0)} bot · ${en(s.modes.local ?? 0)} duo` : 'No races yet';
    if (pfScreen.hidden) return;                        // a hidden canvas has no width to lay out
    const t = theme();
    for (const k of KINDS) {
      let pv = eqPv.get(k);
      if (!pv) {
        pv = createPreview(document.querySelector<HTMLCanvasElement>(`canvas[data-eq=${JSON.stringify(k)}]`)!, k, t);
        eqPv.set(k, pv);
      } else pv.setTheme(t);
      pv.resize();
      pv.settle();
      $(`eq-${k}`).textContent = t[k].name;
    }
  };
  onChange(paintProfile);
  paintProfile();
  new ResizeObserver(() => { if (!pfScreen.hidden) paintProfile(); }).observe(pfScreen);

  /* ---- difficulty ---- */
  let difficulty: Difficulty = menuState.difficulty;
  const paintDiff = () => {
    for (const b of segs) b.setAttribute('aria-pressed', String(b.dataset.diff === difficulty));
  };
  for (const b of segs) {
    b.addEventListener('click', () => {
      const d = b.dataset.diff as Difficulty;
      if (!DIFFICULTIES.includes(d) || d === difficulty) return;
      difficulty = d;
      saveMenu({ difficulty: d });
      paintDiff();
      impact('light');
    });
  }

  /* ---- settings switches ---- */
  const paintSettings = () => {
    for (const r of rows) r.setAttribute('aria-checked', String(Boolean(settings[r.dataset.set as keyof Settings])));
  };
  for (const r of rows) {
    r.addEventListener('click', () => {
      const k = r.dataset.set as keyof Settings;
      setSetting(k, !settings[k]);
      impact('light');
    });
  }
  onSettings(paintSettings);

  /* ---- mode cards ---- */
  for (const el of document.querySelectorAll<HTMLElement>('[data-start]')) {
    el.addEventListener('click', () => {
      if (el.getAttribute('aria-disabled') === 'true') return;   // Online: the badge is the answer
      const mode = el.dataset.start as Mode;
      impact('light');
      saveMenu({ mode });
      api.start(mode, difficulty);
    });
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-go]')) {
    el.addEventListener('click', () => { impact('light'); api.router.go(el.dataset.go as string); });
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-back]')) {
    el.addEventListener('click', () => api.onBack());
  }
  $('help-btn').addEventListener('click', () => {
    const sheet = api.sheet('sheet-help');
    if (sheet) { impact('light'); api.sheets.open(sheet); }
  });

  /* ---- tabs ---- */
  for (const t of tabs) {
    t.addEventListener('click', () => { impact('light'); api.router.go(t.dataset.tab as string); });
  }

  paintDiff();
  paintSettings();

  return {
    setRoute(id) {
      tabbar.hidden = id === 'game';
      if (id === 'profile') paintProfile();       // the equipped row is only laid out once it is showing
      const active = id === 'home' || id === 'modes' ? 'modes' : id;
      for (const t of tabs) {
        const on = t.dataset.tab === active;
        if (on) t.setAttribute('aria-current', 'page');
        else t.removeAttribute('aria-current');
      }
    },
  };
}
