import type { SandboxContext } from '@repo/ai';
import {
  deleteGithubRepoClaim,
  getGithubRepo,
  listGithubRepos,
  setGithubRepoEditors,
} from '@repo/db/queries';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import { githubAuthHint } from '@/lib/github/diagnose';
import { GITHUB_LOGIN, guardGithubCommand } from '@/lib/github/guard';
import { disarmFetchedRepos } from '@/lib/sandbox/git-safety';
import { errorMessage } from '@/lib/utils/error';
import { canEdit, editorsSchema, parseEditors } from './editors';

// gh/git are pre-authenticated inside the sandbox WITHOUT the token ever being
// there: LazySandbox brokers the real GITHUB token via E2B egress rules (the
// proxy rewrites the Authorization header on outbound GitHub requests), and the
// sandbox env only holds an inert placeholder. Because the secret is not in the
// sandbox at all, a full shell (piping, jq, etc.) is safe here — `echo $GH_TOKEN`
// only ever reveals the placeholder, so the char-at-a-time drip attack is moot.
//
// What the token DOESN'T carry is any notion of which Slack user is asking, so
// every write goes through the ownership gate first (lib/github/guard.ts).
const MAX_OUTPUT_CHARS = 8000;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
    : text;
}

export function ghTool({
  getSandboxContext,
  isOwner,
  threadId,
  userId,
}: {
  getSandboxContext: () => SandboxContext;
  isOwner: boolean;
  /** Recorded on a queued approval request so the owner can read the thread. */
  threadId?: string;
  /** The Slack user this turn is running for — the identity writes are gated on. */
  userId: string;
}) {
  return tool({
    description: `Run a \`gh\` (GitHub CLI) command in the sandbox. gh and git are already authenticated (credentials are brokered at the network layer — never ask for a token). On GitHub you ARE the account \`${GITHUB_LOGIN}\`: repos, PRs, issues, and commits under that name are your own work, so don't describe it as some other person. It's a real shell, so piping/filtering works, e.g. \`gh pr list --repo owner/repo | grep foo\` or \`gh api repos/o/r/issues --jq '.[].title'\`. For external contributions, fork first and push branches to the fork, then open a PR. A repo you set up for someone belongs to them: anyone can read it through you, but only they, their named editors, and the bot owner can have you write to it — you'll be refused otherwise, and that refusal is final.`,
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .describe('Shell command using gh and/or pipes to other commands.'),
    }),
    execute: async ({ command }, { abortSignal }) => {
      if (!env.GH_TOKEN) {
        return {
          error: 'gh requires GH_TOKEN to be configured on the host.',
          success: false,
        };
      }
      try {
        const context = getSandboxContext();
        const guard = await guardGithubCommand({
          command,
          context,
          isOwner,
          threadId,
          userId,
          workingDirectory: context.sessionWorkDir,
        });
        if (!guard.allowed) {
          return { error: guard.reason, success: false };
        }
        const result = await context.session.run({
          abortSignal,
          command,
          workingDirectory: context.sessionWorkDir,
        });
        if (result.exitCode === 0) {
          await guard.claim();
        }
        // A `gh repo clone` / `gh release download` can drop a repo (and its
        // hooks) into the workspace.
        await disarmFetchedRepos({
          abortSignal,
          command,
          context,
          workingDirectory: context.sessionWorkDir,
        });
        return {
          exitCode: result.exitCode,
          // A revoked brokered token fails in ways that read like a missing
          // repo or a broken sandbox; say what actually happened.
          hint: githubAuthHint({
            command,
            exitCode: result.exitCode,
            stderr: result.stderr,
          }),
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

/**
 * Manage the repo claims the gate enforces: see who owns what, let other people
 * in, or drop a claim entirely. Without this a claim would be a one-way door —
 * the creator could never share a repo or hand it back.
 */
export function githubAccessTool({
  isOwner,
  userId,
}: {
  isOwner: boolean;
  userId: string;
}) {
  return tool({
    description:
      "Manage who can have you WRITE to a GitHub repo you set up for someone. `list` shows the claimed repos and who they belong to; `editors` sets the people allowed to change a repo alongside its owner; `release` drops the claim so anyone can have you write to it again. Only a repo's owner and the bot owner can change or release it.",
    inputSchema: z.object({
      action: z
        .enum(['list', 'editors', 'release'])
        .describe('What to do with the claim.'),
      editors: editorsSchema,
      repo: z
        .string()
        .optional()
        .describe('The repo as owner/name. Required for editors and release.'),
    }),
    execute: async ({ action, editors, repo }) => {
      if (action === 'list') {
        const rows = await listGithubRepos();
        return {
          repos: rows.map((row) => ({
            editors: row.editorUserIds ?? [],
            owner: row.ownerUserId,
            repo: row.repo,
          })),
          summary:
            rows.length === 0
              ? 'No GitHub repos are claimed yet.'
              : `${rows.length} claimed repo(s).`,
        };
      }
      if (!repo) {
        return { error: 'Provide the repo as owner/name.', success: false };
      }
      const claim = await getGithubRepo(repo);
      if (!claim) {
        return {
          error: `"${repo}" isn't claimed by anyone, so there's nothing to change — writes to it aren't gated.`,
          success: false,
        };
      }
      if (
        !canEdit({
          editorUserIds: claim.editorUserIds ?? null,
          isOwner,
          ownerUserId: claim.ownerUserId,
          userId,
        })
      ) {
        return {
          error: `"${claim.repo}" belongs to <@${claim.ownerUserId}>. Only they, their editors, and the bot owner can change who may write to it.`,
          success: false,
        };
      }
      if (action === 'release') {
        await deleteGithubRepoClaim(claim.repo);
        return {
          released: claim.repo,
          success: true,
          summary: `Released "${claim.repo}" — writes to it are no longer restricted.`,
        };
      }
      const parsed = parseEditors(editors);
      if (!parsed.ok) {
        return { error: parsed.error, success: false };
      }
      await setGithubRepoEditors({
        editorUserIds: parsed.editors,
        repo: claim.repo,
      });
      return {
        editors: parsed.editors ?? [],
        success: true,
        summary: parsed.editors
          ? `Editors for "${claim.repo}": ${parsed.editors.map((id) => `<@${id}>`).join(', ')}.`
          : `Cleared the editor list for "${claim.repo}" — only <@${claim.ownerUserId}> and the bot owner can write to it now.`,
      };
    },
  });
}
