/**
 * tutorial.ts — the first-match coach marks.
 *
 * The board and dock keep their own geometry: `main.ts` hands this module viewport-space rects
 * for the live target of each step. The dim layer is an SVG-clipped scrim, so the target stays
 * sharp (and unblurred) while everything around it takes the slate mask. This module owns the
 * step copy, the pointer gesture, the card placement and the keyboard loop; it never reads the
 * game state itself.
 */

export interface TutorialRect { left: number; top: number; width: number; height: number }

export interface TutorialSpot {
  rect: TutorialRect;
  /** The cut-out's own corner radius. */
  radius?: number;
}

export interface TutorialForward {
  rect: TutorialRect;
  /** Commit the move; false keeps the step up (the rules refused it). */
  tap(): boolean;
}

export type TutorialResult = 'finished' | 'skipped' | 'cancelled';

export interface TutorialHooks {
  finish(): TutorialSpot | null;
  moves(): TutorialSpot | null;
  forward(): TutorialForward | null;
  walls(): TutorialSpot | null;
  mines(): TutorialSpot | null;
  end(result: TutorialResult): void;
}

export interface Tutorial {
  readonly active: boolean;
  start(): void;
  skip(): void;
  cancel(): void;
}

type StepTarget = 'finish' | 'moves' | 'walls' | 'mines';
type Tone = 'goal' | 'move' | 'wall' | 'mine';

interface Step {
  target: StepTarget;
  tone: Tone;
  icon: string;
  title: string;
  body: string;
  action: string | null;
}

const STEPS: readonly Step[] = [
  {
    target: 'finish', tone: 'goal', icon: '#i-flag', title: 'GOAL', action: 'Next',
    body: 'Reach the FINISH line at the top before your opponent does!',
  },
  {
    target: 'moves', tone: 'move', icon: '#i-move', title: 'MOVEMENT', action: null,
    body: 'Tap an adjacent glowing tile to step forward, left, or right.',
  },
  {
    target: 'walls', tone: 'wall', icon: '#i-wall', title: 'BLOCK', action: 'Next',
    body: 'Place walls to slow down your opponent or protect your path. You have limited walls!',
  },
  {
    target: 'mines', tone: 'mine', icon: '#i-mine-tactical', title: 'TACTICAL TRAPS',
    action: "Got it, let's play!",
    body: 'Deploy hidden mines. Stepping on a mine wounds your piece and forces a detour!',
  },
];

const byId = <T extends Element>(id: string): T => document.getElementById(id) as unknown as T;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const padRect = (r: TutorialRect, pad: number): TutorialRect => ({
  left: r.left - pad,
  top: r.top - pad,
  width: r.width + pad * 2,
  height: r.height + pad * 2,
});
const roundRectPath = (r: TutorialRect, radius: number): string => {
  const x = r.left, y = r.top, w = Math.max(0, r.width), h = Math.max(0, r.height);
  const k = Math.min(radius, w / 2, h / 2);
  return `M${x + k} ${y}H${x + w - k}A${k} ${k} 0 0 1 ${x + w} ${y + k}`
    + `V${y + h - k}A${k} ${k} 0 0 1 ${x + w - k} ${y + h}`
    + `H${x + k}A${k} ${k} 0 0 1 ${x} ${y + h - k}`
    + `V${y + k}A${k} ${k} 0 0 1 ${x + k} ${y}Z`;
};

export function createTutorial(hooks: TutorialHooks): Tutorial {
  const root = byId<HTMLElement>('tutorial');
  const clipPath = byId<SVGPathElement>('tut-clip-path');
  const spotEl = byId<HTMLElement>('tut-spot');
  const pointer = byId<HTMLElement>('tut-pointer');
  const card = byId<HTMLElement>('tut-card');
  const stepEl = byId<HTMLElement>('tut-step');
  const titleEl = byId<HTMLElement>('tut-title');
  const bodyEl = byId<HTMLElement>('tut-body');
  const iconUse = byId<SVGUseElement>('tut-ico-use');
  const nextBtn = byId<HTMLButtonElement>('tut-next');
  const forwardBtn = byId<HTMLButtonElement>('tut-forward');
  const skipBtn = byId<HTMLButtonElement>('tut-skip');
  const liveEl = byId<HTMLElement>('tut-live');

  let open = false;
  let stepIndex = 0;
  let trackId = 0;
  let trackUntil = 0;
  let stepTimer = 0;

  const targetSpot = (): TutorialSpot | null => {
    switch (STEPS[stepIndex].target) {
      case 'finish': return hooks.finish();
      case 'moves': return hooks.moves();
      case 'walls': return hooks.walls();
      case 'mines': return hooks.mines();
    }
  };

  const drawMask = (hole: TutorialRect, radius: number) => {
    const w = Math.ceil(window.innerWidth), h = Math.ceil(window.innerHeight);
    /* Even-odd subtracts the rounded hole from the full-viewport rectangle, so the scrim is a
       real cut-out rather than a stack of panels pretending to be one. */
    clipPath.setAttribute('d', `M0 0H${w}V${h}H0Z ${roundRectPath(hole, radius)}`);
    spotEl.style.left = `${hole.left}px`;
    spotEl.style.top = `${hole.top}px`;
    spotEl.style.width = `${hole.width}px`;
    spotEl.style.height = `${hole.height}px`;
    spotEl.style.borderRadius = `${radius}px`;
  };

  const placePointer = (hole: TutorialRect, forward: TutorialForward | null) => {
    let x = hole.left + hole.width / 2;
    let y = hole.top + hole.height / 2;
    if (STEPS[stepIndex].target === 'finish') {
      x = hole.left + hole.width * 0.78;
      y = hole.top + hole.height * 0.58;
    } else if (STEPS[stepIndex].target === 'moves' && forward) {
      x = forward.rect.left + forward.rect.width / 2;
      y = forward.rect.top + forward.rect.height / 2;
    } else if (STEPS[stepIndex].target === 'walls' || STEPS[stepIndex].target === 'mines') {
      /* the dock counters are tiny: point beside them, never over the icon and its digit */
      x = hole.left + hole.width + 12;
      y = hole.top + hole.height / 2;
    }
    pointer.style.left = `${clamp(x, 24, window.innerWidth - 24)}px`;
    pointer.style.top = `${clamp(y, 24, window.innerHeight - 24)}px`;
  };

  const placeForward = (forward: TutorialForward | null) => {
    if (!forward || STEPS[stepIndex].target !== 'moves') {
      forwardBtn.hidden = true;
      forwardBtn.disabled = false;
      return;
    }
    const w = Math.max(48, forward.rect.width);
    const h = Math.max(48, forward.rect.height);
    forwardBtn.style.left = `${forward.rect.left + forward.rect.width / 2 - w / 2}px`;
    forwardBtn.style.top = `${forward.rect.top + forward.rect.height / 2 - h / 2}px`;
    forwardBtn.style.width = `${w}px`;
    forwardBtn.style.height = `${h}px`;
    forwardBtn.hidden = false;
    forwardBtn.disabled = false;
  };

  const placeCard = (hole: TutorialRect | null) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const edge = 14, gap = 14;
    const cw = card.offsetWidth || 300;
    const ch = card.offsetHeight || 160;
    let left = (vw - cw) / 2;
    let top = (vh - ch) / 2;
    if (hole) {
      left = clamp(hole.left + hole.width / 2 - cw / 2, edge, vw - cw - edge);
      const below = hole.top + hole.height + gap;
      const above = hole.top - gap - ch;
      /* a target in the thumb zone gets its card above it, so the dock never disappears
         under the card on the tall phones where there happens to be room below */
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
    if (!open) return;
    const spot = targetSpot();
    if (!spot) {
      drawMask({ left: 0, top: 0, width: 0, height: 0 }, 0);
      spotEl.style.boxShadow = 'none';
      placeForward(null);
      placeCard(null);
      return;
    }
    const pad = STEPS[stepIndex].target === 'finish' ? 4 : STEPS[stepIndex].target === 'moves' ? 8 : 5;
    const target = padRect(spot.rect, pad);
    const hole = clampRect(target);
    const radius = spot.radius ?? (STEPS[stepIndex].target === 'finish' ? 18 : 14);
    drawMask(hole, radius);
    spotEl.style.boxShadow = '';
    const forward = STEPS[stepIndex].target === 'moves' ? hooks.forward() : null;
    placeForward(forward);
    placePointer(hole, forward);
    placeCard(hole);
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

  const focusables = (): HTMLElement[] =>
    [nextBtn, forwardBtn, skipBtn].filter((el) => !el.hidden && !el.disabled && el.getClientRects().length > 0);

  const onKeydown = (e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close('skipped');
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const here = document.activeElement;
    /* the card is the step's reading position, not a Tab stop: Tab moves to the first real
       action (the forward proxy on the movement step), Shift+Tab to the last one */
    if (here === card) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    const at = items.indexOf(here as HTMLElement);
    if (e.shiftKey) {
      if (!root.contains(here) || at === 0) { e.preventDefault(); last.focus(); }
    } else if (!root.contains(here) || at === items.length - 1) {
      e.preventDefault();
      first.focus();
    }
  };

  const render = () => {
    /* A first turn with nowhere to step would trap the player on a card asking for a tap. */
    while (STEPS[stepIndex].target === 'moves' && !hooks.forward()) {
      if (stepIndex >= STEPS.length - 1) { close('finished'); return; }
      stepIndex++;
    }
    const def = STEPS[stepIndex];
    stepEl.textContent = `STEP ${stepIndex + 1} OF ${STEPS.length}`;
    titleEl.textContent = def.title;
    bodyEl.textContent = def.body;
    iconUse.setAttribute('href', def.icon);
    card.dataset.tone = def.tone;
    nextBtn.hidden = def.action === null;
    if (def.action) nextBtn.textContent = def.action;
    forwardBtn.hidden = def.target !== 'moves';
    liveEl.textContent = `Step ${stepIndex + 1} of ${STEPS.length}. ${def.title}: ${def.body}`;
    place();
    card.classList.remove('pop');
    void card.offsetWidth;
    card.classList.add('pop');
    if (def.action) nextBtn.focus({ preventScroll: true });
    else card.focus({ preventScroll: true });
  };

  function close(result: TutorialResult) {
    if (!open) return;
    open = false;
    if (stepTimer) { window.clearTimeout(stepTimer); stepTimer = 0; }
    if (trackId) { cancelAnimationFrame(trackId); trackId = 0; }
    trackUntil = 0;
    forwardBtn.disabled = false;
    root.hidden = true;
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    window.visualViewport?.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKeydown, true);
    hooks.end(result);
  }

  nextBtn.addEventListener('click', () => {
    if (!open) return;
    if (stepIndex >= STEPS.length - 1) { close('finished'); return; }
    stepIndex++;
    render();
  });

  forwardBtn.addEventListener('click', () => {
    if (!open) return;
    const forward = hooks.forward();
    if (!forward) return;
    forwardBtn.disabled = true;
    if (!forward.tap()) { forwardBtn.disabled = false; return; }
    /* a beat of real movement before the card moves on: the tap has to read as a move, not a
       "next" button wearing a board tile */
    stepTimer = window.setTimeout(() => {
      stepTimer = 0;
      if (!open) return;
      stepIndex = 2;
      render();
    }, 180);
  });

  skipBtn.addEventListener('click', () => close('skipped'));

  return {
    get active() { return open; },
    start() {
      if (open) return;
      open = true;
      stepIndex = 0;
      root.hidden = false;
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);
      window.visualViewport?.addEventListener('resize', onResize);
      document.addEventListener('keydown', onKeydown, true);
      render();
      trackFor(460);   // the screen is still sliding in; follow the target's real box
    },
    skip() { close('skipped'); },
    cancel() { close('cancelled'); },
  };
}
