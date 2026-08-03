# Kyto TODO

## When something is done, remove it from here
## how this works: i put my ideas, problems, etc here, then every 2 or so days i ask claude(you) to fix it. I also leave notes between the stuff you put here. 

### Open

**Move the GitHub write gate to the HTTP layer** — owner's call, 2026-07-29
("yeah move gaurd to http layer"), and it was never recorded or built. The
trigger was the owner's own question: "if you get a shell into kyto, you can use
its gh and do stuff right? … remote shell are not easy to stop, you block sshx
one will use tmate". He is right, and the token being unextractable does not
help: the E2B egress rule staples `Authorization` onto EVERY github.com request
out of the sandbox, so any process in the box — kyto tool or not — is already
authenticated as `kyto-agent`. `guardGithubCommand` only ever sees strings that
came through a kyto TOOL, so sshx/tmate, a shell script, or `sh -c 'g''h …'`
never meets it.
about the GH thingy, if we inject token outside token, simply not to inject a token, or to only inject token allowing kyto to make its own repos? is this good idea?

The intended shape: kyto's own host-side proxy in front of GitHub (the pattern
`lib/slack-proxy/` already proves), enforcing on the PARSED request —
`POST /repos/o/n/pulls` is unambiguous where a shell string is not. Reads pass,
writes checked against `github_repos`/`github_trust`, every request logged with
thread + user for attribution.

**Blocking constraint, measured 2026-07-30:** E2B rules can only INJECT HEADERS
(`SandboxNetworkTransform` is `{ headers }`) — they cannot redirect a host. So
the proxy cannot be slipped in transparently. It needs all three of: stop
brokering the token; point the sandbox at the proxy (`GH_HOST`,
`git config url.<proxy>.insteadOf`); and **`denyOut` the real GitHub hosts** so a
shell can't bypass the proxy by curling github.com directly. That last part is
the owner's "credentials XOR open network" idea arriving by necessity, and it is
the piece that needs a decision: a deny-list only for GitHub hosts is cheap, but
a full deny-by-default allowlist (the version that actually kills remote shells)
would also break the browser tool, arbitrary `fetch`, and npm/pypi from
unexpected hosts. **Decide the blast radius before building it.**

**DECISION 2026-08-01 (owner, via ask-question): GitHub-hosts-only deny.**
`denyOut` just the GitHub hosts (github.com, api.github.com, codeload.github.com,
*.githubusercontent.com), point the sandbox at kyto's proxy (`GH_HOST` + `git
config url.<proxy>.insteadOf`), and stop brokering the token. Everything else
keeps open egress, so browser/fetch/npm/pypi are untouched — blast radius ≈ zero.
This closes the GitHub-token hole (a shell can no longer curl github.com as
kyto-agent) but deliberately does NOT try to kill remote shells in general.
Answering the owner's inline question above: "only inject a token allowing kyto
to make its own repos" is roughly what the per-turn GitHub-App token (below)
buys; the cheaper first step is simply to stop brokering the PAT and force all
GitHub through the parsed-request proxy. STILL TO BUILD — not done in this pass
(a host-side GitHub proxy + egress rewiring + tests is a standalone build); the
decision above unblocks it.

**FINDING 2026-08-01 (claude), building it — `denyOut` CANNOT take domains, and
it turns out we don't need it.** The E2B API schema is explicit: `denyOut` is
"denied CIDR blocks or IP addresses … Domain names are not supported for deny
rules" (`node_modules/**/e2b/**/index.d.ts`). So "denyOut github.com" is
UNBUILDABLE as written; a domain deny would need GitHub's IP CIDRs (from
api.github.com/meta — large, changing, and a shell could resolve to a fresh IP
we don't list). BUT the reframe is cleaner: the token-abuse hole is closed simply
by **not brokering the token at all**. Today the real PAT lives ONLY in the E2B
egress header-injection rule (the sandbox-visible `GH_TOKEN` is a base64
placeholder). Remove that rule and NO sandbox process — kyto tool, sshx, tmate,
`sh -c` — has the token; a direct `curl github.com` is anonymous (fine for public
reads, useless for writes/private). The real token then lives ONLY host-side in
the proxy, which kyto's own gh/git are pointed at (via `GH_HOST` +
`url.<proxy>.insteadOf`) and which enforces the parsed-request guard. So:
- **Security = stop brokering + host-side proxy.** No denyOut required.
- **denyOut/`/etc/hosts` sinkhole of github hosts is OPTIONAL UX** (force git
  through the proxy so authed ops "just work"), NOT the security boundary — and
  since denyOut can't name domains, the sinkhole (`127.0.0.1 github.com …` in the
  bootstrap, same idempotent slot as GIT_HARDEN_COMMAND) is the mechanism if we
  want it.
Stop-brokering CANNOT ship without the proxy (gh/git would break unauthenticated),
so they land together — it's one focused build, deferred to its own pass. Also
flagged for the owner: this shifts the trust model to ONE principal baked in per
sandbox lifetime (vs per-shell-command), which matches the already-single-user
-per-thread sandbox but is a real change; and the proxy must proxy git
smart-HTTP (upload-pack/receive-pack), not just REST.

**DECISION 2026-08-01 (owner, ask-question): build option 1 — stop-brokering +
host-side proxy, NO egress deny.** Accepted the one-principal-per-sandbox trust
shift. Build plan for the focused pass:
1. `apps/bot/src/lib/github-proxy/index.ts` — `handleGithubProxy(req, pathname)`
   mounted at `/_ghapi/` on the sites Bun.serve (beside `handleSlackProxy`).
   Per-turn token stores `{userId, isOwner, threadId, expiry}` (not a bare bool)
   so it can feed the guard. Classify method+path (writes = POST/PUT/PATCH/DELETE
   to /repos/.., /user/repos, /orgs/.., graphql `mutation`; else read) → run the
   HTTP-shaped equivalent of guard.ts's two gates → forward to real
   api.github.com/github.com/codeload.github.com with the real PAT attached
   host-side → on 2xx call `claim()`. Must handle git smart-HTTP
   (info/refs?service=git-upload-pack / git-receive-pack), not just REST.
2. `packages/sandbox/src/lazy-sandbox.ts` — stop calling `githubNetwork()` / drop
   the `network: githubToken ? …` line and the placeholder GH_TOKEN env; keep
   GIT_ASKPASS/GIT_TERMINAL_PROMPT. Add an idempotent bootstrap step (new
   `github-proxy-client.ts`, same slot as GIT_HARDEN_COMMAND) that sets `GH_HOST`
   + `git config --global url."<proxy>/".insteadOf` for github/api/codeload, fed
   the per-turn proxy token via per-command env (Slack-proxy pattern).
3. Preserve every guard invariant (ownership→trust→claim-on-success-only,
   github_requests queueing, dead-PAT falls open to anonymous public reads).
4. TEST live: sandbox has NO real token (`echo $GH_TOKEN` = placeholder), gh/git
   route through the proxy, a third-party write is gated + queued, a public read
   works. Remove this whole TODO block once shipped.

Adjacent, from the same conversation and also unrecorded:
- A **GitHub App minting per-turn installation tokens** scoped to the repos the
  guard would allow is the durable answer — it also fixes the "kyto has ONE
  GitHub identity" problem that got the PAT revoked in the first place.
- A **hard wall-clock ceiling per sandbox**, independent of activity. The reaper
  is activity-based, so a sandbox kept warm never ages out (the owner's own "if
  you get kyto to use wait and not pause sandbox?").
- DONE 2026-07-30: `runBackgroundProcess` was a fourth, ungated shell —
  `runBackgroundProcess("gh pr create …")` walked past the ownership check that
  the identical `bash` command hits. Now gated at start time, and refused
  outright when there is no principal to attribute the write to.

**Reduce the system prompt.** Asked 2026-07-28 ("maybe reduce system prompt
too", in the same message as the Qwen pin and the caching work) and never
attempted — the other three parts of that message shipped. Measure the assembled
prompt first; it is paid on every turn of every thread against the shared $3/day.

**Going public — DONE.** The "one mechanical task" was the `slack.ts` prompt
update (it used to say kyto was private with no public repo). That already
shipped: `prompts/slack.ts` now says kyto is open-source AGPL-3.0 and points
users at `github.com/Devansh-awat/kyto`, and the repo went public (commit
`0a0d1a6`). Nothing left here. (Rotating `GH_TOKEN` was never a publication task
— no credential is in the tree — so it isn't blocking anything; rotate it on its
own schedule only if it was ever pasted into a thread or log.)

**"Thinking..." shows as plain text before the plan block appears**, and when
the block does appear it already has thinking in it. Investigated: no such
string exists anywhere in kyto, and the first plan chunk is already pulled
before the stream opens, so this looks like Slack's own placeholder for an open
`chatStream` that has not rendered yet. Needs confirming against a real thread
before there's anything to fix. Ideally show a real loading message instead.

**Next harness upgrades** — the original three (edit + diagnostics, thread
compaction, tests over the crown jewels) are done as of 2026-07-27. What the
assessment named and nobody has touched: (1) loop control — a plan/approve
checkpoint and budget-aware pacing, since `MAX_STEPS=1000` leaves the watchdog
as the only real governor; (2) orchestration depth — more than one subagent
level, parallelism not opt-in per call; (3) provider-native paths, because the
openai-compatible abstraction is now carrying four separate workarounds.

**The duplicate confirm-post acceptance message is only half explained.** The
DM-fallback path definitely misbehaved — `replace_original` does nothing on an
ordinary DM message, so the outcome landed BESIDE a prompt whose buttons stayed
live — and that is fixed. But a true ephemeral is replaced correctly, so if the
duplicate is still seen, grab the actual thread/DM and the timestamps: the
remaining possibility is the confirm going to BOTH the thread and the DM, which
the current code shouldn't do.

### Watch list

**The netic (`netic.hackclub.app`) key is DEAD as supplied (checked 2026-07-29).**
`GET /v1/models` answers 200 over https and lists all seven slugs
(`big-pickle`, `deepseek-v4-flash-free`, `mimo-v2.5-free`, `ling-3.0-flash-free`,
`nemotron-3-ultra-free`, `north-mini-code-free`, `laguna-s-2.1-free`), but every
`POST /v1/chat/completions` returns `401 {"error":{"message":"Invalid API key"}}`
— tested on all seven, and directly against https so it is not a redirect
stripping the header. Note it is http:// in the message and 308-redirects to
https. Nothing was wired up: the rule is no tier without a live account behind
it. Ask your friend for a working key and it can be added as a free tier in
front of Gemini.

**9Router + Kiro: do not use (researched 2026-07-29).** Kiro's own FAQ says
"Use with OpenClaw and similar tools that leverage third-party harnesses is
prohibited", which is exactly what an OpenAI-compatible bridge is, and its terms
separately prohibit rate-limit evasion — which is what round-robining AWS
Builder IDs is FOR. AWS actively detects and blocks multi-account signups. Also
Kiro is not even a built-in 9Router provider yet (open feature request), so it
would need a third-party wrapper on top. Not worth kyto's uptime or the account.

**Free tiers worth trying instead, ranked (researched 2026-07-29).**
1. **NVIDIA NIM** — `https://integrate.api.nvidia.com/v1`, permanently free key,
   no card, ~40 RPM, tool calling confirmed on GLM-5 / DeepSeek V4 / Qwen3 /
   Kimi K2.6. Best structural fit; no expiring credits.
2. **Cloudflare Workers AI** — built for low TTFB, which is the property that
   matters against HackClub's 5s header timeout. 10k Neurons/day.
3. **Groq** — LPU hardware, famously fast first token. Watch the ~6k TPM
   ceiling against kyto's system prompt + tool schemas.
Not worth it: Cerebras (~5 RPM ceiling is incompatible with a tool loop),
GitHub Models (8k input cap), DashScope (90-day expiring trial, and duplicates
the qwen3.7-plus primary), DeepSeek direct (one-time grant), xAI data-sharing
(pays in user conversation content). OpenRouter's free tier lost a third of its
catalogue in nine days — don't hard-code a `:free` slug as a permanent rung.
ABOUT THESE providers, do they have good models, for free? i dont want stuff like llama 8b


**Deferred-tool data is now being collected.** Every turn logs
`[tools] turn summary` with `loaded` / `loadedUsed` / `loadedUnused` /
`coreUsed`. After a few days: promote anything always-loaded-and-used into
`core`, defer any core tool that never shows up in `coreUsed`, and look at
`loadedUnused` — that is a round trip and a schema paid for nothing.

**The prompt is now ordered for caching; watch that it holds.** The volatile
`<your_previous_thinking>` block moved BELOW the thread history so system +
instructions + compacted + history is a stable append-only prefix. If anyone
adds a new block, it goes below `history` or the cache breaks again silently —
the only symptom is the bill.
Caching IS now measurable (2026-07-30): `turn complete` logs
`cache: { input, read, write }` from the answering attempt. Nothing logged it
before, so a broken cache would only have shown up on the bill. Read high +
input low across a thread's turns = the breakpoints are landing.
Me looked at the activity page and saw Qwen3.7 Plus 78,372 in / 300 out $0.019605 based on the pricing of it, only 22,883 was cached. However, based on the activity, it more or less outputs some 500 tokens, calls a tool, then we call hcai again, and the tool output was definetly not the uncached 50k tokens so another bug. A sample of the logs
just now • i	Qwen3.7 Plus	85,873 in / 39 out	$0.021671	OK · 3.2s
just now • i	Qwen3.7 Plus	85,775 in / 61 out	$0.021668	OK · 2.7s
just now • i	Qwen3.7 Plus	83,948 in / 1,787 out	$0.023293	OK · 35s
1m ago • i	Qwen3.7 Plus	83,590 in / 75 out	$0.020987	OK · 3.4s
1m ago • i	Qwen3.7 Plus	83,203 in / 38 out	$0.020815	OK · 2.9s
2m ago • i	Qwen3.7 Plus	83,125 in / 37 out	$0.020789	OK · 2.2s
2m ago • i	Qwen3.7 Plus	83,028 in / 60 out	$0.020788	OK · 2.9s
2m ago • i	Qwen3.7 Plus	82,940 in / 52 out	$0.020749	OK · 2.6s
2m ago • i	Qwen3.7 Plus	82,553 in / 39 out	$0.020609	OK · 2.6s
2m ago • i	Qwen3.7 Plus	82,472 in / 40 out	$0.020584	OK · 2.4s
2m ago • i	Qwen3.7 Plus	82,371 in / 64 out	$0.020583	OK · 2.7s
2m ago • i	Qwen3.7 Plus	79,887 in / 2,446 out	$0.022837	OK · 46s
3m ago • i	Qwen3.7 Plus	79,396 in / 38 out	$0.019597	OK · 2.9s
4m ago • i	Qwen3.7 Plus	79,097 in / 258 out	$0.019783	OK · 6.7s
according to me, everything should be cached apart from tool output, all its reasoning, etc should be cached. check how other agent harnesses do it. 

LOOK AT IF CACHING WORKED

**Findings 2026-08-01 (claude), and why the deepseek promotion is the fix.**
Checked OpenRouter's prompt-caching docs (the authority for the HackClub proxy).
Two different mechanisms by provider:
- **Qwen/Alibaba = EXPLICIT caching, 5-MINUTE write TTL**, breakpoints required.
  The ~22.8k that stayed cached is almost exactly the system+tools prefix
  (breakpoint A). The moving history-tail breakpoint (B) was NOT producing hits
  on qwen — qwen's explicit cache is limited (5-min TTL; and Alibaba lists it as
  unsupported on some snapshot endpoints), and our `ttl:'1h'` is ignored there.
  So on qwen only the system prefix reliably cached and the ~60k tail re-billed
  each step — exactly the pattern in the activity dump above.
- **DeepSeek = AUTOMATIC caching (0.1x read multiplier)** — it caches the growing
  prefix itself, no breakpoints needed. Now that `deepseek-v4-flash` is PRIMARY,
  the common path auto-caches the whole system+history+prior-tool-results prefix
  across steps and only the newest tool output is uncached — which is the "cache
  everything except tool output" behaviour asked for. So the promotion is the
  single biggest caching lever, not just a model swap.
The explicit two-breakpoint code (`cache-control.ts`) is KEPT — it's what Gemini
and any Anthropic BYOK key need, and it's harmless where a provider auto-caches.
NEXT: watch the `cache: { input, read, write }` line in `turn complete` on the
new primary — read HIGH / input LOW across a thread confirms deepseek is
auto-caching. If it isn't, the researched next step is OpenRouter's top-level
`cache_control` (auto-advances the breakpoint for multi-turn), but don't add it
blind — a wrong caching change only shows up on the bill.

**The ChatGPT account is parked until 2026-08-23.** The linked account is on a
FREE plan and its quota is spent; the 429 named that reset date, which is now
stored in `user_chatgpt_accounts.quota_resets_at` and the attempt is skipped
until then. If ChatGPT turns are wanted before that, the account needs a paid
plan. A completed turn clears the park automatically.
thats my account i linked if another user links it should work. 

**HackClub sometimes serves opus-4.5 for a slug kyto never asks for** — a turn
came back `(Empty response: {'content': [], 'model': 'claude-opus-4-5…'})`.
Kyto already filters the placeholder and falls back; whether HackClub remaps
slugs upstream is their question. Watch whether it recurs.

**The DigitalOcean tier is gone (2026-07-27)** — the account behind it stopped
being provided, so the whole `openrouter-do` tier, its key, and both of its
write-offs were deleted from kyto, and the same dead key was removed from
`stardance-archive` (its `gemini` embedder now calls Google directly; same model,
same 3072 dims). Fallback is HackClub then the owner's Gemini key, with nothing
free in between — so watch how often `BudgetExhaustedError` actually shows up
now that HackClub's daily $3 is the only shared tier.

**HackClub's proxy 504s (reported to the HC AI team 2026-07-27).** Bursty, ~5.4s
every time, size- and shape-independent, reproducible with bare `curl` — theirs,
not ours. Three things now sit between it and a user: `gateway-retry.ts` replays
a gateway status twice; a 504 no longer condemns the whole HackClub tier
(`condemnsHackclub`); and the tier it falls back to is kimi-k2.6 then
minimax-m3, both cheaper than the primary. Watch `[agent] gateway failure,
retrying the same request` in the journal — retries EXHAUSTING means the burst is
worse than measured. Also watch what the cheap rungs actually produce in public:
they are now the only thing between the primary and Gemini, and nobody has read a
k2.6 or m3 answer in a live thread yet.

**Compaction is new and unproven in the wild (2026-07-27).** No thread has
crossed 100 messages since it shipped. Check the first one that does: the
`<earlier_in_this_thread>` block should carry real decisions, and the summarizer
runs on the Gemini subagent key — if that key is ever unset the block degrades to
a bare count, which is intended but worth seeing once.
100+msg or a certain token count

### New bugs (from the 2026-07-29 paste — distilled from raw transcripts)

**Status narration lands in the Thinking card instead of reasoning.** A turn's
Thinking card showed "9089 out of 9999 codes done already! Let me run the
server-side exploits test…" and "50 more steps running" — i.e. plan/status text,
not the model's actual reasoning, and the real reasoning wasn't shown. Owner:
"it does not show its reasoning but this."

Audited 2026-07-30 and NOT reproduced from the code: kyto never classifies
anything as reasoning. It arrives pre-separated in the provider's own
`reasoning_content` channel, and the inline `<think>` splitter only moves text
the model itself tagged. Two candidates left, both needing a real thread:
(a) the model genuinely wrote that as its reasoning, which is a prompt/model
issue, not a routing one; (b) the card was TRUNCATED to its last fragment — that
one is plausibly already fixed, since an unclosed reasoning block used to leave
the card with no output at all (see the `reasoning-tracker` fix, same date).
Next time it happens, grab the raw `fullStream` parts, not the rendered card.
i suspect that either when many many tool calls done we dont return thinking and stuff but rather 50 more steps, or this is slack issue check their docs. PLEASE CHECK SLACK DOCS

**channel_not_found confirm-post bug — DONE 2026-08-01 (claude).** Root cause: a
model that passes a message TIMESTAMP where a channel id belongs makes the
confirm gate queue a post whose Slack `channel` is a bare ts, so the send fails
`channel_not_found` — sometimes only AFTER the approver clicked Confirm (the
`post to <#1785…732469>` in the old transcripts is that ts rendered as a channel
mention). `postMessage` was already fixed (`fe1266f`, the transcripts predate
it), but `sendAsUser`/`editAsUser` had NO such guard — same failure reproducible
today. Fixed: `normalizeSlackChannelArg` in `lib/slack/ids.ts` + shape checks on
`channelId`/`userId` in both, so a bad target is rejected with actionable text
BEFORE it can be queued. The "asked once, said could not send, then it sent it /
posts in thread AND channel" was NOT a double-send: it was a first (malformed)
call failing, then a retry with a corrected SAME-CHANNEL id taking the instant
direct-send path (no confirm) — and in a DM, "thread" and "channel" are the same
conversation. The separate duplicate-OUTCOME-notice item above still needs a live
incident's channel/ts to close.

**Subagent model + agy — DONE 2026-08-01 (claude).** Yes, the `Agent` tool takes
a `model` param, so I can (and now do) pick the model per spawn. CLAUDE.md now
states the DEFAULT for any spawned subagent is `model: "sonnet"` (Sonnet 5) and
that an omitted model silently inherits Opus — so it's never left unset; drop to
`haiku` only for mechanical search/read. Token-conservative + use-subagents
guidance was already in CLAUDE.md. Gemini-vs-native is a real choice too: the
`antigravity` plugin is installed and configured (agy = Gemini via
`agy-delegate` / the `antigravity-delegate` subagent, for above-break-even bulk
work), and native Claude subagents run on sonnet/haiku — so both paths exist and
the routing policy says when to use which.

---


