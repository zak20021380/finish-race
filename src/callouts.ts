/**
 * callouts.ts — the board's three beats, spoken in the DOM instead of on the canvas.
 *
 * A mine going off, a log starting its roll and a wall landing all already have a line in the
 * board's toast; this overlay gives them a 1.2s mark over the grid as well, without touching
 * `render.ts` or the turn loop. It is a separate module entry (index.html loads it beside
 * `main.ts`), so the race code stays completely unaware of it: it watches the DOM the HUD already
 * writes — the rolling class, the "Mine!" note and each chip's wall count.
 *
 * NEVER OVER A BALL. The overlay has no model of the board, and the board is a canvas. So before a
 * callout is placed it samples the painted canvas under each candidate slot and takes the first
 * patch with no saturated team body in it. Balls are the only strong red/blue discs on the grid —
 * a wall can also read as one, which only ever costs the callout a slot.
 */
import './arena.css';

/** Each callout lives for this long, then fades out. */
const SHOW_MS = 1200;
/** One more callout of the same kind inside this window is the same event repainting. */
const REPEAT_MS = 250;
/** Pixel stride when sampling a slot. */
const SAMPLE_STEP = 4;

type Kind = 'mine' | 'log' | 'wall';

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

const TICK = '<svg class="co-tick" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
  + '<path d="M5.4 12.6 10 17.2l8.6-9.4" /></svg>';

/** Still first-party markup: no player string ever reaches this overlay. */
const MARKUP: Record<Kind, string> = {
  mine: '<span class="co-in"><span class="co-burst" aria-hidden="true"></span>'
    + '<b class="co-t">MINE!</b></span>',
  log: '<span class="co-in"><b class="co-t">LOG!</b></span>',
  wall: `<span class="co-in">${TICK}<b class="co-t">WALL</b></span>`,
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

function boot(): void {
  const wrap = document.getElementById('board-wrap');
  const layer = document.getElementById('callouts');
  if (!wrap || !layer) return;
  const boardWrap: HTMLElement = wrap;
  const found = document.getElementById('board');
  const canvas = found instanceof HTMLCanvasElement ? found : null;

  const box = document.createElement('span');
  box.className = 'callout';
  layer.appendChild(box);

  let hideTimer = 0;
  const lastAt: Record<Kind, number> = { mine: 0, log: 0, wall: 0 };

  /**
   * How much of a board patch reads as a ball body: saturated red or blue, the two team hues.
   * The board itself is near-neutral lavender, and the finish crown is green/gold, so neither
   * scores. A wall scores — and simply pushes the callout to the next slot.
   */
  function crowd(cx: number, cy: number, w: number, h: number): number {
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || canvas.width < 1 || canvas.height < 1) return 0;
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const x0 = Math.max(0, Math.floor((cx - w / 2) * sx));
    const y0 = Math.max(0, Math.floor((cy - h / 2) * sy));
    const x1 = Math.min(canvas.width, Math.ceil((cx + w / 2) * sx));
    const y1 = Math.min(canvas.height, Math.ceil((cy + h / 2) * sy));
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (bw < 2 || bh < 2) return 0;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 0;
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(x0, y0, bw, bh).data;
    } catch {
      return 0;                       // a tainted canvas must not break the HUD
    }
    let hits = 0;
    for (let y = 0; y < bh; y += SAMPLE_STEP) {
      for (let x = 0; x < bw; x += SAMPLE_STEP) {
        const i = (y * bw + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const red = r > 120 && r - g > 45 && r - b > 30;
        const blue = b > 100 && b - r > 45 && b - g > 20;
        if (red || blue) hits++;
      }
    }
    return hits;
  }

  /** The first slot with no ball under it; failing that, the emptiest one. */
  function pick(): Spot {
    const rect = boardWrap.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return SPOTS[0];
    const w = Math.max(80, box.offsetWidth);
    const h = Math.max(30, box.offsetHeight);
    let best = SPOTS[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const spot of SPOTS) {
      const cx = clamp(spot.x * rect.width, w / 2 + 4, rect.width - w / 2 - 4);
      const cy = clamp(spot.y * rect.height, h / 2 + 4, rect.height - h / 2 - 4);
      const score = crowd(cx, cy, w, h);
      if (score === 0) return { x: cx / rect.width, y: cy / rect.height };
      if (score < bestScore) {
        bestScore = score;
        best = { x: cx / rect.width, y: cy / rect.height };
      }
    }
    return best;
  }

  function show(kind: Kind): void {
    const now = Date.now();
    if (now - lastAt[kind] < REPEAT_MS) return;
    lastAt[kind] = now;
    window.clearTimeout(hideTimer);
    box.className = `callout is-${kind}`;
    box.innerHTML = MARKUP[kind];
    /* placed on the spot: the sample reads the board as it is painted, and no animation frame
       is asked for — a backgrounded WebView throttles rAF and would swallow the callout */
    const spot = pick();
    box.style.left = `${(spot.x * 100).toFixed(2)}%`;
    box.style.top = `${(spot.y * 100).toFixed(2)}%`;
    box.classList.add('show');
    hideTimer = window.setTimeout(() => box.classList.remove('show'), SHOW_MS);
  }

  /* ---- LOG: the board wraps itself in the rolling class for the whole roll ---- */
  let rolling = boardWrap.classList.contains('rolling');
  const rollWatch = new MutationObserver(() => {
    const next = boardWrap.classList.contains('rolling');
    if (next && !rolling) show('log');
    rolling = next;
  });
  rollWatch.observe(boardWrap, { attributes: true, attributeFilter: ['class'] });

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
