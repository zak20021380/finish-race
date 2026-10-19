/**
 * countrypick.ts — the one country picker sheet, shared by Profile and the
 * Nations IQ HUD. Both doors open the same in-place bottom sheet, so a nation
 * can be set or switched without a route change or a second UI to keep in sync.
 */
import { flagOf, guessCountry, search } from './countries';
import { claimIdentityReward, profile, setCountry } from './storage';
import { impact, languageCode, notify } from './telegram';
import type { Sheets } from './sheets';

const PICK_ROW = '<span class="flag" aria-hidden="true"></span><span class="flag-code" aria-hidden="true"></span>'
  + '<span class="pick-n"></span>'
  + '<svg class="ico tick" aria-hidden="true"><use href="#i-check" /></svg>';

export type CountryPicked = (code: string, paid: number) => void;

interface Picker {
  open(): void;
  onPick: CountryPicked | null;
}

const makeRow = (): HTMLLIElement => {
  const li = document.createElement('li');
  li.className = 'pick-row';
  li.innerHTML = PICK_ROW;
  return li;
};

function build(sheets: Sheets): Picker {
  const state: Picker = { onPick: null, open: () => {} };
  const sheet = document.getElementById('sheet-country');
  const list = document.getElementById('country-list');
  const empty = document.getElementById('country-empty');
  const query = document.getElementById('country-q') as HTMLInputElement | null;
  if (!sheet || !list || !empty || !query) return state;
  const sheetEl = sheet;
  const listEl = list;
  const emptyEl = empty;
  const queryEl = query;

  let pickIdx = 0;

  function paint(q: string): void {
    const hits = search(q);
    listEl.textContent = '';
    for (const c of hits) {
      const li = makeRow();
      li.dataset.code = c.code;
      li.setAttribute('role', 'option');
      li.tabIndex = -1;
      li.setAttribute('aria-selected', String(c.code === profile.country));
      const kids = li.children;
      kids[0].textContent = flagOf(c.code);
      kids[1].textContent = c.code;
      kids[2].textContent = c.name;
      listEl.append(li);
    }
    emptyEl.hidden = hits.length > 0;
    pickIdx = Math.max(0, hits.findIndex((c) => c.code === (profile.country ?? guessCountry(languageCode()))));
  }

  function focusPick(move: number): void {
    const items = [...listEl.querySelectorAll<HTMLElement>('.pick-row')];
    if (!items.length) return;
    pickIdx = Math.min(items.length - 1, Math.max(0, pickIdx + move));
    items[pickIdx].focus({ preventScroll: true });
    items[pickIdx].scrollIntoView({ block: 'nearest' });
  }

  function choose(code: string): void {
    setCountry(code);
    const paid = claimIdentityReward('country');
    notify('success');
    sheets.close();
    state.onPick?.(code, paid);
  }

  queryEl.addEventListener('input', () => paint(queryEl.value));
  queryEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const f = listEl.querySelector<HTMLElement>('.pick-row');
      if (f?.dataset.code) choose(f.dataset.code);
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); focusPick(1); }
  });
  listEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusPick(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusPick(-1); }
    else if (e.key === 'Enter') {
      const r = document.activeElement as HTMLElement | null;
      const code = r?.dataset.code;
      if (code) choose(code);
    }
  });
  listEl.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.pick-row');
    if (!row?.dataset.code) return;
    impact('light');
    choose(row.dataset.code);
  });

  state.open = () => {
    const seed = profile.country || guessCountry(languageCode());
    queryEl.value = '';
    paint('');
    sheets.open(sheetEl);
    /* land the list on the current pick (or the language's suggestion), so the
       common case is one tap */
    const want = seed ? listEl.querySelector<HTMLElement>(`[data-code=${JSON.stringify(seed)}]`) : null;
    if (want) {
      want.scrollIntoView({ block: 'center' });
      want.focus({ preventScroll: true });
    }
    impact('light');
  };

  return state;
}

let picker: Picker | null = null;

/** Open the shared picker. `onPick` lets the caller celebrate a first claim. */
export function openCountryPicker(sheets: Sheets, onPick?: CountryPicked): void {
  if (!picker) picker = build(sheets);
  if (onPick) picker.onPick = onPick;
  picker.open();
}
