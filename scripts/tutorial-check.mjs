/**
 * tutorial-check.mjs — the hands-on lesson's pure half, plus the save it writes.
 *
 * Asserts:
 *  - the lesson is exactly five stages over four visible steps, in the eyes-on-the-board order;
 *  - each stage's gate accepts only its exact target (right pawn, right tile, right groove,
 *    right mine cell) and refuses every other action;
 *  - the NEXT_STAGE chain walks select → move → wall → mine-arm → mine-place → done;
 *  - online seats, private rooms and completed saves never auto-start the lesson;
 *  - completeTutorial() persists `tutorialCompleted` through the real storage module, survives a
 *    module reload, and resetTutorialState() clears it (and the legacy bare key).
 *
 * Run: node --experimental-strip-types scripts/tutorial-check.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHOTS = path.resolve('.shots');
fs.mkdirSync(SHOTS, { recursive: true });
const href = (name) => pathToFileURL(path.join(SHOTS, name)).href;

let ran = 0;
const check = async (name, fn) => {
  await fn();
  ran++;
  console.log('ok -', name);
};

/* tutorial.ts imports only types from ./rules, so Node's type stripping can load it directly. */
const {
  TUTORIAL_STEPS, NEXT_STAGE, tutorialAllows, tutorialSpotBox, tutorialSpotHas,
  shouldAutoStartTutorial,
} = await import(pathToFileURL(path.resolve('src/tutorial.ts')).href);

/* ---------- the four-step lesson ---------- */

await check('the lesson is five stages over four visible steps', () => {
  assert.deepEqual(TUTORIAL_STEPS.map((s) => s.stage),
    ['select', 'move', 'wall', 'mine-arm', 'mine-place']);
  assert.deepEqual(TUTORIAL_STEPS.map((s) => s.group), [1, 2, 3, 4, 4]);
  assert.equal(TUTORIAL_STEPS[0].title, 'SELECT YOUR PIECE');
  assert.equal(TUTORIAL_STEPS[0].body, 'Tap your glowing piece to start.');
  assert.equal(TUTORIAL_STEPS[1].title, 'MOVE TO FINISH');
  assert.equal(TUTORIAL_STEPS[2].title, 'PLACE A WALL');
  assert.equal(TUTORIAL_STEPS[3].title, 'ARM A TRAP');
  assert.equal(TUTORIAL_STEPS[4].title, 'PLANT THE MINE');
  /* no stage carries a "next" action: the only way forward is the action itself */
  assert.equal(TUTORIAL_STEPS.every((s) => s.title.length > 0 && !('action' in s)), true);
});

await check('the forward chain is select → move → wall → arm → plant → done', () => {
  assert.equal(NEXT_STAGE.select, 'move');
  assert.equal(NEXT_STAGE.move, 'wall');
  assert.equal(NEXT_STAGE.wall, 'mine-arm');
  assert.equal(NEXT_STAGE['mine-arm'], 'mine-place');
  assert.equal(NEXT_STAGE['mine-place'], 'done');
});

const targets = {
  select: 7,
  move: { c: 2, r: 10 },
  wall: { o: 'h', x: 4, y: 10 },
  mineArm: true,
  mine: { c: 5, r: 9 },
};

await check('step 1 accepts only the local pawn', () => {
  assert.equal(tutorialAllows('select', targets, { kind: 'select', ball: 7 }), true);
  assert.equal(tutorialAllows('select', targets, { kind: 'select', ball: 8 }), false);
  assert.equal(tutorialAllows('select', targets, { kind: 'move', to: { c: 2, r: 10 } }), false);
  assert.equal(tutorialAllows('select', targets, { kind: 'mine-arm' }), false);
});

await check('step 2 accepts only the glowing forward tile', () => {
  assert.equal(tutorialAllows('move', targets, { kind: 'move', to: { c: 2, r: 10 } }), true);
  assert.equal(tutorialAllows('move', targets, { kind: 'move', to: { c: 2, r: 9 } }), false);
  assert.equal(tutorialAllows('move', targets, { kind: 'move', to: { c: 3, r: 10 } }), false);
  assert.equal(tutorialAllows('move', targets, { kind: 'wall', spec: targets.wall }), false);
});

await check('step 3 accepts only the highlighted groove', () => {
  assert.equal(tutorialAllows('wall', targets, { kind: 'wall', spec: { o: 'h', x: 4, y: 10 } }), true);
  assert.equal(tutorialAllows('wall', targets, { kind: 'wall', spec: { o: 'h', x: 5, y: 10 } }), false);
  assert.equal(tutorialAllows('wall', targets, { kind: 'wall', spec: { o: 'h', x: 4, y: 9 } }), false);
  assert.equal(tutorialAllows('wall', targets, { kind: 'wall', spec: { o: 'v', x: 4, y: 10 } }), false);
  assert.equal(tutorialAllows('wall', targets, { kind: 'mine', cell: targets.mine }), false);
});

await check('step 3 is a single tap anywhere inside the spotlight, not only the groove', () => {
  /* a groove spot is a hairline: 30x8 padded by 7 and floored at a 48px thumb */
  const spot = { rect: { left: 100, top: 200, width: 30, height: 8 }, radius: 10 };
  const box = tutorialSpotBox(spot);
  assert.deepEqual(box, { left: 91, top: 180, width: 48, height: 48 });
  assert.equal(tutorialSpotHas(spot, 100, 204), true);          // the groove itself
  assert.equal(tutorialSpotHas(spot, box.left + 1, box.top + 1), true);  // a padded corner
  assert.equal(tutorialSpotHas(spot, box.left + box.width - 1, box.top + box.height - 1), true);
  assert.equal(tutorialSpotHas(spot, box.left - 1, 204), false);
  assert.equal(tutorialSpotHas(spot, 100, box.top - 1), false);
});

await check('step 4A accepts only the mine key', () => {
  assert.equal(tutorialAllows('mine-arm', targets, { kind: 'mine-arm' }), true);
  assert.equal(tutorialAllows('mine-arm', { ...targets, mineArm: false }, { kind: 'mine-arm' }), false);
  assert.equal(tutorialAllows('mine-arm', targets, { kind: 'mine', cell: targets.mine }), false);
});

await check('step 4B accepts only the glowing mine tile', () => {
  assert.equal(tutorialAllows('mine-place', targets, { kind: 'mine', cell: { c: 5, r: 9 } }), true);
  assert.equal(tutorialAllows('mine-place', targets, { kind: 'mine', cell: { c: 5, r: 8 } }), false);
  assert.equal(tutorialAllows('mine-place', targets, { kind: 'mine-arm' }), false);
});

await check('a closed or celebrating lesson accepts nothing', () => {
  assert.equal(tutorialAllows(null, targets, { kind: 'mine-arm' }), false);
  assert.equal(tutorialAllows('done', targets, { kind: 'select', ball: 7 }), false);
});

/* ---------- auto-start rules ---------- */

await check('the lesson only auto-starts in a local, incomplete bot race', () => {
  assert.equal(shouldAutoStartTutorial({ online: false, room: false, completed: false }), true);
  assert.equal(shouldAutoStartTutorial({ online: true, room: false, completed: false }), false);
  assert.equal(shouldAutoStartTutorial({ online: false, room: true, completed: false }), false);
  assert.equal(shouldAutoStartTutorial({ online: false, room: false, completed: true }), false);
});

/* ---------- the client-side red / blue perspective ---------- */

const themes = await import(pathToFileURL(path.resolve('src/themes.ts')).href);

await check('the perspective paints the local seat its colour and the rival the opposite', () => {
  const blueLocal = themes.perspectiveRamps(0, 1, 'blue');
  assert.equal(blueLocal[0].mid, themes.BOT_RAMP.mid);
  assert.equal(blueLocal[1].mid, themes.RED_RAMP.mid);
  /* the same choice when the matchmaker seats this client on the right: index never decides */
  const blueRight = themes.perspectiveRamps(1, 0, 'blue');
  assert.equal(blueRight[1].mid, themes.BOT_RAMP.mid);
  assert.equal(blueRight[0].mid, themes.RED_RAMP.mid);
  const redLocal = themes.perspectiveRamps(0, 1, 'red');
  assert.equal(redLocal[0].mid, themes.RED_RAMP.mid);
  assert.equal(redLocal[1].mid, themes.BOT_RAMP.mid);
  assert.equal(themes.oppositeColor('red'), 'blue');
  assert.equal(themes.oppositeColor('blue'), 'red');
});

/* ---------- storage: the real module against a localStorage shim ---------- */

const memory = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
  },
};

const writeTwin = (name, source) => {
  const out = path.join(SHOTS, name);
  fs.writeFileSync(out, source);
  return pathToFileURL(out).href;
};
const dataHref = writeTwin('countries-data-under-test.mjs',
  `export default ${fs.readFileSync(path.resolve('src/data/countries.json'), 'utf8')};`);
const themesHref = writeTwin('themes-under-test.ts', fs.readFileSync('src/themes.ts', 'utf8'));
const teamsHref = writeTwin('teams-under-test.ts', fs.readFileSync('src/teams.ts', 'utf8'));
const countriesHref = writeTwin('countries-under-test.ts',
  fs.readFileSync('src/countries.ts', 'utf8')
    .replace("from './data/countries.json'", `from '${dataHref}'`));
const map = { themes: themesHref, countries: countriesHref, teams: teamsHref };
const storageHref = writeTwin('storage-under-test.ts',
  fs.readFileSync('src/storage.ts', 'utf8')
    .replace(/from '\.\/(themes|countries|teams)'/g, (_m, name) => `from '${map[name]}'`));

/* rules + the pure mine-demo planner: Node cannot resolve the extensionless './hazards' import,
   so the rules module is loaded through twins exactly as the mines suite does. */
const hazardsHref = writeTwin('hazards-under-test.ts',
  fs.readFileSync('src/hazards.ts', 'utf8').replaceAll("from './rules'", "from './rules-under-test.ts'"));
const rulesHref = writeTwin('rules-under-test.ts',
  fs.readFileSync('src/rules.ts', 'utf8').replaceAll("from './hazards'", `from '${hazardsHref}'`));
const rules = await import(rulesHref);
const { pickMineDemo } = await import(pathToFileURL(path.resolve('src/tutorialDemo.ts')).href);

await check('step 4 plants a mine two legal steps ahead, and the second step detonates it', () => {
  const fresh = rules.newGame([1, 1], { hazards: false, seed: 7 });
  /* the board the tutorial reaches after the wall reply: the rival sits one row up and to the
     right of its start square, with the local seat to move */
  const board = {
    ...fresh,
    turn: 0,
    balls: fresh.balls.map((b) => (b.team === 1 ? { ...b, pos: { c: 5, r: 10 } } : b)),
  };
  const rival = board.balls.find((b) => b.team === 1);
  const plan = pickMineDemo(board, rival, rules.mineCells(board, 0), (s, team) => rules.steps(s, team));
  assert.ok(plan, 'no mine square had a two-step approach');
  assert.deepEqual(plan.cell, { c: 5, r: 8 });
  assert.deepEqual(plan.path.map((p) => p.to), [{ c: 5, r: 9 }, { c: 5, r: 8 }]);

  let game = rules.apply(board, { kind: 'mine', cell: plan.cell });
  assert.equal(game.turn, 1);
  assert.equal(game.mines[0].triggered, false);
  game = rules.apply(game, { kind: 'move', ball: plan.path[0].ball, to: plan.path[0].to });
  assert.equal(game.mines[0].triggered, false, 'the first step must not reach the charge');
  game = rules.apply(game, { kind: 'pass' });                 // the lesson yields the local turn
  game = rules.apply(game, { kind: 'move', ball: plan.path[1].ball, to: plan.path[1].to });
  assert.equal(game.mines[0].triggered, true, 'the second step did not set the mine off');
  const thrown = game.balls.find((b) => b.team === 1);
  assert.ok(thrown.pos.r > plan.cell.r, 'the blast did not throw the rival back');
  assert.equal(game.turn, 0, 'the demonstration must hand the lesson back to the local seat');
});

const storage = await import(storageHref);

await check('a fresh save has not seen the lesson', () => {
  assert.equal(storage.hasCompletedTutorial(), false);
  assert.equal(storage.profile.tutorialCompleted, false);
});

await check('a fresh save plays red; blue is persisted without touching the game record', () => {
  assert.equal(storage.pieceColor(), 'red');
  const before = JSON.parse(JSON.stringify(storage.profile));
  assert.equal(storage.setPieceColor('blue'), true);
  assert.equal(storage.pieceColor(), 'blue');
  assert.equal(storage.profile.coins, before.coins);
  assert.deepEqual(storage.profile.stats, before.stats);
  assert.deepEqual(storage.profile.equipped, before.equipped);
  const raw = JSON.parse(memory.get('detour.save.v2'));
  assert.equal(raw.pieceColor, 'blue');
  assert.equal(storage.setPieceColor('blue'), false, 're-choosing the live colour is a no-op');
});

await check('completion is written to the real save', () => {
  storage.completeTutorial();
  assert.equal(storage.hasCompletedTutorial(), true);
  assert.equal(storage.profile.tutorialCompleted, true);
  const raw = JSON.parse(memory.get('detour.save.v2'));
  assert.equal(raw.tutorialCompleted, true);
});

await check('completion survives a reload', async () => {
  const reloaded = await import(`${storageHref}?reload=complete`);
  assert.equal(reloaded.hasCompletedTutorial(), true);
  assert.equal(reloaded.profile.tutorialCompleted, true);
});

const reloaded = await import(`${storageHref}?reload=reset`);
memory.set('tutorial_completed', '1');

await check('reset clears the save and the legacy bare key', () => {
  reloaded.resetTutorialState();
  assert.equal(reloaded.hasCompletedTutorial(), false);
  assert.equal(memory.has('tutorial_completed'), false);
  const raw = JSON.parse(memory.get('detour.save.v2'));
  assert.equal(raw.tutorialCompleted, false);
});

await check('a reset save starts the lesson again after another reload', async () => {
  const again = await import(`${storageHref}?reload=after-reset`);
  assert.equal(again.hasCompletedTutorial(), false);
});

await check('an unknown piece colour migrates to red; a valid one survives', async () => {
  const raw = JSON.parse(memory.get('detour.save.v2'));
  raw.v = 2;
  raw.pieceColor = 'violet';
  memory.set('detour.save.v2', JSON.stringify(raw));
  const bad = await import(`${storageHref}?reload=bad-color`);
  assert.equal(bad.pieceColor(), 'red');

  raw.pieceColor = 'blue';
  memory.set('detour.save.v2', JSON.stringify(raw));
  const good = await import(`${storageHref}?reload=good-color`);
  assert.equal(good.pieceColor(), 'blue');
});

console.log(`\n${ran} tutorial checks passed.`);
