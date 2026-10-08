/**
 * render.ts — Canvas 2D drawing + pointer → board hit-testing.
 * All sizes derive from `cell`, so the look scales to any phone.
 *
 * Nothing here owns a colour: balls, walls and the board itself are drawn from the `Theme` data in
 * `themes.ts` (see `setTheme`). The renderer also paints the shop's miniature boards — pass `cols`
 * and `rows` and it lays out that patch of board instead of a whole race, so a preview card shows
 * the same code path the race uses rather than a picture of it.
 */
import { COLS, ROWS, type GameState, type Player, type Pos, type Wall, type WallSpec } from './rules';
import { motionReduced } from './settings';
import {
  BOT_RAMP, CLASSIC_BALL, CLASSIC_WALL, DEFAULT_THEME, ERR_RAMP,
  type BallSkin, type CosKind, type Ramp, type Stop, type Theme, type WallStyle,
} from './themes';

export interface Vec { x: number; y: number }

/** Wall ghost under construction. `armed` = already tapped once, waiting for a confirm tap. */
export interface Ghost { spec: WallSpec; ok: boolean; armed: boolean; p: Player }

/** What a player did last, so both sides' moves stay readable. */
export type Mark = { kind: 'step'; from: Pos; to: Pos } | { kind: 'wall'; spec: WallSpec };

export interface View {
  state: GameState;
  balls: [Vec, Vec];        // animated centres, in cell units (col + .5, row + .5)
  hints: Pos[];             // legal move cells
  ghost: Ghost | null;      // wall preview / armed ghost
  last: [Mark | null, Mark | null];
  thinking: boolean;        // opponent is deciding
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

export type Hit =
  | { kind: 'confirm'; spec: WallSpec }
  | { kind: 'wall'; spec: WallSpec }
  | { kind: 'move'; to: Pos };

const TAU = Math.PI * 2;
const LINE_ZONE = 0.3;  // cells from a grid line that still read as "aiming at that line"
const MIN_TOUCH = 44;   // css px: smallest legal-move tap target we allow
const ERR = 2;          // third side: an illegal slot
const SOLID: number[] = [];

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
  if (Math.min(dh, dv) > LINE_ZONE) return null;
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

/**
 * Pointer (CSS px, canvas-local) → the thing to act on.
 * Priority, not raw distance: an armed ghost confirms, a tap inside a legal cell moves,
 * a tap that lands on a grid line arms a wall. A 44px dot target and a 0.3-cell line band
 * cannot both fit in a 37px cell, so the cell the dot sits in always wins for the dot.
 */
export function hitTest(L: Layout, px: number, py: number, o: {
  hints: Pos[]; armed: WallSpec | null;
}): Hit | null {
  const c = L.cell;
  if (c <= 0) return null;
  const bx = (px - L.ox) / c, by = (py - L.oy) / c;
  if (bx < -0.5 || by < -0.5 || bx > L.cols + 0.5 || by > L.rows + 0.5) return null;

  const cand: { hit: Hit; pri: number; d: number }[] = [];
  const reach = Math.max(0.5, MIN_TOUCH / 2 / c);   // 44px target, in cells

  let dot: Pos | null = null, dd = Infinity;
  for (const h of o.hints) {
    const d = Math.hypot(bx - h.c - 0.5, by - h.r - 0.5);
    if (d < dd) { dd = d; dot = h; }
  }
  if (dot && dd <= reach) {
    const own = Math.max(Math.abs(bx - dot.c - 0.5), Math.abs(by - dot.r - 0.5)) <= 0.5;
    cand.push({ hit: { kind: 'move', to: dot }, pri: own ? 1 : 3, d: dd });
  }

  if (o.armed) {
    const d = distToWall(bx, by, o.armed, 0.5);
    if (d <= Math.min(0.42, Math.max(LINE_ZONE, 18 / c))) cand.push({ hit: { kind: 'confirm', spec: o.armed }, pri: 0, d });
  }
  const s = slotNear(bx, by, L.cols, L.rows);
  if (s) cand.push({ hit: { kind: 'wall', spec: s }, pri: 2, d: distToWall(bx, by, s, 1.25) });

  cand.sort((a, b) => a.pri - b.pri || a.d - b.d);
  return cand.length ? cand[0].hit : null;
}

/* ---------- drawing ---------- */

/** One seat: its colours, its ball material, its wall material. Seats 0/1 play, seat 2 refuses. */
interface Side { ramp: Ramp; ball: BallSkin; wall: WallStyle }

const CORNER = 0.4;              // board corner radius, in cells

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

function computeLayout(w: number, h: number, dpr: number, cols: number, rows: number): Layout {
  const m = 3;
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
  /** seat 0 wears the equipped skin and style; seat 1 is the opponent and never does. */
  let sides: [Side, Side, Side] = seats(th);
  const born = new Map<number, number>();                    // wall key → first-seen time (pop-in)
  const pulses: { x: number; y: number; t0: number; p: Player }[] = []; // wall landing rings
  let bg: HTMLCanvasElement | null = null;                   // static board layer, rebuilt on resize
  let lastW = 0, lastH = 0, lastDpr = 0;
  // layout-sized paint servers: built once per resize, reused every frame
  const dash = { trail: [] as number[], last: [] as number[], ghost: [] as number[], armed: [] as number[] };
  const ballFx: { shadow: CanvasGradient; body: CanvasGradient; bounce: CanvasGradient }[] = [];
  const glowG: CanvasGradient[] = [];
  /** Light sweep over the finish strip: one gradient per resize, moved with the canvas transform. */
  const sweep = { grad: null as CanvasGradient | null, band: 0 };

  /** The two seats plus the refusal palette, from one theme. */
  function seats(t: Theme): [Side, Side, Side] {
    const you: Side = { ramp: t.ball.ramp, ball: t.ball, wall: t.wall };
    const foe: Side = { ramp: BOT_RAMP, ball: CLASSIC_BALL, wall: CLASSIC_WALL };
    return [you, foe, { ramp: ERR_RAMP, ball: CLASSIC_BALL, wall: CLASSIC_WALL }];
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

    g.save();
    g.shadowColor = b.drop;
    g.shadowBlur = 14 * dpr;
    g.shadowOffsetY = 4 * dpr;
    rr(g, ox, oy, bw, bh, R);
    g.fillStyle = b.surface;
    g.fill();
    g.restore();

    g.save();
    rr(g, ox, oy, bw, bh, R);
    g.clip();

    // device-pixel snapping keeps the finish checker crisp at any dpr (no half-pixel seams)
    const px = (n: number) => Math.round(n * dpr) / dpr;

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

    const lwDev = Math.max(1, Math.round(dpr));
    const half = (lwDev % 2) / 2;
    const snap = (n: number) => (Math.round(n * dpr - half) + half) / dpr;
    g.strokeStyle = b.grid;
    g.lineWidth = lwDev / dpr;
    g.beginPath();
    for (let i = 1; i < cols; i++) { const x = snap(ox + i * c); g.moveTo(x, oy); g.lineTo(x, oy + bh); }
    for (let i = 1; i < rows; i++) { const y = snap(oy + i * c); g.moveTo(ox, y); g.lineTo(ox + bw, y); }
    g.stroke();
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
    barG[0].clear(); barG[1].clear(); barG[2].clear();
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
    for (let i = 0; i < 2; i++) {
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
  }

  /** Wall-body gradients, bucketed by thickness: built once per size, never per frame. */
  const barG: [Map<number, CanvasGradient>, Map<number, CanvasGradient>, Map<number, CanvasGradient>] =
    [new Map(), new Map(), new Map()];

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
  function outline(w: WallSpec, color: string, width: number, dashes: number[], phase = 0) {
    const c = L.cell;
    const t = c * 0.3 * sides[0].wall.thick;
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

  function drawBall(cx: number, cy: number, r: number, i: number) {
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
    ctx.restore();
  }

  /** Halo under the ball whose turn it is (or the winner). */
  function drawGlow(cx: number, cy: number, r: number, i: number, k: number) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalAlpha = Math.min(1, (0.34 + 0.3 * k) * sides[i].ball.halo);
    ctx.fillStyle = glowG[i];
    ctx.beginPath(); ctx.arc(0, 0, r * 2.3, 0, TAU); ctx.fill();
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

    // last move of each player: trail out of the old cell, ants around the old wall
    for (let pi = 0; pi < 2; pi++) {
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

    // legal-move dots: big, high contrast, at least a 44px target, tinted with the side to move
    const side = sides[v.state.turn];
    const pulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(now / 380);
    const dotR = Math.max(6, c * 0.17 + c * 0.014 * pulse);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = Math.max(1.5, c * 0.035);
    ctx.fillStyle = side.ramp.mid;
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

    if (v.ghost) {
      const gp = sides[v.ghost.p].ramp;
      if (v.ghost.ok) {
        drawBar(v.ghost.spec, v.ghost.p, v.ghost.armed ? 0.85 : 0.42, 1, false);
        outline(v.ghost.spec, v.ghost.armed ? gp.os : gp.ol,
          Math.max(1.5, c * 0.045), v.ghost.armed ? dash.armed : dash.ghost, still ? 0 : -now / 26);
      } else {
        // solid ring + cross: unmistakably "not here", unlike the dashed ghost above
        drawBar(v.ghost.spec, ERR, 0.3, 1, false);
        outline(v.ghost.spec, 'rgba(255,45,85,.95)', Math.max(2, c * 0.06), SOLID, 0);
        cross(v.ghost.spec, '#fff', c * 0.19);
      }
    }

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

    // balls, lower one on top
    const first: number = v.balls[0].y <= v.balls[1].y ? 0 : 1;
    for (let n = 0; n < 2; n++) {
      const i = n === 0 ? first : 1 - first;
      const b = v.balls[i];
      const cx = ox + b.x * c, cy = oy + b.y * c, r = c * 0.34;
      const active = v.state.winner === null && v.state.turn === i;
      if (active || v.state.winner === i) {
        drawGlow(cx, cy, r, i, still ? 0.6 : 0.5 + 0.5 * Math.sin(now / 260));
        if (active) {
          ctx.save();
          ctx.strokeStyle = sides[i].ramp.mid;
          ctx.globalAlpha = 0.55;
          ctx.lineWidth = Math.max(1.5, c * 0.04);
          ctx.beginPath(); ctx.arc(cx, cy, r * 1.42, 0, TAU); ctx.stroke();
          ctx.restore();
        }
      }
      drawBall(cx, cy, r, i);
    }

    // "opponent is thinking" pips above the bot's ball
    if (v.thinking) {
      const b = v.balls[1];
      const x0 = ox + b.x * c, y0 = oy + b.y * c - c * 0.78;
      ctx.save();
      ctx.fillStyle = BOT_RAMP.mid;
      for (let i = 0; i < 3; i++) {
        const ph = still ? 0.6 : 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now / 260 - i * 1.1));
        ctx.globalAlpha = Math.min(1, ph);
        ctx.beginPath(); ctx.arc(x0 + (i - 1) * c * 0.22, y0, c * 0.06, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
  }

  return {
    resize,
    draw,
    layout: () => L,
    resetFx: () => { born.clear(); pulses.length = 0; },
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
type Scene = { cols: number; rows: number; balls: [Vec, Vec]; hints: Pos[]; walls: Wall[] };

/** 6x4 patches: room for a real wall layout, and a finish strip that is not the whole picture. */
const SCENES: Record<PreviewKind, Scene> = {
  // your ball on the move, theirs beside it: the pair is the thing being judged
  ball: {
    cols: 6, rows: 4,
    balls: [{ x: 2.5, y: 3.5 }, { x: 3.5, y: 3.5 }],
    hints: [{ c: 1, r: 2 }, { c: 2, r: 2 }, { c: 3, r: 2 }, { c: 4, r: 2 }],
    walls: [],
  },
  // two of yours and one of theirs, so a style reads in both orientations and against the fixed one
  wall: {
    cols: 6, rows: 4,
    balls: [{ x: 0.5, y: 3.5 }, { x: 5.5, y: 3.5 }],
    hints: [],
    walls: [{ o: 'h', x: 0, y: 2, owner: 0 }, { o: 'v', x: 3, y: 0, owner: 0 }, { o: 'h', x: 2, y: 3, owner: 1 }],
  },
  board: {
    cols: 6, rows: 4,
    balls: [{ x: 2.5, y: 3.5 }, { x: 4.5, y: 3.5 }],
    hints: [],
    walls: [{ o: 'h', x: 0, y: 2, owner: 0 }, { o: 'v', x: 5, y: 1, owner: 1 }],
  },
};

const sceneView = (s: Scene): View => ({
  state: {
    teams: [{ balls: 1 }, { balls: 1 }],
    balls: [
      { id: 0, team: 0, owner: 0, pos: { c: 0, r: s.rows - 1 } },
      { id: 1, team: 1, owner: 1, pos: { c: s.cols - 1, r: s.rows - 1 } },
    ],
    walls: s.walls,
    turn: 0,
    winner: null,
  },
  balls: s.balls,
  hints: s.hints,
  ghost: null,
  last: [null, null],
  thinking: false,
});

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
