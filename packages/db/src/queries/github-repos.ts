import { eq, inArray } from 'drizzle-orm';
import { db } from '../client';
import { type GithubRepo, githubRepos } from '../schema';

export type { GithubRepo } from '../schema';

export async function getGithubRepo(repo: string): Promise<GithubRepo | null> {
  const [row] = await db
    .select()
    .from(githubRepos)
    .where(eq(githubRepos.repo, repo.toLowerCase()))
    .limit(1);
  return row ?? null;
}

/** Claims for several repos at once (the guard checks a whole command). */
export async function getGithubRepos(repos: string[]): Promise<GithubRepo[]> {
  if (repos.length === 0) {
    return [];
  }
  return await db
    .select()
    .from(githubRepos)
    .where(
      inArray(
        githubRepos.repo,
        repos.map((repo) => repo.toLowerCase())
      )
    );
}

export async function listGithubRepos(): Promise<GithubRepo[]> {
  return await db.select().from(githubRepos);
}

/**
 * Record who a repo belongs to. First claim wins — a later mutating command by
 * someone else never re-points an existing claim (that would defeat the gate).
 */
export async function claimGithubRepo(input: {
  editorUserIds?: string[] | null;
  ownerUserId: string;
  repo: string;
}): Promise<GithubRepo> {
  const repo = input.repo.toLowerCase();
  const [row] = await db
    .insert(githubRepos)
    .values({
      editorUserIds: input.editorUserIds ?? null,
      ownerUserId: input.ownerUserId,
      repo,
    })
    .onConflictDoNothing()
    .returning();
  if (row) {
    return row;
  }
  const existing = await getGithubRepo(repo);
  if (!existing) {
    throw new Error(`Failed to claim GitHub repo "${repo}".`);
  }
  return existing;
}

export async function setGithubRepoEditors(input: {
  editorUserIds: string[] | null;
  repo: string;
}): Promise<void> {
  await db
    .update(githubRepos)
    .set({ editorUserIds: input.editorUserIds })
    .where(eq(githubRepos.repo, input.repo.toLowerCase()));
}

export async function deleteGithubRepoClaim(repo: string): Promise<void> {
  await db.delete(githubRepos).where(eq(githubRepos.repo, repo.toLowerCase()));
}
