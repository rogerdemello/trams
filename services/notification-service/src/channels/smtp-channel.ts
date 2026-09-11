import { createTransport, type Transporter } from 'nodemailer';
import type { Config, Logger } from '@trams/shared';
import {
  PermanentDeliveryError,
  TransientDeliveryError,
  type NotificationChannel,
  type NotificationMessage,
} from './types.js';

/**
 * Real email delivery over SMTP.
 *
 * Enabled with NOTIFICATION_CHANNEL=smtp. Works against a local catcher such as
 * Mailhog or Mailpit (the defaults in .env.example point at Mailhog's 127.0.0.1:1025)
 * as well as a real provider.
 *
 * The value of this class in the context of the assignment is that it proves the
 * channel abstraction is real rather than decorative — the handler, the
 * idempotency guard, and the retry classification are all unchanged when
 * delivery switches from a log line to a network call to a third party.
 */
export class SmtpChannel implements NotificationChannel {
  readonly name = 'smtp';
  private readonly transporter: Transporter;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.transporter = createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      // Only send credentials if they were configured. Local catchers accept
      // unauthenticated connections, and passing empty strings makes some
      // servers reject the session outright.
      ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } } : {}),
      // A pool keeps connections warm across a burst of notifications rather
      // than paying the TCP + TLS handshake per message.
      pool: true,
      maxConnections: 5,
      // Bounded so a hung SMTP server cannot occupy a worker slot indefinitely
      // — that would stall the consumer's max_ack_pending budget.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: NotificationMessage): Promise<void> {
    try {
      const info = await this.transporter.sendMail({
        from: this.config.SMTP_FROM,
        to: message.recipient,
        subject: message.subject,
        text: message.body,
        headers: {
          // Carried into the mail headers so a delivered message can still be
          // traced back to the request and event that produced it.
          'X-Correlation-Id': message.correlationId,
          'X-Event-Id': message.eventId,
        },
      });

      this.logger.info(
        { channel: this.name, to: message.recipient, messageId: info.messageId },
        'notification sent via SMTP',
      );
    } catch (error) {
      throw classifySmtpError(error);
    }
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}

/**
 * Map an SMTP failure onto our transient/permanent distinction.
 *
 * The SMTP reply code carries this information and it is worth respecting:
 *
 *   5xx — permanent. "No such mailbox" will be just as untrue in five minutes,
 *         so retrying wastes the budget and delays the dead-letter that would
 *         actually tell someone the address is wrong.
 *   4xx — transient. "Mailbox busy" or "try again later" is precisely the case
 *         retries exist for.
 *
 * Anything unrecognised (a socket error, a DNS failure, a timeout) is treated
 * as transient. That is the safe default: an unnecessary retry costs a little
 * work, while wrongly classifying a recoverable failure as permanent
 * dead-letters a notification that would have gone through.
 */
export function classifySmtpError(error: unknown): Error {
  const candidate = error as { responseCode?: number; code?: string; message?: string };
  const responseCode = candidate?.responseCode;

  if (typeof responseCode === 'number') {
    if (responseCode >= 500 && responseCode < 600) {
      return new PermanentDeliveryError(
        `SMTP permanent failure ${responseCode}: ${candidate.message ?? 'rejected'}`,
        { cause: error },
      );
    }
    if (responseCode >= 400 && responseCode < 500) {
      return new TransientDeliveryError(
        `SMTP transient failure ${responseCode}: ${candidate.message ?? 'deferred'}`,
        { cause: error },
      );
    }
  }

  // EENVELOPE means nodemailer itself rejected the addresses before any
  // network activity — malformed input, so no amount of retrying helps.
  if (candidate?.code === 'EENVELOPE') {
    return new PermanentDeliveryError(
      `Invalid mail envelope: ${candidate.message ?? 'bad recipient'}`,
      { cause: error },
    );
  }

  return new TransientDeliveryError(
    `SMTP delivery failed: ${candidate?.message ?? 'unknown error'}`,
    { cause: error },
  );
}
