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
 * Mode selection is one Play button + a "Choose mode" bottom sheet. Play starts
 * immediately with the last setup (default 1v1 Normal). The sheet holds a
 * 2-column grid of preset cards with live renderer previews, a Custom entry
 * that opens the team builder, a disabled Online entry, a Bot level segmented
 * control and a sticky Start button whose label updates live.
 */
import type { Difficulty } from './bot';
import { menuState, motionReduced, onSettings, saveMenu } from './settings';
import { nameOf } from './countries';
import { getCountryRanking, getPlayerRanking, type CountryRow, type PlayerRow } from './data';
import { onChange, profile, theme } from './storage';
import { BOT_HANDLE, impact, openLink } from './telegram';
import { flagPhoto } from './compete';
import { getSquadRanking } from './squads';
import { newGame } from './rules';
import { createRenderer, type View } from './render';
import type { Router } from './router';
import type { Sheets } from './sheets';
import type { RaceSetup } from './menu';
import { onGameModeChange, paintLobby as paintGameLobby, paintSheetState as paintGameSheet, resetSheetView } from './gamemodes';
import starsImg from './assets/images/telegram_stars.png';

export interface HomeApi {
  router: Router;
  sheets: Sheets;
  start(setup: RaceSetup): void;
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

  /* ---------- Nations Cup: 44px rows + user row / pick-country CTA ----------
     Layout only — data (getCountryRanking) and handlers (openCountryPicker)
     are unchanged. Flags are MIT flag-icons SVGs vendored into
     src/assets/flags (© Lipis, MIT), rendered lazy in a 28px circle with a
     monogram fallback. The 2-letter code box is never rendered here. */

  const PODIUM_CLASS = ['gold', 'silver', 'bronze'] as const;

  const NATIONS_FLAG_SRC: Record<string, string> = {
    US: new URL('./assets/flags/us.svg', import.meta.url).href,
    BR: new URL('./assets/flags/br.svg', import.meta.url).href,
    JP: new URL('./assets/flags/jp.svg', import.meta.url).href,
    DE: new URL('./assets/flags/de.svg', import.meta.url).href,
    IN: new URL('./assets/flags/in.svg', import.meta.url).href,
    FR: new URL('./assets/flags/fr.svg', import.meta.url).href,
    GB: new URL('./assets/flags/gb.svg', import.meta.url).href,
    UA: new URL('./assets/flags/ua.svg', import.meta.url).href,
    TR: new URL('./assets/flags/tr.svg', import.meta.url).href,
    ES: new URL('./assets/flags/es.svg', import.meta.url).href,
  };

  const monogramOf = (name: string): string => {
    const parts = name.trim().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 0) return '•';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0].slice(0, 1) + parts[1].slice(0, 1)).toUpperCase();
  };

  const flagCircle = (code: string, name: string): HTMLSpanElement => {
    const wrap = document.createElement('span');
    wrap.className = 'flag-circle';
    wrap.setAttribute('aria-hidden', 'true');
    const src: string | undefined = NATIONS_FLAG_SRC[code.toUpperCase()];
    if (src) {
      const img = document.createElement('img');
      img.className = 'flag-img';
      img.src = src;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.draggable = false;
      img.addEventListener('error', () => {
        wrap.textContent = '';
        wrap.classList.add('is-fallback');
        const mono = document.createElement('span');
        mono.className = 'flag-mono';
        mono.textContent = monogramOf(name);
        wrap.append(mono);
      });
      wrap.append(img);
    } else {
      wrap.classList.add('is-fallback');
      const mono = document.createElement('span');
      mono.className = 'flag-mono';
      mono.textContent = monogramOf(name);
      wrap.append(mono);
    }
    return wrap;
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
    fl.append(flagCircle(c.code, c.name));
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = c.name;
    nm.title = c.name;
    const pt = document.createElement('span');
    pt.className = 'pt';
    const num = document.createElement('b');
    num.textContent = pts;
    pt.append(num);
    pt.title = `${pts} points`;
    const tr = document.createElement('span');
    tr.className = `tr ${c.trend}`;
    tr.textContent = trendTextOf(c);
    tr.title = trendLabel;
    tr.setAttribute('aria-hidden', 'true');
    li.append(rk, fl, nm, pt, tr);
    return li;
  };

  /** The player's own national contribution, under the top three. */
  const paintNationMine = (rows: CountryRow[]): void => {
    const el = document.getElementById('home-nation-mine');
    if (!el) return;
    const code = profile.country;
    if (!code) {
      el.textContent = 'Your nation: not set · Pick in Profile';
      el.removeAttribute('title');
      return;
    }
    const mine = rows.find((c) => c.code === code);
    const contributed = profile.stats.wins * 140;
    const rank = mine ? `#${mine.rank}` : '—';
    el.textContent = `Your nation: ${rank} · +${contributed.toLocaleString('en-US')} pts contributed`;
    el.setAttribute('title', `You fight for ${nameOf(code)}`);
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
      paintNationMine(all);
    } catch {
      list.textContent = '';
      const li = document.createElement('li');
      li.className = 'nations-row is-error';
      li.textContent = 'Rankings unavailable';
      list.append(li);
      const el = document.getElementById('home-nation-mine');
      if (el) el.textContent = 'Your nation: —';
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

  /* ---------- The Mind Ladder: top minds + your cognitive standing ----------
     Individual TIQ prestige. TIQ is the hero metric: bold gold digits, a tier
     chip drawn from the same bands the ladder uses, and the player's own
     percentile strip below the podium. No countdown, no capacity meter. */

  const MIND_TIERS: ReadonlyArray<{ min: number; name: string }> = [
    { min: 3000, name: 'Grandmaster' },
    { min: 2000, name: 'Strategist' },
    { min: 1000, name: 'Tactician' },
    { min: 0, name: 'Rookie' },
  ];

  const mindTier = (tiq: number): string =>
    (MIND_TIERS.find((t) => tiq >= t.min) ?? MIND_TIERS[MIND_TIERS.length - 1]).name;

  /** Your TIQ: 120 a win plus 20 a race — the exact formula the ladder reads. */
  const myTiq = (): number => Math.max(0, profile.stats.wins * 120 + profile.stats.games * 20);

  /** Nominal ladder pool + a monotone, deterministic rank/percentile (Preview data). */
  const MIND_POOL = 2400;
  const mindStanding = (tiq: number): { rank: number; pct: number } => {
    const rank = Math.min(MIND_POOL, Math.max(1, Math.round(MIND_POOL - (tiq / 3600) * (MIND_POOL - 1))));
    return { rank, pct: Math.min(100, Math.max(1, Math.round((rank / MIND_POOL) * 100))) };
  };

  const mindRow = (p: PlayerRow): HTMLLIElement => {
    const li = document.createElement('li');
    li.className = 'mind-row';
    const tier = mindTier(p.points);
    const score = p.points.toLocaleString('en-US');
    li.setAttribute('aria-label', `${p.name} — ${tier}, ${score} TIQ`);
    const av = document.createElement('span');
    av.className = 'mind-av';
    av.setAttribute('aria-hidden', 'true');
    const ini = document.createElement('b');
    ini.className = 'mind-ini';
    ini.textContent = monogramOf(p.name);
    av.append(ini, flagPhoto(p.countryCode, 'mind-flag'));
    const nm = document.createElement('span');
    nm.className = 'mind-nm';
    nm.textContent = p.name;
    nm.title = p.name;
    const chip = document.createElement('span');
    chip.className = 'mind-tier';
    chip.textContent = tier;
    const sc = document.createElement('span');
    sc.className = 'mind-score';
    sc.textContent = score;
    li.append(av, nm, chip, sc);
    return li;
  };

  const paintMindMine = (): void => {
    const el = document.getElementById('home-mind-mine');
    if (!el) return;
    const tiq = myTiq();
    const { rank, pct } = mindStanding(tiq);
    el.textContent = `You: Rank #${rank} · TIQ ${tiq.toLocaleString('en-US')} · Top ${pct}% Global Mind`;
  };

  const loadMinds = async (): Promise<void> => {
    const list = $('home-minds');
    paintMindMine();
    try {
      const all = await getPlayerRanking();
      list.textContent = '';
      for (const p of all.slice(0, 3)) list.append(mindRow(p));
    } catch {
      list.textContent = '';
      const li = document.createElement('li');
      li.className = 'mind-row is-error';
      li.textContent = 'Ladder unavailable';
      list.append(li);
    }
  };

  document.getElementById('home-mind-cta')?.addEventListener('click', () => {
    impact('light');
    poke();
    api.router.go('ranks');
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
     hands off to Telegram's own bot-admin deeplink (`?startchannel`), where the
     admin picks the channel and grants the rights — inside the client when the SDK
     is there, the system browser otherwise. */
  document.getElementById('home-tournament-admin')?.addEventListener('click', () => {
    impact('light');
    poke();
    openLink(`https://t.me/${BOT_HANDLE}?startchannel=true&admin=invite_users+pin_messages`);
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

  /* The vault's clock. Anchored to a real deadline 02h 45m out, so the line
     reads exactly as authored on arrival and then ticks honestly; it is only
     repainted while the tab is visible. */
  const tourClock = document.getElementById('tour-countdown');
  if (tourClock) {
    const endsAt = Date.now() + (2 * 60 + 45) * 60_000;
    const paintClock = (): void => {
      // Round up: 02h 45m out reads "02h 45m", not "02h 44m", on arrival.
      const totalMin = Math.max(0, Math.ceil((endsAt - Date.now()) / 60_000));
      const hh = Math.floor(totalMin / 60);
      const mm = totalMin % 60;
      tourClock.textContent = `${String(hh).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m`;
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

  homePlay.addEventListener('click', () => {
    impact('light');
    try {
      saveMenu({ mode: 'bot' });
    } catch {
      /* stay in memory */
    }
    api.start({ difficulty: menuState.difficulty, sizes: [...menuState.sizes] });
  });

  onChange(() => {
    void loadCountries();
    void loadMinds();
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
