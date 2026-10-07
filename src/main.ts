import './style.css';
import {
  apply, newGame, reachable, wallOk,
  type Action, type GameState, type Pos, type Wall,
} from './rules';
import { botAction } from './bot';
import { createRenderer, pick, type Vec } from './render';

/* ---------- Telegram (optional) ---------- */

interface TgWebApp {
  ready(): void;
  expand(): void;
  initDataUnsafe?: { user?: { first_name?: string; username?: string } };
  HapticFeedback?: {
    impactOccurred(s: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(t: 'error' | 'success' | 'warning'): void;
  };
  setHeaderColor?(c: string): void;
  setBackgroundColor?(c: string): void;
  disableVerticalSwipes?(): void;
  viewportStableHeight?: number;
  onEvent?(e: string, cb: () => void): void;
}
declare global { interface Window { Telegram?: { WebApp?: TgWebApp } } }

const tg = window.Telegram?.WebApp;
try {
  tg?.ready();
  tg?.expand();
  tg?.disableVerticalSwipes?.();
  tg?.setHeaderColor?.('#e7e6ef');
  tg?.setBackgroundColor?.('#e7e6ef');
} catch { /* running outside Telegram */ }

const setViewport = () => {
  const h = tg?.viewportStableHeight;
  if (h) document.documentElement.style.setProperty('--app-h', `${h}px`);
};
setViewport();
tg?.onEvent?.('viewportChanged', setViewport);

const tap = () => { try { tg?.HapticFeedback?.impactOccurred('light'); } catch { /* ignore */ } };
const notify = (t: 'success' | 'error' | 'warning') => {
  try { tg?.HapticFeedback?.notificationOccurred(t); } catch { /* ignore */ }
};

/* ---------- no zoom / no scroll ---------- */

for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault());
}
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault());

/* ---------- DOM ---------- */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('board');
const wrap = $<HTMLDivElement>('board-wrap');
const statusEl = $<HTMLParagraphElement>('status');
const again = $<HTMLButtonElement>('again');

const user = tg?.initDataUnsafe?.user;
const myName = (user?.first_name || user?.username || `USER${Math.floor(1000 + Math.random() * 9000)}`)
  .toUpperCase().slice(0, 14);
$('name-red').textContent = `▲ ${myName}`;
$('name-blue').textContent = 'BOT';

/* ---------- game ---------- */

const HUMAN = 0 as const;
const BOT = 1 as const;

/** Swap this for a network-backed implementation to go multiplayer. */
interface Opponent { think(s: GameState): Promise<Action> }
const localBot: Opponent = {
  think: (s) => new Promise((res) => setTimeout(() => res(botAction(s)), 650 + Math.random() * 450)),
};
const opponent: Opponent = localBot;

const renderer = createRenderer(canvas);
const toVec = (p: Pos): Vec => ({ x: p.c + 0.5, y: p.r + 0.5 });

let state: GameState = newGame();
let balls: [Vec, Vec] = [toVec(state.pawns[0]), toVec(state.pawns[1])];
let hints: Pos[] = [];
let preview: Wall | null = null;
let gen = 0; // bumps on restart so stale bot replies are dropped

const canAct = () => state.winner === null && state.turn === HUMAN;

function ui() {
  hints = canAct() ? reachable(state, HUMAN) : [];
  if (state.winner !== null) {
    statusEl.textContent = state.winner === HUMAN ? 'You win! 🎉' : 'Opponent wins';
  } else if (state.turn === HUMAN) {
    const n = state.wallsLeft[HUMAN];
    statusEl.textContent = `Your move · ${n} wall${n === 1 ? '' : 's'} left`;
  } else {
    statusEl.textContent = "Opponent's move…";
  }
  again.hidden = state.winner === null;
}

async function runOpponent() {
  if (state.winner !== null || state.turn !== BOT) return;
  const token = ++gen;
  const a = await opponent.think(state);
  if (token !== gen) return;
  if (!play(a)) play({ kind: 'pass' });
}

function play(a: Action): boolean {
  const next = apply(state, a);
  if (!next) return false;
  state = next;
  preview = null;
  ui();
  if (state.winner !== null) notify(state.winner === HUMAN ? 'success' : 'error');
  else if (state.turn === BOT) void runOpponent();
  return true;
}

function restart() {
  gen++;
  state = newGame();
  balls = [toVec(state.pawns[0]), toVec(state.pawns[1])];
  preview = null;
  renderer.resetFx();
  ui();
}

/* ---------- input ---------- */

const local = (e: PointerEvent) => {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!canAct()) return;
  const p = local(e);
  const t = pick(renderer.layout(), p.x, p.y);
  if (!t) return;
  tap();
  if (t.wall) {
    if (!play({ kind: 'wall', wall: { ...t.wall, owner: HUMAN } })) notify('warning');
    return;
  }
  const cell = t.cell;
  if (cell && hints.some((h) => h.c === cell.c && h.r === cell.r)) play({ kind: 'move', to: cell });
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !canAct()) { preview = null; return; }
  const p = local(e);
  const t = pick(renderer.layout(), p.x, p.y);
  const w: Wall | null = t?.wall ? { ...t.wall, owner: HUMAN } : null;
  preview = w && wallOk(state, w) ? w : null;
});
canvas.addEventListener('pointerleave', () => { preview = null; });
again.addEventListener('click', () => { tap(); restart(); });

/* ---------- loop ---------- */

new ResizeObserver(() => renderer.resize()).observe(wrap);
window.addEventListener('resize', () => renderer.resize());
renderer.resize();
ui();

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const k = 1 - Math.exp(-dt * 14); // frame-rate independent lerp
  for (const i of [0, 1] as const) {
    const tx = state.pawns[i].c + 0.5, ty = state.pawns[i].r + 0.5, b = balls[i];
    b.x += (tx - b.x) * k;
    b.y += (ty - b.y) * k;
    if (Math.abs(tx - b.x) < 0.002) b.x = tx;
    if (Math.abs(ty - b.y) < 0.002) b.y = ty;
  }
  renderer.draw({ state, balls, hints, preview }, now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
