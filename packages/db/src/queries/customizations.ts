import { eq } from 'drizzle-orm';
import { db } from '../client';
import { type UserCustomization, userCustomizations } from '../schema';

export async function getUserCustomization(
  userId: string
): Promise<UserCustomization | null> {
  const rows = await db
    .select({
      prompt: userCustomizations.prompt,
      showUsageFooter: userCustomizations.showUsageFooter,
    })
    .from(userCustomizations)
    .where(eq(userCustomizations.userId, userId))
    .limit(1);

  return rows[0] ?? null;
}

/** Toggle the per-turn usage footer for a user (upserts a row if needed). */
export async function setUsageFooter(
  userId: string,
  showUsageFooter: boolean
): Promise<void> {
  await db
    .insert(userCustomizations)
    .values({ prompt: '', showUsageFooter, userId })
    .onConflictDoUpdate({
      set: { showUsageFooter, updatedAt: new Date() },
      target: userCustomizations.userId,
    });
}

export async function setUserCustomization(
  userId: string,
  customization: Pick<UserCustomization, 'prompt'>
): Promise<void> {
  await db
    .insert(userCustomizations)
    .values({ prompt: customization.prompt, userId })
    .onConflictDoUpdate({
      set: { prompt: customization.prompt, updatedAt: new Date() },
      target: userCustomizations.userId,
    });
}

export async function clearUserCustomization(userId: string): Promise<void> {
  await db
    .delete(userCustomizations)
    .where(eq(userCustomizations.userId, userId));
}
