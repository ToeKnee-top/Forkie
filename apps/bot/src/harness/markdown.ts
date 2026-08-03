// Slack mrkdwn ↔ markdown conversion for the custom harness.
//
// Outbound replies are posted as native Block Kit `markdown` blocks, so no
// markdown→mrkdwn conversion is needed anymore. Inbound, Slack delivers
// mrkdwn (`*bold*`, `<url|label>`, `&amp;` escapes) which the model should see
// as regular markdown.

const FENCE = /^\s*(?:```|~~~)/;

function decodeEntities(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

// `<...>` tokens: links (`<url>`/`<url|label>`), mentions (`<@U…>`, `<#C…>`),
// and specials (`<!here>`). Mentions/specials pass through untouched — the
// agent's annotateMentions handles them later.
const ANGLE_TOKEN = /<([^<>|]+)(?:\|([^<>]*))?>/g;

function convertAngleTokens(text: string): string {
  return text.replace(ANGLE_TOKEN, (whole, target: string, label?: string) => {
    if (/^[@#!]/.test(target)) {
      return whole;
    }
    if (/^(?:https?|mailto):/i.test(target)) {
      return label ? `[${label}](${target})` : target;
    }
    return whole;
  });
}

// Inline styles outside code spans: *bold* → **bold**, ~strike~ → ~~strike~~.
// Slack's mrkdwn has no italic/underscore ambiguity worth chasing here.
function convertInlineStyles(line: string): string {
  const parts = line.split(/(`[^`]*`)/);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        return part;
      }
      return part
        .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?;:])/g, '$1**$2**')
        .replace(/(^|\s)~([^~\n]+)~(?=\s|$|[.,!?;:])/g, '$1~~$2~~');
    })
    .join('');
}

export function mrkdwnToMarkdown(text: string): string {
  const lines = decodeEntities(text).split('\n');
  let inFence = false;
  const out = lines.map((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) {
      return line;
    }
    return convertInlineStyles(convertAngleTokens(line));
  });
  return out.join('\n');
}

// Broadcast/control-mention tokens (`<!channel>`, `<!here>`, `<!everyone>`) and
// user-group pings (`<!subteam^ID|name>`). Anyone but the owner is not allowed
// to make kyto ping the whole channel, so we downgrade these to inert plaintext
// (`@channel`, or the group's own name) that renders but never notifies.
const BROADCAST_TOKEN = /<!(channel|here|everyone)(?:\|[^<>]*)?>/g;
const SUBTEAM_TOKEN = /<!subteam\^[^<>|]+(?:\|([^<>]*))?>/g;

/**
 * Did the author actually ask to ping a whole channel or user group?
 *
 * Used to tell "this message would have notified everyone and we defanged it"
 * apart from an ordinary message, so the first case can be offered to the owner
 * as a real decision instead of being silently downgraded while the model
 * believes it pinged the room.
 */
export function hasBroadcastToken(text: string): boolean {
  BROADCAST_TOKEN.lastIndex = 0;
  SUBTEAM_TOKEN.lastIndex = 0;
  return BROADCAST_TOKEN.test(text) || SUBTEAM_TOKEN.test(text);
}

/**
 * Strip broadcast pings from text so it can no longer notify a whole channel or
 * user group. Used to gate `@channel`/`@here`/`@everyone` to the owner only.
 */
export function neutralizeBroadcast(text: string): string {
  return text
    .replace(BROADCAST_TOKEN, (_whole, kind: string) => `@${kind}`)
    .replace(SUBTEAM_TOKEN, (_whole, label?: string) =>
      label ? `@${label}` : 'the group'
    );
}

// Inbound, the agent is shown every mention ANNOTATED — `<@U085KKYFA6Q>` is
// rewritten to `@devansh (U085KKYFA6Q)` so the model can read who is who
// (see lib/agent/mentions). Models then reasonably copy that exact form back
// when they want to mention someone, and Slack renders it as literal text: the
// person is named but never pinged. Observed twice in one thread — "@devansh
// (U085KKYFA6Q):" and "@gork2 (U09NCF07DP1)" — both reported as "failed to
// mention me properly".
//
// So the annotation is REVERSED on the way out. Bounded to one line and to a
// real Slack id shape (U/W/B + 4+ upper-alnum) so ordinary prose that happens to
// end in a parenthesis can't be swallowed; the display name is discarded because
// `<@ID>` renders the current one.
const ANNOTATED_MENTION = /@[^\n]{1,80}?\s*\(([UWB][A-Z0-9]{4,})\)/g;

/**
 * Turn the annotated mentions the model was SHOWN back into real Slack mention
 * tokens, so a mention the model wrote actually pings. Fenced code is left
 * alone: an id inside a code block is being quoted, not addressed.
 */
export function restoreAnnotatedMentions(text: string): string {
  const lines = text.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) {
        return line;
      }
      return line.replace(
        ANNOTATED_MENTION,
        (_whole, id: string) => `<@${id}>`
      );
    })
    .join('\n');
}

/**
 * The same strip, applied to every string inside a Block Kit payload. A block's
 * `text` notifies exactly like message text does, so a broadcast token smuggled
 * into a block would sail past the plain-text gate. Walks the structure rather
 * than regexing the serialized JSON, so an escaped quote in a token's label
 * can't corrupt the payload.
 */
export function neutralizeBroadcastDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return neutralizeBroadcast(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => neutralizeBroadcastDeep(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        neutralizeBroadcastDeep(nested),
      ])
    ) as T;
  }
  return value;
}

/**
 * Close any dangling markdown a mid-stream cut left open (unbalanced code
 * fence, inline code, bold or strikethrough) so a posted chunk renders clean.
 * Replaces the chat-sdk's StreamingMarkdownRenderer push/finish healing.
 */
export function healMarkdown(markdown: string): string {
  let text = markdown.trimEnd();
  if (openFenceLanguage(text) !== null) {
    text = `${text}\n\`\`\``;
  }
  // Balance inline markers outside fenced code, cheapest-first.
  const outside = stripFencedCode(text);
  for (const marker of ['`', '**', '~~'] as const) {
    if (countOccurrences(outside, marker) % 2 === 1) {
      text = `${text}${marker}`;
    }
  }
  return text;
}

/** The open fence's language if `text` ends inside a fenced block, else null. */
export function openFenceLanguage(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const match = /^\s*(?:```|~~~)(.*)$/.exec(line);
    if (match) {
      open = open === null ? (match[1] ?? '').trim() : null;
    }
  }
  return open;
}

function stripFencedCode(text: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      kept.push(line);
    }
  }
  // Also drop inline code spans so their contents can't unbalance markers.
  return kept.join('\n').replace(/`[^`\n]*`/g, '');
}

function countOccurrences(text: string, marker: string): number {
  let count = 0;
  let index = text.indexOf(marker);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(marker, index + marker.length);
  }
  return count;
}
