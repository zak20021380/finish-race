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
  ageLocked, claimIdentityReward, claimReferralRewards, cleanDisplayName, createTeam, daysInMonth,
  DISPLAY_NAME_MAX, DISPLAY_NAME_MIN, DOB_MIN_YEAR, dobMaxYear, dobValue, favouriteMode,
  IDENTITY_REWARD, joinTeam, KINDS, leaveTeam, levelInfo, myTeam, onChange, pieceColor, profile,
  REFERRAL_REWARD, setBadge, setDisplayName, setDob, setFrame, setPieceColor, theme, validDob,
} from './storage';
import {
  BADGES, badgeCrestHtml, badgeDelta, badgeEdition, badgeProgress, badgeStatus, editionHolders,
  editionSerialLabel, editionSpeech, editionSyncState, equippedBadge, hasEditionClaim, isBadgeUnlocked,
  onEditionChange, refreshBadgeEditions, unlockedCount, type BadgeDef, type BadgeEdition, type WornEdition,
} from './badges';
import { MAX_BALLS, newGame } from './rules';
import { createPreview, createRenderer, type Preview, type View } from './render';
import { setBalance } from './coin';
import { nameOf } from './countries';
import { openCountryPicker } from './countrypick';
import { flagPhoto } from './flags';
import { cleanCode, standings, YOU } from './teams';
import {
  bindSquad, bindSquadById, cleanChatReference, cleanHandle, displayNameOf, handleIssue,
  HANDLE_MAX, getMySquad, getSquadRanking, leaveSquad, onSquadChange, searchSquads, squadKind, squadLetter,
  squadMark, telegramAvatarUrl, type RankedSquad, type SquadKind,
} from './squads';
import {
  ARENA_CUP, arrangeRoster, arenaStandingOf, buildSquadRoster, squadTargetAvg,
  type SquadMember, type SquadRole, type SquadRoster,
} from './squadRoster';
import { showToast } from './toast';
import {
  registerSquadWithTelegram, squadErrorMessage, verifySquadChat,
  type SquadChatPreview, type SquadVerifyResult,
} from './squadRegister';
import { copyText } from './gamemodes';
import { myTiq, TIER_NAME, tierOf, type MindTier } from './matchmaking';
import { refreshReferral, referralCode, referralLink, referralShareUrl } from './referral';
import { playReward } from './sound';
import { perspectiveRamps, type CosKind, type PieceColor } from './themes';
import { isTicketCategory, submitTicket } from './support';
import type { Router } from './router';
import type { Sheets } from './sheets';
import { BOT_HANDLE, impact, notify, startParam, tgUser } from './telegram';
import { CHANNEL_URL } from '../shared/config';

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
  /** Telegram's own name is shown whole — the 3–16 window only governs an edited name. */
  const telegramName = (full || u?.username || 'Player').trim() || 'Player';
  /** No custom name yet means the Telegram identity is the name. */
  const playerName = (): string => profile.displayName || telegramName;
  const initialsOf = (raw: string): string => {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    const source = words.length > 1 ? words.map((w) => w[0]).join('') : raw.slice(0, 2);
    return source.replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 2) || 'PL';
  };
  const photoBroken = new Set<string>();
  const FACES = [
    ['avatar-img', 'avatar-t', 'p-name'],
    ['pf-avatar-img', 'pf-avatar-t', 'pf-name'],
  ] as const;
  /* one error listener per face, not one per paint: the resizer repaints this screen */
  for (const [img] of FACES) {
    const photo = $(img) as unknown as HTMLImageElement;
    photo.addEventListener('error', () => {
      photoBroken.add(img);
      photo.hidden = true;
    });
  }

  /* One paint for every face on the app: Home's small token and Profile's hero squircle.
     The photo sits over the initials, so a slow or blocked CDN still shows a player,
     never a blank disc or a broken-image glyph. */
  function paintFaces() {
    const name = playerName();
    const initials = initialsOf(name);
    for (const [img, t, nm] of FACES) {
      $(nm).textContent = name;
      $(t).textContent = initials;
      const photo = $(img) as unknown as HTMLImageElement;
      const url = u?.photo_url ?? '';
      if (!url || photoBroken.has(img)) {
        photo.hidden = true;
        photo.removeAttribute('src');
        continue;
      }
      if (photo.getAttribute('src') !== url) photo.src = url;
      photo.hidden = false;
    }
  }
  paintFaces();

  /* ---- inline rename: the pencil swaps the name row's key for one clay field ---- */
  const nameRow = document.getElementById('pf-name-row');
  const nameForm = document.getElementById('pf-name-form') as HTMLFormElement | null;
  const nameInput = document.getElementById('pf-name-input') as HTMLInputElement | null;
  const nameLen = document.getElementById('pf-name-len');
  const nameHint = document.getElementById('pf-name-hint');
  const nameEdit = document.getElementById('pf-name-edit') as HTMLButtonElement | null;

  function closeNameEditor(refocus = false) {
    if (!nameForm || !nameRow || nameForm.hidden) return;
    nameForm.hidden = true;
    nameRow.removeAttribute('data-editing');
    if (refocus) nameEdit?.focus({ preventScroll: true });
  }

  function paintNameLen() {
    if (!nameInput || !nameLen || !nameHint) return;
    const clean = cleanDisplayName(nameInput.value);
    nameLen.textContent = `${clean.length}/${DISPLAY_NAME_MAX}`;
    const bad = clean.length > 0 && clean.length < DISPLAY_NAME_MIN;
    nameInput.classList.toggle('is-invalid', bad);
    nameHint.textContent = bad
      ? `At least ${DISPLAY_NAME_MIN} characters`
      : `${DISPLAY_NAME_MIN}–${DISPLAY_NAME_MAX} characters`;
    nameHint.classList.toggle('is-warn', bad);
  }

  nameEdit?.addEventListener('click', () => {
    if (!nameForm || !nameInput || !nameRow) return;
    nameInput.value = playerName().slice(0, DISPLAY_NAME_MAX);
    nameForm.hidden = false;
    nameRow.setAttribute('data-editing', '1');
    paintNameLen();
    impact('light');
    requestAnimationFrame(() => {
      nameInput.focus({ preventScroll: true });
      nameInput.select();
    });
  });
  nameInput?.addEventListener('input', paintNameLen);
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeNameEditor(true); }
  });
  document.getElementById('pf-name-cancel')?.addEventListener('click', () => {
    impact('light');
    closeNameEditor(true);
  });
  nameForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!nameInput) return;
    const next = cleanDisplayName(nameInput.value);
    if (next.length < DISPLAY_NAME_MIN) {
      if (nameHint) {
        nameHint.textContent = `At least ${DISPLAY_NAME_MIN} characters`;
        nameHint.classList.add('is-warn');
      }
      nameInput.classList.add('is-invalid');
      nameInput.focus({ preventScroll: true });
      impact('light');
      return;
    }
    if (!setDisplayName(next)) return;
    paintFaces();
    closeNameEditor(true);
    impact('medium');
    notify('success');
    showPfToast('Name updated', true);
  });

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
    const r = createTeam(raw, playerName());
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
    const r = joinTeam(raw, playerName());
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
  const squadScroll = $<HTMLElement>('squad-hub-scroll');
  const squadRosterEl = $<HTMLOListElement>('squad-roster');
  const squadMemberQ = $<HTMLInputElement>('squad-member-q');
  const squadCountEl = $<HTMLElement>('squad-roster-count');
  const squadRosterEmpty = $<HTMLElement>('squad-roster-empty');
  const squadYouEl = $<HTMLElement>('squad-you');
  const squadCrest = $<HTMLElement>('squad-view-crest');
  const squadCrestFrame = $<HTMLElement>('squad-view-frame');
  const squadCrestPhoto = $<HTMLImageElement>('squad-view-photo');
  const squadCrestBadge = $<HTMLElement>('squad-view-badge');
  const squadLeaderEl = $<HTMLElement>('squad-view-leader');
  const squadLeaderNameEl = $<HTMLElement>('squad-view-leader-name');
  const squadExploreBtn = $<HTMLButtonElement>('squad-explore');
  const squadExploreT = $<HTMLElement>('squad-explore-t');
  const squadExploreIco = $<HTMLElement>('squad-explore-ico');
  const squadLeaveBtn = $<HTMLButtonElement>('squad-leave');

  /* The inspection step: a card opens this sheet; the full-width key is the only
     place a join is ever committed. */
  const squadPreviewSheet = api.sheet('sheet-squad-preview');
  const sqpBack = $<HTMLButtonElement>('sqp-back');
  const sqpCrest = $<HTMLElement>('sqp-crest');
  const sqpMark = $<HTMLElement>('sqp-mark');
  const sqpName = $<HTMLElement>('sqp-name');
  const sqpHandle = $<HTMLElement>('sqp-handle');
  const sqpKind = $<HTMLElement>('sqp-kind');
  const sqpRankTile = $<HTMLElement>('sqp-rank-tile');
  const sqpRankV = $<HTMLElement>('sqp-rank-v');
  const sqpRankNote = $<HTMLElement>('sqp-rank-note');
  const sqpTiq = $<HTMLElement>('sqp-tiq');
  const sqpMembers = $<HTMLElement>('sqp-members');
  const sqpJoin = $<HTMLButtonElement>('sqp-join');
  const sqpJoinT = $<HTMLElement>('sqp-join-t');
  const sqpFine = $<HTMLElement>('sqp-fine');

  let previewSquad: RankedSquad | null = null;
  let previewHandle = '';
  let previewJoined = false;
  let previewQuery = '';
  let previewScroll = 0;

  let squadView: SquadRoster | null = null;
  let squadRows: SquadMember[] = [];
  let squadQuery = '';
  let squadPitch = 62;
  let squadGap = 8;
  let squadLeaveTimer = 0;
  const squadRowEls = new Map<number, HTMLElement>();
  let squadRange = { start: -1, end: -1, rows: -1 };
  let squadFrame = 0;
  let squadForce = false;
  let squadPhotoSeq = 0;
  let squadSearchTimer = 0;

  function squadError(msg: string) {
    squadErr.textContent = msg;
    squadErr.hidden = false;
    notify('warning');
  }

  const squadSvg = (href: string): SVGSVGElement => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', href);
    svg.append(use);
    return svg;
  };

  function squadRolePill(role: SquadRole): HTMLElement | null {
    if (role === 'member') return null;        // members stay clean typography, by design
    const pill = document.createElement('span');
    pill.className = 'sq-role';
    pill.dataset.role = role;
    pill.append(squadSvg(role === 'leader' ? '#i-crown' : '#i-shield'));
    pill.append(document.createTextNode(role === 'leader' ? t('leader') : t('admin')));
    return pill;
  }

  function squadMedalPin(medal: WornEdition, cls: string): HTMLElement {
    const pin = document.createElement('span');
    pin.className = `medal-pin ${cls}`.trim();
    pin.dataset.accent = medal.def.accent;
    pin.setAttribute('aria-hidden', 'true');
    pin.title = medal.serial !== null
      ? `${medal.def.name} · ${editionSerialLabel(medal.serial)}`
      : medal.def.name;
    pin.innerHTML = badgeCrestHtml(medal.def, 'badge-crest medal-coin');
    return pin;
  }

  function squadAvatar(member: SquadMember, cls = ''): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = `sq-avwrap${cls ? ` ${cls}` : ''}`;
    const av = document.createElement('span');
    av.className = 'sq-av';
    av.style.setProperty('--sq-hue', String(member.hue));
    av.setAttribute('aria-hidden', 'true');
    av.textContent = member.initials;
    wrap.append(av, flagPhoto(member.country, 'sq-av-flag'));
    if (member.medal) wrap.append(squadMedalPin(member.medal, 'sq-medal'));
    return wrap;
  }

  function paintSquadYou(): void {
    const roster = squadView;
    if (!roster) return;
    const member = roster.members.find((m) => m.isYou);
    if (!member) return;
    squadYouEl.textContent = '';

    const rank = document.createElement('span');
    rank.className = `sq-you-rank${roster.yourRank >= 100000 ? ' is-wide' : ''}`;
    rank.textContent = `#${en(roster.yourRank)}`;

    const avatar = squadAvatar(member);

    const identity = document.createElement('span');
    identity.className = 'sq-you-id';
    const name = document.createElement('b');
    name.className = 'sq-you-name';
    name.textContent = t('you');
    identity.append(name);

    const score = document.createElement('span');
    score.className = `sq-score${roster.yourTiq <= 0 ? ' is-zero' : ''}`;
    score.append(squadSvg('#i-brain'));
    const amount = document.createElement('b');
    amount.textContent = en(roster.yourTiq);
    score.append(amount);

    squadYouEl.append(rank, avatar, identity, score);

    const honor = roster.yourMedal
      ? `, wearing ${roster.yourMedal.def.name}${roster.yourMedal.serial !== null ? ` edition ${roster.yourMedal.serial}` : ''}`
      : '';
    const arenaSpeech = roster.yourArena.rank > 0
      ? `arena rank ${roster.yourArena.rank} in the ${ARENA_CUP}`
      : 'unranked in the arena';
    squadYouEl.setAttribute(
      'aria-label',
      `Your standing: rank ${roster.yourRank} of ${roster.count}, ${roster.yourTiq} Tactical IQ, `
      + `${arenaSpeech}, representing ${nameOf(member.country)}${honor}.`,
    );
  }

  function measureSquadPitch(): number {
    const css = getComputedStyle(squadRosterEl);
    const row = parseFloat(css.getPropertyValue('--sq-row-h'));
    const gap = parseFloat(css.getPropertyValue('--sq-row-gap'));
    const pitch = parseFloat(css.getPropertyValue('--sq-row-pitch'));
    squadGap = Number.isFinite(gap) && gap >= 0 ? gap : 8;
    squadPitch = Number.isFinite(pitch) && pitch > 0
      ? pitch
      : (Number.isFinite(row) && row > 0 ? row : 54) + squadGap;
    return squadPitch;
  }

  function squadRow(member: SquadMember, index: number): HTMLElement {
    const li = document.createElement('li');
    li.className = `sq-row${member.isYou ? ' is-you' : ''}`;
    li.dataset.rank = String(member.rank);
    li.dataset.index = String(index);
    li.setAttribute('aria-setsize', String(squadRows.length));
    li.setAttribute('aria-posinset', String(index + 1));
    if (member.isYou) li.setAttribute('aria-current', 'true');

    const rank = document.createElement('span');
    rank.setAttribute('aria-hidden', 'true');
    rank.className = 'sq-rank';
    if (member.rank >= 100000) rank.classList.add('is-wide');
    rank.textContent = `#${member.rank}`;

    const id = document.createElement('span');
    id.className = 'sq-id';
    const nameLine = document.createElement('span');
    nameLine.className = 'sq-name-line';
    const name = document.createElement('span');
    name.className = 'sq-name';
    name.textContent = member.name;
    name.title = member.name;
    nameLine.append(name);
    const role = squadRolePill(member.role);
    if (role) nameLine.append(role);
    id.append(nameLine);

    const right = document.createElement('span');
    right.className = 'sq-row-right';
    const score = document.createElement('span');
    score.className = `sq-score${member.tiq <= 0 ? ' is-zero' : ''}`;
    const amount = document.createElement('b');
    amount.textContent = en(member.tiq);
    const unit = document.createElement('small');
    unit.textContent = 'TIQ';
    score.append(squadSvg('#i-brain'), amount, unit);
    score.title = `${en(member.tiq)} Tactical IQ · `
      + (member.arena.rank > 0 ? `Arena #${en(member.arena.rank)}` : 'Arena unranked');
    right.append(score);

    const roleSpeech = member.role === 'leader' ? ', leader' : member.role === 'admin' ? ', admin' : '';
    const honor = member.medal
      ? `, wearing ${member.medal.def.name}${member.medal.serial !== null ? ` edition ${member.medal.serial}` : ''}`
      : '';
    const arenaSpeech = member.arena.rank > 0
      ? `arena rank ${member.arena.rank}`
      : 'unranked in the arena';
    li.setAttribute(
      'aria-label',
      `Rank ${member.rank}: ${member.name}${roleSpeech}, representing ${nameOf(member.country)} — `
      + `${member.tiq} Tactical IQ, ${arenaSpeech}, ${member.arena.wins} tournament wins`
      + `${member.isYou ? ', you' : ''}${honor}.`,
    );
    li.append(rank, squadAvatar(member), id, right);
    return li;
  }

  function paintSquadWindow(force: boolean): void {
    squadFrame = 0;
    if (!squadView || squadBoundView.hidden) return;
    if (!squadRows.length) {
      for (const el of squadRowEls.values()) el.remove();
      squadRowEls.clear();
      squadRange = { start: 0, end: 0, rows: 0 };
      return;
    }
    const viewport = squadScroll.clientHeight;
    if (viewport <= 0) return;
    const pitch = squadPitch;
    const y = squadScroll.scrollTop - squadRosterEl.offsetTop;
    const start = Math.max(0, Math.floor(y / pitch) - 6);
    const end = Math.min(squadRows.length, Math.max(start, Math.ceil((y + viewport) / pitch) + 6));
    if (!force && squadRange.start === start && squadRange.end === end && squadRange.rows === squadRows.length) return;
    squadRange = { start, end, rows: squadRows.length };

    for (const [index, el] of squadRowEls) {
      if (index < start || index >= end) {
        el.remove();
        squadRowEls.delete(index);
      }
    }
    let anchor: HTMLElement | null = null;
    for (let index = end - 1; index >= start; index--) {
      let el = squadRowEls.get(index);
      if (!el) {
        el = squadRow(squadRows[index], index);
        squadRowEls.set(index, el);
        if (anchor) squadRosterEl.insertBefore(el, anchor);
        else squadRosterEl.append(el);
      }
      el.style.top = `${index * pitch}px`;
      anchor = el;
    }
  }

  function scheduleSquadWindow(force = false): void {
    if (force) squadForce = true;
    if (squadFrame) return;
    squadFrame = requestAnimationFrame(() => {
      const forced = squadForce;
      squadForce = false;
      paintSquadWindow(forced);
    });
  }

  function paintSquadRoster(): void {
    const roster = squadView;
    if (!roster) return;
    squadRows = arrangeRoster(roster, 'tiq', squadQuery);
    const filtered = squadQuery.trim().length > 0;
    const membersWord = roster.count === 1 ? 'member' : 'members';
    squadCountEl.textContent = en(squadRows.length);
    squadCountEl.setAttribute('aria-label', filtered
      ? `${en(squadRows.length)} of ${en(roster.count)} ${membersWord} shown`
      : `${en(roster.count)} ${membersWord}`);
    squadRosterEl.setAttribute('aria-label', 'Squad members sorted by TIQ');

    squadRosterEmpty.hidden = squadRows.length > 0;
    squadRosterEl.hidden = squadRows.length === 0;
    const pitch = measureSquadPitch();
    squadRosterEl.style.height = `${Math.max(0, squadRows.length * pitch - squadGap)}px`;
    squadRosterEl.textContent = '';
    squadRowEls.clear();
    squadRange = { start: -1, end: -1, rows: -1 };
    scheduleSquadWindow(true);
  }

  /* The founder is the one name worth reading without scrolling, so the hero wears
     it — the roster's leader row, or "You" when this device owns the squad. */
  function paintSquadLeader(roster: SquadRoster): void {
    const leader = roster.members.find((m) => m.role === 'leader');
    squadLeaderEl.classList.toggle('is-on', !!leader);
    if (!leader) return;
    squadLeaderNameEl.textContent = leader.isYou ? t('you') : leader.name;
    squadLeaderNameEl.title = leader.isYou ? t('you') : leader.name;
    squadLeaderEl.setAttribute('aria-label', leader.isYou
      ? 'You founded this squad.'
      : `Founded by ${leader.name}.`);
  }

  /* Real channel photo over the monogram crest. The CDN can answer with an error
     or a 1x1 placeholder, so the monogram stays underneath until a real frame lands. */
  function paintSquadCrestPhoto(handle: string): void {
    const seq = ++squadPhotoSeq;
    squadCrestFrame.classList.remove('has-photo');
    const src = telegramAvatarUrl(handle);
    if (!src) {
      squadCrestPhoto.removeAttribute('src');
      return;
    }
    squadCrestPhoto.onload = () => {
      if (seq !== squadPhotoSeq) return;
      if (squadCrestPhoto.naturalWidth <= 2 || squadCrestPhoto.naturalHeight <= 2) {
        squadCrestPhoto.removeAttribute('src');
        return;
      }
      squadCrestFrame.classList.add('has-photo');
    };
    squadCrestPhoto.onerror = () => {
      if (seq !== squadPhotoSeq) return;
      squadCrestFrame.classList.remove('has-photo');
      squadCrestPhoto.removeAttribute('src');
    };
    if (squadCrestPhoto.getAttribute('src') === src) {
      if (squadCrestPhoto.complete && squadCrestPhoto.naturalWidth > 2 && squadCrestPhoto.naturalHeight > 2) {
        squadCrestFrame.classList.add('has-photo');
      }
      return;
    }
    squadCrestPhoto.src = src;
  }

  function paintSquadHub(): void {
    const me = getMySquad();
    if (!me) { showSquadSearch(); return; }
    squadView = buildSquadRoster(me);
    $<HTMLElement>('squad-view-avatar').textContent = squadMark(me);
    $<HTMLElement>('squad-view-name').textContent = me.name;
    $<HTMLElement>('squad-view-handle').textContent = me.handle;
    squadCrestBadge.textContent = `#${en(me.rank)}`;
    squadCrestBadge.dataset.rank = me.rank === 1 ? 'gold' : me.rank === 2 ? 'silver' : me.rank === 3 ? 'bronze' : 'num';
    squadCrest.setAttribute('aria-label', `${me.name} crest, global squad rank ${me.rank}`);
    paintSquadCrestPhoto(me.handle);
    $<HTMLElement>('squad-view-avg').textContent = en(squadView.avgTiq);
    $<HTMLElement>('squad-view-members').textContent = en(squadView.count);
    paintSquadLeader(squadView);
    paintSquadYou();
    paintSquadRoster();
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
      label.textContent = t('joinSquad');
      rank.hidden = true;
      rank.textContent = '';
      chip.setAttribute('aria-label', t('joinSquad'));
      chip.title = t('joinSquad');
    }
  }

  /** The average a squad shows in the picker once this player is in it. */
  const squadPreviewAvg = (s: { rank: number; members: number }): number =>
    s.members <= 1
      ? myTiq()
      : Math.round((squadTargetAvg(s.rank) * (s.members - 1) + myTiq()) / s.members);

  interface SquadCardOpts {
    /** null mints the "bind this handle" card instead of a ranked squad */
    rank: number | null;
    mark: string;
    name: string;
    handle: string;
    members?: number;
    tiq?: number;
    note?: string;
    aria: string;
    squadId?: string;
    handleRef?: string;
    joined?: boolean;
  }

  function buildSquadCard(opts: SquadCardOpts): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `sq-card${opts.joined ? ' is-bound' : ''}`;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-haspopup', 'dialog');
    li.setAttribute('aria-label', opts.aria);
    if (opts.squadId) li.dataset.squad = opts.squadId;
    if (opts.handleRef) li.dataset.handle = opts.handleRef;

    const rank = document.createElement('span');
    rank.className = 'sq-rank';
    rank.setAttribute('aria-hidden', 'true');
    if (opts.rank === null) {
      rank.dataset.rank = 'new';
      rank.append(squadSvg('#i-plus'));
    } else {
      rank.dataset.rank = opts.rank === 1 ? 'gold' : opts.rank === 2 ? 'silver' : opts.rank === 3 ? 'bronze' : 'num';
      rank.textContent = `#${opts.rank}`;
    }

    const avatar = document.createElement('span');
    avatar.className = 'sq-card-av';
    avatar.setAttribute('aria-hidden', 'true');
    const mark = document.createElement('b');
    mark.textContent = opts.mark;
    avatar.append(mark);

    /* Real Telegram profile photo layered over the monogram crest. The photo is
       hidden until it loads and is dropped on error or a 1x1 placeholder, so a
       channel without a public picture keeps the polished monogram instead. */
    const avatarSrc = telegramAvatarUrl(opts.handleRef ?? opts.handle);
    if (avatarSrc) {
      const img = document.createElement('img');
      img.className = 'sq-card-img';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      const drop = () => img.remove();
      img.addEventListener('error', drop, { once: true });
      img.addEventListener('load', () => {
        if (img.naturalWidth <= 2 || img.naturalHeight <= 2) { drop(); return; }
        avatar.classList.add('has-photo');
      }, { once: true });
      img.src = avatarSrc;
      avatar.append(img);
    }

    const identity = document.createElement('span');
    identity.className = 'sq-card-id';
    const name = document.createElement('b');
    name.className = 'sq-card-name';
    name.textContent = opts.name;
    name.title = opts.name;
    const handle = document.createElement('span');
    handle.className = 'sq-card-handle';
    handle.textContent = opts.handle;
    const metrics = document.createElement('span');
    metrics.className = 'sq-card-metrics';
    if (opts.members !== undefined) {
      const chip = document.createElement('span');
      chip.className = 'sq-chip sq-chip-mem';
      chip.append(squadSvg('#i-users'), document.createTextNode(en(opts.members)));
      metrics.append(chip);
    }
    if (opts.tiq !== undefined) {
      const chip = document.createElement('span');
      chip.className = 'sq-chip sq-chip-tiq';
      const amount = document.createElement('b');
      amount.textContent = en(opts.tiq);
      chip.append(squadSvg('#i-brain'), amount);
      metrics.append(chip);
    }
    if (opts.note) {
      const note = document.createElement('span');
      note.className = 'sq-card-note';
      note.textContent = opts.note;
      metrics.append(note);
    }
    identity.append(name, handle, metrics);

    /* The one gesture on the row: a quiet chevron that opens the inspection sheet.
       Joining never happens here — the detail sheet owns that commitment. */
    const go = document.createElement('span');
    go.className = 'sq-card-go';
    go.setAttribute('aria-hidden', 'true');
    go.append(squadSvg('#i-next'));

    li.append(rank, avatar, identity, go);
    return li;
  }

  function paintSquadPreview(): void {
    if (!squadPreviewSheet) return;
    const s = previewSquad;
    const handle = s?.handle ?? previewHandle;
    const name = s?.name ?? displayNameOf(handle);
    const tiq = s ? squadPreviewAvg(s) : myTiq();
    const members = s ? s.members : 1;
    const rank = s?.rank ?? 0;

    sqpCrest.dataset.tier = arenaStandingOf(tiq).tier;
    sqpMark.textContent = s ? squadMark(s) : squadLetter({ handle, name });
    sqpName.textContent = name;
    sqpName.title = name;
    sqpHandle.textContent = handle;
    sqpKind.textContent = s
      ? (squadKind(s) === 'channel' ? t('officialChannel') : t('officialGroup'))
      : t('newAlliance');

    sqpRankTile.dataset.rank = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : rank ? 'num' : 'new';
    sqpRankV.textContent = rank ? `#${en(rank)}` : 'NEW';
    sqpRankNote.textContent = rank === 1 ? t('goldMedal') : rank === 2 ? t('silverMedal')
      : rank === 3 ? t('bronzeMedal') : rank ? t('globalPosition') : t('awaitingRank');
    sqpTiq.textContent = en(tiq);
    sqpMembers.textContent = en(members);

    sqpJoin.classList.toggle('is-joined', previewJoined);
    sqpJoinT.textContent = previewJoined ? t('openSquadHub') : t('joinSquad');
    sqpJoin.setAttribute('aria-label', previewJoined
      ? `${t('openSquadHub')} · ${handle}`
      : `${t('joinSquad')} · ${name}, ${handle}`);
    sqpFine.textContent = previewJoined
      ? t('squadFineJoined').replace('{handle}', handle)
      : s
        ? t('squadFineJoin').replace('{handle}', handle).replace('{n}', en(members))
        : t('squadFineNew').replace('{handle}', handle);
  }

  function openSquadPreview(target: { squad?: RankedSquad; handle?: string }): void {
    if (!squadPreviewSheet) return;
    squadErr.hidden = true;
    previewQuery = squadQ.value;
    previewScroll = squadList.scrollTop;
    previewSquad = target.squad ?? null;
    previewHandle = target.handle ?? target.squad?.handle ?? '';
    previewJoined = !!previewSquad && getMySquad()?.id === previewSquad.id;
    paintSquadPreview();
    impact('light');
    api.sheets.open(squadPreviewSheet);
  }

  function backToSquadList(): void {
    if (!squadSheet) return;
    impact('light');
    squadQ.value = previewQuery;
    showSquadSearch();
    api.sheets.open(squadSheet);
    requestAnimationFrame(() => { squadList.scrollTop = previewScroll; });
  }

  function commitPreviewJoin(): void {
    if (!previewSquad && !previewHandle) return;
    if (previewSquad && getMySquad()?.id === previewSquad.id) {
      impact('light');
      if (!squadSheet) return;
      showSquadBound();
      api.sheets.open(squadSheet);
      requestAnimationFrame(() => scheduleSquadWindow(true));
      return;
    }
    const result = previewSquad ? bindSquadById(previewSquad.id) : bindSquad(previewHandle);
    if (result === 'bad-handle') {
      notify('warning');
      showToast(t('badChannel'), 'warning');
      return;
    }
    impact('medium');
    notify('success');
    const joinedName = previewSquad?.name ?? displayNameOf(previewHandle);
    const joinedHandle = previewSquad?.handle ?? previewHandle;
    showToast(`${joinedName} joined · ${joinedHandle}`, 'success');
    paintSquadPill();
    api.sheets.close();
  }

  function paintSquadList(q: string) {
    const rows = searchSquads(q, 20);
    const me = getMySquad();
    squadList.textContent = '';
    const needle = cleanHandle(q);
    const hasExact = needle && rows.some((s) => s.handle.toLowerCase() === needle.toLowerCase());
    if (needle && !hasExact) {
      squadList.append(buildSquadCard({
        rank: null,
        mark: squadLetter({ handle: needle, name: needle }),
        name: t('bindHandle').replace('{handle}', needle),
        handle: t('newChannel'),
        note: t('freshRoster'),
        aria: t('bindHandle').replace('{handle}', needle),
        handleRef: needle,
      }));
    }
    for (const s of rows) {
      const joined = me?.id === s.id;
      squadList.append(buildSquadCard({
        rank: s.rank,
        mark: squadMark(s),
        name: s.name,
        handle: s.handle,
        members: s.members,
        tiq: squadPreviewAvg(s),
        aria: joined
          ? `${s.name}, ${s.handle} — your squad. Inspect squad details.`
          : `Inspect ${s.name}, ${s.handle}, rank ${s.rank}`,
        squadId: s.id,
        joined,
      }));
    }
    squadEmpty.hidden = squadList.childElementCount > 0;
    if (!squadList.childElementCount) squadEmpty.textContent = q.trim() ? t('noSquadMatch') : t('noSquadsYet');
    squadList.scrollTop = 0;
  }

  function resetSquadLeave() {
    window.clearTimeout(squadLeaveTimer);
    squadLeaveTimer = 0;
    squadLeaveBtn.classList.remove('is-armed');
    squadLeaveBtn.textContent = t('leaveSquad');
    squadLeaveBtn.setAttribute('aria-label', t('leaveSquad'));
  }

  /* One key, both directions: from the hub it opens the field, from the field it
     goes home. It only exists once a squad is bound, so a first-run player still
     lands on a discovery screen with a single loud action. */
  function paintSquadExplore(): void {
    const bound = !!getMySquad();
    squadExploreBtn.classList.toggle('is-on', bound);
    if (!bound) return;
    const hub = !squadBoundView.hidden;
    squadExploreT.textContent = hub ? t('exploreSquads') : t('yourSquad');
    squadExploreIco.setAttribute('href', hub ? '#i-globe' : '#i-back');
    squadExploreBtn.setAttribute('aria-label', hub ? 'Explore all squads' : 'Back to your squad');
  }

  function showSquadSearch() {
    squadSearchView.hidden = false;
    squadBoundView.hidden = true;
    squadSheet?.classList.remove('is-hub');
    $('squad-title').textContent = t('joinSquad');
    const sub = $('squad-sub');
    sub.textContent = t('joinSquadDesc');
    sub.hidden = false;
    squadErr.hidden = true;
    squadView = null;
    squadRows = [];
    squadQuery = '';
    squadMemberQ.value = '';
    resetSquadLeave();
    paintSquadList(squadQ.value);
    paintSquadExplore();
  }

  function showSquadBound() {
    const me = getMySquad();
    if (!me) { showSquadSearch(); return; }
    squadSearchView.hidden = true;
    squadBoundView.hidden = false;
    squadSheet?.classList.add('is-hub');
    $('squad-title').textContent = t('yourSquad');
    $('squad-sub').hidden = true;
    squadQuery = '';
    squadMemberQ.value = '';
    resetSquadLeave();
    paintSquadHub();
    squadScroll.scrollTop = 0;
    scheduleSquadWindow(true);
    paintSquadExplore();
  }

  function openSquad() {
    if (!squadSheet) return;
    squadQ.value = '';
    squadQuery = '';
    squadMemberQ.value = '';
    const me = getMySquad();
    if (me) showSquadBound();
    else showSquadSearch();
    api.sheets.open(squadSheet);
    impact('light');
    requestAnimationFrame(() => scheduleSquadWindow(true));
  }

  squadQ.addEventListener('input', () => { squadErr.hidden = true; paintSquadList(squadQ.value); });
  squadQ.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = squadQ.value.trim();
    if (!q) { squadError(t('searchSquadHint')); return; }
    const rows = searchSquads(q);
    const needle = cleanHandle(q);
    const exact = needle ? rows.find((s) => s.handle.toLowerCase() === needle.toLowerCase()) : undefined;
    if (exact) { openSquadPreview({ squad: exact }); return; }
    if (needle) { openSquadPreview({ handle: needle }); return; }
    if (rows.length) { openSquadPreview({ squad: rows[0] }); return; }
    squadError(t('squadChannelHint'));
  });
  squadList.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement | null)?.closest<HTMLElement>('.sq-card');
    if (!card) return;
    const id = card.dataset.squad;
    if (id) {
      const squad = getSquadRanking().find((s) => s.id === id);
      if (squad) openSquadPreview({ squad });
      return;
    }
    const handle = card.dataset.handle;
    if (handle) openSquadPreview({ handle });
  });
  squadList.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = (e.target as HTMLElement | null)?.closest<HTMLElement>('.sq-card');
    if (!card || e.target !== card) return;
    e.preventDefault();
    card.click();
  });

  sqpBack.addEventListener('click', backToSquadList);
  sqpJoin.addEventListener('click', commitPreviewJoin);

  $('squad-create').addEventListener('click', () => {
    impact('light');
    window.dispatchEvent(new CustomEvent('detour:squad-register'));
  });

  squadExploreBtn.addEventListener('click', () => {
    impact('light');
    if (squadBoundView.hidden) showSquadBound();
    else showSquadSearch();
  });

  /* The roster is windowed: a scroll frame paints only the rows around the
     viewport, so the DOM stays at ~20 rows no matter how many members there are. */
  squadScroll.addEventListener('scroll', () => scheduleSquadWindow(), { passive: true });
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => scheduleSquadWindow(true)).observe(squadScroll);
  } else {
    window.addEventListener('resize', () => scheduleSquadWindow(true));
  }

  squadMemberQ.addEventListener('input', () => {
    squadQuery = squadMemberQ.value;
    window.clearTimeout(squadSearchTimer);
    squadSearchTimer = window.setTimeout(() => {
      if (squadBoundView.hidden) return;
      paintSquadRoster();
      squadScroll.scrollTop = 0;
    }, 90);
  });
  squadLeaveBtn.addEventListener('click', () => {
    if (!squadLeaveBtn.classList.contains('is-armed')) {
      squadLeaveBtn.classList.add('is-armed');
      squadLeaveBtn.textContent = 'Confirm leave';
      squadLeaveBtn.setAttribute('aria-label', 'Confirm leaving squad');
      squadLeaveTimer = window.setTimeout(resetSquadLeave, 4000);
      impact('light');
      return;
    }
    resetSquadLeave();
    leaveSquad();
    impact('medium');
    paintSquadPill();
    showSquadSearch();
  });
  onSquadChange(() => {
    paintSquadPill();
    if (!squadSheet || squadSheet.hidden) return;
    if (!squadBoundView.hidden) paintSquadHub();
    else paintSquadList(squadQ.value);
  });

  /* A completed enlistment lands here: the modal is a singleton outside this
     scope, so it announces the new squad on the window and the lobby answers by
     opening its dashboard. The registration is already written — this is only
     the hand-off, never a second write. */
  window.addEventListener('detour:squad-enlisted', () => {
    if (!squadSheet) return;
    squadQ.value = '';
    squadQuery = '';
    squadMemberQ.value = '';
    showSquadBound();
    api.sheets.open(squadSheet);
    requestAnimationFrame(() => scheduleSquadWindow(true));
  });

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
  $('pf-team').addEventListener('click', openSquad);
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
  let refPoll = 0;

  function paintReferral() {
    const r = profile.referral;
    const sub = document.getElementById('pf-invite-s');
    if (sub) sub.textContent = t('inviteEarn').replace('{n}', en(REFERRAL_REWARD));
    const banner = document.getElementById('ref-banner');
    if (banner) banner.innerHTML = `Get <b>${en(REFERRAL_REWARD)} Coins</b> for you &amp; your friend upon joining!`;
    const pill = document.getElementById('pf-invite-pill');
    if (pill) pill.textContent = r.joins > 0 ? `${en(r.joins)} Invited` : t('invite');
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
    /* The modal previews the real handle and the server-issued code, never a guessed id. */
    const code = referralCode();
    const handle = document.getElementById('ref-handle');
    if (handle) handle.textContent = `@${BOT_HANDLE}`;
    const codeEl = document.getElementById('ref-code');
    if (codeEl) codeEl.textContent = code ? `ref_${code}` : 'ref_…';
    const link = referralLink();
    if (refLinkEl) {
      refLinkEl.value = link;
      refLinkEl.placeholder = link ? '' : 'Preparing your invite link…';
    }
    const copy = document.getElementById('ref-copy') as HTMLButtonElement | null;
    if (copy) copy.disabled = !link;
    const share = document.getElementById('ref-share') as HTMLButtonElement | null;
    if (share) share.disabled = !link;
  }

  function stopRefPoll() {
    if (!refPoll) return;
    window.clearInterval(refPoll);
    refPoll = 0;
  }

  function startRefPoll() {
    stopRefPoll();
    refPoll = window.setInterval(() => {
      if (!refSheet?.classList.contains('open')) { stopRefPoll(); return; }
      void refreshReferral().then(() => {
        if (refSheet?.classList.contains('open')) paintReferral();
      });
    }, 3000);
  }

  function openReferral() {
    if (!refSheet) return;
    paintReferral();
    api.sheets.open(refSheet);
    impact('light');
    /* the Worker's live ledger; the local save paints instantly and the delta folds in after */
    void refreshReferral().then(() => { if (refSheet.classList.contains('open')) paintReferral(); });
    startRefPoll();
  }

  document.getElementById('pf-invite')?.addEventListener('click', openReferral);
  refLinkEl?.addEventListener('focus', () => refLinkEl.select());
  refLinkEl?.addEventListener('click', () => refLinkEl.select());

  document.getElementById('ref-copy')?.addEventListener('click', () => {
    const btn = document.getElementById('ref-copy');
    const link = referralLink();
    if (!link) { impact('light'); return; }
    impact('light');
    void copyText(link).then((ok) => {
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
    if (!share) return;
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

  /* the ledger fold lands on a save flush; repaint the card and the open sheet on that beat */
  onChange(paintReferral);

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

  /* Competitive division mirrors the Mind Ladder bands exactly:
     0-999 Rookie, 1000-1999 Tactician, 2000-2999 Strategist, 3000+ Grandmaster,
     each split into I / II / III. TIQ is the only source, never the XP level. */
  const TIER_BAND: Record<MindTier, [number, number]> = {
    rookie: [0, 1000],
    tactician: [1000, 2000],
    strategist: [2000, 3000],
    grandmaster: [3000, 4000],
  };
  const DIVISION = ['I', 'II', 'III'] as const;
  const divisionFor = (tiq: number): { tier: MindTier; label: string } => {
    const tier = tierOf(tiq);
    const [lo, hi] = TIER_BAND[tier];
    const step = (hi - lo) / DIVISION.length;
    const slot = Math.min(DIVISION.length - 1, Math.floor(Math.max(0, tiq - lo) / step));
    return { tier, label: `${TIER_NAME[tier]} ${DIVISION[slot]}` };
  };

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
    /* TIQ is the flagship stat: the number, and the real Mind Ladder division it buys. */
    const tiq = myTiq();
    const division = divisionFor(tiq);
    const tiqValue = document.getElementById('pf-tiq');
    if (tiqValue) tiqValue.textContent = en(tiq);
    const tiqPill = document.getElementById('pf-tiq-pill');
    if (tiqPill) {
      const label = `${en(tiq)} Tactical IQ, ${division.label}`;
      tiqPill.setAttribute('aria-label', label);
      tiqPill.setAttribute('title', label);
    }
    /* the level lives in the XP rail's left label now — it is the same figure the bar fills */
    const levelCaption = document.getElementById('pf-xp-lvl');
    if (levelCaption) levelCaption.setAttribute('aria-label', `Level ${lv.n}`);
    /* the avatar is the frame control: its name reads out instead of a caption pill */
    const wrap = document.getElementById('pf-avatar-wrap');
    if (wrap) {
      const frame = profile.frame ?? 'default';
      const label = `${frameName(frame)} avatar frame. Tap to change.`;
      wrap.setAttribute('data-frame', frame);
      wrap.setAttribute('aria-label', label);
      wrap.setAttribute('title', label);
    }
    /* the equipped honor, pinned to the avatar: its metal names it, its tap spots it */
    const eq = equippedBadge();
    const eqWrap = document.getElementById('pf-equipped-badge') as HTMLButtonElement | null;
    const serialTag = document.getElementById('pf-equipped-serial');
    if (eqWrap) {
      if (!eq) {
        eqWrap.hidden = true;
        eqWrap.removeAttribute('data-accent');
        eqWrap.removeAttribute('aria-label');
        eqWrap.removeAttribute('title');
        if (serialTag) { serialTag.hidden = true; serialTag.textContent = ''; }
      } else {
        eqWrap.hidden = false;
        eqWrap.setAttribute('data-accent', eq.accent);
        /* the pin carries the honor's own metal: rendered art when it ships, else the crest */
        if (eqWrap.dataset.badge !== eq.id) {
          eqWrap.innerHTML = badgeCrestHtml(eq, 'badge-crest pf-equipped-crest');
          eqWrap.dataset.badge = eq.id;
        }
        const ed = badgeEdition(eq.id);
        eqWrap.setAttribute(
          'aria-label',
          `Equipped badge: ${eq.name}. ${editionSpeech(ed)} ${eq.archetype}, ${eq.pillar}. Spotlight it.`,
        );
        eqWrap.title = `${eq.name} · ${badgeStatus(eq.id, true).text} · ${eq.archetype}`;
        /* the pin's serial tag is the server-confirmed number, not a local best guess */
        if (serialTag) {
          if (ed.serial !== null) {
            serialTag.hidden = false;
            serialTag.textContent = editionSerialLabel(ed.serial);
            serialTag.setAttribute('data-accent', eq.accent);
          } else {
            serialTag.hidden = true;
            serialTag.textContent = '';
            serialTag.removeAttribute('data-accent');
          }
        }
      }
    }
  };

  /* Honor & Badges: the Genius Triad on one focused shelf. Three archetype
     tiles — crest, title, archetype — and the tile itself is the equip control:
     an unlocked tap swaps the active honor, a locked tap opens its lore. The
     shelf's note line and the avatar pin share one spotlight, so a badge can
     always name its title and archetype in words. */
  const badgeMetricIcon = (b: BadgeDef): string =>
    b.accent === 'quantum' ? 'i-brain' : b.accent === 'titanium' ? 'i-shield' : 'i-swords';

  const makeSlot = (b: BadgeDef, unlocked: boolean, equipped: boolean, label: string): HTMLButtonElement => {
    const edition = badgeEdition(b.id);
    const tag = badgeStatus(b.id, equipped);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `badge-slot ${unlocked ? 'is-unlocked' : 'is-locked'}`
      + `${equipped ? ' is-equipped' : ''}${edition.minting ? ' is-minting' : ''}`;
    btn.dataset.badge = b.id;
    btn.dataset.accent = b.accent;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(equipped));
    btn.setAttribute(
      'aria-label',
      `${b.figure}. ${b.archetype}, ${b.pillar}. ${editionSpeech(edition)} ${unlocked
        ? equipped ? 'Equipped. Tap for details.' : 'Unlocked. Tap to equip.'
        : `Locked. ${label}. Tap for details.`}`,
    );
    btn.title = unlocked
      ? `${b.figure} · ${b.archetype} · ${tag.text} · ${b.description}`
      : `${b.figure} · ${b.archetype} · ${tag.text} · ${label}`;

    const crest = document.createElement('span');
    crest.className = 'badge-slot-crest';
    crest.setAttribute('aria-hidden', 'true');
    crest.innerHTML = badgeCrestHtml(b);
    const pedestal = document.createElement('span');
    pedestal.className = 'badge-slot-pedestal';
    pedestal.setAttribute('aria-hidden', 'true');
    const stage = document.createElement('span');
    stage.className = 'badge-slot-stage';
    stage.append(crest, pedestal);
    const name = document.createElement('span');
    name.className = 'badge-slot-n';
    name.textContent = b.figure;
    const arch = document.createElement('span');
    arch.className = 'badge-slot-a';
    arch.textContent = b.archetype;
    const main = document.createElement('span');
    main.className = 'badge-slot-main';
    main.append(name, arch);
    const status = document.createElement('span');
    status.className = `badge-slot-serial is-${tag.kind}`;
    status.setAttribute('aria-hidden', 'true');
    status.textContent = tag.text;
    btn.append(stage, main, status);

    if (equipped) {
      const check = document.createElement('span');
      check.className = 'badge-slot-check';
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = '<svg class="ico"><use href="#i-check" /></svg>';
      btn.append(check);
    }

    btn.addEventListener('click', () => {
      /* the shelf is the quick-equip control; a second tap on the active honor
         opens its sheet instead of re-equipping it */
      if (!isBadgeUnlocked(b.id) || profile.badge === b.id) { impact('light'); openBadge(b.id); return; }
      setBadge(b.id);
      impact('medium');
      notify('success');
      showPfToast(`${b.name} equipped`, true);
    });
    return btn;
  };

  let spotlightTimer = 0;
  function spotlightBadge(id: string): void {
    const rack = document.getElementById('honor-badges-rack');
    const note = document.getElementById('pf-badge-note');
    const tile = rack?.querySelector<HTMLButtonElement>(`[data-badge="${id}"]`);
    const b = BADGES.find((x) => x.id === id);
    if (!rack || !tile || !b) return;
    if (note) {
      note.textContent = `${b.archetype} · ${b.pillar} — ${b.description}`;
      note.dataset.accent = b.accent;
      note.hidden = false;
      note.classList.remove('is-lit');
    }
    tile.classList.remove('is-spotlit');
    void tile.offsetWidth;
    tile.classList.add('is-spotlit');
    note?.classList.add('is-lit');
    rack.scrollIntoView({ behavior: motionReduced() ? 'auto' : 'smooth', block: 'center' });
    tile.focus({ preventScroll: true });
    window.clearTimeout(spotlightTimer);
    spotlightTimer = window.setTimeout(() => {
      tile.classList.remove('is-spotlit');
      note?.classList.remove('is-lit');
    }, 1800);
  }

  /* The only thing the shelf says about the network: a quiet line under the rack. While a
     refresh is in flight, or after it failed and the cached counts are all we have, it stays
     visible; a successful sync hides it again. */
  const paintBadgeStatus = () => {
    const el = document.getElementById('pf-badge-sync');
    if (!el) return;
    const state = editionSyncState();
    el.hidden = state !== 'syncing' && state !== 'offline';
    el.title = state === 'offline' ? 'Offline — showing the last confirmed editions' : '';
  };

  const paintBadges = () => {
    const rack = document.getElementById('honor-badges-rack');
    const count = document.getElementById('pf-badge-count');
    if (count) count.textContent = `(${unlockedCount()}/${BADGES.length})`;
    const sub = document.getElementById('badges-sub');
    if (sub) sub.textContent = `${unlockedCount()} of ${BADGES.length} honors unlocked. Equip the mind that races like you.`;
    if (!rack) return;
    rack.textContent = '';
    for (const b of BADGES) {
      const unlocked = isBadgeUnlocked(b.id);
      const prog = badgeProgress(b.id);
      rack.append(makeSlot(b, unlocked, unlocked && profile.badge === b.id, prog.label));
    }
    /* the note under the shelf always names the equipped honor's archetype */
    const note = document.getElementById('pf-badge-note');
    const eq = equippedBadge();
    if (note) {
      if (eq) {
        const text = `${eq.archetype} · ${eq.pillar} — ${eq.description}`;
        if (note.textContent !== text) note.textContent = text;
        note.hidden = false;
        note.dataset.badge = eq.id;
        note.dataset.accent = eq.accent;
      } else {
        note.hidden = true;
        note.textContent = '';
        delete note.dataset.badge;
        delete note.dataset.accent;
      }
    }
    paintBadgeList();
    paintBadgeStatus();
  };

  /* "View All ›" drawer: the Genius Triad as three honor cards. Each card
     carries its crest, title, archetype/pillar line, one-line archetype
     description and its requirement meter, with an EQUIPPED seal, a Details
     pill or a locked pill. A card opens the detail drawer, where the full
     requirement, progress and the equip action live. */
  function paintBadgeList() {
    const list = document.getElementById('badge-list');
    if (!list) return;
    list.textContent = '';
    for (const b of BADGES) {
      const unlocked = isBadgeUnlocked(b.id);
      const equipped = unlocked && profile.badge === b.id;
      const prog = badgeProgress(b.id);
      const edition = badgeEdition(b.id);
      /* the rail owns EQUIPPED; this line owns the honor's own mint */
      const tag = badgeStatus(b.id, false);
      const li = document.createElement('li');
      li.className = `badge-card ${unlocked ? 'is-unlocked' : 'is-locked'}`
        + `${equipped ? ' is-equipped' : ''}${edition.minting ? ' is-minting' : ''}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(equipped));
      li.setAttribute('aria-label', `${b.figure}. ${b.archetype}, ${b.pillar}. ${editionSpeech(edition)} ${b.description} ${
        equipped ? 'Equipped.' : unlocked ? 'Unlocked.' : `Locked. ${prog.label}.`
      } Open details.`);
      li.title = `${b.figure} · ${b.archetype} · ${tag.text} — ${b.description}`;
      li.tabIndex = 0;
      li.dataset.badge = b.id;
      li.dataset.accent = b.accent;

      const crest = document.createElement('span');
      crest.className = 'badge-card-crest';
      crest.setAttribute('aria-hidden', 'true');
      crest.innerHTML = badgeCrestHtml(b);

      const main = document.createElement('span');
      main.className = 'badge-card-main';

      const nm = document.createElement('span');
      nm.className = 'badge-card-n';
      nm.textContent = b.name;
      const arch = document.createElement('span');
      arch.className = 'badge-card-arch';
      arch.textContent = `${b.archetype} · ${b.pillar}`;
      const ser = document.createElement('span');
      ser.className = `badge-card-ser is-${tag.kind}`;
      ser.setAttribute('aria-hidden', 'true');
      ser.textContent = tag.text;
      const desc = document.createElement('span');
      desc.className = 'badge-card-lore';
      desc.textContent = b.description;

      /* the requirement chip: the archetype's own proof, met or not */
      const chip = document.createElement('span');
      chip.className = 'badge-card-tiq';
      chip.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#${badgeMetricIcon(b)}" /></svg>`;
      const fig = document.createElement('b');
      fig.textContent = unlocked ? 'Unlocked' : prog.label;
      const unit = document.createElement('span');
      unit.textContent = unlocked ? b.pillar : 'Locked';
      chip.append(fig, unit);

      main.append(nm, arch, ser, desc, chip);

      if (!unlocked) {
        const meter = document.createElement('span');
        meter.className = 'badge-card-meter';
        const bar = document.createElement('i');
        bar.className = 'badge-card-bar';
        const fill = document.createElement('b');
        const pct = Math.round(prog.pct * 100);
        fill.style.width = `${pct}%`;
        bar.append(fill);
        const label = document.createElement('em');
        label.className = 'badge-card-meter-t';
        label.textContent = `${pct}%`;
        meter.append(bar, label);
        main.append(meter);
      }

      /* the right rail: one pill that says the whole state of the badge */
      const rail = document.createElement('span');
      rail.className = 'badge-card-rail';
      const pill = document.createElement('span');
      pill.className = 'badge-card-pill';
      if (equipped) {
        pill.classList.add('is-equipped');
        pill.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-check" /></svg><b>EQUIPPED</b>';
      } else if (unlocked) {
        pill.classList.add('is-arm');
        pill.textContent = 'Details';
      } else {
        pill.classList.add('is-locked');
        pill.textContent = 'Locked';
      }
      rail.append(pill);

      li.append(crest, main, rail);

      const activate = () => { impact('light'); openBadge(b.id); };
      li.addEventListener('click', activate);
      li.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        activate();
      });
      list.append(li);
    }
  }

  function holderRow(serial: number, name: string, opts: { open?: boolean; you?: boolean } = {}): HTMLElement {
    const li = document.createElement('li');
    li.className = `bd-hof-row${opts.open ? ' is-open' : ''}${opts.you ? ' is-you' : ''}`;
    const key = document.createElement('span');
    key.className = 'bd-hof-serial';
    key.textContent = editionSerialLabel(serial);
    const who = document.createElement('span');
    who.className = 'bd-hof-name';
    who.textContent = name;
    li.append(key, who);
    if (opts.you) {
      const tag = document.createElement('span');
      tag.className = 'bd-hof-tag';
      tag.textContent = 'You';
      li.append(tag);
    }
    return li;
  }

  /* The hall is a preview of the first serials: named holders, unlisted legacy claims, then
     the next open slots. The player's own serial is pinned when it falls past the preview. */
  function paintBadgeHall(def: BadgeDef, edition: BadgeEdition): void {
    const list = document.getElementById('badge-hof-list');
    if (!list) return;
    list.textContent = '';
    const live = editionHolders(def.id);
    const named = new Map((live ?? []).map((h) => [h.serial, h.name]));
    const minted = edition.minted ?? (edition.serial ?? 0);
    const known = live !== null || edition.remaining !== null || edition.serial !== null;
    const sub = document.getElementById('badge-hof-sub');
    if (sub) {
      sub.textContent = live !== null
        ? `${live.length} holder${live.length === 1 ? '' : 's'}`
        : `${edition.cap} serials`;
    }

    if (known && minted === 0 && edition.serial === null) {
      const empty = document.createElement('li');
      empty.className = 'bd-hof-empty';
      const first = document.createElement('b');
      first.textContent = 'Be the first to claim serial #001';
      const hint = document.createElement('span');
      hint.textContent = 'The first mint is reserved for the fastest formula.';
      empty.append(first, hint);
      list.append(empty);
      for (let serial = 1; serial <= Math.min(3, def.cap); serial++) {
        list.append(holderRow(serial, 'Available', { open: true }));
      }
      return;
    }

    const preview = Math.min(def.cap, 7);
    for (let serial = 1; serial <= preview; serial++) {
      const name = named.get(serial);
      if (name !== undefined) {
        list.append(holderRow(serial, name, { you: edition.serial === serial }));
      } else if (serial <= minted) {
        list.append(holderRow(serial, known ? 'Unlisted' : 'Claimed', { you: edition.serial === serial }));
      } else if (known) {
        list.append(holderRow(serial, 'Available', { open: true }));
      } else {
        list.append(holderRow(serial, 'Syncing…', { open: true }));
      }
    }
    if (edition.serial !== null && edition.serial > preview) {
      list.append(holderRow(edition.serial, named.get(edition.serial) ?? 'You', { you: true }));
    }
  }

  function paintBadgeSheet(id: string): void {
    const def = BADGES.find((b) => b.id === id);
    const sheet = document.getElementById('sheet-badge');
    if (!def || !sheet) return;
    const unlocked = isBadgeUnlocked(id);
    const prog = badgeProgress(id);
    const edition = badgeEdition(id);
    const pct = Math.round(prog.pct * 100);

    sheet.dataset.accent = def.accent;
    const title = document.getElementById('badge-title');
    if (title) title.textContent = def.name;
    const arch = document.getElementById('badge-archetype');
    if (arch) arch.textContent = `${def.archetype} • ${def.pillar}`;

    const state = document.getElementById('badge-state');
    if (state) {
      if (!unlocked) {
        state.textContent = `Locked • ${prog.label}`;
        state.dataset.state = 'locked';
      } else if (edition.serial !== null) {
        state.textContent = `Serial ${editionSerialLabel(edition.serial)} of ${edition.cap}`;
        state.dataset.state = 'minted';
      } else if (edition.minting) {
        state.textContent = 'Unlocked • minting';
        state.dataset.state = 'minting';
      } else {
        state.textContent = 'Unlocked';
        state.dataset.state = 'open';
      }
    }

    const lore = document.getElementById('badge-lore');
    if (lore) lore.textContent = def.lore;
    const crit = document.getElementById('badge-criteria');
    if (crit) crit.textContent = def.criteria;

    const capEl = document.getElementById('badge-scar-cap');
    if (capEl) capEl.textContent = String(def.cap);
    const supplyTrack = document.getElementById('badge-scar-track');
    supplyTrack?.style.setProperty('--bd-cap', String(def.cap));
    const supplyFill = document.getElementById('badge-supply-fill');
    const minted = edition.minted ?? (edition.serial !== null ? edition.serial : null);
    if (supplyFill) {
      supplyFill.style.width = `${def.cap > 0 ? Math.min(100, ((minted ?? 0) / def.cap) * 100) : 0}%`;
    }
    const edLine = document.getElementById('badge-edition');
    if (edLine) {
      edLine.dataset.state = edition.serial !== null ? 'mine'
        : edition.remaining === null ? 'syncing'
          : edition.remaining <= 0 ? 'closed' : 'open';
      if (edition.remaining !== null && minted !== null) {
        edLine.textContent = `${minted} / ${edition.cap} claimed • ${edition.remaining} remaining`;
      } else if (edition.serial !== null) {
        edLine.textContent = `${edition.serial} / ${edition.cap} claimed • syncing`;
      } else {
        edLine.textContent = `— / ${edition.cap} claimed • syncing`;
      }
    }
    paintBadgeHall(def, edition);

    const req = document.getElementById('badge-req');
    req?.setAttribute('data-met', String(prog.met));
    const fill = document.getElementById('badge-progress-fill');
    const bar = document.getElementById('badge-progress-bar');
    const label = document.getElementById('badge-progress-t');
    if (fill) fill.style.width = `${unlocked ? 100 : pct}%`;
    if (bar) {
      bar.setAttribute('aria-valuenow', String(Math.min(prog.got, prog.need)));
      bar.setAttribute('aria-valuemax', String(prog.need));
      bar.setAttribute('aria-valuetext', prog.label);
    }
    if (label) label.textContent = unlocked ? 'Complete — ready to equip' : prog.label;
    const count = document.getElementById('badge-req-count');
    if (count) count.textContent = `${en(prog.got)} / ${en(prog.need)}`;
    const delta = document.getElementById('badge-req-delta');
    if (delta) delta.textContent = badgeDelta(id);

    const cta = document.getElementById('badge-equip') as HTMLButtonElement | null;
    const ctaLabel = document.getElementById('badge-cta-label');
    if (cta && ctaLabel) {
      const use = cta.querySelector('use');
      if (!unlocked) {
        cta.disabled = false;
        cta.dataset.mode = 'play';
        ctaLabel.textContent = 'Play now to claim';
        use?.setAttribute('href', '#i-play');
        cta.setAttribute('aria-label', `Play a race to unlock ${def.name}`);
      } else if (profile.badge === id) {
        cta.disabled = true;
        cta.dataset.mode = 'equipped';
        ctaLabel.textContent = 'Medallion equipped';
        use?.setAttribute('href', '#i-check');
        cta.setAttribute('aria-label', `${def.name} is equipped`);
      } else {
        cta.disabled = false;
        cta.dataset.mode = 'equip';
        ctaLabel.textContent = 'Equip medallion';
        use?.setAttribute('href', '#i-check');
        cta.setAttribute('aria-label', `Equip ${def.name} to your profile`);
      }
    }
  }

  let badgeDraft: string | null = null;
  function openBadge(id: string) {
    const def = BADGES.find((b) => b.id === id);
    const sheet = api.sheet('sheet-badge');
    if (!def || !sheet) return;
    badgeDraft = id;
    const crest = document.getElementById('badge-sheet-ico-wrap');
    if (crest) {
      crest.dataset.badge = def.id;
      crest.dataset.accent = def.accent;
      crest.innerHTML = badgeCrestHtml(def);
    }
    paintBadgeSheet(id);
    void refreshBadgeEditions();
    api.sheets.open(sheet);
    /* the sheet must be laid out before scrollTop can reset: a hidden element ignores it */
    const body = document.getElementById('badge-sheet-body');
    if (body) body.scrollTop = 0;
    impact('light');
  }

  const paintIdentity = (): void => {
    paintFaces();
    const lv = levelInfo();
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
    if (countryName) countryName.textContent = c ? nameOf(c) : t('addCountry');
    $('pf-country-v').textContent = c ? nameOf(c) : t('addCountry');
    const pfFlag = document.getElementById('pf-flag');
    if (pfFlag && pfFlag.dataset.cc !== (c ?? '')) {
      pfFlag.textContent = '';
      if (c) pfFlag.append(flagPhoto(c, 'fp-slot'));
      pfFlag.dataset.cc = c ?? '';
    }
    /* the flag itself, blurred to a wash, is the nation card's ambient light —
       repainted only when the nation changes, never on a resize */
    const pfAura = document.getElementById('pf-country-aura');
    if (pfAura && pfAura.dataset.cc !== (c ?? '')) {
      pfAura.textContent = '';
      if (c) pfAura.append(flagPhoto(c, 'fp-slot'));
      pfAura.dataset.cc = c ?? '';
    }
    document.getElementById('pf-country-ico')?.classList.toggle('has-flag', !!c);
    const countryCard = document.getElementById('pf-country');
    countryCard?.classList.toggle('is-set', !!c);
    const countryMeta = document.getElementById('pf-country-meta');
    if (countryMeta) {
      if (c) countryMeta.textContent = `${c} · ${profile.rewards.country ? t('nationalDivision') : t('rewardReady')}`;
      else countryMeta.innerHTML = `<bdi dir="ltr">+${IDENTITY_REWARD}</bdi> ${t('coinsWhenSet')}`;
    }
    const countryLabel = c
      ? `${nameOf(c)}. ${profile.rewards.country ? t('nationalDivision') : t('rewardReady')}.`
      : `${t('addCountry')} · +${IDENTITY_REWARD} ${t('coins')}`;
    $('pf-country').setAttribute('aria-label', countryLabel);
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
    const squad = getMySquad();
    $('pf-team-v').textContent = squad ? squad.name : t('joinASquad');
    const squadMeta = document.getElementById('pf-team-meta');
    if (squadMeta) {
      squadMeta.textContent = squad
        ? `#${squad.rank} • ${en(squad.members)} ${t('members')}`
        : t('communitySquads');
    }
    document.getElementById('pf-team')?.classList.toggle('is-set', !!squad);
    $('pf-team').setAttribute('aria-label', squad
      ? `${squad.name}. #${squad.rank}, ${en(squad.members)} ${t('members')}`
      : t('joinASquad'));
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
    $('pf-fav-sub').textContent = s.games
      ? t('botRaces').replace('{n}', en(s.modes.bot ?? 0))
      : t('noRacesYet');
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
    const th = theme();
    for (const k of KINDS) {
      let pv = eqPv.get(k);
      if (!pv) {
        pv = createPreview(document.querySelector<HTMLCanvasElement>(`canvas[data-eq=${JSON.stringify(k)}]`)!, k, th);
        eqPv.set(k, pv);
      } else pv.setTheme(th);
      pv.resize();
      pv.settle();
      $(`eq-${k}`).textContent = th[k].name;
    }
  };
  onChange(paintProfile);

  /* Cache writes already flush the whole save; this listener is for the states a flush cannot
     signal — the first "syncing" frame, each mint starting and settling, and the final offline
     state. It repaints only the badge surfaces, never the cosmetics previews. */
  onEditionChange(() => {
    paintHeroExtras(levelInfo());
    paintBadges();
    if (badgeDraft) paintBadgeSheet(badgeDraft);
    if (squadSheet && !squadSheet.hidden && !squadBoundView.hidden) paintSquadHub();
  });

  /* Unlocking an honor schedules one refresh (and therefore one idempotent mint) right after the
     race settles, so the serial is already on the shelf when Profile opens. Cache-only flushes
     leave the stats signature unchanged and schedule nothing. */
  const statsSignature = (): string =>
    `${myTiq()}/${profile.stats.games}/${profile.stats.wins}/${profile.stats.streak}/${profile.stats.best}`;
  let lastStats = statsSignature();
  let badgeRefreshTimer = 0;
  onChange(() => {
    const next = statsSignature();
    if (next === lastStats) return;
    lastStats = next;
    if (!BADGES.some((b) => isBadgeUnlocked(b.id) && !hasEditionClaim(b.id))) return;
    window.clearTimeout(badgeRefreshTimer);
    badgeRefreshTimer = window.setTimeout(() => { void refreshBadgeEditions(); }, 900);
  });

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
  /* the pin itself is the shortcut to the honor: scroll the shelf into place,
     pulse the equipped tile and name its archetype in the note below */
  document.getElementById('pf-equipped-badge')?.addEventListener('click', () => {
    const eq = equippedBadge();
    if (!eq) return;
    spotlightBadge(eq.id);
    impact('light');
  });
  document.getElementById('badge-equip')?.addEventListener('click', () => {
    if (!badgeDraft) return;
    if (!isBadgeUnlocked(badgeDraft)) {
      const setup: RaceSetup = { difficulty: menuState.difficulty, sizes: [...menuState.sizes] };
      impact('light');
      api.sheets.close();
      saveMenu({ mode: 'bot' });
      window.setTimeout(() => api.start(setup), motionReduced() ? 0 : 280);
      return;
    }
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
    teamPv.setPerspective({ local: 0, rival: 1, color: pieceColor() });
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

  /** Each side's colour family, read off the same perspective plan the race draws with. */
  const paintSwatches = () => {
    const ramps = perspectiveRamps(0, 1, pieceColor());
    customSwatch[0].style.setProperty('--tint', (ramps[0] ?? theme().ball.ramp).mid);
    customSwatch[1].style.setProperty('--tint', (ramps[1] ?? theme().ball.ramp).mid);
    paintCustomPv();                    // the preview itself follows the same perspective
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

  /* ---- piece colour: the client-side red/blue perspective -----------------
     This is a save preference, never a rule: the race still seats, turns and scores
     exactly the same, only the two families this screen paints are swapped. */
  const pcolorKeys = [...document.querySelectorAll<HTMLButtonElement>('[data-pcolor]')];
  const paintPieceColor = () => {
    for (const key of pcolorKeys) key.setAttribute('aria-pressed', String(key.dataset.pcolor === pieceColor()));
  };
  for (const key of pcolorKeys) {
    key.addEventListener('click', () => {
      if (setPieceColor((key.dataset.pcolor === 'blue' ? 'blue' : 'red') as PieceColor)) impact('light');
      paintPieceColor();
    });
  }
  onChange(paintPieceColor);
  paintPieceColor();

  /* ---- settings overhaul: language drawer + community/admin rows ---- */

  const paintI18n = () => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
      const key = el.dataset.i18n;
      if (!key) continue;
      el.textContent = t(key);
    }
    for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-html]')) {
      const key = el.dataset.i18nHtml;
      if (!key) continue;
      el.innerHTML = t(key);
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
  const paintLangLive = () => {
    paintLang();
    paintSquadPill();
    if (!pfScreen.hidden) paintProfile();
  };
  onLang(paintLangLive);
  window.addEventListener('detour:lang', paintLangLive);
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
  const openHelp = (): void => {
    const sheet = api.sheet('sheet-help');
    if (sheet) { impact('light'); api.sheets.open(sheet); }
  };
  $('help-btn').addEventListener('click', openHelp);
  /* Settings carries the rules sheet now: the old modes screen has no route, and the lesson
     must stay one explicit tap away without a launch popup. */
  document.getElementById('set-help')?.addEventListener('click', openHelp);

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
      if (id === 'profile') {
        paintProfile();                           // the equipped row is only laid out once it is showing
        void refreshBadgeEditions();              // cached serials paint now; the ledger refreshes behind them
      }
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

/* ---------------------------------------------------------------------------
   ENLIST SQUAD — the Channel War registration door.

   A centered luxury-glass modal (deliberately not a sheet: this is a
   commitment, not a browse) opened by Home's channel-admin pod. It normalises
   whatever the admin pastes — a `t.me` link, a typed `@name` or the bare
   username — enforces Telegram's 4–32 character shape live, and resolves the
   handle through the Worker's `getChat` door on blur or on the enlist key. The
   plate only turns green with the community's real title and photo once
   Telegram has confirmed it.

   Enlisting is one server write. The Worker re-verifies the chat, refuses a
   type that does not match the selected tab, refuses a chat already on the
   registry (under a per-handle reservation), then stores the row; the client
   only claims the returned squad for this device. The modal then lifts and
   announces `detour:squad-enlisted`, so the lobby opens on the new squad's
   dashboard instead of leaving the player on Home.

   Bound once, on first open: the modal is a singleton in the markup, so every
   listener below is attached exactly once for the life of the app.
   --------------------------------------------------------------------------- */
interface EnlistModal { open(): void }

let enlistModal: EnlistModal | null = null;

export function openEnlistSquad(): void {
  if (!enlistModal) enlistModal = createEnlistModal();
  enlistModal?.open();
}

function createEnlistModal(): EnlistModal | null {
  const modalRoot = document.getElementById('enlist-modal');
  const scrimRoot = document.getElementById('enlist-scrim');
  if (!modalRoot || !scrimRoot) return null;
  /* re-bound as non-null so the listeners below close over a settled element */
  const modal: HTMLElement = modalRoot;
  const scrim: HTMLElement = scrimRoot;

  const input = $<HTMLInputElement>('enlist-input');
  const field = $<HTMLElement>('enlist-field');
  const err = $<HTMLElement>('enlist-err');
  const previewEl = $<HTMLElement>('enlist-preview');
  const pvTitle = $<HTMLElement>('enlist-pv-title');
  const pvHandle = $<HTMLElement>('enlist-pv-h');
  const pvMeta = $<HTMLElement>('enlist-pv-meta');
  const readyEl = $<HTMLElement>('enlist-ready');
  const readyLabel = $<HTMLElement>('enlist-ready-t');
  const avMono = $<HTMLElement>('enlist-av-mono');
  const avImg = $<HTMLImageElement>('enlist-av-img');
  const submit = $<HTMLButtonElement>('enlist-submit');
  const spin = $<HTMLElement>('enlist-spin');
  const verifySpin = $<HTMLElement>('enlist-verify-spin');
  const countEl = $<HTMLElement>('enlist-count');
  const ctaLabel = $<HTMLElement>('enlist-cta-t');
  const closeBtn = $<HTMLButtonElement>('enlist-close');
  const kindBtns = [...modal.querySelectorAll<HTMLElement>('[data-enlist-kind]')];

  /* A full t.me link is folded down the instant it lands. Only a single path
     segment is accepted: an invite link (`t.me/joinchat/…`, `t.me/+hash`) or a
     message link can never be mistaken for a username. The tail needs at least
     one character, so typing `t.me/` is never a match — the field can not be
     wiped out from under someone who is halfway through a link. */
  const LINK = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([A-Za-z0-9_]{1,32})\/?$/i;
  const MAX_HANDLE = HANDLE_MAX;

  type Phase = 'verify' | 'register' | null;

  let kind: SquadKind = 'channel';
  let isOpen = false;
  let phase: Phase = null;
  let touched = false;
  let closeTimer = 0;
  let restore: HTMLElement | null = null;
  let lastAvatar = '';
  let preview: SquadChatPreview | null = null;
  let previewKey = '';
  let verifyTicket = 0;
  let verifyJob: { key: string; promise: Promise<boolean> } | null = null;
  let errorCode = '';
  let errorKind: SquadKind | undefined;
  let errorFallback = '';

  const handleOf = (): string => cleanChatReference(input.value);
  const keyOf = (): string => `${kind}:${handleOf().toLowerCase()}`;

  /* The sigil lives in the pod, so the field only ever holds the bare username:
     a pasted link or a typed `@` is folded down the moment it arrives, with the
     caret put back where the typing actually was. Case is never touched — the
     capitals in `computerScience55` are part of the handle Telegram issued. */
  function normalise(): void {
    const raw = input.value;
    if (!raw) return;
    const bare = raw.trim().split(/[?#]/)[0].replace(/\/+$/, '');
    const link = LINK.exec(bare);
    const next = (link ? link[1] : raw.trim()).replace(/^@+/, '').replace(/\s+/g, '');
    if (next === raw) return;
    const caret = link
      ? next.length
      : Math.max(0, (input.selectionStart ?? raw.length) - (raw.length - next.length));
    input.value = next;
    try { input.setSelectionRange(caret, caret); } catch { /* not focused yet */ }
  }

  /* The photo is a bonus, never the crest: the monogram is already painted
     underneath, and the CDN answers private communities with a 404 or a 1x1
     placeholder — both of which must leave the monogram showing. */
  function paintAvatar(handle: string): void {
    if (handle === lastAvatar) return;
    lastAvatar = handle;
    avMono.textContent = handle.slice(1, 2).toUpperCase() || '?';
    avImg.hidden = true;
    avImg.onload = () => {
      avImg.hidden = avImg.naturalWidth <= 2 || avImg.naturalHeight <= 2;
    };
    avImg.onerror = () => { avImg.hidden = true; };
    const url = telegramAvatarUrl(handle);
    if (url) avImg.src = url;
    else avImg.removeAttribute('src');
  }

  const membersLabel = (n: number): string => {
    const count = n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
    return t('enlistMembers').replace('{n}', count);
  };

  function errorText(): string {
    if (errorCode === 'local:empty') return t('enlistErrHandle');
    if (errorCode === 'local:short') return t('enlistErrShort');
    if (errorCode === 'local:long') return t('enlistErrLong');
    if (errorCode === 'local:chars') return t('enlistErrChars');
    if (!errorCode) return '';
    return squadErrorMessage(errorCode, errorKind, errorFallback);
  }

  function showError(code: string, fallback = '', actual: SquadKind | undefined = undefined, shake = true): void {
    errorCode = code;
    errorKind = actual;
    errorFallback = fallback;
    err.textContent = errorText();
    err.hidden = false;
    field.classList.add('is-bad');
    input.setAttribute('aria-invalid', 'true');
    if (!shake) return;
    field.classList.remove('is-shake');
    void field.offsetWidth;
    field.classList.add('is-shake');
  }

  function clearError(): void {
    errorCode = '';
    errorKind = undefined;
    errorFallback = '';
    err.hidden = true;
    err.textContent = '';
    field.classList.remove('is-bad');
    input.setAttribute('aria-invalid', 'false');
  }

  function showIssue(issue: ReturnType<typeof handleIssue>, shake = true): void {
    if (issue === 'empty') { showError('local:empty', '', undefined, shake); return; }
    if (issue === 'short') { showError('local:short', '', undefined, shake); return; }
    if (issue === 'long') { showError('local:long', '', undefined, shake); return; }
    showError('local:chars', '', undefined, shake);
  }

  function paint(): void {
    const issue = handleIssue(input.value);
    const valid = issue === '';
    const key = keyOf();
    const verified = valid && preview !== null && previewKey === key ? preview : null;
    const bad = !!errorCode || (touched && !!input.value && !valid);

    field.classList.toggle('is-valid', valid && !errorCode);
    field.classList.toggle('is-verified', !!verified && !errorCode);
    field.classList.toggle('is-bad', bad);
    input.setAttribute('aria-invalid', bad ? 'true' : 'false');

    const length = input.value.replace(/^@+/, '').length;
    countEl.hidden = length === 0;
    countEl.textContent = `${length}/${MAX_HANDLE}`;

    if (valid && verified) {
      pvHandle.textContent = verified.handle;
      pvTitle.textContent = verified.name;
      pvMeta.hidden = verified.members <= 0;
      if (verified.members > 0) pvMeta.textContent = membersLabel(verified.members);
      readyLabel.textContent = t('enlistVerified');
      readyEl.classList.add('is-verified');
      paintAvatar(verified.handle);
    } else {
      readyLabel.textContent = t('enlistReady');
      readyEl.classList.remove('is-verified');
    }
    previewEl.hidden = !verified || !!errorCode;
    submit.setAttribute('aria-disabled', valid && !phase ? 'false' : 'true');
    if (!phase) ctaLabel.textContent = t('enlistCta');
  }

  function setPhase(next: Phase): void {
    phase = next;
    input.readOnly = next !== null;
    /* Both phases are waits, so both put a spinner on the key itself: the field's
       tick/spin is a second cue, never the only one. */
    verifySpin.hidden = next !== 'verify';
    spin.hidden = next === null;
    submit.classList.toggle('is-busy', next !== null);
    submit.setAttribute('aria-busy', next === null ? 'false' : 'true');
    submit.setAttribute('aria-disabled', next !== null || handleIssue(input.value) !== '' ? 'true' : 'false');
    ctaLabel.textContent = next === 'verify' ? t('enlistVerifying') : next === 'register' ? t('enlistCtaBusy') : t('enlistCta');
  }

  /** Resolve the current handle with the Worker. One in-flight job per handle+tab. */
  function verifyCurrent(): Promise<boolean> {
    const handle = handleOf();
    const issue = handleIssue(input.value);
    if (!handle || issue) {
      touched = true;
      showIssue(issue);
      paint();
      return Promise.resolve(false);
    }
    const key = keyOf();
    if (preview && previewKey === key) return Promise.resolve(true);
    if (verifyJob && verifyJob.key === key) return verifyJob.promise;

    const ticket = ++verifyTicket;
    const requestedKind = kind;
    clearError();
    setPhase('verify');
    paint();

    const promise = (async (): Promise<boolean> => {
      let result: SquadVerifyResult;
      try {
        result = await verifySquadChat(handle, requestedKind);
      } catch (err) {
        /* The server's own refusal already logged itself in `squadRegister`; this is the
           client-side throw (a rejected fetch, a broken JSON path) and names the handle. */
        console.error('[Squad Verification Failed]', err);
        result = { ok: false, code: 'offline', message: t('enlistErrOffline') };
      }
      if (!isOpen || ticket !== verifyTicket) return false;
      setPhase(null);
      if (keyOf() !== key) { paint(); return false; }
      if (!result.ok) {
        /* The exact payload behind the friendly sentence, for DevTools. */
        console.error('[Squad Verification Failed]', {
          code: result.code,
          status: result.status,
          detail: result.detail,
          message: result.message,
          handle,
          kind: requestedKind,
        });
        preview = null;
        previewKey = '';
        showError(result.code, result.message, result.kind);
        paint();
        notify('error');
        return false;
      }
      preview = result.chat;
      previewKey = key;
      clearError();
      paint();
      notify('success');
      impact('light');
      return true;
    })();
    verifyJob = { key, promise };
    void promise.then(() => {
      if (verifyJob?.promise === promise) verifyJob = null;
    });
    return promise;
  }

  /** The one write: the Worker re-verifies, then stores the squad under a duplicate lock. */
  async function finishEnlist(): Promise<void> {
    if (phase === 'register') return;
    const handle = handleOf();
    if (!handle) return;
    setPhase('register');
    impact('medium');
    const result = await registerSquadWithTelegram(handle, { name: '', tag: '' }, kind);
    if (!isOpen) return;
    setPhase(null);
    if (!result.ok || !result.squad) {
      notify('error');
      impact('light');
      showError(result.error ?? 'failed', result.message);
      paint();
      return;
    }

    const squad = result.squad;
    input.value = '';
    touched = false;
    clearError();
    preview = null;
    previewKey = '';
    restore = null;                 // the squad hub takes focus, not Home's pod
    notify('success');
    close();
    /* The veil lifts first, then the lobby takes over: the squad hub rises on
       the community that was just registered while the confirmation lands on
       top of it. A toast behind a fading scrim reads as a glitch. */
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('detour:squad-enlisted', {
        detail: { id: squad.id, handle: squad.handle },
      }));
      showToast(t('enlistToast'), 'success');
    }, motionReduced() ? 0 : 200);
  }

  async function submitNow(): Promise<void> {
    if (phase === 'register') return;
    /* The tap that follows a blur finds the verification already in flight;
       wait for it instead of dropping the enlistment on the floor. */
    if (phase === 'verify') {
      const job = verifyJob;
      if (!job || job.key !== keyOf()) return;
      const verified = await job.promise;
      if (!verified || !isOpen) return;
      await finishEnlist();
      return;
    }
    const issue = handleIssue(input.value);
    if (issue) {
      touched = true;
      showIssue(issue);
      paint();
      input.focus({ preventScroll: true });
      notify('warning');
      return;
    }
    const ok = await verifyCurrent();
    if (!ok || !isOpen) return;
    await finishEnlist();
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    verifyTicket++;
    verifyJob = null;
    phase = null;
    input.readOnly = false;
    verifySpin.hidden = true;
    spin.hidden = true;
    submit.classList.remove('is-busy');
    submit.setAttribute('aria-busy', 'false');
    modal.classList.remove('is-open');
    scrim.classList.remove('is-open');
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      modal.hidden = true;
      scrim.hidden = true;
      lastAvatar = '';
      const back = restore;
      restore = null;
      try { back?.focus({ preventScroll: true }); } catch { /* gone already */ }
    }, motionReduced() ? 0 : 200);
  }

  function show(): void {
    window.clearTimeout(closeTimer);
    restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    isOpen = true;
    touched = false;
    phase = null;
    verifyTicket++;
    verifyJob = null;
    preview = null;
    previewKey = '';
    input.value = '';
    input.readOnly = false;
    clearError();
    submit.classList.remove('is-busy');
    submit.setAttribute('aria-busy', 'false');
    spin.hidden = true;
    verifySpin.hidden = true;
    ctaLabel.textContent = t('enlistCta');
    input.setAttribute('aria-label', t('enlistPlaceholder').replace(/_/g, ' '));
    modal.hidden = false;
    scrim.hidden = false;
    void modal.offsetWidth;                 // lay the panel out at its closed scale first
    modal.classList.add('is-open');
    scrim.classList.add('is-open');
    paint();
    impact('light');
    window.setTimeout(() => {
      if (isOpen) input.focus({ preventScroll: true });
    }, motionReduced() ? 0 : 170);
  }

  input.addEventListener('input', () => {
    if (phase) return;
    touched = false;
    /* Every keystroke re-judges the field from scratch, so a corrected character —
       a capital letter included — clears the red state on that same keystroke. */
    clearError();
    normalise();
    const issue = handleIssue(input.value);
    if (issue === 'chars' || issue === 'long') {
      showError(issue === 'long' ? 'local:long' : 'local:chars', '', undefined, false);
    }
    if (previewKey && previewKey !== keyOf()) {
      preview = null;
      previewKey = '';
    }
    paint();
  });
  input.addEventListener('blur', () => {
    if (!isOpen || phase) return;
    const value = input.value.trim();
    if (!value) return;
    touched = true;
    const issue = handleIssue(value);
    if (issue) {
      showIssue(issue);
      paint();
      return;
    }
    void verifyCurrent();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void submitNow();
  });

  for (const btn of kindBtns) {
    btn.addEventListener('click', () => {
      const next: SquadKind = btn.dataset.enlistKind === 'group' ? 'group' : 'channel';
      if (next === kind || phase === 'register') return;
      kind = next;
      for (const other of kindBtns) {
        const on = other === btn;
        other.classList.toggle('is-on', on);
        other.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      preview = null;
      previewKey = '';
      if (phase === 'verify') {
        verifyTicket++;
        verifyJob = null;
        setPhase(null);
      }
      clearError();
      paint();
      impact('light');
      if (isOpen && handleIssue(input.value) === '') void verifyCurrent();
    });
  }

  submit.addEventListener('click', () => { void submitNow(); });
  closeBtn.addEventListener('click', () => { impact('light'); close(); });
  scrim.addEventListener('click', () => { impact('light'); close(); });
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (!isOpen || e.key !== 'Escape') return;
    e.preventDefault();
    close();
  });

  /* The chassis is translated in place: `data-i18n` covers the static labels,
     and every string this controller owns is re-read here. */
  window.addEventListener('detour:lang', () => {
    if (!isOpen) return;
    input.setAttribute('aria-label', t('enlistPlaceholder').replace(/_/g, ' '));
    if (errorCode) err.textContent = errorText();
    setPhase(phase);
    paint();
  });

  return { open: show };
}
