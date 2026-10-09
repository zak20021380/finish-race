/**
 * compete.ts — Tournaments / Countries / Players / Teams behind the preview API.
 *
 * Skeletons while loading, empty states when there is nothing to rank, and the
 * user's own row pinned at the bottom of every ranked list. Tournament Join
 * opens a confirm sheet that deducts the entry fee from the local wallet.
 */
import {
  formatCountdown,
  getCountryRanking,
  getPlayerRanking,
  getTeamRanking,
  getTournaments,
  trendArrow,
  type CountryRow,
  type PlayerRow,
  type TeamRow,
  type Tournament,
} from './data';
import { flagOf, nameOf } from './countries';
import { coinText, mountCoins, setBalance } from './coin';
import { myTeam, onChange, profile, spendCoins } from './storage';
import { impact, notify, tgUser } from './telegram';
import type { Router } from './router';
import type { Sheets } from './sheets';

export interface CompeteApi {
  router: Router;
  sheets: Sheets;
  sheet(id: string): HTMLElement | null;
}

type Tab = 'tournaments' | 'countries' | 'players' | 'teams';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const JOINED_KEY = 'detour.tourneys.v1';

function joinedSet(): Set<string> {
  try {
    const raw = window.localStorage.getItem(JOINED_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set<string>();
  }
}

function saveJoined(s: Set<string>): void {
  try {
    window.localStorage.setItem(JOINED_KEY, JSON.stringify([...s]));
  } catch {
    /* in-memory only */
  }
}

const skel = (rows: number): string =>
  Array.from({ length: rows }, () => '<div class="skel-row"><span class="skel w20"></span><span class="skel w60"></span><span class="skel w15"></span></div>').join('');

const empty = (msg: string): string => `<div class="empty" role="status">${msg}</div>`;

export function createCompete(api: CompeteApi): { setRoute(id: string): void } {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-comp]')];
  const panes: Record<Tab, HTMLElement> = {
    tournaments: $('comp-tournaments'),
    countries: $('comp-countries'),
    players: $('comp-players'),
    teams: $('comp-teams'),
  };
  let tab: Tab = 'tournaments';
  let loaded: Partial<Record<Tab, boolean>> = {};
  let tournaments: Tournament[] = [];
  let joined = joinedSet();
  let pending: Tournament | null = null;
  let tick = 0;

  const youName = (): string => {
    const u = tgUser();
    const full = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
    return (full || u?.username || 'You').slice(0, 18);
  };

  /* ---------- tabs ---------- */

  function select(next: Tab): void {
    if (next === tab && loaded[next]) return;
    tab = next;
    for (const b of tabs) b.setAttribute('aria-selected', String(b.dataset.comp === next));
    for (const k of Object.keys(panes) as Tab[]) panes[k].hidden = k !== next;
    impact('light');
    void load(next);
  }

  for (const b of tabs) {
    b.addEventListener('click', () => {
      const v = b.dataset.comp as Tab;
      if (v === 'tournaments' || v === 'countries' || v === 'players' || v === 'teams') select(v);
    });
  }

  async function load(which: Tab): Promise<void> {
    if (which === 'tournaments') await loadTournaments();
    else if (which === 'countries') await loadCountries();
    else if (which === 'players') await loadPlayers();
    else await loadTeams();
    loaded[which] = true;
  }

  /* ---------- tournaments ---------- */

  async function loadTournaments(): Promise<void> {
    const el = panes.tournaments;
    if (!loaded.tournaments) el.innerHTML = skel(3);
    try {
      tournaments = await getTournaments();
    } catch {
      el.innerHTML = empty('Tournaments unavailable. Check your connection and try again.');
      return;
    }
    if (!tournaments.length) {
      el.innerHTML = empty('No tournaments right now. Check back soon.');
      return;
    }
    el.textContent = '';
    for (const t of tournaments) {
      const card = document.createElement('article');
      card.className = 'tourney-card';
      card.dataset.id = t.id;

      const top = document.createElement('div');
      top.className = 'tourney-top';
      const name = document.createElement('h3');
      name.className = 'tourney-name';
      name.textContent = t.name;
      const badge = document.createElement('span');
      badge.className = `pill ${t.status}`;
      badge.textContent = t.status === 'live' ? 'Live' : t.status === 'upcoming' ? 'Upcoming' : 'Ended';
      top.append(name, badge);

      const meta = document.createElement('div');
      meta.className = 'tourney-meta';
      const prize = document.createElement('span');
      prize.className = 'car-prize';
      const coin = document.createElement('span');
      coin.className = 'coin';
      coin.setAttribute('data-coin', '');
      coin.setAttribute('aria-hidden', 'true');
      const pv = document.createElement('b');
      pv.textContent = coinText(t.prizePool);
      prize.append(coin, pv);
      const fee = document.createElement('span');
      fee.className = 'car-fee';
      fee.textContent = t.entryFee ? `${coinText(t.entryFee)} entry` : 'Free entry';
      const count = document.createElement('span');
      count.className = 'car-count';
      count.dataset.count = t.id;
      count.textContent = t.status === 'ended' ? 'Ended' : formatCountdown(t.endsAt);
      meta.append(prize, fee, count);

      const foot = document.createElement('div');
      foot.className = 'tourney-foot';
      const players = document.createElement('span');
      players.className = 'car-players';
      players.textContent = `${t.players}/${t.maxPlayers} players`;
      const join = document.createElement('button');
      join.className = 'btn btn-primary sm';
      join.type = 'button';
      const isJoined = joined.has(t.id);
      join.disabled = t.status === 'ended' || isJoined;
      join.textContent = isJoined ? 'Joined' : t.status === 'ended' ? 'Ended' : 'Join';
      join.setAttribute('aria-label', `${join.textContent}: ${t.name}`);
      join.addEventListener('click', () => askJoin(t));
      foot.append(players, join);

      card.append(top, meta, foot);
      el.append(card);
    }
    mountCoins(el);
    startTick();
  }

  function askJoin(t: Tournament): void {
    if (t.status === 'ended' || joined.has(t.id)) return;
    pending = t;
    ($('tourney-desc') as HTMLElement).textContent = `${t.name} · ${t.players}/${t.maxPlayers} players · ${formatCountdown(t.endsAt)} left`;
    ($('tourney-fee') as HTMLElement).textContent = coinText(t.entryFee);
    setBalance($('tourney-have') as HTMLElement, profile.coins);
    ($('tourney-after') as HTMLElement).textContent = coinText(Math.max(0, profile.coins - t.entryFee));
    const err = $('tourney-err');
    err.hidden = true;
    const yes = $('tourney-yes') as HTMLButtonElement;
    yes.textContent = t.entryFee ? `Join for ${coinText(t.entryFee)}` : 'Join free';
    yes.disabled = profile.coins < t.entryFee;
    if (profile.coins < t.entryFee) {
      err.hidden = false;
      err.textContent = `Not enough coins — ${coinText(t.entryFee - profile.coins)} short. Win a race to top up.`;
    }
    const sheet = api.sheet('sheet-tourney');
    if (sheet) {
      impact('light');
      api.sheets.open(sheet);
    }
  }

  ($('tourney-yes') as HTMLButtonElement).addEventListener('click', () => {
    if (!pending) return;
    const t = pending;
    pending = null;
    if (joined.has(t.id)) {
      api.sheets.close();
      return;
    }
    if (!spendCoins(t.entryFee)) {
      notify('warning');
      ($('tourney-err') as HTMLElement).hidden = false;
      ($('tourney-err') as HTMLElement).textContent = 'Not enough coins for that entry.';
      return;
    }
    joined.add(t.id);
    saveJoined(joined);
    notify('success');
    impact('medium');
    api.sheets.close();
    void loadTournaments();
  });

  function startTick(): void {
    if (tick) return;
    tick = window.setInterval(() => {
      if ($('s-compete').hidden) return;
      for (const t of tournaments) {
        const el = panes.tournaments.querySelector<HTMLElement>(`[data-count=${JSON.stringify(t.id)}]`);
        if (el && t.status !== 'ended') el.textContent = formatCountdown(t.endsAt);
      }
    }, 1000);
  }

  /* ---------- ranked lists ---------- */

  function row(rank: number, flag: string, name: string, sub: string | null, points: string, trend: string, me: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `rank-row${me ? ' me' : ''}`;
    const rk = document.createElement('span');
    rk.className = 'rk';
    rk.textContent = String(rank);
    const fl = document.createElement('span');
    fl.className = 'fl';
    fl.textContent = flag;
    fl.setAttribute('aria-hidden', 'true');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = name;
    if (sub) {
      const s = document.createElement('small');
      s.textContent = sub;
      nm.append(s);
    }
    const pt = document.createElement('span');
    pt.className = 'pt';
    pt.textContent = points;
    const tr = document.createElement('span');
    tr.className = `tr ${trend}`;
    tr.textContent = trendArrow(trend as 'up' | 'down' | 'same');
    li.append(rk, fl, nm, pt, tr);
    return li;
  }

  function pinned(el: HTMLElement, node: HTMLElement): void {
    const wrap = document.createElement('div');
    wrap.className = 'rank-pinned';
    wrap.append(node);
    el.append(wrap);
  }

  async function loadCountries(): Promise<void> {
    const el = panes.countries;
    if (!loaded.countries) el.innerHTML = skel(6);
    let rows: CountryRow[];
    try {
      rows = await getCountryRanking();
    } catch {
      el.innerHTML = empty('Rankings unavailable. Check your connection and try again.');
      return;
    }
    if (!rows.length) {
      el.innerHTML = empty('No countries ranked yet.');
      return;
    }
    el.textContent = '';
    const ol = document.createElement('ol');
    ol.className = 'rank-list';
    for (const c of rows) {
      ol.append(row(c.rank, flagOf(c.code), `${c.name}`, null, c.points.toLocaleString('en-US'), c.trend, profile.country === c.code));
    }
    el.append(ol);
    const mine = profile.country;
    if (mine) {
      const hit = rows.find((c) => c.code === mine);
      const meRow = document.createElement('div');
      meRow.className = 'rank-row me';
      meRow.innerHTML = '';
      const rk = document.createElement('span');
      rk.className = 'rk';
      rk.textContent = hit ? String(hit.rank) : '—';
      const fl = document.createElement('span');
      fl.className = 'fl';
      fl.textContent = flagOf(mine);
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = `You · ${nameOf(mine)}`;
      const pt = document.createElement('span');
      pt.className = 'pt';
      pt.textContent = hit ? hit.points.toLocaleString('en-US') : '0';
      meRow.append(rk, fl, nm, pt);
      pinned(el, meRow);
    } else {
      const hint = document.createElement('button');
      hint.className = 'rank-row rank-pinned hint';
      hint.type = 'button';
      hint.textContent = 'Pick your country in Profile to appear here.';
      hint.setAttribute('aria-label', 'Pick your country in Profile');
      hint.addEventListener('click', () => { impact('light'); api.router.go('profile'); });
      el.append(hint);
    }
  }

  async function loadPlayers(): Promise<void> {
    const el = panes.players;
    if (!loaded.players) el.innerHTML = skel(6);
    let rows: PlayerRow[];
    try {
      rows = await getPlayerRanking();
    } catch {
      el.innerHTML = empty('Rankings unavailable. Check your connection and try again.');
      return;
    }
    if (!rows.length) {
      el.innerHTML = empty('No players ranked yet.');
      return;
    }
    el.textContent = '';
    const ol = document.createElement('ol');
    ol.className = 'rank-list';
    rows.forEach((p, i) => {
      ol.append(row(i + 1, flagOf(p.countryCode), p.name, `${p.wins} wins`, p.points.toLocaleString('en-US'), p.trend, false));
    });
    el.append(ol);
    const meRow = document.createElement('div');
    meRow.className = 'rank-row me';
    const rk = document.createElement('span');
    rk.className = 'rk';
    rk.textContent = '—';
    const fl = document.createElement('span');
    fl.className = 'fl';
    fl.textContent = profile.country ? flagOf(profile.country) : '•';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = `You · ${youName()}`;
    const sub = document.createElement('small');
    sub.textContent = `${profile.stats.wins} wins · ${profile.stats.games} games`;
    nm.append(sub);
    const pt = document.createElement('span');
    pt.className = 'pt';
    pt.textContent = (profile.stats.wins * 120 + profile.stats.games * 20).toLocaleString('en-US');
    meRow.append(rk, fl, nm, pt);
    pinned(el, meRow);
  }

  async function loadTeams(): Promise<void> {
    const el = panes.teams;
    if (!loaded.teams) el.innerHTML = skel(5);
    let rows: TeamRow[];
    try {
      rows = await getTeamRanking();
    } catch {
      el.innerHTML = empty('Rankings unavailable. Check your connection and try again.');
      return;
    }
    if (!rows.length) {
      el.innerHTML = empty('No teams ranked yet.');
      return;
    }
    el.textContent = '';
    const ol = document.createElement('ol');
    ol.className = 'rank-list';
    const mine = myTeam();
    for (const t of rows) {
      ol.append(row(t.rank, '🛡', t.name, `${t.code} · ${t.members} members`, t.points.toLocaleString('en-US'), t.trend, mine?.id === t.id || mine?.code === t.code));
    }
    el.append(ol);
    if (mine) {
      const hit = rows.find((r) => r.id === mine.id || r.code === mine.code);
      const meRow = document.createElement('div');
      meRow.className = 'rank-row me';
      const rk = document.createElement('span');
      rk.className = 'rk';
      rk.textContent = hit ? String(hit.rank) : '—';
      const fl = document.createElement('span');
      fl.className = 'fl';
      fl.textContent = '🛡';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = `You · ${mine.name}`;
      const pt = document.createElement('span');
      pt.className = 'pt';
      pt.textContent = hit ? hit.points.toLocaleString('en-US') : '0';
      meRow.append(rk, fl, nm, pt);
      pinned(el, meRow);
    } else {
      const hint = document.createElement('button');
      hint.className = 'rank-row rank-pinned hint';
      hint.type = 'button';
      hint.textContent = 'Find a team on Home to appear here.';
      hint.setAttribute('aria-label', 'Find a team on Home');
      hint.addEventListener('click', () => { impact('light'); api.router.go('home'); });
      el.append(hint);
    }
  }

  onChange(() => {
    loaded.countries = false;
    loaded.players = false;
    loaded.teams = false;
    if (tab !== 'tournaments') void load(tab);
  });

  return {
    setRoute(id: string) {
      if (id === 'compete') {
        for (const k of Object.keys(panes) as Tab[]) panes[k].hidden = k !== tab;
        void load(tab);
      }
    },
  };
}
