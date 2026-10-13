/**
 * compete.ts — Arena (Tournament Cups) + Ranks (dedicated Leaderboard).
 *
 * IA: Arena owns Live / Upcoming / Archive cups only. Ranks is "The Mind Ladder":
 * one three-way clay switch over Top Minds (solo champions), Intellect Guilds
 * (Telegram channels & groups) and Nations IQ (aggregate country score). Above
 * the ladder sits the Top 3 clay podium, so the list itself starts at #4; the
 * guild board carries its Join / Invite keys there. The squad dock ("My Squad
 * Standing" / join prompt) belongs EXCLUSIVELY to the guild board, and the
 * "Your Standing" module to the two IQ boards.
 * Identity: TIQ (Tactical IQ) is the hero metric — gold digits with the brain
 * glyph, on the HUD pills, the podium and the ladder. #i-cup is reserved for
 * season prizes. The four mind tiers (Rookie / Tactician / Strategist /
 * Grandmaster) are an aura colour driven off your TIQ, never a badge word.
 * Tournament cards are high-energy Dark Clay arena cards with per-status
 * hierarchy (live glow + ENTER ARENA, upcoming slate + Pre-register, ended
 * archive). The Hero cup is three flex rows — header · prizes & meta ·
 * capacity + CTA — and every card sizes to its own content: no fixed height,
 * no overflow clipping, no truncated line.
 */
import {
  formatCountdown,
  getCountryRanking,
  getPlayerRanking,
  getTournaments,
  trendArrow,
  type CountryRow,
  type PlayerRow,
  type Tournament,
} from './data';
import { flagOf, nameOf } from './countries';
import { coinSvg, coinText, mountCoins, setBalance } from './coin';
import { onChange, profile, spendCoins } from './storage';
import { bindSquadById, getMyContribution, getMySquad, getSquadRanking, onSquadChange, squadKind, squadLetter, type RankedSquad } from './squads';
import { impact, notify, tgUser } from './telegram';
import type { Router } from './router';
import type { Sheets } from './sheets';

export interface CompeteApi {
  router: Router;
  sheets: Sheets;
  sheet(id: string): HTMLElement | null;
}

type Board = 'minds' | 'guilds' | 'nations';

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

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------- Mind Ladder identity: the season clock and the TIQ tiers ---------- */

/** Season 4 closes 2026-10-16 14:00Z. Anchoring to a fixed boundary and rolling it
 *  every 28 days keeps the scarcity chip a real countdown after that date instead
 *  of a frozen string that quietly stops matching the pulsing dot beside it. */
const SEASON_ANCHOR = Date.UTC(2026, 9, 16, 14, 0);
const SEASON_MS = 28 * 86400_000;

function seasonOf(t: number): { no: number; endsAt: number } {
  const k = Math.ceil((t - SEASON_ANCHOR) / SEASON_MS);
  return { no: 4 + k, endsAt: SEASON_ANCHOR + k * SEASON_MS };
}

/** TIQ bands. The tier is an aura colour, never a badge word on the ladder. */
type MindTier = 'rookie' | 'tactician' | 'strategist' | 'grandmaster';

function tierOf(tiq: number): MindTier {
  if (tiq >= 3000) return 'grandmaster';
  if (tiq >= 2000) return 'strategist';
  if (tiq >= 1000) return 'tactician';
  return 'rookie';
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

export function createCompete(api: CompeteApi): { setRoute(id: string): void } {
  const boardBtns = [...document.querySelectorAll<HTMLButtonElement>('.ranks-tabs [data-board]')];
  const feedLabel = document.getElementById('arena-feed-t');
  const ranksStats = document.getElementById('ranks-stats');
  const boardSwitch = document.querySelector<HTMLElement>('.ranks-tabs');
  const ranksScreen = document.getElementById('s-ranks');
  const seasonChip = document.getElementById('ranks-season');
  const seasonText = seasonChip?.querySelector<HTMLElement>('.ml-season-t') ?? null;
  const arenaPane = pickEl('arena-tournaments', 'comp-tournaments');
  const podiumEl = document.getElementById('ranks-podium');
  const panes: Record<Board, HTMLElement | null> = {
    minds: document.getElementById('ranks-minds'),
    guilds: document.getElementById('ranks-guilds'),
    nations: document.getElementById('ranks-nations'),
  };

  let board: Board = 'minds';
  let loadedBoard: Partial<Record<Board, boolean>> = {};
  let loadedArena = false;
  /** Aggregate of the last ladder each solo board loaded — the stat chips quote it. */
  const boardStats: Record<'minds' | 'nations', { loaded: boolean; rows: number; points: number }> = {
    minds: { loaded: false, rows: 0, points: 0 },
    nations: { loaded: false, rows: 0, points: 0 },
  };
  let tournaments: Tournament[] = [];
  let joined = joinedSet();
  let pending: Tournament | null = null;
  let tick = 0;

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

  const myTrophyScore = (): number =>
    Math.max(0, profile.stats.wins * 120 + profile.stats.games * 20);

  const myRecord = (): string =>
    `${profile.stats.wins}W · ${profile.stats.losses}L`;

  const soloStandingEl = (): HTMLElement | null =>
    document.getElementById('solo-standing');

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
    paintSeason();
    for (const b of boardBtns) b.setAttribute('aria-selected', String(b.dataset.board === board));
    if (boardSwitch) boardSwitch.dataset.active = board;
    for (const k of Object.keys(panes) as Board[]) {
      const pane = panes[k];
      if (pane) pane.hidden = k !== board;
    }
    // "Your Standing" is a player fact — it belongs to the two IQ boards, never to a guild.
    const standing = soloStandingEl();
    if (standing) standing.hidden = board === 'guilds';
    paintRanksStats();
    // The squad banner belongs EXCLUSIVELY to the Intellect Guilds board.
    const dock = squadDock();
    if (dock) dock.hidden = board !== 'guilds';
    if (board === 'guilds') paintSquadDock();
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

  /** One quick-stat chip: sprite icon + value over a muted label. */
  function setChip(key: 'a' | 'b' | 'c', icon: string, value: string, label: string): void {
    const chip = ranksStats?.querySelector<HTMLElement>(`[data-stat="${key}"]`);
    if (!chip) return;
    chip.querySelector('use')?.setAttribute('href', icon);
    const n = chip.querySelector<HTMLElement>('.rstat-n');
    const l = chip.querySelector<HTMLElement>('.rstat-l');
    if (n) n.textContent = value;
    if (l) l.textContent = label;
  }

  const quietChips = (): void => {
    setChip('a', '#i-brain', '—', 'Tactical Minds');
    setChip('b', '#i-brain', '—', 'Combined TIQ');
    setChip('c', '#i-star', '—', 'Your TIQ');
  };

  /**
   * The pills read as a headcount, a field total and your own number. Only the two
   * TIQ pills carry gold digits — the brain is the score's glyph now, so the cup is
   * free to mean a season prize alone. Which population each counts follows the
   * visible board: quoting guild totals while the user reads the solo ladder is what
   * the old single-sentence stat bar got wrong.
   */
  function paintRanksStats(): void {
    if (!ranksStats) return;
    if (ranksScreen) ranksScreen.dataset.tier = tierOf(myTrophyScore());
    // The coral rim means "this number is yours", so it can only sit on the pill that carries it.
    ranksStats.querySelector<HTMLElement>('[data-stat="c"]')?.classList.toggle('is-you', board !== 'guilds');
    if (board === 'guilds') {
      try {
        const rows = getSquadRanking();
        setChip('a', '#i-shield', String(rows.length), 'Mind Guilds');
        setChip('b', '#i-brain', compactCount(rows.reduce((n, s) => n + s.members, 0)), 'Tactical Minds');
        setChip('c', '#i-brain', compactCount(rows.reduce((n, s) => n + s.trophies, 0)), 'Combined TIQ');
      } catch {
        quietChips();
      }
      return;
    }
    const nations = board === 'nations';
    const st = boardStats[nations ? 'nations' : 'minds'];
    setChip('a', nations ? '#i-globe' : '#i-brain', st.loaded ? String(st.rows) : '—', nations ? 'Nations' : 'Tactical Minds');
    setChip('b', '#i-brain', st.loaded ? compactCount(st.points) : '—', 'Combined TIQ');
    setChip('c', '#i-star', compactCount(myTrophyScore()), 'Your TIQ');
  }

  /** The season capsule: "S4 · 3d 14h left", recomputed on entry and every tick. */
  function paintSeason(): void {
    if (!seasonText) return;
    const t = Date.now();
    const s = seasonOf(t);
    const left = formatCountdown(s.endsAt, t);
    seasonText.textContent = `S${s.no} · ${left} left`;
    seasonChip?.setAttribute('title', `Season ${s.no} closes in ${left}`);
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

  /** Dual prize pool — the shared coin SVG + trophies, no orphan spans, no truncation.
   *  Hero: two tactile chips, gold coins "5,000" + sky trophies "🏆 750".
   *  Upcoming (compact): one quiet line "5,000 · 🏆 150". */
  function prizePoolEl(t: Tournament, compact = false): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = compact ? 'arena-prizes is-compact' : 'arena-prizes is-hero-pool';
    const coins = coinText(t.prizePool);
    const trophies = trophyPoolOf(t).toLocaleString('en-US');
    wrap.setAttribute('aria-label', `Prize pool ${coins} coins plus ${trophies} trophies`);

    const coinHost = document.createElement('span');
    coinHost.className = 'arena-coin';
    coinHost.append(coinSvg());
    const amount = document.createElement('span');
    amount.className = 'arena-coin-amt';
    amount.textContent = coins;

    const cup = document.createElement('span');
    cup.className = 'arena-cup-emo';
    cup.textContent = '🏆';
    cup.setAttribute('aria-hidden', 'true');
    const trAmt = document.createElement('span');
    trAmt.className = 'arena-trophy-amt';
    trAmt.textContent = trophies;

    if (compact) {
      wrap.append(coinHost, amount, document.createTextNode(' · '), cup, trAmt);
    } else {
      const coinChip = document.createElement('span');
      coinChip.className = 'arena-prize-chip is-coins';
      coinChip.append(coinHost, amount);
      const trophyChip = document.createElement('span');
      trophyChip.className = 'arena-prize-chip is-trophies';
      trophyChip.append(cup, trAmt);
      wrap.append(coinChip, trophyChip);
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

  /** Capacity head. Hero is spec-exact: "184/256 entered". Upcoming keeps the
   *  fill mood after it. Always a single line the card has room for — never clipped. */
  function capLabelEl(t: Tournament, hero = false): HTMLElement {
    const label = document.createElement('span');
    label.className = 'cap-label';
    label.append(document.createTextNode(hero ? `${t.players}/${t.maxPlayers} entered` : `${t.players}/${t.maxPlayers} entered · `));
    if (!hero) {
      const hot = document.createElement('span');
      hot.className = 'hot';
      hot.textContent = moodOf(t);
      label.append(hot);
    }
    label.setAttribute('aria-label', `${t.players} of ${t.maxPlayers} players entered${hero ? '' : `, ${moodOf(t)}`}`);
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
      // Spec-exact secondary CTA: sleek tactile "Pre-register".
      if (isJoined) btn.textContent = t.entryFee ? 'Pre-registered ✓' : 'Reminder Set ✓';
      else btn.textContent = 'Pre-register';
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

    /* Row 1 — header: cup icon + cup name on the left, pulsing ● LIVE on the right. */
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
    titles.append(name);
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

    /* Row 2 — prizes & meta: gold coins + trophies + entry info (+ time left). */
    const prizeRow = document.createElement('div');
    prizeRow.className = 'arena-prize-row hero-prizes';
    prizeRow.append(prizePoolEl(t, false));
    const entry = document.createElement('span');
    entry.className = 'arena-sub hero-entry';
    entry.textContent = t.entryFee ? `${coinText(t.entryFee)} entry · Free with ticket` : 'Free entry';
    prizeRow.append(entry);
    const time = document.createElement('span');
    time.className = 'arena-time hero-time';
    time.dataset.count = t.id;
    time.textContent = `${formatCountdown(t.endsAt)} left`;
    prizeRow.append(time);
    card.append(prizeRow);

    /* Row 3 — capacity & CTA: progress meter on the left, ENTER ARENA on the right. */
    const foot = document.createElement('div');
    foot.className = 'arena-foot hero-foot';
    const capBlock = document.createElement('div');
    capBlock.className = 'arena-cap-block';
    capBlock.append(capLabelEl(t, true), meterEl(t));
    foot.append(capBlock, actionBtn(t));
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

    // Foot: capacity meter left, sleek tactile Pre-register right — never clipped.
    const foot = document.createElement('div');
    foot.className = 'arena-foot upcoming-foot';
    const capBlock = document.createElement('div');
    capBlock.className = 'arena-cap-block';
    capBlock.append(capLabelEl(t), meterEl(t));
    foot.append(capBlock, actionBtn(t));
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

  /** Player Arena Pass & Status: clean ticket bar (no orphans, no truncation).
   *  Left = icon + stacked "Tickets: 2" / "Best Finish: Top 4"; right = actions. */
  function buildPassWidget(): HTMLElement {
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
    sub.textContent = `Best Finish: ${bestFinishLabel()}`;
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
      el.append(buildPassWidget());
      paintFeedLabel();
      return;
    }
    el.textContent = '';
    const live = tournaments.filter((t) => t.status === 'live');
    const up = tournaments.filter((t) => t.status === 'upcoming');
    const done = tournaments.filter((t) => t.status === 'ended');

    for (const t of live) el.append(buildLiveCard(t));
    for (const t of up) el.append(buildUpcomingCard(t));

    // Player status module sits right under the cups in the same flex column.
    el.append(buildPassWidget());

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
      if (isRanksVisible()) paintSeason();
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

  /* ---------- IQ boards (Top Minds | Nations IQ) ----------
     No floating / absolute "you" bar. The user's standing lives in #solo-standing,
     an in-flow summary module directly under the board tabs. The ladder itself is a
     pure list: the podium owns #1-3, so its rows start at #4. */

  async function loadBoard(which: Board): Promise<void> {
    if (which === 'guilds') loadSquads();
    else if (which === 'nations') await loadNations();
    else await loadMinds();
    loadedBoard[which] = true;
  }

  const podiumOf = (rank: number): '' | 'gold' | 'silver' | 'bronze' =>
    rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';

  function flagBadge(codeOrEmoji: string, code: string): HTMLSpanElement {
    const fl = document.createElement('span');
    fl.className = 'fl';
    fl.setAttribute('aria-hidden', 'true');
    const flag = document.createElement('span');
    flag.className = 'flag';
    flag.textContent = codeOrEmoji;
    const chip = document.createElement('span');
    chip.className = 'flag-code';
    chip.textContent = code;
    fl.append(flag, chip);
    return fl;
  }

  /* ---------- Top 3 clay podium ---------- */

  interface PodiumEntry {
    rank: number;
    name: string;
    score: string;
    /** Nation entry: Unicode flag emoji, with its ISO chip as the Windows fallback. */
    flag?: string;
    code?: string;
    /** Guild / player entry: a single-letter clay medallion. */
    letter?: string;
    /** The ladder no longer carries #1-3, so a board whose rows have actions must move them up here. */
    action?: HTMLElement;
    onTap?: () => void;
  }

  function podiumCard(e: PodiumEntry): HTMLElement {
    const card = document.createElement('div');
    card.className = `pod-card ${podiumOf(e.rank)}`;
    card.dataset.rank = String(e.rank);
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-label', `Rank ${e.rank}: ${e.name}, ${e.score} Tactical IQ`);

    const medal = document.createElement('span');
    medal.className = 'pod-medal';
    medal.setAttribute('aria-hidden', 'true');
    if (e.rank === 1) medal.append(svgIcon('#i-crown', 'pod-crown'));
    const medalN = document.createElement('b');
    medalN.textContent = String(e.rank);
    medal.append(medalN);

    const av = document.createElement('span');
    av.className = 'pod-av';
    av.setAttribute('aria-hidden', 'true');
    if (e.flag && e.code) {
      av.append(flagBadge(e.flag, e.code));
    } else {
      av.textContent = (e.letter ?? e.name).replace(/^@/, '').slice(0, 1).toUpperCase();
    }

    const nm = document.createElement('span');
    nm.className = 'pod-name';
    nm.textContent = e.name;
    nm.title = e.name;

    const iq = document.createElement('span');
    iq.className = 'pod-iq';
    iq.append(svgIcon('#i-brain', 'pod-tiq'));
    const iqN = document.createElement('b');
    iqN.textContent = e.score;
    iq.append(iqN);
    iq.title = `${e.score} Tactical IQ`;

    const step = document.createElement('span');
    step.className = 'pod-step';
    step.setAttribute('aria-hidden', 'true');
    const stepN = document.createElement('b');
    stepN.textContent = String(e.rank);
    step.append(stepN);

    /* The pillar is the card's base, so the join / invite key stacks above it —
       otherwise the step ends up floating in the middle of the card. */
    card.append(medal, av, nm, iq);
    if (e.action) card.append(e.action);
    card.append(step);
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

  function paintPodium(entries: PodiumEntry[]): void {
    const host = podiumEl;
    if (!host) return;
    host.textContent = '';
    const top = entries.filter((e) => e.rank >= 1 && e.rank <= 3);
    if (!top.length) {
      host.hidden = true;
      return;
    }
    const boardName = board === 'guilds' ? 'Intellect Guilds' : board === 'nations' ? 'Nations IQ' : 'Top Minds';
    host.setAttribute('aria-label', `Top ${top.length} on ${boardName}`);
    host.append(...top.map(podiumCard));
    host.hidden = false;
  }

  /** Shared ladder row: rank crest · identity · tabular score · right-edge action. */
  function rankCrest(rank: number): HTMLElement {
    const rk = document.createElement('span');
    rk.className = 'lb-rank';
    const n = document.createElement('b');
    n.textContent = String(rank);
    rk.append(n);
    return rk;
  }

  function scoreCell(points: string, title: string): HTMLElement {
    const pt = document.createElement('span');
    pt.className = 'lb-score';
    pt.append(svgIcon('#i-brain', 'lb-tiq'));
    const num = document.createElement('b');
    num.textContent = points;
    pt.append(num);
    pt.title = title;
    return pt;
  }

  function row(rank: number, flagEmoji: string, flagCode: string, name: string, sub: string | null, points: string, trend: 'up' | 'down' | 'same', me: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `rank-row lb-row${me ? ' is-you' : ''}`;
    const trendLabel = trend === 'up' ? 'rising' : trend === 'down' ? 'falling' : 'steady';
    li.setAttribute('aria-label', `#${rank} ${name} — ${points} Tactical IQ, ${trendLabel}`);
    if (me) li.setAttribute('aria-current', 'true');

    const id = document.createElement('span');
    id.className = 'lb-id';
    id.append(flagBadge(flagEmoji, flagCode));
    const txt = document.createElement('span');
    txt.className = 'lb-txt';
    const nm = document.createElement('span');
    nm.className = 'lb-name';
    nm.textContent = name;
    nm.title = name;
    txt.append(nm);
    if (sub) {
      const s = document.createElement('span');
      s.className = 'lb-sub';
      s.textContent = sub;
      txt.append(s);
    }
    id.append(txt);

    const act = document.createElement('span');
    act.className = 'lb-act';
    const tr = document.createElement('span');
    tr.className = `tr ${trend}`;
    tr.textContent = trendArrow(trend);
    tr.title = trendLabel;
    tr.setAttribute('aria-hidden', 'true');
    act.append(tr);

    li.append(rankCrest(rank), id, scoreCell(points, `${points} Tactical IQ`), act);
    return li;
  }

  /** "Your Standing" summary module — in-flow below the sub-tabs, never floating. */
  function paintSoloStanding(opts: {
    tab: Board;
    rankText: string;
    percentText: string | null;
    score: number;
    extraSub: string | null;
  }): void {
    const host = soloStandingEl();
    if (!host) return;
    host.hidden = false;
    host.textContent = '';

    const av = document.createElement('span');
    av.className = 'standing-avatar';
    av.setAttribute('aria-hidden', 'true');
    if (opts.tab === 'nations' && profile.country) {
      av.textContent = flagOf(profile.country);
    } else {
      const h = youHandle() ?? 'Y';
      av.textContent = h.replace(/^@/, '').slice(0, 1).toUpperCase() || 'Y';
    }

    const main = document.createElement('span');
    main.className = 'standing-main';
    const name = document.createElement('b');
    name.className = 'standing-name';
    name.textContent = youLabel();
    name.title = youLabel();
    const sub = document.createElement('small');
    sub.className = 'standing-sub';
    const detail = [opts.rankText !== '-' ? opts.rankText : '', opts.percentText ?? '', myRecord(), opts.extraSub ?? '']
      .filter((p) => p.length > 0)
      .join(' · ');
    sub.textContent = detail;
    main.append(name, sub);

    const score = document.createElement('span');
    score.className = 'standing-score';
    score.append(svgIcon('#i-brain', 'tiq'));
    const num = document.createElement('b');
    num.textContent = opts.score.toLocaleString('en-US');
    score.append(num);
    score.title = `${opts.score.toLocaleString('en-US')} Tactical IQ`;
    score.setAttribute('aria-label', `${opts.score.toLocaleString('en-US')} Tactical IQ, ${detail}`);

    host.append(av, main, score);
    host.setAttribute('aria-label', `Your Standing: ${youLabel()}, ${detail}, ${opts.score.toLocaleString('en-US')} Tactical IQ`);
  }

  function paintMindsStanding(): void {
    paintSoloStanding({
      tab: 'minds',
      rankText: '-',
      percentText: null,
      score: myTrophyScore(),
      extraSub: profile.stats.games > 0 ? null : 'Unranked · play to climb',
    });
  }

  function paintNationsStanding(rows: CountryRow[] | null): void {
    const code = profile.country;
    const hit = code && rows ? rows.find((c) => c.code === code) : undefined;
    if (hit && rows) {
      const pct = Math.max(1, Math.round((hit.rank / Math.max(1, rows.length)) * 100));
      paintSoloStanding({
        tab: 'nations',
        rankText: `#${hit.rank}`,
        percentText: `Top ${pct}%`,
        score: hit.points,
        extraSub: nameOf(code as string),
      });
    } else if (code) {
      paintSoloStanding({
        tab: 'nations',
        rankText: '-',
        percentText: null,
        score: 0,
        extraSub: `${nameOf(code)} · warming up`,
      });
    } else {
      paintSoloStanding({
        tab: 'nations',
        rankText: '-',
        percentText: null,
        score: myTrophyScore(),
        extraSub: 'Pick a country in Profile',
      });
      const host = soloStandingEl();
      if (host) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'standing-cta';
        btn.textContent = 'Set Flag';
        btn.setAttribute('aria-label', 'Pick your country in Profile');
        btn.addEventListener('click', () => { impact('light'); api.router.go('profile'); });
        host.append(btn);
      }
    }
  }

  async function loadNations(): Promise<void> {
    const el = panes.nations;
    if (!el) return;
    if (!loadedBoard.nations) el.innerHTML = skel(6);
    let rows: CountryRow[];
    try {
      rows = await getCountryRanking();
    } catch {
      el.innerHTML = empty('Rankings unavailable. Check your connection and try again.');
      paintNationsStanding(null);
      return;
    }
    if (!rows.length) {
      el.innerHTML = empty('No countries ranked yet.');
      paintNationsStanding([]);
      return;
    }
    paintPodium(rows.slice(0, 3).map((c) => ({
      rank: c.rank,
      name: c.name,
      score: c.points.toLocaleString('en-US'),
      flag: flagOf(c.code),
      code: c.code,
    })));
    el.textContent = '';
    const ol = document.createElement('ol');
    ol.className = 'rank-list';
    for (const c of rows.slice(3)) {
      ol.append(row(c.rank, flagOf(c.code), c.code, c.name, null, c.points.toLocaleString('en-US'), c.trend, profile.country === c.code));
    }
    el.append(ol);
    boardStats.nations = { loaded: true, rows: rows.length, points: rows.reduce((n, c) => n + c.points, 0) };
    paintNationsStanding(rows);
    paintRanksStats();
  }

  async function loadMinds(): Promise<void> {
    const el = panes.minds;
    if (!el) return;
    if (!loadedBoard.minds) el.innerHTML = skel(6);
    let rows: PlayerRow[];
    try {
      rows = await getPlayerRanking();
    } catch {
      el.innerHTML = empty('Rankings unavailable. Check your connection and try again.');
      paintMindsStanding();
      return;
    }
    if (!rows.length) {
      el.innerHTML = empty('No players ranked yet.');
      paintMindsStanding();
      return;
    }
    paintPodium(rows.slice(0, 3).map((p, i) => ({
      rank: i + 1,
      name: p.name,
      score: p.points.toLocaleString('en-US'),
      flag: flagOf(p.countryCode),
      code: p.countryCode,
    })));
    el.textContent = '';
    const ol = document.createElement('ol');
    ol.className = 'rank-list';
    rows.slice(3).forEach((p, i) => {
      ol.append(row(i + 4, flagOf(p.countryCode), p.countryCode, p.name, `${p.wins} wins`, p.points.toLocaleString('en-US'), p.trend, false));
    });
    el.append(ol);
    boardStats.minds = { loaded: true, rows: rows.length, points: rows.reduce((n, p) => n + p.points, 0) };
    paintMindsStanding();
    paintRanksStats();
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
        if (bindSquadById(s.id) === 'bad-handle') {
          notify('warning');
          return;
        }
        notify('success');
        impact('medium');
        loadSquads();
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

  function squadRow(s: RankedSquad, mine: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `squad-row lb-row${mine ? ' is-you' : ''}`;
    li.tabIndex = 0;
    li.dataset.id = s.id;
    const label = s.name || s.handle.replace(/^@/, '');
    li.title = `${label} · ${s.handle}`;
    li.setAttribute('aria-label', `${label}, ${s.handle}, rank ${s.rank}, ${s.trophies.toLocaleString('en-US')} Tactical IQ. Press Enter for squad details.`);
    if (mine) li.setAttribute('aria-current', 'true');

    /* Identity column: square avatar, then the name — which owns the flexible width. */
    const id = document.createElement('span');
    id.className = 'lb-id';
    const av = document.createElement('span');
    av.className = 'lb-av';
    av.textContent = squadLetter(s);
    av.setAttribute('aria-hidden', 'true');
    const txt = document.createElement('span');
    txt.className = 'lb-txt';
    const nm = document.createElement('span');
    nm.className = 'lb-name';
    nm.textContent = label;
    nm.title = label;
    const sub = document.createElement('span');
    sub.className = 'lb-sub';
    const k = squadKind(s);
    sub.append(svgIcon(k === 'channel' ? '#i-send' : '#i-users', 'lb-kind'));
    const subT = document.createElement('span');
    subT.className = 'lb-sub-t';
    subT.textContent = s.handle;
    subT.title = `${k === 'channel' ? 'Telegram channel' : 'Telegram group'} · ${compactCount(s.members)} members`;
    sub.append(subT);
    txt.append(nm, sub);
    id.append(av, txt);

    /* Action column: one pill pinned to the right edge — glass cyan to join, solid to invite. */
    const act = document.createElement('span');
    act.className = 'lb-act';
    act.append(squadKey(squadAction(s, mine), 'lb-btn'));

    li.append(
      rankCrest(s.rank),
      id,
      scoreCell(s.trophies.toLocaleString('en-US'), `${s.trophies.toLocaleString('en-US')} squad Tactical IQ`),
      act,
    );

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
    return li;
  }

  function paintSquadDock(): void {
    const dock = squadDock();
    if (!dock) return;
    // Squad dock is exclusive to the Intellect Guilds board — never on an IQ board.
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
      t.textContent = 'Join a guild to earn Tactical IQ';
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
      dock.setAttribute('aria-label', 'My Squad Standing: no squad bound. Find a guild to start earning Tactical IQ.');
      return;
    }

    const mine = getMyContribution();

    const av = document.createElement('span');
    av.className = 'dock-av';
    av.textContent = squadLetter(me);
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
    const sub = document.createElement('small');
    sub.textContent = mine > 0 ? `+${mine.toLocaleString('en-US')} yours` : 'fight to contribute';
    score.append(num, sub);
    score.title = `${me.trophies.toLocaleString('en-US')} squad Tactical IQ`;

    const invite = document.createElement('button');
    invite.type = 'button';
    invite.className = 'dock-btn is-primary';
    invite.textContent = 'Invite';
    invite.setAttribute('aria-label', `Invite to ${me.handle}: copy squad invite`);
    invite.addEventListener('click', (e) => {
      e.stopPropagation();
      inviteSquad(me);
    });

    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'dock-btn';
    view.textContent = 'View';
    view.setAttribute('aria-label', `View ${me.handle} squad details`);
    view.addEventListener('click', (e) => {
      e.stopPropagation();
      impact('light');
      openSquadSheet();
    });

    const actions = document.createElement('span');
    actions.className = 'dock-actions';
    actions.append(invite, view);

    dock.append(av, txt, score, actions);
    dock.setAttribute('aria-label', `My Squad Standing: ${me.handle}, rank ${me.rank}, ${me.trophies.toLocaleString('en-US')} Tactical IQ.`);
  }

  function loadSquads(): void {
    const el = panes.guilds;
    if (!el) return;
    if (!loadedBoard.guilds) el.innerHTML = skel(5);
    const rows = getSquadRanking();
    if (!rows.length) {
      el.innerHTML = empty('No squads ranked yet.');
      paintPodium([]);
      paintSquadDock();
      paintRanksStats();
      return;
    }
    const me = getMySquad();
    paintPodium(rows.slice(0, 3).map((s) => ({
      rank: s.rank,
      name: s.name || s.handle.replace(/^@/, ''),
      score: s.trophies.toLocaleString('en-US'),
      letter: squadLetter(s),
      action: squadKey(squadAction(s, me?.id === s.id), 'pod-btn'),
      onTap: () => {
        impact('light');
        openSquadSheet();
      },
    })));
    el.textContent = '';
    const ol = document.createElement('ol');
    ol.className = 'squad-list';
    for (const s of rows.slice(3)) {
      ol.append(squadRow(s, me?.id === s.id));
    }
    el.append(ol);
    paintSquadDock();
    paintRanksStats();
    loadedBoard.guilds = true;
  }

  onChange(() => {
    loadedBoard.nations = false;
    loadedBoard.minds = false;
    loadedBoard.guilds = false;
    loadedArena = false;
    if (isRanksVisible()) {
      paintRanks();
      void loadBoard(board);
    } else if (isArenaVisible()) {
      paintArena();
      void loadTournaments();
    }
  });

  onSquadChange(() => {
    loadedBoard.guilds = false;
    paintRanksStats();
    if (isRanksVisible() && board === 'guilds') {
      loadSquads();
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
        startTick();
        void loadBoard(board);
      }
    },
  };
}
