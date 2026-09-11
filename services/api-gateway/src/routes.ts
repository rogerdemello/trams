import type { FastifyPluginAsync } from 'fastify';
import type { createProxy } from './proxy.js';

/**
 * The public API surface.
 *
 * Routes are declared explicitly rather than with a catch-all wildcard. That is
 * a deliberate security choice: a `/*` proxy would expose every backend route
 * the moment one is added, including internal or debug endpoints nobody
 * intended to publish. An explicit list means publishing a route is a decision
 * someone made on purpose.
 *
 * Note also that nothing here exposes a way to *create* a notification — the
 * Notification Service's only inbound domain channel is the event stream.
 */

interface RouteOptions {
  userProxy: ReturnType<typeof createProxy>;
  notificationProxy: ReturnType<typeof createProxy>;
  authRateLimit: { max: number; timeWindow: string };
}

export const apiRoutes: FastifyPluginAsync<RouteOptions> = async (app, opts) => {
  const { userProxy, notificationProxy, authRateLimit } = opts;

  /**
   * Authentication endpoints carry a much tighter rate limit than the rest of
   * the API.
   *
   * These are the endpoints worth attacking — credential stuffing and password
   * spraying both target /login specifically. The general limit (100/min) is
   * about protecting capacity; this one (10/min) is about making an online
   * guessing attack impractical.
   */
  const authLimit = {
    config: {
      rateLimit: {
        max: authRateLimit.max,
        timeWindow: authRateLimit.timeWindow,
      },
    },
  };

  app.post('/auth/register', authLimit, (request, reply) =>
    userProxy(request, reply, '/auth/register'),
  );
  app.post('/auth/login', authLimit, (request, reply) => userProxy(request, reply, '/auth/login'));
  app.post('/auth/refresh', authLimit, (request, reply) =>
    userProxy(request, reply, '/auth/refresh'),
  );
  app.post('/auth/logout', (request, reply) => userProxy(request, reply, '/auth/logout'));

  // ── User routes ────────────────────────────────────────────────────────────
  // `onRequest: app.requireAuth` rejects an unauthenticated request at the edge
  // so it never reaches a backend. The backend re-verifies regardless — see
  // packages/shared/src/http/bearer-auth.ts for why that is not redundant.
  app.get('/users/me', { onRequest: app.requireAuth }, (request, reply) =>
    userProxy(request, reply, '/users/me'),
  );
  app.patch('/users/me', { onRequest: app.requireAuth }, (request, reply) =>
    userProxy(request, reply, '/users/me'),
  );
  app.post('/users/me/change-password', { onRequest: app.requireAuth }, (request, reply) =>
    userProxy(request, reply, '/users/me/change-password'),
  );
  app.delete('/users/me', { onRequest: app.requireAuth }, (request, reply) =>
    userProxy(request, reply, '/users/me'),
  );

  app.get<{ Params: { id: string } }>(
    '/users/:id',
    { onRequest: app.requireAuth },
    (request, reply) =>
      // The id is percent-encoded before being interpolated into the upstream
      // path. Without this, a crafted id could inject path segments and reach a
      // different upstream route than the one this handler declares.
      userProxy(request, reply, `/users/${encodeURIComponent(request.params.id)}`),
  );

  app.get('/users', { onRequest: app.requireAdmin }, (request, reply) =>
    userProxy(request, reply, `/users${queryString(request.raw.url)}`),
  );

  // ── Notification routes (read-only) ────────────────────────────────────────
  app.get('/notifications', { onRequest: app.requireAuth }, (request, reply) =>
    notificationProxy(request, reply, `/notifications${queryString(request.raw.url)}`),
  );

  app.get<{ Params: { eventId: string } }>(
    '/notifications/by-event/:eventId',
    { onRequest: app.requireAuth },
    (request, reply) =>
      notificationProxy(
        request,
        reply,
        `/notifications/by-event/${encodeURIComponent(request.params.eventId)}`,
      ),
  );

  app.get('/notifications/dead-letters', { onRequest: app.requireAdmin }, (request, reply) =>
    notificationProxy(request, reply, `/notifications/dead-letters${queryString(request.raw.url)}`),
  );

  app.get('/notifications/stats', { onRequest: app.requireAdmin }, (request, reply) =>
    notificationProxy(request, reply, '/notifications/stats'),
  );
};

/**
 * Extract the query string from the raw URL for forwarding.
 *
 * Taken from the raw URL rather than re-serialised from Fastify's parsed
 * `request.query`, so that pagination parameters reach the backend exactly as
 * sent and are validated there — the service is the authority on its own input.
 */
function queryString(rawUrl: string | undefined): string {
  if (!rawUrl) return '';
  const index = rawUrl.indexOf('?');
  return index === -1 ? '' : rawUrl.slice(index);
}
