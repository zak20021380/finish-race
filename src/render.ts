/**
 * render.ts — Canvas 2D drawing + pointer → board hit-testing.
 * All sizes derive from `cell`, so the look scales to any phone.
 *
 * The board is a clay slab: an outer drop shadow, a lit inner bevel, and a grid of inset tiles
 * with a 1px groove between them. It is painted once into an offscreen canvas and blitted every
 * frame, so the tiles cost nothing while the board animates (see `buildStatic`).
 *
 * Nothing here owns a colour: balls, walls, mines and the slab itself are drawn from the `Theme`
 * data in `themes.ts` (see `setTheme`). The renderer also paints the shop's miniature boards — pass
 * `cols` and `rows` and it lays out that patch of board instead of a whole race, so a preview card
 * shows the same code path the race uses rather than a picture of it.
 *
 * Seats, not sides: `view.balls` carries every ball on the board with the team it belongs to, so a
 * race of three balls a side draws the same code path a 1v1 does. Balls of one team share a colour
 * family and are told apart by a number badge; the chosen ball wears a ring and only its legal
 * cells are drawn as dots.
 */
import {
  COLS, MAX_TEAMS, ROWS, logStopRow, startLayout,
  type Cell, type GameState, type LogEvent, type Player, type Pos, type Wall, type WallSpec,
} from './rules';
import { motionReduced } from './settings';
import {
  BOT_RAMP, CLASSIC_BALL, CLASSIC_WALL, DEFAULT_THEME, ERR_RAMP, MINE_RAMP, TEAM2_RAMP,
  type BallSkin, type CosKind, type Ramp, type Stop, type Theme, type WallStyle,
} from './themes';

export interface Vec { x: number; y: number }

/** Wall ghost under construction. `armed` = already tapped once, waiting for a confirm tap. */
export interface Ghost { spec: WallSpec; ok: boolean; armed: boolean; p: Player }

/** What a player did last, so both sides' moves stay readable. */
export type Mark = { kind: 'step'; from: Pos; to: Pos } | { kind: 'wall'; spec: WallSpec };

/** One ball as drawn: where it is now, whose it is, and whether the player has picked it up. */
export interface BallView {
  /** animated centre, in cell units (col + .5, row + .5) */
  pos: Vec;
  team: Player;
  id: number;
  /** the selection ring: this ball is the one a move dot would move */
  sel: boolean;
}

export interface View {
  state: GameState;
  /** every ball on the board, in state order */
  balls: BallView[];
  /** legal move cells — the chosen ball's only */
  hints: Pos[];
  ghost: Ghost | null;      // wall preview / armed ghost
  /** one entry per seat: what that seat did last */
  last: (Mark | null)[];
  thinking: Player | null;  // the seat deciding, when it is not the player's
  /** the seat this client plays: only its mines are ever drawn, and only while still buried */
  human: Player;
  /** placeable cells while the mine key is armed — painted softer than the move dots */
  mineHints: Cell[];
  /** the cell already tapped in the two-tap mine flow, waiting for the confirm tap */
  mineGhost: Cell | null;
  /** the [✓]/[✕] caps a wall or mine ghost draws, or null when no ghost is armed */
  capsule: CapsuleAction | null;
}

export interface Layout {
  w: number; h: number; cell: number; ox: number; oy: number; dpr: number;
  cols: number; rows: number;
}

export interface RendererOptions {
  /** board patch to paint — the race uses the whole 8x12 */
  cols?: number;
  rows?: number;
  /** asked for on `setTheme`; never polled per frame */
  theme?: () => Theme;
}

/**
 * What the board is doing. `move` is direct play: every target is live at once — a ball, a legal
 * cell, a groove between two squares. `mine` is the chip's mine key being held down, which swaps
 * the whole board for the placement band. There is no wall key to reach for: a groove *is* the
 * wall target, so a tap either picks up a ball or starts a wall.
 */
export type ActionMode = 'move' | 'mine';

export type Hit =
  | { kind: 'ball'; id: number }
  | { kind: 'confirm'; spec: WallSpec }
  | { kind: 'wall'; spec: WallSpec }
  | { kind: 'mine'; cell: Cell }
  | { kind: 'mine-confirm'; cell: Cell }
  | { kind: 'move'; to: Pos }
  | { kind: 'cancel' };

/** The on-canvas [✓]/[✕] caps a ghost draws: their board anchor plus the hit a tap confirms. */
export interface CapsuleAction {
  ax: number;
  ay: number;
  hit: { kind: 'confirm'; spec: WallSpec } | { kind: 'mine-confirm'; cell: Cell };
}

const TAU = Math.PI * 2;
/** A tap within this many cells of a legal-move dot centre always means that move — never the groove. */
const MOVE_ZONE = 0.15;
/** ...and within this many cells of a grid line still reads as "aiming at that line" (the groove). */
const GROOVE_ZONE = 0.3;
const MIN_TOUCH = 44;   // css px: smallest legal tap target we allow
const BADGE_FROM = 28;  // cell size below which a number badge would be unreadable
const SOLID: number[] = [];
const BLAST_MS = 700;   // the whole mine trigger, flash to last spark
const LOG_MS = 600;     // the rolling log: head of the lane down to its shield line
const DUST_MS = 420;    // the puff a shoved ball kicks up where it comes to rest
const RIPPLE_MS = 380;  // a tap's ripple
const STREAK_MS = 300;  // how long a sliding ball's trail takes to fade
/* The log is nobody's team: like the mine's warning red it keeps its own colours, amber and wood. */
const HAZARD_AMBER = '#f59e0b';
const HAZARD_INK = '#1b1b29';
const LOG_BODY = '#a9764c';
const LOG_END = '#d8b48b';
const LOG_RING = 'rgba(60,38,22,.85)';

/** 14 sparks, on fixed unit vectors: a burst costs no randomness and allocates nothing. */
const SPARK_N = 14;
const SPARK_C = new Float32Array(SPARK_N);
const SPARK_S = new Float32Array(SPARK_N);
const SPARK_L = new Float32Array(SPARK_N);
for (let i = 0; i < SPARK_N; i++) {
  const a = (i / SPARK_N) * TAU + 0.24;
  SPARK_C[i] = Math.cos(a);
  SPARK_S[i] = Math.sin(a);
  SPARK_L[i] = 0.55 + 0.7 * (((i * 37) % 11) / 11);   // varied lengths, still deterministic
}

/**
 * The same colour with its alpha driven to zero, for a gradient that has to fade a stop out.
 * Board palettes author every fading colour as an rgba() literal, so this only has to read one.
 */
const clear = (col: string) => (col.startsWith('rgb') ? col.replace(/[\d.]+\)\s*$/, '0)') : col);

/** A stop's colour may name a ramp slot ("mid") or be literal; board stops are always literal. */
const resolve = (ramp: Ramp | null, list: Stop[]): Stop[] => {
  const slots = ramp as unknown as Record<string, string> | null;
  return list.map(([t, ref]) => [t, slots?.[ref] ?? ref]);
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* ---------- hit-testing ---------- */

/** Nearest valid wall slot when (bx, by) aims at a grid line, else null. Board coords. */
function slotNear(bx: number, by: number, cols: number, rows: number): WallSpec | null {
  const hY = clamp(Math.round(by), 1, rows - 1);
  const vX = clamp(Math.round(bx), 1, cols - 1);
  const dh = Math.abs(by - hY), dv = Math.abs(bx - vX);
  if (Math.min(dh, dv) > GROOVE_ZONE) return null;
  return dh <= dv
    ? { o: 'h', x: clamp(Math.round(bx) - 1, 0, cols - 2), y: hY }
    : { o: 'v', x: vX, y: clamp(Math.round(by) - 1, 0, rows - 2) };
}

/** Perpendicular distance (cells) from a board point to a wall's line; Infinity past its ends. */
function distToWall(bx: number, by: number, w: WallSpec, along: number): number {
  if (w.o === 'h') {
    if (bx < w.x - along || bx > w.x + 2 + along) return Infinity;
    return Math.abs(by - w.y);
  }
  if (by < w.y - along || by > w.y + 2 + along) return Infinity;
  return Math.abs(bx - w.x);
}

/** The board-space centre of a wall's body, used to anchor its floating action capsules. */
export function wallCentre(w: WallSpec): Vec {
  return w.o === 'h' ? { x: w.x + 1, y: w.y } : { x: w.x, y: w.y + 1 };
}

/** Radius of a floating action capsule (the [✓] / [✕] chips), in cells. Also its tap target. */
const CAP_R = 0.3;
/** Half the distance between the two capsule centres, in cells. */
const CAP_GAP = 0.4;

/**
 * A floating capsule's centre beside a board anchor, clamped so both chips stay wholly inside the
 * canvas: the whole 2·CAP_R disc is kept within a half-cell margin of every edge.
 */
function capsulePos(L: Layout, ax: number, ay: number, side: 'confirm' | 'cancel'): Vec {
  const dir = side === 'confirm' ? 1 : -1;
  return {
    x: clamp(ax + dir * (CAP_GAP + CAP_R), 0.5 + CAP_R, L.cols - 0.5 - CAP_R),
    y: clamp(ay, 0.5 + CAP_R, L.rows - 0.5 - CAP_R),
  };
}

/** The centre of the confirm ([✓]) capsule beside a board anchor, in board units. */
export const capsuleConfirmPos = (L: Layout, ax: number, ay: number): Vec => capsulePos(L, ax, ay, 'confirm');
/** The centre of the cancel ([✕]) capsule beside a board anchor, in board units. */
export const capsuleCancelPos = (L: Layout, ax: number, ay: number): Vec => capsulePos(L, ax, ay, 'cancel');

/** Which capsule, if either, a tap at (bx, by) lands on. Board coords in, capsule name out. */
function capsuleHit(L: Layout, bx: number, by: number, cap: CapsuleAction): 'confirm' | 'cancel' | null {
  const r2 = CAP_R * CAP_R;
  const c = capsuleConfirmPos(L, cap.ax, cap.ay);
  if ((bx - c.x) * (bx - c.x) + (by - c.y) * (by - c.y) <= r2) return 'confirm';
  const x = capsuleCancelPos(L, cap.ax, cap.ay);
  if ((bx - x.x) * (bx - x.x) + (by - x.y) * (by - x.y) <= r2) return 'cancel';
  return null;
}

/**
 * Pointer (CSS px, canvas-local) → the thing to act on.
 * Priority, not raw distance: an armed ghost (or the on-canvas action capsules) confirms first, one
 * of your balls picks up, a tap in the move zone (0.15 cell) moves, and only a tap nearer the
 * groove than the move zone arms a wall. A tap between the two zones falls back to the nearest
 * legal dot so a sloppy finger still moves rather than starting a wall. One mode is left: while the
 * mine key is armed the board offers mines and nothing else, and the top and bottom two rows are
 * refused outright.
 */
export function hitTest(L: Layout, px: number, py: number, o: {
  hints: Pos[];
  armed: WallSpec | null;
  /** every ball on the board, in cell coordinates */
  balls: readonly { id: number; team: Player; c: number; r: number }[];
  /** the seat whose balls answer to a tap */
  mine: Player;
  mode: ActionMode;
  /** placeable cells — read only while `mode` is 'mine' */
  mineHints: Cell[];
  /** the cell waiting for its confirm tap — read only while `mode` is 'mine' */
  armedMine: Cell | null;
  /** the outcome a tap on an on-canvas action capsule should act on, if drawn */
  capsule?: CapsuleAction | null;
}): Hit | null {
  const c = L.cell;
  if (c <= 0) return null;
  const bx = (px - L.ox) / c, by = (py - L.oy) / c;
  if (bx < -0.5 || by < -0.5 || bx > L.cols + 0.5 || by > L.rows + 0.5) return null;

  const cand: { hit: Hit; pri: number; d: number }[] = [];
  const reach = Math.max(0.5, MIN_TOUCH / 2 / c);   // 44px target, in cells
  /** the nearest of these cells to the tap, with the distance. `maxD` gates what counts as the aim. */
  const nearest = (cells: readonly Pos[], maxD: number) => {
    let best: Pos | null = null, d = Infinity;
    for (const h of cells) {
      const e = Math.hypot(bx - h.c - 0.5, by - h.r - 0.5);
      if (e < d) { d = e; best = h; }
    }
    return best && d <= maxD ? { cell: best, d } : null;
  };

  if (o.mode === 'mine') {
    // mines only: ball selection and wall hit-tests are bypassed; empty board space disarms via null
    const cap = o.capsule ? capsuleHit(L, bx, by, o.capsule) : null;
    if (cap) cand.push({ hit: cap === 'confirm' ? o.capsule!.hit : { kind: 'cancel' }, pri: 0, d: 0 });
    const armed = o.armedMine ? nearest([o.armedMine], reach) : null;
    if (armed) cand.push({ hit: { kind: 'mine-confirm', cell: armed.cell }, pri: 0, d: armed.d });
    const spot = nearest(o.mineHints, reach);
    if (spot) cand.push({ hit: { kind: 'mine', cell: spot.cell }, pri: 1, d: spot.d });
  } else {
    /* Priority order (lower number wins): the action capsules and your own ball, then a move dot
       inside 0.15 cells, then the armed ghost confirming, then a groove, then a far move fallback.
       A dot within the move zone is pushed on its own, so no groove can ever be offered there. */
    const cap = o.capsule ? capsuleHit(L, bx, by, o.capsule) : null;
    if (cap) cand.push({ hit: cap === 'confirm' ? o.capsule!.hit : { kind: 'cancel' }, pri: 0, d: 0 });

    let ballId: number | null = null, db = Infinity;
    for (const b of o.balls) {
      if (b.team !== o.mine) continue;
      const d = Math.hypot(bx - b.c - 0.5, by - b.r - 0.5);
      if (d < db) { db = d; ballId = b.id; }
    }
    if (ballId !== null && db <= reach) cand.push({ hit: { kind: 'ball', id: ballId }, pri: 0, d: db });

    const spot = nearest(o.hints, reach);
    if (spot && spot.d <= MOVE_ZONE) {
      cand.push({ hit: { kind: 'move', to: spot.cell }, pri: 1, d: spot.d });
    } else {
      const s = slotNear(bx, by, L.cols, L.rows);
      const wd = s ? distToWall(bx, by, s, 1.25) : Infinity;
      if (s && wd <= (spot ? spot.d : Infinity)) cand.push({ hit: { kind: 'wall', spec: s }, pri: 3, d: wd });
      if (spot) cand.push({ hit: { kind: 'move', to: spot.cell }, pri: 4, d: spot.d });
    }

    if (o.armed) {
      const d = distToWall(bx, by, o.armed, 0.5);
      if (d <= Math.min(0.42, Math.max(GROOVE_ZONE, 18 / c))) cand.push({ hit: { kind: 'confirm', spec: o.armed }, pri: 2, d });
    }
  }

  cand.sort((a, b) => a.pri - b.pri || a.d - b.d);
  return cand.length ? cand[0].hit : null;
}

/* ---------- drawing ---------- */

/** One seat: its colours, its ball material, its wall material. Seats 0..2 play, seat 3 refuses. */
interface Side { ramp: Ramp; ball: BallSkin; wall: WallStyle }

/** Every seat the rules allow, plus the refusal palette that owns no side. */
const SEAT_COUNT = MAX_TEAMS + 1;
const ERR = MAX_TEAMS;
/** Fixed families for the seats that are never themed: the opponent, the third team, and "no". */
const FIXED: Ramp[] = [BOT_RAMP, TEAM2_RAMP, ERR_RAMP];

const CORNER = 0.4;              // board corner radius, in cells
/** How many balls each seat fields: filled at the top of every frame, reused, never reallocated. */
const SEATS_N = new Int16Array(SEAT_COUNT);
/** Draw order of the balls, nearest last: likewise. */
const ORDER: number[] = [];

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.min(r, w / 2, h / 2); // capsule-thin outlines must not self-overlap
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

/**
 * The start squares of the game on screen, taken from the same helper the rules place the balls
 * with, so the tint under a ball can never drift away from the ball.
 */
function startBoard(s: GameState): { c: number; r: number; t: Player }[] {
  const out: { c: number; r: number; t: Player }[] = [];
  const lay = startLayout(s.teams.map((t) => t.balls));
  for (let t = 0; t < lay.length; t++) for (const p of lay[t]) out.push({ c: p.c, r: p.r, t });
  return out;
}

/**
 * The gap the slab keeps inside its canvas. Only the ring stroke and the slab's own drop shadow
 * need room here — the card's padding does the real spacing, so the board fills the card.
 */
const LAYOUT_PAD = 2;

function computeLayout(w: number, h: number, dpr: number, cols: number, rows: number): Layout {
  const m = LAYOUT_PAD;
  const raw = Math.min((w - 2 * m) / cols, (h - 2 * m) / rows);
  const cell = Math.max(8, Math.floor(raw * dpr) / dpr); // whole device pixels → crisp grid
  const ox = Math.round(((w - cols * cell) / 2) * dpr) / dpr;
  const oy = Math.round(((h - rows * cell) / 2) * dpr) / dpr;
  return { w, h, cell, ox, oy, dpr, cols, rows };
}

export function createRenderer(canvas: HTMLCanvasElement, opts: RendererOptions = {}) {
  const ctx = canvas.getContext('2d')!;
  const cols = opts.cols ?? COLS, rows = opts.rows ?? ROWS;
  let L = computeLayout(1, 1, 1, cols, rows);
  let th: Theme = opts.theme ? opts.theme() : DEFAULT_THEME;
  /** seat 0 wears the equipped skin and style; every other seat keeps its fixed family. */
  let sides: Side[] = seats(th);
  const born = new Map<number, number>();                    // wall key → first-seen time (pop-in)
  const pulses: { x: number; y: number; t0: number; p: Player }[] = []; // wall landing rings
  const blasts: { x: number; y: number; t0: number }[] = []; // mine triggers, queued by blast()
  /** The rolling log: one sprite per warning that landed, and the dust its shove kicks up. */
  const rolls: { left: number; stopRow: number; t0: number }[] = [];
  const dust: { x: number; y: number; t0: number }[] = [];
  const ripples: { x: number; y: number; t0: number; p: Player }[] = []; // tap feedback
  /** Sliding balls leave a short comet tail: pooled, reused, and dropped as they fade. */
  const streaks: { x0: number; y0: number; x1: number; y1: number; t0: number; p: Player }[] = [];
  const prevPos = new Map<number, Vec>();                    // ball id → where it was last frame
  let bg: HTMLCanvasElement | null = null;                   // static board layer, rebuilt on resize
  let mineBody: CanvasGradient | null = null;                // the mine's dim warm sphere
  let mineGlow: CanvasGradient | null = null;                // …and the glow it casts
  let blastGlow: CanvasGradient | null = null;               // the wide light a trigger throws
  /** When the armed mine ghost first appeared, so it can drop into place once. */
  let mineGhostAt = 0;
  let mineGhostKey = '';
  /** The start squares of the game on screen, rebuilt only when the team sizes change. */
  let startKey = '';
  let starts: { c: number; r: number; t: Player }[] = [];
  let lastW = 0, lastH = 0, lastDpr = 0;
  // layout-sized paint servers: built once per resize, reused every frame
  const dash = { trail: [] as number[], last: [] as number[], ghost: [] as number[], armed: [] as number[] };
  const ballFx: { shadow: CanvasGradient; body: CanvasGradient; bounce: CanvasGradient }[] = [];
  const glowG: CanvasGradient[] = [];
  /** Light sweep over the finish strip: one gradient per resize, moved with the canvas transform. */
  const sweep = { grad: null as CanvasGradient | null, band: 0 };

  /** The player's seat plus every fixed one, from one theme. */
  function seats(t: Theme): Side[] {
    const out: Side[] = [{ ramp: t.ball.ramp, ball: t.ball, wall: t.wall }];
    for (let i = 1; i < SEAT_COUNT; i++) {
      out.push({ ramp: FIXED[i - 1] ?? ERR_RAMP, ball: CLASSIC_BALL, wall: CLASSIC_WALL });
    }
    return out;
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === lastW && h === lastH && dpr === lastDpr) return;
    lastW = w; lastH = h; lastDpr = dpr;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    L = computeLayout(w, h, dpr, cols, rows);
    buildStatic();
  }

  /** Everything that only depends on the layout or the theme: the board layer + every paint server. */
  function buildStatic() {
    const { w, h, cell: c, ox, oy, dpr } = L;
    const b = th.board;
    const cv = bg || (bg = document.createElement('canvas'));
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    const g = cv.getContext('2d')!;
    const bw = cols * c, bh = rows * c, R = CORNER * c;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    /* the slab: one solid clay face lifted off the card by a soft outer drop shadow */
    g.save();
    g.shadowColor = b.drop;
    g.shadowBlur = 18 * dpr;
    g.shadowOffsetY = 5 * dpr;
    rr(g, ox, oy, bw, bh, R);
    g.fillStyle = b.surface;
    g.fill();
    g.restore();

    /* everything after this is clipped to the slab, so no bevel or beam can bleed past its edge */
    g.save();
    rr(g, ox, oy, bw, bh, R);
    g.clip();

    // device-pixel snapping keeps the finish checker crisp at any dpr (no half-pixel seams)
    const px = (n: number) => Math.round(n * dpr) / dpr;

    /* the inner bevel that makes it read as clay: lit along the top edge, shaded into the bottom */
    const bevelW = Math.max(2, c * 0.13);
    const bev = g.createLinearGradient(0, oy, 0, oy + bh);
    bev.addColorStop(0, b.bevel[0]);
    bev.addColorStop(0.1, clear(b.bevel[0]));
    bev.addColorStop(0.86, clear(b.bevel[1]));
    bev.addColorStop(1, b.bevel[1]);
    g.lineWidth = bevelW;
    g.strokeStyle = bev;
    rr(g, ox + bevelW / 2, oy + bevelW / 2, bw - bevelW, bh - bevelW, R - bevelW / 2);
    g.stroke();

    /* the grooves the tiles sit in: one hairline per grid line, snapped to the device pixel */
    const lwDev = Math.max(1, Math.round(dpr));
    const half = (lwDev % 2) / 2;
    const snap = (n: number) => (Math.round(n * dpr - half) + half) / dpr;
    g.strokeStyle = b.grid;
    g.lineWidth = lwDev / dpr;
    g.beginPath();
    for (let i = 1; i < cols; i++) { const x = snap(ox + i * c); g.moveTo(x, oy); g.lineTo(x, oy + bh); }
    for (let i = 1; i < rows; i++) { const y = snap(oy + i * c); g.moveTo(ox, y); g.lineTo(ox + bw, y); }
    g.stroke();

    /* inset clay tiles: a faint two-tone checker with a 1px tactile gap, each square shaded
       darker at its top and lighter at its foot, which is what reads as "pressed in" */
    const gap = Math.max(1, c * 0.03);
    const tw = c - gap, tr = Math.min(c * 0.15, tw / 2);
    const shade = g.createLinearGradient(0, 0, 0, c);
    shade.addColorStop(0, b.bevel[1]);
    shade.addColorStop(0.42, clear(b.bevel[1]));
    shade.addColorStop(0.78, clear(b.bevel[0]));
    shade.addColorStop(1, b.bevel[0]);
    g.lineWidth = Math.max(1, c * 0.035);
    g.strokeStyle = shade;
    for (let r0 = 0; r0 < rows; r0++) {
      for (let c0 = 0; c0 < cols; c0++) {
        const tx = ox + c0 * c + gap / 2, ty = oy + r0 * c + gap / 2;
        rr(g, tx, ty, tw, tw, tr);
        g.fillStyle = (c0 + r0) % 2 === 0 ? b.tile[0] : b.tile[1];
        g.fill();
        g.save();
        g.translate(tx, ty);              // the shared shade gradient follows the tile
        rr(g, 0, 0, tw, tw, tr);
        g.stroke();
        g.restore();
      }
    }

    // soft glow under the line, fading out roughly three rows down
    const fg = g.createLinearGradient(0, oy, 0, oy + 3 * c);
    for (const [t, col] of resolve(null, b.glow)) fg.addColorStop(t, col);
    g.fillStyle = fg;
    g.fillRect(ox, oy, bw, 3 * c);

    // checkered finish strip across row 0: the line is readable without colour and without a label
    const q = c / 2;
    for (let i = 0; i < cols * 2; i++) {
      for (let j = 0; j < 2; j++) {
        const x0 = px(ox + i * q), x1 = px(ox + (i + 1) * q);
        const y0 = px(oy + j * q), y1 = px(oy + (j + 1) * q);
        g.fillStyle = (i + j) % 2 === 0 ? b.checker[0] : b.checker[1];
        g.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
    g.strokeStyle = b.rule;
    g.lineWidth = Math.max(1, c * 0.02);
    g.beginPath(); g.moveTo(ox, px(oy + c)); g.lineTo(ox + bw, px(oy + c)); g.stroke();

    /* three soft beams falling out of the finish, gone by the fourth row */
    if (b.beam) {
      const top = oy + c * 0.55, bot = oy + c * 3.5;
      const beam = g.createLinearGradient(0, top, 0, bot);
      beam.addColorStop(0, b.beam);
      beam.addColorStop(0.55, clear(b.beam));
      beam.addColorStop(1, clear(b.beam));
      g.fillStyle = beam;
      for (let i = 0; i < 3; i++) {
        const cx = ox + (bw * (i + 0.5)) / 3, w0 = c * 0.5, w1 = c * 1.45;
        g.beginPath();
        g.moveTo(cx - w0, top); g.lineTo(cx + w0, top);
        g.lineTo(cx + w1, bot); g.lineTo(cx - w1, bot);
        g.closePath();
        g.fill();
      }
    }
    g.restore();

    // border ring: green at the finish, easing into the board's own trim
    const rw = 0.075 * c;
    const ring = g.createLinearGradient(0, oy, 0, oy + bh);
    for (const [t, col] of resolve(null, b.ring)) ring.addColorStop(t, col);
    rr(g, ox + rw / 2, oy + rw / 2, bw - rw, bh - rw, R - rw / 2);
    g.lineWidth = rw;
    g.strokeStyle = ring;
    g.stroke();
    rr(g, ox - 0.5, oy - 0.5, bw + 1, bh + 1, R + 0.5);
    g.lineWidth = 1;
    g.strokeStyle = b.edge;
    g.stroke();

    // paint servers sized to this layout, then reused by every frame
    dash.trail[0] = c * 0.15; dash.trail[1] = c * 0.12;
    dash.last[0] = dash.last[1] = c * 0.1;
    dash.ghost[0] = dash.ghost[1] = c * 0.11;
    dash.armed[0] = dash.armed[1] = c * 0.16;
    for (const m of barG) m.clear();
    ballFx.length = 0;
    glowG.length = 0;
    sweep.band = c * 2.4;
    const sg = ctx.createLinearGradient(0, 0, sweep.band, 0);
    sg.addColorStop(0, `rgba(255,255,255,0)`);
    sg.addColorStop(0.44, `rgba(255,255,255,${b.sweep})`);
    sg.addColorStop(0.56, `rgba(255,255,255,${b.sweep})`);
    sg.addColorStop(1, `rgba(255,255,255,0)`);
    sweep.grad = sg;
    const br = c * 0.34;
    for (let i = 0; i < MAX_TEAMS; i++) {
      const s = sides[i];
      const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, br * 1.1);
      shadow.addColorStop(0, `rgba(${s.ramp.shade},.42)`);
      shadow.addColorStop(0.55, `rgba(${s.ramp.shade},.18)`);
      shadow.addColorStop(1, `rgba(${s.ramp.shade},0)`);
      const body = ctx.createRadialGradient(-0.34 * br, -0.4 * br, br * 0.06, -0.08 * br, -0.08 * br, br * 1.12);
      for (const [t, col] of resolve(s.ramp, s.ball.stops)) body.addColorStop(t, col);
      const bounce = ctx.createRadialGradient(0.3 * br, 0.62 * br, 0, 0.3 * br, 0.62 * br, br * 0.8);
      bounce.addColorStop(0, `rgba(255,255,255,${s.ball.bounce})`);
      bounce.addColorStop(1, 'rgba(255,255,255,0)');
      ballFx.push({ shadow, body, bounce });
      const glow = ctx.createRadialGradient(0, 0, br * 0.8, 0, 0, br * 2.3);
      glow.addColorStop(0, s.ramp.glow);
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      glowG.push(glow);
    }

    /* the mine's two paint servers: a dim warm sphere and the glow that goes with it */
    const mr = c * 0.34;
    const mb = ctx.createRadialGradient(-0.3 * mr, -0.34 * mr, mr * 0.08, 0, 0, mr * 1.1);
    mb.addColorStop(0, MINE_RAMP.light);
    mb.addColorStop(0.42, MINE_RAMP.mid);
    mb.addColorStop(1, MINE_RAMP.dark);
    mineBody = mb;
    const mg = ctx.createRadialGradient(0, 0, mr * 0.5, 0, 0, mr * 2.6);
    mg.addColorStop(0, MINE_RAMP.glow);
    mg.addColorStop(1, 'rgba(255,255,255,0)');
    mineGlow = mg;
    /* the trigger's light: one wide soft wash the whole burst sits in, so the blast is still
       readable half a second later, after the flash and the first sparks are gone */
    const bg2 = ctx.createRadialGradient(0, 0, 0, 0, 0, c * 2.4);
    bg2.addColorStop(0, 'rgba(255,150,60,.75)');
    bg2.addColorStop(0.42, 'rgba(255,90,20,.34)');
    bg2.addColorStop(1, 'rgba(255,90,20,0)');
    blastGlow = bg2;
  }

  /** Wall-body gradients, bucketed by thickness: built once per size, never per frame. */
  const barG: Map<number, CanvasGradient>[] = Array.from({ length: SEAT_COUNT }, () => new Map());

  function barGrad(pi: number, t: number): CanvasGradient {
    const key = Math.round(t * 50);
    const cache = barG[pi];
    let g = cache.get(key);
    if (!g) {
      const s = sides[pi];
      g = ctx.createLinearGradient(0, -t / 2, 0, t / 2);
      for (const [o, col] of resolve(s.ramp, s.wall.stops)) g.addColorStop(o, col);
      cache.set(key, g);
    }
    return g;
  }

  /**
   * A placed wall, a ghost or a refusal — same 2-cell body. Drawn along local +x (vertical
   * walls just rotate), so one cached gradient serves both orientations and the round caps
   * stop exactly on the grid intersections the wall spans.
   */
  function drawBar(w: WallSpec, pi: number, alpha: number, grow: number, glow: boolean) {
    const { cell: c, ox, oy, dpr } = L;
    const s = sides[pi];
    const st = s.wall;
    const t = c * 0.13 * st.thick * (0.62 + 0.38 * grow);
    // round caps hang t/2 past each end, butt caps do not: either way the bar spans exactly 2 cells
    const cap = st.caps === 'butt' ? 0 : t / 2, len = 2 * c - 2 * cap;
    ctx.save();
    ctx.translate(ox + w.x * c, oy + w.y * c);
    if (w.o === 'v') { ctx.translate(0, 2 * c); ctx.rotate(-Math.PI / 2); }
    ctx.lineCap = st.caps;
    ctx.globalAlpha = alpha * st.alpha;
    ctx.lineWidth = t;
    ctx.strokeStyle = barGrad(pi, t);
    if (glow && st.glow > 0) { ctx.shadowColor = s.ramp.glow; ctx.shadowBlur = c * 0.16 * st.glow * dpr; }
    ctx.beginPath(); ctx.moveTo(cap, 0); ctx.lineTo(cap + len, 0); ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    if (st.gloss > 0) {                                       // highlight, by default on the lit (upper) side
      ctx.strokeStyle = `rgba(255,255,255,${st.gloss})`;
      ctx.lineWidth = Math.max(1, t * (st.glossAt === 0 ? 0.34 : 0.26));
      ctx.beginPath();
      ctx.moveTo(cap + t * 0.2, t * st.glossAt); ctx.lineTo(cap + len - t * 0.2, t * st.glossAt);
      ctx.stroke();
    }
    if (st.rim > 0) {                                         // a pane reads through its edge
      ctx.globalAlpha = alpha * st.rim;
      ctx.strokeStyle = s.ramp.light;
      ctx.lineWidth = Math.max(1, t * 0.12);
      rr(ctx, 0, -t / 2, 2 * c, t, t / 2);
      ctx.stroke();
      ctx.globalAlpha = alpha * st.alpha;
    }
    if (pi === 1) {                                            // cross-bands: ownership without colour
      ctx.strokeStyle = 'rgba(255,255,255,.52)';
      ctx.lineWidth = Math.max(1, t * 0.26);
      ctx.beginPath();
      let x = cap + len * 0.32; ctx.moveTo(x, -t * 0.4); ctx.lineTo(x, t * 0.4);
      x = cap + len * 0.68; ctx.moveTo(x, -t * 0.4); ctx.lineTo(x, t * 0.4);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Shared scratch: callers read the fields immediately, so the frame loop stays allocation-free. */
  const _box = { x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 };
  function box(w: WallSpec) {
    const { cell: c, ox, oy } = L;
    _box.x = ox + w.x * c;
    _box.y = oy + w.y * c;
    if (w.o === 'h') {
      _box.w = 2 * c; _box.h = 0;
      _box.cx = ox + (w.x + 1) * c; _box.cy = _box.y;
    } else {
      _box.w = 0; _box.h = 2 * c;
      _box.cx = _box.x; _box.cy = oy + (w.y + 1) * c;
    }
    return _box;
  }

  /** Marching-ants outline hugging a wall — "this is the slot you are about to use". */
  function outline(w: WallSpec, color: string, width: number, dashes: number[], phase = 0, pi = 0) {
    const c = L.cell;
    const t = c * 0.3 * sides[pi].wall.thick;
    const b = box(w);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dashes);
    ctx.lineDashOffset = phase;
    rr(ctx, b.x - t / 2, b.y - t / 2, b.w + t, b.h + t, t * 0.6);
    ctx.stroke();
    ctx.restore();
  }

  function cross(w: WallSpec, color: string, r: number) {
    const { cell: c } = L;
    const b = box(w);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, c * 0.06);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(b.cx - r, b.cy - r); ctx.lineTo(b.cx + r, b.cy + r);
    ctx.moveTo(b.cx + r, b.cy - r); ctx.lineTo(b.cx - r, b.cy + r);
    ctx.stroke();
    ctx.restore();
  }

  /** The specular stack, which is what tells these materials apart at 34px. */
  function shine(s: Side, r: number) {
    const g = s.ball.gloss;
    const alpha = (a: number) => Math.min(1, a * g);
    const blob = (x: number, y: number, rot: number, w: number, h: number, a: number) => {
      ctx.save();
      ctx.translate(x, y); ctx.rotate(rot);
      ctx.fillStyle = `rgba(255,255,255,${alpha(a)})`;
      ctx.beginPath(); ctx.ellipse(0, 0, r * w, r * h, 0, 0, TAU); ctx.fill();
      ctx.restore();
    };
    if (s.ball.shine === 'metal') {
      blob(-0.3 * r, -0.44 * r, -0.5, 0.58, 0.13, 0.3);   // brushed band
      blob(-0.05 * r, -0.5 * r, 0, 0.2, 0.1, 0.95);       // hard sparkle
      blob(0.25 * r, 0.55 * r, 0.3, 0.5, 0.1, 0.2);       // reflected floor
      return;
    }
    if (s.ball.shine === 'glass') {
      blob(-0.3 * r, -0.35 * r, -0.6, 0.46, 0.3, 0.16);   // wide dim sheen
      blob(-0.38 * r, -0.45 * r, 0, 0.15, 0.11, 1);       // pin-point
      return;
    }
    blob(-0.36 * r, -0.42 * r, -0.72, 0.4, 0.24, 0.22);
    blob(-0.36 * r, -0.42 * r, -0.72, 0.26, 0.14, 0.92);
  }

  function drawBall(cx: number, cy: number, r: number, i: number, badge = 0) {
    const s = sides[i], fx = ballFx[i];
    ctx.save();
    ctx.translate(cx, cy);

    ctx.save();                        // soft elliptical shadow
    ctx.translate(0, r * 0.82);
    ctx.scale(1, 0.3);
    ctx.fillStyle = fx.shadow;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.1, 0, TAU); ctx.fill();
    ctx.restore();

    ctx.fillStyle = fx.body;           // body
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();

    ctx.save();                        // bounce light from below-right, clipped to the sphere
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.clip();
    ctx.fillStyle = fx.bounce;
    ctx.fillRect(-r, -r, 2 * r, 2 * r);
    ctx.restore();

    if (s.ball.ring > 0) {             // inner rim light (Neon, Obsidian)
      ctx.save();
      ctx.globalAlpha = s.ball.ring;
      ctx.strokeStyle = s.ramp.light;
      ctx.lineWidth = r * 0.22;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.86, 0, TAU); ctx.stroke();
      ctx.restore();
    }

    ctx.beginPath(); ctx.arc(0, 0, r - 0.5, 0, TAU);   // crisp edge
    ctx.strokeStyle = s.ramp.edge; ctx.lineWidth = 1; ctx.stroke();

    shine(s, r);
    if (badge > 0) drawBadge(r, badge);
    ctx.restore();
  }

  /** Halo under the balls of the seat to move (or of the winner) — the one light on the slab. */
  function drawGlow(cx: number, cy: number, r: number, i: number, k: number) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalAlpha = Math.min(1, (0.42 + 0.34 * k) * sides[i].ball.halo);
    ctx.fillStyle = glowG[i];
    ctx.beginPath(); ctx.arc(0, 0, r * 2.3, 0, TAU); ctx.fill();
    ctx.restore();
  }

  /**
   * A same-team ball's number: a white disc on its lower-right rim, dark ink on top. It is what
   * tells the three balls of one colour family apart, so a race can have 3v3 and still be readable.
   * Called inside `drawBall`'s transform, so the ball itself sits at the origin.
   */
  function drawBadge(r: number, n: number) {
    const c = L.cell;
    if (c < BADGE_FROM) return;                       // no room for a legible digit: skip it
    const s = c * 0.19;
    const x = r * 0.68, y = r * 0.68;
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, s, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.fill();
    ctx.lineWidth = Math.max(1, c * 0.026);
    ctx.strokeStyle = 'rgba(20,20,32,.5)';
    ctx.stroke();
    ctx.fillStyle = '#1b1b29';
    ctx.font = `800 ${Math.round(s * 1.5)}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), x, y + s * 0.06);
    ctx.restore();
  }

  /** The chosen ball: a white ring plus a dashed team-coloured one, breathing so it stays alive. */
  function drawSel(cx: number, cy: number, r: number, i: number, now: number, still: boolean) {
    const c = L.cell;
    const pulse = still ? 1 : 0.5 + 0.5 * Math.sin(now / 300);      // the ring swells and settles
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(255,255,255,${0.7 + 0.26 * pulse})`;
    ctx.lineWidth = Math.max(2, c * 0.075);
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.3 * (1 + 0.05 * pulse), 0, TAU); ctx.stroke();
    ctx.strokeStyle = sides[i].ramp.mid;
    ctx.lineWidth = Math.max(1.5, c * 0.045);
    ctx.setLineDash([c * 0.15, c * 0.12]);
    ctx.lineDashOffset = still ? 0 : -now / 40;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.6, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  /**
   * A mine you buried: a dim spiked sphere in the warning red, breathing gently, with a tiny light
   * blinking on top of it. `phase` is 'buried' for one in the ground, 'ghost' for the square
   * already tapped in the two-tap flow — the ghost is translucent and drops into place. `drop`
   * scales it during that landing. Only ever called for your own mines (see `view()` in rules.ts).
   */
  function drawMine(cx: number, cy: number, phase: 'buried' | 'ghost', k: number, drop: number,
    now: number, still: boolean) {
    const c = L.cell;
    const r = c * (phase === 'ghost' ? 0.27 : 0.24) * (1 + 0.06 * k) * drop;
    const alpha = (phase === 'ghost' ? 0.6 : 0.78) * (0.88 + 0.12 * k);
    ctx.save();
    ctx.translate(cx, cy);
    if (mineGlow) {                                   // the warm halo it casts on the clay
      ctx.globalAlpha = alpha * 0.9 * drop;
      ctx.fillStyle = mineGlow;
      ctx.beginPath(); ctx.arc(0, 0, c * 0.884 * drop, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.strokeStyle = MINE_RAMP.mid;
    ctx.lineWidth = Math.max(1.5, c * 0.05);
    ctx.beginPath();
    for (let n = 0; n < 8; n++) {
      const co = Math.cos(n * Math.PI / 4), si = Math.sin(n * Math.PI / 4);
      ctx.moveTo(co * r * 0.78, si * r * 0.78);
      ctx.lineTo(co * r * 1.3, si * r * 1.3);
    }
    ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.84, 0, TAU);
    ctx.fillStyle = mineBody ?? MINE_RAMP.dark;
    ctx.fill();
    ctx.lineWidth = Math.max(1, c * 0.028);
    ctx.strokeStyle = MINE_RAMP.edge;
    ctx.stroke();
    // the tell-tale light: one short hard blink every 1.4s, alive but never loud
    const bt = (now % 1400) / 1400;
    const blink = still ? 0.6 : bt < 0.14 ? 1 - bt / 0.14 : 0.05;
    ctx.globalAlpha = alpha * (0.3 + 0.7 * blink);
    ctx.fillStyle = MINE_RAMP.light;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.3, 0, TAU); ctx.fill();
    ctx.restore();
  }

  /** Marching ants around a whole cell — "this is the square you are about to use". */
  function cellRing(cell: Cell, color: string, width: number, dashes: number[], phase = 0) {
    const c = L.cell;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dashes);
    ctx.lineDashOffset = phase;
    rr(ctx, L.ox + cell.c * c + c * 0.08, L.oy + cell.r * c + c * 0.08, c * 0.84, c * 0.84, c * 0.2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * A single floating action capsule: a dark disc so it reads on any board, a coloured inner chip,
   * and a white check or a red cross. Anchored beside an armed ghost and clamped to the canvas.
   */
  function drawCapsule(cx: number, cy: number, kind: 'confirm' | 'cancel', color: string, c: number, still: boolean) {
    const r = CAP_R * c;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = 'rgba(12,16,26,.62)';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.fillStyle = kind === 'confirm' ? color : 'rgba(255,255,255,.95)';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.82, 0, TAU); ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, c * 0.045);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.82, 0, TAU); ctx.stroke();
    ctx.strokeStyle = kind === 'confirm' ? 'rgba(255,255,255,.96)' : MINE_RAMP.mid;
    ctx.lineWidth = Math.max(1.6, c * 0.05);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const g = r * 0.4;
    ctx.beginPath();
    if (kind === 'confirm') { ctx.moveTo(-g, 0.05 * g); ctx.lineTo(-g * 0.2, g); ctx.lineTo(g, -g * 0.9); }
    else {
      ctx.moveTo(-g * 0.7, -g * 0.7); ctx.lineTo(g * 0.7, g * 0.7);
      ctx.moveTo(g * 0.7, -g * 0.7); ctx.lineTo(-g * 0.7, g * 0.7);
    }
    ctx.stroke();
    if (!still) {                                   // a slow breath, so the pair reads as live controls
      ctx.globalAlpha = 0.18 + 0.12 * Math.sin(performance.now() / 420);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, c * 0.03);
      ctx.beginPath(); ctx.arc(0, 0, r * 0.95, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }

  /** The floating [✓]/[✕] pair anchored beside an armed ghost, clamped inside the canvas. */
  function drawCapsules(ax: number, ay: number, p: Player, still: boolean) {
    const { cell: c, ox, oy } = L;
    const confirm = capsuleConfirmPos(L, ax, ay);
    const cancel = capsuleCancelPos(L, ax, ay);
    drawCapsule(ox + confirm.x * c, oy + confirm.y * c, 'confirm', sides[p].ramp.mid, c, still);
    drawCapsule(ox + cancel.x * c, oy + cancel.y * c, 'cancel', MINE_RAMP.mid, c, still);
  }

  /**
   * The telegraphed lane: an amber wash and a marching stripe down the column the log will take,
   * with chevrons pointing at the shield line — the last row it can reach. Public information, so
   * every seat is shown the same thing, and the stripe stops where a wall stops the log, which is
   * why the ball below it needs no dodging. Reduced motion keeps it lit but perfectly still.
   */
  function drawLane(col: number, stop: number, now: number, still: boolean) {
    const c = L.cell, x0 = L.ox + col * c, top = L.oy, h = (stop + 1) * c, cx = x0 + c / 2;
    const pulse = still ? 0.55 : 0.5 + 0.5 * Math.sin(now / 260);
    ctx.save();
    rr(ctx, L.ox, top, cols * c, rows * c, CORNER * c);
    ctx.clip();
    ctx.fillStyle = `rgba(245,158,11,${0.07 + 0.05 * pulse})`;
    ctx.fillRect(x0, top, c, h);
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(245,158,11,${0.45 + 0.3 * pulse})`;
    ctx.lineWidth = Math.max(2, c * 0.11);
    ctx.setLineDash([c * 0.3, c * 0.26]);
    ctx.lineDashOffset = still ? 0 : now / 22;
    ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx, top + h); ctx.stroke();
    ctx.setLineDash(SOLID);
    ctx.lineWidth = Math.max(1.5, c * 0.07);
    ctx.strokeStyle = `rgba(253,230,138,${0.4 + 0.35 * pulse})`;
    for (let r = 1; r <= stop; r += 2) {            // a chevron every other cell, pointing the way
      const bob = still ? 0 : Math.sin(now / 300 + r) * c * 0.08;
      const y = top + (r + 0.5) * c + bob, w = c * 0.24;
      ctx.beginPath();
      ctx.moveTo(cx - w, y - c * 0.11); ctx.lineTo(cx, y + c * 0.11); ctx.lineTo(cx + w, y - c * 0.11);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** The lane's nameplate: a log glyph and "Log incoming", riding at the head of the lane. */
  function drawLaneHead(col: number, now: number, still: boolean) {
    const c = L.cell;
    const fs = Math.max(8, Math.round(c * 0.3));
    const label = 'Log incoming';
    ctx.save();
    ctx.font = `800 ${fs}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const pad = fs * 0.6, icon = fs * 1.7, gap = fs * 0.45;
    const w = icon + gap + ctx.measureText(label).width + pad * 2, h = fs * 2;
    const lo = L.ox + w / 2 + c * 0.12, hi = L.ox + cols * c - w / 2 - c * 0.12;
    const cx = clamp(L.ox + (col + 0.5) * c, Math.min(lo, hi), Math.max(lo, hi));
    const cy = L.oy + c * 0.52;
    ctx.globalAlpha = still ? 0.9 : 0.78 + 0.22 * Math.sin(now / 260);
    ctx.fillStyle = HAZARD_AMBER;
    rr(ctx, cx - w / 2, cy - h / 2, w, h, h / 2);
    ctx.fill();
    /* the glyph: a barrel seen from the side, cut end and one ring, in the chip's own dark ink */
    const gx = cx - w / 2 + pad, gy = cy, bw = icon * 0.78, bh = fs * 0.86;
    ctx.strokeStyle = HAZARD_INK;
    ctx.fillStyle = HAZARD_INK;
    ctx.lineWidth = Math.max(1, fs * 0.15);
    rr(ctx, gx, gy - bh / 2, bw, bh, bh / 2);
    ctx.stroke();
    ctx.beginPath(); ctx.ellipse(gx + bw, gy, fs * 0.19, bh / 2, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(gx + bw * 0.42, gy, fs * 0.11, bh * 0.34, 0, 0, TAU); ctx.stroke();
    ctx.fillText(label, gx + icon + gap, cy + 0.5);
    ctx.restore();
  }

  /**
   * The log itself: a clay barrel lying across the lane, lit along its back and shaded in its belly.
   * A perfect cylinder shows its rotation nowhere but on its surface, so `phase` — how far it has
   * rolled, in cells — is what scrolls the bark rings and wobbles the body.
   */
  function drawLog(cx: number, cy: number, c: number, phase: number, alpha: number) {
    const w = c * 0.92, h = c * 0.5;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.sin(phase * 2.2) * 0.05);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(0,0,0,.26)';                 // the shadow it drags over the clay
    rr(ctx, -w / 2 + c * 0.05, -h / 2 + c * 0.09, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = LOG_BODY;
    rr(ctx, -w / 2, -h / 2, w, h, h / 2);
    ctx.fill();
    ctx.save();
    rr(ctx, -w / 2, -h / 2, w, h, h / 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,.2)';
    ctx.fillRect(-w / 2, -h / 2 + h * 0.12, w, h * 0.2);
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.fillRect(-w / 2, h / 2 - h * 0.26, w, h * 0.26);
    ctx.strokeStyle = LOG_RING;
    ctx.lineWidth = Math.max(1, c * 0.05);
    for (let i = 0; i < 4; i++) {
      const t = (phase * 0.55 + i / 4) % 1;
      const k = 0.5 + 0.5 * Math.cos(t * TAU);         // a ring thins as it turns to the far side
      ctx.globalAlpha = alpha * (0.25 + 0.5 * k);
      ctx.beginPath();
      ctx.ellipse(-w / 2 + t * w, 0, Math.max(1, h * 0.24 * k), h / 2 - c * 0.07, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = LOG_END;                           // the cut end: unmistakably a log
    ctx.beginPath();
    ctx.ellipse(w / 2 - h * 0.14, 0, h * 0.18, h / 2 - c * 0.06, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /** Where a shoved ball comes to rest: a soft clay ring and a few motes. Dust, never fire. */
  function drawDust(f: { x: number; y: number; t0: number }, now: number, c: number, still: boolean) {
    const t = (now - f.t0) / DUST_MS;
    if (t < 0 || t >= 1) return;
    const ease = 1 - Math.pow(1 - t, 3);
    ctx.save();
    ctx.globalAlpha = 0.55 * (1 - t);
    ctx.strokeStyle = 'rgba(226,214,196,.9)';
    ctx.lineWidth = Math.max(1, c * 0.08 * (1 - t));
    ctx.beginPath(); ctx.arc(f.x, f.y, c * (0.28 + 1 * ease), 0, TAU); ctx.stroke();
    if (!still) {
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(203,180,150,.85)';
      ctx.lineWidth = Math.max(1, c * 0.05 * (1 - t));
      ctx.beginPath();
      for (let n = 0; n < SPARK_N; n += 2) {           // the same spark fan, flattened and grey
        const r0 = c * (0.2 + 0.8 * ease) * SPARK_L[n];
        const r1 = r0 + c * 0.26 * (1 - t);
        ctx.moveTo(f.x + SPARK_C[n] * r0, f.y + SPARK_S[n] * r0 * 0.45 + c * 0.18 * ease);
        ctx.lineTo(f.x + SPARK_C[n] * r1, f.y + SPARK_S[n] * r1 * 0.45 + c * 0.18 * ease);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw(v: View, now: number) {
    const { cell: c, ox, oy } = L;
    const still = motionReduced();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (bg) ctx.drawImage(bg, 0, 0);
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);

    // slow light sweep across the finish strip (clipped to the strip and the rounded corners)
    if (!still && sweep.grad) {
      const bw = cols * c;
      ctx.save();
      rr(ctx, ox, oy, bw, rows * c, CORNER * c);
      ctx.clip();
      ctx.beginPath(); ctx.rect(ox, oy, bw, c); ctx.clip();
      ctx.translate(ox - sweep.band + ((now % 5200) / 5200) * (bw + sweep.band), 0);
      ctx.fillStyle = sweep.grad;
      ctx.fillRect(0, oy, sweep.band, c);
      ctx.restore();
    }

    /* each team's own start squares wear a whisper of its colour, so a race reads from the bottom up */
    if (rows === ROWS && th.board.startTint > 0) {
      const key = v.state.teams.map((t) => t.balls).join(',');
      if (key !== startKey) { startKey = key; starts = startBoard(v.state); }
      ctx.save();
      ctx.globalAlpha = th.board.startTint;
      for (const s0 of starts) {
        ctx.fillStyle = sides[s0.t].ramp.mid;
        rr(ctx, ox + s0.c * c + c * 0.05, oy + s0.r * c + c * 0.05, c * 0.9, c * 0.9, c * 0.16);
        ctx.fill();
      }
      ctx.restore();
    }

    /* a telegraphed lane is nobody's secret: every seat is shown the stripe and where it stops */
    const lane = v.state.hazard?.pending ?? null;
    if (lane) drawLane(lane.left, logStopRow(v.state.walls, lane.left, lane.width), now, still);

    /* a tap just landed: a quick ripple in the colour of the seat that plays it */
    for (let i = ripples.length - 1; i >= 0; i--) {
      const f = ripples[i];
      const t = (now - f.t0) / RIPPLE_MS;
      if (t >= 1) { ripples.splice(i, 1); continue; }
      const ease = 1 - Math.pow(1 - t, 2);
      ctx.save();
      ctx.globalAlpha = 0.3 * (1 - t);
      ctx.fillStyle = sides[f.p].ramp.mid;
      ctx.beginPath(); ctx.arc(f.x, f.y, c * (0.22 + 0.6 * ease), 0, TAU); ctx.fill();
      ctx.globalAlpha = 0.6 * (1 - t);
      ctx.lineWidth = Math.max(1, c * 0.05 * (1 - t));
      ctx.beginPath(); ctx.arc(f.x, f.y, c * (0.18 + 0.78 * ease), 0, TAU); ctx.stroke();
      ctx.restore();
    }

    // last move of each seat: trail out of the old cell, ants around the old wall
    for (let pi = 0; pi < v.last.length; pi++) {
      const m = v.last[pi];
      if (!m) continue;
      const ramp = sides[pi].ramp;
      if (m.kind === 'step') {
        const ax = ox + (m.from.c + 0.5) * c, ay = oy + (m.from.r + 0.5) * c;
        const bx = ox + (m.to.c + 0.5) * c, by = oy + (m.to.r + 0.5) * c;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = ramp.mid;
        ctx.globalAlpha = 0.26;
        ctx.lineWidth = c * 0.18;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = Math.max(1.5, c * 0.045);
        ctx.setLineDash(dash.trail);
        ctx.beginPath(); ctx.arc(ax, ay, c * 0.25, 0, TAU); ctx.stroke();
        ctx.restore();
      } else {
        outline(m.spec, ramp.glow, Math.max(1.5, c * 0.035), dash.last);
      }
    }

    // legal-move dots: big, high contrast, at least a 44px target, tinted with the chosen ball's side
    const side = sides[v.state.turn];
    const pulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(now / 380);
    const dotR = Math.max(6, c * 0.17 + c * 0.014 * pulse);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = Math.max(1.5, c * 0.035);
    ctx.fillStyle = side.ramp.mid;
    ctx.shadowColor = side.ramp.glow;                 // the dots carry a little glow of their own
    ctx.shadowBlur = c * 0.4 * (0.6 + 0.4 * pulse);
    for (let i = 0; i < v.hints.length; i++) {
      const h = v.hints[i];
      const x = ox + (h.c + 0.5) * c, y = oy + (h.r + 0.5) * c;
      ctx.globalAlpha = 0.1 + 0.06 * pulse;
      ctx.beginPath(); ctx.arc(x, y, dotR * 1.75, 0, TAU); ctx.fill();
      ctx.globalAlpha = 0.72 + 0.12 * pulse;
      ctx.beginPath(); ctx.arc(x, y, dotR, 0, TAU); ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    // placeable cells while the mine key is down: a soft fill per square, no outline — 64 outlined
    // boxes read as a wall of noise, and the armed square already gets its own marching ants
    if (v.mineHints.length) {
      ctx.save();
      ctx.fillStyle = side.ramp.mid;
      ctx.globalAlpha = 0.055 + 0.03 * pulse;
      for (const h of v.mineHints) {
        rr(ctx, ox + h.c * c + c * 0.12, oy + h.r * c + c * 0.12, c * 0.76, c * 0.76, c * 0.17);
        ctx.fill();
      }
      ctx.restore();
    }

    if (v.ghost) {
      const gp = sides[v.ghost.p].ramp;
      if (v.ghost.ok) {
        drawBar(v.ghost.spec, v.ghost.p, v.ghost.armed ? 0.85 : 0.42, 1, false);
        outline(v.ghost.spec, v.ghost.armed ? gp.os : gp.ol,
          Math.max(1.5, c * 0.045), v.ghost.armed ? dash.armed : dash.ghost, still ? 0 : -now / 26, v.ghost.p);
      } else {
        // solid ring + cross: unmistakably "not here", unlike the dashed ghost above
        drawBar(v.ghost.spec, ERR, 0.3, 1, false);
        outline(v.ghost.spec, 'rgba(255,45,85,.95)', Math.max(2, c * 0.06), SOLID, 0, ERR);
        cross(v.ghost.spec, '#fff', c * 0.19);
      }
      if (v.ghost.armed) {
        const centre = wallCentre(v.ghost.spec);
        drawCapsules(centre.x, centre.y, v.ghost.p, still);
      }
    }

    // the cell already tapped in the two-tap mine flow, standing by for its confirm tap
    if (v.mineGhost) {
      const key = `${v.mineGhost.c},${v.mineGhost.r}`;
      if (key !== mineGhostKey) { mineGhostKey = key; mineGhostAt = now; }
      const p = still ? 1 : Math.min(1, (now - mineGhostAt) / 220);
      const drop = 1 + 0.55 * (1 - p) * (1 - p);        // it drops into the square and settles
      const gp = sides[v.state.turn].ramp;
      cellRing(v.mineGhost, gp.os, Math.max(1.5, c * 0.045), dash.armed, still ? 0 : -now / 26);
      drawMine(ox + (v.mineGhost.c + 0.5) * c, oy + (v.mineGhost.r + 0.5) * c, 'ghost', pulse, drop, now, still);
      drawCapsules(v.mineGhost.c + 0.5, v.mineGhost.r + 0.5, v.state.turn, still);
    } else mineGhostKey = '';

    // placed walls (pop-in + landing pulse); walls are never removed mid-game
    for (let i = 0; i < v.state.walls.length; i++) {
      const w = v.state.walls[i];
      const key = 2 * (w.y * cols + w.x) + (w.o === 'h' ? 0 : 1);
      let t0 = born.get(key);
      if (t0 === undefined) {
        t0 = now;
        born.set(key, t0);
        if (!still) { const b = box(w); pulses.push({ x: b.cx, y: b.cy, t0: now, p: w.owner }); }
      }
      const p = Math.min(1, (now - t0) / 220);
      drawBar(w, w.owner, Math.min(1, p * 3), still ? 1 : 1 - Math.pow(1 - p, 3), true);
    }

    // buried mines — this seat's own only. An enemy trap is never painted, not even by accident.
    const mineK = still ? 0.5 : 0.5 + 0.5 * Math.sin(now / 520);
    for (const m of v.state.mines) {
      if (m.triggered || m.owner !== v.human) continue;
      drawMine(ox + (m.cell.c + 0.5) * c, oy + (m.cell.r + 0.5) * c, 'buried', mineK, 1, now, still);
    }

    for (let i = pulses.length - 1; i >= 0; i--) {
      const f = pulses[i];
      const t = (now - f.t0) / 460;
      if (t >= 1) { pulses.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = 0.5 * (1 - t);
      ctx.strokeStyle = sides[f.p].ramp.mid;
      ctx.lineWidth = Math.max(1.5, c * 0.07 * (1 - t));
      ctx.beginPath(); ctx.arc(f.x, f.y, c * (0.5 + 1.5 * t), 0, TAU); ctx.stroke();
      ctx.restore();
    }

    /*
     * The trigger: a white flash, a warm core, one expanding shockwave and 14 sparks, all inside
     * BLAST_MS. Painted in the mine's own warning red — the board surface may be pale, and a mine
     * must never read as a team colour. Reduced motion keeps the flash and the ring, drops the
     * sparks.
     */
    for (let i = blasts.length - 1; i >= 0; i--) {
      const f = blasts[i];
      const t = (now - f.t0) / BLAST_MS;
      if (t >= 1) { blasts.splice(i, 1); continue; }
      const ease = 1 - Math.pow(1 - t, 3);
      ctx.save();
      if (t < 0.18) {                                  // the flash, gone before the ring lands
        const ft = t / 0.18;
        ctx.globalAlpha = (1 - ft) * 0.85;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(f.x, f.y, c * (0.32 + 0.7 * ease), 0, TAU); ctx.fill();
      }
      /* the burst's own light: a wide linear fade. Both gradients are built around the origin,
         like every other paint server here, so the context has to move onto the square first. */
      if (blastGlow) {
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.globalAlpha = 0.9 * (1 - t);
        ctx.fillStyle = blastGlow;
        ctx.beginPath(); ctx.arc(0, 0, c * 2.4, 0, TAU); ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 0.85 * (1 - t);
      ctx.strokeStyle = MINE_RAMP.mid;
      ctx.lineWidth = Math.max(1.5, c * 0.11 * (1 - t));
      ctx.beginPath(); ctx.arc(f.x, f.y, c * (0.4 + 1.9 * ease), 0, TAU); ctx.stroke();
      if (!still) {
        ctx.lineCap = 'round';
        ctx.strokeStyle = MINE_RAMP.light;
        ctx.lineWidth = Math.max(1, c * 0.05 * (1 - t));
        ctx.beginPath();
        for (let n = 0; n < SPARK_N; n++) {
          const r0 = c * (0.3 + 1.2 * ease) * SPARK_L[n];
          const r1 = r0 + c * 0.45 * (1 - t) * SPARK_L[n];
          ctx.moveTo(f.x + SPARK_C[n] * r0, f.y + SPARK_S[n] * r0);
          ctx.lineTo(f.x + SPARK_C[n] * r1, f.y + SPARK_S[n] * r1);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    /* short comet tails: a sliding ball drags a fading streak of its own colour behind it */
    for (let i = streaks.length - 1; i >= 0; i--) {
      const s0 = streaks[i];
      const t = (now - s0.t0) / STREAK_MS;
      if (t >= 1) { streaks.splice(i, 1); continue; }
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = sides[s0.p].ramp.mid;
      ctx.globalAlpha = 0.34 * (1 - t) * (1 - t);
      ctx.lineWidth = c * 0.06 + c * 0.3 * (1 - t);
      ctx.beginPath();
      ctx.moveTo(ox + s0.x0 * c, oy + s0.y0 * c);
      ctx.lineTo(ox + s0.x1 * c, oy + s0.y1 * c);
      ctx.stroke();
      ctx.restore();
    }

    // every ball on the board, the nearer one (further down) drawn last so it sits on top
    SEATS_N.fill(0);
    for (const b of v.balls) if (b.team < SEAT_COUNT) SEATS_N[b.team]++;
    ORDER.length = 0;
    for (let i = 0; i < v.balls.length; i++) ORDER.push(i);
    ORDER.sort((a, b) => v.balls[a].pos.y - v.balls[b].pos.y);
    for (const i of ORDER) {
      const b = v.balls[i];
      const seat = b.team;
      const cx = ox + b.pos.x * c, cy = oy + b.pos.y * c;
      const r = c * 0.34 * (b.sel ? 1.08 : 1);        // the chosen ball lifts off the clay
      /* the tail it is dragging right now: sampled from where it stood last frame */
      const was = prevPos.get(b.id);
      if (was) {
        if (!still) {
          const dx = b.pos.x - was.x, dy = b.pos.y - was.y;
          if (dx * dx + dy * dy > 0.0004) {
            streaks.push({ x0: was.x, y0: was.y, x1: b.pos.x, y1: b.pos.y, t0: now, p: seat });
            if (streaks.length > 96) streaks.shift();
          }
        }
        was.x = b.pos.x; was.y = b.pos.y;
      } else prevPos.set(b.id, { x: b.pos.x, y: b.pos.y });
      const active = v.state.winner === null && v.state.turn === seat;
      if (active || v.state.winner === seat) {
        drawGlow(cx, cy, r, seat, still ? 0.6 : 0.5 + 0.5 * Math.sin(now / 260));
      }
      // the chosen one stands out further than its side's turn halo does
      if (b.sel) drawSel(cx, cy, r, seat, now, still);
      let n = 1;
      for (let j = 0; j < i; j++) if (v.balls[j].team === seat) n++;
      drawBall(cx, cy, r, seat, SEATS_N[seat] > 1 ? n : 0);
    }

    /* the log rides over the balls it is shoving, then fades out on its shield line */
    if (rolls.length || dust.length) {
      ctx.save();
      rr(ctx, ox, oy, cols * c, rows * c, CORNER * c);
      ctx.clip();
      for (let i = dust.length - 1; i >= 0; i--) {
        if (now - dust[i].t0 >= DUST_MS) { dust.splice(i, 1); continue; }
        drawDust(dust[i], now, c, still);
      }
      for (let i = rolls.length - 1; i >= 0; i--) {
        const f = rolls[i];
        const t = (now - f.t0) / LOG_MS;
        if (t >= 1) { rolls.splice(i, 1); continue; }
        const run = f.stopRow + 0.5;                       // cells it covers, head of the lane first
        const go = t < 0.84 ? 1 - Math.pow(1 - t / 0.84, 2) : 1;
        drawLog(ox + (f.left + 0.5) * c, oy + (go * run - 0.45) * c, c, go * run,
          t < 0.84 ? 1 : 1 - (t - 0.84) / 0.16);
      }
      ctx.restore();
    }
    if (lane) drawLaneHead(lane.left, now, still);          // the nameplate stays above the traffic

    // "<side> is thinking" pips above that side's leading ball
    if (v.thinking !== null) {
      let lead: BallView | null = null;
      for (const b of v.balls) {
        if (b.team !== v.thinking) continue;
        if (!lead || b.pos.y < lead.pos.y) lead = b;
      }
      if (lead) {
        const x0 = ox + lead.pos.x * c, y0 = oy + lead.pos.y * c - c * 0.78;
        ctx.save();
        ctx.fillStyle = sides[v.thinking].ramp.mid;
        for (let i = 0; i < 3; i++) {
          const ph = still ? 0.6 : 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now / 260 - i * 1.1));
          ctx.globalAlpha = Math.min(1, ph);
          ctx.beginPath(); ctx.arc(x0 + (i - 1) * c * 0.22, y0, c * 0.06, 0, TAU); ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  return {
    resize,
    draw,
    layout: () => L,
    resetFx: () => {
      born.clear(); pulses.length = 0; blasts.length = 0;
      ripples.length = 0; streaks.length = 0; prevPos.clear(); mineGhostKey = '';
      rolls.length = 0; dust.length = 0;
    },
    /**
     * A warning round just closed, so its log is rolling: the sprite takes LOG_MS from the head of
     * the lane down to `stopRow`, and every ball it shoves puffs dust where it comes to rest — a
     * beat later, timed to when the log reaches it, so the hit and the slide agree. `t0` comes from
     * the caller's frame clock, so the roll and the ball hold start on the same millisecond.
     */
    rollLog(ev: LogEvent, t0: number) {
      const { cell: c, ox, oy } = L;
      rolls.push({ left: ev.left, stopRow: ev.stopRow, t0 });
      for (const m of ev.moves) {
        const f = clamp((m.from.r + 0.5) / (ev.stopRow + 1), 0.14, 0.86);
        dust.push({ x: ox + (m.to.c + 0.5) * c, y: oy + (m.to.r + 0.5) * c, t0: t0 + LOG_MS * f });
      }
    },
    /** A tap landed: a ripple where the finger was, in the seat's own colour. Board units. */
    ripple(x: number, y: number, p: Player) {
      const { cell: c, ox, oy } = L;
      ripples.push({ x: ox + x * c, y: oy + y * c, t0: performance.now(), p });
      if (ripples.length > 12) ripples.shift();
    },
    /**
     * Queue the trigger for a mine that just went off. The caller owns the moment (only it knows a
     * trigger happened), the frame loop owns the paint.
     */
    blast(at: Cell) {
      const { cell: c, ox, oy } = L;
      blasts.push({ x: ox + (at.c + 0.5) * c, y: oy + (at.r + 0.5) * c, t0: performance.now() });
    },
    /** Equipping repaints the board and every cached gradient once; never per frame. */
    setTheme(t: Theme) {
      if (t.ball === th.ball && t.wall === th.wall && t.board === th.board) return;
      th = t;
      sides = seats(t);
      buildStatic();
    },
  };
}

/* ---------- shop and profile previews ---------- */

export type PreviewKind = CosKind;

export interface Preview {
  resize(): void;
  draw(now: number): void;
  /** One settled frame: the wall pop-in clocks past, so a still preview never shows half a bar. */
  settle(): void;
  setTheme(t: Theme): void;
}

/** A `Theme` without the board fields the previews do not use. */
type Scene = { cols: number; rows: number; balls: { team: Player; at: Vec; sel?: boolean }[]; hints: Pos[]; walls: Wall[] };

/** 6x4 patches: room for a real wall layout, and a finish strip that is not the whole picture. */
const SCENES: Record<PreviewKind, Scene> = {
  // your ball on the move, theirs beside it: the pair is the thing being judged
  ball: {
    cols: 6, rows: 4,
    balls: [{ team: 0, at: { x: 2.5, y: 3.5 }, sel: true }, { team: 1, at: { x: 3.5, y: 3.5 } }],
    hints: [{ c: 1, r: 2 }, { c: 2, r: 2 }, { c: 3, r: 2 }, { c: 4, r: 2 }],
    walls: [],
  },
  // two of yours and one of theirs, so a style reads in both orientations and against the fixed one
  wall: {
    cols: 6, rows: 4,
    balls: [{ team: 0, at: { x: 0.5, y: 3.5 } }, { team: 1, at: { x: 5.5, y: 3.5 } }],
    hints: [],
    walls: [{ o: 'h', x: 0, y: 2, owner: 0 }, { o: 'v', x: 3, y: 0, owner: 0 }, { o: 'h', x: 2, y: 3, owner: 1 }],
  },
  board: {
    cols: 6, rows: 4,
    balls: [{ team: 0, at: { x: 2.5, y: 3.5 } }, { team: 1, at: { x: 4.5, y: 3.5 } }],
    hints: [],
    walls: [{ o: 'h', x: 0, y: 2, owner: 0 }, { o: 'v', x: 5, y: 1, owner: 1 }],
  },
};

const sceneView = (s: Scene): View => {
  const teams = Math.max(2, ...s.balls.map((b) => b.team + 1));
  return {
    state: {
      teams: Array.from({ length: teams }, () => ({ balls: 1 })),
      balls: s.balls.map((b, i) => ({ id: i, team: b.team, owner: b.team, pos: { c: 0, r: s.rows - 1 } })),
      walls: s.walls,
      wallsLeft: Array.from({ length: teams }, () => 0),
      mines: [],
      turn: 0,
      winner: null,
    },
    balls: s.balls.map((b, i) => ({ pos: b.at, team: b.team, id: i, sel: Boolean(b.sel) })),
    hints: s.hints,
    ghost: null,
    last: Array.from({ length: teams }, () => null),
    thinking: null,
    human: 0,
    mineHints: [],
    mineGhost: null,
    capsule: null,
  };
};

/**
 * The real renderer, pointed at a patch of board instead of a race. Every shop card and the
 * profile's equipped row use this, so a preview cannot disagree with the game it came from.
 */
export function createPreview(canvas: HTMLCanvasElement, kind: PreviewKind, theme: Theme): Preview {
  const s = SCENES[kind];
  let th = theme;
  const view = sceneView(s);
  const r = createRenderer(canvas, { cols: s.cols, rows: s.rows, theme: () => th });
  return {
    resize: r.resize,
    draw: (now: number) => r.draw(view, now),
    settle() {
      const t = performance.now();
      r.draw(view, t);
      r.draw(view, t + 500);
    },
    setTheme(t: Theme) { th = t; r.setTheme(t); },
  };
}
