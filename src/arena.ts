/**
 * arena.ts — the Arena Road, a trophy case of strategic realms.
 *
 * The Arena tab is a showcase, not a lobby: it paints the player's standing on a
 * four-realm road and nothing in here can start a match. Realm I is the current
 * realm; realms II–IV are sealed prestige vaults behind a TIQ gate, each stamped
 * COMING SOON until its content ships.
 *
 * The road is painted from ARENA_TIERS. A single repaint covers the realm cards,
 * the live TIQ pill and the progress module toward the next gate; it runs on
 * route entry, on a save that moved TIQ, and on a language switch.
 */
import { myTiq } from './matchmaking';
import { lang, onLang, t } from './settings';
import { onChange } from './storage';

export interface ArenaRoad {
  setRoute(id: string): void;
}

/** The live realm carries the player; every other realm is a sealed vault. */
type TierState = 'current' | 'locked';

interface ArenaTier {
  id: string;
  rank: number;
  /** TIQ needed to qualify. The current realm is always open. */
  reqTiq: number;
  state: TierState;
  accent: string;
  accentAlt: string;
  soft: string;
  line: string;
  /** The two ends of the card's gold-leaf hairline. */
  trimA: string;
  trimB: string;
  icon: string;
  nameKey: string;
  subKey: string;
  perkKeys: readonly [string, string];
}

export const ARENA_TIERS: readonly ArenaTier[] = [
  {
    id: 'crucible',
    rank: 1,
    reqTiq: 0,
    state: 'current',
    accent: '#06B6D4',
    accentAlt: '#0E7490',
    soft: 'rgba(6, 182, 212, .13)',
    line: 'rgba(6, 182, 212, .42)',
    trimA: 'rgba(34, 211, 238, .85)',
    trimB: 'rgba(234, 179, 8, .5)',
    icon: '#i-swords',
    nameKey: 'arena1Name',
    subKey: 'arena1Sub',
    perkKeys: ['arena1Perk1', 'arena1Perk2'],
  },
  {
    id: 'cabinet',
    rank: 2,
    reqTiq: 1200,
    state: 'locked',
    accent: '#D97706',
    accentAlt: '#92400E',
    soft: 'rgba(217, 119, 6, .13)',
    line: 'rgba(217, 119, 6, .38)',
    trimA: 'rgba(245, 158, 11, .8)',
    trimB: 'rgba(120, 53, 15, .55)',
    icon: '#i-target',
    nameKey: 'arena2Name',
    subKey: 'arena2Sub',
    perkKeys: ['arena2Perk1', 'arena2Perk2'],
  },
  {
    id: 'bastion',
    rank: 3,
    reqTiq: 2800,
    state: 'locked',
    accent: '#EAB308',
    accentAlt: '#CA8A04',
    soft: 'rgba(234, 179, 8, .12)',
    line: 'rgba(234, 179, 8, .36)',
    trimA: 'rgba(250, 204, 21, .82)',
    trimB: 'rgba(202, 138, 4, .55)',
    icon: '#i-shield',
    nameKey: 'arena3Name',
    subKey: 'arena3Sub',
    perkKeys: ['arena3Perk1', 'arena3Perk2'],
  },
  {
    id: 'apex',
    rank: 4,
    reqTiq: 5000,
    state: 'locked',
    accent: '#C084FC',
    accentAlt: '#7E22CE',
    soft: 'rgba(192, 132, 252, .13)',
    line: 'rgba(192, 132, 252, .38)',
    trimA: 'rgba(233, 213, 255, .85)',
    trimB: 'rgba(192, 132, 252, .5)',
    icon: '#i-crown',
    nameKey: 'arena4Name',
    subKey: 'arena4Sub',
    perkKeys: ['arena4Perk1', 'arena4Perk2'],
  },
];

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Persian copy reads with Persian figures; every other locale keeps Latin digits. */
const localizeDigits = (value: string): string =>
  lang === 'fa' ? value.replace(/\d/g, (d) => FA_DIGITS[Number(d)]) : value;

const num = (n: number): string =>
  localizeDigits(Math.max(0, Math.round(n)).toLocaleString('en-US'));

function fill(key: string, vars: Record<string, string>): string {
  let out = t(key);
  for (const [token, value] of Object.entries(vars)) out = out.split(`{${token}}`).join(value);
  return out;
}

const $ = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

/** The first sealed realm still above the player's TIQ; past the apex, the apex itself. */
const gateFor = (tiq: number): ArenaTier =>
  ARENA_TIERS.find((tier) => tier.state === 'locked' && tier.reqTiq > tiq) ??
  ARENA_TIERS[ARENA_TIERS.length - 1];

export function createArenaRoad(): ArenaRoad {
  const root = $('arena-road');
  if (!root) return { setRoute() { /* the Arena shell is not mounted */ } };

  const screen = document.getElementById('s-arena');
  const isVisible = (): boolean => !!screen && !screen.hidden;

  let lastTiq = -1;

  function cardMarkup(tier: ArenaTier, tiq: number): string {
    const name = t(tier.nameKey);
    const sub = t(tier.subKey);
    const locked = tier.state === 'locked';
    const reached = !locked || tiq >= tier.reqTiq;

    /* the sash owns the top-right corner on sealed realms; the live one has no sash */
    const ribbon = locked
      ? `<span class="arena-ribbon" aria-hidden="true">${t('arenaComingSoon')}</span>`
      : '';

    /* the foot of every card: a struck plate — the current realm's crest, or the vault seal */
    const plate = locked
      ? `<span class="arena-plate is-sealed">
          <svg class="arena-plate-seal" viewBox="0 0 52 60" aria-hidden="true"><use href="#i-lock-ti" /></svg>
          <span class="arena-plate-t">${t('arenaLocked')}</span>
        </span>`
      : `<span class="arena-plate is-live">
          <svg class="ico arena-plate-ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-chess-king" /></svg>
          <span class="arena-plate-t">${t('arenaCurrentRealm')}</span>
        </span>`;

    const perks = tier.perkKeys
      .map((key) => `<li class="arena-perk"><i class="arena-perk-dot" aria-hidden="true"></i>${t(key)}</li>`)
      .join('');

    const label = locked
      ? fill('arenaLockedAria', { name, n: num(tier.reqTiq) })
      : fill('arenaActiveAria', { name, n: num(tiq) });

    return `<article class="arena-tier" role="listitem" data-tier="${tier.id}"
        data-state="${tier.state}" data-reached="${reached}"
        style="--tier-a:${tier.accent};--tier-a2:${tier.accentAlt};--tier-soft:${tier.soft};--tier-line:${tier.line};--tier-trim-a:${tier.trimA};--tier-trim-b:${tier.trimB}"
        aria-label="${label}">
      <div class="arena-tier-rail" aria-hidden="true">
        <span class="arena-tier-node">${localizeDigits(String(tier.rank).padStart(2, '0'))}</span>
      </div>
      <div class="arena-tier-card">
        <svg class="arena-tier-glyph" viewBox="0 0 24 24" aria-hidden="true"><use href="${tier.icon}" /></svg>
        ${ribbon}
        <div class="arena-tier-top">
          <span class="arena-tier-kicker">${fill('arenaTierKicker', { n: num(tier.rank) })}</span>
        </div>
        <h2 class="arena-tier-name">${name}</h2>
        <p class="arena-tier-sub">${sub}</p>
        <span class="arena-milestone">
          <svg class="ico arena-milestone-ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-brain" /></svg>
          <b class="arena-milestone-n">${num(tier.reqTiq)}</b><i class="arena-milestone-plus" aria-hidden="true">+</i>
          <small class="arena-milestone-u">${t('arenaTiqShort')}</small>
        </span>
        <ul class="arena-perks" aria-label="${t('arenaPerks')}">${perks}</ul>
        ${plate}
      </div>
    </article>`;
  }

  function paintProgress(tiq: number): void {
    const target = gateFor(tiq);
    const reached = tiq >= target.reqTiq;
    const maxed = reached && target === ARENA_TIERS[ARENA_TIERS.length - 1];
    const pct = target.reqTiq > 0 ? Math.min(100, (tiq / target.reqTiq) * 100) : 100;

    const pill = $('arena-tiq-pill');
    if (pill) {
      const value = $('arena-tiq-value');
      if (value) value.textContent = num(tiq);
      pill.setAttribute('aria-label', fill('arenaTiqAria', { n: num(tiq) }));
    }

    const card = $('arena-progress-card');
    if (card) {
      card.style.setProperty('--next-a', target.accent);
      card.style.setProperty('--next-a2', target.accentAlt);
      card.style.setProperty('--next-soft', target.soft);
      card.style.setProperty('--next-line', target.line);
    }

    const nextName = $('arena-next-name');
    if (nextName) nextName.textContent = t(target.nameKey);
    const now = $('arena-progress-now');
    if (now) now.textContent = num(tiq);
    const goal = $('arena-progress-goal');
    if (goal) goal.textContent = num(target.reqTiq);

    const fillEl = $('arena-progress-fill');
    if (fillEl) fillEl.style.width = `${pct.toFixed(1)}%`;

    const track = $('arena-progress-track');
    if (track) {
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', String(target.reqTiq));
      track.setAttribute('aria-valuenow', String(Math.min(tiq, target.reqTiq)));
      track.setAttribute('aria-valuetext', `${num(tiq)} / ${num(target.reqTiq)} ${t('arenaTiqShort')}`);
    }

    const hint = $('arena-progress-hint');
    if (hint) {
      hint.textContent = maxed
        ? t('arenaMaxHint')
        : reached
          ? fill('arenaQualifiedHint', { name: t(target.nameKey) })
          : fill('arenaToNextHint', { n: num(target.reqTiq - tiq), name: t(target.nameKey) });
    }
  }

  function paint(tiq: number, force = false): void {
    if (!force && tiq === lastTiq) return;
    lastTiq = tiq;
    root!.setAttribute('aria-label', t('arenaRoadAria'));
    root!.innerHTML = ARENA_TIERS.map((tier) => cardMarkup(tier, tiq)).join('');
    paintProgress(tiq);
  }

  onChange(() => {
    if (isVisible()) paint(myTiq());
  });

  onLang(() => {
    lastTiq = -1;
    if (isVisible()) paint(myTiq(), true);
  });

  paint(myTiq(), true);

  return {
    setRoute(id: string) {
      /* The road is already mounted: repaint only when the TIQ that shapes it
         changed. A language flip resets `lastTiq`, so translated copy still moves. */
      if (id === 'arena') paint(myTiq());
    },
  };
}
