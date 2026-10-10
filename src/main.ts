import './style.css';
import {
  COLS, apply, ballById, distField, newGame, pathLen, reachableBall, steps as teamSteps, wallOk,
  wallsLeft, WALL_LIMIT,
  type Action, type GameState, type Player, type Pos, type Wall, type WallSpec,
} from './rules';
import { botAction, botThinkMs, type Difficulty } from './bot';
import { createRenderer, hitTest, type BallView, type Ghost, type Mark, type Vec, type View } from './render';
import { createConfetti } from './confetti';
import { createRouter } from './router';
import { createSheets } from './sheets';
import { createMenu, type Menu } from './menu';
import { createHome } from './home';
import { createCompete } from './compete';
import { createShop } from './shop';
import { createNotifications } from './notifications';
import { mountCoins, setBalance } from './coin';
import { menuState, motionReduced } from './settings';
import { onChange, recordGame, theme } from './storage';
import { impact, initTelegram, notify, onBackPress, tgUser } from './telegram';
import { applyFlagSupport } from './countries';

initTelegram();
applyFlagSupport();

/* ---------- no zoom / no scroll ---------- */

for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault());
}
/**
 * The app never scrolls vertically — but a sheet's list, the compete body and
 * the home carousel keep their own gestures. `data-scroll` is vertical,
 * `data-carousel` is the one horizontal pan (touch-action: pan-x).
 */
document.addEventListener('touchmove', (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest('[data-scroll],[data-carousel]')) return;
  e.preventDefault();
}, { passive: false });
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
const reward = $<HTMLParagraphElement>('reward');
const rewardN = $<HTMLSpanElement>('reward-n');

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

/* wall budget readout: one dash per wall, built once from WALL_LIMIT, then only classes change */
const wallRows = [$<HTMLSpanElement>('walls-0'), $<HTMLSpanElement>('walls-1')];
const wallSegs: HTMLElement[][] = wallRows.map((row) => {
  const box = row.querySelector<HTMLElement>('.wall-segs')!;
  return Array.from({ length: WALL_LIMIT }, () => {
    const seg = document.createElement('i');
    box.appendChild(seg);
    return seg;
  });
});
const wallNums = wallRows.map((row) => row.querySelector<HTMLElement>('.wall-n')!);
const shownWalls: [number, number] = [-1, -1];
function setWalls(p: Player, left: number) {
  if (shownWalls[p] === left) return;
  shownWalls[p] = left;
  wallNums[p].textContent = `${left}/${WALL_LIMIT}`;
  wallRows[p].classList.toggle('dry', left === 0);
  for (let i = 0; i < WALL_LIMIT; i++) wallSegs[p][i].classList.toggle('on', i < left);
  wallRows[p].setAttribute('aria-label', `Walls left: ${left} of ${WALL_LIMIT}`);
  wallNums[p].classList.remove('pop');
  void wallNums[p].offsetWidth;
  wallNums[p].classList.add('pop');
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

let home: { setRoute(id: string): void } | null = null;
let compete: { setRoute(id: string): void } | null = null;

const router = createRouter($('screens'), (id) => {
  menu.setRoute(id);
  shop.setRoute(id);
  home?.setRoute(id);
  compete?.setRoute(id);
  // Telegram BackButton on every screen except Home; always functional via onBack fallback.
  setBackButton(id !== 'home');
  if (id !== 'game') pauseGame();     // the board only ticks while it is on screen
  syncLoop();
});

/** Telegram's BackButton, when the client has one, and the in-page back buttons both land here. */
const setBackButton = onBackPress(() => onBack());

function onBack() {
  impact('light');
  if (sheets.isOpen) { sheets.close(); return; }
  if (router.current === 'game') {
    if (state.winner !== null) { quitToMenu(); return; }
    pauseGame();
    sheets.open(sheetPause);
    ui();
    return;
  }
  // Tabs push, so back normally unwinds; if already at root, land on Home.
  if (!router.back() && router.current !== 'home') router.popTo('home');
}

/* ---------- game ---------- */

/** You are seat 0; every other seat is the machine. */
const HUMAN = 0 as const;
const BOT = 1 as const;
/** The two seats that race, and the two seats the footer shows. */
const SEATS: Player[] = [HUMAN, BOT];
const TEAM_NAME: Record<number, string> = { [HUMAN]: 'You', [BOT]: 'Bot' };

/** Swap this for a network-backed implementation to go multiplayer. */
interface Opponent { think(s: GameState): Promise<Action> }
const makeBot = (d: Difficulty): Opponent => ({
  think: (s) => new Promise((res) => setTimeout(() => res(botAction(s, d)), botThinkMs(d))),
});

let difficulty: Difficulty = menuState.difficulty;
let sizes: [number, number] = [...menuState.sizes];
let opponent: Opponent = makeBot(difficulty);

const wantsOpponent = () => state.turn !== HUMAN && state.winner === null;

const REASON = { empty: 'No walls left', overlap: 'Overlaps a wall', blocked: 'Blocks the path' };

/**
 * Why a slot was refused: an empty budget, an overlap on the same line, or a sealed path.
 * `wallOk` only answers yes/no, so the reason stays a UI-layer concern.
 */
function wallIssue(s: GameState, w: Wall): keyof typeof REASON {
  if (wallsLeft(s, w.owner) <= 0) return 'empty';
  const clash = s.walls.some((o) => o.o === w.o
    && (w.o === 'h' ? o.y === w.y && Math.abs(o.x - w.x) < 2 : o.x === w.x && Math.abs(o.y - w.y) < 2));
  if (clash) return 'overlap';
  const d = distField([...s.walls, w]);
  return s.balls.some((b) => d[b.pos.r * COLS + b.pos.c] < 0) ? 'blocked' : 'overlap';
}

const renderer = createRenderer(canvas, { theme });
const confetti = createConfetti(confettiEl);
const toVec = (p: Pos): Vec => ({ x: p.c + 0.5, y: p.r + 0.5 });

let state: GameState = newGame(sizes);
/**
 * Every ball the renderer draws, in state order, with the animated centre under it. The entries
 * survive across frames and restarts reset them, so the frame loop never allocates.
 */
const ballViews: BallView[] = [];
/** The ball the player picked up, by id — only its legal cells are drawn as dots. */
let selected: number | null = null;
let hints: Pos[] = [];
let ghost: Ghost | null = null;                 // wall preview; armed = waiting for a confirm tap
const marks: (Mark | null)[] = [null, null];
/** Reused every frame: the loop must not allocate. */
const view: View = { state, balls: ballViews, hints, ghost, last: marks, thinking: null };
let gen = 0; // bumps on restart so stale bot replies are dropped
let paused = false;
const waiting: (() => void)[] = [];            // bot thinks parked by the pause sheet

const canAct = () => state.winner === null && state.turn === HUMAN && !paused;
const clearGhost = () => { ghost = null; clearNote(); };

/** Brings the drawn ball list into step with the state; existing entries are reused as they are. */
function syncBalls() {
  while (ballViews.length > state.balls.length) ballViews.pop();
  for (let i = 0; i < state.balls.length; i++) {
    const b = state.balls[i];
    const v = ballViews[i];
    if (v) { v.team = b.team; v.id = b.id; }
    else ballViews.push({ pos: toVec(b.pos), team: b.team, id: b.id, sel: false });
  }
}

/** Picks up one of your balls — or puts it back down, if it was already the chosen one. */
function pick(id: number | null) {
  selected = id;
  clearGhost();
  ui();                     // the status says what to do next, and only that ball's dots light up
}

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
  verdict.textContent = `${TEAM_NAME[state.winner ?? HUMAN]} win${won ? '' : 's'}`;
  sub.textContent = (won ? 'Your team crossed the line first.' : 'The bot reached FINISH first.') + wallsNote;
  overlay.hidden = false;
  if (won && !motionReduced()) confetti.burst();
  /* one credit per finished race: showOverlay only runs once per game over */
  const earned = recordGame({ difficulty, won });
  setBalance(rewardN, 0);                 // every payout counts up from zero
  setBalance(rewardN, earned);
  reward.hidden = false;
  menuBtn.disabled = true;              // the panel already offers Play again and Menu
  again.focus({ preventScroll: true });
}

function ui() {
  /* a pick that no longer belongs to you, or to a ball that is gone, is dropped here */
  if (selected !== null && (state.winner !== null || state.turn !== HUMAN
    || !state.balls.some((b) => b.id === selected))) selected = null;
  hints = canAct() && selected !== null ? reachableBall(state, selected) : [];
  const thinking = wantsOpponent() && !paused;

  if (state.winner !== null) {
    statusText.textContent = `${TEAM_NAME[state.winner]} win${state.winner === HUMAN ? '' : 's'}`;
  } else if (paused) {
    statusText.textContent = 'Paused';
  } else if (state.turn === HUMAN) {
    statusText.textContent = selected === null ? 'Pick one of your balls' : 'Your move';
  } else {
    statusText.textContent = `${TEAM_NAME[state.turn]} is thinking`;
  }
  dots.classList.toggle('on', thinking);

  for (const p of SEATS) {
    chips[p].classList.toggle('active', state.winner === null && state.turn === p && !paused);
    chips[p].classList.toggle('thinking', thinking && p === state.turn);
    setSteps(p, pathLen(state, p));
    setWalls(p, wallsLeft(state, p));
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
  /* which ball is about to move, so the trail can start under it */
  let from: Pos | null = null;
  if (a.kind === 'move') {
    const st = teamSteps(state, by).find((x) => x.to.c === a.to.c && x.to.r === a.to.r
      && (a.ball === undefined || x.ball === a.ball));
    from = st ? ballById(state, st.ball)?.pos ?? null : null;
  }
  const next = apply(state, a);
  if (!next) return false;
  if (a.kind === 'move' && from) marks[by] = { kind: 'step', from, to: a.to };
  else if (a.kind === 'wall') { marks[by] = { kind: 'wall', spec: a.wall }; impact('medium'); }
  state = next;
  ghost = null;
  selected = null;         // the turn is over: the next pick is a fresh one
  clearNote();
  ui();
  if (state.winner !== null) notify(state.winner === HUMAN ? 'success' : 'error');
  else if (wantsOpponent()) void runOpponent();
  return true;
}

function restart() {
  gen++;
  state = newGame(sizes);
  ballViews.length = 0;
  syncBalls();
  selected = null;
  ghost = null;
  marks[0] = null; marks[1] = null;
  shownSteps[0] = -1; shownSteps[1] = -1;
  shownWalls[0] = -1; shownWalls[1] = -1;
  overlayOpen = false;
  overlay.hidden = true;
  reward.hidden = true;
  menuBtn.disabled = false;
  clearNote();
  confetti.stop();
  renderer.resetFx();
  ui();
}

function paintNames() {
  const u = tgUser();
  $('name-0').textContent = (u?.first_name || u?.username || 'YOU').toUpperCase().slice(0, 14);
  $('name-1').textContent = 'BOT';
  modeLabel.textContent = `${sizes[0]}v${sizes[1]} · ${difficulty[0].toUpperCase()}${difficulty.slice(1)}`;
}

function startGame(setup: { difficulty: Difficulty; sizes: [number, number] }) {
  difficulty = setup.difficulty;
  sizes = setup.sizes;
  opponent = makeBot(difficulty);
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

/** Every ball on the board, in cell coordinates, for the hit-test. */
const cells = () => state.balls.map((b) => ({ id: b.id, team: b.team, c: b.pos.c, r: b.pos.r }));

/** Touch: tap one of your balls to pick it up, then a dot to move it; wall lines stay two-tap. */
function onTouch(p: Vec) {
  const hit = hitTest(renderer.layout(), p.x, p.y, {
    hints,
    armed: ghost?.armed ? ghost.spec : null,
    balls: cells(),
    mine: state.turn,
  });
  if (!hit) { pick(null); clearGhost(); return; }

  if (hit.kind === 'ball') { impact('light'); pick(hit.id === selected ? null : hit.id); return; }
  if (hit.kind === 'move') {
    impact('light');
    play({ kind: 'move', ball: selected ?? undefined, to: hit.to });
    return;
  }

  const spec = hit.spec;
  const wall: Wall = { ...spec, owner: state.turn };
  /* an empty budget never arms a ghost: the tap only reports why nothing will happen */
  if (wallsLeft(state, wall.owner) <= 0) { refuse(wall); return; }
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

/** Mouse: hover previews walls, one click picks a ball, a second click moves it. */
function onMouse(p: Vec, click: boolean) {
  if (!canAct()) { ghost = null; return; }
  const hit = hitTest(renderer.layout(), p.x, p.y, {
    hints,
    armed: null,
    balls: cells(),
    mine: state.turn,
  });
  const spec: WallSpec | null = hit && hit.kind === 'wall' ? hit.spec : null;
  const by = state.turn;
  /* out of walls: no preview ghost at all, so the line stops reading as a live slot */
  const budget = wallsLeft(state, by) > 0;
  const wall: Wall | null = spec && budget ? { ...spec, owner: by } : null;
  const ok = wall ? wallOk(state, wall) : false;
  ghost = wall ? { spec: wall, ok, armed: false, p: by } : null;

  if (!click) return;
  if (hit?.kind === 'ball') { impact('light'); pick(hit.id === selected ? null : hit.id); return; }
  if (hit?.kind === 'move') { impact('light'); play({ kind: 'move', ball: selected ?? undefined, to: hit.to }); return; }
  if (spec && !budget) { refuse({ ...spec, owner: by }); return; }
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
$('pause-resume').addEventListener('click', () => { impact('light'); sheets.close(); resumeGame(); });
$('pause-restart').addEventListener('click', () => { impact('light'); sheets.close(); resumeGame(); restart(); });
$('pause-quit').addEventListener('click', () => { impact('light'); sheets.open(sheetQuit); });
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
  if (ballViews.length !== state.balls.length) syncBalls();
  for (let i = 0; i < state.balls.length; i++) {
    const b = state.balls[i], v = ballViews[i];
    const tx = b.pos.c + 0.5, ty = b.pos.r + 0.5;
    v.pos.x += (tx - v.pos.x) * k;
    v.pos.y += (ty - v.pos.y) * k;
    if (Math.abs(tx - v.pos.x) < 0.002) v.pos.x = tx;
    if (Math.abs(ty - v.pos.y) < 0.002) v.pos.y = ty;
    v.sel = selected !== null && v.id === selected;
  }
  view.state = state;
  view.balls = ballViews;
  view.hints = hints;
  view.ghost = ghost;
  view.last = marks;
  view.thinking = wantsOpponent() && !paused ? state.turn : null;
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

mountCoins();                              // every [data-coin] slot gets the shared gold coin
menu = createMenu({ router, sheets, sheet: sheetById, start: startGame, onBack });
const shop = createShop({ sheets, sheet: sheetById });
home = createHome({ router, sheets, start: startGame });
compete = createCompete({ router, sheets, sheet: sheetById });
createNotifications({ sheets });
paintNames();
ui();
router.start('home');
setBackButton(false);
menu.afterStart();

/* equipping repaints the board, and the chip dot that stands for your ball */
const paintTheme = () => {
  const t = theme();
  renderer.setTheme(t);
  chips[0].style.setProperty('--tint', t.ball.ramp.mid);
  chips[0].style.setProperty('--glow', t.ball.ramp.glow);
};
onChange(paintTheme);
paintTheme();
