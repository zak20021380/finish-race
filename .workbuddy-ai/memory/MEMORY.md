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
- Mind Ladder row = FOUR cells: `.mind-rank` shield → `.mind-av` (28px, conic metal ring) →
  `.mind-id` (`.mind-nm` + optional `.mind-delta`) → `.mind-score` (gold + gold brain). Styling
  hangs off `li[data-rank]`, never per-child classes. The old `.mind-trend` dot capsule is gone —
  never reintroduce a fixed-width trend pill, it eats the handle. Crest = `Season ${arena().seasonNo}`
  in `#mind-top`; the YOU pill is `of N minds` in `#home-mind-field` (not a percentile).

## Post-match banter (src/banter.*)
- The bubble is `.result-say`, ABSOLUTE inside `.result-row` (`inset-inline-end:8px`, `top:50%`,
  `translateY(-50%)`, `max-width:66%`, `inline-flex` + gap). A pictograph-only message gets
  `.is-emote` → 30px round medal, not a pill. Text ellipsis lives on `.result-say-t`, not on the
  container (a block child never inherits the container's `text-overflow`).
- The tray is a `.result-banter` grid of stacked rows: faces, then ONE slot that holds either
  `#banter-form` or `#banter-canned` — never both, and `hidden` removes the track entirely.
- **An author `display` beats the UA `[hidden]` rule.** Every hidden surface here needs the
  `display:none!important` restatement, or the dock shows for 3/4-seat parties.

## VIP layer (premium gate)
- `src/premium.ts` is the ONLY entitlement door: `isPremiumUser()` = signed `user.is_premium` OR a
  session-only preview pass. Never a second `isPremium` anywhere.
- Server-side truth is the signature (`Identity.premium` → `Waiter`/`RoomMember`/`StoredMember`).
  A signed seat is judged by initData's `is_premium`; only the guest door reads `?vip=1`.
- `POST_MATCH_CHAT` carries `{preset}` or `{text}`, never both. `relayPostChat` is the gate; the
  free seat's allowance is `POST_CHAT_FREE_REACTIONS` (the five faces) — that table is the reason a
  free reaction is not refused by its own gate. `vip` is stamped by the room and only on text.
- Locked stickers keep their hitbox + `aria-disabled` (never `disabled`): the tap must be able to
  fire `notify('warning')` and open `#vip-sheet`, which is a SIBLING of `#result-card` (and sets
  `inert` on it). Stash glyphs stay at Emoji 1.0 — 🫡 is Emoji 14 and renders as tofu.
- `.result-row .result-say.is-vip` sits at (0,3,0) and AFTER `.result-row.is-you .result-say`;
  that tie is the only thing that keeps a VIP's own row gold.

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
- Chips sit INSIDE existing rows (`#btn-recover-tiq` in `.result-stake`, `#btn-double-coins` in
  `#result-coin-chip`). The recover key is the ONE thing on that card that may not shrink: 38px
  tall, 60% gold hairline, breathing shadow + clipped `::before` sheen, 16px shield, 12px/900
  label `RECOVER STAKE` → `PROTECTED ✓`. ≤360px it pays in type size, never in hitbox. The band's
  header is a DIFFERENT string (`STAKES LOST` → `STAKES BACK`) — never reuse the key's label there.
  `.result-rewards` is `nowrap`; the pill retires `.result-unit` (and `.result-token` ≤380px) via
  `#btn-double-coins:not([hidden]) ~ …` — the button leads in the DOM, `order:4` renders it last.
- Wiring: `showOverlay()` → `resetMatchClaims()`; `paintRewardButtons()`/`paintStakeValue()` hang
  off `paintResultCopy()` so `onLang` repaints them. Refund = `earnTiq(stake)`, double =
  `earnCoins(coins)`. Audio hold lives in audio.ts (`holdAudio`/`releaseAudio`, never the saved
  volume). `animateClaim()` is the one rAF clock; `stakeRaf`/`coinRaf` sit in `clearResultMotion()`.
- `#ad-toast` (inside `.overlay.result`) is the ONLY surface that can toast above the veil —
  `.note` is z-index 4 under the overlay's 10.

## Design system
- **NO league tiers anywhere.** Tiers were removed from the design (2026-11-01): no ROOKIE /
  LEGEND / PRO chips, no `data-tier` auras on pods, cards, sheets, crests or the admin panel.
  `MindTier`/`tierOf`/`myTier` survive ONLY as the internal queue band (`params.set('tier', …)`);
  never render it. `VsStakes.tier` is the bot's level, not a league. A standing is a rank + a TIQ.
- **Portraits are real Telegram photos**, monogram only as the load/error fallback. Ladder and
  podium fetch `loading=eager` (+`fetchpriority=high` for top 3); `photo_url` first, then
  `telegramAvatarUrl(username)`. `.mind-av` is a clay disc (never a neon orb) so a missing face
  is a clean letter.
- One theme "Dark Clay": opaque slabs, no live blur. Reduced motion is `html.reduced-motion`,
  `applyMotion()` the only writer. Settings uses `--set-pad-x` (never `--s3`). Toggles are amber ON —
  restate both states at (0,4,0). `.stars-head` ≤ 60px. `src/admin.ts` `runtime` = `detour.admin.v1`.
- **Persian = joined script.** One global ban in style.css: `html[data-lang="fa"], … *,
  [dir="rtl"], [dir="rtl"] *` carry `letter-spacing: normal !important` — tracking is a rendering
  fault, not taste. Labels that clip their own overflow (`.result-tag`, `.result-stake-k`) need
  line-height 1.6; every other fa label 1.45, titles 1.4. Physical `left/right` insets must become
  `inset-inline-*` (the ad spinner reads `--ad-spin-x`), or Persian puts the ring on the wrong side.

## Conventions
- Strict TS, `noImplicitReturns`. Prefer `aria-disabled` over `disabled` when the tap must explain
  itself. Never commit `.shots/` or `.tmp/`.
