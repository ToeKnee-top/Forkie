# Publishing the source

Kyto is licensed **AGPL-3.0** (owner's call, 2026-07-31 — it replaced the earlier
source-available/all-rights-reserved licence): see [`LICENSE`](../../LICENSE) for
the full text, [`NOTICE`](../../NOTICE) for the copyright and third-party
attributions, and [`LICENSE-gorkie-MIT`](../../LICENSE-gorkie-MIT) for the
gorkie-derived carve-out. AGPL is strong copyleft: run a modified Kyto as a
network service and you must offer users your modified source. This page records
the pre-publication audit and the things that constrain it, so the next person
deciding whether to make the repo public is not re-deriving it.

## The licence is not a clean slate

Kyto began as a fork of **gorkie**, which was MIT-licensed, and this repository
still contains gorkie's full history — the initial commit is gorkie's, and
`upstream` still points at `imdevarsh/gorkie-slack`.

MIT permits relicensing a derivative work under stricter terms, but it does **not**
let anyone withdraw the permissions already granted for the original code. So:

- Kyto's own code is AGPL-3.0 (`LICENSE`). AGPL can incorporate MIT code (MIT is
  permissive and GPL/AGPL-compatible), so the combined work ships under AGPL.
- Gorkie-derived code, and the pre-rewrite history, stays MIT (`LICENSE-gorkie-MIT`),
  and that notice must be retained — the MIT grant on that code cannot be
  withdrawn, so anyone may still extract those portions under MIT.
- A blanket "nobody may copy or use any of this" over the whole repository would
  be inaccurate while gorkie's code and history are present.

The current harness is a ground-up rewrite (the Vercel Chat SDK, the Pi framework
and `@ai-sdk/harness*` are all gone), and the surviving fraction has now been
**measured** (2026-07-26, `git blame` line-provenance: a line counts as
gorkie-derived iff the commit that last touched it is reachable from
`upstream/main`):

- **Runtime source is ~16% gorkie-derived**: 4,054 of 24,976 lines —
  3,279/20,076 in `apps/bot/src`, 775/4,900 across `packages/*/src`.
- **The whole tree is ~49%**: 21,178 of 42,983 tracked text lines, because
  scaffolding survives nearly wholesale — turbo/tsconfig/generator config,
  `.vscode`/`.zed`, `plans/rewrite.md`, `README.md`, `TESTING.md`, cspell
  tooling, `packages/logging`, the orphaned `packages/db` sandbox
  schema/queries.
- Files that are still substantially gorkie: `bot.ts` (101/113),
  `agent/reply.ts` (172/213), `agent/turns.ts` (49/49), the whole
  `lib/ai/stream/tasks/` directory, `features/assistant`, and several small
  tools (`get-user`, `get-channel-info`, `list-threads`, `mermaid`).

So the "may be near zero" hypothesis is **disproven**: the MIT carve-out is
load-bearing and `LICENSE-gorkie-MIT` must stay. (Blame attributes an
edited-in-place gorkie line to the kyto edit, so if anything this undercounts
derivation.) **This is not legal advice** — the structure above is the
conservative reading, and a lawyer should confirm it before relying on it
commercially.

Publishing to a public GitHub repo also makes the **whole history** public, not
just the tip. Squashing it away would be the only way to avoid that, and it would
also destroy the audit trail that makes "read the source" meaningful.

## Secrets audit

Checked before publication:

- **No `.env` was ever committed.** The only env files in history are
  `.env.example` (root, `apps/bot`, and the long-deleted `apps/server`).
- **No real credentials in the working tree or in history.** Scanned tracked files
  and every added/modified line across all branches for GitHub tokens (`ghp_`/
  `gho_`/`ghu_`/`ghs_`/`github_pat_`), OpenAI/Anthropic keys (`sk-`, `sk-ant-`),
  Slack tokens (`xoxb-`/`xoxp-`/`xapp-`), Google keys (`AIza…`) and E2B keys.
  Every hit was a placeholder (`sk-ant-api03-not-a-real-key-…`,
  `sk-hc-your-sandbox-hackclub-api-key`, `xoxb-paste-your-token-here`).
- **Database URLs in history are all examples** (`postgres://user:password@`,
  `postgresql://gorkie:gorkie@`, `…:your-strong-password@`). The live Postgres is
  localhost-only with no TLS, so its password is not reachable from outside the
  host anyway — but it is *not* one of the values in history, and should stay that
  way.
- **No real email addresses** in tracked files.
- The only Slack ids in tracked source are **kyto's own bot ids across
  deployments** (`packages/ai/src/prompts/slack.ts`, `.claude/CLAUDE.md`), which
  every member of the workspace can already see.

## Not secrets, but they do identify the deployment

Publishing reveals where and how kyto runs: the Oracle Linux host layout and
service user (`deploy/kyto.service`), the Postgres role name, the bot's app/user
ids, the `gorkie__devansh_` legacy handle, and the full list of env vars it reads
(`apps/bot/.env.example`). None of that is exploitable on its own, and all of it is
load-bearing documentation. Worth knowing it goes public, not worth removing.

## Third-party material

`.agents/skills/` vendors ten skills; `LICENSE` §5 disclaims any claim over the
third-party ones. Provenance is recorded: eight were installed by the `skills`
CLI and are pinned (source repo, path, content hash) in **`skills-lock.json`**;
the other two are first-party. Upstream licences as of 2026-07-26:

| skill | source | licence |
| --- | --- | --- |
| `ai-sdk` | `vercel/ai` | Apache-2.0 (GitHub's "Other" was wrong; redistribution wants the notice) |
| `chat-sdk` | `vercel/chat` | MIT |
| `grill-with-docs` | `mattpocock/skills` | MIT |
| `improve` | `shadcn/improve` | MIT (also stated in its frontmatter) |
| `slack-agent` | `vercel-labs/slack-agent-skill` | Apache-2.0 (redistribution wants the notice) |
| `turborepo` | `vercel/turborepo` | MIT |
| `ultracite` | `haydenbleasel/ultracite` | MIT |
| `coding-best-practices` | first-party (kyto-specific rules) | kyto's LICENSE |
| `refactor` | first-party (kyto-specific cleanup style) | kyto's LICENSE |

`thermo-nuclear-code-quality-review` (`cursor/plugins`) was **dropped**
(2026-07-29): its README claimed MIT but the repo carries no LICENSE file and
GitHub detected none, so the claim was unverifiable and redistributing it would
have meant shipping something with no grant behind it. It was a code-review
skill with nothing else depending on it, so dropping cost less than waiting on
an upstream clarification that might never come. Do not re-add it without a
LICENSE file upstream.

**A lock-file entry is attribution, not compliance.** MIT requires its copyright
notice be included *in all copies*, and Apache-2.0 §4 requires handing
recipients the licence text; a repo name and a content hash in
`skills-lock.json` is neither. **Done (2026-07-29)**: every third-party skill now
ships its upstream `LICENSE` beside its `SKILL.md`, fetched from the upstream
default branch. Neither Apache-2.0 skill (`ai-sdk`, `slack-agent`) has an
upstream `NOTICE`, so §4(d) does not apply. `coding-best-practices` and
`refactor` carry none because they are first-party and covered by kyto's own
`LICENSE`. **Any skill added later must bring its `LICENSE` with it.**

## The repo is public (2026-07-31)

Flipped from private to public on 2026-07-31 (owner's call), `github.com/Devansh-awat/kyto`, with every item below resolved. The whole history went public with it (see "The licence is not a clean slate"). The checklist that gated the flip is kept below as the record of what was cleared.

1. ~~Rotate `GH_TOKEN`~~ **Not a publication task — moved out of this list.** It
   was filed here as a "forcing function", which reads as though publishing
   might expose it. It cannot: no credential is in the working tree or in
   history, and Slack messages are not in the repo at all (no verbatim
   transcript is persisted; `thread_thinking`, `thread_summaries` and `memories`
   live in local Postgres). Rotate it if it was ever pasted into a thread, a
   journal line or an issue — that exposure exists today and is unaffected by
   the repo's visibility either way.
2. ~~Decide the gorkie-provenance question~~ **Measured (above): keep the MIT
   carve-out — ~16% of runtime source is still gorkie-derived.**
3. ~~Document `.agents/skills/`~~ ~~confirm-or-drop the two flagged skills~~
   **Both resolved (2026-07-29): `ai-sdk` is Apache-2.0 and stays;
   `thermo-nuclear-code-quality-review` was dropped.**
4. ~~Vendor each remaining upstream `LICENSE`~~ **Done (2026-07-29)** — see
   "Third-party material" above. No licence work is outstanding.
5. ~~Scrub the netic API key from history~~ **Not required — the key's owner
   consented (2026-07-29).** The rescan (24 commits since this audit) found no
   kyto credential anywhere, but it did find a **third party's** API key for
   `netic.hackclub.app` in `TODO.md`, intact in ~15 reachable commits from
   `f4d39d5` even though `b171084` removed it from the tip. Netic confirmed the
   key is already revoked and is fine being public, so no history rewrite is
   needed. **This was luck, not process**: a live third-party secret was one
   `b171084`-that-never-happened away from being published. Do not paste a
   credential — yours or anyone's — into a tracked file again; the working-tree
   scan would not have caught it.
6. ~~Update `packages/ai/src/prompts/slack.ts` in the same commit as the
   visibility flip~~ **Done (2026-07-31)** — the prompt now points users at
   `github.com/Devansh-awat/kyto` and states the AGPL network-service term.
