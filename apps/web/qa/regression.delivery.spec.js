// @ts-check
// Delivery domain regression (api-007 admin zones, client-010, api-008, client-011).
// Real chain: browser session (password + TOTP) -> Next.js route -> PostgREST
// as the admin's own aal2 JWT -> SECURITY DEFINER functions -> audit_log.
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { createUser, db, uiLogin } = require('./helpers/admin-ui');
const { localEnv } = require('./helpers/env');

/** A short random tag so parallel or repeated runs never share a zone name or a city. */
const tag = () => crypto.randomUUID().slice(0, 6);

test.describe('admin delivery zones API (api-007)', () => {
  test('anonymous visitor gets 401 on every verb', async ({ request }) => {
    const id = crypto.randomUUID();
    for (const res of [
      await request.get('/api/admin/delivery-zones'),
      await request.post('/api/admin/delivery-zones', { data: { name: 'x', fee: 1 } }),
      await request.patch(`/api/admin/delivery-zones/${id}`, { data: { fee: 1 } }),
      await request.delete(`/api/admin/delivery-zones/${id}`),
    ]) {
      expect(res.status()).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  test('admin at aal2: create, validate, one zone per city (409 names both), rename clash, patch, deactivate, delete, audited', async ({ page, baseURL }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const api = page.request;
    const headers = { origin: baseURL ?? '' };
    const t = tag();
    const [cityA, cityB, cityC] = [`QA עיר א ${t}`, `QA עיר ב ${t}`, `QA עיר ג ${t}`];

    // CSRF: no Origin, or a foreign one.
    expect((await api.post('/api/admin/delivery-zones', { data: { name: `QA ${t}`, fee: 35 } })).status()).toBe(403);
    expect((await api.post('/api/admin/delivery-zones', { headers: { origin: 'https://evil.example' }, data: { name: `QA ${t}`, fee: 35 } })).status()).toBe(403);

    // Zod: fee not whole shekels, negative, over 1000, string; empty name; blank city; unknown key.
    for (const data of [
      { name: `QA ${t}`, fee: 35.5 },
      { name: `QA ${t}`, fee: -1 },
      { name: `QA ${t}`, fee: 1001 },
      { name: `QA ${t}`, fee: '35' },
      { name: '  ', fee: 35 },
      { name: `QA ${t}`, fee: 35, cities: ['   '] },
      { name: `QA ${t}`, fee: 35, isActive: true },
    ]) {
      const r = await api.post('/api/admin/delivery-zones', { headers, data });
      expect(r.status(), JSON.stringify(data)).toBe(400);
      expect(await r.json()).toEqual({ error: 'invalid_input' });
    }

    // Create: cities trimmed, inner spaces collapsed, duplicates dropped.
    const created = await api.post('/api/admin/delivery-zones', { headers, data: { name: ` QA מרכז ${t} `, fee: 35, cities: [`  ${cityA.replace(' ', '   ')} `, cityA, cityB] } });
    expect(created.status()).toBe(201);
    const zone = await created.json();
    expect(zone).toEqual({ id: expect.any(String), name: `QA מרכז ${t}`, fee: 35, isActive: true, cities: [cityA, cityB].sort() });

    // A city belongs to at most one zone: 409 that names the city and the zone that has it.
    const clash = await api.post('/api/admin/delivery-zones', { headers, data: { name: `QA צפון ${t}`, fee: 40, cities: [cityC, cityB] } });
    expect(clash.status()).toBe(409);
    expect(await clash.json()).toEqual({ error: 'city_in_other_zone', city: cityB, zoneName: `QA מרכז ${t}` });
    expect(await db('SELECT 1 FROM delivery_zones WHERE name = $1', [`QA צפון ${t}`])).toHaveLength(0); // nothing half-written

    const north = await (await api.post('/api/admin/delivery-zones', { headers, data: { name: `QA צפון ${t}`, fee: 40, cities: [cityC] } })).json();
    const moveInto = await api.patch(`/api/admin/delivery-zones/${north.id}`, { headers, data: { cities: [cityC, cityA] } });
    expect(moveInto.status()).toBe(409);
    expect(await moveInto.json()).toEqual({ error: 'city_in_other_zone', city: cityA, zoneName: `QA מרכז ${t}` });

    // Zone names are unique, ignoring case and outer spaces.
    const rename = await api.patch(`/api/admin/delivery-zones/${north.id}`, { headers, data: { name: ` QA מרכז ${t}` } });
    expect(rename.status()).toBe(409);
    expect(await rename.json()).toEqual({ error: 'name_taken' });

    // Patch: fee, then the whole city list (remove B, add C is refused as C is North's; add a new one).
    const fee = await api.patch(`/api/admin/delivery-zones/${zone.id}`, { headers, data: { fee: 45 } });
    expect(fee.status()).toBe(200);
    expect((await fee.json()).fee).toBe(45);
    const cities = await api.patch(`/api/admin/delivery-zones/${zone.id}`, { headers, data: { cities: [cityA, `QA עיר ד ${t}`] } });
    expect((await cities.json()).cities).toEqual([cityA, `QA עיר ד ${t}`].sort());
    expect((await api.patch(`/api/admin/delivery-zones/${zone.id}`, { headers, data: {} })).status()).toBe(400);
    expect((await api.patch('/api/admin/delivery-zones/not-a-uuid', { headers, data: { fee: 1 } })).status()).toBe(400);
    const missing = await api.patch(`/api/admin/delivery-zones/${crypto.randomUUID()}`, { headers, data: { fee: 1 } });
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });

    // Deactivate: stays listed for the admin, with its cities.
    const off = await api.patch(`/api/admin/delivery-zones/${zone.id}`, { headers, data: { isActive: false } });
    expect((await off.json()).isActive).toBe(false);
    const list = await (await api.get('/api/admin/delivery-zones')).json();
    expect(list.zones.find((z) => z.id === zone.id)).toEqual({ id: zone.id, name: `QA מרכז ${t}`, fee: 45, isActive: false, cities: [cityA, `QA עיר ד ${t}`].sort() });

    // Delete: the cities go with it and are free for another zone.
    expect((await api.delete(`/api/admin/delivery-zones/${zone.id}`, { headers })).status()).toBe(200);
    expect((await api.delete(`/api/admin/delivery-zones/${zone.id}`, { headers })).status()).toBe(404);
    const freed = await api.patch(`/api/admin/delivery-zones/${north.id}`, { headers, data: { cities: [cityC, cityA] } });
    expect((await freed.json()).cities).toEqual([cityA, cityC].sort());

    // SEC-017: every change audited as this admin, with the previous values.
    const audit = await db("SELECT action, entity_id, metadata FROM audit_log WHERE actor_id = $1 AND action LIKE 'delivery_zone.%' ORDER BY id", [admin.userId]);
    expect(audit.map((a) => a.action)).toEqual([
      'delivery_zone.created', 'delivery_zone.created',
      'delivery_zone.updated', 'delivery_zone.updated', 'delivery_zone.updated',
      'delivery_zone.deleted', 'delivery_zone.updated',
    ]);
    expect(audit[2].metadata).toMatchObject({ fee: 45, previous: { fee: 35 } });
    expect(audit[5].metadata.previous).toMatchObject({ name: `QA מרכז ${t}`, is_active: false });
    await db('DELETE FROM delivery_zones WHERE id = $1', [north.id]);
  });

  test('through PostgREST: no direct table write for anyone; the functions refuse anon and a customer', async () => {
    const env = localEnv();
    const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    expect((await anon.rpc('fn_admin_create_delivery_zone', { p_name: 'x', p_fee: 1, p_cities: [] })).error?.message).toContain('permission denied');
    expect((await anon.from('delivery_zones').insert({ name: `QA anon ${tag()}` })).error).not.toBeNull();

    const customer = await createUser({ admin: false });
    const user = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    await user.auth.signInWithPassword({ email: customer.email, password: customer.password });
    expect((await user.rpc('fn_admin_create_delivery_zone', { p_name: 'x', p_fee: 1, p_cities: [] })).error?.message).toBe('admin_aal2_required');
    expect((await user.from('delivery_zones').insert({ name: `QA user ${tag()}` })).error?.message).toContain('permission denied');
    expect((await user.from('delivery_zone_cities').delete().neq('city', '')).error?.message).toContain('permission denied');
  });
});
