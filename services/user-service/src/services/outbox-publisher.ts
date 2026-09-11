import type { Kysely } from 'kysely';
import {
  eventEnvelopeSchema,
  withCorrelationId,
  type EventPublisher,
  type Logger,
  type OutboxEvent,
  type UserDatabase,
} from '@trams/shared';
import type { OutboxRepository } from '../repositories/outbox-repository.js';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * The transactional outbox publisher.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The obvious implementation of "register a user, then notify them" is:
 *
 *     await db.insertUser(user)
 *     await broker.publish(event)      // ← the bug
 *
 * There is no transaction spanning a database and a message broker, so that
 * second line has a failure window. If the process is killed between the two
 * statements, or the broker is unreachable for those few milliseconds, the user
 * exists and the event does not. No amount of retry logic *around* the publish
 * call closes the gap, because the gap is between two systems that cannot
 * commit together. The event is simply gone, and nothing in the system knows it
 * was ever supposed to exist.
 *
 * Swapping the order does not help — publish-then-insert can notify a user
 * whose registration then fails.
 *
 * THE SOLUTION
 *
 * Write the event to a table in the SAME transaction as the domain change:
 *
 *     await db.transaction(async (trx) => {
 *       await users.insert(trx, user)
 *       await outbox.enqueue(trx, event)     // atomic with the line above
 *     })
 *
 * Now the two facts commit or fail together. This class then drains the table
 * asynchronously. What each property buys:
 *
 *   - The broker being down never fails a user request. The HTTP call returns
 *     201, the row sits in the outbox, and it publishes on recovery.
 *   - Delivery becomes at-least-once, never at-most-once. Duplicates are
 *     possible; loss is not. That is the correct trade, because a duplicate is
 *     recoverable at the consumer (via its unique index on event_id) whereas a
 *     lost event is not recoverable anywhere.
 *   - Failures are visible. A row stuck in `pending` or moved to `failed` is
 *     queryable evidence, not a gap in a log file.
 * ════════════════════════════════════════════════════════════════════════════
 */

export interface OutboxPublisherOptions {
  db: Kysely<UserDatabase>;
  repository: OutboxRepository;
  publisher: EventPublisher;
  logger: Logger;
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
}

export class OutboxPublisher {
  private timer?: NodeJS.Timeout;
  /** True while the polling loop is scheduled. */
  private running = false;
  /**
   * True once shutdown has been requested.
   *
   * Deliberately separate from `running`. The batch loop cuts itself short when
   * the process is shutting down, and that condition must mean "stop was
   * called" — not "the poll loop was never started". Conflating the two made a
   * directly-invoked `drain()` publish only the first row of its batch and
   * abandon the rest, which is exactly how it is used by tests and by a manual
   * flush.
   */
  private stopping = false;
  /** Guards against overlapping drains if one run outlasts the poll interval. */
  private draining = false;

  constructor(private readonly options: OutboxPublisherOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    const tick = () => {
      void this.drain().finally(() => {
        if (!this.running) return;
        this.timer = setTimeout(tick, this.options.pollIntervalMs);
        // Do not hold the event loop open purely to poll — shutdown should not
        // have to wait for a timer that has nothing to do.
        this.timer.unref();
      });
    };

    tick();
    this.options.logger.info(
      { pollIntervalMs: this.options.pollIntervalMs, batchSize: this.options.batchSize },
      'outbox publisher started',
    );
  }

  /**
   * Stop polling and finish the in-flight drain.
   *
   * Awaiting the current drain matters: abandoning it mid-batch would leave
   * rows that were published to the broker but not yet marked `published`,
   * which the next run would publish again. Harmless (the broker deduplicates)
   * but avoidable.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    while (this.draining) await sleep(25);
    this.options.logger.info('outbox publisher stopped');
  }

  /**
   * Publish one batch of due events.
   *
   * Public so tests and the readiness path can force a drain instead of waiting
   * for the poll interval.
   */
  async drain(): Promise<{ published: number; failed: number }> {
    if (this.draining) return { published: 0, failed: 0 };
    this.draining = true;

    let published = 0;
    let failed = 0;

    try {
      const due = await this.options.repository.claimDue(this.options.db, this.options.batchSize);
      if (due.length === 0) return { published: 0, failed: 0 };

      this.options.logger.debug({ count: due.length }, 'draining outbox batch');

      // Sequential, not parallel. Events for the same user must reach the
      // stream in the order they occurred — publishing `user.deleted` before
      // `user.registered` would have the consumer act on a user it has not
      // seen. Ordering is worth more than throughput at this scale, and the
      // batch is bounded anyway.
      for (const row of due) {
        // Cut the batch short only if shutdown was actually requested. Any rows
        // left behind stay `pending` and are picked up by the next run.
        if (this.stopping && published > 0) break;
        const outcome = await this.publishOne(row);
        if (outcome === 'published') published += 1;
        else failed += 1;
      }

      if (published > 0 || failed > 0) {
        this.options.logger.info({ published, failed }, 'outbox batch drained');
      }
    } catch (error) {
      // A failure to even read the table (database down) must not kill the
      // loop; the next tick retries.
      this.options.logger.error({ err: error }, 'outbox drain failed');
    } finally {
      this.draining = false;
    }

    return { published, failed };
  }

  private async publishOne(row: OutboxEvent): Promise<'published' | 'failed'> {
    const { repository, publisher, logger, db, maxAttempts } = this.options;

    // Bind the originating request's correlation id, so publish logs join up
    // with the HTTP request that created the event even though this runs on a
    // completely separate background task.
    return withCorrelationId(row.correlation_id, async () => {
      const rowLogger = logger.child({
        eventId: row.id,
        eventType: row.event_type,
        attempts: row.attempts,
      });

      try {
        // Re-validate on the way out. The payload was validated when it was
        // built, but this row may have been written by an older version of the
        // code, and publishing a malformed event would push the problem onto
        // the consumer as a poison message.
        const event = eventEnvelopeSchema.parse(JSON.parse(row.payload));

        const result = await publisher.publish(event);
        await repository.markPublished(db, row.id);

        rowLogger.debug({ seq: result.seq, duplicate: result.duplicate }, 'outbox event published');
        return 'published';
      } catch (error) {
        const attempts = row.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        const status = await repository.recordFailure(db, row.id, attempts, message, maxAttempts);

        if (status === 'failed') {
          // Terminal. Deliberately `error` level: this is the one outcome in
          // the whole outbox design that needs a human, and the row is left in
          // place so it can be inspected and replayed.
          rowLogger.error(
            { err: error, attempts, maxAttempts },
            'outbox event permanently failed after exhausting retries — manual intervention required',
          );
        } else {
          rowLogger.warn(
            { err: error, attempts, maxAttempts },
            'outbox publish failed — will retry with backoff',
          );
        }

        return 'failed';
      }
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
