/**
 * joinGate.ts — the mandatory channel-join gate.
 *
 * A verified Telegram session asks the Worker once on boot. The Worker checks `getChatMember` and,
 * when the player is not in the channel, this module raises the gate. The Join key opens the
 * channel; Verify re-runs the same check and, the instant it passes, the Worker settles the
 * pending referral in that request — before the gate is dismissed here.
 *
 * A settlement is paid, not just announced: the ledger credit the gate folds into the unclaimed
 * pool is flushed into the wallet on the spot, so the newcomer's welcome bonus is already in the
 * coin HUD when the gate closes. The inviter's half stays in the Hub's pool behind its Claim key —
 * the Worker has banked it, but this device does not spend another player's tap for them.
 *
 * It deliberately fails open: an unreachable Worker or a missing verification token must never
 * lock a player out of the arena. Only an explicit "not a member" answer shows the gate.
 */
import { claimReferralRewards } from './storage';
import { playReward } from './sound';
import { gateReferral, inboundReferralCode, refreshReferral } from './referral';
import { impact, notify, openLink, tgInitData, tgUser } from './telegram';
import { CHANNEL_URL, REFERRAL_REWARD } from '../shared/config';

const $ = (id: string) => document.getElementById(id);

/** Coin amounts are always grouped the way the rest of the app groups them. */
const coins = (n: number): string => n.toLocaleString('en-US');

let started = false;
let toastTimer = 0;

function toast(text: string): void {
  const el = $('join-gate-toast');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  window.requestAnimationFrame(() => el.classList.add('show'));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.remove('show');
    window.setTimeout(() => { el.hidden = true; }, 240);
  }, 3600);
}

/** Boot entry. Safe to call once; every later call is a no-op. */
export function initJoinGate(): void {
  if (started) return;
  started = true;

  const overlay = $('join-gate');
  if (!overlay) return;
  /* Outside Telegram there is no identity to check, and no gate to raise. */
  if (!tgUser() || !tgInitData()) {
    overlay.hidden = true;
    return;
  }

  const join = $('join-gate-join') as HTMLButtonElement | null;
  const verify = $('join-gate-verify') as HTMLButtonElement | null;
  const status = $('join-gate-status');
  const verifyLabel = verify?.querySelector<HTMLElement>('.join-gate-verify-t') ?? null;
  const body = $('join-gate-body');
  const reward = $('join-gate-reward');
  let busy = false;

  if (body && inboundReferralCode()) {
    body.textContent = 'Join the channel to lock in your invite reward and enter the arena.';
  }
  /* The banner promise is the ledger's own payout, never a number typed into the markup. */
  const rewardAmount = reward?.querySelector<HTMLElement>('b') ?? null;
  if (rewardAmount) rewardAmount.textContent = `${coins(REFERRAL_REWARD)} Coins`;
  if (reward && !inboundReferralCode()) {
    reward.hidden = true;
  }

  const setStatus = (text: string, error = false) => {
    if (!status) return;
    status.textContent = text;
    status.dataset.state = error ? 'error' : '';
  };

  const show = () => {
    overlay.hidden = false;
    setStatus('');
    window.setTimeout(() => join?.focus({ preventScroll: true }), 30);
  };

  const hide = () => {
    overlay.hidden = true;
    setStatus('');
  };

  async function check(initial: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    if (!initial) {
      if (verify) {
        verify.disabled = true;
        verify.setAttribute('aria-busy', 'true');
      }
      if (verifyLabel) verifyLabel.textContent = 'Verifying…';
      setStatus('Checking channel membership…');
    }
    const result = await gateReferral();
    busy = false;
    if (verify) {
      verify.disabled = false;
      verify.removeAttribute('aria-busy');
    }
    if (verifyLabel) verifyLabel.textContent = 'I’ve joined — Verify';

    if (!result || !result.ok || result.unavailable) {
      /* Cannot verify is not a refusal: let the player in and fold whatever the ledger answered. */
      hide();
      if (!initial) toast('Channel check unavailable — you can play. We’ll verify again next launch.');
      void refreshReferral();
      return;
    }
    if (!result.joined) {
      if (initial) show();
      else {
        setStatus('Not in the channel yet. Tap Join Channel, then Verify.', true);
        notify('warning');
      }
      return;
    }

    hide();
    if (result.credited) {
      /* `gateReferral` folded the settlement into the unclaimed pool; draining that pool is what
         turns the credit into a balance. Paying the pool rather than a fixed bonus is what makes
         this impossible to double-pay: a second settle adds nothing, so a second tap pays nothing. */
      const paid = claimReferralRewards();
      if (paid > 0) playReward();
      toast(paid > 0
        ? `Channel verified — +${coins(paid)} Coins added to your balance.`
        : 'Channel verified — your invite reward is on its way.');
      impact('medium');
      notify('success');
    } else if (!initial) {
      toast('Channel verified — welcome to the arena.');
      impact('light');
    }
    void refreshReferral();
  }

  join?.addEventListener('click', () => {
    impact('light');
    openLink(CHANNEL_URL);
    setStatus('Joined? Tap Verify to unlock the arena.');
  });
  verify?.addEventListener('click', () => { void check(false); });

  /* The gate holds focus until it is dismissed; Tab cannot wander into the app beneath it. */
  overlay.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll<HTMLElement>('button:not([disabled])')];
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

  void check(true);
}
