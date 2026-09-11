import { startTestBroker, TEST_NATS_USERS, type TestBroker } from './nats-server.js';

/**
 * One broker for the whole integration suite.
 *
 * Starting a nats-server per test file would add seconds per file and risk port
 * exhaustion. A single broker is shared, and each test isolates itself by using
 * unique event ids and its own in-memory databases — which is also closer to
 * reality, where many workers share one broker.
 */

let broker: TestBroker | undefined;

export async function setup(): Promise<void> {
  broker = await startTestBroker();

  // Published to the test processes through the environment. Every service in
  // this codebase reads its configuration from env, so pointing the suite at
  // the test broker needs no special test-only code path in the services
  // themselves.
  process.env['NATS_URL'] = broker.url;
  process.env['NATS_USER_SERVICE_USER'] = TEST_NATS_USERS.userService.user;
  process.env['NATS_USER_SERVICE_PASS'] = TEST_NATS_USERS.userService.pass;
  process.env['NATS_NOTIFICATION_SERVICE_USER'] = TEST_NATS_USERS.notificationService.user;
  process.env['NATS_NOTIFICATION_SERVICE_PASS'] = TEST_NATS_USERS.notificationService.pass;
  // Harness-only, for purging the stream between tests. See TEST_NATS_USERS.
  process.env['TEST_ADMIN_USER'] = TEST_NATS_USERS.testAdmin.user;
  process.env['TEST_ADMIN_PASS'] = TEST_NATS_USERS.testAdmin.pass;
  process.env['NATS_TLS_ENABLED'] = 'true';
  process.env['DB_CLIENT'] = 'sqlite';
  process.env['USER_DB_URL'] = ':memory:';
  process.env['NOTIFICATION_DB_URL'] = ':memory:';
  process.env['LOG_LEVEL'] = 'silent';
  process.env['NODE_ENV'] = 'test';

  console.log(`\n  integration broker: ${broker.url} (TLS + per-service permissions)\n`);
}

export async function teardown(): Promise<void> {
  await broker?.stop();
}
