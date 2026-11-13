import { workerUrl } from './adminApi';
import { t } from './settings';
import {
  ACTIVE_CUP_ID, applySquadRoster, approveSquadRequestLocal, bindSquadById, claimRegisteredSquad,
  dropSquad, getMySquad, getSquadAdminState, getSquadById, getSquadRanking,
  hydrateSquadBoard as mergeSquadBoard, joinSquadLocally, kickSquadMemberLocal, leaveSquad,
  mergeSquadRequests, myPlayerId, mySquadApplicant, normalizeSquad, queueSquadRequest,
  rejectSquadRequestLocal, setSquadRequireApproval, squadIdFromPayload, squadRequiresApproval,
  type RankedSquad, type Squad, type SquadApplicant, type SquadKind, type SquadMember, type SquadRole,
} from './squads';
import { addNotification } from './notifications';
import { myTiq } from './matchmaking';
import { guestId, profile } from './storage';
import { tgInitData, tgUser } from './telegram';

export interface SquadRegistrationResult {
  ok: boolean;
  squad?: RankedSquad;
  error?: string;
  message: string;
}

export interface SquadIdentity {
  name: string;
  tag: string;
}

export interface SquadChatPreview {
  chatId: string;
  handle: string;
  name: string;
  kind: SquadKind;
  avatar: string;
  /** The chat's Telegram audience — an external stat, not the squad's member count. */
  subscribers: number;
}

export type SquadVerifyResult =
  | { ok: true; chat: SquadChatPreview }
  | { ok: false; code: string; kind?: SquadKind; message: string; status?: number; detail?: string };

/** What the Worker said, kept for DevTools after the friendly message has replaced it. */
export interface SquadFailureDetail {
  /** HTTP status of the refusal, `0` when the request never produced a response. */
  status: number;
  /** Telegram's own `description`/`error_code`, when the Worker forwarded one. */
  detail: string;
}

interface ChatPayload {
  chatId?: string;
  handle?: string;
  name?: string;
  kind?: SquadKind;
  avatar?: string;
  members?: number;
}

interface MemberPayload {
  id?: string;
  name?: string;
  tiq?: number;
  role?: string;
  joinedAt?: number;
  country?: string;
  username?: string;
  /** The player's Telegram profile photo, as their own client reported it. */
  photo?: string;
}

interface SquadPayload {
  id?: string;
  handle?: string;
  name?: string;
  kind?: SquadKind;
  avatar?: string;
  tag?: string;
  members?: number;
  subscribers?: number;
  tiq?: number;
  creatorId?: string;
  ownerId?: string;
  roster?: MemberPayload[];
  /** The cup this squad registered for — the key the Arena's eligibility filter reads. */
  cupId?: string;
  /** Leader's join-approval gate, as the registry holds it. */
  requireApproval?: boolean;
  /** Leader-only: the join requests waiting for an answer. */
  requests?: ApplicantPayload[];
}

interface ApplicantPayload {
  id?: string;
  name?: string;
  tiq?: number;
  country?: string;
  username?: string;
  photo?: string;
  requestedAt?: number;
}

interface VerifyResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  kind?: SquadKind;
  /** The diagnostic the Worker attaches on an unexpected refusal (see `verifySquad`). */
  detail?: string;
  chat?: ChatPayload;
}

interface RegisterResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  kind?: SquadKind;
  squad?: SquadPayload;
}

interface MemberResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  joined?: boolean;
  /** The squad is locked: the join became a pending request instead of a roster row. */
  pending?: boolean;
  role?: string;
  squad?: SquadPayload;
}

interface AdminResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  squad?: SquadPayload;
  requests?: ApplicantPayload[];
  recipients?: number;
}

interface BoardResponse {
  ok?: boolean;
  error?: string;
  squads?: SquadPayload[];
}

const OFFLINE = 'offline';

const failure = (error: string, message: string): SquadRegistrationResult => ({ ok: false, error, message });

const messageFor = (code: string, kind?: SquadKind): string => {
  switch (code) {
    case 'invalid_handle': return t('enlistErrHandle');
    case 'invalid_kind': return t('enlistErrPickKind');
    case 'chat_not_found': return t('enlistErrNotFound');
    case 'chat_private': return t('enlistErrPrivate');
    case 'unsupported_chat': return t('enlistErrUnsupported');
    case 'kind_mismatch': return kind === 'group'
      ? t('enlistErrPickGroup')
      : kind === 'channel' ? t('enlistErrPickChannel') : t('enlistErrPickKind');
    case 'already_registered': return t('enlistErrAlready');
    case 'enlist_in_progress': return t('enlistErrBusySquad');
    case 'unauthorized': return t('enlistErrUnauthorized');
    case 'not_admin': return t('enlistErrAdmin');
    case 'invalid_message': return t('squadBroadcastEmpty');
    case 'broadcast_failed': return t('squadBroadcastFailed');
    case 'bot_not_admin': return t('enlistErrBot');
    case 'no_such_squad': return t('squadErrGone');
    case 'telegram_required': return t('squadErrTelegram');
    case 'squad_banned': return t('squadErrBanned');
    case 'not_a_member': return t('squadErrJoinFirst');
    case 'leader_cannot_leave': return t('squadErrLeaderLeave');
    case 'cannot_kick_leader': return t('squadErrKickLeader');
    case 'cannot_kick_self': return t('squadErrKickSelf');
    case 'member_not_found': return t('squadErrNoMember');
    case 'unavailable':
    case 'telegram_error':
    case OFFLINE: return t('enlistErrOffline');
    case 'telegram_timeout': return t('enlistErrTimeout');
    case 'telegram_unreachable':
    case 'telegram_bad_response': return t('enlistErrNetwork');
    case 'telegram_unauthorized':
    case 'bot_token_missing': return t('enlistErrToken');
    case 'telegram_upstream': return t('enlistErrUpstream');
    default: return '';
  }
};

export const squadErrorMessage = (code: string, kind?: SquadKind, fallback = ''): string =>
  messageFor(code, kind) || fallback || t('enlistErrOffline');

function requestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  const initData = tgInitData();
  if (initData) headers['x-telegram-init-data'] = initData;
  headers['x-guest-id'] = guestId;
  return headers;
}

function telegramUserId(): string {
  const id = tgUser()?.id;
  return id === undefined ? '' : String(id);
}

async function postJson<T>(path: string, payload: Record<string, unknown>): Promise<{ data: T | null; ok: boolean; status: number } | null> {
  const url = workerUrl(path);
  if (!url) return null;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders(),
      signal: controller.signal,
      body: JSON.stringify(payload),
    });
    let data: T | null = null;
    try {
      data = (await response.json()) as T;
    } catch {
      data = null;
    }
    return { data, ok: response.ok, status: response.status };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

async function getJson<T>(
  path: string,
  withIdentity = false,
): Promise<{ data: T | null; ok: boolean; status: number } | null> {
  const url = workerUrl(path);
  if (!url) return null;
  const headers: Record<string, string> = { accept: 'application/json' };
  /* A leader-only read must carry the signed Mini App identity, or the Worker cannot prove
     which squad the caller is allowed to see requests for. */
  if (withIdentity) {
    const initData = tgInitData();
    if (initData) headers['x-telegram-init-data'] = initData;
  headers['x-guest-id'] = guestId;
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    let data: T | null = null;
    try {
      data = (await response.json()) as T;
    } catch {
      data = null;
    }
    return { data, ok: response.ok, status: response.status };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/** A Worker roster row, folded into the client's own shape. */
function toMember(row: MemberPayload): SquadMember | null {
  const id = typeof row.id === 'string' ? row.id.replace(/[^0-9A-Za-z_-]/g, '').slice(0, 24) : '';
  if (!id) return null;
  const role: SquadRole = row.role === 'leader' || row.role === 'admin' ? row.role : 'member';
  const tiq = Number(row.tiq);
  const joinedAt = Number(row.joinedAt);
  const country = typeof row.country === 'string' ? row.country.toUpperCase().slice(0, 2) : '';
  const photo = typeof row.photo === 'string' ? row.photo.trim().slice(0, 300) : '';
  return {
    id,
    name: typeof row.name === 'string' ? row.name.trim().slice(0, 24) : '',
    tiq: Number.isFinite(tiq) && tiq > 0 ? Math.floor(tiq) : 0,
    role,
    joinedAt: Number.isFinite(joinedAt) && joinedAt > 0 ? Math.floor(joinedAt) : 0,
    country: /^[A-Z]{2}$/.test(country) ? country : '',
    username: typeof row.username === 'string' ? row.username.replace(/^@+/, '').slice(0, 32) : '',
    ...(/^https:\/\/[^\s]+$/i.test(photo) ? { photo } : {}),
  };
}

/** A Worker join request, folded into the leader's queue shape. */
function toApplicant(row: ApplicantPayload): SquadApplicant | null {
  const id = typeof row.id === 'string' ? row.id.replace(/[^0-9A-Za-z_-]/g, '').slice(0, 24) : '';
  if (!id) return null;
  const tiq = Number(row.tiq);
  const at = Number(row.requestedAt);
  const photo = typeof row.photo === 'string' ? row.photo.trim().slice(0, 300) : '';
  return {
    id,
    name: typeof row.name === 'string' ? row.name.trim().slice(0, 24) : '',
    tiq: Number.isFinite(tiq) && tiq > 0 ? Math.floor(tiq) : 0,
    country: typeof row.country === 'string' ? row.country.toUpperCase().slice(0, 2) : '',
    requestedAt: Number.isFinite(at) && at > 0 ? Math.floor(at) : Date.now(),
    username: typeof row.username === 'string' ? row.username.replace(/^@+/, '').slice(0, 32) : '',
    ...(/^https:\/\/[^\s]+$/i.test(photo) ? { photo } : {}),
  };
}

/** A Worker squad payload, folded into a squad this device can store and paint. */
export function toSquad(payload: SquadPayload): Squad | null {
  const id = typeof payload.id === 'string' ? payload.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) : '';
  const handle = typeof payload.handle === 'string' ? payload.handle.trim() : '';
  const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 32) : '';
  if (!id || !handle || !name) return null;
  const roster = (Array.isArray(payload.roster) ? payload.roster : [])
    .map(toMember)
    .filter((m): m is SquadMember => m !== null);
  const ownerId = (payload.creatorId ?? payload.ownerId ?? '').replace(/[^0-9]/g, '').slice(0, 24);
  const subscribers = Number(payload.subscribers);
  return normalizeSquad({
    id,
    handle,
    name,
    roster,
    members: roster.length,
    trophies: 0,
    trend: 'same',
    kind: payload.kind === 'group' ? 'group' : 'channel',
    avatar: typeof payload.avatar === 'string' ? payload.avatar.slice(0, 160) : '',
    ...(typeof payload.tag === 'string' && payload.tag ? { tag: payload.tag } : {}),
    ...(Number.isFinite(subscribers) && subscribers >= 0 ? { subscribers: Math.floor(subscribers) } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(typeof payload.cupId === 'string' && payload.cupId.trim()
      ? { cupId: payload.cupId.trim().slice(0, 48) }
      : {}),
    ...(typeof payload.requireApproval === 'boolean' ? { requireApproval: payload.requireApproval } : {}),
  }, ownerId || undefined);
}

/** The player's own numbers, as every membership call reports them. */
function myPayload(): Record<string, unknown> {
  const u = tgUser();
  const name = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim().slice(0, 24);
  const photo = (u?.photo_url ?? '').trim().slice(0, 300);
  return {
    name,
    username: (u?.username ?? '').slice(0, 32),
    tiq: Math.max(0, Math.floor(myTiq())),
    country: /^[A-Za-z]{2}$/.test(profile.country ?? '') ? (profile.country as string).toUpperCase() : '',
    ...(/^https:\/\/[^\s]+$/i.test(photo) ? { photo } : {}),
  };
}

/**
 * Ask the Worker to resolve a handle with Telegram's `getChat` and prove the selected tab's
 * type. The same call answers whether the chat is already on the registry, so the modal can
 * show the community's real title and avatar before anything is written.
 *
 * `subscribers` is the chat's Telegram audience — the enlistment preview quotes it as such, and
 * never as the squad's member count.
 */
export async function verifySquadChat(handle: string, kind: SquadKind): Promise<SquadVerifyResult> {
  const sent = await postJson<VerifyResponse>('/api/squads/verify', {
    chatUsername: handle,
    kind,
    userTelegramId: telegramUserId(),
  });
  if (!sent) {
    /* No response at all: an origin that was never resolved, an aborted request, or a dead
       Worker. Logged with the path so the DevTools entry says which one this was. */
    console.error('[Squad Verification Failed]', {
      reason: 'no response',
      path: '/api/squads/verify',
      handle,
      kind,
      hint: 'worker origin missing, request aborted, or the Worker never answered',
    });
    return { ok: false, code: OFFLINE, message: t('enlistErrOffline'), status: 0, detail: 'no response' };
  }

  const { data, ok } = sent;
  if (!ok || !data || data.ok !== true || !data.chat) {
    const code = typeof data?.error === 'string' ? data.error : 'failed';
    const actual = data?.kind;
    const detail = data?.detail ?? data?.message ?? '';
    /* The exact server payload, before it is softened into a player-facing string. This is the
       line to read when the modal says "try again shortly": it names the code, the status and
       whatever Telegram answered. */
    console.error('[Squad Verification Failed]', {
      status: sent.status,
      code,
      kind: actual,
      message: data?.message,
      detail: data?.detail,
      payload: data,
    });
    return {
      ok: false,
      code,
      kind: actual,
      message: squadErrorMessage(code, actual),
      status: sent.status,
      detail,
    };
  }

  const chat = data.chat;
  const canonical = typeof chat.handle === 'string' && chat.handle ? chat.handle : handle;
  const name = typeof chat.name === 'string' && chat.name.trim() ? chat.name.trim() : canonical;
  const subscribers = typeof chat.members === 'number' && Number.isFinite(chat.members) && chat.members > 0
    ? Math.floor(chat.members)
    : 0;
  return {
    ok: true,
    chat: {
      chatId: typeof chat.chatId === 'string' ? chat.chatId : '',
      handle: canonical,
      name,
      kind: chat.kind === 'group' ? 'group' : 'channel',
      avatar: typeof chat.avatar === 'string' ? chat.avatar : '',
      subscribers,
    },
  };
}

export async function registerSquadWithTelegram(
  handle: string,
  identity: SquadIdentity,
  kind?: SquadKind,
): Promise<SquadRegistrationResult> {
  const sent = await postJson<RegisterResponse>('/api/squads/register', {
    chatUsername: handle,
    squadName: identity.name,
    squadTag: identity.tag,
    ...(kind ? { kind } : {}),
    /* An enlistment is filed under the running championship, never under "any cup": the
       registry has to be able to say which field this squad is actually in. */
    cupId: ACTIVE_CUP_ID,
    ...myPayload(),
    userTelegramId: telegramUserId(),
  });
  if (!sent) return failure(OFFLINE, t('enlistErrOffline'));

  const { data, ok } = sent;
  if (!ok || !data || data.ok !== true || !data.squad) {
    const code = typeof data?.error === 'string' ? data.error : 'failed';
    return failure(code, squadErrorMessage(code, data?.kind, data?.message ?? ''));
  }

  const remote = data.squad;
  const claimed = claimRegisteredSquad({
    id: remote.id,
    handle: remote.handle ?? handle,
    name: remote.name ?? identity.name,
    roster: toSquad(remote)?.roster,
    members: typeof remote.members === 'number' ? remote.members : 0,
    subscribers: typeof remote.subscribers === 'number' ? remote.subscribers : undefined,
    kind: remote.kind,
    avatar: remote.avatar,
    tag: remote.tag ?? identity.tag,
    ownerId: remote.creatorId ?? remote.ownerId,
    cupId: remote.cupId ?? ACTIVE_CUP_ID,
    requireApproval: remote.requireApproval,
  });
  if (claimed.ok) return { ok: true, squad: claimed.squad, message: t('enlistToast') };

  /* The registry accepted the squad, so a local row that already holds this handle is not a
     refusal: bind the device to it instead of stranding a successful enlistment. */
  if (claimed.reason === 'already') {
    const existing = getSquadRanking().find(
      (s) => s.handle.toLowerCase() === (remote.handle ?? handle).toLowerCase(),
    );
    if (existing) {
      const roster = toSquad(remote)?.roster;
      joinSquadLocally(existing.id, roster, {
        subscribers: remote.subscribers,
        ownerId: remote.creatorId ?? remote.ownerId,
      });
      return { ok: true, squad: getMySquad() ?? existing, message: t('enlistToast') };
    }
  }
  return failure(
    claimed.reason === 'already' ? 'already_registered' : 'invalid_handle',
    claimed.reason === 'already' ? t('enlistErrAlready') : t('enlistErrHandle'),
  );
}

/* ---------- membership ---------- */

export interface SquadActionResult {
  ok: boolean;
  code?: string;
  message?: string;
  squad?: RankedSquad;
  /** A locked squad filed a join request instead of adding this player to the roster. */
  pending?: boolean;
  /** The Worker never answered; the local write still landed. */
  offline?: boolean;
}

const actionFailure = (code: string, message?: string): SquadActionResult =>
  ({ ok: false, code, message: squadErrorMessage(code, undefined, message ?? '') });

/** Fold a successful membership answer into this device's store and hand back the live squad. */
function absorb(payload: SquadPayload | undefined): RankedSquad | null {
  if (!payload) return null;
  const squad = toSquad(payload);
  if (!squad) return null;
  const local = getSquadRanking().find((s) => s.id === squad.id);
  if (!local) return null;
  const bound = joinSquadLocally(squad.id, squad.roster, {
    subscribers: squad.subscribers,
    ownerId: squad.ownerId,
  });
  return bound === 'bad-handle' ? null : getMySquad() ?? local;
}

/**
 * Join a squad on the Worker, then bind this device to it.
 *
 * The roster is written server-side first: a join that only happened on the phone would be a
 * member nobody else can see. The local write mirrors the answer, so the hub paints exactly what
 * the registry holds.
 */
export async function joinSquadOnServer(id: string): Promise<SquadActionResult> {
  const local = getSquadRanking().find((s) => s.id === id);
  if (!local) return actionFailure('no_such_squad');
  /* A locked squad never takes a direct join: the invite files a request and stops here, before
     a single roster row is written. The registry's own copy of the flag lands on this device
     through `fetchSquad`, so a link opened on another phone sees the same gate. */
  const me = myPlayerId();
  const alreadyOn = !!me && local.roster.some((m) => m.id === me);
  if (squadRequiresApproval(local) && !alreadyOn) return fileSquadJoinRequest(id);

  if (!telegramUserId()) {
    /* No Telegram identity means no roster row the registry can key on. The local squad (minted
       on this device) is still joinable, which is what keeps a browser tab playable. */
    if (local.ownerId && local.ownerId !== telegramUserId()) return actionFailure('telegram_required');
    const was = joinSquadLocally(id);
    return was === 'bad-handle' ? actionFailure('no_such_squad') : { ok: true, squad: getMySquad() ?? local };
  }

  const sent = await postJson<MemberResponse>('/api/squads/join', { squadId: id, ...myPayload() });
  /* The Worker may answer "pending" when its own gate is newer than this device's cached flag. */
  if (sent?.ok && sent.data?.ok === true && sent.data.pending === true) {
    queueSquadRequest(id, mySquadApplicant());
    return { ok: true, pending: true, squad: local };
  }
  if (!sent) return actionFailure(OFFLINE);
  const { data, ok } = sent;
  if (!ok || !data || data.ok !== true) {
    const code = typeof data?.error === 'string' ? data.error : 'failed';
    return actionFailure(code, data?.message);
  }
  const squad = absorb(data.squad);
  if (!squad) return actionFailure('no_such_squad');
  return { ok: true, squad };
}

/**
 * File a join request on the leader's queue. The local queue is the interactive source of truth
 * so the flow still works with the Worker unreachable; the POST is the cross-device replication
 * that lets a leader reviewing on another phone see the very same applicant.
 */
async function fileSquadJoinRequest(id: string): Promise<SquadActionResult> {
  const local = getSquadById(id);
  const queued = queueSquadRequest(id, mySquadApplicant());
  if (queued === 'no-squad') return actionFailure('no_such_squad');
  const sent = await postJson<AdminResponse>('/api/squads/request', { squadId: id, ...myPayload() });
  return {
    ok: true,
    pending: true,
    squad: local ?? undefined,
    offline: !sent,
  };
}

/**
 * Re-report this player's score to the squad they are on. Called on launch and after a settled
 * match, so a member's contribution is always their latest real TIQ rather than the number they
 * happened to hold on the day they joined.
 */
export async function syncSquadScore(): Promise<RankedSquad | null> {
  const mine = getMySquad();
  if (!mine || !telegramUserId()) return mine;
  const sent = await postJson<MemberResponse>('/api/squads/sync', { squadId: mine.id, ...myPayload() });
  if (!sent?.ok || !sent.data || sent.data.ok !== true) return mine;
  return absorb(sent.data.squad) ?? mine;
}

export async function leaveSquadOnServer(id: string): Promise<SquadActionResult> {
  const mine = getSquadRanking().find((s) => s.id === id);
  if (!mine) return actionFailure('no_such_squad');
  const me = telegramUserId();
  /* Outside Telegram there is no roster row to remove: the local binding is the whole squad. */
  if (!me) {
    leaveSquad();
    return { ok: true };
  }
  const sent = await postJson<MemberResponse & { disbanded?: boolean }>(
    '/api/squads/leave',
    { squadId: id, ...myPayload() },
  );
  if (!sent) return actionFailure(OFFLINE);
  const { data, ok } = sent;
  if (!ok || !data || data.ok !== true) {
    const code = typeof data?.error === 'string' ? data.error : 'failed';
    return actionFailure(code, data?.message);
  }
  if (data.disbanded === true) {
    /* The last player left, so the registry dropped the squad: this device drops it too. */
    dropSquad(id);
    return { ok: true };
  }
  leaveSquad();
  /* The roster the answer carries is already without this player: paint it as-is rather than
     re-adding them through a membership write. */
  if (data.squad) {
    const squad = toSquad(data.squad);
    if (squad) {
      applySquadRoster(squad.id, squad.roster, {
        subscribers: squad.subscribers,
        ownerId: squad.ownerId,
      });
    }
  }
  return { ok: true };
}

/** Remove another player. Leader only, and never the leader themself. */
export async function kickSquadMember(id: string, memberId: string): Promise<SquadActionResult> {
  const mine = getSquadRanking().find((s) => s.id === id);
  if (!mine) return actionFailure('no_such_squad');
  if (mine.ownerId === memberId) return actionFailure('cannot_kick_leader');
  const sent = await postJson<MemberResponse>('/api/squads/kick', { squadId: id, memberId, ...myPayload() });
  if (!sent) return actionFailure(OFFLINE);
  const { data, ok } = sent;
  if (!ok || !data || data.ok !== true) {
    const code = typeof data?.error === 'string' ? data.error : 'failed';
    return actionFailure(code, data?.message);
  }
  kickSquadMemberLocal(id, memberId);
  /* The answer's roster is the registry's: paint exactly that, without a membership write. */
  if (data.squad) {
    const squad = toSquad(data.squad);
    if (squad) {
      applySquadRoster(squad.id, squad.roster, {
        subscribers: squad.subscribers,
        ownerId: squad.ownerId,
      });
    }
  }
  return { ok: true, squad: getSquadById(id) ?? undefined };
}

/** One squad's live view, folded into the local store. */
export async function fetchSquad(id: string): Promise<RankedSquad | null> {
  const sent = await getJson<{ ok?: boolean; squad?: SquadPayload }>(
    `/api/squads/squad?id=${encodeURIComponent(id)}`,
  );
  if (!sent?.ok || !sent.data || sent.data.ok !== true || !sent.data.squad) return null;
  const squad = toSquad(sent.data.squad);
  if (!squad) return null;
  const known = getSquadRanking().find((s) => s.id === squad.id);
  const me = myPlayerId();
  const onRoster = !!me && squad.roster.some((m) => m.id === me);
  if (known) {
    /* Paint the roster the registry holds. A local membership write happens only when the answer
       actually names this player: a kicked member must never be re-added by a page refresh. */
    if (onRoster) {
      joinSquadLocally(squad.id, squad.roster, { subscribers: squad.subscribers, ownerId: squad.ownerId });
    } else {
      applySquadRoster(squad.id, squad.roster, {
        subscribers: squad.subscribers,
        ownerId: squad.ownerId,
      });
    }
  } else {
    /* `bind: false`: an invite is a look, not an enrolment. The card lands in the list and the
       player's own binding is left exactly as it was. */
    claimRegisteredSquad({
      id: squad.id,
      handle: squad.handle,
      name: squad.name,
      roster: squad.roster,
      subscribers: squad.subscribers,
      kind: squad.kind,
      avatar: squad.avatar,
      tag: squad.tag,
      ownerId: squad.ownerId,
      requireApproval: squad.requireApproval,
      bind: false,
    });
  }
  return getSquadRanking().find((s) => s.id === squad.id) ?? null;
}

/**
 * Refresh the discovery board from the registry. With the seeded field gone this is the only
 * thing that fills the list, so it runs on launch and whenever the squad sheet opens.
 */
export async function refreshSquadBoard(): Promise<RankedSquad[]> {
  const sent = await getJson<BoardResponse>('/api/squads/board');
  if (!sent?.ok || !sent.data || sent.data.ok !== true || !Array.isArray(sent.data.squads)) {
    return getSquadRanking();
  }
  const rows = sent.data.squads
    .map((payload) => toSquad(payload))
    .filter((squad): squad is Squad => squad !== null);
  mergeSquadBoard(rows);
  return getSquadRanking();
}

/** Resolve a `squad_<id>` invite payload to a squad this device can open. */
export async function resolveSquadInvite(payload: string): Promise<RankedSquad | null> {
  const id = squadIdFromPayload(payload);
  if (!id) return null;
  const known = getSquadRanking().find((s) => s.id === id);
  if (known) return known;
  return fetchSquad(id);
}

/** The bound squad, after a server round trip when there is one to make. */
export async function refreshMySquad(): Promise<RankedSquad | null> {
  const mine = getMySquad();
  if (!mine) return null;
  const fresh = await fetchSquad(mine.id);
  if (!fresh) return mine;
  bindSquadById(fresh.id);
  return getMySquad() ?? fresh;
}

/* ---------- leader admin: lock, requests, broadcast ----------
   Every one of these is local-first: the modal paints the answer immediately from this device's
   store, and the Worker call replicates it (and, for the broadcast, wakes the bot). A Worker that
   never answers leaves the local control usable; one that explicitly refuses is reported. */

/** Flip the leader's join-approval gate, locally first and then on the registry. */
export async function setSquadApprovalOnServer(id: string, on: boolean): Promise<SquadActionResult> {
  if (!setSquadRequireApproval(id, on)) return actionFailure('no_such_squad');
  const sent = await postJson<AdminResponse>('/api/squads/admin/lock', {
    squadId: id, requireApproval: on, ...myPayload(),
  });
  const squad = getSquadById(id) ?? undefined;
  if (!sent) return { ok: true, squad, offline: true };
  if (!sent.ok || !sent.data || sent.data.ok !== true) {
    /* An explicit refusal (a non-leader, a vanished squad) must not leave a false switch: put
       this device back where the registry says it belongs. */
    setSquadRequireApproval(id, !on);
    const code = typeof sent.data?.error === 'string' ? sent.data.error : 'failed';
    return actionFailure(code, sent.data?.message);
  }
  return { ok: true, squad };
}

/** Read the leader's queue, folding the registry's rows into the device's own copy. */
export async function refreshSquadRequests(id: string): Promise<SquadApplicant[]> {
  const sent = await getJson<AdminResponse>(
    `/api/squads/admin/requests?squadId=${encodeURIComponent(id)}`
    + `&userTelegramId=${encodeURIComponent(telegramUserId())}`,
    true,
  );
  if (sent?.ok && sent.data?.ok === true && Array.isArray(sent.data.requests)) {
    const rows = sent.data.requests
      .map(toApplicant)
      .filter((a): a is SquadApplicant => a !== null);
    mergeSquadRequests(id, rows);
  }
  return getSquadAdminState(id).requests;
}

export type RequestDecision = 'approve' | 'reject';

/** Approve a request into the roster, or dismiss it; then tell the registry and the applicant. */
export async function decideSquadRequest(
  id: string,
  applicantId: string,
  decision: RequestDecision,
): Promise<SquadActionResult> {
  const done = decision === 'approve'
    ? approveSquadRequestLocal(id, applicantId)
    : rejectSquadRequestLocal(id, applicantId);
  if (!done) return actionFailure('member_not_found');
  const sent = await postJson<AdminResponse>('/api/squads/admin/decide', {
    squadId: id, applicantId, decision, ...myPayload(),
  });
  /* Only a roster that actually carries the newly approved player may replace this device's
     copy: an older answer must never un-approve someone the leader just admitted. */
  if (decision === 'approve' && sent?.ok && sent.data?.ok === true && sent.data.squad) {
    const remote = toSquad(sent.data.squad);
    if (remote && remote.roster.some((m) => m.id === applicantId)) {
      applySquadRoster(remote.id, remote.roster, {
        subscribers: remote.subscribers,
        ownerId: remote.ownerId,
      });
    }
  }
  return { ok: true, squad: getSquadById(id) ?? undefined, offline: !sent };
}

/** The one message that goes to every member, through the bot and the in-app inbox. */
export async function sendSquadBroadcast(id: string, text: string): Promise<SquadActionResult> {
  const body = text.trim().slice(0, 280);
  if (!body) return actionFailure('invalid_message');
  const squad = getSquadById(id);
  const sent = await postJson<AdminResponse>('/api/squads/admin/broadcast', {
    squadId: id, text: body, ...myPayload(),
  });
  if (sent && (!sent.ok || !sent.data || sent.data.ok !== true)) {
    const code = typeof sent.data?.error === 'string' ? sent.data.error : 'broadcast_failed';
    return actionFailure(code, sent.data?.message);
  }
  /* The leader's own device keeps a copy in the notification centre, so the announcement is
     visible even when the bot is unreachable. Members receive theirs from @Tactix_Robot. */
  addNotification({
    kind: 'announcement',
    title: t('squadBroadcastTitle'),
    body: `${squad?.name ?? ''}${squad?.name ? ' · ' : ''}${body}`.slice(0, 220),
    id: `squad-cast-${id}-${Date.now().toString(36)}`,
  });
  return { ok: true, squad: squad ?? undefined, offline: !sent };
}
