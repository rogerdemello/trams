import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const shared = fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url));

/**
 * Two test projects, split by what they cost to run.
 *
 *   unit         — pure logic. No broker, no filesystem, no sockets. Runs in
 *                  milliseconds, so it can run on every keystroke.
 *
 *   integration  — boots a REAL nats-server with the real TLS configuration and
 *                  the real per-service permissions.
 *
 * The integration tests deliberately do not mock the broker. The entire point
 * of this system is its delivery guarantees — idempotency, redelivery, dead
 * lettering, ack semantics — and every one of those is a property of JetStream.
 * A mock would encode my assumptions about how JetStream behaves and then
 * cheerfully confirm them. Testing against the real server is the only way the
 * assertions mean anything.
 *
 * `npm test` runs the two projects SEQUENTIALLY (see package.json), not via a
 * bare `vitest run`. Vitest executes projects in parallel by default, and doing
 * so here starves the single shared broker: the integration suite's ack timers
 * and fetch expiries are wall-clock bound, so competing for CPU with the unit
 * workers turns real assertions into spurious timeouts. Running unit first also
 * fails fast on cheap tests before paying for a broker.
 */
export default defineConfig({
  resolve: {
    // Point at source rather than dist, so tests never run against a stale
    // build and no build step is required before `npm test`.
    alias: { '@trams/shared': shared },
  },
  test: {
    // Integration files share one broker, so they must not run concurrently:
    // parallel suites would race over the same durable consumer's position in
    // the stream. This is a root-level option — `fileParallelism` is not valid
    // inside a project config.
    fileParallelism: false,
    projects: [
      {
        resolve: { alias: { '@trams/shared': shared } },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias: { '@trams/shared': shared } },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/helpers/global-setup.ts'],
          // A real broker, real TLS handshakes and real ack timers are involved.
          testTimeout: 45_000,
          hookTimeout: 45_000,
        },
      },
    ],
  },
});
