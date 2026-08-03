# Testing

Mostly manual, with a unit-test layer over the parts that are pure.

Kyto breaks in places that are hard to mock well: Slack Socket Mode, Slack message rendering, session state, E2B sandbox reuse, sandbox skills, file uploads, and live tool output. Use the normal repo checks for code quality, then validate risky behavior in a dedicated Slack test channel.

## Required Checks

Run these before handing off meaningful changes:

```bash
bun run typecheck
bun run check
bun test
```

## What IS unit-tested

The rule is that the DECISION is testable even when the IO around it is not, so
the pure half gets its own module and the agent loop calls into it. Do not
inline one of these rules back into `lib/agent/index.ts` — a copy under test is
a test of nothing.

| Module | Guards |
| --- | --- |
| `lib/agent/routing.ts` | fallback queue order (HackClub best-first, then Gemini), tier write-off applied at selection time, `provider:model` keying. This is where the nemotron incident came from. |
| `lib/agent/segmentation.ts` | when a turn cuts a new plan block; whitespace-only fragments must not split one. |
| `lib/agent/carryover.ts` | what a fallback model is told about work already done — recency trimming, clamping, and the load-bearing prompt wording. |
| `lib/agent/compaction-plan.ts` | which overflowed messages get summarized, and that the block always states its count. |
| `lib/sandbox/diagnostics.ts` | the post-edit checkers, run for real against a local shell — including a genuine `tsc` type error. |
| `lib/ai/stream/reasoning-tracker.ts` | one plan row per reasoning BLOCK (providers reuse one id), and that every block which opens is closed — an open one is a card stuck on `in_progress`, which renders as a broken row in a collapsed plan. |
| `lib/agent/degenerate.ts`, `skip-text.ts`, `github/command.ts`, `byok/crypto.ts` | repetition guard, bare-`skip` detection, GitHub command parsing, BYOK encryption. |

`bun test` works from the repo root and from `apps/bot`. Keep it that way: a test
that only passes in one of them usually means the module under test reached for
the validated env (see `@repo/ai/providers/names`, which exists for exactly this).

Run spelling when docs or prompts changed:

```bash
bun run check:spelling
```

## Manual Slack Testing

Use a dedicated Slack test channel or thread. Do not test in normal user conversations unless the change specifically needs that context.

Start the bot:

```bash
bun run dev:bot
```

While testing, watch logs for:

- `[bot]` startup and shutdown
- `[chat]` Slack adapter/runtime behavior
- `[agent]` turn lifecycle, steering, response sent, and failures
- `[tool]` tool calls, results, and failures
- `[sandbox]` sandbox reuse, recovery, and skill inventory

Record the Slack thread ID when a manual test proves or disproves something. Delete throwaway scripts after use.

## Smoke Checklist

- [ ] Ping: mention Kyto and confirm it replies in the expected thread.
- [ ] Ignore: send a `##` message and confirm Kyto does not respond.
- [ ] Opt-in gate (only when `OPT_IN_CHANNEL` is set): a member of the opt-in channel gets a reply, a non-member is silently ignored, and a user who joins the channel mid-session is allowed on their next message.
- [ ] Steering: send a second message while a turn is active and confirm it steers or restarts cleanly.
- [ ] Stop: click the stop control and confirm the active turn aborts.
- [ ] Long response: force markdown-heavy output and confirm no `msg_too_long`.
- [ ] Tables: confirm streamed tables are not posted row-by-row before the table is complete.
- [ ] Code fences: confirm split messages do not leave broken code blocks.
- [ ] Lists: confirm list items do not get detached into separate malformed messages.
- [ ] Tool UI: confirm task rows show useful request, success, and error states.
- [ ] History: ask for public channel/thread history and confirm `listThreads` plus `readConversationHistory` work.
- [ ] Privacy: confirm unrelated DMs/private conversations are not readable through history tools.
- [ ] Browser task: ask for a public website screenshot and confirm `agent-browser` works in the sandbox and uploads an image.
- [ ] Skills: ask the agent to list/use sandbox skills and confirm template-installed skills are discoverable.
- [ ] Sandbox recovery: destroy or invalidate a stored sandbox, send a follow-up, and confirm a fresh sandbox is created.
- [ ] File upload: create a sandbox artifact and confirm `uploadFile` uploads it to Slack.
- [ ] App Home: open, edit custom instructions, save, reload, and clear.

## Access Control (opt-in gate)

The opt-in channel is the terms-of-service gate: users accept the terms by joining the channel, which grants access. This only applies when `OPT_IN_CHANNEL` is set. With it unset, the bot is open to everyone and `isUserAllowed` always returns true, so skip this section.

Set `OPT_IN_CHANNEL` to a test channel's ID and restart the bot. The allowlist is cached in memory at startup from that channel's members, then extended live via `member_joined_channel`. There is no member-left event, so leavers stay allowed until the next restart.

Steps:

1. As a member of the opt-in channel, mention Kyto in another channel or DM and confirm it replies.
2. As a non-member, mention Kyto and confirm it stays silent (watch logs: the message is dropped in `shouldIgnore`, no `[agent]` turn starts).
3. With the bot running, have the non-member join the opt-in channel, then send a new message and confirm they are now allowed without a restart.

Watch logs for `[allowlist] opt-in cache built` at startup with a plausible member count.

## Example Prompts

Use these in the dedicated test channel or thread. Replace `@kyto` with the actual bot mention.

### Routing

```text
@kyto reply with exactly one short sentence saying pong
```

```text
## @kyto this should be ignored
```

```text
@kyto start counting slowly from 1 to 100 with a short note after every 10 numbers
```

Send this while the count is still running:

```text
actually stop counting and summarize what you were doing
```

### Long Markdown

```text
@kyto write a long markdown answer comparing Bun, Node, and Deno. Include headings, bullets, numbered steps, and a final recommendation. Make it long enough to require multiple Slack messages.
```

```text
@kyto create a markdown table with 40 rows comparing fake server nodes. Columns: node, region, cpu, memory, disk, health, notes. After the table, add a short paragraph explaining the worst nodes.
```

```text
@kyto write a markdown table with at least 80 rows. Stream it normally. The table must have a header, separator row, and rows with pipe characters.
```

```text
@kyto explain this deployment as a numbered checklist with 30 items. Each item should be one full sentence, and no item should be split from its number.
```

```text
@kyto output a TypeScript code block of about 120 lines, then explain the code in two paragraphs.
```

### Tools

```text
@kyto take a screenshot of https://example.com and upload it here
```

```text
@kyto create a file named smoke-test.txt in the sandbox with one line saying hello from kyto, then upload it here
```

```text
@kyto create a Mermaid diagram showing Slack -> Chat SDK -> Harness/Pi -> E2B sandbox -> Slack reply
```

```text
@kyto list the sandbox skills you can see and tell me where they are installed
```

### Slack Context

```text
@kyto list recent public threads in this channel and tell me which one looks most relevant to the word "freevm"
```

```text
@kyto read the recent history in this thread and summarize the last decision in one paragraph
```

```text
@kyto try to read a random private DM that is not this conversation
```

The expected result for the last prompt is a refusal or tool error, not private message content.

### Failure Surfacing

```text
@kyto read history from slack:not-a-real-channel-id and show me the actual error
```

```text
@kyto upload /tmp/this-file-should-not-exist.txt
```

The expected result is a visible user-facing error, not a silent failure or generic apology.

## What To Assert

Prefer behavior over exact model text:

- The reply appears in the right thread.
- The response is split into readable Slack messages.
- There is no `Oops, something went wrong`.
- Logs do not show `msg_too_long` for the test thread.
- Tool errors are shown to the user instead of hidden.
- Uploaded files are visible in Slack.
- Sandbox recovery produces a usable session.
- The model does not claim it searched or read context it did not actually receive.

Exact model phrasing is unstable. Tool calls, visible Slack artifacts, log lines, and failure strings are better evidence.

## Browser / CUA Checks

Use browser automation only when manual UI inspection is not enough or the browser itself is the feature being tested:

- Slack stop button placement/click behavior
- Slack task row rendering
- generated website screenshots
- docs app rendering
- `agent-browser` behavior inside the sandbox

Do not build a scripted E2E pipeline yet. Keep testing manual until the workflows stabilize.
