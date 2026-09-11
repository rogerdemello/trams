/**
 * The delivery channel abstraction.
 *
 * Notification delivery is the one part of this service that talks to the
 * outside world, and it is the part most likely to change — console today,
 * SMTP tomorrow, SMS or push after that. Putting it behind an interface means
 * the handler's logic (idempotency, retry classification, persistence) is
 * written once and is completely independent of how a message physically
 * leaves the process.
 *
 * It also makes the handler testable without a mail server: the test suite
 * injects a recording channel and asserts on what would have been sent.
 */

export interface NotificationMessage {
  recipient: string;
  subject: string;
  body: string;
  /** Correlation id, so a delivery can be traced back to the originating request. */
  correlationId: string;
  eventId: string;
  eventType: string;
}

export interface NotificationChannel {
  /** Recorded on the notification row, so history shows how it was delivered. */
  readonly name: string;

  /**
   * Deliver the message.
   *
   * Throws on failure. The kind of error thrown is significant: see
   * PermanentDeliveryError below.
   */
  send(message: NotificationMessage): Promise<void>;

  /** Optional readiness probe, surfaced on /ready. */
  verify?(): Promise<void>;

  /** Optional cleanup on shutdown (connection pools, etc). */
  close?(): Promise<void>;
}

/**
 * A failure that retrying cannot fix.
 *
 * This distinction is the reason the interface throws typed errors rather than
 * returning a boolean. Consider two failures:
 *
 *   - SMTP connection timed out          → transient. Retry in 30s and it will
 *                                          probably succeed.
 *   - Recipient address is malformed     → permanent. It will fail identically
 *                                          on every one of the five attempts,
 *                                          then be dropped.
 *
 * Treating both the same way is the common mistake: either you retry a hopeless
 * message five times and then lose it silently, or you discard a recoverable
 * one on the first blip. Throwing PermanentDeliveryError lets the handler
 * dead-letter immediately, preserving the message for inspection instead of
 * burning the retry budget on it.
 */
export class PermanentDeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentDeliveryError';
  }
}

/** An explicitly transient failure. Anything unrecognised is treated as transient too. */
export class TransientDeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientDeliveryError';
  }
}

export function isPermanentFailure(error: unknown): boolean {
  return error instanceof PermanentDeliveryError;
}
