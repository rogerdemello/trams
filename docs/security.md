# Security

A threat-model view: what each control defends against, and why it was chosen
over the obvious alternative.

Where a claim is verified by a test, the test is named. Several assertions check
that an operation is **denied** — those are only meaningful because the
integration suite runs the same authorization policy as the production broker
config.

---

## 1. Threat model summary

| Threat                                       | Control                                                                           | Verified by                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Credential stuffing / password spraying      | argon2id (memory-hard) + 10 req/min limit on `/auth/*`                            | manual; `password.test.ts`                             |
| Account enumeration via login                | Identical response for unknown email and wrong password, plus timing equalisation | `security.test.ts › same error`                        |
| Account enumeration via user IDs             | 404 (not 403) when a non-admin targets another account                            | `security.test.ts › returns 404, not 403`              |
| Database leak → usable sessions              | Refresh tokens stored as SHA-256 hashes                                           | `security.test.ts › stores refresh tokens hashed`      |
| Database leak → cracked passwords            | argon2id, 19 MiB, unique salt per hash                                            | `password.test.ts › salts every hash`                  |
| Stolen refresh token used indefinitely       | Rotation on every use + reuse detection revokes the whole family                  | `security.test.ts › rotates … replayed`                |
| Stolen access token → account takeover       | 15-minute TTL; password change requires the current password                      | `security.test.ts › requires the current password`     |
| Compromised gateway minting tokens           | RS256 — the gateway holds only the public key                                     | by construction (`AccessTokenVerifier`)                |
| JWT `alg: none` / key confusion              | Algorithm pinned to `['RS256']` on verify                                         | `security.test.ts › token signed with a different key` |
| Bypassing the gateway to reach a service     | `X-Internal-Token`, compared in constant time                                     | `security.test.ts › did not come through the gateway`  |
| Compromised consumer forging user events     | Broker denies it publish on `user.>`                                              | `security.test.ts › denies … publish user events`      |
| Compromised producer reading the stream      | Broker denies it consumer-read                                                    | `security.test.ts › denies … consume the stream`       |
| Consumer erasing evidence of failures        | No stream-management permission                                                   | `security.test.ts › denies … manage streams`           |
| Network eavesdropping / broker impersonation | TLS 1.3 with `verify: true` (mutual)                                              | connection fails without a CA-signed client cert       |
| Malicious cross-origin requests              | CORS allowlist; unknown origin → 403                                              | manual                                                 |
| Credentials leaking into logs                | pino `redact` on password/token/authorization                                     | `REDACTED_PATHS`                                       |
| Internal details leaking in errors           | Non-exposed errors collapse to a generic 500                                      | `errors.test.ts › collapses an unknown throw`          |
| Resource exhaustion                          | Body cap, rate limits, `max_ack_pending`, bounded upstream timeouts               | manual                                                 |
| Log injection via headers                    | Inbound correlation id is charset- and length-filtered                            | `correlation.ts`                                       |
| Path injection through the proxy             | Route params are `encodeURIComponent`-ed into upstream paths                      | `routes.ts`                                            |

---

## 2. Decisions and their alternatives

### argon2id rather than bcrypt

bcrypt is only CPU-hard. argon2id is **memory**-hard: each guess must allocate
19 MiB, so an attacker's advantage is capped by memory bandwidth rather than
clock cycles, and GPU/ASIC parallelism becomes expensive in silicon.

Parameters (19456 KiB, t=2, p=1) follow the OWASP Password Storage Cheat Sheet
minimum and are encoded in the hash string — so raising them later does not
invalidate existing hashes.

### RS256 rather than HS256

With a symmetric secret, every component that can _verify_ a token can also
_mint_ one. The gateway is the internet-facing component and therefore the most
likely to be compromised, so it is given the weaker capability: only the public
key.

`TokenService` (User Service) is the single place in the system that loads the
private key. Verification everywhere — including inside the User Service itself
— goes through the shared `AccessTokenVerifier`, which cannot sign.

### Two token types

|              | Access token           | Refresh token              |
| ------------ | ---------------------- | -------------------------- |
| Form         | Signed JWT (RS256)     | 32 random bytes, base64url |
| Lifetime     | 15 minutes             | 7 days                     |
| State        | Stateless              | Stored hashed, revocable   |
| Verification | Signature only, no I/O | Database lookup by hash    |

This resolves a real tension: stateless tokens scale but cannot be revoked;
stateful tokens can be revoked but cost a lookup. Using both keeps the common
path (verifying a request) free, while the dangerous capability (staying signed
in for a week) stays revocable. Worst case from a stolen access token is bounded
at 15 minutes.

### Refresh tokens: SHA-256, not argon2

Deliberately different from passwords. A refresh token is 256 bits of CSPRNG
output — there is no dictionary to attack, so a slow KDF buys nothing. It _is_
looked up by its hash on every refresh, so a slow hash would mean re-hashing at
19 MiB per attempt or a table scan.

What hashing buys: a database dump yields no usable sessions.

### Rotation with reuse detection

Each refresh consumes its token and issues a replacement, recording
`replaced_by`. If an already-revoked token is presented, that is a strong signal
of theft — and there is no way to tell which holder is legitimate. The safe
response is to revoke the **entire family** and force a fresh login. Accepting
it would let a stolen token be used indefinitely; the rotation chain is what
makes theft _detectable_ rather than merely survivable.

### Authorization checked twice

The gateway rejects unauthenticated requests, and each service verifies the
signature again locally.

This is not redundant. If the only check lived at the edge, a service would be
deciding _who the caller is_ from a header it never verified — the classic
confused-deputy setup. Verifying locally means authorization rests on
cryptography the service checked itself. The cost is one RSA verification per
request with no database round trip, which is exactly why access tokens are
stateless.

Ownership is likewise re-checked in the service that owns the data
(`authoriseUserAccess`), not inferred from the URL.

### `X-Internal-Token` compared with `timingSafeEqual`

String comparison exits at the first differing byte, so response time reveals
how many leading bytes a guess got right — turning a 128-bit secret into a
byte-at-a-time search. Length is checked first because `timingSafeEqual` throws
on a mismatch, and length is not secret (it is fixed by our own config).

Health probes are exempt, deliberately: they come from the orchestrator, not the
gateway, and a rotated internal token must not make every instance look
unhealthy and trigger a restart loop.

### Header allowlists in the proxy

Both directions use an allowlist, never a blocklist — with a blocklist, anything
you forgot to block passes through, and the interesting attacks come from
headers nobody thought of.

Specifically, `x-internal-token` is **set by the gateway** and any
client-supplied value is dropped. On the response side, a backend cannot set
cookies or CORS headers, so a compromised service cannot widen the browser's
trust boundary.

### CORS allowlist, never reflection

`origin: true` (reflect any origin) combined with `credentials: true` is the
classic misconfiguration that lets any website make authenticated requests on a
logged-in user's behalf. An unknown origin is rejected with a 403.

A missing `Origin` header is allowed: that is a non-browser client (curl, a
server), and CORS is a browser mechanism with nothing to enforce.

### Fail-fast configuration

Every secret is read through a zod-validated loader. When `NODE_ENV=production`,
development fallbacks are **disabled entirely** — a missing secret stops the
process on line one rather than silently degrading to a well-known default,
which is the worst kind of vulnerability because everything appears to work.

---

## 3. Broker authorization in detail

The part of this system that most directly answers "secure inter-service
communication". TLS alone gives you an encrypted pipe to a broker that will then
let any authenticated client publish anything.

```
user-service                          notification-service
────────────                          ────────────────────
publish:                              publish:
  user.>                                dlq.>
  $JS.API.INFO                          $JS.API.INFO
  $JS.API.STREAM.{CREATE,UPDATE,        $JS.API.CONSUMER.INFO.USER_EVENTS.
    INFO}.USER_EVENTS                     notification-worker
  … same for USER_EVENTS_DLQ            $JS.API.CONSUMER.MSG.NEXT.USER_EVENTS.
  $JS.API.CONSUMER.{CREATE,DURABLE.       notification-worker
    CREATE,INFO,UPDATE}.USER_EVENTS.>   $JS.ACK.USER_EVENTS.>

subscribe:                            subscribe:
  _INBOX.>                              _INBOX.>

CANNOT: read the stream               CANNOT: publish user.*,
  (no MSG.NEXT, no $JS.ACK)             manage or delete streams
```

Note what is scoped by _name_: the stream and the consumer are both pinned, so
neither service can operate on a different one. A wildcard
`$JS.API.STREAM.>` would let the producer reconfigure or delete any stream in
the account.

The producer owns topology provisioning because it owns the domain. Giving that
to the consumer instead would mean a service that can reconfigure the stream it
reads from — and therefore delete the evidence of what it failed to process.

### Two layers, not one

1. **mTLS** establishes _fleet membership_ — "this is a legitimate Trams
   service". A CA-signed client certificate is required before the password is
   even considered.
2. **Per-user credentials** establish _role_ — "which service, and what it may
   do".

Compromising one does not grant the other. In development both services share a
client certificate (fleet identity) with distinct credentials (role); in
production, issue a certificate per service so the layers reinforce.

---

## 4. Known limitations

Stated plainly rather than left for a reviewer to find.

1. **Development credentials are committed.** `infra/nats/nats.conf` and
   `.env.example` contain placeholder passwords that match each other so the
   project runs on clone. They are not secrets and must not be deployed. For
   production, use bcrypt hashes (`nats server passwd`) or NATS decentralised
   auth (NKEYs/JWTs), and template the config from a secret store.

2. **Both services share one client certificate in development.** See above —
   per-service certificates in production.

3. **TLS terminates at the load balancer for public traffic.** The gateway sets
   `trustProxy: true`, which is correct behind a proxy but would let a client
   spoof its IP via `X-Forwarded-For` on a directly-exposed listener — and
   thereby evade the per-IP rate limit. Deploy it behind a proxy, or set
   `trustProxy: false`.

4. **Rate limiting is per-instance and in-memory.** With N gateway replicas the
   effective limit is N × the configured value. A shared Redis store is the
   standard fix.

5. **The exactly-once window.** Documented in
   [architecture.md §4](architecture.md#honest-limitation): a crash between
   `channel.send()` and `markSent` can produce a duplicate notification. This is
   irreducible without a distributed transaction; the design chooses a rare
   duplicate over a silent omission.

6. **Migrations run at service boot.** Convenient for a single instance and for
   a reviewer running `npm run dev`; with multiple replicas this belongs in a
   separate release step so concurrent instances do not race.

7. **No audit log.** Security-relevant events (login, password change, token
   reuse detection) are logged but not written to a tamper-resistant, queryable
   audit table. For anything regulated, that is a gap.

8. **Admin role assignment is manual.** There is no endpoint to grant `admin`;
   it must be set directly in the database. That is intentional for an
   assignment — a privilege-escalation endpoint is a liability — but a real
   system needs a controlled path.
