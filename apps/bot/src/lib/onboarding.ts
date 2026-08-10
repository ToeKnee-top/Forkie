import { z } from 'zod';
import { env } from '@/env';
import type { ActionEvent, Author, ThreadHandle } from '@/harness';
import { mrkdwn, plainText } from '@/harness';
import { addAllowedUser } from '@/lib/allowed-users';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';

// First-time onboarding for the opt-in allowlist. When OPT_IN_CHANNEL gates
// access, an un-opted-in user who pings Kyto sees an opt-in card instead of
// silence. Clicking "I accept" is the recorded consent: it grants access and
// invites them into the terms channel.

const slackErrorSchema = z.looseObject({
  data: z
    .looseObject({
      error: z.string().optional(),
    })
    .optional(),
});

export async function offerOptIn(
  thread: ThreadHandle,
  user: Author
): Promise<void> {
  if (!env.OPT_IN_CHANNEL) {
    return;
  }
  try {
    // Posted as a visible in-thread reply (not ephemeral): an un-opted-in user
    // should clearly see the prompt — and so should others in the thread, the
    // way gorkie surfaces its own join gate.
    await thread.post({
      blocks: [
        {
          text: plainText(':wave: first time meeting forkie'),
          type: 'header',
        },
        {
          text: mrkdwn(
            `hi <@${user.userId}>! i'm forkie. before i can help, you need to accept the terms posted in <#${env.OPT_IN_CHANNEL}>.`
          ),
          type: 'section',
        },
        {
          text: mrkdwn(
            "tap below to opt in, i'll add you to the terms channel and we can get started."
          ),
          type: 'section',
        },
        {
          elements: [
            {
              action_id: 'opt_in_accept',
              style: 'primary',
              text: plainText('i accept, opt me in'),
              type: 'button',
              value: thread.id,
            },
          ],
          type: 'actions',
        },
      ],
      fallbackText: 'forkie opt-in: accept the terms to get started.',
    });
  } catch (error) {
    logger.warn(
      { ...toLogError(error), userId: user.userId },
      '[onboarding] failed to offer opt-in'
    );
  }
}

export async function acceptOptIn(event: ActionEvent): Promise<void> {
  const userId = event.user.userId;
  await addAllowedUser(userId);
  await inviteToOptInChannel(userId);
  await event.thread
    ?.postEphemeral(
      event.user,
      "you're all set, welcome to forkie. ask me anything.",
      { fallbackToDM: true }
    )
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId },
        '[onboarding] failed to confirm opt-in'
      );
    });
}

async function inviteToOptInChannel(userId: string): Promise<void> {
  const channel = env.OPT_IN_CHANNEL;
  if (!channel) {
    return;
  }
  try {
    await slack.webClient.conversations.invite({ channel, users: userId });
  } catch (error) {
    // Already a member is success; external users can't be invited (we log it).
    const slackError = slackErrorSchema.safeParse(error).data?.data?.error;
    if (slackError === 'already_in_channel') {
      return;
    }
    logger.warn(
      { ...toLogError(error), channel, userId },
      '[onboarding] failed to invite to opt-in channel'
    );
  }
}
