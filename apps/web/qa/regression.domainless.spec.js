// @ts-check
// Regression: running without a verified sending domain (DEV and PROD until
// Yuval has a domain). CUSTOMER_EMAIL_ENABLED=false and
// CUSTOMER_ACCOUNTS_ENABLED=false, see lib/server/features.ts. The rest of the
// suite runs with both on (local default), so this file starts a second
// production server of the same build with both off, on its own port.
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { localEnv } = require('./helpers/env');
const db = require('./helpers/db');

const PORT = Number(process.env.DOMAINLESS_PORT || 3102);
const BASE = `http://localhost:${PORT}`;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** @type {import('node:child_process').ChildProcess | undefined} */
let server;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, ...localEnv(), CUSTOMER_EMAIL_ENABLED: 'false', CUSTOMER_ACCOUNTS_ENABLED: 'false' },
    stdio: 'ignore',
    detached: true,
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).status < 500) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server on ${PORT} did not start`);
});

test.afterAll(() => {
  if (server?.pid) process.kill(-server.pid, 'SIGTERM');
});

const headers = () => ({ 'content-type': 'application/json', origin: BASE, 'x-nf-client-connection-ip': db.randomIp() });

test.describe('customer accounts off', () => {
  test('account pages, the confirm link and sign-up answer 404; the footer has no account link', async ({ page, request }) => {
    for (const path of ['/register', '/account', '/account/login', '/account/welcome', '/account/confirm?token_hash=x&type=email']) {
      const res = await request.get(`${BASE}${path}`, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
    }
    const signUp = await request.post(`${BASE}/api/customers`, { data: { email: 'qa@example.test' }, headers: headers() });
    expect(signUp.status()).toBe(404);

    await page.goto(`${BASE}/`);
    const footer = page.getByTestId('site-footer');
    await expect(footer.locator('a[href="/find-order"]')).toHaveCount(1);
    await expect(footer.locator('a[href="/account"]')).toHaveCount(0);
  });

  test('unsubscribe keeps working: withdrawing consent never depends on the flag', async ({ request }) => {
    const res = await request.get(`${BASE}/unsubscribe`);
    expect(res.status()).toBe(200);
  });
});

test.describe('customer email off', () => {
  test('checkout and the custom-cake form have no email field', async ({ page }) => {
    const productId = await db.withClient(async (c) => (await c.query(
      `INSERT INTO products (name, price_displayed, cost_basis, oven_minutes_cost, work_minutes_cost, allergens, allergens_confirmed, photo_alt, is_available, is_published)
       VALUES ($1, 10, 'per_unit', 5, 5, ARRAY['gluten'], true, 'qa domainless product', true, true) RETURNING id`,
      [`qa domainless ${crypto.randomUUID().slice(0, 8)}`],
    )).rows[0].id);
    // the checkout form shows only with a cart (sessionStorage, client-001)
    await page.addInitScript((cart) => window.sessionStorage.setItem('yb.cart.v1', cart), JSON.stringify({ day: null, lines: [{ productId, quantity: 1 }] }));
    await page.goto(`${BASE}/checkout`);
    await expect(page.locator('#name')).toBeVisible();
    await expect(page.locator('input[type="email"]')).toHaveCount(0);
    await page.goto(`${BASE}/custom-cake`);
    await expect(page.locator('input[name="phone"]')).toBeVisible();
    await expect(page.locator('input[type="email"]')).toHaveCount(0);
  });

  test('an email sent anyway is not stored, and the customer mail is never attempted', async ({ request }) => {
    const made = await db.withClient(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO products (name, price_displayed, cost_basis, oven_minutes_cost, work_minutes_cost, allergens, allergens_confirmed, photo_alt, is_available, is_published)
         VALUES ($1, 10, 'per_unit', 5, 5, ARRAY['gluten'], true, 'qa domainless product', true, true) RETURNING id`,
        [`qa domainless ${crypto.randomUUID().slice(0, 8)}`],
      );
      const slot = (await c.query(`SELECT id::text FROM time_slots WHERE is_active ORDER BY start_time DESC LIMIT 1`)).rows[0].id;
      return { productId: rows[0].id, day: await db.freshDay(c, { oven: 100, work: 100 }), slot };
    });
    const res = await request.post(`${BASE}/api/orders`, {
      headers: headers(),
      data: { items: [{ productId: made.productId, quantity: 1 }], day: made.day, slotId: made.slot, fulfillment: 'pickup', name: 'QA Domainless', phone: `050${crypto.randomInt(1000000, 9999999)}`, email: 'qa-domainless@example.test' },
    });
    expect(res.status()).toBe(201);
    const { token } = await res.json();

    const order = await db.withClient(async (c) => (await c.query(`SELECT id, guest_email FROM orders WHERE lookup_token_hash = $1`, [sha256(token)])).rows[0]);
    expect(order.guest_email).toBeNull();

    // after() runs once the response is out: wait for the customer's row.
    await expect
      .poll(async () => db.withClient(async (c) => (await c.query(
        `SELECT status, reason FROM notification_attempts WHERE entity_id = $1 AND audience = 'customer' AND channel = 'email'`,
        [order.id],
      )).rows), { timeout: 15_000 })
      .toEqual([{ status: 'skipped', reason: 'no_customer_email' }]);

    const cake = await request.post(`${BASE}/api/custom-cake-requests`, {
      headers: headers(),
      data: {
        name: 'QA Domainless Cake', phone: `050${crypto.randomInt(1000000, 9999999)}`, email: 'qa-cake@example.test', whatsappFollowupOk: true,
        desiredDate: await db.withClient(async (c) => (await c.query(`SELECT (fn_earliest_delivery_date(now()) + 45)::text AS d`)).rows[0].d),
        inscription: 'QA', notes: 'QA', uploadRightsConfirmed: true, photos: [],
      },
    });
    expect(cake.status()).toBe(201);
    const { requestId } = await cake.json();
    await db.withClient(async (c) => {
      expect((await c.query(`SELECT requester_email FROM custom_cake_requests WHERE id = $1`, [requestId])).rows[0].requester_email).toBeNull();
      await c.query(`DELETE FROM custom_cake_requests WHERE id = $1`, [requestId]);
    });
  });
});
