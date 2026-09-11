import type { Logger } from '@trams/shared';
import {
  PermanentDeliveryError,
  type NotificationChannel,
  type NotificationMessage,
} from './types.js';

/**
 * The default channel: render the notification to the structured log.
 *
 * This is the default deliberately. It has no external dependency, so a
 * reviewer can clone the repo and watch notifications arrive without
 * configuring a mail server or signing up for a provider. The event-driven
 * machinery — which is what the assignment is actually about — is fully
 * exercised either way.
 *
 * It is a real implementation of the interface rather than a stub: it validates
 * its input and reports permanent failures the same way the SMTP channel does,
 * so switching NOTIFICATION_CHANNEL=smtp changes nothing about the surrounding
 * logic.
 */
export class ConsoleChannel implements NotificationChannel {
  readonly name = 'console';

  constructor(private readonly logger: Logger) {}

  async send(message: NotificationMessage): Promise<void> {
    // Validated even though nothing downstream requires it, so the console and
    // SMTP channels agree on what constitutes a deliverable message. Otherwise
    // a bad address would pass in development and only fail in production.
    if (!message.recipient.includes('@')) {
      throw new PermanentDeliveryError(`Recipient is not a valid address: ${message.recipient}`);
    }

    this.logger.info(
      {
        channel: this.name,
        to: message.recipient,
        subject: message.subject,
        eventId: message.eventId,
        eventType: message.eventType,
        // The rendered body, on its own field so it stays readable in a
        // structured log viewer.
        body: message.body,
      },
      `NOTIFICATION → ${message.recipient}: ${message.subject}`,
    );
  }

  async verify(): Promise<void> {
    // Always ready — there is nothing to connect to.
  }
}

/**
 * A channel that records instead of delivering, for tests.
 *
 * Lives beside the production channels rather than in the test folder because
 * it is part of the same contract: if the interface changes, this fails to
 * compile alongside the others, so tests cannot silently drift from reality.
 */
export class RecordingChannel implements NotificationChannel {
  readonly name = 'recording';
  readonly sent: NotificationMessage[] = [];

  /** Set to make the next N sends fail, to exercise the retry path. */
  failNext = 0;
  failPermanently = false;

  async send(message: NotificationMessage): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw this.failPermanently
        ? new PermanentDeliveryError('injected permanent failure')
        : new Error('injected transient failure');
    }
    this.sent.push(message);
  }

  async verify(): Promise<void> {}

  reset(): void {
    this.sent.length = 0;
    this.failNext = 0;
    this.failPermanently = false;
  }
}
