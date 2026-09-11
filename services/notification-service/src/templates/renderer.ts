import type { EventEnvelope } from '@trams/shared';

/**
 * Turn a domain event into a human-readable notification.
 *
 * Rendering is a pure function of the event — no database, no clock, no
 * network. That makes it trivially unit-testable and, more importantly, means a
 * redelivered event always renders identically, so a retry cannot produce a
 * subtly different message from the first attempt.
 *
 * The `switch` is exhaustive over the discriminated union. Adding a new event
 * type to the shared contract without adding a template here is a TypeScript
 * error, not a message that silently falls through to a dead-letter queue at
 * runtime. This is the main practical benefit of modelling events as a
 * discriminated union rather than `{ type: string, data: any }`.
 */

export interface RenderedNotification {
  recipient: string;
  subject: string;
  body: string;
  userId: string;
}

export function renderNotification(event: EventEnvelope): RenderedNotification {
  switch (event.type) {
    case 'user.registered':
      return {
        recipient: event.data.email,
        userId: event.data.userId,
        subject: 'Welcome to Trams',
        body: [
          `Hi ${event.data.name},`,
          '',
          'Your Trams account is ready to use.',
          '',
          `Account email: ${event.data.email}`,
          `Created: ${formatTimestamp(event.occurredAt)}`,
          '',
          'If you did not create this account, please contact support.',
        ].join('\n'),
      };

    case 'user.updated': {
      // Describing exactly what changed is what makes this notification useful
      // rather than noise — "your profile was updated" tells a user nothing
      // they can act on.
      const changes = event.data.changedFields.join(', ');
      return {
        recipient: event.data.email,
        userId: event.data.userId,
        subject: 'Your Trams profile was updated',
        body: [
          `Hi ${event.data.name},`,
          '',
          `The following details on your account were changed: ${changes}.`,
          `Changed: ${formatTimestamp(event.occurredAt)}`,
          '',
          'If this was not you, please secure your account immediately.',
        ].join('\n'),
      };
    }

    case 'user.password_changed':
      return {
        recipient: event.data.email,
        userId: event.data.userId,
        subject: 'Your Trams password was changed',
        body: [
          `Hi ${event.data.name},`,
          '',
          'Your password was changed and all other sessions have been signed out.',
          '',
          `When: ${formatTimestamp(event.data.changedAt)}`,
          // Included when known: an unfamiliar origin is the detail that lets
          // someone recognise a change they did not make.
          ...(event.data.ipAddress ? [`Origin: ${event.data.ipAddress}`] : []),
          '',
          'If you did not make this change, contact support straight away —',
          'your account may be compromised.',
        ].join('\n'),
      };

    case 'user.deleted':
      // Note that this can be delivered after the user row is gone. The event
      // carries the email and name precisely so the consumer never has to
      // query a service for data that no longer exists.
      return {
        recipient: event.data.email,
        userId: event.data.userId,
        subject: 'Your Trams account has been deleted',
        body: [
          `Hi ${event.data.name},`,
          '',
          'Your Trams account and its personal data have been deleted.',
          `Deleted: ${formatTimestamp(event.data.deletedAt)}`,
          '',
          'Thank you for using Trams.',
        ].join('\n'),
      };

    default: {
      // Unreachable while the switch stays exhaustive; kept so that removing a
      // case fails to compile rather than falling through at runtime.
      const exhaustive: never = event;
      throw new Error(`No template for event type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function formatTimestamp(iso: string): string {
  // UTC explicitly. The consumer has no idea what timezone the recipient is in,
  // and a bare local timestamp rendered on a server in another region is worse
  // than an unambiguous one.
  return new Date(iso)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}
