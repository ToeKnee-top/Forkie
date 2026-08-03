import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import type { UserMcpServer } from '../schema/mcp';
import { userMcpServers } from '../schema/mcp';

export type { UserMcpServer } from '../schema/mcp';

export function listMcpServers(userId: string): Promise<UserMcpServer[]> {
  return db
    .select()
    .from(userMcpServers)
    .where(eq(userMcpServers.userId, userId));
}

export async function addMcpServer(input: {
  authorization?: string;
  name: string;
  url: string;
  userId: string;
}): Promise<void> {
  await db
    .insert(userMcpServers)
    .values(input)
    .onConflictDoUpdate({
      set: { authorization: input.authorization ?? null, url: input.url },
      target: [userMcpServers.userId, userMcpServers.name],
    });
}

export async function removeMcpServer(input: {
  name: string;
  userId: string;
}): Promise<void> {
  await db
    .delete(userMcpServers)
    .where(
      and(
        eq(userMcpServers.userId, input.userId),
        eq(userMcpServers.name, input.name)
      )
    );
}
