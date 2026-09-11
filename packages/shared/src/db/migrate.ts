import { Kysely, sql } from 'kysely';
import type { Logger } from 'pino';
import type { NotificationDatabase, UserDatabase } from './schema.js';

/**
 * Migrations expressed with Kysely's schema builder rather than raw SQL, so a
 * single definition emits correct DDL for both SQLite and Postgres.
 *
 * Hand-written SQL would mean two dialect variants that drift; this keeps one
 * source of truth. Each migration is wrapped in `IF NOT EXISTS` semantics and
 * recorded in a `_migrations` table, so running it repeatedly is a no-op — the
 * bootstrap script and the test harness both rely on that.
 */

interface Migration {
  name: string;
  up: (db: Kysely<never>) => Promise<void>;
}

const ISO_NOW = () => new Date().toISOString();

// ─── User Service migrations ─────────────────────────────────────────────────

const userMigrations: Migration[] = [
  {
    name: '001_create_users',
    up: async (db) => {
      await db.schema
        .createTable('users')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('email', 'text', (col) => col.notNull())
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('password_hash', 'text', (col) => col.notNull())
        .addColumn('role', 'text', (col) => col.notNull().defaultTo('user'))
        .addColumn('created_at', 'text', (col) => col.notNull())
        .addColumn('updated_at', 'text', (col) => col.notNull())
        .execute();

      // UNIQUE on a lowercased email is what turns a duplicate registration
      // into a clean 409 instead of two accounts that differ only by case.
      // Enforced by the database because a check-then-insert in application
      // code is a race between concurrent requests.
      await db.schema
        .createIndex('users_email_unique')
        .ifNotExists()
        .on('users')
        .column('email')
        .unique()
        .execute();
    },
  },
  {
    name: '002_create_refresh_tokens',
    up: async (db) => {
      await db.schema
        .createTable('refresh_tokens')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('user_id', 'text', (col) =>
          // Cascade: deleting a user must not leave usable credentials behind.
          col.notNull().references('users.id').onDelete('cascade'),
        )
        .addColumn('token_hash', 'text', (col) => col.notNull())
        .addColumn('expires_at', 'text', (col) => col.notNull())
        .addColumn('created_at', 'text', (col) => col.notNull())
        .addColumn('revoked_at', 'text')
        .addColumn('replaced_by', 'text')
        .execute();

      // Lookup is by hash — the plaintext token is never stored, so this is the
      // only way to find a presented token.
      await db.schema
        .createIndex('refresh_tokens_hash_unique')
        .ifNotExists()
        .on('refresh_tokens')
        .column('token_hash')
        .unique()
        .execute();

      await db.schema
        .createIndex('refresh_tokens_user_idx')
        .ifNotExists()
        .on('refresh_tokens')
        .column('user_id')
        .execute();
    },
  },
  {
    name: '003_create_outbox_events',
    up: async (db) => {
      await db.schema
        .createTable('outbox_events')
        .ifNotExists()
        // The event id is the primary key, which makes it structurally
        // impossible to enqueue the same event twice.
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('event_type', 'text', (col) => col.notNull())
        .addColumn('subject', 'text', (col) => col.notNull())
        .addColumn('payload', 'text', (col) => col.notNull())
        .addColumn('correlation_id', 'text', (col) => col.notNull())
        .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
        .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('next_attempt_at', 'text', (col) => col.notNull())
        .addColumn('last_error', 'text')
        .addColumn('created_at', 'text', (col) => col.notNull())
        .addColumn('published_at', 'text')
        .execute();

      // The publisher's hot path is "pending rows due now, oldest first". This
      // composite index keeps that a range scan rather than a full table scan
      // that grows with every event ever published.
      await db.schema
        .createIndex('outbox_pending_idx')
        .ifNotExists()
        .on('outbox_events')
        .columns(['status', 'next_attempt_at'])
        .execute();
    },
  },
];

// ─── Notification Service migrations ─────────────────────────────────────────

const notificationMigrations: Migration[] = [
  {
    name: '001_create_notifications',
    up: async (db) => {
      await db.schema
        .createTable('notifications')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('event_id', 'text', (col) => col.notNull())
        .addColumn('event_type', 'text', (col) => col.notNull())
        .addColumn('user_id', 'text', (col) => col.notNull())
        .addColumn('recipient', 'text', (col) => col.notNull())
        .addColumn('channel', 'text', (col) => col.notNull())
        .addColumn('subject', 'text', (col) => col.notNull())
        .addColumn('body', 'text', (col) => col.notNull())
        .addColumn('status', 'text', (col) => col.notNull())
        .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('correlation_id', 'text', (col) => col.notNull())
        .addColumn('error', 'text')
        .addColumn('created_at', 'text', (col) => col.notNull())
        .addColumn('sent_at', 'text')
        .execute();

      // ─────────────────────────────────────────────────────────────────────
      // The single most important line in the schema.
      //
      // JetStream guarantees at-least-once delivery, so the same event WILL
      // arrive twice — after an ack_wait expiry, a worker crash, or a rebalance.
      // This UNIQUE index is what converts at-least-once *delivery* into
      // exactly-once *effect*: the second insert fails, the handler recognises
      // the violation, and acks without sending a duplicate notification.
      //
      // Deliberately a database constraint rather than an application check.
      // `SELECT ... IF NOT EXISTS THEN INSERT` is a race two replicas will
      // eventually lose; a unique index is arbitrated by the database and
      // remains correct at any concurrency.
      // ─────────────────────────────────────────────────────────────────────
      await db.schema
        .createIndex('notifications_event_id_unique')
        .ifNotExists()
        .on('notifications')
        .column('event_id')
        .unique()
        .execute();

      // Supports the notification-history endpoint: a user's own notifications,
      // newest first.
      await db.schema
        .createIndex('notifications_user_created_idx')
        .ifNotExists()
        .on('notifications')
        .columns(['user_id', 'created_at'])
        .execute();
    },
  },
  {
    name: '002_create_dead_letters',
    up: async (db) => {
      await db.schema
        .createTable('dead_letters')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('event_id', 'text')
        .addColumn('event_type', 'text')
        .addColumn('subject', 'text', (col) => col.notNull())
        .addColumn('raw_payload', 'text', (col) => col.notNull())
        .addColumn('reason', 'text', (col) => col.notNull())
        .addColumn('correlation_id', 'text')
        .addColumn('delivery_count', 'integer', (col) => col.notNull())
        .addColumn('stream_sequence', 'integer', (col) => col.notNull())
        .addColumn('created_at', 'text', (col) => col.notNull())
        .execute();

      await db.schema
        .createIndex('dead_letters_created_idx')
        .ifNotExists()
        .on('dead_letters')
        .column('created_at')
        .execute();
    },
  },
];

// ─── Runner ──────────────────────────────────────────────────────────────────

async function runMigrations(
  db: Kysely<never>,
  migrations: Migration[],
  logger: Logger,
): Promise<void> {
  await db.schema
    .createTable('_migrations')
    .ifNotExists()
    .addColumn('name', 'text', (col) => col.primaryKey())
    .addColumn('applied_at', 'text', (col) => col.notNull())
    .execute();

  const applied = await sql<{ name: string }>`select name from _migrations`.execute(db);
  const alreadyApplied = new Set(applied.rows.map((row) => row.name));

  for (const migration of migrations) {
    if (alreadyApplied.has(migration.name)) {
      logger.debug({ migration: migration.name }, 'migration already applied');
      continue;
    }

    await migration.up(db);
    await sql`insert into _migrations (name, applied_at) values (${migration.name}, ${ISO_NOW()})`.execute(
      db,
    );
    logger.info({ migration: migration.name }, 'migration applied');
  }
}

export async function migrateUserDatabase(db: Kysely<UserDatabase>, logger: Logger): Promise<void> {
  await runMigrations(db as unknown as Kysely<never>, userMigrations, logger);
}

export async function migrateNotificationDatabase(
  db: Kysely<NotificationDatabase>,
  logger: Logger,
): Promise<void> {
  await runMigrations(db as unknown as Kysely<never>, notificationMigrations, logger);
}
