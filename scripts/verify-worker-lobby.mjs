/**
 * verify-worker-lobby.mjs — the friends lobby protocol, driven in plain Node.
 *
 * `npm run build` only proves both sides type-check. This proves the room the sheet talks to:
 * a host mints a code, a guest joins it, the host's format switch reaches every seat, a seat that
 * leaves before the launch hands the crown on, and the room that nobody is left in is gone.
 *
 * The Durable Object runs its real code — the same `MatchmakerDO` the worker serves — with only the
 * three Cloudflare globals faked, so this is "verified in workerd" minus workerd.
 *
 *   node scripts/verify-worker-lobby.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

/* ---------- the three globals the worker touches ---------- */

class FakeSocket {
  constructor() {
    this.peer = null;
    this.sent = [];
    this.received = [];
    this.listeners = new Map();
    this.accepted = false;
    this.closed = false;
    this.readyState = 1;
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
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close', { code, reason });
    this.peer?.emit('close', { code, reason });
  }

  addEventListener(type, cb) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  emit(type, event) {
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

/* ---------- the bundled worker ---------- */

const outfile = path.join(ROOT, '.tmp', 'worker-lobby.mjs');
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

/* ---------- a runtime: one singleton DO behind a fake namespace ---------- */

function runtime() {
  const env = { DEV_AUTH: 'true', TELEGRAM_BOT_TOKEN: undefined };
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

/** One upgrade, exactly as a browser's `new WebSocket(url)` would arrive. */
async function open(rt, { name = 'Player', code = '', host = false, tiq = 1200 } = {}) {
  const query = new URLSearchParams({ tiq: String(tiq), tier: 'tactician', flag: 'NL', name, wide: '0' });
  if (code) query.set('roomcode', code);
  if (host) query.set('host', '1');
  const res = await rt.route(`http://127.0.0.1:8787/ws/matchmake?${query}`, true);
  return { status: res.status, socket: res.webSocket };
}

const send = (socket, message) => socket.send(JSON.stringify(message));
const frames = (socket, type) => socket.received
  .map((raw) => JSON.parse(raw))
  .filter((m) => !type || m.type === type);
/** The newest `LOBBY` a socket has been handed. */
const lobbyOf = (socket) => frames(socket, 'LOBBY').at(-1) ?? null;

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

/* ---------- the lobby ---------- */

/* a host mints the code, a guest joins it, and both see the same roster */
{
  const rt = runtime();
  const host = await open(rt, { name: 'Ada', code: '9786', host: true });
  ok('a host opening a fresh code gets a socket', host.status === 101 && !!host.socket);
  const first = lobbyOf(host.socket);
  ok('the host is told the room it just minted',
    first?.code === '9786' && first?.host === 0 && first?.you === 0 && first?.mode === 'ffa',
    JSON.stringify(first));
  ok('a fresh room seats four and holds only the host',
    first?.capacity === 4 && first?.seats?.length === 1 && first?.seats[0].host === true,
    JSON.stringify(first?.seats));

  const guest = await open(rt, { name: 'Rune', code: '9786' });
  ok('a guest joining by code gets a socket', guest.status === 101 && !!guest.socket);
  const h2 = lobbyOf(host.socket);
  const g1 = lobbyOf(guest.socket);
  ok('both seats are told the room grew to two',
    h2?.seats?.length === 2 && g1?.seats?.length === 2, `${h2?.seats?.length}/${g1?.seats?.length}`);
  ok('the guest is told which seat is theirs', g1?.you === 1, `you=${g1?.you}`);
  ok('the roster carries names, not socket ids', g1?.seats[1].name === 'Rune' && g1?.seats[0].name === 'Ada',
    JSON.stringify(g1?.seats.map((s) => s.name)));
  ok('a seat starts on a team, alternating down the room',
    g1?.seats[0].team === 0 && g1?.seats[1].team === 1,
    JSON.stringify(g1?.seats.map((s) => s.team)));

  /* the host's format switch reaches every seat */
  send(host.socket, { type: 'SET_FORMAT', format: '2v2' });
  ok('the host\'s format switch reaches the guest',
    lobbyOf(guest.socket)?.format === '2v2' && lobbyOf(guest.socket)?.mode === 'team',
    JSON.stringify(lobbyOf(guest.socket)?.format));
  ok('and it is reflected back to the host',
    lobbyOf(host.socket)?.format === '2v2', JSON.stringify(lobbyOf(host.socket)?.format));

  /* a guest cannot turn the same knob */
  const before = frames(host.socket, 'LOBBY').length;
  send(guest.socket, { type: 'SET_FORMAT', format: '4p' });
  ok('a guest cannot change the format',
    lobbyOf(host.socket)?.format === '2v2' && frames(host.socket, 'LOBBY').length === before);

  /* team assignment: the host moves anyone, a guest only their own seat */
  send(host.socket, { type: 'SET_TEAM', side: 1, team: 0 });
  ok('the host can move a seat between the teams', lobbyOf(guest.socket)?.seats[1].team === 0,
    JSON.stringify(lobbyOf(guest.socket)?.seats.map((s) => s.team)));
  send(guest.socket, { type: 'SET_TEAM', side: 0, team: 1 });
  ok('a guest cannot move another seat', lobbyOf(host.socket)?.seats[0].team === 0);
  send(guest.socket, { type: 'SET_TEAM', side: 1, team: 1 });
  ok('a guest can move their own seat',
    lobbyOf(host.socket)?.seats[1].team === 1,
    JSON.stringify(lobbyOf(host.socket)?.seats.map((s) => s.team)));

  /* the size switch reflows the seated people into the smaller room, nobody dropped */
  send(host.socket, { type: 'SET_FORMAT', format: '2v1' });
  const small = lobbyOf(guest.socket);
  ok('a 2v1 reflow fits the room into three seats',
    small?.format === '2v1' && small?.capacity === 3 && small?.seats?.length === 2,
    JSON.stringify([small?.format, small?.capacity, small?.seats?.length]));
}

/* a code nobody minted is a typo, and a code already open belongs to its host */
{
  const rt = runtime();
  const lost = await open(rt, { code: '1111' });
  ok('joining a code that was never minted is refused',
    frames(lost.socket, 'ERROR')[0]?.reason === 'room_not_found',
    JSON.stringify(frames(lost.socket, 'ERROR')));

  const host = await open(rt, { code: '2222', host: true });
  const again = await open(rt, { code: '2222', host: true });
  ok('a second host on the same code is refused',
    frames(again.socket, 'ERROR')[0]?.reason === 'room_exists');
  ok('the first host still holds the room', lobbyOf(host.socket)?.host === 0);
}

/* the room is full at four, and the fifth is told so */
{
  const rt = runtime();
  const host = await open(rt, { name: 'A', code: '3333', host: true });
  const seats = [];
  for (const name of ['B', 'C', 'D']) seats.push(await open(rt, { name, code: '3333' }));
  ok('four seats fill', lobbyOf(host.socket)?.seats?.length === 4,
    String(lobbyOf(host.socket)?.seats?.length));
  const fifth = await open(rt, { name: 'E', code: '3333' });
  ok('a fifth player is refused with room_full',
    frames(fifth.socket, 'ERROR')[0]?.reason === 'room_full');
  ok('the four seats are untouched', lobbyOf(host.socket)?.seats?.length === 4);

  /* a size the room cannot fit into is bounced back to the host, room untouched */
  send(host.socket, { type: 'SET_FORMAT', format: '3p' });
  const denied = frames(host.socket, 'FORMAT_DENIED');
  ok('a size that cannot hold the room is refused',
    denied.length === 1 && denied[0].reason === 'room_full'
    && lobbyOf(host.socket)?.format === '4p' && lobbyOf(host.socket)?.seats?.length === 4,
    JSON.stringify(denied));
}

/* the launch: two players, the host's format, and a race both seats agree on */
{
  const rt = runtime();
  const host = await open(rt, { name: 'Ada', code: '4444', host: true });
  const guest = await open(rt, { name: 'Rune', code: '4444' });
  send(host.socket, { type: 'SET_MODE', mode: 'team' });
  send(guest.socket, { type: 'ROOM_START' });
  ok('a guest cannot start the room', !frames(guest.socket, 'ROOM_FOUND').length
    && !frames(host.socket, 'ROOM_FOUND').length);

  send(host.socket, { type: 'ROOM_START' });
  const rh = frames(host.socket, 'ROOM_FOUND')[0];
  const rg = frames(guest.socket, 'ROOM_FOUND')[0];
  ok('the host starting launches the room for both seats', !!rh && !!rg);
  ok('both seats get the same match and the same seed',
    rh?.matchId === rg?.matchId && rh?.seed === rg?.seed, `${rh?.matchId}/${rg?.matchId}`);
  ok('the seats are told their own side', rh?.side === 0 && rg?.side === 1, `${rh?.side}/${rg?.side}`);
  ok('the race keeps the format the host picked', rh?.mode === 'team' && rg?.mode === 'team');
  ok('every seat carries its team into the race',
    Array.isArray(rg?.teams) && rg.teams.length === 4, JSON.stringify(rg?.teams));
  ok('the roster names both people and fills the rest with the machine',
    rg?.seats?.length === 4 && rg.seats[0].bot === false && rg.seats[1].bot === false
    && rg.seats[2].bot === true && rg.seats[3].bot === true,
    JSON.stringify(rg?.seats?.map((s) => [s.name, s.bot])));
  ok('a one-ball board per seat, as the rules expect',
    Array.isArray(rg?.sizes) && rg.sizes.length === 4 && rg.sizes.every((n) => n === 1),
    JSON.stringify(rg?.sizes));

  /* the launched room is no longer a lobby: the code is free again */
  const late = await open(rt, { name: 'Late', code: '4444' });
  ok('a room that has launched no longer answers its code',
    frames(late.socket, 'ERROR')[0]?.reason === 'room_not_found',
    JSON.stringify(frames(late.socket, 'ERROR')));
}

/* the crown migrates when the host walks out, and the last seat closes the room */
{
  const rt = runtime();
  const host = await open(rt, { name: 'Ada', code: '5555', host: true });
  const guest = await open(rt, { name: 'Rune', code: '5555' });
  const third = await open(rt, { name: 'Kai', code: '5555' });
  host.socket.close(1000, 'left');
  const after = lobbyOf(guest.socket);
  ok('the guest takes the crown when the host leaves',
    after?.host === 1 && after?.seats?.length === 2 && after?.seats.find((s) => s.side === 1).host === true,
    JSON.stringify(after));
  ok('the crown is unique: nobody else is marked host',
    after?.seats.filter((s) => s.host).length === 1);

  /* the promoted host can now start the room */
  send(guest.socket, { type: 'ROOM_START' });
  ok('the promoted host can start the race', !!frames(guest.socket, 'ROOM_FOUND')[0]);
  ok('and the remaining seats are launched with it', !!frames(third.socket, 'ROOM_FOUND')[0]);
}

{
  const rt = runtime();
  const host = await open(rt, { name: 'Ada', code: '6666', host: true });
  const guest = await open(rt, { name: 'Rune', code: '6666' });
  guest.socket.close(1000, 'left');
  ok('a guest leaving is removed from the roster',
    lobbyOf(host.socket)?.seats?.length === 1, String(lobbyOf(host.socket)?.seats?.length));
  host.socket.close(1000, 'left');
  const again = await open(rt, { name: 'Late', code: '6666' });
  ok('the room dies with its last seat', frames(again.socket, 'ERROR')[0]?.reason === 'room_not_found');
}

/* maintenance closes a lobby the same way it closes the queue */
{
  const rt = runtime();
  const host = await open(rt, { name: 'Ada', code: '7777', host: true });
  const guest = await open(rt, { name: 'Rune', code: '7777' });
  await rt.lobby.fetch({
    url: 'http://127.0.0.1:8787/admin/config',
    method: 'POST',
    headers: { get: (name) => (name === 'x-detour-admin' ? '1' : null) },
    json: async () => ({ maintenance: true }),
  });
  ok('maintenance sends both seats an ERROR',
    frames(host.socket, 'ERROR').length > 0 && frames(guest.socket, 'ERROR').length > 0);
  const late = await open(rt, { name: 'Late', code: '8888', host: true });
  ok('and a new code is refused while it is on',
    frames(late.socket, 'ERROR')[0]?.reason === 'MAINTENANCE');
}

console.log(`\n${ran - failed}/${ran} lobby checks passed`);
process.exit(failed === 0 ? 0 : 1);
