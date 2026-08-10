import { bot, slack } from '@/lib/chat';

const mentionPattern = /<@([A-Z0-9_]+)(?:\|([^<>]+))?>/g;
// The bot's Slack username is a leftover gorkie-era handle (`gorkie__devansh_`),
// so resolving its own mention by username makes the agent think *gorkie* was
// mentioned. Always annotate the bot's own id with its real name instead.
const BOT_NAME = 'forkie';

export async function annotateMentions(text: string): Promise<string> {
  const mentionNames = new Map<string, string>();
  const missingIds = new Set<string>();
  const botUserId = slack.botUserId;

  for (const mention of text.matchAll(mentionPattern)) {
    const userId = mention[1];
    const label = mention[2];
    if (!userId || mentionNames.has(userId)) {
      continue;
    }
    if (botUserId && userId === botUserId) {
      mentionNames.set(userId, BOT_NAME);
      continue;
    }
    if (label) {
      mentionNames.set(userId, label);
      continue;
    }
    missingIds.add(userId);
  }

  await Promise.all(
    [...missingIds].map(async (userId) => {
      const user = await bot.getUser(userId).catch(() => undefined);
      mentionNames.set(userId, user?.userName ?? userId);
    })
  );

  if (mentionNames.size === 0) {
    return text;
  }
  return text.replace(mentionPattern, (token, userId: string) => {
    const name = mentionNames.get(userId);
    return name ? `@${name} (${userId})` : token;
  });
}
