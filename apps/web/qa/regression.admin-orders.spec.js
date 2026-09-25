// @ts-check
// Admin orders domain regression (api-004 order actions, client-009 orders screen).
// Real chain: Next.js route -> admin's own aal2 JWT -> DB functions
// (fn_mark_order_paid, fn_cancel_order, fn_mark_order_fulfilled). Orders are
// created through the real checkout function (fn_create_standard_order) on a
// day and a product of their own, so runs never share state.
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const { createUser, db, randomIp, uiLogin } = require('./helpers/admin-ui');
const { withClient, freshDay, freshProduct, orderArgs, CREATE_ORDER_SQL, ledger } = require('./helpers/db');

/** A guest pickup order holding `oven`/`work` minutes on a fresh day. email: optional guest email. */
async function newOrder({ oven = 10, work = 20, email = null, day = null, price = 40 } = {}) {
  return withClient(async (c) => {
    const d = day ?? (await freshDay(c, { oven: 600, work: 600 }));
    const product = await freshProduct(c, { oven, work, price });
    const args = orderArgs(d, product, 1);
    args[4] = email;
    const { rows } = await c.query(CREATE_ORDER_SQL, args);
    return { ...rows[0], day: d };
  });
}

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
