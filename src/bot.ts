/**
 * bot.ts — local stand-in for a remote opponent, and the tactical brain behind Normal and Hard.
 *
 * The engine reads the board once and reasons about *every* contender, not just "the other side":
 * it ranks all opponents by their distance to FINISH (a primary threat and its trailing rivals),
 * prices each wall by what it costs the whole field, and keeps its wall budget for the moment a
 * wall actually bites. Mines are buried on the chokepoints several near-optimal routes share rather
 * than on one deterministic line.
 *
 * Difficulty decides how the same evaluation is played, never the anti-stalemate invariant, which
 * every level obeys: it prices only walls that leave every live pawn a path to FINISH, so a bot
 * never freezes its own race — and, for the same reason, never plays the checkmating wall by
 * accident. (A person may: `wallOk` lets a wall seal a rival, and the rules turn that into the
 * checkmate verdict.)
 *   easy   — races greedily, walls rarely, wanders on a plain random step.
 *   normal — full multi-contender evaluation, softmax over near-optimal actions.
 *   hard   — the same, plus a top-K 2-ply reply check and a tighter softmax band.
 *
 * Collisions are part of the move set, not a special case: the candidates come from `steps()`, so a
 * team-mate stepped over is a candidate like any other, and the ground it gains is measured on
 * `stepField()` — the distance that treats an opponent as a solid obstacle and a team-mate as one
 * action to go around. No illegal hop over a rival is ever priced.
 *
 * It is fed `view(state, seat)` by the caller, so everything here reasons only about what a real
 * player could know: the opponent's hidden mines are not in `s`, and neither is the bot's answer.
 * All of it runs synchronously and its work is bounded — a wall slot that can bite nothing is never
 * priced, and only the slots nearest the balls get a distance field — so a turn stays inside the
 * budget on the widest, busiest board. `scripts/bot-tiers-check.mjs` measures it.
 *
 * RACE STANDING is not a raw shortest path. Seat 0 opens every round, so with both balls on the
 * same row it reaches FINISH one turn before seat 1 — a tie on the distance field is a losing race
 * for every later seat. `contenders()` prices that half-step edge, and from Round 2 onward a bot
 * that sees the front-runner level or ahead answers it with a wall or a mine instead of mirroring
 * the walk. A rival within three steps of the line triggers mandatory interception. Waiting for a
 * rival to place an obstacle first, or for a two-tile deficit to appear, is never a strategy here.
 */
import {
  allWalls, apply, ballById, distField, mineCells, pathOn, stepField, steps,
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
  /** How hard this tier answers a front-runner that is level or ahead. Scales every interception
   *  bonus: Easy still shrugs most of the time, Hard commits its whole inventory. */
  aggression: number;
}

const PROFILES: Record<Difficulty, Profile> = {
  easy:   { wallRate: .25, mineRate: .10, lookahead: 1, noise: .40, band: 0,   temp: 0,   wallDemand: .6,  mineDiscipline: 0,    aggression: .4 },
  normal: { wallRate: .85, mineRate: .30, lookahead: 1, noise: 0,   band: .9,  temp: .45, wallDemand: .3,  mineDiscipline: .15, aggression: .85 },
  hard:   { wallRate: 1,   mineRate: .50, lookahead: 2, noise: 0,   band: .3,  temp: .08, wallDemand: 0,   mineDiscipline: .5,  aggression: 1 },
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
/**
 * The head start a seat earlier in the round cycle owns, in steps. Seat 0 takes the first turn of
 * every round, so on equal rows it crosses FINISH before seat 1 does. `effectiveOppDist` subtracts
 * this from a rival's shortest path; comparing raw distances calls that position a tie and is the
 * reason a whole field of bots used to walk quietly to a first-turn-priority loss.
 */
const TURN_EDGE = 0.5;
/** An opponent this close to FINISH puts the race in the red zone: interception is mandatory. */
const RED_ZONE = 3;

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

/** Every pawn still in the race reaches FINISH with the field `d` standing — the anti-stalemate guard. */
function allReach(s: GameState, d: Int16Array): boolean {
  for (const b of s.balls) if (!b.isCheckmated && d[b.pos.r * s.cols + b.pos.c] < 0) return false;
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

interface Contender {
  team: Player;
  /** Raw shortest path to FINISH — what a wall's cost is counted in. */
  dist: number;
  /** Race standing: `dist` less the half step a seat acting earlier in the round owns. */
  eff: number;
  /** Does this seat take its turn before `me` in every round? */
  actsBefore: boolean;
}

/**
 * Every opponent, front-runner first. Turn order is part of the standing, not an afterthought:
 * `effectiveOppDist = opponentShortestPath - 0.5` for any opponent that acts before the bot in the
 * round cycle. With everyone on the same row, the human at seat 0 therefore reads as WINNING to
 * every later seat, which is exactly the truth of a first-turn-priority sprint. `dist` stays raw so
 * a wall's bite is still measured in real steps; `eff` is what the race is judged on.
 */
function contenders(s: GameState, me: Player, d: Int16Array): Contender[] {
  const out: Contender[] = [];
  for (let t = 0; t < s.teams.length; t++) {
    if (t === me) continue;
    const dist = teamField(s, t, d);
    const actsBefore = t < me;
    out.push({ team: t, dist, eff: dist - (actsBefore ? TURN_EDGE : 0), actsBefore });
  }
  out.sort((a, b) => a.eff - b.eff || a.dist - b.dist || a.team - b.team);
  return out;
}

/** The front-runner's race standing, or Infinity when no rival can reach FINISH. */
const leaderEff = (foes: Contender[]): number => (foes.length ? foes[0].eff : Infinity);

/**
 * Is the front-runner level with us or ahead? Once turn order is priced in, "same row against an
 * earlier seat" is already a losing race. This is the signal that makes a bot spend an obstacle
 * instead of mirroring the leader's walk all the way to the line.
 */
const underPressure = (myD: number, foes: Contender[]): boolean => {
  const lead = leaderEff(foes);
  return Number.isFinite(lead) && Number.isFinite(myD) && lead <= myD;
};

/**
 * How many turns the race has actually played. `repeat.seen` files one fingerprint per real action,
 * plus the opening board, so its length is the round clock without a second piece of state. It caps
 * at `REPEAT_WINDOW`, which is far past round 2 — all this gate needs is "has a full cycle acted".
 * A state built without the ledger is a mid-race position: never mistake it for an opening.
 */
function turnsPlayed(s: GameState): number {
  const seen = s.repeat?.seen.length;
  return seen === undefined ? s.teams.length + 1 : Math.max(0, seen - 1);
}

/** Round 2 onward: a whole cycle of seats has acted, so the opening handshake is over. */
const isProactive = (s: GameState): boolean => turnsPlayed(s) >= s.teams.length;

/** A step across FINISH wins now — no wall, trap or interception is worth passing it up. */
function winningStep(s: GameState, me: Player): Action | null {
  const danger = dangerCells(s, me);
  for (const st of steps(s, me)) {
    /* a live trap of our own on the line would blow the ball back instead of winning */
    if (st.to.r === 0 && !danger.has(key(st.to.c, st.to.r, s.cols))) {
      return { kind: 'move', ball: st.ball, to: st.to };
    }
  }
  return null;
}

/** How much a contender's progress matters: the nearer FINISH, the more a step there is worth. */
const threatWeight = (dist: number) => (Number.isFinite(dist) ? 1 / (1 + Math.max(0, dist)) : 0);

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
): Cand[] {
  const out: Cand[] = [];
  const opts = steps(s, me);
  if (!opts.length) return out;
  const danger = dangerCells(s, me);
  const K = (c: number, r: number) => key(c, r, s.cols);
  const blockFor = foes.map((f) => blockTargets(s, d, f.team));
  for (const st of opts) {
    const b = ballById(s, st.ball);
    if (!b) continue;
    const before = pathOn(d, b.pos, s.cols);
    const after = pathOn(d, st.to, s.cols);
    if (!Number.isFinite(after)) continue;               // a sealed pocket is never a move
    const from = Number.isFinite(before) ? before : after;
    /* Ground is measured with every body on the board, not on the bare one: an opponent is a solid
       obstacle and a team-mate is one action to step over, so a destination reachable only by
       hopping a rival is never counted as ground gained. */
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
    out.push({ a: { kind: 'move', ball: st.ball, to: st.to }, s: sc, danger: danger.has(K(st.to.c, st.to.r)) });
  }
  return out;
}

/* ---------- wall strategy ---------- */

/**
 * How high a wall's value must sit before it is worth spending, given the budget and the board.
 * `urgency` is the pressure the race itself is under: it is NOT a difficulty setting. A front-runner
 * that is level or ahead turns a full wall stack from "reserve for later" into "spend now" — the old
 * unmodified reserve was the gate that let every bot hoard its walls through a straight sprint.
 */
function wallThreshold(s: GameState, me: Player, foes: Contender[], demand: number, urgency: number): number {
  const total = Math.max(1, wallBudget(s.balls.length));
  const left = wallsRemaining(s, me);
  const scarcity = left / total;
  const lead = foes.length ? foes[0].dist : Infinity;
  const ending = Number.isFinite(lead) && lead <= RED_ZONE;  // the sprint is on: spend freely
  const opening = Number.isFinite(lead) && lead > s.rows * 0.6;
  const crowd = 1 + Math.max(0, foes.length - 1) * 0.25; // a crowded board: hold more back
  /* scarce walls and a fresh board demand a bigger bite; an endgame lets a small one through.
     `demand` is the difficulty's own tempo bar: a wall is a turn not spent racing. */
  const reserve = 0.45 + 1.2 * (1 - scarcity) * (1 - scarcity);
  return Math.max(0, reserve * crowd * (ending ? 0.4 : 1) * (opening ? 1.1 : 1) + demand - urgency);
}

/** What the race is asking the wall search to do this turn. */
interface WallTactics {
  /** The front-runner by effective distance — every wall is priced against this seat first. */
  leader: Contender | null;
  /** Extra score for a wall that sets the front-runner back a step without costing us one. */
  boost: number;
  /** Red zone: a horizontal bar across the leader's very next step outranks everything. */
  emergency: boolean;
  /** Rank slots by this row rather than by every ball's row (interception near FINISH). */
  focusRow: number | null;
}

/**
 * A candidate wall, scored across the whole field. A wall only bites when it costs the FRONT-RUNNER
 * a step or traps somebody in a severe detour; every contender it slows adds a little more, and the
 * threat ranking makes sure a wall that hands the race to a rival is not paid for. `self` is the
 * price paid in the bot's own steps, so it is never bought at that cost.
 *
 * Leader targeting is explicit here: the old test read the new *minimum* over all rivals, so in a
 * 3- or 4-way a bar across the leader's lane was discarded whenever another rival on the same row
 * kept that minimum unchanged. That single gate is why whole fields of bots only ever walked.
 */
function wallCandidates(
  s: GameState, me: Player, d0: Int16Array, myD0: number, foes: Contender[], tac: WallTactics,
): Cand[] {
  const out: Cand[] = [];
  if (wallsRemaining(s, me) <= 0) return out;
  const cols = s.cols, rows = s.rows;
  const leadFoe0 = foes.length ? foes[0].dist : Infinity;
  const foeFreedom0 = foes.map((f) => bestStepCount(s, d0, f.team));
  const leadPos = tac.leader && Number.isFinite(tac.leader.dist)
    ? (leadBallOf(s, tac.leader.team, d0)?.pos ?? null)
    : null;
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
    /* x is the column and y the row for BOTH orientations (`Wall` names them that way, and so do
       wallOk / wallsClash / sidestepCells). A vertical wall spans rows y..y+1 at column x, so its
       row runs to rows-2 and its column to cols-1. The old swapped ranges built out-of-bounds
       vertical walls that the distance field could not even see. */
    const y0 = o === 'h' ? 1 : 0, yEnd = rows - 1;
    const x0 = o === 'h' ? 0 : 1, xEnd = o === 'h' ? cols - 2 : cols - 1;
    for (let y = y0; y < yEnd; y++) {
      let near = WALL_RANK_MAX;
      if (tac.focusRow !== null) near = Math.min(WALL_RANK_MAX - 1, Math.abs(tac.focusRow - y));
      else for (const b of s.balls) { const gap = Math.abs(b.pos.r - y); if (gap < near) near = gap; }
      for (let x = x0; x <= xEnd; x++) {
        if (!bites(o, x, y)) continue;
        slots.push((near << 11) | (o === 'v' ? 1 << 10 : 0) | (y << 6) | x);
      }
    }
  }
  slots.sort((a, b) => a - b);
  /* A PRIVATE scratch array, never `s.walls`: `botAction` is handed `view(state, seat)`, a shallow
     projection that still SHARES the live board's wall array. Pushing onto it — even with a
     balancing pop — is an in-place write to live game state during lookahead. One array per turn
     keeps the old push/pop allocation discipline without ever touching the caller's board. */
  const trial: Wall[] = s.walls.slice();
  for (const slot of slots.slice(0, WALL_SLOTS)) {
    const o: 'h' | 'v' = (slot >> 10) & 1 ? 'v' : 'h';
    const y = (slot >> 6) & 15, x = slot & 63;
    const w: Wall = { o, x, y, owner: me };
    let clash = false;
    for (const p of s.walls) if (wallsClash(p, w)) { clash = true; break; }
    if (clash) continue;
    /* push/pop on the private scratch: the same loop owns both, and no live state is ever written */
    trial.push(w);
    const d1 = distField(trial, cols, rows);
    trial.pop();
    if (!allReach(s, d1)) continue;                      // the anti-stalemate guard, wall by wall
    const myD1 = teamField(s, me, d1);
    const self = myD1 - myD0;
    let multiGain = 0, slowed = 0, maxCost = 0, leadAfter = Infinity, leaderCost = 0;
    for (let i = 0; i < foes.length; i++) {
      const f = foes[i];
      const f1 = teamField(s, f.team, d1);
      const cost = f1 - f.dist;
      if (i === 0) leaderCost = cost;                     // the front-runner, by effective distance
      if (cost >= 1) { slowed++; if (cost > maxCost) maxCost = cost; }
      multiGain += Math.max(0, cost) * threatWeight(f.eff);
      if (f1 < leadAfter) leadAfter = f1;
    }
    const standingGain = leadAfter - leadFoe0;            // how far the whole standing is pushed
    /* Must bite the FRONT-RUNNER, or trap somebody in a genuinely severe detour. Testing only the
       new minimum (`standingGain`) silently discarded every leader-blocking wall in a 3- or 4-way:
       another rival on the same row left that minimum unchanged. */
    if (leaderCost < 1 && maxCost < 3) continue;
    let sc = multiGain
      + 0.45 * Math.max(0, slowed - 1)                   // collateral: slowing several at once
      + 0.35 * Math.max(0, maxCost - 2)                  // a severe detour / trapped contender
      + 0.15 * Math.max(0, standingGain)                 // the standing itself is pushed back
      - 1.2 * self;                                      // never at the bot's own expense
    /* Proactive offense: a bar that adds >= 1 step to the front-runner WITHOUT lengthening our
       own route is worth the turn on Normal and Hard, from Round 2 onward. A full stack of walls
       is worth nothing once somebody crosses the line. */
    if (tac.boost > 0 && leaderCost >= 1 && self <= 0) {
      sc += tac.boost * (1 + 0.5 * Math.max(0, leaderCost - 1));
    }
    /* A horizontal bar on the leader's own row blocks its very next step up. In the red zone that
       is the interception — it can stop the step into FINISH outright. */
    const frontal = leadPos !== null && w.o === 'h' && w.y === leadPos.r
      && w.x <= leadPos.c && leadPos.c <= w.x + 1;
    if (tac.emergency && frontal) sc += 1.2;
    /* funnel: strip a contender of the one-step squares it was counting on */
    for (let i = 0; i < foes.length; i++) {
      const after = bestStepCount(s, d1, foes[i].team);
      if (after < foeFreedom0[i]) sc += 0.25 / (1 + i);
    }
    out.push({ a: { kind: 'wall', wall: w }, s: sc, bite: leaderCost, frontal, selfCost: self });
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

/** The trap the bot would bury, plus what it does to the front-runner's lane. */
interface MinePick {
  cell: Cell;
  value: number;
  /** Does one of the front-runner's shortest routes pass through this cell? */
  onPath: boolean;
  /** How many steps ahead of the front-runner the charge sits. */
  ahead: number;
}

/** What the race is asking the trap search to do this turn. */
interface MineTactics {
  /** Actively hunt the front-runner's lane, not just generic chokepoints. */
  intercept: boolean;
  /** Red zone: a charge on the FINISH row can stop the winning step outright. */
  emergency: boolean;
  /** Seat stagger so a crowd of bots does not all bury on the same square of one lane. */
  seat: Player;
}

/**
 * The best trap to bury. It scores every legal cell by the chokepoint share of every contender's
 * optimal routes, the sooner a square is reached the better, biased to the mid and upper-mid rows
 * where a blast costs the most tempo, and to the squares that hug existing walls — where a rival
 * routing around a bar has to step. A square on the bot's own route is steered well clear of.
 *
 * On top of that reading, a charge on the FRONT-RUNNER's shortest path one or two tiles ahead is
 * the single most valuable use of the mine against a straight sprint: the leader walks onto it
 * before it can be routed around, and the blast throws it back two rows. In the red zone the FINISH
 * row itself is included, so the charge can cancel the winning step.
 */
function bestMine(s: GameState, me: Player, d: Int16Array, foes: Contender[], tac: MineTactics): MinePick | null {
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
  let best: Cell | null = null, bestScore = -Infinity, bestOnPath = false, bestAhead = Infinity;
  for (const cell of cells) {
    let sc = 0;
    const cellD = d[key(cell.c, cell.r, s.cols)];
    for (let i = 0; i < foes.length; i++) {
      const r = rival[i];
      if (!r) continue;
      const share = routeShare(r.rt, d, cell, s.cols);
      if (share <= 0) continue;
      /* the sooner the contender will stand there, the more a blast costs it */
      const soon = Number.isFinite(r.d) && r.d > 0 ? Math.max(0, 1 - (r.d - cellD) / (r.d + 1)) : 0;
      sc += (1 / (1 + i)) * share * (0.6 + 0.9 * soon);
    }
    if (sc <= 0) sc = 0.05;                              // still a legal trap; keep it in the running
    if (cell.r >= 2 && cell.r <= half) sc += 0.25;       // mid and upper-mid rows bite hardest
    if (sidestep.has(key(cell.c, cell.r, s.cols))) sc += 0.3;
    /* a charge on our own lane would blow OUR ball back — outweigh any lane bonus below */
    const myShare = mine ? routeShare(mine, d, cell, s.cols) : 0;
    if (myShare > 0) sc -= 0.5 + 1.5 * myShare;

    const lead = rival[0];
    const share0 = lead ? routeShare(lead.rt, d, cell, s.cols) : 0;
    const ahead = lead && Number.isFinite(lead.d) ? lead.d - cellD : Infinity;
    const onPath = share0 > 0 && Number.isFinite(ahead) && ahead >= 1;
    if (onPath) {
      if (tac.intercept) {
        /* the earlier seat wins a tie, so a charge on its lane is worth a little more still */
        if (foes[0]?.actsBefore) sc += 0.15;
        if (ahead <= 2) sc += 1.2;                      // 1-2 tiles ahead of a sprinting leader
        else if (ahead <= 4) sc += 0.55;
        /* de-confliction: seats spread their charges along the lane instead of stacking them */
        if (ahead === 1 + (tac.seat % 3)) sc += 0.2;
      }
      if (tac.emergency && cell.r <= 1) sc += 1.4;      // stop the step into FINISH
    }
    if (sc > bestScore) { bestScore = sc; best = cell; bestOnPath = onPath; bestAhead = ahead; }
  }
  return best ? { cell: best, value: bestScore, onPath: bestOnPath, ahead: bestAhead } : null;
}

/* ---------- 2-ply / selection ---------- */

interface Cand {
  a: Action;
  s: number;
  danger?: boolean;
  /** Walls only: steps this bar adds to the front-runner's shortest path. */
  bite?: number;
  /** Walls only: does it sit across the front-runner's very next step? */
  frontal?: boolean;
  /** Walls only: steps it costs the bot's own path (0 = free). */
  selfCost?: number;
}

/**
 * One full round played out after a candidate: the bot acts, then every rival answers with the step
 * that walks its nearest ball furthest toward FINISH, in turn order, until the race comes back to
 * the bot. In a three- or four-way there is never just one reply, so modelling all of them — not
 * merely the next seat — is what stops a candidate that answers one rival from feeding another.
 * It is the second ply of Hard's search.
 */
function rolloutAdvantage(s: GameState, me: Player, a: Action): number | null {
  let t = apply(s, a);
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
    const moved = apply(t, { kind: 'move', ball: best.ball, to: best.to });
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
    /* the same half-step edge the standing is priced with: a seat that plays before us in every
       round is closer to FINISH than its raw distance says */
    const v = teamField(t, foe, d3) - (foe < me ? TURN_EDGE : 0);
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
  const baseline = leaderEff(foes) - myD0;
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
 * The turn. One distance field up front drives everything: the turn-order-aware threat ranking,
 * the candidate moves, the wall pricing and the traps. Hard then pays for a top-K reply check
 * before the softmax picks, so its choice answers the rival's best answer; Normal softmaxes the
 * 1-ply scores directly.
 *
 * Walls and mines are ACTIONS in the same pool as the steps, not side effects decided after the
 * pick. The old shape kept the trap outside the pool and handed it to a one-round rollout on Hard,
 * which could not see a charge buried two rows ahead — so Hard never spent a mine, and every tier
 * walked to FINISH holding its whole inventory.
 */
export function botAction(s: GameState, difficulty: Difficulty = 'normal'): Action {
  const p = PROFILES[difficulty];
  const me = s.turn;
  const d = distField(s.walls, s.cols, s.rows);
  const myD = teamField(s, me, d);
  const foes = contenders(s, me, d);
  const leader = foes.length ? foes[0] : null;
  const leadDist = leader ? leader.dist : Infinity;
  /* the board as it stands with every rival body on it — the metric the moves are judged on. It is
     `stepField`, not a fence: an opponent is a solid obstacle, while a team-mate is one action to
     step over, so the bot prices exactly the moves `steps()` will accept. */
  const dfOpp = stepField(s);

  /* A step across FINISH wins this turn. No interception is worth passing that up: in the red zone
     a forced block could otherwise cost the bot its own win. */
  const win = winningStep(s, me);
  if (win) return win;

  /* Race standing. `foes` already has turn order priced in, so a field of balls on equal rows
     reads as a human at seat 0 WINNING the race, not as a tie to be mirrored. */
  const pressure = underPressure(myD, foes);
  const emergency = foes.some((f) => Number.isFinite(f.dist) && f.dist <= RED_ZONE && f.eff <= myD);
  const assertive = isProactive(s) && pressure;
  /* Unspent walls and mines are worth nothing once somebody crosses the line. The nearer the
     front-runner gets, the more a single bite is worth the turn it costs. */
  const urgency = Number.isFinite(leadDist) ? Math.max(0, 1 - leadDist / Math.max(1, s.rows)) : 0;

  /* Easy wanders: a plain random legal step, exactly as it always has, keeps it forgiving */
  if (p.noise > 0 && Math.random() < p.noise) {
    const wander = randomStep(s, me);
    if (wander) return wander;
  }

  /* The trap. From Round 2 onward a bot hunts for one on its own — it does NOT wait for the human
     to place an obstacle first. The old random rate is only the opening's tempo knob now. The
     discipline floor is likewise dropped under pressure: a legal charge on the leader's lane beats
     another passive forward step. */
  let minePick: MinePick | null = null;
  let mine: Cand | null = null;
  if (assertive || emergency || Math.random() < p.mineRate) {
    const found = bestMine(s, me, d, foes, { intercept: assertive || emergency, emergency, seat: me });
    if (found && (assertive || emergency || found.value >= p.mineDiscipline)) {
      minePick = found;
      const lane = found.onPath ? 0.9 : 0;
      const close = found.onPath && found.ahead >= 1 && found.ahead <= 2 ? 0.5 : 0;
      const stop = emergency && found.onPath ? 0.8 : 0;
      const init = assertive ? 0.7 : 0;
      const score = (0.35 * Math.min(2, found.value) + lane + close + stop + init)
        * (0.6 + 0.4 * p.aggression) * (assertive || emergency ? 1 : 0.75);
      mine = { a: { kind: 'mine', cell: found.cell }, s: score };
    }
  }

  /* Walls, likewise forced once the opening is over and the front-runner is level or ahead.
     Normal and Hard get the front-runner bite boost; every tier targets the lowest effective
     distance, so in 3P/4P each bot that comes to the turn answers Player 0's sprint rather than
     waiting for a different bot to do it. */
  const wallBoost = assertive || emergency
    ? (0.4 + 0.25 * p.aggression) * (0.7 + 0.9 * urgency) * (emergency ? 1.6 : 1)
    : 0;
  const walls = assertive || emergency || Math.random() < p.wallRate
    ? wallCandidates(s, me, d, myD, foes, {
        leader, boost: wallBoost, emergency,
        focusRow: emergency && leader ? (leadBallOf(s, leader.team, d)?.pos.r ?? null) : null,
      })
    : [];

  /* MANDATORY ENDGAME INTERCEPTION. With a rival 1-3 steps from FINISH and its effective distance
     no worse than ours, walking forward is forbidden if any legal wall or trap can lengthen the
     front-runner's path or block its step into the line. A charge on the lane wins the tie. */
  if (emergency) {
    let block: Cand | null = null;
    for (const w of walls) {
      if ((w.bite ?? 0) < 1 && !w.frontal) continue;
      /* the highest-scoring interceptor wins; on a tie prefer the bar that costs us no ground */
      if (!block || w.s > block.s
        || (w.s === block.s && (w.selfCost ?? 0) < (block.selfCost ?? 0))) block = w;
    }
    if (mine && minePick?.onPath && (!block || mine.s >= block.s)) return mine.a;
    if (block) return block.a;
    if (mine && minePick?.onPath) return mine.a;
  }

  /* No full stack ever crosses the line. Once the trap is spent (or there is none to spend), the
     bot opens its wall inventory on the first bar that sets the front-runner back without costing
     its own route. This fires from Round 2 onward on the bot's own reading of the race — it never
     waits for a rival obstacle or for a two-tile deficit to appear. */
  if (assertive && !emergency && !mine && wallsRemaining(s, me) >= wallBudget(s.balls.length)) {
    let first: Cand | null = null;
    for (const w of walls) {
      if ((w.bite ?? 0) < 1 || (w.selfCost ?? 0) > 0) continue;
      if (!first || w.s > first.s) first = w;
    }
    if (first) return first.a;
  }

  const pool: Cand[] = [];
  /* Under pressure the budget reserve gives way: a wall that bites is worth the turn even on a
     fresh board with a full stack. That reserve was the gate that produced the hoarding sprint. */
  const thr = wallThreshold(s, me, foes, p.wallDemand, emergency ? 2 : assertive ? 1 : 0);
  for (const w of walls) if (w.s >= thr) pool.push(w);
  pool.push(...moveCandidates(s, me, d, dfOpp, myD, foes));
  if (mine) pool.push(mine);

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
  return select(pool, p);
}
