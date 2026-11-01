/**
 * premium.ts — the one entitlement door for the VIP layer of the post-match capsule.
 *
 * Two things can answer `isPremiumUser()`, and only one of them is worth anything to a rival:
 *
 *  - **Telegram Premium.** `initDataUnsafe.user.is_premium` rides the Mini App's signed initData.
 *    The worker verifies that signature (`worker/auth.ts`) and stamps the seat, so the gold bubble
 *    the other player sees is an entitlement the server vouched for — not a decoration the sender
 *    painted on its own frame. Nothing on this device can fake it.
 *  - **A preview pass.** Granted by the store sheet inside a plain browser tab (or by `?vip=1`),
 *    it exists so the VIP surfaces can be seen and reviewed outside Telegram. It never persists,
 *    and the worker only honours a claimed flag for a GUEST seat — a guest holds no ladder
 *    position, no wallet and no standing, so there is nothing there worth forging. A signed
 *    account is judged by its signature alone.
 *
 * Every VIP surface in the app reads this module. There is no second `isPremium` anywhere.
 */
import { tgUser } from './telegram';

let preview = false;

try {
  const query = new URLSearchParams(window.location.search);
  preview = query.get('vip') === '1' || window.location.hash.replace(/^#/, '') === 'vip';
} catch { /* no URL to read (headless) */ }

/** Where the entitlement came from — the store sheet says a different sentence for each. */
export type VipSource = 'telegram' | 'preview' | 'none';

export function vipSource(): VipSource {
  if (tgUser()?.is_premium === true) return 'telegram';
  if (preview) return 'preview';
  return 'none';
}

/** The one question every gated surface asks. */
export const isPremiumUser = (): boolean => vipSource() !== 'none';

/** True inside a Mini App session, premium or not: only there can Telegram sell the upgrade. */
export const insideTelegram = (): boolean => tgUser()?.id !== undefined;

/**
 * The browser demo's door. Never a purchase and never stored: a reload takes the pass away, so a
 * preview can never be mistaken for a licence.
 */
export function grantVipPreview(): void {
  preview = true;
}
