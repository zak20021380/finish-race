/**
 * verify-worker-matchmaking.mjs — drives the real matchmaking worker in plain Node.
 *
 * `npm run build` only proves both sides type-check. This proves the protocol: it bundles
 * `worker/index.ts` with the project's own esbuild, stubs the three Cloudflare globals the
 * backend touches (`WebSocketPair`, a 101-capable `Response`, a fake Durable Object namespace),
 * and walks the whole paper trail — health route, upgrade refusal, signed and forged initData,
 * the 250 / 600 / anyone pairing rules, WIDEN keeping a place in line, and CANCEL leaving the
 * queue. The Durable Object runs its real code (Web Crypto HMAC included); only the runtime
 * around it is faked, so this is "verified in workerd" minus workerd.
 *
 *   node scripts/verify-worker-matchmaking.mjs
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TOKEN = '12345:AAHtest-token-for-the-matchmaking-harness';

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

/* ---------- load the bundled worker ---------- */

const outfile = path.join(ROOT, '.tmp', 'worker-matchmaking.mjs');
fs.mkdirSync(path.dirname(outfile), { recursive: true });
await build({
  entryPoints: [path.join(ROOT, 'worker', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outfile,
  logLevel: 'silent',
});
const worker = (await import(pathToFileURL(outfile).href)).default;
const { MatchmakerDO } = await import(pathToFileURL(outfile).href);
fs.rmSync(outfile, { force: true });

/* the shared rules, bundled on their own: a room's board is the same `src/rules.ts` the clients
   play, so the checks build it here from the seed the room hands out rather than trusting it */
const rulesOut = path.join(ROOT, '.tmp', 'matchmaking-rules.mjs');
await build({
  entryPoints: [path.join(ROOT, 'src', 'rules.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outfile: rulesOut,
  logLevel: 'silent',
});
const rules = await import(pathToFileURL(rulesOut).href);
fs.rmSync(rulesOut, { force: true });
const { apply, newGame, steps } = rules;

/* ---------- a runtime: the worker, one singleton DO, and a fake namespace ---------- */

function runtime(vars = {}) {
  const env = { DEV_AUTH: vars.DEV_AUTH ?? 'false', TELEGRAM_BOT_TOKEN: vars.TELEGRAM_BOT_TOKEN };
  const lobby = new MatchmakerDO({
    id: { toString: () => 'global' },
    acceptWebSocket: () => {},
    getWebSockets: () => [],
  }, env);
  env.MATCHMAKER = {
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({ fetch: (request) => lobby.fetch(request) }),
  };
  const route = (url, upgrade = false) => worker.fetch({
    url,
    headers: { get: (key) => (upgrade && key.toLowerCase() === 'upgrade' ? 'websocket' : null) },
  }, env);
  return { env, lobby, route };
}

/** Through the worker and into the DO, exactly as a browser upgrade would arrive. */
async function open(rt, fields = {}) {
  const { initData = '', tiq = 0, tier = 'rookie', flag = '', name = 'Player', wide = false,
    room = 0, bottier = '', host = 'localhost:8787' } = fields;
  const query = new URLSearchParams({ tiq: String(tiq), tier, flag, name, wide: wide ? '1' : '0' });
  if (initData) query.set('initData', initData);
  /* `room=<n>` is what makes a socket a room seat rather than a queue entry */
  if (room) query.set('room', String(room));
  if (bottier) query.set('bottier', bottier);
  const res = await rt.route(`http://${host}/ws/matchmake?${query}`, true);
  return { status: res.status, socket: res.webSocket };
}

const send = (socket, message) => socket.send(JSON.stringify(message));

/**
 * Run the room's wait timer out. The wait is measured against `Date.now()` inside the object, and
 * the alarm only launches a room whose time has actually come, so the check moves the clock forward
 * instead of sleeping — the assertion under test is the object's own arithmetic, not the delay.
 */
async function elapse(rt, ms) {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    await rt.lobby.alarm();
  } finally {
    Date.now = real;
  }
}
const messages = (socket) => socket.received.map((raw) => JSON.parse(raw));
const matchOf = (socket) => messages(socket).find((m) => m.type === 'MATCH_FOUND') ?? null;
/** A room's own opening frame: the seat, the roster, and which seats the machine holds. */
const roomOf = (socket) => messages(socket).find((m) => m.type === 'ROOM_FOUND') ?? null;

/** A properly signed Telegram initData, built the documented way. */
function signed(fields, token = TOKEN) {
  const rows = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(rows.join('\n')).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const user = (id, first_name, username) => ({ id, first_name, username, language_code: 'en' });

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

/* health + routing */
{
  const rt = runtime();
  const health = await rt.route('http://localhost:8787/health');
  ok('GET /health answers 200 ok', health.status === 200 && JSON.parse(health.body).ok === true);
  ok('an unknown route answers 404', (await rt.route('http://localhost:8787/nope')).status === 404);
  ok('/ws/matchmake without an upgrade answers 426',
    (await rt.route('http://localhost:8787/ws/matchmake', false)).status === 426);
  ok('a plain request still reaches the DO as 426 (the worker forwards it)',
    (await rt.route('http://localhost:8787/ws/matchmake?tiq=10', false)).status === 426);
}

/* authentication */
{
  const rt = runtime({ TELEGRAM_BOT_TOKEN: TOKEN });
  const forged = signed({ auth_date: '1700000000', user: JSON.stringify(user(7, 'Ada')), query_id: 'AAA' })
    .replace(/hash=[0-9a-f]+/, 'hash=deadbeef');
  const bad = await open(rt, { initData: forged, host: 'detour.example.com' });
  ok('a forged initData hash is refused with 401', bad.status === 401, `status ${bad.status}`);

  const none = await open(rt, { host: 'detour.example.com' });
  ok('no initData on a real host is refused with 401', none.status === 401, `status ${none.status}`);

  const good = await open(rt, {
    initData: signed({ auth_date: '1700000000', user: JSON.stringify(user(7, 'Ada', 'ada_w')), query_id: 'AAA' }),
    host: 'detour.example.com',
    tiq: 2100,
    tier: 'strategist',
    flag: 'NL',
  });
  ok('a signed initData upgrades (101) with a socket', good.status === 101 && !!good.socket);

  const rival = await open(rt, { initData: signed({
    auth_date: '1700000001', user: JSON.stringify(user(9, 'Rune')), query_id: 'BBB',
  }), host: 'detour.example.com', tiq: 2150, tier: 'strategist' });
  send(good.socket, { type: 'QUEUE', wide: false });
  send(rival.socket, { type: 'QUEUE', wide: false });
  const a = matchOf(good.socket);
  const b = matchOf(rival.socket);
  ok('two signed players 50 TIQ apart are paired', !!a && !!b);
  ok('Telegram\'s first_name names the opponent, not the client', b?.opponent.name === 'Ada' && a?.opponent.name === 'Rune',
    `${a?.opponent.name} / ${b?.opponent.name}`);
  ok('the opponent carries tiq, tier and flag',
    a?.opponent.tiq === 2150 && a?.opponent.tier === 'strategist' && b?.opponent.flag === 'NL');
}

/* development fallback */
{
  const rt = runtime({ DEV_AUTH: 'true' });
  const guest = await open(rt, { name: 'Local Dev', tiq: 1200 });
  ok('DEV_AUTH=true queues a guest with no initData', guest.status === 101 && !!guest.socket);

  const loop = runtime();
  const onLoop = await open(loop, { host: '127.0.0.1:8787' });
  ok('loopback without initData falls back to a guest', onLoop.status === 101 && !!onLoop.socket);
  ok('the hostname is still required to be local (::1 too)',
    (await open(loop, { host: '[::1]:8787' })).status === 101);

  const other = await open(loop, { host: 'detour.example.com' });
  ok('a deployed host with no credentials is still refused', other.status === 401);

  const named = runtime({ DEV_AUTH: 'true' });
  const one = await open(named, { name: 'Nadia K.', tiq: 1000 });
  const two = await open(named, { name: 'Rune', tiq: 1000 });
  send(one.socket, { type: 'QUEUE', wide: false });
  send(two.socket, { type: 'QUEUE', wide: false });
  ok('guests are given distinct seats and pair with each other',
    !!matchOf(one.socket) && !!matchOf(two.socket));
  ok('a guest keeps the display name it sent', matchOf(one.socket)?.opponent.name === 'Rune');
}

/* pairing radii: 250 → 600 → anyone */
{
  const rt = runtime({ DEV_AUTH: 'true' });
  const a = await open(rt, { tiq: 1000 });
  const b = await open(rt, { tiq: 1300 });
  send(a.socket, { type: 'QUEUE', wide: false });
  send(b.socket, { type: 'QUEUE', wide: false });
  ok('1300 vs 1000 TIQ (300 apart) stays apart while nobody widens',
    !matchOf(a.socket) && !matchOf(b.socket));

  send(a.socket, { type: 'WIDEN' });
  const wa = matchOf(a.socket);
  const wb = matchOf(b.socket);
  ok('one widened side opens the net to 600 and pairs them', !!wa && !!wb);
  ok('both sides get the same matchId and seed', wa?.matchId === wb?.matchId && wa?.seed === wb?.seed,
    `${wa?.matchId}/${wb?.matchId} ${wa?.seed}/${wb?.seed}`);
  ok('the longer wait takes side 0 and the newcomer side 1', wa?.side === 0 && wb?.side === 1,
    `${wa?.side}/${wb?.side}`);
  ok('the matchId is deterministic and the seed 32-bit',
    /^m[0-9a-z]+$/.test(String(wa?.matchId)) && Number.isInteger(wa.seed) && wa.seed >= 0 && wa.seed <= 0xffffffff);
}

/* WIDEN does not cost the wait already earned */
{
  const rt = runtime({ DEV_AUTH: 'true' });
  const a = await open(rt, { tiq: 1000 });
  const b = await open(rt, { tiq: 3000 });
  send(a.socket, { type: 'QUEUE', wide: false });
  send(b.socket, { type: 'QUEUE', wide: false });
  const before = rt.lobby.queue.map((w) => `${w.id}:${w.joinedAt}`).join(',');
  send(a.socket, { type: 'WIDEN' });
  const after = rt.lobby.queue.map((w) => `${w.id}:${w.joinedAt}`).join(',');
  ok('WIDEN keeps the wait already earned (same order, same joinedAt)', before === after && !!before,
    `${before} → ${after}`);
  ok('WIDEN flips the flag in place', rt.lobby.queue[0]?.wide === true && rt.lobby.queue.length === 2);
  ok('WIDEN alone does not pair a 2000 TIQ gap', !matchOf(a.socket) && !matchOf(b.socket));
}

{
  const rt = runtime({ DEV_AUTH: 'true' });
  const a = await open(rt, { tiq: 1000 });
  const b = await open(rt, { tiq: 3000 });
  send(a.socket, { type: 'QUEUE', wide: false });
  send(a.socket, { type: 'WIDEN' });
  send(b.socket, { type: 'QUEUE', wide: false });
  ok('one widened side still refuses a 2000 TIQ gap', !matchOf(a.socket) && !matchOf(b.socket));
  send(b.socket, { type: 'WIDEN' });
  ok('two widened sides race anyone left', !!matchOf(a.socket) && !!matchOf(b.socket));
}

{
  const rt = runtime({ DEV_AUTH: 'true' });
  const a = await open(rt, { tiq: 1000 });
  const b = await open(rt, { tiq: 1000 });
  send(a.socket, { type: 'QUEUE', wide: false });
  send(b.socket, { type: 'QUEUE', wide: true });          // the flag can arrive with the queue too
  ok('wide can be set on the QUEUE message itself', !!matchOf(a.socket) && !!matchOf(b.socket));
  ok('nobody is ever paired with themselves: matched sockets leave the queue', rt.lobby.queue.length === 0);
}

{
  /* two tabs, one Telegram account: the same id must never race itself */
  const rt = runtime({ TELEGRAM_BOT_TOKEN: TOKEN });
  const me = (query_id) => signed({ auth_date: '1700000000', user: JSON.stringify(user(42, 'Solo')), query_id });
  const one = await open(rt, { initData: me('AAA'), host: 'detour.example.com', tiq: 1000 });
  const two = await open(rt, { initData: me('BBB'), host: 'detour.example.com', tiq: 1000 });
  send(one.socket, { type: 'QUEUE', wide: true });
  send(two.socket, { type: 'QUEUE', wide: true });
  ok('the same player id never races itself, even both widened',
    !matchOf(one.socket) && !matchOf(two.socket));
  const other = await open(rt, { initData: signed({ auth_date: '1700000002', user: JSON.stringify(user(43, 'Other')), query_id: 'CCC' }), host: 'detour.example.com', tiq: 1000 });
  send(other.socket, { type: 'QUEUE', wide: false });
  ok('a distinct third player still matches one of them', !!matchOf(other.socket));
}

/* CANCEL */
{
  const rt = runtime({ DEV_AUTH: 'true' });
  const leaving = await open(rt, { tiq: 1000 });
  const waiting = await open(rt, { tiq: 2000 });
  send(leaving.socket, { type: 'QUEUE', wide: false });
  send(waiting.socket, { type: 'QUEUE', wide: false });
  ok('no match across a 1000 TIQ gap', !matchOf(leaving.socket) && !matchOf(waiting.socket));
  send(leaving.socket, { type: 'CANCEL' });
  ok('CANCEL closes the socket cleanly', leaving.socket.ended === true);
  ok('CANCEL removes the player from the queue', rt.lobby.queue.length === 1);

  const next = await open(rt, { tiq: 2050 });
  send(next.socket, { type: 'QUEUE', wide: false });
  ok('the player left behind is matched with someone new', !!matchOf(waiting.socket) && !!matchOf(next.socket));
}

/* a dead socket leaves the room on its own */
{
  const rt = runtime({ DEV_AUTH: 'true' });
  const gone = await open(rt, { tiq: 1000 });
  send(gone.socket, { type: 'QUEUE', wide: false });
  gone.socket.close(1006, 'network');
  ok('a dropped socket is forgotten without a CANCEL', rt.lobby.queue.length === 0);
}

/* ---------- 5. rooms: 2 to 4 seats, humans and bots in any mix ---------- */

console.log('\n-- rooms: seats, backfill, takeover --');
{
  const rt = runtime({ DEV_AUTH: 'true' });
  const a = await open(rt, { name: 'Ada', tiq: 1200, room: 4 });
  ok('a room socket upgrades (101) and takes no place in the 1v1 queue',
    a.status === 101 && rt.lobby.queue.length === 0 && rt.lobby.openRooms.length === 1);

  const b = await open(rt, { name: 'Rune', tiq: 1300, room: 4 });
  ok('a second room socket joins the same room, and nothing launches while a seat is open',
    rt.lobby.openRooms.length === 1 && !roomOf(a.socket) && !roomOf(b.socket));

  /* The wait timer. The alarm is the object's own clock, so the check moves the clock rather than
     sleeping eight seconds: the room's own `openedAt` is read off the real one. */
  await elapse(rt, 9000);
  const fa = roomOf(a.socket);
  const fb = roomOf(b.socket);
  ok('the wait running out backfills every empty seat and launches', !!fa && !!fb);
  ok('the two people keep the seats they took, in order', fa?.side === 0 && fb?.side === 1,
    `${fa?.side}/${fb?.side}`);
  ok('the room names all four seats and says which are the machine\'s',
    JSON.stringify(fa?.seats.map((s) => s.bot)) === '[false,false,true,true]'
    && fa.seats.map((s) => s.name).join('|') === 'Ada|Rune|Bot 2|Bot 3',
    JSON.stringify(fa?.seats));
  ok('the machine seats are laddered Normal/Hard, not three copies of one',
    JSON.stringify(fa?.seats.slice(2).map((s) => s.difficulty)) === '["hard","normal"]',
    JSON.stringify(fa?.seats.map((s) => s.difficulty)));
  ok('both sides get the same matchId, seed and four-seat board',
    fa?.matchId === fb?.matchId && fa?.seed === fb?.seed
    && JSON.stringify(fa?.sizes) === '[1,1,1,1]', JSON.stringify(fa?.sizes));
  ok('the room is a live match on /admin/status, with its size and bot count',
    rt.lobby.rooms.size === 1
    && (await rt.lobby.fetch({
      url: 'http://127.0.0.1:8787/admin/status',
      headers: { get: (name) => (name === 'x-detour-admin' ? '1' : null) },
    })).body.includes('"players":4'));

  /* Play it: both people move, and the machine's whole answer rides along in the same batch. The
     board is rebuilt here from the seed the room handed out, which is what the clients do. */
  const sidesOn = (socket) => messages(socket).filter((m) => m.type === 'MOVE').map((m) => m.side);
  const moveOf = (st) => ({ kind: 'move', ball: st.ball, to: st.to });
  let board = newGame(fa.sizes, { hazards: true, seed: fa.seed });
  const m0 = moveOf(steps(board, 0)[0]);
  send(a.socket, { type: 'MOVE', action: m0 });
  board = apply(board, m0);
  ok('a person\'s move reaches the other seats and nobody else has moved yet',
    JSON.stringify(sidesOn(b.socket)) === '[0]', JSON.stringify(sidesOn(b.socket)));

  const m1 = moveOf(steps(board, 1)[0]);
  send(b.socket, { type: 'MOVE', action: m1 });
  board = apply(board, m1);
  ok('a person\'s move and the machine\'s answers arrive on the other seats in one batch',
    JSON.stringify(sidesOn(a.socket)) === '[1,2,3]' && JSON.stringify(sidesOn(b.socket)) === '[0,2,3]',
    `${JSON.stringify(sidesOn(a.socket))} / ${JSON.stringify(sidesOn(b.socket))}`);

  /* the turn is back on seat 0, so a move from seat 1 is out of turn — and a move that is not even
     this seat's ball is a different refusal, which is why both are checked */
  const before = messages(b.socket).length;
  send(b.socket, { type: 'MOVE', action: m0 });
  const rejected = messages(b.socket).slice(before).find((m) => m.type === 'REJECT');
  ok('a room seat that is not on turn is refused, not obeyed',
    !!rejected && rejected.reason === 'not_your_turn', JSON.stringify(rejected));

  /* the takeover: a person's socket dies mid-race and the machine finishes their seat */
  const seenByA = messages(a.socket).length;
  b.socket.close(1006, 'network');
  const handed = messages(a.socket).slice(seenByA).find((m) => m.type === 'SEAT_BOT');
  ok('a person who drops mid-room hands the seat to the machine, and everyone is told',
    !!handed && handed.side === 1 && handed.name === 'Rune', JSON.stringify(handed));
  ok('and the race carries on: the room is still live', rt.lobby.rooms.size === 1);

  /* the seat is now the machine's, so it plays — and the race keeps moving without the leaver */
  const movedBefore = messages(a.socket).filter((m) => m.type === 'MOVE').length;
  /* Seat 1 is the machine's now, so the room runs itself: seat 0 moves, the driver answers for the
     three machine seats inside the same call, and the turn comes back. Keep feeding seat 0 until
     the room decides itself. */
  for (let i = 0; i < 400 && rt.lobby.rooms.size === 1; i++) {
    const st = rt.lobby.rooms.get(fa.matchId);
    if (!st || st.driver.state.winner !== null || st.driver.turn !== 0) break;
    const list = steps(st.driver.state, 0);
    send(a.socket, {
      type: 'MOVE',
      action: list.length ? { kind: 'move', ball: list[0].ball, to: list[0].to } : { kind: 'pass' },
    });
  }
  ok('the taken-over room played on past the drop, and reached a winner',
    messages(a.socket).filter((m) => m.type === 'MOVE').length > movedBefore && rt.lobby.rooms.size === 0,
    `moves ${messages(a.socket).filter((m) => m.type === 'MOVE').length} vs ${movedBefore}, rooms ${rt.lobby.rooms.size}`);
}

{
  /* the host's early start, and a 1v1 socket that must never be swept into a room */
  const rt = runtime({ DEV_AUTH: 'true' });
  const solo = await open(rt, { name: 'Solo', tiq: 1000 });
  const host = await open(rt, { name: 'Host', tiq: 1000, room: 3, bottier: 'normal' });
  ok('a room socket never joins the pairing queue',
    rt.lobby.queue.length === 1 && rt.lobby.queue[0].name === 'Solo');
  ok('a room waits until it is told to start', !roomOf(host.socket));
  send(host.socket, { type: 'ROOM_START' });
  const found = roomOf(host.socket);
  ok('the host starting early fills the room and launches at once', !!found && found.side === 0);
  ok('the room holds the size it was asked for, all Normal',
    JSON.stringify(found?.sizes) === '[1,1,1]'
    && JSON.stringify(found?.seats.map((s) => s.difficulty)) === '["normal","normal","normal"]',
    JSON.stringify(found?.seats));
  ok('the machine holds the seats nobody took',
    JSON.stringify(found?.seats.map((s) => s.bot)) === '[false,true,true]');
}

{
  /* a seat that leaves before the room launches is simply re-opened, not taken over */
  const rt = runtime({ DEV_AUTH: 'true' });
  const one = await open(rt, { name: 'First', tiq: 1000, room: 2 });
  one.socket.close(1006, 'gone');
  ok('a room nobody is left in is dropped', rt.lobby.openRooms.length === 0);
  const two = await open(rt, { name: 'Second', tiq: 1000, room: 2 });
  await elapse(rt, 9000);
  ok('and the next arrival gets a room of their own, backfilled and launched',
    !!roomOf(two.socket) && JSON.stringify(roomOf(two.socket).seats.map((s) => s.bot)) === '[false,true]');
}

console.log(`\n${ran - failed}/${ran} matchmaking checks passed`);
if (failed > 0) process.exit(1);
