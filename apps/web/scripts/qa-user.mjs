#!/usr/bin/env node
// Managed QA user on the LOCAL stack (Rule 22, qa-005): creates (or replaces) one
// admin, qa-admin@example.test, with a random password and a verified TOTP factor,
// and writes apps/web/.qa.env (gitignored, mode 600). Prints the username and the
// file path, never the password or the secret.
//
//   npm run stack:up && npm run qa:user            # writes .qa.env
//   node scripts/qa-user.mjs --out /tmp/x.env       # somewhere else (tests)
//   node scripts/qa-user.mjs --base-url http://localhost:3100
//
// It refuses any Supabase URL that is not on this machine: the DEV and PROD users
// live in Yuval's project and are created by her (see .qa.env.example).
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createClient } = require('@supabase/supabase-js');
const { Client } = require('pg');
const { localEnv } = require('../qa/helpers/env');
const { totp } = require('../qa/helpers/admin');

const argv = process.argv.slice(2);
const flag = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const out = flag('--out', join(APP, '.qa.env'));
const baseUrl = flag('--base-url', `http://localhost:${process.env.PORT || 3100}`);
const email = flag('--email', 'qa-admin@example.test');

let env;
try {
  env = localEnv();
} catch (e) {
  console.error(`DID NOT RUN: qa-user. No apps/web/.env.local (${e.code}); run npm run stack:up first.`);
  process.exit(2);
}
const url = env.NEXT_PUBLIC_SUPABASE_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
  console.error(`refused: ${url} is not the local stack. DEV/PROD QA users are created in Yuval's project, not by this script.`);
  process.exit(1);
}

const service = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const db = new Client({ connectionString: env.DATABASE_URL_TEST });
await db.connect();
try {
  // replace, so the file and the user never drift apart
  const { rows } = await db.query('select id from auth.users where email = $1', [email]);
  for (const r of rows) {
    await db.query('delete from admins where id = $1', [r.id]);
    const { error } = await service.auth.admin.deleteUser(r.id);
    if (error) throw error;
  }
  const password = randomBytes(24).toString('base64url');
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  await db.query('insert into admins (id, display_name) values ($1, $2)', [data.user.id, 'QA user (managed)']);

  const client = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  const enrolled = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'qa' });
  if (enrolled.error) throw enrolled.error;
  const secret = enrolled.data.totp.secret;
  const verified = await client.auth.mfa.challengeAndVerify({ factorId: enrolled.data.id, code: totp(secret) });
  if (verified.error) throw verified.error;
  await client.auth.signOut({ scope: 'local' });

  writeFileSync(
    out,
    [
      '# Managed QA user, written by scripts/qa-user.mjs. Gitignored. Do not share.',
      'QA_ENV=local',
      `QA_BASE_URL=${baseUrl}`,
      `QA_ADMIN_EMAIL=${email}`,
      `QA_ADMIN_PASSWORD=${password}`,
      `QA_ADMIN_TOTP_SECRET=${secret}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  chmodSync(out, 0o600);
  console.log(`QA user ${email} (admin, TOTP verified) on ${url}; credentials in ${out}`);
} finally {
  await db.end();
}
