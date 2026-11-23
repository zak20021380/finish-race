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
import { lang, onLang, t, type LangCode } from './settings';
import { impact, openTelegramShare, roomShareUrl, startParam, tgInitData, tgUser } from './telegram';
import { workerUrl } from './adminApi';
import { copyText, createRoomCode, openInviteRoom } from './gamemodes';
import { botAppLink } from '../shared/config';
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

type FriendFilter = 'all' | 'most_wins' | 'most_losses';
let friendFilter: FriendFilter = 'all';

const winRateOf = (rec: FriendRecord): number => rec.matches > 0 ? rec.wins / rec.matches : 0;

/** The rows the sheet prints: pinned first by default, or ranked by the chosen record. */
function visibleRows(filter: FriendFilter = friendFilter): FriendRecord[] {
  const rows = roster().filter(surfaced);
  if (filter === 'most_wins') {
    return rows.sort((a, b) => b.wins - a.wins
      || winRateOf(b) - winRateOf(a)
      || Number(b.pinned) - Number(a.pinned)
      || b.lastPlayedAt - a.lastPlayedAt
      || a.name.localeCompare(b.name));
  }
  if (filter === 'most_losses') {
    return rows.sort((a, b) => b.losses - a.losses
      || b.matches - a.matches
      || Number(b.pinned) - Number(a.pinned)
      || b.lastPlayedAt - a.lastPlayedAt
      || a.name.localeCompare(b.name));
  }
  return rows.sort((a, b) => Number(b.pinned) - Number(a.pinned)
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

const FILTER_COPY: Record<LangCode, Record<FriendFilter, string>> = {
  en: { all: 'All', most_wins: 'Most Wins', most_losses: 'Most Losses' },
  fa: { all: 'همه', most_wins: 'بیشترین برد', most_losses: 'بیشترین باخت' },
  ru: { all: 'Все', most_wins: 'Больше побед', most_losses: 'Больше поражений' },
  ar: { all: 'الكل', most_wins: 'الأكثر فوزاً', most_losses: 'الأكثر خسارة' },
  es: { all: 'Todos', most_wins: 'Más victorias', most_losses: 'Más derrotas' },
};

const FILTER_ARIA: Record<LangCode, string> = {
  en: 'Sort friends by record',
  fa: 'مرتب‌سازی دوستان بر اساس آمار',
  ru: 'Сортировка друзей по статистике',
  ar: 'ترتيب الأصدقاء حسب الإحصائيات',
  es: 'Ordenar amigos por estadísticas',
};

const STAT_LABELS: Record<LangCode, { wins: string; losses: string }> = {
  en: { wins: 'W', losses: 'L' },
  fa: { wins: 'برد', losses: 'باخت' },
  ru: { wins: 'В', losses: 'П' },
  ar: { wins: 'ف', losses: 'خ' },
  es: { wins: 'V', losses: 'D' },
};

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
  paintFilters();
}

function paintFilters(): void {
  const bar = $('fr-filters');
  if (!bar) return;
  const copy = FILTER_COPY[lang] ?? FILTER_COPY.en;
  bar.setAttribute('aria-label', FILTER_ARIA[lang] ?? FILTER_ARIA.en);
  for (const button of bar.querySelectorAll<HTMLButtonElement>('[data-fr-filter]')) {
    const key = button.dataset.frFilter as FriendFilter | undefined;
    if (!key || !(key in copy)) continue;
    button.setAttribute('aria-pressed', String(key === friendFilter));
    const label = button.querySelector<HTMLElement>('[data-fr-filter-label]');
    if (label) label.textContent = copy[key];
  }
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
  record.setAttribute('role', 'img');
  record.setAttribute('aria-label', fill('frH2hAria', {
    w: latin(rec.wins), l: latin(rec.losses), n: latin(rec.matches),
  }));
  const labels = STAT_LABELS[lang] ?? STAT_LABELS.en;

  const wins = document.createElement('span');
  wins.className = 'fr-stat fr-stat-w';
  const winsLabel = document.createElement('span');
  winsLabel.textContent = labels.wins;
  const winsValue = document.createElement('bdi');
  winsValue.dir = 'ltr';
  winsValue.textContent = latin(rec.wins);
  wins.append(winsLabel, winsValue);

  const losses = document.createElement('span');
  losses.className = 'fr-stat fr-stat-l';
  const lossesLabel = document.createElement('span');
  lossesLabel.textContent = labels.losses;
  const lossesValue = document.createElement('bdi');
  lossesValue.dir = 'ltr';
  lossesValue.textContent = latin(rec.losses);
  losses.append(lossesLabel, lossesValue);

  const pct = Math.round(winRateOf(rec) * 100);
  const rate = document.createElement('span');
  rate.className = 'fr-stat fr-stat-rate';
  if (pct >= 50 && rec.matches > 0) rate.classList.add('is-good');
  const rateValue = document.createElement('bdi');
  rateValue.dir = 'ltr';
  rateValue.textContent = `${latin(pct)}%`;
  rate.append(rateValue);
  record.append(wins, losses, rate);
  mid.append(record);

  const bar = document.createElement('span');
  bar.className = 'fr-bar';
  bar.setAttribute('aria-hidden', 'true');
  const total = rec.wins + rec.losses;
  const win = document.createElement('i');
  win.className = 'fr-bar-w';
  win.style.width = `${total > 0 ? (rec.wins / total) * 100 : 0}%`;
  const loss = document.createElement('i');
  loss.className = 'fr-bar-l';
  loss.style.width = `${total > 0 ? (rec.losses / total) * 100 : 0}%`;
  bar.append(win, loss);
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
 * The player door every authenticated call in this module rides: a signed Telegram launch sends
 * its initData, and a browser tab sends the same device seat its own socket uses. One helper, so
 * the lookup, the invite link and the linked-friends read can never disagree about who is calling.
 */
function playerHeaders(json: boolean): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (json) headers['content-type'] = 'application/json';
  const init = tgInitData();
  if (init) headers['x-telegram-init-data'] = init;
  const guest = guestId();
  if (guest) headers['x-guest-id'] = guest;
  return headers;
}

/**
 * `GET /api/user/lookup` — the one authenticated read behind manual adding. A signed Telegram
 * launch sends its initData; a browser tab sends the same device seat its socket uses.
 */
async function lookupPlayer(query: string): Promise<Lookup> {
  const url = workerUrl(`/api/user/lookup?q=${encodeURIComponent(query)}`);
  if (!url) return { ok: false, reason: 'failed' };
  const headers = playerHeaders(false);
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
  /* `+ Add` is the MANUAL door and nothing else: an empty bar focuses the field instead of
     opening any kind of picker, so the two ways into this list never trade places. */
  if (!needle) {
    $<HTMLInputElement>('fr-input')?.focus();
    return;
  }
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

  const button = $<HTMLButtonElement>('fr-add-btn');
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

/* ---------- the Telegram doors ----------
 *
 * Two doors, kept strictly apart from the manual bar:
 *
 *   - `#fr-tg-pick-btn` opens Telegram's OWN contact list (`switchInlineQuery` filtered to
 *     `users`) and never touches the lookup route. Its payload is the same personal invite the
 *     inline card carries, so a picked friend reaches the app through the pairing door below.
 *   - `friend_<id>` on the launch payload is the pairing door: the accepter's own signed seat and
 *     the inviter are written together on the server, the inviter is pinned into this roster, and
 *     the room is told so it can hand the same pairing back the other way.
 *
 * Nothing here polls: the picker is one tap, the pairing is one POST, and the inviter's half is
 * read once per sheet open (coalesced), never on a timer.
 */

/** One player as the two friend-link routes hand them over. */
interface FriendCard {
  id: string;
  name: string;
  username: string;
  avatar: string;
}

/** `friend_<seat id>`: the whole grammar of a friend invite, and nothing else matches it. */
const FRIEND_PAYLOAD = /^friend_([A-Za-z0-9_-]{1,64})$/;

/** Fold one answered card, or null when it carries no usable seat. */
function readCard(raw: unknown): FriendCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = cleanId(r.id);
  if (!id) return null;
  return {
    id,
    name: cleanText(r.name, 40) || 'Player',
    username: cleanText(r.username, 40).replace(/^@+/, ''),
    avatar: cleanText(r.avatar, 400),
  };
}

/**
 * The numeric Telegram id this launch is signed under, or ''.
 *
 * The unsafe SDK copy is read first; a client that only hands over the raw `initData` query string
 * is parsed the same way `storage.ts` parses it, so a friend invite names the seat the room knows
 * (`tg-<id>`) even on a client that does not expose `initDataUnsafe`.
 */
function telegramIdOf(): string {
  const direct = tgUser()?.id as unknown;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return String(Math.trunc(direct));
  if (typeof direct === 'string' && /^[0-9]{1,20}$/.test(direct)) return direct;
  try {
    const raw = tgInitData();
    const user = raw ? new URLSearchParams(raw).get('user') : '';
    const id = user ? (JSON.parse(user) as { id?: unknown }).id : undefined;
    if (typeof id === 'number' && Number.isFinite(id) && id > 0) return String(Math.trunc(id));
    if (typeof id === 'string' && /^[0-9]{1,20}$/.test(id)) return id;
  } catch { /* no SDK, or a malformed initData */ }
  return '';
}

/**
 * The seat this launch belongs to: the room's own spelling `tg-<id>` inside Telegram, and the
 * device's persistent guest seat in a plain browser tab. It is what a friend invite names.
 */
function selfSeatId(): string {
  const tg = telegramIdOf();
  return tg ? `tg-${tg}` : guestId();
}

/** `friend_<myUserId>` — the payload the picker sends and the inline card carries. */
export function friendInvitePayload(): string {
  const id = selfSeatId();
  return id ? `friend_${id}` : '';
}

/** `https://t.me/<bot>/play?startapp=friend_<myUserId>` — the personal friend-invite link. */
export function friendInviteUrl(): string {
  const payload = friendInvitePayload();
  return payload ? botAppLink(payload) : '';
}

/** `POST /api/user/friend-link` — file the pairing and answer with the inviter's own card. */
async function postFriendLink(inviterId: string): Promise<FriendCard | null> {
  const url = workerUrl('/api/user/friend-link');
  if (!url) return null;
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: playerHeaders(true),
      body: JSON.stringify({ inviterId }),
      signal: ac.signal,
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: unknown; friend?: unknown } | null;
    return data?.ok === true ? readCard(data.friend) : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/** `GET /api/user/friends-linked` — everyone who tapped this player's invite, once. */
async function readLinkedFriends(): Promise<FriendCard[]> {
  const url = workerUrl('/api/user/friends-linked');
  if (!url) return [];
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, { headers: playerHeaders(false), signal: ac.signal, cache: 'no-store' });
    if (!res.ok) return [];
    const data = (await res.json()) as { ok?: unknown; friends?: unknown } | null;
    if (!Array.isArray(data?.friends)) return [];
    const out: FriendCard[] = [];
    for (const raw of data.friends) {
      const card = readCard(raw);
      if (card) out.push(card);
    }
    return out;
  } catch {
    return [];
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Pin one answered player into the roster — the same row `+ Add` would have written, so a friend
 * who arrives by link keeps the very W/L history that player already has here.
 */
function pinFriend(card: FriendCard): boolean {
  const id = cleanId(card.id);
  if (!id) return false;
  let rec = roster().find((entry) => entry.id === id);
  const changed = !rec || !rec.pinned || rec.dismissed;
  if (rec) {
    rec.pinned = true;
    rec.dismissed = false;
    if (card.name) rec.name = card.name;
    if (card.username) rec.username = card.username;
    if (card.avatar) rec.avatar = card.avatar;
  } else {
    roster().push({
      id,
      name: card.name || 'Player',
      username: card.username,
      avatar: card.avatar,
      wins: 0,
      losses: 0,
      matches: 0,
      pinned: true,
      dismissed: false,
      lastPlayedAt: Date.now(),
    });
  }
  if (changed) persist();
  return changed;
}

let linking = false;
let linkedAt = 0;
/** A sheet re-opened twice a second must not ask the room twice for the same rows. */
const LINK_SYNC_MS = 20_000;

/**
 * The inviter's half of the pairing: every friend who tapped `friend_<myUserId>` is pinned into
 * the roster. The room clears delivered rows, so this answers once per acceptance.
 */
export function syncLinkedFriends(): void {
  if (linking) return;
  const now = Date.now();
  if (linkedAt && now - linkedAt < LINK_SYNC_MS) return;
  linkedAt = now;
  linking = true;
  void readLinkedFriends().then((cards) => {
    linking = false;
    let changed = false;
    for (const card of cards) if (pinFriend(card)) changed = true;
    if (!changed) return;
    paintEntry();
    if (modal?.isOpen()) paintList();
  }).catch(() => { linking = false; });
}

/** Payloads already answered this launch: a warm `start_param` never files the same pairing twice. */
const handledInvites = new Set<string>();
let accepting = false;

/**
 * The accepter's half: `friend_<inviterId>` on the launch payload files the pairing, pins the
 * inviter here and opens the sheet with one line saying it landed. A payload that is not a friend
 * invite, or a pairing the room refused, leaves the launch exactly as it was — this door is
 * additive and never a gate.
 */
export async function acceptFriendInvite(): Promise<void> {
  if (accepting) return;
  let payload = '';
  try {
    payload = startParam().trim();
  } catch {
    return;
  }
  const match = FRIEND_PAYLOAD.exec(payload);
  if (!match) return;
  const inviterId = match[1];
  /* A client that HAS the SDK but no signed payload (a CDN-blocked boot, a stale script) is left
     alone rather than filing the pairing under this device's guest seat: the same payload is
     re-read on the next focus, when the SDK has had its chance to sign the launch. */
  if (window.Telegram?.WebApp && !tgInitData()) return;
  if (handledInvites.has(inviterId)) return;
  handledInvites.add(inviterId);
  accepting = true;
  const friend = await postFriendLink(inviterId);
  accepting = false;
  if (!friend) {
    /* A pairing the room could not be asked (offline, timeout) is not remembered as answered: the
       next focus or sheet open may still land it. Nothing is said to the player meanwhile — the
       launch is theirs, and a failed pairing is not a failed app. */
    handledInvites.delete(inviterId);
    return;
  }
  pinFriend(friend);
  impact('light');
  paintEntry();
  openFriendsRivals();
  setStatus(t('frLinked'), 'ok');
}

/** The client-side surface `switchInlineQuery` lives on; the SDK types here do not carry it. */
type InlineSwitcher = { switchInlineQuery?(query: string, chatTypes?: string[]): void };

/**
 * `#fr-tg-pick-btn`: hand the payload to Telegram's own contact picker, filtered to people.
 *
 * A client that answers `switchInlineQuery` opens the native "Select a Friend" list; one that does
 * not (or throws) gets the native share sheet instead, with the same link copied to the clipboard
 * so the invite still leaves the app by a door the player recognises.
 */
function pickFriendOnTelegram(): void {
  const payload = friendInvitePayload();
  const url = friendInviteUrl();
  if (!payload || !url) {
    setStatus(t('frTgFailed'), 'warn');
    return;
  }
  impact('light');
  const app = window.Telegram?.WebApp as unknown as InlineSwitcher | undefined;
  const switcher = app?.switchInlineQuery;
  if (typeof switcher === 'function') {
    try {
      switcher.call(app, payload, ['users']);
      setStatus(t('frTgHint'), 'ok');
      return;
    } catch { /* the client declined: the share sheet below is the documented fallback */ }
  }
  void copyText(url);
  openTelegramShare(
    `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(t('frTgText'))}`,
  );
  setStatus(t('frTgHint'), 'ok');
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
  /* The inviter's half is read whenever the sheet comes up: a friend who tapped the link while
     this player was away is simply there, already pinned. Coalesced, so a rail-tap rhythm asks
     the room once. */
  syncLinkedFriends();
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
    const filter = target.closest<HTMLButtonElement>('[data-fr-filter]');
    if (filter) {
      event.preventDefault();
      const next = filter.dataset.frFilter as FriendFilter | undefined;
      if (!next || next === friendFilter) return;
      friendFilter = next;
      impact('light');
      paintFilters();
      paintList();
      return;
    }
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

  /* The Telegram picker rides its own key, below the manual bar: one listener, never part of the
     row delegation, so `+ Add` and this can never be mistaken for one another. */
  $('fr-tg-pick-btn')?.addEventListener('click', (event) => {
    event.preventDefault();
    pickFriendOnTelegram();
  });

  /* A warm launch can hand a NEW `start_param` over without reloading the app, so the friend door
     is re-read on the moments a webview gives focus back. Already-answered payloads return on the
     first line of `acceptFriendInvite`, so this costs one string test per focus. */
  window.addEventListener('focus', () => { void acceptFriendInvite(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void acceptFriendInvite();
  });

  onLang(() => {
    paintCopy();
    paintEntry();
    paintList();
  });

  paintCopy();
  paintEntry();
  paintList();
  /* The boot-time read waits for a SIGNED launch: the SDK script is deferred, so a boot that runs
     before it lands would ask the room as a guest and cache that empty answer for the cooldown.
     The sheet's own open always asks, which covers every other case. */
  if (tgInitData()) syncLinkedFriends();
}
