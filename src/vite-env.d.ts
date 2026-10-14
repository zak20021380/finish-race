/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The matchmaking socket, when it is not same-origin — e.g.
   * `wss://detour-matchmaking.<account>.workers.dev/ws/matchmake`. Unset (or empty) means the
   * transport connects to `/ws/matchmake` on the page's own origin.
   */
  readonly VITE_WS_URL?: string;
}
