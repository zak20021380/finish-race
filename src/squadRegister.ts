import { workerUrl } from './adminApi';
import { claimRegisteredSquad, type RankedSquad, type SquadKind } from './squads';
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

interface RegisterResponse {
  ok?: boolean;
  error?: string;
  message?: string;
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

const FAILED = 'Failed: You must be an admin of this community.';
const ALREADY = 'This channel/group is already registered as a Squad.';
const BOT = 'Bot is not added as an administrator to this chat.';

const failure = (error: string, message: string): SquadRegistrationResult => ({ ok: false, error, message });

export async function registerSquadWithTelegram(
  handle: string,
  identity: SquadIdentity,
): Promise<SquadRegistrationResult> {
  const url = workerUrl('/api/squads/register');
  if (!url) return failure('offline', 'Verification is unavailable right now. Try again shortly.');

  const initData = tgInitData();
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (initData) headers['x-telegram-init-data'] = initData;

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        chatUsername: handle,
        squadName: identity.name,
        squadTag: identity.tag,
        userTelegramId: tgUser()?.id === undefined ? '' : String(tgUser()?.id),
      }),
    });
  } catch {
    return failure('offline', 'Verification is unavailable right now. Try again shortly.');
  } finally {
    window.clearTimeout(timer);
  }

  let data: RegisterResponse | null = null;
  try {
    data = (await response.json()) as RegisterResponse;
  } catch {
    data = null;
  }

  if (!response.ok || !data || data.ok !== true || !data.squad) {
    const code = typeof data?.error === 'string' ? data.error : 'failed';
    if (code === 'not_admin') return failure(code, FAILED);
    if (code === 'already_registered') return failure(code, ALREADY);
    if (code === 'bot_not_admin') return failure(code, BOT);
    if (code === 'invalid_handle') return failure(code, data?.message ?? 'Enter a channel handle like @your_channel.');
    if (code === 'invalid_tag') return failure(code, data?.message ?? 'Tag must be 2–3 letters or numbers.');
    if (code === 'chat_not_found') return failure(code, 'Channel or group not found.');
    return failure(code, data?.message ?? 'Verification failed. Try again shortly.');
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
  if (!claimed.ok) {
    return failure(
      claimed.reason === 'already' ? 'already_registered' : 'invalid_handle',
      claimed.reason === 'already' ? ALREADY : 'Enter a channel handle like @your_channel.',
    );
  }
  return { ok: true, squad: claimed.squad, message: 'Squad successfully registered!' };
}
