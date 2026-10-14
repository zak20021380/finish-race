# Project memory — finish-race (Detour Mini App)

## Build / verify
- `npm run build` = `tsc --noEmit` + `tsc -p worker/tsconfig.json` + `vite build`.
- **esbuild is blocked on this machine** (`node_modules/@esbuild/win32-x64/esbuild.exe` exits 1
  silently), so `vite build` and any verifier that `import { build } from 'esbuild'` fail with
  "The service was stopped". Environmental — check a pristine tree before blaming a change.
- **Run the worker verifiers anyway** with the shim: `node --import ./.tmp/esbuild-redirect.mjs
  scripts/verify-worker-<name>.mjs` (`.tmp/esbuild-shim.mjs` reimplements esbuild's `build()` with
  rollup + `ts.transpileModule`). Current: matchmaking 35/35, race 40/40, admin 69/69.
- **No-toolchain suites:** `node --experimental-strip-types scripts/mines-check.mjs` → 41/41,
  `scripts/walls-check.mjs` → 12/12. They copy `src/*.ts` into `.shots/<name>-under-test.ts` with
  relative specifiers rewritten (Node only strips types from a real `.ts`).
- **CDP harness:** `.tmp/admin-check.mjs` (and `shop-preview.mjs`, `wall-mode-check.mjs`,
  `wall-shot.mjs`, same skeleton) bundles the real `src/` with rollup + `ts.transpileModule`,
  inlines `style.css` + the bundle into a copy of `index.html`, serves it on 127.0.0.1 and drives
  headless Chrome at 360x640. It already handles: strip the remote `telegram-web-app.js` script
  (a no-egress box stalls the parser on it), shim `import.meta.env = {}`, and dispatch synthetic
  `PointerEvent`s instead of CDP input. `.tmp/admin-measure.mjs` dumps per-panel geometry.
- **Layout budget at 360x640:** `.admin-body` client height is **504px** and the harness fails on
  any element whose `bottom > innerHeight` — *including* children scrolled out of the body. So
  every tab's whole content must fit 504px with no scrolling. Current heights: stats 460,
  controls ~484, server 254, tools ~360.
- **Pixel probes must replicate `computeLayout` — `LAYOUT_PAD` is 2**, so `raw = min((w-4)/cols,
  (h-4)/rows)` and `cell = floor(raw*dpr)/dpr`. On 360x640: `cell 39.5, ox 2, oy 3`. Probe
  board-space points, not pixels. For the selection ring take the max over an *annulus*.
- `.shots/` = CDP scripts + PNGs; `.tmp/` = scratch. Both gitignored.
- **Editing gotcha:** never batch parallel `Edit` calls at the same file — the writes race and
  clobber each other. Apply one at a time and re-grep.

## Rules engine (src/rules.ts)
- **Wall geometry is two edge segments plus the vertex they hinge on.** `Vertex`, `wallVertices`,
  `wallPivot` (`h(x,y)`→`(x+1,y)`, `v(x,y)`→`(x,y+1)`), `wallSegments` (vertical keys offset by
  `SEG_V = COLS*ROWS`), predicates `wallsOverlap` / `wallsCross` / `wallsClash`; `wallOk` loops
  `wallsClash` over every standing wall.
- **Only a *shared pivot* is the illegal `+`.** An endpoint on another wall's midpoint is a legal
  T-junction; two ends meeting is an L-corner; collinear walls touching end to end (`x` and `x+2`)
  are legal. Do not widen `wallsCross` to "any shared vertex".
- The bot needs no special casing: `botAction` scores candidates through `doWall`, which runs
  `wallOk`. Keep it that way rather than pre-filtering `allWalls`.

## Board action modes (src/boardmode.ts)
- One mode owns the board: ball in hand, wall preview, or mine key. Pure, dependency-free.
  `pickBall` clears the preview; `previewWall(m, null)` (pointer leaving) drops the bar alone so a
  hover does not cost the ball in hand; `moveDots` / `selectionRing` are what the renderer gates on.
- `main.ts` holds `selected` / `ghost` / `mineArmed`; `mode()` / `setMode()` are the only writers —
  `setMode` also calls `armCapsules()` and **recomputes `hints` via `dotsFor(mode())`**. The dots
  are *derived*; a mode writer that forgets them is the bug this fixed.

## Design system (src/style.css)
- One theme, "Dark Clay": opaque slabs, no live blur. `--glass-blur: none`,
  `--glass-bg: var(--clay-face)`; new work drops `backdrop-filter` outright.
- Recipes: `--clay` (drop + top spec + bottom bevel) with `--clay-ring` for raised panels;
  `--inset` for recessed wells; `--lip`/`--press-y` for extruded controls.
- Gold ink for figures is `--honey-ink` (#FCD34D, also `--coin-ink`/`--tiq`).
- On a ≤700px-tall viewport `--s3` is 8px, not 16 — the `max-height: 700px` block redefines it.
- Toast system: `.note` elements. `#note` lives in the game screen, the shop has its own;
  `showNote()` in `main.ts` writes to the note host of the *visible* screen only.

## Admin Command Center — client (src/admin.ts)
- **Four tabs**, `[data-atab]` = `stats` (default) · `controls` · `server` · `tools`;
  `[data-apanel]` mirrors them. Stats = the telemetry dashboard (4 tiles + Top Nations), Controls =
  3 switches + the broadcast line + the 2×3 tuning grid (its 6th cell is `#econ-reset`), Server =
  the Worker roster, Tools = grants + ladder preview + `#tool-reset`.
- `runtime` is the single live config every module reads: `salesOpen, hazards, maintenance,
  broadcast, winTiq, coinMult, blitz, radiusNormal, radiusWide, tierOverride`. Persisted at
  `detour.admin.v1`. `setRuntime(patch)` is the only writer (persist + notify `onRuntime` watchers);
  `resetRuntime()` restores `DEFAULT_RUNTIME`.
- Add a live switch: field on `AdminRuntime` + `DEFAULT_RUNTIME` + `loadRuntime()`, a control in
  `index.html`, then read `runtime.<field>` at the point of use. Never snapshot it into a const.
- **Telemetry** (`recordVisit` / `recordRace` / `recordCoins` + `dayStats`) lives in `admin.ts`.
  Measured counters persist at `detour.telemetry.v1` (`{day, visits, matches, coins}`), rolled over
  on UTC date change. `dayStats(live)` folds them onto a deterministic day-seeded population model
  (FNV-1a + xorshift32 over the UTC date) so the tiles read plausibly and stay stable for a day;
  a Worker answer replaces `active` with real seats. `recordRace` is called from `showOverlay()` in
  `main.ts`; `recordVisit` from `mount()`.
- **Nations strip reuses `flagPhoto()` exported from `compete.ts`** (3-tier circle-flags SVG →
  flagcdn PNG → ISO chip). Any new flag UI should go through it, not a fresh `<img>`.
- `#btn-admin-fab` is a child of `#s-home` (Home only); `placeFab()` measures its `bottom` to clear
  `.launcher`, and `relayout()` runs when the router lands on home.
- `queueMatch()` in `main.ts` is the only caller of `matchmaking.open()` — where Maintenance Lock
  gates. `onBack()` closes the admin stage before anything else.
- Ladder formula is `tiqFrom(wins, games, bonus)`; `RACE_TIQ = 20` is the per-race credit folded
  into `winTiq` (the 140 default = the old 120/win + 20/race). `Save.tiqBonus` + `earnTiq()` in
  `storage.ts` persist a TIQ grant (TIQ itself is derived).
- **Scope selectors to the stage.** The game-mode drawer also carries `data-step` (its ball
  counters), so `document.querySelectorAll('[data-step]')` picks up foreign nodes — query through
  `stage` instead.

## Admin Command Center — server half (worker/)
- `worker/auth.ts` `verifyAdminRequest(request, env)` takes an `AdminRequestLike` (`{url,
  headers.get}`), **not** a real `Request`, so it is testable in plain Node. initData from
  `X-Telegram-Init-Data` / `Authorization: tma <initData>` / `?initData=`; HMAC + `env.ADMIN_IDS`.
  A valid signature always wins; the dev door needs a dev host (`DEV_AUTH="true"` or loopback)
  **and** a marker (`x-admin`, `x-detour-admin`, `?admin=1`).
- `worker/index.ts` verifies `/admin/*` itself, answers **403**, then forwards the *original*
  request to the same `MatchmakerDO`. New admin route → the DO's `admin()` dispatcher (before the
  upgrade check in `fetch()`), not the worker.
- `MatchmakerDO` owns `maintenance` / `normalRadius` / `wideRadius` (defaults 250/600); `take()`
  reads them so `/admin/config` changes the next pairing pass. The maintenance gate is in
  `enqueue()`, **not** at the upgrade: the socket connects, the QUEUE is refused with
  `{type:"ERROR",reason:"MAINTENANCE"}` and closed cleanly. `evictAll(reason)` is the shared
  notify-then-close used by both the lock and `CLEAR_QUEUE`.
- The panel pushes those three fields via `syncConfig()` (diffed against `lastPushed`, a **no-op
  while `serverOn` is false**). Client admin calls send `x-admin: 1` **and** the Telegram initData;
  the Worker ignores the marker off a dev host, so sending both is safe.
- **The server's frames and the client's fallback.** `matchmaker.ts` emits `{type:"ERROR",reason}`
  and `{type:"ABORTED",matchId}`. `src/matchmaking.ts` must treat a refusal as a *decision*: it
  rejects with an `Error` named `'queue-refused'` carrying `reason`, and `queue()`'s rejection
  handler skips `simulatedSearch()` for it — otherwise a maintenance refusal silently becomes a
  bot race. `RaceEnd['why']` includes `'aborted'`.

## Conventions
- Strict TS, `noImplicitReturns`, no unused imports. Prefer `aria-disabled` over `disabled` when a
  control must still receive the tap that explains why it is inert.
- Never commit `.shots/` or `.tmp/`.
