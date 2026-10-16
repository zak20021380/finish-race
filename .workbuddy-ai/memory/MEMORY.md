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
- **Every CDP harness must `fs.rmSync(profile, {recursive:true, force:true})` on exit.** Each run leaves an
  ~18MB Chrome profile in `%TEMP%`; thirty of them filled C: to 0 bytes and every shell command began
  failing with `ENOSPC`. (The PowerShell tool also refuses `Remove-Item -Recurse` inside a computed loop —
  delete explicit `-LiteralPath`s in batches.)
- `.shots/` = CDP scripts + PNGs, `.tmp/` = scratch; both gitignored.

## Movement: leaps + anti-oscillation (src/rules.ts)
- A ball may LEAP over ANY other ball (own included): straight to the square behind the body when
  `canStep` from the BODY's cell passes, else a sidestep to a flank where `canStep(body, perp)` holds.
  Hemmed in on all three sides = a wall, nothing offered. `rawSteps` is the unfiltered set; `steps()`
  = `rawSteps` + the anti-oscillation filter, and it is the ONLY door (tap, bot, blitz, wire).
- `stepField(s)` = distance to FINISH in ACTIONS with the bodies standing (reverse CSR graph; a
  sidestep is a one-way edge). It is the bot's body metric, replacing the old `distFenced`. It
  returns a SHARED scratch buffer — read it, never hold it across another call.
- `GameState.repeat = { seen, streak }`; `REPEAT_LIMIT=3` narrows `steps()` to strictly-forward
  moves, `REPEAT_ADJUDICATE=6` awards the race to the nearest ball (`adjudicated: true`). `pass` is
  never filed. `boardFingerprint` = turn + wall/mine counts + every ball cell.
- ALLOCATION IS THE TURN BUDGET. `blocks()` hands back a shared `_blocks` Set pair (never hold a
  `Blocks` across another `blocks()` call); `distField` reuses `_bfsQ`; `stepField` reuses
  `_revOff/_revPre/_stepDist/_stepQ/_body`. Fresh per-call buffers blew p99 past 5ms.

## Rooms (src/room.ts + worker/matchmaker.ts)
- 2..4 seats, `human`|`bot`. `isAutomated` (badge/tier) vs `isHuman` (may play) are different
  questions — a vacant seat is neither. `rewardEligible` is false for every automated seat.
- `tierFor` counts automated seats BEFORE the index, so `backfill` hands out `mixed`'s hard/normal/
  hard ladder seat by seat. `RoomDriver.submit` plays every automated seat due in the SAME call, so
  the human clock is never charged for the machine's; `drop`/`resume` are takeover/reclaim.
- Worker: `?room=<n>&bottier=<tier>` makes a socket a room seat, NOT a queue entry. The wait rides
  on `MatchmakerDO.alarm()`. Frames: `ROOM_FOUND`, `ROOM_START`, `SEAT_BOT`. 1v1 untouched.
- Client: every local race goes through `openLocalRoom()`; the dock writes `data-bot` and paints
  `.bot-mark` (`#i-bot`) INTO THE FLAG'S OWN 14px SLOT — no new layout at 4 chips on 360px.

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
- **Reduced motion is `html.reduced-motion`** (renamed from `html.rm`). `applyMotion()` in `settings.ts`
  is its only writer; the system `prefers-reduced-motion` always wins (`motionReduced()`).

## Settings screen (`#s-settings`, style.css + index.html + settings.ts)
- **The elastic dial.** One fluid `--set-t` on `.screen.settings-screen` sizes the whole column, so the
  screen fits its box at every phone size. A breakpoint ladder CANNOT: it leaves dead bands (at 661/701/761
  the chrome stepped up ~30px while the screen grew 1px) where the screen suddenly scrolls.
  `--set-t: clamp(0px, calc((var(--app-h) - 640px)/292 - (430px - min(100vw,430px))/220), 1px)` — the
  height term alone is not enough, the foot badge wraps one line taller at 320px than at 430px.
  Every metric (row height, badge, card padding, all gaps) is a `calc()` off it.
- **Use `--set-pad-x`, never `--s3`, for these cards.** The global `:root` block drops `--s3` 16→8 at
  `max-height: 700px`, which reintroduces the same dead band one axis over.
- Verified zero overflow on 60/60 sizes (widths 320/360/390/412/430 × heights 640…932). Below ~620px app
  height the stack scrolls — the only case it ever does. `.tmp/settings-audit.mjs` + `.tmp/probe-sweep.mjs`.
- **The foot is ONE badge:** `#s-settings .set-notes` (opacity .78, ink lifted to `--chip-ink` so the fade
  still clears body-text contrast) holds the save note, the TIQ compliance line and the build stamp.
  `.ver-badge` was deleted; `.ver-dot` is the mint bead inside the badge.
- Toggles are carved grooves (`.settings-screen .switch`), **amber/gold when ON** — the base
  `.row[aria-checked="true"] .switch` paints the blue ramp at specificity (0,3,0), so BOTH states must be
  restated at (0,4,0) or the checked toggle silently falls back to blue.
- `soundSub` = "Steps, walls, and blast effects" in all five language tables.
- **Sound is gated at the source**: `playMove`/`playExplosion` (sound.ts) and `chime` (matchmaking.ts) all
  return early on `!settings.sound`; haptics likewise through `impact`/`notify`/`detonation` in telegram.ts.
  `setSetting()` writes `detour.settings.v1` and `setLang()` writes `detour.lang.v1`, both on the same tap.

## Arena hero header (the 200 Stars Cup, `compete.ts` + `.stars-head`)
- **Palette rule:** gold = live/premium (the Star's setting, the clock's bead, the lit
  key's rim); the wordmark stays cool silver. That keeps the CTA the only solid gold slab.
- **Budget: `.stars-head` ≤ 60px**, or the card scrolls at 360x640. Measured 58 / 60 / 54
  at 360x640 / 390x844 / 320x568. Row 1 has ~80px of *horizontal* slack and ~2px vertical,
  so header work is styling-only — never add a row.
- The emblem's gold rim is a **gradient fill behind a padded `::before`**, not a border,
  because `verify-channel-cup.mjs` audits header fills for opaque near-black boxes. The
  face is `::before { z-index: 0 }`, the PNG `position: relative; z-index: 1` at 74%.
- The wordmark is `background-clip: text` + `filter: drop-shadow(...)` (a `text-shadow`
  shows through a transparent fill), inside `@supports`, with a plain silver fallback.
- **PROBE gotcha:** a regex inside a template literal needs `\\s`, not `\s` — `/245,\s*158/`
  silently becomes `/245,s*158/` and every "is it gold?" test returns false.
- `.tmp/header-check.mjs` is the CDP probe for this header (no playwright needed).

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
