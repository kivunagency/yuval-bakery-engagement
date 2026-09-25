// @ts-check
// Checkout and payment (session E): api-003 POST /api/orders and the read
// paths, client-003 the checkout screen, client-004 the order/payment page. Needs the local stack (npm run
// stack:up) and a production build (npm run build).
//
// API tests use far-future days of their own (no shared state). Screen tests
// need days inside the 14-day strip: offsets 4..7 are reshaped for the test
// and restored afterwards, with the test's own orders removed (catalog tests
// use offsets 9..12).
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const { join } = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { localEnv } = require('./helpers/env');
const db = require('./helpers/db');
const { checkPublicBaseline, SCREENS } = require('./helpers/baseline');

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

// ---------------------------------------------------------------------------
// Screens. Days 4..7 of the strip are reshaped and restored.
// ---------------------------------------------------------------------------
async function withStripDays(fn) {
  const setup = await withDb(async (c) => {
    const today = (await c.query(`SELECT fn_business_date(now())::text AS d`)).rows[0].d;
    const days = [4, 5, 6, 7].map((n) => {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    });
    const saved = (await c.query('SELECT * FROM capacity_day_ledger WHERE day = ANY($1::date[])', [days])).rows;
    await c.query('DELETE FROM capacity_day_ledger WHERE day = ANY($1::date[])', [days]);
    for (const d of days) await c.query(`INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total) VALUES ($1, 300, 300)`, [d]);
    const p = await product(c, { price: 14, oven: 5, work: 5 });
    const z = await zone(c, 35);
    return { days, saved, p, z };
  });
  try {
    return await fn(setup);
  } finally {
    await withDb(async (c) => {
      await c.query(`DELETE FROM orders WHERE delivery_date = ANY($1::date[]) AND guest_name LIKE 'QA %'`, [setup.days]);
      await c.query('DELETE FROM capacity_day_ledger WHERE day = ANY($1::date[])', [setup.days]);
      for (const r of setup.saved) {
        await c.query(
          `INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total, oven_minutes_reserved, work_minutes_reserved,
             oven_minutes_unpaid_reserved, work_minutes_unpaid_reserved, is_blackout, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [r.day, r.oven_minutes_total, r.work_minutes_total, r.oven_minutes_reserved, r.work_minutes_reserved,
            r.oven_minutes_unpaid_reserved, r.work_minutes_unpaid_reserved, r.is_blackout, r.source],
        );
      }
      await c.query('UPDATE products SET is_published = false WHERE id = $1', [setup.p.id]);
      await c.query('DELETE FROM delivery_zones WHERE id = $1', [setup.z.id]);
    });
  }
}

async function withCart(page, cart) {
  // Each test is its own client for the SEC-005 per-IP limit (3 orders an
  // hour): Netlify sets this header in production, the local server does not.
  await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': ip() });
  await page.addInitScript(([key, value]) => {
    if (!window.sessionStorage.getItem('qa.cart.set')) {
      window.sessionStorage.setItem(key, value);
      window.sessionStorage.setItem('qa.cart.set', '1');
    }
  }, [CART_KEY, JSON.stringify(cart)]);
}

async function fillGuest(page, { name = 'QA Screen', tel = phone() } = {}) {
  await page.fill('#name', name);
  await page.fill('#phone', tel);
}

test.describe('client-003: checkout screen', () => {
  test('baseline (RTL, CSP, 44px, 390px, fonts, no console errors) with a cart; the first frame carries its data', async ({ page, request }) => {
    await withStripDays(async ({ days, p }) => {
      const html = await (await request.get('/checkout')).text();
      expect(html).toContain(p.name); // server-rendered products (the cart lines are matched in the browser)
      expect(html).toMatch(/data-state="too_soon"/);
      await withCart(page, { day: days[0], lines: [{ productId: p.id, quantity: 2 }] });
      await checkPublicBaseline(page, '/checkout', 'checkout-light');
    });
  });

  test('empty cart: a way back to the catalog, no form', async ({ page }) => {
    await page.goto('/checkout');
    await expect(page.getByTestId('checkout-empty')).toBeVisible();
    await expect(page.getByTestId('checkout-form')).toHaveCount(0);
  });

  test('compliance order: privacy notice before the first personal field; fee, total, cancellation notice and business details before the submit button', async ({ page }) => {
    await withStripDays(async ({ days, p }) => {
      await withCart(page, { day: days[0], lines: [{ productId: p.id, quantity: 1 }] });
      await page.goto('/checkout');
      const order = await page.evaluate(() => {
        const all = [...document.querySelectorAll('[data-testid], input, select, textarea, button[type=submit]')];
        const at = (sel) => all.indexOf(document.querySelector(sel));
        return {
          notice: at('[data-testid="privacy-notice-at-collection"]'), city: at('#city'), address: at('#address'), name: at('#name'), phone: at('#phone'),
          summary: at('[data-testid="summary"]'), cancel: at('[data-testid="cancellation-exemption-notice"]'),
          biz: at('[data-testid="business-details-summary"]'), submit: at('[data-testid="checkout-submit"]'), hint: at('[data-testid="notes-field-hint"]'), notes: at('#notes'),
        };
      });
      expect(order.notice).toBeGreaterThan(-1);
      for (const k of ['city', 'address', 'name', 'phone']) expect(order.notice, k).toBeLessThan(order[k]);
      for (const k of ['summary', 'cancel', 'biz']) expect(order[k], k).toBeLessThan(order.submit);
      expect(order.hint).toBeGreaterThan(order.notes);
      await expect(page.locator('[data-testid="privacy-notice-at-collection"]')).toHaveAttribute('data-context', 'checkout');
      await expect(page.locator('#notes')).toHaveAttribute('aria-describedby', /notes-hint/);
    });
  });

  test('delivery: choosing a city shows its zone fee at once (aria-live), the total follows, and the order page shows the same total', async ({ page }) => {
    await withStripDays(async ({ days, p, z }) => {
      await withCart(page, { day: days[1], lines: [{ productId: p.id, quantity: 3 }] });
      await page.goto('/checkout');
      await expect(page.locator(`[data-day="${days[1]}"]`)).toHaveAttribute('aria-checked', 'true'); // the cart's day
      await expect(page.getByTestId('zone-fee')).toHaveAttribute('aria-live', 'polite');
      await page.selectOption('#city', z.city);
      await expect(page.getByTestId('zone-fee')).toContainText(z.name);
      await expect(page.getByTestId('zone-fee')).toContainText('35');
      await expect(page.getByTestId('summary-total')).toContainText('77'); // 3 x 14 + 35
      await page.locator('[data-testid="slots"] button:not([disabled])').first().click();
      await page.fill('#address', 'QA street 3');
      await fillGuest(page);
      await page.screenshot({ path: join(SCREENS, 'checkout-filled.png'), fullPage: true });
      await page.getByTestId('checkout-submit').click();
      await page.waitForURL(/\/order\/[A-Za-z0-9_-]{22}$/);
      const token = page.url().split('/order/')[1];
      const view = await (await page.request.get(`/api/orders/${token}`)).json();
      expect([view.subtotal, view.deliveryFee, view.total]).toEqual([42, 35, 77]); // the DB's total = the preview
      await expect(page.getByTestId('order-total')).toContainText('77'); // client-004: the page shows it
      expect(await page.evaluate((k) => window.sessionStorage.getItem(k), CART_KEY)).toBe(JSON.stringify({ day: null, lines: [] }));
    });
  });

  test('"my city is not listed" switches to pickup with an explanation', async ({ page }) => {
    await withStripDays(async ({ days, p }) => {
      await withCart(page, { day: days[0], lines: [{ productId: p.id, quantity: 1 }] });
      await page.goto('/checkout');
      await page.selectOption('#city', '__not_listed__');
      await expect(page.getByTestId('city-not-covered')).toBeVisible();
      await expect(page.getByRole('button', { name: /איסוף עצמי/ })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#city')).toHaveCount(0);
    });
  });

  test('client-side checks name the fields; nothing is sent until they pass', async ({ page }) => {
    await withStripDays(async ({ days, p }) => {
      await withCart(page, { day: days[0], lines: [{ productId: p.id, quantity: 1 }] });
      const calls = [];
      page.on('request', (r) => r.url().includes('/api/orders') && calls.push(r.url()));
      await page.goto('/checkout');
      await page.getByRole('button', { name: /איסוף עצמי/ }).click();
      await page.fill('#phone', '03-1234567');
      await page.getByTestId('checkout-submit').click();
      await expect(page.locator('#phone')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#name')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#slot-error')).toBeVisible();
      expect(calls).toEqual([]);
    });
  });

  test('the day fills up after the page loaded: the DB refuses, the screen says so, shows fresh day states and nothing is booked', async ({ page }) => {
    await withStripDays(async ({ days, p }) => {
      await withCart(page, { day: days[2], lines: [{ productId: p.id, quantity: 1 }] });
      await page.goto('/checkout');
      await page.getByRole('button', { name: /איסוף עצמי/ }).click();
      await page.locator('[data-testid="slots"] button:not([disabled])').first().click();
      await fillGuest(page);
      await withDb((c) => c.query('UPDATE capacity_day_ledger SET oven_minutes_reserved = 300, work_minutes_reserved = 300 WHERE day = $1', [days[2]]));
      const before = await withDb((c) => db.ledger(c, days[2]));
      await page.getByTestId('checkout-submit').click();
      await expect(page.getByTestId('pick-another-day')).toBeVisible();
      await expect(page.getByTestId('checkout-error')).toHaveAttribute('data-error', 'day_full');
      await expect(page.locator(`[data-day="${days[2]}"]`)).toHaveAttribute('data-state', 'full');
      await expect(page.locator(`[data-day="${days[2]}"]`)).toHaveAttribute('aria-checked', 'false');
      expect(page.url()).toContain('/checkout');
      expect(await withDb((c) => db.ledger(c, days[2]))).toEqual(before);
      await page.screenshot({ path: join(SCREENS, 'checkout-day-gone.png'), fullPage: true });
    });
  });
});

// ---------------------------------------------------------------------------
// client-004: the order and payment page
// ---------------------------------------------------------------------------
async function newOrder(request, fulfillment = 'pickup') {
  const made = await withDb(async (c) => ({ p: await product(c, { price: 14 }), day: await db.freshDay(c, { oven: 100, work: 100 }), slot: await lastSlot(c), z: await zone(c, 25) }));
  const extra = fulfillment === 'delivery' ? { fulfillment, city: made.z.city, address: 'QA street 9' } : {};
  const res = await post(request, body(made.p, made.day, made.slot, extra));
  expect(res.status()).toBe(201);
  const { token } = await res.json();
  const row = await withDb((c) => orderByToken(c, token));
  return { token, row, ...made };
}

async function setLinks(bit, paybox) {
  await withDb((c) => c.query(
    `UPDATE app_settings SET value = CASE key WHEN 'payment_link_bit' THEN $1::jsonb ELSE $2::jsonb END WHERE key IN ('payment_link_bit', 'payment_link_paybox')`,
    [JSON.stringify(bit), JSON.stringify(paybox)]));
}

test.describe('client-004: order and payment page', () => {
  test.describe.configure({ mode: 'serial' }); // payment link settings are global

  test('baseline, no Referer and no indexing, order number big in a dashed frame, total, hold time, placeholders while links are unset', async ({ page, request }) => {
    await setLinks(null, null);
    const { token, row } = await newOrder(request, 'delivery');
    const res = await checkPublicBaseline(page, `/order/${token}`, 'order-light');
    expect(res.headers()['referrer-policy']).toBe('no-referrer');
    expect(res.headers()['x-robots-tag']).toContain('noindex');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);

    const code = page.getByTestId('order-number');
    await expect(code).toHaveText(row.order_number);
    const style = await code.evaluate((el) => {
      const s = getComputedStyle(el);
      const frame = getComputedStyle(el.parentElement);
      return { size: s.fontSize, family: s.fontFamily, border: frame.borderTopStyle, dir: getComputedStyle(el.firstElementChild).direction };
    });
    expect(style).toMatchObject({ size: '56px', border: 'dashed', dir: 'ltr' });
    expect(style.family).toContain('Karantina');
    await expect(page.getByTestId('order-total')).toContainText('53'); // 2 x 14 + 25
    await expect(page.getByTestId('hold-until')).toContainText(/\d{2}:\d{2}/);
    await expect(page.getByTestId('pay-bit-placeholder')).toContainText('[');
    await expect(page.getByTestId('pay-paybox-placeholder')).toContainText('[');
    await expect(page.locator('[data-testid="contact-block"]').first()).toContainText(row.order_number);
    await expect(page.getByTestId('business-details-summary')).toBeVisible();
    await expect(page.getByTestId('cancellation-exemption-notice')).toBeVisible();
    await expect(page.getByTestId('order-details')).not.toContainText('QA street');
  });

  test('with links set: two buttons of equal size and style, rel=noreferrer; a link off the allowlist stays a placeholder', async ({ page, request }) => {
    const { token } = await newOrder(request);
    try {
      await setLinks('https://www.bitpay.co.il/app/me/qa-test', 'https://payboxapp.page.link/qa-test');
      await page.goto(`/order/${token}`);
      const bit = page.getByTestId('pay-bit');
      const paybox = page.getByTestId('pay-paybox');
      await expect(bit).toHaveAttribute('href', 'https://www.bitpay.co.il/app/me/qa-test');
      await expect(paybox).toHaveAttribute('href', 'https://payboxapp.page.link/qa-test');
      for (const a of [bit, paybox]) await expect(a).toHaveAttribute('rel', /noreferrer/);
      const boxes = await Promise.all([bit, paybox].map((a) => a.evaluate((el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height), s.backgroundColor, s.borderTopWidth, s.fontSize];
      })));
      expect(boxes[0]).toEqual(boxes[1]);
      expect(boxes[0][1]).toBeGreaterThanOrEqual(56);
      await page.screenshot({ path: join(SCREENS, 'order-links-set.png'), fullPage: true });

      await setLinks('https://evil.example/pay', 'http://payboxapp.page.link/x');
      await page.reload();
      await expect(page.getByTestId('pay-bit-placeholder')).toBeVisible();
      await expect(page.getByTestId('pay-paybox-placeholder')).toBeVisible();
    } finally {
      await setLinks(null, null);
    }
  });

  test('copy button copies the order number', async ({ page, context, request }) => {
    const { token, row } = await newOrder(request);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/order/${token}`);
    await page.getByTestId('copy-order-number').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(row.order_number);
  });

  test('an order that is no longer waiting shows its status and no payment buttons', async ({ page, request }) => {
    const { token, row } = await newOrder(request);
    await withDb((c) => c.query(`SELECT fn_release_order_capacity($1, 'expired', 'system', 'qa')`, [row.id]));
    await page.goto(`/order/${token}`);
    await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'expired');
    await expect(page.locator('[data-testid^="pay-"]')).toHaveCount(0);
  });

  test('an unknown token, an order number or an id in the URL: the same 404', async ({ request }) => {
    const { row } = await newOrder(request);
    for (const key of [crypto.randomBytes(16).toString('base64url'), row.order_number, row.id]) {
      const r = await request.get(`/order/${encodeURIComponent(key)}`);
      expect(r.status(), key).toBe(404);
    }
  });
});
