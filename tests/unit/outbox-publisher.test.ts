import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildEvent,
  createDatabase,
  createLogger,
  migrateUserDatabase,
  SUBJECTS,
  type EventPublisher,
  type UserDatabase,
} from '@trams/shared';
import { OutboxRepository } from '../../services/user-service/src/repositories/outbox-repository.js';
import { OutboxPublisher } from '../../services/user-service/src/services/outbox-publisher.js';

/**
 * The outbox publisher's state machine, tested without a broker.
 *
 * The publish call is stubbed so failure can be injected deterministically —
 * what matters here is what the publisher does with the outcome: which rows it
 * claims, when it retries, and when it gives up. The real broker interaction is
 * covered by the integration suite.
 */

const logger = createLogger({ service: 'test', level: 'silent' });

async function setup(options: { maxAttempts?: number } = {}) {
  const database = createDatabase<UserDatabase>({ client: 'sqlite', url: ':memory:', logger });
  await migrateUserDatabase(database.db, logger);

  const repository = new OutboxRepository();
  const publish = vi.fn<EventPublisher['publish']>().mockResolvedValue({
    seq: 1,
    duplicate: false,
  });
  const publisher = { publish } as unknown as EventPublisher;

  const outboxPublisher = new OutboxPublisher({
    db: database.db,
    repository,
    publisher,
    logger,
    pollIntervalMs: 60_000,
    batchSize: 50,
    maxAttempts: options.maxAttempts ?? 3,
  });

  const enqueue = async () => {
    const userId = randomUUID();
    const event = buildEvent({
      id: randomUUID(),
      type: SUBJECTS.userRegistered,
      correlationId: `corr-${randomUUID().slice(0, 8)}`,
      actorUserId: userId,
      data: { userId, email: `u-${randomUUID().slice(0, 8)}@trams.test`, name: 'Outbox' },
    });
    await repository.enqueue(database.db, event);
    return event;
  };

  return { database, repository, publish, outboxPublisher, enqueue };
}

describe('OutboxPublisher.drain', () => {
  it('publishes the whole batch, not just the first row', async () => {
    // Regression test. The batch loop used to cut itself short whenever the
    // polling loop had not been started, so a directly-invoked drain()
    // published exactly one row and silently abandoned the rest — leaving
    // events pending indefinitely if nothing else triggered a drain.
    const { publish, outboxPublisher, enqueue, repository, database } = await setup();

    for (let i = 0; i < 5; i += 1) await enqueue();

    const result = await outboxPublisher.drain();

    expect(result.published).toBe(5);
    expect(publish).toHaveBeenCalledTimes(5);

    const stats = await repository.stats(database.db);
    expect(stats['published']).toBe(5);
    expect(stats['pending']).toBe(0);

    await database.close();
  });

  it('marks a row published only after the broker acknowledges', async () => {
    const { outboxPublisher, enqueue, repository, database } = await setup();
    const event = await enqueue();

    const before = await repository.findById(database.db, event.id);
    expect(before?.status).toBe('pending');
    expect(before?.published_at).toBeNull();

    await outboxPublisher.drain();

    const after = await repository.findById(database.db, event.id);
    expect(after?.status).toBe('published');
    expect(after?.published_at).not.toBeNull();

    await database.close();
  });

  it('keeps a row pending and schedules a retry when publishing fails', async () => {
    const { publish, outboxPublisher, enqueue, repository, database } = await setup();
    const event = await enqueue();

    publish.mockRejectedValueOnce(new Error('broker unreachable'));

    const result = await outboxPublisher.drain();
    expect(result.failed).toBe(1);

    const row = await repository.findById(database.db, event.id);
    // Still pending — a failed publish must never lose the event.
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toContain('broker unreachable');
    // And backoff pushed the retry into the future rather than hot-looping.
    expect(new Date(row!.next_attempt_at).getTime()).toBeGreaterThan(Date.now() - 500);

    await database.close();
  });

  it('does not claim a row whose retry time has not arrived', async () => {
    const { publish, outboxPublisher, enqueue, repository, database } = await setup();
    await enqueue();

    publish.mockRejectedValueOnce(new Error('broker unreachable'));
    await outboxPublisher.drain();

    // Push the retry well into the future, then confirm it is skipped.
    await database.db
      .updateTable('outbox_events')
      .set({ next_attempt_at: new Date(Date.now() + 600_000).toISOString() })
      .execute();

    publish.mockClear();
    const result = await outboxPublisher.drain();

    expect(result.published).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect((await repository.stats(database.db))['pending']).toBe(1);

    await database.close();
  });

  it('moves a row to failed after exhausting its attempt budget, without deleting it', async () => {
    const { publish, outboxPublisher, enqueue, repository, database } = await setup({
      maxAttempts: 3,
    });
    const event = await enqueue();

    publish.mockRejectedValue(new Error('permanently broken'));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Clear the backoff so the row is due again immediately.
      await database.db
        .updateTable('outbox_events')
        .set({ next_attempt_at: new Date(Date.now() - 1_000).toISOString() })
        .execute();
      await outboxPublisher.drain();
    }

    const row = await repository.findById(database.db, event.id);
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(3);
    // Retained as evidence. Deleting it would turn a visible problem into a
    // silent one, with nothing for an operator to inspect or replay.
    expect(row).toBeDefined();
    expect(row?.payload).toContain(event.id);

    await database.close();
  });

  it('treats a broker-side duplicate as success', async () => {
    // A duplicate ack means the event was already durably stored, so the row is
    // done. Treating it as a failure would retry forever.
    const { publish, outboxPublisher, enqueue, repository, database } = await setup();
    const event = await enqueue();

    publish.mockResolvedValueOnce({ seq: 7, duplicate: true });

    const result = await outboxPublisher.drain();

    expect(result.published).toBe(1);
    expect((await repository.findById(database.db, event.id))?.status).toBe('published');

    await database.close();
  });

  it('publishes in the order events occurred', async () => {
    // Ordering matters: a consumer must not see user.deleted before
    // user.registered for the same user.
    const { publish, outboxPublisher, enqueue, database } = await setup();

    const first = await enqueue();
    await new Promise((r) => setTimeout(r, 5));
    const second = await enqueue();
    await new Promise((r) => setTimeout(r, 5));
    const third = await enqueue();

    await outboxPublisher.drain();

    const publishedIds = publish.mock.calls.map(([event]) => event.id);
    expect(publishedIds).toEqual([first.id, second.id, third.id]);

    await database.close();
  });

  it('survives a database read failure without throwing', async () => {
    // A drain that threw would kill the polling loop and stop the outbox
    // permanently. It must log and let the next tick retry.
    const { outboxPublisher, repository, database } = await setup();
    vi.spyOn(repository, 'claimDue').mockRejectedValueOnce(new Error('database is down'));

    await expect(outboxPublisher.drain()).resolves.toEqual({ published: 0, failed: 0 });

    await database.close();
  });
});
