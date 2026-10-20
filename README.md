# Detour — Telegram Mini App

Vite + TypeScript + Canvas 2D, plus a small Cloudflare Workers backend in `worker/`. A 1v1 quick
match can be played for real against another player — the matchmaker pairs the two seats and the
same socket relays the race between them. The bot, pass-and-play, the mock coins and the
browser-only save are all unchanged; with no Worker behind the page quick match falls back to the
local search exactly as it always did.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (also on your LAN)
npm run build      # client + worker type-check, then the production build in dist/
```

Works in a normal browser too (the Telegram SDK is optional).

## Screens

`Home → Game mode → Race`, with `Shop`, `Profile` and `Settings` on the floating bottom tab bar.
Game mode holds the difficulty and a Teams row — 2v2 / 3v3 / 2v1 presets plus a Custom screen with a
stepper for each side's ball count, the difficulty, a live board preview of the starting layout and
Start.
Navigation is a hand-rolled back stack (`src/router.ts`): slides use transform/opacity only and
swap instantly under `prefers-reduced-motion`. The Telegram `BackButton` is wired when the client
provides one; every screen also has a visible Back button, and the race screen's top-left menu
button opens the same pause sheet.

**Home** is the identity card (avatar, name, country, team, level progress, coins), the highlights
carousel and the mode launcher: a two-tier selector — **Solo / Bot** and **Party & Teams** on a
sliding pill, with only the choice that tier needs underneath it (the size row opens for Party, the
Easy / Normal / Hard row is always there) — and one Play button that names what it will start.

- **Solo / Bot** — one ball each against the machine. Easy / Normal / Hard: how often the bot walls,
  how far it looks ahead and how much it wanders (`src/bot.ts`).
- **Party & Teams** — 1v1 / 2v2 / 3v3, plus Custom, which opens the team builder.
- **Online** — not a mode you can pick: it sits under Play as a "Soon" footnote until the server exists.
- **Shop** — Balls / Walls / Boards. Every card carries a live miniature board painted by the race
  renderer itself, so a preview cannot disagree with the game. Buying spends coins, takes ownership
  and puts the item on in one tap.
- **Profile** — games, wins, losses, best run, coins, win streak, favourite mode, the country and
  team rows (both open the same sheets Home does), and the three equipped items as live previews.

## Country

Telegram hands over a `language_code`, never a country, so Profile owns the question: a bottom
sheet with a searchable list (`src/countries.ts`), pre-scrolled to the country that language usually
means — a suggestion only, nothing is forced. The answer is a two-letter ISO code in the save; while
it is unset, the home chip is a quiet "Add country" link that jumps to Profile.

Flags are regional-indicator pairs, which **Windows does not draw at all**. The app measures once
and falls back to a two-letter code chip in the same slot, so the row reads on every platform.

## Teams

A team is a name, a five-character join code, a roster and a rank in the standings. There is no
server yet, so the registry lives in the save and ships with a handful of demo clubs you can join to
see the flow — the sheet says "local mock" rather than pretending otherwise.

The shape is what makes the future cheap: every team carries `startParam` and a reserved `chatId`,
so `t.me/<bot>/detour?startapp=team-<code>` is already a link the app understands — opening Detour
from one pre-fills the join field. Binding a team to a real Telegram group is a server change, not a
schema change.

## Theme

The app ships **one light-clay palette**: a `#f1f5f9` canvas, elevated white tiles lit from above
(ambient drop · top specular · bottom bevel), coral `#ff5a36` reserved for the single primary action
and electric sky / mint / honey as the secondaries. There is no dark token set any more — a client in
night mode gets the same surfaces as one in day mode. `applyTheme()` in `src/telegram.ts` reports
`light` to Telegram and reads only `themeParams.button_color`, which tints the secondary brand ramp;
no white type sits on a fill that ramp can reach.

Safe-area insets, `viewportStableHeight`, the BackButton and haptics are all wired; every control is
at least 48px, depth is a 0-blur `box-shadow` so a press animates `transform` alone, and the page
itself never scrolls (only sheet lists and the profile pane do).

## Cosmetics

`src/themes.ts` holds every colour the app can draw: ball skins (palette + gradient stops + halo),
wall styles (thickness, bloom, highlight, rim) and board themes (surface, grid, ring, checkers,
finish glow). Defaults are the Classic ball, Classic wall and Lavender board — the look the app
shipped with.

**The opponent is never themed.** Their ball and walls stay on the built-in blue ramp, and a skin's
ramp is pushed out of both opponent hues before anything reads it (`separate()`), so no item — however
it is authored later — can make two sides look alike. Balls of one side also carry number badges, so
coloured jargon alone never has to tell them apart.

## Controls

- **Move**: tap one of your balls, then one of the dots that light up beside it — the chosen ball wears a ring and only its legal cells are shown. Each chip carries a wall badge showing how many walls that side has left.
- **Teams on the board**: every side races 1 to 3 balls (up to 4 sides) and alternates turns; on its turn a team moves any ONE of its balls one cell, or places a wall. Each side owns a colour family and its balls carry number badges, so a 3v3 stays readable. The first ball to the top row wins.
- **A ball in the way is a stepping stone, not a wall.** A ball may not walk into another ball, but it may LEAP over one: it lands on the square directly behind the body when the board leaves that square open, and hops to one of the body's two flanks when a wall, the perimeter or a third ball closes it. The leap is offered over any other ball — a team's own balls jam a corridor exactly the same way, and in a four-way "the opponent" is not a single seat. A body hemmed in on all three sides really is a wall. This is what a one-wide corridor needs: without it, two balls meeting head-on in a walled lane have nothing to do but shuffle forever. `steps()` is the only door, so a tap, the bot, the blitz auto-move and a move off the wire all see the same leaps, and `stepField()` measures distance in *actions* with the bodies on the board — a body is one action to leap, not a wall to walk around.
- **A shuffle cannot go on forever.** `GameState.repeat` is a small deterministic ledger of the boards the last few turns left behind. Once a race shuffles back onto a board it has already been in `REPEAT_LIMIT` (3) turns running, `steps()` narrows to the steps that actually gain ground on FINISH; if that still cannot break the cycle, the race is adjudicated at `REPEAT_ADJUDICATE` (6) — the ball nearest FINISH takes it, and `state.adjudicated` marks the win as called rather than crossed. Both are pure functions of the state, so every seat and the server reach the same verdict from the same board. A `pass` is never filed: it is a seat declining, not a board the race has been in.
- **The board is sized to the race.** Two contenders play the classic 8-column duel board; three or four get a 10-column one, so the extra balls start with room instead of queueing behind each other. `dimsFor(contenders)` picks the grid and `GameState.cols` / `GameState.rows` carry it — nothing downstream reads a module constant. Start squares are always spread with a lane between them: a 1v1 opens on columns 2 and 5 (a two-tile hole where the pair used to sit shoulder to shoulder), a 3-way on 1, 5 and 8, a 4-way on 1, 3, 6 and 8.
- **Walls are rationed per side, by contender count: 8 / 6 / 5.** `wallBudget(contenders)` returns 8 for a duel, 6 for three on the board and 5 for four, so a crowded board cannot be saturated. The chip under the board carries a premium wall badge that counts them down — a stylized wall glyph and the number left in that side's colour — mutes itself with a `.depleted` state at zero, and refuses placement outright. Tapping a groove with an empty budget shows no ghost, pulses the badge in warning amber and flashes "No walls remaining!". A wall still only has to stay in bounds, not overlap another wall on the same line, and keep every ball's path to FINISH open.
- **Wall (touch)**: tap a grid line — a ghost wall appears — tap the ghost again to place it, or tap anywhere else to cancel. An illegal slot shows a red ghost, a warning buzz and the reason ("Blocks the path" / "Overlaps a wall"); a spent budget shows no ghost and reads "No walls remaining!".
- **Wall (mouse)**: hover a grid line to preview, click once to place.
- **Pause**: the menu button (or the Telegram BackButton) opens Resume / Restart / Quit to menu, with a confirm before quitting. The end-of-game panel offers Play again and Menu.

## Coins

Every finished race pays: a win pays most, a loss still pays something, and a sharper bot pays more
(`payout` in `src/storage.ts`). The amount is shown on the game-over panel and lands in the balance
on Home and in the Shop. Every coin mark is the same inline SVG from `src/coin.ts` — gold gradient,
embossed rim, stamped "D" — and a balance change counts up with a shine sweep (both off under
`prefers-reduced-motion`). Amounts use thousands separators and tabular numerals. Coins are mock —
nothing here touches a payment provider.

## What is stored

One module owns persistence: `src/storage.ts`, with a versioned schema (`v: 2`) covering coins,
owned items, equipped items, the record, the country and the team registry. `src/settings.ts` keeps
the switches and the last chosen mode/difficulty. Both go through the same wrapped door, so a
webview that refuses `localStorage` (private mode, cookies off) still plays; the app then just runs
on defaults.

Swapping in Telegram CloudStorage means replacing the `backend` pair with an async get/set and
handing the fetched JSON to `hydrate()` — no screen or module reads storage directly.

Game state is still never stored: leaving a race mid-way abandons it.

## Open it as a Telegram Mini App

Telegram only loads **HTTPS** URLs.

1. Get a public HTTPS URL:
   - Quick test: `npx cloudflared tunnel --url http://localhost:5173` (or `ngrok http 5173`), or
   - Deploy `dist/` to any static host (Netlify, Vercel, Cloudflare Pages, GitHub Pages).
2. In Telegram, open [@BotFather](https://t.me/BotFather) → `/newapp`.
3. Pick your bot, then send: title (`Detour`), description, a 640×360 photo, (optional GIF, `/empty` to skip), and your **HTTPS URL**, then a short name.
4. BotFather replies with a link like `https://t.me/<bot>/<short_name>`. Open it to play.
   - Alternative: `/mybots` → your bot → Bot Settings → Menu Button → set the URL.

## Code map

| File | Role |
| --- | --- |
| `src/rules.ts` | Pure game logic: `GameState` (`cols`, `rows`, `teams`, `balls`, `walls`, `wallsLeft`, `turn`, `winner`), `dimsFor(contenders)` / `wallBudget(contenders)` / `startLayout(sizes, cols, rows)` for 2–4 contenders, `newGame(sizes)` for 1–3 balls per team, `reachable`, `wallOk` / `wallsRemaining` / `hasPathToFinish`, `apply(state, action)` |
| `src/bot.ts` | Local opponent: moves the ball closest to FINISH, walls only when it is level or behind and the wall costs 2+ steps, plus the Easy/Normal/Hard profiles |
| `src/themes.ts` | Every cosmetic as data: ball skins, wall styles, board themes, the fixed bot ramp and the red/blue guarantee |
| `src/render.ts` | Canvas drawing (board, walls, ghosts, every ball of every seat, number badges, the selection ring) from a `Theme`, `hitTest()` tap-target resolution, and `createPreview()` for the shop's miniature boards |
| `src/confetti.ts` | Win burst: a fixed particle pool on its own canvas, no per-frame allocation |
| `src/router.ts` | Screen stack + slide/fade transitions, back handling |
| `src/sheets.ts` | Bottom sheets over a dimming scrim (pause, quit confirm, buy confirm, how to play, country, team) |
| `src/storage.ts` | The save: versioned schema, the wrapped storage door, coins/owned/equipped/record, country, teams and the per-race payout |
| `src/coin.ts` | The one gold coin SVG (gradient body, embossed rim, stamped D) and `setBalance()` — count-up + shine sweep, thousands separators |
| `src/countries.ts` | ISO alpha-2 list, the picker's search, flag emoji + the Windows fallback, language → country preselect |
| `src/teams.ts` | Team/roster shape (`code`, `startParam`, `chatId`), the seeded demo clubs, join by code and the standings |
| `src/settings.ts` | The switches and the last mode/difficulty, on top of `storage.ts`; `motionReduced()` for CSS and canvas |
| `src/telegram.ts` | Optional Telegram init: viewport, themeParams light/dark, haptics, BackButton, language and `start_param` |
| `src/menu.ts` | Home, mode select, settings, the identity card, the country and team sheets and the tab bar — it only asks `main.ts` to start a race |
| `src/shop.ts` | The shop: tabs, cards with live previews, equip, and the buy confirm flow |
| `src/main.ts` | Game wiring: input (tap-to-arm / confirm, mouse hover + click), loop, chips, status, payout, overlay, pause |
| `src/room.ts` | The multi-seat lobby (2–4 seats), the bot backfill, the takeover, and the `RoomDriver` that plays every machine seat |
| `src/style.css` | Tokens, mesh background, clay panels, board frame, menu shell, shop and profile |
| `wrangler.toml` | The Worker: `MATCHMAKER` → `MatchmakerDO`, `BADGES` → `BadgeMintDO`, SQLite Durable Object migrations |
| `worker/index.ts` | `/health`, `/ws/matchmake` and the `/api/badges/*` surface |
| `worker/auth.ts` | Telegram `initData` verified with `crypto.subtle` HMAC-SHA256, plus the dev guest door and the badge player door |
| `worker/matchmaker.ts` | The waiting room: the queue, the 250/600 pairing radii, `MATCH_FOUND`, and the 2–4 seat rooms |
| `worker/badges.ts` | The edition ledger: hard caps, sequential serials, idempotent claims and per-player progress |
| `scripts/verify-worker-matchmaking.mjs` | Drives the whole queueing protocol in plain Node, no wrangler needed |
| `scripts/verify-worker-race.mjs` | Drives two clients through a whole relayed race, resignations and disconnects |
| `scripts/verify-worker-badges.mjs` | Auth, criteria, idempotency, cap exhaustion and 80 concurrent mints in plain Node |
| `scripts/room-check.mjs` | The corridor leap, the anti-oscillation guard, and whole 4-seat mixed rooms, on the real rules |

## Matchmaking backend

Quick match hands the seat to `src/matchmaking.ts`, whose transport opens a socket to
`VITE_WS_URL` (or `/ws/matchmake` on the page's own origin) carrying `initData`, `tiq`, `tier`,
`flag` and `wide`. The client sends `{ type: 'QUEUE' | 'WIDEN' | 'CANCEL' }` and reads
`{ type: 'MATCH_FOUND', matchId, seed, side, opponent }`; a match is then remembered as
`{ matchId, seed, side }` for the race. When no Worker answers, the same call answers with the
local search, so the stage is playable either way. The Worker verifies Telegram `initData` itself —
`DEV_AUTH=true` (`wrangler.toml`) or a loopback host opens a guest door for local work. Nothing in
`src/` imports `worker/`: wrangler bundles the backend on its own.

```bash
npx wrangler dev                       # local workerd, http://127.0.0.1:8787
VITE_WS_URL=ws://127.0.0.1:8787/ws/matchmake npm run dev
npm run check:worker                   # the worker's own strict typecheck (in `npm run build`)
node scripts/verify-worker-matchmaking.mjs
node scripts/verify-worker-race.mjs
node scripts/verify-worker-badges.mjs
```

### Badge editions

The Genius Triad's serials are minted by one singleton Durable Object (`BADGES`), so the caps are
global rather than per device. Its three public routes are:

| Route | Auth | Result |
| --- | --- | --- |
| `GET /api/badges/supply` | none | `{ badges: { id: { cap, minted, remaining } } }` |
| `POST /api/badges/progress` | Telegram `initData` | Records a monotonic progress snapshot for the mint gate |
| `POST /api/badges/mint` | Telegram `initData` | `{ success, badgeId, serial, cap, mintedAt }` |

Caps are `churchill_bastion` 100, `einstein_singularity` 50 and `heisenberg_formula` 25. Every
mutation runs through one promise queue and commits the counter and the claim in a single atomic
storage write; a second mint from the same player returns the existing serial unchanged, and a
full edition answers `409 { error: "CAP_EXHAUSTED" }`. The progress route is the server's criteria
ledger: the app's solo races settle locally, so the client reports their high-water stats, while
the mint itself (cap, serial, claim, eligibility decision) is always the Worker's.

The client (`src/badges.ts`) fetches supply and syncs progress on Profile mount, mints each locally
unlocked honor once per session, caches the confirmed serial in `detour.save.v2` (under
`editions`), and paints the shelf, the View All list and the avatar pin. If the Worker is absent or
slow, those cached numbers stay on screen behind a quiet `Syncing…` line. Deploying this build
applies the `v2` migration that creates `BadgeMintDO`; the ledger starts empty, at serial 1 for
each honor.

### The race, on the same socket

The socket that queued is the socket that plays. Both seats are handed the same `seed` and the same
board size, so `newGame(sizes, { hazards: true, seed })` builds the identical board on both screens
— the hazards and the rolling-log timetable are pure functions of that seed — and the room keeps
its own authoritative copy of it (it imports `src/rules.ts`, the module the client plays):

- `{ type: 'MOVE', action }` is judged against the real state before it is relayed to the other
  seat as `{ type: 'MOVE', side, action }`. A wall is stamped with the sender's seat, never with
  the owner the payload claims.
- An out-of-turn or illegal move answers `{ type: 'REJECT', reason }` and changes nothing.
- `{ type: 'RESIGN' }` and a socket that dies mid-race both hand the win to the seat opposite,
  which reads `{ type: 'RESIGN', side }` or `{ type: 'OPPONENT_LEFT', side }` and shows the reason
  in the end panel.

The client applies its own move the moment it is played and sends it on; the rival's moves come
back through the same `play()` door the bot uses, so walls, mines, thrown-back balls, log strikes
and the blitz clock behave exactly as they do offline. `onlineRace()` in `src/matchmaking.ts` is
that seat — `send()`, `onMove()`, `onEnd()`, `resign()` — and it is null when the search fell back
to the local simulation, which is how the offline board keeps working with no Worker at all.

### Rooms: 2 to 4 seats, humans and bots in any mix

A socket that asks for `?room=<n>` (2 to 4) is not a queue entry at all — it takes a seat in a
multi-seat room, which is the same lobby model the client runs (`src/room.ts`). Seats fill as people
arrive; the moment the room is full it launches, and when the wait timer runs out first every seat
still empty is backfilled with a bot. A four-seat room therefore always starts: 4 humans, 2 + 2,
1 + 3, or a solo host who never waited for anybody.

- The timer is the Durable Object's own alarm (`MatchmakerDO.alarm()`), not a `setTimeout` — an
  object can be evicted between messages and an alarm is the one thing that survives that. `?bottier=`
  picks the level the machine seats play; the default `mixed` ladders them Hard / Normal / Hard.
- `{ type: 'ROOM_FOUND', matchId, seed, side, sizes, seats }` is the room's `MATCH_FOUND`: it names
  every seat and says which of them the machine holds. `{ type: 'ROOM_START' }` from the host is the
  early start. Moves, resignations and refusals are the 1v1 frames.
- The race behind a room is a `RoomDriver` (`src/room.ts`): it owns the authoritative board, judges
  every human action, and plays every automated seat itself — a person's move and the machine's
  answers arrive in one batch, so a room of one person and three bots never needs a second round
  trip. The clock that governs a person's turn is never charged for the machine's.
- A seat whose person leaves — a resignation, a CANCEL, or a socket that simply died — is not
  abandoned: the machine takes it over at the room's own tier, everyone else is told with
  `{ type: 'SEAT_BOT', side, name }`, and the race runs to a real finish.
- A machine seat is never paid: `rewardEligible()` is false for a backfilled bot and for a seat a
  person walked out of, so no bot claims a Star, a trophy or a rung on the ladder. The dock says the
  same thing visually — a machine seat wears a bot mark in the flag's own slot and `data-bot` on the
  chip, so it can never be read as a person.

The **client** plays rooms locally today: the mode drawer's Practice card (any seat count) and the
private-room card both open a room through `openLocalRoom()`, host in seat 0 and the machine in the
rest, which is why a 4-player practice race now has laddered bots and bot badges. Pointing the room
card at the server's `?room=` protocol is the next step, and it needs no change on the server side.

## Going multiplayer later

`main.ts` still talks to the *local* opponent through one interface:

```ts
interface Opponent { think(s: GameState): Promise<Action> }
```

`makeBot(difficulty)` returns one — and takes either a level or a `(seat) => level` resolver, which
is how a room ladders its machine seats while a plain race plays one level throughout. A live race
does not go through it: the seat `onlineRace()`
hands back sends the move the player just made and feeds the rival's moves into the same `play()`
door, with the bot stood down for the length of the race (`wantsOpponent()` is false while a seat
is live). Everything still goes through `apply(state, action)` on both screens, which is what lets
`worker/` run the same `rules.ts` to judge a move before relaying it.

What is still missing from online play: a rematch on the same seats (Play again re-queues), a
reconnect into a *1v1* race that is already running (a room seat already handles it — the machine
takes over and the person can take it back), an authoritative `reject` resync (a refused move
is reported, not repaired), and a server-side check that a seat's clock actually ran out before
its timeout move is relayed. The client's own online seat is still 1v1: `OnlineSession` carries one
rival and two sides, so the server's room protocol is ready before the multi-seat race screen is.

## Tweaking the look

- Colours plus the type, spacing, radius and elevation scales: the `:root` token block at the top of
  `src/style.css`. There is one theme, so that block is the whole palette. Text uses the `*-ink`
  variants of the brand hues so every pair clears 4.5:1 on the card.
- The clay tile: `--clay-drop` / `--clay-spec` / `--clay-bevel` / `--clay-ring`, composed once in the
  shared panel recipe. The pressed key: `--lip`, `--press-y` and a `0 var(--d) 0 <lip>` shadow.
- The wordmark: the inline `<svg class="logo-mark">` in `index.html` — the letters are stroke paths
  and the `O` is the route bending round the wall bar, ending at the ball. Its idle motion is
  `logo-float` / `logo-bloom` in `src/style.css`.
- Menu shell (identity card, mode cards, shop cards, tabs, sheets): the `SHELL` block further down the same file.
- Ball, wall and board looks, and the prices: the catalog arrays in `src/themes.ts`.
- How a theme is painted (specular shape, bar highlight, finish glow): `drawBall`, `drawBar` and
  `buildStatic` in `src/render.ts`.
- Board geometry (cell margin, wall thickness): `computeLayout` and `drawBar` in `src/render.ts`.
- The FINISH pill's breathing room above the board (the lane that keeps it out of the card's rounded
  corner): `--finish-lane` in `src/style.css`. The wall counter's dashes, count pill and turn
  highlight live in the `.wall-*` rules under the chips, same file.
