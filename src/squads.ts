/**
 * squads.ts — Telegram Channel / Community Squads competition layer.
 *
 * A squad is a channel handle (@name) plus the **real players** who joined it. There is no seeded
 * field and no generated roster: the member list is the roster the Worker hands back, and a squad's
 * Squad IQ is the arithmetic mean of its members' own Tactical IQ. A squad a player creates on this
 * device starts with exactly one member — them — and grows only when someone actually joins.
 *
 * Binding is still one squad per player, persisted under `detour.squads.v1`, scoped per Telegram
 * account (`..._u_<id>`). `getSquadRanking()`
 * ranks the squads this device knows (its own creations plus whatever the Worker's board last
 * returned); nothing is invented to fill the board.
 */

import { adoptUserStorageKey, readJson, writeJson } from './storage';
import { myTiq } from './matchmaking';
import { tgUser } from './telegram';
import { squadAppLink, SQUAD_PREFIX } from '../shared/config';

export type SquadTrend = 'up' | 'down' | 'same';

/**
 * The championship a squad enlists into. One cup runs at a time, so one id — and it is the only
 * thing that decides whether a squad's players may appear on that cup's leaderboard.
 */
export const ACTIVE_CUP_ID = 'cup-200-stars';

/** Unified community type: a Telegram Channel (broadcast) or Group (chat). */
export type SquadKind = 'channel' | 'group';

/** Who a roster row is: the player who enlisted the squad, an officer, or a member. */
export type SquadRole = 'leader' | 'admin' | 'member';

/** One real mini-app player on a squad's roster. */
export interface SquadMember {
  /** Telegram user id — the one stable key a player has. */
  id: string;
  name: string;
  /** The player's own Tactical IQ, as the game reads it. */
  tiq: number;
  role: SquadRole;
  joinedAt: number;
  /** ISO 3166-1 alpha-2, or '' when the player has not picked a country. */
  country: string;
  /** Telegram @username without the `@`, or ''. */
  username?: string;
  /** The player's Telegram profile photo, when the roster reported one. */
  photo?: string;
}

/**
 * One player waiting for the leader's answer. A request is *not* a member: it never enters the
 * roster, never moves the member count and never raises the squad's TIQ until it is approved.
 */
export interface SquadApplicant {
  /** Telegram user id — the same stable key a roster row carries. */
  id: string;
  name: string;
  tiq: number;
  country: string;
  requestedAt: number;
  username?: string;
  photo?: string;
}

export interface SquadAdminState {
  requireApproval: boolean;
  requests: SquadApplicant[];
}

export interface Squad {
  id: string;
  /** canonical handle with leading @, e.g. @DogeSquad */
  handle: string;
  name: string;
  /** The joined players. `members` is always this array's length. */
  roster: SquadMember[];
  /** Joined mini-app players — never the Telegram audience. */
  members: number;
  /**
   * The Telegram chat's own audience, when the Worker reported one. An external stat: it is what
   * the community looks like on Telegram, never how many players joined the squad in the game.
   */
  subscribers?: number;
  /** Arithmetic mean of the roster's TIQ: the squad's Squad IQ. */
  trophies: number;
  trend: SquadTrend;
  /** community type; optional so older saves without it still validate */
  kind?: SquadKind;
  /** Telegram photo file id, when the Bot API returned one */
  avatar?: string;
  /** 2–3 character call sign stamped on the squad crest */
  tag?: string;
  /**
   * ms epoch this community enlisted in the Channel War — the tournament's own
   * enrollment mark, written once when the squad is minted and never edited.
   */
  enlistedAt?: number;
  /**
   * The cup this squad registered for. A squad without a stamp has no place in the running
   * championship's field, however high its Squad IQ.
   */
  cupId?: string;
  /** The Telegram id of the player who enlisted the squad: its leader and only admin. */
  ownerId?: string;
  /**
   * Registry flag: an invite link files a join request instead of adding the player to the
   * roster. The leader's own device keeps the authoritative switch in `SquadSave.admin`; this
   * field is the Worker's copy, used to seed a device that has never flipped the switch.
   */
  requireApproval?: boolean;
}

export interface RankedSquad extends Squad {
  rank: number;
  /**
   * True when this device created the squad. Custom squads live only on this device, so the local
   * player is their leader until the Worker names someone else.
   */
  owned: boolean;
}

const KEY = adoptUserStorageKey('detour.squads.v1');

interface SquadSave {
  boundId: string | null;
  custom: Squad[];
  bonus: Record<string, number>;
  /** Leader-only controls, keyed by squad id. Absent = never touched on this device. */
  admin: Record<string, SquadAdminState>;
}

function fresh(): SquadSave {
  return { boundId: null, custom: [], bonus: {}, admin: {} };
}

/** A stored join request, normalised so a stale or hostile row cannot break a roster write. */
function applicantOk(a: unknown): a is SquadApplicant {
  const x = a as Partial<SquadApplicant> | undefined;
  return !!x && typeof x.id === 'string' && x.id.length > 0 && x.id.length <= 24
    && typeof x.name === 'string' && x.name.length <= 24
    && typeof x.tiq === 'number' && Number.isFinite(x.tiq) && x.tiq >= 0
    && typeof x.country === 'string' && x.country.length <= 2
    && typeof x.requestedAt === 'number' && Number.isFinite(x.requestedAt) && x.requestedAt >= 0
    && (x.username === undefined || (typeof x.username === 'string' && x.username.length <= 32))
    && (x.photo === undefined || (typeof x.photo === 'string' && x.photo.length <= 300));
}

const ROLES: readonly SquadRole[] = ['leader', 'admin', 'member'];

/** A roster row from storage: an id is mandatory, everything else has a safe zero. */
function memberOk(m: unknown): m is SquadMember {
  const x = m as Partial<SquadMember> | undefined;
  return !!x && typeof x.id === 'string' && x.id.length > 0 && x.id.length <= 24
    && typeof x.name === 'string' && x.name.length <= 24
    && typeof x.tiq === 'number' && Number.isFinite(x.tiq) && x.tiq >= 0
    && typeof x.role === 'string' && (ROLES as readonly string[]).includes(x.role)
    && typeof x.joinedAt === 'number' && Number.isFinite(x.joinedAt) && x.joinedAt >= 0
    && typeof x.country === 'string' && x.country.length <= 2
    /* A portrait is decoration: anything longer than a URL is dropped here rather than
       allowed to invalidate a real player's row. */
    && (x.photo === undefined || (typeof x.photo === 'string' && x.photo.length <= 300));
}

/** A stored squad, normalised: the roster is the count, and the count is the roster. */
function squadOk(s: unknown): s is Squad {
  const x = s as Partial<Squad> | undefined;
  return !!x && typeof x.id === 'string' && x.id.length > 0 && x.id.length <= 48
    && typeof x.handle === 'string' && /^@[A-Za-z0-9_]{3,32}$/.test(x.handle)
    && typeof x.name === 'string' && x.name.length > 0 && x.name.length <= 32
    && Array.isArray(x.roster)
    && typeof x.trophies === 'number' && Number.isFinite(x.trophies) && x.trophies >= 0
    && (x.trend === 'up' || x.trend === 'down' || x.trend === 'same')
    && (x.kind === undefined || x.kind === 'channel' || x.kind === 'group')
    && (x.avatar === undefined || (typeof x.avatar === 'string' && x.avatar.length <= 160))
    && (x.tag === undefined || (typeof x.tag === 'string' && /^[A-Z0-9]{2,3}$/.test(x.tag)))
    && (x.subscribers === undefined || (typeof x.subscribers === 'number' && Number.isFinite(x.subscribers) && x.subscribers >= 0))
    && (x.ownerId === undefined || (typeof x.ownerId === 'string' && x.ownerId.length <= 24))
    && (x.requireApproval === undefined || typeof x.requireApproval === 'boolean')
    && (x.cupId === undefined || (typeof x.cupId === 'string' && x.cupId.length <= 48))
    && (x.enlistedAt === undefined || (typeof x.enlistedAt === 'number' && Number.isFinite(x.enlistedAt) && x.enlistedAt > 0));
}

/** Resolve the community type, defaulting deterministically for legacy saves. */
export function squadKind(s: Pick<Squad, 'id' | 'kind'>): SquadKind {
  if (s.kind === 'channel' || s.kind === 'group') return s.kind;
  let h = 0;
  for (let i = 0; i < s.id.length; i++) h = (h * 31 + s.id.charCodeAt(i)) >>> 0;
  return h % 2 === 0 ? 'channel' : 'group';
}

/** The roster's TIQ total — the numerator of the squad's average. */
export const squadTiqSum = (roster: SquadMember[]): number =>
  roster.reduce((sum, m) => sum + Math.max(0, Math.floor(m.tiq)), 0);

/** Squad IQ: the arithmetic mean of the roster's own TIQ, rounded once. */
export function squadTiqOf(roster: SquadMember[]): number {
  return roster.length ? Math.round(squadTiqSum(roster) / roster.length) : 0;
}

/**
 * Normalise a squad read from anywhere (this device's save, the Worker's board): dedupe the
 * roster by player id, keep exactly one leader, and re-derive the count and the Squad IQ so the
 * numbers can never disagree.
 */
export function normalizeSquad(squad: Squad, ownerId?: string): Squad {
  const seen = new Set<string>();
  const roster: SquadMember[] = [];
  for (const entry of squad.roster) {
    if (!memberOk(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    roster.push({ ...entry });
  }
  const owner = (ownerId ?? squad.ownerId ?? '').trim();
  if (owner) {
    for (const m of roster) {
      if (m.id === owner) m.role = 'leader';
      else if (m.role === 'leader') m.role = 'member';
    }
  }
  return { ...squad, roster, members: roster.length, trophies: squadTiqOf(roster) };
}

function migrate(raw: Partial<SquadSave> | null): SquadSave {
  const s = fresh();
  if (!raw || typeof raw !== 'object') return s;
  if (typeof raw.boundId === 'string') s.boundId = raw.boundId;
  if (Array.isArray(raw.custom)) {
    s.custom = raw.custom
      .filter(squadOk)
      .map((c) => normalizeSquad({ ...c, kind: squadKind(c) }))
      .slice(0, 40);
  }
  if (raw.bonus && typeof raw.bonus === 'object') {
    for (const [k, v] of Object.entries(raw.bonus)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1_000_000) s.bonus[k] = Math.floor(v);
    }
  }
  if (raw.admin && typeof raw.admin === 'object') {
    for (const [k, v] of Object.entries(raw.admin)) {
      const entry = v as Partial<SquadAdminState> | undefined;
      if (!entry || typeof k !== 'string' || k.length > 48) continue;
      s.admin[k] = {
        requireApproval: entry.requireApproval === true,
        /* A saved request may predate one of its optional fields. Fill the safe zeros first,
           then validate, so a partial row is repaired instead of silently dropped. */
        requests: (Array.isArray(entry.requests) ? entry.requests : [])
          .map((raw) => {
            const x = (raw ?? {}) as Partial<SquadApplicant>;
            return {
              id: typeof x.id === 'string' ? x.id : '',
              name: typeof x.name === 'string' ? x.name : '',
              tiq: typeof x.tiq === 'number' && Number.isFinite(x.tiq) ? x.tiq : 0,
              country: typeof x.country === 'string' ? x.country : '',
              requestedAt: typeof x.requestedAt === 'number' && Number.isFinite(x.requestedAt)
                ? x.requestedAt : Date.now(),
              ...(typeof x.username === 'string' ? { username: x.username } : {}),
              ...(typeof x.photo === 'string' ? { photo: x.photo } : {}),
            };
          })
          .filter(applicantOk)
          .map((a) => ({ ...a }))
          .slice(0, 60),
      };
    }
  }
  return s;
}

const save: SquadSave = migrate(readJson<SquadSave>(KEY));

const watchers: (() => void)[] = [];
function flush() {
  writeJson(KEY, save);
  for (const w of watchers) w();
}

/** Called after every bind / leave / roster change. */
export function onSquadChange(w: () => void) { watchers.push(w); }

/** Telegram username floor and ceiling, in characters. */
export const HANDLE_MIN = 4;
export const HANDLE_MAX = 32;

/**
 * Telegram usernames: 4–32 characters, letters, digits or underscores.
 * The `i` flag is load-bearing — `computerScience55` is a legal username and
 * must never be refused for its capitals.
 */
export const HANDLE_RE = /^[a-z0-9_]{4,32}$/i;

export type HandleIssue = '' | 'empty' | 'short' | 'long' | 'chars';

/**
 * Fold a `t.me` link, a typed `@` and the surrounding whitespace down to the bare
 * username. Every entry point reads a handle through this first, so the same
 * string is judged by the same rule whether it was typed, pasted or linked.
 */
export function bareHandle(raw: string): string {
  let value = (raw ?? '').trim();
  const link = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(.+)$/i.exec(value);
  if (link) value = link[1].split(/[?#]/)[0].replace(/\/+$/, '');
  return value.replace(/^@+/, '').trim();
}

/**
 * Why a typed or pasted community reference is not a Telegram username, or '' when it is.
 * Links and a leading `@` are folded first, so the same rule applies to every entry point.
 */
export function handleIssue(raw: string): HandleIssue {
  const value = bareHandle(raw);
  if (!value) return 'empty';
  if (value.length < HANDLE_MIN) return 'short';
  if (value.length > HANDLE_MAX) return 'long';
  return HANDLE_RE.test(value) ? '' : 'chars';
}

/** Normalise free text to @Handle, or '' when it cannot be a channel username. */
export function cleanHandle(raw: string): string {
  const bare = bareHandle(raw);
  return bare && HANDLE_RE.test(bare) ? `@${bare}` : '';
}

/** Normalise a crest call sign to 2–3 uppercase alphanumerics, or '' when invalid. */
export function cleanTag(raw: string): string {
  const tag = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  return /^[A-Z0-9]{2,3}$/.test(tag) ? tag : '';
}

/** Accept a bare username, a typed `@name` or a `t.me` link; return the canonical @Handle. */
export function cleanChatReference(raw: string): string {
  return cleanHandle(raw);
}

export const displayNameOf = (handle: string): string => {
  const base = handle.slice(1).replace(/[_]+/g, ' ').trim() || 'Squad';
  return base.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').slice(0, 32);
};

/**
 * Public profile photo for a Telegram channel/group. Returns '' for malformed
 * handles; the CDN may still answer with an error or a 1x1 placeholder, so
 * callers must keep a monogram underneath.
 */
export function telegramAvatarUrl(handle: string): string {
  const clean = cleanHandle(handle);
  return clean ? `https://t.me/i/userpic/320/${clean.slice(1)}.jpg` : '';
}

/**
 * The photo a squad crest paints. A Worker-resolved https URL (the cached channel photo)
 * wins; otherwise Telegram's public userpic for the handle is the same image by another
 * door. Anything else falls back to the monogram.
 */
export function squadAvatarUrl(s: Pick<Squad, 'handle' | 'avatar'>): string {
  const stored = (s.avatar ?? '').trim();
  if (/^https:\/\/[^\s]+$/i.test(stored)) return stored;
  return telegramAvatarUrl(s.handle);
}

/** The glyph on a squad crest: its call sign when registered, else the name's initial. */
export function squadMark(s: Pick<Squad, 'name' | 'handle' | 'tag'>): string {
  const tag = typeof s.tag === 'string' ? cleanTag(s.tag) : '';
  return tag || squadLetter(s);
}

/* ---------- identity ---------- */

/** This player's Telegram id, or '' outside the Mini App. */
export function myPlayerId(): string {
  const id = tgUser()?.id;
  return id === undefined || id === null ? '' : String(id).replace(/[^0-9]/g, '').slice(0, 24);
}

/**
 * The id this device's own roster row carries. Outside Telegram there is no numeric id, so a
 * locally-minted squad keys its founder on the one stable string this device has: `local`.
 */
export function myRosterId(): string {
  return myPlayerId() || 'local';
}

/** This player's Telegram @username without the `@`, or ''. */
export function myUsername(): string {
  return (tgUser()?.username ?? '').trim().replace(/^@+/, '').slice(0, 32);
}

/** This device's display name: the saved one, else the Telegram profile, else "You". */
export function myPlayerName(): string {
  const u = tgUser();
  const full = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
  if (full && full.toLowerCase() !== 'you') return full.slice(0, 24);
  const username = (u?.username ?? '').trim();
  return username ? username.slice(0, 24) : '';
}

/* ---------- invites ---------- */

/** `https://t.me/<bot>/<short-name>?startapp=squad_<id>` — the one link a squad ever shares. */
export function squadInviteUrl(id: string): string {
  return squadAppLink(id);
}

/** The squad id a `startapp=squad_<id>` payload names, or ''. */
export function squadIdFromPayload(raw: string): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  const prefix = SQUAD_PREFIX.toLowerCase();
  if (value.toLowerCase().slice(0, prefix.length) !== prefix) return '';
  const id = value.slice(prefix.length).replace(/[^A-Za-z0-9_-]/g, '');
  return id.slice(0, 48);
}

/* ---------- reading ---------- */

/**
 * The roster a squad paints: leader first, then by TIQ. The local player's own row is refreshed
 * from `myTiq()` on every read, so the score a player sees is always the one their games earned —
 * never a number frozen at join time.
 */
export function squadRosterOf(squad: Squad): SquadMember[] {
  const me = myRosterId();
  const roster = squad.roster.map((m) => ({ ...m }));
  const row = roster.find((m) => m.id === me);
  if (row) {
    row.tiq = Math.max(0, Math.floor(myTiq()));
    /* The portrait is this device's own fact, so it is refreshed from the live Telegram profile
       on every read: a player who has never re-synced still shows their real face on the board
       instead of the initials their join-day row happened to carry. */
    const u = tgUser();
    const photo = (u?.photo_url ?? '').trim().slice(0, 300);
    if (photo) row.photo = photo;
    if (!row.username) row.username = myUsername();
  }
  return roster.sort((a, b) =>
    Number(b.role === 'leader') - Number(a.role === 'leader')
    || b.tiq - a.tiq
    || a.joinedAt - b.joinedAt
    || a.id.localeCompare(b.id));
}

/** Customs, ranked by their roster's average TIQ, 1..n. Pure. */
export function getSquadRanking(): RankedSquad[] {
  const me = myPlayerId();
  const all: (Squad & { owned: boolean })[] = save.custom.map((s) => {
    const roster = squadRosterOf(s);
    return {
      ...s,
      roster,
      members: roster.length,
      trophies: squadTiqOf(roster),
      /* A squad with no recorded owner was minted on this device, so this device founded it. */
      owned: s.ownerId ? s.ownerId === me : true,
    };
  });
  all.sort((a, b) => b.trophies - a.trophies || b.members - a.members || a.handle.localeCompare(b.handle));
  return all.map((s, i) => ({ ...s, rank: i + 1 }));
}

export function getSquadById(id: string): RankedSquad | null {
  if (!id) return null;
  return getSquadRanking().find((s) => s.id === id) ?? null;
}

/* ---------- the cup registry ----------
   A cup is not "every squad this device knows". It is the set of squads that enlisted for that
   championship, and a player only ever reaches a cup board through one of them. Everything the
   Arena paints is filtered through these two reads. */

/**
 * The cup a squad is registered for. A row written before the stamp existed carries an
 * enlistment mark, and every enlistment is filed under the championship that was running — so
 * that row still counts. A squad with neither stamp is simply not in any cup.
 */
export function squadCupOf(s: Pick<Squad, 'cupId' | 'enlistedAt'>): string {
  const cup = typeof s.cupId === 'string' ? s.cupId.trim() : '';
  if (cup) return cup;
  return typeof s.enlistedAt === 'number' && s.enlistedAt > 0 ? ACTIVE_CUP_ID : '';
}

/**
 * The squads registered for one cup, in ranking order, re-ranked inside that field: the cup's
 * #1 is the strongest squad that actually enlisted, not the strongest squad this device has seen.
 */
export function cupField(cupId: string): RankedSquad[] {
  const id = (cupId ?? '').trim();
  if (!id) return [];
  return getSquadRanking()
    .filter((s) => squadCupOf(s) === id)
    .map((s, i) => ({ ...s, rank: i + 1 }));
}

/** The ids registered for one cup — the membership test every leaderboard row must pass. */
export function registeredCupSquadIds(cupId: string): Set<string> {
  return new Set(cupField(cupId).map((s) => s.id));
}

export function getMySquad(): RankedSquad | null {
  if (!save.boundId) return null;
  return getSquadRanking().find((s) => s.id === save.boundId) ?? null;
}

/** The role this player holds on a squad. A locally-created squad makes them its leader. */
export function mySquadRole(squad: { roster: SquadMember[]; ownerId?: string; owned?: boolean }): SquadRole {
  const me = myPlayerId();
  if (me) {
    const row = squad.roster.find((m) => m.id === me);
    if (row) return row.role;
    if (squad.ownerId === me) return 'leader';
  }
  return squad.owned ? 'leader' : 'member';
}

/** True when this player may manage the squad (its leader, or a promoted officer). */
export function isSquadAdmin(squad: Squad): boolean {
  const role = mySquadRole(squad);
  return role === 'leader' || role === 'admin';
}

/** Personal trophy contribution: this player's own row on the bound squad's roster. */
export function getMyContribution(): number {
  const me = getMySquad();
  if (!me) return 0;
  const row = me.roster.find((m) => m.id === myRosterId());
  if (row) return Math.max(0, Math.floor(row.tiq));
  return Math.max(0, Math.floor(save.bonus[me.id] ?? 0));
}

export function searchSquads(q: string, limit = 6): RankedSquad[] {
  const needle = (q ?? '').trim().replace(/^@/, '').toLowerCase();
  const all = getSquadRanking();
  if (!needle) return all.slice(0, limit);
  return all.filter((s) =>
    s.handle.toLowerCase().includes(needle) || s.name.toLowerCase().includes(needle),
  ).slice(0, limit);
}

/* ---------- writing ---------- */

/** The local row for this player: their own TIQ, their own name, their own country. */
function myRow(role: SquadRole, country: string): SquadMember {
  const photo = (tgUser()?.photo_url ?? '').trim().slice(0, 300);
  return {
    id: myRosterId(),
    name: myPlayerName(),
    tiq: Math.max(0, Math.floor(myTiq())),
    role,
    joinedAt: Date.now(),
    country: /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : '',
    username: myUsername(),
    ...(photo ? { photo } : {}),
  };
}

/**
 * Write a roster the Worker just returned. This is the only door the member list comes through,
 * so what the hub paints is exactly what the server holds.
 */
export function applySquadRoster(
  id: string,
  roster: SquadMember[],
  extra: { subscribers?: number; ownerId?: string; members?: number; tiq?: number } = {},
): RankedSquad | null {
  const at = save.custom.findIndex((s) => s.id === id);
  if (at < 0) return null;
  const ownerId = extra.ownerId ?? save.custom[at].ownerId;
  save.custom[at] = keepUsernames(normalizeSquad({
    ...save.custom[at],
    roster,
    ...(typeof extra.subscribers === 'number' ? { subscribers: extra.subscribers } : {}),
    ...(ownerId ? { ownerId } : {}),
  }, ownerId), save.custom[at]);
  flush();
  return getSquadById(id);
}

/** Bind this device to a squad and make sure the player has their own row on it. */
export function joinSquadLocally(
  id: string,
  roster?: SquadMember[],
  extra: { subscribers?: number; ownerId?: string; role?: SquadRole } = {},
): BindResult {
  const at = save.custom.findIndex((s) => s.id === id);
  if (at < 0) return 'bad-handle';
  const squad = save.custom[at];
  const rows = (roster ?? squad.roster).map((m) => ({ ...m }));
  const me = myRosterId();
  const existing = rows.find((m) => m.id === me);
  if (!existing) {
    rows.push(myRow(extra.role ?? 'member', ''));
  } else {
    existing.tiq = Math.max(0, Math.floor(myTiq()));
    if (extra.role) existing.role = extra.role;
  }
  save.custom[at] = normalizeSquad({
    ...squad,
    roster: rows,
    ...(typeof extra.subscribers === 'number' ? { subscribers: extra.subscribers } : {}),
    ...(extra.ownerId ? { ownerId: extra.ownerId } : {}),
  }, extra.ownerId ?? squad.ownerId);
  const was = save.boundId && save.boundId !== id ? 'switched' : save.boundId === id ? 'already' : 'bound';
  save.boundId = id;
  flush();
  return was;
}

/** Take a player off a roster after the Worker confirmed it. */
export function kickSquadMemberLocal(id: string, memberId: string): boolean {
  const at = save.custom.findIndex((s) => s.id === id);
  if (at < 0) return false;
  const squad = save.custom[at];
  if (squad.ownerId === memberId) return false;
  const before = squad.roster.length;
  save.custom[at] = normalizeSquad({
    ...squad,
    roster: squad.roster.filter((m) => m.id !== memberId),
  }, squad.ownerId);
  if (save.custom[at].roster.length === before) return false;
  flush();
  return true;
}

/**
 * Keep the @username this device already knew for a row the registry does not publish one for.
 *
 * The Worker stores a member's handle for its audit trail but never puts it on a board, so a
 * roster hydrated from the server comes back with empty usernames. The device learned its own
 * player's handle at join time; dropping it would take away the one public door to that photo.
 */
function keepUsernames(next: Squad, prev: Squad | undefined): Squad {
  if (!prev || !prev.roster.length) return next;
  const known = new Map(prev.roster.map((m) => [m.id, m.username ?? '']));
  return {
    ...next,
    roster: next.roster.map((m) => (m.username ? m : { ...m, username: known.get(m.id) ?? '' })),
  };
}

/**
 * Merge the Worker's public board into this device's known squads. Rows the board names replace
 * the cached copy (its roster is authoritative); a squad this device created but the board does
 * not carry yet is kept, because an enlistment that has not reached the board is not a deletion.
 */
export function hydrateSquadBoard(rows: Squad[]): void {
  if (!rows.length) return;
  let changed = false;
  for (const row of rows) {
    if (!squadOk(row)) continue;
    const next = normalizeSquad(row, row.ownerId);
    const at = save.custom.findIndex((s) => s.id === next.id);
    if (at >= 0) {
      /* The board is the registry's own reading, roster included: it replaces the cached copy so
         the card and the hub can never quote two different member lists. */
      save.custom[at] = keepUsernames(next, save.custom[at]);
    } else {
      save.custom = [...save.custom, next].slice(-40);
    }
    changed = true;
  }
  if (changed) flush();
}

export type BindResult = 'bound' | 'switched' | 'bad-handle' | 'already';

/**
 * Bind a handle this device has never seen. The squad is minted locally with exactly one member —
 * the player creating it — because inventing anyone else is exactly what this layer no longer does.
 */
export function bindSquad(rawHandle: string): BindResult {
  const handle = cleanHandle(rawHandle);
  if (!handle) return 'bad-handle';
  const ranking = getSquadRanking();
  const hit = ranking.find((s) => s.handle.toLowerCase() === handle.toLowerCase());
  if (hit) {
    if (save.boundId === hit.id) return 'already';
    const was = save.boundId ? 'switched' : 'bound';
    save.boundId = hit.id;
    flush();
    return was;
  }
  const id = `sq-${Date.now().toString(36)}-${handle.slice(1, 6).toLowerCase()}`;
  const me = myPlayerId();
  const created: Squad = {
    id,
    handle,
    name: displayNameOf(handle),
    roster: [myRow('leader', '')],
    members: 1,
    trophies: Math.max(0, Math.floor(myTiq())),
    trend: 'same',
    kind: 'channel',
    ...(me ? { ownerId: me } : {}),
    enlistedAt: Date.now(),
    cupId: ACTIVE_CUP_ID,
  };
  save.custom = [...save.custom, created].slice(-40);
  const was = save.boundId ? 'switched' : 'bound';
  save.boundId = id;
  flush();
  return was;
}

export interface RegisteredSquadInput {
  id?: string;
  handle: string;
  name: string;
  roster?: SquadMember[];
  members?: number;
  subscribers?: number;
  kind?: SquadKind;
  avatar?: string;
  tag?: string;
  ownerId?: string;
  /** The cup this enlistment is filed under; the running championship when the caller omits it. */
  cupId?: string;
  /** Registry copy of the leader's join-approval gate. */
  requireApproval?: boolean;
  /** `false` files the squad in the list without moving this device's binding (an invite look). */
  bind?: boolean;
}

export type ClaimResult =
  | { ok: true; squad: RankedSquad }
  | { ok: false; reason: 'bad-handle' | 'already' };

export function claimRegisteredSquad(input: RegisteredSquadInput): ClaimResult {
  const handle = cleanHandle(input.handle);
  if (!handle) return { ok: false, reason: 'bad-handle' };
  const existing = getSquadRanking().find((s) => s.handle.toLowerCase() === handle.toLowerCase());
  if (existing) return { ok: false, reason: 'already' };
  const fallbackId = `sq-${Date.now().toString(36)}-${handle.slice(1, 6).toLowerCase()}`;
  const id = (input.id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || fallbackId;
  if (getSquadRanking().some((s) => s.id === id)) return { ok: false, reason: 'already' };
  const name = (input.name || displayNameOf(handle)).trim().slice(0, 32) || displayNameOf(handle);
  const tag = cleanTag(input.tag ?? '');
  /* The roster is what the server said, or — for an enlistment made offline — just this player,
     who is the one person we can prove is on it. */
  const roster = (input.roster ?? []).filter(memberOk).map((m) => ({ ...m }));
  const me = myPlayerId();
  if (!roster.length) roster.push(myRow('leader', ''));
  const ownerId = input.ownerId ?? (me || roster.find((m) => m.role === 'leader')?.id || '');
  const created: Squad = normalizeSquad({
    id,
    handle,
    name,
    roster,
    members: roster.length,
    trophies: squadTiqOf(roster),
    trend: 'same',
    kind: input.kind === 'group' ? 'group' : 'channel',
    avatar: typeof input.avatar === 'string' ? input.avatar.slice(0, 160) : '',
    ...(typeof input.subscribers === 'number' && Number.isFinite(input.subscribers) && input.subscribers >= 0
      ? { subscribers: Math.floor(input.subscribers) }
      : {}),
    ...(tag ? { tag } : {}),
    ...(ownerId ? { ownerId } : {}),
    enlistedAt: Date.now(),
    cupId: (input.cupId ?? '').trim().slice(0, 48) || ACTIVE_CUP_ID,
    ...(typeof input.requireApproval === 'boolean' ? { requireApproval: input.requireApproval } : {}),
  }, ownerId);
  save.custom = [...save.custom, created].slice(-40);
  if (input.bind !== false) save.boundId = id;
  flush();
  return { ok: true, squad: getSquadById(id) ?? { ...created, rank: getSquadRanking().length, owned: true } };
}

export function bindSquadById(id: string): BindResult {
  const hit = getSquadRanking().find((s) => s.id === id);
  if (!hit) return 'bad-handle';
  if (save.boundId === id) return 'already';
  const was = save.boundId ? 'switched' : 'bound';
  save.boundId = id;
  flush();
  return was;
}

export function leaveSquad(): boolean {
  if (!save.boundId) return false;
  save.boundId = null;
  flush();
  return true;
}

/** Forget a squad entirely: the registry disbanded it, so this device must stop painting it. */
export function dropSquad(id: string): boolean {
  const at = save.custom.findIndex((s) => s.id === id);
  if (at < 0) return false;
  save.custom = save.custom.filter((s) => s.id !== id);
  if (save.boundId === id) save.boundId = null;
  delete save.bonus[id];
  delete save.admin[id];
  flush();
  return true;
}

/**
 * Bank a match's points for the bound squad.
 *
 * The player's own roster row *is* their score — it reads `myTiq()` on every paint — so there is
 * nothing to accumulate here beyond a flush that repaints the board. The return value stays a
 * squad so callers written against the old signature keep working.
 */
export function awardSquadPoints(n: number): RankedSquad | null {
  const me = getMySquad();
  if (!me) return null;
  const gain = Math.max(0, Math.floor(n));
  if (gain) flush();
  return getMySquad();
}

export interface ChannelCup {
  prizePool: number;
  players: number;
  endsAt: number;
  top: RankedSquad | null;
}

/** The cup meta Home paints: fixed pool, live headcount, midnight reset, current leader. */
export function getChannelCup(): ChannelCup {
  const ranking = getSquadRanking();
  const players = ranking.reduce((n, s) => n + s.members, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { prizePool: 12500, players, endsAt: end.getTime(), top: ranking[0] ?? null };
}

/* ---------- leader admin: the approval gate and the pending join queue ----------
   A squad's leader settings live in their own save bucket, keyed by squad id. They are kept out
   of `custom` so a registry hydration (which replaces the cached squad wholesale) can never
   silently reset the leader's lock or throw away the requests waiting for an answer. */

const MAX_REQUESTS = 60;

/** The device's own switch for one squad, seeded from the registry's copy on first read. */
function adminEntry(id: string): SquadAdminState {
  const held = save.admin[id];
  if (held) return held;
  const squad = save.custom.find((s) => s.id === id);
  const made: SquadAdminState = { requireApproval: squad?.requireApproval === true, requests: [] };
  save.admin[id] = made;
  return made;
}

/** A copy of the leader's controls; callers may sort or filter it without touching the save. */
export function getSquadAdminState(id: string): SquadAdminState {
  const entry = adminEntry(id);
  return { requireApproval: entry.requireApproval, requests: entry.requests.map((a) => ({ ...a })) };
}

/** The one gate the invite/join door reads: a locked squad files a request instead of entering. */
export function squadRequiresApproval(squad: Pick<Squad, 'id' | 'requireApproval'>): boolean {
  const held = save.admin[squad.id];
  return held ? held.requireApproval : squad.requireApproval === true;
}

/** Flip the lock. Both the local switch and the cached registry copy move in the same turn. */
export function setSquadRequireApproval(id: string, on: boolean): boolean {
  const at = save.custom.findIndex((s) => s.id === id);
  if (at < 0) return false;
  adminEntry(id).requireApproval = on;
  save.custom[at] = { ...save.custom[at], requireApproval: on };
  flush();
  return true;
}

/** This player's own request row, built from the same live facts a roster row uses. */
export function mySquadApplicant(): SquadApplicant {
  const photo = (tgUser()?.photo_url ?? '').trim().slice(0, 300);
  return {
    id: myRosterId(),
    name: myPlayerName().slice(0, 24),
    tiq: Math.max(0, Math.floor(myTiq())),
    country: '',
    requestedAt: Date.now(),
    username: myUsername(),
    ...(photo ? { photo } : {}),
  };
}

export type QueueResult = 'queued' | 'duplicate' | 'already-member' | 'no-squad';

/** File a join request. A squad member and a repeat request never enter the queue twice. */
export function queueSquadRequest(id: string, applicant: SquadApplicant): QueueResult {
  const squad = save.custom.find((s) => s.id === id);
  if (!squad || !applicantOk(applicant)) return 'no-squad';
  if (squad.roster.some((m) => m.id === applicant.id)) return 'already-member';
  const entry = adminEntry(id);
  if (entry.requests.some((a) => a.id === applicant.id)) return 'duplicate';
  entry.requests = [{ ...applicant }, ...entry.requests].slice(0, MAX_REQUESTS);
  flush();
  return 'queued';
}

/** Fold the registry's queue in, keeping a request this device filed while it was offline. */
export function mergeSquadRequests(id: string, rows: SquadApplicant[]): void {
  const clean = rows.filter(applicantOk).map((a) => ({ ...a })).slice(0, MAX_REQUESTS);
  const entry = adminEntry(id);
  const seen = new Set(clean.map((a) => a.id));
  entry.requests = [...clean, ...entry.requests.filter((a) => !seen.has(a.id))].slice(0, MAX_REQUESTS);
  flush();
}

/** Approve: the request leaves the queue and becomes a real, counted roster row. */
export function approveSquadRequestLocal(id: string, applicantId: string): boolean {
  const at = save.custom.findIndex((s) => s.id === id);
  if (at < 0) return false;
  const entry = adminEntry(id);
  const applicant = entry.requests.find((a) => a.id === applicantId);
  if (!applicant) return false;
  const squad = save.custom[at];
  if (!squad.roster.some((m) => m.id === applicant.id)) {
    const member: SquadMember = {
      id: applicant.id,
      name: applicant.name,
      tiq: Math.max(0, Math.floor(applicant.tiq)),
      role: 'member',
      joinedAt: Date.now(),
      country: /^[A-Za-z]{2}$/.test(applicant.country) ? applicant.country.toUpperCase() : '',
      ...(applicant.username ? { username: applicant.username } : {}),
      ...(applicant.photo ? { photo: applicant.photo } : {}),
    };
    save.custom[at] = normalizeSquad({ ...squad, roster: [...squad.roster, member] }, squad.ownerId);
  }
  entry.requests = entry.requests.filter((a) => a.id !== applicantId);
  flush();
  return true;
}

/** Reject: dismiss the request cleanly. Nothing about the roster changes. */
export function rejectSquadRequestLocal(id: string, applicantId: string): boolean {
  const entry = adminEntry(id);
  if (!entry.requests.some((a) => a.id === applicantId)) return false;
  entry.requests = entry.requests.filter((a) => a.id !== applicantId);
  flush();
  return true;
}

/** One-letter avatar snippet for a clay badge — no network, no image. */
export function squadLetter(s: Pick<Squad, 'name' | 'handle'>): string {
  const from = (s.name || s.handle || '?').replace(/^@/, '').trim();
  return (from.charAt(0) || '?').toUpperCase();
}
