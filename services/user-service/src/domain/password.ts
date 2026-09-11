import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing with argon2id.
 *
 * argon2id rather than bcrypt: it is the current OWASP recommendation and,
 * unlike bcrypt, it is *memory*-hard. Bcrypt is only CPU-hard, which means a
 * GPU or ASIC farm can parallelise it cheaply. Forcing each guess to allocate
 * 19 MiB makes massive parallelism expensive in silicon rather than just in
 * clock cycles — the attacker's advantage is capped by memory bandwidth.
 *
 * argon2id specifically (rather than argon2i or argon2d) is the hybrid variant,
 * resistant to both side-channel and GPU cracking attacks.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet minimum.
 */
const ARGON2_OPTIONS = {
  // 19 MiB. The dominant cost for an attacker and the reason to prefer argon2.
  memoryCost: 19_456,
  // Iterations. Two passes over memory.
  timeCost: 2,
  // Lanes. 1 keeps per-request latency predictable under concurrent load;
  // raising it parallelises a single hash rather than making it harder.
  parallelism: 1,
  // 2 = argon2id
  algorithm: 2 as const,
};

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash. A corrupt or
 * legacy-format hash in the database must read as "authentication failed", not
 * as a 500 — an error here would tell an attacker that the account exists and
 * that something unusual is stored against it.
 *
 * The parameters are encoded in the hash string itself, so raising the cost
 * factors above does not invalidate existing hashes; old passwords still
 * verify against their original parameters and can be re-hashed on next login.
 */
export async function verifyPassword(plaintext: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Password policy.
 *
 * Length is weighted far more heavily than character-class rules, which is what
 * current NIST guidance recommends: composition requirements push users toward
 * predictable substitutions ("Password1!") while adding little real entropy.
 *
 * The 72-byte upper bound is not a bcrypt limitation here — argon2 has no such
 * limit — but an unbounded password is a denial-of-service vector, since the
 * server would hash however many megabytes the caller sends.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
