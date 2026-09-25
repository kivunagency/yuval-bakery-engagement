// @ts-check
// Admin orders domain regression (api-004 order actions, client-009 orders
// screen and the SEC-006 "release all unpaid of a day" tool).
// Real chain: Next.js route -> admin's own aal2 JWT -> DB functions
// (fn_mark_order_paid, fn_cancel_order, fn_mark_order_fulfilled). Orders are
// created through the real checkout function (fn_create_standard_order) on a
// day and a product of their own, so runs never share state.
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const { join } = require('node:path');
const { Client } = require('pg');
const { createUser, db, randomIp, uiLogin } = require('./helpers/admin-ui');
const { withClient, freshDay, freshProduct, orderArgs, CREATE_ORDER_SQL, ledger } = require('./helpers/db');
const { localEnv } = require('./helpers/env');

const SCREENS = join(__dirname, '..', 'test-results', 'screens');

/** A guest pickup order holding `oven`/`work` minutes on a fresh day (or `day`). email: optional guest email. */
async function newOrder({ oven = 10, work = 20, email = null, day = null, price = 40, name = 'QA Guest', phone = null } = {}) {
  return withClient(async (c) => {
    const d = day ?? (await freshDay(c, { oven: 600, work: 600 }));
    const product = await freshProduct(c, { oven, work, price });
    const args = orderArgs(d, product, 1);
    args[2] = name;
    if (phone) args[3] = phone;
    args[4] = email;
    const { rows } = await c.query(CREATE_ORDER_SQL, args);
    return { ...rows[0], day: d, phone: args[3] };
  });
}

const freshTestDay = (oven = 600, work = 600) => withClient((c) => freshDay(c, { oven, work }));

const status = async (id) => (await db('SELECT status FROM orders WHERE id = $1', [id]))[0].status;
const lastAudit = async (id, action) =>
  (await db('SELECT actor_type, actor_id FROM audit_log WHERE entity_id = $1 AND action = $2 ORDER BY id DESC LIMIT 1', [id, action]))[0];

test.describe('POST /api/admin/orders/[id]/* (api-004)', () => {
  const ACTIONS = ['mark-paid', 'cancel', 'mark-fulfilled'];

  test('anonymous visitor and an admin without TOTP (aal1) get 401 and nothing changes', async ({ page, request, baseURL }) => {
    const order = await newOrder();
    for (const a of ACTIONS) {
      const r = await request.post(`/api/admin/orders/${order.id}/${a}`, { headers: { origin: baseURL ?? '' } });
      expect(r.status(), a).toBe(401);
      expect(await r.json()).toEqual({ error: 'unauthorized' });
    }
    const admin = await createUser({ admin: true, withTotp: true });
    await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
    await page.goto('/admin/login');
    await page.getByLabel('אימייל').fill(admin.email);
    await page.getByLabel('סיסמה').fill(admin.password);
    await page.getByRole('button', { name: 'כניסה', exact: true }).click();
    await page.waitForURL('**/admin/login/verify');
    for (const a of ACTIONS) {
      expect((await page.request.post(`/api/admin/orders/${order.id}/${a}`, { headers: { origin: baseURL ?? '' } })).status(), a).toBe(401);
    }
    expect(await status(order.id)).toBe('payment_pending');
  });

  test('admin at aal2: Origin check, Zod contract, 404 for an unknown order', async ({ page, baseURL }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const api = page.request;
    const headers = { origin: baseURL ?? '' };
    const order = await newOrder();

    for (const a of ACTIONS) {
      // CSRF: no Origin, or a foreign one, is refused even with a valid session.
      expect((await api.post(`/api/admin/orders/${order.id}/${a}`)).status(), a).toBe(403);
      expect((await api.post(`/api/admin/orders/${order.id}/${a}`, { headers: { origin: 'https://evil.example' } })).status(), a).toBe(403);
      // Zod: the id must be a UUID; the body is empty or {}; nothing else is accepted.
      for (const [path, data] of [
        [`/api/admin/orders/not-a-uuid/${a}`, undefined],
        [`/api/admin/orders/${order.id}/${a}`, { amount: 1 }],
        [`/api/admin/orders/${order.id}/${a}`, { adminId: admin.userId }],
        [`/api/admin/orders/${order.id}/${a}`, 'not json'],
      ]) {
        const r = await api.post(path, { headers: { ...headers, 'content-type': 'application/json' }, data });
        expect(r.status(), `${a} ${JSON.stringify(data)}`).toBe(400);
        expect(await r.json()).toEqual({ error: 'invalid_input' });
      }
      const missing = await api.post(`/api/admin/orders/${crypto.randomUUID()}/${a}`, { headers });
      expect(missing.status(), a).toBe(404);
      expect(await missing.json()).toEqual({ error: 'not_found' });
    }
    expect(await status(order.id)).toBe('payment_pending');
  });

  test('mark paid: payment_pending -> paid, unpaid hold becomes paid, audited as the admin; twice is a 409', async ({ page, baseURL }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const headers = { origin: baseURL ?? '' };
    const order = await newOrder({ oven: 10, work: 20 });
    const before = await withClient((c) => ledger(c, order.day));
    expect(before.oven_minutes_unpaid_reserved).toBe(10);

    const r = await page.request.post(`/api/admin/orders/${order.id}/mark-paid`, { headers, data: {} });
    expect(r.status()).toBe(200);
    expect(await r.json()).toEqual({ id: order.id, orderNumber: order.order_number, status: 'paid' });
    const after = await withClient((c) => ledger(c, order.day));
    expect(after).toMatchObject({ oven_minutes_reserved: 10, oven_minutes_unpaid_reserved: 0, work_minutes_reserved: 20, work_minutes_unpaid_reserved: 0 });
    expect(await lastAudit(order.id, 'order.marked_paid')).toEqual({ actor_type: 'admin', actor_id: admin.userId });

    const again = await page.request.post(`/api/admin/orders/${order.id}/mark-paid`, { headers });
    expect(again.status()).toBe(409);
    expect(await again.json()).toEqual({ error: 'invalid_transition', status: 'paid' });
    expect(await withClient((c) => ledger(c, order.day))).toEqual(after);
  });

  test('cancel: releases the held minutes exactly once, from payment_pending and from paid', async ({ page, baseURL }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const headers = { origin: baseURL ?? '' };

    const unpaid = await newOrder({ oven: 12, work: 7 });
    const r1 = await page.request.post(`/api/admin/orders/${unpaid.id}/cancel`, { headers });
    expect(r1.status()).toBe(200);
    expect((await r1.json()).status).toBe('cancelled');
    const released = await withClient((c) => ledger(c, unpaid.day));
    expect(released).toMatchObject({ oven_minutes_reserved: 0, oven_minutes_unpaid_reserved: 0, work_minutes_reserved: 0, work_minutes_unpaid_reserved: 0 });
    expect(await lastAudit(unpaid.id, 'order.cancelled')).toEqual({ actor_type: 'admin', actor_id: admin.userId });
    const twice = await page.request.post(`/api/admin/orders/${unpaid.id}/cancel`, { headers });
    expect(twice.status()).toBe(409);
    expect(await twice.json()).toEqual({ error: 'invalid_transition', status: 'cancelled' });
    expect(await withClient((c) => ledger(c, unpaid.day))).toEqual(released);

    // A paid order can be cancelled too (refund is Yuval's, outside the app); its minutes come back.
    const paid = await newOrder({ oven: 5, work: 5 });
    expect((await page.request.post(`/api/admin/orders/${paid.id}/mark-paid`, { headers })).status()).toBe(200);
    expect((await page.request.post(`/api/admin/orders/${paid.id}/cancel`, { headers })).status()).toBe(200);
    expect(await withClient((c) => ledger(c, paid.day))).toMatchObject({ oven_minutes_reserved: 0, work_minutes_reserved: 0 });

    // Nothing from a terminal state: an expired order cannot be paid or cancelled here (no automatic re-activation, blindspot-005).
    const late = await newOrder();
    await db(`SELECT fn_release_order_capacity($1, 'expired', 'system', 'qa')`, [late.id]);
    for (const a of ['mark-paid', 'cancel', 'mark-fulfilled']) {
      const r = await page.request.post(`/api/admin/orders/${late.id}/${a}`, { headers });
      expect(r.status(), a).toBe(409);
      expect(await r.json()).toEqual({ error: 'invalid_transition', status: 'expired' });
    }
  });

  test('mark fulfilled: only from paid; a guest with no email is refused (409, not 500) until the confirmation was delivered (US-0c)', async ({ page, baseURL }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const headers = { origin: baseURL ?? '' };

    const noEmail = await newOrder();
    const early = await page.request.post(`/api/admin/orders/${noEmail.id}/mark-fulfilled`, { headers });
    expect(early.status()).toBe(409);
    expect(await early.json()).toEqual({ error: 'invalid_transition', status: 'payment_pending' });

    expect((await page.request.post(`/api/admin/orders/${noEmail.id}/mark-paid`, { headers })).status()).toBe(200);
    const blocked = await page.request.post(`/api/admin/orders/${noEmail.id}/mark-fulfilled`, { headers });
    expect(blocked.status()).toBe(409);
    expect(await blocked.json()).toEqual({ error: 'confirmation_required', status: 'paid' });
    expect(await status(noEmail.id)).toBe('paid');

    // Recording the delivery is wave 3's screen; here the fact is set directly, as that screen will through fn_record_order_confirmation_delivered.
    await db(`UPDATE orders SET confirmation_delivered_at = now(), confirmation_channel = 'whatsapp_manual' WHERE id = $1`, [noEmail.id]);
    const ok = await page.request.post(`/api/admin/orders/${noEmail.id}/mark-fulfilled`, { headers });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).status).toBe('fulfilled');
    expect(await lastAudit(noEmail.id, 'order.marked_fulfilled')).toEqual({ actor_type: 'admin', actor_id: admin.userId });
    // Fulfilled keeps its minutes (the bake happened) and cannot be cancelled.
    expect((await withClient((c) => ledger(c, noEmail.day))).oven_minutes_reserved).toBe(10);
    expect((await page.request.post(`/api/admin/orders/${noEmail.id}/cancel`, { headers })).status()).toBe(409);

    const withEmail = await newOrder({ email: 'guest@example.test' });
    expect((await page.request.post(`/api/admin/orders/${withEmail.id}/mark-paid`, { headers })).status()).toBe(200);
    expect((await page.request.post(`/api/admin/orders/${withEmail.id}/mark-fulfilled`, { headers })).status()).toBe(200);
  });
});

test.describe('POST /api/admin/orders/release-unpaid (client-009, SEC-006)', () => {
  test('guards and contract: 401 anon, 403 Origin, 400 per bad body', async ({ page, request, baseURL }) => {
    const headers = { origin: baseURL ?? '' };
    expect((await request.post('/api/admin/orders/release-unpaid', { headers, data: { day: '2030-01-01' } })).status()).toBe(401);
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const api = page.request;
    expect((await api.post('/api/admin/orders/release-unpaid', { data: { day: '2030-01-01' } })).status()).toBe(403);
    expect((await api.post('/api/admin/orders/release-unpaid', { headers: { origin: 'https://evil.example' }, data: { day: '2030-01-01' } })).status()).toBe(403);
    for (const data of [{}, { day: '2030-02-30' }, { day: '2030-01-01', status: 'paid' }, { day: 20300101 }, 'not json']) {
      const r = await api.post('/api/admin/orders/release-unpaid', { headers: { ...headers, 'content-type': 'application/json' }, data });
      expect(r.status(), JSON.stringify(data)).toBe(400);
      expect(await r.json()).toEqual({ error: 'invalid_input' });
    }
  });

  test('cancels only the unpaid orders of that day, each released once and audited; paid and other days untouched', async ({ page, baseURL }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const headers = { origin: baseURL ?? '' };
    const day = await freshTestDay();
    const a = await newOrder({ day, oven: 10, work: 10 });
    const b = await newOrder({ day, oven: 20, work: 5 });
    const paid = await newOrder({ day, oven: 7, work: 3 });
    const other = await newOrder({ oven: 4, work: 4 });
    expect((await page.request.post(`/api/admin/orders/${paid.id}/mark-paid`, { headers })).status()).toBe(200);

    const r = await page.request.post('/api/admin/orders/release-unpaid', { headers, data: { day } });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.day).toBe(day);
    expect(body.released).toBe(2);
    expect([...body.orderNumbers].sort()).toEqual([a.order_number, b.order_number].sort());
    expect(await status(a.id)).toBe('cancelled');
    expect(await status(b.id)).toBe('cancelled');
    expect(await status(paid.id)).toBe('paid');
    expect(await status(other.id)).toBe('payment_pending');
    // Only the paid order still holds the day; nothing unpaid is left.
    expect(await withClient((c) => ledger(c, day))).toMatchObject({ oven_minutes_reserved: 7, oven_minutes_unpaid_reserved: 0, work_minutes_reserved: 3, work_minutes_unpaid_reserved: 0 });
    expect(await lastAudit(a.id, 'order.cancelled')).toEqual({ actor_type: 'admin', actor_id: admin.userId });
    expect(await lastAudit(day, 'orders.bulk_released_unpaid')).toEqual({ actor_type: 'admin', actor_id: admin.userId });

    const again = await page.request.post('/api/admin/orders/release-unpaid', { headers, data: { day } });
    expect(await again.json()).toEqual({ day, released: 0, orderNumbers: [] });
    expect(await withClient((c) => ledger(c, day))).toMatchObject({ oven_minutes_reserved: 7, work_minutes_reserved: 3 });
  });

  test('race with "mark paid" on the same order: whichever locks first wins, a paid order is never cancelled', async () => {
    const admin = await createUser({ admin: true, withTotp: false });
    const claims = JSON.stringify({ role: 'authenticated', sub: admin.userId, aal: 'aal2' });
    const connect = async () => {
      const c = new Client({ connectionString: localEnv().DATABASE_URL_TEST });
      await c.connect();
      return c;
    };
    const asAdmin = async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims]);
      await c.query('SET LOCAL ROLE authenticated');
    };

    // 1. Release locks the day's unpaid rows first: mark paid waits, then finds the order cancelled.
    {
      const day = await freshTestDay();
      const o = await newOrder({ day });
      const [c1, c2] = [await connect(), await connect()];
      await asAdmin(c1);
      const released = await c1.query('SELECT fn_admin_release_unpaid_for_day($1::date) AS r', [day]);
      expect(released.rows[0].r.released).toBe(1);
      await asAdmin(c2);
      const pay = c2.query('SELECT fn_mark_order_paid($1) AS ok', [o.id]);
      await new Promise((r) => setTimeout(r, 300)); // c2 is now blocked on the row lock
      await c1.query('COMMIT');
      expect((await pay).rows[0].ok).toBe(false);
      await c2.query('COMMIT');
      await Promise.all([c1.end(), c2.end()]);
      expect(await status(o.id)).toBe('cancelled');
      expect(await withClient((c) => ledger(c, day))).toMatchObject({ oven_minutes_reserved: 0, oven_minutes_unpaid_reserved: 0 });
    }
    // 2. Mark paid locks first: the release waits, re-reads the row, and skips it (no longer payment_pending).
    {
      const day = await freshTestDay();
      const o = await newOrder({ day, oven: 9, work: 9 });
      const [c1, c2] = [await connect(), await connect()];
      await asAdmin(c1);
      expect((await c1.query('SELECT fn_mark_order_paid($1) AS ok', [o.id])).rows[0].ok).toBe(true);
      await asAdmin(c2);
      const release = c2.query('SELECT fn_admin_release_unpaid_for_day($1::date) AS r', [day]);
      await new Promise((r) => setTimeout(r, 300));
      await c1.query('COMMIT');
      expect((await release).rows[0].r.released).toBe(0);
      await c2.query('COMMIT');
      await Promise.all([c1.end(), c2.end()]);
      expect(await status(o.id)).toBe('paid');
      expect(await withClient((c) => ledger(c, day))).toMatchObject({ oven_minutes_reserved: 9, oven_minutes_unpaid_reserved: 0 });
    }
  });

  test('a customer (authenticated, not admin) and aal1 admin cannot call the DB function; anon has no EXECUTE', async () => {
    const admin = await createUser({ admin: true, withTotp: false });
    const day = await freshTestDay();
    const o = await newOrder({ day });
    for (const claims of [{ sub: crypto.randomUUID(), aal: 'aal2' }, { sub: admin.userId, aal: 'aal1' }]) {
      await expect(
        withClient(async (c) => {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', ...claims })]);
          await c.query('SET LOCAL ROLE authenticated');
          try {
            return await c.query('SELECT fn_admin_release_unpaid_for_day($1::date)', [day]);
          } finally {
            await c.query('ROLLBACK');
          }
        }),
      ).rejects.toThrow(/admin_aal2_required/);
    }
    const [grants] = await db(`SELECT has_function_privilege('anon', 'fn_admin_release_unpaid_for_day(date)', 'execute') AS anon,
      has_function_privilege('authenticated', 'fn_admin_release_unpaid_for_day(date)', 'execute') AS auth`);
    expect(grants).toEqual({ anon: false, auth: true });
    expect(await status(o.id)).toBe('payment_pending');
  });
});

test.describe('admin orders screen (client-009)', () => {
  function collectErrors(page) {
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    return errors;
  }

  /** The baseline every admin screen shares (regression.admin.spec.js): RTL, fonts, no scroll at 390px, 44px targets, CSP, screenshot, no console errors. */
  async function baseline(page, res, name, errors) {
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'he');
    const scriptSrc = (res?.headers()['content-security-policy'] ?? '').split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(scriptSrc).not.toContain('unsafe-inline');
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('400 16px "IBM Plex Sans Hebrew"'))).toBe(true);
    expect(await page.evaluate(() => document.fonts.check('700 30px "Karantina"'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('a, button, input, select, textarea, [role="button"]')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && (r.width < 44 || r.height < 44);
        })
        .map((el) => el.outerHTML.slice(0, 80)),
    );
    expect(small).toEqual([]);
    await page.screenshot({ path: join(SCREENS, `admin-orders-${name}.png`), fullPage: true });
    expect(errors).toEqual([]);
  }

  test('waiting for payment: data on first render, phone LTR-isolated, WhatsApp template, mark paid shows the amount, holds and release', async ({ page }) => {
    const errors = collectErrors(page);
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const day = await freshTestDay(100, 100);
    const secretName = `Guest ${crypto.randomUUID().slice(0, 6)}`;
    const o = await newOrder({ day, oven: 30, work: 25, price: 185, name: secretName, phone: '+972501234567' });
    const o2 = await newOrder({ day, oven: 25, work: 10, price: 60 });

    // Screens arrive with their data: no client fetch to /api or PostgREST on load.
    const calls = [];
    page.on('request', (r) => (r.url().includes('/api/') || r.url().includes(':54321')) && calls.push(r.url()));
    const res = await page.goto(`/admin/orders?status=payment_pending&day=${day}`);
    expect(res?.status()).toBe(200);
    expect(calls).toEqual([]);
    await expect(page.getByTestId('day-filter')).toBeVisible();
    await expect(page.getByTestId('filter-payment_pending')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('filter-payment_pending')).toContainText('2');

    const card = page.locator(`[data-order="${o.order_number}"]`);
    await expect(card.getByTestId('order-status')).toHaveText('ממתינה לתשלום');
    await expect(card.getByRole('heading', { level: 2 })).toHaveText(`הזמנה ${o.order_number}`);
    await expect(card).toContainText(secretName);
    const phone = card.getByTestId('order-phone');
    await expect(phone).toHaveText('050-123-4567');
    expect(await phone.evaluate((el) => [getComputedStyle(el).direction, getComputedStyle(el).unicodeBidi])).toEqual(['ltr', 'isolate']);
    await expect(card.getByTestId('order-expires')).toContainText('אם לא תשולם, תפוג ב־');

    // SEC-024: fixed template, E.164 digits, URL-encoded, no customer free text (the name) in it.
    const href = await card.getByTestId('order-whatsapp').getAttribute('href');
    expect(href).toMatch(/^https:\/\/wa\.me\/972501234567\?text=/);
    const text = decodeURIComponent(new URL(href ?? '').searchParams.get('text') ?? '');
    expect(text).toContain(o.order_number);
    expect(text).toContain('185\u00a0₪'); // formatPrice keeps the number and the sign together
    expect(text).not.toContain(secretName);
    await expect(card.getByTestId('order-whatsapp')).toHaveAttribute('rel', 'noopener noreferrer');

    // Holds: this day is 55% held by unpaid orders (above the 50% alert line), with a release button.
    const holds = page.getByTestId(`holds-${day}`);
    await expect(holds).toContainText('55% מהיום מוחזק, ב־2 הזמנות');
    await expect(holds.locator('.admin-warn')).toBeVisible();

    await baseline(page, res, 'pending', errors);
    await card.screenshot({ path: join(SCREENS, 'admin-orders-card-pending.png') });
    await holds.screenshot({ path: join(SCREENS, 'admin-orders-holds.png') });
    await page.locator('.admin-orders-head').screenshot({ path: join(SCREENS, 'admin-orders-head.png') });
    await page.locator('.admin-filter').screenshot({ path: join(SCREENS, 'admin-orders-filter.png') });

    // Mark paid: the expected amount is shown large before anything is written (SEC-008).
    await card.getByTestId('mark-paid').click();
    const amount = card.getByTestId('expected-amount');
    await expect(amount).toHaveText('185 ₪');
    expect(await amount.evaluate((el) => [getComputedStyle(el).fontFamily.includes('Karantina'), parseFloat(getComputedStyle(el).fontSize)])).toEqual([true, 48]);
    await card.screenshot({ path: join(SCREENS, 'admin-orders-confirm-paid.png') });
    expect(await status(o.id)).toBe('payment_pending');
    await card.getByTestId('confirm-paid-yes').click();
    await expect(page.getByTestId('orders-done')).toHaveText(`הזמנה ${o.order_number} סומנה כשולמה.`);
    await expect(page.locator(`[data-order="${o.order_number}"]`)).toHaveCount(0);
    expect(await status(o.id)).toBe('paid');

    // Release the remaining unpaid order of the day, after a confirmation.
    await page.getByTestId(`release-${day}`).click();
    await expect(page.getByTestId(`release-confirm-${day}`)).toContainText('הזמנות ששולמו לא משתנות.');
    await page.getByTestId(`release-yes-${day}`).click();
    await expect(page.getByTestId('orders-done')).toHaveText('הזמנה אחת שלא שולמה שוחררה.');
    expect(await status(o2.id)).toBe('cancelled');
    expect(await status(o.id)).toBe('paid');
    await expect(page.getByTestId('orders-empty')).toBeVisible();
  });

  test('paid: a guest with no email shows the US-0c block, not a button; one with email can be fulfilled; cancel asks first', async ({ page, baseURL }) => {
    const errors = collectErrors(page);
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const headers = { origin: baseURL ?? '' };
    const day = await freshTestDay();
    const noEmail = await newOrder({ day });
    const withEmail = await newOrder({ day, email: 'guest@example.test' });
    for (const o of [noEmail, withEmail]) expect((await page.request.post(`/api/admin/orders/${o.id}/mark-paid`, { headers })).status()).toBe(200);

    const res = await page.goto(`/admin/orders?status=paid&day=${day}`);
    const blocked = page.locator(`[data-order="${noEmail.order_number}"]`);
    await expect(blocked.getByTestId('order-status')).toHaveText('שולמה');
    await expect(blocked.getByTestId('fulfil-blocked')).toContainText('אין אימייל בהזמנה הזאת');
    await expect(blocked.getByTestId('mark-fulfilled')).toHaveCount(0);
    await baseline(page, res, 'paid', errors);
    await blocked.screenshot({ path: join(SCREENS, 'admin-orders-card-blocked.png') });

    const ok = page.locator(`[data-order="${withEmail.order_number}"]`);
    await ok.getByTestId('mark-fulfilled').click();
    await expect(page.getByTestId('orders-done')).toHaveText(`הזמנה ${withEmail.order_number} סומנה כנמסרה.`);
    expect(await status(withEmail.id)).toBe('fulfilled');

    // If the DB still refuses (e.g. the page was stale), the words say why: no 500, no silent success.
    await db(`UPDATE orders SET guest_email = 'x@example.test' WHERE id = $1`, [noEmail.id]);
    await page.goto(`/admin/orders?status=paid&day=${day}`);
    await db(`UPDATE orders SET guest_email = NULL WHERE id = $1`, [noEmail.id]);
    await page.locator(`[data-order="${noEmail.order_number}"]`).getByTestId('mark-fulfilled').click();
    await expect(page.locator(`[data-order="${noEmail.order_number}"]`).getByTestId('order-error')).toHaveText(
      'אישור ההזמנה בכתב עוד לא הגיע ללקוח, ולכן אי אפשר לסמן אותה כנמסרה.',
    );
    expect(await status(noEmail.id)).toBe('paid');

    // Cancel a paid order: asks first and says the refund is outside the app.
    await page.goto(`/admin/orders?status=paid&day=${day}`);
    const c = page.locator(`[data-order="${noEmail.order_number}"]`);
    await c.getByTestId('cancel').click();
    await expect(c.getByTestId('confirm-cancel')).toContainText('את ההחזר עושים מחוץ לאפליקציה.');
    await c.getByTestId('confirm-cancel-yes').click();
    await expect(page.getByTestId('orders-done')).toHaveText(`הזמנה ${noEmail.order_number} בוטלה.`);
    expect(await status(noEmail.id)).toBe('cancelled');
  });

  test('expired and cancelled are different terminal states; expired carries the late-payment note (blindspot-005)', async ({ page }) => {
    const errors = collectErrors(page);
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const day = await freshTestDay();
    const exp = await newOrder({ day });
    const can = await newOrder({ day });
    await db(`SELECT fn_release_order_capacity($1, 'expired', 'system', 'qa')`, [exp.id]);
    await db(`SELECT fn_release_order_capacity($1, 'cancelled', 'admin', 'qa')`, [can.id]);

    // Default view: a banner points to recently expired orders of days still ahead.
    await page.goto('/admin/orders');
    await expect(page.getByTestId('recent-expired')).toBeVisible();

    const res = await page.goto(`/admin/orders?status=expired&day=${day}`);
    await expect(page.getByTestId('expired-note')).toContainText('בודקים ב־Bit או ב־PayBox');
    const e = page.locator(`[data-order="${exp.order_number}"]`);
    await expect(e.getByTestId('order-status')).toHaveText('פג תוקף, לא שולמה');
    await expect(e.getByTestId('order-expired-at')).toContainText('פגה ב־');
    await expect(e.getByTestId('check-late-payment')).toBeVisible();
    await expect(e.getByTestId('mark-paid')).toHaveCount(0); // no re-activation from the screen
    await expect(e.getByTestId('cancel')).toHaveCount(0);
    const expiredStyle = await e.evaluate((el) => getComputedStyle(el).borderTopStyle);
    await baseline(page, res, 'expired', errors);
    await page.getByTestId('expired-note').screenshot({ path: join(SCREENS, 'admin-orders-expired-note.png') });
    await e.screenshot({ path: join(SCREENS, 'admin-orders-card-expired.png') });

    await page.goto(`/admin/orders?status=cancelled&day=${day}`);
    const c = page.locator(`[data-order="${can.order_number}"]`);
    await expect(c.getByTestId('order-status')).toHaveText('בוטלה');
    await expect(page.getByTestId('expired-note')).toHaveCount(0);
    const cancelledStyle = await c.evaluate((el) => getComputedStyle(el).borderTopStyle);
    expect([expiredStyle, cancelledStyle]).toEqual(['dashed', 'solid']);
    await c.screenshot({ path: join(SCREENS, 'admin-orders-card-cancelled.png') });
  });
});
