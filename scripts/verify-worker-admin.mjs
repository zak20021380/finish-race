/**
 * verify-worker-admin.mjs — the Command Center's server half, driven in plain Node.
 *
 * `npm run build` proves both sides type-check. This proves the admin surface actually behaves: it
 * bundles the real `worker/index.ts` (the same code wrangler ships), stubs the three Cloudflare
 * globals the backend touches, and walks every promise the panel makes —
 *
 *   - `403` for a caller with no credentials, a forged signature, or a valid signature that names
 *     somebody who is not on `ADMIN_IDS`;
 *   - the development door: a loopback host (or `DEV_AUTH`) plus an explicit admin marker, and
 *     nothing less than that;
 *   - `GET /admin/status`: the queue, the rooms and the live config, exactly as the roster reads it;
 *   - `POST /admin/config`: the maintenance lock refusing new QUEUE attempts AND sending everyone
 *     already waiting home, plus both pairing radii moving under a live queue;
 *   - `POST /admin/action`: CLEAR_QUEUE evicting the room, ABORT_MATCH ending one stuck race.
 *
 * The Durable Object runs its real code — Web Crypto HMAC and all — so this is "verified in
 * workerd" minus workerd.
 *
 *   node scripts/verify-worker-admin.mjs
 */
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TOKEN = '12345:AAHtest-token-for-the-admin-harness';
/** The allowlist the harness configures: two ids, and one that is deliberately missing. */
const ADMIN_IDS = '1000001,42';
const ADMIN = 1000001;
const SECOND_ADMIN = 42;
const OUTSIDER = 7;
const HOST = 'detour.example.com';

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

const outfile = path.join(ROOT, '.tmp', 'worker-admin.mjs');
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
const workerModule = await import(pathToFileURL(outfile).href);
const worker = workerModule.default;
const { MatchmakerDO } = workerModule;
fs.rmSync(outfile, { force: true });

/* ---------- a request, a runtime: the worker, one singleton DO, a fake namespace ---------- */

/** The slice of `Request` the worker actually reads: the url, the method, the headers, the body. */
function mkRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  return {
    url,
    method,
    headers: { get: (name) => (map.has(String(name).toLowerCase()) ? map.get(String(name).toLowerCase()) : null) },
    async json() { return body ?? {}; },
  };
}

function runtime(vars = {}) {
  const env = {
    DEV_AUTH: vars.DEV_AUTH ?? 'false',
    TELEGRAM_BOT_TOKEN: vars.TELEGRAM_BOT_TOKEN,
    ADMIN_IDS: vars.ADMIN_IDS,
  };
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
    env,
    lobby,
    route: (url, opts) => worker.fetch(mkRequest(url, opts), env),
  };
}

/** Through the worker and into the DO, exactly as a browser upgrade would arrive. */
async function open(rt, fields = {}) {
  const { initData = '', tiq = 0, tier = 'rookie', flag = '', name = 'Player', wide = false,
    host = '127.0.0.1:8787' } = fields;
  const query = new URLSearchParams({ tiq: String(tiq), tier, flag, name, wide: wide ? '1' : '0' });
  if (initData) query.set('initData', initData);
  const res = await rt.route(`http://${host}/ws/matchmake?${query}`, { headers: { upgrade: 'websocket' } });
  return { status: res.status, socket: res.webSocket };
}

/** One admin call. The host decides which door is even available to it. */
const call = (rt, route, { method = 'GET', body = null, headers = {}, host = HOST } = {}) =>
  rt.route(`http://${host}${route}`, { method, body, headers });

const bodyOf = (res) => JSON.parse(res.body);
const status = async (rt, headers = {}) => bodyOf(await call(rt, '/admin/status', { headers }));
const config = async (rt, patch, headers = {}) =>
  bodyOf(await call(rt, '/admin/config', { method: 'POST', body: patch, headers }));
const act = async (rt, payload, headers = {}) =>
  call(rt, '/admin/action', { method: 'POST', body: payload, headers });

const send = (socket, message) => socket.send(JSON.stringify(message));
const messages = (socket) => socket.received.map((raw) => JSON.parse(raw));
const matchOf = (socket) => messages(socket).find((m) => m.type === 'MATCH_FOUND') ?? null;
const errorOf = (socket) => messages(socket).find((m) => m.type === 'ERROR') ?? null;

/** A properly signed Telegram initData, built the documented way. */
function signed(fields, token = TOKEN) {
  const rows = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(rows.join('\n')).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const user = (id, first_name, username) => ({ id, first_name, username, language_code: 'en' });

/** The initData an admin sends: a real signature over a real Telegram user. */
const initFor = (id, query_id = 'ADMIN') =>
  signed({ auth_date: '1700000000', user: JSON.stringify(user(id, 'Boss', 'boss')), query_id });

/** The header the panel actually uses (`adminHeaders()` in src/admin.ts). */
const asAdmin = (id = ADMIN) => ({ 'x-telegram-init-data': initFor(id) });

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

/* ---------- 1. the admin gate ---------- */

console.log('\n-- the admin gate --');
{
  const rt = runtime({ TELEGRAM_BOT_TOKEN: TOKEN, ADMIN_IDS });

  const health = await call(rt, '/health');
  ok('/health is still public', health.status === 200 && bodyOf(health).ok === true);
  ok('/ws/matchmake still answers 426 to a plain request',
    (await call(rt, '/ws/matchmake')).status === 426);

  const none = await call(rt, '/admin/status');
  ok('no credentials on a real host is refused with 403', none.status === 403, `status ${none.status}`);
  ok('the refusal names the reason', bodyOf(none).error === 'forbidden', none.body);

  const forged = initFor(ADMIN).replace(/hash=[0-9a-f]+/, 'hash=deadbeef');
  const bad = await call(rt, '/admin/status', { headers: { 'x-telegram-init-data': forged } });
  ok('a forged initData hash is refused with 403', bad.status === 403, `status ${bad.status}`);

  const stranger = await call(rt, '/admin/status', { headers: asAdmin(OUTSIDER) });
  ok('a valid signature for a non-admin is refused with 403', stranger.status === 403, `status ${stranger.status}`);

  const boss = await call(rt, '/admin/status', { headers: asAdmin(ADMIN) });
  ok('a signed admin is let in (200)', boss.status === 200, `status ${boss.status}`);
  const second = await call(rt, '/admin/status', { headers: asAdmin(SECOND_ADMIN) });
  ok('the second id on the allowlist is let in too', second.status === 200, `status ${second.status}`);

  ok('POST /admin/config is behind the same gate',
    (await call(rt, '/admin/config', { method: 'POST', body: {} })).status === 403);
  ok('POST /admin/action is behind the same gate',
    (await call(rt, '/admin/action', { method: 'POST', body: { action: 'CLEAR_QUEUE' } })).status === 403);

  const nothing = await call(rt, '/admin/nope', { headers: asAdmin() });
  ok('an unknown admin route answers 404 once you are in', nothing.status === 404, `status ${nothing.status}`);
}

/* ---------- 2. the development door ---------- */

console.log('\n-- the development door --');
{
  const dev = runtime({ DEV_AUTH: 'true', ADMIN_IDS });
  ok('DEV_AUTH + an admin header opens the door',
    (await call(dev, '/admin/status', { headers: { 'x-admin': '1' } })).status === 200);
  ok('DEV_AUTH alone does not: the marker is still required',
    (await call(dev, '/admin/status')).status === 403);

  const local = runtime({ ADMIN_IDS });
  ok('a loopback host with ?admin=1 opens the door',
    (await call(local, '/admin/status?admin=1', { host: '127.0.0.1:8787' })).status === 200);
  ok('a loopback host with the x-detour-admin header opens the door',
    (await call(local, '/admin/status', { host: 'localhost:8787', headers: { 'x-detour-admin': '1' } })).status === 200);
  ok('a loopback host with no marker stays shut',
    (await call(local, '/admin/status', { host: '127.0.0.1:8787' })).status === 403);

  const deployed = runtime({ TELEGRAM_BOT_TOKEN: TOKEN, ADMIN_IDS });
  ok('a deployed host ignores the dev marker',
    (await call(deployed, '/admin/status', { headers: { 'x-admin': '1' } })).status === 403);
  ok('but a signed admin still gets in from anywhere',
    (await call(deployed, '/admin/status', { headers: asAdmin() })).status === 200);

  const noToken = runtime({ ADMIN_IDS });
  ok('with no bot token configured, no signature can be trusted',
    (await call(noToken, '/admin/status', { headers: asAdmin() })).status === 403);

  const noList = runtime({ TELEGRAM_BOT_TOKEN: TOKEN });
  ok('an empty ADMIN_IDS closes the Telegram door',
    (await call(noList, '/admin/status', { headers: asAdmin() })).status === 403);
}

/* ---------- 3. GET /admin/status ---------- */

console.log('\n-- GET /admin/status --');
{
  const rt = runtime({ DEV_AUTH: 'true' });
  const headers = { 'x-admin': '1' };
  const empty = await status(rt, headers);
  ok('an empty room reports zero on both counters',
    empty.ok === true && empty.queueCount === 0 && empty.activeMatchesCount === 0);
  ok('and an empty roster', empty.queuedPlayers.length === 0 && empty.activeRooms.length === 0);
  ok('the config starts on the shipped numbers',
    empty.config.maintenance === false && empty.config.normalRadius === 250 && empty.config.wideRadius === 600,
    JSON.stringify(empty.config));

  /* two minds far enough apart that the room keeps them both */
  const a = await open(rt, { tiq: 1000, name: 'Ada' });
  const b = await open(rt, { tiq: 3000, name: 'Rune' });
  send(a.socket, { type: 'QUEUE', wide: false });
  send(b.socket, { type: 'QUEUE', wide: true });

  const waiting = await status(rt, headers);
  ok('both waiting seats are counted', waiting.queueCount === 2, String(waiting.queueCount));
  ok('a waiting seat carries id, name and tiq',
    waiting.queuedPlayers[0].id.startsWith('guest-') && waiting.queuedPlayers[0].name === 'Ada'
      && waiting.queuedPlayers[0].tiq === 1000,
    JSON.stringify(waiting.queuedPlayers[0]));
  ok('the widen flag is reported per seat',
    waiting.queuedPlayers[0].wide === false && waiting.queuedPlayers[1].wide === true);
  ok('the wait is reported in milliseconds',
    waiting.queuedPlayers.every((p) => Number.isInteger(p.waitedMs) && p.waitedMs >= 0),
    JSON.stringify(waiting.queuedPlayers.map((p) => p.waitedMs)));

  /* now a real race: two seats inside the band, and out of reach of the two already waiting */
  const c = await open(rt, { tiq: 1900, name: 'Ivo' });
  const d = await open(rt, { tiq: 1950, name: 'Mira' });
  send(c.socket, { type: 'QUEUE', wide: false });
  send(d.socket, { type: 'QUEUE', wide: false });
  const found = matchOf(c.socket);

  const live = await status(rt, headers);
  ok('a paired room is counted', live.activeMatchesCount === 1, String(live.activeMatchesCount));
  const room = live.activeRooms[0];
  ok('the room names both seats in seat order',
    room.p0 === 'Ivo' && room.p1 === 'Mira', JSON.stringify(room));
  ok('the room reports the match id the clients were given', room.matchId === found?.matchId);
  ok('the room reports whose turn it is and the hazard round',
    room.turn === 0 && room.round === 1, `turn ${room.turn} round ${room.round}`);
  ok('paired seats are no longer queued', live.queueCount === 2, String(live.queueCount));
}

/* ---------- 4. the server-enforced maintenance lock ---------- */

console.log('\n-- the maintenance lock --');
{
  const rt = runtime({ DEV_AUTH: 'true' });
  const headers = { 'x-admin': '1' };

  const a = await open(rt, { tiq: 1000, name: 'Waiting' });
  const b = await open(rt, { tiq: 3000, name: 'AlsoWaiting' });
  send(a.socket, { type: 'QUEUE', wide: false });
  send(b.socket, { type: 'QUEUE', wide: false });
  ok('two seats are waiting before the lock', (await status(rt, headers)).queueCount === 2);

  const locked = await config(rt, { maintenance: true }, headers);
  ok('POST /admin/config turns the lock on and says so', locked.ok === true && locked.config.maintenance === true);
  ok('turning the lock on does not disturb the radii',
    locked.config.normalRadius === 250 && locked.config.wideRadius === 600);

  ok('every seat already waiting is notified',
    errorOf(a.socket)?.reason === 'MAINTENANCE' && errorOf(b.socket)?.reason === 'MAINTENANCE',
    JSON.stringify([errorOf(a.socket), errorOf(b.socket)]));
  ok('and let go cleanly', a.socket.ended === true && b.socket.ended === true);
  ok('the room is empty afterwards', (await status(rt, headers)).queueCount === 0);

  const late = await open(rt, { tiq: 1000 });
  send(late.socket, { type: 'QUEUE', wide: false });
  ok('a new QUEUE is refused with the reason', errorOf(late.socket)?.reason === 'MAINTENANCE');
  ok('and that socket is closed too', late.socket.ended === true);
  ok('the refused seat never joined the queue', rt.lobby.queue.length === 0);
  ok('no match was ever announced', matchOf(late.socket) === null);

  const off = await config(rt, { maintenance: false }, headers);
  ok('the lock lifts again', off.ok === true && off.config.maintenance === false);

  const x = await open(rt, { tiq: 1000, name: 'X' });
  const y = await open(rt, { tiq: 1000, name: 'Y' });
  send(x.socket, { type: 'QUEUE', wide: false });
  send(y.socket, { type: 'QUEUE', wide: false });
  ok('with the lock off, queueing works again', !!matchOf(x.socket) && !!matchOf(y.socket));
}

/* ---------- 5. the live radius override ---------- */

console.log('\n-- the live radius override --');
{
  const rt = runtime({ DEV_AUTH: 'true' });
  const headers = { 'x-admin': '1' };

  const a = await open(rt, { tiq: 1000 });
  const b = await open(rt, { tiq: 1300 });
  send(a.socket, { type: 'QUEUE', wide: false });
  send(b.socket, { type: 'QUEUE', wide: false });
  ok('300 TIQ apart is outside the default 250 band', !matchOf(a.socket) && !matchOf(b.socket));

  const wide = await config(rt, { normalRadius: 400 }, headers);
  ok('POST /admin/config moves the normal band', wide.ok === true && wide.config.normalRadius === 400);
  ok('and the room pairs them on the spot',
    !!matchOf(a.socket) && !!matchOf(b.socket), JSON.stringify(messages(a.socket)));

  /* the widened band, on its own */
  const rt2 = runtime({ DEV_AUTH: 'true' });
  await config(rt2, { normalRadius: 50, wideRadius: 500 }, headers);
  const c = await open(rt2, { tiq: 1000 });
  const d = await open(rt2, { tiq: 1300 });
  send(c.socket, { type: 'QUEUE', wide: false });
  send(d.socket, { type: 'QUEUE', wide: false });
  ok('50 TIQ apart bands nobody', !matchOf(c.socket) && !matchOf(d.socket));
  send(c.socket, { type: 'WIDEN' });
  ok('one widened side pairs inside the overridden wide band', !!matchOf(c.socket) && !!matchOf(d.socket));

  const clamped = await config(rt2, { normalRadius: 99999, wideRadius: -5 }, headers);
  ok('an absurd normal band is clamped to 2000', clamped.config.normalRadius === 2000, String(clamped.config.normalRadius));
  ok('a negative wide band is clamped to 0', clamped.config.wideRadius === 0, String(clamped.config.wideRadius));

  const junk = await config(rt2, { normalRadius: 'wide', wideRadius: null }, headers);
  ok('a field that is not a number is ignored, not applied',
    junk.config.normalRadius === 2000 && junk.config.wideRadius === 0, JSON.stringify(junk.config));

  ok('the status route reads the override back',
    (await status(rt2, headers)).config.normalRadius === 2000);
}

/* ---------- 6. CLEAR_QUEUE and ABORT_MATCH ---------- */

console.log('\n-- the moderation actions --');
{
  const rt = runtime({ DEV_AUTH: 'true' });
  const headers = { 'x-admin': '1' };

  const a = await open(rt, { tiq: 1000, name: 'One' });
  const b = await open(rt, { tiq: 3000, name: 'Two' });
  send(a.socket, { type: 'QUEUE', wide: false });
  send(b.socket, { type: 'QUEUE', wide: false });

  const cleared = await act(rt, { action: 'CLEAR_QUEUE' }, headers);
  ok('CLEAR_QUEUE answers ok', cleared.status === 200 && bodyOf(cleared).ok === true);
  ok('and reports how many seats it evicted', bodyOf(cleared).cleared === 2, cleared.body);
  ok('both waiting sockets were told', !!errorOf(a.socket) && !!errorOf(b.socket),
    JSON.stringify([messages(a.socket), messages(b.socket)]));
  ok('and closed cleanly', a.socket.ended === true && b.socket.ended === true);
  ok('the queue is empty', (await status(rt, headers)).queueCount === 0);

  /* a room, then the abort */
  const c = await open(rt, { tiq: 1000, name: 'Stuck' });
  const d = await open(rt, { tiq: 1100, name: 'Held' });
  send(c.socket, { type: 'QUEUE', wide: false });
  send(d.socket, { type: 'QUEUE', wide: false });
  const matchId = matchOf(c.socket)?.matchId;
  ok('a room is live to abort', !!matchId && (await status(rt, headers)).activeMatchesCount === 1);

  const aborted = await act(rt, { action: 'ABORT_MATCH', matchId }, headers);
  ok('ABORT_MATCH answers ok', aborted.status === 200 && bodyOf(aborted).ok === true);
  ok('and names the room it pulled', bodyOf(aborted).aborted === matchId, aborted.body);
  ok('both seats are notified',
    messages(c.socket).some((m) => m.type === 'ABORTED' && m.matchId === matchId)
      && messages(d.socket).some((m) => m.type === 'ABORTED' && m.matchId === matchId),
    JSON.stringify([messages(c.socket), messages(d.socket)]));
  ok('both seats are closed', c.socket.ended === true && d.socket.ended === true);
  ok('the room is gone from the room list', rt.lobby.races.size === 0);
  ok('and from /admin/status', (await status(rt, headers)).activeMatchesCount === 0);

  const missing = await act(rt, { action: 'ABORT_MATCH', matchId: 'm-nope' }, headers);
  ok('aborting a room that is not there is refused with 400', missing.status === 400, `status ${missing.status}`);
  ok('and says why', bodyOf(missing).error === 'no_such_match', missing.body);

  const unknown = await act(rt, { action: 'EXPLODE' }, headers);
  ok('an unknown action is refused with 400', unknown.status === 400, `status ${unknown.status}`);
  ok('and says why', bodyOf(unknown).error === 'unknown_action', unknown.body);
}

console.log(`\n${ran - failed}/${ran} admin checks passed`);
if (failed > 0) process.exit(1);
