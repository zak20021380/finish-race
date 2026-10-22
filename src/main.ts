import './style.css';
import {
  CONFIG, MAX_TEAMS, apply, ballById, distField, firstBall, getAutoMove, mineCells, minesLeft, newGame,
  reachableBall, steps as teamSteps, view as fogOfWar, wallBudget, wallOk, wallsCross, wallsOverlap,
  wallsRemaining,
  type Action, type Ball, type Cell, type GameState, type LogEvent, type Mine, type Player,
  type Pos, type Wall, type WallSpec,
} from './rules';
import { botAction, botThinkMs, type Difficulty } from './bot';
import {
  createRenderer, hitTest, logArriveMs, logFaceRow, logRollMs, wallCentre, LOG_ALERT_MS,
  type BallView, type CapsuleAction, type Ghost, type Hit,
  type Mark, type Perspective, type Vec, type View,
} from './render';
import { createConfetti } from './confetti';
import { createChat } from './chat';
import {
  BOARD_IDLE, holdMineKey, holdsBall, moveDots, pickBall, pickBallFromMine, previewWall, type BoardMode,
} from './boardmode';
import { createRouter } from './router';
import { createSheets } from './sheets';
import { createMenu, type Menu } from './menu';
import { createHome } from './home';
import { createCompete } from './compete';
import { flagPhoto } from './flags';
import { createShop } from './shop';
import { createNotifications } from './notifications';
import { mountCoins, setBalance } from './coin';
import { menuState, motionReduced } from './settings';
import { audio, SHOVE_RATE } from './audio';
import {
  completeTutorial, hasCompletedTutorial, onChange, pieceColor, profile, recordGame, resetTutorialState, theme,
} from './storage';
import {
  createTutorial, shouldAutoStartTutorial, tutorialSpotHas, TUTORIAL_LIVE_STEPS,
  type Tutorial, type TutorialAction, type TutorialRect, type TutorialSpot, type TutorialStage,
  type TutorialTargetMine, type TutorialTargetMove, type TutorialTargetSelect, type TutorialTargetWall,
} from './tutorial';
import { perspectiveRamps } from './themes';
import { detonation, impact, initTelegram, notify, onBackPress, tgUser } from './telegram';
import { applyFlagSupport } from './countries';
import { createRoomCode, getGameMode, gmBack, initGameModes, onGameModeChange, setGameMode } from './gamemodes';
import type { Lobby, LobbyRace } from './lobby';
import {
  createMatchmaking, myTier, myTiq, onlineRace, onlineSearch, type OnlineSession, type RaceEnd,
} from './matchmaking';
import { createAdmin, onRuntime, recordRace, runtime, tiqFrom, type Admin } from './admin';
import { arena, arenaLocked, onAward, startArenaSync } from './arenaState';
import { createAnnouncements } from './broadcasts';
import {
  MIN_SEATS, ROOM_WAIT_MS, createRoom, difficultyFor, isAutomated, lobbyLine, rewardEligible, seatBadge,
  seatName, sizesOf, startEarly, type BotTier, type Room,
} from './room';

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
const chips = [
  $<HTMLDivElement>('chip-0'), $<HTMLDivElement>('chip-1'),
  $<HTMLDivElement>('chip-2'), $<HTMLDivElement>('chip-3'),
];
const dots = $<HTMLSpanElement>('dots');
/** The blitz ring and its seconds: seat 0's markup, carried to whichever seat the local player is. */
const timerRing = chips[0].querySelector<HTMLElement>('.timer');
const timerNum = chips[0].querySelector<HTMLElement>('.timer-n');
const wallBadges = [
  $<HTMLSpanElement>('walls-0'), $<HTMLSpanElement>('walls-1'),
  $<HTMLSpanElement>('walls-2'), $<HTMLSpanElement>('walls-3'),
];
/** One corner-flag host and one XP pill per seat, in seat order — the identity half of a chip. */
const flagBadges = [0, 1, 2, 3].map((p) => $<HTMLSpanElement>(`flag-${p}`));
const xpPills = [0, 1, 2, 3].map((p) => $<HTMLSpanElement>(`xp-${p}`));
const xpNums = [0, 1, 2, 3].map((p) => xpPills[p].querySelector<HTMLElement>('.xp-n'));
/** The dock itself. `data-players` is how CSS is told how many chips it is laying out — two keep the
 *  generous one-row layout, three and four reflow to a compact 2-up block (see the reflow rule).
 *  `data-seats` is written alongside it: the older probes read that one, and it costs nothing. */
const chipsEl = $<HTMLElement>('chips');
const sheetPause = $<HTMLElement>('sheet-pause');
const sheetQuit = $<HTMLElement>('sheet-quit');
const reward = $<HTMLParagraphElement>('reward');
const rewardN = $<HTMLSpanElement>('reward-n');

/* walls-to-place readout on each chip: repaints only when the number changes. One slot per seat the
   rules allow, so a four-way race has somewhere to put its fourth badge. */
const shownWalls: number[] = [-1, -1, -1, -1];
/** The race's budget per seat: the rules scale it with the number of contenders, so it is read
 *  off the live board rather than assumed — a 4-way hands out 5 walls, a 3-way 6, a duel the classic 8. */
let wallsEach: number = CONFIG.WALL_LIMIT;
function setWalls(p: Player, left: number) {
  const el = wallBadges[p];
  if (!el) return;                    // a seat this race does not field
  if (shownWalls[p] === left) return;
  const first = shownWalls[p] < 0;
  shownWalls[p] = left;
  const num = el.querySelector<HTMLElement>('.wall-n');
  if (num) num.textContent = String(left);
  el.classList.toggle('depleted', left <= 0);
  el.setAttribute('aria-label', `Walls left: ${left} of ${wallsEach}`);
  if (first) return;               // the opening paint is not a placement: no pop
  el.classList.remove('pop');
  void el.offsetWidth;             // restarting the animation needs a reflow between the two class changes
  el.classList.add('pop');
}

/* a player with no walls taps a groove: the badge pulses in warning and a toast says why */
let wallWarnTimer = 0;
function warnNoWalls(p: Player) {
  const el = wallBadges[p];
  if (!el) return;
  if (motionReduced()) { el.classList.remove('depleted'); return; }
  el.classList.remove('depleted', 'dry-warn');
  void el.offsetWidth;
  el.classList.add('depleted', 'dry-warn');
  clearTimeout(wallWarnTimer);
  wallWarnTimer = window.setTimeout(() => el.classList.remove('dry-warn'), 650);
}

/* The mine key is the local strip's own right-hand tactical pod. `seatChrome()` moves it onto
   whichever strip the local seat actually holds, so an online race never arms a mine from the
   rival's strip — the one thing the old welded-in segment could not say. */
const mineBtn = $<HTMLButtonElement>('mine-btn');
const mineN = $<HTMLElement>('mine-n');
let shownMines = -1;
function setMineCount(left: number) {
  if (shownMines === left) return;
  shownMines = left;
  mineN.textContent = String(left);
  mineBtn.setAttribute('aria-label', left
    ? `Bury a mine — ${left} of ${CONFIG.MINES_PER_TEAM} left`
    : 'Bury a mine — none left');
}

/**
 * Fog of war on every card that is not yours: the cell never holds a number. `live` means "there
 * is a cache in the ground, size unknown"; `spent` is only ever painted when the public record
 * proves it — every charge that seat buried has already gone off in front of both players. In an
 * online race the opponent's untriggered mines are stripped by `view()`, so `minesLeft` can only
 * ever over-report their stash, which is exactly why a zero here is safe to show.
 */
const shownFog: (string | null)[] = [null, null, null, null];
function setFog(p: Player) {
  const cell = chips[p]?.querySelector<HTMLElement>('.mine-fog');
  if (!cell) return;
  const spent = minesLeft(state, p) <= 0;
  const next = spent ? 'spent' : 'live';
  if (shownFog[p] === next) return;
  shownFog[p] = next;
  cell.dataset.fog = next;
  const n = cell.querySelector<HTMLElement>('.fog-n');
  if (n) n.textContent = spent ? '0' : '?';
  cell.setAttribute('aria-label', spent ? 'Mines: none left' : 'Mines: count concealed');
}

/* the trigger shakes the board itself, once. A mine is a 2px micro-shake, a log the full 4px.
   Reduced motion never shakes anything. */
let shakeTimer = 0;
function shake(micro = false) {
  if (motionReduced()) return;
  wrap.classList.remove('shake', 'micro');
  void wrap.offsetWidth;                 // restarting the animation needs a reflow in between
  if (micro) wrap.classList.add('micro');
  wrap.classList.add('shake');
  clearTimeout(shakeTimer);
  shakeTimer = window.setTimeout(() => wrap.classList.remove('shake', 'micro'), micro ? 400 : 700);
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
    showNote(reason === 'MATCHING_LOCKED'
      ? 'The arena is locked — new matches are paused.'
      : reason === 'SEASON_ENDED'
        ? 'The season ended — standings are final.'
        : reason === 'MAINTENANCE'
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
  /* the Command Center's own lock, mirrored from the server: new entries stop, live races play out */
  const board = arena();
  if (arenaLocked(board)) {
    impact('light');
    notify('warning');
    showNote(board.status === 'finale' || board.endsAt <= Date.now()
      ? 'The season is closed — standings are final.'
      : 'The arena is locked — new matches are paused.', false, 2600);
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
  if (id !== 'game') { cancelTutorial(); pauseGame(); }   // the board only ticks while it is on screen
  if (id === 'home') admin?.relayout();   // the launcher only has a height once Home is up
  syncLoop();
});

/** Telegram's BackButton, when the client has one, and the in-page back buttons both land here. */
const setBackButton = onBackPress(() => onBack());

function onBack() {
  impact('light');
  /* the coach marks own the board until they are read or skipped: back is the same door as the
     skip key, never a pause sheet opening underneath the overlay */
  if (tutorialActive) { tutorial?.skip(); return; }
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

/**
 * Seat 0 is you in a local race; the matchmaker decides in an online one, so every rule that used
 * to say "the human" says `localSide` instead — the input lock, the clock, the mine key, the
 * chips, the payout and the verdict all follow the side this screen is actually playing.
 */
let localSide: Player = 0;
/** The live online seat, when this race is against a person instead of the machine. */
let active: OnlineSession | LobbyRace | null = null;
/** Why an online race ended without a finish line, for the panel's own caption. */
let forfeit: RaceEnd['why'] | null = null;
const rivalSide = (): Player => (localSide === 0 ? 1 : 0);
/** The two sides this screen actually paints: the player's chosen colour, the rival in the other. */
const currentPerspective = (): Perspective => ({ local: localSide, rival: rivalSide(), color: pieceColor() });
/** `You`, and the name on each other chip: local names in a bot race, the player's in an online one. */
const TEAM_NAME: Record<number, string> = { 0: 'You', 1: 'Bot' };

/**
 * The lobby this race was launched from, or null for a plain race. A room names its seats and says
 * which of them the machine owns — a bot backfilled into a vacancy and a seat a person walked out
 * of are the same thing to everything downstream (`isAutomated`), so the dock, the turn dispatcher
 * and the payout each ask one question instead of three.
 */
let room: Room | null = null;

/** Swap this for a network-backed implementation to go multiplayer. */
interface Opponent { think(s: GameState): Promise<Action> }
/**
 * A bot brain. The level can be fixed (a practice race plays the drawer's pick) or resolved per
 * seat (a room ladders its machine seats), so a four-seat room can field Hard, Normal and Easy at
 * once and the dispatcher never has to know which seat it is thinking for.
 */
const makeBot = (d: Difficulty | ((seat: Player) => Difficulty)): Opponent => ({
  think: (s) => {
    const level = typeof d === 'function' ? d(s.turn) : d;
    return new Promise((res) => setTimeout(() => res(botAction(s, level)), botThinkMs(level)));
  },
});

let difficulty: Difficulty = menuState.difficulty;
/** The seats this race fields, one entry per ball count: `[1, 1]` for a duel, `[1, 1, 1, 1]` for a
 *  four-way. It used to be a fixed pair; `MAX_TEAMS` is what the board can hold. */
let sizes: number[] = [...menuState.sizes];
let opponent: Opponent = makeBot(difficulty);
/** The seed this race's board was built on. Every bot seat derives its flag and its XP from it, so
 *  the four pills are stable for the whole race instead of reshuffling on every repaint. */
let raceSeed = 1;

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
  const d = distField([...s.walls, w], s.cols, s.rows);
  return s.balls.some((b) => d[b.pos.r * s.cols + b.pos.c] < 0) ? 'blocked' : 'overlap';
}

const renderer = createRenderer(canvas, { theme });
const confetti = createConfetti(confettiEl);
const toVec = (p: Pos): Vec => ({ x: p.c + 0.5, y: p.r + 0.5 });

/** Where the board's own numbers are published for CSS: the card that holds both the board and the
 *  dock, so one write reaches `.board-wrap` and `.chips` alike. */
const boardCard = wrap.closest<HTMLElement>('.card') ?? wrap;

/**
 * Hand the grid the rules picked to CSS, which is what lets the board box size itself to the
 * board's own aspect instead of a hard-coded 2:3. Without it a 10x12 board letterboxes inside a
 * 2:3 box — the slab floats away from the box's top edge, and the goal crown that sits on it lands
 * further from the card's edge than the board it belongs to. Called on every `setBoard`, so a duel
 * and a party get their own box.
 */
function fitBoard(c: number, r: number) {
  boardCard.style.setProperty('--board-cols', String(c));
  boardCard.style.setProperty('--board-rows', String(r));
}

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
 * The seats this race actually fields, in seat order. Read off the live board rather than assumed:
 * the same screen runs a two-seat duel and a four-seat party, and every loop that used to walk the
 * fixed pair `[0, 1]` walks this instead.
 */
const roster = (): Player[] => Array.from({ length: state.teams.length }, (_t, i) => i);
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
/** One entry per seat: what that seat did last. Sized to the live roster in `restart()`. */
const marks: (Mark | null)[] = Array.from({ length: state.teams.length }, () => null);
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

/** The first-match hands-on lesson holds the clock and the full bot dispatcher, but never the
 *  board itself: its stage gate decides which real tap is live. */
let tutorialActive = false;
let tutorial: Tutorial | null = null;
/** The first local race is also the lesson: its board is built without the rolling log. */
let tutorialRace = false;
const tutorialStage = (): TutorialStage | null => (tutorialActive ? tutorial?.stage ?? null : null);

/** The turn's own gate. The lesson layers on top of this through `isTutorialActionAllowed()`. */
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

/**
 * A tap on your own pawn while the mine key is down: the key lets go and the pawn comes to hand in
 * one gesture, so placement mode can never trap the player. `ui()` drops the key's lit state and
 * paints the pawn's dots on the same frame.
 */
function pickFromMine(id: number) {
  mineGhost = null;
  setMode(pickBallFromMine(mode(), id));
  clearNote();
  ui();
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
 * How the race was decided: a finish line, a stalemate the engine called, or a rival who did not
 * stay to see it. A forfeit is a win that never touched the board, and an adjudication is a win the
 * board itself awarded, so each says so rather than pretending a ball crossed.
 */
function subLine(won: boolean): string {
  const rival = active?.opponent.name ?? 'The bot';
  if (state.adjudicated) {
    return won
      ? 'Stalemate called — your ball was nearest FINISH.'
      : 'Stalemate called — the nearest ball to FINISH took the race.';
  }
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
     Center's Double-Coins multiplier scales what the settlement pays. A seat the machine held is
     the one exception: it pays nothing and it touches no ladder, because a bot is not a person and
     neither is a seat somebody walked out of. */
  const mine = !room || rewardEligible(room, localSide);
  const earned = mine ? recordGame({ difficulty, won }, runtime.coinMult) : 0;
  recordRace(earned);                   // the Command Center's Stats tab counts the day's duels
  setBalance(rewardN, 0);                 // every payout counts up from zero
  setBalance(rewardN, earned);
  reward.hidden = false;
  menuBtn.disabled = true;              // the panel already offers Play again and Menu
  again.focus({ preventScroll: true });
}

/**
 * The beat the goal zone gets for itself. The rules land a winner the moment the ball touches row 0,
 * and the renderer answers with a golden light sweep along the unified finish bar — but the result
 * card lays a scrim over the whole board, so a card that lands on the same tick buries the one thing
 * the board does to mark the line being taken. The card waits for the pulse instead.
 */
const GOAL_BEAT_MS = 600;
let goalBeat = 0;
function armGoalBeat() {
  if (overlayOpen || goalBeat) return;
  menuBtn.disabled = true;               // no pause sheet opening onto a race that is already settled
  goalBeat = window.setTimeout(() => { goalBeat = 0; showOverlay(); }, GOAL_BEAT_MS);
}
const clearGoalBeat = () => { if (goalBeat) window.clearTimeout(goalBeat); goalBeat = 0; };

function ui() {
  /* a pick that no longer belongs to you, or to a ball that is gone, is dropped here */
  if (selected !== null && (state.winner !== null || state.turn !== localSide
    || !state.balls.some((b) => b.id === selected))) selected = null;
  const live = canAct();
  const stage = tutorialStage();
  /* the key only ever covers one turn, and only while there is still a mine to bury */
  if (!live || minesLeft(state, localSide) <= 0) mineArmed = false;
  /* at the start of a human turn, put that turn's first ball in hand so the dots light up at once —
     unless a wall preview is already up, since that owns the board until it is confirmed or dropped.
     The lesson's first step is the player's own pick, so it never auto-picks behind the card. */
  if (live && !tutorialActive && !mineArmed && !ghost && selected === null && autoPicked !== state.turn) {
    const auto = selectionFor(state);
    if (auto) { selected = auto.id; autoPicked = state.turn; }
  }
  /* the dots belong to the ball in hand and to nothing else: a wall preview or the mine key
     suppresses them outright, so a dashed bar is never drawn under a selection ring */
  hints = dotsFor(mode());
  if (stage === 'select') hints = [];
  else if (stage === 'move') {
    const step = tutorialMoveTarget();
    hints = step ? [step.to] : [];
  }
  mineHints = live && mineArmed ? mineCells(state, localSide) : [];
  if (stage === 'mine-place' && mineArmed) {
    const target = tutorialMineTarget();
    mineHints = target ? [target.cell] : [];
  }
  /* an armed cell that is no longer placeable — the turn moved on, or a ball rolled over it */
  if (mineGhost && !mineHints.some((h) => sameCell(h, mineGhost))) mineGhost = null;
  armCapsules();
  /* the rival's dots tick for a bot's think time and for a person's just the same */
  const thinking = rivalTurn() && !paused && !tutorialActive;

  dots.classList.toggle('on', thinking);

  mineBtn.setAttribute('aria-pressed', String(mineArmed));
  /* the lesson leaves exactly one live key per stage: only the ARM step enables the mine pod */
  mineBtn.disabled = tutorialActive ? stage !== 'mine-arm' : (!live || minesLeft(state, localSide) <= 0);
  setMineCount(minesLeft(state, localSide));

  /* whose turn it is rides on the chips now: a clay glow, a lift, and the countdown ring */
  const seat = state.winner ?? state.turn;
  for (const p of roster()) {
    chips[p]?.classList.toggle('active', state.winner === null && state.turn === p && !paused);
    chips[p]?.classList.toggle('thinking', thinking && p === state.turn);
    setWalls(p, wallsRemaining(state, p));
    if (p !== localSide) setFog(p);
  }
  /* the flags and the XP pills ride along: both are diffed, so this is a comparison per seat */
  paintSeatIdentity();
  const spoken = state.winner !== null ? `${TEAM_NAME[seat]} win${seat === localSide ? '' : 's'}`
    : seat === localSide ? 'Your turn' : `${TEAM_NAME[seat]}'s turn`;
  if (spoken !== saidTurn) { saidTurn = spoken; announce.textContent = spoken; }

  /* one turn per seat makes a round; the counter is the UI's, the rules keep none */
  roundLabel.textContent = `Round ${Math.floor(turnsPlayed / Math.max(1, state.teams.length)) + 1}`;
  /* the strike badge is painted at the heart of the finish crown, so the crest yields to it from
     inside the renderer — the board is visibly inert while a trunk is on it */
  wrap.classList.toggle('rolling', rolling);
  paintClock();

  if (state.winner === null && overlayOpen) {
    overlayOpen = false;
    overlay.hidden = true;
    menuBtn.disabled = false;
  }
  if (state.winner !== null) armGoalBeat();
  /* the wall's live-play intermission ends on the board's own terms: two real rival rows, then
     this seat's turn. Called last so a resumed lesson's own repaint is the final word. */
  if (waitingForMineTrigger) resumeMineLesson();
}

/** A bot turn parked until the board is clear of a rolling log. */
const untilRoll = () => (rolling
  ? new Promise<void>((res) => { rollHeld.push(res); })
  : Promise.resolve());

async function runOpponent() {
  if (state.winner !== null || !wantsOpponent() || tutorialActive) return;
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
  const blocked = ev.stopRow < next.rows - 1;
  rollT0 = strike; rollStop = ev.stopRow;
  renderer.rollLog(ev, t0);
  audio.play('log', { at: strike });    // the roll's voice is cue'd to the frame the trunk moves
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
  /* where the ball actually came to rest — after a blast that is two rows further down */
  const landed = moved === null ? null : ballById(next, moved)?.pos ?? null;
  if (a.kind === 'move' && from && landed) {
    marks[by] = { kind: 'step', from, to: landed };
    /* one voice per step, whoever took it; a tap in the hand rides along for the local player.
       Both are pure side effects — a locked webview or a muted switch must never touch the turn
       the rules just moved. */
    audio.play('move');
    if (by === localSide && !remote) impact('light');
  }
  else if (a.kind === 'wall') { marks[by] = { kind: 'wall', spec: a.wall }; audio.play('move'); impact('medium'); }
  if (a.kind === 'mine') { mineArmed = false; audio.play('move'); }   // one mine per trip to the key
  state = next;
  /* the mine lesson's intermission gate reads real plays, never a scripted walk */
  if (waitingForMineTrigger) countMineStride();
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
    /* the wave throws the ball that set it off: the renderer arcs it over whatever wall it clears */
    renderer.blast(blast.cell, moved !== null && from && landed
      ? { id: moved, from, to: landed }
      : undefined);
    shake(true);
    audio.play('explosion');
    detonation();
    showNote(`Mine! ${TEAM_NAME[by]} ${by === localSide ? 'were' : 'was'} thrown back `
      + `${cells} cell${cells === 1 ? '' : 's'}`, false, 2600);
  }
  /* a log that just landed is a fresh object every time, so identity is the play-once flag */
  if (next.lastEvent && next.lastEvent !== playedLog) playLog(next.lastEvent, next);
  ui();
  startClock();          // the turn has moved on: the next seat gets its own allowance
  if (state.winner !== null) notify(state.winner === localSide ? 'success' : 'error');
  else if (wantsOpponent() && !tutorialActive) void runOpponent();
  return true;
}

/**
 * Blitz clock. One interval, owned by the turn that started it: `startClock` is the only thing that
 * arms it, and it arms nothing unless a human seat is actually up — so a bot's think time, an open
 * sheet, a finished race and a hidden webview all leave the timer cleared rather than running blind.
 *
 * The allowance itself is the Command Center's (`runtime.blitz`), which now ships at the engine's
 * own canonical limit — `CONFIG.TURN_TIME_LIMIT`, 8 seconds — and can only be stepped through
 * `BLITZ_STEPS`. `turnLimit()` is the one reader: the clock, the ring's fraction and the first
 * paint all take the same number, so the HUD can never advertise a length the interval is not
 * counting down.
 */
const URGENT_AT = 3;
/** the amber step, before the last three seconds: 5s or less is a warning, 3s or less an alarm */
const WARN_AT = 5;
/** the ring's whole arc: the SVG's r=21, so C = 2·π·21. The dash offset drains from 12 o'clock. */
const RING_C = 2 * Math.PI * 21;
let turnTimerId: number | null = null;
/** The live allowance in whole seconds; a malformed one falls back to the engine's limit. */
const turnLimit = (): number => {
  const n = Math.round(runtime.blitz);
  return Number.isFinite(n) && n > 0 ? n : CONFIG.TURN_TIME_LIMIT;
};
/** The seconds left on the live turn, reset to `turnLimit()` by every `startClock`. */
let turnSecondsLeft: number = turnLimit();
/** the fraction the ring last showed, so a refill never animates backwards through 1s of easing */
let ringFrac = -1;

/** Is the countdown this seat's to lose? */
const clockLive = () => !paused && !overlayOpen && !document.hidden && router.current === 'game'
  && state.winner === null && state.turn === localSide && !rolling && !tutorialActive;

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
  turnSecondsLeft = turnLimit();
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
  const left = Math.max(0, turnSecondsLeft);
  /* the number is painted whether or not the clock runs: an idle seat shows the turn's length, not
     whatever the last race happened to leave in the middle of the ring */
  timerN.textContent = String(left);
  const live = clockLive();
  chip.classList.toggle('timing', live);
  if (!live) { chip.removeAttribute('data-timer'); return; }
  const frac = left / turnLimit();
  timerFill.style.transition = frac < ringFrac ? '' : 'none';
  ringFrac = frac;
  timerFill.style.strokeDashoffset = String(RING_C * (1 - frac));
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
  cancelTutorial();
  gen++;
  /* Every local race rolls a fresh seed so no two telegraph the same lanes; an online race takes
     the seed the matchmaker handed both sides, so the logs and the hazards are the same board. */
  raceSeed = active ? active.seed : (Math.random() * 0x7fffffff) | 0;
  state = newGame(sizes, { hazards: runtime.hazards && !tutorialRace, seed: raceSeed });
  /* This screen's colours are client-side: the local seat wears the save's red/blue choice and the
     rival wears the other one. Set before the first paint of the new board. */
  renderer.setPerspective(currentPerspective());
  /* The grid the rules picked for this race — a duel keeps 8 columns, a 3- or 4-contender race gets
     10 — and the wall budget that goes with it. Both are read off the board, never assumed, so a
     menu change between races cannot leave the canvas painting the wrong lattice. `fitBoard` hands
     the same two numbers to CSS, which is what sizes the board box to the grid's own aspect. */
  renderer.setBoard(state.cols, state.rows);
  fitBoard(state.cols, state.rows);
  wallsEach = wallBudget(state.balls.length);
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
  /* the roster may have grown or shrunk since the last race: one mark per seat, and every seat's
     wall badge starts unread so the opening paint is not mistaken for a placement */
  marks.length = state.teams.length;
  marks.fill(null);
  shownWalls.fill(-1);
  /* a new race means new rivals: their flags and their XP are drawn off the new seed, so the caches
     that guard the repaints have to forget the old ones or the chips would keep last race's faces */
  shownFlags.fill(undefined);
  shownXp.fill(-1);
  paintRoster();
  paintSeatIdentity();
  shownMines = -1;
  shownFog.fill(null);
  turnsPlayed = 0;
  saidTurn = '';
  clearGoalBeat();
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

/**
 * Reveal exactly the chips this race fields. Two seats is the duel the dock was built for; three
 * and four reveal the extra seats the markup already carries. `data-seats` goes with them, because
 * the dock has to reflow — four 64px chips across a 360px card would leave 84px each and the ball
 * alone is 46 of them.
 */
function paintRoster(): void {
  const n = state.teams.length;
  /* `data-players` is the live one; `data-seats` is written beside it because the older probes read
     that name and it costs a string. Both say the same thing: how many chips the dock is laying out. */
  chipsEl.dataset.players = String(n);
  chipsEl.dataset.seats = String(n);
  /* The chip's class is the colour it wears on THIS screen: the local seat gets the player's
     chosen family, its rival the opposite, then the fixed gold / green order for extra seats.
     Online, the local seat can be seat 1 — the class follows the perspective, not the index. */
  const rivals = rivalSide();
  const extras = [0, 1, 2, 3].filter((p) => p !== localSide && p !== rivals);
  for (let p = 0; p < chips.length; p++) {
    const el = chips[p];
    if (!el) continue;
    const on = p < n;
    el.hidden = !on;
    const color = p === localSide ? pieceColor()
      : p === rivals ? (pieceColor() === 'red' ? 'blue' : 'red')
      : extras.indexOf(p) === 0 ? 'gold' : 'green';
    el.classList.toggle('red', color === 'red');
    el.classList.toggle('blue', color === 'blue');
    el.classList.toggle('gold', color === 'gold');
    el.classList.toggle('green', color === 'green');
    /* and it says who is holding it: `bot` for a seat the machine was backfilled into, `takeover`
       for one a person walked out of and the machine finished. Both are machine-controlled seats,
       and the dock never lets one read as a person. */
    const badge = room ? seatBadge(room, p) : null;
    if (badge) el.dataset.bot = badge;
    else delete el.dataset.bot;
  }
}

/* ---------- seat identity: the corner flag and the XP pill on every chip ---------- */

/** What a bot seat draws its flag and its XP from: one draw per seat, per race, off `raceSeed`. */
const RIVAL_FLAGS = [
  'DE', 'JP', 'BR', 'KR', 'FR', 'ES', 'IT', 'NL', 'SE', 'PL', 'TR', 'MX', 'CA', 'AU', 'IN', 'PT',
];
const RIVAL_XP = [1180, 2040, 880, 3120, 1545, 2680, 980, 2360];

/** Your XP: the ladder's own reading, so a race that settles moves it on the spot. */
const myXp = (): number => myTiq();

/**
 * The flag a seat flies when nothing is set: a real ISO code, never `flagPhoto`'s "—" clay chip. An
 * empty profile is the common case on a first run, and the dock has no room for a placeholder that
 * reads as a broken image — so an unset country, or a rival who arrived without one, gets this.
 */
const DEFAULT_FLAG = 'GB';

/** A seat's flag — yours off the profile, an online rival's off the wire, a bot's from the pool. */
function flagFor(p: Player): string | null {
  if (p === localSide) return profile.country || DEFAULT_FLAG;
  if (active && p === rivalSide()) return active.opponent.flag || DEFAULT_FLAG;
  return RIVAL_FLAGS[(raceSeed + p * 5) % RIVAL_FLAGS.length];
}

/**
 * What a machine-held seat wears where a person's country flag would sit: the bot glyph, in the
 * same 14px circle, so the dock reads "the machine is holding this seat" at a glance without a
 * single pixel of new layout.
 */
function botMark(): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ico bot-mark');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#i-bot');
  svg.append(use);
  return svg;
}

/** A seat's XP. Yours is live; a rival's is fixed for the race. */
function xpFor(p: Player): number {
  if (p === localSide) return myXp();
  if (active && p === rivalSide()) return active.opponent.tiq;
  return RIVAL_XP[(raceSeed + p * 3) % RIVAL_XP.length];
}

/** Comma-groups a count the way a scoreboard does, without the locale's own ideas about digits. */
const commas = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** What each chip already shows, so a repaint on every action costs a comparison and nothing else. */
const shownFlags: (string | null | undefined)[] = [undefined, undefined, undefined, undefined];
const shownXp: number[] = [-1, -1, -1, -1];

/**
 * Paints the identity half of every fielded chip: the corner flag welded to its sphere and the XP
 * pill beside its name. Both are diffed — a rival's identity is fixed for the race and `ui()` runs
 * on every action, so rewriting them each time would be pure churn. `flagPhoto` draws the flag, so
 * the HUD wears the same photo (and the same three-tier fallback) as the ladder and the profile.
 */
/**
 * Paints the identity half of every fielded chip: the corner badge welded to its sphere and the XP
 * pill beside its name. Both are diffed — a rival's identity is fixed for the race and `ui()` runs
 * on every action, so rewriting them each time would be pure churn. `flagPhoto` draws the flag, so
 * the HUD wears the same photo (and the same three-tier fallback) as the ladder and the profile.
 *
 * A seat the machine holds wears a bot mark in the flag's place instead. It is the same slot, the
 * same size and the same diff, so the dock's own layout budget — which has no room to spare at four
 * chips on a 360px card — is untouched, and a machine seat can never be mistaken for a country.
 */
function paintSeatIdentity(): void {
  for (const p of roster()) {
    const mark = room && isAutomated(room, p) ? 'bot' : 'flag';
    const code = mark === 'flag' ? flagFor(p) : mark;
    if (shownFlags[p] !== code) {
      shownFlags[p] = code;
      const host = flagBadges[p];
      if (host) {
        host.textContent = '';
        host.append(mark === 'bot' ? botMark() : flagPhoto(code, 'fp-hud'));
      }
    }
    const xp = xpFor(p);
    if (shownXp[p] !== xp) {
      shownXp[p] = xp;
      const n = xpNums[p];
      if (n) n.textContent = commas(xp);
      xpPills[p]?.setAttribute('aria-label', `${commas(xp)} XP`);
    }
  }
}

/**
 * The four chip swatches, in perspective order. `perspectiveRamps` is the same plan `render.ts`
 * draws the spheres and wall bars from, so the token on the board and the swatch on the chip can
 * never disagree about who is who. The mine key is dock furniture rather than a chip's child, so it
 * wears the local seat's colour from here too.
 */
function paintSeatTints(): void {
  const ramps = perspectiveRamps(localSide, rivalSide(), pieceColor());
  for (let i = 0; i < chips.length; i++) {
    const r = ramps[i];
    if (!r) continue;
    chips[i].style.setProperty('--tint', r.mid);
    chips[i].style.setProperty('--glow', r.glow);
  }
  const mine = ramps[localSide];
  if (mine) {
    mineBtn.style.setProperty('--tint', mine.mid);
    mineBtn.style.setProperty('--glow', mine.glow);
  }
}

function paintNames() {
  const me = ((tgUser()?.first_name || tgUser()?.username || 'You')).toUpperCase().slice(0, 14);
  const foe = (active ? active.opponent.name : 'Bot').toUpperCase().slice(0, 14);
  /* One name per seat that is actually fielded. Seat 0 and its rival keep the names they always
     had; the extra seats a party adds are numbered, so four chips never say the same thing twice. */
  for (const p of roster()) {
    const el = document.getElementById(`name-${p}`);
    if (!el) continue;
    const label = p === localSide ? me : p === rivalSide() ? foe : (TEAM_NAME[p] ?? `BOT ${p}`);
    el.textContent = label;
    /* the avatar well's monogram: one letter off the same name, so it can never disagree with it */
    const av = document.getElementById(`av-${p}`);
    if (av) av.textContent = (label.trim()[0] ?? '?').toUpperCase();
  }
  /* the race names itself where a race is being stopped or judged, not on every frame of play */
  const shape = sizes.length > 2 ? `${sizes.length}-player` : `${sizes[0]}v${sizes[1]}`;
  const mode = `${shape} · ${active ? 'Online' : `${difficulty[0].toUpperCase()}${difficulty.slice(1)}`}`;
  pauseMode.textContent = ` · ${mode}`;
  overMode.textContent = mode;
}

/**
 * The two pieces of seat-indexed chrome are the blitz ring (seat 0's markup) and the thinking dots
 * (seat 1's), but an online seat can be either side. The chips keep their names, colours, flags and
 * XP; only those two move — and only the ring and its seconds, never the whole capsule, which would
 * leave the destination seat wearing two spheres.
 */
function seatChrome(): void {
  const seatBall = chips[localSide]?.querySelector<HTMLElement>('.chip-ball');
  const rivalWho = chips[rivalSide()]?.querySelector<HTMLElement>('.who-line');
  if (!seatBall || !rivalWho || !timerRing || !timerNum) return;
  seatBall.append(timerRing, timerNum);   // this seat's own countdown ring
  rivalWho.appendChild(dots);             // the rival gets the thinking dots
  /* The tactical mine pod follows the seat too. The arm key rides the right end of your own
     strip, and the sealed fog pod it displaces goes back to seat 0 — so every rival strip still
     carries one. Without this an online seat on the right would arm a mine from the strip that
     says BOT. */
  const myStrip = chips[localSide];
  const seat0Strip = chips[0];
  const sealed = myStrip?.querySelector<HTMLElement>('.mine-fog') ?? null;
  if (myStrip) myStrip.append(mineBtn);
  if (sealed && seat0Strip && localSide !== 0) seat0Strip.append(sealed);
  shownFog.fill(null);                    // the cells just changed hands: repaint them from scratch
}

/** How a race starts: the local shape, plus the live seat when the matchmaker paired one. */
interface StartSetup {
  difficulty: Difficulty;
  /** one entry per seat — `[1, 1]` is a duel, `[1, 1, 1, 1]` a four-way. Capped at `MAX_TEAMS`. */
  sizes: readonly number[];
  online?: OnlineSession | LobbyRace | null;
  /** The lobby this race came out of, when it came out of one: it names the seats, says which are
   *  the machine's, and pays only the seats a person actually held to the end. */
  room?: Room | null;
}

function startGame(setup: StartSetup) {
  cancelTutorial();
  /* Only a local bot race teaches, and only until the lesson has been finished or skipped. An
     online seat or a private room is somebody else's board: the lesson never covers it. */
  const wantsTutorial = shouldAutoStartTutorial({
    online: !!setup.online,
    room: !!setup.room,
    completed: hasCompletedTutorial(),
  });
  /* the lesson race is deterministic by design: no log may interrupt a hands-on step */
  tutorialRace = wantsTutorial;
  /* menuState.difficulty is the single source: the Choose-mode sheet persists it live,
     so every start path (vs Bot card, Play) runs the level the sheet shows. */
  difficulty = menuState.difficulty;
  /* An online seat brings its own board and side; a local race is always seat 0 against the rest. */
  active = setup.online ?? null;
  forfeit = null;
  localSide = active ? active.side : 0;
  /* A room's seats are its own — one ball per seat, however many it filled with bots. */
  room = setup.room ?? null;
  sizes = active ? [...active.sizes]
    : room ? sizesOf(room)
    : setup.sizes.slice(0, MAX_TEAMS);
  /* Name every seat before the first paint: `You` for this screen, a room's own seat names (the
     machine's included), and a numbered bot for each extra seat a party adds. */
  for (let p = 0; p < sizes.length; p++) {
    TEAM_NAME[p] = room && !isAutomated(room, p) && p !== localSide
      ? seatName(room, p)
      : `Bot${p > 1 ? ` ${p}` : ''}`;
  }
  TEAM_NAME[localSide] = 'You';
  if (active && !room) TEAM_NAME[rivalSide()] = active.opponent.name;
  view.human = localSide;
  /* One brain per seat: a room ladders its machine seats, a plain race plays one level throughout. */
  const lobby = room;
  opponent = makeBot(lobby ? (seat) => difficultyFor(lobby, seat) : difficulty);
  paused = false;
  restart();
  seatChrome();
  paintSeatTints();       // the mine key is dock furniture now: it wears the local seat's colour
  paintNames();
  paintSeatIdentity();
  /* a networked board cannot be restarted into the same seat: the pause sheet only offers leaving */
  $('pause-restart').hidden = !!active;
  /* replaying the lesson is a local-bot privilege only; a person or a private room owns the board */
  $('pause-tutorial').hidden = !!active || !!room;

  if (active) {
    const session = active;
    /* the rival's moves come through the same door the bot's do, so walls, mines, log strikes and
       the blitz hand-off all animate exactly as they do offline */
    session.onMove((action, side) => {
      if (state.winner === null && side === state.turn) play(action, true);
    });
    /* the rival's emote: the same bubble and the same "Haha!" as a local tap, over their own pawn */
    session.onEmote((emote) => chat.inboundEmote(emote));
    /* the rival's tactical line: their (lang, index) pair looked back up in the same closed table */
    session.onPhrase((lang, index) => chat.inboundPhrase(lang, index));
    session.onEnd((end) => endOnline(end));
    session.onReject(() => {
      notify('error');
      showNote('Move refused — the two boards disagree', true, 2400);
    });
  }

  router.go('game');
  if (wantsTutorial) beginTutorial();
  tutorialRace = false;       // the board already has (or has not) its log for this race
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
  cancelTutorial();                 // leaving mid-lesson does not count as having read it
  /* a race that ended inside the goal beat still has to be paid out before the board goes away */
  if (goalBeat) { clearGoalBeat(); showOverlay(); }
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

/**
 * The mine key's tap branch: your own pawn leaves placement mode and comes to hand, while any other
 * tap runs the two-tap flow — the first arms the square, the second buries it.
 */
function tapMine(hit: Hit | null): boolean {
  /* your own pawn is the board's way out of placement mode: the key lets go, the pawn is picked */
  if (hit?.kind === 'ball') { impact('light'); pickFromMine(hit.id); return true; }
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

/** The lesson's vocabulary for a hit-test result. */
function tutorialHitAction(hit: Hit | null): TutorialAction | null {
  if (!hit) return null;
  switch (hit.kind) {
    case 'ball': return { kind: 'select', ball: hit.id };
    case 'move': return { kind: 'move', to: hit.to };
    case 'wall':
    case 'confirm': return { kind: 'wall', spec: hit.spec };
    case 'mine':
    case 'mine-confirm': return { kind: 'mine', cell: hit.cell };
    default: return null;
  }
}

/**
 * The tutorial action gate. Every door that can change the board asks this first; while the lesson
 * is up only the exact target its current stage is pointing at may pass. Outside the lesson every
 * door is open, so the normal game never pays for the check.
 */
function isTutorialActionAllowed(action: TutorialAction): boolean {
  if (!tutorialActive) return true;
  return tutorial?.allows(action) ?? false;
}

/**
 * The lesson's own tap: hit-test the REAL board, refuse anything but the live target, then perform
 * the real action. There is no proxy button — the spotlight is a hole in the input blocker, so the
 * canvas receives this tap exactly as it would after the lesson.
 */
function tutorialTap(p: Vec) {
  /* Step 1 is the GOAL, not a board action: the FINISH banner is the target, and a tap anywhere
     inside its spotlight (or the card's Next key, wired in tutorial.ts) opens step 2. */
  if (tutorialStage() === 'finish') {
    const goal = tutorialFinishTarget();
    const box = canvas.getBoundingClientRect();
    if (goal && tutorialSpotHas(goal, box.left + p.x, box.top + p.y)) {
      impact('light');
      tutorial?.advance();
    } else {
      tutorial?.nudge();
    }
    return;
  }
  const stage = tutorialStage();
  let action = tutorialHitAction(at(p));
  /* Step 3 is forgiving by design: both halves accept a tap anywhere in the spotlight — not only
     the hairline groove. The first tap previews; the second commits, exactly as live play does. */
  if (stage === 'wall-preview' || stage === 'wall-confirm') {
    const target = tutorialWallTarget();
    const box = canvas.getBoundingClientRect();
    if (target && tutorialSpotHas(target.spot, box.left + p.x, box.top + p.y)) {
      action = { kind: 'wall', spec: target.spec };
    }
  }
  if (!action || !isTutorialActionAllowed(action)) { tutorial?.nudge(); return; }
  const L = renderer.layout();
  renderer.ripple((p.x - L.ox) / L.cell, (p.y - L.oy) / L.cell, localSide);
  switch (action.kind) {
    case 'select':
      impact('light');
      pick(action.ball);
      break;
    case 'move':
      disarmWall();
      impact('light');
      if (!play({ kind: 'move', ball: selected ?? undefined, to: action.to })) return;
      break;
    case 'wall': {
      const wall: Wall = { ...action.spec, owner: state.turn };
      if (stage === 'wall-preview') {
        /* the first tap only shows the real dashed ghost — the wall is not spent until tap two */
        if (!wallOk(state, wall)) { tutorial?.nudge(); return; }
        impact('light');
        setMode(previewWall(mode(), { spec: action.spec, ok: true, armed: false, p: state.turn }));
        break;
      }
      if (!wallOk(state, wall) || !play({ kind: 'wall', wall })) { tutorial?.nudge(); return; }
      break;
    }
    case 'mine':
      if (!play({ kind: 'mine', cell: action.cell })) { tutorial?.nudge(); return; }
      break;
    case 'mine-arm':
      return;   // the arm key is a dock button, never a board tap
  }
  tutorial?.notify(action);
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
    /* Hovering is a preview — but only while no ball is in hand. `previewWall` puts the ball back
       down, so a pointer crossing a groove on its way to a legal-move dot would otherwise wipe the
       dots and cancel the pick mid-travel. A picked ball owns the pointer until it is played or put
       down; a groove opens a wall on an explicit tap instead. */
    if (holdsBall(mode()) || ghost?.armed) return;
    /* an armed ghost keeps its slot and its caps, and a spent budget shows none */
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
  if (tutorialActive) { tutorialTap(p); return; }
  const L = renderer.layout();
  renderer.ripple((p.x - L.ox) / L.cell, (p.y - L.oy) / L.cell, localSide);   // the tap answers at once
  if (e.pointerType === 'mouse') onMouse(p, true);
  else onTouch(p);
});

canvas.addEventListener('pointermove', (e) => {
  if (tutorialActive || e.pointerType !== 'mouse') return;
  onMouse(local(e), false);
});
canvas.addEventListener('pointerleave', () => {
  if (tutorialActive) return;
  if (ghost && !ghost.armed) setMode({ ...mode(), preview: null });
});

mineBtn.addEventListener('click', () => {
  if (tutorialActive) {
    const action: TutorialAction = { kind: 'mine-arm' };
    if (!isTutorialActionAllowed(action)) { tutorial?.nudge(); return; }
    armMine(true);
    tutorial?.notify(action);
    return;
  }
  armMine(!mineArmed);
});

/* ---------- first-match tutorial: live targets and the held race behind them ---------- */

/**
 * A viewport rect for a cell block on the canvas. The renderer publishes its layout in CSS px,
 * but the canvas box is re-read every time so the screen's slide-in transform can never leave
 * the spotlight welded to where the board used to be.
 */
function boardRect(c: number, r: number, w = 1, h = 1): TutorialRect {
  const box = canvas.getBoundingClientRect();
  const L = renderer.layout();
  const sx = box.width / Math.max(1, L.w);
  const sy = box.height / Math.max(1, L.h);
  return {
    left: box.left + (L.ox + c * L.cell) * sx,
    top: box.top + (L.oy + r * L.cell) * sy,
    width: w * L.cell * sx,
    height: h * L.cell * sy,
  };
}

/** A dock element's own box, padded just enough to read as a cut-out around it. */
function elementSpot(el: Element | null | undefined, pad: number): TutorialSpot | null {
  const r = el?.getBoundingClientRect();
  if (!r || r.width < 1 || r.height < 1) return null;
  return {
    rect: { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 },
    radius: 12,
  };
}

/** Step 2's first half: the local player's first pawn, with nothing picked yet. */
function tutorialSelectTarget(): TutorialTargetSelect | null {
  if (state.turn !== localSide || state.winner !== null) return null;
  const ball = firstBall(state, localSide);
  if (!ball) return null;
  return { ball: ball.id, spot: { rect: boardRect(ball.pos.c, ball.pos.r), radius: 18 } };
}

/**
 * The forward step the lesson points at: straight ahead when the lane is open, otherwise the legal
 * step that gains the most ground. It is the same rules query the board uses, never a special case.
 */
function tutorialForwardStep(): { ball: Ball; to: Pos } | null {
  if (state.turn !== localSide || state.winner !== null) return null;
  const ball = selected !== null ? ballById(state, selected) : firstBall(state, localSide);
  if (!ball) return null;
  const opts = reachableBall(state, ball.id);
  if (!opts.length) return null;
  const straight = opts.find((p) => p.c === ball.pos.c && p.r === ball.pos.r - 1);
  if (straight) return { ball, to: straight };
  const forward = opts.filter((p) => p.r < ball.pos.r);
  const pool = forward.length ? forward : opts;
  const to = pool.reduce((a, b) => (
    b.r < a.r || (b.r === a.r && Math.abs(b.c - ball.pos.c) < Math.abs(a.c - ball.pos.c)) ? b : a
  ));
  return { ball, to };
}

function tutorialMoveTarget(): TutorialTargetMove | null {
  const step = tutorialForwardStep();
  return step ? { to: step.to, spot: { rect: boardRect(step.to.c, step.to.r), radius: 18 } } : null;
}

/** The groove under the spotlight: two cells wide, a band high, centred on the wall line. */
function grooveSpot(spec: WallSpec): TutorialSpot {
  return {
    rect: spec.o === 'h'
      ? boardRect(spec.x, spec.y - 0.24, 2, 0.48)
      : boardRect(spec.x - 0.24, spec.y, 0.48, 2),
    radius: 10,
  };
}

/** The rival the wall and mine steps are aimed at. */
const tutorialRival = (): Ball | null =>
  firstBall(state, rivalSide()) ?? state.balls.find((b) => b.team !== localSide) ?? null;

/**
 * Step 3's real target: a legal horizontal groove directly above the rival's pawn. The candidates
 * are tried nearest-first, then the whole lattice, so a crowded party board still finds a groove
 * that is genuinely legal instead of pointing at a refused slot.
 */
function tutorialWallTarget(): TutorialTargetWall | null {
  if (state.turn !== localSide || state.winner !== null) return null;
  if (wallsRemaining(state, localSide) <= 0) return null;
  const rival = tutorialRival();
  if (!rival) return null;
  const seen = new Set<string>();
  const candidates: WallSpec[] = [];
  const push = (spec: WallSpec) => {
    const key = `${spec.o}${spec.x},${spec.y}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(spec);
  };
  for (const y of [rival.pos.r, rival.pos.r - 1, rival.pos.r - 2]) {
    for (const x of [rival.pos.c - 1, rival.pos.c, rival.pos.c - 2]) push({ o: 'h', x, y });
  }
  for (let y = 1; y < state.rows; y++) {
    for (let x = 0; x <= state.cols - 2; x++) push({ o: 'h', x, y });
  }
  for (const spec of candidates) {
    if (wallOk(state, { ...spec, owner: localSide })) return { spec, spot: grooveSpot(spec) };
  }
  return null;
}

/**
 * Step 4's real target: the tile directly in the rival's forward path. It must be a legal mine
 * cell from the rules' own list, so the lesson never points at a square the action would refuse —
 * and it is read from the rival's LIVE position, never from a scripted route.
 */
function tutorialMineTarget(): TutorialTargetMine | null {
  if (state.turn !== localSide || state.winner !== null) return null;
  const cells = mineCells(state, localSide);
  if (!cells.length) return null;
  const rival = tutorialRival();
  const wanted: Cell[] = [];
  const want = (c: Cell) => { if (!wanted.some((w) => sameCell(w, c))) wanted.push(c); };
  if (rival) {
    want({ c: rival.pos.c, r: rival.pos.r - 1 });
    want({ c: rival.pos.c - 1, r: rival.pos.r - 1 });
    want({ c: rival.pos.c + 1, r: rival.pos.r - 1 });
    want({ c: rival.pos.c, r: rival.pos.r - 2 });
  }
  for (const cell of wanted) {
    const legal = cells.find((c) => sameCell(c, cell));
    if (legal) return { cell: legal, spot: { rect: boardRect(legal.c, legal.r), radius: 16 } };
  }
  /* every square ahead is spoken for: the nearest forward cell the rules still allow */
  const ahead = rival ? cells.filter((c) => c.r < rival.pos.r) : cells;
  const pool = ahead.length ? ahead : cells;
  let best = pool[0];
  if (rival) {
    let score = Infinity;
    for (const cell of pool) {
      const s = Math.abs(cell.c - rival.pos.c) * 4 + Math.abs(cell.r - (rival.pos.r - 1)) * 2;
      if (s < score) { score = s; best = cell; }
    }
  }
  return { cell: best, spot: { rect: boardRect(best.c, best.r), radius: 16 } };
}

/**
 * The gold FINISH banner: step 1's own target, and the re-pulse that answers the forward step.
 * Exactly the top row, so the guidance is the board's real goal line and never a floating band.
 */
const tutorialFinishTarget = (): TutorialSpot | null =>
  state.winner === null ? { rect: boardRect(0, 0, state.cols, 1), radius: 18 } : null;

/** The lesson's one bot beat: each machine seat steps once, deterministically, and hands back. */
async function tutorialReply(): Promise<void> {
  for (let guard = 0; guard < 8; guard++) {
    if (!tutorialActive || state.winner !== null || state.turn === localSide) return;
    const seat = state.turn;
    await new Promise<void>((res) => window.setTimeout(res, 50));
    if (!tutorialActive || state.winner !== null || state.turn !== seat) return;
    if (!play(getAutoMove(state, seat)) && !play({ kind: 'pass' })) return;
  }
}

/**
 * Stage change from the lesson: clear the preview when a wall stage ends, keep the player's own
 * ghost up on the confirm half, and let `ui()` re-derive the dots and the mine key's state.
 */
function syncTutorialUI(stage: TutorialStage | null) {
  if (!tutorialActive) return;
  const wallStage = stage === 'wall-preview' || stage === 'wall-confirm';
  if (!wallStage && ghost) setMode({ ...mode(), preview: null });
  /* 3A must start on a bare groove: the preview is the player's first tap, never a freebie */
  if (stage === 'wall-preview' && ghost) setMode({ ...mode(), preview: null });
  if (stage === 'wall-confirm') {
    const target = tutorialWallTarget();
    const wall: Wall | null = target ? { ...target.spec, owner: localSide } : null;
    setMode(previewWall(mode(), wall && wallOk(state, wall)
      ? { spec: target!.spec, ok: true, armed: false, p: localSide }
      : null));
  }
  ui();
}

/* ---------- the live-play intermission before the mine lesson ---------- */

/**
 * Step 3 has just put the wall up. The lesson has stepped aside; from here until the mine is
 * planted the board is ordinary live play. The two numbers below are the only gate: the rival's
 * real forward rows, counted off `play()`, and whose turn it is. Nothing is scripted, and nothing
 * opens while the rival is still parked on its starting row.
 */
let waitingForMineTrigger = false;
let mineStrides = 0;
let mineGateBall: number | null = null;
let mineGateRow = 0;

/** The wall stands: close the overlay, release the gate, and let the match actually play. */
function beginMineIntermission() {
  tutorialActive = false;
  document.body.classList.remove('tutorial-live');
  const rival = tutorialRival();
  mineGateBall = rival?.id ?? null;
  mineGateRow = rival?.pos.r ?? state.rows - 1;
  mineStrides = 0;
  waitingForMineTrigger = true;
  ui();
  startClock();
  if (wantsOpponent()) void runOpponent();
}

/** One real forward step of the gated rival, counted once per row gained. */
function countMineStride() {
  const ball = mineGateBall === null ? tutorialRival()
    : state.balls.find((b) => b.id === mineGateBall) ?? tutorialRival();
  if (!ball || ball.pos.r >= mineGateRow) return;
  mineGateRow = ball.pos.r;
  mineStrides++;
}

/**
 * The intermission is over: the rival has genuinely gained its two rows and the local seat is up.
 * Re-open the overlay on the mine half of step 4. A settled race ends the lesson instead.
 */
function resumeMineLesson() {
  if (!waitingForMineTrigger || tutorialActive || paused || overlayOpen || rolling) return;
  if (state.winner !== null) {
    waitingForMineTrigger = false;
    tutorial?.cancel();
    return;
  }
  if (state.turn !== localSide || mineStrides < TUTORIAL_LIVE_STEPS) return;
  waitingForMineTrigger = false;
  /* the player spent every charge during live play: there is no mine lesson left to teach */
  if (minesLeft(state, localSide) <= 0) { tutorial?.skip(); return; }
  mineArmed = false;
  mineGhost = null;
  selected = null;
  autoPicked = null;
  setMode(BOARD_IDLE);
  tutorialActive = true;      // before stopClock: clockLive reads this flag
  stopClock();
  tutorial?.resume();         // render() refreshes the board through syncTutorialUI -> ui()
}

function beginTutorial() {
  if (!tutorial || tutorial.active || active || room) return;
  waitingForMineTrigger = false;
  mineStrides = 0;
  mineGateBall = null;
  tutorialActive = true;      // before stopClock: clockLive reads this flag
  stopClock();
  /* step one is the player's own pick: clear the auto-pick the race painted before the lesson */
  selected = null;
  autoPicked = null;
  mineArmed = false;
  mineGhost = null;
  setMode(BOARD_IDLE);
  ui();
  tutorial.start();
}

/** Leaving the race, or starting another one, ends the lesson without marking it read. */
function cancelTutorial() {
  if (!tutorialActive && !waitingForMineTrigger) return;
  waitingForMineTrigger = false;
  mineStrides = 0;
  mineGateBall = null;
  tutorial?.cancel();
  tutorialActive = false;
}

tutorial = createTutorial({
  goal: tutorialFinishTarget,
  select: tutorialSelectTarget,
  move: tutorialMoveTarget,
  wall: tutorialWallTarget,
  mineArm: () => elementSpot(mineBtn, 8),
  minePlace: tutorialMineTarget,
  finish: tutorialFinishTarget,
  reply: tutorialReply,
  handoff: beginMineIntermission,
  refresh: syncTutorialUI,
  end(result) {
    tutorialActive = false;
    document.body.classList.remove('tutorial-live');
    setMode(BOARD_IDLE);
    mineGhost = null;
    autoPicked = null;
    if (result === 'cancelled') return;
    completeTutorial();       // read to the end or skipped: either way, not first-run again
    $<HTMLElement>('s-game').focus({ preventScroll: true });
    ui();
    startClock();
    if (wantsOpponent()) void runOpponent();
  },
});

/* The visible replay door: Pause → Replay tutorial restarts this local board with the lesson,
   without needing the console. It is hidden for online seats and private rooms. */
$('pause-tutorial').addEventListener('click', () => {
  impact('light');
  resetTutorialState();
  sheets.close();
  resumeGame();
  tutorialRace = true;         // a rehearsal is deterministic too: no rolling log
  restart();
  tutorialRace = false;
  beginTutorial();
});

/* DEV TRIGGER — console: `window.resetTutorial()` clears the saved lesson flag (and the bare
   `tutorial_completed` key from the brief) and reloads into a clean first run. */
(window as Window & { resetTutorial?: () => void }).resetTutorial = () => {
  resetTutorialState();
  location.reload();
};

again.addEventListener('click', () => {
  impact('light');
  /* a networked seat is not ours to restart: Play again means queue again */
  if (active) { active.close(); active = null; queueMatch(); return; }
  restart();
});
toMenu.addEventListener('click', () => { impact('light'); quitToMenu(); });
menuBtn.addEventListener('click', () => {
  if (tutorialActive || state.winner !== null) return;
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
      audio.play('move', { rate: SHOVE_RATE });   // the slide-back starts on its sound's own frame
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
  view.thinking = wantsOpponent() && !paused && !tutorialActive ? state.turn : null;
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
compete = createCompete({ router, sheets, sheet: sheetById, queue: () => queueMatch() });
createNotifications({ sheets });

/* ---- the announcement engine: urgent broadcasts raise the popup, feed ones the inbox ----
   The command center hands it every broadcast it dispatches; the same engine syncs the public
   feed on boot and whenever the app comes back to the foreground. */
const announcements = createAnnouncements({
  identity: () => ({
    country: profile.country,
    tiq: tiqFrom(profile.stats.wins, profile.stats.games, profile.tiqBonus),
  }),
  /* a target that names a screen goes there; anything else the engine treats as a link out */
  openRoute: (id) => {
    const target = id === 'compete' ? 'arena' : id;
    if (!/^[a-z-]{1,24}$/.test(target)) return false;
    if (!document.querySelector(`.screen[data-screen="${target}"]`)) return false;
    router.go(target);
    return true;
  },
});

/* ---- Admin Command Center: the Home FAB and the live-ops stage (src/admin.ts) ---- */
admin = createAdmin({
  note: showNote,
  tier: myTier,
  /* the stage is not a router screen, so it shows the BackButton itself while it is up */
  onToggle: (open) => setBackButton(open || router.current !== 'home'),
  /* a dispatch lands on this device the same beat it lands anywhere else */
  onBroadcast: (b) => announcements.receive(b),
  onBroadcastArchived: (id) => announcements.retract(id),
  /* the Controls tab's pinned one-liner raises the Command Dispatch modal on this device */
  onDispatch: (text) => announcements.dispatch(text),
});
admin.mount();
startArenaSync();
onAward((award) => {
  impact('medium');
  notify('success');
  const label = award.badge.toLowerCase().startsWith('season ') ? award.badge : `Season ${award.seasonNo} ${award.badge}`;
  showNote(`${label} — +${award.tiq} TIQ.`, false, 3600);
});
announcements.sync();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) announcements.sync();
});
/* the shop is the one screen that reads a switch at paint time: repaint it the moment it moves */
onRuntime(() => shop.refresh());

/* ---- the local party: 2, 3 or 4 seats on the board the rules pick for them ----
   The mode drawer's Practice card carries one segmented control, and it is the whole of the
   three- and four-player entry: pick 3 or 4 and Start runs a race of that many one-ball seats,
   which `dimsFor` lays out on the wide 10x12 board with the wall budget that goes with it. Two
   keeps the classic duel shapes the drawer already persists. It is a local-only setting — quick
   match and the private room hand the board to whoever is at the other end of the socket — so it
   is stored on its own key rather than in the menu's two-seat `sizes` tuple. */
const PARTY_KEY = 'detour.party.v1';
function loadPartySeats(): number {
  try {
    const n = Math.floor(Number(JSON.parse(localStorage.getItem(PARTY_KEY) ?? '2')));
    return n >= 2 && n <= MAX_TEAMS ? n : 2;
  } catch { return 2; }
}
let partySeats = loadPartySeats();

/**
 * Open the lobby for a local race and launch it. Every local race with more than one seat is a
 * room: the host holds seat 0 and the rest are backfilled with the machine, which is the same
 * contract the server's rooms run on — so the dock's bot badges, the per-seat difficulty and the
 * payout guard all behave here exactly as they do online. The board is one ball per seat, however
 * many seats the room holds, which is what `sizesOf` answers.
 *
 * The host pressing Start is the *early* start: a private room's seats stay open for the people who
 * were invited, and `tick()` fills them once the wait runs out. Doing it here rather than on a timer
 * is the honest reading of the tap — nobody presses Start to wait eight more seconds.
 */
function openLocalRoom(botTier: BotTier): Room {
  const me = tgUser();
  const host = {
    kind: 'human' as const,
    id: me?.id === undefined ? 'local' : String(me.id),
    name: (me?.first_name || me?.username || 'You').slice(0, 14),
  };
  return startEarly(createRoom({
    code: getGameMode().roomCode ?? createRoomCode(),
    seats: partySeats,
    host,
    waitMs: ROOM_WAIT_MS,
    botTier,
  }));
}

/** The Start label the seat count implies — the drawer's own label, spoken with the party size. */
function partyLabel(): string {
  return partySeats > 2 ? `Start ${partySeats}-player match` : 'Start practice match';
}

/** Paint the Players control, and make the Start label name the race it will actually run. */
function paintParty(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#sheet-game-modes [data-seats]')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.seats) === partySeats));
  }
  /* only the practice card honours the seat count, so only its label speaks it */
  if (getGameMode().id !== 'bot') return;
  const start = $<HTMLButtonElement>('gm-start');
  if (start && start.textContent !== partyLabel()) start.textContent = partyLabel();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#sheet-game-modes [data-seats]')) {
  b.addEventListener('click', () => {
    const n = Math.floor(Number(b.dataset.seats));
    if (!(n >= 2 && n <= MAX_TEAMS) || n === partySeats) return;
    partySeats = n;
    try { localStorage.setItem(PARTY_KEY, JSON.stringify(n)); } catch { /* stay in memory */ }
    impact('light');
    paintParty();
  });
}
/* The drawer owns `#gm-start` and rewrites it from `paintSheetState()` on every mode change, every
   difficulty tap and every init — and inside `setGameMode` it does so *after* its watchers fire, so
   an `onGameModeChange` hook can never be the last writer. The seat count is a *refinement* of the
   drawer's label rather than a competing one, so it is re-spoken whenever the drawer repaints:
   observe the label itself. The equality guard in `paintParty` means our own write cannot re-enter,
   so this settles in one pass instead of looping. */
function watchPartyLabel(): void {
  const start = $<HTMLButtonElement>('gm-start');
  if (!start) return;
  new MutationObserver(paintParty).observe(start, { childList: true, characterData: true, subtree: true });
}

/**
 * The lobby's roster as the `Room` the board already paints. A friends room is the same model the
 * dock reads — seat names, and which seats the machine holds — so nothing downstream needs to know
 * whether the roster came off a socket or out of a host's own taps. Trailing open wells are
 * trimmed: a two-player lobby plays a two-seat board, not a four-seat one with two bots nobody
 * asked for.
 */
function roomFromRoster(
  code: string,
  roster: ReadonlyArray<{ name: string; bot: boolean } | null>,
): Room {
  let last = roster.length - 1;
  while (last >= 0 && !roster[last]) last--;
  const count = Math.max(MIN_SEATS, last + 1);
  return {
    code,
    seats: Array.from({ length: count }, (_, i) => {
      const s = roster[i] ?? null;
      return {
        index: i,
        kind: s && !s.bot ? 'human' as const : 'bot' as const,
        id: s && !s.bot ? `seat:${i}` : `bot:${i}`,
        name: s ? s.name : `Bot${i > 1 ? ` ${i}` : ''}`,
        difficulty: menuState.difficulty,
        takenOver: false,
        connected: true,
      };
    }),
    waitMs: ROOM_WAIT_MS,
    openedAt: 0,
    launched: true,
    botTier: 'mixed',
  };
}

/* The drawer repaints its own Start label inside its own `onGameModeChange` handler, and
   subscribers fire in registration order — so this one is registered *after* `initGameModes`
   below, never before it. Registered first it would name the seat count and then be silently
   overwritten by `paintSheetState`, which is exactly the "Start practice match" bug. */
initGameModes(sheets, {
  /* the drawer already persisted sizes + difficulty, so the race it names is the race it runs */
  onStart: () => {
    const sel = getGameMode();
    /* Quick match is online: it queues on the searching stage first. Practice and a private
       room have nobody to wait for, so they start the race right away — on the seat count the
       Practice card is showing. Practice plays the level the drawer shows on every seat; a private
       room ladders its machine seats instead, which is the dynamic difficulty a room setting buys. */
    if (sel.id === 'duel_1v1' || sel.id === 'party_2v2') { queueMatch(); return; }
    const botTier: BotTier = sel.id === 'room' ? 'mixed' : menuState.difficulty;
    const lobby = openLocalRoom(botTier);
    showNote(lobbyLine(lobby, Date.now()), false, 2200, true);
    startGame({ difficulty: menuState.difficulty, sizes: sizesOf(lobby), room: lobby });
  },
  /* The friends lobby's Start. A lobby with a socket behind it has already asked the worker to
     launch, and the race arrives on `onRoomRace`; one without a socket plays its own roster here. */
  onRoomStart: (lobby: Lobby) => {
    const room = roomFromRoster(lobby.code, lobby.seats);
    showNote(lobbyLine(room, Date.now()), false, 2200, true);
    startGame({ difficulty: menuState.difficulty, sizes: sizesOf(room), room });
  },
  onRoomRace: (race: LobbyRace) => {
    const room = roomFromRoster(race.code, race.seats);
    startGame({ difficulty: menuState.difficulty, sizes: race.sizes, online: race, room });
  },
});
onGameModeChange(paintParty);
watchPartyLabel();
paintParty();
paintRoster();
paintNames();
/* the HUD ships wearing the allowance it will actually count down, before any race has started */
paintClock();
ui();
/* Quick chat: the one wiring call. It reads the race through getters — the board's state, the
   local seat, the two moments the rules close chat, and whether the screen is actually live — so
   nothing in the turn loop has to know the wheel exists. */
const chat = createChat({
  key: $<HTMLButtonElement>('chat-toggle'),
  lane: $<HTMLElement>('chat-lane'),
  chips,
  /* an online race relays every emote to the rival; offline the bubble is the whole message */
  onEmote: (id) => { active?.sendEmote(id); },
  /* and every phrase too, as the closed (lang, index) pair the sheet is built from */
  onPhrase: (lang, index) => { active?.sendPhrase(lang, index); },
  state: () => state,
  localSide: () => localSide,
  /* the seat's live pawn: its animated ball centre mapped through the renderer's own layout into
     viewport px, plus the cell the move dots are drawn from — so a bubble hangs over the token it
     belongs to and always clears the dot ring. */
  pawn: (seat) => {
    const v = ballViews.find((b) => b.team === seat);
    if (!v) return null;
    const L = renderer.layout();
    const box = canvas.getBoundingClientRect();
    return {
      x: box.left + L.ox + v.pos.x * L.cell,
      y: box.top + L.oy + v.pos.y * L.cell,
      cell: L.cell,
    };
  },
  busy: () => rolling || mineArmed,
  live: () => router.current === 'game' && !paused && !overlayOpen && state.winner === null,
});
router.start('home');
setBackButton(false);
menu.afterStart();

/* equipping repaints the board, and the chip swatch that stands for your ball; choosing a piece
   colour repaints the whole perspective (both sides, the finish wash and every chip) */
const paintTheme = () => {
  renderer.setTheme(theme());
  renderer.setPerspective(currentPerspective());
  paintRoster();
  paintSeatTints();
};
onChange(paintTheme);
/* a settled race writes the save, and the save is what your XP pill reads: repaint it the moment
   the wallet or the tally moves, so the chip is never one race behind. */
onChange(paintSeatIdentity);
paintTheme();
paintSeatIdentity();
