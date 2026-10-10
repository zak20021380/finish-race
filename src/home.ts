/**
 * home.ts — Home: identity card, flexible highlights, then the single Play launcher.
 *
 * Home never scrolls vertically; the carousel is the one horizontal gesture
 * (CSS scroll-snap + `touch-action: pan-x`, `data-carousel` opts out of the
 * global touchmove guard in main.ts). Auto-advance is slow and pauses on touch.
 * Each slide is 100% of the viewport width inside an overflow-hidden wrap, so
 * only the active slide shows cleanly between the paging dots. `.is-active`
 * marks the slide in focus (state binding preserved, no visual peek).
 *
 * Mode selection is one Play button + a "Choose mode" bottom sheet. Play starts
 * immediately with the last setup (default 1v1 Normal). The sheet holds a
 * 2-column grid of preset cards with live renderer previews, a Custom entry
 * that opens the team builder, a disabled Online entry, a Bot level segmented
 * control and a sticky Start button whose label updates live.
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
import { earnCoins, onChange, profile, theme } from './storage';
import { awardSquadPoints, getChannelCup, getMySquad, onSquadChange } from './squads';
import { impact, notify } from './telegram';
import { newGame } from './rules';
import { createRenderer, type View } from './render';
import type { Router } from './router';
import type { Sheets } from './sheets';
import type { RaceSetup } from './menu';
import { getLobbyDisplay, onGameModeChange, paintLobby as paintGameLobby, paintSheetState as paintGameSheet } from './gamemodes';

export interface HomeApi {
  router: Router;
  sheets: Sheets;
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
      goSlide((activeSlide() + 1) % slides.length);
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
    const pct = featured.maxPlayers > 0
      ? Math.min(100, Math.max(0, Math.round((featured.players / featured.maxPlayers) * 100)))
      : 0;
    const fill = document.getElementById('feat-fill') as HTMLElement | null;
    if (fill) fill.style.width = `${pct}%`;
    const bar = document.getElementById('feat-bar') as HTMLElement | null;
    if (bar) bar.setAttribute('aria-valuenow', String(pct));
    const mood = featured.status === 'ended' ? 'Ended' : pct >= 85 ? 'Almost Full' : pct >= 50 ? 'Filling fast' : 'Open';
    const label = $('feat-players');
    label.textContent = '';
    label.append(
      document.createTextNode(`${featured.players} / ${featured.maxPlayers} joined · `),
      (() => {
        const hot = document.createElement('span');
        hot.className = 'hot';
        hot.textContent = mood;
        return hot;
      })(),
    );
    label.setAttribute('aria-label', `${featured.players} of ${featured.maxPlayers} joined, ${mood}`);
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
    api.router.go('arena');
  });

  /* ---------- Telegram Channel Cup: live squad war slide ---------- */

  const paintCup = (): void => {
    const cup = getChannelCup();
    const me = getMySquad();
    ($('cup-prize') as HTMLElement).textContent = coinText(cup.prizePool);
    $('cup-players').textContent = `${cup.players.toLocaleString('en-US')} fighters`;
    $('cup-count').textContent = formatCountdown(cup.endsAt);
    const top = $('cup-top');
    if (cup.top) {
      top.textContent = '';
      const lead = document.createElement('b');
      lead.textContent = cup.top.handle;
      const rest = document.createElement('small');
      rest.textContent = ` leads · ${cup.top.trophies.toLocaleString('en-US')} 🏆`;
      top.append(lead, document.createTextNode(' '), rest);
    } else {
      top.textContent = 'No squads yet';
    }
    const fight = $('cup-fight') as HTMLButtonElement;
    const sub = $('cup-sub');
    if (me) {
      fight.disabled = false;
      fight.textContent = 'Fight for Squad';
      fight.setAttribute('aria-label', `Fight for ${me.handle}: score for you and your squad`);
      sub.textContent = `Fighting as ${me.handle} · #${me.rank}`;
    } else {
      fight.disabled = false;
      fight.textContent = 'Enter Cup';
      fight.setAttribute('aria-label', 'Enter Cup: bind a Telegram squad first');
      sub.textContent = 'Points go to you + your squad';
    }
    mountCoins(carousel);
  };

  let cupCooldown = 0;
  ($('cup-fight') as HTMLButtonElement).addEventListener('click', () => {
    const now = Date.now();
    if (now < cupCooldown) return;
    const me = getMySquad();
    if (!me) {
      // Unbound: the squad sheet is the CTA — same door as the header pill.
      impact('light');
      ($('team-chip') as HTMLButtonElement).click();
      return;
    }
    cupCooldown = now + 1200;
    awardSquadPoints(25);
    earnCoins(25);
    notify('success');
    impact('medium');
    const fight = $('cup-fight') as HTMLButtonElement;
    const prev = fight.textContent;
    fight.textContent = '+25 for Squad';
    fight.disabled = true;
    window.setTimeout(() => { fight.disabled = false; if (fight.textContent === '+25 for Squad') fight.textContent = prev; }, 1200);
    paintCup();
  });

  onSquadChange(() => { paintCup(); });

  /* ---------- Nations Cup: podium rows + gamified country CTA ---------- */

  const PODIUM_CLASS = ['gold', 'silver', 'bronze'] as const;

  const rowEl = (c: CountryRow, me: boolean): HTMLLIElement => {
    const li = document.createElement('li');
    li.classList.add('nations-row');
    li.classList.add(`rank-${c.rank}`);
    if (me) li.classList.add('me');
    const pts = c.points.toLocaleString('en-US');
    const trendLabel = c.trend === 'up' ? 'rising' : c.trend === 'down' ? 'dropping' : 'steady';
    li.setAttribute('aria-label', `#${c.rank} ${c.name} — ${pts} points, ${trendLabel}`);
    const rk = document.createElement('span');
    const podium = c.rank >= 1 && c.rank <= 3 ? PODIUM_CLASS[c.rank - 1] : '';
    rk.className = podium ? `rk rank-${c.rank} ${podium}` : `rk rank-${c.rank}`;
    rk.textContent = String(c.rank);
    rk.setAttribute('aria-hidden', 'true');
    const fl = document.createElement('span');
    fl.className = 'fl';
    fl.setAttribute('aria-hidden', 'true');
    const flag = document.createElement('span');
    flag.className = 'flag';
    flag.textContent = flagOf(c.code);
    const code = document.createElement('span');
    code.className = 'flag-code';
    code.textContent = c.code;
    fl.append(flag, code);
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = c.name;
    nm.title = c.name;
    const pt = document.createElement('span');
    pt.className = 'pt';
    const cup = document.createElement('span');
    cup.className = 'cup';
    cup.textContent = '🏆';
    cup.setAttribute('aria-hidden', 'true');
    const num = document.createElement('b');
    num.textContent = pts;
    pt.append(cup, num);
    const tr = document.createElement('span');
    tr.className = `tr ${c.trend}`;
    tr.textContent = trendArrow(c.trend);
    tr.title = trendLabel;
    tr.setAttribute('aria-hidden', 'true');
    li.append(rk, fl, nm, pt, tr);
    return li;
  };

  const paintCountryCta = (all: CountryRow[] | null): void => {
    const cta = document.getElementById('home-country-cta') as HTMLButtonElement | null;
    const flagEl = document.getElementById('home-country-cta-flag');
    const codeEl = document.getElementById('home-country-cta-code');
    const label = document.getElementById('home-country-cta-label');
    const reward = document.getElementById('home-country-cta-reward');
    if (!cta || !label || !reward) return;
    const code = profile.country;
    const mine = code && all ? all.find((c) => c.code === code) : undefined;
    if (!code) {
      if (flagEl) flagEl.textContent = '🌍';
      if (codeEl) codeEl.textContent = '';
      label.textContent = 'Represent Your Flag';
      reward.innerHTML = '<span class="coin coin-xs" data-coin aria-hidden="true"></span><b>+100</b>';
      cta.classList.remove('is-set');
      cta.setAttribute('aria-label', 'Represent your flag in Profile — earn 100 coins');
    } else {
      const total = all?.length ?? 10;
      const rank = mine?.rank;
      const pct = rank ? Math.max(1, Math.round((rank / Math.max(1, total)) * 100)) : null;
      if (flagEl) flagEl.textContent = flagOf(code);
      if (codeEl) codeEl.textContent = code;
      if (mine && rank && pct !== null) {
        label.textContent = `${nameOf(code)} · #${rank} · Top ${pct}%`;
        reward.innerHTML = '';
        const r = document.createElement('b');
        r.textContent = `#${rank}`;
        reward.append(r);
      } else {
        label.textContent = `${nameOf(code)} · warming up`;
        reward.innerHTML = '';
        const r = document.createElement('b');
        r.textContent = '•';
        reward.append(r);
      }
      cta.classList.add('is-set');
      cta.setAttribute('aria-label', `Your flag ${nameOf(code)}${rank ? `, ranked #${rank}` : ''} — change country in Profile`);
    }
    mountCoins(cta);
  };

  const openCountryPicker = (): void => {
    impact('light');
    poke();
    try {
      api.router.go('profile');
    } catch {
      /* router unavailable — fall through to the sheet */
    }
    // Land on Profile, then pop the country drawer so it is one tap door-to-door.
    window.setTimeout(() => {
      const pf = document.getElementById('pf-country') as HTMLButtonElement | null;
      if (pf && !pf.hidden) {
        pf.click();
        return;
      }
      const sheet = document.getElementById('sheet-country');
      if (sheet) {
        try {
          api.sheets.open(sheet as HTMLElement);
        } catch {
          /* sheet unavailable */
        }
      }
    }, 80);
  };

  const loadCountries = async (): Promise<void> => {
    const list = $('home-countries');
    try {
      const all = await getCountryRanking();
      const top3 = all.slice(0, 3);
      list.textContent = '';
      for (const c of top3) {
        list.append(rowEl(c, profile.country === c.code));
      }
      const mine = profile.country ? all.find((c) => c.code === profile.country) : undefined;
      // The footer CTA owns the user's row (rank + Top %) so the card never
      // grows a 4th line — height stays identical across carousel slides.
      paintCountryCta(all);
      const note = $('home-country-note');
      note.hidden = true;
      if (profile.country) {
        note.textContent = mine
          ? `You cheer for ${nameOf(profile.country)} (#${mine.rank})`
          : `Your country: ${nameOf(profile.country)}`;
      } else {
        note.textContent = 'Pick your country in Profile';
      }
      mountCoins(list);
    } catch {
      list.textContent = '';
      const li = document.createElement('li');
      li.className = 'nations-row is-error';
      li.textContent = 'Rankings unavailable';
      list.append(li);
      paintCountryCta(null);
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

  /* ---------- launcher: one Play button + summary + sheet draft ---------- */

  const homePlay = $('home-play') as HTMLButtonElement;
  const homeSub = $('home-play-sub') as HTMLElement;
  const modeChange = document.getElementById('mode-change') as HTMLButtonElement | null;
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

  const paintLauncher = (): void => {
    // Game Mode Selector owns the lobby card: title + TYPE badge (TEAM / RANKED etc).
    const lobby = getLobbyDisplay();
    if (homeSub) homeSub.textContent = lobby.sub;
    const titleEl = document.getElementById('home-play-title');
    if (titleEl) titleEl.textContent = lobby.title;
    const diffEl = document.getElementById('home-play-diff');
    if (diffEl) {
      diffEl.textContent = lobby.badge;
      diffEl.setAttribute('data-gmode', lobby.id);
      diffEl.removeAttribute('data-diff');
    }
    const useEl = document.getElementById('mode-hero-use') as SVGUseElement | null;
    if (useEl) useEl.setAttribute('href', lobby.icon);
    homePlay.setAttribute('aria-label', `Play ${lobby.title} — ${lobby.badge}`);
    // Keep the shared painter in sync for callers that bypass this closure.
    try {
      paintGameLobby();
    } catch {
      /* DOM not ready */
    }
  };

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

  /** Game Mode Selector sheet: the Change key's one door (see gamemodes.ts). */
  const openGameModes = (): void => {
    const el = document.getElementById('sheet-game-modes') as HTMLElement | null;
    if (!el) {
      openSheet();
      return;
    }
    try {
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

  modeChange?.addEventListener('click', () => {
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
  document.getElementById('home-country-cta')?.addEventListener('click', openCountryPicker);
  $('home-settings').addEventListener('click', () => {
    impact('light');
    api.router.go('settings');
  });

  /* ---------- launcher input ---------- */

  homePlay.addEventListener('click', () => {
    impact('light');
    try {
      saveMenu({ mode: 'bot' });
    } catch {
      /* stay in memory */
    }
    api.start({ difficulty: menuState.difficulty, sizes: [...menuState.sizes] });
  });

  /* ---------- countdown ticker ---------- */

  const startTick = (): void => {
    if (tick) return;
    tick = window.setInterval(() => {
      if ($('s-home').hidden) return;
      if (featured && featured.status !== 'ended') {
        $('feat-count').textContent = formatCountdown(featured.endsAt);
      }
      const cup = getChannelCup();
      const el = $('cup-count');
      if (el) el.textContent = formatCountdown(cup.endsAt);
    }, 1000);
  };

  onChange(() => {
    void loadCountries();
    void loadDaily();
    paintLauncher();
    paintSheet();
    paintPreviews();
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
  void loadFeatured();
  void loadCountries();
  void loadDaily();
  paintDots();
  paintLauncher();
  paintSheet();
  paintCup();
  armAuto();
  startTick();
  mountCoins(carousel);

  return {
    setRoute(id: string) {
      if (id !== 'home') return;
      paintDots();
      poke();
      paintLauncher();
      paintSheet();
      paintCup();
      void loadCountries();
    },
  };
}
