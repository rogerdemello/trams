# API reference

Base URL: `http://localhost:8080/api/v1`

Everything below goes through the **API Gateway**, which is the only publicly
reachable component. The backend services listen on loopback and reject any
request that did not arrive via the gateway.

A machine-readable version of this surface is in
[`openapi.yaml`](openapi.yaml).

---

## Conventions

**Authentication.** Send the access token as a bearer token:

```
Authorization: Bearer <accessToken>
```

Access tokens expire after 15 minutes. Use `POST /auth/refresh` to obtain a new
pair rather than re-sending credentials.

**Correlation.** Optionally send `X-Correlation-Id`. If you do not, the gateway
mints one. It is echoed on every response and threaded through both services
_and the broker_, so a single id traces a request end to end — including the
asynchronous notification it triggered. Quote it in any bug report.

**Errors** follow RFC 9457 `application/problem+json`:

```json
{
  "type": "https://trams.local/errors/validation-error",
  "title": "Validation Failed",
  "status": 400,
  "code": "VALIDATION_ERROR",
  "detail": "Request validation failed",
  "errors": [{ "path": "email", "message": "Must be a valid email address" }],
  "correlationId": "0b7c...e91"
}
```

Branch on `code`, never on `detail` or `title` — those are free to change.

| `code`                 | Status | Meaning                                                      |
| ---------------------- | ------ | ------------------------------------------------------------ |
| `VALIDATION_ERROR`     | 400    | Malformed input; see `errors[]`                              |
| `UNAUTHORIZED`         | 401    | Missing or malformed credentials                             |
| `INVALID_CREDENTIALS`  | 401    | Wrong email **or** password (deliberately indistinguishable) |
| `TOKEN_EXPIRED`        | 401    | Access token expired — refresh                               |
| `TOKEN_INVALID`        | 401    | Token bad or refresh token already used — sign in again      |
| `FORBIDDEN`            | 403    | Authenticated but not permitted                              |
| `NOT_FOUND`            | 404    | Absent, or not yours (the two are not distinguished)         |
| `CONFLICT`             | 409    | Email already registered                                     |
| `RATE_LIMITED`         | 429    | Too many requests                                            |
| `UPSTREAM_UNAVAILABLE` | 503    | A backend service is unreachable                             |
| `INTERNAL_ERROR`       | 500    | Unexpected; quote the `correlationId`                        |

**Rate limits** (per IP, defaults):

| Scope           | Limit        |
| --------------- | ------------ |
| `/auth/*`       | 10 / minute  |
| everything else | 100 / minute |

Auth endpoints are limited far more tightly because they are the ones worth
attacking.

---

## Operational endpoints

Outside `/api/v1`, on every component (`:8080`, `:4001`, `:4002`):

| Method | Path      | Description                                                  |
| ------ | --------- | ------------------------------------------------------------ |
| `GET`  | `/health` | Liveness. Answers from memory; touches nothing.              |
| `GET`  | `/ready`  | Readiness. Probes real dependencies. `503` when any is down. |

Deliberately separate: a dependency blip should remove an instance from the load
balancer, not restart a healthy process.

```bash
curl -s localhost:8080/ready | jq
```

```json
{
  "status": "ready",
  "service": "api-gateway",
  "checks": [
    { "name": "user-service", "status": "ok" },
    { "name": "notification-service", "status": "ok" }
  ]
}
```

---

## Authentication

### `POST /auth/register`

Creates an account and **emits `user.registered`**, which produces a welcome
notification asynchronously.

```bash
curl -X POST localhost:8080/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"Str0ng!Passw0rd","name":"Ada Lovelace"}'
```

| Field      | Rules                                                                                   |
| ---------- | --------------------------------------------------------------------------------------- |
| `email`    | Valid address, ≤ 254 chars, lowercased and trimmed                                      |
| `password` | 10–200 characters. Length is weighted over character classes, per current NIST guidance |
| `name`     | 1–200 characters                                                                        |

**`201 Created`**

```json
{
  "user": {
    "id": "9823da9f-8f89-44c6-ba52-67da8d1a2cba",
    "email": "ada@example.com",
    "name": "Ada Lovelace",
    "role": "user",
    "created_at": "2026-09-10T09:21:37.712Z",
    "updated_at": "2026-09-10T09:21:37.712Z"
  },
  "tokens": {
    "accessToken": "eyJhbGciOiJSUzI1NiIs…",
    "refreshToken": "3xW9…",
    "expiresIn": "15m",
    "tokenType": "Bearer"
  }
}
```

`password_hash` is never present in any response.

Errors: `400` validation, `409` email taken (decided by a database `UNIQUE`
index, not a check-then-insert race), `429` rate limited.

> **This endpoint returns `201` even when the message broker is down.** The
> event is committed to the outbox in the same transaction as the user and
> published when the broker returns. See
> [architecture.md §3](architecture.md#3-reliability-the-transactional-outbox).

### `POST /auth/login`

```bash
curl -X POST localhost:8080/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"Str0ng!Passw0rd"}'
```

**`200 OK`** — same shape as register.

An unknown email and a wrong password return an **identical** response, and the
unknown-email path performs a dummy hash so the timing matches. Anything else
turns this endpoint into an oracle for which addresses have accounts.

### `POST /auth/refresh`

Exchanges a refresh token for a new pair, **rotating** it.

```bash
curl -X POST localhost:8080/api/v1/auth/refresh \
  -H 'content-type: application/json' \
  -d '{"refreshToken":"3xW9…"}'
```

**`200 OK`** — new access _and_ refresh token. The old one is now revoked.

> **Reuse detection.** Presenting an already-rotated token returns `401` and
> revokes **every session** for that user. A replayed token means either the
> attacker or the legitimate client is using a stale one, and there is no way to
> tell which — so the safe response is to force a fresh sign-in.

### `POST /auth/logout`

```bash
curl -X POST localhost:8080/api/v1/auth/logout \
  -H 'content-type: application/json' \
  -d '{"refreshToken":"3xW9…","allSessions":false}'
```

**`204 No Content`.** Idempotent: an unknown or already-revoked token still
succeeds. The caller's intent is satisfied either way, and an error would leak
whether the token was real.

`allSessions: true` revokes every session for the user.

---

## Users

All routes require authentication.

### `GET /users/me`

```bash
curl localhost:8080/api/v1/users/me -H "authorization: Bearer $ACCESS"
```

**`200 OK`** → `{ "user": { … } }`

Prefer this over `/users/{id}`: it takes no client-supplied id, so there is no
ownership question to get wrong.

### `PATCH /users/me`

Emits **`user.updated`** carrying `changedFields`.

```bash
curl -X PATCH localhost:8080/api/v1/users/me \
  -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
  -d '{"name":"Ada King"}'
```

At least one of `name`, `email` is required — `{}` is a `400`, not a silent
no-op. A change to the _current_ value emits nothing, because notifying about a
non-event is noise.

Errors: `400`, `409` if the new email is taken.

### `POST /users/me/change-password`

Emits **`user.password_changed`** and **revokes all other sessions**.

```bash
curl -X POST localhost:8080/api/v1/users/me/change-password \
  -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
  -d '{"currentPassword":"Str0ng!Passw0rd","newPassword":"N3w!Passw0rd!x"}'
```

**`204 No Content`.**

The current password is required even though you are already authenticated: a
stolen access token alone must not let an attacker lock the owner out. Sessions
are revoked because if the password is being changed _due to_ a compromise,
leaving the attacker's refresh token live defeats the purpose.

Errors: `400`, `403` current password incorrect.

### `DELETE /users/me`

Emits **`user.deleted`**; refresh tokens cascade.

```bash
curl -X DELETE localhost:8080/api/v1/users/me -H "authorization: Bearer $ACCESS"
```

**`204 No Content`.**

The deletion notification is delivered _after_ the user row is gone — the event
payload carries the email and name, so the consumer never queries a deleted
record. A request/response design would have nothing left to look up.

> Do not send `content-type: application/json` on a bodyless request; an empty
> JSON body is malformed and is rejected with `400`.

### `GET /users/{id}`

**`200 OK`** for your own id (or any id, as admin).

A non-admin requesting someone else's id gets **`404`, not `403`** — a 403
confirms the account exists and would allow id enumeration.

### `GET /users` — admin only

```bash
curl "localhost:8080/api/v1/users?limit=20&offset=0" -H "authorization: Bearer $ADMIN"
```

| Query    | Default | Range |
| -------- | ------- | ----- |
| `limit`  | 20      | 1–100 |
| `offset` | 0       | ≥ 0   |

**`200 OK`** → `{ "users": [...], "pagination": { "total", "limit", "offset", "hasMore" } }`

`403` for non-admins.

---

## Notifications

**Read-only by design.** There is no endpoint that creates a notification — the
only way one comes into existence is by consuming an event from JetStream. If
this surface had a "send" endpoint, the User Service could call it over REST and
the message broker would be decoration.

### `GET /notifications`

Your own notification history, newest first.

```bash
curl "localhost:8080/api/v1/notifications?limit=20" -H "authorization: Bearer $ACCESS"
```

**`200 OK`**

```json
{
  "notifications": [
    {
      "id": "b1f0…",
      "eventId": "354febed-83ca-4f54-9738-7d1f17b765ab",
      "eventType": "user.registered",
      "recipient": "ada@example.com",
      "channel": "console",
      "subject": "Welcome to Trams",
      "body": "Hi Ada Lovelace,\n\nYour Trams account is ready to use.…",
      "status": "sent",
      "attempts": 1,
      "correlationId": "0b7c…e91",
      "createdAt": "2026-09-10T09:21:38.104Z",
      "sentAt": "2026-09-10T09:21:38.140Z"
    }
  ],
  "pagination": { "total": 1, "limit": 20, "offset": 0, "hasMore": false }
}
```

Scoped to the authenticated subject from the verified token — never to a user id
from the query string. `correlationId` matches the request that caused it.

### `GET /notifications/by-event/{eventId}`

Look up the notification produced by a specific event, for tracing. `404` if it
is not yours.

### `GET /notifications/dead-letters` — admin only

Messages that could never be processed. This is the operational view during an
incident.

```json
{
  "deadLetters": [
    {
      "id": "d4c…",
      "event_id": null,
      "subject": "user.registered",
      "raw_payload": "{\"this\":\"is not a valid event envelope\"}",
      "reason": "schema violation: type: Invalid discriminator value…",
      "delivery_count": 1,
      "stream_sequence": 12,
      "created_at": "2026-09-10T09:33:02.881Z"
    }
  ],
  "pagination": { "total": 1, "limit": 20, "offset": 0, "hasMore": false }
}
```

`delivery_count: 1` is meaningful: a permanently-invalid message is quarantined
on the **first** attempt rather than consuming the retry budget. A
`retries exhausted` reason will show the full count instead.

Admin-only because a dead letter contains the raw event payload.

### `GET /notifications/stats` — admin only

```json
{ "notifications": { "sent": 42, "failed": 1 }, "deadLetters": 2 }
```

---

## Event catalogue

These are internal to the system — never exposed over HTTP — but they are the
actual contract between the two services. Defined in
`packages/shared/src/events/schemas.ts`.

| Subject                 | Emitted by                       | Notification                                                |
| ----------------------- | -------------------------------- | ----------------------------------------------------------- |
| `user.registered`       | `POST /auth/register`            | "Welcome to Trams"                                          |
| `user.updated`          | `PATCH /users/me`                | "Your Trams profile was updated" — names the changed fields |
| `user.password_changed` | `POST /users/me/change-password` | "Your Trams password was changed" — includes origin IP      |
| `user.deleted`          | `DELETE /users/me`               | "Your Trams account has been deleted"                       |

Envelope:

```jsonc
{
  "id": "uuid", // also the JetStream msgID and the consumer's idempotency key
  "type": "user.registered",
  "version": 1, // consumers branch on this; an unknown version is quarantined
  "occurredAt": "2026-09-10T09:21:37.712Z",
  "correlationId": "0b7c…e91",
  "actor": { "userId": "uuid" },
  "data": {/* per-type, zod-validated */},
}
```

Payloads carry identity only — never a password or a hash, and
`tests/unit/events.test.ts` asserts that credentials injected into a payload are
stripped rather than forwarded.
