import type { Kysely } from 'kysely';
import type { Notification, NotificationDatabase } from '@trams/shared';

/**
 * Notification persistence, including the idempotency claim.
 *
 * The interesting method is `claim`. Everything else is ordinary CRUD.
 */
export class NotificationRepository {
  constructor(private readonly db: Kysely<NotificationDatabase>) {}

  /**
   * Attempt to claim an event for processing.
   *
   * Returns:
   *   'claimed'          this worker owns it; go ahead and deliver
   *   'already-sent'     a previous delivery succeeded; do nothing, just ack
   *   'retry-existing'   a previous attempt was recorded but never succeeded;
   *                      deliver and update the existing row
   *
   * ── Why an INSERT rather than a SELECT ────────────────────────────────────
   * The obvious implementation is "SELECT to see if we've handled this, then
   * INSERT if not". That is a race: two replicas can both SELECT nothing, both
   * decide to send, and the user gets two emails. The window is small but it is
   * exactly the window that opens under the load where duplicates hurt most.
   *
   * Instead we INSERT first and let the UNIQUE index on `event_id` arbitrate.
   * Exactly one concurrent worker's insert succeeds; the losers get a
   * constraint violation and can then read the winner's row to decide what to
   * do. Correctness is delegated to the database, which is the only participant
   * with a consistent view.
   * ───────────────────────────────────────────────────────────────────────────
   */
  async claim(input: {
    id: string;
    eventId: string;
    eventType: string;
    userId: string;
    recipient: string;
    channel: string;
    subject: string;
    body: string;
    correlationId: string;
  }): Promise<{ outcome: 'claimed' | 'already-sent' | 'retry-existing'; row?: Notification }> {
    const now = new Date().toISOString();

    try {
      await this.db
        .insertInto('notifications')
        .values({
          id: input.id,
          event_id: input.eventId,
          event_type: input.eventType,
          user_id: input.userId,
          recipient: input.recipient,
          channel: input.channel,
          subject: input.subject,
          body: input.body,
          // Inserted as 'failed' and promoted to 'sent' only after delivery
          // actually succeeds. Recording optimism here would mean a crash
          // mid-send leaves a row claiming success for a notification that was
          // never delivered.
          status: 'failed',
          attempts: 1,
          correlation_id: input.correlationId,
          error: 'delivery not yet attempted',
          created_at: now,
          sent_at: null,
        })
        .execute();

      return { outcome: 'claimed' };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // Lost the race, or this is a genuine redelivery. Read the existing row
      // to find out which.
      const existing = await this.findByEventId(input.eventId);

      if (!existing) {
        // The row vanished between the failed insert and this read — only
        // possible if something deleted it concurrently. Treat as claimed and
        // let a retry sort it out rather than guessing.
        return { outcome: 'claimed' };
      }

      if (existing.status === 'sent') {
        return { outcome: 'already-sent', row: existing };
      }

      return { outcome: 'retry-existing', row: existing };
    }
  }

  /** Promote a claimed row to delivered. */
  async markSent(eventId: string, attempts: number): Promise<void> {
    await this.db
      .updateTable('notifications')
      .set({ status: 'sent', sent_at: new Date().toISOString(), error: null, attempts })
      .where('event_id', '=', eventId)
      .execute();
  }

  /** Record a failed delivery attempt without marking the row delivered. */
  async markFailed(eventId: string, attempts: number, error: string): Promise<void> {
    await this.db
      .updateTable('notifications')
      .set({ status: 'failed', attempts, error: error.slice(0, 1_000) })
      .where('event_id', '=', eventId)
      .execute();
  }

  async findByEventId(eventId: string): Promise<Notification | undefined> {
    return this.db
      .selectFrom('notifications')
      .selectAll()
      .where('event_id', '=', eventId)
      .executeTakeFirst();
  }

  async listForUser(
    userId: string,
    options: { limit: number; offset: number },
  ): Promise<{ notifications: Notification[]; total: number }> {
    const [notifications, countRow] = await Promise.all([
      this.db
        .selectFrom('notifications')
        .selectAll()
        .where('user_id', '=', userId)
        .orderBy('created_at', 'desc')
        .limit(options.limit)
        .offset(options.offset)
        .execute(),
      this.db
        .selectFrom('notifications')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    ]);

    return { notifications, total: Number(countRow?.count ?? 0) };
  }

  async stats(): Promise<Record<string, number>> {
    const rows = await this.db
      .selectFrom('notifications')
      .select(['status'])
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .groupBy('status')
      .execute();

    const stats: Record<string, number> = { sent: 0, failed: 0 };
    for (const row of rows) stats[row.status] = Number(row.count);
    return stats;
  }
}

/**
 * Detect a unique-constraint violation on either dialect.
 *
 * Duplicated from the User Service's equivalent rather than shared, because the
 * two services are independently deployable and a shared helper here would be a
 * coupling with no real benefit — it is six lines that must simply be correct.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; message?: string };
  if (candidate.code === '23505') return true; // Postgres
  if (typeof candidate.code === 'string' && candidate.code.startsWith('SQLITE_CONSTRAINT'))
    return true;
  return /unique constraint|UNIQUE constraint failed/i.test(candidate.message ?? '');
}
