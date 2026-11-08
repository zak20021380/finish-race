/**
 * seize.ts — the confrontation card the dossier key and the Hall of Owners row both open.
 *
 * A medallion is minted once and kept once: the ledger has no path that moves a serial from one
 * player to another (`worker/badges.ts` answers only supply, mint and progress). What this module
 * can honestly stage is the *duel* — the seat is real, the room is real, and the rival's own app
 * answers the challenge over its live socket. So the card names the honor on the line, the entry
 * the seat asks for and the shelter the holder is standing under, then dispatches the challenge
 * inside the game (`RELIC_CHALLENGE_SEND`). Nothing leaves Telegram.
 *
 * Two things are deliberately absent, because nothing behind them exists:
 *
 *  - no currency moves. The entry is printed, never charged — a fee the ledger cannot settle would
 *    take coins for a reward it cannot deliver;
 *  - no ownership is asserted on a win. The card says the duel is thrown, not that the serial is
 *    won, so the certificate and the registry keep reading the server rather than this screen.
 *
 * The shelter clock is derived, not stored: it folds the honor's id and its serial into one hash
 * (`shared/relic.ts`), so every device and the Worker see the same countdown and the same verdict.
 */
import { badgeCrestHtml, type BadgeDef } from './badges';
import { sendRelicChallenge } from './network';
import { myTiq } from './matchmaking';
import { isSelfPlayerId } from './players';
import { t } from './settings';
import { impact, notify } from './telegram';
import { showRoyalToast, showToast } from './toast';
import { relicShelter, type RelicShelter } from '../shared/relic';
import type { Sheets } from './sheets';

export { relicShelter, type RelicShelter };

/** The medallion a duel is being thrown over, the seat it asks for and the player behind it. */
export interface SeizeTarget {
  def: BadgeDef;
  serial: number;
  holderName: string;
  /** The holder's verified session id — the only address the in-game challenge can reach. */
  targetUserId?: string;
  shelter: RelicShelter;
}

/** The scarcer the edition, the dearer the seat: a 25-serial honor asks four times a 100's entry. */
export const seizeEntry = (def: BadgeDef): number => Math.round(40_000 / Math.max(1, def.cap));

/** The TIQ this device puts forward — a share of its own standing, never the rival's. */
export const seizeRisk = (): number => Math.max(50, Math.round((myTiq() * 0.05) / 10) * 10);

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

const els = {
  sheet: null as HTMLElement | null,
  crest: null as HTMLElement | null,
  honor: null as HTMLElement | null,
  serial: null as HTMLElement | null,
  holder: null as HTMLElement | null,
  shelter: null as HTMLElement | null,
  entry: null as HTMLElement | null,
  risk: null as HTMLElement | null,
  bounty: null as HTMLElement | null,
  cta: null as HTMLButtonElement | null,
};

let sheets: Sheets | null = null;
let current: SeizeTarget | null = null;
let ticker = 0;
/** The crest is repainted only when the honor changes, so a ticking clock never re-renders the SVG. */
let crestFor = '';

/** Latin digits for the numeric tokens: the shield hours sit inside Persian copy and must not flip. */
const latin = (n: number): string => n.toLocaleString('en-US');

function shelterLine(target: SeizeTarget): string {
  return target.shelter.sheltered
    ? t('seizeSheltered').replace('{h}', latin(target.shelter.hoursLeft))
    : t('seizeExposed');
}

function paintShelter(): void {
  if (!els.shelter || !current) return;
  els.shelter.textContent = shelterLine(current);
  els.shelter.dataset.state = current.shelter.sheltered ? 'guarded' : 'open';
}

function stopTicker(): void {
  if (!ticker) return;
  window.clearInterval(ticker);
  ticker = 0;
}

/** The card re-reads its own clock while it is up, and stops the moment it is not. */
function startTicker(): void {
  stopTicker();
  ticker = window.setInterval(() => {
    if (!els.sheet || els.sheet.hidden) { stopTicker(); return; }
    if (!current) return;
    /* the verdict can turn while the player is reading: an expiring shield unlocks the key */
    const next = relicShelter(current.def.id, current.serial);
    if (next.sheltered !== current.shelter.sheltered || next.hoursLeft !== current.shelter.hoursLeft) {
      current = { ...current, shelter: next };
      paintShelter();
      if (els.cta) els.cta.disabled = next.sheltered || !current.targetUserId;
    }
  }, 30_000);
}

function paint(target: SeizeTarget): void {
  current = target;
  if (els.crest && crestFor !== target.def.id) {
    crestFor = target.def.id;
    els.crest.dataset.accent = target.def.accent;
    els.crest.innerHTML = badgeCrestHtml(target.def, 'badge-crest sz-crest-ico');
  }
  if (els.honor) els.honor.textContent = target.def.name;
  if (els.serial) {
    els.serial.textContent = t('seizeSerialOf')
      .replace('{serial}', `#${String(target.serial).padStart(3, '0')}`)
      .replace('{cap}', latin(target.def.cap));
  }
  if (els.holder) els.holder.textContent = target.holderName || t('seizeUnlisted');
  if (els.entry) els.entry.textContent = latin(seizeEntry(target.def));
  if (els.risk) els.risk.textContent = latin(seizeRisk());
  if (els.bounty) els.bounty.textContent = t('seizeBounty').replace('{name}', target.def.name);
  paintShelter();
  if (els.cta) {
    els.cta.style.display = '';
    els.cta.disabled = target.shelter.sheltered || !target.targetUserId;
  }
}

/**
 * Dispatch it: one wire action to the matchmaker, which pushes the challenge to the holder's live
 * socket (or files it in their mailbox when they are away). No Telegram share, no copied link.
 */
function confirmSeize(): void {
  const target = current;
  if (!target || target.shelter.sheltered) return;
  if (!target.targetUserId || isSelfPlayerId(target.targetUserId)) {
    notify('error');
    showToast(t('relicDuelNoTarget'), 'error');
    return;
  }
  impact('heavy');
  const sent = sendRelicChallenge({
    targetUserId: target.targetUserId,
    relicId: target.def.id,
    relicSerial: target.serial,
  });
  if (!sent) {
    notify('error');
    showToast(t('relicDuelOffline'), 'error');
    return;
  }
  notify('success');
  showRoyalToast('', t('relicDuelSent').replace('{name}', target.holderName || t('seizeUnlisted')), 'i-swords');
  /* The footer dies with the card: a dispatched challenge must not leave a live key on screen. */
  if (els.cta) {
    els.cta.disabled = true;
    els.cta.style.display = 'none';
  }
  current = null;
  stopTicker();
  sheets?.close();
}

export interface SeizeApi {
  sheets: Sheets;
}

/** Installed once at boot, so both the ladder dossier and the registry hand the card the same sheet. */
export function initSeize(api: SeizeApi): void {
  sheets = api.sheets;
  els.sheet = $<HTMLElement>('sheet-seize');
  if (!els.sheet) return;
  els.crest = $<HTMLElement>('sz-crest');
  els.honor = $<HTMLElement>('sz-honor');
  els.serial = $<HTMLElement>('sz-serial');
  els.holder = $<HTMLElement>('sz-holder');
  els.shelter = $<HTMLElement>('sz-shelter');
  els.entry = $<HTMLElement>('sz-entry');
  els.risk = $<HTMLElement>('sz-risk');
  els.bounty = $<HTMLElement>('sz-bounty');
  els.cta = $<HTMLButtonElement>('sz-cta');
  els.cta?.addEventListener('click', confirmSeize);
}

/** Open the confrontation card. No-op when the sheet was never installed, or when the holder is you. */
export function openSeize(target: SeizeTarget): void {
  if (!els.sheet || !sheets) return;
  if (target.targetUserId && isSelfPlayerId(target.targetUserId)) return;
  paint(target);
  impact('light');
  sheets.open(els.sheet);
  startTicker();
}

/** Drop any open confrontation and forget its target — called when the Profile tab takes the screen. */
export function resetSeizeContext(): void {
  stopTicker();
  current = null;
  crestFor = '';
  if (els.sheet && !els.sheet.hidden) sheets?.close();
}

/** The honor a dossier or a registry row is offering to duel over, with its shelter read fresh. */
export function seizeTargetOf(
  def: BadgeDef,
  serial: number,
  holderName: string,
  targetUserId?: string,
): SeizeTarget {
  return { def, serial, holderName, targetUserId, shelter: relicShelter(def.id, serial) };
}

/** Whether this seat may be called out at all — the one question both entry points ask. */
export function isSeizable(def: BadgeDef, serial: number): boolean {
  return !relicShelter(def.id, serial).sheltered;
}
