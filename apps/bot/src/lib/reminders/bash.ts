import type { Reminder } from '@repo/db/queries';
import { env } from '@/env';
import { brokerableGithubToken } from '@/lib/github/token';
import logger from '@/lib/logger';
import { createSandbox } from '@/lib/sandbox/provider';
import { threadSandboxStore, withThreadSandbox } from '@/lib/sandbox/store';
import {
  registerProxyToken,
  revokeProxyToken,
  slackHelperInstall,
  slackProxyEnv,
} from '@/lib/slack-proxy';

const MAX_OUTPUT_CHARS = 4000;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)`
    : text;
}

function format({
  exitCode,
  stderr,
  stdout,
}: {
  exitCode: number;
  stderr: string;
  stdout: string;
}): string {
  const parts = [
    truncate(stdout.trim()),
    stderr.trim() ? `stderr:\n${truncate(stderr.trim())}` : '',
  ].filter(Boolean);
  const output = parts.join('\n\n') || '(no output)';
  return exitCode === 0 ? output : `${output}\n\n(exit code ${exitCode})`;
}

/**
 * Run a bash reminder's command and return its exact output.
 *
 * It runs in the PERSISTENT SANDBOX OF THE THREAD the reminder was created in,
 * so the command can use scripts and data kyto wrote while setting the reminder
 * up. The thread's sandbox lock is held for the duration — a live turn in that
 * same thread must not pause the sandbox mid-command.
 *
 * The command can also query Slack read-only via the `slack <method>` helper: a
 * FRESH proxy token is minted for this fire and revoked immediately after, since
 * the token from the turn that created the reminder was revoked when that turn
 * ended. Without this a scheduled script could only ever 401.
 *
 * A reminder created before thread sandboxes existed (no `threadId`) falls back
 * to a throwaway sandbox, which starts empty every fire.
 */
export async function runReminderBash(reminder: Reminder): Promise<string> {
  const command = reminder.command;
  if (!command) {
    throw new Error("Bash reminder is missing a 'command'.");
  }
  if (!reminder.threadId) {
    // One-shot job with no thread sandbox to reuse. Use the configured provider
    // (local, ssh, or E2B), run once, and tear it down.
    const sandbox = await createSandbox(env, { logger });
    try {
      return format(await sandbox.run({ command }));
    } finally {
      await sandbox.destroy().catch(() => undefined);
    }
  }
  const threadId = reminder.threadId;
  return await withThreadSandbox(threadId, async () => {
    const secret = env.SITES_ENABLED ? registerProxyToken() : undefined;
    const sandbox = await createSandbox(env, {
      bootstrapCommand: secret ? slackHelperInstall() : undefined,
      baseEnv: secret ? slackProxyEnv(secret, env.SITES_PUBLIC_HOST) : {},
      githubToken: await brokerableGithubToken(),
      logger,
      sessionId: threadId,
      store: threadSandboxStore,
    });
    try {
      return format(await sandbox.run({ command }));
    } finally {
      revokeProxyToken(secret);
      // Pauses (not kills) the thread's sandbox — same as a turn does.
      await sandbox.destroy().catch(() => undefined);
    }
  });
}
