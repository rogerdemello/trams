#!/usr/bin/env node
/**
 * Generate the RSA key pair used to sign and verify access tokens.
 *
 * RS256 rather than HS256, deliberately. With a symmetric algorithm the gateway
 * would need the same secret that signs tokens — which means a compromised
 * gateway can *mint* tokens for any user, not merely validate them. With RS256
 * the User Service holds the private key and the gateway is given only the
 * public key: it can verify and it cannot forge.
 *
 * That asymmetry deliberately matches the trust model. The gateway is the
 * internet-facing component and therefore the most likely to be compromised,
 * so it is the component that gets the weaker capability.
 *
 *   node infra/scripts/gen-jwt-keys.mjs         # generate if missing
 *   node infra/scripts/gen-jwt-keys.mjs --force # regenerate (invalidates tokens)
 */

import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const keyDir = join(root, 'infra', 'keys');
const privatePath = join(keyDir, 'jwt-private.pem');
const publicPath = join(keyDir, 'jwt-public.pem');
const force = process.argv.includes('--force');

if (existsSync(privatePath) && !force) {
  console.log(`JWT keys already present in ${keyDir}`);
  console.log('Nothing to do. Pass --force to regenerate (this invalidates all issued tokens).');
  process.exit(0);
}

mkdirSync(keyDir, { recursive: true });

// 2048-bit RSA: the floor for RS256 and entirely adequate for short-lived
// access tokens. Larger keys would only add signing cost per request.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

writeFileSync(privatePath, privateKey, { mode: 0o600 });
writeFileSync(publicPath, publicKey, { mode: 0o644 });

// Best-effort on Windows, where POSIX modes are not enforced; harmless there
// and meaningful everywhere else.
try {
  chmodSync(privatePath, 0o600);
} catch {
  /* not supported on this filesystem */
}

console.log(`
✓ RS256 key pair written to infra/keys/

    jwt-private.pem  User Service only — signs access tokens (mode 0600)
    jwt-public.pem   API Gateway — verifies access tokens

  This directory is gitignored. Development use only.

  The gateway never receives the private key. It can verify a token's signature
  but cannot produce one, so compromising the internet-facing component does
  not yield the ability to impersonate users.
`);
