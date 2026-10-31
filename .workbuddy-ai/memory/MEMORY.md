# Project memory — finish-race (Detour Mini App)

Durable index; dated logs beside this file hold the history.

## Build / verify
- `npm run build` = `tsc --noEmit` + `tsc -p worker/tsconfig.json` + `node scripts/build-vite.mjs`.
- Unit `scripts/{mines,walls,room,bot-tiers}-check.mjs` (51/14/31/6) with `--experimental-strip-types`;
  worker `verify-worker-*.mjs` (56/39/52/103). `playwright-core` IS installed (`verify-*.mjs`, `.tmp/` CDP).
- **CDP harnesses must `fs.rmSync(profile,…)` on exit** (profiles filled C: once). **Never batch
  parallel `Edit`s at one file.** room-check's machine-budget assert is flaky under host CPU load.

## Rules (src/rules.ts)
- A ball may LEAP over ANY ball (own included): straight behind when `canStep` from the BODY's cell
  passes, else a flank sidestep. `rawSteps` unfiltered; `steps()` = `rawSteps` + anti-oscillation and
  is the ONLY door. `stepField(s)` returns a SHARED scratch buffer. `REPEAT_LIMIT=3`,
  `REPEAT_ADJUDICATE=6`. ALLOCATION IS THE TURN BUDGET: reuse `_blocks`.
- `dimsFor(contenders)` 8x12 ≤2 / 10x12 ≥3 (contenders = balls). `distField`/`pathOn` take dims.
  Only a shared pivot is the illegal `+`; T-junctions and L-corners are legal.

## Rooms + lobby
- 2..4 seats `human|bot`; `isAutomated` ≠ `isHuman`; `rewardEligible` false when automated;
  `RoomDriver.submit` plays every automated seat due in the SAME call.
- **One knob: the format** (`2v2|2v1|3p|4p`) → capacity, mode, `teamCapacity`, `defaultTeam`.
  `Lobby` is a value; `vacate` promotes the lowest held seat. `openLobby` falls back to solo after
  1400ms (set `solo` BEFORE closing its socket). Three panes `#gm-view-*`, `showView` the only
  writer; `[hidden]` must be restated on `.gm-view/.gm-foot/.gm-rewards/.lb-pick`. Unfit formats
  are BOUNCED, never half-applied.
- **Quick match is PARKED** (`QUICK_LOCKED` in `gamemodes.ts`): `DEFAULT_SELECTION` is `bot`, saved
  quick picks normalize to `bot`, `setGameMode` bounces quick ids, and `launchSelectedMode` refuses
  quick instead of `queueMatch()`. Its drawer row is a permanent showcase (`showcase` in
  `paintSheetState` keeps seg+filters visible) with `aria-disabled` pills — never `disabled`, or the
  tap cannot toast.

## Board + HUD
- `main.ts` owns `selected`/`ghost`/`mineArmed`; `onMouse` returns early on `holdsBall(mode())`.
- Everything scales from `computeLayout(...).L.cell`; `draw()` opens one `rr()+clip()` — nothing
  paints outside the slab, and every derived radius is clamped. `[data-seats]` is ALSO the drawer's
  Players control. Dock `#chips`: any new `.chip` rule needs (0,4,0) or it loses to older passes.

## Home carousel
- **Three slides: 0 = `.carousel-slide-tournament` (CHANNEL WAR · 200★, winner-takes-all, the
  default hero), 1 = `.nations-cup.carousel-slide-nations`, 2 = `.mind-ladder`.** Boot re-asserts
  `scrollLeft=0`; `currentSlideIndex` is the single position value. Band is a fixed 320px → card
  280 / content 234; slide 0 pins `8px 12px 37px`, only its hero flexes, ≤350px shrinks chip+gaps
  so the title stays whole. ONE 200★ vault — no 2nd/3rd pods. Hero = `#i-star-3d` 52px over
  crossed blades + dark shield; ticker leader hydrates from `getSquadRanking()[0]`.
  `#home-tournament-cta` → `arena` → knocks `#stars-cta` until the seat drawer opens.
- Leaderboard slides (1 + 2) close with `.hud-mine` — one 3-zone bar `[badge/flag+name][pill][score]`
  inside `.slide-foot` (flow only: no absolute, no negative margins). The five rows are
  `flex:1 1 0; min-height:0` so the band can NEVER overflow onto the bar; rows carry `padding-right:13px`
  to align the score column with the bar's 12px padding + 1px border. `paintMindMine`/`paintNationMine`
  paint zones, never `textContent` on the bar.

## Post-match banter (src/banter.*)
- Bubbles are FLEX CHILDREN of `.result-seat` (`fit-content`, `max-width:68%`,
  `margin-inline-start:auto`) — never absolute, so the nameplate is never covered. A pictograph-only
  message gets `.is-emote` → 42px round medal, not a pill.
- The dock is frameless and TWO rows: faces+toggle, then one `.banter-row-swap` grid cell shared by
  the chip rail and the composer (`grid-area:1/1`) — the toggle swaps them in place.
- **An author `display` beats the UA `[hidden]` rule.** Every hidden surface here needs the
  `display:none!important` restatement, or the dock shows for 3/4-seat parties.

## Squads / Telegram handles
- ONE rule: `HANDLE_RE = /^[a-z0-9_]{4,32}$/i` (src/squads.ts), mirrored in the worker as
  `/^@[a-z0-9_]{4,32}$/i`. Never lowercase a handle — capitals are part of it.
- `bareHandle()` folds a `t.me` link, the typed `@` and outer spaces; `handleIssue`/`cleanHandle`/
  `cleanChatReference` all read through it (no second regex anywhere).
- Enlist verify = worker `getChat` (GET `?chat_id=`) → existence + `chat.type` vs the active tab
  (`channel` vs `supergroup|group`); the modal only goes green on that answer, and BOTH phases
  spin the CTA (`#enlist-spin`), not just register.

## Rewarded video (src/ads.ts)
- ONE door: `playRewardedAd(placement)` **never rejects**; `no_sdk | no_fill | skipped | error`.
  Mutex `isShowingAd` (racing tap → `skipped`), reward on `onReward` OR `done===true && !error`,
  listeners removed + `destroy()` in `finally`.
- Block ids: `VITE_ADSGRAM_{RECOVER,COINS}_BLOCK_ID || VITE_ADSGRAM_BLOCK_ID || ''` — declared in
  `vite-env.d.ts` (undeclared `import.meta.env` keys are TS2339). SDK = async CDN tag in `<head>`.
- Quota `fr_tiq_recovery_log_v1` (NOT `detour.*`): epoch stamps, rolling 24h, max 3, memory mirror
  after first hydrate so refused storage still enforces it. Per-match claims are a separate `Set`.

## Design system
- One theme "Dark Clay": opaque slabs, no live blur. Reduced motion is `html.reduced-motion`,
  `applyMotion()` the only writer. Settings uses `--set-pad-x` (never `--s3`). Toggles are amber ON —
  restate both states at (0,4,0). `.stars-head` ≤ 60px. `src/admin.ts` `runtime` = `detour.admin.v1`.

## Conventions
- Strict TS, `noImplicitReturns`. Prefer `aria-disabled` over `disabled` when the tap must explain
  itself. Never commit `.shots/` or `.tmp/`.
