# Harness assessment — kyto vs the coding agents

> Written 2026-07-26 (Claude, at the owner's request), comparing kyto's agent
> harness with OpenCode (MIT), OpenAI Codex CLI (Apache-2.0), and Claude Code
> (proprietary). Graded on harness machinery only — loop mechanics, streaming,
> tools, context, recovery — not the trust/security model. Snapshot of a moving
> target: the three comparators ship weekly; re-check before citing specifics.

## Where kyto's harness is ahead

- **Failure resilience — best-in-class.** No other agent does cross-model
  mid-task handoff. Kyto detects mid-stream provider death (error part +
  non-`stop` finish), stalls (re-armed idle watchdog), token loops (repetition
  guard trips before anything reaches Slack), and truncated tool-call JSON
  (repaired, not fatal), then hands the SAME task to the next model with
  continuation context + tool-result carryover. Claude Code waits out an
  Anthropic outage; Codex retries and gives up. Born of unreliable free tiers,
  but the engineering transfers.
- **Streaming UX for a chat surface.** Segmented plan blocks (narrate between
  tool stretches), unique per-step reasoning ids, proactive stream-card
  rotation before Slack's ~5-min expiry, hallucinated-tool hiding, markdown
  healing across chunk cuts and table splits. Problems the TUIs never meet.
- **Context economy.** `loadTools`/`activeTools` keeps ~40 deferred tool
  schemas out of every prompt (Claude Code's ToolSearch is the analogue;
  OpenCode/Codex mostly ship full toolsets every request).
- **Code Mode.** One sandboxed TypeScript program instead of N model
  round-trips. None of the three have a direct equivalent (Claude Code's
  Workflow is the nearest cousin).
- **Persistent per-thread sandbox.** Lazy create, pause/resume, scheduled jobs
  reattaching to the same filesystem days later. Codex cloud tasks are
  comparable but don't persist per-conversation.

## Where kyto's harness is behind

- ~~**Precision editing (biggest gap).**~~ **Closed 2026-07-27.** `editFile`
  demands an exact, unique match and fails loudly, naming which of the usual
  causes a miss was; and both `writeFile` and `editFile` now run a post-edit
  check (per-file parse, plus project `tsc --noEmit` for TS/JS) whose errors
  come back in the tool result, so the model sees what it broke without
  thinking to look. See `.claude/TOOLS.md`. Still short of Codex's
  `apply_patch` diff contract and of a real LSP.
- ~~**No compaction.**~~ **Closed 2026-07-27.** Overflow past the replay cap
  is folded into a running per-thread summary (`thread_summaries`) injected
  as `<earlier_in_this_thread>`, incrementally and on the cheap subagent
  key. The block always states how many messages it stands in for, even when
  summarizing failed, so the model is never silently handed the tail of a
  conversation as if it were the whole thing. Still bounded: past
  `MAX_COMPACTION_MESSAGES` the very oldest messages are not fetched at all.
- **Blunt loop control.** `MAX_STEPS=1000` means the real governor is the
  watchdog + degenerate guard. No plan/approve checkpoint, no budget-aware
  pacing, no steering a runaway-but-productive loop short of interrupting.
- **Shallow orchestration.** One subagent level, sequential by default. The
  ChunkRelay visualization is lovely; the orchestration behind it is thin
  next to Claude Code's Task/Workflow layer.
- **The openai-compatible abstraction taxes everything.** Riding the `ai`
  SDK's lowest-common-denominator path costs provider-native features and
  breeds the hack collection (thought_signature tee, `top_p` pinning,
  `store:false` double-force, cache-control body rewriting). Each is correct;
  together they mean the abstraction is fighting us.
- ~~**Test coverage.**~~ **Largely closed 2026-07-27.** The fallback walk,
  stream segmentation, carryover and compaction decisions were pulled out of
  the agent loop into pure modules (`lib/agent/routing|segmentation|carryover|
  compaction-plan`) and now have tests, as do the post-edit checkers. What is
  still untested is the IO around them — the Slack stream, the relay race, the
  attempt lifecycle itself.

## Net

As a CONVERSATION-surface harness (streaming, rendering, multi-model
survival, tool economy) kyto is better than anything comparable. As a
WORK-execution harness (editing precision, compaction, loop steering,
orchestration, verification) it is a tier below all three coding agents.

## Highest-leverage upgrades, in order

All three of the original items were done on 2026-07-27 (exact-match edit +
post-edit diagnostics, thread compaction, tests over the crown jewels). What
the assessment identified and nobody has touched yet:

1. **Loop control** — a plan/approve checkpoint and budget-aware pacing, so
   `MAX_STEPS=1000` is not the only governor besides the watchdog.
2. **Orchestration depth** — more than one subagent level, and parallelism
   that is not opt-in per call.
3. **Provider-native paths** — the openai-compatible abstraction is now
   carrying four separate workarounds; each is correct and together they mean
   it is fighting us.
