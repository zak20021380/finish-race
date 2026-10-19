/**
 * countrypick.ts — the one country picker sheet, shared by Profile and the
 * Nations IQ HUD. Both doors open the same in-place bottom sheet, so a nation
 * can be set or switched without a route change or a second UI to keep in sync.
 *
 * The sheet renders the standardized registry in full (250 nations and
 * territories). Rows are built once with a circular CDN flag; typing filters them
 * in place by hiding rows instead of rebuilding the list, so the scroll stays at
 * 60fps and every nation remains one keystroke away.
 */
import { COUNTRIES, guessCountry, knownCountry, search } from './countries';
import { claimIdentityReward, profile, setCountry } from './storage';
import { flagPhoto } from './flags';
import { impact, languageCode, notify } from './telegram';
import type { Sheets } from './sheets';

export type CountryPicked = (code: string, paid: number) => void;

interface Picker {
  open(): void;
  onPick: CountryPicked | null;
}

const tickSvg = (): SVGSVGElement => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ico tick');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<use href="#i-check" />';
  return svg;
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

  const rows = new Map<string, HTMLLIElement>();
  let built = false;
  let pickIdx = 0;
  /* visual order: the ranked search result, independent of the alphabetical DOM */
  let shown: string[] = COUNTRIES.map((c) => c.code);

  /** Build the complete registry once; filtering never touches this DOM again. */
  function ensureRows(): void {
    if (built) return;
    built = true;
    const frag = document.createDocumentFragment();
    for (const c of COUNTRIES) {
      const li = document.createElement('li');
      li.className = 'pick-row country-row';
      li.dataset.code = c.code;
      li.setAttribute('role', 'option');
      li.tabIndex = -1;
      li.setAttribute('aria-label', `${c.name}, ${c.code}`);

      const nm = document.createElement('span');
      nm.className = 'pick-n';
      nm.textContent = c.name;

      const code = document.createElement('span');
      code.className = 'country-code';
      code.textContent = c.code;
      code.setAttribute('aria-hidden', 'true');

      li.append(flagPhoto(c.code, 'fp-country'), nm, code, tickSvg());
      rows.set(c.code, li);
      frag.append(li);
    }
    listEl.append(frag);
  }

  function visibleRows(): HTMLElement[] {
    return shown
      .map((code) => rows.get(code))
      .filter((r): r is HTMLLIElement => !!r && !r.hidden);
  }

  function selectedCode(): string {
    return profile.country || guessCountry(languageCode());
  }

  function paint(q: string): void {
    ensureRows();
    const hits = search(q);
    const order = new Map(hits.map((c, i) => [c.code, i]));
    const me = profile.country;
    for (const [code, row] of rows) {
      row.hidden = !order.has(code);
      row.style.order = String(order.get(code) ?? 0);
      row.setAttribute('aria-selected', String(code === me));
    }
    shown = hits.map((c) => c.code);
    emptyEl.hidden = hits.length > 0;
    const visible = visibleRows();
    const wanted = selectedCode();
    pickIdx = Math.max(0, visible.findIndex((r) => r.dataset.code === wanted));
  }

  function focusPick(move: number): void {
    const items = visibleRows();
    if (!items.length) return;
    pickIdx = Math.min(items.length - 1, Math.max(0, pickIdx + move));
    items[pickIdx].focus({ preventScroll: true });
    items[pickIdx].scrollIntoView({ block: 'nearest' });
  }

  function focusFirst(): void {
    const items = visibleRows();
    if (!items.length) return;
    pickIdx = 0;
    items[0].focus({ preventScroll: true });
    items[0].scrollIntoView({ block: 'nearest' });
  }

  function choose(code: string): void {
    if (!knownCountry(code)) return;
    setCountry(code);
    const paid = claimIdentityReward('country');
    notify('success');
    sheets.close();
    state.onPick?.(code, paid);
  }

  queryEl.addEventListener('input', () => {
    paint(queryEl.value);
    listEl.scrollTop = 0;
    pickIdx = 0;
  });
  queryEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const f = visibleRows()[0];
      if (f?.dataset.code) choose(f.dataset.code);
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); focusFirst(); }
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
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.country-row');
    if (!row?.dataset.code) return;
    impact('light');
    choose(row.dataset.code);
  });

  state.open = () => {
    ensureRows();
    queryEl.value = '';
    paint('');
    sheets.open(sheetEl);
    /* land the list on the current pick (or the language's suggestion), so the
       common case is one tap */
    const want = selectedCode();
    const row = rows.get(want);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.focus({ preventScroll: true });
      pickIdx = Math.max(0, visibleRows().indexOf(row));
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
