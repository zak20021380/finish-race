/**
 * referrals.ts — the referral ledger: one permanent code per player, one pending referral per
 * invitee, and the atomic credit that flips it the moment the forced-join gate verifies the
 * channel membership.
 *
 * The object is a singleton (`idFromName('global')`), so every contact, every `/start` and every
 * gate check is serialized through one owner. That is what makes "exactly once" a property of the
 * data rather than a race the edge hopes to win: an invitee either has a pending row (credit it
 * once) or a `creditedFrom` stamp (never again).
 *
 * Codes are random base36, 12 characters. They are looked up in a map, never derived from a user
 * id, so a guessed `ref_u123` cannot enumerate the program.
 */
import { json } from './http';
import type { Env } from './env';
import {
  REFERRAL_CODE_ALPHABET, REFERRAL_CODE_LENGTH, REFERRAL_CODE_RE, REFERRAL_PREFIX, REFERRAL_REWARD,
  CHANNEL_HANDLE,
} from '../shared/config';

const USER_PREFIX = 'ref:user:';
const TELEGRAM_BASE = 'https://api.telegram.org/bot';
const TG_ID = /^[0-9]{1,20}$/;
const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);

interface ReferralUserRow {
  /** Numeric Telegram user id, as a string. */
  id: string;
  /** The player's permanent, random referral code. */
  code: string;
  createdAt: number;
  firstSeenAt: number;
  /** Friends this player invited who passed the join gate. */
  joins: number;
  /** Lifetime coins credited to this player by the program. */
  earned: number;
  /** The inviter waiting for this invitee to pass the gate, or ''. */
  pendingFrom: string;
  pendingCode: string;
  pendingAt: number;
  /** The inviter this user was credited to, once. */
  creditedFrom: string;
  creditedAt: number;
}

export interface ReferralStatePayload {
  ok: true;
  userId: string;
  code: string;
  joins: number;
  earned: number;
  unclaimed: number;
  pending: boolean;
  credited: boolean;
}

export interface ReferralContactPayload extends ReferralStatePayload {
  /** The payload named a real referrer. */
  valid: boolean;
  /** This contact bound a fresh pending referral. */
  bound: boolean;
  /** The payload was the caller's own code. */
  self: boolean;
}

export interface ReferralSettlePayload extends ReferralStatePayload {
  creditedNow: boolean;
  alreadyCredited: boolean;
}

export interface ReferralLookupPayload {
  ok: true;
  valid: boolean;
  code: string;
  joins: number;
  earned: number;
  unclaimed: number;
}

const whole = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value)
  ? Math.max(0, Math.floor(value))
  : 0);

/** A stored code is kept only when it still has the shape this ledger generates. */
export function readReferralCode(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const code = value.startsWith(REFERRAL_PREFIX) ? value.slice(REFERRAL_PREFIX.length) : value;
  return REFERRAL_CODE_RE.test(code) ? code : '';
}

/** A start payload (from `?startapp=` or `/start`) that names a referral, or ''. */
export function readReferralPayload(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value.startsWith(REFERRAL_PREFIX) ? readReferralCode(value) : '';
}

function readRow(raw: unknown): ReferralUserRow | null {
  const row = raw as Partial<ReferralUserRow> | null | undefined;
  if (!row) return null;
  const id = typeof row.id === 'string' ? row.id.replace(/[^0-9]/g, '').slice(0, 20) : '';
  const code = readReferralCode(row.code);
  if (!id || !TG_ID.test(id) || !code) return null;
  const pendingFrom = typeof row.pendingFrom === 'string' ? row.pendingFrom.replace(/[^0-9]/g, '').slice(0, 20) : '';
  const creditedFrom = typeof row.creditedFrom === 'string' ? row.creditedFrom.replace(/[^0-9]/g, '').slice(0, 20) : '';
  return {
    id,
    code,
    createdAt: whole(row.createdAt),
    firstSeenAt: whole(row.firstSeenAt),
    joins: Math.min(100_000, whole(row.joins)),
    earned: Math.min(100_000_000, whole(row.earned)),
    pendingFrom: pendingFrom && pendingFrom !== id ? pendingFrom : '',
    pendingCode: readReferralCode(row.pendingCode),
    pendingAt: whole(row.pendingAt),
    creditedFrom: creditedFrom && creditedFrom !== id ? creditedFrom : '',
    creditedAt: whole(row.creditedAt),
  };
}

/** A code nobody in the ledger owns. Random reads make enumeration useless; collisions are retried. */
function freshCode(used: Map<string, string>): string {
  const bytes = new Uint8Array(REFERRAL_CODE_LENGTH);
  for (let attempt = 0; attempt < 16; attempt++) {
    crypto.getRandomValues(bytes);
    let out = '';
    for (const byte of bytes) out += REFERRAL_CODE_ALPHABET[byte % REFERRAL_CODE_ALPHABET.length];
    if (!used.has(out)) return out;
  }
  /* Practically unreachable: a 12-char base36 space is 4.7e18. Still never return a duplicate. */
  throw new Error('referral_code_exhausted');
}

const stateOf = (row: ReferralUserRow): ReferralStatePayload => ({
  ok: true,
  userId: row.id,
  code: row.code,
  joins: row.joins,
  earned: row.earned,
  unclaimed: row.earned,
  pending: Boolean(row.pendingFrom),
  credited: Boolean(row.creditedFrom),
});

/* ---------- the Durable Object ---------- */

export class ReferralLedgerDO {
  private users = new Map<string, ReferralUserRow>();
  private codes = new Map<string, string>();
  private ready: Promise<void>;

  constructor(private state: DurableObjectState, private env: Env) {
    const load = async () => {
      try {
        const entries = await this.state?.storage?.list<unknown>({ prefix: USER_PREFIX });
        if (!entries) return;
        const repaired: ReferralUserRow[] = [];
        for (const raw of entries.values()) {
          const row = readRow(raw);
          if (!row) continue;
          if (this.codes.has(row.code)) {
            row.code = freshCode(this.codes);
            repaired.push(row);
          }
          this.users.set(row.id, row);
          this.codes.set(row.code, row.id);
        }
        if (repaired.length) await this.persistRows(repaired);
      } catch {
        /* A store that refuses the read starts empty; the next write is the first durable claim. */
      }
    };
    this.ready = typeof this.state?.blockConcurrencyWhile === 'function'
      ? this.state.blockConcurrencyWhile(load)
      : load();
  }

  private storage(): DurableObjectState['storage'] {
    return this.state?.storage;
  }

  private persistRow(row: ReferralUserRow): Promise<void> {
    const storage = this.storage();
    if (!storage) return Promise.resolve();
    return storage.put(`${USER_PREFIX}${row.id}`, row);
  }

  /** One atomic write for the two rows a credit touches. */
  private persistRows(rows: ReferralUserRow[]): Promise<void> {
    const storage = this.storage();
    if (!storage) return Promise.resolve();
    const entries: Record<string, unknown> = {};
    for (const row of rows) entries[`${USER_PREFIX}${row.id}`] = { ...row };
    return storage.put(entries);
  }

  /** The row already exists: the user has been in the bot before this contact. */
  private ensureRow(userId: string): { row: ReferralUserRow; created: boolean } {
    const existing = this.users.get(userId);
    if (existing) return { row: existing, created: false };
    const now = Date.now();
    const code = freshCode(this.codes);
    const row: ReferralUserRow = {
      id: userId,
      code,
      createdAt: now,
      firstSeenAt: now,
      joins: 0,
      earned: 0,
      pendingFrom: '',
      pendingCode: '',
      pendingAt: 0,
      creditedFrom: '',
      creditedAt: 0,
    };
    this.users.set(userId, row);
    this.codes.set(code, userId);
    return { row, created: true };
  }

  /**
   * First contact. A brand-new user with a valid inviter is bound PENDING; anyone already in the
   * ledger is never re-bound, which is what kills self-referrals, loops and "fresh link" repeats.
   */
  private contact(userId: string, rawCode: string): ReferralContactPayload {
    const code = readReferralCode(rawCode);
    const existing = this.users.get(userId);
    if (existing) {
      const valid = Boolean(code && this.codes.get(code) && this.codes.get(code) !== userId);
      return { ...stateOf(existing), valid, bound: false, self: Boolean(code && this.codes.get(code) === userId) };
    }

    const { row } = this.ensureRow(userId);
    let valid = false;
    let bound = false;
    let self = false;
    if (code) {
      const inviterId = this.codes.get(code) ?? '';
      const inviter = inviterId ? this.users.get(inviterId) : undefined;
      self = inviterId === userId;
      if (inviter && !self) {
        valid = true;
        row.pendingFrom = inviter.id;
        row.pendingCode = code;
        row.pendingAt = Date.now();
        bound = true;
      }
    }
    return { ...stateOf(row), valid, bound, self };
  }

  /** Runs only after the gate verified membership. Idempotent forever. */
  private settle(userId: string): ReferralSettlePayload {
    const row = this.users.get(userId);
    if (!row) {
      const created = this.ensureRow(userId).row;
      return { ...stateOf(created), creditedNow: false, alreadyCredited: false };
    }
    if (row.creditedFrom) {
      if (row.pendingFrom) {
        row.pendingFrom = '';
        row.pendingCode = '';
        row.pendingAt = 0;
      }
      return { ...stateOf(row), creditedNow: false, alreadyCredited: true };
    }
    const inviter = row.pendingFrom ? this.users.get(row.pendingFrom) : undefined;
    if (!inviter) {
      if (row.pendingFrom || row.pendingCode) {
        row.pendingFrom = '';
        row.pendingCode = '';
        row.pendingAt = 0;
      }
      return { ...stateOf(row), creditedNow: false, alreadyCredited: false };
    }

    row.creditedFrom = inviter.id;
    row.creditedAt = Date.now();
    row.earned = Math.min(100_000_000, row.earned + REFERRAL_REWARD);
    row.pendingFrom = '';
    row.pendingCode = '';
    row.pendingAt = 0;
    inviter.joins = Math.min(100_000, inviter.joins + 1);
    inviter.earned = Math.min(100_000_000, inviter.earned + REFERRAL_REWARD);
    return { ...stateOf(row), creditedNow: true, alreadyCredited: false };
  }

  private lookup(rawCode: string): ReferralLookupPayload {
    const code = readReferralCode(rawCode);
    const userId = code ? this.codes.get(code) ?? '' : '';
    const row = userId ? this.users.get(userId) : undefined;
    return {
      ok: true,
      valid: Boolean(row),
      code,
      joins: row?.joins ?? 0,
      earned: row?.earned ?? 0,
      unclaimed: row?.earned ?? 0,
    };
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    const body = request.method === 'POST'
      ? (await request.json().catch(() => ({}))) as Record<string, unknown>
      : {};
    const rawUser = typeof body.userId === 'string' ? body.userId : (url.searchParams.get('userId') ?? '');
    const userId = rawUser.replace(/[^0-9]/g, '').slice(0, 20);

    if (url.pathname === '/me' || url.pathname === '/code' || url.pathname === '/touch') {
      if (!TG_ID.test(userId)) return json({ ok: false, error: 'bad_user' }, 400);
      const { row, created } = this.ensureRow(userId);
      if (created) await this.persistRow(row);
      return json(stateOf(row));
    }

    if (url.pathname === '/contact') {
      if (!TG_ID.test(userId)) return json({ ok: false, error: 'bad_user' }, 400);
      const code = typeof body.code === 'string' ? body.code : '';
      const existing = this.users.get(userId);
      const result = this.contact(userId, code);
      if (!existing) {
        const row = this.users.get(userId);
        if (row) await this.persistRow(row);
      }
      return json(result);
    }

    if (url.pathname === '/settle') {
      if (!TG_ID.test(userId)) return json({ ok: false, error: 'bad_user' }, 400);
      const result = this.settle(userId);
      const invitee = this.users.get(userId);
      if (invitee) {
        const inviter = result.creditedNow && invitee.creditedFrom
          ? this.users.get(invitee.creditedFrom)
          : undefined;
        await this.persistRows(inviter ? [invitee, inviter] : [invitee]);
      }
      return json(result);
    }

    if (url.pathname === '/lookup') {
      return json(this.lookup(typeof body.code === 'string' ? body.code : (url.searchParams.get('code') ?? '')));
    }

    return json({ ok: false, error: 'not_found' }, 404);
  }
}

/* ---------- the edge helpers ---------- */

interface LedgerStub { fetch(request: Request): Promise<Response> }

function ledger(env: Env): LedgerStub | null {
  if (!env.REFERRALS) return null;
  return env.REFERRALS.get(env.REFERRALS.idFromName('global'));
}

async function call<T>(env: Env, path: string, body: Record<string, unknown>): Promise<T | null> {
  const stub = ledger(env);
  if (!stub) return null;
  try {
    const response = await stub.fetch(new Request(`https://referral.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

/** The player's permanent code, created on first contact. Empty when the ledger is unbound. */
export async function ensureReferralCode(env: Env, userId: string): Promise<string> {
  const state = await call<ReferralStatePayload>(env, '/code', { userId });
  return state?.code ?? '';
}

export async function referralMe(env: Env, userId: string): Promise<ReferralStatePayload | null> {
  return call<ReferralStatePayload>(env, '/me', { userId });
}

/** First contact with a ref payload: binds PENDING only when the user is genuinely new. */
export async function referralContact(
  env: Env,
  userId: string,
  code: string,
): Promise<ReferralContactPayload | null> {
  return call<ReferralContactPayload>(env, '/contact', { userId, code });
}

/** The gate passed: credit the inviter and the invitee in this same request. */
export async function referralSettle(env: Env, userId: string): Promise<ReferralSettlePayload | null> {
  return call<ReferralSettlePayload>(env, '/settle', { userId });
}

export async function referralLookup(env: Env, code: string): Promise<ReferralLookupPayload | null> {
  return call<ReferralLookupPayload>(env, '/lookup', { code });
}

/** Note a user who reached the bot without a referral: an existing user can never be an invitee. */
export async function touchReferralUser(env: Env, userId: string): Promise<string> {
  const state = await call<ReferralStatePayload>(env, '/touch', { userId });
  return state?.code ?? '';
}

/**
 * Verify channel membership for the forced-join gate. `true`/`false` are Telegram's answer;
 * `null` means the check itself is unavailable (no token, no channel, transport error) and the
 * caller must not pretend either way.
 */
export async function channelMembership(env: Env, userId: string): Promise<boolean | null> {
  const channel = (env.REQUIRED_CHANNEL ?? `@${CHANNEL_HANDLE}`).trim();
  if (!channel || !TG_ID.test(userId)) return null;
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  /* Local work without a bot token cannot call Telegram. The marked dev door treats the member
     as joined so the game stays playable; a deployed host always has the token. */
  if (!token) return env.DEV_AUTH === 'true' ? true : null;

  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_BASE}${token}/getChatMember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ chat_id: channel, user_id: userId }),
    });
  } catch {
    return null;
  }
  let data: {
    ok?: boolean;
    result?: { status?: string; is_member?: boolean };
    description?: string;
  } | null = null;
  try {
    data = await response.json();
  } catch {
    return null;
  }
  if (!response.ok || !data || data.ok !== true) {
    const description = typeof data?.description === 'string' ? data.description : '';
    if (/user.*(?:not found|invalid)|participant/i.test(description)) return false;
    return null;
  }
  const status = data.result?.status ?? '';
  if (status === 'restricted') return data.result?.is_member === true;
  return MEMBER_STATUSES.has(status);
}
