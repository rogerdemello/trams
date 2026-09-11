import { importSPKI, jwtVerify, type JWTPayload, type KeyObject } from 'jose';
import { AppError } from '../errors.js';
import { readPem, type Config } from '../config.js';

/**
 * Access-token verification using the PUBLIC key only.
 *
 * This lives in the shared package because two components need it — the API
 * Gateway and the Notification Service — and neither should be able to issue
 * tokens. Only the User Service loads the private key.
 *
 * That asymmetry is the point of choosing RS256 over HS256. With a symmetric
 * secret, every component that verifies a token can also forge one, so a
 * compromised gateway would be able to impersonate any user. Here the gateway
 * holds a key that mathematically cannot produce a valid signature.
 */

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  email: string;
  role: 'user' | 'admin';
}

export class AccessTokenVerifier {
  private publicKey?: KeyObject;

  constructor(private readonly config: Config) {}

  /**
   * Load the public key once, at boot.
   *
   * A missing key must be a startup failure with an actionable message, not a
   * 500 on the first authenticated request.
   */
  async init(): Promise<void> {
    const pem = readPem(
      this.config.JWT_PUBLIC_KEY_PATH,
      'Run `npm run keys` to generate the RS256 key pair.',
    );
    this.publicKey = await importSPKI(pem, 'RS256');
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    if (!this.publicKey) throw new Error('AccessTokenVerifier.init() was not called');

    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: this.config.JWT_ISSUER,
        audience: this.config.JWT_AUDIENCE,
        // Pinned explicitly. Never let the token's own header choose the
        // algorithm — that is the classic JWT vulnerability, where an attacker
        // sets `alg: none` or downgrades RS256 to HS256 and signs with the
        // public key as the HMAC secret.
        algorithms: ['RS256'],
      });

      if (typeof payload.sub !== 'string' || typeof payload['email'] !== 'string') {
        throw AppError.tokenInvalid('Token is missing required claims');
      }

      return {
        ...payload,
        sub: payload.sub,
        email: payload['email'],
        role: (payload['role'] as 'user' | 'admin') ?? 'user',
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Expired and invalid are kept distinct because the correct client
      // response differs: refresh versus re-authenticate.
      const code = (error as { code?: string }).code;
      if (code === 'ERR_JWT_EXPIRED') throw AppError.tokenExpired();
      throw AppError.tokenInvalid();
    }
  }
}
