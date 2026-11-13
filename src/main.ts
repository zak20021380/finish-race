import './style.css';
import './result.css';
import {
  CONFIG, MAX_TEAMS, apply, ballById, distField, finishRoute, firstBall, getAutoMove, hasPathToFinish,
  isEliminated, mineCells, minesLeft, newGame, pathOn, reachableBall, rivalMineAt, steps as teamSteps,
  view as fogOfWar, wallBudget, wallOk, wallsCross, wallsOverlap, wallsRemaining, rotateWall,
  type Action, type Ball, type Cell, type Checkmate, type GameState, type Mine, type Player,
  type Pos, type Wall, type WallSpec,
} from './rules';
import { botAction, botThinkMs, type Difficulty } from './bot';
import {
  capsuleLayout, capsuleSpots, createRenderer, dragWallSlot, hitTest, pawnRadius, wallCentre,
  type BallView, type BlastBeat, type CapsuleAction, type Ghost, type Hit,
  type Mark, type Perspective, type RouteCue, type Vec, type View,
} from './render';
import { createConfetti } from './confetti';
import { createChat, type PawnTint } from './chat';
import { createBanter } from './banter';
import type { PostChatLine } from './data/postchat';
import {
  BOARD_IDLE, holdMineKey, holdsBall, moveDots, pickBall, pickBallFromMine, previewWall, type BoardMode,
} from './boardmode';
import { createRouter } from './router';
import { createSheets } from './sheets';
import { createMenu, openTrainingUpsell, ownersBack, type Menu } from './menu';
import { createHome } from './home';
import { createCompete } from './compete';
import { createArenaRoad } from './arena';
import { flagPhoto } from './flags';
import { createShop } from './shop';
import { createNotifications, clearRelicChallenges, dismissRelicChallenge, noteRelicMissed, showRelicChallenge } from './notifications';
import { fetchRelicMailbox, startRelicChannel } from './network';
import { showToast } from './toast';
import { mountCoins } from './coin';
import { appearance, lang, langDef, menuState, motionReduced, onAppearance, onLang, t, toggleAppearance } from './settings';
import {
  audio, holdAudio, playBoom, playVictoryFanfare, releaseAudio, stopVictoryFanfare,
} from './audio';
import { playDefeat, stopDefeat } from './sound';
import {
  getRemainingTiqRecoveries, hasClaimedInMatch, markClaimedInMatch, playRewardedAd, recordTiqRecovery,
  resetMatchClaims, tiqRecoveryLimit,
} from './ads';
import {
  closeVipSheet, initVipStore, isPremiumUser, onVipChange,
} from './premium';
import {
  accountChanged, claimFirstDuelBonus, completeTutorial, earnCoins, earnTiq, hasChosenLanguage,
  hasClaimedFirstDuelBonus, hasCompletedTutorial, isFirstOnboardingEligible, isFirstTimePlayer,
  ladderTally, markFirstOnboardingWin, onChange, pieceColor, profile, peekPendingDuelRoom,
  reconcileTutorialFromHistory, recordGame, rememberPendingDuelRoom, resetTutorialState,
  takePendingDuelRoom, theme,
} from './storage';
import {
  activateOnboarding, bestSafeStep, deactivateOnboarding, guardPlayerAction,
  ONBOARDING_TURN_GRACE, onboardingActive, onboardingRivalAction, playerIsStuck,
} from './onboarding';
import {
  createTutorial, shouldAutoStartTutorial, tutorialSpotHas, TUTORIAL_LIVE_STEPS,
  type Tutorial, type TutorialAction, type TutorialRect, type TutorialSpot, type TutorialStage,
  type TutorialTargetMine, type TutorialTargetMove, type TutorialTargetSelect, type TutorialTargetWall,
} from './tutorial';
import { PEARL_BOARD, perspectiveRamps, type Theme } from './themes';
import { capsuleStage, mineStage, setCapsuleStage, setMineStage, STAGE_CLEAR } from './staging';
import { setPieceBoxes, type PieceBox } from './boardpieces';
import {
  detonation, impact, initTelegram, inviteDuelCode, inviteRoomCode, inviteSquadId, notify,
  onBackPress, shatterImpact, startParam, tgUser,
} from './telegram';
import { applyFlagSupport } from './countries';
import {
  autoTutorialForLaunch, createRoomCode, getGameMode, gmBack, initGameModes, notifyMatchBusy,
  onGameModeChange, openInviteRoom, rewardModeFor, resumeRoom, setGameMode, setRewardSeats,
  takeAutoLaunch,
} from './gamemodes';
import { dismissDuelVeil, noteDuelLobby, openDuelDoor, throwDuelChallenge } from './duelInvite';
import { initSeize, resetSeizeContext } from './seize';
import type { Lobby, LobbyRace } from './lobby';
import {
  createMatchmaking, myTiq, onlineRace, onlineSearch, setQueueMode, type OnlineSession, type RaceEnd,
} from './matchmaking';
import { createAdmin, recordRace, runtime, tiqFrom, type Admin } from './admin';
import { arena, arenaLocked, onAward, startArenaSync } from './arenaState';
import {
  MIN_SEATS, ROOM_WAIT_MS, createRoom, difficultyFor, hasHumanRival, isAutomated, isHuman,
  lobbyLine, rewardEligible, seatBadge, seatName, sizesOf, startEarly, type BotTier, type Room,
} from './room';
import { initJoinGate } from './joinGate';
import { showVsClash, type VsRival, type VsStakes } from './vsclash';
import { BADGE_REQUIREMENTS } from './badges';
import { beginMatch, finishMatch, initTelemetry, setIdle } from './telemetry';
import type { MatchMode } from '../shared/telemetry';
import {
  createReferralQuestMatch, isReferralQuestActive, onReferralQuestChange, referralQuestUser,
  verifyReferralQuestMatch,
} from './referral';

/* ---------- render-loop state ----------
 * Kept at the very top of the module, ahead of every boot wiring call. A resize, a language flip
 * or an invite-first boot can wake the loop before the loop section is reached, and a `let` read
 * from its temporal dead zone would abort the whole cold start.
 * See `invalidate()` / `frame()` / `syncLoop()` in the loop section below.
 */
let last = performance.now();
let raf = 0;
/** External gate: the board is on screen, visible and unpaused. */
let loopWanted = false;
/** Dirty flag: at least one fresh frame is owed. */
let frameNeeded = true;
/** The last frame reported an active transition, so the next frame is owed too. */
let animating = false;

/* INSTANT BOOT. No splash veil stands between the player and the arena: the SDK is told the app
   is ready and expanded on the very first evaluation, local state hydrates synchronously from the
   save, and the target screen mounts on the first frame. Remote syncs run in the background. */
initTelegram();
/* SHARED-DEVICE SWITCH GUARD. Every save and cache key was bound to the account Telegram announced
   at module init. If the SDK later names a different account — a shared phone switched users while
   this webview stayed alive — reload so the whole scope re-binds instead of letting the newcomer
   run on the old account's in-memory profile. A transient missing id is not a change. */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && accountChanged()) window.location.reload();
});
initTelemetry();
/* The global VIP store binds after the SDK so `initDataUnsafe` is readable on its first paint. */
initVipStore();
applyFlagSupport();

/* ---------- invite-first boot ----------
   A friend's duel link is a promise to land in that room immediately. `detectInviteDuelLaunch()`
   is a hoisted declaration below; reading it here, before any router or sheet is created, is what
   lets the whole invited session stay clear of the boot-time channel gate. */
const INVITE_DUEL_LAUNCH = detectInviteDuelLaunch();
/* ---------- first-time invite onboarding ----------
   A brand-new player who taps a friend's duel link has not met the board yet. The invite is a
   promise, not a shortcut past onboarding: the room code is parked in session memory here, the
   luxury language gate takes the first screen, and the room is joined the instant the gate
   resolves — straight to the friend's seat, never the standalone lesson and never a Home screen
   the player has to navigate out of. Read exactly once at boot, before any router or sheet exists. */
reconcileTutorialFromHistory();
/* The room this launch was invited into (room_ / duel_ / bare code), captured on frame 1. */
const INVITE_ROOM_CODE = detectInviteRoomCode();
/* The locale lock: a player who has never explicitly chosen a language meets the luxury picker
   first — invited or not. Once chosen it is permanent (storage.ts), so returning players skip it. */
const LANG_GATE_NEEDED = !hasChosenLanguage();
/* A first-boot invitee: the language gate holds the friend's room, then hands the player straight
   to it. The in-match micro-coach teaches the board in their chosen language. */
const INVITE_FTUE = !!INVITE_ROOM_CODE && LANG_GATE_NEEDED;
if (INVITE_FTUE) rememberPendingDuelRoom(INVITE_ROOM_CODE);
/** The mandatory channel check is HELD for the invited duel and re-armed on the first Home return. */
let inviteGateDeferred = INVITE_DUEL_LAUNCH || INVITE_FTUE;

/* The mandatory channel check runs in the background and never blocks the first frame; a gate
   that cannot be answered fails open. On an invited launch it is deliberately NOT started: a join
   sheet in front of a waiting friend is the whole drop-off this flow exists to remove.
   `initJoinGate()` is called from the router the moment the player exits back to #s-home instead. */
if (!inviteGateDeferred) initJoinGate();

/* ---------- no zoom / no scroll ---------- */

for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault());
}
/* Touch panning belongs to the compositor: the page itself cannot scroll
   (`overflow: hidden` + `overscroll-behavior: none`), while every scroll surface
   opts into its own axis with `touch-action` in style.css. A non-passive
   `touchmove` listener here would force every flick through the main thread. */
document.addEventListener('dblclick', (e) => e.preventDefault());

/* ---------- DOM ---------- */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/* ---------- diffed DOM writes ----------
 * `ui()` runs on every committed action. A write that stores the same string or toggles a class
 * already in its target state still invalidates style and can cost a recalc on a phone, so every
 * write below goes through one of these guards. Each read here is a cheap in-memory DOM read —
 * none of them touches layout.
 */
function setText(el: Element | null | undefined, value: string): void {
  if (el && el.textContent !== value) el.textContent = value;
}
function setClass(el: Element | null | undefined, name: string, on: boolean): void {
  if (el && el.classList.contains(name) !== on) el.classList.toggle(name, on);
}
function setAttr(el: Element | null | undefined, name: string, value: string): void {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
}
function setDisabled(el: HTMLButtonElement | null | undefined, disabled: boolean): void {
  if (el && el.disabled !== disabled) el.disabled = disabled;
}
/**
 * Restart a one-shot CSS animation without the classic `void el.offsetWidth` forced reflow.
 * Dropping the class now and re-adding it on the next frame restarts the keyframes just the same,
 * and keeps the input path from flushing layout between a DOM write and its measurement.
 */
function restartClass(el: HTMLElement, ...names: string[]): void {
  el.classList.remove(...names);
  requestAnimationFrame(() => el.classList.add(...names));
}

const canvas = $<HTMLCanvasElement>('board');
const wrap = $<HTMLDivElement>('board-wrap');
const overlay = $<HTMLDivElement>('overlay');
const resultCard = $<HTMLDivElement>('result-card');
const verdict = $<HTMLHeadingElement>('verdict');
const again = $<HTMLButtonElement>('again');
const toMenu = $<HTMLButtonElement>('to-menu');
const resultKicker = $<HTMLParagraphElement>('result-kicker');
const resultRoster = $<HTMLOListElement>('result-roster');
const resultBank = $<HTMLElement>('result-bank');
const resultTiqChip = $<HTMLElement>('result-tiq-chip');
const resultTiqN = $<HTMLElement>('result-tiq-n');
const resultXpChip = $<HTMLElement>('result-xp-chip');
const resultXpN = $<HTMLElement>('result-xp-n');
const resultBankDivA = $<HTMLElement>('result-bank-div-a');
const resultBankDivB = $<HTMLElement>('result-bank-div-b');
const resultCoinChip = $<HTMLElement>('result-coin-chip');
const resultCoinsN = $<HTMLElement>('result-coins-n');
const resultStake = $<HTMLElement>('result-stake');
const resultStakeK = $<HTMLElement>('result-stake-k');
const resultStakeN = $<HTMLElement>('result-stake-n');
const resultStakeSaved = $<HTMLElement>('result-stake-saved');
/* the two rewarded-video keys: a chip in the stake band and a chip inside the coin pill */
const recoverBtn = $<HTMLButtonElement>('btn-recover-tiq');
const recoverLabel = $<HTMLElement>('recover-tiq-label');
const recoverQuota = $<HTMLElement>('recover-tiq-quota');
const recoverSpin = $<HTMLElement>('recover-tiq-spin');
const doubleBtn = $<HTMLButtonElement>('btn-double-coins');
const doubleLabel = $<HTMLElement>('double-coins-label');
const doubleSpin = $<HTMLElement>('double-coins-spin');
const adToast = $<HTMLParagraphElement>('ad-toast');
/* the pre-watch consent sheet: it must be answered before the SDK may open a fullscreen video */
const adConfirm = $<HTMLDivElement>('ad-confirm');
const adConfirmTitle = $<HTMLElement>('ad-confirm-title');
const adConfirmDesc = $<HTMLElement>('ad-confirm-desc');
const adConfirmIco = document.getElementById('ad-confirm-ico') as SVGUseElement | null;
const adConfirmWatch = $<HTMLButtonElement>('ad-confirm-watch');
const againLabel = $<HTMLSpanElement>('again-label');
const againIco = document.getElementById('again-ico') as SVGUseElement | null;
const shareBtn = $<HTMLButtonElement>('share');
const shareLabel = $<HTMLSpanElement>('share-label');
const toMenuLabel = $<HTMLSpanElement>('menu-label');
/* every toast on the page: the board's own, and the shop's copy of it. One message goes to all of
   them, so the note speaks on whichever screen is up; the hidden one costs nothing. */
const noteEls = [...document.querySelectorAll<HTMLParagraphElement>('.note')];
/** The board's own toast: the only one that can end up over the mine pair, so the only one that moves. */
const boardNote = $<HTMLParagraphElement>('note');
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
/* The quit sheet's four strings are painted from the live seat, not swept from `data-i18n`:
   one dialog is a practice exit, a ranked forfeit or a friend-duel leave. */
const pauseQuitBtn = $<HTMLButtonElement>('pause-quit');
const quitTitle = $<HTMLElement>('quit-title');
const quitBody = $<HTMLElement>('quit-body');
const quitStay = $<HTMLButtonElement>('quit-stay');
const quitYes = $<HTMLButtonElement>('quit-yes');

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
  restartClass(el, 'pop');         // restarts the pop without a synchronous layout flush
}

/* a player with no walls taps a groove: the badge pulses in warning and a toast says why */
let wallWarnTimer = 0;
function warnNoWalls(p: Player) {
  const el = wallBadges[p];
  if (!el) return;
  if (motionReduced()) { el.classList.remove('depleted'); return; }
  el.classList.remove('dry-warn');
  el.classList.add('depleted');
  /* add the warning on the next frame so the keyframes restart without a forced reflow */
  requestAnimationFrame(() => el.classList.add('dry-warn'));
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
  cell.setAttribute('aria-label', spent
    ? 'Mines: none left'
    : `Mines: ${CONFIG.MINES_PER_TEAM} per player — count concealed`);
}

/* the trigger shakes the board itself, once. A mine is a 2px micro-shake; reduced motion never
   shakes anything. */
let shakeTimer = 0;
function shake(micro = false) {
  if (motionReduced()) return;
  wrap.classList.remove('shake', 'micro');
  /* re-add on the next frame: the keyframes restart, and no layout is flushed from the input path */
  requestAnimationFrame(() => {
    wrap.classList.add('shake');
    if (micro) wrap.classList.add('micro');
  });
  clearTimeout(shakeTimer);
  shakeTimer = window.setTimeout(() => wrap.classList.remove('shake', 'micro'), micro ? 400 : 700);
}

/* the toast over the lower board: why a slot was refused, the wall's drag hint, an event alert.
   Only the screen that is actually up takes the message, so a refusal in the shop never leaks
   onto the board behind it (and vice versa). */
let noteTimer = 0;
let toastMsg = '';
function showNote(msg: string, error: boolean, ttl: number, timeout = false) {
  toastMsg = msg;
  for (const el of noteEls) {
    if (el.closest<HTMLElement>('.screen')?.hidden) continue;
    setText(el, msg);
    setClass(el, 'error', error);
    setClass(el, 'timeout', timeout);            // the blitz verdict gets its own clay tone
    setClass(el, 'show', true);
  }
  clearTimeout(noteTimer);
  if (ttl) noteTimer = window.setTimeout(() => { for (const el of noteEls) setClass(el, 'show', false); }, ttl);
  placeNote();
}
const clearNote = () => {
  clearTimeout(noteTimer);
  toastMsg = '';
  for (const el of noteEls) { setClass(el, 'show', false); setClass(el, 'timeout', false); }
};

/* ---------- invite-first onboarding: the two live surfaces ----------
   Built here rather than in index.html so the markup stays the single source of truth and an
   ordinary launch pays for nothing but two invisible nodes. Both are width-capped, logically
   inset (`inset-inline`) and use `min-width: 0` + `overflow-wrap`, so a 320px RTL viewport can
   never gain a horizontal scrollbar. Neither one takes a pointer or owns a turn. */
const gameScreen = $<HTMLElement>('s-game');
const coachPill = document.createElement('div');
coachPill.className = 'iv-coach';
coachPill.id = 'iv-coach';
coachPill.setAttribute('role', 'status');
coachPill.setAttribute('aria-live', 'polite');
coachPill.innerHTML = '<span class="iv-coach-k" id="iv-coach-k"></span>'
  + '<p class="iv-coach-t" id="iv-coach-t"></p>';
gameScreen.appendChild(coachPill);

/* A live friend-room status pill: the rival's reconnecting grace, without a dialog and without
   taking a tap from the board. Built here so the static markup stays untouched. */
const peerPill = document.createElement('div');
peerPill.className = 'peer-pill';
peerPill.id = 'peer-pill';
peerPill.setAttribute('role', 'status');
peerPill.setAttribute('aria-live', 'polite');
peerPill.hidden = true;
gameScreen.appendChild(peerPill);

let peerPillTimer = 0;
function hidePeerPill(): void {
  if (peerPill.hidden && !peerPillTimer) return;
  window.clearTimeout(peerPillTimer);
  peerPillTimer = 0;
  peerPill.hidden = true;
  peerPill.classList.remove('is-warn', 'is-ok');
}
/** A friend-room seat's socket changed state: the pill says so, the board keeps its turn. */
function setPeerStatus(side: number, status: 'reconnecting' | 'online' | 'bot', graceMs = 0): void {
  if (side === localSide) return;
  if (status === 'bot') { hidePeerPill(); return; }
  window.clearTimeout(peerPillTimer);
  peerPillTimer = 0;
  peerPill.hidden = false;
  peerPill.classList.toggle('is-warn', status === 'reconnecting');
  peerPill.classList.toggle('is-ok', status !== 'reconnecting');
  peerPill.textContent = t(status === 'reconnecting' ? 'peerReconnecting' : 'peerOnline');
  if (status === 'reconnecting') {
    /* The server's grace is also the pill's own lease: if the takeover notice is lost, the
       promise still expires instead of sitting over a board that has moved on. */
    peerPillTimer = window.setTimeout(hidePeerPill, Math.max(4000, graceMs + 500));
  } else {
    peerPillTimer = window.setTimeout(hidePeerPill, 1800);
  }
}

/* ---------- the CHECKMATE splash ----------
   The rules resolve a sealed pawn into a win or an elimination; this is the board's own voice for
   that moment. One pointer-transparent overlay over the grid, one compositor-only scale-down, and
   nothing else: the blast itself is the canvas's (`renderer.checkmate`). The copy is read from
   `settings.ts` on every repaint, so a live language flip re-speaks the same verdict. */
const checkmateSplash = document.createElement('div');
checkmateSplash.className = 'cm-splash';
checkmateSplash.id = 'checkmate-splash';
checkmateSplash.setAttribute('role', 'status');
checkmateSplash.setAttribute('aria-live', 'assertive');
checkmateSplash.hidden = true;
checkmateSplash.innerHTML = '<span class="cm-in">'
  + '<b class="cm-title" id="cm-title"></b>'
  + '<i class="cm-rule" aria-hidden="true"></i>'
  + '<span class="cm-sub" id="cm-sub"></span>'
  + '</span>';
wrap.appendChild(checkmateSplash);
const cmTitle = $<HTMLElement>('cm-title');
const cmSub = $<HTMLElement>('cm-sub');
/** How long the announcement holds the board once it lands — the CSS clock is the same length. */
const CHECKMATE_SPLASH_MS = 1100;
/**
 * The board's own blast gets the first beat. The flare runs for a second and the endgame finisher
 * fires its first burst 630ms after the cue, so a banner raised on the same frame used to land on
 * top of both. It arrives a beat late, and short enough to clear the second burst.
 */
const CHECKMATE_SPLASH_DELAY_MS = 380;
let cmTimer = 0;
let cmVisible = false;

function paintCheckmateSplash(): void {
  setText(cmTitle, t('checkmateTitle'));
  setText(cmSub, t('checkmateSubtitle'));
}

/**
 * Raise the announcement over the board. It never takes a tap and it hides itself on its clock.
 *
 * The live region is populated IMMEDIATELY — a screen reader must not wait for a visual cue — but
 * the banner itself only enters after `CHECKMATE_SPLASH_DELAY_MS`, so the canvas flare and the
 * first finisher burst are seen before the verdict covers them.
 */
function showCheckmateSplash(): void {
  window.clearTimeout(cmTimer);
  cmVisible = true;
  checkmateSplash.hidden = false;
  paintCheckmateSplash();
  cmTimer = window.setTimeout(() => {
    if (!cmVisible) return;
    restartClass(checkmateSplash, 'is-on');
    cmTimer = window.setTimeout(hideCheckmateSplash, CHECKMATE_SPLASH_MS);
  }, CHECKMATE_SPLASH_DELAY_MS);
}

function hideCheckmateSplash(): void {
  window.clearTimeout(cmTimer);
  cmTimer = 0;
  if (!cmVisible && checkmateSplash.hidden) return;
  cmVisible = false;
  checkmateSplash.classList.remove('is-on');
  checkmateSplash.hidden = true;
}

onLang(() => { if (cmVisible) paintCheckmateSplash(); });

const bonusBadge = document.createElement('div');
bonusBadge.className = 'iv-bonus';
bonusBadge.id = 'iv-bonus';
bonusBadge.setAttribute('role', 'status');
bonusBadge.hidden = true;
bonusBadge.innerHTML = '<span class="iv-bonus-ico" aria-hidden="true"><svg class="ico"><use href="#i-gift" /></svg></span>'
  + '<span class="iv-bonus-copy">'
  + '<span class="iv-bonus-k" id="iv-bonus-k"></span>'
  + '<span class="iv-bonus-t" id="iv-bonus-t"></span>'
  + '</span>';
$('over-mode').insertAdjacentElement('afterend', bonusBadge);

const coachKicker = $<HTMLElement>('iv-coach-k');
const coachText = $<HTMLElement>('iv-coach-t');
const bonusKicker = $<HTMLElement>('iv-bonus-k');
const bonusText = $<HTMLElement>('iv-bonus-t');

/** The step painted on the pill (1, 2 or 0 for none): a live language flip re-reads it. */
let coachShownStep: 0 | 1 | 2 = 0;
let coachTimer = 0;

const renderCoach = (): void => {
  coachKicker.textContent = coachShownStep
    ? `${t('inviteCoachKicker')} · ${coachShownStep}/2`
    : t('inviteCoachKicker');
  coachText.textContent = coachShownStep === 2 ? t('inviteCoachTraps')
    : coachShownStep === 1 ? t('inviteCoachGoal') : '';
};

/** One repaint for every new string: copy AND direction, on every live surface. */
const paintInviteSurfaces = (): void => {
  const dir = langDef(lang).dir;
  coachPill.setAttribute('dir', dir);
  bonusBadge.setAttribute('dir', dir);
  renderCoach();
  bonusKicker.textContent = t('firstDuelBonusKicker');
  bonusText.textContent = t('firstDuelBonusLine');
};
onLang(paintInviteSurfaces);
paintInviteSurfaces();

/** Non-blocking: no pointer events, no board freeze, and it fades on its own clock. */
function showMicroCoach(step: 1 | 2): void {
  coachShownStep = step;
  renderCoach();
  coachPill.classList.add('is-on');
  window.clearTimeout(coachTimer);
  coachTimer = window.setTimeout(() => coachPill.classList.remove('is-on'), 5200);
}
const hideMicroCoach = (): void => {
  window.clearTimeout(coachTimer);
  coachPill.classList.remove('is-on');
};

/**
 * Speak into the board's live region without raising its pill.
 *
 * The mine flow still has something to say once a square is staged — it is a state change, and a
 * screen reader cannot see two discs appear on a canvas — but the pill itself must not paint: the
 * ✓/✕ pair IS the instruction at that point, and a bubble repeating "tap again" only sits on the
 * two keys it is describing.
 */
function announceNote(msg: string) {
  boardNote.textContent = msg;
}

/**
 * The board's toast, parked clear of a staged mine's pair.
 *
 * Its own place is the lower band of the board, which is exactly where a mine staged in the bottom
 * rows draws its ✓/✕. So while a pair is live the pill takes the side of it with the most room and
 * keeps `STAGE_CLEAR` px of daylight from the rims — under the pair when the staging is high on the
 * board, over it when the staging is low, the same flip the event callouts make. With nothing
 * staged the inline offsets are dropped and the CSS place applies again, so no other screen pays
 * for this. The pill is absolutely placed either way: it can move, but it can never shift a layout.
 */
let notePlaceRaf = 0;
/**
 * Park the toast beside the staged mine on the NEXT frame, never inside the write that raised it.
 * `showNote`/`armCapsules` have just mutated text and classes; measuring the board or the pill's
 * own height in that same task would force a synchronous layout on every touch. One deferred pass
 * per frame is enough — the note is a floating pill, not layout the board follows.
 */
function placeNote() {
  if (notePlaceRaf) return;
  notePlaceRaf = requestAnimationFrame(() => {
    notePlaceRaf = 0;
    placeNoteNow();
  });
}

function placeNoteNow() {
  const stage = mineStage();
  const clearPlace = () => {
    if (boardNote.style.top) boardNote.style.removeProperty('top');
    if (boardNote.style.bottom) boardNote.style.removeProperty('bottom');
  };
  if (!stage) { clearPlace(); return; }
  const board = boardBox();             // the input layer's one-per-frame cached canvas box
  if (board.height < 1) return;
  /* This read happens in a rAF, after the style invalidation has been handed to the frame — it is
     never the write-then-measure pair that stalls a touch handler. */
  const h = boardNote.offsetHeight || 30;
  const above = stage.top - board.top - STAGE_CLEAR;
  const below = board.top + board.height - (stage.top + stage.height) - STAGE_CLEAR;
  /* the CSS place is `bottom: 18%`, so the side that is not being used is pinned to `auto` rather
     than removed — leaving both would stretch the pill between the two edges */
  if (below >= h && below >= above) {
    const top = `${stage.top + stage.height - board.top + STAGE_CLEAR}px`;
    if (boardNote.style.top !== top) boardNote.style.top = top;
    if (boardNote.style.bottom !== 'auto') boardNote.style.bottom = 'auto';
  } else if (above >= h) {
    const bottom = `${board.top + board.height - stage.top + STAGE_CLEAR}px`;
    if (boardNote.style.bottom !== bottom) boardNote.style.bottom = bottom;
    if (boardNote.style.top !== 'auto') boardNote.style.top = 'auto';
  } else {
    clearPlace();
  }
}

/* ---------- screens ---------- */

let menu: Menu;
let admin: Admin | null = null;
/* The close hook is the pause family's safety net: see `resumeAfterSheetClose` — every way the
   pause sheet (or the quit confirm it opens) can go away ends in a live board again, never a
   silently paused one. */
const sheets = createSheets($('scrim'), { onClose: resumeAfterSheetClose });
const sheetById = (id: string) => document.getElementById(id);

/**
 * The Channel War pass is a TAP door, never a boot surface. A WebView can resume a page from a
 * bfcache snapshot with the pass still raised, so every launch — and every restored page — starts
 * by putting it away and dropping the scrim with it. No other screen state is touched.
 */
function keepChannelPassClosed(): void {
  const pass = sheetById('sheet-stars');
  if (!pass || pass.hidden) return;
  pass.classList.remove('open', 'closing');
  pass.style.pointerEvents = '';
  pass.hidden = true;
  if (sheets.isOpen) {
    sheets.closeNow();                    // keep the sheet controller's panel/scrim in sync
    return;
  }
  const scrim = sheetById('scrim');
  if (scrim) {
    scrim.classList.remove('open');
    scrim.hidden = true;
  }
}
keepChannelPassClosed();
window.addEventListener('pageshow', (event) => { if (event.persisted) keepChannelPassClosed(); });
/* A bfcache/session snapshot is taken on pagehide: the pass must be gone before it is captured, so
   the next launch resumes on the screen it left, never on a raised tournament drawer. */
window.addEventListener('pagehide', () => { keepChannelPassClosed(); });

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
  /* The Worker refused the queue itself. There is no client-side lock in front of it any more,
     so this is the server's enforcement arriving as the answer — say what it means and hand the
     player back to the drawer they came from. */
  onRefused: (reason) => {
    impact('light');
    notify('warning');
    if (reason === 'MAINTENANCE') {
      showNote(t('maintenanceBody'), false, 3200);
    } else {
      showNote(reason === 'MATCHING_LOCKED'
        ? 'The arena is locked — new matches are paused.'
        : reason === 'SEASON_ENDED'
          ? 'The season ended — standings are final.'
          : 'The server closed the queue. Try again in a moment.', false, 2600);
    }
    const drawer = sheetById('sheet-game-modes');
    if (drawer) sheets.open(drawer);
  },
});

/**
 * The one door every queue goes through, so the arena's own lock can stand in front of it: when
 * entries are closed, a new queue is refused with the reason rather than silently doing nothing.
 * `matchmaking.open()` is never called directly.
 */
function queueMatch(mode: 'pvp' | 'arena' = 'pvp') {
  /* MATCH #1 OVERRIDE. A debut seat never enters the live queue: a veteran on the far side of the
     matchmaker is the one outcome this first race cannot underwrite. Route straight to the local
     AI controller instead, through the very same `startGame()` door the practice fallback uses, so
     nothing about the board, the HUD or the ceremony looks different. The searching stage is never
     opened at all, which is what makes the swap seamless. A server-verified Referral Hard Bot quest
     keeps its strict Hard AI and its own launch path — the assist never touches it. */
  if (isFirstOnboardingEligible() && !isReferralQuestActive(referralQuestUser())) {
    setQueueMode(mode);
    setGameMode('bot');
    startGame({ difficulty: menuState.difficulty, sizes: [...menuState.sizes] });
    return;
  }
  setQueueMode(mode);
  /* the arena lock is mirrored from the server: new entries stop, live races play out */
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
let compete: { setRoute(id: string): void; clearRivalContext(): void } | null = null;
let arenaRoad: { setRoute(id: string): void } | null = null;

const router = createRouter($('screens'), (id, prev, phase) => {
  /* Phase 1: only the swap itself and the lifecycle that must answer it. Every
     data paint below is queued for the frame after the new tab has painted, so a
     tab tap never waits on a list rebuild or a network read. */
  menu.setRoute(id);
  /* Any screen change drops a rival confrontation card: the challenge belongs to the panel that
     opened it, never to the screen the player just moved to. */
  resetSeizeContext();
  /* The Profile tab is always the personal, pristine card. A rival inspection that was open on
     Ranks — and any challenge key it mounted — is torn down before the tab paints. */
  if (id === 'profile') {
    menu.clearRivalContext();
    compete?.clearRivalContext();
  }
  // the light finish is a race-stage skin: it comes and goes with the board, never with the shell
  document.documentElement.classList.toggle('light-game', appearance() === 'light' && id === 'game');
  // Telegram BackButton on every screen except Home; always functional via onBack fallback.
  setBackButton(id !== 'home');
  if (id !== 'game') { cancelTutorial(); pauseGame(); }   // the board only ticks while it is on screen
  /* Returning to a live board by a route (not just a fresh `startGame`) must not inherit the
     pause that was raised on the way out. The pause family is sheet-owned, so a sheet still above
     the board keeps its own stop. */
  else if (!sheets.isOpen) paused = false;
  /* off the board, a room that was waiting in the background may finally show itself */
  if (id !== 'game') resumeRoom();
  /* `prev === null` is the cold boot's OWN Home render, not an exit back to it. A genuine return
     to Home re-arms the channel gate that an invite launch held back, and is the one moment the
     optional tactical-training upsell belongs: the friend has been played and nobody is waiting. */
  if (id === 'home' && prev !== null) {
    if (inviteGateDeferred && !peekPendingDuelRoom()) {
      inviteGateDeferred = false;
      initJoinGate();
    }
    if (!peekPendingDuelRoom()) maybeOfferTraining();
  }
  phase.after(() => {
    menu.refresh(id);
    shop.setRoute(id);
    home?.setRoute(id);
    compete?.setRoute(id);
    arenaRoad?.setRoute(id);
    if (id === 'home') admin?.relayout();   // the launcher only has a height once Home is up
  });
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
    // and the Hall of Owners hands back to its collector card before the flow closes
    if (!gmBack() && !ownersBack()) sheets.close();
    return;
  }
  if (router.current === 'game') {
    if (state.winner !== null) { quitToMenu(); return; }
    openPause();
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
/**
 * How this board is counted: an Arena cup race carries the tag the room announced; every other
 * online board is PvP, and a board with no live seat is a practice race against the machine.
 */
const matchMode = (): MatchMode => {
  if (!active) return 'bot';
  if (active.mode === 'arena') return 'arena';
  /* A friends room can launch with one person and a backfilled seat; that board is practice,
     exactly as the room counts it. A seat the machine took over does not make the room PvP. */
  if ('seats' in active) {
    const humans = active.seats.reduce((n, seat) => n + (seat.bot ? 0 : 1), 0);
    return humans >= 2 ? 'pvp' : 'bot';
  }
  return 'pvp';
};
/**
 * Which warning the quit sheet wears. A board with nobody on the far side — a local practice race,
 * or a private room the machine backfilled — costs nothing to leave, which is exactly what
 * `matchMode()` already counts as practice. A friends room with people in it hands the round to a
 * friend; the matchmaker's queue and the Arena cup hand it to a ranked rival, ladder and stake
 * behind it.
 */
type QuitKind = 'practice' | 'duel' | 'forfeit';
function quitKind(): QuitKind {
  if (matchMode() === 'bot') return 'practice';
  if (active && 'seats' in active) return 'duel';
  return 'forfeit';
}
/** The two sides this screen actually paints: the player's chosen colour, the rival in the other. */
const currentPerspective = (): Perspective => ({ local: localSide, rival: rivalSide(), color: pieceColor() });
/**
 * The win streak's own gate: ranked PvP only. A matchmaker seat — the duel queue or an Arena cup —
 * with a person on the far side is ranked; a friends room (an invite link or a private code) and a
 * practice board are not, so neither a friendly win nor a friendly loss may touch the run.
 */
const rankedPvp = (): boolean => {
  if (!active || room || 'seats' in active) return false;
  return matchMode() !== 'bot';
};

/** `You`, and the name on each other chip: local names in a bot race, the player's in an online one. */
const TEAM_NAME: Record<number, string> = { 0: 'You', 1: 'Bot' };

/**
 * The lobby this race was launched from, or null for a plain race. A room names its seats and says
 * which of them the machine owns — a bot backfilled into a vacancy and a seat a person walked out
 * of are the same thing to everything downstream (`isAutomated`), so the dock, the turn dispatcher
 * and the payout each ask one question instead of three.
 */
let room: Room | null = null;

/**
 * `null` is not a move: it is the debut controller's forced-resignation signal, answered by
 * `concedeOnboarding()` below. `full` is the unfogged board the gates read; `s` stays the fogged
 * projection the ordinary brain has always reasoned from.
 */
interface Opponent {
  think(s: GameState, full: GameState, hold: boolean): Promise<Action | null>;
}
/**
 * A bot brain. The level can be fixed (a practice race plays the drawer's pick) or resolved per
 * seat (a room ladders its machine seats), so a four-seat room can field Hard, Normal and Easy at
 * once and the dispatcher never has to know which seat it is thinking for.
 *
 * On the ONE debut match the ordinary decision is merely the `preferred` suggestion: the
 * onboarding gates dry-run it on the full board and may replace it with a held step, a harmless
 * edge wall, or `null`. Every later match takes the untouched `botAction()` path.
 */
const makeBot = (d: Difficulty | ((seat: Player) => Difficulty)): Opponent => ({
  think: (s, full, hold) => {
    const level = typeof d === 'function' ? d(s.turn) : d;
    const debut = onboardingActive();
    return new Promise<Action | null>((res) => setTimeout(() => {
      const natural = botAction(s, level);
      res(debut ? onboardingRivalAction(full, localSide, natural, hold) : natural);
    }, botThinkMs(level)));
  },
});

let difficulty: Difficulty = menuState.difficulty;
/**
 * The reward family the Select Game Mode sheet quoted when this race was launched. `startGame()`
 * is the only writer; `showOverlay()` hands it to `recordGame()`, which prices the win with the
 * very same `computeMatchRewards()` the drawer used. `null` means the launch did not come from
 * the drawer, so the settlement infers the family from the board's own tag instead.
 */
let matchRewardMode: string | null = null;
/**
 * Does the match on screen SPEND the debut when it settles? The standalone first-boot lesson is a
 * scripted, unwinnable-to-lose tutorial: it is guarded but does not consume the flag, so the first
 * race the player could actually lose is the one the controller is owed to govern.
 */
let onboardingConsumesDebut = false;
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
  /* Only the placer's own live pawns can refuse a wall now: sealing a rival is a checkmate,
     resolved by the rules the moment the bar lands. */
  const d = distField([...s.walls, w], s.cols, s.rows);
  const blocked = s.balls.some((b) => b.team === w.owner && !b.isCheckmated
    && d[b.pos.r * s.cols + b.pos.c] < 0);
  return blocked ? 'blocked' : 'overlap';
}

/**
 * The arena on screen right now. The equipped cosmetics still own the pawn and walls; Light Mode
 * only swaps the slab under them for the pearl chessboard, so toggling a finish can never change
 * what a player owns or how a seat reads.
 */
const liveTheme = (): Theme => {
  const base = theme();
  return appearance() === 'light' ? { ...base, board: PEARL_BOARD } : base;
};

const renderer = createRenderer(canvas, {
  theme: liveTheme,
  onFinishSettled: finishSettled,
  /* A deferred re-fit clears the canvas. The loop is parked while the board is idle, so the
     resize must ask for one fresh frame instead of leaving a blank slab behind. */
  onLayoutChanged: () => invalidate(),
});
const confetti = createConfetti(confettiEl);
const toVec = (p: Pos): Vec => ({ x: p.c + 0.5, y: p.r + 0.5 });

/** Where the board's own numbers are published for CSS: the card that holds both the board and the
 *  dock, so one write reaches `.board-wrap` and `.chips` alike. */
const boardCard = wrap.closest<HTMLElement>('.card') ?? wrap;

/**
 * Hand the grid the rules picked to CSS, which is what lets the board box size itself to the
 * board's own aspect instead of a hard-coded 2:3. Without it a 10x14 board letterboxes inside a
 * 2:3 box — the slab floats away from the box's top edge, and the goal crown that sits on it lands
 * further from the card's edge than the board it belongs to. Called on every `setBoard`, so a duel
 * and a party get their own box.
 */
function fitBoard(c: number, r: number) {
  boardCard.style.setProperty('--board-cols', String(c));
  boardCard.style.setProperty('--board-rows', String(r));
}

let state: GameState = newGame(sizes);
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
let ghost: Ghost | null = null;                 // wall preview; armed = toolbar up, ready to confirm
/** The floating Cancel / Rotate / Confirm toolbar anchored to an armed wall or mine ghost. */
let capsule: CapsuleAction | null = null;
/**
 * The finger currently carrying a wall ghost. A press that never travels is a tap — on the bar's
 * centre that means rotate — while a press that crosses `DRAG_SLOP` slides the whole bar instead.
 */
let wallDrag: { id: number; x: number; y: number; moved: boolean; tap: 'centre' | 'groove' } | null = null;
const DRAG_SLOP = 6;                             // css px before a press becomes a drag
/** One entry per seat: what that seat did last. Sized to the live roster in `restart()`. */
const marks: (Mark | null)[] = Array.from({ length: state.teams.length }, () => null);
/** Reused every frame: the loop must not allocate. */
const view: View = {
  state, balls: ballViews, hints, routes: [], ghost, last: marks, thinking: null,
  human: localSide, mineHints, mineGhost, capsule,
};
let gen = 0; // bumps on restart so stale bot replies are dropped
/** Bumps on restart so a combo's scheduled bangs from the OLD race never fire on a new board. */
let blastGen = 0;
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
/** Set by the on-demand door: the lesson opens on the next race even if it was read before. */
let tutorialRequested = false;
/** A lesson that replaces the launch is its own match: finishing or skipping it returns to Home. */
let tutorialStandalone = false;
/**
 * ACTION-FIRST FIRST OPEN. True only while a true first-time player is inside the lesson that
 * boot launched for them: no Home screen was ever shown on the way in. Cleared the moment the
 * lesson ends, so a later race or replay can never be mistaken for a cold boot.
 */
let firstRunBoot = false;
/** The boot lesson is done and the flag is saved; the player is sprinting to the FINISH line. */
let firstRunSprint = false;
const tutorialStage = (): TutorialStage | null => (tutorialActive ? tutorial?.stage ?? null : null);
/**
 * The lesson's board-wide cues, in cells: the player's gold guide to FINISH and the rival's
 * crimson threat run at the same line. Re-derived on every state change, so the wall the player
 * builds visibly bends the rival's line around itself — the detour IS the lesson, with no caption.
 */
let tutorialRoutes: RouteCue[] = [];

/* ---- invite-first onboarding: per-match session state ----
   All four are reset by `restart()`, so "first two turns" means the first two turns of THIS
   duel, not of the app's lifetime. Nothing here is persisted: the micro-coach is a live hint,
   never a state machine, and it is deliberately absent from src/tutorial.ts. */
let myTurnCount = 0;
let coachWasMyTurn = false;
/** A hint counted while #s-game was still hidden, waiting for `reveal()` to raise it. */
let pendingCoachStep: 0 | 1 | 2 = 0;
/** After turn 2 the coach goes quiet for the rest of the match. */
let microCoachQuiet = false;
/** The first duel has actually reached a verdict in this session. */
let inviteDuelSettled = false;
/** The optional training prompt is offered at most once per session. */
let trainingPromptShown = false;

/** People actually holding seats in a room — a local practice room holds only this screen. */
function humansIn(target: Room | null | undefined): number {
  if (!target) return 0;
  let count = 0;
  for (let i = 0; i < target.seats.length; i++) if (isHuman(target, i)) count++;
  return count;
}

/** The turn's own gate. The lesson layers on top of this through `isTutorialActionAllowed()`. */
const canAct = () => state.winner === null && state.turn === localSide && !paused
  && !isEliminated(state, localSide);
const clearGhost = () => { mineGhost = null; setMode({ ...mode(), preview: null }); clearNote(); };

/**
 * The board's action modes — a ball in hand, a wall preview, the mine key — as one value. The rule
 * that only one of them may own the board at a time is `boardmode.ts`'s; these two just move it.
 * The move dots are derived from the mode rather than stored, so a change here drops them at once
 * and the frame loop paints them back only if the new mode still calls for them.
 */
const mode = (): BoardMode<Ghost> => ({ selected, preview: ghost, mine: mineArmed });
/**
 * The dots a mode calls for: a ball in hand draws them, a wall preview or the mine key never does.
 * PURE GEOMETRY — `reachableBall()` walks board bounds, walls and pawn occupancy and returns plain
 * coordinates. It never calls `apply()`, never reads a mine record to arm it and never cues a
 * blast, so the four glowing circles may sit on top of a buried charge without setting it off.
 * Detonation has exactly one owner: `play()`, after a real action has been committed.
 */
const dotsFor = (m: BoardMode<Ghost>): Pos[] =>
  canAct() && moveDots(m) && m.selected !== null ? reachableBall(state, m.selected) : [];
function setMode(next: BoardMode<Ghost>) {
  selected = next.selected;
  ghost = next.preview;
  mineArmed = next.mine;
  if (!next.preview) wallDrag = null;   // no bar to carry once the ghost is gone
  hints = dotsFor(next);         // derived, so it is rebuilt the moment the mode moves — never stale
  armCapsules();                 // the floating keys hang off the preview, so they follow it
  /* A wall hover, a drag slide or a cancelled ghost changes only the canvas. With the loop parked
     between transitions it must be woken here, or the preview would never be painted. */
  invalidate();
}

/**
 * The chip's mine key: tapping it hands the board over to the placement band, tapping it again
 * hands direct play straight back. Placing a mine lets the key go on its own, so the next tap is
 * always a plain board tap.
 */
function armMine(next: boolean) {
  const on = next && canAct() && minesLeft(state, localSide) > 0 && !mineReserved();
  if (on === mineArmed) return;
  impact('light');
  mineGhost = null;
  setMode(holdMineKey(mode(), on));   // the key owns the board: no ball in hand, no wall preview
  clearNote();
  ui();
}

/** The exact centre of a logical pawn's tile, in cell units — its spawn position on frame zero. */
const spawnCentre = (b: Ball): Vec => toVec(b.pos);

/** Brings the drawn ball list into step with the state; existing entries are reused as they are. */
function syncBalls() {
  while (ballViews.length > state.balls.length) ballViews.pop();
  for (let i = 0; i < state.balls.length; i++) {
    const b = state.balls[i];
    const v = ballViews[i];
    if (!v) { ballViews.push({ pos: spawnCentre(b), team: b.team, id: b.id, sel: false }); continue; }
    v.team = b.team; v.id = b.id;
    /* A missing or non-finite visual coordinate would survive the lerp forever (NaN propagates),
       so heal it here instead of letting the pawn quietly vanish off the canvas. */
    if (!v.pos || !Number.isFinite(v.pos.x) || !Number.isFinite(v.pos.y)) v.pos = spawnCentre(b);
  }
}

/**
 * Frame-zero synchronisation. A race must open with every animated pawn sitting EXACTLY on its
 * logical spawn tile — no interpolation from the previous board, no half-finished tween, no
 * stale selection ring. Called on restart and again at the reveal, which can be a cinematic later.
 */
function snapBalls() {
  while (ballViews.length > state.balls.length) ballViews.pop();
  for (let i = 0; i < state.balls.length; i++) {
    const b = state.balls[i];
    const at = spawnCentre(b);
    const v = ballViews[i];
    if (!v) { ballViews.push({ pos: at, team: b.team, id: b.id, sel: false }); continue; }
    v.pos.x = at.x; v.pos.y = at.y;
    v.team = b.team; v.id = b.id; v.sel = false;
  }
  view.balls = ballViews;
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

/** The ghost's floating controls: a wall gets the three-key toolbar, a mine the compact ✓/✕ pair. */
function armCapsules() {
  if (ghost?.armed) {
    const centre = wallCentre(ghost.spec);
    capsule = { ax: centre.x, ay: centre.y, hit: { kind: 'confirm', spec: ghost.spec } };
  } else if (mineGhost) {
    capsule = { ax: mineGhost.c + 0.5, ay: mineGhost.r + 0.5, hit: { kind: 'mine-confirm', cell: mineGhost } };
  } else {
    capsule = null;
  }
  syncStage();
}

/**
 * Publish the staged mine's ✓/✕ box to the guidance layers, and park the board's toast around it.
 *
 * `armCapsules()` is the one writer of `capsule`, so it is the one writer of this too: the box is
 * live exactly as long as a live pair is, and a ghost that is buried, cancelled or reset clears it
 * on the same frame. It is measured through `boardRect`, which maps the pair's own cells onto the
 * canvas as it is actually laid out — a screen still sliding in publishes where the discs really
 * are, not where the layout thinks they are.
 */
function syncStage() {
  const cap = capsule;
  const blocked = state.balls.filter((b) => !b.isCheckmated).map((b) => b.pos);
  if (mineGhost && cap && cap.hit.kind === 'mine-confirm') {
    /* the pair's own box, resolved against the live pawns exactly as the renderer draws it:
       a horizontal pair on a roomy square, a vertical stack in a boundary column */
    const lay = capsuleLayout(renderer.layout(), cap.ax, cap.ay, blocked);
    setMineStage(lay ? boardRect(lay.box.left, lay.box.top, lay.box.width, lay.box.height) : null);
  } else setMineStage(null);
  /* The lesson's ring needs the ✓ key on its own and its door needs the whole pair — for a wall's
     glass toolbar exactly as for a mine's discs. One geometry call, the same one the frame draws
     and the hit-test answers, so the spotlight can never point at a key that is not there. */
  const spots = cap ? capsuleSpots(renderer.layout(), cap, blocked) : null;
  setCapsuleStage(spots
    ? {
        confirm: boardRect(spots.confirm.left, spots.confirm.top, spots.confirm.width, spots.confirm.height),
        pair: boardRect(spots.pair.left, spots.pair.top, spots.pair.width, spots.pair.height),
      }
    : null);
  placeNote();
}

/**
 * Publish every live pawn's footprint to the guidance layers (`boardpieces.ts`).
 *
 * The event callouts must never stand over a ball, and they cannot look: the pieces are canvas
 * pixels, and sampling them was a `getImageData()` readback on the detonation tick. The board knows
 * where its pawns are, so it hands the overlay boxes instead of pixels — one arithmetic test per
 * candidate slot, no GPU sync, no layout read.
 *
 * A box is the ball's own footprint (~0.7 of its cell), not the whole square: a callout sharing the
 * edge of a piece's tile is still clear of the piece.
 */
function syncPieces() {
  const out: PieceBox[] = [];
  for (const b of state.balls) {
    if (b.isCheckmated) continue;
    const tile = boardRect(b.pos.c, b.pos.r);
    const w = tile.width * 0.7, h = tile.height * 0.7;
    out.push({
      left: tile.left + (tile.width - w) / 2,
      top: tile.top + (tile.height - h) / 2,
      width: w,
      height: h,
    });
  }
  setPieceBoxes(out);
}

/* ---------- the post-match stage ---------- */

interface ResultView {
  won: boolean;
  coins: number;
  /** XP the race paid: a bot win pays its tier, every other non-win pays nothing. */
  xp: number;
  /**
   * The machine held the far side. A bot board pays no TIQ — win, loss, forfeit or timeout — so
   * the strip never prints a TIQ pill for it, and the stake band never opens.
   */
  bot: boolean;
  /** The TIQ a rewarded win actually paid; always 0 on a bot board. */
  tiq: number;
  /** The magnitude of the crimson stake loss a defeat wears. */
  stake: number;
  hardBotDuel: boolean;
  questMatch: () => Promise<string | null>;
  questAdCompleted: boolean;
  questVerified: boolean;
}

let resultView: ResultView | null = null;
let hardBotDuel = false;
let questEpoch = 0;
let questMatch: () => Promise<string | null> = async () => null;
let resultRaf = 0;
/** the coin count-up keeps its own handle: claiming coins must not freeze the stake */
let coinRaf = 0;
/** The stake is mid-morph (struck out, waiting for the shield): repaints must not snap it back. */
let stakeMorphing = false;
let resultTimers: number[] = [];
/** The rival walked out of the settled race: the rematch key and the banter dock are dead. */
let resultLocked = false;

/** Stop every clock the result owns: the count-up and the haptic beats. */
function clearResultMotion() {
  if (resultRaf) { cancelAnimationFrame(resultRaf); resultRaf = 0; }
  if (coinRaf) { cancelAnimationFrame(coinRaf); coinRaf = 0; }
  for (const id of resultTimers) window.clearTimeout(id);
  resultTimers = [];
  stakeMorphing = false;
  resultCoinChip.classList.remove('is-celebrating');
  resultStakeSaved.classList.remove('is-lit');
}

const resultLater = (fn: () => void, ms: number) => {
  resultTimers.push(window.setTimeout(fn, ms));
};

/** A count on this panel is never negative text: the sign is painted separately. */
const resultAbs = (n: number): string => commas(Math.max(0, Math.round(n)));

/** The local player's name, off the same Telegram identity the HUD wears. */
function localPlayerName(): string {
  const u = tgUser();
  const full = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
  return profile.displayName || full || u?.username || t('hudYou');
}

function seatLabel(seat: Player): string {
  return seat === localSide ? localPlayerName() : TEAM_NAME[seat] || t('rival');
}

const asPhoto = (raw: string | null | undefined): string =>
  typeof raw === 'string' && /^https?:\/\//i.test(raw) ? raw : '';

/** A photo over its monogram, so a slow or blocked CDN still leaves a person, never a hole. */
function paintResultAvatar(
  img: HTMLImageElement, initialEl: HTMLElement, name: string, url: string,
): void {
  initialEl.textContent = (name.trim()[0] ?? '?').toUpperCase();
  if (!url) {
    img.hidden = true;
    img.removeAttribute('src');
    return;
  }
  img.onerror = () => { img.hidden = true; };
  if (img.getAttribute('src') !== url) img.src = url;
  img.hidden = false;
}

/** A seat's photo, off the same identity the dock already wears. Bots and room seats have none. */
function resultPhoto(seat: Player): string {
  if (seat === localSide) return asPhoto(tgUser()?.photo_url);
  return seat === rivalSide() ? asPhoto(active?.opponent.avatarUrl ?? null) : '';
}

/**
 * Does this seat hold VIP? The local seat reads the live entitlement; the online rival is judged
 * by the room's stamped flag on `MATCH_FOUND`, never by anything the rival's own client claims.
 */
function seatVip(seat: Player): boolean {
  if (seat === localSide) return isPremiumUser();
  if (!active || !('opponent' in active)) return false;
  if ('seats' in active) return active.seats.find((s) => s.side === seat)?.vip === true;
  return seat === rivalSide() && active.opponent.vip === true;
}

/** The seats the board paints with the gold aura: the local entitlement plus the room's stamps. */
function vipBoardSeats(): Player[] {
  const seats: Player[] = [];
  if (isPremiumUser()) seats.push(localSide);
  if (active && 'seats' in active) {
    for (const s of active.seats) {
      if (s.vip && s.side !== localSide && !seats.includes(s.side as Player)) seats.push(s.side as Player);
    }
    return seats;
  }
  if (active && 'opponent' in active && active.opponent.vip === true) seats.push(rivalSide());
  return seats;
}

const paintVipSeats = (): void => { renderer.setVipSeats(vipBoardSeats()); invalidate(); };

/**
 * Where every seat finished, champion first. A race stops the instant a ball takes the line, so
 * the seats that never crossed are ordered by how far their leading ball climbed and then by the
 * field behind it — a final standing the player can read straight off the board they just left.
 * A seat checkmated out of a party fell further than any runner: it owns the bottom of the ladder,
 * later falls ranked above earlier ones.
 */
function finalStandings(): Player[] {
  const winner = state.winner;
  const fallen = state.eliminated ?? [];
  const progress = (seat: Player): [number, number] => {
    const rows = state.balls.filter((ball) => ball.team === seat).map((ball) => ball.pos.r);
    if (!rows.length) return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    return [Math.min(...rows), rows.reduce((sum, row) => sum + row, 0)];
  };
  const rest = roster().filter((seat) => seat !== winner);
  rest.sort((a, b) => {
    /* a checkmated seat owns the bottom of the ladder; the later it fell, the higher it ranks */
    const ai = fallen.indexOf(a), bi = fallen.indexOf(b);
    if (ai >= 0 || bi >= 0) {
      if (ai < 0) return -1;
      if (bi < 0) return 1;
      return bi - ai;
    }
    const [aLead, aField] = progress(a);
    const [bLead, bField] = progress(b);
    return aLead - bLead || aField - bField || a - b;
  });
  return winner === null ? rest : [winner, ...rest];
}

/** The gold #1 badge: the same crown the winner used to wear over a podium portrait. */
function crownMark(): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#i-crown');
  svg.append(use);
  return svg;
}

/**
 * One row of the standings ladder: rank medal, circular portrait, name, placement. Every seat wears
 * the same height and rhythm; only the local seat is lit, by a gold hairline rather than a shout.
 * The row also owns the anchor its speaker's reaction bubble lands on.
 */
function resultRosterRow(seat: Player, rank: number): HTMLLIElement {
  const place = Math.min(rank, 4);
  const placeKey = `resultPlace${place}`;
  const name = seatLabel(seat);
  const local = seat === localSide;
  const out = isEliminated(state, seat);

  const row = document.createElement('li');
  row.className = 'result-row';
  row.dataset.place = String(place);
  row.dataset.seat = String(seat);
  row.setAttribute('aria-label', `${name}, ${t(out ? 'checkmateOut' : placeKey)}${local ? `, ${t('hudYou')}` : ''}${seatVip(seat) ? `, ${t('vipPillActive')}` : ''}`);
  if (local) {
    row.classList.add('is-you');
    row.setAttribute('aria-current', 'true');
  }
  if (out) row.classList.add('is-out');

  const medal = document.createElement('span');
  medal.className = 'result-medal';
  medal.dataset.place = String(place);
  medal.setAttribute('aria-hidden', 'true');
  if (place === 1) medal.append(crownMark());
  else medal.textContent = `#${rank}`;

  const avatar = document.createElement('span');
  avatar.className = 'result-avatar';
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  const initial = document.createElement('b');
  initial.setAttribute('aria-hidden', 'true');
  paintResultAvatar(img, initial, name, resultPhoto(seat));
  avatar.append(img, initial);

  const id = document.createElement('span');
  id.className = 'result-row-id';
  const strong = document.createElement('strong');
  strong.className = 'result-row-name';
  strong.textContent = name;
  id.append(strong);
  /* the gold crown is the VIP prestige mark: it sits beside the name on every result row the
     entitlement covers, and it is part of the same aria-label the row already announces */
  if (seatVip(seat)) {
    const vip = document.createElement('span');
    vip.className = 'result-vip';
    vip.setAttribute('role', 'img');
    vip.setAttribute('aria-label', t('vipPillActive'));
    vip.append(crownMark());
    id.append(vip);
  }

  const meta = document.createElement('span');
  meta.className = 'result-row-meta';
  const placeEl = document.createElement('span');
  placeEl.className = 'result-place';
  placeEl.textContent = t(out ? 'checkmateOut' : placeKey);
  meta.append(placeEl);
  if (local) {
    const you = document.createElement('span');
    you.className = 'result-you';
    you.textContent = t('hudYou').toUpperCase();
    meta.append(you);
  }

  const say = document.createElement('span');
  say.className = 'result-say';
  say.setAttribute('role', 'status');
  say.setAttribute('aria-live', 'polite');
  say.hidden = true;
  const sayText = document.createElement('span');
  sayText.className = 'result-say-t';
  /* the crown a VIP line wears: painted by banter.ts, present from the first paint so a line
     never has to reflow its own bubble to gain a badge */
  const sayVip = document.createElement('span');
  sayVip.className = 'result-say-vip';
  sayVip.hidden = true;
  sayVip.append(crownMark());
  say.append(sayText, sayVip);

  row.append(medal, avatar, id, meta, say);
  return row;
}

/** The whole ladder, champion first; a duel is simply the two-row case of the same list. */
function paintResultRoster(): void {
  resultRoster.setAttribute('aria-label', t('resultStandings'));
  resultRoster.replaceChildren(
    ...finalStandings().map((seat, index) => resultRosterRow(seat, index + 1)),
  );
}

/** Every word and every state class the current result owns, re-readable after a language flip. */
function paintResultCopy(): void {
  if (!resultView) return;
  const { won, coins, xp, bot, tiq, stake } = resultView;
  /* A checkmate that ended the race is the result's own reason, not a generic victory: the card
     says how it was won. A trap that only eliminated a party seat is already history by now. */
  const trapped = state.checkmate?.decided === true && state.winner !== null;
  resultKicker.textContent = t(!won && trapped ? 'checkmateKicker' : 'resultKicker');
  verdict.textContent = t(won ? (trapped ? 'checkmateKicker' : 'resultVictoryTitle') : 'resultDefeatTitle');
  shareLabel.textContent = t('resultShare');
  toMenuLabel.textContent = t('resultMenu');
  shareBtn.setAttribute('aria-label', t('resultShare'));
  toMenu.setAttribute('aria-label', t('resultMenu'));
  paintStakeValue();
  /* THE REWARDS STRIP IS THE SETTLEMENT, NOT A LEDGER. Only what the race actually paid is
     painted: a machine-held board never shows TIQ (its delta is zero by rule, win or lose), a
     race that paid nothing hides the whole capsule instead of printing +0, and a real win shows
     coins · xp · tiq in that order. */
  const staked = !won && stake > 0;
  const showCoins = coins > 0;
  const showXp = xp > 0;
  const showTiq = !bot && tiq > 0;
  resultCoinChip.hidden = !showCoins;
  resultXpChip.hidden = !showXp;
  resultTiqChip.hidden = !showTiq;
  resultStake.hidden = !staked;
  resultCoinChip.classList.toggle('is-consolation', !won);
  const paid = [showCoins, showXp, showTiq].filter(Boolean).length;
  resultBank.hidden = paid === 0 && !staked;
  /* a full three-item win keeps its edges; fewer items close up into the middle */
  resultBank.classList.toggle('is-centered', paid > 0 && paid < 3 && !staked);
  /* one hairline per shared edge: coin|xp, xp|tiq — or coin|tiq when XP paid nothing */
  resultBankDivA.hidden = !(showCoins && showXp);
  resultBankDivB.hidden = !((showXp && showTiq) || (showCoins && showTiq && !showXp));
  shareBtn.hidden = !won;
  again.classList.toggle('is-revenge', !won);
  againIco?.setAttribute('href', won ? '#i-play' : '#i-restart');
  paintResultLock();
  paintRewardButtons();
  paintResultRoster();
  /* a language flip can land while the consent sheet is up: its warning must switch too */
  paintAdConfirmCopy();
}

/**
 * The primary key is the one action the rival shares: when they leave, it is locked and renamed
 * instead of queueing a rematch into an empty room. The label is recomputed on every repaint, so a
 * language flip cannot quietly unlock it.
 */
function paintResultLock(): void {
  if (!resultView) return;
  again.disabled = resultLocked;
  again.classList.toggle('is-locked', resultLocked);
  const againText = resultLocked
    ? t('resultOpponentLeft')
    : t(resultView.won ? 'resultPlayAgain' : 'resultRevenge');
  againLabel.textContent = againText;
  /* the key's spoken name follows the visible one in every language, locked or not */
  again.setAttribute('aria-label', againText);
  if (resultLocked) again.title = t('resultOpponentLeftHint');
  else again.removeAttribute('title');
}

/**
 * Roll both counters up from zero and land three haptic beats under the roll. Reduced motion stills
 * the numbers on their final values; the haptics are the user's own setting and keep their pulse.
 */
function rollResultValues(): void {
  if (!resultView) return;
  const { won, coins, xp, tiq, stake } = resultView;
  const coin = resultCoinChip.querySelector<SVGSVGElement>('.coin');
  if (coin && !motionReduced()) {
    coin.classList.remove('sweep');
    void coin.getBoundingClientRect();
    coin.classList.add('sweep');
  }
  const dur = motionReduced() ? 0 : 880;
  const t0 = performance.now();
  const paint = (now: number) => {
    const k = dur > 0 ? Math.min(1, (now - t0) / dur) : 1;
    const eased = 1 - Math.pow(1 - k, 3);
    resultTiqN.textContent = resultAbs((won ? tiq : 0) * eased);
    resultCoinsN.textContent = resultAbs(coins * eased);
    resultXpN.textContent = resultAbs(xp * eased);
    if (!won) resultStakeN.textContent = `−${resultAbs(Math.max(1, stake * eased))} ${t('resultTiqUnit')}`;
    if (k < 1) {
      resultRaf = requestAnimationFrame(paint);
      return;
    }
    resultTiqN.textContent = resultAbs(won ? tiq : 0);
    resultCoinsN.textContent = resultAbs(coins);
    resultXpN.textContent = resultAbs(xp);
    if (!won) resultStakeN.textContent = `−${resultAbs(stake)} ${t('resultTiqUnit')}`;
    resultRaf = 0;
  };
  resultRaf = requestAnimationFrame(paint);
  impact('light');
  resultLater(() => impact('light'), 280);
  resultLater(() => impact('medium'), 680);
}

/* ---------- the rewarded-video actions ---------- */

/**
 * The two chips, painted from state: the save owns the daily budget, this match owns what it has
 * already paid, and the settlement owns whether there is anything left to claim. Called from
 * `paintResultCopy`, so a language flip re-reads every label it owns.
 */
function paintRewardButtons(): void {
  if (!resultView) return;
  const { won, coins, stake } = resultView;

  /* ---- TIQ recovery: only a defeat that actually cost TIQ ---- */
  const lost = !won && stake > 0;
  const claimed = hasClaimedInMatch('recover_tiq');
  const left = getRemainingTiqRecoveries();
  const limit = tiqRecoveryLimit();
  recoverBtn.hidden = !lost;
  recoverBtn.classList.toggle('is-claimed', claimed);
  /* the exhausted chip wears the limit in its own label, so the badge would only repeat it */
  recoverBtn.classList.toggle('is-exhausted', !claimed && left <= 0);
  /* The claimed key is spent: a real `disabled` takes it out of the tab order for good. The
     exhausted key stays announced-only, because its label still explains why it will not pay. */
  setDisabled(recoverBtn, claimed);
  recoverBtn.setAttribute('aria-disabled', String(claimed || left <= 0));
  recoverLabel.textContent = claimed
    ? t('adRecoverProtected')
    : left > 0 ? t('adRecoverCta') : t(limit > 3 ? 'adRecoverLimitVip' : 'adRecoverLimit');
  recoverQuota.textContent = `${left}/${limit}`;
  recoverQuota.hidden = claimed || left <= 0;

  const user = referralQuestUser();
  const activeQuest = isReferralQuestActive(user);
  const capped = user.dailyMatches >= user.dailyMatchCap;
  const quest = activeQuest && resultView.hardBotDuel && !capped;
  const pending = quest && resultView.questAdCompleted && !resultView.questVerified;
  const questReward = $('result-quest-reward');
  const wrongMode = $('quest-wrong-mode-notice');
  questReward.hidden = !quest;
  questReward.dir = langDef(lang).dir;
  wrongMode.hidden = !activeQuest || (resultView.hardBotDuel && !capped);
  wrongMode.dir = langDef(lang).dir;
  wrongMode.textContent = t(resultView.hardBotDuel && capped ? 'quest_daily_cap' : 'quest_wrong_mode_notice');
  $('quest-ad-subtitle').textContent = t(pending ? 'quest_sync_failed' : 'quest_ad_subtitle');
  const target = quest ? $('quest-ad-slot') : resultCoinChip;
  if (doubleBtn.parentElement !== target) target.append(doubleBtn);
  doubleBtn.classList.toggle('ad-chip--quest', quest);
  doubleBtn.classList.toggle('ad-chip--mini', !quest);
  if (quest) doubleBtn.setAttribute('aria-describedby', 'quest-ad-subtitle');
  else doubleBtn.removeAttribute('aria-describedby');
  const paid = hasClaimedInMatch('double_coins');
  doubleBtn.hidden = coins <= 0 && !quest;
  doubleBtn.classList.toggle('is-claimed', paid && !pending);
  doubleBtn.classList.remove('is-exhausted');
  setDisabled(doubleBtn, paid && !pending);
  doubleBtn.setAttribute('aria-disabled', String(paid && !pending));
  doubleLabel.textContent = pending ? t('quest_sync_retry')
    : paid ? t(quest && resultView.questVerified ? 'quest_verified' : 'adDoubleClaimed')
    : quest ? t(user.matchesCount === 9 || user.hardWins === 4 ? 'quest_ad_button_final' : 'quest_ad_button_standard')
    : t('adDoubleCta');
  /* the consolation tint belongs to the reward, never to the key that doubles it */
  resultCoinChip.classList.toggle('is-doubled', coins > 0);
}

/** The stake band reads what the match owes — or what the shield already gave back. */
function paintStakeValue(): void {
  if (!resultView) return;
  const refunded = hasClaimedInMatch('recover_tiq');
  resultStake.classList.toggle('is-refunded', refunded);
  /* the band's header and the key beside it are two different sentences: the header reports
     the stake ("STAKES BACK"), the key reports its own state ("RECOVERED ✓"). Reusing one
     string for both is what made the row read twice. */
  resultStakeK.textContent = t(refunded ? 'resultStakeReturned' : 'resultStakeLost');
  resultStakeSaved.textContent = t('result_stake_saved');
  /* the morph owns the pair until the shield lands: a repaint mid-flight (a language flip,
     a second paint) must not jump the band ahead of the animation already running */
  if (stakeMorphing) return;
  resultStakeN.hidden = refunded;
  resultStakeSaved.hidden = !refunded;
  resultStakeN.classList.remove('is-struck');
  if (!refunded) resultStakeN.textContent = `−${resultAbs(resultView.stake)} ${t('resultTiqUnit')}`;
}

/** A chip's working face: spinner out, taps off, `aria-busy` on. */
function setChipBusy(btn: HTMLButtonElement, spin: HTMLElement, busy: boolean): void {
  btn.setAttribute('aria-busy', String(busy));
  btn.classList.toggle('is-busy', busy);
  spin.hidden = !busy;
}

/* ---- the pre-watch consent sheet ----
   No rewarded video may open from a bare chip tap: the SDK takes the whole screen, and a player
   who closes it early loses the reward without warning. The sheet is a promise the chip awaits;
   only its primary key resolves `true`, and every dismissal resolves `false`. */
type AdConfirmKind = 'tiq' | 'coins';

let adConfirmKind: AdConfirmKind | null = null;
let adConfirmResolve: ((accepted: boolean) => void) | null = null;
let adConfirmOpener: HTMLElement | null = null;

function paintAdConfirmCopy(): void {
  if (!adConfirmKind) return;
  const tiq = adConfirmKind === 'tiq';
  adConfirmTitle.textContent = t(tiq ? 'ad_confirm_title_tiq' : 'ad_confirm_title_coins');
  adConfirmDesc.textContent = t(tiq ? 'ad_confirm_desc_tiq' : 'ad_confirm_desc_coins');
  adConfirmWatch.textContent = t('ad_confirm_watch');
  adConfirmIco?.setAttribute('href', tiq ? '#i-shield' : '#i-play');
}

function askAdConfirm(kind: AdConfirmKind): Promise<boolean> {
  if (adConfirmResolve || !adConfirm.hidden) return Promise.resolve(false);
  adConfirmKind = kind;
  paintAdConfirmCopy();
  hideAdToast();
  adConfirmOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  adConfirm.hidden = false;
  void adConfirm.offsetWidth;                 // lay the sheet out at its closed position first
  adConfirm.classList.add('open');
  /* the card behind the scrim is not a tab stop while the consent sheet is the only answer */
  resultCard.toggleAttribute('inert', true);
  try { adConfirmWatch.focus({ preventScroll: true }); } catch { /* no focus in headless */ }
  return new Promise<boolean>((resolve) => { adConfirmResolve = resolve; });
}

function closeAdConfirm(accepted: boolean): void {
  const resolve = adConfirmResolve;
  if (!resolve) return;
  adConfirmResolve = null;
  adConfirmKind = null;
  adConfirm.hidden = true;
  adConfirm.classList.remove('open');
  resultCard.removeAttribute('inert');
  const back = adConfirmOpener;
  adConfirmOpener = null;
  if (back && back.isConnected) {
    try { back.focus({ preventScroll: true }); } catch { /* opener is gone */ }
  }
  resolve(accepted);
}

adConfirm.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  if (!target?.closest('[data-ad-confirm-cancel]')) return;
  impact('light');
  closeAdConfirm(false);
});
adConfirmWatch.addEventListener('click', () => { impact('light'); closeAdConfirm(true); });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !adConfirmResolve) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  impact('light');
  closeAdConfirm(false);
}, true);

type AdToastTone = 'info' | 'success' | 'error';

let adToastTimer = 0;
/** The ad's answer, over the capsule rather than inside it: the card never grows a line. */
function showAdToast(msg: string, tone: AdToastTone = 'info', ms = 3600): void {
  adToast.textContent = msg;
  adToast.classList.toggle('is-success', tone === 'success');
  adToast.classList.toggle('is-error', tone === 'error');
  adToast.classList.add('show');
  clearTimeout(adToastTimer);
  adToastTimer = window.setTimeout(() => {
    adToast.classList.remove('show', 'is-success', 'is-error');
    adToast.textContent = '';
  }, ms);
}

function hideAdToast(): void {
  clearTimeout(adToastTimer);
  adToast.classList.remove('show', 'is-success', 'is-error');
  adToast.textContent = '';
}

/**
 * One claim count-up: `paint` receives the eased fraction, so a signed stake and a bare coin total
 * can share the same clock. Reduced motion lands on the final value in the same frame.
 */
function animateClaim(ms: number, paint: (eased: number) => void, store: (id: number) => void): void {
  if (motionReduced() || ms <= 0) {
    paint(1);
    store(0);
    return;
  }
  /* the first frame is painted here, synchronously, and the handle is live before this returns:
     a repaint on the same tick (a label flip, a second paint) must not snap the number to the
     value the animation is still travelling toward */
  paint(0);
  const t0 = performance.now();
  const tick = (now: number) => {
    const k = Math.min(1, (now - t0) / ms);
    paint(1 - Math.pow(1 - k, 3));
    if (k < 1) {
      store(requestAnimationFrame(tick));
      return;
    }
    store(0);
  };
  store(requestAnimationFrame(tick));
}

/**
 * The crimson `−14 TIQ` is struck out first, then a glowing emerald shield lands in its place.
 * The beat between the two is deliberate: the player reads the penalty being cancelled before
 * the value changes, instead of the number silently turning into a different one.
 */
function animateStakeRefund(): void {
  stakeMorphing = true;
  resultStakeSaved.hidden = true;
  resultStakeSaved.classList.remove('is-lit');
  resultStakeN.hidden = false;
  resultStakeN.classList.add('is-struck');
  const settle = () => {
    stakeMorphing = false;
    resultStakeN.classList.remove('is-struck');
    resultStakeN.hidden = true;
    resultStakeSaved.textContent = t('result_stake_saved');
    resultStakeSaved.hidden = false;
    resultStake.classList.add('is-refunded');
    resultStakeK.textContent = t('resultStakeReturned');
    restartClass(resultStakeSaved, 'is-lit');
  };
  resultLater(settle, motionReduced() ? 0 : 480);
}

/** The pill's total climbs from `+X` to `+(2X)` while the coin takes one gold shimmer. */
function animateCoinTotal(base: number): void {
  restartClass(resultCoinChip, 'is-celebrating');
  resultLater(() => resultCoinChip.classList.remove('is-celebrating'), motionReduced() ? 0 : 700);
  animateClaim(520, (eased) => {
    resultCoinsN.textContent = resultAbs(base * (1 + eased));
  }, (id) => { coinRaf = id; });
}

let recoverBusy = false;
let doubleBusy = false;

/**
 * The shield: one rewarded video buys the stake back. The refund lands in `tiqBonus`, which is the
 * same linear term `tiqFrom` reads, so the rating the HUD shows moves by exactly the stake.
 */
async function claimTiqRecovery(): Promise<void> {
  const view = resultView;
  if (!view || view.won || view.stake <= 0) return;
  /* one video at a time across both chips: the SDK's own mutex would answer `skipped`, which
     reads as the player's fault rather than a tap that simply arrived too early */
  if (recoverBusy || doubleBusy || hasClaimedInMatch('recover_tiq')) return;
  if (getRemainingTiqRecoveries() <= 0) return;

  if (!(await askAdConfirm('tiq'))) return;
  /* the sheet can outlive the card: re-check the settlement before a fullscreen video opens */
  if (resultView !== view || !overlayOpen) return;
  if (recoverBusy || doubleBusy || hasClaimedInMatch('recover_tiq')) return;
  if (getRemainingTiqRecoveries() <= 0) return;

  recoverBusy = true;
  setChipBusy(recoverBtn, recoverSpin, true);
  /* the defeat fanfare does not play under a rewarded video: stop it with the rest of the audio */
  stopDefeat();
  holdAudio();                              // the race goes quiet under the video
  const outcome = await playRewardedAd('recover_tiq', {
    /* a player who left the result while the tag was still loading gets no video over the menu */
    stillWanted: () => overlayOpen && resultView === view,
  }).finally(releaseAudio);
  recoverBusy = false;
  setChipBusy(recoverBtn, recoverSpin, false);

  /* an ad that outlived the capsule must not pay into a match that is already gone */
  if (resultView !== view) return;

  if (!outcome.rewarded) {
    paintRewardButtons();
    const exhausted = outcome.reason === 'no_fill' || outcome.reason === 'no_sdk';
    showAdToast(t(exhausted ? 'adToastUnavailable' : 'ad_failed_incomplete'), 'error');
    return;
  }

  const stake = view.stake;
  earnTiq(stake);                           // the save flushes, so every HUD reader follows
  recordTiqRecovery();                      // the receipt: only a completed view spends a recovery
  markClaimedInMatch('recover_tiq');
  paintSeatIdentity();                      // the top HUD's TIQ pill reads the save
  /* the strike starts first and owns the number; the repaint then only moves the chip and the
     band's copy, so the band strikes −stake before the shield replaces it */
  animateStakeRefund();
  paintRewardButtons();
  showAdToast(t('ad_success_tiq_saved'), 'success');
  notify('success');
}

async function claimDoubleCoins(): Promise<void> {
  const view = resultView;
  if (!view || doubleBusy || recoverBusy) return;
  const user = referralQuestUser();
  const quest = isReferralQuestActive(user) && view.hardBotDuel && user.dailyMatches < user.dailyMatchCap;
  const retry = quest && view.questAdCompleted && !view.questVerified;
  if ((view.coins <= 0 && !quest) || (hasClaimedInMatch('double_coins') && !retry)) return;

  doubleBusy = true;
  setChipBusy(doubleBtn, doubleSpin, true);
  try {
    const matchId = quest ? await view.questMatch() : null;
    if (resultView !== view || !overlayOpen) return;
    if (quest && !matchId) {
      showAdToast(t('quest_unavailable'), 'error');
      return;
    }
    if (!retry) {
      if (!(await askAdConfirm('coins'))) return;
      if (resultView !== view || !overlayOpen) return;
      stopDefeat();
      holdAudio();
      const outcome = await playRewardedAd('double_coins', {
        stillWanted: () => overlayOpen && resultView === view,
      }).finally(releaseAudio);
      if (resultView !== view) return;
      if (!outcome.rewarded) {
        const exhausted = outcome.reason === 'no_fill' || outcome.reason === 'no_sdk';
        showAdToast(t(exhausted ? 'adToastUnavailable' : 'ad_failed_incomplete'), 'error');
        return;
      }
      earnCoins(view.coins);
      markClaimedInMatch('double_coins');
      animateCoinTotal(view.coins);
      view.questAdCompleted = quest;
    }
    if (quest && matchId && isReferralQuestActive(referralQuestUser())) {
      const verified = await verifyReferralQuestMatch(matchId, view.won);
      view.questVerified = verified.verified;
      if (resultView !== view) return;
      showAdToast(t(verified.verified ? 'quest_match_verified_toast'
        : verified.error === 'daily_cap' ? 'quest_daily_cap' : 'quest_sync_failed'),
      verified.verified ? 'success' : 'error', 4600);
      notify(verified.verified ? 'success' : 'warning');
    } else {
      const doubled = String(Math.round(view.coins * 2));
      showAdToast(t('ad_success_coins_doubled').replace('{coins}', doubled), 'success', 4600);
      notify('success');
    }
  } finally {
    if (resultView === view) {
      doubleBusy = false;
      setChipBusy(doubleBtn, doubleSpin, false);
      paintRewardButtons();
    }
  }
}

recoverBtn.addEventListener('click', () => { void claimTiqRecovery(); });
doubleBtn.addEventListener('click', () => { void claimDoubleCoins(); });

let overlayOpen = false;
function showOverlay() {
  if (overlayOpen) return;
  overlayOpen = true;
  /* The invited duel has genuinely settled. This is the flag that separates a real "return to
     Home after the duel" from a stray tab hop during an invite launch that never reached a board. */
  inviteDuelSettled = true;
  /* The board reached its result: one match report, measured from `restart()`. A lesson has no
     clock open, so this is a no-op there. */
  finishMatch();
  clearResultMotion();
  /* a fresh settlement owns a fresh budget: last match's claims must never pay this one */
  resetMatchClaims();
  recoverBusy = false;
  doubleBusy = false;
  setChipBusy(recoverBtn, recoverSpin, false);
  setChipBusy(doubleBtn, doubleSpin, false);
  resultStake.classList.remove('is-refunded');
  resultStakeN.hidden = false;
  resultStakeN.classList.remove('is-struck');
  resultStakeSaved.hidden = true;
  closeAdConfirm(false);
  hideAdToast();
  const won = state.winner === localSide;
  /* A rival who walked out mid-race leaves a machine in the chair. The capsule opens with its
     rematch and banter already dead: there is nobody on the far side of that socket. */
  if (active && 'goneSides' in active && active.goneSides().includes(rivalSide())) resultLocked = true;
  /* one credit per finished race: showOverlay only runs once per game over. The Admin Command
     Center's Double-Coins multiplier scales what the settlement pays. A seat the machine held is
     the one exception: it pays nothing and it touches no ladder, because a bot is not a person and
     neither is a seat somebody walked out of. */
  const mine = !room || rewardEligible(room, localSide);
  /* the ladder's counters, with machine-held boards already taken back out: a bot race leaves
     both of these untouched, which is what makes its TIQ delta exactly zero */
  const beforeTally = ladderTally();
  const beforeTiq = tiqFrom(beforeTally.wins, beforeTally.games, profile.tiqBonus);
  /* Churchill's integrity gate: the share of this seat's wall budget still in hand at the
     final turn — the same wall count the board's chips carry. */
  const wallCap = wallBudget(sizes.reduce((n, balls) => n + balls, 0));
  const defenseHeld = wallCap > 0
    && state.wallsLeft[localSide] / wallCap >= BADGE_REQUIREMENTS.churchill_bastion.minDefenseHealth;
  /* One settlement returns the wallet and the XP pool together, and says whether the machine
     held the far side. A bot board pays coins and XP on a WIN only, and never any TIQ. */
  const boardMode = matchMode();
  const settled = mine
    ? recordGame({
      /* the three inputs the mode sheet quoted: level, seat count and reward family. The
         settlement's payout/XP doors pass these straight into `computeMatchRewards()`. */
      difficulty, won, mode: boardMode, defenseHeld,
      rewardMode: matchRewardMode ?? undefined,
      ranked: rankedPvp(),
      /* the race ended without a finish line: a ranked run never survives a void board */
      forfeit: forfeit !== null,
      seats: sizes.length,
    }, runtime.coinMult)
    : { coins: 0, xp: 0, bot: boardMode === 'bot' };
  const earned = settled.coins;
  /* CLEAN COMPLETION & PERSISTENCE. The governed debut has settled and `recordGame()` has flushed
     the tally (`games >= 1`). Spend the one-shot flag in the very same result beat and disarm the
     controller, so Play again (which calls `restart()` directly, without `startGame()`) and every
     later match use the standard AI and real matchmaking. `hydrate()` keeps the flag monotonic, so
     a stale cloud blob can never re-arm the assist. */
  if (onboardingConsumesDebut) {
    markFirstOnboardingWin();
    onboardingConsumesDebut = false;
  }
  if (onboardingActive()) deactivateOnboarding();
  recordRace(earned);                   // the Command Center's Stats tab counts the day's duels
  /* FIRST-DUEL WELCOME CUSHION. The debut is the likeliest churn moment — and a new invitee
     usually loses to the experienced friend who sent the link — so the +200 lands on a defeat as
     surely as on a win. `claimFirstDuelBonus()` stamps the flag and credits the wallet in ONE
     flush, so a reload or a second result can never mint it twice. It is deliberately OUTSIDE
     `earned`/`resultView`: the double-coins chip must still multiply only the race payout. */
  const welcomeBonus = claimFirstDuelBonus();
  bonusBadge.hidden = welcomeBonus <= 0;
  const afterTally = ladderTally();
  const afterTiq = tiqFrom(afterTally.wins, afterTally.games, profile.tiqBonus);
  /* the HUD's XP pill reads the save, so paint it on the same beat the settlement moves it */
  paintSeatIdentity();
  /* The ladder's own gain on a win, and the crimson stake the defeat asks for. */
  resultView = {
    won,
    coins: earned,
    xp: settled.xp,
    bot: settled.bot,
    /* a bot board is TIQ-neutral by rule, so its pill and its stake never exist */
    tiq: settled.bot || !mine ? 0 : Math.max(0, afterTiq - beforeTiq),
    stake: settled.bot || !mine ? 0 : Math.max(5, Math.round(runtime.winTiq * 0.1)),
    hardBotDuel: hardBotDuel && !active && forfeit === null,
    questMatch,
    questAdCompleted: false,
    questVerified: false,
  };
  overlay.classList.toggle('win', won);
  overlay.classList.toggle('lose', !won);
  paintResultCopy();
  resultTiqN.textContent = '0';
  resultCoinsN.textContent = '0';
  resultXpN.textContent = '0';
  resultStakeN.textContent = `−1 ${t('resultTiqUnit')}`;
  overlay.hidden = false;
  /* the card and its standings ladder are on screen: the one moment the result fanfare belongs to.
     The two voices are mutually exclusive by construction — a win gets the victory fanfare, a loss
     gets the defeat sting, and whichever engine is asked, the other one is handed back first — and
     each voice is single-shot per result. The heavy impact adds the weight under the error buzz that
     follows below (a forfeit has already had its buzz from endOnline). */
  if (won) {
    stopDefeat();
    playVictoryFanfare();
  } else {
    stopVictoryFanfare();
    playDefeat();
    impact('heavy');
  }
  /* The reaction tray serves every capsule: a duel lands its bubbles on the speaker's row, a
     party on whichever row they own, and a race against the machine answers on its own. */
  banter.open({ localSide, rivalSide: rivalSide(), locked: resultLocked });
  if (won && !motionReduced()) { confetti.burst(); invalidate(); }
  rollResultValues();
  if (!won) {
    /* endOnline has already buzzed a forfeit; do not repeat it under the card. */
    if (!forfeit) notify('error');
  } else if (!forfeit) {
    notify('success');
  }
  menuBtn.disabled = true;              // the panel already offers Play again and Menu
  /* a locked rematch cannot take the focus it never gets: the quiet door does */
  if (resultLocked) toMenu.focus({ preventScroll: true });
  else again.focus({ preventScroll: true });
  /* The first open's tutorial match has now reached the FINISH line. Give the result card one
     beat to be read, then route the new player cleanly to #s-home — the main menu they never saw
     on the way in. If they already left, or hit Play again, the guards make this a no-op. */
  if (firstRunSprint) {
    firstRunSprint = false;
    window.setTimeout(() => {
      if (overlayOpen && router.current === 'game') quitToMenu();
    }, 3600);
  }
}

/**
 * The beat the goal zone gets for itself. The rules land a winner the moment the ball touches row 0,
 * and the renderer answers with a golden light sweep along the unified finish bar — but the result
 * card lays a scrim over the whole board, so a card that lands on the same tick buries the one thing
 * the board does to mark the line being taken.
 *
 * The card waits for the whole endgame finisher instead: the winner is crowned, then every losing
 * pawn overheats and detonates in sequence, and the sheet opens only after the last spark settles.
 * The beats are the renderer's (`finishCue` hands back the plan); this side is responsible for the
 * sound and the haptics, and the renderer's own completion callback owns opening the sheet.
 */
const GOAL_BEAT_MS = 600;                 // a winner with no rival to shatter: the goal pulse alone
/** A checkmate decision has no shattered rival to wait for: hold the card until the splash clears. */
const CHECKMATE_BEAT_MS = 1900;
let goalBeat = 0;
/** A finisher is on the board: the result sheet now belongs to the renderer's completion callback. */
let finishPending = false;
/** Every timer the finisher owns besides the sheet's own, so leaving the race clears them all. */
let finishTimers: number[] = [];
/** Bumped on every cancel: a callback that was already queued can never land in a new race. */
let finishRun = 0;

/** Is the endgame in flight (finisher playing or its fallback beat ticking)? */
function finishUnderway(): boolean {
  return goalBeat !== 0 || finishPending;
}

function armGoalBeat() {
  if (overlayOpen || finishUnderway()) return;
  const winner = state.winner;
  if (winner === null) return;
  menuBtn.disabled = true;               // no pause sheet opening onto a race that is already settled
  /* Farthest from the line first, so the closest rival is the last one standing — and the last
     thing heard before the card. A pawn already checkmated off the board is not shattered twice;
     the one the deciding trap just sealed is, so a duel's checkmate still ends on its explosion. */
  const deciding = state.checkmate?.decided ? state.checkmate : null;
  const justSealed = (b: Ball): boolean =>
    deciding?.cells.some((cell) => cell.c === b.pos.c && cell.r === b.pos.r) ?? false;
  const losers = state.balls
    .filter((b) => b.team !== winner && (!b.isCheckmated || justSealed(b)))
    .sort((a, b) => b.pos.r - a.pos.r)
    .map((b) => ({ id: b.id, cell: b.pos }));
  /* The crowned pawn: the winning seat's leading ball, which is the one that crossed the line. */
  let winnerBall: number | null = null;
  let lead = Infinity;
  for (const b of state.balls) {
    if (b.team !== winner || b.isCheckmated) continue;
    if (b.pos.r < lead) { lead = b.pos.r; winnerBall = b.id; }
  }
  /* The finisher plays under every motion setting: an Android battery saver flips the OS
     reduced-motion flag on its own, and the end-of-race explosion is gameplay feedback, not
     decoration. Only a race with nobody left to shatter falls back to the plain goal pulse. */
  const plan = renderer.finishCue(winnerBall, losers);
  if (!plan.bursts.length) {
    const beat = state.checkmate?.decided ? CHECKMATE_BEAT_MS : GOAL_BEAT_MS;
    goalBeat = window.setTimeout(() => { goalBeat = 0; showOverlay(); }, beat);
    return;
  }
  const run = ++finishRun;
  finishPending = true;
  /* The renderer starts its finisher clock on the first frame it paints. Two rAFs are the
     guarantee that frame has happened (the loop's own callback is always registered ahead of
     these), so the detonation beats are armed against the picture, not against the cue call. */
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (run !== finishRun || !finishPending) return;
    /* Every burst is its own beat: the synthesized boom and the heavy buzz land on the same frame
       the shards leave the pawn. Synthesized because the finisher cannot go silent on an asset that
       failed to fetch or had not decoded yet — the deep bass hit is built on the spot, every time. */
    for (let i = 0; i < plan.bursts.length; i++) {
      finishTimers.push(window.setTimeout(() => {
        if (run !== finishRun) return;
        playBoom(0.92);
        shatterImpact();
        shake(true);
      }, plan.bursts[i]));
    }
  }));
}

/**
 * The renderer painted the finisher's final settle frame. The match result is heavy — save writes,
 * standings, the sheet's whole DOM — and it belongs after the explosion, never on top of it. The
 * zero-delay task lets the last frame present before that work begins.
 */
function finishSettled() {
  window.setTimeout(() => {
    if (!finishPending) return;
    /* `showOverlay` flips `overlayOpen` on its first line, so no `ui()` repaint can re-arm the
       finisher between this call and the sheet taking the stage. */
    showOverlay();
    finishPending = false;
  }, 0);
}

function clearGoalBeat() {
  finishRun++;
  finishPending = false;
  for (const id of finishTimers) window.clearTimeout(id);
  finishTimers = [];
  if (goalBeat) window.clearTimeout(goalBeat);
  goalBeat = 0;
  renderer.cancelFinish();
}

/**
 * A real duel, not a practice board: a networked seat, or a room with a person on the far side.
 * The invited first-timer's micro-coach belongs here and nowhere else — a solo bot race already
 * has the standalone lesson, and a bot-backfilled seat is not a friend waiting on the other end.
 */
const isLiveDuel = (): boolean => !!active || hasHumanRival(room, localSide);

/**
 * FIRST-TWO-TURNS MICRO-COACH. Called from `ui()` on every repaint, but it counts only the
 * TRANSITION into one of this seat's turns (a pause, a hover or a re-paint cannot double-count).
 * Nothing here freezes the board, disables an input, or touches the tutorial's stage machine:
 * it raises a fading, pointer-transparent obsidian/gold pill and nothing else.
 */
function maybeMicroCoach(): void {
  const myTurn = state.winner === null && state.turn === localSide;
  if (!myTurn) { coachWasMyTurn = false; return; }
  if (coachWasMyTurn) return;
  coachWasMyTurn = true;
  if (microCoachQuiet) return;
  if (hasCompletedTutorial()) return;
  if (tutorialActive || tutorialStandalone || firstRunBoot || waitingForMineTrigger) return;
  if (!isLiveDuel()) return;
  myTurnCount++;
  if (myTurnCount <= 2) {
    const step: 1 | 2 = myTurnCount === 1 ? 1 : 2;
    /* `restart()` paints its first `ui()` while #s-game can still be hidden behind the face-off.
       Hold the hint for `reveal()` in that case; on a rematch the board is already up, so raise it
       at once. Either way each turn gets exactly ONE hint and the fade starts when it is readable. */
    if (router.current === 'game') showMicroCoach(step);
    else pendingCoachStep = step;
  }
  if (myTurnCount >= 2) microCoachQuiet = true;   // quiet for the rest of the match
}

function ui() {
  /* Every state change passes through here. With an event-driven loop the board must be told to
     paint once — a tap, a turn hand-off or a socket roster must never wait for a loop that is
     deliberately asleep. */
  invalidate();
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
  if (mineArmed && (stage === 'mine-place' || stage === 'mine-confirm')) {
    /* the staged square stays placeable through its own confirmation, so the ✓/✕ pair the lesson
       is pointing at is never dropped by the repaint that raised it */
    const target = stage === 'mine-confirm' && mineGhost ? { cell: mineGhost } : tutorialMineTarget();
    mineHints = target ? [target.cell] : [];
  }
  /* an armed cell that is no longer placeable — the turn moved on, or a ball rolled over it */
  if (mineGhost && !mineHints.some((h) => sameCell(h, mineGhost))) mineGhost = null;
  armCapsules();
  /* the pawns moved: the event callouts' slots are resolved against them, not against pixels */
  syncPieces();
  /* the rival's dots tick for a bot's think time and for a person's just the same */
  const thinking = rivalTurn() && !paused && !tutorialActive;

  setClass(dots, 'on', thinking);

  setAttr(mineBtn, 'aria-pressed', String(mineArmed));
  /* the lesson leaves exactly one live key per stage: only the ARM step enables the mine pod.
     During the live-play intermission the LAST charge is held back for that step. */
  setDisabled(mineBtn, tutorialActive
    ? stage !== 'mine-arm'
    : (!live || minesLeft(state, localSide) <= 0 || mineReserved()));
  setMineCount(minesLeft(state, localSide));

  /* whose turn it is rides on the chips now: a clay glow, a lift, and the countdown ring */
  const seat = state.winner ?? state.turn;
  for (const p of roster()) {
    setClass(chips[p], 'active', state.winner === null && state.turn === p && !paused);
    setClass(chips[p], 'thinking', thinking && p === state.turn);
    /* a checkmated seat is off the board: its strip reads as struck, and it never wears the turn */
    setClass(chips[p], 'is-out', isEliminated(state, p));
    setWalls(p, wallsRemaining(state, p));
    if (p !== localSide) setFog(p);
  }
  /* the flags and the XP pills ride along: both are diffed, so this is a comparison per seat */
  paintSeatIdentity();
  const spoken = state.winner !== null ? `${TEAM_NAME[seat]} win${seat === localSide ? '' : 's'}`
    : seat === localSide ? 'Your turn' : `${TEAM_NAME[seat]}'s turn`;
  if (spoken !== saidTurn) { saidTurn = spoken; announce.textContent = spoken; }

  /* one turn per seat makes a round; the counter is the UI's, the rules keep none */
  setText(roundLabel, `Round ${Math.floor(turnsPlayed / Math.max(1, state.teams.length)) + 1}`);
  paintClock();

  if (state.winner === null && overlayOpen) {
    overlayOpen = false;
    overlay.hidden = true;
    clearResultMotion();
    closeAdConfirm(false);
    hideAdToast();
    resultView = null;
    resultLocked = false;
    banter.close();
    menuBtn.disabled = false;
  }
  if (state.winner !== null) {
    /* A settled board has no live opponent to reconnect: the pill would be a promise with no
       match left to keep it. */
    hidePeerPill();
    armGoalBeat();
  }
  /* the wall's live-play intermission ends on the board's own terms: two real rival turns, then
     this seat's turn. Called last so a resumed lesson's own repaint is the final word. */
  paintTutorialRoutes();
  if (waitingForMineTrigger) resumeMineLesson();
  /* a hint is a repaint, not a state machine: it never changes `state`, the mode or any input */
  maybeMicroCoach();
}

async function runOpponent() {
  if (state.winner !== null || !wantsOpponent() || tutorialActive) return;
  const token = ++gen;
  if (token !== gen) return;
  if (paused) await new Promise<void>((res) => waiting.push(res));   // parked until Resume
  if (token !== gen) return;
  /* The brain reasons on the fog it has always been fed; the debut gates read the FULL board.
     `hold` is dropped during the lesson's live-play intermission, whose two-row rival stride is
     part of the tutorial's choreography and must still be allowed to happen. */
  const a = await opponent.think(fogOfWar(state, state.turn), state, !waitingForMineTrigger);
  if (token !== gen) return;
  /* ULTIMATE FALLBACK: no safe, non-winning action is left for the rival. Award the resignation
     instead of letting it play a move that would end the race against the player. */
  if (a === null) { concedeOnboarding(); return; }
  if (play(a)) return;
  /* On the debut board a rejected action is already a deadlock: the gates validated it on this
     exact state, so a refusal means the turn cannot be spent safely. Do not fall through to a raw
     step that could cross FINISH — concede instead. */
  if (onboardingActive()) { concedeOnboarding(); return; }
  /* a bot only sees its own side of the fog, so it can pick a square the human already mined —
     which the rules now settle as a dual detonation rather than refusing. A pick the board still
     rejects (a budget already spent, a pawn in the way) falls back to a plain step, so the turn is
     never thrown away */
  const st = teamSteps(state, state.turn)[0];
  play(st ? { kind: 'move', ball: st.ball, to: st.to } : { kind: 'pass' });
}

/**
 * Every charge this action spent, in the order the engine set them off. Triggered mines only ever
 * flip IN PLACE: the rule rebuilds exactly the entries that fired and carries every other mine
 * through by reference, so a freshly triggered record is one this board has never held before.
 * Identity rather than index keeps the answer right under fog of war, where an opponent mine that
 * was hidden before the move appears at the end of the list and can sit ahead of an older crater.
 *
 * `doMove()` stamps each rebuilt record with its `chainStep`, so a combo replays in the engine's
 * own order on both replicas of a race. A placement collision rebuilds two records on ONE square
 * without a `chainStep`; they keep the ledger's order and are still reported here, but only a MOVE
 * with more than one is a chain (see `play()`). No new state means no detonation — a hint, a hover
 * or a lookahead dry-run never produces one.
 */
function blastsOf(prev: GameState, next: GameState): Mine[] {
  if (prev === next) return [];
  const fresh = next.mines.filter((m) => m.triggered && !prev.mines.includes(m));
  /* Stable sort: charges without a step (the dual collision) stay in ledger order. */
  return fresh.sort((a, b) => (a.chainStep ?? 0) - (b.chainStep ?? 0));
}

/** The single-blast reader, kept for the lone-trap path and for callers that want one cell. */
function blastOf(prev: GameState, next: GameState): Mine | null {
  return blastsOf(prev, next)[0] ?? null;
}

/**
 * The single door every action comes through — taps, the bot, the blitz timeout and (with
 * `remote`) the rival's moves off the wire — so a networked race animates exactly like a local one.
 */
function play(a: Action, remote = false): boolean {
  const prev = state;
  /* PLAYER FAIL-SAFES (debut only). A tap that would seal the player in, walk their pawn onto a
     live charge, hand the rival a win, or trip the anti-oscillation adjudication is rewritten into
     the best safe FORWARD step. The scripted lesson is deliberately exempt: its stages own the
     board and expect the exact action they just asked for. Rival turns and relayed moves are left
     alone — `guardPlayerAction` is a no-op for any seat other than the local one. */
  if (!remote && onboardingActive() && !tutorialActive) {
    a = guardPlayerAction(state, a, localSide);
  }
  const by = state.turn;
  /* A charge committed onto a rival's buried charge. Read BEFORE the action is applied, because
     afterwards the two craters are indistinguishable from a trigger a ball walked into — and this
     seat's copy, its sound and the weight of its jolt all key off the difference. Both replicas of
     a race hold the same board, so both seats reach the same verdict here. */
  const duel = a.kind === 'mine' && rivalMineAt(prev, a.cell, by) !== null;
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
  /* The optimistic commit happens only after the wire takes it. A friend room queues the move
     while its socket reconnects; any other session that cannot send leaves the board untouched,
     so a failed send can never leave a pawn standing somewhere the server never approved. */
  if (!remote && active) {
    const sent = active.send(a);
    if (!sent && !('seats' in active)) return false;
  }
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
  if (waitingForMineTrigger) {
    countMineStride();
    if (by !== localSide) mineRivalTurns++;
  }
  turnsPlayed++;                 // one seat has acted; the round caption counts them
  mineGhost = null;
  setMode(BOARD_IDLE);           // the turn is over: the next pick is a fresh one
  autoPicked = null;             // ...and the next human turn auto-selects its own first ball
  clearNote();
  /* VFX GATE. Nothing on this board may detonate until an action has actually been COMMITTED:
     `apply()` has returned a new state and `state = next` has landed. Hints, hover and selection
     only ever read the board (dotsFor -> reachableBall) and never reach this door. Guarding on a
     genuinely new state also means an upstream dry-run apply() could never cue a blast here. */
  const committed = next !== prev;
  /* A MOVE that spent more than one charge is a combo. A `mine` placement collision also rebuilds
     two records, but both go off together on ONE square — that is a dual detonation, not a chain. */
  const blasts = committed && a.kind === 'move' ? blastsOf(prev, next) : [];
  const combo = blasts.length > 1;
  const blast = combo ? null : (committed ? blastOf(prev, next) : null);
  if (combo) {
    /* The rules already resolved the whole chain before this frame: `blasts[i]` IS the charge the
       ball was thrown onto by beat i-1, so its cell doubles as that beat's landing square. The last
       beat lands wherever the new state says the ball rests. No second simulation, no guessing. */
    const beats: BlastBeat[] = blasts.map((m, i) => ({
      at: m.cell,
      knock: moved !== null && from && landed
        ? {
            id: moved,
            from: i === 0 ? from : blasts[i - 1].cell,
            to: i + 1 < blasts.length ? blasts[i + 1].cell : landed,
          }
        : undefined,
    }));
    /* Beat 0 goes off immediately at the first charge; the renderer staggers every later beat on
       one clock and hands back each detonation's offset so the sound, the buzz and the jolt land
       exactly where the flash and the pawn are seen. */
    const offsets = renderer.blastChain(beats);
    const fx = blastGen;
    const heard = new Set<number>();
    for (let i = 0; i < offsets.length; i++) {
      const wait = offsets[i];
      /* Reduced motion collapses the whole chain onto one frame: one bang, not eight at once. */
      if (heard.has(wait)) continue;
      heard.add(wait);
      audio.play('explosion', wait > 0 ? { delay: wait / 1000 } : undefined);
      const boom = () => {
        if (fx !== blastGen) return;    // this race was restarted mid-combo
        detonation();
        shake(false);                   // a chain always takes the board's HEAVY jolt
      };
      if (wait > 0) window.setTimeout(boom, wait);
      else boom();
    }
    showNote(t('chainDetonationNote').replace('{n}', String(blasts.length)), false, 3000);
  } else if (blast) {
    const cells = landed ? landed.r - blast.cell.r : 0;
    /* Stage 1 belongs to the renderer: the pawn steps onto the charge before anything goes off.
       It hands back that beat's length, so the jolt, the bang and the buzz land on the detonation
       frame itself rather than on the move that walked into it. */
    const delay = renderer.blast(blast.cell, moved !== null && from && landed
      ? { id: moved, from, to: landed }
      : undefined);
    /* the bang is scheduled on the audio clock and the jolt/buzz on the same beat, so the blast is
       heard and felt where it is seen: under the ball standing on the charge. */
    audio.play('explosion', delay > 0 ? { delay: delay / 1000 } : undefined);
    /* a collision is two charges going off at once, so it takes the board's heavy jolt; a single
       trigger keeps the micro-shake it has always had */
    const fx = blastGen;
    const boom = () => {
      if (fx !== blastGen) return;
      shake(!duel);
      detonation();
    };
    if (delay > 0) window.setTimeout(boom, delay);
    else boom();
    showNote(duel
      ? t('dualDetonationNote')
      : `Mine! ${TEAM_NAME[by]} ${by === localSide ? 'were' : 'was'} thrown back `
        + `${cells} cell${cells === 1 ? '' : 's'}`, false, 2600);
  }
  /* ---- CHECKMATE: the rules just sealed a pawn's last route ----
     The canvas blows the trapped pawn off the board and the board speaks the verdict. A seat that
     lost its last pawn is out (a duel is already decided); a pawn sealed while a team-mate still
     runs gets the same blast and a quieter note, because the race goes on. */
  const trap: Checkmate | null = committed && next.checkmate !== prev.checkmate
    ? next.checkmate ?? null : null;
  if (trap) {
    if (trap.cells.length) {
      renderer.checkmate(trap.cells);
      /* the mine's own bang already owns the beat when the trap was sprung by its throw */
      if (!combo && !blast) {
        audio.play('explosion');
        detonation();
        shake(false);
      }
    }
    if (trap.teams.length) showCheckmateSplash();
    else if (trap.cells.length) showNote(t('checkmatePawnNote'), false, 2800);
  }
  ui();
  startClock();          // the turn has moved on: the next seat gets its own allowance
  /* ULTIMATE FALLBACK, player side: if the debut seat has somehow boxed itself in (no route to
     FINISH, eliminated, or no legal step on its own turn), the rival resigns immediately rather
     than the board grinding to a halt with no winner. */
  if (onboardingActive() && !tutorialActive && state.winner === null
    && playerIsStuck(state, localSide)) {
    concedeOnboarding();
    return true;
  }
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
  const base = Number.isFinite(n) && n > 0 ? n : CONFIG.TURN_TIME_LIMIT;
  /* TURN TIMER GRACE. The debut seat gets double the allowance, so a first-time player reading the
     board never loses a turn to the clock. The ring, the interval and the first paint all read this
     one function, so the HUD can never advertise a length the clock is not counting down. */
  return onboardingActive() ? base * ONBOARDING_TURN_GRACE : base;
};
/** The seconds left on the live turn, painted from the wall clock rather than decremented. */
let turnSecondsLeft: number = turnLimit();
/**
 * The instant this turn expires on the device clock. Every turn arms it once; hiding the webview
 * and coming back must not hand the seat a fresh allowance — the rival's clock kept running.
 */
let turnDeadlineAt = 0;
/** the fraction the ring last showed, so a refill never animates backwards through 1s of easing */
let ringFrac = -1;

/** Is the countdown this seat's to lose? */
const clockLive = () => !paused && !overlayOpen && !document.hidden && router.current === 'game'
  && state.winner === null && state.turn === localSide && !tutorialActive
  && !isEliminated(state, localSide);

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
  turnDeadlineAt = Date.now() + turnSecondsLeft * 1000;
  paintClock();
  if (clockLive()) turnTimerId = window.setInterval(tickClock, 1000);
}

/**
 * Returning to a board that was merely hidden: the turn's deadline survived, so the ring reads
 * what is actually left instead of resetting to a full allowance. This is the one path a
 * backgrounded mobile webview takes, and the reason a rival cannot steal a turn by waiting.
 */
function resumeClock() {
  if (!clockLive()) { paintClock(); return; }
  if (!turnDeadlineAt) { startClock(); return; }
  const leftMs = Math.max(0, turnDeadlineAt - Date.now());
  turnSecondsLeft = Math.ceil(leftMs / 1000);
  paintClock();
  if (leftMs <= 0) {
    turnSecondsLeft = 0;
    stopClock();
    paintClock();
    timeoutMove();
    return;
  }
  if (turnTimerId === null) turnTimerId = window.setInterval(tickClock, 1000);
}

/**
 * A snapshot from the room is the authority on the turn it is running: arm the local ring with
 * the server's remaining time (capped to this device's own allowance), so the two clocks agree.
 */
function armTurnClock(leftMs: number): void {
  stopClock();
  const cap = turnLimit() * 1000;
  const left = Math.max(0, Math.min(cap, Math.round(Number.isFinite(leftMs) ? leftMs : cap)));
  turnDeadlineAt = Date.now() + left;
  turnSecondsLeft = Math.ceil(left / 1000);
  paintClock();
  /* A zero clock is the server's to settle: it will play the fallback and relay the move. */
  if (left > 0 && clockLive()) turnTimerId = window.setInterval(tickClock, 1000);
}

/** What the clock last painted, so a repaint that changes nothing writes nothing. */
let shownTimerN = -1;
let shownTimerLive: boolean | null = null;
let shownTimerTone: string | null = null;
let shownRingOffset = '';
let shownRingTransition = '';

/**
 * The countdown, painted on the seat that owns it: a ring around its ball and the seconds punched
 * through the middle. The number is always there, so the colour is a heads-up and never the only
 * signal — accent past 5s, amber to 5s, red to 3s (where the ring also breathes).
 *
 * `ui()` calls this on every action, but the clock only moves once a second: every write is
 * diffed against the last painted value, so a tap does not re-style the ring or the chip.
 */
function paintClock() {
  const chip = chips[localSide];
  const left = Math.max(0, turnSecondsLeft);
  /* the number is painted whether or not the clock runs: an idle seat shows the turn's length, not
     whatever the last race happened to leave in the middle of the ring */
  if (shownTimerN !== left) {
    shownTimerN = left;
    timerN.textContent = String(left);
  }
  const live = clockLive();
  if (shownTimerLive !== live) {
    shownTimerLive = live;
    setClass(chip, 'timing', live);
    if (!live) {
      chip.removeAttribute('data-timer');
      shownTimerTone = null;
      return;
    }
  }
  if (!live) return;
  const frac = left / turnLimit();
  const transition = frac < ringFrac ? '' : 'none';
  if (shownRingTransition !== transition) {
    shownRingTransition = transition;
    timerFill.style.transition = transition;
  }
  ringFrac = frac;
  const offset = String(RING_C * (1 - frac));
  if (shownRingOffset !== offset) {
    shownRingOffset = offset;
    timerFill.style.strokeDashoffset = offset;
  }
  const tone = left <= URGENT_AT ? 'red' : left <= WARN_AT ? 'amber' : 'accent';
  if (shownTimerTone !== tone) {
    shownTimerTone = tone;
    chip.dataset.timer = tone;
  }
}

function tickClock() {
  /* The wall clock is the countdown: a throttled interval must not lengthen a turn. */
  const leftMs = Math.max(0, turnDeadlineAt - Date.now());
  const left = Math.ceil(leftMs / 1000);
  if (left <= 0) {
    turnSecondsLeft = 0;
    stopClock();
    paintClock();
    timeoutMove();
    return;
  }
  if (left === turnSecondsLeft) return;
  turnSecondsLeft = left;
  if (left <= URGENT_AT) impact('light');
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
  /* TIMEOUT GRACE. The engine never forfeits a turn — it auto-plays — but the debut takes the
     extra step of choosing the best FORWARD move that cannot detonate a charge or seal the pawn.
     `play()`'s own fail-safe would rewrite it anyway; picking it here keeps the toast honest. */
  const auto = onboardingActive()
    ? (bestSafeStep(state, localSide) ?? getAutoMove(state, state.turn))
    : getAutoMove(state, state.turn);
  play(auto);
  /* after play(), which clears the toast itself to make room for the next prompt */
  showNote(onboardingActive() ? 'Extra time — auto-move' : 'Auto-move', false, 1800, true);
}

function restart() {
  /* every new board is a new match: the last result's celebration (or its defeat sting) cannot
     survive into it */
  stopVictoryFanfare();
  stopDefeat();
  cancelTutorial();
  hideCheckmateSplash();
  /* A new match owns a fresh pair of turns. Resetting BEFORE `ui()` at the end of this function
     is what makes turn 1 of the invited duel count as turn 1 rather than inheriting a stale
     counter from the boot's idle board. */
  myTurnCount = 0;
  coachWasMyTurn = false;
  pendingCoachStep = 0;
  microCoachQuiet = false;
  hideMicroCoach();
  bonusBadge.hidden = true;
  /* A lesson is not a match; a real board starts a fresh telemetry clock even when the player
     replayed it from the pause sheet. */
  if (!tutorialStandalone) {
    beginMatch({ mode: matchMode(), players: sizes.length, matchId: active?.matchId });
  }
  gen++;
  const questGeneration = ++questEpoch;
  questMatch = hardBotDuel && !tutorialStandalone
    ? createReferralQuestMatch(() => questGeneration === questEpoch)
    : async () => null;
  void questMatch();
  blastGen++;      // drop any combo beats still scheduled against the previous board
  /* Release bot thinks parked by the pause sheet on the PREVIOUS board. Their `token !== gen`
     check drops them as soon as they resume, so a stale reply cannot move a fresh pawn — and no
     awaiting promise is left stranded to hold the next race's dispatcher. */
  for (const go of waiting.splice(0, waiting.length)) go();
  /* A fresh draw per race keeps the rivals' flags and XP stable for this board; an online race
     uses the seed the matchmaker handed both sides. */
  raceSeed = active ? active.seed : (Math.random() * 0x7fffffff) | 0;
  state = newGame(sizes);
  /* This screen's colours are client-side: the local seat wears the save's red/blue choice and the
     rival wears the other one. Set before the first paint of the new board. */
  renderer.setPerspective(currentPerspective());
  /* The gold VIP halo follows the entitlement, not the client's claim: the local seat reads the
     live pass, the rival reads the room's `MATCH_FOUND` stamp. */
  paintVipSeats();
  /* The grid the rules picked for this race — a duel keeps 8 columns, a 3- or 4-contender race gets
     10 — and the wall budget that goes with it. Both are read off the board, never assumed, so a
     menu change between races cannot leave the canvas painting the wrong lattice. `fitBoard` hands
     the same two numbers to CSS, which is what sizes the board box to the grid's own aspect. */
  renderer.setBoard(state.cols, state.rows);
  fitBoard(state.cols, state.rows);
  wallsEach = wallBudget(state.balls.length);
  /* The visual coordinates are born ON the spawn tile, never interpolated from the old board.
     `snapBalls()` is also the writer of `view.balls`, so the very first frame already has every
     token at its logical cell centre. */
  ballViews.length = 0;
  snapBalls();
  mineGhost = null;              // before the mode: `armCapsules` must not re-stage a dead square
  setMode(BOARD_IDLE);
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
  clearResultMotion();
  closeAdConfirm(false);
  resultView = null;
  resultLocked = false;
  closeVipSheet();
  banter.close();
  overlayOpen = false;
  overlay.hidden = true;
  overlay.classList.remove('win', 'lose', 'is-party');
  menuBtn.disabled = false;
  clearNote();
  confetti.stop();
  invalidate();      // a restart repaints the fresh board once, then the loop parks again
  renderer.resetFx();
  ui();
  startClock();
}

/**
 * Replace the local board with the room's authoritative snapshot, without restarting the match.
 * Used when a reconnect lands, when a refused move carries the server's state, and when a relayed
 * move arrived on the wrong turn. Every visual cache that could remember the stale board is
 * dropped; the pawns are placed on their logical cells before the next paint, so a jump is a clean
 * re-read rather than a tween across half the grid.
 */
function applyRoomSnapshot(next: GameState, turnLeftMs: number): void {
  if (!active) return;
  const dimsChanged = next.cols !== state.cols || next.rows !== state.rows;
  state = next;
  selected = null;
  autoPicked = null;
  mineGhost = null;
  setMode(BOARD_IDLE);
  if (dimsChanged) {
    renderer.setBoard(state.cols, state.rows);
    fitBoard(state.cols, state.rows);
    wallsEach = wallBudget(state.balls.length);
  }
  ballViews.length = 0;
  snapBalls();
  marks.length = state.teams.length;
  marks.fill(null);
  shownWalls.fill(-1);
  shownFlags.fill(undefined);
  shownXp.fill(-1);
  shownMines = -1;
  shownFog.fill(null);
  /* The server's deadline belongs to the seat that is up. This client only counts it when that
     seat is its own; on a rival's turn the ring stays at the idle allowance until the hand-off. */
  if (state.winner === null && state.turn === localSide) {
    armTurnClock(turnLeftMs);
  } else {
    stopClock();
    turnSecondsLeft = turnLimit();
    turnDeadlineAt = 0;
    paintClock();
  }
  ui();
  syncLoop();
}

/**
 * The colour family a seat wears on THIS screen: the local seat gets the player's chosen one, the
 * rival the opposite, then the fixed gold / green order for the extra seats a party adds. The chip's
 * class, the chat bubble's neon and the sphere all read this plan, so the three can never disagree
 * about who is who — which is the whole point when four balls share one tile.
 */
function seatTint(p: Player): PawnTint {
  const chosen = pieceColor();
  if (p === localSide) return chosen;
  if (p === rivalSide()) return chosen === 'red' ? 'blue' : 'red';
  const extras = [0, 1, 2, 3].filter((x) => x !== localSide && x !== rivalSide());
  return extras.indexOf(p) === 0 ? 'gold' : 'amethyst';
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
     chosen family, its rival the opposite, then the fixed gold / amethyst order for extra seats.
     Online, the local seat can be seat 1 — the class follows the perspective, not the index. */
  for (let p = 0; p < chips.length; p++) {
    const el = chips[p];
    if (!el) continue;
    const on = p < n;
    el.hidden = !on;
    const color = seatTint(p);
    el.classList.toggle('red', color === 'red');
    el.classList.toggle('blue', color === 'blue');
    el.classList.toggle('gold', color === 'gold');
    el.classList.toggle('amethyst', color === 'amethyst');
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
  paintRaceTags();
}

/** Persian figures for the mode tag: "۳ نفره" reads as Farsi, "3 نفره" reads as a glitch. */
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const tagDigits = (n: number): string => {
  const s = String(n);
  return lang === 'fa' ? s.replace(/\d/g, (d) => FA_DIGITS[Number(d)]) : s;
};
/**
 * The same sentence with Latin figures: the result caption is always "1 به 1 · سخت" and never
 * "۱ به ۱ · سخت". Persian keeps its own figures where the copy is genuinely Persian prose (the
 * pause header); a standing, a score and a count on the result card read as 0-9 everywhere.
 */
const toLatinDigits = (s: string): string =>
  s.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)));
const DIFF_TAG: Record<Difficulty, string> = {
  easy: 'pauseDiffEasy', normal: 'pauseDiffNormal', hard: 'pauseDiffHard',
};

/** The contender count in the tag's own tongue: a duel, a party of three or four, or a sized pair. */
function raceShapeTag(): string {
  if (sizes.length > 2) return t('pauseShapeParty').replace('{n}', tagDigits(sizes.length));
  if (sizes[0] === 1 && sizes[1] === 1) return t('pauseShapeDuel');
  return t('pauseShapeVs').replace('{a}', tagDigits(sizes[0])).replace('{b}', tagDigits(sizes[1]));
}

/**
 * The race names itself where a race is being stopped or judged, not on every frame of play: the
 * pause header and the result caption. A practice board carries the machine's level, a live seat
 * the company it keeps — a friend's room or the ranked queue. Both are translated, so a language
 * flip repaints them without needing a new race.
 */
function paintRaceTags(): void {
  const kind = quitKind();
  const context = kind === 'practice' ? t(DIFF_TAG[difficulty])
    : t(kind === 'duel' ? 'pauseTagFriends' : 'pauseTagOnline');
  const mode = `${raceShapeTag()} · ${context}`;
  pauseMode.textContent = ` · ${mode}`;
  overMode.textContent = toLatinDigits(mode);
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
  /* the ring and its seconds now live on a different chip: forget every diffed value */
  shownTimerN = -1;
  shownTimerLive = null;
  shownTimerTone = null;
  shownRingOffset = '';
  shownRingTransition = '';
}

/** How a race starts: the local shape, plus the live seat when the matchmaker paired one. */
interface StartSetup {
  difficulty: Difficulty;
  mode?: 'vs_bot';
  /** The mode-sheet family this launch was previewed under (`practice` | `friendly` | `ranked`). */
  rewardMode?: string;
  isQuestMatch?: boolean;
  /** one entry per seat — `[1, 1]` is a duel, `[1, 1, 1, 1]` a four-way. Capped at `MAX_TEAMS`. */
  sizes: readonly number[];
  online?: OnlineSession | LobbyRace | null;
  /** The lobby this race came out of, when it came out of one: it names the seats, says which are
   *  the machine's, and pays only the seats a person actually held to the end. */
  room?: Room | null;
  /** The countdown already staged this match: go straight to the board, no second face-off. */
  quiet?: boolean;
}

/**
 * The seats the face-off puts on the other side of the crest. A live pairing brings its own rival;
 * a room's machine seats and a plain bot race are dressed by the clash itself, because "Hard bot"
 * is a setting and "Kestrel of the Obsidian Cortex, IR" is a reason to win.
 */
function clashRivals(): VsRival[] {
  const out: VsRival[] = [];
  if (active) {
    if ('seats' in active) {
      for (const seat of active.seats) {
        if (seat.side === localSide) continue;
        out.push(seat.bot
          ? { id: `${active.code}:${seat.side}`, bot: room ? difficultyFor(room, seat.side) : difficulty }
          : { id: seat.id, name: seat.name });
      }
    }
    if (!out.length) {
      const o = active.opponent;
      out.push({ id: o.id, name: o.name, avatarUrl: o.avatarUrl, country: o.flag ?? null, tiq: o.tiq });
    }
    return out;
  }
  if (room) {
    for (let p = 0; p < sizes.length; p++) {
      if (p === localSide) continue;
      out.push(isAutomated(room, p)
        ? { id: `${room.code}:${p}`, bot: difficultyFor(room, p) }
        : { id: `seat:${p}`, name: seatName(room, p) });
    }
    return out;
  }
  for (let p = 0; p < sizes.length; p++) {
    if (p === localSide) continue;
    out.push({ id: `bot:${p}`, bot: difficulty });
  }
  return out;
}

function startGame(setup: StartSetup) {
  cancelTutorial();
  /* A status pill from the previous race is not this race's news. */
  hidePeerPill();
  /* A board on screen outranks a challenge that is still being read: the duel veil steps aside
     instead of covering the race it was offering. */
  dismissDuelVeil();
  /* a new race owns a new reward budget: whatever the last settlement claimed is not this one's.
     The result screen resets it again on open, so both ends of a match start clean. */
  resetMatchClaims();
  /* A background friends lobby hears that this seat is on another board, so its countdown holds
     instead of launching the player into a second race. Cleared by `quitToMenu`. */
  notifyMatchBusy(true);
  /* Only a local bot race teaches, and only until the lesson has been finished or skipped. An
     online seat — or a room another person is sitting in — is somebody else's board: the lesson
     never covers it. A practice room (this player plus the machine) is still a local bot race,
     which is what the Play Dock launches, so the lesson stays reachable there. */
  const requested = tutorialRequested;
  tutorialRequested = false;
  /* STRICT FIRST-TIME-ONLY. A late server/profile hydrate can restore match history after boot,
     so stamp the lesson flag before ANY launch decision: a returning player on a fresh cache is
     never auto-routed into onboarding. The persistent flag is then read once here and again at the
     mode-selection door; the pure rule refuses online seats and rooms held by other people. A
     returning player who finished OR skipped the lesson therefore NEVER auto-routes into it:
     `wantsTutorial` stays false and the requested mode (Practice, 1v1, private room) launches
     directly. A manual replay (`requested`) is the ONLY thing that may override the flag. */
  reconcileTutorialFromHistory();
  const completed = hasCompletedTutorial();
  /* An invite launch owns its first race. Even a room that lost its host to a bot backfill (so the
     pure rule below would see a "local" board) must NOT be replaced by the standalone lesson: the
     friend's room is where this player was promised to land. The window closes as soon as that
     first duel settles, so the normal first-time rule is unchanged afterwards. A MANUAL request
     (`requested`, from the lobby training card) is never gated by this. */
  const inviteBootWindow = INVITE_DUEL_LAUNCH && !inviteDuelSettled && !completed;
  const questLaunch = setup.isQuestMatch === true && isReferralQuestActive(referralQuestUser());
  const autoLesson = !completed
    && !questLaunch
    && !inviteBootWindow
    && autoTutorialForLaunch()
    && shouldAutoStartTutorial({
      online: !!setup.online,
      room: humansIn(setup.room) > 1,
      completed,
    });
  const wantsTutorial = requested || autoLesson;
  /* ---- GUARANTEED FIRST-MATCH VICTORY ----
     Eligibility is the one-shot persistent flag, NOT `stats.games`: the standalone first-boot
     lesson already settles a race but is a scripted win, so it must not spend the debut. Three
     exclusions keep the assist out of boards that are not ours to script:
       · a friendly invite room with a person on the far side (invite launch, room code, or a
         second human seat) — a friend must be allowed to win honestly;
       · an ad-verified Referral Hard Bot quest, whose server-side verification demands strict
         Hard AI (and which launches straight into its own match);
       · the standalone / auto / manually replayed LESSON. It is already a scripted, guaranteed
         finish with its own choreography (including the rival's two-row live-play stride), so it
         is left untouched — and it does NOT spend the debut. The first race a player could
         actually lose is the one the controller is owed to govern. */
  const invitedRoom = INVITE_DUEL_LAUNCH || !!INVITE_ROOM_CODE || !!peekPendingDuelRoom()
    || humansIn(setup.room) > 1 || hasHumanRival(setup.room ?? null, setup.online?.side ?? 0);
  const questPending = setup.isQuestMatch === true || isReferralQuestActive(referralQuestUser());
  const debut = isFirstOnboardingEligible() && !invitedRoom && !questPending && !wantsTutorial;
  onboardingConsumesDebut = debut;
  if (debut) activateOnboarding(); else deactivateOnboarding();
  /* A lesson that replaces the launch is the whole match: its end returns to Home. Pause →
     Replay is the one lesson that runs inside a real match and hands the board straight back. */
  tutorialStandalone = wantsTutorial;
  /* Preserve the exact difficulty AND the exact reward family the drawer quoted. Both survive
     every repaint and are read back by `showOverlay()` when the race settles. */
  difficulty = setup.difficulty;
  matchRewardMode = setup.rewardMode ?? null;
  /* MATCHMAKING OVERRIDE FOR MATCH #1. Any live seat that still reached this door — a late
     MATCH_FOUND, a relic challenge accepted in-session — is dropped BEFORE a single socket
     callback is wired. The board becomes a local AI-controlled duel, so the outcome is 100% under
     client control. `close()` is the no-forfeit release, never `resign()`. */
  const droppedLive = debut && !!setup.online;
  let live = setup.online ?? null;
  if (droppedLive && live) { live.close(); live = null; }
  /* An online seat brings its own board and side; a local race is always seat 0 against the rest. */
  active = live;
  forfeit = null;
  resultLocked = false;
  localSide = active ? active.side : 0;
  /* A room's seats are its own — one ball per seat, however many it filled with bots. A room that
     arrived with a live socket is discarded with it; a local practice room keeps its bot roster. */
  room = droppedLive ? null : (setup.room ?? null);
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
  /* The debut never arms a server-verified Hard Bot quest: that ladder's strict AI is the one
     thing the onboarding controller must not soften. */
  hardBotDuel = !active && !debut && (!room || setup.mode === 'vs_bot') && difficulty === 'hard'
    && sizes.length === 2 && sizes.every((n) => n === 1) && !wantsTutorial;
  paused = false;
  restart();
  seatChrome();
  paintSeatTints();       // the mine key is dock furniture now: it wears the local seat's colour
  paintNames();
  paintSeatIdentity();
  /* a networked board cannot be restarted into the same seat: the pause sheet only offers leaving */
  $('pause-restart').hidden = !!active;
  /* Replay runs on the board it is clicked from, so the key rides wherever the lesson itself can
     run: never on an online seat, never on a room another person is sitting in. Every local race
     — 1v1, 2-, 3- and 4-player practice alike — launches as a practice room of this player plus
     the machine, so the test is the people in the room, not the room itself. Mirrors the guard
     in `beginTutorial()`, so the key is visible exactly where clicking it starts the lesson. */
  $('pause-tutorial').hidden = !!active || humansIn(room) > 1;

  if (active) {
    const session = active;
    /* the rival's moves come through the same door the bot's do, so walls, mines and the blitz
       hand-off all animate exactly as they do offline */
    session.onMove((action, side) => {
      if (state.winner !== null) return;
      if (side === state.turn) {
        if (!play(action, true) && 'seats' in session) session.requestSync();
        return;
      }
      /* A relayed move that names a seat which is not up means the two replicas drifted — a
         dropped packet, a queued local move, a server-side timeout. Ask for the room's board
         instead of applying an action the local turn does not allow. */
      if ('seats' in session) session.requestSync();
    });
    /* the rival's emote: the same bubble and the same "Haha!" as a local tap, over their own pawn —
       and `side` is whose pawn that is, so a party race points at the seat who sent it */
    session.onEmote((emote, side) => chat.inboundEmote(emote, side));
    /* the rival's tactical line: their (lang, index) pair looked back up in the same closed table */
    session.onPhrase((lang, index, side) => chat.inboundPhrase(lang, index, side));
    /* the rival's post-match line: it lands on whichever standings row their seat owns, wearing
       the crown only when the room vouched for that seat's VIP entitlement */
    session.onPostChat((line, side, vip) => banter.inbound(line, side, vip));
    /* the settled socket died, or the rival walked out: the result's live keys go with it */
    session.onPostLeft(() => { if (overlayOpen || finishUnderway()) lockResultForLeft(); });
    session.onEnd((end) => endOnline(end));
    session.onReject(() => {
      notify('error');
      showNote('Move refused — the two boards disagree', true, 2400);
      /* The refusal frame normally carries the authoritative board (which `onSync` applied just
         before this). Ask again when it did not, so the repair is never left to a toast. */
      if ('seats' in session) session.requestSync();
    });
    if ('seats' in session) {
      /* Friend-room only: a peer's reconnect grace, and the authoritative snapshot that repairs
         a board after a resume, a refusal or an explicit sync request. */
      session.onPeerStatus((side, status, graceMs) => setPeerStatus(side, status, graceMs));
      session.onSync((next, turnLeftMs) => applyRoomSnapshot(next, turnLeftMs));
    }
  }

  /* The face-off owns the reveal, and the reveal is the only thing it owns. Routing is deferred to
     its callback, so the board never ticks behind the crest — `syncLoop()` runs frames and the turn
     clock only while the game screen is up. An automated browser and the lesson both get the
     original synchronous path: the clash answers `onReveal` before it returns. */
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    /* The face-off is asynchronous: a route event or a late sheet close during the cinematic can
       leave `paused` set. With that flag up `syncLoop()` cancels every frame and the board shows
       a grid with no pawns, so entering a race always clears it. */
    paused = false;
    /* The reveal can be several frames after `restart()`. Re-snap here too, so the first visible
       frame is guaranteed to hold every pawn on its exact spawn tile centre. */
    snapBalls();
    router.go('game');
    /* The first turn began in `restart()` behind the face-off (or the lobby veil). The board is
       only now visible, so this is the instant its wall clock starts. */
    startClock();
    /* Kick the loop immediately — do not wait for another route or visibility event. */
    syncLoop();
    /* `hidden` was cleared a line ago: re-fit now, then verify once after the DOM settles. */
    settleBoard();
    /* The first turn began in `restart()`, while #s-game was still hidden behind the face-off.
       Raise its held hint on the very first frame the invited player can read the board, so the
       fade never burns down during a cinematic nobody could see. */
    if (pendingCoachStep) {
      showMicroCoach(pendingCoachStep);
      pendingCoachStep = 0;
    }
    /* `autoLesson` asks for one last storage read at the moment the overlay opens, so a save that
       became complete during the face-off cinematic can never resurrect the lesson. */
    if (wantsTutorial) beginTutorial(autoLesson);
  };
  /* A room that already counted itself down has had its ceremony — the FIGHT flash *was* the
     reveal — so it goes straight to the board rather than paying for a second cinematic. */
  if (setup.quiet || questLaunch) { reveal(); return; }
  const rivals = wantsTutorial ? [] : clashRivals();
  showVsClash(rivals, {
    kind: active ? 'ranked' : room ? 'room' : 'bot',
    tier: rivals.find((r) => r.bot)?.bot ?? undefined,
    seats: sizes.length,
    nonce: raceSeed,
  }, reveal);
}

/**
 * The online race ended without a finish line: award it, say why, and stop the clock. The board is
 * left exactly as it stands — nothing is rewound, because both screens stopped on the same turn.
 */
function endOnline(end: RaceEnd): void {
  hidePeerPill();
  /* The board is already settled, so this frame is the rival walking out of the result capsule —
     by closing the tab, going back to the menu or losing the socket. Nothing is awarded twice:
     the rematch key and the banter dock simply stop pretending somebody is still there. */
  if (state.winner !== null) {
    /* only the result capsule needs the guard: a socket closed on the way out of the board is
       already past the point where a rematch could be offered */
    if (overlayOpen || finishUnderway()) lockResultForLeft();
    return;
  }
  forfeit = end.why;
  state = { ...state, winner: end.win ? localSide : rivalSide() };
  /* Only a resignation leaves the rival's socket open long enough to taunt. A dropped or
     abandoned connection, or an operator abort, has nobody on the far side of a rematch. */
  if (end.why !== 'resign') resultLocked = true;
  stopClock();
  ui();
  notify(end.win ? 'success' : 'error');
  showNote(end.win
    ? (end.why === 'resign' ? 'Rival resigned — you win' : 'Rival left — you win')
    : end.why === 'aborted' ? 'Room closed by an operator' : 'Connection lost',
  !end.win, 3000);
}

/**
 * ULTIMATE DEADLOCK / FORCED-WIN FALLBACK. The rival has no safe non-winning action left, or the
 * debut player has somehow boxed themselves in. Award the race as an opponent resignation in the
 * same shape `endOnline()` uses — set the winner and let `ui()` arm the ordinary finisher — so the
 * result card, the tally and the one-shot flag all settle through the one existing door. There is
 * no parallel settlement path and nothing to pay out twice.
 */
function concedeOnboarding(): void {
  if (!onboardingActive() || state.winner !== null) return;
  /* A lesson card must not sit on top of the result capsule. */
  if (tutorialActive || waitingForMineTrigger) cancelTutorial();
  stopClock();
  state = { ...state, winner: localSide };
  showNote('Opponent resigned — you win', false, 3200);
  notify('success');
  ui();                  // winner !== null -> armGoalBeat() -> finishSettled() -> showOverlay()
}

/** The rival is gone: raise the badge, dead the taunt keys and lock the rematch in one beat. */
function lockResultForLeft(): void {
  resultLocked = true;
  banter.opponentLeft();
  if (!resultView) return;             // the card is still behind the goal beat: it opens locked
  paintResultLock();
  /* a search stage on top owns the focus; the dead capsule behind it must not steal it back */
  if (overlayOpen && !matchmaking.isOpen) toMenu.focus({ preventScroll: true });
}

/** The pause sheet's quit key names its verdict before it is ever tapped: leaving a practice board
 *  is an exit, leaving a live seat is a forfeit. */
function paintPause(): void {
  pauseQuitBtn.textContent = t(quitKind() === 'practice' ? 'pauseQuit' : 'pauseForfeit');
}

/** One dialog, three faces. Staying is always the primary key; only a ranked exit wears crimson —
 *  a practice board or a friend's round costs no stake, so its confirm stays a quiet second key. */
function paintQuit(): void {
  const kind = quitKind();
  const key = kind === 'practice' ? 'quitPractice' : kind === 'duel' ? 'quitDuel' : 'quitForfeit';
  quitTitle.textContent = t(`${key}Title`);
  quitBody.textContent = t(`${key}Body`);
  quitStay.textContent = t(`${key}Stay`);
  quitYes.textContent = t(`${key}Confirm`);
  const ranked = kind === 'forfeit';
  quitYes.classList.toggle('btn-danger', ranked);
  quitYes.classList.toggle('btn-ghost', !ranked);
}

/** The one door into the pause sheet: the HUD's menu key and the system back key both take it. */
function openPause(): void {
  pauseGame();
  paintPause();
  sheets.open(sheetPause);
  ui();
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

/**
 * However the pause family goes away — Resume, Restart, Replay tutorial, the scrim, Escape, the
 * system back key, or the quit sheet's Stay — a live board must never be left silently paused:
 * with the flag stuck the loop stays cancelled, `canAct()` swallows every tap and a parked bot
 * promise never resolves, which is the whole board freezing. The wired keys call `resumeGame()`
 * themselves; this is the net the sheets' close hook holds under every other door out. It only
 * answers the pause family, only on the game screen with no sheet left above the board, and
 * never over a lesson or a settled race. `resumeGame()` is itself a no-op unless a pause is
 * actually holding the board, so the wired keys passing through here change nothing.
 */
function resumeAfterSheetClose(el: HTMLElement): void {
  if (el !== sheetPause && el !== sheetQuit) return;       // only the pause family pauses the board
  if (router.current !== 'game' || sheets.isOpen) return;  // off the board, or another sheet owns it
  if (tutorialActive || state.winner !== null) return;     // a lesson or a settled race owns it
  resumeGame();
}

function quitToMenu() {
  /* Any exit ends the first-open session: the sprint's deferred Home hop must not outlive a
     player who already left the board, and a later race is never a cold boot. */
  firstRunBoot = false;
  firstRunSprint = false;
  /* An abandoned board is not a settled match: disarm the assist without spending the flag, so the
     next `startGame()` re-arms it for a debut that has still never been won. */
  deactivateOnboarding();
  cancelTutorial();                 // leaving mid-lesson does not count as having read it
  /* A board abandoned before its verdict is not a match: drop the open clock without reporting. */
  setIdle();
  /* The board is leaving the screen: a waiting room can count down again, and its HUD banner
     (if one was raised) is the only thing left to act on. */
  notifyMatchBusy(false);
  hidePeerPill();
  hideCheckmateSplash();
  /* a race that ended inside the goal beat still has to be paid out before the board goes away */
  if (finishUnderway()) { clearGoalBeat(); showOverlay(); }
  /* Menu, the back button and a quit all land here: the fanfare never follows the board home */
  stopVictoryFanfare();
  stopDefeat();
  if (overlayOpen) {
    clearResultMotion();
    closeAdConfirm(false);
    resultView = null;
    resultLocked = false;
    banter.close();
    overlayOpen = false;
    overlay.hidden = true;
  }
  sheets.close();
  /* Walking out of a live online race is a resignation: the rival takes the win immediately, and
     the socket goes with it — leaving it open would only hold the other player's seat hostage. */
  if (active) {
    /* Only an unsettled board can be forfeited. A race that already reached its verdict was paid
       out by `showOverlay()` above (or by the goal beat), and must not be counted twice. */
    if (state.winner === null) {
      active.resign();
      /* The forfeit is a defeat on this device's ledger too, not only in the room: the tally, the
         streak and the TIQ the ladder derives from them move exactly as a finished loss would.
         Practice is exempt — `matchMode()` already counts a bot-backfilled room as practice, so
         walking out of one costs no rating and no stake. */
      const mode = matchMode();
      const ranked = rankedPvp();
      if (mode !== 'bot' && (!room || rewardEligible(room, localSide))) {
        recordGame({ difficulty, won: false, mode, ranked, forfeit: true }, runtime.coinMult);
      }
    }
    active.close();
    active = null;
  }
  paused = true;
  router.popTo('home');
}

/* ---------- input ---------- */

/**
 * One layout read per frame at most. Touch events arrive at 120–240 Hz on a phone, and every
 * `getBoundingClientRect()` issued right after a `ui()`/`setMode()` DOM write forces a
 * synchronous layout — the classic touch-time thrash that shows up as input lag. The canvas box
 * only changes on a resize or a screen slide (both far slower than a frame), so a short-lived
 * cache is exact while cutting those forced layouts by an order of magnitude.
 */
let boardBoxCache: DOMRect | null = null;
let boardBoxAt = -Infinity;
const BOARD_BOX_TTL = 32;
function boardBox(): DOMRect {
  const now = performance.now();
  if (!boardBoxCache || now - boardBoxAt > BOARD_BOX_TTL) {
    boardBoxCache = canvas.getBoundingClientRect();
    boardBoxAt = now;
  }
  return boardBoxCache;
}
/** Drop the cached box when the layout genuinely changes. */
function dropBoardBox() { boardBoxCache = null; boardBoxAt = -Infinity; }

const local = (e: PointerEvent) => {
  const r = boardBox();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};

function refuse(w: Wall) {
  const why = wallIssue(state, w);
  showNote(REASON[why], true, 2200);
  if (why === 'dry') warnNoWalls(w.owner);
  notify('warning');
}

/** Every live ball on the board, in cell coordinates, for the hit-test. */
const cells = () => state.balls
  .filter((b) => !b.isCheckmated)
  .map((b) => ({ id: b.id, team: b.team, c: b.pos.c, r: b.pos.r }));

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

/** Clear the wall ghost and anything it was holding (its toolbar included). */
function disarmWall() {
  wallDrag = null;
  setMode({ ...mode(), preview: null });
  clearNote();
}

/**
 * Put the wall ghost up at `spec`, armed and wearing its toolbar. Nothing is committed here: only
 * the toolbar's green key (or the tutorial's single-tap lesson) actually spends a wall.
 */
function previewWallAt(spec: WallSpec): boolean {
  const wall: Wall = { ...spec, owner: state.turn };
  if (wallsRemaining(state, wall.owner) <= 0) {
    setMode({ ...mode(), preview: null });
    refuse(wall);
    return false;
  }
  const ok = wallOk(state, wall);
  setMode(previewWall(mode(), { spec, ok, armed: true, p: state.turn }));
  if (ok) {
    impact('light');
    showNote('Drag to aim · tap the centre to rotate', false, 0);
  } else refuse(wall);
  return true;
}

/** Slide an already-armed ghost without re-firing the placement toast on every drag frame. */
function slideWall(spec: WallSpec) {
  const wall: Wall = { ...spec, owner: state.turn };
  const ok = wallOk(state, wall);
  setMode(previewWall(mode(), { spec, ok, armed: true, p: state.turn }));
  if (ok) clearNote();             // a refusal from the slot the finger just left is now stale
}

/** Turn the armed ghost 90° about its centre. An illegal turn stays up, ready to be turned back. */
function rotateGhost() {
  if (!ghost) return;
  const spec = rotateWall(ghost.spec);
  const wall: Wall = { ...spec, owner: state.turn };
  const ok = wallOk(state, wall);
  setMode(previewWall(mode(), { spec, ok, armed: true, p: state.turn }));
  impact('light');
  if (ok) showNote('Drag to aim · tap the centre to rotate', false, 0);
  else refuse(wall);
}

/** The toolbar's green key: the one door that spends a wall. */
function commitWall() {
  if (!ghost) return;
  const wall: Wall = { ...ghost.spec, owner: state.turn };
  if (!wallOk(state, wall)) { refuse(wall); return; }
  play({ kind: 'wall', wall });
}

/**
 * The wall ghost's input branch: the toolbar commits, rotates or cancels; another groove moves the
 * ghost without committing; a ball or a legal-move dot drops the ghost and plays that move.
 * Returns true when the tap was handled here.
 */
function wallBranch(hit: Hit | null): boolean {
  if (hit?.kind === 'confirm') { commitWall(); return true; }
  if (hit?.kind === 'rotate') { rotateGhost(); return true; }
  if (hit?.kind === 'cancel') { disarmWall(); return true; }
  if (hit?.kind === 'wall') {
    /* tapping the bar away from its centre is dead space: the centre is the rotate handle, and the
       rest of that groove is already the ghost's own slot */
    const same = ghost?.armed && ghost.spec.o === hit.spec.o
      && ghost.spec.x === hit.spec.x && ghost.spec.y === hit.spec.y;
    if (!same) previewWallAt(hit.spec);
    return true;
  }
  if (!ghost?.armed) return false;
  if (hit?.kind === 'ball') { disarmWall(); impact('light'); pick(hit.id === selected ? null : hit.id); return true; }
  if (!hit) { disarmWall(); pick(null); return true; }        // neutral board space cancels
  return false;
}

/**
 * The mine key's tap branch: your own pawn leaves placement mode and comes to hand, while any other
 * tap runs the two-tap flow — the first arms the square, the second buries it.
 */
function tapMine(hit: Hit | null): boolean {
  /* This branch stages/cancels the two-tap mine square without a full `ui()` repaint, so it must
     wake the parked loop itself or the ✓/✕ pair would never appear on the tapped tile. */
  invalidate();
  /* your own pawn is the board's way out of placement mode: the key lets go, the pawn is picked */
  if (hit?.kind === 'ball') { impact('light'); pickFromMine(hit.id); return true; }
  // board background, or the [✕] cap: disarm the mine ghost and its caps
  if (!hit || hit.kind === 'cancel') { mineGhost = null; armCapsules(); return true; }
  if (hit.kind === 'mine-confirm') {
    if (mineGhost) play({ kind: 'mine', cell: mineGhost });
    return true;
  }
  if (hit.kind !== 'mine') return false;
  mineGhost = hit.cell;
  armCapsules();
  impact('light');
  /* No pill on this beat. The ✓/✕ pair is the whole instruction once a square is staged, and the
     board's toast parks low enough to land on it — so the flow says its piece in the live region
     alone and leaves the two discs clear. */
  announceNote('Mine staged. Confirm to bury it, or cancel.');
  return true;
}

/** The lesson's vocabulary for a hit-test result: a first tap stages, a green key commits. */
function tutorialHitAction(hit: Hit | null): TutorialAction | null {
  if (!hit) return null;
  switch (hit.kind) {
    case 'ball': return { kind: 'select', ball: hit.id };
    case 'move': return { kind: 'move', to: hit.to };
    case 'wall': return { kind: 'wall-stage', spec: hit.spec };
    case 'confirm': return { kind: 'wall', spec: hit.spec };
    case 'mine': return { kind: 'mine-stage', cell: hit.cell };
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
 * canvas receives this tap exactly as it would after the lesson. Both placements run the game's
 * own two taps: stage the ghost, then press its green key.
 */
function tutorialTap(p: Vec) {
  const stage = tutorialStage();
  const box = boardBox();
  const vx = box.left + p.x, vy = box.top + p.y;
  /* The goal card goes on the FINISH band itself, or on its Start key (wired in tutorial.ts). */
  if (stage === 'goal') {
    const goal = tutorialFinishTarget();
    if (goal && tutorialSpotHas(goal, vx, vy)) {
      impact('light');
      tutorial?.advance();
    } else {
      tutorial?.nudge();
    }
    return;
  }
  const hit = at(p);
  /* The ✕ beside a staged ghost is a real way back to the first tap, never a nudge. */
  if (hit?.kind === 'cancel') {
    if (stage === 'wall-confirm' && ghost?.armed) {
      impact('light');
      disarmWall();
      tutorial?.notify({ kind: 'wall-cancel' });
      return;
    }
    if (stage === 'mine-confirm' && mineGhost) {
      impact('light');
      mineGhost = null;
      armCapsules();
      invalidate();        // the canvas owns the pair: repaint it once after the cancel
      tutorial?.notify({ kind: 'mine-cancel' });
      return;
    }
    tutorial?.nudge();
    return;
  }
  let action = tutorialHitAction(hit);
  /* The groove is a hairline and the ✓ a small disc: a tap anywhere inside the ring the lesson
     paints counts as a tap on the thing it is pointing at. */
  if (stage === 'wall-stage') {
    const target = tutorialWallTarget();
    if (target && tutorialSpotHas(target.spot, vx, vy)) action = { kind: 'wall-stage', spec: target.spec };
  } else if (stage === 'wall-confirm' && ghost?.armed) {
    const target = tutorialWallConfirmTarget();
    if (target && tutorialSpotHas(target.spot, vx, vy)) action = { kind: 'wall', spec: ghost.spec };
  } else if (stage === 'mine-confirm' && mineGhost) {
    const target = tutorialMineConfirmTarget();
    if (target && tutorialSpotHas(target.spot, vx, vy)) action = { kind: 'mine', cell: mineGhost };
  }
  if (!action || !isTutorialActionAllowed(action)) { tutorial?.nudge(); return; }
  const L = renderer.layout();
  renderer.ripple((p.x - L.ox) / L.cell, (p.y - L.oy) / L.cell, localSide);
  invalidate();           // a queued ripple is a finite transition: wake the parked loop
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
    case 'wall-stage': {
      /* FIRST tap: the ghost stands in the groove and raises the board's real ✓/✕ toolbar. No
         toast comes with it — from here the green key IS the whole instruction. */
      const wall: Wall = { ...action.spec, owner: state.turn };
      if (!wallOk(state, wall)) { tutorial?.nudge(); return; }
      setMode(previewWall(mode(), { spec: action.spec, ok: true, armed: true, p: state.turn }));
      impact('light');
      break;
    }
    case 'wall': {
      const wall: Wall = { ...action.spec, owner: state.turn };
      if (!wallOk(state, wall) || !play({ kind: 'wall', wall })) { tutorial?.nudge(); return; }
      /* the bar locks in with weight: the rival's dashed route bends around it on this frame */
      impact('heavy');
      shake(true);
      break;
    }
    case 'mine-stage':
      /* FIRST tap: stage the charge on the exact tile the lesson names. The board's own pair
         comes up and the spotlight walks onto its green disc; nothing is buried yet. */
      mineGhost = action.cell;
      armCapsules();
      impact('light');
      break;
    case 'mine':
      /* SECOND tap: bury it through the same `play()` every real race uses. */
      if (!play({ kind: 'mine', cell: action.cell })) { tutorial?.nudge(); return; }
      break;
    default:
      return;   // the arm key is a dock button, and cancels are handled above
  }
  tutorial?.notify(action);
}

/**
 * Touch: whatever the live key offers is what a tap acts on — the floating keys, a ball, a line, or
 * a square. An armed wall ghost owns the tap first; otherwise the strict move/groove arbitration wins.
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
  }
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
    /* an armed ghost keeps its slot and its toolbar, and a spent budget shows none */
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
  /* A click on neutral board space puts the picked pawn back down and drops any hovered ghost —
     the same cancel a touch gets. Nothing is committed until a dot or a slot is chosen. */
  if (!hit) { pick(null); return; }
  clearGhost();
}

/** Begin carrying the ghost: a short press is a tap, travel past `DRAG_SLOP` is a slide. */
function startWallDrag(e: PointerEvent, p: Vec, tap: 'centre' | 'groove') {
  wallDrag = { id: e.pointerId, x: p.x, y: p.y, moved: false, tap };
  try { canvas.setPointerCapture(e.pointerId); } catch { /* best-effort: pointerup still lands */ }
}

/** Release the ghost. An unmoved press on the bar's centre turns it; a dragged slot is left armed. */
function endWallDrag(e: PointerEvent, release: boolean) {
  const drag = wallDrag;
  if (!drag || e.pointerId !== drag.id) return;
  wallDrag = null;
  try {
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  } catch { /* the capture may already have been dropped by the browser */ }
  if (!drag.moved) {
    if (release && drag.tap === 'centre') rotateGhost();
    return;
  }
  if (release && ghost && !ghost.ok) refuse({ ...ghost.spec, owner: state.turn });
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!canAct()) return;
  const p = local(e);
  if (tutorialActive) { tutorialTap(p); return; }
  const L = renderer.layout();
  renderer.ripple((p.x - L.ox) / L.cell, (p.y - L.oy) / L.cell, localSide);   // the tap answers at once
  invalidate();           // the ripple must paint even when the loop is asleep
  if (mineArmed) { tapMine(at(p)); return; }
  const hit = at(p);
  /* the toolbar's rotate key fires on press; the ghost's own centre waits for pointerup so the
     same press can turn into a drag instead of rotating under the finger */
  if (hit?.kind === 'rotate' && hit.from === 'capsule') { rotateGhost(); return; }
  if (ghost?.armed && (hit?.kind === 'rotate' || hit?.kind === 'wall')) {
    if (hit.kind === 'wall') {
      const same = ghost.spec.o === hit.spec.o && ghost.spec.x === hit.spec.x && ghost.spec.y === hit.spec.y;
      if (!same && !previewWallAt(hit.spec)) return;
    }
    startWallDrag(e, p, hit.kind === 'rotate' ? 'centre' : 'groove');
    return;
  }
  if (hit?.kind === 'wall') {
    if (!previewWallAt(hit.spec)) return;
    startWallDrag(e, p, 'groove');
    return;
  }
  if (e.pointerType === 'mouse') onMouse(p, true);
  else onTouch(p);
});

canvas.addEventListener('pointermove', (e) => {
  if (tutorialActive) return;
  const p = local(e);
  if (wallDrag) {
    if (e.pointerId !== wallDrag.id) return;
    if (!wallDrag.moved) {
      const dx = p.x - wallDrag.x, dy = p.y - wallDrag.y;
      if (dx * dx + dy * dy < DRAG_SLOP * DRAG_SLOP) return;
      wallDrag.moved = true;
    }
    if (ghost?.armed) {
      /* the bar keeps the orientation it has and follows the nearest line of that family; turns
         are the centre tap's or the toolbar's job */
      const spec = dragWallSlot(renderer.layout(), p.x, p.y, ghost.spec.o);
      if (spec.x !== ghost.spec.x || spec.y !== ghost.spec.y) slideWall(spec);
    }
    return;
  }
  if (e.pointerType !== 'mouse') return;
  onMouse(p, false);
});
canvas.addEventListener('pointerup', (e) => endWallDrag(e, true));
canvas.addEventListener('pointercancel', (e) => endWallDrag(e, false));
canvas.addEventListener('pointerleave', () => {
  if (tutorialActive || wallDrag) return;
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
  /* The cached canvas box: `armCapsules()` runs on every drag frame, and a live `getBoundingClientRect`
     there was a forced layout between pointermove writes. `dropBoardBox()` re-primes it on refit. */
  const box = boardBox();
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
 * The wall lesson's real target: a legal horizontal groove directly above the rival's pawn. The
 * candidates are tried nearest-first, then the whole lattice, so a crowded party board still finds
 * a groove that is genuinely legal instead of pointing at a refused slot.
 *
 * Two rules the lesson adds on top of `wallOk`, which only guards its OWN author's route: every
 * live pawn must still have a way to FINISH (a wall that checkmated the rival would end the race
 * inside the tutorial), and a groove that actually lengthens the rival's run wins over one that
 * does not — the detour the dashed line then draws is the whole point of the step.
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
  const before = pathOn(distField(state.walls, state.cols, state.rows), rival.pos, state.cols);
  let fallback: WallSpec | null = null;
  for (const spec of candidates) {
    const wall: Wall = { ...spec, owner: localSide };
    if (!wallOk(state, wall)) continue;
    const walls = [...state.walls, wall];
    if (!hasPathToFinish(state, walls)) continue;
    if (pathOn(distField(walls, state.cols, state.rows), rival.pos, state.cols) > before) {
      return { spec, spot: grooveSpot(spec) };
    }
    if (!fallback) fallback = spec;
  }
  return fallback ? { spec: fallback, spot: grooveSpot(fallback) } : null;
}

/**
 * The wall's SECOND tap: the green key of the toolbar the staged ghost raised. The ring rides the
 * key alone; the input door is the whole strip, so the ✕ beside it stays a real way back.
 */
function tutorialWallConfirmTarget(): TutorialTargetWall | null {
  if (state.turn !== localSide || state.winner !== null) return null;
  if (!ghost?.armed || !ghost.ok) return null;
  const keys = capsuleStage();
  if (!keys) return null;
  return {
    spec: ghost.spec,
    spot: { rect: keys.confirm, radius: Math.max(keys.confirm.width, keys.confirm.height) / 2 },
    door: keys.pair,
  };
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
 * The gold FINISH banner: the goal card's own target, and the re-pulse that answers the forward
 * step. Exactly the top row, so the guidance is the board's real goal line and never a floating band.
 */
const tutorialFinishTarget = (): TutorialSpot | null =>
  state.winner === null ? { rect: boardRect(0, 0, state.cols, 1), radius: 18 } : null;

/** The mine's SECOND tap: the green disc of the pair the staged charge raised. */
function tutorialMineConfirmTarget(): TutorialTargetMine | null {
  if (state.turn !== localSide || state.winner !== null) return null;
  if (!mineGhost) return null;
  const keys = capsuleStage();
  if (!keys) return null;
  return {
    cell: mineGhost,
    spot: { rect: keys.confirm, radius: Math.max(keys.confirm.width, keys.confirm.height) / 2 },
    door: keys.pair,
  };
}

/**
 * The lesson's two dashed lines, re-derived from the board every time it changes: the player's own
 * run to FINISH while the movement step is up, and the rival's threat run from the moment the wall
 * step opens until the charge is buried. Both are real routes through the standing walls, so the
 * wall the player commits bends the rival's line around itself in front of them.
 */
function paintTutorialRoutes() {
  const stage = tutorialStage();
  const routes: RouteCue[] = [];
  if (state.winner === null) {
    if (stage === 'move') {
      const ball = selected !== null ? ballById(state, selected) : firstBall(state, localSide);
      const path = ball ? finishRoute(state, ball.pos) : [];
      if (path.length > 1) routes.push({ tone: 'guide', path });
    }
    const threat = waitingForMineTrigger || stage === 'wall-stage' || stage === 'wall-confirm'
      || stage === 'mine-arm' || stage === 'mine-place' || stage === 'mine-confirm';
    if (threat) {
      const rival = tutorialRival();
      const path = rival ? finishRoute(state, rival.pos) : [];
      if (path.length > 1) routes.push({ tone: 'threat', path });
    }
  }
  tutorialRoutes = routes;
}

/** The lesson's one bot beat: each machine seat steps once, deterministically, and hands back. */
async function tutorialReply(): Promise<void> {
  for (let guard = 0; guard < 8; guard++) {
    if (!tutorialActive || state.winner !== null || state.turn === localSide) return;
    const seat = state.turn;
    await new Promise<void>((res) => window.setTimeout(res, 50));
    if (!tutorialActive || state.winner !== null || state.turn !== seat) return;
    /* A lesson replayed from the Pause sheet inside a governed debut still answers to the gates:
       a deterministic forward step may never become the move that wins the race or seals the
       player. `hold` is false here, because these two rows are the lesson's own choreography. */
    const auto = getAutoMove(state, seat);
    const guarded = onboardingActive()
      ? onboardingRivalAction(state, localSide, auto, false)
      : auto;
    if (onboardingActive() && guarded === null) { concedeOnboarding(); return; }
    if (!play(guarded ?? auto) && !play({ kind: 'pass' })) return;
  }
}

/**
 * Stage change from the lesson: clear any HOVER preview so the board stays bare behind the
 * spotlight, then let `ui()` re-derive the dots and the mine key's state. An ARMED ghost is not a
 * hover — it is the wall the player just staged, and the confirm stage is pointing at its ✓ — so
 * it survives the refresh. On the ARM stage the pod AND its inventory counter are ringed;
 * `refresh(null)` takes that ring down when the lesson closes or suspends.
 */
function syncTutorialUI(stage: TutorialStage | null = null) {
  mineBtn.classList.toggle('tut-arm-target', stage === 'mine-arm');
  if (!tutorialActive) {
    paintTutorialRoutes();
    invalidate();
    return;
  }
  if (ghost && !ghost.armed) setMode({ ...mode(), preview: null });
  ui();
}

/* ---------- the live-play intermission before the mine lesson ---------- */

/**
 * The wall stands. The lesson has stepped aside; from here until the mine is planted the board is
 * ordinary live play, with three rules of its own: the last mine charge is held for the lesson,
 * the rival's two turns are counted whether they gain rows or sidestep around the new wall, and a
 * race that settles here ends the lesson cleanly instead of stranding it.
 */
let waitingForMineTrigger = false;
let mineStrides = 0;
/** Completed rival turns since the handoff — a detour costs a turn without gaining a row. */
let mineRivalTurns = 0;
/** Best (lowest) row each rival ball has reached since the handoff. */
let mineGateRows: Map<number, number> | null = null;

/** The lesson's own charge: live play may spend every mine but the last one. */
const mineReserved = () => waitingForMineTrigger && minesLeft(state, localSide) <= 1;

/** The wall stands: close the overlay, release the gate, and let the match actually play. */
function beginMineIntermission() {
  tutorialActive = false;
  document.body.classList.remove('tutorial-live');
  mineGateRows = new Map(
    state.balls.filter((b) => b.team !== localSide).map((b) => [b.id, b.pos.r]),
  );
  mineStrides = 0;
  mineRivalTurns = 0;
  waitingForMineTrigger = true;
  ui();
  startClock();
  if (wantsOpponent()) void runOpponent();
}

/**
 * Real forward progress of the rival, counted once per new row. Every rival ball counts, so a
 * 2v2 board cannot stall the intermission by moving the piece the lesson did not name.
 */
function countMineStride() {
  if (!mineGateRows) return;
  for (const ball of state.balls) {
    if (ball.team === localSide) continue;
    const best = mineGateRows.get(ball.id);
    if (best === undefined) { mineGateRows.set(ball.id, ball.pos.r); continue; }
    if (ball.pos.r >= best) continue;
    mineStrides += best - ball.pos.r;
    mineGateRows.set(ball.id, ball.pos.r);
  }
}

/**
 * The intermission is over: the rival has taken its two turns — two forward rows, or two completed
 * moves when the new wall sent it sideways — and the local seat is up. Re-open on the mine half of
 * the lesson. A race that settled while the lesson was aside is COMPLETED, not cancelled: the flag
 * is written and the board goes to its own result, never back into a half-open lesson.
 */
function resumeMineLesson() {
  if (!waitingForMineTrigger || tutorialActive) return;
  /* the verdict comes first: the result sheet is exactly what would otherwise keep this gate
     from ever running again, leaving the lesson suspended for the rest of the match */
  if (state.winner !== null) {
    waitingForMineTrigger = false;
    mineGateRows = null;
    tutorial?.complete();
    return;
  }
  if (paused || overlayOpen) return;
  if (state.turn !== localSide) return;
  if (mineStrides < TUTORIAL_LIVE_STEPS && mineRivalTurns < TUTORIAL_LIVE_STEPS) return;
  waitingForMineTrigger = false;
  mineGateRows = null;
  /* no charge left to teach with (a board that started without a budget): the lesson is read */
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

function beginTutorial(auto = false) {
  if (!tutorial || tutorial.active || active || humansIn(room) > 1) return;
  /* The late guard: an AUTO lesson is refused the instant the save says it was completed or
     skipped. Manual replays (Pause / Settings) pass `auto === false` and always run. */
  if (auto && hasCompletedTutorial()) {
    tutorialStandalone = false;   // nothing replaces this race: it plays as an ordinary match
    return;
  }
  waitingForMineTrigger = false;
  mineStrides = 0;
  mineRivalTurns = 0;
  mineGateRows = null;
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

/**
 * The other half of the reserved invite: take the room code the language gate parked at boot,
 * forget it, and let the lobby join it. The short beat lets `quitToMenu()`'s Home render settle
 * first, so the drawer slides over a real shell and the route is already Home when it opens. A
 * shell that is still not ready is retried once through the same door.
 */
let pendingDuelJoinTimer = 0;
function joinPendingDuelRoom(): void {
  /* Keep the code in session memory through the Home route: `quitToMenu()` only re-arms the
     channel gate when nothing is pending, and it must see this invitation. The code is consumed
     inside the deferred join, once the route has settled and the gate decision is behind us. */
  if (!peekPendingDuelRoom() || pendingDuelJoinTimer) return;
  pendingDuelJoinTimer = window.setTimeout(() => {
    pendingDuelJoinTimer = 0;
    const code = takePendingDuelRoom();
    if (!code) return;
    const join = (attempt: number): void => {
      if (openInviteRoom(code)) return;
      if (attempt < 1) window.setTimeout(() => join(attempt + 1), 400);
    };
    join(0);
  }, 300);
}

/**
 * The lobby's on-demand door into the lesson: a fresh local duel with the overlay forced on, for
 * a player who has already read it as much as for a first-timer. `beginTutorial` refuses a live
 * seat or a room with people in it, so the setup is deliberately a plain 1v1 bot race — the exact
 * board the four steps were written against. It is a standalone lesson: `end` returns to Home.
 */
function startTutorial() {
  if (sheets.isOpen) sheets.close();
  tutorialRequested = true;
  /* `quiet` skips the empty VS face-off: a lesson opens on the board, not on a cinematic. */
  startGame({ difficulty: menuState.difficulty, sizes: [1, 1], quiet: true });
}

/* ---------- zero-friction invite boot ---------- */

/**
 * Was this very launch opened from a friend's room/duel invite?
 *
 * `inviteRoomCode()` / `inviteDuelCode()` already cover Telegram's `initDataUnsafe.start_param`
 * (`startapp=room_1909`, `duel_1909`) and the plain `?room=` / `?roomcode=` / `?duel=` query
 * fallbacks. The extra pass below widens that to a hash-delivered payload (`#room=1909`,
 * `#1909`, `#startapp=duel_1909`) without ever treating `squad_`, `ref_`, `team-` or a bare
 * referral as a duel. Read exactly once at boot, before the router or any sheet exists.
 *
 * Every constant is FUNCTION-LOCAL on purpose: this runs from a `const` initializer at the very
 * top of the module, so a module-level `const` here would still be in its temporal dead zone.
 */
function detectInviteDuelLaunch(): boolean {
  /* `room_1909`, `duel_1909`, `duel_relic_1909`, `#1909`, a bare `1909` — one invitation. */
  const invitePayload = /^(?:#?\s*)?(?:room|duel)[\s_-]*(?:relic[\s_-]*)?(\d{4})(?!\d)/i;
  const bareRoomPayload = /^(?:#?\s*)?(\d{4})\s*$/;
  const queryKeys = ['room', 'roomcode', 'duel', 'startapp', 'tgWebAppStartParam', 'start_param'];
  const isInvite = (raw: string | null | undefined): boolean => {
    const value = (raw ?? '').trim();
    return !!value && (invitePayload.test(value) || bareRoomPayload.test(value));
  };
  try {
    if (inviteRoomCode() || inviteDuelCode()) return true;
    if (isInvite(startParam())) return true;
    for (const part of [window.location.search, window.location.hash]) {
      const body = part.replace(/^[?#]/, '');
      if (!body) continue;
      if (isInvite(body)) return true;
      const query = new URLSearchParams(body);
      for (const key of queryKeys) {
        if (isInvite(query.get(key))) return true;
      }
    }
  } catch {
    /* a webview that refuses the URL still boots normally */
  }
  return false;
}

/**
 * The room code this launch was invited into, or ''. It accepts the same grammar as the guard
 * above but returns the FOUR DIGITS: `room_1909`, `duel_relic_1909`, `#room=1909`, a bare
 * `#1909`, `?room=1909` and Telegram's `startapp` all name one room. `squad_`, `ref_` and
 * `team-` payloads return '' — they belong to their own doors.
 */
function detectInviteRoomCode(): string {
  const roomPayload = /^(?:#?\s*)?room[\s_-]*(\d{4})(?!\d)/i;
  const duelPayload = /^(?:#?\s*)?duel[\s_-]*(?:relic[\s_-]*)?(\d{4})(?!\d)/i;
  const bareRoomPayload = /^(?:#?\s*)?(\d{4})\s*$/;
  const queryKeys = ['room', 'roomcode', 'duel', 'startapp', 'tgWebAppStartParam', 'start_param'];
  const codeOf = (raw: string | null | undefined): string => {
    const value = (raw ?? '').trim();
    if (!value) return '';
    const match = roomPayload.exec(value) ?? duelPayload.exec(value) ?? bareRoomPayload.exec(value);
    return match ? match[1] : '';
  };
  try {
    const direct = codeOf(inviteRoomCode()) || codeOf(inviteDuelCode()) || codeOf(startParam());
    if (direct) return direct;
    for (const part of [window.location.search, window.location.hash]) {
      const body = part.replace(/^[?#]/, '');
      if (!body) continue;
      const fromBody = codeOf(body);
      if (fromBody) return fromBody;
      const query = new URLSearchParams(body);
      for (const key of queryKeys) {
        const code = codeOf(query.get(key));
        if (code) return code;
      }
    }
  } catch {
    /* a webview that refuses the URL still boots normally */
  }
  return '';
}

/**
 * A shared link owns the first screen. A room, duel or squad invite — or any other start payload —
 * is a promise to take the reader somewhere specific, so first-open onboarding must never cover it.
 * The query-string fallbacks matter outside Telegram, where the payload arrives as `?room=1909`.
 */
function hasLaunchDeepLink(): boolean {
  try {
    if (startParam().trim()) return true;
    return !!(inviteRoomCode() || inviteDuelCode() || inviteSquadId());
  } catch {
    return false;   /* a webview that refuses the URL still boots normally */
  }
}

/**
 * ACTION-FIRST FIRST OPEN — the FTUE router.
 *
 * A brand-new profile does NOT see Home/Lobby first. Boot drops it straight onto a fresh 1v1 local
 * board with the interactive lesson already running; the main menu is discovered AFTER that first
 * playable experience. Three gates stand in front of that door, in this order:
 *
 *   1. A server/profile hydrate can restore match history onto an empty local cache. That player is
 *      RETURNING even without the lesson flag, so the flag is stamped before any decision is made.
 *   2. `isFirstTimePlayer()` — no completed lesson AND zero recorded matches. A returning player
 *      (`hasCompletedTutorial() === true`) always boots on #s-home and is never auto-routed again.
 *   3. A deep link keeps its own destination; onboarding never hijacks an invite. In particular a
 *      ROOM/DUEL invite is an explicit promise to land in that live seat: `INVITE_DUEL_LAUNCH`
 *      short-circuits the standalone lesson even for a profile that has never played a move.
 *
 * When the lesson is skipped (or Escape / Back is pressed) `end()` routes straight Home. When it
 * is finished, the completion flag is persisted at once and the player sprints to the FINISH line;
 * `showOverlay()` then lands them on #s-home once that first match is settled.
 */
function bootFirstRunTutorial(): void {
  reconcileTutorialFromHistory();
  if (!isFirstTimePlayer()) return;      // returning users ALWAYS boot on #s-home
  /* ZERO-FRICTION ENTRY: a friend is already waiting in the invited room. Never hijack this boot
     into src/tutorial.ts, and never start a replacement local race behind the invite. */
  if (INVITE_DUEL_LAUNCH || hasLaunchDeepLink()) return;
  firstRunBoot = true;
  /* A fresh local duel, not a room and not an online seat. `quiet` skips the VS cinematic: the
     board itself is the first thing a new player sees. `tutorialRequested` forces the standalone
     lesson, so `reveal()` calls `beginTutorial()` on the same turn the screen goes live. */
  tutorialRequested = true;
  startGame({ difficulty: menuState.difficulty, sizes: [1, 1], quiet: true });
  /* Cold boot: re-anchor and re-measure across animation frames (see settleColdBootBoard). */
  settleColdBootBoard();
}

/**
 * RETURN-TO-LOBBY TACTICAL TRAINING UPSELL.
 *
 * Offered on a genuine return to #s-home, and only to the player this flow was built for: the
 * lesson was bypassed (`!ftueDone`) and the first duel actually finished (its one-time bonus is
 * claimed). Once per session, after the Home transition has settled so the card never fights it.
 *
 * The primary CTA calls `startTutorial()` — the EXISTING, untouched on-demand door into
 * src/tutorial.ts. Nothing in this function edits, refactors or re-implements the lesson. The
 * secondary CTA stamps the completion flag so the offer is never repeated on a later launch.
 */
function maybeOfferTraining(): void {
  if (trainingPromptShown) return;
  if (hasCompletedTutorial()) return;
  if (!hasClaimedFirstDuelBonus()) return;
  /* A live invite that has not reached a verdict must stay completely frictionless. */
  if (INVITE_DUEL_LAUNCH && !inviteDuelSettled) return;
  if (overlayOpen || sheets.isOpen) return;
  trainingPromptShown = true;
  window.setTimeout(() => {
    if (router.current !== 'home' || overlayOpen || sheets.isOpen) {
      trainingPromptShown = false;   // not this time; a later Home return can still offer it
      return;
    }
    openTrainingUpsell({
      onStart: () => { startTutorial(); },
      onSkip: () => { completeTutorial(); },
    });
  }, 380);
}

/** Leaving the race, or starting another one, ends the lesson without marking it read. */
function cancelTutorial() {
  if (!tutorialActive && !waitingForMineTrigger) return;
  waitingForMineTrigger = false;
  mineStrides = 0;
  mineRivalTurns = 0;
  mineGateRows = null;
  tutorial?.cancel();
  tutorialActive = false;
  paintTutorialRoutes();
}

tutorial = createTutorial({
  goal: tutorialFinishTarget,
  select: tutorialSelectTarget,
  move: tutorialMoveTarget,
  wall: tutorialWallTarget,
  wallConfirm: tutorialWallConfirmTarget,
  mineArm: () => elementSpot(mineBtn, 8),
  minePlace: tutorialMineTarget,
  mineConfirm: tutorialMineConfirmTarget,
  finish: tutorialFinishTarget,
  reply: tutorialReply,
  handoff: beginMineIntermission,
  finishPulse: () => { renderer.pulseFinish(1200); invalidate(); },
  refresh: syncTutorialUI,
  end(result) {
    const bootLesson = firstRunBoot;
    firstRunBoot = false;
    tutorialActive = false;
    document.body.classList.remove('tutorial-live');
    mineGhost = null;            // before the mode: `armCapsules` must not re-stage a dead square
    setMode(BOARD_IDLE);
    autoPicked = null;
    if (result === 'cancelled') { tutorialStandalone = false; return; }
    /* Finishing the confirmed mine placement OR explicitly tapping Skip writes
       `tutorialCompleted = true` to the save immediately (completeTutorial flushes). This is the
       only place the flag is earned, so a returning profile can never be auto-routed into the
       lesson again — on this launch or on any later one. */
    completeTutorial();
    /* A lesson that replaced the launch is its own match. Skip (or Escape) goes straight Home;
       a booted first-timer who FINISHED keeps the live board for the fourth pillar — sprinting to
       the FINISH line — and `showOverlay()` returns them to #s-home once the race is settled.
       Pause → Replay is the exception: the real match under it gets the board straight back. */
    if (tutorialStandalone) {
      tutorialStandalone = false;
      /* A settled board keeps its own result: a race that finished during the live-play
         intermission is crowned and scored like any other, then Home follows the card. */
      if (result === 'finished' && (bootLesson || state.winner !== null)) {
        firstRunSprint = true;
        $<HTMLElement>('s-game').focus({ preventScroll: true });
        ui();
        startClock();
        if (wantsOpponent()) void runOpponent();
        return;
      }
      quitToMenu();
      /* Safety net: hand over any invite still parked in session memory so a lesson that ends can
         never strand a waiting friend. First-boot invitees normally join straight from the gate,
         so this is a no-op for them; it stays for any edge that runs a lesson with a code pending. */
      joinPendingDuelRoom();
      return;
    }
    $<HTMLElement>('s-game').focus({ preventScroll: true });
    ui();
    startClock();
    if (wantsOpponent()) void runOpponent();
  },
});

/* The rules sheet's Play tutorial key — reachable from Settings and from a live board's pause
   sheet. It never depends on the completion flag, so a player can replay at any time. */
$('help-tutorial').addEventListener('click', () => { impact('light'); startTutorial(); });

/* The visible replay door: Pause → Replay tutorial restarts this local board with the lesson,
   without needing the console. It is hidden for online seats and private rooms. */
$('pause-tutorial').addEventListener('click', () => {
  impact('light');
  /* A manual replay is an explicit request, NOT a return to first-run. Do NOT clear the saved
     completion flag: doing so would make a returning player auto-see the lesson on their next
     launch if they walked out of this replay mid-way. `beginTutorial()` runs with auto = false. */
  tutorialStandalone = false;   // this lesson runs inside the match already on the board
  sheets.close();
  resumeGame();
  restart();
  beginTutorial();
});

/* DEV TRIGGER — console: `window.resetTutorial()` clears the saved lesson flag (and the bare
   `tutorial_completed` key from the brief) and reloads into a clean first run. */
(window as Window & { resetTutorial?: () => void }).resetTutorial = () => {
  resetTutorialState();
  location.reload();
};

again.addEventListener('click', () => {
  /* the rematch key lands harder than a replay: it is the revenge trigger, not a menu hop */
  impact(state.winner === localSide ? 'medium' : 'heavy');
  clearResultMotion();
  /* Play again and Rematch both leave this result behind: the celebration (or the defeat sting)
     goes with it */
  stopVictoryFanfare();
  stopDefeat();
  /* a networked seat is not ours to restart in place: Play again queues the next race */
  if (active) {
    const mode: 'pvp' | 'arena' = active.mode === 'arena' ? 'arena' : 'pvp';
    active.close();
    active = null;
    queueMatch(mode);
    return;
  }
  restart();
});
shareBtn.addEventListener('click', () => {
  if (!resultView?.won) return;
  impact('medium');
  /* The board goes home first: the duel is armed in the lobby, and a drawer opened over a finished
     board would be closed again by the quit path it just took. A refusal is already voiced — the
     maintenance lock raises its own notice from inside the drawer. */
  quitToMenu();
  throwDuelChallenge();
});
toMenu.addEventListener('click', () => { impact('light'); clearResultMotion(); quitToMenu(); });
menuBtn.addEventListener('click', () => {
  if (tutorialActive || state.winner !== null) return;
  impact('light');
  openPause();
});
$('pause-resume').addEventListener('click', () => { impact('light'); sheets.close(); resumeGame(); });
$('pause-restart').addEventListener('click', () => { impact('light'); sheets.close(); resumeGame(); restart(); });
$('pause-quit').addEventListener('click', () => { impact('light'); paintQuit(); sheets.open(sheetQuit); });
$('quit-yes').addEventListener('click', () => { impact('light'); quitToMenu(); });

/* ---------- loop ---------- */

/** One re-fit of everything measured off the board box: canvas, confetti and staged chrome. */
function refitBoard() {
  /* `settle()` measures now and verifies on the next frame; a 0x0 container is never turned into
     geometry, so no pawn can be placed with a zero/NaN coordinate during the reveal. */
  renderer.settle();
  confetti.resize();
  dropBoardBox();         // the canvas box moved: re-prime it before anything maps board cells
  syncStage();
  syncPieces();           // the boxes the callouts avoid are viewport px: they move with the box
  /* resizing a canvas clears it. With the loop parked between transitions, a rotation or a
     WebView chrome collapse must explicitly ask for one repaint or the board stays blank. */
  invalidate();
}

/**
 * Match entry. The reveal clears `hidden` synchronously, but a container-query reflow, a font swap
 * or a WebView toolbar can change the box on the frame AFTER that — so measure now and once more
 * on the next animation frame, re-anchoring the pawn centres both times.
 */
let settleFrame = 0;
function settleBoard() {
  snapBalls();
  refitBoard();
  if (settleFrame) cancelAnimationFrame(settleFrame);
  settleFrame = requestAnimationFrame(() => {
    settleFrame = 0;
    if (!renderer.hasLayout()) {
      /* Still a 0x0 container: re-anchor and measure again rather than paint a stale fit. */
      snapBalls();
      refitBoard();
    } else {
      /* Cheap verification: `resize()` rebuilds only if the box actually changed. */
      renderer.resize();
      confetti.resize();
      dropBoardBox();
      syncStage();
      syncPieces();
    }
    syncLoop();       // a degenerate first pass must not leave the loop asleep
  });
}

/**
 * COLD BOOT only. On a first open the game screen has never been visible before: its container
 * queries and the WebView chrome settle over a few frames, so a single
 * synchronous measure can read a stale (or 0x0) box. Snap the pawns onto their spawn centres NOW,
 * re-measure on the next animation frame, and let `settleBoard()` run its own deferred
 * verification frame after that. Result: frame zero shows every pawn at 100% visibility on its
 * exact tile centre, on a canvas whose geometry is real.
 */
function settleColdBootBoard(): void {
  snapBalls();
  refitBoard();
  requestAnimationFrame(() => {
    snapBalls();
    settleBoard();          // re-measures + verifies on one more rAF
  });
}

/* ---------- loop: dirty / event-driven ----------
 * The old design ran requestAnimationFrame for the whole time the race screen was visible: a
 * static board still paid for a full canvas repaint (and a full-screen re-composite) sixty times
 * a second, which is exactly where a mid-range phone loses frames and input latency. Now a frame
 * is only requested when something CHANGED (ui / pointer / resize / a queued effect), and the
 * loop keeps ticking only while a transition is genuinely in flight. Once everything settles —
 * pawns on their tiles, blasts and ripples expired, confetti landed — `raf` goes to 0 and the
 * board costs nothing until the next tap.
 */

/**
 * Ask for one fresh frame. Cheap, idempotent, and deliberately the ONLY way to start the loop
 * from an event handler: it sets a flag and arms rAF only if the loop is asleep. The frame itself
 * decides whether to keep ticking, so no caller has to know how long an animation lasts.
 */
function invalidate() {
  frameNeeded = true;
  if (loopWanted && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
}

function frame(now: number) {
  /* Consume the dirty flag BEFORE painting: `onFinishSettled` and friends can invalidate from
     inside draw(), and that request must not be clobbered when this frame returns. */
  frameNeeded = false;
  try {
    /* The rAF timestamp can be a hair behind the `performance.now()` taken when the loop was
       armed; a negative delta produced a negative lerp factor before this clamp. */
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    const k = motionReduced() ? 1 : 1 - Math.exp(-dt * 14); // frame-rate independent lerp
    if (ballViews.length !== state.balls.length) syncBalls();
    /* one mode value per frame: the ring rides the dots, so a previewing board shows no ball as picked */
    const m = mode(), dots = moveDots(m);
    let settling = false;
    for (let i = 0; i < state.balls.length; i++) {
      const b = state.balls[i];
      let v = ballViews[i];
      if (!v) { syncBalls(); v = ballViews[i]; if (!v) continue; }
      const tx = b.pos.c + 0.5, ty = b.pos.r + 0.5;
      /* Per-frame fallback guard: a missing, NaN, Infinity or out-of-bounds visual coordinate is
         snapped straight to the logical tile centre. No pawn is ever dropped from the queue. */
      if (!v.pos || !Number.isFinite(v.pos.x) || !Number.isFinite(v.pos.y)
        || v.pos.x < -0.5 || v.pos.y < -0.5
        || v.pos.x > state.cols + 0.5 || v.pos.y > state.rows + 0.5) {
        v.pos = { x: tx, y: ty };
      }
      v.pos.x += (tx - v.pos.x) * k;
      v.pos.y += (ty - v.pos.y) * k;
      if (Math.abs(tx - v.pos.x) < 0.002) v.pos.x = tx;
      if (Math.abs(ty - v.pos.y) < 0.002) v.pos.y = ty;
      if (v.pos.x !== tx || v.pos.y !== ty) settling = true;
      v.sel = dots && v.id === m.selected;
    }
    view.state = state;
    view.balls = ballViews;
    view.hints = hints;
    view.routes = tutorialRoutes;
    view.ghost = ghost;
    view.mineHints = mineHints;
    view.mineGhost = mineGhost;
    view.capsule = capsule;
    view.last = marks;
    view.thinking = wantsOpponent() && !paused && !tutorialActive ? state.turn : null;
    /* Confetti reports whether any particle is still in the air. It is drawn above the result
       scrim, so it keeps ticking even when the board behind it is deliberately not repainted. */
    const confettiLive = confetti.tick(dt, now);
    /* The result capsule lays a full-screen scrim over the board: repainting the canvas behind it
       would re-composite a board nobody can see. Only confetti keeps the loop alive up there. */
    const fxBusy = overlayOpen ? false : renderer.draw(view, now, settling || confettiLive);
    animating = fxBusy || settling || confettiLive;
  } finally {
    /* A frame that throws must never strand `raf` at a stale id: re-arm from the flags, not from
       a guess, so `invalidate()` or `syncLoop()` can always restart a parked loop. */
    raf = loopWanted && (frameNeeded || animating) ? requestAnimationFrame(frame) : 0;
  }
}

/** The webview keeps a hidden Mini App running, and the pause sheet is a real stop: no frames
 *  are burned unless the board is on screen and unpaused. The clock follows the same rule —
 *  leaving the board stops it, coming back hands the seat a full allowance again. */
function syncLoop() {
  const onBoard = !document.hidden && router.current === 'game';
  /* The race stage is the one screen that repaints a canvas. `game-live` parks the drifting mesh
     and every off-screen sheet's loop underneath it, so the compositor's only moving layer is the
     board itself — and now even that layer only moves during a transition. */
  document.documentElement.classList.toggle('game-live', onBoard);
  const want = onBoard && !paused;
  loopWanted = want;
  if (want) {
    /* Re-entering the board always owes one frame: a resize may have cleared the canvas while
       the loop was parked, and a hidden Mini App can come back to a changed roster. */
    frameNeeded = true;
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  } else if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
    animating = false;
  }
  if (!want) stopClock();
  else if (turnTimerId === null) resumeClock();
}

/* A dedicated observer on the board container owns every re-fit: the reveal, a WebView chrome
   collapse, a rotation and a container-query reflow all change this box. A wrap that was already
   sized can stay silent, which is why `settleBoard()` also verifies after a deferred frame. */
const boardObserver = new ResizeObserver(() => refitBoard());
boardObserver.observe(wrap);
window.addEventListener('resize', () => refitBoard());
refitBoard();

document.addEventListener('visibilitychange', () => { dropBoardBox(); syncLoop(); });

/* ---------- boot ---------- */

mountCoins();                              // every [data-coin] slot gets the shared gold coin
/* the confrontation card is one panel shared by the ladder dossier and the Hall of Owners */
initSeize({ sheets });
menu = createMenu({ router, sheets, sheet: sheetById, start: startGame, onBack });
const shop = createShop({ sheets, sheet: sheetById });
home = createHome({
  router, sheets, start: startGame, queue: (mode) => queueMatch(mode),
});
compete = createCompete({
  router, sheets, sheet: sheetById,
});
/* the Arena tab is a showcase, not a lobby: the road takes no match action */
arenaRoad = createArenaRoad();
createNotifications({ sheets });

/* ---- the in-game relic-duel channel ----
   One ambient socket listens for challenges; an accepted challenge becomes a live 1v1 on that same
   socket and routes straight to the board. The mailbox covers a challenge filed while away. */
startRelicChannel({
  onIncoming: (challenge) => {
    showRelicChallenge(challenge);
  },
  onStart: (session) => { startRelicDuel(session); },
  onDeclined: () => {
    impact('light');
    showToast(t('relicDuelDeclined'), 'warning', 3000);
  },
  onExpired: () => {
    impact('light');
    showToast(t('relicDuelExpired'), 'warning', 3000);
  },
  onClosed: (challengeId) => { dismissRelicChallenge(challengeId); },
  onRefused: (reason) => {
    impact('light');
    const line =
      reason === 'SHIELDED' ? t('relicDuelShielded')
        : reason === 'TARGET_BUSY' ? t('relicDuelBusy')
          : reason === 'BUSY' ? t('relicDuelSelfBusy')
            : reason === 'SELF' ? t('relicDuelNoTarget')
              : t('relicDuelOffline');
    showToast(line, 'error', 3000);
  },
});
void syncRelicMailbox();

/** A challenge accepted by the holder: leave whatever sheet/search was up and take the board. */
function startRelicDuel(session: OnlineSession): void {
  clearRelicChallenges();
  compete?.clearRivalContext();
  resetSeizeContext();
  matchmaking.abandon();
  sheets.close();
  impact('heavy');
  notify('success');
  startGame({
    difficulty: menuState.difficulty,
    sizes: [session.sizes[0], session.sizes[1]],
    online: session,
    quiet: true,
  });
}

/** The next-boot half: a challenge filed while this seat had no session socket. */
async function syncRelicMailbox(): Promise<void> {
  const rows = await fetchRelicMailbox();
  if (!rows.length) return;
  const now = Date.now();
  for (const row of rows) {
    if (row.status === 'pending' && row.expiresAt > now) {
      showRelicChallenge(row);
      continue;
    }
    /* An unexpired challenge is answered live; anything else is history worth one inbox row. */
    if (row.status === 'pending' || row.status === 'expired') {
      noteRelicMissed(row);
    }
  }
}

/* ---- Admin Command Center: the Home FAB and the live-ops stage (src/admin.ts) ---- */
admin = createAdmin({
  note: showNote,
  /* the stage is not a router screen, so it shows the BackButton itself while it is up */
  onToggle: (open) => setBackButton(open || router.current !== 'home'),
});
admin.mount();
startArenaSync();
onAward((award) => {
  impact('medium');
  notify('success');
  const label = award.badge.toLowerCase().startsWith('season ') ? award.badge : `Season ${award.seasonNo} ${award.badge}`;
  showNote(`${label} — +${award.tiq} TIQ.`, false, 3600);
});
document.addEventListener('visibilitychange', () => {
  /* A host who stepped into a Telegram chat to send the invite comes back to the room they never
     left: the webview may have killed the socket while it was away, so the membership reconnects
     the moment the app is on screen again. */
  if (!document.hidden) resumeRoom();
});
/* ---- the local party: 2, 3 or 4 seats on the board the rules pick for them ----
   The mode drawer's Practice card carries one segmented control, and it is the whole of the
   three- and four-player entry: pick 3 or 4 and Start runs a race of that many one-ball seats,
   which `getBoardDimensions` lays out on the wide, long 10x14 board with the wall budget that goes
   with it. Two keeps the classic duel shapes the drawer already persists. It is a local-only
   setting — quick match and the private room hand the board to whoever is at the other end of the
   socket — so it is stored on its own key rather than in the menu's two-seat `sizes` tuple. */
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
  if (partySeats > 2) return t('startPracticeN').replace('{n}', String(partySeats));
  return t('startPractice');
}

/** Paint the Players control, and make the Start label name the race it will actually run. */
function paintParty(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#sheet-game-modes [data-seats]')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.seats) === partySeats));
  }
  /* Publish the seat count to the live reward preview. The drawer's coins/XP and the settlement
     read the same number, so a 2P -> 4P tap changes BOTH figures on the very same beat. */
  setRewardSeats(partySeats);
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

/**
 * The one launch the drawer's Start runs: the selection decides the door. Quick match is
 * online, so it queues on the searching stage first; practice and a private room have nobody
 * to wait for, so they open their roster and start right away — on the seat count the Practice
 * card is showing. Practice plays the level the drawer shows on every seat; a private room
 * ladders its machine seats instead, which is the dynamic difficulty a room setting buys.
 */
function launchSelectedMode(): void {
  /* Onboarding is NOT decided here. `startGame` is the single launch door, and it gates
     `beginTutorial()` on `hasCompletedTutorial()` + `autoTutorialForLaunch()`. A returning
     profile goes straight into the mode it picked; only a brand-new save is auto-routed. */
  const sel = getGameMode();
  /* The online queue is parked behind the gold lock: never drop the player into a search with no
     server behind it. Say what the card says, and open the drawer that still holds an open door. */
  if (sel.id === 'duel_1v1' || sel.id === 'party_2v2') {
    impact('light');
    notify('warning');
    showNote('Online servers undergoing tuning · Live soon', false, 2600);
    const drawer = sheetById('sheet-game-modes');
    if (drawer) sheets.open(drawer);
    return;
  }
  const botTier: BotTier = sel.id === 'room' ? 'mixed' : menuState.difficulty;
  const lobby = openLocalRoom(botTier);
  showNote(lobbyLine(lobby, Date.now()), false, 2200, true);
  startGame({ difficulty: menuState.difficulty, sizes: sizesOf(lobby), room: lobby,
    rewardMode: rewardModeFor(sel.id),
    ...(sel.id === 'bot' ? { mode: 'vs_bot' as const } : {}) });
}

/* The drawer repaints its own Start label inside its own `onGameModeChange` handler, and
   subscribers fire in registration order — so this one is registered *after* `initGameModes`
   below, never before it. Registered first it would name the seat count and then be silently
   overwritten by `paintSheetState`, which is exactly the "Start practice match" bug. */
initGameModes(sheets, {
  /* the drawer already persisted sizes + difficulty, so the race it names is the race it runs */
  onStart: launchSelectedMode,
  /* The friends lobby's Start. A lobby with a socket behind it has already asked the worker to
     launch, and the race arrives on `onRoomRace`; one without a socket plays its own roster here. */
  onRoomStart: (lobby: Lobby) => {
    takeAutoLaunch();   // a roster with no socket never counted down: drop any stale flag
    const room = roomFromRoster(lobby.code, lobby.seats);
    showNote(lobbyLine(room, Date.now()), false, 2200, true);
    startGame({ difficulty: menuState.difficulty, sizes: sizesOf(room), room, rewardMode: 'friendly' });
  },
  onRoomRace: (race: LobbyRace) => {
    const room = roomFromRoster(race.code, race.seats);
    /* Both seats watched the same roster fill and the same countdown stage the launch: the board
       is already the ceremony, so neither host nor guest pays for a second face-off. Dropping the
       stale flag keeps the next non-room launch honest. */
    takeAutoLaunch();
    startGame({ difficulty: menuState.difficulty, sizes: race.sizes, online: race, room,
      rewardMode: 'friendly', quiet: true });
  },
  /* The armed duel reads the same roster the drawer paints, for one line: the wait ends the moment
     the challenged seat is held by a person. */
  onLobbyState: noteDuelLobby,
  /* A guest's arrival may bring the drawer up over Home — never over a board being played. */
  canPopLobby: () => router.current !== 'game',
  /* JOIN NOW on the in-match arrival banner leaves the board through this same quit path. */
  onAbandonMatch: () => quitToMenu(),
  /* A server-side maintenance refusal still raises the one-key notice. */
  onMaintenance: () => showNote(t('maintenanceBody'), false, 3200),
});
onGameModeChange(paintParty);
onLang(paintParty);
/* the result is a live surface too: a language flip repaints its copy, tags and aria labels.
   The race's own name rides along — it is translated copy on the pause header and this caption. */
onLang(() => { paintRaceTags(); if (overlayOpen && resultView) paintResultCopy(); });
onReferralQuestChange(() => { if (overlayOpen && resultView) paintRewardButtons(); });
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
     viewport px, plus its radius, tile size and colour family — so the bubble can park in the
     quadrant the board has room for, clear every cardinal move dot, aim its tail at this ball alone,
     and glow in the same neon. */
  pawn: (seat) => {
    const v = ballViews.find((b) => b.team === seat);
    if (!v) return null;
    const L = renderer.layout();
    const box = canvas.getBoundingClientRect();
    return {
      x: box.left + L.ox + v.pos.x * L.cell,
      y: box.top + L.oy + v.pos.y * L.cell,
      radius: pawnRadius(L.cell),
      cell: L.cell,
      color: seatTint(seat),
    };
  },
  busy: () => mineArmed,
  live: () => router.current === 'game' && !paused && !overlayOpen && state.winner === null,
});
/* Post-match reactions: the tray reads the live session when there is one, and the machine answers
   when there is not. The wire is resolved at send time, never captured, because `active` changes
   with every race. */
const banter = createBanter({
  wire: () => {
    const session = active;
    if (!session) return null;
    /* A room whose other seats are all the machine has no socket to answer on the far side:
       treat it as a bot race, so the same canned reply wakes after 1.2s. */
    if ('seats' in session && !session.seats.some((s) => s.side !== localSide && !s.bot)) return null;
    return (line: PostChatLine) => session.sendPostMatchChat(line);
  },
  /* Bubbles land on the row the speaker owns. Looked up per message: a language flip rebuilds
     the ladder, so a cached node would go stale behind it. */
  anchor: (side) => {
    const row = resultRoster.querySelector<HTMLElement>(`.result-row[data-seat="${side}"]`);
    const node = row?.querySelector<HTMLElement>('.result-say');
    const text = node?.querySelector<HTMLElement>('.result-say-t');
    const badge = node?.querySelector<HTMLElement>('.result-say-vip') ?? null;
    return node && text ? { node, text, badge } : null;
  },
});
router.start('home');
setBackButton(false);
menu.afterStart();
/* Home is the ROOT of the screen stack, so `quitToMenu()` can always pop back to #s-home after
   the first playable experience. The boot then settles the locale before anything else mounts. */

/**
 * Resume the boot once the locale is settled — either because the player already chose it on a
 * previous launch (returning) or because the first-boot gate just resolved. An invite owns the
 * first screen: a first-boot invitee is handed straight to the friend's room (the in-match
 * micro-coach teaches the board in their language); everyone else falls through to the action-first
 * lesson / Home exactly as before. The duel veil and room door below answer returning invitees.
 */
function resumeBootAfterLanguage(): void {
  if (INVITE_FTUE) {
    /* The gate parked the code in session memory; consume it and open the lobby over Home. The
       friend's countdown fires the moment both seats are human, so the player lands on the match
       board — never dumped on #s-home wondering where the duel went. */
    joinPendingDuelRoom();
    return;
  }
  bootFirstRunTutorial();
}

if (LANG_GATE_NEEDED) {
  /* FIRST BOOT: the luxury obsidian-and-gold language picker is the very first screen — before any
     tutorial, duel veil or room door mounts. The invite (if any) is already parked, so the gate can
     never swallow it. The chosen locale is applied + locked synchronously inside the pick, then the
     boot resumes in that exact language. */
  requestAnimationFrame(() => {
    menu.openLanguagePicker(() => resumeBootAfterLanguage(), INVITE_ROOM_CODE ? 'invite' : 'welcome');
  });
} else {
  resumeBootAfterLanguage();
}
/* A CloudStorage hydrate can resolve AFTER boot and reveal that this is really a returning player
   (match history, no lesson flag). `hydrate()` stamps the flag; this watcher ends a first-open
   lesson already in flight and puts them on Home. It NEVER dismisses the language gate: choosing a
   locale is a separate, permanent decision every new player makes once, returning or not. */
onChange(() => {
  if (!hasCompletedTutorial()) return;
  if (!firstRunBoot) return;
  firstRunBoot = false;
  tutorialStandalone = false;
  tutorial?.cancel();
  quitToMenu();
});

/* equipping repaints the board, and the chip swatch that stands for your ball; choosing a piece
   colour repaints the whole perspective (both sides, the finish wash and every chip) */
const paintTheme = () => {
  renderer.setTheme(liveTheme());
  renderer.setPerspective(currentPerspective());
  paintRoster();
  paintSeatTints();
};
onChange(paintTheme);
/* a settled race writes the save, and the save is what your XP pill reads: repaint it the moment
   the wallet or the tally moves, so the chip is never one race behind. */
onChange(paintSeatIdentity);
/* A purchase can land while the result card (or a board) is already up: the aura, the standings
   crown and the fourth recovery are all live surfaces, so they repaint on the same beat. */
onVipChange(() => {
  paintVipSeats();
  if (resultView) {
    paintResultRoster();
    paintRewardButtons();
  }
});
paintTheme();
paintSeatIdentity();

/* ---------- the finish switch: Dark Sapphire <-> Pearl Chessboard ---------- */

const themeToggle = $<HTMLButtonElement>('theme-toggle');

function paintThemeToggle() {
  const light = appearance() === 'light';
  themeToggle.setAttribute('aria-checked', String(light));
  document.documentElement.classList.toggle('light-game', light && router.current === 'game');
}

onAppearance(() => {
  paintTheme();
  paintThemeToggle();
});
paintThemeToggle();

themeToggle.addEventListener('click', () => {
  impact('light');
  const commit = () => { toggleAppearance(); };
  /* a document cross-fade takes the whole stage from one finish to the other; older webviews
     simply commit the swap, and the toggle's own thumb still glides on its CSS clock. */
  const page = document as Document & {
    startViewTransition?: (cb: () => void | Promise<void>) => { finished: Promise<void> };
  };
  if (!page.startViewTransition || motionReduced()) { commit(); return; }
  page.startViewTransition(commit);
});

/* ---------- the duel door: `?startapp=duel_XXXX` is answered before it is entered ---------- */

/**
 * A challenge link is not an invite to a room, it is a dare — so the rival meets it on a veil of its
 * own instead of a lobby they have to work out. Accepting *is* the join: no seat is taken while the
 * player has not agreed to play, which also holds the challenger's countdown until they do.
 *
 * Opened on the first frame so the veil lands over a laid-out shell with no boot screen in front of
 * it. The payload grammar (`duel_`) never collides with the room door's (`room_`), so a plain room
 * invite still goes straight in with no tap at all. A FIRST-BOOT invitee (`INVITE_FTUE`) skips the
 * veil entirely: the language gate joins them straight to the room the moment they pick a locale.
 */
requestAnimationFrame(() => { if (!INVITE_FTUE) openDuelDoor(); });

/* ---------- the invite door: `?startapp=room_XXXX` lands in that room, no taps ---------- */

/**
 * A shared room link is a promise: the friend who taps it is already seated. The code rides
 * `initDataUnsafe.start_param` inside Telegram and the query string outside it (`telegram.ts`),
 * and the drawer is opened on the live lobby before the socket even answers — so the screen a
 * guest sees is the room, never the launcher they would have had to navigate.
 *
 * The door opens exactly once per launch. The retry below exists only for a shell that has not
 * been built yet (the drawer or its host is missing, which is the one false `openInviteRoom`
 * reports before it attempts anything); it is never a second handshake on a room already open.
 *
 * Opened on the first frame: the drawer needs the shell laid out before it can slide, and with no
 * boot veil there is nothing to wait for. A refusal — full, expired, gone — arrives as a toast from
 * `openInviteRoom` with the player left at home.
 */
const invitedRoom = inviteRoomCode();
/* A first-boot invitee is held at the language gate: the room is joined the instant the gate
   resolves (`resumeBootAfterLanguage` → `joinPendingDuelRoom`), never behind the gate. */
if (invitedRoom && !INVITE_FTUE) {
  let inviteDoorDone = false;
  const openInvite = (attempt = 0): void => {
    if (inviteDoorDone) return;
    if (openInviteRoom(invitedRoom)) {
      inviteDoorDone = true;
      return;
    }
    if (attempt < 12) window.setTimeout(() => openInvite(attempt + 1), 250);
  };
  requestAnimationFrame(() => openInvite());
}

/* ---------- the squad door: `?startapp=squad_<id>` opens that squad's join sheet ---------- */

/**
 * A squad invite is a *prompt*, never an enrolment: the player who taps it lands on the squad's
 * card with its real roster and a Join key, and only that key puts them on the roster. The door
 * is handed to `menu.ts`, which owns the sheet and the roster it paints.
 *
 * The event fires once per launch, on the first frame (the sheet slides over a laid-out shell, not
 * over a skeleton), and only when the payload is exactly `squad_<id>` — a room or referral payload
 * never opens this door.
 */
const invitedSquad = inviteSquadId();
if (invitedSquad) {
  requestAnimationFrame(() => {
    try {
      window.dispatchEvent(new CustomEvent('detour:squad-invite', { detail: { id: invitedSquad } }));
    } catch { /* a shell without CustomEvent: the player still has the squad list */ }
  });
}
