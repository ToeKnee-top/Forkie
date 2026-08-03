import { eq } from 'drizzle-orm';
import { db } from '../client';
import type {
  ChatgptAccount,
  ChatgptAccountSecret,
} from '../schema/chatgpt-accounts';
import { userChatgptAccounts } from '../schema/chatgpt-accounts';
import type { CredentialValidationStatus } from '../schema/model-credentials';

export type {
  ChatgptAccount,
  ChatgptAccountSecret,
} from '../schema/chatgpt-accounts';

// Every column except the encrypted token blob. Selecting this explicitly keeps
// token material out of the default read path — and out of anything that logs a
// query result.
const publicColumns = {
  accountLabel: userChatgptAccounts.accountLabel,
  chatgptFirst: userChatgptAccounts.chatgptFirst,
  createdAt: userChatgptAccounts.createdAt,
  lastUsedAt: userChatgptAccounts.lastUsedAt,
  model: userChatgptAccounts.model,
  quotaResetsAt: userChatgptAccounts.quotaResetsAt,
  serviceFallback: userChatgptAccounts.serviceFallback,
  updatedAt: userChatgptAccounts.updatedAt,
  userId: userChatgptAccounts.userId,
  validationMessage: userChatgptAccounts.validationMessage,
  validationStatus: userChatgptAccounts.validationStatus,
};

/** A user's linked account WITHOUT the tokens — for the App Home UI. */
export async function getChatgptAccount(
  userId: string
): Promise<ChatgptAccount | undefined> {
  const rows = await db
    .select(publicColumns)
    .from(userChatgptAccounts)
    .where(eq(userChatgptAccounts.userId, userId))
    .limit(1);
  return rows[0];
}

/**
 * A user's linked account WITH the encrypted token blob. Only the bot's resolver
 * may call this; it decrypts, refreshes, and never persists or logs plaintext.
 */
export async function getChatgptAccountSecret(
  userId: string
): Promise<ChatgptAccountSecret | undefined> {
  const rows = await db
    .select()
    .from(userChatgptAccounts)
    .where(eq(userChatgptAccounts.userId, userId))
    .limit(1);
  return rows[0];
}

export async function upsertChatgptAccount(input: {
  accountLabel: string;
  encryptedTokens: string;
  model: string;
  serviceFallback?: boolean;
  userId: string;
}): Promise<void> {
  await db
    .insert(userChatgptAccounts)
    .values({
      accountLabel: input.accountLabel,
      encryptedTokens: input.encryptedTokens,
      model: input.model,
      serviceFallback: input.serviceFallback ?? false,
      userId: input.userId,
      validationMessage: null,
      validationStatus: 'valid',
    })
    .onConflictDoUpdate({
      set: {
        accountLabel: input.accountLabel,
        encryptedTokens: input.encryptedTokens,
        model: input.model,
        ...(input.serviceFallback === undefined
          ? {}
          : { serviceFallback: input.serviceFallback }),
        validationMessage: null,
        validationStatus: 'valid',
      },
      target: userChatgptAccounts.userId,
    });
}

/** Refresh the stored token blob in place (after an OAuth token refresh). */
export async function updateChatgptTokens(input: {
  encryptedTokens: string;
  userId: string;
}): Promise<void> {
  await db
    .update(userChatgptAccounts)
    .set({ encryptedTokens: input.encryptedTokens })
    .where(eq(userChatgptAccounts.userId, input.userId));
}

/** Change just the model the account runs on, keeping the stored tokens. */
export async function updateChatgptModel(input: {
  model: string;
  userId: string;
}): Promise<void> {
  await db
    .update(userChatgptAccounts)
    .set({ model: input.model })
    .where(eq(userChatgptAccounts.userId, input.userId));
}

export async function setChatgptChatgptFirst(input: {
  chatgptFirst: boolean;
  userId: string;
}): Promise<void> {
  await db
    .update(userChatgptAccounts)
    .set({ chatgptFirst: input.chatgptFirst })
    .where(eq(userChatgptAccounts.userId, input.userId));
}

export async function setChatgptServiceFallback(input: {
  allowed: boolean;
  userId: string;
}): Promise<void> {
  await db
    .update(userChatgptAccounts)
    .set({ serviceFallback: input.allowed })
    .where(eq(userChatgptAccounts.userId, input.userId));
}

/**
 * Remember when the account's plan quota resets, so the attempt is skipped until
 * then rather than retried (and re-retried by the SDK) at the head of every
 * turn. `null` clears it — a successful turn proves the quota is back.
 */
export async function setChatgptQuotaReset(input: {
  resetsAt: Date | null;
  userId: string;
}): Promise<void> {
  await db
    .update(userChatgptAccounts)
    .set({ quotaResetsAt: input.resetsAt })
    .where(eq(userChatgptAccounts.userId, input.userId));
}

export async function setChatgptValidation(input: {
  message?: string | null;
  status: CredentialValidationStatus;
  userId: string;
}): Promise<void> {
  await db
    .update(userChatgptAccounts)
    .set({
      validationMessage: input.message ?? null,
      validationStatus: input.status,
      ...(input.status === 'valid' ? { lastUsedAt: new Date() } : {}),
    })
    .where(eq(userChatgptAccounts.userId, input.userId));
}

export async function deleteChatgptAccount(userId: string): Promise<void> {
  await db
    .delete(userChatgptAccounts)
    .where(eq(userChatgptAccounts.userId, userId));
}
