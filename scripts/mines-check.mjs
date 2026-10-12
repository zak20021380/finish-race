/**
 * mines-check.mjs — assertion run for the mine rules in src/rules.ts (no DOM, no Playwright).
 * Run: node --experimental-strip-types scripts/mines-check.mjs
 *
 * Covers: the CONFIG tunables, the placement band (never the top or bottom two rows), occupied
 * cells, the per-team budget, whose turn it is, mines not blocking movement, the 3-cell
 * knockback and each of its three early stops, no chained blasts, friendly fire, and what
 * view(state, team) is allowed to reveal — plus 300 randomised playouts that re-check those
 * invariants after every single action.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as rules from '../src/rules.ts';
import {
  CONFIG, COLS, ROWS, allWalls, apply, doMine, doWall, mineCells, mineOk, newGame, reachable,
  steps, view, liveMines, minesLeft, wallOk,
} from '../src/rules.ts';

/* bot.ts says `from './rules'`, which Vite resolves and Node does not. Node only strips types from
   a real `.ts` file, so rewrite that one specifier into a generated twin in .shots/ — rebuilt on
   every run, so the bot under test can never drift from src/bot.ts. */
const botSrc = fs.readFileSync(path.join('src', 'bot.ts'), 'utf8')
  .replace("'./rules'", JSON.stringify(pathToFileURL(path.resolve('src', 'rules.ts')).href));
fs.mkdirSync('.shots', { recursive: true });
fs.writeFileSync('.shots/bot-under-test.ts', botSrc);
const { botAction } = await import(pathToFileURL(path.resolve('.shots', 'bot-under-test.ts')).href);

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

check('walls are unlimited: 9 legal walls in a row, past the old 8', () => {
  let s = newGame([1, 1]);
  for (const y of [3, 5, 7]) for (const x of [0, 2, 4]) {
    const next = doWall(s, { o: 'h', x, y, owner: s.turn });
    assert.ok(next, `wall ${x},${y} rejected with only ${s.walls.length} built`);
    s = { ...next, turn: s.turn };
  }
  assert.equal(s.walls.length, 9);
});

check('the wall budget exports are gone', () => {
  assert.ok(!('WALL_LIMIT' in rules), 'WALL_LIMIT still exported');
  assert.ok(!('wallsLeft' in rules), 'wallsLeft still exported');
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

console.log(`\n${run} mine-rule checks passed`);
