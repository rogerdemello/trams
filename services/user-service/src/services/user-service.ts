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
import { OutboxRepository } from '../repositories/outbox-repository.js';
import { RefreshTokenRepository } from '../repositories/refresh-token-repository.js';
import { isUniqueViolation, UserRepository } from '../repositories/user-repository.js';

/**
 * User profile operations.
 *
 * Every mutation follows the same shape as registration: the domain change and
 * its event are written in one transaction, then drained by the outbox
 * publisher. That consistency is deliberate — there is exactly one way to emit
 * an event in this service, so no future handler can accidentally introduce the
 * publish-after-commit bug the outbox exists to prevent.
 */

export interface UserServiceDeps {
  db: Kysely<UserDatabase>;
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
  outbox: OutboxRepository;
  logger: Logger;
}

export class UserManagementService {
  constructor(private readonly deps: UserServiceDeps) {}

  async getById(id: string): Promise<PublicUser> {
    const user = await this.deps.users.findById(this.deps.db, id);
    if (!user) throw AppError.notFound('User');
    return toPublicUser(user);
  }

  async list(options: {
    limit: number;
    offset: number;
  }): Promise<{ users: PublicUser[]; total: number }> {
    const [users, total] = await Promise.all([
      this.deps.users.list(this.deps.db, options),
      this.deps.users.count(this.deps.db),
    ]);
    return { users: users.map(toPublicUser), total };
  }

  /**
   * Update a profile.
   *
   * Emits `user.updated` carrying `changedFields`, so the consumer can decide
   * whether a change is worth notifying about — an email change matters to the
   * user, a display-name tweak may not. Putting that decision in the payload
   * rather than assuming it here keeps the producer ignorant of consumer policy,
   * which is what lets the two services evolve separately.
   *
   * A no-op update short-circuits without emitting an event. Publishing
   * "nothing changed" would produce notifications for non-events.
   */
  async updateProfile(input: {
    id: string;
    name?: string;
    email?: string;
    correlationId: string;
  }): Promise<PublicUser> {
    const { db, users, outbox, logger } = this.deps;

    const existing = await users.findById(db, input.id);
    if (!existing) throw AppError.notFound('User');

    const changedFields: string[] = [];
    if (input.name !== undefined && input.name !== existing.name) changedFields.push('name');
    if (input.email !== undefined && input.email.toLowerCase() !== existing.email) {
      changedFields.push('email');
    }

    if (changedFields.length === 0) {
      return toPublicUser(existing);
    }

    try {
      return await db.transaction().execute(async (trx) => {
        const changes: { name?: string; email?: string } = {};
        if (changedFields.includes('name')) changes.name = input.name;
        if (changedFields.includes('email')) changes.email = input.email;

        const updated = await users.updateProfile(trx, input.id, changes);
        if (!updated) throw AppError.notFound('User');

        await outbox.enqueue(
          trx,
          buildEvent({
            id: randomUUID(),
            type: SUBJECTS.userUpdated,
            correlationId: input.correlationId,
            actorUserId: updated.id,
            data: {
              userId: updated.id,
              email: updated.email,
              name: updated.name,
              changedFields,
            },
          }),
        );

        logger.info({ userId: updated.id, changedFields }, 'user profile updated');
        return toPublicUser(updated);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw AppError.conflict('That email address is already in use');
      }
      throw error;
    }
  }

  /**
   * Change a password.
   *
   * Requires the current password even though the caller is already
   * authenticated. This is not redundant: it means a stolen access token alone
   * cannot lock the real owner out of their account, which is the single most
   * damaging thing an attacker could do with 15 minutes of access.
   *
   * All other sessions are revoked afterwards. If the password is being changed
   * *because* of a suspected compromise, leaving the attacker's refresh token
   * live would defeat the entire point.
   */
  async changePassword(input: {
    id: string;
    currentPassword: string;
    newPassword: string;
    correlationId: string;
    ipAddress?: string;
  }): Promise<void> {
    const { db, users, refreshTokens, outbox, logger } = this.deps;

    const existing = await users.findById(db, input.id);
    if (!existing) throw AppError.notFound('User');

    const currentMatches = await verifyPassword(input.currentPassword, existing.password_hash);
    if (!currentMatches) {
      logger.warn({ userId: input.id }, 'password change rejected — current password incorrect');
      throw AppError.forbidden('Current password is incorrect');
    }

    // Hashed outside the transaction; see AuthService.register.
    const newHash = await hashPassword(input.newPassword);

    await db.transaction().execute(async (trx) => {
      await users.updatePasswordHash(trx, input.id, newHash);
      await refreshTokens.revokeAllForUser(trx, input.id);

      await outbox.enqueue(
        trx,
        buildEvent({
          id: randomUUID(),
          type: SUBJECTS.userPasswordChanged,
          correlationId: input.correlationId,
          actorUserId: existing.id,
          data: {
            userId: existing.id,
            email: existing.email,
            name: existing.name,
            changedAt: new Date().toISOString(),
            ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
          },
        }),
      );
    });

    logger.info({ userId: input.id }, 'password changed and all sessions revoked');
  }

  /**
   * Delete an account.
   *
   * The event is enqueued *before* the delete within the same transaction,
   * because the event payload needs the user's email and name — data that will
   * not exist a moment later. Capturing it into the event is what lets the
   * Notification Service send a confirmation to an account that is already gone.
   *
   * This is a genuine strength of event-driven design worth noting: the
   * notification does not need to query a service for data that has been
   * deleted, because the event carries everything the consumer requires.
   */
  async deleteAccount(input: { id: string; correlationId: string }): Promise<void> {
    const { db, users, outbox, logger } = this.deps;

    const existing = await users.findById(db, input.id);
    if (!existing) throw AppError.notFound('User');

    await db.transaction().execute(async (trx) => {
      await outbox.enqueue(
        trx,
        buildEvent({
          id: randomUUID(),
          type: SUBJECTS.userDeleted,
          correlationId: input.correlationId,
          actorUserId: existing.id,
          data: {
            userId: existing.id,
            email: existing.email,
            name: existing.name,
            deletedAt: new Date().toISOString(),
          },
        }),
      );

      // Refresh tokens cascade via the foreign key, so no credential survives
      // the account.
      const deleted = await users.deleteById(trx, input.id);
      if (!deleted) throw AppError.notFound('User');
    });

    logger.info({ userId: input.id }, 'user account deleted');
  }
}
