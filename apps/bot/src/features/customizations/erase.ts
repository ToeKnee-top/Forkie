import {
  clearThreadSandbox,
  clearUserCustomization,
  deleteChatgptAccount,
  deletePrivateMemoriesByAuthor,
  deleteSummariesForChannel,
  deleteThinkingForChannel,
  deleteUserModelCredential,
  getUserCustomization,
  listMcpServers,
  listMemoriesByAuthor,
  listThreadSandboxesForChannel,
  listUserModelCredentials,
  removeMcpServer,
} from '@repo/db/queries';
import { killSandbox } from '@repo/sandbox';
import { env } from '@/env';
import { bot } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

/**
 * Self-serve erase: what kyto has derived from someone's conversations, removed
 * by that person, without the bot owner in the loop.
 *
 * Consent is the point. Hack Club confirmed kyto's temporary storage is fine, but
 * until now withdrawing it meant asking the owner to delete memories on the
 * dashboard and then waiting out the ~30-day `thread_thinking` retention window.
 * "Ask the admin and wait a month" is not a consent withdrawal mechanism.
 *
 * Two things bound what this can honestly do:
 *
 *  - `thread_thinking` is keyed by THREAD, not user, and a channel thread's
 *    reasoning is derived from everyone who was in it. So only the user's own DM
 *    channel with kyto is erased. Reasoning in shared channels ages out on the
 *    normal retention window, and `summarize()` says so rather than implying a
 *    clean sweep.
 *  - A PROMOTED (global) memory belongs to the bot owner now; custody transfer is
 *    what stops "get it promoted, then rewrite it". Those are reported back by
 *    title so the user can ask, never silently left behind unmentioned.
 */

export interface EraseResult {
  /** Titles of promoted memories that only the bot owner can now remove. */
  promotedMemories: string[];
  removed: {
    chatgptAccount: boolean;
    customInstructions: boolean;
    mcpServers: number;
    memories: number;
    modelKeys: number;
    sandboxes: number;
    /** DM threads whose compacted history (lib/agent/compaction) was deleted. */
    summarizedThreads: number;
    thinkingThreads: number;
  };
}

/** What `eraseUserData` will touch, so the confirmation can be specific. */
export interface ErasePreview {
  customInstructions: boolean;
  mcpServers: number;
  modelKeys: number;
  privateMemories: number;
  promotedMemories: number;
}

export async function previewUserData(userId: string): Promise<ErasePreview> {
  const [memories, mcpServers, modelKeys, customization] = await Promise.all([
    listMemoriesByAuthor(userId).catch(() => []),
    listMcpServers(userId).catch(() => []),
    listUserModelCredentials(userId).catch(() => []),
    getUserCustomization(userId).catch(() => undefined),
  ]);
  return {
    customInstructions: Boolean(customization?.prompt),
    mcpServers: mcpServers.length,
    modelKeys: modelKeys.length,
    privateMemories: memories.filter((memory) => !memory.isGlobal).length,
    promotedMemories: memories.filter((memory) => memory.isGlobal).length,
  };
}

/**
 * Erase this user's data. `includeSettings` also removes what they configured
 * (custom instructions, MCP servers, their own model keys, a linked ChatGPT
 * account) — kept separate because someone who wants kyto to forget what it
 * learned about them does not necessarily want their API keys deleted too.
 *
 * Reminders and hosted sites are deliberately NOT touched: those are live things
 * other people may depend on, and silently cancelling them is a surprise, not a
 * privacy win. They are already individually deletable from App Home.
 */
export async function eraseUserData({
  includeSettings,
  userId,
}: {
  includeSettings: boolean;
  userId: string;
}): Promise<EraseResult> {
  const authored = await listMemoriesByAuthor(userId).catch(() => []);
  const promotedMemories = authored
    .filter((memory) => memory.isGlobal)
    .map((memory) => memory.title);

  const memoryCount = await deletePrivateMemoriesByAuthor(userId).catch(
    (error: unknown) => {
      logger.error(
        { err: errorMessage(error), userId },
        '[erase] failed to delete memories'
      );
      return 0;
    }
  );

  // The user's DM channel with kyto: the one conversation whose derived text is
  // unambiguously theirs alone. openDM is idempotent and returns the existing
  // channel, so this does not create anything.
  const dmChannelId = await bot
    .openDM(userId)
    .then((thread) => thread.id.split(':')[1])
    .catch((error: unknown) => {
      logger.warn(
        { err: errorMessage(error), userId },
        '[erase] could not resolve the DM channel; skipping thread data'
      );
      return;
    });

  let thinkingThreads = 0;
  let summarizedThreads = 0;
  let sandboxes = 0;
  if (dmChannelId) {
    thinkingThreads = await deleteThinkingForChannel(dmChannelId).catch(
      (error: unknown) => {
        logger.error(
          { err: errorMessage(error), userId },
          '[erase] failed to delete thread thinking'
        );
        return 0;
      }
    );
    // A compacted thread summary is the same class of derived text as the
    // reasoning cache — kyto's own paraphrase of what was said — so it goes on
    // the same terms and by the same channel-scoped rule.
    summarizedThreads = await deleteSummariesForChannel(dmChannelId).catch(
      (error: unknown) => {
        logger.error(
          { err: errorMessage(error), userId },
          '[erase] failed to delete thread summaries'
        );
        return 0;
      }
    );
    sandboxes = await eraseDmSandboxes({ dmChannelId, userId });
  }

  const settings = includeSettings
    ? await eraseSettings(userId)
    : {
        chatgptAccount: false,
        customInstructions: false,
        mcpServers: 0,
        modelKeys: 0,
      };

  logger.info(
    {
      ...settings,
      memoryCount,
      sandboxes,
      summarizedThreads,
      thinkingThreads,
      userId,
    },
    '[erase] user erased their own data'
  );

  return {
    promotedMemories,
    removed: {
      ...settings,
      memories: memoryCount,
      sandboxes,
      summarizedThreads,
      thinkingThreads,
    },
  };
}

/**
 * Kill the E2B sandboxes behind the user's DM threads, then forget their ids.
 * Order matters: dropping the rows first would orphan paused sandboxes that still
 * hold the user's files, with nothing left pointing at them to clean up.
 */
async function eraseDmSandboxes({
  dmChannelId,
  userId,
}: {
  dmChannelId: string;
  userId: string;
}): Promise<number> {
  const rows = await listThreadSandboxesForChannel(dmChannelId).catch(
    (error: unknown) => {
      logger.error(
        { err: errorMessage(error), userId },
        '[erase] failed to list thread sandboxes'
      );
      return [];
    }
  );
  let killed = 0;
  for (const row of rows) {
    // Killing is E2B-only: local/ssh providers have no sandbox ids to kill. The
    // DB row is cleared either way.
    if (env.E2B_API_KEY) {
      await killSandbox(row.sandboxId, env.E2B_API_KEY).catch(
        (error: unknown) => {
          // Already gone (expired, reaped) is the common case and not a failure.
          logger.info(
            { err: errorMessage(error), sandboxId: row.sandboxId },
            '[erase] sandbox was already gone'
          );
        }
      );
    }
    await clearThreadSandbox(row.threadId).catch(() => undefined);
    killed += 1;
  }
  return killed;
}

async function eraseSettings(userId: string): Promise<{
  chatgptAccount: boolean;
  customInstructions: boolean;
  mcpServers: number;
  modelKeys: number;
}> {
  const [servers, credentials] = await Promise.all([
    listMcpServers(userId).catch(() => []),
    listUserModelCredentials(userId).catch(() => []),
  ]);
  await clearUserCustomization(userId).catch(() => undefined);
  for (const server of servers) {
    await removeMcpServer({ name: server.name, userId }).catch(() => undefined);
  }
  for (const credential of credentials) {
    await deleteUserModelCredential({
      provider: credential.provider,
      userId,
    }).catch(() => undefined);
  }
  await deleteChatgptAccount(userId).catch(() => undefined);
  return {
    chatgptAccount: true,
    customInstructions: true,
    mcpServers: servers.length,
    modelKeys: credentials.length,
  };
}

/** A plain-language account of what just happened, for the App Home confirmation. */
export function summarize(result: EraseResult): string {
  const { removed } = result;
  const lines = [
    `• ${removed.memories} saved ${removed.memories === 1 ? 'memory' : 'memories'} deleted`,
    `• reasoning cache cleared for ${removed.thinkingThreads} of your DM ${removed.thinkingThreads === 1 ? 'thread' : 'threads'}`,
    `• compacted history deleted for ${removed.summarizedThreads} of your DM ${removed.summarizedThreads === 1 ? 'thread' : 'threads'}`,
    `• ${removed.sandboxes} sandbox ${removed.sandboxes === 1 ? 'workspace' : 'workspaces'} destroyed`,
  ];
  if (removed.customInstructions) {
    lines.push(
      `• custom instructions, ${removed.mcpServers} MCP ${removed.mcpServers === 1 ? 'server' : 'servers'}, ${removed.modelKeys} model ${removed.modelKeys === 1 ? 'key' : 'keys'} and any linked ChatGPT account removed`
    );
  }
  // Never let this read as a clean sweep when it isn't.
  lines.push(
    "• kyto's reasoning and compacted history in SHARED channels are keyed by thread, not by person, and derived from everyone who was in it — they aren't deleted here, and age out on their own within about 30 days"
  );
  if (result.promotedMemories.length > 0) {
    lines.push(
      `• ${result.promotedMemories.length} of your memories were promoted to workspace-wide and now belong to the bot owner, so only they can remove them: ${result.promotedMemories.map((title) => `\`${title}\``).join(', ')}`
    );
  }
  lines.push(
    '\nSlack still holds the messages themselves — kyto reads your thread as context every turn and never stored a copy. Delete a message in Slack and it is gone from what kyto can see.'
  );
  return lines.join('\n');
}
