/**
 * referral.ts — the invite-to-earn engine behind Profile's "Invite Friends" card.
 *
 * The Worker's referral ledger is the authority: it owns the player's permanent random code, the
 * pending referral bound on first contact, and the credited counters that move the instant the
 * forced-join gate verifies channel membership. This module only reads and folds that ledger into
 * the save, and builds the one link both the Copy and Share keys use:
 *
 *   https://t.me/<BOT_HANDLE>/play?startapp=ref_<code>
 *
 * The bot's `/start ref_<code>` path resolves to the same pending row, so a player who lands in
 * the chat first is attributed exactly like one who opens the Mini App directly.
 *
 * A plain browser tab has no signed Telegram identity, so it keeps a stable device code for the
 * local demo; a real Mini App always shows the server code.
 */
import { profile, readJson, syncReferralLedger, writeJson } from './storage';
import { startParam, tgInitData } from './telegram';
import { workerUrl } from './adminApi';
import {
  REFERRAL_CODE_ALPHABET, REFERRAL_CODE_LENGTH, REFERRAL_CODE_RE, REFERRAL_PREFIX, REFERRAL_REWARD,
  referralAppLink, referralPayload, telegramShareLink,
} from '../shared/config';

const DEVICE_KEY = 'detour.device.v1';

interface LedgerReading {
  ok?: boolean;
  code?: unknown;
  joins?: unknown;
  earned?: unknown;
  pending?: unknown;
  credited?: unknown;
  joined?: unknown;
  unavailable?: unknown;
  link?: unknown;
  error?: unknown;
}

export interface GateResult {
  ok: boolean;
  joined: boolean;
  unavailable: boolean;
  credited: boolean;
  earned: number;
}

/** The device code a browser without a Telegram identity shares instead of a server code. */
function deviceCode(): string {
  const box = readJson<{ code?: string }>(DEVICE_KEY);
  if (box && typeof box.code === 'string' && REFERRAL_CODE_RE.test(box.code)) return box.code;
  const bytes = new Uint8Array(REFERRAL_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const byte of bytes) code += REFERRAL_CODE_ALPHABET[byte % REFERRAL_CODE_ALPHABET.length];
  writeJson(DEVICE_KEY, { code });
  return code;
}

/** A signed Mini App session: the only case in which the Worker can own this player's code. */
export function hasServerIdentity(): boolean {
  return Boolean(tgInitData() && workerUrl(''));
}

/**
 * This player's shareable code. The server cache wins; a plain browser (or a Mini App whose first
 * read has not landed yet) falls back to the stable device code only when there is no signed
 * identity to create a real one with.
 */
export function referralCode(): string {
  const cached = profile.referral.code;
  if (typeof cached === 'string' && REFERRAL_CODE_RE.test(cached)) return cached;
  if (hasServerIdentity()) return '';
  return deviceCode();
}

/** The personal invite link: what the Hub shows, copies and shares. */
export function referralLink(): string {
  const code = referralCode();
  return code ? referralAppLink(code) : '';
}

/** The Telegram share-sheet URL for the personal link. */
export function referralShareUrl(): string {
  const link = referralLink();
  if (!link) return '';
  return telegramShareLink(link, `Race me on Tactix — we both get ${REFERRAL_REWARD.toLocaleString('en-US')} coins when you join!`);
}

/** The inbound `ref_` code this launch carried, or null (its own code is not a referral). */
export function inboundReferralCode(): string | null {
  const raw = startParam();
  if (!raw.startsWith(REFERRAL_PREFIX)) return null;
  const code = raw.slice(REFERRAL_PREFIX.length).trim();
  if (!REFERRAL_CODE_RE.test(code)) return null;
  return code === referralCode() ? null : code;
}

function headers(): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-telegram-init-data': tgInitData(),
  };
}

function timeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => window.clearTimeout(timer) };
}

function fold(data: LedgerReading | null): boolean {
  if (!data || data.ok !== true) return false;
  return syncReferralLedger({
    code: typeof data.code === 'string' ? data.code : '',
    joins: typeof data.joins === 'number' ? data.joins : 0,
    earned: typeof data.earned === 'number' ? data.earned : 0,
  });
}

/**
 * Read the ledger and fold any new credit into the save. Called on boot, when the Hub opens, and
 * on a short poll while the Hub stays open — so an inviter watching the sheet sees a friend's
 * join land without closing and reopening it.
 *
 * Concurrent callers share one in-flight read: a slow network must not stack six polls.
 */
let refreshInFlight: Promise<boolean> | null = null;

export function refreshReferral(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = fetchReferralState().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function fetchReferralState(): Promise<boolean> {
  const url = workerUrl('/api/referral/me');
  if (!url || !tgInitData()) return false;
  const t = timeout(6000);
  try {
    const ref = inboundReferralCode();
    const query = ref ? `?ref=${encodeURIComponent(referralPayload(ref))}` : '';
    const res = await fetch(`${url}${query}`, { signal: t.signal, headers: headers() });
    if (!res.ok) return false;
    return fold((await res.json()) as LedgerReading);
  } catch {
    return false;
  } finally {
    t.done();
  }
}

/**
 * The forced-join gate check. Posts the launch payload (when it is a referral), verifies channel
 * membership server-side, and lets the ledger settle in that same request. `null` means the
 * caller could not ask at all (outside Telegram or no Worker), so the gate must stay open.
 */
export async function gateReferral(): Promise<GateResult | null> {
  const url = workerUrl('/api/referral/gate');
  if (!url || !tgInitData()) return null;
  const t = timeout(8000);
  try {
    const ref = inboundReferralCode();
    const res = await fetch(url, {
      method: 'POST',
      signal: t.signal,
      headers: headers(),
      body: JSON.stringify({ ref: ref ? referralPayload(ref) : '' }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as LedgerReading;
    if (data.ok !== true) return null;
    fold(data);
    return {
      ok: true,
      joined: data.joined === true,
      unavailable: data.unavailable === true,
      credited: data.credited === true,
      earned: typeof data.earned === 'number' ? data.earned : 0,
    };
  } catch {
    return null;
  } finally {
    t.done();
  }
}
