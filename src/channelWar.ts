/**
 * channelWar.ts — the Channel Wars Hub.
 *
 * One bottom sheet, two states. A player with no channel gets three steps, one field and a rail
 * of channels they can join with a single tap; a player with a channel gets the war room — their
 * crest, the live ladder with their own row lit, and the gold key that queues a war match.
 *
 * Every number here is a real one: the ladder is `getWarRanking()`, the points are what settled
 * war matches banked, and the fighter count is the roster's own length. When the registry has no
 * scored field yet the rail switches to open recruiting rather than inventing a leaderboard.
 */
import { onLang, t } from './settings';
import { impact, notify, openTelegramShare } from './telegram';
import { showToast, showToastDetail } from './toast';
import type { Sheets } from './sheets';
import {
  bindSquad, cleanHandle, displayNameOf, getMySquad, getSquadRanking, getWarRanking, handleIssue,
  myWarStanding, onSquadChange, squadAvatarUrl, squadMark, warEndsAt, warPointsOf,
  type RankedSquad,
} from './squads';
import { joinSquadOnServer, refreshSquadBoard } from './squadRegister';
import { CHANNEL_HANDLE, channelWarAppLink, telegramShareLink } from '../shared/config';

export interface ChannelWarApi {
  sheets: Sheets;
  /** The war queue. `channel_war` is what puts the war identity on the matchmaking stage. */
  queue(mode: 'pvp' | 'arena' | 'channel_war'): void;
}

export interface ChannelWarHub {
  /** Raise the hub. `prefill` seeds the join field (a rally link names a channel). */
  open(prefill?: string): void;
  /** Repaint from the live store — called after a war match settles. */
  refresh(): void;
  readonly isOpen: boolean;
}

/**
 * Channels open to represent when the registry has no scored field yet. These are real public
 * Telegram communities, not invented squads: they carry zero war points and an empty roster,
 * which is exactly what a channel nobody has fought for yet looks like.
 */
const RECRUITING: readonly string[] = [CHANNEL_HANDLE, 'telegram', 'toncoin', 'contests', 'durov'];

const RAIL_MAX = 5;
const LADDER_MAX = 20;
const AVATAR_HUES = [198, 210, 232, 262, 288, 318, 24, 42, 158, 174];

const hash32 = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** The war clock, always in Latin figures: a countdown is a code, not a sentence. */
function warClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const mins = Math.floor((total % 3_600) / 60);
  return days > 0 ? `${days}d ${pad(hours)}h` : `${pad(hours)}h ${pad(mins)}m`;
}

const crewLabel = (n: number): string =>
  n <= 0 ? t('cwNoFighters') : n === 1 ? t('cwFighterOne') : t('cwFighters').replace('{n}', String(n));

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
 * A clipboard write in an unfocused WebView can hang instead of rejecting, and the rally key must
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

export function createChannelWarHub(api: ChannelWarApi): ChannelWarHub {
  const root = document.getElementById('channel-war-modal');
  const onboard = document.getElementById('cw-onboard');
  const hubView = document.getElementById('cw-hub');
  const foot = document.getElementById('cw-foot');
  const clock = document.getElementById('cw-countdown');
  const input = document.getElementById('cw-handle') as HTMLInputElement | null;
  const joinBtn = document.getElementById('cw-join-go') as HTMLButtonElement | null;
  const joinErr = document.getElementById('cw-join-err');
  const quickList = document.getElementById('cw-quick-list');
  const railTitle = document.getElementById('cw-rail-title');
  const boardList = document.getElementById('cw-board-list');
  const boardCount = document.getElementById('cw-board-count');
  const gapLine = document.getElementById('cw-gap');
  const gapText = document.getElementById('cw-gap-t');
  const liveRegion = document.getElementById('cw-live-region');
  const heroImg = document.getElementById('cw-hero-img') as HTMLImageElement | null;
  const heroMark = document.getElementById('cw-hero-mark');
  const heroAv = document.getElementById('cw-hero-av');
  const heroName = document.getElementById('cw-hero-name');
  const heroHandle = document.getElementById('cw-hero-handle');
  const heroRank = document.getElementById('cw-hero-rank');
  const heroPts = document.getElementById('cw-hero-pts');
  const heroCrew = document.getElementById('cw-hero-crew');

  /** True while the player is switching channels: State A even though they already have one. */
  let switching = false;
  let joining = false;
  let boardRequest: Promise<void> | null = null;

  const isOpen = (): boolean => !!root && !root.hidden;

  const say = (text: string): void => { if (liveRegion) liveRegion.textContent = text; };

  function setJoinError(key: string): void {
    if (!joinErr) return;
    joinErr.textContent = key ? t(key) : '';
    joinErr.hidden = !key;
  }

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
   * One ladder row. `join` turns it into a one-tap door; `you` lights it and swaps the door for
   * the pill. Every dynamic string rides its own `<bdi>` so an RTL channel name is contained.
   */
  function buildRow(s: RankedSquad, opts: { join: boolean; you: boolean; open: boolean }): HTMLLIElement {
    const li = document.createElement('li');
    const tail = opts.join || opts.you;
    li.className = `cw-row${tail ? ' has-tail' : ''}${opts.you ? ' is-you' : ''}${opts.open ? ' is-open' : ''}`;

    const rank = document.createElement('span');
    rank.className = `cw-rank${s.rank <= 3 ? ` is-${s.rank}` : ''}`;
    rank.setAttribute('dir', 'ltr');
    rank.textContent = `#${s.rank}`;

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
    const crew = document.createElement('span');
    crew.className = 'cw-row-crew';
    crew.textContent = opts.open ? t('cwBeFirst') : crewLabel(s.members);
    meta.append(handle, crew);
    id.append(name, meta);

    const pts = document.createElement('span');
    pts.className = 'cw-row-pts';
    const ptsN = document.createElement('b');
    ptsN.setAttribute('dir', 'ltr');
    ptsN.textContent = String(warPointsOf(s));
    const ptsU = document.createElement('span');
    ptsU.textContent = t('cwPts');
    pts.append(ptsN, ptsU);

    li.append(rank, av, id, pts);

    if (opts.you) {
      const pill = document.createElement('span');
      pill.className = 'cw-you';
      pill.textContent = t('cwYou');
      li.append(pill);
    } else if (opts.join) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cw-row-join';
      btn.textContent = t('cwRowJoin');
      btn.dataset.handle = s.handle;
      btn.setAttribute('aria-label', `${t('cwRowJoin')} ${s.name || s.handle}`);
      li.append(btn);
    }
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

  /** A recruiting slot: a real public channel with no squad behind it yet. */
  function recruitingSquad(handle: string, rank: number): RankedSquad {
    const canonical = `@${handle}`;
    return {
      id: `recruit-${handle.toLowerCase()}`,
      handle: canonical,
      name: displayNameOf(canonical),
      roster: [],
      members: 0,
      trophies: 0,
      trend: 'same',
      kind: 'channel',
      warPoints: 0,
      rank,
      owned: false,
    };
  }

  function paintQuickJoin(): void {
    if (!quickList) return;
    const mine = getMySquad();
    const live = getWarRanking().filter((s) => s.id !== mine?.id);
    const rows: { squad: RankedSquad; open: boolean }[] = live.slice(0, RAIL_MAX).map((s) => ({ squad: s, open: false }));
    /* No scored field yet: the rail becomes an recruiting door rather than an empty box. Every
       row is still one tap, and every number on it (0 points, no fighters) is the truth. */
    const used = new Set(rows.map((r) => r.squad.handle.toLowerCase()));
    if (mine) used.add(mine.handle.toLowerCase());
    for (const handle of RECRUITING) {
      if (rows.length >= RAIL_MAX) break;
      if (used.has(`@${handle}`.toLowerCase())) continue;
      rows.push({ squad: recruitingSquad(handle, rows.length + 1), open: true });
    }
    if (railTitle) railTitle.textContent = t(live.length ? 'cwPopular' : 'cwRecruiting');
    quickList.textContent = '';
    if (!rows.length) { quickList.append(emptyRow('cwNoBoard')); return; }
    for (const row of rows) quickList.append(buildRow(row.squad, { join: true, you: false, open: row.open }));
  }

  function paintHero(): void {
    const standing = myWarStanding();
    const s = standing.squad;
    if (!s) return;
    paintAvatar(heroImg, heroMark, heroAv, s);
    if (heroName) heroName.textContent = s.name || displayNameOf(s.handle);
    if (heroHandle) heroHandle.textContent = s.handle;
    if (heroRank) heroRank.textContent = `#${standing.rank || 1}`;
    if (heroPts) heroPts.textContent = String(standing.points);
    if (heroCrew) heroCrew.textContent = String(s.members);
  }

  function paintLadder(): void {
    if (!boardList) return;
    const board = getWarRanking();
    const mine = getMySquad();
    const rows = board.slice(0, LADDER_MAX);
    const myRow = mine ? board.find((s) => s.id === mine.id) ?? null : null;
    if (myRow && !rows.some((s) => s.id === myRow.id)) rows.push(myRow);
    if (boardCount) boardCount.textContent = String(board.length);
    boardList.textContent = '';
    if (!rows.length) { boardList.append(emptyRow('cwNoBoard')); }
    for (const s of rows) {
      boardList.append(buildRow(s, { join: false, you: !!mine && s.id === mine.id, open: false }));
    }
    revealMyRow();
    paintGap(board, myRow);
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

  function paintGap(board: RankedSquad[], mine: RankedSquad | null): void {
    if (!gapLine || !gapText) return;
    if (!mine) { gapLine.hidden = true; return; }
    gapLine.hidden = false;
    const at = board.findIndex((s) => s.id === mine.id);
    const lead = at <= 0;
    gapLine.classList.toggle('is-lead', lead);
    if (lead) { gapText.textContent = t('cwLeading'); return; }
    const above = board[at - 1];
    const gap = Math.max(0, warPointsOf(above) - warPointsOf(mine));
    paintTemplate(
      gapText,
      gap > 0 ? t('cwGap') : t('cwGapZero'),
      { n: String(gap), rank: String(above.rank) },
    );
  }

  function paint(): void {
    if (!root) return;
    const mine = getMySquad();
    const showHub = !!mine && !switching;
    if (onboard) onboard.hidden = showHub;
    if (hubView) hubView.hidden = !showHub;
    if (foot) foot.hidden = !showHub;
    if (clock) clock.textContent = warClock(warEndsAt() - Date.now());
    if (showHub) {
      paintHero();
      paintLadder();
    } else {
      paintQuickJoin();
      if (switching && railTitle) railTitle.textContent = t('cwChangeTitle');
    }
  }

  /** The registry's board, fetched once per open and merged into the ladder behind the paint. */
  function warmBoard(): void {
    if (boardRequest) return;
    boardRequest = refreshSquadBoard()
      .then(() => { if (isOpen()) paint(); })
      .catch(() => { /* the device's own board still paints */ })
      .finally(() => { boardRequest = null; });
  }

  function setJoining(on: boolean): void {
    joining = on;
    if (!joinBtn) return;
    joinBtn.disabled = on;
    joinBtn.setAttribute('aria-busy', on ? 'true' : 'false');
    const label = joinBtn.querySelector('span');
    if (label) label.textContent = t(on ? 'cwJoinBusy' : 'cwJoinCta');
  }

  /** Land on the war room. No sheet swap: the same panel simply changes its contents. */
  function welcome(s: RankedSquad): void {
    switching = false;
    setJoinError('');
    if (input) input.value = '';
    impact('medium');
    notify('success');
    paint();
    say(t('cwJoined'));
    showToastDetail(t('cwJoinedTitle'), `${s.name || displayNameOf(s.handle)} · ${s.handle}`, 'success');
  }

  async function joinHandle(raw: string): Promise<void> {
    if (joining) return;
    const issue = handleIssue(raw);
    if (issue) {
      setJoinError(issue === 'empty' ? 'cwErrEmpty'
        : issue === 'short' ? 'cwErrShort'
          : issue === 'long' ? 'cwErrLong' : 'cwErrChars');
      notify('warning');
      impact('light');
      input?.focus();
      return;
    }
    const handle = cleanHandle(raw);
    setJoinError('');
    const known = getSquadRanking().find((s) => s.handle.toLowerCase() === handle.toLowerCase());
    /* A handle nobody enlisted yet is a local mint: the squad starts with exactly one fighter,
       the player doing the joining. Nothing is invented to fill it. */
    if (!known) {
      const minted = bindSquad(handle);
      if (minted === 'bad-handle') { setJoinError('cwErrChars'); notify('warning'); return; }
      const created = getMySquad();
      if (created) welcome(created);
      return;
    }
    if (getMySquad()?.id === known.id) { welcome(known); return; }
    setJoining(true);
    const result = await joinSquadOnServer(known.id);
    setJoining(false);
    if (!result.ok) {
      setJoinError('');
      notify('warning');
      showToast(result.message || t('cwJoinFailed'), 'warning');
      return;
    }
    if (result.pending) {
      notify('success');
      showToast(t('cwJoinPending'), 'success');
      say(t('cwJoinPending'));
      return;
    }
    welcome(result.squad ?? known);
  }

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
      /* Outside Telegram the link itself is the deliverable: if the clipboard refused, the player
         can still read it off the toast and copy it by hand. */
      showToastDetail(
        copied ? t('cwRallyCopied') : t('cwRallyLink'),
        copied ? t('cwRallyCopiedBody') : url,
        copied ? 'success' : 'warning',
        5200,
      );
    });
  }

  const hub: ChannelWarHub = {
    open(prefill = '') {
      if (!root) { api.queue('channel_war'); return; }
      const target = prefill ? `@${prefill.replace(/^@+/, '')}` : '';
      const mine = getMySquad();
      /* A rally for a channel this player is not on yet is a switch, so it opens the join view
         with the handle already typed. A rally for their own channel opens the war room. */
      switching = !!target && !!mine && mine.handle.toLowerCase() !== target.toLowerCase();
      setJoinError('');
      setJoining(false);
      if (input) input.value = target;
      paint();
      api.sheets.open(root);
      requestAnimationFrame(revealMyRow);
      warmBoard();
      say(t('cwTitle'));
      if (switching) requestAnimationFrame(() => joinBtn?.focus({ preventScroll: true }));
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

  joinBtn?.addEventListener('click', () => { void joinHandle(input?.value ?? ''); });
  input?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void joinHandle(input.value);
  });
  input?.addEventListener('input', () => { if (joinErr && !joinErr.hidden) setJoinError(''); });

  quickList?.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.cw-row-join');
    if (!btn?.dataset.handle) return;
    impact('light');
    void joinHandle(btn.dataset.handle);
  });

  document.getElementById('cw-change')?.addEventListener('click', () => {
    impact('light');
    switching = true;
    setJoinError('');
    paint();
    requestAnimationFrame(() => input?.focus({ preventScroll: true }));
  });

  document.getElementById('cw-rally')?.addEventListener('click', () => { rally(); });

  document.getElementById('cw-start')?.addEventListener('click', () => {
    impact('heavy');
    api.sheets.close();
    api.queue('channel_war');
  });

  /* A rally link is a prompt, not an enrolment: it raises the hub with the channel already typed,
     and the Join key is still the only thing that puts a player on a roster. */
  window.addEventListener('detour:channel-war-invite', (event) => {
    const handle = (event as CustomEvent<{ handle?: string }>).detail?.handle ?? '';
    if (handle) hub.open(handle);
  });

  onSquadChange(() => { if (isOpen()) paint(); });
  onLang(() => { if (isOpen()) paint(); });

  return hub;
}