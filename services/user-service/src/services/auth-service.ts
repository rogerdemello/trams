import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  AppError,
  buildEvent,
  SUBJECTS,
  toPublicUser,
  type Logger,
  type PublicUser,
  type UserDatabase,
} from '@trams/shared';
import { hashPassword, verifyPassword } from '../domain/password.js';
import { hashRefreshToken, type TokenService } from '../domain/tokens.js';
import { OutboxRepository } from '../repositories/outbox-repository.js';
import {
  isRefreshTokenUsable,
  RefreshTokenRepository,
} from '../repositories/refresh-token-repository.js';
import { isUniqueViolation, UserRepository } from '../repositories/user-repository.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  tokenType: 'Bearer';
}

export interface AuthResult {
  user: PublicUser;
  tokens: AuthTokens;
}

export interface AuthServiceDeps {
  db: Kysely<UserDatabase>;
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
  outbox: OutboxRepository;
  tokens: TokenService;
  logger: Logger;
  /** Echoed to clients so they know when to refresh, e.g. "15m". */
  accessTokenTtl: string;
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  /**
   * A real argon2id hash of a value nobody knows, computed once at startup.
   *
   * Used to equalise timing on the unknown-account login path. It has to be a
   * genuine hash with the production parameters — a malformed string would make
   * `verifyPassword` fail fast, which would reintroduce exactly the timing
   * difference it exists to hide.
   */
  private dummyHash?: string;

  async init(): Promise<void> {
    this.dummyHash = await hashPassword(randomUUID());
  }

  /**
   * Register a new user.
   *
   * ── The transaction is the important part ──────────────────────────────────
   * The user row and the outbox event are written together. Either both exist
   * or neither does, so there is no state in which a user has registered but
   * their welcome notification was never even queued.
   *
   * Note what is deliberately OUTSIDE the transaction:
   *
   *   - Password hashing. argon2 takes ~50ms; holding a write transaction open
   *     for that long would serialise registrations on SQLite's write lock.
   *   - Access/refresh token issuance for the response. Not part of the
   *     durable domain change.
   *   - The actual broker publish. That is the entire point — see
   *     OutboxPublisher.
   * ───────────────────────────────────────────────────────────────────────────
   */
  async register(input: {
    email: string;
    password: string;
    name: string;
    correlationId: string;
  }): Promise<AuthResult> {
    const { db, users, refreshTokens, outbox, tokens, logger } = this.deps;

    // Outside the transaction, deliberately — see above.
    const passwordHash = await hashPassword(input.password);
    const userId = randomUUID();
    const refresh = tokens.issueRefreshToken();

    let user: PublicUser;

    try {
      user = await db.transaction().execute(async (trx) => {
        const created = await users.insert(trx, {
          id: userId,
          email: input.email,
          name: input.name,
          passwordHash,
        });

        // Built here rather than in the route so the event is always
        // consistent with what was actually persisted.
        const event = buildEvent({
          id: randomUUID(),
          type: SUBJECTS.userRegistered,
          correlationId: input.correlationId,
          actorUserId: created.id,
          data: { userId: created.id, email: created.email, name: created.name },
        });

        // ← atomic with the insert above. This single line is what makes the
        //   system unable to lose the event.
        await outbox.enqueue(trx, event);

        await refreshTokens.insert(trx, {
          id: refresh.id,
          userId: created.id,
          tokenHash: refresh.hash,
          expiresAt: refresh.expiresAt,
        });

        return toPublicUser(created);
      });
    } catch (error) {
      // Let the database's UNIQUE index decide, rather than a
      // SELECT-then-INSERT check that two concurrent registrations would race.
      if (isUniqueViolation(error)) {
        throw AppError.conflict('An account with that email address already exists');
      }
      throw error;
    }

    logger.info({ userId: user.id }, 'user registered');

    return {
      user,
      tokens: await this.buildTokens(user, refresh.plaintext),
    };
  }

  /**
   * Authenticate with email and password.
   *
   * Two anti-enumeration measures:
   *
   *  1. The same error (`INVALID_CREDENTIALS`) whether the email is unknown or
   *     the password is wrong. Distinguishing them turns this endpoint into an
   *     oracle for discovering which addresses have accounts.
   *
   *  2. A dummy verification when the user does not exist. Without it, an
   *     unknown email returns in ~1ms while a known one takes ~50ms for argon2,
   *     and that timing difference leaks exactly what measure 1 conceals.
   */
  async login(input: {
    email: string;
    password: string;
    correlationId: string;
  }): Promise<AuthResult> {
    const { db, users, refreshTokens, tokens, logger } = this.deps;

    const existing = await users.findByEmail(db, input.email);

    if (!existing) {
      await this.dummyVerify(input.password);
      logger.info({ email: '[redacted]' }, 'login failed — no such account');
      throw AppError.invalidCredentials();
    }

    const passwordMatches = await verifyPassword(input.password, existing.password_hash);
    if (!passwordMatches) {
      logger.info({ userId: existing.id }, 'login failed — wrong password');
      throw AppError.invalidCredentials();
    }

    const refresh = tokens.issueRefreshToken();
    await refreshTokens.insert(db, {
      id: refresh.id,
      userId: existing.id,
      tokenHash: refresh.hash,
      expiresAt: refresh.expiresAt,
    });

    logger.info({ userId: existing.id }, 'user logged in');
    const user = toPublicUser(existing);

    return { user, tokens: await this.buildTokens(user, refresh.plaintext) };
  }

  /**
   * Exchange a refresh token for a new pair, rotating the old one.
   *
   * ── Rotation with reuse detection ─────────────────────────────────────────
   * Each refresh consumes its token and issues a replacement. The consumed
   * token is marked revoked with a pointer to its successor.
   *
   * If an already-revoked token is presented, that is a strong signal of theft:
   * either the attacker is using a stolen token the legitimate client already
   * rotated, or the legitimate client is using one the attacker rotated. There
   * is no way to tell which party is genuine, so the safe response is to revoke
   * the entire token family and force a fresh login. Accepting it would let a
   * stolen token be used indefinitely.
   * ───────────────────────────────────────────────────────────────────────────
   */
  async refresh(input: { refreshToken: string; correlationId: string }): Promise<AuthResult> {
    const { db, users, refreshTokens, tokens, logger } = this.deps;

    const tokenHash = hashRefreshToken(input.refreshToken);
    const existing = await refreshTokens.findByHash(db, tokenHash);

    if (!existing) {
      throw AppError.tokenInvalid('Refresh token is not recognised');
    }

    if (existing.revoked_at !== null) {
      logger.error(
        { userId: existing.user_id, tokenId: existing.id },
        'revoked refresh token replayed — revoking all sessions for this user',
      );
      await refreshTokens.revokeAllForUser(db, existing.user_id);
      throw AppError.tokenInvalid(
        'Refresh token has already been used. All sessions have been revoked; please sign in again.',
      );
    }

    if (!isRefreshTokenUsable(existing)) {
      throw AppError.tokenExpired('Refresh token has expired');
    }

    const user = await users.findById(db, existing.user_id);
    if (!user) {
      // The token is valid but its user is gone (deleted mid-session).
      await refreshTokens.revoke(db, existing.id);
      throw AppError.tokenInvalid('Account no longer exists');
    }

    const replacement = tokens.issueRefreshToken();

    // Rotation is transactional: issuing the new token and revoking the old one
    // must not be separable, or a crash between them would either leave two
    // live tokens or none.
    await db.transaction().execute(async (trx) => {
      await refreshTokens.insert(trx, {
        id: replacement.id,
        userId: user.id,
        tokenHash: replacement.hash,
        expiresAt: replacement.expiresAt,
      });
      await refreshTokens.revoke(trx, existing.id, replacement.id);
    });

    logger.debug({ userId: user.id }, 'refresh token rotated');
    const publicUser = toPublicUser(user);

    return { user: publicUser, tokens: await this.buildTokens(publicUser, replacement.plaintext) };
  }

  /** Revoke a single session, or every session for the user. */
  async logout(input: { refreshToken: string; allSessions?: boolean }): Promise<void> {
    const { db, refreshTokens, logger } = this.deps;

    const tokenHash = hashRefreshToken(input.refreshToken);
    const existing = await refreshTokens.findByHash(db, tokenHash);

    // Idempotent by design: logging out with an unknown or already-revoked
    // token still succeeds. The caller's intent ("end my session") is satisfied
    // either way, and returning an error would leak whether the token was real.
    if (!existing) {
      logger.debug('logout with unrecognised token — treating as already logged out');
      return;
    }

    if (input.allSessions) {
      const count = await refreshTokens.revokeAllForUser(db, existing.user_id);
      logger.info({ userId: existing.user_id, revoked: count }, 'all sessions revoked');
      return;
    }

    await refreshTokens.revoke(db, existing.id);
    logger.info({ userId: existing.user_id }, 'session revoked');
  }

  private async buildTokens(user: PublicUser, refreshToken: string): Promise<AuthTokens> {
    return {
      accessToken: await this.deps.tokens.issueAccessToken({
        id: user.id,
        email: user.email,
        role: user.role,
      }),
      refreshToken,
      expiresIn: this.deps.accessTokenTtl,
      tokenType: 'Bearer',
    };
  }

  /**
   * Burn roughly the same CPU as a real verification when the account does not
   * exist, so response time does not reveal whether an email is registered.
   */
  private async dummyVerify(candidate: string): Promise<void> {
    if (!this.dummyHash) {
      // init() was not called. Fall back to hashing the candidate, which costs
      // the same as a verify — better to spend the time than to leak.
      await hashPassword(candidate);
      return;
    }
    await verifyPassword(candidate, this.dummyHash);
  }
}
