import type { FastifyPluginAsync } from 'fastify';
import type { AuthService } from '../services/auth-service.js';
import { loginSchema, logoutSchema, refreshSchema, registerSchema } from '../schemas.js';

/**
 * Authentication routes.
 *
 * Handlers stay thin on purpose: parse, delegate, shape the response. All the
 * interesting decisions — the outbox transaction, token rotation, timing
 * equalisation — live in AuthService, where they can be unit-tested without an
 * HTTP layer in the way.
 */

interface AuthRoutesOptions {
  authService: AuthService;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, opts) => {
  const { authService } = opts;

  app.post('/register', async (request, reply) => {
    const body = registerSchema.parse(request.body);

    const result = await authService.register({
      ...body,
      correlationId: request.correlationId,
    });

    return reply.status(201).send(result);
  });

  app.post('/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const result = await authService.login({
      ...body,
      correlationId: request.correlationId,
    });

    return reply.status(200).send(result);
  });

  app.post('/refresh', async (request, reply) => {
    const body = refreshSchema.parse(request.body);

    const result = await authService.refresh({
      refreshToken: body.refreshToken,
      correlationId: request.correlationId,
    });

    return reply.status(200).send(result);
  });

  app.post('/logout', async (request, reply) => {
    const body = logoutSchema.parse(request.body);

    await authService.logout({
      refreshToken: body.refreshToken,
      allSessions: body.allSessions,
    });

    // 204: the operation is idempotent and there is nothing meaningful to
    // return. A body here would only invite clients to depend on it.
    return reply.status(204).send();
  });
};
