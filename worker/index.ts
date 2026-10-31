/**
 * index.ts — the worker in front of the waiting room.
 *
 * The public surface is two routes: `GET /health` for a liveness probe, and `GET /ws/matchmake`,
 * which is handed straight to the singleton `MatchmakerDO`. The Durable Object owns the upgrade —
 * it verifies initData, pairs, and then relays the race on that same socket — because a
 * `WebSocket` cannot be passed through `fetch`, only the upgrade request can.
 *
 * The third surface is the Admin Command Center's, and it is not public: `GET /admin/status`,
 * `GET /api/admin/matchmaking`, `POST /admin/config`, `POST /admin/action`, `GET /admin/players`
 * and `POST /admin/player` are checked by `identifyAdminRequest` here — an operator key, a held
 * Telegram signature, or an explicitly marked dev request — and only then forwarded to the same
 * `MatchmakerDO`, which owns the live config, the player directory, and enforces both. An
 * unauthenticated call never reaches the room: it answers `403`.
 *
 * The fourth surface is the same Command Center, under its `/api/*` spelling: the role registry
 * (`GET /api/admin/roles`, `POST /api/admin/roles/grant|revoke`), the broadcast engine
 * (`GET /api/admin/broadcasts`, `POST /api/admin/broadcasts/create`, and
 * `POST /api/admin/broadcasts/:id/archive`) — plus the public routes the players read,
 * `GET /api/client/announcements/active`, the live Mind Ladder at `GET /api/client/minds`,
 * and the Nations Cup at `GET /api/nations/leaderboard` / `GET /api/nations/roster`.
 *
 * `GET /api/admin/metrics` is a stricter door than that surface: only an id on the operator set —
 * the metrics operator plus the deployment's `ADMIN_IDS` — proven by a credential, with no
 * development fallback. It reads the room's live counts and durable counters and answers exact
 * zeroes for empty state.
 *
 * Both admin prefixes are only *authenticated* here. Authorization is the room's, because the role
 * registry lives there: the DO admits exactly the ids on its registry (or the dev and operator-key
 * doors), routes reads to members, and puts every mutation behind the `isSuperAdmin` middleware. A
 * caller who is not on the registry answers `403` from the room, not from the edge.
 *
 * The fifth surface is the Genius Triad's edition ledger: `GET /api/badges/supply` is public,
 * while `POST /api/badges/progress` and `POST /api/badges/mint` pass the player door above and
 * are forwarded to the singleton `BadgeMintDO`. The edge owns the identity header; the ledger
 * owns the caps, counters and claims.
 *
 * The sixth surface is the bot's own chat, before the Mini App ever opens: Telegram posts updates to
 * `POST /telegram/webhook`, while `GET|POST /telegram/setup-webhook` registers that webhook, the
 * localised `/` command list and the chat menu button — behind the `ADMIN_IDS` door, because it
 * points a bot at a host. Both are answered at the edge (`worker/bot.ts`): no room state is
 * involved, so there is no reason to wake the Durable Object.
 *
 * Every refusal on every one of these surfaces answers JSON, with a reason in the body. An opaque
 * error page is the one thing a Command Center can only report as an offline Worker — and this
 * backend is not offline.
 *
 * The seventh surface is the referral ledger: `GET /api/referral/me` issues the caller's permanent
 * random code and reads its counters, while `POST /api/referral/gate` binds a pending invite, checks
 * channel membership, and settles the credit in that same request. `GET /referral/state?code=...`
 * is the public, non-enumerable read kept for older clients. All three are answered by the
 * singleton `REFERRALS` Durable Object.
 */
import { MatchmakerDO } from './matchmaker';
import { BadgeMintDO } from './badges';
import { ReferralLedgerDO, channelMembership, referralContact, referralLookup, referralMe, referralSettle } from './referrals';
import {
  identifyAdminRequest, identifyMetricsAdmin, identifyPlayerRequest, METRICS_HEADER,
} from './auth';
import { telegramSetup, telegramWebhook } from './bot';
import { json, reasonOf } from './http';
import { referralAppLink } from '../shared/config';
import type { Env } from './env';

export { MatchmakerDO, BadgeMintDO, ReferralLedgerDO };

/** One waiting room for everyone: that is the whole point of the singleton. */
const LOBBY = 'global';
/** One edition ledger for everyone: the caps are global, so the counter has one home. */
const LEDGER = 'global';

/* The client is served from Vite on another port during local work, and from the same origin in
   production. The badge API is token-authenticated (not cookie-authenticated), so a wildcard
   origin is enough and keeps `npm run dev` + `wrangler dev` working without a proxy. */
const BADGE_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-telegram-init-data, authorization, x-detour-dev-player',
  'access-control-max-age': '86400',
};

const badgeJson = (body: unknown, status = 200): Response => json(body, status, BADGE_CORS);

function withBadgeCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(BADGE_CORS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

/** The one answer that may honestly be read as an outage: a call to the room that never returned. */
const unreachable = (err: unknown, extra: Record<string, unknown> = {}): Response =>
  json({ error: 'matchmaker_unreachable', hint: reasonOf(err), code: 'do_unreachable', ...extra }, 503);

/**
 * The server telemetry door. Unlike `/admin/*`, this route has no development fallback: only an id
 * on the operator set may read it, proven by whatever credential opens the door — the initData
 * signature while the deployment holds a bot token, the operator key, or (only when there is no
 * secret left to sign with) a declared id the `ADMIN_IDS` allowlist recognises. The room re-checks
 * the internal marker before it hands anything back.
 *
 * Every answer carries a reason, and the room's own refusals keep their status: a credential the
 * operator set does not recognise has to read as a refusal, never as an outage.
 */
async function serverMetrics(request: Request, env: Env): Promise<Response> {
  const admin = await identifyMetricsAdmin(request, env);
  if (!admin) {
    return json({ error: 'unauthorized', hint: 'metrics operator required', code: 'admin_unauthorized' }, 403);
  }
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  if (!env.MATCHMAKER) return json({ error: 'matchmaker_unbound' }, 503);

  const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
  const headers = new Headers(request.headers);
  headers.set(METRICS_HEADER, admin.userId);
  /* The forwarded call is a GET with no body, so the caller's entity headers must not ride along. */
  headers.delete('content-length');
  headers.delete('content-type');

  /* The ping is the real round trip this request takes through the Durable Object. */
  const started = Date.now();
  let reply: Response;
  try {
    reply = await lobby.fetch(new Request(request.url, { method: 'GET', headers }));
  } catch (err) {
    return unreachable(err, { pingMs: Math.max(0, Date.now() - started) });
  }
  const pingMs = Math.max(0, Date.now() - started);
  const body = await reply.json().catch((): null => null) as Record<string, unknown> | null;

  if (!reply.ok) {
    /* A 4xx is a decision the room made, not an outage: pass its status and its reason through. */
    const status = reply.status >= 400 && reply.status < 500 ? reply.status : 502;
    return json({
      error: typeof body?.error === 'string' ? body.error : 'metrics_unavailable',
      hint: typeof body?.hint === 'string' ? body.hint : `room answered ${reply.status}`,
      code: 'room_refused',
      roomStatus: reply.status,
      pingMs,
    }, status);
  }
  if (!body || body.ok !== true) {
    return json({
      error: 'metrics_bad_response',
      hint: 'the room answered 200 without a metrics body',
      code: 'room_malformed',
      pingMs,
    }, 502);
  }
  return json({ ...body, pingMs });
}

/**
 * The edition surface: `GET /api/badges/supply` is public, while minting and the progress
 * snapshot require a verified player. The edge strips any client-supplied identity header
 * before handing the request to the singleton ledger; the object trusts only this door.
 */
async function badges(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: BADGE_CORS });
  }
  if (!env.BADGES) return badgeJson({ error: 'badges_unavailable' }, 503);

  const ledger = env.BADGES.get(env.BADGES.idFromName(LEDGER));

  if (url.pathname === '/api/badges/supply') {
    if (request.method !== 'GET') return badgeJson({ error: 'method_not_allowed' }, 405);
    return withBadgeCors(await ledger.fetch(request));
  }

  if (url.pathname === '/api/badges/mint' || url.pathname === '/api/badges/progress') {
    if (request.method !== 'POST') return badgeJson({ error: 'method_not_allowed' }, 405);
    const auth = await identifyPlayerRequest(request, env);
    if (!auth) return badgeJson({ success: false, error: 'UNAUTHORIZED' }, 401);
    const headers = new Headers(request.headers);
    headers.delete('x-detour-player');
    headers.set('x-detour-player', auth.playerId);
    /* URI-encoded so a non-Latin Telegram name survives the header's byte string. */
    headers.delete('x-detour-player-name');
    headers.set('x-detour-player-name', encodeURIComponent(auth.name));
    return withBadgeCors(await ledger.fetch(new Request(request, { headers })));
  }

  return badgeJson({ error: 'not_found' }, 404);
}

/** The referral surface is token-authenticated, so a wildcard origin is enough. */
const REFERRAL_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-telegram-init-data, authorization, x-detour-dev-player',
  'access-control-max-age': '86400',
};

const referralJson = (body: unknown, status = 200): Response => json(body, status, REFERRAL_CORS);

/**
 * The referral surface. Three doors:
 *
 *   - `POST /api/referral/gate` is the forced-join gate. The caller's signed initData names the
 *     invitee; the ref payload (when present) binds PENDING on first contact; the channel check
 *     runs here; a joined invitee is settled in the same request cycle, so the inviter's counter
 *     and both unclaimed pools move before this response leaves the Worker.
 *   - `GET /api/referral/me` is the modal's live stats read and creates the caller's permanent
 *     code on first open.
 *   - `GET /referral/state?code=...` is the public, code-addressed stats read kept for older
 *     clients; the code itself is random and non-enumerable.
 */
async function referrals(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: REFERRAL_CORS });

  if (url.pathname === '/referral/state') {
    if (request.method !== 'GET') return referralJson({ error: 'method_not_allowed' }, 405);
    if (!env.REFERRALS) return referralJson({ ok: false, error: 'referrals_unavailable' }, 503);
    const found = await referralLookup(env, url.searchParams.get('code') ?? '');
    return referralJson(found ?? { ok: false, error: 'referrals_unavailable' }, found ? 200 : 503);
  }

  if (url.pathname === '/api/referral/me' || url.pathname === '/api/referral/gate') {
    if (!env.REFERRALS) return referralJson({ ok: false, error: 'referrals_unavailable' }, 503);
    const gate = url.pathname === '/api/referral/gate';
    if (gate && request.method !== 'POST') return referralJson({ error: 'method_not_allowed' }, 405);
    if (!gate && request.method !== 'GET') return referralJson({ error: 'method_not_allowed' }, 405);

    const auth = await identifyPlayerRequest(request, env);
    if (!auth) return referralJson({ ok: false, error: 'unauthorized' }, 401);
    if (!auth.tgId) {
      /* The dev door has no Telegram identity to key a ledger row on. Say so plainly instead of
         inventing a code or a credit. */
      return referralJson({ ok: false, error: 'telegram_required' }, 403);
    }

    let body: Record<string, unknown> = {};
    if (gate) {
      body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    }
    const bodyRef = typeof body.ref === 'string' ? body.ref : '';
    const refRaw = bodyRef || url.searchParams.get('ref') || url.searchParams.get('startapp') || '';

    if (refRaw) await referralContact(env, auth.tgId, refRaw);
    const state = await referralMe(env, auth.tgId);
    if (!state) return referralJson({ ok: false, error: 'referrals_unavailable' }, 503);

    if (!gate) {
      return referralJson({ ...state, link: referralAppLink(state.code) });
    }

    const joined = await channelMembership(env, auth.tgId);
    if (joined !== true) {
      const unavailable = joined === null;
      return referralJson({
        ...state,
        link: referralAppLink(state.code),
        joined: false,
        ...(unavailable ? { unavailable: true } : {}),
      });
    }
    const settled = await referralSettle(env, auth.tgId);
    const after = settled ?? state;
    return referralJson({
      ...after,
      link: referralAppLink(after.code),
      joined: true,
      credited: settled?.creditedNow === true,
      alreadyCredited: settled?.alreadyCredited === true,
    });
  }

  return referralJson({ error: 'not_found' }, 404);
}

/** The whole routing table, in surface order. */
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/badges/')) return badges(request, env, url);

  if (url.pathname === '/health') {
    return json({ ok: true, service: 'detour-matchmaking', time: Date.now() });
  }

  /* The referral surface: the forced-join gate, the modal's live stats, and the public
     code-addressed read. The ledger is the singleton `REFERRALS` object. */
  if (url.pathname === '/referral/state' || url.pathname.startsWith('/api/referral/')) {
    return referrals(request, env, url);
  }

  if (url.pathname === '/api/squads/verify') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
    return lobby.fetch(request);
  }

  if (url.pathname === '/api/squads/register') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
    return lobby.fetch(request);
  }

  if (url.pathname === '/ws/matchmake') {
    const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
    return lobby.fetch(request);
  }

  /* The one public announcement feed: what a client reads to raise an urgent popup. */
  if (url.pathname === '/api/client/announcements/active') {
    const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
    return lobby.fetch(request);
  }

  /* The public tournament clock. The room verifies any initData itself, so the award that
     rides along is never keyed off a client-supplied identity header. */
  if (url.pathname === '/api/client/arena/state') {
    const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
    return lobby.fetch(request);
  }

  /* The public Mind Ladder: the room's own TIQ registry, ranked. Read-only and never cached. */
  if (url.pathname === '/api/client/minds') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
    return lobby.fetch(request);
  }

  /* The public Nations Cup: enrolled nations ranked by the points the room banked for them. */
  if (url.pathname === '/api/nations/leaderboard' || url.pathname === '/api/nations/roster') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
    return lobby.fetch(request);
  }

  /* The bot's chat surface. Telegram is the only caller of the webhook; the setup route is the
     operator's, and answers 403 until it carries admin credentials. */
  if (url.pathname === '/telegram/webhook') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed', hint: 'Telegram posts updates' }, 405);
    return telegramWebhook(request, env);
  }
  if (url.pathname === '/telegram/setup-webhook') return telegramSetup(request, env);

  /* The server telemetry route is stricter than the rest of the admin surface: the operator set,
     and no dev door. */
  if (url.pathname === '/api/admin/metrics') return serverMetrics(request, env);

  /* The Command Center's routes: authenticated here, then handed to the room that authorizes.
     A refusal names itself, so the panel never has to guess between a door and an outage. */
  if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/api/admin/')) {
    const admin = await identifyAdminRequest(request, env);
    if (!admin) return json({ error: 'forbidden', hint: 'admin credentials required', code: 'admin_unauthorized' }, 403);
    const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
    try {
      return await lobby.fetch(request);
    } catch (err) {
      return unreachable(err);
    }
  }

  /* Everything that is not a backend surface is the Mini App itself: `/`, the hashed bundles
     and any other page the client asks for. A missing backend route stays a JSON 404 rather
     than quietly answering with the game's HTML. */
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/') || url.pathname.startsWith('/telegram/')) {
    return json({ error: 'not_found', hint: `no route for ${url.pathname}`, code: 'no_route' }, 404);
  }
  if (env.ASSETS) return env.ASSETS.fetch(request);

  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    /* No route may answer as a bare Cloudflare error page. A body the panel cannot parse is, on
       the client, indistinguishable from a Worker that is not there at all — and that is how a
       live backend ends up reported offline. */
    try {
      return await route(request, env);
    } catch (err) {
      return json({ error: 'worker_error', hint: reasonOf(err), code: 'worker_exception' }, 500);
    }
  },
};
