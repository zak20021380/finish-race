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
  synthetic `PointerEvent`s. `.tmp/board-size-check.mjs` = board geometry (12/12).
- **Pixel probes:** replicate `computeLayout` exactly — `LAYOUT_PAD = 2`, so `raw = min((w-4)/cols,
  (h-4)/rows)`, `cell = floor(raw*dpr)/dpr`. Probe board-space points, not pixels. A **slab-width**
  probe cannot tell 8x12 from 10x12 apart (the board scales to fit); find balls by **colour-family
  runs**, not saturation peaks (a red halo out-saturates a blue ball).
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
