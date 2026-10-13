/**
 * mines-check.mjs — assertion run for the pure rules: mines in src/rules.ts, the rolling log in
 * src/hazards.ts and the bot's reading of it in src/bot.ts. No DOM, no Playwright.
 * Run: node --experimental-strip-types scripts/mines-check.mjs
 *
 * Covers: the CONFIG tunables, the placement band (never the top or bottom two rows), occupied
 * cells, the per-team budget, whose turn it is, mines not blocking movement, the 3-cell
 * knockback and each of its three early stops, no chained blasts, friendly fire, and what
 * view(state, team) is allowed to reveal — plus 300 randomised playouts that re-check those
 * invariants after every single action. Then the log: a schedule that is a pure function of the
 * seed, a hazard-free opening, the telegraph/resolve round cycle, the wall shield, the lane's three
 * early stops, multi-ball and own-team hits, mines that never arm under a shove, and the bot.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* rules.ts ↔ hazards.ts ↔ bot.ts say `from './rules'` / `'./hazards'`, which Vite resolves and Node
   does not. Node only strips types from a real `.ts` file, so rewrite those specifiers into
   generated twins in .shots/ — rebuilt from src on every run, so what is under test can never drift
   from it, and all three modules still share one instance of each. */
const NAMES = ['rules', 'hazards', 'bot'];
const HREF = Object.fromEntries(NAMES.map((n) => [n, pathToFileURL(path.resolve('.shots', `${n}-under-test.ts`)).href]));
fs.mkdirSync('.shots', { recursive: true });
for (const n of NAMES) {
  const src = fs.readFileSync(path.join('src', `${n}.ts`), 'utf8')
    .replace(/from '\.\/(rules|hazards|bot)'/g, (_m, m) => `from '${HREF[m]}'`);
  fs.writeFileSync(new URL(HREF[n]), src);
}
const {
  CONFIG, COLS, ROWS, HAZARD, allWalls, apply, doMine, doWall, logStopRow, mineCells, mineOk, newGame,
  reachable, steps, view, liveMines, minesLeft, wallOk, wallsRemaining,
} = await import(HREF.rules);
const { hazardAt, hazardSchedule, runLog } = await import(HREF.hazards);
const { botAction } = await import(HREF.bot);

const ball = (s, id = 0) => s.balls[id].pos;
const put = (s, id, c, r) => { const n = structuredClone(s); n.balls[id].pos = { c, r }; return n; };
const bury = (s, owner, c, r) => {
  const n = structuredClone(s);
  n.turn = owner;
  const out = doMine(n, { c, r });
  assert.ok(out, `bury ${c},${r} for team ${owner}`);
  return out;
};

let run = 0;
const check = (name, fn) => { fn(); run++; console.log('ok -', name); };

check('config', () => {
  assert.equal(CONFIG.MINES_PER_TEAM, 3);
  assert.equal(CONFIG.KNOCKBACK, 3);
  assert.equal(CONFIG.WALL_LIMIT, 8);
});

check('newGame starts with no mines', () => {
  assert.deepEqual(newGame([1, 1]).mines, []);
});

check('placement band: rows 2..ROWS-3 only', () => {
  const s = newGame([1, 1]);
  assert.equal(mineOk(s, { c: 3, r: 0 }), false, 'finish row');
  assert.equal(mineOk(s, { c: 3, r: 1 }), false, 'top 2 rows');
  assert.equal(mineOk(s, { c: 3, r: ROWS - 2 }), false, 'bottom 2 rows');
  assert.equal(mineOk(s, { c: 3, r: ROWS - 1 }), false, 'start row');
  assert.equal(mineOk(s, { c: 0, r: 2 }), true, 'first legal row');
  assert.equal(mineOk(s, { c: COLS - 1, r: ROWS - 3 }), true, 'last legal row');
  assert.equal(mineOk(s, { c: -1, r: 5 }), false);
  assert.equal(mineOk(s, { c: COLS, r: 5 }), false);
  const cells = mineCells(s, 0);
  assert.equal(cells.length, COLS * (ROWS - 4));
  assert.ok(cells.every((c) => c.r >= 2 && c.r <= ROWS - 3));
});

check('occupied cells reject: ball, then mine', () => {
  const s = put(newGame([1, 1]), 1, 4, 6); // bot ball on 4,6
  assert.equal(mineOk(s, { c: 4, r: 6 }), false, 'ball stands there');
  assert.equal(mineOk(s, { c: 4, r: 5 }), true);
  const withMine = bury(s, 0, 4, 5);
  assert.equal(mineOk(withMine, { c: 4, r: 5 }, 1), false, 'mine already there');
  assert.equal(liveMines(withMine).length, 1);
});

check('budget: 3 per team, spent mines still count against it', () => {
  let s = newGame([1, 1]);
  assert.equal(minesLeft(s, 0), 3);
  s = bury(s, 0, 1, 5);
  s = bury(s, 0, 2, 5);
  s = bury(s, 0, 3, 5);
  assert.equal(minesLeft(s, 0), 0);
  assert.equal(minesLeft(s, 1), 3, 'per team');
  assert.equal(mineOk(s, { c: 4, r: 5 }, 0), false, 'budget spent');
  assert.deepEqual(mineCells(s, 0), []);
  assert.equal(doMine({ ...s, turn: 0 }, { c: 4, r: 5 }), null, 'apply rejects too');
});

check('only the team on turn may bury', () => {
  const s = newGame([1, 1]);
  assert.equal(doMine(s, { c: 2, r: 5 }, 1), null, 'not my turn');
  assert.equal(apply(s, { kind: 'mine', cell: { c: 2, r: 5 } }).turn, 1, 'turn passes');
});

check('mine does not block movement', () => {
  let s = put(newGame([1, 1]), 0, 3, 8);
  s = bury(s, 1, 3, 7);
  const back = { ...s, turn: 0 };
  assert.ok(reachable(back, 0).some((p) => p.c === 3 && p.r === 7), 'cell still reachable');
});

check('trigger: full 3-cell knockback, mine consumed, turn passes', () => {
  let s = put(newGame([1, 1]), 0, 3, 8);
  s = bury(s, 1, 3, 7);
  s = { ...s, turn: 0 };
  const after = apply(s, { kind: 'move', ball: 0, to: { c: 3, r: 7 } });
  assert.deepEqual(ball(after), { c: 3, r: 10 }, 'pushed 3 down');
  assert.equal(after.mines.length, 1);
  assert.equal(after.mines[0].triggered, true);
  assert.equal(liveMines(after).length, 0);
  assert.equal(after.turn, 1, 'turn passes normally');
  assert.equal(after.winner, null);
});

check('knockback stops at the bottom edge', () => {
  let s = put(newGame([1, 1]), 0, 3, 10);
  s = bury(s, 1, 3, 9);
  s = { ...s, turn: 0 };
  const after = apply(s, { kind: 'move', ball: 0, to: { c: 3, r: 9 } });
  assert.deepEqual(ball(after), { c: 3, r: ROWS - 1 }, '2 cells then the wall');
});

check('knockback stops at a horizontal wall', () => {
  let s = put(newGame([1, 1]), 0, 3, 8);
  s = bury(s, 1, 3, 7);
  s = { ...s, turn: 0 };
  s = { ...s, walls: [{ o: 'h', x: 3, y: 9, owner: 1 }] }; // line above row 9, covers col 3
  const after = apply(s, { kind: 'move', ball: 0, to: { c: 3, r: 7 } });
  assert.deepEqual(ball(after), { c: 3, r: 8 }, 'stopped above the wall');
});

check('knockback stops at another ball', () => {
  let s = put(newGame([1, 1]), 0, 3, 8);
  s = { ...s, balls: s.balls.map((b) => (b.id === 1 ? { ...b, pos: { c: 3, r: 9 } } : b)) };
  s = bury(s, 1, 3, 7);
  s = { ...s, turn: 0 };
  const after = apply(s, { kind: 'move', ball: 0, to: { c: 3, r: 7 } });
  assert.deepEqual(ball(after, 0), { c: 3, r: 8 }, 'blocked by the ball below');
  assert.deepEqual(ball(after, 1), { c: 3, r: 9 }, 'the blocker did not move');
});

check('knockback never chains into a second mine', () => {
  let s = put(newGame([1, 1]), 0, 3, 6);
  s = bury(s, 1, 3, 5); // the one we step on
  s = bury(s, 1, 3, 8); // sitting exactly at the landing square
  s = { ...s, turn: 0 };
  const after = apply(s, { kind: 'move', ball: 0, to: { c: 3, r: 5 } });
  assert.deepEqual(ball(after), { c: 3, r: 8 }, 'lands on the second mine');
  assert.equal(after.mines.filter((m) => m.triggered).length, 1, 'second mine still armed');
  assert.deepEqual(liveMines(after)[0].cell, { c: 3, r: 8 });
});

check('a blast can be friendly fire', () => {
  let s = put(newGame([1, 1]), 0, 3, 8);
  s = bury(s, 0, 3, 7);
  s = { ...s, turn: 0 };
  const after = apply(s, { kind: 'move', ball: 0, to: { c: 3, r: 7 } });
  assert.deepEqual(ball(after), { c: 3, r: 10 });
  assert.equal(after.mines[0].owner, 0);
});

check('winning move is unaffected (no mines near the finish)', () => {
  let s = put(newGame([1, 1]), 0, 3, 3);
  s = { ...s, turn: 0 };
  s = apply(s, { kind: 'move', ball: 0, to: { c: 3, r: 2 } });
  s = { ...s, turn: 0 };
  const win = apply(s, { kind: 'move', ball: 0, to: { c: 3, r: 1 } });
  assert.equal(win.winner, null);
  assert.equal(win.turn, 1);
  assert.equal(win.balls[0].pos.r, 1);
});

check('view(): opponent mines hidden, mine own, triggered visible to both', () => {
  let s = put(newGame([1, 1]), 0, 3, 8);
  s = bury(s, 1, 3, 7); // team 1's trap, about to go off
  s = bury(s, 0, 5, 6); // team 0's trap, stays in the ground
  s = apply({ ...s, turn: 0 }, { kind: 'move', ball: 0, to: { c: 3, r: 7 } });
  assert.equal(s.mines.length, 2);
  const forZero = view(s, 0);
  const forOne = view(s, 1);
  assert.equal(forZero.mines.length, 2, 'own live mine + the enemy one already spent');
  assert.ok(forZero.mines.some((m) => m.owner === 1 && m.triggered));
  assert.ok(forZero.mines.some((m) => m.owner === 0 && !m.triggered));
  assert.equal(forOne.mines.length, 1, 'team 1 must not see team 0s live mine');
  assert.equal(forOne.mines[0].owner, 1);
  assert.equal(forOne.mines[0].triggered, true);
  assert.equal(forOne.balls.length, s.balls.length);
  assert.equal(forOne.turn, s.turn);
  assert.equal(forOne.walls, s.walls);
  assert.notEqual(forOne, s, 'projection is a copy');
});

check('pure: no input mutation', () => {
  const s = put(newGame([1, 1]), 0, 3, 8);
  const before = JSON.stringify(s);
  bury(s, 1, 3, 7);
  mineCells(s, 0);
  view(s, 0);
  assert.equal(JSON.stringify(s), before);
});

check('walls are rationed: eight legal walls, then the ninth is refused', () => {
  let s = newGame([1, 1]);
  let built = 0;
  /* a diagonal staircase of non-overlapping slots, far more than the budget, all individually legal */
  for (const y of [3, 4, 5, 6, 7, 8, 9]) for (const x of [0, 2, 4, 6]) {
    const w = { o: 'h', x, y, owner: s.turn };
    if (!wallOk(s, w)) continue;
    const next = doWall(s, w);
    assert.ok(next, `wall ${x},${y} rejected with ${built} built`);
    s = { ...next, turn: s.turn };
    built++;
  }
  assert.equal(built, CONFIG.WALL_LIMIT, `placed ${built} walls, budget is ${CONFIG.WALL_LIMIT}`);
  assert.equal(wallsRemaining(s, 0), 0, 'budget should be spent');
  const extra = allWalls(0).find((w) => {
    const t = { ...s, turn: 0 };
    return wallOk(t, w);
  });
  assert.equal(extra, undefined, 'a ninth wall was still legal');
});

check('the wall budget is tracked per seat and starts full', () => {
  const s = newGame([2, 2]);
  assert.deepEqual(s.wallsLeft, [CONFIG.WALL_LIMIT, CONFIG.WALL_LIMIT]);
  assert.equal(wallsRemaining(s, 0), CONFIG.WALL_LIMIT);
  const after = doWall(s, { o: 'h', x: 0, y: 3, owner: 0 });
  assert.ok(after, 'first wall should place');
  assert.deepEqual(after.wallsLeft, [CONFIG.WALL_LIMIT - 1, CONFIG.WALL_LIMIT]);
  assert.equal(wallsRemaining(after, 1), CONFIG.WALL_LIMIT, 'the other seat is untouched');
});

check('bot: every action survives the real state, or main.ts falls back and races on', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let mined = 0, walled = 0, moved = 0, refused = 0;
  for (let g = 0; g < 120; g++) {
    let s = newGame([1 + ((rnd() * 3) | 0), 1 + ((rnd() * 3) | 0)]);
    for (let i = 0; i < 40 && s.winner === null; i++) {
      const a = botAction(view(s, s.turn), ['easy', 'normal', 'hard'][(rnd() * 3) | 0]);
      // the bot is handed the projection but the rules run on the whole state, exactly as main.ts does
      let next = apply(s, a);
      if (!next) {
        refused++;
        const st = steps(s, s.turn)[0];
        next = st ? apply(s, { kind: 'move', ball: st.ball, to: st.to }) : apply(s, { kind: 'pass' });
        assert.ok(next, 'even the fallback step was refused');
      }
      if (a.kind === 'mine') mined++; else if (a.kind === 'wall') walled++; else if (a.kind === 'move') moved++;
      s = next;
    }
  }
  assert.ok(mined > 40, `the bot buried only ${mined} mines in 120 games`);
  assert.ok(walled > 0, 'the bot never walled: the wall branch stopped firing');
  assert.ok(moved > 200, `the bot barely raced: ${moved} moves`);
  console.log(`   (bot: ${mined} mines, ${walled} walls, ${moved} moves, ${refused} refused by the fog)`);
});

check('fuzz: 300 random playouts keep every invariant', () => {
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  let triggers = 0, finished = 0;
  for (let g = 0; g < 300; g++) {
    let s = newGame(pick([[1, 1], [1, 1, 1], [2, 3], [3, 3, 3]]));
    for (let i = 0; i < 160 && s.winner === null; i++) {
      const roll = rnd();
      let a = null;
      if (roll < 0.72) {
        const mv = reachable(s, s.turn).sort((x, y) => x.r - y.r);
        // biased toward FINISH so playouts actually walk into what is buried ahead of them
        if (mv.length) a = { kind: 'move', to: pick(mv.slice(0, Math.ceil(mv.length / 2))) };
      } else if (roll < 0.94) {
        const cells = mineCells(s, s.turn);
        if (cells.length) a = { kind: 'mine', cell: pick(cells) };
      } else {
        const w = { ...pick(allWalls(s.turn)), owner: s.turn };
        if (wallOk(s, w)) a = { kind: 'wall', wall: w };
      }
      if (!a) a = { kind: 'pass' };
      const next = apply(s, a);
      assert.ok(next, `legal action rejected: ${JSON.stringify(a)}`);
      assert.notEqual(next, s, 'apply mutated in place');
      s = next;
      const seen = new Set();
      for (const b of s.balls) {
        assert.ok(b.pos.c >= 0 && b.pos.c < COLS && b.pos.r >= 0 && b.pos.r < ROWS, 'ball off board');
        const k = b.pos.r * COLS + b.pos.c;
        assert.ok(!seen.has(k), 'two balls on one cell');
        seen.add(k);
      }
      for (const t of [0, 1, 2]) assert.ok(minesLeft(s, t) >= 0, 'mine budget overspent');
      const armed = new Set();
      for (const m of liveMines(s)) {
        assert.ok(m.cell.r >= 2 && m.cell.r <= ROWS - 3, 'mine in a banned row');
        const k = m.cell.r * COLS + m.cell.c;
        assert.ok(!armed.has(k), 'two live mines on one cell');
        armed.add(k);
      }
      for (const t of [0, 1, 2]) {
        const v = view(s, t);
        assert.ok(!v.mines.some((m) => m.owner !== t && !m.triggered), 'view leaked an enemy mine');
      }
    }
    triggers += s.mines.filter((m) => m.triggered).length;
    if (s.winner !== null) finished++;
  }
  // a fuzz that never set a mine off would prove nothing
  assert.ok(triggers > 20, `only ${triggers} mine blasts in 300 games`);
  assert.ok(finished > 20, `only ${finished} games reached FINISH`);
  console.log(`   (${triggers} blasts, ${finished} finished games)`);
});

/* ---------- rolling log ---------- */

/** Park the race in a warning round: the wide lane is telegraphed and the last team has yet to act. */
const inWarning = (left, sizes = [1, 1], round = 4, width = HAZARD.logWidth) => {
  const s = newGame(sizes, { hazards: true, seed: 5 });
  return {
    ...s,
    hazard: { ...s.hazard, round, emitted: 1, pending: { left, width, hitRound: round }, nextWarningRound: round },
  };
};

/** The last team of the round acts: the round closes and any due log comes down with it. */
const closeRound = (s, a = { kind: 'pass' }) => apply({ ...s, turn: s.teams.length - 1 }, a);
const moveTo = (ev, id) => ev.moves.find((m) => m.ballId === id)?.to;

check('hazard config', () => {
  assert.deepEqual({ ...HAZARD }, { firstWarningRound: 3, minGap: 3, maxGap: 9, knockback: 3, logWidth: 3 });
});

check('hazard: the schedule is a pure function of the seed', () => {
  assert.deepEqual(hazardSchedule(7, 30), hazardSchedule(7, 30));
  assert.deepEqual(hazardSchedule(7, 30).map((h) => h.k), Array.from({ length: 30 }, (_, i) => i));
  assert.notDeepEqual(hazardSchedule(7, 30), hazardSchedule(8, 30), 'a new seed must retime the board');
  assert.deepEqual({ k: 4, ...hazardAt(7, 4) }, hazardSchedule(7, 5)[4]);
  // nothing about the moves so far can shift it: the same k from the same seed, whatever the state
  const a = newGame([1, 1], { hazards: true, seed: 7 });
  const b = apply(apply(a, { kind: 'pass' }), { kind: 'pass' });
  assert.deepEqual(hazardSchedule(b.hazard.seed, 6), hazardSchedule(a.hazard.seed, 6));
});

check('hazard: rounds 1 and 2 are clean and every gap sits in minGap..maxGap', () => {
  for (let seed = 0; seed < 250; seed++) {
    const plan = hazardSchedule(seed, 14);
    let prev = 0;
    for (const h of plan) {
      assert.ok(h.warnRound >= 3, `seed ${seed}: warned in round ${h.warnRound}`);
      const gap = h.warnRound - prev;
      assert.ok(gap >= HAZARD.minGap && gap <= HAZARD.maxGap, `seed ${seed}: gap ${gap} out of range`);
      assert.equal(h.width, HAZARD.logWidth, `seed ${seed}: width must be logWidth`);
      assert.ok(h.left >= 0 && h.left <= COLS - h.width, `seed ${seed}: lane left ${h.left} off board`);
      assert.ok(h.warnRound > prev, 'the clock must never run backwards');
      prev = h.warnRound;
    }
  }
});

check('hazard: off by default, and an off race sees nothing at all', () => {
  assert.equal(newGame([1, 1]).hazard, undefined);
  assert.equal(newGame([1, 1], { hazards: false, seed: 2 }).hazard, undefined);
  let s = newGame([2, 2, 1]);
  for (let i = 0; i < 400; i++) {
    s = apply(s, { kind: 'pass' });
    assert.equal(s.hazard, undefined, 'a plain race grew a hazard clock');
    assert.equal(s.lastEvent, null, 'a plain race fired a log');
  }
  assert.deepEqual(ball(s), { c: 3, r: ROWS - 1 }, 'nothing moved a ball');
});

check('hazard: telegraphed for its whole round, resolved when the round ends', () => {
  const seed = 11;
  let s = newGame([1, 1], { hazards: true, seed });
  assert.deepEqual(s.hazard, { on: true, seed, round: 1, emitted: 0, pending: null, nextWarningRound: hazardAt(seed, 0).warnRound });
  const warned = [];
  let hits = 0;
  for (let i = 0; i < 280; i++) {
    const was = s.hazard;
    const next = apply(s, { kind: 'pass' });
    const now = next.hazard;
    assert.ok(now.round === was.round || now.round === was.round + 1, 'the clock jumped');
    assert.equal(now.seed, seed);
    if (!was.pending && now.pending) {
      warned.push({ left: now.pending.left, width: now.pending.width, round: now.round });
      assert.equal(now.pending.hitRound, now.round, 'a warning lands in its own round');
      assert.equal(now.pending.width, HAZARD.logWidth);
      assert.ok(now.pending.left >= 0 && now.pending.left <= COLS - now.pending.width);
      assert.equal(now.emitted, was.emitted + 1);
      assert.equal(view(next, 1).hazard.pending.left, now.pending.left, 'the telegraph must be public');
      assert.ok(!('col' in now.pending), 'old single col field must be gone');
    }
    if (was.pending && !now.pending) {
      hits++;
      assert.equal(now.round, was.round + 1, 'a log lands the instant its round closes');
      assert.equal(next.lastEvent.type, 'log');
      assert.equal(next.lastEvent.left, was.pending.left, 'the event reports the telegraphed lane');
      assert.equal(next.lastEvent.width, was.pending.width);
      assert.ok(!('col' in next.lastEvent), 'old single col field must be gone');
      assert.ok(next.lastEvent.stopRow < ROWS);
    }
    assert.ok(!now.pending || now.pending.hitRound === now.round, 'a stale telegraph survived its round');
    assert.ok(now.round >= 3 || !now.pending, 'no warning in rounds 1 or 2');
    s = next;
  }
  assert.ok(warned.length >= 4, `only ${warned.length} hazards in 280 turns`);
  assert.equal(hits, warned.length - (s.hazard.pending ? 1 : 0), 'every closed warning must land');
  warned.forEach((w, k) => {
    const due = hazardAt(seed, k);
    assert.equal(w.left, due.left, `hazard ${k} lane`);
    assert.equal(w.width, due.width, `hazard ${k} width`);
    assert.equal(w.round, due.warnRound, `hazard ${k} round`);
  });
});

check('log: one hit ball is shoved the full 3 cells', () => {
  const ev = (s) => s.lastEvent;
  let s = put(inWarning(2), 0, 3, 6);
  s = closeRound(s);
  assert.equal(logStopRow(s.walls, 2, 3), ROWS - 1, 'no wall, so the lane runs to the bottom');
  assert.deepEqual(ball(s, 0), { c: 3, r: 9 });
  assert.deepEqual(ev(s), { type: 'log', left: 2, width: 3, stopRow: ROWS - 1, moves: [{ ballId: 0, from: { c: 3, r: 6 }, to: { c: 3, r: 9 } }] });
  assert.equal(s.hazard.pending, null);
  assert.equal(s.hazard.round, 5);
  assert.equal(s.turn, 0, 'the hand-off is untouched');
});

check('log: a wall in the lane stops it, and balls under that wall are shielded', () => {
  let s = put(inWarning(2), 0, 3, 3);
  s = put({ ...s, walls: [{ o: 'h', x: 3, y: 6, owner: 1 }] }, 1, 3, 8); // line above row 6, covers 3 and 4
  assert.equal(logStopRow(s.walls, 2, 3), 5);
  s = closeRound(s);
  assert.deepEqual(ball(s, 0), { c: 3, r: 5 }, '2 cells, then the wall');
  assert.deepEqual(ball(s, 1), { c: 3, r: 8 }, 'the ball below the wall never saw the log');
  assert.deepEqual(s.lastEvent, { type: 'log', left: 2, width: 3, stopRow: 5, moves: [{ ballId: 0, from: { c: 3, r: 3 }, to: { c: 3, r: 5 } }] });
});

check('log: a single partial wall stops the entire wide trunk', () => {
  // lane 3..5; wall covers only col 5 (x=5 covers 5,6) yet the whole trunk halts at row 5
  let s = put(inWarning(3), 0, 2, 2);
  s = put(s, 1, 4, 2);
  s = { ...s, walls: [{ o: 'h', x: 5, y: 6, owner: 1 }] };
  assert.equal(logStopRow(s.walls, 3, 3), 5, 'one blocked column halts all three');
  assert.equal(logStopRow([], 3, 3), ROWS - 1);
  s = closeRound(s);
  assert.equal(s.lastEvent.left, 3);
  assert.equal(s.lastEvent.width, 3);
  assert.equal(s.lastEvent.stopRow, 5);
  assert.deepEqual(ball(s, 0), { c: 2, r: 2 }, 'outside the lane: untouched');
  assert.deepEqual(ball(s, 1), { c: 4, r: 5 }, 'inside the lane but halted by the partial wall');
});

check('log: simultaneous hits across multiple lane columns', () => {
  let s = put(inWarning(2), 0, 2, 4);
  s = put(s, 1, 4, 4);
  s = closeRound(s);
  assert.equal(s.lastEvent.left, 2);
  assert.equal(s.lastEvent.width, 3);
  assert.deepEqual(ball(s, 0), { c: 2, r: 7 });
  assert.deepEqual(ball(s, 1), { c: 4, r: 7 });
  assert.equal(s.lastEvent.moves.length, 2);
});

check('log: a shove stops at the bottom edge', () => {
  const s = closeRound(put(inWarning(2), 0, 3, 9));
  assert.deepEqual(ball(s, 0), { c: 3, r: ROWS - 1 }, '2 cells, not 3');
  assert.deepEqual(moveTo(s.lastEvent, 0), { c: 3, r: ROWS - 1 });
});

check('log: a shove stops at another ball, which does not move twice', () => {
  let s = put(inWarning(2), 1, 3, 11); // already on the last row: nowhere to go
  s = put(s, 0, 3, 9);
  s = closeRound(s);
  assert.deepEqual(ball(s, 0), { c: 3, r: 10 }, '1 cell, then the ball');
  assert.deepEqual(ball(s, 1), { c: 3, r: 11 });
  assert.deepEqual(s.lastEvent.moves, [{ ballId: 0, from: { c: 3, r: 9 }, to: { c: 3, r: 10 } }], 'a ball that cannot move reports no move');
});

check('log: two balls in one lane, the bottom-most shoved first', () => {
  let s = put(inWarning(2), 0, 3, 2);
  s = put(s, 1, 3, 4);
  s = closeRound(s);
  assert.deepEqual(s.lastEvent.moves.map((m) => [m.ballId, m.from.r, m.to.r]), [[1, 4, 7], [0, 2, 5]]);
  assert.deepEqual(ball(s, 0), { c: 3, r: 5 }, 'takes the cell the one below vacated');
  assert.deepEqual(ball(s, 1), { c: 3, r: 7 });
});

check('log: chain push collision across the wide lane', () => {
  // same column chain: bottom ball blocked by edge, top ball stacks behind it
  let s = put(inWarning(1), 0, 2, 8);
  s = put(s, 1, 2, 9);
  s = { ...s, balls: [...s.balls.map((b) => (b.id === 1 ? { ...b, pos: { c: 2, r: 10 } } : b)), { id: 2, team: 1, owner: 1, pos: { c: 2, r: 11 } }] };
  s = closeRound(s);
  assert.deepEqual(ball(s, 2), { c: 2, r: 11 }, 'bottom ball pinned at the edge');
  assert.ok(ball(s, 1).r >= 10, 'middle ball held by the chain');
  assert.ok(ball(s, 0).r >= 8, 'top ball stacks behind');
});

check('log: it hits its own team too', () => {
  let s = put(inWarning(2, [2, 1]), 0, 3, 5);
  s = put(s, 1, 3, 7); // both belong to team 0, which is not even the side that just acted
  assert.equal(s.balls[0].team, 0);
  assert.equal(s.balls[1].team, 0);
  s = closeRound(s);
  assert.deepEqual(s.lastEvent.moves.map((m) => m.ballId), [1, 0]);
  assert.deepEqual(ball(s, 0), { c: 3, r: 8 });
  assert.deepEqual(ball(s, 1), { c: 3, r: 10 });
});

check('log: a shove across a mine never sets it off', () => {
  let s = put(inWarning(2), 0, 3, 6);
  s = { ...s, mines: [{ cell: { c: 3, r: 9 }, owner: 1, triggered: false }] };
  const after = closeRound(s);
  assert.deepEqual(ball(after, 0), { c: 3, r: 9 }, 'landed on the mine');
  assert.equal(after.mines[0].triggered, false, 'the log is not a blast');
  assert.deepEqual(liveMines(after).map((m) => m.cell), [{ c: 3, r: 9 }]);
});

check('log: shield protection below the shared stop line', () => {
  // lane 2..4, wall blocks only col 4 at y=6 -> stopRow 5 for all; balls below are safe
  let s = put(inWarning(2), 0, 2, 1);
  s = put(s, 1, 4, 8);
  s = { ...s, walls: [{ o: 'h', x: 4, y: 6, owner: 0 }] };
  assert.equal(logStopRow(s.walls, 2, 3), 5);
  s = closeRound(s);
  assert.deepEqual(ball(s, 0), { c: 2, r: 4 }, 'hit and shoved within the shared limit');
  assert.deepEqual(ball(s, 1), { c: 4, r: 8 }, 'below the wall: shielded');
});

check('log: an empty lane still reports the event', () => {
  const s = closeRound(inWarning(5)); // both balls sit on columns 3 and 4
  assert.deepEqual(s.lastEvent, { type: 'log', left: 5, width: 3, stopRow: ROWS - 1, moves: [] });
  assert.deepEqual(ball(s, 0), { c: 3, r: ROWS - 1 });
  assert.deepEqual(ball(s, 1), { c: 4, r: ROWS - 1 });
});

check('log: runLog is pure — the state it read is untouched', () => {
  let s = put(inWarning(2), 0, 3, 6);
  s = { ...s, mines: [{ cell: { c: 3, r: 9 }, owner: 1, triggered: false }] };
  const before = JSON.stringify(s);
  const out = runLog(s, s.hazard.pending);
  assert.equal(out.balls[0].pos.r, 9, 'the copy moved');
  assert.equal(JSON.stringify(s), before);
  assert.equal(s.mines[0].triggered, false);
  const ended = closeRound(s);
  assert.equal(JSON.stringify(s), before, 'apply mutated in place');
  assert.notEqual(ended, s);
});

check('log: rounds only close when every team has acted', () => {
  let s = newGame([1, 1, 1], { hazards: true, seed: 5 });
  for (const expect of [1, 1, 2, 2, 2, 3, 3, 3, 4]) {
    s = apply(s, { kind: 'pass' });
    assert.equal(s.hazard.round, expect, 'a round is one turn per team');
  }
});

check('bot: never ends a move inside ANY telegraphed lane column it can afford to leave', () => {
  let s = put(inWarning(3), 0, 4, 11);          // the foe, out of the way
  s = put(s, 1, 3, 5);                          // the bot starts inside the wide lane 3..5
  s = { ...s, turn: 1 };
  // its cheapest step is straight up the lane (4 steps to FINISH); a swerve to col 2 costs 5, well inside 2
  assert.deepEqual(steps(s, 1).map((st) => st.to), [{ c: 3, r: 4 }, { c: 3, r: 6 }, { c: 2, r: 5 }, { c: 4, r: 5 }]);
  let moves = 0;
  for (let i = 0; i < 200; i++) {
    const a = botAction(view(s, 1), 'hard');
    if (a.kind !== 'move') continue;
    moves++;
    const lane = s.hazard.pending;
    const stop = logStopRow(s.walls, lane.left, lane.width);
    const inside = a.to.c >= lane.left && a.to.c < lane.left + lane.width && a.to.r <= stop;
    assert.ok(!inside, `the bot finished in the lane: ${JSON.stringify(a.to)}`);
    assert.ok(apply(s, a), 'the bot proposed an illegal step');
  }
  assert.ok(moves > 60, `the bot barely moved: ${moves}`);
});

check('bot: walks the lane when every way out costs it more than two steps', () => {
  let s = newGame([1, 2], { hazards: true, seed: 5 });
  s = {
    ...s,
    balls: s.balls.map((b) => (b.id === 0 ? { ...b, pos: { c: 5, r: 11 } }
      : b.id === 1 ? { ...b, pos: { c: 3, r: 5 } } : { ...b, pos: { c: 4, r: 9 } })),
    walls: [
      { o: 'h', x: 3, y: 6, owner: 0 },        // blocks the way down and puts the shield line at 5
      { o: 'v', x: 3, y: 4, owner: 0 },        // blocks the way left
      { o: 'v', x: 4, y: 4, owner: 0 },        // blocks the way right
    ],
    hazard: { ...s.hazard, round: 4, emitted: 1, pending: { left: 3, width: 3, hitRound: 4 }, nextWarningRound: 4 },
    turn: 1,
  };
  assert.equal(logStopRow(s.walls, 3, 3), 5, 'the bot is standing exactly on the shield line');
  assert.deepEqual(steps(s, 1).filter((st) => st.ball === 1), [{ ball: 1, to: { c: 3, r: 4 } }]);
  let moves = 0;
  for (let i = 0; i < 60; i++) {
    const a = botAction(view(s, 1), 'hard');
    if (a.kind !== 'move') continue;
    moves++;
    assert.deepEqual(a.to, { c: 3, r: 4 }, 'the only escape costs 8 steps, so the lane is the pick');
    assert.ok(a.ball === 1, 'it should still be the trapped ball that walks the lane');
  }
  assert.ok(moves > 10, `the bot never raced: ${moves}`);
});

check('hazard: determinism by seed and left bounds', () => {
  for (const seed of [0, 1, 7, 42, 12345]) {
    const a = hazardSchedule(seed, 20);
    const b = hazardSchedule(seed, 20);
    assert.deepEqual(a, b, `seed ${seed} not deterministic`);
    for (const h of a) {
      assert.ok(h.left >= 0 && h.left <= COLS - h.width, `seed ${seed}: left ${h.left} out of [0, COLS-width]`);
      assert.equal(h.width, HAZARD.logWidth);
    }
  }
  assert.notDeepEqual(hazardSchedule(7, 10), hazardSchedule(8, 10));
});

console.log(`\n${run} rules checks passed`);
