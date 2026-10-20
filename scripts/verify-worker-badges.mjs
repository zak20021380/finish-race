/**
 * verify-worker-badges.mjs — drives the real badge ledger in plain Node.
 *
 * The Worker and `BadgeMintDO` are bundled with the project's own esbuild and run for real;
 * only the Cloudflare runtime around them is faked: a Durable Object namespace that always
 * returns the same singleton, and an asynchronous in-memory store (so read/write pairs really
 * can interleave) with the one atomic `put(entries)` form the object relies on.
 *
 * The important assertion is the concurrent one: 80 players mint the 25-serial honor at once
 * and exactly 25 distinct serials come back. The rest must answer 409 CAP_EXHAUSTED.
 *
 *   node scripts/verify-worker-badges.mjs
 */
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TOKEN = '12345:AAHtest-token-for-the-badge-harness';
const CAPS = { churchill_bastion: 100, einstein_singularity: 50, heisenberg_formula: 25 };

/* ---------- bundle the real worker ---------- */

const outfile = path.join(ROOT, '.tmp', 'worker-badges.mjs');
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
const { BadgeMintDO } = mod;
fs.rmSync(outfile, { force: true });

/* ---------- an async in-memory Durable Object ---------- */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function runtime(vars = {}) {
  const env = {
    DEV_AUTH: vars.DEV_AUTH ?? 'false',
    TELEGRAM_BOT_TOKEN: vars.TELEGRAM_BOT_TOKEN,
    ADMIN_IDS: '',
  };
  const store = new Map();
  let badge = null;

  const boot = () => {
    const state = {
      id: { toString: () => 'global' },
      acceptWebSocket: () => {},
      getWebSockets: () => [],
      blockConcurrencyWhile: (cb) => cb(),
      storage: {
        async get(key) {
          await tick();
          return store.get(key);
        },
        async put(key, value) {
          await tick();
          if (key && typeof key === 'object') {
            for (const [k, v] of Object.entries(key)) store.set(k, v);
          } else {
            store.set(key, value);
          }
        },
        async list({ prefix = '', limit = 1000 } = {}) {
          await tick();
          const out = new Map();
          for (const [k, v] of store) {
            if (!k.startsWith(prefix)) continue;
            out.set(k, v);
            if (out.size >= limit) break;
          }
          return out;
        },
      },
    };
    badge = new BadgeMintDO(state, env);
  };
  boot();

  env.BADGES = {
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({ fetch: (request) => badge.fetch(request) }),
  };

  /** A whole new instance over the same storage — an eviction mid-test. */
  const restart = () => boot();

  const route = (pathname, init = {}, host = 'localhost:8787') =>
    worker.fetch(new Request(`http://${host}${pathname}`, init), env);

  return { env, route, restart, store };
}

function signed(fields, token = TOKEN) {
  const rows = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(rows.join('\n')).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const tgInit = (id, query = 'AAA') => signed({
  auth_date: '1700000000',
  user: JSON.stringify({ id, first_name: `Player ${id}`, username: `p${id}`, language_code: 'en' }),
  query_id: query,
});

function devHeaders(player) {
  const headers = { 'content-type': 'application/json' };
  if (player) headers['x-detour-dev-player'] = player;
  return headers;
}

const progress = (over = {}) => ({
  tiq: 1500,
  games: 5,
  wins: 4,
  streak: 0,
  best: 3,
  ...over,
});

async function sync(rt, player, body = progress()) {
  return rt.route('/api/badges/progress', {
    method: 'POST',
    headers: devHeaders(player),
    body: JSON.stringify(body),
  });
}

async function mint(rt, player, badgeId = 'churchill_bastion') {
  return rt.route('/api/badges/mint', {
    method: 'POST',
    headers: devHeaders(player),
    body: JSON.stringify({ badgeId }),
  });
}

async function supply(rt) {
  return rt.route('/api/badges/supply');
}

const read = async (res) => {
  const body = await res.json();
  return { status: res.status, body };
};

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

/* supply + CORS */
{
  const rt = runtime();
  const s = await read(await supply(rt));
  ok('GET /api/badges/supply answers 200', s.status === 200);
  ok('all three caps match the brief',
    s.body?.badges?.churchill_bastion?.cap === 100
    && s.body?.badges?.einstein_singularity?.cap === 50
    && s.body?.badges?.heisenberg_formula?.cap === 25,
    JSON.stringify(s.body));
  ok('every badge starts minted=0 and remaining=cap',
    Object.entries(CAPS).every(([id, cap]) =>
      s.body?.badges?.[id]?.minted === 0 && s.body?.badges?.[id]?.remaining === cap));

  const preflight = await rt.route('/api/badges/mint', {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:5173',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-telegram-init-data',
    },
  });
  ok('OPTIONS preflight answers 204 with CORS', preflight.status === 204
    && preflight.headers.get('access-control-allow-origin') === '*');
  ok('supply response carries CORS', (await supply(rt)).headers.get('access-control-allow-origin') === '*');
}

/* the Telegram door */
{
  const rt = runtime({ TELEGRAM_BOT_TOKEN: TOKEN });
  const noAuth = await rt.route('/api/badges/mint', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ badgeId: 'churchill_bastion' }),
  }, 'detour.example.com');
  ok('no initData on a real host answers 401', noAuth.status === 401);

  const forgedInit = tgInit(7).replace(/hash=[0-9a-f]+/, 'hash=deadbeef');
  const forged = await rt.route('/api/badges/mint', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-init-data': forgedInit },
    body: JSON.stringify({ badgeId: 'churchill_bastion' }),
  }, 'detour.example.com');
  ok('a forged Telegram signature answers 401', forged.status === 401);

  const forgedOnLoopback = await rt.route('/api/badges/mint', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-init-data': forgedInit },
    body: JSON.stringify({ badgeId: 'churchill_bastion' }),
  }, 'localhost:8787');
  ok('a forged signature is refused even on the dev host', forgedOnLoopback.status === 401);

  const good = tgInit(7);
  const noProgress = await rt.route('/api/badges/mint', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-init-data': good },
    body: JSON.stringify({ badgeId: 'churchill_bastion' }),
  }, 'detour.example.com');
  ok('a genuine signature reaches the ledger and is gated by criteria (403)', noProgress.status === 403);
}

/* criteria gate + progress ledger */
{
  const rt = runtime();
  const low = await read(await mint(rt, 'alice'));
  ok('minting before any progress answers 403', low.status === 403 && low.body?.error === 'CRITERIA_NOT_MET');

  await sync(rt, 'alice', progress({ best: 2, tiq: 1499, games: 4, wins: 4 }));
  const stillLow = await read(await mint(rt, 'alice'));
  ok('a below-threshold snapshot stays locked', stillLow.status === 403);

  await sync(rt, 'alice', progress({ best: 3, tiq: 1500, games: 5, wins: 3 }));
  const bastion = await read(await mint(rt, 'alice', 'churchill_bastion'));
  const singularity = await read(await mint(rt, 'alice', 'einstein_singularity'));
  const formula = await read(await mint(rt, 'alice', 'heisenberg_formula'));
  ok('best=3 mints the Bastion first', bastion.status === 200 && bastion.body?.serial === 1);
  ok('tiq=1500 mints the Singularity first', singularity.status === 200 && singularity.body?.serial === 1);
  ok('3/5 = 60% mints the Formula first', formula.status === 200 && formula.body?.serial === 1);

  await sync(rt, 'alice', progress({ best: 0, tiq: 0, games: 0, wins: 0 }));
  const again = await read(await mint(rt, 'alice', 'churchill_bastion'));
  ok('progress never moves backwards and a claimed badge stays claimed',
    again.status === 200 && again.body?.serial === 1);

  const shape = await read(await mint(rt, 'alice', 'churchill_bastion'));
  ok('the success payload is exactly the documented shape',
    Object.keys(shape.body).sort().join(',') === 'badgeId,cap,mintedAt,serial,success'
    && shape.body.badgeId === 'churchill_bastion'
    && shape.body.cap === 100
    && typeof shape.body.mintedAt === 'string'
    && !Number.isNaN(Date.parse(shape.body.mintedAt)),
    JSON.stringify(shape.body));

  const unknown = await read(await rt.route('/api/badges/mint', {
    method: 'POST', headers: devHeaders('alice'), body: JSON.stringify({ badgeId: 'not_a_badge' }),
  }));
  ok('an unknown badge id answers 400', unknown.status === 400);

  const hall = await read(await supply(rt));
  const holderRow = hall.body?.badges?.churchill_bastion?.holders;
  ok('supply publishes serial + holder name in the hall of fame',
    Array.isArray(holderRow) && holderRow.length === 1
    && holderRow[0]?.serial === 1 && holderRow[0]?.name === 'alice',
    JSON.stringify(holderRow));
  ok('the holder index never leaks the player id',
    JSON.stringify(holderRow).includes('guest-') === false);
}

/* the verified Telegram name reaches the public index (including non-Latin scripts) */
{
  const rt = runtime({ TELEGRAM_BOT_TOKEN: TOKEN });
  const init = signed({
    auth_date: '1700000000',
    user: JSON.stringify({ id: 9, first_name: 'Хайзенберг', language_code: 'ru' }),
    query_id: 'AAA',
  });
  const headers = { 'content-type': 'application/json', 'x-telegram-init-data': init };
  const host = 'detour.example.com';
  await rt.route('/api/badges/progress', {
    method: 'POST', headers, body: JSON.stringify(progress()),
  }, host);
  const minted = await read(await rt.route('/api/badges/mint', {
    method: 'POST', headers, body: JSON.stringify({ badgeId: 'heisenberg_formula' }),
  }, host));
  const s = await read(await supply(rt));
  const holder = s.body?.badges?.heisenberg_formula?.holders?.[0];
  ok('a verified Telegram name survives the edge header intact',
    minted.status === 200 && holder?.serial === 1 && holder?.name === 'Хайзенберг',
    JSON.stringify(holder));
}

/* idempotency */
{
  const rt = runtime();
  await sync(rt, 'bob');
  const one = await read(await mint(rt, 'bob'));
  const two = await read(await mint(rt, 'bob'));
  ok('the same player gets the same serial twice', one.status === 200 && two.status === 200
    && one.body.serial === two.body.serial && one.body.mintedAt === two.body.mintedAt);
  const s = await read(await supply(rt));
  ok('an idempotent retry does not advance the counter', s.body.badges.churchill_bastion.minted === 1);

  const ten = await Promise.all(Array.from({ length: 10 }, () => mint(rt, 'bob')));
  const bodies = await Promise.all(ten.map((r) => r.json()));
  ok('ten concurrent retries from one player all return that one serial',
    bodies.every((b) => b.serial === one.body.serial) && bodies.length === 10);
  const after = await read(await supply(rt));
  ok('the counter still reads 1 after the concurrent retries', after.body.badges.churchill_bastion.minted === 1);

  await sync(rt, 'carol');
  const next = await read(await mint(rt, 'carol'));
  ok('a different player gets the next serial', next.status === 200 && next.body.serial === one.body.serial + 1);
}

/* cap exhaustion + concurrency */
{
  const rt = runtime();
  const players = Array.from({ length: 80 }, (_, i) => `p${i}`);
  await Promise.all(players.map((p) => sync(rt, p, progress({ games: 5, wins: 5, best: 3 }))));

  const results = await Promise.all(players.map((p) => mint(rt, p, 'heisenberg_formula')));
  const bodies = await Promise.all(results.map((r) => r.json()));
  const winners = results.map((r, i) => ({ status: r.status, body: bodies[i] })).filter((r) => r.status === 200);
  const losers = results.filter((r) => r.status === 409);
  const serials = winners.map((r) => r.body.serial).sort((a, b) => a - b);

  ok('80 concurrent mints against a cap of 25 produce exactly 25 winners', winners.length === 25,
    `${winners.length} winners`);
  ok('every loser answers 409 CAP_EXHAUSTED',
    losers.length === 55 && bodies.filter((_, i) => results[i].status === 409).every((b) => b.error === 'CAP_EXHAUSTED'));
  ok('the 25 serials are unique and sequential, 1..25',
    serials.length === 25 && serials.every((n, i) => n === i + 1), serials.join(','));
  ok('no serial exceeds the cap', serials.every((n) => n >= 1 && n <= CAPS.heisenberg_formula));

  const s = await read(await supply(rt));
  ok('supply reports 25 minted / 0 remaining', s.body.badges.heisenberg_formula.minted === 25
    && s.body.badges.heisenberg_formula.remaining === 0);

  const hall = s.body.badges.heisenberg_formula.holders;
  ok('the hall of fame lists exactly the 25 winning holders, in serial order',
    Array.isArray(hall) && hall.length === 25
    && hall.every((h, i) => h.serial === i + 1 && typeof h.name === 'string' && h.name.length > 0),
    JSON.stringify(hall?.slice(-3)));

  const winner = winners[0].body;
  const holder = players[results.findIndex((r) => r.status === 200)];
  const retry = await read(await mint(rt, holder, 'heisenberg_formula'));
  ok('an existing holder still gets their serial after the cap fills',
    retry.status === 200 && retry.body.serial === winner.serial);

  await sync(rt, 'late');
  const late = await read(await mint(rt, 'late', 'heisenberg_formula'));
  ok('a late eligible player is refused with 409, not a serial', late.status === 409
    && late.body.cap === 25 && late.body.minted === 25);

  const other = await read(await mint(rt, 'late', 'churchill_bastion'));
  ok('an exhausted honor does not block the other editions', other.status === 200);
}

/* an eviction keeps the ledger */
{
  const rt = runtime();
  await sync(rt, 'dora');
  const first = await read(await mint(rt, 'dora'));
  rt.restart();
  const s = await read(await supply(rt));
  const retry = await read(await mint(rt, 'dora'));
  ok('counters survive an eviction', s.body.badges.churchill_bastion.minted === 1);
  ok('claims survive an eviction', retry.status === 200 && retry.body.serial === first.body.serial);
  ok('the holder index survives an eviction',
    s.body.badges.churchill_bastion.holders?.[0]?.serial === 1
    && s.body.badges.churchill_bastion.holders?.[0]?.name === 'dora');

  /* a ledger minted before the holder index existed: delete the index, evict, rebuild */
  rt.store.delete('badge:holders:churchill_bastion');
  rt.restart();
  const rebuilt = await read(await supply(rt));
  const rows = rebuilt.body.badges.churchill_bastion.holders;
  ok('a pre-index ledger rebuilds its hall from the claims',
    Array.isArray(rows) && rows.length === 1 && rows[0].serial === 1 && rows[0].name === 'Unlisted',
    JSON.stringify(rows));
}

/* ---------- summary ---------- */

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
console.log('\n' + '─'.repeat(52));
console.log(failed === 0
  ? green(`All ${ran} badge checks passed.`)
  : red(`${failed} of ${ran} badge checks failed.`));
if (failed > 0) process.exit(1);
