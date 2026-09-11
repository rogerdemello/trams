/**
 * Public surface of @trams/shared.
 *
 * Everything both services must agree on lives behind this single entry point:
 * the event contract, the NATS runtime, the data layer, and the cross-cutting
 * HTTP concerns. If a type is exported here it is part of a contract; if it is
 * not, it is an implementation detail of one service.
 */

// Configuration and observability
export { loadConfig, resetConfigCache, readPem, type Config } from './config.js';
export {
  createLogger,
  withCorrelationId,
  currentCorrelationId,
  REDACTED_PATHS,
  type Logger,
  type LoggerOptions,
} from './logger.js';
export {
  AppError,
  isAppError,
  toProblemDetails,
  type ErrorCode,
  type ProblemDetails,
} from './errors.js';
export { GracefulShutdown, type ShutdownOptions } from './shutdown.js';

// Authentication (verification only — signing lives in the User Service)
export { AccessTokenVerifier, type AccessTokenClaims } from './auth/verifier.js';

// HTTP building blocks
export { correlation, CORRELATION_HEADER } from './http/correlation.js';
export { errorHandler } from './http/error-handler.js';
export { health, type DependencyCheck, type HealthOptions } from './http/health.js';
export { bearerAuth, requireUser } from './http/bearer-auth.js';
export { internalAuth, INTERNAL_TOKEN_HEADER } from './http/internal-auth.js';

// The event contract — the only thing both backend services depend on
export {
  SUBJECTS,
  STREAM_USER_EVENTS,
  STREAM_USER_EVENTS_DLQ,
  USER_SUBJECT_PREFIX,
  USER_SUBJECT_WILDCARD,
  DLQ_SUBJECT_PREFIX,
  DLQ_SUBJECT_WILDCARD,
  DLQ_SUBJECT_NOTIFICATIONS,
  DEDUPE_WINDOW_NANOS,
  type Subject,
} from './events/subjects.js';
export {
  buildEvent,
  parseEvent,
  eventEnvelopeSchema,
  eventPayloads,
  CURRENT_EVENT_VERSION,
  type EventEnvelope,
  type EventType,
  type DomainEvent,
  type UserRegisteredEvent,
  type UserUpdatedEvent,
  type UserPasswordChangedEvent,
  type UserDeletedEvent,
  type BuildEventInput,
  type ParseResult,
} from './events/schemas.js';

// NATS runtime
export { connectToNats, closeNats, type ServiceIdentity } from './nats/connection.js';
export {
  createJetStreamManager,
  ensureStreams,
  ensureConsumer,
  notificationConsumerSpec,
  type ConsumerSpec,
} from './nats/streams.js';
export { EventPublisher, type PublishResult } from './nats/publisher.js';
export {
  ConsumerRuntime,
  ACK,
  retry,
  deadLetter,
  type HandlerOutcome,
  type EventHandler,
  type MessageContext,
  type DeadLetterSink,
  type ConsumerRuntimeOptions,
} from './nats/consumer.js';
export {
  backoffDelay,
  nextAttemptAt,
  DEFAULT_BACKOFF,
  type BackoffOptions,
} from './nats/backoff.js';

// Data layer
export {
  createDatabase,
  type DbClient,
  type DatabaseOptions,
  type DatabaseHandle,
} from './db/connection.js';
export { migrateUserDatabase, migrateNotificationDatabase } from './db/migrate.js';
export {
  toPublicUser,
  type UserDatabase,
  type NotificationDatabase,
  type UserTable,
  type RefreshTokenTable,
  type OutboxEventTable,
  type NotificationTable,
  type DeadLetterTable,
  type User,
  type NewUser,
  type UserUpdate,
  type PublicUser,
  type RefreshTokenRow,
  type NewRefreshToken,
  type OutboxEvent,
  type NewOutboxEvent,
  type Notification,
  type NewNotification,
  type DeadLetter,
  type NewDeadLetter,
} from './db/schema.js';
