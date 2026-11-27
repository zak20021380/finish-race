/**
 * verify-worker-match-session.mjs — the two match doors, driven through the real Worker.
 *
 * `verify-matches.mjs` proves the gate functions. This proves the ENDPOINTS apply them: it bundles
 * `worker/index.ts` with the project's own esbuild, runs the real `MatchmakerDO` against an
 * in-memory context, and posts signed `initData` at it the way the Mini App does. Nothing here
 * reads `worker/matches.ts` directly — if the wiring is wrong, this goes red.
 *
 * What it pins:
 *   - no initData is 401, and a body-declared `userId` is never a credential;
 *   - a `pvp` row must name a real rival, so a solo stopwatch cannot be a ranked board;
 *   - an instant finish is `too_fast`, and the SAME call after the 15-second floor is credited;
 *   - a replay of that settlement is `not_active` and pays nothing;
 *   - a non-participant cannot settle somebody else's row;
 *   - only `pvp` pays a ladder point — `ai` pays coins and no TIQ;
 *   - a settlement is refused when the client echoes it with no match id;
 *   - the per-seat rate window answers 429 once the allowance is spent.
 *
 *   node scripts/verify-worker-match-session.mjs
 */
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TOKEN = '12345:AAHmatch-session-harness-token';
const HOST = 'finish-race.deadeye-game.workers.dev';

/* ---------- the bundled worker ---------- */

/* The room opens sockets for a queue pairing, so the harness needs the two globals the backend
   touches for an upgrade. Nothing else is faked: the Durable Object runs its real code. */
class FakeSocket {
  constructor() {
    this.peer = null;
    this.received = [];
    this.listeners = new Map();
    this.readyState = 1;
  }

  accept() {}

  send(data) {
    this.peer?.deliver(String(data));
  }

  deliver(text) {
    this.received.push(text);
    for (const cb of this.listeners.get('message') ?? []) cb({ data: text });
  }

  close() {
    this.readyState = 3;
    for (const cb of this.listeners.get('close') ?? []) cb({ code: 1000, reason: '' });
    this.peer?.close();
  }

  addEventListener(type, cb) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
}

const RealResponse = globalThis.Response;
/**
 * A Response that can also carry an upgrade's socket. The real one refuses `status: 101`, and the
 * worker's `json()` path only needs a body, a status and the header bag — so this keeps both.
 */
class FakeResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers);
    this.webSocket = init.webSocket ?? null;
  }

  async text() {
    return this.body === null || this.body === undefined ? '' : String(this.body);
  }

  async json() {
    return JSON.parse(await this.text());
  }

  clone() {
    return new FakeResponse(this.body, { status: this.status, headers: this.headers, webSocket: this.webSocket });
  }
}
void RealResponse;
globalThis.Response = FakeResponse;
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

const outfile = path.join(ROOT, '.tmp', 'worker-match-session.mjs');
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
const mod = await import(pathToFileURL(outfile).href);
const worker = mod.default;
const { MatchmakerDO } = mod;
fs.rmSync(outfile, { force: true });

/* ---------- one runtime: the worker plus one singleton room ---------- */

function runtime(vars = {}) {
  const env = {
    DEV_AUTH: vars.DEV_AUTH ?? 'false',
    TELEGRAM_BOT_TOKEN: vars.TELEGRAM_BOT_TOKEN ?? TOKEN,
    ADMIN_IDS: vars.ADMIN_IDS ?? '',
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
  return { env, lobby };
}

/** A properly signed Telegram initData, built the documented way. */
function signed(fields, token = TOKEN) {
  const rows = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(rows.join('\n')).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const user = (id, first_name) => ({ id, first_name, language_code: 'en' });
const initFor = (id, name) => signed({
  auth_date: '1795000000',
  user: JSON.stringify(user(id, name)),
  query_id: `Q${id}`,
});

/** One POST through the edge, exactly as the client sends it. */
async function post(rt, route, body, { initData = '', host = HOST } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (initData) headers['x-telegram-init-data'] = initData;
  const request = new Request(`https://${host}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(request, rt.env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* a non-JSON body is a failure the checks report */ }
  return { status: res.status, body: json, text };
}

/** Run `fn` with the clock pushed forward — the room judges with its own `Date.now()`. */
async function after(ms, fn) {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

let ran = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  ran += 1;
  if (condition) {
    console.log(`  ok  ${label}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

/* ---------- the checks ---------- */

const A = initFor(1001, 'Ada');
const B = initFor(2002, 'Rune');
const C = initFor(3003, 'Ivo');
const SEAT_A = 'tg-1001';
const SEAT_B = 'tg-2002';

console.log('\n-- the identity door --');
{
  const rt = runtime();
  const anon = await post(rt, '/api/match/start', { mode: 'pvp', opponentId: SEAT_B });
  ok('no initData is 401', anon.status === 401, `${anon.status} ${anon.text}`);

  /* A body that names somebody else is not a credential: the request still has no signature. */
  const declared = await post(rt, '/api/match/start', {
    mode: 'pvp', opponentId: SEAT_B, userId: '1001', player1Id: SEAT_A, score: 99999, wins: 500,
  });
  ok('a body-declared userId is still 401', declared.status === 401, `${declared.status} ${declared.text}`);

  const forged = initFor(1001, 'Ada').replace(/hash=[0-9a-f]+/, 'hash=deadbeef');
  const bad = await post(rt, '/api/match/start', { mode: 'pvp', opponentId: SEAT_B }, { initData: forged });
  ok('a forged signature is 401', bad.status === 401, `${bad.status} ${bad.text}`);
}

console.log('\n-- opening a row --');
let matchId = '';
{
  const rt = runtime();
  const solo = await post(rt, '/api/match/start', { mode: 'pvp' }, { initData: A });
  ok('a ranked row with no rival is refused', solo.status === 400 && solo.body?.error === 'opponent_required', solo.text);

  const aiOpponent = await post(rt, '/api/match/start', { mode: 'pvp', opponentId: 'ai' }, { initData: A });
  ok('a ranked row cannot name the machine', aiOpponent.status === 400, aiOpponent.text);

  const self = await post(rt, '/api/match/start', { mode: 'friendly', opponentId: SEAT_A }, { initData: A });
  ok('a self-pairing is refused', self.status === 400 && self.body?.error === 'self_opponent', self.text);

  const started = await post(rt, '/api/match/start', { mode: 'pvp', opponentId: SEAT_B }, { initData: A });
  matchId = started.body?.matchId ?? '';
  ok('a ranked row opens and mints an id',
    started.status === 200 && /^[0-9a-f-]{36}$/.test(matchId), started.text);
  ok('the row names both seats and stamps the clock',
    started.body?.player1Id === SEAT_A && started.body?.player2Id === SEAT_B
      && typeof started.body?.startedAt === 'number', started.text);
  ok('the answer advertises the floor', started.body?.minMs === 15_000, started.text);
}

console.log('\n-- the gates on the way out --');
{
  const rt = runtime();
  const started = await post(rt, '/api/match/start', { mode: 'pvp', opponentId: SEAT_B }, { initData: A });
  const id = started.body.matchId;

  const instant = await post(rt, '/api/match/end', { matchId: id, winnerId: SEAT_A }, { initData: A });
  ok('an instant finish is refused', instant.status === 400 && instant.body?.reason === 'too_fast', instant.text);

  const stranger = await post(rt, '/api/match/end', { matchId: id, winnerId: SEAT_A }, { initData: C });
  ok('a non-participant cannot settle it', stranger.status === 403 && stranger.body?.reason === 'not_participant', stranger.text);

  const wrongWinner = await after(16_000, () => post(rt, '/api/match/end', { matchId: id, winnerId: 'tg-9999' }, { initData: A }));
  ok('a winner outside the row is refused', wrongWinner.status === 400 && wrongWinner.body?.reason === 'bad_winner', wrongWinner.text);

  const unknown = await after(16_000, () => post(rt, '/api/match/end', { matchId: 'not-a-real-id', winnerId: SEAT_A }, { initData: A }));
  ok('an unknown id is 404', unknown.status === 404 && unknown.body?.reason === 'unknown_match', unknown.text);

  const won = await after(16_000, () => post(rt, '/api/match/end', { matchId: id, winnerId: SEAT_A, moves: 24 }, { initData: A }));
  ok('the same call after the floor is credited',
    won.status === 200 && won.body?.recorded === true, won.text);
  ok('a ranked win pays a ladder point', won.body?.tiq === 25, won.text);
  ok('the answer carries the seat\'s server-side total', won.body?.totalTiq === 25, won.text);
  ok('the loser is named, not scored', won.body?.won === true && won.body?.winnerId === SEAT_A, won.text);

  const replay = await post(rt, '/api/match/end', { matchId: id, winnerId: SEAT_A, moves: 24 }, { initData: A });
  ok('THE REPLAY IS REFUSED', replay.status === 409 && replay.body?.reason === 'not_active', replay.text);
  ok('and it pays nothing', replay.body?.recorded === false, replay.text);

  const afterReplay = await post(rt, '/api/match/end', { matchId: id, winnerId: SEAT_A }, { initData: A });
  ok('a third attempt is refused the same way', afterReplay.status === 409, afterReplay.text);
}

console.log('\n-- only pvp pays a ladder point --');
{
  const rt = runtime();
  const practice = await post(rt, '/api/match/start', { mode: 'ai' }, { initData: A });
  ok('a practice row opens with no rival', practice.status === 200, practice.text);
  const settled = await after(16_000, () => post(rt, '/api/match/end', {
    matchId: practice.body.matchId, winnerId: SEAT_A, moves: 30,
  }, { initData: A }));
  ok('the practice board settles', settled.status === 200 && settled.body?.recorded === true, settled.text);
  ok('an ai win pays NO ladder point', settled.body?.tiq === 0, settled.text);
  ok('but it does pay in currency', settled.body?.coins > 0, settled.text);
  ok('the seat\'s ladder total is untouched', settled.body?.totalTiq === 0, settled.text);

  const friendly = await post(rt, '/api/match/start', { mode: 'friendly', opponentId: SEAT_B }, { initData: A });
  const fSettled = await after(16_000, () => post(rt, '/api/match/end', {
    matchId: friendly.body.matchId, winnerId: SEAT_A,
  }, { initData: A }));
  ok('a friendly win settles', fSettled.status === 200, fSettled.text);
  ok('a friendly win pays NO ladder point', fSettled.body?.tiq === 0, fSettled.text);
}

console.log('\n-- the friendly allowance --');
{
  const rt = runtime();
  let credited = 0;
  for (let i = 0; i < 4; i++) {
    const started = await post(rt, '/api/match/start', { mode: 'friendly', opponentId: SEAT_B }, { initData: A });
    if (started.status !== 200) break;
    const settled = await after(16_000, () => post(rt, '/api/match/end', {
      matchId: started.body.matchId, winnerId: SEAT_A,
    }, { initData: A }));
    if (settled.status === 200) credited += 1;
  }
  ok('a pairing is paid for at most 2 friendly boards a day', credited === 2, `credited ${credited}`);
}

console.log('\n-- the registry only folds a settled row --');
{
  const rt = runtime();
  const bare = await post(rt, '/api/registry/match', {
    mode: 'pvp', result: 'W', userId: '1001', score: 9999, wins: 9999,
  }, { initData: A });
  ok('a report with no match id is refused', bare.status === 409 && bare.body?.reason === 'no_match_session', bare.text);
  ok('a client-asserted win is never folded in', bare.body?.recorded === false, bare.text);
}

console.log('\n-- the ranked row belongs to the room --');
{
  const rt = runtime();
  /* Two signed seats queue and pair, exactly as the Mini App's socket does. */
  const open = async (initData) => {
    const query = new URLSearchParams({
      initData, tiq: '0', tier: 'rookie', flag: '', name: 'P', wide: '0',
    });
    const res = await worker.fetch({
      url: `https://${HOST}/ws/matchmake?${query}`,
      headers: { get: (key) => (key.toLowerCase() === 'upgrade' ? 'websocket' : null) },
    }, rt.env);
    return { status: res.status, socket: res.webSocket };
  };
  const a = await open(A);
  const b = await open(B);
  ok('both seats take a socket', a.status === 101 && b.status === 101, `${a.status}/${b.status}`);

  a.socket.send(JSON.stringify({ type: 'QUEUE', wide: false }));
  b.socket.send(JSON.stringify({ type: 'QUEUE', wide: false }));

  const found = a.socket.received.map((raw) => JSON.parse(raw)).find((m) => m.type === 'MATCH_FOUND');
  ok('the pairing is announced', !!found, a.socket.received.join(','));
  ok('the frame withholds the rival\'s seat', found && found.opponent?.id === undefined, JSON.stringify(found?.opponent));

  const row = [...rt.lobby.matches.values()].find((r) => r.matchId === `pvp-${found.matchId}`);
  ok('the room opened the ranked row itself', !!row, [...rt.lobby.matches.keys()].join(','));
  ok('the row names both verified seats',
    row?.player1Id === SEAT_A && row?.player2Id === SEAT_B && row?.mode === 'pvp', JSON.stringify(row));
  ok('the row is open and unpaid', row?.status === 'active' && row?.reward.tiq === 0);

  /* An instant settlement — the scripted-socket case — records the board and pays nothing. */
  rt.lobby.verdict(SEAT_A, true, true, { mode: 'pvp', matchId: found.matchId, moves: 20, durationSec: 0 });
  ok('a sub-15-second room verdict pays no ladder point',
    rt.lobby.players.get(SEAT_A).tiq === 0, String(rt.lobby.players.get(SEAT_A).tiq));
  ok('but the row is settled', row?.status === 'completed');

  /* A second pairing, settled after the floor: the winner climbs, the loser does not. */
  const c = await open(C);
  const d = await open(initFor(4004, 'Mira'));
  c.socket.send(JSON.stringify({ type: 'QUEUE', wide: false }));
  d.socket.send(JSON.stringify({ type: 'QUEUE', wide: false }));
  const found2 = c.socket.received.map((raw) => JSON.parse(raw)).find((m) => m.type === 'MATCH_FOUND');
  ok('a second pairing is announced', !!found2, c.socket.received.join(','));

  const seatC = 'tg-3003';
  const seatD = 'tg-4004';
  await after(16_000, async () => {
    rt.lobby.verdict(seatC, true, true, { mode: 'pvp', matchId: found2.matchId, moves: 30, durationSec: 16 });
    rt.lobby.verdict(seatD, false, true, { mode: 'pvp', matchId: found2.matchId, moves: 30, durationSec: 16 });
  });
  ok('the ranked winner is paid a ladder point',
    rt.lobby.players.get(seatC)?.tiq === 25, JSON.stringify(rt.lobby.players.get(seatC)?.tiq));
  ok('the loser is paid nothing', rt.lobby.players.get(seatD)?.tiq === 0, JSON.stringify(rt.lobby.players.get(seatD)?.tiq));
  ok('the loser cannot re-settle the board',
    [...rt.lobby.matches.values()].find((r) => r.matchId === `pvp-${found2.matchId}`)?.winnerId === seatC,
    JSON.stringify([...rt.lobby.matches.values()].find((r) => r.matchId === `pvp-${found2.matchId}`)));

  for (const socket of [a.socket, b.socket, c.socket, d.socket]) {
    try { socket.close(); } catch { /* already gone */ }
  }
}

console.log('\n-- the open-row cap --');
{
  const rt = runtime();
  const opened = [];
  for (let i = 0; i < 4; i++) {
    const answer = await post(rt, '/api/match/start', { mode: 'ai' }, { initData: A });
    opened.push(answer);
  }
  ok('three open rows are allowed', opened.slice(0, 3).every((a) => a.status === 200),
    opened.map((a) => a.status).join(','));
  ok('the fourth is refused', opened[3].status === 429 && opened[3].body?.error === 'too_many_open_matches',
    opened[3].text);
}

console.log('\n-- the rate window --');
{
  const rt = runtime();
  /* The finish door's own allowance, spent with ids the room never minted: each answers 404 and
     costs one unit, which is exactly how a script hammering the endpoint would behave. */
  const statuses = [];
  for (let i = 0; i < 26; i++) {
    const answer = await post(rt, '/api/match/end', { matchId: `ghost-${i}`, winnerId: SEAT_A }, { initData: B });
    statuses.push(answer.status);
  }
  ok('the first 24 finishes are served', statuses.slice(0, 24).every((s) => s === 404), statuses.join(','));
  ok('the 25th is rate limited', statuses[24] === 429, statuses.join(','));
  const limited = await post(rt, '/api/match/end', { matchId: 'ghost-x', winnerId: SEAT_A }, { initData: B });
  ok('and the refusal says when to retry',
    limited.body?.error === 'rate_limited' && limited.body?.retryAfterMs > 0, limited.text);
  const other = await post(rt, '/api/match/start', { mode: 'ai' }, { initData: C });
  ok('another seat still has its own allowance', other.status === 200, other.text);
}

console.log(`\n${ran - failed}/${ran} checks passed`);
if (failed > 0) process.exit(1);
console.log('match session endpoint verification passed');
