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
  /**
   * AdsGram rewarded-video block ids. `RECOVER` pays the TIQ recovery, `COINS` pays the
   * double-coins claim; both fall back to the shared `VITE_ADSGRAM_BLOCK_ID` when unset.
   * An empty id is not an error: `src/ads.ts` answers `no_sdk` and the buttons stay honest.
   */
  readonly VITE_ADSGRAM_BLOCK_ID?: string;
  readonly VITE_ADSGRAM_RECOVER_BLOCK_ID?: string;
  readonly VITE_ADSGRAM_COINS_BLOCK_ID?: string;
  /** `'true'` turns on the SDK's own console logging. Anything else is off. */
  readonly VITE_ADSGRAM_DEBUG?: string;
}
