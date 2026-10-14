/**
 * admin.ts — the Admin Command Center: a sculpted clay key on Home that opens a full-viewport
 * Dark Clay stage for running the game live.
 *
 * Two halves, on purpose.
 *
 * **The runtime config** (`runtime`, below) is the one live source every other module reads:
 * whether the shop is selling, whether a race carries the rolling log, the blitz allowance, the
 * TIQ win reward, the coin payout multiplier and the two queue radii. It persists to the device
 * through the same wrapped door as the save, and `setRuntime` is the only writer — so a toggle
 * takes effect everywhere the instant it flips, with no reload and no second source of truth.
 *
 * **The controller** (`createAdmin`) wires the FAB, the overlay, its four tabs and every control
 * to that config. It owns no game state of its own.
 *
 * **The server** is the third half. The Worker (`worker/index.ts`, `worker/matchmaker.ts`) owns the
 * same three knobs for the live room — the maintenance lock and both queue radii — and enforces
 * them itself. The Server tab reads `GET /admin/status` for the queue and the rooms, and every
 * change to those three fields is pushed to `POST /admin/config` the moment it happens. With no
 * Worker answering, every call is a no-op, the pill reads Local, and the panel still governs the
 * device — nothing here ever depends on a backend being up.
 *
 * Who may open it: a Telegram user id on the allowlist (`ADMIN_IDS`, extended by `VITE_ADMIN_IDS`)
 * — or the dev door, which opens for any browser outside Telegram or on a loopback host, so the
 * panel is testable without a device. The Worker checks the same allowlist (`ADMIN_IDS` in
 * wrangler.toml) on every `/admin/*` call, so the panel's door is never the server's door.
 */
import { motionReduced } from './settings';
import { earnCoins, earnTiq, onChange, profile, readJson, writeJson } from './storage';
import { coinText, mountCoins, setBalance } from './coin';
import { impact, notify, tgInitData, tgUser } from './telegram';
import type { MindTier } from './matchmaking';

/* ---------- who may open it ---------- */

/** The built-in allowlist. Add Telegram user ids here, or to `VITE_ADMIN_IDS`. */
export const ADMIN_IDS: readonly string[] = ['1', '1000001'];

const envIds = (import.meta.env.VITE_ADMIN_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOW = new Set<string>([...ADMIN_IDS, ...envIds]);

/** Where the viewer came in through — the header badge and the FAB dot both read it. */
export type Door = 'tg' | 'dev';

/** A plain browser, or a loopback host: the door that makes the panel testable locally. */
export function isDevDoor(): boolean {
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return true;
  return tgUser()?.id === undefined;
}

export function doorOf(): Door {
  const id = tgUser()?.id;
  return id !== undefined && ALLOW.has(String(id)) ? 'tg' : 'dev';
}

export function isAdmin(): boolean {
  return doorOf() === 'tg' || isDevDoor();
}

/* ---------- the live runtime config ---------- */

export interface AdminRuntime {
  /** Shop sales: off parks every card in the inert "Not for sale" showcase state. */
  salesOpen: boolean;
  /** The rolling log on upcoming boards. */
  hazards: boolean;
  /** Blocks new match queues with a maintenance toast. */
  maintenance: boolean;
  /** The live announcement pinned to the top of Home. '' means none. */
  broadcast: string;
  /** TIQ a win is worth, race credit included. */
  winTiq: number;
  /** 1.0x / 1.5x / 2.0x — the coin payout scale. */
  coinMult: number;
  /** Seconds a seat gets before the blitz auto-move. */
  blitz: number;
  /** The ordinary queue radius, in TIQ. */
  radiusNormal: number;
  /** The widened radius, once a seat asks for more. */
  radiusWide: number;
  /** Force the ladder's aura for a preview, or null to read it off the TIQ. */
  tierOverride: MindTier | null;
}

/** The coin multiplier a Double-Coins event steps through. */
export const COIN_STEPS: readonly number[] = [1, 1.5, 2];
/** The blitz allowances the stepper offers. */
export const BLITZ_STEPS: readonly number[] = [10, 15, 20];

export const DEFAULT_RUNTIME: AdminRuntime = {
  salesOpen: false,
  hazards: true,
  maintenance: false,
  broadcast: '',
  winTiq: 140,
  coinMult: 1,
  blitz: 15,
  radiusNormal: 250,
  radiusWide: 600,
  tierOverride: null,
};

const RUNTIME_KEY = 'detour.admin.v1';

/** The four mind tiers, in ladder order, and what the panel calls them. */
const TIERS: readonly MindTier[] = ['rookie', 'tactician', 'strategist', 'grandmaster'];
const TIER_LABEL: Record<MindTier, string> = {
  rookie: 'Rookie',
  tactician: 'Tactician',
  strategist: 'Strategist',
  grandmaster: 'Grandmaster',
};

/** Every finished race lands this much TIQ; a win adds the rest of `winTiq` on top of it. */
export const RACE_TIQ = 20;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pickNum = (v: unknown, fallback: number, lo: number, hi: number): number =>
  isNum(v) ? clamp(v, lo, hi) : fallback;
const pickBool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const pickOne = (list: readonly number[], v: unknown, fallback: number): number =>
  isNum(v) && list.includes(v) ? v : fallback;

/** A hand-edited or half-written blob is folded field by field, never trusted as it stands. */
function loadRuntime(): AdminRuntime {
  const raw = readJson<AdminRuntime>(RUNTIME_KEY);
  const d = DEFAULT_RUNTIME;
  if (!raw) return { ...d };
  return {
    salesOpen: pickBool(raw.salesOpen, d.salesOpen),
    hazards: pickBool(raw.hazards, d.hazards),
    maintenance: pickBool(raw.maintenance, d.maintenance),
    broadcast: typeof raw.broadcast === 'string' ? raw.broadcast.slice(0, 140) : d.broadcast,
    winTiq: Math.round(pickNum(raw.winTiq, d.winTiq, 0, 1000)),
    coinMult: pickOne(COIN_STEPS, raw.coinMult, d.coinMult),
    blitz: pickOne(BLITZ_STEPS, raw.blitz, d.blitz),
    radiusNormal: Math.round(pickNum(raw.radiusNormal, d.radiusNormal, 50, 2000)),
    radiusWide: Math.round(pickNum(raw.radiusWide, d.radiusWide, 100, 4000)),
    tierOverride: TIERS.includes(raw.tierOverride as MindTier) ? (raw.tierOverride as MindTier) : null,
  };
}

/** The live config every module reads. Mutated only through `setRuntime`. */
export const runtime: AdminRuntime = loadRuntime();

const watchers: (() => void)[] = [];

/** Fires after every accepted change, so the app can repaint what the change touched. */
export function onRuntime(w: () => void): () => void {
  watchers.push(w);
  return () => {
    const i = watchers.indexOf(w);
    if (i >= 0) watchers.splice(i, 1);
  };
}

/** The one writer: patch, persist, then tell everyone. */
export function setRuntime(patch: Partial<AdminRuntime>): void {
  Object.assign(runtime, patch);
  writeJson(RUNTIME_KEY, runtime);
  for (const w of [...watchers]) {
    try {
      w();
    } catch {
      /* a watcher threw: the rest still get their turn */
    }
  }
}

/** Back to the shipped numbers, keeping whatever is not in the default set. */
export function resetRuntime(): void {
  setRuntime({ ...DEFAULT_RUNTIME });
}

/**
 * What the Economy & Rules tab's "Reset to Defaults" restores: the tunables that tab owns, and
 * nothing else — the switches and the pinned broadcast are somebody else's decision.
 */
const ECONOMY_DEFAULTS: Partial<AdminRuntime> = {
  winTiq: DEFAULT_RUNTIME.winTiq,
  coinMult: DEFAULT_RUNTIME.coinMult,
  blitz: DEFAULT_RUNTIME.blitz,
  radiusNormal: DEFAULT_RUNTIME.radiusNormal,
  radiusWide: DEFAULT_RUNTIME.radiusWide,
};

/**
 * The ladder's own reading, so the admin's win reward and the matchmaker's TIQ agree by
 * construction. The win reward folds the race credit in, which is why the 140 default still
 * lands exactly the old 120-per-win + 20-per-race.
 */
export function tiqFrom(wins: number, games: number, bonus: number): number {
  return Math.max(0, wins * Math.max(0, runtime.winTiq - RACE_TIQ) + games * RACE_TIQ + bonus);
}

/* ---------- the live server: the Worker is the other half of this panel ---------- */

/**
 * The three knobs `MatchmakerDO` enforces itself. They are the server's copy of the local runtime:
 * the panel pushes them, the room applies them to the next pairing pass, and `/admin/status` reads
 * them back so a second admin can see what is actually in force.
 */
export interface ServerConfig {
  maintenance: boolean;
  normalRadius: number;
  wideRadius: number;
}

/** One seat in the room's queue, as `/admin/status` reports it. */
export interface QueuedPlayer {
  id: string;
  name: string;
  tiq: number;
  wide: boolean;
  waitedMs: number;
}

/** One live 1v1, as `/admin/status` reports it. */
export interface ActiveRoom {
  matchId: string;
  p0: string;
  p1: string;
  turn: number;
  round: number;
}

export interface ServerStatus {
  ok: true;
  queueCount: number;
  activeMatchesCount: number;
  queuedPlayers: QueuedPlayer[];
  activeRooms: ActiveRoom[];
  config: ServerConfig;
}

/** The Worker base: `VITE_WS_URL` when the app was pointed at one, else this page's own origin. */
function workerBase(): string {
  const ws = import.meta.env.VITE_WS_URL?.trim();
  if (ws) {
    const base = ws.startsWith('http') ? ws : `https://${ws}`;
    return base.replace(/^ws/, 'http').replace(/\/+$/, '');
  }
  return location.host ? location.origin : '';
}

/** A Worker route, or `''` when there is no origin to hang one off. */
function workerUrl(path: string): string {
  const base = workerBase();
  return base ? `${base}${path}` : '';
}

/**
 * What every admin call carries: the Mini App's own `initData` when Telegram handed one over, plus
 * the explicit developer marker. The Worker ignores the marker unless it is on a dev host and a
 * valid signature always wins over it, so sending both is safe and keeps local work possible.
 */
function adminHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', 'x-admin': '1' };
  const init = tgInitData();
  if (init) headers['x-telegram-init-data'] = init;
  return headers;
}

/** One admin call on a short leash: a Worker that is not there must never hold the panel up. */
async function adminFetch(path: string, init: RequestInit = {}): Promise<Response | null> {
  const url = workerUrl(path);
  if (!url) return null;
  const extra = (init.headers ?? {}) as Record<string, string>;
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), 2500);
  try {
    return await fetch(url, { ...init, signal: ac.signal, headers: { ...adminHeaders(), ...extra } });
  } catch {
    return null;                              // offline, refused, or too slow: the same answer
  } finally {
    window.clearTimeout(timer);
  }
}

/** The room's own reading of itself, or null when nothing answers. */
async function fetchStatus(): Promise<ServerStatus | null> {
  const res = await adminFetch('/admin/status');
  if (!res || !res.ok) return null;
  try {
    const data = (await res.json()) as ServerStatus;
    return data && data.ok === true ? data : null;
  } catch {
    return null;
  }
}

/** Push a config patch to the live server. False when it could not be delivered. */
async function pushConfig(patch: ServerConfig): Promise<boolean> {
  const res = await adminFetch('/admin/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return !!res && res.ok;
}

/** One moderation action. False when the server refused it or never answered. */
async function serverAction(
  body: { action: 'CLEAR_QUEUE' } | { action: 'ABORT_MATCH'; matchId: string },
): Promise<boolean> {
  const res = await adminFetch('/admin/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return !!res && res.ok;
}

/* ---------- the controller ---------- */

export interface AdminApi {
  /** The board's own toast (`showNote` in main.ts): the panel speaks in the game's voice. */
  note(msg: string, error: boolean, ttl: number): void;
  /** The tier the ladder currently reads — the preview swatch falls back to it. */
  tier(): MindTier;
  /** The stage opened or closed: the shell shows the Telegram BackButton while it is up. */
  onToggle(open: boolean): void;
}

export interface Admin {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  /** Show the FAB for this viewer, paint every control and anchor the key above the dock. */
  mount(): void;
  /** The route moved: re-anchor the FAB (the launcher only has a height while Home is up). */
  relayout(): void;
}

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

/** One stepper: read the live value, compute the next, write it back, label it. */
interface Knob {
  get(): number;
  next(dir: number): number;
  apply(v: number): void;
  label(v: number): string;
}

const cycle = (list: readonly number[], cur: number, dir: number): number => {
  const i = list.indexOf(cur);
  return list[((i < 0 ? 0 : i) + dir + list.length) % list.length];
};

const KNOBS: Record<string, Knob> = {
  tiq: {
    get: () => runtime.winTiq,
    next: (d) => clamp(runtime.winTiq + d * 10, 0, 1000),
    apply: (v) => setRuntime({ winTiq: v }),
    label: (v) => String(v),
  },
  coin: {
    get: () => runtime.coinMult,
    next: (d) => cycle(COIN_STEPS, runtime.coinMult, d),
    apply: (v) => setRuntime({ coinMult: v }),
    label: (v) => `${v.toFixed(1)}x`,
  },
  blitz: {
    get: () => runtime.blitz,
    next: (d) => cycle(BLITZ_STEPS, runtime.blitz, d),
    apply: (v) => setRuntime({ blitz: v }),
    label: (v) => `${v}s`,
  },
  'radius-normal': {
    get: () => runtime.radiusNormal,
    next: (d) => clamp(runtime.radiusNormal + d * 50, 50, 2000),
    apply: (v) => setRuntime({ radiusNormal: v }),
    label: (v) => `±${v}`,
  },
  'radius-wide': {
    get: () => runtime.radiusWide,
    next: (d) => clamp(runtime.radiusWide + d * 50, 100, 4000),
    apply: (v) => setRuntime({ radiusWide: v }),
    label: (v) => `±${v}`,
  },
};

const TOGGLES = ['salesOpen', 'hazards', 'maintenance'] as const;
type ToggleKey = (typeof TOGGLES)[number];

export function createAdmin(api: AdminApi): Admin {
  const fab = $<HTMLButtonElement>('btn-admin-fab');
  const dot = $<HTMLElement>('admin-fab-dot');
  const stage = $<HTMLElement>('overlay-admin');
  const home = $<HTMLElement>('s-home');
  const badge = $<HTMLElement>('admin-badge');
  const closeBtn = $<HTMLButtonElement>('admin-close');
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-atab]')];
  const panels = [...document.querySelectorAll<HTMLElement>('[data-apanel]')];
  const sws = [...document.querySelectorAll<HTMLButtonElement>('[data-tog]')];
  const stepBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-step] [data-dir]')];
  const stepRows = [...document.querySelectorAll<HTMLElement>('[data-step]')];
  const bcInput = $<HTMLInputElement>('bc-input');
  const bcLive = $<HTMLElement>('bc-live');
  const banner = $<HTMLElement>('home-broadcast');
  const bannerText = $<HTMLElement>('home-broadcast-text');
  const tierRing = $<HTMLElement>('tool-tier-ring');
  const tierLabel = $<HTMLElement>('tool-tier-label');
  const coinsNow = $<HTMLElement>('tool-coins-now');
  const tiqNow = $<HTMLElement>('tool-tiq-now');
  const resetBtn = $<HTMLButtonElement>('tool-reset');
  const serverCard = $<HTMLElement>('adm-server');
  const serverChip = $<HTMLElement>('adm-server-chip');
  const serverQueue = $<HTMLElement>('srv-queue');
  const serverRooms = $<HTMLElement>('srv-rooms');
  const serverList = $<HTMLElement>('srv-list');
  const serverRefresh = $<HTMLButtonElement>('srv-refresh');
  const serverClear = $<HTMLButtonElement>('srv-clear');

  let open = false;
  let hideId = 0;
  let resetId = 0;
  let live = false;
  /** True once `/admin/status` has answered: the panel is governing a real room. */
  let serverOn = false;
  /** What the Worker was last told, so an unchanged toggle never sends a pointless call. */
  let lastPushed: ServerConfig | null = null;

  /* ---------- painting ---------- */

  const setKpi = (id: string, text: string, on: boolean) => {
    const kpi = $(id);
    if (!kpi) return;
    kpi.dataset.state = on ? 'on' : 'off';
    const b = kpi.querySelector('b');
    if (b) b.textContent = text;
  };

  function paintToggles() {
    for (const el of sws) {
      const key = el.dataset.tog as ToggleKey;
      if (TOGGLES.includes(key)) el.setAttribute('aria-checked', String(runtime[key]));
    }
  }

  function paintKpis() {
    setKpi('kpi-shop', runtime.salesOpen ? 'Open' : 'Closed', runtime.salesOpen);
    setKpi('kpi-haz', runtime.hazards ? 'Active' : 'Off', runtime.hazards);
  }

  function paintDot() {
    if (dot) dot.dataset.state = runtime.maintenance ? 'lock' : 'live';
  }

  function paintBadge() {
    if (!badge) return;
    const verified = doorOf() === 'tg';
    badge.textContent = verified ? 'ADMIN · TG VERIFIED' : 'DEV MODE';
    badge.dataset.door = verified ? 'tg' : 'dev';
  }

  function paintSteps() {
    for (const row of stepRows) {
      const k = KNOBS[row.dataset.step ?? ''];
      if (!k) continue;
      const out = row.querySelector<HTMLElement>('[data-val]');
      if (out) out.textContent = k.label(k.get());
    }
  }

  function paintBroadcast() {
    const text = runtime.broadcast;
    if (banner) banner.hidden = !text;
    if (bannerText) bannerText.textContent = text;
    if (bcLive) {
      bcLive.textContent = text || 'No announcement pinned.';
      bcLive.dataset.on = String(!!text);
    }
  }

  function paintTier() {
    const forced = runtime.tierOverride;
    const t = forced ?? api.tier();
    if (tierRing) tierRing.dataset.tier = t;
    if (tierLabel) tierLabel.textContent = `${TIER_LABEL[t]}${forced ? ' · forced' : ' · from TIQ'}`;
  }

  function paintSave() {
    if (coinsNow) setBalance(coinsNow, profile.coins);
    if (tiqNow) tiqNow.textContent = String(tiqFrom(profile.stats.wins, profile.stats.games, profile.tiqBonus));
  }

  function paintAll() {
    paintToggles();
    paintKpis();
    paintDot();
    paintBadge();
    paintSteps();
    paintBroadcast();
    paintTier();
    paintSave();
  }

  /* ---------- the live server ---------- */

  /** The local runtime, in the three fields the Worker also enforces. */
  function serverConfig(): ServerConfig {
    return { maintenance: runtime.maintenance, normalRadius: runtime.radiusNormal, wideRadius: runtime.radiusWide };
  }

  const sameConfig = (a: ServerConfig | null, b: ServerConfig): boolean =>
    !!a && a.maintenance === b.maintenance && a.normalRadius === b.normalRadius && a.wideRadius === b.wideRadius;

  /** Nothing answered: the panel governs this device alone, and says so. */
  function markLocal() {
    serverOn = false;
    setKpi('kpi-server', 'Local', false);
    paintServer(null);
  }

  /** `12s` / `1m 20s`: a wait in the unit somebody would actually say it in. */
  function waited(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function rosterRow(name: string, meta: string, matchId?: string): HTMLLIElement {
    const li = document.createElement('li');
    li.className = matchId ? 'adm-server-row is-room' : 'adm-server-row';
    const txt = document.createElement('span');
    txt.className = 'adm-server-txt';
    const n = document.createElement('span');
    n.className = 'adm-server-n';
    n.textContent = name;
    const m = document.createElement('span');
    m.className = 'adm-server-m';
    m.textContent = meta;
    txt.append(n, m);
    li.append(txt);
    if (matchId) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'adm-btn adm-btn-danger adm-abort';
      btn.dataset.abort = matchId;
      btn.textContent = 'Abort';
      btn.setAttribute('aria-label', `Abort room ${matchId}`);
      li.append(btn);
    }
    return li;
  }

  function emptyRow(text: string): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'adm-server-empty';
    li.textContent = text;
    return li;
  }

  /** The chip, the two counters and the roster, all from one status payload (or its absence). */
  function paintServer(status: ServerStatus | null) {
    if (serverCard) serverCard.dataset.state = status ? 'live' : 'local';
    if (serverChip) serverChip.textContent = status ? 'LIVE SERVER' : 'LOCAL MODE';
    if (serverQueue) serverQueue.textContent = status ? String(status.queueCount) : '—';
    if (serverRooms) serverRooms.textContent = status ? String(status.activeMatchesCount) : '—';
    if (!serverList) return;
    serverList.textContent = '';
    if (!status) {
      serverList.append(emptyRow('No telemetry — the Worker is not answering.'));
      return;
    }
    if (!status.queuedPlayers.length && !status.activeRooms.length) {
      serverList.append(emptyRow('Nobody is waiting, and no room is running.'));
      return;
    }
    for (const p of status.queuedPlayers) {
      serverList.append(rosterRow(p.name, `TIQ ${p.tiq} · ${p.wide ? 'wide' : 'normal'} · ${waited(p.waitedMs)}`));
    }
    for (const r of status.activeRooms) {
      serverList.append(rosterRow(
        `${r.p0} vs ${r.p1}`,
        `#${r.matchId} · turn ${r.turn} · round ${r.round}`,
        r.matchId,
      ));
    }
  }

  /** Read the room, paint it, and remember whether the Worker is really there. */
  async function refreshServer(): Promise<void> {
    const status = await fetchStatus();
    serverOn = !!status;
    setKpi('kpi-server', serverOn ? 'Online' : 'Local', serverOn);
    paintServer(status);
    if (serverOn) await syncConfig();
  }

  /**
   * Keep the Worker's own enforcement in step with the local runtime. Only the three fields the
   * server also owns travel; anything else the panel changes is a device-local matter. With no
   * Worker answering there is nothing to sync, and the panel simply stays in Local mode.
   */
  async function syncConfig(): Promise<void> {
    if (!serverOn) return;
    const want = serverConfig();
    if (sameConfig(lastPushed, want)) return;
    if (await pushConfig(want)) lastPushed = want;
    else markLocal();
  }

  /** Empty the room's queue on the server, then read it back so the roster agrees. */
  async function clearQueue(): Promise<void> {
    impact('medium');
    if (!(await serverAction({ action: 'CLEAR_QUEUE' }))) {
      markLocal();
      notify('error');
      api.note('Clear Queue failed — the Worker is not answering.', true, 2400);
      return;
    }
    notify('success');
    api.note('Queue cleared on the server.', false, 2000);
    await refreshServer();
  }

  /** Pull one stuck room: both seats are told, and the room stops existing. */
  async function abortMatch(matchId: string): Promise<void> {
    if (!matchId) return;
    impact('medium');
    if (!(await serverAction({ action: 'ABORT_MATCH', matchId }))) {
      markLocal();
      notify('error');
      api.note('Abort failed — the Worker is not answering.', true, 2400);
      return;
    }
    notify('success');
    api.note(`Room ${matchId} aborted.`, false, 2000);
    await refreshServer();
  }

  /* ---------- the FAB ---------- */

  /** Clear the launcher (mode card + PLAY) so the key never sits on top of either. */
  function placeFab() {
    if (!fab || !home) return;
    const launcher = home.querySelector<HTMLElement>('.launcher');
    if (!launcher) return;
    const hr = home.getBoundingClientRect();
    const lr = launcher.getBoundingClientRect();
    if (!hr.height || !lr.height) return;
    fab.style.bottom = `${Math.max(12, Math.round(hr.bottom - lr.top + 12))}px`;
  }

  /* ---------- open / close ---------- */

  function openStage() {
    if (!stage || open) return;
    open = true;
    window.clearTimeout(hideId);
    stage.hidden = false;
    void stage.offsetWidth;               // lay the stage out at its closed position first
    stage.classList.add('open');
    document.documentElement.classList.add('admin-open');
    paintAll();
    void refreshServer();                 // the Server KPI is read off `/admin/status`, not `/health`
    closeBtn?.focus({ preventScroll: true });
    api.onToggle(true);
    impact('medium');
  }

  function closeStage() {
    if (!stage || !open) return;
    open = false;
    stage.classList.remove('open');
    document.documentElement.classList.remove('admin-open');
    impact('light');
    api.onToggle(false);
    hideId = window.setTimeout(() => {
      if (!open) stage.hidden = true;
    }, motionReduced() ? 0 : 240);
    try {
      fab?.focus({ preventScroll: true });
    } catch {
      /* gone already */
    }
  }

  function selectTab(id: string) {
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.atab === id));
    for (const p of panels) p.hidden = p.dataset.apanel !== id;
  }

  /* ---------- wiring ---------- */

  fab?.addEventListener('click', openStage);
  closeBtn?.addEventListener('click', closeStage);
  stage?.addEventListener('click', (e) => {
    // the backdrop below the stage's own column closes it, like every other full-viewport stage
    if (e.target === stage) closeStage();
  });
  for (const t of tabs) {
    t.addEventListener('click', () => {
      impact('light');
      const id = t.dataset.atab ?? 'ops';
      selectTab(id);
      if (id === 'server') void refreshServer();   // the roster is only ever as fresh as its last read
    });
  }

  serverRefresh?.addEventListener('click', () => {
    impact('light');
    void refreshServer();
  });
  serverClear?.addEventListener('click', () => { void clearQueue(); });
  /* every Abort is delegated: the roster is rebuilt on each read, so no handler outlives its row */
  serverList?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-abort]');
    if (btn) void abortMatch(btn.dataset.abort ?? '');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) closeStage();
  });

  for (const el of sws) {
    const key = el.dataset.tog as ToggleKey;
    if (!TOGGLES.includes(key)) continue;
    el.addEventListener('click', () => {
      impact('light');
      setRuntime({ [key]: !runtime[key] } as Partial<AdminRuntime>);
      paintToggles();
      paintKpis();
      paintDot();
      const label = key === 'salesOpen' ? 'Shop sales' : key === 'hazards' ? 'Board hazards' : 'Maintenance lock';
      api.note(`${label}: ${runtime[key] ? 'on' : 'off'}`, false, 1800);
      notify(runtime[key] ? 'success' : 'warning');
    });
  }

  for (const btn of stepBtns) {
    btn.addEventListener('click', () => {
      const row = btn.closest<HTMLElement>('[data-step]');
      const k = row ? KNOBS[row.dataset.step ?? ''] : undefined;
      if (!k) return;
      const dir = btn.dataset.dir === '-1' ? -1 : 1;
      k.apply(k.next(dir));
      paintSteps();
      paintKpis();
      impact('light');
    });
  }

  $<HTMLButtonElement>('econ-reset')?.addEventListener('click', () => {
    setRuntime(ECONOMY_DEFAULTS);
    paintAll();
    impact('medium');
    notify('success');
    api.note('Economy reset to defaults.', false, 2000);
  });

  $<HTMLButtonElement>('bc-publish')?.addEventListener('click', () => {
    const text = (bcInput?.value ?? '').trim().slice(0, 140);
    if (!text) {
      api.note('Type a message before publishing.', true, 2200);
      notify('error');
      return;
    }
    setRuntime({ broadcast: text });
    paintBroadcast();
    impact('medium');
    notify('success');
    api.note('Broadcast pinned to Home.', false, 2000);
  });

  $<HTMLButtonElement>('bc-clear')?.addEventListener('click', () => {
    setRuntime({ broadcast: '' });
    if (bcInput) bcInput.value = '';
    paintBroadcast();
    impact('light');
    api.note('Broadcast cleared.', false, 1800);
  });

  $<HTMLButtonElement>('tool-coins')?.addEventListener('click', () => {
    const got = earnCoins(500);
    paintSave();
    impact('medium');
    notify('success');
    api.note(`+${coinText(got)} coins granted.`, false, 2200);
  });

  $<HTMLButtonElement>('tool-tiq')?.addEventListener('click', () => {
    const got = earnTiq(200);
    paintSave();
    paintTier();
    impact('medium');
    notify('success');
    api.note(`+${got} TIQ granted.`, false, 2200);
  });

  $<HTMLButtonElement>('tool-tier')?.addEventListener('click', () => {
    const cur = runtime.tierOverride;
    const next = TIERS[((cur ? TIERS.indexOf(cur) : -1) + 1) % TIERS.length];
    setRuntime({ tierOverride: next });
    paintTier();
    impact('light');
    api.note(`Mind tier preview: ${TIER_LABEL[next]}.`, false, 2000);
  });

  resetBtn?.addEventListener('click', () => {
    if (resetId) {
      // second tap inside the window: the device-local save goes, the reload hands back defaults
      window.clearTimeout(resetId);
      resetId = 0;
      try {
        const doomed: string[] = [];
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith('detour.')) doomed.push(k);
        }
        for (const k of doomed) window.localStorage.removeItem(k);
      } catch {
        /* storage refused — the reload still gives defaults */
      }
      notify('success');
      api.note('Local save cleared — reloading.', false, 1200);
      window.setTimeout(() => window.location.reload(), 700);
      return;
    }
    resetBtn.classList.add('armed');
    resetBtn.textContent = 'Tap again to confirm';
    impact('light');
    api.note('Reset Local Save: tap once more to confirm.', true, 2600);
    resetId = window.setTimeout(() => {
      resetId = 0;
      resetBtn.classList.remove('armed');
      resetBtn.textContent = 'Reset Local Save';
    }, 3200);
  });

  // a balance or TIQ moved anywhere else in the app keeps the panel's readouts honest
  onChange(() => {
    if (open) paintSave();
  });
  onRuntime(() => {
    paintBroadcast();
    paintDot();
    /* Maintenance Lock and both radii are the server's too: the same flip that repaints the panel
       pushes the new values to `POST /admin/config`. Offline, `syncConfig` is a no-op. */
    void syncConfig();
  });

  const onResize = () => {
    if (live) placeFab();
  };
  window.addEventListener('resize', onResize);
  if (home) {
    const ro = new ResizeObserver(onResize);
    ro.observe(home);
    const launcher = home.querySelector<HTMLElement>('.launcher');
    if (launcher) ro.observe(launcher);
  }
  document.addEventListener('visibilitychange', onResize);

  return {
    open: openStage,
    close: closeStage,
    get isOpen() {
      return open;
    },
    mount() {
      if (fab) fab.hidden = !isAdmin();
      if (stage) mountCoins(stage);
      paintAll();
      // the launcher only has a height once the home screen has been laid out
      requestAnimationFrame(() => {
        live = true;
        placeFab();
      });
    },
    relayout() {
      if (live) placeFab();
    },
  };
}
