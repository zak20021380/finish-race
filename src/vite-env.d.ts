/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The matchmaking socket, when it is not same-origin — e.g.
   * `wss://detour-matchmaking.<account>.workers.dev/ws/matchmake`. Unset (or empty) means the
   * transport connects to `/ws/matchmake` on the page's own origin.
   */
  readonly VITE_WS_URL?: string;
  /**
   * Extra Telegram user ids allowed into the Admin Command Center, comma-separated.
   * The built-in `ADMIN_IDS` list in `src/admin.ts` is always honoured; outside Telegram
   * (or on a loopback host) the panel opens anyway so a browser can test it.
   */
  readonly VITE_ADMIN_IDS?: string;
}
