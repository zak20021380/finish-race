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
  TUTORIAL_STEPS, NEXT_STAGE, tutorialAllows, shouldAutoStartTutorial,
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

const storage = await import(storageHref);

await check('a fresh save has not seen the lesson', () => {
  assert.equal(storage.hasCompletedTutorial(), false);
  assert.equal(storage.profile.tutorialCompleted, false);
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

console.log(`\n${ran} tutorial checks passed.`);
