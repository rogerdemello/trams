import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildEvent, CURRENT_EVENT_VERSION, parseEvent, SUBJECTS } from '@trams/shared';

/**
 * The event contract is the only thing both services depend on, so it gets the
 * most scrutiny. A defect here does not break one service — it silently
 * desynchronises two.
 */

const baseData = () => ({
  userId: randomUUID(),
  email: 'test@trams.local',
  name: 'Test User',
});

describe('buildEvent', () => {
  it('produces a complete, validated envelope', () => {
    const id = randomUUID();
    const actorUserId = randomUUID();
    const event = buildEvent({
      id,
      type: SUBJECTS.userRegistered,
      correlationId: 'corr-1',
      actorUserId,
      data: baseData(),
    });

    expect(event.id).toBe(id);
    expect(event.type).toBe('user.registered');
    expect(event.version).toBe(CURRENT_EVENT_VERSION);
    expect(event.correlationId).toBe('corr-1');
    expect(event.actor.userId).toBe(actorUserId);
    expect(() => new Date(event.occurredAt).toISOString()).not.toThrow();
  });

  it('rejects a payload that does not match its event type', () => {
    expect(() =>
      buildEvent({
        id: randomUUID(),
        type: SUBJECTS.userRegistered,
        correlationId: 'corr-1',
        actorUserId: randomUUID(),
        // @ts-expect-error deliberately wrong shape — email is required
        data: { userId: randomUUID(), name: 'No Email' },
      }),
    ).toThrow();
  });

  it('rejects a malformed email, so an undeliverable event never enters the stream', () => {
    expect(() =>
      buildEvent({
        id: randomUUID(),
        type: SUBJECTS.userRegistered,
        correlationId: 'corr-1',
        actorUserId: randomUUID(),
        data: { ...baseData(), email: 'not-an-email' },
      }),
    ).toThrow();
  });

  it('requires changedFields on user.updated', () => {
    expect(() =>
      buildEvent({
        id: randomUUID(),
        type: SUBJECTS.userUpdated,
        correlationId: 'corr-1',
        actorUserId: randomUUID(),
        // @ts-expect-error changedFields is required
        data: baseData(),
      }),
    ).toThrow();
  });
});

describe('parseEvent', () => {
  const valid = () =>
    buildEvent({
      id: randomUUID(),
      type: SUBJECTS.userRegistered,
      correlationId: 'corr-1',
      actorUserId: randomUUID(),
      data: baseData(),
    });

  it('round-trips a valid event', () => {
    const event = valid();
    const result = parseEvent(JSON.stringify(event));

    expect(result.ok).toBe(true);
    expect(result.event).toEqual(event);
  });

  it('accepts a Uint8Array, which is what the broker actually delivers', () => {
    const event = valid();
    const bytes = new TextEncoder().encode(JSON.stringify(event));

    expect(parseEvent(bytes).ok).toBe(true);
  });

  it('reports malformed JSON without throwing', () => {
    // Returning a result rather than throwing matters: the caller has to make a
    // routing decision (dead-letter, never retry) from the outcome.
    const result = parseEvent('{ not json');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/malformed JSON/);
  });

  it('reports a schema violation with the offending path', () => {
    const result = parseEvent(JSON.stringify({ id: 'not-a-uuid', type: 'user.registered' }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/schema violation/);
  });

  it('rejects an unknown event type rather than guessing', () => {
    const result = parseEvent(
      JSON.stringify({ ...valid(), type: 'user.something_invented_later' }),
    );

    expect(result.ok).toBe(false);
  });

  it('quarantines a future event version instead of misreading it', () => {
    // Forward compatibility: a consumer that sees version 2 while it only
    // understands version 1 must refuse, not reinterpret. Misreading a payload
    // is worse than not reading it.
    const result = parseEvent(JSON.stringify({ ...valid(), version: 99 }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unsupported event version 99/);
  });

  it('never surfaces a password field, even if one is injected into the payload', () => {
    const event = valid();
    const tampered = {
      ...event,
      data: { ...event.data, password: 'hunter2', password_hash: '$argon2id$...' },
    };

    const result = parseEvent(JSON.stringify(tampered));

    // zod strips unknown keys, so credentials cannot ride along inside an event
    // even if a future bug tries to put them there.
    expect(result.ok).toBe(true);
    expect(result.event?.data).not.toHaveProperty('password');
    expect(result.event?.data).not.toHaveProperty('password_hash');
  });
});
