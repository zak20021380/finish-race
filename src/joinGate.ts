/**
 * joinGate.ts — the mandatory Telegram-channel gate.
 *
 * The Worker owns the switch (`POST /api/admin/force-join`) and answers each launch with one
 * reading from `GET /api/user/check-subscription`: is the gate armed, where does it point, and is
 * this signed session inside the channel. Only an explicit "not a member" answer raises this
 * overlay. A disabled gate, an unreachable Worker, or a check Telegram could not answer all fail
 * open, so a configuration fault never locks a player out of the arena.
 *
 * The overlay has no close key on purpose. Join opens the configured channel through Telegram's
 * own link handler; Verify re-reads the same endpoint and, the instant it passes, dismisses the
 * gate with a fade and settles any pending referral before the reward toast is painted.
 */
import { claimReferralRewards } from './storage';
import { playReward } from './sound';
import { gateReferral, refreshReferral } from './referral';
import { impact, notify, openLink, tgInitData, tgUser } from './telegram';
import { t } from './settings';
import { workerUrl } from './adminApi';
import { CHANNEL_URL } from '../shared/config';

const $ = (id: string) => document.getElementById(id);

/** Coin amounts are grouped the way the rest of the app groups them. */
const coins = (n: number): string => n.toLocaleString('en-US');

let started = false;
let toastTimer = 0;

/** The one reading the gate needs; every extra field is decoration for the panel. */
interface SubscriptionReading {
  ok?: boolean;
  forceJoinEnabled?: boolean;
  targetChannel?: string;
  channelUrl?: string;
  isMember?: boolean;
  /** The check could not be answered (bot misconfigured, Telegram unreachable). */
  unavailable?: boolean;
}

/**
 * Ask the Worker. `null` means the question itself could not be asked — outside Telegram, no
 * Worker origin, a refused or malformed answer — which the caller must treat as fail-open.
 */
async function readSubscription(): Promise<SubscriptionReading | null> {
  const base = workerUrl('/api/user/check-subscription');
  const init = tgInitData();
  if (!base || !init) return null;
  const id = tgUser()?.id;
  const query = id === undefined ? '' : `?userId=${encodeURIComponent(String(id))}`;

  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(`${base}${query}`, {
      signal: ac.signal,
      headers: { accept: 'application/json', 'x-telegram-init-data': init },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as SubscriptionReading;
    return data && data.ok === true ? data : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Boot entry. Safe to call once; every later call is a no-op. */
export function initJoinGate(): void {
  if (started) return;
  started = true;

  const overlay = $('force-join-modal');
  if (!overlay) return;
  /* A non-null alias the closures below can narrow against. */
  const gate = overlay;
  /* Outside Telegram there is no identity to check, and no gate to raise. */
  if (!tgUser() || !tgInitData()) {
    overlay.hidden = true;
    return;
  }

  const join = $('force-join-open') as HTMLButtonElement | null;
  const joinLabel = $('force-join-open-t');
  const verify = $('force-join-verify') as HTMLButtonElement | null;
  const verifyLabel = $('force-join-verify-t');
  const status = $('force-join-status');
  const kicker = $('force-join-kicker');
  const title = $('force-join-title');
  const body = $('force-join-body');
  const toastEl = $('force-join-toast');

  let busy = false;
  let channelUrl = CHANNEL_URL;
  let hideTimer = 0;
  /** The status line is stored by key, so a language switch repaints it too. */
  let statusKey = '';
  let statusError = false;

  function toast(text: string): void {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.hidden = false;
    window.requestAnimationFrame(() => toastEl.classList.add('show'));
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.classList.remove('show');
      window.setTimeout(() => { toastEl.hidden = true; }, 240);
    }, 3600);
  }

  /** Every word this controller owns, re-read on a language switch. */
  function applyCopy(): void {
    if (kicker) kicker.textContent = t('forceJoinKicker');
    if (title) title.textContent = t('forceJoinTitle');
    if (body) body.textContent = t('forceJoinBody');
    if (joinLabel) joinLabel.textContent = t('forceJoinJoin');
    if (verifyLabel) verifyLabel.textContent = busy ? t('forceJoinVerifying') : t('forceJoinVerify');
    if (status) {
      status.textContent = statusKey ? t(statusKey) : '';
      status.dataset.state = statusError ? 'error' : '';
    }
  }

  function setBusy(on: boolean): void {
    busy = on;
    if (verify) {
      verify.disabled = on;
      verify.setAttribute('aria-busy', String(on));
    }
    if (verifyLabel) verifyLabel.textContent = on ? t('forceJoinVerifying') : t('forceJoinVerify');
  }

  function setStatus(key: string, error = false): void {
    statusKey = key;
    statusError = error;
    if (!status) return;
    status.textContent = key ? t(key) : '';
    status.dataset.state = error ? 'error' : '';
  }

  function show(): void {
    window.clearTimeout(hideTimer);
    gate.hidden = false;
    gate.dataset.state = 'open';
    setStatus('');
    window.setTimeout(() => join?.focus({ preventScroll: true }), 40);
  }

  function hide(): void {
    gate.dataset.state = 'closing';
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      gate.hidden = true;
      gate.dataset.state = '';
      setStatus('');
    }, 240);
  }

  /**
   * Fold the referral ledger after a successful check. The Worker settles the credit in the same
   * request, so draining the unclaimed pool here is what turns it into spendable coins. A second
   * call adds nothing, which is why a second tap can never double-pay.
   */
  async function settle(announce: boolean): Promise<void> {
    const result = await gateReferral();
    if (result?.ok && result.joined) {
      if (result.credited) {
        const paid = claimReferralRewards();
        if (paid > 0) playReward();
        toast(paid > 0
          ? t('forceJoinRewardClaimed').replace('{n}', coins(paid))
          : t('forceJoinRewardPending'));
      } else if (announce) {
        toast(t('forceJoinVerified'));
      }
    } else if (announce) {
      toast(t('forceJoinVerified'));
    }
    void refreshReferral();
  }

  async function check(initial: boolean): Promise<void> {
    if (busy) return;
    if (!initial) {
      setBusy(true);
      setStatus('forceJoinChecking');
    }

    const reading = await readSubscription();
    if (!initial) setBusy(false);

    if (!reading) {
      /* No answer is not a refusal: open the arena and say the check could not run. */
      hide();
      if (!initial) toast(t('forceJoinUnavailable'));
      return;
    }

    channelUrl = reading.channelUrl || CHANNEL_URL;

    if (reading.forceJoinEnabled !== true) {
      hide();
      void settle(false);
      return;
    }
    if (reading.unavailable === true) {
      hide();
      if (!initial) toast(t('forceJoinUnavailable'));
      return;
    }
    /* Only an explicit false closes the gate; a malformed answer must fail open. */
    if (reading.isMember !== false) {
      hide();
      if (!initial) {
        impact('medium');
        notify('success');
        await settle(true);
      } else {
        void settle(false);
      }
      return;
    }

    /* An explicit "not a member": this is the only answer that raises the gate. */
    if (initial) {
      show();
      /* Bind a pending invite while the player is on the way to the channel. */
      void settle(false);
      return;
    }
    setStatus('forceJoinNotYet', true);
    notify('warning');
  }

  join?.addEventListener('click', () => {
    impact('light');
    openLink(channelUrl);
    setStatus('forceJoinJoinedHint');
  });
  verify?.addEventListener('click', () => { void check(false); });

  /* The gate holds focus until it is dismissed; Tab cannot wander into the app beneath it, and
     Escape has no meaning here because the overlay deliberately has no close key. */
  gate.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...gate.querySelectorAll<HTMLElement>('button:not([disabled])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  applyCopy();
  window.addEventListener('detour:lang', applyCopy);

  void check(true);
}
