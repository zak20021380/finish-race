/**
 * index.ts — the worker in front of the waiting room.
 *
 * The public surface is two routes: `GET /health` for a liveness probe, and `GET /ws/matchmake`,
 * which is handed straight to the singleton `MatchmakerDO`. The Durable Object owns the upgrade —
 * it verifies initData, pairs, and then relays the race on that same socket — because a
 * `WebSocket` cannot be passed through `fetch`, only the upgrade request can.
 *
 * The third surface is the Admin Command Center's, and it is not public: `GET /admin/status`,
 * `POST /admin/config`, `POST /admin/action`, `GET /admin/players` and `POST /admin/player` are
 * checked by `verifyAdminRequest` here — a Telegram signature on the `ADMIN_IDS` allowlist, or an
 * explicitly marked dev request — and only then forwarded to the same `MatchmakerDO`, which owns
 * the live config, the player directory, and enforces both. An unauthenticated call never reaches
 * the room: it answers `403`.
 *
 * The fourth surface is the same Command Center, under its `/api/*` spelling: the role registry
 * (`GET /api/admin/roles`, `POST /api/admin/roles/grant|revoke`), the broadcast engine
 * (`GET /api/admin/broadcasts`, `POST /api/admin/broadcasts/create`, and
 * `POST /api/admin/broadcasts/:id/archive`) — plus the one public route the players read,
 * `GET /api/client/announcements/active`.
 *
 * Both admin prefixes are only *authenticated* here (`identifyAdminRequest`): a signature that
 * holds, or the marked dev door. Authorization is the room's, because the role registry lives
 * there: the DO admits exactly the ids on its registry (or the dev door), routes reads to
 * members, and puts every mutation behind the `isSuperAdmin` middleware. A caller who is not
 * on the registry answers `403` from the room, not from the edge.
 *
 * The fifth surface is the Genius Triad's edition ledger: `GET /api/badges/supply` is public,
 * while `POST /api/badges/progress` and `POST /api/badges/mint` pass the player door above and
 * are forwarded to the singleton `BadgeMintDO`. The edge owns the identity header; the ledger
 * owns the caps, counters and claims.
 */
import { MatchmakerDO } from './matchmaker';
import { BadgeMintDO } from './badges';
import { identifyAdminRequest, identifyPlayerRequest } from './auth';
import { json } from './http';
import type { Env } from './env';

export { MatchmakerDO, BadgeMintDO };

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/badges/')) return badges(request, env, url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'detour-matchmaking', time: Date.now() });
    }

    /* The referral hub's ledger seam. Device-local today, so the mock answers zeroes for every
       code; a real referral ledger slots in here with the same shape `referral.ts` merges. */
    if (url.pathname === '/referral/state') {
      const code = (url.searchParams.get('code') ?? '').slice(0, 32);
      return json({ ok: true, service: 'detour-referral', code, joins: 0, unclaimed: 0 });
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

    /* The Command Center's routes: authenticated here, then handed to the room that authorizes. */
    if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/api/admin/')) {
      const admin = await identifyAdminRequest(request, env);
      if (!admin) return json({ error: 'forbidden', hint: 'admin credentials required' }, 403);
      const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
      return lobby.fetch(request);
    }

    /* Everything that is not a backend surface is the Mini App itself: `/`, the hashed bundles
       and any other page the client asks for. A missing backend route stays a JSON 404 rather
       than quietly answering with the game's HTML. */
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
      return json({ error: 'not_found' }, 404);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);

    return json({ error: 'not_found' }, 404);
  },
};
