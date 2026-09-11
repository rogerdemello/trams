import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError, isAppError, toProblemDetails } from '../errors.js';

/**
 * Fastify types the value reaching an error handler as `unknown`, which is
 * correct — anything can be thrown. These two helpers do the narrowing once
 * rather than casting at each use.
 */
function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = (error as { statusCode?: unknown }).statusCode;
  return typeof candidate === 'number' ? candidate : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One error handler for all three services, so every failure — anywhere in the
 * system — leaves as the same `application/problem+json` shape.
 *
 * Consistency here is a real feature: a client needs exactly one error parser,
 * and an unexpected error can never accidentally return a stack trace because
 * no route is responsible for formatting its own failures.
 */
export interface ErrorHandlerOptions {
  /**
   * Appended to a 404 as the problem document's `hint`. Set it where a human
   * reads the response — the public edge — and leave it unset on the internal
   * services, whose 404s are consumed by the gateway rather than by a person.
   */
  notFoundHint?: string;
}

const errorHandlerPlugin: FastifyPluginAsync<ErrorHandlerOptions> = async (app, opts) => {
  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.correlationId;

    // Zod failures become field-level validation errors rather than a 500.
    if (error instanceof ZodError) {
      const appError = AppError.validation(
        'Request validation failed',
        error.issues.map((issue) => ({
          path: issue.path.join('.') || '(body)',
          message: issue.message,
        })),
      );
      request.log.info({ err: appError, issues: appError.details }, 'request validation failed');
      const problem = toProblemDetails(appError, correlationId);
      return reply.status(problem.status).type('application/problem+json').send(problem);
    }

    // Fastify's own errors (bad JSON, body too large, rate limit) arrive with a
    // statusCode already attached; map them into our taxonomy.
    const fastifyStatus = statusCodeOf(error);
    if (!isAppError(error) && fastifyStatus !== undefined && fastifyStatus < 500) {
      const message = messageOf(error);
      const mapped =
        fastifyStatus === 429
          ? AppError.rateLimited(message)
          : new AppError('VALIDATION_ERROR', fastifyStatus, message);
      request.log.info({ err: error }, 'request rejected');
      const problem = toProblemDetails(mapped, correlationId);
      return reply.status(problem.status).type('application/problem+json').send(problem);
    }

    const problem = toProblemDetails(error, correlationId);

    // 5xx is an operator problem; log the full error including cause and stack.
    // 4xx is a caller problem; info level is enough and keeps logs readable.
    if (problem.status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
    } else {
      request.log.info({ err: error }, 'request failed');
    }

    return reply.status(problem.status).type('application/problem+json').send(problem);
  });

  app.setNotFoundHandler((request, reply) => {
    const problem = toProblemDetails(
      AppError.notFound(`Route ${request.method} ${request.url}`),
      request.correlationId,
    );
    if (opts.notFoundHint) problem.hint = opts.notFoundHint;
    return reply.status(404).type('application/problem+json').send(problem);
  });
};

export const errorHandler = fp(errorHandlerPlugin, {
  name: 'trams-error-handler',
  fastify: '5.x',
});
