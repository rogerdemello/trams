import helmet from '@fastify/helmet';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  bearerAuth,
  correlation,
  errorHandler,
  health,
  internalAuth,
  type AccessTokenVerifier,
  type Config,
  type DependencyCheck,
  type Logger,
} from '@trams/shared';
import { notificationRoutes } from './routes/notification-routes.js';
import type { DeadLetterRepository } from './repositories/dead-letter-repository.js';
import type { NotificationRepository } from './repositories/notification-repository.js';

/**
 * The Notification Service's HTTP surface is read-only.
 *
 * There is no route that creates a notification. The only way one comes into
 * existence is by consuming an event from JetStream — which is exactly the
 * constraint the assignment sets. If this app exposed a "send" endpoint, the
 * User Service could call it over REST and the message broker would become
 * ornamental.
 */

export interface BuildAppOptions {
  config: Config;
  logger: Logger;
  verifier: AccessTokenVerifier;
  notifications: NotificationRepository;
  deadLetters: DeadLetterRepository;
  dependencies: DependencyCheck[];
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, logger, verifier, notifications, deadLetters, dependencies } = options;

  const app = Fastify({
    // See services/user-service/src/app.ts for why this cast is required: it
    // pins the instance generic so the annotated `FastifyInstance` return type
    // stays assignable. ESLint only inspects the property assignment.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    loggerInstance: logger as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: config.BODY_LIMIT_BYTES,
    requestIdHeader: false,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(correlation);
  await app.register(errorHandler);
  await app.register(health, { service: 'notification-service', dependencies });

  await app.register(internalAuth, { token: config.INTERNAL_TOKEN });
  await app.register(bearerAuth, { verifier });

  await app.register(notificationRoutes, {
    notifications,
    deadLetters,
    prefix: '/notifications',
  });

  return app;
}
