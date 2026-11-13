/**
 * tutorial.ts — the first-match hands-on lesson.
 *
 * ONE card, then light. The opening GOAL card is the only words the lesson ever prints: a title,
 * one line and a Start key, dismissed by that key or by tapping the FINISH band itself. Every
 * stage after it is silent — a spotlight cut into the scrim, a pulsing ghost hand on the exact
 * pixel to tap, the board's own furniture (the pawn's legal-move dots, the rival's dashed threat
 * run), sound and haptics. Nothing to read, nothing to dismiss.
 *
 * The curriculum is the real game, performed on the real board:
 *   goal → select → move → wall-stage → wall-confirm → [live play] → mine-arm → mine-place →
 *   mine-confirm → the race itself.
 * Both placements are the REAL two-tap flow: the first tap stages a ghost and raises the board's
 * own ✓/✕ controls, the second commits it. The spotlight moves onto the green ✓ while the input
 * cut-out stays wide enough for the ✕ beside it, so cancelling is a genuine way back rather than a
 * dead disc under the guard.
 *
 * After the wall locks in, the lesson steps OUT of the way: the overlay closes, the gate releases
 * and the board is ordinary live play until the rival has taken its two turns. Then it re-opens on
 * its own for the mine, and gets out of the way for good the instant the charge is buried — with
 * one gold breath over the FINISH row as the parting "run" cue.
 *
 * The module never mutates the game itself — `main.ts` performs the action, then calls `notify()`;
 * the action gate here is what told it the tap was the right one.
 *
 * The top bar survives every stage: the EN / فارسی / RU switcher on the left, Skip on the right.
 * The choice persists as `tactix_tut_lang` and flips the card to RTL with Vazirmatn for Persian.
 *
 * The scrim and the input blocker share one SVG cut-out, so the spotlight is sharp and — just as
 * important — the blocker is physically absent inside it. Taps land on the real canvas or the real
 * mine key. Everything outside the hole is swallowed, and `main.ts` repeats the check at the action
 * layer for keyboard and programmatic doors.
 */

import type { Cell, Pos, WallSpec } from './rules';
import { audio } from './audio';
import { impact } from './telegram';
import { lang as appLang, onLang } from './settings';

export interface TutorialRect { left: number; top: number; width: number; height: number }

export interface TutorialSpot {
  rect: TutorialRect;
  /** The cut-out's own corner radius. */
  radius?: number;
}

export type TutorialStage =
  | 'goal' | 'select' | 'move'
  | 'wall-stage' | 'wall-confirm'
  | 'mine-arm' | 'mine-place' | 'mine-confirm';
export type TutorialPhase = TutorialStage | 'done';
export type TutorialResult = 'finished' | 'skipped' | 'cancelled';
export type TutorialLang = 'en' | 'fa' | 'ru';

export const TUTORIAL_LANGS: readonly TutorialLang[] = ['en', 'fa', 'ru'];
export const TUT_LANG_KEY = 'tactix_tut_lang';

/** The goal card's three lines. No kicker: this is a one-second intro, not page one of four. */
export interface TutorialStepCopy {
  title: string;
  body: string;
  action: string;
}

export const TUTORIAL_CHROME: Readonly<Record<TutorialLang, { skip: string }>> = {
  en: { skip: 'Skip' },
  fa: { skip: 'رد کردن آموزش' },
  ru: { skip: 'Пропустить' },
};

/** Anything unknown (missing save, stale value) falls back to English. */
export function normalizeTutLang(value: string | null | undefined): TutorialLang {
  return value === 'fa' || value === 'ru' || value === 'en' ? value : 'en';
}

export const tutorialDir = (lang: TutorialLang): 'rtl' | 'ltr' =>
  lang === 'fa' ? 'rtl' : 'ltr';

/** What a tap asked the board to do, in the tutorial's own vocabulary. */
export type TutorialAction =
  | { kind: 'select'; ball: number }
  | { kind: 'move'; to: Pos }
  /** first tap of the wall flow: raise the ghost and its ✓/✕ toolbar */
  | { kind: 'wall-stage'; spec: WallSpec }
  /** second tap: the green key spends the wall */
  | { kind: 'wall'; spec: WallSpec }
  | { kind: 'wall-cancel' }
  | { kind: 'mine-arm' }
  /** first tap of the mine flow: stage the charge and its ✓/✕ discs */
  | { kind: 'mine-stage'; cell: Cell }
  /** second tap: the green key buries it */
  | { kind: 'mine'; cell: Cell }
  | { kind: 'mine-cancel' };

/** The live target of every stage, as values — the pure half of the action gate. */
export interface TutorialTargets {
  select: number | null;
  move: Pos | null;
  wall: WallSpec | null;
  wallConfirm: WallSpec | null;
  mineArm: boolean;
  mine: Cell | null;
  mineConfirm: Cell | null;
}

export interface TutorialTargetSelect { spot: TutorialSpot; ball: number }
export interface TutorialTargetMove { spot: TutorialSpot; to: Pos }
export interface TutorialTargetWall {
  spot: TutorialSpot;
  spec: WallSpec;
  /** A wider input door than the ring: the whole ✓/✕ pair, so cancel stays reachable. */
  door?: TutorialRect;
}
export interface TutorialTargetMine { spot: TutorialSpot; cell: Cell; door?: TutorialRect }

export interface TutorialHooks {
  /** The goal card's own target: the FINISH band across the top of the board. */
  goal(): TutorialSpot | null;
  select(): TutorialTargetSelect | null;
  move(): TutorialTargetMove | null;
  /** The groove to stage a wall on. */
  wall(): TutorialTargetWall | null;
  /** The staged wall's green ✓, with the whole toolbar as its door. */
  wallConfirm(): TutorialTargetWall | null;
  mineArm(): TutorialSpot | null;
  minePlace(): TutorialTargetMine | null;
  /** The staged charge's green ✓, with the whole pair as its door. */
  mineConfirm(): TutorialTargetMine | null;
  /** One fast, deterministic reply per bot seat; resolves when the local seat is on turn again. */
  reply(): Promise<void>;
  /**
   * The wall is up: the overlay is about to step aside so the race can be played for real. The
   * board releases the lesson's input gate, runs the live turns, and re-opens it at the mine.
   */
  handoff(): void;
  /** The parting cue: one gold breath over the FINISH row, drawn by the board itself. */
  finishPulse(): void;
  /** A stage began (or the lesson closed, with null): re-derive hints, routes and the mine key. */
  refresh(stage: TutorialStage | null): void;
  end(result: TutorialResult): void;
}

export interface Tutorial {
  /** The overlay is up and the action gate is live. False during the live-play intermission. */
  readonly active: boolean;
  /** The lesson is between sittings: the wall is placed and the board is being played for real. */
  readonly suspended: boolean;
  readonly stage: TutorialStage | null;
  start(): void;
  /** The goal card was dismissed: the FINISH band was tapped, or its Start key pressed. */
  advance(): void;
  /** The intermission is over: re-open the overlay on the mine lesson. */
  resume(): void;
  /** The race settled while the lesson was aside: close it as read, never as cancelled. */
  complete(): void;
  skip(): void;
  cancel(): void;
  allows(action: TutorialAction): boolean;
  notify(action: TutorialAction): void;
  nudge(): void;
}

export interface TutorialStepDef {
  stage: TutorialStage;
  icon: string;
  tone: 'goal' | 'select' | 'move' | 'wall' | 'mine' | 'confirm';
  /** Present on the opening stage ONLY. Every later stage teaches with light alone. */
  copy?: Readonly<Record<TutorialLang, TutorialStepCopy>>;
}

/** The whole lesson, in order. One card at the top of it, and nothing else to read. */
export const TUTORIAL_STEPS: readonly TutorialStepDef[] = [
  {
    stage: 'goal', icon: '#i-flag', tone: 'goal',
    copy: {
      en: {
        title: 'GOAL: REACH FINISH',
        body: 'First pawn to reach the green FINISH line wins!',
        action: 'Start',
      },
      fa: {
        title: 'هدف: خط پایان',
        body: 'اولین نفری که مهره‌اش به خط سبز FINISH برسه برنده‌ست!',
        action: 'بزن بریم',
      },
      ru: {
        title: 'ЦЕЛЬ: ФИНИШ',
        body: 'Побеждает тот, кто первым доведёт фишку до линии FINISH!',
        action: 'Поехали',
      },
    },
  },
  { stage: 'select', icon: '#i-target', tone: 'select' },
  { stage: 'move', icon: '#i-move', tone: 'move' },
  { stage: 'wall-stage', icon: '#i-wall', tone: 'wall' },
  { stage: 'wall-confirm', icon: '#i-wall', tone: 'confirm' },
  { stage: 'mine-arm', icon: '#i-mine-tactical', tone: 'mine' },
  { stage: 'mine-place', icon: '#i-mine-tactical', tone: 'mine' },
  { stage: 'mine-confirm', icon: '#i-mine-tactical', tone: 'confirm' },
];

/** What comes after each successful action. The wall's green key hands over to live play instead. */
export const NEXT_STAGE: Readonly<Record<TutorialStage, TutorialStage | 'done'>> = {
  goal: 'select',
  select: 'move',
  move: 'wall-stage',
  'wall-stage': 'wall-confirm',
  'wall-confirm': 'mine-arm',
  'mine-arm': 'mine-place',
  'mine-place': 'mine-confirm',
  'mine-confirm': 'done',
};

/** A confirm stage whose controls vanished falls BACK to its own first tap, never forward. */
const CONFIRM_BACK: Partial<Record<TutorialStage, TutorialStage>> = {
  'wall-confirm': 'wall-stage',
  'mine-confirm': 'mine-place',
};

/** The action each stage answers to. Cancels are accepted by the two confirm stages on top. */
const STAGE_KIND: Readonly<Record<TutorialStage, TutorialAction['kind'] | null>> = {
  goal: null,
  select: 'select',
  move: 'move',
  'wall-stage': 'wall-stage',
  'wall-confirm': 'wall',
  'mine-arm': 'mine-arm',
  'mine-place': 'mine-stage',
  'mine-confirm': 'mine',
};

/** The stage that hands the board back: the wall is up and the overlay leaves for live play. */
export const TUTORIAL_HANDOFF: TutorialStage = 'wall-confirm';
/** Where the lesson re-opens on its own once live play has run its course. */
export const TUTORIAL_RESUME_STAGE: TutorialStage = 'mine-arm';
/** Rival turns (or forward rows) the live intermission runs before the mine lesson re-opens. */
export const TUTORIAL_LIVE_STEPS = 2;

/**
 * STRICT FIRST-TIME-ONLY rule. Only a local, single-human bot race may auto-route into the lesson,
 * and only when the persistent completion flag is NOT true. `completed` is optional on purpose: a
 * missing flag (an older save, a refused storage backend, a fresh install) IS a first launch, while
 * only the literal `true` written by `completeTutorial()` on finish or Skip closes the door for
 * good. An online seat or a room another person holds never sees the lesson.
 */
export function shouldAutoStartTutorial(o: { online: boolean; room: boolean; completed?: boolean }): boolean {
  return !o.online && !o.room && o.completed !== true;
}

export const sameCell = (a: Cell | null, b: Cell | null): boolean =>
  !!a && !!b && a.c === b.c && a.r === b.r;

export const sameWall = (a: WallSpec | null, b: WallSpec | null): boolean =>
  !!a && !!b && a.o === b.o && a.x === b.x && a.y === b.y;

/**
 * The one rule the lesson enforces: a stage only accepts the exact target it is pointing at.
 * Pure, so the whole flow and every mismatch can be asserted without a browser.
 */
export function tutorialAllows(
  stage: TutorialPhase | null,
  targets: TutorialTargets,
  action: TutorialAction,
): boolean {
  if (stage === null || stage === 'done') return false;
  switch (stage) {
    case 'goal':
      /* the card goes by its own key or by the FINISH band: no board action belongs to it */
      return false;
    case 'select':
      return action.kind === 'select' && targets.select !== null && action.ball === targets.select;
    case 'move':
      return action.kind === 'move' && sameCell(action.to, targets.move);
    case 'wall-stage':
      return action.kind === 'wall-stage' && sameWall(action.spec, targets.wall);
    case 'wall-confirm':
      if (action.kind === 'wall-cancel') return true;
      return action.kind === 'wall' && sameWall(action.spec, targets.wallConfirm);
    case 'mine-arm':
      return action.kind === 'mine-arm' && targets.mineArm;
    case 'mine-place':
      return action.kind === 'mine-stage' && sameCell(action.cell, targets.mine);
    case 'mine-confirm':
      if (action.kind === 'mine-cancel') return true;
      return action.kind === 'mine' && sameCell(action.cell, targets.mineConfirm);
    default:
      return false;
  }
}

const byId = <T extends Element>(id: string): T => document.getElementById(id) as unknown as T;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const padRect = (r: TutorialRect, pad: number): TutorialRect => ({
  left: r.left - pad,
  top: r.top - pad,
  width: r.width + pad * 2,
  height: r.height + pad * 2,
});
/** A tap target is never smaller than a thumb, even when the thing it points at is a hairline. */
const atLeast = (r: TutorialRect, minW: number, minH: number): TutorialRect => {
  const width = Math.max(r.width, minW);
  const height = Math.max(r.height, minH);
  return {
    left: r.left - (width - r.width) / 2,
    top: r.top - (height - r.height) / 2,
    width,
    height,
  };
};

/** The spotlight's pad: the groove is a hairline, the cut-out around it is a thumb. */
export const TUTORIAL_SPOT_PAD = 7;

/**
 * The exact tap box the lesson paints and cuts out for a target: its own rect, padded, floored at
 * a 48px thumb. Exported because the action layer has to accept the SAME box — a tap anywhere
 * inside the spotlight is a tap on the thing it is pointing at, not only a tap on the hairline.
 */
export function tutorialSpotBox(spot: TutorialSpot): TutorialRect {
  return atLeast(padRect(spot.rect, TUTORIAL_SPOT_PAD), 48, 48);
}

/** Is a viewport point inside the live spotlight? Used by the forgiving groove tap. */
export function tutorialSpotHas(spot: TutorialSpot, x: number, y: number): boolean {
  const r = tutorialSpotBox(spot);
  return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
}

const roundRectPath = (r: TutorialRect, radius: number): string => {
  const x = r.left, y = r.top, w = Math.max(0, r.width), h = Math.max(0, r.height);
  const k = Math.min(radius, w / 2, h / 2);
  return `M${x + k} ${y}H${x + w - k}A${k} ${k} 0 0 1 ${x + w} ${y + k}`
    + `V${y + h - k}A${k} ${k} 0 0 1 ${x + w - k} ${y + h}`
    + `H${x + k}A${k} ${k} 0 0 1 ${x} ${y + h - k}`
    + `V${y + k}A${k} ${k} 0 0 1 ${x + k} ${y}Z`;
};
const setBox = (el: HTMLElement, r: TutorialRect) => {
  el.style.left = `${r.left}px`;
  el.style.top = `${r.top}px`;
  el.style.width = `${Math.max(0, r.width)}px`;
  el.style.height = `${Math.max(0, r.height)}px`;
};

const REPLY_BEAT_MS = 200;      // let the player's own move read, then the rival answers at once

function readStoredLang(): string | null {
  try { return window.localStorage.getItem(TUT_LANG_KEY); } catch { return null; }
}
function writeStoredLang(value: TutorialLang): void {
  try { window.localStorage.setItem(TUT_LANG_KEY, value); } catch { /* storage is optional */ }
}

export function createTutorial(hooks: TutorialHooks): Tutorial {
  const root = byId<HTMLElement>('tutorial');
  const clipPath = byId<SVGPathElement>('tut-clip-path');
  const spotEl = byId<HTMLElement>('tut-spot');
  const aidEl = byId<HTMLElement>('tut-aid');
  const pointer = byId<HTMLElement>('tut-pointer');
  const card = byId<HTMLElement>('tut-card');
  const titleEl = byId<HTMLElement>('tut-title');
  const bodyEl = byId<HTMLElement>('tut-body');
  const iconUse = byId<SVGUseElement>('tut-ico-use');
  const skipBtn = byId<HTMLButtonElement>('tut-skip');
  const nextBtn = byId<HTMLButtonElement>('tut-next');
  const nextLabel = byId<HTMLElement>('tut-next-label');
  const liveEl = byId<HTMLElement>('tut-live');
  const langEl = byId<HTMLElement>('tut-lang');
  const langBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-tut-lang]'));

  let open = false;
  /** The wall is up and the board is being played for real: no overlay, no gate, step held. */
  let suspended = false;
  let stepIndex = 0;
  let trackId = 0;
  let trackUntil = 0;
  let transitionTimer = 0;
  let nudgeTimer = 0;
  /** Every stage change and close bumps this, so a stale bot reply can never advance the lesson. */
  let flow = 0;
  let lang: TutorialLang = normalizeTutLang(readStoredLang() ?? appLang);

  const stage = (): TutorialStage | null =>
    open ? TUTORIAL_STEPS[stepIndex].stage : null;

  const targets = (): TutorialTargets => {
    const s = stage();
    return {
      select: s === 'select' ? hooks.select()?.ball ?? null : null,
      move: s === 'move' ? hooks.move()?.to ?? null : null,
      wall: s === 'wall-stage' ? hooks.wall()?.spec ?? null : null,
      wallConfirm: s === 'wall-confirm' ? hooks.wallConfirm()?.spec ?? null : null,
      mineArm: s === 'mine-arm' && hooks.mineArm() !== null,
      mine: s === 'mine-place' ? hooks.minePlace()?.cell ?? null : null,
      mineConfirm: s === 'mine-confirm' ? hooks.mineConfirm()?.cell ?? null : null,
    };
  };

  /** The ring's own box, plus the (possibly wider) door the input guard leaves open. */
  const targetFor = (s: TutorialStage): { spot: TutorialSpot; door?: TutorialRect } | null => {
    switch (s) {
      case 'goal': { const g = hooks.goal(); return g ? { spot: g } : null; }
      case 'select': return hooks.select();
      case 'move': return hooks.move();
      case 'wall-stage': return hooks.wall();
      case 'wall-confirm': return hooks.wallConfirm();
      case 'mine-arm': { const m = hooks.mineArm(); return m ? { spot: m } : null; }
      case 'mine-place': return hooks.minePlace();
      case 'mine-confirm': return hooks.mineConfirm();
    }
  };

  /**
   * The secondary highlight under the ring: the FINISH band on the goal card, the target's own
   * footprint otherwise. The forward step gets none — the board is drawing the pawn's real legal
   * dots, and a gold band at the far end of the slab only pulls the eye off them. A staged pair
   * gets none either: the ghost bar or the charged square is already there.
   */
  const aidFor = (s: TutorialStage, target: { spot: TutorialSpot }): TutorialSpot | null => {
    switch (s) {
      case 'move':
      case 'wall-confirm':
      case 'mine-confirm': return null;
      default: return target.spot;
    }
  };

  const paintLang = () => {
    const dir = tutorialDir(lang);
    card.dataset.lang = lang;
    card.dir = dir;
    card.lang = lang;
    skipBtn.dataset.lang = lang;
    skipBtn.dir = dir;
    skipBtn.lang = lang;
    root.dataset.lang = lang;
    for (const btn of langBtns) {
      btn.setAttribute('aria-pressed', String(btn.dataset.tutLang === lang));
    }
  };

  /** Repaint the goal card in the active language. Every later stage has nothing to repaint. */
  const paintCopy = (animate = false) => {
    const copy = TUTORIAL_STEPS[stepIndex].copy?.[lang];
    skipBtn.textContent = TUTORIAL_CHROME[lang].skip;
    if (copy) {
      titleEl.textContent = copy.title;
      bodyEl.textContent = copy.body;
      nextLabel.textContent = copy.action;
      liveEl.textContent = `${copy.title}. ${copy.body}`;
    } else {
      liveEl.textContent = '';
    }
    if (!animate) return;
    card.classList.remove('lang-swap');
    root.classList.remove('lang-swap');
    void card.offsetWidth;
    card.classList.add('lang-swap');
    root.classList.add('lang-swap');
  };

  const switchLang = (next: TutorialLang, animate: boolean) => {
    if (next === lang && animate) return;
    lang = next;
    paintLang();
    paintCopy(animate);
    if (animate) {
      writeStoredLang(next);
      if (open) { place(); trackFor(260); }
    }
  };

  const fullPath = (): string =>
    `M0 0H${Math.ceil(window.innerWidth)}V${Math.ceil(window.innerHeight)}H0Z`;

  /** The scrim and the input guard share this one path: the hole is both sharp and pressable. */
  const drawMask = (hole: TutorialRect | null, radius: number) => {
    clipPath.setAttribute('d', hole ? `${fullPath()} ${roundRectPath(hole, radius)}` : fullPath());
  };

  /** The neon ring keeps its own box: on a staged pair it rings the green key, not the whole door. */
  const placeRing = (rect: TutorialRect | null, radius: number) => {
    spotEl.hidden = !rect;
    if (!rect) return;
    setBox(spotEl, rect);
    spotEl.style.borderRadius = `${radius}px`;
  };

  const clampRect = (r: TutorialRect): TutorialRect => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = clamp(r.left, 0, Math.max(0, vw - 8));
    const top = clamp(r.top, 0, Math.max(0, vh - 8));
    return {
      left,
      top,
      width: clamp(r.width, 8, vw - left),
      height: clamp(r.height, 8, vh - top),
    };
  };

  const placePointer = (rect: TutorialRect) => {
    /* the SVG's contact tip sits at the container's origin: anchoring it on the target centre
       puts the glowing fingertip on the exact pixel the player must hit, with the body below it */
    const x = clamp(rect.left + rect.width / 2, 22, window.innerWidth - 22);
    const y = clamp(rect.top + rect.height / 2, 20, window.innerHeight - 20);
    pointer.style.left = `${x}px`;
    pointer.style.top = `${y}px`;
  };

  const placeAid = (s: TutorialStage, spot: TutorialSpot | null) => {
    aidEl.hidden = !spot;
    if (!spot) return;
    aidEl.dataset.kind = s === 'goal' ? 'finish'
      : s === 'wall-stage' || s === 'wall-confirm' ? 'wall' : 'tile';
    setBox(aidEl, spot.rect);
    aidEl.style.borderRadius = `${spot.radius ?? 14}px`;
  };

  /** The goal card parks low: its target is the top of the screen and the hand hangs below it. */
  const placeCard = () => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const edge = 12;
    const cw = card.offsetWidth || 280;
    const ch = card.offsetHeight || 110;
    card.style.left = `${clamp((vw - cw) / 2, edge, Math.max(edge, vw - cw - edge))}px`;
    card.style.top = `${clamp(vh * 0.56, edge, Math.max(edge, vh - ch - edge))}px`;
  };

  const place = () => {
    if (!open) return;
    const s = TUTORIAL_STEPS[stepIndex].stage;
    /* THE rule of this lesson: the goal card is the only text surface it ever shows. */
    card.hidden = s !== 'goal';
    const target = targetFor(s);
    if (!target) {
      drawMask(null, 0);
      placeRing(null, 0);
      aidEl.hidden = true;
      pointer.style.display = 'none';
      if (s === 'goal') placeCard();
      return;
    }
    const pad = s === 'mine-arm' ? 8 : TUTORIAL_SPOT_PAD;
    const radius = target.spot.radius ?? 16;
    const ring = clampRect(atLeast(padRect(target.spot.rect, pad), 48, 48));
    /* A staged pair opens its WHOLE box to input — the cancel key beside the green one is a real
       way back — while the ring and the ghost hand stay on the confirm key alone. */
    const door = target.door ? clampRect(padRect(target.door, pad)) : ring;
    drawMask(door, target.door ? 14 : radius);
    placeRing(ring, radius);
    placeAid(s, aidFor(s, target));
    pointer.style.display = '';
    placePointer(ring);
    if (s === 'goal') placeCard();
  };

  const track = () => {
    trackId = 0;
    place();
    if (performance.now() < trackUntil) trackId = requestAnimationFrame(track);
  };
  const trackFor = (ms: number) => {
    trackUntil = Math.max(trackUntil, performance.now() + ms);
    if (!trackId) trackId = requestAnimationFrame(track);
  };
  const onResize = () => trackFor(160);

  const onKeydown = (e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close('skipped');
    }
  };

  const clearTimers = () => {
    if (transitionTimer) { window.clearTimeout(transitionTimer); transitionTimer = 0; }
    if (nudgeTimer) { window.clearTimeout(nudgeTimer); nudgeTimer = 0; }
  };

  const render = () => {
    if (!open) return;
    /* A target can disappear with the board (a rival walked, a corner sealed, a pair with no room
       to draw). A confirm stage falls back to its own first tap; anything else steps past it, and
       the lesson finishes rather than freezing on a spotlight asking for an impossible tap. */
    for (let guard = 0; guard < TUTORIAL_STEPS.length; guard++) {
      const here = TUTORIAL_STEPS[stepIndex];
      if (targetFor(here.stage)) break;
      const back = CONFIRM_BACK[here.stage];
      const at = back ? TUTORIAL_STEPS.findIndex((s) => s.stage === back) : -1;
      if (at >= 0 && at < stepIndex && targetFor(TUTORIAL_STEPS[at].stage)) { stepIndex = at; break; }
      if (stepIndex >= TUTORIAL_STEPS.length - 1) { close('finished'); return; }
      stepIndex++;
    }
    const def = TUTORIAL_STEPS[stepIndex];
    flow++;
    root.dataset.stage = def.stage;
    root.dataset.tone = def.tone;
    iconUse.setAttribute('href', def.icon);
    skipBtn.hidden = false;
    langEl.hidden = false;
    paintCopy();
    hooks.refresh(def.stage);
    place();
    if (!card.hidden) {
      card.classList.remove('pop');
      void card.offsetWidth;
      card.classList.add('pop');
      card.focus({ preventScroll: true });
    }
    trackFor(420);       // the screen may still be sliding in: follow the target's real box
  };

  const go = (next: TutorialStage) => {
    if (!open) return;
    const at = TUTORIAL_STEPS.findIndex((s) => s.stage === next);
    if (at < 0) { close('finished'); return; }
    stepIndex = at;
    render();
  };

  /** The goal card's two doors: the FINISH band itself, or its Start key. */
  const advance = () => {
    if (!open) return;
    if (TUTORIAL_STEPS[stepIndex].stage !== 'goal') return;
    go('select');
  };

  const attach = () => {
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKeydown, true);
  };
  const detach = () => {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    window.visualViewport?.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKeydown, true);
  };

  /**
   * The live-play intermission. The wall stands, so the lesson takes its overlay AND its input gate
   * down and holds its place: step, timers and targets are kept, and `resume()` re-opens directly on
   * the mine. Nothing here ends the lesson — only the mine (or a skip) does that.
   */
  const suspend = () => {
    if (!open) return;
    open = false;
    suspended = true;
    flow++;
    clearTimers();
    if (trackId) { cancelAnimationFrame(trackId); trackId = 0; }
    trackUntil = 0;
    root.hidden = true;
    root.removeAttribute('data-stage');
    root.removeAttribute('data-tone');
    document.body.classList.remove('tutorial-live');
    /* no paint of the lesson survives the intermission: a hidden overlay must never leave a
       stale spotlight box behind for a tester (or a screen) to read */
    drawMask(null, 0);
    placeRing(null, 0);
    card.hidden = true;
    aidEl.hidden = true;
    pointer.style.display = 'none';
    detach();
    hooks.refresh(null);
  };

  function close(result: TutorialResult) {
    if (!open && !suspended) return;
    open = false;
    suspended = false;
    flow++;
    clearTimers();
    if (trackId) { cancelAnimationFrame(trackId); trackId = 0; }
    trackUntil = 0;
    root.hidden = true;
    root.removeAttribute('data-stage');
    root.removeAttribute('data-tone');
    card.hidden = true;
    card.classList.remove('lang-swap');
    root.classList.remove('lang-swap');
    document.body.classList.remove('tutorial-live');
    drawMask(null, 0);
    placeRing(null, 0);
    aidEl.hidden = true;
    pointer.style.display = 'none';
    detach();
    hooks.refresh(null);
    hooks.end(result);
  }

  skipBtn.addEventListener('click', () => close('skipped'));
  nextBtn.addEventListener('click', () => advance());
  for (const btn of langBtns) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      switchLang(normalizeTutLang(btn.dataset.tutLang), true);
      btn.focus({ preventScroll: true });
    });
  }
  switchLang(lang, false);
  /* the app language is the lesson's language: a switch in Settings re-reads the card in place */
  onLang((code) => {
    const next: TutorialLang = code === 'fa' || code === 'ru' ? code : 'en';
    if (next !== lang) switchLang(next, true);
  });

  return {
    get active() { return open; },
    get suspended() { return suspended; },
    get stage() { return stage(); },
    start() {
      if (open) return;
      open = true;
      suspended = false;
      stepIndex = 0;
      root.hidden = false;
      document.body.classList.add('tutorial-live');
      attach();
      render();
      trackFor(460);   // the screen is still sliding in; follow the target's real box
    },
    advance,
    resume() {
      if (open || !suspended) return;
      suspended = false;
      open = true;
      const at = TUTORIAL_STEPS.findIndex((s) => s.stage === TUTORIAL_RESUME_STAGE);
      if (at >= 0) stepIndex = at;
      root.hidden = false;
      document.body.classList.add('tutorial-live');
      attach();
      render();
      trackFor(460);
    },
    complete() { close('finished'); },
    skip() { close('skipped'); },
    cancel() { close('cancelled'); },
    allows(action) {
      return tutorialAllows(stage(), targets(), action);
    },
    notify(action) {
      if (!open) return;
      const now = TUTORIAL_STEPS[stepIndex].stage;
      /* The exact target was gated BEFORE the action ran. Re-running that target check here would
         fail every move/wall/mine: the action itself changed whose turn it is. Kind is enough. */
      const cancel = (now === 'wall-confirm' && action.kind === 'wall-cancel')
        || (now === 'mine-confirm' && action.kind === 'mine-cancel');
      if (!cancel && action.kind !== STAGE_KIND[now]) return;
      switch (now) {
        case 'goal':
          return;
        case 'select':
          go('move');
          return;
        case 'wall-stage':
          /* the ghost stands in its groove with the real toolbar up: the ring walks onto the key */
          go('wall-confirm');
          return;
        case 'wall-confirm':
          if (cancel) { go('wall-stage'); return; }
          /* The wall is locked in. The lesson gets out of the way at once: the player plays the
             next turns for real and main.ts calls resume() once the rival has taken its two. */
          suspend();
          hooks.handoff();
          return;
        case 'mine-arm':
          go('mine-place');
          return;
        case 'mine-place':
          go('mine-confirm');
          return;
        case 'mine-confirm':
          if (cancel) { go('mine-place'); return; }
          /* The charge is buried. play() already handed the turn to the rival, so the board is
             live again on this same frame: the FINISH row breathes gold once and the race is on. */
          hooks.finishPulse();
          impact('medium');
          audio.play('swoosh', { gain: 0.5 });
          close('finished');
          return;
        case 'move': {
          /* the forward step hands the turn to the machine: one reply through the normal door,
             then the player is up again with the rival's threat route drawn at the wall step */
          const token = ++flow;
          transitionTimer = window.setTimeout(() => {
            transitionTimer = 0;
            void hooks.reply()
              .catch(() => undefined)
              .then(() => {
                if (!open || token !== flow) return;
                go('wall-stage');
              });
          }, REPLY_BEAT_MS);
          return;
        }
      }
    },
    nudge() {
      if (!open) return;
      /* a mis-tap answers with light, motion, a tap of haptics and a muted thud, never a word */
      impact('light');
      audio.play('move', { gain: 0.26 });
      spotEl.classList.remove('nudge');
      aidEl.classList.remove('nudge');
      pointer.classList.remove('nudge');
      void spotEl.offsetWidth;
      spotEl.classList.add('nudge');
      aidEl.classList.add('nudge');
      pointer.classList.add('nudge');
      if (nudgeTimer) window.clearTimeout(nudgeTimer);
      nudgeTimer = window.setTimeout(() => {
        nudgeTimer = 0;
        spotEl.classList.remove('nudge');
        aidEl.classList.remove('nudge');
        pointer.classList.remove('nudge');
      }, 420);
    },
  };
}
