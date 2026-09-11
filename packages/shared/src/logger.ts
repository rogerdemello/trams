import { AsyncLocalStorage } from 'node:async_hooks';
import { pino, type Logger } from 'pino';

/**
 * Structured logging with two responsibilities beyond "print things":
 *
 *  1. Redaction. Passwords, tokens and authorization headers must never reach
 *     a log sink. This is enforced centrally rather than trusted to every call
 *     site, because it only takes one `log.info({ body })` to leak a password
 *     into a log aggregator that a much wider audience can read.
 *
 *  2. Correlation. In an asynchronous system, a request's path crosses three
 *     processes and a broker. Without a shared identifier on every line, the
 *     only way to reconstruct what happened is to guess from timestamps. The
 *     correlation id is stored in AsyncLocalStorage so it attaches itself to
 *     log lines automatically, without being threaded through every signature.
 */

export const REDACTED_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'passwordHash',
  'tokenHash',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-internal-token"]',
  'headers.authorization',
  'headers["x-internal-token"]',
  '*.password',
  '*.passwordHash',
  '*.refreshToken',
] as const;

interface LogContext {
  correlationId: string;
}

const contextStore = new AsyncLocalStorage<LogContext>();

/** Run `fn` with a correlation id bound to every log line it produces. */
export function withCorrelationId<T>(correlationId: string, fn: () => T): T {
  return contextStore.run({ correlationId }, fn);
}

/** The correlation id for the current async context, if one is bound. */
export function currentCorrelationId(): string | undefined {
  return contextStore.getStore()?.correlationId;
}

export interface LoggerOptions {
  service: string;
  level?: string;
  pretty?: boolean;
}

export function createLogger({ service, level = 'info', pretty = false }: LoggerOptions): Logger {
  return pino({
    level,
    base: { service },
    redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
    // Pull the correlation id out of async context on every line, so callers
    // never have to remember to pass it.
    mixin() {
      const correlationId = currentCorrelationId();
      return correlationId ? { correlationId } : {};
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

export type { Logger };
