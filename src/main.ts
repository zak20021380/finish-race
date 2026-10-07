import './style.css';
import {
  COLS, WALLS_PER_PLAYER, apply, distField, newGame, reachable, wallOk,
  type Action, type GameState, type Player, type Pos, type Wall, type WallSpec,
} from './rules';
import { botAction } from './bot';
import { createRenderer, hitTest, type Ghost, type Mark, type Vec, type View } from './render';
import { createConfetti } from './confetti';

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

const impact = (s: 'light' | 'medium') => { try { tg?.HapticFeedback?.impactOccurred(s); } catch { /* ignore */ } };
const notify = (t: 'success' | 'error' | 'warning') => {
  try { tg?.HapticFeedback?.notificationOccurred(t); } catch { /* ignore */ }
};

const reduced = matchMedia('(prefers-reduced-motion: reduce)');

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
const statusText = $<HTMLSpanElement>('status-text');
const dots = $<HTMLSpanElement>('dots');
const overlay = $<HTMLDivElement>('overlay');
const verdict = $<HTMLParagraphElement>('verdict');
const sub = $<HTMLParagraphElement>('sub');
const again = $<HTMLButtonElement>('again');
const noteEl = $<HTMLParagraphElement>('note');
const hintEl = $<HTMLDivElement>('hint');
const confettiEl = $<HTMLCanvasElement>('confetti');
const chips = [$<HTMLDivElement>('chip-0'), $<HTMLDivElement>('chip-1')];
const pips = [$<HTMLSpanElement>('pips-0'), $<HTMLSpanElement>('pips-1')];

const user = tg?.initDataUnsafe?.user;
$('name-0').textContent = (user?.first_name || user?.username || 'YOU').toUpperCase().slice(0, 14);
$('name-1').textContent = 'BOT';

const PLAYERS: Player[] = [0, 1];
for (const box of pips) {
  for (let i = 0; i < WALLS_PER_PLAYER; i++) box.appendChild(document.createElement('i'));
}

/* floating message over the board: why a slot was refused, or "tap again to place" */
let noteTimer = 0;
function showNote(msg: string, error: boolean, ttl: number) {
  noteEl.textContent = msg;
  noteEl.classList.toggle('error', error);
  noteEl.classList.add('show');
  clearTimeout(noteTimer);
  if (ttl) noteTimer = setTimeout(() => noteEl.classList.remove('show'), ttl);
}
const clearNote = () => { clearTimeout(noteTimer); noteEl.classList.remove('show'); };

/* ---------- game ---------- */

const HUMAN = 0 as const;
const BOT = 1 as const;

/** Swap this for a network-backed implementation to go multiplayer. */
interface Opponent { think(s: GameState): Promise<Action> }
const localBot: Opponent = {
  think: (s) => new Promise((res) => setTimeout(() => res(botAction(s)), 650 + Math.random() * 450)),
};
const opponent: Opponent = localBot;

const REASON = { overlap: 'Overlaps a wall', blocked: 'Blocks the path' };

/**
 * Why a slot was refused. `wallOk` only answers yes/no, so the reason is re-derived here
 * (rules.ts stays untouched): an overlap on the same line, or a sealed path.
 */
function wallIssue(s: GameState, w: Wall): keyof typeof REASON {
  const clash = s.walls.some((o) => o.o === w.o
    && (w.o === 'h' ? o.y === w.y && Math.abs(o.x - w.x) < 2 : o.x === w.x && Math.abs(o.y - w.y) < 2));
  if (clash) return 'overlap';
  const d = distField([...s.walls, w]);
  return s.pawns.some((p) => d[p.r * COLS + p.c] < 0) ? 'blocked' : 'overlap';
}

const renderer = createRenderer(canvas);
const confetti = createConfetti(confettiEl);
const toVec = (p: Pos): Vec => ({ x: p.c + 0.5, y: p.r + 0.5 });

let state: GameState = newGame();
let balls: [Vec, Vec] = [toVec(state.pawns[0]), toVec(state.pawns[1])];
let hints: Pos[] = [];
let ghost: Ghost | null = null;                 // wall preview; armed = waiting for a confirm tap
const marks: [Mark | null, Mark | null] = [null, null];
/** Reused every frame: the loop must not allocate. */
const view: View = { state, balls, hints, ghost, last: marks, thinking: false };
let gen = 0; // bumps on restart so stale bot replies are dropped

const canAct = () => state.winner === null && state.turn === HUMAN;
const clearGhost = () => { ghost = null; clearNote(); };

/* one-time hint: lives in memory only, this app never persists anything */
let hintClosed = false;
let hintTimer = 0;
function closeHint() { hintClosed = true; clearTimeout(hintTimer); hintEl.hidden = true; }
function maybeShowHint() {
  if (hintClosed || !canAct() || state.wallsLeft[HUMAN] === 0 || !hintEl.hidden) return;
  hintEl.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(closeHint, 12000);
}

let overlayOpen = false;
function showOverlay() {
  if (overlayOpen) return;
  overlayOpen = true;
  const won = state.winner === HUMAN;
  const spare = state.wallsLeft[HUMAN];
  overlay.classList.toggle('win', won);
  overlay.classList.toggle('lose', !won);
  verdict.textContent = won ? 'You win!' : 'Bot wins';
  sub.textContent = won
    ? `You crossed the line first with ${spare} wall${spare === 1 ? '' : 's'} unused.`
    : `The bot reached FINISH first. You still had ${spare} wall${spare === 1 ? '' : 's'} in hand.`;
  overlay.hidden = false;
  if (won && !reduced.matches) confetti.burst();
  again.focus({ preventScroll: true });
}

function ui() {
  hints = canAct() ? reachable(state, HUMAN) : [];
  const thinking = state.winner === null && state.turn === BOT;

  if (state.winner !== null) {
    statusText.textContent = state.winner === HUMAN ? 'You win!' : 'Opponent wins';
  } else if (state.turn === HUMAN) {
    const n = state.wallsLeft[HUMAN];
    statusText.textContent = `Your move · ${n} wall${n === 1 ? '' : 's'} left`;
  } else {
    statusText.textContent = 'Opponent is thinking';
  }
  dots.classList.toggle('on', thinking);

  for (const p of PLAYERS) {
    chips[p].classList.toggle('active', state.winner === null && state.turn === p);
    chips[p].classList.toggle('thinking', thinking && p === BOT);
    const kids = pips[p].children;
    for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('off', i >= state.wallsLeft[p]);
  }

  if (state.winner === null && overlayOpen) { overlayOpen = false; overlay.hidden = true; }
  if (state.winner !== null) showOverlay();
  maybeShowHint();
}

async function runOpponent() {
  if (state.winner !== null || state.turn !== BOT) return;
  const token = ++gen;
  const a = await opponent.think(state);
  if (token !== gen) return;
  if (!play(a)) play({ kind: 'pass' });
}

function play(a: Action): boolean {
  const by = state.turn;
  const next = apply(state, a);
  if (!next) return false;
  if (a.kind === 'move') marks[by] = { kind: 'step', from: state.pawns[by], to: a.to };
  else if (a.kind === 'wall') { marks[by] = { kind: 'wall', spec: a.wall }; impact('medium'); }
  state = next;
  ghost = null;
  clearNote();
  ui();
  if (state.winner !== null) notify(state.winner === HUMAN ? 'success' : 'error');
  else if (state.turn === BOT) void runOpponent();
  return true;
}

function restart() {
  gen++;
  state = newGame();
  balls = [toVec(state.pawns[0]), toVec(state.pawns[1])];
  ghost = null;
  marks[0] = null; marks[1] = null;
  overlayOpen = false;
  overlay.hidden = true;
  clearNote();
  confetti.stop();
  renderer.resetFx();
  ui();
}

/* ---------- input ---------- */

const local = (e: PointerEvent) => {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};

function refuse(w: Wall) {
  const why = wallIssue(state, w);
  showNote(REASON[why], true, 2200);
  notify('warning');
}

/** Touch: tap a grid line to arm a ghost, tap the ghost again to place it. */
function onTouch(p: Vec) {
  const hit = hitTest(renderer.layout(), p.x, p.y, {
    hints,
    walls: state.wallsLeft[HUMAN] > 0,
    armed: ghost?.armed ? ghost.spec : null,
  });
  if (!hit) { clearGhost(); return; }

  if (hit.kind === 'move') { impact('light'); play({ kind: 'move', to: hit.to }); return; }

  const spec = hit.spec;
  const wall: Wall = { ...spec, owner: HUMAN };
  if (hit.kind === 'confirm') {
    if (!wallOk(state, wall)) { refuse(wall); return; }
    play({ kind: 'wall', wall });
    return;
  }
  const ok = wallOk(state, wall);
  ghost = { spec, ok, armed: true };
  closeHint();
  if (ok) { impact('light'); showNote('Tap again to place', false, 0); } else refuse(wall);
}

/** Mouse: hover previews, one click commits. */
function onMouse(p: Vec, click: boolean) {
  if (!canAct()) { ghost = null; return; }
  const hit = hitTest(renderer.layout(), p.x, p.y, {
    hints,
    walls: state.wallsLeft[HUMAN] > 0,
    armed: null,
  });
  const spec: WallSpec | null = hit && hit.kind !== 'move' ? hit.spec : null;
  const wall: Wall | null = spec ? { ...spec, owner: HUMAN } : null;
  const ok = wall ? wallOk(state, wall) : false;
  ghost = wall ? { spec: wall, ok, armed: false } : null;

  if (!click) return;
  if (hit?.kind === 'move') { impact('light'); play({ kind: 'move', to: hit.to }); return; }
  if (wall && ok) { closeHint(); play({ kind: 'wall', wall }); return; }
  if (wall) refuse(wall);
  else clearGhost();
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!canAct()) return;
  const p = local(e);
  if (e.pointerType === 'mouse') onMouse(p, true);
  else onTouch(p);
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  onMouse(local(e), false);
});
canvas.addEventListener('pointerleave', () => { if (ghost && !ghost.armed) ghost = null; });
hintEl.addEventListener('click', () => { impact('light'); closeHint(); });
again.addEventListener('click', () => { impact('light'); restart(); });

/* ---------- loop ---------- */

new ResizeObserver(() => { renderer.resize(); confetti.resize(); }).observe(wrap);
window.addEventListener('resize', () => { renderer.resize(); confetti.resize(); });
renderer.resize();
confetti.resize();
ui();

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const k = reduced.matches ? 1 : 1 - Math.exp(-dt * 14); // frame-rate independent lerp
  for (let i = 0; i < 2; i++) {
    const tx = state.pawns[i].c + 0.5, ty = state.pawns[i].r + 0.5, b = balls[i];
    b.x += (tx - b.x) * k;
    b.y += (ty - b.y) * k;
    if (Math.abs(tx - b.x) < 0.002) b.x = tx;
    if (Math.abs(ty - b.y) < 0.002) b.y = ty;
  }
  view.state = state;
  view.balls = balls;
  view.hints = hints;
  view.ghost = ghost;
  view.thinking = state.turn === BOT && state.winner === null;
  renderer.draw(view, now);
  confetti.tick(dt, now);
  raf = requestAnimationFrame(frame);
}

/* The webview keeps a hidden Mini App running: stop burning frames when nobody can see it. */
let raf = 0;
const resume = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };
const pause = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else resume(); });

resume();
