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
  DISPLAY_NAME_MAX, DISPLAY_NAME_MIN, DOB_MIN_YEAR, dobMaxYear, dobValue,
  IDENTITY_REWARD, joinTeam, leaveTeam, levelInfo, myTeam, onChange, pieceColor, profile,
  REFERRAL_REWARD, setBadge, setDisplayName, setDob, setFrame, setPieceColor, theme, validDob,
} from './storage';
import {
  BADGES, badgeCrestHtml, badgeDelta, badgeEdition, badgeHolders, badgeProgress, badgeProgressText,
  badgeStatus, badgeText, claimMintedAt, editionSerialLabel, editionSpeech, editionSyncState,
  equippedBadge, hasEditionClaim, isBadgeUnlocked, onEditionChange, refreshBadgeEditions, unlockedCount,
  type BadgeDef, type EditionHolder, type WornEdition,
} from './badges';
import { MAX_BALLS, newGame } from './rules';
import { createRenderer, type View } from './render';
import { setBalance } from './coin';
import { nameOf } from './countries';
import { openCountryPicker } from './countrypick';
import { flagPhoto } from './flags';
import { cleanCode, standings, YOU } from './teams';
import {
  bindSquad, cleanChatReference, cleanHandle, displayNameOf, getSquadAdminState, handleIssue,
  HANDLE_MAX, getMySquad, getSquadRanking, isSquadAdmin, leaveSquad, myPlayerId, mySquadRole,
  onSquadChange, searchSquads, squadInviteUrl, squadKind, squadLetter, squadMark,
  squadRequiresApproval, telegramAvatarUrl, type RankedSquad, type SquadApplicant, type SquadKind,
} from './squads';
import {
  arrangeRoster, buildSquadRoster,
  type SquadMember, type SquadRole, type SquadRoster,
} from './squadRoster';
import { showToast } from './toast';
import {
  decideSquadRequest, fetchSquad, joinSquadOnServer, kickSquadMember, leaveSquadOnServer,
  refreshSquadBoard, refreshMySquad, refreshSquadRequests, registerSquadWithTelegram,
  sendSquadBroadcast, setSquadApprovalOnServer, squadErrorMessage, syncSquadScore, verifySquadChat,
  type RequestDecision, type SquadChatPreview, type SquadVerifyResult,
} from './squadRegister';
import { copyText } from './gamemodes';
import { myTiq } from './matchmaking';
import { openSeize, relicShelter, seizeTargetOf } from './seize';
import { refreshReferral, referralCode, referralLink, referralShareUrl } from './referral';
import { playReward } from './sound';
import { perspectiveRamps, type PieceColor } from './themes';
import { isTicketCategory, submitTicket } from './support';
import type { Router } from './router';
import type { Sheets } from './sheets';
import { BOT_HANDLE, impact, notify, openTelegramShare, startParam, tgUser } from './telegram';
import { CHANNEL_URL, telegramShareLink } from '../shared/config';

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
  /**
   * The pre-lesson language gate a first-time invitee sees. The callback runs ONCE, after the
   * choice has been applied and the gate has closed; main.ts starts the untouched lesson there.
   */
  openLanguagePicker(onPick: (code: LangCode) => void): void;
  /** Lift the gate without a choice (a late hydrate can prove this is not a first launch). */
  closeLanguagePicker(): void;
  /** Is the gate still on screen? A late hydrate only hands over an invite it actually covers. */
  isLanguagePickerOpen(): boolean;
}

/** A race to start: how sharp the opponent is and how many balls each side fields. */
export interface RaceSetup { difficulty: Difficulty; sizes: [number, number] }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const en = (n: number) => n.toLocaleString('en-US');

/** Installed by the menu while it can answer a back step; main.ts unwinds through it. */
let ownersBackStep: (() => boolean) | null = null;

/** True when the Hall of Owners was open and has been handed back to its collector card. */
export function ownersBack(): boolean {
  return ownersBackStep?.() === true;
}

/** Installed by the menu once it owns the collector card, so another sheet can hand it a relic. */
let relicOpenStep: ((id: string, returnTo: () => void) => void) | null = null;

/**
 * Open one honor's collector card from outside the menu, and call `returnTo` when the card is
 * dismissed. The sheet manager holds a single panel, so a card reached from a dossier has to be
 * handed back to it rather than unwound to the ladder behind it.
 */
export function openRelicCard(id: string, returnTo: () => void): void {
  relicOpenStep?.(id, returnTo);
}
/** A chip has ~80px on the narrowest phone: 46,794 subscribers reads as 46.8K. */
const compact = (n: number): string => {
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return en(n);
};

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
  const squadTools = $<HTMLElement>('squad-tools');
  const squadCountEl = $<HTMLElement>('squad-roster-count');
  const squadRosterEmpty = $<HTMLElement>('squad-roster-empty');
  const squadCrest = $<HTMLElement>('squad-view-crest');
  const squadCrestFrame = $<HTMLElement>('squad-view-frame');
  const squadCrestPhoto = $<HTMLImageElement>('squad-view-photo');
  const squadCrestBadge = $<HTMLElement>('squad-view-badge');
  const squadKindBadge = $<HTMLElement>('squad-view-kind');
  const squadTotalEl = $<HTMLElement>('squad-view-total');
  const squadExploreBtn = $<HTMLButtonElement>('squad-explore');
  const squadExploreT = $<HTMLElement>('squad-explore-t');
  const squadExploreIco = $<HTMLElement>('squad-explore-ico');
  const squadLeaveBtn = $<HTMLButtonElement>('squad-leave');
  const squadSubsEl = $<HTMLElement>('squad-view-subs');
  const squadAdminEl = $<HTMLElement>('squad-admin');
  const squadInviteCopy = $<HTMLButtonElement>('squad-invite-copy');
  const squadInviteCopyT = $<HTMLElement>('squad-invite-copy-t');
  const squadInviteShare = $<HTMLButtonElement>('squad-invite-share');

  /* Leader administration. These surfaces stay `hidden` until a leader's role is proven, so a
     regular member's DOM never exposes a control they cannot use. */
  const squadAdminPanel = $<HTMLElement>('squad-admin-panel');
  const squadApprovalToggle = $<HTMLButtonElement>('squad-approval-toggle');
  const squadBroadcastBtn = $<HTMLButtonElement>('squad-broadcast-btn');
  const squadTabs = $<HTMLElement>('squad-tabs');
  const squadTabMembers = $<HTMLButtonElement>('squad-tab-members');
  const squadTabRequests = $<HTMLButtonElement>('squad-tab-requests');
  const squadTabMembersN = $<HTMLElement>('squad-tab-members-n');
  const squadTabRequestsN = $<HTMLElement>('squad-tab-requests-n');
  const squadRosterTitleRow = $<HTMLElement>('squad-roster-title-row');
  const squadRequestsEl = $<HTMLOListElement>('squad-requests');
  const squadRequestsEmpty = $<HTMLElement>('squad-requests-empty');
  const squadCastDrawer = $<HTMLElement>('squad-broadcast-drawer');
  const squadCastScrim = $<HTMLElement>('squad-broadcast-scrim');
  const squadCastText = $<HTMLTextAreaElement>('squad-broadcast-text');
  const squadCastCount = $<HTMLElement>('squad-broadcast-count');
  const squadCastSend = $<HTMLButtonElement>('squad-broadcast-send');
  const squadCastClose = $<HTMLButtonElement>('squad-broadcast-close');
  const squadCastCancel = $<HTMLButtonElement>('squad-broadcast-cancel');

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
  /** True while the bound squad's leader is looking at the hub: the kick keys ride this flag. */
  let squadAdmin = false;
  let squadCopiedTimer = 0;
  let squadKickBusy = '';
  /** Only the player wearing the LEADER pill gets the lock, the requests tab and the megaphone. */
  let squadLeader = false;
  let squadTab: 'members' | 'requests' = 'members';
  let squadRequests: SquadApplicant[] = [];
  let squadSearchable = false;
  let squadApprovalBusy = false;
  let squadDecisionBusy = '';
  let squadCastBusy = false;
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
    av.setAttribute('aria-hidden', 'true');
    av.textContent = member.initials;
    /* Real Telegram portrait over the monogram. A blocked, broken or 1x1 frame is dropped so
       the crisp initials stay; the country flag rides the container either way. */
    if (member.photo) {
      const img = document.createElement('img');
      img.className = 'sq-av-photo';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      const drop = () => img.remove();
      img.addEventListener('error', drop, { once: true });
      img.addEventListener('load', () => {
        if (img.naturalWidth <= 2 || img.naturalHeight <= 2) { drop(); return; }
        av.classList.add('has-photo');
      }, { once: true });
      img.src = member.photo;
      av.append(img);
    }
    wrap.append(av, flagPhoto(member.country, 'sq-av-flag'));
    if (member.medal) wrap.append(squadMedalPin(member.medal, 'sq-medal'));
    return wrap;
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
    if (member.isYou) {
      const you = document.createElement('span');
      you.className = 'sq-you-tag';
      you.textContent = t('you');
      nameLine.append(you);
    }
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

    /* The leader's one per-row action: remove a player who is not the founder. It only exists
       for an admin, and it is never drawn on the admin's own row. */
    if (squadAdmin && !member.isYou && member.role !== 'leader') {
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'sq-kick';
      kick.dataset.kick = member.id;
      kick.setAttribute('aria-label', `${t('kickMember')} · ${member.name || t('member')}`);
      kick.title = t('kickMember');
      kick.append(squadSvg('#i-close'));
      if (squadKickBusy === member.id) {
        kick.classList.add('is-busy');
        kick.setAttribute('aria-busy', 'true');
      }
      kick.addEventListener('click', (e) => {
        e.stopPropagation();
        void kickSquadRow(member.id);
      });
      right.append(kick);
    }

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
    /* A roster smaller than six has nothing worth filtering: the field stays out of the way
       (and any stale query is cleared) until the list actually grows. */
    const canSearch = roster.count >= 6;
    if (!canSearch && squadQuery) {
      squadQuery = '';
      squadMemberQ.value = '';
    }
    squadSearchable = canSearch;
    squadRows = arrangeRoster(roster, 'tiq', squadQuery);
    const filtered = squadQuery.trim().length > 0;
    const membersWord = roster.count === 1 ? 'member' : 'members';
    squadCountEl.textContent = en(squadRows.length);
    squadCountEl.setAttribute('aria-label', filtered
      ? `${en(squadRows.length)} of ${en(roster.count)} ${membersWord} shown`
      : `${en(roster.count)} ${membersWord}`);
    squadRosterEl.setAttribute('aria-label', 'Squad members sorted by TIQ');

    const pitch = measureSquadPitch();
    squadRosterEl.style.height = `${Math.max(0, squadRows.length * pitch - squadGap)}px`;
    squadRosterEl.textContent = '';
    squadRowEls.clear();
    squadRange = { start: -1, end: -1, rows: -1 };
    scheduleSquadWindow(true);
    applySquadTabVisibility();
  }

  /* ---------- leader administration: lock, requests tab, broadcast composer ----------
     `squadLeader` is the only door. Every one of these surfaces stays hidden for a regular
     member, and the visibility of all four lists is owned by one function so the segmented
     tabs can never paint two lists at once. */

  function applySquadTabVisibility(): void {
    const onRequests = squadLeader && squadTab === 'requests';
    squadRosterEl.hidden = onRequests || squadRows.length === 0;
    squadRosterEmpty.hidden = onRequests || squadRows.length > 0;
    squadTools.hidden = onRequests || !squadSearchable;
    squadRequestsEl.hidden = !onRequests || squadRequests.length === 0;
    squadRequestsEmpty.hidden = !onRequests || squadRequests.length > 0;
  }

  /** Telegram portrait over initials, exactly as the roster rows do it. */
  function squadApplicantAvatar(a: SquadApplicant): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'sq-req-av';
    wrap.setAttribute('aria-hidden', 'true');
    const label = (a.name || a.username || '?').trim();
    wrap.textContent = label.slice(0, 2).toUpperCase();
    if (a.photo && /^https:\/\/[^\s]+$/i.test(a.photo)) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.remove(), { once: true });
      img.addEventListener('load', () => {
        if (img.naturalWidth <= 2 || img.naturalHeight <= 2) img.remove();
      }, { once: true });
      img.src = a.photo;
      wrap.append(img);
    }
    return wrap;
  }

  function squadRequestRow(a: SquadApplicant): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'sq-req';
    const display = a.name || (a.username ? `@${a.username}` : t('member'));

    const identity = document.createElement('span');
    identity.className = 'sq-req-id';
    const name = document.createElement('span');
    name.className = 'sq-req-name';
    name.textContent = display;
    name.title = display;
    const score = document.createElement('span');
    score.className = 'sq-req-tiq';
    score.textContent = `${en(Math.max(0, Math.floor(a.tiq)))} TIQ`;
    identity.append(name, score);

    const actions = document.createElement('span');
    actions.className = 'sq-req-actions';
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'sq-req-btn yes';
    approve.textContent = '✓';
    approve.setAttribute('aria-label', `${t('squadApprove')} · ${display}`);
    approve.title = t('squadApprove');
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'sq-req-btn no';
    reject.textContent = '✕';
    reject.setAttribute('aria-label', `${t('squadReject')} · ${display}`);
    reject.title = t('squadReject');
    for (const el of [approve, reject]) {
      if (squadDecisionBusy === a.id) {
        el.setAttribute('aria-disabled', 'true');
        el.setAttribute('aria-busy', 'true');
      }
      actions.append(el);
    }
    approve.addEventListener('click', () => { void decideSquadApplicant(a.id, 'approve'); });
    reject.addEventListener('click', () => { void decideSquadApplicant(a.id, 'reject'); });

    li.append(squadApplicantAvatar(a), identity, actions);
    return li;
  }

  function paintSquadRequests(): void {
    squadRequestsEl.textContent = '';
    for (const a of squadRequests) squadRequestsEl.append(squadRequestRow(a));
  }

  function paintSquadTabs(): void {
    squadAdminPanel.hidden = !squadLeader;
    squadTabs.hidden = !squadLeader;
    squadRosterTitleRow.hidden = squadLeader;
    if (!squadLeader) squadTab = 'members';
    const onRequests = squadLeader && squadTab === 'requests';
    squadTabMembers.classList.toggle('is-active', !onRequests);
    squadTabRequests.classList.toggle('is-active', onRequests);
    squadTabMembers.setAttribute('aria-selected', String(!onRequests));
    squadTabRequests.setAttribute('aria-selected', String(onRequests));
    squadTabMembers.tabIndex = onRequests ? -1 : 0;
    squadTabRequests.tabIndex = squadLeader && onRequests ? 0 : -1;
    squadTabMembersN.textContent = en(squadView?.count ?? 0);
    squadTabRequestsN.textContent = en(squadRequests.length);
    /* The amber/red counter only exists when somebody is actually waiting. */
    squadTabRequestsN.hidden = squadRequests.length === 0;
    squadRequestsEl.setAttribute('aria-label', `${t('squadPendingRequests')} · ${en(squadRequests.length)}`);
    applySquadTabVisibility();
  }

  function setSquadTab(next: 'members' | 'requests'): void {
    if (!squadLeader || squadTab === next) return;
    squadTab = next;
    impact('light');
    paintSquadTabs();
    if (squadTab === 'members') paintSquadRoster();
    else paintSquadRequests();
    squadScroll.scrollTop = 0;
  }

  async function decideSquadApplicant(applicantId: string, decision: RequestDecision): Promise<void> {
    const me = getMySquad();
    if (!me || !squadLeader || squadDecisionBusy) return;
    squadDecisionBusy = applicantId;
    paintSquadRequests();
    const result = await decideSquadRequest(me.id, applicantId, decision);
    squadDecisionBusy = '';
    squadRequests = getSquadAdminState(me.id).requests;
    if (!result.ok) {
      notify('warning');
      showToast(result.message || t('enlistErrOffline'), 'warning');
    } else {
      notify('success');
      impact('medium');
      showToast(t(decision === 'approve' ? 'squadApproved' : 'squadRejected'), 'success');
    }
    /* Approval adds a real roster row: rebuild the whole hub so the member count and the
       tab's own counter move together. */
    const fresh = getMySquad();
    if (fresh) {
      squadView = buildSquadRoster(fresh);
      paintSquadRoster();
      paintSquadRequests();
      paintSquadTabs();
      $<HTMLElement>('squad-view-members').textContent = en(squadView.count);
      squadTotalEl.textContent = en(squadView.totalTiq);
    }
  }

  /* The composer is a drawer within the sheet, so it never enters the sheets singleton. */
  function updateSquadCastCount(): void {
    squadCastCount.textContent = t('squadBroadcastChars').replace('{n}', en(squadCastText.value.length));
  }

  function openSquadCast(): void {
    if (!squadLeader || squadCastBusy) return;
    squadCastText.value = '';
    updateSquadCastCount();
    squadCastDrawer.hidden = false;
    impact('light');
    requestAnimationFrame(() => { try { squadCastText.focus({ preventScroll: true }); } catch { /* headless */ } });
  }

  function closeSquadCast(): void {
    squadCastDrawer.hidden = true;
    try { squadBroadcastBtn.focus({ preventScroll: true }); } catch { /* headless */ }
  }

  async function submitSquadCast(): Promise<void> {
    const me = getMySquad();
    if (!me || !squadLeader || squadCastBusy) return;
    const text = squadCastText.value.trim();
    if (!text) {
      notify('warning');
      showToast(t('squadBroadcastEmpty'), 'warning');
      squadCastText.focus();
      return;
    }
    squadCastBusy = true;
    squadCastSend.setAttribute('aria-busy', 'true');
    squadCastSend.setAttribute('aria-disabled', 'true');
    const result = await sendSquadBroadcast(me.id, text);
    squadCastBusy = false;
    squadCastSend.removeAttribute('aria-busy');
    squadCastSend.removeAttribute('aria-disabled');
    if (!result.ok) {
      notify('warning');
      showToast(result.message || t('squadBroadcastFailed'), 'warning');
      return;
    }
    closeSquadCast();
    notify('success');
    impact('medium');
    showToast(t('squadBroadcastSent'), 'success');
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

  /**
   * The leader's one invite row. It exists only for the player who can use it: the gold key hands
   * the `?startapp=squad_<id>` link to Telegram's own share sheet, the pill copies it. The hero
   * names no role: the captain's roster row already wears the LEADER pill.
   */
  function paintSquadAdmin(me: RankedSquad): void {
    squadAdmin = isSquadAdmin(me);
    /* The three management features belong to the LEADER alone. An officer keeps the invite
       row and the kick keys, but never sees the lock, the requests tab or the megaphone. */
    squadLeader = mySquadRole(me) === 'leader';
    squadAdminEl.hidden = !squadAdmin;
    squadApprovalToggle.setAttribute('aria-checked', String(getSquadAdminState(me.id).requireApproval));
    squadApprovalToggle.setAttribute('aria-label', `${t('squadRequireApproval')} · ${me.handle}`);
    if (!squadAdmin) return;
    const url = squadInviteUrl(me.id);
    squadInviteCopyT.textContent = t('copyLink');
    squadInviteCopy.classList.remove('is-copied');
    squadInviteCopy.setAttribute('aria-disabled', url ? 'false' : 'true');
    squadInviteShare.setAttribute('aria-disabled', url ? 'false' : 'true');
    squadInviteCopy.setAttribute('aria-label', `${t('copyLink')} · ${me.handle}`);
    squadInviteShare.setAttribute('aria-label', `${t('invitePlayers')} · ${me.handle}`);
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
    squadTotalEl.textContent = en(squadView.totalTiq);
    $<HTMLElement>('squad-view-members').textContent = en(squadView.count);
    /* A channel gets the compact check beside its handle; a group simply omits it. */
    const isChannel = squadKind(me) === 'channel';
    squadKindBadge.hidden = !isChannel;
    if (isChannel) {
      squadKindBadge.title = t('officialChannel');
      squadKindBadge.setAttribute('aria-label', t('officialChannel'));
    }
    /* The Telegram audience is a separate, clearly-labelled chip: it never counts as members.
       An unreported audience stays a quiet dash rather than collapsing the 3-up grid. */
    const subs = squadView.subscribers;
    squadSubsEl.textContent = subs > 0 ? compact(subs) : '—';
    squadSubsEl.title = subs > 0 ? `${en(subs)} ${t('subscribers')}` : t('subscribersNote');
    paintSquadAdmin(me);
    squadRequests = getSquadAdminState(me.id).requests;
    paintSquadRoster();
    paintSquadRequests();
    paintSquadTabs();
  }

  /**
   * Remove a member. The Worker owns the roster, so this only mirrors its answer — a local-only
   * removal would be a player the registry still counts.
   */
  async function kickSquadRow(memberId: string): Promise<void> {
    const me = getMySquad();
    if (!me || !squadAdmin || squadKickBusy) return;
    squadKickBusy = memberId;
    paintSquadRoster();
    const result = await kickSquadMember(me.id, memberId);
    squadKickBusy = '';
    if (!result.ok) {
      notify('warning');
      showToast(result.message || t('enlistErrOffline'), 'warning');
      paintSquadRoster();
      return;
    }
    notify('success');
    impact('medium');
    showToast(t('memberRemoved'), 'success');
    paintSquadHub();
  }

  /** Copy the squad's one invite link. The label confirms in place, then falls back. */
  function copySquadInvite(): void {
    const me = getMySquad();
    if (!me) return;
    const url = squadInviteUrl(me.id);
    if (!url) return;
    void copyText(url).then((ok) => {
      if (!ok) {
        notify('warning');
        showToast(t('linkCopyFailed'), 'warning');
        return;
      }
      notify('success');
      impact('light');
      squadInviteCopyT.textContent = t('linkCopied');
      squadInviteCopy.classList.add('is-copied');
      window.clearTimeout(squadCopiedTimer);        squadCopiedTimer = window.setTimeout(() => {
          squadInviteCopyT.textContent = t('copyLink');
          squadInviteCopy.classList.remove('is-copied');
        }, 1800);
      showToast(t('linkCopied'), 'success');
    });
  }

  /** The same link, through Telegram's own recipient picker. */
  function shareSquadInvite(): void {
    const me = getMySquad();
    if (!me) return;
    const url = squadInviteUrl(me.id);
    if (!url) return;
    impact('light');
    openTelegramShare(telegramShareLink(url, t('inviteShareText').replace('{squad}', me.name)));
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

  /** The squad's Squad IQ — the roster average the ranking already stores. */
  const squadPreviewAvg = (s: { trophies: number }): number =>
    Math.max(0, Math.floor(s.trophies));

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
    name.dir = 'auto';
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

    sqpMark.textContent = s ? squadMark(s) : squadLetter({ handle, name });
    sqpName.dir = 'auto';
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

    /* A locked squad never promises direct entry: the same key asks to join instead. */
    const locked = !!s && !previewJoined && squadRequiresApproval(s);
    sqpJoin.classList.toggle('is-joined', previewJoined);
    sqpJoinT.textContent = previewJoined
      ? t('openSquadHub')
      : locked ? t('squadRequestJoin') : t('joinSquad');
    sqpJoin.setAttribute('aria-label', previewJoined
      ? `${t('openSquadHub')} · ${handle}`
      : `${locked ? t('squadRequestJoin') : t('joinSquad')} · ${name}, ${handle}`);
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

  let previewJoining = false;

  async function commitPreviewJoin(): Promise<void> {
    if (!previewSquad && !previewHandle) return;
    if (previewSquad && getMySquad()?.id === previewSquad.id) {
      impact('light');
      if (!squadSheet) return;
      showSquadBound();
      api.sheets.open(squadSheet);
      requestAnimationFrame(() => scheduleSquadWindow(true));
      return;
    }

    /* A handle with no squad behind it is a local mint: there is nothing to join on the server
       yet, and the squad it creates starts with exactly one member — this player. */
    if (!previewSquad) {
      const created = bindSquad(previewHandle);
      if (created === 'bad-handle') {
        notify('warning');
        showToast(t('badChannel'), 'warning');
        return;
      }
      impact('medium');
      notify('success');
      showToast(`${displayNameOf(previewHandle)} joined · ${previewHandle}`, 'success');
      paintSquadPill();
      api.sheets.close();
      return;
    }

    if (previewJoining) return;
    previewJoining = true;
    sqpJoin.setAttribute('aria-busy', 'true');
    sqpJoin.classList.add('is-busy');
    sqpJoinT.textContent = t('joiningSquad');
    const result = await joinSquadOnServer(previewSquad.id);
    previewJoining = false;
    sqpJoin.removeAttribute('aria-busy');
    sqpJoin.classList.remove('is-busy');
    if (!result.ok) {
      paintSquadPreview();
      notify('warning');
      showToast(result.message || t('enlistErrOffline'), 'warning');
      return;
    }
    /* The squad is locked: the join became a request for the leader, so this player stays on
       the preview instead of landing on a roster they are not on. */
    if (result.pending) {
      paintSquadPreview();
      impact('light');
      notify('success');
      showToast(t('squadRequestSent'), 'success');
      return;
    }
    impact('medium');
    notify('success');
    const joined = result.squad ?? previewSquad;
    showToast(`${joined.name} joined · ${joined.handle}`, 'success');
    paintSquadPill();
    /* The preview swaps straight to the hub: one sheet at a time, and the player lands on the
       roster they just joined rather than back on the search field. */
    if (!squadSheet) { api.sheets.close(); return; }
    showSquadBound();
    api.sheets.open(squadSheet);
    requestAnimationFrame(() => scheduleSquadWindow(true));
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
    squadRequests = [];
    squadTab = 'members';
    squadLeader = false;
    squadCastDrawer.hidden = true;
    squadAdminPanel.hidden = true;
    squadTabs.hidden = true;
    squadQuery = '';
    squadMemberQ.value = '';
    resetSquadLeave();
    paintSquadList(squadQ.value);
    paintSquadExplore();
  }

  /**
   * Pull the roster the registry holds and repaint. The hub opens on the cached copy (instant,
   * offline-safe) and corrects itself a moment later — a join that happened on another phone, a
   * kick, a score that moved since launch.
   */
  function refreshSquadHub(): void {
    const me = getMySquad();
    if (!me) return;
    /* The registry is the cross-device copy of the leader's queue: a request filed on another
       phone must reach this leader's badge. The local queue already painted instantly. */
    if (squadLeader) {
      void refreshSquadRequests(me.id).then((rows) => {
        if (!squadSheet || squadSheet.hidden || squadBoundView.hidden || !squadLeader) return;
        squadRequests = rows;
        paintSquadRequests();
        paintSquadTabs();
      });
    }
    void refreshMySquad().then((fresh) => {
      if (!fresh) return;
      const id = myPlayerId();
      /* Removed from the roster while this device still had the squad bound: let it go rather
         than paint a squad the player is no longer on. */
      if (id && !fresh.roster.some((m) => m.id === id)) {
        leaveSquad();
        paintSquadPill();
        showSquadSearch();
        return;
      }
      paintSquadPill();
      if (!squadSheet || squadSheet.hidden || squadBoundView.hidden) return;
      paintSquadHub();
    });
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
    refreshSquadHub();
  }

  function openSquad() {
    if (!squadSheet) return;
    squadQ.value = '';
    squadQuery = '';
    squadMemberQ.value = '';
    squadCastDrawer.hidden = true;
    squadTab = 'members';
    const me = getMySquad();
    if (me) showSquadBound();
    else showSquadSearch();
    api.sheets.open(squadSheet);
    impact('light');
    requestAnimationFrame(() => scheduleSquadWindow(true));
    /* Discovery is the registry's board now: read it while the sheet slides, so the list the
       player is looking at is today's field rather than the last launch's. */
    if (!me) {
      void refreshSquadBoard().then(() => {
        if (!squadSheet || squadSheet.hidden || !squadBoundView.hidden) return;
        paintSquadList(squadQ.value);
      });
    }
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
      squadLeaveBtn.textContent = t('confirmLeave');
      squadLeaveBtn.setAttribute('aria-label', t('confirmLeaveAria'));
      squadLeaveTimer = window.setTimeout(resetSquadLeave, 4000);
      impact('light');
      return;
    }
    resetSquadLeave();
    const me = getMySquad();
    if (!me) { showSquadSearch(); return; }
    /* The Worker decides what a leader's exit means: the crown passes to the next member, or the
       squad disbands when they were the last one. This only mirrors the answer. */
    void leaveSquadOnServer(me.id).then((result) => {
      if (!result.ok) {
        notify('warning');
        showToast(result.message || t('enlistErrOffline'), 'warning');
        return;
      }
      impact('medium');
      paintSquadPill();
      showSquadSearch();
    });
  });
  squadInviteCopy.addEventListener('click', copySquadInvite);
  squadInviteShare.addEventListener('click', shareSquadInvite);

  /* ---- leader control wiring: every handler re-checks `squadLeader` before it acts ---- */
  squadApprovalToggle.addEventListener('click', () => {
    const me = getMySquad();
    if (!me || !squadLeader || squadApprovalBusy) return;
    const next = squadApprovalToggle.getAttribute('aria-checked') !== 'true';
    squadApprovalBusy = true;
    squadApprovalToggle.setAttribute('aria-busy', 'true');
    squadApprovalToggle.setAttribute('aria-checked', String(next));
    impact('light');
    /* The bridge writes locally before its first await, so the switch lands on the very frame
       the thumb lifts; a Worker refusal is the only thing that can put it back. */
    void setSquadApprovalOnServer(me.id, next).then((result) => {
      squadApprovalBusy = false;
      squadApprovalToggle.removeAttribute('aria-busy');
      const fresh = getMySquad();
      if (fresh) paintSquadAdmin(fresh);
      if (!result.ok) {
        notify('warning');
        showToast(result.message || t('enlistErrOffline'), 'warning');
        return;
      }
      notify('success');
      showToast(t(next ? 'squadLockOn' : 'squadLockOff'), 'success');
    });
  });
  squadTabMembers.addEventListener('click', () => setSquadTab('members'));
  squadTabRequests.addEventListener('click', () => setSquadTab('requests'));
  /* Roving tabindex needs the arrow keys to move between the two segments. */
  squadTabs.addEventListener('keydown', (e) => {
    if (!squadLeader || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    e.preventDefault();
    setSquadTab(squadTab === 'members' ? 'requests' : 'members');
    const focus = squadTab === 'members' ? squadTabMembers : squadTabRequests;
    try { focus.focus({ preventScroll: true }); } catch { /* headless */ }
  });
  squadBroadcastBtn.addEventListener('click', openSquadCast);
  squadCastClose.addEventListener('click', closeSquadCast);
  squadCastCancel.addEventListener('click', closeSquadCast);
  squadCastScrim.addEventListener('click', closeSquadCast);
  squadCastText.addEventListener('input', updateSquadCastCount);
  squadCastSend.addEventListener('click', () => { void submitSquadCast(); });
  /* Escape belongs to the drawer while it is open, not to the sheets singleton: capture it
     before the sheet's own keydown listener can dismiss the whole hub. */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || squadCastDrawer.hidden) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    closeSquadCast();
  }, true);
  /* A tap that dismisses the squad sheet must dismiss its composer with it, so reopening the
     hub never lands on a half-written announcement. */
  document.addEventListener('click', (e) => {
    if (squadCastDrawer.hidden) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.closest('[data-sheet-close]') || target.id === 'scrim')) {
      squadCastDrawer.hidden = true;
    }
  }, true);
  /* The static labels are swept by the global i18n pass; these are the strings this block
     paints itself, so a language switch has to rebuild them too. */
  window.addEventListener('detour:lang', () => {
    if (squadBoundView.hidden) return;
    const me = getMySquad();
    if (me) paintSquadAdmin(me);
    paintSquadRequests();
    paintSquadTabs();
    updateSquadCastCount();
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

  /**
   * A `?startapp=squad_<id>` invite. It resolves the squad (from this device's list, else the
   * registry) and opens its card: the invite is a prompt, and only the Join key puts the player on
   * the roster. A squad that is gone says so instead of opening an empty hub.
   */
  let squadInviteBusy = false;
  async function openSquadInvite(id: string): Promise<void> {
    if (!id || squadInviteBusy) return;
    squadInviteBusy = true;
    const known = getSquadRanking().find((s) => s.id === id);
    /* Read the registry first: an invite should show the roster as it is now, and fall back to
       the cached card when the Worker cannot answer. */
    const squad = await fetchSquad(id) ?? known;
    squadInviteBusy = false;
    if (!squad) {
      notify('warning');
      showToast(t('squadErrGone'), 'warning');
      return;
    }
    if (!squadSheet) return;
    openSquadPreview({ squad });
  }
  window.addEventListener('detour:squad-invite', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id ?? '';
    void openSquadInvite(id);
  });

  /* Launch sync: the registry's board fills the discovery list, and this player's own score is
     re-reported so their squad row always carries the TIQ their games earned. */
  void refreshSquadBoard().then(() => {
    paintSquadPill();
    if (squadSheet && !squadSheet.hidden) {
      if (!squadBoundView.hidden) paintSquadHub();
      else paintSquadList(squadQ.value);
    }
  });
  void syncSquadScore().then(() => paintSquadPill());

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

  /* Avatar frames for the hero slot: persisted as profile.frame (default | auric | neon). */
  const FRAMES: { id: string; name: string }[] = [
    { id: 'default', name: 'Default' },
    { id: 'auric', name: 'Auric' },
    { id: 'neon', name: 'Neon' },
  ];
  const frameName = (id: string | null): string =>
    FRAMES.find((f) => f.id === id)?.name ?? 'Default';

  /* TIQ is the only competitive reading: the league divisions were removed from the design,
     so nothing on this card names a band any more. */

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
    /* TIQ is the flagship stat: the number and the unit, with no league word beside it. */
    const tiq = myTiq();
    const tiqValue = document.getElementById('pf-tiq');
    if (tiqValue) tiqValue.textContent = en(tiq);
    const tiqPill = document.getElementById('pf-tiq-pill');
    if (tiqPill) {
      const label = `${en(tiq)} Tactical IQ`;
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
          `Equipped badge: ${eq.name}. ${editionSpeech(ed)} ${eq.archetype}, ${eq.pillar}. View its certificate.`,
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

  /** The multi-gate mission as compact proof chips: TIQ first, then the live-PvP run. */
  function paintRequirementChips(prog: ReturnType<typeof badgeProgress>): void {
    const wrap = document.getElementById('badge-req-chips');
    if (!wrap) return;
    wrap.textContent = '';
    const rows = prog.requirements ?? [];
    wrap.hidden = rows.length === 0;
    for (const row of rows) {
      const chip = document.createElement('span');
      chip.className = `bd-req-metric is-${row.kind}${row.met ? ' is-met' : ''}`;
      chip.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#${row.kind === 'tiq' ? 'i-brain' : 'i-swords'}" /></svg>`;
      const key = document.createElement('span');
      key.className = 'bd-req-metric-k';
      key.textContent = `${row.kind === 'tiq' ? t('badgeReqTiq') : t('badgeReqStreak')}:`;
      const value = document.createElement('b');
      value.className = 'bd-req-metric-v';
      value.dir = 'ltr';
      value.textContent = `${en(row.got)} / ${en(row.need)}`;
      chip.append(key, value);
      wrap.append(chip);
    }
  }

  /**
   * The owner's charter: privileges this honor grants while it is worn. The copy is data, not
   * markup, so the Singularity's three privileges never appear on a badge that does not carry
   * them. `{serial}` is stamped from the same ledger reading the plaque uses.
   */
  function paintBadgePrivileges(def: BadgeDef, unlocked: boolean): void {
    const section = document.getElementById('badge-privileges');
    const list = document.getElementById('badge-privilege-list');
    if (!section || !list) return;
    const rows = def.privileges ?? [];
    const show = unlocked && rows.length > 0;
    section.hidden = !show;
    list.replaceChildren();
    if (!show) return;
    const serial = badgeEdition(def.id).serial;
    const serialLabel = serial !== null ? editionSerialLabel(serial) : '—';
    for (const row of rows) {
      const li = document.createElement('li');
      li.className = 'bd-privilege';
      const well = document.createElement('span');
      well.className = 'bd-privilege-ico';
      well.setAttribute('aria-hidden', 'true');
      well.innerHTML = `<svg class="ico"><use href="#${row.icon}" /></svg>`;
      const copy = document.createElement('p');
      copy.className = 'bd-privilege-text';
      copy.textContent = badgeText(row.text, lang).split('{serial}').join(serialLabel);
      li.append(well, copy);
      list.append(li);
    }
  }

  function paintBadgeSheet(id: string): void {
    const def = BADGES.find((b) => b.id === id);
    const sheet = document.getElementById('sheet-badge');
    if (!def || !sheet) return;
    const unlocked = isBadgeUnlocked(id);
    const equipped = profile.badge === id;
    const prog = badgeProgress(id);
    const edition = badgeEdition(id);

    sheet.dataset.accent = def.accent;
    const title = document.getElementById('badge-title');
    if (title) title.textContent = def.name;

    const state = document.getElementById('badge-state');
    if (state) {
      state.removeAttribute('aria-label');
      if (!unlocked) {
        state.textContent = t('badgeLocked');
        state.dataset.state = 'locked';
      } else if (edition.serial !== null) {
        /* the engraved plaque: № 002 / 50 · LIMITED RELIC. The serial rides in its own LTR
           isolate, so a Persian sheet can never reverse the digits or the № mark. */
        const no = document.createElement('bdi');
        no.className = 'bd-plaque-no';
        no.dir = 'ltr';
        no.textContent = `№ ${String(edition.serial).padStart(3, '0')} / ${String(edition.cap)}`;
        const sep = document.createElement('span');
        sep.className = 'bd-plaque-sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '·';
        const tag = document.createElement('span');
        tag.className = 'bd-plaque-tag';
        tag.textContent = t('badgeHistoricMint');
        state.replaceChildren(no, sep, tag);
        state.dataset.state = 'minted';
        state.setAttribute('aria-label', `${no.textContent} ${tag.textContent}`);
      } else if (edition.minting) {
        state.textContent = t('badgeMinting');
        state.dataset.state = 'minting';
      } else {
        state.textContent = t('badgeUnlocked');
        state.dataset.state = 'open';
      }
    }

    const crit = document.getElementById('badge-criteria');
    if (crit) crit.textContent = badgeText(def.criteria, lang);
    paintRequirementChips(prog);
    paintBadgePrivileges(def, unlocked);

    /* The supply bento reads the ledger first and the last confirmed serial second;
       before either answers it shows an em dash, never an invented count. */
    const minted = edition.minted ?? (edition.serial !== null ? edition.serial : null);
    const remaining = edition.remaining ?? (minted !== null ? Math.max(0, def.cap - minted) : null);
    const totalEl = document.getElementById('badge-supply-total');
    if (totalEl) totalEl.textContent = en(def.cap);
    const claimedEl = document.getElementById('badge-supply-claimed');
    if (claimedEl) claimedEl.textContent = minted !== null ? en(minted) : '—';
    const availEl = document.getElementById('badge-supply-available');
    if (availEl) availEl.textContent = remaining !== null ? en(remaining) : '—';
    const availCell = document.getElementById('badge-supply-available-cell');
    if (availCell) {
      availCell.dataset.state = remaining === null ? 'syncing' : remaining <= 0 ? 'closed' : 'open';
    }
    /* the claimed cell is the door to the registry: it warms to gold only once the ledger
       has published holders, so the hint never promises a hall that is still syncing */
    const claimedCell = document.getElementById('badge-supply-claimed-cell');
    if (claimedCell) {
      const published = badgeHolders(id)?.length ?? 0;
      claimedCell.dataset.state = (minted !== null && minted > 0) || published > 0 ? 'live' : 'quiet';
      const hint = t('badgeOwnersHint');
      claimedCell.title = hint;
      claimedCell.setAttribute('aria-label', `${t('badgeClaimed')} — ${hint}`);
    }

    const req = document.getElementById('badge-req');
    req?.setAttribute('data-met', String(prog.met));
    const chip = document.getElementById('badge-req-chip');
    const check = document.getElementById('badge-req-check');
    const count = document.getElementById('badge-req-count');
    if (chip && count) {
      chip.classList.toggle('is-met', prog.met);
      check?.toggleAttribute('hidden', !prog.met);
      const gates = prog.requirements;
      count.textContent = prog.met
        ? t('badgeUnlocked')
        : gates?.length
          ? `${gates.filter((r) => r.met).length} / ${gates.length}`
          : `${en(prog.got)} / ${en(prog.need)}`;
      chip.setAttribute('aria-label', prog.met ? t('badgeUnlocked') : badgeProgressText(id, lang));
    }
    const delta = document.getElementById('badge-req-delta');
    if (delta) {
      delta.textContent = prog.met
        ? (equipped ? t('badgeEquippedNote') : t('badgeReady'))
        : `${t('badgeNextStep')}: ${badgeDelta(id, lang)}`;
    }

    const cta = document.getElementById('badge-equip') as HTMLButtonElement | null;
    const ctaLabel = document.getElementById('badge-cta-label');
    if (cta && ctaLabel) {
      const use = cta.querySelector('use');
      cta.classList.toggle('is-locked', !unlocked);
      if (!unlocked) {
        /* the claim key never opens on an unmet gate: the mission card is the only read */
        cta.disabled = true;
        cta.dataset.mode = 'locked';
        ctaLabel.textContent = t('badgeCtaLocked');
        use?.setAttribute('href', '#i-lock');
      } else if (equipped) {
        cta.disabled = true;
        cta.dataset.mode = 'equipped';
        ctaLabel.textContent = t('badgeCtaEquipped');
        use?.setAttribute('href', '#i-check');
      } else {
        cta.disabled = false;
        cta.dataset.mode = 'equip';
        ctaLabel.textContent = t('badgeCtaEquip');
        use?.setAttribute('href', '#i-check');
      }
      cta.setAttribute('aria-label', `${ctaLabel.textContent} — ${def.name}`);
      if (equipped) cta.title = t('badgeEquippedNote');
      else cta.removeAttribute('title');
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

  /* A relic tapped inside another sheet: the collector card borrows the one panel, and the
     sheet that lent it gets its own panel back the moment the card is dismissed. */
  let relicReturnTo: (() => void) | null = null;
  const relicCardOpen = (): boolean =>
    relicReturnTo !== null && api.sheet('sheet-badge')?.classList.contains('open') === true;
  function handBackToRelicOwner(): void {
    const back = relicReturnTo;
    relicReturnTo = null;
    impact('light');
    back?.();
  }
  relicOpenStep = (id, returnTo) => {
    if (!BADGES.some((b) => b.id === id) || !api.sheet('sheet-badge')) return;
    relicReturnTo = returnTo;
    openBadge(id);
  };

  /* every close path of the card, taken in capture so the sheet manager never sees it */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !relicCardOpen()) return;
    e.stopPropagation();
    e.preventDefault();
    handBackToRelicOwner();
  }, true);
  document.addEventListener('click', (e) => {
    if (!relicCardOpen()) return;
    const target = e.target as HTMLElement | null;
    if (!target || (!target.closest('#scrim') && !target.closest('[data-sheet-close]'))) return;
    e.stopPropagation();
    e.preventDefault();
    handBackToRelicOwner();
  }, true);

  /* ---- Hall of Owners: the registry the claimed chip opens ---- */

  const owners = {
    sheet: api.sheet('badge-owners-modal'),
    list: $<HTMLUListElement>('badge-owners-list'),
    empty: $<HTMLElement>('badge-owners-empty'),
    note: $<HTMLElement>('badge-owners-note'),
    name: $<HTMLElement>('badge-owners-name'),
    crest: $<HTMLElement>('badge-owners-empty-crest'),
    emptyCopy: $<HTMLElement>('badge-owners-empty-copy'),
    emptyFirst: $<HTMLElement>('badge-owners-first'),
    vault: $<HTMLElement>('badge-owners-vault'),
    track: document.querySelector<HTMLElement>('#badge-owners-vault .bo-vault-track'),
    fill: $<HTMLElement>('badge-owners-fill'),
    struck: $<HTMLElement>('badge-owners-struck'),
    held: $<HTMLElement>('badge-owners-held'),
  };
  const ownersOpen = (): boolean => owners.sheet?.classList.contains('open') === true;

  /** Two letters off the ledger's own name, in its own script — the ladder monogram would
   *  flatten a Persian display name to a placeholder. */
  const holderMonogram = (raw: string): string => {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    const source = words.length > 1 ? words.map((w) => w.charAt(0)).join('') : raw.trim().slice(0, 2);
    return source.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 2) || 'P';
  };

  /** The mint stamp this device holds, in the player's own calendar and on the app's own clock:
   *  Persian reads it Jalali, every other locale reads the Tehran date. '' when the ledger never said. */
  function mintStamp(iso: string): string {
    if (!iso) return '';
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    try {
      return new Intl.DateTimeFormat(lang === 'fa' ? 'fa-IR' : 'en-GB', {
        timeZone: 'Asia/Tehran',
        year: 'numeric', month: 'short', day: 'numeric',
      }).format(new Date(ms));
    } catch { return ''; }
  }

  /** The shelter this serial is standing under. An exposed one offers the duel; a guarded one
   *  says why it does not, in the same clock the dossier reads. */
  function shelterAction(def: BadgeDef, holder: EditionHolder): HTMLElement {
    const shelter = relicShelter(def.id, holder.serial);
    if (shelter.sheltered) {
      const guard = document.createElement('span');
      guard.className = 'bo-shelter is-guarded';
      guard.dir = 'ltr';
      guard.textContent = `🛡️ ${shelter.hoursLeft}h`;
      guard.title = t('seizeShieldAria');
      return guard;
    }
    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'btn-seize-relic';
    key.setAttribute('aria-label', t('seizeAria'));
    key.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-swords" /></svg>';
    key.addEventListener('click', () => {
      impact('medium');
      openSeize(seizeTargetOf(def, holder.serial, holder.name));
    });
    return key;
  }

  /** The brass plaque a serial rides. `№ 001` is a ledger code, not a sentence: it keeps its
   *  Latin digits and its own left-to-right run in every language, so no RTL sheet can split it. */
  const serialPlaque = (serial: number): string => `№ ${String(serial).padStart(3, '0')}`;

  /** Persian prose reads with Persian figures. The vault counts are prose; the serial is a code. */
  const FA_FIGURES = '۰۱۲۳۴۵۶۷۸۹';
  const faDigits = (value: string): string =>
    lang === 'fa' ? value.replace(/\d/g, (d) => FA_FIGURES[Number(d)]) : value;

  /** One registry row: medallion, name, and the serial plate the ledger minted for it. */
  function holderRow(def: BadgeDef, holder: EditionHolder, mine: boolean): HTMLElement {
    const when = mine ? mintStamp(claimMintedAt(def.id)) : '';
    const genesis = holder.serial === 1;
    const serial = t('badgeSerialLabel').replace('#{num}', editionSerialLabel(holder.serial));

    const av = document.createElement('span');
    av.className = 'bo-av';
    av.textContent = holderMonogram(holder.name);
    /* Only this device's own row can name a photo — the ledger publishes a display name and
       never a player id, so every other plate keeps its monogram. */
    if (mine) {
      const src = tgUser()?.photo_url || telegramAvatarUrl(tgUser()?.username ?? '');
      if (src) {
        const img = document.createElement('img');
        img.className = 'bo-av-img';
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => img.remove(), { once: true });
        img.addEventListener('load', () => {
          if (img.naturalWidth > 2 && img.naturalHeight > 2) av.classList.add('has-photo');
          else img.remove();
        }, { once: true });
        img.src = src;
        av.append(img);
      }
    }
    if (genesis) {
      const pin = document.createElement('span');
      pin.className = 'bo-pin';
      pin.title = t('badgeOwnersFounder');
      pin.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-crown" /></svg>';
      av.append(pin);
    }

    const who = document.createElement('span');
    who.className = 'bo-id';
    const nm = document.createElement('b');
    nm.className = 'bo-name';
    nm.dir = 'auto';
    nm.textContent = holder.name;
    nm.title = holder.name;

    /* The sub-line is three facts in three directions, so it is built from parts rather than one
       concatenated string: an RTL sheet can no longer reorder an @handle or a mint stamp, and the
       dots between them are decoration the reader never hears. */
    const meta = document.createElement('small');
    meta.className = 'bo-meta';
    const parts: HTMLElement[] = [];
    const handle = mine ? (tgUser()?.username ?? '') : '';
    if (handle) {
      const h = document.createElement('span');
      h.className = 'bo-part bo-handle';
      h.dir = 'ltr';
      h.textContent = `@${handle}`;
      parts.push(h);
    }
    if (when) {
      const d = document.createElement('span');
      d.className = 'bo-part bo-when';
      d.textContent = when;
      parts.push(d);
    }
    if (!mine) {
      const r = document.createElement('span');
      r.className = 'bo-part bo-role';
      r.textContent = t('badgeOwnersVerified');
      parts.push(r);
    }
    if (parts.length === 0) {
      const r = document.createElement('span');
      r.className = 'bo-part bo-role';
      r.textContent = t('badgeOwnersYou');
      parts.push(r);
    }
    parts.forEach((part, i) => {
      if (i > 0) {
        const dot = document.createElement('span');
        dot.className = 'bo-dot';
        dot.setAttribute('aria-hidden', 'true');
        dot.textContent = '·';
        meta.append(dot);
      }
      meta.append(part);
    });
    who.append(nm, meta);

    const plate = document.createElement('span');
    plate.className = 'bo-right';
    const plaque = document.createElement('b');
    plaque.className = 'serial-plaque';
    plaque.dir = 'ltr';
    plaque.textContent = serialPlaque(holder.serial);
    plaque.title = serial;
    plate.append(plaque);
    /* A rival's row carries its shelter: an exposed serial offers the duel, a guarded one says
       why it does not. The player's own row is a deed, never a door into a challenge. */
    if (mine) {
      const yours = document.createElement('span');
      yours.className = 'bo-yours';
      yours.textContent = t('badgeOwnersYours');
      plate.append(yours);
    } else {
      plate.append(shelterAction(def, holder));
    }

    const li = document.createElement('li');
    li.className = `bo-row${mine ? ' is-you' : ''}${genesis ? ' is-genesis' : ''}`;
    li.setAttribute('aria-label', `${holder.name} — ${serial}${when ? ` · ${when}` : ''}`);
    li.append(av, who, plate);
    return li;
  }

  /** Redraw the registry from what the ledger has actually published for the open honor. */
  function paintOwners(): void {
    const id = badgeDraft;
    const def = id ? BADGES.find((b) => b.id === id) : undefined;
    if (!def || !id || !owners.sheet || !owners.list || !owners.empty || !owners.note) return;

    const holders = badgeHolders(id);
    const edition = badgeEdition(id);

    if (owners.name) owners.name.textContent = def.name;
    owners.sheet.dataset.accent = def.accent;
    if (owners.crest && owners.crest.dataset.badge !== def.id) {
      owners.crest.dataset.badge = def.id;
      owners.crest.innerHTML = badgeCrestHtml(def, 'badge-crest');
    }
    if (owners.emptyCopy) owners.emptyCopy.textContent = t('badgeOwnersEmpty');
    if (owners.emptyFirst) owners.emptyFirst.textContent = t('badgeOwnersFirst');

    owners.list.textContent = '';
    owners.list.hidden = true;
    owners.empty.hidden = true;
    owners.note.hidden = true;

    const rows = holders ?? [];
    if (rows.length > 0) {
      for (const holder of rows) owners.list.append(holderRow(def, holder, holder.serial === edition.serial));
      owners.list.hidden = false;
    } else if (holders === null) {
      /* the ledger has published no name for this honor: say so rather than
         presenting an empty hall as if nobody had ever claimed it */
      owners.note.textContent = t('badgeOwnersSyncing');
      owners.note.hidden = false;
    } else {
      owners.empty.hidden = false;
    }

    /* The vault meter reads the same supply the plates are minted from: struck on one side,
       still locked away on the other. An unread ledger hides the meter rather than invent one. */
    if (owners.vault) {
      const live = holders !== null;
      owners.vault.hidden = !live;
      if (live) {
        const cap = def.cap;
        const struck = Math.max(0, Math.min(cap, edition.minted ?? rows.length));
        const left = cap - struck;
        const readout = faDigits(t('badgeOwnersStruck')
          .replace('{n}', String(struck))
          .replace('{cap}', String(cap)));
        if (owners.fill) owners.fill.style.width = `${cap > 0 ? (struck / cap) * 100 : 0}%`;
        if (owners.track) {
          owners.track.setAttribute('aria-valuemax', String(cap));
          owners.track.setAttribute('aria-valuenow', String(struck));
          owners.track.setAttribute('aria-label', t('badgeOwnersVaultAria'));
          owners.track.setAttribute('aria-valuetext', readout);
        }
        if (owners.struck) owners.struck.textContent = readout;
        if (owners.held) owners.held.textContent = faDigits(t('badgeOwnersVault').replace('{n}', String(left)));
        owners.vault.dataset.state = left === 0 ? 'full' : struck === 0 ? 'empty' : 'open';
      }
    }
  }

  function openOwners(): void {
    if (!owners.sheet) return;
    paintOwners();
    impact('light');
    api.sheets.open(owners.sheet);
    /* laid out only after the swap, so this is where the registry starts back at serial one */
    if (owners.list) owners.list.scrollTop = 0;
  }

  /* The registry is a child of whichever card opened it — the collector sheet or the
     certificate — and the sheet manager holds one panel: handing back re-opens that parent
     rather than unwinding the whole flow to the shelf. */
  let ownersParent: 'badge' | 'cert' = 'badge';
  function backFromOwners(): void {
    const id = badgeDraft;
    const parent = ownersParent === 'cert'
      ? api.sheet('equipped-badge-modal')
      : api.sheet('sheet-badge');
    if (!id || !parent) { api.sheets.close(); return; }
    impact('light');
    if (ownersParent === 'cert') paintCertificate(id);
    else paintBadgeSheet(id);
    api.sheets.open(parent);
  }
  ownersBackStep = () => {
    if (!ownersOpen()) return false;
    backFromOwners();
    return true;
  };

  document.getElementById('badge-supply-claimed-cell')?.addEventListener('click', () => {
    if (!badgeDraft) return;
    if (badgeHolders(badgeDraft) === null) {
      notify('warning');
      showToast(t('badgeOwnersSyncing'), 'warning');
      void refreshBadgeEditions();          // the retry is what turns this toast into a registry
      return;
    }
    ownersParent = 'badge';
    openOwners();
  });
  document.getElementById('badge-owners-back')?.addEventListener('click', backFromOwners);
  document.getElementById('badge-owners-close')?.addEventListener('click', backFromOwners);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !ownersOpen()) return;
    e.stopPropagation();
    e.preventDefault();
    backFromOwners();
  }, true);
  document.addEventListener('click', (e) => {
    if (!ownersOpen()) return;
    const target = e.target as HTMLElement | null;
    if (!target || !target.closest('#scrim')) return;
    e.stopPropagation();
    e.preventDefault();
    backFromOwners();
  }, true);

  /** A Latin token kept upright inside RTL text. */
  const isolate = (raw: string): HTMLElement => {
    const bdi = document.createElement('bdi');
    bdi.dir = 'ltr';
    bdi.textContent = raw;
    return bdi;
  };

  /* ---- Medallion Certificate: the ownership deed the avatar pin and its serial tag open ----
     Every reading is one the ledger already gave us. A serial that has not arrived prints an
     em dash and the mint stamp reads "not recorded" — the deed never invents its own numbers. */

  const cert = {
    sheet: api.sheet('equipped-badge-modal'),
    body: $<HTMLElement>('badge-cert-body'),
    crest: $<HTMLElement>('badge-cert-crest'),
    ribbon: $<HTMLElement>('badge-cert-ribbon'),
    honor: $<HTMLElement>('badge-cert-honor'),
    arch: $<HTMLElement>('badge-cert-archetype'),
    holder: $<HTMLElement>('badge-cert-holder'),
    verified: $<HTMLElement>('badge-cert-verified'),
    serial: $<HTMLElement>('badge-cert-serial'),
    minted: $<HTMLElement>('badge-cert-minted'),
    supply: $<HTMLElement>('badge-cert-supply'),
    perks: $<HTMLUListElement>('badge-cert-perks'),
  };
  const certOpen = (): boolean => cert.sheet?.classList.contains('open') === true;

  function paintCertificate(id: string): void {
    const def = BADGES.find((b) => b.id === id);
    if (!def || !cert.sheet) return;
    const edition = badgeEdition(id);

    cert.sheet.dataset.accent = def.accent;
    if (cert.crest && cert.crest.dataset.badge !== def.id) {
      cert.crest.dataset.badge = def.id;
      cert.crest.dataset.accent = def.accent;
      cert.crest.innerHTML = badgeCrestHtml(def);
    }
    if (cert.honor) cert.honor.textContent = def.name;
    if (cert.arch) cert.arch.textContent = `${def.archetype} · ${def.pillar}`;
    cert.sheet.setAttribute('aria-label', `${t('badgeCertTitle')} — ${def.name}`);
    document.getElementById('badge-cert-close')?.setAttribute('aria-label', t('badgeCertClose'));

    const serialTag = edition.serial !== null ? editionSerialLabel(edition.serial) : '—';
    if (cert.ribbon) {
      /* the serial and its cap each ride an LTR isolate: in Persian a bare "#" is otherwise
         claimed by the RTL run and prints between the word and its digits */
      const parts = t('badgeCertRibbon').split(/\{serial\}|\{cap\}/);
      cert.ribbon.textContent = '';
      cert.ribbon.append(
        parts[0] ?? '', isolate(serialTag),
        parts[1] ?? '', isolate(en(edition.cap)),
        parts[2] ?? '',
      );
    }
    if (cert.serial) {
      cert.serial.textContent = edition.serial !== null ? serialTag : t('badgeCertSerialPending');
      cert.serial.dataset.state = edition.serial !== null ? 'live' : 'pending';
    }
    /* the tick means the ledger has this name against this serial, not that a display name
       was typed carefully — so it rides the claim, never the player */
    if (cert.holder) cert.holder.textContent = playerName();
    if (cert.verified) cert.verified.hidden = edition.serial === null;

    if (cert.minted) {
      const stamp = mintStamp(claimMintedAt(id));
      cert.minted.textContent = stamp || t('badgeCertNotRecorded');
      cert.minted.dataset.state = stamp ? 'live' : 'pending';
    }
    if (cert.supply) {
      cert.supply.textContent = t('badgeCertSupplyCap').replace('{cap}', en(def.cap));
    }

    if (cert.perks) {
      cert.perks.textContent = '';
      for (const perk of def.perks) {
        const li = document.createElement('li');
        li.className = 'ct-perk';
        const ico = document.createElement('span');
        ico.className = 'ct-perk-ico';
        ico.setAttribute('aria-hidden', 'true');
        ico.textContent = perk.icon;
        const txt = document.createElement('p');
        txt.className = 'ct-perk-t';
        txt.textContent = badgeText(perk.text, lang);
        li.append(ico, txt);
        cert.perks.append(li);
      }
    }
  }

  function openCertificate(): void {
    const eq = equippedBadge();
    if (!eq || !cert.sheet) return;
    badgeDraft = eq.id;
    ownersParent = 'cert';
    paintCertificate(eq.id);
    void refreshBadgeEditions();
    impact('light');
    api.sheets.open(cert.sheet);
    /* laid out only after the swap, so the deed opens on its seal and not mid-scroll */
    if (cert.body) cert.body.scrollTop = 0;
  }

  document.getElementById('badge-cert-owners')?.addEventListener('click', () => {
    const id = badgeDraft;
    if (!id) return;
    if (badgeHolders(id) === null) {
      notify('warning');
      showToast(t('badgeOwnersSyncing'), 'warning');
      void refreshBadgeEditions();
      return;
    }
    ownersParent = 'cert';
    openOwners();
  });

  document.getElementById('badge-cert-unequip')?.addEventListener('click', () => {
    const id = badgeDraft;
    if (!id || profile.badge !== id) { api.sheets.close(); return; }
    setBadge(null);
    impact('medium');
    notify('success');
    api.sheets.close();
    showPfToast(t('badgeCertUnequipped'), true);
  });

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
    $('pf-age-v').textContent = age !== null
      ? t('profileAgeYears').replace('{n}', String(age))
      : t('profileAgeNotSet');
    $('pf-age-s').textContent = locked && dob
      ? t('profileBornOn').replace('{date}', lang === 'fa'
        ? `${dob.y}/${String(dob.m).padStart(2, '0')}/${String(dob.d).padStart(2, '0')}`
        : `${dob.d} ${MONTH_LABELS[dob.m - 1]} ${dob.y}`)
      : locked ? t('profilePermanentEntry') : t('profileComplete');
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
  };
  onChange(paintProfile);

  /* Cache writes already flush the whole save; this listener is for the states a flush cannot
     signal — the first "syncing" frame, each mint starting and settling, and the final offline
     state. It repaints only the badge surfaces, never the cosmetics previews. */
  onEditionChange(() => {
    paintHeroExtras(levelInfo());
    paintBadges();
    if (badgeDraft) paintBadgeSheet(badgeDraft);
    if (ownersOpen()) paintOwners();
    if (certOpen() && badgeDraft) paintCertificate(badgeDraft);
    if (squadSheet && !squadSheet.hidden && !squadBoundView.hidden) paintSquadHub();
  });

  /* Unlocking an honor schedules one refresh (and therefore one idempotent mint) right after the
     race settles, so the serial is already on the shelf when Profile opens. Cache-only flushes
     leave the stats signature unchanged and schedule nothing. */
  const statsSignature = (): string =>
    `${myTiq()}/${profile.stats.games}/${profile.stats.wins}/${profile.stats.streak}`
    + `/${profile.stats.best}/${profile.stats.pvpStreak}/${profile.stats.pvpBest}`;
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

  /* frame cycle: tapping the avatar steps Default → Auric → Neon; the name reads out via aria-label. */
  document.getElementById('pf-avatar-wrap')?.addEventListener('click', () => {
    const ids = FRAMES.map((f) => f.id);
    const cur = profile.frame ?? 'default';
    const next = ids[(ids.indexOf(cur) + 1) % ids.length];
    setFrame(next === 'default' ? null : next);
    impact('light');
    notify('success');
  });
  /* the pin and the serial tag hanging under it are two doors to one place: the honor's
     certificate. The shelf is still reachable — it is the tile that equips, and the
     certificate's registry button is the short path to the hall. */
  const openWornCertificate = (): void => {
    if (!equippedBadge()) return;
    openCertificate();
  };
  document.getElementById('pf-equipped-badge')?.addEventListener('click', openWornCertificate);
  document.getElementById('pf-equipped-serial')?.addEventListener('click', openWornCertificate);
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
    /* the preview is drawn from the same `newGame` the race will run, so it has to be pointed at
       that board before it lays itself out: a three- or four-contender field is the wider, longer
       grid, and a renderer left on the duel's 8x12 would paint the balls off their own squares. */
    const s = newGame(custom);
    teamPv.setBoard(s.cols, s.rows);
    teamPv.resize();
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
    /* The spoken name of a key whose visible label is translated too: an aria-label
       written in the markup would otherwise stay English under every language. */
    for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
      const key = el.dataset.i18nAria;
      if (!key) continue;
      el.setAttribute('aria-label', t(key));
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
    const row = $('profile-lang-btn');
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

  $('profile-lang-btn')?.addEventListener('click', openLang);
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
  $('profile-tg-channel')?.addEventListener('click', () => { impact('light'); openExternal(CHANNEL_URL); });

  /* ---- the pre-lesson language gate ---------------------------------------------------------
     A first-time invitee gets one decision before the board: which language to learn in. It is
     deliberately NOT a sheet — there is nothing behind it to browse yet — so it is a full
     viewport obsidian card over the boot shell, and it cannot be dismissed without a choice.
     Every width is capped, every text node wraps and the grid collapses at 340px, so a 320px
     Persian or Arabic viewport can never gain a horizontal scrollbar. */
  const langGate = document.createElement('div');
  langGate.className = 'lang-picker-modal';
  langGate.id = 'lang-picker-modal';
  langGate.hidden = true;
  langGate.innerHTML = [
    '<div class="lang-picker-card" data-scroll role="dialog" aria-modal="true" aria-labelledby="lang-picker-title" aria-describedby="lang-picker-sub">',
    '  <span class="lang-picker-crest" aria-hidden="true"><svg class="ico"><use href="#i-swords" /></svg></span>',
    '  <p class="lang-picker-kicker" id="lang-picker-kicker"></p>',
    '  <h2 class="lang-picker-title" id="lang-picker-title"></h2>',
    '  <p class="lang-picker-sub" id="lang-picker-sub"></p>',
    '  <div class="lang-picker-grid" id="lang-picker-grid" role="group"></div>',
    '</div>',
  ].join('');
  document.body.appendChild(langGate);

  const langGateCard = langGate.querySelector<HTMLElement>('.lang-picker-card');
  const langGateKicker = langGate.querySelector<HTMLElement>('#lang-picker-kicker');
  const langGateTitle = langGate.querySelector<HTMLElement>('#lang-picker-title');
  const langGateSub = langGate.querySelector<HTMLElement>('#lang-picker-sub');
  const langGateGrid = langGate.querySelector<HTMLElement>('#lang-picker-grid');
  const langGateButtons: HTMLButtonElement[] = [];
  let langGatePick: ((code: LangCode) => void) | null = null;

  const paintLanguageGate = (): void => {
    const dir = langDef(lang).dir;
    langGate.setAttribute('dir', dir);
    langGateCard?.setAttribute('dir', dir);
    if (langGateKicker) langGateKicker.textContent = t('language');
    if (langGateTitle) langGateTitle.textContent = t('langPickerTitle');
    if (langGateSub) langGateSub.textContent = t('langPickerSub');
    for (const b of langGateButtons) {
      const on = b.dataset.lang === lang;
      b.classList.toggle('is-current', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };

  function closeLanguageGate(): void {
    if (langGate.hidden) return;
    langGate.hidden = true;
    langGate.classList.remove('is-in');
    langGatePick = null;
  }

  function pickLanguageGate(code: LangCode): void {
    if (langGate.hidden) return;
    impact('light');
    /* Apply the locale BEFORE the gate lifts: every surface behind it — and the lesson that is
       about to start — paints in the chosen language from its very first frame. */
    setLang(code);
    paintLanguageGate();
    const done = langGatePick;
    closeLanguageGate();
    done?.(code);
  }

  if (langGateGrid) {
    for (const l of LANGS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lang-pick';
      btn.dataset.lang = l.code;
      btn.setAttribute('aria-pressed', 'false');
      const flag = document.createElement('span');
      flag.className = 'lang-pick-flag';
      flag.textContent = l.flag;
      flag.setAttribute('aria-hidden', 'true');
      const native = document.createElement('span');
      native.className = 'lang-pick-native';
      native.textContent = l.native;
      native.lang = l.code;
      native.dir = l.dir;
      btn.append(flag, native);
      btn.addEventListener('click', () => pickLanguageGate(l.code));
      langGateButtons.push(btn);
      langGateGrid.append(btn);
    }
  }

  function openLanguageGate(onPick: (code: LangCode) => void): void {
    langGatePick = onPick;
    paintLanguageGate();
    langGate.hidden = false;
    requestAnimationFrame(() => langGate.classList.add('is-in'));
    const current = langGateButtons.find((b) => b.dataset.lang === lang) ?? langGateButtons[0];
    window.setTimeout(() => {
      if (!langGate.hidden) current?.focus({ preventScroll: true });
    }, 60);
  }

  /* Mandatory decision: Tab cycles inside the card, and there is no Escape or scrim dismissal. */
  langGate.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || langGate.hidden || !langGateButtons.length) return;
    const first = langGateButtons[0];
    const last = langGateButtons[langGateButtons.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus({ preventScroll: true });
    }
  });

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
  $('profile-admin-contact')?.addEventListener('click', openSupport);

  /* live repaint: internal watchers + the public DOM event for external listeners */
  const paintLangLive = () => {
    paintLang();
    paintSquadPill();
    if (!pfScreen.hidden) paintProfile();
    if (badgeDraft && document.getElementById('sheet-badge')?.classList.contains('open')) paintBadgeSheet(badgeDraft);
    if (badgeDraft && ownersOpen()) paintOwners();
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
    openLanguagePicker(onPick) { openLanguageGate(onPick); },
    closeLanguagePicker() { closeLanguageGate(); },
    isLanguagePickerOpen() { return !langGate.hidden; },
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

  /** The chat's Telegram audience, quoted as what it is — never as the squad's member count. */
  const membersLabel = (n: number): string => {
    const count = n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
    return t('enlistSubscribers').replace('{n}', count);
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
      pvMeta.hidden = verified.subscribers <= 0;
      if (verified.subscribers > 0) pvMeta.textContent = membersLabel(verified.subscribers);
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

/* ---------------------------------------------------------------------------
   RETURN-TO-LOBBY TACTICAL TRAINING UPSELL

   The invitee who skipped first-open onboarding is offered the lesson only AFTER
   the duel is over and they are back on Home. This controller owns just the
   chassis: the two decisions are handed back to main.ts, which is the only place
   that may start the untouched tutorial flow or stamp the lesson flag.

   One full-viewport grid (scrim + centred panel) rather than a physical
   left/right pair, so a 320px RTL viewport stays centred with zero horizontal
   overflow. The whole card is [hidden]-gated: an author `display` beats the UA
   rule, so the stylesheet repeats that gate with `display: none !important`.
   --------------------------------------------------------------------------- */

export interface TrainingUpsellActions {
  /** Primary CTA: launch the existing, unmodified tutorial flow. */
  onStart: () => void;
  /** Secondary CTA: dismiss AND mark the lesson read, so this never nags again. */
  onSkip: () => void;
}

interface TrainingUpsellModal {
  open(actions: TrainingUpsellActions): void;
}

let trainingUpsell: TrainingUpsellModal | null = null;

/** Open the optional 30-second training prompt. Idempotent: one chassis for the whole app. */
export function openTrainingUpsell(actions: TrainingUpsellActions): void {
  if (!trainingUpsell) trainingUpsell = createTrainingUpsell();
  trainingUpsell?.open(actions);
}

function createTrainingUpsell(): TrainingUpsellModal | null {
  const root = document.createElement('div');
  root.className = 'tu-modal';
  root.id = 'tu-modal';
  root.hidden = true;
  root.innerHTML = [
    '<div class="tu-scrim" data-tu-scrim></div>',
    '<div class="tu-panel" role="dialog" aria-modal="true" aria-labelledby="tu-title" aria-describedby="tu-body">',
    '  <span class="tu-crest" aria-hidden="true">⚔️</span>',
    '  <p class="tu-kicker" id="tu-kicker"></p>',
    '  <h2 class="tu-title" id="tu-title"></h2>',
    '  <p class="tu-body" id="tu-body"></p>',
    '  <div class="tu-actions">',
    '    <button class="tu-primary" id="tu-start" type="button"><span id="tu-start-t"></span></button>',
    '    <button class="tu-secondary" id="tu-skip" type="button"><span id="tu-skip-t"></span></button>',
    '  </div>',
    '</div>',
  ].join('');
  document.body.appendChild(root);

  const panel = root.querySelector<HTMLElement>('.tu-panel');
  const scrim = root.querySelector<HTMLElement>('[data-tu-scrim]');
  const start = root.querySelector<HTMLButtonElement>('#tu-start');
  const skip = root.querySelector<HTMLButtonElement>('#tu-skip');
  if (!panel || !scrim || !start || !skip) return null;

  const copy: [string, string][] = [
    ['#tu-kicker', 'trainingUpsellKicker'],
    ['#tu-title', 'trainingUpsellTitle'],
    ['#tu-body', 'trainingUpsellBody'],
    ['#tu-start-t', 'trainingUpsellStart'],
    ['#tu-skip-t', 'trainingUpsellSkip'],
  ];

  const paint = (): void => {
    /* Persian and Arabic are joined scripts: zero tracking, and their own direction on every
       text surface (the document itself never flips `dir`). */
    const dir = langDef(lang).dir;
    panel.setAttribute('dir', dir);
    start.setAttribute('dir', dir);
    skip.setAttribute('dir', dir);
    for (const [selector, key] of copy) {
      const el = root.querySelector<HTMLElement>(selector);
      if (el) el.textContent = t(key);
    }
  };
  onLang(paint);
  paint();

  let actions: TrainingUpsellActions | null = null;
  let restore: HTMLElement | null = null;

  const dismiss = (decide: (a: TrainingUpsellActions) => void): void => {
    if (root.hidden) return;
    const current = actions;
    actions = null;
    root.hidden = true;
    const back = restore;
    restore = null;
    back?.focus({ preventScroll: true });
    if (current) decide(current);
  };

  start.addEventListener('click', () => { impact('light'); dismiss((a) => a.onStart()); });
  skip.addEventListener('click', () => { impact('light'); dismiss((a) => a.onSkip()); });
  /* A tap on the veil is a dismissal, not a decision: the lesson flag stays untouched so the
     offer can still be made on a later visit. */
  scrim.addEventListener('click', () => dismiss(() => {}));
  root.addEventListener('click', (e) => { if (e.target === root) dismiss(() => {}); });
  document.addEventListener('keydown', (e) => {
    if (root.hidden || e.key !== 'Escape') return;
    /* The mandatory channel gate sits above this card at a higher layer and owns Escape while it
       is up; never silently dismiss the optional card underneath it. */
    const gate = document.getElementById('force-join-modal');
    if (gate && !gate.hidden) return;
    e.preventDefault();
    dismiss(() => {});
  });

  return {
    open(next: TrainingUpsellActions) {
      if (!root.hidden) return;
      actions = next;
      paint();
      restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      root.hidden = false;
      window.setTimeout(() => { if (!root.hidden) start.focus({ preventScroll: true }); }, 40);
    },
  };
}
