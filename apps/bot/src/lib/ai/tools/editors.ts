import { z } from 'zod';
import { toRawSlackUserId } from '@/lib/slack/ids';

// Things kyto creates on someone's behalf and can later change — reminders and
// published sites — carry an access list. The creator can always edit their own;
// anyone named here can too; the bot owner can edit anything. Everyone else is
// refused, so a thread bystander can't ask kyto to rewrite someone's reminder or
// take down their site.

export const editorsSchema = z
  .array(z.string())
  .optional()
  .describe(
    'Optional: Slack user ids (or <@U123> mentions) of other people allowed to edit this later. Omit so that only the person who created it (and the bot owner) can.'
  );

export type EditorsResult =
  | { ok: true; editors: string[] | null }
  | { ok: false; error: string };

/** Turn the `editors` argument into raw Slack user ids, rejecting non-ids. */
export function parseEditors(editors: string[] | undefined): EditorsResult {
  if (!editors) {
    return { editors: null, ok: true };
  }
  const ids: string[] = [];
  for (const entry of editors) {
    const id = toRawSlackUserId(entry);
    if (!id) {
      return {
        error: `"${entry}" is not a Slack user id. Use the id (U123ABC) or a <@U123ABC> mention — look it up with getUser if you only have a name.`,
        ok: false,
      };
    }
    ids.push(id);
  }
  return { editors: ids.length > 0 ? ids : null, ok: true };
}

/** Whether `userId` may change something created by `ownerUserId`. */
export function canEdit({
  editorUserIds,
  isOwner,
  ownerUserId,
  userId,
}: {
  editorUserIds: string[] | null;
  isOwner: boolean;
  ownerUserId: string;
  userId: string;
}): boolean {
  return (
    isOwner || ownerUserId === userId || (editorUserIds ?? []).includes(userId)
  );
}
