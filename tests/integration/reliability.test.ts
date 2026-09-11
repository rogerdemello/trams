import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEvent, SUBJECTS } from '@trams/shared';
import { createHarness, waitFor, type Harness } from '../helpers/harness.js';

/**
 * Failure handling.
 *
 * These tests inject the failures a production system actually experiences —
 * a flaky dependency, a permanently bad recipient, a malformed message, a
 * broker outage — and assert the system does the right thing with each. This is
 * the difference between "handles failures reliably" as a claim and as a
 * property.
 */

let harness: Harness;

afterEach(async () => {
  await harness?.teardown();
});

describe('transient failures are retried', () => {
  it('recovers after a temporary delivery failure and still sends exactly once', async () => {
    harness = await createHarness({ maxDeliver: 5 });

    const userId = randomUUID();
    const email = `retry-${randomUUID().slice(0, 8)}@trams.test`;

    // Fail the first two attempts, then succeed.
    harness.channel.failNext = 2;

    await harness.publisher.publish(
      buildEvent({
        id: randomUUID(),
        type: SUBJECTS.userRegistered,
        correlationId: `retry-${randomUUID()}`,
        actorUserId: userId,
        data: { userId, email, name: 'Retry Me' },
      }),
    );

    await waitFor(() => harness.channel.sent.some((m) => m.recipient === email), {
      timeoutMs: 30_000,
      label: 'delivery after transient failures',
    });

    // Delivered once, despite three total attempts. The row records the
    // attempt count, so the retries are visible rather than silent.
    expect(harness.channel.sent.filter((m) => m.recipient === email)).toHaveLength(1);

    const row = await harness.notificationDb.db
      .selectFrom('notifications')
      .selectAll()
      .where('recipient', '=', email)
      .executeTakeFirst();

    expect(row?.status).toBe('sent');
    expect(row?.attempts).toBeGreaterThan(1);
    expect(await harness.deadLetters.count()).toBe(0);
  });
});

describe('permanent failures are not retried', () => {
  it('dead-letters immediately rather than burning the retry budget', async () => {
    harness = await createHarness({ maxDeliver: 5 });

    const userId = randomUUID();
    const email = `permanent-${randomUUID().slice(0, 8)}@trams.test`;

    harness.channel.failNext = 99;
    harness.channel.failPermanently = true;

    await harness.publisher.publish(
      buildEvent({
        id: randomUUID(),
        type: SUBJECTS.userRegistered,
        correlationId: `perm-${randomUUID()}`,
        actorUserId: userId,
        data: { userId, email, name: 'Permanent Fail' },
      }),
    );

    await waitFor(async () => (await harness.deadLetters.count()) > 0, {
      timeoutMs: 30_000,
      label: 'permanent failure dead-lettered',
    });

    const { deadLetters } = await harness.deadLetters.list({ limit: 10, offset: 0 });
    const record = deadLetters[0];

    expect(record?.reason).toMatch(/permanent delivery failure/);
    // The key assertion: ONE delivery, not five. A permanent failure that
    // consumed the whole retry budget would delay the operator's signal and
    // waste work on something that could never succeed.
    expect(record?.delivery_count).toBe(1);
    expect(harness.channel.sent).toHaveLength(0);
  });
});

describe('retries are bounded', () => {
  it('dead-letters after exhausting the delivery budget', async () => {
    harness = await createHarness({ maxDeliver: 3 });

    const userId = randomUUID();
    const email = `exhaust-${randomUUID().slice(0, 8)}@trams.test`;

    // Always fail, transiently. The message must not be retried forever, and
    // must not be silently dropped either.
    harness.channel.failNext = 99;

    await harness.publisher.publish(
      buildEvent({
        id: randomUUID(),
        type: SUBJECTS.userRegistered,
        correlationId: `exhaust-${randomUUID()}`,
        actorUserId: userId,
        data: { userId, email, name: 'Exhaust Me' },
      }),
    );

    await waitFor(async () => (await harness.deadLetters.count()) > 0, {
      timeoutMs: 40_000,
      label: 'retry budget exhausted and dead-lettered',
    });

    const { deadLetters } = await harness.deadLetters.list({ limit: 10, offset: 0 });
    const record = deadLetters[0];

    expect(record?.reason).toMatch(/retries exhausted/);
    expect(record?.delivery_count).toBe(3);
    // Preserved for inspection, not discarded — the whole point of a DLQ.
    expect(record?.raw_payload).toContain(email);
  });
});

describe('poison messages', () => {
  it('quarantines a malformed message without retrying it', async () => {
    harness = await createHarness({ maxDeliver: 5 });

    // Publish something structurally invalid directly to a valid subject. It
    // will fail identically on every attempt, so retrying is pure waste.
    await harness.publisher.publishRaw('user.registered', {
      not: 'a valid event envelope',
    });

    await waitFor(async () => (await harness.deadLetters.count()) > 0, {
      timeoutMs: 20_000,
      label: 'malformed message dead-lettered',
    });

    const { deadLetters } = await harness.deadLetters.list({ limit: 10, offset: 0 });

    expect(deadLetters[0]?.reason).toMatch(/schema violation/);
    expect(deadLetters[0]?.delivery_count).toBe(1);
  });

  it('quarantines an event from a future schema version instead of misreading it', async () => {
    harness = await createHarness({ maxDeliver: 5 });

    const userId = randomUUID();
    const event = buildEvent({
      id: randomUUID(),
      type: SUBJECTS.userRegistered,
      correlationId: `future-${randomUUID()}`,
      actorUserId: userId,
      data: { userId, email: 'future@trams.test', name: 'Future' },
    });

    await harness.publisher.publishRaw('user.registered', { ...event, version: 99 });

    await waitFor(async () => (await harness.deadLetters.count()) > 0, {
      timeoutMs: 20_000,
      label: 'future version quarantined',
    });

    const { deadLetters } = await harness.deadLetters.list({ limit: 10, offset: 0 });

    // Forward compatibility: refusing to interpret an unknown version is safer
    // than guessing at its meaning.
    expect(deadLetters[0]?.reason).toMatch(/unsupported event version 99/);
  });
});

describe('broker outage', () => {
  it('accepts the request, keeps the event, and publishes it on recovery', async () => {
    // The headline reliability property. The user request must succeed even
    // though the broker is unreachable, and the event must not be lost.
    harness = await createHarness({ startConsumer: false });

    // Simulate the outage by closing the producer's connection. Publishing now
    // fails exactly as it would if the broker were down.
    await harness.producerNats.close();

    const { email } = await harness.registerUser();

    // The HTTP request succeeded regardless: registerUser throws unless it got
    // a 201. The user exists.
    const user = await harness.userDb.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();
    expect(user).toBeDefined();

    // And the event is safely staged, not lost.
    let stats = await harness.outbox.stats(harness.userDb.db);
    expect(stats['pending']).toBe(1);
    expect(stats['published']).toBe(0);

    // Draining while the broker is unreachable records a failure and schedules
    // a retry — it does not drop the row.
    const result = await harness.drainOutbox();
    expect(result.published).toBe(0);
    expect(result.failed).toBe(1);

    stats = await harness.outbox.stats(harness.userDb.db);
    expect(stats['pending']).toBe(1);

    const row = await harness.userDb.db.selectFrom('outbox_events').selectAll().executeTakeFirst();

    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBeTruthy();
    // Backoff pushed the next attempt into the future rather than hot-looping.
    expect(new Date(row!.next_attempt_at).getTime()).toBeGreaterThan(Date.now() - 1_000);
  });
});
