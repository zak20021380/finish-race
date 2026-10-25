/**
 * referral.ts — the invite-to-earn engine behind Profile's "Invite Friends" card.
 *
 * The save owns the counters (`profile.referral` in storage.ts); this module owns the link, the
 * inbound half of the program and the optional backend seam. A personal link is
 * `https://t.me/<bot>?start=ref_<code>`, the code being the player's Telegram id when the client
 * has one and a stable device code otherwise — so the link is shareable even in a plain browser.
 *
 * When the app was pointed at a Worker (`VITE_WS_URL`), `pullReferral()` asks its `/referral/state`
 * route for the ledger's join count and credits any friends the server knows that this device has
 * not seen yet. Without a Worker the same call resolves to the local save — the same fallback
 * contract every other feature keeps, and the reason the Hub never depends on a backend being up.
 */
import {
  creditReferralJoin, markReferralWelcome, profile, readJson, writeJson,
} from './storage';
import { BOT_HANDLE, startParam, tgUser } from './telegram';

const DEVICE_KEY = 'detour.device.v1';

/** The device code a browser without a Telegram identity shares instead of `u<id>`. */
function deviceCode(): string {
  const box = readJson<{ code?: string }>(DEVICE_KEY);
  if (box && typeof box.code === 'string' && /^[A-Za-z0-9]{6,16}$/.test(box.code)) return box.code;
  const code = Math.random().toString(36).slice(2, 10);
  writeJson(DEVICE_KEY, { code });
  return code;
}

/** This player's shareable code: their Telegram id when there is one, else the device code. */
export function referralCode(): string {
  const id = tgUser()?.id;
  return id === undefined ? deviceCode() : `u${id}`;
}

/** The personal invite link: what the Hub shows, copies and shares. */
export function referralLink(): string {
  return `https://t.me/${BOT_HANDLE}?start=ref_${referralCode()}`;
}

/** The Telegram share-sheet URL for the personal link. */
export function referralShareUrl(): string {
  const url = encodeURIComponent(referralLink());
  const text = encodeURIComponent('Race me on Detour — we both get 500 coins when you join!');
  return `https://t.me/share/url?url=${url}&text=${text}`;
}

/** The inbound `ref_` code this launch carried, or null (its own code is not a referral). */
function inboundReferral(): string | null {
  const m = /^ref_([A-Za-z0-9_-]{1,32})$/.exec(startParam());
  if (!m) return null;
  return m[1] === referralCode() ? null : m[1];
}

/**
 * Pays the invitee's welcome bonus once, on the launch that carried a `ref_` link. Returns the
 * coins paid, or 0 when this launch had no inbound referral or the bonus was already banked.
 */
export function claimWelcomeBonus(): number {
  const via = inboundReferral();
  return via === null ? 0 : markReferralWelcome(via);
}

/** The Worker base for the referral ledger, or '' when the app runs without one. */
function workerBase(): string {
  const ws = import.meta.env?.VITE_WS_URL?.trim();
  if (!ws) return '';
  const base = ws.startsWith('http') ? ws : `https://${ws}`;
  return base.replace(/^ws/, 'http').replace(/\/+$/, '');
}

interface LedgerState { ok?: boolean; joins?: number; unclaimed?: number }

/**
 * Ask the Worker for the ledger when the app was pointed at one and fold any join the server knows
 * into the save. Best-effort: a Worker that is absent, slow, or refuses answers the same as the
 * local-only case. Returns true when the local counters moved.
 */
export async function pullReferral(): Promise<boolean> {
  const base = workerBase();
  if (!base) return false;
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), 2500);
  try {
    const res = await fetch(`${base}/referral/state?code=${encodeURIComponent(referralCode())}`, {
      signal: ac.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as LedgerState;
    const joins = typeof data.joins === 'number' && Number.isFinite(data.joins) ? Math.floor(data.joins) : 0;
    if (data.ok !== true || joins <= profile.referral.joins) return false;
    creditReferralJoin(joins - profile.referral.joins);
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}
