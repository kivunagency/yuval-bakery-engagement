// Creates a real admin on the local stack: Auth user (admin API), TOTP factor
// enrolled and verified through Supabase Auth, row in `admins`. Returns a
// supabase-js client whose session is at aal2. Local stack only.
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { Client } = require('pg');
const { localEnv } = require('./env');

function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP, 6 digits, 30s step, SHA-1 (what Supabase Auth issues). */
function totp(secretBase32, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = crypto.createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function createAdmin({ withMfa = true } = {}) {
  const env = localEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const service = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const email = `admin-${crypto.randomUUID()}@example.test`;
  const password = crypto.randomBytes(18).toString('base64url');
  const { data: created, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const userId = created.user.id;

  const db = new Client({ connectionString: env.DATABASE_URL_TEST });
  await db.connect();
  await db.query('INSERT INTO admins (id, display_name) VALUES ($1, $2)', [userId, 'QA admin']);
  await db.end();

  const client = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;

  if (withMfa) {
    const { data: factor, error: enrollError } = await client.auth.mfa.enroll({ factorType: 'totp' });
    if (enrollError) throw enrollError;
    const { error: verifyError } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp(factor.totp.secret) });
    if (verifyError) throw verifyError;
  }
  return { client, userId, email };
}

module.exports = { createAdmin, totp };
