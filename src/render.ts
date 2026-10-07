/**
 * render.ts — Canvas 2D drawing + pointer → board hit-testing.
 * All sizes derive from `cell`, so the look scales to any phone.
 */
import { COLS, ROWS, type GameState, type Player, type Pos, type WallSpec } from './rules';

export interface Vec { x: number; y: number }

/** Wall ghost under construction. `armed` = already tapped once, waiting for a confirm tap. */
export interface Ghost { spec: WallSpec; ok: boolean; armed: boolean }

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

export interface Layout { w: number; h: number; cell: number; ox: number; oy: number; dpr: number }

export type Hit =
  | { kind: 'confirm'; spec: WallSpec }
  | { kind: 'wall'; spec: WallSpec }
  | { kind: 'move'; to: Pos };

const TAU = Math.PI * 2;
const LINE_ZONE = 0.3;  // cells from a grid line that still read as "aiming at that line"
const MIN_TOUCH = 44;   // css px: smallest legal-move tap target we allow

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* ---------- hit-testing ---------- */

/** Nearest valid wall slot when (bx, by) aims at a grid line, else null. Board coords. */
function slotNear(bx: number, by: number): WallSpec | null {
  const hY = clamp(Math.round(by), 1, ROWS - 1);
  const vX = clamp(Math.round(bx), 1, COLS - 1);
  const dh = Math.abs(by - hY), dv = Math.abs(bx - vX);
  if (Math.min(dh, dv) > LINE_ZONE) return null;
  return dh <= dv
    ? { o: 'h', x: clamp(Math.round(bx) - 1, 0, COLS - 2), y: hY }
    : { o: 'v', x: vX, y: clamp(Math.round(by) - 1, 0, ROWS - 2) };
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
  hints: Pos[]; walls: boolean; armed: WallSpec | null;
}): Hit | null {
  const c = L.cell;
  if (c <= 0) return null;
  const bx = (px - L.ox) / c, by = (py - L.oy) / c;
  if (bx < -0.5 || by < -0.5 || bx > COLS + 0.5 || by > ROWS + 0.5) return null;

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
  if (o.walls) {
    const s = slotNear(bx, by);
    if (s) cand.push({ hit: { kind: 'wall', spec: s }, pri: 2, d: distToWall(bx, by, s, 1.25) });
  }

  cand.sort((a, b) => a.pri - b.pri || a.d - b.d);
  return cand.length ? cand[0].hit : null;
}

/* ---------- drawing ---------- */

interface Pal {
  light: string; mid: string; dark: string; glow: string; shade: string;
  wl: string; wd: string; edge: string;
}
/** 0 = you (red), 1 = opponent (blue), 2 = refusal. The opponent's walls carry cross-bands so
 *  ownership is readable without colour. */
const PALS: [Pal, Pal, Pal] = [
  { light: '#ffa3b7', mid: '#e0264f', dark: '#80092a', glow: 'rgba(224,38,79,.55)', shade: '90,20,50', wl: '#ff6f8d', wd: '#b4113b', edge: 'rgba(90,20,50,.28)' },
  { light: '#a6bbff', mid: '#3057db', dark: '#122770', glow: 'rgba(48,87,219,.55)', shade: '20,30,100', wl: '#7794ff', wd: '#2142b0', edge: 'rgba(20,30,100,.28)' },
  { light: '#ffc2c2', mid: '#ff2d55', dark: '#8d0a24', glow: 'rgba(255,45,85,.6)', shade: '120,10,30', wl: '#ff9a9a', wd: '#d6173f', edge: 'rgba(120,10,30,.28)' },
];
const ERR = 2;
const DOT = 'rgb(224,38,79)';
const SOLID: number[] = [];

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

function computeLayout(w: number, h: number, dpr: number): Layout {
  const m = 3;
  const raw = Math.min((w - 2 * m) / COLS, (h - 2 * m) / ROWS);
  const cell = Math.max(8, Math.floor(raw * dpr) / dpr); // whole device pixels → crisp grid
  const ox = Math.round(((w - COLS * cell) / 2) * dpr) / dpr;
  const oy = Math.round(((h - ROWS * cell) / 2) * dpr) / dpr;
  return { w, h, cell, ox, oy, dpr };
}

export function createRenderer(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const rmq = matchMedia('(prefers-reduced-motion: reduce)');
  let L = computeLayout(1, 1, 1);
  const born = new Map<number, number>();                    // wall key → first-seen time (pop-in)
  const pulses: { x: number; y: number; t0: number; p: Player }[] = []; // wall landing rings
  let bg: HTMLCanvasElement | null = null;                   // static board layer, rebuilt on resize
  let lastW = 0, lastH = 0, lastDpr = 0;
  // layout-sized paint servers: built once per resize, reused every frame
  const dash = { trail: [] as number[], last: [] as number[], ghost: [] as number[], armed: [] as number[] };
  const ballFx: { shadow: CanvasGradient; body: CanvasGradient; bounce: CanvasGradient }[] = [];
  const glowG: CanvasGradient[] = [];

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === lastW && h === lastH && dpr === lastDpr) return;
    lastW = w; lastH = h; lastDpr = dpr;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    L = computeLayout(w, h, dpr);
    buildStatic();
  }

  /** Everything that only depends on the layout: the board layer + every paint server. */
  function buildStatic() {
    const { w, h, cell: c, ox, oy, dpr } = L;
    const cv = bg || (bg = document.createElement('canvas'));
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    const g = cv.getContext('2d')!;
    const bw = COLS * c, bh = ROWS * c, R = 0.4 * c;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    g.save();
    g.shadowColor = 'rgba(88,84,140,.20)';
    g.shadowBlur = 14 * dpr;
    g.shadowOffsetY = 4 * dpr;
    rr(g, ox, oy, bw, bh, R);
    g.fillStyle = '#f7f7fc';
    g.fill();
    g.restore();

    g.save();
    rr(g, ox, oy, bw, bh, R);
    g.clip();

    // FINISH wash: the top three rows
    const fg = g.createLinearGradient(0, oy, 0, oy + 3 * c);
    fg.addColorStop(0, 'rgba(47,168,111,.36)');
    fg.addColorStop(0.42, 'rgba(47,168,111,.17)');
    fg.addColorStop(1, 'rgba(47,168,111,0)');
    g.fillStyle = fg;
    g.fillRect(ox, oy, bw, 3 * c);

    // checker strip across row 0: "finish" also reads without colour
    const q = c / 2;
    for (let i = 0; i < COLS * 2; i++) {
      for (let j = 0; j < 2; j++) {
        g.fillStyle = (i + j) % 2 === 0 ? 'rgba(255,255,255,.55)' : 'rgba(15,107,69,.26)';
        g.fillRect(ox + i * q, oy + j * q, q, q);
      }
    }
    g.strokeStyle = 'rgba(15,107,69,.30)';
    g.lineWidth = Math.max(1, c * 0.02);
    g.beginPath(); g.moveTo(ox, oy + c); g.lineTo(ox + bw, oy + c); g.stroke();

    const lwDev = Math.max(1, Math.round(dpr));
    const half = (lwDev % 2) / 2;
    const snap = (n: number) => (Math.round(n * dpr - half) + half) / dpr;
    g.strokeStyle = '#d0d0de';
    g.lineWidth = lwDev / dpr;
    g.beginPath();
    for (let i = 1; i < COLS; i++) { const x = snap(ox + i * c); g.moveTo(x, oy); g.lineTo(x, oy + bh); }
    for (let i = 1; i < ROWS; i++) { const y = snap(oy + i * c); g.moveTo(ox, y); g.lineTo(ox + bw, y); }
    g.stroke();
    g.restore();

    // border ring: green at the finish, fading to grey-lavender
    const rw = 0.075 * c;
    const ring = g.createLinearGradient(0, oy, 0, oy + bh);
    ring.addColorStop(0, '#2fa86f');
    ring.addColorStop(0.09, '#43b585');
    ring.addColorStop(0.28, '#cfd0e0');
    ring.addColorStop(1, '#d6d5e5');
    rr(g, ox + rw / 2, oy + rw / 2, bw - rw, bh - rw, R - rw / 2);
    g.lineWidth = rw;
    g.strokeStyle = ring;
    g.stroke();
    rr(g, ox - 0.5, oy - 0.5, bw + 1, bh + 1, R + 0.5);
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,.75)';
    g.stroke();

    // paint servers sized to this layout, then reused by every frame
    dash.trail[0] = c * 0.15; dash.trail[1] = c * 0.12;
    dash.last[0] = dash.last[1] = c * 0.1;
    dash.ghost[0] = dash.ghost[1] = c * 0.11;
    dash.armed[0] = dash.armed[1] = c * 0.16;
    barG[0].clear(); barG[1].clear(); barG[2].clear();
    ballFx.length = 0;
    glowG.length = 0;
    const br = c * 0.34;
    for (let i = 0; i < 2; i++) {
      const p = PALS[i];
      const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, br * 1.1);
      shadow.addColorStop(0, `rgba(${p.shade},.42)`);
      shadow.addColorStop(0.55, `rgba(${p.shade},.18)`);
      shadow.addColorStop(1, `rgba(${p.shade},0)`);
      const body = ctx.createRadialGradient(-0.34 * br, -0.4 * br, br * 0.06, -0.08 * br, -0.08 * br, br * 1.12);
      body.addColorStop(0, p.light); body.addColorStop(0.4, p.mid); body.addColorStop(1, p.dark);
      const bounce = ctx.createRadialGradient(0.3 * br, 0.62 * br, 0, 0.3 * br, 0.62 * br, br * 0.8);
      bounce.addColorStop(0, 'rgba(255,255,255,.28)'); bounce.addColorStop(1, 'rgba(255,255,255,0)');
      ballFx.push({ shadow, body, bounce });
      const glow = ctx.createRadialGradient(0, 0, br * 0.8, 0, 0, br * 2.3);
      glow.addColorStop(0, p.glow);
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
      const p = PALS[pi];
      g = ctx.createLinearGradient(0, -t / 2, 0, t / 2);
      g.addColorStop(0, p.wl);
      g.addColorStop(0.5, p.mid);
      g.addColorStop(1, p.wd);
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
    const t = c * 0.13 * (0.62 + 0.38 * grow);
    const cap = t / 2, len = 2 * c - t;
    ctx.save();
    ctx.translate(ox + w.x * c, oy + w.y * c);
    if (w.o === 'v') { ctx.translate(0, 2 * c); ctx.rotate(-Math.PI / 2); }
    ctx.lineCap = 'round';
    ctx.globalAlpha = alpha;
    ctx.lineWidth = t;
    ctx.strokeStyle = barGrad(pi, t);
    if (glow) { ctx.shadowColor = PALS[pi].glow; ctx.shadowBlur = c * 0.16 * dpr; }
    ctx.beginPath(); ctx.moveTo(cap, 0); ctx.lineTo(cap + len, 0); ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255,255,255,.38)';                 // gloss, on the lit (upper-left) side
    ctx.lineWidth = t * 0.26;
    ctx.beginPath();
    ctx.moveTo(cap + t * 0.2, -t * 0.18); ctx.lineTo(cap + len - t * 0.2, -t * 0.18);
    ctx.stroke();
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
    const t = c * 0.3;
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

  function drawBall(cx: number, cy: number, r: number, i: number) {
    const fx = ballFx[i];
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

    ctx.beginPath(); ctx.arc(0, 0, r - 0.5, 0, TAU);   // crisp edge
    ctx.strokeStyle = PALS[i].edge; ctx.lineWidth = 1; ctx.stroke();

    ctx.translate(-0.36 * r, -0.42 * r);               // specular
    ctx.rotate(-0.72);
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    ctx.beginPath(); ctx.ellipse(0, 0, r * 0.4, r * 0.24, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.beginPath(); ctx.ellipse(0, 0, r * 0.26, r * 0.14, 0, 0, TAU); ctx.fill();
    ctx.restore();
  }

  /** Halo under the ball whose turn it is (or the winner). */
  function drawGlow(cx: number, cy: number, r: number, i: number, k: number) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalAlpha = 0.34 + 0.3 * k;
    ctx.fillStyle = glowG[i];
    ctx.beginPath(); ctx.arc(0, 0, r * 2.3, 0, TAU); ctx.fill();
    ctx.restore();
  }

  function draw(v: View, now: number) {
    const { cell: c, ox, oy } = L;
    const still = rmq.matches;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (bg) ctx.drawImage(bg, 0, 0);
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);

    // last move of each player: trail out of the old cell, ants around the old wall
    for (let pi = 0; pi < 2; pi++) {
      const m = v.last[pi];
      if (!m) continue;
      const pal = PALS[pi];
      if (m.kind === 'step') {
        const ax = ox + (m.from.c + 0.5) * c, ay = oy + (m.from.r + 0.5) * c;
        const bx = ox + (m.to.c + 0.5) * c, by = oy + (m.to.r + 0.5) * c;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = pal.mid;
        ctx.globalAlpha = 0.26;
        ctx.lineWidth = c * 0.18;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = Math.max(1.5, c * 0.045);
        ctx.setLineDash(dash.trail);
        ctx.beginPath(); ctx.arc(ax, ay, c * 0.25, 0, TAU); ctx.stroke();
        ctx.restore();
      } else {
        outline(m.spec, pal.glow, Math.max(1.5, c * 0.035), dash.last);
      }
    }

    // legal-move dots: big, high contrast, at least a 44px target
    const pulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(now / 380);
    const dotR = Math.max(6, c * 0.17 + c * 0.014 * pulse);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = Math.max(1.5, c * 0.035);
    ctx.fillStyle = DOT;
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
      if (v.ghost.ok) {
        drawBar(v.ghost.spec, 0, v.ghost.armed ? 0.85 : 0.42, 1, false);
        outline(v.ghost.spec, v.ghost.armed ? 'rgba(224,38,79,.95)' : 'rgba(224,38,79,.5)',
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
      const key = 2 * (w.y * COLS + w.x) + (w.o === 'h' ? 0 : 1);
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
      ctx.strokeStyle = PALS[f.p].mid;
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
          ctx.strokeStyle = PALS[i].mid;
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
      ctx.fillStyle = PALS[1].mid;
      for (let i = 0; i < 3; i++) {
        const ph = still ? 0.6 : 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now / 260 - i * 1.1));
        ctx.globalAlpha = Math.min(1, ph);
        ctx.beginPath(); ctx.arc(x0 + (i - 1) * c * 0.22, y0, c * 0.06, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
  }

  return { resize, draw, layout: () => L, resetFx: () => { born.clear(); pulses.length = 0; } };
}
