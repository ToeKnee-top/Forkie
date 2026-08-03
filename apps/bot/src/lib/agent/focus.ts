import { env } from '@/env';
import type { ThreadState } from '@/harness';

// Focus mode: kyto can be told to respond to (and only see) specific users in a
// thread, so other people can't distract it in a public thread. The owner is
// always allowed through so a focus can never lock the owner out of the thread,
// and kyto's own messages are always kept in context.

export function focusUsers(state: ThreadState | null): string[] | null {
  const ids = state?.focusUserIds;
  return Array.isArray(ids) && ids.length > 0 ? ids : null;
}

/**
 * Whether a user may interact with / be seen by kyto in a thread given its
 * focus state. True when focus is off, the user is focused, the user is the
 * owner, or the message is kyto's own.
 */
export function isFocusAllowed(
  state: ThreadState | null,
  userId: string,
  { isMe = false }: { isMe?: boolean } = {}
): boolean {
  if (isMe) {
    return true;
  }
  const focus = focusUsers(state);
  if (!focus) {
    return true;
  }
  if (env.OWNER_USER_ID && userId === env.OWNER_USER_ID) {
    return true;
  }
  return focus.includes(userId);
}
