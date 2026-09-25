// Helpers for the admin UI tests (regression.admin.spec.js): a real Auth user
// with a known password, optionally in `admins`, optionally with a verified
// TOTP factor whose secret the test keeps. Local stack only.
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { Client } = require('pg');
const { localEnv } = require('./env');
const { totp } = require('./admin');

async function db(query, params = []) {
  const c = new Client({ connectionString: localEnv().DATABASE_URL_TEST });
  await c.connect();
  try {
    return (await c.query(query, params)).rows;
  } finally {
    await c.end();
  }
}

/** Auth user with a known password. admin: row in `admins`. withTotp: enrolled + verified factor. */
async function createUser({ admin = true, withTotp = false } = {}) {
  const env = localEnv();
  const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const email = `qa-${crypto.randomUUID()}@example.test`;
  const password = crypto.randomBytes(18).toString('base64url');
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;
  if (admin) await db('INSERT INTO admins (id, display_name) VALUES ($1, $2)', [userId, 'QA admin']);
  let secret = null;
  if (withTotp) {
    const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { error: e1 } = await client.auth.signInWithPassword({ email, password });
    if (e1) throw e1;
    const { data: f, error: e2 } = await client.auth.mfa.enroll({ factorType: 'totp' });
    if (e2) throw e2;
    secret = f.totp.secret;
    const { error: e3 } = await client.auth.mfa.challengeAndVerify({ factorId: f.id, code: totp(secret) });
    if (e3) throw e3;
    await client.auth.signOut({ scope: 'local' });
  }
  return { email, password, userId, secret };
}

/** A fresh client IP per test, so the per-IP login rate limit of one test never hits another. */
function randomIp() {
  return `10.${crypto.randomInt(0, 255)}.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;
}

/** Full UI login of an admin that already has a TOTP factor. Leaves the page on /admin/orders. */
async function uiLogin(page, user) {
  await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
  await page.goto('/admin/login');
  await page.getByLabel('אימייל').fill(user.email);
  await page.getByLabel('סיסמה').fill(user.password);
  await page.getByRole('button', { name: 'כניסה', exact: true }).click();
  await page.waitForURL('**/admin/login/verify');
  await page.getByLabel('קוד בן 6 ספרות').fill(totp(user.secret));
  await page.getByRole('button', { name: 'אישור' }).click();
  await page.waitForURL('**/admin/orders');
}

module.exports = { createUser, db, randomIp, uiLogin, totp };
