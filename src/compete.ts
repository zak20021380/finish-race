/**
 * compete.ts — Arena (Tournament Cups) + Ranks (dedicated Leaderboard).
 *
 * IA: Arena owns Live / Upcoming / Archive cups only. Ranks is the dedicated
 * leaderboard tab with a two-way clay switch ("Telegram Squads" clan wars vs
 * "Solo Champions" top players) plus a docked "My Squad Standing" card so the
 * player always sees their community progress. Solo Champions keeps the
 * Players | Countries | Teams secondary switch.
 * Tournament cards are high-energy Dark Clay arena cards with per-status
 * hierarchy (live glow + ENTER NOW, upcoming slate + Register, ended archive).
 */
import {
  formatCountdown,
  getCountryRanking,
  getPlayerRanking,
  getTeamRanking,
  getTournaments,
  trendArrow,
  type CountryRow,
  type PlayerRow,
  type TeamRow,
  type Tournament,
} from './data';
import { flagOf, nameOf } from './countries';
import { coinText, mountCoins, setBalance } from './coin';
import { myTeam, onChange, profile, spendCoins } from './storage';
import { bindSquadById, getMyContribution, getMySquad, getSquadRanking, onSquadChange, squadKind, squadLetter, type RankedSquad } from './squads';
import { impact, notify, tgUser } from './telegram';
import type { Router } from './router';
import type { Sheets } from './sheets';

export interface CompeteApi {
  router: Router;
  sheets: Sheets;
  sheet(id: string): HTMLElement | null;
}

type RankMode = 'squads' | 'solo';
type LbTab = 'players' | 'countries' | 'teams';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const JOINED_KEY = 'detour.tourneys.v1';

function joinedSet(): Set<string> {
  try {
    const raw = window.localStorage.getItem(JOINED_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set<string>();
  }
}

function saveJoined(s: Set<string>): void {
  try {
    window.localStorage.setItem(JOINED_KEY, JSON.stringify([...s]));
  } catch {
    /* in-memory only */
  }
}

const skel = (rows: number): string =>
  Array.from({ length: rows }, () => '<div class="skel-row"><span class="skel w20"></span><span class="skel w60"></span><span class="skel w15"></span></div>').join('');

const empty = (msg: string): string => `<div class="empty" role="status">${msg}</div>`;

const pctOf = (t: Tournament): number =>
  t.maxPlayers > 0 ? Math.min(100, Math.max(0, Math.round((t.players / t.maxPlayers) * 100))) : 0;

const moodOf = (t: Tournament): string => {
  const pct = pctOf(t);
  if (t.status === 'live') {
    if (pct >= 85) return 'Closing Soon';
    if (pct >= 50) return 'Filling fast';
    return 'Open';
  }
  if (pct >= 90) return 'Almost full';
  if (pct >= 50) return 'Filling fast';
  return 'Open';
};

function pickEl(id: string, legacy: string): HTMLElement {
  return (document.getElementById(id) ?? document.getElementById(legacy)) as HTMLElement;
}

export function createCompete(api: CompeteApi): { setRoute(id: string): void } {
  const modeBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-rankmode],[data-squadmode]')];
  const lbBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-lb]')];
  const feedLabel = document.getElementById('arena-feed-t');
  const ranksStats = document.getElementById('ranks-stats');
  const arenaPane = pickEl('arena-tournaments', 'comp-tournaments');
  const squadsPane = pickEl('ranks-squads', 'comp-squads');
  const soloWrap = document.getElementById('ranks-solo');
  const lbPanes: Record<LbTab, HTMLElement> = {
    players: pickEl('ranks-players', 'comp-players'),
    countries: pickEl('ranks-countries', 'comp-countries'),
    teams: pickEl('ranks-teams', 'comp-teams'),
  };

  let rankMode: RankMode = 'squads';
  let lbTab: LbTab = 'players';
  let loadedArena = false;
  let loadedLb: Partial<Record<LbTab, boolean>> = {};
  let squadsLoaded = false;
  let tournaments: Tournament[] = [];
  let joined = joinedSet();
  let pending: Tournament | null = null;
  let tick = 0;

  const youName = (): string => {
    const u = tgUser();
    const full = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
    return (full || u?.username || 'You').slice(0, 18);
  };

  /* ---------- squad dock helpers ---------- */

  const squadDock = (): HTMLElement | null =>
    document.getElementById('ranks-dock') ?? document.getElementById('squad-dock');

  const openSquadSheet = (): void => {
    (document.getElementById('team-chip') as HTMLButtonElement | null)?.click();
  };

  const inviteSquad = (s: RankedSquad): void => {
    const text = `${s.handle} — join my squad in Detour!`;
    try {
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text).then(
          () => notify('success'),
          () => notify('warning'),
        );
      } else {
        notify('success');
      }
    } catch {
      notify('warning');
    }
    impact('medium');
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

  const isArenaVisible = (): boolean => {
    const el = document.getElementById('s-arena') ?? document.getElementById('s-compete');
    return !!el && !el.hidden;
  };

  function paintArena(): void {
    paintFeedLabel();
  }

  function paintRanks(): void {
    for (const b of modeBtns) {
      const v = b.dataset.rankmode ?? b.dataset.squadmode;
      const selected = v === rankMode || (rankMode === 'solo' && v === 'solo') || (rankMode === 'squads' && v === 'squads');
      b.setAttribute('aria-selected', String(selected));
    }
    for (const b of lbBtns) b.setAttribute('aria-selected', String(b.dataset.lb === lbTab));
    const squads = rankMode === 'squads';
    squadsPane.hidden = !squads;
    if (soloWrap) soloWrap.hidden = squads;
    // Legacy single-pane board (pre-split markup): keep hidden unless solo.
    const legacyBoard = document.getElementById('comp-leaderboard');
    if (legacyBoard) legacyBoard.hidden = squads;
    if (!squads) {
      for (const k of Object.keys(lbPanes) as LbTab[]) lbPanes[k].hidden = k !== lbTab;
    }
    paintRanksStats();
    const dock = squadDock();
    if (dock) dock.hidden = false;
    paintSquadDock();
  }

  function paintFeedLabel(): void {
    if (!feedLabel) return;
    const live = tournaments.filter((t) => t.status === 'live').length;
    const up = tournaments.filter((t) => t.status === 'upcoming').length;
    if (!tournaments.length) {
      feedLabel.textContent = 'Arena feed';
      return;
    }
    const parts: string[] = [];
    if (live) parts.push(`${live} live`);
    if (up) parts.push(`${up} upcoming`);
    feedLabel.textContent = parts.length ? `${parts.join(' · ')} cups` : 'Arena feed';
  }

  function paintRanksStats(): void {
    if (!ranksStats) return;
    try {
      const rows = getSquadRanking();
      const fighters = rows.reduce((n, s) => n + s.members, 0);
      const trophies = rows.reduce((n, s) => n + s.trophies, 0);
      const me = getMySquad();
      const base = `${rows.length} squads · ${compactCount(fighters)} fighters · ${compactCount(trophies)} 🏆`;
      ranksStats.textContent = me ? `${base} · you: ${me.handle} #${me.rank}` : `${base} · join a squad to climb`;
    } catch {
      ranksStats.textContent = 'Squad Warfare · live standings';
    }
  }

  function selectRankMode(next: RankMode): void {
    if (next === rankMode && (next === 'squads' ? squadsLoaded : loadedLb[lbTab])) {
      paintRanks();
      return;
    }
    rankMode = next;
    paintRanks();
    impact('light');
    if (next === 'squads') loadSquads();
    else void loadLb(lbTab);
    const sc = document.getElementById('ranks-scroll');
    if (sc) sc.scrollTo({ top: 0 });
  }

  for (const b of modeBtns) {
    b.addEventListener('click', () => {
      const v = (b.dataset.rankmode ?? b.dataset.squadmode) as string | undefined;
      if (v === 'solo' || v === 'squads') selectRankMode(v);
    });
  }

  function selectLb(next: LbTab): void {
    if (next === lbTab && loadedLb[next]) {
      paintRanks();
      return;
    }
    lbTab = next;
    if (rankMode !== 'solo') rankMode = 'solo';
    paintRanks();
    impact('light');
    void loadLb(next);
  }

  for (const b of lbBtns) {
    b.addEventListener('click', () => {
      const v = b.dataset.lb as LbTab;
      if (v === 'players' || v === 'countries' || v === 'teams') selectLb(v);
    });
  }

  /* ---------- arena feed ---------- */

    /* ---------- arena pass (tickets + best finish) state ---------- */

  const PASS_KEY = 'detour.arena.pass.v1';

  interface PassState {
    tickets: number;
    /** YYYY-MM-DD of the last daily claim, local time */
    lastClaim: string;
    best: string;
  }

  function todayStr(): string {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function readPass(): PassState {
    const fallback: PassState = { tickets: 2, lastClaim: '', best: 'Top 4' };
    try {
      const raw = window.localStorage.getItem(PASS_KEY);
      if (!raw) return fallback;
      const p = JSON.parse(raw) as Partial<PassState>;
      return {
        tickets: typeof p.tickets === 'number' && Number.isFinite(p.tickets) ? Math.max(0, Math.min(9, Math.floor(p.tickets))) : fallback.tickets,
        lastClaim: typeof p.lastClaim === 'string' ? p.lastClaim : '',
        best: typeof p.best === 'string' && p.best.length > 0 && p.best.length <= 24 ? p.best : fallback.best,
      };
    } catch {
      return fallback;
    }
  }

  function writePass(s: PassState): void {
    try {
      window.localStorage.setItem(PASS_KEY, JSON.stringify(s));
    } catch {
      /* in-memory only */
    }
  }

  function bestFinishLabel(): string {
    // Persisted best finish; new devices start at the motivational default.
    // A real backend would compute this from tournament results.
    const stored = readPass().best;
    if (joined.size > 0) return stored || 'Top 4';
    if (profile.stats.games > 0) return stored || 'Top 4';
    return stored || 'Top 4';
  }

  function trophyPoolOf(t: Tournament): number {
    if (typeof t.trophyPool === 'number' && Number.isFinite(t.trophyPool)) return Math.max(0, Math.floor(t.trophyPool));
    return Math.max(0, Math.round(t.prizePool / 8));
  }

  function trophyEl(kind: 'neon' | 'steel' | 'dim'): HTMLElement {
    const t = document.createElement('span');
    t.className = `trophy trophy-${kind}`;
    t.setAttribute('aria-hidden', 'true');
    const badge = document.createElement('span');
    badge.className = 'trophy-badge';
    // Build SVG via DOM (no innerHTML) so no orphan text nodes can leak.
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(svgNS, 'use');
    use.setAttribute('href', '#i-cup');
    svg.append(use);
    badge.append(svg);
    t.append(badge);
    return t;
  }

  /** Dual prize pool — exact spec format, pure text (no orphan spans).
   *  Hero: "🏆 250 Trophies  ·  🪙 5,000 Coins" (full labels, prominent).
   *  Upcoming (compact): "🪙 2,500 · 🏆 150". */
  function prizePoolEl(t: Tournament, compact = false): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = compact ? 'arena-prizes is-compact' : 'arena-prizes is-hero-pool';
    const coins = coinText(t.prizePool);
    const trophies = trophyPoolOf(t).toLocaleString('en-US');
    if (compact) {
      wrap.textContent = `🪙 ${coins} · 🏆 ${trophies}`;
      wrap.setAttribute('aria-label', `Prize pool ${coins} coins plus ${trophies} trophies`);
    } else {
      wrap.textContent = `🏆 ${trophies} Trophies  ·  🪙 ${coins} Coins`;
      wrap.setAttribute('aria-label', `Prize pool ${trophies} trophies plus ${coins} coins`);
    }
    return wrap;
  }

  function meterEl(t: Tournament): HTMLElement {
    const pct = pctOf(t);
    const wrap = document.createElement('div');
    wrap.className = 'cap-meter';
    const track = document.createElement('span');
    track.className = 'cap-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', `${t.name} capacity: ${t.players} of ${t.maxPlayers} entered`);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(pct));
    const fill = document.createElement('i');
    fill.className = 'cap-fill';
    fill.style.width = `${pct}%`;
    track.append(fill);
    wrap.append(track);
    return wrap;
  }

  function capLabelEl(t: Tournament): HTMLElement {
    const label = document.createElement('span');
    label.className = 'cap-label';
    // Spec-exact dynamic capacity: "184/256 Players" (no spaces, no "Entered").
    label.append(document.createTextNode(`${t.players}/${t.maxPlayers} Players · `));
    const hot = document.createElement('span');
    hot.className = 'hot';
    hot.textContent = moodOf(t);
    label.append(hot);
    label.setAttribute('aria-label', `${t.players} of ${t.maxPlayers} players entered, ${moodOf(t)}`);
    return label;
  }

  function actionBtn(t: Tournament): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isJoined = joined.has(t.id);
    if (t.status === 'live') {
      btn.className = 'btn btn-coral arena-cta hero-cta';
      btn.disabled = isJoined;
      // Spec-exact primary CTA: bold tactile 3D "ENTER ARENA" (CSS uppercases visually).
      btn.textContent = isJoined ? 'Entered ✓' : 'ENTER ARENA';
      btn.dataset.hero = 'enter';
    } else {
      btn.className = 'btn btn-ghost arena-cta upcoming-cta';
      btn.disabled = isJoined;
      if (isJoined) btn.textContent = t.entryFee ? 'Registered ✓' : 'Reminder Set ✓';
      else btn.textContent = t.entryFee ? 'Register' : 'Remind Me';
    }
    btn.setAttribute('aria-label', `${btn.textContent}: ${t.name}`);
    btn.addEventListener('click', () => askJoin(t));
    return btn;
  }

  function buildLiveCard(t: Tournament): HTMLElement {
    const card = document.createElement('article');
    card.className = 'arena-card is-live is-hero';
    card.dataset.id = t.id;
    card.setAttribute('aria-label', `${t.name}, live tournament, prize pool ${coinText(t.prizePool)} plus ${trophyPoolOf(t)} trophies`);

    const glow = document.createElement('div');
    glow.className = 'arena-glow';
    glow.setAttribute('aria-hidden', 'true');
    card.append(glow);
    const backlight = document.createElement('div');
    backlight.className = 'arena-hero-backlight';
    backlight.setAttribute('aria-hidden', 'true');
    card.append(backlight);

    const top = document.createElement('div');
    top.className = 'arena-top';
    const id = document.createElement('div');
    id.className = 'arena-id';
    id.append(trophyEl('neon'));
    const titles = document.createElement('div');
    titles.className = 'arena-titles';
    const name = document.createElement('h3');
    name.className = 'arena-name';
    name.textContent = t.name;
    const sub = document.createElement('p');
    sub.className = 'arena-sub';
    sub.textContent = t.entryFee ? `${coinText(t.entryFee)} entry · Free with ticket` : 'Free entry';
    titles.append(name, sub);
    id.append(titles);
    const badge = document.createElement('span');
    badge.className = 'pill live pulse';
    badge.setAttribute('aria-label', 'Live tournament');
    const dot = document.createElement('i');
    dot.className = 'live-dot';
    dot.setAttribute('aria-hidden', 'true');
    // Spec-exact pulsing red "● LIVE" (dot + uppercase label, no orphan text).
    const liveLabel = document.createElement('b');
    liveLabel.className = 'live-label';
    liveLabel.textContent = 'LIVE';
    badge.append(dot, liveLabel);
    top.append(id, badge);
    card.append(top);

    const prizeRow = document.createElement('div');
    prizeRow.className = 'arena-prize-row hero-prizes';
    prizeRow.append(prizePoolEl(t, false));
    const time = document.createElement('span');
    time.className = 'arena-time hero-time';
    time.dataset.count = t.id;
    time.textContent = `${formatCountdown(t.endsAt)} left`;
    prizeRow.append(time);
    card.append(prizeRow);

    const capBlock = document.createElement('div');
    capBlock.className = 'arena-cap-block';
    capBlock.append(capLabelEl(t), meterEl(t));
    card.append(capBlock);

    const foot = document.createElement('div');
    foot.className = 'arena-foot hero-foot';
    const feeNote = document.createElement('span');
    feeNote.className = 'arena-entry-note';
    feeNote.textContent = t.entryFee ? `${coinText(t.entryFee)} to enter` : 'Free to enter';
    foot.append(feeNote, actionBtn(t));
    card.append(foot);
    return card;
  }

  function buildUpcomingCard(t: Tournament): HTMLElement {
    const card = document.createElement('article');
    card.className = 'arena-card is-upcoming';
    card.dataset.id = t.id;
    card.setAttribute('aria-label', `${t.name}, upcoming tournament, prize pool ${coinText(t.prizePool)} plus ${trophyPoolOf(t)} trophies`);

    const top = document.createElement('div');
    top.className = 'arena-top';
    const id = document.createElement('div');
    id.className = 'arena-id';
    id.append(trophyEl('steel'));
    const titles = document.createElement('div');
    titles.className = 'arena-titles';
    const name = document.createElement('h3');
    name.className = 'arena-name';
    name.textContent = t.name;
    const sub = document.createElement('p');
    sub.className = 'arena-sub';
    sub.textContent = t.entryFee ? `${coinText(t.entryFee)} entry · Free with ticket` : 'Free entry · Reminder available';
    titles.append(name, sub);
    id.append(titles);
    const badge = document.createElement('span');
    badge.className = 'pill upcoming countdown-badge';
    badge.dataset.start = t.id;
    // Spec-exact uppercase countdown: "STARTS IN 1D 1H".
    badge.textContent = `STARTS IN ${formatCountdown(t.endsAt).toUpperCase()}`;
    top.append(id, badge);
    card.append(top);

    const prizeRow = document.createElement('div');
    prizeRow.className = 'arena-prize-row';
    prizeRow.append(prizePoolEl(t, true));
    const slots = document.createElement('span');
    slots.className = 'arena-slots';
    slots.textContent = `${t.maxPlayers - t.players} slots left`;
    prizeRow.append(slots);
    card.append(prizeRow);

    const capBlock = document.createElement('div');
    capBlock.className = 'arena-cap-block';
    capBlock.append(capLabelEl(t), meterEl(t));
    card.append(capBlock);

    const foot = document.createElement('div');
    foot.className = 'arena-foot upcoming-foot';
    const feeNote = document.createElement('span');
    feeNote.className = 'arena-entry-note';
    feeNote.textContent = t.entryFee ? `${coinText(t.entryFee)} entry` : 'Free entry';
    foot.append(feeNote, actionBtn(t));
    card.append(foot);
    return card;
  }

  function buildEndedCard(t: Tournament): HTMLElement {
    const card = document.createElement('article');
    card.className = 'arena-card is-ended';
    card.dataset.id = t.id;

    const top = document.createElement('div');
    top.className = 'arena-top';
    const id = document.createElement('div');
    id.className = 'arena-id';
    id.append(trophyEl('dim'));
    const titles = document.createElement('div');
    titles.className = 'arena-titles';
    const name = document.createElement('h3');
    name.className = 'arena-name';
    name.textContent = t.name;
    const sub = document.createElement('p');
    sub.className = 'arena-sub';
    sub.textContent = 'Final · archived';
    titles.append(name, sub);
    id.append(titles);
    const badge = document.createElement('span');
    badge.className = 'pill ended';
    badge.textContent = 'Final';
    top.append(id, badge);
    card.append(top);

    const champ = document.createElement('div');
    champ.className = 'arena-champ';
    const cup = document.createElement('span');
    cup.className = 'champ-cup';
    cup.textContent = '🏆';
    cup.setAttribute('aria-hidden', 'true');
    const who = document.createElement('span');
    who.className = 'champ-who';
    who.textContent = t.champion ?? 'Champion crowned';
    const meta = document.createElement('span');
    meta.className = 'champ-meta';
    const paid = t.championMeta ? `${t.championMeta} · ${coinText(t.prizePool)} paid` : `${coinText(t.prizePool)} distributed`;
    meta.textContent = paid;
    champ.append(cup, who, meta);
    champ.setAttribute('aria-label', `Winner ${who.textContent}, ${paid}`);
    card.append(champ);
    return card;
  }

  /** Player Arena Pass & Status: clean ticket bar (no orphans, no truncation). */
  function buildPassWidget(liveCount: number): HTMLElement {
    const pass = readPass();
    const claimedToday = pass.lastClaim === todayStr();

    const card = document.createElement('section');
    card.className = 'arena-pass';
    card.setAttribute('aria-label', 'Player Arena Pass and status');

    const main = document.createElement('div');
    main.className = 'arena-pass-main';

    const left = document.createElement('div');
    left.className = 'arena-pass-left';
    const ico = document.createElement('span');
    ico.className = 'arena-pass-ico';
    ico.textContent = '🎟️';
    ico.setAttribute('aria-hidden', 'true');
    const titles = document.createElement('div');
    titles.className = 'arena-pass-titles';
    // Spec-exact clean balance: "Tickets: 2" (single text node, no emoji dup, no orphans).
    const count = document.createElement('b');
    count.className = 'arena-pass-count';
    count.textContent = `Tickets: ${pass.tickets}`;
    const sub = document.createElement('small');
    sub.className = 'arena-pass-sub';
    sub.textContent = liveCount ? `Best Finish: ${bestFinishLabel()} · ${liveCount} live` : `Best Finish: ${bestFinishLabel()}`;
    titles.append(count, sub);
    left.append(ico, titles);

    const actions = document.createElement('div');
    actions.className = 'arena-pass-actions';

    const claim = document.createElement('button');
    claim.type = 'button';
    claim.className = 'btn btn-primary sm arena-pass-claim';
    claim.disabled = claimedToday;
    claim.textContent = claimedToday ? 'Claimed ✓' : 'Claim +1 Free';
    claim.setAttribute('aria-label', claimedToday ? 'Daily ticket already claimed' : 'Claim free daily ticket');
    claim.addEventListener('click', () => {
      const cur = readPass();
      if (cur.lastClaim === todayStr()) return;
      cur.tickets = Math.min(9, cur.tickets + 1);
      cur.lastClaim = todayStr();
      writePass(cur);
      count.textContent = `Tickets: ${cur.tickets}`;
      claim.disabled = true;
      claim.textContent = 'Claimed ✓';
      claim.setAttribute('aria-label', 'Daily ticket already claimed');
      notify('success');
      impact('medium');
    });

    const history = document.createElement('button');
    history.type = 'button';
    history.className = 'btn btn-ghost sm arena-pass-history';
    history.textContent = 'History';
    history.setAttribute('aria-label', 'Open tournament history');
    history.addEventListener('click', () => {
      impact('light');
      const arch = arenaPane.querySelector<HTMLDetailsElement>('details.arena-archive');
      if (arch) {
        arch.open = true;
        const sum = arch.querySelector<HTMLElement>('summary');
        if (sum) sum.focus({ preventScroll: true });
        arch.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        api.router.go('ranks');
      }
    });

    actions.append(claim, history);
    main.append(left, actions);
    card.append(main);
    return card;
  }

  async function loadTournaments(): Promise<void> {
    const el = arenaPane;
    if (!el) return;
    if (!loadedArena) el.innerHTML = skel(3);
    try {
      tournaments = await getTournaments();
    } catch {
      el.innerHTML = empty('Tournaments unavailable. Check your connection and try again.');
      paintFeedLabel();
      return;
    }
    // Live first, upcoming next, ended last — the feed never mixes the archive in.
    tournaments.sort((a, b) => {
      const order = { live: 0, upcoming: 1, ended: 2 } as const;
      return order[a.status] - order[b.status];
    });
    if (!tournaments.length) {
      el.innerHTML = empty('No tournaments right now. Check back soon.');
      el.append(buildPassWidget(0));
      paintFeedLabel();
      return;
    }
    el.textContent = '';
    const live = tournaments.filter((t) => t.status === 'live');
    const up = tournaments.filter((t) => t.status === 'upcoming');
    const done = tournaments.filter((t) => t.status === 'ended');

    for (const t of live) el.append(buildLiveCard(t));
    for (const t of up) el.append(buildUpcomingCard(t));

    // Player status module fills the vertical gap between cards and dock.
    el.append(buildPassWidget(live.length));

    if (done.length) {
      const arch = document.createElement('details');
      arch.className = 'arena-archive';
      const sum = document.createElement('summary');
      sum.className = 'arena-archive-sum';
      const t = document.createElement('span');
      t.textContent = `Archive · Recent Results (${done.length})`;
      const archChev: HTMLElement = document.createElement('span');
      archChev.className = 'arch-chev';
      archChev.textContent = '›';
      archChev.setAttribute('aria-hidden', 'true');
      sum.append(t, archChev);
      arch.append(sum);
      const list = document.createElement('div');
      list.className = 'arena-archive-list';
      for (const e of done) list.append(buildEndedCard(e));
      arch.append(list);
      el.append(arch);
    }

    mountCoins(el);
    loadedArena = true;
    paintFeedLabel();
    startTick();
  }

  function askJoin(t: Tournament): void {
    if (t.status === 'ended' || joined.has(t.id)) return;
    pending = t;
    ($('tourney-desc') as HTMLElement).textContent = `${t.name} · ${t.players}/${t.maxPlayers} players · ${formatCountdown(t.endsAt)} left`;
    ($('tourney-fee') as HTMLElement).textContent = coinText(t.entryFee);
    setBalance($('tourney-have') as HTMLElement, profile.coins);
    ($('tourney-after') as HTMLElement).textContent = coinText(Math.max(0, profile.coins - t.entryFee));
    const err = $('tourney-err');
    err.hidden = true;
    const yes = $('tourney-yes') as HTMLButtonElement;
    yes.textContent = t.entryFee ? `Join for ${coinText(t.entryFee)}` : 'Join free';
    yes.disabled = profile.coins < t.entryFee;
    if (profile.coins < t.entryFee) {
      err.hidden = false;
      err.textContent = `Not enough coins — ${coinText(t.entryFee - profile.coins)} short. Win a race to top up.`;
    }
    const sheet = api.sheet('sheet-tourney');
    if (sheet) {
      impact('light');
      api.sheets.open(sheet);
    }
  }

  ($('tourney-yes') as HTMLButtonElement).addEventListener('click', () => {
    if (!pending) return;
    const t = pending;
    pending = null;
    if (joined.has(t.id)) {
      api.sheets.close();
      return;
    }
    if (!spendCoins(t.entryFee)) {
      notify('warning');
      ($('tourney-err') as HTMLElement).hidden = false;
      ($('tourney-err') as HTMLElement).textContent = 'Not enough coins for that entry.';
      return;
    }
    joined.add(t.id);
    saveJoined(joined);
    notify('success');
    impact('medium');
    api.sheets.close();
    loadedArena = false;
    void loadTournaments();
  });

  function startTick(): void {
    if (tick) return;
    tick = window.setInterval(() => {
      if (!isArenaVisible()) return;
      for (const t of tournaments) {
        if (t.status === 'ended') continue;
        const time = arenaPane.querySelector<HTMLElement>(`[data-count="${t.id}"]`);
        if (time) time.textContent = `${formatCountdown(t.endsAt)} left`;
        const pill = arenaPane.querySelector<HTMLElement>(`[data-start="${t.id}"]`);
        if (pill) pill.textContent = `STARTS IN ${formatCountdown(t.endsAt).toUpperCase()}`;
      }
    }, 1000);
  }

  /* ---------- solo leaderboard (behind the Ranks switch) ---------- */

  async function loadLb(which: LbTab): Promise<void> {
    if (which === 'countries') await loadCountries();
    else if (which === 'players') await loadPlayers();
    else await loadTeams();
    loadedLb[which] = true;
  }

  function row(rank: number, flag: string, name: string, sub: string | null, points: string, trend: string, me: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `rank-row${me ? ' me' : ''}`;
    const rk = document.createElement('span');
    rk.className = 'rk';
    rk.textContent = String(rank);
    const fl = document.createElement('span');
    fl.className = 'fl';
    fl.textContent = flag;
    fl.setAttribute('aria-hidden', 'true');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = name;
    if (sub) {
      const s = document.createElement('small');
      s.textContent = sub;
      nm.append(s);
    }
    const pt = document.createElement('span');
    pt.className = 'pt';
    pt.textContent = points;
    const tr = document.createElement('span');
    tr.className = `tr ${trend}`;
    tr.textContent = trendArrow(trend as 'up' | 'down' | 'same');
    li.append(rk, fl, nm, pt, tr);
    return li;
  }

  function pinned(el: HTMLElement, node: HTMLElement): void {
    const wrap = document.createElement('div');
    wrap.className = 'rank-pinned';
    wrap.append(node);
    el.append(wrap);
  }

  async function loadCountries(): Promise<void> {
    const el = lbPanes.countries;
    if (!loadedLb.countries) el.innerHTML = skel(6);
    let rows: CountryRow[];
    try {
      rows = await getCountryRanking();
    } catch {
      el.innerHTML = empty('Rankings unavailable. Check your connection and try again.');
      return;
    }
    if (!rows.length) {
      el.innerHTML = empty('No countries ranked yet.');
      return;
    }
    el.textContent = '';
    const ol = document.createElement('ol');
    ol.className = 'rank-list';
    for (const c of rows) {
      ol.append(row(c.rank, flagOf(c.code), `${c.name}`, null, c.points.toLocaleString('en-US'), c.trend, profile.country === c.code));
    }
    el.append(ol);
    const mine = profile.country;
    if (mine) {
      const hit = rows.find((c) => c.code === mine);
      const meRow = document.createElement('div');
      meRow.className = 'rank-row me';
      meRow.innerHTML = '';
      const rk = document.createElement('span');
      rk.className = 'rk';
      rk.textContent = hit ? String(hit.rank) : '—';
      const fl = document.createElement('span');
      fl.className = 'fl';
      fl.textContent = flagOf(mine);
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = `You · ${nameOf(mine)}`;
      const pt = document.createElement('span');
      pt.className = 'pt';
      pt.textContent = hit ? hit.points.toLocaleString('en-US') : '0';
      meRow.append(rk, fl, nm, pt);
      pinned(el, meRow);
    } else {
      const hint = document.createElement('button');
      hint.className = 'rank-row rank-pinned hint';
      hint.type = 'button';
      hint.textContent = 'Pick your country in Profile to appear here.';
      hint.setAttribute('aria-label', 'Pick your country in Profile');
      hint.addEventListener('click', () => { impact('light'); api.router.go('profile'); });
      el.append(hint);
    }
  }

  async function loadPlayers(): Promise<void> {
    const el = lbPanes.players;
    if (!loadedLb.players) el.innerHTML = skel(6);
    let rows: PlayerRow[];
    try {
      rows = await getPlayerRanking();
    } catch {
      el.innerHTML = empty('Rankings unavailable. Check your connection and try again.');
      return;
    }
    if (!rows.length) {
      el.innerHTML = empty('No players ranked yet.');
      return;
    }
    el.textContent = '';
    const ol = document.createElement('ol');
    ol.className = 'rank-list';
    rows.forEach((p, i) => {
      ol.append(row(i + 1, flagOf(p.countryCode), p.name, `${p.wins} wins`, p.points.toLocaleString('en-US'), p.trend, false));
    });
    el.append(ol);
    const meRow = document.createElement('div');
    meRow.className = 'rank-row me';
    const rk = document.createElement('span');
    rk.className = 'rk';
    rk.textContent = '—';
    const fl = document.createElement('span');
    fl.className = 'fl';
    fl.textContent = profile.country ? flagOf(profile.country) : '•';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = `You · ${youName()}`;
    const sub = document.createElement('small');
    sub.textContent = `${profile.stats.wins} wins · ${profile.stats.games} games`;
    nm.append(sub);
    const pt = document.createElement('span');
    pt.className = 'pt';
    pt.textContent = (profile.stats.wins * 120 + profile.stats.games * 20).toLocaleString('en-US');
    meRow.append(rk, fl, nm, pt);
    pinned(el, meRow);
  }

  async function loadTeams(): Promise<void> {
    const el = lbPanes.teams;
    if (!loadedLb.teams) el.innerHTML = skel(5);
    let rows: TeamRow[];
    try {
      rows = await getTeamRanking();
    } catch {
      el.innerHTML = empty('Rankings unavailable. Check your connection and try again.');
      return;
    }
    if (!rows.length) {
      el.innerHTML = empty('No teams ranked yet.');
      return;
    }
    el.textContent = '';
    const ol = document.createElement('ol');
    ol.className = 'rank-list';
    const mine = myTeam();
    for (const t of rows) {
      ol.append(row(t.rank, '🛡', t.name, `${t.code} · ${t.members} members`, t.points.toLocaleString('en-US'), t.trend, mine?.id === t.id || mine?.code === t.code));
    }
    el.append(ol);
    if (mine) {
      const hit = rows.find((r) => r.id === mine.id || r.code === mine.code);
      const meRow = document.createElement('div');
      meRow.className = 'rank-row me';
      const rk = document.createElement('span');
      rk.className = 'rk';
      rk.textContent = hit ? String(hit.rank) : '—';
      const fl = document.createElement('span');
      fl.className = 'fl';
      fl.textContent = '🛡';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = `You · ${mine.name}`;
      const pt = document.createElement('span');
      pt.className = 'pt';
      pt.textContent = hit ? hit.points.toLocaleString('en-US') : '0';
      meRow.append(rk, fl, nm, pt);
      pinned(el, meRow);
    } else {
      const hint = document.createElement('button');
      hint.className = 'rank-row rank-pinned hint';
      hint.type = 'button';
      hint.textContent = 'Find a team on Home to appear here.';
      hint.setAttribute('aria-label', 'Find a team on Home');
      hint.addEventListener('click', () => { impact('light'); api.router.go('home'); });
      el.append(hint);
    }
  }

  /* ---------- Telegram Squads: channel/community ranking ---------- */

  function squadRow(s: RankedSquad, mine: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `squad-row${mine ? ' me' : ''}`;
    li.tabIndex = 0;
    li.dataset.id = s.id;
    li.title = `${s.name} · ${s.handle}`;
    li.setAttribute('aria-label', `${s.name}, ${s.handle}, rank ${s.rank}, ${s.trophies.toLocaleString('en-US')} trophies. Press Enter for squad details.`);
    if (mine) li.setAttribute('aria-current', 'true');

    const rk = document.createElement('span');
    rk.className = `rk${s.rank === 1 ? ' gold' : s.rank === 2 ? ' silver' : s.rank === 3 ? ' bronze' : ''}`;
    rk.textContent = String(s.rank);
    rk.setAttribute('aria-hidden', 'true');

    const av = document.createElement('span');
    av.className = 'squad-avatar';
    av.textContent = squadLetter(s);
    av.setAttribute('aria-hidden', 'true');

    const txt = document.createElement('span');
    txt.className = 'squad-txt';

    const nameRow = document.createElement('span');
    nameRow.className = 'squad-name-row';
    const nm = document.createElement('span');
    nm.className = 'squad-name';
    nm.textContent = s.name;
    nm.title = s.name;
    // Tiny subtle kind icon — never a space-eating pill. Full label stays in title/a11y.
    const kind = document.createElement('span');
    const k = squadKind(s);
    kind.className = 'squad-kind';
    kind.dataset.kind = k;
    kind.textContent = k === 'channel' ? '📢' : '👥';
    kind.title = k === 'channel' ? 'Telegram channel' : 'Telegram group';
    kind.setAttribute('aria-hidden', 'true');
    nameRow.append(nm, kind);

    const sub = document.createElement('span');
    sub.className = 'squad-sub';
    sub.textContent = `${s.handle} · ${compactCount(s.members)} members`;

    txt.append(nameRow, sub);

    const pt = document.createElement('span');
    pt.className = 'squad-pt';
    const num = document.createElement('b');
    num.textContent = s.trophies.toLocaleString('en-US');
    const cup = document.createElement('span');
    cup.className = 'trophy';
    cup.textContent = '🏆';
    cup.setAttribute('aria-hidden', 'true');
    pt.append(num, cup);
    pt.title = `${s.trophies.toLocaleString('en-US')} squad trophies`;
    pt.setAttribute('aria-label', `${s.trophies.toLocaleString('en-US')} trophies`);

    const go = document.createElement('button');
    go.type = 'button';
    if (mine) {
      go.className = 'squad-go bound invite';
      go.textContent = 'Invite';
      go.setAttribute('aria-label', `Invite to ${s.handle}: copy squad invite`);
      go.addEventListener('click', (e) => {
        e.stopPropagation();
        inviteSquad(s);
      });
    } else {
      go.className = 'squad-go join';
      go.textContent = 'Join';
      go.setAttribute('aria-label', `Join ${s.handle}`);
      go.addEventListener('click', (e) => {
        e.stopPropagation();
        impact('light');
        const r = bindSquadById(s.id);
        if (r === 'bad-handle') { notify('warning'); return; }
        notify('success');
        impact('medium');
        loadSquads();
      });
    }

    // The whole row opens squad details; the compact key joins / invites.
    li.addEventListener('click', () => {
      impact('light');
      openSquadSheet();
    });
    li.addEventListener('keydown', (e) => {
      if (e.target !== li) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        impact('light');
        openSquadSheet();
      }
    });

    // 3-column flex: left (rank + avatar, fixed) · center (dynamic info) · right (score + CTA, fixed).
    const left = document.createElement('span');
    left.className = 'squad-left';
    left.setAttribute('aria-hidden', 'true');
    left.append(rk, av);
    // rk/av were marked aria-hidden individually; the row itself carries the label.
    rk.removeAttribute('aria-hidden');
    av.removeAttribute('aria-hidden');
    const right = document.createElement('span');
    right.className = 'squad-right';
    right.append(pt, go);
    li.append(left, txt, right);
    return li;
  }

  function paintSquadDock(): void {
    const dock = squadDock();
    if (!dock) return;
    if (!isRanksVisible()) {
      dock.hidden = true;
      return;
    }
    dock.hidden = false;
    const me = getMySquad();
    dock.textContent = '';
    dock.classList.toggle('member', !!me);

    if (!me) {
      const ico = document.createElement('span');
      ico.className = 'squad-dock-ico';
      ico.textContent = '🏆';
      ico.setAttribute('aria-hidden', 'true');

      const txt = document.createElement('span');
      txt.className = 'squad-dock-txt';
      const t = document.createElement('b');
      t.textContent = 'Join a squad to earn trophies for your community';
      const s = document.createElement('small');
      s.textContent = 'Race points count for your channel or group';
      txt.append(t, s);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary sm squad-dock-btn';
      btn.textContent = 'Find Squad';
      btn.setAttribute('aria-label', 'Find Squad: open squad picker');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        impact('light');
        openSquadSheet();
      });

      dock.append(ico, txt, btn);
      dock.setAttribute('aria-label', 'My Squad Standing: no squad bound. Find a squad to start earning trophies.');
      return;
    }

    const mine = getMyContribution();
    const av = document.createElement('span');
    av.className = 'squad-avatar';
    av.textContent = squadLetter(me);
    av.setAttribute('aria-hidden', 'true');

    const txt = document.createElement('span');
    txt.className = 'squad-dock-txt';
    const t = document.createElement('b');
    t.textContent = `My Squad · ${me.handle} · #${me.rank}`;
    t.title = `${me.name} · ${me.handle}`;
    const s = document.createElement('small');
    const yours = mine > 0 ? ` · +${mine.toLocaleString('en-US')} yours` : ' · fight to contribute';
    s.textContent = `${me.trophies.toLocaleString('en-US')} trophies${yours}`;
    txt.append(t, s);

    const invite = document.createElement('button');
    invite.type = 'button';
    invite.className = 'btn btn-primary sm squad-dock-btn';
    invite.textContent = 'Invite';
    invite.setAttribute('aria-label', `Invite to ${me.handle}: copy squad invite`);
    invite.addEventListener('click', (e) => {
      e.stopPropagation();
      inviteSquad(me);
    });

    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'btn btn-ghost sm squad-dock-btn';
    view.textContent = 'View';
    view.setAttribute('aria-label', `View ${me.handle} squad details`);
    view.addEventListener('click', (e) => {
      e.stopPropagation();
      impact('light');
      openSquadSheet();
    });

    dock.append(av, txt, invite, view);
    dock.setAttribute('aria-label', `My Squad Standing: ${me.handle}, rank ${me.rank}, ${me.trophies.toLocaleString('en-US')} trophies.`);
  }

  function loadSquads(): void {
    const el = squadsPane;
    if (!el) return;
    if (!squadsLoaded) el.innerHTML = skel(5);
    const rows = getSquadRanking();
    if (!rows.length) {
      el.innerHTML = empty('No squads ranked yet.');
      paintSquadDock();
      paintRanksStats();
      return;
    }
    const me = getMySquad();
    el.textContent = '';
    const ol = document.createElement('ol');
    ol.className = 'squad-list';
    for (const s of rows) {
      ol.append(squadRow(s, me?.id === s.id));
    }
    el.append(ol);
    paintSquadDock();
    paintRanksStats();
    squadsLoaded = true;
  }

  onChange(() => {
    loadedLb.countries = false;
    loadedLb.players = false;
    loadedLb.teams = false;
    loadedArena = false;
    squadsLoaded = false;
    if (isRanksVisible()) {
      paintRanks();
      if (rankMode === 'squads') loadSquads();
      else void loadLb(lbTab);
    } else if (isArenaVisible()) {
      paintArena();
      void loadTournaments();
    }
  });

  onSquadChange(() => {
    squadsLoaded = false;
    paintRanksStats();
    if (isRanksVisible()) {
      if (rankMode === 'squads') loadSquads();
      else paintSquadDock();
    }
  });

  return {
    setRoute(id: string) {
      // Legacy "compete" route lands on Arena (its old default feed).
      if (id === 'compete') id = 'arena';
      if (id === 'arena') {
        paintArena();
        void loadTournaments();
      } else if (id === 'ranks') {
        paintRanks();
        if (rankMode === 'squads') loadSquads();
        else void loadLb(lbTab);
      }
    },
  };
}
