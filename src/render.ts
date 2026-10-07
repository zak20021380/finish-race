/**
 * render.ts — Canvas 2D drawing + pointer → board hit-testing.
 * All sizes derive from `cell`, so the look scales to any phone.
 */
import { COLS, ROWS, type GameState, type Player, type Pos, type Wall, type WallSpec } from './rules';

export interface Vec { x: number; y: number }
export interface View {
  state: GameState;
  balls: [Vec, Vec];        // animated centres, in cell units (col + .5, row + .5)
  hints: Pos[];             // legal move cells
  preview: Wall | null;     // faded wall under the mouse
}
export interface Layout { w: number; h: number; cell: number; ox: number; oy: number; dpr: number }
export interface Target { cell: Pos | null; wall: WallSpec | null }

const TAU = Math.PI * 2;

interface Pal { light: string; mid: string; dark: string; glow: string; shade: string; wl: string; wd: string }
const PAL: [Pal, Pal] = [
  { light: '#ffa3b7', mid: '#e0264f', dark: '#80092a', glow: 'rgba(224,38,79,.55)', shade: '90,20,50', wl: '#ff6f8d', wd: '#b4113b' },
  { light: '#a6bbff', mid: '#3057db', dark: '#122770', glow: 'rgba(48,87,219,.55)', shade: '20,30,100', wl: '#7794ff', wd: '#2142b0' },
];

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
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

/** Pointer (CSS px, canvas-local) → cell under it + the wall slot if it is near a grid line. */
export function pick(L: Layout, px: number, py: number): Target | null {
  const bx = (px - L.ox) / L.cell, by = (py - L.oy) / L.cell;
  if (bx < 0 || by < 0 || bx >= COLS || by >= ROWS) return null;
  const cell = { c: Math.floor(bx), r: Math.floor(by) };
  const lx = Math.round(bx), ly = Math.round(by);
  const dx = Math.abs(bx - lx), dy = Math.abs(by - ly);
  const nearH = dy < 0.2 && ly >= 1 && ly <= ROWS - 1;
  const nearV = dx < 0.2 && lx >= 1 && lx <= COLS - 1;
  let wall: WallSpec | null = null;
  if (nearH && (!nearV || dy <= dx)) wall = { o: 'h', x: Math.min(COLS - 2, Math.max(0, lx - 1)), y: ly };
  else if (nearV) wall = { o: 'v', x: lx, y: Math.min(ROWS - 2, Math.max(0, ly - 1)) };
  return { cell, wall };
}

export function createRenderer(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  let L = computeLayout(1, 1, 1);
  const born = new Map<string, number>(); // wall key → first-seen time (pop-in animation)

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    L = computeLayout(w, h, dpr);
  }

  function drawWall(w: Wall, alpha: number, grow: number) {
    const { cell: c, ox, oy, dpr } = L;
    const p = PAL[w.owner];
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
    g.addColorStop(0, p.wl);
    g.addColorStop(0.5, p.mid);
    g.addColorStop(1, p.wd);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.shadowColor = p.glow;
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
    ctx.strokeStyle = '#d7d7e3';
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

    // legal-move dots
    const pulse = 0.5 + 0.5 * Math.sin(now / 380);
    for (const h of v.hints) {
      ctx.beginPath();
      ctx.arc(ox + (h.c + 0.5) * c, oy + (h.r + 0.5) * c, c * (0.11 + 0.012 * pulse), 0, TAU);
      ctx.fillStyle = `rgba(224,38,79,${0.26 + 0.14 * pulse})`;
      ctx.fill();
    }

    if (v.preview) drawWall(v.preview, 0.38, 1);

    // placed walls (pop-in on first sight)
    const live = new Set<string>();
    for (const w of v.state.walls) {
      const key = `${w.o}${w.x},${w.y}`;
      live.add(key);
      if (!born.has(key)) born.set(key, now);
      const p = Math.min(1, (now - born.get(key)!) / 220);
      const e = 1 - Math.pow(1 - p, 3);
      drawWall(w, Math.min(1, p * 3), e);
    }
    for (const k of born.keys()) if (!live.has(k)) born.delete(k);

    // balls, lower one on top
    const order: Player[] = v.balls[0].y <= v.balls[1].y ? [0, 1] : [1, 0];
    for (const i of order) {
      const b = v.balls[i];
      const cx = ox + b.x * c, cy = oy + b.y * c, r = c * 0.34;
      if (v.state.winner === i) {
        const k = 0.5 + 0.5 * Math.sin(now / 260);
        const hg = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * (2 + 0.4 * k));
        hg.addColorStop(0, PAL[i].glow);
        hg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = hg;
        ctx.beginPath(); ctx.arc(cx, cy, r * 2.4, 0, TAU); ctx.fill();
      }
      drawBall(cx, cy, r, PAL[i]);
    }
  }

  return { resize, draw, layout: () => L, resetFx: () => born.clear() };
}
