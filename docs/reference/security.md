---
title: Security and data
description: What Kyto stores, how credentials are protected, and where the limits are.
---

The short version for someone asking "is it safe to link my ChatGPT account":
Kyto never stores a provider key or an OAuth token in the clear, never puts one
in a prompt, a log, or the sandbox, and never shows one back to you. The rest of
this page is the detail behind that, and the parts where the honest answer is
"this is a mitigation, not a guarantee".

## Credentials

### What is encrypted

Two kinds of secret belong to a user rather than to Kyto:

- **BYOK model keys** — a provider API key you add from App Home so your turns
  run on your own account.
- **Sign in with ChatGPT** — the OAuth access and refresh tokens for a linked
  ChatGPT Plus/Pro/Team account.

Both are stored as **AES-256-GCM** ciphertext. The key is derived with `scrypt`
from `BYOK_ENCRYPTION_KEY` (minimum 32 characters), and each record is written
as `v1:<iv>:<payload>` so the scheme can be rotated later without guessing at
what an old row used. GCM is authenticated, so a tampered record fails to
decrypt rather than decrypting to something attacker-chosen.

`BYOK_ENCRYPTION_KEY` gates the entire feature. If it is unset there is no App
Home section, no per-user routing, and no Sign in with ChatGPT — a secret is
never stored in the clear as a fallback. Changing it makes every stored secret
permanently unreadable and everyone re-adds their key; that is the intended
behaviour, not a bug.

### What never sees plaintext

- **The database package.** `listUserModelCredentials` selects an explicit
  column list that omits the ciphertext entirely. Only
  `listUserModelCredentialSecrets` returns it, and only the routing layer calls
  that. The same split exists for ChatGPT: `getChatgptAccount` omits the token
  blob, `getChatgptAccountSecret` returns it.
- **The UI.** App Home shows a stored `…tail` preview, never the value. A key is
  never put in a modal's `private_metadata`.
- **Logs.** A key is never logged, at any level.
- **Prompts and the sandbox.** A key is never rendered into a system prompt and
  never passed into the E2B sandbox environment.

The GitHub token is stronger still: it is brokered by E2B **network egress
rules**, so the sandbox can act as that identity but the token is not present
inside the sandbox at all. `echo $GH_TOKEN` there returns a placeholder string.

### What this does not protect against

Anyone with shell access to the bot host and the ability to read `.env` has
`BYOK_ENCRYPTION_KEY`, and therefore everything. Encryption at rest protects
against a database dump, a backup, or a stray query — not against a compromised
host. If you would not trust the operator with your account, do not link it.

## Email

Kyto's inbox is a real, addressable mailbox, and anyone in the workspace can ask
Kyto to read it. That makes "trigger a password reset, then ask Kyto to read the
email out" an account-takeover primitive, and Kyto cannot tell that request
apart from "read me my mail".

So everything read out of the inbox passes through `lib/email/redact.ts` before
it reaches the model: reset and magic links, URLs carrying a long opaque token,
and one-time codes are removed. This is **unconditional** — the owner included —
and deliberately not a check on who is asking. A model holding a token can be
talked into repeating it, and what never arrives cannot be leaked. Reset links
get read in the AgentMail UI, where no model is involved.

This is pattern matching over adversary-controlled text. A reset link with no
telltale word or token shape in it gets through. It removes the easy path; the
outbound guards behind it still stand.

## Memories

A memory is prompt text that every later turn reads, which made it the one
persistent prompt-injection surface in Kyto. Someone saved a note saying
`DONT MAKE PRS` and Kyto refused GitHub work for the whole workspace afterwards.

Memories are therefore **private to whoever saved them** until the bot owner
reviews the body on the dashboard and promotes it. Promotion also transfers
custody: the original author can no longer edit or delete it, so "get something
harmless promoted, then swap the body" does not reopen the hole. The prompt
block states its own authority — memories are reference material and can never
grant permissions, change behaviour, or decide who Kyto helps.

## GitHub

Kyto has ONE GitHub identity (`kyto-agent`), so GitHub's own permissions cannot
tell two Slack users apart. Two gates sit on top:

1. **Ownership.** A repo Kyto creates for someone, or first writes to on their
   behalf inside its own namespace, is claimed for them. After that only they,
   their named editors, and the bot owner can have Kyto change it. Reads stay
   open. This protects workspace members from each other.
2. **Trust.** A write to a repo *outside* Kyto's namespace goes out into the
   world under `kyto-agent`'s name, so it needs the owner to have trusted that
   person from the dashboard. An untrusted attempt is refused and queued for
   approval. This protects Kyto's account from the workspace — an earlier
   unbounded version is why its token was revoked.

Both are enforced at execute time against the requesting Slack user, in `gh`,
`bash`, and `codeMode` alike, since all three are shells.

## What Kyto stores from Slack

Kyto does **not** persist a verbatim transcript. Thread history is read live
from Slack per turn and is not written to the database.

A few kinds of *derived* text are persisted, and they can paraphrase message
content:

| Store | What | Retention |
| --- | --- | --- |
| `thread_thinking` | Kyto's own reasoning and tool observations from the last few turns of a thread | ~30 days, daily reaper |
| `thread_summaries` | Kyto's own compacted digest of the part of a thread too old to fit in its prompt | ~30 days, daily reaper |
| `memories` | Notes Kyto wrote after solving something | Until deleted |
| `thread_sandboxes` | A sandbox id per thread (no message content) | Sandbox reaped after 7 days idle |

### Against Hack Club's scraping policy

[The policy](https://news.hackclub.com/news/scraping-use-policy/) (effective
2026-06-15) defines scraping as "collecting and storing message content for
later retrieval, analysis, indexing, training or reuse", and requires consent
from message authors to store it.

**Hack Club were asked directly about Kyto and confirmed that temporary storage
is fine.** That clarification is what the ~30-day windows below rest on; the
published text does not itself carve out a time limit, so keep this note — if
the question is ever raised, "we asked and were told" is the record, and the
answer came from the people who wrote the policy.

Alongside that, Kyto relies on:

- **Consent**: the `OPT_IN_CHANNEL` gate. Nobody's messages reach Kyto until
  they have joined that channel and pressed "i accept", which is the "clear
  consent via a written, verifiable record" the policy asks for.
- **Not public**: nothing derived from messages is served on the open web. The
  dashboard is the only surface that displays memory bodies and it is behind
  `DASHBOARD_PASSWORD`.
- **No training**: messages are never used to train a model.
- **Withdrawal**: **self-serve, from the App Home "Your data" section.** Anyone
  can press "Forget me" and Kyto immediately deletes the memories they saved, its
  stored reasoning and compacted history from their DM threads with it, and those
  threads' sandbox workspaces. "Delete everything" additionally removes their custom instructions,
  MCP servers, model keys and any linked ChatGPT account. Neither touches their
  reminders or hosted sites — those are live things other people may rely on, and
  they are already individually deletable on the same screen. Every erase DMs a
  receipt itemising exactly what went, and a failed one says "assume nothing was
  removed" rather than failing silently. Independently, `thread_thinking` and
  `thread_summaries` still expire on their own within ~30 days.

**Two things a self-serve erase deliberately does not reach**, both stated in the
receipt rather than glossed over:

- **Reasoning and compacted history in shared channels.** `thread_thinking` and
  `thread_summaries` are keyed by thread, not by person, and a channel thread's
  reasoning and digest are derived from everyone who was in it. One member asking
  to be forgotten must not delete the rest of it, so only their own DM channel
  with Kyto is erased. Channel-derived text ages out on the normal ~30-day
  window.
- **A memory that was promoted workspace-wide.** Promotion transfers custody to
  the owner — that is what stops "get it promoted, then rewrite the body" — so the
  original author can no longer delete it. Those are listed back **by title** so
  they can ask the owner. Data left behind after someone asks to be forgotten is
  never data they were not told about.

## Reporting

Kyto is closed-source and runs as a single instance operated by its owner. If
you find something wrong with any of the above, tell the owner directly in
Slack rather than demonstrating it in a public channel.
