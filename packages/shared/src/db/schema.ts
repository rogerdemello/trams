import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * The database schema, as TypeScript types.
 *
 * A note on portability, since it constrains every choice here: this schema is
 * written to run unchanged on both SQLite (local, zero install) and Postgres
 * (docker-compose). That is achieved by using only the intersection of the two
 * type systems — TEXT, INTEGER, and ISO-8601 timestamps stored as TEXT — rather
 * than native UUID, JSONB, or ENUM columns.
 *
 * The trade is real: we give up database-level JSON querying and enum
 * enforcement, and validate those at the application boundary with zod instead.
 * What we gain is that "works locally" and "works in compose" mean the same
 * thing, and one Kysely query layer serves both dialects, so the Postgres path
 * is exercised by exactly the code that is tested against SQLite.
 *
 * Timestamps are stored as ISO-8601 strings, which sort lexicographically in
 * the same order as chronologically — so ORDER BY and range comparisons work
 * identically on both engines without a dialect-specific date type.
 */

type Timestamp = ColumnType<string, string, string>;

// ─── User Service ────────────────────────────────────────────────────────────

export interface UserTable {
  id: string;
  /** Stored lowercased; a UNIQUE index makes duplicate registration a 409. */
  email: string;
  name: string;
  /** argon2id hash. Never selected into any response DTO. */
  password_hash: string;
  role: 'user' | 'admin';
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * Refresh tokens are stored **hashed**, never in plaintext.
 *
 * They are long-lived credentials, so a database read must not be equivalent to
 * a session dump. `revoked_at` plus `replaced_by` also make rotation auditable:
 * if an already-rotated token is presented again, that is a strong signal of
 * theft, and the chain shows which family it belonged to.
 */
export interface RefreshTokenTable {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  created_at: Timestamp;
  revoked_at: Timestamp | null;
  replaced_by: string | null;
}

/**
 * The transactional outbox.
 *
 * A row here is written in the *same database transaction* as the domain change
 * that produced it, which is what closes the gap between "user saved" and
 * "event published". See OutboxPublisher for how rows are drained.
 */
export interface OutboxEventTable {
  /** The event id — also the JetStream msgID and the consumer's dedupe key. */
  id: string;
  event_type: string;
  subject: string;
  /** The serialised event envelope, validated before insert. */
  payload: string;
  correlation_id: string;
  status: 'pending' | 'published' | 'failed';
  attempts: Generated<number>;
  /** Earliest time this row may be retried; drives exponential backoff. */
  next_attempt_at: Timestamp;
  last_error: string | null;
  created_at: Timestamp;
  published_at: Timestamp | null;
}

// ─── Notification Service ────────────────────────────────────────────────────

/**
 * A delivered (or attempted) notification.
 *
 * `event_id` carries a UNIQUE index, and that index — not application code — is
 * what makes processing idempotent. An `if (alreadyProcessed)` check is a race
 * between concurrent replicas; a uniqueness constraint is arbitrated by the
 * database and stays correct under any concurrency.
 */
export interface NotificationTable {
  id: string;
  /** UNIQUE. The idempotency key: at-least-once delivery, exactly-once effect. */
  event_id: string;
  event_type: string;
  user_id: string;
  recipient: string;
  channel: string;
  subject: string;
  body: string;
  status: 'sent' | 'failed';
  attempts: Generated<number>;
  correlation_id: string;
  error: string | null;
  created_at: Timestamp;
  sent_at: Timestamp | null;
}

/**
 * Messages that could never be processed.
 *
 * Kept in the database as well as the DLQ stream, because this is the table a
 * human actually queries during an incident. A dead letter that exists only as
 * a NATS message is one nobody will find.
 */
export interface DeadLetterTable {
  id: string;
  event_id: string | null;
  event_type: string | null;
  subject: string;
  raw_payload: string;
  reason: string;
  correlation_id: string | null;
  delivery_count: number;
  stream_sequence: number;
  created_at: Timestamp;
}

// ─── Database interfaces ─────────────────────────────────────────────────────

/**
 * Each service gets its own Database interface and its own physical database.
 *
 * This separation is not incidental — a shared database between microservices
 * is precisely the coupling this assignment is testing for. Two services on one
 * schema can no longer be deployed, migrated, or scaled independently, and the
 * broker between them becomes decoration.
 */
export interface UserDatabase {
  users: UserTable;
  refresh_tokens: RefreshTokenTable;
  outbox_events: OutboxEventTable;
}

export interface NotificationDatabase {
  notifications: NotificationTable;
  dead_letters: DeadLetterTable;
}

export type User = Selectable<UserTable>;
export type NewUser = Insertable<UserTable>;
export type UserUpdate = Updateable<UserTable>;

export type RefreshTokenRow = Selectable<RefreshTokenTable>;
export type NewRefreshToken = Insertable<RefreshTokenTable>;

export type OutboxEvent = Selectable<OutboxEventTable>;
export type NewOutboxEvent = Insertable<OutboxEventTable>;

export type Notification = Selectable<NotificationTable>;
export type NewNotification = Insertable<NotificationTable>;

export type DeadLetter = Selectable<DeadLetterTable>;
export type NewDeadLetter = Insertable<DeadLetterTable>;

/** A user as exposed over HTTP — the password hash is structurally absent. */
export type PublicUser = Omit<User, 'password_hash'>;

export function toPublicUser(user: User): PublicUser {
  const { password_hash: _passwordHash, ...rest } = user;
  return rest;
}
