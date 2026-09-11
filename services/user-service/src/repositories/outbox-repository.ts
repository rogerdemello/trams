import type { EventEnvelope, OutboxEvent } from '@trams/shared';
import { nextAttemptAt } from '@trams/shared';
import { nowIso, type UserDbExecutor } from './types.js';

/**
 * The outbox table's data access.
 *
 * Read `enqueue` together with AuthService.register to see the point: the
 * insert here happens inside the *caller's* transaction, alongside the user
 * row. Either both commit or neither does. There is no window in which a user
 * exists without their event pending.
 */
export class OutboxRepository {
  /**
   * Stage an event for publication, inside the caller's transaction.
   *
   * The event id is the primary key, so enqueueing the same event twice is
   * structurally impossible rather than merely unlikely.
   *
   * `next_attempt_at` is set to now, so the publisher picks it up on its next
   * poll. Backoff only pushes this into the future after a failure.
   */
  async enqueue(executor: UserDbExecutor, event: EventEnvelope): Promise<void> {
    await executor
      .insertInto('outbox_events')
      .values({
        id: event.id,
        event_type: event.type,
        subject: event.type,
        payload: JSON.stringify(event),
        correlation_id: event.correlationId,
        status: 'pending',
        attempts: 0,
        next_attempt_at: nowIso(),
        last_error: null,
        created_at: nowIso(),
        published_at: null,
      })
      .execute();
  }

  /**
   * Claim a batch of events that are due for publication.
   *
   * Ordered by `next_attempt_at` so the oldest due work goes first and a
   * repeatedly failing event cannot starve newer ones indefinitely.
   *
   * Note on concurrency: with a single publisher instance (the default) this is
   * safe as written. Running multiple User Service replicas would mean two
   * publishers could claim the same row and both publish it — which is *safe
   * but wasteful*, because the broker deduplicates on `msgID` and the consumer
   * deduplicates on `event_id`. To make it efficient rather than merely
   * correct, Postgres offers `FOR UPDATE SKIP LOCKED`; that is a dialect-
   * specific optimisation and is documented in docs/architecture.md rather than
   * applied here, since SQLite has no equivalent.
   */
  async claimDue(executor: UserDbExecutor, limit: number): Promise<OutboxEvent[]> {
    return executor
      .selectFrom('outbox_events')
      .selectAll()
      .where('status', '=', 'pending')
      .where('next_attempt_at', '<=', nowIso())
      .orderBy('next_attempt_at', 'asc')
      .limit(limit)
      .execute();
  }

  /** Mark an event durably stored by the broker. */
  async markPublished(executor: UserDbExecutor, id: string): Promise<void> {
    await executor
      .updateTable('outbox_events')
      .set({ status: 'published', published_at: nowIso(), last_error: null })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Record a failed attempt and schedule the retry.
   *
   * Exceeding the attempt budget moves the row to `failed` rather than deleting
   * it. The row is the evidence: an operator can see exactly which event never
   * made it and why, and replay it by hand. Deleting would turn a visible
   * problem into a silent one.
   */
  async recordFailure(
    executor: UserDbExecutor,
    id: string,
    attempts: number,
    error: string,
    maxAttempts: number,
  ): Promise<'pending' | 'failed'> {
    const exhausted = attempts >= maxAttempts;
    const status = exhausted ? 'failed' : 'pending';

    await executor
      .updateTable('outbox_events')
      .set({
        status,
        attempts,
        next_attempt_at: nextAttemptAt(attempts, new Date()).toISOString(),
        // Truncated: an error message is attacker-influenceable in principle
        // and an unbounded string here would let one bad event bloat the table.
        last_error: error.slice(0, 1_000),
      })
      .where('id', '=', id)
      .execute();

    return status;
  }

  /** Operational counters, surfaced for tests and diagnostics. */
  async stats(executor: UserDbExecutor): Promise<Record<string, number>> {
    const rows = await executor
      .selectFrom('outbox_events')
      .select(['status'])
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .groupBy('status')
      .execute();

    const stats: Record<string, number> = { pending: 0, published: 0, failed: 0 };
    for (const row of rows) stats[row.status] = Number(row.count);
    return stats;
  }

  async findById(executor: UserDbExecutor, id: string): Promise<OutboxEvent | undefined> {
    return executor.selectFrom('outbox_events').selectAll().where('id', '=', id).executeTakeFirst();
  }
}
