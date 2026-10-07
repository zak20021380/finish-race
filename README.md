# Finish Race — Telegram Mini App (frontend only)

Vite + TypeScript + Canvas 2D. No backend: the opponent is a local bot, and the menu carries
placeholder Shop / Profile / Online screens until there is something behind them.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (also on your LAN)
npm run build      # type-check + production build in dist/
```

Works in a normal browser too (the Telegram SDK is optional).

## Screens

`Home → Game mode → Race`, with `Settings`, `Shop` and `Profile` on the bottom tab bar.
Navigation is a hand-rolled back stack (`src/router.ts`): slides use transform/opacity only and
swap instantly under `prefers-reduced-motion`. The Telegram `BackButton` is wired when the client
provides one; every screen also has a visible Back button, and the race screen's top-left menu
button opens the same pause sheet.

- **vs Bot** — Easy / Normal / Hard: how often the bot walls, how far it looks ahead and how much
  it wanders (`src/bot.ts`).
- **Pass & Play** — two humans on one device. Both seats are local, the turn label flips each move
  and no opponent is ever asked.
- **Online** — disabled, "Coming soon".

## Controls

- **Move**: tap a highlighted dot. The chips show each side's shortest path to FINISH in steps.
- **Walls are unlimited.** Each side may wall every turn; a wall only has to stay in bounds, not overlap another wall on the same line, and keep both pawns' path to FINISH open.
- **Wall (touch)**: tap a grid line — a ghost wall appears — tap the ghost again to place it, or tap anywhere else to cancel. An illegal slot shows a red ghost, a warning buzz and the reason ("Blocks the path" / "Overlaps a wall").
- **Wall (mouse)**: hover a grid line to preview, click once to place.
- **Pause**: the menu button (or the Telegram BackButton) opens Resume / Restart / Quit to menu, with a confirm before quitting. The end-of-game panel offers Play again and Menu.

## What is stored

Only the Settings switches (sound, haptics, reduced motion) and the last chosen mode/difficulty,
through `src/settings.ts` in `try/catch` — the app runs with storage blocked. Game state, streaks
and coins live in memory for the page load.

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
| `src/render.ts` | Canvas drawing (board, walls, ghosts, balls) and `hitTest()` tap-target resolution |
| `src/confetti.ts` | Win burst: a fixed particle pool on its own canvas, no per-frame allocation |
| `src/router.ts` | Screen stack + slide/fade transitions, back handling |
| `src/sheets.ts` | Bottom sheets over a dimming scrim (pause, quit confirm, how to play) |
| `src/settings.ts` | The only storage door: settings + last mode, `motionReduced()` for CSS and canvas |
| `src/telegram.ts` | Optional Telegram init: viewport, haptics, BackButton |
| `src/menu.ts` | Home, mode select, settings, placeholders, tab bar — it only asks `main.ts` to start a race |
| `src/main.ts` | Game wiring: input (tap-to-arm / confirm, mouse hover + click), loop, chips, status, overlay, pause |
| `src/style.css` | Tokens, mesh background, frosted cards, board frame, menu shell |

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
- Menu shell (hero balls, mode cards, tabs, sheets): the `SHELL` block further down the same file.
- Ball and wall colours: `PALS` at the top of `src/render.ts`.
- Board geometry (cell margin, wall thickness): `computeLayout` and `drawBar` in `src/render.ts`.
