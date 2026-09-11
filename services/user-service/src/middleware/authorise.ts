import type { FastifyRequest } from 'fastify';
import { AppError } from '@trams/shared';

/**
 * Authorise access to a specific user's resources.
 *
 * Ownership is enforced here, in the service that owns the data, rather than
 * inferred from the URL or trusted from the gateway. The gateway is a
 * convenience filter; this is the authority. If the only ownership check lived
 * at the edge, anything reaching this service directly — a misconfigured
 * network rule, a future internal caller, a bug in a proxy route — would bypass
 * it entirely.
 *
 * Admins may act on anyone; everyone else may act only on themselves.
 *
 * Note the 404, not 403, when a non-admin targets someone else's account. A 403
 * confirms the account exists, which turns this endpoint into an oracle for
 * enumerating valid user ids. Both "does not exist" and "not yours" are
 * indistinguishable to the caller.
 */
export function authoriseUserAccess(request: FastifyRequest, targetUserId: string): void {
  const actor = request.authenticatedUser;
  if (!actor) throw AppError.unauthorized();

  if (actor.role === 'admin') return;
  if (actor.id === targetUserId) return;

  request.log.warn({ actorId: actor.id, targetUserId }, 'blocked cross-account access attempt');
  throw AppError.notFound('User');
}
