# Project memory — finish-race (Detour Mini App)

History lives in the dated logs beside this file; this is the durable index.

## Build / verify
- `npm run build` = `tsc --noEmit` + `tsc -p worker/tsconfig.json` + `node scripts/build-vite.mjs`.
- **esbuild is blocked on this box** (`esbuild.exe` exits 1 silently) → a plain `vite build` dies with
  "The service was stopped". Environmental, not an app bug. Worker verifiers need
  `node --import ./.tmp/esbuild-redirect.mjs scripts/verify-worker-<n>.mjs` → matchmaking 35/35,
  race 52/52, admin 69/69; `node --experimental-strip-types scripts/{mines,walls}-check.mjs` → 49/49,
  14/14.
- Browser checks `.tmp/*-check.mjs`: rollup + `ts.transpileModule` over real `src/`, inline `style.css`
  and the bundle into a copy of `index.html`, serve on 127.0.0.1, drive headless Chrome over raw CDP.
  Strip `telegram-web-app.js`, shim `import.meta.env = {}`, dispatch synthetic `PointerEvent`s.
  `.tmp/board-scale-check.mjs` = fit + palettes + magnet + HUD + sticky dots across 360x640 / 390x844 /
  430x932 for 2P/3P/4P (135/135); `.tmp/hud-probe.mjs` dumps dock geometry + crops, asserts nothing.
- The playwright verifiers (`verify-game-layout` & co.) cannot run here: `playwright-core` is missing and
  the box is out of disk, so `npm i` fails. Pre-existing; the `.tmp/*-check.mjs` CDP harnesses cover the
  same game-screen ground.
- **Pixel probes:** replicate `computeLayout` — `PAD = 2`, `raw = min((w-4)/cols, (h-4)/rows)`,
  `cell = max(1, floor(raw*dpr)/dpr)`, second pass `pad = max(2, min(6, cell*0.06))`; probe board-space
  points, never pixels. Calibrate off the **fully-opaque bbox** (`alpha >= 250` — only the slab is
  opaque). Find a ball by **saturation-weighted centroid** (the turn halo spans 3 columns). Viewport px
  ≠ canvas-local px: subtract the canvas `top`.
- **Never batch parallel `Edit` calls at one file** — the writes race and clobber.
- `.shots/` = CDP scripts + PNGs, `.tmp/` = scratch; both gitignored.

## Board sizing (src/rules.ts)
- `state.cols`/`.rows` are the only source of truth. `dimsFor(contenders)` → 8x12 for ≤2, 10x12 for ≥3;
  contenders = total balls, not seats. `MAX_TEAMS`=4; `wallBudget` 8/6/5 for 2/3/≥4. `spawnColumns` →
  1v1 `[2,5]`, 3-way `[1,5,8]`, 4-way `[1,3,6,8]`.
- Lattice keys are dimension-free, so `wallsClash`/`wallsOverlap`/`wallsCross` take no dims, but
  `distField(walls, cols, rows)` / `pathOn(d, pos, cols)` take them as **required** args.
- **Only a *shared pivot* is the illegal `+`**: an endpoint on another wall's midpoint is a legal
  T-junction, two ends meeting an L-corner, collinear touching walls legal. Don't widen `wallsCross`.

## Board interaction (src/boardmode.ts, main.ts, render.ts)
- Modes are pure arithmetic; `main.ts` owns `selected`/`ghost`/`mineArmed` and `mode()`/`setMode()` are
  the only writers. `hints` are **derived** from the mode (`dotsFor`), never stored.
- **Sticky selection:** `previewWall(m, non-null)` clears the selection, so `onMouse` must return early
  on `holdsBall(mode())` — otherwise a pointer crossing a groove on its way to a move dot wipes the
  dots mid-travel. Hover previews walls only while nothing is in hand.
- `hitTest` priority: capsule/ball → **move dot** → armed confirm → groove → far move. A tap inside a
  legal-move dot's own cell always resolves to `move` (`hintCellAt`) — the radius-based `MOVE_ZONE`
  test alone loses to the magnet whenever `reach` is narrower than half a cell.

## Board fit + HUD (render.ts, main.ts, index.html, style.css)
- **One metric, derived:** everything painted scales from `computeLayout(...)`'s `L.cell`; never a module
  constant. `SEAT_RAMPS` (themes.ts) feeds both the renderer and the HUD chips.
- `main.ts` publishes `--board-cols`/`--board-rows` (every `setBoard`) and `--board-cell`/`--board-oy`
  (every resize) on `.card`.
- **Nothing may paint outside the slab:** `draw()` opens one `rr(...)+clip()` and closes it last (no early
  returns). **Clamp every derived radius** — a degenerate cell throws `IndexSizeError` and aborts the
  frame (blank board).
- Dock: `#chips` is a grid; `data-players` is the live seat count (written with `data-seats` by
  `paintRoster()`). `[data-seats]` is *also* the mode drawer's Players control — scope to
  `#sheet-game-modes`. `paintSeatIdentity()` diffs flags/XP against `shownFlags`/`shownXp` because `ui()`
  runs on every action.
- **Card = `[.chip-ball] [.chip-txt: .who-line(flag/name/XP) / .walls]`.** 2P is `1.35fr 1fr` and
  `#mine-btn` is a DOM child of `#chip-0` on its right; 3P/4P is `1fr 1fr` + `padding-right: 60px` with
  the bomb absolute against `#chips`, which needs `#chip-0 { position: static; transform: none }` there
  (its turn ring then lives on box-shadow, not `.chip::after`).
- `flagPhoto(code, cls)` (compete.ts) is the only flag renderer; `null` paints an ISO chip reading "—", so
  `flagFor()` hands it `DEFAULT_FLAG`. `.xp-u` stays in the DOM but is hidden in the dock.

## Design system (style.css)
- One theme, "Dark Clay": opaque slabs, no live blur (`--glass-blur: none`). `--clay`/`--clay-ring` raised,
  `--inset` wells, `--lip`/`--press-y` controls, gold ink `--honey-ink` (#FCD34D). On a ≤700px-tall
  viewport `--s3` is 8px. Toasts are `.note`; `showNote()` writes to the *visible* screen only.

## Admin Command Center
- Client `src/admin.ts`: tabs `[data-atab]` = stats · controls · server · tools. `runtime` is the one live
  config (`setRuntime` the only writer), persisted at `detour.admin.v1`; add a switch via `AdminRuntime` +
  `DEFAULT_RUNTIME` + `loadRuntime()` + an `index.html` control.
- Server `worker/`: `verifyAdminRequest(request, env)` takes an `AdminRequestLike` so it tests in plain
  Node; `worker/index.ts` verifies `/admin/*`, 403s, then forwards the original request to
  `MatchmakerDO`, whose `admin()` dispatcher owns new routes. The maintenance gate is in `enqueue()`.
  A refusal is a decision: the matchmaker emits `ERROR`/`ABORTED` and `src/matchmaking.ts` rejects with an
  `Error` named `'queue-refused'` carrying `reason`, so `queue()` skips `simulatedSearch()` for it.

## Conventions
- Strict TS, `noImplicitReturns`, no unused imports. Prefer `aria-disabled` over `disabled` when the
  control must still receive the tap that explains why it is inert. Never commit `.shots/` or `.tmp/`.
