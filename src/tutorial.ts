/**
 * tutorial.ts — the first-match hands-on lesson: an eight-tap comeback narrative.
 *
 * The lesson is one opening card and then eight single taps, each of them a real move on the real
 * board. `main.ts` seeds the FULL match opening — both pawns on their true start tiles, one hidden
 * rival mine buried on the player's third forward step — so the choreography is deterministic:
 *
 *   PHASE 1 — opening sprint & dramatic setback (steps 1-3)
 *   1-3. advance — three taps straight ahead. The third lands on the rival's hidden charge: the
 *        engine's own detonation throws the player KNOCKBACK rows back while the rival climbs
 *        ahead. The `setback` beat holds the crater under the ambush callout.
 *
 *   PHASE 2 — the three-wall funnel (steps 4-6)
 *   4-6. wall — three pulsing ghost grooves, one tap each. The first cuts the leader's straight
 *        rush, the second bends it into a narrow corridor, the third seals the side escape so the
 *        only route left runs through the ambush square. A soft detour marker names the tile the
 *        rival is forced to take after each bar drops.
 *
 *   PHASE 3 — counter-mine & comeback sprint (steps 7-8)
 *   7. trap — one tap buries the player's charge on the choke point; the rival holds its breath.
 *   8. sprint — one tap forward, and the rival's own answer walks it onto the charge. The blast
 *      throws it two rows back and hands the lead to the player.
 *
 * There is no wall-mode toggle, no rotation step and no ✓/✕ confirmation anywhere: the gate names
 * one target per stage and `main.ts` commits it through the same `play()` a real race uses. Between
 * the taps the rival answers with its own scripted step, so the combo reads as a duel rather than a
 * slideshow.
 *
 * Each stage carries one short localized prompt in the cue banner (EN / FA / RU / AR / ES, painted
 * from `settings.ts`), a step counter in Latin digits, the pulsing spotlight and the ghost hand on
 * the exact pixel to tap. Nothing is ever stroked across the board: no route, no threat beam.
 *
 * When the counter-blast settles the lesson closes as `finished` and `main.ts` hands the player the
 * wheel for the free-play climax, under handicaps that make the race impossible to lose.
 *
 * The module never mutates the game itself — `main.ts` performs the action, then calls `notify()`;
 * the action gate here is what told it the tap was the right one. The scrim and the input blocker
 * share one SVG cut-out, so the spotlight is sharp and the blocker is physically absent inside it.
 */

import type { Cell, Pos, WallSpec } from './rules';
import { audio } from './audio';
import { impact } from './telegram';
import { lang as appLang, onLang, tIn, type LangCode } from './settings';

export interface TutorialRect { left: number; top: number; width: number; height: number }

export interface TutorialSpot {
  rect: TutorialRect;
  /** The cut-out's own corner radius. */
  radius?: number;
}

/**
 * The comeback arc, stage by stage. `setback` holds the ambush crater after the opening mine, and
 * `blast` holds the player's own charge while the rival walks into it — neither owns a board action.
 */
export type TutorialStage =
  | 'goal' | 'rush1' | 'rush2' | 'rush3' | 'setback'
  | 'wall1' | 'wall2' | 'wall3' | 'trap' | 'sprint' | 'blast';
export type TutorialPhase = TutorialStage | 'done';
export type TutorialResult = 'finished' | 'skipped' | 'cancelled';
export type TutorialLang = LangCode;

export const TUTORIAL_LANGS: readonly TutorialLang[] = ['en', 'fa', 'ru', 'ar', 'es'];
export const TUT_LANG_KEY = 'tactix_tut_lang';

/** Anything unknown (missing save, stale value) falls back to the app's own tongue, then English. */
export function normalizeTutLang(value: string | null | undefined): TutorialLang {
  return TUTORIAL_LANGS.includes(value as TutorialLang) ? (value as TutorialLang) : 'en';
}

export const tutorialDir = (lang: TutorialLang): 'rtl' | 'ltr' =>
  lang === 'fa' || lang === 'ar' ? 'rtl' : 'ltr';

/** What a tap asked the board to do. Every one of them is a single, complete action. */
export type TutorialAction =
  | { kind: 'move'; ball: number; to: Pos }
  | { kind: 'wall'; spec: WallSpec }
  | { kind: 'mine'; cell: Cell };

/** The live target of every stage, as values — the pure half of the action gate. */
export interface TutorialTargets {
  move: Pos | null;
  wall: WallSpec | null;
  mine: Cell | null;
}

export interface TutorialTargetMove { spot: TutorialSpot; ball: number; to: Pos }
export interface TutorialTargetWall { spot: TutorialSpot; spec: WallSpec }
export interface TutorialTargetMine { spot: TutorialSpot; cell: Cell }

export interface TutorialHooks {
  /** The goal card's own target: the FINISH band across the top of the board. */
  goal(): TutorialSpot | null;
  /** Steps 1-3 and 8: the square directly ahead of the player's pawn. */
  advance(): TutorialTargetMove | null;
  /** Steps 4-6: the glowing groove for wall n, committed by one tap. */
  wall(n: 1 | 2 | 3): TutorialTargetWall | null;
  /** Step 7: the choke-point square the rival is forced to take, mined by one tap. */
  mine(): TutorialTargetMine | null;
  /** The rival's forced next tile once the live wall drops: the funnel's soft detour marker. */
  detour(): TutorialSpot | null;
  /** The ambush crater: the spotlight holds it while the setback callout reads. */
  setback(): TutorialTargetMine | null;
  /** The buried charge's own square: the spotlight holds it while the rival walks into it. */
  blast(cell: Cell | null): TutorialTargetMine | null;
  /** One scripted rival beat for the stage just committed; resolves when the local seat is up again. */
  reply(stage: TutorialStage): Promise<void>;
  /** Walk the rival onto the buried charge and resolve once the real detonation has played out. */
  detonate(cell: Cell): Promise<void>;
  /** The parting cue: one gold breath over the FINISH row, drawn by the board itself. */
  finishPulse(): void;
  /** A stage began (or the lesson closed, with null): re-derive hints, ghosts and the mine key. */
  refresh(stage: TutorialStage | null): void;
  end(result: TutorialResult): void;
}

export interface Tutorial {
  /** The overlay is up and the action gate is live. */
  readonly active: boolean;
  readonly stage: TutorialStage | null;
  start(): void;
  /** The goal card was dismissed: the FINISH band was tapped, or its Start key pressed. */
  advance(): void;
  /** The race settled mid-lesson: close it as read, never as cancelled. */
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
  tone: 'goal' | 'move' | 'wall' | 'mine' | 'setback';
  /** 1..8 on the comeback's own steps; 0 on the card and the two blast beats, which wear no counter. */
  step: number;
  /** The cue banner's i18n key, or null on the stages that teach with light alone. */
  cue: string | null;
}

/** The whole lesson, in order: one card, eight taps, two detonations. */
export const TUTORIAL_STEPS: readonly TutorialStepDef[] = [
  { stage: 'goal', icon: '#i-flag', tone: 'goal', step: 0, cue: null },
  { stage: 'rush1', icon: '#i-move', tone: 'move', step: 1, cue: 'tutStep1' },
  { stage: 'rush2', icon: '#i-move', tone: 'move', step: 2, cue: 'tutStep2' },
  { stage: 'rush3', icon: '#i-move', tone: 'move', step: 3, cue: 'tutStep3' },
  { stage: 'setback', icon: '#i-bolt', tone: 'setback', step: 3, cue: 'tutSetback' },
  { stage: 'wall1', icon: '#i-wall', tone: 'wall', step: 4, cue: 'tutStep4' },
  { stage: 'wall2', icon: '#i-wall', tone: 'wall', step: 5, cue: 'tutStep5' },
  { stage: 'wall3', icon: '#i-wall', tone: 'wall', step: 6, cue: 'tutStep6' },
  { stage: 'trap', icon: '#i-mine-tactical', tone: 'mine', step: 7, cue: 'tutStep7' },
  { stage: 'sprint', icon: '#i-move', tone: 'move', step: 8, cue: 'tutStep8' },
  { stage: 'blast', icon: '#i-mine-tactical', tone: 'mine', step: 0, cue: null },
];

/** What comes after each successful action. The rival answers between every pair of taps. */
export const NEXT_STAGE: Readonly<Record<TutorialStage, TutorialStage | 'done'>> = {
  goal: 'rush1',
  rush1: 'rush2',
  rush2: 'rush3',
  rush3: 'setback',
  setback: 'wall1',
  wall1: 'wall2',
  wall2: 'wall3',
  wall3: 'trap',
  trap: 'sprint',
  sprint: 'blast',
  blast: 'done',
};

/** The action each stage answers to. The card and the two blast beats own no board action. */
const STAGE_KIND: Readonly<Record<TutorialStage, TutorialAction['kind'] | null>> = {
  goal: null,
  rush1: 'move',
  rush2: 'move',
  rush3: 'move',
  setback: null,
  wall1: 'wall',
  wall2: 'wall',
  wall3: 'wall',
  trap: 'mine',
  sprint: 'move',
  blast: null,
};

/** The four forward taps share one target hook: the square directly ahead, read from the live board. */
const MOVE_STAGES: ReadonlySet<TutorialStage> = new Set(['rush1', 'rush2', 'rush3', 'sprint']);
const WALL_N: Readonly<Partial<Record<TutorialStage, 1 | 2 | 3>>> = { wall1: 1, wall2: 2, wall3: 3 };

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
  if (MOVE_STAGES.has(stage)) {
    return action.kind === 'move' && sameCell(action.to, targets.move);
  }
  if (stage === 'wall1' || stage === 'wall2' || stage === 'wall3') {
    return action.kind === 'wall' && sameWall(action.spec, targets.wall);
  }
  if (stage === 'trap') {
    return action.kind === 'mine' && sameCell(action.cell, targets.mine);
  }
  return false;
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

const REPLY_BEAT_MS = 260;      // let the player's own move read, then the rival answers at once
/** The ambush needs a longer breath: the blast, the knockback and the callout all land first. */
const SETBACK_BEAT_MS = 1650;
/** The buried charge gets its own beat before the rival holds position over it. */
const TRAP_BEAT_MS = 420;
/** The top bar the lesson itself owns: the language segment and Skip both live in it. */
const BAR_BOTTOM = 66;

function readStoredLang(): string | null {
  try { return window.localStorage.getItem(TUT_LANG_KEY); } catch { return null; }
}
function writeStoredLang(value: TutorialLang): void {
  try { window.localStorage.setItem(TUT_LANG_KEY, value); } catch { /* storage is optional */ }
}

/** The tongue the lesson is speaking right now — the climax callout reads it too, so the hand-off
 *  lands in the same language as the eight prompts that led to it. */
let liveLang: TutorialLang = normalizeTutLang(readStoredLang() ?? appLang);
export const tutorialLang = (): TutorialLang => liveLang;

export function createTutorial(hooks: TutorialHooks): Tutorial {
  const root = byId<HTMLElement>('tutorial');
  const clipPath = byId<SVGPathElement>('tut-clip-path');
  const spotEl = byId<HTMLElement>('tut-spot');
  const aidEl = byId<HTMLElement>('tut-aid');
  const detourEl = byId<HTMLElement>('tut-detour');
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
  const cue = byId<HTMLElement>('tut-cue');
  const cueNum = byId<HTMLElement>('tut-cue-n');
  const cueText = byId<HTMLElement>('tut-cue-t');
  const cueUse = byId<SVGUseElement>('tut-cue-use');
  const langBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-tut-lang]'));

  let open = false;
  let stepIndex = 0;
  /** The square the lesson's own charge was buried on: the spotlight holds it through the blast. */
  let blastCell: Cell | null = null;
  let trackId = 0;
  let trackUntil = 0;
  let transitionTimer = 0;
  let nudgeTimer = 0;
  /** Every stage change and close bumps this, so a stale bot reply can never advance the lesson. */
  let flow = 0;
  let lang: TutorialLang = liveLang;

  const stage = (): TutorialStage | null =>
    open ? TUTORIAL_STEPS[stepIndex].stage : null;

  const targets = (): TutorialTargets => {
    const s = stage();
    const wn = s ? WALL_N[s] : undefined;
    return {
      move: s && MOVE_STAGES.has(s) ? hooks.advance()?.to ?? null : null,
      wall: wn ? hooks.wall(wn)?.spec ?? null : null,
      mine: s === 'trap' ? hooks.mine()?.cell ?? null : null,
    };
  };

  const targetFor = (s: TutorialStage): { spot: TutorialSpot } | null => {
    if (s === 'goal') { const g = hooks.goal(); return g ? { spot: g } : null; }
    if (MOVE_STAGES.has(s)) return hooks.advance();
    const wn = WALL_N[s];
    if (wn) return hooks.wall(wn);
    if (s === 'trap') return hooks.mine();
    if (s === 'setback') return hooks.setback();
    return hooks.blast(blastCell);
  };

  /**
   * The secondary highlight under the ring: the FINISH band on the goal card, the luminous ghost
   * bar on the wall steps, the charged square on the mine step and both blast beats, the target's
   * own footprint on the four moves.
   */
  const aidKind = (s: TutorialStage): string =>
    s === 'goal' ? 'finish'
      : WALL_N[s] ? 'wall'
        : s === 'trap' || s === 'blast' || s === 'setback' ? 'mine' : 'tile';

  const paintLang = () => {
    const dir = tutorialDir(lang);
    card.dataset.lang = lang;
    card.dir = dir;
    card.lang = lang;
    cue.dataset.lang = lang;
    cue.dir = dir;
    cue.lang = lang;
    skipBtn.dataset.lang = lang;
    skipBtn.dir = dir;
    skipBtn.lang = lang;
    root.dataset.lang = lang;
    langEl.setAttribute('aria-label', tIn(lang, 'tutLangAria'));
    for (const btn of langBtns) {
      btn.setAttribute('aria-pressed', String(btn.dataset.tutLang === lang));
    }
  };

  /** Repaint the card and the cue in the active language. Both are short, joined-script safe. */
  const paintCopy = (animate = false) => {
    const def = TUTORIAL_STEPS[stepIndex];
    skipBtn.textContent = tIn(lang, 'tutSkip');
    if (def.stage === 'goal') {
      const title = tIn(lang, 'tutGoalTitle');
      const body = tIn(lang, 'tutGoalBody');
      titleEl.textContent = title;
      bodyEl.textContent = body;
      nextLabel.textContent = tIn(lang, 'tutGoalAction');
      liveEl.textContent = `${title}. ${body}`;
    } else if (def.cue) {
      const line = tIn(lang, def.cue);
      cueText.textContent = line;
      cueNum.textContent = `${def.step}/8`;
      cue.setAttribute('aria-label', tIn(lang, 'tutStepAria').replace('{n}', String(def.step)));
      liveEl.textContent = line;
    } else {
      liveEl.textContent = '';
    }
    if (!animate) return;
    card.classList.remove('lang-swap');
    cue.classList.remove('lang-swap');
    root.classList.remove('lang-swap');
    void card.offsetWidth;
    card.classList.add('lang-swap');
    cue.classList.add('lang-swap');
    root.classList.add('lang-swap');
  };

  const switchLang = (next: TutorialLang, animate: boolean) => {
    if (next === lang && animate) return;
    lang = next;
    liveLang = next;
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
    aidEl.dataset.kind = aidKind(s);
    setBox(aidEl, spot.rect);
    aidEl.style.borderRadius = `${spot.radius ?? 14}px`;
  };

  /** The funnel's quiet second marker: the tile the rival is forced to take once the bar drops.
   *  Decoration only — it never owns a tap, and the ghost hand stays on the wall itself. */
  const placeDetour = (s: TutorialStage) => {
    const spot = WALL_N[s] ? hooks.detour() : null;
    detourEl.hidden = !spot;
    if (!spot) return;
    setBox(detourEl, spot.rect);
    detourEl.style.borderRadius = `${spot.radius ?? 14}px`;
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

  /**
   * The cue banner never covers the thing it is talking about. It takes whichever daylight the
   * board leaves — above the slab or below it. On a phone too short for either it sits INSIDE the
   * slab at the edge farthest from the live ring, over empty start rows: the dock, its seat chips
   * and its counters stay readable, and the ring stays clear.
   */
  const placeCue = (ring: TutorialRect | null) => {
    if (cue.hidden) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const ch = cue.offsetHeight || 54;
    const cw = Math.min(cue.offsetWidth || 300, vw - 24);
    const slab = document.getElementById('board-wrap')?.getBoundingClientRect();
    const dock = document.getElementById('chips')?.getBoundingClientRect();
    let top: number;
    if (slab && dock && slab.height > 1) {
      const below = dock.top - slab.bottom;
      const above = slab.top - BAR_BOTTOM;
      if (below >= ch + 10) top = slab.bottom + (below - ch) / 2;
      else if (above >= ch + 10) top = BAR_BOTTOM + (above - ch) / 2;
      else {
        const focus = ring ? ring.top + ring.height / 2 : slab.top + slab.height / 2;
        top = focus < slab.top + slab.height / 2 ? slab.bottom - ch - 8 : slab.top + 8;
      }
    } else {
      top = vh - ch - 10;
    }
    cue.style.left = `${clamp((vw - cw) / 2, 12, Math.max(12, vw - cw - 12))}px`;
    cue.style.top = `${clamp(top, 8, Math.max(8, vh - ch - 8))}px`;
  };

  const place = () => {
    if (!open) return;
    const def = TUTORIAL_STEPS[stepIndex];
    const s = def.stage;
    card.hidden = s !== 'goal';
    cue.hidden = !def.cue;
    const target = targetFor(s);
    if (!target) {
      drawMask(null, 0);
      placeRing(null, 0);
      aidEl.hidden = true;
      detourEl.hidden = true;
      pointer.style.display = 'none';
      if (s === 'goal') placeCard();
      placeCue(null);
      return;
    }
    const radius = target.spot.radius ?? 16;
    const ring = clampRect(atLeast(padRect(target.spot.rect, TUTORIAL_SPOT_PAD), 48, 48));
    drawMask(ring, radius);
    placeRing(ring, radius);
    placeAid(s, target.spot);
    placeDetour(s);
    pointer.style.display = '';
    placePointer(ring);
    if (s === 'goal') placeCard();
    placeCue(ring);
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
    /* A target can disappear with the board (a rival walked, a corner sealed). Step past it rather
       than freezing on a spotlight asking for an impossible tap; the lesson finishes instead. */
    for (let guard = 0; guard < TUTORIAL_STEPS.length; guard++) {
      if (targetFor(TUTORIAL_STEPS[stepIndex].stage)) break;
      if (stepIndex >= TUTORIAL_STEPS.length - 1) { close('finished'); return; }
      stepIndex++;
    }
    const def = TUTORIAL_STEPS[stepIndex];
    flow++;
    root.dataset.stage = def.stage;
    root.dataset.tone = def.tone;
    iconUse.setAttribute('href', def.icon);
    cueUse.setAttribute('href', def.icon);
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
    } else if (!cue.hidden) {
      cue.classList.remove('pop');
      void cue.offsetWidth;
      cue.classList.add('pop');
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
    go('rush1');
  };

  /**
   * One bot beat, then the next stage. Token-guarded like every other transition, so a skip, a
   * close or a stale reply can never advance a lesson that has already moved on.
   */
  const awaiting = (beatMs: number, beat: () => Promise<void>, next: () => void) => {
    const token = ++flow;
    transitionTimer = window.setTimeout(() => {
      transitionTimer = 0;
      void beat()
        .catch(() => undefined)
        .then(() => {
          if (!open || token !== flow) return;
          next();
        });
    }, beatMs);
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

  function close(result: TutorialResult) {
    if (!open) return;
    open = false;
    blastCell = null;
    flow++;
    clearTimers();
    if (trackId) { cancelAnimationFrame(trackId); trackId = 0; }
    trackUntil = 0;
    root.hidden = true;
    root.removeAttribute('data-stage');
    root.removeAttribute('data-tone');
    card.hidden = true;
    cue.hidden = true;
    card.classList.remove('lang-swap', 'pop');
    cue.classList.remove('lang-swap', 'pop');
    root.classList.remove('lang-swap');
    document.body.classList.remove('tutorial-live');
    drawMask(null, 0);
    placeRing(null, 0);
    aidEl.hidden = true;
    detourEl.hidden = true;
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
  /* the app language is the lesson's language: a switch in Settings re-reads the copy in place */
  onLang((code) => {
    const next = normalizeTutLang(code);
    if (next !== lang) switchLang(next, true);
  });

  return {
    get active() { return open; },
    get stage() { return stage(); },
    start() {
      if (open) return;
      open = true;
      stepIndex = 0;
      blastCell = null;
      root.hidden = false;
      document.body.classList.add('tutorial-live');
      attach();
      render();
      trackFor(460);   // the screen is still sliding in; follow the target's real box
    },
    advance,
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
      if (action.kind !== STAGE_KIND[now]) return;
      switch (now) {
        case 'rush1':
        case 'rush2':
          /* the rival answers the step at once, then the next tap is lit */
          awaiting(REPLY_BEAT_MS, () => hooks.reply(now), () => go(NEXT_STAGE[now] as TutorialStage));
          return;
        case 'rush3':
          /* The hidden charge already went off inside `play()`: the flash, the KNOCKBACK throw and
             the bang are the engine's own. Hold the crater under the ambush callout, let it read,
             then the rival's answer climbs into the lead. */
          go('setback');
          awaiting(SETBACK_BEAT_MS, () => hooks.reply('setback'), () => go('wall1'));
          return;
        case 'wall1':
        case 'wall2':
        case 'wall3':
          /* each bar bends the rival's route one notch deeper into the funnel; the detour marker
             and the next ghost groove are re-derived from the live board on the next stage */
          awaiting(REPLY_BEAT_MS, () => hooks.reply(now), () => go(NEXT_STAGE[now] as TutorialStage));
          return;
        case 'trap': {
          if (action.kind !== 'mine') { close('finished'); return; }
          /* The charge is buried on the choke point. The rival holds position for one beat — the
             player's forward tap is what sends it walking onto the square. */
          blastCell = action.cell;
          awaiting(TRAP_BEAT_MS, () => hooks.reply('trap'), () => go('sprint'));
          return;
        }
        case 'sprint': {
          /* The player stepped; the spotlight holds the buried square while the board walks the
             rival onto it: the blast, the knockback, the shake and the bang are the engine's own. */
          const cell = blastCell;
          go('blast');
          if (!cell) { close('finished'); return; }
          const token = ++flow;
          void hooks.detonate(cell)
            .catch(() => undefined)
            .then(() => {
              if (!open || token !== flow) return;
              hooks.finishPulse();
              impact('medium');
              audio.play('swoosh', { gain: 0.5 });
              close('finished');
            });
          return;
        }
        default:
          return;
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