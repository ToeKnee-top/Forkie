# Development

Kyto runs as one long-lived process: `apps/bot`.

It talks to Slack through its own harness (`apps/bot/src/harness/`) built on
`@slack/socket-mode` + `@slack/web-api`. **Socket Mode is the only mode**, so
local development never needs a public tunnel. AI work runs through kyto's own
agent loop on the `ai` SDK (`packages/ai/src/agent.ts`), and each active Slack
thread gets a persistent E2B sandbox.

> The Vercel Chat SDK, the Pi framework, and `@ai-sdk/harness*` were removed in
> a ground-up rewrite. Anything describing them is stale.

## Prerequisites

- Bun
- PostgreSQL
- A Slack app created from `slack-manifest.json`, with `SLACK_APP_TOKEN` (Socket
  Mode) as well as the bot token
- An E2B API key
- At least one model provider key (`HACKCLUB_API_KEY`, and `GEMINI_API_KEY` for
  the fallback tier and subagents)

## Environment

```bash
cp apps/bot/.env.example apps/bot/.env
```

Fill in Slack, database, provider, E2B and Exa values. Two gates worth knowing:
`BYOK_ENCRYPTION_KEY` (min 32 chars) enables per-user model keys and Sign in
with ChatGPT — unset, neither exists. `DASHBOARD_PASSWORD` (min 12 chars)
mounts the owner dashboard — unset, the route 404s as if it were never there.

## Running Locally

```bash
bun install
bun run db:push
bun run dev:bot
```

**Never run a second copy against the same Slack app.** Each process opens its
own Socket Mode connection and Slack delivers each event to exactly ONE of them,
so a stray instance silently steals about half the mentions. If the deployed bot
is running, stop it before starting a local one.

Dev mode uses process-restart watch, not Bun hot reload: Socket Mode owns a
persistent WebSocket that must shut down cleanly between reloads.

## Database Changes

`drizzle-kit push` prompts interactively (it asks about renames) and hangs in a
non-TTY shell. Add new tables and columns with one-off SQL using
`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, and add
the matching Drizzle definition under `packages/db/src/schema/`. `bun run
db:push` works fine for a human at a terminal.

Note `authorization` is a reserved word — quote it in DDL.

## Sandbox Template

Rebuild when sandbox packages or CLI dependencies change:

```bash
bun run build:template
```

The template installs Node, Python packages, `agent-browser`, and browser
dependencies.

## Slack Manifest

Scopes are declared in `slack-manifest.json`. After changing it:

```bash
bun --filter=bot run sync:manifest
```

This needs a Slack **app configuration token** (`SLACK_APP_ID`,
`SLACK_CONFIG_ACCESS_TOKEN`), not the bot token. **Scope changes still require
reinstalling the app.**

## Checks

```bash
bun run typecheck
bun run check
bun test
bun run check:spelling
```

`bun run check:write` autofixes formatting and most lint findings.

## Deployment Notes

`apps/bot` is a long-lived process on a persistent host, run under systemd
(`deploy/kyto.service`, `Restart=always`). Configure the same variables as
`apps/bot/.env.example` in the host environment.

```bash
systemctl restart kyto.service
journalctl -u kyto.service -f -o cat     # look for "kyto (…) is online"
```

If `deploy/kyto.service` changed, `systemctl daemon-reload` first.

Postgres on the deploy host is local with no TLS, so `packages/db/src/client.ts`
uses `ssl: false`.

### When kyto stops responding

- **Slash commands work but @mentions and DMs don't**: the Event Subscriptions
  master toggle is off. Socket Mode routes commands, interactivity and events
  independently, so `slash_commands` keep arriving while events deliver nothing.
- **Everything is intermittent**: check for a second process. The `hello` frame's
  `num_connections` should be 1.
- **Silent but running**: a dropped WSS can stay TCP-established with a stuck
  send queue (`ss -tnp | grep :443`, non-zero Send-Q) while delivering nothing.
  A restart re-establishes it.
