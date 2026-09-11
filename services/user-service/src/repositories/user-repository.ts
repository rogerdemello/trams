import type { User } from '@trams/shared';
import { nowIso, type UserDbExecutor } from './types.js';

/**
 * User persistence.
 *
 * Email is normalised to lowercase on every write and every lookup. That
 * normalisation plus the UNIQUE index is what makes `Alice@x.com` and
 * `alice@x.com` the same account — without it, two users could register what a
 * human would read as the same address, which is both a support problem and an
 * account-takeover vector during password reset.
 */
export class UserRepository {
  async findById(executor: UserDbExecutor, id: string): Promise<User | undefined> {
    return executor.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByEmail(executor: UserDbExecutor, email: string): Promise<User | undefined> {
    return executor
      .selectFrom('users')
      .selectAll()
      .where('email', '=', normaliseEmail(email))
      .executeTakeFirst();
  }

  async insert(
    executor: UserDbExecutor,
    input: {
      id: string;
      email: string;
      name: string;
      passwordHash: string;
      role?: 'user' | 'admin';
    },
  ): Promise<User> {
    const timestamp = nowIso();

    await executor
      .insertInto('users')
      .values({
        id: input.id,
        email: normaliseEmail(input.email),
        name: input.name,
        password_hash: input.passwordHash,
        role: input.role ?? 'user',
        created_at: timestamp,
        updated_at: timestamp,
      })
      .execute();

    // Read back rather than reconstructing in memory, so the returned object
    // reflects any database-applied defaults. `insert ... returning` is not
    // portable to SQLite in older versions, so a select keeps both dialects on
    // the same code path.
    const created = await this.findById(executor, input.id);
    if (!created) throw new Error('user insert did not persist');
    return created;
  }

  async updateProfile(
    executor: UserDbExecutor,
    id: string,
    changes: { name?: string; email?: string },
  ): Promise<User | undefined> {
    const patch: Record<string, string> = { updated_at: nowIso() };
    if (changes.name !== undefined) patch['name'] = changes.name;
    if (changes.email !== undefined) patch['email'] = normaliseEmail(changes.email);

    await executor.updateTable('users').set(patch).where('id', '=', id).execute();
    return this.findById(executor, id);
  }

  async updatePasswordHash(
    executor: UserDbExecutor,
    id: string,
    passwordHash: string,
  ): Promise<void> {
    await executor
      .updateTable('users')
      .set({ password_hash: passwordHash, updated_at: nowIso() })
      .where('id', '=', id)
      .execute();
  }

  async deleteById(executor: UserDbExecutor, id: string): Promise<boolean> {
    const result = await executor.deleteFrom('users').where('id', '=', id).executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async list(
    executor: UserDbExecutor,
    options: { limit: number; offset: number },
  ): Promise<User[]> {
    return executor
      .selectFrom('users')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(options.limit)
      .offset(options.offset)
      .execute();
  }

  async count(executor: UserDbExecutor): Promise<number> {
    const row = await executor
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Recognise a unique-constraint violation across both dialects.
 *
 * SQLite and Postgres report this differently (`SQLITE_CONSTRAINT_UNIQUE` vs
 * SQLSTATE `23505`), so the check is centralised here. This is used to turn a
 * duplicate registration into a clean 409 — and note that we let the *database*
 * detect it rather than doing SELECT-then-INSERT, which is a race two
 * concurrent registrations would eventually lose.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; message?: string };
  if (candidate.code === '23505') return true; // Postgres
  if (typeof candidate.code === 'string' && candidate.code.startsWith('SQLITE_CONSTRAINT'))
    return true;
  return /unique constraint|UNIQUE constraint failed/i.test(candidate.message ?? '');
}
