#!/usr/bin/env tsx
/**
 * Apply migrations to both service databases.
 *
 * Each service owns its own physical database, so this runs twice against two
 * separate connections. That separation is not incidental — a shared database
 * between two microservices is exactly the coupling this system is built to
 * avoid, and having one migration entry point that opens two connections keeps
 * that visible rather than letting it quietly collapse into one schema.
 *
 * Safe to run repeatedly: every migration is recorded in a `_migrations` table
 * and skipped once applied.
 *
 *   npm run db:migrate
 */

import {
  createDatabase,
  createLogger,
  loadConfig,
  migrateNotificationDatabase,
  migrateUserDatabase,
  type NotificationDatabase,
  type UserDatabase,
} from '@trams/shared';

const config = loadConfig();
const logger = createLogger({
  service: 'migrate',
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV !== 'production',
});

async function main(): Promise<void> {
  const userDb = createDatabase<UserDatabase>({
    client: config.DB_CLIENT,
    url: config.USER_DB_URL,
    logger: logger.child({ database: 'user-service' }),
  });

  const notificationDb = createDatabase<NotificationDatabase>({
    client: config.DB_CLIENT,
    url: config.NOTIFICATION_DB_URL,
    logger: logger.child({ database: 'notification-service' }),
  });

  try {
    await migrateUserDatabase(userDb.db, logger.child({ database: 'user-service' }));
    await migrateNotificationDatabase(
      notificationDb.db,
      logger.child({ database: 'notification-service' }),
    );
    logger.info({ client: config.DB_CLIENT }, 'migrations complete for both service databases');
  } finally {
    // Closed in a finally block so a failed migration still releases its
    // connections — otherwise the process hangs instead of reporting the error.
    await userDb.close();
    await notificationDb.close();
  }
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'migration failed');
  process.exit(1);
});
