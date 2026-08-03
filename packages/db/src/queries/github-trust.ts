import { and, desc, eq } from 'drizzle-orm';
import { db } from '../client';
import {
  type GithubRequest,
  type GithubTrust,
  githubRequests,
  githubTrust,
} from '../schema';

export type { GithubRequest, GithubTrust } from '../schema';

export async function getGithubTrust(
  userId: string
): Promise<GithubTrust | null> {
  const [row] = await db
    .select()
    .from(githubTrust)
    .where(eq(githubTrust.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function listGithubTrust(): Promise<GithubTrust[]> {
  return await db
    .select()
    .from(githubTrust)
    .orderBy(desc(githubTrust.createdAt));
}

/**
 * Grant trust. `allRepos` is the blanket grant; `repo` adds a single repo to
 * the person's list. Both are additive — approving one request never revokes
 * an earlier grant.
 */
export async function grantGithubTrust({
  allRepos,
  grantedBy,
  repo,
  userId,
}: {
  allRepos?: boolean;
  grantedBy: string;
  repo?: string;
  userId: string;
}): Promise<GithubTrust | null> {
  const existing = await getGithubTrust(userId);
  const repos = new Set(existing?.repos ?? []);
  if (repo) {
    repos.add(repo.toLowerCase());
  }
  const values = {
    allRepos: allRepos ?? existing?.allRepos ?? false,
    grantedBy,
    repos: [...repos],
    userId,
  };
  const [row] = await db
    .insert(githubTrust)
    .values(values)
    .onConflictDoUpdate({
      set: {
        allRepos: values.allRepos,
        grantedBy: values.grantedBy,
        repos: values.repos,
      },
      target: githubTrust.userId,
    })
    .returning();
  return row ?? null;
}

export async function revokeGithubTrust(userId: string): Promise<void> {
  await db.delete(githubTrust).where(eq(githubTrust.userId, userId));
}

/**
 * Record a refused third-party write so the owner can approve it later. An
 * identical pending request is not duplicated — a model that retries the same
 * refused command three times should leave one row in the queue, not three.
 */
export async function recordGithubRequest(input: {
  command: string;
  repo: string;
  threadId?: string;
  userId: string;
}): Promise<GithubRequest | null> {
  const repo = input.repo.toLowerCase();
  const [existing] = await db
    .select()
    .from(githubRequests)
    .where(
      and(
        eq(githubRequests.userId, input.userId),
        eq(githubRequests.repo, repo),
        eq(githubRequests.status, 'pending')
      )
    )
    .limit(1);
  if (existing) {
    return existing;
  }
  const [row] = await db
    .insert(githubRequests)
    .values({ ...input, repo })
    .returning();
  return row ?? null;
}

export async function listGithubRequests(
  status?: string
): Promise<GithubRequest[]> {
  const query = db.select().from(githubRequests);
  const rows = status
    ? await query.where(eq(githubRequests.status, status))
    : await query;
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function getGithubRequest(
  id: number
): Promise<GithubRequest | null> {
  const [row] = await db
    .select()
    .from(githubRequests)
    .where(eq(githubRequests.id, id))
    .limit(1);
  return row ?? null;
}

export async function decideGithubRequest({
  id,
  status,
}: {
  id: number;
  status: 'approved' | 'rejected';
}): Promise<GithubRequest | null> {
  const [row] = await db
    .update(githubRequests)
    .set({ decidedAt: new Date(), status })
    .where(eq(githubRequests.id, id))
    .returning();
  return row ?? null;
}
