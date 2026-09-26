// @ts-check
// US-0c: the written order confirmation (PDF), its 24-month link, the email
// that carries it and the admin's WhatsApp delivery. Real chain on the local
// stack: POST /api/orders -> after() -> render -> private bucket
// `order-confirmations` -> fn_issue_order_confirmation -> OrderCreated email
// (capture provider) -> fn_record_order_confirmation_delivered; GET
// /confirmation/<order id>.<mac> -> fn_confirmation_by_link_token -> Storage
// -> sha256 check. Every order uses its own day and product.
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { localEnv } = require('./helpers/env');
const dbh = require('./helpers/db');
const { createUser, db, uiLogin } = require('./helpers/admin-ui');
const { checkPublicBaseline, SCREENS } = require('./helpers/baseline');

const env = localEnv();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const phone = () => `050${crypto.randomInt(1000000, 9999999)}`;
const hasPoppler = spawnSync('pdftoppm', ['-v']).status === 0 && spawnSync('pdftotext', ['-v']).status === 0;

/** The link token the server derives (lib/server/confirmation/link.ts). */
function linkToken(orderId) {
  const mac = crypto.createHmac('sha256', env.CONFIRMATION_LINK_SECRET).update(`yb-order-confirmation-v1:${orderId}`).digest('base64url');
  return `${orderId}.${mac}`;
}

async function fixtures({ price = 72.5, name } = {}) {
  return dbh.withClient(async (c) => {
    const day = await dbh.freshDay(c, { oven: 300, work: 300 });
    const product = (await c.query(
      `INSERT INTO products (name, price_displayed, cost_basis, oven_minutes_cost, work_minutes_cost, allergens, allergens_confirmed, photo_alt, is_available, is_published)
       VALUES ($1, $2, 'per_unit', 5, 5, ARRAY['gluten'], true, 'qa confirmation product', true, true) RETURNING id`,
      [name ?? `עוגת QA ${crypto.randomUUID().slice(0, 6)} (ללא גלוטן)`, price],
    )).rows[0].id;
    const slot = (await c.query(`SELECT id::text FROM time_slots WHERE is_active ORDER BY start_time DESC LIMIT 1`)).rows[0].id;
    const tag = crypto.randomUUID().slice(0, 8);
    const zone = (await c.query(`INSERT INTO delivery_zones (name, fee_displayed) VALUES ($1, 25) RETURNING id`, [`QA zone ${tag}`])).rows[0].id;
    const city = `קריית QA ${tag}`;
    await c.query(`INSERT INTO delivery_zone_cities (zone_id, city) VALUES ($1, $2)`, [zone, city]);
    return { day, product, slot, city };
  });
}

/** A guest order through the real checkout route (so after() runs). */
async function checkout(request, { email = null, delivery = false, name = 'QA Confirmation Guest', tel = phone(), address = 'QA Hidden Street 7' } = {}) {
  const f = await fixtures();
  const data = {
    items: [{ productId: f.product, quantity: 2 }], day: f.day, slotId: f.slot, name, phone: tel,
    fulfillment: delivery ? 'delivery' : 'pickup',
    ...(delivery ? { city: f.city, address, notes: 'QA secret gate code 4321' } : {}),
    ...(email ? { email } : {}),
  };
  const res = await request.post('/api/orders', {
    data, headers: { 'content-type': 'application/json', origin: 'http://localhost:3100', 'x-nf-client-connection-ip': dbh.randomIp() },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { token } = await res.json();
  const row = (await db(`SELECT * FROM orders WHERE lookup_token_hash = $1`, [sha256(token)]))[0];
  return { token, row, day: f.day, city: f.city, name, tel, address };
}

/** Expire an unpaid order the real way: past its window, then the sweep (status changes only through DB functions). */
async function expire(id) {
  await dbh.withClient((c) => dbh.backdateExpiry(c, id));
  const { error } = await service().rpc('fn_expire_stale_orders');
  expect(error).toBeNull();
  expect((await orderRow(id)).status).toBe('expired');
}

const orderRow = async (id) => (await db('SELECT * FROM orders WHERE id = $1', [id]))[0];

async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

function service() {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

async function capturedMailTo(address) {
  const dir = env.EMAIL_CAPTURE_DIR;
  return until(() => {
    if (!existsSync(dir)) return null;
    for (const f of readdirSync(dir)) {
      const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (m.to === address) return m;
    }
    return null;
  });
}

test.describe('US-0c: order confirmation PDF', () => {
  // Every checkout emails every admin (job-002), and other specs leave many
  // admins in this shared DB, so the daily email cap would refuse the
  // customer's confirmation mail. Lift it here and put the seeded values back,
  // as regression.notifications does.
  const CAP_KEYS = ['email_daily_hard_cap', 'email_daily_alert_at', 'email_daily_customer_cap'];
  let savedCaps = [];
  test.beforeAll(async () => {
    savedCaps = await db('SELECT key, value FROM app_settings WHERE key = ANY($1)', [CAP_KEYS]);
    for (const [k, v] of [['email_daily_hard_cap', 100000], ['email_daily_alert_at', 99999], ['email_daily_customer_cap', 100000]]) {
      await db('UPDATE app_settings SET value = $2::jsonb WHERE key = $1', [k, JSON.stringify(v)]);
    }
  });
  test.afterAll(async () => {
    for (const r of savedCaps) await db('UPDATE app_settings SET value = $2::jsonb WHERE key = $1', [r.key, JSON.stringify(r.value)]);
  });

  test('checkout with an email: the PDF is issued once, emailed with its link, and the delivery is recorded (channel email)', async ({ request }) => {
    const email = `guest-${crypto.randomUUID()}@example.test`;
    const { row } = await checkout(request, { email });
    const done = await until(async () => {
      const r = await orderRow(row.id);
      return r.confirmation_delivered_at ? r : null;
    });
    expect(done.confirmation_channel).toBe('email');
    expect(done.confirmation_pdf_path).toBe(`orders/${row.id}/${done.confirmation_pdf_sha256}.pdf`);
    expect(done.confirmation_link_token_hash).toBe(sha256(linkToken(row.id)));
    // the 24-month floor (CHECK on orders) and the link expiry
    const months = (await db(`SELECT confirmation_link_expires_at >= created_at + interval '24 months' AS ok FROM orders WHERE id = $1`, [row.id]))[0];
    expect(months.ok).toBe(true);

    const mail = await capturedMailTo(email);
    expect(mail.attachments).toEqual([{ filename: `order-${row.order_number}.pdf`, bytes: expect.any(Number) }]);
    expect(mail.text).toContain(`/confirmation/${linkToken(row.id)}`);

    const res = await request.get(`/confirmation/${linkToken(row.id)}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/pdf');
    expect(res.headers()['content-disposition']).toBe(`attachment; filename="order-${row.order_number}.pdf"`);
    expect(res.headers()['referrer-policy']).toBe('no-referrer');
    expect(res.headers()['x-robots-tag']).toContain('noindex');
    expect(res.headers()['cache-control']).toBe('no-store');
    const body = await res.body();
    expect(sha256(body)).toBe(done.confirmation_pdf_sha256);
    expect(mail.attachments[0].bytes).toBe(body.length);
    // immutable: the same bytes again, and nothing re-issued
    expect(sha256(await (await request.get(`/confirmation/${linkToken(row.id)}`)).body())).toBe(done.confirmation_pdf_sha256);
    const audits = await db(`SELECT action, actor_type FROM audit_log WHERE entity_id = $1 AND action LIKE 'order.confirmation_%' ORDER BY id`, [row.id]);
    expect(audits).toEqual([
      { action: 'order.confirmation_issued', actor_type: 'system' },
      { action: 'order.confirmation_delivered', actor_type: 'system' },
    ]);
  });

  test('the PDF, rendered: Hebrew right to left, real text, fonts embedded, and no customer name, phone, email, street or notes', async ({ request }) => {
    test.skip(!hasPoppler, 'DID NOT RUN: poppler-utils (pdftoppm, pdftotext, pdffonts) not installed');
    const email = `pdf-${crypto.randomUUID()}@example.test`;
    const o = await checkout(request, { email, delivery: true, name: 'QA Secret Name' });
    await until(async () => (await orderRow(o.row.id)).confirmation_pdf_path);
    const res = await request.get(`/confirmation/${linkToken(o.row.id)}`);
    expect(res.status()).toBe(200);
    const dir = join(SCREENS, '..', 'confirmation-pdf');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'confirmation.pdf');
    writeFileSync(file, await res.body());

    const fonts = spawnSync('pdffonts', [file], { encoding: 'utf8' }).stdout;
    expect(fonts).toMatch(/IBMPlexSansHebrew\s+CID TrueType\s+Identity-H\s+yes yes yes/);
    expect(fonts).toMatch(/IBMPlexSansHebrew-Bold\s+CID TrueType\s+Identity-H\s+yes yes yes/);

    // pdftotext applies the bidi algorithm on extraction: logical Hebrew words
    // back out prove the glyphs are laid out right to left as real text.
    // Brackets and punctuation next to Hebrew come out mirrored or moved on
    // extraction (copy and paste), though they render correctly: checked by
    // words, and by eye on the PNG (SYSTEM-CONTRACT section 3).
    const text = spawnSync('pdftotext', ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8' }).stdout.replace(/[‎‏‪-‮]/g, '');
    for (const s of ['אישור הזמנה', o.row.order_number, 'משלוח ל', o.city, 'ביטול הזמנה', 'לא ניתן לבטל', 'שם העסק', 'מחיר סופי', 'ללא גלוטן']) {
      expect(text, s).toContain(s);
    }
    for (const secret of ['QA Secret Name', o.tel.slice(3), email, o.address, 'QA secret gate code']) {
      expect(text, secret).not.toContain(secret);
    }
    mkdirSync(SCREENS, { recursive: true });
    // 100% (72 dpi is PDF's 1:1; 96 matches a screen at 100%)
    const out = spawnSync('pdftoppm', ['-r', '96', '-png', '-f', '1', '-l', '1', file, join(SCREENS, 'confirmation-pdf')]);
    expect(out.status).toBe(0);
    expect(existsSync(join(SCREENS, 'confirmation-pdf-1.png'))).toBe(true);
  });

  test('order page of a guest with no email: download link (baseline, RTL); the first open issues the PDF; nothing is recorded as delivered', async ({ page, request }) => {
    const { token, row } = await checkout(request);
    await checkPublicBaseline(page, `/order/${token}`, 'order-confirmation');
    const link = page.getByTestId('confirmation-download');
    await expect(link).toHaveAttribute('href', `/confirmation/${linkToken(row.id)}`);
    await expect(link).toHaveAttribute('download', `order-${row.order_number}.pdf`);
    await expect(page.getByTestId('order-confirmation')).toContainText('24 חודשים');
    await expect(page.getByTestId('cancellation-exemption-notice')).toHaveAttribute('data-kind', 'catalog');

    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toBe(`order-${row.order_number}.pdf`);
    const after = await orderRow(row.id);
    expect(after.confirmation_pdf_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(after.confirmation_delivered_at).toBeNull();
    expect(after.confirmation_channel).toBeNull();
    const bytes = readFileSync(/** @type {string} */ (await download.path()));
    expect(sha256(bytes)).toBe(after.confirmation_pdf_sha256);
  });

  test('every refusal is the same 404: unknown, badly signed, id or order number alone, expired, revoked, purged, anonymized, never issued, file changed', async ({ request }) => {
    const svc = service();
    const issue = async () => {
      const { row } = await checkout(request);
      expect((await request.get(`/confirmation/${linkToken(row.id)}`)).status()).toBe(200);
      return orderRow(row.id);
    };
    const [expired, revoked, purged, anonymized, changed] = [await issue(), await issue(), await issue(), await issue(), await issue()];
    const { row: neverIssued } = await checkout(request);
    await db(`UPDATE orders SET created_at = now() - interval '25 months', confirmation_link_expires_at = now() - interval '1 day' WHERE id = $1`, [expired.id]);
    await db(`UPDATE orders SET confirmation_link_revoked_at = now() WHERE id = $1`, [revoked.id]);
    await db(`UPDATE orders SET confirmation_pdf_purged_at = now() WHERE id = $1`, [purged.id]);
    expect((await svc.rpc('fn_anonymize_order', { p_order_id: anonymized.id })).data).toBe(true);
    await expire(neverIssued.id);
    const up = await svc.storage.from('order-confirmations').upload(changed.confirmation_pdf_path, Buffer.from('%PDF-1.3 not the recorded file'), { contentType: 'application/pdf', upsert: true });
    expect(up.error).toBeNull();

    const good = linkToken(revoked.id);
    const keys = [
      `${crypto.randomUUID()}.${crypto.randomBytes(32).toString('base64url')}`,
      `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`,
      revoked.id,
      revoked.order_number,
      linkToken(crypto.randomUUID()),
      linkToken(expired.id),
      linkToken(revoked.id),
      linkToken(purged.id),
      linkToken(anonymized.id),
      linkToken(neverIssued.id),
      linkToken(changed.id),
    ];
    const answers = [];
    for (const k of keys) {
      const r = await request.get(`/confirmation/${encodeURIComponent(k)}`);
      answers.push({ status: r.status(), body: await r.text(), type: r.headers()['content-type'], cache: r.headers()['cache-control'], robots: r.headers()['x-robots-tag'] });
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(answers[0]).toEqual({ status: 404, body: 'Not found', type: 'text/plain; charset=utf-8', cache: 'no-store', robots: 'noindex, nofollow' });
    // the expired order that never had a document still has none
    expect((await orderRow(neverIssued.id)).confirmation_pdf_path).toBeNull();
  });

  test('DB: issue is service-role only and write-once; delivery needs an issued link, the right actor, and is write-once', async ({ request }) => {
    const { row } = await checkout(request);
    const token = linkToken(row.id);
    const hash = 'a'.repeat(64);
    const path = `orders/${row.id}/${hash}.pdf`;
    const call = (role, claims, sql, params) => dbh.withClient((c) => dbh.asRole(c, role, claims, sql, params)).then(() => 'ok', (e) => e.message);

    const issueSql = 'SELECT fn_issue_order_confirmation($1, $2, $3, $4)';
    for (const role of ['anon', 'authenticated']) {
      expect(await call(role, { sub: crypto.randomUUID() }, issueSql, [row.id, path, hash, token])).toMatch(/permission denied/);
      expect(await call(role, { sub: crypto.randomUUID() }, 'SELECT fn_confirmation_by_link_token($1)', [token])).toMatch(/permission denied/);
      expect(await call(role, { sub: crypto.randomUUID() }, 'SELECT fn_order_confirmation_source($1)', [row.id])).toMatch(/permission denied/);
    }
    expect(await call('anon', {}, "SELECT fn_record_order_confirmation_delivered($1, 'email')", [row.id])).toMatch(/permission denied/);
    // a signed-in customer (not an admin) cannot open the fulfilment gate (B5a)
    expect(await call('authenticated', { sub: crypto.randomUUID() }, "SELECT fn_record_order_confirmation_delivered($1, 'whatsapp_manual')", [row.id])).toMatch(/confirmation_delivery_requires_admin_or_service_role/);
    expect(await call('authenticated', { sub: crypto.randomUUID() }, "SELECT fn_record_order_confirmation_delivered($1, 'email')", [row.id])).toMatch(/confirmation_delivery_requires_admin_or_service_role/);
    // the system never claims a WhatsApp send
    expect(await call('service_role', {}, "SELECT fn_record_order_confirmation_delivered($1, 'whatsapp_manual')", [row.id])).toMatch(/confirmation_delivery_requires_admin_or_service_role/);
    // nothing to deliver before it is issued
    expect(await call('service_role', {}, "SELECT fn_record_order_confirmation_delivered($1, 'email')", [row.id])).toMatch(/confirmation_not_issued/);
    // arguments are checked: path must be orders/<id>/<sha>.pdf, token long enough
    expect(await call('service_role', {}, issueSql, [row.id, `orders/other/${hash}.pdf`, hash, token])).toMatch(/confirmation_invalid_argument/);
    expect(await call('service_role', {}, issueSql, [row.id, path, hash, 'short'])).toMatch(/confirmation_invalid_argument/);

    const svc = service();
    expect((await svc.rpc('fn_issue_order_confirmation', { p_order_id: row.id, p_pdf_path: path, p_pdf_sha256: hash, p_link_token: token })).data).toBe(true);
    const other = 'b'.repeat(64);
    expect((await svc.rpc('fn_issue_order_confirmation', { p_order_id: row.id, p_pdf_path: `orders/${row.id}/${other}.pdf`, p_pdf_sha256: other, p_link_token: token })).data).toBe(false);
    expect((await orderRow(row.id)).confirmation_pdf_sha256).toBe(hash);
    expect((await svc.rpc('fn_record_order_confirmation_delivered', { p_order_id: row.id, p_channel: 'email' })).data).toBe(true);
    expect((await svc.rpc('fn_record_order_confirmation_delivered', { p_order_id: row.id, p_channel: 'email' })).data).toBe(false);
    expect((await svc.rpc('fn_record_order_confirmation_delivered', { p_order_id: row.id, p_channel: 'fax' })).error?.message).toMatch(/invalid_confirmation_channel/);

    // an expired order that never had a document cannot get a first one
    const { row: gone } = await checkout(request);
    await expire(gone.id);
    const r = await svc.rpc('fn_issue_order_confirmation', { p_order_id: gone.id, p_pdf_path: `orders/${gone.id}/${hash}.pdf`, p_pdf_sha256: hash, p_link_token: linkToken(gone.id) });
    expect(r.error?.message).toMatch(/confirmation_order_not_available/);
    expect((await orderRow(gone.id)).confirmation_pdf_path).toBeNull();
  });

  test('admin: a paid guest order with no email: WhatsApp with the PDF link, "I sent it" records whatsapp_manual as the admin, then it can be marked delivered', async ({ page, baseURL }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const { row, day } = await checkout(page.request);
    const headers = { origin: baseURL ?? '' };
    expect((await page.request.post(`/api/admin/orders/${row.id}/mark-paid`, { headers })).status()).toBe(200);

    await page.goto(`/admin/orders?status=paid&day=${day}`);
    const card = page.locator(`[data-testid="order-card"][data-order="${row.order_number}"]`);
    await expect(card.getByTestId('fulfil-blocked')).toBeVisible();
    await expect(card.getByTestId('mark-fulfilled')).toHaveCount(0);
    const wa = card.getByTestId('confirmation-whatsapp');
    const href = await wa.getAttribute('href');
    expect(href).toMatch(/^https:\/\/wa\.me\/972\d{9}\?text=/);
    const text = decodeURIComponent(/** @type {string} */ (href).split('?text=')[1]);
    expect(text).toContain(row.order_number);
    expect(text).toContain(`/confirmation/${linkToken(row.id)}`);
    expect(text).not.toContain('QA Confirmation Guest');
    await expect(wa).toHaveAttribute('rel', 'noopener noreferrer');
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: join(SCREENS, 'admin-order-confirmation.png') });

    // anonymous and wrong-origin calls change nothing
    const anon = await page.context().browser()?.newContext();
    const anonRes = await anon?.request.post(`${baseURL}/api/admin/orders/${row.id}/confirmation-sent`, { headers });
    expect(anonRes?.status()).toBe(401);
    await anon?.close();
    expect((await page.request.post(`/api/admin/orders/${row.id}/confirmation-sent`, { headers: { origin: 'https://evil.example' } })).status()).toBe(403);
    expect((await orderRow(row.id)).confirmation_delivered_at).toBeNull();

    await card.getByTestId('confirmation-sent').click();
    await expect(page.getByTestId('orders-done')).toContainText(row.order_number);
    const after = await orderRow(row.id);
    expect(after.confirmation_channel).toBe('whatsapp_manual');
    expect(after.confirmation_pdf_sha256).toMatch(/^[0-9a-f]{64}$/);
    const audit = (await db(`SELECT actor_type, actor_id FROM audit_log WHERE entity_id = $1 AND action = 'order.confirmation_delivered'`, [row.id]))[0];
    expect(audit).toEqual({ actor_type: 'admin', actor_id: admin.userId });
    // the link Yuval sent serves the recorded file
    expect(sha256(await (await page.request.get(`/confirmation/${linkToken(row.id)}`)).body())).toBe(after.confirmation_pdf_sha256);

    // a second press is harmless
    const again = await page.request.post(`/api/admin/orders/${row.id}/confirmation-sent`, { headers });
    expect(await again.json()).toEqual({ id: row.id, orderNumber: row.order_number, recorded: false });

    await page.goto(`/admin/orders?status=paid&day=${day}`);
    await card.getByTestId('mark-fulfilled').click();
    await expect(page.getByTestId('orders-done')).toBeVisible();
    expect((await orderRow(row.id)).status).toBe('fulfilled');
  });
});

// ---------------------------------------------------------------------------
// US-0d: find my order by phone + order number
// ---------------------------------------------------------------------------
function lookup(request, data, { from = dbh.randomIp(), origin = 'http://localhost:3100' } = {}) {
  const headers = { 'content-type': 'application/json', 'x-nf-client-connection-ip': from };
  if (origin) headers.origin = origin;
  return request.post('/api/find-order', { data, headers });
}

test.describe('US-0d: find my order', () => {
  test('baseline: /find-order renders RTL with the form first, no Referer and no indexing, linked from the footer', async ({ page }) => {
    const res = await checkPublicBaseline(page, '/find-order', 'find-order');
    expect(res.headers()['referrer-policy']).toBe('no-referrer');
    expect(res.headers()['x-robots-tag']).toContain('noindex');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.getByTestId('find-order-form')).toBeVisible();
    await expect(page.getByTestId('site-footer').locator('a[href="/find-order"]')).toBeVisible();
    // the privacy line comes before the first field
    const order = await page.evaluate(() => {
      const note = document.querySelector('[data-testid="find-order-privacy"]');
      const phone = document.getElementById('fo-phone');
      return note && phone ? note.compareDocumentPosition(phone) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
    });
    expect(order).toBeTruthy();
  });

  test('phone + order number (typed loosely) show only the masked view and the confirmation link; the PDF downloads', async ({ page, request }) => {
    const o = await checkout(request, { delivery: true, name: 'QA Secret Name', address: 'QA Hidden Street 7' });
    await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': dbh.randomIp() });
    await page.goto('/find-order');
    const local = o.tel; // "050xxxxxxx", typed with a dash
    await page.getByLabel('מספר טלפון נייד').fill(`${local.slice(0, 3)}-${local.slice(3)}`);
    await page.getByLabel('מספר הזמנה').fill(` ${o.row.order_number.toLowerCase()} `);
    await page.getByTestId('find-order-submit').click();
    const result = page.getByTestId('find-order-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText(o.row.order_number);
    await expect(page.getByTestId('find-order-status')).toHaveText('ממתינה לתשלום');
    await expect(page.getByTestId('find-order-address')).toHaveText(`${o.city}, Q***`);
    const text = await page.locator('main').innerText();
    for (const secret of ['QA Secret Name', 'Hidden Street', 'gate code', o.tel.slice(4)]) expect(text).not.toContain(secret);
    const link = page.getByTestId('find-order-confirmation');
    await expect(link).toHaveAttribute('href', `/confirmation/${linkToken(o.row.id)}`);
    await page.screenshot({ path: join(SCREENS, 'find-order-result.png'), fullPage: true });
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toBe(`order-${o.row.order_number}.pdf`);
    expect(sha256(readFileSync(/** @type {string} */ (await download.path())))).toBe((await orderRow(o.row.id)).confirmation_pdf_sha256);
    // the internal id never reaches the browser except inside the signed link
    const api = await (await lookup(request, { phone: o.tel, orderNumber: o.row.order_number })).json();
    expect(Object.keys(api.order).sort()).toEqual(['confirmationPath', 'day', 'fulfillment', 'maskedAddress', 'orderNumber', 'status']);
  });

  test('every miss is the same answer: wrong phone, wrong number, both, an anonymized order; phone or number alone is not even looked up', async ({ page, request }) => {
    const a = await checkout(request);
    const b = await checkout(request);
    const gone = await checkout(request);
    expect((await service().rpc('fn_anonymize_order', { p_order_id: gone.row.id })).data).toBe(true);
    const answers = [];
    for (const data of [
      { phone: b.tel, orderNumber: a.row.order_number }, // right number, another customer's phone
      { phone: a.tel, orderNumber: b.row.order_number }, // right phone, another order's number
      { phone: phone(), orderNumber: 'AZZZ-ZZZ' },
      { phone: gone.tel, orderNumber: gone.row.order_number },
    ]) {
      const r = await lookup(request, data);
      answers.push({ status: r.status(), body: await r.text() });
    }
    for (const x of answers) expect(x).toEqual({ status: 200, body: JSON.stringify({ result: 'not_found' }) });
    const before = (await db('SELECT count(*)::int n FROM order_lookup_attempts WHERE phone_e164 = $1', [a.tel]))[0].n;
    expect((await lookup(request, { phone: a.tel })).status()).toBe(400);
    expect((await lookup(request, { orderNumber: a.row.order_number })).status()).toBe(400);
    expect((await lookup(request, { phone: a.tel, orderNumber: a.row.order_number, id: a.row.id })).status()).toBe(400);
    expect((await db('SELECT count(*)::int n FROM order_lookup_attempts WHERE phone_e164 = $1', [a.tel]))[0].n).toBe(before);
    expect((await lookup(request, { phone: a.tel, orderNumber: a.row.order_number }, { origin: 'https://evil.example' })).status()).toBe(403);
    // the screen says the same thing for every miss
    await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': dbh.randomIp() });
    await page.goto('/find-order');
    await page.getByLabel('מספר טלפון נייד').fill(b.tel);
    await page.getByLabel('מספר הזמנה').fill(a.row.order_number);
    await page.getByTestId('find-order-submit').click();
    await expect(page.getByTestId('find-order-not-found')).toBeVisible();
    await page.screenshot({ path: join(SCREENS, 'find-order-not-found.png'), fullPage: true });
  });

  test('rate limited in the DB per phone (5/hour) and per IP (10/hour), whether or not the phone exists; the real client IP is recorded', async ({ request }) => {
    const o = await checkout(request);
    for (let i = 0; i < 5; i++) expect((await lookup(request, { phone: o.tel, orderNumber: `AQQQ-Q${i}Q` })).status()).toBe(200);
    // sixth from a fresh IP, with the RIGHT number: still refused
    const limited = await lookup(request, { phone: o.tel, orderNumber: o.row.order_number });
    expect(limited.status()).toBe(429);
    expect(await limited.json()).toEqual({ error: 'too_many_attempts' });

    const ip = dbh.randomIp();
    for (let i = 0; i < 10; i++) expect((await lookup(request, { phone: phone(), orderNumber: 'AQQQ-QQQ' }, { from: ip })).status()).toBe(200);
    expect((await lookup(request, { phone: phone(), orderNumber: 'AQQQ-QQQ' }, { from: ip })).status()).toBe(429);
    const rows = await db('SELECT count(*)::int n FROM order_lookup_attempts WHERE ip_address = $1', [ip]);
    expect(rows[0].n).toBe(10);
  });

  test('DB: the lookup is service-role only now (the IP comes from the server), anon and a signed-in user are refused', async ({ request }) => {
    const o = await checkout(request);
    for (const role of ['anon', 'authenticated']) {
      const err = await dbh.withClient((c) => dbh.asRole(c, role, { sub: crypto.randomUUID() }, 'SELECT * FROM fn_lookup_order_by_phone_and_number($1, $2, $3)', ['1.2.3.4', `+972${o.tel.slice(1)}`, o.row.order_number])).then(() => 'ok', (e) => e.message);
      expect(err).toMatch(/permission denied/);
    }
    const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { error } = await anon.rpc('fn_lookup_order_by_phone_and_number', { p_ip_address: '1.2.3.4', p_phone: o.tel, p_order_number: o.row.order_number });
    expect(error).not.toBeNull();
  });
});
