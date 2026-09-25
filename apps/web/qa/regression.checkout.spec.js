// @ts-check
// Checkout and payment (session E): api-003 POST /api/orders and the read
// paths. Needs the local stack (npm run stack:up) and a production build
// (npm run build). API tests use far-future days of their own (no shared state).
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { localEnv } = require('./helpers/env');
const db = require('./helpers/db');

const VERSIONS = { privacy: 'privacy-2026-10-v1', terms: 'terms-2026-10-v1', cancellation: 'cancellation-2026-10-v1' };
const CART_KEY = 'yb.cart.v1';

const withDb = db.withClient;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ip = () => db.randomIp();
const phone = () => `050${crypto.randomInt(1000000, 9999999)}`;

async function product(c, { price = 10, oven = 5, work = 5 } = {}) {
  const { rows } = await c.query(
    `INSERT INTO products (name, price_displayed, cost_basis, oven_minutes_cost, work_minutes_cost, allergens, allergens_confirmed, photo_alt, is_available, is_published)
     VALUES ($1, $2, 'per_unit', $3, $4, ARRAY['gluten'], true, 'qa checkout product', true, true) RETURNING id, name`,
    [`qa checkout ${crypto.randomUUID().slice(0, 8)}`, price, oven, work],
  );
  return rows[0];
}

/** A zone of its own with one city, so the test never depends on seed names. */
async function zone(c, fee) {
  const tag = crypto.randomUUID().slice(0, 8);
  const { rows } = await c.query(`INSERT INTO delivery_zones (name, fee_displayed) VALUES ($1, $2) RETURNING id`, [`QA zone ${tag}`, fee]);
  await c.query(`INSERT INTO delivery_zone_cities (zone_id, city) VALUES ($1, $2)`, [rows[0].id, `QA City ${tag}`]);
  return { id: rows[0].id, name: `QA zone ${tag}`, city: `QA City ${tag}` };
}

async function lastSlot(c) {
  return (await c.query(`SELECT id::text FROM time_slots WHERE is_active ORDER BY start_time DESC LIMIT 1`)).rows[0].id;
}

function post(request, data, { from = ip(), origin = 'http://localhost:3100' } = {}) {
  const headers = { 'content-type': 'application/json', 'x-nf-client-connection-ip': from };
  if (origin) headers.origin = origin;
  return request.post('/api/orders', { data, headers });
}

function body(p, day, slotId, over = {}) {
  return { items: [{ productId: p.id, quantity: 2 }], day, slotId, fulfillment: 'pickup', name: 'QA Guest', phone: phone(), ...over };
}

async function orderByToken(c, token) {
  return (await c.query(`SELECT * FROM orders WHERE lookup_token_hash = $1`, [sha256(token)])).rows[0];
}

// ---------------------------------------------------------------------------
// api-003: POST /api/orders
// ---------------------------------------------------------------------------
test.describe('api-003: POST /api/orders', () => {
  test('pickup: 201 with a 128-bit token only; the DB prices it, stores the hash, the IP and the text versions', async ({ request }) => {
    const { p, day, slot } = await withDb(async (c) => ({ p: await product(c, { price: 12.5 }), day: await db.freshDay(c, { oven: 100, work: 100 }), slot: await lastSlot(c) }));
    const from = ip();
    const res = await post(request, body(p, day, slot, { email: 'qa@example.test' }), { from });
    expect(res.status()).toBe(201);
    const json = await res.json();
    expect(Object.keys(json)).toEqual(['token']);
    expect(json.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(json.token, 'base64url')).toHaveLength(16);
    expect(res.headers()['cache-control']).toContain('no-store');

    await withDb(async (c) => {
      const o = await orderByToken(c, json.token);
      expect(o.status).toBe('payment_pending');
      expect(o.order_number).toMatch(/^A[A-Z2-9]{3}-[A-Z2-9]{3}$/);
      expect(Number(o.total_displayed)).toBe(25);
      expect(Number(o.delivery_fee_displayed)).toBe(0);
      expect(o.guest_phone).toMatch(/^\+9725\d{8}$/);
      expect(o.guest_email).toBe('qa@example.test');
      expect([o.privacy_notice_version, o.terms_version, o.cancellation_notice_version]).toEqual([VERSIONS.privacy, VERSIONS.terms, VERSIONS.cancellation]);
      expect(o.delivery_slot_id).toBe(slot);
      expect(JSON.stringify(o)).not.toContain(json.token); // only the hash is stored
      const log = await c.query(`SELECT count(*)::int AS n FROM order_attempt_log WHERE ip_address = $1`, [from]);
      expect(log.rows[0].n).toBe(1); // SEC-005: the real client IP reached the DB
    });
  });

  test('delivery: the fee comes from the city in the DB; a zone id or an amount in the body is refused', async ({ request }) => {
    const { p, day, slot, z } = await withDb(async (c) => ({
      p: await product(c), day: await db.freshDay(c, { oven: 100, work: 100 }), slot: await lastSlot(c), z: await zone(c, 31.5),
    }));
    const res = await post(request, body(p, day, slot, { fulfillment: 'delivery', city: z.city, address: 'QA street 1' }));
    expect(res.status()).toBe(201);
    await withDb(async (c) => {
      const row = await orderByToken(c, (await res.json()).token);
      expect([Number(row.subtotal_displayed), Number(row.delivery_fee_displayed), Number(row.total_displayed)]).toEqual([20, 31.5, 51.5]);
      expect(row.delivery_zone_id).toBe(z.id);
      expect(row.delivery_city).toBe(z.city);
    });
    for (const extra of [{ zoneId: z.id }, { total: 1 }, { deliveryFee: 0 }]) {
      const r = await post(request, body(p, day, slot, { fulfillment: 'delivery', city: z.city, address: 'x 1', ...extra }));
      expect(r.status(), JSON.stringify(extra)).toBe(400);
      expect((await r.json()).error).toBe('invalid_input');
    }
    const unknown = await post(request, body(p, day, slot, { fulfillment: 'delivery', city: 'No Such City', address: 'x 1' }));
    expect(unknown.status()).toBe(409);
    expect(await unknown.json()).toEqual({ error: 'city_not_served' });
    await withDb((c) => c.query('UPDATE delivery_zones SET is_active = false WHERE id = $1', [z.id]));
    const inactive = await post(request, body(p, day, slot, { fulfillment: 'delivery', city: z.city, address: 'x 1' }));
    expect(await inactive.json()).toEqual({ error: 'city_not_served' });
  });

  test('same-origin only, and invalid input is 400 with the field names', async ({ request }) => {
    const { p, day, slot } = await withDb(async (c) => ({ p: await product(c), day: await db.freshDay(c, { oven: 100, work: 100 }), slot: await lastSlot(c) }));
    expect((await post(request, body(p, day, slot), { origin: 'https://evil.example' })).status()).toBe(403);
    expect((await post(request, body(p, day, slot), { origin: '' })).status()).toBe(403);
    const bad = await post(request, body(p, day, slot, { phone: '03-1234567', name: '' }));
    expect(bad.status()).toBe(400);
    expect((await bad.json()).fields.sort()).toEqual(['name', 'phone']);
    const notJson = await request.post('/api/orders', { data: 'nope', headers: { 'content-type': 'application/json', origin: 'http://localhost:3100' } });
    expect(notJson.status()).toBe(400);
  });

  test('capacity is the DB\'s: a full day is 409 day_full with pickAnotherDay, and the ledger does not move', async ({ request }) => {
    const { p, day, slot } = await withDb(async (c) => ({ p: await product(c, { oven: 30, work: 30 }), day: await db.freshDay(c, { oven: 100, work: 100 }), slot: await lastSlot(c) }));
    await withDb((c) => c.query('UPDATE capacity_day_ledger SET oven_minutes_reserved = 90, work_minutes_reserved = 10 WHERE day = $1', [day]));
    const before = await withDb((c) => db.ledger(c, day));
    const res = await post(request, body(p, day, slot, { items: [{ productId: p.id, quantity: 1 }] }));
    expect(res.status()).toBe(409);
    expect(await res.json()).toEqual({ error: 'day_full', pickAnotherDay: true });
    expect(await withDb((c) => db.ledger(c, day))).toEqual(before);

    const blackout = await withDb(async (c) => db.freshDay(c, { oven: 100, work: 100, blackout: true }));
    expect(await (await post(request, body(p, blackout, slot))).json()).toEqual({ error: 'day_full', pickAnotherDay: true });
    expect(await (await post(request, body(p, '2099-01-01', slot))).json()).toEqual({ error: 'day_full', pickAnotherDay: true });
  });

  test('unpaid-holds cap, single-order cap, too-soon slot and a paused product each get their own answer', async ({ request }) => {
    const { p, day, slot } = await withDb(async (c) => ({ p: await product(c, { oven: 10, work: 10 }), day: await db.freshDay(c, { oven: 100, work: 100 }), slot: await lastSlot(c) }));
    await withDb((c) => c.query('UPDATE capacity_day_ledger SET oven_minutes_reserved = 65, oven_minutes_unpaid_reserved = 65 WHERE day = $1', [day]));
    const one = { items: [{ productId: p.id, quantity: 1 }] };
    expect(await (await post(request, body(p, day, slot, one))).json()).toEqual({ error: 'day_almost_full', pickAnotherDay: true });

    const roomy = await withDb((c) => db.freshDay(c, { oven: 100, work: 100 }));
    const big = await post(request, body(p, roomy, slot, { items: [{ productId: p.id, quantity: 4 }] }));
    expect(big.status()).toBe(409);
    expect(await big.json()).toEqual({ error: 'order_too_big' });

    const today = await withDb(async (c) => {
      const d = (await c.query(`SELECT fn_business_date(now())::text AS d`)).rows[0].d;
      await c.query(`INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total) VALUES ($1, 500, 500) ON CONFLICT (day) DO NOTHING`, [d]);
      return d;
    });
    expect(await (await post(request, body(p, today, slot, one))).json()).toEqual({ error: 'too_soon', pickAnotherDay: true });

    expect(await (await post(request, body(p, roomy, crypto.randomUUID(), one))).json()).toEqual({ error: 'slot_unavailable' });

    await withDb((c) => c.query('UPDATE products SET is_available = false WHERE id = $1', [p.id]));
    expect(await (await post(request, body(p, roomy, slot, one))).json()).toEqual({ error: 'product_unavailable' });
  });

  test('rate limits (SEC-005): 3 orders per IP per hour, 2 open orders per phone', async ({ request }) => {
    const { p, day, slot } = await withDb(async (c) => ({ p: await product(c, { oven: 1, work: 1 }), day: await db.freshDay(c, { oven: 1000, work: 1000 }), slot: await lastSlot(c) }));
    const one = { items: [{ productId: p.id, quantity: 1 }] };
    const from = ip();
    for (let i = 0; i < 3; i += 1) expect((await post(request, body(p, day, slot, one), { from })).status()).toBe(201);
    const fourth = await post(request, body(p, day, slot, one), { from });
    expect(fourth.status()).toBe(429);
    expect(await fourth.json()).toEqual({ error: 'too_many_attempts' });

    const tel = phone();
    for (let i = 0; i < 2; i += 1) expect((await post(request, body(p, day, slot, { ...one, phone: tel }))).status()).toBe(201);
    const third = await post(request, body(p, day, slot, { ...one, phone: tel }));
    expect(third.status()).toBe(429);
    expect(await third.json()).toEqual({ error: 'too_many_open_orders' });
  });

  test('fn_create_standard_order is server-side only: anon and a signed-in user are refused through PostgREST, the service role is not', async () => {
    const env = localEnv();
    const { p, day, slot } = await withDb(async (c) => ({ p: await product(c), day: await db.freshDay(c, { oven: 100, work: 100 }), slot: await lastSlot(c) }));
    const args = {
      p_ip_address: ip(), p_customer_id: null, p_guest_name: 'QA', p_guest_phone: `+97250${crypto.randomInt(1000000, 9999999)}`, p_guest_email: null,
      p_fulfillment_type: 'pickup', p_delivery_date: day, p_delivery_slot_id: slot, p_delivery_address: null, p_delivery_city: null, p_delivery_notes: null,
      p_items: [{ product_id: p.id, quantity: 1 }], p_lookup_token: crypto.randomBytes(16).toString('base64url'),
      p_privacy_notice_version: VERSIONS.privacy, p_terms_version: VERSIONS.terms, p_cancellation_notice_version: VERSIONS.cancellation,
    };
    const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const denied = await anon.rpc('fn_create_standard_order', args);
    expect(denied.error?.message).toContain('permission denied');
    const privileges = await withDb(async (c) => (await c.query(`
      SELECT has_function_privilege('anon', 'fn_create_standard_order(text,uuid,text,text,text,text,date,uuid,text,text,text,jsonb,text,text,text,text)', 'execute') AS a,
             has_function_privilege('authenticated', 'fn_create_standard_order(text,uuid,text,text,text,text,date,uuid,text,text,text,jsonb,text,text,text,text)', 'execute') AS u`)).rows[0]);
    expect(privileges).toEqual({ a: false, u: false });
    const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const ok = await service.rpc('fn_create_standard_order', args);
    expect(ok.error).toBeNull();
    expect(ok.data.status).toBe('payment_pending');
  });
});

// ---------------------------------------------------------------------------
// Read paths: GET /api/orders/[token], GET /api/delivery-zones, payment links
// ---------------------------------------------------------------------------
test.describe('api-003 read paths', () => {
  test('GET /api/orders/[token]: the order view without PII; any other key gets the identical 404', async ({ request }) => {
    const { p, day, slot, z } = await withDb(async (c) => ({ p: await product(c), day: await db.freshDay(c, { oven: 100, work: 100 }), slot: await lastSlot(c), z: await zone(c, 20) }));
    const created = await post(request, body(p, day, slot, { fulfillment: 'delivery', city: z.city, address: 'Secret street 7', email: 'secret@example.test', notes: 'gate code 1234' }));
    const { token } = await created.json();
    const res = await request.get(`/api/orders/${token}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['referrer-policy']).toBe('no-referrer');
    expect(res.headers()['x-robots-tag']).toContain('noindex');
    const view = await res.json();
    expect(view).toMatchObject({ status: 'payment_pending', fulfillment: 'delivery', day, city: z.city, subtotal: 20, deliveryFee: 20, total: 40 });
    expect(view.items).toEqual([{ name: p.name, quantity: 2, unitPrice: 10, lineTotal: 20 }]);
    expect(JSON.stringify(view)).not.toMatch(/Secret street|secret@|gate code|QA Guest|\+972/);

    const row = await withDb((c) => orderByToken(c, token));
    const miss = await request.get(`/api/orders/${crypto.randomBytes(16).toString('base64url')}`);
    const answers = [miss];
    for (const key of [row.order_number, row.id, 'x', token.slice(0, 21)]) answers.push(await request.get(`/api/orders/${encodeURIComponent(key)}`));
    for (const a of answers) {
      expect(a.status()).toBe(404);
      expect(await a.json()).toEqual({ error: 'not_found' });
    }
    await withDb((c) => c.query(`UPDATE orders SET lookup_token_expires_at = now() - interval '1 minute' WHERE id = $1`, [row.id]));
    expect((await request.get(`/api/orders/${token}`)).status()).toBe(404);
  });

  test('GET /api/delivery-zones: active zones with fee and cities, inactive ones hidden', async ({ request }) => {
    const [on, off] = await withDb(async (c) => {
      const a = await zone(c, 15);
      const b = await zone(c, 5);
      await c.query('UPDATE delivery_zones SET is_active = false WHERE id = $1', [b.id]);
      return [a, b];
    });
    const res = await request.get('/api/delivery-zones');
    expect(res.status()).toBe(200);
    const { zones } = await res.json();
    expect(zones.find((z) => z.id === on.id)).toEqual({ id: on.id, name: on.name, fee: 15, cities: [on.city] });
    expect(zones.find((z) => z.id === off.id)).toBeUndefined();
  });

  test('payment links (SEC-009): anon cannot read them; only the service role reads the whitelist', async () => {
    const env = localEnv();
    const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const rows = await anon.from('app_settings').select('key').like('key', 'payment_link%');
    expect(rows.data ?? []).toEqual([]);
    const other = await anon.from('app_settings').select('key').eq('key', 'payment_pending_expiry_hours_standard');
    expect(other.data).toHaveLength(1); // other keys keep their visibility
    expect((await anon.rpc('fn_payment_link_settings')).error?.message).toContain('permission denied');
    const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const ok = await service.rpc('fn_payment_link_settings');
    expect(ok.error).toBeNull();
    expect(Object.keys(ok.data).sort()).toEqual(['bit', 'paybox']);
  });
});
