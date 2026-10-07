# Finish Race — Telegram Mini App (frontend only)

Vite + TypeScript + Canvas 2D. No backend: the opponent is a local bot.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (also on your LAN)
npm run build      # type-check + production build in dist/
```

Works in a normal browser too (the Telegram SDK is optional). On desktop, hover near a grid line to preview a wall.

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
| `src/bot.ts` | Local opponent (shortest path + occasional blocking wall) |
| `src/render.ts` | Canvas drawing (board, walls, balls) and `pick()` hit-testing |
| `src/main.ts` | Telegram init, input, animation loop, status UI |
| `src/style.css` | Card frame, header/footer, status, button |

## Going multiplayer later

`main.ts` talks to the opponent through one interface:

```ts
interface Opponent { think(s: GameState): Promise<Action> }
```

Replace `localBot` with an implementation that sends your own moves over a socket and resolves with the remote player's `Action`. Everything goes through `apply(state, action)`, so the server can run the same `rules.ts` to validate moves.

## Tweaking the look

- Ball and wall colours: `PAL` at the top of `src/render.ts`.
- Card, header, footer, status: `src/style.css`.
