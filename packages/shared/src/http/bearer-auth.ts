import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../errors.js';
import type { AccessTokenVerifier } from '../auth/verifier.js';

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedUser?: { id: string; email: string; role: 'user' | 'admin' };
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest) => Promise<void>;
    requireAdmin: (request: FastifyRequest) => Promise<void>;
  }
}

/**
 * Bearer-token route guards, shared by the gateway and the Notification Service.
 *
 * Each service verifies the signature itself rather than trusting an upstream
 * header. That is what makes the token the source of truth: a service whose
 * authorization decisions rest on `X-User-Id` handed over by a proxy is a
 * confused deputy waiting to happen, because anything that can reach the port
 * can then claim to be anyone.
 */
const bearerAuthPlugin: FastifyPluginAsync<{ verifier: AccessTokenVerifier }> = async (
  app,
  opts,
) => {
  app.decorateRequest('authenticatedUser', undefined);

  app.decorate('requireAuth', async (request: FastifyRequest) => {
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw AppError.unauthorized('Missing or malformed Authorization header');
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) throw AppError.unauthorized('Bearer token is empty');

    const claims = await opts.verifier.verify(token);

    request.authenticatedUser = {
      id: claims.sub,
      email: claims.email,
      role: claims.role,
    };
  });

  app.decorate('requireAdmin', async (request: FastifyRequest) => {
    await app.requireAuth(request);
    if (request.authenticatedUser?.role !== 'admin') {
      throw AppError.forbidden('This action requires administrator privileges');
    }
  });
};

export const bearerAuth = fp(bearerAuthPlugin, {
  name: 'trams-bearer-auth',
  fastify: '5.x',
});

/**
 * The authenticated user, or a 401.
 *
 * Route handlers guarded by `requireAuth` know a user is present, but the type
 * is still optional because the decorator applies to every request. Rather than
 * scattering `request.authenticatedUser!` non-null assertions through the
 * handlers — which silently become wrong the moment a route forgets its guard —
 * this narrows once and fails loudly if the guard really was missing.
 */
export function requireUser(request: FastifyRequest): {
  id: string;
  email: string;
  role: 'user' | 'admin';
} {
  const user = request.authenticatedUser;
  if (!user) {
    // Reaching here means a handler used this without registering requireAuth.
    // A 401 is the safe outcome, and the log line names the bug.
    request.log.error(
      { url: request.url },
      'route read the authenticated user without an auth guard — this is a wiring bug',
    );
    throw AppError.unauthorized();
  }
  return user;
}
