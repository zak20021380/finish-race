/**
 * bot.ts — local stand-in for a remote opponent, and the tactical brain behind Normal and Hard.
 *
 * The engine reads the board once and reasons about *every* contender, not just "the other side":
 * it ranks all opponents by their distance to FINISH (a primary threat and its trailing rivals),
 * prices each wall by what it costs the whole field, and keeps its wall budget for the moment a
 * wall actually bites. It understands the rolling log the way a human does — from the public clock
 * only (`hazard.on` / `round` / `nextHitRound`) and the board's geometry, never from the seed: a log
 * with no telegraph cannot be dodged, but a horizontal wall that blocks the trunk can be sheltered
 * behind, and a wall that forces a rival out of cover can be aimed for. Mines are buried on the
 * chokepoints several near-optimal routes share rather than on one deterministic line.
 *
 * Difficulty decides how the same evaluation is played, never the anti-stalemate invariant, which
 * every level obeys: it may only place a wall that leaves every ball a path to FINISH (`wallOk`), so
 * no number of walls can freeze a race.
 *   easy   — races greedily, walls rarely, wanders on a plain random step.
 *   normal — full multi-contender + hazard evaluation, softmax over near-optimal actions.
 *   hard   — the same, plus a top-K 2-ply reply check and a tighter softmax band.
 *
 * Leaps are part of the move set, not a special case: the candidates come from `steps()`, so a hop
 * over a rival is a candidate like any other, and the ground it gains is measured on `stepField` —
 * the distance that counts a body as one action to leap rather than a wall to walk around. That is
 * what lets the bot commit to a one-wide corridor instead of refusing it as impassable.
 *
 * It is fed `view(state, seat)` by the caller, so everything here reasons only about what a real
 * player could know: the opponent's hidden mines are not in `s`, and neither is the bot's answer.
 * All of it runs synchronously and its work is bounded — a wall slot that can bite nothing is never
 * priced, and only the slots nearest the balls get a distance field — so a turn stays inside the
 * budget on the widest, busiest board. `scripts/bot-tiers-check.mjs` measures it.
 */
import {
  allWalls, apply, ballById, distField, HAZARD, mineCells, pathOn, stepField, steps,
  wallBudget, wallOk, wallsClash, wallsRemaining,
  type Action, type Ball, type Cell, type GameState, type Player, type Pos, type Wall,
} from './rules';

export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard'];

interface Profile {
  /** odds of even looking for a wall this turn */
  wallRate: number;
  /** odds of spending the turn on a mine instead of racing */
  mineRate: number;
  /** 1 = score by the steps a turn gains; 2 = also play the whole round of replies out (2-ply) */
  lookahead: 1 | 2;
  /** odds of a plain random legal step — Easy's only unpredictability */
  noise: number;
  /** softmax band: how far below the best an action may sit and still be in the race (0 = off) */
  band: number;
  /** softmax temperature: how evenly the in-band actions share the odds */
  temp: number;
  /**
   * Extra bite a wall must show before it is judged worth the turn it costs. Hard asks for none —
   * whenever a wall pays it takes it — while Easy, which barely looks for one, still insists the
   * bite be large before it spends. The budget scaling in `wallThreshold` sits on top of this.
   */
  wallDemand: number;
  /** How much of a rival's optimal routes a trap must sit on to be worth the turn: chokepoint discipline. */
  mineDiscipline: number;
}

const PROFILES: Record<Difficulty, Profile> = {
  easy:   { wallRate: .25, mineRate: .10, lookahead: 1, noise: .40, band: 0,   temp: 0,   wallDemand: .6,  mineDiscipline: 0 },
  normal: { wallRate: .85, mineRate: .30, lookahead: 1, noise: 0,   band: .9,  temp: .45, wallDemand: .3,  mineDiscipline: .15 },
  hard:   { wallRate: 1,   mineRate: .50, lookahead: 2, noise: 0,   band: .3,  temp: .08, wallDemand: 0,   mineDiscipline: .5 },
};

/** How long the bot is seen to think: Hard looks sharp, Easy takes its time. */
export function botThinkMs(d: Difficulty): number {
  const span = d === 'hard' ? [380, 680] : d === 'easy' ? [780, 1480] : [650, 1100];
  return span[0] + Math.random() * (span[1] - span[0]);
}

const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]] as const;
/** A cell key on the board in play: the stride is the board's own width, never a constant. */
const key = (c: number, r: number, cols: number) => r * cols + c;
/** The most wall slots one turn will price, nearest the balls first — the turn's own work cap. */
const WALL_SLOTS = 48;
/** The largest row gap the slot ranking tracks (any board is shorter than this). */
const WALL_RANK_MAX = 31;

/* ---------- shared board reads ---------- */

/** A team's distance to FINISH off an already-computed field: its nearest ball is the race. */
function teamField(s: GameState, team: Player, d: Int16Array): number {
  let best = Infinity;
  for (const b of s.balls) {
    if (b.team !== team) continue;
    const v = d[b.pos.r * s.cols + b.pos.c];
    if (v >= 0 && v < best) best = v;
  }
  return best;
}

/** Every ball on the board still reaches FINISH with the field `d` standing — the anti-stalemate guard. */
function allReach(s: GameState, d: Int16Array): boolean {
  for (const b of s.balls) if (d[b.pos.r * s.cols + b.pos.c] < 0) return false;
  return true;
}

/** The ball of `team` closest to FINISH — the one a route is read from. */
function leadBallOf(s: GameState, team: Player, d: Int16Array): Ball | null {
  let best: Ball | null = null, v = Infinity;
  for (const b of s.balls) {
    if (b.team !== team) continue;
    const e = pathOn(d, b.pos, s.cols);
    if (e < v) { v = e; best = b; }
  }
  return best;
}

interface Contender { team: Player; dist: number }

/** Every opponent, nearest to FINISH first — the race's own threat ranking. */
function contenders(s: GameState, me: Player, d: Int16Array): Contender[] {
  const out: Contender[] = [];
  for (let t = 0; t < s.teams.length; t++) {
    if (t === me) continue;
    out.push({ team: t, dist: teamField(s, t, d) });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out;
}

/** How much a contender's progress matters: the nearer FINISH, the more a step there is worth. */
const threatWeight = (dist: number) => (Number.isFinite(dist) ? 1 / (1 + Math.max(0, dist)) : 0);

/* ---------- rolling-log intelligence (public clock + geometry only) ---------- */

/**
 * Is a cell under the trunk's cover? A log stops above the first horizontal wall blocking any lane
 * column, and a lane spans `logWidth` columns, so a ball in column `c` is sheltered when a
 * horizontal wall at or above its row covers a column within `logWidth - 1` of it. Never a peek at
 * the seed: the lane is unknown until it drops, so this reads the board, not the timetable.
 */
function isSheltered(walls: readonly Wall[], cols: number, c: number, r: number, extra?: Wall): boolean {
  const reach = HAZARD.logWidth - 1;
  const covers = (w: Wall) => w.o === 'h' && w.y <= r
    && (Math.abs(c - w.x) <= reach || Math.abs(c - (w.x + 1)) <= reach);
  for (const w of walls) if (covers(w)) return true;
  return extra !== undefined && covers(extra);
}

/**
 * Cells a side will not step onto if it can help it: only its own mines still in the ground. A mine
 * that has already gone off is spent and harmless, so treating it as a hazard would make the bot
 * refuse a corridor somebody once mined — a superstition that walls it out of its own escape route.
 */
function dangerCells(s: GameState, me: Player): Set<number> {
  const out = new Set<number>();
  for (const m of s.mines) if (!m.triggered && m.owner === me) out.add(key(m.cell.c, m.cell.r, s.cols));
  return out;
}

/* ---------- movement ---------- */

/** The cells a contender's lead ball could step onto next that walk it one step closer to FINISH. */
function blockTargets(s: GameState, d: Int16Array, team: Player): Set<number> {
  const out = new Set<number>();
  for (const b of s.balls) {
    if (b.team !== team) continue;
    const v = d[b.pos.r * s.cols + b.pos.c];
    if (v < 0) continue;
    for (const [dc, dr] of DIRS) {
      const c = b.pos.c + dc, r = b.pos.r + dr;
      if (c < 0 || c >= s.cols || r < 0 || r >= s.rows) continue;
      if (d[r * s.cols + c] === v - 1) out.add(r * s.cols + c);
    }
  }
  return out;
}

/** How many one-step-closer squares a contender's lead ball has right now — its lateral freedom. */
function bestStepCount(s: GameState, d: Int16Array, team: Player): number {
  const lb = leadBallOf(s, team, d);
  if (!lb) return 0;
  const v = d[lb.pos.r * s.cols + lb.pos.c];
  if (v < 0) return 0;
  let n = 0;
  for (const [dc, dr] of DIRS) {
    const c = lb.pos.c + dc, r = lb.pos.r + dr;
    if (c < 0 || c >= s.cols || r < 0 || r >= s.rows) continue;
    if (d[r * s.cols + c] === v - 1) n++;
  }
  return n;
}

function moveCandidates(
  s: GameState, me: Player, d: Int16Array, dfOpp: Int16Array, myD: number, foes: Contender[],
  hazardOn: boolean, imminent: boolean,
): Cand[] {
  const out: Cand[] = [];
  const opts = steps(s, me);
  if (!opts.length) return out;
  const danger = dangerCells(s, me);
  const K = (c: number, r: number) => key(c, r, s.cols);
  const blockFor = foes.map((f) => blockTargets(s, d, f.team));
  /* the log can only be sheltered behind when a horizontal wall exists to duck under */
  const cover = hazardOn && imminent && s.walls.some((w) => w.o === 'h');
  const half = Math.floor(s.rows / 2);
  for (const st of opts) {
    const b = ballById(s, st.ball);
    if (!b) continue;
    const before = pathOn(d, b.pos, s.cols);
    const after = pathOn(d, st.to, s.cols);
    if (!Number.isFinite(after)) continue;               // a sealed pocket is never a move
    const from = Number.isFinite(before) ? before : after;
    /* Ground is measured with the rivals' bodies on the board, not on the bare one: the walk counts
       a body as one action to leap, so a step that walks into a spot only a rival's own square can
       reach the line from is not ground gained. */
    const oppFrom = dfOpp[b.pos.r * s.cols + b.pos.c];
    const oppTo = dfOpp[st.to.r * s.cols + st.to.c];
    let sc: number;
    if (oppTo < 0) sc = oppFrom < 0 ? 0 : -3;            // cut off by bodies: refuse unless already stuck
    else if (oppFrom < 0) sc = 1.5;                      // a way out of the jam
    else sc = oppFrom - oppTo;
    /* body-blocking: standing on a square a contender wanted to step into next turn */
    for (let i = 0; i < foes.length; i++) {
      if (blockFor[i].has(K(st.to.c, st.to.r))) sc += 0.5 / (1 + i);
    }
    /* develop the second ball when the one in the lead is not the one moving */
    if (before > myD) sc += 0.15 * (from - after);
    /* the log: duck under cover, and do not walk an exposed ball into the upper rows unprotected */
    if (cover) {
      if (isSheltered(s.walls, s.cols, st.to.c, st.to.r)) sc += 0.5;
      else if (after < from && st.to.r <= half) sc -= 0.35;
    }
    out.push({ a: { kind: 'move', ball: st.ball, to: st.to }, s: sc, danger: danger.has(K(st.to.c, st.to.r)) });
  }
  return out;
}

/* ---------- wall strategy ---------- */

/** How high a wall's value must sit before it is worth spending, given the budget and the board. */
function wallThreshold(s: GameState, me: Player, foes: Contender[], demand: number): number {
  const total = Math.max(1, wallBudget(s.balls.length));
  const left = wallsRemaining(s, me);
  const scarcity = left / total;
  const lead = foes.length ? foes[0].dist : Infinity;
  const ending = Number.isFinite(lead) && lead <= 3;     // the sprint is on: spend freely
  const opening = Number.isFinite(lead) && lead > s.rows * 0.6;
  const crowd = 1 + Math.max(0, foes.length - 1) * 0.25; // a crowded board: hold more back
  /* scarce walls and a fresh board demand a bigger bite; an endgame lets a small one through.
     `demand` is the difficulty's own tempo bar: a wall is a turn not spent racing. */
  const reserve = 0.45 + 1.2 * (1 - scarcity) * (1 - scarcity);
  return reserve * crowd * (ending ? 0.4 : 1) * (opening ? 1.1 : 1) + demand;
}

/**
 * A candidate wall, scored across the whole field. A wall only bites when it costs the *leader* a
 * step or traps somebody in a severe detour; every contender it slows adds a little more, and the
 * threat ranking makes sure a wall that hands the race to a rival is not paid for. `self` is the
 * price paid in the bot's own steps, so it is never bought at that cost. Hazard bonuses are folded
 * in only when the log is on the clock: a dual-purpose wall that slows a rival and roofs the bot's
 * own advanced ball, or one that funnels a sheltered leader into an open lane.
 */
function wallCandidates(
  s: GameState, me: Player, d0: Int16Array, myD0: number, foes: Contender[],
  hazardOn: boolean, imminent: boolean,
): Cand[] {
  const out: Cand[] = [];
  if (wallsRemaining(s, me) <= 0) return out;
  const cols = s.cols, rows = s.rows;
  const leadFoe0 = foes.length ? foes[0].dist : Infinity;
  const foeFreedom0 = foes.map((f) => bestStepCount(s, d0, f.team));
  const myAdvanced = s.balls.filter((b) => b.team === me);
  /* The edges a shortest route can use: neighbours whose distance to FINISH differs by one. A wall
     that blocks none of them cannot lengthen any ball's route — on an open board a vertical wall is
     pure scenery, and even in a maze only a handful of slots bite — so it is skipped before the
     expensive walk. What is left is priced exactly as the rules would. */
  const critV = new Set<number>();                       // the edge above cell (c, r)
  const critH = new Set<number>();                       // the edge left of cell (c, r)
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const k = r * cols + c;
    if (d0[k] < 0) continue;
    if (r > 0) { const u = k - cols; if (d0[u] >= 0 && Math.abs(d0[u] - d0[k]) === 1) critV.add(k); }
    if (c > 0) { const l = k - 1; if (d0[l] >= 0 && Math.abs(d0[l] - d0[k]) === 1) critH.add(k); }
  }
  const bites = (o: 'h' | 'v', x: number, y: number) => (o === 'h'
    ? critV.has(y * cols + x) || critV.has(y * cols + x + 1)
    : critH.has(y * cols + x) || critH.has((y + 1) * cols + x));
  /* Which slots are worth a distance field: the ones that bite, priced nearest the balls first,
     because a detour only bites near where somebody is walking. Sorting encoded slots keeps the
     turn's work bounded on a wide, busy board — and a slot that bites nothing never gets a wall
     object built at all, which is the bulk of what the loop would otherwise allocate. */
  const slots: number[] = [];
  for (const o of ['h', 'v'] as const) {
    const y0 = o === 'h' ? 1 : 0, yEnd = o === 'h' ? rows - 1 : cols - 1;
    const x0 = o === 'h' ? 0 : 1, xEnd = o === 'h' ? cols - 2 : rows - 2;
    for (let y = y0; y < yEnd; y++) {
      let near = WALL_RANK_MAX;
      for (const b of s.balls) { const gap = Math.abs(b.pos.r - y); if (gap < near) near = gap; }
      for (let x = x0; x <= xEnd; x++) {
        if (!bites(o, x, y)) continue;
        slots.push((near << 11) | (o === 'v' ? 1 << 10 : 0) | (y << 6) | x);
      }
    }
  }
  slots.sort((a, b) => a - b);
  for (const slot of slots.slice(0, WALL_SLOTS)) {
    const o: 'h' | 'v' = (slot >> 10) & 1 ? 'v' : 'h';
    const y = (slot >> 6) & 15, x = slot & 63;
    const w: Wall = { o, x, y, owner: me };
    let clash = false;
    for (const p of s.walls) if (wallsClash(p, w)) { clash = true; break; }
    if (clash) continue;
    /* push/pop rather than a fresh array per candidate: the same loop owns both */
    s.walls.push(w);
    const d1 = distField(s.walls, cols, rows);
    s.walls.pop();
    if (!allReach(s, d1)) continue;                      // the anti-stalemate guard, wall by wall
    const myD1 = teamField(s, me, d1);
    const self = myD1 - myD0;
    let multiGain = 0, slowed = 0, maxCost = 0, leadAfter = Infinity;
    for (let i = 0; i < foes.length; i++) {
      const f = foes[i];
      const f1 = teamField(s, f.team, d1);
      const cost = f1 - f.dist;
      if (cost >= 1) { slowed++; if (cost > maxCost) maxCost = cost; }
      multiGain += Math.max(0, cost) * threatWeight(f.dist);
      if (f1 < leadAfter) leadAfter = f1;
    }
    const ledGain = leadAfter - leadFoe0;                // how much the *leader* is set back
    /* must bite the leader, or be a genuinely severe detour for somebody (a dead-end pocket) */
    if (ledGain < 1 && maxCost < 3) continue;
    let sc = multiGain
      + 0.45 * Math.max(0, slowed - 1)                   // collateral: slowing several at once
      + 0.35 * Math.max(0, maxCost - 2)                  // a severe detour / trapped contender
      - 1.2 * self;                                      // never at the bot's own expense
    /* funnel: strip a contender of the one-step squares it was counting on */
    for (let i = 0; i < foes.length; i++) {
      const after = bestStepCount(s, d1, foes[i].team);
      if (after < foeFreedom0[i]) sc += (0.25 + (imminent ? 0.35 : 0)) / (1 + i);
    }
    /* shield: roof the bot's own advanced balls so a log cannot shove them back down */
    if (hazardOn && imminent) {
      let roofed = 0;
      for (const b of myAdvanced) {
        if (!isSheltered(s.walls, cols, b.pos.c, b.pos.r)
          && isSheltered(s.walls, cols, b.pos.c, b.pos.r, w)) roofed++;
      }
      if (roofed) sc += (o === 'h' ? 0.7 : 0.4) * roofed;
    }
    out.push({ a: { kind: 'wall', wall: w }, s: sc });
  }
  return out;
}

/* ---------- chokepoint mines ---------- */

/** Shortest-path counts for one lead ball: how many optimal routes pass through each cell. */
interface Routes { fwd: Float64Array; back: Float64Array; total: number }

const PATH_CAP = 1e9;

/**
 * Every shortest route from `from` to FINISH, counted cell by cell. `back` counts the routes that
 * continue from a cell to FINISH; `fwd` counts the routes that reach a cell from `from`. Their
 * product, over the total, is the share of optimal routes a cell sits on — the chokepoint measure.
 */
function routesFrom(s: GameState, d: Int16Array, from: Pos): Routes {
  const n = s.cols * s.rows;
  const back = new Float64Array(n);
  const order: number[] = [];
  for (let i = 0; i < n; i++) if (d[i] >= 0) order.push(i);
  order.sort((a, b) => d[a] - d[b]);
  for (const i of order) {
    const v = d[i];
    if (v === 0) { back[i] = 1; continue; }
    let sum = 0;
    const c = i % s.cols, r = (i / s.cols) | 0;
    for (const [dc, dr] of DIRS) {
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || cc >= s.cols || rr < 0 || rr >= s.rows) continue;
      const nn = rr * s.cols + cc;
      if (d[nn] === v - 1) sum += back[nn];
    }
    back[i] = Math.min(PATH_CAP, sum);
  }
  const start = from.r * s.cols + from.c;
  const D = d[start];
  const fwd = new Float64Array(n);
  if (D >= 0) {
    fwd[start] = 1;
    const byD: number[][] = [];
    for (let i = 0; i < n; i++) if (d[i] >= 0 && d[i] <= D) (byD[d[i]] ??= []).push(i);
    for (let v = D; v > 0; v--) {
      for (const i of byD[v] ?? []) {
        const f = fwd[i];
        if (!f) continue;
        const c = i % s.cols, r = (i / s.cols) | 0;
        for (const [dc, dr] of DIRS) {
          const cc = c + dc, rr = r + dr;
          if (cc < 0 || cc >= s.cols || rr < 0 || rr >= s.rows) continue;
          const nn = rr * s.cols + cc;
          if (d[nn] === v - 1) fwd[nn] = Math.min(PATH_CAP, fwd[nn] + f);
        }
      }
    }
  }
  return { fwd, back, total: D >= 0 ? back[start] : 0 };
}

/** The share of a lead ball's optimal routes that pass through a cell, 0..1. */
const routeShare = (rt: Routes, d: Int16Array, cell: Cell, cols: number): number => {
  const i = cell.r * cols + cell.c;
  if (rt.total <= 0 || d[i] < 0 || rt.back[i] === 0 || rt.fwd[i] === 0) return 0;
  return Math.min(1, (rt.fwd[i] * rt.back[i]) / rt.total);
};

/** The squares a rival is forced to step onto when routing around a wall — hugging a bar. */
function sidestepCells(s: GameState): Set<number> {
  const out = new Set<number>();
  const add = (c: number, r: number) => { if (c >= 0 && c < s.cols && r >= 0 && r < s.rows) out.add(key(c, r, s.cols)); };
  for (const w of s.walls) {
    if (w.o === 'h') { add(w.x, w.y - 1); add(w.x + 1, w.y - 1); add(w.x, w.y); add(w.x + 1, w.y); }
    else { add(w.x - 1, w.y); add(w.x - 1, w.y + 1); add(w.x, w.y); add(w.x, w.y + 1); }
  }
  return out;
}

/**
 * The best trap to bury. It scores every legal cell by the chokepoint share of every contender's
 * optimal routes, the sooner a square is reached the better, biased to the mid and upper-mid rows
 * where a blast costs the most tempo, and to the squares that hug existing walls — where a rival
 * routing around a bar has to step. A square on the bot's own route is steered well clear of.
 */
function bestMine(s: GameState, me: Player, d: Int16Array, foes: Contender[]): { cell: Cell; value: number } | null {
  const cells = mineCells(s, me);
  if (!cells.length) return null;
  const sidestep = sidestepCells(s);
  const myLead = leadBallOf(s, me, d);
  const mine = myLead ? routesFrom(s, d, myLead.pos) : null;
  const rival = foes.map((f) => {
    const lb = leadBallOf(s, f.team, d);
    return lb ? { rt: routesFrom(s, d, lb.pos), d: f.dist } : null;
  });
  const half = Math.floor(s.rows / 2);
  let best: Cell | null = null, bestScore = -Infinity;
  for (const cell of cells) {
    let sc = 0;
    for (let i = 0; i < foes.length; i++) {
      const r = rival[i];
      if (!r) continue;
      const share = routeShare(r.rt, d, cell, s.cols);
      if (share <= 0) continue;
      const dCell = d[key(cell.c, cell.r, s.cols)];
      /* the sooner the contender will stand there, the more a blast costs it */
      const soon = r.d > 0 ? Math.max(0, 1 - (r.d - dCell) / (r.d + 1)) : 0;
      sc += (1 / (1 + i)) * share * (0.6 + 0.9 * soon);
    }
    if (sc <= 0) sc = 0.05;                              // still a legal trap; keep it in the running
    if (cell.r >= 2 && cell.r <= half) sc += 0.25;       // mid and upper-mid rows bite hardest
    if (sidestep.has(key(cell.c, cell.r, s.cols))) sc += 0.3;
    if (mine && routeShare(mine, d, cell, s.cols) > 0) sc -= 0.5;   // never on the bot's own route
    if (sc > bestScore) { bestScore = sc; best = cell; }
  }
  return best ? { cell: best, value: bestScore } : null;
}

/* ---------- 2-ply / selection ---------- */

interface Cand { a: Action; s: number; danger?: boolean }

/**
 * A clone with the log clock stripped. A simulated turn must not tick the hazard: the round close
 * would draw the next lane from the seed, and reading it back is exactly the telegraph the game
 * refuses to give anyone. Anything the bot simulates sees walls and balls only — never the future.
 */
const quiet = (s: GameState): GameState => (s.hazard ? { ...s, hazard: undefined, lastEvent: null } : s);

/**
 * One full round played out after a candidate: the bot acts, then every rival answers with the step
 * that walks its nearest ball furthest toward FINISH, in turn order, until the race comes back to
 * the bot. In a three- or four-way there is never just one reply, so modelling all of them — not
 * merely the next seat — is what stops a candidate that answers one rival from feeding another.
 * It is the second ply of Hard's search, and all of it runs on the clock-free clone: no simulated
 * turn may peek at the next log.
 */
function rolloutAdvantage(s: GameState, me: Player, a: Action): number | null {
  let t = apply(quiet(s), a);
  if (!t) return null;
  if (t.winner === me) return 1e3;
  if (t.winner !== null) return -1e3;
  for (let guard = 0; guard <= s.teams.length && t.winner === null && t.turn !== me; guard++) {
    const seat = t.turn;
    const d2 = distField(t.walls, t.cols, t.rows);
    let bestVal = teamField(t, seat, d2), best: { ball: number; to: Pos } | null = null;
    for (const st of steps(t, seat)) {
      const v = pathOn(d2, st.to, t.cols);
      if (v < bestVal) { bestVal = v; best = st; }
    }
    if (!best) break;                                    // the rival cannot advance: nothing more to model
    const moved = apply(quiet(t), { kind: 'move', ball: best.ball, to: best.to });
    if (!moved) break;
    t = moved;
  }
  if (t.winner === me) return 1e3;
  const d3 = distField(t.walls, t.cols, t.rows);
  const myD = teamField(t, me, d3);
  if (!Number.isFinite(myD)) return -1e3;
  let foeBest = Infinity;
  for (let foe = 0; foe < t.teams.length; foe++) {
    if (foe === me) continue;
    const v = teamField(t, foe, d3);
    if (v < foeBest) foeBest = v;
  }
  if (!Number.isFinite(foeBest)) foeBest = 1e3;          // no rival can reach FINISH at all
  return foeBest - myD;
}

/**
 * Fold the full-round reply check into the top candidates, so Hard answers every rival at once. The
 * best moves, the top wall and the trap all get a rollout: `extras` are candidates that must be
 * checked even when their one-ply score would not have made the cut, because the whole point of the
 * second ply is to find the action whose value only shows up once the rivals have answered.
 */
function refineTwoPly(
  s: GameState, me: Player, myD0: number, foes: Contender[], pool: Cand[], extras: readonly Cand[],
): void {
  if (!pool.length && !extras.length) return;
  const baseline = (foes.length ? foes[0].dist : Infinity) - myD0;
  const ranked = [...pool].sort((a, b) => b.s - a.s).slice(0, 8);
  for (const x of extras) if (!ranked.includes(x)) ranked.push(x);
  for (const c of ranked) {
    const v = rolloutAdvantage(s, me, c.a);
    if (v === null) continue;
    c.s += 0.5 * (v - (Number.isFinite(baseline) ? baseline : 0));
  }
}

/**
 * Weighted softmax across the actions that score within a tight band of the best: the exact move is
 * unpredictable from game to game, but a plainly worse action is never in the running. With the
 * band off (Easy) the best action simply wins.
 *
 * A move onto the bot's own live trap is dropped — but only while a safe move actually gains ground.
 * If every safe move is a step backwards, refusing the trap just wall it out of its own route and
 * shuffles forever; better to eat the blast and let the spent mine open the lane than to loop.
 */
function select(pool: Cand[], p: Profile): Action {
  if (!pool.length) return { kind: 'pass' };
  const safe = pool.filter((c) => !c.danger);
  let bestSafe = -Infinity;
  for (const c of safe) if (c.s > bestSafe) bestSafe = c.s;
  const use = safe.length && bestSafe > 0 ? safe : pool;
  let best = -Infinity;
  for (const c of use) if (c.s > best) best = c.s;
  if (p.band <= 0 || p.temp <= 0) {
    const top = use.filter((c) => c.s === best);
    return top[(Math.random() * top.length) | 0].a;
  }
  const band = use.filter((c) => c.s >= best - p.band);
  const weights = band.map((c) => Math.exp((c.s - best) / p.temp));
  let total = 0;
  for (const w of weights) total += w;
  let r = Math.random() * total;
  for (let i = 0; i < band.length; i++) { r -= weights[i]; if (r <= 0) return band[i].a; }
  return band[band.length - 1].a;
}

/** A uniformly random legal step — Easy's dive off the shortest path. */
function randomStep(s: GameState, me: Player): Action | null {
  const opts = steps(s, me);
  if (!opts.length) return null;
  const st = opts[(Math.random() * opts.length) | 0];
  return { kind: 'move', ball: st.ball, to: st.to };
}

/**
 * The turn. One distance field up front drives everything: the threat ranking, the candidate moves,
 * the wall pricing and the traps. Hard then pays for a top-K reply check before the softmax picks,
 * so its choice answers the rival's best answer; Normal softmaxes the 1-ply scores directly.
 */
export function botAction(s: GameState, difficulty: Difficulty = 'normal'): Action {
  const p = PROFILES[difficulty];
  const me = s.turn;
  const d = distField(s.walls, s.cols, s.rows);
  const myD = teamField(s, me, d);
  const foes = contenders(s, me, d);
  /* the board as it stands with every rival body on it — the metric the moves are judged on. It is
     `stepField`, not a fence: a body is a square to leap, not a wall to walk round, so a corridor
     two balls are wedged in is one action wide and the bot commits to it instead of refusing. */
  const dfOpp = stepField(s);
  const hz = s.hazard;
  const hazardOn = !!hz;
  /* the round cadence is public: a strike is imminent when the next hit round is this one or the
     next. Which lane it is stays unknown — the bot plans cover and tempo, never a peek at the seed. */
  const imminent = hazardOn && (hz!.nextHitRound - hz!.round) <= 1;

  /* Easy wanders: a plain random legal step, exactly as it always has, keeps it forgiving */
  if (p.noise > 0 && Math.random() < p.noise) {
    const wander = randomStep(s, me);
    if (wander) return wander;
  }

  /* the trap, if this turn is a mining turn: the best chokepoint across every rival's routes,
     kept only when it lands on enough of them to be worth the turn it costs to bury */
  let mine: Cand | null = null;
  if (Math.random() < p.mineRate) {
    const found = bestMine(s, me, d, foes);
    if (found && found.value >= p.mineDiscipline) mine = { a: { kind: 'mine', cell: found.cell }, s: 0 };
  }

  const pool: Cand[] = [];
  if (Math.random() < p.wallRate) {
    /* the budget speaks here: a wall that does not clear the threshold is not worth the spend */
    const thr = wallThreshold(s, me, foes, p.wallDemand);
    for (const c of wallCandidates(s, me, d, myD, foes, hazardOn, imminent)) if (c.s >= thr) pool.push(c);
  }
  pool.push(...moveCandidates(s, me, d, dfOpp, myD, foes, hazardOn, imminent));

  if (!pool.length) {
    if (mine) return mine.a;
    const st = randomStep(s, me);
    if (st) return st;
    for (const w of allWalls(me, s.cols, s.rows)) if (wallOk(s, w)) return { kind: 'wall', wall: w };
    return { kind: 'pass' };
  }

  if (p.lookahead >= 2) {
    /* the best wall goes into the reply check alongside the top moves — a wall that looks loud one
       ply out can be the wrong wall once the field has answered — and the trap is checked too */
    const extras: Cand[] = [];
    let bestWall: Cand | null = null;
    for (const c of pool) if (c.a.kind === 'wall' && (!bestWall || c.s > bestWall.s)) bestWall = c;
    if (bestWall) extras.push(bestWall);
    if (mine) extras.push(mine);
    refineTwoPly(s, me, myD, foes, pool, extras);
  }
  const chosen = select(pool, p);

  if (!mine) return chosen;
  /* a mining turn still races if racing is plainly better: the round rollout ranks the trap too */
  if (p.lookahead >= 2) {
    const trap = rolloutAdvantage(s, me, mine.a);
    const play = rolloutAdvantage(s, me, chosen);
    if (trap !== null && play !== null && trap > play + 0.5) return mine.a;
    return chosen;
  }
  return mine.a;
}
