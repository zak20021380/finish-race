/**
 * callouts.ts — the board's three beats, spoken in the DOM instead of on the canvas.
 *
 * A mine going off and a wall landing already have a line in the board's toast; this overlay gives
 * them a 1.2s mark over the grid as well, without touching `render.ts` or the turn loop. It is a
 * separate module entry (index.html loads it beside `main.ts`), so the race code stays completely
 * unaware of it: it watches the DOM the HUD already writes — the "Mine!" note and each chip's
 * wall count.
 *
 * NEVER OVER A BALL, and never by looking at one. The board is a canvas, and reading it back
 * (`getImageData`) flushed the GPU pipeline on the frame the explosion was queued — the single
 * worst thing this overlay did. The board publishes its pawns' boxes instead (`boardpieces.ts`),
 * exactly as `staging.ts` publishes the staged mine's pair, so a slot is chosen with arithmetic.
 *
 * NEVER OVER THE MINE PAIR EITHER. A staged mine draws its ✓/✕ discs beside the armed square, and
 * those two are the only thing the player is being asked to tap. `staging.ts` publishes that pair's
 * box, so a slot that would sit on it is dropped and its mirror on the other half of the board is
 * tried instead — the flip an upper-row staging asks for — and a beat with no clear slot at all
 * simply does not paint. A hint is never worth the turn it would cost.
 */
import './arena.css';
import { pieceOverlaps } from './boardpieces';
import { stageOverlaps } from './staging';

/** Each callout lives for this long, then fades out. */
const SHOW_MS = 1200;
/** One more callout of the same kind inside this window is the same event repainting. */
const REPEAT_MS = 250;
/** Daylight a callout keeps from a pawn's own footprint, in css px. */
const BALL_CLEAR = 4;
/**
 * How late a placement may still paint. A backgrounded WebView throttles animation frames, so a
 * beat that missed its own frame must be dropped rather than raised over a board that has moved on.
 */
const PLACE_MAX_LATE_MS = 600;

type Kind = 'mine' | 'wall';

interface Spot { x: number; y: number }

/** Candidate slots, as fractions of the board. All sit in the upper half, clear of the dock. */
const SPOTS: readonly Spot[] = [
  { x: 0.5, y: 0.105 },
  { x: 0.27, y: 0.15 },
  { x: 0.73, y: 0.15 },
  { x: 0.5, y: 0.3 },
  { x: 0.27, y: 0.38 },
  { x: 0.73, y: 0.38 },
];

/** The same slot on the other half of the board: the flip a staged mine forces on the beat. */
const flip = (s: Spot): Spot => ({ x: s.x, y: 1 - s.y });

const TICK = '<svg class="co-tick" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
  + '<path d="M5.4 12.6 10 17.2l8.6-9.4" /></svg>';

/** Still first-party markup: no player string ever reaches this overlay. */
const MARKUP: Record<Kind, string> = {
  mine: '<span class="co-in"><span class="co-burst" aria-hidden="true"></span>'
    + '<b class="co-t">MINE!</b></span>',
  wall: `<span class="co-in">${TICK}<b class="co-t">WALL</b></span>`,
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

function boot(): void {
  const wrap = document.getElementById('board-wrap');
  const layer = document.getElementById('callouts');
  if (!wrap || !layer) return;
  const boardWrap: HTMLElement = wrap;

  const box = document.createElement('span');
  box.className = 'callout';
  layer.appendChild(box);

  let hideTimer = 0;
  const lastAt: Record<Kind, number> = { mine: 0, wall: 0 };

  /**
   * The first slot with no pawn under it and no staged mine beside it.
   *
   * Both answers are arithmetic: the board publishes every pawn's footprint (`boardpieces.ts`) and
   * the staged pair publishes its own (`staging.ts`). No pixel is ever read back, and no canvas
   * context is even held here — the old sampling loop asked for one with `willReadFrequently` and
   * pulled up to twelve patches out of the live board on the detonation tick.
   */
  function pick(): Spot | null {
    const rect = boardWrap.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return SPOTS[0];
    const w = Math.max(80, box.offsetWidth);
    const h = Math.max(30, box.offsetHeight);
    for (const spot of [...SPOTS, ...SPOTS.map(flip)]) {
      const cx = clamp(spot.x * rect.width, w / 2 + 4, rect.width - w / 2 - 4);
      const cy = clamp(spot.y * rect.height, h / 2 + 4, rect.height - h / 2 - 4);
      /* the pair's box and the pawns' boxes are both in viewport px, so one test each covers it */
      const at = { left: rect.left + cx - w / 2, top: rect.top + cy - h / 2, width: w, height: h };
      if (stageOverlaps(at)) continue;
      if (pieceOverlaps(at, BALL_CLEAR)) continue;
      return { x: cx / rect.width, y: cy / rect.height };
    }
    /* the staged pair (or a full board) owns every slot: this beat does not paint at all */
    return null;
  }

  let placeRaf = 0;
  let queued: Kind | null = null;
  let queuedAt = 0;

  /**
   * Raise a callout — the WRITE half only: the class and the copy, nothing measured.
   *
   * This runs inside a MutationObserver microtask, i.e. on the tick the detonation was queued. A
   * `getBoundingClientRect()` or an `offsetWidth` here would force the style and layout work that
   * the first explosion frame is waiting behind, so placement is a separate pass on the next
   * animation frame — the same split `placeNote()` makes for the board's toast.
   */
  function show(kind: Kind): void {
    const now = Date.now();
    if (now - lastAt[kind] < REPEAT_MS) return;
    lastAt[kind] = now;
    window.clearTimeout(hideTimer);
    box.className = `callout is-${kind}`;
    box.innerHTML = MARKUP[kind];
    queued = kind;
    queuedAt = now;
    if (!placeRaf) placeRaf = requestAnimationFrame(place);
  }

  /**
   * The READ half, on a frame of its own: measure the board and the pill, choose a clear slot,
   * then write the position. Reads happen first, writes last — never the other way round.
   */
  function place(): void {
    placeRaf = 0;
    const kind = queued;
    queued = null;
    if (!kind) return;
    if (Date.now() - queuedAt > PLACE_MAX_LATE_MS) return;   // the beat is stale: drop it
    const spot = pick();
    if (!spot) return;
    box.style.left = `${(spot.x * 100).toFixed(2)}%`;
    box.style.top = `${(spot.y * 100).toFixed(2)}%`;
    box.classList.add('show');
    hideTimer = window.setTimeout(() => box.classList.remove('show'), SHOW_MS);
  }

  /* ---- MINE: the board's own alert is the only place the blast is named ---- */
  const note = document.getElementById('note');
  if (note) {
    const mineWatch = new MutationObserver(() => {
      if ((note.textContent ?? '').startsWith('Mine!')) show('mine');
    });
    mineWatch.observe(note, { childList: true, characterData: true, subtree: true });
  }

  /* ---- WALL: a chip's ammo strip only ever counts down when its owner puts one up ---- */
  const wallCount = (badge: HTMLElement): number => {
    const raw = badge.querySelector('.wall-n')?.textContent ?? '';
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : -1;
  };
  for (let p = 0; p < 4; p++) {
    const badge = document.getElementById(`walls-${p}`);
    if (!badge) continue;
    let seen = wallCount(badge);
    const watch = new MutationObserver(() => {
      const next = wallCount(badge);
      if (seen >= 0 && next >= 0 && next < seen) show('wall');
      seen = next;
    });
    watch.observe(badge, { childList: true, characterData: true, subtree: true });
  }
}

boot();
