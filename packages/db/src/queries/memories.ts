import { and, asc, desc, eq, or } from 'drizzle-orm';
import { db } from '../client';
import { type Memory, memories } from '../schema';

export type { Memory } from '../schema';

// A memory is visible on someone's turn if they saved it, or if the owner has
// promoted it to global. Nobody else's private notes are ever in scope — that
// isolation is the whole point (see the schema comment).
function visibleTo(userId: string) {
  return or(eq(memories.createdBy, userId), eq(memories.isGlobal, true));
}

// Title + who saved it, for every memory visible on this turn — the lightweight
// index injected into the system prompt. Bodies are fetched separately.
export interface MemoryIndexEntry {
  createdBy: string;
  isGlobal: boolean;
  summary: string;
  title: string;
}

export async function listMemoryIndex(
  userId: string
): Promise<MemoryIndexEntry[]> {
  return await db
    .select({
      createdBy: memories.createdBy,
      isGlobal: memories.isGlobal,
      summary: memories.summary,
      title: memories.title,
    })
    .from(memories)
    .where(visibleTo(userId))
    .orderBy(asc(memories.createdAt));
}

/**
 * Resolve a title to a memory this user can actually see. Their OWN memory wins
 * over a global one with the same title — a user's private note is the more
 * specific answer, and it also means promoting someone's memory can never
 * silently shadow another person's.
 */
export async function getMemory({
  title,
  userId,
}: {
  title: string;
  userId: string;
}): Promise<Memory | null> {
  const rows = await db
    .select()
    .from(memories)
    .where(and(eq(memories.title, title), visibleTo(userId)))
    // Own row (createdBy === userId) sorts before a global one: `isGlobal`
    // descending puts globals first, so order by it ascending instead and rely
    // on the author match being the non-global row in the common case.
    .orderBy(asc(memories.isGlobal))
    .limit(2);
  return rows.find((row) => row.createdBy === userId) ?? rows.at(0) ?? null;
}

/**
 * Save a new memory, private to `createdBy`. Returns null if that person
 * already has one with this title (they should edit it instead) — saves are
 * create-only so an existing memory is never silently clobbered.
 */
export async function createMemory(input: {
  title: string;
  summary: string;
  body: string;
  createdBy: string;
}): Promise<Memory | null> {
  const [row] = await db
    .insert(memories)
    .values(input)
    .onConflictDoNothing({ target: [memories.createdBy, memories.title] })
    .returning();
  return row ?? null;
}

/**
 * Update one memory by id. The caller decides who may do this — a global
 * memory belongs to the bot owner, a private one to its author.
 */
export async function updateMemory(input: {
  id: number;
  summary?: string;
  body?: string;
}): Promise<Memory | null> {
  const patch: { summary?: string; body?: string } = {};
  if (input.summary !== undefined) {
    patch.summary = input.summary;
  }
  if (input.body !== undefined) {
    patch.body = input.body;
  }
  if (Object.keys(patch).length === 0) {
    return await getMemoryById(input.id);
  }
  const [row] = await db
    .update(memories)
    .set(patch)
    .where(eq(memories.id, input.id))
    .returning();
  return row ?? null;
}

export async function deleteMemory(id: number): Promise<Memory | null> {
  const [row] = await db
    .delete(memories)
    .where(eq(memories.id, id))
    .returning();
  return row ?? null;
}

export async function getMemoryById(id: number): Promise<Memory | null> {
  const [row] = await db
    .select()
    .from(memories)
    .where(eq(memories.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Promote a memory to global (or demote it back). Owner-only, enforced by the
 * dashboard — this query layer has no notion of who is asking.
 */
export async function setMemoryGlobal({
  id,
  isGlobal,
}: {
  id: number;
  isGlobal: boolean;
}): Promise<Memory | null> {
  const [row] = await db
    .update(memories)
    .set({ isGlobal, promotedAt: isGlobal ? new Date() : null })
    .where(eq(memories.id, id))
    .returning();
  return row ?? null;
}

/** Every memory, newest first — the dashboard's review list. */
/**
 * Everything this user saved, promoted or not — what a "what do you know about
 * me" listing and a self-serve erase both need to reason about.
 */
export async function listMemoriesByAuthor(userId: string): Promise<Memory[]> {
  return await db
    .select()
    .from(memories)
    .where(eq(memories.createdBy, userId))
    .orderBy(asc(memories.createdAt));
}

/**
 * Delete this user's own PRIVATE memories, returning how many went.
 *
 * Promoted (global) memories are deliberately left alone: promotion transfers
 * custody to the bot owner, and letting the original author still delete one
 * would reopen the "get it promoted, then change it" hole the custody rule
 * closes. The caller is expected to TELL the user which promoted memories remain
 * so they can ask the owner — silently leaving data behind after someone asks to
 * be forgotten would be the worse failure.
 */
export async function deletePrivateMemoriesByAuthor(
  userId: string
): Promise<number> {
  const removed = await db
    .delete(memories)
    .where(and(eq(memories.createdBy, userId), eq(memories.isGlobal, false)))
    .returning({ id: memories.id });
  return removed.length;
}

export async function listAllMemories(): Promise<Memory[]> {
  return await db.select().from(memories).orderBy(desc(memories.createdAt));
}
