import { z } from 'zod';
import { SUBJECTS } from './subjects.js';

/**
 * The event contract — the only thing the User Service and the Notification
 * Service both depend on, and therefore the most important file in the repo.
 *
 * This module lives in a shared package for a specific reason. If the producer
 * and the consumer each kept their own copy of the message shape, they would
 * drift, and the first payload change would break the consumer at runtime with
 * no compile-time warning. One definition, imported by both, turns a schema
 * mismatch into a build failure instead of a production incident.
 *
 * The envelope/payload split follows from the same reasoning: envelope fields
 * are what the *infrastructure* needs (routing, dedupe, tracing, versioning)
 * and `data` is what the *domain* needs. Infrastructure can inspect any event
 * without knowing its type.
 */

/** Passwords never appear in an event. Consumers only ever need identity. */
const userIdentity = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1).max(200),
});

export const eventPayloads = {
  [SUBJECTS.userRegistered]: userIdentity,
  [SUBJECTS.userUpdated]: userIdentity.extend({
    changedFields: z.array(z.string()).min(1),
  }),
  [SUBJECTS.userPasswordChanged]: z.object({
    userId: z.string().uuid(),
    email: z.string().email(),
    name: z.string().min(1).max(200),
    // A security-relevant notification should say when and roughly from where,
    // so a user can recognise a change they did not make.
    changedAt: z.string().datetime(),
    ipAddress: z.string().optional(),
  }),
  [SUBJECTS.userDeleted]: z.object({
    userId: z.string().uuid(),
    email: z.string().email(),
    name: z.string().min(1).max(200),
    deletedAt: z.string().datetime(),
  }),
} as const;

export type EventType = keyof typeof eventPayloads;

export const CURRENT_EVENT_VERSION = 1;

/**
 * Envelope fields common to every event.
 *
 * `version` is in the envelope, not the payload, because a consumer must be
 * able to decide how to interpret `data` *before* parsing it. That is what
 * allows the two services to be deployed independently: a consumer that sees
 * version 2 while it only understands version 1 can route the message to the
 * DLQ deliberately, instead of misreading it.
 */
const envelopeBase = z.object({
  /** Doubles as the JetStream `Nats-Msg-Id` and the consumer's idempotency key. */
  id: z.string().uuid(),
  version: z.number().int().positive(),
  /** Set by the producer at the moment the fact became true, not at publish time. */
  occurredAt: z.string().datetime(),
  /** Threaded from the originating HTTP request through to the consumer's logs. */
  correlationId: z.string().min(1).max(128),
  actor: z.object({ userId: z.string().uuid() }),
});

/**
 * A discriminated union over `type`, which gives exhaustive `switch` checking
 * in the consumer: adding a new event type without handling it becomes a
 * TypeScript error rather than a message that falls through to the DLQ.
 */
export const eventEnvelopeSchema = z.discriminatedUnion('type', [
  envelopeBase.extend({
    type: z.literal(SUBJECTS.userRegistered),
    data: eventPayloads[SUBJECTS.userRegistered],
  }),
  envelopeBase.extend({
    type: z.literal(SUBJECTS.userUpdated),
    data: eventPayloads[SUBJECTS.userUpdated],
  }),
  envelopeBase.extend({
    type: z.literal(SUBJECTS.userPasswordChanged),
    data: eventPayloads[SUBJECTS.userPasswordChanged],
  }),
  envelopeBase.extend({
    type: z.literal(SUBJECTS.userDeleted),
    data: eventPayloads[SUBJECTS.userDeleted],
  }),
]);

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** Narrow helper for a single event type, e.g. `DomainEvent<'user.registered'>`. */
export type DomainEvent<T extends EventType = EventType> = Extract<EventEnvelope, { type: T }>;

export type UserRegisteredEvent = DomainEvent<'user.registered'>;
export type UserUpdatedEvent = DomainEvent<'user.updated'>;
export type UserPasswordChangedEvent = DomainEvent<'user.password_changed'>;
export type UserDeletedEvent = DomainEvent<'user.deleted'>;

export interface BuildEventInput<T extends EventType> {
  id: string;
  type: T;
  correlationId: string;
  actorUserId: string;
  data: z.infer<(typeof eventPayloads)[T]>;
  occurredAt?: string;
}

/**
 * Construct a validated envelope.
 *
 * Validation happens here, at publish time, rather than only on the consuming
 * side. Rejecting a malformed event before it enters the stream keeps a poison
 * message out of the system entirely — much cheaper than discovering it five
 * redeliveries later in a dead-letter queue.
 */
export function buildEvent<T extends EventType>(input: BuildEventInput<T>): DomainEvent<T> {
  const candidate = {
    id: input.id,
    type: input.type,
    version: CURRENT_EVENT_VERSION,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    correlationId: input.correlationId,
    actor: { userId: input.actorUserId },
    data: input.data,
  };

  return eventEnvelopeSchema.parse(candidate) as DomainEvent<T>;
}

export interface ParseResult {
  ok: boolean;
  event?: EventEnvelope;
  error?: string;
}

/**
 * Parse bytes from the broker.
 *
 * Returns a result object rather than throwing, because the caller has to make
 * a routing decision from the outcome — a malformed message must be terminated
 * and dead-lettered, never retried, since replaying it can only fail the same
 * way. Modelling that as a return value keeps the distinction explicit at the
 * call site instead of buried in a catch block.
 */
export function parseEvent(raw: Uint8Array | string): ParseResult {
  let json: unknown;
  try {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `malformed JSON: ${(error as Error).message}` };
  }

  const parsed = eventEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, error: `schema violation: ${issues}` };
  }

  if (parsed.data.version !== CURRENT_EVENT_VERSION) {
    return {
      ok: false,
      error: `unsupported event version ${parsed.data.version} (this consumer understands ${CURRENT_EVENT_VERSION})`,
    };
  }

  return { ok: true, event: parsed.data };
}
