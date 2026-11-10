# Forkie Web Chat — the handoff

The Forkie website (`index.html` / `app.js` / `styles.css` at the repo root,
served from GitHub Pages) is a frontend for **the same agent that runs this
bot**. By default it talks to a free public model so it works out of the box;
connect it to your own backend and it uses the exact same brain as Slack.

## How it works

`apps/bot/src/lib/webchat/server.ts` runs a tiny HTTP server (default port
`8787`) that exposes:

- `GET /health` → `{ "ok": true }`
- `POST /api/chat` → server-sent-events stream (`delta` / `done` / `error`
  events). Body: `{ "messages": [{ "role": "user", "content": "..." }] }`

Every chat call reuses the Slack agent's own pipeline from `@repo/ai`:

- the **same model attempts** — `PRIMARY_ATTEMPT` then `LEADERBOARD_FALLBACK`
  (same HackClub proxy key, same Gemini fallback, same quota);
- the **same core + personality prompts** — it *is* Forkie, not a lookalike.

## One-command handoff

1. In `apps/bot/.env` (copy from `.env.example` if you haven't), set:

   ```env
   WEB_CHAT_ENABLED="true"
   WEB_CHAT_PORT=8787
   WEB_CHAT_SECRET="<openssl rand -hex 16>"
   ```

   `WEB_CHAT_SECRET` is optional but recommended — it stops random visitors
   burning your model quota. The site keeps it in your browser's localStorage,
   so it never needs to live in the repo.

2. Start the bot as usual:

   ```sh
   bun install
   bun run start:bot
   ```

3. Open the website (GitHub Pages or anywhere it's hosted), click the **gear
   icon** in the sidebar, enter your backend URL
   (`https://<host-where-the-bot-runs>:8787`) and the secret, and save.

The dot in the top bar turns green when the site is talking to your backend.
If the backend is unreachable, the chat silently falls back to public mode.

## Notes / honest limits

- Same model, same keys, same persona — but Slack-specific tools (posting to a
  thread, reacting, reading Slack history) are intentionally not wired into the
  web endpoint, because they don't map to a browser chat. Web-appropriate tools
  (search, sandboxed code, images) plug into the `tools` set passed to
  `streamAttempt` in `apps/bot/src/lib/webchat/server.ts` when you want them.
- The site files live on `main` and GitHub Pages serves them. The webchat
  server is part of the bot process, so it shares the bot's environment and
  keys — never expose `WEB_CHAT_SECRET` in the frontend repo.
