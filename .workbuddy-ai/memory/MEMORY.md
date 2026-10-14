# Project memory — finish-race (Detour Mini App)

Detailed history lives in the dated logs beside this file. This is the durable index.

## Build / verify
- `npm run build` = `tsc --noEmit` + `tsc -p worker/tsconfig.json` + `vite build`.
- **esbuild is blocked on this machine** (`@esbuild/win32-x64/esbuild.exe` exits 1 silently), so
  `vite build` and any verifier importing esbuild fail with "The service was stopped". Environmental.
- Worker verifiers need the shim: `node --import ./.tmp/esbuild-redirect.mjs scripts/verify-worker-<n>.mjs`
  → matchmaking 35/35, race 52/52, admin 69/69.
- No-toolchain suites: `node --experimental-strip-types scripts/{mines,walls}-check.mjs` → 49/49, 14/14.
  They copy `src/*.ts` into `.shots/*-under-test.ts` with relative specifiers rewritten.
- Browser checks: `.tmp/*-check.mjs` bundle real `src/` with rollup + `ts.transpileModule`, inline
  `style.css` + bundle into a copy of `index.html`, serve on 127.0.0.1, drive headless Chrome over raw
  CDP at 360x640. Must strip the remote `telegram-web-app.js`, shim `import.meta.env = {}`, dispatch
  synthetic `PointerEvent`s. `.tmp/board-size-check.mjs` = grid choice (12/12);
  **`.tmp/board-scale-check.mjs` = fit + palettes + magnet + dock across 360x640 / 390x844 / 430x932
  for 2P/3P/4P (86/86)**. `.tmp/probe-bbox.mjs` / `.tmp/probe-party.mjs` are one-off probes that
  reuse the bundle the harness already wrote (no bundling of their own).
- **Pixel probes:** replicate `computeLayout` exactly — `LAYOUT_PAD = 2`, so `raw = min((w-4)/cols,
  (h-4)/rows)`, `cell = max(1, floor(raw*dpr)/dpr)`, then a **second pass** with
  `pad = max(2, min(6, cell*0.06))`. Probe board-space points, not pixels. A **slab-width** probe
  cannot tell 8x12 from 10x12 apart (the board scales to fit).
- **Calibrate off the fully-opaque bounding box, never a colour feature.** `getImageData` once, keep
  pixels with `alpha >= 250`: the slab is the only opaque thing (shadows are blurred translucent
  colours, every glow/ring/streak is blended), so its bbox *is* `ox, oy, cols*cell x rows*cell`.
  Deriving `ox` from the finish strip's leftmost white pixel fails — the checkers alternate and the
  strip starts **green**, so that pixel is the second checker (half a cell out).
- **Find a ball by saturation-weighted centroid, not per-column counts.** The seat to move wears a
  halo at radius 0.78 cell vs the ball's 0.34, so window votes report one ball as three columns. A
  radial halo is centred on its ball, so the centroid is right either way.
- **Viewport px ≠ canvas-local px.** `getBoundingClientRect()` vs `getImageData` offsets differ by the
  canvas's own `top`. Subtract it before comparing.
- **Layout budget at 360x640:** `.admin-body` is 504px and the harness fails on any element whose
  `bottom > innerHeight`, including children scrolled out of the body.
- `.shots/` = CDP scripts + PNGs; `.tmp/` = scratch. Both gitignored.
- **Never batch parallel `Edit` calls at one file** — the writes race and clobber.

## Board sizing — 2 to 4 contenders (src/rules.ts)
- `GameState.cols` / `.rows` are the only source of truth. `COLS`=8/`ROWS`=12 are the duel defaults
  and the arg defaults on board-shape helpers; `WIDE_COLS`=10/`WIDE_ROWS`=12.
  `dimsFor(contenders)` → 8x12 for ≤2, 10x12 for ≥3.
- **Contenders = total balls, not seats** (`contendersIn`): it is the balls that traffic-jam, so
  `[2,2]` gets the wide board. `MAX_TEAMS` = 4 (needs `TEAM3_RAMP` in `themes.ts` + `FIXED`).
- `wallBudget(contenders)` = 8 / 6 / 5 for 2 / 3 / ≥4; `CONFIG.WALL_LIMIT` stays 8 as the duel number.
- `spawnColumns(cols, count)` margins 2 / 1 / 0 for count 2 / 3–4 / ≥5 → 1v1 `[2,5]`, 3-way `[1,5,8]`,
  4-way `[1,3,6,8]`. `startLayout` fills rows bottom-up; later rows draw from the columns earlier ones
  left free, so nothing starts stacked while there is room.
- **Lattice keys are dimension-free:** `blocks()` / `wallSegments()` use `LATTICE_C`/`LATTICE_R` (the
  largest board), so `wallsClash`/`wallsOverlap`/`wallsCross` take no dims and stay pure.
  `distField(walls, cols, rows)` and `pathOn(d, pos, cols)` take dims as **required** args.
  `hasPathToFinish(s, walls?)` names the BFS goal-path guard `wallOk` uses.
- hazards: `hazardAt(seed,k,cols)` / `hazardSchedule(seed,n,cols)` / `initPhase(seed,cols)` /
  `logStopRow(walls,left,width,rows)`; `runLog`/`tickHazard` read `s.cols`/`s.rows`.
- Renderer: `setBoard(c, r)` (resets `lastW` to force a relayout); `main.ts restart()` calls it and
  sets `wallsEach = wallBudget(state.balls.length)`. Wire validation is dims-aware both sides:
  `worker/matchmaker.ts` `readMessage(..., cols, rows)` via `boardOf(waiter)`; `src/matchmaking.ts`
  `parseFrame(raw, sizes)`.

## Responsive board fit (src/render.ts, src/main.ts, src/style.css)
- **One metric, derived:** `computeLayout(w, h, dpr, cols, rows)` fits the grid into the box and
  everything scales from `L.cell` — `ballR(cell)`, `barT(cell)`, `capR(cell)`, `grooveZone(cell)`.
  Never a module constant for anything that is painted.
- **Seat palettes come from `SEAT_RAMPS`** in `themes.ts` (crimson skin · cobalt · solar gold ·
  emerald) and feed both the renderer's spheres/bars and the HUD chips, so they cannot drift.
  `SEAT_TICKS` gives each seat's wall bar a tick count, so ownership reads without colour.
- **`main.ts` publishes the layout to CSS on `.card`:** `--board-cols` / `--board-rows` (from
  `fitBoard`, on every `setBoard`) and `--board-cell` / `--board-oy` (from `publishCell`, on every
  resize). `.board-wrap` takes the board's own aspect from the first pair;
  `.finish-tag`'s `top` is `calc(var(--board-oy, 0px) + var(--board-cell, 36px) / 2)` — the slab is
  **centred** in the canvas, so row 0 starts at `oy`, and `100% / (2 * rows)` is wrong.
- **Nothing may paint outside the slab.** `draw()` opens one `rr(...)+clip()` after `setTransform`
  and closes it at the very end (no early returns, so it is balanced). Without it a bottom-row
  ball's selection ring (`r * 1.6`) and turn halo (`r * 2.3`) float on the card — the canvas used to
  clip that spill for free when the board filled it edge to edge.
- **Clamp every derived radius.** `ctx.arc(0, 0, r - 0.5, …)` on a degenerate cell throws
  `IndexSizeError` and aborts the whole frame, which reads as a blank board. And `draw()` re-fits
  when `clientWidth/Height` no longer match `lastW/lastH`: a race built while its screen was hidden
  measures `0x0` and a wrap that was already sized fires no `ResizeObserver` on reveal.
- **The drawer owns `#gm-start` and repaints it last.** `gamemodes.ts` `setGameMode` fires its
  watchers *then* calls `paintSheetState()` (and the diff-button handler calls it directly), so an
  `onGameModeChange` hook can never be the last writer. `paintParty` is registered after
  `initGameModes` **and** re-applied by a `MutationObserver` on the label, with an equality guard so
  it cannot re-enter. Party size persists at `detour.party.v1`.

## Rules engine geometry (src/rules.ts)
- A wall = two edge segments + the vertex they hinge on. `wallVertices`, `wallPivot` (`h(x,y)`→
  `(x+1,y)`, `v(x,y)`→`(x,y+1)`), `wallSegments`.
- **Only a *shared pivot* is the illegal `+`.** An endpoint on another wall's midpoint is a legal
  T-junction; two ends meeting is an L-corner; collinear walls touching end to end (`x` and `x+2`)
  are legal. Do not widen `wallsCross` to "any shared vertex".
- The bot needs no special casing: `botAction` scores candidates through `doWall`, which runs `wallOk`.

## Board action modes (src/boardmode.ts)
- One mode owns the board: ball in hand, wall preview, or mine key. Pure, no imports. `pickBall` clears
  the preview; `previewWall(m, null)` (pointer leaving) drops the bar alone; `moveDots`/`selectionRing`
  gate the renderer.
- `main.ts` holds `selected`/`ghost`/`mineArmed`; `mode()`/`setMode()` are the only writers — `setMode`
  also calls `armCapsules()` and **recomputes `hints` via `dotsFor(mode())`**. The dots are *derived*;
  a mode writer that forgets them is the bug this fixed.

## Design system (src/style.css)
- One theme, "Dark Clay": opaque slabs, no live blur (`--glass-blur: none`). Recipes: `--clay`
  (+ `--clay-ring`) for raised, `--inset` for wells, `--lip`/`--press-y` for controls. Gold ink
  `--honey-ink` (#FCD34D). On a ≤700px-tall viewport `--s3` is 8px, not 16.
- Toasts: `.note` elements; `showNote()` writes to the note host of the *visible* screen only.
- `flagPhoto()` (exported from `compete.ts`) is the only flag renderer. Reuse it, never a fresh `<img>`.

## Admin Command Center
- Client (`src/admin.ts`): four tabs `[data-atab]` = stats (default) · controls · server · tools.
  `runtime` is the single live config every module reads (`salesOpen, hazards, maintenance, broadcast,
  winTiq, coinMult, blitz, radiusNormal, radiusWide, tierOverride`), persisted at `detour.admin.v1`;
  `setRuntime(patch)` is the only writer. Add a switch: field on `AdminRuntime` + `DEFAULT_RUNTIME` +
  `loadRuntime()`, a control in `index.html`, then read `runtime.<field>` at the point of use — never
  snapshot it into a const.
- Server (`worker/`): `verifyAdminRequest(request, env)` takes an `AdminRequestLike` (`{url,
  headers.get}`), not a real `Request`, so it is testable in plain Node. `worker/index.ts` verifies
  `/admin/*`, answers 403, then forwards the *original* request to the `MatchmakerDO`; new admin
  routes go in the DO's `admin()` dispatcher. `MatchmakerDO` owns `maintenance`/`normalRadius`/
  `wideRadius`; the maintenance gate is in `enqueue()`, not at the upgrade.
- **A refusal is a decision, not a dead socket.** `matchmaker.ts` emits `{type:"ERROR",reason}` /
  `{type:"ABORTED",matchId}`; `src/matchmaking.ts` rejects with an `Error` named `'queue-refused'`
  carrying `reason`, and `queue()`'s handler skips `simulatedSearch()` for it — otherwise a maintenance
  refusal silently becomes a bot race.
- **Scope selectors to the stage.** The game-mode drawer also carries `data-step`; a bare
  `querySelectorAll('[data-step]')` picks up foreign nodes.

## Conventions
- Strict TS, `noImplicitReturns`, no unused imports. Prefer `aria-disabled` over `disabled` when a
  control must still receive the tap that explains why it is inert.
- Never commit `.shots/` or `.tmp/`.
