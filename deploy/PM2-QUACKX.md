# Deploy QuackX (self-hosted kyto agent) on an existing pm2 box

QuackX is a fork of [kyto](https://github.com/Devansh-awat/kyto) (AGPL-3.0) —
a full agentic Slack bot. It is **not** the old node/@slack/bolt QuackX. Two
big differences that shape everything below:

1. **Runtime is Bun, not Node.** Install Bun on the box. pm2 runs it fine.
2. **It needs a database and a code sandbox**, not just Slack tokens.

Because it uses Socket Mode only, **no public URL / tunnel is required** — the
process opens its own outbound socket. That's the good news vs. the old QuackX.

## 1. What the box must have

| Thing | Why | Where to get it |
|---|---|---|
| Bun | Runtime (kyto is a Bun app) | https://bun.sh |
| PostgreSQL | Chat memory, reminders, dashboard state | `apt install postgresql` or a managed DB |
| A **new** Slack app | Bot identity (create from `slack-manifest.json`) | api.slack.com/apps |
| E2B key | The code sandbox (runs code/browser/sites) | https://e2b.dev |
| GROQ key | Primary model (llama-3.3-70b-versatile) | https://console.groq.com |
| Exa key | Web search tool | https://exa.ai |
| (optional) Gemini key | Lets the bot SEE images (GROQ is text-only); also fallback | Google AI Studio |
| (optional) HackClub proxy key | Fallback + image generation. **Not needed** if GROQ is primary and you skip images | ai.hackclub.com |

Required env vars that must be set (the process refuses to boot without them):
`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`, `DATABASE_URL`,
`E2B_API_KEY`, `EXA_API_KEY`, plus `GROQ_API_KEY` (starts requiring it once
`keys.ts` validates — it's optional in the fork, so GROQ can be off, but the
point of QuackX is GROQ, so set it).

## 2. The Slack app

- Create a NEW app (do NOT reuse the old QuackX app's tokens, and do NOT point
  this at production kyto's app — "never run a second copy against the same
  Slack app").
- Install from `slack-manifest.json` at the repo root (or paste it into
  api.slack.com → "Create New App" → "From an app manifest").
- Enable **Socket Mode**; copy the app-level token (`xapp-...`) → `SLACK_APP_TOKEN`.
- Install to the workspace; copy the bot token (`xoxb-...`) → `SLACK_BOT_TOKEN`.
- Copy the Signing Secret → `SLACK_SIGNING_SECRET`.

## 3. Env + database

```bash
cd /path/to/quackx/apps/bot
cp .env.example .env
# fill in all tokens above
cd /path/to/quackx
bun install
bun run db:push          # creates the Postgres schema
```

## 4. Run under pm2 (Bun interpreter)

```bash
cd /path/to/quackx/apps/bot
# pm2 runs Bun like it runs node
pm2 start --name quackx --interpreter bun -- src/index.ts
pm2 save                  # resurrect on reboot
pm2 logs quackx           # watch for "QuackX is running!" / errors
```

To update later:

```bash
cd /path/to/quackx && git pull && bun install && bun run db:push
pm2 restart quackx
```

## 5. Gotchas

- **Never run two processes on the same Slack app** — Socket Mode delivers each
  event to exactly one connection, so a stray second instance silently eats
  about half your mentions.
- **GROQ is text-only.** The bot can't see images or generate them from GROQ
  alone. Image recognition needs a Gemini key (`GEMINI_API_KEY`), and image
  generation needs either a Gemini key or the HackClub proxy. Without either,
  image tools just won't be available — the rest of the agent still works.
- This is a fork of AGPL-3.0 kyto and you're offering it as a network service,
  so you must offer users the modified source.
- The ownership/write gates at boot may ask for a `DASHBOARD_PASSWORD` (12+
  chars) and `BYOK_ENCRYPTION_KEY` (32+ chars) before certain features exist;
  both are optional (routes 404 / feature disabled when unset).
