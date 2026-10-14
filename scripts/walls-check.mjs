/**
 * walls-check.mjs — assertion run for wall geometry in src/rules.ts and for the board's action
 * modes in src/boardmode.ts. No DOM, no Playwright.
 * Run: node --experimental-strip-types scripts/walls-check.mjs
 *
 * A wall is two adjacent edge segments plus the vertex they hinge on. This file pins that geometry
 * down: collinear walls may not share a segment, perpendicular walls may not share a pivot (the
 * illegal `+`), and touching at an L-corner or a T-junction stays legal — checked as pure predicates,
 * through `doWall`, and across full randomised bot playouts so nothing on the board ever clashes.
 * Then the modes: a ball in hand and a wall preview are mutually exclusive, so the move dots and the
 * dashed preview can never be drawn at once.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* rules.ts says `from './hazards'`, which Vite resolves and Node does not. Node only strips types
   from a real `.ts` file, so the specifier is rewritten into a generated twin in .shots/ — rebuilt
   from src on every run, so what is under test can never drift from it, and rules/hazards/bot all
   still share one instance of each. boardmode.ts imports nothing, so it is read from src directly. */
const NAMES = ['rules', 'hazards', 'bot'];
const HREF = Object.fromEntries(NAMES.map((n) =>
  [n, pathToFileURL(path.resolve('.shots', `walls-${n}-under-test.ts`)).href]));
fs.mkdirSync('.shots', { recursive: true });
for (const n of NAMES) {
  const src = fs.readFileSync(path.join('src', `${n}.ts`), 'utf8')
    .replace(/from '\.\/(rules|hazards|bot)'/g, (_m, m) => `from '${HREF[m]}'`);
  fs.writeFileSync(new URL(HREF[n]), src);
}
const {
  COLS, ROWS, allWalls, apply, doWall, newGame, wallOk, wallPivot, wallVertices, wallsClash,
  wallsCross, wallsOverlap, wallsRemaining,
} = await import(HREF.rules);
const { botAction } = await import(HREF.bot);
const { BOARD_IDLE, holdMineKey, moveDots, pickBall, previewWall, selectionRing } =
  await import(pathToFileURL(path.resolve('src', 'boardmode.ts')).href);

let run = 0;
const check = (name, fn) => { fn(); run++; console.log('ok -', name); };

/** A fresh 1v1 whose only walls are the ones handed in, all owned by seat 0. */
const board = (walls) => ({ ...newGame([1, 1]), walls: walls.map((w) => ({ ...w, owner: 0 })) });
const h = (x, y) => ({ o: 'h', x, y, owner: 0 });
const v = (x, y) => ({ o: 'v', x, y, owner: 0 });
/** Every unordered pair on a board, so a clash can be looked for rather than asserted one by one. */
const clashOn = (walls) => {
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) if (wallsClash(walls[i], walls[j])) return [walls[i], walls[j]];
  }
  return null;
};

check('geometry: a wall spans two segments and hinges on the vertex between them', () => {
  assert.deepEqual(wallVertices(h(2, 5)), [{ x: 2, y: 5 }, { x: 3, y: 5 }, { x: 4, y: 5 }]);
  assert.deepEqual(wallVertices(v(3, 4)), [{ x: 3, y: 4 }, { x: 3, y: 5 }, { x: 3, y: 6 }]);
  assert.deepEqual(wallPivot(h(2, 5)), { x: 3, y: 5 }, 'horizontal midpoint');
  assert.deepEqual(wallPivot(v(3, 4)), { x: 3, y: 5 }, 'vertical midpoint — the same vertex');
  /* a wall's own two segments never overlap each other, whatever it is */
  for (const w of allWalls(0)) assert.equal(wallsOverlap(w, w), true);
});

check('same orientation: a horizontal wall rejects both of its same-line neighbours', () => {
  const s = board([h(2, 5)]);
  for (const x of [1, 2, 3]) assert.equal(wallOk(s, h(x, 5)), false, `h(${x},5) shares a segment`);
  assert.equal(wallOk(s, h(0, 5)), true, 'h(0,5) only touches the far end');
  assert.equal(wallOk(s, h(4, 5)), true, 'h(4,5) only touches the near end');
  assert.equal(wallOk(s, h(2, 6)), true, 'a different line never overlaps');
  assert.equal(wallOk(s, h(2, 4)), true);
  assert.equal(wallOk(s, v(3, 3)), true, 'perpendicular is a separate question');
});

check('same orientation: a vertical wall rejects both of its same-line neighbours', () => {
  const s = board([v(3, 4)]);
  for (const y of [3, 4, 5]) assert.equal(wallOk(s, v(3, y)), false, `v(3,${y}) shares a segment`);
  assert.equal(wallOk(s, v(3, 2)), true);
  assert.equal(wallOk(s, v(3, 6)), true);
  assert.equal(wallOk(s, v(4, 4)), true, 'a different line never overlaps');
  assert.equal(wallOk(s, v(2, 4)), true);
});

check('overlap is symmetric, and a shared segment is found either way round', () => {
  assert.equal(wallsOverlap(h(2, 5), h(3, 5)), true, 'one segment in common');
  assert.equal(wallsOverlap(h(3, 5), h(2, 5)), true, 'and the other way round');
  assert.equal(wallsOverlap(h(2, 5), h(2, 5)), true, 'identical');
  assert.equal(wallsOverlap(h(2, 5), h(4, 5)), false, 'end to end is not an overlap');
  assert.equal(wallsOverlap(h(2, 5), h(2, 4)), false, 'different line');
  assert.equal(wallsOverlap(h(2, 5), v(2, 5)), false, 'different orientation');
  assert.equal(wallsOverlap(v(3, 4), v(3, 5)), true);
  assert.equal(wallsOverlap(v(3, 4), v(3, 6)), false);
});

check('overlap, exhaustively: collinear walls share a segment only when they should', () => {
  const all = allWalls(0);
  for (const a of all) {
    for (const b of all) {
      /* perpendicular walls can never share a segment — they do not even lie on the same line */
      if (a.o !== b.o) assert.equal(wallsOverlap(a, b), false, `${a.o}(${a.x},${a.y}) vs ${b.o}(${b.x},${b.y})`);
      /* collinear ones do exactly when they are on the same line and less than a full wall apart */
      else if (a.o === 'h') assert.equal(wallsOverlap(a, b), a.y === b.y && Math.abs(a.x - b.x) < 2);
      else assert.equal(wallsOverlap(a, b), a.x === b.x && Math.abs(a.y - b.y) < 2);
    }
  }
});

check('perpendicular: a `+` through a shared pivot is illegal, both ways round', () => {
  const horiz = board([h(2, 5)]);                       // pivot (3, 5)
  assert.deepEqual(wallPivot(h(2, 5)), wallPivot(v(3, 4)), 'the two walls share one vertex');
  assert.equal(wallsCross(h(2, 5), v(3, 4)), true);
  assert.equal(wallsCross(v(3, 4), h(2, 5)), true, 'symmetric');
  assert.equal(wallOk(horiz, v(3, 4)), false, 'vertical through a horizontal');
  assert.equal(doWall({ ...horiz, turn: 0 }, v(3, 4)), null, 'doWall refuses it too');
  assert.equal(apply({ ...horiz, turn: 0 }, { kind: 'wall', wall: v(3, 4) }), null);

  const vert = board([v(3, 4)]);
  assert.equal(wallOk(vert, h(2, 5)), false, 'horizontal through a vertical');
  assert.equal(doWall({ ...vert, turn: 0 }, h(2, 5)), null);
  assert.equal(wallsCross(h(2, 5), h(3, 5)), false, 'collinear walls never cross');
  assert.equal(wallsCross(h(2, 5), h(2, 4)), false);
  assert.equal(wallsCross(h(2, 5), h(3, 5)), false);

  /* every pivot a horizontal wall can be crossed through, on every legal line */
  for (const y of [1, 2, 5, ROWS - 1]) {
    for (const x of [0, 2, COLS - 2]) {
      const s = board([h(x, y)]);
      assert.equal(wallOk(s, v(x + 1, y - 1)), false, `v(${x + 1},${y - 1}) crosses h(${x},${y})`);
    }
  }
});

check('T-junctions and L-corners touch at a vertex and stay legal', () => {
  const s = board([h(2, 5)]);                           // spans (2,5) (3,5) (4,5)
  /* T: the vertical wall ends exactly on the horizontal wall's midpoint */
  assert.equal(wallOk(s, v(3, 3)), true, 'T-junction from above');
  assert.equal(wallOk(s, v(3, 5)), true, 'T-junction from below');
  /* T the other way: the horizontal wall ends on the vertical wall's midpoint */
  assert.equal(wallOk(board([v(3, 4)]), h(1, 5)), true, 'horizontal ends on a vertical midpoint');
  /* L: two ends meeting at a corner */
  assert.equal(wallOk(s, v(4, 5)), true, 'L-corner at the far end');
  assert.equal(wallOk(s, v(2, 5)), true, 'L-corner at the near end');
  assert.equal(wallOk(s, v(2, 6)), true, 'and a wall that misses it entirely');
  /* none of those share a pivot, which is exactly why they stand */
  assert.equal(wallsCross(h(2, 5), v(3, 3)), false);
  assert.equal(wallsCross(h(2, 5), v(4, 5)), false);
  assert.equal(wallsCross(h(2, 5), v(2, 5)), false);
});

check('collinear walls may meet end to end', () => {
  const s = board([h(2, 5)]);
  assert.equal(wallOk(s, h(4, 5)), true);
  const both = { ...s, walls: [...s.walls, h(4, 5)] };
  assert.equal(clashOn(both.walls), null, 'h(2,5) + h(4,5) share a vertex, not a segment');
  assert.equal(wallOk(both, h(0, 5)), true, 'and a third one closes the run');
  assert.equal(wallOk(both, h(6, 5)), true);
  assert.equal(wallOk(both, h(3, 5)), false, 'but the middle is still taken');
});

check('a legal wall goes up, and the board it leaves has no clash anywhere', () => {
  let s = newGame([1, 1]);
  const placed = [h(2, 5), v(4, 5), h(6, 5), v(6, 6), h(2, 8), v(2, 8), v(1, 8)];
  for (const w of placed) {
    const next = doWall({ ...s, turn: 0 }, w);
    assert.ok(next, `${w.o}(${w.x},${w.y}) should be legal`);
    assert.equal(clashOn(next.walls), null, 'and the board stays clash-free');
    s = next;
  }
  assert.equal(s.walls.length, placed.length);
  assert.equal(wallsRemaining(s, 0), 8 - placed.length);
  /* the crossings and overlaps of the first two are still refused on the real board */
  assert.equal(doWall({ ...s, turn: 0 }, v(3, 4)), null, '`+` through h(2,5)');
  assert.equal(doWall({ ...s, turn: 0 }, h(3, 5)), null, 'overlapping h(2,5)');
  assert.equal(doWall({ ...s, turn: 0 }, v(1, 9)), null, 'overlapping v(1,8)');
  assert.equal(doWall({ ...s, turn: 0 }, v(7, 4)), null, '`+` through h(6,5)');
  assert.equal(doWall({ ...s, turn: 0 }, h(5, 7)), null, '`+` through v(6,6)');
});

check('the bot never picks a wall that clashes, on any board it plays', () => {
  const rnd = (n) => Math.floor(Math.random() * n);
  let placed = 0, races = 0;
  for (const difficulty of ['easy', 'normal', 'hard']) {
    for (let race = 0; race < 25; race++) {
      let s = newGame(race % 2 ? [2, 2] : [1, 1]);
      /* open on a board that is already busy, so the bot has to route its walls around real ones */
      for (let k = 0; k < 6; k++) {
        const pool = allWalls(0).filter((w) => wallOk({ ...s, turn: 0 }, w));
        if (!pool.length) break;
        s = doWall({ ...s, turn: 0 }, pool[rnd(pool.length)]);
        assert.equal(clashOn(s.walls), null, 'a board seeded only from legal walls never clashes');
      }
      races++;
      for (let turn = 0; turn < 260 && s.winner === null; turn++) {
        const a = botAction(s, difficulty);
        if (a.kind === 'wall') {
          assert.equal(clashOn([...s.walls, a.wall]), null,
            `bot wall ${a.wall.o}(${a.wall.x},${a.wall.y}) clashes`);
          assert.equal(wallOk(s, a.wall), true, 'the bot only offers walls the rules accept');
          placed++;
        }
        const next = apply(s, a);
        assert.ok(next, `bot action ${a.kind} was refused`);
        assert.equal(clashOn(next.walls), null, 'no board the bot plays on ever clashes');
        s = next;
      }
    }
  }
  assert.ok(races > 0 && placed > 20, `expected the bot to wall a few times, saw ${placed}`);
});

check('action modes: a ball in hand and a wall preview never share the board', () => {
  const wall = h(2, 5);
  /* a groove first, then a ball: the ball wins and the preview goes */
  const previewing = previewWall(BOARD_IDLE, wall);
  assert.deepEqual(previewing, { selected: null, preview: wall, mine: false });
  const picked = pickBall(previewing, 3);
  assert.equal(picked.selected, 3, 'the ball comes to hand');
  assert.equal(picked.preview, null, 'and the pending wall preview is cleared');
  assert.equal(moveDots(picked), true, 'so the dots are drawn');
  assert.equal(selectionRing(picked, 3), true, 'with the ring on that ball');
  assert.equal(selectionRing(picked, 4), false);

  /* a ball first, then a groove: the wall wins and the ball goes back down */
  const holding = pickBall(BOARD_IDLE, 3);
  assert.equal(moveDots(holding), true);
  const armed = previewWall(holding, { spec: wall, ok: true, armed: true, p: 0 });
  assert.equal(armed.selected, null, 'arming a wall drops the ball in hand');
  assert.equal(moveDots(armed), false, 'so no move dot is drawn');
  assert.equal(selectionRing(armed, 3), false, 'and no ball wears a selection ring');
  assert.equal(armed.preview.armed, true);

  /* a hover that leaves the board drops the bar alone, which is what makes it a hover */
  const hovered = previewWall(holding, { spec: wall, ok: true, armed: false, p: 0 });
  assert.equal(hovered.selected, null);
  assert.equal(previewWall(hovered, null).selected, null, 'nothing was in hand to restore');
  assert.equal(previewWall(holding, null).selected, 3, 'a plain hover-out keeps the ball in hand');

  /* the mine key owns the board outright */
  const keyed = holdMineKey(previewing, true);
  assert.deepEqual(keyed, { selected: null, preview: null, mine: true });
  assert.equal(moveDots(keyed), false);
  assert.equal(moveDots(pickBall(keyed, 1)), false, 'a ball cannot be in hand while the key is down');
  assert.deepEqual(holdMineKey(holding, false), { selected: 3, preview: null, mine: false });

  /* the invariant, over every reachable combination: never dots and a preview at once */
  for (const selected of [null, 0, 1]) {
    for (const preview of [null, wall]) {
      for (const mine of [false, true]) {
        const m = { selected, preview, mine };
        if (moveDots(m)) assert.equal(m.preview, null, 'dots without a preview');
        if (moveDots(m)) assert.equal(m.mine, false, 'dots without the mine key');
        if (m.preview !== null) assert.equal(moveDots(m), false, 'a preview suppresses the dots');
      }
    }
  }
});

check('action modes: a tap is the only thing that changes the board, and it is total', () => {
  /* whatever the board is doing, picking a ball leaves exactly one mode live */
  const states = [
    BOARD_IDLE,
    previewWall(BOARD_IDLE, h(1, 1)),
    holdMineKey(BOARD_IDLE, true),
    previewWall(holdMineKey(BOARD_IDLE, true), h(1, 1)),
  ];
  for (const s of states) {
    const picked = pickBall(s, 2);
    assert.equal(picked.selected, 2);
    assert.equal(picked.preview, null);
    assert.equal(picked.mine, s.mine, 'the mine key is the chip\'s to hold, not the board\'s');
  }
  /* ...and arming a wall leaves exactly one mode live from any of them */
  for (const s of states) {
    const armed = previewWall(s, h(1, 1));
    assert.equal(armed.preview.x, 1);
    assert.equal(armed.selected, null);
    assert.equal(moveDots(armed), false);
  }
});

console.log(`\n${run} wall checks passed`);
