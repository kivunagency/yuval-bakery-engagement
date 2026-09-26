// The managed QA user (Rule 22, qa-005): read apps/web/.qa.env (gitignored).
// Returns { ok: true, user } or { ok: false, reason }. A missing or incomplete
// file is DID NOT RUN for whatever needed the user, never a pass. Nothing here
// logs or returns the password or the TOTP secret in a message.
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const QA_ENV_PATH = join(__dirname, '..', '..', '.qa.env');
const REQUIRED = ['QA_ENV', 'QA_BASE_URL', 'QA_ADMIN_EMAIL', 'QA_ADMIN_PASSWORD', 'QA_ADMIN_TOTP_SECRET'];

function parse(text) {
  return Object.fromEntries(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

function loadQaUser(path = QA_ENV_PATH) {
  if (!existsSync(path)) return { ok: false, reason: `no ${path} (copy .qa.env.example, or run npm run qa:user on the local stack)` };
  const env = parse(readFileSync(path, 'utf8'));
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) return { ok: false, reason: `${path} is missing ${missing.join(', ')}` };
  if (!['local', 'dev', 'prod'].includes(env.QA_ENV)) return { ok: false, reason: `QA_ENV must be local, dev or prod (got "${env.QA_ENV}")` };
  return {
    ok: true,
    user: {
      env: env.QA_ENV,
      baseUrl: env.QA_BASE_URL.replace(/\/+$/, ''),
      email: env.QA_ADMIN_EMAIL,
      password: env.QA_ADMIN_PASSWORD,
      secret: env.QA_ADMIN_TOTP_SECRET,
    },
  };
}

module.exports = { loadQaUser, parseQaEnv: parse, QA_ENV_PATH, REQUIRED_QA_KEYS: REQUIRED };
