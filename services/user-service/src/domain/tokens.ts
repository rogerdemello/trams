import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readPem, type Config } from '@trams/shared';
import { SignJWT, importPKCS8, type KeyObject } from 'jose';

/**
 * Token issuance and verification.
 *
 * Two token types with deliberately different properties:
 *
 *   Access token   — a signed JWT, short-lived (15 min), stateless. Verified by
 *                    the gateway with the public key alone. Nothing to look up,
 *                    so it costs no database round trip per request.
 *
 *   Refresh token  — an opaque random string, long-lived (7 days), stateful.
 *                    Stored hashed and revocable.
 *
 * The split resolves a genuine tension. Stateless tokens scale but cannot be
 * revoked; stateful tokens can be revoked but cost a lookup. Using both means
 * the common path (verifying a request) stays free, while the dangerous
 * capability (staying logged in for a week) remains revocable. The worst case
 * from a stolen access token is bounded at 15 minutes.
 */

export interface IssuedRefreshToken {
  /** Returned to the client exactly once — never stored in this form. */
  plaintext: string;
  /** What goes in the database. */
  hash: string;
  id: string;
  expiresAt: Date;
}

/**
 * Token ISSUANCE only.
 *
 * Verification deliberately lives elsewhere — in the shared
 * `AccessTokenVerifier`, which loads only the public key. This class is the
 * single place in the whole system that touches the private key, so the
 * capability to mint a token is confined to one file in one service.
 */
export class TokenService {
  private privateKey?: KeyObject;

  constructor(private readonly config: Config) {}

  /**
   * Load key material once at boot rather than per request.
   *
   * Called explicitly during startup so that a missing or malformed key is a
   * startup failure with a clear message, instead of the first login attempt
   * failing with a 500.
   */
  async init(): Promise<void> {
    const privatePem = readPem(
      this.config.JWT_PRIVATE_KEY_PATH,
      'Run `npm run keys` to generate the RS256 key pair.',
    );
    this.privateKey = await importPKCS8(privatePem, 'RS256');
  }

  /**
   * Sign a short-lived access token.
   *
   * `issuer` and `audience` are set and are checked on verification. Without
   * them, a token minted by some other system that happens to share our public
   * key would be accepted — and more practically, it prevents a token intended
   * for one audience being replayed against another.
   */
  async issueAccessToken(user: {
    id: string;
    email: string;
    role: 'user' | 'admin';
  }): Promise<string> {
    if (!this.privateKey) throw new Error('TokenService.init() was not called');

    return new SignJWT({ email: user.email, role: user.role })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setSubject(user.id)
      .setIssuer(this.config.JWT_ISSUER)
      .setAudience(this.config.JWT_AUDIENCE)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(this.config.ACCESS_TOKEN_TTL)
      .sign(this.privateKey);
  }

  /**
   * Mint a refresh token.
   *
   * 32 bytes from a CSPRNG — 256 bits of entropy, so it is not guessable and
   * needs no rate limiting of its own.
   *
   * Stored as a SHA-256 hash. Note the deliberate difference from passwords:
   * this value is high-entropy random, so there is no dictionary to attack and
   * no need for a deliberately slow KDF. A fast hash is both sufficient and
   * necessary here, because the token is looked up *by* its hash on every
   * refresh — an argon2 lookup would mean re-hashing at 19 MiB per attempt, or
   * a table scan.
   *
   * What hashing buys: a database dump does not yield usable sessions. The
   * stored value cannot be replayed.
   */
  issueRefreshToken(): IssuedRefreshToken {
    const plaintext = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1_000,
    );

    return {
      plaintext,
      hash: hashRefreshToken(plaintext),
      id: randomUUID(),
      expiresAt,
    };
  }
}

/** Deterministic hash used both to store and to look up a refresh token. */
export function hashRefreshToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}
