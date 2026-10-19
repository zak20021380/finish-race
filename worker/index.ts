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
 */
import { MatchmakerDO } from './matchmaker';
import { identifyAdminRequest } from './auth';
import { json } from './http';
import type { Env } from './env';

export { MatchmakerDO };

/** One waiting room for everyone: that is the whole point of the singleton. */
const LOBBY = 'global';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

    /* The Command Center's routes: authenticated here, then handed to the room that authorizes. */
    if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/api/admin/')) {
      const admin = await identifyAdminRequest(request, env);
      if (!admin) return json({ error: 'forbidden', hint: 'admin credentials required' }, 403);
      const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
      return lobby.fetch(request);
    }

    return json({ error: 'not_found' }, 404);
  },
};
