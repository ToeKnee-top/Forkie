import { and, asc, eq } from 'drizzle-orm';
import { db } from '../client';
import type {
  CredentialValidationStatus,
  UserModelCredential,
  UserModelCredentialSecret,
} from '../schema/model-credentials';
import { userModelCredentials } from '../schema/model-credentials';

export type {
  CredentialValidationStatus,
  UserModelCredential,
  UserModelCredentialSecret,
} from '../schema/model-credentials';

// Every column except the ciphertext. Selecting this explicitly (rather than
// `select()` and deleting the field afterwards) is what keeps key material out
// of the default read path — and out of anything that logs a query result.
const publicColumns = {
  baseUrl: userModelCredentials.baseUrl,
  createdAt: userModelCredentials.createdAt,
  keyPreview: userModelCredentials.keyPreview,
  lastUsedAt: userModelCredentials.lastUsedAt,
  model: userModelCredentials.model,
  provider: userModelCredentials.provider,
  serviceFallback: userModelCredentials.serviceFallback,
  updatedAt: userModelCredentials.updatedAt,
  userId: userModelCredentials.userId,
  validationMessage: userModelCredentials.validationMessage,
  validationStatus: userModelCredentials.validationStatus,
};

/** A user's credentials WITHOUT their secrets — for the App Home UI. */
export function listUserModelCredentials(
  userId: string
): Promise<UserModelCredential[]> {
  return db
    .select(publicColumns)
    .from(userModelCredentials)
    .where(eq(userModelCredentials.userId, userId))
    .orderBy(asc(userModelCredentials.createdAt));
}

/**
 * A user's credentials WITH their encrypted secrets, oldest first (that order is
 * the routing order). Only the bot's BYOK resolver may call this; it decrypts
 * and never persists or logs the plaintext.
 */
export function listUserModelCredentialSecrets(
  userId: string
): Promise<UserModelCredentialSecret[]> {
  return db
    .select()
    .from(userModelCredentials)
    .where(eq(userModelCredentials.userId, userId))
    .orderBy(asc(userModelCredentials.createdAt));
}

export async function upsertUserModelCredential(input: {
  baseUrl?: string | null;
  encryptedKey: string;
  keyPreview: string;
  model: string;
  provider: string;
  serviceFallback?: boolean;
  userId: string;
}): Promise<void> {
  await db
    .insert(userModelCredentials)
    .values({
      baseUrl: input.baseUrl ?? null,
      encryptedKey: input.encryptedKey,
      keyPreview: input.keyPreview,
      model: input.model,
      provider: input.provider,
      serviceFallback: input.serviceFallback ?? false,
      userId: input.userId,
      // A new key (or a rotation) invalidates whatever the last check said.
      validationMessage: null,
      validationStatus: 'unvalidated',
    })
    .onConflictDoUpdate({
      set: {
        baseUrl: input.baseUrl ?? null,
        encryptedKey: input.encryptedKey,
        keyPreview: input.keyPreview,
        model: input.model,
        ...(input.serviceFallback === undefined
          ? {}
          : { serviceFallback: input.serviceFallback }),
        validationMessage: null,
        validationStatus: 'unvalidated',
      },
      target: [userModelCredentials.userId, userModelCredentials.provider],
    });
}

/**
 * Change the model / base URL of an existing credential, keeping its stored
 * secret. Lets a user switch models without pasting their key again.
 */
export async function updateUserModelCredentialConfig(input: {
  baseUrl?: string | null;
  model: string;
  provider: string;
  userId: string;
}): Promise<void> {
  await db
    .update(userModelCredentials)
    .set({ baseUrl: input.baseUrl ?? null, model: input.model })
    .where(
      and(
        eq(userModelCredentials.userId, input.userId),
        eq(userModelCredentials.provider, input.provider)
      )
    );
}

export async function deleteUserModelCredential(input: {
  provider: string;
  userId: string;
}): Promise<void> {
  await db
    .delete(userModelCredentials)
    .where(
      and(
        eq(userModelCredentials.userId, input.userId),
        eq(userModelCredentials.provider, input.provider)
      )
    );
}

/** Record what the provider said about the key on its last real use or check. */
export async function setCredentialValidation(input: {
  message?: string | null;
  provider: string;
  status: CredentialValidationStatus;
  userId: string;
}): Promise<void> {
  await db
    .update(userModelCredentials)
    .set({
      validationMessage: input.message ?? null,
      validationStatus: input.status,
      ...(input.status === 'valid' ? { lastUsedAt: new Date() } : {}),
    })
    .where(
      and(
        eq(userModelCredentials.userId, input.userId),
        eq(userModelCredentials.provider, input.provider)
      )
    );
}

/** Per-key opt-in to spending the SHARED service budget when the key fails. */
export async function setCredentialServiceFallback(input: {
  allowed: boolean;
  provider: string;
  userId: string;
}): Promise<void> {
  await db
    .update(userModelCredentials)
    .set({ serviceFallback: input.allowed })
    .where(
      and(
        eq(userModelCredentials.userId, input.userId),
        eq(userModelCredentials.provider, input.provider)
      )
    );
}
