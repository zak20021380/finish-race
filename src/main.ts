import './style.css';
import './result.css';
import {
  CONFIG, MAX_TEAMS, REPEAT_LIMIT, apply, ballById, distField, firstBall, getAutoMove,
  isEliminated, isLeft, markLeft, mineCells, minesLeft, newGame, pathOn, reachableBall, rivalMineAt,
  sideOf, steps as teamSteps,
  view as fogOfWar, wallBudget, wallConflict, wallOk, wallsRemaining, rotateWall,
  type Action, type Ball, type Cell, type Checkmate, type GameState, type Mine, type Player,
  type Pos, type Wall, type WallSpec,
} from './rules';
import { botAction, botThinkMs, type Difficulty } from './bot';
import {
  capsuleLayout, capsuleSpots, createRenderer, dragWallSlot, hitTest, pawnRadius, wallCentre,
  type BallView, type BlastBeat, type CapsuleAction, type Ghost, type Hit,
  type Mark, type Perspective, type Vec, type View,
} from './render';
import { createConfetti } from './confetti';
/* SIMULATED LIVE CROWD: purely cosmetic in-match atmosphere. It reads the board to decide which
   side is ahead, but never touches the rules, the wallet or the wire. */
import { closeCrowd, initMatchCrowd, onCrowdEvent } from './crowd';
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
import { showMarkupToast, showRoyalToast, showToast } from './toast';
import { getMySquad, WAR_LOSS, WAR_WIN } from './squads';
import { awardWarPoints } from './squadRegister';
import { channelWarHandleOf } from '../shared/config';
import { CHANNEL_WARS_ENABLED, applyChannelWarsFlag } from './channelWar';
import { workerUrl } from './adminApi';
import { createModal, type ModalHandle } from './modal';
import telegramStarsUrl from './assets/images/telegram_stars.png';
import { mountCoins } from './coin';
import {
  appearance, lang, langDef, menuState, motionReduced, onAppearance, onLang, setSkip2xConfirm,
  skip2xConfirm, t, tIn, toggleAppearance, type LangCode,
} from './settings';
import {
  audio, holdAudio, playBoom, playVictoryFanfare, releaseAudio, stopVictoryFanfare,
} from './audio';
import { playDefeat, stopDefeat } from './sound';
/* The ambient bed's own controller. It registers its listeners and builds its element only when
   `initMusic()` runs below — after the first screen has mounted — so nothing here touches boot.
   `setMusicInMatch()` is the STRICT gate: the bed is a match voice, so it is opened when the board
   becomes playable and closed on every exit — it is never heard over Home, the Shop, VIP, Ranks,
   Squads, Friends or the lobby. `setMusicMatchOver()` is the settlement's own door: the result
   capsule ducks the bed so the victory/defeat fanfare is heard alone. */
import { initMusic, setMusicInMatch, setMusicMatchOver } from './music';
import {
  getRemainingTiqRecoveries, hasClaimedInMatch, markClaimedInMatch, playRewardedAd, recordTiqRecovery,
  resetMatchClaims, tiqRecoveryLimit,
} from './ads';
import {
  closeVipSheet, initVipStore, isPremiumUser, onVipChange,
} from './premium';
import {
  accountChanged, applyTiqDelta, claimFirstDuelBonus, completeTutorial, earnCoins, earnTiq, hasChosenLanguage,
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
  createTutorial, shouldAutoStartTutorial, tutorialDir, tutorialLang, tutorialSpotHas,
  type Tutorial, type TutorialAction, type TutorialRect, type TutorialSpot, type TutorialStage,
  type TutorialTargetMine, type TutorialTargetMove, type TutorialTargetWall,
} from './tutorial';
import { PEARL_BOARD, perspectiveRamps, withTeamRampContext, type Theme } from './themes';
import { mineStage, setCapsuleStage, setMineStage, STAGE_CLEAR } from './staging';
import { setPieceBoxes, type PieceBox } from './boardpieces';
import {
  detonation, impact, initTelegram, inviteChannelWarHandle, inviteDuelCode, inviteRoomCode, inviteSquadId, notify,
  onBackPress, roomShareUrl, shatterImpact, startParam, tgInitData, tgUser,
} from './telegram';
import { applyFlagSupport } from './countries';
import {
  autoTutorialForLaunch, createRoomCode, getGameMode, gmBack, initGameModes, notifyMatchBusy,
  onGameModeChange, openInviteRoom, rewardModeFor, resumeRoom, setGameMode,
  setRewardSeats, takeAutoLaunch,
} from './gamemodes';
import { dismissDuelVeil, noteDuelLobby, openDuelDoor, throwDuelChallenge } from './duelInvite';
import { acceptFriendInvite, initFriends, openFriendsRivals, recordFriendsMatch, type FriendOpponent } from './friends';
import { initSeize, resetSeizeContext } from './seize';
import type { Lobby, LobbyRace, RematchState } from './lobby';
import {
  createMatchmaking, myTiq, onlineRace, onlineSearch, setQueueMode, type OnlineSession, type RaceEnd,
} from './matchmaking';
import { runtime, tiqFrom } from './runtime';
import { arena, arenaLocked, onAward, startArenaSync } from './arenaState';
import {
  MIN_SEATS, ROOM_WAIT_MS, createRoom, defaultTeam, difficultyFor, hasHumanRival, isAutomated, isHuman,
  lobbyLine, rewardEligible, seatBadge, seatName, sizesOf, startEarly, type BotTier, type Room,
} from './room';
import { channelGateBlocks, initJoinGate, raiseChannelGate } from './joinGate';
import type { VsRival, VsStakes } from './vsclash';
import { BADGE_REQUIREMENTS } from './badges';
import { beginMatch, finishMatch, initTelemetry, setIdle } from './telemetry';
import type { MatchMode } from '../shared/telemetry';
import {
  createReferralQuestMatch, isReferralQuestActive, onReferralQuestChange, referralQuestUser,
  verifyReferralQuestMatch,
} from './referral';
import type { ReferralQuestMatchSetup } from './referral';
import { REFERRAL_CONFIG } from '../shared/referralConfig';

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

/* ---------- the post-paint scheduler ----------
 * A cold start has exactly one job: put Home on screen. A mobile webview gives it four to six
 * connections, and every background socket, beacon and store hydrate started during module
 * evaluation competes for those connections with the bundle's own chunks — which is the whole
 * difference between a first frame and a stalled one. So all of it is handed to `afterPaint`:
 * two frames (the first commits Home, the second confirms the paint), then the browser's own idle
 * callback, with a timeout as the guarantee for a client that never goes idle.
 */
function afterPaint(fn: () => void, timeout = 600): void {
  const run = (): void => {
    try { fn(); } catch { /* background I/O never takes the boot down */ }
  };
  const idle = (window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (typeof idle === 'function') idle(run, { timeout });
    else window.setTimeout(run, timeout);
  }));
}

/**
 * Finish the frame that is already on screen before any synchronous work begins. rAF's callback
 * runs *before* the paint, so the trailing 16ms macrotask is the first point at which the human's
 * move is actually composited — the bot then reasons in the gap after it instead of stealing the
 * tail of the slide. A hidden WebView parks rAF entirely, so it resolves at once there, and a
 * guard timeout keeps a stalled rAF from ever stranding a turn.
 */
function yieldToPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (document.hidden) { resolve(); return; }
    let done = false;
    const go = (): void => { if (done) return; done = true; resolve(); };
    requestAnimationFrame(() => window.setTimeout(go, 16));
    window.setTimeout(go, 200);
  });
}

/* The Command Center's chunk, fetched on first use. Declared here rather than beside its mount
   below for the same reason the render-loop state is: a settled race reaches `recordRace` through
   `showOverlay`, and a `const` read from its temporal dead zone would abort the result screen. */
let adminModule: Promise<typeof import('./admin')> | null = null;
const loadAdmin = (): Promise<typeof import('./admin')> => (adminModule ??= import('./admin'));

applyFlagSupport();
/* SHARED-DEVICE SWITCH GUARD. Every save and cache key was bound to the account Telegram announced
   at module init. If the SDK later names a different account — a shared phone switched users while
   this webview stayed alive — reload so the whole scope re-binds instead of letting the newcomer
   run on the old account's in-memory profile. A transient missing id is not a change. */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && accountChanged()) window.location.reload();
});
/* Telemetry's first beacon and the VIP store's first read are both network work: they follow the
   first frame rather than hold it. The VIP store binds after the SDK either way, so
   `initDataUnsafe` is readable on its first paint. */
afterPaint(() => {
  initTelemetry();
  initVipStore();
  /* The face-off cinematic is a chunk of its own; warm it here so the first race's veil is already
     in memory by the time the player presses Start, without its parse landing on the first frame. */
  void import('./vsclash').catch(() => { /* a missing chunk leaves the reveal path untouched */ });
});

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
   that cannot be answered fails open. It can never stand in front of a first race either — the
   verdict is `0 matches` for a new profile, so only a returning, unverified player meets the wall
   at boot. On an invited launch it is deliberately NOT started: a join sheet in front of a waiting
   friend is the whole drop-off this flow exists to remove. `initJoinGate()` is called from the
   router the moment the player exits back to #s-home instead. */
if (!inviteGateDeferred) afterPaint(initJoinGate);

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
const resultTiqSign = $<HTMLElement>('result-tiq-sign');
const resultTiqLabel = $<HTMLElement>('result-tiq-label');
const resultLeft = $<HTMLElement>('result-left');
const resultLeftTxt = $<HTMLElement>('result-left-txt');
const resultXpChip = $<HTMLElement>('result-xp-chip');
const resultXpN = $<HTMLElement>('result-xp-n');
const resultCoinChip = $<HTMLElement>('result-coin-chip');
const resultCoinsN = $<HTMLElement>('result-coins-n');
/* the two rewarded-video keys: one inside each reward card */
const recoverBtn = $<HTMLButtonElement>('btn-recover-tiq');
const recoverLabel = $<HTMLElement>('recover-tiq-label');
const recoverQuota = $<HTMLElement>('recover-tiq-quota');
const recoverSpin = $<HTMLElement>('recover-tiq-spin');
const doubleBtn = $<HTMLButtonElement>('btn-double-coins');
const doubleLabel = $<HTMLElement>('double-coins-label');
const doubleSub = $<HTMLElement>('double-coins-sub');
const doubleIco = document.getElementById('double-coins-ico') as SVGUseElement | null;
const doubleSpin = $<HTMLElement>('double-coins-spin');
/* Obsidian VIP: the +50% pill the settlement already paid, shown beside the coin/XP bank */
const resultVipBoost = $<HTMLElement>('result-vip-boost');
const resultVipBoostT = $<HTMLElement>('result-vip-boost-t');
const adToast = $<HTMLParagraphElement>('ad-toast');
/* the pre-watch consent sheet: it must be answered before the SDK may open a fullscreen video */
const adConfirm = $<HTMLDivElement>('ad-confirm');
const adConfirmTitle = $<HTMLElement>('ad-confirm-title');
const adConfirmDesc = $<HTMLElement>('ad-confirm-desc');
const adConfirmIco = document.getElementById('ad-confirm-ico') as SVGUseElement | null;
const adConfirmWatch = $<HTMLButtonElement>('ad-confirm-watch');
const adConfirmSheet = document.getElementById('ad-confirm-sheet');
const adSkipOpt = document.getElementById('ad-skip-opt');
const adSkipCheck = $<HTMLInputElement>('ad-skip-check');
const adSkipLabel = $<HTMLElement>('ad-skip-label');
const againLabel = $<HTMLSpanElement>('again-label');
const againIco = document.getElementById('again-ico') as SVGUseElement | null;
const shareBtn = $<HTMLButtonElement>('share');
const shareLabel = $<HTMLSpanElement>('share-label');
const toMenuLabel = $<HTMLSpanElement>('menu-label');
/* the friends room's rematch consensus: one line of live progress and the decline key */
const rematchBar = $<HTMLElement>('result-rematch');
const rematchBarText = $<HTMLElement>('result-rematch-t');
const rematchDeclineBtn = $<HTMLButtonElement>('result-rematch-decline');
/* the incoming invitation owns its own floating card, so no answer hides in a progress pill */
const rematchChallenge = $<HTMLElement>('rematch-challenge-modal');
const rematchChallengeTitle = $<HTMLElement>('rematch-challenge-title');
const rematchChallengeSub = $<HTMLElement>('rematch-challenge-sub');
const rematchChallengeAccept = $<HTMLButtonElement>('rematch-challenge-accept');
const rematchChallengeDecline = $<HTMLButtonElement>('rematch-challenge-decline');
const rematchChallengePhoto = $<HTMLImageElement>('rematch-challenge-photo');
const rematchChallengeInitial = $<HTMLElement>('rematch-challenge-initial');
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
/**
 * The seat whose card wears the thinking dots right now. The dots are ONE element — the rival's own
 * markup, carried from card to card — so the card that wears them is always the seat the board's
 * pips are floating over.
 */
let dotsSeat: Player | null = null;
/**
 * Park the thinking dots on a seat's card. One element, one home: the dots move to whoever is
 * thinking and to nobody else, so a three- or four-seat race names the person who is actually up
 * instead of lighting the same card for every rival.
 */
function homeThinkingDots(seat: Player | null): void {
  dotsSeat = seat;
  if (seat === null) return;
  const who = chips[seat]?.querySelector<HTMLElement>('.who-line');
  if (who && dots.parentElement !== who) who.appendChild(dots);
}
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

/* A seat struck from the race keeps its card, but the card stops being a player: the ammo readout
   is replaced by a muted LEFT badge and the whole strip goes ash. One badge per seat, minted on
   first use and then only toggled, so a repaint costs a comparison. */
const leftBadges: (HTMLElement | null)[] = [null, null, null, null];
function paintSeatLeft(p: Player, on: boolean): void {
  const host = document.getElementById(`res-${p}`);
  if (!host) return;
  let badge = leftBadges[p];
  if (on && !badge) {
    badge = document.createElement('span');
    badge.className = 'res-cell seat-left';
    badge.setAttribute('role', 'img');
    host.append(badge);
    leftBadges[p] = badge;
  }
  if (!badge) return;
  badge.hidden = !on;
  if (wallBadges[p]) wallBadges[p].hidden = on;
  if (!on) return;
  const label = t('seatLeftBadge');
  if (badge.textContent !== label) badge.textContent = label;
  badge.setAttribute('aria-label', label);
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
  /* The guided lesson narrates in its own tongue through the cue banner: the board's generic
     English toasts (the blast report above all) would talk over the story, so they stay quiet. */
  if (tutorialActive) return;
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
/* One text child owns the ellipsis: the pill is a flex row (dot + copy), and `text-overflow` only
   bites on a block that can actually shrink. */
const peerPillText = document.createElement('span');
peerPillText.className = 'peer-pill-t';
peerPill.append(peerPillText);
gameScreen.appendChild(peerPill);

let peerPillTimer = 0;
/** The rival the pill is currently warning about, or -1. Any proof that seat is active clears it. */
let peerWarnSide = -1;
function hidePeerPill(): void {
  if (peerPill.hidden && !peerPillTimer) return;
  window.clearTimeout(peerPillTimer);
  peerPillTimer = 0;
  peerPill.hidden = true;
  peerWarnSide = -1;
  peerPill.classList.remove('is-warn', 'is-ok', 'is-left');
}

/**
 * Print a pill template around a player's FULL display name. The name goes in a `<bdi>` so a
 * Latin, Persian, Arabic, Russian or Spanish handle keeps its own direction and never reorders
 * the sentence around it — and it is a text node, so a name is never parsed as markup.
 */
function paintPeerPill(template: string, name: string): void {
  peerPillText.textContent = '';
  const at = name ? template.indexOf('{name}') : -1;
  if (at < 0) { peerPillText.textContent = template; return; }
  const bdi = document.createElement('bdi');
  bdi.dir = 'auto';
  bdi.textContent = name;
  peerPillText.append(template.slice(0, at), bdi, template.slice(at + '{name}'.length));
}

/* ---------- the CHECKMATE banner: who was trapped, and why ----------
   A party race does not end when a trap closes: the seat is out, the race plays on, and the board
   says so. The banner is the same quiet top pill the connection notices use, in its own tone, and
   it names the seat the way the forfeit banner does — the FULL display name in a `<bdi>`, so a
   mixed-direction handle never reorders the sentence around itself. It never takes a tap: it is
   pointer-transparent, it holds its own clock, and it hides itself when it is done. */
const checkmateBanner = document.createElement('div');
checkmateBanner.className = 'cm-banner';
checkmateBanner.id = 'cm-banner';
checkmateBanner.setAttribute('role', 'status');
checkmateBanner.setAttribute('aria-live', 'assertive');
checkmateBanner.hidden = true;
/* One text child owns the ellipsis: the banner is a flex row (dot + copy), and `text-overflow`
   only bites on a block that can actually shrink. */
const checkmateBannerText = document.createElement('span');
checkmateBannerText.className = 'cm-banner-t';
checkmateBanner.appendChild(checkmateBannerText);
gameScreen.appendChild(checkmateBanner);

/** How long one verdict holds the top of the screen before the next one takes its place. */
const CHECKMATE_BANNER_MS = 4200;
let cmBannerTimer = 0;
/** The name the banner is printing right now: a live language flip re-speaks it in place. */
let cmBannerName = '';
/** Verdicts still waiting for their turn: one trap can close more than one seat at once. */
const cmBannerQueue: string[] = [];
let cmBannerUp = false;

/**
 * Print the checkmate banner around a player's FULL display name. The name goes in a `<bdi>` so a
 * Latin, Persian, Arabic, Russian or Spanish handle keeps its own direction and never reorders the
 * sentence around it — and it is a text node, so a name is never parsed as markup.
 */
function paintCheckmateBanner(name: string): void {
  const template = t('checkmateBanner');
  checkmateBannerText.textContent = '';
  const at = name ? template.indexOf('{name}') : -1;
  if (at < 0) { checkmateBannerText.textContent = template; return; }
  const bdi = document.createElement('bdi');
  bdi.dir = 'auto';
  bdi.textContent = name;
  checkmateBannerText.append(template.slice(0, at), bdi, template.slice(at + '{name}'.length));
}

/** Hand the banner over to the next verdict in the queue, or take it down when there is none. */
function stepCheckmateBanner(): void {
  window.clearTimeout(cmBannerTimer);
  cmBannerTimer = 0;
  const next = cmBannerQueue.shift();
  if (next === undefined) {
    cmBannerUp = false;
    cmBannerName = '';
    checkmateBanner.hidden = true;
    return;
  }
  cmBannerName = next;
  checkmateBanner.hidden = false;
  paintCheckmateBanner(next);
  cmBannerTimer = window.setTimeout(stepCheckmateBanner, CHECKMATE_BANNER_MS);
}

/**
 * Announce a seat that a trap just closed. The banner is a verdict, not a promise: it comes up
 * once, holds its own clock and goes away on its own. A connection notice gives way to it — the
 * elimination is the bigger news — and the live region is filled the moment the verdict lands.
 */
function showCheckmateBanner(name: string): void {
  if (!name) return;
  hidePeerPill();
  cmBannerQueue.push(name);
  if (cmBannerUp) return;              // the banner is already up: this verdict queues behind it
  cmBannerUp = true;
  stepCheckmateBanner();
}

/** Take the banner down: the race is over, or the screen is going somewhere else. */
function hideCheckmateBanner(): void {
  window.clearTimeout(cmBannerTimer);
  cmBannerTimer = 0;
  cmBannerQueue.length = 0;
  cmBannerUp = false;
  cmBannerName = '';
  checkmateBanner.hidden = true;
}

onLang(() => { if (cmBannerUp) paintCheckmateBanner(cmBannerName); });

/** The name a banner prints: the room's own roster first, the HUD's seat label as the fallback. */
function seatFullName(side: Player): string {
  if (active && 'seats' in active) {
    const seat = active.seats.find((s) => s.side === side);
    if (seat?.name) return seat.name;
  }
  /* a ranked rival is named by the matchmaker's own seat data, never by the dock's placeholder */
  if (active && side === rivalSide() && active.opponent.name) return active.opponent.name;
  return TEAM_NAME[side] ?? '';
}

/** The seat whose forfeit decided this race: the struck one, or the ranked rival who resigned. */
function forfeitedSeatName(): string {
  const seat = (state.left ?? [])[0];
  return seatFullName((seat ?? rivalSide()) as Player);
}

/**
 * The result capsule's own verdict line: a bdi-wrapped name and 'left the match', under the header
 * in the live language. The name stays a text node, so a mixed-direction handle never reorders it.
 */
function paintResultLeft(name: string): void {
  const template = t('peerLeft');
  resultLeftTxt.textContent = '';
  const at = name ? template.indexOf('{name}') : -1;
  if (at < 0) {
    resultLeftTxt.textContent = template;
  } else {
    const bdi = document.createElement('bdi');
    bdi.dir = 'auto';
    bdi.textContent = name;
    resultLeftTxt.append(template.slice(0, at), bdi, template.slice(at + '{name}'.length));
  }
  resultLeft.hidden = false;
}

/** A friend-room seat's socket changed state: the pill says so, the board keeps its turn. */
function setPeerStatus(side: number, status: 'reconnecting' | 'online' | 'bot', graceMs = 0, name = ''): void {
  if (side === localSide) return;
  if (status === 'bot') { hidePeerPill(); return; }
  window.clearTimeout(peerPillTimer);
  peerPillTimer = 0;
  peerPill.hidden = false;
  peerWarnSide = status === 'reconnecting' ? side : -1;
  peerPill.classList.toggle('is-warn', status === 'reconnecting');
  peerPill.classList.toggle('is-ok', status !== 'reconnecting');
  peerPill.classList.remove('is-left');
  paintPeerPill(
    t(status === 'reconnecting' ? 'peerReconnecting' : 'peerOnline'),
    name || seatFullName(side),
  );
  if (status === 'reconnecting') {
    /* The server's grace is also the pill's own lease: if the takeover notice is lost, the
       promise still expires instead of sitting over a board that has moved on. */
    peerPillTimer = window.setTimeout(hidePeerPill, Math.max(4000, graceMs + 500));
  } else {
    peerPillTimer = window.setTimeout(hidePeerPill, 1800);
  }
}

/**
 * A rival proved they are active — they moved, or the authoritative snapshot lists them seated. A
 * `reconnecting` pill naming that seat cannot stand against that proof, so it comes down at once
 * instead of waiting out its lease over a board that has already moved on.
 */
function notePeerActive(side: number): void {
  if (peerWarnSide === side) hidePeerPill();
}

/** The chair was struck from the race: a verdict, not a promise, so it reads in its own tone. */
function showSeatLeftPill(side: number, name: string): void {
  if (side === localSide) return;
  window.clearTimeout(peerPillTimer);
  peerPill.hidden = false;
  peerPill.classList.remove('is-warn', 'is-ok');
  peerPill.classList.add('is-left');
  paintPeerPill(t('peerLeft'), name || seatFullName(side));
  peerPillTimer = window.setTimeout(hidePeerPill, 4200);
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
/** The seats the trap just took out: the splash's copy is written from the viewer's own role. */
let cmSplashSeats: Player[] = [];

/**
 * The verdict in the viewer's own voice. This screen's chair comes first — a sealed pawn is its
 * own news before anybody else's. A duel names no one (the far side is simply the opponent), while
 * a party names the seat, because "opponent" is ambiguous once four chairs share the board.
 */
function paintCheckmateSplash(): void {
  setText(cmTitle, t('checkmateTitle'));
  const seats = cmSplashSeats;
  if (seats.includes(localSide)) { setText(cmSub, t('checkmateSubtitleSelf')); return; }
  const named = state.teams.length > 2 ? seats[0] : undefined;
  if (named === undefined) { setText(cmSub, t('checkmateSubtitle')); return; }
  /* The name goes in a `<bdi>` as a text node, so a mixed-direction handle keeps its own order
     inside the sentence and is never parsed as markup. */
  const template = t('checkmateSubtitleSeat');
  const name = seatFullName(named);
  cmSub.textContent = '';
  const at = name ? template.indexOf('{name}') : -1;
  if (at < 0) { cmSub.textContent = template; return; }
  const bdi = document.createElement('bdi');
  bdi.dir = 'auto';
  bdi.textContent = name;
  cmSub.append(template.slice(0, at), bdi, template.slice(at + '{name}'.length));
}

/**
 * Raise the announcement over the board. It never takes a tap and it hides itself on its clock.
 *
 * The live region is populated IMMEDIATELY — a screen reader must not wait for a visual cue — but
 * the banner itself only enters after `CHECKMATE_SPLASH_DELAY_MS`, so the canvas flare and the
 * first finisher burst are seen before the verdict covers them.
 */
function showCheckmateSplash(seats: readonly Player[]): void {
  window.clearTimeout(cmTimer);
  cmSplashSeats = [...seats];
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
  cmSplashSeats = [];
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

/** A bdi-isolated run: signed figures, ratios and rank tags never borrow the paragraph's direction. */
function isoText(text: string, dir: 'ltr' | 'auto'): HTMLElement {
  const el = document.createElement('bdi');
  el.setAttribute('dir', dir);
  el.textContent = text;
  return el;
}

/** Paint a line with every signed figure, ratio and rank tag isolated in its own LTR run. */
function paintIsoLine(el: HTMLElement, text: string, dir: 'ltr' | 'rtl'): void {
  el.dir = dir;
  el.replaceChildren();
  const re = /([+\-−]?\d+(?:\/\d+)?|#\d+)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) el.append(document.createTextNode(text.slice(last, at)));
    el.append(isoText(m[0], 'ltr'));
    last = at + m[0].length;
  }
  if (last < text.length) el.append(document.createTextNode(text.slice(last)));
}

/** Paint a template's `{name}` slot as its own auto-direction run, never as bidi-neutral text. */
function paintNamedLine(el: HTMLElement, template: string, name: string): void {
  const dir = langDef(lang).dir;
  el.dir = dir;
  const at = template.indexOf('{name}');
  el.replaceChildren();
  if (at < 0) {
    el.append(document.createTextNode(template));
    return;
  }
  if (at > 0) el.append(document.createTextNode(template.slice(0, at)));
  if (name) {
    const bdi = document.createElement('bdi');
    bdi.dir = 'auto';
    bdi.textContent = name;
    el.append(bdi);
  }
  el.append(document.createTextNode(template.slice(at + 6)));
}

/**
 * The channel's own cut of the match, as one horizontal strip: shield + channel + rank on the
 * start edge, the gold `+5 TIQ` pill on the end edge. Shown only for an enrolled fighter in a
 * Play with Friends room — the one board Channel Wars pays.
 */
const warBadge = document.createElement('div');
warBadge.className = 'cw-war';
warBadge.id = 'iv-war';
warBadge.setAttribute('role', 'status');
warBadge.hidden = true;
warBadge.innerHTML = '<span class="cw-war-ico" aria-hidden="true"><svg class="ico"><use href="#i-shield" /></svg></span>'
  + '<bdi class="cw-war-name" id="iv-war-name" dir="auto"></bdi>'
  + '<bdi class="cw-war-rank" id="iv-war-rank" dir="ltr"></bdi>'
  + '<span class="cw-war-tiq"><bdi id="iv-war-tiq" dir="ltr"></bdi></span>';
bonusBadge.insertAdjacentElement('afterend', warBadge);

const warName = $<HTMLElement>('iv-war-name');
const warRank = $<HTMLElement>('iv-war-rank');
const warTiq = $<HTMLElement>('iv-war-tiq');

function paintWarBadge(gain: number, rank: number, name: string): void {
  warName.textContent = name;
  warRank.textContent = `#${Math.max(1, rank)}`;
  warTiq.textContent = `+${gain} ${t('resultTiqUnit')}`;
}

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
  warBadge.setAttribute('dir', dir);
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
/** The Command Center's own module: its type only, so the panel itself is a lazy chunk. */
type Admin = import('./admin').Admin;
let admin: Admin | null = null;
/* The close hook is the pause family's safety net: see `resumeAfterSheetClose` — every way the
   pause sheet (or the quit confirm it opens) can go away ends in a live board again, never a
   silently paused one. */
const sheets = createSheets($('scrim'), { onClose: resumeAfterSheetClose });
const sheetById = (id: string) => document.getElementById(id);

/**
 * The Channel Wars Hub is a TAP door, never a boot surface. A WebView can resume a page from a
 * bfcache snapshot with the hub still raised, so every launch — and every restored page — starts
 * by putting it away and dropping the scrim with it. No other screen state is touched.
 */
function keepChannelWarClosed(): void {
  const hub = sheetById('channel-war-modal');
  if (!hub || hub.hidden) return;
  hub.classList.remove('open', 'closing');
  hub.style.pointerEvents = '';
  hub.hidden = true;
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
keepChannelWarClosed();
window.addEventListener('pageshow', (event) => { if (event.persisted) keepChannelWarClosed(); });
/* A bfcache/session snapshot is taken on pagehide: the hub must be gone before it is captured, so
   the next launch resumes on the screen it left, never on a raised tournament drawer. */
window.addEventListener('pagehide', () => { keepChannelWarClosed(); });

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
 * The Channel Wars identity of the board being played. `warPending` is armed by the hub's queue
 * and spent by `startGame`, so the flag survives the debut override and the matchmaker hand-off
 * without leaking into a practice board launched from the mode drawer. `warPaid` keeps one match
 * to one credit: the settlement and the forfeit path both ask it before paying.
 */
let warPending = false;
let warMatch = false;
let warPaid = false;

/**
 * The one door every queue goes through, so the arena's own lock can stand in front of it: when
 * entries are closed, a new queue is refused with the reason rather than silently doing nothing.
 * `matchmaking.open()` is never called directly.
 */
function queueMatch(mode: 'pvp' | 'arena' | 'channel_war' = 'pvp') {
  /* THE POST-FIRST-MATCH WALL. A queue that would open a second board for an unverified player
     is refused here, before the searching stage exists: the gate is the only thing that can
     answer this tap, and it never stood in front of the first race. */
  if (channelGateBlocks()) { raiseChannelGate(); return; }
  /* A war match is an ordinary ranked pairing that also pays the fighter's channel. The flag is
     held here rather than read off the seat, because the debut override and a bot backfill both
     produce a board with no online mode — and a war match still owes its channel its points. */
  warPending = mode === 'channel_war';
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
  /* the arena lock is mirrored from the server: new entries stop, live races play out. The war
     runs on its own weekly clock, so a closed Arena season never shuts the Channel Wars door. */
  const board = arena();
  if (mode !== 'channel_war' && arenaLocked(board)) {
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
     Ranks — and any challenge key it mounted — is torn down before the tab paints.
     `menu.setRoute()` above already dropped the menu's own rival context for this navigation
     (same screen, same tick), so only the compete side is asked here. */
  if (id === 'profile') {
    compete?.clearRivalContext();
  }
  // the light finish is a race-stage skin: it comes and goes with the board, never with the shell
  document.documentElement.classList.toggle('light-game', appearance() === 'light' && id === 'game');
  // Telegram BackButton on every screen except Home; always functional via onBack fallback.
  setBackButton(id !== 'home');
  if (id !== 'game') { cancelTutorial(); pauseGame(); }   // the board only ticks while it is on screen
  /* ...and the bed follows the board. Every screen that is not the playable race is a non-match
     screen — Home, Ranks, the Shop, Squads, Compete, a lobby — so the strict gate is closed on
     arrival there. The board itself is gated ON by `reveal()` and by a `restart()` dealt in place,
     never by a route alone, which is what keeps matchmaking and the menu silent. */
  if (id !== 'game') setMusicInMatch(false);
  /* Returning to a live board by a route (not just a fresh `startGame`) must not inherit the
     pause that was raised on the way out. The pause family is sheet-owned, so a sheet still above
     the board keeps its own stop. */
  else if (!sheets.isOpen) paused = false;
  /* off the board, a room that was waiting in the background may finally show itself */
  if (id !== 'game') resumeRoom();
  /* `prev === null` is the cold boot's OWN Home render, not an exit back to it. A genuine return
     to Home re-arms the channel gate that an invite launch held back, raises the post-first-match
     wall when it stands, and is the one moment the optional tactical-training upsell belongs: the
     friend has been played and nobody is waiting. */
  if (id === 'home' && prev !== null) {
    if (inviteGateDeferred && !peekPendingDuelRoom()) {
      inviteGateDeferred = false;
      initJoinGate();
    }
    /* Every road back to the menu ends here — the result card's Menu key, the dock, the back
       button — so the wall is raised on the arrival rather than on one particular exit. */
    raiseChannelGate();
    /* A training sheet has no business opening behind a wall the player has to answer first. */
    if (!peekPendingDuelRoom() && !channelGateBlocks()) maybeOfferTraining();
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
/** A seat forfeited during this race: its victory pays the exact ±15 stake the sheet quotes. */
let forfeitMatch = false;
/** The window after a confirmed forfeit: the Home screen owes the player one verdict toast. */
let forfeitToast = false;
/** The one competitive stake, in TIQ: what a forfeit costs and what the victory pays. */
const FORFEIT_TIQ = 15;
const rivalSide = (): Player => {
  if (state.seatTeam) {
    const allies = sideOf(state, localSide);
    const enemy = roster().find((seat) => !allies.includes(seat));
    if (enemy !== undefined) return enemy;
  }
  return localSide === 0 ? 1 : 0;
};
/**
 * How this board is counted: an Arena cup race carries the tag the room announced; every other
 * online board is PvP, and a board with no live seat is a practice race against the machine.
 */
const matchMode = (): MatchMode => {
  if (!active) return 'bot';
  if (active.mode === 'arena') return 'arena';
  /* A friends room can launch with one person and a backfilled seat; that board is practice,
     exactly as the room counts it. A seat the machine took over (`left`) is ALSO practice —
     the person who opened it is gone, so a win there is against the AI, never a PvP win. */
  if ('seats' in active) {
    const humans = active.seats.reduce((n, seat) => n + (seat.bot || seat.left ? 0 : 1), 0);
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

/** Paint the board through the live team map while keeping the renderer's API untouched. */
function paintRendererPerspective(reset = false): void {
  withTeamRampContext(state.seatTeam, localSide, () => {
    if (reset) renderer.setPerspective(null);
    renderer.setPerspective(currentPerspective());
  });
}
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
    return new Promise<Action | null>((res) => {
      window.setTimeout(() => {
        /* One committed frame first: Hard's wall sweep is synchronous and must never land on the
           same frame as the player's slide. The think delay is unchanged — only the yield point
           moves, to just after the browser has painted. */
        void yieldToPaint().then(() => {
          const natural = botAction(s, level);
          res(debut ? onboardingRivalAction(full, localSide, natural, hold) : natural);
        });
      }, botThinkMs(level));
    });
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

/**
 * Is this seat played from THIS screen? Seat 0 in a local race, the matchmaker's seat in an online
 * one. Every "somebody else is thinking" rule asks this one question — never "is this seat a bot?".
 */
const isLocalSeat = (seat: Player): boolean => seat === localSide;

/**
 * Is this seat thinking it over? The ONE condition every turn indicator reads: the seat to move is
 * somebody else's, the match is still live, and nothing is holding the board.
 *
 * A bot working out its move and a PERSON on the far side of the wire answer it identically, which
 * is what lets the pips floating above a pawn and the dots on a card mean the same thing in a
 * friendly room and in a ranked duel. The local seat's own pawns never wear them: this screen
 * plays `localSide`, so that seat is never an opponent, whoever is on the other end.
 */
const opponentThinking = (seat: Player): boolean =>
  state.turn === seat && !isLocalSeat(seat) && state.winner === null && !paused && !tutorialActive
  && !isLeft(state, seat);

const REASON = {
  dry: 'No walls remaining!',
  overlap: 'Overlaps a wall',
  cross: 'Crosses a wall',
  blocked: 'Blocks the path',
};

/**
 * Why a wall slot was refused: the budget is spent, a clash with a wall already standing (the same
 * `wallConflict` test the engine, bot and server use — a shared edge segment, a `+` through a hinge
 * vertex, or the composite `+` a bar completes across a tip-to-tip seam) or a sealed path. `wallOk`
 * only answers yes/no, so the reason stays a UI concern.
 */
function wallIssue(s: GameState, w: Wall): keyof typeof REASON {
  if (wallsRemaining(s, w.owner) <= 0) return 'dry';
  const clash = wallConflict(s.walls, w);
  if (clash) return clash;
  /* EVERY live pawn can refuse a wall — yours, your partner's and your rivals'. Sealing an empty
     pocket is legal; sealing a runner is not, whoever owns it. Checkmates come from the walk and
     the mine's throw, never from the bar. */
  const d = distField([...s.walls, w], s.cols, s.rows);
  const blocked = s.balls.some((b) => !b.isCheckmated
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

/* ---------- the side this screen plays for ----------
   A 2v2 is won by a TEAM: the worker pays every chair on the winning colour (`onWinningSide`), and
   the board's `winner` names the seat that took the line, not the side that took the race. These
   three readers are the one place that distinction is resolved, so the capsule, the standings and
   the finisher can never disagree about who won. Every other format names a seat, and `sideOf`
   collapses to that seat alone. */

/**
 * The room's seat → colour plan for the engine, or undefined when this race names seats rather than
 * teams. Read off `sizes`, not the board: `restart()` asks for it while the previous board is still
 * in `state`.
 */
function seatTeamMap(): number[] | undefined {
  if (!active || !('seats' in active) || active.mode !== 'team') return undefined;
  const seats = active.seats;
  return sizes.map((_n, seat) => seats.find((s) => s.side === seat)?.team ?? defaultTeam(seat));
}

/** Did this screen's SIDE take the race? A partner who crossed the line wins this seat too. */
function localWon(): boolean {
  const winner = state.winner;
  return winner !== null && sideOf(state, winner).includes(localSide);
}

/** The seats that took the race, champion first: both partners in a 2v2, the lone winner elsewhere. */
function winningSeats(): Player[] {
  const winner = state.winner;
  if (winner === null) return [];
  return [winner, ...sideOf(state, winner).filter((seat) => seat !== winner)];
}

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
/** The subset of `hints` whose cell has no route to FINISH: a step there seals the pawn that takes it. */
let trapHints: Pos[] = [];
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
  state, balls: ballViews, hints, trapHints, ghost, last: marks, thinking: null,
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
/** The action a wall/mine preview staged and the floating ✓ has not answered yet. */
let tutPending: TutorialAction | null = null;
/** Set by the on-demand door: the lesson opens on the next race even if it was read before. */
let tutorialRequested = false;
/** A lesson that replaces the launch is its own match; finishing or skipping it keeps the board. */
let tutorialStandalone = false;
/**
 * ACTION-FIRST FIRST OPEN. True only while a true first-time player is inside the lesson that
 * boot launched for them: no Home screen was ever shown on the way in. Cleared the moment the
 * lesson ends, so a later race or replay can never be mistaken for a cold boot.
 */
let firstRunBoot = false;
/** The boot lesson is done and the flag is saved; the player is sprinting to the FINISH line. */
let firstRunSprint = false;
/**
 * FREE-PLAY CLIMAX. The thirteen-tap comeback has detonated, the overlay is gone and the board is the
 * player's own. The match is still the lesson's, so the rival stays handicapped (no walls, no
 * mines, no row 0) and chat stays silent until the race settles. This is what makes the tutorial
 * impossible to lose rather than merely easy.
 */
let tutorialClimax = false;
/** The whole tutorial match — guided lesson plus climax. Chat and banter read this, never the stage. */
const tutorialMatchLive = (): boolean => tutorialActive || tutorialClimax;
const tutorialStage = (): TutorialStage | null => (tutorialActive ? tutorial?.stage ?? null : null);
/* The lesson draws NO line across the board — no route, no threat run, no reroute. It points with
   the spotlight, the ghost hand, the single-tile detour marker and the board's own local highlights. */

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
/**
 * Publish the move dots, and mark the ones that walk into a dead end. A step onto a cell with no
 * route to FINISH seals the pawn that takes it, so the dot carries a warning rather than being
 * hidden: the move is legal, and the player is still the one who decides to take it.
 */
function setHints(next: Pos[]): void {
  hints = next;
  trapHints = [];
  if (!next.length) return;
  const d = distField(state.walls, state.cols, state.rows);
  for (const h of next) if (pathOn(d, h, state.cols) === Infinity) trapHints.push(h);
}
function setMode(next: BoardMode<Ghost>) {
  selected = next.selected;
  ghost = next.preview;
  mineArmed = next.mine;
  if (!next.preview) wallDrag = null;   // no bar to carry once the ghost is gone
  setHints(dotsFor(next));       // derived, so it is rebuilt the moment the mode moves — never stale
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
  const on = next && canAct() && minesLeft(state, localSide) > 0;
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
 * Publish every pawn's footprint to the guidance layers (`boardpieces.ts`).
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
    /* A sealed pawn keeps its token on the board, so it keeps its footprint too: the callouts must
       not stand over a piece the player can still see, frozen or not. */
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
  /** The TIQ a win actually paid; always 0 on a bot board. */
  tiq: number;
  /** The magnitude of the stake a defeat wears; a bot board never charges one. */
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
/** the coin count-up keeps its own handle: claiming coins must not freeze the TIQ ledger */
let coinRaf = 0;
let resultTimers: number[] = [];
/** The rival walked out of the settled race: the rematch key and the banter dock are dead. */
let resultLocked = false;
/** The friends room's live rematch consensus, or null outside a friends match. */
let rematchState: RematchState | null = null;
/** The invitation this seat already answered: the modal never reopens for the same vote. */
let rematchChallengeDismissed = '';
/** One settled board owns one channel answer: a late registry reply cannot paint into the next. */
let warEpoch = 0;

/** Stop every clock the result owns: the count-up and the haptic beats. */
function clearResultMotion() {
  if (resultRaf) { cancelAnimationFrame(resultRaf); resultRaf = 0; }
  if (coinRaf) { cancelAnimationFrame(coinRaf); coinRaf = 0; }
  for (const id of resultTimers) window.clearTimeout(id);
  resultTimers = [];
  resultCoinChip.classList.remove('is-celebrating');
  resultTiqChip.classList.remove('is-restoring');
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
  /* A room names every chair from its roster, so each of a party's opponents is painted from its
     OWN seat. The single `opponent` slot is only a fallback for a ranked duel's one rival. */
  if (active && 'seats' in active) {
    return asPhoto(active.seats.find((s) => s.side === seat)?.avatarUrl);
  }
  return seat === rivalSide() ? asPhoto(active?.opponent.avatarUrl ?? null) : '';
}

/**
 * The people on the far side of the board that just settled, shaped for the Friends & Rivals
 * store. Only a board with two people at it reaches here: a bot race, a room the machine
 * backfilled and a seat somebody walked out of are not rivalries. A 2v2 partner is a partner,
 * never a rival, and an FFA seat the local player finished above is a win against that seat.
 */
function settledOpponents(won: boolean): FriendOpponent[] {
  if (!active || matchMode() !== 'pvp') return [];
  const order = finalStandings();
  const champions = winningSeats();
  const rankOf = (side: Player): number => order.indexOf(side);
  const myRank = rankOf(localSide);
  const out: FriendOpponent[] = [];
  if ('seats' in active) {
    const teamMatch = active.mode === 'team';
    const myTeam = active.seats.find((seat) => seat.side === localSide)?.team ?? defaultTeam(localSide);
    for (const seat of active.seats) {
      if (seat.side === localSide || seat.bot || seat.left) continue;
      if (teamMatch && seat.team === myTeam) continue;   // a 2v2 partner is not a rival
      const rivalWon = champions.includes(seat.side as Player);
      const verdict = teamMatch
        ? won
        : won ? !rivalWon : (!rivalWon && myRank >= 0 && rankOf(seat.side as Player) > myRank);
      out.push({ id: seat.id, name: seat.name, avatar: seat.avatarUrl ?? '', won: verdict });
    }
    return out;
  }
  const rival = active.opponent;
  if (rival && !rival.isBot) {
    out.push({ id: rival.id, name: rival.name, avatar: rival.avatarUrl ?? '', won });
  }
  return out;
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

/** The seats the board paints inert: struck from the race after their player disconnected. */
function paintLeftSeats(): void {
  renderer.setLeftSeats(roster().filter((p) => isLeft(state, p)));
}

/**
 * Where every seat finished, champion first. A race stops the instant a ball takes the line, so
 * the seats that never crossed are ordered by how far their leading ball climbed and then by the
 * field behind it — a final standing the player can read straight off the board they just left.
 * A seat checkmated out of a party fell further than any runner: it owns the bottom of the ladder,
 * later falls ranked above earlier ones. A 2v2 is won by a side, so both partners take the top of
 * the ladder together — the seat that crossed the line first, its team-mate beside it.
 */
function finalStandings(): Player[] {
  const champions = winningSeats();
  const fallen = state.eliminated ?? [];
  const progress = (seat: Player): [number, number] => {
    const rows = state.balls.filter((ball) => ball.team === seat).map((ball) => ball.pos.r);
    if (!rows.length) return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    return [Math.min(...rows), rows.reduce((sum, row) => sum + row, 0)];
  };
  const rest = roster().filter((seat) => !champions.includes(seat));
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
  return [...champions, ...rest];
}

/**
 * THE SEAT'S LIVE VERDICT. A friends capsule paints one pill per row: a green check when that
 * player is ready for the rematch, a muted LEFT when their chair is gone. Stroke-only, tinted by
 * CSS, never a pictograph.
 */
function statusCheck(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'result-ready-ico');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const d = document.createElementNS(NS, 'path');
  d.setAttribute('d', 'M4.5 12.6 9.6 17.7 19.5 6.9');
  d.setAttribute('fill', 'none');
  d.setAttribute('stroke', 'currentColor');
  d.setAttribute('stroke-width', '3');
  d.setAttribute('stroke-linecap', 'round');
  d.setAttribute('stroke-linejoin', 'round');
  svg.append(d);
  return svg;
}

/** A friends / private-room match: its capsule votes a rematch, never random matchmaking. */
const friendsMatch = (): boolean => !!active && 'seats' in active;

/** The consensus says nothing more can happen: the key reads a reason and is dead. */
const rematchDead = (): boolean => friendsMatch() && !!rematchState
  && (rematchState.status === 'unavailable' || rematchState.requiredCount < 2);

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
  /* a disconnect reads LEFT, a trap reads OUT: both are off the board, but not for the same reason */
  const placeLabel = t(isLeft(state, seat) ? 'seatLeftBadge' : out ? 'checkmateOut' : placeKey);

  const row = document.createElement('li');
  row.className = 'result-row';
  row.dataset.place = String(place);
  row.dataset.seat = String(seat);
  row.setAttribute('aria-label', `${name}, ${placeLabel}${local ? `, ${t('hudYou')}` : ''}${seatVip(seat) ? `, ${t('vipPillActive')}` : ''}`);
  if (local) {
    row.classList.add('is-you');
    row.setAttribute('aria-current', 'true');
  }
  if (out) row.classList.add('is-out');

  const medal = document.createElement('span');
  medal.className = 'result-medal';
  medal.dataset.place = String(place);
  medal.setAttribute('aria-hidden', 'true');
  medal.append(isoText(`#${rank}`, 'ltr'));

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
  strong.append(isoText(name, 'auto'));
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
  placeEl.textContent = placeLabel;
  meta.append(placeEl);
  /* the live rematch verdict this seat carries: filled by `paintRematchUi()` */
  const ready = document.createElement('span');
  ready.className = 'result-ready';
  ready.hidden = true;
  meta.append(ready);
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
  const sayText = document.createElement('bdi');
  sayText.className = 'result-say-t';
  sayText.dir = 'auto';
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
  const { won } = resultView;
  /* The hero outcome is always Victory or Defeat. A checkmate is the reason, so it moves up into
     the kicker instead of replacing the outcome the player came to read. */
  const trapped = state.checkmate?.decided === true && state.winner !== null;
  resultKicker.textContent = t(trapped ? 'checkmateKicker' : 'resultKicker');
  verdict.textContent = t(won ? 'resultVictoryTitle' : 'resultDefeatTitle');
  shareLabel.textContent = t('resultShare');
  toMenuLabel.textContent = t('resultMenu');
  shareBtn.setAttribute('aria-label', t('resultShare'));
  toMenu.setAttribute('aria-label', t('resultMenu'));
  /* A FRIENDS CAPSULE OWNS ONE TEAL KEY. The duel challenge is a lobby door — there is nobody to
     challenge in a room the player just raced, and a second call to action there is noise. */
  shareBtn.hidden = !won || friendsMatch();
  again.classList.toggle('is-revenge', !won);
  againIco?.setAttribute('href', won ? '#i-play' : '#i-restart');
  paintResultRewards();
  paintResultLock();
  paintRewardButtons();
  paintResultRoster();
  paintRematchUi();
  /* a language flip can land while the consent sheet is up: its warning must switch too */
  paintAdConfirmCopy();
}

/**
 * ONE symmetric reward card on each side of the grid. Card one is always the coins the wallet
 * kept. Card two is the player's OWN TIQ for the match — a win prints the gain, a defeat turns
 * crimson and opens the recovery shield — on every board with a person on the far side, friendly
 * rooms included. The channel's cut lives in its own strip above the grid, never in this card, so
 * the two ledgers can never overwrite each other. A practice board pays XP instead, and a bot
 * board is TIQ-neutral by rule.
 */
type RewardTier = { kind: 'personal' | 'xp' | 'none'; amount: number; sign: '+' | '-' };

function rewardTier(): RewardTier {
  if (!resultView) return { kind: 'none', amount: 0, sign: '+' };
  const v = resultView;
  if (!v.bot && (v.won ? v.tiq > 0 : v.stake > 0)) {
    return { kind: 'personal', amount: v.won ? v.tiq : v.stake, sign: v.won ? '+' : '-' };
  }
  if (v.xp > 0) return { kind: 'xp', amount: v.xp, sign: '+' };
  return { kind: 'none', amount: 0, sign: '+' };
}

function paintResultRewards(): void {
  if (!resultView) return;
  const { won, coins } = resultView;
  const tier = rewardTier();
  const claimed = hasClaimedInMatch('recover_tiq');
  const restored = tier.kind === 'personal' && tier.sign === '-' && claimed;
  const doubled = hasClaimedInMatch('double_coins');
  const showCoins = coins > 0;
  const showXp = tier.kind === 'xp';
  const showTiq = tier.kind === 'personal';
  resultCoinChip.hidden = !showCoins;
  resultXpChip.hidden = !showXp;
  resultTiqChip.hidden = !showTiq;
  resultCoinChip.classList.toggle('is-consolation', !won && showCoins);
  const paid = (showCoins ? 1 : 0) + (showXp || showTiq ? 1 : 0);
  resultBank.hidden = paid === 0;
  resultBank.dataset.paid = String(Math.max(1, paid));
  if (showTiq) {
    resultTiqChip.classList.toggle('is-loss', tier.sign === '-');
    resultTiqChip.classList.toggle('is-restored', restored);
    resultTiqLabel.textContent = t('resultTiqUnit');
    resultTiqSign.textContent = restored ? '' : tier.sign;
    resultTiqN.textContent = resultAbs(restored ? 0 : tier.amount);
  }
  if (showXp) resultXpN.textContent = resultAbs(resultView.xp);
  if (showCoins) resultCoinsN.textContent = resultAbs(doubled ? coins * 2 : coins);
}

/**
 * The primary key is the one action the rival shares: when they leave, it is locked and renamed
 * instead of queueing a rematch into an empty room. The label is recomputed on every repaint, so a
 * language flip cannot quietly unlock it.
 */
function paintResultLock(): void {
  if (!resultView) return;
  const friends = friendsMatch();
  const dead = rematchDead();
  const waiting = friends && rematchState?.votes?.[localSide] === 'accepted' && !dead;
  again.disabled = resultLocked || dead || !!waiting;
  again.classList.toggle('is-locked', resultLocked || dead);
  const againText = resultLocked ? t('resultOpponentLeft') : primaryLabel();
  /* a waiting key names the friend it waits on as its own bidi run; everything else is the
     ordinary one-line label, with its signed figures isolated by the shared painter */
  if (waiting && sizes.length <= 2) {
    paintNamedLine(againLabel, t('resultRematchWaitingDuel'), seatFullName(rivalSide()));
  } else {
    paintIsoLine(againLabel, againText, langDef(lang).dir);
  }
  /* the key's spoken name follows the visible one in every language, locked or not */
  again.setAttribute('aria-label', againText);
  if (resultLocked) again.title = t('resultOpponentLeftHint');
  else again.removeAttribute('title');
}

/**
 * THE PRIMARY KEY'S ONE SENTENCE. Outside a friends room it is the old pair — Play again, or the
 * revenge line after a loss. Inside one it is the live consensus: REMATCH before anybody votes,
 * the friend's name while this seat waits on them, and the reason once the rematch is dead.
 * Friends rooms rematch without a count or a cap, so no fraction ever appears here.
 */
function waitingRematchLabel(): string {
  const party = sizes.length > 2;
  const template = t(party ? 'resultRematchWaitingParty' : 'resultRematchWaitingDuel');
  return template.replace('{name}', party ? '' : seatFullName(rivalSide()));
}

function primaryLabel(): string {
  if (!resultView) return t('resultPlayAgain');
  if (!friendsMatch()) return t(resultView.won ? 'resultPlayAgain' : 'resultRevenge');
  const state = rematchState;
  if (state && (state.status === 'unavailable' || state.requiredCount < 2)) {
    if (state.reason === 'RIVAL_LEFT') return t('resultRematchRivalLeft');
    if (state.reason === 'RIVAL_DECLINED') return t('resultRematchRivalDeclined');
    return t('resultRematchNotEnough');
  }
  if (state?.votes?.[localSide] === 'accepted') return waitingRematchLabel();
  return t('resultRematch');
}

/**
 * The capsule's consensus surface: one quiet waiting line when this seat has already asked, the
 * reason once the rematch is dead, and the floating invitation card for the incoming request.
 * Friends rooms rematch without a count or a cap, so no `0/2` or `1/2` is ever painted here.
 */
function paintRematchUi(): void {
  if (!resultView || !friendsMatch()) {
    rematchBar.hidden = true;
    rematchDeclineBtn.hidden = true;
    rematchBarText.textContent = '';
    hideRematchChallenge();
    paintRematchPills();
    return;
  }
  const state = rematchState;
  const you = state?.votes?.[localSide] ?? 'pending';
  const dead = rematchDead();
  const waiting = you === 'accepted' && !dead;
  rematchDeclineBtn.classList.toggle('is-cancel', waiting);
  if (state && state.status === 'unavailable') {
    rematchBar.hidden = false;
    paintIsoLine(rematchBarText,
      state.reason === 'RIVAL_DECLINED' ? t('resultRematchRivalDeclined')
        : state.reason === 'RIVAL_LEFT' ? t('resultRematchRivalLeft')
          : t('resultRematchNotEnough'),
      langDef(lang).dir);
    rematchDeclineBtn.hidden = true;
  } else if (waiting) {
    /* THIS SEAT ASKED FIRST: one quiet line naming the friend, and a cancel key. Never a fraction. */
    rematchBar.hidden = false;
    paintNamedLine(rematchBarText,
      t(sizes.length > 2 ? 'resultRematchWaitingParty' : 'resultRematchWaitingDuel'),
      sizes.length > 2 ? '' : seatFullName(rivalSide()));
    rematchDeclineBtn.hidden = false;
    rematchDeclineBtn.textContent = t('resultRematchCancel');
    rematchDeclineBtn.setAttribute('aria-label', t('resultRematchCancel'));
  } else {
    /* an incoming invitation belongs to the floating card, not to a strip over the actions */
    rematchBar.hidden = true;
    rematchDeclineBtn.hidden = true;
  }
  paintRematchChallenge();
  paintRematchPills();
}

/**
 * One pill per standings row: this player's live verdict. A chair struck from the board reads
 * LEFT whatever its vote said, so the capsule never promises a rematch with someone who is gone.
 */
function paintRematchPills(): void {
  const friends = !!resultView && friendsMatch();
  const votes = rematchState?.votes ?? null;
  for (const row of Array.from(resultRoster.children) as HTMLElement[]) {
    const pill = row.querySelector<HTMLElement>('.result-ready');
    if (!pill) continue;
    if (!friends) { pill.hidden = true; continue; }
    const seat = Number(row.dataset.seat);
    if (!Number.isInteger(seat)) { pill.hidden = true; continue; }
    const gone = isLeft(state, seat as Player) || votes?.[seat] === 'declined';
    if (gone) {
      pill.hidden = false;
      pill.classList.add('is-left');
      pill.replaceChildren(document.createTextNode(t('resultRematchLeft')));
      continue;
    }
    if (votes?.[seat] === 'accepted') {
      pill.hidden = false;
      pill.classList.remove('is-left');
      pill.replaceChildren(statusCheck(), document.createTextNode(t('resultRematchReady')));
      continue;
    }
    pill.hidden = true;
    pill.classList.remove('is-left');
  }
}

/** The first friend who asked for the next board, so a party names the actual challenger. */
function rematchInviteSeat(state: RematchState | null): Player | null {
  const votes = state?.votes ?? {};
  const seat = Object.keys(votes)
    .map(Number)
    .filter((side) => side !== localSide && votes[side] === 'accepted')
    .sort((a, b) => a - b)[0];
  return Number.isInteger(seat) ? seat as Player : null;
}

/** The invitation signature: this round plus every OTHER seat that has accepted it. */
function rematchInviteSig(state: RematchState | null): string {
  const votes = state?.votes ?? {};
  const seats = Object.keys(votes)
    .filter((seat) => Number(seat) !== localSide && votes[Number(seat)] === 'accepted')
    .sort()
    .join(',');
  return seats ? String(state?.round ?? 1) + '|' + seats : '';
}

function hideRematchChallenge(): void {
  rematchChallenge.hidden = true;
  rematchChallenge.classList.remove('is-on');
}

/**
 * THE INCOMING INVITATION. A friend tapped rematch while this seat still owes an answer, so the
 * capsule raises one floating card: their portrait in a pulsing gold ring, their name as its own
 * bidi run, and the two keys. It closes the moment this seat answers, the rival leaves, or the
 * room starts the next board.
 */
function paintRematchChallenge(): void {
  const state = rematchState;
  const you = state?.votes?.[localSide] ?? 'pending';
  const sig = rematchInviteSig(state);
  if (!resultView || !friendsMatch() || resultLocked || !sig || you !== 'pending' || rematchDead()) {
    hideRematchChallenge();
    if (!sig) rematchChallengeDismissed = '';
    return;
  }
  const from = rematchInviteSeat(state) ?? rivalSide();
  const name = seatFullName(from);
  rematchChallengeTitle.textContent = t('rematchChallengeTitle');
  paintNamedLine(rematchChallengeSub, t('rematchChallengeSubtitle'), name);
  rematchChallengeAccept.textContent = t('rematchChallengeAccept');
  rematchChallengeDecline.textContent = t('rematchChallengeDecline');
  rematchChallengeAccept.setAttribute('aria-label', t('rematchChallengeAccept'));
  rematchChallengeDecline.setAttribute('aria-label', t('rematchChallengeDecline'));
  paintResultAvatar(rematchChallengePhoto, rematchChallengeInitial, name, resultPhoto(from));
  const wasHidden = rematchChallenge.hidden;
  rematchChallenge.hidden = rematchChallengeDismissed === sig;
  if (!rematchChallenge.hidden && wasHidden) {
    restartClass(rematchChallenge, 'is-on');
    if (overlayOpen) rematchChallengeAccept.focus({ preventScroll: true });
  }
}

/**
 * ASK FOR THE REMATCH. The only door a friends capsule has into another board: one vote on the
 * room that is already open. This function can never reach a queue — that is the whole point of
 * the branch above it in the key's handler.
 */
function requestRematch(): void {
  if (!active || !('seats' in active)) return;
  if (rematchDead()) { notify('error'); paintRematchUi(); return; }
  if (rematchState?.votes?.[localSide] === 'accepted') return;
  if (!active.sendRematchVote('accepted')) {
    showNote(t('resultOpponentLeftHint'), true, 2200);
    return;
  }
  const cast = rematchState?.votes ?? {};
  rematchState = {
    votes: { ...cast, [localSide]: 'accepted' },
    acceptedCount: (rematchState?.acceptedCount ?? 0) + 1,
    requiredCount: rematchState?.requiredCount ?? Math.max(2, sizes.length),
    status: 'pending',
    round: rematchState?.round ?? 1,
  };
  rematchChallengeDismissed = '';
  hideRematchChallenge();
  paintRematchUi();
  paintResultLock();
}

/** Decline the rematch this seat was asked for. The room re-reads its quorum immediately. */
function declineRematch(): void {
  if (!active || !('seats' in active)) return;
  if (!active.sendRematchVote('declined')) return;
  const cast = rematchState?.votes ?? {};
  rematchState = {
    votes: { ...cast, [localSide]: 'declined' },
    acceptedCount: rematchState?.acceptedCount ?? 0,
    requiredCount: rematchState?.requiredCount ?? Math.max(2, sizes.length),
    status: 'pending',
    round: rematchState?.round ?? 1,
  };
  rematchChallengeDismissed = rematchInviteSig(rematchState);
  hideRematchChallenge();
  paintRematchUi();
  paintResultLock();
}

/**
 * Roll both counters up from zero and land three haptic beats under the roll. Reduced motion stills
 * the numbers on their final values; the haptics are the user's own setting and keep their pulse.
 */
function rollResultValues(): void {
  if (!resultView) return;
  const { coins, xp } = resultView;
  const tier = rewardTier();
  const restored = tier.kind === 'personal' && tier.sign === '-' && hasClaimedInMatch('recover_tiq');
  const tiqTarget = restored ? 0 : tier.amount;
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
    resultTiqN.textContent = resultAbs(tiqTarget * eased);
    resultCoinsN.textContent = resultAbs(coins * eased);
    resultXpN.textContent = resultAbs(xp * eased);
    if (k < 1) {
      resultRaf = requestAnimationFrame(paint);
      return;
    }
    resultTiqN.textContent = resultAbs(tiqTarget);
    resultCoinsN.textContent = resultAbs(coins);
    resultXpN.textContent = resultAbs(xp);
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
  const { coins } = resultView;
  const vip = isPremiumUser();

  /* ---- the +50% pill: the bonus the settlement already folded into these rewards ---- */
  const boosted = vip && (coins > 0 || resultView.xp > 0);
  resultVipBoost.hidden = !boosted;
  if (boosted) resultVipBoostT.textContent = t('resultVipBoost');

  /* ---- TIQ recovery: any defeat that cost personal TIQ, friendly rooms included ---- */
  const tier = rewardTier();
  const lost = tier.kind === 'personal' && tier.sign === '-';
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
  /* An active VIP shields the stake with no video: the same shield key reads AD-FREE, and the
     quota beside it is the 4/4 daily budget. A free seat keeps the rewarded-ad RECOVER face. */
  const recoverOpen = vip && !claimed && left > 0;
  recoverBtn.classList.toggle('is-vip', recoverOpen);
  recoverLabel.textContent = claimed
    ? t('adRecoverProtected')
    : left > 0 ? t(recoverOpen ? 'adRecoverCtaVip' : 'adRecoverCta') : t(limit > 3 ? 'adRecoverLimitVip' : 'adRecoverLimit');
  recoverQuota.textContent = `${left}/${limit}`;
  recoverQuota.hidden = claimed || left <= 0;
  if (recoverOpen) recoverBtn.setAttribute('aria-label', t('adRecoverVipAria'));
  else recoverBtn.removeAttribute('aria-label');

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
  /* Obsidian VIP doubles the coins instantly: a lightning key with an ad-free micro-line, never
     the video play triangle. A referral quest still watches its sponsor ad, so it keeps the play face. */
  const vipDouble = vip && !quest;
  const doubleOpen = vipDouble && !paid && !pending;
  doubleBtn.classList.toggle('is-vip', doubleOpen);
  doubleSub.hidden = !doubleOpen;
  if (doubleOpen) doubleSub.textContent = t('adDoubleSubVip');
  doubleIco?.setAttribute('href', vipDouble ? '#i-bolt' : '#i-play');
  doubleLabel.textContent = pending ? t('quest_sync_retry')
    : paid ? t(quest && resultView.questVerified ? 'quest_verified' : 'adDoubleClaimed')
    : quest ? t(user.matchesCount >= REFERRAL_CONFIG.QUEST_MIN_MATCHES - 1
      && user.hardWins >= REFERRAL_CONFIG.QUEST_MIN_HARD_WINS - 1
      ? 'quest_ad_button_final' : 'quest_ad_button_standard')
    : doubleOpen ? t('adDoubleCtaVip')
    : t('adDoubleCta');
  if (doubleOpen) doubleBtn.setAttribute('aria-label', t('adDoubleVipAria'));
  else doubleBtn.removeAttribute('aria-label');
  /* the consolation tint belongs to the reward, never to the key that doubles it */
  resultCoinChip.classList.toggle('is-doubled', coins > 0);
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
  adSkipLabel.textContent = t('adSkipOpt');
  /* The opt-out belongs to the 2x sheet only: a stake recovery keeps its single warning. */
  if (adSkipOpt) adSkipOpt.hidden = tiq;
  adConfirmIco?.setAttribute('href', tiq ? '#i-shield' : '#i-play');
}

/**
 * The consent card IS the in-app rewarded-ad modal: the scrim and the visible card are shown in
 * one synchronous frame, so a dimmed screen can never appear on its own while an ad provider is
 * being waited on. On mobile the WebView must render the card body within this window — the same
 * 1200ms budget the ad module gives the SDK — or the watchdog below forces it visible.
 */
const AD_MODAL_FALLBACK_MS = 1200;
let adConfirmWatchdog = 0;
/** Set from consent acceptance until the ad's answer lands: the modal is never dismissed mid-claim. */
let adClaimInFlight = false;

const mobileViewport = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 480px)').matches;

/**
 * Mobile fallback. A WebView can paint the scrim but leave the sheet transparent or clipped off a
 * `dvh` viewport — the player sees a black screen with a spinning chip. After 1200ms we inspect
 * the rendered box; if it never materialised we add `.is-fallback` (CSS pins the card visible,
 * centred and scrollable) and hand the chip's spinner back so nothing keeps turning in the dark.
 */
function guardAdConfirmVisible(onStalled?: () => void): void {
  window.clearTimeout(adConfirmWatchdog);
  if (!mobileViewport()) return;
  adConfirmWatchdog = window.setTimeout(() => {
    if (!adConfirmResolve || adConfirm.hidden) return;
    const box = adConfirmSheet?.getBoundingClientRect();
    const opacity = adConfirmSheet ? Number(window.getComputedStyle(adConfirmSheet).opacity) : 0;
    const visible = !!adConfirmSheet && !!box
      && box.width > 0 && box.height > 0
      && box.bottom > 0 && box.top < window.innerHeight
      && opacity > 0.05;
    if (visible) return;
    adConfirm.classList.add('is-fallback');
    onStalled?.();
  }, AD_MODAL_FALLBACK_MS);
}

function askAdConfirm(kind: AdConfirmKind, onStalled?: () => void): Promise<boolean> {
  if (adConfirmResolve || !adConfirm.hidden) return Promise.resolve(false);
  adConfirmKind = kind;
  paintAdConfirmCopy();
  /* Every open starts from the saved choice — never from the previous modal's tick. */
  adSkipCheck.checked = skip2xConfirm();
  hideAdToast();
  adConfirmOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  /* atomic: the scrim and the card become visible in the same frame, before any SDK is touched */
  adConfirm.classList.remove('is-fallback');
  adConfirm.hidden = false;
  void adConfirm.offsetWidth;                 // lay the sheet out at its closed position first
  adConfirm.classList.add('open');
  /* the card behind the scrim is not a tab stop while the consent sheet is the only answer */
  resultCard.toggleAttribute('inert', true);
  try { adConfirmWatch.focus({ preventScroll: true }); } catch { /* no focus in headless */ }
  guardAdConfirmVisible(onStalled);
  return new Promise<boolean>((resolve) => { adConfirmResolve = resolve; });
}

function closeAdConfirm(accepted: boolean): void {
  /* always retire the watchdog and the forced-visible state, even on a redundant close */
  window.clearTimeout(adConfirmWatchdog);
  adConfirm.classList.remove('is-fallback');
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
  if (adClaimInFlight) return;                // never dismiss the sheet mid-claim
  const target = event.target as HTMLElement | null;
  if (!target?.closest('[data-ad-confirm-cancel]')) return;
  impact('light');
  closeAdConfirm(false);
});
adConfirmWatch.addEventListener('click', () => {
  impact('light');
  /* The opt-out is saved only by committing to a video. CANCEL, the scrim and Escape all take
     the plain close path, so declining an ad never silently disables future confirmations. */
  if (adConfirmKind === 'coins' && adSkipCheck.checked) setSkip2xConfirm(true);
  closeAdConfirm(true);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !adConfirmResolve || adClaimInFlight) return;
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
 * One claim count-up: `paint` receives the eased fraction, so the doubled coin total lands on the
 * same clock the settlement used. Reduced motion lands on the final value in the same frame.
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

/** The shield lands: the ranked card turns emerald, its value settles on 0 and the key reads RECOVERED. */
function animateTiqRestore(): void {
  paintResultRewards();
  paintRewardButtons();
  restartClass(resultTiqChip, 'is-restoring');
  resultLater(() => resultTiqChip.classList.remove('is-restoring'), motionReduced() ? 0 : 700);
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

  /* Obsidian VIP shields the stake with no video and no consent sheet: the refund lands on the tap,
     spends one of the day's 4 recoveries, and the quota beside the key counts down (4/4 -> 3/4). */
  if (isPremiumUser()) {
    stopDefeat();
    earnTiq(view.stake);
    recordTiqRecovery();
    markClaimedInMatch('recover_tiq');
    paintSeatIdentity();
    animateTiqRestore();
    showAdToast(t('ad_success_tiq_saved'), 'success');
    notify('success');
    return;
  }

  if (!(await askAdConfirm('tiq', () => setChipBusy(recoverBtn, recoverSpin, false)))) return;
  /* the sheet can outlive the card: re-check the settlement before a fullscreen video opens */
  if (resultView !== view || !overlayOpen) return;
  if (recoverBusy || doubleBusy || hasClaimedInMatch('recover_tiq')) return;
  if (getRemainingTiqRecoveries() <= 0) return;

  adClaimInFlight = true;
  recoverBusy = true;
  setChipBusy(recoverBtn, recoverSpin, true);
  /* the defeat fanfare does not play under a rewarded video: stop it with the rest of the audio */
  stopDefeat();
  holdAudio();                              // the race goes quiet under the video
  const outcome = await playRewardedAd('recover_tiq', {
    /* a player who left the result while the tag was still loading gets no video over the menu */
    stillWanted: () => overlayOpen && resultView === view,
  }).finally(() => { releaseAudio(); adClaimInFlight = false; });
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
  animateTiqRestore();
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
      if (isPremiumUser() && !quest) {
        /* Obsidian VIP: the doubled coins land on the tap — no consent sheet, no rewarded video. */
        stopDefeat();
        earnCoins(view.coins);
        markClaimedInMatch('double_coins');
        animateCoinTotal(view.coins);
        view.questAdCompleted = false;
      } else {
        /* "Watch directly" fast path: the sheet never opens, while the 2x chip's busy spinner,
           the still-wanted guard and the one-ad-at-a-time mutex below all stay in force. */
        if (!skip2xConfirm()
          && !(await askAdConfirm('coins', () => setChipBusy(doubleBtn, doubleSpin, false)))) return;
        if (resultView !== view || !overlayOpen) return;
        stopDefeat();
        holdAudio();
        adClaimInFlight = true;
        const outcome = await playRewardedAd('double_coins', {
          stillWanted: () => overlayOpen && resultView === view,
        }).finally(() => { releaseAudio(); adClaimInFlight = false; });
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
/**
 * Pay the channel for the match that just settled — and only when a person was on the far side.
 *
 * **Channel TIQ is earned in Play with Friends, nowhere else.** A real multiplayer room pays the
 * win bonus (`+25 TIQ`) or the participation credit (`+5 TIQ`); a bot board, a practice race, a
 * tutorial and a solo duel all pay the channel exactly nothing. A machine that cannot lose is not
 * an opponent, and a channel must never be lifted by farming one — which is why the gate is the
 * board's own reading of who was in the room (`friendsMatch()` for the room, `bot` for the seats)
 * rather than the queue the player happened to come in through.
 *
 * The local ledger moves on this frame, so the hub the player returns to already shows the new
 * total; the registry call behind it is what makes the ladder shared.
 */
function settleWarMatch(won: boolean, bot = false): void {
  if (warPaid) return;
  /* No room, or a room the machine filled: the channel is owed nothing. */
  if (!friendsMatch() || bot) return;
  const channel = getMySquad();
  if (!channel) return;
  warPaid = true;
  const epoch = ++warEpoch;
  const gain = won ? WAR_WIN : WAR_LOSS;
  const name = channel.name || channel.handle;
  /* `awardWarPoints` credits the local roster synchronously, so the channel's new place is
     readable on this frame; the registry answer only refines the rank a beat later. */
  const pending = awardWarPoints(won);
  const live = getMySquad();
  const rank = Math.max(1, live?.rank ?? channel.rank ?? 1);
  paintWarBadge(gain, rank, name);
  warBadge.hidden = false;
  void pending.then((standing) => {
    if (!standing || epoch !== warEpoch) return;
    paintWarBadge(gain, standing.rank, name);
    showRoyalToast(
      t('cwAwardTitle'),
      t(won ? 'cwAwardWinBody' : 'cwAwardLossBody')
        .replace('{channel}', name)
        .replace('{n}', String(gain))
        .replace('{rank}', String(standing.rank)),
      'i-swords',
    );
  });
}

function showOverlay() {
  if (overlayOpen) return;
  overlayOpen = true;
  /* The simulated audience belongs to the board, not to the result capsule. */
  closeCrowd();
  /* THE SETTLEMENT TAKES THE SOUND. The bed ducks and parks here — before the fanfare below is
     asked for — so the victory or the defeat voice is heard alone. It stays parked for as long as
     this capsule is up: `restart()`, `quitToMenu()` and the result's own keys are the only doors
     that bring it back. */
  setMusicMatchOver(true);
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
  adClaimInFlight = false;
  setChipBusy(recoverBtn, recoverSpin, false);
  setChipBusy(doubleBtn, doubleSpin, false);
  resultTiqChip.classList.remove('is-restored', 'is-loss', 'is-restoring');
  closeAdConfirm(false);
  hideAdToast();
  /* Last match's channel badge is not this match's news. It is cleared here, once, so a bot race
     that follows a friends win cannot inherit the +TIQ line the channel earned an hour ago. */
  warBadge.hidden = true;
  warEpoch += 1;
  const won = localWon();
  /* Friends & Rivals: fold this board's people into the persistent head-to-head roster before
     the board is reset. Bot seats, a struck chair and a 2v2 partner never reach the store. */
  recordFriendsMatch(settledOpponents(won));
  /* The 7-Day Challenge: a Hard AI win files its ticket report; every settle refreshes the card. */
  settleChallengeBoard(won);
  /* A rival who walked out mid-race leaves a machine in the chair. A duel whose only opponent is
     gone has nobody to answer, so its capsule opens dead. A party still has people at the table
     while ANY other seat is held by a person, so it stays alive; the server's rematch consensus
     (not the old single-rival index, which is 0/1 only) decides when that is no longer true. */
  const goneSides = active && 'goneSides' in active ? active.goneSides() : [];
  const otherSeats = roster().filter((s) => s !== localSide);
  if (otherSeats.length && otherSeats.every((s) => goneSides.includes(s))) resultLocked = true;
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
  const ranked = rankedPvp();
  const settled = mine
    ? recordGame({
      /* the three inputs the mode sheet quoted: level, seat count and reward family. The
         settlement's payout/XP doors pass these straight into `computeMatchRewards()`. */
      difficulty, won, mode: boardMode, defenseHeld,
      rewardMode: matchRewardMode ?? undefined,
      ranked,
      /* the race ended without a finish line: a ranked run never survives a void board */
      forfeit: forfeit !== null,
      seats: sizes.length,
    }, runtime.coinMult, isPremiumUser())
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
  void loadAdmin().then((m) => m.recordRace(earned));  // the Stats tab counts the day's duels
  /* FIRST-DUEL WELCOME CUSHION. The debut is the likeliest churn moment — and a new invitee
     usually loses to the experienced friend who sent the link — so the +200 lands on a defeat as
     surely as on a win. `claimFirstDuelBonus()` stamps the flag and credits the wallet in ONE
     flush, so a reload or a second result can never mint it twice. It is deliberately OUTSIDE
     `earned`/`resultView`: the double-coins chip must still multiply only the race payout. */
  const welcomeBonus = claimFirstDuelBonus();
  bonusBadge.hidden = welcomeBonus <= 0;
  const afterTally = ladderTally();
  let afterTiq = tiqFrom(afterTally.wins, afterTally.games, profile.tiqBonus);
  /* THE MATCH STAKE. A race a forfeit decided settles at exactly +15 TIQ, the number the leave
     sheet quoted. The ladder may have moved the same save a little on its own (the race counted, a
     win paid), so the stake is applied as the DIFFERENCE: the reading lands on the verdict, never
     on the sum of two systems. A bot board is TIQ-neutral by rule and never reaches this. */
  /* The authoritative board is the last word: a struck seat in the state IS the forfeit, even when
     the capsule opened off the snapshot a frame before the broadcast landed. */
  const forfeited = forfeitMatch || (state.left?.length ?? 0) > 0;
  const stakeTiq = settled.bot || !mine || !won || !forfeited ? 0 : FORFEIT_TIQ;
  forfeitMatch = false;
  if (stakeTiq > 0) afterTiq = Math.max(0, afterTiq + applyTiqDelta(stakeTiq - (afterTiq - beforeTiq)));
  /* The channel's own ledger moves on the same beat as the player's: an enrolled fighter pays
     their channel on every settled race, whether the far side held a person or the machine. */
  if (mine) settleWarMatch(won, settled.bot);
  /* the HUD's XP pill reads the save, so paint it on the same beat the settlement moves it */
  paintSeatIdentity();
  /* The ladder's own gain on a win, and the crimson stake the defeat asks for. */
  /* The referral ledger's own report: the server-issued receipt carries this board's mode and
     difficulty, and the room dedupes by that matchId. A tutorial board has no receipt, so this is
     a no-op there. It runs before the player can tap the quest chip, which only re-verifies. */
  void questMatch().then((matchId) => (matchId ? verifyReferralQuestMatch(matchId, won) : null));
  resultView = {
    won,
    coins: earned,
    xp: settled.xp,
    bot: settled.bot,
    /* Every board with a person on the far side prints its OWN TIQ — a friendly room included.
       A win shows the gain the ladder paid; a defeat wears the stake and opens the recovery
       shield. Only a bot board is TIQ-neutral by rule, and a seat the machine held pays nothing. */
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
  /* One quiet line under the header when a forfeit handed this victory over, and never a stale one
     from last match's settlement. */
  resultLeft.hidden = true;
  if (won && forfeited) paintResultLeft(forfeitedSeatName());
  resultTiqN.textContent = '0';
  resultCoinsN.textContent = '0';
  resultXpN.textContent = '0';
  overlay.hidden = false;
  /* The card is one reused object: a previous scroll must not open this result below its hero. */
  resultCard.scrollTop = 0;
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
  /* A board the machine held has nobody on the far side to talk to: the reaction tray would only
     eat the capsule's height. Real human and friends boards keep it. Set after `open`, which
     un-hides the dock itself. */
  $<HTMLElement>('result-banter').hidden = settled.bot;
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
  /* A 2v2 shatters the losing SIDE only: the winner's partner ran the same race and is not a rival. */
  const champions = new Set(sideOf(state, winner));
  const losers = state.balls
    .filter((b) => !champions.has(b.team) && (!b.isCheckmated || justSealed(b)))
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
  if (tutorialActive || tutorialStandalone || firstRunBoot) return;
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
  setHints(dotsFor(mode()));
  mineHints = live && mineArmed ? mineCells(state, localSide) : [];
  /* the board-placement mine step offers exactly ONE square — the rival's forced detour — so the
     placement band reads as a single glowing target rather than a board full of options */
  if (tutorialActive && stage === 'placeMine') {
    const target = tutorialMineTarget();
    mineHints = target ? [target.cell] : [];
  }
  /* an armed cell that is no longer placeable — the turn moved on, or a ball rolled over it */
  if (mineGhost && !mineHints.some((h) => sameCell(h, mineGhost))) mineGhost = null;
  armCapsules();
  /* the pawns moved: the event callouts' slots are resolved against them, not against pixels */
  syncPieces();
  /* the rival's dots tick for a bot's think time and for a person's just the same */
  const thinking = opponentThinking(state.turn);
  /* the dots are ONE element, so they are homed on the seat that is thinking: the card that wears
     them names the same seat the board's pips float over, in a duel and in a party alike */
  if (dotsSeat !== (thinking ? state.turn : null)) homeThinkingDots(thinking ? state.turn : null);

  setClass(dots, 'on', thinking);

  setAttr(mineBtn, 'aria-pressed', String(mineArmed));
  /* Step 7 teaches the HUD arm key itself: the Mine button is live ONLY on that stage, so tapping it
     runs the real armMine() toggle. Every other lesson stage (and a spent/foreign turn) keeps it
     inert — in particular step 8 locks mine mode on so a stray tap can never toggle it back off. */
  const canArmInLesson = stage === 'selectMine';
  setDisabled(mineBtn, (tutorialActive && !canArmInLesson) || !live || minesLeft(state, localSide) <= 0);
  setMineCount(minesLeft(state, localSide));

  /* whose turn it is rides on the chips now: a clay glow, a lift, and the countdown ring */
  const seat = state.winner ?? state.turn;
  for (const p of roster()) {
    const gone = isLeft(state, p);
    setClass(chips[p], 'active', !gone && state.winner === null && state.turn === p && !paused);
    setClass(chips[p], 'thinking', opponentThinking(p));
    /* a checkmated seat is off the board: its strip reads as struck, and it never wears the turn */
    setClass(chips[p], 'is-out', isEliminated(state, p));
    /* a seat whose player disconnected is struck for good: ash, no timer, no dots, a LEFT badge */
    setClass(chips[p], 'is-left', gone);
    paintSeatLeft(p, gone);
    setWalls(p, wallsRemaining(state, p));
    if (p !== localSide) setFog(p);
  }
  paintLeftSeats();
  /* the flags and the XP pills ride along: both are diffed, so this is a comparison per seat */
  paintSeatIdentity();
  const spoken = state.winner !== null ? (localWon() ? 'You win' : `${TEAM_NAME[seat]} wins`)
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
    /* The tutorial match is settled: the rival is an ordinary opponent again, the callout is gone
       and the post-match tray may speak. */
    if (tutorialClimax) endTutorialMatch();
    /* A settled board has no live opponent to reconnect: the pill would be a promise with no
       match left to keep it. */
    hidePeerPill();
    /* The deciding trap's banner is NOT stale news: it names the seat the final move took out, and
       a party still has to read who fell. Only a board with no verdict left to give takes the pill
       down — otherwise the queue keeps its own clock and steps through every seat it holds. */
    if (!cmBannerUp && !cmBannerQueue.length) hideCheckmateBanner();
    armGoalBeat();
  }
  /* a hint is a repaint, not a state machine: it never changes `state`, the mode or any input */
  maybeMicroCoach();
}

async function runOpponent() {
  if (state.winner !== null || !wantsOpponent() || tutorialActive) return;
  const token = ++gen;
  if (token !== gen) return;
  if (paused) await new Promise<void>((res) => waiting.push(res));   // parked until Resume
  if (token !== gen) return;
  let a: Action | null;
  if (tutorialClimax) {
    /* THE TUTORIAL CLIMAX: the brain is stood down for a handicapped step — no walls, no mines,
       no row 0 — so the sprint the lesson just handed over cannot be lost. */
    await new Promise<void>((res) => window.setTimeout(res, botThinkMs(difficulty)));
    if (token !== gen) return;
    a = tutorialClimaxAction();
  } else {
    /* The brain reasons on the fog it has always been fed; the debut gates read the FULL board. */
    a = await opponent.think(fogOfWar(state, state.turn), state, true);
  }
  if (token !== gen) return;
  /* ULTIMATE FALLBACK: no safe, non-winning action is left for the rival. Award the resignation
     instead of letting it play a move that would end the race against the player. */
  if (a === null) { concedeOnboarding(); return; }
  if (play(a)) return;
  /* On the debut board a rejected action is already a deadlock: the gates validated it on this
     exact state, so a refusal means the turn cannot be spent safely. Do not fall through to a raw
     step that could cross FINISH — concede instead. */
  if (onboardingActive()) { concedeOnboarding(); return; }
  /* the climax may never fall through to a raw step either: its first legal step could be row 0 */
  if (tutorialClimax) { play({ kind: 'pass' }); return; }
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
 * The crowd's two-camp read of the board: camp 0 is seat 0's side, camp 1 is everyone else. The
 * nearer pawn to FINISH (row 0) leads; a level board has no leader and the simulation abstains.
 * This is decoration, never an input: nothing here writes `state` or is read by the rules.
 */
function crowdLeader(): 0 | 1 | null {
  if (state.teams.length < 2) return null;
  const home = new Set(sideOf(state, 0));
  let a = Infinity;
  let b = Infinity;
  for (const ball of state.balls) {
    if (ball.isCheckmated) continue;
    if (home.has(ball.team)) {
      if (ball.pos.r < a) a = ball.pos.r;
    } else if (ball.pos.r < b) b = ball.pos.r;
  }
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
  return a < b ? 0 : 1;
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
  if (!remote && (onboardingActive() || tutorialClimax) && !tutorialActive) {
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
    /* NO TOAST. A detonation speaks through its flash, the board's jolt and the bang — never
       through a dark banner laid over the pawn it just threw. */
  } else if (blast) {
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
    if (trap.teams.length) {
      showCheckmateSplash(trap.teams);
      /* A PARTY match does not end on a trap: the seat is out, the race plays on, and the top
         banner names the seat and the reason. A duel is already decided by the splash and the
         result card, so it never raises one. */
      if (state.teams.length > 2) {
        for (const seat of trap.teams) showCheckmateBanner(seatFullName(seat));
      }
    } else if (trap.cells.length) showNote(t('checkmatePawnNote'), false, 2800);
  }
  ui();
  startClock();          // the turn has moved on: the next seat gets its own allowance
  /* SIMULATED CROWD (cosmetic). Runs after the board has committed, so the leader it reads is the
     board the players are looking at. Purely atmospheric: one pill, one rail, one reaction toast;
     it never changes a rule, a coin, a TIQ figure or a match result. */
  if (committed) {
    const leader = crowdLeader();
    if (duel || blast || combo) onCrowdEvent('mine', leader);
    else if (a.kind === 'wall') onCrowdEvent('wall', leader);
    else if (a.kind === 'move' && landed !== null && landed.r <= 2 && (from === null || from.r > 2)) {
      onCrowdEvent('near_finish', leader);
    }
    onCrowdEvent('turn', leader);
  }
  /* ULTIMATE FALLBACK, player side: if the debut seat has somehow boxed itself in (no route to
     FINISH, eliminated, or no legal step on its own turn), the rival resigns immediately rather
     than the board grinding to a halt with no winner. */
  if ((onboardingActive() || tutorialClimax) && !tutorialActive && state.winner === null
    && playerIsStuck(state, localSide)) {
    concedeOnboarding();
    return true;
  }
  if (state.winner !== null) notify(localWon() ? 'success' : 'error');
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
  return onboardingActive() || tutorialClimax ? base * ONBOARDING_TURN_GRACE : base;
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
  const auto = onboardingActive() || tutorialClimax
    ? (bestSafeStep(state, localSide) ?? getAutoMove(state, state.turn))
    : getAutoMove(state, state.turn);
  play(auto);
  /* after play(), which clears the toast itself to make room for the next prompt */
  showNote(onboardingActive() || tutorialClimax ? 'Extra time — auto-move' : 'Auto-move', false, 1800, true);
}

/**
 * The receipt metadata for the board `restart()` is about to launch. A live socket is an online
 * duel, a room holding another person is a Play with Friends match, and everything else is the
 * machine at the drawer's chosen level. `format` is what keeps a 4-seat party from ever reading as
 * a 1v1 Hard AI win. Exported only through the quest receipt; nothing here awards anything.
 */
function referralQuestSetup(): ReferralQuestMatchSetup {
  const format: ReferralQuestMatchSetup['format'] =
    sizes.length === 2 && sizes.every((n) => n === 1) ? '1v1' : 'party';
  if (active) return { mode: 'online', difficulty: 'normal', format };
  if (room && humansIn(room) > 1) return { mode: 'friends', difficulty: 'normal', format };
  return { mode: 'vs_bot', difficulty, format };
}

function restart() {
  /* Replaying a war board is another war match: the channel is owed its points again. */
  warPaid = false;
  warEpoch += 1;
  /* every new board is a new match: the last result's celebration (or its defeat sting) cannot
     survive into it */
  stopVictoryFanfare();
  stopDefeat();
  cancelTutorial();
  endTutorialMatch();
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
  warBadge.hidden = true;
  /* A lesson is not a match; a real board starts a fresh telemetry clock even when the player
     replayed it from the pause sheet. */
  if (!tutorialStandalone) {
    beginMatch({ mode: matchMode(), players: sizes.length, matchId: active?.matchId });
  }
  /* The 7-Day Challenge's Hard AI track starts its clock — and mints the room's one-shot ticket —
     with the board itself, so the 45-second floor is measured from a real start. */
  if (hardBotDuel) beginChallengeBotBoard();
  gen++;
  const questGeneration = ++questEpoch;
  /* Every real board files one receipt, whatever the mode: online 1v1, a Play with Friends room,
     or a bot race on any difficulty. A tutorial lesson and the granted debut board are never
     counted matches, and a local solo sandbox has no seat to report. */
  questMatch = !tutorialStandalone && !onboardingConsumesDebut
    ? createReferralQuestMatch(() => questGeneration === questEpoch, referralQuestSetup())
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
  state = newGame(sizes, seatTeamMap());
  /* A fresh audience for a fresh board (14–44 simulated fans, organically split). Cosmetic only:
     `showOverlay()` and `quitToMenu()` tear it down when this race leaves the screen. The audience
     cheers for the SEATS at this board: a 1v1 passes this player and the rival, a 2v2 folds each
     pair into one duo label, and a missing name only falls back inside the crowd module. */
  initMatchCrowd({
    teamMode: sizes.length === 2 && sizes[0] === 2 && sizes[1] === 2,
    p1Name: sideOf(state, localSide)
      .map((seat) => (seat === localSide ? localPlayerName() : seatFullName(seat)))
      .filter(Boolean)
      .join(' & '),
    p2Name: sideOf(state, rivalSide())
      .map((seat) => (seat === localSide ? localPlayerName() : seatFullName(seat)))
      .filter(Boolean)
      .join(' & '),
  });
  /* This screen's colours are client-side: the local seat wears the save's red/blue choice and the
     rival wears the other one. Set before the first paint of the new board. */
  paintRendererPerspective(true);
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
  rematchState = null;
  hideRematchChallenge();
  closeVipSheet();
  banter.close();
  overlayOpen = false;
  overlay.hidden = true;
  /* The settlement is behind us and a board is being dealt: the bed is wanted again, but ONLY if
     this board is already the visible one. Play again and a room's rematch restart in place on a
     live board, so the strict gate opens here; a fresh `startGame()` still sits behind the menu,
     the lobby or the online queue, and `reveal()` is what opens it when the race is playable.
     `setMusicMatchOver` is a no-op when nothing was ducked. */
  setMusicInMatch(router.current === 'game');
  setMusicMatchOver(false);
  overlay.classList.remove('win', 'lose', 'is-party');
  menuBtn.disabled = false;
  clearNote();
  /* A fresh board has no verdict to announce: the last race's checkmate banner goes with it. */
  hideCheckmateBanner();
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
function applyRoomSnapshot(next: GameState, turnLeftMs: number, presence?: Array<{ seat: number; connected: boolean }>): void {
  if (!active) return;
  /* The snapshot carries the room's own read of who is seated: any rival it proves connected cannot
     still be "reconnecting", so the pill comes down on the same beat the board lands. */
  if (presence) for (const p of presence) if (p.connected) notePeerActive(p.seat);
  const dimsChanged = next.cols !== state.cols || next.rows !== state.rows;
  /* The wall budget scales with contenders, not only with board size: a 3P and a 4P field share
     the same 10x14 grid but hand out 6 and 5 walls. Recompute it on every snapshot so a seat-count
     change that does not move the dimensions still leaves the "Walls left: N of M" label truthful. */
  wallsEach = wallBudget(next.balls.length);
  /* The seats this client had already seen go out: a trap that closed while the socket was down
     shows up in the snapshot alone, and the banner says so when the board lands. */
  const knownOut = state.eliminated ?? [];
  state = next;
  selected = null;
  autoPicked = null;
  mineGhost = null;
  setMode(BOARD_IDLE);
  if (dimsChanged) {
    renderer.setBoard(state.cols, state.rows);
    fitBoard(state.cols, state.rows);
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
  /* The verdict the snapshot brought with it: a seat the board found already eliminated. The
     banner names it, exactly as it would have named it live. */
  if (state.teams.length > 2) {
    for (const seat of state.eliminated ?? []) {
      if (knownOut.includes(seat)) continue;
      showCheckmateBanner(seatFullName(seat));
    }
  }
  syncLoop();
}

/**
 * A chair was struck from the race: its player disconnected and the machine's two substitute turns
 * ran out. `markLeft` is the same pure call the worker made, so this replica seals the same pawns,
 * skips the same hand-offs and reaches the same verdict without waiting for a snapshot.
 */
function strikeSeat(side: number, name: string): void {
  const seat = side as Player;
  if (!state.teams[seat]) return;
  state = markLeft(state, seat);
  showSeatLeftPill(seat, name);
  ui();
  syncLoop();
}

/**
 * A rival confirmed their own exit. The worker already struck the chair, charged the stake and —
 * when that left one contender standing — settled the race. This screen paints the same banner,
 * marks the same pawn inert, and opens the victory capsule on the same beat; the +15 stake is
 * applied by the settlement itself, exactly as the sheet promises.
 */
function opponentForfeited(info: { side: number; name: string; deltas: Record<string, number>; winner: number | null }): void {
  const side = info.side as Player;
  const name = info.name || seatFullName(side);
  forfeitMatch = true;
  /* The authoritative snapshot may already carry the struck chair, so the banner is raised here
     either way — the verdict is the news, not the repaint. */
  if (state.teams[side] && !isLeft(state, side)) strikeSeat(side, name);
  else showSeatLeftPill(side, name);
  if (info.winner === null || state.winner !== null) return;
  /* A 2v2 is won by a TEAM: the room's verdict names a seat on the winning colour, and this screen
     rides it when the board's own side map puts both chairs there. Every other format names a seat. */
  const won = sideOf(state, info.winner as Player).includes(localSide);
  if (!won) return;                           // the local seat is out: the board's own verdict lands
  /* The chair that left took the rematch with it. */
  resultLocked = true;
  stopClock();
  state = { ...state, winner: localSide };
  ui();
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
  if (state.seatTeam) {
    if (sideOf(state, localSide).includes(p)) return chosen === 'red' ? 'gold' : 'blue';
    return p === rivalSide() ? (chosen === 'red' ? 'blue' : 'red') : 'amethyst';
  }
  if (p === rivalSide()) return chosen === 'red' ? 'blue' : 'red';
  const extras = [0, 1, 2, 3].filter((x) => x !== localSide && x !== rivalSide());
  return extras.indexOf(p) === 0 ? 'gold' : 'amethyst';
}

type TeamRelation = 'you' | 'ally' | 'enemy';
const TEAM_RELATION_LABEL: Record<LangCode, Record<TeamRelation, string>> = {
  en: { you: 'YOU', ally: 'ALLY', enemy: 'ENEMY' },
  fa: { you: 'تو', ally: 'یار', enemy: 'حریف' },
  ru: { you: 'ТЫ', ally: 'СОЮЗНИК', enemy: 'ВРАГ' },
  ar: { you: 'أنت', ally: 'حليف', enemy: 'خصم' },
  es: { you: 'TÚ', ally: 'ALIADO', enemy: 'RIVAL' },
};
const teamBadges: (HTMLSpanElement | null)[] = [null, null, null, null];

/** One persistent, localized relation pill per chip; only team races reveal them. */
function paintTeamBadges(): void {
  const teamed = !!state.seatTeam;
  setAttr(chipsEl, 'data-team', String(teamed));
  const allies = teamed ? sideOf(state, localSide) : [];
  for (let p = 0; p < chips.length; p++) {
    const chip = chips[p];
    chip.classList.add('seat-chip');
    let badge = teamBadges[p];
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'team-badge';
      badge.setAttribute('aria-live', 'off');
      chip.querySelector<HTMLElement>('.res')?.append(badge);
      teamBadges[p] = badge;
    }
    badge.hidden = !teamed || p >= state.teams.length;
    if (!teamed) { delete chip.dataset.relation; continue; }
    const relation: TeamRelation = p === localSide ? 'you' : allies.includes(p) ? 'ally' : 'enemy';
    setAttr(chip, 'data-relation', relation);
    setAttr(badge, 'data-relation', relation);
    setText(badge, TEAM_RELATION_LABEL[lang][relation]);
  }
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
  paintTeamBadges();
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
  const ramps = perspectiveRamps(localSide, rivalSide(), pieceColor(), state.seatTeam, localSide);
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
  overMode.replaceChildren(isoText(toLatinDigits(mode), 'auto'));
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
  /* The dots are homed on whoever is actually thinking (`homeThinkingDots`), so the race starts with
     them parked on the rival's card and the first repaint moves them to the seat that is up. */
  dotsSeat = null;
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
 * The seats the face-off puts on the other side of the crest. Every field here is metadata the
 * room or the matchmaker already holds in memory — a person's real profile or a machine's real
 * difficulty. Nothing is synthesised for the card: a bot is labelled BOT, a missing guild or
 * nation is simply left off, and no name, flag or rating is ever invented.
 */
function clashRivals(): VsRival[] {
  const out: VsRival[] = [];
  if (active) {
    if ('seats' in active) {
      for (const seat of active.seats) {
        if (seat.side === localSide) continue;
        out.push(seat.bot
          ? {
            id: `${active.code}:${seat.side}`,
            isBot: true,
            difficulty: room ? difficultyFor(room, seat.side) : difficulty,
          }
          : {
            id: seat.id, name: seat.name, avatarUrl: seat.avatarUrl,
            nation: seat.nation, guild: seat.guild, tiq: seat.tiq,
          });
      }
    }
    if (!out.length) {
      const o = active.opponent;
      out.push({
        id: o.id, name: o.name, avatarUrl: o.avatarUrl,
        nation: o.nation ?? o.flag ?? null, guild: o.guild, tiq: o.tiq, isBot: o.isBot === true,
      });
    }
    return out;
  }
  if (room) {
    for (let p = 0; p < sizes.length; p++) {
      if (p === localSide) continue;
      const seat = room.seats[p];
      out.push(isAutomated(room, p)
        ? { id: `${room.code}:${p}`, isBot: true, difficulty: difficultyFor(room, p) }
        : {
          id: seat?.id || `seat:${p}`, name: seatName(room, p),
          nation: seat?.nation, guild: seat?.guild, tiq: seat?.tiq,
        });
    }
    return out;
  }
  for (let p = 0; p < sizes.length; p++) {
    if (p === localSide) continue;
    out.push({ id: `bot:${p}`, isBot: true, difficulty });
  }
  return out;
}

/* ---------- the face-off: unskippable, and never ahead of the board ---------- */

/**
 * The longest a face-off will wait for a font or a portrait. A stalled request is not a reason to
 * hold a race: past this the showcase opens on what is already there, and the board's own
 * re-measure at the reveal covers the rest. Deliberately under the crest's own 730 ms run, so a
 * slow load can never turn the pre-match into a two-second wait — and far above the one frame a
 * warm cache actually costs.
 */
const MATCH_READY_CAP_MS = 700;

/**
 * The automated-browser path, mirrored from `vsclash.ts`'s own `bypassed()`.
 *
 * That module answers `onReveal` before it returns when the page is driven by a harness or carries
 * `data-txs-skip`, and `scripts/verify-vs-clash.mjs` measures that hand-off at under 50 ms. A gate
 * in front of the showcase would turn that synchronous start into a promise, so the test is
 * repeated here — the one place that decides whether to wait — rather than exported and shared.
 */
function clashBypassed(): boolean {
  if (typeof navigator !== 'undefined' && navigator.webdriver === true) return true;
  return document.documentElement.hasAttribute('data-txs-skip');
}

/**
 * ONE PORTRAIT, DECODED AND IN THE CACHE. Never rejects and never blocks for longer than the cap:
 * a missing face is a monogram on the card, not a reason to keep a player waiting.
 */
function faceReady(url: string | null | undefined): Promise<void> {
  if (!url) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => { if (done) return; done = true; resolve(); };
    try {
      const img = new Image();
      img.onload = finish;
      img.onerror = finish;
      img.src = url;
    } catch { finish(); }
    window.setTimeout(finish, MATCH_READY_CAP_MS);
  });
}

/**
 * EVERYTHING THE FIRST VISIBLE FRAME OF A RACE DEPENDS ON.
 *
 * `startGame()` has already drawn the board by the time this is asked for: `restart()` builds the
 * grid, every pawn on its spawn tile, the seat names, the chips and the first turn synchronously,
 * so there is no half-built state to wait for. What can still be in flight is the type, the
 * portraits and the first paint — and a font swap after the board is up reflows every chip and
 * re-measures the canvas under the player's first tap.
 *
 * The promise therefore settles on the fonts, on every rival's face, and on two frames (the point
 * at which styles and container queries have landed), each with its own cap. It never rejects and
 * never waits longer than `MATCH_READY_CAP_MS`: readiness is a gate, not a trap.
 */
function matchReady(rivals: readonly VsRival[]): Promise<void> {
  const settled = new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => { if (done) return; done = true; resolve(); };
    try {
      const fonts = document.fonts;
      if (fonts && fonts.ready && typeof fonts.ready.then === 'function') {
        void fonts.ready.then(finish, finish);
      } else finish();
    } catch { finish(); }
    requestAnimationFrame(() => requestAnimationFrame(finish));
    window.setTimeout(finish, MATCH_READY_CAP_MS);
  });
  return Promise.all([settled, ...rivals.map((r) => faceReady(r.avatarUrl))]).then(() => undefined);
}

/**
 * THE FACE-OFF IS A SHOWCASE, NOT A PROMPT. `vsclash.ts` closes on its own timer, on a tap and on
 * a watchdog; the tap is the one that can cut the matchup short, and it is the one this removes.
 *
 * The listener sits on the document in the CAPTURE phase, so it is reached before the overlay's
 * own `pointerdown` and can stop the event there — the showcase never hears the tap, and because
 * the overlay itself still takes the hit, nothing behind it is tapped either. `pointer-events` is
 * deliberately left alone: a dismiss layer that lets taps through would hand them to the menu
 * underneath, which is a worse bug than a skippable crest. The window-level capture listeners are
 * untouched, so the first-gesture audio unlock still lands.
 *
 * Returns the release; the reveal calls it, so the board's first tap is never swallowed.
 */
function holdClash(): () => void {
  const swallow = (event: Event): void => {
    const node = event.target instanceof Element ? event.target : null;
    if (!node || !node.closest('#vs-clash')) return;
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
  };
  const opts: AddEventListenerOptions = { capture: true, passive: false };
  document.addEventListener('pointerdown', swallow, opts);
  document.addEventListener('touchstart', swallow, opts);
  document.addEventListener('mousedown', swallow, opts);
  return () => {
    document.removeEventListener('pointerdown', swallow, opts);
    document.removeEventListener('touchstart', swallow, opts);
    document.removeEventListener('mousedown', swallow, opts);
  };
}

function startGame(setup: StartSetup) {
  /* THE SAME WALL, AT THE SINGLE DOOR. Every board — Play, the Arena queue, a custom room, a
     server push — comes through here, so a second board is never dealt to an unverified player
     even when the tap came from a surface that does not ask the question itself. The first race
     is exempt by the verdict (`0` matches), which is what keeps cold boot uninterrupted. */
  if (channelGateBlocks()) {
    matchmaking.abandon();
    raiseChannelGate();
    return;
  }
  /* The queue's war identity lands on the board it opened, and on no other. */
  warMatch = warPending;
  warPending = false;
  warPaid = false;
  warEpoch += 1;
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
         finish with its own choreography (including the rival steps the lesson scripts), so it
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
      /* A seat that just moved is plainly connected: drop any reconnecting pill naming it. */
      notePeerActive(side);
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
    /* the rival's in-match free text: gold only when the room vouched for their VIP entitlement */
    session.onChat((text, side, vip) => chat.inboundCustom(text, side, vip));
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
      session.onPeerStatus((side, status, graceMs, name) => setPeerStatus(side, status, graceMs, name));
      session.onSeatLeft((side, name) => strikeSeat(side, name));
      /* An explicit forfeit carries the worker's whole verdict, not just the struck chair. */
      session.onForfeit?.((info) => opponentForfeited(info));
      session.onSync((next, turnLeftMs, presence) => applyRoomSnapshot(next, turnLeftMs, presence));
      /* THE CAPSULE'S CONSENSUS. The worker owns the quorum; this screen only paints it and asks
         for a vote when the player taps the teal key. A quorum that lands rebuilds the board this
         socket already holds — never a queue, never a fresh room. */
      session.onRematchState((next) => {
        rematchState = next;
        if (!overlayOpen) return;
        paintRematchUi();
        paintResultLock();
      });
      session.onRematchStart(() => {
        rematchState = null;
        clearResultMotion();
        stopVictoryFanfare();
        stopDefeat();
        /* `restart()` is the board's own fresh draw: it hides the capsule, rebuilds the pawns and
           starts the clock, and the room's `ROOM_SYNC` that followed `REMATCH_START` lands on it
           through `applyRoomSnapshot` to make the two boards identical. */
        restart();
        router.go('game');
      });
      /* A chair already struck before this screen mounted: a reconnect into a race that moved on
         without us. The roster carries the verdict, so the board opens on it instead of catching
         up a frame later. */
      for (const side of session.leftSides()) strikeSeat(side, seatFullName(side));
    }
  }

  /* The face-off owns the reveal, and the reveal is the only thing it owns. Routing is deferred to
     its callback, so the board never ticks behind the crest — `syncLoop()` runs frames and the turn
     clock only while the game screen is up. An automated browser and the lesson both get the
     original synchronous path: the clash answers `onReveal` before it returns. */
  let revealed = false;
  /* The unskippable shield's release, held until the board takes over. */
  let releaseClash: (() => void) | null = null;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    /* First thing, before any routing: the board's own taps must never be swallowed by the
       showcase's shield, and the overlay is already on its way out. */
    if (releaseClash) { releaseClash(); releaseClash = null; }
    /* The face-off is asynchronous: a route event or a late sheet close during the cinematic can
       leave `paused` set. With that flag up `syncLoop()` cancels every frame and the board shows
       a grid with no pawns, so entering a race always clears it. */
    paused = false;
    /* The reveal can be several frames after `restart()`. Re-snap here too, so the first visible
       frame is guaranteed to hold every pawn on its exact spawn tile centre. */
    snapBalls();
    router.go('game');
    /* THE RACE IS PLAYABLE. The face-off is behind the player and the board in front of them, so
       this is the moment the bed is allowed: Solo/Bot, local, 1v1, 3P/4P, 2v2 and a friend duel
       all pass through here, and `quiet` launches (a lesson, a room's own countdown) reach it too.
       The ramp is the module's own 500 ms fade; nothing here touches a frame. */
    setMusicInMatch(true);
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
  const stakes: VsStakes = {
    kind: active ? 'ranked' : room ? 'room' : 'bot',
    seats: sizes.length,
  };
  /**
   * THE GATE. The showcase opens only once the board behind it is genuinely ready, and it then
   * plays its full length unskippable — so the crest can never be cut short and the board can
   * never be entered half-built. Both waits are real work, run together: the chunk (warmed right
   * after the first frame, see the boot's `afterPaint` block) and `matchReady()`.
   *
   * A harness, the `data-txs-skip` path and a lesson with no rivals keep the original synchronous
   * hand-off — `showVsClash` answers `reveal()` before it returns on those, and a promise in front
   * of it would change a 0 ms start into a frame or two of nothing.
   */
  const gated = rivals.length > 0 && !clashBypassed();
  /* Started before the chunk is awaited, so the two waits overlap rather than queue: the crest
     opens on the later of the two, never on their sum. */
  const ready = gated ? matchReady(rivals) : null;
  void import('./vsclash').then(({ showVsClash }) => {
    const open = (): void => {
      releaseClash = holdClash();
      showVsClash(rivals, stakes, reveal);
    };
    if (ready) void ready.then(open, open);
    else open();
  });
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
  /* A resignation is a forfeit on the wire: the survivor's capsule pays the same +15 stake a
     friends room's PLAYER_FORFEITED pays. */
  if (end.win && end.why === 'resign') forfeitMatch = true;
  /* The verdict is this screen's own: a win names this seat, a loss names a chair on the far SIDE.
     `rivalSide()` is the duel's opposite number and can be a PARTNER in a 2v2, so the loser is
     picked off the board's colour plan — a duel and a free-for-all still land on the same seat. */
  const mine = sideOf(state, localSide);
  const far = roster().find((seat) => !mine.includes(seat)) ?? rivalSide();
  state = { ...state, winner: end.win ? localSide : far };
  /* Only a resignation leaves the rival's socket open long enough to taunt. A dropped or
     abandoned connection, or an operator abort, has nobody on the far side of a rematch. */
  if (end.why !== 'resign') resultLocked = true;
  stopClock();
  ui();
  notify(end.win ? 'success' : 'error');
  /* The reason is the player's own language: an operator's close and a lost link are different
     events, and neither may surface a raw wire phrase. */
  showNote(end.win
    ? (end.why === 'resign' ? 'Rival resigned — you win' : 'Rival left — you win')
    : end.why === 'aborted' ? t('roomClosedByServer') : t('connectionLost'),
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
  if ((!onboardingActive() && !tutorialClimax) || state.winner !== null) return;
  /* A lesson card must not sit on top of the result capsule. */
  if (tutorialActive) cancelTutorial();
  stopClock();
  state = { ...state, winner: localSide };
  showNote('Opponent resigned — you win', false, 3200);
  notify('success');
  ui();                  // winner !== null -> armGoalBeat() -> finishSettled() -> showOverlay()
}

/** The rival is gone: raise the badge, dead the taunt keys and lock the rematch in one beat. */
function lockResultForLeft(): void {
  resultLocked = true;
  hideRematchChallenge();
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

/**
 * One dialog, three faces. Staying is always the primary key; a live seat's exit wears crimson.
 * A party exit keeps its chairs on the board and strikes only the leaving pawn; a duel hands the
 * win over at once. The copy says which one this is; the stake is the same 15 either way.
 */
function paintQuit(): void {
  const kind = quitKind();
  const practice = kind === 'practice';
  const party = sizes.length > 2;
  quitTitle.textContent = t(practice ? 'quitPracticeTitle' : 'quitForfeitTitle');
  /* static locale copy only — the stake's own span is what keeps its figure Latin and LTR */
  quitBody.innerHTML = t(practice ? 'quitPracticeBody' : party ? 'quitForfeitPartyBody' : 'quitForfeitBody');
  quitStay.textContent = t(practice ? 'quitPracticeStay' : 'quitForfeitStay');
  quitYes.textContent = t(practice ? 'quitPracticeConfirm' : 'quitForfeitConfirm');
  quitYes.classList.toggle('btn-danger', !practice);
  quitYes.classList.toggle('btn-ghost', practice);
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
  /* The simulated audience does not follow the player home. */
  closeCrowd();
  /* An abandoned board is not a settled match: disarm the assist without spending the flag, so the
     next `startGame()` re-arms it for a debut that has still never been won. */
  deactivateOnboarding();
  cancelTutorial();                 // leaving mid-lesson does not count as having read it
  endTutorialMatch();               // ...and the climax's handicaps and silent chat go with it
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
    hideRematchChallenge();
    banter.close();
    overlayOpen = false;
    overlay.hidden = true;
  }
  /* Menu, the back key, the share door and the pause sheet's quit all land here: whatever the
     settlement ducked, the bed is the menu's again from this beat on — which under the strict
     gate means parked and silent until a race actually begins. The match gate is closed FIRST so
     lifting the settlement duck above cannot fade a bed in over the menu for a quarter second. */
  setMusicInMatch(false);
  setMusicMatchOver(false);
  sheets.close();
  /* Walking out of a live online race is a resignation: the rival takes the win immediately, and
     the socket goes with it — leaving it open would only hold the other player's seat hostage. */
  if (active) {
    /* Only an unsettled board can be forfeited. A race that already reached its verdict was paid
       out by `showOverlay()` above (or by the goal beat), and must not be counted twice. */
    if (state.winner === null) {
      /* The frame goes FIRST: the worker must hear the verdict while the socket is still open, or
         the seat would read as a drop and the room would hold it for the reconnect grace. */
      active.resign();
      /* The forfeit is a defeat on this device's ledger too, not only in the room: the tally, the
         streak and the TIQ the ladder derives from them move exactly as a finished loss would.
         Practice is exempt — `matchMode()` already counts a bot-backfilled room as practice, so
         walking out of one costs no rating and no stake. */
      const mode = matchMode();
      const ranked = rankedPvp();
      if (mode !== 'bot' && (!room || rewardEligible(room, localSide))) {
        const before = myTiq();
        recordGame({ difficulty, won: false, mode, ranked, forfeit: true }, runtime.coinMult, isPremiumUser());
        /* EXACTLY the stake, not the ladder's coincidence: whatever the recorded defeat did to
           this save on its own, the reading lands 15 below where it stood, and never below zero. */
        const stake = Math.min(FORFEIT_TIQ, Math.max(0, before));
        const adjust = (before - stake) - myTiq();
        if (adjust !== 0) applyTiqDelta(adjust);
        forfeitToast = true;
      }
      /* Walking out of a friends race is still a friends race played: the channel keeps its
         participation credit, and never the win bonus. A room the machine filled pays nothing —
         `mode` is this board's own verdict on who was actually in the other seats. */
      settleWarMatch(false, mode === 'bot');
    }
    active.close();
    active = null;
  }
  warMatch = false;
  warPending = false;
  paused = true;
  router.popTo('home');
  /* The verdict follows the player home: one crisp toast naming the stake just paid. */
  if (forfeitToast) {
    forfeitToast = false;
    showMarkupToast(t('forfeitToast'), 'warning');
  }
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

/** The lesson's vocabulary for a hit-test result: every hit is already a whole, committed action. */
function tutorialHitAction(hit: Hit | null): TutorialAction | null {
  if (!hit) return null;
  switch (hit.kind) {
    case 'move': {
      const ball = selected !== null ? ballById(state, selected) : firstBall(state, localSide);
      return ball ? { kind: 'move', ball: ball.id, to: hit.to } : null;
    }
    case 'wall': return { kind: 'wall', spec: hit.spec };
    case 'mine': return { kind: 'mine', cell: hit.cell };
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
 * Raise the REAL floating keys for a staged wall or mine, exactly as a live race does: the wall
 * walks up armed and wears its glass Cancel/Rotate/Confirm toolbar, the mine stages its square and
 * draws the ✓/× disc pair. `syncStage()` publishes the pair's own geometry, so the lesson's ring,
 * ghost hand and input cut-out can land on the very keys the frame paints.
 */
function raiseTutorialPreview(action: TutorialAction): void {
  if (action.kind === 'wall') {
    setMode(previewWall(mode(), { spec: action.spec, ok: true, armed: true, p: localSide }));
  } else if (action.kind === 'mine') {
    mineGhost = action.cell;
    armCapsules();
    invalidate();           // the parked loop must wake to paint the staged pair
  }
}

/** The floating ✓: spend the staged wall or mine through the same door a live race uses. */
function commitTutorialPreview(): void {
  const pending = tutPending;
  if (!pending || (pending.kind !== 'wall' && pending.kind !== 'mine')) {
    tutorial?.nudge();
    return;
  }
  const owner = state.turn;
  tutorial?.previewDone();
  tutPending = null;
  if (pending.kind === 'wall') {
    const wall: Wall = { ...pending.spec, owner };
    if (!wallOk(state, wall) || !play({ kind: 'wall', wall })) { tutorial?.nudge(); return; }
    impact('heavy');
    shake(true);
  } else {
    if (!play({ kind: 'mine', cell: pending.cell })) { tutorial?.nudge(); return; }
    impact('medium');
  }
  tutorial?.notify(pending);
}

/** The floating ✕: clear the staged ghost (and its keys) and point the hand back at the slot. */
function cancelTutorialPreview(): void {
  if (mineArmed) {
    mineGhost = null;
    armCapsules();
    invalidate();
  } else {
    disarmWall();
  }
  tutPending = null;
  tutorial?.previewDone();
  impact('light');
  audio.play('move', { gain: 0.3 });
}

/**
 * The lesson's own tap: hit-test the REAL board, refuse anything but the live target, then perform
 * the real action. There is no proxy button — the spotlight is a hole in the input blocker, so the
 * canvas receives this tap exactly as it would after the lesson. The pawn is already in hand, and a
 * wall or the mine is staged first: that tap raises the SAME floating controls a live race draws —
 * the wall's glass Cancel/Rotate/Confirm toolbar, the mine's ✓/× disc pair — and the ✓ is what
 * commits the action through the same `play()` a real race uses.
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
  /* The floating keys answer first while a preview is up: the ✓ commits the staged action, the ×
     drops it and the lesson points back at the slot — the real double-door of a live match. */
  if (tutorial?.confirming) {
    const hit = at(p);
    if (hit?.kind === 'confirm' || hit?.kind === 'mine-confirm') { commitTutorialPreview(); return; }
    if (hit?.kind === 'cancel') { cancelTutorialPreview(); return; }
    if (hit?.kind === 'rotate') { tutorial?.nudge(); return; }
  }
  let action = tutorialHitAction(at(p));
  /* The groove is a hairline and the detour is one tile: a tap anywhere inside the ring the lesson
     paints counts as a tap on the thing it is pointing at. */
  if (stage === 'rush1' || stage === 'rush2' || stage === 'rush3' || stage === 'sprint') {
    const target = tutorialAdvanceTarget();
    if (target && tutorialSpotHas(target.spot, vx, vy)) {
      action = { kind: 'move', ball: target.ball, to: target.to };
    }
  } else if (stage === 'wall1' || stage === 'wall2' || stage === 'wall3') {
    const target = tutorialWallTarget(stage === 'wall1' ? 1 : stage === 'wall2' ? 2 : 3);
    if (target && tutorialSpotHas(target.spot, vx, vy)) action = { kind: 'wall', spec: target.spec };
  } else if (stage === 'placeMine') {
    const target = tutorialMineTarget();
    if (target && tutorialSpotHas(target.spot, vx, vy)) action = { kind: 'mine', cell: target.cell };
  } else if (stage === 'dodgeLeft1' || stage === 'dodgeLeft2' || stage === 'clearWall' || stage === 'dodgeRight') {
    /* The fixed dodge reads the ring as its input target too: a tap anywhere inside the spotlight
       is the same move the lit tile offers, so the glowing square can never go inert. */
    const target = tutorialDodgeTarget(stage);
    if (target && tutorialSpotHas(target.spot, vx, vy)) {
      action = { kind: 'move', ball: target.ball, to: target.to };
    }
  }
  if (!action || !isTutorialActionAllowed(action)) { tutorial?.nudge(); return; }
  const L = renderer.layout();
  renderer.ripple((p.x - L.ox) / L.cell, (p.y - L.oy) / L.cell, localSide);
  invalidate();           // a queued ripple is a finite transition: wake the parked loop
  /* TAP 1 of a wall or a mine is a PREVIEW, not a commitment: the stage locks on the exact slot the
     finger hit, a tick lands, and the cue asks for the floating ✓. Nothing is spent, no rival
     answers, and the beat cannot be rushed past — the real controls own the board from here. */
  if (tutorial?.preview(action)) {
    tutPending = action;
    raiseTutorialPreview(action);
    return;
  }
  /* Step 9 WALKS THE PAWN. The forward tap runs the real move handler — (2, 8) -> (2, 7) — so the
     player feels their pawn answer immediately after burying the charge; the lesson springs the
     trap one deliberate beat later, from the new row, while the pawn stays right where it landed. */
  if (stage === 'sprint') {
    disarmWall();
    impact('light');
    if (action.kind !== 'move') { tutorial?.nudge(); return; }
    if (!play({ kind: 'move', ball: action.ball, to: action.to })) { tutorial?.nudge(); return; }
    tutorial?.notify(action);
    return;
  }
  switch (action.kind) {
    case 'move':
      disarmWall();
      impact('light');
      if (!play({ kind: 'move', ball: action.ball, to: action.to })) { tutorial?.nudge(); return; }
      break;
    case 'wall': {
      /* The slot itself answered the preview (the ✓ is the taught door; this keeps a tap on the
         staged bar a confirm too). `play()` spends the wall exactly as a live race does. */
      const wall: Wall = { ...action.spec, owner: state.turn };
      tutorial?.previewDone();
      tutPending = null;
      if (!wallOk(state, wall) || !play({ kind: 'wall', wall })) { tutorial?.nudge(); return; }
      impact('heavy');
      shake(true);
      break;
    }
    case 'mine':
      /* The staged square confirmed from under the pair: bury the charge on the forced detour. */
      tutorial?.previewDone();
      tutPending = null;
      if (!play({ kind: 'mine', cell: action.cell })) { tutorial?.nudge(); return; }
      impact('medium');
      break;
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
    /* Step 7 is the one lesson stage where this key is the live target. Gate the tap, run the REAL
       toggle (so the key lights up exactly as it does in a match), then hand the lesson to step 8.
       On every other stage — above all step 8 — the tap is refused, so mine mode cannot be turned
       back off and the placement step can never be skipped. */
    if (tutorialStage() === 'selectMine' && tutorial?.allows({ kind: 'armMine' })) {
      armMine(true);
      tutorial?.notify({ kind: 'armMine' });
    } else {
      tutorial?.nudge();
    }
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

/** STEPS 1-3 and 9 — the single square directly ahead of the player's pawn. */
function tutorialAdvanceTarget(): TutorialTargetMove | null {
  const step = tutorialForwardStep();
  return step
    ? { ball: step.ball.id, to: step.to, spot: { rect: boardRect(step.to.c, step.to.r), radius: 18 } }
    : null;
}

/**
 * STEPS 10-13 — four FIXED squares anchored on the player's pawn at the moment the rival's
 * counter-wall dropped, not the live forward finder. Step 9 walked the pawn onto (2, 7), so the bar
 * sits flush on the edge directly above that square — h(1, 7) shuts the straight step out of (2, 7)
 * with zero gap and meets v(3, 7) as a legal L-corner — and the lesson teaches the way around it,
 * practising BOTH directions: left under the bar to (1, 7), left again to the open edge at (0, 7),
 * forward past the wall's end to (0, 6), then right back into the centre lane at (1, 6). The anchor is read once so the four tiles
 * stay put as the pawn walks them; each is offered only when the rules say the pawn can actually
 * step there, so a replay on a drifted board can never spotlight a dead tile.
 */
function tutorialDodgeTarget(stage: TutorialStage): TutorialTargetMove | null {
  if (state.turn !== localSide || state.winner !== null) return null;
  const ball = firstBall(state, localSide);
  if (!ball) return null;
  const a = tutDodgeAnchor ?? ball.pos;
  const to: Pos | null = stage === 'dodgeLeft1' ? { c: a.c - 1, r: a.r }
    : stage === 'dodgeLeft2' ? { c: a.c - 2, r: a.r }
      : stage === 'clearWall' ? { c: a.c - 2, r: a.r - 1 }
        : stage === 'dodgeRight' ? { c: a.c - 1, r: a.r - 1 } : null;
  if (!to) return null;
  if (!reachableBall(state, ball.id).some((p) => sameCell(p, to))) return null;
  return { ball: ball.id, to, spot: { rect: boardRect(to.c, to.r), radius: 18 } };
}

/* ---------- the deterministic comeback script ---------- */

/**
 * The seeded opening the whole lesson is choreographed against: the funnel's anchor — the rival's
 * column and the row the three walls bend it along. No rival mine is planted any more; the opening
 * sprint is a clean, unbroken advance. The seed holds on every board size — the player keeps column
 * 2 and the primary rival column 5 on the baseline, party seats included — so the funnel and the
 * relative dodge read the same in 1v1, 3P and 4P. Null only on a refused seed (a board too small to
 * hold the lesson), and every scripted target then falls back to the live-board finders below.
 */
let tutScript: { rivalCol: number; funnelRow: number } | null = null;

/**
 * The player's pawn square at the instant the rival's counter-wall dropped: the fixed anchor the
 * four dodge tiles are measured from, so they stay put while the pawn walks them. Set by
 * `tutorialCounterWall()`, cleared with the seed.
 */
let tutDodgeAnchor: Pos | null = null;

/**
 * The funnel's three bars, in order, derived from the seeded opening:
 *   1. the groove directly in front of the leading rival — its straight rush to FINISH closes;
 *   2. the next groove along the same seam — the rival is bent into the narrow corridor;
 *   3. the vertical bar on the corridor's open flank — the side escape is sealed, so the only
 *      route left runs straight through the choke point.
 * The bars touch end to end (legal: no shared segment, no `+`), and the player's own lane stays
 * clear of all three, so the comeback sprint is a straight run.
 */
function scriptedWall(n: 1 | 2 | 3): WallSpec | null {
  if (!tutScript) return null;
  const { rivalCol: c, funnelRow: r } = tutScript;
  return n === 1 ? { o: 'h', x: c - 1, y: r }
    : n === 2 ? { o: 'h', x: c + 1, y: r }
      : { o: 'v', x: c - 2, y: r - 1 };
}

/**
 * The funnel's quiet detour marker: dry-run the live wall on a throwaway board, then read the
 * rival's forced answer there — the exact tile it must take once the bar drops. Decoration only;
 * the tap gate never consults it.
 */
function tutorialDetourTarget(): TutorialSpot | null {
  const stage = tutorialStage();
  const n = stage === 'wall1' ? 1 : stage === 'wall2' ? 2 : stage === 'wall3' ? 3 : null;
  if (!n || state.turn !== localSide || state.winner !== null) return null;
  const target = tutorialWallTarget(n);
  if (!target) return null;
  const next = apply(state, { kind: 'wall', wall: { ...target.spec, owner: localSide } });
  if (!next) return null;
  const step = tutorialRivalStep(next);
  return step ? { rect: boardRect(step.to.c, step.to.r), radius: 14 } : null;
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
 * The wall lesson's real target for bar n. On the seeded opening the script names the exact groove
 * the comeback is choreographed against, validated by the engine's own `wallOk` (budget, lattice,
 * no clash, every live pawn keeps a route). If the board has drifted off the script — or the lesson
 * is replayed on a party board — the live-board finder takes over: candidates nearest the rival
 * first, then the whole lattice, preferring a groove that actually lengthens the rival's run, so
 * the step always points at a legal bar that forces a detour.
 */
function tutorialWallTarget(n: 1 | 2 | 3): TutorialTargetWall | null {
  if (state.turn !== localSide || state.winner !== null) return null;
  if (wallsRemaining(state, localSide) <= 0) return null;
  const rival = tutorialRival();
  if (!rival) return null;
  const scripted = scriptedWall(n);
  if (scripted && tutScript && state.walls.length === n - 1 && rival.pos.r === tutScript.funnelRow) {
    const wall: Wall = { ...scripted, owner: localSide };
    if (wallOk(state, wall)) return { spec: scripted, spot: grooveSpot(scripted) };
  }
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
    if (pathOn(distField(walls, state.cols, state.rows), rival.pos, state.cols) > before) {
      return { spec, spot: grooveSpot(spec) };
    }
    if (!fallback) fallback = spec;
  }
  return fallback ? { spec: fallback, spot: grooveSpot(fallback) } : null;
}

/**
 * STEP 8's real target: the tile the rival is about to step onto. `tutorialRivalStep()` reads the
 * LIVE board and the rules' own step query, so the tile is one the rival can actually reach in one
 * move — straight ahead when that edge is open, the nearest sidestep/forward tile on its shortest
 * route when a wall turns it aside — and it must also be a legal mine cell, so the lesson never
 * points at a square the placement would refuse. On the seeded funnel this is the choke point the
 * three walls forced open; the rival is then scripted onto exactly this tile after the player's
 * step-9 advance.
 */
function tutorialMineTarget(): TutorialTargetMine | null {
  if (state.turn !== localSide || state.winner !== null) return null;
  const cells = mineCells(state, localSide);
  if (!cells.length) return null;
  const step = tutorialRivalStep();
  const at = step ? cells.find((c) => sameCell(c, step.to)) ?? null : null;
  if (at) return { cell: at, spot: { rect: boardRect(at.c, at.r), radius: 16 } };
  /* No reachable tile is mine-legal (a board whose rival is still inside the start rows): the
     nearest legal square ahead of it keeps the lesson alive without pointing at a refused cell. */
  const rival = step?.ball ?? tutorialRival();
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

/**
 * The tiles the secondary bots must never touch during the lesson: the player's pawn and its guided
 * forward square, the four fixed dodge tiles around the counter-wall anchor, and the primary rival's
 * pawn plus the next step the funnel forces on it. Live charges are filtered separately in
 * `tutorialSafeStep`, so a seat can never wander onto the player's buried mine either.
 */
function tutorialReservedCells(): Set<string> {
  const out = new Set<string>();
  const add = (p: Pos | null | undefined) => { if (p) out.add(`${p.c},${p.r}`); };
  const mine = firstBall(state, localSide);
  add(mine?.pos);
  if (mine) {
    add({ c: mine.pos.c, r: mine.pos.r - 1 });
    const a = tutDodgeAnchor ?? mine.pos;
    add({ c: a.c - 1, r: a.r });
    add({ c: a.c - 2, r: a.r });
    add({ c: a.c - 2, r: a.r - 1 });
    add({ c: a.c - 1, r: a.r - 1 });
  }
  const rival = firstBall(state, rivalSide());
  add(rival?.pos);
  add(tutorialRivalStep()?.to);
  return out;
}

/**
 * A fast, SAFE pawn move for a secondary bot (Seats 2 and 3) during the lesson. It is the whole of
 * their vocabulary: never a wall, never a mine, never row 0 (FINISH is the player's alone), never the
 * player's charge, the funnel corridor or a guided target tile. Every candidate is dry-run through
 * the engine, so a step that would win the race, seal the player or invite the shuffle verdict is
 * refused too — the same 100% anti-loss safeguard the climax runs on. A sideways shuffle is preferred
 * to a forward gain so the extra seats stay out of the lesson's way; with nothing safe left, the seat
 * passes and the turn still cycles home.
 */
function tutorialSafeStep(seat: Player): Action {
  const reserved = tutorialReservedCells();
  const live = state.mines.filter((m) => !m.triggered);
  const ranked: { a: Action; cost: number }[] = [];
  for (const st of teamSteps(state, seat)) {
    if (st.to.r === 0) continue;
    if (reserved.has(`${st.to.c},${st.to.r}`)) continue;
    if (live.some((m) => sameCell(m.cell, st.to))) continue;
    const t = apply(state, { kind: 'move', ball: st.ball, to: st.to });
    if (!t || t.winner !== null) continue;
    if (isEliminated(t, localSide)) continue;
    const trap = t.checkmate !== state.checkmate ? t.checkmate : null;
    if (trap && trap.teams.includes(localSide)) continue;
    if ((t.repeat?.streak ?? 0) >= REPEAT_LIMIT) continue;
    const ball = ballById(state, st.ball);
    const lateral = ball !== null && st.to.r === ball.pos.r;
    ranked.push({ a: { kind: 'move', ball: st.ball, to: st.to }, cost: lateral ? 0 : 1 });
  }
  ranked.sort((x, y) => x.cost - y.cost);
  return ranked[0]?.a ?? { kind: 'pass' };
}

/**
 * Walk the turn cleanly past the secondary bots (Seats 2 and 3) back to the player. Each takes one
 * fast, safe step — or passes when nothing is safe — so a party tutorial can never stall on a bot the
 * scripted lesson does not own. Stops the moment the player (or the primary rival, whose beats are
 * scripted elsewhere) is up again.
 */
async function tutorialSecondaryBots(): Promise<void> {
  for (let guard = 0; guard < 8; guard++) {
    if (!tutorialActive || state.winner !== null) return;
    const seat = state.turn;
    if (seat === localSide || seat === rivalSide()) return;
    await new Promise<void>((res) => window.setTimeout(res, 40));
    if (!tutorialActive || state.winner !== null || state.turn !== seat) return;
    if (!play(tutorialSafeStep(seat)) && !play({ kind: 'pass' })) return;
  }
}

/**
 * The lesson's bot beat: the primary rival's scripted answer, the secondary bots' safe steps, and
 * then the board is the player's again — in 1v1, 3P and 4P alike. The turn always cycles home, so the
 * cue banner never vanishes mid-lesson and the player is never left waiting on a stalled bot.
 */
async function tutorialReply(stage: TutorialStage): Promise<void> {
  /* Step 8's beat: the charge is buried and EVERY bot seat holds position — passing keeps the
     funnel's forced step intact, so the player's step-9 tap is what sends the rival walking onto the
     charge. In a party the turn still cycles cleanly past Seats 2 and 3 instead of stalling on them. */
  if (stage === 'placeMine') {
    for (let guard = 0; guard < 8; guard++) {
      if (!tutorialActive || state.winner !== null || state.turn === localSide) return;
      if (!play({ kind: 'pass' })) return;
    }
    return;
  }
  const dodge = stage === 'dodgeLeft1' || stage === 'dodgeLeft2' || stage === 'clearWall';
  for (let guard = 0; guard < 12; guard++) {
    if (!tutorialActive || state.winner !== null || state.turn === localSide) return;
    const seat = state.turn;
    await new Promise<void>((res) => window.setTimeout(res, 50));
    if (!tutorialActive || state.winner !== null || state.turn !== seat) return;
    let a: Action;
    if (seat !== rivalSide()) {
      /* Seats 2 and 3: a fast, safe pawn move out of the lesson's way, never a wall or a mine. */
      a = tutorialSafeStep(seat);
    } else if (dodge) {
      /* Steps 10-12's answer: the primary rival shuffles sideways (c -> c + 1 on the same row), out
         of the way while the player learns the route around its counter-wall. */
      const foe = firstBall(state, seat);
      const lateral = foe ? reachableBall(state, foe.id).filter((p) => p.r === foe.pos.r) : [];
      const to = lateral.find((p) => foe !== null && p.c === foe.pos.c + 1) ?? lateral[0];
      a = foe && to ? { kind: 'move', ball: foe.id, to } : { kind: 'pass' };
    } else {
      /* The choreography is a walk, not a search: the rival takes the shortest route the rules offer,
         which on the seeded opening is the exact sidestep the funnel forces — and the straight lane
         the spotlight teaches during the opening sprint. A rival that does not hold the scripted ball
         still falls back to the brain's own answer. */
      const scripted = tutorialRivalStep();
      const auto = scripted && scripted.ball.team === seat
        ? { kind: 'move' as const, ball: scripted.ball.id, to: scripted.to }
        : getAutoMove(state, seat);
      /* A lesson replayed from the Pause sheet inside a governed debut still answers to the gates:
         a deterministic forward step may never become the move that wins the race or seals the
         player. `hold` is false here, because these rows are the lesson's own choreography. */
      const guarded = onboardingActive()
        ? onboardingRivalAction(state, localSide, auto, false)
        : auto;
      if (onboardingActive() && guarded === null) { concedeOnboarding(); return; }
      a = guarded ?? auto;
    }
    if (!play(a) && !play({ kind: 'pass' })) return;
  }
}

/**
 * Stage change from the lesson: give the board exactly the furniture the step needs and nothing
 * else. Every tap-the-square stage — the four forward taps and the four dodge taps — holds the pawn
 * so its legal dots light up, which makes the lit square a plain live tap and not only a hole in the
 * scrim; each wall step stands a real ghost bar in the glowing groove (unarmed until the player's
 * tap raises its toolbar); step 7 leaves the board in ordinary move mode while the HUD key is
 * taught; step 8 locks mine mode on with a single placeable square. `refresh(null)` takes it all
 * away.
 */
function syncTutorialUI(stage: TutorialStage | null = null) {
  tutPending = null;          // a stage change owns no staged preview
  if (!tutorialActive) {
    invalidate();
    return;
  }
  mineGhost = null;
  if (stage === 'blast') {
    /* The mine tile is empty: drop the board's own placement hint with the overlay's ring, hand
       and mine silhouette, so not one marker is left over the crater while the blast plays. */
    mineHints = [];
    setMode(BOARD_IDLE);
    ui();
    return;
  }
  if (stage === 'rush1' || stage === 'rush2' || stage === 'rush3' || stage === 'sprint'
    || stage === 'dodgeLeft1' || stage === 'dodgeLeft2' || stage === 'clearWall' || stage === 'dodgeRight') {
    /* the pawn in hand: its legal dots are the board's own answer to "where can I go?", so the
       dodge square is clickable the instant it is painted */
    const ball = state.turn === localSide ? firstBall(state, localSide) : null;
    setMode({ selected: ball ? ball.id : null, preview: null, mine: false });
  } else if (stage === 'wall1' || stage === 'wall2' || stage === 'wall3') {
    const target = tutorialWallTarget(stage === 'wall1' ? 1 : stage === 'wall2' ? 2 : 3);
    setMode(previewWall(BOARD_IDLE, target
      ? { spec: target.spec, ok: true, armed: false, p: localSide }
      : null));
  } else if (stage === 'placeMine') {
    /* Mine mode was armed by the real HUD key on step 7; keep it locked on for this one tap so a
       stray press can never toggle it off, and show only the rival's forced square. */
    setMode(holdMineKey(BOARD_IDLE, true));
  } else {
    /* includes step 7 (selectMine): the board stays in normal, unarmed move mode until the player
       taps the HUD Mine button themselves. */
    setMode(BOARD_IDLE);
  }
  ui();
}

/* ---------- the lesson's own bot beats ---------- */

/**
 * The rival's next step, read from a board (the live one by default): straight ahead whenever that
 * edge is open, and otherwise the sidestep/forward tile nearest FINISH on its shortest route.
 * `reachableBall()` is the rules' own step query, so a walled edge is never pointed at, and
 * `distField()` is the same route the board measures, so the tile the lesson names is the tile the
 * rival actually takes. The detour marker opens it on a throwaway post-wall board.
 */
function tutorialRivalStep(s: GameState = state): { ball: Ball; to: Pos } | null {
  const rival = firstBall(s, rivalSide()) ?? s.balls.find((b) => b.team !== localSide) ?? null;
  if (!rival) return null;
  const opts = reachableBall(s, rival.id);
  if (!opts.length) return null;
  const d = distField(s.walls, s.cols, s.rows);
  const dist = (p: Pos): number => {
    const v = d[p.r * s.cols + p.c];
    return v < 0 ? Number.POSITIVE_INFINITY : v;
  };
  const straight = (p: Pos): boolean => p.c === rival.pos.c && p.r === rival.pos.r - 1;
  let best = opts[0];
  for (const p of opts) {
    const dp = dist(p), db = dist(best);
    if (dp < db || (dp === db && straight(p) && !straight(best))) best = p;
  }
  return { ball: rival, to: best };
}

/** The beat the buried charge needs before the rival starts walking into it. */
const MINE_BAIT_BEAT_MS = 300;
/** The beat the real detonation gets before the lesson hands the player the wheel. */
const MINE_BLAST_READ_MS = 1250;

/** The buried charge's square: the spotlight holds the crater while it goes off. */
function tutorialMineBlastTarget(cell: Cell | null): TutorialTargetMine | null {
  return cell ? { cell, spot: { rect: boardRect(cell.c, cell.r), radius: 16 } } : null;
}

/**
 * The combo's payoff. The charge is buried on `cell`, and the rival's very next move is the scripted
 * step onto that square — performed through `play()`, so the detonation, the KNOCKBACK throw, the
 * shake and the bang are the engine's real ones rather than a re-enactment. The player's pawn held
 * the funnel row on the sprint tap, so the rival's turn is borrowed for this one walk and handed
 * straight back; in a party the blast lands the turn on a secondary bot, which is stepped home too.
 * Resolves once the blast has had its beat, so the hand-off lands on the crater and not over it.
 */
async function tutorialDetonate(cell: Cell): Promise<void> {
  await new Promise<void>((res) => window.setTimeout(res, MINE_BAIT_BEAT_MS));
  if (state.winner === null) {
    const foe = rivalSide();
    const rival = tutorialRival();
    if (rival && rival.team === foe) {
      /* The named tile first: the rival steps onto the mined square itself whenever the rules still
         offer it, which is what makes the blast certain rather than hoped for. */
      const opts = reachableBall(state, rival.id);
      const to = opts.find((p) => sameCell(p, cell)) ?? tutorialRivalStep()?.to ?? null;
      if (to) {
        const saved = state.turn;
        state = { ...state, turn: foe };
        if (!play({ kind: 'move', ball: rival.id, to })) state = { ...state, turn: saved };
      }
    }
  }
  /* The blast hands the turn down the table: step any secondary bots home and give the board back. */
  await tutorialSecondaryBots();
  if (state.winner === null && state.turn !== localSide) state = { ...state, turn: localSide };
  await new Promise<void>((res) => window.setTimeout(res, MINE_BLAST_READ_MS));
}

/**
 * STEP 10's setup. Once the blast has settled the rival drops one cheap bar flush on the edge directly
 * above the player's NEW pawn square — h(1, 7) covers columns 1-2 on the line above row 7, so it
 * shuts the straight step out of (2, 7) with zero empty tiles in between, meets v(3, 7) as a legal
 * L-corner and leaves the left flank open. It is committed through the very same `wallOk` gate a human
 * placement uses, with the rival's turn borrowed for this one action and handed straight back. The
 * player's square is saved as the dodge anchor, and the board is washed of every stale input mode —
 * mine off, no ghost, no carried pick — with the pawn already in hand, so its move dots light up the
 * moment the first dodge target is painted and the highlighted square answers the very first tap.
 */
async function tutorialCounterWall(): Promise<void> {
  const foe = rivalSide();
  if (state.winner !== null) return;
  /* The borrowed beat starts from the player's turn: in a party the blast may have left it on a
     secondary bot, so step them home first rather than skipping the wall. */
  await tutorialSecondaryBots();
  if (state.winner !== null) return;
  if (state.turn !== localSide) state = { ...state, turn: localSide };
  const ball = firstBall(state, localSide);
  if (!ball) return;
  /* The fixed anchor the four dodge tiles are measured from: the square step 9 walked the pawn onto
     — (2, 7) on the seeded opening — so every dodge tap moves smoothly around the bar above it. */
  tutDodgeAnchor = { ...ball.pos };
  const spec: WallSpec = { o: 'h', x: ball.pos.c - 1, y: ball.pos.r };
  const wall: Wall = { ...spec, owner: foe };
  if (wallsRemaining(state, foe) > 0 && wallOk(state, wall)) {
    state = { ...state, turn: foe };
    if (!play({ kind: 'wall', wall })) state = { ...state, turn: localSide };
  }
  /* A borrowed beat is not a turn: the lesson always hands the board straight back to the player. */
  if (state.winner === null) state = { ...state, turn: localSide };
  mineArmed = false;
  mineGhost = null;
  ghost = null;
  const pawn = firstBall(state, localSide);
  setMode({ selected: pawn ? pawn.id : null, preview: null, mine: false });
  ui();
}

/* ---------- the free-play climax: the wheel is the player's, the race is not losable ---------- */

/** Rows from FINISH inside which the tutorial rival may only shuffle sideways. */
const CLIMAX_BRAKE_ROW = 3;
/** How long the hand-off callout holds before it lets the board have the whole screen. */
const CLIMAX_CALL_OUT_MS = 4600;
let climaxTimer = 0;

/**
 * THE 100% ANTI-LOSS SAFEGUARD. The tutorial rival's whole vocabulary during the climax is a step:
 * it never builds a wall and never buries a mine, so nothing it does can lengthen the player's run
 * or throw their pawn. Inside `CLIMAX_BRAKE_ROW` rows of FINISH it may only move sideways (or back
 * when no sideways square is open), and it may never enter row 0 at all — the player therefore
 * always crosses the line first. Every candidate is still dry-run through the engine, so a step
 * that would seal the player, checkmate them or adjudicate the race against them is refused too.
 */
function tutorialClimaxAction(): Action {
  const seat = state.turn;
  const d = distField(state.walls, state.cols, state.rows);
  const ranked: { a: Action; cost: number }[] = [];
  for (const st of teamSteps(state, seat)) {
    if (st.to.r === 0) continue;                       // FINISH is the player's alone
    const ball = ballById(state, st.ball);
    if (!ball) continue;
    const near = ball.pos.r <= CLIMAX_BRAKE_ROW;
    if (near && st.to.r < ball.pos.r) continue;        // no forward gain inside the brake band
    const t = apply(state, { kind: 'move', ball: st.ball, to: st.to });
    if (!t || t.winner !== null) continue;
    if (isEliminated(t, localSide)) continue;
    const trap = t.checkmate !== state.checkmate ? t.checkmate : null;
    if (trap && trap.teams.includes(localSide)) continue;
    if ((t.repeat?.streak ?? 0) >= REPEAT_LIMIT) continue;   // never invite the shuffle verdict
    const gain = pathOn(d, ball.pos, state.cols) - pathOn(d, st.to, state.cols);
    /* inside the brake band a sideways shuffle is the whole turn; outside it the rival races
       honestly, which is what keeps the climax reading as a race rather than a walkover */
    const cost = near ? (st.to.r === ball.pos.r ? 0 : 1) : -gain;
    ranked.push({ a: { kind: 'move', ball: st.ball, to: st.to }, cost });
  }
  ranked.sort((x, y) => x.cost - y.cost);
  return ranked[0]?.a ?? { kind: 'pass' };
}

/** The hand-off callout: one line, pointer-transparent, gone on its own. Never a second button. */
function showClimaxCallout(): void {
  const el = $<HTMLElement>('tut-climax');
  const text = $<HTMLElement>('tut-climax-t');
  /* the hand-off speaks the lesson's own tongue, not the shell's: the switcher in the top bar is
     the language the player just read eight prompts in */
  const tongue = tutorialLang();
  text.textContent = tIn(tongue, 'tutClimax');
  el.dir = tutorialDir(tongue);
  el.lang = tongue;
  el.hidden = false;
  el.classList.remove('is-out');
  /* park it in the daylight the slab leaves, so the sprint's own move dots are never covered */
  const vw = window.innerWidth, vh = window.innerHeight;
  const ch = el.offsetHeight || 60;
  const cw = Math.min(el.offsetWidth || 320, vw - 24);
  const slab = document.getElementById('board-wrap')?.getBoundingClientRect();
  const dock = document.getElementById('chips')?.getBoundingClientRect();
  let top = vh - ch - 12;
  if (slab && dock && slab.height > 1) {
    const below = dock.top - slab.bottom;
    const above = slab.top - 12;
    if (below >= ch + 10) top = slab.bottom + (below - ch) / 2;
    else if (above >= ch + 10) top = 12 + (above - ch) / 2;
    /* too short for either gap: sit over the slab's empty bottom rows, never over the dock or the
       head's own keys — the sprint's pawn and its dots are up the board, far from this edge */
    else top = slab.bottom - ch - 8;
  }
  el.style.left = `${Math.max(12, Math.min((vw - cw) / 2, vw - cw - 12))}px`;
  el.style.top = `${Math.max(8, Math.min(top, vh - ch - 8))}px`;
  void el.offsetWidth;
  el.classList.add('is-live');
  if (climaxTimer) window.clearTimeout(climaxTimer);
  climaxTimer = window.setTimeout(hideClimaxCallout, CLIMAX_CALL_OUT_MS);
}

function hideClimaxCallout(): void {
  if (climaxTimer) { window.clearTimeout(climaxTimer); climaxTimer = 0; }
  const el = $<HTMLElement>('tut-climax');
  if (el.hidden) return;
  el.classList.add('is-out');
  window.setTimeout(() => {
    if (el.classList.contains('is-out')) { el.hidden = true; el.classList.remove('is-live', 'is-out'); }
  }, 320);
}

/** The lesson's match is over: the rival is an ordinary opponent again and chat comes back. */
function endTutorialMatch(): void {
  tutorialClimax = false;
  document.body.classList.remove('tut-match');
  hideClimaxCallout();
}

/**
 * The comeback's deterministic opening: the FULL match start, on every board size. The player holds
 * column 2 and the primary rival column 5 on the baseline — the exact lanes the funnel and the
 * relative left/right dodge are choreographed against — while any party seats keep their own spawn
 * tiles. NO rival charge is buried on the player's lane, so the opening sprint is a smooth, unbroken
 * advance with no knockback setback. The budgets, the fog and the seat colours are all the race's own.
 */
function seedTutorialBoard(): void {
  tutScript = null;
  tutDodgeAnchor = null;
  if (state.balls.length < 2 || state.cols < 6 || state.rows < 8) return;
  const mine = firstBall(state, localSide);
  const foe = firstBall(state, rivalSide());
  if (!mine || !foe) return;
  const homeRow = state.rows - 1;
  if (homeRow < 4) return;
  /* the funnel anchor: the row the player reaches after three clean forward steps */
  const funnelRow = homeRow - 3;
  tutScript = { rivalCol: 5, funnelRow };
  const used = new Set<number>([2, 5]);
  const balls = state.balls.map((b) => {
    if (b.id === mine.id) return { ...b, pos: { c: 2, r: homeRow }, isCheckmated: false };
    if (b.id === foe.id) return { ...b, pos: { c: 5, r: homeRow }, isCheckmated: false };
    /* A party seat keeps its spawn tile unless it already holds a seeded lane; then it slides to the
       nearest free baseline column, so no two pawns ever share a square. */
    let c = b.pos.c;
    if (b.pos.r === homeRow && used.has(c)) {
      c = 0;
      while (c < state.cols && used.has(c)) c++;
      if (c >= state.cols) c = b.pos.c;
    }
    used.add(c);
    return { ...b, pos: { c, r: b.pos.r }, isCheckmated: false };
  });
  state = {
    ...state,
    balls,
    walls: [],
    mines: [],
    wallsLeft: state.teams.map(() => wallBudget(state.balls.length)),
    turn: localSide,
    winner: null,
    checkmate: null,
    eliminated: [],
    repeat: { seen: [], streak: 0 },
  };
  /* the tokens are born on their true start tiles, never tweened in from elsewhere */
  ballViews.length = 0;
  snapBalls();
  marks.fill(null);
  shownWalls.fill(-1);
  shownMines = -1;
  turnsPlayed = 0;
  saidTurn = '';
  mineGhost = null;
  autoPicked = null;
  setMode(BOARD_IDLE);
  invalidate();
}

function beginTutorial(auto = false) {
  if (!tutorial || tutorial.active || active || humansIn(room) > 1) return;
  /* The late guard: an AUTO lesson is refused the instant the save says it was completed or
     skipped. Manual replays (Pause / Settings) pass `auto === false` and always run. */
  if (auto && hasCompletedTutorial()) {
    tutorialStandalone = false;   // nothing replaces this race: it plays as an ordinary match
    return;
  }
  tutorialActive = true;      // before stopClock: clockLive reads this flag
  tutorialClimax = false;
  stopClock();
  hideClimaxCallout();
  seedTutorialBoard();
  /* the combo's first tap is a whole move: the pawn comes to hand with the lesson, not before it */
  selected = null;
  autoPicked = null;
  mineArmed = false;
  mineGhost = null;
  setMode(BOARD_IDLE);
  document.body.classList.add('tut-match');
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
 * board the thirteen steps were written against. It is a standalone lesson: `end` closes it on the
 * same live board.
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
 * When the lesson is skipped (or Escape / Back is pressed) `end()` only dismisses the overlay: the
 * player stays in the match already on the board. When it is finished, the completion flag is
 * persisted at once and the player sprints to the FINISH line; `showOverlay()` then lands them on
 * #s-home once that first match is settled.
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
  if (!tutorialActive) return;
  tutorial?.cancel();
  tutorialActive = false;
}

tutorial = createTutorial({
  goal: tutorialFinishTarget,
  advance: tutorialAdvanceTarget,
  wall: tutorialWallTarget,
  mine: tutorialMineTarget,
  detour: tutorialDetourTarget,
  mineButton: () => {
    /* Step 7 spotlights the real HUD Mine button wherever seatChrome() parked it. The box is read
       afresh on every track frame, so the ring, the input cut-out and the ghost hand stay locked to
       the exact key the player must tap even while the board screen is still sliding in. */
    const r = mineBtn.getBoundingClientRect();
    return r.width > 1 && r.height > 1
      ? { rect: { left: r.left, top: r.top, width: r.width, height: r.height }, radius: 14 }
      : null;
  },
  blast: tutorialMineBlastTarget,
  dodge: tutorialDodgeTarget,
  counterWall: tutorialCounterWall,
  reply: tutorialReply,
  detonate: tutorialDetonate,
  finishPulse: () => { renderer.pulseFinish(1200); invalidate(); },
  refresh: syncTutorialUI,
  end(result) {
    const bootLesson = firstRunBoot;
    firstRunBoot = false;
    tutorialActive = false;
    tutPending = null;
    document.body.classList.remove('tutorial-live');
    mineGhost = null;            // before the mode: `armCapsules` must not re-stage a dead square
    setMode(BOARD_IDLE);
    autoPicked = null;
    if (result === 'cancelled') { tutorialStandalone = false; endTutorialMatch(); return; }
    /* Completing the combo OR explicitly tapping Skip writes `tutorialCompleted = true` to the save
       immediately (completeTutorial flushes). This is the only place the flag is earned, so a
       returning profile can never be auto-routed into the lesson again. */
    completeTutorial();
    if (result === 'finished') {
      /* THE FREE-PLAY CLIMAX. The counter-mine has gone off, the rival is thrown back and the lead
         is the player's again. Every gate comes off the board: the pawn, the walls, the mines and
         the clock are all the player's own again, and one callout says so. The rival stays
         handicapped until the line is crossed, so the race cannot be lost. */
      tutorialStandalone = false;
      if (bootLesson) firstRunSprint = true;
      if (state.winner === null) {
        tutorialClimax = true;
        showClimaxCallout();
        impact('heavy');
      } else {
        endTutorialMatch();      // the race settled under the lesson: keep its own result
      }
      $<HTMLElement>('s-game').focus({ preventScroll: true });
      ui();
      startClock();
      if (wantsOpponent()) void runOpponent();
      return;
    }
    /* Skip (or Escape) DISMISSES the lesson and leaves the player inside the match already on the
       board — the flag above is saved, the overlay is torn down, and the ordinary controls and
       clock are handed straight back. A standalone lesson never routes out to Home. */
    tutorialStandalone = false;
    endTutorialMatch();
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
  impact(localWon() ? 'medium' : 'heavy');
  /* PLAY AGAIN IS THE SECOND MATCH. The capsule closes into the wall instead of a fresh board —
     and before a friends rematch vote is cast, so a room is never asked to count down for a seat
     that cannot take it. */
  if (channelGateBlocks()) { raiseChannelGate(); return; }
  /* NEVER ROUTE A FRIENDS REMATCH TO THE QUEUE. A private room's next board is a vote on the room
     the player is already seated in; queueing here would drop the friends they just raced and put
     them in front of strangers. This branch is the only thing a friends capsule can do. */
  if (active && 'seats' in active) { requestRematch(); return; }
  clearResultMotion();
  /* Play again and Rematch both leave this result behind: the celebration (or the defeat sting)
     goes with it */
  stopVictoryFanfare();
  stopDefeat();
  /* ...and the bed comes back with the next race. Placed after the two stops so the fanfare's tail
     is not faded over; a rematch VOTE returned above and never reaches this line, which is what
     keeps the bed parked while the room is still deciding. */
  /* a networked seat is not ours to restart in place: Play again queues the next race */
  if (active) {
    const mode: 'pvp' | 'arena' | 'channel_war' = warMatch
      ? 'channel_war'
      : active.mode === 'arena' ? 'arena' : 'pvp';
    /* The board is left behind on this beat and the queue screen takes over, so the strict match
       gate closes HERE — `setMusicMatchOver(false)` would lift the duck over a screen that is no
       longer a match. The queued race opens it again at its own reveal. */
    setMusicInMatch(false);
    active.close();
    active = null;
    queueMatch(mode);
    return;
  }
  setMusicMatchOver(false);
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
rematchDeclineBtn.addEventListener('click', () => { impact('light'); declineRematch(); });
rematchChallengeAccept.addEventListener('click', () => {
  impact('medium');
  requestRematch();
  hideRematchChallenge();
});
rematchChallengeDecline.addEventListener('click', () => {
  impact('light');
  rematchChallengeDismissed = rematchInviteSig(rematchState);
  declineRematch();
  hideRematchChallenge();
  if (!again.disabled) again.focus({ preventScroll: true });
});
toMenu.addEventListener('click', () => {
  impact('light');
  clearResultMotion();
  /* A settled friends room hears the exit before the screen leaves, so the remaining players'
     consensus updates on this beat instead of waiting out a reconnect grace. */
  if (active && 'seats' in active) active.leaveRoom();
  quitToMenu();
});
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
    view.trapHints = trapHints;
    view.ghost = ghost;
    view.mineHints = mineHints;
    view.mineGhost = mineGhost;
    view.capsule = capsule;
    view.last = marks;
    /* The pips above the thinking pawn belong to whoever is up: a bot working out its move AND a
       person on the far side of the wire. The local seat's own pawns never wear them, and the
       pips go the moment the turn moves on or the match ends. */
    const thinkingSeat = opponentThinking(state.turn) ? state.turn : null;
    view.thinking = thinkingSeat;
    /* Confetti reports whether any particle is still in the air. It is drawn above the result
       scrim, so it keeps ticking even when the board behind it is deliberately not repainted. */
    const confettiLive = confetti.tick(dt, now);
    /* The board keeps breathing while an opponent thinks. The pips' wave rides the ambient clock,
       so the loop has to keep ticking through a human rival's turn over the wire exactly as it
       does through a bot's think time — otherwise the wave would freeze between socket updates. */
    const thinking = thinkingSeat !== null;
    /* The result capsule lays a full-screen scrim over the board: repainting the canvas behind it
       would re-composite a board nobody can see. Only confetti keeps the loop alive up there. */
    const fxBusy = overlayOpen ? false : renderer.draw(view, now, settling || confettiLive || thinking);
    animating = fxBusy || settling || confettiLive || thinking;
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

/* ============================================================================================
   THE 7-DAY "MOST WINS" RACE — slide 0's engine
   --------------------------------------------------------------------------------------------
   The weekly race is uncapped: every friend win and every Hard AI win inside one exact 168-hour
   window (the season epoch stamped at launch, the same clock the Worker runs) adds to a single
   total, and the Top 3 totals when the week closes split one 50-Star pool 25 / 15 / 10. The card is markup in index.html; every live
   figure on it — and on its board / rules sheet — is painted here from the room's own answer.

   Anti-cheat is the room's, never this file's:
     · the Hard AI track is a one-shot ticket minted at board start, and the room only accepts a
       victory that arrives 45s later with 10+ played moves on a hard/1v1 board;
     · the friend track is written only by the room's settlement of a real 1v1 between two verified
       Telegram accounts (45s, 10 moves, 60s on a forfeit, and 3 wins per friend per week);
     · the Top 3 are locked when the window closes, and each payout is paid exactly once.

   This file only reports and paints. A failed request leaves the card readable with the last
   figures it had, and the local window clock keeps counting down.
   ============================================================================================ */

const CHALLENGE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Mirrors `CHALLENGE_SEASON_EPOCH` in worker/challenge.ts: 2026-11-24T14:30:00Z. */
const CHALLENGE_SEASON_EPOCH = Date.UTC(2026, 10, 24, 14, 30, 0);
const CHALLENGE_DAY_MS = 24 * 60 * 60 * 1000;
const CHALLENGE_HOUR_MS = 60 * 60 * 1000;
/** The countdown turns warm amber for the last six hours of the 168-hour cycle. */
const CHALLENGE_URGENT_MS = 6 * 60 * 60 * 1000;
/** One row of the room's live board. The internal player id never leaves the Worker. */
interface ChallengeRowView {
  position: number;
  /** The room's opaque player id for this seat; never printed. */
  userId?: string;
  handle: string;
  friendWins: number;
  hardBotWins: number;
  totalWins: number;
  /** The exact rank reward at week close: 25 / 15 / 10, 0 outside the Top 3. */
  prizeStars?: number;
  isMe?: boolean;
}

interface ChallengeView {
  ok?: boolean;
  error?: string;
  auth?: string;
  ticket?: string;
  hardBotWins?: number;
  friendWins?: number;
  totalWins?: number;
  myPosition?: number | null;
  leaderboard?: ChallengeRowView[];
  contenders?: number;
  totalParticipants?: number;
  /** True when this verified seat already holds a live row on this week's field. */
  isEnrolled?: boolean;
  /** The 50-Star pool and its exact Top-3 split, served by the room. */
  totalPrizePool?: number;
  prizeByRank?: Record<string, number>;
  /** This seat's slice at its current rank: 25 / 15 / 10, else 0. */
  prizeStars?: number;
  windowStart?: number;
  windowEnd?: number;
  endsInMs?: number;
  stars?: number;
  maxWinners?: number;
  maxWinsPerFriend?: number;
  friendCount?: number;
  /** The rank this seat may collect for the week that just closed, or null. */
  claimableRank?: number | null;
  /** The exact rank prize the closed week pays: 25 / 15 / 10. */
  claimableStars?: number;
  /** The last podium this seat stood on, claimed or not. */
  lastRank?: number | null;
  lastStars?: number;
  claimed?: boolean;
  claimedAt?: number;
  claimedRank?: number | null;
  claimStars?: number;
  credited?: boolean;
}

/** One row of the floating rules card: a terse key, a terse value, one accent. */
interface ChallengeRuleShort {
  k: string;
  v: string;
  tone: 'gold' | 'mint' | 'plain';
}

interface ChallengeCopy {
  /** The crown label on the poster's top edge. */
  badge: string;
  prizeUnit: string;
  /** The poster's one-line hook, under the headline. */
  hook: string;
  podium: string;
  /** The word after the countdown digits while a day or more remains ("left" / "باقی‌مانده"). */
  clockLeft: string;
  winsWord: string;
  friendHint: string;
  /** The live rank pill: the rank token is replaced with a Latin number. */
  rank: string;
  unranked: string;
  botCta: string;
  friendCta: string;
  /** The tournament mint key's own challenge line, carried verbatim by the room's invite. */
  duelShare: string;
  /** The brand-new 1v1 lobby's caption while the invited rival's chair is still empty. */
  duelWaiting: string;
  /** Confirmation once that room's invite has left the device for Telegram's picker. */
  duelArmed: string;
  /** The quiet second door under the mint key: the Friends & Rivals list, no room minted. */
  rivalsLink: string;
  /** The hub's payout banner: {stars} and {rank} become Latin numbers. */
  claim: string;
  /** The poster's slim claim label: {stars} and {rank} become Latin numbers. */
  claimShort: string;
  /** The poster's one key. */
  enter: string;
  claimDone: string;
  claimOk: string;
  claimFail: string;
  guest: string;
  /** The board panel's quiet section label above the standings. */
  boardLive: string;
  /** The header pill's own short label ("Rules" / "قوانین"). */
  rulesOpen: string;
  /** The floating card's headline and its one dismiss key. */
  rulesTitle: string;
  rulesCta: string;
  /** The sheet's own headline only: the 50-Star pool is the separate gold pill beside it. */
  sheetTitle: string;
  /** The standings rail's two column names. */
  boardHeadStart: string;
  boardHeadEnd: string;
  /** The pool split strip's podium labels; the rank token is a Latin "#n" in its own bdi. */
  tier1: string;
  tier2: string;
  tier3: string;
  you: string;
  empty: string;
  /** One row's exact rank reward: {stars} becomes the Latin 25 / 15 / 10. */
  prizeTag: string;
  /** One row's source split: the two win tokens are Latin numbers. */
  rowSub: string;
  /** The live-field counter's unit, printed beside a Latin participant count. */
  players: string;
  /** The seated status: the emerald-gold badge in the hub's top telemetry strip. */
  enrolled: string;
  /** The free one-tap enrollment key, until this seat has synced into the live week. */
  join: string;
  joinOk: string;
  joinFail: string;
  /** The floating rules card: four terse key/value rows, never a paragraph. */
  rulesShort: ChallengeRuleShort[];
  warsOff: string;
}

/* All five languages live here, beside the card's own paint, because none of these lines belong in
   the global string table: this poster and its hub are the only surfaces that say them. Every
   numeral is a Latin digit wrapped in an LTR <bdi>, in every language, so no font can re-shape a
   score and no bidi run can swap a rank. */
const CHALLENGE_COPY: Record<LangCode, ChallengeCopy> = {
  fa: {
    badge: 'تورنمنت هفتگی',
    prizeUnit: 'استارز',
    hook: 'بیشترین برد این هفته رو ثبت کن و سهمت رو از <bdi dir="ltr">50</bdi> استارز واقعی ببر!',
    podium: 'جایزه <bdi dir="ltr">3</bdi> نفر برتر • <bdi dir="ltr">25 / 15 / 10</bdi> استارز',
    clockLeft: 'باقی‌مانده',
    winsWord: 'برد',
    friendHint: 'حداکثر <bdi dir="ltr">3</bdi> برد از هر دوست',
    rank: 'رتبه <bdi dir="ltr">#{rank}</bdi>',
    unranked: 'بدون رتبه',
    botCta: 'بازی با ربات Hard',
    friendCta: 'دعوت از دوست',
    duelShare: 'بیا دوئل تورنمنت 50 استارز! اتاق 1v1 آماده‌ست، ببینم کی می‌بره!',
    duelWaiting: 'اتاق دوئل تورنمنت آماده‌ست؛ منتظر ورود رقیب...',
    duelArmed: 'اتاق آماده شد؛ لینک دعوت راهی تلگرام شد.',
    rivalsLink: 'انتخاب مستقیم از لیست دوستان و رقبا',
    claim: 'ثبت و دریافت <bdi dir="ltr">{stars}</bdi> استارز • مقام <bdi dir="ltr">#{rank}</bdi>',
    claimShort: 'دریافت <bdi dir="ltr">{stars}</bdi> استارز • مقام <bdi dir="ltr">#{rank}</bdi>',
    enter: 'ورود به تورنمنت و جدول زنده',
    claimDone: 'این جایزه قبلاً ثبت شده است',
    claimOk: 'جایزه تورنمنت شما ثبت شد',
    claimFail: 'ثبت درخواست ممکن نشد؛ دوباره تلاش کنید',
    guest: 'برای شرکت، مینی‌اپ را داخل تلگرام باز کنید',
    boardLive: 'جدول رتبه‌بندی زنده',
    rulesOpen: 'قوانین',
    rulesTitle: 'قوانین تورنمنت',
    rulesCta: 'متوجه شدم',
    sheetTitle: 'تورنمنت هفتگی',
    boardHeadStart: 'بازیکن و رتبه',
    boardHeadEnd: 'امتیاز و جایزه',
    tier1: 'نفر اول',
    tier2: 'نفر دوم',
    tier3: 'نفر سوم',
    you: 'شما',
    empty: 'هنوز شرکت‌کننده‌ای ثبت نشده؛ دکمه شرکت رایگان رو بزن و نفر اول شو!',
    prizeTag: '<bdi dir="ltr">{stars}</bdi> استارز',
    rowSub: 'دوستان <bdi dir="ltr">{friendWins}</bdi> • ربات Hard <bdi dir="ltr">{botWins}</bdi>',
    players: 'شرکت‌کننده',
    enrolled: 'عضو تورنمنت',
    join: 'شرکت رایگان',
    joinOk: 'در تورنمنت هفتگی ثبت شدی؛ موفق باشی!',
    joinFail: 'ثبت در تورنمنت ممکن نشد؛ دوباره تلاش کنید',
    rulesShort: [
      { k: 'جوایز هفتگی', v: '<bdi dir="ltr">25</bdi> / <bdi dir="ltr">15</bdi> / <bdi dir="ltr">10</bdi> استارز', tone: 'gold' },
      { k: 'امتیاز هر برد', v: 'ربات Hard یا دوستان = <bdi dir="ltr">+1</bdi>', tone: 'mint' },
      { k: 'سقف برد از دوست', v: 'حداکثر <bdi dir="ltr">3</bdi> برد در هفته', tone: 'plain' },
      { k: 'شرط ثبت برد', v: 'حداقل <bdi dir="ltr">45</bdi> ثانیه و <bdi dir="ltr">10</bdi> حرکت', tone: 'plain' },
    ],
    warsOff: 'موقتاً غیرفعال • به زودی',
  },
  en: {
    badge: 'WEEKLY TOURNAMENT',
    prizeUnit: 'STARS',
    hook: 'Rack up the most wins this week to claim your share of <bdi dir="ltr">50</bdi> Stars!',
    podium: 'TOP <bdi dir="ltr">3</bdi> PRIZES • <bdi dir="ltr">25 / 15 / 10</bdi> STARS',
    clockLeft: 'left',
    winsWord: 'wins',
    friendHint: 'Max <bdi dir="ltr">3</bdi> wins from each friend',
    rank: 'RANK <bdi dir="ltr">#{rank}</bdi>',
    unranked: 'UNRANKED',
    botCta: 'Play Hard Bot',
    friendCta: 'Invite a Friend',
    duelShare: 'Join my 1v1 duel for the 50 Stars Weekly Tournament! Room is ready!',
    duelWaiting: 'Your tournament duel room is ready — waiting for the rival…',
    duelArmed: 'Room ready — the invite is on its way to Telegram.',
    rivalsLink: 'Or challenge directly from Friends & Rivals',
    claim: 'Claim <bdi dir="ltr">{stars}</bdi> Stars • Rank <bdi dir="ltr">#{rank}</bdi>',
    claimShort: 'Claim <bdi dir="ltr">{stars}</bdi> Stars • Rank <bdi dir="ltr">#{rank}</bdi>',
    enter: 'Enter Tournament &amp; Standings',
    claimDone: 'This prize was already claimed',
    claimOk: 'Your tournament prize is recorded',
    claimFail: 'Could not record the claim — try again',
    guest: 'Open this Mini App inside Telegram to compete',
    boardLive: 'Live Standings',
    rulesOpen: 'Rules',
    rulesTitle: 'Tournament Rules',
    rulesCta: 'Got it',
    sheetTitle: 'Weekly Tournament',
    boardHeadStart: 'Player & rank',
    boardHeadEnd: 'Wins & prize',
    tier1: 'First Place',
    tier2: 'Second Place',
    tier3: 'Third Place',
    you: 'YOU',
    empty: 'No participants yet — tap Free Join and take first place!',
    prizeTag: '<bdi dir="ltr">{stars}</bdi> STARS',
    rowSub: 'Friends <bdi dir="ltr">{friendWins}</bdi> • Hard bot <bdi dir="ltr">{botWins}</bdi>',
    players: 'Players',
    enrolled: 'Enrolled',
    join: 'Join Free',
    joinOk: 'You are in the weekly tournament — good luck!',
    joinFail: 'Could not join the tournament — try again',
    rulesShort: [
      { k: 'Weekly Prizes', v: '<bdi dir="ltr">25</bdi> / <bdi dir="ltr">15</bdi> / <bdi dir="ltr">10</bdi> Stars', tone: 'gold' },
      { k: 'Win Points', v: 'Hard Bot or Friends = <bdi dir="ltr">+1</bdi>', tone: 'mint' },
      { k: 'Friend Cap', v: 'Max <bdi dir="ltr">3</bdi> wins / friend', tone: 'plain' },
      { k: 'Valid Match', v: 'Min <bdi dir="ltr">45</bdi>s &amp; <bdi dir="ltr">10</bdi> moves', tone: 'plain' },
    ],
    warsOff: 'Paused • Back soon',
  },
  ru: {
    badge: 'НЕДЕЛЬНЫЙ ТУРНИР',
    prizeUnit: 'STARS',
    hook: 'Набери больше всех побед за неделю и раздели <bdi dir="ltr">50</bdi> Stars!',
    podium: 'ТОП-<bdi dir="ltr">3</bdi> ПРИЗЫ • <bdi dir="ltr">25 / 15 / 10</bdi> STARS',
    clockLeft: 'осталось',
    winsWord: 'побед',
    friendHint: 'Макс. <bdi dir="ltr">3</bdi> побед от друга',
    rank: 'МЕСТО <bdi dir="ltr">#{rank}</bdi>',
    unranked: 'БЕЗ МЕСТА',
    botCta: 'Играть с Hard-ботом',
    friendCta: 'Пригласить друга',
    duelShare: 'Заходи в дуэль 1 на 1 за 50 Stars в недельном турнире! Комната готова!',
    duelWaiting: 'Дуэльная комната турнира готова — ждём соперника…',
    duelArmed: 'Комната готова — приглашение отправлено в Telegram.',
    rivalsLink: 'Или выбрать из списка друзей и соперников',
    claim: 'Получить <bdi dir="ltr">{stars}</bdi> Stars • место <bdi dir="ltr">#{rank}</bdi>',
    claimShort: 'Забрать <bdi dir="ltr">{stars}</bdi> Stars • место <bdi dir="ltr">#{rank}</bdi>',
    enter: 'Войти в турнир и таблицу',
    claimDone: 'Этот приз уже получен',
    claimOk: 'Ваш турнирный приз записан',
    claimFail: 'Не удалось отправить заявку — попробуйте ещё раз',
    guest: 'Откройте мини-приложение в Telegram, чтобы участвовать',
    boardLive: 'Живая таблица',
    rulesOpen: 'Правила',
    rulesTitle: 'Правила турнира',
    rulesCta: 'Понятно',
    sheetTitle: 'Недельный турнир',
    boardHeadStart: 'Игрок и место',
    boardHeadEnd: 'Победы и приз',
    tier1: 'Первое место',
    tier2: 'Второе место',
    tier3: 'Третье место',
    you: 'ВЫ',
    empty: 'Участников пока нет — нажмите «Участвовать» и станьте первым!',
    prizeTag: '<bdi dir="ltr">{stars}</bdi> STARS',
    rowSub: 'Друзья <bdi dir="ltr">{friendWins}</bdi> • Hard-бот <bdi dir="ltr">{botWins}</bdi>',
    players: 'Участники',
    enrolled: 'Участник',
    join: 'Участвовать',
    joinOk: 'Вы в недельном турнире — удачи!',
    joinFail: 'Не удалось зарегистрироваться — попробуйте ещё раз',
    rulesShort: [
      { k: 'Призы недели', v: '<bdi dir="ltr">25</bdi> / <bdi dir="ltr">15</bdi> / <bdi dir="ltr">10</bdi> Stars', tone: 'gold' },
      { k: 'Очки за победу', v: 'Hard-бот или друзья = <bdi dir="ltr">+1</bdi>', tone: 'mint' },
      { k: 'Лимит с другом', v: 'Не более <bdi dir="ltr">3</bdi> побед от друга', tone: 'plain' },
      { k: 'Зачёт матча', v: 'Мин. <bdi dir="ltr">45</bdi> с и <bdi dir="ltr">10</bdi> ходов', tone: 'plain' },
    ],
    warsOff: 'Приостановлено • Скоро вернётся',
  },
  ar: {
    badge: 'البطولة الأسبوعية',
    prizeUnit: 'ستارز',
    hook: 'حقق أكبر عدد من الانتصارات هذا الأسبوع واربح حصتك من <bdi dir="ltr">50</bdi> ستارز!',
    podium: 'جوائز أول <bdi dir="ltr">3</bdi> • <bdi dir="ltr">25 / 15 / 10</bdi> ستارز',
    clockLeft: 'متبقي',
    winsWord: 'انتصار',
    friendHint: 'حد أقصى <bdi dir="ltr">3</bdi> انتصارات من كل صديق',
    rank: 'الترتيب <bdi dir="ltr">#{rank}</bdi>',
    unranked: 'بدون ترتيب',
    botCta: 'العب مع روبوت Hard',
    friendCta: 'دعوة صديق',
    duelShare: 'ادخل تحدي 1 ضد 1 في بطولة 50 ستارز الأسبوعية! الغرفة جاهزة!',
    duelWaiting: 'غرفة مبارزة البطولة جاهزة — بانتظار الخصم...',
    duelArmed: 'الغرفة جاهزة — وصلت الدعوة إلى تلغرام.',
    rivalsLink: 'أو اختر مباشرة من قائمة الأصدقاء والمنافسين',
    claim: 'استلم <bdi dir="ltr">{stars}</bdi> ستارز • المرتبة <bdi dir="ltr">#{rank}</bdi>',
    claimShort: 'استلم <bdi dir="ltr">{stars}</bdi> ستارز • المرتبة <bdi dir="ltr">#{rank}</bdi>',
    enter: 'دخول البطولة والترتيب المباشر',
    claimDone: 'تم تسجيل هذه الجائزة سابقاً',
    claimOk: 'تم تسجيل جائزة البطولة',
    claimFail: 'تعذّر تسجيل الطلب — حاول مرة أخرى',
    guest: 'افتح التطبيق المصغّر داخل تلغرام للمشاركة',
    boardLive: 'جدول الترتيب المباشر',
    rulesOpen: 'القوانين',
    rulesTitle: 'قوانين البطولة',
    rulesCta: 'فهمت',
    sheetTitle: 'البطولة الأسبوعية',
    boardHeadStart: 'اللاعب والترتيب',
    boardHeadEnd: 'الانتصارات والجائزة',
    tier1: 'المركز الأول',
    tier2: 'المركز الثاني',
    tier3: 'المركز الثالث',
    you: 'أنت',
    empty: 'لا مشاركين بعد — اضغط «انضم مجاناً» وكن الأول!',
    prizeTag: '<bdi dir="ltr">{stars}</bdi> ستارز',
    rowSub: 'الأصدقاء <bdi dir="ltr">{friendWins}</bdi> • روبوت Hard <bdi dir="ltr">{botWins}</bdi>',
    players: 'مشارك',
    enrolled: 'مشارك',
    join: 'انضم مجاناً',
    joinOk: 'تم تسجيلك في البطولة الأسبوعية — حظاً موفقاً!',
    joinFail: 'تعذّر الانضمام إلى البطولة — حاول مرة أخرى',
    rulesShort: [
      { k: 'جوائز الأسبوع', v: '<bdi dir="ltr">25</bdi> / <bdi dir="ltr">15</bdi> / <bdi dir="ltr">10</bdi> ستارز', tone: 'gold' },
      { k: 'نقاط الفوز', v: 'روبوت Hard أو الأصدقاء = <bdi dir="ltr">+1</bdi>', tone: 'mint' },
      { k: 'حد كل صديق', v: 'حد أقصى <bdi dir="ltr">3</bdi> انتصارات / صديق', tone: 'plain' },
      { k: 'احتساب المباراة', v: 'على الأقل <bdi dir="ltr">45</bdi> ثانية و <bdi dir="ltr">10</bdi> حركات', tone: 'plain' },
    ],
    warsOff: 'متوقف مؤقتاً • يعود قريباً',
  },
  es: {
    badge: 'TORNEO SEMANAL',
    prizeUnit: 'STARS',
    hook: '¡Consigue más victorias esta semana y gana tu parte de <bdi dir="ltr">50</bdi> Stars!',
    podium: 'TOP <bdi dir="ltr">3</bdi> PREMIOS • <bdi dir="ltr">25 / 15 / 10</bdi> STARS',
    clockLeft: 'restantes',
    winsWord: 'victorias',
    friendHint: 'Máx. <bdi dir="ltr">3</bdi> victorias por amigo',
    rank: 'PUESTO <bdi dir="ltr">#{rank}</bdi>',
    unranked: 'SIN PUESTO',
    botCta: 'Jugar con bot Hard',
    friendCta: 'Invitar a un amigo',
    duelShare: '¡Únete a mi duelo 1v1 por el Torneo Semanal de 50 Stars! ¡Sala lista!',
    duelWaiting: 'Tu sala de duelo del torneo está lista — esperando al rival…',
    duelArmed: 'Sala lista — la invitación ya va a Telegram.',
    rivalsLink: 'O desafía directo desde Amigos y Rivales',
    claim: 'Reclamar <bdi dir="ltr">{stars}</bdi> Stars • puesto <bdi dir="ltr">#{rank}</bdi>',
    claimShort: 'Reclamar <bdi dir="ltr">{stars}</bdi> Stars • puesto <bdi dir="ltr">#{rank}</bdi>',
    enter: 'Entrar al Torneo y Clasificación',
    claimDone: 'Este premio ya fue reclamado',
    claimOk: 'Tu premio del torneo quedó registrado',
    claimFail: 'No se pudo registrar la solicitud — inténtalo de nuevo',
    guest: 'Abre este Mini App dentro de Telegram para competir',
    boardLive: 'Clasificación en vivo',
    rulesOpen: 'Reglas',
    rulesTitle: 'Reglas del torneo',
    rulesCta: 'Entendido',
    sheetTitle: 'Torneo semanal',
    boardHeadStart: 'Jugador y puesto',
    boardHeadEnd: 'Victorias y premio',
    tier1: 'Primer puesto',
    tier2: 'Segundo puesto',
    tier3: 'Tercer puesto',
    you: 'TÚ',
    empty: 'Aún no hay participantes — ¡pulsa Unirse gratis y sé el primero!',
    prizeTag: '<bdi dir="ltr">{stars}</bdi> STARS',
    rowSub: 'Amigos <bdi dir="ltr">{friendWins}</bdi> • Bot Hard <bdi dir="ltr">{botWins}</bdi>',
    players: 'Jugadores',
    enrolled: 'Inscrito',
    join: 'Unirse gratis',
    joinOk: '¡Ya estás en el torneo semanal — buena suerte!',
    joinFail: 'No se pudo unir al torneo — inténtalo de nuevo',
    rulesShort: [
      { k: 'Premios semanales', v: '<bdi dir="ltr">25</bdi> / <bdi dir="ltr">15</bdi> / <bdi dir="ltr">10</bdi> Stars', tone: 'gold' },
      { k: 'Puntos por victoria', v: 'Bot Hard o amigos = <bdi dir="ltr">+1</bdi>', tone: 'mint' },
      { k: 'Límite por amigo', v: 'Máx. <bdi dir="ltr">3</bdi> victorias / amigo', tone: 'plain' },
      { k: 'Partida válida', v: 'Mín. <bdi dir="ltr">45</bdi>s y <bdi dir="ltr">10</bdi> movimientos', tone: 'plain' },
    ],
    warsOff: 'En pausa • Vuelve pronto',
  },
};

let challengeView: ChallengeView | null = null;
let challengeWindowEnd = 0;
let challengeRolled = false;
let challengeRefreshing = false;
let challengeTicket = '';
let challengeBotStartedAt = 0;
let challengeClaimBusy = false;
let challengeJoinBusy = false;
/** One background enrollment repair at a time; only a `/me` miss can schedule it. */
let challengeSelfHealing = false;
let challengeReady = false;
let challengeSheet: ModalHandle | null = null;
let challengeBoardSig = '';
/** The key that opened the floating rules card, so focus can land back on it. */
let challengeRulesOpener: HTMLElement | null = null;
/**
 * This device's own week, painted before the room answers. `isEnrolled` is a one-way latch and
 * the board holds this reader's seat until the room serves its own row. The window end is stored
 * with it, so a reload on the same week never asks the reader to join twice.
 */
interface ChallengeLocalState {
  isEnrolled: boolean;
  leaderboard: ChallengeRowView[];
  myPosition: number;
  totalParticipants: number;
  weekEnd: number;
}
const challengeState: ChallengeLocalState = {
  isEnrolled: false,
  leaderboard: [],
  myPosition: 0,
  totalParticipants: 0,
  weekEnd: 0,
};
/** The delegated enrollment door is bound once, even across a sheet repaint. */
let challengeJoinDelegated = false;

const challengeCopy = (): ChallengeCopy => CHALLENGE_COPY[lang] ?? CHALLENGE_COPY.en;

/**
 * The fixed 168-hour window, computed locally only when the room has not answered yet. It runs on
 * the exact season epoch the Worker uses, so an offline card counts down to the same boundary as
 * the live room and a launch does not silently shave the days already gone since Monday.
 */
function localChallengeWindowEnd(now = Date.now()): number {
  const weekIndex = Math.max(0, Math.floor((now - CHALLENGE_SEASON_EPOCH) / CHALLENGE_WEEK_MS));
  return CHALLENGE_SEASON_EPOCH + (weekIndex + 1) * CHALLENGE_WEEK_MS;
}

/** The exact per-window latch key the enrollment tap writes before its POST leaves the device. */
function challengeEnrollmentKey(weekEnd = challengeState.weekEnd || localChallengeWindowEnd()): string {
  return 'tactix_chal_enrolled_' + weekEnd;
}

/** Lock this device's seat for one window and remember it across reloads. Never writes false. */
function challengeRememberEnrollment(weekEnd = challengeState.weekEnd || localChallengeWindowEnd()): void {
  challengeState.isEnrolled = true;
  challengeState.weekEnd = weekEnd;
  try { localStorage.setItem(challengeEnrollmentKey(weekEnd), '1'); } catch { /* private mode */ }
}

/** Read that latch back. It only ever raises the seat; a missing key leaves it as it was. */
function challengeReadEnrollment(weekEnd = challengeState.weekEnd || localChallengeWindowEnd()): boolean {
  challengeState.weekEnd = weekEnd;
  try {
    if (localStorage.getItem(challengeEnrollmentKey(weekEnd)) === '1') challengeState.isEnrolled = true;
  } catch { /* private mode */ }
  return challengeState.isEnrolled;
}

/** One room call. Its own fetch, so a refused or offline answer never throws into the UI. */
async function challengeCall(path: string, body?: Record<string, unknown>): Promise<ChallengeView | null> {
  const url = workerUrl(path);
  if (!url) return null;
  const headers: Record<string, string> = { accept: 'application/json' };
  const init = tgInitData();
  if (init) headers['x-telegram-init-data'] = init;
  if (body) headers['content-type'] = 'application/json';
  try {
    const answer = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await answer.json() as ChallengeView;
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function challengeSetText(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el && el.textContent !== value) el.textContent = value;
}

/** Static, authored card copy only: the numerals inside it are wrapped in LTR bdi runs. */
function challengeSetHTML(id: string, html: string): void {
  const el = document.getElementById(id);
  if (el && el.innerHTML !== html) el.innerHTML = html;
}

/** One Latin figure inside its own LTR run: every number this card prints goes through here. */
function challengeBdi(value: string): HTMLElement {
  const el = document.createElement('bdi');
  el.setAttribute('dir', 'ltr');
  el.textContent = value;
  return el;
}

/** A public handle, as the board prints it: the room already stores the verified at-name. */
function challengeHandleText(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return '—';
  if (text.startsWith('@') || text.includes(' ')) return text;
  return '@' + text;
}

/** This device's own public handle, the way the room prints it: the `@username`, else the display
 * name the Telegram seat carries (its `first_name` fallback), so the optimistic board row reads
 * exactly like the row the room will serve for the same seat. */
function challengeLocalHandle(): string {
  const u = tgUser();
  const username = (u?.username ?? '').trim().replace(/^@+/, '').slice(0, 32);
  if (username) return '@' + username;
  return (u?.first_name ?? '').trim().slice(0, 40) || 'me';
}

const challengeCount = (raw: unknown): number => {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
  return Math.max(0, n);
};

/** The exact payout of one podium rank: the room's table wins, its own split is the fallback. */
function challengePrizeStars(rank: number): number {
  const table = challengeView?.prizeByRank;
  const served = table && typeof table === 'object' ? challengeCount(table[String(rank)]) : 0;
  if (served > 0) return served;
  return rank === 1 ? 25 : rank === 2 ? 15 : rank === 3 ? 10 : 0;
}

/** The room's board, sanitised and merged with this device's own optimistic seat. */
function challengeBoardRows(): ChallengeRowView[] {
  const rows = challengeView?.leaderboard;
  const out: ChallengeRowView[] = [];
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const position = challengeCount(row.position);
      if (position < 1) continue;
      out.push({
        position,
        userId: typeof row.userId === 'string' ? row.userId : '',
        handle: typeof row.handle === 'string' ? row.handle : '',
        friendWins: challengeCount(row.friendWins),
        hardBotWins: challengeCount(row.hardBotWins),
        totalWins: challengeCount(row.totalWins),
        prizeStars: row.prizeStars === undefined ? challengePrizeStars(position) : challengeCount(row.prizeStars),
        isMe: row.isMe === true,
      });
    }
  }
  /* The tap's own seat rides the board until the room serves its row: this is the only board that
     can be painted synchronously, and it survives a slow, refused or offline POST. */
  for (const row of challengeState.leaderboard) {
    if (!row || typeof row !== 'object') continue;
    if (row.isMe === true && out.some((served) => served.isMe === true)) continue;
    /* This device's own seat is never dropped as a handle collision with another row: an
       enrolled reader must always be printed, even when the room's answer lost their row. */
    const sameSeat = row.isMe !== true && out.some((served) =>
      (row.userId && served.userId === row.userId)
      || (row.handle && served.handle.trim().toLowerCase() === row.handle.trim().toLowerCase()));
    if (sameSeat) continue;
    out.push({ ...row });
  }
  /* The room ranks total wins descending; re-index locally so the tap's new row is never a
     duplicate rank, and its prize pill always follows the row it is printed on. */
  out.sort((a, b) => b.totalWins - a.totalWins || a.position - b.position);
  out.forEach((row, index) => {
    row.position = index + 1;
    row.prizeStars = challengePrizeStars(row.position);
  });
  return out;
}

/** True when a board row is this device's own seat: the room marks it `isMe`, or its id matches. */
function challengeIsSelfRow(row: ChallengeRowView | null | undefined, myUserId: string): boolean {
  if (!row || typeof row !== 'object') return false;
  return row.isMe === true || (myUserId !== '' && row.userId === myUserId);
}

/**
 * Guarantee this device's own row on the board. An enrolled reader always holds a printed seat:
 * the room's row when it served one, otherwise the optimistic row the join tap (or a restored
 * per-window latch) carries locally. The injected row takes the room's latest counters, never
 * zeroing a real total, and the rank and field size are recomputed from the merged board so the
 * pill can never print "unranked" while `isEnrolled` is true.
 */
function ensureSelfInLeaderboard(): void {
  if (challengeState.isEnrolled !== true) return;
  const myUserId = String(tgUser()?.id ?? '');
  const holdsSelf = (row: ChallengeRowView | null | undefined): boolean =>
    challengeIsSelfRow(row, myUserId);
  const merged = challengeBoardRows();
  if (!merged.some(holdsSelf)) {
    const friendWins = challengeCount(challengeView?.friendWins);
    const hardBotWins = challengeCount(challengeView?.hardBotWins);
    const totalWins = typeof challengeView?.totalWins === 'number'
      ? challengeCount(challengeView.totalWins)
      : friendWins + hardBotWins;
    challengeState.leaderboard.push({
      userId: myUserId,
      position: merged.length + 1,
      handle: challengeLocalHandle(),
      friendWins,
      hardBotWins,
      totalWins,
      prizeStars: 0,
      isMe: true,
    });
  }
  challengeState.leaderboard.sort((a, b) => b.totalWins - a.totalWins || a.position - b.position);
  const board = challengeBoardRows();
  const at = board.findIndex(holdsSelf);
  challengeState.myPosition = at >= 0 ? at + 1 : Math.max(1, challengeState.myPosition);
  challengeState.totalParticipants = Math.max(
    challengeState.totalParticipants || 0,
    challengeCount(challengeView?.totalParticipants),
    board.length,
    1,
  );
  /* The empty trophy must never replace the row of a reader who is already in the race. */
  const empty = document.getElementById('ci-empty');
  if (empty) empty.hidden = true;
}

/** The countdown is the room's window end projected onto this device's clock. */
function paintChallengeClock(): void {
  if (!challengeWindowEnd) challengeWindowEnd = localChallengeWindowEnd();
  const ms = Math.max(0, challengeWindowEnd - Date.now());
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  /* The 168-hour window reads in days until the final day, then in hours, then in minutes and
     seconds: every threshold is tested on the raw millisecond clock, not on a rounded second. */
  const line = ms >= CHALLENGE_DAY_MS
    ? days + 'd ' + hours + 'h'
    : ms >= CHALLENGE_HOUR_MS
      ? hours + 'h ' + minutes + 'm'
      : minutes + 'm ' + seconds + 's';
  /* The poster and the championship sheet print the same room clock, both inside LTR bdi runs. */
  const poster = document.getElementById('chal-countdown');
  if (poster && poster.textContent !== line) poster.textContent = line;
  const sheet = document.getElementById('ci-clock-n');
  if (sheet && sheet.textContent !== line) sheet.textContent = line;
  /* The "left / باقی‌مانده" suffix belongs to the day-scale reading only; the sub-day readings are
     self-sufficient. It is repainted with the digits, so a language switch cannot leave a stale
     word behind, and it keeps the baseline markup's digits-alone shape before the first tick. */
  const left = document.getElementById('chal-clock-left');
  if (left) {
    const word = challengeCopy().clockLeft;
    if (left.textContent !== word) left.textContent = word;
    left.hidden = ms < CHALLENGE_DAY_MS;
  }
  /* Last six hours: one static warm-amber glow, no keyframes and no blur. */
  const urgent = ms > 0 && ms <= CHALLENGE_URGENT_MS;
  const pill = poster ? poster.closest('.chal-clock') : null;
  if (pill) pill.classList.toggle('is-urgent', urgent);
  const sheetPill = document.querySelector<HTMLElement>('#challenge-info-modal .ci-clock');
  if (sheetPill) sheetPill.classList.toggle('is-urgent', urgent);
  if (ms === 0 && !challengeRolled) {
    challengeRolled = true;
    void refreshChallengeCard();
  }
}

/** Every label the poster prints, in the reader's language. */
function paintChallengeLabels(): void {
  const copy = challengeCopy();
  challengeSetText('chal-badge-t', copy.badge);
  challengeSetText('chal-prize-u', copy.prizeUnit);
  challengeSetHTML('chal-hook', copy.hook);
  challengeSetHTML('chal-podium-pill', copy.podium);
  challengeSetHTML('chal-enter-t', copy.enter);
  const clockLeft = document.getElementById('chal-clock-left');
  if (clockLeft) clockLeft.textContent = copy.clockLeft;
  challengeSetText('home-tournament-off-t', copy.warsOff);
}

/**
 * The hub's pinned scoreboard: live rank, weekly total, both sources — and the two payout keys,
 * the hub's banner and the poster's slim label, which are the same claim one tap apart.
 */
function paintChallengeTelemetry(): void {
  const copy = challengeCopy();
  const view = challengeView;
  const friend = challengeCount(view?.friendWins);
  const bot = challengeCount(view?.hardBotWins);
  const total = typeof view?.totalWins === 'number' ? challengeCount(view.totalWins) : friend + bot;
  const myUserId = String(tgUser()?.id ?? '');
  const board = challengeBoardRows();
  /* This seat's live rank is the row the board holds for it — the room's own answer or the row the
     tap inserted a round trip earlier. */
  const mineRow = board.find((row) => row.isMe === true)
    ?? (myUserId ? board.find((row) => row.userId === myUserId) : undefined)
    ?? null;
  const position = mineRow ? mineRow.position
    : Math.max(challengeCount(view?.myPosition), challengeState.myPosition);

  challengeSetText('ci-my-wins-u', copy.winsWord);
  challengeSetText('ci-bot-t', copy.botCta);
  challengeSetText('ci-friend-t', copy.friendCta);
  challengeSetText('ci-my-wins', String(total));
  /* The summary strip's muted breakdown: two Latin integers inside their own LTR runs. */
  challengeSetHTML('ci-sum-src', copy.rowSub
    .replace('{friendWins}', String(friend))
    .replace('{botWins}', String(bot)));

  const rank = document.getElementById('ci-my-rank');
  if (rank) {
    const ranked = position > 0;
    challengeSetHTML('ci-my-rank', ranked ? copy.rank.replace('{rank}', String(position)) : copy.unranked);
    rank.classList.toggle('is-none', !ranked);
  }

  /* The field pill can never read one seat fewer than the rows printed beneath it. */
  const players = Math.max(
    challengeCount(view?.totalParticipants),
    board.length,
    challengeState.totalParticipants,
  );
  challengeState.totalParticipants = players;
  challengeState.myPosition = position;
  challengeSetText('ci-players-n', String(players));
  challengeSetText('ci-players-u', copy.players);
  const field = document.getElementById('ci-players-pill');
  if (field) field.setAttribute('aria-label', players + ' ' + copy.players);

  /* The tap's latch owns the badge: it flips on synchronously and never returns to the gold key,
     even when a slow /me answer still carries the pre-join card. */
  const enrolled = challengeState.isEnrolled || view?.isEnrolled === true;
  const seated = document.getElementById('ci-seat-on');
  if (seated) seated.hidden = !enrolled;
  if (enrolled) challengeSetText('ci-seat-on-t', copy.enrolled);
  const join = document.getElementById('chal-join-btn') as HTMLButtonElement | null;
  if (join) {
    join.hidden = enrolled;
    challengeSetText('ci-seat-join-t', copy.join);
    /* Never disabled: the handler's own busy latch guards a double tap, and a dead network must
       not leave a frozen key. */
    join.disabled = false;
    join.setAttribute('aria-disabled', 'false');
    join.setAttribute('aria-busy', String(challengeJoinBusy));
  }

  /* A champion of the week that just closed collects here. Once the room stamps the payout both
     keys are gone for good, so nothing gold is left on screen that cannot be pressed. */
  const claimableRank = typeof view?.claimableRank === 'number' ? challengeCount(view.claimableRank) : 0;
  const claimableStars = typeof view?.claimableStars === 'number'
    ? challengeCount(view.claimableStars)
    : challengePrizeStars(claimableRank);
  const banner = document.getElementById('ci-claim-cta') as HTMLButtonElement | null;
  if (banner) {
    banner.hidden = claimableRank === 0;
    if (claimableRank > 0) {
      challengeSetHTML('ci-claim-t', copy.claim
        .replace('{stars}', String(claimableStars))
        .replace('{rank}', String(claimableRank)));
      banner.disabled = challengeClaimBusy;
      banner.setAttribute('aria-disabled', String(challengeClaimBusy));
    }
  }
  const poster = document.getElementById('chal-claim-cta') as HTMLButtonElement | null;
  if (poster) {
    poster.hidden = claimableRank === 0;
    if (claimableRank > 0) {
      challengeSetHTML('chal-claim-t', copy.claimShort
        .replace('{stars}', String(claimableStars))
        .replace('{rank}', String(claimableRank)));
      poster.disabled = challengeClaimBusy;
      poster.setAttribute('aria-disabled', String(challengeClaimBusy));
    }
  }
}

/** Paint every label, the live figures and both payout keys. */
function paintChallengeCard(): void {
  paintChallengeLabels();
  paintChallengeTelemetry();

  /* The parked poster's localized subtitle still opens with a trophy glyph from the old design:
     the dormant slide keeps its line, never the cartoon. */
  const warSub = document.querySelector<HTMLElement>('[data-i18n="carouselWarSubtitle"]');
  if (warSub) {
    const clean = (warSub.textContent ?? '').replace(/^[\u2600-\u27BF\u{1F300}-\u{1FAFF}]\uFE0F?\s*/u, '');
    if (clean !== warSub.textContent) warSub.textContent = clean;
  }

  if (challengeSheet?.isOpen()) paintChallengeSheet();
}

/**
 * One contender row of the championship ladder, built as nodes:
 *
 *   start — a sculpted metallic rank medallion, then the full LTR-sealed @handle with its YOU
 *           badge and the muted Hard-bot / friends split;
 *   end   — the tabular weekly total, with that rank's exact 25 / 15 / 10 Star pill beneath it.
 *
 * The handle is text, every figure is a Latin bdi run, and no authored markup carries a handle.
 */
function challengeRowNode(row: ChallengeRowView): HTMLLIElement {
  const copy = challengeCopy();
  const item = document.createElement('li');
  item.className = 'ci-row';
  item.dataset.place = String(row.position);
  if (row.isMe === true) item.classList.add('is-me');

  const start = document.createElement('div');
  start.className = 'ci-row-start';

  /* The medallion: one 38px coin, the whole "#1" token sealed in a single Latin run. */
  const rank = document.createElement('span');
  rank.className = 'ci-row-rank';
  rank.append(challengeBdi('#' + row.position));

  const info = document.createElement('div');
  info.className = 'ci-row-info';

  const top = document.createElement('div');
  top.className = 'ci-row-top';

  /* The public handle is one LTR-sealed run, so its at-sign can never flip sides in RTL. */
  const handle = document.createElement('bdi');
  handle.setAttribute('dir', 'ltr');
  handle.className = 'ci-row-handle';
  handle.textContent = challengeHandleText(row.handle);
  top.append(handle);

  if (row.isMe === true) {
    const you = document.createElement('span');
    you.className = 'ci-you';
    you.textContent = copy.you;
    top.append(you);
  }

  const sub = document.createElement('span');
  sub.className = 'ci-row-sub';
  /* Authored copy plus two integers: nothing here can carry a handle into markup. */
  sub.innerHTML = copy.rowSub
    .replace('{friendWins}', String(row.friendWins))
    .replace('{botWins}', String(row.hardBotWins));

  info.append(top, sub);
  start.append(rank, info);

  const end = document.createElement('div');
  end.className = 'ci-row-end';
  const total = document.createElement('span');
  total.className = 'ci-row-w';
  total.append(challengeBdi(String(row.totalWins)), document.createTextNode(' ' + copy.winsWord));
  end.append(total);

  const prizeStars = row.prizeStars ?? challengePrizeStars(row.position);
  if (row.position <= 3 && prizeStars > 0) {
    const prize = document.createElement('span');
    prize.className = 'ci-row-prize';
    /* Authored template plus one integer: no handle can reach this markup. */
    prize.innerHTML = copy.prizeTag.replace('{stars}', String(prizeStars));
    end.append(prize);
  }

  item.append(start, end);
  return item;
}

/** The full-participant list. It is rebuilt only when the board, the language or the seat moves. */
function paintChallengeList(rows: ChallengeRowView[]): void {
  const list = document.getElementById('ci-list');
  const empty = document.getElementById('ci-empty');
  const copy = challengeCopy();
  const sig = lang + '|' + rows
    .map((row) => [row.position, row.userId ?? '', row.handle, row.friendWins, row.hardBotWins, row.totalWins, row.prizeStars ?? 0, row.isMe === true ? 1 : 0].join(','))
    .join(';');
  if (list && sig !== challengeBoardSig) {
    challengeBoardSig = sig;
    list.textContent = '';
    for (const row of rows) list.append(challengeRowNode(row));
  }
  /* An empty field hands the whole panel to the centred trophy and its gold CTA sentence. */
  if (list) list.hidden = rows.length === 0;
  if (empty) {
    empty.hidden = rows.length > 0 || challengeState.isEnrolled === true;
    if (rows.length === 0) challengeSetText('ci-empty-t', copy.empty);
  }
}

/** The floating rules card, its own pill and the board's section label — one language per paint. */
function paintChallengeRulesCard(): void {
  const copy = challengeCopy();
  challengeSetText('ci-rules-pill-t', copy.rulesOpen);
  challengeSetHTML('cr-title', copy.rulesTitle);
  challengeSetText('cr-cta-t', copy.rulesCta);
  challengeSetText('ci-board-k', copy.boardLive);
  /* Four rows, painted in place: nothing here rebuilds a node, so an open card never flickers. */
  copy.rulesShort.forEach((rule, index) => {
    const n = String(index + 1);
    challengeSetHTML('cr-r' + n + '-k', rule.k);
    challengeSetHTML('cr-r' + n + '-v', rule.v);
    const value = document.getElementById('cr-r' + n + '-v');
    if (value) value.dataset.tone = rule.tone;
  });
}

function paintChallengeSheetLabels(): void {
  const copy = challengeCopy();
  /* The headline and the pool are two separate runs in the header: the room's whole 50-Star pool
     is the gold pill, and it is the sum of the three podium slices unless the room serves its own. */
  const pool = challengeCount(challengeView?.totalPrizePool)
    || challengePrizeStars(1) + challengePrizeStars(2) + challengePrizeStars(3);
  challengeSetHTML('ci-title', copy.sheetTitle);
  challengeSetHTML('ci-pool', copy.prizeTag.replace('{stars}', String(pool)));
  challengeSetText('ci-clock-left', copy.clockLeft);
  challengeSetHTML('ci-prize-1-k', copy.tier1);
  challengeSetHTML('ci-prize-2-k', copy.tier2);
  challengeSetHTML('ci-prize-3-k', copy.tier3);
  challengeSetText('ci-prize-1-v', String(challengePrizeStars(1)));
  challengeSetText('ci-prize-2-v', String(challengePrizeStars(2)));
  challengeSetText('ci-prize-3-v', String(challengePrizeStars(3)));
  challengeSetText('ci-prize-1-u', copy.prizeUnit);
  challengeSetText('ci-prize-2-u', copy.prizeUnit);
  challengeSetText('ci-prize-3-u', copy.prizeUnit);
  challengeSetText('ci-empty-t', copy.empty);
  paintChallengeRulesCard();
}

function paintChallengeSheet(): void {
  paintChallengeSheetLabels();
  paintChallengeTelemetry();
  const rows = challengeBoardRows();
  paintChallengeList(rows);
}

/** Open the hub: it is one board now, the live standings. `focusClaim` lands on the payout banner. */
function openChallengeSheet(opener?: HTMLElement | null, focusClaim = false): void {
  const root = document.getElementById('challenge-info-modal');
  if (!root) return;
  if (!challengeSheet) challengeSheet = createModal(root, { onClose: () => closeChallengeRules(false) });
  challengeBoardSig = '';
  paintChallengeSheet();
  challengeSheet.open(opener ?? null);
  if (focusClaim) {
    const claim = document.getElementById('ci-claim-cta') as HTMLButtonElement | null;
    if (claim && !claim.hidden) {
      try { claim.focus({ preventScroll: true }); } catch { /* nothing focusable */ }
    }
  }
  /* A board that was never read paints zeros; one background read fills it in place. */
  void refreshChallengeCard();
}

/** Adopt one room answer: figures, live rank, the board and the projected window end. */
function applyChallengeView(view: ChallengeView): void {
  challengeView = view;
  if (view.auth === 'guest' || view.auth === 'telegram') challengeView.auth = view.auth;
  const endsIn = typeof view.endsInMs === 'number' && Number.isFinite(view.endsInMs) ? view.endsInMs : 0;
  challengeWindowEnd = endsIn > 0
    ? Date.now() + endsIn
    : (view.windowEnd && view.windowEnd > Date.now() ? view.windowEnd : localChallengeWindowEnd());
  if (endsIn > 0) challengeRolled = false;
  /* The latch is per window: read it back with the window the room just named, and never let a
     stale answer turn an enrolled seat back into a join key. */
  const liveEnd = typeof view.windowEnd === 'number' && view.windowEnd > Date.now()
    ? view.windowEnd
    : (challengeWindowEnd || localChallengeWindowEnd());
  /* A new window is a new race: the previous week's optimistic row, rank and field size must not
     leak into it. The enrollment latch itself is read per window by the stored key below. */
  if (challengeState.weekEnd > 0 && challengeState.weekEnd !== liveEnd) {
    challengeState.leaderboard = [];
    challengeState.myPosition = 0;
    challengeState.totalParticipants = 0;
  }
  challengeState.weekEnd = liveEnd;
  challengeReadEnrollment(liveEnd);
  const served = Array.isArray(view.leaderboard) ? view.leaderboard : [];
  const servedMine = served.some((row) => row?.isMe === true);
  if (view.isEnrolled === true || servedMine) challengeRememberEnrollment(liveEnd);
  /* Only a served row for this seat replaces the local placeholder; a room answer that predates
     the join keeps the tap's row painted until the next read catches up. */
  if (servedMine) challengeState.leaderboard = [];
  const servedPosition = servedMine
    ? challengeCount(served.find((row) => row?.isMe === true)?.position)
    : challengeCount(view.myPosition);
  const localMine = challengeState.leaderboard.some((row) => row.isMe === true);
  /* A served row or a quiet board may lower the rank; only a pending optimistic row keeps it. */
  challengeState.myPosition = servedMine || !localMine ? servedPosition : challengeState.myPosition;
  challengeState.totalParticipants = Math.max(
    challengeState.totalParticipants,
    challengeCount(view.totalParticipants),
    served.length,
  );
  /* A room answer that pre-dates the join (or lost the row) must not erase the seat: the local
     optimistic row and this reader's rank survive until the next answer catches up. */
  ensureSelfInLeaderboard();
  paintChallengeCard();
  paintChallengeClock();
}

async function refreshChallengeCard(): Promise<void> {
  if (challengeRefreshing) return;
  challengeRefreshing = true;
  try {
    const view = await challengeCall('/api/challenge/me');
    if (!view || typeof view.totalWins !== 'number') return;
    const wasEnrolled = challengeState.isEnrolled;
    const myUserId = String(tgUser()?.id ?? '');
    const servedMine = Array.isArray(view.leaderboard)
      && view.leaderboard.some((row) => challengeIsSelfRow(row, myUserId));
    applyChallengeView(view);
    /* The local latch holds a seat the room's answer does not. Repair it through the idempotent
       join door in the background, so the next read comes back with this participant persisted. */
    if (wasEnrolled && /^[0-9]{1,20}$/.test(myUserId)
      && (view.isEnrolled !== true || !servedMine)) {
      void healChallengeEnrollment(myUserId);
    }
  } finally {
    challengeRefreshing = false;
  }
}

/**
 * Self-heal a seat the local latch holds but the room's `/me` answer does not. The join door is
 * idempotent and awaits its own storage write, so replaying it persists the participant in the
 * live window's ledger; one POST is in flight at a time and only a `/me` miss can start it.
 */
async function healChallengeEnrollment(myUserId: string): Promise<void> {
  if (challengeSelfHealing || challengeState.isEnrolled !== true) return;
  challengeSelfHealing = true;
  try {
    const view = await challengeCall('/api/challenge/join', {
      userId: myUserId,
      handle: challengeLocalHandle(),
    });
    if (view && view.isEnrolled === true && typeof view.totalWins === 'number') applyChallengeView(view);
  } finally {
    challengeSelfHealing = false;
  }
}

/** A Hard AI board is starting: stamp its clock and mint the room's one-shot ticket. */
function beginChallengeBotBoard(): void {
  challengeTicket = '';
  challengeBotStartedAt = Date.now();
  const started = challengeBotStartedAt;
  void (async () => {
    const view = await challengeCall('/api/challenge/start', {});
    if (!view || view.ok !== true || typeof view.ticket !== 'string') return;
    /* A replay may have started (and stamped a newer clock) while this ticket was in flight. */
    if (challengeBotStartedAt !== started) return;
    challengeTicket = view.ticket;
    applyChallengeView(view);
  })();
}

/**
 * The board settled. A Hard AI win is reported with its ticket + played moves; the room re-proves
 * the 45-second floor itself. Every other board only refreshes the figures (a friend win was
 * already credited by the room's own settlement).
 */
function settleChallengeBoard(won: boolean): void {
  const ticket = challengeTicket;
  const started = challengeBotStartedAt;
  const botBoard = hardBotDuel;
  challengeTicket = '';
  challengeBotStartedAt = 0;
  if (!botBoard) {
    void refreshChallengeCard();
    return;
  }
  if (!won || !ticket || !started) {
    void refreshChallengeCard();
    return;
  }
  const moves = Math.max(0, Math.floor(state.turn));
  void (async () => {
    const view = await challengeCall('/api/challenge/report', {
      ticket: ticket,
      won: true,
      moves: moves,
      difficulty: 'hard',
      format: '1v1',
    });
    if (view && typeof view.totalWins === 'number') applyChallengeView(view);
    else void refreshChallengeCard();
  })();
}

/**
 * The free one-tap enrollment key. Everything up to the POST is synchronous: the latch, the
 * stored window key, the reader's own zero-win row, its rank and the field count are painted on
 * the tap itself, so no network answer — slow, refused or offline — can leave the key dead.
 */
async function handleChallengeJoin(): Promise<void> {
  const copy = challengeCopy();
  if (challengeJoinBusy) return;
  challengeJoinBusy = true;
  impact('light');
  const myUserId = String(tgUser()?.id ?? '');
  const myHandle = challengeLocalHandle();

  /* ---- synchronous optimistic enrollment: no await above this line ---- */
  challengeState.isEnrolled = true;
  if (!challengeState.weekEnd) challengeState.weekEnd = localChallengeWindowEnd();
  try { localStorage.setItem('tactix_chal_enrolled_' + challengeState.weekEnd, '1'); } catch { /* private mode */ }
  ensureSelfInLeaderboard();
  challengeBoardSig = '';
  paintChallengeCard();

  /* ---- network reconcile: the seat is already the truth on this device ---- */
  try {
    const view = await challengeCall('/api/challenge/join', { userId: myUserId, handle: myHandle });
    if (view && view.isEnrolled === true) {
      applyChallengeView(view);
      showToast(copy.joinOk, 'success', 3400);
    } else if (view) {
      /* Never undo the latch: a guest or pre-join answer may still fill the card, but the badge
         and the stored window key stay exactly where the tap put them. */
      if (typeof view.totalWins === 'number') applyChallengeView(view);
      else paintChallengeCard();
      showToast(view.auth === 'guest' ? copy.guest : copy.joinFail,
        view.auth === 'guest' ? 'warning' : 'error', 3400);
    } else {
      /* Offline: the stored latch is the truth until the next /me read reconciles it. */
      paintChallengeCard();
    }
  } finally {
    challengeJoinBusy = false;
    paintChallengeCard();
  }
}

async function claimChallengePrize(): Promise<void> {
  const copy = challengeCopy();
  if (challengeClaimBusy) return;
  challengeClaimBusy = true;
  paintChallengeCard();
  try {
    const view = await challengeCall('/api/challenge/claim', {});
    if (!view) {
      showToast(copy.claimFail, 'error', 3400);
      return;
    }
    if (view.ok === true) {
      notify('success');
      showToast(copy.claimOk, 'success', 3800);
    } else if (view.error === 'already_claimed') {
      showToast(copy.claimDone, 'warning', 3400);
    } else {
      showToast(copy.claimFail, 'error', 3400);
    }
    if (typeof view.totalWins === 'number') applyChallengeView(view);
  } finally {
    challengeClaimBusy = false;
    paintChallengeCard();
    void refreshChallengeCard();
  }
}

/**
 * The tournament hub's mint key: ONE tap closes the hub, mints the private 1v1 room on the spot and
 * seats the host in its waiting lobby — the generic Create sheet and the format step are
 * both skipped — then hands that same room's own invite link to Telegram's picker, pre-filled with
 * the tournament challenge line.
 *
 * It reuses the friends pipeline end to end: `duelInvite.throwDuelChallenge` mints a four-digit
 * code, opens the very lobby the drawer opens (its host seat, its live code, its `Copy Link` and
 * `Invite` keys) and only then calls `openTelegramShare`. No second socket and no second protocol
 * exist for this door. The link is the room's own invite deep link (`?startapp=room_<code>`), so a
 * friend who taps it lands in the lobby ready to play instead of on a second accept key.
 *
 * A share sheet the player closes is not an error: the room was minted before the link left the
 * device, so they are already standing in the live 1v1 waiting room, exactly where the standard
 * copy/share controls are. A shell that cannot open a drawer is handed the standard friends door
 * rather than a dead tap. Only this key takes this path — the home Play with Friends flow, its hub
 * and its 1v1/2v2 selection never run through here.
 */
function startTournamentDuel(): void {
  const copy = challengeCopy();
  challengeSheet?.close();
  const thrown = throwDuelChallenge({
    /* The room invite, not the post-race duel door: same room, same seat, one less tap for the
       friend who receives it. */
    link: (code, text) => roomShareUrl(code, text),
    text: copy.duelShare,
    waiting: copy.duelWaiting,
    armed: copy.duelArmed,
  });
  /* No drawer to seat the host in (a maintenance lock, a shell still booting): the tap is still
     answered, by the standard friends door that owns the same room. */
  if (!thrown) menu.openFriends();
}

/**
 * The floating rules card. It is not a second sheet in the modal stack: it is one fixed overlay
 * above the hub (z-index 1200 against the sheet's 40), so opening it never touches the standings,
 * the seat or the scroll underneath — and dismissing it leaves the hub exactly where it was.
 */
function openChallengeRules(opener?: HTMLElement | null): void {
  const modal = document.getElementById('challenge-rules-modal');
  if (!modal || !modal.hidden) return;
  paintChallengeRulesCard();
  challengeRulesOpener = opener ?? null;
  modal.hidden = false;
  const card = modal.querySelector<HTMLElement>('.cr-card');
  try { card?.focus({ preventScroll: true }); } catch { /* nothing focusable */ }
}

/**
 * Dismiss only the card: the hub underneath keeps its seat, its board and its scroll. When the hub
 * is the one closing, focus belongs to the poster key that opened it, so it is not pulled back.
 */
function closeChallengeRules(restoreFocus = true): void {
  const modal = document.getElementById('challenge-rules-modal');
  if (!modal || modal.hidden) return;
  const opener = challengeRulesOpener;
  challengeRulesOpener = null;
  modal.hidden = true;
  if (restoreFocus && opener && opener.isConnected) {
    try { opener.focus({ preventScroll: true }); } catch { /* the key is gone */ }
  }
}

/** The poster's one key, the hub's rules pill and its floating card, wired once. */
function wireChallengeSheet(): void {
  const root = document.getElementById('challenge-info-modal');
  if (!root) return;
  /* Closing the hub takes its rules card with it, so no overlay can outlive the sheet. */
  challengeSheet = createModal(root, { onClose: () => closeChallengeRules(false) });

  const enter = document.getElementById('chal-enter-cta');
  enter?.addEventListener('click', () => {
    impact('light');
    openChallengeSheet(enter);
  });
  /* The slim poster label is the payout, not the board: it lands on the claim banner itself. */
  const posterClaim = document.getElementById('chal-claim-cta');
  posterClaim?.addEventListener('click', () => {
    impact('light');
    openChallengeSheet(posterClaim, true);
  });

  /* The header pill is the one door to the rules: the hub itself stays one clean board. */
  const rulesOpen = document.getElementById('ci-rules-open');
  rulesOpen?.addEventListener('click', () => {
    impact('light');
    openChallengeRules(rulesOpen);
  });

  const rulesModal = document.getElementById('challenge-rules-modal');
  if (rulesModal) {
    /* One delegated tap: the backdrop, the round key and the CTA dismiss only this card. */
    rulesModal.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target !== rulesModal && !target.closest('[data-chal-rules-close]')) return;
      event.preventDefault();
      impact('light');
      closeChallengeRules();
    });
    rulesModal.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeChallengeRules();
    });
  }
}

/** Boot the card: asset, listeners, the first read and the one-second window clock. */
function initChallengeCard(): void {
  if (challengeReady) return;
  challengeReady = true;
  /* Read this device's own per-window latch before the first paint: a reload inside an enrolled
     week finds the badge already on, without waiting for the room's answer. */
  challengeState.weekEnd = localChallengeWindowEnd();
  challengeReadEnrollment(challengeState.weekEnd);
  /* A restored per-window latch already owns a printed seat, before the room's first answer. */
  ensureSelfInLeaderboard();
  /* The parked Channel Wars poster and its floating shield follow the module flag, one attribute
     for the whole document. index.html ships it `off`, so a parked build never flashes the shield
     before this line runs. */
  applyChannelWarsFlag();
  const star = document.getElementById('chal-star-img') as HTMLImageElement | null;
  if (star) star.src = telegramStarsUrl;

  /* The two quick launches live in the hub now: each closes the sheet and takes its own door. */
  const botCta = document.getElementById('ci-bot-cta');
  botCta?.addEventListener('click', () => {
    impact('light');
    /* A guest can still play the board; only the crediting needs a verified Telegram seat. */
    if (challengeView?.auth === 'guest') showToast(challengeCopy().guest, 'warning', 3400);
    challengeSheet?.close();
    startGame({ difficulty: 'hard', sizes: [1, 1], quiet: true });
  });
  /* The tournament's Invite & Play Friend key is the 1-tap door: it mints the private 1v1 room,
     seats the host in it and shares its invite in one gesture. The home Play with Friends flow is
     untouched — this listener exists only on the element inside #challenge-info-modal. */
  const friendCta = document.getElementById('ci-friend-cta');
  friendCta?.addEventListener('click', () => {
    impact('light');
    /* A guest can still host the room; only the crediting needs a verified Telegram seat. */
    if (challengeView?.auth === 'guest') showToast(challengeCopy().guest, 'warning', 3400);
    startTournamentDuel();
  });
  const claim = document.getElementById('ci-claim-cta');
  claim?.addEventListener('click', () => { void claimChallengePrize(); });
  /* The enrollment key is bound twice on purpose — a direct listener on the current node and one
     delegated listener on document — so a sheet repaint or a header tick can never orphan it. */
  const joinBtn = document.getElementById('chal-join-btn');
  joinBtn?.addEventListener('click', () => { void handleChallengeJoin(); });
  if (!challengeJoinDelegated) {
    challengeJoinDelegated = true;
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('[data-chal-join]')) return;
      event.preventDefault();
      void handleChallengeJoin();
    });
  }

  wireChallengeSheet();
  paintChallengeCard();
  paintChallengeClock();
  /* The clock is one text write per second, never an HTML rebuild. It is non-essential while a
     match owns the compositor and idle entirely in a hidden WebView — coming back repaints it
     immediately, so a throttled tab can never leave a stale countdown behind. */
  window.setInterval(() => {
    if (document.hidden || router.current === 'game') return;
    paintChallengeClock();
  }, 1000);
  onLang(() => { paintChallengeCard(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { paintChallengeClock(); void refreshChallengeCard(); }
  });
  /* A slow reconcile while Home is on screen: friend wins move on the room's side, so the card
     must not need a reload to catch up. */
  window.setInterval(() => {
    if (!document.hidden && router.current === 'home') void refreshChallengeCard();
  }, 60_000);
  /* The authenticated app's boot read of /api/challenge/me is the automatic enrollment door: every
     verified Telegram seat is registered on the live week the moment Home opens, not when the hub
     does. The hub renders the room's own count and the seated badge without a second round trip. */
  void refreshChallengeCard();
}
/* ---------- boot ---------- */

mountCoins();                              // every [data-coin] slot gets the shared gold coin
/* the confrontation card is one panel shared by the ladder dossier and the Hall of Owners */
initSeize({ sheets });
menu = createMenu({ router, sheets, sheet: sheetById, start: startGame, onBack });
const shop = createShop({ sheets, sheet: sheetById });
home = createHome({
  router, sheets, start: startGame, queue: (mode) => queueMatch(mode),
  /* Channel Wars' enrolled CTA: the friends room is the only board that pays a channel TIQ, so
     the hub opens that sheet rather than queueing a match that would bank nothing. */
  openFriends: () => menu.openFriends(),
});
initChallengeCard();                           // slide 0's live counters, clock and claim
compete = createCompete({
  router, sheets, sheet: sheetById,
});
/* the Arena tab is a showcase, not a lobby: the road takes no match action */
arenaRoad = createArenaRoad();
createNotifications({ sheets });

/* ---- the in-game relic-duel channel ----
   One ambient socket listens for challenges; an accepted challenge becomes a live 1v1 on that same
   socket and routes straight to the board. The mailbox covers a challenge filed while away.
   Both open after the first frame: a challenge is a thing that arrives seconds later at the
   earliest, and a socket held open during boot is a connection the first frame cannot have. */
afterPaint(() => {
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
});

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

/* ---- Admin Command Center: the Home FAB and the live-ops stage (src/admin.ts) ----
   The panel is a lazy chunk: ~290 KB of source, five tabs and a metrics grid that only an
   appointed operator ever opens. The boot paints Home without it, and the chunk is fetched the
   moment the door is needed — here, after the first frame, because the FAB's own entitlement is
   the server's answer (`probeDoor`) and an operator's key should still appear on the same visit.
   `recordRace` rides the same chunk: it is a counter, and it can arrive a few milliseconds late. */
afterPaint(() => {
  void loadAdmin().then((m) => {
    admin = m.createAdmin({
      note: showNote,
      /* the stage is not a router screen, so it shows the BackButton itself while it is up */
      onToggle: (open) => setBackButton(open || router.current !== 'home'),
    });
    admin.mount();
  }).catch(() => { /* a chunk that never arrives leaves the game without its operator panel */ });
  startArenaSync();
});
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
  roster: ReadonlyArray<{
    name: string; bot: boolean; avatarUrl?: string | null;
    nation?: string | null; guild?: string | null; tiq?: number; difficulty?: string;
  } | null>,
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
        difficulty: s?.difficulty === 'easy' || s?.difficulty === 'normal' || s?.difficulty === 'hard'
          ? s.difficulty : menuState.difficulty,
        takenOver: false,
        connected: true,
        avatarUrl: s?.avatarUrl ?? null,
        nation: s?.nation ?? null,
        guild: s?.guild ?? null,
        tiq: s?.tiq ?? null,
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
  /* Play with friends is a room, not a race: the drawer's Start opens Create / Join (or the live
     lobby) before this hook is ever reached. Never let a friends selection fall through to a bot
     board here — a mode the player did not pick must not be what launches. */
  if (sel.id === 'room') return;
  const botTier: BotTier = menuState.difficulty;
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
  /* The room struck this seat while it was away and refused to hand it back. The board must not
     stay mounted: the one quit path drops it and lands Home, where the room's toast already is. */
  onSeatEliminated: () => quitToMenu(),
  /* A server-side maintenance refusal still raises the one-key notice. */
  onMaintenance: () => showNote(t('maintenanceBody'), false, 3200),
  /* The friends pane's second door: the H2H sheet, opened over the drawer. */
  onFriendsRivals: openFriendsRivals,
});
initFriends();
onGameModeChange(paintParty);
onLang(paintParty);
onLang(paintTeamBadges);
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
  /* a VIP's typed line rides the same socket; the room gates the entitlement again on its side */
  onCustom: (text) => { active?.sendChat(text); },
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
  /* the whole tutorial match — guided combo and free-play climax — is a silent board */
  silent: tutorialMatchLive,
});
/* Post-match reactions: the tray reads the live session when there is one, and the machine answers
   when there is not. The wire is resolved at send time, never captured, because `active` changes
   with every race. */
const banter = createBanter({
  silent: tutorialMatchLive,
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
/* THE AMBIENT BED, ARMED LAST. Boot is done (Home is mounted, the router owns the back stack), so
   this is the first moment the music controller may register its first-touch unlock and its
   Mini App lifecycle. It still fetches and decodes nothing: `bgm.mp3` waits for the player's own
   first gesture, which is the only frame where a WebView will let it play. */
initMusic();
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
  withTeamRampContext(state.seatTeam, localSide, () => {
    renderer.setTheme(liveTheme());
    renderer.setPerspective(currentPerspective());
  });
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
    /* The drawer's friends lobby is the ONE surface a room invite opens: the guest lands on the
       roster they were invited to. A link that turns out to be spent — expired, already used,
       full or gone — is answered there with a single toast on Home (`inviteRefused`), never with
       a second modal over a blank screen. */
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

/* ---------- the rally door: `?startapp=ch_<handle>` raises the Channel Wars Hub ----------
   Same rule as the squad invite: the link is a prompt. It opens the hub with the channel already
   typed into the join field, and the Join key is still the only thing that writes a roster row. */
const ralliedChannel = inviteChannelWarHandle();
if (CHANNEL_WARS_ENABLED && ralliedChannel) {
  requestAnimationFrame(() => {
    try {
      window.dispatchEvent(new CustomEvent('detour:channel-war-invite', { detail: { handle: ralliedChannel } }));
    } catch { /* a shell without CustomEvent: the hub is still one tap away on Home */ }
  });
}

/* ---------- the friend door: `?startapp=friend_<id>` pairs two rosters ----------
   Additive, never a gate: `friends.ts` matches the payload itself, files the pairing with the room,
   pins the inviter into the sheet and opens it on one confirmation line. A payload that is not a
   friend invite — every other door's — answers nothing and leaves this launch exactly as it was.
   Read on the first frame so the sheet slides over a laid-out shell, and again on focus/visibility
   by the module itself, which is what catches a warm `start_param`. */
requestAnimationFrame(() => { void acceptFriendInvite(); });

/* ---------- the rank door: `?startapp=ranks` opens the Top Minds ladder ----------
   The overtake push lands a player in this app with one promise: the board that just changed under
   them. A notification that opens on Home makes the reader go hunting for the ladder they were
   told about, so this door is a plain tab move — no sheet, no prompt, nothing to confirm — and it
   opens on the first frame, over a shell that is already laid out.

   `rankDoorConsumed` is what keeps a warm launch honest: `start_param` outlives the navigation
   that read it, so without it every focus would replay the payload and yank a player off the board
   they had since moved to. With it the payload is spent exactly once. The focus/visibility re-read
   covers the client that fills `start_param` in after the first frame (a deferred SDK, a slow
   CDN); the same value is never applied twice either way.

   The locale gate outranks it — a player who has never chosen a language meets the picker first,
   and a first-boot player has no rank to look at. Every payload but `ranks` leaves this launch
   exactly as it was. */
let rankDoorConsumed = false;
const openRankDoor = (): void => {
  if (rankDoorConsumed || !hasChosenLanguage() || startParam() !== 'ranks') return;
  rankDoorConsumed = true;
  router.go('ranks');
};
requestAnimationFrame(openRankDoor);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') openRankDoor();
});
window.addEventListener('focus', openRankDoor);
