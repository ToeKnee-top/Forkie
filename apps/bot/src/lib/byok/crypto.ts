import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Versioned symmetric encryption for user-supplied API keys (BYOK).
 *
 * The bot owns this: `packages/db` only ever sees the opaque ciphertext string,
 * so a stray query log or a `select *` can never surface key material. The
 * format is versioned (`v1:…`) so the scheme can be rotated later without
 * guessing at what a stored row was written with.
 *
 * v1 = AES-256-GCM. The key is derived from `BYOK_ENCRYPTION_KEY` with scrypt;
 * a random 12-byte IV per message; the GCM tag is appended to the ciphertext,
 * so tampering with ANY part fails the open rather than returning garbage.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
// Fixed, version-scoped salt: the passphrase is already a high-entropy secret
// from the environment, and a per-row salt would have to be stored beside the
// ciphertext for no gain against an attacker who has the database anyway.
const SALT = 'kyto-byok-v1';
// scrypt on a long passphrase is ~100ms; derive once per passphrase per process.
const derivedKeys = new Map<string, Buffer>();

export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretCryptoError';
  }
}

// Read straight from the environment rather than through `@/env`: this module is
// the one piece of BYOK worth unit-testing in isolation, and importing the full
// env schema would make the crypto tests require every unrelated service key
// (Slack, HackClub, Exa…) just to encrypt a string. `env.ts` still declares and
// validates BYOK_ENCRYPTION_KEY at startup — that's where a bad value is caught.
function passphraseFromEnv(): string | undefined {
  return process.env.BYOK_ENCRYPTION_KEY;
}

/** Is BYOK usable at all? False when no encryption key is configured. */
export function byokConfigured(): boolean {
  return Boolean(passphraseFromEnv());
}

// `passphrase` is an explicit override, used by the tests (and available for a
// future key rotation, which must decrypt under the old key and re-encrypt under
// the new one). Production callers pass nothing and get BYOK_ENCRYPTION_KEY.
function encryptionKey(passphrase = passphraseFromEnv()): Buffer {
  if (!passphrase) {
    throw new SecretCryptoError(
      'BYOK_ENCRYPTION_KEY is not set; user model keys cannot be encrypted or read.'
    );
  }
  const cached = derivedKeys.get(passphrase);
  if (cached) {
    return cached;
  }
  const derived = scryptSync(passphrase, SALT, KEY_BYTES);
  derivedKeys.set(passphrase, derived);
  return derived;
}

/** Encrypt a secret into the stored `v1:iv:payload` form. */
export function encryptSecret(plaintext: string, passphrase?: string): string {
  if (!plaintext) {
    throw new SecretCryptoError('Refusing to encrypt an empty secret.');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(passphrase), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const payload = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return `${VERSION}:${iv.toString('base64url')}:${payload.toString('base64url')}`;
}

/**
 * Decrypt a stored secret. Throws SecretCryptoError on a wrong key, a tampered
 * payload, or a malformed/unknown-version string. The thrown message never
 * carries plaintext, ciphertext or key material — only the failure mode.
 */
export function decryptSecret(stored: string, passphrase?: string): string {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new SecretCryptoError('Stored secret is malformed or unsupported.');
  }
  const iv = Buffer.from(parts[1] as string, 'base64url');
  const payload = Buffer.from(parts[2] as string, 'base64url');
  if (iv.length !== IV_BYTES || payload.length <= TAG_BYTES) {
    throw new SecretCryptoError('Stored secret is malformed or unsupported.');
  }
  const ciphertext = payload.subarray(0, payload.length - TAG_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(passphrase), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Swallow the underlying error: node's message is generic, but its `cause`
    // chain has been known to carry buffers. Never let one reach a log.
    throw new SecretCryptoError(
      'Could not decrypt secret (wrong key or tampered payload).'
    );
  }
}

const PREVIEW_TAIL = 4;

/**
 * A safe, storable hint of which key a row holds: the last few characters only.
 * Everything the UI shows about a key comes from this, never from the plaintext.
 */
export function keyPreview(plaintext: string): string {
  const tail = plaintext.slice(-PREVIEW_TAIL);
  return `…${tail}`;
}

/** Constant-time compare, for anything that ever checks a secret by value. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
