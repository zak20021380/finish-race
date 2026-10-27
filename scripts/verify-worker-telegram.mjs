/**
 * verify-worker-telegram.mjs — the bot's chat surface, driven in plain Node.
 *
 * `npm run build` proves the worker type-checks. This proves the conversation actually works. It
 * bundles the real `worker/index.ts` (the same code wrangler ships), stubs the Bot API with a
 * recorder so every outbound `sendMessage`, `editMessageText` and `setWebhook` can be read back, and
 * walks the flow a player takes:
 *
 *   - the gates: a GET on the webhook is refused, an unconfigured token is honest about it, and a
 *     `secret_token` mismatch is the one thing that answers 403;
 *   - `/start` and `/lang` open on the trilingual picker, in three rows, one callback per language;
 *   - picking a language *edits* the picker into the main menu of that language — one PLAY web_app
 *     button, the two menu callbacks, and the language callback — and never stacks a second message;
 *   - rules and invite screens, in all three languages, with the invite link and share sheet built
 *     from the bot's own handle;
 *   - the referral: a `/start ref_ab12cd34ef56` payload still rides on the PLAY button's `?startapp=` after
 *     the player has changed language in between, which is what pays the inviter in the Mini App;
 *   - a bare `/rules` and `/play` answer in the language the player last chose, or in what their
 *     client reports when the worker has never met them — and `/rules@thebot` parses as `/rules`;
 *   - resilience: a blocked player, a failed edit, and an identical screen are all handled without
 *     the webhook ever giving Telegram a reason to retry;
 *   - the operator's door: setup is behind the same allowlist as `/admin/*`, registers the webhook at
 *     its own origin, localises the command list, points the chat menu button at the Mini App, and
 *     takes the invite handle from `getMe`;
 *   - and the invariants that keep Telegram from rejecting the payload at all: HTML parse_mode with no
 *     leftover `**` markers, callback data and button labels inside their byte limits, and message
 *     text inside Telegram's 4096.
 *
 *   node scripts/verify-worker-telegram.mjs
 */
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TOKEN = '12345:AAHtest-token-for-the-telegram-harness';
const ADMIN_ID = 1000001;
const LIVE = 'https://finish-race.deadeye-game.workers.dev';
const HOST = 'finish-race.deadeye-game.workers.dev';
/** The two ids the bot has never met, so each scenario starts from no remembered language. */
const EN_USER = 500001;
const NEW_USER = 500002;

/* ---------- the Bot API, recorded rather than called ---------- */

let calls = [];
let messageSeq = 500;
/** method -> the queue of failures to drain, one per call. */
const faults = new Map();
const results = new Map();

function resetApi() {
  calls = [];
  faults.clear();
  results.clear();
}

/** Fail the next `count` calls to `method` with Telegram's own error envelope. */
function failNext(method, error_code, description, count = 1) {
  faults.set(method, Array.from({ length: count }, () => ({ error_code, description })));
}

/** What `method` should hand back, when the documented `result` is not simply `true`. */
function answerWith(method, result) {
  results.set(method, result);
}

globalThis.fetch = async (url, init) => {
  const full = String(url);
  const method = full.split('/').pop() ?? '';
  const token = /\/bot([^/]+)\//.exec(full)?.[1] ?? '';
  const params = init?.body ? JSON.parse(init.body) : {};
  calls.push({ method, params, token });

  const pending = faults.get(method);
  if (pending?.length) {
    const fault = pending.shift();
    return {
      ok: false,
      status: fault.error_code >= 500 ? 500 : 400,
      async json() {
        return { ok: false, error_code: fault.error_code, description: fault.description };
      },
    };
  }
  if (results.has(method)) {
    return { ok: true, status: 200, async json() { return { ok: true, result: results.get(method) }; } };
  }
  if (method === 'sendMessage') return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: ++messageSeq, date: 1700000000 } }; } };
  return { ok: true, status: 200, async json() { return { ok: true, result: true }; } };
};

/* ---------- the two globals the worker needs beyond Node ---------- */

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

/** So a route's `Response` body can be read as a string, the way the admin harness reads it. */
class FakeResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers);
    this.webSocket = init.webSocket ?? null;
  }
  get ok() { return this.status >= 200 && this.status < 300; }
  async json() { return this.body ? JSON.parse(this.body) : {}; }
}

globalThis.Response = FakeResponse;

/* ---------- load the bundled worker ---------- */

const outfile = path.join(ROOT, '.tmp', 'worker-telegram.mjs');
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

/**
 * A real ReferralLedgerDO over an in-memory store: the bot's invite card asks it for the player's
 * permanent code, exactly as production does. A fresh instance per runtime keeps test ids isolated.
 */
function referralNamespace(env) {
  const store = new Map();
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
    idFromName: () => ({ toString: () => 'global' }),
    get: () => ({ fetch: (request) => ledger.fetch(request) }),
  };
}

/* ---------- a request, a runtime ---------- */

function mkRequest(url, { method = 'GET', headers = {}, body = null, throws = false } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  const read = (name) => map.get(String(name).toLowerCase()) ?? null;
  return {
    url,
    method,
    headers: { get: read },
    async json() {
      if (throws) throw new SyntaxError('Unexpected token');
      return body ?? {};
    },
  };
}

/** The bot needs no Durable Object, so the namespaces only have to prove they were not touched. */
function runtime(vars = {}) {
  const env = {
    DEV_AUTH: vars.DEV_AUTH ?? 'false',
    TELEGRAM_BOT_TOKEN: vars.TELEGRAM_BOT_TOKEN ?? TOKEN,
    ADMIN_IDS: vars.ADMIN_IDS ?? String(ADMIN_ID),
    WEBAPP_URL: vars.WEBAPP_URL,
    TELEGRAM_WEBHOOK_SECRET: vars.TELEGRAM_WEBHOOK_SECRET,
  };
  const unused = () => ({ idFromName: (n) => ({ toString: () => n }), get: () => ({ fetch: () => { throw new Error('the room must not be woken for a bot route'); } }) });
  env.MATCHMAKER = unused();
  env.BADGES = unused();
  env.REFERRALS = referralNamespace(env);
  resetApi();
  return {
    env,
    route: (url, opts) => worker.fetch(mkRequest(url, opts), env),
    webhook: (update, opts = {}) =>
      worker.fetch(mkRequest(`https://${HOST}/telegram/webhook`, { method: 'POST', body: update, ...opts }), env),
  };
}

const bodyOf = (res) => JSON.parse(res.body);

/* ---------- update fixtures ---------- */

const message = (text, { from = EN_USER, lang = 'en', chat = -1001, type = 'private', bot = false, id = 1 } = {}) => ({
  message: {
    message_id: id,
    chat: { id: chat, type },
    from: { id: from, language_code: lang, is_bot: bot, first_name: 'Zed' },
    text,
  },
});

const callback = (data, { from = EN_USER, lang = 'en', chat = -1001, messageId = 77, id = 'cq' } = {}) => ({
  callback_query: {
    id,
    data,
    from: { id: from, language_code: lang, is_bot: false, first_name: 'Zed' },
    message: { message_id: messageId, chat: { id: chat, type: 'private', from: { id: chat, first_name: 'Zed' } }, from: { id: chat } },
  },
});

/* ---------- the recorder's reads ---------- */

const sent = (method) => calls.filter((c) => c.method === method).map((c) => c.params);
const count = (method) => sent(method).length;
/** Never null: a check that reads a call which was not made must fail, not throw. */
const last = (method) => sent(method).at(-1) ?? { text: '', reply_markup: { inline_keyboard: [] } };
const rows = (params) => params?.reply_markup?.inline_keyboard ?? [];
const flat = (params) => rows(params).flat();
/** The first button whose label contains `needle`. */
const button = (params, needle) => flat(params).find((b) => b.text.includes(needle)) ?? null;
const playUrl = (params) => flat(params).find((b) => b.web_app)?.web_app?.url ?? '';

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

/** Every keyboard, in every language, has to survive Telegram's own limits. */
function withinLimits(params, label) {
  const oversizeText = (params?.text ?? '').length > 4096;
  const badButtons = flat(params).some((b) =>
    !b.text || b.text.length > 64 || (b.callback_data ?? '').length > 64);
  const emptyRows = rows(params).some((row) => !Array.isArray(row) || row.length === 0);
  ok(`${label}: inside Telegram's text, button and row limits`,
    !oversizeText && !badButtons && !emptyRows,
    `text ${params?.text?.length} buttons ${flat(params).length}`);
}

/* ---------- 1. the gates ---------- */

console.log('\n-- the webhook gates --');
{
  const rt = runtime();

  const get = await rt.route(`https://${HOST}/telegram/webhook`);
  ok('GET on the webhook is refused with 405', get.status === 405, `status ${get.status}`);
  ok('and says what it wants instead', bodyOf(get).error === 'method_not_allowed', get.body);
  ok('nothing was sent to Telegram', calls.length === 0, JSON.stringify(calls));

  const noToken = runtime({ TELEGRAM_BOT_TOKEN: '' });
  const shut = await noToken.webhook(message('/start'));
  ok('an unconfigured bot token answers 503 rather than pretending', shut.status === 503, `status ${shut.status}`);
  ok('and names the reason', bodyOf(shut).error === 'no_bot_token', shut.body);

  const guarded = runtime({ TELEGRAM_WEBHOOK_SECRET: 'hunter2' });
  const wrong = await guarded.webhook(message('/start'), { headers: { 'x-telegram-bot-api-secret-token': 'nope' } });
  ok('a wrong secret_token is the one thing refused with 403', wrong.status === 403, `status ${wrong.status}`);
  ok('and it refuses silently, sending nothing', calls.length === 0, JSON.stringify(calls));

  const missing = await guarded.webhook(message('/start'));
  ok('a missing secret_token is refused too', missing.status === 403, `status ${missing.status}`);

  resetApi();
  const right = await guarded.webhook(message('/start', { from: NEW_USER }), { headers: { 'x-telegram-bot-api-secret-token': 'hunter2' } });
  ok('the right secret_token lets the update through', right.status === 200 && last('sendMessage') !== null);

  const junk = await rt.webhook(null, { throws: true });
  ok('an unparseable body is consumed with 200, so Telegram never retries', junk.status === 200, `status ${junk.status}`);
  ok('and says it ignored the update', bodyOf(junk).ignored === 'unparseable', junk.body);

  const empty = await rt.route(`https://${HOST}/telegram/nope`, { method: 'POST', body: {} });
  ok('an unknown /telegram/ route stays a JSON 404, not the game HTML',
    empty.status === 404 && bodyOf(empty).error === 'not_found', empty.body);

  const health = await rt.route(`https://${HOST}/health`);
  ok('/health is still public next to it', health.status === 200 && bodyOf(health).ok === true);
}

/* ---------- 2. language comes first ---------- */

console.log('\n-- the language picker --');
{
  const rt = runtime();
  await rt.webhook(message('/start', { from: EN_USER }));

  const greeting = last('sendMessage');
  ok('/start sends exactly one message', calls.length === 1, JSON.stringify(calls.map((c) => c.method)));
  ok('with the trilingual welcome', greeting.text.includes('Welcome to Tactix'));
  ok('and asks in Persian and Arabic too',
    greeting.text.includes('لطفاً زبان خود را انتخاب کنید')
      && greeting.text.includes('يرجى اختيار لغتك للمتابعة'));
  ok('as HTML', greeting.parse_mode === 'HTML');
  ok('to the private chat it came from', String(greeting.chat_id) === '-1001');
  ok('one language per row, in the order en, fa, ar',
    rows(greeting).length === 3 && rows(greeting).every((row) => row.length === 1)
      && flat(greeting).map((b) => b.callback_data).join(',') === 'lang:en,lang:fa,lang:ar',
    JSON.stringify(flat(greeting)));
  ok('each with its own flag',
    flat(greeting).every((b, i) => b.text.startsWith(['🇬🇧', '🇮🇷', '🇸🇦'][i])),
    JSON.stringify(flat(greeting).map((b) => b.text)));
  withinLimits(greeting, 'the picker');

  resetApi();
  await rt.webhook(message('/lang', { from: EN_USER }));
  ok('/lang opens the same picker', last('sendMessage')?.text.includes('Welcome to Tactix'));

  resetApi();
  await rt.webhook(message('/start', { from: EN_USER, chat: -4400, type: 'group' }));
  ok('a /start in a group still gets the picker', calls.length === 1);
}

/* ---------- 3. choosing a language redraws the screen in place ---------- */

console.log('\n-- choosing a language --');
{
  const rt = runtime();
  await rt.webhook(callback('lang:fa', { from: EN_USER, messageId: 77 }));

  const methods = calls.map((c) => c.method);
  ok('the callback query is answered, so the spinner stops', methods.includes('answerCallbackQuery'));
  ok('and the menu is edited, not stacked', methods.includes('editMessageText') && !methods.includes('sendMessage'),
    JSON.stringify(methods));

  const ack = last('answerCallbackQuery');
  ok('the ack names the callback it closes', ack.callback_query_id === 'cq', JSON.stringify(ack));

  const menu = last('editMessageText');
  ok('on the message the player tapped', String(menu.message_id) === '77' && String(menu.chat_id) === '-1001');
  ok('with the Persian headline', menu.text.includes('به میدان نبرد Tactix خوش اومدی'), menu.text?.slice(0, 40));
  ok('and the pitch to master Tactix', menu.text.includes('آماده‌ای نشون بدی کی باهوش‌تره'));
  ok('as HTML', menu.parse_mode === 'HTML');
  ok('row 1 launches the Mini App',
    playUrl(menu) === `${LIVE}/` || playUrl(menu) === LIVE, playUrl(menu));
  ok('the web_app button is typed for Bot API 7+ clients',
    button(menu, 'شروع بازی')?.type === 'web_app', JSON.stringify(button(menu, 'شروع بازی')));
  ok('row 2 is rules and invite, both carrying the language',
    button(menu, 'راهنمای بازی')?.callback_data === 'menu:rules:fa'
      && button(menu, 'دعوت از دوستان')?.callback_data === 'menu:invite:fa');
  ok('row 3 switches language', button(menu, 'تغییر زبان')?.callback_data === 'menu:lang');
  withinLimits(menu, 'the Persian menu');

  /* An Arabic player who has never been seen: their own client decides. */
  resetApi();
  await rt.webhook(callback('lang:ar', { from: NEW_USER, messageId: 90 }));
  const arabic = last('editMessageText');
  ok('the Arabic menu reads as Arabic', arabic.text.includes('مرحباً بك في ساحة Tactix'));
  ok('with the Arabic call to action', arabic.text.includes('هل تملك السرعة والذكاء للوصول أولاً'));
  ok('and its own button labels', button(arabic, 'العب الآن') !== null && button(arabic, 'طريقة اللعب') !== null);
  withinLimits(arabic, 'the Arabic menu');
}

/* ---------- 4. rules and invite ---------- */

console.log('\n-- rules and invite --');
{
  const rt = runtime();

  await rt.webhook(callback('menu:rules:en', { messageId: 12 }));
  const rules = last('editMessageText');
  ok('the English rules card', rules.text.includes('HOW TO PLAY Tactix'));
  ok('states the goal and the turn options',
    rules.text.includes('Be the first to reach the') && rules.text.includes('Place a Wall')
      && rules.text.includes('Plant Mines'), rules.text.slice(0, 160));
  ok('bolds the goal the way the copy intends', rules.text.includes('<b>FINISH</b>'), rules.text.slice(0, 60));
  ok('with no Markdown markers left behind', !rules.text.includes('**'));
  ok('offers PLAY and a way back',
    playUrl(rules) !== '' && button(rules, 'Back to Menu')?.callback_data === 'lang:en');
  withinLimits(rules, 'the English rules');

  resetApi();
  await rt.webhook(callback('menu:rules:fa'));
  ok('the Persian rules card', last('editMessageText').text.includes('قوانین و راهنمای Tactix'));
  ok('with the back button in Persian', button(last('editMessageText'), 'بازگشت')?.callback_data === 'lang:fa');

  resetApi();
  await rt.webhook(callback('menu:rules:ar'));
  ok('the Arabic rules card', last('editMessageText').text.includes('طريقة اللعب والقوانين في Tactix'));
  ok('and its PLAY button still opens the app', playUrl(last('editMessageText')).startsWith(LIVE));

  resetApi();
  await rt.webhook(callback('menu:invite:en', { from: EN_USER }));
  const invite = last('editMessageText');
  const personal = /https:\/\/t\.me\/Tactix_Robot\/app\?startapp=ref_([a-z0-9]{12})/.exec(invite.text)?.[0] ?? '';
  ok('the invite card carries a personal direct-Mini-App link', personal !== '', invite.text.slice(-120));
  ok('with the placeholder filled in, not printed', !invite.text.includes('{link}'));
  const share = button(invite, 'Share Invite Link');
  ok('one button opens the share sheet', (share?.url ?? '').startsWith('https://t.me/share/url?url='), share?.url);
  ok('and the share sheet carries the same link and a pitch',
    decodeURIComponent(share.url).includes(personal) && decodeURIComponent(share.url).includes('500 coins'));
  ok('another hands the pitch to any chat as an inline query',
    (button(invite, 'Challenge a Friend')?.switch_inline_query ?? '').length > 0);
  ok('and back goes to the menu', button(invite, 'Back to Menu')?.callback_data === 'lang:en');
  withinLimits(invite, 'the English invite');

  resetApi();
  await rt.webhook(callback('menu:invite:fa', { from: 500003 }));
  const persian = last('editMessageText');
  ok('the Persian invite localises the pitch it shares',
    decodeURIComponent(button(persian, 'ارسال')?.url ?? '').includes('۵۰۰ سکه'),
    JSON.stringify(button(persian, 'ارسال')));

  resetApi();
  await rt.webhook(callback('menu:invite:ar', { from: 500004 }));
  ok('the Arabic invite does too',
    last('editMessageText').text.includes('دعوة الأصدقاء')
      && last('editMessageText').text.includes('٥٠٠ عملة'));

  resetApi();
  await rt.webhook(callback('menu:lang', { messageId: 31 }));
  ok('Change Language puts the picker back on the same message',
    calls.map((c) => c.method).includes('editMessageText')
      && last('editMessageText').message_id === 31
      && last('editMessageText').text.includes('Welcome to Tactix'));
}

/* ---------- 5. the referral survives the menu ---------- */

console.log('\n-- the referral payload --');
{
  const rt = runtime();

  await rt.webhook(message('/start ref_ab12cd34ef56', { from: 500005 }));
  ok('a payload start still opens on the picker', last('sendMessage').text.includes('Welcome to Tactix'));

  resetApi();
  await rt.webhook(callback('lang:en', { from: 500005 }));
  const play = playUrl(last('editMessageText'));
  ok('the PLAY button carries the code into the Mini App',
    play === `${LIVE}/?startapp=ref_ab12cd34ef56`, play);

  resetApi();
  await rt.webhook(callback('menu:rules:en', { from: 500005 }));
  ok('and so does the PLAY button on the rules card',
    playUrl(last('editMessageText')) === `${LIVE}/?startapp=ref_ab12cd34ef56`, playUrl(last('editMessageText')));

  /* a fresh player with nothing to attribute gets a clean url */
  resetApi();
  await rt.webhook(callback('lang:en', { from: 500006 }));
  const clean = playUrl(last('editMessageText'));
  ok('a player with no referral gets an uncluttered launch url',
    clean === LIVE || clean === `${LIVE}/`, clean);

  /* junk after /start is not a code, and does not reach a url */
  resetApi();
  await rt.webhook(message('/start <script>alert(1)</script> http://evil', { from: 500007 }));
  resetApi();
  await rt.webhook(callback('lang:en', { from: 500007 }));
  ok('a payload that is not a code is dropped, not encoded into the app url',
    !playUrl(last('editMessageText')).includes('startapp'), playUrl(last('editMessageText')));
}

/* ---------- 6. commands answer in the player language ---------- */

console.log('\n-- commands --');
{
  const rt = runtime();

  resetApi();
  await rt.webhook(callback('lang:fa', { from: 600000 }));
  await rt.webhook(message('/rules', { from: 600000 }));
  ok('a bare /rules answers in the language the player last chose',
    last('sendMessage').text.includes('قوانین و راهنمای Tactix'), last('sendMessage').text?.slice(0, 40));

  resetApi();
  await rt.webhook(message('/play', { from: 600000 }));
  ok('and so does /play, with no help from the client language',
    last('sendMessage').text.includes('میدان نبرد آماده‌ست'), last('sendMessage').text?.slice(0, 40));

  resetApi();
  await rt.webhook(message('/rules@Tactix_Robot', { from: 600001, lang: 'ar' }));
  ok('a bare /rules for a new Arabic client uses their client language',
    last('sendMessage').text.includes('طريقة اللعب والقوانين في Tactix'));
  ok('and the handle suffix is not part of the command', calls.length === 1, JSON.stringify(calls));

  resetApi();
  await rt.webhook(message('/play', { from: 600002, lang: 'fa' }));
  const card = last('sendMessage');
  ok('/play is a launch card, not the whole menu',
    card.text.includes('میدان نبرد آماده‌ست') && rows(card).length === 2 && playUrl(card) !== '');
  ok('with one way back to the menu', button(card, 'منوی اصلی')?.callback_data === 'lang:fa');

  resetApi();
  await rt.webhook(message('hello there', { from: 600003, lang: 'en' }));
  ok('an ordinary word in a private chat opens the menu',
    last('sendMessage').text.includes('WELCOME TO THE ARENA'));

  resetApi();
  await rt.webhook(message('hello there', { from: 600004, type: 'group', chat: -4400 }));
  ok('but not in a group: the lobby is not a chat room', calls.length === 0, JSON.stringify(calls));

  resetApi();
  await rt.webhook(message('/start', { from: 600005, bot: true }));
  ok('another bot never gets an answer, so no two bots can loop', calls.length === 0);

  resetApi();
  await rt.webhook({ callback_query: { id: 'cq2', data: 'lang:en', from: { id: 600006, language_code: 'en' } } });
  ok('a callback with no message still gets its ack and nothing else',
    calls.length === 1 && calls[0].method === 'answerCallbackQuery', JSON.stringify(calls));

  resetApi();
  await rt.webhook(callback('menu:rules:xx', { from: 600007 }));
  ok('a callback naming a language the bot has no copy for is ignored',
    calls.length === 1 && calls[0].method === 'answerCallbackQuery', JSON.stringify(calls));

  resetApi();
  await rt.webhook(callback('some:other:bot', { from: 600008 }));
  ok('an unknown callback is acked but changes nothing',
    calls.length === 1 && calls[0].method === 'answerCallbackQuery');

  resetApi();
  await rt.webhook({ message: { chat: { id: -1001, type: 'private' }, from: { id: 600009 }, text: '/unknown' } });
  ok('an unknown command is silent rather than wrong', calls.length === 0);
}

/* ---------- 7. nothing here makes Telegram retry ---------- */

console.log('\n-- resilience --');
{
  const rt = runtime();

  failNext('sendMessage', 403, 'Forbidden: bot was blocked by the user');
  const blocked = await rt.webhook(message('/start', { from: 600010 }));
  ok('a blocked player is not an error: the webhook answers 200',
    blocked.status === 200 && bodyOf(blocked).ignored === 'unreachable', blocked.body);

  resetApi();
  failNext('editMessageText', 400, 'Bad Request: message is not modified: specified new message content is the same as the current one');
  await rt.webhook(callback('lang:en', { from: 600011, messageId: 41 }));
  ok('an identical screen does not resend itself',
    calls.filter((c) => c.method === 'editMessageText').length === 1
      && calls.filter((c) => c.method === 'sendMessage').length === 0,
    JSON.stringify(calls.map((c) => c.method)));

  resetApi();
  failNext('editMessageText', 400, 'Bad Request: message to edit not found');
  await rt.webhook(callback('lang:ar', { from: 600012, messageId: 42 }));
  ok('a message that is gone falls back to a fresh one',
    calls.some((c) => c.method === 'editMessageText') && calls.some((c) => c.method === 'sendMessage'),
    JSON.stringify(calls.map((c) => c.method)));
  ok('and the fallback says the same thing in the same language',
    last('sendMessage').text.includes('مرحباً بك في ساحة Tactix'));

  resetApi();
  failNext('answerCallbackQuery', 400, 'Bad Request: query is too old and response timeout expired');
  await rt.webhook(callback('lang:en', { from: 600013 }));
  ok('a stale callback ack does not lose the menu',
    calls.some((c) => c.method === 'editMessageText'));

  resetApi();
  const odd = await rt.webhook({ my_chat_member: { chat: { id: -1 }, new_chat_member: { status: 'left' } } });
  ok('an update shape the bot does not speak is consumed with 200',
    odd.status === 200 && bodyOf(odd).ok === true && calls.length === 0, odd.body);

  resetApi();
  const everyLanguage = ['lang:en', 'lang:fa', 'lang:ar'];
  for (const data of everyLanguage) {
    await rt.webhook(callback(data, { from: 600014 }));
    await rt.webhook(callback(`menu:invite:${data.slice(5)}`, { from: 600014 }));
  }
  ok('three languages, two screens each, all sent as HTML with no markers left',
    sent('editMessageText').length === 6
      && sent('editMessageText').every((p) => p.parse_mode === 'HTML' && !p.text.includes('**')),
    JSON.stringify(sent('editMessageText').map((p) => p.parse_mode)));
}

/* ---------- 8. the inline answer a challenge button needs ---------- */

console.log('\n-- the inline share card --');
{
  const rt = runtime();
  await rt.webhook(callback('lang:fa', { from: 600020 }));

  resetApi();
  await rt.webhook({ inline_query: { id: 'iq1', from: { id: 600020, language_code: 'fa' } } });
  const answer = last('answerInlineQuery');
  const card = answer.results?.[0] ?? {};
  ok('the challenge button gets a result instead of an empty list', count('answerInlineQuery') === 1, JSON.stringify(calls));
  ok('for the query it came from', answer.inline_query_id === 'iq1');
  ok('one article, in the player language',
    answer.results?.length === 1 && (card.title ?? '').includes('مسابقه'), JSON.stringify(answer.results));
  ok('whose card is the pitch plus the personal link',
    /ref_[a-z0-9]{12}/.test(card.input_message_content?.message_text ?? '')
      && card.input_message_content?.parse_mode === 'HTML');
  ok('and the card opens the Mini App straight from the group it lands in',
    (card.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url ?? '').startsWith(LIVE), JSON.stringify(card.reply_markup));
  ok('with a description short enough for the picker',
    (card.description ?? '').length > 0 && card.description.length <= 64, String(card.description?.length));
}

/* ---------- 9. the operator's setup door ---------- */

/** A properly signed Telegram initData, built the documented way. */
function signed(fields, token = TOKEN) {
  const rows = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(rows.join('\n')).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const asAdmin = (id = ADMIN_ID) => ({
  'x-telegram-init-data': signed({ auth_date: '1700000000', user: JSON.stringify({ id, first_name: 'Boss' }), query_id: 'ADMIN' }),
});

console.log('\n-- /telegram/setup-webhook --');
{
  const rt = runtime({ WEBAPP_URL: LIVE });

  const anon = await rt.route(`https://${HOST}/telegram/setup-webhook`);
  ok('setup is closed to an anonymous caller with 403', anon.status === 403, `status ${anon.status}`);
  ok('and says what would open it', bodyOf(anon).error === 'forbidden' && /ADMIN_IDS/.test(bodyOf(anon).hint), anon.body);
  ok('nothing was registered', calls.length === 0);

  const stranger = await rt.route(`https://${HOST}/telegram/setup-webhook`, { headers: asAdmin(999999) });
  ok('a valid signature that is not on ADMIN_IDS is refused too', stranger.status === 403);

  answerWith('getMe', { id: 777, is_bot: true, username: '@detour_real_bot' });
  const boss = await rt.route(`https://${HOST}/telegram/setup-webhook`, { headers: asAdmin() });
  const report = bodyOf(boss);
  ok('a signed admin gets a 200 and a green report', boss.status === 200 && report.ok === true, boss.body);
  ok('on its own origin, at /telegram/webhook',
    report.webhook === `https://${HOST}/telegram/webhook`, report.webhook);

  const hook = last('setWebhook');
  ok('setWebhook registers that url', hook.url === report.webhook);
  ok('and keeps the pending updates rather than dropping them', hook.drop_pending_updates === false);
  ok('with no secret_token when none is configured', !('secret_token' in hook), JSON.stringify(hook));

  const commandLists = sent('setMyCommands');
  const asList = (entry) => entry ?? { commands: [], scope: {} };
  const [defaultList, persianList, arabicList] = commandLists.map(asList);
  ok('the command list is registered for every private chat', commandLists.length === 3, JSON.stringify(commandLists));
  ok('the default list carries the four commands',
    defaultList.commands.map((c) => c.command).join(',') === 'start,lang,play,rules',
    JSON.stringify(defaultList.commands));
  ok('its descriptions are English', defaultList.commands[0]?.description === 'Open the main menu');
  ok('the second list is Persian and scoped to that language',
    persianList.language_code === 'fa' && persianList.commands[3]?.description === 'راهنمای بازی',
    JSON.stringify(persianList));
  ok('the third is Arabic',
    arabicList.language_code === 'ar' && arabicList.commands[2]?.description === 'ابدأ سباقاً فوراً',
    JSON.stringify(arabicList?.language_code));
  ok('every list is scoped to all_private_chats',
    commandLists.every((c) => c.scope?.type === 'all_private_chats'));

  const menuButton = last('setChatMenuButton').menu_button ?? {};
  ok('the chat menu button opens the Mini App',
    menuButton.type === 'web_app' && menuButton.web_app?.url === LIVE, JSON.stringify(menuButton));
  ok('and is labelled short enough for the client', (menuButton.text ?? '').length > 0 && menuButton.text.length <= 31);

  ok('the bot identity comes from the shared config, not getMe', report.bot === 'Tactix_Robot', JSON.stringify(report.bot));
  ok('getMe is still reported so a renamed bot is visible to the operator',
    report.steps.getMe.ok === true && /detour_real_bot/.test(report.steps.getMe.detail ?? ''),
    JSON.stringify(report.steps.getMe));
  ok('webhook info comes back so the operator can see what Telegram thinks',
    report.steps.getWebhookInfo.ok === true);

  /* every invite link is built from the same shared config, whatever getMe says */
  resetApi();
  await rt.webhook(callback('menu:invite:en', { from: 600030 }));
  ok('a renamed bot never silently rewrites the link identity',
    /https:\/\/t\.me\/Tactix_Robot\/app\?startapp=ref_[a-z0-9]{12}/.test(last('editMessageText').text),
    last('editMessageText').text.slice(0, 80));

  /* a configured secret is registered and required */
  resetApi();
  const guarded = runtime({ TELEGRAM_WEBHOOK_SECRET: 's3cret', WEBAPP_URL: LIVE });
  await guarded.route(`https://${HOST}/telegram/setup-webhook`, { headers: asAdmin() });
  ok('a configured secret_token is registered with the webhook',
    last('setWebhook').secret_token === 's3cret', JSON.stringify(last('setWebhook')));

  /* the loopback dev door, and the origin-relative registration it implies */
  resetApi();
  const dev = runtime({ DEV_AUTH: 'true' });
  await dev.route('http://127.0.0.1:8787/telegram/setup-webhook?admin=1');
  ok('the dev door opens setup on loopback', calls.some((c) => c.method === 'setWebhook'));
  ok('and registers the local worker, so wrangler dev is wired with one call',
    last('setWebhook').url === 'http://127.0.0.1:8787/telegram/webhook', JSON.stringify(last('setWebhook')));
  ok('with no WEBAPP_URL set, the buttons point at the same local origin',
    last('setChatMenuButton').menu_button.web_app.url === 'http://127.0.0.1:8787',
    JSON.stringify(last('setChatMenuButton')));

  /* a rejected step is reported, not thrown */
  resetApi();
  answerWith('getMe', { id: 777, username: 'detour_real_bot' });
  failNext('setChatMenuButton', 400, 'Bad Request: can not parse the string as a json object');
  const partial = await guarded.route(`https://${HOST}/telegram/setup-webhook`, { headers: asAdmin() });
  const partialReport = bodyOf(partial);
  ok('one rejected Telegram call answers 502 with the rest still applied',
    partial.status === 502 && partialReport.ok === false
      && partialReport.failed?.join(',') === 'setChatMenuButton'
      && partialReport.steps?.setWebhook?.ok === true, partial.body);
  ok("and the reason is Telegram's own words",
    /can not parse/.test(partialReport.steps?.setChatMenuButton?.detail ?? ''),
    JSON.stringify(partialReport.steps?.setChatMenuButton));

  const noToken = runtime({ TELEGRAM_BOT_TOKEN: '' });
  const untrusted = await noToken.route(`https://${HOST}/telegram/setup-webhook`, { headers: asAdmin() });
  ok('with no bot token, the allowlisted signed id reaches setup, which then names the missing token',
    untrusted.status === 503 && bodyOf(untrusted).error === 'no_bot_token', `status ${untrusted.status}`);

  const devNoToken = runtime({ TELEGRAM_BOT_TOKEN: '', DEV_AUTH: 'true' });
  const unconfigured = await devNoToken.route('http://127.0.0.1:8787/telegram/setup-webhook?admin=1');
  ok('a dev-marked local caller is told the token is missing, with 503 and the reason',
    unconfigured.status === 503 && bodyOf(unconfigured).error === 'no_bot_token', unconfigured.body);
}

/* ---------- 10. the copy itself ---------- */

console.log('\n-- the copy --');
{
  const rt = runtime();
  for (const [code, user] of [['en', 700001], ['fa', 700002], ['ar', 700003]]) {
    resetApi();
    await rt.webhook(callback(`lang:${code}`, { from: user }));
    await rt.webhook(callback(`menu:rules:${code}`, { from: user }));
    const [menu, rules] = sent('editMessageText');
    ok(`${code}: the welcome asks for speed and wit`, /ARENA|میدان نبرد|ساحة/.test(menu.text));
    ok(`${code}: the rules card is longer than the menu, as written`, rules.text.length > 300);
    ok(`${code}: every bold run became a tag`, (rules.text.match(/<b>/g) ?? []).length === (rules.text.match(/<\/b>/g) ?? []).length
      && (rules.text.match(/<b>/g) ?? []).length >= 3);
    ok(`${code}: no stray angle bracket survives unescaped`,
      !/[<>]/.test(rules.text.replace(/<\/?b>/g, '')), rules.text.replace(/<\/?b>/g, '').match(/[<>]/g)?.join(''));
    ok(`${code}: the three turn bullets are all there`,
      (rules.text.match(/•/g) ?? []).length >= 3, String((rules.text.match(/•/g) ?? []).length));
  }
}

console.log(`\n${ran - failed}/${ran} telegram checks passed`);
if (failed > 0) process.exit(1);
