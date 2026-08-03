import { tool } from 'ai';
import { z } from 'zod';

// Curated, up-to-date reference notes on the Slack surfaces kyto writes to,
// loadable on demand (deferred behind loadTools). Models already "know" Slack,
// but their training data is stale exactly where it hurts: canvas checkbox
// syntax (they reach for emoji), the newer `markdown` block, and the less
// common search modifiers. Written from the official docs
// (docs.slack.dev/reference, docs.slack.dev/surfaces/canvases, the Slack
// search help article) — refresh against those when Slack ships changes.

const BLOCK_KIT_DOC = `# Block Kit reference (messages)

Limits: up to 50 blocks per message (100 in modals/App Home). Every block takes
an optional block_id (≤255 chars).

## Text objects
- \`mrkdwn\` text uses SLACK mrkdwn, not standard markdown: *bold*, _italic_,
  ~strike~, \`code\`, \`\`\`fences\`\`\`, > quote, <https://url|label>,
  mentions <@U123>, channels <#C123>, emoji :tada:. No headings, no tables,
  no [label](url).
- \`plain_text\` renders literally (emoji optional via \`"emoji": true\`).

## Blocks worth reaching for
- **section** — the workhorse. \`text\` (1–3000 chars), optional \`fields\`
  (≤10 text objects, ≤2000 chars each, laid out two-column), optional
  \`accessory\` element (button, select, image, overflow, datepicker).
- **markdown** — \`{"type":"markdown","text":"…"}\` (≤12000 chars). Takes REAL
  markdown: headers, tables, task lists, code with syntax highlighting.
  Images render as links. One block may be split into several on delivery.
  Good default for LLM-formatted prose; does NOT resolve <!channel> control
  mentions (kyto's harness posts those as section+mrkdwn instead).
- **header** — plain_text only, ≤150 chars.
- **context** — up to 10 small text/image elements, muted styling.
- **divider** — \`{"type":"divider"}\`.
- **image** — \`image_url\` + \`alt_text\` (block or context element).
- **actions** — up to 25 interactive elements (buttons ≤75-char labels).
- **rich_text** — what the Slack client itself produces; prefer section or
  markdown when composing by hand.
- **video** — embeds a player; needs a public thumbnail + provider allowlist.

## Interactivity warning (kyto-specific)
A button/select posts an \`action_id\` to the app. kyto only handles its OWN
action ids (confirm gate, polls, onboarding, App Home) — an arbitrary
action_id you invent will do NOTHING when clicked. Use link buttons
(\`"url": "https://…"\`) for anything that should just open; never promise a
custom button "tells kyto" something.

## Notification fallback
Always send \`text\` alongside \`blocks\` — it's what notifications and
screen readers read (kyto's postMessage \`message\` param already is this).`;

const SEARCH_DOC = `# Slack search modifiers (searchSlack)

Combinable; quote "exact phrases"; exclude with a leading minus (-report,
-in:#noise); wildcard on 3+ chars (rep*). Run searches EARLY in the turn —
the action token expires ~2 minutes in.

## People
- from:@user — messages a person sent (from:me works)
- to:@user — DMs you sent them
- with:@user — threads/DMs the person is IN
- creator:@user — canvases/lists created by them

## Place
- in:#channel / in:@user (a DM) / in:"channel name"
- is:dm, is:thread, is:external (Slack Connect)

## Time
- on:2026-07-01, before:/after:YYYY-MM-DD, during:july (month or year)

## Content
- has:link, has:pin, has:star, has::eyes: (a reaction), hasmy::eyes:
  (your own reaction)
- is:saved (your saved items)
- filename:report, ext:pdf (file searches)

kyto notes: results come back trimmed (2 context messages either side,
limit 10) because context dominates token cost. Narrow with modifiers instead
of raising limits. Searching \`in:@user\` is how kyto reads earlier DM
history on purpose — thread context alone has no memory of the rest of a DM.`;

const CANVAS_DOC = `# Canvas markdown (canvasWrite / canvases.edit)

Canvas bodies are \`document_content: {type:"markdown", markdown:"…"}\`. Block
Kit is NOT supported in canvases.

## Syntax that works
- Headings: # ## ### (h1–h3 only)
- *bold*/**bold**, _italic_, ~~strike~~, \`code\`, fenced code blocks
- Bulleted and ordered lists; quote blocks (>) ; dividers (---)
- **Clickable checkboxes**: \`- [ ] open task\` / \`- [x] done\` — USE THIS
  for checklists, never emoji squares (☐/✅ render as plain text and can't
  be ticked).
- Tables: standard markdown tables, max 300 cells
- Links: [label](url); bare URLs unfurl (canvas/file/message/profile/website)
- Emoji: :tada: (standard and custom)
- Mentions: \`![](@U0123ABC)\` for a user, \`![](#C0123ABC)\` for a channel —
  NOT the message-style <@U…> form.

## Editing (kyto's canvasWrite)
- mode create-channel / create-standalone / edit; edit takes
  editOperation replace | insert_at_end (the API also has insert_at_start /
  insert_before / insert_after / delete with a section_id from
  canvases.sections.lookup, but kyto's tool exposes the two above).
- canvasId defaults to the last canvas created/edited this turn.
- Share the returned \`link\` as [Title](link); never hand-compose a
  /canvas/<id> URL (it unfurls as a sign-in card).`;

const DOCS = {
  'block-kit': BLOCK_KIT_DOC,
  canvas: CANVAS_DOC,
  search: SEARCH_DOC,
} as const;

export function slackDocsTool() {
  return tool({
    description:
      'Load detailed, current reference notes on a Slack writing surface before composing something non-trivial: "block-kit" (block types, limits, mrkdwn vs markdown blocks, interactivity pitfalls), "canvas" (canvas markdown — including real clickable checkboxes — and edit operations), or "search" (every searchSlack modifier). Cheap and instant; prefer checking over guessing syntax from memory.',
    inputSchema: z.object({
      topic: z
        .enum(['block-kit', 'canvas', 'search'])
        .describe('Which reference to load.'),
    }),
    execute: ({ topic }) => Promise.resolve({ doc: DOCS[topic], topic }),
  });
}
