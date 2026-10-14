/**
 * verify-worker-race.mjs — two clients, one matchmaker, a whole race in plain Node.
 *
 * `npm run build` proves the race type-checks; this proves it plays. It bundles the worker with the
 * project's own esbuild (the room imports the same `src/rules.ts` the client plays, so this is the
 * real authoritative board, not a mock), stubs the three Cloudflare globals the backend touches,
 * and drives two socket pairs through:
 *
 *   - a match on the shared seed, and the same board built twice from it;
 *   - every move of a full race, relayed and replayed on both sides;
 *   - an out-of-turn move, an illegal move, and a wall with a spoofed owner;
 *   - RESIGN and a mid-race disconnect (the forfeit path);
 *   - board sizes: 1v1 never pairs with 2v2;
 *   - board geometry: a duel is 8 columns, a 2v2 is the wide 10, the wide board's extra columns are
 *     relayed rather than dropped as off-board, and a whole race replays on it move for move.
 *
 *   node scripts/verify-worker-race.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = path.join(ROOT, '.tmp');

/* ---------- the three globals the worker touches ---------- */

class FakeSocket {
  constructor() {
    this.peer = null;
    this.sent = [];
    this.received = [];
    this.listeners = new Map();
    this.accepted = false;
    this.closed = false;
    this.ended = false;
    this.readyState = 1;                 // the client half starts open, like a real pair
  }

  accept() { this.accepted = true; }

  send(data) {
    const text = String(data);
    this.sent.push(text);
    this.peer?.deliver(text);
  }

  deliver(text) {
    this.received.push(text);
    this.emit('message', { data: text });
  }

  close(code = 1000, reason = '') {
    this.closed = true;
    this.readyState = 3;
    this.emit('close', { code, reason });
    this.peer?.emit('close', { code, reason });   // a real close lands on both halves
  }

  addEventListener(type, cb) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  emit(type, event) {
    if (type === 'close') this.ended = true;
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }
}

class FakeResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers);
    this.webSocket = init.webSocket ?? null;
  }
}

globalThis.WebSocketPair = class {
  constructor() {
    const client = new FakeSocket();
    const server = new FakeSocket();
    client.peer = server;
    server.peer = client;
    this[0] = client;
    this[1] = server;
  }
};
globalThis.Response = FakeResponse;

/* ---------- bundle the worker (with the shared rules) and the rules on their own ---------- */

fs.mkdirSync(TMP, { recursive: true });
const workerOut = path.join(TMP, 'race-worker.mjs');
const rulesOut = path.join(TMP, 'race-rules.mjs');
const hazardsOut = path.join(TMP, 'race-hazards.mjs');
for (const [entry, outfile] of [
  ['worker/index.ts', workerOut],
  ['src/rules.ts', rulesOut],
  ['src/hazards.ts', hazardsOut],
]) {
  await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    outfile,
    logLevel: 'silent',
  });
}
const workerModule = await import(pathToFileURL(workerOut).href);
const worker = workerModule.default;
const { MatchmakerDO } = workerModule;
const rules = await import(pathToFileURL(rulesOut).href);
const { apply, getAutoMove, newGame, steps, wallOk, wallsClash, allWalls } = rules;
const { hazardAt } = await import(pathToFileURL(hazardsOut).href);

/* ---------- a runtime: the worker, one singleton DO, and a fake namespace ---------- */

function runtime(vars = {}) {
  const env = { DEV_AUTH: vars.DEV_AUTH ?? 'true', TELEGRAM_BOT_TOKEN: undefined };
  const lobby = new MatchmakerDO({
    id: { toString: () => 'global' },
    acceptWebSocket: () => {},
    getWebSockets: () => [],
  }, env);
  env.MATCHMAKER = {
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({ fetch: (request) => lobby.fetch(request) }),
  };
  return {
    lobby,
    route: (url, upgrade = false) => worker.fetch({
      url,
      headers: { get: (key) => (upgrade && key.toLowerCase() === 'upgrade' ? 'websocket' : null) },
    }, env),
  };
}

async function open(rt, { tiq = 0, name = 'Player', sizes = [1, 1], wide = false } = {}) {
  const query = new URLSearchParams({
    tiq: String(tiq),
    tier: 'rookie',
    name,
    wide: wide ? '1' : '0',
    sizes: sizes.join(','),
  });
  const res = await rt.route(`http://127.0.0.1:8787/ws/matchmake?${query}`, true);
  assert.equal(res.status, 101, `upgrade refused (${res.status})`);
  return res.webSocket;
}

const send = (socket, message) => socket.send(JSON.stringify(message));
const frames = (socket, cursor) => socket.received.slice(cursor).map((raw) => JSON.parse(raw));
const only = (socket, type, cursor = 0) => frames(socket, cursor).filter((f) => f.type === type);

/**
 * Play a whole race through the room: every move is judged there, relayed to the rival and replayed
 * on both boards. They have to stay identical to each other and to the room's own copy, move for
 * move — the one property that makes the server authoritative rather than a postbox.
 */
function playOut(rt, a, b, matchId, one, two) {
  let clientA = one, clientB = two;
  let cursorA = a.received.length, cursorB = b.received.length;
  let actions = 0, agreed = true, roomAgreed = true;
  while (clientA.winner === null && actions < 400) {
    const actor = clientA.turn === 0 ? a : b;
    const mine = clientA.turn === 0 ? clientA : clientB;
    const action = getAutoMove(mine, mine.turn);
    const before = actor.received.length;
    send(actor, { type: 'MOVE', action });
    if (frames(actor, before).find((f) => f.type === 'REJECT')) { agreed = false; break; }
    const next = apply(mine, action);
    if (!next) { agreed = false; break; }
    if (actor === a) { clientA = next; cursorA = a.received.length; }
    else { clientB = next; cursorB = b.received.length; }

    const peer = actor === a ? b : a;
    const relayed = only(peer, 'MOVE', actor === a ? cursorB : cursorA).at(-1);
    if (!relayed) { agreed = false; break; }
    const peerNext = apply(peer === a ? clientA : clientB, relayed.action);
    if (!peerNext) { agreed = false; break; }
    if (peer === a) { clientA = peerNext; cursorA = a.received.length; }
    else { clientB = peerNext; cursorB = b.received.length; }
    if (JSON.stringify(clientA) !== JSON.stringify(clientB)) { agreed = false; break; }
    if (relayed.side !== (actor === a ? 0 : 1)) { agreed = false; break; }
    /* The room settles a race the moment a winner appears, so it only holds the board while the
       race is still running — which is exactly when it has to agree with both screens. */
    const room = rt.lobby.races.get(matchId);
    if (room && JSON.stringify(room.state) !== JSON.stringify(clientA)) { roomAgreed = false; break; }
    actions++;
  }
  return { agreed, actions, clientA, clientB, roomAgreed };
}

/* ---------- checks ---------- */

let ran = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  ran++;
  if (condition) console.log(`  ok  ${label}`);
  else {
    failed++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/* a match, on a shared seed */
{
  const rt = runtime();
  const a = await open(rt, { tiq: 1000, name: 'Ada' });
  const b = await open(rt, { tiq: 1100, name: 'Rune' });
  send(a, { type: 'QUEUE', wide: false });
  send(b, { type: 'QUEUE', wide: false });
  const [ma] = only(a, 'MATCH_FOUND');
  const [mb] = only(b, 'MATCH_FOUND');

  ok('two clients are paired and both are told the same race',
    !!ma && !!mb && ma.matchId === mb.matchId && ma.seed === mb.seed);
  ok('sides are 0 and 1', ma?.side === 0 && mb?.side === 1);
  ok('MATCH_FOUND carries the board both seats queued for',
    JSON.stringify(ma?.sizes) === '[1,1]' && JSON.stringify(mb?.sizes) === '[1,1]');
  ok('the room holds exactly that one race', rt.lobby.races.size === 1);

  /* the same seed builds the same board twice, and rolls the same logs */
  const one = newGame(ma.sizes, { hazards: true, seed: ma.seed });
  const two = newGame(mb.sizes, { hazards: true, seed: mb.seed });
  ok('the shared seed builds an identical board on both screens', JSON.stringify(one) === JSON.stringify(two));
  ok('the shared seed sets the hazard clock', one.hazard?.on === true && one.hazard?.seed === ma.seed);
  const lanes = Array.from({ length: 10 }, (_, k) => hazardAt(one.hazard.seed, k));
  const lanesAgain = Array.from({ length: 10 }, (_, k) => hazardAt(two.hazard.seed, k));
  ok('the rolling-log timetable is drawn from that seed alone',
    JSON.stringify(lanes) === JSON.stringify(lanesAgain) && lanes.length === 10);

  /* an out-of-turn move is refused, on the wire and in the room */
  const atRest = rt.lobby.races.get(ma.matchId).state;
  const step = steps(atRest, 0)[0];
  send(b, { type: 'MOVE', action: { kind: 'move', ball: step.ball, to: step.to } });   // side 1, seat 0's turn
  const [outOfTurn] = only(b, 'REJECT');
  ok('a move out of turn is refused', outOfTurn?.reason === 'not_your_turn', outOfTurn?.reason);
  ok('a refused move is not relayed', only(a, 'MOVE').length === 0);
  ok('a refused move does not touch the room', JSON.stringify(rt.lobby.races.get(ma.matchId).state) === JSON.stringify(atRest));

  /* a move into thin air is refused too */
  send(a, { type: 'MOVE', action: { kind: 'move', to: { c: 7, r: 0 } } });
  ok('an illegal move is refused', only(a, 'REJECT').at(-1)?.reason === 'illegal_action');

  /* a full race: every move relayed, both boards landing on the same squares */
  const { agreed, actions, clientA, clientB, roomAgreed } = playOut(rt, a, b, ma.matchId, one, two);

  ok('every relayed move kept both boards identical', agreed && actions > 20, `${actions} moves`);
  ok('the race reached a winner', clientA.winner !== null, `winner ${clientA.winner}`);
  ok('the winner is the same on both screens', clientA.winner === clientB.winner);
  ok('the room played the same race the clients did', roomAgreed && agreed);
  ok('a finished race is dropped from the room', rt.lobby.races.size === 0);
}

/* the board a race runs on is the room's, and so are the squares it accepts */
{
  const rt = runtime();
  const a = await open(rt, { tiq: 1000, sizes: [2, 2] });
  const b = await open(rt, { tiq: 1000, sizes: [2, 2] });
  send(a, { type: 'QUEUE', wide: false });
  send(b, { type: 'QUEUE', wide: false });
  const [ma] = only(a, 'MATCH_FOUND');
  const state = newGame(ma.sizes, { hazards: true, seed: ma.seed });
  const cells = state.balls.map((x) => x.pos);

  ok('a four-ball race runs on the wide board', state.cols === 10 && state.rows === 12,
    `${state.cols}x${state.rows}`);
  ok('its four balls start on the bottom row, none of them side by side',
    cells.length === 4
    && cells.every((p) => p.r === state.rows - 1)
    && cells.every((p, i) => cells.every((q, j) => i === j || Math.abs(p.c - q.c) + Math.abs(p.r - q.r) > 1)),
    JSON.stringify(cells));
  ok('and the room hands out the four-contender wall budget',
    JSON.stringify(state.wallsLeft) === '[5,5]', JSON.stringify(state.wallsLeft));

  /* a wall out in the two new columns: the duel has no such square, the wide board does */
  const wideWall = { o: 'v', x: 9, y: 3, owner: 0 };
  ok('the rules accept a wall in the wide board\'s new columns', wallOk(state, wideWall));
  send(a, { type: 'MOVE', action: { kind: 'wall', wall: wideWall } });
  const [placedWide] = only(b, 'MOVE');
  ok('and the room relays it rather than dropping it as off-board',
    JSON.stringify(placedWide?.action.wall) === JSON.stringify(wideWall));

  const duel = newGame([1, 1], { hazards: true, seed: ma.seed });
  ok('the duel board is still the classic eight columns', duel.cols === 8 && duel.rows === 12,
    `${duel.cols}x${duel.rows}`);
  ok('and the same wall is off it', !wallOk(duel, wideWall));

  /* the same whole-race replay, this time on the wide grid — continued from the wall the room just
     accepted, so both clients start where the room actually is */
  const from = apply(state, { kind: 'wall', wall: wideWall }) ?? state;
  ok('the relayed wall is where the wide race continues from',
    from.walls.length === 1 && from.turn === 1, `${from.walls.length} walls, turn ${from.turn}`);
  const wide = playOut(rt, a, b, ma.matchId, from, from);
  ok('a full race replays identically on the wide board', wide.agreed && wide.actions > 20,
    `${wide.actions} moves`);
  ok('and it reaches a winner both seats agree on',
    wide.clientA.winner !== null && wide.clientA.winner === wide.clientB.winner);
  ok('the room played the same wide race', wide.roomAgreed);
  ok('a finished wide race is dropped from the room too', rt.lobby.races.size === 0);
}

/* walls are relayed with the sender's own seat as the owner, whatever the payload claims */
{
  const rt = runtime();
  const a = await open(rt, { tiq: 1000 });
  const b = await open(rt, { tiq: 1000 });
  send(a, { type: 'QUEUE', wide: false });
  send(b, { type: 'QUEUE', wide: false });
  const [ma] = only(a, 'MATCH_FOUND');
  const state = newGame(ma.sizes, { hazards: true, seed: ma.seed });
  const wall = allWalls(0).find((w) => wallOk(state, w));
  send(a, { type: 'MOVE', action: { kind: 'wall', wall: { ...wall, owner: 1 } } });   // a spoofed owner
  const [relayed] = only(b, 'MOVE');
  ok('a wall is relayed', relayed?.action.kind === 'wall');
  ok('the room stamps the sender\'s seat as the wall owner', relayed?.action.wall.owner === 0,
    String(relayed?.action.wall.owner));
  ok('the relayed wall is the one the rules accepted',
    JSON.stringify(apply(state, relayed.action)?.walls) === JSON.stringify([{ ...wall, owner: 0 }]));
}

/* wall geometry is the room's to enforce, not the client's */
{
  const rt = runtime();
  const a = await open(rt, { tiq: 1000 });
  const b = await open(rt, { tiq: 1000 });
  send(a, { type: 'QUEUE', wide: false });
  send(b, { type: 'QUEUE', wide: false });
  const [ma] = only(a, 'MATCH_FOUND');
  const start = newGame(ma.sizes, { hazards: true, seed: ma.seed });

  const flat = { o: 'h', x: 2, y: 5, owner: 0 };      // spans (2,5) (3,5) (4,5), pivot (3,5)
  const cross = { o: 'v', x: 3, y: 4, owner: 1 };     // same pivot: a `+` through flat's midpoint
  const over = { o: 'h', x: 3, y: 5, owner: 1 };      // shares flat's second edge segment
  const corner = { o: 'v', x: 4, y: 5, owner: 1 };    // touches flat at one vertex only
  const after = { ...start, walls: [flat] };
  ok('a `+` through an existing wall is illegal in the shared rules', !wallOk(after, cross));
  ok('an overlapping collinear wall is illegal too', !wallOk(after, over));
  ok('an L-corner that only touches it is legal', wallOk(after, corner));

  send(a, { type: 'MOVE', action: { kind: 'wall', wall: flat } });
  const [placed] = only(b, 'MOVE');
  ok('the room relays a plain horizontal wall', JSON.stringify(placed?.action.wall) === JSON.stringify(flat));

  const before = a.received.length;
  send(b, { type: 'MOVE', action: { kind: 'wall', wall: cross } });
  ok('a vertical wall through its centre vertex is refused',
    only(b, 'REJECT').at(-1)?.reason === 'illegal_action');
  ok('and a `+` is never relayed to the other seat', only(a, 'MOVE', before).length === 0);

  send(b, { type: 'MOVE', action: { kind: 'wall', wall: over } });
  ok('a wall overlapping it is refused', only(b, 'REJECT').at(-1)?.reason === 'illegal_action');
  ok('and an overlap is never relayed either', only(a, 'MOVE', before).length === 0);

  send(b, { type: 'MOVE', action: { kind: 'wall', wall: corner } });
  const [second] = only(a, 'MOVE', before);
  ok('the L-corner is relayed', JSON.stringify(second?.action.wall) === JSON.stringify(corner));
  const board = second ? apply({ ...after, turn: 1 }, second.action) : null;
  ok('both seats end up on the same two walls',
    JSON.stringify(board?.walls) === JSON.stringify([flat, corner]));
  ok('and no two walls on the board clash', !!board && !wallsClash(board.walls[0], board.walls[1]));
}

/* resignation */
{
  const rt = runtime();
  const a = await open(rt, { tiq: 1000 });
  const b = await open(rt, { tiq: 1000 });
  send(a, { type: 'QUEUE', wide: false });
  send(b, { type: 'QUEUE', wide: false });
  send(a, { type: 'RESIGN' });
  const [quit] = only(b, 'RESIGN');
  ok('a resignation tells the other seat immediately', quit && quit.side === 0);
  ok('the resigned race is dropped', rt.lobby.races.size === 0);
  ok('the resigning seat keeps its socket (it may still be asked to leave)',
    a.closed === false && a.ended === false);
}

/* a socket that dies mid-race */
{
  const rt = runtime();
  const a = await open(rt, { tiq: 1000, name: 'Gone' });
  const b = await open(rt, { tiq: 1000, name: 'Stays' });
  send(a, { type: 'QUEUE', wide: false });
  send(b, { type: 'QUEUE', wide: false });
  const before = a.received.length;
  a.close(1006, 'network');
  const [left] = only(b, 'OPPONENT_LEFT');
  ok('a dropped socket hands the win to the seat opposite', left && left.side === 0, JSON.stringify(b.received.slice(before)));
  ok('the abandoned race is dropped', rt.lobby.races.size === 0);
  ok('the surviving seat is still connected', b.closed === false);
}

/* one game only: a 1v1 seat is never dropped onto a 2v2 board */
{
  const rt = runtime();
  const solo = await open(rt, { tiq: 1000, sizes: [1, 1] });
  const pair = await open(rt, { tiq: 1000, sizes: [2, 2] });
  send(solo, { type: 'QUEUE', wide: true });
  send(pair, { type: 'QUEUE', wide: true });
  const pair2 = await open(rt, { tiq: 1000, sizes: [2, 2] });   // connecting is queueing
  const [m1] = only(pair, 'MATCH_FOUND');
  const [m2] = only(pair2, 'MATCH_FOUND');
  ok('a 1v1 seat is never dropped onto a 2v2 board', only(solo, 'MATCH_FOUND').length === 0,
    JSON.stringify(solo.received));
  ok('the two 2v2 seats find each other', !!m1 && !!m2 && m1.matchId === m2.matchId);
  ok('the matched pair plays a 2v2 board',
    JSON.stringify(m1?.sizes) === '[2,2]' && JSON.stringify(m2?.sizes) === '[2,2]');
  ok('the 1v1 seat is still waiting its turn',
    rt.lobby.queue.length === 1 && rt.lobby.queue[0].sizes.join(',') === '1,1');
}

console.log(`\n${ran - failed}/${ran} race checks passed`);
if (failed > 0) process.exit(1);
