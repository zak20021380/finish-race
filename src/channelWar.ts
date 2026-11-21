/**
 * channelWar.ts — the Channel Wars Hub.
 *
 * One flagship sheet, four zones and no repeats: the prize rule and its clock, the friends-only
 * earning rule, the rankings with the admins' register door, and a single action bar that reads
 * the player's own state. Two sub-views live inside the same panel — the register flow an admin
 * came to enlist through, and the inspector a tap on any channel row opens — because a player who
 * went looking at a channel should never lose the tournament they were looking at it in.
 *
 * Every number here is a real one: the ladder is `getWarRanking()`, the TIQ is what settled
 * Play with Friends matches banked, the Telegram audience is what `getChatMemberCount` answered,
 * and the fighters are the roster's own rows. When nothing has scored yet the board says so
 * instead of inventing a field.
 *
 * Channel TIQ has exactly one source. A bot board, a practice race and a solo duel pay the
 * channel nothing: a machine that cannot lose is not an opponent, and a channel should never be
 * lifted by farming one.
 */
import { onLang, t } from './settings';
import { impact, notify, openLink, openTelegramShare } from './telegram';
import { showToast, showToastDetail } from './toast';
import type { Sheets } from './sheets';
import {
  cleanHandle, displayNameOf, getMySquad, getSquadRanking, getWarRanking, handleIssue,
  hasWarEarnings, myPlayerId, onSquadChange, squadAvatarUrl, squadMark, warEndsAt, warPointsOf,
  type RankedSquad, type SquadMember,
} from './squads';
import {
  buildSquadVerifyPanel, checkChannelMembership, joinSquadOnServer, refreshSquadBoard,
  registerSquadWithTelegram, syncChannelTiq, type SquadVerifyPanel,
} from './squadRegister';
import { channelWarAppLink, telegramShareLink } from '../shared/config';

export interface ChannelWarApi {
  sheets: Sheets;
  /** The war queue. `channel_war` is what puts the war identity on the matchmaking stage. */
  queue(mode: 'pvp' | 'arena' | 'channel_war'): void;
  /**
   * The Play with Friends lobby: the one mode that earns Channel TIQ. The hub hands the player
   * straight to it rather than queueing them into a board that would pay their channel nothing.
   */
  openFriends(): void;
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
const SVG_NS = 'http://www.w3.org/2000/svg';

const hash32 = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** Channel TIQ in Latin tabular figures, grouped: `1,450`. A score is a code, not prose. */
const TIQ_FMT = new Intl.NumberFormat('en-US');
const tiqLabel = (n: number): string => TIQ_FMT.format(Math.max(0, Math.floor(n)));

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

/** One inline monochrome glyph. Every icon in this sheet is drawn, never typed. */
function icon(id: string, cls = 'ico'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', id);
  svg.append(use);
  return svg;
}

/** The gold check, rendered only for `verified === true` — never for a pending claim. */
function verifiedBadge(cls = 'squad-vbadge'): HTMLElement {
  const badge = document.createElement('span');
  badge.className = cls;
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', t('squadVerifyBadge'));
  badge.title = t('squadVerifyBadge');
  badge.append(icon('#i-check', 'ico'));
  return badge;
}

/** The neutral `Unverified` pill: present on an unproven squad, never a checkmark. */
function unverifiedPill(cls = 'squad-unverified'): HTMLElement {
  const pill = document.createElement('span');
  pill.className = cls;
  pill.textContent = t('squadVerifyUnverifiedPill');
  return pill;
}

/**
 * The unit itself: the TIQ mark and its three letters in one isolated run.
 *
 * `TIQ` is a code, so it never takes the prose's direction and never inherits the digits' — a
 * Latin acronym beside an Arabic number is exactly where a bidi pass would otherwise shuffle.
 */
function tiqUnit(): HTMLElement {
  const unit = document.createElement('span');
  unit.className = 'cw-tiq-u';
  unit.setAttribute('dir', 'ltr');
  const word = document.createElement('span');
  word.className = 'cw-tiq-w';
  word.textContent = t('cwPts');
  unit.append(icon('#i-tiq', 'ico cw-tiq-ico'), word);
  return unit;
}

/**
 * `1,450 TIQ` — the figure, then the unit. `sign` prefixes the amount for a gain or a spend
 * (`+25 TIQ`); every character of the number stays Latin tabular.
 */
function tiqFigure(n: number, opts: { sign?: '+' | '−' | ''; cls?: string } = {}): HTMLElement {
  const host = document.createElement('span');
  host.className = opts.cls ?? 'cw-tiq';
  host.setAttribute('dir', 'ltr');
  const value = document.createElement('b');
  value.className = 'cw-tiq-n';
  value.textContent = `${opts.sign ?? ''}${tiqLabel(n)}`;
  host.append(value, tiqUnit());
  return host;
}

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

/** Which pane of the sheet is on screen. */
type WarView = 'hub' | 'register' | 'detail';

export function createChannelWarHub(api: ChannelWarApi): ChannelWarHub {
  const root = document.getElementById('channel-war-modal');
  const mainView = document.getElementById('cw-main');
  const regView = document.getElementById('cw-register');
  const detailView = document.getElementById('cw-detail');
  const clock = document.getElementById('cw-countdown');
  const prizeRule = document.getElementById('cw-prize-rule');
  const prizeSub = document.getElementById('cw-prize-sub');
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
  const regVerifyHost = document.getElementById('cw-reg-verify');
  const regSkip = document.getElementById('cw-reg-skip') as HTMLButtonElement | null;
  /** The dual-mode verification block mounted in the register view. */
  let regVerifyPanel: SquadVerifyPanel | null = null;

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

  /* the inspector */
  const detailBack = document.getElementById('cw-detail-back');
  const detailClose = document.getElementById('cw-detail-close');
  const detailBody = detailView?.querySelector<HTMLElement>('.cw-detail-body') ?? null;
  const detailAv = document.getElementById('cw-detail-av');
  const detailImg = document.getElementById('cw-detail-img') as HTMLImageElement | null;
  const detailMark = document.getElementById('cw-detail-mark');
  const detailName = document.getElementById('cw-detail-name');
  const detailHandle = document.getElementById('cw-detail-handle');
  const detailRank = document.getElementById('cw-detail-rank');
  const detailTiq = document.getElementById('cw-detail-tiq');
  const detailMembers = document.getElementById('cw-detail-members');
  const detailFightersN = document.getElementById('cw-detail-fighters-n');
  const detailList = document.getElementById('cw-detail-list');
  const detailNote = document.getElementById('cw-detail-note');
  const detailInvite = document.getElementById('cw-detail-invite');
  const detailPlay = document.getElementById('cw-detail-play');
  const detailPlayT = document.getElementById('cw-detail-play-t');
  const detailJoin = document.getElementById('cw-detail-join');
  const detailJoinT = document.getElementById('cw-detail-join-t');

  /** The squad chosen but not yet enrolled — a selection, never a membership. */
  let picked = '';
  /** The handle whose membership gate is open, or '' when there is nothing to ask. */
  let awaiting = '';
  /** A rally link that named a channel this device has not seen yet. */
  let rallyHandle = '';
  /** The channel the inspector is showing, or '' when it is closed. */
  let detailId = '';
  let view: WarView = 'hub';
  let joining = false;
  let checking = false;
  let registering = false;
  let boardRequest: Promise<void> | null = null;

  const isOpen = (): boolean => !!root && !root.hidden;
  /* A name spoken aloud rides the same bdi wrap as names on the board: RTL prose must not
     reorder a Latin channel title or handle that lands in the reader's ear. */
  const say = (text: string): void => {
    if (!liveRegion) return;
    const iso = document.createElement('bdi');
    iso.setAttribute('dir', 'auto');
    iso.textContent = text;
    liveRegion.textContent = '';
    liveRegion.append(iso);
  };

  const squadById = (id: string): RankedSquad | undefined => getSquadRanking().find((s) => s.id === id);
  /** The inspected channel, read through the war ladder so its rank and total are the board's own. */
  const detailSquad = (): RankedSquad | undefined =>
    detailId ? getWarRanking().find((s) => s.id === detailId) : undefined;

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
   * One ladder row: rank + crest, a spacious two-line identity, Channel TIQ, and the door in.
   *
   * The identity owns the whole middle column so a bilingual title can breathe on line one; the
   * handle, the member count and the team pill share the quieter line beneath it. In an RTL locale
   * the flex row lays these out right-to-left, while `<bdi dir="auto">` keeps every dynamic name,
   * handle and title bidi-contained — no mixed-script word gets chewed up mid-clip.
   *
   * `inspectable` makes the whole row a pointer target and gives it a real chevron key, so a
   * keyboard reaches the same place a thumb does. `selectable` turns the row into a choice in the
   * quick pick.
   */
  function buildRow(
    s: RankedSquad,
    opts: { you: boolean; selectable: boolean; inspectable?: boolean },
  ): HTMLLIElement {
    const tiq = warPointsOf(s);
    const li = document.createElement('li');
    li.className = `cw-row${opts.you ? ' is-you' : ''}${picked === s.id ? ' is-selected' : ''}`;

    const rank = document.createElement('span');
    const scored = tiq > 0;
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

    /* Line 1 — the full-width title. Its own <bdi> isolates a mixed Persian/Latin name so the
       ellipsis lands cleanly at the end of the whole title instead of inside a Persian word. */
    const title = document.createElement('bdi');
    title.className = 'cw-row-title';
    title.setAttribute('dir', 'auto');
    title.textContent = s.name || displayNameOf(s.handle);
    const nameLine = document.createElement('span');
    nameLine.className = 'cw-row-nameline';
    nameLine.append(title);
    if (s.verified === true) nameLine.append(verifiedBadge('squad-vbadge cw-vbadge'));

    /* Line 2 — the quiet metadata: handle · count, then the team pill as a compact inline tag. */
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
    crew.setAttribute('dir', 'auto');
    crew.textContent = membersLabel(s.members);
    meta.append(handle, dot, crew);

    if (opts.you) {
      const pill = document.createElement('span');
      pill.className = 'cw-pill cw-you-pill';
      pill.textContent = t('cwYourTeam');
      meta.append(pill);
    }
    id.append(nameLine, meta);

    const side = document.createElement('span');
    side.className = 'cw-row-side';
    const ptsEl = document.createElement('b');
    ptsEl.className = `cw-row-pts${scored ? '' : ' is-zero'}`;
    ptsEl.append(tiqFigure(tiq));
    side.append(ptsEl);

    if (opts.selectable) {
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

    if (opts.inspectable) {
      li.dataset.detail = s.id;
      li.classList.add('is-inspectable');
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'cw-row-go';
      go.dataset.detail = s.id;
      /* The key names its destination, not the row's contents: a screen reader already read those. */
      go.setAttribute('aria-label', t('cwOpenChannel').replace('{h}', s.handle));
      go.append(icon('#i-chevron-right', 'ico cw-row-go-ico'));
      li.append(go);
    }
    return li;
  }

  function emptyRow(key: string): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'cw-empty';
    li.append(icon('#i-crown', 'ico'));
    const text = document.createElement('span');
    text.textContent = t(key);
    li.append(text);
    return li;
  }

  function paintBoard(): void {
    if (!boardList) return;
    const board = getWarRanking();
    const mine = getMySquad();
    /* Switching is only free while the channel has nothing to lose: a team that has actually
       fought is a team. The total itself is the roster's real TIQ sum, so the test reads the
       banked war column instead of locking every channel that merely has members. */
    const canSelect = !mine || !hasWarEarnings(mine);
    boardList.textContent = '';
    if (!board.length) {
      boardList.append(emptyRow('cwEmptyBoard'));
      paintWait();
      return;
    }
    for (const s of board.slice(0, LADDER_MAX)) {
      const you = !!mine && s.id === mine.id;
      boardList.append(buildRow(s, { you, selectable: canSelect && !you, inspectable: true }));
    }
    paintWait();
    revealMyRow();
  }

  /* ---------- the open challenger slots ---------- */

  /**
   * One quiet invitation, and only one: while the ladder holds fewer than three channels a single
   * dashed card explains that rivals are missing. It sits directly under the rows and is read,
   * not tapped — the register key above it is the only door into the ladder.
   */
  function paintWait(): void {
    const wait = document.getElementById('cw-wait');
    if (!wait) return;
    const open = getWarRanking().length < 3;
    wait.hidden = !open;
    if (open) wait.textContent = t('cwWaitingRivals');
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
    /* The headline names the season's crown and its clock sits at the far end of the same line.
       The prize figure is its own `<bdi dir="ltr">` run so `200` never flips inside a Persian
       sentence; the friends rule under it is one plain muted line, not a second boxed card. */
    if (prizeRule) {
      const [lead, tail = ''] = t('cwPrizeHero').split('{n}');
      const figure = document.createElement('bdi');
      figure.setAttribute('dir', 'ltr');
      figure.textContent = '200';
      prizeRule.textContent = '';
      prizeRule.append(lead, figure, tail);
    }
    if (prizeSub) prizeSub.textContent = t('cwPrizeSub');
  }

  function paintVerify(): void {
    if (!verify) return;
    verify.hidden = !awaiting;
    if (!awaiting) return;
    if (verifyHandle) verifyHandle.textContent = awaiting;
    if (verifyOpenT) paintTemplate(verifyOpenT, t('cwOpenChannel'), { h: awaiting });
  }

  /**
   * The one action bar. An enrolled fighter is not shown a queue key: the only board that pays
   * their channel is a Play with Friends room, so that is the door the key opens.
   */
  function paintCta(): void {
    if (!joinBtn || !joinT) return;
    const mine = getMySquad();
    const switching = !!picked && picked !== mine?.id;
    const playing = !!mine && !switching;
    joinT.textContent = t(playing ? 'cwPlayFriends' : 'cwJoinWar');
    const ready = playing || !!picked;
    joinBtn.setAttribute('aria-disabled', String(!ready));
    joinBtn.setAttribute('aria-busy', String(joining || checking));
    joinBtn.querySelector('use')?.setAttribute('href', playing ? '#i-users' : '#i-user-join');
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
    if (view === 'detail') paintDetail();
  }

  function paintView(): void {
    if (mainView) mainView.hidden = view !== 'hub';
    if (regView) regView.hidden = view !== 'register';
    if (detailView) detailView.hidden = view !== 'detail';
  }

  /* ---------- the inspector ---------- */

  /** One fighter's row: place, face, name, and the real TIQ balance the channel total sums. */
  function buildFighter(m: SquadMember, place: number): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'cw-fighter';

    const rank = document.createElement('span');
    /* The pill always carries the place; the colour stays a prize: muted neutral when the fighter
       holds no TIQ, gold/silver/bronze when they do. */
    const balance = Math.max(0, Math.floor(m.tiq || 0));
    const scored = balance > 0;
    rank.className = `cw-fighter-rank${place <= 3 && scored ? ` is-${place}` : ''}`;
    rank.setAttribute('dir', 'ltr');
    rank.textContent = `#${place}`;

    const av = document.createElement('span');
    av.className = 'cw-fighter-av';
    av.style.setProperty('--cw-hue', String(AVATAR_HUES[hash32(m.id) % AVATAR_HUES.length]));
    const mark = document.createElement('b');
    mark.className = 'cw-fighter-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = (m.name || '?').trim().charAt(0).toUpperCase() || '?';
    av.append(mark);
    const photo = (m.photo ?? '').trim();
    if (/^https:\/\/[^\s]+$/i.test(photo)) {
      const img = document.createElement('img');
      img.className = 'cw-fighter-img';
      img.alt = '';
      img.decoding = 'async';
      img.onerror = () => { img.remove(); };
      img.src = photo;
      av.append(img);
    }

    const name = document.createElement('b');
    name.className = 'cw-fighter-name';
    const bdi = document.createElement('bdi');
    bdi.setAttribute('dir', 'auto');
    bdi.textContent = m.name || t('cwNoName');
    name.append(bdi);

    /* The balance itself, never a `+0` contribution delta: the card's label already says TIQ. */
    const tiq = document.createElement('b');
    tiq.className = 'cw-fighter-tiq';
    tiq.append(tiqFigure(balance));

    li.append(rank, av, name, tiq);
    return li;
  }

  function paintDetailFighters(s: RankedSquad): void {
    if (!detailList) return;
    const rows = [...s.roster].sort((a, b) =>
      Math.max(0, Math.floor(b.tiq || 0)) - Math.max(0, Math.floor(a.tiq || 0))
      || a.id.localeCompare(b.id));
    detailList.textContent = '';
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'cw-empty';
      li.append(icon('#i-users', 'ico'));
      const text = document.createElement('span');
      text.textContent = t('cwEmptyFighters');
      li.append(text);
      detailList.append(li);
      return;
    }
    rows.forEach((m, i) => detailList.append(buildFighter(m, i + 1)));
  }

  /**
   * The contextual foot. Your own channel invites and plays; a channel you could still join
   * offers the join; a channel you are already locked out of says why, once, instead of showing a
   * key that would refuse the tap.
   */
  function paintDetailActions(s: RankedSquad): void {
    const mine = getMySquad();
    const isMine = !!mine && mine.id === s.id;
    const canJoin = !isMine && (!mine || !hasWarEarnings(mine));
    const locked = !isMine && !canJoin;
    if (detailInvite) detailInvite.hidden = !isMine;
    if (detailPlay) detailPlay.hidden = !isMine;
    if (detailJoin) detailJoin.hidden = !canJoin;
    if (detailNote) {
      detailNote.hidden = !locked;
      detailNote.textContent = locked ? t('cwSwitchLocked') : '';
    }
    if (detailPlayT) detailPlayT.textContent = t('cwPlayFriends');
    if (detailJoinT) detailJoinT.textContent = t('cwJoinThis');
    detailJoin?.setAttribute('aria-busy', String(joining || checking));
  }

  function paintDetail(): void {
    const s = detailSquad();
    /* The channel left the registry under the inspector: the pane it belonged to is gone, so the
       sheet goes back to the ladder it came from rather than standing on an empty room. */
    if (!s) {
      if (detailId) { detailId = ''; view = 'hub'; paintView(); paint(); }
      return;
    }
    paintAvatar(detailImg, detailMark, detailAv, s);
    if (detailName) detailName.textContent = s.name || displayNameOf(s.handle);
    if (detailHandle) detailHandle.textContent = s.handle;
    /* The strict gate lives beside the handle: a check only for a proven squad, and a quiet
       unverified pill otherwise. Rebuilt on every paint so it can never outlive a revoke. */
    const heroSub = detailHandle?.parentElement;
    if (heroSub) {
      heroSub.querySelectorAll('.squad-vbadge, .squad-unverified').forEach((node) => node.remove());
      heroSub.append(s.verified === true
        ? verifiedBadge('squad-vbadge cw-vbadge')
        : unverifiedPill('squad-unverified cw-unverified'));
    }
    const tiq = warPointsOf(s);
    if (detailRank) {
      const scored = tiq > 0;
      detailRank.className = `cw-hero-rank${scored ? (s.rank <= 3 ? ` is-${s.rank}` : '') : ' is-none'}`;
      /* `#1` is a code and reads LTR everywhere; the word for "no place yet" is prose and takes
         whatever direction the locale is already running in. */
      detailRank.setAttribute('dir', scored ? 'ltr' : 'auto');
      detailRank.textContent = scored ? `#${s.rank}` : t('cwUnranked');
    }
    /* The metric in its own plain figure — the plate's label already says what the number is. */
    if (detailTiq) detailTiq.textContent = tiqLabel(tiq);
    /* Telegram's own audience. `null` is "the bot never got an answer" — a dash, never a zero. */
    if (detailMembers) {
      const audience = s.telegramMembers;
      detailMembers.textContent = typeof audience === 'number' && Number.isFinite(audience) && audience >= 0
        ? TIQ_FMT.format(Math.floor(audience))
        : '—';
      detailMembers.classList.toggle('is-unknown', typeof audience !== 'number');
    }
    if (detailFightersN) {
      const fighters = typeof s.botFightersCount === 'number' && Number.isFinite(s.botFightersCount)
        ? s.botFightersCount : s.members;
      detailFightersN.textContent = TIQ_FMT.format(Math.max(0, Math.floor(fighters)));
    }
    paintDetailFighters(s);
    paintDetailActions(s);

    /* The founder of an unverified channel gets the same dual-mode door as the drawer. Any
       other viewer, and every verified squad, sees no verification controls at all. */
    document.getElementById('cw-detail-verify')?.remove();
    const viewerId = myPlayerId();
    const isFounder = !!viewerId && (s.ownerId ?? '') === viewerId;
    if (s.verified !== true && isFounder && detailBody) {
      const host = document.createElement('section');
      host.id = 'cw-detail-verify';
      host.className = 'cw-verifybox';
      const fighters = detailBody.querySelector('.cw-fighters');
      detailBody.insertBefore(host, fighters ?? null);
      const panel = buildSquadVerifyPanel({
        mode: 'verify',
        handle: () => s.handle,
        squadId: s.id,
        onVerified: () => {
          notify('success');
          showToast(t('squadVerifyDone'), 'success');
          void refreshSquadBoard().then(() => { if (isOpen()) paint(); });
        },
        onError: (message) => {
          notify('warning');
          showToast(message, 'warning');
        },
        onNotice: (message) => {
          notify('success');
          showToast(message, 'success');
        },
      });
      host.append(panel.el);
    }
  }

  function openDetail(id: string): void {
    if (!id || !detailView) return;
    detailId = id;
    view = 'detail';
    impact('light');
    closePick();
    paintDetail();
    paintView();
    if (detailBody) detailBody.scrollTop = 0;
    const s = detailSquad();
    say(s ? `${s.name || s.handle}` : t('cwDetailTitle'));
  }

  function closeDetail(): void {
    detailId = '';
    view = 'hub';
    paintView();
    paint();
    requestAnimationFrame(revealMyRow);
  }

  /**
   * Hand the player to the one mode that pays their channel.
   *
   * The hub closes first: the friends lobby is its own sheet, and two sheets stacked would leave
   * the drawer opening behind the tournament it was launched from.
   */
  function playFriends(): void {
    impact('heavy');
    api.sheets.close();
    api.openFriends();
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
    /* Enrolled and staying: the key is the friends lobby, not a queue. */
    if (mine && !switching) { playFriends(); return; }
    if (!picked) { openPick(); return; }
    const squad = squadById(picked);
    if (!squad) { picked = ''; paint(); return; }
    await gate(squad);
  }

  /**
   * Join the channel the inspector is showing. The gate runs exactly as it does from the hub —
   * a tap on this key is not a shortcut past the membership proof — and the sheet returns to the
   * ladder either way: a success lands the player's new team in the action bar, and a refusal
   * lands on the membership card, which is the one place that prompt lives.
   */
  async function joinFromDetail(): Promise<void> {
    const squad = detailSquad();
    if (!squad || joining || checking) return;
    picked = squad.id;
    await gate(squad);
    closeDetail();
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
      if (label) label.textContent = t(on ? 'squadVerifyBusy' : 'squadVerifyBotCta');
    }
    if (regSkip) {
      regSkip.disabled = on;
      regSkip.setAttribute('aria-busy', String(on));
    }
    if (regHandle) regHandle.disabled = on;
    if (regName) regName.disabled = on;
  }

  /** Mount the shared dual-mode verification block inside the admin door. */
  function mountRegVerifyPanel(): void {
    if (!regVerifyHost) return;
    regVerifyHost.textContent = '';
    regVerifyPanel = buildSquadVerifyPanel({
      mode: 'register',
      handle: () => cleanHandle(regHandle?.value ?? ''),
      onPostRegister: (code) => { void submitRegister('post', code); },
      onError: (message) => setRegErrorText(message),
      onNotice: (message) => {
        notify('success');
        showToast(message, 'success');
      },
    });
    regVerifyHost.append(regVerifyPanel.el);
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
    mountRegVerifyPanel();
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

  async function submitRegister(method: 'bot' | 'none' | 'post' = 'bot', code = ''): Promise<void> {
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
    }, undefined, {
      method,
      ...(method === 'post' ? { verifyCode: code } : {}),
    });
    registering = false;
    setRegBusy(false);
    if (!result.ok) {
      if (result.error === 'already_registered') { await adoptRegistered(handle); return; }
      /* A verification refusal keeps the admin on this pane: the handle, the identity and the
         Method 1 / Method 2 cards are all still there to finish the job. */
      if (result.error === 'verify_code_expired') regVerifyPanel?.resetCode();
      setRegErrorText(result.message || t('cwJoinFailed'));
      notify('warning');
      return;
    }
    if (!result.squad) { setRegError('enlistErrAlready'); notify('warning'); return; }
    /* A verified enlistment already proved the player's admin seat, so the membership gate is
       answered; an unverified one is a normal registration that earns its badge later. */
    const verified = result.squad.verified === true;
    welcome(result.squad);
    showInviteCard(result.squad.handle);
    notify('success');
    if (verified) showToast(t('squadVerifyDone'), 'success');
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
    /* The player's own balance is saved first: the board that comes back sums real TIQ, and the
       total for their channel must already include the number this device is holding. */
    boardRequest = syncChannelTiq()
      .then(() => refreshSquadBoard())
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
      if (!root) { api.openFriends(); return; }
      const handle = prefill ? cleanHandle(prefill) : '';
      const known = handle
        ? getSquadRanking().find((s) => s.handle.toLowerCase() === handle.toLowerCase())
        : undefined;
      view = 'hub';
      detailId = '';
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
  regGo?.addEventListener('click', () => { void submitRegister('bot'); });
  regSkip?.addEventListener('click', () => { void submitRegister('none'); });
  regHandle?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void submitRegister('bot');
  });
  regHandle?.addEventListener('input', () => {
    if (regErr && !regErr.hidden) setRegError('');
    regVerifyPanel?.handleChanged();
  });
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

  detailBack?.addEventListener('click', () => { impact('light'); closeDetail(); });
  detailClose?.addEventListener('click', () => { impact('light'); closeDetail(); });
  detailPlay?.addEventListener('click', () => { playFriends(); });
  detailInvite?.addEventListener('click', () => { rally(); });
  detailJoin?.addEventListener('click', () => { void joinFromDetail(); });

  /* The ladder answers two taps: the inline Select key picks a squad, anywhere else on the row
     opens its inspector. The chevron is the same door for a keyboard. */
  boardList?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const sel = target?.closest<HTMLElement>('[data-select]');
    if (sel) { choose(sel.dataset.select ?? ''); return; }
    const row = target?.closest<HTMLElement>('[data-detail]');
    if (row?.dataset.detail) openDetail(row.dataset.detail);
  });
  /* The quick pick has one verb: a tap anywhere on a row is that row's selection. */
  pickList?.addEventListener('click', (event) => {
    const hit = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-select]');
    const id = hit?.dataset.select ?? '';
    if (id) choose(id);
  });
  pickX?.addEventListener('click', () => { impact('light'); closePick(); });

  /* A rally link is a prompt, not an enrolment: it raises the hub with the channel already
     selected, and the Join key is still the only thing that puts a player on a roster. */
  window.addEventListener('detour:channel-war-invite', (event) => {
    const handle = (event as CustomEvent<{ handle?: string }>).detail?.handle ?? '';
    if (handle) hub.open(handle);
  });

  onSquadChange(() => { if (isOpen()) paint(); });
  /* One repaint covers every pane: `paint()` re-reads the ladder and, when the inspector is the
     pane on screen, its hero, plates and roster too. The register view's verification cards are
     built from the dictionary, so a language flip remounts them. */
  onLang(() => {
    if (!isOpen()) return;
    if (view === 'register') mountRegVerifyPanel();
    paint();
  });

  return hub;
}
