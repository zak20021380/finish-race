/**
 * index.ts — the worker in front of the waiting room.
 *
 * Two routes and nothing else: `GET /health` for a liveness probe, and `GET /ws/matchmake`, which
 * is handed straight to the singleton `MatchmakerDO`. The Durable Object owns the upgrade — it
 * verifies initData and pairs — because a `WebSocket` cannot be passed through `fetch`, only the
 * upgrade request can.
 */
import { MatchmakerDO } from './matchmaker';
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

    if (url.pathname === '/ws/matchmake') {
      const lobby = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(LOBBY));
      return lobby.fetch(request);
    }

    return json({ error: 'not_found' }, 404);
  },
};
