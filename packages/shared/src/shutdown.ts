import type { Logger } from 'pino';

/**
 * Ordered, idempotent, time-bounded graceful shutdown.
 *
 * Order is the whole point. Handlers run in REVERSE registration order, so a
 * service registers its resources in dependency order (database, then broker,
 * then HTTP server) and they tear down correctly without anyone maintaining a
 * separate shutdown list that drifts from reality.
 *
 * For this system the sequence that matters is:
 *   1. stop accepting new HTTP requests
 *   2. stop pulling new messages and drain in-flight ones
 *   3. close the database
 *
 * Getting this wrong is not cosmetic. Killing the process mid-handler means a
 * JetStream message is left unacked — best case it is redelivered, worst case a
 * notification is half-written. Draining first turns an ugly failure into a
 * clean one.
 */

type ShutdownHandler = () => Promise<void> | void;

interface Registered {
  name: string;
  handler: ShutdownHandler;
}

export interface ShutdownOptions {
  logger: Logger;
  /** Hard ceiling before the process is killed regardless of progress. */
  timeoutMs?: number;
  signals?: NodeJS.Signals[];
  /**
   * How the process terminates. Injectable purely so the ordering guarantees
   * below can be unit-tested — a real `process.exit` would take the test
   * runner down with it.
   *
   * This matters more than it looks: Windows has no true SIGTERM, so the
   * shutdown path cannot be exercised there by signalling a live process. A
   * test is the only way to verify the ordering on every platform.
   */
  exit?: (code: number) => void;
}

export class GracefulShutdown {
  private readonly handlers: Registered[] = [];
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly exit: (code: number) => void;
  private shuttingDown = false;

  constructor(private readonly options: ShutdownOptions) {
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.exit = options.exit ?? ((code) => process.exit(code));
  }

  /** Register a teardown step. Later registrations tear down first. */
  register(name: string, handler: ShutdownHandler): this {
    this.handlers.push({ name, handler });
    return this;
  }

  /**
   * Install signal handlers plus the two last-resort process traps.
   *
   * An unhandled rejection or uncaught exception leaves the process in an
   * unknown state. The only safe response is to log it and exit so the
   * orchestrator replaces the instance — continuing to serve traffic from a
   * process whose invariants may be broken is worse than being down.
   */
  listen(): void {
    const signals = this.options.signals ?? ['SIGTERM', 'SIGINT'];
    for (const signal of signals) {
      process.once(signal, () => {
        this.logger.info({ signal }, 'shutdown signal received');
        void this.run(0);
      });
    }

    process.on('unhandledRejection', (reason) => {
      this.logger.fatal({ err: reason }, 'unhandled promise rejection — shutting down');
      void this.run(1);
    });

    process.on('uncaughtException', (error) => {
      this.logger.fatal({ err: error }, 'uncaught exception — shutting down');
      void this.run(1);
    });
  }

  /** Run every handler once. Safe to call repeatedly; later calls are ignored. */
  async run(exitCode = 0): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    const forceExit = setTimeout(() => {
      this.logger.fatal(
        { timeoutMs: this.timeoutMs },
        'graceful shutdown timed out — forcing exit',
      );
      this.exit(exitCode === 0 ? 1 : exitCode);
    }, this.timeoutMs);
    forceExit.unref();

    for (const { name, handler } of [...this.handlers].reverse()) {
      try {
        this.logger.debug({ step: name }, 'shutdown step starting');
        await handler();
        this.logger.debug({ step: name }, 'shutdown step complete');
      } catch (error) {
        // One failed step must not prevent the rest from running; a broker that
        // will not drain should still not leave the database connection open.
        this.logger.error({ err: error, step: name }, 'shutdown step failed');
      }
    }

    clearTimeout(forceExit);
    this.logger.info('shutdown complete');
    this.exit(exitCode);
  }
}
