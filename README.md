# Finish Race — Telegram Mini App (frontend only)

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

`Home → Game mode → Race`, with `Shop`, `Profile` and `Settings` on the bottom tab bar.
Navigation is a hand-rolled back stack (`src/router.ts`): slides use transform/opacity only and
swap instantly under `prefers-reduced-motion`. The Telegram `BackButton` is wired when the client
provides one; every screen also has a visible Back button, and the race screen's top-left menu
button opens the same pause sheet.

- **vs Bot** — Easy / Normal / Hard: how often the bot walls, how far it looks ahead and how much
  it wanders (`src/bot.ts`).
- **Pass & Play** — two humans on one device. Both seats are local, the turn label flips each move
  and no opponent is ever asked.
- **Online** — disabled, "Coming soon".
- **Shop** — Balls / Walls / Boards. Every card carries a live miniature board painted by the race
  renderer itself, so a preview cannot disagree with the game. Buying spends coins, takes ownership
  and puts the item on in one tap.
- **Profile** — games, wins, losses, best run, coins, win streak, favourite mode, and the three
  equipped items as live previews.

## Cosmetics

`src/themes.ts` holds every colour the app can draw: ball skins (palette + gradient stops + halo),
wall styles (thickness, bloom, highlight, rim) and board themes (surface, grid, ring, checkers,
finish glow). Defaults are the Classic ball, Classic wall and Lavender board — the look the app
shipped with.

**The opponent is never themed.** Their ball and walls stay on the built-in blue ramp, and a skin's
ramp is pushed out of that blue before anything reads it (`separate()`), so no item — however it is
authored later — can make the two sides look alike.

## Controls

- **Move**: tap a highlighted dot. The chips show each side's shortest path to FINISH in steps.
- **Walls are unlimited.** Each side may wall every turn; a wall only has to stay in bounds, not overlap another wall on the same line, and keep both pawns' path to FINISH open.
- **Wall (touch)**: tap a grid line — a ghost wall appears — tap the ghost again to place it, or tap anywhere else to cancel. An illegal slot shows a red ghost, a warning buzz and the reason ("Blocks the path" / "Overlaps a wall").
- **Wall (mouse)**: hover a grid line to preview, click once to place.
- **Pause**: the menu button (or the Telegram BackButton) opens Resume / Restart / Quit to menu, with a confirm before quitting. The end-of-game panel offers Play again and Menu.

## Coins

Every finished race pays: a win pays most, a loss still pays something, and a sharper bot pays more
(`payout` in `src/storage.ts`). The amount is shown on the game-over panel and lands in the balance
on Home and in the Shop. Coins are mock — nothing here touches a payment provider.

## What is stored

One module owns persistence: `src/storage.ts`, with a versioned schema (`v: 1`) covering coins,
owned items, equipped items and the record. `src/settings.ts` keeps the switches and the last
chosen mode/difficulty. Both go through the same wrapped door, so a webview that refuses
`localStorage` (private mode, cookies off) still plays; the app then just runs on defaults.

Swapping in Telegram CloudStorage means replacing the `backend` pair with an async get/set and
handing the fetched JSON to `hydrate()` — no screen or module reads storage directly.

Game state is still never stored: leaving a race mid-way abandons it.

## Open it as a Telegram Mini App

Telegram only loads **HTTPS** URLs.

1. Get a public HTTPS URL:
   - Quick test: `npx cloudflared tunnel --url http://localhost:5173` (or `ngrok http 5173`), or
   - Deploy `dist/` to any static host (Netlify, Vercel, Cloudflare Pages, GitHub Pages).
2. In Telegram, open [@BotFather](https://t.me/BotFather) → `/newapp`.
3. Pick your bot, then send: title, description, a 640×360 photo, (optional GIF, `/empty` to skip), and your **HTTPS URL**, then a short name.
4. BotFather replies with a link like `https://t.me/<bot>/<short_name>`. Open it to play.
   - Alternative: `/mybots` → your bot → Bot Settings → Menu Button → set the URL.

## Code map

| File | Role |
| --- | --- |
| `src/rules.ts` | Pure game logic: `GameState`, `doMove`, `doWall`, `reachable`, `wallOk`, `apply(state, action)` |
| `src/bot.ts` | Local opponent (shortest path; walls only when it is level or behind and the wall costs 2+ steps) plus the Easy/Normal/Hard profiles |
| `src/themes.ts` | Every cosmetic as data: ball skins, wall styles, board themes, the fixed bot ramp and the red/blue guarantee |
| `src/render.ts` | Canvas drawing (board, walls, ghosts, balls) from a `Theme`, `hitTest()` tap-target resolution, and `createPreview()` for the shop's miniature boards |
| `src/confetti.ts` | Win burst: a fixed particle pool on its own canvas, no per-frame allocation |
| `src/router.ts` | Screen stack + slide/fade transitions, back handling |
| `src/sheets.ts` | Bottom sheets over a dimming scrim (pause, quit confirm, buy confirm, how to play) |
| `src/storage.ts` | The save: versioned schema, the wrapped storage door, coins/owned/equipped/record and the per-race payout |
| `src/settings.ts` | The switches and the last mode/difficulty, on top of `storage.ts`; `motionReduced()` for CSS and canvas |
| `src/telegram.ts` | Optional Telegram init: viewport, haptics, BackButton |
| `src/menu.ts` | Home, mode select, settings, the profile card and the tab bar — it only asks `main.ts` to start a race |
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

- Colours plus the type and spacing scales: the `:root` token block at the top of `src/style.css`.
  Text uses the `*-ink` variants of the brand hues so every pair clears 4.5:1 on the card.
- Menu shell (hero balls, mode cards, shop cards, tabs, sheets): the `SHELL` block further down the same file.
- Ball, wall and board looks, and the prices: the catalog arrays in `src/themes.ts`.
- How a theme is painted (specular shape, bar highlight, finish glow): `drawBall`, `drawBar` and
  `buildStatic` in `src/render.ts`.
- Board geometry (cell margin, wall thickness): `computeLayout` and `drawBar` in `src/render.ts`.
