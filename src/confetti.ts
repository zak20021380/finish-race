/**
 * confetti.ts — the win burst. One canvas, a fixed particle pool allocated up front and
 * physics that never touch the heap, so the loop stays flat on a mid-range phone.
 * The caller decides whether to fire at all: nothing should burst under prefers-reduced-motion.
 */

const MAX = 120;
const GRAV = 1500;      // css px / s²
const DRAG = 0.55;
const COLORS = ['#e0264f', '#3057db', '#2fa86f', '#ffffff', '#b9b5d6', '#ff8aa3'];

interface P {
  x: number; y: number; vx: number; vy: number;
  rot: number; spin: number; w: number; h: number; c: number; ph: number; live: boolean;
}

export function createConfetti(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const pool: P[] = [];
  for (let i = 0; i < MAX; i++) {
    pool.push({ x: 0, y: 0, vx: 0, vy: 0, rot: 0, spin: 0, w: 0, h: 0, c: 0, ph: 0, live: false });
  }
  let w = 0, h = 0, dpr = 1, live = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    w = canvas.clientWidth; h = canvas.clientHeight;
    const cw = Math.max(1, Math.round(w * dpr)), ch = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
  }

  /** Two corner cannons firing up and inward. */
  function burst(count = 96) {
    resize();
    if (w < 2 || h < 2) return;
    for (let i = 0; i < MAX && count > 0; i++) {
      const p = pool[i];
      if (p.live) continue;
      const side = count % 2 === 0 ? 1 : -1;
      const a = -Math.PI / 2 - side * 0.4 + (Math.random() - 0.5) * 0.55;
      const sp = 760 + Math.random() * 640;
      p.x = w / 2 + side * w * 0.46;
      p.y = h * 1.01;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.rot = Math.random() * Math.PI;
      p.spin = (Math.random() - 0.5) * 9;
      p.w = 4 + Math.random() * 4;
      p.h = 7 + Math.random() * 7;
      p.c = (Math.random() * COLORS.length) | 0;
      p.ph = Math.random() * 6.283;
      p.live = true;
      live++;
      count--;
    }
  }

  function stop() {
    if (!live) return;
    live = 0;
    for (const p of pool) p.live = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function tick(dt: number, now: number) {
    if (!live) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const k = Math.exp(-dt * DRAG);
    for (let i = 0; i < MAX; i++) {
      const p = pool[i];
      if (!p.live) continue;
      p.vy = p.vy * k + GRAV * dt;
      p.vx *= k;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      if (p.y > h + 24 || p.x < -30 || p.x > w + 30) { p.live = false; live--; continue; }
      const tum = Math.abs(Math.sin(now / 170 + p.ph));           // flutter: the piece turns edge-on
      const hh = p.h * (0.3 + 0.7 * tum);
      const cs = Math.cos(p.rot), sn = Math.sin(p.rot);
      ctx.setTransform(dpr * cs, dpr * sn, -dpr * sn, dpr * cs, p.x * dpr, p.y * dpr);
      ctx.globalAlpha = Math.min(1, (h + 20 - p.y) / (h * 0.22));
      ctx.fillStyle = COLORS[p.c];
      ctx.fillRect(-p.w / 2, -hh / 2, p.w, hh);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  return { resize, burst, stop, tick };
}
