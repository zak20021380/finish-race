/**
 * arena.ts — the Arena Progression Road.
 *
 * Arena 1 is the live, playable crucible. Arenas 2–4 are staged as prestige
 * milestones: their TIQ gates are real, but their doors stay sealed until the
 * content ships, so every one of them carries the same COMING SOON stamp.
 *
 * The road is painted from ARENA_TIERS. A single repaint covers the tier cards,
 * the live TIQ pill and the progress module toward the next gate; it runs on
 * route entry, on a save that moved TIQ, and on a language switch.
 */
import { myTiq } from './matchmaking';
import { lang, onLang, t } from './settings';
import { onChange } from './storage';
import { impact } from './telegram';

export interface ArenaRoadApi {
  /** The current playable match flow: queue → matchmaking → race. */
  battle(): void;
}

export interface ArenaRoad {
  setRoute(id: string): void;
}

interface ArenaTier {
  id: string;
  rank: number;
  /** TIQ needed to qualify. Arena 1 is always open. */
  reqTiq: number;
  active: boolean;
  accent: string;
  accentAlt: string;
  soft: string;
  line: string;
  icon: string;
  nameKey: string;
  subKey: string;
  perkKeys: readonly [string, string];
}

export const ARENA_TIERS: readonly ArenaTier[] = [
  {
    id: 'obsidian',
    rank: 1,
    reqTiq: 0,
    active: true,
    accent: '#22D3EE',
    accentAlt: '#0EA5E9',
    soft: 'rgba(34, 211, 238, .14)',
    line: 'rgba(34, 211, 238, .42)',
    icon: '#i-swords',
    nameKey: 'arena1Name',
    subKey: 'arena1Sub',
    perkKeys: ['arena1Perk1', 'arena1Perk2'],
  },
  {
    id: 'molten',
    rank: 2,
    reqTiq: 1200,
    active: false,
    accent: '#F59E0B',
    accentAlt: '#B45309',
    soft: 'rgba(245, 158, 11, .14)',
    line: 'rgba(245, 158, 11, .4)',
    icon: '#i-flame',
    nameKey: 'arena2Name',
    subKey: 'arena2Sub',
    perkKeys: ['arena2Perk1', 'arena2Perk2'],
  },
  {
    id: 'citadel',
    rank: 3,
    reqTiq: 2800,
    active: false,
    accent: '#EAB308',
    accentAlt: '#CBD5E1',
    soft: 'rgba(234, 179, 8, .13)',
    line: 'rgba(234, 179, 8, .38)',
    icon: '#i-shield',
    nameKey: 'arena3Name',
    subKey: 'arena3Sub',
    perkKeys: ['arena3Perk1', 'arena3Perk2'],
  },
  {
    id: 'summit',
    rank: 4,
    reqTiq: 5000,
    active: false,
    accent: '#A855F7',
    accentAlt: '#22D3EE',
    soft: 'rgba(168, 85, 247, .15)',
    line: 'rgba(168, 85, 247, .42)',
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

/** The first arena still above the player's TIQ; past the summit, the summit itself. */
const gateFor = (tiq: number): ArenaTier =>
  ARENA_TIERS.find((tier) => !tier.active && tier.reqTiq > tiq) ?? ARENA_TIERS[ARENA_TIERS.length - 1];

export function createArenaRoad(api: ArenaRoadApi): ArenaRoad {
  const root = $('arena-road');
  if (!root) return { setRoute() { /* the Arena shell is not mounted */ } };

  const screen = document.getElementById('s-arena');
  const isVisible = (): boolean => !!screen && !screen.hidden;

  let lastTiq = -1;

  function cardMarkup(tier: ArenaTier, tiq: number): string {
    const name = t(tier.nameKey);
    const sub = t(tier.subKey);
    const reached = tier.active || tiq >= tier.reqTiq;
    const requirement = tier.active
      ? `<span class="arena-req is-open"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-check" /></svg>${t('arenaOpenNow')}</span>`
      : `<span class="arena-req${reached ? ' is-qualified' : ''}" data-req>
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${reached ? 'check' : 'lock'}" /></svg>
          ${reached ? t('arenaTiqReached') : fill('arenaRequires', { n: num(tier.reqTiq) })}
        </span>`;

    const perks = tier.perkKeys
      .map((key) => `<li class="arena-perk"><i class="arena-perk-dot" aria-hidden="true"></i>${t(key)}</li>`)
      .join('');

    const footer = tier.active
      ? `<button class="arena-battle" type="button" data-battle aria-label="${fill('arenaBattleAria', { name })}">
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-swords" /></svg>
          <span>${t('arenaEnterBattle')}</span>
        </button>`
      : '';

    const status = tier.active
      ? `<span class="arena-status"><i class="arena-status-dot" aria-hidden="true"></i>${t('arenaActive')}</span>`
      : '';

    const label = tier.active
      ? fill('arenaActiveAria', { name, n: num(tiq) })
      : fill('arenaLockedAria', { name, n: num(tier.reqTiq) });

    return `<article class="arena-tier" role="listitem" data-tier="${tier.id}"
        data-state="${tier.active ? 'active' : 'coming'}" data-reached="${reached}"
        style="--tier-a:${tier.accent};--tier-a2:${tier.accentAlt};--tier-soft:${tier.soft};--tier-line:${tier.line}"
        aria-label="${label}">
      <div class="arena-tier-rail" aria-hidden="true">
        <span class="arena-tier-node">${localizeDigits(String(tier.rank).padStart(2, '0'))}</span>
      </div>
      <div class="arena-tier-card">
        <svg class="arena-tier-glyph" viewBox="0 0 24 24" aria-hidden="true"><use href="${tier.icon}" /></svg>
        ${tier.active ? '' : '<svg class="arena-lock-mark" viewBox="0 0 52 60" aria-hidden="true"><use href="#i-lock-ti" /></svg>'}
        ${tier.active ? '' : `<span class="arena-ribbon" aria-hidden="true">${t('arenaComingSoon')}</span>`}
        <div class="arena-tier-top">
          <span class="arena-tier-kicker">${fill('arenaTierKicker', { n: num(tier.rank) })}</span>
          ${status}
        </div>
        <h2 class="arena-tier-name">${name}</h2>
        <p class="arena-tier-sub">${sub}</p>
        ${requirement}
        <ul class="arena-perks" aria-label="${t('arenaPerks')}">${perks}</ul>
        ${footer}
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

  /* One delegated key: repaints never leave a dead CTA behind. */
  root.addEventListener('click', (e) => {
    const cell = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('[data-battle]') : null;
    if (!cell || cell.disabled) return;
    impact('medium');
    api.battle();
  });

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
      if (id === 'arena') paint(myTiq(), true);
    },
  };
}
