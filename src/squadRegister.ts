import { workerUrl } from './adminApi';
import { t } from './settings';
import {
  bindSquadById, claimRegisteredSquad, getMySquad, getSquadRanking,
  type RankedSquad, type SquadKind,
} from './squads';
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
  members: number;
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
  squad?: {
    id?: string;
    handle?: string;
    name?: string;
    members?: number;
    kind?: SquadKind;
    avatar?: string;
    tag?: string;
  };
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
    case 'bot_not_admin': return t('enlistErrBot');
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

/**
 * Ask the Worker to resolve a handle with Telegram's `getChat` and prove the selected tab's
 * type. The same call answers whether the chat is already on the registry, so the modal can
 * show the community's real title and avatar before anything is written.
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
  const members = typeof chat.members === 'number' && Number.isFinite(chat.members) && chat.members > 0
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
      members,
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
    userTelegramId: telegramUserId(),
  });
  if (!sent) return failure(OFFLINE, t('enlistErrOffline'));

  const { data, ok } = sent;
  if (!ok || !data || data.ok !== true || !data.squad) {
    const code = typeof data?.error === 'string' ? data.error : 'failed';
    return failure(code, squadErrorMessage(code, data?.kind, data?.message ?? ''));
  }

  const claimed = claimRegisteredSquad({
    id: data.squad.id,
    handle: data.squad.handle ?? handle,
    name: data.squad.name ?? identity.name,
    members: typeof data.squad.members === 'number' ? data.squad.members : 0,
    kind: data.squad.kind,
    avatar: data.squad.avatar,
    tag: data.squad.tag ?? identity.tag,
  });
  if (claimed.ok) return { ok: true, squad: claimed.squad, message: t('enlistToast') };

  /* The registry accepted the squad, so a local row that already holds this handle is not a
     refusal: bind the device to it instead of stranding a successful enlistment. */
  if (claimed.reason === 'already') {
    const existing = getSquadRanking().find(
      (s) => s.handle.toLowerCase() === (data.squad?.handle ?? handle).toLowerCase(),
    );
    if (existing) {
      bindSquadById(existing.id);
      return { ok: true, squad: getMySquad() ?? existing, message: t('enlistToast') };
    }
  }
  return failure(
    claimed.reason === 'already' ? 'already_registered' : 'invalid_handle',
    claimed.reason === 'already' ? t('enlistErrAlready') : t('enlistErrHandle'),
  );
}
