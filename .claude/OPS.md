# Operations

> Split out of `.claude/CLAUDE.md` to keep that file under its 40k character
> budget. **Keep this current the same way** — if you change how kyto is
> deployed, synced, debugged, or migrated, update it in the same change.

## Manifest sync

`bun run sync:manifest` (apps/bot) pushes `slack-manifest.json` via `apps.manifest.update`. Needs a Slack **app configuration token**, not the bot/user token: `SLACK_APP_ID`, `SLACK_CONFIG_ACCESS_TOKEN`, optional `SLACK_CONFIG_REFRESH_TOKEN`. Scopes live in `slack-manifest.json` — update it when a tool needs a new one; scope changes require reinstalling the app.

## Host / deployment

- **Runs on the `oracle` server** (Oracle Linux 9, aarch64), migrated from `nest` after that account was suspended for an AUP violation (unrelated to kyto). Postgres is **local with no TLS**, so `packages/db/src/client.ts` uses `ssl: false` — keep it `false` while oracle is the target.
- **`gh` is NOT in the Oracle Linux repos**; install it from GitHub's official RPM repo, or authenticate git pushes with a PAT credential instead.

## Debugging "kyto isn't responding"

- Runs under **systemd** (`kyto.service`, unit at `deploy/kyto.service`, `Restart=always`). `journalctl -u kyto.service -f -o cat`. Two unrelated Slack apps also run here (`slackbot.service`, `hackclub-ai-status-bot.service`) — different tokens, no interference.
- **Never hand-launch a second copy.** Each process opens its own Socket Mode connection and Slack delivers each event to only ONE, so a stray instance silently steals ~half the mentions. Diagnose with the `hello` frame's `num_connections` (throwaway socket via `apps.connections.open`) — should be **1**.
- **Slash commands work but @mentions/DMs don't = Event Subscriptions are off.** Socket Mode routes slash commands, interactivity, and events independently; if the **Enable Events** master toggle is off (it silently turned off once), `slash_commands` still deliver while events deliver nothing. Re-enable it.
- **Zombie socket**: a dropped WSS can stay TCP-`ESTAB` with a stuck send-queue (`ss -tnp | grep :443` shows non-zero Send-Q) while delivering nothing. Restart fixes it.

## Branches

**`main` is the branch actually deployed** (`kyto.service` tracks what's checked out here). `rebuild-on-upstream` is a dead Pi-era branch — `main` is a strict superset (audited 2026-07-09), except its `MAX_RECURRING_RUNS = 20` auto-cancel, deliberately NOT ported (it would silently kill existing "forever" reminders).

## Database notes

New tables/columns are pushed with one-off SQL — `drizzle-kit push` prompts interactively (a rename decision) and hangs in a non-TTY shell. Use `ALTER TABLE … ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`; `db:generate`/`db:push` work for a human at the CLI. `authorization` is reserved — quote it in DDL. `sandbox_sessions` is **orphaned scaffolding**; `thread_sandboxes` is live.
