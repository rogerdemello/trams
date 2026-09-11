import helmet from '@fastify/helmet';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
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
  type UserDatabase,
} from '@trams/shared';
import { authRoutes } from './routes/auth-routes.js';
import { userRoutes } from './routes/user-routes.js';
import type { AuthService } from './services/auth-service.js';
import type { UserManagementService } from './services/user-service.js';

/**
 * Assemble the HTTP application.
 *
 * Separated from main.ts so tests can build an app against in-memory
 * dependencies and drive it with `app.inject()` — no ports, no sockets, no
 * cleanup. A bootstrap that both wires dependencies and starts listening is a
 * bootstrap you cannot test.
 */

export interface BuildAppOptions {
  config: Config;
  logger: Logger;
  db: Kysely<UserDatabase>;
  /**
   * Verifies access tokens with the PUBLIC key. Note that this service also
   * holds the private key (in TokenService) for signing, but verification goes
   * through the same public-key path every other component uses — so a bug in
   * verification cannot accidentally trust something only the private key
   * could produce.
   */
  verifier: AccessTokenVerifier;
  authService: AuthService;
  userService: UserManagementService;
  dependencies: DependencyCheck[];
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, logger, verifier, authService, userService, dependencies } = options;

  const app = Fastify({
    // Cast to Fastify's own logger interface: pino's Logger is a structural
    // superset, but passing it directly narrows Fastify's generics and makes
    // the returned instance incompatible with plain `FastifyInstance`.
    //
    // ESLint reports this as unnecessary because it only considers the property
    // assignment, where pino's Logger is indeed assignable. The cast exists to
    // pin the *instance* generic, not to satisfy this property — removing it
    // produces TS2322 on the function's return type.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    loggerInstance: logger as FastifyBaseLogger,
    // Trust the proxy so `request.ip` is the real client address rather than
    // the gateway's. Safe here because the only reachable path to this service
    // is through our own gateway; on a public listener this would let clients
    // spoof their IP via X-Forwarded-For.
    trustProxy: true,
    bodyLimit: config.BODY_LIMIT_BYTES,
    disableRequestLogging: false,
    requestIdHeader: false,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(correlation);
  await app.register(errorHandler);
  await app.register(health, { service: 'user-service', dependencies });

  // Registered after /health and /ready so orchestrator probes are not blocked
  // by the gateway-only check.
  await app.register(internalAuth, { token: config.INTERNAL_TOKEN });
  await app.register(bearerAuth, { verifier });

  await app.register(authRoutes, { authService, prefix: '/auth' });
  await app.register(userRoutes, { userService, prefix: '/users' });

  return app;
}
