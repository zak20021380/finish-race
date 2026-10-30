/**
 * verify-squad-register.mjs — mock the Telegram Bot API and drive the real worker route.
 *
 * Proves `POST /api/squads/register`:
 *   - refuses a member who is not an owner/administrator (403, not_admin);
 *   - accepts an administrator when the bot is also an administrator, and populates
 *     the squad from getChat / getChatMemberCount metadata;
 *   - refuses a chat where the bot itself is not an administrator;
 *   - refuses a duplicate registration (409, already_registered);
 *   - normalizes a t.me link to the same handle.
 *
 * Run: node scripts/verify-squad-register.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TOKEN = '12345:AAHtest-token-for-the-squad-harness';
const BOT_ID = '999000111';

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

/* ---------- Telegram Bot API mock ---------- */

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const method = String(url).split('/').pop();
  const body = init.body ? JSON.parse(String(init.body)) : {};
  calls.push({ method, body });
  const reply = (payload, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

  if (method === 'getChat') {
    if (body.chat_id === '@Botless') {
      return reply({ ok: true, result: { id: -100777, type: 'supergroup', title: 'Botless Group', username: 'Botless' } });
    }
    if (body.chat_id === '@MissingChat') {
      return reply({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400);
    }
    if (body.chat_id === '@NamedSquad') {
      return reply({
        ok: true,
        result: {
          id: -100555000111,
          type: 'supergroup',
          title: 'Named Squad HQ',
          username: 'NamedSquad',
          photo: { small_file_id: 'named-photo-id' },
        },
      });
    }
    return reply({
      ok: true,
      result: {
        id: -1001234567890,
        type: 'channel',
        title: 'Test Squad HQ',
        username: 'TestSquad',
        photo: { small_file_id: 'small-photo-id', big_file_id: 'big-photo-id' },
      },
    });
  }
  if (method === 'getChatMember') {
    if (body.chat_id === '-100777') {
      return reply({ ok: true, result: { status: body.user_id === BOT_ID ? 'member' : 'administrator' } });
    }
    if (body.user_id === BOT_ID) return reply({ ok: true, result: { status: 'administrator' } });
    if (body.user_id === '42') return reply({ ok: true, result: { status: 'creator' } });
    return reply({ ok: true, result: { status: 'member' } });
  }
  if (method === 'getChatMemberCount') return reply({ ok: true, result: 321 });
  if (method === 'getMe') return reply({ ok: true, result: { id: BOT_ID, username: 'Tactix_Robot' } });
  return reply({ ok: false, error_code: 404, description: 'Not Found' }, 404);
};

/* ---------- the real worker, one real DO, no storage backend ---------- */

const outfile = path.join(ROOT, '.tmp', 'worker-squad-register.mjs');
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

function mkRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  return {
    url,
    method,
    headers: { get: (name) => (map.has(String(name).toLowerCase()) ? map.get(String(name).toLowerCase()) : null) },
    async json() { return body ?? {}; },
  };
}

const env = {
  DEV_AUTH: 'true',
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_BOT_ID: BOT_ID,
  ADMIN_IDS: '',
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

const route = (body, method = 'POST') =>
  worker.fetch(mkRequest('https://detour.example.com/api/squads/register', { method, body }), env);
const bodyOf = async (res) => JSON.parse(await res.text());

/* ---------- checks ---------- */

console.log('\n-- squad registration --');

{
  const member = await route({ chatUsername: '@TestSquad', userTelegramId: '43' });
  const data = await bodyOf(member);
  ok('a non-admin member is refused with 403', member.status === 403, `status ${member.status}`);
  ok('the refusal is not_admin', data.error === 'not_admin', JSON.stringify(data));
  ok('the refusal carries the access-denied message',
    data.message === 'Access Denied: You must be an administrator of this channel/group.', data.message);
}

{
  const valid = await route({ chatUsername: 'https://t.me/TestSquad', userTelegramId: '42' });
  const data = await bodyOf(valid);
  ok('an owner/administrator verifies successfully', valid.status === 200, `status ${valid.status}`);
  ok('the squad is populated from getChat metadata',
    data.ok === true && data.squad?.name === 'Test Squad HQ' && data.squad?.handle === '@TestSquad'
      && data.squad?.members === 321 && data.squad?.kind === 'channel'
      && data.squad?.avatar === 'small-photo-id' && data.squad?.ownerId === '42'
      && data.squad?.tag === '',
    JSON.stringify(data.squad));
  ok('getChatMember was asked about the requester and the bot',
    calls.some((c) => c.method === 'getChatMember' && c.body.user_id === '42')
      && calls.some((c) => c.method === 'getChatMember' && c.body.user_id === BOT_ID));
}

{
  const duplicate = await route({ chatUsername: '@TestSquad', userTelegramId: '42' });
  const data = await bodyOf(duplicate);
  ok('a duplicate registration is refused with 409', duplicate.status === 409, `status ${duplicate.status}`);
  ok('the duplicate is already_registered', data.error === 'already_registered', JSON.stringify(data));
  ok('the duplicate carries the already-registered message',
    data.message === 'This squad is already enlisted in the competition!', data.message);
}

{
  const botless = await route({ chatUsername: '@Botless', userTelegramId: '42' });
  const data = await bodyOf(botless);
  ok('a chat where the bot is not an admin is refused', botless.status === 400, `status ${botless.status}`);
  ok('the botless refusal is bot_not_admin', data.error === 'bot_not_admin', JSON.stringify(data));
  ok('the botless refusal names the bot requirement',
    data.message === 'Bot is not added as an administrator to this chat.', data.message);
}

{
  const invalid = await route({ chatUsername: 'not a handle', userTelegramId: '42' });
  const data = await bodyOf(invalid);
  ok('an invalid handle is refused with 400', invalid.status === 400 && data.error === 'invalid_handle');
  const missing = await route({ chatUsername: '@MissingChat', userTelegramId: '42' });
  const missingData = await bodyOf(missing);
  ok('an unknown chat is refused with 404', missing.status === 404 && missingData.error === 'chat_not_found');
  const get = await route({}, 'GET');
  ok('a non-POST method is refused with 405', get.status === 405);
}

{
  const badTag = await route({
    chatUsername: '@NamedSquad',
    squadName: 'Night Shift',
    squadTag: 'X',
    userTelegramId: '42',
  });
  const data = await bodyOf(badTag);
  ok('a one-character tag is refused with 400', badTag.status === 400 && data.error === 'invalid_tag',
    JSON.stringify(data));

  const named = await route({
    chatUsername: '@NamedSquad',
    squadName: 'Night Shift',
    squadTag: 'ns',
    userTelegramId: '42',
  });
  const namedData = await bodyOf(named);
  ok('a custom name and tag are verified and stored',
    named.status === 200 && namedData.squad?.name === 'Night Shift' && namedData.squad?.tag === 'NS'
      && namedData.squad?.handle === '@NamedSquad',
    JSON.stringify(namedData.squad));
}

console.log(`\n${ran - failed}/${ran} checks passed`);
if (failed) process.exit(1);
