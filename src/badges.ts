/**
 * badges.ts — the Genius Triad: three prestige honors, one per player archetype.
 *
 * The catalogue is static and the unlock state is derived from the live save, so
 * a half-written localStorage blob can never smuggle a badge in. Only the
 * equipped badge id persists (profile.badge under detour.save.v2) — the same
 * single-key contract storage.ts already owns.
 *
 * Each archetype answers to a different proof:
 * - Churchill's Bastion  — Resilience: a 3-win streak, holding the line.
 * - Einstein's Singularity — Pure Intellect: the 1,500 TIQ threshold.
 * - Heisenberg's Formula — Calculated Precision: a 60% win rate over 5+ races.
 *
 * Each honor is also a numbered edition. The cap is fixed, and the serial is minted by
 * the Worker's singleton ledger (`GET /api/badges/supply`, `POST /api/badges/mint`) — never
 * invented on this device. The save only caches the last server-confirmed serial and supply
 * reading, so an offline shelf still shows the truth it last heard and a subtle syncing state
 * while it tries again.
 *
 * Ids are stable; the crest symbol and the CSS aura are both keyed by `accent`,
 * so a badge is one data row plus one #i-crest-<accent> in index.html. A badge
 * that ships rendered art paints that medallion instead, on every surface.
 */

import { cacheBadgeClaim, cacheBadgeSupply, profile, type EditionClaim, type EditionSupply } from './storage';
import { myTiq } from './matchmaking';
import { workerUrl } from './adminApi';
import { tgInitData, tgUser } from './telegram';
import einsteinMedallion from './assets/images/einstein.png';
import churchillMedallion from './assets/images/Futuristic Churchill Steel Medallion.png';
import heisenbergMedallion from './assets/images/Heisenberg Chrome Medallion.png';

export type BadgeAccent = 'titanium' | 'quantum' | 'frost';

export interface BadgeDef {
  id: string;
  name: string;
  /** The character the medal carries: the card's first line. */
  figure: string;
  /** The shortened archetype name printed on the shelf tile. */
  archetype: string;
  /** The psychological pillar the archetype represents. */
  pillar: string;
  /** One sentence of archetype copy, used by the pin spotlight and detail sheet. */
  description: string;
  /** Flavor — the legend the detail sheet prints under the title. */
  lore: string;
  /** The unlock requirement in player-facing words. */
  criteria: string;
  /** Names the sculpted crest (#i-crest-<accent>), its CSS aura, and the art fallback. */
  accent: BadgeAccent;
  /** Rendered medallion art; when set it replaces the vector crest everywhere the honor is worn. */
  art?: string;
  /** Hard edition cap. Mirrors `BADGE_CAPS` in worker/badges.ts; never mint above it. */
  cap: number;
}

export const GENIUS_TRIAD: readonly BadgeDef[] = [
  {
    id: 'churchill_bastion',
    name: "Churchill's Bastion",
    figure: 'Churchill',
    archetype: 'The Bastion',
    pillar: 'Resilience',
    description: 'Unyielding defence and comeback mastery. Holds the line until the board breaks.',
    lore: 'Never surrender. The wall is not a tactic; it is a promise.',
    criteria: 'Reach a 3-win streak. High-resilience runs and clutch comebacks forge the Bastion.',
    accent: 'titanium',
    art: churchillMedallion,
    cap: 100,
  },
  {
    id: 'einstein_singularity',
    name: "Einstein's Singularity",
    figure: 'Einstein',
    archetype: 'The Singularity',
    pillar: 'Pure Intellect',
    description: 'Spatial foresight and zero-error calculation. Sees the whole board before the first move.',
    lore: 'The board is not a race. It is a proof.',
    criteria: 'Bank 1,500 Tactical IQ. Pure calculation bends the board into a single answer.',
    accent: 'quantum',
    art: einsteinMedallion,
    cap: 50,
  },
  {
    id: 'heisenberg_formula',
    name: "Heisenberg's Formula",
    figure: 'Heisenberg',
    archetype: 'The Formula',
    pillar: 'Calculated Precision',
    description: 'Flawless tactical execution and cold dominance. Wins before the race begins.',
    lore: "No wasted moves. No reliance on luck. Pure, cold chemical dominance. You don't just win the board; you claim territory before the first move is made.",
    criteria: 'Win 60% of at least 5 competitive matches.',
    accent: 'frost',
    art: heisenbergMedallion,
    cap: 25,
  },
];

/** Back-compat alias: the catalogue is the triad. */
export const BADGES = GENIUS_TRIAD;

export const badgeById = (id: string | null | undefined): BadgeDef | null =>
  BADGES.find((b) => b.id === id) ?? null;

/**
 * The honor's crest as markup: its rendered medallion when one ships, else the
 * vector silhouette keyed by accent. Decorative — every host names the badge.
 */
export function badgeCrestHtml(def: BadgeDef, className = 'badge-crest'): string {
  if (def.art) {
    return `<img class="${className} badge-crest-art" src="${def.art}" alt="" aria-hidden="true" draggable="false" decoding="async"`
      + ` data-badge="${def.id}" data-accent="${def.accent}" />`
      + `<span class="medal-sheen" data-badge="${def.id}" style="--medal-mask:url('${def.art}')" aria-hidden="true"></span>`;
  }
  return `<svg class="${className}" viewBox="0 0 56 56" aria-hidden="true">`
    + `<use href="#i-crest-${def.accent}" /></svg>`;
}

const en = (n: number) => n.toLocaleString('en-US');

export interface BadgeProgress {
  got: number;
  need: number;
  /** 0..1, ready for meters and aria-valuenow ratios. */
  pct: number;
  /** The requirement's own unit, e.g. "2/3 win streak" or "62% win rate". */
  label: string;
  met: boolean;
}

/** Live progress against a badge's requirement — the same read the shelf and sheet use. */
export function badgeProgress(id: string): BadgeProgress {
  const s = profile.stats;
  switch (id) {
    case 'churchill_bastion': {
      const got = Math.min(Math.max(0, s.best), 3);
      return { got, need: 3, pct: got / 3, label: `${got}/3 win streak`, met: got >= 3 };
    }
    case 'einstein_singularity': {
      const need = 1500;
      const got = Math.max(0, myTiq());
      return {
        got,
        need,
        pct: Math.min(1, got / need),
        label: `${en(got)} / ${en(need)} TIQ`,
        met: got >= need,
      };
    }
    case 'heisenberg_formula': {
      if (s.games < 5) {
        const got = Math.min(Math.max(0, s.games), 5);
        return { got, need: 5, pct: got / 5, label: `${got}/5 races`, met: false };
      }
      const rate = Math.round((s.wins / s.games) * 100);
      return {
        got: rate,
        need: 60,
        pct: Math.min(1, rate / 60),
        label: `${rate}% / 60% wins`,
        met: rate >= 60,
      };
    }
    default:
      return { got: 0, need: 1, pct: 0, label: 'Locked', met: false };
  }
}

export function isBadgeUnlocked(id: string): boolean {
  return badgeById(id) !== null && badgeProgress(id).met;
}

/** The next step in the requirement's own unit — "Needs 3 more wins in a row". */
export function badgeDelta(id: string): string {
  const p = badgeProgress(id);
  if (p.met) return 'Requirement met';
  switch (id) {
    case 'churchill_bastion': {
      const n = Math.max(1, 3 - Math.max(0, profile.stats.best));
      return `Needs ${n} more consecutive win${n === 1 ? '' : 's'}`;
    }
    case 'einstein_singularity': {
      const n = Math.max(1, 1500 - Math.max(0, myTiq()));
      return `Needs ${en(n)} more TIQ`;
    }
    case 'heisenberg_formula': {
      const games = Math.max(0, profile.stats.games);
      const wins = Math.max(0, Math.min(games, profile.stats.wins));
      if (games < 5) {
        const n = 5 - games;
        return `Needs ${n} more race${n === 1 ? '' : 's'} to qualify`;
      }
      /* A win without a loss closes the rate gap fastest: (wins+k)/(games+k) >= .6. */
      const k = Math.max(0, Math.ceil(games * 1.5 - wins * 2.5));
      return k > 0 ? `Needs ${k} more win${k === 1 ? '' : 's'} in a row` : 'Requirement met';
    }
    default:
      return 'Locked';
  }
}

/* ---------- server-minted editions ---------- */

export type EditionSyncState = 'idle' | 'syncing' | 'live' | 'offline';

export interface EditionHolder {
  serial: number;
  /** Verified Telegram display name from the ledger; never a player id. */
  name: string;
}

export interface BadgeEdition {
  cap: number;
  /** The player's server-confirmed serial, or null until the ledger answers. */
  serial: number | null;
  /** Serials already claimed globally, or null before the first supply reading. */
  minted: number | null;
  /** Unclaimed serials left in the edition, or null before the first supply reading. */
  remaining: number | null;
  /** A mint roundtrip is in flight for this honor. */
  minting: boolean;
  /** Earned locally, but this device has no confirmed serial yet. */
  awaiting: boolean;
  /** The ledger says every slot is gone and this player holds none of them. */
  exhausted: boolean;
}

interface WireSupplyRow { cap?: unknown; minted?: unknown; remaining?: unknown; holders?: unknown }
interface WireMint {
  success?: unknown;
  serial?: unknown;
  cap?: unknown;
  mintedAt?: unknown;
  minted?: unknown;
  error?: unknown;
}

const BADGE_TIMEOUT = 4000;
const pad3 = (n: number) => String(n).padStart(3, '0');

/** "#042" — the serial as every surface prints it. */
export const editionSerialLabel = (serial: number): string => `#${pad3(serial)}`;

let syncState: EditionSyncState = 'idle';
let inFlight: Promise<void> | null = null;
const minting = new Set<string>();
const exhausted = new Set<string>();
/** Honors verified by the Worker during this page's life, so a route revisit is not a re-mint. */
const confirmed = new Set<string>();
/** The public holder index from the last live supply reading; never persisted or invented. */
const liveHolders = new Map<string, EditionHolder[]>();
const listeners = new Set<() => void>();

/** Subscribe to cache/mint transitions; returns the unsubscribe. */
export function onEditionChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function editionChanged(): void {
  for (const cb of listeners) {
    try { cb(); } catch { /* one listener must not stop the rest */ }
  }
}

export const editionSyncState = (): EditionSyncState => syncState;

/** The last live hall of fame for an honor, or null when this session has not read it. */
export function editionHolders(id: string): readonly EditionHolder[] | null {
  return liveHolders.get(id) ?? null;
}

function readHolders(raw: unknown, cap: number): EditionHolder[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<number>();
  const rows: EditionHolder[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const row = value as { serial?: unknown; name?: unknown };
    if (typeof row.serial !== 'number' || !Number.isInteger(row.serial) || row.serial < 1 || row.serial > cap) continue;
    if (seen.has(row.serial)) continue;
    seen.add(row.serial);
    const name = typeof row.name === 'string' ? row.name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) : '';
    rows.push({ serial: row.serial, name: name || 'Unlisted' });
  }
  return rows.sort((a, b) => a.serial - b.serial);
}

/** The same name the Worker derives from verified initData, so an optimistic row cannot disagree. */
function localHolderName(): string {
  const u = tgUser();
  const full = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
  return (full || u?.username || 'Player').slice(0, 20) || 'Player';
}

/** Add this player's fresh serial to a live index without waiting for the next supply read. */
function noteOwnHolder(id: string, serial: number): void {
  const current = liveHolders.get(id);
  if (!current || current.some((h) => h.serial === serial)) return;
  liveHolders.set(id, [...current, { serial, name: localHolderName() }].sort((a, b) => a.serial - b.serial));
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function claimOf(id: string): EditionClaim | null {
  const def = badgeById(id);
  if (!def) return null;
  const claim = profile.editions.claims[id];
  if (!claim || !Number.isFinite(claim.serial) || claim.serial < 1 || claim.serial > def.cap) return null;
  return claim;
}

function supplyOf(def: BadgeDef): EditionSupply | null {
  const row = profile.editions.supply[def.id];
  if (!row || !Number.isFinite(row.minted) || !Number.isFinite(row.remaining)) return null;
  return {
    cap: def.cap,
    minted: Math.max(0, Math.min(def.cap, Math.floor(row.minted))),
    remaining: Math.max(0, Math.min(def.cap, Math.floor(row.remaining))),
  };
}

export const hasEditionClaim = (id: string): boolean => claimOf(id) !== null;

/** A live supply payload, folded to the catalogue; null when it held none of our three ids. */
function readSupply(raw: unknown): Record<string, EditionSupply> | null {
  const badges = raw && typeof raw === 'object' ? (raw as { badges?: unknown }).badges : null;
  if (!badges || typeof badges !== 'object' || Array.isArray(badges)) return null;
  const table = badges as Record<string, WireSupplyRow>;
  const out: Record<string, EditionSupply> = {};
  let found = false;
  for (const def of BADGES) {
    const row = table[def.id];
    if (!row || typeof row !== 'object') continue;
    const minted = num(row.minted);
    const remaining = num(row.remaining);
    if (minted === null && remaining === null) continue;
    const m = Math.max(0, Math.min(def.cap, Math.floor(minted ?? def.cap - (remaining ?? 0))));
    const r = Math.max(0, Math.min(def.cap, Math.floor(remaining ?? def.cap - m)));
    out[def.id] = { cap: def.cap, minted: m, remaining: r };
    const holders = readHolders(row.holders, def.cap);
    if (holders) liveHolders.set(def.id, holders);
    else liveHolders.delete(def.id);
    found = true;
  }
  return found ? out : null;
}

function readMinted(raw: unknown, cap: number): EditionClaim | null {
  const body = raw && typeof raw === 'object' ? (raw as WireMint) : null;
  const serial = num(body?.serial);
  if (serial === null || !Number.isInteger(serial) || serial < 1 || serial > cap) return null;
  return {
    serial,
    cap,
    mintedAt: typeof body?.mintedAt === 'string' ? body.mintedAt.slice(0, 40) : '',
  };
}

function writeSupplyRow(def: BadgeDef, minted: number) {
  const capped = Math.max(0, Math.min(def.cap, Math.floor(minted)));
  cacheBadgeSupply({
    ...profile.editions.supply,
    [def.id]: { cap: def.cap, minted: capped, remaining: def.cap - capped },
  }, profile.editions.syncedAt);
}

export function badgeEdition(id: string): BadgeEdition {
  const def = badgeById(id);
  if (!def) {
    return { cap: 0, serial: null, minted: null, remaining: null, minting: false, awaiting: false, exhausted: false };
  }
  const claim = claimOf(def.id);
  const supply = supplyOf(def);
  const unlocked = isBadgeUnlocked(def.id);
  const drained = exhausted.has(def.id) || (supply !== null && supply.remaining <= 0);
  return {
    cap: def.cap,
    serial: claim?.serial ?? null,
    minted: supply?.minted ?? null,
    remaining: supply?.remaining ?? null,
    minting: minting.has(def.id) || (syncState === 'syncing' && unlocked && !claim && !drained),
    awaiting: unlocked && !claim && !drained,
    exhausted: !claim && drained,
  };
}

export type BadgeStatusKind = 'equipped' | 'serial' | 'unlocked' | 'minting' | 'editions';

export interface BadgeStatus {
  kind: BadgeStatusKind;
  /** The card's third line: "EQUIPPED", "#042 / 100", "UNLOCKED" or "25 EDITIONS". */
  text: string;
}

/**
 * What the player holds, in the card's own words — never a network state.
 * Equipped outranks the serial; an earned honor with no confirmed mint reads
 * UNLOCKED, and an unowned one offers its edition cap as a rarity tag.
 */
export function badgeStatus(id: string, equipped: boolean): BadgeStatus {
  const def = badgeById(id);
  if (!def) return { kind: 'editions', text: '—' };
  if (equipped) return { kind: 'equipped', text: 'EQUIPPED' };
  const ed = badgeEdition(def.id);
  if (ed.serial !== null) return { kind: 'serial', text: `${editionSerialLabel(ed.serial)} / ${ed.cap}` };
  if (ed.minting) return { kind: 'minting', text: 'MINTING…' };
  if (isBadgeUnlocked(def.id)) return { kind: 'unlocked', text: 'UNLOCKED' };
  return { kind: 'editions', text: `${def.cap} EDITIONS` };
}

/** The same state, spelled for a screen reader. */
export function editionSpeech(ed: BadgeEdition): string {
  if (ed.serial !== null) return `Edition ${ed.serial} of ${ed.cap}.`;
  if (ed.minting) return `Minting your edition of ${ed.cap}.`;
  if (ed.exhausted) return `All ${ed.cap} editions are claimed.`;
  if (ed.remaining !== null) return `${ed.remaining} of ${ed.cap} editions remaining.`;
  if (ed.awaiting) return 'Edition not minted yet.';
  return 'Edition supply syncing.';
}

/* ---------- the wire ---------- */

interface BadgeReply { ok: boolean; status: number; body: unknown }

async function badgeCall(path: string, init: RequestInit): Promise<BadgeReply | null> {
  const url = workerUrl('/api/badges');
  if (!url) return null;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.headers) Object.assign(headers, init.headers as Record<string, string>);
  const initData = tgInitData();
  if (initData) headers['x-telegram-init-data'] = initData;

  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), BADGE_TIMEOUT);
  try {
    const res = await fetch(`${url}${path}`, { ...init, headers, signal: ac.signal });
    let body: unknown = null;
    let parsed = false;
    try { body = await res.json(); parsed = true; } catch { /* empty or not JSON */ }
    /* A static host's SPA fallback answers 200 with index.html; that is not a ledger. */
    return { ok: res.ok && parsed, status: res.status, body };
  } catch {
    return null;                // offline, refused, or too slow: cached state stays up
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Fetch the live supply, push this player's progress snapshot, then mint every locally
 * unlocked honor the Worker has not confirmed this session. A failed call only flips the
 * sync state; it never throws and never clears the cached snapshot.
 */
export async function refreshBadgeEditions(): Promise<void> {
  if (inFlight) return inFlight;
  syncState = 'syncing';
  editionChanged();

  const snapshot = {
    tiq: myTiq(),
    games: profile.stats.games,
    wins: profile.stats.wins,
    streak: profile.stats.streak,
    best: profile.stats.best,
  };

  inFlight = (async () => {
    const [supplyReply, progressReply] = await Promise.all([
      badgeCall('/supply', { method: 'GET' }),
      badgeCall('/progress', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshot),
      }),
    ]);

    let supplyLive = false;
    if (supplyReply?.ok) {
      const live = readSupply(supplyReply.body);
      if (live) {
        cacheBadgeSupply({ ...profile.editions.supply, ...live }, Date.now());
        supplyLive = true;
      }
    }

    const progressLive = progressReply?.ok
      && Boolean(progressReply.body && typeof progressReply.body === 'object'
        && (progressReply.body as { success?: unknown }).success === true);

    /* A refused mint is not a transport failure: 403 is the ledger's criteria answer and 409 is
       an edition that is simply gone. Anything else means the roundtrip itself did not land. */
    let mintBroken = false;

    if (progressLive) {
      for (const def of BADGES) {
        if (!isBadgeUnlocked(def.id) || confirmed.has(def.id) || exhausted.has(def.id)) continue;
        const supply = supplyOf(def);
        if (supply !== null && supply.remaining <= 0 && !claimOf(def.id)) {
          exhausted.add(def.id);
          continue;
        }

        minting.add(def.id);
        editionChanged();
        const reply = await badgeCall('/mint', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ badgeId: def.id }),
        });
        minting.delete(def.id);

        if (!reply) {
          mintBroken = true;
          editionChanged();
          break;
        }
        if (reply.ok) {
          const claim = readMinted(reply.body, def.cap);
          if (claim) {
            cacheBadgeClaim(def.id, claim);
            noteOwnHolder(def.id, claim.serial);
            confirmed.add(def.id);
            writeSupplyRow(def, Math.max(claim.serial, supplyOf(def)?.minted ?? 0));
          } else {
            mintBroken = true;          // a 200 that is not a serial cannot be trusted
          }
        } else if (reply.status === 409) {
          exhausted.add(def.id);
          writeSupplyRow(def, num((reply.body as WireMint | null)?.minted) ?? def.cap);
        } else if (reply.status !== 403) {
          mintBroken = true;
        }
        editionChanged();
      }
    }

    syncState = supplyLive && progressLive && !mintBroken ? 'live' : 'offline';
    editionChanged();
  })().catch(() => {
    syncState = 'offline';
    editionChanged();
  }).finally(() => {
    inFlight = null;
  });

  return inFlight;
}

export function unlockedCount(): number {
  return BADGES.filter((b) => isBadgeUnlocked(b.id)).length;
}

export function equippedBadge(): BadgeDef | null {
  if (!profile.badge) return null;
  const def = badgeById(profile.badge);
  if (!def) return null;
  return isBadgeUnlocked(def.id) ? def : null;
}

/** An honor as it is worn: the catalogue row plus the ledger's serial, when one exists. */
export interface WornEdition {
  def: BadgeDef;
  serial: number | null;
}

/** The honor this device wears, with its server-confirmed serial if the ledger has answered. */
export function wornEdition(): WornEdition | null {
  const def = equippedBadge();
  if (!def) return null;
  return { def, serial: claimOf(def.id)?.serial ?? null };
}

/** Generic ledger names that must never be mistaken for a ladder player. */
const HOLDER_SKIP = new Set(['', 'unlisted', 'player', 'you', 'available']);

/**
 * A ladder player's minted honor, read from the public holder index.
 *
 * The ledger publishes who holds which serial, not which honor is currently equipped,
 * so the rarest cap is the strongest honor it can honestly attribute to that name.
 * Returns null until a live supply reading has landed, or when no holder carries the name.
 */
export function holderEdition(name: string): WornEdition | null {
  const key = name.trim().toLowerCase();
  if (HOLDER_SKIP.has(key)) return null;
  let best: WornEdition | null = null;
  for (const def of BADGES) {
    const holders = liveHolders.get(def.id);
    if (!holders) continue;
    const hit = holders.find((h) => h.name.trim().toLowerCase() === key);
    if (!hit) continue;
    if (!best || def.cap < best.def.cap) best = { def, serial: hit.serial };
  }
  return best;
}
