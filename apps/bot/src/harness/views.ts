// Block Kit text helpers (replacing @chat-adapter/slack/format + /api).

export function mrkdwn(text: string) {
  return { text, type: 'mrkdwn' as const };
}

export function plainText(text: string) {
  return { emoji: true, text, type: 'plain_text' as const };
}
