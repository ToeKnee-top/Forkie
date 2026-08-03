import { tool } from 'ai';
import { z } from 'zod';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';
import { fetchUrlText } from './url';

/**
 * On-demand port of QuackX's stardance devlog detector. QuackX watched every
 * message and auto-posted a "Devlog Boosted" card; in kyto the watch+post part
 * is a behaviour change (see the feature/README note), so this ships as an
 * explicit tool instead: the agent calls it when a stardance devlog link turns
 * up, and it returns the parsed summary + ready-to-post Block Kit. The agent
 * (and the human) decide whether/how to post it.
 */
const STARENCE_HOST = 'stardance.hackclub.com';

function extractStardanceLink(text: string): string | null {
  // Matches both bare links (https://stardance.hackclub.com/...) and styled
  // Slack links (<https://stardance.hackclub.com/...|Label>). Stopping the
  // match at `>` handles the styled-link terminator, then we strip any
  // trailing `|Label` suffix and stray punctuation.
  const match = text.match(/https?:\/\/stardance\.hackclub\.com\/[^\s>]+/);
  if (!match) return null;
  return match[0]
    .replace(/\|.*$/, '')
    .replace(/[>\)\]]+$/, '');
}

function parseDevlog(content: string): {
  summary: string;
  progress: string[];
  nextSteps: string[];
} {
  const lines = content.split('\n').filter((line) => line.trim());
  const progress = lines.filter((line) =>
    /built|made|added|fixed|implemented/i.test(line)
  );
  const nextSteps = lines.filter((line) =>
    /next|todo|plan|will/i.test(line)
  );
  return {
    summary: lines.slice(0, 3).join('\n'),
    progress: progress.slice(0, 3),
    nextSteps: nextSteps.slice(0, 3),
  };
}

// Block Kit "Devlog Boosted" card, mirroring QuackX's formatDevlogBlocks so a
// channel post of a devlog looks the way the community is used to.
export function buildDevlogBlocks(
  userId: string | undefined,
  url: string,
  title: string,
  parsed: { summary: string; progress: string[]; nextSteps: string[] }
): Record<string, unknown>[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: '📔 *New Devlog Boosted*' } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Author:* ${userId ? `<@${userId}>` : 'unknown'}\n*Title:* ${title}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Summary:*\n${parsed.summary || 'No summary'}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Progress:*\n• ${parsed.progress.join('\n• ') || 'None'}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Next Steps:*\n• ${parsed.nextSteps.join('\n• ') || 'None'}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Devlog' },
          url,
        },
      ],
    },
  ];
}

export function devlogTool() {
  return tool({
    description:
      "Fetch and summarize a Stardance devlog (stardance.hackclub.com). Detect when a message contains such a link and want it summed up, or when someone pastes one. Returns the title, a short summary, recent progress, next steps, and a ready-to-post 'Devlog Boosted' Block Kit card.",
    inputSchema: z.object({
      text: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          'The message or text that contains the stardance.hackclub.com link, or the URL itself.'
        ),
    }),
    execute: async ({ text }) => {
      try {
        const url = extractStardanceLink(text);
        if (!url) {
          return {
            error: "Couldn't find a stardance.hackclub.com link in that text.",
            success: false,
          };
        }
        const fetched = await fetchUrlText(url);
        // First line of the page text is a reasonable title fallback.
        let title = 'Untitled Devlog';
        const firstLine = fetched.content.match(/^.+/m);
        if (firstLine) title = firstLine[0].slice(0, 120);
        const parsed = parseDevlog(fetched.content);
        const blocks = buildDevlogBlocks(undefined, url, title, parsed);
        return {
          blocks,
          posted: false,
          title,
          url,
          summary: parsed.summary,
          progress: parsed.progress,
          nextSteps: parsed.nextSteps,
          note: 'Returned ready-to-post Block Kit in `blocks`. Post it to the channel with the postMessage tool if the user wants a Devlog Boosted card.',
          success: true,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[devlog] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

// Re-export for consumers that only need the linker/parser (e.g. a future
// auto-watch feature module).
export { extractStardanceLink, parseDevlog, STARENCE_HOST };
