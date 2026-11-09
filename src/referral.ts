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
import { lang, referralInvites } from './settings';
import {
  REFERRAL_CODE_ALPHABET, REFERRAL_CODE_LENGTH, REFERRAL_CODE_RE, REFERRAL_PREFIX, REFERRAL_REWARD,
  referralAppLink, referralPayload, telegramShareLink,
} from '../shared/config';
import { REFERRAL_CONFIG } from '../shared/referralConfig';

const DEVICE_KEY = 'detour.device.v1';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

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

/**
 * The fingerprint the Worker's device lock reads. A Telegram webview shares one localStorage
 * origin across every account logged into the phone, so this code is stable across exactly the
 * accounts a "one invited account per device" rule has to catch.
 */
export function deviceFingerprint(): string {
  return deviceCode();
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
  return telegramShareLink(link, inviteLine());
}

/**
 * The line that rides the link into a friend's chat, in the language the player reads in.
 *
 * Random by design, like the duel taunts: the same invite twice in a row reads as a script, and a
 * friend who has already seen it taps nothing. `{coins}` is filled last so a variant can never
 * carry a reward the campaign does not pay.
 */
function inviteLine(): string {
  const pool = referralInvites();
  const raw = (pool[Math.floor(Math.random() * pool.length)] ?? '').replace(/\s+/g, ' ').trim();
  const coins = REFERRAL_REWARD.toLocaleString('en-US');
  /* Persian copy reads with Persian figures; the share text is copy, not a form field. */
  const bonus = lang === 'fa' ? coins.replace(/\d/g, (d) => FA_DIGITS[Number(d)]) : coins;
  return raw.replace(/\{coins\}/g, bonus);
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
    'x-detour-device': deviceFingerprint(),
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

/* ---------- the Stars Vault ----------
 *
 * The two-stage Stars campaign is a different ledger from the coin credit above: the room watches
 * the boards the invited friend actually plays and decides both stages itself. Nothing here
 * computes a reward — these calls read a server verdict and hand it to the Profile card.
 */

export interface VaultFriend {
  id: string;
  name: string;
  avatar: string;
  matches: number;
  days: number;
  pvpMatches: number;
  opponents: number;
  pvpWins: number;
  arena: number;
  stage1: boolean;
  stage2: boolean;
  flagged: boolean;
  credited: number;
  queued: number;
}

export interface StarsVault {
  /** false until a server read lands: the card paints the opening gift, never a guessed balance. */
  live: boolean;
  starterBonus: number;
  earnedStars: number;
  paidOutStars: number;
  vaultBalance: number;
  pendingFriendsCount: number;
  qualifiedFriendsCount: number;
  threshold: number;
  canPayout: boolean;
  waiting: boolean;
  queuedStars: number;
  budgetLeft: number;
  friends: VaultFriend[];
}

const count = (value: unknown, max = 1_000_000): number => (
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : 0
);

const label = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');

/**
 * The opening state, straight from the campaign config: the pre-filled gift, the cash-out target
 * and no friends. This is what the server answers on a first read too, so the card never flashes
 * a different number before the live one lands.
 */
export function starterVault(): StarsVault {
  return {
    live: false,
    starterBonus: REFERRAL_CONFIG.STARTER_VAULT_GIFT_STARS,
    earnedStars: 0,
    paidOutStars: 0,
    vaultBalance: REFERRAL_CONFIG.STARTER_VAULT_GIFT_STARS,
    pendingFriendsCount: 0,
    qualifiedFriendsCount: 0,
    threshold: REFERRAL_CONFIG.MIN_PAYOUT_THRESHOLD_STARS,
    canPayout: false,
    waiting: false,
    queuedStars: 0,
    budgetLeft: REFERRAL_CONFIG.GLOBAL_MONTHLY_BUDGET_STARS,
    friends: [],
  };
}

function readVault(raw: unknown): StarsVault | null {
  const data = raw as Partial<StarsVault> & { ok?: unknown; friends?: unknown } | null;
  if (!data || data.ok !== true) return null;
  const friends: VaultFriend[] = [];
  if (Array.isArray(data.friends)) {
    for (const entry of data.friends) {
      const f = entry as Partial<VaultFriend> | null;
      if (!f || typeof f.id !== 'string' || !f.id) continue;
      friends.push({
        id: f.id.slice(0, 64),
        name: label(f.name, 48),
        avatar: label(f.avatar, 300),
        matches: count(f.matches),
        days: count(f.days, 366),
        pvpMatches: count(f.pvpMatches),
        opponents: count(f.opponents),
        pvpWins: count(f.pvpWins),
        arena: count(f.arena, 4),
        stage1: f.stage1 === true,
        stage2: f.stage2 === true,
        flagged: f.flagged === true,
        credited: count(f.credited, REFERRAL_CONFIG.TOTAL_PER_FRIEND_STARS),
        queued: count(f.queued, REFERRAL_CONFIG.TOTAL_PER_FRIEND_STARS),
      });
    }
  }
  const starterBonus = count(data.starterBonus, REFERRAL_CONFIG.STARTER_VAULT_GIFT_STARS);
  return {
    live: true,
    starterBonus,
    earnedStars: count(data.earnedStars),
    paidOutStars: count(data.paidOutStars),
    vaultBalance: count(data.vaultBalance),
    pendingFriendsCount: count(data.pendingFriendsCount),
    qualifiedFriendsCount: count(data.qualifiedFriendsCount),
    threshold: count(data.threshold) || REFERRAL_CONFIG.MIN_PAYOUT_THRESHOLD_STARS,
    canPayout: data.canPayout === true,
    waiting: data.waiting === true,
    queuedStars: count(data.queuedStars),
    budgetLeft: count(data.budgetLeft),
    friends,
  };
}

/**
 * Read the vault. Unlike the coin ledger this does not insist on a signed Telegram identity: the
 * room's marked dev door answers a local browser too, and a production call without one simply
 * refuses, leaving the card on its opening state.
 */
export async function fetchStarsVault(): Promise<StarsVault | null> {
  const url = workerUrl('/api/stars/vault');
  if (!url) return null;
  const t = timeout(7000);
  try {
    const res = await fetch(url, { signal: t.signal, headers: headers(), cache: 'no-store' });
    if (!res.ok) return null;
    return readVault(await res.json());
  } catch {
    return null;
  } finally {
    t.done();
  }
}

/** File the manual payout request. The owner settles it by hand; nothing is transferred here. */
export async function requestStarsPayout(): Promise<StarsVault | null> {
  const url = workerUrl('/api/stars/payout');
  if (!url) return null;
  const t = timeout(9000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: t.signal,
      headers: headers(),
      body: JSON.stringify({}),
    });
    if (!res.ok) return null;
    return readVault(await res.json());
  } catch {
    return null;
  } finally {
    t.done();
  }
}
