import { jetstream, type JetStreamClient } from '@nats-io/jetstream';
import { headers, type NatsConnection } from '@nats-io/transport-node';
import type { Logger } from 'pino';
import type { EventEnvelope } from '../events/schemas.js';
import { STREAM_USER_EVENTS } from '../events/subjects.js';

/**
 * Publishes domain events to JetStream.
 *
 * Note what this class does NOT do: it is never called from inside a request
 * handler. The User Service writes events to its outbox table instead, and this
 * publisher is driven by a background loop. That indirection is the entire
 * reason the system cannot lose an event — see OutboxPublisher for the
 * reasoning.
 *
 * The job here is narrower: make a single publish attempt safe to repeat.
 */

export interface PublishResult {
  /** The stream sequence assigned to the message. */
  seq: number;
  /** True when the broker recognised the message id and discarded a duplicate. */
  duplicate: boolean;
}

export class EventPublisher {
  private readonly js: JetStreamClient;

  constructor(
    connection: NatsConnection,
    private readonly logger: Logger,
    options: { timeoutMs?: number } = {},
  ) {
    this.js = jetstream(connection, { timeout: options.timeoutMs ?? 5_000 });
  }

  /**
   * Publish one event.
   *
   * Three properties make this safe to retry:
   *
   *  1. `msgID` is the event's own id, so the broker deduplicates a repeated
   *     publish within the stream's duplicate window. If we send a message, the
   *     ack is lost in transit, and the outbox retries, the broker discards the
   *     second copy instead of appending it.
   *
   *  2. `expect.streamName` asserts the message is landing in the stream we
   *     think it is. Without it, a subject/stream misconfiguration would be
   *     accepted silently and the events would go nowhere discoverable.
   *
   *  3. The promise only resolves on a broker acknowledgement. A resolved
   *     promise therefore means "durably stored", which is what allows the
   *     caller to mark the outbox row published.
   *
   * Errors are rethrown rather than swallowed: the outbox needs the failure in
   * order to retry, and a publisher that hides errors converts a recoverable
   * problem into permanent silent data loss.
   */
  async publish(event: EventEnvelope): Promise<PublishResult> {
    const messageHeaders = headers();
    // Carried on the message so the consumer's logs join up with the HTTP
    // request that caused the event, without needing to parse the payload.
    messageHeaders.set('X-Correlation-Id', event.correlationId);
    messageHeaders.set('X-Event-Type', event.type);
    messageHeaders.set('X-Event-Version', String(event.version));

    const ack = await this.js.publish(event.type, JSON.stringify(event), {
      msgID: event.id,
      headers: messageHeaders,
      expect: { streamName: STREAM_USER_EVENTS },
    });

    if (ack.duplicate) {
      // Not an error. It means the safety net worked: this event was already in
      // the stream, so the retry correctly became a no-op.
      this.logger.info(
        { eventId: event.id, eventType: event.type, seq: ack.seq },
        'publish deduplicated by broker — event was already stored',
      );
    } else {
      this.logger.debug(
        { eventId: event.id, eventType: event.type, seq: ack.seq, stream: ack.stream },
        'event published to JetStream',
      );
    }

    return { seq: ack.seq, duplicate: ack.duplicate ?? false };
  }

  /**
   * Publish a raw payload to an arbitrary subject.
   *
   * Used only for dead-lettering, where the payload is by definition not a
   * valid event and must not be forced through event validation.
   */
  async publishRaw(
    subject: string,
    payload: unknown,
    options: { msgID?: string; correlationId?: string } = {},
  ): Promise<void> {
    const messageHeaders = headers();
    if (options.correlationId) messageHeaders.set('X-Correlation-Id', options.correlationId);

    await this.js.publish(subject, JSON.stringify(payload), {
      headers: messageHeaders,
      ...(options.msgID ? { msgID: options.msgID } : {}),
    });
  }
}
