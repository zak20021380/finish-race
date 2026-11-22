/**
 * friends.ts — Friends & Rivals: the persistent head-to-head roster and the one sheet that reads it.
 *
 * The list is built from the races the player actually finished. Every human seat on the far side
 * of a settled board is folded into a record keyed by that player's stable id, and a record is
 * surfaced automatically once it holds more than one match — no follow, no accept, no second tap.
 * A player may also pin somebody by `@username` or id through the Worker's lookup door, and remove
 * any row again; removal only hides the row (`dismissed`), it never erases the record, so adding
 * the same rival back restores the very same W/L history.
 *
 * The sheet is deliberately outside the room drawer and outside every screen: it is one modal,
 * built once, repainted from the store. Rows are plain flex cards carrying `contain: layout paint`,
 * and the two row actions ride ONE delegated listener — so opening the sheet is a single class
 * flip and tapping a row never rebuilds the list. There is no blur, no infinite animation and no
 * per-row listener anywhere in this file.
 */
import { adoptUserStorageKey, readJson, writeJson } from './storage';
import { createModal, type ModalHandle } from './modal';
import { onLang, t } from './settings';
import { impact, openTelegramShare, roomShareUrl, tgInitData } from './telegram';
import { workerUrl } from './adminApi';
import { createRoomCode, openInviteRoom } from './gamemodes';
import { showToast } from './toast';

/* ---------- the store ---------- */

/** One opponent's record, keyed by their stable player id on the wire. */
export interface FriendRecord {
  id: string;
  name: string;
  username: string;
  avatar: string;
  /** Matches the local player won against this opponent. */
  wins: number;
  /** Matches this opponent won. */
  losses: number;
  /** Every settled meeting, so `wins + losses` (or a legacy blob) can be read safely. */
  matches: number;
  /** Added by hand: always surfaced while not dismissed. */
  pinned: boolean;
  /** Removed by hand: never auto-surfaced again until the player adds them back. */
  dismissed: boolean;
  lastPlayedAt: number;
}

/** One settled opponent handed over by the board's settlement. */
export interface FriendOpponent {
  id: string;
  name: string;
  username?: string;
  avatar?: string | null;
  /** True when the local player's side beat this opponent's side on the settled board. */
  won: boolean;
}

const BASE_KEY = 'detour.friends.v1';
const KEY = adoptUserStorageKey(BASE_KEY);
/** The store is read once and kept in memory: every surface repaints from this one array. */
let store: FriendRecord[] | null = null;

const cleanText = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const cleanCount = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** A stable seat: never a bot chair and never the lobby's positional fallback. */
function cleanId(value: unknown): string {
  const raw = cleanText(value, 64);
  if (!raw) return '';
  if (raw.startsWith('bot:') || raw.startsWith('seat:')) return '';
  return raw;
}

function readRecord(raw: unknown): FriendRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = cleanId(r.id);
  if (!id) return null;
  const wins = cleanCount(r.wins);
  const losses = cleanCount(r.losses);
  return {
    id,
    name: cleanText(r.name, 40) || 'Player',
    username: cleanText(r.username, 40).replace(/^@+/, ''),
    avatar: cleanText(r.avatar, 400),
    wins,
    losses,
    matches: Math.max(cleanCount(r.matches), wins + losses),
    pinned: r.pinned === true,
    dismissed: r.dismissed === true,
    lastPlayedAt: cleanCount(r.lastPlayedAt),
  };
}

/** The roster, loaded once per launch and never re-parsed by a repaint. */
function roster(): FriendRecord[] {
  if (store) return store;
  const blob = readJson<{ list?: unknown }>(KEY);
  const rows = Array.isArray(blob?.list) ? blob.list : [];
  const out: FriendRecord[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const rec = readRecord(raw);
    if (!rec || seen.has(rec.id)) continue;
    seen.add(rec.id);
    out.push(rec);
  }
  store = out;
  return out;
}

function persist(): void {
  writeJson(KEY, { list: roster() });
}

/** A record appears when it was pinned by hand, or when the history itself qualifies it. */
const surfaced = (rec: FriendRecord): boolean => !rec.dismissed && (rec.pinned || rec.matches > 1);

/** The rows the sheet prints: pinned first, then the freshest rivalry. */
function visibleRows(): FriendRecord[] {
  return roster()
    .filter(surfaced)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || b.lastPlayedAt - a.lastPlayedAt
      || a.name.localeCompare(b.name));
}

/** One-match opponents the player can add in a single tap. */
function recentRows(): FriendRecord[] {
  return roster()
    .filter((rec) => !rec.dismissed && !rec.pinned && rec.matches === 1)
    .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
    .slice(0, 8);
}

/** The live count on the drawer's entry button. */
export function friendsRivalCount(): number {
  return visibleRows().length;
}

/**
 * Fold one settled board's human opponents into the store.
 *
 * The caller hands over only people: the machine's seats, the local seat and a 2v2 partner are
 * filtered out before this door. Two or more meetings with somebody surface them automatically,
 * and a record the player removed stays removed — a fresh race never undoes an explicit choice.
 */
export function recordFriendsMatch(rows: readonly FriendOpponent[]): void {
  if (!rows.length) return;
  const now = Date.now();
  let touched = false;
  for (const row of rows) {
    const id = cleanId(row.id);
    if (!id) continue;
    const name = cleanText(row.name, 40);
    const username = cleanText(row.username, 40).replace(/^@+/, '');
    const avatar = cleanText(row.avatar, 400);
    let rec = roster().find((entry) => entry.id === id);
    if (!rec) {
      rec = {
        id, name: name || 'Player', username, avatar,
        wins: 0, losses: 0, matches: 0,
        pinned: false, dismissed: false, lastPlayedAt: 0,
      };
      roster().push(rec);
    }
    if (name) rec.name = name;
    if (username) rec.username = username;
    if (avatar) rec.avatar = avatar;
    rec.matches += 1;
    if (row.won) rec.wins += 1;
    else rec.losses += 1;
    rec.lastPlayedAt = now;
    touched = true;
  }
  if (!touched) return;
  persist();
  paintEntry();
  if (modal?.isOpen()) paintList();
}

/* ---------- the modal ---------- */

let modal: ModalHandle | null = null;
let wired = false;
let statusTimer = 0;

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

/** Every numeral this module writes is Latin and tabular: no locale formatting anywhere. */
const latin = (n: number): string => String(Math.max(0, Math.floor(n)));

/** The letter a photo-less avatar wears. */
function monogram(name: string): string {
  const chars = Array.from((name || '?').trim());
  return (chars[0] ?? '?').toUpperCase();
}

/** One localized line with its `{token}` slots filled — never markup, only text. */
function fill(key: string, tokens: Record<string, string>): string {
  return t(key).replace(/\{(\w+)\}/g, (whole, token: string) => tokens[token] ?? whole);
}

function setStatus(message: string, tone: 'ok' | 'warn'): void {
  const el = $('fr-status');
  if (!el) return;
  el.textContent = message;
  el.dataset.tone = tone;
  el.hidden = false;
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    el.hidden = true;
    statusTimer = 0;
  }, 3200);
}

/** Paint the static copy of the entry button and the sheet from the live language table. */
function paintCopy(): void {
  for (const scope of [$('friends-rivals-btn'), $('friends-modal')]) {
    if (!scope) continue;
    for (const el of scope.querySelectorAll<HTMLElement>('[data-i18n]')) {
      const key = el.dataset.i18n;
      if (key) el.textContent = t(key);
    }
    for (const el of scope.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
      const key = el.dataset.i18nAria;
      if (key) el.setAttribute('aria-label', t(key));
    }
    for (const el of scope.querySelectorAll<HTMLInputElement>('[data-i18n-ph]')) {
      const key = el.dataset.i18nPh;
      if (key) el.setAttribute('placeholder', t(key));
    }
  }
  const input = $<HTMLInputElement>('fr-input');
  if (input) input.setAttribute('aria-label', t('frAddPlaceholder'));
}

function paintEntry(): void {
  const count = friendsRivalCount();
  const pill = $('friends-rivals-count');
  if (pill && pill.textContent !== latin(count)) pill.textContent = latin(count);
  const btn = $('friends-rivals-btn');
  if (btn) btn.setAttribute('aria-label', `${t('frTitle')} · ${latin(count)}`);
}

function avatarNode(rec: FriendRecord): HTMLElement {
  const node = document.createElement('span');
  node.className = 'fr-ava';
  if (/^https?:\/\//i.test(rec.avatar)) {
    const img = document.createElement('img');
    img.src = rec.avatar;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.draggable = false;
    node.append(img);
  } else {
    node.textContent = monogram(rec.name);
  }
  return node;
}

/** One row: face, identity + H2H readout, then the two actions. Built without innerHTML. */
function rowNode(rec: FriendRecord): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'fr-card';
  li.dataset.frId = rec.id;

  li.append(avatarNode(rec));

  const mid = document.createElement('span');
  mid.className = 'fr-mid';

  const top = document.createElement('span');
  top.className = 'fr-top';
  const name = document.createElement('bdi');
  name.className = 'fr-name';
  name.dir = 'auto';
  name.textContent = rec.name;
  top.append(name);
  if (rec.username) {
    const tag = document.createElement('span');
    tag.className = 'fr-tag';
    tag.dir = 'ltr';
    tag.textContent = `@${rec.username}`;
    top.append(tag);
  }
  if (rec.matches > 1) {
    const tag = document.createElement('span');
    tag.className = 'fr-tag is-auto';
    tag.textContent = t('frFrequent');
    tag.title = t('frFrequentTag');
    top.append(tag);
  }
  mid.append(top);

  const record = document.createElement('span');
  record.className = 'fr-h2h';
  const wl = document.createElement('bdi');
  wl.className = 'fr-wl';
  wl.dir = 'ltr';
  wl.textContent = fill('frRecord', { w: latin(rec.wins), l: latin(rec.losses) });
  wl.setAttribute('aria-label', fill('frH2hAria', {
    w: latin(rec.wins), l: latin(rec.losses), n: latin(rec.matches),
  }));
  const dot = document.createElement('span');
  dot.className = 'fr-dot';
  dot.setAttribute('aria-hidden', 'true');
  dot.textContent = '·';
  const rate = document.createElement('bdi');
  rate.className = 'fr-rate';
  rate.dir = 'ltr';
  const pct = rec.matches > 0 ? Math.round((rec.wins / rec.matches) * 100) : 0;
  rate.textContent = `${latin(pct)}%`;
  record.append(wl, dot, rate);
  mid.append(record);

  const bar = document.createElement('span');
  bar.className = 'fr-bar';
  bar.setAttribute('aria-hidden', 'true');
  const win = document.createElement('i');
  win.className = 'fr-bar-w';
  win.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  bar.append(win);
  mid.append(bar);

  li.append(mid);

  const acts = document.createElement('span');
  acts.className = 'fr-acts';
  const challenge = document.createElement('button');
  challenge.type = 'button';
  challenge.className = 'fr-chal';
  challenge.dataset.frChallenge = rec.id;
  challenge.textContent = t('frChallenge');
  challenge.setAttribute('aria-label', `${t('frChallenge')} · ${rec.name}`);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'fr-del';
  remove.dataset.frRemove = rec.id;
  remove.textContent = '×';
  remove.setAttribute('aria-label', `${t('frRemove')} · ${rec.name}`);
  acts.append(challenge, remove);
  li.append(acts);

  return li;
}

function recentChip(rec: FriendRecord): HTMLButtonElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'fr-chip';
  chip.dataset.frRecent = rec.id;
  const plus = document.createElement('b');
  plus.className = 'fr-chip-plus';
  plus.setAttribute('aria-hidden', 'true');
  plus.textContent = '+';
  const label = document.createElement('span');
  label.className = 'fr-chip-t';
  label.dir = 'auto';
  label.textContent = rec.username ? `@${rec.username}` : rec.name;
  chip.append(plus, label);
  chip.setAttribute('aria-label', `${t('frAdd')} · ${label.textContent}`);
  return chip;
}

function paintList(): void {
  const list = $<HTMLUListElement>('fr-list');
  if (!list) return;
  const rows = visibleRows();
  const frag = document.createDocumentFragment();
  for (const rec of rows) frag.append(rowNode(rec));
  list.replaceChildren(frag);
  list.hidden = rows.length === 0;

  const empty = $('fr-empty');
  if (empty) empty.hidden = rows.length > 0;

  const recentBox = $('fr-recent');
  const chips = $('fr-chips');
  if (recentBox && chips) {
    const recent = recentRows();
    const fragChips = document.createDocumentFragment();
    for (const rec of recent) fragChips.append(recentChip(rec));
    chips.replaceChildren(fragChips);
    recentBox.hidden = recent.length === 0;
  }
}

/* ---------- the manual doors ---------- */

type Lookup =
  | { ok: true; id: string; name: string; username: string; avatar: string }
  | { ok: false; reason: 'not_found' | 'failed' };

/** The device's guest seat, when this launch is not inside Telegram. */
function guestId(): string {
  try {
    return window.localStorage.getItem('tactix_guest_id')?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * `GET /api/user/lookup` — the one authenticated read behind manual adding. A signed Telegram
 * launch sends its initData; a browser tab sends the same device seat its socket uses.
 */
async function lookupPlayer(query: string): Promise<Lookup> {
  const url = workerUrl(`/api/user/lookup?q=${encodeURIComponent(query)}`);
  if (!url) return { ok: false, reason: 'failed' };
  const headers: Record<string, string> = { accept: 'application/json' };
  const init = tgInitData();
  if (init) headers['x-telegram-init-data'] = init;
  const guest = guestId();
  if (guest) headers['x-guest-id'] = guest;
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, { headers, signal: ac.signal, cache: 'no-store' });
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: 'failed' };
    const data = (await res.json()) as {
      id?: unknown; name?: unknown; username?: unknown; avatar?: unknown;
    } | null;
    const id = cleanId(data?.id);
    if (!id) return { ok: false, reason: 'not_found' };
    return {
      ok: true,
      id,
      name: cleanText(data?.name, 40) || 'Player',
      username: cleanText(data?.username, 40).replace(/^@+/, ''),
      avatar: cleanText(data?.avatar, 400),
    };
  } catch {
    return { ok: false, reason: 'failed' };
  } finally {
    window.clearTimeout(timer);
  }
}

let adding = false;

async function addByQuery(raw: string): Promise<void> {
  if (adding) return;
  const needle = raw.trim().replace(/^@+/, '').trim().slice(0, 64);
  if (!needle) return;
  const lower = needle.toLowerCase();
  const duplicate = roster().find((rec) => !rec.dismissed && (
    rec.id.toLowerCase() === lower
    || rec.id.toLowerCase() === `tg-${lower}`
    || (rec.username !== '' && rec.username.toLowerCase() === lower)
  ));
  if (duplicate) {
    setStatus(t('frAlready'), 'warn');
    return;
  }

  const button = $<HTMLButtonElement>('fr-add');
  adding = true;
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
  const found = await lookupPlayer(needle);
  adding = false;
  if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
  if (!found.ok) {
    setStatus(found.reason === 'not_found' ? t('frNotFound') : t('frAddFailed'), 'warn');
    return;
  }

  let rec = roster().find((entry) => entry.id === found.id);
  if (rec) {
    /* Adding somebody back revives the very same record: the W/L history is never reset. */
    rec.pinned = true;
    rec.dismissed = false;
    if (found.name) rec.name = found.name;
    if (found.username) rec.username = found.username;
    if (found.avatar) rec.avatar = found.avatar;
  } else {
    roster().push({
      id: found.id,
      name: found.name,
      username: found.username,
      avatar: found.avatar,
      wins: 0,
      losses: 0,
      matches: 0,
      pinned: true,
      dismissed: false,
      lastPlayedAt: Date.now(),
    });
  }
  persist();
  const input = $<HTMLInputElement>('fr-input');
  if (input) input.value = '';
  setStatus(t('frAdded'), 'ok');
  impact('light');
  paintEntry();
  paintList();
}

function removeFriend(id: string): void {
  const rec = roster().find((entry) => entry.id === id);
  if (!rec) return;
  rec.pinned = false;
  rec.dismissed = true;
  persist();
  impact('light');
  paintEntry();
  paintList();
}

function addRecent(id: string): void {
  const rec = roster().find((entry) => entry.id === id);
  if (!rec || rec.dismissed || rec.pinned) return;
  rec.pinned = true;
  rec.dismissed = false;
  persist();
  impact('light');
  setStatus(t('frAdded'), 'ok');
  paintEntry();
  paintList();
}

/** The friend's handle as the invitation names them. */
function handleOf(rec: FriendRecord): string {
  return rec.username ? `@${rec.username}` : rec.name;
}

/**
 * Open a fresh 1v1 friends room and hand its link to Telegram's own recipient picker. The room is
 * the drawer's ordinary duel lobby — no second socket, no second server path — and the sheet gets
 * out of its way so the player lands on the live seat counter.
 */
function challengeFriend(id: string): void {
  const rec = roster().find((entry) => entry.id === id);
  if (!rec) return;
  impact('medium');
  const code = createRoomCode();
  if (!openInviteRoom(code)) return;
  modal?.close();
  const share = roomShareUrl(code, fill('frChallengeText', { name: handleOf(rec) }));
  if (share) openTelegramShare(share);
  showToast(t('frChallengeSent'), 'success', 2400);
}

/* ---------- wiring ---------- */

/** Open the sheet over whatever is on screen. */
export function openFriendsRivals(): void {
  const root = $('friends-modal');
  if (!root) return;
  if (!wired) initFriends();
  const status = $('fr-status');
  if (status) status.hidden = true;
  window.clearTimeout(statusTimer);
  statusTimer = 0;
  paintCopy();
  paintEntry();
  paintList();
  modal?.open($('friends-rivals-btn'));
}

/**
 * One-time wiring. The sheet keeps ONE delegated tap for every row and chip, one submit for the
 * add bar, and one language watcher — nothing here scales with the size of the roster.
 */
export function initFriends(): void {
  if (wired) return;
  const root = $('friends-modal');
  if (!root) return;
  wired = true;
  modal = createModal(root, {
    onClose: () => {
      window.clearTimeout(statusTimer);
      statusTimer = 0;
      const status = $('fr-status');
      if (status) status.hidden = true;
    },
  });

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const remove = target.closest<HTMLElement>('[data-fr-remove]');
    if (remove) {
      event.preventDefault();
      const id = remove.dataset.frRemove ?? '';
      if (id) removeFriend(id);
      return;
    }
    const challenge = target.closest<HTMLElement>('[data-fr-challenge]');
    if (challenge) {
      event.preventDefault();
      const id = challenge.dataset.frChallenge ?? '';
      if (id) challengeFriend(id);
      return;
    }
    const recent = target.closest<HTMLElement>('[data-fr-recent]');
    if (recent) {
      event.preventDefault();
      const id = recent.dataset.frRecent ?? '';
      if (id) addRecent(id);
    }
  });

  const form = $<HTMLFormElement>('fr-add-form');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $<HTMLInputElement>('fr-input');
    void addByQuery(input?.value ?? '');
  });

  onLang(() => {
    paintCopy();
    paintEntry();
    paintList();
  });

  paintCopy();
  paintEntry();
  paintList();
}
