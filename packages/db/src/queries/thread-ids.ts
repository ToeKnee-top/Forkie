import type { SQL } from 'drizzle-orm';
import { eq, like, or } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * Match every thread id rooted in one Slack channel.
 *
 * Thread ids use the harness codec `slack:CHANNEL[:TS]` — the timestamp is
 * optional, so a channel matches both the bare `slack:C123` form and every
 * `slack:C123:1784…` thread within it.
 *
 * Anchored on the trailing colon rather than a bare `slack:C123%` prefix. Slack
 * ids happen to be fixed width today, so no real id is a prefix of another — but
 * that is an accident of Slack's format, and this is used by deletes whose blast
 * radius would be someone else's channel if it ever stopped being true.
 */
export function threadsInChannel(
  column: PgColumn,
  channelId: string
): SQL | undefined {
  return or(
    eq(column, `slack:${channelId}`),
    like(column, `slack:${channelId}:%`)
  );
}
