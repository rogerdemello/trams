import {
  AccessTokenVerifier,
  closeNats,
  connectToNats,
  ConsumerRuntime,
  createDatabase,
  createLogger,
  DLQ_SUBJECT_NOTIFICATIONS,
  EventPublisher,
  GracefulShutdown,
  loadConfig,
  migrateNotificationDatabase,
  STREAM_USER_EVENTS,
  type DeadLetterSink,
  type NotificationDatabase,
} from '@trams/shared';
import { buildApp } from './app.js';
import { createChannel } from './channels/index.js';
import { DeadLetterRepository } from './repositories/dead-letter-repository.js';
import { NotificationRepository } from './repositories/notification-repository.js';
import { createNotificationHandler } from './services/notification-handler.js';

/**
 * Notification Service entry point.
 *
 * This service has no HTTP path to the User Service and no shared database with
 * it. Its only inbound channel for domain data is the JetStream consumer wired
 * up below.
 */

const config = loadConfig();
const logger = createLogger({
  service: 'notification-service',
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV !== 'production',
});

async function main(): Promise<void> {
  const shutdown = new GracefulShutdown({ logger });

  // ── 1. Database ────────────────────────────────────────────────────────────
  const database = createDatabase<NotificationDatabase>({
    client: config.DB_CLIENT,
    url: config.NOTIFICATION_DB_URL,
    logger,
  });
  shutdown.register('database', () => database.close());
  await migrateNotificationDatabase(database.db, logger);

  const notifications = new NotificationRepository(database.db);
  const deadLetters = new DeadLetterRepository(database.db);

  // ── 2. Token verification (public key only) ────────────────────────────────
  // This service can verify a token but has no way to issue one — it never
  // sees the private key.
  const verifier = new AccessTokenVerifier(config);
  await verifier.init();

  // ── 3. Delivery channel ────────────────────────────────────────────────────
  const channel = createChannel(config, logger);
  // Bound to a local so the optional method is narrowed once, rather than
  // asserted non-null inside the shutdown callback.
  const closeChannel = channel.close?.bind(channel);
  if (closeChannel) shutdown.register('channel', () => closeChannel());

  // ── 4. Broker ──────────────────────────────────────────────────────────────
  const nats = await connectToNats({ config, identity: 'notification-service', logger });
  shutdown.register('nats', () => closeNats(nats, logger));

  /**
   * Note what is absent: this service does NOT create or configure the stream
   * or its consumer. The User Service provisions the topology (see its main.ts)
   * and this service's broker credentials have no stream-management permission
   * at all.
   *
   * That is intentional. A consumer able to reconfigure the stream it reads
   * from is also able to delete the evidence of what it failed to process.
   *
   * The consequence is that this service depends on the topology already
   * existing, which `ConsumerRuntime.start()` handles by retrying — so the two
   * services may boot in any order.
   */

  /**
   * Dead letters are written to BOTH the database and the DLQ stream.
   *
   * The database copy is what a human queries during an incident; the stream
   * copy is the durable original, replayable by a fixed consumer. The database
   * write comes first — if the stream publish fails, we would rather have a
   * queryable record and a warning than lose the dead letter entirely.
   */
  const dlqPublisher = new EventPublisher(nats, logger.child({ component: 'dlq' }));

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

    try {
      await dlqPublisher.publishRaw(
        DLQ_SUBJECT_NOTIFICATIONS,
        {
          reason: input.reason,
          originalSubject: input.subject,
          payload: input.rawPayload,
          eventId: input.eventId,
          deliveryCount: input.deliveryCount,
          streamSequence: input.streamSequence,
          deadLetteredAt: new Date().toISOString(),
        },
        {
          ...(input.eventId ? { msgID: `dlq-${input.eventId}` } : {}),
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        },
      );
    } catch (error) {
      // Non-fatal: the durable database record already exists, so the dead
      // letter is not lost. Log loudly and carry on rather than failing the
      // sink, which would leave the message endlessly redelivered.
      logger.error(
        { err: error, eventId: input.eventId },
        'failed to publish to DLQ stream — database record was written',
      );
    }
  };

  // ── 5. Consumer runtime ────────────────────────────────────────────────────
  const consumer = new ConsumerRuntime({
    connection: nats,
    stream: STREAM_USER_EVENTS,
    durableName: config.NOTIFICATION_CONSUMER_NAME,
    handler: createNotificationHandler({ repository: notifications, channel }),
    deadLetterSink,
    logger: logger.child({ component: 'consumer' }),
    maxDeliver: config.NOTIFICATION_MAX_DELIVER,
    fetchBatch: config.NOTIFICATION_FETCH_BATCH,
  });

  await consumer.start();
  shutdown.register('consumer', () => consumer.stop());

  // ── 6. HTTP server (read-only) ─────────────────────────────────────────────
  const app = await buildApp({
    config,
    logger,
    verifier,
    notifications,
    deadLetters,
    dependencies: [
      { name: 'database', check: () => database.ping() },
      {
        name: 'nats',
        check: async () => {
          if (nats.isClosed()) throw new Error('NATS connection is closed');
        },
      },
      {
        name: `channel:${channel.name}`,
        check: async () => {
          if (channel.verify) await channel.verify();
        },
      },
    ],
  });

  // Registered last, so it tears down first: stop accepting HTTP, then drain
  // the consumer's in-flight messages, then close the broker, then the database.
  shutdown.register('http-server', () => app.close());
  shutdown.listen();

  await app.listen({
    port: config.NOTIFICATION_SERVICE_PORT,
    host: config.NOTIFICATION_SERVICE_HOST,
  });

  logger.info(
    {
      port: config.NOTIFICATION_SERVICE_PORT,
      channel: channel.name,
      consumer: config.NOTIFICATION_CONSUMER_NAME,
      maxDeliver: config.NOTIFICATION_MAX_DELIVER,
    },
    'notification-service ready',
  );
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'notification-service failed to start');
  process.exit(1);
});
