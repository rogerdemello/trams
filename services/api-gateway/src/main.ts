import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { request as undiciRequest } from 'undici';
import {
  AccessTokenVerifier,
  bearerAuth,
  correlation,
  createLogger,
  errorHandler,
  GracefulShutdown,
  health,
  loadConfig,
  AppError,
} from '@trams/shared';
import { createProxy } from './proxy.js';
import { apiRoutes } from './routes.js';

/**
 * API Gateway — the only component intended to be publicly reachable.
 *
 * It holds no business logic and no database. Its entire job is policy:
 * authentication, rate limiting, CORS, correlation, error normalisation, and
 * forwarding. Keeping domain rules out of it is what lets the backend services
 * stay independently testable and the gateway stay replaceable.
 *
 * It also holds the *weakest* credentials in the system: only the JWT public
 * key, so it can verify tokens but not mint them. That is deliberate — this is
 * the component most exposed to the internet and therefore the one most likely
 * to be compromised, so it is given the least capability.
 */

const config = loadConfig();
const logger = createLogger({
  service: 'api-gateway',
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV !== 'production',
});

async function main(): Promise<void> {
  const shutdown = new GracefulShutdown({ logger });

  const verifier = new AccessTokenVerifier(config);
  await verifier.init();

  const app = Fastify({
    loggerInstance: logger,
    // This IS the public listener, so trustProxy must reflect reality. It is
    // enabled because the intended deployment sits behind a TLS-terminating
    // load balancer; on a directly-exposed listener it would let any client
    // spoof its address via X-Forwarded-For and evade the per-IP rate limit.
    trustProxy: true,
    bodyLimit: config.BODY_LIMIT_BYTES,
    requestIdHeader: false,
  });

  // ── Edge hardening ─────────────────────────────────────────────────────────
  await app.register(helmet, {
    // The gateway serves JSON, not HTML, so a CSP would have nothing to govern.
    contentSecurityPolicy: false,
    hsts: config.NODE_ENV === 'production',
  });

  /**
   * CORS from an explicit allowlist, never a wildcard.
   *
   * `origin: true` (reflect any origin) combined with credentials is the
   * classic misconfiguration that lets any website make authenticated requests
   * on a logged-in user's behalf. An unknown origin is rejected here.
   */
  await app.register(cors, {
    origin: (origin, callback) => {
      // No Origin header: a same-origin or non-browser client (curl, a server).
      // CORS is a browser mechanism, so there is nothing to enforce.
      if (!origin) return callback(null, true);

      if (config.CORS_ORIGINS.includes(origin)) return callback(null, true);

      logger.warn({ origin }, 'blocked request from disallowed origin');
      // An AppError, not a bare Error: the shared error handler renders it as a
      // 403 problem+json. A plain Error carries no status and would surface as
      // a 500, which misreports a correctly-enforced policy as a server fault.
      return callback(AppError.forbidden(`Origin ${origin} is not allowed`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-correlation-id'],
    exposedHeaders: ['x-correlation-id'],
    maxAge: 86_400,
  });

  /**
   * Rate limiting, keyed per IP.
   *
   * Applied at the gateway rather than in each service, because this is the one
   * place that sees the real client address. It protects both capacity and the
   * authentication endpoints (which impose a tighter limit of their own — see
   * routes.ts).
   */
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    keyGenerator: (request) => request.ip,
    // Must return an Error, not a plain payload object: the plugin throws this
    // value, so it lands in setErrorHandler. Returning a bare problem-details
    // object gives a 500, because nothing downstream can tell what status it
    // was meant to have. An AppError carries the 429 with it.
    errorResponseBuilder: (_request, context) =>
      AppError.rateLimited(`Rate limit exceeded: ${context.max} requests per ${context.after}`),
  });

  await app.register(correlation);
  await app.register(errorHandler);
  await app.register(bearerAuth, { verifier });

  /**
   * Readiness probes the backends through the same path real traffic takes.
   *
   * A readiness check that only reports on the gateway's own process would say
   * "ready" while every request 503s. Probing the dependencies is the only
   * answer that means anything to a load balancer.
   */
  await app.register(health, {
    service: 'api-gateway',
    dependencies: [
      { name: 'user-service', check: () => probe(config.USER_SERVICE_URL) },
      { name: 'notification-service', check: () => probe(config.NOTIFICATION_SERVICE_URL) },
    ],
  });

  // ── Proxies ────────────────────────────────────────────────────────────────
  const userProxy = createProxy({
    targetBaseUrl: config.USER_SERVICE_URL,
    internalToken: config.INTERNAL_TOKEN,
    serviceName: 'user-service',
    logger,
  });

  const notificationProxy = createProxy({
    targetBaseUrl: config.NOTIFICATION_SERVICE_URL,
    internalToken: config.INTERNAL_TOKEN,
    serviceName: 'notification-service',
    logger,
  });

  await app.register(apiRoutes, {
    userProxy,
    notificationProxy,
    authRateLimit: { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW },
    // Versioned from the start. Adding a version later means either breaking
    // every client or running an unversioned surface forever.
    prefix: '/api/v1',
  });

  shutdown.register('http-server', () => app.close());
  shutdown.listen();

  await app.listen({ port: config.GATEWAY_PORT, host: config.GATEWAY_HOST });

  logger.info(
    {
      port: config.GATEWAY_PORT,
      host: config.GATEWAY_HOST,
      corsOrigins: config.CORS_ORIGINS,
      rateLimit: `${config.RATE_LIMIT_MAX}/${config.RATE_LIMIT_WINDOW}`,
      authRateLimit: `${config.AUTH_RATE_LIMIT_MAX}/${config.RATE_LIMIT_WINDOW}`,
    },
    'api-gateway ready',
  );
}

/** Hit a backend's own /health so readiness reflects the real network path. */
async function probe(baseUrl: string): Promise<void> {
  const response = await undiciRequest(`${baseUrl}/health`, {
    method: 'GET',
    headersTimeout: 2_000,
    bodyTimeout: 2_000,
  });
  // Drain the body, otherwise the connection is not released back to the pool
  // and repeated probes leak sockets.
  await response.body.dump();
  if (response.statusCode !== 200) {
    throw new Error(`health check returned ${response.statusCode}`);
  }
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'api-gateway failed to start');
  process.exit(1);
});
