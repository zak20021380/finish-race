/**
 * verify-referral-ledger.mjs — the referral ledger, driven through the real Worker in plain Node.
 *
 * The Worker is bundled exactly as wrangler ships it. A fake `REFERRALS` namespace wraps the real
 * `ReferralLedgerDO` over an in-memory store, and the Bot API is a recorder so `getChatMember`
 * membership is the only lever each scenario turns. This is the end-to-end proof of the rules:
 *
 *   - a fresh invitee's first contact binds PENDING, and the first gate check that sees them in
 *     the channel flips it to CREDITED in that same request: inviter +1 and both pools +500;
 *   - the same invitee passing again credits nothing;
 *   - a forged / unknown / malformed code is ignored without a crash;
 *   - a self-referral and an A→B→A loop credit nothing;
 *   - a user who existed before the link (bot `/start` or an earlier app open) is never an invitee;
 *   - `/start ref_<code>` in the bot chat and `?startapp=ref_<code>` in the Mini App resolve to the
 *     same pending row;
 *   - concurrent gate calls count one join, never two;
 *   - leaving the channel later does not claw the credit back;
 *   - the ledger survives a fresh object over the same storage.
 *
 *   node scripts/verify-referral-ledger.mjs
 */
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TOKEN = '12345:AAHreferral-test-token';
const HOST = 'finish-race.deadeye-game.workers.dev';
const CHANNEL = '@tactix_test_channel';

/* ---------- the Bot API, recorded rather than called ---------- */

let calls = [];
const members = new Set();

globalThis.fetch = async (url, init) => {
  const full = String(url);
  const method = full.split('/').pop() ?? '';
  const params = init?.body ? JSON.parse(init.body) : {};
  calls.push({ method, params });
  if (method === 'getChatMember') {
    const id = String(params.user_id ?? '');
    const status = members.has(id) ? 'member' : 'left';
    return { ok: true, status: 200, async json() { return { ok: true, result: { status } }; } };
  }
  return { ok: true, status: 200, async json() { return { ok: true, result: true }; } };
};

class FakeSocket {
  accept() {}
  send() {}
  close() {}
  addEventListener() {}
}
globalThis.WebSocketPair = class {
  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
  }
};

/* ---------- load the bundled worker ---------- */

const outfile = path.join(ROOT, '.tmp', 'worker-referrals.mjs');
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
const ReferralLedgerDO = workerModule.ReferralLedgerDO;
fs.rmSync(outfile, { force: true });

/* ---------- signed Mini App identity, built the documented way ---------- */

function signed(userId) {
  const fields = {
    auth_date: '1700000000',
    query_id: `AAH${userId}`,
    user: JSON.stringify({ id: userId, first_name: `P${userId}`, username: `p${userId}` }),
  };
  const rows = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(rows.join('\n')).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function mkRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  return {
    url,
    method,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    async json() { return body ?? {}; },
  };
}

/* ---------- a real ledger over an in-memory store ---------- */

function ledgerNamespace(env, store = new Map()) {
  const state = {
    id: { toString: () => 'global' },
    acceptWebSocket() {},
    getWebSockets() { return []; },
    blockConcurrencyWhile: (fn) => fn(),
    storage: {
      get: async (key) => store.get(key),
      put: async (key, value) => {
        if (key && typeof key === 'object') {
          for (const [name, row] of Object.entries(key)) store.set(name, row);
          return;
        }
        store.set(key, value);
      },
      delete: async (key) => { store.delete(key); },
      list: async (options = {}) => {
        const out = new Map();
        const prefix = options.prefix ?? '';
        for (const [key, value] of store) if (key.startsWith(prefix)) out.set(key, value);
        return out;
      },
    },
  };
  const ledger = new ReferralLedgerDO(state, env);
  return {
    namespace: {
      idFromName: () => ({ toString: () => 'global' }),
      get: () => ({ fetch: (request) => ledger.fetch(request) }),
    },
    makeAnother: () => new ReferralLedgerDO(state, env),
    store,
  };
}

function runtime() {
  const env = {
    DEV_AUTH: 'false',
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_WEBHOOK_SECRET: '',
    ADMIN_IDS: '',
    REQUIRED_CHANNEL: CHANNEL,
  };
  const { namespace, makeAnother } = ledgerNamespace(env);
  env.REFERRALS = namespace;
  const unused = () => ({ idFromName: (n) => ({ toString: () => n }), get: () => ({ fetch: () => { throw new Error('unrelated DO touched'); } }) });
  env.MATCHMAKER = unused();
  env.BADGES = unused();
  calls = [];
  const api = async (route, userId, { method = 'GET', body = null } = {}) => {
    const headers = { 'x-telegram-init-data': signed(userId) };
    const request = mkRequest(`https://${HOST}${route}`, { method, headers, body });
    const response = await worker.fetch(request, env);
    return { status: response.status, body: await response.json() };
  };
  const webhook = (update) => worker.fetch(
    mkRequest(`https://${HOST}/telegram/webhook`, { method: 'POST', body: update }),
    env,
  ).then(async (response) => ({ status: response.status, body: await response.json() }));
  return { env, api, webhook, makeAnother };
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

const CODE_RE = /^[a-z0-9]{12}$/;
const me = (rt, user) => rt.api('/api/referral/me', user);
const gate = (rt, user, ref) => rt.api('/api/referral/gate', user, { method: 'POST', body: { ref } });
const stateOf = (rt, code) => rt.api(`/referral/state?code=${encodeURIComponent(code)}`, 1);

console.log('\n-- identity: a permanent random code and the direct link --');
const rt = runtime();
const A = 1001;
const inviterBefore = await me(rt, A);
ok('the first open creates a code', inviterBefore.status === 200 && CODE_RE.test(inviterBefore.body.code ?? ''), JSON.stringify(inviterBefore.body));
ok('the link opens the Mini App directly with ref_<code>',
  inviterBefore.body.link === `https://t.me/Tactix_Robot/play?startapp=ref_${inviterBefore.body.code}`,
  inviterBefore.body.link);
ok('a fresh inviter starts at 0 friends and 0 coins',
  inviterBefore.body.joins === 0 && inviterBefore.body.earned === 0);
const again = await me(rt, A);
ok('the code is stable across reads', again.body.code === inviterBefore.body.code);
const codeA = inviterBefore.body.code;

console.log('\n-- a fresh invitee: pending, then instant credit at the gate --');
const B = 2002;
const pending = await gate(rt, B, `ref_${codeA}`);
ok('first contact binds PENDING without crediting', pending.status === 200
  && pending.body.joined === false && pending.body.pending === true && pending.body.earned === 0,
  JSON.stringify(pending.body));
let inviter = await me(rt, A);
ok('the inviter is not credited before the gate passes',
  inviter.body.joins === 0 && inviter.body.earned === 0, JSON.stringify(inviter.body));

members.add(String(B));
const credited = await gate(rt, B, '');
ok('the gate pass credits the invitee in the same response',
  credited.body.joined === true && credited.body.credited === true && credited.body.earned === 500,
  JSON.stringify(credited.body));
inviter = await me(rt, A);
ok('and the inviter +1 friend / +500 coins on the same response cycle',
  inviter.body.joins === 1 && inviter.body.earned === 500, JSON.stringify(inviter.body));
const publicState = await stateOf(rt, codeA);
ok('the public code-addressed read agrees',
  publicState.body.valid === true && publicState.body.joins === 1 && publicState.body.earned === 500,
  JSON.stringify(publicState.body));

console.log('\n-- idempotency: the same invitee twice --');
const twice = await gate(rt, B, '');
ok('a second gate pass credits nothing', twice.body.credited === false && twice.body.earned === 500, JSON.stringify(twice.body));
inviter = await me(rt, A);
ok('the inviter stays at one join', inviter.body.joins === 1 && inviter.body.earned === 500, JSON.stringify(inviter.body));

console.log('\n-- forged, unknown and malformed codes --');
const C = 3003;
members.add(String(C));
const forged = await gate(rt, C, 'ref_deadbeefdead');
ok('an unknown but well-formed code is ignored cleanly',
  forged.status === 200 && forged.body.pending === false && forged.body.credited === false,
  JSON.stringify(forged.body));
const malformed = await gate(rt, C, 'ref_zz');
ok('a malformed payload is ignored without a crash',
  malformed.status === 200 && malformed.body.credited === false, JSON.stringify(malformed.body));
inviter = await me(rt, A);
ok('the inviter never moved for a forged code', inviter.body.joins === 1, JSON.stringify(inviter.body));

console.log('\n-- self-referral and loops --');
members.add(String(A));
const self = await gate(rt, A, `ref_${codeA}`);
ok('an inviter opening their own link credits nothing',
  self.body.joined === true && self.body.credited === false && self.body.joins === 1,
  JSON.stringify(self.body));
const codeB = (await me(rt, B)).body.code;
await gate(rt, A, `ref_${codeB}`);
const bState = await me(rt, B);
ok('A→B→A cannot make B an inviter', bState.body.joins === 0, JSON.stringify(bState.body));

console.log('\n-- an existing user can never be a new invitee --');
const D = 4004;
await me(rt, D);
members.add(String(D));
const existing = await gate(rt, D, `ref_${codeA}`);
ok('a user who opened the app before the link credits nothing',
  existing.body.credited === false, JSON.stringify(existing.body));
const G = 7007;
await rt.webhook({
  message: {
    message_id: 1,
    chat: { id: G, type: 'private' },
    from: { id: G, language_code: 'en', is_bot: false, first_name: 'G' },
    text: '/start',
  },
});
members.add(String(G));
const botExisting = await gate(rt, G, `ref_${codeA}`);
ok('a user who existed in the bot before the link credits nothing',
  botExisting.body.credited === false, JSON.stringify(botExisting.body));
inviter = await me(rt, A);
ok('the inviter is still at one join', inviter.body.joins === 1, JSON.stringify(inviter.body));

console.log('\n-- the bot /start path and the Mini App path share attribution --');
const E = 6006;
await rt.webhook({
  message: {
    message_id: 2,
    chat: { id: E, type: 'private' },
    from: { id: E, language_code: 'en', is_bot: false, first_name: 'E' },
    text: `/start ref_${codeA}`,
  },
});
inviter = await me(rt, A);
ok('the bot chat only binds pending; it does not credit before the gate',
  inviter.body.joins === 1, JSON.stringify(inviter.body));
members.add(String(E));
const botLanded = await gate(rt, E, '');
ok('opening the Mini App after the bot /start credits the same invite',
  botLanded.body.credited === true && botLanded.body.earned === 500, JSON.stringify(botLanded.body));
inviter = await me(rt, A);
ok('the inviter is now at two joins', inviter.body.joins === 2 && inviter.body.earned === 1000, JSON.stringify(inviter.body));

console.log('\n-- concurrent gate passes --');
const F = 5005;
members.add(String(F));
const burst = await Promise.all(Array.from({ length: 6 }, () => gate(rt, F, `ref_${codeA}`)));
inviter = await me(rt, A);
ok('six concurrent passes credit exactly one join',
  inviter.body.joins === 3 && inviter.body.earned === 1500, JSON.stringify(inviter.body));
ok('exactly one response owns the credit',
  burst.filter((r) => r.body.credited === true).length === 1,
  JSON.stringify(burst.map((r) => r.body.credited)));

console.log('\n-- leaving the channel later --');
members.delete(String(B));
const left = await gate(rt, B, '');
inviter = await me(rt, A);
ok('a former member is no longer "joined"', left.body.joined === false, JSON.stringify(left.body));
ok('but the credit is not clawed back', inviter.body.joins === 3 && inviter.body.earned === 1500, JSON.stringify(inviter.body));

console.log('\n-- durability --');
const another = rt.makeAnother();
const revived = await another.fetch(new Request('https://referral.internal/lookup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: codeA }),
})).then((res) => res.json());
ok('a fresh object over the same storage still knows the ledger',
  revived.valid === true && revived.joins === 3 && revived.earned === 1500, JSON.stringify(revived));

console.log('\n-- public state is not an enumeration oracle --');
const guess = await stateOf(rt, 'u1001');
ok('the old enumerable id shape reads as invalid', guess.body.valid === false, JSON.stringify(guess.body));

console.log(`\n${ran - failed}/${ran} checks passed`);
if (failed > 0) process.exit(1);
console.log('referral ledger simulation passed');
