#!/usr/bin/env node
/**
 * Generate a local certificate authority plus server and client certificates
 * for mutual TLS between the services and the NATS broker.
 *
 * Why a private CA rather than self-signed certificates: `verify: true` in
 * nats.conf requires the *server* to validate the client's certificate against
 * a CA it trusts. Independently self-signed certs cannot satisfy that — there
 * has to be a common issuer. So we mint a CA, then sign both ends with it.
 *
 * These certificates are for local development only. They are written to a
 * gitignored directory and must never be reused anywhere real.
 *
 *   node infra/scripts/gen-certs.mjs         # generate if missing
 *   node infra/scripts/gen-certs.mjs --force # regenerate from scratch
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const certDir = join(root, 'infra', 'nats', 'certs');
const force = process.argv.includes('--force');

const DAYS = '825'; // ~27 months, under the 825-day limit browsers/tooling expect
const KEY_BITS = '2048';

function openssl(args, label) {
  try {
    execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: certDir });
  } catch (error) {
    const stderr = error.stderr?.toString().trim();
    console.error(`\n✗ openssl failed while ${label}`);
    if (stderr) console.error(`  ${stderr.split('\n').join('\n  ')}`);
    process.exit(1);
  }
}

function assertOpensslPresent() {
  try {
    const version = execFileSync('openssl', ['version'], { encoding: 'utf8' }).trim();
    console.log(`Using ${version}`);
  } catch {
    console.error(
      '\n✗ openssl was not found on PATH.\n\n' +
        '  Windows : it ships with Git for Windows — try running this from Git Bash,\n' +
        '            or install with `winget install ShiningLight.OpenSSL.Light`\n' +
        '  macOS   : brew install openssl\n' +
        '  Linux   : apt install openssl\n\n' +
        '  Alternatively set NATS_TLS_ENABLED=false in .env to run without TLS\n' +
        '  (development only — it disables the mutual-TLS layer entirely).\n',
    );
    process.exit(1);
  }
}

if (force && existsSync(certDir)) {
  rmSync(certDir, { recursive: true, force: true });
  console.log('Removed existing certificates (--force)');
}

if (existsSync(join(certDir, 'server-cert.pem')) && !force) {
  console.log(`Certificates already present in ${certDir}`);
  console.log('Nothing to do. Pass --force to regenerate.');
  process.exit(0);
}

assertOpensslPresent();
mkdirSync(certDir, { recursive: true });

/**
 * Subject Alternative Names.
 *
 * The SAN list — not the Common Name — is what modern TLS stacks validate, so
 * every hostname the broker might be reached by has to appear here. `nats` is
 * included for docker-compose, where the service is addressed by container name
 * rather than by localhost.
 */
writeFileSync(
  join(certDir, 'server-ext.cnf'),
  [
    'basicConstraints = CA:FALSE',
    'keyUsage = digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth',
    'subjectAltName = @alt_names',
    '',
    '[alt_names]',
    'DNS.1 = localhost',
    'DNS.2 = nats',
    'DNS.3 = trams-nats',
    'IP.1 = 127.0.0.1',
    'IP.2 = ::1',
  ].join('\n'),
);

/**
 * The client certificate is marked `clientAuth` only.
 *
 * This matters: a certificate that carries both serverAuth and clientAuth could
 * be used to impersonate the broker itself. Splitting the extended key usage
 * means a leaked client certificate can only be used to connect *as* a client.
 */
writeFileSync(
  join(certDir, 'client-ext.cnf'),
  [
    'basicConstraints = CA:FALSE',
    'keyUsage = digitalSignature, keyEncipherment',
    'extendedKeyUsage = clientAuth',
  ].join('\n'),
);

console.log('\n1/3  Certificate authority');
openssl(['genrsa', '-out', 'ca-key.pem', KEY_BITS], 'generating the CA key');
openssl(
  [
    'req',
    '-x509',
    '-new',
    '-nodes',
    '-key',
    'ca-key.pem',
    '-sha256',
    '-days',
    DAYS,
    '-out',
    'ca-cert.pem',
    '-subj',
    '/C=US/ST=Local/L=Local/O=Trams/OU=Development/CN=Trams Development CA',
  ],
  'creating the CA certificate',
);

console.log('2/3  Server certificate (NATS broker)');
openssl(['genrsa', '-out', 'server-key.pem', KEY_BITS], 'generating the server key');
openssl(
  [
    'req',
    '-new',
    '-key',
    'server-key.pem',
    '-out',
    'server.csr',
    '-subj',
    '/C=US/ST=Local/L=Local/O=Trams/OU=Broker/CN=localhost',
  ],
  'creating the server CSR',
);
openssl(
  [
    'x509',
    '-req',
    '-in',
    'server.csr',
    '-CA',
    'ca-cert.pem',
    '-CAkey',
    'ca-key.pem',
    '-CAcreateserial',
    '-out',
    'server-cert.pem',
    '-days',
    DAYS,
    '-sha256',
    '-extfile',
    'server-ext.cnf',
  ],
  'signing the server certificate',
);

console.log('3/3  Client certificate (services)');
openssl(['genrsa', '-out', 'client-key.pem', KEY_BITS], 'generating the client key');
openssl(
  [
    'req',
    '-new',
    '-key',
    'client-key.pem',
    '-out',
    'client.csr',
    '-subj',
    '/C=US/ST=Local/L=Local/O=Trams/OU=Services/CN=trams-service',
  ],
  'creating the client CSR',
);
openssl(
  [
    'x509',
    '-req',
    '-in',
    'client.csr',
    '-CA',
    'ca-cert.pem',
    '-CAkey',
    'ca-key.pem',
    '-CAcreateserial',
    '-out',
    'client-cert.pem',
    '-days',
    DAYS,
    '-sha256',
    '-extfile',
    'client-ext.cnf',
  ],
  'signing the client certificate',
);

// CSRs and extension files are build intermediates; leaving them behind makes
// the directory harder to read and invites confusion about which files matter.
for (const file of ['server.csr', 'client.csr', 'server-ext.cnf', 'client-ext.cnf']) {
  rmSync(join(certDir, file), { force: true });
}

console.log(`
✓ Certificates written to infra/nats/certs/

    ca-cert.pem      trusted by both the broker and the services
    server-cert.pem  presented by the NATS broker
    server-key.pem   broker private key
    client-cert.pem  presented by both services (mutual TLS)
    client-key.pem   client private key

  This directory is gitignored. Development use only — never deploy these.

  Both services share one client certificate by design: mTLS establishes fleet
  membership ("a legitimate Trams service"), while the per-service credentials
  in nats.conf establish role ("which service, and what it may do"). In
  production, issue a certificate per service so the two layers reinforce.
`);
