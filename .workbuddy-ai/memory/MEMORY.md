# Project memory — finish-race (Detour Mini App)

Detailed history lives in the dated logs beside this file. This is the durable index.

## Build / verify
- `npm run build` = `tsc --noEmit` + `tsc -p worker/tsconfig.json` + `node scripts/build-vite.mjs`
  (probes esbuild, falls back to the rollup shim when the binary will not start).
- **esbuild is blocked on this machine** (`@esbuild/win32-x64/esbuild.exe` exits 1 silently), so a plain
  `vite build` dies with "The service was stopped". Environmental, not an app problem.
- Worker verifiers need the shim: `node --import ./.tmp/esbuild-redirect.mjs scripts/verify-worker-<n>.mjs`
  → matchmaking 35/35, race 52/52, admin 69/69.
- No-toolchain: `node --experimental-strip-types scripts/{mines,walls}-check.mjs` → 49/49, 14/14.
- Browser checks (`.tmp/*-check.mjs`): bundle real `src/` with rollup + `ts.transpileModule`, inline
  `style.css` + bundle into a copy of `index.html`, serve on 127.0.0.1, drive headless Chrome over raw
  CDP. Strip the remote `telegram-web-app.js`, shim `import.meta.env = {}`, dispatch synthetic
  `PointerEvent`s. `.tmp/board-size-check.mjs` = grid choice; **`.tmp/board-scale-check.mjs` = fit +
  palettes + magnet + rich HUD across 360x640 / 390x844 / 430x932 for 2P/3P/4P (125/125)**.
  `.tmp/probe-*.mjs` reuse the bundle the harness already wrote.
- **Pixel probes:** replicate `computeLayout` exactly — `LAYOUT_PAD = 2`, `raw = min((w-4)/cols,
  (h-4)/rows)`, `cell = max(1, floor(raw*dpr)/dpr)`, then a **second pass** with
  `pad = max(2, min(6, cell*0.06))`. Probe board-space points, not pixels.
- **Calibrate off the fully-opaque bounding box, never a colour feature.** One `getImageData`, keep
  `alpha >= 250`: the slab is the only opaque thing, so its bbox *is* `ox, oy, cols*cell x rows*cell`.
  The finish strip starts **green**, so its leftmost white pixel is the second checker (half a cell out).
- **Find a ball by saturation-weighted centroid, not per-column counts** — the turn halo (r 0.78 cell)
  reports one ball as three columns; a radial halo is centred on its ball, so the centroid is right.
- **Viewport px ≠ canvas-local px:** subtract the canvas's own `top` before comparing.
- **Layout budget at 360x640:** `.admin-body` is 504px; the harness fails on any element whose
  `bottom > innerHeight`, including children scrolled out of the body.
- `.shots/` = CDP scripts + PNGs; `.tmp/` = scratch. Both gitignored.
- **Never batch parallel `Edit` calls at one file** — the writes race and clobber.

## Board sizing — 2 to 4 contenders (src/rules.ts)
- `GameState.cols`/`.rows` are the only source of truth. `COLS`=8/`ROWS`=12 are the duel defaults;
  `WIDE_COLS`=10/`WIDE_ROWS`=12. `dimsFor(contenders)` → 8x12 for ≤2, 10x12 for ≥3.
- **Contenders = total balls, not seats** (`contendersIn`): `[2,2]` gets the wide board. `MAX_TEAMS`=4.
- `wallBudget(contenders)` = 8/6/5 for 2/3/≥4; `CONFIG.WALL_LIMIT` stays 8 as the duel number.
- `spawnColumns(cols, count)` margins 2/1/0 → 1v1 `[2,5]`, 3-way `[1,5,8]`, 4-way `[1,3,6,8]`.
  `startLayout` fills rows bottom-up; later rows use the columns earlier ones left free.
- **Lattice keys are dimension-free:** `blocks()`/`wallSegments()` use `LATTICE_C`/`LATTICE_R`, so
  `wallsClash`/`wallsOverlap`/`wallsCross` take no dims. `distField(walls, cols, rows)` and
  `pathOn(d, pos, cols)` take dims as **required** args. `hasPathToFinish(s, walls?)` is the BFS guard.
- hazards: `hazardAt(seed,k,cols)` / `hazardSchedule(seed,n,cols)` / `initPhase(seed,cols)` /
  `logStopRow(walls,left,width,rows)`; `runLog`/`tickHazard` read `s.cols`/`s.rows`.
- Renderer `setBoard(c, r)` resets `lastW` to force a relayout; `restart()` calls it and sets
  `wallsEach = wallBudget(state.balls.length)`. Wire validation is dims-aware both sides:
  `worker/matchmaker.ts` `readMessage(..., cols, rows)` via `boardOf(waiter)`; `matchmaking.ts`
  `parseFrame(raw, sizes)`.

## Responsive board fit (src/render.ts, src/main.ts, src/style.css)
- **One metric, derived:** `computeLayout(w, h, dpr, cols, rows)` fits the grid into the box and
  everything scales from `L.cell` — `ballR`, `barT`, `capR`, `grooveZone`. Never a module constant for
  anything painted.
- **Seat palettes come from `SEAT_RAMPS`** (`themes.ts`: crimson · cobalt · solar gold · emerald) and
  feed both the renderer's spheres/bars and the HUD chips. `SEAT_TICKS` gives each wall bar a tick count.
- **`main.ts` publishes the layout to CSS on `.card`:** `--board-cols`/`--board-rows` (`fitBoard`, every
  `setBoard`) and `--board-cell`/`--board-oy` (`publishCell`, every resize). `.board-wrap` takes the
  board's aspect from the first pair; `.finish-tag`'s `top` is
  `calc(var(--board-oy, 0px) + var(--board-cell, 36px) / 2)` — the slab is **centred** in the canvas.
- **Nothing may paint outside the slab.** `draw()` opens one `rr(...)+clip()` after `setTransform` and
  closes it at the very end (no early returns, so it is balanced). Without it a bottom-row ball's
  selection ring (`r*1.6`) and turn halo (`r*2.3`) float on the card.
- **Clamp every derived radius.** `ctx.arc(0, 0, r - 0.5, …)` on a degenerate cell throws
  `IndexSizeError` and aborts the frame (reads as a blank board). `draw()` re-fits when
  `clientWidth/Height` no longer match `lastW/lastH`: a race built while hidden measures `0x0` and a
  wrap that was already sized fires no `ResizeObserver` on reveal.
- **The drawer owns `#gm-start` and repaints it last.** `setGameMode` fires its watchers *then* calls
  `paintSheetState()`, so an `onGameModeChange` hook can never be the last writer. `paintParty` is
  registered after `initGameModes` **and** re-applied by a `MutationObserver` on the label, with an
  equality guard. Party size persists at `detour.party.v1`.

## The bottom dock / HUD chips (index.html, src/style.css, src/main.ts)
- **The dock is a grid, not a row:** `#chips` is `grid-template-columns: 1fr 1fr auto` and `#mine-btn` is
  its third column — dock furniture, *not* a chip's child. That is what buys every seat its width back
  (a 48px key inside a chip costs it ~54 of the 130 it has at 360px). 3P/4P add
  `grid-row: 1 / span 2` on the key; 3P adds `#chip-2 { grid-column: 1 / 3 }`.
- **`data-players` is the live seat count** (2/3/4); `data-seats` is written beside it for older probes.
  Both come from `paintRoster()`. `[data-seats]` is *also* the mode drawer's Players control — scope
  selectors to `#sheet-game-modes`.
- Chip layout: `[.chip-ball (sphere + .flag-badge)] [.chip-txt: .who-line(.who + .walls) / .xp]`.
  2P = 68px chip, 42px ball, 13px name; 3P/4P = 52px chip, 34px ball, 11px name, 16px XP pill.
  `.who` is `flex: 1 1 auto` with ellipsis, `.walls` is `flex: none`, so the ammo count never moves.
- **The `walls` word is never painted** in the dock (`.chip .walls .wall-w { display: none }`): the
  team-coloured bar + count is the readout, and the badge's `aria-label` still spells it out. Leaving it
  visible truncated "BOT 2" to "BOT…" at 390px.
- **Seat identity is `paintSeatIdentity()`** — flags via `flagPhoto` into `#flag-N`, XP into
  `#xp-N .xp-n` — diffed against `shownFlags`/`shownXp` because `ui()` runs on every action. Seat 0's XP
  is `myTiq()` and repaints on `onChange` (a settled race flushes the save); a bot seat's flag and XP come
  off `raceSeed` (set in `restart()`) so they are stable for the whole race. Online seats read
  `active.opponent.flag` / `.tiq`.
- `paintSeatTints()` also sets `--tint`/`--glow` on `#mine-btn`, which is outside the chips now.
- `seatChrome()` moves only the `.timer` SVG + `.timer-n` onto the local seat's `.chip-ball` and `#dots`
  onto the rival's — moving the whole capsule left the destination seat wearing two spheres.

## Rules engine geometry (src/rules.ts)
- A wall = two edge segments + the vertex they hinge on. `wallVertices`, `wallPivot`, `wallSegments`.
- **Only a *shared pivot* is the illegal `+`.** An endpoint on another wall's midpoint is a legal
  T-junction; two ends meeting is an L-corner; collinear walls touching end to end (`x` and `x+2`) are
  legal. Do not widen `wallsCross` to "any shared vertex".
- The bot needs no special casing: `botAction` scores candidates through `doWall`, which runs `wallOk`.

## Board action modes (src/boardmode.ts)
- One mode owns the board: ball in hand, wall preview, or mine key. Pure, no imports. `pickBall` clears
  the preview; `previewWall(m, null)` drops the bar alone; `moveDots`/`selectionRing` gate the renderer.
- `main.ts` holds `selected`/`ghost`/`mineArmed`; `mode()`/`setMode()` are the only writers — `setMode`
  also calls `armCapsules()` and recomputes `hints` via `dotsFor(mode())`. The dots are *derived*.

## Design system (src/style.css)
- One theme, "Dark Clay": opaque slabs, no live blur (`--glass-blur: none`). `--clay` (+ `--clay-ring`)
  for raised, `--inset` for wells, `--lip`/`--press-y` for controls. Gold ink `--honey-ink` (#FCD34D).
  On a ≤700px-tall viewport `--s3` is 8px, not 16.
- Toasts: `.note` elements; `showNote()` writes to the note host of the *visible* screen only.
- `flagPhoto()` (exported from `compete.ts`) is the only flag renderer. Reuse it, never a fresh `<img>`.

## Admin Command Center
- Client (`src/admin.ts`): four tabs `[data-atab]` = stats (default) · controls · server · tools.
  `runtime` is the single live config every module reads (`salesOpen, hazards, maintenance, broadcast,
  winTiq, coinMult, blitz, radiusNormal, radiusWide, tierOverride`), persisted at `detour.admin.v1`;
  `setRuntime(patch)` is the only writer. Add a switch: field on `AdminRuntime` + `DEFAULT_RUNTIME` +
  `loadRuntime()`, a control in `index.html`, then read `runtime.<field>` at the point of use.
- Server (`worker/`): `verifyAdminRequest(request, env)` takes an `AdminRequestLike` (`{url,
  headers.get}`), not a real `Request`, so it is testable in plain Node. `worker/index.ts` verifies
  `/admin/*`, answers 403, then forwards the *original* request to the `MatchmakerDO`; new admin routes
  go in the DO's `admin()` dispatcher. `MatchmakerDO` owns `maintenance`/`normalRadius`/`wideRadius`;
  the maintenance gate is in `enqueue()`, not at the upgrade.
- **A refusal is a decision, not a dead socket.** `matchmaker.ts` emits `{type:"ERROR",reason}` /
  `{type:"ABORTED",matchId}`; `src/matchmaking.ts` rejects with an `Error` named `'queue-refused'`
  carrying `reason`, and `queue()`'s handler skips `simulatedSearch()` for it.
- **Scope selectors to the stage.** The game-mode drawer also carries `data-step`; a bare
  `querySelectorAll('[data-step]')` picks up foreign nodes.

## Conventions
- Strict TS, `noImplicitReturns`, no unused imports. Prefer `aria-disabled` over `disabled` when a
  control must still receive the tap that explains why it is inert.
- Never commit `.shots/` or `.tmp/`.
