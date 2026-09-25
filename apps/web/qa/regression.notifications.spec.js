// @ts-check
// Notifications regression (job-002, client-012, blindspot-001), local stack.
// job-002 runs the REAL lib/server/notification module (bundled like the
// Netlify functions) against the real local PostgREST, a capture email
// adapter and a stand-in push service whose payloads we decrypt with the
// subscription's own keys, the way a browser does.
// What this does NOT prove: Resend delivering mail (no account yet, Yuval's)
// and a real browser push service delivering (FCM/Apple): DID NOT RUN.
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { localEnv } = require('./helpers/env');
const db = require('./helpers/db');
const { createAdmin } = require('./helpers/admin');
const { loadNotificationModule, subscriptionKeys, pushService, capturedTo, sha256 } = require('./helpers/notification');

test.describe.configure({ mode: 'serial' });

const CAP_KEYS = ['email_daily_hard_cap', 'email_daily_alert_at', 'email_daily_customer_cap', 'email_per_recipient_daily_cap'];
let savedCaps;

/** Emails already counted today (pending or sent), the number the caps compare against. */
async function emailsToday(c) {
  const { rows } = await c.query(
    `SELECT count(*)::int AS n FROM notification_attempts WHERE business_day = fn_business_date() AND channel = 'email' AND status IN ('pending','sent')`);
  return rows[0].n;
}

async function setCaps(c, caps) {
  for (const [k, v] of Object.entries(caps)) await c.query(`UPDATE app_settings SET value = $2::jsonb WHERE key = $1`, [k, JSON.stringify(v)]);
}

/** A guest pickup order with an email, on a far-future day. */
async function orderWithEmail(c, email) {
  const day = await db.freshDay(c, { oven: 500, work: 500 });
  const product = await db.freshProduct(c, { oven: 10, work: 10, price: 45 });
  const args = db.orderArgs(day, product, 2);
  args[2] = 'Dana Levi';
  args[4] = email;
  const { rows } = await c.query(db.CREATE_ORDER_SQL, args);
  return { ...rows[0], phone: args[3], day };
}

async function attempts(c, entityId) {
  const { rows } = await c.query(
    `SELECT event, channel, audience, status, reason, recipient_hash FROM notification_attempts WHERE entity_id = $1 ORDER BY created_at, channel`, [entityId]);
  return rows;
}

test.beforeAll(async () => {
  await db.withClient(async (c) => {
    const { rows } = await c.query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [CAP_KEYS]);
    savedCaps = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    // Other specs create many admins in this DB and every admin gets an email
    // per order; lift the caps for the flow tests. The cap tests set their own.
    await setCaps(c, { email_daily_hard_cap: 100000, email_daily_alert_at: 99999, email_daily_customer_cap: 100000, email_per_recipient_daily_cap: 3 });
  });
});

test.afterAll(async () => {
  await db.withClient((c) => setCaps(c, savedCaps));
});

test.describe('job-002 schema and privileges', () => {
  test('seeded caps are the Rule 30 / SEC-015 values', () => {
    expect(savedCaps).toEqual({ email_daily_hard_cap: 100, email_daily_alert_at: 80, email_daily_customer_cap: 60, email_per_recipient_daily_cap: 3 });
  });

  test('anon and a signed-in non-admin cannot call the sender functions or read attempts', async () => {
    const env = localEnv();
    const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const args = { p_event: 'order_created', p_channel: 'email', p_audience: 'admin', p_entity_type: 'order', p_entity_id: crypto.randomUUID(), p_recipient_hash: sha256('x') };
    for (const [fn, a] of [
      ['fn_notification_begin', args],
      ['fn_notification_order_facts', { p_order_id: crypto.randomUUID() }],
      ['fn_notification_admin_emails', {}],
      ['fn_notification_active_push_subscriptions', {}],
      ['fn_admin_register_push_subscription', { p_endpoint: 'https://fcm.googleapis.com/x', p_p256dh: 'B'.repeat(87), p_auth_key: 'a'.repeat(22) }],
    ]) {
      const { error } = await anon.rpc(fn, a);
      expect(error?.message, fn).toContain('permission denied');
    }
    const { data, error } = await anon.from('notification_attempts').select('id').limit(1);
    expect(error?.message ?? '').toContain('permission denied');
    expect(data).toBeNull();

    // A signed-in admin at aal1 (no TOTP) may call the register function but is refused inside.
    const { client: aal1 } = await createAdmin({ withMfa: false });
    const res = await aal1.rpc('fn_admin_register_push_subscription', { p_endpoint: 'https://fcm.googleapis.com/x', p_p256dh: 'B'.repeat(87), p_auth_key: 'a'.repeat(22) });
    expect(res.error?.message).toContain('admin_aal2_required');
    const denied = await aal1.rpc('fn_notification_begin', args);
    expect(denied.error?.message).toContain('permission denied');
  });

  test('push subscriptions: only through the aal2 function, actor from the JWT, no direct writes', async () => {
    const { client, userId } = await createAdmin();
    const keys = subscriptionKeys();
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    const direct = await client.from('push_subscriptions').insert({ admin_id: userId, endpoint, p256dh: keys.p256dh, auth_key: keys.auth });
    expect(direct.error?.message).toContain('permission denied');

    const { data: id, error } = await client.rpc('fn_admin_register_push_subscription', { p_endpoint: endpoint, p_p256dh: keys.p256dh, p_auth_key: keys.auth });
    expect(error).toBeNull();
    const bad = await client.rpc('fn_admin_register_push_subscription', { p_endpoint: 'ftp://x', p_p256dh: keys.p256dh, p_auth_key: keys.auth });
    expect(bad.error?.message).toContain('push_subscription_invalid');

    await db.withClient(async (c) => {
      const { rows } = await c.query(`SELECT admin_id, revoked_at FROM push_subscriptions WHERE id = $1`, [id]);
      expect(rows[0]).toEqual({ admin_id: userId, revoked_at: null });
      const { rows: audit } = await c.query(`SELECT actor_id FROM audit_log WHERE action = 'push.subscribed' AND entity_id = $1`, [id]);
      expect(audit).toEqual([{ actor_id: userId }]);
    });

    const { data: revoked } = await client.rpc('fn_admin_revoke_push_subscription', { p_endpoint: endpoint });
    expect(revoked).toBe(true);
    await db.withClient(async (c) => {
      const { rows } = await c.query(`SELECT revoked_at FROM push_subscriptions WHERE id = $1`, [id]);
      expect(rows[0].revoked_at).not.toBeNull();
    });
  });
});

test.describe('job-002 OrderCreated end to end (real module, real DB)', () => {
  test('admin gets email + push (order number and link only), customer email waits for the PDF, nothing touches the order', async () => {
    const notification = await loadNotificationModule();
    const { client: admin, email: adminEmail } = await createAdmin();
    const keys = subscriptionKeys();
    const service = await pushService(keys);
    try {
      const { error } = await admin.rpc('fn_admin_register_push_subscription', { p_endpoint: service.endpoint, p_p256dh: keys.p256dh, p_auth_key: keys.auth });
      expect(error).toBeNull();

      await db.withClient(async (c) => {
        const customerEmail = `guest-${crypto.randomUUID()}@example.test`;
        const order = await orderWithEmail(c, customerEmail);
        const before = (await c.query('SELECT status, updated_at FROM orders WHERE id = $1', [order.id])).rows[0];

        const report = await notification.OrderCreated({ orderId: order.id });
        expect(report.event).toBe('order_created');
        expect(report.outcomes).toContainEqual({ channel: 'email', audience: 'admin', status: 'sent', reason: null });
        expect(report.outcomes).toContainEqual({ channel: 'push', audience: 'admin', status: 'sent', reason: null });
        expect(report.outcomes).toContainEqual({ channel: 'email', audience: 'customer', status: 'skipped', reason: 'confirmation_pdf_pending' });

        // email to this admin, captured
        const mails = capturedTo(adminEmail);
        expect(mails).toHaveLength(1);
        expect(mails[0].subject).toContain(order.order_number);
        expect(mails[0].html).toContain(`/admin/orders/${order.id}`);
        expect(mails[0].html).toContain('Dana Levi');
        expect(mails[0].html + mails[0].text).not.toContain(order.phone);

        // push: exactly one POST to our endpoint, VAPID-signed, payload decrypts
        expect(service.received).toHaveLength(1);
        expect(service.received[0].headers.authorization).toMatch(/^vapid t=/);
        const payload = service.received[0].payload;
        expect(payload.title).toContain(order.order_number);
        expect(payload.url).toContain(`/admin/orders/${order.id}`);
        const flat = JSON.stringify(payload);
        for (const pii of ['Dana', 'Levi', order.phone, customerEmail]) expect(flat).not.toContain(pii);
        // the raw bytes on the wire are encrypted
        expect(service.received[0].raw.toString('latin1')).not.toContain(order.order_number);

        // nothing to the customer yet; the attempt is recorded
        expect(capturedTo(customerEmail)).toHaveLength(0);
        const rows = await attempts(c, order.id);
        expect(rows.find((r) => r.audience === 'customer')).toMatchObject({ status: 'skipped', reason: 'confirmation_pdf_pending' });
        expect(rows.filter((r) => r.status === 'sent').length).toBeGreaterThanOrEqual(2);
        // hashes only, never an address
        for (const r of rows) expect(r.recipient_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(rows.some((r) => r.recipient_hash === sha256(adminEmail.toLowerCase()))).toBe(true);

        const after = (await c.query('SELECT status, updated_at FROM orders WHERE id = $1', [order.id])).rows[0];
        expect(after).toEqual(before);

        // a retry sends nothing twice
        const again = await notification.OrderCreated({ orderId: order.id });
        expect(again.outcomes.filter((o) => o.status === 'sent')).toEqual([]);
        expect(capturedTo(adminEmail)).toHaveLength(1);
        expect(service.received).toHaveLength(1);

        // with the PDF (wave 3 seam) the customer gets the confirmation, attachment included
        const withPdf = await notification.OrderCreated({ orderId: order.id, confirmationPdf: { filename: `order-${order.order_number}.pdf`, content: new Uint8Array([37, 80, 68, 70, 45]) } });
        expect(withPdf.outcomes).toContainEqual({ channel: 'email', audience: 'customer', status: 'sent', reason: null });
        const customerMail = capturedTo(customerEmail);
        expect(customerMail).toHaveLength(1);
        expect(customerMail[0].attachments).toEqual([{ filename: `order-${order.order_number}.pdf`, bytes: 5 }]);
        expect(customerMail[0].html + customerMail[0].text).not.toContain('Dana');
      });
    } finally {
      await admin.rpc('fn_admin_revoke_push_subscription', { p_endpoint: service.endpoint });
      await service.close();
    }
  });

  test('a dead push endpoint (410) is retired; a failing email is recorded; the order is untouched', async () => {
    const notification = await loadNotificationModule();
    const { client: admin } = await createAdmin();
    const keys = subscriptionKeys();
    const service = await pushService(keys, 410);
    const savedDir = process.env.EMAIL_CAPTURE_DIR;
    try {
      const { data: subId } = await admin.rpc('fn_admin_register_push_subscription', { p_endpoint: service.endpoint, p_p256dh: keys.p256dh, p_auth_key: keys.auth });
      // capture adapter pointed at a path that cannot be a directory: every send fails
      process.env.EMAIL_CAPTURE_DIR = '/dev/null/outbox';
      await db.withClient(async (c) => {
        const order = await orderWithEmail(c, `guest-${crypto.randomUUID()}@example.test`);
        const report = await notification.OrderCreated({ orderId: order.id });
        expect(report.outcomes).toContainEqual({ channel: 'email', audience: 'admin', status: 'failed', reason: 'capture_write_failed' });
        expect(report.outcomes).toContainEqual({ channel: 'push', audience: 'admin', status: 'failed', reason: 'push_http_410' });
        const { rows } = await c.query('SELECT revoked_at FROM push_subscriptions WHERE id = $1', [subId]);
        expect(rows[0].revoked_at).not.toBeNull();
        const { rows: o } = await c.query('SELECT status FROM orders WHERE id = $1', [order.id]);
        expect(o[0].status).toBe('payment_pending');
        // a failed email frees its slot: it is not counted as sent
        const failed = (await attempts(c, order.id)).filter((r) => r.channel === 'email' && r.audience === 'admin');
        expect(failed.every((r) => r.status === 'failed')).toBe(true);
      });
    } finally {
      process.env.EMAIL_CAPTURE_DIR = savedDir;
      await service.close();
    }
  });

  test('unknown or malformed ids never throw', async () => {
    const notification = await loadNotificationModule();
    const r1 = await notification.OrderCreated({ orderId: crypto.randomUUID() });
    expect(r1.outcomes).toEqual([{ channel: 'email', audience: 'admin', status: 'skipped', reason: 'entity_not_found' }]);
    const r2 = await notification.CustomCakeApproved({ requestId: 'not-a-uuid' });
    expect(r2.outcomes).toEqual([{ channel: 'email', audience: 'admin', status: 'skipped', reason: 'invalid_entity_id' }]);
  });
});

test.describe('job-002 custom cake events end to end', () => {
  async function cakeRequest(c, fields) {
    const day = await db.freshDay(c, { oven: 500, work: 500 });
    const { rows } = await c.query(
      `INSERT INTO custom_cake_requests (requester_name, requester_phone, requester_email, desired_date, upload_rights_confirmed_at, inscription_text, notes)
       VALUES ('Noa Cohen', $1, $2, $3, now(), 'Happy birthday Maya 6', 'visit evil.test for a prize') RETURNING id`,
      [db.randomPhone(), fields.email, day]);
    return { id: rows[0].id, day };
  }

  test('requested -> admin; approved and declined -> customer, with no customer-typed text', async () => {
    const notification = await loadNotificationModule();
    const { email: adminEmail } = await createAdmin();
    await db.withClient(async (c) => {
      const customerEmail = `cake-${crypto.randomUUID()}@example.test`;
      const req = await cakeRequest(c, { email: customerEmail });

      const requested = await notification.CustomCakeRequested({ requestId: req.id });
      expect(requested.outcomes).toContainEqual({ channel: 'email', audience: 'admin', status: 'sent', reason: null });
      const adminMail = capturedTo(adminEmail).find((m) => m.html.includes(`/admin/custom-cakes/${req.id}`));
      expect(adminMail).toBeTruthy();
      expect(adminMail.html).not.toContain('evil.test');
      expect(adminMail.html).not.toContain('Maya');

      // approve as the DB would leave it: an order in payment_pending, price and time cost set
      const product = await db.freshProduct(c, { oven: 10, work: 10 });
      const order = await db.createOrder(c, req.day, product, 1);
      await c.query(`UPDATE orders SET payment_pending_expires_at = now() + interval '24 hours' WHERE id = $1`, [order.id]);
      await c.query(
        `UPDATE custom_cake_requests SET status = 'approved', price_displayed = 350, oven_minutes_cost = 30, work_minutes_cost = 60, order_id = $2 WHERE id = $1`,
        [req.id, order.id]);
      const approved = await notification.CustomCakeApproved({ requestId: req.id });
      expect(approved.outcomes).toEqual([{ channel: 'email', audience: 'customer', status: 'sent', reason: null }]);
      const mail = capturedTo(customerEmail);
      expect(mail).toHaveLength(1);
      expect(mail[0].subject).toContain(order.order_number);
      for (const typed of ['Noa', 'Maya', 'evil.test', 'birthday']) expect(mail[0].html + mail[0].text).not.toContain(typed);

      // declined on a second request, reason written by the admin, escaped
      const req2 = await cakeRequest(c, { email: customerEmail });
      await c.query(`UPDATE custom_cake_requests SET status = 'declined', decline_reason = 'Fully booked <b>that week</b>' WHERE id = $1`, [req2.id]);
      const declined = await notification.CustomCakeDeclined({ requestId: req2.id });
      expect(declined.outcomes).toEqual([{ channel: 'email', audience: 'customer', status: 'sent', reason: null }]);
      const declineMail = capturedTo(customerEmail).find((m) => m.html.includes('Fully booked'));
      expect(declineMail.html).toContain('Fully booked &lt;b&gt;that week&lt;/b&gt;');

      // the per-recipient cap (3/day) stops a 4th customer email to the same address
      const req3 = await cakeRequest(c, { email: customerEmail.toUpperCase() });
      await c.query(`UPDATE custom_cake_requests SET status = 'declined' WHERE id = $1`, [req3.id]);
      const req4 = await cakeRequest(c, { email: customerEmail });
      await c.query(`UPDATE custom_cake_requests SET status = 'declined' WHERE id = $1`, [req4.id]);
      expect((await notification.CustomCakeDeclined({ requestId: req3.id })).outcomes[0].status).toBe('sent');
      expect((await notification.CustomCakeDeclined({ requestId: req4.id })).outcomes[0]).toEqual({ channel: 'email', audience: 'customer', status: 'refused', reason: 'recipient_daily_cap' });
      expect(capturedTo(customerEmail).length + capturedTo(customerEmail.toUpperCase()).length).toBe(3);
    });
  });
});

test.describe('job-002 email caps are counted in the DB, under concurrency', () => {
  /** N concurrent fn_notification_begin calls, each on its own connection, as service_role. */
  async function raceBegins(n, argsFor) {
    const p = db.pool(n);
    try {
      const clients = await Promise.all(Array.from({ length: n }, () => p.connect()));
      try {
        const results = await Promise.all(clients.map((cl, i) =>
          db.asRole(cl, 'service_role', {}, `SELECT fn_notification_begin($1,$2,$3,$4,$5,$6) AS r`, argsFor(i)).then((res) => res.rows[0].r)));
        return results;
      } finally {
        clients.forEach((cl) => cl.release());
      }
    } finally {
      await p.end();
    }
  }

  test('hard cap: 24 racers for the last 5 slots, exactly 5 win; the alert fires exactly once', async () => {
    await db.withClient(async (c) => {
      const base = await emailsToday(c);
      await setCaps(c, { email_daily_hard_cap: base + 5, email_daily_alert_at: base + 3, email_daily_customer_cap: 100000 });
      try {
        const results = await raceBegins(24, () => ['order_created', 'email', 'admin', 'order', crypto.randomUUID(), sha256(crypto.randomUUID())]);
        expect(results.filter((r) => r.allowed)).toHaveLength(5);
        expect(results.filter((r) => !r.allowed).every((r) => r.reason === 'daily_cap')).toBe(true);
        expect(results.filter((r) => r.alert)).toHaveLength(1);
        expect(await emailsToday(c)).toBe(base + 5);
        // refusals are recorded too
        const ids = results.filter((r) => r.attempt_id).map((r) => r.attempt_id);
        const { rows } = await c.query(`SELECT status, count(*)::int n FROM notification_attempts WHERE id = ANY($1) GROUP BY 1 ORDER BY 1`, [ids]);
        expect(rows).toEqual([{ status: 'pending', n: 5 }, { status: 'refused', n: 19 }]);
        // close them as failed so they stop counting (they were never sent)
        for (const r of results.filter((x) => x.allowed)) {
          await db.asRole(c, 'service_role', {}, `SELECT fn_notification_finish($1, 'failed', 'qa', null)`, [r.attempt_id]);
        }
        expect(await emailsToday(c)).toBe(base);
      } finally {
        await setCaps(c, { email_daily_hard_cap: 100000, email_daily_alert_at: 99999, email_daily_customer_cap: 100000 });
      }
    });
  });

  test('customer sub-cap keeps room for admin notifications (SEC-015)', async () => {
    await db.withClient(async (c) => {
      const base = await emailsToday(c);
      const { rows: cust } = await c.query(
        `SELECT count(*)::int n FROM notification_attempts WHERE business_day = fn_business_date() AND channel = 'email' AND audience = 'customer' AND status IN ('pending','sent')`);
      await setCaps(c, { email_daily_hard_cap: base + 10, email_daily_customer_cap: cust[0].n + 2 });
      const opened = [];
      try {
        const results = await raceBegins(8, () => ['custom_cake_declined', 'email', 'customer', 'custom_cake_request', crypto.randomUUID(), sha256(crypto.randomUUID())]);
        expect(results.filter((r) => r.allowed)).toHaveLength(2);
        expect(results.filter((r) => !r.allowed).every((r) => r.reason === 'customer_daily_cap')).toBe(true);
        opened.push(...results.filter((r) => r.allowed).map((r) => r.attempt_id));
        const adminTry = await db.asRole(c, 'service_role', {}, `SELECT fn_notification_begin('order_created','email','admin','order',$1,$2) AS r`, [crypto.randomUUID(), sha256(crypto.randomUUID())]);
        expect(adminTry.rows[0].r.allowed).toBe(true);
        opened.push(adminTry.rows[0].r.attempt_id);
      } finally {
        for (const id of opened) await db.asRole(c, 'service_role', {}, `SELECT fn_notification_finish($1, 'failed', 'qa', null)`, [id]);
        await setCaps(c, { email_daily_hard_cap: 100000, email_daily_customer_cap: 100000 });
      }
    });
  });

  test('push attempts never count against the email cap', async () => {
    await db.withClient(async (c) => {
      const base = await emailsToday(c);
      await setCaps(c, { email_daily_hard_cap: base });
      try {
        const r = await db.asRole(c, 'service_role', {}, `SELECT fn_notification_begin('order_created','push','admin','order',$1,$2) AS r`, [crypto.randomUUID(), sha256(crypto.randomUUID())]);
        expect(r.rows[0].r.allowed).toBe(true);
        await db.asRole(c, 'service_role', {}, `SELECT fn_notification_finish($1, 'sent', null, null)`, [r.rows[0].r.attempt_id]);
        const e = await db.asRole(c, 'service_role', {}, `SELECT fn_notification_begin('order_created','email','admin','order',$1,$2) AS r`, [crypto.randomUUID(), sha256(crypto.randomUUID())]);
        expect(e.rows[0].r).toMatchObject({ allowed: false, reason: 'daily_cap' });
      } finally {
        await setCaps(c, { email_daily_hard_cap: 100000 });
      }
    });
  });
});

// ---------------------------------------------------------------- client-012
const { join } = require('node:path');
const { createUser, uiLogin } = require('./helpers/admin-ui');

const SCREENS = join(__dirname, '..', 'test-results', 'screens');
const BASE = `http://localhost:${process.env.PORT || 3100}`;

function collectErrors(page) {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** The baseline every admin screen shares (same checks as regression.admin.spec.js). */
async function adminBaseline(page, name, errors) {
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('400 16px "IBM Plex Sans Hebrew"'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="switch"]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && (r.width < 44 || r.height < 44);
      })
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(small).toEqual([]);
  await page.screenshot({ path: join(SCREENS, `admin-push-${name}.png`), fullPage: true });
  expect(errors).toEqual([]);
}

/**
 * Headless Chromium has no push service, so PushManager.subscribe is replaced
 * by one returning a subscription for OUR stand-in push service with keys the
 * test holds. Its Notification.permission also reads 'denied' even after a
 * grant (the Permissions API says 'granted'), so the prompt is stubbed to
 * answer 'granted'. Everything else is real: the service worker, the API
 * route, the DB function, and the sender posting to that endpoint.
 */
async function stubPushManager(page, sub) {
  await page.addInitScript((s) => {
    let permission = 'default';
    Object.defineProperty(Notification, 'permission', { get: () => permission });
    Notification.requestPermission = async () => (permission = 'granted');
    let current = null;
    const make = () => ({
      endpoint: s.endpoint,
      toJSON: () => ({ endpoint: s.endpoint, expirationTime: null, keys: { p256dh: s.p256dh, auth: s.auth } }),
      unsubscribe: async () => ((current = null), true),
    });
    PushManager.prototype.subscribe = async function () {
      current = make();
      return current;
    };
    PushManager.prototype.getSubscription = async function () {
      return current;
    };
  }, sub);
}

test.describe('client-012 admin push subscribe', () => {
  test('API: aal2 admin only, same Origin, strict body, push-service hosts only', async ({ page }) => {
    const anon = await page.request.post('/api/admin/push-subscriptions', { data: {}, headers: { origin: 'http://localhost:3100' } });
    expect(anon.status()).toBe(401);

    const user = await createUser({ withTotp: true });
    await uiLogin(page, user);
    const origin = new URL(page.url()).origin;
    const keys = subscriptionKeys();
    const good = { endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`, keys: { p256dh: keys.p256dh, auth: keys.auth } };
    const post = (data, headers = { origin }) => page.request.post('/api/admin/push-subscriptions', { data, headers });

    expect((await post(good, { origin: 'https://evil.test' })).status()).toBe(403);
    expect((await post(good, {})).status()).toBe(403);
    expect(await (await post({ ...good, admin_id: crypto.randomUUID() })).json()).toEqual({ error: 'invalid_input' });
    expect(await (await post({ ...good, keys: { ...good.keys, auth: 'x' } })).json()).toEqual({ error: 'invalid_input' });
    for (const endpoint of ['https://evil.test/push', 'http://169.254.169.254/latest', 'https://fcm.googleapis.com.evil.test/x']) {
      const r = await post({ ...good, endpoint });
      expect(r.status(), endpoint).toBe(400);
      expect(await r.json()).toEqual({ error: 'endpoint_not_allowed' });
    }

    const ok = await post(good);
    expect(ok.status()).toBe(201);
    await db.withClient(async (c) => {
      const { rows } = await c.query('SELECT admin_id, revoked_at FROM push_subscriptions WHERE endpoint = $1', [good.endpoint]);
      expect(rows).toEqual([{ admin_id: user.userId, revoked_at: null }]);
    });
    const del = await page.request.delete('/api/admin/push-subscriptions', { data: { endpoint: good.endpoint }, headers: { origin } });
    expect(await del.json()).toEqual({ revoked: true });
    await db.withClient(async (c) => {
      const { rows } = await c.query('SELECT revoked_at FROM push_subscriptions WHERE endpoint = $1', [good.endpoint]);
      expect(rows[0].revoked_at).not.toBeNull();
    });
  });

  test('aal1 (password, no TOTP) cannot register', async ({ page }) => {
    const user = await createUser({ withTotp: true });
    await page.goto('/admin/login');
    await page.getByLabel('אימייל').fill(user.email);
    await page.getByLabel('סיסמה').fill(user.password);
    await page.getByRole('button', { name: 'כניסה', exact: true }).click();
    await page.waitForURL('**/admin/login/verify');
    const keys = subscriptionKeys();
    const r = await page.request.post('/api/admin/push-subscriptions', {
      data: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: keys.p256dh, auth: keys.auth } },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(r.status()).toBe(401);
  });

  test('settings screen: turn on, the next order reaches this device, turn off', async ({ page, context }) => {
    const notification = await loadNotificationModule();
    const keys = subscriptionKeys();
    const service = await pushService(keys);
    try {
      await context.grantPermissions(['notifications'], { origin: BASE });
      await stubPushManager(page, { endpoint: service.endpoint, p256dh: keys.p256dh, auth: keys.auth });
      const errors = collectErrors(page);
      const user = await createUser({ withTotp: true });
      await uiLogin(page, user);
      const res = await page.goto('/admin/settings');
      const csp = res?.headers()['content-security-policy'] ?? '';
      expect(csp).toContain("worker-src 'self'");

      const card = page.getByTestId('push-card');
      await expect(card).toHaveAttribute('data-state', 'off');
      await expect(card).toContainText('התראות הן תוספת');
      await expect(page.getByTestId('push-devices')).toHaveText('עוד אין מכשיר שמקבל התראות.');
      await adminBaseline(page, 'off', errors);

      await page.getByTestId('push-toggle').click();
      await expect(card).toHaveAttribute('data-state', 'on');
      await expect(page.getByTestId('push-message')).toHaveText('ההתראות פעילות במכשיר הזה.');
      await expect(page.getByTestId('push-devices')).toHaveText('מכשיר אחד מקבל התראות.');
      await expect(page.getByTestId('push-status')).toHaveText('פעילות');
      // the real service worker is registered for /admin/ only
      const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/admin/'))?.scope ?? null);
      expect(scope).toMatch(/\/admin\/$/);
      await adminBaseline(page, 'on', errors);

      await db.withClient(async (c) => {
        const { rows } = await c.query('SELECT admin_id FROM push_subscriptions WHERE endpoint = $1 AND revoked_at IS NULL', [service.endpoint]);
        expect(rows).toEqual([{ admin_id: user.userId }]);
        // a new order now reaches this device through the real sender
        const order = await orderWithEmail(c, `guest-${crypto.randomUUID()}@example.test`);
        await notification.OrderCreated({ orderId: order.id });
        expect(service.received).toHaveLength(1);
        expect(service.received[0].payload.title).toContain(order.order_number);
      });

      await page.getByTestId('push-toggle').click();
      await expect(card).toHaveAttribute('data-state', 'off');
      await expect(page.getByTestId('push-message')).toHaveText('ההתראות כבויות במכשיר הזה.');
      await expect(page.getByTestId('push-devices')).toHaveText('עוד אין מכשיר שמקבל התראות.');
      await db.withClient(async (c) => {
        const { rows } = await c.query('SELECT revoked_at FROM push_subscriptions WHERE endpoint = $1', [service.endpoint]);
        expect(rows[0].revoked_at).not.toBeNull();
      });
      expect(errors).toEqual([]);
    } finally {
      await service.close();
    }
  });

  test('permission denied: explains how to allow, says email still arrives, nothing breaks', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'denied' });
      Notification.requestPermission = async () => 'denied';
    });
    const errors = collectErrors(page);
    const user = await createUser({ withTotp: true });
    await uiLogin(page, user);
    await page.goto('/admin/settings');
    const card = page.getByTestId('push-card');
    await expect(card).toHaveAttribute('data-state', 'denied');
    await expect(page.getByTestId('push-note')).toContainText('חסומות בדפדפן');
    await expect(page.getByTestId('push-note')).toContainText('במייל');
    await page.getByTestId('push-toggle').click(); // asking again stays calm
    await expect(card).toHaveAttribute('data-state', 'denied');
    await adminBaseline(page, 'denied', errors);
  });

  test('prompt dismissed: stays off with a gentle message', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'default' });
      Notification.requestPermission = async () => 'default';
    });
    const user = await createUser({ withTotp: true });
    await uiLogin(page, user);
    await page.goto('/admin/settings');
    await page.getByTestId('push-toggle').click();
    await expect(page.getByTestId('push-card')).toHaveAttribute('data-state', 'off');
    await expect(page.getByTestId('push-message')).toHaveText('ההתראות לא הופעלו. אפשר לנסות שוב בכל זמן.');
  });

  test('a browser without push (older iPhone, in-app browser): says so, email still arrives', async ({ page }) => {
    await page.addInitScript(() => {
      delete window.PushManager;
    });
    const errors = collectErrors(page);
    const user = await createUser({ withTotp: true });
    await uiLogin(page, user);
    await page.goto('/admin/settings');
    await expect(page.getByTestId('push-card')).toHaveAttribute('data-state', 'unsupported');
    await expect(page.getByTestId('push-note')).toContainText('במייל');
    await expect(page.getByTestId('push-toggle')).toHaveCount(0);
    await adminBaseline(page, 'unsupported', errors);
  });
});
