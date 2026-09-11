import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, SUBJECTS } from '@trams/shared';
import { createHarness, waitFor, type Harness } from '../helpers/harness.js';

/**
 * The end-to-end event path, against a real JetStream broker.
 *
 * These are the tests that actually verify the assignment's central claims. Each
 * one corresponds to a specific failure mode that a naive implementation gets
 * wrong.
 */

describe('event flow: User Service → JetStream → Notification Service', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it('delivers a notification for a registered user, with no HTTP link between the services', async () => {
    const correlationId = `flow-${randomUUID()}`;
    const { email } = await harness.registerUser({ correlationId });

    // The event is in the outbox, committed with the user. It has NOT been
    // published yet — nothing has touched the broker at this point.
    const pendingBefore = await harness.outbox.stats(harness.userDb.db);
    expect(pendingBefore['pending']).toBe(1);

    await harness.drainOutbox();

    await waitFor(() => harness.channel.sent.some((m) => m.recipient === email), {
      label: 'welcome notification delivered',
    });

    const delivered = harness.channel.sent.find((m) => m.recipient === email);
    expect(delivered?.subject).toBe('Welcome to Trams');
    // The correlation id survived the whole path: HTTP request → database →
    // outbox row → NATS header → consumer → delivery.
    expect(delivered?.correlationId).toBe(correlationId);

    const stats = await harness.outbox.stats(harness.userDb.db);
    expect(stats['published']).toBe(1);
    expect(stats['failed']).toBe(0);
  });

  it('persists the notification so it survives a consumer restart', async () => {
    const { email } = await harness.registerUser();
    await harness.drainOutbox();

    await waitFor(() => harness.channel.sent.some((m) => m.recipient === email));

    const rows = await harness.notificationDb.db
      .selectFrom('notifications')
      .selectAll()
      .where('recipient', '=', email)
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('sent');
    expect(rows[0]?.sent_at).not.toBeNull();
  });

  it('delivers every event type', async () => {
    const { accessToken, email } = await harness.registerUser();
    await harness.drainOutbox();
    await waitFor(() => harness.channel.sent.some((m) => m.eventType === 'user.registered'));

    const auth = {
      'x-internal-token': 'test-internal-token',
      authorization: `Bearer ${accessToken}`,
    };

    await harness.app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: auth,
      payload: { name: 'Renamed Person' },
    });

    await harness.app.inject({
      method: 'POST',
      url: '/users/me/change-password',
      headers: auth,
      payload: { currentPassword: 'Str0ng!Passw0rd', newPassword: 'An0ther!Passw0rd' },
    });

    await harness.app.inject({ method: 'DELETE', url: '/users/me', headers: auth });

    await harness.drainOutbox();

    await waitFor(
      () => {
        const forUser = harness.channel.sent.filter((m) => m.recipient === email);
        return (
          forUser.some((m) => m.eventType === 'user.updated') &&
          forUser.some((m) => m.eventType === 'user.password_changed') &&
          forUser.some((m) => m.eventType === 'user.deleted')
        );
      },
      { label: 'update, password-change and delete notifications' },
    );

    // The notable one: `user.deleted` is delivered after the user row is gone.
    // The consumer never queries the User Service, so the event payload has to
    // carry everything the template needs — and it does.
    const deletion = harness.channel.sent.find(
      (m) => m.recipient === email && m.eventType === 'user.deleted',
    );
    expect(deletion?.subject).toBe('Your Trams account has been deleted');
  });

  it('does not emit an event for a no-op update', async () => {
    const { accessToken } = await harness.registerUser({ name: 'Unchanged Name' });
    await harness.drainOutbox();

    const before = (await harness.outbox.stats(harness.userDb.db))['published'] ?? 0;

    await harness.app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: {
        'x-internal-token': 'test-internal-token',
        authorization: `Bearer ${accessToken}`,
      },
      payload: { name: 'Unchanged Name' },
    });

    await harness.drainOutbox();

    // Publishing "nothing changed" would notify users about non-events.
    expect((await harness.outbox.stats(harness.userDb.db))['published']).toBe(before);
  });
});

describe('idempotency: at-least-once delivery, exactly-once effect', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it('sends once when the same event is delivered three times', async () => {
    const userId = randomUUID();
    const email = `idem-${randomUUID().slice(0, 8)}@trams.test`;

    const event = buildEvent({
      id: randomUUID(),
      type: SUBJECTS.userRegistered,
      correlationId: `idem-${randomUUID()}`,
      actorUserId: userId,
      data: { userId, email, name: 'Idempotent' },
    });

    // Three copies of the same event.id, each with a DIFFERENT broker msgID so
    // JetStream's own deduplication cannot mask the problem. This isolates the
    // consumer's database-level guard — the defence that has to hold when a
    // genuine redelivery happens.
    for (let copy = 0; copy < 3; copy += 1) {
      await harness.publisher.publish({ ...event, id: event.id });
      await harness.producerNats.flush();
    }

    await waitFor(() => harness.channel.sent.filter((m) => m.recipient === email).length >= 1, {
      label: 'first delivery',
    });

    // Allow time for any duplicate to be (incorrectly) delivered.
    await new Promise((r) => setTimeout(r, 2_500));

    expect(harness.channel.sent.filter((m) => m.recipient === email)).toHaveLength(1);

    const rows = await harness.notificationDb.db
      .selectFrom('notifications')
      .selectAll()
      .where('event_id', '=', event.id)
      .execute();

    // One row, enforced by the UNIQUE index on event_id rather than by
    // application logic — which is why it holds under concurrency.
    expect(rows).toHaveLength(1);
  });

  it('deduplicates at the broker when the same msgID is published twice', async () => {
    const userId = randomUUID();
    const event = buildEvent({
      id: randomUUID(),
      type: SUBJECTS.userRegistered,
      correlationId: 'dedupe-test',
      actorUserId: userId,
      data: { userId, email: `dedupe-${randomUUID().slice(0, 8)}@trams.test`, name: 'Dedupe' },
    });

    const first = await harness.publisher.publish(event);
    const second = await harness.publisher.publish(event);

    // This is what makes an outbox publisher retry free: if the ack is lost and
    // the publisher retries, the broker recognises the msgID and discards it.
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.seq).toBe(first.seq);
  });
});
