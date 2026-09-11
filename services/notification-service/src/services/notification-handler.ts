import { randomUUID } from 'node:crypto';
import {
  ACK,
  deadLetter,
  retry,
  type EventEnvelope,
  type EventHandler,
  type HandlerOutcome,
  type MessageContext,
} from '@trams/shared';
import { isPermanentFailure, type NotificationChannel } from '../channels/index.js';
import type { NotificationRepository } from '../repositories/notification-repository.js';
import { renderNotification } from '../templates/renderer.js';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * The event handler — where at-least-once delivery becomes exactly-once effect.
 *
 * THE PROBLEM
 *
 * JetStream guarantees at-least-once delivery, which means the same event WILL
 * arrive more than once. Not rarely, and not only under exotic failures:
 *
 *   - the worker crashes after sending but before acking
 *   - the handler takes longer than `ack_wait`, so the broker assumes it died
 *   - the ack itself is lost on the network
 *   - the outbox publisher retried a publish whose ack went missing
 *
 * Without protection, each of those sends the user a second email. And this
 * cannot be fixed by making delivery exactly-once at the broker, because the
 * side effect is external: no broker can retract an email that has been sent.
 *
 * THE SOLUTION
 *
 * Claim the event in the database before delivering it, and let the UNIQUE
 * index on `notifications.event_id` decide who owns it. The claim is atomic, so
 * exactly one worker proceeds to send regardless of how many copies arrive or
 * how many replicas are running.
 *
 * HONEST LIMITATION
 *
 * There remains one irreducible window: if the process dies *after* the channel
 * has sent but *before* `markSent` commits, a redelivery will send again. This
 * cannot be closed without a distributed transaction across the database and
 * the mail server, which does not exist. The design chooses the safe side —
 * a rare duplicate notification rather than a silently missing one — and the
 * window is milliseconds wide. Claiming that this is literally exactly-once
 * would be false; it is exactly-once except across a crash in that window.
 * ════════════════════════════════════════════════════════════════════════════
 */

export interface NotificationHandlerDeps {
  repository: NotificationRepository;
  channel: NotificationChannel;
}

export function createNotificationHandler(deps: NotificationHandlerDeps): EventHandler {
  return async (event: EventEnvelope, context: MessageContext): Promise<HandlerOutcome> => {
    const { repository, channel } = deps;
    const { logger, deliveryCount } = context;

    // ── 1. Render ────────────────────────────────────────────────────────────
    // Before any I/O, because a template failure is a code bug that no amount
    // of retrying fixes. Dead-letter it immediately rather than burning the
    // retry budget.
    let rendered;
    try {
      rendered = renderNotification(event);
    } catch (error) {
      return deadLetter(
        `template rendering failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // ── 2. Claim ─────────────────────────────────────────────────────────────
    const claim = await repository.claim({
      id: randomUUID(),
      eventId: event.id,
      eventType: event.type,
      userId: rendered.userId,
      recipient: rendered.recipient,
      channel: channel.name,
      subject: rendered.subject,
      body: rendered.body,
      correlationId: event.correlationId,
    });

    if (claim.outcome === 'already-sent') {
      // The important line in the whole file. A duplicate is acked WITHOUT
      // re-sending, which is what makes redelivery harmless.
      logger.info(
        { eventId: event.id, deliveryCount, originalSentAt: claim.row?.sent_at },
        'event already delivered — acknowledging duplicate without re-sending',
      );
      return ACK;
    }

    if (claim.outcome === 'retry-existing') {
      logger.info(
        { eventId: event.id, deliveryCount, previousAttempts: claim.row?.attempts },
        'retrying a previously failed delivery',
      );
    }

    // ── 3. Deliver ───────────────────────────────────────────────────────────
    const attempts = (claim.row?.attempts ?? 0) + 1;

    try {
      await channel.send({
        recipient: rendered.recipient,
        subject: rendered.subject,
        body: rendered.body,
        correlationId: event.correlationId,
        eventId: event.id,
        eventType: event.type,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await repository.markFailed(event.id, attempts, message);

      // The transient/permanent distinction, honoured. A malformed recipient
      // fails identically forever, so it goes straight to the dead-letter queue
      // instead of consuming five delivery attempts and then being dropped.
      if (isPermanentFailure(error)) {
        logger.error(
          { err: error, eventId: event.id, recipient: rendered.recipient },
          'permanent delivery failure — dead-lettering without retrying',
        );
        return deadLetter(`permanent delivery failure: ${message}`);
      }

      // Transient: hand back to the runtime, which naks with backoff and
      // dead-letters once the budget is exhausted.
      return retry(`delivery failed: ${message}`);
    }

    // ── 4. Confirm ───────────────────────────────────────────────────────────
    await repository.markSent(event.id, attempts);

    logger.info(
      {
        eventId: event.id,
        eventType: event.type,
        recipient: rendered.recipient,
        channel: channel.name,
        attempts,
      },
      'notification delivered',
    );

    return ACK;
  };
}
