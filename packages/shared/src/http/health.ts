import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Liveness and readiness are deliberately different endpoints.
 *
 *  /health  — "is this process alive?" Answers from memory, touches nothing.
 *             An orchestrator restarts the container when this fails.
 *
 *  /ready   — "can this process actually serve traffic?" Probes each real
 *             dependency. An orchestrator removes the instance from the load
 *             balancer when this fails, but does NOT restart it.
 *
 * Collapsing the two is a common and expensive mistake: if a dependency blips,
 * a combined endpoint makes the orchestrator kill a perfectly healthy process,
 * turning a brief downstream hiccup into a restart storm that takes longer to
 * recover than the original fault.
 */

export interface DependencyCheck {
  name: string;
  check: () => Promise<void>;
}

export interface HealthOptions {
  service: string;
  version?: string;
  dependencies?: DependencyCheck[];
}

const healthPlugin: FastifyPluginAsync<HealthOptions> = async (app, opts) => {
  const startedAt = Date.now();
  const { service, version = '1.0.0', dependencies = [] } = opts;

  app.get('/health', { logLevel: 'warn' }, async () => ({
    status: 'ok',
    service,
    version,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }));

  app.get('/ready', { logLevel: 'warn' }, async (request, reply) => {
    const results = await Promise.all(
      dependencies.map(async (dependency) => {
        try {
          await dependency.check();
          return { name: dependency.name, status: 'ok' as const };
        } catch (error) {
          request.log.warn({ err: error, dependency: dependency.name }, 'readiness check failed');
          return {
            name: dependency.name,
            status: 'unavailable' as const,
            // The reason is useful to an operator reading `/ready` directly and
            // contains no secrets — dependency names and connection failures only.
            reason: error instanceof Error ? error.message : 'unknown error',
          };
        }
      }),
    );

    const ready = results.every((result) => result.status === 'ok');
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      service,
      checks: results,
    });
  });
};

export const health = fp(healthPlugin, {
  name: 'trams-health',
  fastify: '5.x',
});
