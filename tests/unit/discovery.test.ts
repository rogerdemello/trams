import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  API_CATALOGUE,
  API_PREFIX,
  buildIndexDocument,
  buildRootDocument,
  discoveryRoutes,
  type CatalogueEntry,
} from '../../services/api-gateway/src/discovery.js';
import { apiRoutes } from '../../services/api-gateway/src/routes.js';

/**
 * The discovery document is hand-written, which buys readable summaries and
 * sensible grouping at the cost of being able to drift from the routes it
 * claims to describe. This suite is what stops it drifting: it registers the
 * real route plugin and compares what Fastify actually mounted against what the
 * catalogue advertises, in both directions.
 *
 * A document that quietly lies about the API is worse than no document, because
 * the reader has no way to tell. So a route added without a catalogue entry
 * fails here, and so does a catalogue entry for a route that does not exist.
 */

interface RegisteredRoute {
  method: string;
  url: string;
}

/** Register the real route table with the surrounding plugins stubbed out. */
async function collectRegisteredRoutes(): Promise<RegisteredRoute[]> {
  const app: FastifyInstance = Fastify({ ignoreTrailingSlash: true });
  const routes: RegisteredRoute[] = [];

  // routes.ts guards endpoints with decorators supplied by the bearerAuth
  // plugin. Only their presence matters here — this suite is about the shape of
  // the route table, and the guards themselves are covered by the security
  // tests that run against a real gateway.
  const noop = async () => {};
  app.decorate('requireAuth', noop);
  app.decorate('requireAdmin', noop);

  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      // Fastify mounts a HEAD for every GET, and CORS adds OPTIONS. Neither is
      // an endpoint anyone consults a catalogue for.
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      routes.push({ method, url: route.url });
    }
  });

  const proxyStub = (async () => undefined) as never;
  await app.register(apiRoutes, {
    userProxy: proxyStub,
    notificationProxy: proxyStub,
    authRateLimit: { max: 10, timeWindow: '1 minute' },
    prefix: API_PREFIX,
  });
  await app.ready();
  await app.close();

  return routes;
}

function catalogueEntries(): CatalogueEntry[] {
  return Object.values(API_CATALOGUE).flat();
}

const key = (method: string, path: string) => `${method} ${path}`;

describe('discovery catalogue matches the real route table', () => {
  it('describes every route the gateway actually serves', async () => {
    const registered = await collectRegisteredRoutes();
    const advertised = new Set(
      catalogueEntries().map((entry) => key(entry.method, `${API_PREFIX}${entry.path}`)),
    );

    const undocumented = registered
      .map((route) => key(route.method, route.url))
      .filter((route) => !advertised.has(route));

    expect(undocumented, 'routes are registered but missing from API_CATALOGUE').toEqual([]);
  });

  it('advertises no endpoint that does not exist', async () => {
    const registered = new Set(
      (await collectRegisteredRoutes()).map((route) => key(route.method, route.url)),
    );

    const phantom = catalogueEntries()
      .map((entry) => key(entry.method, `${API_PREFIX}${entry.path}`))
      .filter((entry) => !registered.has(entry));

    expect(phantom, 'API_CATALOGUE describes routes that are not registered').toEqual([]);
  });

  it('covers the whole surface, so neither check above can pass vacuously', async () => {
    const registered = await collectRegisteredRoutes();

    // Two empty sets compare equal. Without this, deleting every route and
    // every catalogue entry would leave the suite green.
    expect(registered.length).toBeGreaterThan(10);
    expect(catalogueEntries()).toHaveLength(registered.length);
  });
});

describe('discovery documents', () => {
  it('answers at both the server root and the API root', async () => {
    const app = Fastify({ ignoreTrailingSlash: true });
    await app.register(discoveryRoutes, { version: '1.0.0' });

    for (const url of ['/', API_PREFIX, `${API_PREFIX}/`]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, `GET ${url}`).toBe(200);
    }

    await app.close();
  });

  it('does not turn a genuinely wrong path into a success', async () => {
    // The fix for "the root 404s" must not become "nothing ever 404s".
    const app = Fastify({ ignoreTrailingSlash: true });
    await app.register(discoveryRoutes, { version: '1.0.0' });

    const response = await app.inject({ method: 'GET', url: '/api/v1/nope' });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('names no internal host, port, or credential', () => {
    // The document is served unauthenticated, so it must carry nothing that is
    // not already public the moment the gateway is reachable.
    const serialised = JSON.stringify(buildIndexDocument('1.0.0'));

    // Internal topology: the backends are not routable from outside, and saying
    // where they listen only helps someone who has got past the edge.
    expect(serialised).not.toMatch(/4001|4002|4222/);
    expect(serialised).not.toMatch(/localhost|127\.0\.0\.1/);

    // Credential *material*, which is the actual risk. Deliberately not a match
    // on the word "password": /users/me/change-password is a route name, and an
    // assertion that forbids naming it would be testing prudishness rather than
    // secrecy — the kind of check that gets weakened until it means nothing.
    expect(serialised).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(serialised).not.toMatch(/INTERNAL_TOKEN|NATS_[A-Z_]*PASS|JWT_PRIVATE/);
    expect(serialised).not.toMatch(/Bearer [A-Za-z0-9._-]{20,}/);
  });

  it('points the reader at the catalogue from the server root', () => {
    const root = buildRootDocument('1.0.0');

    expect(root.api).toBe(API_PREFIX);
    expect(root.hint).toContain(API_PREFIX);
  });

  it('states every advertised path in full, so it can be pasted into curl', () => {
    const index = buildIndexDocument('1.0.0');
    const paths = Object.values(index.endpoints)
      .flat()
      .map((entry) => entry.path);

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path.startsWith(`${API_PREFIX}/`)).toBe(true);
  });
});
