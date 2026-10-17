/**
 * index.ts — the worker in front of the waiting room.
 *
 * The public surface is two routes: `GET /health` for a liveness probe, and `GET /ws/matchmake`,
 * which is handed straight to the singleton `MatchmakerDO`. The Durable Object owns the upgrade —
 * it verifies initData, pairs, and then relays the race on that same socket — because a
 * `WebSocket` cannot be passed through `fetch`, only the upgrade request can.
 *
 * The third surface is the Admin Command Center's, and it is not public: `GET /admin/status`,
 * `POST /admin/config` and `POST /admin/action` are checked by `verifyAdminRequest` here — a
 * Telegram signature on the `ADMIN_IDS` allowlist, or an explicitly marked dev request — and only
 * then forwarded to the same `MatchmakerDO`, which owns the live config and enforces it. An
 * unauthenticated call never reaches the room: it answers `403`.
 */
import { MatchmakerDO } from './matchmaker';
import { verifyAdminRequest } from './auth';
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

    if (url.pathname === '/ws/matchmake') {
      const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
      return lobby.fetch(request);
    }

    /* The Command Center's routes: verified here, then handed to the room that enforces them. */
    if (url.pathname.startsWith('/admin/')) {
      const admin = await verifyAdminRequest(request, env);
      if (!admin) return json({ error: 'forbidden', hint: 'admin credentials required' }, 403);
      const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
      return lobby.fetch(request);
    }

    return json({ error: 'not_found' }, 404);
  },
};
