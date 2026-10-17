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
  COLS, HAZARD, MAX_TEAMS, ROWS, startLayout,
  type Cell, type GameState, type LogEvent, type Player, type Pos, type Wall, type WallSpec,
} from './rules';
import { motionReduced } from './settings';
import {
  CLASSIC_BALL, CLASSIC_WALL, DEFAULT_THEME, ERR_RAMP, MINE_RAMP, NO_RAMP, OK_RAMP, SEAT_RAMPS,
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
  /** board patch to paint — the race uses whatever `GameState` says (`cols` x `rows`) */
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
/**
 * The *floor* of the groove's own reach, in cells. The live value is `grooveZone()`, which lifts it
 * to half a thumb on a cramped board: a ten-column board on a 360px phone draws ~35px cells, and
 * asking a finger to land within 10px of a hairline is not a control, it is a test.
 */
const GROOVE_ZONE = 0.3;
/**
 * The ceiling on that reach, in cells. Held just under half a cell so every point on the board still
 * resolves to exactly one nearest groove — at 0.5 the two lines bounding a cell would meet and a tap
 * between them would have no answer at all.
 */
const GROOVE_MAX = 0.46;
const MIN_TOUCH = 44;   // css px: smallest legal tap target we allow
const BADGE_FROM = 28;  // cell size below which a number badge would be unreadable
/** The board's two metrics: the ball's radius and the wall bar's thickness, both fractions of a cell. */
const BALL_R = 0.34;
const BAR_T = 0.13;
const SOLID: number[] = [];
const BLAST_MS = 700;   // the whole mine trigger, flash to last spark
const DUST_MS = 420;    // the puff a shoved ball kicks up where it comes to rest
const RIPPLE_MS = 380;  // a tap's ripple
const STREAK_MS = 300;  // how long a sliding ball's trail takes to fade
/* The log is nobody's team: like the mine's warning red it keeps its own colours, amber and wood. */
const HAZARD_AMBER = '#f59e0b';
const HAZARD_INK = '#1b1b29';
const LOG_DUST = 'rgba(222,198,164,.9)';
/* ---- the rolling log: one clock, so the sprite, the shoved balls and main.ts's locks agree ---- */
/** The trunk's steady pace, and the slower launch it eases in over the first two rows. */
export const LOG_ROW_MS = 140;
/** The whole warning a seat gets: a second of tremor and a flashing badge, then it is already on them. */
export const LOG_ALERT_MS = 1000;
const LOG_LAUNCH_ROWS = 2;
const LOG_LAUNCH_V = 0.5;      // speed it lifts off at, as a fraction of the steady pace
const LOG_FADE_MS = 200;       // the clean fade-out on its shield line
const LOG_SKID_MS = 900;       // how long the scuff it dragged stays on the clay
const LOG_SLAM_MS = 420;       // wall impact: flash, chips, recoil
const LOG_THUMP_MS = 300;      // a shoved ball's micro-bounce as it comes to rest
const LOG_BANDS = 26;          // slices per trunk: the cylinder's foreshortening resolution
/** ms the eased launch spends covering `rows` cells: the mean of its two speeds. */
const launchMs = (rows: number) => (2 * rows * LOG_ROW_MS) / (1 + LOG_LAUNCH_V);
/** Cells the trunk centre has covered `e` ms into a roll that spans `span` of them. */
function logCells(e: number, span: number): number {
  const rows = Math.min(LOG_LAUNCH_ROWS, span);
  const t1 = launchMs(rows);
  if (e <= t1) {
    const u = e / t1;
    return (rows * (2 * LOG_LAUNCH_V * u + (1 - LOG_LAUNCH_V) * u * u)) / (1 + LOG_LAUNCH_V);
  }
  return Math.min(span, rows + (e - t1) / LOG_ROW_MS);
}
/** The inverse: ms from the roll's start until the centre has covered `cells`. */
function logMsAt(cells: number, span: number): number {
  const rows = Math.min(LOG_LAUNCH_ROWS, span);
  const t1 = launchMs(rows);
  if (cells <= rows) {
    const k = (cells * (1 + LOG_LAUNCH_V)) / rows;
    const u = (Math.sqrt(LOG_LAUNCH_V * LOG_LAUNCH_V + (1 - LOG_LAUNCH_V) * k) - LOG_LAUNCH_V)
      / (1 - LOG_LAUNCH_V);
    return t1 * Math.max(0, Math.min(1, u));
  }
  return t1 + (cells - rows) * LOG_ROW_MS;
}
/** A lane that stops on `stopRow`: the centre runs from the perch above row 0 down to that row. */
const logSpan = (stopRow: number) => Math.max(0.5, stopRow + 0.5);
/** The roll's whole length — a clear sweep of this board takes ~3.9s. */
export const logRollMs = (stopRow: number) => logMsAt(logSpan(stopRow), logSpan(stopRow));
/** The trunk centre's board row `e` ms in. The balls the log pushes ride this same curve. */
export const logFaceRow = (stopRow: number, e: number) =>
  -0.5 + logCells(Math.max(0, e), logSpan(stopRow));
/** When the face reaches the ball on `row`, i.e. when that ball's shove begins. */
export const logArriveMs = (row: number, stopRow: number) =>
  logMsAt(clampCell(row + 0.5, 0, logSpan(stopRow)), logSpan(stopRow));
const clampCell = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
 * 18 wood chips, likewise: a fan thrown up out of the impact, each with its own speed, length and
 * spin. The slam draws them straight from these tables, so the burst costs no allocation either.
 */
const SPL_N = 18;
const SPL_DX = new Float32Array(SPL_N);
const SPL_DY = new Float32Array(SPL_N);
const SPL_SP = new Float32Array(SPL_N);
const SPL_LN = new Float32Array(SPL_N);
const SPL_RO = new Float32Array(SPL_N);
for (let i = 0; i < SPL_N; i++) {
  const a = -0.15 - Math.PI * (0.06 + 0.88 * (i / SPL_N));
  SPL_DX[i] = Math.cos(a) * (i % 2 === 0 ? 1 : -1);
  SPL_DY[i] = Math.sin(a);
  SPL_SP[i] = 0.6 + 1.6 * (((i * 53) % 13) / 13);
  SPL_LN[i] = 0.09 + 0.15 * (((i * 29) % 7) / 7);
  SPL_RO[i] = ((i * 17) % 11) / 11 - 0.5;
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

/**
 * An `rgba()` copy of a hex token at alpha `a`. The crest palette is authored as hex (a metal ramp
 * has no business carrying alpha), and the crown's flanking rules still have to fade out.
 */
function tint(col: string, a: number): string {
  const h = /^#([0-9a-f]{6})$/i.exec(col);
  if (!h) return col;
  const n = parseInt(h[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ---------- the board's metrics ----------
 * One cell is the whole unit system: `computeLayout` fits the grid the rules picked (8x12 for a
 * duel, 10x12 for three or four contenders) into whatever box the stage hands it, and every size
 * below is a fraction of the cell that comes out. That is what makes the board scale from a
 * 430x932 phone down to a 360x640 one without a single media query — and what makes the *touch*
 * targets scale with it, which is the part a purely visual fit would get wrong.
 */

/** The ball's radius in css px on a board whose cells are `cell` px across. */
const ballR = (cell: number) => cell * BALL_R;
/** The wall bar's thickness in css px, before the seat's own `thick` multiplier. */
const barT = (cell: number) => cell * BAR_T;
/**
 * How far from a grid line a tap still reads as "aiming at that line", in cells. A thumb is 44px;
 * on a roomy board that sits well inside the 0.3-cell floor and the zone stays tight, but a
 * ten-column board on a 360px phone draws ~35px cells and the same thumb spans two thirds of a
 * cell — so the zone grows to meet it. That growth *is* the magnet: on the wide board a tap
 * anywhere in a cell snaps to its nearest groove, and only the sliver at the exact centre (past
 * `GROOVE_MAX`) falls through to the legal-move dot underneath, which keeps the two gestures from
 * ever fighting over one tap.
 */
const grooveZone = (cell: number) => Math.min(GROOVE_MAX, Math.max(GROOVE_ZONE, MIN_TOUCH * 0.5 / cell));

/**
 * The legal-move cell a tap landed in, if any. A ball in hand draws one dot per legal destination, so
 * the *cell* under a dot is the target the player is aiming at — and a tap anywhere inside it means
 * that move, never the groove that runs along its edge. This is deliberately a containment test and
 * not a radius: `nearest` below is gated on `reach`, which on a board with fat cells is narrower than
 * half a cell, so a tap in a dot's corner would otherwise fall through to the magnet.
 */
function hintCellAt(hints: readonly Pos[], bx: number, by: number): Pos | null {
  for (const h of hints) {
    if (bx >= h.c && bx <= h.c + 1 && by >= h.r && by <= h.r + 1) return h;
  }
  return null;
}

/* ---------- hit-testing ---------- */

/**
 * Nearest valid wall slot when (bx, by) aims at a grid line, else null. Board coords.
 * `zone` is how far a tap may sit from a line and still mean it — see `grooveZone`: on the wide
 * board it is wide enough that the whole cell snaps to its nearest groove, so a two-span wall on a
 * ten-column grid is armed by aiming at the seam, not at a pixel.
 */
function slotNear(bx: number, by: number, cols: number, rows: number, zone: number): WallSpec | null {
  const hY = clamp(Math.round(by), 1, rows - 1);
  const vX = clamp(Math.round(bx), 1, cols - 1);
  const dh = Math.abs(by - hY), dv = Math.abs(bx - vX);
  if (Math.min(dh, dv) > zone) return null;
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

/**
 * Radius of a floating action capsule (the [✓] / [✕] chips), in cells, on a board whose cells are
 * `cell` px across. `CAP_R` is what a roomy board draws; on a cramped one the chip grows until it
 * is a thumb's worth of pixels, and stops at `CAP_R_MAX` so the pair still fits beside a wall
 * without the two chips touching. It only ever grows — a 430px phone draws the classic size.
 */
const CAP_R = 0.3;
const CAP_R_MAX = 0.34;
const capR = (cell: number) => Math.min(CAP_R_MAX, Math.max(CAP_R, MIN_TOUCH * 0.36 / cell));
/** Half the distance between the two capsule centres, in cells: one radius plus a hair of daylight. */
const capGap = (r: number) => r + 0.1;

/**
 * A floating capsule's centre beside a board anchor, clamped so both chips stay wholly inside the
 * canvas: the whole 2·capR disc is kept within a half-cell margin of every edge.
 */
function capsulePos(L: Layout, ax: number, ay: number, side: 'confirm' | 'cancel'): Vec {
  const dir = side === 'confirm' ? 1 : -1;
  const r = capR(L.cell);
  return {
    x: clamp(ax + dir * (capGap(r) + r), 0.5 + r, L.cols - 0.5 - r),
    y: clamp(ay, 0.5 + r, L.rows - 0.5 - r),
  };
}

/** The centre of the confirm ([✓]) capsule beside a board anchor, in board units. */
export const capsuleConfirmPos = (L: Layout, ax: number, ay: number): Vec => capsulePos(L, ax, ay, 'confirm');
/** The centre of the cancel ([✕]) capsule beside a board anchor, in board units. */
export const capsuleCancelPos = (L: Layout, ax: number, ay: number): Vec => capsulePos(L, ax, ay, 'cancel');

/** Which capsule, if either, a tap at (bx, by) lands on. Board coords in, capsule name out. */
function capsuleHit(L: Layout, bx: number, by: number, cap: CapsuleAction): 'confirm' | 'cancel' | null {
  const r = capR(L.cell), r2 = r * r;
  const c = capsuleConfirmPos(L, cap.ax, cap.ay);
  if ((bx - c.x) * (bx - c.x) + (by - c.y) * (by - c.y) <= r2) return 'confirm';
  const x = capsuleCancelPos(L, cap.ax, cap.ay);
  if ((bx - x.x) * (bx - x.x) + (by - x.y) * (by - x.y) <= r2) return 'cancel';
  return null;
}

/**
 * Pointer (CSS px, canvas-local) → the thing to act on.
 * Priority, not raw distance: an armed ghost (or the on-canvas action capsules) confirms first, one
 * of your balls picks up, a legal-move dot's own cell moves, and only a tap that is inside no dot
 * cell and nearer the groove than the nearest dot arms a wall. A tap between the dot and the groove
 * falls back to the nearest legal dot so a sloppy finger still moves rather than starting a wall.
 * One mode is left: while the mine key is armed the board offers mines and nothing else, and the
 * top and bottom two rows are refused outright.
 *
 * The groove's own reach is `grooveZone(cell)` rather than a constant: on the wide board it grows
 * until a whole cell snaps to its nearest line, which is what makes a two-span wall on a ten-column
 * grid comfortable to arm with a thumb. It never outranks a ball or a legal-move dot — those are
 * decided above it, on priority — so the magnet can only ever claim taps nothing else wanted.
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
  const gz = grooveZone(c);                         // the groove's own reach on this board, in cells
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

    /* A ball in hand makes every legal-move cell a target in its own right, and the containment
       test is what enforces it: a tap inside one is that move, full stop, and the groove is never
       even offered there. Only a tap that lands in no dot cell can arm a wall. */
    const inCell = hintCellAt(o.hints, bx, by);
    const spot = inCell
      ? { cell: inCell, d: Math.hypot(bx - inCell.c - 0.5, by - inCell.r - 0.5) }
      : nearest(o.hints, reach);
    if (spot && (inCell !== null || spot.d <= MOVE_ZONE)) {
      cand.push({ hit: { kind: 'move', to: spot.cell }, pri: 1, d: spot.d });
    } else {
      const s = slotNear(bx, by, L.cols, L.rows, gz);
      const wd = s ? distToWall(bx, by, s, 1.25) : Infinity;
      if (s && wd <= (spot ? spot.d : Infinity)) cand.push({ hit: { kind: 'wall', spec: s }, pri: 3, d: wd });
      if (spot) cand.push({ hit: { kind: 'move', to: spot.cell }, pri: 4, d: spot.d });
    }

    if (o.armed) {
      /* The confirm tap commits, so it reaches a little further than the preview that armed it did:
         the same thumb that found the slot lands on the same slot again without re-aiming. */
      const d = distToWall(bx, by, o.armed, 0.5);
      if (d <= Math.min(0.5, gz + 0.08)) cand.push({ hit: { kind: 'confirm', spec: o.armed }, pri: 2, d });
    }
  }

  cand.sort((a, b) => a.pri - b.pri || a.d - b.d);
  return cand.length ? cand[0].hit : null;
}

/* ---------- drawing ---------- */

/**
 * One seat: its colours, its ball material, its wall material. Seats 0..3 play, seat 4 refuses.
 * Seat 0 wears whatever skin the player equipped; seats 1..3 are the fixed families — cobalt, solar
 * gold, emerald — and seat 4 is the refusal red that owns no side. `SEAT_RAMPS` is the single source
 * of the fixed order, shared with `main.ts` so the HUD chips cannot drift from the spheres.
 */
interface Side { ramp: Ramp; ball: BallSkin; wall: WallStyle }

/** Every seat the rules allow, plus the refusal palette that owns no side. */
const SEAT_COUNT = MAX_TEAMS + 1;
const ERR = MAX_TEAMS;
/** Fixed families for the seats that are never themed: seats 1, 2, 3, then "no". */
const FIXED: Ramp[] = [...SEAT_RAMPS, ERR_RAMP];

/**
 * The wall's own numbering: how many tick bands a seat's bar wears. Colour already separates the
 * four seats, but a wall has to stay readable where colour does not survive — a greyscale
 * screenshot, a colour-blind eye, a board washed out by the finish-strip glow. Seat 0 wears none
 * (it is the one bar a player places themselves), and the count climbs 1 → 2 → 3 across the rest,
 * so four walls on one board can always be told apart.
 */
const SEAT_TICKS: readonly number[] = [0, 1, 2, 3];

const CORNER = 0.4;              // board corner radius, in cells
/**
 * The word the crown wears. It names the line, it is board furniture rather than UI copy, and it is
 * the one thing on the slab that has always been set in Latin.
 */
const CREST_WORD = 'FINISH';
/** Below this cell the inscription is mush rather than type, so the crown wears no word at all. */
const CREST_MIN = 24;
/** Heavy enough to survive being nine pixels tall, on the stack the app already ships. */
const crestFont = (px: number) =>
  `900 ${px}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif`;
/** Tracking between the crest's letters, in ems: wide enough to read as an inscription, not a word. */
const CREST_TRACK = 0.26;
/** How long the arrival pulse runs, and how long the crown waits for a ball to reach the line. */
const GOAL_MS = 1150;
const GOAL_WAIT_MS = 420;
/** How many balls each seat fields: filled at the top of every frame, reused, never reallocated. */
const SEATS_N = new Int16Array(SEAT_COUNT);
/** Draw order of the balls, nearest last: likewise. */
const ORDER: number[] = [];

/**
 * A rounded rect. `r` is clamped to the box and to zero: a caller that insets a shape by more than
 * half its own width — the bevel ring on a board squeezed into a handful of pixels, which is what a
 * hidden canvas produces before its stage has a size — would otherwise hand `arcTo` a negative
 * radius, and `arcTo` throws on that. A zero radius is a plain corner, which is the right answer.
 */
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
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
  const lay = startLayout(s.teams.map((t) => t.balls), s.cols, s.rows);
  for (let t = 0; t < lay.length; t++) for (const p of lay[t]) out.push({ c: p.c, r: p.r, t });
  return out;
}

/**
 * The gap the slab keeps inside its canvas. Only the ring stroke and the slab's own drop shadow
 * need room here — the card's padding does the real spacing, so the board fills the card. It is a
 * slice of a cell rather than a constant, so a cramped board keeps the same *proportion* of
 * breathing room a roomy one has, and it is floored at `LAYOUT_PAD` because the ring stroke is 1px.
 */
const LAYOUT_PAD = 2;
const layoutPad = (cell: number) => Math.max(LAYOUT_PAD, Math.min(6, cell * 0.06));

/**
 * Fit the grid into the box the stage handed us: one cell size that satisfies both axes, quantised
 * to whole device pixels so the grooves land on the pixel grid and the board stays crisp. The cell
 * floor is 1px rather than 8 — a board in a box too small for even one cell must shrink to fit, not
 * spill past its canvas — and the margin is re-derived from the cell it produced, one pass, because
 * a pad expressed in cells cannot be known before the cell is.
 */
function computeLayout(w: number, h: number, dpr: number, cols: number, rows: number): Layout {
  const fit = (m: number) => {
    const raw = Math.min((w - 2 * m) / cols, (h - 2 * m) / rows);
    return Math.max(1, Math.floor(Math.max(0, raw) * dpr) / dpr);
  };
  let cell = fit(LAYOUT_PAD);
  const m = layoutPad(cell);
  if (m !== LAYOUT_PAD) cell = fit(m);
  const ox = Math.round(((w - cols * cell) / 2) * dpr) / dpr;
  const oy = Math.round(((h - rows * cell) / 2) * dpr) / dpr;
  return { w, h, cell, ox, oy, dpr, cols, rows };
}

export function createRenderer(canvas: HTMLCanvasElement, opts: RendererOptions = {}) {
  const ctx = canvas.getContext('2d')!;
  /* The board can change size between races (`setBoard`): a duel is 8 columns, a 3- or 4-contender
     race 10. Everything below reads these, never a module constant. */
  let cols = opts.cols ?? COLS, rows = opts.rows ?? ROWS;
  let L = computeLayout(1, 1, 1, cols, rows);
  let th: Theme = opts.theme ? opts.theme() : DEFAULT_THEME;
  /** seat 0 wears the equipped skin and style; every other seat keeps its fixed family. */
  let sides: Side[] = seats(th);
  const born = new Map<number, number>();                    // wall key → first-seen time (pop-in)
  const pulses: { x: number; y: number; t0: number; p: Player }[] = []; // wall landing rings
  const blasts: { x: number; y: number; t0: number }[] = []; // mine triggers, queued by blast()
  /** The rolling log: one entry per warning that landed, and the dust its shove kicks up. */
  const rolls: { left: number; width: number; stopRow: number; t0: number; slam: boolean }[] = [];
  const dust: { x: number; y: number; t0: number }[] = [];
  /** ball id → the ms its shove lands, so the settle can bounce. Rebuilt by `rollLog`. */
  const thump = new Map<number, number>();
  const ripples: { x: number; y: number; t0: number; p: Player }[] = []; // tap feedback
  /** Sliding balls leave a short comet tail: pooled, reused, and dropped as they fade. */
  const streaks: { x0: number; y0: number; x1: number; y1: number; t0: number; p: Player }[] = [];
  const prevPos = new Map<number, Vec>();                    // ball id → where it was last frame
  let bg: HTMLCanvasElement | null = null;                   // static board layer, rebuilt on resize
  /* The trunk's pre-rendered layers, built once per resize like the board itself: an unrolled bark
     strip (one full circumference plus the visible window), one end-grain cap, its contact smudge. */
  let barkArt: HTMLCanvasElement | null = null;
  let capArt: HTMLCanvasElement | null = null;
  let smudgeArt: HTMLCanvasElement | null = null;
  let logShade: CanvasGradient | null = null;                // the cylinder's own light, local coords
  let logSkid: CanvasGradient | null = null;                 // …and the scuff it drags behind it
  /** Geometry of the trunk at this size, shared by the art build and every frame. */
  const logGeo = {
    len: 0, dia: 0, r: 0, win: 0, per: 0,
    band: new Float32Array(LOG_BANDS + 1),                   // screen slice → arc position, once
  };
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
  /**
   * The crown's inscription: struck once per resize into a tile of its own, then blitted every
   * frame. Offscreen and per-frame because it has to yield to a rolling log and flare when the line
   * is taken, and the static layer can do neither.
   */
  let crestArt: HTMLCanvasElement | null = null;
  const crestGeo = { x: 0, y: 0, w: 0, h: 0 };
  /** the crest's fade — 1 lit, 0 yielded to a log — eased against real elapsed time, not frames */
  let crestK = 1, crestT = 0;
  /** a scratch context that only ever measures the crest's type */
  let crestProbe: CanvasRenderingContext2D | null = null;
  /** the moment the line was taken, -1 = the crown is at rest; drives the arrival pulse alone */
  let goalAt = -1;
  /** the seat the rules have crowned, and the moment they did it, while its ball finishes travelling */
  let goalWait = -1, goalSeat: Player | null = null;

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

    // device-pixel snapping keeps the finish bar's hairlines crisp at any dpr (no half-pixel seams)
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
    for (let r0 = 1; r0 < rows; r0++) {            // row 0 belongs to the finish bar, not the tiles
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

    /* ---------- the goal zone: row 0 is one sculpted finish bar ----------
       The whole row is a single seamless band of dark clay — the apex kerb the board is crowned by —
       with the FINISH crest struck into it. There is no checkered inlay to break the surface up: the
       bar is one continuous recessed plane from the slab's top edge down to the arrival cells, so
       the line reads as one object rather than a strip of tiles. The row is still exactly one cell
       tall, so none of this costs the board height, and nothing about it is a separate object laid
       over the grid. */
    const kh = c;                                  // the bar is the whole crown row
    const gold = resolve(null, b.crest);
    const core = gold[(gold.length / 2) | 0][1];   // the crest's own metal, shared with its rim

    /* the bar itself: one recessed band of dark clay, lit along its crown and gathering shade
       toward its foot */
    const kerb = g.createLinearGradient(0, oy, 0, oy + kh);
    kerb.addColorStop(0, b.kerb[0]);
    kerb.addColorStop(0.55, b.kerb[1]);
    kerb.addColorStop(1, b.kerb[1]);
    g.fillStyle = kerb;
    g.fillRect(ox, oy, bw, kh);

    /* the warm-gold ambient the title sits in: one soft centred radial, so the middle of the bar
       carries a quiet glow the crest is struck into */
    const gx = ox + bw / 2, gy = oy + kh * 0.52;
    const amb = g.createRadialGradient(gx, gy, 0, gx, gy, Math.max(c * 2.2, bw * 0.3));
    amb.addColorStop(0, 'rgba(255,208,116,.22)');
    amb.addColorStop(0.5, 'rgba(255,192,92,.08)');
    amb.addColorStop(1, 'rgba(255,192,92,0)');
    g.fillStyle = amb;
    g.fillRect(ox, oy, bw, kh);

    /* the top metallic rim: a crisp gold highlight riding just inside the ring that trims the slab,
       fading into the clay so the crown reads lit rather than outlined */
    const rimH = Math.max(2, c * 0.14);
    const rim = g.createLinearGradient(0, oy, 0, oy + rimH);
    rim.addColorStop(0, 'rgba(255,244,206,.85)');
    rim.addColorStop(0.4, tint(core, 0.55));
    rim.addColorStop(1, tint(core, 0));
    g.fillStyle = rim;
    g.fillRect(ox, oy, bw, rimH);

    /* the foot of the bar, read as a bevel: a dark lip easing it onto the arrival cells, closed by
       one clean hairline — the border that separates the crown from the board proper */
    const lip = Math.max(2, c * 0.2);
    const foot = g.createLinearGradient(0, oy + kh - lip, 0, oy + kh);
    foot.addColorStop(0, 'rgba(0,0,0,0)');
    foot.addColorStop(1, 'rgba(0,0,0,.5)');
    g.fillStyle = foot;
    g.fillRect(ox, oy + kh - lip, bw, lip);
    g.fillStyle = b.rule;
    g.fillRect(ox, px(oy + c) - Math.max(1, c * 0.02), bw, Math.max(1, c * 0.02));

    /* the light the goal zone throws down onto the arrival tiles: the emerald wash the arena is
       themed with, and its warm amber partner, both starting below the line so they never wash the
       checks out. This is what takes the hard seam out of the join with row 1. */
    for (const stops of [b.glow, b.spill]) {
      const fg = g.createLinearGradient(0, oy + c, 0, oy + 3.6 * c);
      for (const [t, col] of resolve(null, stops)) fg.addColorStop(t, col);
      g.fillStyle = fg;
      g.fillRect(ox, oy + c, bw, 2.6 * c);
    }

    /* three soft beams falling out of the finish, gone by the fourth row */
    if (b.beam) {
      const top = oy + c, bot = oy + c * 3.5;
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
    sg.addColorStop(0, `rgba(255,236,178,0)`);
    sg.addColorStop(0.44, `rgba(255,236,178,${b.sweep})`);
    sg.addColorStop(0.56, `rgba(255,236,178,${b.sweep})`);
    sg.addColorStop(1, `rgba(255,236,178,0)`);
    sweep.grad = sg;
    const br = ballR(c);
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
    const mr = ballR(c);
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
    buildLogArt();
    buildCrest(bw);
  }

  /**
   * Strike the crown's inscription at this board's own scale: measure the word once at a known size
   * and let the bar set the type, never the other way round. Then the metal — a crisp dark drop into
   * the clay, a hair of light along each glyph's crown, and the gold ramp over the two — so the word
   * reads as an embossed strike rather than a label dropped onto the bar. Two tapered accents flank
   * it: thick at the word's shoulder, drawn to a point and faded out, so the line stays centred on
   * the bar without a hard end.
   */
  function buildCrest(bw: number) {
    const { cell: c, ox, oy, dpr } = L;
    const kh = c;
    crestArt = null;
    if (c < CREST_MIN) return;
    const m = crestProbe ?? (crestProbe = document.createElement('canvas').getContext('2d')!);
    m.font = crestFont(100);
    let units = 0;                                   // the word's width per 100px of type, tracking in
    for (const ch of CREST_WORD) units += m.measureText(ch).width + CREST_TRACK * 100;
    units -= CREST_TRACK * 100;
    /* the inscription leaves the bar's own ends bare, so the band still reads as one moulding */
    const fs = Math.min(kh * 0.42, ((bw - c * 2.6) / units) * 100);
    if (fs < 6) return;
    const track = fs * CREST_TRACK;
    m.font = crestFont(fs);
    const wds: number[] = [];
    let tw = 0;
    for (const ch of CREST_WORD) { const w = m.measureText(ch).width; wds.push(w); tw += w + track; }
    tw -= track;
    const rule = fs * 1.5, gap = fs * 0.6, H = fs * 1.7, W = tw + 2 * (rule + gap);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil(W * dpr));
    cv.height = Math.max(1, Math.ceil(H * dpr));
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.textBaseline = 'middle';
    const mid = H / 2, cx = W / 2;
    const gold = resolve(null, th.board.crest);
    const core = gold[(gold.length / 2) | 0][1];
    const strike = (dy: number) => {
      let x = cx - tw / 2;
      for (let i = 0; i < wds.length; i++) { g.fillText(CREST_WORD[i], x, mid + dy); x += wds[i] + track; }
    };
    for (const sgn of [-1, 1]) {
      const x0 = cx + sgn * (tw / 2 + gap), x1 = x0 + sgn * rule;
      const h0 = Math.max(1, fs * 0.075), h1 = Math.max(0.5, fs * 0.02);
      const rl = g.createLinearGradient(x0, 0, x1, 0);
      rl.addColorStop(0, tint(core, 0.95));
      rl.addColorStop(0.45, tint(core, 0.55));
      rl.addColorStop(1, tint(core, 0));
      g.fillStyle = rl;
      g.beginPath();
      g.moveTo(x0, mid - h0);
      g.lineTo(x1, mid - h1);
      g.lineTo(x1, mid + h1);
      g.lineTo(x0, mid + h0);
      g.closePath();
      g.fill();
      g.beginPath();                                 // the finial that finishes the accent at the word
      g.arc(x0 + sgn * fs * 0.06, mid, Math.max(0.8, fs * 0.045), 0, TAU);
      g.fillStyle = tint(core, 0.9);
      g.fill();
    }
    g.fillStyle = 'rgba(0,0,0,.65)';                 // the crisp drop the raised metal casts
    strike(fs * 0.09);
    g.fillStyle = 'rgba(255,248,220,.38)';           // a hair of light along each glyph's crown
    strike(-fs * 0.035);
    const body = g.createLinearGradient(0, mid - fs * 0.52, 0, mid + fs * 0.52);
    for (const [t, col] of gold) body.addColorStop(t, col);
    g.fillStyle = body;
    strike(0);
    crestArt = cv;
    crestGeo.w = W; crestGeo.h = H;
    crestGeo.x = ox + (bw - W) / 2;
    crestGeo.y = oy + kh * 0.5 - H / 2;
  }

  /** Has the seat that took the race actually arrived on the line, or is its ball still gliding? */
  function leadsOnLine(v: View, seat: Player): boolean {
    for (const b of v.balls) if (b.team === seat && b.pos.y <= 0.62) return true;
    return false;
  }

  /**
   * The trunk's own static layers, once per resize: its bark unrolled along the circumference so a
   * slice of it can be blitted straight onto the cylinder, one end-grain cap, the smudge it drags,
   * and the two paint servers that give the bar its round body. A roll is then nothing but blits —
   * the bark is never redrawn and no frame ever builds a gradient.
   */
  function buildLogArt() {
    const { cell: c, dpr } = L;
    const dia = c * 0.95, r = dia / 2;
    const len = c * HAZARD.logWidth * 1.06;   // the lane, plus the overhang past both rails
    const per = TAU * r;                       // one full turn of bark, in css px
    const win = Math.PI * r;                   // …and the half the viewer ever sees
    logGeo.len = len; logGeo.dia = dia; logGeo.r = r; logGeo.per = per; logGeo.win = win;
    for (let j = 0; j <= LOG_BANDS; j++) {     // a screen slice and the arc position it maps onto
      logGeo.band[j] = r * Math.asin(-1 + 2 * (j / LOG_BANDS)) + win / 2;
    }
    let seed = 0x51ed7a;                       // fixed: the same tree in every build and every shot
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const bark = barkArt || (barkArt = document.createElement('canvas'));
    bark.width = Math.max(1, Math.round(len * dpr));
    bark.height = Math.max(1, Math.round((per + win) * dpr));
    const k = bark.getContext('2d')!;
    k.setTransform(1, 0, 0, 1, 0, 0);
    k.clearRect(0, 0, bark.width, bark.height);
    k.setTransform(dpr, 0, 0, dpr, 0, 0);
    /* three passes: the motif authors exactly one period, and the copies on either side of it are
       what make the seam where the bark wraps round invisible */
    for (let pass = -1; pass <= 1; pass++) {
      k.save();
      k.beginPath(); k.rect(0, 0, len, per + win); k.clip();
      k.translate(0, pass * per);
      k.fillStyle = '#5b3c25';
      k.fillRect(0, 0, len, per);
      for (let i = 0; i < 8; i++) {            // plates: low bands of tone along the whole length
        k.globalAlpha = 0.3 + rnd() * 0.35;
        k.fillStyle = i % 2 ? '#6d4a2d' : '#4a3020';
        k.fillRect(0, rnd() * per, len, per * (0.08 + rnd() * 0.17));
      }
      k.globalAlpha = 1;
      k.lineCap = 'round';
      for (let i = 0; i < 24; i++) {           // the lengthwise grain, lit on one side, dark on the other
        const y = rnd() * per, amp = per * 0.02 * rnd();
        k.strokeStyle = i % 3 === 0 ? 'rgba(255,214,158,.30)' : 'rgba(30,18,10,.45)';
        k.lineWidth = 0.6 + rnd() * c * 0.05;
        k.beginPath();
        for (let x = 0; x <= len + 0.1; x += len / 7) k.lineTo(x, y + Math.sin(x * 0.09 + i) * amp);
        k.stroke();
      }
      for (let i = 0; i < 40; i++) {           // vertical grain: cracks across the ridges
        const x = rnd() * len, y = rnd() * per, h = per * (0.04 + rnd() * 0.14);
        k.strokeStyle = i % 4 === 0 ? 'rgba(18,10,5,.6)' : 'rgba(228,190,146,.2)';
        k.lineWidth = Math.max(0.6, c * (0.012 + rnd() * 0.032));
        k.beginPath();
        k.moveTo(x, y);
        k.lineTo(x + (rnd() - 0.5) * c * 0.08, y + h);
        k.stroke();
      }
      for (let i = 0; i < 4; i++) {            // knots: a dark eye with a lit ring around it
        const x = c * (0.3 + rnd() * (HAZARD.logWidth * 1.06 - 0.6));
        const y = rnd() * per, rx = c * (0.09 + rnd() * 0.09), ry = c * (0.05 + rnd() * 0.07);
        k.fillStyle = 'rgba(36,22,11,.85)';
        k.beginPath(); k.ellipse(x, y, rx, ry, 0, 0, TAU); k.fill();
        k.strokeStyle = 'rgba(214,170,120,.45)';
        k.lineWidth = Math.max(0.8, c * 0.026);
        k.beginPath(); k.ellipse(x, y, rx * 1.7, ry * 1.7, 0, 0, TAU); k.stroke();
      }
      for (let i = 0; i < 3; i++) {            // branch stubs: a limb sawn off, rings and all
        const x = rnd() * len, y = rnd() * per, s0 = c * (0.16 + rnd() * 0.14);
        k.save();
        k.translate(x, y);
        k.rotate(rnd() * TAU);
        k.fillStyle = '#7e5733';
        rr(k, -s0 * 0.5, -s0 * 0.34, s0, s0 * 0.68, s0 * 0.3);
        k.fill();
        k.strokeStyle = 'rgba(28,16,8,.7)';
        k.lineWidth = Math.max(0.8, c * 0.02);
        k.stroke();
        k.strokeStyle = 'rgba(226,190,142,.5)';
        k.beginPath(); k.ellipse(s0 * 0.42, 0, s0 * 0.1, s0 * 0.24, 0, 0, TAU); k.stroke();
        k.restore();
      }
      k.restore();
    }

    /* one end-grain cap: the years of it, plus the checks that run out to the bark */
    const rx = dia * 0.26;
    const cap = capArt || (capArt = document.createElement('canvas'));
    cap.width = Math.max(1, Math.round(rx * 2 * dpr));
    cap.height = Math.max(1, Math.round(dia * dpr));
    const p = cap.getContext('2d')!;
    p.setTransform(dpr, 0, 0, dpr, 0, 0);
    p.translate(rx, r);
    const face = p.createRadialGradient(-rx * 0.2, -r * 0.2, dia * 0.04, 0, 0, r * 1.05);
    face.addColorStop(0, '#e6c193');
    face.addColorStop(0.55, '#c1935f');
    face.addColorStop(1, '#8a6034');
    p.beginPath(); p.ellipse(0, 0, rx, r, 0, 0, TAU);
    p.fillStyle = face; p.fill();
    p.save();
    p.clip();
    p.lineWidth = Math.max(0.7, c * 0.018);
    for (let i = 1; i <= 9; i++) {
      const t = Math.pow(i / 9.6, 1.5);         // rings crowd together toward the sapwood
      p.strokeStyle = i % 2 ? 'rgba(96,64,34,.5)' : 'rgba(240,214,176,.34)';
      p.beginPath(); p.ellipse(-rx * 0.08, r * 0.04, rx * t, r * t, 0, 0, TAU); p.stroke();
    }
    p.strokeStyle = 'rgba(52,32,16,.55)';
    p.lineWidth = Math.max(0.8, c * 0.022);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + 0.5;
      p.beginPath();
      p.moveTo(Math.cos(a) * rx * 0.1, Math.sin(a) * r * 0.1);
      p.lineTo(Math.cos(a) * rx * (0.72 + 0.24 * (i % 2)), Math.sin(a) * r * (0.7 + 0.26 * (i % 3)));
      p.stroke();
    }
    p.restore();
    p.strokeStyle = 'rgba(30,18,9,.92)';        // the cut bark edge: a rim, not a hairline
    p.lineWidth = Math.max(1.2, c * 0.055);
    p.beginPath(); p.ellipse(0, 0, rx, r, 0, 0, TAU); p.stroke();

    /* the smudge it drags: soft, elongated, and moving with it rather than stamped under it */
    const sm = smudgeArt || (smudgeArt = document.createElement('canvas'));
    sm.width = Math.max(1, Math.round(len * 1.2 * dpr));
    sm.height = Math.max(1, Math.round(dia * 1.7 * dpr));
    const q = sm.getContext('2d')!;
    q.setTransform(dpr, 0, 0, dpr, 0, 0);
    q.translate(len * 0.6, dia * 0.85);
    q.scale(len * 0.6, dia * 0.8);
    const soft = q.createRadialGradient(0, 0, 0, 0, 0, 1);
    soft.addColorStop(0, 'rgba(6,8,14,.55)');
    soft.addColorStop(0.45, 'rgba(6,8,14,.3)');
    soft.addColorStop(1, 'rgba(6,8,14,0)');
    q.fillStyle = soft;
    q.beginPath(); q.arc(0, 0, 1, 0, TAU); q.fill();

    /* the cylinder's light and the scuff, both authored around the origin and moved by the transform */
    const sh = ctx.createLinearGradient(0, -r, 0, r);
    sh.addColorStop(0, 'rgba(6,8,14,.6)');       // ambient dark into the far edge
    sh.addColorStop(0.16, 'rgba(20,14,8,.26)');
    sh.addColorStop(0.34, 'rgba(255,206,146,.3)');  // the directional highlight, warm
    sh.addColorStop(0.5, 'rgba(255,236,196,.13)');
    sh.addColorStop(0.7, 'rgba(24,16,9,.22)');
    sh.addColorStop(0.88, 'rgba(8,6,4,.5)');
    sh.addColorStop(1, 'rgba(4,4,8,.66)');       // …and the side it rolls on
    logShade = sh;
    const sk = ctx.createLinearGradient(-len / 2, 0, len / 2, 0);
    sk.addColorStop(0, 'rgba(14,10,6,0)');
    sk.addColorStop(0.18, 'rgba(14,10,6,.5)');
    sk.addColorStop(0.5, 'rgba(10,7,4,.62)');
    sk.addColorStop(0.82, 'rgba(14,10,6,.5)');
    sk.addColorStop(1, 'rgba(14,10,6,0)');
    logSkid = sk;
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
   * walls just rotate), so one cached gradient serves both orientations.
   *
   * The body is inset twice over. Once for the caps: a round cap hangs `t/2` past each end, so the
   * stroke starts at `t/2` and the two together still span exactly the two cells the wall covers.
   * Then once more by a hair, so an L-corner or a T-junction stops just short of the perpendicular
   * wall it touches instead of bulging over it.
   */
  function drawBar(w: WallSpec, pi: number, alpha: number, grow: number, glow: boolean) {
    const { cell: c, ox, oy, dpr } = L;
    const s = sides[pi];
    const st = s.wall;
    const t = barT(c) * st.thick * (0.62 + 0.38 * grow);
    const cap = st.caps === 'butt' ? 0 : t / 2;
    const x0 = cap + Math.min(2, c * 0.06), len = Math.max(0, 2 * c - 2 * x0);
    ctx.save();
    ctx.translate(ox + w.x * c, oy + w.y * c);
    if (w.o === 'v') { ctx.translate(0, 2 * c); ctx.rotate(-Math.PI / 2); }
    ctx.lineCap = st.caps;
    ctx.globalAlpha = alpha * st.alpha;
    ctx.lineWidth = t;
    ctx.strokeStyle = barGrad(pi, t);
    if (glow && st.glow > 0) { ctx.shadowColor = s.ramp.glow; ctx.shadowBlur = c * 0.16 * st.glow * dpr; }
    ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0 + len, 0); ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    if (st.gloss > 0) {                                       // highlight, by default on the lit (upper) side
      ctx.strokeStyle = `rgba(255,255,255,${st.gloss})`;
      ctx.lineWidth = Math.max(1, t * (st.glossAt === 0 ? 0.34 : 0.26));
      ctx.beginPath();
      ctx.moveTo(x0 + t * 0.2, t * st.glossAt); ctx.lineTo(x0 + len - t * 0.2, t * st.glossAt);
      ctx.stroke();
    }
    if (st.rim > 0) {                                         // a pane reads through its edge
      ctx.globalAlpha = alpha * st.rim;
      ctx.strokeStyle = s.ramp.light;
      ctx.lineWidth = Math.max(1, t * 0.12);
      rr(ctx, x0, -t / 2, len, t, t / 2);
      ctx.stroke();
      ctx.globalAlpha = alpha * st.alpha;
    }
    /* Ownership that survives losing colour: a seat's own number of tick bands across its bar, so
       four walls on one board still read apart in greyscale. Seat 0 wears none — it is the bar the
       player places themselves, and the one they never have to identify. */
    const ticks = SEAT_TICKS[pi] ?? 0;
    if (ticks > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,.52)';
      ctx.lineWidth = Math.max(1, t * 0.26);
      ctx.beginPath();
      for (let i = 0; i < ticks; i++) {
        const x = x0 + (len * (i + 1)) / (ticks + 1);
        ctx.moveTo(x, -t * 0.4); ctx.lineTo(x, t * 0.4);
      }
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

    /* the crisp edge: the 1px stroke's own centre-line, pulled inside the silhouette so the ring
       does not feather past it. On a cramped board `r` can fall under half a pixel, so the inset
       is clamped to zero — a hairline ring on a 1px ball, never a negative radius (which throws). */
    ctx.beginPath(); ctx.arc(0, 0, Math.max(0, r - 0.5), 0, TAU);
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
   * a bevel rim and a white glyph. The chip's own ramp decides its colour — emerald for confirm,
   * crimson for cancel (OK_RAMP / NO_RAMP) — so the pair says yes/no the same way for every seat
   * and on every board. Anchored beside an armed ghost and clamped to the canvas.
   */
  function drawCapsule(cx: number, cy: number, kind: 'confirm' | 'cancel', ramp: Ramp, c: number, still: boolean) {
    const r = capR(c) * c;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = 'rgba(12,16,26,.62)';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.fillStyle = ramp.mid;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.82, 0, TAU); ctx.fill();
    ctx.strokeStyle = ramp.dark;
    ctx.lineWidth = Math.max(1.5, c * 0.045);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.82, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.96)';
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
      ctx.strokeStyle = ramp.mid;
      ctx.lineWidth = Math.max(1, c * 0.03);
      ctx.beginPath(); ctx.arc(0, 0, r * 0.95, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The floating [✓]/[✕] pair anchored beside an armed ghost, clamped inside the canvas. Which seat
   * armed the ghost makes no difference to the pair: the ramps are OK_RAMP and NO_RAMP.
   */
  function drawCapsules(ax: number, ay: number, still: boolean) {
    const { cell: c, ox, oy } = L;
    const confirm = capsuleConfirmPos(L, ax, ay);
    const cancel = capsuleCancelPos(L, ax, ay);
    /* semantics, not the placing seat: green tick, red cross, whatever p is wearing */
    drawCapsule(ox + confirm.x * c, oy + confirm.y * c, 'confirm', OK_RAMP, c, still);
    drawCapsule(ox + cancel.x * c, oy + cancel.y * c, 'cancel', NO_RAMP, c, still);
  }

  /**
   * The strike alert: the only heads-up a log gives. The lane's tiles jump around under it and a
   * hazard badge blinks at the head of the columns the trunk is about to come down — then it does.
   * `k` is how far through the second we are, so the badge can lean in. Reduced motion keeps the
   * badge lit and the board dead still: the warning stays readable, the tremor does not.
   */
  function drawStrike(left: number, width: number, k: number, now: number, still: boolean) {
    const c = L.cell, dpr = L.dpr, x0 = L.ox + left * c, w = width * c, top = L.oy;
    ctx.save();
    rr(ctx, L.ox, top, cols * c, rows * c, CORNER * c);
    ctx.clip();
    if (!still && bg) {
      const a = Math.sin(now / 6.1) + Math.sin(now / 2.7) * 0.5;
      const j = (a > 0 ? 2 : a < -0.2 ? -2 : 1) / dpr;
      ctx.drawImage(bg, x0 * dpr, top * dpr, w * dpr, rows * c * dpr, x0 + j, top - j, w, rows * c);
    }
    const cx = x0 + w / 2, cy = top + c * 0.62;
    const r = c * 0.6 * (0.86 + 0.14 * k);
    /* one second is not long: the badge blinks hard rather than fading politely */
    ctx.globalAlpha = still || Math.floor(now / 95) % 2 === 0 ? 1 : 0.42;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r * 0.95, cy + r * 0.66); ctx.lineTo(cx - r * 0.95, cy + r * 0.66);
    ctx.closePath();
    ctx.fillStyle = HAZARD_AMBER;
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, c * 0.05);
    ctx.strokeStyle = 'rgba(27,27,41,.8)';
    ctx.stroke();
    ctx.fillStyle = HAZARD_INK;                     // the bang inside it
    ctx.fillRect(cx - c * 0.055, cy - r * 0.3, c * 0.11, r * 0.5);
    ctx.beginPath(); ctx.arc(cx, cy + r * 0.36, c * 0.068, 0, TAU); ctx.fill();
    ctx.restore();
  }

  /**
   * The trunk: bark painted once into a strip unrolled along its own circumference, then blitted
   * back onto the body slice by slice, each slice landing where the cylinder's curvature puts it.
   * That is what makes the roll read — `arc` is the distance travelled in css px, which for a wheel
   * of this radius *is* its rotation, so the grain turns over the top, down the face and out of the
   * bottom edge while the shading and the two cut ends stay exactly where the light puts them.
   */
  function drawTrunk(cx: number, cy: number, arc: number, alpha: number, tilt: number) {
    const bark = barkArt, cap = capArt, smudge = smudgeArt, shade = logShade;
    const { len, dia, r, per, band } = logGeo;
    if (!bark || !cap || !smudge || !shade || len <= 0) return;
    const d = L.dpr;
    ctx.save();
    /* the contact shadow first, and further down the slope than the body it belongs to */
    ctx.globalAlpha = alpha * 0.9;
    ctx.drawImage(smudge, cx - len * 0.6, cy - dia * 0.1, len * 1.2, dia * 1.7);
    ctx.translate(cx, cy);
    if (tilt !== 0) ctx.rotate(tilt);
    ctx.globalAlpha = alpha;
    rr(ctx, -len / 2, -r, len, dia, r);
    ctx.save();
    ctx.clip();
    const base = ((arc % per) + per) % per;
    const bh = dia / LOG_BANDS;
    for (let j = 0; j < LOG_BANDS; j++) {
      const s0 = (base + band[j]) * d;
      const sh = Math.min(bark.height - s0, (band[j + 1] - band[j]) * d + 0.6);
      if (sh <= 0) continue;
      ctx.drawImage(bark, 0, s0, bark.width, sh, -len / 2, -r + j * bh, len, bh + 0.35);
    }
    ctx.fillStyle = shade;                      // ambient edges, warm highlight, dark belly
    ctx.fillRect(-len / 2, -r, len, dia);
    const cw = dia * 0.52, ch = dia * 0.96;      // the two exposed ends, just inside the silhouette
    ctx.drawImage(cap, -len / 2 + cw * 0.14, -ch / 2, cw, ch);
    ctx.drawImage(cap, len / 2 - cw * 1.14, -ch / 2, cw, ch);
    const lw = Math.max(1, dia * 0.06);
    const edge = (col: string, y: number, hh: number) => {
      ctx.save();
      ctx.beginPath(); ctx.rect(-len / 2 - 2, y, len + 4, hh); ctx.clip();
      ctx.strokeStyle = col;
      ctx.lineWidth = lw;
      rr(ctx, -len / 2 + lw / 2, -r + lw / 2, len - lw, dia - lw, r - lw / 2);
      ctx.stroke();
      ctx.restore();
    };
    edge('rgba(255,230,186,.5)', -r - 2, r * 1.5);      // rim light along the lit edge
    edge('rgba(8,6,4,.55)', r * 0.2, r * 1.2);          // …and the line it rolls on
    ctx.restore();
    ctx.restore();
  }

  /** The churn along a rolling trunk's leading edge: puffs that come and go with the roll itself. */
  function drawChurn(cx: number, cy: number, now: number, c: number) {
    ctx.save();
    ctx.fillStyle = LOG_DUST;
    for (let i = 0; i < 6; i++) {
      const t = ((now / 260) + i / 6) % 1;
      ctx.globalAlpha = 0.3 * (1 - t);
      const x = cx + Math.sin(i * 2.2) * logGeo.len * 0.4;
      const y = cy + logGeo.r * 0.78 + t * c * 0.55;
      ctx.beginPath(); ctx.arc(x, y, c * (0.05 + 0.16 * t), 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  /** The scuff it drags: a smear from the head of the lane down to where the trunk stands now. */
  function drawSkid(left: number, width: number, head: number, alpha: number) {
    const c = L.cell;
    if (!logSkid || alpha <= 0) return;
    ctx.save();
    ctx.translate(L.ox + (left + width / 2) * c, 0);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = logSkid;
    ctx.fillRect(-logGeo.len / 2, L.oy, logGeo.len, (head + 0.5) * c);
    ctx.restore();
  }

  /**
   * The wall slam: the bars that took it flash and bounce back up the lane by 8% of a cell, the
   * impact throws a fan of chips off the contact line, and the whole thing is over in the time it
   * takes the trunk to fade. Same 18 vectors every time, so a burst still allocates nothing.
   */
  function drawSlam(walls: readonly Wall[], left: number, width: number, stop: number, k: number) {
    const c = L.cell;
    const line = L.oy + (stop + 1) * c, x0 = L.ox + left * c, w = width * c;
    ctx.save();
    ctx.translate(0, -Math.sin(k * Math.PI) * (1 - k) * c * 0.08);
    for (const wl of walls) {
      if (wl.o !== 'h' || wl.y !== stop + 1) continue;
      if (wl.x > left + width - 1 || wl.x + 1 < left) continue;
      drawBar(wl, wl.owner, 1, 1, true);
      const b = box(wl);
      ctx.globalAlpha = 0.85 * (1 - k);
      ctx.strokeStyle = '#fff3d6';
      ctx.lineWidth = Math.max(2, c * 0.17 * (1 - k));
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + b.w, b.y); ctx.stroke();
    }
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 0.45 * (1 - k) * (1 - k);
    ctx.fillStyle = HAZARD_AMBER;
    ctx.fillRect(x0, line - c * 0.55, w, c * 1.1);
    ctx.lineCap = 'round';
    for (let n = 0; n < SPL_N; n++) {
      const fly = SPL_SP[n] * k * (1 - 0.25 * k);
      const x = x0 + w * (0.06 + 0.88 * (((n * 7) % 11) / 10)) + SPL_DX[n] * fly * c * 1.5;
      const y = line + SPL_DY[n] * fly * c * 1.5 + c * 3.4 * k * k;    // …and gravity takes them
      const a = 0.9 * (1 - k);
      if (a <= 0.02 || y > line + c * 1.2) continue;
      ctx.globalAlpha = a;
      ctx.strokeStyle = n % 3 === 0 ? '#d8b48b' : '#8a5c33';
      ctx.lineWidth = Math.max(1, c * 0.055 * (1 - k * 0.5));
      const sp = SPL_RO[n] * k * 6, dx = Math.cos(sp) * SPL_LN[n] * c, dy = Math.sin(sp) * SPL_LN[n] * c;
      ctx.beginPath(); ctx.moveTo(x - dx, y - dy); ctx.lineTo(x + dx, y + dy); ctx.stroke();
    }
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
    /* Self-heal the fit before painting. `setBoard` re-fits on every race, but a board built while
       its screen was still hidden measures a zero box and keeps that degenerate cell forever: the
       stage's ResizeObserver catches the reveal only when the *wrap* changes size, and a wrap that
       was already sized can stay silent. Two property reads per frame buy a board that can never
       paint at a stale size — the bug was a ball drawn at cell 1.08 (a negative `r - 0.5` throw). */
    if (canvas.clientWidth !== lastW || canvas.clientHeight !== lastH) resize();
    const { cell: c, ox, oy } = L;
    const still = motionReduced();
    /*
     * The goal was crossed. The rules land a winner the moment the ball *lands*, but the ball is
     * still gliding there, so the crown waits for it to touch the line — and if it never does (a
     * forfeit, an adjudication: a win that never touched the board) the wait itself fires the pulse.
     */
    const win = v.state.winner;
    if (win === null) { goalWait = -1; goalSeat = null; }
    else if (goalSeat !== win) { goalSeat = win; goalWait = now; }
    if (win !== null && goalWait >= 0 && (now - goalWait > GOAL_WAIT_MS || leadsOnLine(v, win))) {
      goalWait = -1;
      goalAt = now;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (bg) ctx.drawImage(bg, 0, 0);
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);

    /*
     * Everything below is board furniture — the strip's sweep, the start tints, walls, mines,
     * landing pulses, blast rings, the balls and their halos and rings, the rolling log and the
     * thinking pips. The slab *is* the board, so none of it may paint outside the slab.
     *
     * This used to be free: the board filled its canvas edge to edge and the canvas clipped the
     * spill for us. Now the grid is centred inside a box of its own aspect, so a bottom-row ball's
     * selection ring (`r * 1.6`) and turn halo (`r * 2.3`) reach past the slab and float on the card
     * as a crimson arc under the board. One clip here covers every one of them.
     */
    ctx.save();
    rr(ctx, ox, oy, cols * c, rows * c, CORNER * c);
    ctx.clip();

    /* ---- the goal zone's own furniture: the crown's inscription and the light it wears ----
       The strike badge is painted at the heart of this same band, so the crest steps aside while a
       log is on it, exactly as the plate used to — only now it is the board's own paint doing it,
       and no DOM layer has to be kept welded to a row that moves with the layout. */
    const lane = rolls.length > 0;
    const dtc = crestT ? clamp((now - crestT) / 1000, 0, 0.05) : 0;
    crestT = now;
    crestK += ((lane ? 0 : 1) - crestK) * (still ? 1 : 1 - Math.exp(-dtc * 18));
    const goal = goalAt >= 0 ? 1 - (now - goalAt) / GOAL_MS : -1;   // -1 = the crown is at rest
    if (goal <= 0) goalAt = -1;

    const bw = cols * c;
    /* the strip's idle light sweep, held back while the arrival pulse is running the same band */
    if (!still && sweep.grad && goal < 0) {
      ctx.save();
      rr(ctx, ox, oy, bw, rows * c, CORNER * c);
      ctx.clip();
      ctx.beginPath(); ctx.rect(ox, oy, bw, c); ctx.clip();
      ctx.translate(ox - sweep.band + ((now % 5200) / 5200) * (bw + sweep.band), 0);
      ctx.fillStyle = sweep.grad;
      ctx.fillRect(0, oy, sweep.band, c);
      ctx.restore();
    }

    if (crestArt && crestK > 0.01) {
      ctx.save();
      ctx.globalAlpha = crestK;
      ctx.drawImage(crestArt, crestGeo.x, crestGeo.y, crestGeo.w, crestGeo.h);
      if (goal > 0) {                                   // the metal catches the line as it is taken
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = crestK * goal * 0.85;
        ctx.drawImage(crestArt, crestGeo.x, crestGeo.y, crestGeo.w, crestGeo.h);
      }
      ctx.restore();
    }

    /* the victory pulse: one golden pass of light along the unified finish bar plus a wash over the
       whole goal zone. Additive, inside the slab, and gone in just over a second — nothing here
       moves a box, so the victory card cannot land on a board that has shifted under it. */
    if (goal > 0) {
      ctx.save();
      rr(ctx, ox, oy, bw, rows * c, CORNER * c);
      ctx.clip();
      ctx.beginPath(); ctx.rect(ox, oy, bw, c); ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,222,142,${(0.22 * goal * goal).toFixed(3)})`;
      ctx.fillRect(ox, oy, bw, c);
      if (!still && sweep.grad) {
        ctx.translate(ox - sweep.band + (bw + sweep.band) * (1 - goal * goal), 0);
        ctx.globalAlpha = 0.4 + 0.6 * goal;
        ctx.fillStyle = sweep.grad;
        ctx.fillRect(0, oy, sweep.band, c);
      }
      ctx.restore();
    }

    /* each team's own start squares wear a whisper of its colour, so a race reads from the bottom up */
    if (rows === ROWS && th.board.startTint > 0) {
      const key = `${v.state.cols}x${v.state.rows}:${v.state.teams.map((t) => t.balls).join(',')}`;
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
        drawCapsules(centre.x, centre.y, still);
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
      drawCapsules(v.mineGhost.c + 0.5, v.mineGhost.r + 0.5, still);
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
      const r = ballR(c) * (b.sel ? 1.08 : 1);        // the chosen ball lifts off the clay
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
      /* a ball the log has just shoved settles with a micro-bounce rather than simply stopping */
      const th = thump.get(b.id);
      let sq = 0;
      if (th !== undefined) {
        const k = (now - th) / LOG_THUMP_MS;
        if (k >= 1) thump.delete(b.id);
        else if (k >= 0) sq = Math.sin(k * Math.PI * 2.4) * (1 - k) * 0.13;
      }
      if (sq !== 0) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1 + sq, 1 - sq);
        ctx.translate(-cx, -cy);
      }
      drawBall(cx, cy, r, seat, SEATS_N[seat] > 1 ? n : 0);
      if (sq !== 0) ctx.restore();
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
        const e = now - f.t0 - LOG_ALERT_MS;             // negative while the strike alert is up
        const T = logRollMs(f.stopRow);
        if (e >= T + LOG_SKID_MS) { rolls.splice(i, 1); continue; }
        if (e < 0) { drawStrike(f.left, f.width, 1 + e / LOG_ALERT_MS, now, still); continue; }
        const face = logFaceRow(f.stopRow, e);           // it stops travelling at the shield line
        const cx = ox + (f.left + f.width / 2) * c;
        drawSkid(f.left, f.width, face, e < T ? 0.46 : 0.46 * (1 - (e - T) / LOG_SKID_MS));
        const sk = f.slam && e >= T ? (e - T) / LOG_SLAM_MS : -1;
        if (e < T + LOG_FADE_MS) {
          /* the recoil lifts the whole trunk back up the lane for a moment, then it comes down */
          const back = sk >= 0 ? Math.sin(Math.min(1, sk) * Math.PI) * (1 - Math.min(1, sk)) * c * 0.08 : 0;
          drawTrunk(cx, oy + (face + 0.5) * c - back, (face + 0.5) * c,
            e < T ? 1 : 1 - (e - T) / LOG_FADE_MS, 0);
          if (!still && e < T) drawChurn(cx, oy + (face + 0.5) * c, now, c);
        }
        if (sk >= 0) drawSlam(v.state.walls, f.left, f.width, f.stopRow, Math.min(1, sk));
      }
      ctx.restore();
    }

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

    ctx.restore();                     // the slab clip opened at the top of this frame
  }

  return {
    resize,
    draw,
    layout: () => L,
    /**
     * Point the renderer at a board of a different size. The rules pick the grid from the number of
     * contenders, so the race screen hands the board over on every `restart()`; nothing is repainted
     * until the next frame, and a board that has not moved size costs nothing.
     */
    setBoard(c: number, r: number) {
      if (c === cols && r === rows) return;
      cols = c; rows = r;
      lastW = -1;                    // force the next resize() past its "nothing changed" early-out
      resize();
    },
    resetFx: () => {
      born.clear(); pulses.length = 0; blasts.length = 0;
      ripples.length = 0; streaks.length = 0; prevPos.clear(); mineGhostKey = '';
      rolls.length = 0; dust.length = 0; thump.clear();
      goalAt = -1; goalWait = -1; goalSeat = null; crestK = 1; crestT = 0;
    },
    /**
     * A warning round just closed, so its log is rolling: ~320ms per row behind an eased launch, the
     * whole sweep timed by the very functions main.ts locks the turn with. Every ball it shoves
     * puffs dust and takes its micro-bounce at the moment the face reaches the row it lands on.
     */
    rollLog(ev: LogEvent, t0: number) {
      const { cell: c, ox, oy } = L;
      rolls.push({ left: ev.left, width: ev.width, stopRow: ev.stopRow, t0, slam: ev.stopRow < rows - 1 });
      for (const m of ev.moves) {
        const hit = t0 + LOG_ALERT_MS + logArriveMs(m.to.r, ev.stopRow);   // when the face catches up
        dust.push({ x: ox + (m.to.c + 0.5) * c, y: oy + (m.to.r + 0.5) * c, t0: hit });
        thump.set(m.ballId, hit);
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
      cols: s.cols,
      rows: s.rows,
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
