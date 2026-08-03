import { CommandExitError, Sandbox } from '@e2b/code-interpreter';
import { sandboxConfig as config } from './config';

const COMMAND_TIMEOUT_MS = 4 * 60 * 1000;

export interface RunOnceResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/**
 * Runs a single shell command in a brand-new, throwaway sandbox and kills it
 * immediately after — for callers outside a turn's lifecycle that just need one
 * command's output and have no thread sandbox to reuse (e.g. a recurring bash
 * reminder whose originating thread's sandbox has since expired).
 */
/**
 * Kill a sandbox by id, whether running or paused. Resolves false when it no
 * longer exists — the common case for the idle-sandbox reaper.
 */
export async function killSandbox(
  sandboxId: string,
  apiKey: string
): Promise<boolean> {
  return await Sandbox.kill(sandboxId, { apiKey });
}

export async function runOnce(
  command: string,
  apiKey: string
): Promise<RunOnceResult> {
  const sandbox = await Sandbox.create(config.template, {
    apiKey,
    metadata: { app: 'kyto', purpose: 'run-once' },
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  try {
    const result = await sandbox.commands.run(command, {
      cwd: config.workdir,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    return {
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } catch (error) {
    if (error instanceof CommandExitError) {
      return {
        exitCode: error.exitCode,
        stderr: error.stderr,
        stdout: error.stdout,
      };
    }
    throw error;
  } finally {
    await sandbox.kill().catch(() => undefined);
  }
}
