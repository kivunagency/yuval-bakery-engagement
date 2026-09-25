// Registered customers on the local stack (api-010). Local stack only.
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { localEnv } = require('./env');
const { randomPhone } = require('./db');

function newIdentity() {
  return {
    name: 'QA לקוחה',
    email: `customer-${crypto.randomUUID()}@example.test`,
    password: `qa-${crypto.randomBytes(12).toString('base64url')}`,
    phone: randomPhone(),
  };
}

/** The JSON body POST /api/customers expects. */
function registerBody(id, extra = {}) {
  return { name: id.name, phone: id.phone, email: id.email, password: id.password, ageConfirmed: true, privacyNoticeVersion: 'privacy-2026-10-v1', ...extra };
}

/**
 * A confirmed Auth user (admin API), signed in with supabase-js, with a
 * customers row created through fn_register_customer over PostgREST (the same
 * call /account/confirm makes). Returns the signed-in client.
 */
async function createConfirmedCustomer({ register = true } = {}) {
  const env = localEnv();
  const id = newIdentity();
  const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data, error } = await service.auth.admin.createUser({ email: id.email, password: id.password, email_confirm: true });
  if (error) throw error;
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email: id.email, password: id.password });
  if (signInError) throw signInError;
  if (register) {
    const { error: regError } = await client.rpc('fn_register_customer', {
      p_name: id.name, p_phone: id.phone, p_privacy_notice_version: 'privacy-2026-10-v1', p_age_confirmed: true,
    });
    if (regError) throw regError;
  }
  return { ...id, client, userId: data.user.id, service };
}

module.exports = { newIdentity, registerBody, createConfirmedCustomer };
