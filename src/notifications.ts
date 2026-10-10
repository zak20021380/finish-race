/**
 * notifications.ts — In-Game Notification Center (Inbox & Alerts).
 *
 * Local-first store + tactile sheet controller. One module owns the schema and
 * the only door to the device: `detour.notifications.v1` in localStorage.
 * A refused store still yields a working inbox (in-memory only), mirroring
 * storage.ts / squads.ts so the race never depends on persistence.
 *
 * Store API (spec): `getNotifications()`, `markAsRead(id)`,
 * `markAllAsRead()`, `hasUnread()` — plus `getUnreadCount()`,
 * `addNotification()` for future squad/tournament hooks, and
 * `onNotifications()` so the header bell repaints on every change.
 *
 * UI: `createNotifications({ sheets })` binds the header bell (#home-notifs),
 * the badge (#notif-badge) and the bottom sheet (#sheet-notifications).
 * Rendering uses textContent only (no innerHTML for user-adjacent strings)
 * and transform/opacity-only motion, per the Dark Clay contract.
 */
import { earnCoins } from './storage';
import { impact, notify } from './telegram';
import type { Sheets } from './sheets';

export type NotificationKind = 'squad' | 'tournament' | 'reward';

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
  Partial<Pick<AppNotification, 'createdAt' | 'read'>>;

const KEY = 'detour.notifications.v1';
const V = 1;
const MAX_ITEMS = 30;

interface NotifSave {
  v: number;
  items: AppNotification[];
}

const KINDS: readonly NotificationKind[] = ['squad', 'tournament', 'reward'];

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
  return [
    {
      id: 'seed-squad-rank',
      kind: 'squad',
      title: 'Squad update',
      body: 'Your squad @DogeSquad reached Rank #12! (+50 Trophies)',
      createdAt: now - 8 * min,
      read: false,
    },
    {
      id: 'seed-neon-cup',
      kind: 'tournament',
      title: 'Tournament starting soon',
      body: 'Neon Rush Cup starts in 10 minutes — don’t miss out!',
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

/** Future hook for squad / tournament / reward events. Returns the stored row. */
export function addNotification(input: NewNotification): AppNotification {
  const now = Date.now();
  const row: AppNotification = {
    id: `n-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
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
  reward: '#i-bag',
};

const KIND_LABEL: Record<NotificationKind, string> = {
  squad: 'Squad',
  tournament: 'Tournament',
  reward: 'Reward',
};

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

  const paintBadge = (): void => {
    const unread = getUnreadCount();
    if (badge) {
      badge.hidden = unread === 0;
      badge.textContent = unread > 9 ? '9+' : String(unread);
    }
    if (bell) {
      bell.classList.toggle('has-unread', unread > 0);
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

      // Reward rows carry a direct [Claim] key; claimed rows go quiet.
      if (n.kind === 'reward' && !n.claimed) {
        const claim = document.createElement('button');
        claim.type = 'button';
        claim.className = 'btn btn-primary sm notif-claim';
        claim.dataset.claim = n.id;
        claim.textContent = 'Claim';
        claim.setAttribute('aria-label', `Claim reward: ${n.body}`);
        card.append(claim);
      } else if (n.kind === 'reward' && n.claimed) {
        const done = document.createElement('span');
        done.className = 'notif-claimed';
        done.textContent = 'Claimed';
        card.append(done);
      }

      if (!n.read) {
        const dot = document.createElement('span');
        dot.className = 'notif-dot';
        dot.setAttribute('aria-hidden', 'true');
        card.append(dot);
      }

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

  // One delegated listener: card tap marks read, [Claim] settles the wallet.
  // The claim key stops propagation so one tap never both claims and re-reads.
  list?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const claimBtn = target.closest<HTMLButtonElement>('[data-claim]');
    if (claimBtn) {
      e.stopPropagation();
      const id = claimBtn.dataset.claim ?? '';
      const paid = claimReward(id);
      if (paid > 0) {
        notify('success');
        impact('medium');
        const prev = claimBtn.textContent;
        claimBtn.textContent = `+${paid}`;
        claimBtn.disabled = true;
        window.setTimeout(() => {
          if (claimBtn.isConnected && claimBtn.textContent === `+${paid}`) {
            claimBtn.textContent = prev;
          }
        }, 900);
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
