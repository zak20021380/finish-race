/**
 * channelWar.ts — the Channel Wars Hub.
 *
 * One sheet, three zones and no repeats: the prize rule and its clock, the rankings with the
 * admins' register door, and a single action bar that reads the player's own state. The register
 * flow is a sub-view of this same panel, never a second modal — an admin who came to enlist a
 * channel stays inside the tournament they are enlisting into.
 *
 * Every number here is a real one: the ladder is `getWarRanking()`, the points are what settled
 * matches banked, and the member count is the roster's own length. When nothing has scored yet
 * the board says so instead of inventing a field.
 */
import { onLang, t } from './settings';
import { impact, notify, openLink, openTelegramShare } from './telegram';
import { showToast, showToastDetail } from './toast';
import type { Sheets } from './sheets';
import {
  cleanHandle, displayNameOf, getMySquad, getSquadRanking, getWarRanking, handleIssue,
  onSquadChange, squadAvatarUrl, squadMark, warEndsAt, warPointsOf, WAR_WIN,
  type RankedSquad,
} from './squads';
import {
  checkChannelMembership, joinSquadOnServer, refreshSquadBoard, registerSquadWithTelegram,
} from './squadRegister';
import { channelWarAppLink, telegramShareLink } from '../shared/config';

export interface ChannelWarApi {
  sheets: Sheets;
  /** The war queue. `channel_war` is what puts the war identity on the matchmaking stage. */
  queue(mode: 'pvp' | 'arena' | 'channel_war'): void;
}

export interface ChannelWarHub {
  /** Raise the hub. `prefill` seeds the selection (a rally link names a channel). */
  open(prefill?: string): void;
  /** Repaint from the live store — called after a match settles. */
  refresh(): void;
  readonly isOpen: boolean;
}

const LADDER_MAX = 20;
const PICK_MAX = 6;
const AVATAR_HUES = [198, 210, 232, 262, 288, 318, 24, 42, 158, 174];

const hash32 = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** War points in Latin tabular figures, grouped: `1,450`. A score is a code, not prose. */
const PTS_FMT = new Intl.NumberFormat('en-US');
const ptsLabel = (n: number): string => PTS_FMT.format(Math.max(0, Math.floor(n)));

/** The war clock, always in Latin figures: a countdown is a code, not a sentence. */
function warClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const mins = Math.floor((total % 3_600) / 60);
  return days > 0 ? `${days}d ${pad(hours)}h` : `${pad(hours)}h ${pad(mins)}m`;
}

const membersLabel = (n: number): string =>
  n <= 0 ? t('cwNoMembers') : n === 1 ? t('cwMemberOne') : t('cwMembers').replace('{n}', String(n));

/** A Latin-digit template with its numbers isolated, so RTL prose never reorders them. */
function paintTemplate(host: HTMLElement, template: string, vars: Record<string, string>): void {
  host.textContent = '';
  let cut = 0;
  for (const found of template.matchAll(/\{\w+\}/g)) {
    const at = found.index ?? 0;
    if (at > cut) host.append(template.slice(cut, at));
    const value = vars[found[0].slice(1, -1)];
    if (value !== undefined) {
      const iso = document.createElement('bdi');
      iso.setAttribute('dir', 'auto');
      iso.textContent = value;
      host.append(iso);
    }
    cut = at + found[0].length;
  }
  if (cut < template.length) host.append(template.slice(cut));
}

/**
 * A clipboard write in an unfocused WebView can hang instead of rejecting, and the invite key must
 * never look dead while it waits. Whatever the clipboard does, the player gets an answer.
 */
function copyText(value: string): Promise<boolean> {
  const attempt = (async (): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch { /* fall through to the legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', 'true');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  })();
  return Promise.race([attempt, new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 1200))]);
}

/** Why a typed or pasted reference is not a Telegram username, as a message key. */
const handleErrorKey = (issue: string): string =>
  issue === 'empty' ? 'cwErrEmpty'
    : issue === 'short' ? 'cwErrShort'
      : issue === 'long' ? 'cwErrLong' : 'cwErrChars';

export function createChannelWarHub(api: ChannelWarApi): ChannelWarHub {
  const root = document.getElementById('channel-war-modal');
  const mainView = document.getElementById('cw-main');
  const regView = document.getElementById('cw-register');
  const clock = document.getElementById('cw-countdown');
  const prizeRule = document.getElementById('cw-prize-rule');
  const boardList = document.getElementById('cw-board-list');
  const liveRegion = document.getElementById('cw-live-region');

  const regOpen = document.getElementById('cw-reg-open');
  const regBack = document.getElementById('cw-reg-back');
  const regHandle = document.getElementById('cw-reg-handle') as HTMLInputElement | null;
  const regName = document.getElementById('cw-reg-name') as HTMLInputElement | null;
  const regErr = document.getElementById('cw-reg-err');
  const regGo = document.getElementById('cw-reg-go') as HTMLButtonElement | null;
  const regDone = document.getElementById('cw-reg-done');
  const regLink = document.getElementById('cw-reg-link');
  const regCopy = document.getElementById('cw-reg-copy');

  const pick = document.getElementById('cw-pick');
  const pickList = document.getElementById('cw-pick-list');
  const pickX = document.getElementById('cw-pick-x');

  const verify = document.getElementById('cw-verify');
  const verifyHandle = document.getElementById('cw-verify-h');
  const verifyOpen = document.getElementById('cw-verify-open');
  const verifyOpenT = document.getElementById('cw-verify-open-t');
  const verifyAgain = document.getElementById('cw-verify-again');

  const joinBtn = document.getElementById('cw-join') as HTMLButtonElement | null;
  const joinT = document.getElementById('cw-join-t');
  const inviteBtn = document.getElementById('cw-invite');

  /** The squad chosen but not yet enrolled — a selection, never a membership. */
  let picked = '';
  /** The handle whose membership gate is open, or '' when there is nothing to ask. */
  let awaiting = '';
  /** A rally link that named a channel this device has not seen yet. */
  let rallyHandle = '';
  let view: 'hub' | 'register' = 'hub';
  let joining = false;
  let checking = false;
  let registering = false;
  let boardRequest: Promise<void> | null = null;

  const isOpen = (): boolean => !!root && !root.hidden;
  const say = (text: string): void => { if (liveRegion) liveRegion.textContent = text; };

  const squadById = (id: string): RankedSquad | undefined => getSquadRanking().find((s) => s.id === id);

  /* ---------- painting ---------- */

  /** The crest: Telegram's public photo when it answers, the call sign when it does not. */
  function paintAvatar(img: HTMLImageElement | null, mark: HTMLElement | null, host: HTMLElement | null, s: RankedSquad): void {
    host?.style.setProperty('--cw-hue', String(AVATAR_HUES[hash32(s.handle) % AVATAR_HUES.length]));
    if (mark) mark.textContent = squadMark(s);
    const url = squadAvatarUrl(s);
    if (!img) return;
    if (!url) { img.hidden = true; img.removeAttribute('src'); return; }
    img.hidden = false;
    img.onerror = () => { img.hidden = true; };
    img.src = url;
  }

  /**
   * One ladder row: rank badge, crest, identity, score. `you` lights the player's own channel and
   * swaps the door for the pill; `selectable` turns the row into a choice. Every dynamic string
   * rides its own `<bdi>` so an RTL channel name is contained.
   */
  function buildRow(s: RankedSquad, opts: { you: boolean; selectable: boolean }): HTMLLIElement {
    const pts = warPointsOf(s);
    const li = document.createElement('li');
    li.className = `cw-row${opts.you ? ' is-you' : ''}${picked === s.id ? ' is-selected' : ''}`;

    const rank = document.createElement('span');
    const scored = pts > 0;
    rank.className = `cw-rank${scored ? (s.rank <= 3 ? ` is-${s.rank}` : '') : ' is-none'}`;
    rank.setAttribute('dir', 'ltr');
    /* A channel nobody has scored for has no place to defend yet: it reads as a dash, never #4. */
    rank.textContent = scored ? `#${s.rank}` : '—';

    const av = document.createElement('span');
    av.className = 'cw-av';
    const img = document.createElement('img');
    img.className = 'cw-av-img';
    img.alt = '';
    img.hidden = true;
    img.decoding = 'async';
    const mark = document.createElement('b');
    mark.className = 'cw-av-t';
    mark.setAttribute('aria-hidden', 'true');
    av.append(img, mark);
    paintAvatar(img, mark, av, s);

    const id = document.createElement('span');
    id.className = 'cw-row-id';
    const name = document.createElement('b');
    name.className = 'cw-row-name';
    const nameBdi = document.createElement('bdi');
    nameBdi.setAttribute('dir', 'auto');
    nameBdi.textContent = s.name || displayNameOf(s.handle);
    name.append(nameBdi);
    const meta = document.createElement('span');
    meta.className = 'cw-row-meta';
    const handle = document.createElement('bdi');
    handle.className = 'cw-row-handle';
    handle.setAttribute('dir', 'ltr');
    handle.textContent = s.handle;
    const dot = document.createElement('span');
    dot.className = 'cw-dot';
    dot.setAttribute('aria-hidden', 'true');
    dot.textContent = '·';
    const crew = document.createElement('span');
    crew.className = 'cw-row-members';
    crew.textContent = membersLabel(s.members);
    meta.append(handle, dot, crew);
    id.append(name, meta);

    const side = document.createElement('span');
    side.className = 'cw-row-side';
    const ptsEl = document.createElement('b');
    ptsEl.className = `cw-row-pts${scored ? '' : ' is-zero'}`;
    ptsEl.setAttribute('dir', 'ltr');
    const ptsN = document.createElement('span');
    ptsN.textContent = ptsLabel(pts);
    const ptsU = document.createElement('span');
    ptsU.textContent = t('cwPts');
    ptsEl.append(ptsN, ptsU);
    side.append(ptsEl);

    if (opts.you) {
      const pill = document.createElement('span');
      pill.className = 'cw-pill';
      pill.textContent = t('cwYourTeam');
      side.append(pill);
    } else if (opts.selectable) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cw-sel';
      btn.textContent = t('cwSelect');
      btn.dataset.select = s.id;
      btn.setAttribute('aria-pressed', String(picked === s.id));
      btn.setAttribute('aria-label', `${t('cwSelect')} ${s.name || s.handle}`);
      side.append(btn);
    }

    li.append(rank, av, id, side);
    return li;
  }

  function emptyRow(key: string): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'cw-empty';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-crown');
    svg.append(use);
    const text = document.createElement('span');
    text.textContent = t(key);
    li.append(svg, text);
    return li;
  }

  function paintBoard(): void {
    if (!boardList) return;
    const board = getWarRanking();
    const mine = getMySquad();
    /* Switching is only free while the channel has nothing to lose: a scored team is a team. */
    const canSelect = !mine || warPointsOf(mine) === 0;
    boardList.textContent = '';
    if (!board.length) { boardList.append(emptyRow('cwEmptyBoard')); return; }
    for (const s of board.slice(0, LADDER_MAX)) {
      const you = !!mine && s.id === mine.id;
      boardList.append(buildRow(s, { you, selectable: canSelect && !you }));
    }
    revealMyRow();
  }

  /**
   * Bring the player's own place under their thumb. It only works on a laid-out list, so the hub
   * calls it again once the sheet has actually opened — measuring a hidden panel scrolls nowhere.
   */
  function revealMyRow(): void {
    if (!boardList) return;
    const row = boardList.querySelector<HTMLElement>('.cw-row.is-you');
    if (!row || !boardList.clientHeight) return;
    boardList.scrollTop = Math.max(0, row.offsetTop - boardList.clientHeight / 2 + row.clientHeight / 2);
  }

  function paintPrize(): void {
    if (!prizeRule) return;
    /* The one rule of the tournament, with the pool in its own Latin run. */
    paintTemplate(prizeRule, t('cwPrizeRule'), { n: '200' });
  }

  function paintVerify(): void {
    if (!verify) return;
    verify.hidden = !awaiting;
    if (!awaiting) return;
    if (verifyHandle) verifyHandle.textContent = awaiting;
    if (verifyOpenT) paintTemplate(verifyOpenT, t('cwOpenChannel'), { h: awaiting });
  }

  function paintCta(): void {
    if (!joinBtn || !joinT) return;
    const mine = getMySquad();
    const switching = !!picked && picked !== mine?.id;
    const playing = !!mine && !switching;
    if (playing) paintTemplate(joinT, t('cwPlayEarn'), { n: String(WAR_WIN) });
    else joinT.textContent = t('cwJoinWar');
    const ready = playing || !!picked;
    joinBtn.setAttribute('aria-disabled', String(!ready));
    joinBtn.setAttribute('aria-busy', String(joining || checking));
    joinBtn.querySelector('use')?.setAttribute('href', playing ? '#i-swords' : '#i-user-join');
    if (inviteBtn) inviteBtn.hidden = !playing;
  }

  function paint(): void {
    if (!root) return;
    if (clock) clock.textContent = warClock(warEndsAt() - Date.now());
    paintPrize();
    paintBoard();
    paintVerify();
    paintCta();
    if (pick && !pick.hidden) paintPick();
  }

  function paintView(): void {
    if (mainView) mainView.hidden = view !== 'hub';
    if (regView) regView.hidden = view !== 'register';
  }

  /* ---------- the quick pick ---------- */

  function paintPick(): void {
    if (!pickList) return;
    const mine = getMySquad();
    const rows = getWarRanking().filter((s) => s.id !== mine?.id).slice(0, PICK_MAX);
    pickList.textContent = '';
    if (!rows.length) { pickList.append(emptyRow('cwEmptyBoard')); return; }
    for (const s of rows) {
      const li = buildRow(s, { you: false, selectable: true });
      li.dataset.select = s.id;
      pickList.append(li);
    }
  }

  function openPick(): void {
    if (!pick) return;
    paintPick();
    pick.hidden = false;
    boardList?.closest('.cw-board')?.classList.add('is-picking');
    impact('light');
  }

  function closePick(): void {
    if (pick) pick.hidden = true;
    boardList?.closest('.cw-board')?.classList.remove('is-picking');
  }

  function choose(id: string): void {
    if (!id) return;
    picked = id;
    awaiting = '';
    impact('light');
    closePick();
    paint();
    say(t('cwSelected'));
  }

  /* ---------- enrolment: the membership gate, then the roster ---------- */

  function welcome(s: RankedSquad): void {
    picked = '';
    awaiting = '';
    impact('medium');
    notify('success');
    paint();
    say(t('cwJoined'));
    showToastDetail(t('cwJoinedTitle'), `${s.name || displayNameOf(s.handle)} · ${s.handle}`, 'success');
  }

  async function enrol(squad: RankedSquad): Promise<void> {
    if (getMySquad()?.id === squad.id) { picked = ''; awaiting = ''; paint(); return; }
    joining = true;
    paintCta();
    const result = await joinSquadOnServer(squad.id);
    joining = false;
    if (!result.ok) {
      paintCta();
      notify('warning');
      showToast(result.message || t('cwJoinFailed'), 'warning');
      return;
    }
    if (result.pending) {
      picked = '';
      paint();
      notify('success');
      showToast(t('cwJoinPending'), 'success');
      say(t('cwJoinPending'));
      return;
    }
    welcome(result.squad ?? squad);
  }

  /**
   * Prove the player is inside the chat before putting them on its roster. A refusal is not an
   * error: it is the inline prompt above the CTA, with the channel's own door and a retry.
   */
  async function gate(squad: RankedSquad): Promise<void> {
    checking = true;
    paintCta();
    const verdict = await checkChannelMembership(squad.handle);
    checking = false;
    if (!verdict.isMember) {
      awaiting = squad.handle;
      paint();
      notify('warning');
      impact('light');
      say(t('cwVerifyLead'));
      return;
    }
    awaiting = '';
    await enrol(squad);
  }

  async function onJoin(): Promise<void> {
    if (joining || checking) return;
    const mine = getMySquad();
    const switching = !!picked && picked !== mine?.id;
    /* Enrolled and staying: the key is the race, not the roster. */
    if (mine && !switching) {
      impact('heavy');
      api.sheets.close();
      api.queue('channel_war');
      return;
    }
    if (!picked) { openPick(); return; }
    const squad = squadById(picked);
    if (!squad) { picked = ''; paint(); return; }
    await gate(squad);
  }

  /* ---------- the admin door ---------- */

  function setRegError(key: string): void {
    if (!regErr) return;
    regErr.textContent = key ? t(key) : '';
    regErr.hidden = !key;
  }

  function setRegErrorText(text: string): void {
    if (!regErr) return;
    regErr.textContent = text;
    regErr.hidden = !text;
  }

  function setRegBusy(on: boolean): void {
    if (regGo) {
      regGo.setAttribute('aria-busy', String(on));
      regGo.setAttribute('aria-disabled', String(on));
      const label = regGo.querySelector('b');
      if (label) label.textContent = t(on ? 'cwRegisterBusy' : 'cwRegisterGo');
    }
    if (regHandle) regHandle.disabled = on;
    if (regName) regName.disabled = on;
  }

  function showInviteCard(handle: string): void {
    const link = channelWarAppLink(handle);
    if (regLink) regLink.textContent = link;
    if (regDone) regDone.hidden = !link;
  }

  function openRegister(prefill = ''): void {
    view = 'register';
    setRegError('');
    if (regDone) regDone.hidden = true;
    if (regLink) regLink.textContent = '';
    if (regHandle) regHandle.value = prefill;
    if (regName) regName.value = '';
    setRegBusy(false);
    paintView();
    requestAnimationFrame(() => regHandle?.focus({ preventScroll: true }));
  }

  function closeRegister(): void {
    view = 'hub';
    paintView();
    paint();
    requestAnimationFrame(revealMyRow);
  }

  /**
   * The registry already holds this chat. That is not a refusal — the admin wanted the channel in
   * the war and it is already in it — so the device joins the squad that exists instead.
   */
  async function adoptRegistered(handle: string): Promise<void> {
    await refreshSquadBoard();
    const known = getSquadRanking().find((s) => s.handle.toLowerCase() === handle.toLowerCase());
    if (!known) { setRegError('enlistErrAlready'); notify('warning'); return; }
    const result = await joinSquadOnServer(known.id);
    if (!result.ok) { setRegErrorText(result.message || t('cwJoinFailed')); notify('warning'); return; }
    welcome(result.squad ?? known);
    showInviteCard(handle);
  }

  async function submitRegister(): Promise<void> {
    if (registering) return;
    const issue = handleIssue(regHandle?.value ?? '');
    if (issue) {
      setRegError(handleErrorKey(issue));
      notify('warning');
      impact('light');
      regHandle?.focus();
      return;
    }
    const handle = cleanHandle(regHandle?.value ?? '');
    setRegError('');
    registering = true;
    setRegBusy(true);
    const result = await registerSquadWithTelegram(handle, {
      name: (regName?.value ?? '').trim().slice(0, 32),
      tag: '',
    });
    registering = false;
    setRegBusy(false);
    if (!result.ok) {
      if (result.error === 'already_registered') { await adoptRegistered(handle); return; }
      setRegErrorText(result.message || t('cwJoinFailed'));
      notify('warning');
      return;
    }
    if (!result.squad) { setRegError('enlistErrAlready'); notify('warning'); return; }
    /* The Worker proved this player is an administrator of the chat, so the membership gate is
       already answered: the enlistment lands and the invite card takes the stage. */
    welcome(result.squad);
    showInviteCard(result.squad.handle);
    notify('success');
  }

  /* ---------- the invite link ---------- */

  function rally(): void {
    const mine = getMySquad();
    if (!mine) return;
    const url = channelWarAppLink(mine.handle);
    if (!url) { notify('warning'); showToast(t('cwRallyFailed'), 'warning'); return; }
    impact('medium');
    /* Inside Telegram the native picker is the whole action; the copy rides along as a convenience
       and never holds the share hostage. */
    if (typeof window.Telegram?.WebApp?.openTelegramLink === 'function') {
      void copyText(url);
      openTelegramShare(telegramShareLink(url, t('cwRallyShare').replace('{channel}', mine.name || mine.handle)));
      return;
    }
    void copyText(url).then((copied) => {
      notify(copied ? 'success' : 'warning');
      showToastDetail(
        copied ? t('cwInviteCopied') : t('cwRallyLink'),
        copied ? t('cwRallyCopiedBody') : url,
        copied ? 'success' : 'warning',
        5200,
      );
    });
  }

  /* ---------- the board behind the paint ---------- */

  function warmBoard(): void {
    if (boardRequest) return;
    boardRequest = refreshSquadBoard()
      .then(() => {
        if (!isOpen()) return;
        /* A rally link that named a channel this device had never seen becomes the selection the
           moment the registry names it. */
        if (rallyHandle) {
          const hit = getSquadRanking().find((s) => s.handle.toLowerCase() === rallyHandle.toLowerCase());
          if (hit) picked = hit.id;
          rallyHandle = '';
        }
        paint();
      })
      .catch(() => { /* the device's own board still paints */ })
      .finally(() => { boardRequest = null; });
  }

  const hub: ChannelWarHub = {
    open(prefill = '') {
      if (!root) { api.queue('channel_war'); return; }
      const handle = prefill ? cleanHandle(prefill) : '';
      const known = handle
        ? getSquadRanking().find((s) => s.handle.toLowerCase() === handle.toLowerCase())
        : undefined;
      view = 'hub';
      picked = known?.id ?? '';
      awaiting = '';
      rallyHandle = known ? '' : handle;
      joining = false;
      checking = false;
      closePick();
      setRegError('');
      paintView();
      paint();
      api.sheets.open(root);
      requestAnimationFrame(revealMyRow);
      warmBoard();
      say(t('cwTitle'));
    },
    refresh() { if (isOpen()) paint(); },
    get isOpen() { return isOpen(); },
  };

  /* One clock for the life of the page: it only spends a tick while the hub is on screen. */
  window.setInterval(() => {
    if (!isOpen() || document.hidden || !clock) return;
    clock.textContent = warClock(warEndsAt() - Date.now());
  }, 1000);

  /* A rotation or a Telegram viewport change resizes the ladder, so the player's own place has to
     be brought back under their thumb rather than left wherever the old height put it. */
  window.addEventListener('resize', () => { if (isOpen()) revealMyRow(); });

  joinBtn?.addEventListener('click', () => { void onJoin(); });
  inviteBtn?.addEventListener('click', () => { rally(); });

  regOpen?.addEventListener('click', () => { impact('light'); openRegister(); });
  regBack?.addEventListener('click', () => { impact('light'); closeRegister(); });
  regGo?.addEventListener('click', () => { void submitRegister(); });
  regHandle?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void submitRegister();
  });
  regHandle?.addEventListener('input', () => { if (regErr && !regErr.hidden) setRegError(''); });
  regCopy?.addEventListener('click', () => {
    const link = regLink?.textContent ?? '';
    if (!link) return;
    impact('medium');
    void copyText(link).then((copied) => {
      notify(copied ? 'success' : 'warning');
      showToastDetail(
        copied ? t('cwInviteCopied') : t('cwRallyLink'),
        copied ? t('cwRallyCopiedBody') : link,
        copied ? 'success' : 'warning',
        5200,
      );
    });
  });

  verifyOpen?.addEventListener('click', () => {
    if (!awaiting) return;
    impact('light');
    openLink(`https://t.me/${awaiting.replace(/^@+/, '')}`);
  });
  verifyAgain?.addEventListener('click', () => {
    const squad = squadById(picked);
    if (!squad || checking) return;
    void gate(squad);
  });

  /* Both lists answer the same way: a `data-select` names the squad a tap stands for. */
  for (const list of [boardList, pickList]) {
    list?.addEventListener('click', (event) => {
      const hit = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-select]');
      const id = hit?.dataset.select ?? '';
      if (id) choose(id);
    });
  }
  pickX?.addEventListener('click', () => { impact('light'); closePick(); });

  /* A rally link is a prompt, not an enrolment: it raises the hub with the channel already
     selected, and the Join key is still the only thing that puts a player on a roster. */
  window.addEventListener('detour:channel-war-invite', (event) => {
    const handle = (event as CustomEvent<{ handle?: string }>).detail?.handle ?? '';
    if (handle) hub.open(handle);
  });

  onSquadChange(() => { if (isOpen()) paint(); });
  onLang(() => { if (isOpen()) paint(); });

  return hub;
}
