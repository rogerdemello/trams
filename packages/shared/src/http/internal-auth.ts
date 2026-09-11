import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../errors.js';

export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/**
 * Require proof that a request arrived via the API Gateway.
 *
 * Defence in depth. The backend services already bind to loopback, so in the
 * normal case they are unroutable from outside the host. But "the network
 * protects it" is exactly the assumption that fails — a misconfigured
 * container network, a port-forward left open, an SSRF bug in another service
 * on the same host. This check means reaching the port is not the same as being
 * authorised to use it.
 *
 * Compared with `timingSafeEqual` rather than `===`. String comparison exits at
 * the first differing byte, so response time reveals how many leading bytes a
 * guess got right, which turns a 128-bit secret into a byte-at-a-time search.
 */
const internalAuthPlugin: FastifyPluginAsync<{ token: string; skipRoutes?: string[] }> = async (
  app,
  opts,
) => {
  const expected = Buffer.from(opts.token, 'utf8');
  const skip = new Set(opts.skipRoutes ?? ['/health', '/ready']);

  app.addHook('onRequest', async (request) => {
    // Health probes come from the orchestrator, not the gateway, and must stay
    // reachable — otherwise a rotated internal token would make every instance
    // look unhealthy and trigger a restart loop.
    if (skip.has(request.url.split('?')[0] ?? request.url)) return;

    const provided = request.headers[INTERNAL_TOKEN_HEADER];
    const value = Array.isArray(provided) ? provided[0] : provided;

    if (!value) {
      request.log.warn(
        { url: request.url, ip: request.ip },
        'rejected request with no internal token — did it bypass the gateway?',
      );
      throw AppError.unauthorized('This service is only reachable through the API Gateway');
    }

    const candidate = Buffer.from(value, 'utf8');

    // timingSafeEqual throws on length mismatch, so length is checked first.
    // Length is not secret — it is fixed by our own configuration — so leaking
    // it costs nothing.
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      request.log.warn(
        { url: request.url, ip: request.ip },
        'rejected request with invalid internal token',
      );
      throw AppError.unauthorized('This service is only reachable through the API Gateway');
    }
  });
};

export const internalAuth = fp(internalAuthPlugin, {
  name: 'trams-internal-auth',
  fastify: '5.x',
});
