/**
 * compete.ts — Ranks: the dedicated three-board leaderboard.
 *
 * "The Mind Ladder": one three-way clay switch over Top Minds (solo champions),
 * Intellect Guilds (Telegram channels & groups) and Nations IQ (aggregate country
 * score). Above the ladder sits the Top 3 clay podium, so the list itself starts
 * at #4; the guild board carries its Join keys there, and the pinned own-squad
 * hero replaces the dock once bound. The squad dock ("My Squad Standing" / join
 * prompt) belongs EXCLUSIVELY to the guild board, and the "Your Standing" module
 * to the two IQ boards.
 *
 * Identity: TIQ (Tactical IQ) is the hero metric — gold digits with the brain
 * glyph, on the HUD pills, the podium and the ladder. #i-cup is reserved for
 * season prizes. A player's face is their Telegram photo; a name, its TIQ and
 * the plinth carry the rank, with no league pill between them.
 *
 * The Arena tab is the progression road in src/arena.ts. Channel War is staged
 * on Home's hero slide, so this controller owns no cup, bracket or channel board.
 */
import { type PlayerRow, type Trend } from './data';
import {
  fetchNationBoard,
  fetchNationRoster,
  type NationFeed,
  type NationPlayer,
  type NationRoster,
  type NationRow,
} from './nations';
import { fetchMindLadder, type MindFeed } from './minds';
import { myTiq } from './matchmaking';
import { nameOf } from './countries';
import { BADGES, type BadgeDef, badgeCrestHtml, badgeEdition, badgeHolders, editionSerialLabel, holderEdition, isBadgeUnlocked, refreshBadgeEditions, wornEdition, type WornEdition } from './badges';
import { openRelicCard } from './menu';
import { isSeizable, openSeize, relicShelter, seizeTargetOf } from './seize';
import { flagPhoto } from './flags';
import { openCountryPicker } from './countrypick';
import { onChange, profile } from './storage';
import { arena, countdownPill, fullCountdown, seasonLabel } from './arenaState';
import { cleanChatReference, cleanHandle, cleanTag, displayNameOf, getMyContribution, getMySquad, getSquadRanking, onSquadChange, squadAvatarUrl, squadInviteUrl, squadKind, squadMark, squadTiqSum, telegramAvatarUrl, type RankedSquad } from './squads';
import { BOT_HANDLE, impact, notify, openLink, tgUser } from './telegram';
import { lang, onLang, t } from './settings';
import { isPremiumUser, onVipChange } from './premium';
import { joinSquadOnServer, registerSquadWithTelegram } from './squadRegister';
import { showToast } from './toast';
import type { Router } from './router';
import type { Sheets } from './sheets';

export interface CompeteApi {
  router: Router;
  sheets: Sheets;
  sheet(id: string): HTMLElement | null;
}

type Board = 'minds' | 'guilds' | 'nations';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const skel = (rows: number): string =>
  Array.from({ length: rows }, () => '<div class="skel-row"><span class="skel w20"></span><span class="skel w60"></span><span class="skel w15"></span></div>').join('');

const empty = (msg: string): string => `<div class="empty" role="status">${msg}</div>`;

function pickEl(id: string, legacy: string): HTMLElement {
  return (document.getElementById(id) ?? document.getElementById(legacy)) as HTMLElement;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------- Mind Ladder identity: the season clock ---------- */

/** FNV-1a over an ASCII key: stable across renders, so a seeded figure never jitters. */
function hashOf(key: string): number {
  let h = 216613261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return Math.abs(h);
}

/* ---------- mind profile: the stat capsule, the form strip, the percentile ring ---------- */

/** Newest on the right; `u` is a race the save genuinely does not remember. */
type FormCell = 'w' | 'l' | 'u';

/** One cell of the scorecard: a number and what it counts. */
interface MindStat {
  label: string;
  value: string;
}

/**
 * A rival's scorecard, seeded once from their own key. The ladder holds no race log for
 * anybody but you, so the match count and best streak are the Preview chip's figures —
 * stable across renders — while the wins and their rate come from the row's real wins.
 */
function rivalStats(p: PlayerRow): MindStat[] {
  const h = hashOf(p.id);
  const rate = 42 + (h % 27); /* 42–68% keeps the seeded field plausible */
  const matches = p.wins > 0 ? Math.max(p.wins, Math.round((p.wins * 100) / rate)) : 6 + (h % 24);
  const wins = Math.min(p.wins, matches);
  const pct = matches > 0 ? Math.round((wins / matches) * 100) : 0;
  const streak = 1 + ((h >> 5) % 8);
  return [
    { label: t('msMatches'), value: matches.toLocaleString('en-US') },
    { label: t('msWinRate'), value: `${pct}%` },
    { label: t('msBestStreak'), value: streak.toLocaleString('en-US') },
  ];
}

/** Weighted by the row's own trend so the seeded form stays internally consistent. */
function rivalForm(key: string, trend: Trend): FormCell[] {
  const h = hashOf(key);
  const bias = trend === 'up' ? 72 : trend === 'down' ? 40 : 56;
  const out: FormCell[] = [];
  for (let i = 0; i < 5; i++) out.push((h >> (i * 3)) % 100 < bias ? 'w' : 'l');
  return out;
}

/** Sprite icon as a real element — the house artwork, never an emoji stand-in. */
function svgIcon(href: string, cls: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', href);
  svg.append(use);
  return svg;
}

/**
 * Percentile ring: one SVG arc on pathLength=100, so the dash *is* the percentage and
 * the mount animation only has to walk stroke-dashoffset from empty to its own value.
 */
function percentRing(pct: number, inner: HTMLElement, extraCls = ''): HTMLElement {
  const ring = document.createElement('span');
  ring.className = `mh-ring${extraCls ? ` ${extraCls}` : ''}`;
  ring.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'mh-arc');
  svg.setAttribute('viewBox', '0 0 44 44');
  const arc = (fill: boolean): void => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', fill ? 'mh-arc-fill' : 'mh-arc-track');
    c.setAttribute('cx', '22');
    c.setAttribute('cy', '22');
    c.setAttribute('r', '19');
    c.setAttribute('fill', 'none');
    if (fill) {
      c.setAttribute('pathLength', '100');
      c.setAttribute('stroke-dasharray', '100 100');
      c.style.strokeDashoffset = String(100 - Math.max(0, Math.min(100, pct)));
    }
    svg.append(c);
  };
  arc(false);
  arc(true);
  ring.append(svg, inner);
  return ring;
}

/* ---------- flag rendering pipeline ---------- */

/* One shared resolver (`flags.ts`) serves the ladder, the HUD, the profile and the
   picker: flagcdn PNG → circle-flags SVG → the clay ISO chip / globe. */

export function createCompete(api: CompeteApi): { setRoute(id: string): void } {
  const boardBtns = [...document.querySelectorAll<HTMLButtonElement>('.ranks-tabs [data-board]')];
  const boardSwitch = document.querySelector<HTMLElement>('.ranks-tabs');
  const seasonChip = document.getElementById('ranks-season');
  const seasonText = seasonChip?.querySelector<HTMLElement>('.ml-season-t') ?? null;
  const seasonKicker = seasonChip?.querySelector<HTMLElement>('.ml-season-k') ?? null;
  const seasonSub = document.getElementById('ranks-sub');
  const podiumEl = document.getElementById('ranks-podium');
  const panes: Record<Board, HTMLElement | null> = {
    minds: document.getElementById('ranks-minds'),
    guilds: document.getElementById('ranks-guilds'),
    nations: document.getElementById('ranks-nations'),
  };

  let board: Board = 'minds';
  let loadedBoard: Partial<Record<Board, boolean>> = {};
  /** The last country board, so a flag change repaints before the refetch lands. */
  let nationRows: NationRow[] | null = null;
  /** The last live board, kept so a language switch never blanks the HUD or invents a score. */
  let nationFeed: NationFeed | null = null;
  let tick = 0;
  /** Last time the public holder index was fetched, so route re-entry is not a re-fetch loop. */
  let medalsFetchedAt = 0;

  /* ---------- tab caching: fingerprints + windowed list construction ----------
     A board rebuild is the one expensive thing this screen does. `boardSignature`
     is a cheap FNV-1a digest of the rows a board would paint; an unchanged board
     keeps every mounted node. A changed one builds only the rows a phone actually
     shows synchronously and appends the tail on later frames. */
  const boardSignature = (parts: ReadonlyArray<string | number | null | undefined>): string => {
    let h = 2166136261;
    for (const part of parts) {
      const s = String(part ?? '');
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      h ^= 124;
    }
    return (h >>> 0).toString(36);
  };

  const FIRST_BATCH = 20;
  const NEXT_BATCH = 24;
  const listQueues = new WeakMap<HTMLElement, number>();

  function fillLadder<T>(
    host: HTMLElement,
    rows: readonly T[],
    make: (item: T, index: number) => HTMLElement,
  ): void {
    /* Each list owns its queue, so a board switch never truncates another pane's
       rows. A queue stops the moment its host is replaced (or the view is gone). */
    const run = (listQueues.get(host) ?? 0) + 1;
    listQueues.set(host, run);
    let at = 0;
    const step = (limit: number): void => {
      if (listQueues.get(host) !== run || !host.isConnected) return;
      const end = Math.min(rows.length, at + limit);
      const frag = document.createDocumentFragment();
      for (; at < end; at++) frag.append(make(rows[at], at));
      host.append(frag);
      if (at < rows.length) requestAnimationFrame(() => step(NEXT_BATCH));
    };
    step(FIRST_BATCH);
  }

  const lastLoad: Partial<Record<Board, number>> = {};
  const BOARD_TTL = 15_000;

  /** Clean user handle: "@username" when Telegram provides one, else first name, else null. */
  const youHandle = (): string | null => {
    const u = tgUser();
    if (u?.username) {
      const h = u.username.trim().replace(/^@+/, '').slice(0, 32);
      if (h) return `@${h}`;
    }
    const full = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
    if (full && full.toLowerCase() !== 'you') return full.slice(0, 24);
    return null;
  };

  /** "You (@Username)" — never the glitchy "You · You". Falls back to plain "You". */
  const youLabel = (): string => {
    const h = youHandle();
    return h ? `You (${h})` : 'You';
  };

  /** The bare name a roster row carries — a handle is not a name, and "You" is last. */
  const youName = (): string => {
    const u = tgUser();
    const full = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
    if (full && full.toLowerCase() !== 'you') return full.slice(0, 20);
    if (u?.username) return u.username.slice(0, 20);
    return 'You';
  };

  const myTrophyScore = (): number => myTiq();

  const soloStandingEl = (): HTMLElement | null =>
    document.getElementById('solo-standing');

  /* ---------- squad dock helpers ---------- */

  const squadDock = (): HTMLElement | null =>
    document.getElementById('ranks-dock') ?? document.getElementById('squad-dock');

  const openSquadSheet = (): void => {
    (document.getElementById('team-chip') as HTMLButtonElement | null)?.click();
  };

  /* ---------- claim a Telegram channel/group as an official squad ----------
     Two steps, not one form: the link is verified before the identity is asked
     for, and step 2 carries a live row in the exact ladder grammar. The name and
     crest tag travel with the request; the worker verifies ownership exactly as
     before and persists both. */

  const regEls = {
    sheet: document.getElementById('sheet-squad-register'),
    body: document.querySelector<HTMLElement>('#sheet-squad-register .sheet-body'),
    input: document.getElementById('squad-reg-input') as HTMLInputElement | null,
    name: document.getElementById('squad-reg-name') as HTMLInputElement | null,
    tag: document.getElementById('squad-reg-tag') as HTMLInputElement | null,
    stepLabel: document.getElementById('squad-reg-step'),
    step1: document.getElementById('squad-reg-step-1'),
    step2: document.getElementById('squad-reg-step-2'),
    back: document.getElementById('squad-reg-back') as HTMLButtonElement | null,
    track: [...document.querySelectorAll<HTMLElement>('#sheet-squad-register .sqr-track i')],
    detect: document.getElementById('squad-reg-detect'),
    detectText: document.getElementById('squad-reg-detect-t'),
    previewMark: document.getElementById('squad-reg-preview-mark'),
    previewName: document.getElementById('squad-reg-preview-name'),
    previewMembers: document.getElementById('squad-reg-preview-members'),
    previewNote: document.getElementById('squad-reg-preview-note'),
    error: document.getElementById('squad-reg-error'),
    submit: document.getElementById('squad-reg-submit') as HTMLButtonElement | null,
    spinner: document.getElementById('squad-reg-spinner'),
    label: document.getElementById('squad-reg-label'),
    bot: document.getElementById('squad-reg-bot'),
  };
  if (regEls.bot) regEls.bot.textContent = `@${BOT_HANDLE}`;
  let registering = false;
  let regStep: 1 | 2 = 1;
  let tagTouched = false;

  const registerHandle = (): string => cleanChatReference(regEls.input?.value ?? '');

  function showRegisterError(message: string): void {
    if (!regEls.error) return;
    regEls.error.textContent = message;
    regEls.error.hidden = false;
    regEls.error.scrollIntoView({ block: 'nearest' });
  }

  function clearRegisterError(): void {
    if (regEls.error) regEls.error.hidden = true;
  }

  function setRegisterStep(step: 1 | 2, focus = false): void {
    regStep = step;
    if (regEls.step1) regEls.step1.hidden = step !== 1;
    if (regEls.step2) regEls.step2.hidden = step !== 2;
    if (regEls.stepLabel) {
      regEls.stepLabel.textContent = `${step} / 2`;
      regEls.stepLabel.setAttribute('aria-label', `Step ${step} of 2`);
    }
    for (const [i, seg] of regEls.track.entries()) seg.classList.toggle('is-on', i < step);
    if (regEls.back) regEls.back.hidden = step !== 2;
    if (regEls.label && !registering) regEls.label.textContent = step === 1 ? 'Continue' : 'Launch Squad';
    if (focus) (step === 1 ? regEls.input : regEls.name)?.focus({ preventScroll: true });
  }

  function setRegisterBusy(busy: boolean): void {
    registering = busy;
    if (regEls.submit) {
      regEls.submit.disabled = busy;
      regEls.submit.toggleAttribute('aria-busy', busy);
    }
    if (regEls.back) regEls.back.disabled = busy;
    if (regEls.spinner) regEls.spinner.hidden = !busy;
    if (regEls.label) regEls.label.textContent = busy ? 'Launching…' : regStep === 1 ? 'Continue' : 'Launch Squad';
  }

  function updateRegisterDetection(): void {
    const handle = registerHandle();
    if (regEls.detect) regEls.detect.hidden = !handle;
    if (regEls.detectText) regEls.detectText.textContent = handle;
  }

  function syncRegisterPreview(): void {
    const handle = registerHandle();
    const typed = (regEls.name?.value ?? '').trim();
    const name = typed || 'Your squad';
    const tag = cleanTag(regEls.tag?.value ?? '');
    const mark = tag || (name.charAt(0) || 'S').toUpperCase();
    if (regEls.previewMark) {
      regEls.previewMark.textContent = mark;
      regEls.previewMark.dataset.len = String(mark.length);
    }
    if (regEls.previewName) regEls.previewName.textContent = name;
    if (regEls.previewMembers) regEls.previewMembers.textContent = '— members';
    if (regEls.previewNote) {
      regEls.previewNote.textContent = handle
        ? `${handle} · members and TIQ sync when you launch.`
        : 'Members and TIQ sync when you launch.';
    }
  }

  function suggestTag(name: string, handle: string): string {
    const initials = name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0))
      .join('')
      .toUpperCase();
    if (initials.length >= 2) return cleanTag(initials) || cleanTag(initials.slice(0, 2));
    const fromHandle = handle.replace(/^@/, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (initials.length === 1) {
      return cleanTag(initials + fromHandle.charAt(0)) || cleanTag(fromHandle.slice(0, 2)) || 'SQ';
    }
    return cleanTag(fromHandle.slice(0, 2)) || 'SQ';
  }

  function openSquadRegister(): void {
    if (!regEls.sheet) return;
    if (regEls.input) regEls.input.value = '';
    if (regEls.name) regEls.name.value = '';
    if (regEls.tag) regEls.tag.value = '';
    tagTouched = false;
    clearRegisterError();
    updateRegisterDetection();
    syncRegisterPreview();
    setRegisterBusy(false);
    setRegisterStep(1);
    api.sheets.open(regEls.sheet);
    if (regEls.body) regEls.body.scrollTop = 0;
    impact('light');
    regEls.input?.focus({ preventScroll: true });
  }

  function goToRegisterIdentity(): void {
    const handle = registerHandle();
    if (!handle) {
      const message = t('enlistErrHandle');
      showRegisterError(message);
      showToast(message, 'warning');
      notify('warning');
      regEls.input?.focus({ preventScroll: true });
      return;
    }
    if (regEls.input) regEls.input.value = handle;
    updateRegisterDetection();
    clearRegisterError();
    if (regEls.name && !regEls.name.value.trim()) regEls.name.value = displayNameOf(handle);
    if (regEls.tag && !tagTouched) regEls.tag.value = suggestTag(regEls.name?.value ?? '', handle);
    syncRegisterPreview();
    setRegisterStep(2, true);
    if (regEls.body) regEls.body.scrollTop = 0;
  }

  async function submitSquadRegistration(): Promise<void> {
    if (registering) return;
    if (regStep === 1) { goToRegisterIdentity(); return; }

    const handle = registerHandle();
    if (!handle) {
      setRegisterStep(1, true);
      showRegisterError(t('enlistErrHandle'));
      return;
    }
    const name = (regEls.name?.value ?? '').trim().slice(0, 32);
    const tag = cleanTag(regEls.tag?.value ?? '');
    if (!name) {
      showRegisterError('Give your squad a name.');
      regEls.name?.focus({ preventScroll: true });
      return;
    }
    if (!tag) {
      showRegisterError('Pick a 2–3 letter tag for the crest.');
      regEls.tag?.focus({ preventScroll: true });
      return;
    }
    if (regEls.tag) regEls.tag.value = tag;
    clearRegisterError();
    setRegisterBusy(true);
    const result = await registerSquadWithTelegram(handle, { name, tag });
    setRegisterBusy(false);
    if (result.ok) {
      notify('success');
      impact('medium');
      showToast('Squad successfully registered!', 'success');
      api.sheets.close();
      loadedBoard.guilds = false;
      selectBoard('guilds');
      return;
    }
    notify('error');
    impact('light');
    showToast(result.message, 'error');
    if (result.error === 'invalid_tag') {
      showRegisterError(result.message);
      regEls.tag?.focus({ preventScroll: true });
      return;
    }
    setRegisterStep(1, true);
    showRegisterError(result.message);
  }

  document.getElementById('squad-reg-open')?.addEventListener('click', () => openSquadRegister());
  window.addEventListener('detour:squad-register', () => openSquadRegister());
  regEls.submit?.addEventListener('click', () => { void submitSquadRegistration(); });
  regEls.back?.addEventListener('click', () => {
    clearRegisterError();
    setRegisterStep(1, true);
  });
  regEls.input?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void submitSquadRegistration();
  });
  regEls.name?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    regEls.tag?.focus({ preventScroll: true });
    regEls.tag?.select();
  });
  regEls.tag?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void submitSquadRegistration();
  });
  regEls.input?.addEventListener('input', () => {
    clearRegisterError();
    updateRegisterDetection();
    syncRegisterPreview();
  });
  regEls.name?.addEventListener('input', () => {
    if (!tagTouched && regEls.tag) regEls.tag.value = suggestTag(regEls.name?.value ?? '', registerHandle());
    clearRegisterError();
    syncRegisterPreview();
  });
  regEls.tag?.addEventListener('input', () => {
    const clean = (regEls.tag?.value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
    if (regEls.tag && regEls.tag.value !== clean) regEls.tag.value = clean;
    tagTouched = true;
    clearRegisterError();
    syncRegisterPreview();
  });

  /**
   * The squad's one invite link: `?startapp=squad_<id>`. Copying it is the whole action — the
   * leader pastes it into the channel and every tap lands on this squad's join card.
   */
  const inviteSquad = (s: RankedSquad): void => {
    const url = squadInviteUrl(s.id);
    if (!url) {
      notify('warning');
      showToast(t('linkCopyFailed'), 'warning');
      return;
    }
    const done = (ok: boolean): void => {
      if (!ok) {
        notify('warning');
        showToast(t('linkCopyFailed'), 'warning');
        return;
      }
      notify('success');
      impact('medium');
      showToast(t('linkCopied'), 'success');
    };
    try {
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(url).then(() => done(true), () => done(false));
        return;
      }
    } catch {
      /* fall through to the legacy path below */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', 'true');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      done(ok);
    } catch {
      done(false);
    }
  };

  /** 1240 -> "1.2k", 986 -> "986" — keeps the sub line on one row. */
  const compactCount = (n: number): string => {
    if (!Number.isFinite(n) || n < 0) return '0';
    if (n < 1000) return String(Math.floor(n));
    const v = n / 1000;
    const s = v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
    return `${s}k`;
  };

  /* ---------- top-level paint ---------- */

  const isRanksVisible = (): boolean => {
    const el = document.getElementById('s-ranks') ?? document.getElementById('s-compete');
    return !!el && !el.hidden;
  };

  /** The arena's reading, as the season capsule and its plate need it. */
  type Season = ReturnType<typeof arena>;

  /** Persian digits inside a translated sentence. A Latin clock keeps its own numerals. */
  const langDigits = (value: string): string =>
    lang === 'fa' ? value.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]) : value;

  /**
   * The season line under the wordmark. The built-in season is translated
   * (`فصل ۵: نبرد ذهن‌ها`), while a title the operator typed in the Command Center is shown
   * exactly as typed — the panel owns that copy, not the dictionary.
   */
  function seasonTitle(a: Season): string {
    const typed = (a.seasonName || '').trim();
    const named = /^season\s+\d+\s*[:\-·]?\s*(.*)$/i.exec(typed)?.[1]?.trim() ?? typed;
    if (!named || /^mind\s*clash$/i.test(named)) {
      return t('ranksSeasonTitle').replace('{season}', langDigits(String(a.seasonNo)));
    }
    return seasonLabel(a);
  }

  /**
   * The capsule in the player's language. The day count is a sentence (`{d} روز مانده`), so its
   * figure takes the language's own digits; the h/m code inside the last two days is an
   * instrument reading and stays Latin, exactly as the app's other clocks do.
   */
  function seasonCountdown(
    a: Season,
    now: number,
    pill: { value: string },
  ): { kicker: string; value: string } {
    const left = a.endsAt - now;
    if (a.status === 'finale' || left <= 0) {
      return {
        kicker: t(a.status === 'finale' ? 'ranksFinale' : 'ranksSeasonK'),
        value: t('ranksLocked'),
      };
    }
    if (left >= 48 * 3600_000) {
      const days = Math.max(1, Math.ceil(left / 86400_000));
      return {
        kicker: t('ranksEndsIn'),
        value: t('ranksDaysLeft').replace('{d}', langDigits(String(days))),
      };
    }
    return { kicker: t('ranksClosingIn'), value: pill.value };
  }

  function paintRanks(): void {
    paintSeason();
    for (const b of boardBtns) b.setAttribute('aria-selected', String(b.dataset.board === board));
    if (boardSwitch) boardSwitch.dataset.active = board;
    for (const k of Object.keys(panes) as Board[]) {
      const pane = panes[k];
      if (pane) pane.hidden = k !== board;
    }
    // "Your Standing" is the Top Minds HUD. Nations paints its own nation strip.
    const standing = soloStandingEl();
    if (standing) standing.hidden = board !== 'minds';
    // The squad banner belongs EXCLUSIVELY to the Intellect Guilds board.
    const regBar = document.getElementById('squad-reg-bar');
    if (regBar) regBar.hidden = board !== 'guilds';
    const dock = squadDock();
    if (dock) dock.hidden = board !== 'guilds';
    if (board === 'guilds') paintSquadDock();
    paintGuildHero();
  }

  /**
   * The season line and its capsule: the subtitle carries the Command Center's season
   * title, the pill switches from days to hours inside the last two, and both are
   * recomputed on every tick so the beacon never pulses beside a stale figure.
   */
  function paintSeason(): void {
    const a = arena();
    const now = Date.now();
    const pill = countdownPill(a, now);
    const copy = seasonCountdown(a, now, pill);
    if (seasonText) seasonText.textContent = copy.value;
    if (seasonKicker) seasonKicker.textContent = copy.kicker;
    if (seasonSub) seasonSub.textContent = seasonTitle(a);
    if (seasonChip) {
      seasonChip.dataset.tone = pill.tone;
      seasonChip.setAttribute('title', `${seasonTitle(a)} — ${fullCountdown(a, now)}`);
    }
  }

  function selectBoard(next: Board): void {
    if (next === board && loadedBoard[next]) {
      paintRanks();
      return;
    }
    board = next;
    // The podium is board data: blank it here so the incoming ladder never inherits
    // the previous board's top three while its rows are still loading.
    if (podiumEl) podiumEl.hidden = true;
    paintRanks();
    impact('light');
    void loadBoard(next);
    const sc = document.getElementById('ranks-scroll');
    if (sc) sc.scrollTo({ top: 0 });
  }

  for (const b of boardBtns) {
    b.addEventListener('click', () => {
      const v = b.dataset.board;
      if (v === 'minds' || v === 'guilds' || v === 'nations') selectBoard(v);
    });
  }

  /*
   * A language flip repaints the plate and the capsule in place (the static labels are the
   * markup's own `data-i18n` sweep), then re-reads the visible board so the copy only its rows
   * carry — the contribution tag, the empty states, the podium's spoken labels — moves with it.
   * The cached rows are dropped first: a repaint from cache would leave the old language inside
   * rows the sweep cannot reach.
   */
  onLang(() => {
    paintRanks();
    loadedBoard = {};
    if (isRanksVisible()) void loadBoard(board);
  });

  /* ---------- shared row + copy helpers (Ranks boards) ---------- */

  const num = (n: number): string => n.toLocaleString('en-US');
  /** The handle without its sigil: a card this small reads better as a name. */
  const bare = (handle: string): string => handle.replace(/^@+/, '');
  /** Two letters is all a 30px sphere holds without a second glyph crowding it. */
  const initials = (name: string): string => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
  };
  const tag = (cls: string, text?: string): HTMLElement => {
    const el = document.createElement('span');
    el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const kindWord = (s: RankedSquad): string => (squadKind(s) === 'channel' ? 'channel' : 'group');
  const kindLabel = (s: RankedSquad): string => `Telegram ${kindWord(s)}`;

  function startTick(): void {
    if (tick) return;
    tick = window.setInterval(() => {
      if (!document.hidden && isRanksVisible()) paintSeason();
    }, 1000);
  }

  /* The season capsule is the only thing on this screen that moves. Its clock
     exists while Ranks is on screen and is torn down the moment the route leaves,
     so an idle app never wakes a painter every second. */
  function stopTick(): void {
    if (!tick) return;
    window.clearInterval(tick);
    tick = 0;
  }

  /* ---------- IQ boards (Top Minds | Nations IQ) ----------
  /* ---------- IQ boards (Top Minds | Nations IQ) ----------
     No floating / absolute "you" bar. The user's standing lives in #solo-standing,
     an in-flow summary module directly under the board tabs. The ladder itself is a
     pure list: the podium owns #1-3, so its rows start at #4. */

  async function loadBoard(which: Board): Promise<void> {
    /* The mounted board is the cache. Re-entering the tab inside the freshness
       window shows it without touching the wire; a board that is already
       loading is never asked twice. */
    const now = Date.now();
    if (loadedBoard[which] && now - (lastLoad[which] ?? 0) < BOARD_TTL) return;
    lastLoad[which] = now;
    if (which === 'guilds') loadSquads();
    else if (which === 'nations') await loadNations();
    else await loadMinds();
    loadedBoard[which] = true;
  }

  const podiumOf = (rank: number): '' | 'gold' | 'silver' | 'bronze' =>
    rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';

  /** The ranks screen always has an ISO code in hand, so the emoji tier is skipped. */
  function flagBadge(code: string | null): HTMLElement {
    return flagPhoto(code, 'fp-badge');
  }

  /** A portrait is decoration: only an absolute https URL may reach an `<img>`. */
  function photoSrc(raw: string | null | undefined): string {
    const url = (raw ?? '').trim();
    return /^https:\/\/[^\s]+$/i.test(url) ? url : '';
  }

  /**
   * A player's face is the hero: their Telegram photo over a one-letter monogram,
   * with the nation pinned as a minted micro badge on the avatar's bottom-end
   * corner. The monogram only holds the shape while the real portrait loads, and
   * stays when the seat genuinely has no photo.
   */
  function paintFace(host: HTMLElement, name: string, code: string | null, photo: string | null, eager = false): void {
    const mono = document.createElement('b');
    mono.className = 'av-mono';
    const letter = Array.from(name.trim().replace(/^@+/, ''))[0] ?? '?';
    mono.textContent = letter.toUpperCase();
    host.dataset.len = '1';
    host.append(mono);
    paintPhoto(host, photo, eager);
    if (code) host.append(flagPhoto(code, 'fp-pin'));
  }

  /**
   * One photo layer for any crest: transparent until real pixels arrive, so the
   * monogram underneath is never covered by a slow (or 1x1 placeholder) response.
   * `hidden` would deadlock a lazy image, so the face fades in instead. The podium
   * and the standing strip pass `eager` — they are on screen the moment they paint.
   */
  function paintPhoto(host: HTMLElement, photo: string | null | undefined, eager = false): void {
    const src = photoSrc(photo);
    if (!src) return;
    const img = document.createElement('img');
    img.className = 'av-photo';
    img.alt = '';
    img.loading = eager ? 'eager' : 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    if (eager) img.setAttribute('fetchpriority', 'high');
    img.addEventListener('error', () => img.remove());
    img.addEventListener('load', () => {
      if (img.naturalWidth <= 2 || img.naturalHeight <= 2) {
        img.remove();
        return;
      }
      img.classList.add('is-loaded');
    });
    img.src = src;
    host.append(img);
  }

  /**
   * The channel's verified Telegram photo, cropped to a circle inside any crest well.
   * The monogram underneath holds the shape until real pixels arrive; a hidden channel
   * (the CDN's 1x1 placeholder) or an error keeps the monogram alone. Idempotent, so a
   * repaint that quotes the same URL never thrashes the node.
   */
  function paintCrestPhoto(host: HTMLElement | null, url: string): void {
    if (!host) return;
    const src = photoSrc(url);
    const existing = host.querySelector<HTMLImageElement>(':scope > .stars-ch-photo');
    if (existing?.dataset.src === src) return;
    if (existing) existing.remove();
    if (!src) {
      host.classList.remove('has-photo');
      return;
    }
    const img = document.createElement('img');
    img.className = 'stars-ch-photo';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.dataset.src = src;
    img.addEventListener('error', () => {
      img.remove();
      host.classList.remove('has-photo');
    });
    img.addEventListener('load', () => {
      if (img.naturalWidth <= 2 || img.naturalHeight <= 2) {
        img.remove();
        host.classList.remove('has-photo');
        return;
      }
      img.classList.add('is-loaded');
      host.classList.add('has-photo');
    });
    img.src = src;
    host.append(img);
  }

  /** A guild crest: the channel photo over the call-sign monogram. */
  function paintSquadFace(host: HTMLElement, mark: string, photo: string): void {
    const mono = document.createElement('b');
    mono.className = 'av-mono';
    mono.textContent = mark;
    host.dataset.len = String(mark.length);
    host.append(mono);
    paintPhoto(host, photo);
  }

  /* ---------- Top 3 clay podium ---------- */

  interface PodiumEntry {
    rank: number;
    name: string;
    score: string;
    /** Nation entry: the flag photo, with the ISO chip as its own fallback. */
    code?: string;
    /** Player entry: the crest is their own face, with the nation pinned to its corner. */
    person?: boolean;
    /** Player entry: their Telegram face. Guild entry: the channel's cached photo. */
    photo?: string;
    /** Guild entry: a clay medallion carrying the squad mark. */
    letter?: string;
    /** Guild entry only: the member line under the name. */
    members?: number;
    /** A minted prestige honor the rider wears; its metal also lights the pedestal rim. */
    medal?: WornEdition;
    onTap?: () => void;
    /** What the tap opens, spoken by the accessible name. */
    tapHint?: string;
  }

  /** The minted coin, pinned to the avatar rim. Decorative — the host speaks the honor. */
  function medalPin(w: WornEdition, cls: string): HTMLElement {
    const pin = document.createElement('span');
    pin.className = `medal-pin ${cls}`.trim();
    pin.dataset.accent = w.def.accent;
    pin.setAttribute('aria-hidden', 'true');
    pin.title = w.serial !== null ? `${w.def.name} · ${editionSerialLabel(w.serial)}` : w.def.name;
    pin.innerHTML = badgeCrestHtml(w.def, 'badge-crest medal-coin');
    return pin;
  }

  /** The ledger's serial as a recessed micro tag; null until a real serial exists. */
  function serialChip(w: WornEdition, cls: string, withCap = false): HTMLElement | null {
    if (w.serial === null) return null;
    const chip = document.createElement('span');
    chip.className = `medal-serial ${cls}`.trim();
    chip.dataset.accent = w.def.accent;
    chip.textContent = withCap
      ? `${editionSerialLabel(w.serial)} / ${w.def.cap}`
      : editionSerialLabel(w.serial);
    chip.title = `${w.def.name} · ${editionSerialLabel(w.serial)} of ${w.def.cap}`;
    return chip;
  }

  /**
   * Card order is avatar → name → TIQ → plinth. The plinth stays the last child
   * because it is the card's base: appending the join key after it would float
   * the base into the middle of the card. The name sits directly above the TIQ
   * read; the pedestal already owns the rank.
   */
  function podiumCard(e: PodiumEntry): HTMLElement {
    const card = document.createElement('div');
    card.className = `pod-card ${podiumOf(e.rank)}`;
    card.dataset.rank = String(e.rank);
    if (e.medal) card.dataset.medal = e.medal.def.accent;
    card.setAttribute('role', 'listitem');
    const honor = e.medal
      ? `, ${e.medal.def.name}${e.medal.serial !== null ? ` edition ${e.medal.serial}` : ''}`
      : '';
    const membership = typeof e.members === 'number' ? `, ${membersLine(e.members)}` : '';
    card.setAttribute(
      'aria-label',
      `Rank ${e.rank}: ${e.name}${honor}${membership}, ${e.score} Tactical IQ${e.onTap ? `. Activate to ${e.tapHint ?? 'inspect'}.` : ''}`,
    );

    /* The champion wears the crown; the two challengers wear their metal's medal,
       so the top three share one honor row instead of only the leader carrying it. */
    if (e.rank === 1) card.append(svgIcon('#i-crown', 'pod-crown'));
    else card.append(svgIcon('#i-medal', `pod-rank-medal ${podiumOf(e.rank)}`));

    const av = document.createElement('span');
    av.className = 'pod-av';
    av.setAttribute('aria-hidden', 'true');
    if (e.person) {
      paintFace(av, e.name, e.code ?? null, e.photo ?? null, true);
    } else if (e.code) {
      av.append(flagBadge(e.code));
    } else {
      const mark = (e.letter ?? e.name).replace(/^@/, '').slice(0, 3).toUpperCase();
      paintSquadFace(av, mark, e.photo ?? '');
    }
    if (e.medal) av.append(medalPin(e.medal, 'pod-medal'));

    const nm = document.createElement('span');
    nm.className = 'pod-name';
    /* a mixed English/Persian title is one bidi paragraph, isolated so the
       surrounding rank grid never forces it into the wrong direction */
    nm.dir = 'auto';
    nm.textContent = e.name;
    nm.title = e.name;
    if (e.name.length > 28) nm.classList.add('is-xlong');
    else if (e.name.length > 15) nm.classList.add('is-long');

    let membersEl: HTMLElement | null = null;
    if (typeof e.members === 'number') {
      membersEl = document.createElement('span');
      membersEl.className = 'pod-members';
      membersEl.textContent = membersLine(e.members);
      membersEl.title = `${e.members.toLocaleString('en-US')} members`;
    }

    const iq = document.createElement('span');
    iq.className = 'pod-iq';
    iq.append(svgIcon('#i-brain', 'pod-tiq'));
    const iqN = document.createElement('b');
    iqN.textContent = e.score;
    iq.append(iqN);
    iq.title = `${e.score} Tactical IQ`;

    /* The plinth is the card's base: an embossed metal slab with a stepped
       cornice above and its own aura pooling underneath. The aura is a real
       child so the glow has its own box and never eats the numeral's edge. */
    const step = document.createElement('span');
    step.className = 'pod-foot';
    step.setAttribute('aria-hidden', 'true');
    const aura = document.createElement('i');
    aura.className = 'pod-foot-aura';
    const stepN = document.createElement('b');
    stepN.textContent = String(e.rank);
    step.append(aura);
    if (e.medal) {
      const glow = document.createElement('i');
      glow.className = 'pod-foot-medal';
      step.append(glow);
    }
    step.append(stepN);

    card.append(av, nm);
    if (membersEl) card.append(membersEl);
    card.append(iq, step);
    if (e.onTap) {
      card.classList.add('is-tappable');
      card.tabIndex = 0;
      card.addEventListener('click', e.onTap);
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          e.onTap?.();
        }
      });
    }
    return card;
  }

  /**
   * An empty rung on the Squad IQ board: a frosted, dashed slot that holds the stage
   * together while a league is still filling. The podium is a three-place struct, so a
   * one- or two-squad league keeps all three places instead of floating a champion alone.
   */
  function podiumPlaceholder(rank: number): HTMLElement {
    const card = document.createElement('div');
    card.className = 'pod-card is-awaiting';
    card.dataset.rank = String(rank);
    card.setAttribute('role', 'listitem');
    const label = t('awaitingContender');
    card.setAttribute('aria-label', `Rank ${rank}: ${label}`);

    const av = document.createElement('span');
    av.className = 'pod-av pod-av-awaiting';
    av.setAttribute('aria-hidden', 'true');
    av.append(svgIcon('#i-lock', 'pod-awaiting-ico'));

    const nm = document.createElement('span');
    nm.className = 'pod-name pod-name-awaiting';
    nm.dir = 'auto';
    nm.textContent = label;

    const step = document.createElement('span');
    step.className = 'pod-foot pod-foot-awaiting';
    step.setAttribute('aria-hidden', 'true');
    const stepN = document.createElement('b');
    stepN.textContent = String(rank);
    step.append(stepN);

    card.append(av, nm, step);
    return card;
  }

  function paintPodium(entries: PodiumEntry[]): void {
    const host = podiumEl;
    if (!host) return;
    host.textContent = '';
    const top = entries.filter((e) => e.rank >= 1 && e.rank <= 3);
    if (!top.length) {
      host.hidden = true;
      return;
    }
    const boardName = t(board === 'guilds'
      ? 'ranksBoardSquads'
      : board === 'nations' ? 'ranksBoardNations' : 'ranksBoardMinds');
    /* Only the Squad IQ board stages empty rungs: a top-three nation or mind board is a
       slice of a long field, not a league that has places left to fill. */
    if (board === 'guilds' && top.length < 3) {
      const byRank = new Map(top.map((e) => [e.rank, e]));
      const cards: HTMLElement[] = [];
      for (let rank = 1; rank <= 3; rank++) {
        const entry = byRank.get(rank);
        cards.push(entry ? podiumCard(entry) : podiumPlaceholder(rank));
      }
      host.setAttribute('aria-label', `Top 3 on ${boardName}, ${top.length} of 3 places taken`);
      host.append(...cards);
    } else {
      host.setAttribute('aria-label', `Top ${top.length} on ${boardName}`);
      host.append(...top.map(podiumCard));
    }
    host.hidden = false;
  }

  /** Extruded clay rank key. */
  function rankCrest(rank: number): HTMLElement {
    const rk = document.createElement('span');
    rk.className = 'lb-rank';
    const n = document.createElement('b');
    n.textContent = String(rank);
    rk.append(n);
    return rk;
  }

  /** One clean right-aligned score cell: brain glyph · tabular TIQ. */
  function scoreCell(points: string, title: string): HTMLElement {
    const pt = document.createElement('span');
    pt.className = 'lb-score';
    const line = document.createElement('span');
    line.className = 'lb-line';
    line.append(svgIcon('#i-brain', 'lb-tiq'));
    const num = document.createElement('b');
    num.textContent = points;
    line.append(num);
    pt.append(line);
    pt.title = title;
    return pt;
  }

  interface LadderRow {
    rank: number;
    code: string;
    name: string;
    sub: string | null;
    points: string;
    me: boolean;
    /** A player row wears their face; a nation row keeps its flag as the crest. */
    person?: boolean;
    /** Player row only: the verified Telegram photo, or '' for the monogram. */
    photo?: string;
    /** A minted prestige honor this name holds, read from the ledger's holder index. */
    medal?: WornEdition;
    /** Every ladder row is a control: it opens its own detail sheet. */
    onOpen: () => void;
    /** What the row opens, spoken by the accessible name. */
    openHint: string;
    /** Optional second-line modifier (nation counts use the brief's #94A3B8). */
    subClass?: string;
  }

  /**
   * Shared ladder row: rank crest · identity · tabular score. The tap is always
   * spent on the row's own detail sheet — the mind profile or the nation roster.
   */
  function row(r: LadderRow): HTMLLIElement {
    const { rank, code, name, points } = r;
    const li = document.createElement('li');
    li.className = `rank-row lb-row${r.me ? ' is-you' : ''}`;
    li.dataset.rank = String(rank);
    const honor = r.medal
      ? `, ${r.medal.def.name}${r.medal.serial !== null ? ` edition ${r.medal.serial}` : ''}`
      : '';
    li.setAttribute('aria-label', `#${rank} ${name}${honor} — ${points} Tactical IQ. Activate to ${r.openHint}.`
      + (r.me && isPremiumUser() ? ' VIP.' : ''));
    if (r.me) li.setAttribute('aria-current', 'true');

    const id = document.createElement('span');
    id.className = 'lb-id';
    const avWrap = document.createElement('span');
    avWrap.className = 'lb-avwrap';
    if (r.person) {
      const face = document.createElement('span');
      face.className = 'lb-face';
      face.setAttribute('aria-hidden', 'true');
      paintFace(face, name, code || null, r.photo ?? null);
      avWrap.append(face);
    } else {
      avWrap.append(flagBadge(code));
    }
    if (r.medal) avWrap.append(medalPin(r.medal, 'lb-medal'));
    id.append(avWrap);
    const txt = document.createElement('span');
    txt.className = 'lb-txt';
    const nmLine = document.createElement('span');
    nmLine.className = 'lb-nm';
    const nm = document.createElement('span');
    nm.className = 'lb-name';
    nm.textContent = name;
    nm.title = name;
    nmLine.append(nm);
    /* The serial sits on the name line, and the only other line is the sub read:
       two clean tiers, no third chip wedged between the name and the score. */
    const serial = r.medal ? serialChip(r.medal, 'lb-serial') : null;
    if (serial) nmLine.append(serial);
    txt.append(nmLine);
    if (r.sub) {
      const s = document.createElement('span');
      s.className = `lb-sub${r.subClass ? ` ${r.subClass}` : ''}`;
      const st = document.createElement('span');
      st.className = 'lb-sub-t';
      st.textContent = r.sub;
      s.append(st);
      txt.append(s);
    }
    id.append(txt);

    const cell = scoreCell(points, `${points} Tactical IQ`);
    li.append(rankCrest(rank), id, cell);

    li.tabIndex = 0;
    const run = (): void => { r.onOpen(); };
    li.addEventListener('click', run);
    li.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        run();
      }
    });
    return li;
  }

  /**
   * Your last five, read from the only history the save keeps: a win streak is bounded
   * by the loss that ended the one before it, so everything past it is unrecorded
   * rather than invented.
   */
  function myForm(): FormCell[] {
    const s = profile.stats;
    const wins = Math.min(5, s.streak);
    const loss = s.losses > 0 && s.streak < s.games && wins < 5 ? 1 : 0;
    const known = wins + loss;
    const out: FormCell[] = [];
    for (let i = 5 - known; i > 0; i--) out.push('u');
    if (loss) out.push('l');
    for (let i = 0; i < wins; i++) out.push('w');
    return out;
  }

  /**
   * The Top Minds strip: one 48px row reading where you stand (metal rank badge),
   * who you are (clay avatar · "You" · minted serial) and what you hold (TIQ).
   * It names no league: the strip is your place and your number, nothing else.
   */
  function paintMindsStanding(rows: PlayerRow[] | null): void {
    const host = soloStandingEl();
    if (!host) return;
    host.textContent = '';
    host.classList.add('mh');
    host.hidden = false;

    const tiq = myTrophyScore();
    const field = rows?.length ?? 0;
    const ahead = rows ? rows.filter((p) => p.points > tiq).length : 0;
    const onBoard = profile.stats.games > 0 && field > 0;
    /* the podium owns #1-3 outright, so the strip that follows it can never claim
       one of those places — its standing starts at #4 and counts up from there */
    const myRank = Math.max(4, ahead + 1);
    const pct = onBoard ? Math.max(1, Math.round((myRank / (field + 1)) * 100)) : 100;

    /* the standing as a number: the podium owns 1-3 and the rows carry 4+, so
       until now the one place that names you was the only place that hid it */
    const badge = document.createElement('span');
    badge.className = 'mh-rank';
    badge.textContent = `#${myRank}`;
    badge.title = `Rank ${myRank} of ${field + 1} on Top Minds`;

    /* the same portrait hierarchy as the ladder: your face, with your nation pinned
       to the corner — the strip never demotes you to a bare flag or letter */
    const av = document.createElement('span');
    av.className = 'mh-av';
    const myPhoto = tgUser()?.photo_url || telegramAvatarUrl(tgUser()?.username ?? '');
    paintFace(av, youName(), profile.country, myPhoto || null, true);

    /* the equipped honor is pinned to the avatar rim and its real ledger serial
       rides the identity line — the same coin the Honor sheet and Profile show */
    const own = wornEdition();
    const avWrap = document.createElement('span');
    avWrap.className = 'mh-avwrap';
    avWrap.append(av);
    if (own) avWrap.append(medalPin(own, 'mh-medal'));

    const idWrap = document.createElement('span');
    idWrap.className = 'mh-id';
    const line = document.createElement('b');
    line.className = 'mh-line';
    line.textContent = t('you');
    const serial = own ? serialChip(own, 'mh-serial', true) : null;
    const placement = !onBoard
      ? 'Unranked'
      : pct >= 100
        ? `Below the top ${field}`
        : `Top ${pct}%`;
    const read = onBoard ? `${placement} of minds` : 'Play a race to take a place on the ladder';
    idWrap.append(line);
    if (serial) idWrap.append(serial);

    const score = document.createElement('span');
    score.className = 'mh-score';
    score.append(svgIcon('#i-brain', 'tiq'));
    const num = document.createElement('b');
    num.textContent = tiq.toLocaleString('en-US');
    score.append(num);
    score.title = `${tiq.toLocaleString('en-US')} Tactical IQ`;
    score.setAttribute('aria-label', `${tiq.toLocaleString('en-US')} Tactical IQ`);

    if (onBoard) host.append(badge);
    host.append(avWrap, idWrap, score);

    const where = onBoard ? `Rank ${myRank} of ${field + 1}` : 'Unranked';
    const honor = own
      ? ` · ${own.def.name}${own.serial !== null ? ` edition ${own.serial} of ${own.def.cap}` : ''}`
      : '';
    host.title = `${where} · ${read}${honor}`;
    host.setAttribute(
      'aria-label',
      `Your Standing: ${youLabel()}, ${where}, ${tiq.toLocaleString('en-US')} Tactical IQ, ${read}${honor}`,
    );
  }

  /* ---------- the mind sheet: one ladder name's cognitive profile (bottom clay sheet) ----------
     One panel, two shapes. A *mind* is a read-only dossier: its challenge key is parked, and
     the primary key opens that player's own squad when the local registry knows one. A *guild*
     never gets the four-axis read — a channel's average Squad IQ is not a mind — it gets density
     and its real join / invite key. */

  const msEls = {
    sheet: document.getElementById('sheet-mind'),
    av: document.getElementById('ms-av'),
    photo: document.getElementById('ms-av-img') as HTMLImageElement | null,
    rank: document.getElementById('ms-rank'),
    marks: document.querySelector<HTMLElement>('#sheet-mind .ms-marks'),
    flag: document.getElementById('ms-flag'),
    name: document.getElementById('ms-name'),
    sub: document.getElementById('ms-sub'),
    body: document.getElementById('ms-body'),
    challenge: document.getElementById('ms-challenge') as HTMLButtonElement | null,
    guild: document.getElementById('ms-guild') as HTMLButtonElement | null,
  };

  /** The last field each board loaded — the percentile ring has to be a rank over something. */
  let mindsField: PlayerRow[] = [];
  let guildField: RankedSquad[] = [];
  /** Guards the guild photo against a late load from a sheet that has since changed face. */
  let msPhotoSeq = 0;
  /** The medallion a rival stands on that is not under its shield — the dossier's one live offer. */
  interface SeizeOffer { def: BadgeDef; serial: number }

  /** What the two keys at the foot of the open sheet are allowed to do right now. */
  let msPending: { kind: 'mind'; name: string; tiq: number; squad: RankedSquad | null; seize: SeizeOffer | null } | { kind: 'guild'; squad: RankedSquad } | null = null;

  /** A guild wears a community photo and one rank badge; clearing them keeps a mind clean. */
  function msClearGuild(): void {
    msPhotoSeq++;
    const img = msEls.photo;
    if (img) {
      img.hidden = true;
      img.removeAttribute('src');
    }
    if (msEls.rank) {
      msEls.rank.hidden = true;
      delete msEls.rank.dataset.rank;
    }
    msEls.marks?.classList.remove('is-guild');
    msEls.sheet?.classList.remove('is-guild');
  }

  /**
   * The shared head of both sheets: monogram, nation flag, name, the sub line — and the
   * seat's own portrait. `photo` is the real Telegram image; it sits over the letter, and a
   * 1x1 CDN placeholder leaves the monogram in place instead of painting a broken square.
   */
  function msHead(letter: string, code: string | null, name: string, sub: string, photo?: string | null): void {
    const { av, flag, name: nm, sub: tr } = msEls;
    msClearGuild();
    if (av) {
      av.textContent = letter;
      av.dataset.len = String(letter.length);
    }
    const img = msEls.photo;
    if (img) {
      const seq = ++msPhotoSeq;
      const src = photoSrc(photo);
      img.hidden = true;
      if (src) {
        img.onload = () => { if (seq === msPhotoSeq) img.hidden = img.naturalWidth <= 2 || img.naturalHeight <= 2; };
        img.onerror = () => { if (seq === msPhotoSeq) img.hidden = true; };
        img.src = src;
      } else {
        img.removeAttribute('src');
      }
    }
    if (flag) {
      flag.textContent = '';
      if (code) flag.append(flagPhoto(code, 'fp-ms'));
    }
    if (nm) {
      nm.dir = 'auto';
      nm.textContent = name;
      nm.title = name;
    }
    if (tr) {
      tr.textContent = sub;
      tr.title = sub;
    }
  }

  /**
   * The guild face of the same header: the community's own Telegram photo over the
   * monogram, its rank minted once as a metallic corner badge, and a type tag that
   * carries the handle instead of repeating the rank the badge already spells out.
   */
  function msGuildHead(s: RankedSquad, label: string): void {
    const kind = squadKind(s);
    msHead(squadMark(s), null, label, '');
    const tr = msEls.sub;
    if (tr) {
      const tag = document.createElement('span');
      tag.className = 'ms-kind';
      tag.textContent = kind === 'group' ? t('squadTgGroup') : t('squadTgChannel');
      const dot = document.createElement('i');
      dot.className = 'ms-sub-dot';
      dot.setAttribute('aria-hidden', 'true');
      const handle = document.createElement('b');
      handle.className = 'ms-handle';
      handle.textContent = s.handle;
      handle.dir = 'ltr';
      tr.replaceChildren(tag, dot, handle);
      tr.title = `${tag.textContent} · ${s.handle}`;
    }
    msEls.marks?.classList.add('is-guild');
    msEls.sheet?.classList.add('is-guild');
    const rank = msEls.rank;
    if (rank) {
      rank.textContent = `#${s.rank}`;
      rank.dataset.rank = s.rank === 1 ? 'gold' : s.rank === 2 ? 'silver' : s.rank === 3 ? 'bronze' : 'num';
      rank.hidden = false;
    }
    const img = msEls.photo;
    if (img) {
      img.hidden = true;
      const seq = ++msPhotoSeq;
      const src = squadAvatarUrl(s);
      if (src) {
        /* the CDN answers a hidden channel with a 1x1 placeholder, so a tiny natural
           size keeps the monogram instead of painting a broken square */
        img.onload = () => { if (seq === msPhotoSeq) img.hidden = img.naturalWidth <= 2 || img.naturalHeight <= 2; };
        img.onerror = () => { if (seq === msPhotoSeq) img.hidden = true; };
        img.src = src;
      } else {
        img.removeAttribute('src');
      }
    }
  }

  function msHero(points: string, pct: number, sub: string, squad = false): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = squad ? 'ms-hero is-squad' : 'ms-hero';
    const col = document.createElement('span');
    col.className = 'ms-hero-id';
    const kick = document.createElement('small');
    kick.className = 'ms-hero-k';
    kick.textContent = squad ? t('squadAvgIq') : t('arenaTiqLabel');
    const iq = document.createElement('span');
    iq.className = 'ms-iq';
    iq.append(svgIcon('#i-brain', 'tiq'));
    const num = document.createElement('b');
    num.textContent = points;
    iq.append(num);
    const line = document.createElement('small');
    line.className = 'ms-hero-sub';
    line.textContent = sub;
    line.title = sub;
    col.append(kick, iq, line);
    const split = document.createElement('i');
    split.className = 'ms-hero-split';
    split.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('b');
    inner.textContent = `${pct}%`;
    const ringCol = document.createElement('span');
    ringCol.className = 'ms-ring-col';
    const cap = document.createElement('small');
    cap.className = 'ms-ring-c';
    cap.textContent = t('percentile');
    ringCol.append(percentRing(pct, inner, 'ms-ring'), cap);
    wrap.append(col, split, ringCol);
    return wrap;
  }

  /** Caption over content, in the same engraved-cap voice the podium band uses. */
  function msSection(title: string, ...kids: HTMLElement[]): HTMLElement {
    const wrap = document.createElement('section');
    wrap.className = 'ms-block';
    const h = document.createElement('h3');
    h.className = 'ms-h';
    h.textContent = title;
    wrap.append(h, ...kids);
    return wrap;
  }

  /** Three recessed obsidian cells: results at a glance — no bars, no RPG axes. */
  function msStatCapsule(stats: MindStat[]): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'ms-stats';
    wrap.setAttribute('role', 'list');
    for (const s of stats) {
      const cell = document.createElement('div');
      cell.className = 'ms-stat';
      cell.setAttribute('role', 'listitem');
      cell.title = `${s.label}: ${s.value}`;
      const v = document.createElement('b');
      v.className = 'ms-stat-v';
      v.textContent = s.value;
      const l = document.createElement('small');
      l.className = 'ms-stat-l';
      l.textContent = s.label;
      cell.append(v, l);
      wrap.append(cell);
    }
    return wrap;
  }

  /* ---------- the relic vault: the three honors this seat holds, on lit pedestals ----------
     A rival's shelf is read from the ledger's own holder index, so a supply reading that has
     not landed says nothing at all rather than printing three empty sockets as a verdict.
     Every pedestal is a door into that honor's collector card, and the card hands the
     dossier back when it is dismissed. */

  /** The honors this dossier seat holds — rarest edition first — or null while the ledger is silent. */
  function relicsOf(p: PlayerRow): WornEdition[] | null {
    if (p.id === 'you') {
      return BADGES
        .filter((def) => isBadgeUnlocked(def.id))
        .map((def) => ({ def, serial: badgeEdition(def.id).serial }))
        .sort((a, b) => a.def.cap - b.def.cap)
        .slice(0, 3);
    }
    const wanted = p.name.trim().toLowerCase();
    let read = false;
    const held: WornEdition[] = [];
    for (const def of BADGES) {
      const holders = badgeHolders(def.id);
      if (holders === null) continue;
      read = true;
      const hit = holders.find((h) => h.name.trim().toLowerCase() === wanted);
      if (hit) held.push({ def, serial: hit.serial });
    }
    if (!read) return null;
    return held.sort((a, b) => a.def.cap - b.def.cap).slice(0, 3);
  }

  /** One minted honor: a metallic frame over its own aura, engraved with the serial it carries.
      On a rival's shelf it also wears its shelter, so the clock says which pedestals can be called out. */
  function msRelicPedestal(w: WornEdition, onBack: () => void, guardedHours: number | null): HTMLElement {
    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'relic-socket is-owned';
    key.dataset.accent = w.def.accent;
    if (guardedHours !== null) key.dataset.shelter = guardedHours > 0 ? 'guarded' : 'open';

    const halo = document.createElement('i');
    halo.className = 'relic-halo';
    halo.setAttribute('aria-hidden', 'true');

    const frame = document.createElement('span');
    frame.className = 'relic-frame';
    frame.innerHTML = badgeCrestHtml(w.def, 'badge-crest relic-coin');

    const tag = document.createElement('small');
    tag.className = 'relic-tag';
    /* the serial is Latin digits behind a № mark: isolated, a Persian sheet cannot reorder it */
    tag.dir = 'ltr';
    tag.textContent = w.serial !== null ? `№ ${String(w.serial).padStart(3, '0')}` : 'LIMITED';

    key.append(halo, frame, tag);
    key.title = w.serial !== null ? `${w.def.name} · ${editionSerialLabel(w.serial)}` : w.def.name;
    key.setAttribute('aria-label', `${w.def.name} — ${t('msRelicView')}`);
    key.addEventListener('click', () => openRelicCard(w.def.id, onBack));
    return key;
  }

  /** An unfilled socket: a recessed silhouette, decorative — it promises nothing. */
  function msRelicSocket(): HTMLElement {
    const socket = document.createElement('span');
    socket.className = 'relic-socket is-empty';
    socket.setAttribute('aria-hidden', 'true');
    const ghost = document.createElement('i');
    ghost.className = 'relic-ghost';
    socket.append(ghost);
    return socket;
  }

  /** One line under the shelf: the soonest this rival's guard comes off, or that it is already off. */
  function msShelterNote(relics: WornEdition[]): HTMLElement {
    const note = document.createElement('p');
    note.className = 'ms-shelter';
    const read = relics
      .filter((w): w is WornEdition & { serial: number } => w.serial !== null)
      .map((w) => relicShelter(w.def.id, w.serial));
    if (read.length === 0) { note.hidden = true; return note; }
    if (read.some((s) => !s.sheltered)) {
      note.dataset.state = 'open';
      note.textContent = t('seizeExposed');
      return note;
    }
    const soonest = read.reduce((a, b) => (b.hoursLeft < a.hoursLeft ? b : a));
    note.dataset.state = 'guarded';
    note.textContent = t('seizeSheltered').replace('{h}', soonest.hoursLeft.toLocaleString('en-US'));
    return note;
  }

  function msRelicVault(relics: WornEdition[], onBack: () => void, rival: boolean): HTMLElement {
    const shelf = document.createElement('div');
    shelf.className = 'relic-showcase-row';
    for (let i = 0; i < 3; i++) {
      const w = relics[i];
      const hours = w && rival && w.serial !== null ? relicShelter(w.def.id, w.serial).hoursLeft : null;
      shelf.append(w ? msRelicPedestal(w, onBack, hours) : msRelicSocket());
    }
    const block = msSection(t('msRelicVault'), shelf);
    /* a player's own shelf needs no verdict — only a rival's says whether it can be called out */
    if (rival) block.append(msShelterNote(relics));
    return block;
  }

  function msFormStrip(form: FormCell[]): HTMLElement {
    const rowEl = document.createElement('div');
    rowEl.className = 'ms-form';
    const dots = document.createElement('span');
    dots.className = 'ms-dots';
    const read = form.map((c) => (c === 'w' ? 'W' : c === 'l' ? 'L' : 'unrecorded')).join(', ');
    dots.setAttribute('aria-label', `Last five, newest on the right: ${read}.`);
    for (const c of form) {
      const d = document.createElement('i');
      d.className = `ms-dot ${c}`;
      d.textContent = c === 'w' ? 'W' : c === 'l' ? 'L' : '·';
      dots.append(d);
    }
    rowEl.append(dots);
    return rowEl;
  }

  /** Form reads as one row: the caption sits beside the five chips, never across from them. */
  function msFormBlock(form: FormCell[]): HTMLElement {
    const wrap = document.createElement('section');
    wrap.className = 'ms-block is-inline';
    const h = document.createElement('h3');
    h.className = 'ms-h';
    h.textContent = t('msForm');
    wrap.append(h, msFormStrip(form));
    return wrap;
  }

  /** Three focused cards: headcount, the squad's per-mind average, and your own share. */
  function msSquadMetrics(s: RankedSquad, mine: boolean, contrib: number): HTMLElement {
    const grid = document.createElement('div');
    grid.className = 'ms-squad-grid';
    grid.setAttribute('role', 'list');
    /* `trophies` is the roster average, so the total is read off the same rows rather
       than re-multiplied (which would round twice). */
    const total = squadTiqSum(s.roster);
    const avg = s.members > 0 ? s.trophies : 0;
    const cards: { icon: string; label: string; value: string; title: string; empty?: boolean; share?: boolean }[] = [
      {
        icon: '#i-users',
        label: t('members'),
        value: s.members.toLocaleString('en-US'),
        title: `${s.members.toLocaleString('en-US')} ${t('members')}`,
      },
      {
        icon: '#i-target',
        label: t('squadAvgIq'),
        value: avg.toLocaleString('en-US'),
        title: `${avg.toLocaleString('en-US')} ${t('squadAvgIq')} · ${total.toLocaleString('en-US')} TIQ / ${s.members.toLocaleString('en-US')}`,
      },
      {
        icon: '#i-brain',
        label: t('squadYourShare'),
        value: mine ? contrib.toLocaleString('en-US') : t('squadNotEnlisted'),
        title: mine ? `${contrib.toLocaleString('en-US')} TIQ ${t('squadYourShare')}` : t('squadNotEnlisted'),
        empty: !mine,
        share: true,
      },
    ];
    for (const cell of cards) {
      const card = document.createElement('div');
      card.className = `ms-squad-card${cell.share ? ' is-share' : ''}${cell.empty ? ' is-empty' : ''}`;
      card.setAttribute('role', 'listitem');
      card.title = cell.title;
      const top = document.createElement('span');
      top.className = 'ms-squad-top';
      top.append(svgIcon(cell.icon, 'ms-squad-ic'));
      const label = document.createElement('small');
      label.className = 'ms-squad-lbl';
      label.textContent = cell.label;
      top.append(label);
      const value = document.createElement('b');
      value.className = 'ms-squad-v';
      value.textContent = cell.value;
      card.append(top, value);
      grid.append(card);
    }
    return grid;
  }

  /** The sprite glyph inside a foot key — join swaps the swords for a copied invite link. */
  function msKeyIcon(btn: HTMLButtonElement | null, href: string): void {
    btn?.querySelector('use')?.setAttribute('href', href);
  }

  /** Two fixed keys: a mind's challenge stays parked unless one of its relics stands exposed,
      and a squad's join/invite key stays live. */
  function msActions(kind: 'mind' | 'guild', label: string, hint: string, seize?: SeizeOffer | null): void {
    const ch = msEls.challenge;
    const gu = msEls.guild;
    if (ch) {
      const span = ch.querySelector<HTMLElement>('span');
      if (span) span.textContent = label;
      ch.setAttribute('aria-label', hint);
      ch.disabled = kind === 'mind' && !seize;
      /* the parked key and the live one are the same plate: only the aura and the lock change */
      ch.classList.toggle('is-seize', kind === 'mind' && !!seize);
      if (ch.disabled) ch.setAttribute('aria-disabled', 'true');
      else ch.removeAttribute('aria-disabled');
    }
    if (gu) {
      const span = gu.querySelector<HTMLElement>('span');
      gu.disabled = false;
      gu.removeAttribute('aria-disabled');
      if (span) span.textContent = kind === 'guild' ? t('squadViewChannel') : t('msViewSquad');
      gu.setAttribute('aria-label', kind === 'guild' ? t('squadViewChannel') : t('msViewSquad'));
    }
  }

  /** The squad a ladder name rides for, when the local registry knows one. */
  function squadOfPlayer(p: PlayerRow): RankedSquad | null {
    if (p.id === 'you') return getMySquad();
    const field = getSquadRanking();
    /* the ladder keys a seat `tg-<id>`, a roster key is the bare Telegram id — fold both */
    const key = (id: string): string => id.trim().replace(/^tg-/, '').toLowerCase();
    const wanted = key(p.id);
    const byId = field.find((s) => s.roster.some((m) => key(m.id) === wanted));
    if (byId) return byId;
    const name = p.name.trim().toLowerCase();
    if (!name) return null;
    return field.find((s) => s.roster.some((m) => m.name.trim().toLowerCase() === name)) ?? null;
  }

  function openMind(p: PlayerRow, rank: number): void {
    const el = msEls.sheet;
    const body = msEls.body;
    if (!el || !body) return;
    const field = mindsField.length;
    const pct = field > 0 ? Math.max(1, Math.min(99, Math.round((rank / (field + 1)) * 100))) : 100;
    const tiq = p.points.toLocaleString('en-US');
    const squad = squadOfPlayer(p);
    const squadName = squad ? squad.name || squad.handle.replace(/^@/, '') : '';
    const wins = p.wins === 1 ? t('msWinOne') : t('msWins').replace('{n}', p.wins.toLocaleString('en-US'));
    /* LRI…PDI keeps "#4" reading as a rank inside the RTL pill */
    const rankTag = `\u2066#${rank}\u2069`;
    /* the sheet wears the same face the ladder row does: their real Telegram photo */
    msHead(p.name.slice(0, 1).toUpperCase() || '?', p.countryCode, p.name, `#${rank} · ${squadName || t('msNoSquad')}`, p.avatar);
    el.setAttribute('aria-label', `Mind profile: ${p.name}, ${tiq} Tactical IQ`);
    body.textContent = '';
    const relics = relicsOf(p);
    const rival = p.id !== 'you';
    /* rarest first, so the offer on the line is the honor that actually costs something */
    const seize = relics && rival
      ? relics.find((w): w is WornEdition & { serial: number } =>
        w.serial !== null && isSeizable(w.def, w.serial)) ?? null
      : null;
    msPending = {
      kind: 'mind',
      name: p.name,
      tiq: p.points,
      squad,
      seize: seize ? { def: seize.def, serial: seize.serial } : null,
    };
    const panels = [msHero(tiq, pct, `${wins} · ${rankTag}`)];
    if (relics) panels.push(msRelicVault(relics, () => openMind(p, rank), rival));
    panels.push(
      msSection(t('msScorecard'), msStatCapsule(rivalStats(p))),
      msFormBlock(rivalForm(p.id, p.trend)),
    );
    body.append(...panels);
    msActions(
      'mind',
      seize ? t('seizeCta') : t('msChallengeMind'),
      seize
        ? `${t('seizeCta')} · ${seize.def.name} · ${editionSerialLabel(seize.serial)}`
        : `${t('msChallengeMind')} · ${t('msChallengeSoon')}`,
      seize,
    );
    const gu = msEls.guild;
    if (gu && squad) {
      gu.setAttribute('aria-label', `${t('msViewSquad')} · ${squadName}`);
    } else if (gu) {
      const span = gu.querySelector<HTMLElement>('span');
      gu.disabled = true;
      gu.setAttribute('aria-disabled', 'true');
      if (span) span.textContent = t('msNoSquad');
      gu.setAttribute('aria-label', `${t('msNoSquad')} · ${p.name}`);
    }
    msEls.challenge?.classList.remove('is-squad');
    msKeyIcon(msEls.challenge, '#i-swords');
    msKeyIcon(msEls.guild, '#i-users');
    impact('light');
    api.sheets.open(el);
  }

  function openGuild(s: RankedSquad): void {
    const el = msEls.sheet;
    const body = msEls.body;
    if (!el || !body) return;
    const mine = getMySquad()?.id === s.id;
    const field = guildField.length || getSquadRanking().length;
    const pct = field > 0 ? Math.max(1, Math.min(99, Math.round((s.rank / (field + 1)) * 100))) : 100;
    const kindLabel = squadKind(s) === 'group' ? t('squadTgGroup') : t('squadTgChannel');
    const label = s.name || s.handle.replace(/^@/, '');
    const contrib = mine ? getMyContribution() : 0;
    const tiq = s.trophies.toLocaleString('en-US');
    msPending = { kind: 'guild', squad: s };
    msGuildHead(s, label);
    el.setAttribute('aria-label', `${label} · ${kindLabel} ${s.handle} · #${s.rank} · ${tiq} TIQ`);
    body.textContent = '';
    body.append(
      msHero(tiq, pct, t('squadLeague').replace('{n}', field.toLocaleString('en-US')), true),
      msSection(t('squadRead'), msSquadMetrics(s, mine, contrib)),
    );
    msActions(
      'guild',
      mine ? t('invite') : t('squadJoinCta'),
      mine ? `${t('invite')} · ${s.handle}` : `${t('squadJoinCta')} · ${s.handle}`,
    );
    msKeyIcon(msEls.challenge, mine ? '#i-link' : '#i-swords');
    msKeyIcon(msEls.guild, '#i-ext');
    msEls.challenge?.classList.add('is-squad');
    /* a join repaints this same open sheet in place — never replay the slide-in or its tap */
    if (el.hidden) {
      impact('light');
      api.sheets.open(el);
    }
  }

  /* ---------- the nation sheet: prestige medallion + national top players ----------
     Every Nations IQ row and podium pillar opens this panel. The medallion carries
     the country's own flag inside a minted ring and its aura follows the standing
     (#1 gold, #2 silver, #3 bronze, everyone else cobalt). The roster is sliced to
     the same head-count the country row prints, so the sheet can never promise
     more players than the ladder named. */

  const ndEls = {
    sheet: document.getElementById('sheet-nation-detail'),
    head: document.getElementById('nd-head'),
    rank: document.getElementById('nd-rank'),
    name: document.getElementById('nd-name'),
    kicker: document.getElementById('nd-kicker'),
    body: document.getElementById('nd-body'),
  };
  /** A nation's live roster is cached per board reading; re-entry is instant, a refresh is real. */
  const nationRosters = new Map<string, NationRoster>();
  let nationSeq = 0;

  const nationAuraOf = (rank: number): 'gold' | 'silver' | 'bronze' | 'cobalt' =>
    rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : 'cobalt';

  function nationHero(c: NationRow): HTMLElement {
    const total = c.players;
    const label = c.name || nameOf(c.code);
    const hero = document.createElement('div');
    hero.className = 'nd-hero';

    const aura = document.createElement('span');
    aura.className = 'nd-aura';
    aura.setAttribute('aria-hidden', 'true');

    const mark = document.createElement('span');
    mark.className = 'nd-mark';
    const coin = document.createElement('span');
    coin.className = 'nd-coin';
    coin.setAttribute('aria-hidden', 'true');
    const face = document.createElement('span');
    face.className = 'nd-coin-face';
    face.append(flagPhoto(c.code, 'fp-medal', 320));
    const gleam = document.createElement('span');
    gleam.className = 'nd-gleam';
    coin.append(face, gleam);
    mark.append(coin);

    const pedestal = document.createElement('span');
    pedestal.className = 'nd-pedestal';
    pedestal.setAttribute('aria-hidden', 'true');

    const totals = document.createElement('div');
    totals.className = 'nd-totals';
    totals.setAttribute('aria-label', `${c.avg.toLocaleString('en-US')} average nation Tactical IQ · ${total.toLocaleString('en-US')} players`);
    const tiq = document.createElement('span');
    tiq.className = 'nd-total is-tiq';
    tiq.append(svgIcon('#i-brain', 'nd-total-ico nd-total-tiq'));
    const tiqN = document.createElement('b');
    tiqN.textContent = c.avg.toLocaleString('en-US');
    const tiqK = document.createElement('small');
    tiqK.textContent = 'TIQ';
    tiq.append(tiqN, tiqK);
    const split = document.createElement('i');
    split.className = 'nd-split';
    split.setAttribute('aria-hidden', 'true');
    const people = document.createElement('span');
    people.className = 'nd-total is-people';
    people.append(svgIcon('#i-users', 'nd-total-ico'));
    const peopleN = document.createElement('b');
    peopleN.textContent = total.toLocaleString('en-US');
    const peopleK = document.createElement('small');
    peopleK.textContent = 'Players';
    people.append(peopleN, peopleK);
    totals.append(tiq, split, people);

    const caption = document.createElement('p');
    caption.className = 'nd-caption';
    caption.textContent = `Rank ${c.rank} of ${nationRows?.length ?? 1} nations worldwide`;

    hero.append(aura, mark, pedestal, totals, caption);
    hero.title = label;
    return hero;
  }

  function nationRosterHead(c: NationRow): HTMLElement {
    const head = document.createElement('header');
    head.className = 'nd-rhead';
    const h = document.createElement('h3');
    h.className = 'nd-rh';
    h.textContent = 'Top players';
    const count = document.createElement('span');
    count.className = 'nd-rh-count';
    count.textContent = `${c.players.toLocaleString('en-US')} players`;
    head.append(h, count);
    return head;
  }

  function nationSkeleton(rows: number): DocumentFragment {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < rows; i++) {
      const li = document.createElement('li');
      li.className = 'nd-row is-skel';
      for (const w of ['w20', 'w60', 'w20']) {
        const s = document.createElement('span');
        s.className = `skel ${w}`;
        li.append(s);
      }
      frag.append(li);
    }
    return frag;
  }

  /** The row's own avatar: initials tinted from its id, with a real minted pin when held. */
  function nationAvatar(m: NationPlayer): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'nd-avwrap';
    const av = document.createElement('b');
    av.className = 'nd-av';
    av.textContent = initials(m.name);
    av.style.setProperty('--nd-hue', String(188 + (hashOf(m.id) % 116)));
    wrap.append(av);
    const honor = m.isYou ? wornEdition() : holderEdition(m.name);
    if (honor) wrap.append(medalPin(honor, 'nd-medal'));
    return wrap;
  }

  function nationRow(m: NationPlayer): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `nd-row${m.isYou ? ' is-you' : ''}`;
    li.dataset.rank = String(m.rank);
    const rk = document.createElement('span');
    rk.className = `nd-rk${m.rank <= 3 ? ` t${m.rank}` : ''}`;
    rk.textContent = String(m.rank);
    rk.setAttribute('aria-hidden', 'true');

    const id = document.createElement('span');
    id.className = 'nd-id';
    const line = document.createElement('span');
    line.className = 'nd-nm';
    const nm = document.createElement('b');
    nm.className = 'nd-pname';
    nm.textContent = m.name;
    nm.title = m.name;
    line.append(nm);
    if (m.isYou && m.name.trim().toLowerCase() !== 'you') {
      const tag = document.createElement('span');
      tag.className = 'nd-you-tag';
      tag.textContent = 'You';
      line.append(tag);
    }
    const sub = document.createElement('small');
    sub.className = 'nd-sub';
    sub.textContent = `${m.wins.toLocaleString('en-US')} wins`;
    id.append(line, sub);

    const score = document.createElement('span');
    score.className = 'nd-score';
    score.append(svgIcon('#i-brain', 'nd-score-ico'));
    const num = document.createElement('b');
    num.textContent = m.tiq.toLocaleString('en-US');
    score.append(num);

    li.append(rk, nationAvatar(m), id, score);
    li.setAttribute(
      'aria-label',
      `#${m.rank} ${m.name}${m.isYou ? ', you' : ''} — ${m.tiq.toLocaleString('en-US')} Tactical IQ, ${m.wins.toLocaleString('en-US')} wins`,
    );
    return li;
  }

  function nationYouCard(c: NationRow, m: NationPlayer, count: number): HTMLElement {
    const label = c.name || nameOf(c.code);
    const card = document.createElement('div');
    card.className = 'nd-you';
    const txt = document.createElement('span');
    txt.className = 'nd-you-txt';
    const kick = document.createElement('small');
    kick.className = 'nd-you-k';
    kick.textContent = `Your standing · Top ${Math.max(1, Math.round((m.rank / Math.max(1, count)) * 100))}%`;
    const line = document.createElement('b');
    line.className = 'nd-you-line';
    line.textContent = `#${m.rank} in ${label}`;
    txt.append(kick, line);
    const score = document.createElement('span');
    score.className = 'nd-score nd-you-score';
    score.append(svgIcon('#i-brain', 'nd-score-ico'));
    const num = document.createElement('b');
    num.textContent = m.tiq.toLocaleString('en-US');
    score.append(num);
    card.append(nationAvatar(m), txt, score);
    card.setAttribute(
      'aria-label',
      `Your standing: #${m.rank} in ${label}, ${m.tiq.toLocaleString('en-US')} Tactical IQ, top ${Math.max(1, Math.round((m.rank / Math.max(1, count)) * 100))} percent of ${count} players`,
    );
    return card;
  }

  function paintNationList(c: NationRow, list: HTMLElement, host: HTMLElement, roster: NationRoster | null): void {
    list.textContent = '';
    if (!roster || (!roster.rows.length && !roster.you)) {
      const empty = document.createElement('li');
      empty.className = 'nd-empty';
      empty.textContent = roster?.live
        ? 'No players have joined this nation yet.'
        : 'The nation roster is unavailable right now.';
      list.append(empty);
      return;
    }
    const you = roster.you ?? roster.rows.find((m) => m.isYou);
    if (you) host.insertBefore(nationYouCard(c, you, roster.total), list);
    const frag = document.createDocumentFragment();
    for (const m of roster.rows) frag.append(nationRow(m));
    list.append(frag);
  }

  async function openNation(c: NationRow): Promise<void> {
    const el = ndEls.sheet;
    const body = ndEls.body;
    if (!el || !body) return;
    const label = c.name || nameOf(c.code);
    el.dataset.aura = nationAuraOf(c.rank);
    if (ndEls.rank) ndEls.rank.textContent = `#${c.rank}`;
    if (ndEls.name) {
      ndEls.name.textContent = label;
      ndEls.name.title = label;
    }
    if (ndEls.kicker) ndEls.kicker.textContent = `#${c.rank} worldwide`;
    el.setAttribute(
      'aria-label',
      `Nation roster: ${label}, #${c.rank} worldwide, ${c.avg.toLocaleString('en-US')} average Tactical IQ across ${c.players.toLocaleString('en-US')} players`,
    );

    body.textContent = '';
    body.scrollTop = 0;
    const rosterHost = document.createElement('section');
    rosterHost.className = 'nd-roster';
    const list = document.createElement('ol');
    list.className = 'nd-list';
    list.setAttribute('aria-label', `Top players in ${label}`);
    list.append(nationSkeleton(6));
    rosterHost.append(nationRosterHead(c), list);
    body.append(nationHero(c), rosterHost);
    api.sheets.open(el);
    impact('light');

    const seq = ++nationSeq;
    const key = `${c.code}|${c.avg}|${c.players}|${profile.country ?? '-'}`;
    let roster = nationRosters.get(key) ?? null;
    if (!roster) {
      try {
        roster = await fetchNationRoster(c.code);
      } catch {
        roster = null;
      }
      if (seq !== nationSeq) return;
      if (roster) nationRosters.set(key, roster);
    }
    if (seq !== nationSeq) return;
    paintNationList(c, list, rosterHost, roster);
  }

  /** Pull the header down to dismiss, the way a native sheet moves under the thumb. */
  function bindNationSwipe(panel: HTMLElement, handle: HTMLElement): void {
    const LIMIT = 78;
    let startY = 0;
    let dy = 0;
    let active = false;
    let pointerId = -1;
    let resetTimer = 0;

    const reset = (): void => {
      window.clearTimeout(resetTimer);
      panel.style.transition = '';
      panel.style.transform = '';
    };

    handle.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if ((e.target as HTMLElement | null)?.closest('button, a, input, textarea, select')) return;
      active = true;
      pointerId = e.pointerId;
      startY = e.clientY;
      dy = 0;
      try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    });
    handle.addEventListener('pointermove', (e) => {
      if (!active || e.pointerId !== pointerId) return;
      dy = Math.max(0, e.clientY - startY);
      if (dy > 0) {
        panel.style.transition = 'none';
        panel.style.transform = `translate3d(0, ${Math.min(dy, 160)}px, 0)`;
      }
    });
    const finish = (e: PointerEvent): void => {
      if (!active || e.pointerId !== pointerId) return;
      active = false;
      window.clearTimeout(resetTimer);
      panel.style.transition = 'transform 180ms ease-out';
      if (dy > LIMIT) {
        panel.style.transform = 'translate3d(0, 102%, 0)';
        api.sheets.close();
        resetTimer = window.setTimeout(reset, 320);
      } else {
        panel.style.transform = '';
        resetTimer = window.setTimeout(reset, 200);
      }
      dy = 0;
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  if (ndEls.sheet && ndEls.head) bindNationSwipe(ndEls.sheet, ndEls.head);

  msEls.challenge?.addEventListener('click', () => {
    const p = msPending;
    if (!p) return;
    if (p.kind === 'mind') {
      /* a mind's key only answers when a medallion is actually standing exposed */
      if (!p.seize) return;
      openSeize(seizeTargetOf(p.seize.def, p.seize.serial, p.name));
      return;
    }
    const wasMine = getMySquad()?.id === p.squad.id;
    squadAction(p.squad, wasMine).run();
    if (!wasMine) {
      /* the key just turned into Invite and the share became yours — repaint the open sheet */
      const next = getSquadRanking().find((s) => s.id === p.squad.id);
      if (next && getMySquad()?.id === next.id) openGuild(next);
    }
  });

  msEls.guild?.addEventListener('click', () => {
    const p = msPending;
    if (!p) return;
    if (p.kind === 'guild') {
      impact('light');
      const handle = cleanHandle(p.squad.handle);
      if (handle) openLink(`https://t.me/${handle.slice(1)}`);
      else openSquadSheet();
      return;
    }
    if (!p.squad) return;
    /* the mind sheet yields the stage: the guild board loads behind and that
       player's own squad profile takes its place in the same panel */
    selectBoard('guilds');
    openGuild(p.squad);
  });

  /**
   * The Nations HUD: one 48px strip that either asks for a flag or wears the
   * chosen nation's standing. Both states are the same button, so the picker
   * opens in place and switching the flag never leaves the ladder.
   */
  function nationsHud(rows: NationRow[]): HTMLElement {
    const hud = document.createElement('button');
    hud.type = 'button';
    hud.className = 'nation-hud';
    /* The save is the only place a nation lives before the socket opens; fold it to the same
       uppercase ISO key the board is cut on, so a stored 'ir' still finds Iran. */
    const code = (profile.country ?? '').trim().toUpperCase();
    const openPicker = (): void => {
      impact('light');
      openCountryPicker(api.sheets);
    };

    if (!code) {
      hud.classList.add('is-unset');
      hud.setAttribute('aria-label', 'No nation selected. Tap to represent your flag.');
      const globe = document.createElement('span');
      globe.className = 'nh-globe';
      globe.append(svgIcon('#i-globe', 'nh-globe-ico'));
      const copy = document.createElement('span');
      copy.className = 'nh-copy';
      copy.textContent = 'No nation selected • Tap to represent your flag';
      const pill = document.createElement('span');
      pill.className = 'nh-pill';
      pill.textContent = 'Select Flag';
      hud.append(globe, copy, pill);
      hud.addEventListener('click', openPicker);
      return hud;
    }

    const hit = rows.find((c) => c.code === code);
    const nm = hit?.name || nameOf(code) || code;
    const rank = document.createElement('span');
    rank.className = `nh-rank${hit ? ` ${podiumOf(hit.rank)}` : ' is-new'}`.trim();
    rank.textContent = hit ? `#${hit.rank}` : '#—';
    rank.title = hit ? `Rank ${hit.rank} on Nations IQ` : 'Waiting for the nation standings';

    const av = document.createElement('span');
    av.className = 'nh-av';
    av.append(flagPhoto(code, 'fp-nation'));

    /* The badge is this seat's own TIQ as the room holds it — the score its nation's average is
       built from. A guest read carries no verified seat, so the save's own ladder TIQ stands in
       rather than an empty zero. */
    const standing = nationFeed?.standing?.code?.toUpperCase() === code
      ? nationFeed.standing
      : null;
    const mine = standing?.tiq || myTrophyScore();
    const average = standing?.avg ?? hit?.avg ?? 0;

    const id = document.createElement('span');
    id.className = 'nh-id';
    const idLine = document.createElement('span');
    idLine.className = 'nh-idline';
    const name = document.createElement('b');
    name.className = 'nh-name';
    name.textContent = nm;
    name.title = nm;
    const tag = document.createElement('span');
    tag.className = 'nh-tag';
    tag.textContent = t('ranksYourContribution');
    idLine.append(name, tag);
    /* The national average rides on the identity tier, under the flag's name, the way a ladder
       row wears its player count. Out of the score column, so a longer national figure can never
       squeeze the country name off a 320px screen. */
    const avgCap = document.createElement('small');
    avgCap.className = 'nh-avg';
    avgCap.textContent = `${t('nationAverageTiq')} ${average.toLocaleString('en-US')}`;
    id.append(idLine, avgCap);

    const score = document.createElement('span');
    score.className = 'nh-score';
    score.append(svgIcon('#i-brain', 'nh-tiq'));
    const num = document.createElement('b');
    num.textContent = mine.toLocaleString('en-US');
    score.append(num);
    score.title = `${mine.toLocaleString('en-US')} Tactical IQ earned · `
      + `${average.toLocaleString('en-US')} ${t('nationAverageTiq')}`;

    hud.classList.add('is-set');
    hud.append(rank, av, id, score);
    const seen = `${nm}, ${hit ? `rank ${hit.rank}` : 'rank pending'}, `
      + `${mine.toLocaleString('en-US')} Tactical IQ earned, ${average.toLocaleString('en-US')} national average`;
    hud.setAttribute('aria-label', `Your Nation: ${seen}. Activate to change your nation.`);
    hud.title = 'Tap to change your nation';
    hud.addEventListener('click', openPicker);
    return hud;
  }

  /** The whole Nations pane from a row set: podium, HUD and ladder. */
  let nationsKey = '';
  function paintNations(rows: NationRow[], force = false): void {
    const el = panes.nations;
    if (!el) return;
    const key = `${lang}|${profile.country ?? ''}|${myTrophyScore()}|`
      + boardSignature(rows.flatMap((c) => [c.rank, c.code, c.name, c.avg, c.players, c.trend, c.delta]));
    if (!force && key === nationsKey) return;
    nationsKey = key;
    paintPodium(rows.slice(0, 3).map((c) => ({
      rank: c.rank,
      name: c.name || nameOf(c.code),
      score: c.avg.toLocaleString('en-US'),
      code: c.code,
      onTap: () => openNation(c),
      tapHint: 'open the nation roster',
    })));
    el.textContent = '';
    el.append(nationsHud(rows));
    if (!rows.length) {
      el.insertAdjacentHTML('beforeend', empty('No nations on the board yet — pick your flag to put yours on it.'));
      return;
    }
    const ol = document.createElement('ol');
    ol.className = 'rank-list';
    el.append(ol);
    fillLadder(ol, rows.slice(3), (c) => row({
      rank: c.rank,
      code: c.code,
      name: c.name || nameOf(c.code),
      sub: `${c.players.toLocaleString('en-US')} players`,
      subClass: 'nd-count',
      points: c.avg.toLocaleString('en-US'),
      me: (profile.country ?? '').trim().toUpperCase() === c.code,
      onOpen: () => openNation(c),
      openHint: 'open the nation roster',
    }));
  }

  async function loadNations(): Promise<void> {
    const el = panes.nations;
    if (!el) return;
    if (!loadedBoard.nations && !nationRows) el.innerHTML = skel(6);
    const feed = await fetchNationBoard(myTrophyScore());
    if (!feed.live) {
      if (!nationRows) el.innerHTML = empty('Rankings unavailable. Check your connection and try again.');
      return;
    }
    nationFeed = feed;
    nationRows = feed.rows;
    paintNations(feed.rows);
  }

  /** Paint the Top Minds podium, ladder and your strip from one loaded field. */
  let mindsKey = '';
  function paintMinds(rows: PlayerRow[], force = false): void {
    const own = wornEdition();
    const key = `${lang}|${isPremiumUser() ? 1 : 0}|${myTrophyScore()}|${profile.stats.games}`
      + `|${profile.country ?? ''}|${own ? `${own.def.id}:${own.serial ?? ''}` : ''}|`
      + boardSignature(rows.flatMap((p) => [p.id, p.name, p.countryCode, p.avatar, p.points, p.wins, p.trend]));
    if (!force && key === mindsKey) return;
    mindsKey = key;
    paintPodium(rows.slice(0, 3).map((p, i) => ({
      rank: i + 1,
      name: p.name,
      score: p.points.toLocaleString('en-US'),
      code: p.countryCode,
      person: true,
      photo: p.avatar,
      medal: holderEdition(p.name) ?? undefined,
      onTap: () => openMind(p, i + 1),
    })));
    const el = panes.minds;
    if (!el) return;
    el.textContent = '';
    const ol = document.createElement('ol');
    ol.className = 'rank-list';
    el.append(ol);
    fillLadder(ol, rows.slice(3), (p, i) => row({
      rank: i + 4,
      code: p.countryCode,
      name: p.name,
      sub: `${p.wins} wins`,
      points: p.points.toLocaleString('en-US'),
      me: p.id === 'you',
      person: true,
      photo: p.avatar,
      medal: holderEdition(p.name) ?? undefined,
      onOpen: () => openMind(p, i + 4),
      openHint: 'open the mind profile',
    }));
    paintMindsStanding(rows);
  }

  /**
   * The ledger's holder index is what names the coins on the podium and rows. It is
   * fetched on entry (not in loadMinds, whose save-driven relaunches would loop with
   * the supply cache write), then the ladder repaints once it lands.
   */
  function refreshLadderMedals(): void {
    const now = Date.now();
    if (now - medalsFetchedAt < 60_000) return;
    medalsFetchedAt = now;
    void refreshBadgeEditions().then(() => {
      if (isRanksVisible() && board === 'minds' && mindsField.length) paintMinds(mindsField, true);
    });
  }

  async function loadMinds(): Promise<void> {
    const el = panes.minds;
    if (!el) return;
    /* a supply refresh can relaunch this load: keep the painted ladder up instead
       of flashing a skeleton under the player's eyes */
    if (!loadedBoard.minds && !mindsField.length) el.innerHTML = skel(6);
    let feed: MindFeed | null = null;
    try {
      feed = await fetchMindLadder(myTrophyScore(), 100);
    } catch {
      feed = null;
    }
    if (!feed?.live) {
      /* a quiet Worker keeps the last real board; a first read says why it is blank */
      if (!mindsField.length) {
        el.innerHTML = empty('Rankings unavailable. Check your connection and try again.');
        paintMindsStanding(null);
      }
      return;
    }
    const rows: PlayerRow[] = feed.rows.map((p) => ({
      id: p.id,
      name: p.name,
      countryCode: p.countryCode,
      avatar: p.avatar,
      points: p.tiq,
      wins: p.wins,
      trend: p.trend,
    }));
    if (!rows.length) {
      mindsField = [];
      el.innerHTML = empty('No players ranked yet.');
      paintMindsStanding(null);
      return;
    }
    mindsField = rows;
    paintMinds(rows);
  }

  /* ---------- Intellect Guilds: Telegram channel / community ranking ---------- */

  /** Bind a guild (or copy an invite for your own) — one spec, used by the row and the podium. */
  function squadAction(s: RankedSquad, mine: boolean): { label: string; mine: boolean; hint: string; run: () => void } {
    if (mine) {
      return { label: 'Invite', mine: true, hint: `Invite to ${s.handle}: copy squad invite`, run: () => inviteSquad(s) };
    }
    return {
      label: 'Join',
      mine: false,
      hint: `Join ${s.handle}`,
      run: () => {
        impact('light');
        /* The roster is the registry's, so the join is too: this waits for the answer, then
           repaints the board from the roster the Worker just confirmed. */
        void joinSquadOnServer(s.id).then((result) => {
          if (!result.ok) {
            notify('warning');
            showToast(result.message || t('enlistErrOffline'), 'warning');
            return;
          }
          notify('success');
          impact('medium');
          loadSquads();
        });
      },
    };
  }

  /** The compact glass-to-solid key; `cls` lets the ladder and the podium share the behaviour. */
  function squadKey(a: { label: string; mine: boolean; hint: string; run: () => void }, cls: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `${cls} ${a.mine ? 'is-invite' : 'is-join'}`;
    b.textContent = a.label;
    b.setAttribute('aria-label', a.hint);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      a.run();
    });
    return b;
  }

  /** Hexagonal clay crest: lip and face share one clip, two pixels apart, because
      clip-path throws away the box-shadow the rest of the sheet uses for depth.
      A guild's real channel photo rides inside the face, over the call sign. */
  function hexCrest(letter: string, cls: string, photo = ''): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = `hex ${cls}`;
    wrap.setAttribute('aria-hidden', 'true');
    const face = document.createElement('span');
    face.className = 'hex-face';
    const b = document.createElement('b');
    b.textContent = letter;
    b.dataset.len = String(letter.length);
    face.append(b);
    const src = photoSrc(photo);
    if (src) {
      const img = document.createElement('img');
      img.className = 'hex-photo';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.remove());
      img.addEventListener('load', () => {
        if (img.naturalWidth <= 2 || img.naturalHeight <= 2) {
          img.remove();
          return;
        }
        face.classList.add('has-photo');
      });
      img.src = src;
      face.append(img);
    }
    wrap.append(face);
    return wrap;
  }

  /** "809 members" / "1.2k members" — the one line under a squad name. */
  const membersLine = (members: number): string =>
    `${compactCount(members)} ${members === 1 ? 'member' : 'members'}`;


  const guildHeroEl = (): HTMLElement | null => {
    const existing = document.getElementById('guild-hero');
    if (existing) return existing;
    const sc = document.getElementById('ranks-scroll');
    const parent = sc?.parentElement;
    if (!parent || !sc) return null;
    const el = document.createElement('section');
    el.id = 'guild-hero';
    el.className = 'gh';
    el.hidden = true;
    parent.insertBefore(el, sc);
    return el;
  };

  /**
   * Own-guild hero, pinned above the ladder as a flex sibling of the scroller — so
   * it never overlays a row. When a guild is bound it replaces the bottom dock: the
   * screen states your standing in one place, not two.
   */
  function paintGuildHero(): void {
    const host = guildHeroEl();
    if (!host) return;
    const me = isRanksVisible() && board === 'guilds' ? getMySquad() : null;
    if (!me) { host.hidden = true; return; }
    const dock = squadDock();
    if (dock) dock.hidden = true;
    host.hidden = false;
    host.textContent = '';

    host.append(hexCrest(squadMark(me), 'gh-crest', squadAvatarUrl(me)));

    const txt = document.createElement('span');
    txt.className = 'gh-txt';
    const top = document.createElement('span');
    top.className = 'gh-top';
    const kick = document.createElement('small');
    kick.className = 'gh-kick';
    kick.textContent = 'My squad';
    const rank = document.createElement('b');
    rank.className = 'gh-rank';
    rank.textContent = `#${me.rank}`;
    const members = document.createElement('small');
    members.className = 'gh-members';
    members.textContent = membersLine(me.members);
    members.title = `${me.members.toLocaleString('en-US')} members · ${me.handle}`;
    top.append(kick, rank, members);
    const sub = document.createElement('span');
    sub.className = 'gh-sub';
    const nm = document.createElement('b');
    nm.className = 'gh-name';
    nm.dir = 'auto';
    nm.textContent = me.name || me.handle.replace(/^@/, '');
    nm.title = `${me.name} · ${me.handle}`;
    sub.append(nm);
    txt.append(top, sub);

    const score = document.createElement('span');
    score.className = 'gh-score';
    const line = document.createElement('span');
    line.className = 'gh-line';
    line.append(svgIcon('#i-brain', 'tiq'));
    const num = document.createElement('b');
    num.textContent = me.trophies.toLocaleString('en-US');
    line.append(num);
    const avgCap = document.createElement('small');
    avgCap.textContent = t('squadAvgIq');
    score.append(line, avgCap);
    score.title = `${me.trophies.toLocaleString('en-US')} ${t('squadAvgIq')} · ${squadTiqSum(me.roster).toLocaleString('en-US')} TIQ / ${me.members.toLocaleString('en-US')} minds`;

    host.append(txt, score);
    host.setAttribute('aria-label', `My squad: ${me.name}, rank ${me.rank}, ${me.trophies.toLocaleString('en-US')} average Tactical IQ, ${me.members.toLocaleString('en-US')} minds.`);
  }

  function squadRow(s: RankedSquad, mine: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `squad-row lb-row${mine ? ' is-you' : ''}`;
    li.tabIndex = 0;
    li.dataset.id = s.id;
    const label = s.name || s.handle.replace(/^@/, '');
    const members = membersLine(s.members);
    li.title = `${label} · ${s.handle}`;
    li.setAttribute('aria-label', `${label}, ${s.handle}, rank ${s.rank}, ${s.members.toLocaleString('en-US')} members, ${s.trophies.toLocaleString('en-US')} Tactical IQ.${mine ? ' You are in this squad.' : ''} Activate to open the squad profile.`);
    if (mine) li.setAttribute('aria-current', 'true');

    /* Identity column: rank key · crest · name over its member line. The name owns
       every leftover pixel and ellipsises first; the score and the Join key never
       move. Nothing else rides on the row. */
    const id = document.createElement('span');
    id.className = 'lb-id';
    const av = hexCrest(squadMark(s), 'lb-hex', squadAvatarUrl(s));
    const txt = document.createElement('span');
    txt.className = 'lb-txt';
    const nm = document.createElement('span');
    nm.className = 'lb-name';
    nm.dir = 'auto';
    nm.textContent = label;
    nm.title = `${label} · ${s.handle}`;
    const sub = document.createElement('span');
    sub.className = 'lb-sub nd-count';
    sub.textContent = members;
    sub.title = `${s.members.toLocaleString('en-US')} members · ${s.handle}`;
    txt.append(nm, sub);
    id.append(av, txt);

    /* Action column: Joined is a quiet stamp on your own row, never a second key;
       every other row carries the one cyan glass Join capsule. */
    const act = document.createElement('span');
    act.className = 'lb-act';
    if (mine) {
      const joined = document.createElement('span');
      joined.className = 'lb-btn is-joined';
      joined.textContent = 'Joined';
      joined.setAttribute('aria-hidden', 'true');
      act.append(joined);
    } else {
      act.append(squadKey(squadAction(s, false), 'lb-btn'));
    }

    const cell = scoreCell(s.trophies.toLocaleString('en-US'), `${s.trophies.toLocaleString('en-US')} squad Tactical IQ`);

    li.append(rankCrest(s.rank), id, cell, act);

    // The whole row opens the guild's profile sheet, which carries the real keys.
    li.addEventListener('click', () => { openGuild(s); });
    li.addEventListener('keydown', (e) => {
      if (e.target !== li) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openGuild(s);
      }
    });
    return li;
  }

  function paintSquadDock(): void {
    const dock = squadDock();
    if (!dock) return;
    // Squad dock is exclusive to the Squad IQ board — never on an IQ board.
    if (!isRanksVisible() || board !== 'guilds') {
      dock.hidden = true;
      return;
    }
    dock.hidden = false;
    const me = getMySquad();
    dock.textContent = '';
    dock.classList.toggle('member', !!me);

    if (!me) {
      const ico = document.createElement('span');
      ico.className = 'dock-av is-empty';
      ico.append(svgIcon('#i-brain', 'dock-ico'));
      ico.setAttribute('aria-hidden', 'true');

      const txt = document.createElement('span');
      txt.className = 'dock-txt';
      const t = document.createElement('b');
      t.className = 'dock-name';
      t.textContent = 'Join a squad to earn Tactical IQ';
      const s = document.createElement('small');
      s.className = 'dock-sub';
      s.textContent = 'Race points count for your channel or group';
      txt.append(t, s);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dock-btn is-primary';
      btn.textContent = 'Find Squad';
      btn.setAttribute('aria-label', 'Find Squad: open squad picker');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        impact('light');
        openSquadSheet();
      });

      const actions = document.createElement('span');
      actions.className = 'dock-actions';
      actions.append(btn);
      dock.append(ico, txt, actions);
      dock.setAttribute('aria-label', 'My Squad Standing: no squad bound. Find a squad to start earning Tactical IQ.');
      return;
    }

    const av = document.createElement('span');
    av.className = 'dock-av';
    const mark = squadMark(me);
    av.textContent = mark;
    av.dataset.len = String(mark.length);
    av.setAttribute('aria-hidden', 'true');

    const txt = document.createElement('span');
    txt.className = 'dock-txt';
    const top = document.createElement('span');
    top.className = 'dock-top';
    const kick = document.createElement('small');
    kick.className = 'dock-kicker';
    kick.textContent = 'My Squad';
    const rank = document.createElement('span');
    rank.className = 'dock-rank';
    rank.textContent = `#${me.rank}`;
    top.append(kick, rank);
    const nm = document.createElement('b');
    nm.className = 'dock-name';
    nm.textContent = me.handle;
    nm.title = `${me.name} · ${me.handle}`;
    txt.append(top, nm);

    const score = document.createElement('span');
    score.className = 'dock-score';
    score.append(svgIcon('#i-brain', 'dock-tiq'));
    const num = document.createElement('b');
    num.textContent = me.trophies.toLocaleString('en-US');
    score.append(num);
    score.title = `${me.trophies.toLocaleString('en-US')} average Tactical IQ`;

    dock.append(av, txt, score);
    dock.setAttribute('aria-label', `My Squad Standing: ${me.handle}, rank ${me.rank}, ${me.trophies.toLocaleString('en-US')} average Tactical IQ.`);
  }

  let guildsKey = '';
  function loadSquads(): void {
    const el = panes.guilds;
    if (!el) return;
    const rows = getSquadRanking();
    const me = getMySquad();
    const key = `${lang}|${isPremiumUser() ? 1 : 0}|${me?.id ?? ''}|${me?.rank ?? ''}|${me?.trophies ?? ''}|`
      + boardSignature(rows.flatMap((s) => [s.id, s.rank, s.name, s.handle, s.members, s.trophies]));
    if (key === guildsKey) {
      loadedBoard.guilds = true;
      paintSquadDock();
      paintGuildHero();
      return;
    }
    guildsKey = key;
    if (!loadedBoard.guilds) el.innerHTML = skel(5);
    if (!rows.length) {
      el.innerHTML = empty('No squads ranked yet.');
      paintPodium([]);
      paintSquadDock();
      return;
    }
    guildField = rows;
    paintPodium(rows.slice(0, 3).map((s) => ({
      rank: s.rank,
      name: s.name || s.handle.replace(/^@/, ''),
      score: s.trophies.toLocaleString('en-US'),
      letter: squadMark(s),
      photo: squadAvatarUrl(s),
      members: s.members,
    })));
    el.textContent = '';
    const ol = document.createElement('ol');
    ol.className = 'squad-list';
    el.append(ol);
    fillLadder(ol, rows.slice(3), (s) => squadRow(s, me?.id === s.id));
    paintSquadDock();
    paintGuildHero();
    loadedBoard.guilds = true;
  }

  onChange(() => {
    loadedBoard.nations = false;
    loadedBoard.minds = false;
    loadedBoard.guilds = false;
    if (isRanksVisible()) {
      /* the standing strip carries the equipped badge, so it repaints on the same
         beat the save lands — a new honor shows on the ladder without a reload */
      paintMindsStanding(mindsField.length ? mindsField : null);
      paintRanks();
      if (board === 'nations' && nationRows) {
        paintNations(nationRows);
        void loadNations();
      } else {
        void loadBoard(board);
      }
    }
  });

  onSquadChange(() => {
    loadedBoard.guilds = false;
    if (isRanksVisible() && board === 'guilds') {
      loadSquads();
    }
  });

  /* A pass bought from the VIP store repaints the same board it was bought from: the local
     seat's gold crown appears in the roster sheet and the players ladder without a reload. */
  onVipChange(() => {
    if (isRanksVisible() && board === 'guilds') {
      void loadSquads();
    } else if (isRanksVisible() && board === 'minds' && mindsField.length) {
      paintMinds(mindsField);
    }
  });

  return {
    setRoute(id: string) {
      if (id === 'ranks') {
        paintRanks();
        startTick();
        refreshLadderMedals();
        void loadBoard(board);
      } else {
        stopTick();
      }
    },
  };
}
