import type { Message } from '@/harness';

const leadingMentions = /^\s*(?:<@[A-Z0-9][A-Z0-9._-]*(?:\|[^>]+)?>\s*)+/;

export function rawSlackText(message: Message): string | undefined {
  const raw = message.raw;
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('text' in raw) ||
    typeof raw.text !== 'string'
  ) {
    return;
  }
  return raw.text;
}

export function rawText(message: Message): string {
  return rawSlackText(message) ?? message.text;
}

export function withoutLeadingMentions(text: string): string {
  return text.replace(leadingMentions, '');
}

// A message is hidden from Kyto entirely (not just non-triggering) when it
// STARTS with `##` (after leading mentions). Such messages must neither wake the
// bot NOR appear in the thread context it replays — they're a private
// side-channel for humans to talk without Kyto seeing anything.
//
// Only the FIRST content line counts: a `##` further down (e.g. a normal message
// that happens to contain a markdown `## heading`) does NOT hide the message,
// which used to silently drop ordinary messages. To use the side-channel, begin
// the message with `##`.
export function isHiddenFromBot(message: Message): boolean {
  return withoutLeadingMentions(rawText(message)).trimStart().startsWith('##');
}
