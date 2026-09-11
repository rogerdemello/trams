import {
  AccessTokenVerifier,
  closeNats,
  connectToNats,
  createDatabase,
  createJetStreamManager,
  createLogger,
  ensureConsumer,
  ensureStreams,
  EventPublisher,
  GracefulShutdown,
  loadConfig,
  migrateUserDatabase,
  notificationConsumerSpec,
  type UserDatabase,
} from '@trams/shared';
import { buildApp } from './app.js';
import { TokenService } from './domain/tokens.js';
import { OutboxRepository } from './repositories/outbox-repository.js';
import { RefreshTokenRepository } from './repositories/refresh-token-repository.js';
import { UserRepository } from './repositories/user-repository.js';
import { AuthService } from './services/auth-service.js';
import { OutboxPublisher } from './services/outbox-publisher.js';
import { UserManagementService } from './services/user-service.js';

/**
 * User Service entry point.
 *
 * Startup order is deliberate, and each step must succeed before the service
 * accepts traffic. Anything that fails here should fail loudly at boot rather
 * than surface as a 500 on the first real request.
 */

const config = loadConfig();
const logger = createLogger({
  service: 'user-service',
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV !== 'production',
});

async function main(): Promise<void> {
  const shutdown = new GracefulShutdown({ logger });

  // ── 1. Database ────────────────────────────────────────────────────────────
  const database = createDatabase<UserDatabase>({
    client: config.DB_CLIENT,
    url: config.USER_DB_URL,
    logger,
  });
  shutdown.register('database', () => database.close());

  // Migrate on boot so a fresh clone works with one command. In a multi-replica
  // deployment this belongs in a release step instead — noted in the README.
  await migrateUserDatabase(database.db, logger);

  // ── 2. Token services ──────────────────────────────────────────────────────
  // Key material is loaded now, so a missing key is a startup error with a
  // clear remedy rather than a failed login later.
  //
  // Two objects, deliberately: TokenService holds the private key and is the
  // only thing in the system that can sign, while AccessTokenVerifier holds
  // only the public key and is what the request path uses.
  const tokens = new TokenService(config);
  await tokens.init();

  const verifier = new AccessTokenVerifier(config);
  await verifier.init();

  // ── 3. Broker ──────────────────────────────────────────────────────────────
  const nats = await connectToNats({ config, identity: 'user-service', logger });
  shutdown.register('nats', () => closeNats(nats, logger));

  /**
   * The User Service owns the stream topology, as the producer and the owner of
   * the domain. It provisions its own streams *and* the notification consumer.
   *
   * Provisioning the consumer here rather than in the Notification Service is
   * what removes any startup ordering dependency between the two: either
   * service can boot first, in any order, and the topology still ends up
   * correct. It also keeps stream-management permissions out of the consumer's
   * credentials entirely (see infra/nats/nats.conf) — a consumer that can
   * reconfigure its own stream can also erase the evidence of what it failed to
   * process.
   */
  const jsm = await createJetStreamManager(nats);
  await ensureStreams(jsm, logger);
  await ensureConsumer(jsm, logger, notificationConsumerSpec(config));

  // ── 4. Repositories and services ───────────────────────────────────────────
  const users = new UserRepository();
  const refreshTokens = new RefreshTokenRepository();
  const outbox = new OutboxRepository();

  const authService = new AuthService({
    db: database.db,
    users,
    refreshTokens,
    outbox,
    tokens,
    logger: logger.child({ component: 'auth' }),
    accessTokenTtl: config.ACCESS_TOKEN_TTL,
  });
  await authService.init();

  const userService = new UserManagementService({
    db: database.db,
    users,
    refreshTokens,
    outbox,
    logger: logger.child({ component: 'users' }),
  });

  // ── 5. Outbox publisher ────────────────────────────────────────────────────
  const outboxPublisher = new OutboxPublisher({
    db: database.db,
    repository: outbox,
    publisher: new EventPublisher(nats, logger.child({ component: 'publisher' })),
    logger: logger.child({ component: 'outbox' }),
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    batchSize: config.OUTBOX_BATCH_SIZE,
    maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
  });
  outboxPublisher.start();
  shutdown.register('outbox-publisher', () => outboxPublisher.stop());

  // ── 6. HTTP server ─────────────────────────────────────────────────────────
  const app = await buildApp({
    config,
    logger,
    db: database.db,
    verifier,
    authService,
    userService,
    dependencies: [
      { name: 'database', check: () => database.ping() },
      {
        name: 'nats',
        check: async () => {
          if (nats.isClosed()) throw new Error('NATS connection is closed');
        },
      },
    ],
  });

  /**
   * Registered LAST, so it tears down FIRST (handlers run in reverse order).
   *
   * That ordering is the graceful part: stop accepting new requests, then drain
   * the outbox publisher, then close the broker connection, then the database.
   * Closing the database while a request is still in flight would turn a clean
   * shutdown into a burst of 500s.
   */
  shutdown.register('http-server', () => app.close());
  shutdown.listen();

  await app.listen({ port: config.USER_SERVICE_PORT, host: config.USER_SERVICE_HOST });

  logger.info(
    {
      port: config.USER_SERVICE_PORT,
      host: config.USER_SERVICE_HOST,
      dbClient: config.DB_CLIENT,
    },
    'user-service ready',
  );
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'user-service failed to start');
  process.exit(1);
});
