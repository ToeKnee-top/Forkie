// Chat SDK Slack ids are `slack:CHANNEL` or `slack:CHANNEL:TS`. These convert to
// the raw Slack channel id (C123…) the Web API expects, and back.

// Slack channel ids start with C (public), G (private/group) or D (DM).
const RAW_SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]+$/;
// Slack renders a channel mention as `<#C123ABC|name>`; users/models often paste
// that, or a bare `#C123ABC`, when they mean a channel.
const SLACK_CHANNEL_MENTION = /^<#([CGD][A-Z0-9]+)(?:\|[^>]*)?>$/;

// Slack renders a user mention as `<@U123ABC>`; models and users paste that, a
// bare `@U123ABC`, or the raw id when naming someone.
const SLACK_USER_MENTION = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/;
const RAW_SLACK_USER_ID = /^[UW][A-Z0-9]+$/;

/**
 * Normalize the shapes a user reference arrives in into a raw Slack user id.
 * Returns null for anything that cannot be one (a display name, say) so callers
 * can reject it rather than silently storing a permission entry that never
 * matches.
 */
export function toRawSlackUserId(user: string): string | null {
  const trimmed = user.trim();
  const mention = trimmed.match(SLACK_USER_MENTION);
  if (mention?.[1]) {
    return mention[1];
  }
  const raw = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  return RAW_SLACK_USER_ID.test(raw) ? raw : null;
}

export function toRawSlackChannelId(id: string): string {
  return id.startsWith('slack:') ? (id.split(':')[1] ?? id) : id;
}

/**
 * True only for a bare raw Slack channel id (C…/G…/D…). Used to reject a value
 * that is really a message TIMESTAMP (`1785…`) or a user id before it reaches
 * the Web API, where the mistake surfaces as a cryptic `channel_not_found` —
 * sometimes only AFTER a human has clicked Confirm on a queued post.
 */
export function isRawSlackChannelId(id: string): boolean {
  return RAW_SLACK_CHANNEL_ID.test(id);
}

/**
 * Normalize any channel reference a model may supply — a raw C…/G…/D… id, a
 * `<#C123|name>`/`#C123` mention, or a Chat SDK `slack:CHANNEL[:TS]` id — into a
 * raw Slack channel id. Returns null for anything that cannot be one (most
 * importantly a message TIMESTAMP), so a caller can reject it before it reaches
 * the Web API as `channel_not_found` — sometimes only AFTER a human clicked
 * Confirm on a queued post.
 */
export function normalizeSlackChannelArg(value: string): string | null {
  const trimmed = value.trim();
  const mention = trimmed.match(SLACK_CHANNEL_MENTION);
  if (mention?.[1]) {
    return mention[1];
  }
  let raw = trimmed;
  if (raw.startsWith('slack:')) {
    raw = raw.split(':')[1] ?? '';
  } else if (raw.startsWith('#')) {
    raw = raw.slice(1);
  }
  return RAW_SLACK_CHANNEL_ID.test(raw) ? raw : null;
}

// Normalize the many shapes a channel reference arrives in (a Chat SDK id, a raw
// `C123` id, a `<#C123|name>` mention, or a bare `#C123`) into a Chat SDK
// `slack:CHANNEL` id. Throws only when the value can't be a Slack channel at all.
export function toChatSlackChannelId(channelId: string): string {
  const trimmed = channelId.trim();

  if (trimmed.startsWith('slack:') && trimmed.split(':').length === 2) {
    return trimmed;
  }

  const mention = trimmed.match(SLACK_CHANNEL_MENTION);
  if (mention) {
    return `slack:${mention[1]}`;
  }

  const raw = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (RAW_SLACK_CHANNEL_ID.test(raw)) {
    return `slack:${raw}`;
  }

  throw new Error(
    `${channelId} is not a Slack channel id. Use a value like C123456 or slack:C123456.`
  );
}
