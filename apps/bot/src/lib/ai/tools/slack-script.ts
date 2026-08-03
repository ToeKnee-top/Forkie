import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { readOnlySlackMethods } from '@/lib/slack-proxy';
import { errorMessage } from '@/lib/utils/error';

const MAX_OUTPUT_CHARS = 12_000;

// The `slack <method> [jsonArgs]` helper is no longer prepended as a shell
// function here — it is installed as a real executable on PATH when the sandbox
// materializes (see slackHelperInstall). That way the plain `bash` tool and
// recurring `bash` reminders can call it too, not just this tool.

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
    : text;
}

export function slackScriptTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description: `Run a bash script in the sandbox that queries Slack READ-ONLY, for aggregate questions that would otherwise need many individual lookups — e.g. "who is in the most channels", "most active user in #x", "how many members does each channel have". A \`slack <method> [jsonArgs]\` command is on PATH; it prints the raw JSON API response. Compose loops, jq, sort, etc. around it. It is strictly read-only (posting/editing/deleting is impossible through it) and the Slack token never enters the sandbox. Handle pagination via response.response_metadata.next_cursor. Allowed methods: ${readOnlySlackMethods().join(', ')} — note there is NO search method, so counting a user's messages means paging conversations.history per channel. Example: \`slack conversations.list '{"limit":1000,"types":"public_channel"}' | jq '.channels | length'\`.

The same \`slack\` command is available to the plain \`bash\` tool and to recurring \`bash\` reminders (each reminder fire gets a fresh proxy token), so a scheduled script can recompute a Slack stat on every run.`,
    inputSchema: z.object({
      script: z
        .string()
        .min(1)
        .describe(
          'Bash script using the preloaded `slack` helper (plus jq/awk/etc.). Print your final answer to stdout.'
        ),
    }),
    execute: async ({ script }, { abortSignal }) => {
      try {
        const context = getSandboxContext();
        const result = await context.session.run({
          abortSignal,
          command: script,
          workingDirectory: context.sessionWorkDir,
        });
        return {
          exitCode: result.exitCode,
          stderr: truncate(result.stderr),
          stdout: truncate(result.stdout),
          success: result.exitCode === 0,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
