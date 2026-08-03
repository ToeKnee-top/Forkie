import type { SandboxContext } from '@repo/ai';
import { mayHaveFetchedRepo, sanitizeGitRepos } from '@repo/sandbox';
import logger from '@/lib/logger';

/**
 * Disarm any git repo a tool call just brought into the sandbox — hooks and the
 * config keys that name a command to run. The model is never asked to do this;
 * the tools call it themselves after any command that could have fetched or
 * extracted a repository (see `mayHaveFetchedRepo`).
 *
 * Best effort and non-fatal: the tool's own result is returned to the model
 * whatever happens here.
 */
export async function disarmFetchedRepos({
  abortSignal,
  command,
  context,
  workingDirectory,
}: {
  abortSignal?: AbortSignal;
  /** The command that just ran; skipped when it can't have fetched a repo. */
  command?: string;
  context: SandboxContext;
  /** Extra directory to scan alongside the workspace. */
  workingDirectory?: string;
}): Promise<void> {
  if (command !== undefined && !mayHaveFetchedRepo(command)) {
    return;
  }
  const dirs = [context.sessionWorkDir];
  if (
    workingDirectory &&
    !workingDirectory.startsWith(context.sessionWorkDir)
  ) {
    dirs.push(workingDirectory);
  }
  const result = await sanitizeGitRepos({
    abortSignal,
    dirs,
    runner: context.session,
  });
  if (result && (result.hooks > 0 || result.keys.length > 0)) {
    logger.info(
      { hooks: result.hooks, keys: result.keys, repos: result.repos },
      '[sandbox] stripped git hooks / executable config from a fetched repo'
    );
  }
}
