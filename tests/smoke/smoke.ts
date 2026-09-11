#!/usr/bin/env tsx
/**
 * End-to-end smoke test against a running system.
 *
 * Unlike the integration suite, this talks to the real gateway over HTTP with
 * nothing stubbed — three separate processes, a real broker, real TLS. It is
 * the check that answers "is the deployed system actually working?" and it is
 * what a reviewer should run after `npm run dev`.
 *
 * The assertion that matters is the asynchronous one: after registering a user
 * through the public API, a notification must appear without anything having
 * called the Notification Service directly. That is the whole architecture in
 * one observation.
 *
 *   npm run smoke
 */

import { randomUUID } from 'node:crypto';

const GATEWAY = process.env['SMOKE_GATEWAY_URL'] ?? 'http://127.0.0.1:8080';
const API = `${GATEWAY}/api/v1`;

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  [32mPASS[0m  ${label}`);
  } else {
    failed += 1;
    console.log(`  [31mFAIL[0m  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n[1m${title}[0m`);
}

interface HttpResult {
  status: number;
  body: unknown;
  headers: Headers;
}

async function http(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; correlationId?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  // Only declare a JSON content-type when there is actually a body. Sending
  // `content-type: application/json` with an empty body is a malformed request
  // and Fastify rightly rejects it with a 400 — a real client must not do this
  // on a bodyless DELETE or GET.
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers['authorization'] = `Bearer ${options.token}`;
  if (options.correlationId) headers['x-correlation-id'] = options.correlationId;

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep the raw text */
  }

  return { status: response.status, body, headers: response.headers };
}

/** Poll until the predicate holds — the async path needs time to complete. */
async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`        (timed out after ${timeoutMs}ms waiting for ${label})`);
  return false;
}

async function main(): Promise<void> {
  console.log(`\n[1mTrams smoke test[0m  →  ${GATEWAY}\n`);

  // ── Reachability ───────────────────────────────────────────────────────────
  section('1. System is up');

  // /health and /ready sit at the gateway root, not under the /api/v1 prefix —
  // they are operational endpoints, not part of the public API surface.
  const health = await fetch(`${GATEWAY}/health`);
  const ready = await fetch(`${GATEWAY}/ready`);
  const readyBody = (await ready.json()) as {
    status: string;
    checks: Array<{ name: string; status: string }>;
  };

  check('gateway responds to /health', health.status === 200);
  check(
    'gateway /ready confirms both backends are reachable',
    ready.status === 200 && readyBody.checks.every((c) => c.status === 'ok'),
    JSON.stringify(readyBody),
  );

  // ── Registration ───────────────────────────────────────────────────────────
  section('2. Registration through the public API');

  const correlationId = `smoke-${randomUUID()}`;
  const email = `smoke-${randomUUID().slice(0, 8)}@trams.test`;
  const password = 'Sm0ke!TestPassw0rd';

  const registered = await http('POST', '/auth/register', {
    body: { email, password, name: 'Smoke Test' },
    correlationId,
  });

  const registerBody = registered.body as {
    user?: { id: string; email: string; role: string };
    tokens?: { accessToken: string; refreshToken: string };
  };

  check('register returns 201', registered.status === 201, JSON.stringify(registered.body));
  check('response contains the created user', registerBody.user?.email === email);
  check(
    'password hash is never returned',
    !JSON.stringify(registered.body).includes('password_hash'),
  );
  check(
    'correlation id is echoed back for tracing',
    registered.headers.get('x-correlation-id') === correlationId,
  );

  if (!registerBody.tokens) {
    console.log('\n  Cannot continue without tokens — aborting.\n');
    process.exit(1);
  }

  const { accessToken, refreshToken } = registerBody.tokens;
  const userId = registerBody.user!.id;

  // ── The asynchronous event path ────────────────────────────────────────────
  section('3. The event path: outbox → JetStream → consumer');
  console.log('   (nothing called the Notification Service directly)');

  const notified = await waitFor('welcome notification', async () => {
    const result = await http('GET', '/notifications', { token: accessToken });
    const body = result.body as { notifications?: Array<{ eventType: string; status: string }> };
    return (
      body.notifications?.some((n) => n.eventType === 'user.registered' && n.status === 'sent') ??
      false
    );
  });

  check('a welcome notification was delivered asynchronously', notified);

  const notifications = await http('GET', '/notifications', { token: accessToken });
  const notificationBody = notifications.body as {
    notifications: Array<{
      eventType: string;
      recipient: string;
      subject: string;
      correlationId: string;
      channel: string;
      status: string;
    }>;
  };
  const welcome = notificationBody.notifications?.find((n) => n.eventType === 'user.registered');

  check('notification was addressed to the registered user', welcome?.recipient === email);
  check('notification has a rendered subject', welcome?.subject === 'Welcome to Trams');
  check(
    'correlation id survived the whole path, including the broker hop',
    welcome?.correlationId === correlationId,
    `expected ${correlationId}, got ${welcome?.correlationId}`,
  );

  // ── Authentication ─────────────────────────────────────────────────────────
  section('4. Authentication and authorization');

  const noToken = await http('GET', '/users/me');
  check('unauthenticated request is rejected', noToken.status === 401);

  const badToken = await http('GET', '/users/me', { token: 'not.a.real.jwt' });
  check('forged token is rejected', badToken.status === 401);

  const me = await http('GET', '/users/me', { token: accessToken });
  check('authenticated request succeeds', me.status === 200);

  const notAdmin = await http('GET', '/users', { token: accessToken });
  check('non-admin cannot list all users', notAdmin.status === 403);

  const wrongPassword = await http('POST', '/auth/login', {
    body: { email, password: 'Wr0ng!Passw0rd' },
  });
  const unknownUser = await http('POST', '/auth/login', {
    body: { email: 'nobody-here@trams.test', password: 'Wr0ng!Passw0rd' },
  });
  const wrongBody = wrongPassword.body as { code?: string };
  const unknownBody = unknownUser.body as { code?: string };
  check(
    'unknown email and wrong password are indistinguishable (no account enumeration)',
    wrongPassword.status === unknownUser.status && wrongBody.code === unknownBody.code,
  );

  // ── Refresh rotation ───────────────────────────────────────────────────────
  section('5. Refresh token rotation');

  const rotated = await http('POST', '/auth/refresh', { body: { refreshToken } });
  const rotatedBody = rotated.body as { tokens?: { refreshToken: string } };
  check('refresh succeeds', rotated.status === 200);
  check('a new refresh token is issued', rotatedBody.tokens?.refreshToken !== refreshToken);

  const replayed = await http('POST', '/auth/refresh', { body: { refreshToken } });
  check('replaying a consumed refresh token is rejected', replayed.status === 401);

  // ── Further event types ────────────────────────────────────────────────────
  section('6. Profile update produces its own notification');

  await http('PATCH', '/users/me', { token: accessToken, body: { name: 'Smoke Renamed' } });

  const updateNotified = await waitFor('update notification', async () => {
    const result = await http('GET', '/notifications', { token: accessToken });
    const body = result.body as { notifications?: Array<{ eventType: string }> };
    return body.notifications?.some((n) => n.eventType === 'user.updated') ?? false;
  });

  check('user.updated produced a notification', updateNotified);

  // ── Validation and error shape ──────────────────────────────────────────────
  section('7. Validation and error contract');

  const invalid = await http('POST', '/auth/register', {
    body: { email: 'not-an-email', password: 'short', name: '' },
  });
  const invalidBody = invalid.body as {
    code?: string;
    errors?: Array<{ path: string; message: string }>;
    correlationId?: string;
  };

  check('invalid input returns 400', invalid.status === 400);
  check('errors identify the offending fields', (invalidBody.errors?.length ?? 0) >= 3);
  check('error carries a correlation id', Boolean(invalidBody.correlationId));

  const missing = await http('GET', '/no-such-route');
  check('unknown route returns a structured 404', missing.status === 404);

  const duplicate = await http('POST', '/auth/register', {
    body: { email, password, name: 'Duplicate' },
  });
  check('duplicate email returns 409', duplicate.status === 409);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  section('8. Account deletion');

  const deleted = await http('DELETE', '/users/me', { token: accessToken });
  check(
    'account is deleted',
    deleted.status === 204,
    `got ${deleted.status}: ${JSON.stringify(deleted.body)}`,
  );

  /**
   * The deletion notification is the most interesting one in the whole flow.
   *
   * It is delivered AFTER the user row is gone. The consumer never queries the
   * User Service, so the event payload had to carry the email and name with it
   * — and it did. A request/response design would have had nothing left to look
   * up by the time it tried.
   *
   * The access token is still cryptographically valid for its remaining TTL,
   * so it can still read the notification history of the account it deleted.
   */
  const deletionNotified = await waitFor('deletion notification', async () => {
    const result = await http('GET', '/notifications', { token: accessToken });
    const body = result.body as { notifications?: Array<{ eventType: string }> };
    return body.notifications?.some((n) => n.eventType === 'user.deleted') ?? false;
  });

  check(
    'user.deleted was notified even though the user record is gone',
    deletionNotified,
    'the event payload must be self-contained for this to work',
  );
  console.log(`        (user ${userId.slice(0, 8)}… removed; its notifications remain on record)`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n[1mResult:[0m ${passed} passed, ${failed} failed  (${passed + failed} checks)\n`);

  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(
    `\n[31mSmoke test could not run.[0m\n` +
      `${error instanceof Error ? error.message : String(error)}\n\n` +
      `Is the system running? Start it with:\n` +
      `  npm run nats     (in one terminal)\n` +
      `  npm run dev      (in another)\n`,
  );
  process.exit(1);
});
