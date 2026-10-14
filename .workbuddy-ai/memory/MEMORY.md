# Project memory — finish-race (Detour Mini App)

## Build / verify
- `npm run build` = `tsc --noEmit` + `tsc -p worker/tsconfig.json` + `vite build`.
- **esbuild is blocked on this machine.** `node_modules/@esbuild/win32-x64/esbuild.exe` cannot
  execute at all (`esbuild.exe --version` exits 1, silent), so `vite build` fails with
  "The service was stopped", and `scripts/verify-worker-matchmaking.mjs` /
  `verify-worker-race.mjs` (both `import { build } from 'esbuild'`) fail the same way. Those
  failures are environmental — check them against a pristine tree before blaming a change.
- **esbuild shim (run the worker verifiers anyway):** `.tmp/esbuild-shim.mjs` implements esbuild's
  `build({ entryPoints, outfile, ... })` with rollup + `ts.transpileModule`; `.tmp/esbuild-hook.mjs`
  is a resolve hook that rewrites the bare specifier `esbuild` to it; `.tmp/esbuild-redirect.mjs`
  registers the hook. Then:
  `node --import ./.tmp/esbuild-redirect.mjs scripts/verify-worker-matchmaking.mjs` → 35/35, and
  the same for `verify-worker-race.mjs` → 29/29. Prefer this over re-implementing their assertions.
- **Workaround harness: `.tmp/shop-preview.mjs`** (and `.tmp/admin-check.mjs`, same skeleton) —
  bundles the real `src/` with rollup + `ts.transpileModule` (no esbuild), inlines `style.css` and
  the bundle into a copy of `index.html`, serves it on 127.0.0.1, and drives headless Chrome over
  CDP at 360x640. Two gotchas it already handles: strip the remote `telegram-web-app.js` script (a
  no-egress box stalls the parser on it) and shim `import.meta.env = {}` (vite substitutes it at
  build time; the raw bundle otherwise throws on `import.meta.env.VITE_WS_URL` in `matchmaking.ts`).
- `.tmp/smoke-game.mjs` walks Home -> `#home-play` -> `[data-gmode="bot"]` -> `#gm-start` to smoke
  the board screen. Note `#home-play` starts a *bot race* directly; the matchmaking stage is only
  reachable via `#mode-hero` -> `[data-gmode="duel_1v1"]` -> `#gm-start`.
- `.shots/` holds the CDP screenshot scripts and PNGs; `.tmp/` is scratch. Both gitignored.
- Editing gotcha: never batch parallel `Edit` calls at the same file — the writes race and silently
  clobber each other. Apply them one at a time and re-grep afterwards.

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

## Admin Command Center (src/admin.ts)
- `runtime` is the single live config every module reads: `salesOpen, hazards, maintenance,
  broadcast, winTiq, coinMult, blitz, radiusNormal, radiusWide, tierOverride`. Persisted at
  `detour.admin.v1`. `setRuntime(patch)` is the only writer (persist + notify `onRuntime` watchers);
  `resetRuntime()` restores `DEFAULT_RUNTIME`.
- Add a new live switch: field on `AdminRuntime` + `DEFAULT_RUNTIME` + `loadRuntime()`, a control in
  `index.html`, then read `runtime.<field>` at the point of use. Do **not** snapshot it into a const.
- `#btn-admin-fab` is a child of `#s-home` (so it only shows on Home) and its `bottom` is measured in
  JS by `placeFab()` so it clears `.launcher`; `relayout()` is called when the router lands on home.
- `queueMatch()` in `main.ts` is the only caller of `matchmaking.open()` — that is where Maintenance
  Lock gates. `onBack()` closes the admin stage before anything else.
- The ladder formula is `tiqFrom(wins, games, bonus)` in `admin.ts`; `RACE_TIQ = 20` is the per-race
  credit folded into `winTiq`, which is why the 140 default equals the original 120/win + 20/race.
- `Save.tiqBonus` + `earnTiq()` in `storage.ts` are how a TIQ grant persists (TIQ itself is derived).

## Conventions
- Strict TS, `noImplicitReturns`, no unused imports. Prefer `aria-disabled` over the `disabled`
  attribute when a control must still receive the tap that explains why it is inert.
- Never commit `.shots/` or `.tmp/`; the repo keeps them as scratch by convention.
