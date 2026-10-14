# Project memory — finish-race (Detour Mini App)

## Build / verify
- `npm run build` = `tsc --noEmit` + `tsc -p worker/tsconfig.json` + `vite build`.
- **esbuild is blocked on this machine.** `node_modules/@esbuild/win32-x64/esbuild.exe` cannot
  execute at all (`esbuild.exe --version` exits 1, silent), so `vite build` fails with
  "The service was stopped", and `scripts/verify-worker-matchmaking.mjs` /
  `verify-worker-race.mjs` (both `import { build } from 'esbuild'`) fail the same way. Those
  failures are environmental — check them against a pristine tree before blaming a change.
- **Workaround harness: `.tmp/shop-preview.mjs`** — bundles the real `src/` with rollup +
  `ts.transpileModule` (no esbuild), inlines `style.css` and the bundle into a copy of
  `index.html`, serves it on 127.0.0.1, and drives headless Chrome over CDP at 360x640. Two gotchas
  it already handles: strip the remote `telegram-web-app.js` script (a no-egress box stalls the
  parser on it) and shim `import.meta.env = {}` (vite substitutes it at build time; the raw bundle
  otherwise throws on `import.meta.env.VITE_WS_URL` in `matchmaking.ts`).
- `.tmp/smoke-game.mjs` walks Home -> `#home-play` -> `[data-gmode="bot"]` -> `#gm-start` to smoke
  the board screen.
- `.shots/` holds the CDP screenshot scripts and PNGs; `.tmp/` is scratch. Both gitignored.

## Design system (src/style.css)
- One theme, "Dark Clay": opaque slabs, no live blur. `--glass-blur: none` and
  `--glass-bg: var(--clay-face)`, but new work should drop `backdrop-filter` outright.
- Recipes: `--clay` (drop + top spec + bottom bevel) with `--clay-ring` for raised panels;
  `--inset` for recessed wells; `--lip`/`--press-y` for extruded controls.
- `.cos` (shop cards) is listed in the shared panel recipe; keep it on `--clay-face`.
- Shop modules: `src/shop.ts` (tabs/cards/buy flow), `src/themes.ts` (`ITEMS`), `src/coin.ts`,
  `src/storage.ts` (`buy`/`equip`/`owns`).
- Toast system: `.note` elements. `#note` lives inside the game screen; the shop has its own.
  `showNote()` in `main.ts` writes to the note host of the *visible* screen only.

## Conventions
- Strict TS, `noImplicitReturns`, no unused imports. Prefer `aria-disabled` over the `disabled`
  attribute when a control must still receive the tap that explains why it is inert.
- Never commit `.shots/` or `.tmp/`; the repo keeps them as scratch by convention.
