# Trams

An event-driven microservices system: **API Gateway**, **User Service**, and
**Notification Service**. The two backend services communicate exclusively over
**NATS JetStream** — no REST, no WebSockets, no shared database.

Built for the internship assignment in [`docs/assignment.md`](docs/assignment.md).
The engineering plan is in [`plan.md`](plan.md).

```
Client ──HTTPS──► API Gateway ──internal HTTP──► User Service
                       │                              │
                       │                        PUBLISH ONLY
                       │                              ▼
                       │                    NATS JetStream (mTLS)
                       │                     stream USER_EVENTS
                       │                              │
                       │                       SUBSCRIBE ONLY
                       └──internal HTTP──► Notification Service
```

---

## Quick start

No Docker required. Roughly two minutes from clone to a working system.

```bash
# 1. Install nats-server (one time)
scoop install nats-server        # Windows
brew install nats-server         # macOS
# Linux: https://github.com/nats-io/nats-server/releases

# 2. Install and configure
npm install
cp .env.example .env

# 3. Generate TLS certificates and the JWT key pair, then migrate
npm run bootstrap

# 4. Start the broker (leave running)
npm run nats

# 5. In a second terminal — start all three services
npm run dev
```

Then, in a third terminal:

```bash
npm run smoke
```

That runs 29 end-to-end checks against the live system, including the one that
matters most: registering a user through the public API causes a notification to
appear **without anything having called the Notification Service directly**.

<details>
<summary>Expected output</summary>

```
Trams smoke test  →  http://127.0.0.1:8080

1. System is up
  PASS  gateway responds to /health
  PASS  gateway /ready confirms both backends are reachable

2. Registration through the public API
  PASS  register returns 201
  PASS  response contains the created user
  PASS  password hash is never returned
  PASS  correlation id is echoed back for tracing

3. The event path: outbox → JetStream → consumer
   (nothing called the Notification Service directly)
  PASS  a welcome notification was delivered asynchronously
  PASS  notification was addressed to the registered user
  PASS  notification has a rendered subject
  PASS  correlation id survived the whole path, including the broker hop
...
Result: 29 passed, 0 failed  (29 checks)
```

</details>

### With Docker

```bash
npm run bootstrap                # still needed: generates certs and keys
docker compose up --build
```

This runs the **Postgres** path (the native flow above uses SQLite). One Kysely
query layer serves both dialects, so exercising both is how the abstraction is
kept honest.

> **Disclosure:** Docker is not installed on the machine this was built on, so
> the compose path has been written and reviewed but **not executed**. The
> native path above has been run end to end many times. A second review pass
> corrected four defects in the compose path — broker config paths that did not
> match their mounts, a JetStream volume mounted where the config never looked,
> a migration job missing environment the config schema requires in production,
> and an image that did not ship the migration script. Reviewed twice is still
> not the same as run once: treat the native path as the verified one.

---

## Try it by hand

```bash
API=http://localhost:8080/api/v1

# Start here. The API root lists every endpoint, how to authenticate, and where
# the docs are — so you never have to guess a path.
curl -s $API | jq

# Register — note the correlation id, which we will follow through the system
curl -s -X POST $API/auth/register \
  -H 'content-type: application/json' \
  -H 'x-correlation-id: demo-001' \
  -d '{"email":"ada@example.com","password":"Str0ng!Passw0rd","name":"Ada Lovelace"}' | jq

ACCESS=$(curl -s -X POST $API/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"Str0ng!Passw0rd"}' | jq -r .tokens.accessToken)

# The notification arrived over the broker, carrying the same correlation id
curl -s $API/notifications -H "authorization: Bearer $ACCESS" | jq '.notifications[0]'
```

In the `npm run dev` output you will see the whole path, tied together by
`demo-001`:

```
[user] outbox event published        eventId=354feb… correlationId=demo-001
[notif] NOTIFICATION → ada@example.com: Welcome to Trams   correlationId=demo-001
[notif] notification delivered       eventType=user.registered attempts=1
```

Full endpoint reference: [`docs/api.md`](docs/api.md) ·
OpenAPI: [`docs/openapi.yaml`](docs/openapi.yaml)

---

## Prove the guarantees

The interesting claims are about failure, so they are worth checking rather than
believing. Each of these is also covered by an automated test.

### 1. A broker outage loses nothing

```bash
# With everything running, kill the broker
#   Windows:  Get-Process nats-server | Stop-Process -Force
#   Unix:     pkill nats-server

curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"bob@example.com","password":"Str0ng!Passw0rd","name":"Bob"}'
# → 201   the request succeeds even though the broker is gone
```

The event is sitting in the outbox:

```bash
node -e "const D=require('better-sqlite3');const db=new D('./data/user-service.db',{readonly:true});
console.log(db.prepare('SELECT event_type,status,attempts FROM outbox_events').all())"
# → [{ event_type: 'user.registered', status: 'pending', attempts: 0 }]
```

Restart the broker with `npm run nats`, wait a few seconds, and re-run the query:

```
→ [{ event_type: 'user.registered', status: 'published', attempts: 4 }]
```

It published itself after four backoff retries, with no intervention. **Zero
events lost.** This is the transactional outbox — see
[architecture.md §3](docs/architecture.md#3-reliability-the-transactional-outbox)
for why the naive `insert(); publish();` cannot achieve this.

### 2. A duplicate event sends one notification

JetStream guarantees _at-least-once_ delivery, so the same event will arrive
twice. `tests/integration/event-flow.test.ts` publishes three copies of one
event (with different broker message ids, so the broker's own deduplication
cannot mask the problem) and asserts exactly one notification is sent.

The guard is a `UNIQUE` index on `notifications.event_id` — a database
constraint, not an `if (alreadyProcessed)` check, because the latter is a race
that two replicas eventually lose.

### 3. A poison message is quarantined, not retried forever

Publish something malformed and it lands in the dead-letter queue on the
**first** attempt, because it can never succeed:

```bash
curl -s "$API/notifications/dead-letters" -H "authorization: Bearer $ADMIN_TOKEN" | jq
# → reason: "schema violation: type: Invalid discriminator value…"
#   delivery_count: 1        ← not retried, correct for a permanent failure
```

A _transient_ failure behaves differently: it is retried with backoff and only
dead-lettered once the budget is exhausted (`reason: "retries exhausted…"`).
Distinguishing the two is the difference between wasting the retry budget on
something hopeless and discarding something recoverable.

### 4. Neither service can do the other's job

The broker enforces this, not convention:

```bash
npm run test:integration -- security
```

```
✓ denies the notification service permission to publish user events
✓ denies the notification service permission to manage streams
✓ denies the user service the ability to consume the stream it publishes to
✓ permits the notification service to publish dead letters
```

The first assertion fails with `Permissions Violation for Publish to
"user.registered"` — a compromised Notification Service **cannot forge account
events.** See [security.md §3](docs/security.md#3-broker-authorization-in-detail).

---

## Tests

```bash
npm test               # 105 tests: 75 unit + 30 integration
npm run test:unit      # fast, no dependencies
npm run test:integration   # boots a real nats-server with real mTLS
npm run typecheck      # all projects, plus the test suite and infra scripts
npm run lint           # eslint, zero warnings
npm run smoke          # 29 end-to-end checks against a running system
```

The integration suite **does not mock the broker**. Every guarantee being
tested — idempotency, redelivery, ack semantics, dead lettering — is a property
of JetStream, so a mock would encode my assumptions about JetStream and then
confirm them. It spins up a real `nats-server` with the same TLS configuration
and the same per-service permissions as production; several tests assert that an
operation is _denied_, which is only meaningful against the real policy.

Current state: **105 passing**, clean typecheck, zero lint warnings.

---

## How it works

Three ideas carry the design. Full detail in
[`docs/architecture.md`](docs/architecture.md).

### Transactional outbox — why events cannot be lost

The obvious implementation has an unfixable gap:

```ts
await db.insertUser(user);
await broker.publish(event); // ← process dies here and the event is gone forever
```

No transaction spans a database and a broker, so no amount of retry logic
_around_ the publish closes it. Instead, the event is written to a table in the
**same transaction** as the user:

```ts
await db.transaction().execute(async (trx) => {
  await users.insert(trx, user);
  await outbox.enqueue(trx, event); // atomic with the line above
});
```

A background publisher drains that table. Broker downtime therefore never fails
a user request, and delivery becomes at-least-once rather than at-most-once —
the right trade, because a duplicate is recoverable at the consumer while a lost
event is recoverable nowhere.

### Idempotency — why duplicates are harmless

At-least-once delivery shifts the burden to the consumer. It claims each event
by inserting a row with a `UNIQUE` index on `event_id` before delivering. Exactly
one worker wins the insert regardless of how many copies arrive or how many
replicas are running, so a redelivered event is acknowledged **without**
re-sending.

_One honest caveat:_ a crash between "email sent" and "row marked sent" can
still duplicate. Closing that needs a distributed transaction across the
database and the mail server, which does not exist. The design takes the safe
side — a rare duplicate over a silent omission — and says so rather than
claiming exactly-once.

### Layered security on the broker

TLS alone gives you an encrypted pipe to a broker that will then let any
authenticated client publish anything. So there are two independent layers:

1. **mutual TLS** proves _fleet membership_ — "a legitimate Trams service".
2. **per-service subject permissions** prove _role_ — "which service, and what
   it may do".

| Service                | Publish                        | Subscribe  | Cannot                           |
| ---------------------- | ------------------------------ | ---------- | -------------------------------- |
| `user-service`         | `user.>` + stream provisioning | `_INBOX.>` | read the stream back             |
| `notification-service` | `dlq.>` + acks                 | `_INBOX.>` | publish `user.*`, manage streams |

Also: **RS256, not HS256.** With a symmetric secret, anything that can verify a
token can mint one. The gateway — the internet-facing component, and so the most
likely to be compromised — holds only the public key.

---

## Project layout

```
packages/shared/          the event contract + what both services agree on
  events/                 envelope, per-type zod schemas, subject constants
  nats/                   connect · streams · publisher · consumer runtime
  db/                     Kysely schema, dialect factory, migrations
  http/                   correlation · error handler · health · auth guards
  auth/                   AccessTokenVerifier (public key only)
  config.ts               zod-validated env, fail-fast at boot
services/user-service/    owns identity; produces events via the outbox
services/notification-service/  consumes events; delivers notifications
services/api-gateway/     the only public listener
infra/nats/nats.conf      TLS + per-service subject permissions
infra/scripts/            cert generation, key generation, migrations
tests/{unit,integration,smoke}/
docs/                     architecture · api · security · openapi · assignment
```

The monorepo exists for one reason: **the event contract is a shared artifact.**
If each service kept its own copy of the message shape they would drift, and the
first schema change would break the consumer at runtime with no warning. One
module imported by both makes a mismatch a compile error.

---

## Configuration

Every value is read from the environment through a zod-validated loader
([`packages/shared/src/config.ts`](packages/shared/src/config.ts)). See
[`.env.example`](.env.example) for the annotated full list.

When `NODE_ENV=production`, **development fallbacks are disabled entirely** — a
missing secret stops the process on line one rather than degrading to a
well-known default. That is the worst class of vulnerability precisely because
everything appears to work.

The values worth knowing:

| Variable                   | Default   | Notes                                                |
| -------------------------- | --------- | ---------------------------------------------------- |
| `DB_CLIENT`                | `sqlite`  | `sqlite` \| `postgres` — same query layer either way |
| `NOTIFICATION_CHANNEL`     | `console` | `console` \| `smtp`                                  |
| `NATS_TLS_ENABLED`         | `true`    | Set `false` only to run against a plain local broker |
| `ACCESS_TOKEN_TTL`         | `15m`     | Bounds the damage from a stolen access token         |
| `REFRESH_TOKEN_TTL_DAYS`   | `7`       | Rotated on every use; reuse revokes the family       |
| `NOTIFICATION_MAX_DELIVER` | `5`       | Attempts before a message is dead-lettered           |
| `AUTH_RATE_LIMIT_MAX`      | `10`      | Per minute per IP on `/auth/*`                       |
| `OUTBOX_POLL_INTERVAL_MS`  | `1000`    | How quickly staged events are published              |

Real emails, via a local catcher:

```bash
NOTIFICATION_CHANNEL=smtp docker compose --profile mail up   # UI at :8025
```

---

## Scripts

| Command                                 | Purpose                                              |
| --------------------------------------- | ---------------------------------------------------- |
| `npm run bootstrap`                     | Certs + JWT keys + migrations (run once after clone) |
| `npm run nats`                          | Start the broker with the project's TLS config       |
| `npm run dev`                           | All three services with hot reload                   |
| `npm run build` / `start`               | Compile, then run the built output                   |
| `npm test`                              | Unit then integration                                |
| `npm run smoke`                         | End-to-end checks against a running system           |
| `npm run typecheck` / `lint` / `format` | Quality gates                                        |
| `npm run certs -- --force`              | Regenerate TLS certificates                          |
| `npm run keys -- --force`               | Regenerate JWT keys (invalidates all tokens)         |

---

## Known limitations

Stated up front rather than left to be discovered. Reasoning for each is in
[security.md §4](docs/security.md#4-known-limitations) and
[architecture.md](docs/architecture.md).

- **Development credentials are committed** in `nats.conf` and `.env.example`,
  so the project runs on clone. They are placeholders, not secrets, and must not
  be deployed. Production should use bcrypt hashes or NATS NKEY/JWT auth.
- **Both services share one client certificate** in development. mTLS
  establishes fleet identity; the per-service credentials establish role. Issue
  a certificate per service in production.
- **Rate limiting is per-instance and in-memory**, so N gateway replicas give N×
  the configured limit. A shared Redis store is the standard fix.
- **The exactly-once window** described above.
- **Migrations run at service boot** for convenience. With multiple replicas
  this belongs in a release step; `docker-compose.yml` already models it that
  way with a one-shot `migrate` job.
- **The outbox publisher is sequential** per instance, to preserve per-user
  event ordering. Throughput scales with replicas; Postgres `SKIP LOCKED` would
  remove the duplicated work between them.
- **No audit log.** Security events are logged but not written to a
  tamper-resistant queryable table.
- **`docker compose` is unverified** — no Docker on the build machine. It has
  been reviewed line by line twice and the second pass found four real defects,
  which is the honest argument for why review is not a substitute for running
  it. Every claim made elsewhere in this README is from the native path.

---

## Assignment requirements

| Requirement                                | Where                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| Two services + API Gateway                 | `services/`                                                              |
| No REST or WebSockets between the services | Only edge is JetStream; asserted in `tests/integration/security.test.ts` |
| Secure communication                       | mTLS + per-service subject permissions ([security.md](docs/security.md)) |
| Reliable delivery                          | Transactional outbox + durable consumer + idempotency + DLQ              |
| Production-ready                           | Graceful shutdown, health/readiness, backoff, fail-fast config           |
| Asynchronous                               | Producer never waits on the consumer; `201` returns before any publish   |
| Clean, scalable architecture               | Shared contract, layered services, repository pattern                    |
| Authentication and security                | argon2id, RS256, rotating refresh tokens, edge hardening                 |
| Error handling and validation              | zod at every boundary; RFC 9457 problem+json                             |
| Secrets in environment variables           | zod-validated loader; no defaults in production                          |
| README with setup instructions             | this file                                                                |
| Architecture diagram                       | [`docs/architecture.md`](docs/architecture.md) (mermaid)                 |
| API documentation                          | [`docs/api.md`](docs/api.md) + [`docs/openapi.yaml`](docs/openapi.yaml)  |
| Instructions to run locally                | [Quick start](#quick-start)                                              |
