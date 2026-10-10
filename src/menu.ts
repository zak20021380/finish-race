/**
 * menu.ts — everything around the board: home, mode select, settings and the two placeholders.
 * It holds no game logic; the only thing it decides is which race to ask main.ts to start.
 *
 * Home is the identity card, the wordmark and the ways to play — nothing else. Country and team
 * live in the save: the country is picked only in Profile (the language may suggest a row, nothing
 * is forced), and the team sheet is reachable from Home and Profile alike.
 */
import { DIFFICULTIES, type Difficulty } from './bot';
import { menuState, saveMenu, settings, setSetting, onSettings, type Settings } from './settings';
import {
  createTeam, favouriteMode, joinTeam, KINDS, leaveTeam, levelInfo, myTeam, onChange, profile,
  setCountry, theme,
} from './storage';
import { MAX_BALLS, newGame } from './rules';
import { createPreview, createRenderer, type Preview, type View } from './render';
import { setBalance } from './coin';
import { flagOf, guessCountry, nameOf, search } from './countries';
import { cleanCode, standings, YOU } from './teams';
import { BOT_RAMP, type CosKind } from './themes';
import type { Router } from './router';
import type { Sheets } from './sheets';
import { impact, languageCode, notify, startParam, tgUser } from './telegram';

export interface MenuApi {
  router: Router;
  sheets: Sheets;
  /** sheet ids come from the DOM so markup stays the single source of truth */
  sheet(id: string): HTMLElement | null;
  start(setup: RaceSetup): void;
  onBack(): void;
}

export interface Menu {
  setRoute(id: string): void;
  /** first launch: land on the team a `startapp=` invite named */
  afterStart(): void;
}

/** A race to start: how sharp the opponent is, and how many balls each side fields. */
export interface RaceSetup { difficulty: Difficulty; sizes: [number, number] }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const en = (n: number) => n.toLocaleString('en-US');

const PICK_ROW = '<span class="flag" aria-hidden="true"></span><span class="flag-code" aria-hidden="true"></span>'
  + '<span class="pick-n"></span>'
  + '<svg class="ico tick" aria-hidden="true"><use href="#i-check" /></svg>';

const make = (cls: string, html: string) => {
  const el = document.createElement('li');
  el.className = cls;
  el.innerHTML = html;
  return el;
};

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
  for (const [av, img, t, nm] of [
    ['avatar', 'avatar-img', 'avatar-t', 'p-name'],
    ['pf-avatar', 'pf-avatar-img', 'pf-avatar-t', 'pf-name'],
  ] as const) {
    $(nm).textContent = name;
    $(t).textContent = initials;
    const photo = $(img) as unknown as HTMLImageElement;
    if (u?.photo_url) { photo.src = u.photo_url; photo.hidden = false; $(av).style.background = 'none'; }
    /* a photo that fails to load must not leave a blank disc behind */
    photo.addEventListener('error', () => { photo.hidden = true; $(av).style.background = ''; });
  }

  /* ---------- country ---------- */
  const countrySheet = api.sheet('sheet-country');
  const countryList = $<HTMLElement>('country-list');
  const countryEmpty = $<HTMLElement>('country-empty');
  const countryQ = <HTMLInputElement>$('country-q');
  let pickIdx = 0;

  function paintCountryList(q: string) {
    const hits = search(q);
    countryList.textContent = '';
    for (const c of hits) {
      const li = make('pick-row', PICK_ROW);
      li.dataset.code = c.code;
      li.setAttribute('role', 'option');
      li.tabIndex = -1;
      li.setAttribute('aria-selected', String(c.code === profile.country));
      const kids = li.children;
      kids[0].textContent = flagOf(c.code);
      kids[1].textContent = c.code;
      kids[2].textContent = c.name;
      countryList.append(li);
    }
    countryEmpty.hidden = hits.length > 0;
    pickIdx = Math.max(0, hits.findIndex((c) => c.code === (profile.country ?? guessCountry(languageCode()))));
  }

  /** The row the picker would answer with, moved by the arrow keys. */
  function focusPick(move: number) {
    const items = [...countryList.querySelectorAll<HTMLElement>('.pick-row')];
    if (!items.length) return;
    pickIdx = Math.min(items.length - 1, Math.max(0, pickIdx + move));
    items[pickIdx].focus({ preventScroll: true });
    items[pickIdx].scrollIntoView({ block: 'nearest' });
  }

  function chooseCountry(code: string) {
    setCountry(code);
    notify('success');
    api.sheets.close();
  }

  countryQ.addEventListener('input', () => paintCountryList(countryQ.value));
  countryQ.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const f = countryList.querySelector<HTMLElement>('.pick-row'); if (f) chooseCountry(f.dataset.code!); }
    if (e.key === 'ArrowDown') { e.preventDefault(); focusPick(1); }
  });
  countryList.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusPick(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusPick(-1); }
    else if (e.key === 'Enter') { const r = document.activeElement as HTMLElement | null; const c = r?.dataset.code; if (c) chooseCountry(c); }
  });
  countryList.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.pick-row');
    if (!row) return;
    impact('light');
    chooseCountry(row.dataset.code!);
  });

  function openCountry() {
    if (!countrySheet) return;
    const seed = profile.country || guessCountry(languageCode());
    countryQ.value = '';
    paintCountryList('');
    api.sheets.open(countrySheet);
    /* land the list on the guess, so the common case is one tap */
    const want = seed ? countryList.querySelector<HTMLElement>(`[data-code=${JSON.stringify(seed)}]`) : null;
    if (want) { want.scrollIntoView({ block: 'center' }); want.focus({ preventScroll: true }); }
    impact('light');
  }

  /* ---------- team ---------- */
  const teamSheet = api.sheet('sheet-team');

  function paintTeam() {
    const t = myTeam();
    const none = $<HTMLElement>('team-none');
    const inTeam = $<HTMLElement>('team-in');
    none.hidden = !!t;
    inTeam.hidden = !t;
    if (!t) { $<HTMLElement>('team-err').hidden = true; return; }

    $<HTMLElement>('team-h-name').textContent = t.name;
    $<HTMLElement>('team-h-code').textContent = t.code;
    // the code is what a `startapp=team-<code>` link will one day carry; today it only joins locally
    $<HTMLElement>('team-h-note').textContent = t.seed
      ? 'A demo club on this device. Rosters become real with online play.'
      : `Invite code ${t.code} · link value ${t.startParam}`;
    $<HTMLElement>('team-h-size').textContent = String(t.members.length);

    const roster = $<HTMLElement>('team-roster');
    roster.textContent = '';
    for (const m of [...t.members].sort((a, b) => Number(b.captain) - Number(a.captain) || b.wins - a.wins)) {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = m.name;
      if (m.id === YOU) who.classList.add('you-tag');
      const tag = document.createElement('span');
      tag.className = 'capt';
      tag.textContent = m.captain ? 'Captain' : '';
      const wins = document.createElement('span');
      wins.className = 'n';
      wins.textContent = `${en(m.wins)}W / ${en(m.games)}`;
      li.append(who, tag, wins);
      roster.append(li);
    }

    const board = $<HTMLElement>('team-board');
    board.textContent = '';
    for (const s of standings(profile.teams).slice(0, 8)) {
      const li = document.createElement('li');
      const rank = document.createElement('span');
      rank.className = 'rank-n';
      rank.textContent = String(s.rank);
      const nm = document.createElement('span');
      nm.className = 'who';
      nm.textContent = s.team.name;
      const w = document.createElement('span');
      w.className = 'n';
      w.textContent = en(s.wins);
      li.append(rank, nm, w);
      if (s.team.id === profile.teamId) li.classList.add('me');
      board.append(li);
    }
  }

  function teamError(msg: string) {
    const el = $<HTMLElement>('team-err');
    el.textContent = msg;
    el.hidden = false;
    notify('warning');
  }

  $('team-create').addEventListener('click', () => {
    const raw = $<HTMLInputElement>('team-new').value;
    const r = createTeam(raw, name);
    if (r === 'short-name') return teamError('Give the team at least two characters.');
    if (r === 'already-in') return teamError('You are already in a team — leave it first.');
    if (r === 'full') return teamError('Could not mint a join code. Try again.');
    $<HTMLInputElement>('team-new').value = '';
    $<HTMLElement>('team-err').hidden = true;
    notify('success');
    paintTeam();
  });

  $('team-join').addEventListener('click', () => {
    const raw = $<HTMLInputElement>('team-code').value;
    const r = joinTeam(raw, name);
    if (r === 'no-code') return teamError(`No team on this device answers to ${cleanCode(raw) || 'that code'}.`);
    if (r === 'already-in') return teamError('You are already in a team — leave it first.');
    $<HTMLInputElement>('team-code').value = '';
    $<HTMLElement>('team-err').hidden = true;
    notify('success');
    paintTeam();
  });

  $('team-leave').addEventListener('click', () => {
    leaveTeam();
    impact('medium');
    paintTeam();
  });

  for (const el of [$<HTMLElement>('team-new'), $<HTMLInputElement>('team-code')]) {
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      ($('team-new') === document.activeElement ? $('team-create') : $('team-join')).click();
    });
  }

  function openTeam() {
    if (!teamSheet) return;
    paintTeam();
    api.sheets.open(teamSheet);
    impact('light');
  }

  /* ---- the entry points: the Home country chip jumps to Profile, where the picker lives ---- */
  $('country-chip').addEventListener('click', () => { impact('light'); api.router.go('profile'); });
  $('pf-country').addEventListener('click', openCountry);
  for (const id of ['team-chip', 'pf-team']) $(id).addEventListener('click', openTeam);

  /* ---- the record, and what is worn: re-painted whenever the save changes ---- */
  const pfScreen = $<HTMLElement>('s-profile');
  const eqPv = new Map<CosKind, Preview>();
  const setFlag = (flagId: string, codeId: string, code: string) => {
    $(flagId).textContent = code ? flagOf(code) : '';
    $(codeId).textContent = code;
  };
  const paintIdentity = () => {
    const lv = levelInfo();
    const t = myTeam();
    setBalance($('p-coins'), profile.coins);
    setBalance($('pf-coins'), profile.coins);
    for (const id of ['p-level', 'pf-level']) $(id).textContent = String(lv.n);
    $('p-xp').textContent = `${lv.got}/${lv.need} XP`;
    $('pf-xp').textContent = `${lv.got}/${lv.need} XP`;
    const bar = $<HTMLElement>('p-bar');
    $('p-fill').style.setProperty('--p', `${Math.round((lv.got / lv.need) * 100)}%`);
    bar.setAttribute('aria-valuenow', String(lv.got));
    bar.setAttribute('aria-valuemax', String(lv.need));
    bar.setAttribute('aria-valuetext', `Level ${lv.n}, ${lv.got} of ${lv.need} XP`);

    const c = profile.country;
    $('country-chip').classList.toggle('unset', !c);
    $('country-name').textContent = c ? nameOf(c) : 'Add country';
    setFlag('country-flag', 'country-code', c ?? '');
    $('pf-country-v').textContent = c ? nameOf(c) : 'Not set';
    setFlag('pf-flag', 'pf-code', c ?? '');

    $('team-name').textContent = t ? t.name : 'Find a team';
    $('team-count').textContent = t ? String(t.members.length) : '';
    $('pf-team-v').textContent = t ? `${t.name} · ${t.members.length}` : 'No team';
  };
  const paintProfile = () => {
    const s = profile.stats;
    paintIdentity();
    $('pf-games').textContent = en(s.games);
    $('pf-wins').textContent = en(s.wins);
    $('pf-losses').textContent = en(s.losses);
    $('pf-best').textContent = en(s.best);
    $('pf-streak').textContent = en(s.streak);
    const fav = favouriteMode();
    const favLabel = fav === 'bot' ? `${menuState.sizes[0]}v${menuState.sizes[1]}` : '—';
    $('pf-fav').textContent = favLabel;
    $('pf-fav-sub').textContent = s.games ? `${en(s.modes.bot ?? 0)} bot races` : 'No races yet';
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

  /* ---- difficulty: mode select owns the segmented control; Home shows fixed labels ---- */
  let difficulty: Difficulty = menuState.difficulty;
  const paintBotSub = () => {
    const el = document.getElementById('mode-bot-sub');
    if (el) el.textContent = 'vs Bot';
  };
  const paintDiff = () => {
    for (const b of segs) b.setAttribute('aria-pressed', String(b.dataset.diff === difficulty));
    paintBotSub();
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

  /* ---- custom teams: two steppers, the same difficulty, a live board preview, Start ---- */
  const customScreen = $<HTMLElement>('s-custom');
  const customSteps = [$<HTMLElement>('step-0'), $<HTMLElement>('step-1')];
  const customBtns = [...document.querySelectorAll<HTMLButtonElement>('.step-b')];
  const customPv = $<HTMLCanvasElement>('custom-pv');
  const customTip = $<HTMLElement>('custom-tip');
  const customSwatch = [$<HTMLElement>('swatch-0'), $<HTMLElement>('swatch-1')];
  let custom: [number, number] = [...menuState.sizes];
  let teamPv: ReturnType<typeof createRenderer> | null = null;
  let customDrawn = false;

  /**
   * The starting positions, painted by the race's own renderer rather than a picture of one —
   * the same board the race will draw, with the balls already spread where they will start.
   */
  function paintCustomPv() {
    if (customScreen.hidden || !customDrawn) return;      // a hidden canvas has no width to lay out
    if (!teamPv) teamPv = createRenderer(customPv, { theme });
    teamPv.setTheme(theme());
    teamPv.resize();
    const s = newGame(custom);
    const v: View = {
      state: s,
      balls: s.balls.map((b) => ({ pos: { x: b.pos.c + 0.5, y: b.pos.r + 0.5 }, team: b.team, id: b.id, sel: false })),
      hints: [], ghost: null, last: [null, null], thinking: null,
    };
    const t = performance.now();
    teamPv.draw(v, t);
    teamPv.draw(v, t + 600);             // settle the pop-in clocks past their first frame
  }

  /** Each side's colour family, taken from the same data the board draws with. */
  const paintSwatches = () => {
    customSwatch[0].style.setProperty('--tint', theme().ball.ramp.mid);
    customSwatch[1].style.setProperty('--tint', BOT_RAMP.mid);
  };

  function paintCustom() {
    for (const t of [0, 1] as const) {
      customSteps[t].textContent = String(custom[t]);
      for (const b of customBtns) {
        if (Number(b.dataset.team) !== t) continue;
        b.disabled = Number(b.dataset.step) < 0 ? custom[t] <= 1 : custom[t] >= MAX_BALLS;
      }
    }
    const n = custom[0] + custom[1];
    customTip.textContent = `${custom[0]}v${custom[1]} · ${n} ball${n === 1 ? '' : 's'} on the board, first to the top row wins`;
    paintCustomPv();
  }

  function nudge(team: 0 | 1, step: number) {
    const next = Math.max(1, Math.min(MAX_BALLS, custom[team] + step));
    if (next === custom[team]) return;
    custom[team] = next;
    saveMenu({ sizes: [...custom] });
    paintBotSub();
    impact('light');
    paintCustom();
  }

  for (const b of customBtns) {
    b.addEventListener('click', () => nudge(Number(b.dataset.team) as 0 | 1, Number(b.dataset.step)));
  }

  $('custom-start').addEventListener('click', () => {
    impact('light');
    saveMenu({ mode: 'bot', sizes: [...custom] });
    api.start({ difficulty, sizes: [...custom] });
  });

  new ResizeObserver(() => paintCustomPv()).observe(customScreen);
  onChange(paintSwatches);

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
  /** vs Bot races the last configuration saved; the Teams row and the presets pick their own sizes. */
  for (const el of document.querySelectorAll<HTMLElement>('[data-start]')) {
    el.addEventListener('click', () => {
      if (el.getAttribute('aria-disabled') === 'true') return;   // Online: the badge is the answer
      if (el.dataset.start !== 'bot') return;                    // vs Bot is the only race that starts
      impact('light');
      saveMenu({ mode: 'bot' });
      api.start({ difficulty, sizes: [...menuState.sizes] });
    });
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-preset]')) {
    el.addEventListener('click', () => {
      const [a, b] = (el.dataset.preset ?? '').split(',').map(Number);
      if (!a || !b) return;
      impact('light');
      saveMenu({ mode: 'bot', sizes: [a, b] });
      api.start({ difficulty, sizes: [a, b] });
    });
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-go]')) {
    el.addEventListener('click', () => { impact('light'); api.router.go(el.dataset.go as string); });
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-back]')) {
    el.addEventListener('click', () => { impact('light'); api.onBack(); });
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
  paintSwatches();
  paintCustom();

  /** A `startapp=team-XXXX` link pre-fills the join field, so an invite lands somewhere useful. */
  const invite = /^team-([a-z0-9]{1,5})$/i.exec(startParam());
  if (invite && !profile.teamId) {
    const f = $<HTMLInputElement>('team-code');
    f.value = cleanCode(invite[1]);
  }

  return {
    setRoute(id) {
      tabbar.hidden = id === 'game';
      if (id === 'profile') paintProfile();       // the equipped row is only laid out once it is showing
      /* Home now commits the strength live, so re-read it whenever these screens come forward */
      if (id === 'modes' || id === 'custom') {
        difficulty = menuState.difficulty;
        paintDiff();
      }
      if (id === 'custom') {                      // the preview is the same board, smaller
        custom = [...menuState.sizes];
        customDrawn = true;
        paintCustom();
      }
      const active = id === 'home' || id === 'modes' || id === 'custom' || id === 'game' ? 'home' : id;
      for (const t of tabs) {
        const on = t.dataset.tab === active;
        if (on) t.setAttribute('aria-current', 'page');
        else t.removeAttribute('aria-current');
      }
    },
    afterStart() {
      if (invite && !profile.teamId) openTeam();
    },
  };
}
