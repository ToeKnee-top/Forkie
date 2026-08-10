import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle as Thread } from '@/harness';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

const MAX_CONTENT_CHARS = 20_000;

// Slack workspace/message/file URLs (e.g. foo.slack.com, files.slack.com) —
// these require an authenticated session, so fetchUrl can't read them.
function isSlackLink(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'slack.com' || host.endsWith('.slack.com');
  } catch {
    return false;
  }
}

const permalinkSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
  permalink: z.string().optional(),
});

function channelIdFromThread(thread: Thread): string | undefined {
  const [platform, channelId] = thread.id.split(':');
  return platform === 'slack' ? channelId : undefined;
}

export function getPermalinkTool({ thread }: { thread: Thread }) {
  return tool({
    description:
      'Get a shareable Slack permalink for a message in the current channel, e.g. to reference it elsewhere.',
    inputSchema: z.object({
      messageTs: z
        .string()
        .min(1)
        .describe('Timestamp (ts) of the message, e.g. 1781599802.270109.'),
    }),
    execute: async ({ messageTs }) => {
      try {
        const channelId = channelIdFromThread(thread);
        if (!channelId) {
          return {
            error: 'Could not resolve a Slack channel for this thread.',
            success: false,
          };
        }
        const result = permalinkSchema.parse(
          await slack.webClient.apiCall('chat.getPermalink', {
            channel: channelId,
            message_ts: messageTs,
          })
        );
        if (!(result.ok && result.permalink)) {
          return {
            error: `Could not get permalink: ${result.error ?? 'unknown'}`,
            success: false,
          };
        }
        return { permalink: result.permalink, success: true };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[getPermalink] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

/**
 * Fetch a URL as readable text (HTML is stripped to its text content). Throws
 * on a Slack link or a non-OK response. Shared by the `fetchUrl` tool and by
 * 'script' reminders, which post a URL's content on a schedule.
 */
export async function fetchUrlText(url: string): Promise<{
  content: string;
  contentType: string;
  truncated: boolean;
}> {
  // Slack message/file links aren't publicly fetchable (they 302 to a login
  // wall), so callers get pointed at the Slack read tools instead of markup.
  if (isSlackLink(url)) {
    throw new Error(
      "That's a Slack link, which isn't publicly fetchable. Use Slack tools instead: readConversationHistory for a message/thread (the URL path is /archives/<CHANNEL>/p<TS> — the ts is the digits with a dot before the last 6), or getFile for a file link."
    );
  }
  const response = await fetch(url, {
    headers: { 'User-Agent': 'forkie-slack-bot' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();
  // Strip tags for HTML so the reader gets readable text, not markup.
  const text = contentType.includes('text/html')
    ? raw
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : raw;
  const truncated = text.length > MAX_CONTENT_CHARS;
  return {
    content: truncated ? text.slice(0, MAX_CONTENT_CHARS) : text,
    contentType,
    truncated,
  };
}

export function fetchUrlTool() {
  return tool({
    description:
      'Fetch the raw text content of a specific URL the user pasted or referenced. Use this instead of a web search when you already have the exact link.',
    inputSchema: z.object({
      url: z.string().url().describe('The URL to fetch.'),
    }),
    execute: async ({ url }) => {
      try {
        return { ...(await fetchUrlText(url)), success: true };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[fetchUrl] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
