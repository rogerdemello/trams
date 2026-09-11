/**
 * Subject names and stream configuration, defined once.
 *
 * Nothing in this system may write a subject as an inline string literal. In a
 * request/response system a typo'd URL gives you an immediate 404; in pub/sub a
 * typo'd subject publishes successfully to a subject nobody listens on. The
 * message is accepted, the caller sees success, and the side effect silently
 * never happens. Constants turn that class of bug into a compile error.
 */

export const STREAM_USER_EVENTS = 'USER_EVENTS';
export const STREAM_USER_EVENTS_DLQ = 'USER_EVENTS_DLQ';

/** Everything the User Service is permitted to publish. */
export const USER_SUBJECT_PREFIX = 'user';
export const USER_SUBJECT_WILDCARD = 'user.>';

export const SUBJECTS = {
  userRegistered: 'user.registered',
  userUpdated: 'user.updated',
  userPasswordChanged: 'user.password_changed',
  userDeleted: 'user.deleted',
} as const;

export type Subject = (typeof SUBJECTS)[keyof typeof SUBJECTS];

/** Terminal failures are parked here rather than dropped. */
export const DLQ_SUBJECT_PREFIX = 'dlq';
export const DLQ_SUBJECT_WILDCARD = 'dlq.>';
export const DLQ_SUBJECT_NOTIFICATIONS = 'dlq.notifications';

/**
 * How long JetStream remembers a message id for deduplication.
 *
 * This window is what makes a publisher retry safe. If the outbox publisher
 * sends a message, the ack is lost in transit, and it retries, the broker
 * recognises the repeated `Nats-Msg-Id` and discards the duplicate instead of
 * appending it to the stream.
 *
 * Two minutes comfortably exceeds the outbox's own retry backoff, so a retry
 * always lands inside the window. It is a safety net, not the primary defence —
 * the consumer's unique constraint on `event_id` is what guarantees correctness
 * if a duplicate ever does get through.
 */
export const DEDUPE_WINDOW_NANOS = 2 * 60 * 1_000_000_000;
