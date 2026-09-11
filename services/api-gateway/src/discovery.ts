import type { FastifyPluginAsync } from 'fastify';

/**
 * Service discovery: what a caller gets for hitting the API with no route.
 *
 * The first thing anyone does with an unfamiliar API is open its base URL, and
 * a 404 there is a dead end — it tells you the thing you typed is wrong without
 * telling you what would have been right. Answering with the endpoint catalogue
 * turns that dead end into the fastest possible orientation, and costs one
 * static document.
 *
 * This is discovery, not documentation. It lists what exists and what it needs;
 * request and response shapes live in docs/api.md and docs/openapi.yaml, which
 * it points at. Keeping the split means this document stays short enough to
 * actually read in a terminal.
 *
 * Nothing here is privileged. It advertises only paths that are already public
 * knowledge from the moment the API is reachable, names no internal host or
 * port, and describes no route that is not already declared in routes.ts.
 */

/** The single source of truth for the version prefix, imported by main.ts. */
export const API_PREFIX = '/api/v1';

/**
 * Who may call an endpoint.
 *
 * `public` is deliberately distinct from "unauthenticated": every `public`
 * route below is an authentication endpoint carrying the tighter auth-specific
 * rate limit, and calling it out lets a reader see the whole trust boundary in
 * one column.
 */
export type AuthLevel = 'public' | 'user' | 'admin';

export interface CatalogueEntry {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path relative to API_PREFIX, exactly as declared in routes.ts. */
  path: string;
  auth: AuthLevel;
  summary: string;
}

/**
 * Every public endpoint, grouped the way a reader thinks about them.
 *
 * This list is hand-written because generating it from Fastify's route table
 * would produce something correct and unreadable — no summaries, no grouping,
 * and parameter names as router internals. The cost of writing it by hand is
 * that it can drift from the routes it describes, so it does not get to drift:
 * `tests/unit/discovery.test.ts` registers the real route plugin and fails if a
 * route is missing here, described here but not registered, or listed with the
 * wrong method or authentication level. Adding a route to routes.ts without
 * adding it here is a failing test, not a stale document.
 */
export const API_CATALOGUE: Record<string, readonly CatalogueEntry[]> = {
  auth: [
    {
      method: 'POST',
      path: '/auth/register',
      auth: 'public',
      summary: 'Create an account. Returns the user and a token pair.',
    },
    {
      method: 'POST',
      path: '/auth/login',
      auth: 'public',
      summary: 'Exchange credentials for a token pair.',
    },
    {
      method: 'POST',
      path: '/auth/refresh',
      auth: 'public',
      summary: 'Rotate a refresh token. The presented token is consumed.',
    },
    {
      method: 'POST',
      path: '/auth/logout',
      auth: 'public',
      summary: 'Revoke a refresh token. Idempotent.',
    },
  ],
  users: [
    { method: 'GET', path: '/users/me', auth: 'user', summary: 'Your own profile.' },
    { method: 'PATCH', path: '/users/me', auth: 'user', summary: 'Update name or email.' },
    {
      method: 'POST',
      path: '/users/me/change-password',
      auth: 'user',
      summary: 'Change password. Requires the current one.',
    },
    {
      method: 'DELETE',
      path: '/users/me',
      auth: 'user',
      summary: 'Delete the account and revoke its tokens.',
    },
    { method: 'GET', path: '/users/:id', auth: 'user', summary: 'Fetch a user by id.' },
    { method: 'GET', path: '/users', auth: 'admin', summary: 'List users, paginated.' },
  ],
  notifications: [
    {
      method: 'GET',
      path: '/notifications',
      auth: 'user',
      summary: 'Notifications delivered to the caller, newest first.',
    },
    {
      method: 'GET',
      path: '/notifications/by-event/:eventId',
      auth: 'user',
      summary: 'Look up the notification produced by one event.',
    },
    {
      method: 'GET',
      path: '/notifications/dead-letters',
      auth: 'admin',
      summary: 'Events that could not be processed and were quarantined.',
    },
    {
      method: 'GET',
      path: '/notifications/stats',
      auth: 'admin',
      summary: 'Delivery counts by status and channel.',
    },
  ],
};

/**
 * There is no endpoint for creating a notification, and its absence is the
 * architecture rather than an omission. The Notification Service's only inbound
 * domain channel is the event stream, so the sole way to cause a notification
 * is to cause an event. Saying so here pre-empts the reasonable assumption that
 * the route was simply forgotten.
 */
const NOTIFICATION_NOTE =
  'Notifications are not created over HTTP. They are produced by consuming domain events from ' +
  'NATS JetStream, so the only way to cause one is to cause an event - for example by registering.';

function withPrefix(entries: readonly CatalogueEntry[]) {
  return entries.map((entry) => ({
    method: entry.method,
    path: `${API_PREFIX}${entry.path}`,
    auth: entry.auth,
    summary: entry.summary,
  }));
}

/** The document served at the versioned API root. */
export function buildIndexDocument(version: string) {
  return {
    name: 'Trams API',
    version,
    apiVersion: API_PREFIX,
    description:
      'Event-driven microservices. This gateway is the only public entry point; the User and ' +
      'Notification services behind it communicate solely over NATS JetStream.',
    documentation: {
      reference: 'docs/api.md',
      openapi: 'docs/openapi.yaml',
      architecture: 'docs/architecture.md',
    },
    health: {
      liveness: '/health',
      readiness: '/ready',
    },
    authentication: {
      scheme: 'Bearer',
      obtain: `POST ${API_PREFIX}/auth/login`,
      header: 'authorization: Bearer <accessToken>',
      accessTokenTtl: '15 minutes',
      note: 'Access tokens are RS256. This gateway holds only the public key, so it can verify a token but cannot mint one.',
    },
    conventions: {
      errors:
        'RFC 9457 application/problem+json, carrying a machine-readable `code` and the correlationId of the request.',
      correlation:
        'Send x-correlation-id to trace a request across both services and the broker; one is generated when absent and always echoed back.',
    },
    endpoints: {
      auth: withPrefix(API_CATALOGUE['auth'] ?? []),
      users: withPrefix(API_CATALOGUE['users'] ?? []),
      notifications: withPrefix(API_CATALOGUE['notifications'] ?? []),
    },
    notes: [NOTIFICATION_NOTE],
  };
}

/** The document served at the server root, for anyone who drops the path. */
export function buildRootDocument(version: string) {
  return {
    name: 'Trams API',
    version,
    api: API_PREFIX,
    health: { liveness: '/health', readiness: '/ready' },
    hint: `Start at GET ${API_PREFIX} for the endpoint catalogue.`,
  };
}

export interface DiscoveryOptions {
  version: string;
}

/**
 * Registered at the root, outside the versioned prefix, so both the server root
 * and the API root answer. Declared as explicit paths rather than a wildcard:
 * a catch-all would swallow genuine 404s and report every mistyped route as a
 * success, which is worse than the dead end it set out to fix.
 */
export const discoveryRoutes: FastifyPluginAsync<DiscoveryOptions> = async (app, opts) => {
  const index = buildIndexDocument(opts.version);
  const root = buildRootDocument(opts.version);

  // Static for the lifetime of the process, so it is cheap to cache and there
  // is no reason to make a reverse proxy re-ask for it on every page load.
  const cacheable = { 'cache-control': 'public, max-age=300' };

  app.get('/', { logLevel: 'warn' }, async (_request, reply) =>
    reply.headers(cacheable).send(root),
  );

  app.get(API_PREFIX, { logLevel: 'warn' }, async (_request, reply) =>
    reply.headers(cacheable).send(index),
  );
};
