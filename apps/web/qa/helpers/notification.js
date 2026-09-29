// Helpers for qa/regression.notifications.spec.js (job-002, client-012).
// Local stack only.
const crypto = require('node:crypto');
const http = require('node:http');
const { mkdirSync, readdirSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const ece = require('http_ece');
const { localEnv } = require('./env');

const APP = join(__dirname, '..', '..');
const BUNDLE_DIR = join(APP, 'test-results', 'notification-bundle');

/**
 * Bundles lib/server/notification/index.ts the way scripts/build-functions.mjs
 * bundles the scheduled functions (react-server condition, so `server-only`
 * resolves to its empty module), and loads it with the local stack's env.
 * This is the real module, talking to the real local PostgREST.
 */
async function loadNotificationModule() {
  const { build } = require('esbuild');
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const out = join(BUNDLE_DIR, 'index.mjs');
  await build({
    absWorkingDir: APP,
    entryPoints: [join(APP, 'lib', 'server', 'notification', 'index.ts')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    conditions: ['react-server'],
    tsconfig: join(APP, 'tsconfig.json'),
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'warning',
  });
  Object.assign(process.env, localEnv());
  return import(`${pathToFileURL(out).href}?v=${Date.now()}`);
}

/** Keys a browser would generate for a push subscription (P-256 + 16-byte auth secret). */
function subscriptionKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
}

/**
 * A stand-in push service on 127.0.0.1: records every POST, answers `status`
 * (201 by default), and decrypts the aes128gcm payload with the subscription's
 * private key, exactly as the browser would.
 */
async function pushService(keys, status = 201) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let payload = null;
      try {
        payload = JSON.parse(ece.decrypt(body, { version: 'aes128gcm', privateKey: keys.ecdh, authSecret: keys.auth }).toString('utf8'));
      } catch (e) {
        payload = { decryptError: String(e) };
      }
      received.push({ headers: req.headers, raw: body, payload });
      res.statusCode = status;
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}/push/${crypto.randomUUID()}`,
    received,
    setStatus: (s) => (status = s),
    close: () => new Promise((r) => server.close(r)),
  };
}

function outboxDir() {
  return process.env.EMAIL_CAPTURE_DIR || localEnv().EMAIL_CAPTURE_DIR;
}

/** Captured emails (capture adapter) addressed to `to`. */
function capturedTo(to) {
  const dir = outboxDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .filter((m) => m.to === to);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = { loadNotificationModule, subscriptionKeys, pushService, capturedTo, outboxDir, sha256 };
