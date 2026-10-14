/**
 * bot.ts — local stand-in for a remote opponent.
 * Works for any team size: it moves the ball closest to FINISH, walls only when it is worth the
 * wait, and buries a mine now and then on the route the opponent is walking. Difficulty decides how
 * often it walls, how far it looks ahead, how often it mines and how much it wanders — never the
 * anti-stalemate invariant below, which every level obeys.
 *
 * The rolling log is nothing to plan around: its lane is drawn from the seed the instant its round
 * closes, so there is no telegraph here to read. The bot races on and takes whatever drops, exactly
 * as a human does when the strike alert refuses their tap.
 *
 * It is fed `view(state, seat)` by the caller, so everything here reasons only about what a real
 * player could know: the opponent's hidden mines are not in `s`, and neither is the bot's answer.
 */
import {
  allWalls, ballById, ballPath, distField, doWall, mineCells, nextTeam,
  pathLen, pathOn, steps, wallsRemaining,
  type Action, type GameState, type Player, type Pos, type Step, type Wall,
} from './rules';

export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard'];

interface Profile {
  /** odds of playing the best wall it found instead of just racing */
  wallRate: number;
  /** odds of spending a turn on a mine instead of racing */
  mineRate: number;
  /** 1 = a wall is judged by the steps it costs; 2 = also demands the position stays level or ahead */
  lookahead: 1 | 2;
  /** odds of ignoring the shortest path for a random legal step */
  noise: number;
}

const PROFILES: Record<Difficulty, Profile> = {
  easy:   { wallRate: .25, mineRate: .1, lookahead: 1, noise: .4 },
  normal: { wallRate: .85, mineRate: .3, lookahead: 1, noise: .12 },
  hard:   { wallRate: 1,   mineRate: .5, lookahead: 2, noise: 0 },
};

/** How long the bot is seen to think: Hard looks sharp, Easy takes its time. */
export function botThinkMs(d: Difficulty): number {
  const span = d === 'hard' ? [380, 680] : d === 'easy' ? [780, 1480] : [650, 1100];
  return span[0] + Math.random() * (span[1] - span[0]);
}

const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]] as const;
/** A cell key on the board in play: the stride is the board's own width, never a constant. */
const key = (c: number, r: number, cols: number) => r * cols + c;

/**
 * The cells on the shortest route from `from` to FINISH, nearest the ball first. Walking strictly
 * downhill on the distance field is enough: a neighbour one step closer is by definition reachable.
 */
function route(d: Int16Array, from: Pos, cols: number, rows: number): Pos[] {
  const out: Pos[] = [];
  let { c, r } = from;
  let v = d[key(c, r, cols)];
  if (v < 0) return out;
  while (v > 0 && out.length < cols * rows) {
    let nc = c, nr = r;
    for (const [dc, dr] of DIRS) {
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue;
      if (d[key(cc, rr, cols)] === v - 1) { nc = cc; nr = rr; break; }
    }
    if (nc === c && nr === r) break;              // sealed in: no downhill step left
    c = nc; r = nr; v = d[key(c, r, cols)];
    out.push({ c, r });
  }
  return out;
}

/** Cells the bot will not step into if it can help it: mines that already went off, plus its own. */
function dangerOf(s: GameState, me: Player): Set<number> {
  const out = new Set<number>();
  for (const m of s.mines) {
    // a spent mine is harmless, but it marks a lane somebody chose to mine — and its own traps
    // are still in the ground, so the bot must not walk into them either
    if (m.triggered || m.owner === me) out.add(key(m.cell.c, m.cell.r, s.cols));
  }
  return out;
}

/** The foe's ball nearest FINISH — the one its route is read from. */
function leadBall(s: GameState, foe: Player, d: Int16Array): Pos {
  let best = s.balls[0].pos, v = Infinity;
  for (const b of s.balls) {
    if (b.team !== foe) continue;
    const e = pathOn(d, b.pos, s.cols);
    if (e < v) { v = e; best = b.pos; }
  }
  return best;
}

/**
 * The bot walls only where a wall pays for itself: while the opponent is level or ahead, and only
 * with a wall that costs the opponent 2+ steps. Such a wall always leaves the bot ahead, so it
 * stops walling until the opponent claws that back — and since `wallOk` refuses any wall that
 * seals a ball in, no number of walls can ever freeze the race.
 */
export function botAction(s: GameState, difficulty: Difficulty = 'normal'): Action {
  const p = PROFILES[difficulty];
  const me = s.turn, foe = nextTeam(s, me);
  const myD = pathLen(s, me), foeD = pathLen(s, foe);
  const d = distField(s.walls, s.cols, s.rows);
  const k = (c: number, r: number) => key(c, r, s.cols);

  if (Math.random() < p.mineRate) {
    const spots = mineCells(s, me);
    if (spots.length) {
      const onRoute = new Set(route(d, leadBall(s, foe, d), s.cols, s.rows).map((c) => k(c.c, c.r)));
      // anywhere the foe is heading, biased to the squares it reaches soonest
      const ahead = spots.filter((c) => onRoute.has(k(c.c, c.r)));
      const pool = (ahead.length ? ahead : spots).slice(0, 8);
      return { kind: 'mine', cell: pool[(Math.random() * pool.length) | 0] };
    }
  }

  if (foeD <= myD && wallsRemaining(s, me) > 0 && Math.random() < p.wallRate) {
    let best: Wall | null = null;
    let bestScore = 0;
    let bestSelf = Infinity;
    for (const w of allWalls(me, s.cols, s.rows)) {
      const t = doWall(s, w);
      if (!t) continue;
      const cost = pathLen(t, foe) - foeD;
      if (cost < 2) continue;
      const self = pathLen(t, me) - myD;
      // looking a ply further: keep the wall only if it still leaves the bot level or ahead
      if (p.lookahead > 1 && pathLen(t, me) > pathLen(t, foe)) continue;
      const score = cost - self * 2;
      if (!best || score > bestScore || (score === bestScore && self < bestSelf)) { best = w; bestScore = score; bestSelf = self; }
    }
    if (best) return { kind: 'wall', wall: best };
  }

  let mySteps = steps(s, me);
  const score = (q: Pos) => { const v = d[k(q.c, q.r)]; return v < 0 ? 999 : v; };
  if (mySteps.length) {
    if (p.noise > 0 && Math.random() < p.noise) {
      const st = mySteps[(Math.random() * mySteps.length) | 0];
      return { kind: 'move', ball: st.ball, to: st.to };
    }
    const min = Math.min(...mySteps.map((st) => score(st.to)));
    // among the cells that gain the most ground, play the ball that is already closest to the line
    let pool = mySteps.filter((st) => score(st.to) === min);
    const danger = dangerOf(s, me);
    const wary = pool.filter((st) => !danger.has(k(st.to.c, st.to.r)));
    if (wary.length) pool = wary;                 // never a hard ban: a bot with one way out takes it
    const near = new Map<number, number>();
    for (const st of pool) {
      if (near.has(st.ball)) continue;
      const b = ballById(s, st.ball);
      if (b) near.set(st.ball, ballPath(s, b));
    }
    const lead = Math.min(...near.values());
    const leadPool = pool.filter((st) => near.get(st.ball) === lead);
    const pick = leadPool[(Math.random() * leadPool.length) | 0];
    return { kind: 'move', ball: pick.ball, to: pick.to };
  }

  for (const w of allWalls(me, s.cols, s.rows)) if (doWall(s, w)) return { kind: 'wall', wall: w };
  return { kind: 'pass' };
}
