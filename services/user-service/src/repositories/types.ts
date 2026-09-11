import type { Kysely, Transaction } from 'kysely';
import type { UserDatabase } from '@trams/shared';

/**
 * Every repository method takes an executor rather than closing over a
 * connection.
 *
 * This is what makes the transactional outbox possible. `Kysely<DB>` and
 * `Transaction<DB>` share the same query-builder surface, so the identical
 * repository call can run standalone or enlisted in a caller's transaction.
 * Without this, the outbox insert could not be made atomic with the domain
 * write without duplicating every method.
 */
export type UserDbExecutor = Kysely<UserDatabase> | Transaction<UserDatabase>;

export const nowIso = (): string => new Date().toISOString();
