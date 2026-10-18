/**
 * broadcasts.ts — the announcement engine's client half: one popup, one feed.
 *
 * The Command Center dispatches announcements from the Worker (`POST /api/admin/broadcasts/
 * create`); this module is what a player's device does with them. Two shapes ride the same wire:
 *
 *   - `urgent` raises the Dark Clay popup (`#modal-announcement`) the moment it arrives, and keeps
 *     raising it on later launches until its Dismiss is pressed — the dismissal is remembered per
 *     device, so an announcement is never "seen" by accident.
 *   - `feed` takes the quiet road into the notification centre, one card per announcement, deduped
 *     by the broadcast's own id so a re-sync never stacks cards.
 *
 * Who sees what is decided here, where the player is known: an announcement to everyone, to one
 * country (the code in the save), or to a TIQ level floor (level 1 is 0-99 TIQ, level 2 is 100-199
 * and so on — `levelOf` in one place, so the panel's composer and this filter can never drift).
 *
 * The public read is `GET /api/client/announcements/active` and it is deliberately polite: it is
 * only fetched when there is actually a Worker to ask (a configured `VITE_WS_URL`, or a Telegram
 * session that implies the deployed one), never from a bare local page — where the route does not
 * exist and the request would be noise. The last-known list is cached on the device
 * (`detour.broadcasts.v1`) and served from there when offline, so standing instructions survive a
 * dead network. Dismissed ids live under the spec's own key, `dismissed_announcements`.
 */
import { readJson, writeJson } from './storage';
import { addNotification } from './notifications';
import { impact, tgInitData } from './telegram';
import { motionReduced } from './settings';
import { workerUrl } from './adminApi';

/* ---------- the wire ---------- */

export interface BroadcastAudience {
  /** `all` — everyone; `country` — one ISO 3166-1 alpha-2 code; `minLevel` — a TIQ level floor. */
  kind: 'all' | 'country' | 'minLevel';
  value: string;
}

export interface Broadcast {
  id: string;
  title: string;
  /** Plain text with a light markdown subset: **bold**, *italic*, `code`, newlines. */
  body: string;
  ctaLabel: string;
  ctaTarget: string;
  audience: BroadcastAudience;
  /** `urgent` pops a modal; `feed` lands in the notification centre. */
  priority: 'urgent' | 'feed';
  status: 'active' | 'archived';
  createdAt: number;
  createdBy: string;
  archivedAt: number;
}

/** Who the player is, for audience matching — read fresh at every sync. */
export interface AnnouncementIdentity {
  /** The ISO 3166-1 alpha-2 code from the save, or null. */
  country: string | null;
  /** The player's TIQ. */
  tiq: number;
}

/** The public feed's frame, or `null` when nothing answered. */
interface FeedPage {
  ok: true;
  announcements: Broadcast[];
  now: number;
}

/* ---------- the match ---------- */

/**
 * The level a TIQ folds into: level 1 covers 0-99, level 2 100-199, and so on. The composer's
 * "min level" audience and this filter read the same formula on purpose.
 */
export function levelOf(tiq: number): number {
  const n = Number.isFinite(tiq) ? Math.max(0, tiq) : 0;
  return 1 + Math.floor(n / 100);
}

/** Whether this player is in an announcement's audience. */
export function matchesAudience(b: Broadcast, who: AnnouncementIdentity): boolean {
  const a = b.audience;
  if (a.kind === 'country') {
    return !!who.country && who.country.toUpperCase() === a.value.toUpperCase();
  }
  if (a.kind === 'minLevel') {
    const min = Number(a.value);
    return !Number.isFinite(min) || levelOf(who.tiq) >= min;
  }
  return true;
}

function isBroadcast(v: unknown): v is Broadcast {
  const b = v as Partial<Broadcast> | null | undefined;
  if (!b || typeof b.id !== 'string' || !b.id) return false;
  if (typeof b.title !== 'string' || !b.title) return false;
  if (typeof b.body !== 'string') return false;
  if (b.priority !== 'urgent' && b.priority !== 'feed') return false;
  if (b.status !== 'active' && b.status !== 'archived') return false;
  const a = b.audience;
  if (!a || (a.kind !== 'all' && a.kind !== 'country' && a.kind !== 'minLevel')) return false;
  if (typeof a.value !== 'string') return false;
  return true;
}

/* ---------- the device store ---------- */

const STORE_KEY = 'detour.broadcasts.v1';
const DISMISS_KEY = 'dismissed_announcements';

interface BroadcastSave {
  v: number;
  items: Broadcast[];
}

/** The cached active list, newest first. Empty when nothing was ever fetched or stored. */
export function getBroadcasts(): Broadcast[] {
  const save = readJson<BroadcastSave>(STORE_KEY);
  const raw = (save as BroadcastSave | null)?.items;
  const items = Array.isArray(raw) ? raw.filter(isBroadcast) : [];
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

function setBroadcasts(items: Broadcast[]): void {
  writeJson(STORE_KEY, { v: 1, items } satisfies BroadcastSave);
}

/** The ids this device has dismissed, as a Set for cheap matching. */
export function getDismissedIds(): Set<string> {
  const raw = readJson<string[]>(DISMISS_KEY);
  return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
}

function dismiss(id: string): void {
  const ids = [...getDismissedIds(), id];
  writeJson(DISMISS_KEY, ids.slice(-200));
}

/* ---------- the public read ---------- */

/**
 * Is there actually a Worker to ask? A configured origin always counts; a Telegram session
 * implies the deployed one. A bare local page has neither, and its own origin has no
 * announcements route — so it never asks, and never shows up as a 404 in the console.
 */
function canFetch(): boolean {
  if ((import.meta.env.VITE_WS_URL ?? '').trim()) return true;
  return !!tgInitData();
}

/** `GET /api/client/announcements/active`, or null when there is nothing to ask or it did not answer. */
export async function fetchActiveAnnouncements(): Promise<Broadcast[] | null> {
  if (!canFetch()) return null;
  const url = workerUrl('/api/client/announcements/active');
  if (!url) return null;
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), 2500);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<FeedPage> | null;
    if (!data || data.ok !== true || !Array.isArray(data.announcements)) return null;
    const items = data.announcements.filter(isBroadcast);
    setBroadcasts(items);
    return items;
  } catch {
    return null;                              // offline, refused, or too slow: the cache answers
  } finally {
    window.clearTimeout(timer);
  }
}

/* ---------- the popup ---------- */

export interface AnnouncementsDeps {
  /** Who this player is right now — read at every sync, so country/TIQ changes take effect. */
  identity(): AnnouncementIdentity;
  /** Show an in-app screen by id. Returns false when the id is not a screen, so a URL can follow. */
  openRoute(id: string): boolean;
}

export interface Announcements {
  /** Refresh the cache (when online), file feed cards, and raise the next popup. */
  sync(): void;
  /** The Command Center just dispatched one: show it at once, without waiting for a fetch. */
  receive(b: Broadcast): void;
  /** The Command Center just archived one: pull it from the device store and close its popup. */
  retract(id: string): void;
  /** Close the open popup, if any (the admin stage stepping in front of it, for one). */
  close(): void;
  isOpen(): boolean;
}

/**
 * Escape first, decorate after — the body is authored by an admin, and "trusted" is not a
 * decoration this module can afford. Only the subset the composer promises is turned back into
 * markup: `**bold**`, `*italic*`, `` `code` `` and newlines.
 */
function renderBody(text: string): string {
  const safe = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return safe
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function createAnnouncements(deps: AnnouncementsDeps): Announcements {
  const modal = el<HTMLElement>('modal-announcement');
  const title = el<HTMLElement>('announce-title');
  const body = el<HTMLElement>('announce-body');
  const cta = el<HTMLButtonElement>('announce-cta');
  const dismissBtn = el<HTMLButtonElement>('announce-dismiss');

  let open = false;
  /** The announcement currently on screen, or null. */
  let current: Broadcast | null = null;
  let closeTimer = 0;
  /** What had focus before the popup took it, so Dismiss can hand it back. */
  let restoreFocus: HTMLElement | null = null;

  /** Urgent, in-audience, not-yet-dismissed, newest first — what may pop. */
  const eligible = (): Broadcast[] => {
    const who = deps.identity();
    const gone = getDismissedIds();
    return getBroadcasts().filter(
      (b) => b.priority === 'urgent' && b.status === 'active' && !gone.has(b.id) && matchesAudience(b, who),
    );
  };

  const show = (b: Broadcast): void => {
    if (!modal || !title || !body) return;
    if (closeTimer) {
      window.clearTimeout(closeTimer);
      closeTimer = 0;
    }
    current = b;
    open = true;
    title.textContent = b.title;
    body.innerHTML = renderBody(b.body);
    if (cta) {
      const has = !!b.ctaLabel && !!b.ctaTarget;
      cta.hidden = !has;
      cta.textContent = has ? b.ctaLabel : '';
    }
    restoreFocus = (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    modal.hidden = false;
    /* a forced reflow so the entry transition always runs from its start state */
    void modal.offsetWidth;
    modal.classList.add('is-open');
    impact('medium');
    /* focus the next step, not the close box: the popup is a task, not a dialog to flee */
    window.setTimeout(() => {
      if (!open) return;
      (cta && !cta.hidden ? cta : dismissBtn)?.focus();
    }, motionReduced() ? 0 : 120);
  };

  const presentNext = (): void => {
    if (open) return;
    const next = eligible()[0];
    if (next) show(next);
  };

  const close = (): void => {
    if (!open || !modal) return;
    open = false;
    current = null;
    modal.classList.remove('is-open');
    const done = (): void => {
      modal.hidden = true;
      restoreFocus?.focus?.();
      restoreFocus = null;
      presentNext();
    };
    if (motionReduced()) {
      done();
    } else {
      closeTimer = window.setTimeout(done, 240);
    }
  };

  /** The Dismiss path: remember the id so this device is never asked again. */
  const dismissCurrent = (): void => {
    if (current) dismiss(current.id);
    impact('light');
    close();
  };

  const followCta = (): void => {
    const b = current;
    if (!b) return;
    impact('light');
    /* An in-app route goes through the router; anything else is a link out. Dismissing is part
       of following: the call to action was the task, and it has been done. */
    dismiss(b.id);
    close();
    const target = b.ctaTarget;
    if (!target) return;
    if (deps.openRoute(target)) return;
    try {
      const w = window as unknown as {
        Telegram?: { WebApp?: { openTelegramLink?: (u: string) => void; openLink?: (u: string) => void } };
      };
      const tg = w.Telegram?.WebApp;
      if (target.includes('t.me/') && tg?.openTelegramLink) {
        tg.openTelegramLink(target);
        return;
      }
      if (tg?.openLink) {
        tg.openLink(target);
        return;
      }
    } catch {
      /* fall through to window.open */
    }
    try {
      window.open(target, '_blank', 'noopener');
    } catch {
      /* webview blocked — the announcement is still readable in the feed */
    }
  };

  /** Feed-priority announcements become notification-centre cards, one per broadcast id. */
  const fileFeed = (items: Broadcast[]): void => {
    const who = deps.identity();
    for (const b of items) {
      if (b.status !== 'active' || b.priority !== 'feed' || !matchesAudience(b, who)) continue;
      addNotification({
        id: b.id.startsWith('bc-') ? b.id : `bc-${b.id}`,
        kind: 'announcement',
        title: b.title,
        body: b.body.replace(/\s+/g, ' ').slice(0, 220),
        createdAt: b.createdAt,
      });
    }
  };

  const sync = (): void => {
    /* The cache answers first so a re-launch never waits on the network to show a standing
       popup; the fetch then replaces it, when there is a Worker to ask. */
    fileFeed(getBroadcasts());
    presentNext();
    void fetchActiveAnnouncements().then((items) => {
      if (!items) return;
      fileFeed(items);
      presentNext();
    });
  };

  dismissBtn?.addEventListener('click', dismissCurrent);
  cta?.addEventListener('click', followCta);
  /* a tap on the veil, not the panel, is a dismiss — the same gesture sheets use */
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) dismissCurrent();
  });

  document.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      dismissCurrent();
    }
  });

  return {
    sync,
    receive(b: Broadcast): void {
      if (!isBroadcast(b)) return;
      const rest = getBroadcasts().filter((x) => x.id !== b.id);
      setBroadcasts([b, ...rest]);
      fileFeed([b]);
      presentNext();
    },
    retract(id: string): void {
      setBroadcasts(getBroadcasts().filter((x) => x.id !== id));
      if (current?.id === id) close();
    },
    close,
    isOpen: (): boolean => open,
  };
}
