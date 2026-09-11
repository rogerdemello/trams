import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError, requireUser } from '@trams/shared';
import type { DeadLetterRepository } from '../repositories/dead-letter-repository.js';
import type { NotificationRepository } from '../repositories/notification-repository.js';

/**
 * Read-only HTTP surface.
 *
 * Worth being explicit about what is NOT here: there is no endpoint to create a
 * notification. The only way one comes into existence is by consuming an event
 * from JetStream. That is not an omission — it is the constraint the assignment
 * sets. If this service exposed a "send notification" endpoint, the User
 * Service could call it over REST and the entire event-driven design would be
 * decoration.
 *
 * These routes exist so a human (and the smoke test) can verify what was
 * delivered.
 */

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

interface NotificationRoutesOptions {
  notifications: NotificationRepository;
  deadLetters: DeadLetterRepository;
}

export const notificationRoutes: FastifyPluginAsync<NotificationRoutesOptions> = async (
  app,
  opts,
) => {
  const { notifications, deadLetters } = opts;

  /**
   * The caller's own notification history.
   *
   * Scoped to the authenticated subject from the verified token — never to a
   * user id from the query string, which the caller controls. Reading someone
   * else's notifications must not be one query parameter away.
   */
  app.get('/', { onRequest: app.requireAuth }, async (request, reply) => {
    const query = paginationSchema.parse(request.query);
    const userId = requireUser(request).id;

    const { notifications: rows, total } = await notifications.listForUser(userId, query);

    return reply.send({
      notifications: rows.map(toNotificationDto),
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + rows.length < total,
      },
    });
  });

  /** Look up the notification produced by a specific event, for tracing. */
  app.get('/by-event/:eventId', { onRequest: app.requireAuth }, async (request, reply) => {
    const { eventId } = z.object({ eventId: z.string().uuid() }).parse(request.params);

    const row = await notifications.findByEventId(eventId);
    if (!row) throw AppError.notFound('Notification');

    // Ownership re-checked: an event id must not be a way to read another
    // user's notification.
    const actor = requireUser(request);
    if (actor.role !== 'admin' && row.user_id !== actor.id) {
      throw AppError.notFound('Notification');
    }

    return reply.send({ notification: toNotificationDto(row) });
  });

  /**
   * Dead letters — admin only.
   *
   * This is the operational view: what failed permanently, and why. Restricted
   * to admins because a dead letter contains the raw event payload.
   */
  app.get('/dead-letters', { onRequest: app.requireAdmin }, async (request, reply) => {
    const query = paginationSchema.parse(request.query);
    const { deadLetters: rows, total } = await deadLetters.list(query);

    return reply.send({
      deadLetters: rows,
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + rows.length < total,
      },
    });
  });

  /** Delivery counters, for the smoke test and for operators. */
  app.get('/stats', { onRequest: app.requireAdmin }, async (_request, reply) => {
    const [delivery, deadLetterCount] = await Promise.all([
      notifications.stats(),
      deadLetters.count(),
    ]);

    return reply.send({ notifications: delivery, deadLetters: deadLetterCount });
  });
};

/**
 * Map a row to its API representation.
 *
 * Explicit field mapping rather than returning the row, so adding a column to
 * the table cannot accidentally expose it over HTTP.
 */
function toNotificationDto(row: {
  id: string;
  event_id: string;
  event_type: string;
  recipient: string;
  channel: string;
  subject: string;
  body: string;
  status: string;
  attempts: number;
  correlation_id: string;
  created_at: string;
  sent_at: string | null;
}) {
  return {
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    recipient: row.recipient,
    channel: row.channel,
    subject: row.subject,
    body: row.body,
    status: row.status,
    attempts: row.attempts,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}
