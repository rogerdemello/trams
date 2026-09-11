import type { FastifyReply, FastifyRequest } from 'fastify';
import { request as undiciRequest } from 'undici';
import { AppError, CORRELATION_HEADER, INTERNAL_TOKEN_HEADER, type Logger } from '@trams/shared';

/**
 * Forward a request to a backend service.
 *
 * Written explicitly rather than using an off-the-shelf proxy plugin, because
 * the header handling is the security-relevant part and it should be visible
 * rather than buried in a dependency's defaults. Specifically:
 *
 *   - Only an allowlisted set of headers is forwarded. A blocklist would be the
 *     wrong shape here: anything we forgot to block gets passed through, and
 *     the interesting attacks come from headers nobody thought about.
 *
 *   - `x-internal-token` is *set by us*, and any client-supplied value is
 *     dropped. Without that, a caller could send their own internal token
 *     header and, if it happened to be right, reach the backend as though it
 *     had come from the gateway.
 *
 *   - The correlation id is propagated so one identifier spans the gateway, the
 *     service, the broker, and the consumer.
 */

/**
 * Request headers that may cross the gateway.
 *
 * Notably absent: `x-internal-token` (we set it), `x-forwarded-*` (we set it),
 * and anything hop-by-hop.
 */
const FORWARDABLE_REQUEST_HEADERS = new Set([
  'authorization',
  'content-type',
  'accept',
  'accept-language',
  'user-agent',
]);

/**
 * Response headers that may return to the client.
 *
 * Also an allowlist. A backend must not be able to set cookies or CORS headers
 * on a response that leaves through the gateway — those are the gateway's
 * responsibility, and honouring them from upstream would let a compromised
 * backend widen the browser's trust boundary.
 */
const FORWARDABLE_RESPONSE_HEADERS = new Set([
  'content-type',
  'cache-control',
  'etag',
  'last-modified',
  'location',
  CORRELATION_HEADER,
]);

export interface ProxyOptions {
  targetBaseUrl: string;
  internalToken: string;
  serviceName: string;
  logger: Logger;
  timeoutMs?: number;
}

export function createProxy(options: ProxyOptions) {
  const { targetBaseUrl, internalToken, serviceName, timeoutMs = 10_000 } = options;

  return async function proxy(
    request: FastifyRequest,
    reply: FastifyReply,
    targetPath: string,
  ): Promise<void> {
    const headers: Record<string, string> = {};

    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      if (!FORWARDABLE_REQUEST_HEADERS.has(key.toLowerCase())) continue;
      headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    // Set by us, unconditionally — this is what proves to the backend that the
    // request came through the gateway. Any inbound value was already dropped
    // by the allowlist above.
    headers[INTERNAL_TOKEN_HEADER] = internalToken;
    headers[CORRELATION_HEADER] = request.correlationId;

    // The real client address, for the backend's logs and for the
    // `user.password_changed` event's `ipAddress` field.
    headers['x-forwarded-for'] = request.ip;
    headers['x-forwarded-proto'] = request.protocol;

    const url = `${targetBaseUrl}${targetPath}`;
    const startedAt = Date.now();

    try {
      const response = await undiciRequest(url, {
        method: request.method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
        headers,
        // Fastify has already parsed the body, so re-serialise it. GET/HEAD
        // must not carry one.
        ...(request.body !== undefined && !['GET', 'HEAD'].includes(request.method)
          ? { body: JSON.stringify(request.body) }
          : {}),
        // A bounded timeout is essential: without it a hung backend would hold
        // gateway connections open until the process ran out of sockets,
        // turning one slow service into a total outage.
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

      const durationMs = Date.now() - startedAt;

      for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        if (!FORWARDABLE_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
        void reply.header(key, Array.isArray(value) ? value.join(', ') : String(value));
      }

      request.log.debug(
        { service: serviceName, targetPath, status: response.statusCode, durationMs },
        'proxied request',
      );

      const body = await response.body.arrayBuffer();
      void reply.status(response.statusCode);

      // 204 and 304 must not carry a body.
      if (response.statusCode === 204 || response.statusCode === 304 || body.byteLength === 0) {
        return await reply.send();
      }

      return await reply.send(Buffer.from(body));
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      request.log.error(
        { err: error, service: serviceName, targetPath, durationMs },
        'upstream request failed',
      );

      // Deliberately a 503 with the service name and nothing else. The raw
      // error could contain internal hostnames, ports, or stack details, and a
      // client has no business learning the shape of our internal network.
      throw AppError.upstreamUnavailable(serviceName, error);
    }
  };
}
