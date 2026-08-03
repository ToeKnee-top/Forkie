import {
  boolean,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * A user's own model API key (BYOK), one row per (user, provider).
 *
 * `encryptedKey` holds ONLY the bot's versioned ciphertext (`v1:…`, see
 * `lib/byok/crypto.ts`) — this package never sees a plaintext key, so a query
 * log or an accidental `select *` cannot leak one. Reads that don't need the
 * secret must use `listUserModelCredentials`, whose return type omits it.
 */
export const userModelCredentials = pgTable(
  'user_model_credentials',
  {
    userId: text('user_id').notNull(),
    // Provider slug from packages/ai's BYOK_PROVIDERS (openai, anthropic, …).
    provider: text('provider').notNull(),
    encryptedKey: text('encrypted_key').notNull(),
    // Last few characters of the key, so the UI can identify it without holding
    // it. Never widen this — a longer preview is a partial key.
    keyPreview: text('key_preview').notNull(),
    // Model id to run on this provider, and an optional base-URL override (for
    // the `custom` provider, or a proxy in front of a standard one).
    model: text('model').notNull(),
    baseUrl: text('base_url'),
    // Result of the last credential check ('unvalidated' | 'valid' | 'invalid'),
    // and the provider's own message when it rejected the key. Shown only to the
    // key's owner.
    validationStatus: text('validation_status')
      .notNull()
      .default('unvalidated'),
    validationMessage: text('validation_message'),
    // Whether kyto may fall back to the SHARED service models when this key
    // fails. Off by default: a user's broken key must not silently spend the
    // shared budget — they opt in per key.
    serviceFallback: boolean('service_fallback').notNull().default(false),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.provider],
      name: 'user_model_credentials_pk',
    }),
  ]
);

type Row = typeof userModelCredentials.$inferSelect;

/** Everything about a credential EXCEPT the secret — safe for UI and logs. */
export type UserModelCredential = Omit<Row, 'encryptedKey'>;

/** The secret, handed out only to the bot-owned code that decrypts it. */
export type UserModelCredentialSecret = UserModelCredential & {
  encryptedKey: string;
};

export type CredentialValidationStatus = 'unvalidated' | 'valid' | 'invalid';
