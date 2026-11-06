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
  COLS, MAX_TEAMS, ROWS, startLayout,
  type Cell, type GameState, type Player, type Pos, type Wall, type WallSpec,
} from './rules';
import { motionReduced } from './settings';
import {
  CLASSIC_BALL, CLASSIC_WALL, DEFAULT_THEME, ERR_RAMP, MINE_RAMP, NO_RAMP, OK_RAMP, perspectiveRamps,
  SEAT_RAMPS, type BallSkin, type CosKind, type PieceColor, type Ramp, type Stop, type Theme, type WallStyle,
} from './themes';

export interface Vec { x: number; y: number }

/** Wall ghost under construction. `armed` = the floating toolbar is up, waiting for its confirm key. */
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
  /** the floating action controls a wall or mine ghost draws, or null when no ghost is armed */
  capsule: CapsuleAction | null;
}

/** One pawn the finisher has to take off the board: its id and the cell it stands on. */
export interface FinishLoser {
  id: number;
  cell: Cell;
}

/**
 * The timing the caller needs to stage the same sequence in sound and haptics. Both arrays are
 * milliseconds measured from the first frame the finisher is painted — the renderer starts its
 * own clock there, so a slow first draw moves the bangs with the picture instead of eating the
 * opening beat.
 */
export interface FinishPlan {
  /** when each loser goes off, in the order it was handed over */
  bursts: number[];
  /** when the last spark has died and the result sheet may open */
  total: number;
}

/**
 * A loser with its timing resolved: cell space, not pixels, so a resize between the cue and the
 * burst still lands the debris on the right tile.
 */
interface FinishPawn {
  id: number;
  /** centre, in cell units */
  cx: number;
  cy: number;
  /** the finisher-clock time the burst starts */
  burstAt: number;
  /** the burst's own rotation, so two shatters never look stamped from one stencil */
  rot: number;
}

interface FinishState {
  /** the ball that crossed the line — the one that takes the crown */
  winnerBall: number | null;
  /** milliseconds elapsed on the finisher's own clock; 0 on its first painted frame */
  clock: number;
  /** `performance.now()` of the previous painted frame, -1 before the first */
  lastFrame: number;
  /** when the last spark has settled, on the finisher clock */
  total: number;
  /** the completion callback has already run for this cue */
  settled: boolean;
  pawns: FinishPawn[];
  byId: Map<number, FinishPawn>;
}

export interface Layout {
  w: number; h: number; cell: number; ox: number; oy: number; dpr: number;
  cols: number; rows: number;
}

/**
 * How this client paints the two sides of a duel. `local` wears the player's chosen family, the
 * `rival` seat wears the opposite one, and every other seat keeps the fixed gold / amethyst order.
 * It is presentation only — the rules keep their own `turn`, seats and colours.
 */
export interface Perspective {
  local: Player;
  rival: Player;
  color: PieceColor;
}

export interface RendererOptions {
  /** board patch to paint — the race uses whatever `GameState` says (`cols` x `rows`) */
  cols?: number;
  rows?: number;
  /** asked for on `setTheme`; never polled per frame */
  theme?: () => Theme;
  /**
   * Fired once, from the frame that ends the current endgame finisher. The caller uses it to open
   * the result sheet: the sheet then lands after the last spark, not on a wall-clock guess.
   */
  onFinishSettled?: () => void;
  /**
   * Fired when a deferred re-fit actually rebuilt the board layer. The render loop is parked
   * while the board is idle, so a resize that clears the canvas must ask for one fresh frame —
   * otherwise the screen would keep a blank board until the next transition.
   */
  onLayoutChanged?: () => void;
}

/**
 * One beat of a mine detonation chain. `at` is the charge's own square; `knock` is the ball it
 * throws, from the square it stepped off (or was thrown from) to its resolved landing. The caller
 * only names the cells — the renderer owns the clock that staggers them.
 */
export interface BlastBeat {
  at: Cell;
  knock?: { id: number; from: Pos; to: Pos };
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
  | { kind: 'rotate'; from: 'wall' | 'capsule' }
  | { kind: 'mine'; cell: Cell }
  | { kind: 'mine-confirm'; cell: Cell }
  | { kind: 'move'; to: Pos }
  | { kind: 'cancel' };

/**
 * The floating controls a ghost draws: their board anchor plus the hit its confirm key actuates.
 * A wall ghost draws the three-key glass toolbar; a mine ghost keeps the compact ✓/✕ pair.
 */
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
/** How long the scorched tile's fracture knots keep smouldering before they are cold carbon. */
const EMBER_MS = 2600;
/** Tooth marks behind a wounded ball: recent, previous, third gait, then the tile is clean again. */
const TRAIL_STEPS = 3;
/** The march onto the charge: the ball is visibly standing on the mine before anything goes off. */
const KNOCK_STEP_MS = 260;
/** The throw after detonation: the arc over whatever wall it clears, down to the landing. */
const KNOCK_FLY_MS = 520;
/**
 * The tactical gap between two detonations of a CHAIN — tight enough to read as one combo, long
 * enough to see the pawn get thrown onto the next charge before it blows. A chain's intermediate
 * throws take exactly this long, so beat i+1 fires the frame the ball lands on charge i+1.
 */
const CHAIN_STAGGER_MS = 290;
/** The hop's peak, in cells: tall enough to carry the ball over a wall bar on the line below it. */
const KNOCK_ARC = 1.15;
const DUST_MS = 420;    // the puff a thrown ball kicks up where it comes to rest
const RIPPLE_MS = 380;  // a tap's ripple
const STREAK_MS = 300;  // how long a sliding ball's trail takes to fade
const THUMP_MS = 300;   // a thrown ball's micro-bounce as it comes to rest

/* ---------- the endgame finisher ----------
 * A settled race is crowned first: the winning pawn takes a 1.18× lift inside a gold pulse ring.
 * Then every losing pawn overheats and goes off, farthest from the line first so the closest rival
 * is the last thing standing. These numbers are the whole choreography; `finishCue()` turns them
 * into absolute times, and the caller uses the returned plan to line the bangs, the buzzes and the
 * result card up with the frames.
 */
const FINISH_LEAD_MS = 350;       // the coronation hold: the winner owns the board before the first
                                  // rival even starts to cook
const FINISH_STAGGER_MS = 570;    // a rival's whole beat — shake, boom, debris — before the next one
const FINISH_SHAKE_MS = 280;      // the overheat jitter before the burst
const FINISH_BURST_MS = 650;      // flash → shockwave → shards → last spark
const FINISH_SCORCH_MS = 1200;    // the charred tile cooling off, outliving the debris over it
const FINISH_SETTLE_MS = 650;     // dust settles before the result sheet is allowed in
const FINISH_ASCEND_MS = 420;     // the winner's lift to its crowned scale
const FINISH_ASCEND_SCALE = 0.18; // 1 → 1.18×
const FINISH_JITTER = 5;          // ±5 css px of violent pre-detonation shake
/**
 * The most one frame may advance the finisher clock, in ms. A settled match is exactly when the
 * main thread spikes — socket traffic, save writes, the result prep — and a raw delta of 300ms
 * would skip the flash, the rings and half the shards. Capping the step at 33ms keeps every
 * visible beat on screen; the sequence runs a little longer after a stall, never faster.
 */
const FINISH_DT_CAP = 33;
/**
 * The flash and the rings own the front of the burst, in fractions of `FINISH_BURST_MS`: the blast
 * is over in a heartbeat, and the rest of the window belongs to the debris flying through it.
 */
const FINISH_FLASH = 0.16;
const FINISH_RING = 0.52;
/** 18 particles, on fixed unit vectors: no randomness and no allocation per burst. */
const SHARD_N = 18;
const SHARD_C = new Float32Array(SHARD_N);
const SHARD_S = new Float32Array(SHARD_N);
const SHARD_V = new Float32Array(SHARD_N);
const SHARD_LIFE = new Float32Array(SHARD_N);
const SHARD_SPIN = new Float32Array(SHARD_N);
const SHARD_SZ = new Float32Array(SHARD_N);
for (let i = 0; i < SHARD_N; i++) {
  const a = (i / SHARD_N) * TAU + 0.31;
  SHARD_C[i] = Math.cos(a);
  SHARD_S[i] = Math.sin(a);
  SHARD_V[i] = 0.85 + (((i * 29) % 13) / 13) * 0.95;    // reach, still deterministic
  SHARD_LIFE[i] = 0.72 + (((i * 17) % 11) / 11) * 0.28; // each fleck dies at its own pace, near the end
  SHARD_SPIN[i] = (((i * 41) % 9) - 4) * 1.7;           // shard tumble over one burst
  SHARD_SZ[i] = 5 + (((i * 23) % 11) / 11) * 4;         // a 5px..9px obsidian sliver
}
/** Every third vector is an ember instead of a shard: a 3px..5px amber head on a long trail. */
const EMBER_N = SHARD_N / 3;
const EMBER_SZ = new Float32Array(EMBER_N);
for (let i = 0; i < EMBER_N; i++) EMBER_SZ[i] = 3 + ((i * 7) % 5) * 0.5;

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

/** The same colour at a new alpha; hex tokens (the crest metal) are left alone. */
const withAlpha = (col: string, a: number) =>
  (col.startsWith('rgb') ? col.replace(/[\d.]+\)\s*$/, `${a})`) : col);

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
 * duel, 10x14 for three or four contenders) into whatever box the stage hands it, and every size
 * below is a fraction of the cell that comes out. The cell is the smaller of the two axis fits —
 * `min(width / cols, height / rows)` — so the taller party board buys its extra runway by drawing
 * slightly smaller cells rather than by spilling out of the viewport: nothing is ever clipped,
 * vertically or horizontally, on a 320px phone. That is also what makes the board scale from a
 * 430x932 phone down to a 360x640 one without a single media query — and what makes the *touch*
 * targets scale with it, which is the part a purely visual fit would get wrong.
 */

/** The ball's radius in css px on a board whose cells are `cell` px across. */
const ballR = (cell: number) => cell * BALL_R;
/**
 * The same on-screen radius, published for overlays that live outside the renderer. The chat
 * bubble uses it to stop its tail just above the solid token instead of guessing a cell fraction.
 */
export const pawnRadius = ballR;
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

/** The board-space centre of a wall's body, used to anchor its floating action toolbar. */
export function wallCentre(w: WallSpec): Vec {
  return w.o === 'h' ? { x: w.x + 1, y: w.y } : { x: w.x, y: w.y + 1 };
}

/**
 * The slot a wall snaps to while its ghost is being dragged. Unlike `slotNear` there is no magnet
 * zone: the finger owns the bar for the whole gesture, so it slides along the nearest line of its
 * own orientation all the way across the board instead of dropping out between grooves.
 */
export function dragWallSlot(L: Layout, px: number, py: number, o: 'h' | 'v'): WallSpec {
  const bx = (px - L.ox) / L.cell, by = (py - L.oy) / L.cell;
  if (o === 'h') {
    return { o, x: clamp(Math.round(bx) - 1, 0, L.cols - 2), y: clamp(Math.round(by), 1, L.rows - 1) };
  }
  return { o, x: clamp(Math.round(bx), 1, L.cols - 1), y: clamp(Math.round(by) - 1, 0, L.rows - 2) };
}

/**
 * Radius of a mine ghost's compact ✓/✕ capsule, in cells, on a board whose cells are `cell` px
 * across. `CAP_R` is what a roomy board draws; on a cramped one the chip grows until it is a
 * thumb's worth of pixels, and stops before its outermost paint reaches the tile edge.
 */
const CAP_R = 0.3;
const CAP_R_MAX = 0.34;
/**
 * Daylight kept between a disc's outermost paint and the edge of the tile it owns, in css px.
 * This is the canvas's `inset: 2px`: each control is inscribed in one cell with `border-box`
 * discipline, so its rim, its warning ring and its drop shadow can never bleed over a boundary
 * wall or fold onto the disc beside it.
 */
const CAP_INSET = 2;
/** The outermost drop-shadow pass, in disc radii, and the lift below the disc it is struck at. */
const CAP_WASH = 1.2;
const CAP_LIFT = 0.1;
const capR = (cell: number) => Math.min(
  CAP_R_MAX,
  (0.5 - CAP_INSET / cell) / (CAP_WASH + CAP_LIFT),
  Math.max(CAP_R, MIN_TOUCH * 0.36 / cell),
);

/** A cell a floating control must keep clear of. Pawns are the only occupants that matter. */
export interface CapsuleOccupant { c: number; r: number }

export interface CapsuleLayout {
  /** 'h' = cancel left / confirm right; 'v' = the two discs stacked in one column. */
  orient: 'h' | 'v';
  /** Disc centres, in board units. */
  confirm: Vec;
  cancel: Vec;
  /** The pair's outer rim, shadows excluded, in board units. */
  box: { left: number; top: number; width: number; height: number };
}

/**
 * Where a mine ghost's two controls stand.
 *
 * Each disc owns one whole tile: cancel on the left, confirm on the right. That horizontal pair
 * is only legal while BOTH neighbouring tiles are inside the grid and hold no pawn — the moment
 * either side is blocked (the staged square sits on a boundary column, or a piece stands beside
 * it) the pair turns VERTICAL: confirm in the tile nearest the mine, cancel in the tile beyond it.
 * Down is tried first, then up, then the nearest columns either side of the mine. Every candidate
 * is filtered against the live pawns, so a control can never be drawn on a cell holding a piece.
 *
 * Drawing and hit-testing both call this one function with the same board, which is what keeps a
 * painted disc and its tap target welded together even as the layout flips orientation.
 */
export function capsuleLayout(
  L: Layout, ax: number, ay: number, blocked: readonly CapsuleOccupant[] = [],
): CapsuleLayout | null {
  const c = clamp(Math.round(ax - 0.5), 0, Math.max(0, L.cols - 1));
  const r = clamp(Math.round(ay - 0.5), 0, Math.max(0, L.rows - 1));
  /* a race holds at most four pawns, so a linear scan beats building a Set every frame */
  const free = (cc: number, rr: number) =>
    cc >= 0 && cc < L.cols && rr >= 0 && rr < L.rows
    && !blocked.some((b) => b.c === cc && b.r === rr);
  const boxOf = (confirm: Vec, cancel: Vec): CapsuleLayout['box'] => {
    const rad = capR(L.cell);
    return {
      left: Math.min(confirm.x, cancel.x) - rad,
      top: Math.min(confirm.y, cancel.y) - rad,
      width: Math.abs(confirm.x - cancel.x) + rad * 2,
      height: Math.abs(confirm.y - cancel.y) + rad * 2,
    };
  };

  /* the roomy pair: one free tile either side of the staged square */
  if (c > 0 && c < L.cols - 1 && free(c - 1, r) && free(c + 1, r)) {
    const confirm = { x: c + 1.5, y: r + 0.5 };
    const cancel = { x: c - 0.5, y: r + 0.5 };
    return { orient: 'h', confirm, cancel, box: boxOf(confirm, cancel) };
  }

  /* the stack: confirm nearest the mine, cancel one tile beyond it */
  const stack = (col: number, dir: 1 | -1): CapsuleLayout | null => {
    const cr = r + dir, xr = r + dir * 2;
    if (!free(col, cr) || !free(col, xr)) return null;
    const confirm = { x: col + 0.5, y: cr + 0.5 };
    const cancel = { x: col + 0.5, y: xr + 0.5 };
    return { orient: 'v', confirm, cancel, box: boxOf(confirm, cancel) };
  };

  const direct = stack(c, 1) ?? stack(c, -1);
  if (direct) return direct;
  /* the direct line is tight: walk the nearest columns out from the mine */
  for (let d = 1; d < L.cols; d++) {
    for (const col of [c - d, c + d]) {
      if (col < 0 || col >= L.cols) continue;
      const found = stack(col, 1) ?? stack(col, -1);
      if (found) return found;
    }
  }
  /* No two free tiles share a column. A race cannot produce this board, but the rule still
     holds: no control is ever drawn on a pawn. Both discs stay inside the staged tile, which
     the mine rules already promise holds no ball. */
  if (free(c, r)) {
    const confirm = { x: c + 0.5, y: r + 0.5 };
    const rad = capR(L.cell);
    return {
      orient: 'v', confirm, cancel: confirm,
      box: { left: confirm.x - rad, top: confirm.y - rad, width: rad * 2, height: rad * 2 },
    };
  }
  return null;
}

/**
 * The wall toolbar's metrics, in css px. A compact capsule: 27px lenses with only a few px of
 * daylight between them, so the whole three-key strip hugs roughly 1.7 board tiles. `TOOL_OFFSET`
 * leaves about 30px of clearance between the wall and the pill's near edge — clear of the bar and
 * its glow without floating off across the board. The touch targets stay larger than the lenses.
 */
const TOOL_OFFSET = 45;
const TOOL_BTN = 27;
const TOOL_GAP = 4;
const TOOL_PAD = 3;
const TOOL_W = TOOL_BTN * 3 + TOOL_GAP * 2 + TOOL_PAD * 2;
const TOOL_H = TOOL_BTN + TOOL_PAD * 2;
const TOOL_EDGE = 3;
/** Generous tap radius per key, resolved by nearest centre so neighbouring keys never steal a tap. */
const TOOL_HIT = 19;

interface ToolbarBox { x: number; y: number; w: number; h: number; below: boolean }

/**
 * Where the three-key toolbar sits: `TOOL_OFFSET` clear of the wall's nearest end, centred above
 * the bar, flipping to the wall's other side when the top of the board would clip it, and clamped
 * inside the canvas horizontally. Centre coords, css px.
 */
function toolbarBox(L: Layout, ax: number, ay: number, o: 'h' | 'v'): ToolbarBox {
  const cx = L.ox + ax * L.cell, cy = L.oy + ay * L.cell;
  /* a vertical wall reaches a whole cell either side of its centre: clear that end, not the middle */
  const half = o === 'v' ? L.cell : 0;
  const above = cy - half - TOOL_OFFSET;
  const below = above - TOOL_H / 2 < L.oy + TOOL_EDGE;
  const minX = TOOL_W / 2 + TOOL_EDGE, maxX = Math.max(minX, L.w - TOOL_W / 2 - TOOL_EDGE);
  const minY = TOOL_H / 2 + TOOL_EDGE, maxY = Math.max(minY, L.h - TOOL_H / 2 - TOOL_EDGE);
  return {
    x: clamp(cx, minX, maxX),
    y: clamp(below ? cy + half + TOOL_OFFSET : above, minY, maxY),
    w: TOOL_W,
    h: TOOL_H,
    below,
  };
}

/** The centre of toolbar key `i` (0 = cancel, 1 = rotate, 2 = confirm), in css px. */
const toolKeyX = (b: ToolbarBox, i: number) => b.x + (i - 1) * (TOOL_BTN + TOOL_GAP);

/** Which wall-toolbar key a canvas point lands on, if any. */
function toolbarHit(
  L: Layout, px: number, py: number, ax: number, ay: number, o: 'h' | 'v',
): 'confirm' | 'cancel' | 'rotate' | null {
  const b = toolbarBox(L, ax, ay, o);
  const r2 = TOOL_HIT * TOOL_HIT;
  let best = -1, bestD = r2;
  for (let i = 0; i < 3; i++) {
    const dx = px - toolKeyX(b, i), dy = py - b.y;
    const d = dx * dx + dy * dy;
    /* nearest centre wins, so the generous radii may overlap without stealing a neighbour's tap */
    if (d <= bestD) { best = i; bestD = d; }
  }
  return best === 0 ? 'cancel' : best === 1 ? 'rotate' : best === 2 ? 'confirm' : null;
}

/** Which floating control, if any, a tap at (px, py) lands on. Canvas coords in. */
function capsuleHit(
  L: Layout, px: number, py: number, cap: CapsuleAction, blocked: readonly CapsuleOccupant[],
): 'confirm' | 'cancel' | 'rotate' | null {
  /* a wall ghost owns the glass toolbar; a mine keeps the pair its square can actually hold */
  if (cap.hit.kind === 'confirm') return toolbarHit(L, px, py, cap.ax, cap.ay, cap.hit.spec.o);
  const lay = capsuleLayout(L, cap.ax, cap.ay, blocked);
  if (!lay) return null;
  const bx = (px - L.ox) / L.cell, by = (py - L.oy) / L.cell;
  const r2 = capR(L.cell) * capR(L.cell);
  const on = (p: Vec) => (bx - p.x) * (bx - p.x) + (by - p.y) * (by - p.y) <= r2;
  if (on(lay.confirm)) return 'confirm';
  if (on(lay.cancel)) return 'cancel';
  return null;
}

/**
 * Pointer (CSS px, canvas-local) → the thing to act on.
 * Priority, not raw distance: the floating toolbar and your own balls come first, then the centre
 * of an armed wall (which turns it 90°), then a legal-move dot's own cell, and only a tap that is
 * inside no dot cell and nearer the groove than the nearest dot repositions a wall. A tap between
 * the dot and the groove falls back to the nearest legal dot so a sloppy finger still moves rather
 * than starting a wall. One mode is left: while the mine key is armed the board offers mines and
 * nothing else, except that a tap inside one of your own balls is that ball — the gesture that lets
 * the key go and brings the pawn to hand. The top and bottom two rows are refused outright.
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
  /** the outcome a tap on a floating action control should act on, if drawn */
  capsule?: CapsuleAction | null;
}): Hit | null {
  const c = L.cell;
  if (c <= 0) return null;
  const bx = (px - L.ox) / c, by = (py - L.oy) / c;

  const cand: { hit: Hit; pri: number; d: number }[] = [];
  const reach = Math.max(0.5, MIN_TOUCH / 2 / c);   // 44px target, in cells
  const gz = grooveZone(c);                         // the groove's own reach on this board, in cells
  /** The hit a floating control's own key actuates. */
  const capHit = (key: 'confirm' | 'cancel' | 'rotate'): Hit =>
    key === 'confirm' ? o.capsule!.hit
      : key === 'rotate' ? { kind: 'rotate', from: 'capsule' }
        : { kind: 'cancel' };
  /** The floating key this tap lands on, if any — chrome, so it is resolved before the board is. */
  const cap = o.capsule ? capsuleHit(L, px, py, o.capsule, o.balls) : null;
  /* A badge may ride the slab rim, half of it past the last cell: it answers even a hair outside
     the grid, so the outer edge of the ✓/✕ pair is never a dead zone. The board's own bounds still
     refuse a tap on the card around it — but only for taps no control wanted. */
  if (bx < -0.5 || by < -0.5 || bx > L.cols + 0.5 || by > L.rows + 0.5) {
    return cap ? capHit(cap) : null;
  }
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
    // mines for empty squares, but your own ball is always a ball: the caller lets the key go
    /* `pri: -1` is the whole touch contract of the ✓/✕ pair: the badge is drawn ON TOP of whatever
       tile it lands on, so it must also answer first — a tap on a badge that overlaps a pawn is the
       badge, never the pawn underneath it. */
    if (cap) cand.push({ hit: capHit(cap), pri: -1, d: 0 });
    /* Containment, not the 44px reach: tapping a square beside the pawn must still arm a mine
       there, while every tap inside the pawn's own square means "give me my piece back". */
    let ballId: number | null = null, db = Infinity;
    for (const b of o.balls) {
      if (b.team !== o.mine) continue;
      if (bx < b.c || bx > b.c + 1 || by < b.r || by > b.r + 1) continue;
      const d = Math.hypot(bx - b.c - 0.5, by - b.r - 0.5);
      if (d < db) { db = d; ballId = b.id; }
    }
    if (ballId !== null) cand.push({ hit: { kind: 'ball', id: ballId }, pri: 0, d: db });
    const armed = o.armedMine ? nearest([o.armedMine], reach) : null;
    if (armed) cand.push({ hit: { kind: 'mine-confirm', cell: armed.cell }, pri: 0, d: armed.d });
    const spot = nearest(o.mineHints, reach);
    if (spot) cand.push({ hit: { kind: 'mine', cell: spot.cell }, pri: 1, d: spot.d });
  } else {
    /* Priority order (lower number wins): the floating keys and your own ball, the ghost's centre
       (rotate), a move dot inside 0.15 cells, then a groove, then a far move fallback. A dot within
       the move zone is pushed on its own, so no groove can ever be offered there. */
    if (cap) cand.push({ hit: capHit(cap), pri: -1, d: 0 });

    let ballId: number | null = null, db = Infinity;
    for (const b of o.balls) {
      if (b.team !== o.mine) continue;
      const d = Math.hypot(bx - b.c - 0.5, by - b.r - 0.5);
      if (d < db) { db = d; ballId = b.id; }
    }
    if (ballId !== null && db <= reach) cand.push({ hit: { kind: 'ball', id: ballId }, pri: 0, d: db });

    /* The centre of the live ghost is its rotate handle: a tap there turns the bar in place, while
       every other groove is a move. The handle is a thumb-sized disc, not the old confirm body. */
    if (o.armed) {
      const centre = wallCentre(o.armed);
      const d = Math.hypot(bx - centre.x, by - centre.y);
      if (d <= Math.max(0.36, 20 / c)) cand.push({ hit: { kind: 'rotate', from: 'wall' }, pri: 1, d });
    }

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
  }

  cand.sort((a, b) => a.pri - b.pri || a.d - b.d);
  return cand.length ? cand[0].hit : null;
}

/* ---------- drawing ---------- */

/**
 * One seat: its colours, its ball material, its wall material. Seats 0..3 play, seat 4 refuses.
 * Without a perspective the local seat wears the equipped skin and seats 1..3 keep the fixed
 * families; with one, the local seat wears the player's chosen red/blue and its rival the other.
 */
interface Side { ramp: Ramp; ball: BallSkin; wall: WallStyle }

/** Every seat the rules allow, plus the refusal palette that owns no side. */
const SEAT_COUNT = MAX_TEAMS + 1;
const ERR = MAX_TEAMS;

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
/**
 * Below this cell the inscription is mush rather than type, so the crown wears no word at all.
 * The floor is the *duel's* cell, not the party board's: a 10x14 grid fits the same phone by
 * drawing smaller cells, and at 24 a four-way on a 320px screen would lose the word the finish bar
 * is named for. `fs < 6` below is the real legibility guard; this one only keeps the crest off a
 * board that has collapsed to a thumbnail.
 */
const CREST_MIN = 20;
/** Heavy enough to survive being nine pixels tall, on the stack the app already ships. */
const crestFont = (px: number) =>
  `900 ${px}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif`;
/** Tracking between the crest's letters, in ems: wide enough to read as an inscription, not a word. */
const CREST_TRACK = 0.22;
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

/* ---------- mine scars and the blood trail ----------
 * The board is one canvas, so the brief's tile classes have no DOM to live in. Each state is a
 * small stamp struck at the current cell size and blitted once per marked tile: the per-frame
 * cost is a drawImage, with no per-decal nodes, path building or gradient allocation.
 */

/** Deterministic PRNG for the stamps and the droplet scatter, so a board paints the same twice. */
function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The scar / droplet shape a cell wears: stable for the cell, chosen once at build time. */
const decalVariant = (c: number, r: number): number => (c * 7 + r * 13) % 3;

interface DecalArt {
  scorch: HTMLCanvasElement[];
  /** Warm knots along each variant's fractures, in tile fractions. */
  embers: { x: number; y: number }[][];
  /** The soft smoulder each knot is painted with — never a hard dot, so it cannot read as blood. */
  ember: HTMLCanvasElement;
  wet: HTMLCanvasElement[];
  dry: HTMLCanvasElement[];
  smoke: HTMLCanvasElement;
}

/**
 * Build the tile-sized art once per layout. The three scorch faces are confined, transparent-
 * backed crater decals: the base tile's clay, border and corners show through untouched, and only
 * a centred blast burn (about half the tile's area) is painted over it. The six droplet faces are
 * the same three shapes in a wet arterial ruby and a dried carbon red, so a trail can age by
 * swapping stamps rather than by repainting a path.
 */
function buildDecalArt(cell: number, dpr: number): DecalArt {
  const gap = Math.max(1, cell * 0.03);
  const tw = Math.max(2, cell - gap);
  const scorch: HTMLCanvasElement[] = [];
  const embers: { x: number; y: number }[][] = [];
  for (let v = 0; v < 3; v++) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(tw * dpr));
    cv.height = cv.width;
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rand = rng32(0x5eed + v * 977);
    const cx = tw * 0.5, cy = tw * 0.5;

    /* the brief's radial cavity, exactly: near-black heart, slate falloff, clear by 70%. At this
       reach the burn covers just under half the tile; the outer frame stays bare clay. */
    const core = g.createRadialGradient(cx, cy, 0, cx, cy, tw * 0.56);
    core.addColorStop(0, 'rgba(10,10,15,.9)');
    core.addColorStop(0.45, 'rgba(15,23,42,.6)');
    core.addColorStop(0.7, 'rgba(15,23,42,0)');
    core.addColorStop(1, 'rgba(15,23,42,0)');
    g.fillStyle = core;
    g.fillRect(0, 0, tw, tw);

    /* a smaller, deeper cavity so the burn has a floor rather than a flat wash */
    const pit = g.createRadialGradient(cx, cy, 0, cx, cy, tw * 0.22);
    pit.addColorStop(0, 'rgba(2,3,6,.6)');
    pit.addColorStop(0.55, 'rgba(2,3,6,.24)');
    pit.addColorStop(1, 'rgba(2,3,6,0)');
    g.fillStyle = pit;
    g.beginPath(); g.arc(cx, cy, tw * 0.22, 0, TAU); g.fill();

    /* carbon speckle inside the crater, never out at the tile's edge */
    for (let k = 0; k < 12; k++) {
      const a = rand() * TAU, d = Math.sqrt(rand()) * tw * 0.33;
      g.fillStyle = `rgba(8,10,16,${(0.06 + rand() * 0.1).toFixed(3)})`;
      g.beginPath();
      g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, Math.max(0.4, tw * 0.006), 0, TAU);
      g.fill();
    }

    /* a broken carbon rim: short, faint arcs, never a perfect ring */
    g.lineCap = 'round';
    for (let k = 0; k < 5; k++) {
      const a0 = rand() * TAU, a1 = a0 + 0.35 + rand() * 0.65;
      g.strokeStyle = `rgba(8,10,16,${(0.1 + rand() * 0.1).toFixed(3)})`;
      g.lineWidth = Math.max(0.8, tw * (0.007 + rand() * 0.007));
      g.beginPath();
      g.arc(cx, cy, tw * (0.30 + rand() * 0.06), a0, a1);
      g.stroke();
    }

    /* radial fractures feather out toward the intact clay. The clamp is radial, not a box:
       a diagonal crack can never reach a corner, so the tile's whole outer frame stays clean. */
    const anchors: { x: number; y: number }[] = [];
    const rMax = tw * 0.36;
    g.lineJoin = 'round';
    for (let k = 0; k < 6; k++) {
      let ang = (k / 6) * TAU + (rand() - 0.5) * 0.5;
      let x = cx + Math.cos(ang) * tw * 0.05;
      let y = cy + Math.sin(ang) * tw * 0.05;
      const segs = 4 + Math.floor(rand() * 3);
      const path = new Path2D();
      path.moveTo(x, y);
      let tipX = x, tipY = y;
      for (let s = 0; s < segs; s++) {
        ang += (rand() - 0.5) * 0.95;
        const len = tw * (0.045 + rand() * 0.065);
        let nx = x + Math.cos(ang) * len, ny = y + Math.sin(ang) * len;
        const dx = nx - cx, dy = ny - cy, dist = Math.hypot(dx, dy);
        if (dist > rMax) { nx = cx + (dx / dist) * rMax; ny = cy + (dy / dist) * rMax; }
        x = nx; y = ny;
        path.lineTo(x, y);
        tipX = x; tipY = y;
        if (k < 3 && s === 2) anchors.push({ x: x / tw, y: y / tw });
      }
      const fade = g.createLinearGradient(cx, cy, tipX, tipY);
      fade.addColorStop(0, 'rgba(4,6,10,.6)');
      fade.addColorStop(0.6, 'rgba(24,22,24,.34)');
      fade.addColorStop(1, 'rgba(60,45,35,0)');
      g.strokeStyle = fade;
      g.lineWidth = Math.max(1, tw * (0.011 + rand() * 0.011));
      g.stroke(path);
      g.strokeStyle = 'rgba(124,45,18,.11)';
      g.lineWidth = Math.max(0.6, tw * 0.005);
      g.stroke(path);
    }
    scorch.push(cv);
    embers.push(anchors);
  }

  const box = Math.max(4, cell * 0.26);
  const drop = (variant: number, dried: boolean): HTMLCanvasElement => {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(box * dpr));
    cv.height = cv.width;
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = box * 0.5, cy = box * 0.52;
    const rad = box * 0.25;
    const stain = g.createRadialGradient(cx, cy, 0, cx, cy, box * 0.48);
    stain.addColorStop(0, dried ? 'rgba(45,5,5,.32)' : 'rgba(64,8,8,.34)');
    stain.addColorStop(1, 'rgba(45,5,5,0)');
    g.fillStyle = stain;
    g.fillRect(0, 0, box, box);
    const body = g.createRadialGradient(cx - rad * 0.35, cy - rad * 0.4, 0, cx, cy, rad * 1.15);
    if (dried) {
      body.addColorStop(0, '#5C0F0F');
      body.addColorStop(0.55, '#450A0A');
      body.addColorStop(1, '#2B0606');
    } else {
      body.addColorStop(0, '#B91C1C');
      body.addColorStop(0.5, '#991B1B');
      body.addColorStop(1, '#7F1D1D');
    }
    const bead = (x: number, y: number, r0: number) => {
      g.beginPath();
      g.ellipse(x, y, r0, r0 * 0.9, 0, 0, TAU);
      g.fill();
    };
    g.fillStyle = body;
    if (variant === 0) {
      bead(cx, cy, rad);
      bead(cx + rad * 0.95, cy + rad * 0.7, rad * 0.2);
    } else if (variant === 1) {
      bead(cx, cy, rad * 0.88);
      bead(cx - rad * 0.95, cy - rad * 0.9, rad * 0.34);
      bead(cx - rad * 1.55, cy - rad * 1.45, rad * 0.17);
    } else {
      bead(cx, cy, rad * 0.78);
      bead(cx + rad * 0.9, cy - rad * 0.25, rad * 0.24);
      bead(cx - rad * 0.7, cy + rad * 0.8, rad * 0.19);
      bead(cx + rad * 0.25, cy + rad * 1.05, rad * 0.13);
    }
    /* high specular contrast: a hard white bead, not a soft sheen */
    if (!dried) {
      g.fillStyle = 'rgba(255,240,240,.75)';
      g.beginPath();
      g.ellipse(cx - rad * 0.32, cy - rad * 0.36, rad * 0.3, rad * 0.17, -0.65, 0, TAU);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,.3)';
      g.beginPath(); g.arc(cx + rad * 0.32, cy + rad * 0.3, rad * 0.1, 0, TAU); g.fill();
    } else {
      g.fillStyle = 'rgba(255,190,190,.16)';
      g.beginPath();
      g.ellipse(cx - rad * 0.3, cy - rad * 0.34, rad * 0.24, rad * 0.13, -0.65, 0, TAU);
      g.fill();
    }
    return cv;
  };
  const wet = [0, 1, 2].map((v) => drop(v, false));
  const dry = [0, 1, 2].map((v) => drop(v, true));

  const ember = document.createElement('canvas');
  const ebox = Math.max(6, cell * 0.46);
  ember.width = Math.max(1, Math.round(ebox * dpr));
  ember.height = ember.width;
  const eg = ember.getContext('2d')!;
  eg.setTransform(dpr, 0, 0, dpr, 0, 0);
  const glow = eg.createRadialGradient(ebox / 2, ebox / 2, 0, ebox / 2, ebox / 2, ebox / 2);
  glow.addColorStop(0, 'rgba(194,65,12,.82)');
  glow.addColorStop(0.3, 'rgba(124,45,18,.5)');
  glow.addColorStop(0.68, 'rgba(124,45,18,.14)');
  glow.addColorStop(1, 'rgba(124,45,18,0)');
  eg.fillStyle = glow;
  eg.fillRect(0, 0, ebox, ebox);

  const smoke = document.createElement('canvas');
  const sbox = Math.max(8, cell * 0.95);
  smoke.width = Math.max(1, Math.round(sbox * dpr));
  smoke.height = smoke.width;
  const sg = smoke.getContext('2d')!;
  sg.setTransform(dpr, 0, 0, dpr, 0, 0);
  const puff = sg.createRadialGradient(sbox / 2, sbox / 2, 0, sbox / 2, sbox / 2, sbox / 2);
  puff.addColorStop(0, 'rgba(214,202,190,.5)');
  puff.addColorStop(0.45, 'rgba(148,152,160,.24)');
  puff.addColorStop(1, 'rgba(120,125,135,0)');
  sg.fillStyle = puff;
  sg.fillRect(0, 0, sbox, sbox);

  return { scorch, embers, ember, wet, dry, smoke };
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
 * A sane stand-in box for the one moment the DOM cannot be measured (the race screen is still
 * `display:none` during the launch cinematic, or a WebView reports a 0x0 container mid-reflow).
 * It is never painted for long — `settle()` re-measures on the next frame — but it keeps `layout()`
 * finite and positive so no caller can ever derive a zero/NaN pawn coordinate from it.
 */
const FALLBACK_W = 320, FALLBACK_H = 420;
/**
 * The bevel band struck along the slab's inner edge. It is the board's own rim, so anything that
 * lands on it reads as cut off by the border rather than as sitting in a tile.
 */
const bevelBand = (cell: number) => Math.max(2, cell * 0.13);
/**
 * How far a box of `size` starting at `v` has to slide to fit inside `[lo, hi]`, negative when it
 * overflows the far end. An indicator that does fit never moves, so only the outer rows and columns
 * feel it — and they move as one piece, which keeps the square a square.
 */
const slideInto = (v: number, size: number, lo: number, hi: number) =>
  Math.max(0, lo - v) - Math.max(0, v + size - hi);

/**
 * Fit the grid into the box the stage handed us: one cell size that satisfies both axes, quantised
 * to whole device pixels so the grooves land on the pixel grid and the board stays crisp. The cell
 * floor is 1px rather than 8 — a board in a box too small for even one cell must shrink to fit, not
 * spill past its canvas — and the margin is re-derived from the cell it produced, one pass, because
 * a pad expressed in cells cannot be known before the cell is.
 */
function computeLayout(w: number, h: number, dpr: number, cols: number, rows: number): Layout {
  /* Never derive geometry from an unmounted or zero-size container. A 0x0 box fits a negative
     cell, which floors to 1 and pushes `ox`/`oy` NEGATIVE — every pawn is then drawn off the
     canvas and stays invisible until something re-fits. Clamp the inputs here as well as at the
     `resize()` door, so a caller that reaches this directly still gets a usable, positive layout. */
  const bw = Number.isFinite(w) && w > 0 ? w : FALLBACK_W;
  const bh = Number.isFinite(h) && h > 0 ? h : FALLBACK_H;
  const bd = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const fit = (m: number) => {
    const raw = Math.min((bw - 2 * m) / cols, (bh - 2 * m) / rows);
    return Math.max(1, Math.floor(Math.max(0, raw) * bd) / bd);
  };
  let cell = fit(LAYOUT_PAD);
  const m = layoutPad(cell);
  if (m !== LAYOUT_PAD) cell = fit(m);
  const ox = Math.max(0, Math.round(((bw - cols * cell) / 2) * bd) / bd);
  const oy = Math.max(0, Math.round(((bh - rows * cell) / 2) * bd) / bd);
  return { w: bw, h: bh, cell, ox, oy, dpr: bd, cols, rows };
}

export function createRenderer(canvas: HTMLCanvasElement, opts: RendererOptions = {}) {
  const ctx = canvas.getContext('2d')!;
  /* The board can change size between races (`setBoard`): a duel is 8 columns, a 3- or 4-contender
     race 10. Everything below reads these, never a module constant. */
  let cols = opts.cols ?? COLS, rows = opts.rows ?? ROWS;
  /* A finite, positive layout from the first line. The old `computeLayout(1,1,1,…)` handed every
     early caller a 1px cell and a negative origin before the first real resize. */
  let L = computeLayout(FALLBACK_W, FALLBACK_H, 1, cols, rows);
  /** False until at least one measurement came from a mounted, non-zero container. */
  let layoutReady = false;
  /** A reveal or resize asked the next draw to verify the fit — never a per-frame layout read. */
  let layoutCheck = false;
  /** One deferred verification frame, armed by `settle()`; never a polling loop. */
  let settleRaf = 0;
  let th: Theme = opts.theme ? opts.theme() : DEFAULT_THEME;
  /** The client-side colour perspective, or null for previews that show the authored theme. */
  let perspective: Perspective | null = null;
  /** Seats wearing the purchased VIP halo. Server-stamped for a rival, live for the local seat. */
  let vipSeats = new Set<Player>();
  /** seat 0 wears the equipped skin and style; every other seat keeps its fixed family. */
  let sides: Side[] = seats(th);
  const born = new Map<number, number>();                    // wall key → first-seen time (pop-in)
  const pulses: { x: number; y: number; t0: number; p: Player }[] = []; // wall landing rings
  /** mine triggers, queued by blast(); `t0` is the detonation, after the step onto the charge */
  const blasts: { x: number; y: number; t0: number; c: number; r: number }[] = [];
  /**
   * One throw a trigger puts on the ball that set it off: the step onto the charge, the hop over
   * the wall it was buried under, and the landing. A CHAIN queues one of these per beat, with
   * abutting windows, so the same ball can be blown off one charge straight onto the next.
   * `stepMs` is the arrival phase (0 for every beat after the first — the ball is already there),
   * `flyMs` the throw phase. Renderer-owned, keyed by ball id.
   */
  const knocks: {
    id: number; from: Pos; mine: Pos; to: Pos; t0: number; stepMs: number; flyMs: number;
  }[] = [];
  /** Mine-blast dust and the micro-bounce of a thrown ball as it settles. */
  const dust: { x: number; y: number; t0: number }[] = [];
  /** ball id → the ms its throw lands, so the settle can bounce. */
  const thump = new Map<number, number>();
  const ripples: { x: number; y: number; t0: number; p: Player }[] = []; // tap feedback
  /** Sliding balls leave a short comet tail: pooled, reused, and dropped as they fade. */
  const streaks: { x0: number; y0: number; x1: number; y1: number; t0: number; p: Player }[] = [];
  const prevPos = new Map<number, Vec>();                    // ball id → where it was last frame
  /** Tile-surface art, struck once per layout; every scar and droplet blits from here. */
  let decal: DecalArt | null = null;
  /** Mine bursts still smouldering at their fracture intersections. */
  const embers: { c: number; r: number; t0: number; v: number }[] = [];
  /** ball id → its logical steps, whether the blast wounded it, and the cell it last stood on. */
  const stride = new Map<number, number>();
  const wounds = new Set<number>();
  /** ball id → the wound it is about to take and the moment the charge under it goes off. */
  const pendingWounds = new Map<number, { at: Cell; when: number }>();
  const stood = new Map<number, { c: number; r: number }>();
  /** Blood shed on the tiles behind a wounded ball, in board units. */
  const blood: { x: number; y: number; v: number; s: number; ball: number; born: number }[] = [];
  let boardBufferCanvas: HTMLCanvasElement | null = null;    // static board layer, rebuilt on resize
  let mineBody: CanvasGradient | null = null;                // the mine's dim warm sphere
  let mineGlow: CanvasGradient | null = null;                // …and the glow it casts
  let blastGlow: CanvasGradient | null = null;               // the wide light a trigger throws
  /** When the armed mine ghost first appeared, so it can drop into place once. */
  let mineGhostAt = 0;
  let mineGhostKey = '';
  /** Reused every frame: the pawn cells the mine pair must keep clear of. */
  const capsuleBlocked: CapsuleOccupant[] = [];
  /** The start squares of the game on screen, rebuilt only when the team sizes change. */
  let startKey = '';
  let starts: { c: number; r: number; t: Player }[] = [];
  let lastW = 0, lastH = 0, lastDpr = 0;
  // layout-sized paint servers: built once per resize, reused every frame
  const dash = { trail: [] as number[], last: [] as number[], ghost: [] as number[], armed: [] as number[] };
  const ballFx: { shadow: CanvasGradient; body: CanvasGradient; bounce: CanvasGradient }[] = [];
  const glowG: CanvasGradient[] = [];
  /** The wide, soft light each pawn pools on the tiles around it, in the seat's own colour. */
  const lampG: CanvasGradient[] = [];
  /** Legal-move dots: the halo each one sits in, struck once per seat and layout. */
  const dotG: CanvasGradient[] = [];
  /** Wall-ghost end caps: the glow struck once per seat instead of a gradient per frame. */
  const capG: CanvasGradient[] = [];
  /* No ambient light cone or drifting sweep over the finish line: both were full-width gradient
     fills repainted on every idle frame. The goal zone keeps its baked crown and its one-shot
     arrival flare, which are finite transitions the loop can sleep between. */
  /**
   * The crown's inscription: struck once per resize into a tile of its own, then blitted every
   * frame. Offscreen and per-frame because it flares when the line is taken, and the static layer
   * cannot.
   */
  let crestArt: HTMLCanvasElement | null = null;
  const crestGeo = { x: 0, y: 0, w: 0, h: 0 };
  /** a scratch context that only ever measures the crest's type */
  let crestProbe: CanvasRenderingContext2D | null = null;
  /** the moment the line was taken, -1 = the crown is at rest; drives the arrival pulse alone */
  let goalAt = -1;
  /** the seat the rules have crowned, and the moment they did it, while its ball finishes travelling */
  let goalWait = -1, goalSeat: Player | null = null;
  /** The live endgame finisher, or null between races. Renderer-owned: the caller only sets the cue. */
  let finish: FinishState | null = null;
  /** The finisher's paint servers, struck with the board on every resize. */
  let crownG: CanvasGradient | null = null;   // the winner's gold halo
  let heatG: CanvasGradient | null = null;    // a losing pawn's crimson/amber overheat
  let scorchG: CanvasGradient | null = null;  // the charred coin left on the tile

  /** The player's seat plus every fixed one, from one theme and the live perspective. */
  function seats(t: Theme): Side[] {
    /* Without a perspective this is the authored board: seat 0 wears the skin, 1..3 stay fixed.
       With one, both sides of the duel are the player's own red/blue pair, whatever the seat
       numbers say. The material stays the seat's: your equipped ball/wall, the rival's Classic. */
    const ramps = perspective
      ? perspectiveRamps(perspective.local, perspective.rival, perspective.color)
      : [t.ball.ramp, ...SEAT_RAMPS, ERR_RAMP];
    const local = perspective ? perspective.local : 0;
    const out: Side[] = [];
    for (let i = 0; i < SEAT_COUNT; i++) {
      const mine = i === local;
      out.push({
        ramp: ramps[i] ?? ERR_RAMP,
        ball: mine ? t.ball : CLASSIC_BALL,
        wall: mine ? t.wall : CLASSIC_WALL,
      });
    }
    return out;
  }

  /**
   * The canvas's device-pixel ratio, capped for the board. A 3x phone draws nine device pixels for
   * every css pixel; past 2x the slab, its glows and the debris gain nothing the eye can find, and
   * a small touch viewport tops out at 1.75 — still crisp, a third less fill. On a budget Android
   * WebView that fill is what the GPU runs out of first.
   */
  function canvasDpr(): number {
    const raw = window.devicePixelRatio || 1;
    const touch = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    const small = Math.min(window.innerWidth || 0, window.innerHeight || 0) <= 520;
    return Math.min(raw, touch || small ? 1.75 : 2);
  }

  /**
   * Measure the board and rebuild its paint servers. Returns true only when the geometry came from
   * a mounted, non-zero container. A zero-size box is never turned into a layout: a 0x0 fit floors
   * the cell at 1px and pushes the origin negative, which paints every pawn outside the canvas.
   * Instead the last good layout is kept and the cache is invalidated, so the deferred rAF pass or
   * the board's ResizeObserver is guaranteed to re-fit the moment the DOM settles.
   */
  function resize(): boolean {
    const dpr = canvasDpr();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
      layoutReady = false;
      lastW = -1; lastH = -1; lastDpr = -1;
      /* Strike the paint servers once against the finite fallback layout, never the degenerate
         0x0 box: a frame drawn before the first real fit must still find its gradients. */
      if (!ballFx.length) buildStatic();
      return false;
    }
    if (layoutReady && w === lastW && h === lastH && dpr === lastDpr) return true;
    lastW = w; lastH = h; lastDpr = dpr;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    L = computeLayout(w, h, dpr, cols, rows);
    if (!(L.cell > 0) || !Number.isFinite(L.cell) || !Number.isFinite(L.ox) || !Number.isFinite(L.oy)) {
      layoutReady = false;
      lastW = -1; lastH = -1; lastDpr = -1;
      return false;
    }
    layoutReady = true;
    buildStatic();
    return true;
  }

  /** The canvas-pixel centre of a logical tile — the one source of truth for a pawn's spawn. */
  function tileToCanvas(c: number, r: number): Vec {
    return { x: L.ox + (c + 0.5) * L.cell, y: L.oy + (r + 0.5) * L.cell };
  }

  /** Arm ONE deferred verification frame. Never polls: a further change is the observer's job. */
  function scheduleSettle() {
    layoutCheck = true;
    if (settleRaf) return;
    settleRaf = requestAnimationFrame(() => {
      settleRaf = 0;
      if (!layoutReady || canvas.clientWidth !== lastW || canvas.clientHeight !== lastH) {
        lastW = -1; lastH = -1; lastDpr = -1;
        resize();
        /* resize() clears the canvas. The main loop is parked while the board is idle, so ask
           for one frame explicitly — a resize must never leave a blank slab behind. */
        opts.onLayoutChanged?.();
      }
    });
  }

  /**
   * Force a fresh measurement now and verify it on the next frame. Clearing `hidden`, a
   * container-query reflow and a WebView toolbar collapse can all change this box one frame after
   * the reveal, and the wrap's ResizeObserver stays silent if its own size never changed.
   */
  function settle(): boolean {
    /* An observer notification does not always mean the box moved. Skip the rebuild when the
       cached fit is already live, but still arm the deferred verification frame. */
    if (!layoutReady || canvas.clientWidth !== lastW || canvas.clientHeight !== lastH
      || canvasDpr() !== lastDpr) {
      lastW = -1; lastH = -1; lastDpr = -1;
      const ok = resize();
      scheduleSettle();
      return ok;
    }
    scheduleSettle();
    return true;
  }

  /** Everything that only depends on the layout or the theme: the board layer + every paint server. */
  function buildStatic() {
    const { w, h, cell: c, ox, oy, dpr } = L;
    const b = th.board;
    /* The static half of the board — slab, every tile, the grid grooves and the finish bar — is
       struck once per layout and blitted whole every frame. A frame therefore never rebuilds a
       tile gradient or re-strokes 140 squares, and no ambient beam is painted at all. */
    const cv = boardBufferCanvas || (boardBufferCanvas = document.createElement('canvas'));
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    const g = cv.getContext('2d')!;
    const bw = cols * c, bh = rows * c, R = CORNER * c;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    /* the slab: one solid clay face lifted off the card by a TIGHT 2-3px drop. A wide 18px
       blurred shadow here used to smear a second soft edge under the whole neon rim; it is baked
       once, but it is still the largest blurred surface on the board. */
    g.save();
    g.shadowColor = b.drop;
    g.shadowBlur = 3 * dpr;
    g.shadowOffsetY = 2 * dpr;
    rr(g, ox, oy, bw, bh, R);
    if (typeof b.surface === 'string') g.fillStyle = b.surface;
    else {
      const face = g.createLinearGradient(0, oy, 0, oy + bh);
      for (const [t, col] of b.surface) face.addColorStop(t, col);
      g.fillStyle = face;
    }
    g.fill();
    g.restore();

    /* everything after this is clipped to the slab, so no bevel or beam can bleed past its edge */
    g.save();
    rr(g, ox, oy, bw, bh, R);
    g.clip();

    // device-pixel snapping keeps the finish bar's hairlines crisp at any dpr (no half-pixel seams)
    const px = (n: number) => Math.round(n * dpr) / dpr;

    /* the inner bevel that makes it read as clay: lit along the top edge, shaded into the bottom */
    const bevelW = bevelBand(c);
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

    /* Three tile finishes, all painted over the same slab. The dark arenas wear polished glass:
       every square is a translucent sapphire key, its face catching the ceiling light along the
       crown and deepening toward its foot, with a soft specular bloom at the top edge and a
       crisp 1px top/left catch. The light arena is a chessboard cut in pearl and
       platinum: a gloss-ivory pad beside a cool metallic one, each its own raised piece with a
       crisp groove between, a lit top/left inset and a shaded foot. Pale shop boards keep their
       inset clay checks. */
    const gap = Math.max(1, c * 0.03);
    const tw = c - gap, tr = Math.min(c * (b.glass ? 0.18 : 0.15), tw / 2);
    if (b.pearl) {
      /* ---- pearl | platinum: the modern chessboard ----
         A hidden board can report a one-pixel cell before its screen is revealed; every derived
         length is floored so a boot with Light Mode saved can never build a negative gradient. */
      const pGap = Math.min(c * 0.35, Math.max(1.2, c * 0.034));
      const pw = Math.max(1, c - pGap);
      const pr = Math.max(1, Math.min(pw * 0.1, c * 0.12));
      const rimW = Math.max(1, c * 0.018);

      /* the light every pad catches: a soft crown bloom in the upper-left, held inside the face */
      const bloom = g.createRadialGradient(pw * 0.27, pw * 0.15, 0, pw * 0.27, pw * 0.15, Math.max(0.5, pw * 0.95));
      bloom.addColorStop(0, 'rgba(255,255,255,.78)');
      bloom.addColorStop(0.32, 'rgba(255,255,255,.28)');
      bloom.addColorStop(0.68, 'rgba(255,255,255,.06)');
      bloom.addColorStop(1, 'rgba(255,255,255,0)');

      /* one broad glass reflection raked across the upper-left of the ivory squares */
      const gloss = g.createLinearGradient(0, 0, pw, pw);
      gloss.addColorStop(0, 'rgba(255,255,255,.62)');
      gloss.addColorStop(0.34, 'rgba(255,255,255,.16)');
      gloss.addColorStop(0.62, 'rgba(255,255,255,0)');
      gloss.addColorStop(1, 'rgba(116,126,140,.05)');

      /* the foot of a pad: a faint cool pool, so the square reads pressed into the slab */
      const foot = g.createLinearGradient(0, 0, 0, pw);
      foot.addColorStop(0, 'rgba(54,64,78,0)');
      foot.addColorStop(0.72, 'rgba(54,64,78,0)');
      foot.addColorStop(0.92, 'rgba(54,64,78,.06)');
      foot.addColorStop(1, 'rgba(45,55,68,.16)');

      /* the beveled rim: lit along the crown, cooling into a fine slate line at the foot */
      const padRim = g.createLinearGradient(0, 0, 0, pw);
      padRim.addColorStop(0, 'rgba(255,255,255,.95)');
      padRim.addColorStop(0.42, 'rgba(255,255,255,.22)');
      padRim.addColorStop(0.72, 'rgba(92,101,114,.08)');
      padRim.addColorStop(1, 'rgba(64,73,86,.3)');

      const ivory = g.createLinearGradient(0, 0, 0, pw);
      ivory.addColorStop(0, '#fffefb');
      ivory.addColorStop(0.5, '#faf6ee');
      ivory.addColorStop(1, '#efe9dc');

      /* the platinum square is a brushed cool metal: brightest at the crown, slate at the foot */
      const platinum = g.createLinearGradient(0, 0, pw, pw);
      platinum.addColorStop(0, '#f3f5f8');
      platinum.addColorStop(0.34, '#e3e7ec');
      platinum.addColorStop(0.7, '#d2d8df');
      platinum.addColorStop(1, '#c5ccd6');

      const topCatch = 'rgba(255,255,255,.9)';
      const bottomShade = 'rgba(67,76,90,.18)';
      for (let r0 = 1; r0 < rows; r0++) {          // row 0 belongs to the finish bar, not the tiles
        for (let c0 = 0; c0 < cols; c0++) {
          const tx = ox + c0 * c + pGap / 2, ty = oy + r0 * c + pGap / 2;
          const pearlTile = (c0 + r0) % 2 === 0;
          g.save();
          g.translate(tx, ty);
          g.shadowColor = 'rgba(72,60,40,.17)';    // each pad casts its own short contact shadow
          g.shadowBlur = Math.max(1, c * 0.04);
          g.shadowOffsetY = Math.max(0.5, c * 0.02);
          rr(g, 0, 0, pw, pw, pr);
          g.fillStyle = pearlTile ? ivory : platinum;
          g.fill();
          g.restore();

          g.save();
          g.translate(tx, ty);
          rr(g, 0, 0, pw, pw, pr);
          g.clip();
          g.fillStyle = bloom;
          g.globalAlpha = pearlTile ? 1 : 0.58;
          g.fillRect(0, 0, pw, pw);
          if (pearlTile) {
            g.globalAlpha = 0.8;
            g.fillStyle = gloss;
            g.fillRect(0, 0, pw, pw);
          }
          g.globalAlpha = 1;
          g.fillStyle = foot;
          g.fillRect(0, 0, pw, pw);
          g.restore();

          /* the crisp cut: one lit crown/left catch over a cool shaded foot */
          g.save();
          g.translate(tx, ty);
          rr(g, rimW / 2, rimW / 2, pw - rimW, pw - rimW, Math.max(0, pr - rimW / 2));
          g.lineWidth = rimW;
          g.strokeStyle = padRim;
          g.stroke();
          g.lineWidth = Math.max(1, rimW * 0.8);
          g.strokeStyle = topCatch;
          g.beginPath();
          g.moveTo(pr, rimW * 0.35);
          g.lineTo(pw - pr, rimW * 0.35);
          g.moveTo(rimW * 0.35, pr);
          g.lineTo(rimW * 0.35, pw - pr);
          g.stroke();
          g.strokeStyle = bottomShade;
          g.beginPath();
          g.moveTo(pr, pw - rimW * 0.35);
          g.lineTo(pw - pr, pw - rimW * 0.35);
          g.moveTo(pw - rimW * 0.35, pr);
          g.lineTo(pw - rimW * 0.35, pw - pr);
          g.stroke();
          g.restore();
        }
      }
    } else if (b.glass) {
      /* the glass light: one lit-crown-to-dark-foot gradient shared by every tile */
      const glass = g.createLinearGradient(0, 0, 0, tw);
      glass.addColorStop(0, 'rgba(255,255,255,.11)');
      glass.addColorStop(0.34, 'rgba(255,255,255,.035)');
      glass.addColorStop(0.6, 'rgba(255,255,255,0)');
      glass.addColorStop(0.82, 'rgba(0,0,0,.1)');
      glass.addColorStop(1, 'rgba(0,0,0,.24)');
      /* the rim: lit along the crown, shaded into the bottom lip. The first stop is the brief's
         `inset 0 1px 0 rgba(255,255,255,.18)`, drawn as the top edge of the stroked tile. */
      const tileRim = g.createLinearGradient(0, 0, 0, tw);
      tileRim.addColorStop(0, 'rgba(255,255,255,.18)');
      tileRim.addColorStop(0.2, 'rgba(255,255,255,.06)');
      tileRim.addColorStop(0.52, 'rgba(255,255,255,0)');
      tileRim.addColorStop(0.8, 'rgba(0,0,0,.16)');
      tileRim.addColorStop(1, 'rgba(0,0,0,.42)');
      /* the overhead lights, held in the glass: a soft crown bloom repeated on every pad */
      const spec = g.createRadialGradient(tw * 0.3, tw * 0.12, 0, tw * 0.3, tw * 0.12, tw * 0.82);
      spec.addColorStop(0, 'rgba(255,255,255,.32)');
      spec.addColorStop(0.24, 'rgba(255,255,255,.14)');
      spec.addColorStop(0.6, 'rgba(255,255,255,.035)');
      spec.addColorStop(1, 'rgba(255,255,255,0)');
      const rimW = Math.max(1, c * 0.022);
      const hair = Math.max(1, c * 0.018);
      for (let r0 = 1; r0 < rows; r0++) {          // row 0 belongs to the finish bar, not the tiles
        /* the rows nearest the finish catch a slightly stronger baked glint */
        const glint = r0 <= 3 ? 0.38 - (r0 - 1) * 0.08 : 0.075;
        for (let c0 = 0; c0 < cols; c0++) {
          const tx = ox + c0 * c + gap / 2, ty = oy + r0 * c + gap / 2;
          g.save();
          g.translate(tx, ty);            // the shared gradients follow the tile
          rr(g, 0, 0, tw, tw, tr);
          g.fillStyle = (c0 + r0) % 2 === 0 ? b.tile[0] : b.tile[1];
          g.fill();
          g.fillStyle = glass;
          g.fill();
          /* the specular sits on the face, clipped so no light leaks into the groove */
          g.save();
          g.clip();
          g.globalAlpha = glint;
          g.fillStyle = spec;
          g.fillRect(0, 0, tw, tw);
          g.restore();
          /* a fine lit rim around the pad: bright along the top, dark under the bottom lip */
          rr(g, 0, 0, tw, tw, tr);
          g.lineWidth = rimW;
          g.strokeStyle = tileRim;
          g.stroke();
          /* the left edge keeps its own catch, like the top's inset highlight */
          g.lineWidth = hair;
          g.strokeStyle = 'rgba(255,255,255,.14)';
          g.beginPath();
          g.moveTo(hair / 2, tr);
          g.lineTo(hair / 2, tw - tr);
          g.stroke();
          g.restore();
        }
      }
    } else {
      /* inset clay tiles: a faint two-tone checker with a 1px tactile gap, each square shaded
         darker at its top and lighter at its foot, which is what reads as "pressed in" */
      const shade = g.createLinearGradient(0, 0, 0, c);
      shade.addColorStop(0, b.bevel[1]);
      shade.addColorStop(0.42, clear(b.bevel[1]));
      shade.addColorStop(0.78, clear(b.bevel[0]));
      shade.addColorStop(1, b.bevel[0]);
      const rimW = Math.max(1, c * 0.022);
      const rimLit = withAlpha(b.bevel[0], 0.22);
      g.lineWidth = Math.max(1, c * 0.035);
      g.strokeStyle = shade;
      for (let r0 = 1; r0 < rows; r0++) {          // row 0 belongs to the finish bar, not the tiles
        for (let c0 = 0; c0 < cols; c0++) {
          const tx = ox + c0 * c + gap / 2, ty = oy + r0 * c + gap / 2;
          rr(g, tx, ty, tw, tw, tr);
          g.fillStyle = (c0 + r0) % 2 === 0 ? b.tile[0] : b.tile[1];
          g.fill();
          g.save();
          g.translate(tx, ty);            // the shared shade gradient follows the tile
          rr(g, 0, 0, tw, tw, tr);
          g.stroke();
          g.lineWidth = rimW;             // a crisp light rim lifts every square off the groove
          g.strokeStyle = rimLit;
          rr(g, rimW / 2, rimW / 2, tw - rimW, tw - rimW, Math.max(0, tr - rimW / 2));
          g.stroke();
          g.restore();
        }
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

    /* the bar itself: one recessed band of emerald clay, lit along its crown and gathering shade
       toward its foot */
    const kerb = g.createLinearGradient(0, oy, 0, oy + kh);
    kerb.addColorStop(0, b.kerb[0]);
    kerb.addColorStop(0.62, b.kerb[1]);
    kerb.addColorStop(1, b.kerb[1]);
    g.fillStyle = kerb;
    g.fillRect(ox, oy, bw, kh);

    /* a warm gold sheen across the crown, so the emerald reads as a lit ceremonial band */
    const sheen = g.createLinearGradient(ox, 0, ox + bw, 0);
    sheen.addColorStop(0, 'rgba(255,205,92,0)');
    sheen.addColorStop(0.24, 'rgba(255,216,122,.06)');
    sheen.addColorStop(0.5, 'rgba(255,229,156,.14)');
    sheen.addColorStop(0.76, 'rgba(255,216,122,.06)');
    sheen.addColorStop(1, 'rgba(255,205,92,0)');
    g.fillStyle = sheen;
    g.fillRect(ox, oy, bw, kh);

    /* the warm-gold ambient the title sits in: one soft centred radial, so the middle of the bar
       carries a bright glow the crest is struck into */
    const gx = ox + bw / 2, gy = oy + kh * 0.52;
    const amb = g.createRadialGradient(gx, gy, 0, gx, gy, Math.max(c * 2.2, bw * 0.34));
    amb.addColorStop(0, 'rgba(255,216,130,.24)');
    amb.addColorStop(0.5, 'rgba(255,198,96,.09)');
    amb.addColorStop(1, 'rgba(255,198,96,0)');
    g.fillStyle = amb;
    g.fillRect(ox, oy, bw, kh);

    /* the top metallic rim: a crisp gold highlight riding just inside the ring that trims the slab,
       fading into the clay so the crown reads lit rather than outlined */
    const rimH = Math.max(2, c * 0.14);
    const rim = g.createLinearGradient(0, oy, 0, oy + rimH);
    rim.addColorStop(0, 'rgba(255,251,226,.96)');
    rim.addColorStop(0.4, tint(core, 0.72));
    rim.addColorStop(1, tint(core, 0));
    g.fillStyle = rim;
    g.fillRect(ox, oy, bw, rimH);

    /* the foot of the bar, read as a bevel: a dark lip easing it onto the arrival cells, closed by
       one clean hairline — the border that separates the crown from the board proper */
    const lip = Math.max(2, c * 0.2);
    const foot = g.createLinearGradient(0, oy + kh - lip, 0, oy + kh);
    foot.addColorStop(0, 'rgba(0,0,0,0)');
    foot.addColorStop(1, 'rgba(0,0,0,.4)');
    g.fillStyle = foot;
    g.fillRect(ox, oy + kh - lip, bw, lip);
    g.fillStyle = b.rule;
    g.fillRect(ox, px(oy + c) - Math.max(1, c * 0.022), bw, Math.max(1, c * 0.022));

    /* the light the goal zone throws down onto the arrival tiles: the emerald wash the arena is
       themed with, and its warm amber partner, both starting below the line so they never wash the
       checks out. This is what takes the hard seam out of the join with row 1. On a coloured
       perspective the emerald wash becomes the local player's own family, so the finish glow is
       theirs even though the gold crown and the kerb never change. */
    const localWash: Stop[] | null = perspective
      ? (() => {
        const glow = sides[perspective.local]?.ramp.glow;
        return glow
          ? [[0, withAlpha(glow, 0.2)], [0.45, withAlpha(glow, 0.07)], [1, withAlpha(glow, 0)]]
          : null;
      })()
      : null;
    for (const stops of [localWash ?? b.glow, b.spill]) {
      const fg = g.createLinearGradient(0, oy + c, 0, oy + 3.6 * c);
      for (const [t, col] of resolve(null, stops)) fg.addColorStop(t, col);
      g.fillStyle = fg;
      g.fillRect(ox, oy + c, bw, 2.6 * c);
    }

    /* The overhead spotlight beams that used to fan down from the finish line are gone. Three
       additive trapezoids plus a wide gradient per beam were the most expensive fill on the
       board, and they were pure ambience — the crown and the kerb already say "finish". */
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
    lampG.length = 0;
    dotG.length = 0;
    capG.length = 0;
    const br = ballR(c);
    for (let i = 0; i < MAX_TEAMS; i++) {
      const s = sides[i];
      const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, br * 1.3);
      shadow.addColorStop(0, `rgba(${s.ramp.shade},${b.pearl ? 0.78 : 0.58})`);
      shadow.addColorStop(0.55, `rgba(${s.ramp.shade},${b.pearl ? 0.38 : 0.26})`);
      shadow.addColorStop(1, `rgba(${s.ramp.shade},0)`);
      const body = ctx.createRadialGradient(-0.34 * br, -0.4 * br, br * 0.06, -0.08 * br, -0.08 * br, br * 1.12);
      for (const [t, col] of resolve(s.ramp, s.ball.stops)) body.addColorStop(t, col);
      const bounce = ctx.createRadialGradient(0.3 * br, 0.62 * br, 0, 0.3 * br, 0.62 * br, br * 0.8);
      bounce.addColorStop(0, `rgba(255,255,255,${s.ball.bounce})`);
      bounce.addColorStop(1, 'rgba(255,255,255,0)');
      ballFx.push({ shadow, body, bounce });
      /* halo gradients are struck to the SAME tight radius the frame actually fills, so every
         stop is used and no pawn pays for a wide transparent disc. */
      const glow = ctx.createRadialGradient(0, 0, br * 0.8, 0, 0, br * 1.5);
      glow.addColorStop(0, s.ramp.glow);
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      glowG.push(glow);
      const lamp = ctx.createRadialGradient(0, 0, br * 0.4, 0, 0, c * 1.1);
      lamp.addColorStop(0, s.ramp.glow);
      lamp.addColorStop(0.18, tint(s.ramp.light, 0.5));
      lamp.addColorStop(0.5, withAlpha(s.ramp.glow, 0.16));
      lamp.addColorStop(0.8, withAlpha(s.ramp.glow, 0.05));
      lamp.addColorStop(1, 'rgba(255,255,255,0)');
      lampG.push(lamp);
      /* the dot's halo: a radial falloff instead of a `shadowBlur` on every legal-move dot */
      const dot = ctx.createRadialGradient(0, 0, 0, 0, 0, c * 0.62);
      dot.addColorStop(0, s.ramp.glow);
      dot.addColorStop(0.42, withAlpha(s.ramp.glow, 0.42));
      dot.addColorStop(1, 'rgba(255,255,255,0)');
      dotG.push(dot);
      /* the wall ghost's end caps: one gradient per seat, moved to each end at paint time */
      const cap = ctx.createRadialGradient(0, 0, 0, 0, 0, c * 0.26);
      cap.addColorStop(0, 'rgba(255,255,255,.95)');
      cap.addColorStop(0.3, s.ramp.light);
      cap.addColorStop(1, 'rgba(255,255,255,0)');
      capG.push(cap);
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
    /* the trigger's light: a tight soft wash under the burst. It is a finite transition, but a
       2.4-cell disc of additive blending still costs a full tile block per frame on a phone. */
    const bg2 = ctx.createRadialGradient(0, 0, 0, 0, 0, c * 1.4);
    bg2.addColorStop(0, 'rgba(255,150,60,.75)');
    bg2.addColorStop(0.42, 'rgba(255,90,20,.34)');
    bg2.addColorStop(1, 'rgba(255,90,20,0)');
    blastGlow = bg2;

    /* the finisher's three servers: the winner's gold, a loser's overheat, and the scorched tile */
    const fg = ctx.createRadialGradient(0, 0, 0, 0, 0, br * 2.9);
    fg.addColorStop(0, 'rgba(255,232,164,.9)');
    fg.addColorStop(0.32, 'rgba(255,196,84,.42)');
    fg.addColorStop(0.72, 'rgba(255,164,40,.12)');
    fg.addColorStop(1, 'rgba(255,148,20,0)');
    crownG = fg;
    const hg = ctx.createRadialGradient(0, 0, 0, 0, 0, br * 2.2);
    hg.addColorStop(0, 'rgba(255,226,168,1)');
    hg.addColorStop(0.26, 'rgba(255,126,48,.86)');
    hg.addColorStop(0.6, 'rgba(228,24,38,.44)');
    hg.addColorStop(1, 'rgba(150,0,24,0)');
    heatG = hg;
    const sc = ctx.createRadialGradient(0, 0, 0, 0, 0, c * 0.62);
    sc.addColorStop(0, 'rgba(8,5,5,.82)');
    sc.addColorStop(0.5, 'rgba(24,12,9,.5)');
    sc.addColorStop(1, 'rgba(24,12,9,0)');
    scorchG = sc;
    decal = buildDecalArt(c, dpr);
    buildCrest(bw);
    /* The inscription is board furniture, not animation: strike it into the buffer once. Only the
       arrival flare layered over it in `draw()` stays live paint. */
    if (crestArt) g.drawImage(crestArt, crestGeo.x, crestGeo.y, crestGeo.w, crestGeo.h);
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
    const fs = Math.min(kh * 0.5, ((bw - c * 2.6) / units) * 100);
    if (fs < 6) return;
    const track = fs * CREST_TRACK;
    m.font = crestFont(fs);
    const wds: number[] = [];
    let tw = 0;
    for (const ch of CREST_WORD) { const w = m.measureText(ch).width; wds.push(w); tw += w + track; }
    tw -= track;
    const rule = fs * 1.5, gap = fs * 0.6, H = fs * 1.9, W = tw + 2 * (rule + gap);
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
    const outline = (dy: number) => {
      let x = cx - tw / 2;
      for (let i = 0; i < wds.length; i++) { g.strokeText(CREST_WORD[i], x, mid + dy); x += wds[i] + track; }
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
    g.fillStyle = 'rgba(255,248,220,.5)';            // a hair of light along each glyph's crown
    strike(-fs * 0.035);
    const body = g.createLinearGradient(0, mid - fs * 0.52, 0, mid + fs * 0.52);
    for (const [t, col] of gold) body.addColorStop(t, col);
    /* a warm halo first, then a dark emerald keyline, then the crisp gold face on top */
    g.fillStyle = body;
    g.shadowColor = 'rgba(255,196,84,.95)';
    g.shadowBlur = fs * 0.65 * dpr;
    strike(0);
    g.shadowBlur = 0;
    g.lineJoin = 'round';
    g.strokeStyle = th.board.pearl ? 'rgba(52,34,7,.86)' : 'rgba(3,37,26,.8)';
    g.lineWidth = Math.max(1, fs * 0.06);
    outline(0);
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
    const { cell: c, ox, oy } = L;
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
    const pearl = !!th.board.pearl;
    /* The lift a lit bar throws onto the clay, as three wide alpha strokes. `shadowBlur` makes
       the GPU re-rasterise the stroke through a gaussian blur every frame; flat passes cost a
       fraction of that and read the same at phone size. */
    if (glow && st.glow > 0) {
      const spread = Math.max(2, c * (pearl ? 0.2 : 0.16) * st.glow);
      const glowA = Math.min(0.55, (pearl ? 0.34 : 0.3) * st.glow);
      ctx.strokeStyle = pearl ? `rgba(${s.ramp.shade},.62)` : s.ramp.glow;
      for (let k = 3; k >= 1; k--) {
        ctx.globalAlpha = alpha * st.alpha * (glowA / k);
        ctx.lineWidth = t + spread * k;
        ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0 + len, 0); ctx.stroke();
      }
      ctx.globalAlpha = alpha * st.alpha;
    }
    /* a dark contact outline keeps the bar's silhouette crisp on the bright tiles */
    ctx.lineWidth = t + Math.max(1.5, c * (pearl ? 0.072 : 0.05));
    ctx.strokeStyle = `rgba(${s.ramp.shade},${pearl ? 0.6 : 0.42})`;
    ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0 + len, 0); ctx.stroke();
    ctx.lineWidth = t;
    ctx.strokeStyle = barGrad(pi, t);
    ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0 + len, 0); ctx.stroke();
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

  /**
   * The two glowing caps on a valid wall ghost. They pin the bar's ends to the exact vertices the
   * partition runs between, so the preview reads as a complete two-tile wall even with its action
   * keys now floating clear of it.
   */
  function drawGhostCaps(w: WallSpec, pi: number, alpha: number, still: boolean) {
    const { cell: c, ox, oy } = L;
    const s = sides[pi];
    const ends = w.o === 'h'
      ? [{ x: ox + w.x * c, y: oy + w.y * c }, { x: ox + (w.x + 2) * c, y: oy + w.y * c }]
      : [{ x: ox + w.x * c, y: oy + w.y * c }, { x: ox + w.x * c, y: oy + (w.y + 2) * c }];
    const breath = still ? 0.6 : 0.6 + 0.4 * Math.sin(performance.now() / 420);
    const cap = capG[pi];
    ctx.save();
    for (const e of ends) {
      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.globalAlpha = alpha * 0.8;
      ctx.fillStyle = cap;
      ctx.beginPath(); ctx.arc(0, 0, c * 0.26, 0, TAU); ctx.fill();
      if (!still) {
        ctx.globalAlpha = alpha * 0.26 * breath;
        ctx.strokeStyle = s.ramp.light;
        ctx.lineWidth = Math.max(1, c * 0.035);
        ctx.beginPath(); ctx.arc(0, 0, c * (0.16 + 0.035 * breath), 0, TAU); ctx.stroke();
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(255,255,255,.96)';
      ctx.beginPath(); ctx.arc(0, 0, Math.max(1.4, c * 0.045), 0, TAU); ctx.fill();
      ctx.restore();
    }
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

  function drawBall(cx: number, cy: number, r: number, i: number, badge = 0, wounded = false) {
    if (!ballFx.length) buildStatic();
    const seat = i >= 0 && i < sides.length ? i : 0;
    const s = sides[seat], fx = ballFx[seat] ?? ballFx[0];
    if (!s || !fx) return;                    // no paint servers to draw with (draw() prevents this)
    /* Recover rather than drop: a bad coordinate is snapped back onto the board, and a zero or
       NaN radius is replaced with a strictly positive one. Nothing here can hide a pawn. */
    if (!(r > 0) || !Number.isFinite(r)) r = Math.max(1, ballR(L.cell));
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      const at = tileToCanvas(0, 0);
      cx = at.x; cy = at.y;
    }
    /* Each token owns its own context: no aborted spawn tween or leaked pass can strand this
       pawn at alpha 0, at scale 0, or under an additive composite. */
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.translate(cx, cy);

    ctx.save();                        // soft elliptical shadow
    ctx.translate(0, r * 0.82);
    ctx.scale(1, 0.3);
    ctx.fillStyle = fx.shadow;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.1, 0, TAU); ctx.fill();
    ctx.restore();
    if (th.board.pearl) {              // a tight dark contact shadow, so the token lifts off pearl
      ctx.save();
      ctx.translate(0, r * 0.9);
      ctx.scale(1, 0.24);
      ctx.fillStyle = 'rgba(38,31,22,.26)';
      ctx.beginPath(); ctx.arc(0, 0, r * 1.12, 0, TAU); ctx.fill();
      ctx.restore();
    }

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

    /* the crisp edge: a stroke thick enough to silhouette the ball on the lit tiles, its
       centre-line pulled inside the silhouette so the ring does not feather past it. On a cramped
       board `r` can fall under half a pixel, so the inset is clamped to zero. */
    const edge = Math.max(1, r * 0.09);
    ctx.beginPath(); ctx.arc(0, 0, Math.max(0, r - edge / 2), 0, TAU);
    ctx.strokeStyle = s.ramp.edge; ctx.lineWidth = edge; ctx.stroke();

    shine(s, r);
    if (wounded) drawWoundMark(r);
    if (badge > 0) drawBadge(r, badge);
    ctx.restore();
  }

  /**
   * The wound itself, inside the ball's own transform: a dark bite chipped out of the upper-left
   * rim with a crimson cut and a bead. Kept small — the pulse ring is the state, this is the story.
   */
  function drawWoundMark(r: number) {
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.clip();
    const mid = -2.34;                       // centre of the bite, upper left
    ctx.fillStyle = 'rgba(8,10,17,.58)';
    ctx.beginPath();
    ctx.arc(0, 0, r, mid - 0.3, mid + 0.3);
    ctx.lineTo(Math.cos(mid) * r * 0.66, Math.sin(mid) * r * 0.66);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(153,27,27,.9)';
    ctx.lineWidth = Math.max(1, r * 0.13);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-r * 0.56, -r * 0.28);
    ctx.quadraticCurveTo(-r * 0.04, -r * 0.04, r * 0.28, r * 0.5);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(122,16,16,.95)';
    ctx.lineWidth = Math.max(0.6, r * 0.05);
    ctx.stroke();
    ctx.fillStyle = 'rgba(220,38,38,.95)';
    ctx.beginPath(); ctx.arc(-r * 0.46, -r * 0.2, Math.max(0.8, r * 0.07), 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.beginPath(); ctx.arc(-r * 0.48, -r * 0.23, Math.max(0.3, r * 0.025), 0, TAU); ctx.fill();
    ctx.restore();
  }

  /**
   * The VIP prestige mark: a thin metallic-gold ring outside the pawn, with a quiet warm bloom
   * behind it. It is painted under selection and wounded states so those still read on top, and it
   * breathes slower than the turn halo — a status, not a turn.
   */
  function drawVipAura(cx: number, cy: number, r: number, now: number, still: boolean) {
    const c = L.cell;
    const pulse = still ? 0.7 : 0.58 + 0.42 * Math.sin(now / 620);
    ctx.save();
    ctx.translate(cx, cy);
    /* tight halo: a 1px metallic ring with a ~2px warm bloom, not a wide glow disc */
    const halo = ctx.createRadialGradient(0, 0, r * 1.05, 0, 0, r * 1.55);
    halo.addColorStop(0, `rgba(255, 214, 120, ${(0.16 * pulse).toFixed(3)})`);
    halo.addColorStop(0.55, `rgba(255, 190, 64, ${(0.11 * pulse).toFixed(3)})`);
    halo.addColorStop(1, 'rgba(255, 190, 64, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.55, 0, TAU); ctx.fill();

    const ring = ctx.createLinearGradient(-r, -r, r, r);
    ring.addColorStop(0, '#FFF6D0');
    ring.addColorStop(0.32, '#F5C84E');
    ring.addColorStop(0.62, '#A9771B');
    ring.addColorStop(0.82, '#F3D483');
    ring.addColorStop(1, '#FFE9A3');
    ctx.lineWidth = Math.max(1.8, c * 0.055);
    ctx.strokeStyle = 'rgba(12, 9, 3, .7)';
    ctx.beginPath(); ctx.arc(0, 0, r * 1.5, 0, TAU); ctx.stroke();
    ctx.strokeStyle = ring;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.46, 0, TAU); ctx.stroke();
    /* one short highlight arc at the crown of the ring, so the metal reads as lit rather than flat */
    ctx.strokeStyle = 'rgba(255, 251, 228, .9)';
    ctx.lineWidth = Math.max(1.2, c * 0.03);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, 0, r * 1.46, -2.55, -2.05); ctx.stroke();
    ctx.restore();
  }

  /**
   * The wide coloured pool a pawn throws across the tiles around it. Additive and kept below the
   * finish row, so red and blue light warms the grid without ever tinting the crown.
   * `k` is the active-seat beat; a resting pawn still casts a quiet version of the same light.
   */
  function drawLamp(cx: number, cy: number, i: number, k: number) {
    const pearl = !!th.board.pearl;
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.ox, L.oy + L.cell, L.cols * L.cell, (L.rows - 1) * L.cell);
    ctx.clip();
    /* additive light is invisible on ivory; pearl boards take a normal-blended, punchier pool */
    ctx.globalCompositeOperation = pearl ? 'source-over' : 'lighter';
    ctx.globalAlpha = (1 - 0.25 * k) * sides[i].ball.halo * (pearl ? 0.42 : 1);
    ctx.translate(cx, cy);
    ctx.fillStyle = lampG[i];
    /* a tight pool (~1.1 cells) instead of a 2.5-cell disc: a fifth of the blended pixels per
       pawn per frame, and the neon still reads on the dark clay. */
    ctx.beginPath(); ctx.arc(0, 0, L.cell * 1.1, 0, TAU); ctx.fill();
    ctx.restore();
  }

  /** Halo under the balls of the seat to move (or of the winner) — the one light on the slab. */
  function drawGlow(cx: number, cy: number, r: number, i: number, k: number) {
    const pearl = !!th.board.pearl;
    ctx.save();
    ctx.translate(cx, cy);
    if (pearl) ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = Math.min(1, (0.42 + 0.34 * k) * sides[i].ball.halo * (pearl ? 0.72 : 1));
    ctx.fillStyle = glowG[i];
    ctx.beginPath(); ctx.arc(0, 0, r * 1.5, 0, TAU); ctx.fill();
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
    ctx.strokeStyle = th.board.pearl
      ? `rgba(28,34,44,${0.5 + 0.22 * pulse})`
      : `rgba(255,255,255,${0.88 + 0.12 * pulse})`;
    ctx.lineWidth = Math.max(2, c * 0.08);
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.3 * (1 + 0.05 * pulse), 0, TAU); ctx.stroke();
    ctx.setLineDash([c * 0.15, c * 0.12]);
    ctx.lineDashOffset = still ? 0 : -now / 40;
    ctx.strokeStyle = `rgba(${sides[i].ramp.shade},.6)`;   // dark backing keeps the dashes legible
    ctx.lineWidth = Math.max(3, c * 0.085);
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.42, 0, TAU); ctx.stroke();
    ctx.strokeStyle = sides[i].ramp.mid;
    ctx.lineWidth = Math.max(1.5, c * 0.05);
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.42, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  /** A wounded piece wears a slow crimson pulse: 25% at its brightest, under everything else. */
  function drawWoundedRing(cx: number, cy: number, r: number, now: number, still: boolean) {
    const c = L.cell;
    const beat = still ? 1 : 0.5 + 0.5 * Math.sin(now / 360);
    ctx.save();
    ctx.strokeStyle = `rgba(220,38,38,${(0.13 + 0.12 * beat).toFixed(3)})`;
    ctx.lineWidth = Math.max(1.5, c * 0.042);
    ctx.beginPath();
    ctx.arc(cx, cy, r * (1.42 + 0.07 * beat), 0, TAU);
    ctx.stroke();
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

  /**
   * Marching ants around a whole cell — "this is the square you are about to use".
   *
   * The ring is board furniture, so the slab clip cuts everything that reaches past the slab, and on
   * an outer column or row the cell's own edge *is* the border: the ring's stroke landed on the
   * bevel and grazed the rounded corner, which read as a ring sawn in half. It now slides inward,
   * as one piece, just far enough for its whole stroke to sit on tile. Interior cells never move.
   */
  function cellRing(cell: Cell, color: string, width: number, dashes: number[], phase = 0) {
    const { cell: c, ox, oy, cols, rows } = L;
    const side = c * 0.84;
    const clear = bevelBand(c) + width / 2;
    const x0 = ox + cell.c * c + c * 0.08, y0 = oy + cell.r * c + c * 0.08;
    const dx = slideInto(x0, side, ox + clear, ox + cols * c - clear);
    const dy = slideInto(y0, side, oy + clear, oy + rows * c - clear);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dashes);
    ctx.lineDashOffset = phase;
    rr(ctx, x0 + dx, y0 + dy, side, side, c * 0.2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * A mine ghost's compact action capsule: a near-opaque obsidian disc, a 1.5px high-contrast
   * hairline on its rim, a coloured inner chip, a bevel rim and a white glyph. The chip's own ramp
   * decides its colour — emerald for confirm, crimson for cancel (OK_RAMP / NO_RAMP) — so the pair
   * says yes/no the same way for every seat and on every board.
   *
   * The pair is painted over whatever tile it lands on, which may be a pawn wearing a turn halo or
   * a goal-glow rim. Three things keep it legible there: the disc is near opaque so no light bleeds
   * through it, the obsidian drop-shadow separates it from the tile, and the pale hairline is the
   * edge the eye actually finds — it reads as a control against a bright pawn and against dark clay.
   */
  function drawCapsule(cx: number, cy: number, kind: 'confirm' | 'cancel', ramp: Ramp, c: number, still: boolean) {
    const r = capR(c) * c;
    ctx.save();
    ctx.translate(cx, cy);
    /* the badge's lift: two soft obsidian passes under the disc instead of a shadow filter, so the
       control still separates from a glowing pawn without a per-frame gaussian on the GPU */
    const lift = Math.max(1, r * CAP_LIFT);
    ctx.fillStyle = 'rgba(2,5,12,.42)';
    ctx.beginPath(); ctx.arc(0, lift, r * 1.06, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(2,5,12,.2)';
    ctx.beginPath(); ctx.arc(0, lift, r * CAP_WASH, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(8,12,20,.93)';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    /* the 1.5px high-contrast hairline: the disc's own border, pale enough to cut a dark tile and
       riding the shadow on a bright one — the chip's bevel below never reaches it */
    ctx.strokeStyle = 'rgba(238,243,250,.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, r - 0.75, 0, TAU); ctx.stroke();
    /* the chip sits inside the rim with its own dark bevel, and the two never touch: the hairline
       is the edge the eye reads, so nothing is allowed to overpaint it */
    const chip = Math.max(2, r - Math.max(2.6, r * 0.22));
    ctx.fillStyle = ramp.mid;
    ctx.beginPath(); ctx.arc(0, 0, chip, 0, TAU); ctx.fill();
    ctx.strokeStyle = ramp.dark;
    ctx.lineWidth = Math.max(1.2, c * 0.04);
    ctx.beginPath(); ctx.arc(0, 0, chip, 0, TAU); ctx.stroke();
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
    /*
     * The tile rim: confirm wears a live emerald glow, cancel a dashed crimson warning. Both are
     * struck 2px inside the cell the disc owns — `border-box` + `inset: 2px` in canvas terms — so
     * neither can clip against a boundary wall or bleed over the next tile.
     */
    const rim = Math.min(r + 3, Math.max(r + 0.5, c * 0.5 - CAP_INSET));
    ctx.save();
    ctx.strokeStyle = ramp.mid;
    ctx.lineWidth = Math.max(1, c * 0.03);
    ctx.setLineDash(kind === 'cancel' ? [Math.max(2.5, c * 0.09), Math.max(2, c * 0.07)] : SOLID);
    ctx.globalAlpha = still ? 0.3 : 0.2 + 0.12 * Math.sin(performance.now() / 420);
    ctx.beginPath(); ctx.arc(0, 0, rim, 0, TAU); ctx.stroke();
    ctx.restore();
    ctx.restore();
  }

  /** The [✓]/[✕] pair a mine ghost keeps beside its square, laid out clear of every pawn. */
  function drawMineCapsules(ax: number, ay: number, blocked: readonly CapsuleOccupant[], still: boolean) {
    const lay = capsuleLayout(L, ax, ay, blocked);
    if (!lay) return;
    const { cell: c, ox, oy } = L;
    drawCapsule(ox + lay.confirm.x * c, oy + lay.confirm.y * c, 'confirm', OK_RAMP, c, still);
    drawCapsule(ox + lay.cancel.x * c, oy + lay.cancel.y * c, 'cancel', NO_RAMP, c, still);
  }

  /** Wall-toolbar key colours: semantics first — red cancels, cyan turns, green commits. */
  const TOOL_COLORS = {
    cancel: { light: '#fda4af', mid: '#e11d48', dark: '#881337', glow: 'rgba(244,63,94,.55)' },
    rotate: { light: '#a5f3fc', mid: '#0891b2', dark: '#155e75', glow: 'rgba(34,211,238,.55)' },
    confirm: { light: '#a7f3d0', mid: '#059669', dark: '#065f46', glow: 'rgba(16,185,129,.55)' },
  } as const;

  type ToolKind = keyof typeof TOOL_COLORS;

  /** One compact glass-toolbar key: a coloured lens, a crisp rim, and a proportional vector glyph. */
  function drawToolKey(cx: number, cy: number, kind: ToolKind, still: boolean, dim = false) {
    const r = TOOL_BTN / 2 - 1;
    const pal = TOOL_COLORS[kind];
    ctx.save();
    ctx.translate(cx, cy);
    if (dim) ctx.globalAlpha = 0.42;
    /* the lens's drop: two dark passes, no per-frame blur */
    ctx.fillStyle = 'rgba(2,6,14,.62)';
    ctx.beginPath(); ctx.arc(0, 1.5, r + 1, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(2,6,14,.26)';
    ctx.beginPath(); ctx.arc(0, 1.5, r + 2.5, 0, TAU); ctx.fill();
    const body = ctx.createRadialGradient(-r * 0.38, -r * 0.48, r * 0.08, 0, 0, r * 1.12);
    body.addColorStop(0, pal.light);
    body.addColorStop(0.46, pal.mid);
    body.addColorStop(1, pal.dark);
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.34)';
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.arc(0, 0, r - 0.4, 0, TAU); ctx.stroke();
    /* top lens highlight: the glass still reads as convex at this size */
    const sheen = ctx.createLinearGradient(0, -r, 0, r * 0.35);
    sheen.addColorStop(0, 'rgba(255,255,255,.4)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.beginPath(); ctx.arc(0, 0, r - 1, Math.PI, TAU); ctx.closePath(); ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,.97)';
    ctx.fillStyle = 'rgba(255,255,255,.97)';
    ctx.lineWidth = Math.max(1.45, r * 0.125);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (kind === 'cancel') {
      const g = r * 0.34;
      ctx.beginPath();
      ctx.moveTo(-g, -g); ctx.lineTo(g, g);
      ctx.moveTo(g, -g); ctx.lineTo(-g, g);
      ctx.stroke();
    } else if (kind === 'confirm') {
      ctx.beginPath();
      ctx.moveTo(-r * 0.42, r * 0.02);
      ctx.lineTo(-r * 0.1, r * 0.31);
      ctx.lineTo(r * 0.45, -r * 0.34);
      ctx.stroke();
    } else {
      const rad = r * 0.5;
      ctx.beginPath();
      ctx.arc(0, 0, rad, Math.PI * 0.35, Math.PI * 1.8);
      ctx.stroke();
      const a = Math.PI * 1.8;
      const ex = Math.cos(a) * rad, ey = Math.sin(a) * rad;
      const tx = -Math.sin(a), ty = Math.cos(a);
      const nx = Math.cos(a), ny = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(ex + tx * r * 0.28, ey + ty * r * 0.28);
      ctx.lineTo(ex + nx * r * 0.19 - tx * r * 0.03, ey + ny * r * 0.19 - ty * r * 0.03);
      ctx.lineTo(ex - nx * r * 0.19 - tx * r * 0.03, ey - ny * r * 0.19 - ty * r * 0.03);
      ctx.closePath();
      ctx.fill();
    }
    if (!still) {                                   // the keys breathe together, never apart
      ctx.globalAlpha = (dim ? 0.16 : 0.3) + 0.14 * Math.sin(performance.now() / 480);
      ctx.strokeStyle = pal.glow;
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.arc(0, 0, r + 2, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The floating wall toolbar: a glass pill with Cancel / Rotate / Confirm, parked clear of the
   * wall's centre (above it, or below when the top boundary would clip). None of the three touches
   * the ghost, so the whole two-tile preview and its glowing caps stay readable.
   */
  function drawWallToolbar(ax: number, ay: number, o: 'h' | 'v', ok: boolean, still: boolean) {
    const b = toolbarBox(L, ax, ay, o);
    const left = b.x - b.w / 2, top = b.y - b.h / 2;
    ctx.save();
    /* the glass is dark and translucent; two soft obsidian passes separate it from the clay tiles
       without asking the GPU for a blur every frame the ghost is up */
    ctx.fillStyle = 'rgba(3,7,15,.34)';
    rr(ctx, left - 1, top + 2, b.w + 2, b.h + 2, (b.h + 2) / 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(3,7,15,.16)';
    rr(ctx, left - 3, top + 4, b.w + 6, b.h + 6, (b.h + 6) / 2);
    ctx.fill();
    const glass = ctx.createLinearGradient(0, top, 0, top + b.h);
    glass.addColorStop(0, 'rgba(36,44,64,.78)');
    glass.addColorStop(0.52, 'rgba(17,23,38,.78)');
    glass.addColorStop(1, 'rgba(9,13,23,.84)');
    ctx.fillStyle = glass;
    rr(ctx, left, top, b.w, b.h, b.h / 2);
    ctx.fill();
    /* a frosted rim: bright catch-light above, cool hairline below */
    ctx.strokeStyle = 'rgba(255,255,255,.26)';
    ctx.lineWidth = 0.8;
    rr(ctx, left + 0.4, top + 0.4, b.w - 0.8, b.h - 0.8, (b.h - 0.8) / 2);
    ctx.stroke();
    const sheen = ctx.createLinearGradient(0, top, 0, top + b.h * 0.52);
    sheen.addColorStop(0, 'rgba(255,255,255,.16)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    rr(ctx, left + 1.4, top + 1.4, b.w - 2.8, b.h * 0.5, b.h * 0.25);
    ctx.fill();
    /* a short, subtle stem marks which wall the strip belongs to */
    ctx.strokeStyle = 'rgba(255,255,255,.28)';
    ctx.lineWidth = Math.max(1, b.h * 0.035);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(b.x, b.below ? top : top + b.h);
    ctx.lineTo(b.x, b.below ? top - 4 : top + b.h + 4);
    ctx.stroke();
    drawToolKey(toolKeyX(b, 0), b.y, 'cancel', still);
    drawToolKey(toolKeyX(b, 1), b.y, 'rotate', still);
    drawToolKey(toolKeyX(b, 2), b.y, 'confirm', still, !ok);
    ctx.restore();
  }

  /** Where a thrown ball comes to rest: a soft clay ring and a few motes. Dust, never fire. */
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

  /**
   * A wound is cosmetic, so it lives here rather than in `rules.ts`: the single `blast()` door
   * marks the ball the rules threw, and this watches the rules' own positions for the tiles it
   * leaves behind. `stride` is per ball, so the trail ages by that piece's own steps.
   */
  function observeTrail(v: View) {
    for (const b of v.state.balls) {
      const was = stood.get(b.id);
      if (!was) { stood.set(b.id, { c: b.pos.c, r: b.pos.r }); continue; }
      if (was.c === b.pos.c && was.r === b.pos.r) continue;
      const step = (stride.get(b.id) ?? 0) + 1;
      stride.set(b.id, step);
      if (wounds.has(b.id)) spill(b.id, was, b.pos, step);
      stood.set(b.id, { c: b.pos.c, r: b.pos.r });
    }
    for (let i = blood.length - 1; i >= 0; i--) {
      const d = blood[i];
      if ((stride.get(d.ball) ?? d.born) - d.born >= TRAIL_STEPS) blood.splice(i, 1);
    }
  }

  /** One to three droplets on every tile the piece just vacated; a side step sheds on its origin. */
  function spill(ball: number, from: Pos, to: Pos, step: number) {
    const cells: Pos[] = [from];
    if (from.c === to.c && Math.abs(to.r - from.r) > 1) {
      const dir = to.r > from.r ? 1 : -1;
      for (let r = from.r + dir; r !== to.r; r += dir) cells.push({ c: from.c, r });
    }
    for (const cell of cells) {
      const rand = rng32((Math.imul(ball + 1, 0x9e3779b1) ^ Math.imul(step, 0x85ebca6b)
        ^ Math.imul(cell.c * 17 + cell.r * 31 + 1, 0xc2b2ae35)) >>> 0);
      const n = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) {
        const a = rand() * TAU;
        const d = 0.07 + rand() * 0.23;
        blood.push({
          x: clamp(cell.c + 0.5 + Math.cos(a) * d, cell.c + 0.16, cell.c + 0.84),
          y: clamp(cell.r + 0.5 + Math.sin(a) * d * 0.82, cell.r + 0.16, cell.r + 0.84),
          v: Math.floor(rand() * 3),
          s: 0.75 + rand() * 0.5,
          ball, born: step,
        });
      }
    }
    /* keep each piece's last three gaits, never a carpet */
    let own = 0;
    for (let i = blood.length - 1; i >= 0; i--) {
      if (blood[i].ball !== ball) continue;
      if (++own > 24) blood.splice(i, 1);
    }
  }

  /** Past scars, newest embers: tile furniture, so it sits under walls, dots and balls. */
  function drawScars(v: View, now: number, still: boolean) {
    const art = decal;
    if (!art) return;
    const { cell: c, ox, oy } = L;
    const gap = Math.max(1, c * 0.03);
    const tw = Math.max(2, c - gap);
    for (const m of v.state.mines) {
      if (!m.triggered) continue;
      /* the rules flip the mine the moment the move is judged, but the charge only goes off when
         the ball has stepped onto it: while its blast is queued with a future `t0`, hold the
         crater back so the square is still intact under the approaching ball. */
      let pending = false;
      for (const f of blasts) {
        if (f.c === m.cell.c && f.r === m.cell.r && now < f.t0) { pending = true; break; }
      }
      if (pending) continue;
      ctx.drawImage(art.scorch[decalVariant(m.cell.c, m.cell.r)],
        ox + m.cell.c * c + gap / 2, oy + m.cell.r * c + gap / 2, tw, tw);
    }
    for (let i = embers.length - 1; i >= 0; i--) {
      const e = embers[i];
      const t = (now - e.t0) / EMBER_MS;
      if (t >= 1) { embers.splice(i, 1); continue; }
      if (t < 0) continue;                       // the blast has not gone off yet
      const anchors = art.embers[e.v];
      const x0 = ox + e.c * c + gap / 2, y0 = oy + e.r * c + gap / 2;
      const cool = (1 - t) * (1 - t);
      const size = c * 0.36;
      ctx.save();
      /* the smoulder stays inside the crater: no warmth is allowed to reach the tile's edge */
      ctx.beginPath(); ctx.arc(x0 + tw / 2, y0 + tw / 2, tw * 0.39, 0, TAU); ctx.clip();
      for (let k = 0; k < anchors.length; k++) {
        const flicker = still ? 1 : 0.78 + 0.22 * Math.sin(now / 90 + k * 2.3 + i);
        ctx.globalAlpha = 0.8 * cool * flicker;
        ctx.drawImage(art.ember, x0 + anchors[k].x * tw - size / 2,
          y0 + anchors[k].y * tw - size / 2, size, size);
      }
      ctx.restore();
    }
  }

  /** The blood trail: glossy fresh, dried and 60% on the previous gait, a faint third, then gone. */
  function drawBloodTrail() {
    const art = decal;
    if (!art || !blood.length) return;
    const { cell: c, ox, oy } = L;
    ctx.save();
    for (const d of blood) {
      const age = (stride.get(d.ball) ?? d.born) - d.born;
      if (age < 0 || age >= TRAIL_STEPS) continue;
      const img = (age === 0 ? art.wet : art.dry)[d.v] ?? art.wet[0];
      const w = c * 0.26 * d.s;
      ctx.globalAlpha = age === 0 ? 1 : age === 1 ? 0.6 : 0.24;
      ctx.drawImage(img, ox + d.x * c - w / 2, oy + d.y * c - w / 2, w, w);
    }
    ctx.restore();
  }

  /**
   * The winner's crown: two gold rings running out from the pawn, a breathing halo it keeps until
   * the result sheet lands, and a small crown struck over the ball. Pure vector paint — no layout,
   * no DOM, and every stroke stays inside the slab clip the frame already opened.
   */
  function drawFinishCrown(cx: number, cy: number, r: number, clock: number, still: boolean) {
    const el = clock;
    if (el < 0) return;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalCompositeOperation = 'lighter';
    /* the pulse: two passes of light, the second a beat behind the first */
    for (let k = 0; k < 2; k++) {
      const t = clamp((el - k * 180) / 780, 0, 1);
      if (t <= 0 || t >= 1) continue;
      const e = 1 - Math.pow(1 - t, 3);
      ctx.globalAlpha = 0.85 * (1 - t);
      ctx.strokeStyle = k === 0 ? 'rgba(255,226,150,.95)' : 'rgba(255,186,70,.8)';
      ctx.lineWidth = Math.max(1.4, r * 0.1 * (1 - t));
      ctx.beginPath(); ctx.arc(0, 0, r * (0.72 + 1.45 * e), 0, TAU); ctx.stroke();
    }
    /* the ring it keeps: a quiet gold ring breathing around the crowned pawn */
    const breathe = still ? 0.55 : 0.5 + 0.5 * Math.sin(clock / 240);
    ctx.globalAlpha = 0.3 + 0.34 * breathe;
    ctx.strokeStyle = 'rgba(255,220,140,.95)';
    ctx.lineWidth = Math.max(1.2, r * 0.055);
    ctx.beginPath(); ctx.arc(0, 0, r * 1.3, 0, TAU); ctx.stroke();
    /* the crown itself: three gold points over the ball's shoulder */
    const q = clamp(el / 320, 0, 1);
    const s = r * 0.6 * (0.55 + 0.45 * (1 - Math.pow(1 - q, 2)));
    ctx.globalAlpha = 0.92 * q;
    ctx.globalCompositeOperation = 'source-over';
    /* seated low enough that a winner on row 0 keeps its crown inside the slab */
    ctx.translate(0, -r * 0.7);
    /* the metal's warm bloom as its own radial pass — a shadow filter here re-blurs the glyph on
       every frame, which is exactly the cost the finisher cannot afford on a phone */
    if (crownG) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.45 * q;
      ctx.fillStyle = crownG;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = '#ffd97e';
    ctx.strokeStyle = 'rgba(90,48,8,.85)';
    ctx.lineWidth = Math.max(0.8, r * 0.035);
    ctx.beginPath();
    ctx.moveTo(-s, s * 0.5);
    ctx.lineTo(-s, -s * 0.42);
    ctx.lineTo(-s * 0.42, -s * 0.02);
    ctx.lineTo(0, -s * 0.72);
    ctx.lineTo(s * 0.42, -s * 0.02);
    ctx.lineTo(s, -s * 0.42);
    ctx.lineTo(s, s * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Every losing pawn's burst, plus the scorch it leaves. Scorch marks are painted first so the
   * debris sits on top of its own damage; each burst is a white-hot core inside a gold halo →
   * two expanding shock rings → obsidian shards and amber embers with drag and gravity, all inside
   * FINISH_BURST_MS. This is the frame's topmost board pass: a blast is never buried under a pawn,
   * a halo, a ring or a thinking pip.
   */
  function drawFinishFx(fin: FinishState, now: number, c: number, ox: number, oy: number) {
    const br = ballR(c);
    /* the flash's own reach, in css px: 28px on the smallest board, 34px on the largest */
    const flashR = Math.min(34, Math.max(28, c * 0.78));
    /* the charred tile: a dark coin with a dull ember rim, cooling off over FINISH_SCORCH_MS */
    for (const p of fin.pawns) {
      const t = (now - p.burstAt) / FINISH_SCORCH_MS;
      if (t < 0 || t >= 1) continue;
      if (!scorchG) continue;
      const fade = (1 - t) * (1 - t);
      ctx.save();
      ctx.translate(ox + p.cx * c, oy + p.cy * c);
      ctx.globalAlpha = 0.72 * fade;
      ctx.fillStyle = scorchG;
      ctx.beginPath(); ctx.arc(0, 0, c * 0.63, 0, TAU); ctx.fill();
      ctx.globalAlpha = 0.42 * fade;
      ctx.strokeStyle = 'rgba(255,132,54,.7)';
      ctx.lineWidth = Math.max(1, c * 0.022);
      ctx.beginPath(); ctx.arc(0, 0, c * (0.3 + 0.18 * (1 - t)), 0, TAU); ctx.stroke();
      ctx.restore();
    }

    for (const p of fin.pawns) {
      const el = now - p.burstAt;
      if (el < 0 || el >= FINISH_BURST_MS) continue;
      const t = el / FINISH_BURST_MS;
      const x = ox + p.cx * c, y = oy + p.cy * c;
      ctx.save();
      ctx.translate(x, y);
      ctx.globalCompositeOperation = 'lighter';

      /* the wide warm light a shattered pawn throws across its neighbours */
      if (blastGlow) {
        ctx.globalAlpha = 0.72 * (1 - t) * (1 - t);
        ctx.fillStyle = blastGlow;
        ctx.beginPath(); ctx.arc(0, 0, c * 2.1, 0, TAU); ctx.fill();
      }
      /* the flash: white hot enough to bleach the tile, seated in gold so it reads as fire.
         It is gone before the first ring is a third of the way out. */
      if (t < FINISH_FLASH) {
        const ft = t / FINISH_FLASH;
        const fe = 1 - (1 - ft) * (1 - ft);              // jumps out, then settles
        const r = flashR * (0.42 + 0.58 * fe);
        ctx.globalAlpha = (1 - ft) * 0.72;
        ctx.fillStyle = '#ffcf5e';
        ctx.beginPath(); ctx.arc(0, 0, r * 1.34, 0, TAU); ctx.fill();
        ctx.globalAlpha = (1 - ft) * 0.98;
        ctx.fillStyle = '#fff8e6';
        ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
      }
      /* the fireball the rings peel off from, dying as they clear the tile */
      if (t < FINISH_RING) {
        const q = t / FINISH_RING;
        ctx.globalAlpha = 0.44 * (1 - q);
        ctx.fillStyle = '#ff7a2a';
        ctx.beginPath(); ctx.arc(0, 0, br * (0.85 + 1.15 * q), 0, TAU); ctx.fill();
      }
      /* the shockwaves: gold out first, crimson on its heels, both to 2.8× the pawn's own radius */
      for (let k = 0; k < 2; k++) {
        const rt = clamp((t - k * 0.1) / FINISH_RING, 0, 1);
        if (rt <= 0 || rt >= 1) continue;
        const re = 1 - Math.pow(1 - rt, 2.6);
        ctx.globalAlpha = (1 - rt) * (k === 0 ? 1 : 0.72);
        ctx.strokeStyle = k === 0 ? 'rgba(255,226,150,1)' : 'rgba(255,92,38,.95)';
        ctx.lineWidth = Math.max(0.5, 3 * (1 - rt));
        ctx.beginPath();
        ctx.arc(0, 0, br * (0.25 + 2.55 * re) * (k === 0 ? 1 : 0.82), 0, TAU);
        ctx.stroke();
      }
      /* the debris: eighteen tumbling shards and six embers, all on fixed vectors */
      const ca = Math.cos(p.rot), sa = Math.sin(p.rot);
      for (let i = 0; i < SHARD_N; i++) {
        const q = clamp(el / (FINISH_BURST_MS * SHARD_LIFE[i]), 0, 1);
        if (q >= 1) continue;
        const dx = SHARD_C[i] * ca - SHARD_S[i] * sa;
        const dy = SHARD_C[i] * sa + SHARD_S[i] * ca;
        const ember = i % 3 === 0;
        /* embers are thrown hardest: they cross onto the neighbouring tiles, the shards stay near */
        const reach = c * (0.5 + (ember ? 0.95 : 0.7) * SHARD_V[i] * (1 - Math.pow(1 - q, 2.2)));
        const px = dx * reach;
        /* drag flattens the outward run; gravity takes over as the fleck cools */
        const py = dy * reach * 0.8 + c * 0.62 * q * q;
        if (ember) {
          const sz = EMBER_SZ[i / 3];
          const fade = 1 - q * q;
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.95 * (1 - q);
          ctx.strokeStyle = i % 2 === 0 ? '#ffe08a' : '#ff9448';
          ctx.lineCap = 'round';
          ctx.lineWidth = Math.max(1.4, sz * (1 - q * 0.55) * 0.8);
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px - dx * c * 0.95 * fade, py - dy * c * 0.95 * fade - c * 0.16);
          ctx.stroke();
          ctx.fillStyle = '#fff0c2';
          ctx.beginPath(); ctx.arc(px, py, sz * (1 - q * 0.35), 0, TAU); ctx.fill();
        } else {
          /* obsidian: an angular sliver tumbling along its own outward line, edge still burning */
          const len = SHARD_SZ[i];
          const wid = len * 0.36;
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 0.96 * (1 - q * q);
          ctx.fillStyle = '#141013';
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(p.rot + SHARD_SPIN[i] * q + Math.atan2(dy, dx));
          ctx.beginPath();
          ctx.moveTo(len, 0);
          ctx.lineTo(len * 0.12, wid);
          ctx.lineTo(-len * 0.55, wid * 0.35);
          ctx.lineTo(-len * 0.55, -wid * 0.35);
          ctx.lineTo(len * 0.12, -wid);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,158,74,.95)';
          ctx.lineWidth = Math.max(1, len * 0.14);
          ctx.stroke();
          ctx.restore();
        }
      }
      ctx.restore();
    }
  }

  /**
   * Does the board still owe the compositor a frame? Only FINITE transitions count here —
   * a queued detonation (whose `t0` may still be in the future), a throw, a tap ripple, a wall
   * pop-in, a scar cooling off, the arrival flare or the endgame finisher. Ambient breathing
   * (dots, halos, thinking pips) is deliberately NOT in this list: it is the thing that used to
   * keep a 60 fps loop burning over a completely static board.
   *
   * `draw()` calls this at both ends of a frame: at the start to decide whether the ambient clock
   * may advance, and at the end — after expired cues have been spliced out — to tell the caller
   * whether to arm another frame.
   */
  function fxPending(now: number): boolean {
    for (const f of ripples) if (now < f.t0 + RIPPLE_MS) return true;
    for (const f of pulses) if (now < f.t0 + 460) return true;
    /* `t0` is the detonation, AFTER the ball's walk onto the charge: a future t0 must keep the
       loop alive through that walk or the blast would never be painted. */
    for (const f of blasts) if (now < f.t0 + BLAST_MS) return true;
    for (const k of knocks) if (now < k.t0 + k.stepMs + k.flyMs) return true;
    for (const f of dust) if (now < f.t0 + DUST_MS) return true;
    for (const f of streaks) if (now < f.t0 + STREAK_MS) return true;
    for (const f of embers) if (now < f.t0 + EMBER_MS) return true;
    for (const [, t] of thump) if (now < t + THUMP_MS) return true;
    for (const [, w] of pendingWounds) if (now < w.when) return true;
    for (const [, t] of born) if (now < t + 220) return true;     // wall pop-in
    if (mineGhostKey !== '' && now < mineGhostAt + 220) return true;
    if (goalAt >= 0 && now < goalAt + GOAL_MS) return true;
    /* The arrival wait is resolved by the FIRST frame past its timeout, so keep the loop alive
       until draw() itself clears it — an off-by-one at exactly GOAL_WAIT_MS would park the loop
       one frame too early and the crown would never fire. */
    if (goalWait >= 0) return true;
    if (finish && !finish.settled) return true;
    return false;
  }

  /** Ambient pulses ride this clock, which only advances while a transition is running. */
  let ambientT = 0;
  let ambientLast = -1;

  /**
   * Paint one frame and report whether another is needed. `active` is the caller's own motion
   * (a pawn lerping between tiles, confetti in the air): it keeps the ambient clock alive so the
   * board still breathes during a move, without ever starting a loop on its own.
   */
  function draw(v: View, now: number, active = false): boolean {
    const pending = fxPending(now);
    if (pending || active) {
      if (ambientLast >= 0) ambientT += Math.min(50, Math.max(0, now - ambientLast));
      ambientLast = now;
    } else {
      ambientLast = -1;          // idle: freeze the breathing at its current phase, no jump on wake
    }
    /* One clock for every continuous sin()/dash pulse. When the board is idle it is frozen, so a
       single painted frame is enough and the main loop can stop entirely. */
    const clock = ambientT;
    /* Self-heal the fit ONLY when a reveal or resize asked for it. `clientWidth`/`clientHeight`
       used to be read on every frame; on a touch device that is a synchronous layout flush sixty
       times a second. The board's ResizeObserver, `settle()` and `scheduleSettle()` own every
       re-measure now, and `draw()` merely consumes the pending flag they raise. */
    if (!layoutReady || layoutCheck) {
      layoutCheck = false;
      if (!resize()) scheduleSettle();
    }
    /* The paint servers always exist, even before the first successful measurement: drawing a
       pawn must never dereference an undefined gradient and abort the whole frame. */
    if (!ballFx.length) buildStatic();
    const { cell: c, ox, oy } = L;
    const still = motionReduced();
    /* A finisher can only belong to a settled board. If a cue ever survived a restart, its
       "burst" would `continue` past a live pawn and drop it from the render queue entirely — the
       exact symptom of a board that shows its grid but no tokens on frame zero. It would also
       keep `fxPending()` true forever, because the finisher clock only advances while a winner
       is on the board: clear it so an idle board can genuinely park. */
    if (v.state.winner === null && finish) finish = null;
    const fin = v.state.winner === null ? null : finish;
    /*
     * The finisher runs on its own clock, advanced by this frame's CLAMPED delta. A settled match
     * is exactly when the main thread spikes — socket traffic, save writes, DOM prep — and a raw
     * 300ms gap would jump the explosion past its flash, its rings and half its shards. At most
     * 33ms per frame, every visible beat is painted; after a stall the sequence simply runs longer.
     * The first painted frame owns t=0, so the caller's sound beats line up with the picture.
     */
    let finNow = now;
    if (fin) {
      if (fin.lastFrame < 0) fin.lastFrame = now;
      else {
        fin.clock += Math.min(Math.max(0, now - fin.lastFrame), FINISH_DT_CAP);
        fin.lastFrame = now;
      }
      finNow = fin.clock;
    }
    /* a trigger's wound lands with the detonation, not with the step onto the charge: until then
       the ball is whole, and its trail is still growing from the square the charge sits on. */
    for (const [id, w] of pendingWounds) {
      if (now < w.when) continue;
      pendingWounds.delete(id);
      wounds.add(id);
      stood.set(id, { c: w.at.c, r: w.at.r });
    }
    observeTrail(v);
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
    /* A frame aborted mid-paint (or a stale tween) must never leave globalAlpha at 0 or a
       `lighter` composite behind: reset the two states that can make a whole pawn disappear,
       once per frame, before any furniture is drawn. */
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (boardBufferCanvas) ctx.drawImage(boardBufferCanvas, 0, 0);
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);

    /*
     * Everything below is board furniture — the start tints, walls, mines,
     * landing pulses, blast rings, the balls and their halos and rings, and the thinking pips. The
     * slab *is* the board, so none of it may paint outside the slab.
     *
     * This used to be free: the board filled its canvas edge to edge and the canvas clipped the
     * spill for us. Now the grid is centred inside a box of its own aspect, so a bottom-row ball's
     * selection ring (`r * 1.42`) and turn halo (`r * 1.5`) reach past the slab and float on the card
     * as a crimson arc under the board. One clip here covers every one of them.
     */
    ctx.save();
    rr(ctx, ox, oy, cols * c, rows * c, CORNER * c);
    ctx.clip();

    /* ---- the goal zone's own furniture: the crown's inscription and the light it wears ---- */
    const goal = goalAt >= 0 ? 1 - (now - goalAt) / GOAL_MS : -1;   // -1 = the crown is at rest
    if (goal <= 0) goalAt = -1;

    const bw = cols * c;
    /* No idle light sweep over the finish strip. It translated a full-width gradient across the
       goal band on EVERY frame forever — the single biggest reason a static board never reached
       an idle frame. The crown below is baked into the board buffer. */

    /* the inscription itself is baked into the board buffer; only the arrival flare is live paint */
    if (goal > 0 && crestArt) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = goal * 0.85;
      ctx.drawImage(crestArt, crestGeo.x, crestGeo.y, crestGeo.w, crestGeo.h);
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
      /* The travelling sweep is gone; the one-shot wash above is the whole arrival flare. */
      ctx.restore();
    }

    /* each team's own start squares glow in its colour, so a race reads from the bottom up */
    if (rows === ROWS && th.board.startTint > 0) {
      const key = `${v.state.cols}x${v.state.rows}:${v.state.teams.map((t) => t.balls).join(',')}`;
      if (key !== startKey) { startKey = key; starts = startBoard(v.state); }
      const tintA = th.board.startTint;
      const sw = c * 0.9, rad = c * 0.16, rimW = Math.max(1.5, c * 0.04);
      ctx.save();
      for (const s0 of starts) {
        const sprint = sides[s0.t].ramp;
        const sx = ox + s0.c * c + c * 0.05, sy = oy + s0.r * c + c * 0.05;
        ctx.globalAlpha = tintA;
        ctx.fillStyle = sprint.mid;
        rr(ctx, sx, sy, sw, sw, rad);
        ctx.fill();
        ctx.globalAlpha = Math.min(1, tintA * 2.2);
        ctx.save();
        ctx.translate(sx + sw / 2, sy + sw / 2);
        ctx.fillStyle = glowG[s0.t];
        ctx.beginPath(); ctx.arc(0, 0, c * 0.45, 0, TAU); ctx.fill();
        ctx.restore();
        ctx.globalAlpha = Math.min(1, tintA * 2.8);
        ctx.strokeStyle = sprint.light;
        ctx.lineWidth = rimW;
        rr(ctx, sx + rimW / 2, sy + rimW / 2, sw - rimW, sw - rimW, Math.max(0, rad - rimW / 2));
        ctx.stroke();
      }
      ctx.restore();
    }

    /* the surface the race has already marked: cold craters under the live traps, then the trail */
    drawScars(v, now, still);
    drawBloodTrail();

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
    const pulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(clock / 380);
    const dotR = Math.max(6, c * 0.17 + c * 0.014 * pulse);
    ctx.save();
    ctx.strokeStyle = th.board.pearl ? 'rgba(24,30,40,.78)' : 'rgba(255,255,255,.96)';
    ctx.lineWidth = Math.max(1.75, c * 0.045);
    /* the dots' glow: one radial pass struck with the board, not a shadow on every dot */
    const halo = dotG[v.state.turn];
    for (let i = 0; i < v.hints.length; i++) {
      const h = v.hints[i];
      const x = ox + (h.c + 0.5) * c, y = oy + (h.r + 0.5) * c;
      if (halo) {
        ctx.globalAlpha = 0.42 + 0.22 * pulse;
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(x, y, c * 0.62, 0, TAU); ctx.fill();
      }
      ctx.fillStyle = side.ramp.mid;
      ctx.globalAlpha = 0.1 + 0.06 * pulse;
      ctx.beginPath(); ctx.arc(x, y, dotR * 1.75, 0, TAU); ctx.fill();
      ctx.globalAlpha = 0.9 + 0.1 * pulse;
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
        drawBar(v.ghost.spec, v.ghost.p, v.ghost.armed ? 0.9 : 0.5, 1, true);
        outline(v.ghost.spec, v.ghost.armed ? gp.os : gp.ol,
          Math.max(1.5, c * 0.045), v.ghost.armed ? dash.armed : dash.ghost, still ? 0 : -clock / 26, v.ghost.p);
        drawGhostCaps(v.ghost.spec, v.ghost.p, v.ghost.armed ? 0.95 : 0.5, still);
      } else {
        // solid ring + cross: unmistakably "not here", unlike the dashed ghost above
        drawBar(v.ghost.spec, ERR, 0.3, 1, false);
        outline(v.ghost.spec, 'rgba(255,45,85,.95)', Math.max(2, c * 0.06), SOLID, 0, ERR);
        cross(v.ghost.spec, '#fff', c * 0.19);
      }
    }

    // the cell already tapped in the two-tap mine flow, standing by for its confirm tap
    if (v.mineGhost) {
      const key = `${v.mineGhost.c},${v.mineGhost.r}`;
      if (key !== mineGhostKey) { mineGhostKey = key; mineGhostAt = now; }
      const p = still ? 1 : Math.min(1, (now - mineGhostAt) / 220);
      const drop = 1 + 0.55 * (1 - p) * (1 - p);        // it drops into the square and settles
      const gp = sides[v.state.turn].ramp;
      cellRing(v.mineGhost, gp.os, Math.max(1.5, c * 0.045), dash.armed, still ? 0 : -clock / 26);
      drawMine(ox + (v.mineGhost.c + 0.5) * c, oy + (v.mineGhost.r + 0.5) * c, 'ghost', pulse, drop, clock, still);
      /* the square and its mine stay board furniture; the ✓/✕ pair is chrome, painted once the
         clip has closed, so an adjacent pawn can never be drawn over it */
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
    const mineK = still ? 0.5 : 0.5 + 0.5 * Math.sin(clock / 520);
    for (const m of v.state.mines) {
      if (m.owner !== v.human) continue;
      /* a triggered mine stays in the ground until its blast's own `t0`, so the ball walks onto a
         live charge and the charge is what disappears under the flash */
      let pending = false;
      if (m.triggered) {
        for (const f of blasts) if (f.c === m.cell.c && f.r === m.cell.r && now < f.t0) { pending = true; break; }
        if (!pending) continue;
      }
      drawMine(ox + (m.cell.c + 0.5) * c, oy + (m.cell.r + 0.5) * c, 'buried', mineK, 1, clock, still);
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
     * The trigger: a white flash, a warm core, one expanding shockwave, amber sparks and a ring of
     * smoke, all inside BLAST_MS. The ring stays in the mine's own warning red — the board surface
     * may be pale, and a mine must never read as a team colour. Reduced motion keeps the flash and
     * the ring, drops the sparks and the smoke.
     */
    for (let i = blasts.length - 1; i >= 0; i--) {
      const f = blasts[i];
      const t = (now - f.t0) / BLAST_MS;
      if (t >= 1) { blasts.splice(i, 1); continue; }
      if (t < 0) continue;                       // Stage 1 still owns the board: the ball is walking on
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
        ctx.beginPath(); ctx.arc(0, 0, c * 1.4, 0, TAU); ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 0.85 * (1 - t);
      ctx.strokeStyle = MINE_RAMP.mid;
      ctx.lineWidth = Math.max(1.5, c * 0.11 * (1 - t));
      ctx.beginPath(); ctx.arc(f.x, f.y, c * (0.4 + 1.9 * ease), 0, TAU); ctx.stroke();
      if (!still) {
        /* the smoke ring, thrown with the sparks and thinning into the clay */
        if (decal) {
          const sw = c * 0.95;
          for (let n = 0; n < 6; n++) {
            const a = (n / 6) * TAU + 0.5;
            const d = c * (0.32 + 1.05 * ease);
            ctx.globalAlpha = 0.17 * (1 - t) * (1 - t);
            ctx.drawImage(decal.smoke, f.x + Math.cos(a) * d - sw / 2,
              f.y + Math.sin(a) * d * 0.72 - c * 0.4 * ease - sw / 2, sw, sw);
          }
        }
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(1, c * 0.05 * (1 - t));
        const fan = (warm: boolean) => {
          ctx.beginPath();
          for (let n = 0; n < SPARK_N; n++) {
            if ((n % 3 === 0) !== warm) continue;
            const r0 = c * (0.3 + 1.2 * ease) * SPARK_L[n];
            const r1 = r0 + c * 0.45 * (1 - t) * SPARK_L[n];
            ctx.moveTo(f.x + SPARK_C[n] * r0, f.y + SPARK_S[n] * r0);
            ctx.lineTo(f.x + SPARK_C[n] * r1, f.y + SPARK_S[n] * r1);
          }
          ctx.stroke();
        };
        ctx.globalAlpha = 0.85 * (1 - t);
        ctx.strokeStyle = MINE_RAMP.light;
        fan(false);
        ctx.strokeStyle = '#f59e0b';
        fan(true);
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
    for (let i = knocks.length - 1; i >= 0; i--) {
      const k = knocks[i];
      if (now - k.t0 >= k.stepMs + k.flyMs) knocks.splice(i, 1);
    }
    /* ---- per-frame fallback guard: never let a pawn leave the render queue ----
       A visual coordinate can desynchronise from the rules when a race is restarted mid-tween, a
       resize lands between two frames, or an interpolated value goes non-finite. Heal it from the
       LOGICAL ball (by id, not index) before the depth sort, so a NaN can neither scramble the
       paint order nor reach `continue`. The cell-space centre below is exactly what
       `tileToCanvas()` converts to pixels when the ball is drawn. */
    const logical = v.state.balls;
    for (let i = 0; i < v.balls.length; i++) {
      const b = v.balls[i];
      if (!b) {
        const src = logical[i];
        if (src) v.balls[i] = { pos: { x: src.pos.c + 0.5, y: src.pos.r + 0.5 }, team: src.team, id: src.id, sel: false };
        continue;
      }
      const p = b.pos;
      const bad = !p || !Number.isFinite(p.x) || !Number.isFinite(p.y)
        || p.x < -0.5 || p.y < -0.5 || p.x > L.cols + 0.5 || p.y > L.rows + 0.5;
      if (!bad) continue;
      const src = logical.find((s) => s.id === b.id) ?? logical[i];
      b.pos = src
        ? { x: src.pos.c + 0.5, y: src.pos.r + 0.5 }
        : { x: 0.5, y: 0.5 };
    }
    SEATS_N.fill(0);
    for (const b of v.balls) if (b.team < SEAT_COUNT) SEATS_N[b.team]++;
    ORDER.length = 0;
    for (let i = 0; i < v.balls.length; i++) ORDER.push(i);
    ORDER.sort((a, b) => v.balls[a].pos.y - v.balls[b].pos.y);
    for (const i of ORDER) {
      const b = v.balls[i];
      const seat = b.team;
      /* the finisher's own pawn: once its burst begins, the ball is gone — the debris takes over */
      const pawn = fin ? fin.byId.get(b.id) : undefined;
      if (pawn && finNow >= pawn.burstAt) continue;
      /* a ball the mine is throwing rides its own arc: onto the charge, then up and over the wall.
         The state's own slide lands underneath it, so the takeover at either end is seamless. */
      /* A chain keeps one arc per beat in the queue: the FIRST unexpired one is the active throw,
         because the beats were pushed in time order and their windows abut. A beat whose `t0` is a
         hair in the future still owns the ball (the clamp below parks it on `from`), which keeps
         the rAF timestamp — occasionally a millisecond behind performance.now() — from dropping a
         pawn onto its final square for one frame. */
      const kn = still ? undefined : knocks.find((k) =>
        k.id === b.id && now - k.t0 < k.stepMs + k.flyMs);
      let cx = ox + b.pos.x * c, cy = oy + b.pos.y * c;
      if (kn) {
        const el = Math.max(0, now - kn.t0);
        if (el <= kn.stepMs) {
          /* Stage 1: a smoothstep walk from the old square into the centre of the charge, so the
             ball is unmistakably standing on the mine before the blast is drawn. A chain's later
             beats have `stepMs === 0`: the previous throw has ALREADY landed the ball here. */
          const q = kn.stepMs > 0 ? clamp(el / kn.stepMs, 0, 1) : 1;
          const e = q * q * (3 - 2 * q);
          cx = ox + (kn.from.c + (kn.mine.c - kn.from.c) * e + 0.5) * c;
          cy = oy + (kn.from.r + (kn.mine.r - kn.from.r) * e + 0.5) * c;
        } else {
          /* Stage 3: the throw, immediately after the flash, to the resolved landing square. */
          const q = kn.flyMs > 0 ? clamp((el - kn.stepMs) / kn.flyMs, 0, 1) : 1;
          const x = kn.mine.c + (kn.to.c - kn.mine.c) * q + 0.5;
          const y = kn.mine.r + (kn.to.r - kn.mine.r) * q + 0.5 - KNOCK_ARC * Math.sin(Math.PI * q);
          cx = ox + x * c;
          cy = oy + y * c;
        }
      }
      /* a pawn on the way out: the last 280ms before its burst are a violent ±5px overheat jitter,
         driven by two out-of-phase harmonics so the shake never settles into a steady wobble */
      let shakeEl = -1;
      if (pawn) {
        shakeEl = finNow - (pawn.burstAt - FINISH_SHAKE_MS);
        if (shakeEl >= 0) {
          const ramp = Math.min(1, shakeEl / 48);
          cx += (Math.sin(shakeEl * 0.23) + Math.sin(shakeEl * 0.61) * 0.32) * FINISH_JITTER * ramp;
          cy += (Math.cos(shakeEl * 0.19) + Math.sin(shakeEl * 0.53) * 0.26) * FINISH_JITTER * ramp;
        }
      }
      /* Last line of defence: a stale knock tween, a finisher jitter or an aborted interpolation
         can still push the drawn centre to NaN or off the canvas. Snap it back to the logical
         tile's canvas centre (and heal the view for the next frame) rather than skipping the pawn. */
      if (!Number.isFinite(cx) || !Number.isFinite(cy)
        || cx < -c || cy < -c || cx > L.w + c || cy > L.h + c) {
        const src = logical.find((s) => s.id === b.id);
        if (src) {
          const at = tileToCanvas(src.pos.c, src.pos.r);
          cx = at.x; cy = at.y;
          b.pos.x = src.pos.c + 0.5; b.pos.y = src.pos.r + 0.5;
        } else {
          const at = tileToCanvas(0, 0);
          cx = at.x; cy = at.y;
        }
      }
      const crowned = fin !== null && b.id === fin.winnerBall;
      let r = ballR(c) * (b.sel ? 1.08 : 1);          // the chosen ball lifts off the clay
      if (pawn && shakeEl >= 0) r *= 1 + 0.09 * Math.min(1, shakeEl / FINISH_SHAKE_MS);
      if (crowned && fin) {
        /* the winner rises to 1.18× and stays there, under the crown */
        const q = clamp(finNow / FINISH_ASCEND_MS, 0, 1);
        r *= 1 + FINISH_ASCEND_SCALE * (1 - Math.pow(1 - q, 3));
      }
      /* A zero or NaN radius is an invisible pawn. No spawn tween, stale scale lock or degenerate
         cell is allowed to take a token off the board: clamp to a strictly positive base radius. */
      if (!Number.isFinite(r) || r <= 0) r = Math.max(1, ballR(c));
      /* the tail it is dragging right now: sampled from where it stood last frame. A ball riding
         the mine's throw draws no comet: its path is the arc, and a straight streak from the old
         square to the landing would give the whole throw away before the blast. */
      const was = prevPos.get(b.id);
      if (was) {
        if (!still && !kn) {
          const dx = b.pos.x - was.x, dy = b.pos.y - was.y;
          if (dx * dx + dy * dy > 0.0004) {
            streaks.push({ x0: was.x, y0: was.y, x1: b.pos.x, y1: b.pos.y, t0: now, p: seat });
            if (streaks.length > 96) streaks.shift();
          }
        }
        was.x = b.pos.x; was.y = b.pos.y;
      } else prevPos.set(b.id, { x: b.pos.x, y: b.pos.y });
      const active = v.state.winner === null && v.state.turn === seat;
      const lit = active || v.state.winner === seat;
      const beat = still ? 0.6 : 0.5 + 0.5 * Math.sin(clock / 260);
      drawLamp(cx, cy, seat, lit ? beat : 0);
      if (crowned && crownG) {
        /* gold light pooled under the winner: the crown's own warmth on the goal tile */
        ctx.save();
        ctx.translate(cx, cy);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = still ? 0.6 : 0.55 + 0.24 * Math.sin(finNow / 230);
        ctx.fillStyle = crownG;
        ctx.beginPath(); ctx.arc(0, 0, ballR(c) * 2.9, 0, TAU); ctx.fill();
        ctx.restore();
      }
      if (pawn && shakeEl >= 0 && heatG) {
        /* the overheat: burning orange through the core, crimson at the rim, and the aura is the
           countdown — it climbs and flickers to a white-hot frame the instant before the burst */
        const heat = Math.min(1, shakeEl / FINISH_SHAKE_MS);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = (0.5 + 0.5 * heat) * (0.9 + 0.1 * Math.sin(shakeEl * 0.42));
        ctx.fillStyle = heatG;
        ctx.beginPath(); ctx.arc(0, 0, ballR(c) * (2.6 + 0.7 * heat), 0, TAU); ctx.fill();
        ctx.globalAlpha = 0.46 * heat;
        ctx.fillStyle = 'rgba(255,166,60,.9)';
        ctx.beginPath(); ctx.arc(0, 0, ballR(c) * 0.92, 0, TAU); ctx.fill();
        ctx.restore();
      }
      if (vipSeats.has(seat)) drawVipAura(cx, cy, r, clock, still);
      if (lit) drawGlow(cx, cy, r, seat, beat);
      const hurt = wounds.has(b.id);
      if (hurt) drawWoundedRing(cx, cy, r, clock, still);
      // the chosen one stands out further than its side's turn halo does
      if (b.sel) drawSel(cx, cy, r, seat, clock, still);
      let n = 1;
      for (let j = 0; j < i; j++) if (v.balls[j].team === seat) n++;
      /* a ball the mine has just thrown settles with a micro-bounce rather than simply stopping */
      const th = thump.get(b.id);
      let sq = 0;
      if (th !== undefined) {
        const k = (now - th) / THUMP_MS;
        if (k >= 1) thump.delete(b.id);
        else if (k >= 0) sq = Math.sin(k * Math.PI * 2.4) * (1 - k) * 0.13;
      }
      if (sq !== 0) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1 + sq, 1 - sq);
        ctx.translate(-cx, -cy);
      }
      /* Full opacity for every token, whatever the furniture painted before it left behind. */
      ctx.globalAlpha = 1;
      drawBall(cx, cy, r, seat, SEATS_N[seat] > 1 ? n : 0, hurt);
      if (sq !== 0) ctx.restore();
      if (crowned && fin) drawFinishCrown(cx, cy, r, finNow, still);
    }

    /* mine-blast dust: the puff a thrown ball kicks up where it comes to rest */
    if (dust.length) {
      ctx.save();
      rr(ctx, ox, oy, cols * c, rows * c, CORNER * c);
      ctx.clip();
      for (let i = dust.length - 1; i >= 0; i--) {
        if (now - dust[i].t0 >= DUST_MS) { dust.splice(i, 1); continue; }
        drawDust(dust[i], now, c, still);
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
          const ph = still ? 0.6 : 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(clock / 260 - i * 1.1));
          ctx.globalAlpha = Math.min(1, ph);
          ctx.beginPath(); ctx.arc(x0 + (i - 1) * c * 0.22, y0, c * 0.06, 0, TAU); ctx.fill();
        }
        ctx.restore();
      }
    }

    /*
     * The losers' bursts and the charred tiles they leave are the LAST board pass, above the dust
     * and the thinking pips: a detonation must never read as though it happened behind a pawn. It
     * stays inside the slab clip, so the bloom and the debris can spill over the neighbouring tiles
     * but never off the board.
     */
    if (fin) drawFinishFx(fin, finNow, c, ox, oy);

    ctx.restore();                     // the slab clip opened at the top of this frame

    /* The wall toolbar is chrome, not board furniture: it floats above the clip so its glass edge
       can ride over the slab rim instead of being cut off by it. */
    if (v.ghost?.armed) {
      const centre = wallCentre(v.ghost.spec);
      drawWallToolbar(centre.x, centre.y, v.ghost.spec.o, v.ghost.ok, still);
    }

    /*
     * The mine ghost's ✓/✕ pair is chrome as well, and it is the LAST pass of the frame. Each disc
     * owns one whole tile — either side of the armed square, or stacked in a boundary column — and
     * the layout is filtered against every pawn before it is drawn. A control the player is being
     * told to tap can therefore never be buried under a piece, and painting the pair here, after
     * the slab clip and after every ball, keeps it above the aura rings, wall posts and the fog.
     *
     * The pair is only painted while its own hit target is armed (`capsule`), so a drawn badge is
     * always a live one — never a disc the tap falls through.
     */
    if (v.mineGhost && v.capsule?.hit.kind === 'mine-confirm') {
      capsuleBlocked.length = 0;
      for (const b of v.state.balls) capsuleBlocked.push(b.pos);
      drawMineCapsules(v.mineGhost.c + 0.5, v.mineGhost.r + 0.5, capsuleBlocked, still);
    }

    /* The picture is finished: only now may the caller open the result sheet. The finisher clock
       is authoritative, so a wall-clock hiccup can never cut the last explosion short. */
    if (fin && !fin.settled && fin.clock >= fin.total) {
      fin.settled = true;
      opts.onFinishSettled?.();
    }

    /* Recomputed AFTER this frame's expired cues were spliced out: when the board is settled this
       is false and the caller parks the loop immediately. No idle frame is ever requested. */
    return fxPending(now);
  }

  return {
    resize,
    /** Force a re-fit now plus one deferred verification frame (match entry / container resize). */
    settle,
    /** Canvas-pixel centre of a logical tile; the fallback guard's single source of truth. */
    tileToCanvas,
    /** True only after a measurement came from a mounted, non-zero container. */
    hasLayout: () => layoutReady,
    draw,
    layout: () => L,
    /**
     * Point the renderer at a board of a different size. The rules pick the grid from the number of
     * contenders, so the race screen hands the board over on every `restart()`. Every call also
     * re-measures (the container may have changed while hidden) and arms one deferred verification
     * frame; a genuinely unchanged, visible box costs one rebuild per race, not per frame.
     */
    setBoard(c: number, r: number) {
      cols = c; rows = r;
      /* Keep `layout()`'s own grid in step even while the container is unmeasurable: every caller
         that reads it between `restart()` and the reveal must see THIS race's columns and rows. */
      L = computeLayout(L.w, L.h, L.dpr, cols, rows);
      /* A new race is a new measurement, even when the grid did not change: the previous race's
         cached size may have been taken from a hidden or mid-reflow container. The deferred pass
         catches the reveal, which can land several frames after `restart()`. */
      lastW = -1; lastH = -1; lastDpr = -1;
      const ok = resize();
      scheduleSettle();
      return ok;
    },
    resetFx: () => {
      /* No tween, alpha or composite from the previous match may greet the first frame of this
         one. Context state is reset here as well as at the top of draw(). */
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      born.clear(); pulses.length = 0; blasts.length = 0; knocks.length = 0;
      ripples.length = 0; streaks.length = 0; prevPos.clear(); mineGhostKey = '';
      dust.length = 0; thump.clear();
      embers.length = 0; stride.clear(); wounds.clear(); pendingWounds.clear(); stood.clear(); blood.length = 0;
      goalAt = -1; goalWait = -1; goalSeat = null;
      finish = null;
    },
    /**
     * Start the endgame finisher: crown the winning pawn, then shake and shatter every losing pawn
     * in the order it was handed over. The caller decides that order (farthest from the line
     * first); the renderer resolves the beats on its own clock and hands back the plan the caller
     * schedules its bangs and buzzes against.
     *
     * The choreography plays under every motion setting — a battery saver on Android flips the OS
     * reduced-motion flag as a side effect, and the end of a race is gameplay feedback, not
     * decoration. An empty losers list is the only thing that cancels it, because there is no
     * explosion to stage.
     */
    finishCue(winnerBall: number | null, losers: readonly FinishLoser[]): FinishPlan {
      if (!losers.length) {
        finish = null;
        return { bursts: [], total: 0 };
      }
      const pawns: FinishPawn[] = [];
      const byId = new Map<number, FinishPawn>();
      const bursts: number[] = [];
      for (let i = 0; i < losers.length; i++) {
        const l = losers[i];
        const at = FINISH_LEAD_MS + i * FINISH_STAGGER_MS + FINISH_SHAKE_MS;
        const pawn: FinishPawn = {
          id: l.id,
          cx: l.cell.c + 0.5,
          cy: l.cell.r + 0.5,
          /* relative to the finisher's clock, which starts on its first painted frame */
          burstAt: at,
          rot: i * 0.7 + (l.id % 7) * 0.13,
        };
        pawns.push(pawn);
        byId.set(l.id, pawn);
        bursts.push(at);
      }
      const last = bursts[bursts.length - 1] ?? 0;
      const total = last + FINISH_BURST_MS + FINISH_SETTLE_MS;
      finish = { winnerBall, clock: 0, lastFrame: -1, total, settled: false, pawns, byId };
      return { bursts, total };
    },
    /** Cancel a finisher that has not finished: every pawn whole again, no debris, no crown. */
    cancelFinish() { finish = null; },
    /** A tap landed: a ripple where the finger was, in the seat's own colour. Board units. */
    ripple(x: number, y: number, p: Player) {
      const { cell: c, ox, oy } = L;
      ripples.push({ x: ox + x * c, y: oy + y * c, t0: performance.now(), p });
      if (ripples.length > 12) ripples.shift();
    },
    /**
     * Queue the trigger for a mine that just went off, plus the throw it puts on the ball that set
     * it off. The caller owns the moment (only it knows a trigger happened), the frame loop owns
     * the paint: the ball steps onto the charge, the charge goes off under it, and the throw arcs
     * over whatever wall stands under it to the resolved landing. The flash, sparks and crater are
     * queued for the end of the step, not the start of the move, so nothing explodes before the
     * ball is visibly standing on the mine. Returns how long that step takes, in ms, so the caller
     * can land the sound and the haptic buzz with the detonation itself (0 when there is no throw
     * to wait for, or motion is reduced).
     */
    blast(at: Cell, knock?: { id: number; from: Pos; to: Pos }): number {
      const { cell: c, ox, oy } = L;
      const now = performance.now();
      const thrown = !!knock && (knock.from.c !== knock.to.c || knock.from.r !== knock.to.r);
      const delay = thrown && !motionReduced() ? KNOCK_STEP_MS : 0;
      const t0 = now + delay;
      blasts.push({ x: ox + (at.c + 0.5) * c, y: oy + (at.r + 0.5) * c, t0, c: at.c, r: at.r });
      embers.push({ c: at.c, r: at.r, t0, v: decalVariant(at.c, at.r) });
      if (knock) {
        /* the ball that set the charge off is the one the rules threw — it takes its wound when
           the charge goes off. The state jumps from its last square straight to the landing, so
           the wound's first footprint is planted on the charge itself, not on the square it
           stepped from before the blast. */
        pendingWounds.set(knock.id, { at: { c: at.c, r: at.r }, when: t0 });
        if (thrown) {
          for (let i = knocks.length - 1; i >= 0; i--) if (knocks[i].id === knock.id) knocks.splice(i, 1);
          knocks.push({
            id: knock.id, from: knock.from, mine: at, to: knock.to, t0: now,
            stepMs: KNOCK_STEP_MS, flyMs: KNOCK_FLY_MS,
          });
          dust.push({ x: ox + (knock.to.c + 0.5) * c, y: oy + (knock.to.r + 0.5) * c, t0: t0 + KNOCK_FLY_MS });
          thump.set(knock.id, t0 + KNOCK_FLY_MS);
        }
      }
      return delay;
    },
    /**
     * Queue a CHAIN of detonations on ONE clock, so the player actually watches the pawn get thrown
     * off one charge onto the next and blown back again.
     *
     * Beat 0 keeps the classic walk-onto-the-charge — the first boom is not a jump cut. Every later
     * charge goes off one `CHAIN_STAGGER_MS` after the previous one, EXACTLY on the frame its throw
     * lands the ball on that square; the final throw gets the full, slower `KNOCK_FLY_MS` arc. Each
     * cell keeps its own flash, sparks, embers, dust and permanent crater (`drawScars` holds each
     * scar back until that beat's `t0`).
     *
     * Returns each detonation's offset from now in ms, in the order handed over, so the caller can
     * land a bang, a haptic buzz and the heavy shake on every beat. Reduced motion collapses every
     * offset to 0: all scars paint at once, no arcs and no stagger.
     */
    blastChain(beats: readonly BlastBeat[]): number[] {
      const { cell: c, ox, oy } = L;
      const now = performance.now();
      const still = motionReduced();
      const offsets: number[] = [];
      if (!beats.length) return offsets;
      const first = beats[0].knock;
      const thrown = !!first && (first.from.c !== first.to.c || first.from.r !== first.to.r);
      const lead = thrown && !still ? KNOCK_STEP_MS : 0;
      const stagger = still ? 0 : CHAIN_STAGGER_MS;
      /* One ball, one timeline: a chain replaces any throw still in flight, then owns every beat. */
      const ids = new Set<number>();
      for (const beat of beats) if (beat.knock) ids.add(beat.knock.id);
      for (let i = knocks.length - 1; i >= 0; i--) if (ids.has(knocks[i].id)) knocks.splice(i, 1);
      for (let i = 0; i < beats.length; i++) {
        const beat = beats[i];
        const knock = beat.knock;
        const last = i === beats.length - 1;
        /* beat 0 walks onto the charge; every later beat starts with the ball already there,
           carried by the previous throw — hence `stepMs === 0` and `arcStart === boomAt`. */
        const boomAt = now + lead + i * stagger;
        const arcStart = i === 0 ? now : boomAt;
        const stepMs = i === 0 ? lead : 0;
        const flyMs = last ? (still ? 0 : KNOCK_FLY_MS) : stagger;
        blasts.push({
          x: ox + (beat.at.c + 0.5) * c, y: oy + (beat.at.r + 0.5) * c,
          t0: boomAt, c: beat.at.c, r: beat.at.r,
        });
        embers.push({ c: beat.at.c, r: beat.at.r, t0: boomAt, v: decalVariant(beat.at.c, beat.at.r) });
        /* The first charge wounds the pawn; the rest keep throwing an already-wounded ball, so the
           trail's first footprint stays on the square where the chain began. */
        if (i === 0 && knock) {
          pendingWounds.set(knock.id, { at: { c: beat.at.c, r: beat.at.r }, when: boomAt });
        }
        if (knock && !still) {
          knocks.push({
            id: knock.id, from: knock.from, mine: beat.at, to: knock.to,
            t0: arcStart, stepMs, flyMs,
          });
          dust.push({
            x: ox + (knock.to.c + 0.5) * c, y: oy + (knock.to.r + 0.5) * c, t0: boomAt + flyMs,
          });
          if (last) thump.set(knock.id, boomAt + flyMs);
        }
        offsets.push(boomAt - now);
      }
      return offsets;
    },
    /** Equipping repaints the board and every cached gradient once; never per frame. */
    setTheme(t: Theme) {
      if (t.ball === th.ball && t.wall === th.wall && t.board === th.board) return;
      th = t;
      sides = seats(t);
      buildStatic();
    },
    /**
     * Repaint this client's two sides in its own red/blue perspective. Purely visual: the rules,
     * the seats and the turn order are untouched. Passing null restores the authored seat colours
     * for a preview.
     */
    setPerspective(p: Perspective | null) {
      const same = (!p && !perspective)
        || (!!p && !!perspective && p.local === perspective.local
          && p.rival === perspective.rival && p.color === perspective.color);
      if (same) return;
      perspective = p ? { ...p } : null;
      sides = seats(th);
      buildStatic();
    },
    /** The seats that wear the gold VIP halo. Cheap to call: a change repaints on the next frame. */
    setVipSeats(seatsWithVip: readonly Player[]) {
      const next = new Set(seatsWithVip);
      if (next.size === vipSeats.size && [...next].every((seat) => vipSeats.has(seat))) return;
      vipSeats = next;
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
