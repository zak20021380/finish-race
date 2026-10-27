/**
 * env.ts — everything wrangler hands the worker: one binding and two settings.
 *
 * Kept in its own module so `auth.ts` can type the environment without importing the worker
 * entry point (which imports the Durable Object, which imports auth).
 */

export interface Env {
  /** The Durable Object namespace bound as `MATCHMAKER` in wrangler.toml. */
  MATCHMAKER: DurableObjectNamespace;
  /** The singleton edition ledger: caps, counters and serialized badge claims. */
  BADGES: DurableObjectNamespace;
  /** The built frontend in `dist/`, bound as `ASSETS` in wrangler.toml. Absent only in the
   *  bare Node harness that drives the Worker without wrangler. */
  ASSETS?: Fetcher;
  /** Bot token used to verify Mini App initData. A secret, never a var:
   *  `npx wrangler secret put TELEGRAM_BOT_TOKEN`. */
  TELEGRAM_BOT_TOKEN?: string;
  /** The bot's numeric id, used to prove it is an administrator of a registered chat. Optional:
   *  the worker asks `getMe` when it is not set. */
  TELEGRAM_BOT_ID?: string;
  /** `"true"` opens the guest door for local work (see `DEV_AUTH` in wrangler.toml). */
  DEV_AUTH?: string;
  /** Optional deployment mode label for `/api/admin/metrics` (`production`, `staging`, ...).
   *  Unset, the worker reports `development` when `DEV_AUTH` is on or the host is loopback,
   *  and `production` otherwise. */
  WORKER_ENV?: string;
  /** Comma-separated Telegram user ids allowed through the `/admin/*` routes — the server-side
   *  half of the Command Center's allowlist (`ADMIN_IDS` in `src/admin.ts`). A var, not a secret:
   *  `ADMIN_IDS = "123456789,987654321"`. An empty value closes the Telegram door entirely. */
  ADMIN_IDS?: string;
  /** The operator's escape key for the whole admin surface, presented as `x-admin-key` or
   *  `Authorization: Bearer <key>`. A secret, and closed while unset:
   *  `npx wrangler secret put ADMIN_ACCESS_TOKEN`. It exists so a broken initData signature can
   *  never lock the owner out of their own Command Center. */
  ADMIN_ACCESS_TOKEN?: string;
  /** The Mini App the bot's `web_app` buttons and chat menu button open. Unset, the bot uses its own
   *  origin — which is right in production (the app and the API are one Worker) and right locally
   *  (a loopback origin is the app under development). Set it only to point the bot somewhere else. */
  WEBAPP_URL?: string;
  /** Sent as `secret_token` on `setWebhook` and required on every update posted to
   *  `/telegram/webhook`. A secret: `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET`. Unset leaves
   *  the webhook open to whatever Telegram posts — and to anything else that finds the URL. */
  TELEGRAM_WEBHOOK_SECRET?: string;
}
