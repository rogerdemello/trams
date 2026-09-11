import type { FastifyPluginAsync } from 'fastify';
import { requireUser } from '@trams/shared';
import { authoriseUserAccess } from '../middleware/authorise.js';
import {
  changePasswordSchema,
  listUsersQuerySchema,
  updateProfileSchema,
  userIdParamSchema,
} from '../schemas.js';
import type { UserManagementService } from '../services/user-service.js';

interface UserRoutesOptions {
  userService: UserManagementService;
}

export const userRoutes: FastifyPluginAsync<UserRoutesOptions> = async (app, opts) => {
  const { userService } = opts;

  /**
   * The caller's own profile.
   *
   * `/me` exists alongside `/users/:id` because it needs no id from the client
   * and therefore has no ownership question to get wrong. Clients should prefer
   * it, and it removes any temptation to trust a client-supplied id.
   */
  app.get('/me', { onRequest: app.requireAuth }, async (request, reply) => {
    const user = await userService.getById(requireUser(request).id);
    return reply.send({ user });
  });

  app.patch('/me', { onRequest: app.requireAuth }, async (request, reply) => {
    const body = updateProfileSchema.parse(request.body);

    const user = await userService.updateProfile({
      id: requireUser(request).id,
      ...body,
      correlationId: request.correlationId,
    });

    return reply.send({ user });
  });

  app.post('/me/change-password', { onRequest: app.requireAuth }, async (request, reply) => {
    const body = changePasswordSchema.parse(request.body);

    await userService.changePassword({
      id: requireUser(request).id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      correlationId: request.correlationId,
      // Recorded in the `user.password_changed` event so the notification can
      // tell the user where the change came from — which is how someone
      // recognises a change they did not make.
      ipAddress: request.ip,
    });

    return reply.status(204).send();
  });

  app.delete('/me', { onRequest: app.requireAuth }, async (request, reply) => {
    await userService.deleteAccount({
      id: requireUser(request).id,
      correlationId: request.correlationId,
    });

    return reply.status(204).send();
  });

  /**
   * Fetch a user by id.
   *
   * Ownership is re-checked against the token's subject; a non-admin asking for
   * someone else's id gets 404, not 403 — see authoriseUserAccess for why.
   */
  app.get('/:id', { onRequest: app.requireAuth }, async (request, reply) => {
    const { id } = userIdParamSchema.parse(request.params);
    authoriseUserAccess(request, id);

    const user = await userService.getById(id);
    return reply.send({ user });
  });

  /** Admin only: listing every user is not a capability an ordinary user needs. */
  app.get('/', { onRequest: app.requireAdmin }, async (request, reply) => {
    const query = listUsersQuerySchema.parse(request.query);
    const { users, total } = await userService.list(query);

    return reply.send({
      users,
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + users.length < total,
      },
    });
  });
};
