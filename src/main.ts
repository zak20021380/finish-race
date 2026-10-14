import './style.css';
import {
  COLS, CONFIG, ROWS, apply, ballById, distField, firstBall, getAutoMove, mineCells, minesLeft, newGame,
  reachableBall, steps as teamSteps, view as fogOfWar, wallOk, wallsCross, wallsOverlap, wallsRemaining,
  type Action, type Ball, type Cell, type GameState, type LogEvent, type Mine, type Player,
  type Pos, type Wall, type WallSpec,
} from './rules';
import { botAction, botThinkMs, type Difficulty } from './bot';
import {
  createRenderer, hitTest, logArriveMs, logFaceRow, logRollMs, wallCentre, LOG_ALERT_MS,
  type BallView, type CapsuleAction, type Ghost, type Hit,
  type Mark, type Vec, type View,
} from './render';
import { createConfetti } from './confetti';
import { BOARD_IDLE, holdMineKey, moveDots, pickBall, previewWall, type BoardMode } from './boardmode';
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
import { getGameMode, gmBack, initGameModes, setGameMode } from './gamemodes';
import { createMatchmaking, myTier, onlineRace, onlineSearch, type OnlineSession, type RaceEnd } from './matchmaking';
import { createAdmin, onRuntime, runtime, type Admin } from './admin';

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
const overlay = $<HTMLDivElement>('overlay');
const verdict = $<HTMLParagraphElement>('verdict');
const sub = $<HTMLParagraphElement>('sub');
const again = $<HTMLButtonElement>('again');
const toMenu = $<HTMLButtonElement>('to-menu');
/* every toast on the page: the board's own, and the shop's copy of it. One message goes to all of
   them, so the note speaks on whichever screen is up; the hidden one costs nothing. */
const noteEls = [...document.querySelectorAll<HTMLParagraphElement>('.note')];
const confettiEl = $<HTMLCanvasElement>('confetti');
const menuBtn = $<HTMLButtonElement>('menu-btn');
const roundLabel = $<HTMLParagraphElement>('round-label');
const pauseMode = $<HTMLSpanElement>('pause-mode');
const overMode = $<HTMLParagraphElement>('over-mode');
const announce = $<HTMLParagraphElement>('turn-announce');
/** the countdown ring: `style.strokeDashoffset` drives the arc, `data-timer` on the chip its colour */
const timerFill = $<HTMLElement>('timer-fill');
const timerN = $<HTMLElement>('timer-n');
const chips = [$<HTMLDivElement>('chip-0'), $<HTMLDivElement>('chip-1')];
const dots = $<HTMLSpanElement>('dots');
/** The seat-0 furniture that follows the local player when an online seat is not seat 0. */
const chipRows = chips.map((chip) => chip.querySelector<HTMLElement>('.chip-row'));
const timerCapsule = chips[0].querySelector<HTMLElement>('.chip-ball');
const wallBadges = [$<HTMLSpanElement>('walls-0'), $<HTMLSpanElement>('walls-1')];
const sheetPause = $<HTMLElement>('sheet-pause');
const sheetQuit = $<HTMLElement>('sheet-quit');
const reward = $<HTMLParagraphElement>('reward');
const rewardN = $<HTMLSpanElement>('reward-n');

/* walls-to-place readout on each chip: repaints only when the number changes */
const shownWalls: [number, number] = [-1, -1];
function setWalls(p: Player, left: number) {
  if (shownWalls[p] === left) return;
  const first = shownWalls[p] < 0;
  shownWalls[p] = left;
  const el = wallBadges[p];
  const num = el.querySelector<HTMLElement>('.wall-n');
  if (num) num.textContent = String(left);
  el.classList.toggle('depleted', left <= 0);
  el.setAttribute('aria-label', `Walls left: ${left} of ${CONFIG.WALL_LIMIT}`);
  if (first) return;               // the opening paint is not a placement: no pop
  el.classList.remove('pop');
  void el.offsetWidth;             // restarting the animation needs a reflow between the two class changes
  el.classList.add('pop');
}

/* a player with no walls taps a groove: the badge pulses in warning and a toast says why */
let wallWarnTimer = 0;
function warnNoWalls(p: Player) {
  const el = wallBadges[p];
  if (motionReduced()) { el.classList.remove('depleted'); return; }
  el.classList.remove('depleted', 'dry-warn');
  void el.offsetWidth;
  el.classList.add('depleted', 'dry-warn');
  clearTimeout(wallWarnTimer);
  wallWarnTimer = window.setTimeout(() => el.classList.remove('dry-warn'), 650);
}

/* the mine key lives on your own chip: three pips, and the whole board while it is armed */
const mineBtn = $<HTMLButtonElement>('mine-btn');
const minePips = Array.from({ length: CONFIG.MINES_PER_TEAM }, () => {
  const dot = document.createElement('i');
  $<HTMLElement>('mine-pips').appendChild(dot);
  return dot;
});
let shownMines = -1;
function setMinePips(left: number) {
  if (shownMines === left) return;
  shownMines = left;
  minePips.forEach((el, i) => el.classList.toggle('on', i < left));
  mineBtn.setAttribute('aria-label', left
    ? `Bury a mine — ${left} of ${CONFIG.MINES_PER_TEAM} left`
    : 'Bury a mine — none left');
}

/* the trigger shakes the board itself, once. Reduced motion never shakes anything. */
let shakeTimer = 0;
function shake() {
  if (motionReduced()) return;
  wrap.classList.remove('shake');
  void wrap.offsetWidth;                 // restarting the animation needs a reflow in between
  wrap.classList.add('shake');
  clearTimeout(shakeTimer);
  shakeTimer = window.setTimeout(() => wrap.classList.remove('shake'), 700);
}

/* the toast over the lower board: why a slot was refused, "tap again to place", an event alert.
   Only the screen that is actually up takes the message, so a refusal in the shop never leaks
   onto the board behind it (and vice versa). */
let noteTimer = 0;
let toastMsg = '';
function showNote(msg: string, error: boolean, ttl: number, timeout = false) {
  toastMsg = msg;
  for (const el of noteEls) {
    if (el.closest<HTMLElement>('.screen')?.hidden) continue;
    el.textContent = msg;
    el.classList.toggle('error', error);
    el.classList.toggle('timeout', timeout);     // the blitz verdict gets its own clay tone
    el.classList.add('show');
  }
  clearTimeout(noteTimer);
  if (ttl) noteTimer = setTimeout(() => { for (const el of noteEls) el.classList.remove('show'); }, ttl);
}
const clearNote = () => {
  clearTimeout(noteTimer);
  toastMsg = '';
  for (const el of noteEls) el.classList.remove('show', 'timeout');
};

/* ---------- screens ---------- */

let menu: Menu;
let admin: Admin | null = null;
const sheets = createSheets($('scrim'));
const sheetById = (id: string) => document.getElementById(id);

/**
 * The 1v1 searching stage. Quick match queues here instead of dropping straight onto the
 * board; the race itself still starts through the single `startGame()` door, and cancelling
 * hands the player back to the mode drawer they came from.
 *
 * The transport is the Worker's matchmaker (`worker/`, wired in `matchmaking.ts`): it pairs you
 * with a real opponent and remembers the `{ matchId, seed, side }` the online race runs on. With
 * no Worker listening — a static preview — the same call falls back to the local search, so this
 * stage is still playable on its own.
 */
const matchmaking = createMatchmaking({
  source: onlineSearch(),
  /* A live seat plays the person the matchmaker paired; with no Worker behind the page the same
     stage falls back to the local search, `onlineRace()` is null, and the bot drives the rival. */
  onMatchFound: () => {
    const seat = onlineRace();
    startGame({
      difficulty: menuState.difficulty,
      sizes: seat ? [seat.sizes[0], seat.sizes[1]] : [...menuState.sizes],
      online: seat,
    });
  },
  onCancel: () => {
    const drawer = sheetById('sheet-game-modes');
    if (drawer) sheets.open(drawer);
  },
  /* A queue with nobody in it beats nobody: take the bot, and remember the choice so the
     lobby agrees with the race that just started. */
  onPractice: () => {
    setGameMode('bot');
    startGame({ difficulty: menuState.difficulty, sizes: [...menuState.sizes] });
  },
  /* The Worker refused the queue itself. The local Maintenance Lock normally catches this before a
     socket is ever opened, so this is the server's own enforcement arriving late — say the same
     thing the lock does, and hand the player back to the drawer they came from. */
  onRefused: (reason) => {
    impact('light');
    notify('warning');
    showNote(reason === 'MAINTENANCE'
      ? 'Maintenance in progress — matchmaking is paused.'
      : 'The server closed the queue. Try again in a moment.', false, 2600);
    const drawer = sheetById('sheet-game-modes');
    if (drawer) sheets.open(drawer);
  },
});

/**
 * The one door every queue goes through, so the Admin Command Center's Maintenance Lock can stand
 * in front of it: with the lock on, a new queue is refused with the reason rather than silently
 * doing nothing. `matchmaking.open()` is never called directly.
 */
function queueMatch() {
  if (runtime.maintenance) {
    impact('light');
    notify('warning');
    showNote('Maintenance in progress — matchmaking is paused.', false, 2600);
    return;
  }
  matchmaking.open();
}

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
  if (id === 'home') admin?.relayout();   // the launcher only has a height once Home is up
  syncLoop();
});

/** Telegram's BackButton, when the client has one, and the in-page back buttons both land here. */
const setBackButton = onBackPress(() => onBack());

function onBack() {
  impact('light');
  // the Command Center is a full-viewport stage above every sheet: it unwinds first
  if (admin?.isOpen) { admin.close(); return; }
  // the searching stage sits above every sheet, so it unwinds first
  if (matchmaking.isOpen) { matchmaking.cancel(); return; }
  if (sheets.isOpen) {
    // the game-mode drawer's friends pane unwinds one step before the drawer does
    if (!gmBack()) sheets.close();
    return;
  }
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

/** The two seats that race, and the two seats the footer shows. */
const SEATS: Player[] = [0, 1];
/**
 * Seat 0 is you in a local race; the matchmaker decides in an online one, so every rule that used
 * to say "the human" says `localSide` instead — the input lock, the clock, the mine key, the
 * chips, the payout and the verdict all follow the side this screen is actually playing.
 */
let localSide: Player = 0;
/** The live online seat, when this race is against a person instead of the machine. */
let active: OnlineSession | null = null;
/** Why an online race ended without a finish line, for the panel's own caption. */
let forfeit: RaceEnd['why'] | null = null;
const rivalSide = (): Player => (localSide === 0 ? 1 : 0);
/** `You`, and the name on the other chip: local names in a bot race, the player's in an online one. */
const TEAM_NAME: Record<number, string> = { 0: 'You', 1: 'Bot' };

/** Swap this for a network-backed implementation to go multiplayer. */
interface Opponent { think(s: GameState): Promise<Action> }
const makeBot = (d: Difficulty): Opponent => ({
  think: (s) => new Promise((res) => setTimeout(() => res(botAction(s, d)), botThinkMs(d))),
});

let difficulty: Difficulty = menuState.difficulty;
let sizes: [number, number] = [...menuState.sizes];
let opponent: Opponent = makeBot(difficulty);

/** Is the other seat to move? In an online race that seat is a person, not the machine. */
const rivalTurn = () => state.turn !== localSide && state.winner === null;
const wantsOpponent = () => rivalTurn() && !active;

const REASON = {
  dry: 'No walls remaining!',
  overlap: 'Overlaps a wall',
  cross: 'Crosses a wall',
  blocked: 'Blocks the path',
};

/**
 * Why a wall slot was refused: the budget is spent, a clash with a wall already standing (a shared
 * edge segment, or a `+` through a vertex) or a sealed path. `wallOk` only answers yes/no, so the
 * reason stays a UI-layer concern.
 */
function wallIssue(s: GameState, w: Wall): keyof typeof REASON {
  if (wallsRemaining(s, w.owner) <= 0) return 'dry';
  if (s.walls.some((o) => wallsCross(o, w))) return 'cross';
  if (s.walls.some((o) => wallsOverlap(o, w))) return 'overlap';
  const d = distField([...s.walls, w]);
  return s.balls.some((b) => d[b.pos.r * COLS + b.pos.c] < 0) ? 'blocked' : 'overlap';
}

const renderer = createRenderer(canvas, { theme });
const confetti = createConfetti(confettiEl);
const toVec = (p: Pos): Vec => ({ x: p.c + 0.5, y: p.r + 0.5 });

/** Hands, the opponent's brain and the blitz clock all stand down while a log is on its way. */
let rolling = false;
/** Bot turns parked by a roll, in the order they arrived. */
const rollHeld: (() => void)[] = [];
/** `lastEvent` stays on the state, so the object's identity is what marks it as already played. */
let playedLog: LogEvent | null = null;
/** ball id → the moment the log reaches it, so a shoved ball only starts sliding when it is hit. */
const logWait = new Map<number, number>();
/** ball id → the rows a shove carries it between: the ball rides the trunk's face, not a lerp. */
const logShove = new Map<number, { y0: number; y1: number }>();
/** the roll's own clock, so the face the balls follow and the sprite are the same curve */
let rollT0 = 0, rollStop = 0, rumbleId = 0;
let state: GameState = newGame(sizes, { hazards: runtime.hazards, seed: (Math.random() * 0x7fffffff) | 0 });
/**
 * Every ball the renderer draws, in state order, with the animated centre under it. The entries
 * survive across frames and restarts reset them, so the frame loop never allocates.
 */
const ballViews: BallView[] = [];
/** The ball the player picked up, by id — only its legal cells are drawn as dots. */
let selected: number | null = null;
/** The turn whose ball was picked for the player automatically, so it only happens once per turn. */
let autoPicked: Player | null = null;
/** Your chip's mine key: armed, the whole board becomes the placement band. Direct play otherwise. */
let mineArmed = false;
let hints: Pos[] = [];
let mineHints: Cell[] = [];
/** The cell tapped once in the two-tap mine flow, waiting for its confirm tap. */
let mineGhost: Cell | null = null;
const sameCell = (a: Cell | null, b: Cell | null) => !!a && !!b && a.c === b.c && a.r === b.r;
let ghost: Ghost | null = null;                 // wall preview; armed = waiting for a confirm tap
/** The on-canvas [✓]/[✕] caps anchored beside an armed ghost, or null. */
let capsule: CapsuleAction | null = null;
const marks: (Mark | null)[] = [null, null];
/** Reused every frame: the loop must not allocate. */
const view: View = {
  state, balls: ballViews, hints, ghost, last: marks, thinking: null,
  human: localSide, mineHints, mineGhost, capsule,
};
let gen = 0; // bumps on restart so stale bot replies are dropped
let paused = false;
/** Turns played since the race started: the rules keep no round clock, so the HUD counts its own. */
let turnsPlayed = 0;
/** The last thing spoken into the live region, so a repaint never repeats the same announcement. */
let saidTurn = '';
const waiting: (() => void)[] = [];            // bot thinks parked by the pause sheet

const canAct = () => state.winner === null && state.turn === localSide && !paused && !rolling;
const clearGhost = () => { mineGhost = null; setMode({ ...mode(), preview: null }); clearNote(); };

/**
 * The board's action modes — a ball in hand, a wall preview, the mine key — as one value. The rule
 * that only one of them may own the board at a time is `boardmode.ts`'s; these two just move it.
 * The move dots are derived from the mode rather than stored, so a change here drops them at once
 * and the frame loop paints them back only if the new mode still calls for them.
 */
const mode = (): BoardMode<Ghost> => ({ selected, preview: ghost, mine: mineArmed });
/** The dots a mode calls for: a ball in hand draws them, a wall preview or the mine key never does. */
const dotsFor = (m: BoardMode<Ghost>): Pos[] =>
  canAct() && moveDots(m) && m.selected !== null ? reachableBall(state, m.selected) : [];
function setMode(next: BoardMode<Ghost>) {
  selected = next.selected;
  ghost = next.preview;
  mineArmed = next.mine;
  hints = dotsFor(next);         // derived, so it is rebuilt the moment the mode moves — never stale
  armCapsules();                 // the [✓]/[✕] caps hang off the preview, so they follow it
}

/**
 * The chip's mine key: tapping it hands the board over to the placement band, tapping it again
 * hands direct play straight back. Placing a mine lets the key go on its own, so the next tap is
 * always a plain board tap.
 */
function armMine(next: boolean) {
  const on = next && canAct() && minesLeft(state, localSide) > 0;
  if (on === mineArmed) return;
  impact('light');
  mineGhost = null;
  setMode(holdMineKey(mode(), on));   // the key owns the board: no ball in hand, no wall preview
  clearNote();
  ui();
}

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

/**
 * What a player's turn put in hand: their first ball, if it can still move. The turn always opens
 * on a move, so the dots render straight away; a waxed-in trail re-derives nothing.
 */
function selectionFor(s: GameState): Ball | null {
  if (s.winner !== null) return null;
  const b = firstBall(s, s.turn);
  return b && reachableBall(s, b.id).length ? b : null;
}

/** Picks up one of your balls — or puts it back down, if it was already the chosen one. */
function pick(id: number | null) {
  mineGhost = null;
  setMode(pickBall(mode(), id));   // the ball comes to hand, and any wall preview goes with it
  clearNote();
  ui();                            // only the picked ball's dots light up
}

/** The wall ghost's floating caps: confirm commits the slot, cancel clears it. */
function armCapsules() {
  if (ghost?.armed) {
    const centre = wallCentre(ghost.spec);
    capsule = { ax: centre.x, ay: centre.y, hit: { kind: 'confirm', spec: ghost.spec } };
  } else if (mineGhost) {
    capsule = { ax: mineGhost.c + 0.5, ay: mineGhost.r + 0.5, hit: { kind: 'mine-confirm', cell: mineGhost } };
  } else {
    capsule = null;
  }
}

/**
 * How the race was decided: a finish line, or a rival who did not stay to see it. A forfeit is a
 * win that never touched the board, so it says so rather than pretending a ball crossed.
 */
function subLine(won: boolean): string {
  const rival = active?.opponent.name ?? 'The bot';
  if (!forfeit) return won ? 'Your team crossed the line first.' : `${rival} reached FINISH first.`;
  if (forfeit === 'drop') return 'Connection lost — the rival takes the win.';
  if (!won) return `${rival} took the win.`;
  return `${rival} ${forfeit === 'resign' ? 'resigned' : 'left the race'} — the win is yours.`;
}

let overlayOpen = false;
function showOverlay() {
  if (overlayOpen) return;
  overlayOpen = true;
  const won = state.winner === localSide;
  const built = state.walls.length;
  const wallsNote = built ? ` ${built} wall${built === 1 ? '' : 's'} went up along the way.` : '';
  overlay.classList.toggle('win', won);
  overlay.classList.toggle('lose', !won);
  verdict.textContent = `${TEAM_NAME[state.winner ?? localSide]} win${won ? '' : 's'}`;
  sub.textContent = subLine(won) + wallsNote;
  overlay.hidden = false;
  if (won && !motionReduced()) confetti.burst();
  /* one credit per finished race: showOverlay only runs once per game over. The Admin Command
     Center's Double-Coins multiplier scales what the settlement pays. */
  const earned = recordGame({ difficulty, won }, runtime.coinMult);
  setBalance(rewardN, 0);                 // every payout counts up from zero
  setBalance(rewardN, earned);
  reward.hidden = false;
  menuBtn.disabled = true;              // the panel already offers Play again and Menu
  again.focus({ preventScroll: true });
}

function ui() {
  /* a pick that no longer belongs to you, or to a ball that is gone, is dropped here */
  if (selected !== null && (state.winner !== null || state.turn !== localSide
    || !state.balls.some((b) => b.id === selected))) selected = null;
  const live = canAct();
  /* the key only ever covers one turn, and only while there is still a mine to bury */
  if (!live || minesLeft(state, localSide) <= 0) mineArmed = false;
  /* at the start of a human turn, put that turn's first ball in hand so the dots light up at once —
     unless a wall preview is already up, since that owns the board until it is confirmed or dropped */
  if (live && !mineArmed && !ghost && selected === null && autoPicked !== state.turn) {
    const auto = selectionFor(state);
    if (auto) { selected = auto.id; autoPicked = state.turn; }
  }
  /* the dots belong to the ball in hand and to nothing else: a wall preview or the mine key
     suppresses them outright, so a dashed bar is never drawn under a selection ring */
  hints = dotsFor(mode());
  mineHints = live && mineArmed ? mineCells(state, localSide) : [];
  /* an armed cell that is no longer placeable — the turn moved on, or a ball rolled over it */
  if (mineGhost && !mineHints.some((h) => sameCell(h, mineGhost))) mineGhost = null;
  armCapsules();
  /* the rival's dots tick for a bot's think time and for a person's just the same */
  const thinking = rivalTurn() && !paused;

  dots.classList.toggle('on', thinking);

  mineBtn.setAttribute('aria-pressed', String(mineArmed));
  mineBtn.disabled = !live || minesLeft(state, localSide) <= 0;
  setMinePips(minesLeft(state, localSide));

  /* whose turn it is rides on the chips now: a clay glow, a lift, and the countdown ring */
  const seat = state.winner ?? state.turn;
  for (const p of SEATS) {
    chips[p].classList.toggle('active', state.winner === null && state.turn === p && !paused);
    chips[p].classList.toggle('thinking', thinking && p === state.turn);
    setWalls(p, wallsRemaining(state, p));
  }
  const spoken = state.winner !== null ? `${TEAM_NAME[seat]} win${seat === localSide ? '' : 's'}`
    : seat === localSide ? 'Your turn' : `${TEAM_NAME[seat]}'s turn`;
  if (spoken !== saidTurn) { saidTurn = spoken; announce.textContent = spoken; }

  /* one turn per seat makes a round; the counter is the UI's, the rules keep none */
  roundLabel.textContent = `Round ${Math.floor(turnsPlayed / Math.max(1, state.teams.length)) + 1}`;
  /* the strike badge is painted at the heart of the finish strip, so the label yields while it is up */
  wrap.classList.toggle('lane', rolling);
  wrap.classList.toggle('rolling', rolling);   // the board is visibly inert while a trunk is on it
  paintClock();

  if (state.winner === null && overlayOpen) {
    overlayOpen = false;
    overlay.hidden = true;
    menuBtn.disabled = false;
  }
  if (state.winner !== null) showOverlay();
}

/** A bot turn parked until the board is clear of a rolling log. */
const untilRoll = () => (rolling
  ? new Promise<void>((res) => { rollHeld.push(res); })
  : Promise.resolve());

async function runOpponent() {
  if (state.winner !== null || !wantsOpponent()) return;
  const token = ++gen;
  await untilRoll();                    // it does not think over the top of a trunk, let alone move
  if (token !== gen) return;
  if (paused) await new Promise<void>((res) => waiting.push(res));   // parked until Resume
  if (token !== gen) return;
  const a = await opponent.think(fogOfWar(state, state.turn));
  if (token !== gen) return;
  if (play(a)) return;
  /* a bot only sees its own side of the fog, so a mine it buries can sit on a square the human
     already mined, which the rules refuse: carry on racing rather than throw the turn away */
  const st = teamSteps(state, state.turn)[0];
  play(st ? { kind: 'move', ball: st.ball, to: st.to } : { kind: 'pass' });
}

/** The mine that went off across this action: triggered mines only ever flip in place. */
function blastOf(prev: GameState, next: GameState): Mine | null {
  for (let i = 0; i < next.mines.length; i++) {
    const m = next.mines[i];
    if (m.triggered && !prev.mines[i]?.triggered) return m;
  }
  return null;
}

/**
 * A log has just dropped, and it is the only warning anyone gets: one second of tremor and a
 * blinking badge, then the trunk is away. Nothing may move across all of that — taps are refused,
 * the bot parks, the blitz clock stays stopped — so the strike cannot be walked out of. The sprite
 * and every beat inside it are timed by `render.ts`, so the board and this lock cannot disagree.
 */
function playLog(ev: LogEvent, next: GameState) {
  playedLog = ev;
  rolling = true;
  const token = gen;                    // restart() bumps it, so a stale roll cannot unlock the new race
  const t0 = performance.now();
  const strike = t0 + LOG_ALERT_MS;     // the trunk leaves the top edge when the alert ends
  const T = logRollMs(ev.stopRow);
  const blocked = ev.stopRow < ROWS - 1;
  rollT0 = strike; rollStop = ev.stopRow;
  renderer.rollLog(ev, t0);
  shake();                              // the board itself trembles for the whole second
  impact('heavy');
  if (!motionReduced()) {
    for (const m of ev.moves) {
      const hit = strike + logArriveMs(m.from.r, ev.stopRow);
      logWait.set(m.ballId, hit);
      logShove.set(m.ballId, { y0: m.from.r, y1: m.to.r });
      window.setTimeout(() => { if (token === gen) impact('heavy'); }, hit - t0);
    }
  }
  /* the log meets the top-most ball first, so that is the shove the note reports */
  let hit: LogEvent['moves'][number] | undefined = ev.moves[0];
  for (const m of ev.moves) if (hit && m.from.r < hit.from.r) hit = m;
  const team = hit ? ballById(next, hit.ballId)?.team ?? localSide : localSide;
  const thrown = hit ? hit.to.r - hit.from.r : 0;
  const msg = hit
    ? `Log! ${TEAM_NAME[team] ?? 'Ball'} pushed back ${thrown} cell${thrown === 1 ? '' : 's'}`
    : blocked ? 'Log blocked by a wall' : 'Log rolled down an empty lane';
  notify('warning');
  showNote(msg, false, Math.max(2600, LOG_ALERT_MS + T));
  /* a trunk this heavy is felt the whole way down: a soft thud every 140ms once it is rolling */
  window.setTimeout(() => {
    if (token !== gen) return;
    rumbleId = window.setInterval(() => impact('light'), 140);
  }, LOG_ALERT_MS);
  /* and if a wall took it, the board shakes where it hit, not when it started */
  if (blocked) window.setTimeout(() => { if (token === gen) { shake(); impact('heavy'); } }, strike - t0 + T);
  window.setTimeout(() => {
    window.clearInterval(rumbleId);
    rumbleId = 0;
    if (token !== gen) return;          // the race restarted: that lock belongs to the new one
    rolling = false;
    logWait.clear();                    // anything still held is released, never left frozen
    logShove.clear();
    while (rollHeld.length) rollHeld.shift()!();
    if (paused || state.winner !== null) return;
    ui();
    startClock();                       // the seat gets its allowance back once the board is clear
  }, strike - t0 + T + 240);
}

/**
 * The single door every action comes through — taps, the bot, the blitz timeout and (with
 * `remote`) the rival's moves off the wire — so a networked race animates exactly like a local one.
 */
function play(a: Action, remote = false): boolean {
  const prev = state;
  const by = state.turn;
  /* which ball is about to move, so the trail can start under it */
  let from: Pos | null = null;
  let moved: number | null = null;
  if (a.kind === 'move') {
    const st = teamSteps(prev, by).find((x) => x.to.c === a.to.c && x.to.r === a.to.r
      && (a.ball === undefined || x.ball === a.ball));
    if (st) { moved = st.ball; from = ballById(prev, st.ball)?.pos ?? null; }
  }
  const next = apply(prev, a);
  if (!next) return false;
  /* where the ball actually came to rest — after a blast that is three rows further down */
  const landed = moved === null ? null : ballById(next, moved)?.pos ?? null;
  if (a.kind === 'move' && from && landed) marks[by] = { kind: 'step', from, to: landed };
  else if (a.kind === 'wall') { marks[by] = { kind: 'wall', spec: a.wall }; impact('medium'); }
  if (a.kind === 'mine') mineArmed = false;      // one mine per trip to the key
  state = next;
  /* a move this seat made is also a move the rival has to see: the matchmaker relays it */
  if (!remote && active) active.send(a);
  turnsPlayed++;                 // one seat has acted; the round caption counts them
  mineGhost = null;
  setMode(BOARD_IDLE);           // the turn is over: the next pick is a fresh one
  autoPicked = null;             // ...and the next human turn auto-selects its own first ball
  clearNote();
  const blast = blastOf(prev, next);
  if (blast) {
    const cells = landed ? landed.r - blast.cell.r : 0;
    renderer.blast(blast.cell);
    shake();
    impact('heavy');
    notify('warning');
    showNote(`Mine! ${TEAM_NAME[by]} ${by === localSide ? 'were' : 'was'} thrown back `
      + `${cells} cell${cells === 1 ? '' : 's'}`, false, 2600);
  }
  /* a log that just landed is a fresh object every time, so identity is the play-once flag */
  if (next.lastEvent && next.lastEvent !== playedLog) playLog(next.lastEvent, next);
  ui();
  startClock();          // the turn has moved on: the next seat gets its own allowance
  if (state.winner !== null) notify(state.winner === localSide ? 'success' : 'error');
  else if (wantsOpponent()) void runOpponent();
  return true;
}

/**
 * Blitz clock. One interval, owned by the turn that started it: `startClock` is the only thing that
 * arms it, and it arms nothing unless a human seat is actually up — so a bot's think time, an open
 * sheet, a finished race and a hidden webview all leave the timer cleared rather than running blind.
 */
const URGENT_AT = 3;
/** the amber step, before the last three seconds: 5s or less is a warning, 3s or less an alarm */
const WARN_AT = 5;
/** the ring's whole arc: the SVG's r=21, so C = 2·π·21. The dash offset drains from 12 o'clock. */
const RING_C = 2 * Math.PI * 21;
let turnTimerId: number | null = null;
/** The live allowance, read off the Command Center every turn — so a change lands on the next one. */
let turnSecondsLeft: number = runtime.blitz;
/** the fraction the ring last showed, so a refill never animates backwards through 1s of easing */
let ringFrac = -1;

/** Is the countdown this seat's to lose? */
const clockLive = () => !paused && !overlayOpen && !document.hidden && router.current === 'game'
  && state.winner === null && state.turn === localSide && !rolling;

/** Park the countdown: the interval is gone, and the chip stops advertising a clock it isn't running. */
function stopClock() {
  if (turnTimerId !== null) {
    clearInterval(turnTimerId);
    turnTimerId = null;
  }
  paintClock();
}

/** A new turn: the full allowance, and an interval only once a human seat is actually up. */
function startClock() {
  stopClock();
  turnSecondsLeft = runtime.blitz;
  paintClock();
  if (clockLive()) turnTimerId = window.setInterval(tickClock, 1000);
}

/**
 * The countdown, painted on the seat that owns it: a ring around its ball and the seconds punched
 * through the middle. The number is always there, so the colour is a heads-up and never the only
 * signal — accent past 5s, amber to 5s, red to 3s (where the ring also breathes).
 */
function paintClock() {
  const chip = chips[localSide];
  const live = clockLive();
  chip.classList.toggle('timing', live);
  if (!live) { chip.removeAttribute('data-timer'); return; }
  const left = Math.max(0, turnSecondsLeft);
  const frac = left / Math.max(1, runtime.blitz);
  timerFill.style.transition = frac < ringFrac ? '' : 'none';
  ringFrac = frac;
  timerFill.style.strokeDashoffset = String(RING_C * (1 - frac));
  timerN.textContent = String(left);
  chip.dataset.timer = left <= URGENT_AT ? 'red' : left <= WARN_AT ? 'amber' : 'accent';
}

function tickClock() {
  turnSecondsLeft--;
  if (turnSecondsLeft <= 0) {
    turnSecondsLeft = 0;
    stopClock();
    paintClock();
    timeoutMove();
    return;
  }
  if (turnSecondsLeft <= URGENT_AT) impact('light');
  paintClock();
}

/**
 * The clock ran out. Every armed mode goes before the move is committed, so a half-placed wall or a
 * live mine key can never be carried into the next seat's turn.
 */
function timeoutMove() {
  mineGhost = null;
  setMode(BOARD_IDLE);
  notify('warning');
  play(getAutoMove(state, state.turn));
  /* after play(), which clears the toast itself to make room for the next prompt */
  showNote('Auto-move', false, 1800, true);
}

function restart() {
  gen++;
  /* Every local race rolls a fresh seed so no two telegraph the same lanes; an online race takes
     the seed the matchmaker handed both sides, so the logs and the hazards are the same board. */
  state = newGame(sizes, { hazards: runtime.hazards, seed: active ? active.seed : (Math.random() * 0x7fffffff) | 0 });
  rolling = false;
  window.clearInterval(rumbleId);
  rumbleId = 0;
  playedLog = null;
  logWait.clear();
  logShove.clear();
  ballViews.length = 0;
  syncBalls();
  setMode(BOARD_IDLE);
  mineGhost = null;
  autoPicked = null;
  marks[0] = null; marks[1] = null;
  shownWalls[0] = -1; shownWalls[1] = -1;
  shownMines = -1;
  turnsPlayed = 0;
  saidTurn = '';
  overlayOpen = false;
  overlay.hidden = true;
  reward.hidden = true;
  menuBtn.disabled = false;
  clearNote();
  confetti.stop();
  renderer.resetFx();
  ui();
  startClock();
}

function paintNames() {
  const me = ((tgUser()?.first_name || tgUser()?.username || 'You')).toUpperCase().slice(0, 14);
  const foe = (active ? active.opponent.name : 'Bot').toUpperCase().slice(0, 14);
  $('name-0').textContent = localSide === 0 ? me : foe;
  $('name-1').textContent = localSide === 0 ? foe : me;
  /* the race names itself where a race is being stopped or judged, not on every frame of play */
  const mode = `${sizes[0]}v${sizes[1]} · ${active ? 'Online' : `${difficulty[0].toUpperCase()}${difficulty.slice(1)}`}`;
  pauseMode.textContent = ` · ${mode}`;
  overMode.textContent = mode;
}

/**
 * The interactive furniture is seat-indexed in the markup (`#mine-btn` and the blitz ring in seat
 * 0's chip, the thinking dots in seat 1's), but an online seat can be either side. The chips keep
 * their names and colours; only the controls follow the local player to their own chip.
 */
function seatChrome(): void {
  const row = chipRows[localSide];
  const rivalWho = chips[rivalSide()].querySelector<HTMLElement>('.who-line');
  if (!row || !rivalWho || !timerCapsule) return;
  row.insertBefore(timerCapsule, row.firstChild);   // this seat's own countdown ring
  row.appendChild(mineBtn);                        // ...and its own mine key
  rivalWho.appendChild(dots);                      // the rival gets the thinking dots
}

/** How a race starts: the local shape, plus the live seat when the matchmaker paired one. */
interface StartSetup {
  difficulty: Difficulty;
  sizes: [number, number];
  online?: OnlineSession | null;
}

function startGame(setup: StartSetup) {
  /* menuState.difficulty is the single source: the Choose-mode sheet persists it live,
     so every start path (vs Bot card, Play) runs the level the sheet shows. */
  difficulty = menuState.difficulty;
  /* An online seat brings its own board and side; a local race is always seat 0 against the bot. */
  active = setup.online ?? null;
  forfeit = null;
  localSide = active ? active.side : 0;
  sizes = active ? [active.sizes[0], active.sizes[1]] : setup.sizes;
  TEAM_NAME[localSide] = 'You';
  TEAM_NAME[rivalSide()] = active ? active.opponent.name : 'Bot';
  view.human = localSide;
  opponent = makeBot(difficulty);
  paused = false;
  restart();
  seatChrome();
  paintNames();
  /* a networked board cannot be restarted into the same seat: the pause sheet only offers leaving */
  $('pause-restart').hidden = !!active;

  if (active) {
    const session = active;
    /* the rival's moves come through the same door the bot's do, so walls, mines, log strikes and
       the blitz hand-off all animate exactly as they do offline */
    session.onMove((action) => { if (state.winner === null) play(action, true); });
    session.onEnd((end) => endOnline(end));
    session.onReject(() => {
      notify('error');
      showNote('Move refused — the two boards disagree', true, 2400);
    });
  }

  router.go('game');
}

/**
 * The online race ended without a finish line: award it, say why, and stop the clock. The board is
 * left exactly as it stands — nothing is rewound, because both screens stopped on the same turn.
 */
function endOnline(end: RaceEnd): void {
  if (state.winner !== null) return;
  forfeit = end.why;
  state = { ...state, winner: end.win ? localSide : rivalSide() };
  stopClock();
  ui();
  notify(end.win ? 'success' : 'error');
  showNote(end.win
    ? (end.why === 'resign' ? 'Rival resigned — you win' : 'Rival left — you win')
    : end.why === 'aborted' ? 'Room closed by an operator' : 'Connection lost',
  !end.win, 3000);
}

function pauseGame() {
  if (paused) return;
  /* A networked race does not pause: the rival is still playing and their clock is still theirs,
     so the pause sheet in an online race is only a way out — Resume just closes it again. */
  if (active) return;
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
  /* Walking out of a live online race is a resignation: the rival takes the win, and the socket
     goes with it — leaving it open would only hold the other player's seat hostage. */
  if (active) {
    if (state.winner === null) active.resign();
    active.close();
    active = null;
  }
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
  if (why === 'dry') warnNoWalls(w.owner);
  notify('warning');
}

/** Every ball on the board, in cell coordinates, for the hit-test. */
const cells = () => state.balls.map((b) => ({ id: b.id, team: b.team, c: b.pos.c, r: b.pos.r }));

/** What the key that is down offers to a tap. */
const at = (p: Vec) => hitTest(renderer.layout(), p.x, p.y, {
  hints,
  armed: ghost?.armed ? ghost.spec : null,
  balls: cells(),
  mine: localSide,
  mode: mineArmed ? 'mine' : 'move',
  mineHints,
  armedMine: mineGhost,
  capsule,
});

/** Clear the wall ghost and anything it was holding (the caps included). */
function disarmWall() { setMode({ ...mode(), preview: null }); clearNote(); }

/**
 * The wall ghost's input branch: [✓] commits, [✕] cancels, another groove relocates the ghost, and
 * a ball or a legal-move dot immediately drops the ghost and plays that move.
 * Returns true when the tap was handled here.
 */
function wallBranch(hit: Hit | null): boolean {
  if (!ghost?.armed) {
    if (hit?.kind === 'cancel') { disarmWall(); return true; }
    if (hit?.kind === 'wall') { tapWall(hit); return true; }   // open the two-tap wall here
    return false;
  }
  if (hit?.kind === 'confirm') { tapWall(hit); return true; }
  if (hit?.kind === 'cancel') { disarmWall(); return true; }
  if (hit?.kind === 'wall') { tapWall(hit); return true; }   // relocate to the new slot
  if (hit?.kind === 'ball') { disarmWall(); impact('light'); pick(hit.id === selected ? null : hit.id); return true; }
  if (!hit) { disarmWall(); pick(null); return true; }        // neutral board space cancels
  return false;
}

/** The two-tap mine flow: one tap arms the square, the next buries it. */
function tapMine(hit: Hit | null): boolean {
  // board background, or the [✕] cap: disarm the mine ghost and its caps
  if (!hit || hit.kind === 'cancel') { mineGhost = null; capsule = null; return true; }
  if (hit.kind === 'mine-confirm') {
    if (mineGhost) play({ kind: 'mine', cell: mineGhost });
    return true;
  }
  if (hit.kind !== 'mine') return false;
  mineGhost = hit.cell;
  armCapsules();
  impact('light');
  showNote('Tap again to bury', false, 0);
  return true;
}

/** The two-tap wall flow: one tap arms the slot, the next puts the wall up. */
function tapWall(hit: { kind: 'wall' | 'confirm'; spec: WallSpec }) {
  const wall: Wall = { ...hit.spec, owner: state.turn };
  const ok = wallOk(state, wall);
  /* a spent budget disallows the preview entirely: refuse the tap and pulse the badge instead */
  if (wallsRemaining(state, wall.owner) <= 0) {
    setMode({ ...mode(), preview: null });
    refuse(wall);
    return;
  }
  if (hit.kind === 'confirm') {
    if (ok) play({ kind: 'wall', wall }); else refuse(wall);
    return;
  }
  /* arming the slot takes the board: a dashed bar and a ball's move dots are never both up */
  setMode(previewWall(mode(), { spec: hit.spec, ok, armed: true, p: state.turn }));
  if (ok) { impact('light'); showNote('Tap again to place', false, 0); } else refuse(wall);
}

/**
 * Touch: whatever the live key offers is what a tap acts on — the ghost caps, a ball, a line, or a
 * square. An armed wall ghost owns the tap first; otherwise the strict move/groove arbitration wins.
 */
function onTouch(p: Vec) {
  const hit = at(p);
  if (mineArmed) { tapMine(hit); return; }
  if (wallBranch(hit)) return;
  if (!hit) { pick(null); return; }
  if (hit.kind === 'ball') { impact('light'); pick(hit.id === selected ? null : hit.id); return; }
  if (hit.kind === 'move') {
    disarmWall();
    impact('light');
    play({ kind: 'move', ball: selected ?? undefined, to: hit.to });
    return;
  }
  if (hit.kind === 'confirm') tapWall(hit);
}

/** Mouse: hovering a groove previews the wall there; mines arm on click, like everywhere else. */
function onMouse(p: Vec, click: boolean) {
  if (!canAct()) { disarmWall(); return; }
  if (mineArmed) {
    if (click) tapMine(at(p));
    return;
  }
  const hit = at(p);
  if (!click) {
    /* hovering is a preview; an armed ghost keeps its slot and its caps, and a spent budget shows none */
    if (ghost?.armed) return;
    const spec = hit && hit.kind === 'wall' && wallsRemaining(state, state.turn) > 0 ? hit.spec : null;
    const wall: Wall | null = spec ? { ...spec, owner: state.turn } : null;
    setMode(previewWall(mode(), wall ? { spec: wall, ok: wallOk(state, wall), armed: false, p: state.turn } : null));
    return;
  }
  if (wallBranch(hit)) return;
  if (hit?.kind === 'ball') { impact('light'); pick(hit.id === selected ? null : hit.id); return; }
  if (hit?.kind === 'move') {
    disarmWall();
    impact('light');
    play({ kind: 'move', ball: selected ?? undefined, to: hit.to });
    return;
  }
  clearGhost();
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!canAct()) return;
  const p = local(e);
  const L = renderer.layout();
  renderer.ripple((p.x - L.ox) / L.cell, (p.y - L.oy) / L.cell, localSide);   // the tap answers at once
  if (e.pointerType === 'mouse') onMouse(p, true);
  else onTouch(p);
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  onMouse(local(e), false);
});
canvas.addEventListener('pointerleave', () => {
  if (ghost && !ghost.armed) setMode({ ...mode(), preview: null });
});

mineBtn.addEventListener('click', () => { armMine(!mineArmed); });

again.addEventListener('click', () => {
  impact('light');
  /* a networked seat is not ours to restart: Play again means queue again */
  if (active) { active.close(); active = null; queueMatch(); return; }
  restart();
});
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
  /* one mode value per frame: the ring rides the dots, so a previewing board shows no ball as picked */
  const m = mode(), dots = moveDots(m);
  for (let i = 0; i < state.balls.length; i++) {
    const b = state.balls[i], v = ballViews[i];
    const gate = logWait.get(b.id);
    if (gate !== undefined) {
      if (now < gate) continue;         // a rolling log has not reached this ball yet: it stays put
      logWait.delete(b.id);
    }
    const tx = b.pos.c + 0.5, ty = b.pos.r + 0.5;
    const sh = logShove.get(b.id);
    if (sh) {
      /* the trunk is pushing it, so it rides the face: never ahead of it, never behind it either */
      const y = Math.min(sh.y1, Math.max(sh.y0, logFaceRow(rollStop, now - rollT0)));
      v.pos.x += (tx - v.pos.x) * k;
      v.pos.y = y + 0.5;
      if (y >= sh.y1) logShove.delete(b.id);
    } else {
      v.pos.x += (tx - v.pos.x) * k;
      v.pos.y += (ty - v.pos.y) * k;
    }
    if (Math.abs(tx - v.pos.x) < 0.002) v.pos.x = tx;
    if (Math.abs(ty - v.pos.y) < 0.002) v.pos.y = ty;
    v.sel = dots && v.id === m.selected;
  }
  view.state = state;
  view.balls = ballViews;
  view.hints = hints;
  view.ghost = ghost;
  view.mineHints = mineHints;
  view.mineGhost = mineGhost;
  view.capsule = capsule;
  view.last = marks;
  view.thinking = wantsOpponent() && !paused ? state.turn : null;
  renderer.draw(view, now);
  confetti.tick(dt, now);
  raf = requestAnimationFrame(frame);
}

/** The webview keeps a hidden Mini App running, and the pause sheet is a real stop: no frames
 *  are burned unless the board is on screen and unpaused. The clock follows the same rule —
 *  leaving the board stops it, coming back hands the seat a full allowance again. */
let raf = 0;
function syncLoop() {
  const want = !document.hidden && !paused && router.current === 'game';
  if (want && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  else if (!want && raf) { cancelAnimationFrame(raf); raf = 0; }
  if (!want) stopClock();
  else if (turnTimerId === null) startClock();
}
document.addEventListener('visibilitychange', syncLoop);

/* ---------- boot ---------- */

mountCoins();                              // every [data-coin] slot gets the shared gold coin
menu = createMenu({ router, sheets, sheet: sheetById, start: startGame, onBack });
/* the till reads the live sales switch, so the Command Center's toggle lands without a reload */
const shop = createShop({
  sheets, sheet: sheetById, note: showNote, salesOpen: () => runtime.salesOpen,
});
home = createHome({ router, sheets, start: startGame });
compete = createCompete({ router, sheets, sheet: sheetById });
createNotifications({ sheets });

/* ---- Admin Command Center: the Home FAB and the live-ops stage (src/admin.ts) ---- */
admin = createAdmin({
  note: showNote,
  tier: myTier,
  /* the stage is not a router screen, so it shows the BackButton itself while it is up */
  onToggle: (open) => setBackButton(open || router.current !== 'home'),
});
admin.mount();
/* the shop is the one screen that reads a switch at paint time: repaint it the moment it moves */
onRuntime(() => shop.refresh());

initGameModes(sheets, {
  /* the drawer already persisted sizes + difficulty, so the race it names is the race it runs */
  onStart: () => {
    const sel = getGameMode();
    /* Quick match is online: it queues on the searching stage first. Practice and a private
       room have nobody to wait for, so they start the race right away. */
    if (sel.id === 'duel_1v1' || sel.id === 'party_2v2') { queueMatch(); return; }
    startGame({ difficulty: menuState.difficulty, sizes: [...menuState.sizes] });
  },
});
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
