/**
 * room-check.mjs — the corridor rule, the anti-oscillation ledger, and 4-seat mixed rooms.
 * Run: node --experimental-strip-types scripts/room-check.mjs
 *
 * Two behaviours, both of them things a race used to get wrong:
 *
 *   1. THE CORRIDOR. A ball may not walk into another ball and may no longer jump straight over a
 *      rival that blocks its way to FINISH: the rival's flanks are the way around, and when the lane
 *      itself is sealed the ledger ends the shuffle. Both are checked here on real boards, driven by
 *      the real bot, until somebody crosses FINISH.
 *   2. THE ROOM. A four-seat room used to stall whenever fewer than four people turned up. It now
 *      backfills every vacant seat with a bot when the wait runs out, ladders those bots across
 *      Normal and Hard, plays them itself, takes a seat over when its person leaves, and pays only
 *      the seats a person actually held. Every one of those is asserted here on a real race.
 *
 * Everything is seeded, including `Math.random`, so a run is reproducible.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* rules.ts ↔ hazards.ts ↔ bot.ts ↔ room.ts say `from './rules'`, which Vite resolves and Node does
   not. Rewrite the specifiers into generated twins in .shots/, exactly as the other checks do, so
   what is under test is rebuilt from src on every run and all four share one instance each. */
const NAMES = ['rules', 'hazards', 'bot', 'room'];
const HREF = Object.fromEntries(NAMES.map((n) => [n, pathToFileURL(path.resolve('.shots', `room-${n}.ts`)).href]));
fs.mkdirSync('.shots', { recursive: true });
for (const n of NAMES) {
  const src = fs.readFileSync(path.join('src', `${n}.ts`), 'utf8')
    .replace(/from '\.\/(rules|hazards|bot|room)'/g, (_m, m) => `from '${HREF[m]}'`);
  fs.writeFileSync(new URL(HREF[n]), src);
}
const R = await import(HREF.rules);
const { newGame, apply, steps, stepField, distField, pathOn, getAutoMove, view, COLS, ROWS,
  REPEAT_LIMIT, REPEAT_ADJUDICATE, boardFingerprint } = R;
const ROOM = await import(HREF.room);
const {
  ROOM_WAIT_MS, backfill, botCount, createRoom, createRoomDriver, difficultyFor, humanCount,
  isAutomated, launch, lobbyLine, rewardEligible, seatBadge, seatHuman, sizesOf, startEarly,
  takeover, tick, vacantSeats, waitLeft,
  FORMAT_CAPACITY, FORMAT_LINE, FORMAT_MODE, FORMAT_NAME, LOBBY_FORMATS, assignTeam,
  defaultTeam, formatOfMode, isLobbyFormat, reflowRoom, reflowSeats, teamCapacity,
} = ROOM;

/* ---------- seeded randomness, so a run is a run and not a mood ---------- */
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = mulberry32(Number(process.env.SEED || 0x5eed));

let run = 0;
const check = (name, fn) => { fn(); run++; console.log('ok -', name); };

/* ---------- board helpers ---------- */

const put = (s, id, c, r) => ({ ...s, balls: s.balls.map((b) => (b.id === id ? { ...b, pos: { c, r } } : b)) });
const ballAt = (s, id) => s.balls.find((b) => b.id === id).pos;
const wall = (o, x, y) => ({ o, x, y, owner: 0 });
const targets = (s, team, id) => steps(s, team).filter((st) => st.ball === id).map((st) => st.to);
const has = (list, c, r) => list.some((p) => p.c === c && p.r === r);
const show = (list) => list.map((p) => `(${p.c},${p.r})`).join(' ') || 'none';

/**
 * A one-wide corridor down column 3, rows 5..9: vertical walls seal both sides of the lane, and the
 * lane's own mouth is sealed by a horizontal wall above row 5. Two balls dropped in it can never
 * reach FINISH from inside — the only way out is back down and around — which is precisely the
 * shape that used to shuffle forever.
 */
function corridor({ sealedMouth = true } = {}) {
  let s = newGame([1, 1]);
  s = put(s, 0, 3, 8);
  s = put(s, 1, 3, 7);
  const walls = [
    wall('v', 3, 5), wall('v', 3, 7),          // left of column 3, rows 5..8
    wall('v', 4, 5), wall('v', 4, 7),          // right of column 3, rows 5..8
  ];
  if (sealedMouth) walls.push(wall('h', 3, 5)); // the line above row 5, covering column 3
  return { ...s, walls };
}

/* ---------- 1. the leap rules ---------- */

check('leap: a rival ahead blocks the straight leap, and its flanks are the way around', () => {
  let s = put(newGame([1, 1]), 0, 3, 8);
  s = put(s, 1, 3, 7);
  const list = targets(s, 0, 0);
  assert.ok(!has(list, 3, 6), `the trailing ball jumped the rival ahead: ${show(list)}`);
  assert.ok(has(list, 2, 7) && has(list, 4, 7), `expected both flank hops around the rival, got ${show(list)}`);
  assert.ok(!has(list, 3, 7), 'the leap must not land on the body itself');
});

check('leap: a team-mate ahead is still a stepping stone', () => {
  let s = put(newGame([1, 1]), 0, 3, 8);
  s = put(s, 1, 3, 7);
  s = {
    ...s,
    teams: [{ balls: 2 }, { balls: 0 }],
    balls: s.balls.map((b) => ({ ...b, team: 0, owner: 0 })),
  };
  const list = targets(s, 0, 0);
  assert.ok(has(list, 3, 6), `an own-team body was treated as a rival wall: ${show(list)}`);
});

check('leap: a walled back becomes a sidestep onto the body\'s flank', () => {
  let s = newGame([1, 1]);
  s = put(s, 0, 3, 6);
  s = put(s, 1, 3, 5);
  s = { ...s, walls: [wall('h', 3, 5)] };        // the square behind the body is shut
  const list = targets(s, 0, 0);
  assert.ok(has(list, 2, 5) && has(list, 4, 5), `expected both flanks, got ${show(list)}`);
  assert.ok(!has(list, 3, 4), 'a shut square is not a landing');
});

/**
 * The same lane with the square behind the body walled as well, so the body is hemmed in on all
 * three sides. Then it really is a wall, and the only way out of the lane is back the way it came.
 */
function hemmed() {
  let s = newGame([1, 1]);
  s = put(s, 0, 3, 7);
  s = put(s, 1, 3, 6);
  return {
    ...s,
    walls: [
      wall('v', 3, 5), wall('v', 3, 7),          // left of column 3, rows 5..8
      wall('v', 4, 5), wall('v', 4, 7),          // right of column 3, rows 5..8
      wall('h', 3, 6),                           // the square directly behind the body
    ],
  };
}

check('leap: a body hemmed in on all three sides is a wall, and nothing is offered', () => {
  const list = targets(hemmed(), 0, 0);
  assert.deepEqual(list, [{ c: 3, r: 8 }],
    `a hemmed body was leapt anyway, or the lane opened up: ${show(list)}`);
});

check('leap: never two balls on one square — every landing is empty', () => {
  for (let g = 0; g < 120; g++) {
    const sizes = [[1, 1], [1, 1, 1], [1, 1, 1, 1], [2, 2]][g % 4];
    let s = newGame(sizes);
    for (let i = 0; i < 40 && s.winner === null; i++) {
      const list = steps(s, s.turn);
      if (!list.length) { s = apply(s, { kind: 'pass' }); continue; }
      const st = list[(Math.random() * list.length) | 0];
      const next = apply(s, { kind: 'move', ball: st.ball, to: st.to });
      assert.ok(next, `a legal step was refused: ${JSON.stringify(st)}`);
      const seen = new Set();
      for (const b of next.balls) {
        const k = b.pos.r * next.cols + b.pos.c;
        assert.ok(!seen.has(k), 'two balls landed on one square');
        seen.add(k);
      }
      s = next;
    }
  }
});

check('stepField: a rival ahead is not a one-action bridge, but a flank hop still is', () => {
  const s = corridor({ sealedMouth: false });
  const d = stepField(s, 0);
  /* the ball at (3,8) can no longer leap the rival at (3,7): it must walk all the way round */
  assert.ok(pathOn(d, { c: 3, r: 8 }, s.cols) > 7, 'the leap shortcut was still counted as one action');
  assert.ok(Number.isFinite(pathOn(d, { c: 3, r: 8 }, s.cols)), 'the mover has no route at all');
  assert.ok(pathOn(d, { c: 3, r: 7 }, s.cols) >= 0, 'a body cell has no distance of its own');
  /* put the same two balls on an open board: the flank hop around the rival is one action */
  const open = put(put(newGame([1, 1]), 0, 3, 8), 1, 3, 7);
  assert.equal(pathOn(stepField(open, 0), { c: 3, r: 8 }, open.cols), 8,
    'a flank hop should still count as one action, not a wall');
  /* and a sealed corridor really is sealed: the bare board still reaches FINISH from inside */
  const sealed = corridor();
  assert.ok(Number.isFinite(pathOn(distField(sealed.walls, sealed.cols, sealed.rows), { c: 3, r: 7 }, sealed.cols)),
    'the corridor must stay legal: every ball keeps a path to FINISH');
});

/* ---------- 2. the corridor race actually finishes ---------- */

/**
 * Drive a board to its finish with the engine's own auto-move, watching what it plays. Returns the
 * trace so a check can assert on how the race got out of the lane, not only that it did.
 */
function race(s, cap = 400) {
  const leaps = [];
  let turns = 0, forcedAt = -1;
  for (; turns < cap && s.winner === null; turns++) {
    const a = getAutoMove(s, s.turn);
    const mover = a.kind === 'move' ? s.balls.find((b) => b.id === a.ball) ?? null : null;
    const next = apply(s, a);
    assert.ok(next, `the engine played an illegal turn: ${JSON.stringify(a)}`);
    if (mover) {
      const dist = Math.abs(a.to.c - mover.pos.c) + Math.abs(a.to.r - mover.pos.r);
      if (dist === 2) leaps.push({ turn: turns, seat: s.turn, from: { ...mover.pos }, to: a.to });
    }
    if (forcedAt < 0 && (next.repeat?.streak ?? 0) >= REPEAT_LIMIT) forcedAt = turns;
    s = next;
  }
  return { state: s, turns, leaps, forcedAt };
}

check('corridor: the trailing ball follows the leader out instead of leaping it', () => {
  const r = race(corridor({ sealedMouth: false }));
  assert.ok(r.state.winner !== null, `the lane never opened: ${r.turns} turns, no winner`);
  assert.equal(r.leaps.length, 0, 'a trailing ball jumped a rival ahead of it');
  assert.ok(r.turns < 200, `the lane took ${r.turns} turns — that is a shuffle, not a race`);
  console.log(`   (open lane: ${r.turns} turns, ${r.leaps.length} leaps, finished without a jump)`);
});

check('corridor: a lane whose far end is sealed cannot trap the race either', () => {
  /* The leap cannot help here — the square behind the body is walled and so are both flanks — so a
     seat that insists on pushing forward shuffles between the same handful of squares forever. That
     is the old deadlock exactly. The guard is what breaks it, and it breaks it through `steps()`:
     once the board repeats, the only moves the engine will offer are the ones that give ground, so
     the seat that wanted to go up is sent back down and the two balls walk out of the lane. */
  let s = corridor();
  let turns = 0, forcedAt = -1, overriddenAt = -1;
  for (; turns < 120 && s.winner === null; turns++) {
    const list = steps(s, s.turn);
    assert.ok(list.length, `the seat on turn was offered nothing at all: turn ${turns}`);
    const up = list.slice().sort((a, b) => a.to.r - b.to.r || a.to.c - b.to.c)[0];
    const before = s.balls.find((b) => b.id === up.ball).pos;
    const next = apply(s, { kind: 'move', ball: up.ball, to: up.to });
    assert.ok(next, `the engine refused a step it had just offered: turn ${turns}`);
    if (forcedAt < 0 && (next.repeat?.streak ?? 0) >= REPEAT_LIMIT) forcedAt = turns;
    if (forcedAt >= 0 && overriddenAt < 0) {
      const moved = next.balls.find((b) => b.id === up.ball);
      if (moved.pos.r > before.r) overriddenAt = turns;   // it asked to climb and was sent back down
    }
    s = next;
  }
  assert.ok(forcedAt >= 0, `the ledger never reached REPEAT_LIMIT (${REPEAT_LIMIT}): the guard is dead`);
  assert.ok(overriddenAt >= 0, 'the guard never overrode the seat\'s own choice: it is not forcing');
  assert.ok(s.winner !== null, `the sealed lane never resolved: ${turns} turns, no winner`);
  console.log(`   (sealed lane: guard engaged at turn ${forcedAt}, overrode the push at turn `
    + `${overriddenAt}, race done in ${turns})`);
});

/* ---------- 3. the anti-oscillation ledger ---------- */

check('ledger: a board the race has been in before is recognised and counted', () => {
  /* two balls in pockets that offer no forward step at all, shuffled by hand */
  let s = newGame([1, 1]);
  s = put(s, 0, 0, 6);
  s = put(s, 1, 5, 6);
  s = { ...s, walls: [wall('h', 0, 6), wall('h', 5, 6)] };
  const cycle = [
    [{ c: 0, r: 7 }, { c: 5, r: 7 }],
    [{ c: 0, r: 6 }, { c: 5, r: 6 }],
  ];
  const streaks = [];
  for (let i = 0; i < 12 && s.winner === null; i++) {
    const to = cycle[Math.floor(i / 2) % 2][s.turn];
    const next = apply(s, { kind: 'move', to });
    streaks.push(next ? s.repeat.streak : -1);
    if (!next) break;                            // the guard refused to give ground back
    s = next;
  }
  assert.ok(streaks.includes(REPEAT_LIMIT), `the streak never reached the limit: ${streaks.join(',')}`);
  assert.equal(streaks[streaks.length - 1], -1, 'the backward step was never refused');
});

check('ledger: a race caught in a repetition is adjudicated on the board', () => {
  /* The ledger is part of the state, so a test can stand a race one repeat away from the
     adjudication and assert what the engine does with it: the board decides, instantly, and both
     seats can work out the same verdict from the same position. */
  let s = put(newGame([1, 1]), 0, 2, 5);        // team 0 is plainly the nearer ball
  const move = { kind: 'move', ball: 0, to: { c: 2, r: 4 } };
  const after = apply(s, move);
  assert.ok(after, 'the stepping move was refused');
  const brink = {
    ...s,
    turn: 0,
    repeat: { seen: [boardFingerprint(after)], streak: REPEAT_ADJUDICATE - 1 },
  };
  const decided = apply(brink, move);
  assert.ok(decided, 'the adjudicating move was refused');
  assert.equal(decided.adjudicated, true, 'the win was not marked as an adjudication');
  assert.ok(decided.repeat.streak >= REPEAT_ADJUDICATE, `streak only reached ${decided.repeat.streak}`);
  /* the board decides it: the ball nearer FINISH takes the race */
  const d = distField(decided.walls, decided.cols, decided.rows);
  const mine = pathOn(d, ballAt(decided, 0), decided.cols);
  const theirs = pathOn(d, ballAt(decided, 1), decided.cols);
  assert.ok(mine < theirs, 'the fixture did not leave the right team ahead');
  assert.equal(decided.winner, 0, 'the nearest ball did not take it');
});

check('ledger: a pass is not a board the race has been in', () => {
  let s = newGame([1, 1, 1], { hazards: true, seed: 5 });
  for (let i = 0; i < 12; i++) {
    s = apply(s, { kind: 'pass' });
    assert.equal(s.repeat.streak, 0, 'a table of passers tripped the shuffle guard');
  }
});

check('ledger: the ledger is public and identical from both seats', () => {
  let s = newGame([1, 1]);
  for (let i = 0; i < 8; i++) s = apply(s, { kind: 'move', to: targets(s, s.turn, s.balls.find((b) => b.team === s.turn).id)[0] });
  for (let t = 0; t < s.teams.length; t++) {
    assert.deepEqual(view(s, t).repeat, s.repeat, 'a seat was given a different ledger');
  }
});

check('determinism: the same board and the same actions give the same race', () => {
  const play = () => {
    let s = newGame([1, 1, 1, 1], { hazards: true, seed: 4242 });
    const moves = [];
    for (let i = 0; i < 60 && s.winner === null; i++) {
      const a = getAutoMove(s, s.turn);
      moves.push(a);
      s = apply(s, a);
    }
    return { moves, json: JSON.stringify(s) };
  };
  const a = play(), b = play();
  assert.equal(a.json, b.json, 'two identical races diverged');
  assert.deepEqual(a.moves, b.moves, 'two identical races played different moves');
});

/* ---------- 4. the room: seats, backfill, tiers ---------- */

const host = (id = 'p-host', name = 'Host') => ({ kind: 'human', id, name });

check('room: seats are held open until somebody takes them', () => {
  const room = createRoom({ code: '1234', seats: 4, host: host(), now: 0 });
  assert.equal(room.seats.length, 4);
  assert.equal(humanCount(room), 1, 'the host holds one seat');
  assert.deepEqual(vacantSeats(room), [1, 2, 3]);
  assert.equal(room.launched, false);
  assert.ok(!isAutomated(room, 1), 'a vacant seat is not yet the machine\'s');
  assert.equal(botCount(room), 0, 'a vacant seat was counted as a bot');
  assert.equal(seatBadge(room, 0), null, 'a person\'s seat wears no badge');
});

check('room: the wait timer runs out and every empty seat is backfilled', () => {
  const room = createRoom({ code: '1234', seats: 4, host: host(), waitMs: ROOM_WAIT_MS, now: 1000 });
  assert.equal(tick(room, 1000 + ROOM_WAIT_MS - 1), room, 'the room launched before its wait was up');
  assert.equal(waitLeft(room, 1000 + 4000), 4000);
  const started = tick(room, 1000 + ROOM_WAIT_MS);
  assert.equal(started.launched, true, 'the room never launched');
  assert.deepEqual(vacantSeats(started), [], 'a seat was left empty');
  assert.equal(humanCount(started), 1);
  assert.equal(botCount(started), 3);
  assert.deepEqual(sizesOf(started), [1, 1, 1, 1]);
  assert.ok(lobbyLine(started, 0).includes('1 human') && lobbyLine(started, 0).includes('3 bots'),
    `the lobby caption lied: ${lobbyLine(started, 0)}`);
});

check('room: the host can start early, and the backfill is the same either way', () => {
  const late = tick(createRoom({ code: '1', seats: 4, host: host(), now: 0 }), ROOM_WAIT_MS);
  const early = startEarly(createRoom({ code: '1', seats: 4, host: host(), now: 0 }));
  assert.deepEqual(early.seats.map((s) => s.kind), late.seats.map((s) => s.kind));
  assert.equal(early.launched, true);
  assert.equal(backfill(early), early, 'backfill is not idempotent');
  assert.equal(launch(early), early, 'launch is not idempotent');
});

check('room: backfilled bots are ladders, not three copies of one opponent', () => {
  const room = startEarly(createRoom({ code: '1', seats: 4, host: host(), botTier: 'mixed', now: 0 }));
  assert.deepEqual([1, 2, 3].map((i) => difficultyFor(room, i)), ['hard', 'normal', 'hard']);
  assert.deepEqual([1, 2, 3].map((i) => room.seats[i].difficulty), ['hard', 'normal', 'hard'],
    'the seat records a different tier from the one it plays');
  const flat = startEarly(createRoom({ code: '1', seats: 4, host: host(), botTier: 'normal', now: 0 }));
  assert.deepEqual([1, 2, 3].map((i) => difficultyFor(flat, i)), ['normal', 'normal', 'normal']);
  const hard = startEarly(createRoom({ code: '1', seats: 3, host: host(), botTier: 'hard', now: 0 }));
  assert.deepEqual([1, 2].map((i) => difficultyFor(hard, i)), ['hard', 'hard']);
});

check('room: a person takes a seat right up to the moment it launches', () => {
  let room = createRoom({ code: '1', seats: 4, host: host(), now: 0 });
  room = seatHuman(room, 1, { kind: 'human', id: 'p-two', name: 'Rune' });
  assert.deepEqual(vacantSeats(room), [2, 3]);
  const started = tick(room, ROOM_WAIT_MS);
  assert.deepEqual(started.seats.map((s) => s.name), ['Host', 'Rune', 'Bot 2', 'Bot 3']);
  assert.deepEqual(started.seats.map((s) => s.kind), ['human', 'human', 'bot', 'bot']);
  /* a launched roster is frozen: a late arrival cannot displace the backfill */
  const late = seatHuman(started, 2, { kind: 'human', id: 'p-late', name: 'Late' });
  assert.equal(late, started, 'a launched room accepted a new seat');
});

check('room: only a person who stayed can be paid a win', () => {
  let room = createRoom({ code: '1', seats: 4, host: host(), now: 0 });
  room = seatHuman(room, 1, { kind: 'human', id: 'p-two', name: 'Rune' });
  room = startEarly(room);
  assert.equal(rewardEligible(room, 0), true, 'the host is a person and stayed');
  assert.equal(rewardEligible(room, 1), true, 'the second person is a person and stayed');
  for (const i of [2, 3]) {
    assert.equal(rewardEligible(room, i), false, `a backfilled bot claimed seat ${i}`);
    assert.equal(seatBadge(room, i), 'bot', `seat ${i} wears no bot badge`);
  }
  /* and a person who walks out of a seat the machine finishes is no longer a person's win */
  const left = takeover(room, 1);
  assert.equal(rewardEligible(left, 1), false, 'a seat the machine finished was still paid');
  assert.equal(seatBadge(left, 1), 'takeover', 'a taken-over seat wears no badge');
  assert.ok(isAutomated(left, 1), 'a taken-over seat is not the machine\'s');
  assert.equal(humanCount(left), 1);
});

/* ---------- 5. mixed rooms play a whole race ---------- */

/**
 * Drive a room to its finish. Every person plays `pick`, which is handed the live state and the
 * seat; every machine turn is played by the driver. Returns the trace, so a caller can assert on
 * what actually happened rather than only on how it ended.
 */
function playRoom(spec, seed, pick, cap = 900) {
  let room = createRoom({ code: '4242', seats: spec.length, botTier: 'mixed', now: 0 });
  for (let i = 0; i < spec.length; i++) {
    if (spec[i]) room = seatHuman(room, i, { kind: 'human', id: spec[i].id, name: spec[i].name });
  }
  const driver = createRoomDriver(startEarly(room), { hazards: true, seed });
  const trace = [];
  let turns = 0, bots = 0, humans = 0, worst = 0;
  for (; turns < cap && driver.state.winner === null; ) {
    const seat = driver.turn;
    if (driver.botTurn) {
      const t0 = performance.now();
      const played = driver.runBots();
      worst = Math.max(worst, performance.now() - t0);
      assert.ok(played.length > 0, 'the driver said it was the machine\'s turn and played nothing');
      const seats = driver.room.seats.length;
      for (let i = 0; i < played.length; i++) {
        assert.equal(played[i].seat, (seat + i) % seats, 'the machine played out of turn');
        trace.push({ seat: played[i].seat, action: played[i].action });
      }
      turns += played.length;
      continue;
    }
    const action = pick(driver.state, seat);
    const result = driver.submit(seat, action);
    assert.ok(result.ok, `a person's legal action was refused: ${JSON.stringify(action)} / ${result.reason}`);
    for (const ev of result.events) trace.push({ seat: ev.seat, action: ev.action });
    turns += result.events.length;
  }
  /* classify every turn by who actually played it, not by which branch happened to play it: a
     person's own move and the machine's answer arrive in one batch, so the branch tells you nothing */
  for (const t of trace) (isAutomated(driver.room, t.seat) ? bots++ : humans++);
  return { driver, room: driver.room, trace, turns, bots, humans, worst };
}

const greedy = (s, seat) => {
  const a = getAutoMove(s, seat);
  return a.kind === 'move' ? a : { kind: 'pass' };
};

check('room race: 1 human + 3 bots initialises, plays every turn and concludes', () => {
  const r = playRoom([{ id: 'p-a', name: 'Ada' }, null, null, null], 9001, greedy);
  assert.ok(r.driver.state.winner !== null, `the race never concluded: ${r.turns} turns`);
  assert.ok(r.bots > 0, 'no machine seat ever played');
  assert.ok(r.humans > 0, 'the person never played');
  assert.equal(r.room.seats.filter((s) => s.kind === 'bot').length, 3);
  assert.equal(r.driver.payable(0), true, 'the person was not payable');
  for (const i of [1, 2, 3]) assert.equal(r.driver.payable(i), false, `bot seat ${i} was payable`);
  /* every action in the trace was played by the seat whose turn it was, in order */
  assert.ok(r.trace.length > 0);
  console.log(`   (1+3 room: ${r.trace.length} turns, ${r.bots} machine, winner seat ${r.driver.state.winner})`);
});

check('room race: 2 humans + 2 bots — the machine answers whoever moves', () => {
  const r = playRoom([{ id: 'p-a', name: 'Ada' }, { id: 'p-b', name: 'Rune' }, null, null], 9002, greedy);
  assert.ok(r.driver.state.winner !== null, `the race never concluded: ${r.turns} turns`);
  assert.ok(r.bots > 0 && r.humans > 0, 'one side of the room never played');
  const seatsPlayed = new Set(r.trace.map((t) => t.seat));
  assert.ok(seatsPlayed.size >= 3, `only ${seatsPlayed.size} seats ever moved`);
  console.log(`   (2+2 room: ${r.trace.length} turns, ${r.bots} machine, winner seat ${r.driver.state.winner})`);
});

check('room race: every board a room plays is legal and finishes, on every mix', () => {
  const mixes = [
    [null, null, null, null],
    [{ id: 'p-a', name: 'A' }, null, null, null],
    [{ id: 'p-a', name: 'A' }, { id: 'p-b', name: 'B' }, null, null],
    [{ id: 'p-a', name: 'A' }, { id: 'p-b', name: 'B' }, { id: 'p-c', name: 'C' }, null],
    [{ id: 'p-a', name: 'A' }, { id: 'p-b', name: 'B' }, { id: 'p-c', name: 'C' }, { id: 'p-d', name: 'D' }],
  ];
  let longest = 0;
  for (let g = 0; g < 25; g++) {
    const spec = mixes[g % mixes.length];
    const r = playRoom(spec, 7000 + g, greedy);
    assert.ok(r.driver.state.winner !== null, `mix ${g} never concluded`);
    longest = Math.max(longest, r.turns);
  }
  console.log(`   (25 mixed rooms, longest ${longest} turns)`);
});

check('room race: input isolation — only the seat on turn, and only a person, may act', () => {
  /* Seat 0 is left vacant and seat 1 is a person, so the driver opens on a machine turn: the two
     refusals can be told apart without racing the driver's own batch. */
  let room = createRoom({ code: '1', seats: 2, botTier: 'mixed', now: 0 });
  room = seatHuman(room, 1, { kind: 'human', id: 'p-b', name: 'Rune' });
  const driver = createRoomDriver(startEarly(room), { hazards: true, seed: 3 });
  assert.equal(driver.turn, 0);
  assert.equal(driver.botTurn, true, 'the machine seat is not on turn');
  assert.deepEqual(driver.submit(0, greedy(driver.state, 0)), { ok: false, reason: 'automated' },
    'a machine seat accepted a person\'s action');
  assert.deepEqual(driver.submit(1, greedy(driver.state, 1)), { ok: false, reason: 'not_your_turn' },
    'a seat played out of turn');
  /* and a person's own turn carries the machine's answer inside the same call */
  const played = driver.runBots();
  assert.equal(played.length, 1, 'the machine did not take its turn');
  assert.equal(driver.botTurn, false);
  const batch = driver.submit(1, greedy(driver.state, 1));
  assert.ok(batch.ok, `the person's turn was refused: ${batch.reason}`);
  assert.equal(batch.events[0].seat, 1, 'the batch did not open with the person\'s own move');
  assert.equal(batch.events.length, 2, 'the machine did not answer in the same call');
  assert.equal(batch.events[1].seat, 0, 'the machine answered out of turn');
  console.log(`   (one submit played ${batch.events.length} turns: the person's move + the machine's answer)`);
});

check('room race: a person who walks out is taken over and the race still finishes', () => {
  const spec = [{ id: 'p-a', name: 'Ada' }, { id: 'p-b', name: 'Rune' }, null, null];
  let room = createRoom({ code: '4242', seats: 4, botTier: 'mixed', now: 0 });
  for (let i = 0; i < spec.length; i++) if (spec[i]) room = seatHuman(room, i, { kind: 'human', id: spec[i].id, name: spec[i].name });
  const driver = createRoomDriver(startEarly(room), { hazards: true, seed: 31337 });

  let turns = 0;
  /* play a few turns, then seat 1 walks out mid-race */
  for (let i = 0; i < 6 && driver.state.winner === null; i++) {
    if (driver.botTurn) { turns += driver.runBots().length; continue; }
    assert.ok(driver.submit(driver.turn, greedy(driver.state, driver.turn)).ok);
    turns++;
  }
  assert.equal(driver.drop(1), true, 'the seat could not be taken over');
  assert.equal(driver.payable(1), false, 'the seat that walked out was still payable');
  assert.ok(isAutomated(driver.room, 1), 'the seat did not become the machine\'s');
  assert.equal(seatBadge(driver.room, 1), 'takeover');
  assert.equal(driver.drop(1), false, 'an already-taken seat was taken over twice');

  for (; turns < 900 && driver.state.winner === null; ) {
    if (driver.botTurn) { turns += driver.runBots().length; continue; }
    const res = driver.submit(driver.turn, greedy(driver.state, driver.turn));
    assert.ok(res.ok, `the race stalled after the takeover: ${res.reason}`);
    turns += res.events.length;
  }
  assert.ok(driver.state.winner !== null, 'the race never finished after a takeover');
  console.log(`   (takeover race concluded in ${turns} turns, winner seat ${driver.state.winner})`);
});

check('room race: a returning person takes their own seat back', () => {
  const room = startEarly(createRoom({ code: '1', seats: 4, host: host(), now: 0 }));
  const driver = createRoomDriver(room, { hazards: true, seed: 5 });
  driver.drop(0);
  assert.ok(isAutomated(driver.room, 0));
  assert.equal(driver.resume(0), true, 'the seat could not be reclaimed');
  assert.equal(isAutomated(driver.room, 0), false);
  assert.equal(driver.payable(0), true, 'the reclaimed seat is not payable');
  assert.equal(driver.resume(1), false, 'a bot seat was handed to a person');
});

check('room race: the same room, seed and actions give the same race', () => {
  /* The bots draw on `Math.random`, so a rerun is only the same race if the draw starts over. */
  const play = (draw) => {
    Math.random = mulberry32(draw);
    const r = playRoom([{ id: 'p-a', name: 'A' }, null, null, null], 555, greedy);
    return JSON.stringify({ state: r.driver.state, room: r.room });
  };
  assert.equal(play(4242), play(4242), 'two identical rooms diverged');
  assert.notEqual(play(4242), play(99), 'a different draw gave the same race: the seed is ignored');
});

check('room race: a machine turn is inside the 15ms budget', () => {
  const r = playRoom([null, null, null, null], 24680, greedy);
  assert.ok(r.worst < 15, `the slowest machine batch took ${r.worst.toFixed(2)}ms`);
  assert.ok(r.driver.state.winner !== null);
  console.log(`   (4 bots, slowest machine batch ${r.worst.toFixed(2)}ms over ${r.turns} turns)`);
});

check('room race: fog — a machine seat only ever sees its own side, and never stalls on it', () => {
  /* The driver plays each seat through `view(state, seat)`, so a bot can pick a square a rival had
     already mined and the rules will refuse it. The driver must recover from that refusal rather
     than throw the turn away, and every race must still reach FINISH. A room of Hard bots mines
     often enough to make that happen. */
  let buried = 0, races = 0, turns = 0;
  for (let g = 0; g < 12; g++) {
    let room = createRoom({ code: '1', seats: 4, botTier: 'hard', now: 0 });
    room = seatHuman(room, 0, { kind: 'human', id: 'p-a', name: 'A' });
    const driver = createRoomDriver(startEarly(room), { hazards: true, seed: 900 + g });
    for (let i = 0; i < 900 && driver.state.winner === null; ) {
      if (driver.botTurn) {
        const played = driver.runBots();
        assert.ok(played.length > 0, 'the machine skipped its turn');
        for (const ev of played) if (ev.action.kind === 'mine') buried++;
        i += played.length; turns += played.length;
        continue;
      }
      const res = driver.submit(driver.turn, greedy(driver.state, driver.turn));
      assert.ok(res.ok, `the person's turn was refused: ${res.reason}`);
      for (const ev of res.events) if (ev.action.kind === 'mine') buried++;
      i += res.events.length; turns += res.events.length;
    }
    assert.ok(driver.state.winner !== null, `race ${g} never finished`);
    races++;
  }
  assert.equal(races, 12, 'not every room reached a winner');
  assert.ok(buried > 0, 'no mine was ever buried: the fog path was not exercised');
  console.log(`   (12 fogged rooms: ${buried} mines buried over ${turns} turns, all 12 races finished)`);
});

/* ---------- 6. the client's own lobby ---------- */

check('lobby: the caption counts down, then reports the roster it launched with', () => {
  const room = createRoom({ code: '1', seats: 4, host: host(), waitMs: 8000, now: 0 });
  assert.equal(lobbyLine(room, 0), '1 of 4 seats taken · bots fill the rest in 8s');
  assert.equal(lobbyLine(room, 3000), '1 of 4 seats taken · bots fill the rest in 5s');
  const started = tick(room, 8000);
  assert.equal(lobbyLine(started, 9000), '4-seat race · 1 human, 3 bots');
});

/* ---------- 7. the lobby format: one knob, and everything it derives ---------- */

check('lobby format: capacity, mode, teams and copy all follow the one pick', () => {
  for (const good of ['2v2', '2v1', '3p', '4p']) assert.ok(isLobbyFormat(good), `${good} was refused`);
  for (const bad of ['2V2', '4', '5p', '', null, undefined, 4]) assert.ok(!isLobbyFormat(bad), `${bad} was accepted`);
  assert.deepEqual([...LOBBY_FORMATS], ['2v2', '2v1', '3p', '4p']);

  assert.equal(FORMAT_CAPACITY['2v2'], 4);
  assert.equal(FORMAT_CAPACITY['2v1'], 3);
  assert.equal(FORMAT_CAPACITY['3p'], 3);
  assert.equal(FORMAT_CAPACITY['4p'], 4);

  assert.equal(FORMAT_MODE['2v2'], 'team');
  assert.equal(FORMAT_MODE['2v1'], 'team');
  assert.equal(FORMAT_MODE['3p'], 'ffa');
  assert.equal(FORMAT_MODE['4p'], 'ffa');

  assert.equal(teamCapacity('2v2', 0), 2);
  assert.equal(teamCapacity('2v2', 1), 2);
  assert.equal(teamCapacity('2v1', 0), 2);
  assert.equal(teamCapacity('2v1', 1), 1, '2v1 must keep the lone challenger alone');
  assert.equal(teamCapacity('3p', 0), 3);
  assert.equal(teamCapacity('4p', 1), 4);

  assert.equal(formatOfMode('team'), '2v2');
  assert.equal(formatOfMode('ffa'), '4p');
  assert.deepEqual([0, 1, 2, 3].map(defaultTeam), [0, 1, 0, 1]);
  for (const f of LOBBY_FORMATS) {
    assert.ok(FORMAT_NAME[f].length > 0, `${f} has no chip label`);
    assert.ok(FORMAT_LINE[f].length > 0, `${f} has no promise line`);
  }
});

check('lobby format: a reflow keeps every held seat, and refuses the impossible', () => {
  /* every subset of a four-seat room, into every room size: a fit iff the people fit */
  for (let cap = 2; cap <= 4; cap++) {
    for (let mask = 0; mask < 16; mask++) {
      const held = [0, 1, 2, 3].filter((i) => mask & (1 << i));
      const out = reflowSeats(held, cap);
      if (held.length > cap) { assert.equal(out, null, `${held} fitted a ${cap}-seat room`); continue; }
      assert.ok(out, `${held} was refused a ${cap}-seat room`);
      assert.equal(out.length, held.length, 'a seat was dropped');
      assert.equal(new Set(out).size, out.length, 'two seats landed on one well');
      assert.ok(out.every((i) => i >= 0 && i < cap), 'a seat landed outside the room');
      assert.ok(held.filter((i) => i < cap).every((i) => out.includes(i)), 'a fitting seat moved for no reason');
    }
  }
  assert.deepEqual(reflowSeats([0, 2], 3), [0, 2], 'a reflow moved seats that already fit');
  assert.deepEqual(reflowSeats([3], 3), [0], 'an out-of-room seat must land on the lowest free well');
  assert.equal(reflowSeats([0, 1, 2, 3], 3), null);

  /* a real room resizes around its people: indexes renumbered, order kept, original untouched */
  let room = createRoom({ code: '1', seats: 4, host: host(), now: 0 });
  room = seatHuman(room, 3, { kind: 'human', id: 'p-b', name: 'B' });
  room = seatHuman(room, 0, { kind: 'human', id: 'p-a', name: 'A' });
  const sized = reflowRoom(room, 3);
  assert.ok(sized, 'two people were refused a three-seat room');
  assert.equal(sized.room.seats.length, 3);
  assert.deepEqual(sized.moves, [{ from: 0, to: 0 }, { from: 3, to: 1 }]);
  assert.equal(sized.room.seats[0].kind, 'human');
  assert.equal(sized.room.seats[1].index, 1, 'the moved seat kept a stale index');
  assert.equal(sized.room.seats[1].id, 'p-b');
  assert.equal(room.seats.length, 4, 'the source room was mutated');
  assert.deepEqual(vacantSeats(sized.room), [2], 'the freed well is not backfillable');
});

check('lobby format: a team move respects the cap, and swaps when the team is full', () => {
  const held = [true, true, true];
  /* 2v1: Blue is full, so the Red player who taps Blue swaps the first Blue to Red */
  assert.deepEqual(assignTeam([0, 1, 0], held, 1, 0, '2v1'), [1, 0, 0]);
  /* 2v2: Red is full, so a Blue tapping Red swaps with the first Red */
  assert.deepEqual(assignTeam([0, 1, 0, 1], [true, true, true, true], 2, 1, '2v2'), [0, 0, 1, 1]);
  /* a team with room takes the seat without displacing anyone */
  assert.deepEqual(assignTeam([0, 1, 0, 1], [true, true, true, false], 2, 1, '2v2'), [0, 1, 1, 1]);
  assert.deepEqual(assignTeam([0, 1, 0], held, 2, 1, '3p'), [0, 1, 1]);
  /* a vacant seat, a no-op move, and a team outside the shape are all refused */
  assert.equal(assignTeam([0, 1, 0, 1], [true, false, true, true], 1, 0, '2v2'), null);
  assert.equal(assignTeam([0, 1, 0, 1], [true, true, true, true], 0, 0, '2v2'), null);
  assert.equal(assignTeam([0, 1], [true, true], 5, 1, '2v2'), null);
  assert.equal(assignTeam([0, 1, 0], held, 1, 1, '2v1'), null, 'a seat already on its team was moved');
});

console.log(`\n${run} room checks passed`);
