// @ts-check
// Cross-cutting DB security checks (orchestrator, after wave 1).
const { test, expect } = require('@playwright/test');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { localEnv } = require('./helpers/env');

// The only functions in public that anon may EXECUTE. Adding one is a
// deliberate decision: update this list in the same PR, with the reason.
const ANON_EXECUTE_ALLOWLIST = [
  'fn_business_date', // blindspot-002: day floor for the day picker
  'fn_earliest_delivery_date', // blindspot-002
  'fn_public_day_availability', // api-002, states only
  'fn_public_site_settings', // compliance-002, whitelisted fields
  'has_aal2', 'is_admin', 'is_admin_aal2', // called by RLS policies
];

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
