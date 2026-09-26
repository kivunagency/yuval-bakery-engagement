// @ts-check
// Cross-cutting DB security checks (orchestrator, after wave 1).
const { test, expect } = require('@playwright/test');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { localEnv } = require('./helpers/env');

// The only functions in public that anon may EXECUTE. Adding one is a
// deliberate decision: update this list in the same PR, with the reason.
// (authenticated has its own map below.)
const ANON_EXECUTE_ALLOWLIST = [
  'fn_business_date', // blindspot-002: day floor for the day picker
  'fn_earliest_delivery_date', // blindspot-002
  'fn_lookup_order_by_phone_and_number', // US-0d, rate limited in the DB
  'fn_public_day_availability', // api-002, states only
  'fn_public_site_settings', // compliance-002, whitelisted fields
  'has_aal2', 'is_admin', 'is_admin_aal2', // called by RLS policies
];

// The only functions in public that a signed-in user (`authenticated`: every
// customer AND Yuval) may EXECUTE, each with the reason and the guard that makes
// it safe for a customer to call. Adding one is a deliberate decision: update this
// map in the same PR. The guard is checked against the function body below, so a
// reason cannot claim a check the function does not make.
//   admin:  refuses unless is_admin_aal2() (raises admin_aal2_required or similar);
//           a customer's JWT is never aal2 + in `admins`, so for customers it is a no-op
//   member: refuses unless is_admin() (in `admins`); aal1 on purpose, see its reason
//   self:   acts only on the caller's own row, keyed by auth.uid()
//   public: the same read anon has (see ANON_EXECUTE_ALLOWLIST)
//   pure:   not SECURITY DEFINER, reads no table: a calculation
const AUTHENTICATED_EXECUTE_ALLOWLIST = {
  // admin screens (Yuval, aal2 inside)
  fn_admin_create_delivery_zone: ['admin', 'api-007 zones screen'],
  fn_admin_update_delivery_zone: ['admin', 'api-007 zones screen'],
  fn_admin_delete_delivery_zone: ['admin', 'api-007 zones screen'],
  fn_admin_delivery_list: ['admin', 'api-008 delivery list, audited'],
  fn_admin_custom_cake_capacity_check: ['admin', 'api-006 read-only fit check before approving'],
  fn_admin_record_auth_event: ['member', 'db-005 admin sign-in audit, recorded at the password step before TOTP'],
  fn_admin_register_push_subscription: ['admin', 'client-012 push to Yuval only (SEC-018)'],
  fn_admin_revoke_push_subscription: ['admin', 'client-012'],
  fn_admin_release_unpaid_for_day: ['admin', 'client-009 release unpaid holds of a day'],
  fn_admin_reset_day_to_pattern: ['admin', 'client-007 capacity day back to the weekly pattern'],
  fn_admin_set_day_capacity: ['admin', 'api-009 capacity of one day'],
  fn_admin_set_weekly_pattern: ['admin', 'client-007 weekly pattern'],
  fn_approve_custom_cake_request: ['admin', 'api-006 approve, reserves capacity in the DB'],
  fn_decline_custom_cake_request: ['admin', 'api-006'],
  fn_cancel_order: ['admin', 'api-004 cancel releases capacity once (SEC-007)'],
  fn_mark_order_paid: ['admin', 'api-004 mark paid'],
  fn_mark_order_fulfilled: ['admin', 'api-004 mark fulfilled'],
  fn_find_guest_records_by_phone: ['admin', 'privacy: a data-subject request by phone'],
  fn_record_order_confirmation_delivered: ['admin', 'US-0c confirmation delivery (admin or service role)'],
  // the customer's own account (api-010)
  fn_register_customer: ['self', 'api-010 profile row of the signed-in user'],
  fn_update_my_profile: ['self', 'api-010 own profile'],
  fn_set_marketing_consent: ['self', 'own consent; an aal2 admin may record one on request'],
  fn_hard_delete_customer: ['self', 'right to erasure of the own account; or an aal2 admin'],
  // the same public reads anon has
  fn_business_date: ['public', 'blindspot-002'],
  fn_earliest_delivery_date: ['public', 'blindspot-002'],
  fn_lookup_order_by_phone_and_number: ['public', 'US-0d, rate limited in the DB'],
  fn_public_day_availability: ['public', 'api-002, states only'],
  fn_public_site_settings: ['public', 'compliance-002, whitelisted fields'],
  has_aal2: ['public', 'called by RLS policies'],
  is_admin: ['public', 'called by RLS policies'],
  is_admin_aal2: ['public', 'called by RLS policies'],
  // calculations
  fn_is_day_of_month: ['pure', 'api-010 birthday validation'],
};

async function db() {
  const c = new Client({ connectionString: localEnv().DATABASE_URL_TEST });
  await c.connect();
  return c;
}

test.describe('DB privileges', () => {
  test('anon can EXECUTE only the allowlisted functions', async () => {
    const c = await db();
    const { rows } = await c.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and p.proname not like 'uuid\\_%'
        and has_function_privilege('anon', p.oid, 'execute') order by 1`);
    await c.end();
    expect(rows.map((r) => r.proname)).toEqual([...ANON_EXECUTE_ALLOWLIST].sort());
  });

  test('authenticated (every signed-in customer) can EXECUTE only the allowlisted functions', async () => {
    const c = await db();
    const { rows } = await c.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and p.proname not like 'uuid\\_%'
        and has_function_privilege('authenticated', p.oid, 'execute') order by 1`);
    await c.end();
    expect(rows.map((r) => r.proname)).toEqual(Object.keys(AUTHENTICATED_EXECUTE_ALLOWLIST).sort());
  });

  test('each authenticated function makes the check its allowlist reason claims', async () => {
    const c = await db();
    const { rows } = await c.query(`
      select p.proname, p.prosecdef, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[])`, [Object.keys(AUTHENTICATED_EXECUTE_ALLOWLIST)]);
    await c.end();
    const wrong = [];
    for (const r of rows) {
      const [guard] = AUTHENTICATED_EXECUTE_ALLOWLIST[r.proname];
      const src = r.prosrc;
      const ok =
        guard === 'admin' ? /IF NOT[\s\S]{0,80}is_admin_aal2\(\)[\s\S]{0,200}RAISE EXCEPTION/i.test(src)
        : guard === 'member' ? /IF NOT is_admin\(\) THEN\s+RAISE EXCEPTION/i.test(src)
        : guard === 'self' ? /auth\.uid\(\)/.test(src)
        : guard === 'public' ? ANON_EXECUTE_ALLOWLIST.includes(r.proname)
        : guard === 'pure' ? !r.prosecdef && !/\b(from|update|insert|delete)\s+[a-z_]+/i.test(src)
        : false;
      if (!ok) wrong.push(`${r.proname} (${guard})`);
    }
    expect(wrong).toEqual([]);
  });

  test('a signed-in customer calling an admin function is refused by the DB', async () => {
    const env = localEnv();
    const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const email = `sec-customer-${Date.now()}@example.test`;
    const password = `pw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const customer = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    expect((await customer.auth.signInWithPassword({ email, password })).error).toBeNull();
    const calls = [
      ['fn_admin_set_day_capacity', { p_day: '2099-01-01', p_oven_minutes_total: 1, p_work_minutes_total: 1, p_is_blackout: false }],
      ['fn_mark_order_paid', { p_order_id: '00000000-0000-0000-0000-000000000000' }],
      ['fn_admin_delivery_list', { p_day: '2099-01-01' }],
      ['fn_find_guest_records_by_phone', { p_phone: '0500000000' }],
    ];
    for (const [fn, args] of calls) {
      const { error } = await customer.rpc(fn, args);
      expect(error?.message, fn).toContain('admin_aal2_required');
    }
    await service.auth.admin.deleteUser(created.data.user.id);
  });

  test('a function a migration creates from now on is callable by nobody until granted', async () => {
    const c = await db();
    await c.query(`create function public.zz_probe() returns int language sql as 'select 1'`);
    const { rows } = await c.query(`select has_function_privilege('anon','public.zz_probe()','execute') a,
      has_function_privilege('authenticated','public.zz_probe()','execute') u,
      has_function_privilege('service_role','public.zz_probe()','execute') s`);
    await c.query(`drop function public.zz_probe()`);
    await c.end();
    expect(rows[0]).toEqual({ a: false, u: false, s: true });
  });

  test('service-role paths inside SECURITY DEFINER work (fn_unsubscribe_by_token)', async () => {
    const env = localEnv();
    const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data, error } = await service.rpc('fn_unsubscribe_by_token', { p_token: 'no-such-token' });
    expect(error).toBeNull();
    expect(data).toBe(false);

    const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const denied = await anon.rpc('fn_unsubscribe_by_token', { p_token: 'no-such-token' });
    expect(denied.error?.message).toContain('permission denied');
  });

  test('Storage: anon and a signed-in customer can neither list nor read nor write the private bucket; product photos are public-read only', async () => {
    const env = localEnv();
    const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const path = `requests/qa-${Date.now()}/probe.jpg`;
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    expect((await service.storage.from('custom-cake-inspiration').upload(path, bytes, { contentType: 'image/jpeg' })).error).toBeNull();

    // private bucket: nothing for anon
    const list = await anon.storage.from('custom-cake-inspiration').list('requests');
    expect(list.data ?? []).toEqual([]);
    expect((await anon.storage.from('custom-cake-inspiration').download(path)).data).toBeNull();
    const publicUrl = anon.storage.from('custom-cake-inspiration').getPublicUrl(path).data.publicUrl;
    expect((await fetch(publicUrl)).ok).toBe(false);
    expect((await anon.storage.from('custom-cake-inspiration').upload(`incoming/x/${Date.now()}`, bytes, { contentType: 'image/jpeg' })).error).not.toBeNull();

    // product photos: readable by public URL, not writable by anon
    const pp = `qa/${Date.now()}.jpg`;
    expect((await service.storage.from('product-photos').upload(pp, bytes, { contentType: 'image/jpeg' })).error).toBeNull();
    expect((await fetch(anon.storage.from('product-photos').getPublicUrl(pp).data.publicUrl)).ok).toBe(true);
    expect((await anon.storage.from('product-photos').upload(`qa/anon-${Date.now()}.jpg`, bytes, { contentType: 'image/jpeg' })).error).not.toBeNull();

    // buckets refuse types the API refuses
    expect((await service.storage.from('custom-cake-inspiration').upload(`qa/${Date.now()}.svg`, Buffer.from('<svg/>'), { contentType: 'image/svg+xml' })).error).not.toBeNull();
    await service.storage.from('custom-cake-inspiration').remove([path]);
    await service.storage.from('product-photos').remove([pp]);
  });
});
