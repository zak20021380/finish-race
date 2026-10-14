/**
 * env.ts — everything wrangler hands the worker: one binding and two settings.
 *
 * Kept in its own module so `auth.ts` can type the environment without importing the worker
 * entry point (which imports the Durable Object, which imports auth).
 */

export interface Env {
  /** The Durable Object namespace bound as `MATCHMAKER` in wrangler.toml. */
  MATCHMAKER: DurableObjectNamespace;
  /** Bot token used to verify Mini App initData. A secret, never a var:
   *  `npx wrangler secret put TELEGRAM_BOT_TOKEN`. */
  TELEGRAM_BOT_TOKEN?: string;
  /** `"true"` opens the guest door for local work (see `DEV_AUTH` in wrangler.toml). */
  DEV_AUTH?: string;
  /** Comma-separated Telegram user ids allowed through the `/admin/*` routes — the server-side
   *  half of the Command Center's allowlist (`ADMIN_IDS` in `src/admin.ts`). A var, not a secret:
   *  `ADMIN_IDS = "123456789,987654321"`. An empty value closes the Telegram door entirely. */
  ADMIN_IDS?: string;
}
