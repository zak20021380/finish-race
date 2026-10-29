/**
 * tutorial.ts — the first-match hands-on lesson.
 *
 * Six stages over four visible steps. Step 1 shows the GOAL: the FINISH banner is the live target,
 * so the player sees where the race ends before touching a pawn. Step 2 is the pick and the forward
 * step, step 3 the single-tap wall: one tap anywhere in the highlighted groove commits it. Then the
 * lesson deliberately steps OUT of the way: the wall stands, the overlay closes, and the board is
 * normal live play for two rival steps. When the rival has gained those two rows and the local seat
 * is up again, the lesson re-opens on its own for step 4 — the mine — and gets out of the way for
 * good the instant the charge is planted.
 *
 * The module never mutates the game itself — `main.ts` performs the action, then calls `notify()`;
 * the action gate here is what told it the tap was the right one.
 *
 * Copy ships in English, Persian and Russian. The segmented switcher in the top bar repaints the
 * current step in place, persists the choice as `tactix_tut_lang`, and flips the card + ready toast
 * to RTL with Vazirmatn for Persian.
 *
 * The scrim and the input blocker share one SVG cut-out, so the spotlight is sharp and — just as
 * important — the blocker is physically absent inside it. Taps land on the real canvas or the real
 * mine key. Everything outside the hole is swallowed, and `main.ts` repeats the check at the action
 * layer for keyboard and programmatic doors.
 */

import type { Cell, Pos, WallSpec } from './rules';

export interface TutorialRect { left: number; top: number; width: number; height: number }

export interface TutorialSpot {
  rect: TutorialRect;
  /** The cut-out's own corner radius. */
  radius?: number;
}

export type TutorialStage =
  | 'goal' | 'select' | 'move'
  | 'wall'
  | 'mine-arm' | 'mine-place';
export type TutorialPhase = TutorialStage | 'done';
export type TutorialResult = 'finished' | 'skipped' | 'cancelled';
export type TutorialLang = 'en' | 'fa' | 'ru';

export const TUTORIAL_LANGS: readonly TutorialLang[] = ['en', 'fa', 'ru'];
export const TUT_LANG_KEY = 'tactix_tut_lang';

/** Every word the lesson speaks, in one language, for one stage. */
export interface TutorialStepCopy {
  step: string;
  title: string;
  body: string;
  /** Only step 1 carries a key action; every other step moves by its real board action. */
  action?: string;
}

export interface TutorialChromeCopy {
  skip: string;
  ready: string;
}

export const TUTORIAL_CHROME: Readonly<Record<TutorialLang, TutorialChromeCopy>> = {
  en: { skip: 'Skip Tutorial', ready: "YOU'RE READY! REACH THE FINISH LINE!" },
  fa: { skip: 'رد کردن آموزش', ready: 'حله، راه افتادی! حالا برو تا خط پایان!' },
  ru: { skip: 'Пропустить', ready: 'ВСЁ ГОТОВО! ВПЕРЁД К ФИНИШУ!' },
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
  | { kind: 'wall'; spec: WallSpec }
  | { kind: 'mine-arm' }
  | { kind: 'mine'; cell: Cell };

/** The live target of every stage, as values — the pure half of the action gate. */
export interface TutorialTargets {
  select: number | null;
  move: Pos | null;
  wall: WallSpec | null;
  mineArm: boolean;
  mine: Cell | null;
}

export interface TutorialTargetSelect { spot: TutorialSpot; ball: number }
export interface TutorialTargetMove { spot: TutorialSpot; to: Pos }
export interface TutorialTargetWall { spot: TutorialSpot; spec: WallSpec }
export interface TutorialTargetMine { spot: TutorialSpot; cell: Cell }

export interface TutorialHooks {
  /** Step 1's own target: the gold FINISH band across the top of the board. */
  goal(): TutorialSpot | null;
  select(): TutorialTargetSelect | null;
  move(): TutorialTargetMove | null;
  wall(): TutorialTargetWall | null;
  mineArm(): TutorialSpot | null;
  minePlace(): TutorialTargetMine | null;
  /** The gold FINISH band, re-pulsed while the movement step is up. */
  finish(): TutorialSpot | null;
  /** One fast, deterministic reply per bot seat; resolves when the local seat is on turn again. */
  reply(): Promise<void>;
  /**
   * The wall is up: the overlay is about to step aside so the race can be played for real. The
   * board releases the lesson's input gate, runs the live turns, and re-opens it at the mine.
   */
  handoff(): void;
  /** A stage began (or the lesson closed, with null): re-derive hints and the mine key. */
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
  /** Step 1 was taken: the FINISH banner was tapped, or the card's Next key was pressed. */
  advance(): void;
  /** The intermission is over: re-open the overlay on the mine lesson. */
  resume(): void;
  skip(): void;
  cancel(): void;
  allows(action: TutorialAction): boolean;
  notify(action: TutorialAction): void;
  nudge(): void;
}

export interface TutorialStepDef {
  stage: TutorialStage;
  /** The visible step number: pick + move are step 2, the wall is step 3, both mine halves 4. */
  group: number;
  icon: string;
  tone: 'goal' | 'select' | 'move' | 'wall' | 'mine';
  copy: Readonly<Record<TutorialLang, TutorialStepCopy>>;
}

/** The whole lesson, in order, in every language. Copy is deliberately short where it can be. */
export const TUTORIAL_STEPS: readonly TutorialStepDef[] = [
  {
    stage: 'goal', group: 1, icon: '#i-flag', tone: 'goal',
    copy: {
      en: {
        step: 'STEP 1 OF 4', title: 'THE GOAL',
        body: 'First player to reach the FINISH line at the top wins! '
          + 'Tap the FINISH line or Next to start.',
        action: 'Next',
      },
      fa: {
        step: 'قدم ۱ از ۴', title: 'هدف بازی',
        body: 'هرکی زودتر مهره‌ش رو به خط پایان (FINISH) اون بالا برسونه برنده‌ست! بزن بریم.',
        action: 'بزن بریم',
      },
      ru: {
        step: 'ШАГ 1 ИЗ 4', title: 'ЦЕЛЬ ИГРЫ',
        body: 'Тот, кто первым доведёт фишку до линии FINISH наверху — побеждает! Нажми далее.',
        action: 'Далее',
      },
    },
  },
  {
    stage: 'select', group: 2, icon: '#i-target', tone: 'select',
    copy: {
      en: {
        step: 'STEP 2 OF 4', title: 'SELECT YOUR PIECE',
        body: 'Tap your glowing piece to see where you can move.',
      },
      fa: {
        step: 'قدم ۲ از ۴', title: 'انتخاب مهره',
        body: 'رو مهره درخشان خودت بزن تا ببینی کجاها می‌تونی حرکت کنی.',
      },
      ru: {
        step: 'ШАГ 2 ИЗ 4', title: 'ВЫБЕРИ ФИШКУ',
        body: 'Нажми на свою светящуюся фишку, чтобы увидеть доступные ходы.',
      },
    },
  },
  {
    stage: 'move', group: 2, icon: '#i-move', tone: 'move',
    copy: {
      en: {
        step: 'STEP 2 OF 4', title: 'MOVE FORWARD',
        body: 'Tap the glowing tile ahead to move one step closer to FINISH!',
      },
      fa: {
        step: 'قدم ۲ از ۴', title: 'حرکت به جلو',
        body: 'حالا رو خونه جلویی بزن تا یه قدم به خط پایان نزدیک‌تر بشی!',
      },
      ru: {
        step: 'ШАГ 2 ИЗ 4', title: 'ХОД ВПЕРЁД',
        body: 'Нажми на светящуюся клетку впереди, чтобы шагнуть к финишу!',
      },
    },
  },
  {
    stage: 'wall', group: 3, icon: '#i-wall', tone: 'wall',
    copy: {
      en: {
        step: 'STEP 3 OF 4', title: 'PLACE A WALL',
        body: 'Tap the glowing line in front of your opponent to put up a wall '
          + 'and block their path!',
      },
      fa: {
        step: 'قدم ۳ از ۴', title: 'دیوار بکش!',
        body: 'رو این خطِ نورانی جلوی حریفت بزن تا یه دیوار بذاری و راهشو ببندی!',
      },
      ru: {
        step: 'ШАГ 3 ИЗ 4', title: 'ПОСТАВЬ СТЕНУ',
        body: 'Нажми на светящуюся линию перед соперником, чтобы преградить ему путь стеной!',
      },
    },
  },
  {
    stage: 'mine-arm', group: 4, icon: '#i-mine-tactical', tone: 'mine',
    copy: {
      en: {
        step: 'STEP 4 OF 4', title: 'ARM A TRAP',
        body: 'Tap the Mine button below to prepare a hidden trap!',
      },
      fa: {
        step: 'قدم ۴ از ۴', title: 'آماده‌سازی تله',
        body: 'رو دکمه مین اون پایین بزن تا یه تله مخفی رو آماده کنی!',
      },
      ru: {
        step: 'ШАГ 4 ИЗ 4', title: 'ПОДГОТОВЬ МИНУ',
        body: 'Нажми на кнопку мины внизу, чтобы подготовить скрытую ловушку!',
      },
    },
  },
  {
    stage: 'mine-place', group: 4, icon: '#i-mine-tactical', tone: 'mine',
    copy: {
      en: {
        step: 'STEP 4 OF 4', title: 'PLANT THE MINE',
        body: 'Tap the glowing tile ahead of your opponent to hide the mine in their path!',
      },
      fa: {
        step: 'قدم ۴ از ۴', title: 'کاشتن مین!',
        body: 'حالا رو خونه جلوی حریف بزن تا مین رو سر راهش قایم کنی! '
          + 'بره روش حسابی عقب می‌افته!',
      },
      ru: {
        step: 'ШАГ 4 ИЗ 4', title: 'УСТАНОВИ МИНУ',
        body: 'Нажми на клетку перед соперником, чтобы спрятать мину на его пути!',
      },
    },
  },
];

/** What comes after each successful action. The mine flow gets out of the way from its last stage. */
export const NEXT_STAGE: Readonly<Record<TutorialStage, TutorialStage | 'done'>> = {
  goal: 'select',
  select: 'move',
  move: 'wall',
  wall: 'mine-arm',
  'mine-arm': 'mine-place',
  'mine-place': 'done',
};

/** The stage that hands the board back: the wall is up and the overlay leaves for live play. */
export const TUTORIAL_HANDOFF: TutorialStage = 'wall';
/** Where the lesson re-opens on its own once live play has run its course. */
export const TUTORIAL_RESUME_STAGE: TutorialStage = 'mine-arm';
/** Forward rows the rival must take in live play before the mine lesson re-opens. */
export const TUTORIAL_LIVE_STEPS = 2;

/** Only local bot races teach; an online seat or a room another person holds never sees it. */
export function shouldAutoStartTutorial(o: { online: boolean; room: boolean; completed: boolean }): boolean {
  return !o.online && !o.room && !o.completed;
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
      /* step 1 is the banner (or the card's Next key): no board action belongs to it */
      return false;
    case 'select':
      return action.kind === 'select' && targets.select !== null && action.ball === targets.select;
    case 'move':
      return action.kind === 'move' && sameCell(action.to, targets.move);
    case 'wall':
      return action.kind === 'wall' && sameWall(action.spec, targets.wall);
    case 'mine-arm':
      return action.kind === 'mine-arm' && targets.mineArm;
    case 'mine-place':
      return action.kind === 'mine' && sameCell(action.cell, targets.mine);
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

/** Is a viewport point inside the live spotlight? Used by the step-3 forgiving wall tap. */
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
  const stepEl = byId<HTMLElement>('tut-step');
  const titleEl = byId<HTMLElement>('tut-title');
  const bodyEl = byId<HTMLElement>('tut-body');
  const iconUse = byId<SVGUseElement>('tut-ico-use');
  const skipBtn = byId<HTMLButtonElement>('tut-skip');
  const nextBtn = byId<HTMLButtonElement>('tut-next');
  const nextLabel = byId<HTMLElement>('tut-next-label');
  const liveEl = byId<HTMLElement>('tut-live');
  const langEl = byId<HTMLElement>('tut-lang');
  const langBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-tut-lang]'));
  const readyEl = byId<HTMLElement>('tut-ready');
  const readyTxt = byId<HTMLElement>('tut-ready-txt');

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
  let lang: TutorialLang = normalizeTutLang(readStoredLang());
  let readyTimer = 0;

  const stage = (): TutorialStage | null =>
    open ? TUTORIAL_STEPS[stepIndex].stage : null;

  const targets = (): TutorialTargets => {
    const s = stage();
    return {
      select: s === 'select' ? hooks.select()?.ball ?? null : null,
      move: s === 'move' ? hooks.move()?.to ?? null : null,
      wall: s === 'wall' ? hooks.wall()?.spec ?? null : null,
      mineArm: s === 'mine-arm' && hooks.mineArm() !== null,
      mine: s === 'mine-place' ? hooks.minePlace()?.cell ?? null : null,
    };
  };

  const spotFor = (s: TutorialStage): TutorialSpot | null => {
    switch (s) {
      case 'goal': return hooks.goal();
      case 'select': return hooks.select()?.spot ?? null;
      case 'move': return hooks.move()?.spot ?? null;
      case 'wall': return hooks.wall()?.spot ?? null;
      case 'mine-arm': return hooks.mineArm();
      case 'mine-place': return hooks.minePlace()?.spot ?? null;
    }
  };

  /** The secondary highlight: the gold FINISH band on step 2, the groove on 3, the tile on 4. */
  const aidFor = (s: TutorialStage): TutorialSpot | null => {
    switch (s) {
      case 'goal': return hooks.goal();
      case 'select': return hooks.select()?.spot ?? null;
      case 'move': return hooks.finish();
      case 'wall': return hooks.wall()?.spot ?? null;
      case 'mine-arm': return hooks.mineArm();
      case 'mine-place': return hooks.minePlace()?.spot ?? null;
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
    readyEl.dataset.lang = lang;
    readyEl.dir = dir;
    readyEl.lang = lang;
    root.dataset.lang = lang;
    for (const btn of langBtns) {
      btn.setAttribute('aria-pressed', String(btn.dataset.tutLang === lang));
    }
  };

  /** Repaint every word of the current step in the active language, without moving the flow. */
  const paintCopy = (animate = false) => {
    const def = TUTORIAL_STEPS[stepIndex];
    const copy = def.copy[lang];
    stepEl.textContent = copy.step;
    titleEl.textContent = copy.title;
    bodyEl.textContent = copy.body;
    nextLabel.textContent = copy.action ?? 'Next';
    skipBtn.textContent = TUTORIAL_CHROME[lang].skip;
    readyTxt.textContent = TUTORIAL_CHROME[lang].ready;
    liveEl.textContent = `${copy.step}. ${copy.title}. ${copy.body}`;
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

  const hideReady = () => {
    if (readyTimer) { window.clearTimeout(readyTimer); readyTimer = 0; }
    readyEl.classList.remove('show');
    readyEl.hidden = true;
  };

  const showReady = () => {
    readyTxt.textContent = TUTORIAL_CHROME[lang].ready;
    readyEl.dataset.lang = lang;
    readyEl.dir = tutorialDir(lang);
    readyEl.lang = lang;
    readyEl.hidden = false;
    readyEl.classList.remove('show');
    void readyEl.offsetWidth;
    readyEl.classList.add('show');
    if (readyTimer) window.clearTimeout(readyTimer);
    readyTimer = window.setTimeout(() => {
      readyTimer = 0;
      readyEl.classList.remove('show');
      readyEl.hidden = true;
    }, 3200);
  };

  const fullPath = (): string =>
    `M0 0H${Math.ceil(window.innerWidth)}V${Math.ceil(window.innerHeight)}H0Z`;

  const drawMask = (hole: TutorialRect | null, radius: number) => {
    clipPath.setAttribute('d', hole ? `${fullPath()} ${roundRectPath(hole, radius)}` : fullPath());
    spotEl.hidden = !hole;
    if (!hole) return;
    setBox(spotEl, hole);
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
    aidEl.dataset.kind = s === 'goal' || s === 'move' ? 'finish'
      : s === 'wall' ? 'wall' : 'tile';
    setBox(aidEl, spot.rect);
    aidEl.style.borderRadius = `${spot.radius ?? 14}px`;
  };

  const placeCard = (hole: TutorialRect | null) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const edge = 12, gap = 12;
    const cw = card.offsetWidth || 280;
    const ch = card.offsetHeight || 110;
    /* Step 1's target is the top of the screen, and the hand hangs BELOW its fingertip: park the
       card low so the pointer is never hidden under the card explaining it. */
    if (TUTORIAL_STEPS[stepIndex]?.stage === 'goal') {
      card.style.left = `${clamp((vw - cw) / 2, edge, Math.max(edge, vw - cw - edge))}px`;
      card.style.top = `${clamp(vh * 0.56, edge, Math.max(edge, vh - ch - edge))}px`;
      return;
    }
    let left = (vw - cw) / 2;
    let top = (vh - ch) / 2;
    if (hole) {
      left = clamp(hole.left + hole.width / 2 - cw / 2, edge, vw - cw - edge);
      const below = hole.top + hole.height + gap;
      const above = hole.top - gap - ch;
      /* a target in the thumb zone gets its card above it, so the dock never disappears under
         the card on the tall phones where there happens to be room below */
      if (hole.top + hole.height / 2 > vh * 0.55 && above >= edge) top = above;
      else if (below + ch <= vh - edge) top = below;
      else if (above >= edge) top = above;
      else top = clamp(below, edge, vh - ch - edge);
    }
    /* the top bar owns both corners: the card never parks on the skip key or the language pill */
    for (const barEl of [skipBtn, langEl]) {
      const bar = barEl.getBoundingClientRect();
      if (left + cw > bar.left - 8 && left < bar.right + 8 && top < bar.bottom + 8) {
        top = Math.max(top, bar.bottom + 8);
      }
    }
    card.style.left = `${left}px`;
    card.style.top = `${clamp(top, edge, Math.max(edge, vh - ch - edge))}px`;
  };

  const place = () => {
    if (!open) return;
    const def = TUTORIAL_STEPS[stepIndex];
    const spot = spotFor(def.stage);
    if (!spot) {
      drawMask(null, 0);
      aidEl.hidden = true;
      pointer.style.display = 'none';
      placeCard(null);
      return;
    }
    const pad = def.stage === 'mine-arm' ? 8 : TUTORIAL_SPOT_PAD;
    const hole = clampRect(atLeast(padRect(spot.rect, pad), 48, 48));
    drawMask(hole, spot.radius ?? 16);
    placeAid(def.stage, aidFor(def.stage));
    pointer.style.display = '';
    placePointer(spot.rect);
    placeCard(hole);
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
    const def = TUTORIAL_STEPS[stepIndex];
    /* a target can disappear with the board (a rival walked, a corner sealed): step past it, and
       finish the lesson rather than freeze on a card that asks for an impossible tap */
    if (!spotFor(def.stage)) {
      if (stepIndex >= TUTORIAL_STEPS.length - 1) { close('finished'); return; }
      stepIndex++;
      render();
      return;
    }
    flow++;
    root.dataset.stage = def.stage;
    root.dataset.tone = def.tone;
    iconUse.setAttribute('href', def.icon);
    card.dataset.tone = def.tone;
    card.hidden = false;
    skipBtn.hidden = false;
    langEl.hidden = false;
    /* Next is step 1's door and only step 1's: every other step moves by its real action */
    nextBtn.hidden = def.stage !== 'goal';
    paintCopy();
    hooks.refresh(def.stage);
    place();
    card.classList.remove('pop');
    void card.offsetWidth;
    card.classList.add('pop');
    card.focus({ preventScroll: true });
    trackFor(420);       // the screen may still be sliding in: follow the target's real box
  };

  const go = (next: TutorialStage) => {
    if (!open) return;
    const at = TUTORIAL_STEPS.findIndex((s) => s.stage === next);
    if (at < 0) { close('finished'); return; }
    stepIndex = at;
    render();
  };

  /** Step 1's door: the FINISH banner itself, or the card's Next key. */
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
    card.classList.remove('lang-swap');
    root.classList.remove('lang-swap');
    document.body.classList.remove('tutorial-live');
    detach();
    if (result === 'finished') showReady();
    else hideReady();
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

  return {
    get active() { return open; },
    get suspended() { return suspended; },
    get stage() { return stage(); },
    start() {
      if (open) return;
      open = true;
      suspended = false;
      stepIndex = 0;
      hideReady();
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
      const kind: TutorialAction['kind'] | null = now === 'goal' ? null
        : now === 'select' ? 'select'
        : now === 'move' ? 'move'
        : now === 'wall' ? 'wall'
        : now === 'mine-arm' ? 'mine-arm' : 'mine';
      if (kind === null || action.kind !== kind) return;
      if (now === TUTORIAL_HANDOFF) {
        /* One tap committed the wall, so the lesson gets out of the way at once: the player plays
           the next turns for real and `main.ts` calls resume() when the rival has gained ground. */
        suspend();
        hooks.handoff();
        return;
      }
      if (now === 'mine-place') {
        /* The mine is buried: the overlay and the lesson are done, immediately and for good. The
           rival walks onto the charge as part of the live match, not a scripted watch beat. */
        close('finished');
        return;
      }
      if (now === 'mine-arm') { go('mine-place'); return; }
      if (now === 'select') { go('move'); return; }
      /* the forward step hands the turn to the machine: one reply through the normal door, then
         the player is up again for the wall */
      const next = NEXT_STAGE[now];
      if (next === 'done') { close('finished'); return; }
      const token = ++flow;
      transitionTimer = window.setTimeout(() => {
        transitionTimer = 0;
        void hooks.reply()
          .catch(() => undefined)
          .then(() => {
            if (!open || token !== flow) return;
            go(next);
          });
      }, REPLY_BEAT_MS);
    },
    nudge() {
      if (!open) return;
      liveEl.textContent = lang === 'fa' ? 'رو هدف نورانی بزن.'
        : lang === 'ru' ? 'Нажми на светящуюся цель.'
        : 'Tap the glowing target.';
      spotEl.classList.remove('nudge');
      aidEl.classList.remove('nudge');
      void spotEl.offsetWidth;
      spotEl.classList.add('nudge');
      aidEl.classList.add('nudge');
      if (nudgeTimer) window.clearTimeout(nudgeTimer);
      nudgeTimer = window.setTimeout(() => {
        nudgeTimer = 0;
        spotEl.classList.remove('nudge');
        aidEl.classList.remove('nudge');
      }, 380);
    },
  };
}
