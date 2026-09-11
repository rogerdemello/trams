import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { Kysely, PostgresDialect, SqliteDialect, sql, type Dialect } from 'kysely';
import type { Logger } from 'pino';

/**
 * Both database drivers are CommonJS native/binary modules, and both are loaded
 * lazily so that only the dialect actually in use is ever required. A
 * Postgres-only deployment therefore never touches the SQLite native binding.
 * `createRequire` is the ESM-correct way to do a synchronous conditional load.
 */
const requireCjs = createRequire(import.meta.url);

/**
 * Dialect selection — the one place in the codebase that knows which database
 * engine is in use.
 *
 * Everything above this file writes Kysely query-builder calls, which compile
 * to correct SQL for either engine. That is the payoff of the portable schema:
 * there is no second implementation to keep in sync and no dialect-specific
 * code path that only runs in production.
 */

export type DbClient = 'sqlite' | 'postgres';

export interface DatabaseOptions {
  client: DbClient;
  /** File path for SQLite, connection string for Postgres. */
  url: string;
  logger: Logger;
  poolMax?: number;
}

export interface DatabaseHandle<T> {
  db: Kysely<T>;
  /** Readiness probe: proves the connection actually answers a query. */
  ping: () => Promise<void>;
  close: () => Promise<void>;
}

export function createDatabase<T>(options: DatabaseOptions): DatabaseHandle<T> {
  const { client, url, logger } = options;

  const dialect =
    client === 'sqlite' ? createSqliteDialect(url, logger) : createPostgresDialect(options);

  const db = new Kysely<T>({
    dialect,
    log: (event) => {
      if (event.level === 'error') {
        logger.error(
          { err: event.error, durationMs: Math.round(event.queryDurationMillis) },
          'database query failed',
        );
      } else {
        // SQL text only — never the parameters, which contain password hashes
        // and refresh tokens.
        logger.trace(
          { sql: event.query.sql, durationMs: Math.round(event.queryDurationMillis) },
          'database query',
        );
      }
    },
  });

  return {
    db,
    ping: async () => {
      await sql`select 1`.execute(db);
    },
    close: async () => {
      await db.destroy();
      logger.info('database connection closed');
    },
  };
}

function createSqliteDialect(url: string, logger: Logger): Dialect {
  const Database = requireCjs('better-sqlite3') as typeof import('better-sqlite3');

  const isMemory = url === ':memory:' || url.startsWith('file::memory:');
  const path = isMemory ? url : resolve(process.cwd(), url);

  if (!isMemory) {
    // Create the parent directory rather than failing on a missing ./data.
    // A first-run experience should not require the user to mkdir by hand.
    mkdirSync(dirname(path), { recursive: true });
  }

  const database = new Database(path);

  // WAL lets readers proceed while a writer holds the write lock. Without it
  // the outbox publisher's writes would block concurrent HTTP reads.
  if (!isMemory) database.pragma('journal_mode = WAL');
  // NORMAL still survives application crashes (the WAL is replayed); only a
  // host power loss can lose the last commit. Appropriate here, and far faster
  // than FULL for the outbox's write-heavy polling.
  database.pragma('synchronous = NORMAL');
  // SQLite returns SQLITE_BUSY immediately by default; wait instead. The outbox
  // publisher and request handlers do contend for the write lock.
  database.pragma('busy_timeout = 5000');
  // Off by default in SQLite — the outbox and refresh-token foreign keys are
  // only actually enforced with this on.
  database.pragma('foreign_keys = ON');

  logger.info({ client: 'sqlite', path: isMemory ? ':memory:' : path }, 'database initialised');

  return new SqliteDialect({ database });
}

function createPostgresDialect(options: DatabaseOptions): Dialect {
  const { Pool } = requireCjs('pg') as typeof import('pg');

  const pool = new Pool({
    connectionString: options.url,
    max: options.poolMax ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // An idle-client error (server restart, network drop) is emitted on the pool.
  // Unhandled, it would crash the process via the 'error' event.
  pool.on('error', (error) => {
    options.logger.error({ err: error }, 'idle postgres client error');
  });

  options.logger.info({ client: 'postgres' }, 'database initialised');

  return new PostgresDialect({ pool });
}
