/**
 * notifications.ts — In-Game Notification Center (Inbox & Alerts).
 *
 * Local-first store + tactile sheet controller. One module owns the schema and
 * the only door to the device: `detour.notifications.v1`, scoped per Telegram account
 * (`..._u_<id>`). A refused store still yields a working inbox (in-memory only), mirroring
 * storage.ts / squads.ts so the race never depends on persistence.
 *
 * Store API (spec): `getNotifications()`, `markAsRead(id)`,
 * `markAllAsRead()`, `deleteNotification(id)`, `clearAll()`,
 * `hasUnread()` — plus `getUnreadCount()`,
 * `addNotification()` for future squad/tournament hooks, and
 * `onNotifications()` so the header bell repaints on every change.
 *
 * UI: `createNotifications({ sheets })` binds the header bell (#home-notifs),
 * the badge (#notif-badge) and the bottom sheet (#sheet-notifications).
 * Rendering uses textContent only (no innerHTML for user-adjacent strings)
 * and transform/opacity-only motion, per the Dark Clay contract.
 */
import { adoptUserStorageKey, earnCoins } from './storage';
import { impact, notify } from './telegram';
import { lang, langDef, motionReduced, onLang, settings, t } from './settings';
import { audioContext } from './sound';
import { badgeById, badgeCrestHtml } from './badges';
import {
  acceptRelicChallenge, declineRelicChallenge,
  type RelicChallenge, type RelicMailboxItem,
} from './network';
import { showToast } from './toast';
import type { Sheets } from './sheets';

export type NotificationKind = 'squad' | 'tournament' | 'reward' | 'announcement';

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  createdAt: number;
  read: boolean;
  /** reward coins awaiting claim (reward kind only) */
  coins?: number;
  /** reward already claimed — the [Claim] key goes quiet */
  claimed?: boolean;
}

export type NewNotification = Omit<AppNotification, 'id' | 'createdAt' | 'read'> &
  Partial<Pick<AppNotification, 'id' | 'createdAt' | 'read'>>;

const KEY = adoptUserStorageKey('detour.notifications.v1');
const V = 1;
const MAX_ITEMS = 30;

interface NotifSave {
  v: number;
  items: AppNotification[];
}

const KINDS: readonly NotificationKind[] = ['squad', 'tournament', 'reward', 'announcement'];

const isKind = (v: unknown): v is NotificationKind =>
  typeof v === 'string' && (KINDS as readonly string[]).includes(v);

const isNotif = (v: unknown): v is AppNotification => {
  const x = v as Partial<AppNotification> | undefined;
  if (!x || typeof x.id !== 'string' || !x.id) return false;
  if (!isKind(x.kind)) return false;
  if (typeof x.title !== 'string' || !x.title) return false;
  if (typeof x.body !== 'string') return false;
  if (typeof x.createdAt !== 'number' || !Number.isFinite(x.createdAt)) return false;
  if (typeof x.read !== 'boolean') return false;
  if (x.coins !== undefined && (typeof x.coins !== 'number' || !Number.isFinite(x.coins))) return false;
  if (x.claimed !== undefined && typeof x.claimed !== 'boolean') return false;
  return true;
};

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function writeRaw(value: string): void {
  try {
    window.localStorage.setItem(KEY, value);
  } catch {
    /* stay in memory */
  }
}

function seed(): AppNotification[] {
  const now = Date.now();
  const min = 60_000;
  /* No squad row here on purpose: a squad notification is only ever real news, so it is written
     by the squad layer when something actually happens — never pre-seeded for a squad that the
     player has not joined. */
  return [
    {
      id: 'seed-arena-cup',
      kind: 'tournament',
      title: 'Arena bracket opening soon',
      body: '200 Stars Arena opens its brackets in 10 minutes — take your seat.',
      createdAt: now - 26 * min,
      read: false,
    },
    {
      id: 'seed-daily-streak',
      kind: 'reward',
      title: 'Daily streak reward',
      body: 'Daily streak reward ready to claim (+150 Coins)',
      createdAt: now - 52 * min,
      read: false,
      coins: 150,
      claimed: false,
    },
  ];
}

function load(): AppNotification[] {
  let raw: string | null = null;
  try {
    raw = readRaw();
  } catch {
    raw = null;
  }
  // First run (no key at all): seed the three showcase cards from the spec.
  if (raw === null) {
    const items = seed();
    persist(items);
    return items;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<NotifSave> | AppNotification[] | null;
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Partial<NotifSave> | null)?.items)
        ? (parsed as NotifSave).items
        : [];
    const clean = list.filter(isNotif).slice(0, MAX_ITEMS);
    // Newest first, so the bell and the sheet never disagree on order.
    clean.sort((a, b) => b.createdAt - a.createdAt);
    return clean;
  } catch {
    return [];
  }
}

function persist(items: AppNotification[]): void {
  try {
    writeRaw(JSON.stringify({ v: V, items } satisfies NotifSave));
  } catch {
    /* stay in memory */
  }
}

let items: AppNotification[] = load();

type Watcher = () => void;
const watchers: Watcher[] = [];

function emit(): void {
  persist(items);
  for (const w of [...watchers]) {
    try {
      w();
    } catch {
      /* a watcher must never break the store */
    }
  }
}

/** All notifications, newest first. Returns copies — mutate via the helpers. */
export function getNotifications(): AppNotification[] {
  return [...items]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((n) => ({ ...n }));
}

export function getUnreadCount(): number {
  let n = 0;
  for (const item of items) if (!item.read) n++;
  return n;
}

export function hasUnread(): boolean {
  return items.some((n) => !n.read);
}

export function markAsRead(id: string): void {
  const hit = items.find((n) => n.id === id);
  if (!hit || hit.read) return;
  hit.read = true;
  emit();
}

export function markAllAsRead(): void {
  if (!items.some((n) => !n.read)) return;
  for (const n of items) n.read = true;
  emit();
}

/** Removes one row for good. Returns whether something was actually deleted. */
export function deleteNotification(id: string): boolean {
  const i = items.findIndex((n) => n.id === id);
  if (i < 0) return false;
  items.splice(i, 1);
  emit();
  return true;
}

/** Empties the drawer — the [Clear All] key's move. Returns how many rows went. */
export function clearAll(): number {
  const gone = items.length;
  if (gone === 0) return 0;
  items = [];
  emit();
  return gone;
}

/**
 * The squad / tournament / reward / broadcast hook. A caller-supplied `id` is a dedupe key:
 * a row that already carries it is returned as-is, so an announcement that syncs twice leaves
 * one card, not two.
 */
export function addNotification(input: NewNotification): AppNotification {
  const now = Date.now();
  if (input.id) {
    const hit = items.find((n) => n.id === input.id);
    if (hit) return { ...hit };
  }
  const row: AppNotification = {
    id: input.id ?? `n-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    kind: input.kind,
    title: input.title.slice(0, 80),
    body: input.body.slice(0, 220),
    createdAt:
      typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
        ? input.createdAt
        : now,
    read: input.read ?? false,
    ...(typeof input.coins === 'number' && Number.isFinite(input.coins)
      ? { coins: Math.max(0, Math.floor(input.coins)) }
      : {}),
    ...(typeof input.claimed === 'boolean' ? { claimed: input.claimed } : {}),
  };
  items = [row, ...items].slice(0, MAX_ITEMS);
  emit();
  return { ...row };
}

/**
 * Settles a reward row's [Claim] key. Returns the coins awarded, or 0 when
 * there was nothing to claim (unknown id, not a reward, already claimed).
 * The wallet move itself stays here so callers cannot forget persistence.
 */
export function claimReward(id: string): number {
  const hit = items.find((n) => n.id === id);
  if (!hit || hit.kind !== 'reward' || hit.claimed) return 0;
  const coins =
    typeof hit.coins === 'number' && Number.isFinite(hit.coins) && hit.coins > 0
      ? Math.floor(hit.coins)
      : 0;
  if (coins <= 0) return 0;
  hit.claimed = true;
  hit.read = true;
  earnCoins(coins);
  emit();
  return coins;
}

/** Repaint hook for the bell + sheet. Returns an unsubscribe function. */
export function onNotifications(w: Watcher): () => void {
  watchers.push(w);
  return () => {
    const i = watchers.indexOf(w);
    if (i >= 0) watchers.splice(i, 1);
  };
}

/** "just now" · "5m ago" · "3h ago" · "2d ago" — slate timestamp under each card. */
export function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/* ------------------------------------------------------------------ */
/* Sheet controller                                                    */
/* ------------------------------------------------------------------ */

export interface NotificationsDeps {
  sheets: Sheets;
}

const KIND_ICON: Record<NotificationKind, string> = {
  squad: '#i-cup',
  tournament: '#i-flag',
  reward: '#i-gift',
  announcement: '#i-bell',
};

const KIND_LABEL: Record<NotificationKind, string> = {
  squad: 'Squad',
  tournament: 'Tournament',
  reward: 'Reward',
  announcement: 'Announcement',
};

/**
 * The reward chime: the same rising E5→B5 pair the matchmaking lock uses, fed
 * through the shared engine (`sound.ts`). Respects Sound; silent without WebAudio.
 */
const CLAIM_NOTES: ReadonlyArray<readonly [number, number]> = [[659.25, 0], [987.77, 0.09]];

function chime(): void {
  if (!settings.sound) return;
  try {
    const ctx = audioContext();
    if (!ctx) return;
    if (ctx.state !== 'running') void ctx.resume().catch(() => { /* still locked */ });
    const t0 = ctx.currentTime;
    for (const [freq, at] of CLAIM_NOTES) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const t = t0 + at;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.13, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    }
  } catch {
    /* no audio in this webview */
  }
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function createNotifications(deps: NotificationsDeps): { refresh(): void } {
  const bell = el<HTMLButtonElement>('home-notifs');
  const badge = el<HTMLElement>('notif-badge');
  const sheet = el<HTMLElement>('sheet-notifications');
  const list = el<HTMLElement>('notif-list');
  const empty = el<HTMLElement>('notif-empty');
  const count = el<HTMLElement>('notif-count');
  const markAll = el<HTMLButtonElement>('notif-mark-all');
  const clearEvery = el<HTMLButtonElement>('notif-clear-all');

  /**
   * Mid-claim state: the gold key flashes [+N] for a beat before the repaint
   * settles the card into its quiet Claimed chip. Kept here so a watcher
   * repaint mid-flash re-renders the flash instead of killing it early.
   */
  let flash: { id: string; coins: number } | null = null;
  let flashTimer = 0;

  const paintBadge = (): void => {
    const unread = getUnreadCount();
    if (badge) {
      /* the bell wears the count itself: a warm amber/red counter bead */
      badge.hidden = unread === 0;
      badge.textContent = unread > 0 ? String(unread) : '';
      badge.setAttribute('aria-hidden', 'true');
    }
    if (bell) {
      const wasSilent = !bell.classList.contains('has-unread');
      bell.classList.toggle('has-unread', unread > 0);
      /* a fresh batch rings the bell once on mount: transform-only, no CSS loop */
      if (wasSilent && unread > 0 && !motionReduced()) {
        bell.classList.remove('ring');
        void bell.offsetWidth;
        bell.classList.add('ring');
      }
      bell.setAttribute(
        'aria-label',
        unread > 0 ? `Open notifications, ${unread} unread` : 'Open notifications',
      );
    }
    if (count) {
      count.hidden = unread === 0;
      count.textContent = unread > 0 ? `${unread} new` : '';
    }
    if (markAll) markAll.disabled = unread === 0;
    if (clearEvery) clearEvery.disabled = getNotifications().length === 0;
  };

  const paintList = (): void => {
    if (!list) return;
    const rows = getNotifications();
    list.textContent = '';
    if (empty) empty.hidden = rows.length > 0;

    for (const n of rows) {
      const card = document.createElement('article');
      card.className = `notif-card kind-${n.kind}${n.read ? ' is-read' : ' is-unread'}`;
      card.dataset.id = n.id;

      const ico = document.createElement('span');
      ico.className = `notif-ico ${n.kind}`;
      ico.setAttribute('aria-hidden', 'true');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'ico');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', KIND_ICON[n.kind]);
      svg.append(use);
      ico.append(svg);

      const txt = document.createElement('div');
      txt.className = 'notif-txt';
      const kind = document.createElement('span');
      kind.className = 'notif-kind';
      kind.textContent = KIND_LABEL[n.kind];
      const title = document.createElement('p');
      title.className = 'notif-title';
      title.textContent = n.title;
      const body = document.createElement('p');
      body.className = 'notif-body';
      body.textContent = n.body;
      const time = document.createElement('span');
      time.className = 'notif-time';
      time.textContent = timeAgo(n.createdAt);
      time.setAttribute('datetime', new Date(n.createdAt).toISOString());
      txt.append(kind, title, body, time);

      card.append(ico, txt);

      /* reward rows: [Claim] gold key → [+N] flash → quiet Claimed chip */
      if (n.kind === 'reward') {
        if (flash !== null && flash.id === n.id) {
          const gain = document.createElement('button');
          gain.type = 'button';
          gain.className = 'notif-claim is-gain';
          gain.disabled = true;
          gain.textContent = `+${flash.coins}`;
          gain.setAttribute('aria-label', `Claimed +${flash.coins} coins`);
          card.append(gain);
        } else if (n.claimed) {
          const done = document.createElement('span');
          done.className = 'notif-claimed';
          done.textContent = 'Claimed';
          card.append(done);
        } else {
          const claim = document.createElement('button');
          claim.type = 'button';
          claim.className = 'notif-claim';
          claim.dataset.claim = n.id;
          claim.textContent = 'Claim';
          claim.setAttribute('aria-label', `Claim reward: ${n.body}`);
          card.append(claim);
        }
      }

      if (!n.read) {
        const dot = document.createElement('span');
        dot.className = 'notif-dot';
        dot.setAttribute('aria-hidden', 'true');
        card.append(dot);
      }

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'notif-del';
      del.dataset.del = n.id;
      del.setAttribute('aria-label', `Delete: ${n.title}`);
      const delSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      delSvg.setAttribute('class', 'ico');
      delSvg.setAttribute('aria-hidden', 'true');
      const delUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      delUse.setAttribute('href', '#i-trash');
      delSvg.append(delUse);
      del.append(delSvg);
      card.append(del);

      list.append(card);
    }
  };

  const refresh = (): void => {
    paintBadge();
    if (sheet && !sheet.hidden) paintList();
  };

  bell?.addEventListener('click', () => {
    if (!sheet) return;
    impact('light');
    paintList();
    paintBadge();
    deps.sheets.open(sheet);
  });

  markAll?.addEventListener('click', () => {
    if (!hasUnread()) return;
    impact('light');
    markAllAsRead();
    paintList();
    paintBadge();
  });

  /* [Clear All]: the drawer breathes out once, then the store empties. */
  clearEvery?.addEventListener('click', () => {
    if (clearEvery.disabled) return;
    impact('light');
    if (list && !motionReduced()) {
      list.classList.add('is-clearing');
      window.setTimeout(() => {
        list.classList.remove('is-clearing');
        clearAll();
      }, 170);
      return;
    }
    clearAll();
    paintList();
    paintBadge();
  });

  // One delegated listener: card tap marks read, [Claim] settles the wallet,
  // [Delete] collapses its card before the row leaves the store. The claim and
  // delete keys stop propagation, so one tap never does two things at once.
  list?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const delBtn = target.closest<HTMLButtonElement>('[data-del]');
    if (delBtn) {
      e.stopPropagation();
      const id = delBtn.dataset.del ?? '';
      const card = delBtn.closest<HTMLElement>('.notif-card');
      impact('light');
      if (card && list && !motionReduced()) {
        /* measured height → 0 collapse, then out of the store (one repaint) */
        card.classList.add('is-out');
        card.style.height = `${card.offsetHeight}px`;
        card.style.paddingTop = '0';
        card.style.paddingBottom = '0';
        void card.offsetHeight;
        card.style.height = '0px';
        window.setTimeout(() => deleteNotification(id), 230);
      } else {
        deleteNotification(id);
      }
      return;
    }
    const claimBtn = target.closest<HTMLButtonElement>('[data-claim]');
    if (claimBtn) {
      e.stopPropagation();
      const id = claimBtn.dataset.claim ?? '';
      const paid = claimReward(id);
      if (paid > 0) {
        notify('success');
        impact('medium');
        chime();
        flash = { id, coins: paid };
        if (flashTimer) window.clearTimeout(flashTimer);
        flashTimer = window.setTimeout(() => {
          flash = null;
          flashTimer = 0;
          paintList();
        }, 760);
      } else {
        impact('light');
      }
      paintList();
      paintBadge();
      return;
    }
    const card = target.closest<HTMLElement>('.notif-card[data-id]');
    if (!card?.dataset.id) return;
    impact('light');
    markAsRead(card.dataset.id);
    paintList();
    paintBadge();
  });

  onNotifications(() => {
    paintBadge();
    if (sheet && !sheet.hidden) paintList();
  });

  // Timestamps go stale ("just now" → "1m ago"): one cheap repaint per minute
  // while the sheet is open. No per-card timers, no layout work when closed.
  window.setInterval(() => {
    if (sheet && !sheet.hidden) paintList();
  }, 60_000);

  paintBadge();
  return { refresh };
}

/* ------------------------------------------------------------------ */
/* Relic duel challenge modal                                          */
/* ------------------------------------------------------------------ */

interface RelicModalEls {
  host: HTMLElement;
  card: HTMLElement;
  title: HTMLElement;
  kicker: HTMLElement;
  challengerLabel: HTMLElement;
  stakeLabel: HTMLElement;
  avatar: HTMLElement;
  avatarImg: HTMLImageElement;
  monogram: HTMLElement;
  name: HTMLElement;
  tiq: HTMLElement;
  relicCrest: HTMLElement;
  relicName: HTMLElement;
  relicSerial: HTMLElement;
  fill: HTMLElement;
  seconds: HTMLElement;
  accept: HTMLButtonElement;
  decline: HTMLButtonElement;
  acceptLabel: HTMLElement;
  declineLabel: HTMLElement;
}

let relicEls: RelicModalEls | null = null;
let relicCurrent: RelicChallenge | null = null;
let relicQueue: RelicChallenge[] = [];
let relicTimer = 0;
let relicCloseTimer = 0;
let relicOpener: HTMLElement | null = null;
let relicLangBound = false;

const relicIcon = (href: string, cls = 'rd-ico'): SVGSVGElement => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${href}`);
  svg.append(use);
  return svg;
};

const relicSerialCode = (serial: number): string => `№ ${String(serial).padStart(3, '0')}`;

function buildRelicModal(): RelicModalEls | null {
  if (relicEls) return relicEls;
  const host = document.createElement('div');
  host.className = 'rd';
  host.id = 'relic-duel-modal';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-labelledby', 'rd-title');

  const card = document.createElement('div');
  card.className = 'rd-card';

  const head = document.createElement('header');
  head.className = 'rd-head';
  const crest = document.createElement('span');
  crest.className = 'rd-mark';
  crest.append(relicIcon('i-swords'));
  const title = document.createElement('h2');
  title.className = 'rd-title';
  title.id = 'rd-title';
  const kicker = document.createElement('p');
  kicker.className = 'rd-kicker';
  head.append(crest, title, kicker);

  const challenger = document.createElement('section');
  challenger.className = 'rd-challenger';
  const challengerLabel = document.createElement('p');
  challengerLabel.className = 'rd-label';
  const face = document.createElement('div');
  face.className = 'rd-face';
  const avatar = document.createElement('span');
  avatar.className = 'rd-av';
  const monogram = document.createElement('b');
  monogram.className = 'rd-mono';
  const avatarImg = document.createElement('img');
  avatarImg.className = 'rd-av-img';
  avatarImg.alt = '';
  avatarImg.decoding = 'async';
  avatarImg.referrerPolicy = 'no-referrer';
  avatarImg.hidden = true;
  avatar.append(monogram, avatarImg);
  const who = document.createElement('div');
  who.className = 'rd-who';
  const name = document.createElement('b');
  name.className = 'rd-name';
  name.dir = 'auto';
  const tiq = document.createElement('span');
  tiq.className = 'rd-tiq';
  tiq.append(relicIcon('i-brain', 'rd-tiq-ico'));
  const tiqNum = document.createElement('b');
  tiqNum.className = 'rd-tiq-n';
  tiq.append(tiqNum);
  who.append(name, tiq);
  face.append(avatar, who);
  challenger.append(challengerLabel, face);

  const stake = document.createElement('section');
  stake.className = 'rd-stake';
  const stakeLabel = document.createElement('p');
  stakeLabel.className = 'rd-label';
  const relic = document.createElement('div');
  relic.className = 'rd-relic';
  const relicCrest = document.createElement('span');
  relicCrest.className = 'rd-relic-crest';
  const relicId = document.createElement('span');
  relicId.className = 'rd-relic-id';
  const relicName = document.createElement('b');
  relicName.className = 'rd-relic-name';
  const relicSerial = document.createElement('span');
  relicSerial.className = 'rd-relic-serial';
  relicSerial.dir = 'ltr';
  relicId.append(relicName, relicSerial);
  relic.append(relicCrest, relicId);
  stake.append(stakeLabel, relic);

  const timer = document.createElement('div');
  timer.className = 'rd-timer';
  const track = document.createElement('div');
  track.className = 'rd-track';
  track.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('span');
  fill.className = 'rd-fill';
  track.append(fill);
  const seconds = document.createElement('p');
  seconds.className = 'rd-seconds';
  seconds.setAttribute('role', 'timer');
  timer.append(track, seconds);

  const actions = document.createElement('footer');
  actions.className = 'rd-actions';
  const accept = document.createElement('button');
  accept.type = 'button';
  accept.className = 'rd-accept';
  const acceptLabel = document.createElement('span');
  accept.append(relicIcon('i-swords'), acceptLabel);
  const decline = document.createElement('button');
  decline.type = 'button';
  decline.className = 'rd-decline';
  const declineLabel = document.createElement('span');
  decline.append(declineLabel);
  actions.append(accept, decline);

  card.append(head, challenger, stake, timer, actions);
  host.append(card);

  /* Backdrop taps are ignored on purpose: a 25s duel offer is answered, not dismissed by accident. */
  accept.addEventListener('click', () => respondRelic(true));
  decline.addEventListener('click', () => respondRelic(false));

  relicEls = {
    host, card, title, kicker, challengerLabel, stakeLabel, avatar, avatarImg, monogram, name, tiq,
    relicCrest, relicName, relicSerial, fill, seconds, accept, decline, acceptLabel, declineLabel,
  };
  /* the TIQ figure sits inside `tiq`, keep the direct reference through a property lookup */
  (relicEls as RelicModalEls & { tiqNum?: HTMLElement }).tiqNum = tiqNum;
  return relicEls;
}

function relicTiqNode(): HTMLElement | null {
  return relicEls?.tiq.querySelector<HTMLElement>('.rd-tiq-n') ?? null;
}

function paintRelicCopy(): void {
  if (!relicEls || !relicCurrent) return;
  const c = relicCurrent;
  const def = badgeById(c.relicId);
  const dir = langDef(lang).dir;
  relicEls.host.dir = dir;
  relicEls.card.classList.toggle('is-rtl', dir === 'rtl');
  relicEls.title.textContent = t('relicDuelTitle');
  relicEls.kicker.textContent = t('relicDuelKicker');
  relicEls.challengerLabel.textContent = t('relicDuelChallenger');
  relicEls.stakeLabel.textContent = t('relicDuelStake');
  relicEls.acceptLabel.textContent = t('relicDuelAccept');
  relicEls.declineLabel.textContent = t('relicDuelDecline');
  relicEls.accept.setAttribute('aria-label', t('relicDuelAccept'));
  relicEls.decline.setAttribute('aria-label', t('relicDuelDecline'));
  relicEls.host.setAttribute('aria-label', t('relicDuelAria'));
  relicEls.name.textContent = c.challengerName || 'Player';
  relicEls.monogram.textContent = (c.challengerName || '?').trim().charAt(0).toUpperCase() || '?';
  const tiqNum = relicTiqNode();
  if (tiqNum) tiqNum.textContent = c.challengerTiq.toLocaleString('en-US');
  relicEls.relicName.textContent = def?.name ?? c.relicId;
  relicEls.relicSerial.textContent = relicSerialCode(c.relicSerial);
  if (def) {
    relicEls.relicCrest.dataset.accent = def.accent;
    relicEls.relicCrest.innerHTML = badgeCrestHtml(def, 'badge-crest rd-crest');
  } else {
    relicEls.relicCrest.replaceChildren(relicIcon('i-medal', 'rd-crest-ico'));
  }
  const src = c.challengerAvatar;
  relicEls.avatarImg.hidden = true;
  relicEls.avatarImg.removeAttribute('src');
  if (/^https:\/\/[^\s"'<>\\]+$/i.test(src)) {
    relicEls.avatarImg.onload = () => {
      if (relicEls && relicEls.avatarImg.src === src) {
        relicEls.avatarImg.hidden = relicEls.avatarImg.naturalWidth <= 2 || relicEls.avatarImg.naturalHeight <= 2;
      }
    };
    relicEls.avatarImg.onerror = () => { if (relicEls) relicEls.avatarImg.hidden = true; };
    relicEls.avatarImg.src = src;
  }
}

function paintRelicClock(): void {
  if (!relicEls || !relicCurrent) return;
  const left = Math.max(0, relicCurrent.expiresAt - Date.now());
  const total = Math.max(1, 25_000);
  const ratio = Math.max(0, Math.min(1, left / total));
  relicEls.fill.style.transform = `scaleX(${ratio.toFixed(4)})`;
  const seconds = Math.ceil(left / 1000);
  relicEls.seconds.textContent = t('relicDuelSeconds').replace('{s}', String(seconds));
  if (left <= 0) {
    stopRelicClock();
    dismissRelicChallenge();
  }
}

function stopRelicClock(): void {
  if (!relicTimer) return;
  window.clearInterval(relicTimer);
  relicTimer = 0;
}

function respondRelic(accept: boolean): void {
  const current = relicCurrent;
  if (!current || !relicEls) return;
  const id = current.challengeId;
  relicEls.accept.disabled = true;
  relicEls.decline.disabled = true;
  const sent = accept ? acceptRelicChallenge(id) : declineRelicChallenge(id);
  if (!sent) {
    notify('error');
    showToast(t('relicDuelOffline'), 'error');
    /* A decline is final either way: the server's own clock will expire the offer. An accept
       is not, so its key stays live for another try while the channel is down. */
    if (accept) {
      relicEls.accept.disabled = false;
      relicEls.decline.disabled = false;
    } else {
      dismissRelicChallenge(id);
    }
    return;
  }
  impact(accept ? 'heavy' : 'light');
  notify(accept ? 'success' : 'warning');
  dismissRelicChallenge(id);
}

/** Remove the challenge card (smoothly) and hand the stage to the next queued offer. */
export function dismissRelicChallenge(challengeId?: string): void {
  if (challengeId) relicQueue = relicQueue.filter((c) => c.challengeId !== challengeId);
  if (!relicCurrent) return;
  if (challengeId && relicCurrent.challengeId !== challengeId) return;
  stopRelicClock();
  window.clearTimeout(relicCloseTimer);
  const host = relicEls?.host ?? null;
  relicCurrent = null;
  if (host) {
    host.classList.remove('is-in');
    relicCloseTimer = window.setTimeout(() => {
      host.remove();
      if (relicEls?.host === host) relicEls = null;
      const back = relicOpener;
      relicOpener = null;
      if (back && document.contains(back)) {
        try { back.focus({ preventScroll: true }); } catch { /* gone already */ }
      }
      nextRelicChallenge();
    }, motionReduced() ? 0 : 200);
  } else {
    nextRelicChallenge();
  }
}

function nextRelicChallenge(): void {
  if (relicCurrent || !relicQueue.length) return;
  const next = relicQueue.shift();
  if (next) openRelicChallenge(next);
}

/** Drop the open offer and everything queued — a duel is starting, so no offer may follow it in. */
export function clearRelicChallenges(): void {
  /* Queued offers are real people waiting: tell the room they were not taken. */
  for (const waiting of relicQueue) declineRelicChallenge(waiting.challengeId);
  relicQueue = [];
  const open = relicCurrent;
  if (open) declineRelicChallenge(open.challengeId);
  if (!relicCurrent) return;
  stopRelicClock();
  window.clearTimeout(relicCloseTimer);
  const host = relicEls?.host ?? null;
  relicCurrent = null;
  if (host) {
    host.classList.remove('is-in');
    relicCloseTimer = window.setTimeout(() => {
      host.remove();
      if (relicEls?.host === host) relicEls = null;
    }, motionReduced() ? 0 : 200);
  }
}

function openRelicChallenge(challenge: RelicChallenge): void {
  const els = buildRelicModal();
  if (!els) return;
  window.clearTimeout(relicCloseTimer);
  relicCloseTimer = 0;
  relicCurrent = challenge;
  relicOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  paintRelicCopy();
  els.accept.disabled = false;
  els.decline.disabled = false;
  els.avatarImg.hidden = true;
  els.host.classList.remove('is-in');
  if (!document.contains(els.host)) document.body.appendChild(els.host);
  void els.host.offsetWidth;
  requestAnimationFrame(() => els.host.classList.add('is-in'));
  paintRelicClock();
  stopRelicClock();
  relicTimer = window.setInterval(paintRelicClock, 100);
  els.accept.focus({ preventScroll: true });
  impact('heavy');
  notify('warning');

  if (!relicLangBound) {
    relicLangBound = true;
    onLang(() => { if (relicCurrent) paintRelicCopy(); });
  }
}

/**
 * Present one relic challenge. A second offer that arrives while the first is still up waits its
 * turn instead of replacing the countdown the player is reading.
 */
export function showRelicChallenge(challenge: RelicChallenge): void {
  if (!challenge || !challenge.challengeId) return;
  if (relicCurrent) {
    if (relicCurrent.challengeId === challenge.challengeId) return;
    if (!relicQueue.some((c) => c.challengeId === challenge.challengeId)) relicQueue.push(challenge);
    return;
  }
  openRelicChallenge(challenge);
}

/** File a missed challenge into the in-game inbox (the holder was away or the clock ran out). */
export function noteRelicMissed(item: RelicMailboxItem): void {
  const def = badgeById(item.relicId);
  const relic = def
    ? `${def.name} ${relicSerialCode(item.relicSerial)}`
    : `${item.relicId} ${relicSerialCode(item.relicSerial)}`;
  addNotification({
    id: `relic-challenge-${item.challengeId}`,
    kind: 'announcement',
    title: t('relicDuelMissedTitle'),
    body: t('relicDuelMissedBody')
      .replace('{name}', item.challengerName || 'Player')
      .replace('{relic}', relic),
    createdAt: item.createdAt || Date.now(),
  });
}

/* Escape answers the offer with a decline: the modal is never dismissed by a stray backdrop tap. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !relicCurrent) return;
  e.preventDefault();
  e.stopPropagation();
  respondRelic(false);
}, true);
