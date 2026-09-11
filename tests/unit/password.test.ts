import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../services/user-service/src/domain/password.js';
import { hashRefreshToken } from '../../services/user-service/src/domain/tokens.js';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('Str0ng!Passw0rd');

    expect(await verifyPassword('Str0ng!Passw0rd', hash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('Str0ng!Passw0rd');

    expect(await verifyPassword('Str0ng!Passw0rc', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('uses argon2id with the expected cost parameters', async () => {
    const hash = await hashPassword('Str0ng!Passw0rd');

    // Encoded in the hash string, which is what lets the cost be raised later
    // without invalidating existing hashes.
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).toContain('m=19456');
    expect(hash).toContain('t=2');
    expect(hash).toContain('p=1');
  });

  it('salts every hash, so identical passwords do not collide', async () => {
    const a = await hashPassword('Str0ng!Passw0rd');
    const b = await hashPassword('Str0ng!Passw0rd');

    // Without a per-hash salt, a database leak would reveal which users share a
    // password, and one cracked hash would unlock all of them.
    expect(a).not.toBe(b);
    expect(await verifyPassword('Str0ng!Passw0rd', a)).toBe(true);
    expect(await verifyPassword('Str0ng!Passw0rd', b)).toBe(true);
  });

  it('returns false rather than throwing on a corrupt hash', async () => {
    // A malformed hash must read as "authentication failed", not as a 500 —
    // an error would tell an attacker the account exists and something unusual
    // is stored against it.
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
    expect(await verifyPassword('anything', '$argon2id$garbage')).toBe(false);
  });

  it('handles unicode and very long passwords', async () => {
    const unicode = 'пароль-🔐-密码-Ω';
    const long = 'x'.repeat(200);

    expect(await verifyPassword(unicode, await hashPassword(unicode))).toBe(true);
    expect(await verifyPassword(long, await hashPassword(long))).toBe(true);
  });
});

describe('refresh token hashing', () => {
  it('is deterministic, so a presented token can be looked up by hash', async () => {
    // Deliberately different from password hashing: the token is high-entropy
    // random, so a fast deterministic hash is both sufficient and necessary —
    // it is the lookup key on every refresh.
    expect(hashRefreshToken('abc123')).toBe(hashRefreshToken('abc123'));
  });

  it('produces a sha256 hex digest', () => {
    expect(hashRefreshToken('abc123')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not reveal the plaintext', () => {
    const token = 'a-secret-refresh-token-value';

    expect(hashRefreshToken(token)).not.toContain(token);
  });

  it('differs for different inputs', () => {
    expect(hashRefreshToken('token-a')).not.toBe(hashRefreshToken('token-b'));
  });
});
