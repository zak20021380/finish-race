import './style.css';
import {
  COLS, apply, distField, newGame, pathLen, reachable, wallOk,
  type Action, type GameState, type Player, type Pos, type Wall, type WallSpec,
} from './rules';
import { botAction, botThinkMs, type Difficulty } from './bot';
import { createRenderer, hitTest, type Ghost, type Mark, type Vec, type View } from './render';
import { createConfetti } from './confetti';
import { createRouter } from './router';
import { createSheets } from './sheets';
import { createMenu, type Menu } from './menu';
import { menuState, motionReduced, type Mode } from './settings';
import { impact, initTelegram, notify, onBackPress, tgUser } from './telegram';

initTelegram();

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
const toMenu = $<HTMLButtonElement>('to-menu');
const noteEl = $<HTMLParagraphElement>('note');
const hintEl = $<HTMLDivElement>('hint');
const confettiEl = $<HTMLCanvasElement>('confetti');
const menuBtn = $<HTMLButtonElement>('menu-btn');
const modeLabel = $<HTMLElement>('mode-label');
const chips = [$<HTMLDivElement>('chip-0'), $<HTMLDivElement>('chip-1')];
const steps = [$<HTMLSpanElement>('steps-0'), $<HTMLSpanElement>('steps-1')];
const sheetPause = $<HTMLElement>('sheet-pause');
const sheetQuit = $<HTMLElement>('sheet-quit');

/* steps-to-FINISH readout on each chip: repaints only when the number changes */
const shownSteps: [number, number] = [-1, -1];
function setSteps(p: Player, d: number) {
  if (shownSteps[p] === d) return;
  shownSteps[p] = d;
  const el = steps[p];
  el.textContent = Number.isFinite(d) ? `${d} step${d === 1 ? '' : 's'}` : 'no path';
  el.classList.remove('pop');
  void el.offsetWidth;   // restarting the animation needs a reflow between the two class changes
  el.classList.add('pop');
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

/* ---------- screens ---------- */

let menu: Menu;
const sheets = createSheets($('scrim'));
const sheetById = (id: string) => document.getElementById(id);

const router = createRouter($('screens'), (id) => {
  menu.setRoute(id);
  setBackButton(id !== 'home' && router.canGoBack);
  if (id !== 'game') pauseGame();     // the board only ticks while it is on screen
  syncLoop();
});

/** Telegram's BackButton, when the client has one, and the in-page back buttons both land here. */
const setBackButton = onBackPress(() => onBack());

function onBack() {
  if (sheets.isOpen) { sheets.close(); return; }
  if (router.current === 'game') {
    if (state.winner !== null) { quitToMenu(); return; }
    pauseGame();
    sheets.open(sheetPause);
    ui();
    return;
  }
  router.back();
}

/* ---------- game ---------- */

const HUMAN = 0 as const;
const BOT = 1 as const;
const PLAYERS: Player[] = [0, 1];

/** Swap this for a network-backed implementation to go multiplayer. */
interface Opponent { think(s: GameState): Promise<Action> }
const makeBot = (d: Difficulty): Opponent => ({
  think: (s) => new Promise((res) => setTimeout(() => res(botAction(s, d)), botThinkMs(d))),
});

let mode: Mode = menuState.mode === 'local' ? 'local' : 'bot';
let difficulty: Difficulty = menuState.difficulty;
let opponent: Opponent = makeBot(difficulty);

/** Pass & Play hands both seats to humans, so the opponent is simply never asked. */
const isHuman = (p: Player) => mode === 'local' || p === HUMAN;
const wantsOpponent = () => mode === 'bot' && state.turn === BOT && state.winner === null;

const REASON = { overlap: 'Overlaps a wall', blocked: 'Blocks the path' };

/**
 * Why a slot was refused: an overlap on the same line, or a sealed path. `wallOk` only answers
 * yes/no, so the reason stays a UI-layer concern.
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
let paused = false;
const waiting: (() => void)[] = [];            // bot thinks parked by the pause sheet

/* session-only results, shown on the home and profile cards */
let streak = 0;
let wins = 0;

const canAct = () => state.winner === null && isHuman(state.turn) && !paused;
const clearGhost = () => { ghost = null; clearNote(); };

/* one-time hint: lives in memory only, this app never persists game state */
let hintClosed = false;
let hintTimer = 0;
function closeHint() { hintClosed = true; clearTimeout(hintTimer); hintEl.hidden = true; }
function maybeShowHint() {
  if (hintClosed || !canAct() || !hintEl.hidden) return;
  hintEl.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(closeHint, 12000);
}

let overlayOpen = false;
function showOverlay() {
  if (overlayOpen) return;
  overlayOpen = true;
  const won = state.winner === HUMAN;
  const built = state.walls.length;
  const wallsNote = built ? ` ${built} wall${built === 1 ? '' : 's'} went up along the way.` : '';
  overlay.classList.toggle('win', won);
  overlay.classList.toggle('lose', !won);
  if (mode === 'local') {
    verdict.textContent = won ? 'Red wins!' : 'Blue wins!';
    sub.textContent = (won ? 'Red' : 'Blue') + ' crossed the line first.' + wallsNote;
  } else {
    verdict.textContent = won ? 'You win!' : 'Bot wins';
    sub.textContent = (won ? 'You crossed the line first.' : 'The bot reached FINISH first.') + wallsNote;
  }
  overlay.hidden = false;
  if ((mode === 'local' || won) && !motionReduced()) confetti.burst();
  if (mode === 'bot') {
    if (won) { streak++; wins++; } else streak = 0;
    menu.setStats({ streak, wins });
  }
  menuBtn.disabled = true;              // the panel already offers Play again and Menu
  again.focus({ preventScroll: true });
}

function ui() {
  hints = canAct() ? reachable(state, state.turn) : [];
  const thinking = wantsOpponent() && !paused;

  if (state.winner !== null) {
    statusText.textContent = mode === 'local'
      ? (state.winner === HUMAN ? 'Red wins!' : 'Blue wins!')
      : (state.winner === HUMAN ? 'You win!' : 'Opponent wins');
  } else if (paused) {
    statusText.textContent = 'Paused';
  } else if (mode === 'local') {
    statusText.textContent = state.turn === HUMAN ? 'Red to move' : 'Blue to move';
  } else if (state.turn === HUMAN) {
    statusText.textContent = 'Your move';
  } else {
    statusText.textContent = 'Opponent is thinking';
  }
  dots.classList.toggle('on', thinking);

  for (const p of PLAYERS) {
    chips[p].classList.toggle('active', state.winner === null && state.turn === p && !paused);
    chips[p].classList.toggle('thinking', thinking && p === BOT);
    setSteps(p, pathLen(state, p));
  }

  if (state.winner === null && overlayOpen) {
    overlayOpen = false;
    overlay.hidden = true;
    menuBtn.disabled = false;
  }
  if (state.winner !== null) showOverlay();
  maybeShowHint();
}

async function runOpponent() {
  if (state.winner !== null || !wantsOpponent()) return;
  const token = ++gen;
  const a = await opponent.think(state);
  if (token !== gen) return;
  if (paused) await new Promise<void>((res) => waiting.push(res));   // parked until Resume
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
  if (state.winner !== null) notify(mode === 'local' || state.winner === HUMAN ? 'success' : 'error');
  else if (wantsOpponent()) void runOpponent();
  return true;
}

function restart() {
  gen++;
  state = newGame();
  balls = [toVec(state.pawns[0]), toVec(state.pawns[1])];
  ghost = null;
  marks[0] = null; marks[1] = null;
  shownSteps[0] = -1; shownSteps[1] = -1;
  overlayOpen = false;
  overlay.hidden = true;
  menuBtn.disabled = false;
  clearNote();
  confetti.stop();
  renderer.resetFx();
  ui();
}

function paintNames() {
  const u = tgUser();
  $('name-0').textContent = mode === 'local' ? 'RED' : (u?.first_name || u?.username || 'YOU').toUpperCase().slice(0, 14);
  $('name-1').textContent = mode === 'local' ? 'BLUE' : 'BOT';
  modeLabel.textContent = mode === 'local' ? 'Pass & Play' : `vs Bot · ${difficulty[0].toUpperCase()}${difficulty.slice(1)}`;
}

function startGame(m: Mode, d: Difficulty) {
  mode = m === 'local' ? 'local' : 'bot';
  difficulty = d;
  if (mode === 'bot') opponent = makeBot(d);
  paused = false;
  restart();
  paintNames();
  router.go('game');
}

function pauseGame() {
  if (paused) return;
  paused = true;
  clearGhost();
  syncLoop();
}

function resumeGame() {
  if (!paused) return;
  paused = false;
  const parked = waiting.splice(0, waiting.length);
  syncLoop();
  ui();
  for (const go of parked) go();
}

function quitToMenu() {
  sheets.close();
  paused = true;
  router.popTo('home');
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
    armed: ghost?.armed ? ghost.spec : null,
  });
  if (!hit) { clearGhost(); return; }

  if (hit.kind === 'move') { impact('light'); play({ kind: 'move', to: hit.to }); return; }

  const spec = hit.spec;
  const wall: Wall = { ...spec, owner: state.turn };
  if (hit.kind === 'confirm') {
    if (!wallOk(state, wall)) { refuse(wall); return; }
    play({ kind: 'wall', wall });
    return;
  }
  const ok = wallOk(state, wall);
  ghost = { spec, ok, armed: true, p: state.turn };
  closeHint();
  if (ok) { impact('light'); showNote('Tap again to place', false, 0); } else refuse(wall);
}

/** Mouse: hover previews, one click commits. */
function onMouse(p: Vec, click: boolean) {
  if (!canAct()) { ghost = null; return; }
  const hit = hitTest(renderer.layout(), p.x, p.y, {
    hints,
    armed: null,
  });
  const spec: WallSpec | null = hit && hit.kind !== 'move' ? hit.spec : null;
  const by = state.turn;
  const wall: Wall | null = spec ? { ...spec, owner: by } : null;
  const ok = wall ? wallOk(state, wall) : false;
  ghost = wall ? { spec: wall, ok, armed: false, p: by } : null;

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
toMenu.addEventListener('click', () => { impact('light'); quitToMenu(); });
menuBtn.addEventListener('click', () => {
  if (state.winner !== null) return;
  impact('light');
  pauseGame();
  sheets.open(sheetPause);
  ui();
});
$('pause-resume').addEventListener('click', () => { sheets.close(); resumeGame(); });
$('pause-restart').addEventListener('click', () => { sheets.close(); resumeGame(); restart(); });
$('pause-quit').addEventListener('click', () => sheets.open(sheetQuit));
$('quit-yes').addEventListener('click', () => { impact('light'); quitToMenu(); });

/* ---------- loop ---------- */

new ResizeObserver(() => { renderer.resize(); confetti.resize(); }).observe(wrap);
window.addEventListener('resize', () => { renderer.resize(); confetti.resize(); });
renderer.resize();
confetti.resize();

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const k = motionReduced() ? 1 : 1 - Math.exp(-dt * 14); // frame-rate independent lerp
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
  view.thinking = wantsOpponent() && !paused;
  renderer.draw(view, now);
  confetti.tick(dt, now);
  raf = requestAnimationFrame(frame);
}

/** The webview keeps a hidden Mini App running, and the pause sheet is a real stop: no frames
 *  are burned unless the board is on screen and unpaused. */
let raf = 0;
function syncLoop() {
  const want = !document.hidden && !paused && router.current === 'game';
  if (want && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  else if (!want && raf) { cancelAnimationFrame(raf); raf = 0; }
}
document.addEventListener('visibilitychange', syncLoop);

/* ---------- boot ---------- */

menu = createMenu({ router, sheets, sheet: sheetById, start: startGame, onBack });
menu.setStats({ streak, wins });
paintNames();
ui();
router.start('home');
setBackButton(false);
