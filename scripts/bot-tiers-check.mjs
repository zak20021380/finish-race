/**
 * bot-tiers-check.mjs — head-to-head run for the bot's difficulty tiers in src/bot.ts. No DOM.
 * Run: node --experimental-strip-types scripts/bot-tiers-check.mjs
 *
 * The three levels are one evaluation played to different depths: Easy races greedily and wanders,
 * Normal softmaxes a one-ply read, Hard adds a full-round reply check over the top moves, walls and
 * trap. This file makes them race each other on the real rules — 2-player duels and 4-way
 * free-for-alls, the rolling log live on every board — and pins down four promises:
 *
 *   1. the ladder is real: Hard beats Normal and Normal beats Easy, on both board sizes, by a
 *      margin that is not one lucky board (a one-sided binomial test on the pooled sample);
 *   2. it is legal: over every turn of every match the bot only ever proposes a move or a wall the
 *      rules accept. The one refusal the fog can force is a mine on a square a rival had already
 *      mined, which `main.ts` recovers from, so those are counted and must be recovered rather than
 *      treated as illegal;
 *   3. it finishes: no match runs to the cap — a bot never locks a race into an endless wall loop
 *      or a pocket shuffle;
 *   4. it is fast: a turn is a bounded handful of distance fields, inside the 15ms budget.
 *
 * Everything is seeded, including `Math.random`, so a run is reproducible. `SEED` and `GAMES`
 * override the defaults.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* rules.ts ↔ hazards.ts ↔ bot.ts say `from './rules'` / `'./hazards'`, which Vite resolves and Node
   does not. Rewrite the specifiers into generated twins in .shots/, exactly as the other checks do,
   so what is under test is rebuilt from src on every run and all three share one instance each. */
const NAMES = ['rules', 'hazards', 'bot'];
const HREF = Object.fromEntries(NAMES.map((n) => [n, pathToFileURL(path.resolve('.shots', `tiers-${n}.ts`)).href]));
fs.mkdirSync('.shots', { recursive: true });
for (const n of NAMES) {
  const src = fs.readFileSync(path.join('src', `${n}.ts`), 'utf8')
    .replace(/from '\.\/(rules|hazards|bot)'/g, (_m, m) => `from '${HREF[m]}'`);
  fs.writeFileSync(new URL(HREF[n]), src);
}
const { newGame, apply, view, steps } = await import(HREF.rules);
const { botAction } = await import(HREF.bot);

/** Seeded mulberry32, installed as `Math.random` so the whole run is deterministic and repeatable. */
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(Number(process.env.SEED || 0x5eed));
Math.random = rnd;

let run = 0;
const check = (name, fn) => { fn(); run++; console.log('ok -', name); };

const GAMES = Number(process.env.GAMES || 400);
const MAX_TURNS = 1500;                                   // a race this long is a stall, not a game

/**
 * One whole match: the tiers in `seats` race on a fresh hazard board until a ball crosses FINISH.
 * A refused action is recovered the way `main.ts` recovers it — carry on racing — so a fog-refused
 * mine never throws a turn away and never ends a match.
 */
function playMatch(sizes, seats) {
  let s = newGame(sizes, { hazards: true, seed: (rnd() * 0x7fffffff) | 0 });
  const times = [];
  let refusedMine = 0, refusedAction = 0, turns = 0;
  for (; turns < MAX_TURNS && s.winner === null; turns++) {
    const t0 = performance.now();
    const a = botAction(view(s, s.turn), seats[s.turn % seats.length]);
    times.push(performance.now() - t0);
    tally.kind[a.kind]++;
    let next = apply(s, a);
    if (!next) {
      if (a.kind === 'mine') refusedMine++; else refusedAction++;   // only a fog-hidden mine may be refused
      const st = steps(s, s.turn)[0];
      next = st ? apply(s, { kind: 'move', ball: st.ball, to: st.to }) : apply(s, { kind: 'pass' });
      if (!next) return { dead: true, turns, times, refusedMine, refusedAction };
    }
    s = next;
  }
  return { winner: s.winner, turns, times, refusedMine, refusedAction };
}

const tally = { refusedMine: 0, refusedAction: 0, maxTurns: 0, worstMs: 0, sumMs: 0, nMs: 0, stalls: 0, games: 0,
  kind: { move: 0, wall: 0, mine: 0, pass: 0 } };
const games = Object.create(null);

/** Play a position forward with a mixed field, so a spot can be reached without hand-building one. */
function advance(sizes, plies) {
  let s = newGame(sizes, { hazards: true, seed: (rnd() * 0x7fffffff) | 0 });
  const field = ['hard', 'normal', 'easy'];
  for (let i = 0; i < plies && s.winner === null; i++) {
    const a = botAction(view(s, s.turn), field[i % field.length]);
    let next = apply(s, a);
    if (!next) {
      const st = steps(s, s.turn)[0];
      next = st ? apply(s, { kind: 'move', ball: st.ball, to: st.to }) : apply(s, { kind: 'pass' });
    }
    s = next;
  }
  return s.winner === null ? view(s, s.turn) : null;
}

/**
 * The turn budget, measured where it means something: the bot called repeatedly on settled
 * positions — a duel, a wide three-way, a four-way and a 2v2, each early, mid-race and tangled in
 * walls. Counting every turn of the match series instead would mostly measure the harness's own
 * garbage, since a few thousand matches a second allocate far harder than one game ever does. The
 * bound is checked on the slowest of these calls, not on a median.
 */
function measureTurns() {
  const spots = [];
  for (const sizes of [[1, 1], [1, 1, 1], [1, 1, 1, 1], [2, 2]]) {
    for (const plies of [0, 20, 60]) {
      const spot = advance(sizes, plies);
      if (spot) spots.push({ spot, walls: spot.walls.length, sizes: sizes.length });
    }
  }
  const times = [];
  const field = ['hard', 'normal', 'easy'];
  for (const { spot } of spots) {
    for (let i = 0; i < 150; i++) {
      const t0 = performance.now();
      botAction(spot, field[i % field.length]);
      times.push(performance.now() - t0);
    }
  }
  times.sort((a, b) => a - b);
  const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
  return { calls: times.length, p50: q(0.5), p99: q(0.99), max: times[times.length - 1], spots: spots.length };
}

/**
 * `a` against `b`: every other match swaps which seat each tier takes, so the first-move edge
 * cancels out. Every tier occupies every seat equally often.
 */
function series(key, sizes, a, b, n = GAMES) {
  const acc = games[key] ??= { a, b, wins: 0, losses: 0 };
  for (let g = 0; g < n; g++) {
    const flipped = g % 2 === 1;
    const seats = flipped ? [b, a] : [a, b];
    const r = playMatch(sizes, seats);
    tally.games++;
    tally.refusedMine += r.refusedMine; tally.refusedAction += r.refusedAction;
    tally.maxTurns = Math.max(tally.maxTurns, r.turns);
    for (const ms of r.times) { tally.worstMs = Math.max(tally.worstMs, ms); tally.sumMs += ms; tally.nMs++; }
    if (r.dead) { acc.losses++; continue; }
    if (r.winner === null) { tally.stalls++; continue; }
    if (seats[r.winner % seats.length] === a) acc.wins++; else acc.losses++;
  }
  return acc;
}

const rate = (k) => { const g = games[k]; return g.wins / Math.max(1, g.wins + g.losses); };
const pct = (x) => (x * 100).toFixed(1) + '%';
const pool = (keys) => keys.reduce((t, k) => ({ wins: t.wins + games[k].wins, losses: t.losses + games[k].losses }), { wins: 0, losses: 0 });
/** One-sided binomial z: how many standard errors the win share sits above a coin toss. */
const zed = (t) => {
  const n = t.wins + t.losses;
  return (t.wins / n - 0.5) / Math.sqrt(0.25 / n);
};

const DUEL = [1, 1];
const FOUR = [1, 1, 1, 1];

/* Warm the engine before anything is measured. The first turns a process ever runs pay for JIT, and
   the app's own race screen builds distance fields long before the bot's first turn comes round. */
for (const sizes of [DUEL, FOUR]) {
  let s = newGame(sizes, { hazards: true, seed: (rnd() * 0x7fffffff) | 0 });
  for (let i = 0; i < 400 && s.winner === null; i++) {
    const a = botAction(view(s, s.turn), ['hard', 'normal', 'easy'][i % 3]);
    let next = apply(s, a);
    if (!next) {
      const st = steps(s, s.turn)[0];
      next = st ? apply(s, { kind: 'move', ball: st.ball, to: st.to }) : apply(s, { kind: 'pass' });
    }
    s = next;
  }
}
tally.worstMs = 0; tally.sumMs = 0; tally.nMs = 0;        // only measured turns count

series('hard/normal-duel', DUEL, 'hard', 'normal');
series('hard/normal-four', FOUR, 'hard', 'normal');
series('normal/easy-duel', DUEL, 'normal', 'easy');
series('normal/easy-four', FOUR, 'normal', 'easy');
series('hard/easy-duel', DUEL, 'hard', 'easy');

const hardNormal = pool(['hard/normal-duel', 'hard/normal-four']);
const normalEasy = pool(['normal/easy-duel', 'normal/easy-four']);

/* ---------- report (printed before the assertions, so numbers survive a failure) ---------- */

for (const key of ['hard/normal-duel', 'hard/normal-four', 'normal/easy-duel', 'normal/easy-four', 'hard/easy-duel']) {
  const g = games[key];
  console.log(`   ${key.padEnd(18)} ${g.a} wins ${pct(rate(key)).padStart(6)}  (${g.wins}-${g.losses})`);
}
console.log(`   pooled: hard>normal ${pct(hardNormal.wins / (hardNormal.wins + hardNormal.losses))} (z ${zed(hardNormal).toFixed(2)}), `
  + `normal>easy ${pct(normalEasy.wins / (normalEasy.wins + normalEasy.losses))} (z ${zed(normalEasy).toFixed(2)})`);
const timing = measureTurns();
console.log(`   turn budget: p50 ${timing.p50.toFixed(2)}ms, p99 ${timing.p99.toFixed(2)}ms, worst ${timing.max.toFixed(2)}ms `
  + `over ${timing.calls} calls on ${timing.spots} settled positions (in-match avg ${(tally.sumMs / tally.nMs).toFixed(2)}ms)`);
console.log(`   longest game ${tally.maxTurns} turns`);
console.log(`   refusals: ${tally.refusedMine} fog-hidden mines recovered, ${tally.refusedAction} illegal actions, ${tally.stalls} unfinished`);
console.log(`   actions: ${tally.kind.move} moves, ${tally.kind.wall} walls (${(tally.kind.wall / tally.games).toFixed(1)}/game), `
  + `${tally.kind.mine} mines (${(tally.kind.mine / tally.games).toFixed(1)}/game), ${tally.kind.pass} passes`);

/* ---------- the ladder ---------- */

check('hard beats normal on both boards, pooled', () => {
  assert.ok(hardNormal.wins + hardNormal.losses > 500, 'not enough decisive matches');
  assert.ok(rate('hard/normal-duel') > 0.5, 'hard lost the duel series');
  assert.ok(rate('hard/normal-four') > 0.5, 'hard lost the four-way series');
  assert.ok(zed(hardNormal) > 1.64, `hard only ${pct(hardNormal.wins / (hardNormal.wins + hardNormal.losses))}, z ${zed(hardNormal).toFixed(2)}`);
});

check('normal beats easy on both boards, pooled', () => {
  assert.ok(rate('normal/easy-duel') > 0.6, 'normal lost the duel series to easy');
  assert.ok(rate('normal/easy-four') > 0.6, 'normal lost the four-way series to easy');
  assert.ok(zed(normalEasy) > 3, `normal only ${pct(normalEasy.wins / (normalEasy.wins + normalEasy.losses))}`);
});

check('hard beats easy — the whole ladder holds', () => {
  assert.ok(rate('hard/easy-duel') > 0.8, `hard won only ${pct(rate('hard/easy-duel'))}`);
});

/* ---------- legality, stalemates and speed ---------- */

check('legality: the bot never proposes an illegal move or wall', () => {
  assert.equal(tally.refusedAction, 0, `${tally.refusedAction} non-mine actions were refused`);
});

check('fog: the only refusal is a hidden mine, and the fallback always recovers', () => {
  assert.ok(tally.refusedMine > 0, 'the fog never hid a mine: the test proved nothing');
  assert.equal(tally.stalls, 0, `${tally.stalls} matches never reached FINISH`);
  assert.ok(tally.maxTurns < MAX_TURNS, `a match hit the ${MAX_TURNS}-turn cap`);
});

check('speed: a turn is a handful of distance fields, well inside 15ms', () => {
  assert.ok(timing.p50 < 2, `median turn was ${timing.p50.toFixed(2)}ms`);
  assert.ok(timing.p99 < 5, `p99 turn was ${timing.p99.toFixed(2)}ms`);
  assert.ok(timing.max < 15, `slowest turn was ${timing.max.toFixed(2)}ms`);
});

console.log(`\n${run} bot tier checks passed`);
