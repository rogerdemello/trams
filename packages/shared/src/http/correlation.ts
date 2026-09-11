import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { withCorrelationId } from '../logger.js';

export const CORRELATION_HEADER = 'x-correlation-id';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

/**
 * Accept an inbound correlation id or mint one, bind it to the async context so
 * every log line in the request picks it up automatically, and echo it back on
 * the response.
 *
 * Echoing matters: it means a caller who sees a 500 can quote an id that maps
 * to exact log lines across all three services and the broker.
 *
 * An inbound id is length-capped and character-filtered before use. It is
 * attacker-controlled input that ends up in log files, so accepting it verbatim
 * would allow log injection (newlines forging fake entries) or unbounded
 * memory per request.
 */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const correlationPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('correlationId', '');

  app.addHook('onRequest', (request, reply, done) => {
    const inbound = request.headers[CORRELATION_HEADER];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
    const correlationId = candidate && SAFE_ID.test(candidate) ? candidate : randomUUID();

    request.correlationId = correlationId;
    void reply.header(CORRELATION_HEADER, correlationId);

    withCorrelationId(correlationId, done);
  });
};

export const correlation = fp(correlationPlugin, {
  name: 'trams-correlation',
  fastify: '5.x',
});
