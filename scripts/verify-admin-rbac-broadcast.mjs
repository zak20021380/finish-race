/**
 * verify-admin-rbac-broadcast.mjs — the Command Center's newest muscles, driven end to end.
 *
 * Two halves, one story: an operator appoints an admin, and an announcement reaches a device.
 *
 *   Part 1 — the room. `npm run build` proves both sides type-check; this bundles the real
 *   `worker/index.ts` (the same code wrangler ships), stubs the Cloudflare globals, and walks
 *   every promise the role registry and the broadcast engine make:
 *     - the edge authenticates, the room authorizes: a signed stranger stays out (`403`),
 *       a root id from `ADMIN_IDS` is in, and the registry rows the ACL reads are seeded;
 *     - appointments: grant by numeric id and by @handle, re-role, and every guard the panel
 *       reports — `invalid_id`, `invalid_role`, `root_admin`, `no_such_admin`, `last_superadmin`;
 *     - the widened door: an appointed Moderator signs in and reads (status, directory, registry,
 *       history) while every command (`config`, `action`, `player`, `grant`, `revoke`, `create`,
 *       `archive`) answers `403` until the root re-roles them to SuperAdmin — and `403` again
 *       the moment they are demoted or revoked;
 *     - the broadcast engine: every validation code, every clamp (title/body/CTA), audience
 *       normalisation, urgent-before-feed ordering on the public feed, the 60-second cache
 *       header, archive/restore round-trips, and the 500-row history ceiling.
 *
 *   Part 2 — the device. The built `./dist` is served over 127.0.0.1 behind a stateful mock
 *   Worker, and a stubbed Telegram session (initData, no user) walks the player path:
 *     - an urgent announcement on the public feed raises `#modal-announcement` on boot, and
 *       Dismiss remembers the id in `dismissed_announcements` — a reload is not asked again;
 *     - a feed announcement lands in the notification centre exactly once across reloads;
 *     - the Controls tab lists the registry, grants a new admin through the drawer, and revokes
 *       through the confirm dialog; the Inbox composer previews a draft and dispatches it, the
 *       urgent one popping on the spot, the archived one retracting from the feed;
 *     - layout holds at 360x640 and 430x932: zero page scroll, zero horizontal overflow;
 *     - zero console errors across the whole run.
 *
 * Run: node scripts/verify-admin-rbac-broadcast.mjs   (playwright-core resolved at runtime)
 */
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DIST = path.join(ROOT, 'dist');
const SHOTS = path.join(ROOT, '.shots');
const TOKEN = '12345:AAHtest-token-for-the-rbac-harness';
const ADMIN_IDS = '1000001';
const ROOT_ADMIN = 1000001;
const MODERATOR = 9001;
const STRANGER = 777;
const HOST = 'detour.example.com';

let failed = 0;
let ran = 0;
function ok(label, condition, detail = '') {
  ran++;
  if (condition) console.log(`  ok  ${label}`);
  else {
    failed++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ==================================================================== *
 * PART 1 — the room: worker/index.ts + the real MatchmakerDO in Node
 * ==================================================================== */

/* ---------- the Cloudflare globals the worker touches ---------- */

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
    const client = { send() {}, close() {}, accept() {} };
    const server = { send() {}, close() {}, accept() {} };
    this[0] = client;
    this[1] = server;
  }
};
globalThis.Response = FakeResponse;

const outfile = path.join(ROOT, '.tmp', 'worker-rbac.mjs');
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

/** The slice of `Request` the worker reads: url, method, headers, body. */
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

const call = (rt, route, { method = 'GET', body = null, headers = {}, host = HOST } = {}) =>
  rt.route(`http://${host}${route}`, { method, body, headers });

const bodyOf = (res) => JSON.parse(res.body);
const DEV = { 'x-admin': '1' };
const dev = (rt, route, opts = {}) => call(rt, route, { headers: DEV, ...opts });
const post = (rt, route, body, headers = DEV) => call(rt, route, { method: 'POST', body, headers });

/** A properly signed Telegram initData, built the documented way. */
function signed(fields, token = TOKEN) {
  const rows = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(rows.join('\n')).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const user = (id, first_name, username) => ({ id, first_name, username, language_code: 'en' });
const initFor = (id) => signed({ auth_date: '1700000000', user: JSON.stringify(user(id, 'Boss', 'boss')), query_id: `Q${id}` });
const as = (id) => ({ 'x-telegram-init-data': initFor(id) });

const draft = (over = {}) => ({
  title: 'Server maintenance at 22:00 UTC',
  body: 'The arena closes for **20 minutes**.',
  ctaLabel: '',
  ctaTarget: '',
  audienceKind: 'all',
  audienceValue: '',
  priority: 'urgent',
  ...over,
});

/* ---------- 1. the door: authentication at the edge, membership in the room ---------- */

console.log('\n-- the registry door --');
{
  const rt = runtime({ DEV_AUTH: 'true', TELEGRAM_BOT_TOKEN: TOKEN, ADMIN_IDS });

  ok('anonymous /api/admin/roles is refused with 403',
    (await call(rt, '/api/admin/roles')).status === 403);
  ok('and the refusal names the reason',
    bodyOf(await call(rt, '/api/admin/roles')).error === 'forbidden');

  const forged = initFor(ROOT_ADMIN).replace(/hash=[0-9a-f]+/, 'hash=deadbeef');
  ok('a forged signature is refused before the room is touched',
    (await call(rt, '/api/admin/roles', { headers: { 'x-telegram-init-data': forged } })).status === 403);

  const stranger = await call(rt, '/api/admin/roles', { headers: as(STRANGER) });
  ok('a signed stranger (not on the registry) is refused with 403', stranger.status === 403, `status ${stranger.status}`);
  ok('the stranger cannot even read /admin/status',
    (await call(rt, '/admin/status', { headers: as(STRANGER) })).status === 403);

  const root = await call(rt, '/api/admin/roles', { headers: as(ROOT_ADMIN) });
  const view = bodyOf(root);
  ok('a signed root is let in (200)', root.status === 200, `status ${root.status}`);
  ok('the view names the caller', view.me === String(ROOT_ADMIN), JSON.stringify(view));
  ok('the root may command (super true)', view.super === true);
  ok('the allowlist seeded one root row, unrevocable',
    view.admins.length === 1 && view.admins[0].id === String(ROOT_ADMIN)
      && view.admins[0].root === true && view.admins[0].role === 'superadmin',
    JSON.stringify(view.admins));
  ok('both roles are offered', Array.isArray(view.roles)
    && view.roles.includes('superadmin') && view.roles.includes('moderator'));

  const devView = bodyOf(await dev(rt, '/api/admin/roles'));
  ok('the dev door reads the same view', devView.ok === true && devView.super === true);

  ok('the public feed answers anonymously',
    (await call(rt, '/api/client/announcements/active')).status === 200);
  ok('an unknown api route answers 404 once you are in',
    (await call(rt, '/api/admin/nope', { headers: as(ROOT_ADMIN) })).status === 404);
}

/* ---------- 2. appointments: the ACL the Controls tab drives ---------- */

console.log('\n-- appointments --');
{
  const rt = runtime({ DEV_AUTH: 'true', TELEGRAM_BOT_TOKEN: TOKEN, ADMIN_IDS });
  const roleOf = async (id) => {
    const view = bodyOf(await dev(rt, '/api/admin/roles'));
    return view.admins?.find((a) => a.id === id) ?? null;
  };

  const granted = await post(rt, '/api/admin/roles/grant', { id: '424242', role: 'moderator' });
  ok('grant by numeric id answers ok', granted.status === 200 && bodyOf(granted).ok === true, granted.body);
  const row = await roleOf('424242');
  ok('the row is appointed, not a root, and carries who appointed it',
    row && row.role === 'moderator' && row.root === false && row.addedBy === 'dev', JSON.stringify(row));

  const handle = await post(rt, '/api/admin/roles/grant', { id: '@Helper', role: 'moderator' });
  ok('grant by @handle answers ok', handle.status === 200, handle.body);
  const hRow = await roleOf('@helper');
  ok('the handle is normalised to lower case', !!hRow, JSON.stringify(await roleOf('@Helper')));

  const up = await post(rt, '/api/admin/roles/grant', { id: '@helper', role: 'superadmin' });
  ok('re-granting moves the role in place', bodyOf(up).admin?.role === 'superadmin');
  ok('the re-grant kept the original appointment time',
    bodyOf(up).admin?.addedAt === hRow.addedAt);

  const badId = await post(rt, '/api/admin/roles/grant', { id: 'not a telegram id', role: 'moderator' });
  ok('a malformed id is refused with the panel\'s own code',
    badId.status === 400 && bodyOf(badId).error === 'invalid_id', badId.body);
  const badRole = await post(rt, '/api/admin/roles/grant', { id: '424242', role: 'admin' });
  ok('an unknown role is refused', badRole.status === 400 && bodyOf(badRole).error === 'invalid_role');

  const downgradeRoot = await post(rt, '/api/admin/roles/grant', { id: ADMIN_IDS, role: 'moderator' });
  ok('a root cannot be re-roled down',
    downgradeRoot.status === 400 && bodyOf(downgradeRoot).error === 'root_admin', downgradeRoot.body);

  const revokeMissing = await post(rt, '/api/admin/roles/revoke', { id: '55555' });
  ok('revoking somebody never appointed is refused',
    revokeMissing.status === 400 && bodyOf(revokeMissing).error === 'no_such_admin');
  const revokeRoot = await post(rt, '/api/admin/roles/revoke', { id: ADMIN_IDS });
  ok('revoking a root is refused',
    revokeRoot.status === 400 && bodyOf(revokeRoot).error === 'root_admin');

  const revoked = await post(rt, '/api/admin/roles/revoke', { id: '@helper' });
  ok('an appointed admin is revoked', revoked.status === 200 && bodyOf(revoked).ok === true);
  ok('and the registry no longer carries them', (await roleOf('@helper')) === null);

  /* the last SuperAdmin never leaves — an empty allowlist makes the registry the only source */
  const lonely = runtime({ DEV_AUTH: 'true', TELEGRAM_BOT_TOKEN: TOKEN, ADMIN_IDS: '' });
  await post(lonely, '/api/admin/roles/grant', { id: '6001', role: 'superadmin' });
  const last = await post(lonely, '/api/admin/roles/revoke', { id: '6001' });
  ok('the last SuperAdmin cannot be revoked',
    last.status === 400 && bodyOf(last).error === 'last_superadmin', last.body);
}

/* ---------- 3. the role matrix: a Moderator reads, a SuperAdmin commands ---------- */

console.log('\n-- the role matrix --');
{
  const rt = runtime({ TELEGRAM_BOT_TOKEN: TOKEN, ADMIN_IDS });
  const signedIn = (id) => ({ headers: as(id) });

  await call(rt, '/api/admin/roles/grant', {
    method: 'POST', body: { id: String(MODERATOR), role: 'moderator' }, headers: as(ROOT_ADMIN),
  });

  const me = bodyOf(await call(rt, '/api/admin/roles', signedIn(MODERATOR)));
  ok('an appointed Moderator signs in and is told what they are',
    me.ok === true && me.me === String(MODERATOR) && me.super === false, JSON.stringify(me));

  ok('a Moderator reads the live room', (await call(rt, '/admin/status', signedIn(MODERATOR))).status === 200);
  ok('a Moderator reads the directory', (await call(rt, '/admin/players', signedIn(MODERATOR))).status === 200);
  ok('a Moderator reads the history', (await call(rt, '/api/admin/broadcasts', signedIn(MODERATOR))).status === 200);

  const commands = [
    ['/admin/config', {}],
    ['/admin/action', { action: 'CLEAR_QUEUE' }],
    ['/admin/player', { id: 'x', action: 'BAN' }],
    ['/api/admin/roles/grant', { id: '777', role: 'moderator' }],
    ['/api/admin/roles/revoke', { id: '424242' }],
    ['/api/admin/broadcasts/create', draft()],
    ['/api/admin/broadcasts/bc-nope/archive', { archived: true }],
  ];
  for (const [route, body] of commands) {
    const res = await call(rt, route, {
      method: 'POST', body, headers: as(MODERATOR),
    });
    ok(`a Moderator is refused ${route}`,
      res.status === 403 && bodyOf(res).hint === 'superadmin required', res.body);
  }

  /* the root re-roles them: the same door, the same signature, a different verdict */
  await call(rt, '/api/admin/roles/grant', {
    method: 'POST', body: { id: String(MODERATOR), role: 'superadmin' }, headers: as(ROOT_ADMIN),
  });
  const promoted = await call(rt, '/admin/config', { method: 'POST', body: {}, headers: as(MODERATOR) });
  ok('promoted to SuperAdmin, the same command goes through',
    promoted.status === 200 && bodyOf(promoted).ok === true, promoted.body);
  const created = await call(rt, '/api/admin/broadcasts/create', {
    method: 'POST', body: draft({ title: 'From the promoted admin' }), headers: as(MODERATOR),
  });
  ok('and a promoted SuperAdmin may dispatch', created.status === 200, created.body);

  await call(rt, '/api/admin/roles/grant', {
    method: 'POST', body: { id: String(MODERATOR), role: 'moderator' }, headers: as(ROOT_ADMIN),
  });
  ok('demoted again, the command is refused again',
    (await call(rt, '/admin/config', { method: 'POST', body: {}, headers: as(MODERATOR) })).status === 403);

  await call(rt, '/api/admin/roles/revoke', {
    method: 'POST', body: { id: String(MODERATOR) }, headers: as(ROOT_ADMIN),
  });
  ok('revoked, the whole panel is refused',
    (await call(rt, '/api/admin/roles', signedIn(MODERATOR))).status === 403
      && (await call(rt, '/admin/status', signedIn(MODERATOR))).status === 403);
}

/* ---------- 4. the broadcast engine ---------- */

console.log('\n-- the broadcast engine --');
{
  const rt = runtime({ DEV_AUTH: 'true' });
  const create = (body) => post(rt, '/api/admin/broadcasts/create', body);
  const view = async () => bodyOf(await dev(rt, '/api/admin/broadcasts'));
  const feed = async () => bodyOf(await call(rt, '/api/client/announcements/active'));

  /* validation */
  const cases = [
    [{ title: '', body: 'x' }, 'missing_title'],
    [{ title: 'x', body: '' }, 'missing_body'],
    [draft({ audienceKind: 'country', audienceValue: 'USA' }), 'invalid_country'],
    [draft({ audienceKind: 'country', audienceValue: '1X' }), 'invalid_country'],
    [draft({ audienceKind: 'minLevel', audienceValue: '0' }), 'invalid_level'],
    [draft({ audienceKind: 'minLevel', audienceValue: '1000' }), 'invalid_level'],
    [draft({ audienceKind: 'minLevel', audienceValue: 'ten' }), 'invalid_level'],
    [draft({ ctaLabel: 'Open', ctaTarget: '' }), 'incomplete_cta'],
    [draft({ ctaLabel: '', ctaTarget: 'shop' }), 'incomplete_cta'],
  ];
  for (const [body, error] of cases) {
    const res = await create(body);
    ok(`the engine refuses ${JSON.stringify(error)}`,
      res.status === 400 && bodyOf(res).error === error, res.body);
  }

  /* clamps and normalisation */
  const clamped = bodyOf(await create(draft({
    title: 'T'.repeat(120),
    body: 'B'.repeat(700),
    ctaLabel: 'C'.repeat(40),
    ctaTarget: 'https://example.com/' + 'x'.repeat(400),
    audienceKind: 'country',
    audienceValue: 'us',
    priority: 'loud',
  }))).broadcast;
  ok('a title is clamped to 80', clamped.title.length === 80, String(clamped.title.length));
  ok('a body is clamped to 600', clamped.body.length === 600, String(clamped.body.length));
  ok('a CTA label is clamped to 24', clamped.ctaLabel.length === 24);
  ok('a CTA target is clamped to 200', clamped.ctaTarget.length === 200);
  ok('a country code is normalised to upper case', clamped.audience.value === 'US', JSON.stringify(clamped.audience));
  ok('the id carries the bc prefix', /^bc-[0-9a-z]+-[0-9a-z]{6}$/.test(clamped.id), clamped.id);
  ok('an unknown priority falls back to urgent', clamped.priority === 'urgent');
  ok('a dispatch is created by its caller and starts active',
    clamped.createdBy === 'dev' && clamped.status === 'active' && clamped.archivedAt === 0);

  /* ordering on the public feed: urgent first, newest first within a band */
  const sleep = () => new Promise((r) => setTimeout(r, 3));
  const a = bodyOf(await create(draft({ title: 'Urgent A' }))).broadcast;
  await sleep();
  const b = bodyOf(await create(draft({ title: 'Urgent B' }))).broadcast;
  await sleep();
  const c = bodyOf(await create(draft({ title: 'Feed C', priority: 'feed' }))).broadcast;
  const publicFeed = await call(rt, '/api/client/announcements/active');
  const list = bodyOf(publicFeed).announcements.map((x) => x.title);
  ok('the public feed sorts urgent before feed, newest first',
    list.indexOf('Urgent B') < list.indexOf('Urgent A')
      && list.indexOf('Urgent A') < list.indexOf('Feed C'),
    JSON.stringify(list));
  ok('the public feed carries the 60-second cache header',
    publicFeed.headers.get('cache-control') === 'public, max-age=60',
    String(publicFeed.headers.get('cache-control')));
  ok('the feed names its own clock', typeof bodyOf(publicFeed).now === 'number');

  /* archive, restore, and the feed reacting */
  const archived = await post(rt, `/api/admin/broadcasts/${encodeURIComponent(b.id)}/archive`, { archived: true });
  ok('archiving flips the status and stamps the time',
    bodyOf(archived).broadcast.status === 'archived' && bodyOf(archived).broadcast.archivedAt > 0);
  const feedAfter = (await feed()).announcements.map((x) => x.id);
  ok('an archived announcement leaves the public feed', !feedAfter.includes(b.id));
  const inside = (await view()).broadcasts.some((x) => x.id === b.id);
  ok('but stays in the history for the panel', inside);

  const restored = await post(rt, `/api/admin/broadcasts/${encodeURIComponent(b.id)}/archive`, { archived: false });
  ok('restoring brings it back with no archive stamp',
    bodyOf(restored).broadcast.status === 'active' && bodyOf(restored).broadcast.archivedAt === 0);
  ok('and it is live on the public feed again',
    (await feed()).announcements.some((x) => x.id === b.id));

  const ghost = await post(rt, '/api/admin/broadcasts/bc-ghost/archive', { archived: true });
  ok('archiving a broadcast that is not there is refused',
    ghost.status === 400 && bodyOf(ghost).error === 'no_such_broadcast', ghost.body);
  ok('the history view counts the live ones',
    (await view()).active === (await view()).broadcasts.filter((x) => x.status === 'active').length);

  /* the ceiling: 500 rows, and the oldest archived fall off the end */
  for (let i = 0; i < 501; i++) {
    const made = bodyOf(await create(draft({ title: `bulk ${i}` }))).broadcast;
    await post(rt, `/api/admin/broadcasts/${encodeURIComponent(made.id)}/archive`, { archived: true });
  }
  const bulk = await view();
  ok('the history never grows past 500 rows', bulk.broadcasts.length === 500, String(bulk.broadcasts.length));
  ok('the newest dispatch survives the prune',
    bulk.broadcasts.some((x) => x.title === 'bulk 500'), 'bulk 500 missing');
  ok('the oldest archived fell off the end',
    !bulk.broadcasts.some((x) => x.title === 'bulk 0'), 'bulk 0 still present');
}

console.log(`\n${ran - failed}/${ran} room checks passed`);

/* ==================================================================== *
 * PART 2 — the device: the built dist behind a stateful mock Worker
 * ==================================================================== */

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error(
    'playwright-core not found. Run with NODE_PATH pointing at a temp install, e.g.:\n' +
      '  NODE_PATH="C:\\Users\\PC-Y\\AppData\\Local\\Temp\\opencode\\check\\node_modules" node scripts/verify-admin-rbac-broadcast.mjs',
  );
  process.exit(2);
}

const now = Date.now();
const FEED_URGENT = {
  id: 'bc-feed-000001', title: 'Server maintenance at 22:00 UTC',
  body: 'The arena closes for **20 minutes**.', ctaLabel: '', ctaTarget: '',
  audience: { kind: 'all', value: '' }, priority: 'urgent', status: 'active',
  createdAt: now - 60_000, createdBy: '1', archivedAt: 0,
};
const FEED_QUIET = {
  id: 'bc-feed-000002', title: 'Season rewards are live',
  body: 'Check the shop for the new *clay* crates.', ctaLabel: '', ctaTarget: '',
  audience: { kind: 'all', value: '' }, priority: 'feed', status: 'active',
  createdAt: now - 120_000, createdBy: '1', archivedAt: 0,
};

/** The stateful mock Worker: the room's shapes, held in one object the checks can read back. */
function mockState() {
  return {
    roles: [
      { id: '1', name: 'Admin 1', username: 'root', role: 'superadmin', addedAt: now - 86_400_000, addedBy: 'ADMIN_IDS', root: true },
      { id: '@helper', name: 'helper', username: 'helper', role: 'moderator', addedAt: now - 3_600_000, addedBy: '1', root: false },
    ],
    broadcasts: [FEED_URGENT, FEED_QUIET],
    serial: 1,
    posts: [],
  };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

function serve(state) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(String(req.url).split('?')[0]);
      if (p === '/') p = '/index.html';
      if (p === '/favicon.ico') { res.writeHead(200, { 'Content-Type': 'image/x-icon' }); res.end(); return; }

      const send = (code, body, headers = {}) => {
        res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      const read = (cb) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          let body = {};
          try { body = raw ? JSON.parse(raw) : {}; } catch { /* empty */ }
          cb(body);
        });
      };

      if (p === '/admin/status' && req.method === 'GET') {
        return send(200, {
          ok: true, queueCount: 0, activeMatchesCount: 0, queuedPlayers: [], activeRooms: [],
          config: { maintenance: false, normalRadius: 250, wideRadius: 600 },
        });
      }
      if ((p === '/admin/config' || p === '/admin/action') && req.method === 'POST') {
        return read(() => send(200, { ok: true, config: { maintenance: false, normalRadius: 250, wideRadius: 600 } }));
      }
      if (p === '/admin/players' && req.method === 'GET') {
        return send(200, { ok: true, players: [], total: 0, limit: 20, offset: 0 });
      }
      if (p === '/api/admin/roles' && req.method === 'GET') {
        return send(200, { ok: true, admins: state.roles, roles: ['superadmin', 'moderator'], me: '1', super: true });
      }
      if (p === '/api/admin/roles/grant' && req.method === 'POST') {
        return read((body) => {
          state.posts.push({ route: p, body });
          const id = String(body.id ?? '').toLowerCase();
          const role = body.role === 'superadmin' ? 'superadmin' : 'moderator';
          const existing = state.roles.find((r) => r.id === id);
          if (existing) existing.role = role;
          else state.roles.push({
            id, name: /^@/.test(id) ? id.slice(1) : `Admin ${id.slice(0, 6)}`, username: /^@/.test(id) ? id.slice(1) : '',
            role, addedAt: Date.now(), addedBy: '1', root: false,
          });
          send(200, { ok: true });
        });
      }
      if (p === '/api/admin/roles/revoke' && req.method === 'POST') {
        return read((body) => {
          state.posts.push({ route: p, body });
          const id = String(body.id ?? '').toLowerCase();
          const at = state.roles.findIndex((r) => r.id === id);
          if (at < 0) return send(400, { ok: false, error: 'no_such_admin' });
          state.roles.splice(at, 1);
          send(200, { ok: true });
        });
      }
      if (p === '/api/admin/broadcasts' && req.method === 'GET') {
        const live = state.broadcasts.filter((b) => b.status === 'active').length;
        return send(200, { ok: true, broadcasts: [...state.broadcasts].reverse(), active: live });
      }
      if (p === '/api/admin/broadcasts/create' && req.method === 'POST') {
        return read((body) => {
          state.posts.push({ route: p, body });
          const row = {
            id: `bc-e2e-${String(state.serial++).padStart(6, '0')}`,
            title: String(body.title ?? '').slice(0, 80),
            body: String(body.body ?? '').slice(0, 600),
            ctaLabel: String(body.ctaLabel ?? '').slice(0, 24),
            ctaTarget: String(body.ctaTarget ?? '').slice(0, 200),
            audience: { kind: body.audienceKind ?? 'all', value: String(body.audienceValue ?? '') },
            priority: body.priority === 'feed' ? 'feed' : 'urgent',
            status: 'active', createdAt: Date.now(), createdBy: '1', archivedAt: 0,
          };
          state.broadcasts.push(row);
          send(200, { ok: true, broadcast: row });
        });
      }
      const flip = /^\/api\/admin\/broadcasts\/([^/]+)\/archive$/.exec(p);
      if (flip && req.method === 'POST') {
        return read((body) => {
          state.posts.push({ route: p, body });
          const row = state.broadcasts.find((b) => b.id === decodeURIComponent(flip[1]));
          if (!row) return send(400, { ok: false, error: 'no_such_broadcast' });
          const archived = body.archived !== false;
          row.status = archived ? 'archived' : 'active';
          row.archivedAt = archived ? Date.now() : 0;
          send(200, { ok: true, broadcast: row });
        });
      }
      if (p === '/api/client/announcements/active' && req.method === 'GET') {
        return send(200, {
          ok: true,
          announcements: state.broadcasts.filter((b) => b.status === 'active'),
          now: Date.now(),
        }, { 'cache-control': 'public, max-age=60' });
      }

      const fp = path.join(DIST, p.slice(1));
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/** Telegram stub with a session (initData) but no user: the dev door is open and the feed is asked. */
const TG_STUB = `
  window.__tgCalls = [];
  const push = (...a) => window.__tgCalls.push(a);
  const stub = window.Telegram?.WebApp || {};
  stub.ready = () => {};
  stub.expand = () => {};
  stub.disableVerticalSwipes = () => {};
  stub.setHeaderColor = () => {};
  stub.setBackgroundColor = () => {};
  stub.setColorScheme = () => {};
  stub.isVersionAtLeast = () => true;
  stub.version = '7.2';
  stub.platform = 'ios';
  stub.initData = 'user=%7B%22id%22%3A1%2C%22first_name%22%3A%22Harness%22%7D&hash=stub';
  stub.openTelegramLink = (u) => push('tglink', u);
  stub.openLink = (u) => push('link', u);
  stub.HapticFeedback = {
    impactOccurred: (s) => push('impact', s),
    notificationOccurred: (t) => push('notify', t),
    selectionChanged: () => {},
  };
  try { Object.defineProperty(window, 'Telegram', { value: { WebApp: stub }, writable: false, configurable: false }); }
  catch { window.Telegram = { WebApp: stub }; }
`;

const errors = [];
function watch(pg, label) {
  pg.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  pg.on('response', (r) => { if (r.status() === 404) errors.push(`${label} 404: ${r.url()}`); });
}

async function main() {
  const state = mockState();
  const srv = await serve(state);
  const port = srv.address().port;
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox'],
  });
  fs.mkdirSync(SHOTS, { recursive: true });

  const boot = async (w, h, label) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.route('**/telegram-web-app.js**', (route) =>
      route.fulfill({ status: 200, body: '', contentType: 'application/javascript' }));
    await ctx.addInitScript(TG_STUB);
    const pg = await ctx.newPage();
    watch(pg, label);
    await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(1000);
    return { ctx, pg };
  };

  try {
    /* ============ 360x640: the popup, the feed, the registry, the composer ============ */
    const { ctx, pg } = await boot(360, 640, '360');

    /* ---- an urgent announcement raises the popup at boot ---- */
    const raised = await pg.evaluate(() => {
      const modal = document.getElementById('modal-announcement');
      return {
        open: modal.classList.contains('is-open') && !modal.hidden,
        title: document.getElementById('announce-title').textContent,
        body: document.getElementById('announce-body').innerHTML,
        ctaHidden: document.getElementById('announce-cta').hidden,
        focus: document.activeElement?.id ?? '',
      };
    });
    expect('the urgent feed announcement raises the popup on boot', raised.open);
    expect('the popup carries the title', raised.title === FEED_URGENT.title);
    expect('the body gets the light markdown subset', raised.body.includes('<strong>20 minutes</strong>'), raised.body);
    expect('no CTA means no button', raised.ctaHidden);
    expect('focus lands on the next step (Dismiss)', raised.focus === 'announce-dismiss', raised.focus);

    /* ---- the overhaul: no inline strip, a flush header, a frosted scrim, a centered modal ---- */
    const shell = await pg.evaluate(() => {
      const card = document.getElementById('home-id-card');
      const scrim = document.getElementById('admin-broadcast-scrim');
      const modal = document.getElementById('admin-broadcast-modal');
      const scs = scrim ? getComputedStyle(scrim) : null;
      const mcs = modal ? getComputedStyle(modal) : null;
      const r = modal?.getBoundingClientRect();
      return {
        strip: document.getElementById('home-broadcast'),
        first: document.getElementById('s-home')?.firstElementChild?.id ?? '',
        cardTop: card?.getBoundingClientRect().top ?? -1,
        scrim: scrim && scs ? {
          open: !scrim.hidden && scrim.classList.contains('is-open'),
          pos: scs.position,
          z: scs.zIndex,
          blur: scs.backdropFilter || scs.webkitBackdropFilter || '',
          bg: scs.backgroundColor,
        } : null,
        modal: modal && mcs && r ? {
          w: r.width, cx: r.left + r.width / 2, cy: r.top + r.height / 2,
          radius: mcs.borderRadius, pad: mcs.padding,
        } : null,
        pill: document.querySelector('.announce-pill')?.textContent ?? '',
        crest: !!document.querySelector('.announce-badge-ico'),
        dismissText: document.getElementById('announce-dismiss')?.textContent ?? '',
      };
    });
    expect('the top inline banner is gone', shell.strip === null && shell.first !== 'home-broadcast');
    expect('the header sits flush at the top edge', shell.cardTop >= 0 && shell.cardTop <= 24, String(shell.cardTop));
    expect('the frosted scrim covers the viewport',
      !!shell.scrim && shell.scrim.open && shell.scrim.pos === 'fixed' && shell.scrim.z === '1000'
      && /blur\(8px\)/.test(shell.scrim.blur) && /rgba\(8, 12, 20, 0\.82\)/.test(shell.scrim.bg),
      JSON.stringify(shell.scrim));
    expect('the Command Dispatch modal is centered and capped at 340px',
      !!shell.modal && Math.abs(shell.modal.cx - 180) <= 2 && Math.abs(shell.modal.cy - 320) <= 2
      && shell.modal.w <= 340 && shell.modal.radius === '20px' && shell.modal.pad === '22px 18px',
      JSON.stringify(shell.modal));
    expect('it carries the authority pill, engraved crest and acknowledge key',
      shell.pill === 'OFFICIAL DISPATCH · SYSTEM ADMIN' && shell.crest && shell.dismissText === 'CONFIRM & DISMISS',
      JSON.stringify({ pill: shell.pill, crest: shell.crest, dismiss: shell.dismissText }));

    await pg.click('#announce-dismiss');
    await pg.waitForTimeout(400);
    const dismissed = await pg.evaluate(() => ({
      hidden: document.getElementById('modal-announcement').hidden,
      scrimHidden: document.getElementById('admin-broadcast-scrim')?.hidden,
      stored: JSON.parse(localStorage.getItem('dismissed_announcements') ?? '[]'),
      seen: JSON.parse(localStorage.getItem('seen_broadcast_ids') ?? '[]'),
    }));
    expect('Dismiss closes the popup', dismissed.hidden);
    expect('and the scrim fades out with it', dismissed.scrimHidden === true);
    expect('and remembers the id on the device', dismissed.stored.includes(FEED_URGENT.id), JSON.stringify(dismissed.stored));
    expect('under the spec key seen_broadcast_ids too', dismissed.seen.includes(FEED_URGENT.id), JSON.stringify(dismissed.seen));

    /* ---- the quiet announcement files one feed card ---- */
    await pg.click('#home-notifs');
    await pg.waitForTimeout(450);
    const feedCards = await pg.evaluate(() => ({
      count: document.querySelectorAll('#notif-list .notif-card.kind-announcement').length,
      title: document.querySelector('#notif-list .notif-card.kind-announcement .notif-title')?.textContent ?? '',
      kind: document.querySelector('#notif-list .notif-card.kind-announcement .notif-kind')?.textContent ?? '',
    }));
    expect('the feed announcement filed exactly one announcement card', feedCards.count === 1, String(feedCards.count));
    expect('the card carries the announcement kind', feedCards.kind === 'Announcement');
    expect('the card carries the title', feedCards.title === FEED_QUIET.title);

    /* ---- a reload: no re-popup, no duplicate card ---- */
    await pg.reload({ waitUntil: 'networkidle' });
    await pg.waitForTimeout(1000);
    const afterReload = await pg.evaluate(() => ({
      popup: !document.getElementById('modal-announcement').hidden,
      filed: JSON.parse(localStorage.getItem('detour.notifications.v1') ?? '{"items":[]}').items ?? [],
    }));
    expect('a dismissed announcement never pops again', afterReload.popup === false);
    const quietCards = afterReload.filed.filter((n) => n.kind === 'announcement');
    expect('a re-sync never stacks a second card', quietCards.length === 1, JSON.stringify(afterReload.filed.map((n) => n.id)));

    /* ---- the Controls tab: the registry, a grant through the drawer, a revoke through the confirm ---- */
    await pg.click('#btn-admin-fab');
    await pg.waitForTimeout(450);
    await pg.evaluate(() => document.getElementById('atab-controls').click());
    await pg.waitForTimeout(350);
    const acl = await pg.evaluate(() => {
      const rows = [...document.querySelectorAll('#adm-acl-list .adm-admin')];
      return {
        count: rows.length,
        ids: rows.map((r) => r.dataset.aid),
        rootRows: rows.filter((r) => r.classList.contains('is-root')).length,
        rootRole: rows.find((r) => r.classList.contains('is-root'))?.querySelector('.adm-admin-role')?.textContent,
        rootLocked: rows.find((r) => r.classList.contains('is-root'))?.querySelector('.adm-admin-x')?.disabled,
        modRole: rows.find((r) => r.dataset.aid === '@helper')?.querySelector('.adm-admin-role')?.textContent,
        counter: document.getElementById('acl-count').textContent,
      };
    });
    expect('the ACL lists the registry the server answered', acl.count === 2 && acl.ids.includes('1') && acl.ids.includes('@helper'), JSON.stringify(acl));
    expect('the root row is marked Owner and its revoke is locked',
      acl.rootRows === 1 && acl.rootRole === 'Owner' && acl.rootLocked === true);
    expect('the appointed row reads Moderator', acl.modRole === 'Mod', acl.modRole);
    expect('the section counter counts them', acl.counter === '2 admins', acl.counter);

    await pg.click('#adm-acl-add');
    await pg.waitForTimeout(350);
    await pg.fill('#adm-acl-id', '424242424');
    await pg.waitForTimeout(320);                 /* the 180ms leash before the verdict */
    const hint = await pg.evaluate(() => ({
      state: document.getElementById('adm-acl-id-hint').dataset.state,
      text: document.getElementById('adm-acl-id-hint').textContent,
      grant: document.getElementById('adm-acl-grant').getAttribute('aria-disabled'),
      role: document.querySelector('#adm-acl-role [aria-pressed="true"]')?.dataset.role,
    }));
    expect('a numeric id validates as ok', hint.state === 'ok');
    expect('the hint names the appointment', hint.text.includes('424242424'));
    expect('the grant key unlocks only then', hint.grant === 'false');
    expect('Moderator is the default role of the drawer', hint.role === 'moderator');
    await pg.click('#adm-acl-grant');
    await pg.waitForTimeout(500);
    const granted = await pg.evaluate(() => ({
      rows: document.querySelectorAll('#adm-acl-list .adm-admin').length,
      ids: [...document.querySelectorAll('#adm-acl-list .adm-admin')].map((r) => r.dataset.aid),
      drawerHidden: document.getElementById('adm-acl-drawer').hidden,
    }));
    expect('the grant reached the server and the list grew', granted.rows === 3 && granted.ids.includes('424242424'), JSON.stringify(granted));
    expect('the drawer closed behind it', granted.drawerHidden === true);

    await pg.evaluate(() => document.querySelector('#adm-acl-list .adm-admin[data-aid="@helper"] .adm-admin-x').click());
    await pg.waitForTimeout(350);
    const asked = await pg.evaluate(() => ({
      open: !document.getElementById('adm-confirm').hidden && document.getElementById('adm-confirm').classList.contains('open'),
      title: document.getElementById('adm-confirm-title').textContent,
      body: document.getElementById('adm-confirm-body').textContent,
      yes: document.getElementById('adm-confirm-yes').textContent,
    }));
    expect('revoke asks first', asked.open);
    expect('the confirm names the admin and the consequence',
      asked.title === 'Revoke admin?' && asked.body.includes('@helper') && asked.yes === 'Revoke', JSON.stringify(asked));
    await pg.click('#adm-confirm-no');
    await pg.waitForTimeout(300);
    expect('backing out changes nothing',
      (await pg.evaluate(() => document.querySelectorAll('#adm-acl-list .adm-admin').length)) === 3);
    await pg.evaluate(() => document.querySelector('#adm-acl-list .adm-admin[data-aid="@helper"] .adm-admin-x').click());
    await pg.waitForTimeout(300);
    await pg.click('#adm-confirm-yes');
    await pg.waitForTimeout(500);
    const revoked = await pg.evaluate(() => ({
      ids: [...document.querySelectorAll('#adm-acl-list .adm-admin')].map((r) => r.dataset.aid),
      confirmHidden: document.getElementById('adm-confirm').hidden,
    }));
    expect('confirming the revoke removes the row', !revoked.ids.includes('@helper') && revoked.ids.length === 2, JSON.stringify(revoked));
    expect('and the dialog is out of the way', revoked.confirmHidden === true);

    await pg.screenshot({ path: path.join(SHOTS, 'admin-rbac-360x640.png') });
    console.log('shot admin-rbac-360x640.png');

    /* ---- the Inbox composer: preview, dispatch, the immediate popup, archive ---- */
    await pg.evaluate(() => document.getElementById('atab-inbox').click());
    await pg.waitForTimeout(350);
    const beforeBc = await pg.evaluate(() => document.querySelectorAll('#adm-bc-list .adm-bc-card').length);
    await pg.click('#adm-bc-compose');
    await pg.waitForTimeout(350);
    await pg.fill('#adm-bc-title', 'Fire drill at 18:00 UTC');
    await pg.fill('#adm-bc-body', 'The arena closes for **10 minutes**.');
    await pg.fill('#adm-bc-cta-label', 'Open Shop');
    await pg.fill('#adm-bc-cta-target', 'shop');
    await pg.waitForTimeout(150);
    const preview = await pg.evaluate(() => ({
      kicker: document.getElementById('adm-bc-pv-kicker').textContent,
      title: document.getElementById('adm-bc-pv-title').textContent,
      body: document.getElementById('adm-bc-pv-body').textContent,
      cta: document.getElementById('adm-bc-pv-cta').hidden ? '' : document.getElementById('adm-bc-pv-cta').textContent,
      send: document.getElementById('adm-bc-send').getAttribute('aria-disabled'),
    }));
    expect('the composer previews the draft as it is typed', preview.title === 'Fire drill at 18:00 UTC'
      && preview.body.includes('10 minutes') && preview.cta === 'Open Shop', JSON.stringify(preview));
    expect('the preview carries the kicker', preview.kicker === 'Urgent · Everyone', preview.kicker);
    expect('a complete draft unlocks Dispatch', preview.send === 'false');
    await pg.click('#adm-bc-send');
    await pg.waitForTimeout(650);

    const popped = await pg.evaluate(() => ({
      raised: !document.getElementById('modal-announcement').hidden,
      title: document.getElementById('announce-title').textContent,
      cta: document.getElementById('announce-cta').hidden ? '' : document.getElementById('announce-cta').textContent,
      cards: document.querySelectorAll('#adm-bc-list .adm-bc-card').length,
      newest: document.querySelector('#adm-bc-list .adm-bc-card .adm-bc-title')?.textContent,
    }));
    expect('a dispatched urgent announcement is already up (below the stage)',
      popped.raised && popped.title === 'Fire drill at 18:00 UTC', JSON.stringify(popped));
    expect('the popup carries the composed CTA', popped.cta === 'Open Shop');
    expect('the history gained the card', popped.cards === beforeBc + 1 && popped.newest === 'Fire drill at 18:00 UTC');

    /* the stage steps aside; the popup takes the front and its CTA routes in-app */
    await pg.click('#admin-close');
    await pg.waitForTimeout(500);
    const front = await pg.evaluate(() => ({
      open: !document.getElementById('modal-announcement').hidden,
      cta: document.getElementById('announce-cta').hidden ? '' : document.getElementById('announce-cta').textContent,
    }));
    expect('with the stage closed the popup is the front layer', front.open && front.cta === 'Open Shop');
    await pg.click('#announce-cta');
    await pg.waitForTimeout(550);
    const followed = await pg.evaluate(() => ({
      popupHidden: document.getElementById('modal-announcement').hidden,
      screen: document.querySelector('.screen:not([hidden])')?.dataset.screen ?? '',
      dismissed: JSON.parse(localStorage.getItem('dismissed_announcements') ?? '[]').length,
    }));
    expect('following the CTA goes to the shop and dismisses the popup',
      followed.popupHidden && followed.screen === 'shop', JSON.stringify(followed));
    expect('the dismissal was remembered', followed.dismissed >= 2, JSON.stringify(followed));

    await pg.click('.dock-nav .tab[data-tab="home"]');
    await pg.waitForTimeout(450);
    await pg.click('#btn-admin-fab');
    await pg.waitForTimeout(500);
    await pg.evaluate(() => document.getElementById('atab-inbox').click());
    await pg.waitForTimeout(350);

    /* archive the top card: the feed retracts and the card flips */
    await pg.evaluate(() => {
      const card = document.querySelector('#adm-bc-list .adm-bc-card[data-bcid^="bc-e2e-"]');
      card.querySelector('[data-bcflip]').click();
    });
    await pg.waitForTimeout(550);
    const archive = await pg.evaluate(() => {
      const card = document.querySelector('#adm-bc-list .adm-bc-card[data-bcid^="bc-e2e-"]');
      return {
        archived: card.classList.contains('is-archived'),
        chip: card.querySelector('[data-state="archived"]')?.textContent ?? '',
        flip: card.querySelector('[data-bcflip]').textContent.trim(),
      };
    });
    expect('archiving flips the card', archive.archived && archive.chip === 'Archived');
    expect('and offers the way back', archive.flip === 'Reactivate');

    /* a feed-priority dispatch: no popup, one card in the centre */
    await pg.click('#adm-bc-compose');
    await pg.waitForTimeout(300);
    await pg.fill('#adm-bc-title', 'Weekend tournament');
    await pg.fill('#adm-bc-body', 'Sign-ups are open until Friday.');
    await pg.evaluate(() => document.querySelector('#adm-bc-priority [data-pri="feed"]').click());
    await pg.waitForTimeout(120);
    await pg.click('#adm-bc-send');
    await pg.waitForTimeout(650);
    const quiet = await pg.evaluate(() => ({
      popupHidden: document.getElementById('modal-announcement').hidden,
      cards: (JSON.parse(localStorage.getItem('detour.notifications.v1') ?? '{"items":[]}').items ?? [])
        .filter((n) => n.kind === 'announcement').length,
      preview: document.getElementById('adm-bc-pv-kicker').textContent,
    }));
    expect('a feed dispatch does not pop a modal', quiet.popupHidden);
    expect('it files one more announcement card', quiet.cards === 2, JSON.stringify(quiet));
    expect('and the composer reset itself', quiet.preview === 'Urgent · Everyone', quiet.preview);

    /* ---- layout: zero page scroll, zero horizontal overflow ---- */
    const geo = await pg.evaluate(() => ({
      pageScroll: document.documentElement.scrollHeight - window.innerHeight,
      hOverflow: document.documentElement.scrollWidth - window.innerWidth,
    }));
    expect('zero page scroll at 360x640', geo.pageScroll <= 0, String(geo.pageScroll));
    expect('zero horizontal overflow at 360x640', geo.hOverflow <= 0, String(geo.hOverflow));
    await ctx.close();

    /* ============ 430x932: the ceiling mark, and the popup's own geometry ============ */
    const { ctx: ctx2, pg: pg2 } = await boot(430, 932, '430');
    const big = await pg2.evaluate(() => {
      const modal = document.getElementById('modal-announcement');
      const r = modal.getBoundingClientRect();
      return {
        popup: !modal.hidden,
        inside: r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight,
        pageScroll: document.documentElement.scrollHeight - window.innerHeight,
        hOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect('the popup raised again at 430x932 (fresh profile)', big.popup);
    expect('the popup sits fully inside the viewport', big.inside);
    expect('zero page scroll at 430x932', big.pageScroll <= 0, String(big.pageScroll));
    expect('zero horizontal overflow at 430x932', big.hOverflow <= 0, String(big.hOverflow));

    /* the spec's viewport audit: 360x640 up to 430x932, zero overflow, modal centered */
    const sweep = [];
    for (const [w, h] of [[360, 640], [390, 844], [412, 915], [430, 932]]) {
      await pg2.setViewportSize({ width: w, height: h });
      await pg2.waitForTimeout(150);
      sweep.push(await pg2.evaluate(() => {
        const panel = document.getElementById('admin-broadcast-modal');
        const r = panel?.getBoundingClientRect();
        return {
          vp: `${window.innerWidth}x${window.innerHeight}`,
          pageScroll: document.documentElement.scrollHeight - window.innerHeight,
          hOverflow: document.documentElement.scrollWidth - window.innerWidth,
          dx: r ? Math.abs(r.left + r.width / 2 - window.innerWidth / 2) : 999,
          dy: r ? Math.abs(r.top + r.height / 2 - window.innerHeight / 2) : 999,
          inside: r ? r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight : false,
        };
      }));
    }
    expect('zero overflow and a centered modal across 360x640 → 430x932',
      sweep.every((s) => s.pageScroll <= 0 && s.hOverflow <= 0 && s.dx <= 2 && s.dy <= 2 && s.inside),
      JSON.stringify(sweep));
    await pg2.screenshot({ path: path.join(SHOTS, 'admin-broadcast-430x932.png') });
    console.log('shot admin-broadcast-430x932.png');

    /* ---- the Controls tab's pinned one-liner rides the same modal ---- */
    await pg2.click('#announce-dismiss');
    await pg2.waitForTimeout(400);
    await pg2.click('#btn-admin-fab');
    await pg2.waitForTimeout(450);
    await pg2.evaluate(() => document.getElementById('atab-controls').click());
    await pg2.waitForTimeout(300);
    await pg2.fill('#bc-input', 'River maintenance tonight at 21:00');
    await pg2.click('#bc-publish');
    await pg2.waitForTimeout(300);
    const pin = await pg2.evaluate(() => ({
      title: document.getElementById('announce-title').textContent,
      body: document.getElementById('announce-body').textContent,
      live: document.getElementById('bc-live').textContent,
      liveOn: document.getElementById('bc-live').dataset.on,
    }));
    expect('a pinned dispatch raises the Command Dispatch modal',
      pin.title === 'Command Dispatch' && pin.body === 'River maintenance tonight at 21:00'
      && pin.live === 'River maintenance tonight at 21:00' && pin.liveOn === 'true', JSON.stringify(pin));
    await pg2.click('#admin-close');
    await pg2.waitForTimeout(500);
    const pinFront = await pg2.evaluate(() => ({
      open: !document.getElementById('modal-announcement').hidden
        && document.getElementById('modal-announcement').classList.contains('is-open'),
      scrim: !document.getElementById('admin-broadcast-scrim').hidden,
    }));
    expect('with the stage closed, the pinned dispatch is the front layer',
      pinFront.open && pinFront.scrim, JSON.stringify(pinFront));
    await pg2.click('#announce-dismiss');
    await pg2.waitForTimeout(400);
    const pinSeen = await pg2.evaluate(() => ({
      hidden: document.getElementById('modal-announcement').hidden,
      seen: JSON.parse(localStorage.getItem('seen_broadcast_ids') ?? '[]'),
    }));
    expect('acknowledging the pinned dispatch closes it and remembers its id',
      pinSeen.hidden && pinSeen.seen.some((id) => id.startsWith('pin-')), JSON.stringify(pinSeen));
    await ctx2.close();
  } finally {
    await browser.close();
    srv.close();
  }
}

/* Shared with the audit scripts: named, counted, and reported in one place. */
function expect(name, condition, detail = '') {
  ran++;
  if (condition) console.log(`  ok  ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

await main();

expect(`zero console/page errors (${errors.length})`, errors.length === 0);
for (const e of errors) console.log(`  ${e}`);

console.log(`\n${ran - failed}/${ran} checks passed`);
if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all rbac + broadcast checks passed');
