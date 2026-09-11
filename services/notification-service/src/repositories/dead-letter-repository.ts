import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DeadLetter, NotificationDatabase } from '@trams/shared';

/**
 * Dead-letter persistence.
 *
 * Dead letters are written to the database *as well as* the DLQ stream. That
 * looks redundant but is not:
 *
 *   - The DLQ stream is the durable, replayable copy. It holds the original
 *     message, so a fixed consumer can reprocess it.
 *   - This table is the queryable copy. It is what a human actually looks at
 *     during an incident — "what has failed, and why" is an SQL query here and
 *     a stream-scanning exercise there.
 *
 * A dead letter that exists only inside a NATS stream is one nobody will find.
 */
export class DeadLetterRepository {
  constructor(private readonly db: Kysely<NotificationDatabase>) {}

  async record(input: {
    eventId?: string;
    eventType?: string;
    subject: string;
    rawPayload: string;
    reason: string;
    correlationId?: string;
    deliveryCount: number;
    streamSequence: number;
  }): Promise<void> {
    await this.db
      .insertInto('dead_letters')
      .values({
        id: randomUUID(),
        event_id: input.eventId ?? null,
        event_type: input.eventType ?? null,
        subject: input.subject,
        // Truncated. The payload is attacker-influenceable in principle, and an
        // unbounded blob would let one malformed message bloat the table.
        raw_payload: input.rawPayload.slice(0, 10_000),
        reason: input.reason.slice(0, 1_000),
        correlation_id: input.correlationId ?? null,
        delivery_count: input.deliveryCount,
        stream_sequence: input.streamSequence,
        created_at: new Date().toISOString(),
      })
      .execute();
  }

  async list(options: { limit: number; offset: number }): Promise<{
    deadLetters: DeadLetter[];
    total: number;
  }> {
    const [deadLetters, countRow] = await Promise.all([
      this.db
        .selectFrom('dead_letters')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(options.limit)
        .offset(options.offset)
        .execute(),
      this.db
        .selectFrom('dead_letters')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .executeTakeFirst(),
    ]);

    return { deadLetters, total: Number(countRow?.count ?? 0) };
  }

  async count(): Promise<number> {
    const row = await this.db
      .selectFrom('dead_letters')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }
}
