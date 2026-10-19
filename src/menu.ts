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
  LANGS, lang, langDef, motionReduced, onLang, setLang, t,
  menuState, saveMenu, settings, setSetting, onSettings, type LangCode, type Settings,
} from './settings';
import {
  ageLocked, claimIdentityReward, claimReferralRewards, createTeam, daysInMonth, DOB_MIN_YEAR,
  dobMaxYear, dobValue, favouriteMode, IDENTITY_REWARD, joinTeam, KINDS, leaveTeam, levelInfo,
  myTeam, onChange, profile, REFERRAL_REWARD, setBadge, setDob, setFrame, theme, validDob,
} from './storage';
import { BADGES, badgeProgress, badgeTiq, equippedBadge, isBadgeUnlocked, unlockedCount } from './badges';
import { MAX_BALLS, newGame } from './rules';
import { createPreview, createRenderer, type Preview, type View } from './render';
import { setBalance } from './coin';
import { nameOf } from './countries';
import { openCountryPicker } from './countrypick';
import { flagPhoto } from './flags';
import { cleanCode, standings, YOU } from './teams';
import {
  bindSquad, bindSquadById, cleanHandle, getMySquad, leaveSquad,
  onSquadChange, searchSquads, squadLetter,
} from './squads';
import { copyText } from './gamemodes';
import { claimWelcomeBonus, pullReferral, referralLink, referralShareUrl } from './referral';
import { playReward } from './sound';
import { BOT_RAMP, type CosKind } from './themes';
import { isTicketCategory, submitTicket } from './support';
import type { Router } from './router';
import type { Sheets } from './sheets';
import { impact, notify, startParam, tgUser } from './telegram';

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

/** A race to start: how sharp the opponent is and how many balls each side fields. */
export interface RaceSetup { difficulty: Difficulty; sizes: [number, number] }

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

  /* ---------- profile completion toast: animated +100 confirmation ---------- */
  let pfToastTimer = 0;
  function showPfToast(msg: string, plain = false) {
    const toast = document.getElementById('pf-toast');
    const label = document.getElementById('pf-toast-t');
    if (!toast || !label) return;
    toast.classList.toggle('plain', plain); // a plain toast carries a message, not a coin
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

  /* ---------- birthdate: three numeric wells, auto-advancing, locked for good on confirm ---------- */
  const ageSheet = api.sheet('sheet-age');
  const dayIn = $<HTMLInputElement>('dob-day');
  const monthIn = $<HTMLInputElement>('dob-month');
  const yearIn = $<HTMLInputElement>('dob-year');
  const dobFields = [dayIn, monthIn, yearIn];
  const ageSave = $<HTMLButtonElement>('age-save');
  const ageConfirm = $<HTMLElement>('dob-confirm');
  const dobLead = $<HTMLElement>('dob-lead');
  const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const dobErr = $<HTMLElement>('dob-err');
  const dobErrT = $<HTMLElement>('dob-err-t');
  /** Wells that hold a committed verdict: a full-length value, or one the fingers have left. */
  const dobChecked = new Set<HTMLInputElement>();
  let dobBad = new Set<HTMLInputElement>();
  let dobErrMsg = '';
  let dobErrTimer = 0;
  let dobLit = false;

  /** The draft only stands when the save layer would accept it: calendar day, year window, age window. */
  function dobDraft(): { y: number; m: number; d: number } | null {
    if (!dayIn.value || !monthIn.value || !yearIn.value) return null;
    const d = Number(dayIn.value); const m = Number(monthIn.value); const y = Number(yearIn.value);
    if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(y)) return null;
    return validDob(y, m, d) ? { y, m, d } : null;
  }

  /** One well's verdict on the digits it currently holds, or null when they read fine. */
  function fieldIssue(el: HTMLInputElement): string | null {
    const v = el.value;
    if (!v) return null;
    const n = Number(v);
    if (el === yearIn) {
      return n < DOB_MIN_YEAR || n > dobMaxYear()
        ? `Year must be between ${DOB_MIN_YEAR} and ${dobMaxYear()}` : null;
    }
    if (el === monthIn) return n < 1 || n > 12 ? 'Month must be between 01 and 12' : null;
    if (n < 1 || n > 31) return 'Day must be between 1 and 31';
    const m = Number(monthIn.value);
    if (m >= 1 && m <= 12) {
      const max = daysInMonth(Number(yearIn.value) || 2000, m);
      if (n > max) return `${MONTH_NAMES[m - 1]} has up to ${max} days`;
    }
    return null;
  }

  /** The chip: one line of what is wrong, faded in on the first bad verdict and out on the fix. */
  function paintDobErr(msg: string) {
    if (msg === dobErrMsg) return;
    dobErrMsg = msg;
    window.clearTimeout(dobErrTimer);
    if (msg) {
      dobErrT.textContent = msg;
      dobErr.hidden = false;
      dobErr.classList.remove('out');
      void dobErr.offsetWidth;
      dobErr.classList.add('on');
    } else {
      dobErr.classList.remove('on');
      dobErr.classList.add('out');
      dobErrTimer = window.setTimeout(() => { dobErr.hidden = true; dobErr.classList.remove('out'); }, 200);
    }
  }

  function paintDob() {
    const issues = new Map<HTMLInputElement, string>();
    for (const el of dobFields) {
      const msg = dobChecked.has(el) ? fieldIssue(el) : null;
      if (msg) issues.set(el, msg);
    }
    for (const el of dobFields) {
      const bad = issues.has(el);
      el.classList.toggle('is-invalid', bad);
      el.setAttribute('aria-invalid', bad ? 'true' : 'false');
    }
    /* one error buzz per fresh verdict, never on a repaint of the same one */
    if ([...issues.keys()].some((el) => !dobBad.has(el))) notify('error');
    dobBad = new Set(issues.keys());
    paintDobErr(issues.get(dayIn) ?? issues.get(monthIn) ?? issues.get(yearIn) ?? '');
    const valid = dobDraft() !== null;
    ageSave.disabled = !valid;
    ageSave.textContent = 'Confirm Birthdate';
    dobLead.innerHTML = profile.rewards.age
      ? 'Set your date of birth to complete your profile. This is a permanent, one-time entry.'
      : `Set it once to complete your profile and claim <b>+${IDENTITY_REWARD} coins</b>.`;
    if (valid && !dobLit) {
      ageSave.classList.remove('lit');
      void ageSave.offsetWidth;         // replay the warm-up from the first frame
      ageSave.classList.add('lit');
    } else if (!valid) {
      ageSave.classList.remove('lit');
    }
    dobLit = valid;
  }

  /** Digits only, and only digits that fit: anything else never reaches the well. */
  function onDobKeydown(e: KeyboardEvent) {
    const el = e.currentTarget as HTMLInputElement;
    if (e.ctrlKey || e.metaKey || e.altKey || e.key === 'Tab' || e.key === 'Enter') return;
    if (e.key === 'Backspace') {
      if (el.value === '') {
        const i = dobFields.indexOf(el);
        if (i > 0) { e.preventDefault(); dobFields[i - 1].focus({ preventScroll: true }); }
      }
      return;
    }
    if (e.key.length === 1 && !/[0-9]/.test(e.key)) e.preventDefault();
  }

  /** A finished value earns its verdict: a good one walks the focus onward, a bad one stays put and shakes. */
  function onDobInput(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const cap = el.maxLength > 0 ? el.maxLength : 4;
    const clean = el.value.replace(/\D+/g, '').slice(0, cap);
    if (clean !== el.value) el.value = clean;
    if (clean.length >= cap) {
      dobChecked.add(el);
      if (!fieldIssue(el)) {
        const i = dobFields.indexOf(el);
        if (i < dobFields.length - 1) dobFields[i + 1].focus({ preventScroll: true });
      }
    } else {
      dobChecked.delete(el);            // mid-edit: withdraw the old verdict, keep the digits
    }
    paintDob();
  }

  /** Leaving a well pads a lone digit and locks in its verdict — nothing is ever wiped. */
  function onDobBlur(e: FocusEvent) {
    const el = e.currentTarget as HTMLInputElement;
    if ((el === dayIn || el === monthIn) && el.value.length === 1) el.value = pad2(Number(el.value));
    dobChecked.add(el);
    paintDob();
  }

  function openAge() {
    if (!ageSheet) return;
    if (ageLocked()) {
      /* the locked row no longer reacts; this guard is the belt to its braces */
      notify('warning');
      showPfToast('🔒 Birthdate is locked');
      return;
    }
    const dob = dobValue();
    const legacy = profile.age !== null ? new Date().getFullYear() - profile.age : null;
    const guess = dob?.y ?? legacy;
    /* a fresh entry: no verdicts carried over, the chip closed without animating */
    dobChecked.clear();
    dobBad = new Set();
    dobErrMsg = '';
    window.clearTimeout(dobErrTimer);
    dobErr.hidden = true;
    dobErr.classList.remove('on', 'out');
    yearIn.value = guess !== null && guess >= DOB_MIN_YEAR && guess <= dobMaxYear() ? String(guess) : '';
    monthIn.value = dob ? pad2(dob.m) : '';
    dayIn.value = dob ? pad2(dob.d) : '';
    ageConfirm.hidden = true;
    ageSave.hidden = false;
    paintDob();
    api.sheets.open(ageSheet);
    impact('light');
  }

  /** The confirm pulse: one more deliberate tap between the picker and the permanent lock. */
  function askAgeConfirm() {
    if (ageSave.disabled) return;
    impact('light');
    ageSave.hidden = true;
    ageConfirm.hidden = false;
    $('dob-lock').focus({ preventScroll: true });
  }

  function cancelAgeConfirm() {
    impact('light');
    ageConfirm.hidden = true;
    ageSave.hidden = false;
    ageSave.focus({ preventScroll: true });
  }

  function lockAge() {
    const draft = dobDraft();
    if (!draft) return;
    if (!setDob(draft.y, draft.m, draft.d)) return;   // already locked, or out of window: nothing to do
    const paid = claimIdentityReward('age');
    notify('success');
    impact('medium');
    if (paid > 0) playReward();
    api.sheets.close();
    showPfToast(paid > 0 ? `+${paid} Coins · Birthdate locked` : '🔒 Birthdate locked');
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
  let paintBadgesRef: (() => void) | null = null;
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

  function paintSquadPill(): void {
    const me = getMySquad();
    const chip = $<HTMLElement>('team-chip');
    const label = $<HTMLElement>('team-name');
    const rank = $<HTMLElement>('team-count');
    const avatar = $<HTMLElement>('squad-avatar');
    const ico = document.getElementById('squad-ico');
    if (me) {
      chip.classList.add('bound');
      avatar.hidden = false;
      avatar.textContent = squadLetter(me);
      if (ico) ico.hidden = true;
      label.textContent = me.handle;
      rank.hidden = false;
      // The rank alone: CSS draws the dot separator so only "#1" picks up the amber.
      rank.textContent = `#${me.rank}`;
      chip.setAttribute('aria-label', `${me.handle}, squad rank ${me.rank}. Open squad.`);
      chip.title = `${me.handle} · #${me.rank}`;
    } else {
      chip.classList.remove('bound');
      avatar.hidden = true;
      if (ico) ico.hidden = false;
      label.textContent = 'Join Squad';
      rank.hidden = true;
      rank.textContent = '';
      chip.setAttribute('aria-label', 'Join Squad');
      chip.title = 'Join Squad';
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
  onSquadChange(() => { paintSquadPill(); if (squadSheet && !squadSheet.hidden) showSquadBoundRefresh(); paintBadgesSafe(); });
  function showSquadBoundRefresh() {
    if (!squadBoundView.hidden) showSquadBound();
    else paintSquadList(squadQ.value);
  }
  /* badge rack also answers to squad binds (Squad Warrior unlocks there). */
  function paintBadgesSafe() {
    try {
      const rack = document.getElementById('pf-badge-rack');
      if (!rack) return;
      /* paintBadges is defined below — call it late so squad events never race init. */
      (paintBadgesRef as (() => void) | null)?.();
    } catch { /* rack paints on next profile repaint */ }
  }

  /* ---- the entry points: country now lives only in Profile (header pill removed) ---- */
  document.getElementById('country-chip')?.addEventListener('click', () => { impact('light'); api.router.go('profile'); });
  $('pf-country').addEventListener('click', () => {
    openCountryPicker(api.sheets, (_code, paid) => {
      if (paid > 0) showPfToast(`+${paid} Coins · Country set`);
    });
  });
  $('pf-age').addEventListener('click', openAge);
  for (const el of dobFields) {
    el.addEventListener('keydown', onDobKeydown);
    el.addEventListener('input', onDobInput);
    el.addEventListener('blur', onDobBlur);
    el.addEventListener('focus', () => { try { el.select(); } catch { /* a tap still lands the caret */ } });
  }
  ageSave.addEventListener('click', askAgeConfirm);
  $('dob-cancel').addEventListener('click', cancelAgeConfirm);
  $('dob-lock').addEventListener('click', lockAge);
  $('team-chip').addEventListener('click', openSquad);
  $('pf-team').addEventListener('click', openTeam);
  document.getElementById('profile-settings')?.addEventListener('click', () => {
    impact('light');
    api.router.go('settings');
  });

  /* ---- referral hub: the Invite & Earn card, the link sheet, the claim ----
     The save owns the counters (`profile.referral`); this block owns the sheet's face and the
     taps — open, copy, share, claim. The reward chime and the medium haptic fire on a claim that
     actually paid. The campaign figures come from the storage constants, never hardcoded twice. */
  const refSheet = api.sheet('sheet-referral');
  const refLinkEl = document.getElementById('ref-link') as HTMLInputElement | null;
  let refCopyTimer = 0;

  function paintReferral() {
    const r = profile.referral;
    const sub = document.getElementById('pf-invite-s');
    if (sub) sub.textContent = `Earn +${en(REFERRAL_REWARD)} Coins per invite`;
    const banner = document.getElementById('ref-banner');
    if (banner) banner.innerHTML = `Get <b>${en(REFERRAL_REWARD)} Coins</b> for you &amp; your friend upon joining!`;
    const pill = document.getElementById('pf-invite-pill');
    if (pill) pill.textContent = r.joins > 0 ? `${en(r.joins)} Invited` : 'Invite';
    const card = document.getElementById('pf-invite');
    if (card) {
      card.setAttribute('aria-label', r.joins > 0
        ? `Invite friends and earn coins. ${en(r.joins)} friend${r.joins === 1 ? '' : 's'} joined so far`
        : `Invite friends and earn ${en(REFERRAL_REWARD)} coins per invite`);
    }
    const joins = document.getElementById('ref-joins');
    if (joins) joins.textContent = en(r.joins);
    const unclaimed = document.getElementById('ref-unclaimed');
    if (unclaimed) unclaimed.textContent = en(r.unclaimed);
    const claim = document.getElementById('ref-claim') as HTMLButtonElement | null;
    if (claim) {
      claim.disabled = r.unclaimed <= 0;
      claim.setAttribute('aria-label', r.unclaimed > 0
        ? `Claim ${en(r.unclaimed)} referral coins`
        : 'No referral rewards to claim yet');
    }
    if (refLinkEl) refLinkEl.value = referralLink();
    /* the invitee's welcome: the toast lives on this screen, so hold it until the screen shows
       (createMenu paints the profile once at boot even while Home is the visible route) */
    if (pendingWelcome > 0 && !pfScreen.hidden) {
      showPfToast(`+${en(pendingWelcome)} Coins · Welcome bonus`);
      pendingWelcome = 0;
    }
  }

  function openReferral() {
    if (!refSheet) return;
    paintReferral();
    api.sheets.open(refSheet);
    impact('light');
    /* the Worker's ledger when the app was pointed at one; resolve to the local save otherwise */
    void pullReferral().then((moved) => { if (moved) paintReferral(); });
  }

  document.getElementById('pf-invite')?.addEventListener('click', openReferral);
  refLinkEl?.addEventListener('focus', () => refLinkEl.select());
  refLinkEl?.addEventListener('click', () => refLinkEl.select());

  document.getElementById('ref-copy')?.addEventListener('click', () => {
    const btn = document.getElementById('ref-copy');
    impact('light');
    void copyText(referralLink()).then((ok) => {
      notify(ok ? 'success' : 'warning');
      if (!btn || !ok) return;
      const label = btn.querySelector<HTMLElement>('.ref-copy-t');
      if (label) label.textContent = 'Copied! ✔';
      btn.classList.add('copied');
      window.clearTimeout(refCopyTimer);
      refCopyTimer = window.setTimeout(() => {
        if (label) label.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 1400);
    });
  });

  document.getElementById('ref-share')?.addEventListener('click', () => {
    impact('medium');
    const share = referralShareUrl();
    try {
      const w = window as unknown as { Telegram?: { WebApp?: { openTelegramLink?: (u: string) => void } } };
      if (w.Telegram?.WebApp?.openTelegramLink) { w.Telegram.WebApp.openTelegramLink(share); return; }
    } catch { /* fall through to window.open */ }
    try { window.open(share, '_blank', 'noopener'); } catch { /* webview blocked — the link is still copyable */ }
  });

  document.getElementById('ref-claim')?.addEventListener('click', () => {
    const paid = claimReferralRewards();
    if (paid <= 0) { impact('light'); return; }
    playReward();                              /* the chime lands on the tap's own frame */
    impact('medium');
    notify('success');
    showPfToast(`+${en(paid)} Coins · Referral rewards`);
    paintReferral();
  });

  /* the invitee's side: a launch that carried `?start=ref_...` banks its welcome bonus once */
  let pendingWelcome = claimWelcomeBonus();

  /* ---- the record, and what is worn: re-painted whenever the save changes ---- */
  const pfScreen = $<HTMLElement>('s-profile');
  const eqPv = new Map<CosKind, Preview>();

  /* Avatar frames for the hero slot: persisted as profile.frame (default | auric | neon). */
  const FRAMES: { id: string; name: string }[] = [
    { id: 'default', name: 'Default' },
    { id: 'auric', name: 'Auric' },
    { id: 'neon', name: 'Neon' },
  ];
  const frameName = (id: string | null): string =>
    FRAMES.find((f) => f.id === id)?.name ?? 'Default';

  /* Rank tiers: cosmetic tags driven by level, so the hero reads like a gamer card. */
  const RANKS: { min: number; id: string; name: string }[] = [
    { min: 1, id: 'rookie', name: 'Rookie' },
    { min: 3, id: 'bronze', name: 'Bronze' },
    { min: 6, id: 'silver', name: 'Silver' },
    { min: 10, id: 'gold', name: 'Gold' },
    { min: 16, id: 'elite', name: 'Elite' },
    { min: 24, id: 'legend', name: 'Legend' },
  ];
  const rankFor = (n: number) => [...RANKS].reverse().find((r) => n >= r.min) ?? RANKS[0];

  const paintHeroExtras = (lv: { n: number; got: number; need: number }) => {
    /* recessed profile XP bar mirrors Home's bar (same levelInfo source). */
    const pfBar = document.getElementById('pf-bar');
    const pfFill = document.getElementById('pf-fill');
    if (pfBar && pfFill) {
      pfFill.style.setProperty('--p', `${Math.round((lv.got / lv.need) * 100)}%`);
      pfBar.setAttribute('aria-valuenow', String(lv.got));
      pfBar.setAttribute('aria-valuemax', String(lv.need));
      pfBar.setAttribute('aria-valuetext', `Level ${lv.n}, ${lv.got} of ${lv.need} XP`);
    }
    const rankBadge = document.getElementById('pf-rank-badge');
    const rankName = rankFor(lv.n);
    if (rankBadge) {
      rankBadge.dataset.rank = rankName.id;
      rankBadge.setAttribute('aria-label', `Level ${lv.n}, ${rankName.name} rank`);
    }
    /* the rank name lives inside the merged badge */
    const rankTag = document.getElementById('pf-rank-tag');
    if (rankTag) rankTag.textContent = rankName.name;
    /* the avatar is the frame control: its name reads out instead of a caption pill */
    const wrap = document.getElementById('pf-avatar-wrap');
    if (wrap) {
      const frame = profile.frame ?? 'default';
      const label = `${frameName(frame)} avatar frame. Tap to change.`;
      wrap.setAttribute('data-frame', frame);
      wrap.setAttribute('aria-label', label);
      wrap.setAttribute('title', label);
    }
    /* primary equipped badge next to the name */
    const eq = equippedBadge();
    const eqWrap = document.getElementById('pf-equipped-badge');
    if (eqWrap) {
      if (!eq) {
        eqWrap.hidden = true;
      } else {
        eqWrap.hidden = false;
        eqWrap.setAttribute('data-accent', eq.accent);
        const use = document.getElementById('pf-equipped-use') as unknown as SVGUseElement | null;
        if (use) use.setAttribute('href', `#i-crest-${eq.accent}`);
        const label = document.getElementById('pf-equipped-t');
        if (label) label.textContent = eq.name;
        eqWrap.setAttribute('aria-label', `Equipped badge: ${eq.name}`);
        eqWrap.setAttribute('title', eq.name);
      }
    }
    /* the avatar's own crest tag mirrors the equipped badge, so the HUD reads
       at a glance even when the name pill has to elide beside a long name */
    const avTag = document.getElementById('pf-avatar-tag');
    const avUse = document.getElementById('pf-avatar-tag-use') as unknown as SVGUseElement | null;
    if (avTag && avUse) {
      avUse.setAttribute('href', eq ? `#i-crest-${eq.accent}` : '#i-crown');
      avTag.setAttribute('data-accent', eq?.accent ?? 'none');
    }
  };

  /* Honor & Badges: a slim horizontal tray of sculpted crest chips — lit metal
     when unlocked, frosted slate + a lock pin when locked. No prose in the tray:
     the full card, its TIQ milestone and the equip action live in the View All
     sheet, and the detail drawer still carries the lore. */
  const makeChip = (unlocked: boolean, b: { accent: string }): HTMLSpanElement => {
    const chip = document.createElement('span');
    chip.className = 'badge-chip';
    chip.setAttribute('aria-hidden', 'true');
    chip.setAttribute('data-accent', b.accent);
    chip.setAttribute('data-state', unlocked ? 'unlocked' : 'locked');
    chip.innerHTML = `<svg class="badge-crest" viewBox="0 0 56 56" aria-hidden="true">`
      + `<use href="#i-crest-${b.accent}" /></svg>`
      + (unlocked ? '' : `<span class="badge-lock"><svg class="ico ico-lock" aria-hidden="true">`
        + `<use href="#i-lock" /></svg></span>`);
    return chip;
  };

  const paintBadges = () => {
    const rack = document.getElementById('pf-badge-rack');
    const count = document.getElementById('pf-badge-count');
    if (count) count.textContent = `(${unlockedCount()}/${BADGES.length})`;
    if (!rack) return;
    rack.textContent = '';
    for (const b of BADGES) {
      const unlocked = isBadgeUnlocked(b.id);
      const prog = badgeProgress(b.id);
      const equipped = unlocked && profile.badge === b.id;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `badge-slot ${unlocked ? 'is-unlocked' : 'is-locked'}${equipped ? ' is-equipped' : ''}`;
      btn.setAttribute('role', 'listitem');
      btn.dataset.badge = b.id;
      const chip = makeChip(unlocked, b);
      btn.setAttribute(
        'aria-label',
        `${b.name} — ${unlocked ? (equipped ? 'equipped' : 'unlocked') : `locked, ${prog.label}`}. Open details.`,
      );
      const chipTiq = badgeTiq(b.id);
      btn.title = unlocked
        ? b.name
        : `${b.name} · ${chipTiq.met ? prog.label : `${en(chipTiq.tiq)} TIQ required`}`;
      btn.append(chip);
      btn.addEventListener('click', () => openBadge(b.id));
      rack.append(btn);
    }
    paintBadgeList();
  };
  paintBadgesRef = paintBadges;

  /* "View All ›" drawer: the full catalogue as sculpted honor cards. Each card
     carries its crest, its TIQ milestone, and either an EQUIPPED seal or a live
     meter to the number that still stands between the player and the badge.
     Tapping an unlocked card equips it on the spot; a locked card opens the lore
     drawer with the exact requirement and its TIQ progress. */
  function paintBadgeList() {
    const list = document.getElementById('badge-list');
    if (!list) return;
    list.textContent = '';
    for (const b of BADGES) {
      const unlocked = isBadgeUnlocked(b.id);
      const equipped = unlocked && profile.badge === b.id;
      const tp = badgeTiq(b.id);
      const ach = badgeProgress(b.id);
      const achMet = ach.got >= ach.need;
      const li = document.createElement('li');
      li.className = `badge-card ${unlocked ? 'is-unlocked' : 'is-locked'}${equipped ? ' is-equipped' : ''}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(equipped));
      li.setAttribute('aria-label', `${b.name}. ${
        equipped ? 'Equipped.'
          : unlocked ? 'Unlocked. Tap to equip.'
            : tp.met ? `Locked. ${en(tp.tiq)} TIQ met; ${ach.label}.`
              : `Locked. ${en(tp.tiq)} TIQ required, you have ${en(tp.got)}.`
      }`);
      li.tabIndex = 0;
      li.dataset.badge = b.id;

      const crest = document.createElement('span');
      crest.className = 'badge-card-crest';
      crest.setAttribute('aria-hidden', 'true');
      crest.innerHTML = `<svg class="badge-crest" viewBox="0 0 56 56" aria-hidden="true">`
        + `<use href="#i-crest-${b.accent}" /></svg>`
        + (unlocked ? '' : '<span class="badge-card-lock"><svg class="ico" aria-hidden="true">'
          + '<use href="#i-lock" /></svg></span>');

      const main = document.createElement('span');
      main.className = 'badge-card-main';

      const top = document.createElement('span');
      top.className = 'badge-card-top';
      const nm = document.createElement('span');
      nm.className = 'badge-card-n';
      nm.textContent = b.name;
      top.append(nm);
      if (equipped) {
        const tag = document.createElement('span');
        tag.className = 'badge-card-tag is-equipped';
        tag.textContent = '✓ EQUIPPED';
        top.append(tag);
      } else if (unlocked) {
        const tag = document.createElement('span');
        tag.className = 'badge-card-tag is-arm';
        tag.textContent = 'Tap to Equip';
        top.append(tag);
      }

      const chip = document.createElement('span');
      chip.className = 'badge-card-tiq';
      chip.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-brain" /></svg>'
        + (unlocked
          ? `<b>${en(tp.tiq)} TIQ</b><span>${tp.tiq > 0 ? 'Unlocked' : 'Founding'}</span>`
          : `<b>${en(tp.tiq)} TIQ</b><span>${tp.met ? 'Met' : 'Required'}</span>`);

      main.append(top, chip);

      if (!unlocked) {
        const meter = document.createElement('span');
        meter.className = 'badge-card-meter';
        const bar = document.createElement('i');
        bar.className = 'badge-card-bar';
        const fill = document.createElement('b');
        const meterPct = tp.met && !achMet
          ? Math.round((ach.got / Math.max(1, ach.need)) * 100)
          : Math.round(tp.pct * 100);
        fill.style.width = `${meterPct}%`;
        bar.append(fill);
        const fig = document.createElement('em');
        fig.className = 'badge-card-meter-t';
        fig.textContent = tp.met && !achMet ? ach.label : `${en(tp.got)} / ${en(tp.tiq)} TIQ`;
        meter.append(bar, fig);
        main.append(meter);
      }
      li.append(crest, main);

      const activate = () => {
        if (!isBadgeUnlocked(b.id)) { impact('light'); openBadge(b.id); return; }
        if (profile.badge === b.id) return;
        setBadge(b.id);
        impact('medium');
        notify('success');
        showPfToast(`${b.name} equipped`, true);
      };
      li.addEventListener('click', activate);
      li.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        activate();
      });
      list.append(li);
    }
  }

  let badgeDraft: string | null = null;
  function openBadge(id: string) {
    const def = BADGES.find((b) => b.id === id);
    const sheet = api.sheet('sheet-badge');
    if (!def || !sheet) return;
    badgeDraft = id;
    const unlocked = isBadgeUnlocked(id);
    const prog = badgeProgress(id);
    const hero = document.getElementById('badge-sheet-hero');
    if (hero) {
      hero.setAttribute('data-accent', def.accent);
      hero.classList.toggle('is-locked', !unlocked);
    }
    const tp = badgeTiq(id);
    const use = document.getElementById('badge-sheet-use') as unknown as SVGUseElement | null;
    if (use) use.setAttribute('href', `#i-crest-${def.accent}`);
    const title = document.getElementById('badge-title');
    if (title) title.textContent = def.name;
    const lore = document.getElementById('badge-lore');
    if (lore) lore.textContent = def.lore;
    const crit = document.getElementById('badge-criteria');
    if (crit) crit.textContent = def.criteria;
    const state = document.getElementById('badge-state');
    if (state) state.textContent = unlocked
      ? `Unlocked · ${en(tp.tiq)} TIQ`
      : tp.met ? `Locked · ${prog.label}` : `Locked · ${en(tp.got)} / ${en(tp.tiq)} TIQ`;
    const fill = document.getElementById('badge-progress-fill');
    const bar = document.getElementById('badge-progress-bar');
    const label = document.getElementById('badge-progress-t');
    const tiqLocked = !unlocked && !tp.met;
    const pct = tiqLocked
      ? Math.round(tp.pct * 100)
      : prog.need > 0 ? Math.min(100, Math.round((prog.got / prog.need) * 100)) : 100;
    if (fill) fill.style.width = `${unlocked ? 100 : pct}%`;
    if (bar) {
      bar.setAttribute('aria-valuenow', String(tiqLocked ? tp.got : prog.got));
      bar.setAttribute('aria-valuemax', String(tiqLocked ? tp.tiq : prog.need));
    }
    if (label) label.textContent = unlocked
      ? 'Complete — ready to equip'
      : tiqLocked ? `${en(tp.got)} / ${en(tp.tiq)} TIQ` : prog.label;
    const equip = document.getElementById('badge-equip') as HTMLButtonElement | null;
    if (equip) {
      if (!unlocked) {
        equip.disabled = true;
        equip.textContent = tiqLocked ? `${en(tp.tiq)} TIQ required` : prog.label;
      } else if (profile.badge === id) {
        equip.disabled = true;
        equip.textContent = 'Equipped';
      } else {
        equip.disabled = false;
        equip.textContent = 'Equip to Profile';
      }
    }
    api.sheets.open(sheet);
    impact('light');
  }

  const paintIdentity = (): void => {
    const lv = levelInfo();
    const t = myTeam();
    setBalance($('p-coins'), profile.coins);
    setBalance($('pf-coins'), profile.coins);
    for (const id of ['p-level', 'pf-level']) $(id).textContent = String(lv.n);
    $('pf-xp').textContent = `${lv.got} / ${lv.need} XP`;
    /* Home XP ring (r=22 in a 48 viewBox, round caps, cyan→emerald gradient on a dark track):
       the arc replaces the level pill + XP bar. Circumference comes from the node itself, so a
       resize of the orb can never desync the dash math from the painted circle. */
    const pct: number = lv.need > 0 ? Math.min(1, Math.max(0, lv.got / lv.need)) : 0;
    const ring = document.getElementById('p-ring') as unknown as SVGCircleElement | null;
    if (ring) {
      const radius = ring.r?.baseVal?.value || 22;
      const RING_C = 2 * Math.PI * radius;
      ring.style.strokeDasharray = String(RING_C);
      ring.style.strokeDashoffset = String(RING_C * (1 - pct));
      ring.setAttribute('aria-hidden', 'true');
    }
    const avatarBtn = document.getElementById('avatar-btn') as HTMLButtonElement | null;
    if (avatarBtn) {
      avatarBtn.setAttribute(
        'aria-label',
        `Open profile, Level ${lv.n}, ${lv.got} of ${lv.need} XP`,
      );
    }
    paintHeroExtras(lv);
    paintBadges();
    paintReferral();

    const c = profile.country;
    // Header country pill was decluttered — Profile owns country now. Guard for legacy DOM.
    document.getElementById('country-chip')?.classList.toggle('unset', !c);
    const countryName = document.getElementById('country-name');
    if (countryName) countryName.textContent = c ? nameOf(c) : 'Add country';
    $('pf-country-v').textContent = c ? nameOf(c) : 'Add country';
    const pfFlag = document.getElementById('pf-flag');
    if (pfFlag) {
      pfFlag.textContent = '';
      if (c) pfFlag.append(flagPhoto(c, 'fp-profile'));
    }
    /* Home name flag: a real vector plate next to the name — never a regional-indicator
       pair, which Windows draws as two bare letters. The code stays in the DOM (hidden)
       only as the accessible/state hook. */
    const homeFlag = document.getElementById('home-flag');
    const homeGlyph = document.getElementById('home-flag-glyph');
    const homeCode = document.getElementById('home-flag-code');
    if (homeFlag && homeGlyph) {
      if (c) {
        homeFlag.hidden = false;
        homeGlyph.textContent = '';
        homeGlyph.append(flagPhoto(c, 'fp-home'));
      } else {
        homeFlag.hidden = true;
        homeGlyph.textContent = '';
      }
      if (homeCode) homeCode.textContent = c ?? '';
    }
    /* country reward state: +100 while unclaimed, verified once set+claimed */
    const cReward = $('pf-country-reward');
    const cDone = $('pf-country-done');
    if (cReward) cReward.hidden = profile.rewards.country;
    if (cDone) cDone.hidden = !(c && profile.rewards.country);
    $('pf-country').classList.toggle('claimed', !!c);

    /* the age row: once the birthdate is locked the row seals — badge on, chevron gone, tap dead */
    const age = profile.age;
    const locked = ageLocked();
    const dob = dobValue();
    $('pf-age-v').textContent = age !== null ? `${age} yrs` : 'Not set';
    $('pf-age-s').textContent = locked && dob
      ? `Born ${dob.d} ${MONTH_LABELS[dob.m - 1]} ${dob.y}`
      : locked ? 'Permanent entry' : 'Complete your profile';
    const aReward = $('pf-age-reward');
    const aDone = $('pf-age-done');
    if (aReward) aReward.hidden = profile.rewards.age;
    if (aDone) aDone.hidden = !locked;
    const aRow = $('pf-age');
    aRow.classList.toggle('claimed', age !== null);
    aRow.classList.toggle('edit', !locked);
    aRow.classList.toggle('locked', locked);
    if (locked) aRow.setAttribute('aria-disabled', 'true');
    else aRow.removeAttribute('aria-disabled');

    paintSquadPill();
    $('pf-team-v').textContent = t ? `${t.name} · ${t.members.length}` : 'Join a team';
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
    /* empty stats become an exciting quest card until the first race lands */
    const quest = document.getElementById('pf-quest');
    const empty = document.getElementById('pf-quest-empty');
    const stats = document.getElementById('pf-quest-stats');
    if (quest && empty && stats) {
      const isNew = s.games === 0;
      quest.dataset.empty = String(isNew);
      empty.hidden = !isNew;
      stats.hidden = isNew;
    }
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

  /* the equipped loadouts stay locked until the cosmetic inventory ships: the cards are
     pointer-events: none, so the slab itself takes the tap and answers with a warning
     nudge and a clay toast — nothing here can ever equip, focus or toggle a loadout. */
  document.getElementById('pf-eq-lock')?.addEventListener('click', () => {
    notify('warning');
    showPfToast('Cosmetic loadouts unlock soon!', true);
  });

  /* frame cycle: tapping the avatar steps Default → Auric → Neon; the name reads out via aria-label. */
  document.getElementById('pf-avatar-wrap')?.addEventListener('click', () => {
    const ids = FRAMES.map((f) => f.id);
    const cur = profile.frame ?? 'default';
    const next = ids[(ids.indexOf(cur) + 1) % ids.length];
    setFrame(next === 'default' ? null : next);
    impact('light');
    notify('success');
  });
  document.getElementById('badge-equip')?.addEventListener('click', () => {
    if (!badgeDraft || !isBadgeUnlocked(badgeDraft)) return;
    setBadge(badgeDraft);
    notify('success');
    impact('medium');
    api.sheets.close();
    showPfToast('Badge equipped');
  });
  /* "View All ›" opens the full honor catalogue; the tray stays the shortcut. */
  document.getElementById('pf-badges-all')?.addEventListener('click', () => {
    const sheet = api.sheet('sheet-badges');
    if (!sheet) return;
    paintBadgeList();
    api.sheets.open(sheet);
    impact('light');
  });

  /* first-match CTA: plays the saved bot race, the same one Home's Play button runs. */
  document.getElementById('pf-play')?.addEventListener('click', () => {
    impact('light');
    saveMenu({ mode: 'bot' });
    api.start({ difficulty: menuState.difficulty, sizes: [...menuState.sizes] });
  });

  /* ---- difficulty: menuState.difficulty is the single source; every control paints it, every start reads it ---- */
  const capDiff = (d: Difficulty): string => d.charAt(0).toUpperCase() + d.slice(1);
  const paintBotSub = (): void => {
    const el = document.getElementById('mode-bot-sub');
    if (el) el.textContent = `vs Bot · ${capDiff(menuState.difficulty)}`;
  };
  const paintDiff = (): void => {
    for (const b of segs) b.setAttribute('aria-pressed', String(b.dataset.diff === menuState.difficulty));
    paintBotSub();
  };
  for (const b of segs) {
    b.addEventListener('click', () => {
      const d = b.dataset.diff as Difficulty;
      if (!DIFFICULTIES.includes(d) || d === menuState.difficulty) return;
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
      human: 0, mineHints: [], mineGhost: null, capsule: null,
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
    api.start({ difficulty: menuState.difficulty, sizes: [...custom] });
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

  /* ---- settings overhaul: language drawer + community/admin rows ---- */
  const CHANNEL_URL = 'https://t.me/detour_game';

  const paintI18n = () => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
      const key = el.dataset.i18n;
      if (!key) continue;
      el.textContent = t(key);
    }
    for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-i18n-ph]')) {
      const key = el.dataset.i18nPh;
      if (!key) continue;
      el.setAttribute('placeholder', t(key));
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

  /* ---- Contact Admin: the in-app support drawer -----------------------------------------------
     The row opens a Dark-Clay bottom sheet — category pills, a recessed 300-char textarea and
     a gold clay send key — so the message is written and submitted inside the Mini App, never
     by hopping out to a private chat. Tap-outside and Escape close are the sheets' own; this
     block only owns open / verify / send / confirm / auto-dismiss and the busy-state resets. */
  const supportSheet = api.sheet('sheet-support');
  const supportMsg = supportSheet?.querySelector<HTMLTextAreaElement>('#support-msg') ?? null;
  const supportSend = supportSheet?.querySelector<HTMLButtonElement>('#support-send') ?? null;
  const supportOk = supportSheet?.querySelector<HTMLElement>('#support-ok') ?? null;
  const supportCount = supportSheet?.querySelector<HTMLElement>('#support-count') ?? null;
  const SUPPORT_MAX = 300;
  let supportBusy = false;
  let supportTimer = 0;

  const supportReset = () => {
    supportBusy = false;
    if (supportSend) {
      supportSend.disabled = false;
      supportSend.setAttribute('aria-busy', 'false');
      supportSend.classList.remove('sending');
      const lbl = supportSend.querySelector('.send-t');
      if (lbl) lbl.textContent = t('supportSend');
    }
    if (supportMsg) supportMsg.value = '';
    if (supportCount) supportCount.textContent = String(SUPPORT_MAX);
    if (supportOk) supportOk.hidden = true;
  };

  function openSupport() {
    if (!supportSheet) return;
    clearTimeout(supportTimer);
    supportReset();
    impact('light');
    api.sheets.open(supportSheet);
  }

  function sendSupport() {
    if (!supportSheet || !supportMsg || !supportSend || supportBusy) return;
    const text = supportMsg.value.trim();
    if (!text) { impact('light'); supportMsg.focus({ preventScroll: true }); return; }
    const cat = supportSheet.querySelector<HTMLElement>('.cat-pill[aria-pressed="true"]')?.dataset.cat;
    supportBusy = true;
    supportSend.classList.add('sending');
    supportSend.setAttribute('aria-busy', 'true');
    const lbl = supportSend.querySelector('.send-t');
    if (lbl) lbl.textContent = t('supportSending');
    impact('medium');                     /* light Telegram haptic on the send tap itself */
    clearTimeout(supportTimer);
    supportTimer = window.setTimeout(() => {
      /* the ticket lands in the shared queue the Admin Command Center's Inbox reads */
      const me = tgUser();
      submitTicket({
        category: isTicketCategory(cat) ? cat : 'feedback',
        message: text,
        userId: me?.id === undefined ? 'device' : String(me.id),
        username: me?.username || me?.first_name || '',
      });
      notify('success');                  /* the haptic + badge pair confirm the send */
      if (supportOk) supportOk.hidden = false;
      clearTimeout(supportTimer);
      supportTimer = window.setTimeout(() => {
        /* auto-dismiss only if the user has not already backed out mid-flight */
        if (supportSheet.classList.contains('open')) api.sheets.close();
        clearTimeout(supportTimer);
        supportTimer = window.setTimeout(supportReset, motionReduced() ? 0 : 320);
      }, motionReduced() ? 150 : 950);
    }, motionReduced() ? 80 : 700);
  }

  supportSheet?.querySelector('.support-cats')?.addEventListener('click', (e) => {
    const pill = (e.target as HTMLElement | null)?.closest<HTMLElement>('.cat-pill');
    if (!pill || supportBusy) return;
    impact('light');
    for (const p of supportSheet.querySelectorAll('.cat-pill')) p.setAttribute('aria-pressed', String(p === pill));
  });
  supportMsg?.addEventListener('input', () => {
    if (supportCount) supportCount.textContent = String(SUPPORT_MAX - supportMsg.value.length);
  });
  supportMsg?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendSupport(); }
  });
  supportSend?.addEventListener('click', sendSupport);
  $('admin-row')?.addEventListener('click', openSupport);

  /* live repaint: internal watchers + the public DOM event for external listeners */
  onLang(paintLang);
  window.addEventListener('detour:lang', () => paintLang());
  paintLang();

  /* ---- mode cards ---- */
  /** vs Bot races the last configuration saved; the Teams row and the presets pick their own sizes. */
  for (const el of document.querySelectorAll<HTMLElement>('[data-start]')) {
    el.addEventListener('click', () => {
      if (el.getAttribute('aria-disabled') === 'true') return;   // Online: the badge is the answer
      const kind = el.dataset.start;
      if (kind !== 'bot') return;     // vs Bot is the race that starts
      impact('light');
      saveMenu({ mode: 'bot' });
      api.start({ difficulty: menuState.difficulty, sizes: [...menuState.sizes] });
    });
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-preset]')) {
    el.addEventListener('click', () => {
      const [a, b] = (el.dataset.preset ?? '').split(',').map(Number);
      if (!a || !b) return;
      impact('light');
      saveMenu({ mode: 'bot', sizes: [a, b] });
      api.start({ difficulty: menuState.difficulty, sizes: [a, b] });
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
      /* Home commits the strength live to menuState, so repaint whenever these screens come forward */
      if (id === 'modes' || id === 'custom') {
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
