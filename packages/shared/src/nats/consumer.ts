import { jetstream, type Consumer, type JsMsg } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';
import type { Logger } from 'pino';
import { parseEvent, type EventEnvelope } from '../events/schemas.js';
import { withCorrelationId } from '../logger.js';
import { backoffDelay, type BackoffOptions } from './backoff.js';

/**
 * The consumer runtime: a pull loop that turns broker messages into handler
 * calls and translates handler outcomes into the correct JetStream
 * acknowledgement.
 *
 * Pull, not push. A push consumer delivers at the *broker's* pace; a pull
 * consumer delivers at the *worker's* pace. Since handling a notification means
 * waiting on a slow external dependency, the worker must control its own intake
 * or a burst will simply bury it.
 *
 * The three-way outcome below is the heart of the design. Treating every
 * failure the same way is the most common bug in event-driven systems: retry a
 * poison message forever and the queue stalls; drop a transient failure and you
 * have silently lost data.
 */

/** What a handler decided, which determines the acknowledgement sent back. */
export type HandlerOutcome =
  /** Done. Acknowledge and never see it again. */
  | { kind: 'ack' }
  /** Transient failure (dependency down, timeout). Redeliver after a delay. */
  | { kind: 'retry'; reason: string }
  /** Permanently unprocessable. Do not redeliver; dead-letter it. */
  | { kind: 'dead-letter'; reason: string };

export const ACK: HandlerOutcome = { kind: 'ack' };
export const retry = (reason: string): HandlerOutcome => ({ kind: 'retry', reason });
export const deadLetter = (reason: string): HandlerOutcome => ({ kind: 'dead-letter', reason });

export interface MessageContext {
  /** How many times this message has been delivered, including now (1-based). */
  deliveryCount: number;
  /** Deliveries remaining before the broker gives up. */
  deliveriesRemaining: number;
  streamSequence: number;
  logger: Logger;
}

export type EventHandler = (
  event: EventEnvelope,
  context: MessageContext,
) => Promise<HandlerOutcome>;

/** Called when a message can never be processed, so it can be parked durably. */
export type DeadLetterSink = (input: {
  reason: string;
  subject: string;
  rawPayload: string;
  eventId?: string;
  eventType?: string;
  correlationId?: string;
  deliveryCount: number;
  streamSequence: number;
}) => Promise<void>;

export interface ConsumerRuntimeOptions {
  connection: NatsConnection;
  stream: string;
  durableName: string;
  handler: EventHandler;
  deadLetterSink: DeadLetterSink;
  logger: Logger;
  maxDeliver: number;
  fetchBatch: number;
  backoff?: BackoffOptions;
}

export class ConsumerRuntime {
  private consumer?: Consumer;
  private running = false;
  private stopped?: Promise<void>;
  /** Resolves once the current fetch loop iteration has finished. */
  private idle = Promise.resolve();

  constructor(private readonly options: ConsumerRuntimeOptions) {}

  /**
   * Bind to the durable consumer and begin pulling.
   *
   * The consumer is provisioned by the *producer* service, which holds the only
   * credentials with stream-management permission. That means this service may
   * boot before the topology exists, so `start()` waits for it rather than
   * crashing.
   *
   * The alternative — requiring the producer to start first — would make the
   * two services order-dependent at deploy time, which is precisely the
   * coupling an event-driven architecture is supposed to remove.
   */
  async start(): Promise<void> {
    const { connection, stream, durableName, logger } = this.options;
    const js = jetstream(connection);

    const maxWaitMs = 60_000;
    const startedAt = Date.now();
    let attempt = 0;

    for (;;) {
      try {
        this.consumer = await js.consumers.get(stream, durableName);
        break;
      } catch (error) {
        attempt += 1;
        if (Date.now() - startedAt > maxWaitMs) {
          logger.error(
            { err: error, stream, consumer: durableName, attempt },
            'durable consumer never appeared — is the User Service running to provision it?',
          );
          throw error;
        }
        const delay = backoffDelay(attempt, { baseMs: 500, maxMs: 5_000 });
        logger.warn(
          { stream, consumer: durableName, attempt, delayMs: delay },
          'durable consumer not available yet — waiting for it to be provisioned',
        );
        await sleep(delay);
      }
    }

    this.running = true;
    logger.info({ stream, consumer: durableName }, 'consumer runtime started');
    // The bound consumer is handed to the loop directly, so the loop needs no
    // non-null assertion on a field that is only populated here.
    this.stopped = this.loop(this.consumer);
  }

  /**
   * Stop pulling and wait for the in-flight batch to finish.
   *
   * Awaiting the loop is what makes shutdown graceful: without it the process
   * exits mid-handler, the message is left unacked, and it is redelivered —
   * possibly after a partial side effect has already occurred.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.options.logger.info('consumer runtime stopping — draining in-flight messages');
    await this.stopped;
    await this.idle;
    this.options.logger.info('consumer runtime stopped');
  }

  private async loop(consumer: Consumer): Promise<void> {
    const { logger, fetchBatch } = this.options;

    while (this.running) {
      try {
        const messages = await consumer.fetch({
          max_messages: fetchBatch,
          // Bounded wait so the loop returns regularly and can observe
          // `this.running`. Without an expiry, shutdown would block until a
          // message happened to arrive.
          expires: 5_000,
        });

        for await (const message of messages) {
          this.idle = this.handle(message);
          await this.idle;
          // Re-check between messages so a stop signal takes effect promptly
          // instead of after the whole batch.
          if (!this.running) break;
        }
      } catch (error) {
        if (!this.running) break;
        // A fetch failure is almost always a disconnect. The client reconnects
        // on its own; we pause briefly so a hard-down broker does not become a
        // hot spin loop.
        logger.warn({ err: error }, 'fetch failed — retrying shortly');
        await sleep(1_000);
      }
    }
  }

  /**
   * Process one message. This method decides the acknowledgement and is where
   * the reliability guarantees are actually enforced.
   */
  private async handle(message: JsMsg): Promise<void> {
    const { logger, handler, deadLetterSink, maxDeliver, backoff } = this.options;

    const deliveryCount = message.info.deliveryCount;
    const streamSequence = message.info.streamSequence;
    const rawPayload = message.string();
    const correlationId = message.headers?.get('X-Correlation-Id') || undefined;

    const run = async () => {
      const messageLogger = logger.child({
        subject: message.subject,
        streamSequence,
        deliveryCount,
      });

      // Parse before anything else. A malformed message will fail identically
      // on every redelivery, so retrying it is pure waste — it goes straight to
      // the dead-letter queue.
      const parsed = parseEvent(rawPayload);
      if (!parsed.ok || !parsed.event) {
        const reason = parsed.error ?? 'unparseable message';
        messageLogger.error({ reason }, 'message failed validation — dead-lettering');
        await this.deadLetter(message, deadLetterSink, {
          reason,
          rawPayload,
          deliveryCount,
          streamSequence,
          ...(correlationId ? { correlationId } : {}),
        });
        return;
      }

      const event = parsed.event;
      const eventLogger = messageLogger.child({ eventId: event.id, eventType: event.type });

      let outcome: HandlerOutcome;
      try {
        outcome = await handler(event, {
          deliveryCount,
          deliveriesRemaining: Math.max(0, maxDeliver - deliveryCount),
          streamSequence,
          logger: eventLogger,
        });
      } catch (error) {
        // A handler that throws instead of returning an outcome is treated as a
        // transient failure. Assuming "retryable" is the safe default: a
        // needless retry costs a little work, whereas wrongly discarding a
        // message loses data permanently.
        eventLogger.error({ err: error }, 'handler threw — treating as retryable');
        outcome = retry(error instanceof Error ? error.message : 'handler threw');
      }

      switch (outcome.kind) {
        case 'ack':
          message.ack();
          eventLogger.debug('message acknowledged');
          return;

        case 'retry': {
          // On the final permitted delivery, stop retrying and dead-letter
          // explicitly. Left to the broker, the message would exceed
          // max_deliver and be dropped with no record of why — the exact silent
          // data loss this design exists to prevent.
          if (deliveryCount >= maxDeliver) {
            const reason = `retries exhausted after ${deliveryCount} deliveries: ${outcome.reason}`;
            eventLogger.error({ reason }, 'retry budget exhausted — dead-lettering');
            await this.deadLetter(message, deadLetterSink, {
              reason,
              rawPayload,
              eventId: event.id,
              eventType: event.type,
              correlationId: event.correlationId,
              deliveryCount,
              streamSequence,
            });
            return;
          }

          const delay = backoffDelay(deliveryCount, backoff);
          eventLogger.warn(
            { reason: outcome.reason, delayMs: delay, attempt: deliveryCount, maxDeliver },
            'transient failure — scheduling redelivery',
          );
          message.nak(delay);
          return;
        }

        case 'dead-letter':
          eventLogger.error({ reason: outcome.reason }, 'unprocessable message — dead-lettering');
          await this.deadLetter(message, deadLetterSink, {
            reason: outcome.reason,
            rawPayload,
            eventId: event.id,
            eventType: event.type,
            correlationId: event.correlationId,
            deliveryCount,
            streamSequence,
          });
          return;
      }
    };

    // Bind the correlation id from the message header so consumer log lines
    // join up with the HTTP request that originally caused the event.
    await (correlationId ? withCorrelationId(correlationId, run) : run());
  }

  /**
   * Park a message that will never succeed, then `term()` it.
   *
   * Order matters: persist first, terminate second. `term()` tells the broker
   * to stop redelivering, so if we terminated first and then failed to record
   * the dead letter, the message would be gone with no trace. Recording first
   * means a failure here leaves the message eligible for redelivery — we would
   * rather retry a dead letter than lose it.
   */
  private async deadLetter(
    message: JsMsg,
    sink: DeadLetterSink,
    input: Omit<Parameters<DeadLetterSink>[0], 'subject'>,
  ): Promise<void> {
    try {
      await sink({ ...input, subject: message.subject });
      message.term(input.reason.slice(0, 200));
    } catch (error) {
      this.options.logger.error(
        { err: error, streamSequence: input.streamSequence },
        'failed to record dead letter — leaving message for redelivery rather than dropping it',
      );
      message.nak(backoffDelay(input.deliveryCount, this.options.backoff));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
