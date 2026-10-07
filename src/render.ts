/**
 * render.ts — Canvas 2D drawing + pointer → board hit-testing.
 * All sizes derive from `cell`, so the look scales to any phone.
 */
import { COLS, ROWS, type GameState, type Player, type Pos, type Wall, type WallSpec } from './rules';

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
const wallKey = (w: WallSpec) => `${w.o}${w.x},${w.y}`;

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

interface Pal { light: string; mid: string; dark: string; glow: string; shade: string; wl: string; wd: string }
const PAL: [Pal, Pal] = [
  { light: '#ffa3b7', mid: '#e0264f', dark: '#80092a', glow: 'rgba(224,38,79,.55)', shade: '90,20,50', wl: '#ff6f8d', wd: '#b4113b' },
  { light: '#a6bbff', mid: '#3057db', dark: '#122770', glow: 'rgba(48,87,219,.55)', shade: '20,30,100', wl: '#7794ff', wd: '#2142b0' },
];
const ERR: Pal = {
  light: '#ffc2c2', mid: '#ff2d55', dark: '#8d0a24', glow: 'rgba(255,45,85,.6)', shade: '120,10,30', wl: '#ff9a9a', wd: '#d6173f',
};

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
  const m = 6;
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
  const born = new Map<string, number>();                    // wall key → first-seen time (pop-in)
  const pulses: { x: number; y: number; t0: number; p: Player }[] = []; // wall landing rings

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    L = computeLayout(w, h, dpr);
  }

  /** A wall, a ghost or an error ghost — same body, different palette + alpha. */
  function drawBar(w: WallSpec, pal: Pal, alpha: number, grow: number) {
    const { cell: c, ox, oy, dpr } = L;
    const t = c * 0.1 * (0.55 + 0.45 * grow);
    const cap = c * 0.05; // round caps end exactly on the 2-cell span
    let x1: number, y1: number, x2: number, y2: number, g: CanvasGradient;
    if (w.o === 'h') {
      y1 = y2 = oy + w.y * c;
      x1 = ox + w.x * c + cap;
      x2 = ox + (w.x + 2) * c - cap;
      g = ctx.createLinearGradient(0, y1 - t / 2, 0, y1 + t / 2);
    } else {
      x1 = x2 = ox + w.x * c;
      y1 = oy + w.y * c + cap;
      y2 = oy + (w.y + 2) * c - cap;
      g = ctx.createLinearGradient(x1 - t / 2, 0, x1 + t / 2, 0);
    }
    g.addColorStop(0, pal.wl);
    g.addColorStop(0.5, pal.mid);
    g.addColorStop(1, pal.wd);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.shadowColor = pal.glow;
    ctx.shadowBlur = c * 0.3 * dpr;
    ctx.strokeStyle = g;
    ctx.lineWidth = t;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,.38)'; // gloss
    ctx.lineWidth = t * 0.28;
    const o = -t * 0.18, e = t * 0.2;
    ctx.beginPath();
    if (w.o === 'h') { ctx.moveTo(x1 + e, y1 + o); ctx.lineTo(x2 - e, y2 + o); }
    else { ctx.moveTo(x1 + o, y1 + e); ctx.lineTo(x2 + o, y2 - e); }
    ctx.stroke();
    ctx.restore();
  }

  const box = (w: WallSpec) => {
    const { cell: c, ox, oy } = L;
    return w.o === 'h'
      ? { x: ox + w.x * c, y: oy + w.y * c, w: 2 * c, h: 0, cx: ox + (w.x + 1) * c, cy: oy + w.y * c }
      : { x: ox + w.x * c, y: oy + w.y * c, w: 0, h: 2 * c, cx: ox + w.x * c, cy: oy + (w.y + 1) * c };
  };

  /** Marching-ants outline hugging a wall — "this is the slot you are about to use". */
  function outline(w: WallSpec, color: string, width: number, dash: number, phase: number) {
    const c = L.cell;
    const t = c * 0.3;
    const b = box(w);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash([dash, dash]);
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

  function drawBall(cx: number, cy: number, r: number, p: Pal) {
    // soft elliptical shadow
    ctx.save();
    ctx.translate(cx, cy + r * 0.82);
    ctx.scale(1, 0.3);
    let g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.1);
    g.addColorStop(0, `rgba(${p.shade},.42)`);
    g.addColorStop(0.55, `rgba(${p.shade},.18)`);
    g.addColorStop(1, `rgba(${p.shade},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.1, 0, TAU); ctx.fill();
    ctx.restore();

    // body
    g = ctx.createRadialGradient(cx - 0.34 * r, cy - 0.4 * r, r * 0.06, cx - 0.08 * r, cy - 0.08 * r, r * 1.12);
    g.addColorStop(0, p.light);
    g.addColorStop(0.4, p.mid);
    g.addColorStop(1, p.dark);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = g; ctx.fill();

    // bounce light from below-right, clipped to the sphere
    ctx.save();
    ctx.clip();
    g = ctx.createRadialGradient(cx + 0.3 * r, cy + 0.62 * r, 0, cx + 0.3 * r, cy + 0.62 * r, r * 0.8);
    g.addColorStop(0, 'rgba(255,255,255,.28)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    ctx.restore();

    // crisp edge
    ctx.beginPath(); ctx.arc(cx, cy, r - 0.5, 0, TAU);
    ctx.strokeStyle = `rgba(${p.shade},.28)`; ctx.lineWidth = 1; ctx.stroke();

    // specular
    ctx.save();
    ctx.translate(cx - 0.36 * r, cy - 0.42 * r);
    ctx.rotate(-0.72);
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    ctx.beginPath(); ctx.ellipse(0, 0, r * 0.4, r * 0.24, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.beginPath(); ctx.ellipse(0, 0, r * 0.26, r * 0.14, 0, 0, TAU); ctx.fill();
    ctx.restore();
  }

  function draw(v: View, now: number) {
    const { cell: c, ox, oy, dpr } = L;
    const still = rmq.matches;
    const bw = COLS * c, bh = ROWS * c, R = 0.4 * c;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, L.w, L.h);

    // board body with a soft lift
    ctx.save();
    ctx.shadowColor = 'rgba(88,84,140,.20)';
    ctx.shadowBlur = 16 * dpr;
    ctx.shadowOffsetY = 4 * dpr;
    rr(ctx, ox, oy, bw, bh, R);
    ctx.fillStyle = '#f7f7fc';
    ctx.fill();
    ctx.restore();

    // finish tint + grid, clipped to the rounded board
    ctx.save();
    rr(ctx, ox, oy, bw, bh, R);
    ctx.clip();
    const fg = ctx.createLinearGradient(0, oy, 0, oy + 2.2 * c);
    fg.addColorStop(0, 'rgba(47,168,111,.30)');
    fg.addColorStop(0.55, 'rgba(47,168,111,.12)');
    fg.addColorStop(1, 'rgba(47,168,111,0)');
    ctx.fillStyle = fg;
    ctx.fillRect(ox, oy, bw, 2.2 * c);

    const lwDev = Math.max(1, Math.round(dpr));
    const half = (lwDev % 2) / 2;
    const snap = (n: number) => (Math.round(n * dpr - half) + half) / dpr;
    ctx.strokeStyle = '#d0d0de';
    ctx.lineWidth = lwDev / dpr;
    ctx.beginPath();
    for (let i = 1; i < COLS; i++) { const x = snap(ox + i * c); ctx.moveTo(x, oy); ctx.lineTo(x, oy + bh); }
    for (let i = 1; i < ROWS; i++) { const y = snap(oy + i * c); ctx.moveTo(ox, y); ctx.lineTo(ox + bw, y); }
    ctx.stroke();
    ctx.restore();

    // border ring: green at the finish, fading to grey-lavender
    const rw = 0.075 * c;
    const ring = ctx.createLinearGradient(0, oy, 0, oy + bh);
    ring.addColorStop(0, '#2fa86f');
    ring.addColorStop(0.1, '#43b585');
    ring.addColorStop(0.3, '#cfd0e0');
    ring.addColorStop(1, '#d6d5e5');
    rr(ctx, ox + rw / 2, oy + rw / 2, bw - rw, bh - rw, R - rw / 2);
    ctx.lineWidth = rw;
    ctx.strokeStyle = ring;
    ctx.stroke();
    rr(ctx, ox - 0.5, oy - 0.5, bw + 1, bh + 1, R + 0.5);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    ctx.stroke();

    // last move of each player: trail out of the old cell, ants around the old wall
    for (const p of [0, 1] as Player[]) {
      const m = v.last[p];
      if (!m) continue;
      const pal = PAL[p];
      if (m.kind === 'step') {
        const a = { x: ox + (m.from.c + 0.5) * c, y: oy + (m.from.r + 0.5) * c };
        const b = { x: ox + (m.to.c + 0.5) * c, y: oy + (m.to.r + 0.5) * c };
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = pal.mid;
        ctx.globalAlpha = 0.26;
        ctx.lineWidth = c * 0.18;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = Math.max(1.5, c * 0.045);
        ctx.setLineDash([c * 0.15, c * 0.12]);
        ctx.beginPath(); ctx.arc(a.x, a.y, c * 0.25, 0, TAU); ctx.stroke();
        ctx.restore();
      } else {
        outline(m.spec, pal.glow, Math.max(1.5, c * 0.035), c * 0.1, 0);
      }
    }

    // legal-move dots: big, high contrast, at least a 44px target
    const pulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(now / 380);
    const dotR = Math.max(6, c * 0.17 + c * 0.014 * pulse);
    for (const h of v.hints) {
      const x = ox + (h.c + 0.5) * c, y = oy + (h.r + 0.5) * c;
      ctx.beginPath(); ctx.arc(x, y, dotR * 1.75, 0, TAU);
      ctx.fillStyle = `rgba(224,38,79,${0.1 + 0.06 * pulse})`; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, dotR, 0, TAU);
      ctx.fillStyle = `rgba(224,38,79,${0.72 + 0.12 * pulse})`; ctx.fill();
      ctx.lineWidth = Math.max(1.5, c * 0.035);
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.stroke();
    }

    if (v.ghost) {
      if (v.ghost.ok) {
        drawBar(v.ghost.spec, PAL[0], v.ghost.armed ? 0.85 : 0.42, 1);
        outline(v.ghost.spec, v.ghost.armed ? 'rgba(224,38,79,.95)' : 'rgba(224,38,79,.5)',
          Math.max(1.5, c * 0.045), c * (v.ghost.armed ? 0.16 : 0.11), still ? 0 : -now / 26);
      } else {
        // solid ring + cross: unmistakably "not here", unlike the dashed ghost above
        drawBar(v.ghost.spec, ERR, 0.3, 1);
        outline(v.ghost.spec, 'rgba(255,45,85,.95)', Math.max(2, c * 0.06), 0, 0);
        cross(v.ghost.spec, '#fff', c * 0.19);
      }
    }

    // placed walls (pop-in + landing pulse)
    const live = new Set<string>();
    for (const w of v.state.walls) {
      const key = wallKey(w);
      live.add(key);
      if (!born.has(key)) {
        born.set(key, now);
        if (!still) { const b = box(w); pulses.push({ x: b.cx, y: b.cy, t0: now, p: w.owner }); }
      }
      const p = Math.min(1, (now - born.get(key)!) / 220);
      drawBar(w, PAL[w.owner], Math.min(1, p * 3), still ? 1 : 1 - Math.pow(1 - p, 3));
    }
    for (const k of born.keys()) if (!live.has(k)) born.delete(k);

    for (let i = pulses.length - 1; i >= 0; i--) {
      const f = pulses[i];
      const t = (now - f.t0) / 460;
      if (t >= 1) { pulses.splice(i, 1); continue; }
      const pal = PAL[f.p];
      ctx.save();
      ctx.globalAlpha = 0.5 * (1 - t);
      ctx.strokeStyle = pal.mid;
      ctx.lineWidth = Math.max(1.5, c * 0.07 * (1 - t));
      ctx.beginPath(); ctx.arc(f.x, f.y, c * (0.5 + 1.5 * t), 0, TAU); ctx.stroke();
      ctx.restore();
    }

    // balls, lower one on top
    const order: Player[] = v.balls[0].y <= v.balls[1].y ? [0, 1] : [1, 0];
    for (const i of order) {
      const b = v.balls[i];
      const cx = ox + b.x * c, cy = oy + b.y * c, r = c * 0.34;
      const active = v.state.winner === null && v.state.turn === i;
      if (active || v.state.winner === i) {
        const k = still ? 0.6 : 0.5 + 0.5 * Math.sin(now / 260);
        const hg = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * (1.9 + 0.35 * k));
        hg.addColorStop(0, PAL[i].glow);
        hg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = hg;
        ctx.beginPath(); ctx.arc(cx, cy, r * 2.3, 0, TAU); ctx.fill();
        if (active) {
          ctx.strokeStyle = PAL[i].mid;
          ctx.globalAlpha = 0.55;
          ctx.lineWidth = Math.max(1.5, c * 0.04);
          ctx.beginPath(); ctx.arc(cx, cy, r * 1.42, 0, TAU); ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      drawBall(cx, cy, r, PAL[i]);
    }

    // "opponent is thinking" pips above the bot's ball
    if (v.thinking) {
      const b = v.balls[1];
      const x0 = ox + b.x * c, y0 = oy + b.y * c - c * 0.78;
      for (let i = 0; i < 3; i++) {
        const ph = still ? 0.6 : 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now / 260 - i * 1.1));
        ctx.globalAlpha = Math.min(1, ph);
        ctx.fillStyle = PAL[1].mid;
        ctx.beginPath(); ctx.arc(x0 + (i - 1) * c * 0.22, y0, c * 0.06, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawWall(w: Wall, alpha: number, grow: number) { drawBar(w, PAL[w.owner], alpha, grow); }

  return { resize, draw, layout: () => L, resetFx: () => { born.clear(); pulses.length = 0; } };
}
