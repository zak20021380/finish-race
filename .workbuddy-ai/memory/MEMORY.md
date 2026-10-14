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
  `node --import ./.tmp/esbuild-redirect.mjs scripts/verify-worker-matchmaking.mjs` → 35/35,
  `verify-worker-race.mjs` → 40/40, `verify-worker-admin.mjs` → 69/69. Prefer this over
  re-implementing their assertions.
- **Pure-rules suites run with no toolchain at all:** `node --experimental-strip-types
  scripts/mines-check.mjs` → 41/41 and `scripts/walls-check.mjs` → 12/12. Both copy `src/*.ts` into
  `.shots/<name>-under-test.ts` with the relative specifiers rewritten (Node only strips types from
  a real `.ts`, and `rules.ts` says `from './hazards'`). `src/boardmode.ts` imports nothing, so a
  test can read it straight out of `src/`.
- **Workaround harness: `.tmp/shop-preview.mjs`** (and `.tmp/admin-check.mjs`, `.tmp/wall-mode-check.mjs`,
  `.tmp/wall-shot.mjs`, same skeleton) — bundles the real `src/` with rollup + `ts.transpileModule`
  (no esbuild), inlines `style.css` and the bundle into a copy of `index.html`, serves it on
  127.0.0.1, and drives headless Chrome over CDP at 360x640. Three gotchas it already handles: strip
  the remote `telegram-web-app.js` script (a no-egress box stalls the parser on it), shim
  `import.meta.env = {}` (vite substitutes it at build time; the raw bundle otherwise throws on
  `import.meta.env.VITE_WS_URL` in `matchmaking.ts`), and dispatch synthetic `PointerEvent`s
  (`pointerType: 'mouse'` for hover, `'touch'` for a tap) instead of plumbing CDP input.
- **Pixel probes must replicate `computeLayout` exactly — `LAYOUT_PAD` is 2**, so
  `raw = min((w-4)/cols, (h-4)/rows)` and `cell = floor(raw*dpr)/dpr`. `.shots/wall-badge-check.mjs`
  still has the old `(w - 6)`; copying it shifts every probe by cells and will lie to you. On
  360x640 the truth is `cell 39.5, ox 2, oy 3` (canvas 320x480). Probe board-space points, not
  pixels: a cell centre catches the move dots, a point on a grid line between centres catches a wall.
  For the selection ring, take the max over an *annulus* (it pulses in and out of a fixed radius).
- `.tmp/smoke-game.mjs` walks Home -> `#home-play` -> `[data-gmode="bot"]` -> `#gm-start` to smoke
  the board screen. Note `#home-play` starts a *bot race* directly; the matchmaking stage is only
  reachable via `#mode-hero` -> `[data-gmode="duel_1v1"]` -> `#gm-start`.
- `.shots/` holds the CDP screenshot scripts and PNGs; `.tmp/` is scratch. Both gitignored.
- Editing gotcha: never batch parallel `Edit` calls at the same file — the writes race and silently
  clobber each other. Apply them one at a time and re-grep afterwards.

## Rules engine (src/rules.ts)
- **Wall geometry is two edge segments plus the vertex they hinge on.** `Vertex`, `wallVertices`,
  `wallPivot` (`h(x,y)` → `(x+1, y)`, `v(x,y)` → `(x, y+1)`), `wallSegments` (vertical segment keys
  offset by `SEG_V = COLS*ROWS` so the families never collide), and the predicates `wallsOverlap` /
  `wallsCross` / `wallsClash`. `wallOk` loops `wallsClash` against every standing wall.
- **Only a *shared pivot* is the illegal `+`.** An endpoint landing on another wall's midpoint is a
  T-junction and is legal; two ends meeting is an L-corner; collinear walls touching end to end
  (`x` and `x+2`) are legal. Do not widen `wallsCross` to "any shared vertex".
- The bot needs no special casing: `botAction` scores candidates through `doWall`, which runs
  `wallOk`. Keep it that way rather than pre-filtering `allWalls`.

## Board action modes (src/boardmode.ts)
- One mode owns the board: a ball in hand, a wall preview, or the mine key. Pure and dependency-free,
  so it is unit-testable. `pickBall` clears the preview; `previewWall(m, null)` (the pointer leaving)
  drops the bar *alone* so a hover does not cost the ball in hand; `moveDots` / `selectionRing` are
  what the renderer gates on.
- `main.ts` holds the values (`selected` / `ghost` / `mineArmed`) and `mode()` / `setMode()` are the
  only writers — `setMode` also calls `armCapsules()`, and **recomputes `hints` via `dotsFor(mode())`**.
  The dots are *derived*; a writer of the mode that forgets them is exactly the bug this fixed.


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

## Admin Command Center — the server half (worker/)
- `worker/auth.ts` `verifyAdminRequest(request, env)` takes an `AdminRequestLike` (`{url,
  headers.get}`), **not** a real `Request`, so it is testable in plain Node. It reads initData from
  `X-Telegram-Init-Data` / `Authorization: tma <initData>` / `?initData=`, verifies the HMAC, and
  checks `env.ADMIN_IDS`. A valid signature always wins; the dev door needs a dev host
  (`DEV_AUTH="true"` or loopback) **and** a marker (`x-admin`, `x-detour-admin`, or `?admin=1`).
- `worker/index.ts` verifies `/admin/*` itself and answers **403**, then forwards the *original*
  request to the same `MatchmakerDO`. Add a new admin route: handle it in the DO's `admin()`
  dispatcher (before the upgrade check in `fetch()`), not in the worker.
- `MatchmakerDO` owns `maintenance` / `normalRadius` / `wideRadius` (defaults 250/600). `take()`
  reads them, so `/admin/config` changes the next pairing pass. The maintenance gate is in
  `enqueue()`, **not** at the upgrade: the socket still connects, the QUEUE is refused with
  `{type:"ERROR",reason:"MAINTENANCE"}` and closed cleanly. `evictAll(reason)` is the shared
  notify-then-close used by both the lock and `CLEAR_QUEUE`.
- The panel's three shared fields are pushed by the `onRuntime` watcher via `syncConfig()`, which
  diffs against `lastPushed` and is a **no-op while `serverOn` is false** (offline never retries in a
  loop). The Server KPI pill reads `/admin/status`, not `/health` (`probeServer`/`healthUrl` are gone).
- Client admin calls send `x-admin: 1` **and** the Telegram initData; the Worker ignores the marker
  off a dev host, so sending both is safe.
- **The server's frames and the client's fallback.** `worker/matchmaker.ts` emits `{type:"ERROR",
  reason}` (maintenance / cleared) and `{type:"ABORTED",matchId}`. `src/matchmaking.ts` must keep
  treating a refusal as a *decision*, not a dead socket: it rejects with an `Error` named
  `'queue-refused'` carrying `reason`, and `queue()`'s rejection handler skips the
  `simulatedSearch()` fallback for it. Without that, a maintenance refusal silently becomes a bot
  race. `RaceEnd['why']` includes `'aborted'`.
- **New admin UI content goes in a new tab, never the Live Ops panel.** `.tmp/admin-check.mjs` walks
  every element of `#overlay-admin` and fails on `bottom > innerHeight` — including elements scrolled
  out of the `overflow-y: auto` body. Ops already fills 360x640 exactly; a hidden panel's children
  have zero height and are skipped.

## Conventions
- Strict TS, `noImplicitReturns`, no unused imports. Prefer `aria-disabled` over the `disabled`
  attribute when a control must still receive the tap that explains why it is inert.
- Never commit `.shots/` or `.tmp/`; the repo keeps them as scratch by convention.
