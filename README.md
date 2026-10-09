# Detour — Telegram Mini App (frontend only)

Vite + TypeScript + Canvas 2D. No backend: the opponent is a local bot, coins are mock and every
save lives in the browser. Shop and Profile are real screens; Online is still a placeholder.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (also on your LAN)
npm run build      # type-check + production build in dist/
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

**Home** is the identity card (avatar, name, country, team, level progress, coins), the drawn
DETOUR wordmark and the way to play: a big Play button into mode select, then shortcuts —
vs Bot (starts with the saved difficulty) and Online as a badge rather than a button.

- **vs Bot** — Easy / Normal / Hard: how often the bot walls, how far it looks ahead and how much
  it wanders (`src/bot.ts`).
- **Online** — disabled, "Coming soon".
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

`themeParams` from Telegram decide the palette: `bg_color`, `text_color` and `hint_color` are handed
to CSS as `--tg-*`, and the light or dark token set in `src/style.css` fills in the rest. Outside a
client the SDK claims `colorScheme: "light"` even in a plain tab, so the app only trusts a declared
scheme when the platform says it is really Telegram and otherwise follows
`prefers-color-scheme`. Safe-area insets, `viewportStableHeight`, the BackButton and haptics are all
wired; every control is at least 44px and the page itself never scrolls (only sheet lists and the
profile pane do).

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

- **Move**: tap one of your balls, then one of the dots that light up beside it — the chosen ball wears a ring and only its legal cells are shown. The chips show each side's shortest path to FINISH in steps.
- **Teams on the board**: every side races 1 to 3 balls (up to 3v3) and alternates turns; on its turn a team moves any ONE of its balls one cell, or places a wall. Each side owns a colour family and its balls carry number badges, so a 3v3 stays readable. Balls — friendly or hostile — block, nothing jumps, and the first ball to the top row wins.
- **Walls are rationed: 8 per side.** Each team brings `WALL_LIMIT` walls to a race. The chip under the board counts them down — one glowing dash per wall in that side's colour, plus an icon and an `8/8` readout — dims every dash it spends, highlights the counter while the seat is to move, and refuses placement outright at `0/8`. A wall still only has to stay in bounds, not overlap another wall on the same line, and keep every ball's path to FINISH open.
- **Wall (touch)**: tap a grid line — a ghost wall appears — tap the ghost again to place it, or tap anywhere else to cancel. An illegal or unaffordable slot shows a red ghost, a warning buzz and the reason ("Blocks the path" / "Overlaps a wall" / "No walls left").
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
| `src/rules.ts` | Pure game logic: `GameState` (`teams`, `balls`, `walls`, `turn`, `winner`), `newGame(sizes)` for 1–3 balls per team, `reachable`, `wallOk` / `wallsLeft` (`WALL_LIMIT` = 8), `apply(state, action)` |
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
| `src/style.css` | Tokens, mesh background, frosted cards, board frame, menu shell, shop and profile |

## Going multiplayer later

`main.ts` talks to the opponent through one interface:

```ts
interface Opponent { think(s: GameState): Promise<Action> }
```

`makeBot(difficulty)` returns one today. Replace it with an implementation that sends your own
moves over a socket and resolves with the remote player's `Action`; the Online card is where it
plugs in. Everything goes through `apply(state, action)`, so the server can run the same
`rules.ts` to validate moves.

## Tweaking the look

- Colours plus the type and spacing scales: the `:root` token block at the top of `src/style.css`,
  and the `html.dark` block under it that restates the same names. Text uses the `*-ink` variants of
  the brand hues so every pair clears 4.5:1 on the card.
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
