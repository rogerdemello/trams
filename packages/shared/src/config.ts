import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Configuration is validated once, at boot, and then frozen.
 *
 * The design rule here: a misconfigured process must fail on its first line,
 * loudly, rather than surface as an intermittent 500 once traffic arrives.
 * Every consumer of this module therefore receives an already-validated,
 * fully-typed object and never has to defend against `undefined`.
 *
 * The second rule: development conveniences must not survive into production.
 * `devDefault` supplies a value only while NODE_ENV !== 'production'. In
 * production the same variable is required, so a forgotten secret cannot
 * silently degrade into a well-known default — the worst kind of vulnerability,
 * because everything appears to work.
 */

const isProduction = process.env['NODE_ENV'] === 'production';

/**
 * A secret that must be explicitly supplied in production but may fall back to
 * a placeholder during local development.
 */
function devDefault(value: string) {
  return isProduction ? z.string().min(1) : z.string().min(1).default(value);
}

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0),
);

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Service addresses
  GATEWAY_PORT: port.default(8080),
  GATEWAY_HOST: z.string().default('0.0.0.0'),
  USER_SERVICE_PORT: port.default(4001),
  USER_SERVICE_HOST: z.string().default('127.0.0.1'),
  USER_SERVICE_URL: z.string().url().default('http://127.0.0.1:4001'),
  NOTIFICATION_SERVICE_PORT: port.default(4002),
  NOTIFICATION_SERVICE_HOST: z.string().default('127.0.0.1'),
  NOTIFICATION_SERVICE_URL: z.string().url().default('http://127.0.0.1:4002'),

  // Database
  DB_CLIENT: z.enum(['sqlite', 'postgres']).default('sqlite'),
  USER_DB_URL: z.string().default('./data/user-service.db'),
  NOTIFICATION_DB_URL: z.string().default('./data/notification-service.db'),

  // JWT
  JWT_PRIVATE_KEY_PATH: z.string().default('./infra/keys/jwt-private.pem'),
  JWT_PUBLIC_KEY_PATH: z.string().default('./infra/keys/jwt-public.pem'),
  JWT_ISSUER: z.string().default('trams.user-service'),
  JWT_AUDIENCE: z.string().default('trams.api'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: positiveInt.default(7),

  // Gateway -> service authentication
  INTERNAL_TOKEN: devDefault('dev-internal-token-change-me'),

  // Edge hardening
  // Note: `.default()` on a transforming schema takes the *output* type, so the
  // fallback is the parsed array rather than the raw comma-separated string.
  CORS_ORIGINS: csv.default(['http://localhost:3000', 'http://localhost:5173']),
  RATE_LIMIT_MAX: positiveInt.default(100),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  AUTH_RATE_LIMIT_MAX: positiveInt.default(10),
  BODY_LIMIT_BYTES: positiveInt.default(65_536),

  // NATS
  NATS_URL: z.string().default('tls://127.0.0.1:4222'),
  NATS_USER_SERVICE_USER: z.string().default('user-service'),
  NATS_USER_SERVICE_PASS: devDefault('dev-user-service-pass-change-me'),
  NATS_NOTIFICATION_SERVICE_USER: z.string().default('notification-service'),
  NATS_NOTIFICATION_SERVICE_PASS: devDefault('dev-notification-service-pass-change-me'),

  // NATS TLS
  NATS_TLS_ENABLED: booleanish.default(true),
  NATS_CA_PATH: z.string().default('./infra/nats/certs/ca-cert.pem'),
  NATS_CLIENT_CERT_PATH: z.string().default('./infra/nats/certs/client-cert.pem'),
  NATS_CLIENT_KEY_PATH: z.string().default('./infra/nats/certs/client-key.pem'),

  // Outbox publisher
  OUTBOX_POLL_INTERVAL_MS: positiveInt.default(1_000),
  OUTBOX_BATCH_SIZE: positiveInt.default(50),
  OUTBOX_MAX_ATTEMPTS: positiveInt.default(10),

  // Notification consumer
  NOTIFICATION_CONSUMER_NAME: z.string().default('notification-worker'),
  NOTIFICATION_MAX_DELIVER: positiveInt.default(5),
  NOTIFICATION_ACK_WAIT_MS: positiveInt.default(30_000),
  NOTIFICATION_MAX_ACK_PENDING: positiveInt.default(100),
  NOTIFICATION_FETCH_BATCH: positiveInt.default(10),

  // Notification delivery
  NOTIFICATION_CHANNEL: z.enum(['console', 'smtp']).default('console'),
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: port.default(1025),
  SMTP_SECURE: booleanish.default(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM: z.string().default('no-reply@trams.local'),
});

export type Config = z.infer<typeof envSchema>;

let cached: Config | undefined;

/**
 * Parse and validate the environment. Cached, so repeated calls across modules
 * are free and every module observes exactly the same configuration.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;

  const result = envSchema.safeParse(env);

  if (!result.success) {
    // Deliberately bypasses the logger: the logger itself depends on config, and
    // a config failure must be reportable before anything else is constructed.
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    process.stderr.write(
      `\nInvalid configuration — refusing to start:\n${issues}\n\n` +
        `Copy .env.example to .env and fill in the missing values.\n` +
        (isProduction
          ? `NODE_ENV=production disables all development fallbacks, so every secret must be set explicitly.\n`
          : ''),
    );
    process.exit(1);
  }

  cached = Object.freeze(result.data);
  return cached;
}

/** Test helper: drop the cached config so a different environment can be loaded. */
export function resetConfigCache(): void {
  cached = undefined;
}

/**
 * Read a PEM key from disk with an error message that says what to do about it.
 * A cryptic ENOENT during boot is a bad first experience for whoever is trying
 * to run this project.
 */
export function readPem(path: string, hint: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Could not read required key material at "${path}". ${hint}`);
  }
}
