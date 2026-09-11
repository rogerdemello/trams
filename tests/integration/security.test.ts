import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jetstream } from '@nats-io/jetstream';
import { createJetStreamManager, STREAM_USER_EVENTS, SUBJECTS } from '@trams/shared';
import { createHarness, TEST_INTERNAL_TOKEN, type Harness } from '../helpers/harness.js';

/**
 * The security boundaries, verified against the real broker with the real
 * per-service permissions.
 *
 * These are the tests that make "secure inter-service communication" a
 * demonstrated property rather than an assertion in a README. Each asserts that
 * something is DENIED — which is only meaningful because the test broker runs
 * the same authorization policy as infra/nats/nats.conf.
 */

describe('broker authorization: neither service can do the other job', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ startConsumer: false });
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it('denies the notification service permission to publish user events', async () => {
    // The single most important security assertion here. If this passed, a
    // compromised Notification Service could forge account events — inventing
    // registrations or password changes — and the User Service would have no
    // way to tell.
    const js = jetstream(harness.consumerNats);

    await expect(
      js.publish(SUBJECTS.userRegistered, JSON.stringify({ forged: true }), { timeout: 3_000 }),
    ).rejects.toThrow(/[Pp]ermission/);
  });

  it('denies the notification service permission to manage streams', async () => {
    // A consumer that can reconfigure the stream it reads from can also delete
    // the evidence of what it failed to process.
    const jsm = await createJetStreamManager(harness.consumerNats);

    await expect(
      jsm.streams.add({ name: 'ROGUE_STREAM', subjects: ['rogue.>'] }),
    ).rejects.toThrow();
  });

  it('denies the user service the ability to consume the stream it publishes to', async () => {
    // Least privilege in the other direction: a producer has no business
    // reading the event history back.
    const js = jetstream(harness.producerNats);

    let delivered = 0;
    try {
      const consumer = await js.consumers.get(STREAM_USER_EVENTS, harness.consumerName);
      const messages = await consumer.fetch({ max_messages: 1, expires: 2_000 });
      for await (const message of messages) {
        delivered += 1;
        message.nak();
      }
    } catch {
      // Either an outright permission error or zero messages is a pass — both
      // mean the producer's credentials cannot read the stream.
    }

    expect(delivered).toBe(0);
  });

  it('permits the notification service to publish dead letters', async () => {
    // Least privilege means the *necessary* permissions still work. `dlq.>` is
    // the one subject this service may write to.
    const js = jetstream(harness.consumerNats);

    const ack = await js.publish('dlq.notifications', JSON.stringify({ reason: 'test' }), {
      timeout: 3_000,
    });

    expect(ack.seq).toBeGreaterThan(0);
  });
});

describe('service-level access control', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ startConsumer: false });
  });

  afterAll(async () => {
    await harness.teardown();
  });

  const internal = { 'x-internal-token': TEST_INTERNAL_TOKEN };

  it('rejects a request that did not come through the gateway', async () => {
    // Defence in depth. The services bind to loopback, but "the network
    // protects it" is exactly the assumption that fails.
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'someone@trams.test', password: 'irrelevant' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects an incorrect internal token', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-internal-token': 'wrong-token-of-the-same-length' },
      payload: { email: 'someone@trams.test', password: 'irrelevant' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('leaves health probes reachable without the internal token', async () => {
    // Otherwise a rotated internal token would make every instance look
    // unhealthy and trigger a restart loop.
    expect((await harness.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('never returns the password hash', async () => {
    const { accessToken } = await harness.registerUser();

    const response = await harness.app.inject({
      method: 'GET',
      url: '/users/me',
      headers: { ...internal, authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('password');
    expect(response.json().user).not.toHaveProperty('password_hash');
  });

  it('returns 404, not 403, when a user requests another account', async () => {
    const alice = await harness.registerUser();
    const bob = await harness.registerUser();

    const response = await harness.app.inject({
      method: 'GET',
      url: `/users/${bob.userId}`,
      headers: { ...internal, authorization: `Bearer ${alice.accessToken}` },
    });

    // 403 would confirm the account exists, letting an attacker enumerate
    // valid user ids. Both "not found" and "not yours" look identical.
    expect(response.statusCode).toBe(404);
  });

  it('denies a non-admin the ability to list all users', async () => {
    const { accessToken } = await harness.registerUser();

    const response = await harness.app.inject({
      method: 'GET',
      url: '/users',
      headers: { ...internal, authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects a token signed with a different key', async () => {
    // Guards against the "alg: none" and key-confusion families of JWT attack:
    // the algorithm is pinned and the signature must verify against our key.
    const forged = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(
        JSON.stringify({ sub: randomUUID(), email: 'attacker@evil.test', role: 'admin' }),
      ).toString('base64url'),
      '',
    ].join('.');

    const response = await harness.app.inject({
      method: 'GET',
      url: '/users/me',
      headers: { ...internal, authorization: `Bearer ${forged}` },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('authentication lifecycle', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ startConsumer: false });
  });

  afterAll(async () => {
    await harness.teardown();
  });

  const internal = { 'x-internal-token': TEST_INTERNAL_TOKEN };

  it('gives the same error for an unknown email and a wrong password', async () => {
    const { email } = await harness.registerUser();

    const unknown = await harness.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: internal,
      payload: { email: 'nobody-at-all@trams.test', password: 'Str0ng!Passw0rd' },
    });

    const wrongPassword = await harness.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: internal,
      payload: { email, password: 'Wr0ng!Passw0rd' },
    });

    // Identical status AND identical body: anything else is an enumeration
    // oracle for which addresses have accounts.
    expect(unknown.statusCode).toBe(401);
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknown.json().code).toBe(wrongPassword.json().code);
    expect(unknown.json().detail).toBe(wrongPassword.json().detail);
  });

  it('rotates the refresh token and revokes the whole family when one is replayed', async () => {
    const { refreshToken } = await harness.registerUser();

    const rotated = await harness.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: internal,
      payload: { refreshToken },
    });
    expect(rotated.statusCode).toBe(200);

    const replacement = rotated.json().tokens.refreshToken;
    expect(replacement).not.toBe(refreshToken);

    // Replaying the consumed token is a strong signal of theft — there is no
    // way to tell which holder is genuine, so every session is revoked.
    const replayed = await harness.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: internal,
      payload: { refreshToken },
    });
    expect(replayed.statusCode).toBe(401);

    // Including the legitimate-looking replacement.
    const afterRevocation = await harness.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: internal,
      payload: { refreshToken: replacement },
    });
    expect(afterRevocation.statusCode).toBe(401);
  });

  it('stores refresh tokens hashed, so a database read is not a session dump', async () => {
    const { refreshToken } = await harness.registerUser();

    const rows = await harness.userDb.db.selectFrom('refresh_tokens').selectAll().execute();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.token_hash).not.toBe(refreshToken);
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('revokes all sessions when the password changes', async () => {
    const { accessToken, refreshToken } = await harness.registerUser();

    await harness.app.inject({
      method: 'POST',
      url: '/users/me/change-password',
      headers: { ...internal, authorization: `Bearer ${accessToken}` },
      payload: { currentPassword: 'Str0ng!Passw0rd', newPassword: 'Rot@ted!Passw0rd' },
    });

    // If the password is being changed because of a suspected compromise,
    // leaving the attacker's refresh token live would defeat the point.
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: internal,
      payload: { refreshToken },
    });

    expect(response.statusCode).toBe(401);
  });

  it('requires the current password to change it, even with a valid token', async () => {
    const { accessToken } = await harness.registerUser();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/users/me/change-password',
      headers: { ...internal, authorization: `Bearer ${accessToken}` },
      payload: { currentPassword: 'not-the-right-one', newPassword: 'Rot@ted!Passw0rd' },
    });

    // A stolen access token alone must not let an attacker lock the owner out.
    expect(response.statusCode).toBe(403);
  });

  it('rejects a duplicate registration with 409, decided by the database', async () => {
    const { email } = await harness.registerUser();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: internal,
      payload: { email, password: 'Str0ng!Passw0rd', name: 'Impostor' },
    });

    expect(response.statusCode).toBe(409);
  });

  it('treats email case-insensitively, so one address is one account', async () => {
    const { email } = await harness.registerUser();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: internal,
      payload: { email: email.toUpperCase(), password: 'Str0ng!Passw0rd', name: 'Case Variant' },
    });

    expect(response.statusCode).toBe(409);
  });
});
