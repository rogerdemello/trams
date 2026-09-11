import {
  connect,
  usernamePasswordAuthenticator,
  type NatsConnection,
} from '@nats-io/transport-node';
import type { Logger } from 'pino';
import type { Config } from '../config.js';

/**
 * The broker connection — the single trust boundary between the two backend
 * services.
 *
 * Security note, and the reason this file exists rather than a one-line
 * `connect()` at each call site: each service connects with its own
 * credentials, and the broker enforces subject-level permissions per account
 * (see infra/nats/nats.conf). The User Service may only *publish* `user.>`;
 * the Notification Service may only *subscribe* to it. That distinction is what
 * makes the messaging layer secure rather than merely encrypted — TLS alone
 * would give you a private channel to a broker that then lets any authenticated
 * client publish anything it likes.
 */

export type ServiceIdentity = 'user-service' | 'notification-service';

export interface NatsConnectionOptions {
  config: Config;
  identity: ServiceIdentity;
  logger: Logger;
  /** Overrides the URL from config; used by the integration test harness. */
  url?: string;
}

function credentialsFor(config: Config, identity: ServiceIdentity) {
  return identity === 'user-service'
    ? { user: config.NATS_USER_SERVICE_USER, pass: config.NATS_USER_SERVICE_PASS }
    : {
        user: config.NATS_NOTIFICATION_SERVICE_USER,
        pass: config.NATS_NOTIFICATION_SERVICE_PASS,
      };
}

/**
 * Establish a connection and log every lifecycle transition.
 *
 * Reconnection is delegated to the client library, which handles it well: an
 * unlimited retry budget with jittered backoff. What we add is visibility.
 * A silent reconnect loop is how a service ends up "running" for an hour while
 * quietly delivering nothing, so every state change produces a log line at a
 * level that matches its severity.
 */
export async function connectToNats(options: NatsConnectionOptions): Promise<NatsConnection> {
  const { config, identity, logger } = options;
  const { user, pass } = credentialsFor(config, identity);
  const servers = options.url ?? config.NATS_URL;

  const connection = await connect({
    servers,
    name: `trams-${identity}`,
    authenticator: usernamePasswordAuthenticator(user, pass),

    // Unlimited reconnect attempts with jitter. A broker restart should be a
    // recoverable blip, not something that requires restarting three services.
    maxReconnectAttempts: -1,
    reconnectTimeWait: 1_000,
    reconnectJitter: 500,
    reconnectJitterTLS: 1_000,

    // Detect a half-open connection — one where TCP looks alive but the broker
    // is gone — rather than waiting indefinitely on a dead socket.
    pingInterval: 20_000,
    maxPingOut: 3,

    ...(config.NATS_TLS_ENABLED
      ? {
          tls: {
            caFile: config.NATS_CA_PATH,
            certFile: config.NATS_CLIENT_CERT_PATH,
            keyFile: config.NATS_CLIENT_KEY_PATH,
          },
        }
      : {}),
  });

  logger.info(
    {
      servers,
      identity,
      tls: config.NATS_TLS_ENABLED,
      server: connection.getServer(),
    },
    'connected to NATS',
  );

  // Fire-and-forget lifecycle observer. Deliberately not awaited: it runs for
  // the lifetime of the connection and completes only when the connection closes.
  void (async () => {
    for await (const status of connection.status()) {
      switch (status.type) {
        case 'disconnect':
          logger.warn({ status }, 'NATS disconnected — buffering and retrying');
          break;
        case 'reconnect':
          logger.info({ status }, 'NATS reconnected');
          break;
        case 'error':
          logger.error({ status }, 'NATS protocol error');
          break;
        case 'staleConnection':
          logger.warn({ status }, 'NATS connection went stale');
          break;
        default:
          logger.debug({ status }, 'NATS status event');
      }
    }
  })();

  return connection;
}

/**
 * Close the connection cleanly.
 *
 * `drain()` rather than `close()`: drain flushes pending publishes and lets
 * in-flight subscription handlers finish before the socket goes away. Calling
 * `close()` on shutdown is how you lose the last few messages and leave
 * consumers with unacked work.
 */
export async function closeNats(connection: NatsConnection, logger: Logger): Promise<void> {
  try {
    await connection.drain();
    logger.info('NATS connection drained and closed');
  } catch (error) {
    logger.error({ err: error }, 'failed to drain NATS connection');
    await connection.close();
  }
}
