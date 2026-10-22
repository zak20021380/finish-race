/**
 * tutorial.ts — the first-match hands-on lesson.
 *
 * There are no Next buttons. Each of the four units (the mine one is a two-part flow) owns one
 * real board action: select the pawn, step it forward, place a wall, arm the mine key, plant the
 * mine. The module never mutates the game itself — `main.ts` performs the action, then calls
 * `notify()`; the action gate here is what told it the tap was the right one.
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

export type TutorialStage = 'select' | 'move' | 'wall' | 'mine-arm' | 'mine-place';
export type TutorialPhase = TutorialStage | 'done';
export type TutorialResult = 'finished' | 'skipped' | 'cancelled';

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
  select(): TutorialTargetSelect | null;
  move(): TutorialTargetMove | null;
  wall(): TutorialTargetWall | null;
  mineArm(): TutorialSpot | null;
  minePlace(): TutorialTargetMine | null;
  /** The gold FINISH band, pulsed while the movement step is up. */
  finish(): TutorialSpot | null;
  /** One fast, deterministic reply per bot seat; resolves when the local seat is on turn again. */
  reply(): Promise<void>;
  /** A stage began (or the lesson closed, with null): re-derive hints and the mine key. */
  refresh(stage: TutorialStage | null): void;
  end(result: TutorialResult): void;
}

export interface Tutorial {
  readonly active: boolean;
  readonly stage: TutorialStage | null;
  start(): void;
  skip(): void;
  cancel(): void;
  allows(action: TutorialAction): boolean;
  notify(action: TutorialAction): void;
  nudge(): void;
}

export interface TutorialStepDef {
  stage: TutorialStage;
  /** The visible step number: the two mine halves are both step 4 of 4. */
  group: number;
  icon: string;
  tone: 'select' | 'move' | 'wall' | 'mine';
  title: string;
  body: string;
}

/** The whole lesson, in order. Copy is deliberately five words where five words will do. */
export const TUTORIAL_STEPS: readonly TutorialStepDef[] = [
  {
    stage: 'select', group: 1, icon: '#i-target', tone: 'select',
    title: 'SELECT YOUR PIECE',
    body: 'Tap your glowing piece to start.',
  },
  {
    stage: 'move', group: 2, icon: '#i-move', tone: 'move',
    title: 'MOVE TO FINISH',
    body: 'Tap the glowing tile ahead to step toward the FINISH line!',
  },
  {
    stage: 'wall', group: 3, icon: '#i-wall', tone: 'wall',
    title: 'PLACE A WALL',
    body: 'Tap the glowing slot in front of your opponent to block their path!',
  },
  {
    stage: 'mine-arm', group: 4, icon: '#i-mine-tactical', tone: 'mine',
    title: 'ARM A TRAP',
    body: 'Tap the MINE button below.',
  },
  {
    stage: 'mine-place', group: 4, icon: '#i-mine-tactical', tone: 'mine',
    title: 'PLANT THE MINE',
    body: 'Now tap the glowing tile on the board to hide your mine!',
  },
];

/** What comes after each successful action. The mine flow celebrates from its last stage. */
export const NEXT_STAGE: Readonly<Record<TutorialStage, TutorialStage | 'done'>> = {
  select: 'move',
  move: 'wall',
  wall: 'mine-arm',
  'mine-arm': 'mine-place',
  'mine-place': 'done',
};

/** Only local bot races teach; a person or a private room never sees the lesson. */
export function shouldAutoStartTutorial(o: { online: boolean; room: boolean; completed: boolean }): boolean {
  return !o.online && !o.room && !o.completed;
}

export const sameCell = (a: Cell | null, b: Cell | null): boolean =>
  !!a && !!b && a.c === b.c && a.r === b.r;

export const sameWall = (a: WallSpec | null, b: WallSpec | null): boolean =>
  !!a && !!b && a.o === b.o && a.x === b.x && a.y === b.y;

/**
 * The one rule the lesson enforces: a stage only accepts the exact target it is pointing at.
 * Pure, so the five-stage flow and every mismatch can be asserted without a browser.
 */
export function tutorialAllows(
  stage: TutorialPhase | null,
  targets: TutorialTargets,
  action: TutorialAction,
): boolean {
  if (stage === null || stage === 'done') return false;
  switch (stage) {
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
const CELEBRATE_MS = 1200;      // the "YOU'RE READY" banner, then live play

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
  const doneEl = byId<HTMLElement>('tut-done');
  const skipBtn = byId<HTMLButtonElement>('tut-skip');
  const liveEl = byId<HTMLElement>('tut-live');

  let open = false;
  let celebrating = false;
  let stepIndex = 0;
  let trackId = 0;
  let trackUntil = 0;
  let transitionTimer = 0;
  let closeTimer = 0;
  let nudgeTimer = 0;
  /** Every stage change and close bumps this, so a stale bot reply can never advance the lesson. */
  let flow = 0;

  const stage = (): TutorialStage | null =>
    open && !celebrating ? TUTORIAL_STEPS[stepIndex].stage : null;

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
      case 'select': return hooks.select()?.spot ?? null;
      case 'move': return hooks.finish();
      case 'wall': return hooks.wall()?.spot ?? null;
      case 'mine-arm': return hooks.mineArm();
      case 'mine-place': return hooks.minePlace()?.spot ?? null;
    }
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
    /* the emoji's fingertip is its top edge: anchoring the glyph's top at the target centre puts
       the finger on the exact pixel the player must hit, with the hand body below it */
    const x = clamp(rect.left + rect.width / 2, 22, window.innerWidth - 22);
    const y = clamp(rect.top + rect.height / 2, 20, window.innerHeight - 20);
    pointer.style.left = `${x}px`;
    pointer.style.top = `${y}px`;
  };

  const placeAid = (s: TutorialStage, spot: TutorialSpot | null) => {
    aidEl.hidden = !spot;
    if (!spot) return;
    aidEl.dataset.kind = s === 'move' ? 'finish' : s === 'wall' ? 'wall' : 'tile';
    setBox(aidEl, spot.rect);
    aidEl.style.borderRadius = `${spot.radius ?? 14}px`;
  };

  const placeCard = (hole: TutorialRect | null) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const edge = 12, gap = 12;
    const cw = card.offsetWidth || 280;
    const ch = card.offsetHeight || 110;
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
    /* the skip key owns the top-right corner: the card never parks on top of it */
    const skip = skipBtn.getBoundingClientRect();
    if (left + cw > skip.left - 8 && left < skip.right + 8 && top < skip.bottom + 8) {
      top = Math.max(top, skip.bottom + 8);
    }
    card.style.left = `${left}px`;
    card.style.top = `${clamp(top, edge, Math.max(edge, vh - ch - edge))}px`;
  };

  const place = () => {
    if (!open || celebrating) return;
    const def = TUTORIAL_STEPS[stepIndex];
    const spot = spotFor(def.stage);
    if (!spot) {
      drawMask(null, 0);
      aidEl.hidden = true;
      pointer.style.display = 'none';
      placeCard(null);
      return;
    }
    const pad = def.stage === 'mine-arm' ? 8 : 7;
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
    if (closeTimer) { window.clearTimeout(closeTimer); closeTimer = 0; }
    if (nudgeTimer) { window.clearTimeout(nudgeTimer); nudgeTimer = 0; }
  };

  const render = () => {
    if (!open || celebrating) return;
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
    stepEl.textContent = `STEP ${def.group} OF 4`;
    titleEl.textContent = def.title;
    bodyEl.textContent = def.body;
    iconUse.setAttribute('href', def.icon);
    card.dataset.tone = def.tone;
    card.hidden = false;
    doneEl.hidden = true;
    doneEl.classList.remove('show');
    skipBtn.hidden = false;
    liveEl.textContent = `Step ${def.group} of 4. ${def.title}. ${def.body}`;
    hooks.refresh(def.stage);
    place();
    card.classList.remove('pop');
    void card.offsetWidth;
    card.classList.add('pop');
    card.focus({ preventScroll: true });
    trackFor(420);       // the screen may still be sliding in: follow the target's real box
  };

  const go = (next: TutorialStage) => {
    if (!open || celebrating) return;
    const at = TUTORIAL_STEPS.findIndex((s) => s.stage === next);
    if (at < 0) { close('finished'); return; }
    stepIndex = at;
    render();
  };

  const celebrate = () => {
    if (!open || celebrating) return;
    celebrating = true;
    flow++;
    clearTimers();
    drawMask(null, 0);
    aidEl.hidden = true;
    pointer.style.display = 'none';
    card.hidden = true;
    doneEl.hidden = false;
    void doneEl.offsetWidth;
    doneEl.classList.add('show');
    liveEl.textContent = "You're ready! Reach the FINISH line!";
    hooks.refresh(null);
    closeTimer = window.setTimeout(() => { closeTimer = 0; close('finished'); }, CELEBRATE_MS);
  };

  function close(result: TutorialResult) {
    if (!open) return;
    open = false;
    celebrating = false;
    flow++;
    clearTimers();
    if (trackId) { cancelAnimationFrame(trackId); trackId = 0; }
    trackUntil = 0;
    root.hidden = true;
    root.removeAttribute('data-stage');
    root.removeAttribute('data-tone');
    document.body.classList.remove('tutorial-live');
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    window.visualViewport?.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKeydown, true);
    hooks.refresh(null);
    hooks.end(result);
  }

  skipBtn.addEventListener('click', () => close('skipped'));

  return {
    get active() { return open; },
    get stage() { return stage(); },
    start() {
      if (open) return;
      open = true;
      celebrating = false;
      stepIndex = 0;
      root.hidden = false;
      document.body.classList.add('tutorial-live');
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);
      window.visualViewport?.addEventListener('resize', onResize);
      document.addEventListener('keydown', onKeydown, true);
      render();
      trackFor(460);   // the screen is still sliding in; follow the target's real box
    },
    skip() { close('skipped'); },
    cancel() { close('cancelled'); },
    allows(action) {
      return tutorialAllows(stage(), targets(), action);
    },
    notify(action) {
      if (!open || celebrating) return;
      const now = TUTORIAL_STEPS[stepIndex].stage;
      /* The exact target was gated BEFORE the action ran. Re-running that target check here would
         fail every move/wall/mine: the action itself changed whose turn it is. Kind is enough. */
      const kind: TutorialAction['kind'] = now === 'select' ? 'select'
        : now === 'move' ? 'move'
        : now === 'wall' ? 'wall'
        : now === 'mine-arm' ? 'mine-arm' : 'mine';
      if (action.kind !== kind) return;
      if (now === 'mine-place') { celebrate(); return; }
      if (now === 'mine-arm') { go('mine-place'); return; }
      if (now === 'select') { go('move'); return; }
      /* move and wall hand the turn to the machine: one instant, deterministic reply, then the
         local player is up again for the next physical action */
      const next = NEXT_STAGE[now];
      if (next === 'done') { celebrate(); return; }
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
      if (!open || celebrating) return;
      liveEl.textContent = 'Tap the glowing target.';
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
