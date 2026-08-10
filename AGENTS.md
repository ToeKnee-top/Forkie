# Kyto

Forkie is an AI assistant for Slack, forked from Kyto. The codebase is a
Bun/TypeScript monorepo on Bun + TypeScript, the `ai` SDK, Drizzle/Postgres,
Turborepo, and Ultracite.

**The Vercel Chat SDK, the Pi framework, and `@ai-sdk/harness*` were removed in
a ground-up rewrite. Nothing in this repo runs on them.** If a doc, comment, or
plan still refers to `HarnessAgent`, "Pi attempts", or Chat SDK adapters, it is
stale — believe the source.

## Mental Model

Every Slack turn runs kyto's own agent loop on the `ai` SDK's `streamText`
(`packages/ai/src/agent.ts` + `apps/bot/src/lib/agent/`): a multi-step tool loop
against one OpenAI-compatible endpoint at a time, with a fallback chain across
providers when an attempt fails.

Slack is reached through kyto's own harness (`apps/bot/src/harness/`) —
`@slack/socket-mode` + `@slack/web-api` directly. Socket Mode is the only mode.

The loop runs on the bot host, never in the sandbox. Model keys, BYOK secrets,
MCP credentials, prompt assembly, Slack tools, and the agent loop all live on the
host. Each Slack THREAD gets its own persistent remote Linux sandbox over SSH —
the owner's Nest box at `toeknee@hacklub.app` — for the `bash`/file tools,
created lazily on the first tool call that needs it.

Memory is the Slack thread itself: `buildPrompt` replays it. No transcript is
persisted. Three kinds of DERIVED text are (`thread_thinking`,
`thread_summaries`, `memories`).

## When Unsure

- Read source before guessing.
- **`.claude/CLAUDE.md` is the real architecture reference**, and it is loaded
  automatically. Deeper detail lives in `.claude/MODELS.md` (routing, fallback,
  BYOK, ChatGPT OAuth) and `.claude/TOOLS.md` (per-tool behaviour), neither of
  which is loaded automatically — read the relevant one before touching that
  area, and update it in the same change.
- Use the relevant skills when a task touches their area: `ai-sdk`, `ultracite`.
- Docs and architecture: start in `docs/index.md`.
- Open items: `TODO.md`. Check it when touching a related file.

## Where Things Belong

- `apps/bot`: the Slack harness, event routing, the agent loop, Slack features,
  tools, and the owner dashboard.
- `packages/ai`: platform-neutral attempt construction, the `streamText` call
  and its per-provider fetch tuning, prompts, and provider rosters.
- `packages/sandbox`: SSH sandbox provider (Nest host), lazy/persistent session, template.
- `packages/db`: Drizzle schema, Postgres client, and app-owned queries.
- `docs`: Markdown architecture docs for humans and agents.

## Boundaries

- Never: put Slack-only behavior in `packages/ai`.
- Never: put model keys or Slack tokens in the sandbox. The bot token reaches
  Slack from the sandbox only through the host-side READ-ONLY proxy.
- Never: let sandboxed code invoke a mutating tool. Outward-facing sends stay
  behind a human confirm click or the approval gate.
- Never: add one-use constants, wrappers, helpers, or re-export-only files.
- Never: commit secrets or tracked throwaway scripts.
- Ask first: dependency changes, broad schema changes, destructive git
  operations, or anything that changes deployment shape.

The full set of security invariants — and why each one exists — is in
`.claude/CLAUDE.md`. Do not regress one because it looks like dead weight.

## Coding Rules

- Inline over extract: no one-shot helpers.
- Dict params: functions with more than one parameter take a single options
  object.
- Small functions: prefer early returns over nesting.
- No type casts to silence TypeScript: parse or validate with Zod at boundaries.
- Comment only a non-obvious why — especially the failure a piece of code exists
  to prevent.
- The pure halves of the agent loop live in their own modules WITH TESTS
  (`lib/agent/routing.ts`, `segmentation.ts`, `carryover.ts`,
  `compaction-plan.ts`, `thinking-render.ts`). Do not inline one back.
- Feature-enclosed: Slack features live under `apps/bot/src/features/<name>/`.

## Validation

Before handoff after code changes:

1. `bun run typecheck`
2. `bun run check` (`bun run check:write` to autofix)
3. `bun test`
4. `bun run check:spelling`, and `bun run check:knip` for cleanup or
   package-export work

New tables and columns are pushed with one-off `ALTER TABLE … ADD COLUMN IF NOT
EXISTS` / `CREATE TABLE IF NOT EXISTS` SQL: `drizzle-kit push` prompts
interactively and hangs in a non-TTY shell.
