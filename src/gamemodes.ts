/**
 * gamemodes.ts — Game Mode Selector: lobby state, bottom sheet wiring, custom rooms.
 *
 * The lobby stays clean (one title + one type badge + Change key). The
 * `#sheet-game-modes` drawer owns the three sections: Quick Play (Online),
 * Play with Friends (Custom Room, viral) and Practice & Offline. Selecting any
 * mode updates the lobby instantly, persists to the device and closes the sheet.
 *
 * Rooms are local-first: Create mints a 4-digit code and reveals a 1-tap
 * "Invite via Telegram" deep-link (`t.me/<bot>?start=room_XXXX`). Join validates
 * a 4-digit code. Online races still start as local bot races with matching
 * sizes until netplay lands — the lobby is the contract, the starter is a stub.
 */
import { readJson, writeJson } from './storage';
import { saveMenu } from './settings';
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
      return { id: sel.id, title: '1v1 Duel', badge: 'DUEL / RANKED', icon: '#i-swords', sub: '1v1 · Ranked · ~5s' };
    case 'party_2v2':
      return { id: sel.id, title: '2v2 Party', badge: 'TEAM / RANKED', icon: '#i-users', sub: '2v2 · Ranked · ~8s' };
    case 'bot':
      return { id: sel.id, title: 'vs Bot', badge: 'PRACTICE / OFFLINE', icon: '#i-bot', sub: 'Training · Zero trophy loss' };
    case 'room':
      return {
        id: sel.id,
        title: sel.roomCode ? `Room ${sel.roomCode}` : 'Custom Room',
        badge: 'FRIENDS / PRIVATE',
        icon: '#i-send',
        sub: sel.roomCode ? `Private · ${sel.roomCode} · Friends only` : 'Private room · Friends only',
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
  const text = encodeURIComponent(`Join my Detour room ${code} — 1 tap to race!`);
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
    /* webview blocked — the link text itself is still copyable */
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
  if (play) play.setAttribute('aria-label', `Play ${lobby.title} — ${lobby.badge}`);
}

export function paintSheetState(): void {
  const cards = [...document.querySelectorAll<HTMLButtonElement>('.gm-card[data-gmode]')];
  for (const c of cards) {
    const raw = c.dataset.gmode;
    const on = isGameModeId(raw) && raw === current.id;
    c.classList.toggle('is-active', on);
    c.setAttribute('aria-checked', String(on));
  }
  const room = document.querySelector('.gm-room');
  if (room) room.classList.toggle('is-active', current.id === 'room');
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

export function initGameModes(sheets: Sheets): void {
  paintLobby();
  paintSheetState();

  for (const card of document.querySelectorAll<HTMLButtonElement>('.gm-card[data-gmode]')) {
    card.addEventListener('click', () => {
      const raw = card.dataset.gmode;
      if (!isGameModeId(raw)) return;
      // Room is configured via Create/Join below — tapping the practice/quick
      // cards is the instant path: persist, repaint the lobby, close the sheet.
      if (raw === 'room') return;
      impact('light');
      clearRoomError();
      setGameMode(raw);
      notify('success');
      sheets.close();
    });
  }

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
    const joinInput = document.getElementById('gm-join-input') as HTMLInputElement | null;
    if (joinInput && sel.roomCode) joinInput.value = sel.roomCode;
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
    const input = document.getElementById('gm-join-input') as HTMLInputElement | null;
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
    sheets.close();
  };

  document.getElementById('gm-join')?.addEventListener('click', doJoin);
  document.getElementById('gm-join-input')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    doJoin();
  });
  document.getElementById('gm-join-input')?.addEventListener('input', () => {
    clearRoomError();
    const input = document.getElementById('gm-join-input') as HTMLInputElement | null;
    if (input) input.value = input.value.replace(/\D/g, '').slice(0, 4);
  });

  onGameModeChange(() => {
    paintLobby();
    paintSheetState();
  });
}
