import { describe, expect, it, vi } from 'vitest';
import { createLogger, GracefulShutdown } from '@trams/shared';

/**
 * Graceful shutdown ordering.
 *
 * Worth testing rather than asserting, for a specific reason: Windows has no
 * true SIGTERM, so the shutdown path cannot be exercised by signalling a live
 * process there. A unit test verifies the guarantees on every platform.
 *
 * What is actually at stake: if the HTTP server is not closed before the
 * message consumer drains, a request can be accepted after its dependencies
 * have gone away. And if the process exits mid-handler, a JetStream message is
 * left unacked — best case redelivered, worst case a half-written notification.
 */

const logger = createLogger({ service: 'test', level: 'silent' });

describe('GracefulShutdown', () => {
  it('runs handlers in reverse registration order', async () => {
    // Reverse order is the whole design: a service registers its resources in
    // dependency order (database → broker → HTTP server) and they tear down
    // correctly without anyone maintaining a second, drift-prone list.
    const order: string[] = [];
    const exit = vi.fn();

    const shutdown = new GracefulShutdown({ logger, exit });
    shutdown.register('database', () => void order.push('database'));
    shutdown.register('nats', () => void order.push('nats'));
    shutdown.register('http-server', () => void order.push('http-server'));

    await shutdown.run(0);

    // Registered last → torn down first: stop accepting requests, then drain
    // the broker, then close the database.
    expect(order).toEqual(['http-server', 'nats', 'database']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('awaits async handlers before moving on', async () => {
    const order: string[] = [];
    const exit = vi.fn();

    const shutdown = new GracefulShutdown({ logger, exit });
    shutdown.register('slow-database', async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('slow-database');
    });
    shutdown.register('consumer', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('consumer');
    });

    await shutdown.run(0);

    // Not interleaved — the consumer must fully drain before the database it
    // writes to is closed.
    expect(order).toEqual(['consumer', 'slow-database']);
  });

  it('continues after a failing handler', async () => {
    // A broker that refuses to drain must not leave the database connection
    // open. One bad step cannot abort the rest of teardown.
    const order: string[] = [];
    const exit = vi.fn();

    const shutdown = new GracefulShutdown({ logger, exit });
    shutdown.register('database', () => void order.push('database'));
    shutdown.register('nats', () => {
      throw new Error('broker will not drain');
    });
    shutdown.register('http-server', () => void order.push('http-server'));

    await shutdown.run(0);

    expect(order).toEqual(['http-server', 'database']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('is idempotent — a second signal does not re-run teardown', async () => {
    // Both SIGTERM and SIGINT can arrive, and an orchestrator may repeat the
    // signal. Running teardown twice would double-close resources.
    const handler = vi.fn();
    const exit = vi.fn();

    const shutdown = new GracefulShutdown({ logger, exit });
    shutdown.register('database', handler);

    await shutdown.run(0);
    await shutdown.run(0);
    await shutdown.run(1);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-zero exit code', async () => {
    const exit = vi.fn();
    const shutdown = new GracefulShutdown({ logger, exit });

    await shutdown.run(1);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('force-exits when a handler hangs past the timeout', async () => {
    // Without a ceiling, a hung handler means the process never dies and the
    // orchestrator's own kill timer eventually SIGKILLs it — losing whatever
    // the remaining steps would have flushed.
    const exit = vi.fn();
    const shutdown = new GracefulShutdown({ logger, exit, timeoutMs: 50 });

    shutdown.register('hangs-forever', () => new Promise<void>(() => undefined));

    void shutdown.run(0);
    await new Promise((r) => setTimeout(r, 150));

    // Forced to 1 even though a clean exit was requested: the shutdown did not
    // complete, so reporting success would be a lie to the orchestrator.
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('supports fluent registration', () => {
    const shutdown = new GracefulShutdown({ logger, exit: vi.fn() });

    expect(shutdown.register('a', () => undefined)).toBe(shutdown);
  });
});
