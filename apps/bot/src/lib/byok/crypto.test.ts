import { describe, expect, test } from 'bun:test';

// The module reads BYOK_ENCRYPTION_KEY from the environment at call time (not
// through `@/env`, so this test needs no other service key to run).
process.env.BYOK_ENCRYPTION_KEY =
  'test-only-passphrase-with-enough-entropy-0123456789';

const { decryptSecret, encryptSecret, keyPreview, SecretCryptoError } =
  await import('./crypto');

const SECRET = 'sk-ant-api03-not-a-real-key-0123456789';

describe('BYOK secret encryption', () => {
  test('round-trips a secret', () => {
    expect(decryptSecret(encryptSecret(SECRET))).toBe(SECRET);
  });

  test('is non-deterministic (fresh IV per encryption)', () => {
    expect(encryptSecret(SECRET)).not.toBe(encryptSecret(SECRET));
  });

  test('rejects a tampered payload', () => {
    const stored = encryptSecret(SECRET);
    const [version, iv, payload] = stored.split(':');
    // Substitute the last character for a DIFFERENT one rather than swapping the
    // last two: base64 payloads end in two identical characters often enough
    // (~1 in 64) that the swap was sometimes a no-op, and the test then failed
    // because untampered ciphertext correctly decrypted.
    const last = payload?.at(-1);
    const tampered = `${payload?.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    expect(payload).not.toBe(tampered);
    expect(() => decryptSecret(`${version}:${iv}:${tampered}`)).toThrow(
      SecretCryptoError
    );
  });

  test('rejects a payload encrypted under a different key', () => {
    const stored = encryptSecret(SECRET);
    expect(() =>
      decryptSecret(stored, 'a-completely-different-passphrase-value')
    ).toThrow(SecretCryptoError);
  });

  test('rejects malformed and unknown-version input', () => {
    for (const bad of ['', 'nonsense', 'v1:only-two', 'v2:aaaa:bbbb']) {
      expect(() => decryptSecret(bad)).toThrow(SecretCryptoError);
    }
  });

  test('never leaks plaintext or key material in a thrown error', () => {
    const stored = encryptSecret(SECRET);
    const broken = `${stored.slice(0, -4)}0000`;
    try {
      decryptSecret(broken);
      throw new Error('expected decryptSecret to throw');
    } catch (error) {
      const dump = `${(error as Error).message} ${JSON.stringify(error)}`;
      expect(dump).not.toContain(SECRET);
      expect(dump).not.toContain(process.env.BYOK_ENCRYPTION_KEY as string);
    }
  });

  test('preview shows only the tail of the key', () => {
    const preview = keyPreview(SECRET);
    expect(preview).toBe('…6789');
    expect(SECRET).toContain(preview.slice(1));
    expect(preview).not.toContain('sk-ant');
  });
});
