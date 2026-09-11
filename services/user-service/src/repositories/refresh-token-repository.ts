import type { RefreshTokenRow } from '@trams/shared';
import { nowIso, type UserDbExecutor } from './types.js';

/**
 * Refresh token persistence.
 *
 * Tokens are only ever looked up by hash, because the plaintext is never
 * stored. The `revoked_at` / `replaced_by` pair records the rotation chain,
 * which is what makes reuse of an already-rotated token detectable.
 */
export class RefreshTokenRepository {
  async insert(
    executor: UserDbExecutor,
    input: { id: string; userId: string; tokenHash: string; expiresAt: Date },
  ): Promise<void> {
    await executor
      .insertInto('refresh_tokens')
      .values({
        id: input.id,
        user_id: input.userId,
        token_hash: input.tokenHash,
        expires_at: input.expiresAt.toISOString(),
        created_at: nowIso(),
        revoked_at: null,
        replaced_by: null,
      })
      .execute();
  }

  async findByHash(
    executor: UserDbExecutor,
    tokenHash: string,
  ): Promise<RefreshTokenRow | undefined> {
    return executor
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();
  }

  /** Mark a token consumed by rotation, recording which token replaced it. */
  async revoke(executor: UserDbExecutor, id: string, replacedBy?: string): Promise<void> {
    await executor
      .updateTable('refresh_tokens')
      .set({ revoked_at: nowIso(), replaced_by: replacedBy ?? null })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Revoke every live token for a user.
   *
   * Called on logout-all and, importantly, when a rotated token is replayed —
   * the safe response to a suspected stolen token is to invalidate the whole
   * family, forcing a fresh login rather than guessing which holder is genuine.
   */
  async revokeAllForUser(executor: UserDbExecutor, userId: string): Promise<number> {
    const result = await executor
      .updateTable('refresh_tokens')
      .set({ revoked_at: nowIso() })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0);
  }

  /**
   * Delete expired rows.
   *
   * Housekeeping: expired tokens are already unusable, so this is about keeping
   * the table (and its unique index) from growing without bound.
   */
  async deleteExpired(executor: UserDbExecutor): Promise<number> {
    const result = await executor
      .deleteFrom('refresh_tokens')
      .where('expires_at', '<', nowIso())
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }
}

/** A token row is usable only if it is neither revoked nor expired. */
export function isRefreshTokenUsable(row: RefreshTokenRow, now = new Date()): boolean {
  if (row.revoked_at !== null) return false;
  return new Date(row.expires_at).getTime() > now.getTime();
}
