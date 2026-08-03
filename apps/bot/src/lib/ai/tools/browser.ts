import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { ensureCloakBrowser } from '@/lib/browser/cloak';
import { errorMessage } from '@/lib/utils/error';

// Browser automation runs the preinstalled `agent-browser` CLI inside the
// sandbox (Chromium + untrusted page automation stay isolated off the host),
// driving a CloakBrowser stealth Chromium over CDP — see lib/browser/cloak.ts.
// agent-browser is stateful: sequential calls in one turn share the same
// browser session (the sandbox lives for the turn). The CLI serves its own,
// always-current usage docs — run `skills get core` first to learn commands.
const MAX_OUTPUT_CHARS = 8000;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
    : text;
}

export function browserTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext | undefined;
}) {
  return tool({
    description:
      'Drive a real web browser in your sandbox: navigate pages, fill forms, click, screenshot, scrape, or test web apps. It runs the agent-browser CLI against a stealth Chromium (CloakBrowser), so most anti-bot walls never challenge you. Pass the agent-browser sub-command and args in `command` (it is run as `agent-browser <command>`). Run `command: "skills get core"` first to load the current workflows and command reference, then issue open/snapshot/click/etc. Sequential calls share one browser session. If a captcha or "verify you are human" checkbox does appear, just interact with it like a person would — snapshot the page, click the checkbox or challenge frame, and carry on. Never tell the user you cannot get past a captcha before you have actually tried clicking it.',
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .describe(
          'Arguments passed to the agent-browser CLI, e.g. "skills get core", "open https://example.com", or "snapshot".'
        ),
    }),
    execute: async ({ command }, { abortSignal }) => {
      const context = getSandboxContext();
      if (!context) {
        return {
          error: 'No active sandbox session is available for browsing.',
          success: false,
        };
      }
      try {
        const ready = await ensureCloakBrowser({ abortSignal, context });
        if (!ready.ok) {
          return { error: ready.error, success: false, summary: ready.error };
        }
        // Forward the turn's abort signal so a browser command that never
        // returns (a page that hangs loading) is killed when the turn is
        // interrupted or the per-attempt watchdog fires — otherwise the agent
        // loop stays blocked awaiting this tool and the whole turn freezes.
        const result = await context.session.run({
          abortSignal,
          command: `agent-browser ${command}`,
          workingDirectory: context.sessionWorkDir,
        });
        return {
          exitCode: result.exitCode,
          stderr: truncate(result.stderr),
          stdout: truncate(result.stdout),
          success: result.exitCode === 0,
          summary:
            result.exitCode === 0
              ? `Ran browser ${command}.`
              : `browser ${command} exited ${result.exitCode}.`,
        };
      } catch (error) {
        return {
          error: errorMessage(error),
          success: false,
          summary: `Browser command failed: ${errorMessage(error)}`,
        };
      }
    },
  });
}
