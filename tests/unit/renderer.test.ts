import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildEvent, SUBJECTS, type EventEnvelope } from '@trams/shared';
import { renderNotification } from '../../services/notification-service/src/templates/renderer.js';

/**
 * Rendering is a pure function of the event, which is what makes a redelivered
 * event produce a byte-identical message. If rendering read a clock or a
 * database, a retry could send something subtly different from the first
 * attempt.
 */

const userId = randomUUID();
const data = { userId, email: 'recipient@trams.local', name: 'Renée O’Brien' };

function event<T extends keyof typeof SUBJECTS>(
  type: (typeof SUBJECTS)[T],
  payload: unknown,
): EventEnvelope {
  return buildEvent({
    id: randomUUID(),
    type,
    correlationId: 'corr-render',
    actorUserId: userId,
    occurredAt: '2026-03-04T05:06:07.000Z',
    // The per-type schema is enforced by buildEvent; this cast only satisfies
    // the generic signature in the test.
    data: payload as never,
  });
}

describe('renderNotification', () => {
  it('renders user.registered', () => {
    const result = renderNotification(event(SUBJECTS.userRegistered, data));

    expect(result.recipient).toBe('recipient@trams.local');
    expect(result.userId).toBe(userId);
    expect(result.subject).toBe('Welcome to Trams');
    expect(result.body).toContain('Renée O’Brien');
    expect(result.body).toContain('recipient@trams.local');
  });

  it('names the specific fields that changed on user.updated', () => {
    // "Your profile was updated" is noise; naming the fields is what makes the
    // notification actionable.
    const result = renderNotification(
      event(SUBJECTS.userUpdated, { ...data, changedFields: ['email', 'name'] }),
    );

    expect(result.subject).toBe('Your Trams profile was updated');
    expect(result.body).toContain('email, name');
  });

  it('includes the origin IP on a password change when known', () => {
    const result = renderNotification(
      event(SUBJECTS.userPasswordChanged, {
        ...data,
        changedAt: '2026-03-04T05:06:07.000Z',
        ipAddress: '203.0.113.42',
      }),
    );

    expect(result.subject).toBe('Your Trams password was changed');
    expect(result.body).toContain('203.0.113.42');
    expect(result.body).toContain('signed out');
  });

  it('omits the origin line entirely when the IP is unknown', () => {
    const result = renderNotification(
      event(SUBJECTS.userPasswordChanged, { ...data, changedAt: '2026-03-04T05:06:07.000Z' }),
    );

    // Not "Origin: undefined".
    expect(result.body).not.toContain('Origin:');
    expect(result.body).not.toContain('undefined');
  });

  it('renders user.deleted from the event payload alone', () => {
    // The significant property: this event can be delivered after the user row
    // is gone, so the payload has to carry everything the template needs.
    const result = renderNotification(
      event(SUBJECTS.userDeleted, { ...data, deletedAt: '2026-03-04T05:06:07.000Z' }),
    );

    expect(result.recipient).toBe('recipient@trams.local');
    expect(result.subject).toBe('Your Trams account has been deleted');
    expect(result.body).toContain('Renée O’Brien');
  });

  it('formats timestamps as unambiguous UTC', () => {
    const result = renderNotification(event(SUBJECTS.userRegistered, data));

    expect(result.body).toContain('2026-03-04 05:06:07 UTC');
  });

  it('is deterministic, so a redelivery renders identically', () => {
    const source = event(SUBJECTS.userRegistered, data);

    expect(renderNotification(source)).toEqual(renderNotification(source));
  });

  it('never leaks internal identifiers into the message body', () => {
    const source = event(SUBJECTS.userRegistered, data);
    const result = renderNotification(source);

    // A recipient has no use for an event id or a correlation id, and both
    // reveal internals. They belong in logs and headers, not in the email.
    expect(result.body).not.toContain(source.id);
    expect(result.body).not.toContain(source.correlationId);
  });
});
