import type { Env } from './env';

/**
 * The championship a squad enlists into. The registry is per-cup: a squad is a contender in a
 * tournament because it registered for that tournament, never because it exists.
 */
export const ACTIVE_CUP_ID = 'cup-200-stars';

/**
 * The weekly Channel Wars cycle. Every channel's tournament score is measured from the balance it
 * held when it entered the running cycle, so a channel that has existed on Telegram for years
 * never carries its pre-tournament TIQ into a fresh week.
 *
 * The cycle is anchored on a Monday at 00:00 UTC and the id changes with it: that single changing
 * string is what makes every new week start every channel at exactly `0` TIQ.
 */
export const WAR_SEASON_MS = 7 * 24 * 60 * 60 * 1000;
/** A Monday, 00:00 UTC — the anchor every weekly cycle is counted from. */
const WAR_SEASON_ANCHOR = Date.UTC(2025, 0, 6);

/** The tournament cycle running at `at`, as a stable id for the whole week. */
export function warSeasonId(at: number = Date.now()): string {
  const weeks = Math.max(0, Math.floor((at - WAR_SEASON_ANCHOR) / WAR_SEASON_MS));
  return `cw-w${weeks}`;
}

export type SquadKind = 'channel' | 'group';

/** The audit state the Command Center shows: confirmed admin, awaiting review, or pulled. */
export type SquadVerification = 'verified' | 'pending' | 'revoked';

/**
 * How a registration asked for its badge:
 *   - `bot`  — Method 1: the founder added the bot as an admin; Telegram is asked directly.
 *   - `post` — Method 2: the founder posted a one-time `#TX-XXXXX` code in a public channel.
 *   - `none` — register first, verify later from the squad drawer.
 * A request that names no method keeps the legacy enlistment flow (bot-admin proof).
 */
export type SquadVerifyMethod = 'bot' | 'post' | 'none' | '';

/** Who a roster row is: the player who enlisted the squad, a promoted officer, or a member. */
export type SquadMemberRole = 'leader' | 'admin' | 'member';

/**
 * One real mini-app player on a squad's roster.
 *
 * This is the *only* thing that makes a squad have members: there is no seeded roster, no derived
 * ladder, and no Telegram audience folded in. `tiq` is the player's own Tactical IQ as they
 * reported it from the game (the same reading the Mind Ladder prints), so the squad's Squad IQ is
 * the mean of numbers real people actually earned.
 */
export interface SquadMemberRow {
  /** Telegram user id — the one stable key a player has. */
  id: string;
  /** Display name at the time of the last sync; '' when the player never sent one. */
  name: string;
  tiq: number;
  role: SquadMemberRole;
  joinedAt: number;
  /** ISO 3166-1 alpha-2, or '' when the player has not picked a country. */
  country: string;
  /** Telegram @username without the `@`, or ''. */
  username: string;
  /**
   * The player's Telegram profile photo, as their own client reported it. Published so a
   * leaderboard paints a real face instead of a monogram; '' when the player has none.
   */
  photo: string;
  /**
   * Legacy audit column: the Channel Wars TIQ this player banked while the war kept a separate
   * ledger. The channel's TOTAL TIQ no longer reads it — that is `tiq`, the player's real balance,
   * summed across the roster. Kept so an older row still reports what it earned.
   */
  warTiq: number;
}

/** The ceiling one member's reported TIQ may hold. */
export const MEMBER_TIQ_CAP = 9_999_999;

/**
 * A player waiting for the leader to answer an invite. Deliberately *not* a `SquadMemberRow`:
 * until the leader approves, this player is nowhere on the roster and moves no count.
 */
export interface SquadApplicantRow {
  id: string;
  name: string;
  tiq: number;
  country: string;
  username: string;
  photo: string;
  requestedAt: number;
}

/** One leader announcement, kept for the audit trail and the notification centre. */
export interface SquadAnnouncementRow {
  id: string;
  text: string;
  authorId: string;
  createdAt: number;
  recipients: number;
}

export interface RegisteredSquad {
  id: string;
  chatId: string;
  handle: string;
  name: string;
  /**
   * The Telegram chat's own audience (`getChatMemberCount`). An external stat only: it is what the
   * community looks like on Telegram, never how many players joined the squad in the game.
   */
  subscribers: number;
  /**
   * The same audience, kept nullable on purpose: `null` means Telegram never told us (the bot was
   * never added to the chat, or the call failed), which the inspector paints as `—` instead of a
   * confident zero. A real `0` is a chat that answered and has no members.
   */
  telegramMembers: number | null;
  /** The real players who joined. `members` is always this array's length. */
  roster: SquadMemberRow[];
  /** Joined players — derived from `roster`, never from `subscribers`. */
  members: number;
  kind: SquadKind;
  avatar: string;
  /** 2–3 character call sign stamped on the squad crest. */
  tag: string;
  /** The Telegram id of the player who enlisted the squad: its leader and only admin. */
  creatorId: string;
  /** `creatorId` under its legacy name; kept so older rows and admin reads agree. */
  ownerId: string;
  /**
   * The cup this squad registered for. The one field every tournament leaderboard filters on:
   * a squad without this stamp is not in the field, so none of its players can be either.
   */
  cupId: string;
  /**
   * The weekly tournament cycle this channel's baseline belongs to. When the cycle rolls, the row
   * is re-enrolled with a fresh snapshot — that is what makes a new week start at `0` TIQ.
   */
  seasonId: string;
  /**
   * The channel's cumulative TIQ at the exact moment it entered `seasonId`. The tournament score
   * is `current - baseline`, so no pre-tournament history is ever counted on the weekly ladder.
   */
  baselineTiq: number;
  /** When the channel entered `seasonId` (ms). */
  enrolledAt: number;
  createdAt: number;
  /** `verified` — the bot proved the submitter is an admin; `pending` — awaits an audit. */
  verification: SquadVerification;
  /**
   * The public badge gate, persisted as a boolean beside the audit state. A squad only ever
   * holds `true` after Method 1 (bot admin) or Method 2 (posted code) proved ownership; a
   * registration that stops before that proof is stored with `false` and carries no badge.
   */
  verified: boolean;
  verifiedAt: number;
  verifiedBy: string;
  revokedAt: number;
  /** Pulled from the Channel War by an admin. The row stays for the audit trail. */
  banned: boolean;
  bannedAt: number;
  /** Leader's lock: an invite through the shared link files a request, not a membership. */
  requireApproval: boolean;
  /** Leader-only queue of join requests awaiting a decision. */
  pending: SquadApplicantRow[];
  /**
   * Legacy war ledger, kept for stored rows from before the channel total became the roster's own
   * TIQ sum. No view reads it: every Channel Wars total is `squadTotalTiq`.
   */
  warPoints: number;
  /** The last announcements this leader dispatched, newest first. */
  announcements: SquadAnnouncementRow[];
}

export type SquadRegistration =
  | { ok: true; squad: RegisteredSquad }
  | { ok: false; status: number; code: string; message: string; kind?: SquadKind };

interface TelegramChat {
  id?: number | string;
  type?: string;
  title?: string;
  username?: string;
  photo?: { small_file_id?: string; big_file_id?: string };
  members_count?: number;
}

interface TelegramMember {
  status?: string;
  /** Set on `restricted`: a restricted member who is still inside the chat. */
  is_member?: boolean;
  user?: { id?: number | string };
}

interface TelegramEnvelope<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

const TELEGRAM_BASE = 'https://api.telegram.org/bot';
/** A canonical handle: `@` + 4–32 ASCII letters, digits or underscores, any case. */
const HANDLE = /^@[a-z0-9_]{4,32}$/i;
const MEMBER_TEXT = 32;
const AVATAR_TEXT = 160;
/** The refusal every enlistment door gives for a chat that is already on the board. */
export const SQUAD_ALREADY_ENLISTED = 'This squad is already enlisted in the competition!';
const KIND_MISMATCH_GROUP = 'Handle belongs to a group, not a channel. Switch to the GROUP tab.';
const KIND_MISMATCH_CHANNEL = 'Handle belongs to a channel, not a group. Switch to the CHANNEL tab.';
const CHAT_NOT_FOUND = 'Channel or group not found on Telegram.';
/** What a 403 from `getChat` earns: only a chat with a public username can be enlisted. */
const CHAT_NOT_PUBLIC = 'Channel must be public. Only public channels and groups can enlist.';
/** The one answer a Worker without a token can give, and the fix it names. */
const TOKEN_MISSING_MESSAGE =
  'Telegram bot token is not configured on this Worker. Set TELEGRAM_BOT_TOKEN '
  + '(`npx wrangler secret put TELEGRAM_BOT_TOKEN`) and redeploy.';
/**
 * Every Bot API call is bounded. A hung connection used to hold the enlist modal until the
 * *browser* gave up, which read as "verification is unavailable" with nothing in the Worker log;
 * eight seconds leaves room for Telegram's slowest `getChat` and still answers in time.
 */
const TELEGRAM_TIMEOUT_MS = 8_000;
/**
 * Where the bot token may arrive, best first. `TELEGRAM_BOT_TOKEN` is the documented secret —
 * `wrangler.toml`, `.dev.vars`, the README and every harness use it — while the two shorter
 * spellings are read as fallbacks so a deployment that bound one of them does not silently lose
 * squad verification (see `botToken`).
 */
const TOKEN_BINDINGS = ['TELEGRAM_BOT_TOKEN', 'BOT_TOKEN', 'TELEGRAM_TOKEN'] as const;
let cachedBotId = '';
/** One diagnostic line per isolate: a missing token should be loud, not repeated on every call. */
let tokenDiagnosed = false;

/** How a Bot API call failed — the difference between "no chat" and "we never reached Telegram". */
type TelegramFailure = 'api' | 'unreachable' | 'timeout' | 'bad_response';

class TelegramError extends Error {
  constructor(
    readonly description: string,
    readonly errorCode: number,
    /** The HTTP status Telegram (or the edge) answered with; `0` when there was no response. */
    readonly httpStatus = 0,
    readonly kind: TelegramFailure = 'api',
  ) {
    super(description);
  }
}

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';

/** A token, safe to print: enough to identify which bot answered, never enough to use it. */
function maskToken(token: string): string {
  if (!token) return '(empty)';
  if (token.length <= 8) return `${token.slice(0, 2)}***`;
  return `${token.slice(0, 4)}***${token.slice(-4)} (len ${token.length})`;
}

/** An outgoing Bot API URL with the token replaced by its masked form. */
function maskedUrl(url: string): string {
  return url.replace(/(\/bot)([^/]+)(\/)/, (_all, head: string, token: string, tail: string) =>
    `${head}${token.slice(0, 4)}***${tail}`);
}

/**
 * The bot token, from whichever binding the deployment actually set.
 *
 * The documented name is `TELEGRAM_BOT_TOKEN` (a secret); `BOT_TOKEN` and `TELEGRAM_TOKEN` are
 * accepted afterwards because a Worker that bound one of those is working code with a wrong
 * constant, not a missing secret. Whichever binding answered is logged once per isolate, and an
 * absent token is a loud `console.warn` naming the fix — never a silent `unavailable` that the
 * player can only read as "Telegram is down".
 */
function botToken(env: Env | undefined): { token: string; binding: string } {
  const source = (env ?? {}) as Record<string, unknown>;
  for (const binding of TOKEN_BINDINGS) {
    const value = typeof source[binding] === 'string' ? (source[binding] as string).trim() : '';
    if (!value) continue;
    if (!tokenDiagnosed) {
      tokenDiagnosed = true;
      if (binding !== 'TELEGRAM_BOT_TOKEN') {
        console.warn(
          `[squad-verify] bot token found on "${binding}"; rename the binding to `
          + '"TELEGRAM_BOT_TOKEN" (the documented secret) so every route reads the same value.',
        );
      }
      console.log(`[squad-verify] bot token bound via "${binding}" (${maskToken(value)})`);
    }
    return { token: value, binding };
  }
  if (!tokenDiagnosed) {
    tokenDiagnosed = true;
    console.warn(
      `[squad-verify] no bot token in the Worker environment: none of `
      + `${TOKEN_BINDINGS.map((name) => `"${name}"`).join(', ')} is set. `
      + 'Squad verification cannot call getChat until one is — '
      + '`npx wrangler secret put TELEGRAM_BOT_TOKEN`, then redeploy (a secret is not a [vars] entry).',
    );
  }
  return { token: '', binding: '' };
}

const stampOf = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * A stored audit state is one of the three known values. A row persisted before the audit fields
 * existed was Telegram-verified at registration, so it keeps the verified badge; an unrecognised
 * value is treated as an un-reviewed claim rather than silently trusted.
 */
const verificationOf = (value: unknown): SquadVerification => {
  if (value === 'verified' || value === 'pending' || value === 'revoked') return value;
  return value === undefined ? 'verified' : 'pending';
};

const memberStatus = (value: unknown): string => {
  const result = (value ?? {}) as TelegramMember;
  return typeof result.status === 'string' ? result.status : '';
};

export function normalizeChatHandle(raw: string): string {
  let value = text(raw, 200);
  if (!value) return '';
  /* A link's query/fragment is not part of the username, but a bare handle with one is
     malformed — only the link shape is allowed to carry a suffix. */
  const link = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([A-Za-z0-9_]{4,32})\/?(?:[?#].*)?$/i.exec(value);
  if (link) value = link[1];
  value = value.replace(/^@+/, '').trim();
  if (!HANDLE.test(`@${value}`)) return '';
  return `@${value}`;
}

/**
 * The public profile photo Telegram serves for a handle. `getChat` answers a file id, which a
 * browser cannot paint; this is the same cached channel photo behind the username CDN, so the
 * client can render it directly and fall back to a monogram when the CDN 404s.
 */
export function telegramPhotoUrl(rawHandle: string): string {
  const handle = normalizeChatHandle(rawHandle);
  return handle ? `https://t.me/i/userpic/320/${handle.slice(1)}.jpg` : '';
}

export function normalizeSquadTag(raw: unknown): string {
  const tag = text(raw, 8).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  return /^[A-Z0-9]{2,3}$/.test(tag) ? tag : '';
}

/**
 * A portrait is decoration: only an absolute https URL is stored, anything else is dropped so a
 * malformed report can never reach an `<img>` — or invalidate the player's row.
 */
const photoOf = (value: unknown): string => {
  const url = text(value, 300);
  return /^https:\/\/[^\s]+$/i.test(url) ? url : '';
};

/** A roster row from untrusted storage: an id is mandatory, every other field has a safe zero. */
export function readSquadMember(raw: unknown): SquadMemberRow | null {
  const row = raw as Partial<SquadMemberRow> | null | undefined;
  if (!row) return null;
  const id = text(row.id, 24).replace(/[^0-9A-Za-z_-]/g, '');
  if (!id) return null;
  const role: SquadMemberRole = row.role === 'leader' || row.role === 'admin' ? row.role : 'member';
  const tiq = Number(row.tiq);
  const joinedAt = Number(row.joinedAt);
  const country = text(row.country, 2).toUpperCase();
  const warTiq = warTotalOf(row.warTiq);
  const storedTiq = Number.isFinite(tiq) && tiq > 0 ? Math.floor(tiq) : 0;
  return {
    id,
    name: text(row.name, 24),
    /* A row written before `tiq` existed kept its only score in `warTiq`; that number is the
       player's best known balance, so it backfills the real column instead of reporting a 0. */
    tiq: storedTiq || warTiq,
    role,
    joinedAt: Number.isFinite(joinedAt) && joinedAt > 0 ? Math.floor(joinedAt) : 0,
    country: /^[A-Z]{2}$/.test(country) ? country : '',
    username: text(row.username, 32).replace(/^@+/, ''),
    photo: photoOf(row.photo),
    warTiq,
  };
}

/** A join request from untrusted storage, folded field by field. */
export function readSquadApplicant(raw: unknown): SquadApplicantRow | null {
  const row = raw as Partial<SquadApplicantRow> | null | undefined;
  if (!row) return null;
  const id = text(row.id, 24).replace(/[^0-9A-Za-z_-]/g, '');
  if (!id) return null;
  const tiq = Number(row.tiq);
  const at = Number(row.requestedAt);
  const country = text(row.country, 2).toUpperCase();
  return {
    id,
    name: text(row.name, 24),
    tiq: Number.isFinite(tiq) && tiq > 0 ? Math.floor(tiq) : 0,
    country: /^[A-Z]{2}$/.test(country) ? country : '',
    username: text(row.username, 32).replace(/^@+/, ''),
    photo: photoOf(row.photo),
    requestedAt: Number.isFinite(at) && at > 0 ? Math.floor(at) : 0,
  };
}

/** Build one applicant from a join request the room just authenticated. */
export function applicantFromRequest(raw: {
  id: string; name?: unknown; tiq?: unknown; country?: unknown; username?: unknown; photo?: unknown;
}): SquadApplicantRow {
  const tiq = Number(raw.tiq);
  const country = text(raw.country, 2).toUpperCase();
  return {
    id: text(raw.id, 24).replace(/[^0-9A-Za-z_-]/g, ''),
    name: text(raw.name, 24),
    tiq: Number.isFinite(tiq) && tiq > 0 ? Math.floor(tiq) : 0,
    country: /^[A-Z]{2}$/.test(country) ? country : '',
    username: text(raw.username, 32).replace(/^@+/, ''),
    photo: photoOf(raw.photo),
    requestedAt: Date.now(),
  };
}

function readAnnouncement(raw: unknown): SquadAnnouncementRow | null {
  const row = raw as Partial<SquadAnnouncementRow> | null | undefined;
  if (!row) return null;
  const at = Number(row.createdAt);
  const sent = Number(row.recipients);
  return {
    id: text(row.id, 48),
    text: text(row.text, 280),
    authorId: text(row.authorId, 24),
    createdAt: Number.isFinite(at) && at > 0 ? Math.floor(at) : 0,
    recipients: Number.isFinite(sent) && sent > 0 ? Math.floor(sent) : 0,
  };
}

/**
 * A stored squad, normalised. The one rule this enforces is the whole point of the model:
 * **`members` is the roster's length**. A row written before the roster existed carries the
 * Telegram audience in `members`; that number is moved to `subscribers` (where it belongs) and the
 * enlisting owner is seeded as the squad's leader, because they did in fact enlist it.
 */
export function readRegisteredSquad(raw: unknown): RegisteredSquad | null {
  const row = raw as Partial<RegisteredSquad> | null | undefined;
  if (!row) return null;
  const id = text(row.id, 48);
  const handle = normalizeChatHandle(text(row.handle, 64));
  const name = text(row.name, MEMBER_TEXT);
  if (!id || !handle || !name) return null;
  const createdAt = Number(row.createdAt);
  const ownerId = text(row.ownerId ?? row.creatorId, 24);
  const creatorId = text(row.creatorId ?? row.ownerId, 24);

  const roster: SquadMemberRow[] = [];
  const seen = new Set<string>();
  if (Array.isArray(row.roster)) {
    for (const entry of row.roster) {
      const member = readSquadMember(entry);
      if (!member || seen.has(member.id)) continue;
      seen.add(member.id);
      roster.push(member);
      if (roster.length >= MAX_ROSTER) break;
    }
  }
  /* A legacy row has no roster but does have an owner: that player enlisted the squad, so the
     roster starts at exactly one — the leader — rather than at the channel's audience. */
  const leader = creatorId || ownerId;
  if (!roster.length && leader) {
    roster.push({
      id: leader,
      name: '',
      tiq: 0,
      role: 'leader',
      joinedAt: Number.isFinite(createdAt) && createdAt > 0 ? Math.floor(createdAt) : Date.now(),
      country: '',
      username: '',
      photo: '',
      warTiq: 0,
    });
  }
  /* Exactly one leader, and it is the creator: a promoted or stale row can never hold the crown. */
  for (const member of roster) {
    member.role = member.id === leader ? 'leader' : member.role === 'leader' ? 'member' : member.role;
  }

  const subscribers = Number(row.subscribers ?? row.members);
  /* The nullable audience: an explicit `null` is a chat Telegram never answered for, and a row
     written before this field existed falls back to the numeric audience it already carried. */
  const rawMembers = row.telegramMembers;
  const telegramMembers = rawMembers === null
    ? null
    : Number.isFinite(Number(rawMembers)) && Number(rawMembers) >= 0
      ? Math.floor(Number(rawMembers))
      : (Number.isFinite(subscribers) && subscribers >= 0 ? Math.floor(subscribers) : null);
  /* The audit string is the source of truth; the persisted boolean follows it. A row written
     before the flag existed was verified by the old bot-admin enlistment, so it keeps the badge
     only while its audit state is `verified`. */
  const verification = verificationOf(row.verification);
  const baselineRaw = Number(row.baselineTiq);
  const enrolledRaw = Number(row.enrolledAt);
  return {
    id,
    chatId: text(row.chatId, 32),
    handle,
    name,
    subscribers: Number.isFinite(subscribers) && subscribers >= 0 ? Math.floor(subscribers) : 0,
    telegramMembers,
    roster,
    members: roster.length,
    kind: row.kind === 'channel' ? 'channel' : 'group',
    avatar: text(row.avatar, AVATAR_TEXT),
    tag: normalizeSquadTag(row.tag),
    creatorId: leader,
    ownerId: leader,
    /* A row written before the stamp existed was enlisted into the championship that was
       running, so it keeps its place in that field instead of being orphaned by the upgrade. */
    cupId: text(row.cupId, 48) || ACTIVE_CUP_ID,
    /* A row written before the weekly baseline existed carries no season stamp: `enrolInWarSeason`
       snapshots it on first sight instead of trusting a stored zero. */
    seasonId: text(row.seasonId, 24),
    baselineTiq: Number.isFinite(baselineRaw) && baselineRaw > 0 ? Math.floor(baselineRaw) : 0,
    enrolledAt: Number.isFinite(enrolledRaw) && enrolledRaw > 0 ? Math.floor(enrolledRaw) : 0,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? Math.floor(createdAt) : Date.now(),
    verification,
    verified: verification === 'verified',
    verifiedAt: stampOf(row.verifiedAt),
    verifiedBy: text(row.verifiedBy, 40),
    revokedAt: stampOf(row.revokedAt),
    banned: row.banned === true,
    bannedAt: stampOf(row.bannedAt),
    requireApproval: row.requireApproval === true,
    warPoints: warTotalOf(row.warPoints),
    pending: (Array.isArray(row.pending) ? row.pending : [])
      .map(readSquadApplicant)
      .filter((a): a is SquadApplicantRow => a !== null)
      .filter((a, i, all) => all.findIndex((x) => x.id === a.id) === i)
      .slice(0, 60),
    announcements: (Array.isArray(row.announcements) ? row.announcements : [])
      .map(readAnnouncement)
      .filter((a): a is SquadAnnouncementRow => a !== null && !!a.text)
      .slice(0, 20),
  };
}

/** A roster is bounded: a Telegram supergroup can hold 200k people, a war board cannot. */
export const MAX_ROSTER = 5_000;

/** The role a player holds on a squad, or '' when they are not on it. */
export function roleOf(squad: RegisteredSquad, playerId: string): SquadMemberRole | '' {
  const id = text(playerId, 24);
  if (!id) return '';
  const hit = squad.roster.find((m) => m.id === id);
  if (hit) return hit.role;
  return squad.creatorId === id ? 'leader' : '';
}

/** True when this player may manage the squad (its leader, or an appointed officer). */
export function isSquadAdmin(squad: RegisteredSquad, playerId: string): boolean {
  const role = roleOf(squad, playerId);
  return role === 'leader' || role === 'admin';
}

/**
 * Put a player on the roster, or refresh the row they already have.
 *
 * `join` is the difference between the two doors: a join may add a row, a sync only ever touches
 * one that exists — so opening the app can never quietly enrol someone who never tapped Join.
 * Returns whether the row was created.
 */
export function upsertSquadMember(
  squad: RegisteredSquad,
  input: { id: string; name?: string; tiq?: number; country?: string; username?: string; photo?: string },
  join: boolean,
): boolean {
  const id = text(input.id, 24).replace(/[^0-9A-Za-z_-]/g, '');
  if (!id) return false;
  const tiqRaw = Number(input.tiq);
  const tiq = Number.isFinite(tiqRaw) && tiqRaw > 0 ? Math.min(Math.floor(tiqRaw), MEMBER_TIQ_CAP) : 0;
  const country = text(input.country, 2).toUpperCase();
  const name = text(input.name, 24);
  const username = text(input.username, 32).replace(/^@+/, '');
  const photo = photoOf(input.photo);

  const existing = squad.roster.find((m) => m.id === id);
  if (existing) {
    /* A sync is authoritative for the player's own numbers and never for their role: the crown
       belongs to the creator and only an admin action can change that. */
    if (name) existing.name = name;
    existing.tiq = Math.max(existing.tiq, tiq);
    if (country) existing.country = country;
    if (username) existing.username = username;
    /* The portrait is refreshed only when the player's own client sent one: a client that cannot
       read `photo_url` must not wipe the face the board already knows. */
    if (photo) existing.photo = photo;
    return false;
  }
  if (!join) return false;
  if (squad.roster.length >= MAX_ROSTER) return false;
  squad.roster.push({
    id,
    name,
    tiq,
    role: id === squad.creatorId ? 'leader' : 'member',
    joinedAt: Date.now(),
    country: /^[A-Z]{2}$/.test(country) ? country : '',
    username,
    photo,
    /* A fresh row has banked nothing yet: the column is earned by playing, never seeded. */
    warTiq: 0,
  });
  squad.members = squad.roster.length;
  return true;
}

/** Take a player off the roster. The leader can never be removed by this door. */
export function removeSquadMember(squad: RegisteredSquad, playerId: string): boolean {
  const id = text(playerId, 24);
  if (!id || id === squad.creatorId) return false;
  const before = squad.roster.length;
  squad.roster = squad.roster.filter((m) => m.id !== id);
  squad.members = squad.roster.length;
  return squad.roster.length !== before;
}

/**
 * The channel's TOTAL TIQ: the exact sum of every member's real TIQ balance.
 *
 * This is the one authority for every Channel Wars total — the ladder, the inspector's telemetry
 * card and the fighters' own figures are all this same arithmetic, so two screens can never quote
 * two different numbers for one channel.
 */
export function squadTotalTiq(squad: RegisteredSquad): number {
  return squad.roster.reduce((sum, m) => sum + Math.max(0, Math.round(m.tiq || 0)), 0);
}

/** The same sum under the admin telemetry's historical name. */
export const squadWarTiq = squadTotalTiq;

/**
 * Is this row enrolled in the tournament cycle that is running now? A legacy row (no season
 * stamp) or a row from an older week is not: it has to be snapshotted before it can be ranked.
 */
export function warSeasonEnrolled(squad: RegisteredSquad, at: number = Date.now()): boolean {
  return !!squad.seasonId && squad.seasonId === warSeasonId(at);
}

/**
 * Enrol a channel in the running weekly tournament: snapshot the TIQ it holds right now as its
 * baseline and start its tournament score at exactly `0`.
 *
 * Idempotent inside a cycle — re-opening the hub, refreshing the rankings or syncing a member
 * never moves the baseline mid-week. Returns `true` only when the row actually changed (a legacy
 * row, or the first sighting of a new week).
 */
export function enrolInWarSeason(squad: RegisteredSquad, at: number = Date.now()): boolean {
  const seasonId = warSeasonId(at);
  if (squad.seasonId === seasonId) return false;
  squad.seasonId = seasonId;
  squad.baselineTiq = squadTotalTiq(squad);
  squad.enrolledAt = at;
  return true;
}

/**
 * The number the Channel Wars ladder paints: TIQ earned **since this channel entered the running
 * week**, never the lifetime balance it arrived with. A channel can lose a member and fall below
 * its baseline; the score floors at `0` rather than going negative.
 */
export function squadTournamentTiq(squad: RegisteredSquad, at: number = Date.now()): number {
  if (!warSeasonEnrolled(squad, at)) return 0;
  const baseline = Math.max(0, Math.floor(squad.baselineTiq || 0));
  return Math.max(0, squadTotalTiq(squad) - baseline);
}

/** A war-point reading, bounded. Anything malformed is a zero, never a NaN on the board. */
export function warTotalOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(WAR_POINTS_CAP, Math.floor(n)) : 0;
}

/** The ceiling one squad can hold in a season. */
export const WAR_POINTS_CAP = 1_000_000;

/**
 * Bank a war match's points. The gain is clamped to the two amounts the game actually pays, so a
 * hand-made request cannot mint a lead: a war match is worth a win or a participation credit.
 *
 * `playerId` names the fighter who played, and their member row is credited in the same turn —
 * their reported real balance first, then the match's gain on top, so the channel's TOTAL TIQ
 * (the sum of the roster) moves the moment the match settles. Returns that new total.
 */
export function addWarPoints(
  squad: RegisteredSquad,
  gain: number,
  playerId = '',
  playerTiq = 0,
): number {
  const paid = Math.max(0, Math.min(WAR_WIN_POINTS, Math.floor(Number(gain) || 0)));
  squad.warPoints = Math.min(WAR_POINTS_CAP, warTotalOf(squad.warPoints) + paid);
  const id = text(playerId, 24);
  if (paid > 0 && id) {
    const row = squad.roster.find((m) => m.id === id);
    if (row) {
      const reported = Number(playerTiq);
      const balance = Number.isFinite(reported) && reported > 0
        ? Math.min(MEMBER_TIQ_CAP, Math.floor(reported))
        : 0;
      /* The member's real balance is the score; a stale stored value never walks it backwards. */
      row.tiq = Math.min(MEMBER_TIQ_CAP, Math.max(0, Math.max(row.tiq, balance) + paid));
      row.warTiq = Math.min(WAR_POINTS_CAP, warTotalOf(row.warTiq) + paid);
    }
  }
  return squadTotalTiq(squad);
}

/** What a war match pays, mirrored from the client's own settlement. */
export const WAR_WIN_POINTS = 25;

/** Squad IQ: the arithmetic mean of the roster's TIQ, rounded once. */
export function squadAvgTiq(squad: RegisteredSquad): number {
  return squad.roster.length
    ? Math.round(squadWarTiq(squad) / squad.roster.length)
    : 0;
}

/**
 * One fighter on a channel's roster, as the inspector paints them: the identity a face and a name
 * need, and the TIQ balance the player actually holds.
 */
export interface SquadFighterView {
  id: string;
  name: string;
  /** The Telegram portrait, or '' when the player has none. */
  avatar: string;
  /** The player's real TIQ balance — the number the channel's TOTAL TIQ sums. */
  tiq: number;
  /** Legacy audit column: the war TIQ this player banked while the ledger was separate. */
  tiqContributed: number;
  role: SquadMemberRole;
}

/**
 * One row of the roster sheet: the fighter's identity and balance, plus the two flags a member row
 * decorates itself with. The *complete* roster is published in this shape — never a capped head of
 * it — so a drawer can always reach the last member of a large squad.
 */
export interface SquadMemberView extends SquadMemberRow {
  /** The portrait under the name every consumer already reads it by. Detail door only. */
  avatar?: string;
  /** True for the squad's founder, and for the one row the registry stamped `leader`. */
  isLeader: boolean;
  /** The room's VIP reading, when the caller had one to offer. */
  isVip?: boolean;
}

/**
 * How a view is read: the single-squad detail door and a board read do not publish the same
 * fields. A board answers for every squad at once, so it stays the lighter shape.
 */
export interface SquadViewOptions {
  /**
   * Publish the per-member detail a roster sheet needs — the @username and the portrait under its
   * inspector name. Only the single-squad detail door asks for it; a board read keeps the handle
   * private and the payload lean, exactly as it always has.
   */
  detail?: boolean;
  /** The room's VIP reading, keyed by a member's bare Telegram id. Omitted = not published. */
  isVip?: (memberId: string) => boolean;
}

/**
 * The public shape a client reads: identity, the real roster (ranked by the TIQ each member
 * banked), the derived counts, and the audience as a clearly separate stat. No chat token and no
 * audit notes — a board read carries no Telegram @username either; the roster names a player by
 * their display name, which is all the board ever paints.
 */
export interface SquadView {
  id: string;
  chatId: string;
  handle: string;
  name: string;
  kind: SquadKind;
  avatar: string;
  tag: string;
  /** Joined mini-app players. Always `roster.length`. */
  members: number;
  /** Telegram audience — external stat, never the squad's size. */
  subscribers: number;
  /** The same audience, nullable: `null` when Telegram never answered. The inspector prints `—`. */
  telegramMembers: number | null;
  /** Players of this bot representing the channel — the same count as `members`, named for the UI. */
  botFightersCount: number;
  /** Squad IQ: the exact sum of the roster's TIQ — the same figure as `totalTiq`. */
  tiq: number;
  /**
   * Channel Wars TOTAL TIQ: the exact sum of every member's real TIQ balance. Never a separate
   * war ledger — the number here is `sum(member.tiq)`, which is also what `totalTiq` carries.
   */
  warPoints: number;
  /** The same total under its Channel Wars name. Always equal to `warPoints`. */
  totalTiq: number;
  /** The weekly cycle this row is enrolled in. */
  seasonId: string;
  /** The lifetime TIQ the channel held when it entered the running week. */
  baselineTiq: number;
  /** When the channel entered the running week (ms). */
  enrolledAt: number;
  /**
   * The Channel Wars tournament score: TIQ earned since enrolment, floored at `0`. This — never
   * the lifetime sum — is the number the weekly ladder is ranked and painted by.
   */
  tournamentTiq: number;
  /** The roster as the inspector ranks it: highest real TIQ first. */
  fighters: SquadFighterView[];
  creatorId: string;
  createdAt: number;
  verified: boolean;
  /** The cup this squad registered for — the eligibility key its players are filtered on. */
  cupId: string;
  /** Every member, ranked by the TIQ each one banked: highest first, ties broken by join order. */
  roster: SquadMemberView[];
  /** The Telegram id of the player who enlisted the squad — the row that wears the crown. */
  founderId: string;
  /** Public: an invitee needs to know the squad is locked before they tap Join. */
  requireApproval: boolean;
}

export function squadViewOf(squad: RegisteredSquad, options: SquadViewOptions = {}): SquadView {
  const founderId = squad.creatorId || squad.ownerId;
  const isVip = options.isVip;
  const detail = options.detail === true;
  /* The roster sheet ranks every member by the TIQ they actually banked: highest first, ties
     broken by join order and then by id, so two devices never paint one roster two ways. */
  const roster: SquadMemberView[] = [...squad.roster]
    .sort((a, b) => b.tiq - a.tiq || a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))
    .map((member) => ({
      ...member,
      /* The @username is stored for the audit trail. The single-squad detail door publishes it —
         the roster names a player beside their handle — while a board read keeps it private. */
      username: detail ? member.username : '',
      ...(detail ? { avatar: member.photo } : {}),
      isLeader: member.role === 'leader' || (!!founderId && member.id === founderId),
      ...(isVip ? { isVip: isVip(member.id) === true } : {}),
    }));
  /* The inspector's own order: the roster ranked by real TIQ balance, ties broken by id so two
     devices never paint the same roster two ways. */
  const fighters: SquadFighterView[] = roster
    .map((member) => ({
      id: member.id,
      name: member.name,
      avatar: member.photo,
      tiq: Math.max(0, Math.floor(member.tiq)),
      tiqContributed: warTotalOf(member.warTiq),
      role: member.role,
    }))
    .sort((a, b) => b.tiq - a.tiq || a.id.localeCompare(b.id));
  const totalTiq = squadTotalTiq(squad);
  /* A row that has not been enrolled in the running week has no baseline yet; its tournament
     score is a clean `0` rather than a borrowed lifetime total. */
  const enrolled = warSeasonEnrolled(squad);
  const baselineTiq = enrolled ? Math.max(0, Math.floor(squad.baselineTiq || 0)) : 0;
  const tournamentTiq = enrolled ? Math.max(0, totalTiq - baselineTiq) : 0;
  const audience = squad.telegramMembers;
  return {
    id: squad.id,
    chatId: squad.chatId,
    handle: squad.handle,
    name: squad.name,
    kind: squad.kind,
    avatar: squad.avatar,
    tag: squad.tag,
    members: roster.length,
    subscribers: squad.subscribers,
    telegramMembers: typeof audience === 'number' && Number.isFinite(audience) && audience >= 0
      ? Math.floor(audience)
      : null,
    botFightersCount: roster.length,
    tiq: totalTiq,
    warPoints: totalTiq,
    totalTiq,
    seasonId: squad.seasonId,
    baselineTiq,
    enrolledAt: squad.enrolledAt,
    tournamentTiq,
    fighters,
    creatorId: squad.creatorId,
    createdAt: squad.createdAt,
    verified: squad.verified === true && squad.verification === 'verified' && !squad.banned,
    cupId: squad.cupId || ACTIVE_CUP_ID,
    roster,
    founderId,
    requireApproval: squad.requireApproval === true,
  };
}

/* ---------- the cup's field, and the players it may pay ----------
   A cup board is not "every squad the room knows". It is the squads registered for that cup,
   and a player reaches it only through one of them. Both reads below apply that rule, so the
   client and the server can never disagree about who is a contender. */

/** The cup a registry row belongs to; a legacy row is filed under the running championship. */
export function squadCupOf(squad: Pick<RegisteredSquad, 'cupId'>): string {
  return text(squad.cupId, 48) || ACTIVE_CUP_ID;
}

/**
 * The squads registered for one cup, in ranking order, re-ranked inside that field. A banned or
 * revoked row is out of the field entirely: it is still stored, but it is not a contender.
 */
export function cupField(squads: Iterable<RegisteredSquad>, cupId: string): RegisteredSquad[] {
  const id = text(cupId, 48);
  if (!id) return [];
  /* One clock for the whole sort: the weekly leaderboard is ranked by the score it prints.
     Lifetime Squad IQ only breaks ties, so a channel's history never outranks this week's work. */
  const now = Date.now();
  return [...squads]
    .filter((squad) => !squad.banned && squad.verification !== 'revoked' && squadCupOf(squad) === id)
    .sort((a, b) =>
      squadTournamentTiq(b, now) - squadTournamentTiq(a, now)
      || squadAvgTiq(b) - squadAvgTiq(a)
      || b.members - a.members
      || a.handle.localeCompare(b.handle));
}

/** The ids registered for one cup — the membership test every player row must pass. */
export function cupSquadIds(squads: Iterable<RegisteredSquad>, cupId: string): Set<string> {
  return new Set(cupField(squads, cupId).map((squad) => squad.id));
}

/** One contender on the cup's player leaderboard. */
export interface CupPlayerRow {
  rank: number;
  id: string;
  name: string;
  country: string;
  /** The Telegram portrait, or '' when the player has none. */
  avatar: string;
  tiq: number;
  /** The registered squad this player rides for — the key the hard filter tests. */
  squadId: string;
  squadHandle: string;
}

/**
 * The cup's player leaderboard: every joined player of every registered squad, ranked by their
 * own TIQ.
 *
 * **Hard filter:** a player is only ever listed through a squad that is on this cup's registry.
 * Someone with no squad, or whose squad never enlisted for this cup, has no row here at all — and
 * therefore cannot appear on the podium or claim a place in the pool.
 */
export function cupPlayerBoard(
  squads: Iterable<RegisteredSquad>,
  cupId: string,
  limit = 10,
): CupPlayerRow[] {
  const field = cupField(squads, cupId);
  const registered = new Set(field.map((squad) => squad.id));
  const seen = new Set<string>();
  const rows: Array<Omit<CupPlayerRow, 'rank'>> = [];

  for (const squad of field) {
    for (const member of squad.roster) {
      if (!member.id || seen.has(member.id)) continue;
      seen.add(member.id);
      rows.push({
        id: member.id,
        name: member.name || '—',
        country: member.country,
        avatar: member.photo || telegramPhotoUrl(`@${member.username}`),
        tiq: Math.max(0, Math.floor(member.tiq)),
        squadId: squad.id,
        squadHandle: squad.handle,
      });
    }
  }

  /* The one gate: a row whose squad is not on the registry is dropped, whoever it is. */
  const eligible = rows.filter((row) => registered.has(row.squadId));
  eligible.sort((a, b) => b.tiq - a.tiq || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return eligible.slice(0, Math.max(0, Math.floor(limit))).map((row, i) => ({ ...row, rank: i + 1 }));
}


/**
 * One Bot API call. Reads ride GET with the chat id in the query string — the shape the
 * docs publish for `getChat` (`/bot<token>/getChat?chat_id=@handle`) — while writes and
 * membership probes stay POST/JSON. Both answer the same `{ ok, result }` envelope.
 *
 * Every call is bounded and every failure is classified, because the three ways this can go
 * wrong are not the same thing to the player: Telegram said no (`api`), Telegram never answered
 * (`unreachable`/`timeout`), or the answer was not JSON (`bad_response`). The URL is logged with
 * the token masked, and Telegram's own `description`/`error_code` is logged verbatim so an
 * operator can read the real reason in `wrangler tail` instead of guessing.
 */
async function telegram<T>(
  token: string,
  method: string,
  params: Record<string, string | number>,
  verb: 'GET' | 'POST' = 'POST',
): Promise<T> {
  const endpoint = `${TELEGRAM_BASE}${token}/${method}`;
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)] as [string, string]),
  ).toString();
  const url = verb === 'GET' ? `${endpoint}?${query}` : endpoint;
  const init: RequestInit = verb === 'GET'
    ? { method: 'GET', headers: { accept: 'application/json' } }
    : {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(params),
    };

  if (!token) {
    /* Reached only if a caller skipped the token gate: say so here rather than sending `/bot/`. */
    throw new TelegramError('no bot token configured', 0, 0, 'unreachable');
  }
  console.log(`[squad-verify] telegram ${method} → ${maskedUrl(url)}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const aborted = controller.signal.aborted;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[squad-verify] telegram ${method} ${aborted ? 'timed out' : 'connection failed'} `
      + `after ${TELEGRAM_TIMEOUT_MS}ms budget: ${reason}`,
    );
    throw new TelegramError(
      aborted ? `telegram ${method} timed out` : `telegram ${method} unreachable`,
      0,
      0,
      aborted ? 'timeout' : 'unreachable',
    );
  } finally {
    clearTimeout(timer);
  }

  /* The raw text first: a proxy or an HTML error page is not JSON, and `response.json()` would
     hide that behind a bare SyntaxError. */
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    raw = '';
  }
  let data: TelegramEnvelope<T> | null = null;
  try {
    data = raw ? (JSON.parse(raw) as TelegramEnvelope<T>) : null;
  } catch {
    data = null;
  }

  const description = text(data?.description, 240);
  console.log(
    `[squad-verify] telegram ${method} ← HTTP ${response.status}`
    + `${data?.error_code === undefined ? '' : ` (error_code ${data.error_code})`}`
    + `${description ? ` — ${description}` : ''}`,
  );

  if (!response.ok || !data || data.ok !== true || data.result === undefined) {
    /* A body that does not parse is not "Telegram is down" — we reached something, it just was
       not the Bot API (a proxy, a WAF page, a truncated response). `unreachable`/`timeout` are
       reserved for a transport that never answered at all, which is classified at the fetch. */
    const kind: TelegramFailure = data ? 'api' : 'bad_response';
    if (data) {
      console.warn(
        `[squad-verify] telegram ${method} refused: HTTP ${response.status}, `
        + `error_code ${data.error_code ?? '(none)'}, description ${JSON.stringify(description || '(none)')}`,
      );
    } else {
      console.warn(
        `[squad-verify] telegram ${method} returned a non-JSON body (HTTP ${response.status}): `
        + JSON.stringify(raw.slice(0, 240) || '(empty)'),
      );
    }
    throw new TelegramError(
      description || `telegram ${method} failed`,
      typeof data?.error_code === 'number' ? data.error_code : response.status,
      response.status,
      kind,
    );
  }
  return data.result;
}

/**
 * What a failed `getChat` should tell the player. The classification is by Telegram's own
 * answer, then by its HTTP status, then by transport: 400/404 is "no such chat", 403 is
 * "that chat is not public", and a transport failure says so instead of blaming the handle.
 */
function chatFailure(error: TelegramError): ChatFailure {
  const description = error.description;
  if (error.kind === 'timeout') {
    return {
      ok: false,
      status: 504,
      code: 'telegram_timeout',
      message: 'Telegram did not answer in time. Check the Worker network and try again.',
    };
  }
  if (error.kind === 'unreachable') {
    return {
      ok: false,
      status: 502,
      code: 'telegram_unreachable',
      message: `Could not reach Telegram (${description || 'connection failed'}). Try again shortly.`,
    };
  }
  if (error.kind === 'bad_response') {
    return {
      ok: false,
      status: 502,
      code: 'telegram_bad_response',
      message: 'Telegram returned an unreadable answer. Try again shortly.',
    };
  }
  /* A token check answers 401; that is a deployment problem, never the player's handle. */
  if (error.errorCode === 401 || error.httpStatus === 401) {
    return {
      ok: false,
      status: 503,
      code: 'telegram_unauthorized',
      message: TOKEN_MISSING_MESSAGE,
    };
  }
  if (error.errorCode === 403 || error.httpStatus === 403) {
    return { ok: false, status: 403, code: 'chat_private', message: CHAT_NOT_PUBLIC };
  }
  if (
    error.errorCode === 400 || error.errorCode === 404
    || error.httpStatus === 400 || error.httpStatus === 404
    || /chat not found|username not found|chat_id_invalid|invalid/i.test(description)
  ) {
    return { ok: false, status: 404, code: 'chat_not_found', message: CHAT_NOT_FOUND };
  }
  if (/private|not enough rights|not a member|kicked|not found/i.test(description)) {
    return { ok: false, status: 403, code: 'chat_private', message: CHAT_NOT_PUBLIC };
  }
  return { ok: false, status: 502, code: 'telegram_error', message: `Telegram could not verify this chat (${description || 'unknown error'}).` };
}

/**
 * A failed membership probe. A transport failure (timeout, DNS, TLS, a 5xx) is an outage and says
 * so; a refusal Telegram actually sent — a bot that was never added to the chat answers
 * `not enough rights` / `chat not found` on `getChatMember` — stays the bot-not-admin verdict.
 */
function membershipFailure(error: unknown, call: string): ChatFailure {
  if (isTransportFailure(error) && error instanceof TelegramError) {
    console.warn(`[squad-verify] ${call} transport failure: ${error.description}`);
    return chatFailure(error);
  }
  const description = error instanceof TelegramError ? error.description : String(error);
  console.warn(`[squad-verify] ${call} refused: ${description || 'no description'}`);
  return {
    ok: false,
    status: 400,
    code: 'bot_not_admin',
    message: 'Bot is not added as an administrator to this chat.',
  };
}

async function botUserId(token: string, env: Env): Promise<string> {
  const configured = (env.TELEGRAM_BOT_ID ?? '').replace(/[^0-9]/g, '').slice(0, 20);
  if (configured) return configured;
  if (cachedBotId) return cachedBotId;
  const me = await telegram<{ id?: number | string }>(token, 'getMe', {});
  const id = String(me?.id ?? '').replace(/[^0-9]/g, '').slice(0, 20);
  if (id) cachedBotId = id;
  return id;
}

function memberFailure(error: unknown): boolean {
  if (!(error instanceof TelegramError)) return false;
  return /user.*(?:not found|invalid)|user_id_invalid|participant/i.test(error.description);
}

/** A transport failure is not "this user is not a member": it is an outage, and must be reported. */
const isTransportFailure = (error: unknown): boolean =>
  error instanceof TelegramError && error.kind !== 'api';

async function statusOf(token: string, chatId: string, userId: string): Promise<string> {
  try {
    return memberStatus(await telegram<TelegramMember>(token, 'getChatMember', {
      chat_id: chatId,
      user_id: userId,
    }));
  } catch (error) {
    if (memberFailure(error)) return '';
    throw error;
  }
}

export interface SquadChatPreview {
  chatId: string;
  handle: string;
  name: string;
  kind: SquadKind;
  avatar: string;
  members: number;
}

export type SquadChatCheck =
  | { ok: true; chat: SquadChatPreview }
  | { ok: false; status: number; code: string; message: string; kind?: SquadKind };

export interface ResolvedChat {
  chatId: string;
  handle: string;
  title: string;
  kind: SquadKind;
  avatar: string;
  /** `null` when `getChatMemberCount` refused and `getChat` carried no fallback. */
  members: number | null;
}

type ChatFailure = { ok: false; status: number; code: string; message: string; kind?: SquadKind };

/**
 * `getChat` is the one source of truth for a community's existence, type, title, photo and
 * audience. It only ever answers for the username that was asked for, and a chat without a
 * public username is refused as private — a handle that resolves must be public by definition.
 */
async function resolveChat(rawHandle: string, token: string): Promise<{ ok: true; chat: ResolvedChat } | ChatFailure> {
  const handle = normalizeChatHandle(rawHandle);
  if (!handle) {
    return { ok: false, status: 400, code: 'invalid_handle', message: 'Enter a channel handle or link like @your_channel.' };
  }

  let chat: TelegramChat;
  try {
    /* The single source of truth: does this username exist, what type is it, what is it
       called, and does it have a photo. Nothing about a squad is trusted before this. */
    chat = await telegram<TelegramChat>(token, 'getChat', { chat_id: handle }, 'GET');
  } catch (error) {
    if (error instanceof TelegramError) return chatFailure(error);
    console.error('[squad-verify] unexpected getChat failure:', error);
    return {
      ok: false,
      status: 502,
      code: 'telegram_error',
      message: 'Telegram could not verify this chat. Try again shortly.',
    };
  }

  const type = text(chat.type, 20);
  if (type !== 'channel' && type !== 'group' && type !== 'supergroup') {
    return { ok: false, status: 400, code: 'unsupported_chat', message: 'Only Telegram channels and groups can be registered.' };
  }

  const canonical = normalizeChatHandle(chat.username ?? '');
  if (!canonical) {
    return { ok: false, status: 403, code: 'chat_private', message: CHAT_NOT_PUBLIC };
  }
  /* A username resolves to exactly one chat; never accept an answer for a different handle. */
  if (canonical.toLowerCase() !== handle.toLowerCase()) {
    return { ok: false, status: 404, code: 'chat_not_found', message: CHAT_NOT_FOUND };
  }

  const chatId = chat.id === undefined || chat.id === null ? handle : String(chat.id).replace(/[^0-9-]/g, '').slice(0, 32);
  /* The real audience. `getChatMemberCount` is the documented door and answers for any public
     chat the bot can read; `getChat`'s own `members_count` is the fallback for a deployment whose
     bot is not in the chat yet. Neither answering leaves the count UNKNOWN — `null`, never a
     confident zero — because "we could not read it" and "nobody is in it" are different facts and
     the inspector prints them differently. */
  let members: number | null = null;
  try {
    const count = await telegram<number>(token, 'getChatMemberCount', { chat_id: chatId });
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) members = Math.floor(count);
  } catch {
    const fallback = Number(chat.members_count);
    if (Number.isFinite(fallback) && fallback >= 0) members = Math.floor(fallback);
  }

  return {
    ok: true,
    chat: {
      chatId,
      handle: canonical,
      title: text(chat.title, MEMBER_TEXT) || canonical,
      kind: type === 'channel' ? 'channel' : 'group',
      /* `getChat` answers a photo file id, which a browser cannot paint; a chat that has
         one gets the public CDN URL for its handle instead. */
      avatar: chat.photo ? telegramPhotoUrl(canonical) : '',
      members,
    },
  };
}

const kindMismatch = (actual: SquadKind): ChatFailure => ({
  ok: false,
  status: 409,
  code: 'kind_mismatch',
  kind: actual,
  message: actual === 'group' ? KIND_MISMATCH_GROUP : KIND_MISMATCH_CHANNEL,
});

/**
 * A best-effort public read for a door that proved ownership another way (Method 2). Null is an
 * honest "Telegram did not answer": the caller keeps the title it already has.
 */
export async function readPublicChat(rawHandle: string, env: Env): Promise<ResolvedChat | null> {
  const { token } = botToken(env);
  if (!token) return null;
  const resolved = await resolveChat(rawHandle, token);
  return resolved.ok ? resolved.chat : null;
}

/** The refusal a deployment without a token gives: named, logged, and impossible to misread. */
const noToken = (): ChatFailure => ({
  ok: false,
  status: 503,
  code: 'bot_token_missing',
  message: TOKEN_MISSING_MESSAGE,
});

/**
 * Method 1: prove, through Telegram itself, that `userId` is the chat's creator/administrator
 * and that this bot is already an administrator beside them. Resolves the chat at the same time,
 * so a successful proof can sync its authentic title, photo and audience in one turn.
 */
export async function verifySquadAdminOwnership(
  rawHandle: string,
  userId: string,
  env: Env,
): Promise<{ ok: true; chat: ResolvedChat } | ChatFailure> {
  const requester = text(userId, 24).replace(/[^0-9-]/g, '');
  if (!requester) {
    return { ok: false, status: 401, code: 'unauthorized', message: 'Telegram verification required.' };
  }
  const { token } = botToken(env);
  if (!token) return noToken();
  const resolved = await resolveChat(rawHandle, token);
  if (!resolved.ok) return resolved;
  const chat = resolved.chat;

  let requesterStatus: string;
  try {
    requesterStatus = await statusOf(token, chat.chatId, requester);
  } catch (error) {
    return membershipFailure(error, 'getChatMember(requester)');
  }
  if (requesterStatus !== 'creator' && requesterStatus !== 'administrator') {
    return {
      ok: false,
      status: 403,
      code: 'not_admin',
      message: 'Access Denied: You must be an administrator of this channel/group.',
    };
  }

  let botId = '';
  try {
    botId = await botUserId(token, env);
  } catch (error) {
    return membershipFailure(error, 'getMe');
  }
  if (!botId) {
    return {
      ok: false,
      status: 400,
      code: 'bot_not_admin',
      message: 'Bot is not added as an administrator to this chat.',
    };
  }
  let botStatus: string;
  try {
    botStatus = await statusOf(token, chat.chatId, botId);
  } catch (error) {
    return membershipFailure(error, 'getChatMember(bot)');
  }
  if (botStatus !== 'creator' && botStatus !== 'administrator') {
    return {
      ok: false,
      status: 400,
      code: 'bot_not_admin',
      message: 'Bot is not added as an administrator to this chat.',
    };
  }
  return { ok: true, chat };
}

/**
 * Method 2: the one-time post code.
 *
 * A founder who will not hand the bot admin rights posts `#TX-XXXXX` in a public channel; the
 * public preview at `t.me/s/<username>` already renders that message server-side, so reading it
 * proves channel control without a Bot API right. The page is requested with a normal browser
 * user-agent because the preview endpoint can answer differently to an unknown client.
 */
const POST_CODE_SHAPE = /^#TX-[0-9]{5}$/;
const POST_PAGE_TIMEOUT_MS = 8_000;
const POST_PAGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function verifyPostedCode(rawHandle: string, rawCode: string): Promise<boolean> {
  const handle = normalizeChatHandle(rawHandle);
  const code = text(rawCode, 16).toUpperCase();
  if (!handle || !POST_CODE_SHAPE.test(code)) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_PAGE_TIMEOUT_MS);
  let html = '';
  try {
    const response = await fetch(`https://t.me/s/${handle.slice(1)}`, {
      method: 'GET',
      headers: { 'user-agent': POST_PAGE_USER_AGENT, accept: 'text/html' },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    html = await response.text();
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }

  /* Every rendered bubble carries `tgme_widget_message_text`; scan only those blocks so a code
     echoed anywhere else on the page (a title, a meta tag) can never stand in for a real post. */
  const plain = (chunk: string): string => chunk
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|#0?39|nbsp);/gi, ' ')
    .replace(/\s+/g, ' ');
  const marker = /tgme_widget_message_text[^>]*>/gi;
  let hit: RegExpExecArray | null;
  while ((hit = marker.exec(html)) !== null) {
    if (plain(html.slice(hit.index, hit.index + 4_000)).includes(code)) return true;
  }
  return false;
}

/** Copy Telegram's authentic reading of a chat onto a stored squad. */
export function syncSquadChatDetails(squad: RegisteredSquad, chat: ResolvedChat): void {
  if (chat.chatId) squad.chatId = chat.chatId;
  if (chat.title) squad.name = chat.title;
  squad.kind = chat.kind;
  squad.avatar = chat.avatar;
  if (chat.members !== null) {
    squad.telegramMembers = chat.members;
    squad.subscribers = chat.members;
  }
}

/** Flip the audit state and the public badge flag together, so they can never disagree. */
export function markSquadVerified(squad: RegisteredSquad, by: string, at = Date.now()): void {
  squad.verification = 'verified';
  squad.verified = true;
  squad.verifiedAt = at;
  squad.verifiedBy = text(by, 40);
  squad.revokedAt = 0;
}

/** The preview door: getChat, the chosen tab's type check, and nothing written to the registry. */
export async function verifySquadChat(
  rawHandle: string,
  requestedKind: SquadKind,
  env: Env,
): Promise<SquadChatCheck> {
  const { token, binding } = botToken(env);
  if (!token) return noToken();
  console.log(
    `[squad-verify] verifying "${normalizeChatHandle(rawHandle) || rawHandle}" with binding "${binding}"`,
  );
  const resolved = await resolveChat(rawHandle, token);
  if (!resolved.ok) {
    console.warn(`[squad-verify] getChat refused: ${resolved.code} (HTTP ${resolved.status}) — ${resolved.message}`);
    return resolved;
  }
  if (resolved.chat.kind !== requestedKind) return kindMismatch(resolved.chat.kind);
  return {
    ok: true,
    chat: {
      chatId: resolved.chat.chatId,
      handle: resolved.chat.handle,
      name: resolved.chat.title,
      kind: resolved.chat.kind,
      avatar: resolved.chat.avatar,
      members: resolved.chat.members ?? 0,
    },
  };
}

export async function verifyAndBuildSquad(
  rawHandle: string,
  userId: string,
  env: Env,
  identity?: {
    name?: string; tag?: string; kind?: SquadKind; memberName?: string; username?: string;
    /** The enlisting leader's own Telegram portrait. */
    photo?: string;
    /** The enlisting leader's current real TIQ balance; the roster's first row starts here. */
    playerTiq?: number;
    /** The cup this enlistment is filed under; the running championship when omitted. */
    cupId?: string;
    /** Which proof this registration carries; omitted keeps the legacy bot-admin enlistment. */
    method?: SquadVerifyMethod;
    /** The `#TX-XXXXX` code the founder posted, for `method: 'post'`. */
    verifyCode?: string;
  },
): Promise<SquadRegistration> {
  const handle = normalizeChatHandle(rawHandle);
  if (!handle) {
    return { ok: false, status: 400, code: 'invalid_handle', message: 'Enter a channel handle or link like @your_channel.' };
  }
  const wantedTag = typeof identity?.tag === 'string' ? identity.tag : '';
  const tag = normalizeSquadTag(wantedTag);
  if (wantedTag.trim() && !tag) {
    return { ok: false, status: 400, code: 'invalid_tag', message: 'Tag must be 2–3 letters or numbers.' };
  }
  const requester = text(userId, 24).replace(/[^0-9-]/g, '');
  if (!requester) {
    return { ok: false, status: 401, code: 'unauthorized', message: 'Telegram verification required.' };
  }
  const method: SquadVerifyMethod = identity?.method === 'bot' || identity?.method === 'post'
    || identity?.method === 'none'
    ? identity.method
    : '';
  const { token } = botToken(env);
  if (!token) {
    return {
      ok: false,
      status: 503,
      code: 'bot_token_missing',
      message: TOKEN_MISSING_MESSAGE,
    };
  }

  /* Method 1 (and the legacy enlistment) asks Telegram who owns the chat and whether the bot
     stands beside them. The other two doors only resolve the public chat: an unverified squad is
     allowed to exist, and the code door proves control from the channel's own public page. */
  /* The leader's own balance is the channel's opening balance. It is also the tournament
     baseline: a channel that registers today starts the week at 0 TIQ, whatever it brought. */
  const enrolledAt = Date.now();
  const leaderTiq = Number.isFinite(Number(identity?.playerTiq)) && Number(identity?.playerTiq) > 0
    ? Math.min(MEMBER_TIQ_CAP, Math.floor(Number(identity?.playerTiq)))
    : 0;

  let chat: ResolvedChat;
  let verified = false;
  let verifiedBy = '';
  if (method === '' || method === 'bot') {
    const proof = await verifySquadAdminOwnership(handle, requester, env);
    if (!proof.ok) return proof;
    chat = proof.chat;
    verified = true;
    verifiedBy = 'telegram';
  } else {
    const resolved = await resolveChat(handle, token);
    if (!resolved.ok) return resolved;
    chat = resolved.chat;
    if (method === 'post') {
      const posted = await verifyPostedCode(handle, identity?.verifyCode ?? '');
      if (!posted) {
        return {
          ok: false,
          status: 400,
          code: 'POST_CODE_NOT_FOUND',
          message: 'That code is not in the channel posts yet. Post it again and verify.',
        };
      }
      verified = true;
      verifiedBy = 'post';
    }
  }

  const expectedKind = identity?.kind === 'channel' ? 'channel' : identity?.kind === 'group' ? 'group' : '';
  if (expectedKind && chat.kind !== expectedKind) return kindMismatch(chat.kind);

  return {
    ok: true,
    squad: {
      id: `sq-tg-${chat.chatId.replace(/[^0-9]/g, '') || chat.handle.slice(1).toLowerCase()}`.slice(0, 48),
      chatId: chat.chatId,
      handle: chat.handle,
      name: text(identity?.name, MEMBER_TEXT) || chat.title,
      /* The chat's audience is an external stat; the squad starts with exactly one player. */
      subscribers: chat.members ?? 0,
      telegramMembers: chat.members,
      roster: [{
        id: requester,
        name: text(identity?.memberName, 24),
        /* The leader already holds a real balance; the channel's lifetime total starts there. */
        tiq: leaderTiq,
        role: 'leader',
        joinedAt: enrolledAt,
        country: '',
        username: text(identity?.username, 32).replace(/^@+/, ''),
        photo: photoOf(identity?.photo),
        warTiq: 0,
      }],
      members: 1,
      kind: chat.kind,
      avatar: chat.avatar,
      tag,
      creatorId: requester,
      ownerId: requester,
      cupId: text(identity?.cupId, 48) || ACTIVE_CUP_ID,
      /* The tournament baseline is the balance held at registration, so the new row's first
         Channel Wars score is `0` and only TIQ earned after this instant moves it. */
      seasonId: warSeasonId(enrolledAt),
      baselineTiq: leaderTiq,
      enrolledAt,
      createdAt: enrolledAt,
      /* Only a proof that actually ran earns the badge; a plain registration is pending. */
      verification: verified ? 'verified' : 'pending',
      verified,
      verifiedAt: verified ? Date.now() : 0,
      verifiedBy,
      revokedAt: 0,
      banned: false,
      bannedAt: 0,
      requireApproval: false,
      pending: [],
      warPoints: 0,
      announcements: [],
    },
  };
}

/**
 * Re-read one squad's Telegram audience and store it.
 *
 * The inspector promises a real member count, and a channel grows after it was enlisted. This is
 * the refresh door: one `getChatMemberCount` against the chat id the registry already holds, and
 * the answer written back to `telegramMembers`. Every failure is silent by design — a bot that is
 * not in the chat, a chat that went private, a Telegram hiccup — because a stale-but-real number
 * beats an error where a statistic belongs, and `null` is the honest answer for "never read".
 * Returns true when the stored row actually moved, so the caller knows whether to persist.
 */
export async function refreshTelegramMembers(squad: RegisteredSquad, env: Env): Promise<boolean> {
  const { token } = botToken(env);
  /* The stored chat id is the canonical target; a row that never captured one is asked for by its
     public handle instead — `chat_id: '@handle'` is the same chat, by the name a person knows. */
  const chatId = text(squad.chatId, 32) || `@${squad.handle.replace(/^@+/, '')}`;
  if (!token || !chatId) return false;
  let count: number | null = null;
  try {
    const answer = await telegram<number>(token, 'getChatMemberCount', { chat_id: chatId });
    if (typeof answer === 'number' && Number.isFinite(answer) && answer >= 0) count = Math.floor(answer);
  } catch (error) {
    if (!(error instanceof TelegramError)) console.warn('[squad-verify] getChatMemberCount refresh failed:', error);
    return false;
  }
  if (count === null || count === squad.telegramMembers) return false;
  squad.telegramMembers = count;
  /* The legacy numeric column follows the authoritative one, so an older reader never disagrees. */
  squad.subscribers = count;
  return true;
}

/* ---------- the Channel Wars membership gate ----------
   A player may only represent a chat they are actually inside, or the ladder is a list of names
   nobody stands behind. The check is one `getChatMember` call, and it is deliberately a courtesy
   gate rather than a wall: a bot that was never made an administrator of a public channel cannot
   read that channel's member list, and that is a configuration gap, not a verdict on the player.
   Every answer that cannot be proven opens the door and says so. */

export interface ChannelMembership {
  ok: true;
  /** Whether the player is inside the chat — or, when unproven, whether the door opens. */
  isMember: boolean;
  /** Only present on an explicit refusal: Telegram confirmed the player is not inside. */
  reason?: 'NOT_MEMBER';
  /** The gate could not be enforced (no token, no rights, an outage). The door opened. */
  unverifiedFallback?: boolean;
}

/** Telegram's answer for "this user is not in this chat": a real verdict, not an outage. */
const isNonMemberAnswer = (status: string): boolean => status === 'left' || status === 'kicked';

/**
 * Is `userId` a member of `rawHandle`?
 *
 * `chat_id` is the public `@username`, which is the one address a channel and a supergroup share.
 * Telegram answers `creator`/`administrator`/`member` for the three ways of being inside, and
 * `left`/`kicked` for the two ways of being outside; `restricted` carries its own `is_member`.
 */
export async function verifyChannelMembership(
  rawHandle: string,
  userId: string,
  env: Env | undefined,
): Promise<ChannelMembership> {
  const handle = normalizeChatHandle(rawHandle);
  const member = text(userId, 24).replace(/[^0-9]/g, '');
  const { token } = botToken(env);
  /* Nobody to ask, or nothing to ask with: open the door. A tournament must never be bricked by
     a missing secret or a half-typed handle. */
  if (!handle || !member || !token) return { ok: true, isMember: true, unverifiedFallback: true };

  let row: TelegramMember;
  try {
    row = await telegram<TelegramMember>(token, 'getChatMember', { chat_id: handle, user_id: member });
  } catch (error) {
    /* "User not found" is Telegram telling us this player never touched the chat: a real
       NOT_MEMBER, not a failure. Everything else — a chat the bot cannot see, a timeout, a
       transport drop — opens the door rather than blaming the player for it. */
    if (memberFailure(error)) return { ok: true, isMember: false, reason: 'NOT_MEMBER' };
    const description = error instanceof TelegramError ? error.description : 'unreachable';
    console.warn(`[squad-verify] verify-member ${handle} → ${description}; opening the door`);
    return { ok: true, isMember: true, unverifiedFallback: true };
  }

  const status = memberStatus(row);
  if (status === 'creator' || status === 'administrator' || status === 'member') {
    return { ok: true, isMember: true };
  }
  if (status === 'restricted') {
    return row.is_member === true
      ? { ok: true, isMember: true }
      : { ok: true, isMember: false, reason: 'NOT_MEMBER' };
  }
  if (isNonMemberAnswer(status)) return { ok: true, isMember: false, reason: 'NOT_MEMBER' };
  /* An empty or unknown status proves nothing about the player. */
  return { ok: true, isMember: true, unverifiedFallback: true };
}
