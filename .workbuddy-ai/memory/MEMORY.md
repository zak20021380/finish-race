# Project memory — finish-race (Detour Mini App)

Durable index; dated logs beside this file hold the history.

## Build / verify
- `npm run build` = `tsc --noEmit` + `tsc -p worker/tsconfig.json` + `node scripts/build-vite.mjs`.
- Unit: `node --experimental-strip-types scripts/{mines,walls,room,bot-tiers}-check.mjs` (51/14/31/6).
  Worker: `verify-worker-{matchmaking,lobby,race,admin}.mjs` (56/39/52/103) — they bundle with esbuild
  and fake `WebSocketPair`/`Response`/the DO namespace, so the real DO code runs in plain Node.
- `.tmp/lobby-audit.mjs` (49 checks): solo flow at 3 viewports **plus an online pass** driving a fake
  `WebSocket` injected with `Page.addScriptToEvaluateOnNewDocument` (`window.__ws.push(frame)` in,
  `window.__wsLog` out). The machine-budget check in room-check is flaky under host CPU load — rerun
  quiet before suspecting a regression.
- `playwright-core` IS installed; `verify-gm-sheet.mjs` (Playwright) and the `.tmp/*-audit.mjs` raw-CDP
  harnesses both work (serve `dist`, strip `telegram-web-app.js`, drive headless Chrome).
- **Every CDP harness must `fs.rmSync(profile, {recursive:true, force:true})` on exit** — 18MB profiles
  filled C: once and every command began failing with `ENOSPC`.
- **Never batch parallel `Edit` calls at one file** — the writes race and clobber.

## Movement (src/rules.ts)
- A ball may LEAP over ANY ball (own included): straight behind the body when `canStep` from the BODY's
  cell passes, else a sidestep to a flank. Hemmed in on all three sides = a wall. `rawSteps` is
  unfiltered; `steps()` = `rawSteps` + anti-oscillation and is the ONLY door (tap, bot, blitz, wire).
- `stepField(s)` = distance to FINISH in ACTIONS with bodies standing; returns a SHARED scratch buffer
  (read, never hold). `repeat` → `REPEAT_LIMIT=3` narrows to forward-only, `REPEAT_ADJUDICATE=6` awards
  the race to the nearest ball. ALLOCATION IS THE TURN BUDGET: reuse `_blocks`/`_bfsQ`/`_stepDist`.

## Board sizing (src/rules.ts)
- `state.cols`/`.rows` are the only truth. `dimsFor(contenders)` → 8x12 for ≤2, 10x12 for ≥3;
  contenders = total balls, not seats. `MAX_TEAMS`=4; `wallBudget` 8/6/5; `spawnColumns` 1v1 `[2,5]`,
  3-way `[1,5,8]`, 4-way `[1,3,6,8]`. Lattice keys are dimension-free, but `distField(walls, cols, rows)`
  and `pathOn(d, pos, cols)` take dims as **required** args.
- **Only a shared pivot is the illegal `+`**: T-junctions, L-corners, collinear touching are legal.

## Rooms (src/room.ts + worker/matchmaker.ts)
- 2..4 seats, `human`|`bot`. `isAutomated` (badge/tier) vs `isHuman` (may play) differ — a vacant seat
  is neither. `rewardEligible` is false for every automated seat. `tierFor` counts automated seats
  BEFORE the index, so `backfill` hands out `mixed`'s hard/normal/hard ladder seat by seat.
  `RoomDriver.submit` plays every automated seat due in the SAME call (human clock untouched).
- Worker: `?room=<n>` = auto-pair seats (NOT a queue entry), wait rides on `alarm()`. Frames
  `ROOM_FOUND`/`ROOM_START`/`SEAT_BOT`. Client: local races go through `openLocalRoom()`; the dock
  writes `data-bot` and paints `.bot-mark` INTO THE FLAG'S OWN 14px SLOT.

## Friends lobby (src/lobby.ts, gamemodes.ts, worker)
- Three panes: `#gm-view-modes` / `#gm-view-room` (entry) / `#gm-view-lobby`. `showView` is the only
  writer of `view`; it hides the foot on the entry pane and restores `#gm-start`'s list label.
- **One knob: the format** (`src/room.ts`: `2v2|2v1|3p|4p`). Everything derives from it — capacity
  (4/3/3/4), mode (team/team/ffa/ffa), `teamCapacity` (2v2 2/2, 2v1 Blue 2 / Red 1), `defaultTeam`
  = seat parity, `formatOfMode` ('team'→2v2). `reflowSeats`/`reflowRoom` keep fitting seats where they
  are; `assignTeam` swaps with the lowest opposite seat when the target team is full; `nextTeam` is
  shared by client `teamFor` and the UI's `plannedTeam`.
- `Lobby` is a value; `seatIn`/`vacate`/`setFormat`/`setTeam` are pure. **`vacate` promotes the lowest
  held seat** — host migration, once. `openLobby` falls back to a **solo** lobby after 1400ms with no
  `LOBBY` frame; it sets `solo` before closing its own socket, or the close handler reports a drop.
  `minToStart` is 3 for 2v1 (all three humans), 2 otherwise — bots may fill the rest.
- Arena UI: Team view = Blue column / gold `#i-swords` crest / Red column, both `max(cap)` rows with
  `.lb-lock` on cells a format lacks (2v1 Red's second). FFA = 2x2 grid with seat colour chips.
  A player may move **their own** seat between teams; the host moves anyone. `[hidden]` still must be
  restated on `.gm-view`, `.gm-foot`, `.gm-rewards`, `.lb-pick` (author `display` outranks the UA rule).
- Worker: `?roomcode=NNNN&host=1` mints a code lobby; a guest must be expected (`room_not_found`).
  `LOBBY` out; `SET_FORMAT`/`SET_MODE` (alias)/`SET_TEAM`/`ROOM_START`/`CANCEL` in. A format nobody
  fits is **bounced** (`FORMAT_DENIED` to the host + a fresh `LOBBY`), never half-applied. The
  two-player minimum is **code lobbies only** — `?room=<n>` still launches solo (`formatForSize`).
- `LobbyRace` mirrors `OnlineSession` (`side: number`, `sizes: number[]`), so `startGame()` runs a room
  race with no second path; `roomFromRoster` trims trailing wells (min 2 seats). Team mode is lobby
  metadata: teams sync and paint, the board still plays one ball per seat.

## Board interaction + HUD (boardmode.ts, render.ts, main.ts)
- `main.ts` owns `selected`/`ghost`/`mineArmed`; `mode()`/`setMode()` are the only writers; `hints` are
  derived. **Sticky selection:** `onMouse` must return early on `holdsBall(mode())`, or a pointer
  crossing a groove wipes the dots mid-travel. `hitTest`: ball → move dot → confirm → groove → far move.
- Everything painted scales from `computeLayout(...)`'s `L.cell`. `main.ts` publishes
  `--board-cols/rows` and `--board-cell/oy` on `.card`. **Nothing may paint outside the slab:** `draw()`
  opens one `rr()+clip()` and closes it last; **clamp every derived radius** (`IndexSizeError` blanks
  the frame). `#chips` is a grid, `data-players` is the seat count; `[data-seats]` is ALSO the drawer's
  Players control — scope to `#sheet-game-modes`. `flagPhoto()` is the only flag renderer.
- **Dock, fourth pass (the cockpit):** `#chips` = `.hud-rail` (chat pill, `grid-column: 1/-1`) over two
  mirrored `.chip` cards. Budget at 360x640 is arithmetic: 10 air + 38 rail + 4 gap + 72 card = 124 = the
  old `36 margin + 88`, so the board never moves. The key must start >=510: the slab's own drop shadow
  reaches ~8px past the board box. Cards are `.chip-ball` well (40px) + `.av-in` monogram + `.res`
  (walls | mines, 47x24 wells). `#mine-btn` is the local cell and `seatChrome()` MOVES it into the local
  seat's dock (pushing the displaced `.mine-fog` to seat 0); rivals get `.mine-fog`, never a number —
  `setFog()` shows `?` and only prints `0` when `minesLeft()` proves the stash spent. Older chip passes
  still live in style.css: any new rule needs `.chip` in the selector (0,4,0) or it loses.

## Quick chat emotes (data/phrases.ts + chat.css)
- A face is read at 38-42px over `--field`: the body gradient's LAST stop must stay SATURATED
  (#F59E0B/#DC2626/#06B6D4). A dark rim melts into the well — that is what "muddy" means here.
  Volume comes from a crescent shade painted inside the sphere, never from the rim.
- The art is glossy 3D sticker vocabulary (Fluent/mobile-game packs), ~14-29 shapes per face:
  sphere + crescent shade + soft radial gloss + specular dot + bottom-right rim-light arc, then
  ONE clean feature per face. Laugh: closed-arc `∩` eyes + open smile (tooth band + tongue).
  Rage: thick angled brow strokes, centered pupils, a single down-curving frown stroke (corners
  LOW, middle HIGH in y-down coords — the reverse reads as a grin), white-gradient steam wisps.
  Hurry: raised-arch left brow + flat right brow, flat mouth, knuckle-bump fist at the chin, and
  a standalone golden hourglass at x43-59 (pinched continuous-outline glass).
- `ChatEmote.motion` → `emote-haha|grrr|hurry` on BOTH `.chat-emote-art` (pod) and `.chat-emote`
  (bubble). Only the art node animates; `.chat-emote-btn.is-tapped` owns the button transform.
  Inner SVG hooks: `.ec-steam` (fill-box), `.eh-glass` (view-box origin 51/37.5), `.ec-eyes`
  (pupils only — sclera stay put in the hurrry dart).
- Bubble lifecycle: `chat-bubble-pop` 200ms has NO fill-mode, so `is-out` (opacity 0 +
  translateY(-18px)) can take the transform back. `setBubble` drops `show` + reflows to re-arm.
  `EMOTE_MS` 2000 / `BUBBLE_MS` 2500 / `LEAVE_MS` 360. The bubble runs the same loops 40-50%
  faster (`.chat-bubble .emote-*` duration overrides) — duration only, never geometry.
- Bubbles are PAWN-anchored in the gameplay zone: `main.ts` passes `pawn(seat)` (animated
  `ballViews` centre mapped through `renderer.layout()` into viewport px + the cell), chat drops
  `.pawn-you`/`.pawn-bot` on that point and hangs the bubble `2.4 cells + 24px` above (clears a
  leap's two-cell dot ring), tail tracking via `--tip`. Emotes are 48x48 frosted capsules with a
  1px team neon ring (`--pawn-glow`: crimson mine / cyan foe). Layer and marks are
  `pointer-events: none`. Check: `scripts/verify-emote-overlay.mjs`.

## Design system (style.css)
- One theme, "Dark Clay": opaque slabs, no live blur. `--clay`/`--clay-ring` raised, `--inset` wells,
  `--lip`/`--press-y` controls, gold ink `--honey-ink`. Toasts are `.note`. **Reduced motion is
  `html.reduced-motion`**; `applyMotion()` (settings.ts) is its only writer, and the system
  `prefers-reduced-motion` always wins.

## Settings screen (`#s-settings`)
- **The elastic dial:** one fluid `--set-t` on `.screen.settings-screen` sizes the whole column; a
  breakpoint ladder leaves dead bands where the screen suddenly scrolls. Every metric is a `calc()`.
- Snug top-aligned rhythm: `.set-stack` is `flex: 0 1 auto` + `flex-start` (no `space-evenly`); air
  pools BELOW the foot badge. Use `--set-pad-x`, never `--s3` (`:root` drops it 16→8 under 700px).
- Toggles are carved grooves, **amber when ON** — the base `.row[aria-checked="true"] .switch` paints
  blue at (0,3,0), so BOTH states must be restated at (0,4,0).
- Sound is gated at the source (`playMove`/`playExplosion`/`chime`); haptics through `impact`/`notify`.

## Arena header + Admin
- `.stars-head` ≤ 60px or the card scrolls at 360x640; gold = live/premium, the wordmark stays silver.
- `src/admin.ts`: tabs `[data-atab]`; `runtime` is the one live config (`setRuntime` only), persisted at
  `detour.admin.v1`. `worker/index.ts` verifies `/admin/*` then forwards to `MatchmakerDO.admin()`; a
  refused queue rejects with an `Error` named `'queue-refused'` carrying `reason`.

## Conventions
- Strict TS, `noImplicitReturns`, no unused imports. Prefer `aria-disabled` over `disabled` when the
  control must still receive the tap that explains why it is inert. Never commit `.shots/` or `.tmp/`.
