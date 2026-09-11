import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { NatsConnection } from '@nats-io/transport-node';
import {
  AccessTokenVerifier,
  ConsumerRuntime,
  connectToNats,
  createDatabase,
  createJetStreamManager,
  createLogger,
  ensureConsumer,
  ensureStreams,
  EventPublisher,
  loadConfig,
  migrateNotificationDatabase,
  migrateUserDatabase,
  resetConfigCache,
  STREAM_USER_EVENTS,
  STREAM_USER_EVENTS_DLQ,
  type DatabaseHandle,
  type DeadLetterSink,
  type NotificationDatabase,
  type UserDatabase,
} from '@trams/shared';
import { buildApp } from '../../services/user-service/src/app.js';
import { TokenService } from '../../services/user-service/src/domain/tokens.js';
import { OutboxRepository } from '../../services/user-service/src/repositories/outbox-repository.js';
import { RefreshTokenRepository } from '../../services/user-service/src/repositories/refresh-token-repository.js';
import { UserRepository } from '../../services/user-service/src/repositories/user-repository.js';
import { AuthService } from '../../services/user-service/src/services/auth-service.js';
import { OutboxPublisher } from '../../services/user-service/src/services/outbox-publisher.js';
import { UserManagementService } from '../../services/user-service/src/services/user-service.js';
import { RecordingChannel } from '../../services/notification-service/src/channels/index.js';
import { DeadLetterRepository } from '../../services/notification-service/src/repositories/dead-letter-repository.js';
import { NotificationRepository } from '../../services/notification-service/src/repositories/notification-repository.js';
import { createNotificationHandler } from '../../services/notification-service/src/services/notification-handler.js';

/**
 * Wires both services together against the real test broker.
 *
 * This is intentionally the production wiring — the same repositories, the same
 * OutboxPublisher, the same ConsumerRuntime, the same JetStream topology. Only
 * two things are substituted:
 *
 *   - in-memory SQLite instead of files (fast, isolated per test)
 *   - RecordingChannel instead of console/SMTP, so a test can assert on what
 *     was delivered and inject failures
 *
 * Everything that carries a delivery guarantee is the real implementation. A
 * harness that stubbed the publisher or the consumer would be testing the
 * harness.
 */

export const TEST_INTERNAL_TOKEN = 'test-internal-token';

export interface Harness {
  app: FastifyInstance;
  channel: RecordingChannel;
  outboxPublisher: OutboxPublisher;
  outbox: OutboxRepository;
  notifications: NotificationRepository;
  deadLetters: DeadLetterRepository;
  publisher: EventPublisher;
  userDb: DatabaseHandle<UserDatabase>;
  notificationDb: DatabaseHandle<NotificationDatabase>;
  producerNats: NatsConnection;
  consumerNats: NatsConnection;
  consumer: ConsumerRuntime;
  /** Unique per harness, so parallel suites do not share a consumer position. */
  consumerName: string;
  /** Drain the outbox immediately instead of waiting for the poll interval. */
  drainOutbox: () => Promise<{ published: number; failed: number }>;
  registerUser: (overrides?: {
    email?: string;
    password?: string;
    name?: string;
    correlationId?: string;
  }) => Promise<{ userId: string; accessToken: string; refreshToken: string; email: string }>;
  teardown: () => Promise<void>;
}

export interface HarnessOptions {
  /** Deliveries before the broker gives up and the runtime dead-letters. */
  maxDeliver?: number;
  /** Start the consumer loop. Disable to test the producer side in isolation. */
  startConsumer?: boolean;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { maxDeliver = 3, startConsumer = true } = options;

  // A distinct durable consumer per harness. Without this, two test files would
  // share one consumer position and steal each other's messages.
  const consumerName = `test-worker-${randomUUID().slice(0, 8)}`;

  resetConfigCache();
  process.env['INTERNAL_TOKEN'] = TEST_INTERNAL_TOKEN;
  process.env['NOTIFICATION_CONSUMER_NAME'] = consumerName;
  process.env['NOTIFICATION_MAX_DELIVER'] = String(maxDeliver);
  // Short ack_wait so redelivery tests do not spend 30s waiting.
  process.env['NOTIFICATION_ACK_WAIT_MS'] = '3000';
  const config = loadConfig();

  const logger = createLogger({ service: 'test', level: 'silent' });

  // ── Databases: separate, as in production ─────────────────────────────────
  const userDb = createDatabase<UserDatabase>({ client: 'sqlite', url: ':memory:', logger });
  const notificationDb = createDatabase<NotificationDatabase>({
    client: 'sqlite',
    url: ':memory:',
    logger,
  });
  await migrateUserDatabase(userDb.db, logger);
  await migrateNotificationDatabase(notificationDb.db, logger);

  // ── Producer side ──────────────────────────────────────────────────────────
  const producerNats = await connectToNats({ config, identity: 'user-service', logger });
  const jsm = await createJetStreamManager(producerNats);
  await ensureStreams(jsm, logger);

  /**
   * Purge the streams before this harness's consumer is created.
   *
   * The broker is shared by the whole suite and JetStream streams are durable,
   * so without this a new harness's consumer — which uses the production
   * `deliver_policy: All` — would replay every event published by every earlier
   * test. That is not a hypothetical: it initially caused a dead-letter test to
   * quarantine an unrelated `user.updated` event leaked from another file.
   *
   * Purging (rather than switching the consumer to `deliver_policy: New`) keeps
   * the consumer configuration identical to production, so the tests still
   * exercise the real backlog-processing behaviour.
   */
  await purgeStreams();

  await ensureConsumer(jsm, logger, {
    stream: STREAM_USER_EVENTS,
    durableName: consumerName,
    filterSubject: 'user.>',
    ackWaitMs: config.NOTIFICATION_ACK_WAIT_MS,
    maxDeliver,
    maxAckPending: config.NOTIFICATION_MAX_ACK_PENDING,
  });

  const publisher = new EventPublisher(producerNats, logger);
  const users = new UserRepository();
  const refreshTokens = new RefreshTokenRepository();
  const outbox = new OutboxRepository();

  const tokens = new TokenService(config);
  await tokens.init();
  const verifier = new AccessTokenVerifier(config);
  await verifier.init();

  const authService = new AuthService({
    db: userDb.db,
    users,
    refreshTokens,
    outbox,
    tokens,
    logger,
    accessTokenTtl: config.ACCESS_TOKEN_TTL,
  });
  await authService.init();

  const userService = new UserManagementService({
    db: userDb.db,
    users,
    refreshTokens,
    outbox,
    logger,
  });

  const outboxPublisher = new OutboxPublisher({
    db: userDb.db,
    repository: outbox,
    publisher,
    logger,
    // Long interval: tests call drainOutbox() explicitly so they are
    // deterministic rather than sleeping and hoping.
    pollIntervalMs: 60_000,
    batchSize: config.OUTBOX_BATCH_SIZE,
    maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
  });

  const app = await buildApp({
    config,
    logger,
    db: userDb.db,
    verifier,
    authService,
    userService,
    dependencies: [],
  });
  await app.ready();

  // ── Consumer side ──────────────────────────────────────────────────────────
  const notifications = new NotificationRepository(notificationDb.db);
  const deadLetters = new DeadLetterRepository(notificationDb.db);
  const channel = new RecordingChannel();

  const deadLetterSink: DeadLetterSink = async (input) => {
    await deadLetters.record({
      subject: input.subject,
      rawPayload: input.rawPayload,
      reason: input.reason,
      deliveryCount: input.deliveryCount,
      streamSequence: input.streamSequence,
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.eventType ? { eventType: input.eventType } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
  };

  const consumerNats = await connectToNats({
    config,
    identity: 'notification-service',
    logger,
  });

  const consumer = new ConsumerRuntime({
    connection: consumerNats,
    stream: STREAM_USER_EVENTS,
    durableName: consumerName,
    handler: createNotificationHandler({ repository: notifications, channel }),
    deadLetterSink,
    logger,
    maxDeliver,
    fetchBatch: 10,
    // Tight backoff so retry tests finish quickly.
    backoff: { baseMs: 200, maxMs: 1_000, jitter: 0 },
  });

  if (startConsumer) await consumer.start();

  return {
    app,
    channel,
    outboxPublisher,
    outbox,
    notifications,
    deadLetters,
    publisher,
    userDb,
    notificationDb,
    producerNats,
    consumerNats,
    consumer,
    consumerName,

    drainOutbox: () => outboxPublisher.drain(),

    registerUser: async (overrides = {}) => {
      const email = overrides.email ?? `user-${randomUUID().slice(0, 8)}@trams.test`;
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        headers: {
          'x-internal-token': TEST_INTERNAL_TOKEN,
          ...(overrides.correlationId ? { 'x-correlation-id': overrides.correlationId } : {}),
        },
        payload: {
          email,
          password: overrides.password ?? 'Str0ng!Passw0rd',
          name: overrides.name ?? 'Test User',
        },
      });

      if (response.statusCode !== 201) {
        throw new Error(`registration failed: ${response.statusCode} ${response.body}`);
      }

      const body = response.json();
      return {
        userId: body.user.id,
        accessToken: body.tokens.accessToken,
        refreshToken: body.tokens.refreshToken,
        email: body.user.email,
      };
    },

    teardown: async () => {
      await consumer.stop();
      await outboxPublisher.stop();
      await app.close();
      await producerNats.drain().catch(() => undefined);
      await consumerNats.drain().catch(() => undefined);
      await userDb.close();
      await notificationDb.close();
    },
  };
}

/**
 * Empty both streams using the harness-only admin account.
 *
 * Purge permission deliberately does not belong to either service account —
 * see TEST_NATS_USERS.testAdmin — so this opens its own short-lived connection.
 */
async function purgeStreams(): Promise<void> {
  const { connect, usernamePasswordAuthenticator } = await import('@nats-io/transport-node');
  const config = loadConfig();

  const admin = await connect({
    servers: config.NATS_URL,
    authenticator: usernamePasswordAuthenticator(
      process.env['TEST_ADMIN_USER'] ?? 'test-admin',
      process.env['TEST_ADMIN_PASS'] ?? 'test-admin-pass',
    ),
    tls: {
      caFile: config.NATS_CA_PATH,
      certFile: config.NATS_CLIENT_CERT_PATH,
      keyFile: config.NATS_CLIENT_KEY_PATH,
    },
  });

  try {
    const jsm = await createJetStreamManager(admin);
    for (const stream of [STREAM_USER_EVENTS, STREAM_USER_EVENTS_DLQ]) {
      // A stream that does not exist yet is not an error worth failing on.
      await jsm.streams.purge(stream).catch(() => undefined);
    }
  } finally {
    await admin.close();
  }
}

/** Poll until `predicate` holds or the timeout expires. */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const { timeoutMs = 15_000, intervalMs = 100, label = 'condition' } = options;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
