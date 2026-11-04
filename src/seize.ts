/**
 * seize.ts — the confrontation card the dossier key and the Hall of Owners row both open.
 *
 * A medallion is minted once and kept once: the ledger has no path that moves a serial from one
 * player to another (`worker/badges.ts` answers only supply, mint and progress). What this module
 * can honestly stage is the *duel* — the seat is real, the room is real, and the rival's own app
 * already knows how to answer a `duel_relic_` link. So the card names the honor on the line, the
 * entry the seat asks for and the shelter the holder is standing under, then hands the whole thing
 * to the one challenge path the app has (`throwDuelChallenge`), which arms a room and shares it.
 *
 * Two things are deliberately absent, because nothing behind them exists:
 *
 *  - no currency moves. The entry is printed, never charged — a fee the ledger cannot settle would
 *    take coins for a reward it cannot deliver;
 *  - no ownership is asserted on a win. The card says the duel is thrown, not that the serial is
 *    won, so the certificate and the registry keep reading the server rather than this screen.
 *
 * The shelter clock is derived, not stored: it folds the honor's id and its serial into one hash,
 * so every device that looks at serial #042 sees the same countdown and the same verdict. A random
 * per-paint shield would let the same relic read as guarded to one player and exposed to the next.
 */
import { badgeCrestHtml, type BadgeDef } from './badges';
import { senderName, throwDuelChallenge } from './duelInvite';
import { myTiq } from './matchmaking';
import { t } from './settings';
import { impact, notify, relicDuelShareUrl } from './telegram';
import { showToast } from './toast';
import type { Sheets } from './sheets';

const HOUR = 3_600_000;
/** One shelter cycle: a relic stands guarded for its own length, then exposed until the cycle turns. */
const CYCLE = 72 * HOUR;

export interface RelicShelter {
  /** True while the holder is still under the shield — the relic cannot be called out. */
  sheltered: boolean;
  /** Whole hours left on the shield, rounded up; 0 once exposed. */
  hoursLeft: number;
}

/** FNV-1a over the honor and its serial — the same relic must never disagree with itself. */
function shelterSeed(seed: string, salt = ''): number {
  const text = `${seed}${salt}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function relicShelter(badgeId: string, serial: number): RelicShelter {
  const relic = `${badgeId}|${serial}`;
  const seed = shelterSeed(relic);
  /* the length comes off this hash and the phase off a second one over the same relic: folding both
     out of one 32-bit value would cap the phase at a fraction of the cycle, and every serial would
     land exposed (or guarded) at the same time of day rather than spreading across the clock */
  const length = (18 + (seed % 30)) * HOUR;
  const phase = shelterSeed(relic, 'phase') % CYCLE;
  const rel = (((Date.now() % CYCLE) - phase) % CYCLE + CYCLE) % CYCLE;
  return rel < length
    ? { sheltered: true, hoursLeft: Math.max(1, Math.ceil((length - rel) / HOUR)) }
    : { sheltered: false, hoursLeft: 0 };
}

/** The medallion a duel is being thrown over, and the seat it asks for. */
export interface SeizeTarget {
  def: BadgeDef;
  serial: number;
  holderName: string;
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
      if (els.cta) els.cta.disabled = next.sheltered;
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
  if (els.cta) els.cta.disabled = target.shelter.sheltered;
}

/**
 * Throw it: the same duel the result capsule throws, reached through the `duel_relic_` payload so
 * the rival's app greets them with the challenge. Nothing here settles the medallion afterwards.
 */
function confirmSeize(): void {
  const target = current;
  if (!target) return;
  impact('heavy');
  const line = t('seizeTaunt')
    .replace('{relic}', `#${String(target.serial).padStart(3, '0')}`)
    .replace('{holder}', target.holderName || t('seizeUnlisted'))
    .replace('{name}', senderName());
  if (!throwDuelChallenge({
    link: relicDuelShareUrl,
    text: line,
    waiting: t('seizeWaitingRival'),
    armed: t('seizeArmed'),
  })) {
    notify('error');
    showToast(t('seizeFailed'), 'error');
    return;
  }
  notify('success');
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

/** Open the confrontation card. No-op when the sheet was never installed. */
export function openSeize(target: SeizeTarget): void {
  if (!els.sheet || !sheets) return;
  paint(target);
  impact('light');
  sheets.open(els.sheet);
  startTicker();
}

/** The honor a dossier or a registry row is offering to duel over, with its shelter read fresh. */
export function seizeTargetOf(def: BadgeDef, serial: number, holderName: string): SeizeTarget {
  return { def, serial, holderName, shelter: relicShelter(def.id, serial) };
}

/** Whether this seat may be called out at all — the one question both entry points ask. */
export function isSeizable(def: BadgeDef, serial: number): boolean {
  return !relicShelter(def.id, serial).sheltered;
}
