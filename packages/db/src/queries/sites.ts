import { eq } from 'drizzle-orm';
import { db } from '../client';
import { type Site, sites } from '../schema';

export type { Site } from '../schema';

export async function getSite(name: string): Promise<Site | null> {
  const [row] = await db
    .select()
    .from(sites)
    .where(eq(sites.name, name))
    .limit(1);
  return row ?? null;
}

export async function listSiteOwners(): Promise<Site[]> {
  return await db.select().from(sites);
}

/**
 * Record who owns a site. The first deploy of a name claims it; later deploys by
 * someone already allowed to edit it only update the editor list (when given).
 */
export async function claimSite(input: {
  name: string;
  ownerUserId: string;
  editorUserIds?: string[] | null;
}): Promise<Site> {
  const [row] = await db
    .insert(sites)
    .values({
      editorUserIds: input.editorUserIds ?? null,
      name: input.name,
      ownerUserId: input.ownerUserId,
    })
    .onConflictDoNothing()
    .returning();
  if (row) {
    return row;
  }
  const existing = await getSite(input.name);
  if (!existing) {
    throw new Error(`Failed to claim site "${input.name}".`);
  }
  return existing;
}

export async function setSiteEditors(input: {
  name: string;
  editorUserIds: string[] | null;
}): Promise<void> {
  await db
    .update(sites)
    .set({ editorUserIds: input.editorUserIds })
    .where(eq(sites.name, input.name));
}

export async function deleteSite(name: string): Promise<void> {
  await db.delete(sites).where(eq(sites.name, name));
}
