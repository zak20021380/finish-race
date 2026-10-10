/**
 * menu.ts — everything around the board: home, mode select, settings and the two placeholders.
 * It holds no game logic; the only thing it decides is which race to ask main.ts to start.
 *
 * Home is the identity card, the wordmark and the ways to play — nothing else. Country and team
 * live in the save: the country is picked only in Profile (the language may suggest a row, nothing
 * is forced), and the team sheet is reachable from Home and Profile alike.
 */
import { DIFFICULTIES, type Difficulty } from './bot';
import {
  LANGS, lang, langDef, onLang, setLang, t,
  menuState, saveMenu, settings, setSetting, onSettings, type LangCode, type Settings,
} from './settings';
import {
  AGE_MAX, AGE_MIN, claimIdentityReward, createTeam, favouriteMode, IDENTITY_REWARD, joinTeam, KINDS,
  leaveTeam, levelInfo, myTeam, onChange, profile,
  setAge, setCountry, theme,
} from './storage';
import { MAX_BALLS, newGame } from './rules';
import { createPreview, createRenderer, type Preview, type View } from './render';
import { setBalance } from './coin';
import { flagOf, guessCountry, nameOf, search } from './countries';
import { cleanCode, standings, YOU } from './teams';
import {
  bindSquad, bindSquadById, cleanHandle, getMySquad, leaveSquad,
  onSquadChange, searchSquads, squadLetter,
} from './squads';
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
    const paid = claimIdentityReward('country');
    notify('success');
    api.sheets.close();
    if (paid > 0) showPfToast(`+${paid} Coins · Country set`);
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

  /* ---------- profile completion toast: animated +100 confirmation ---------- */
  let pfToastTimer = 0;
  function showPfToast(msg: string) {
    const toast = document.getElementById('pf-toast');
    const label = document.getElementById('pf-toast-t');
    if (!toast || !label) return;
    label.textContent = msg;
    toast.hidden = false;
    toast.classList.remove('out', 'bump');
    void toast.offsetWidth; // restart the entrance each time
    toast.classList.add('show', 'bump');
    window.clearTimeout(pfToastTimer);
    pfToastTimer = window.setTimeout(() => {
      toast.classList.add('out');
      window.setTimeout(() => { toast.hidden = true; toast.classList.remove('show', 'out', 'bump'); }, 260);
    }, 2300);
  }

  /* ---------- age: optional stepper drawer, claimed once like country ---------- */
  const ageSheet = api.sheet('sheet-age');
  let ageDraft = profile.age ?? 18;
  const paintAgeDraft = () => {
    $('age-n').textContent = String(ageDraft);
    ($('age-minus') as HTMLButtonElement).disabled = ageDraft <= AGE_MIN;
    ($('age-plus') as HTMLButtonElement).disabled = ageDraft >= AGE_MAX;
    const hint = $<HTMLElement>('age-hint');
    if (profile.rewards.age) { hint.hidden = true; return; }
    hint.hidden = false;
    hint.textContent = `Save to claim +${IDENTITY_REWARD} coins · ${AGE_MIN}–${AGE_MAX}, optional`;
  };

  function openAge() {
    if (!ageSheet) return;
    ageDraft = profile.age ?? 18;
    ageDraft = Math.max(AGE_MIN, Math.min(AGE_MAX, ageDraft));
    paintAgeDraft();
    api.sheets.open(ageSheet);
    impact('light');
  }

  function saveAge() {
    setAge(ageDraft);
    const paid = claimIdentityReward('age');
    notify('success');
    impact('medium');
    api.sheets.close();
    if (paid > 0) showPfToast(`+${paid} Coins · Age set`);
  }

  function clearAge() {
    setAge(null);
    notify('success');
    impact('light');
    api.sheets.close();
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

  /* ---------- squad: Telegram channel binding (header pill owns this sheet) ---------- */
  const squadSheet = api.sheet('sheet-squad');
  const squadQ = $('squad-q') as HTMLInputElement;
  const squadList = $<HTMLElement>('squad-list');
  const squadEmpty = $<HTMLElement>('squad-empty');
  const squadErr = $<HTMLElement>('squad-err');
  const squadSearchView = $<HTMLElement>('squad-search-view');
  const squadBoundView = $<HTMLElement>('squad-bound-view');

  function squadError(msg: string) {
    squadErr.textContent = msg;
    squadErr.hidden = false;
    notify('warning');
  }

  function paintSquadPill() {
    const me = getMySquad();
    const chip = $<HTMLElement>('team-chip');
    const label = $<HTMLElement>('team-name');
    const rank = $<HTMLElement>('team-count');
    const avatar = $<HTMLElement>('squad-avatar');
    if (me) {
      chip.classList.add('bound');
      avatar.hidden = false;
      avatar.textContent = squadLetter(me);
      label.textContent = me.handle;
      rank.hidden = false;
      rank.textContent = `#${me.rank}`;
      chip.setAttribute('aria-label', `${me.handle}, squad rank ${me.rank}. Open squad.`);
    } else {
      chip.classList.remove('bound');
      avatar.hidden = true;
      label.textContent = 'Join Squad';
      rank.hidden = true;
      rank.textContent = '';
      chip.setAttribute('aria-label', 'Join Squad');
    }
  }

  function paintSquadList(q: string) {
    const rows = searchSquads(q);
    const me = getMySquad();
    squadList.textContent = '';
    const needle = cleanHandle(q);
    const hasExact = needle && rows.some((s) => s.handle.toLowerCase() === needle.toLowerCase());
    if (needle && !hasExact) {
      const li = document.createElement('li');
      li.className = 'pick-row';
      li.setAttribute('role', 'option');
      li.tabIndex = -1;
      li.dataset.handle = needle;
      li.innerHTML = '';
      const av = document.createElement('span');
      av.className = 'squad-avatar';
      av.textContent = squadLetter({ handle: needle, name: needle });
      const nm = document.createElement('span');
      nm.className = 'pick-n';
      nm.textContent = `Bind ${needle}`;
      const sub = document.createElement('small');
      sub.textContent = 'New channel · starts at 0 trophies';
      nm.append(sub);
      li.append(av, nm);
      squadList.append(li);
    }
    for (const s of rows) {
      const li = document.createElement('li');
      li.className = 'pick-row';
      li.setAttribute('role', 'option');
      li.tabIndex = -1;
      li.dataset.squad = s.id;
      li.setAttribute('aria-selected', String(me?.id === s.id));
      const av = document.createElement('span');
      av.className = 'squad-avatar';
      av.textContent = squadLetter(s);
      const nm = document.createElement('span');
      nm.className = 'pick-n';
      nm.textContent = `${s.handle} · ${s.name}`;
      const sub = document.createElement('small');
      sub.textContent = `#${s.rank} · ${en(s.members)} members · ${en(s.trophies)} trophies`;
      nm.append(sub);
      const tick = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      tick.setAttribute('class', 'ico tick');
      tick.setAttribute('aria-hidden', 'true');
      tick.innerHTML = '<use href="#i-check" />';
      li.append(av, nm, tick);
      squadList.append(li);
    }
    squadEmpty.hidden = squadList.childElementCount > 0;
    if (!squadList.childElementCount) squadEmpty.textContent = q.trim() ? 'No squad matches that.' : 'No squads yet.';
  }

  function showSquadSearch() {
    squadSearchView.hidden = false;
    squadBoundView.hidden = true;
    $('squad-title').textContent = 'Join Squad';
    squadErr.hidden = true;
    paintSquadList(squadQ.value);
  }

  function showSquadBound() {
    const me = getMySquad();
    if (!me) { showSquadSearch(); return; }
    squadSearchView.hidden = true;
    squadBoundView.hidden = false;
    $('squad-title').textContent = 'Your Squad';
    $<HTMLElement>('squad-view-avatar').textContent = squadLetter(me);
    $<HTMLElement>('squad-view-name').textContent = me.handle;
    $<HTMLElement>('squad-view-rank').textContent = `#${me.rank}`;
    $<HTMLElement>('squad-view-sub').textContent = `${me.name} · ${en(me.members)} members cheer for this channel.`;
    $<HTMLElement>('squad-view-members').textContent = en(me.members);
    $<HTMLElement>('squad-view-points').textContent = en(me.trophies);
    $<HTMLElement>('squad-view-pos').textContent = `#${me.rank}`;
  }

  function openSquad() {
    if (!squadSheet) return;
    squadQ.value = '';
    const me = getMySquad();
    if (me) showSquadBound();
    else showSquadSearch();
    api.sheets.open(squadSheet);
    impact('light');
  }

  function commitBind(handleOrId: string, isId: boolean) {
    const r = isId ? bindSquadById(handleOrId) : bindSquad(handleOrId);
    if (r === 'bad-handle') return squadError('That is not a channel handle — try @channel.');
    squadErr.hidden = true;
    notify('success');
    impact('medium');
    paintSquadPill();
    showSquadBound();
  }

  squadQ.addEventListener('input', () => { squadErr.hidden = true; paintSquadList(squadQ.value); });
  squadQ.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = squadQ.value;
    const rows = searchSquads(q);
    if (rows.length === 1 && !cleanHandle(q)) { commitBind(rows[0].id, true); return; }
    if (cleanHandle(q)) { commitBind(q, false); return; }
    if (rows.length) { commitBind(rows[0].id, true); return; }
    squadError('Type a channel like @DogeSquad.');
  });
  squadList.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.pick-row');
    if (!row) return;
    impact('light');
    if (row.dataset.squad) commitBind(row.dataset.squad, true);
    else if (row.dataset.handle) commitBind(row.dataset.handle, false);
  });
  $('squad-switch').addEventListener('click', () => { impact('light'); showSquadSearch(); squadQ.focus({ preventScroll: true }); });
  $('squad-leave').addEventListener('click', () => {
    leaveSquad();
    impact('medium');
    paintSquadPill();
    showSquadSearch();
  });
  onSquadChange(() => { paintSquadPill(); if (squadSheet && !squadSheet.hidden) showSquadBoundRefresh(); });
  function showSquadBoundRefresh() {
    if (!squadBoundView.hidden) showSquadBound();
    else paintSquadList(squadQ.value);
  }

  /* ---- the entry points: the Home country chip jumps to Profile, where the picker lives ---- */
  $('country-chip').addEventListener('click', () => { impact('light'); api.router.go('profile'); });
  $('pf-country').addEventListener('click', openCountry);
  $('pf-age').addEventListener('click', openAge);
  ($('age-minus') as HTMLButtonElement).addEventListener('click', () => {
    if (ageDraft <= AGE_MIN) return;
    ageDraft--;
    paintAgeDraft();
    impact('light');
  });
  ($('age-plus') as HTMLButtonElement).addEventListener('click', () => {
    if (ageDraft >= AGE_MAX) return;
    ageDraft++;
    paintAgeDraft();
    impact('light');
  });
  $('age-save').addEventListener('click', saveAge);
  $('age-clear').addEventListener('click', clearAge);
  $('team-chip').addEventListener('click', openSquad);
  $('pf-team').addEventListener('click', openTeam);

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
    /* country reward state: +100 while unclaimed, verified once set+claimed */
    const cReward = $('pf-country-reward');
    const cDone = $('pf-country-done');
    if (cReward) cReward.hidden = profile.rewards.country;
    if (cDone) cDone.hidden = !(c && profile.rewards.country);
    $('pf-country').classList.toggle('claimed', !!c);

    const age = profile.age;
    $('pf-age-v').textContent = age !== null ? `${age} yrs` : 'Not set';
    const aReward = $('pf-age-reward');
    const aDone = $('pf-age-done');
    if (aReward) aReward.hidden = profile.rewards.age;
    if (aDone) aDone.hidden = !(age !== null && profile.rewards.age);
    $('pf-age').classList.toggle('claimed', age !== null);

    paintSquadPill();
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

  /* ---- settings overhaul: language drawer, community rows, reset flow ---- */
  const CHANNEL_URL = 'https://t.me/detour_game';

  const paintI18n = () => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
      const key = el.dataset.i18n;
      if (!key) continue;
      el.textContent = t(key);
    }
  };

  const paintLangPill = () => {
    const d = langDef(lang);
    const flag = $('lang-flag');
    const code = $('lang-code');
    const nm = $('lang-name');
    if (flag) flag.textContent = d.flag;
    if (code) code.textContent = d.code.toUpperCase();
    if (nm) nm.textContent = d.native;
    const row = $('lang-row');
    if (row) row.setAttribute('aria-label', `${t('language')}: ${d.native}`);
  };

  const paintLangList = () => {
    const list = $('lang-list');
    if (!list) return;
    list.textContent = '';
    for (const l of LANGS) {
      const li = document.createElement('li');
      li.className = 'pick-row lang-row';
      li.setAttribute('role', 'option');
      li.tabIndex = 0;
      li.dataset.lang = l.code;
      li.setAttribute('aria-selected', String(l.code === lang));
      const flag = document.createElement('span');
      flag.className = 'flag';
      flag.textContent = l.flag;
      const fcode = document.createElement('span');
      fcode.className = 'flag-code';
      fcode.textContent = l.code.toUpperCase();
      const nm = document.createElement('span');
      nm.className = 'pick-n';
      nm.textContent = l.native;
      const sub = document.createElement('small');
      sub.textContent = l.label;
      nm.append(sub);
      const tick = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      tick.setAttribute('class', 'ico tick');
      tick.setAttribute('aria-hidden', 'true');
      tick.innerHTML = '<use href="#i-check" />';
      li.append(flag, fcode, nm, tick);
      list.append(li);
    }
  };

  const paintLang = () => {
    paintI18n();
    paintLangPill();
    paintLangList();
  };

  function openLang() {
    const sheet = api.sheet('sheet-lang');
    if (!sheet) return;
    paintLangList();
    api.sheets.open(sheet);
    impact('light');
  }

  function chooseLang(code: string) {
    if ((LANGS as { code: string }[]).every((l) => l.code !== code)) return;
    setLang(code as LangCode);
    notify('success');
    impact('medium');
    api.sheets.close();
  }

  let setToastTimer = 0;
  function showSetToast(msg: string) {
    const toast = $('set-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.hidden = false;
    toast.classList.remove('show');
    void toast.offsetWidth;
    toast.classList.add('show');
    window.clearTimeout(setToastTimer);
    setToastTimer = window.setTimeout(() => {
      toast.classList.remove('show');
      window.setTimeout(() => { toast.hidden = true; }, 240);
    }, 2300);
  }

  function openExternal(url: string) {
    try {
      const w = window as unknown as {
        Telegram?: { WebApp?: { openTelegramLink?: (u: string) => void; openLink?: (u: string) => void } };
      };
      const tg = w.Telegram?.WebApp;
      if (url.includes('t.me/') && tg?.openTelegramLink) { tg.openTelegramLink(url); return; }
      if (tg?.openLink) { tg.openLink(url); return; }
    } catch { /* fall through to window.open */ }
    try { window.open(url, '_blank', 'noopener'); } catch { /* webview blocked */ }
  }

  function doReset() {
    try {
      const doomed: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith('detour.')) doomed.push(k);
      }
      for (const k of doomed) window.localStorage.removeItem(k);
    } catch { /* storage refused — reload still gives defaults */ }
    notify('success');
    api.sheets.close();
    showSetToast(t('resetDone'));
    window.setTimeout(() => window.location.reload(), 650);
  }

  $('lang-row')?.addEventListener('click', openLang);
  $('lang-list')?.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.lang-row');
    if (!row?.dataset.lang) return;
    impact('light');
    chooseLang(row.dataset.lang);
  });
  $('lang-list')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.lang-row');
    if (!row?.dataset.lang) return;
    e.preventDefault();
    chooseLang(row.dataset.lang);
  });
  $('tg-channel')?.addEventListener('click', () => { impact('light'); openExternal(CHANNEL_URL); });
  $('support-row')?.addEventListener('click', () => {
    impact('light');
    notify('success');
    showSetToast(t('supportNote'));
  });
  $('reset-row')?.addEventListener('click', () => {
    const sheet = api.sheet('sheet-reset');
    if (!sheet) return;
    impact('light');
    api.sheets.open(sheet);
  });
  $('reset-yes')?.addEventListener('click', () => { impact('medium'); doReset(); });

  /* live repaint: internal watchers + the public DOM event for external listeners */
  onLang(paintLang);
  window.addEventListener('detour:lang', () => paintLang());
  paintLang();

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
  paintSquadPill();

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
      const raw = id === 'compete' ? 'arena' : id;
      const active = raw === 'home' || raw === 'modes' || raw === 'custom' || raw === 'game' ? 'home' : raw;
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
