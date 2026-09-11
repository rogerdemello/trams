import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Boot a real nats-server for the integration suite.
 *
 * The configuration mirrors infra/nats/nats.conf exactly — same mutual TLS,
 * same per-service accounts, same subject permissions. That matters: if the
 * test broker were permissive, the suite would pass while the real deployment
 * denied the very operations it was verifying. Several of the tests assert that
 * a permission is *denied*, which is only meaningful against the real policy.
 *
 * Each run gets its own port and its own JetStream store directory, so tests
 * start from a clean stream and never collide with a developer's local broker.
 */

const repoRoot = resolve(fileDir(), '../..');
const certDir = join(repoRoot, 'infra', 'nats', 'certs');

function fileDir(): string {
  // fileURLToPath, not URL.pathname: the latter is percent-encoded, so any
  // repository path containing a space resolves to a directory that does not exist.
  return dirname(fileURLToPath(import.meta.url));
}

export interface TestBroker {
  url: string;
  port: number;
  storeDir: string;
  stop: () => Promise<void>;
}

export const TEST_NATS_USERS = {
  userService: { user: 'user-service', pass: 'test-user-pass' },
  notificationService: { user: 'notification-service', pass: 'test-notification-pass' },
  /**
   * A test-harness-only account with unrestricted permissions.
   *
   * It exists solely so the harness can purge the stream between tests. That
   * capability has to come from somewhere, and deliberately NOT from the two
   * service accounts: their permissions are byte-for-byte identical to
   * infra/nats/nats.conf, which is what keeps the "this operation is denied"
   * assertions in security.test.ts meaningful. Granting purge to user-service
   * here would quietly weaken the very policy the suite verifies.
   *
   * There is no equivalent account in the production configuration.
   */
  testAdmin: { user: 'test-admin', pass: 'test-admin-pass' },
};

export function certsAvailable(): boolean {
  return existsSync(join(certDir, 'server-cert.pem')) && existsSync(join(certDir, 'ca-cert.pem'));
}

function buildConfig(port: number, storeDir: string): string {
  const p = (file: string) => join(certDir, file).replace(/\\/g, '/');

  return `
server_name: trams-test-nats
listen: 127.0.0.1:${port}

jetstream {
  store_dir: "${storeDir.replace(/\\/g, '/')}"
  # Matches infra/nats/nats.conf exactly. These limits are not incidental: the
  # USER_EVENTS stream declares max_bytes of 512MB, so a broker with a smaller
  # file store rejects stream creation outright with "insufficient storage
  # resources". Keeping the test broker's limits identical to production means
  # a capacity misconfiguration fails here rather than on first deploy.
  max_memory_store: 268435456
  max_file_store: 2147483648
}

tls {
  cert_file: "${p('server-cert.pem')}"
  key_file:  "${p('server-key.pem')}"
  ca_file:   "${p('ca-cert.pem')}"
  verify:    true
  timeout:   5
}

accounts {
  TRAMS: {
    jetstream: enabled
    users: [
      {
        user: "${TEST_NATS_USERS.userService.user}"
        password: "${TEST_NATS_USERS.userService.pass}"
        permissions: {
          publish: {
            allow: [
              "user.>",
              "$JS.API.INFO",
              "$JS.API.STREAM.CREATE.USER_EVENTS",
              "$JS.API.STREAM.UPDATE.USER_EVENTS",
              "$JS.API.STREAM.INFO.USER_EVENTS",
              "$JS.API.STREAM.CREATE.USER_EVENTS_DLQ",
              "$JS.API.STREAM.UPDATE.USER_EVENTS_DLQ",
              "$JS.API.STREAM.INFO.USER_EVENTS_DLQ",
              "$JS.API.CONSUMER.CREATE.USER_EVENTS.>",
              "$JS.API.CONSUMER.DURABLE.CREATE.USER_EVENTS.>",
              "$JS.API.CONSUMER.INFO.USER_EVENTS.>",
              "$JS.API.CONSUMER.UPDATE.USER_EVENTS.>"
            ]
          }
          subscribe: { allow: ["_INBOX.>"] }
        }
      }
      {
        user: "${TEST_NATS_USERS.notificationService.user}"
        password: "${TEST_NATS_USERS.notificationService.pass}"
        permissions: {
          publish: {
            allow: [
              "dlq.>",
              "$JS.API.INFO",
              "$JS.API.CONSUMER.INFO.USER_EVENTS.>",
              "$JS.API.CONSUMER.MSG.NEXT.USER_EVENTS.>",
              "$JS.ACK.USER_EVENTS.>"
            ]
          }
          subscribe: { allow: ["_INBOX.>"] }
        }
      }
      {
        # Test harness only — see TEST_NATS_USERS.testAdmin. No production
        # counterpart exists.
        user: "${TEST_NATS_USERS.testAdmin.user}"
        password: "${TEST_NATS_USERS.testAdmin.pass}"
      }
    ]
  }
}

max_payload: 1MB
logtime: true
`;
}

/** Start the broker and resolve once it reports readiness. */
export async function startTestBroker(): Promise<TestBroker> {
  if (!certsAvailable()) {
    throw new Error(
      'TLS certificates are missing. Run `npm run certs` before the integration suite.',
    );
  }

  // A high random port, so a developer's local broker on 4222 is untouched and
  // concurrent runs do not collide.
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const workDir = mkdtempSync(join(tmpdir(), 'trams-test-nats-'));
  const storeDir = join(workDir, 'jetstream');
  const configPath = join(workDir, 'nats.conf');

  writeFileSync(configPath, buildConfig(port, storeDir));

  const child: ChildProcess = spawn('nats-server', ['-c', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  await waitForReady(child, port);

  /**
   * Detach the broker from the parent's event loop.
   *
   * Without this the piped stdio handles keep Node alive after the suite
   * finishes, and vitest reports "something prevents the main process from
   * exiting". The `unref` releases the process handle; the stdio streams are
   * torn down explicitly in `stop()`.
   */
  child.unref();

  return {
    url: `tls://127.0.0.1:${port}`,
    port,
    storeDir,
    stop: async () => {
      // Drop the readiness listeners and close the pipes before killing, so no
      // handle outlives the child.
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.stdout?.destroy();
      child.stderr?.destroy();

      if (child.exitCode === null && !child.killed) {
        child.kill('SIGTERM');
        // Give it a moment to release the port and flush its store before the
        // next suite starts.
        await new Promise((r) => setTimeout(r, 300));
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    },
  };
}

/**
 * Wait for "Server is ready" on the broker's own output.
 *
 * Reading the log rather than polling the port: the TCP socket accepts
 * connections slightly before JetStream has finished initialising, so a port
 * check produces a flaky suite that fails on the first stream operation.
 */
function waitForReady(child: ChildProcess, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(
        new Error(
          `nats-server did not become ready within 15s on port ${port}.\n` +
            `Is it installed and on PATH? (scoop install nats-server)\n\n${output}`,
        ),
      );
    }, 15_000);

    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('Server is ready')) {
        clearTimeout(timer);
        resolvePromise();
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Could not start nats-server: ${error.message}\n` +
            `Install it with: scoop install nats-server  (or winget / brew / apt)`,
        ),
      );
    });

    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        reject(new Error(`nats-server exited with code ${code}\n\n${output}`));
      }
    });
  });
}
