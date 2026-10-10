/**
 * gamemodes.ts â€” Game Mode Selector: lobby state, bottom sheet wiring, custom rooms.
 *
 * The lobby stays clean (one title + one type badge + Change key). The
 * `#sheet-game-modes` drawer holds exactly three rows â€” Quick match, Play with
 * friends and Practice vs Bot â€” plus one reward caption and one sticky Start.
 * Selecting a mode updates the lobby instantly and persists to the device; the
 * row that is open shows its options in place (1v1/2v2 or Easy/Normal/Hard).
 * The room UI lives on its own sub-screen behind a back arrow, never in the list.
 *
 * Rooms are local-first: Create mints a 4-digit code and reveals a 1-tap
 * "Invite via Telegram" deep-link (`t.me/<bot>?start=room_XXXX`). Join validates
 * a 4-digit code. Online races still start as local bot races with matching
 * sizes until netplay lands â€” the lobby is the contract, the starter is a stub.
 */
import { readJson, writeJson } from './storage';
import { menuState, saveMenu } from './settings';
import { impact, notify } from './telegram';
import type { Sheets } from './sheets';

export type GameModeId = 'duel_1v1' | 'party_2v2' | 'bot' | 'room';

export interface GameModeSelection {
  id: GameModeId;
  roomCode: string | null;
}

export interface LobbyDisplay {
  id: GameModeId;
  title: string;
  badge: string;
  icon: string;
  sub: string;
}

const KEY = 'detour.gamemode.v1';
const BOT_HANDLE = 'detour_game_bot';

const DEFAULT_SELECTION: GameModeSelection = { id: 'party_2v2', roomCode: null };

/* ---- what the sheet renders: the DOM stays declarative, the labels live here ---- */

type QuickId = 'duel_1v1' | 'party_2v2';
/** The three rows: `online` owns both quick sizes, `room` owns the sub-screen. */
type RowId = 'online' | 'room' | 'bot';
/** Which pane of the drawer is showing. */
type SheetView = 'modes' | 'room';

const ROW_OF: Record<GameModeId, RowId> = {
  duel_1v1: 'online',
  party_2v2: 'online',
  room: 'room',
  bot: 'bot',
};

/** Estimated matchmaking wait, shown beside the size segment. */
const WAIT: Record<QuickId, string> = { duel_1v1: '~5s', party_2v2: '~8s' };

const START_LABEL: Record<GameModeId, string> = {
  duel_1v1: 'Start 1v1 match',
  party_2v2: 'Start 2v2 match',
  bot: 'Start practice match',
  room: 'Start private match',
};

interface RewardLine {
  lead: string;
  /** `null` when the mode pays no trophies â€” practice has no ranking to lose. */
  trophy: string | null;
  coin: string;
}

const REWARD: Record<GameModeId, RewardLine> = {
  duel_1v1: { lead: 'Win', trophy: '+30', coin: '+65' },
  party_2v2: { lead: 'Win', trophy: '+50', coin: '+100' },
  bot: { lead: 'Practice', trophy: null, coin: '+65' },
  room: { lead: 'Win', trophy: '+30', coin: '+65' },
};

const isQuick = (id: GameModeId): id is QuickId => id === 'duel_1v1' || id === 'party_2v2';

function isGameModeId(v: unknown): v is GameModeId {
  return v === 'duel_1v1' || v === 'party_2v2' || v === 'bot' || v === 'room';
}

function cleanRoomCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const digits = v.replace(/\D/g, '').slice(0, 4);
  return /^\d{4}$/.test(digits) ? digits : null;
}

function load(): GameModeSelection {
  try {
    const raw = readJson<GameModeSelection>(KEY);
    if (!raw || !isGameModeId(raw.id)) return { ...DEFAULT_SELECTION };
    const roomCode = raw.id === 'room' ? cleanRoomCode(raw.roomCode) : null;
    return { id: raw.id, roomCode };
  } catch {
    return { ...DEFAULT_SELECTION };
  }
}

let current: GameModeSelection = load();
/** The drawer opens on the list every time; the friends pane is a step away. */
let view: SheetView = 'modes';

const watchers: Array<() => void> = [];

function persist(): void {
  try {
    writeJson(KEY, current);
  } catch {
    /* stay in memory */
  }
  for (const w of [...watchers]) {
    try {
      w();
    } catch {
      /* watcher threw */
    }
  }
}

export function onGameModeChange(w: () => void): () => void {
  watchers.push(w);
  return () => {
    const i = watchers.indexOf(w);
    if (i >= 0) watchers.splice(i, 1);
  };
}

export function getGameMode(): GameModeSelection {
  return { ...current };
}

/** Sizes the local race starter uses until online play arrives. */
export function sizesForMode(id: GameModeId): [number, number] {
  if (id === 'party_2v2') return [2, 2];
  return [1, 1];
}

export function setGameMode(id: GameModeId, opts?: { roomCode?: string | null }): GameModeSelection {
  const roomCode = id === 'room' ? cleanRoomCode(opts?.roomCode ?? current.roomCode) : null;
  current = { id, roomCode };
  try {
    saveMenu({ mode: 'bot', sizes: sizesForMode(id) });
  } catch {
    /* stay in memory */
  }
  persist();
  paintLobby();
  paintSheetState();
  return getGameMode();
}

export function getLobbyDisplay(sel: GameModeSelection = current): LobbyDisplay {
  switch (sel.id) {
    case 'duel_1v1':
      return { id: sel.id, title: '1v1 Duel', badge: 'DUEL / RANKED', icon: '#i-swords', sub: '1v1 Â· Ranked Â· ~5s' };
    case 'party_2v2':
      return { id: sel.id, title: '2v2 Party', badge: 'TEAM / RANKED', icon: '#i-users', sub: '2v2 Â· Ranked Â· ~8s' };
    case 'bot':
      return { id: sel.id, title: 'vs Bot', badge: 'PRACTICE / OFFLINE', icon: '#i-bot', sub: 'Training Â· Zero trophy loss' };
    case 'room':
      return {
        id: sel.id,
        title: sel.roomCode ? `Room ${sel.roomCode}` : 'Custom Room',
        badge: 'FRIENDS / PRIVATE',
        icon: '#i-send',
        sub: sel.roomCode ? `Private Â· ${sel.roomCode} Â· Friends only` : 'Private room Â· Friends only',
      };
  }
}

/* ---------- rooms ---------- */

export function createRoomCode(): string {
  const n = 1000 + Math.floor(Math.random() * 9000);
  return String(n);
}

/** Mint a fresh room, select it and reveal the invite block. */
export function createRoom(): GameModeSelection {
  const code = createRoomCode();
  return setGameMode('room', { roomCode: code });
}

export function joinRoomCode(raw: string): { ok: true; code: string } | { ok: false; error: string } {
  const code = cleanRoomCode(raw);
  if (!code) return { ok: false, error: 'Enter the 4-digit room code.' };
  setGameMode('room', { roomCode: code });
  return { ok: true, code };
}

/** Display form: `t.me/bot?start=room_XXXX` shape (uses the app bot handle). */
export function buildInviteDisplay(code: string): string {
  return `t.me/${BOT_HANDLE}?start=room_${code}`;
}

/** Full URL the Invite button opens / shares. */
export function buildInviteLink(code: string): string {
  return `https://t.me/${BOT_HANDLE}?start=room_${code}`;
}

export function buildShareUrl(code: string): string {
  const url = encodeURIComponent(buildInviteLink(code));
  const text = encodeURIComponent(`Join my Detour room ${code} â€” 1 tap to race!`);
  return `https://t.me/share/url?url=${url}&text=${text}`;
}

function openInvite(code: string): void {
  const href = buildInviteLink(code);
  try {
    const w = window as unknown as {
      Telegram?: { WebApp?: { openTelegramLink?: (u: string) => void; openLink?: (u: string) => void } };
    };
    const tg = w.Telegram?.WebApp;
    if (tg?.openTelegramLink) {
      tg.openTelegramLink(href);
      return;
    }
    if (tg?.openLink) {
      tg.openLink(buildShareUrl(code));
      return;
    }
  } catch {
    /* fall through to window.open */
  }
  try {
    window.open(buildShareUrl(code), '_blank', 'noopener');
  } catch {
    /* webview blocked â€” the link text itself is still copyable */
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
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
}

/* ---------- lobby + sheet painting (same IDs home.ts owns) ---------- */

export function paintLobby(): void {
  const lobby = getLobbyDisplay();
  const titleEl = document.getElementById('home-play-title');
  if (titleEl) titleEl.textContent = lobby.title;
  const badgeEl = document.getElementById('home-play-diff');
  if (badgeEl) {
    badgeEl.textContent = lobby.badge;
    badgeEl.setAttribute('data-gmode', lobby.id);
    badgeEl.removeAttribute('data-diff');
  }
  const useEl = document.getElementById('mode-hero-use') as unknown as SVGUseElement | null;
  if (useEl) useEl.setAttribute('href', lobby.icon);
  const subEl = document.getElementById('home-play-sub');
  if (subEl) subEl.textContent = lobby.sub;
  const play = document.getElementById('home-play') as HTMLButtonElement | null;
  if (play) play.setAttribute('aria-label', `Play ${lobby.title} â€” ${lobby.badge}`);
}

/** Swap the drawer between the mode list and the friends sub-screen. */
function showView(next: SheetView): void {
  view = next;
  const modes = document.getElementById('gm-view-modes');
  if (modes) modes.hidden = next !== 'modes';
  const room = document.getElementById('gm-view-room');
  if (room) room.hidden = next !== 'room';
  const back = document.getElementById('gm-back');
  if (back) back.hidden = next !== 'room';
  const title = document.getElementById('gm-title');
  if (title) title.textContent = next === 'room' ? 'Play with friends' : 'Select Game Mode';
  const sub = document.getElementById('gm-sub');
  if (sub) sub.textContent = next === 'room' ? 'Create a room or join with a code' : 'Pick how you want to race';
  const body = document.querySelector<HTMLElement>('.gm-body');
  if (body) body.scrollTop = 0;
}

/** The drawer always opens on the three rows, never on a pane left behind. */
export function resetSheetView(): void {
  showView('modes');
}

/**
 * One step of back: the friends pane returns to the list before the drawer
 * closes. Returns false when there is nothing left to unwind here.
 */
export function gmBack(): boolean {
  const sheet = document.getElementById('sheet-game-modes');
  if (view !== 'room' || !sheet || sheet.hidden) return false;
  showView('modes');
  return true;
}

export function paintSheetState(): void {
  const row = ROW_OF[current.id];

  for (const card of document.querySelectorAll<HTMLElement>('.gm-card[data-row]')) {
    const on = card.dataset.row === row;
    card.classList.toggle('is-active', on);
    card.querySelector<HTMLElement>('.gm-pick')?.setAttribute('aria-checked', String(on));
    /* the options for a mode only exist while that mode is the selected one */
    const seg = card.querySelector<HTMLElement>('.gm-seg');
    if (seg) seg.hidden = !on;
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>('#sheet-game-modes [data-size]')) {
    b.setAttribute('aria-pressed', String(b.dataset.size === current.id));
  }
  const wait = document.getElementById('gm-wait');
  if (wait && isQuick(current.id)) wait.textContent = WAIT[current.id];

  for (const b of document.querySelectorAll<HTMLButtonElement>('#sheet-game-modes [data-diff]')) {
    b.setAttribute('aria-pressed', String(b.dataset.diff === menuState.difficulty));
  }

  /* one reward caption above Start, one Start label that names the mode */
  const reward = REWARD[current.id];
  const lead = document.getElementById('gm-lead');
  if (lead) lead.textContent = reward.lead;
  const trophy = document.getElementById('gm-rw-trophy');
  const trophyN = document.getElementById('gm-rw-trophy-n');
  if (trophy) {
    trophy.hidden = reward.trophy === null;
    if (reward.trophy) {
      if (trophyN) trophyN.textContent = reward.trophy;
      trophy.setAttribute('aria-label', `${reward.trophy.replace('+', '')} trophies`);
    }
  }
  const coinN = document.getElementById('gm-rw-coin-n');
  if (coinN) {
    coinN.textContent = reward.coin;
    coinN.closest('.gm-rw')?.setAttribute('aria-label', `${reward.coin.replace('+', '')} coins`);
  }
  const start = document.getElementById('gm-start');
  if (start) start.textContent = START_LABEL[current.id];

  const invite = document.getElementById('gm-invite');
  const codeEl = document.getElementById('gm-code');
  const linkEl = document.getElementById('gm-link');
  const inviteBtn = document.getElementById('gm-invite-btn') as HTMLAnchorElement | null;
  if (current.id === 'room' && current.roomCode) {
    if (invite) invite.hidden = false;
    if (codeEl) codeEl.textContent = current.roomCode;
    if (linkEl) linkEl.textContent = buildInviteDisplay(current.roomCode);
    if (inviteBtn) inviteBtn.href = buildShareUrl(current.roomCode);
  }
}

function showRoomError(msg: string): void {
  const el = document.getElementById('gm-err');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  notify('warning');
}

function clearRoomError(): void {
  const el = document.getElementById('gm-err');
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
}

/* ---------- wiring ---------- */

export interface GameModeInit {
  /** Starts a race with the sizes + difficulty the drawer just persisted. */
  onStart?: () => void;
}

export function initGameModes(sheets: Sheets, init?: GameModeInit): void {
  paintLobby();
  paintSheetState();
  showView('modes');

  /* rows: quick + practice select in place, friends open their own sub-screen */
  for (const pick of document.querySelectorAll<HTMLButtonElement>('.gm-pick[data-gmode]')) {
    pick.addEventListener('click', () => {
      const raw = pick.dataset.gmode;
      if (!isGameModeId(raw)) return;
      impact('light');
      if (raw === 'room') { showView('room'); return; }
      clearRoomError();
      setGameMode(raw);
    });
  }

  document.getElementById('gm-back')?.addEventListener('click', () => {
    impact('light');
    showView('modes');
  });

  /* in-row options: the size for Quick match, the level for Practice vs Bot */
  for (const b of document.querySelectorAll<HTMLButtonElement>('#sheet-game-modes [data-size]')) {
    b.addEventListener('click', () => {
      const raw = b.dataset.size;
      if (!isGameModeId(raw) || raw === 'room') return;
      impact('light');
      if (raw === current.id) return;
      clearRoomError();
      setGameMode(raw);
    });
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>('#sheet-game-modes [data-diff]')) {
    b.addEventListener('click', () => {
      const d = b.dataset.diff;
      if (d !== 'easy' && d !== 'normal' && d !== 'hard') return;
      impact('light');
      try {
        saveMenu({ difficulty: d });
      } catch {
        /* stay in memory */
      }
      paintSheetState();
    });
  }

  const joinInput = document.getElementById('gm-join-input') as HTMLInputElement | null;
  const joinBtn = document.getElementById('gm-join') as HTMLButtonElement | null;
  /** Join only lights up once the field holds a full 4-digit code. */
  const syncJoin = (): void => {
    if (!joinBtn) return;
    joinBtn.disabled = (joinInput?.value ?? '').replace(/\D/g, '').length !== 4;
  };
  syncJoin();

  document.getElementById('gm-create')?.addEventListener('click', () => {
    impact('medium');
    clearRoomError();
    const sel = createRoom();
    notify('success');
    // Stay open so the 1-tap invite is reachable; the lobby already shows Room XXXX.
    const codeEl = document.getElementById('gm-code');
    if (codeEl && sel.roomCode) codeEl.textContent = sel.roomCode;
    const linkEl = document.getElementById('gm-link');
    if (linkEl && sel.roomCode) linkEl.textContent = buildInviteDisplay(sel.roomCode);
    const invite = document.getElementById('gm-invite');
    if (invite) invite.hidden = false;
    const inviteBtn = document.getElementById('gm-invite-btn') as HTMLAnchorElement | null;
    if (inviteBtn && sel.roomCode) inviteBtn.href = buildShareUrl(sel.roomCode);
    if (joinInput && sel.roomCode) joinInput.value = sel.roomCode;
    syncJoin();
  });

  document.getElementById('gm-invite-btn')?.addEventListener('click', (e) => {
    const code = getGameMode().roomCode;
    if (!code) return;
    // Let the anchor href work outside Telegram; inside, open via the client.
    try {
      const w = window as unknown as { Telegram?: { WebApp?: object } };
      if (w.Telegram?.WebApp) {
        e.preventDefault();
        impact('light');
        openInvite(code);
      }
    } catch {
      /* default anchor navigation */
    }
  });

  document.getElementById('gm-copy')?.addEventListener('click', async () => {
    const code = getGameMode().roomCode;
    if (!code) return;
    impact('light');
    const ok = await copyText(buildInviteLink(code));
    notify(ok ? 'success' : 'warning');
    const btn = document.getElementById('gm-copy');
    if (btn && ok) {
      const prev = btn.textContent;
      btn.textContent = 'Copied';
      window.setTimeout(() => {
        if (btn.textContent === 'Copied') btn.textContent = prev;
      }, 1200);
    }
  });

  const doJoin = (): void => {
    const input = joinInput;
    if (!input) return;
    const res = joinRoomCode(input.value);
    if (!res.ok) {
      impact('light');
      const r = res as { ok: false; error: string };
      showRoomError(r.error);
      input.focus({ preventScroll: true });
      return;
    }
    impact('medium');
    clearRoomError();
    notify('success');
    /* the room is selected now: land on the list so Start reads "private match" */
    showView('modes');
  };

  document.getElementById('gm-join')?.addEventListener('click', doJoin);
  joinInput?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    doJoin();
  });
  joinInput?.addEventListener('input', () => {
    clearRoomError();
    if (joinInput) joinInput.value = joinInput.value.replace(/\D/g, '').slice(0, 4);
    syncJoin();
  });

  /* the sticky Start: persist the row as the race to run, then run it */
  document.getElementById('gm-start')?.addEventListener('click', () => {
    impact('light');
    notify('success');
    try {
      saveMenu({ mode: 'bot', sizes: sizesForMode(current.id) });
    } catch {
      /* stay in memory */
    }
    sheets.close();
    init?.onStart?.();
  });

  onGameModeChange(() => {
    paintLobby();
    paintSheetState();
  });
}
