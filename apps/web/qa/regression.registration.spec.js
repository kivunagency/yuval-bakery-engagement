// @ts-check
// Regression: optional customer registration (api-010, client-005, PRD US-4).
// Runs against a local production build + the local stack, with email
// confirmation ON and Auth's mail captured by the local SMTP sink.
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { localEnv } = require('./helpers/env');
const { withClient, asRole, freshDay, freshProduct, createOrder, randomIp } = require('./helpers/db');
const { newIdentity, registerBody, createConfirmedCustomer } = require('./helpers/customer');
const { waitForMail, mailsTo, confirmPathFrom } = require('./helpers/mail');
const { createAdmin } = require('./helpers/admin');

const ORIGIN = `http://localhost:${process.env.PORT || 3100}`;

/** POST /api/customers from a fresh client IP (the per-IP limit is its own test). */
function postRegister(request, body, { ip = randomIp(), origin = ORIGIN } = {}) {
  const headers = { 'content-type': 'application/json', 'x-nf-client-connection-ip': ip };
  if (origin) headers.origin = origin;
  return request.post('/api/customers', { data: body, headers, maxRedirects: 0 });
}

async function customerRow(email) {
  return withClient(async (db) => (await db.query('SELECT * FROM customers WHERE email = $1', [email])).rows[0]);
}

async function authUser(email) {
  return withClient(async (db) => (await db.query('SELECT id, email_confirmed_at, raw_user_meta_data FROM auth.users WHERE email = $1', [email])).rows[0]);
}

test.describe('api-010 POST /api/customers', () => {
  test('new address: 202 check_email, a confirmation mail, no profile until the link is opened', async ({ request }) => {
    const id = newIdentity();
    const res = await postRegister(request, registerBody(id, { phone: `0${id.phone.slice(4, 6)}-${id.phone.slice(6)}` }));
    expect(res.status()).toBe(202);
    expect(await res.json()).toEqual({ status: 'check_email' });
    expect(res.headers()['cache-control']).toContain('no-store');

    const mail = await waitForMail(id.email);
    expect(confirmPathFrom(mail)).toMatch(/^\/account\/confirm\?token_hash=[0-9a-f]+&type=email$/);
    expect(await customerRow(id.email)).toBeUndefined();
    const user = await authUser(id.email);
    expect(user.email_confirmed_at).toBeNull();
    // Parked until confirmation, phone already normalized to E.164.
    expect(user.raw_user_meta_data.yb_registration).toEqual({ name: id.name, phone: id.phone, privacy_notice_version: 'privacy-2026-10-v1', age_confirmed: true });
  });

  test('the mail link confirms and creates the profile: email from Auth, no consent, parked data removed', async ({ request }) => {
    const id = newIdentity();
    expect((await postRegister(request, registerBody(id))).status()).toBe(202);
    const confirm = await request.get(confirmPathFrom(await waitForMail(id.email)), { maxRedirects: 0 });
    expect(confirm.status()).toBe(307);
    expect(confirm.headers().location).toBe('/account/welcome');
    expect(confirm.headers()['set-cookie'] ?? '').toContain('auth-token');

    const row = await customerRow(id.email);
    expect(row).toMatchObject({ name: id.name, phone: id.phone, email: id.email, marketing_opt_in: false, privacy_notice_version: 'privacy-2026-10-v1', birthday_day: null });
    expect(row.age_confirmed_18_at).not.toBeNull();
    expect((await authUser(id.email)).raw_user_meta_data.yb_registration).toBeUndefined();
    const events = await withClient(async (db) => (await db.query('SELECT count(*)::int n FROM consent_events WHERE customer_id = $1', [row.id])).rows[0].n);
    expect(events).toBe(0);

    // The link works once.
    const again = await request.get(confirmPathFrom((await mailsTo(id.email))[0]), { maxRedirects: 0 });
    expect(again.headers().location).toBe('/account/login?notice=link_invalid');
  });

  test('no enumeration: a registered address gets the same answer and no second account', async ({ request }) => {
    const existing = await createConfirmedCustomer();
    const fresh = newIdentity();
    const a = await postRegister(request, registerBody({ ...newIdentity(), email: existing.email }));
    const b = await postRegister(request, registerBody(fresh));
    expect(a.status()).toBe(b.status());
    expect(await a.json()).toEqual(await b.json());
    expect(await withClient(async (db) => (await db.query('SELECT count(*)::int n FROM auth.users WHERE email = $1', [existing.email])).rows[0].n)).toBe(1);
    expect((await customerRow(existing.email)).phone).toBe(existing.phone);
  });

  test('a bad or used link, and a link of the wrong type, go to sign-in with a notice', async ({ request }) => {
    for (const q of ['token_hash=deadbeefdeadbeefdeadbeef&type=email', 'type=email', 'token_hash=deadbeefdeadbeefdeadbeef&type=recovery', 'token_hash=%3Cscript%3E&type=email']) {
      const res = await request.get(`/account/confirm?${q}`, { maxRedirects: 0 });
      expect(res.headers().location).toBe('/account/login?notice=link_invalid');
    }
  });

  test('a phone that already has an account: the confirmed user is asked to complete details, no row', async ({ request }) => {
    const owner = await createConfirmedCustomer();
    const id = { ...newIdentity(), phone: owner.phone };
    expect((await postRegister(request, registerBody(id))).status()).toBe(202);
    const res = await request.get(confirmPathFrom(await waitForMail(id.email)), { maxRedirects: 0 });
    expect(res.headers().location).toBe('/account/complete?reason=phone_taken');
    expect(await customerRow(id.email)).toBeUndefined();
  });

  test('validation: 400 with the failing fields; marketing consent cannot ride along (s.30A)', async ({ request }) => {
    const cases = [
      [{ phone: '03-1234567' }, 'invalid_input', ['phone']],
      [{ email: 'not-an-email' }, 'invalid_input', ['email']],
      [{ ageConfirmed: false }, 'invalid_input', ['ageConfirmed']],
      [{ privacyNoticeVersion: 'privacy-2020-01-v0' }, 'invalid_input', ['privacyNoticeVersion']],
      [{ name: '' }, 'invalid_input', ['name']],
      [{ marketingOptIn: true }, 'invalid_input', []],
      [{ marketing: 'granted' }, 'invalid_input', []],
      [{ password: 'short-11chr' }, 'weak_password', ['password']],
    ];
    for (const [patch, error, fields] of cases) {
      const res = await postRegister(request, registerBody(newIdentity(), patch));
      expect(res.status(), JSON.stringify(patch)).toBe(400);
      const body = await res.json();
      expect(body.error, JSON.stringify(patch)).toBe(error);
      for (const f of fields) expect(body.fields).toContain(f);
    }
    const notJson = await request.post('/api/customers', { data: 'x', headers: { 'content-type': 'application/json', origin: ORIGIN } });
    expect(notJson.status()).toBe(400);
  });

  test('CSRF: no Origin or a foreign Origin is refused before anything happens', async ({ request }) => {
    const id = newIdentity();
    expect((await postRegister(request, registerBody(id), { origin: null })).status()).toBe(403);
    expect((await postRegister(request, registerBody(id), { origin: 'https://evil.example' })).status()).toBe(403);
    expect(await authUser(id.email)).toBeUndefined();
  });

  test('rate limit: 3 sign-ups per address and 5 per IP per window, then 429 and no mail', async ({ request }) => {
    const id = newIdentity();
    for (let i = 0; i < 3; i++) expect((await postRegister(request, registerBody(id))).status()).toBe(202);
    const limited = await postRegister(request, registerBody(id));
    expect(limited.status()).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });

    const ip = randomIp();
    for (let i = 0; i < 5; i++) expect((await postRegister(request, registerBody(newIdentity()), { ip })).status()).toBe(202);
    const blocked = newIdentity();
    expect((await postRegister(request, registerBody(blocked), { ip })).status()).toBe(429);
    await new Promise((r) => setTimeout(r, 500));
    expect(mailsTo(blocked.email)).toEqual([]);
  });
});

test.describe('api-010 DB contract', () => {
  test('anon can call none of the new functions; authenticated cannot reach the rate-limit internals', async () => {
    const env = localEnv();
    const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const calls = [
      ['fn_register_customer', { p_name: 'x', p_phone: '+972501234567', p_privacy_notice_version: 'privacy-2026-10-v1', p_age_confirmed: true }],
      ['fn_update_my_profile', { p_name: 'x', p_phone: '+972501234567', p_birthday_day: null, p_birthday_month: null, p_anniversary_day: null, p_anniversary_month: null }],
      ['fn_customer_auth_attempt_begin', { p_kind: 'signup', p_ip: '1.1.1.1', p_account: 'a' }],
      ['fn_customer_auth_attempt_finish', { p_attempt_id: 1, p_succeeded: true }],
      ['fn_is_day_of_month', { p_day: 1, p_month: 1 }],
    ];
    for (const [fn, args] of calls) {
      const { error } = await anon.rpc(fn, args);
      expect(error?.message, fn).toContain('permission denied');
    }
    const { client } = await createConfirmedCustomer();
    for (const [fn, args] of calls.slice(2, 4)) {
      const { error } = await client.rpc(fn, args);
      expect(error?.message, fn).toContain('permission denied');
    }
  });

  test('fn_register_customer: needs a confirmed email, refuses admins, is idempotent', async () => {
    await withClient(async (db) => {
      const uid = crypto.randomUUID();
      await db.query(`INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at) VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, now(), now())`, [uid, `unconfirmed-${uid}@example.test`]);
      const call = `SELECT fn_register_customer('QA', '+972509999999', 'privacy-2026-10-v1', true) r`;
      await expect(asRole(db, 'authenticated', { sub: uid }, call)).rejects.toThrow(/customer_email_not_confirmed/);
      await expect(asRole(db, 'anon', {}, call)).rejects.toThrow(/permission denied/);
      await db.query('DELETE FROM auth.users WHERE id = $1', [uid]);
    });
    const admin = await createAdmin();
    const { error } = await admin.client.rpc('fn_register_customer', { p_name: 'QA', p_phone: '+972509999998', p_privacy_notice_version: 'privacy-2026-10-v1', p_age_confirmed: true });
    expect(error?.message).toContain('customer_sign_in_required');

    const c = await createConfirmedCustomer();
    const again = await c.client.rpc('fn_register_customer', { p_name: 'Other', p_phone: '+972509999997', p_privacy_notice_version: 'privacy-2026-10-v1', p_age_confirmed: true });
    expect(again.data).toBe('exists');
    expect((await customerRow(c.email)).name).toBe(c.name);
  });

  test('fn_register_customer refuses a wrong privacy version, no age declaration, a bad phone', async () => {
    const c = await createConfirmedCustomer({ register: false });
    const base = { p_name: 'QA', p_phone: c.phone, p_privacy_notice_version: 'privacy-2026-10-v1', p_age_confirmed: true };
    expect((await c.client.rpc('fn_register_customer', { ...base, p_privacy_notice_version: 'x' })).error?.message).toContain('privacy_notice_version_mismatch');
    expect((await c.client.rpc('fn_register_customer', { ...base, p_age_confirmed: false })).error?.message).toContain('customer_age_not_confirmed');
    expect((await c.client.rpc('fn_register_customer', { ...base, p_phone: '0501234567' })).error?.message).toContain('customer_invalid_input');
    expect((await c.client.rpc('fn_register_customer', base)).data).toBe('created');
  });

  test('writes only through functions: a customer cannot UPDATE customers directly, not even their own row', async () => {
    const c = await createConfirmedCustomer();
    const { error } = await c.client.from('customers').update({ name: 'hacked' }).eq('id', c.userId);
    expect(error?.message).toContain('permission denied');
    const { error: optIn } = await c.client.from('customers').update({ marketing_opt_in: true }).eq('id', c.userId);
    expect(optIn?.message).toContain('permission denied');
    expect((await customerRow(c.email)).name).toBe(c.name);
  });

  test('birthday/anniversary only with marketing consent, real dates only, erased on withdrawal', async () => {
    const c = await createConfirmedCustomer();
    const profile = (b, a) => ({ p_name: c.name, p_phone: c.phone, p_birthday_day: b?.[0] ?? null, p_birthday_month: b?.[1] ?? null, p_anniversary_day: a?.[0] ?? null, p_anniversary_month: a?.[1] ?? null });

    expect((await c.client.rpc('fn_update_my_profile', profile([12, 5]))).error?.message).toContain('customer_dates_require_marketing_consent');
    // Even the superuser cannot store a date without consent: it is a CHECK.
    await withClient(async (db) => {
      await expect(db.query('UPDATE customers SET birthday_day = 1, birthday_month = 1 WHERE id = $1', [c.userId])).rejects.toThrow(/customers_dates_require_marketing_consent/);
    });

    const grant = await c.client.rpc('fn_set_marketing_consent', { p_customer_id: c.userId, p_action: 'granted', p_consent_version: 'marketing-2026-10-v1', p_source: 'profile' });
    expect(grant.error).toBeNull();
    expect((await c.client.rpc('fn_update_my_profile', profile([31, 2]))).error?.message).toContain('customer_invalid_date');
    expect((await c.client.rpc('fn_update_my_profile', profile([12, null]))).error?.message).toContain('customer_invalid_date');
    expect((await c.client.rpc('fn_update_my_profile', profile([29, 2], [14, 6]))).error).toBeNull();
    expect(await customerRow(c.email)).toMatchObject({ birthday_day: 29, birthday_month: 2, anniversary_day: 14, anniversary_month: 6 });

    await c.client.rpc('fn_set_marketing_consent', { p_customer_id: c.userId, p_action: 'withdrawn', p_consent_version: 'marketing-2026-10-v1', p_source: 'profile' });
    expect(await customerRow(c.email)).toMatchObject({ marketing_opt_in: false, birthday_day: null, birthday_month: null, anniversary_day: null, anniversary_month: null });
  });

  test('profile phone must stay unique; name and phone are validated', async () => {
    const a = await createConfirmedCustomer();
    const b = await createConfirmedCustomer();
    const args = { p_name: b.name, p_phone: a.phone, p_birthday_day: null, p_birthday_month: null, p_anniversary_day: null, p_anniversary_month: null };
    expect((await b.client.rpc('fn_update_my_profile', args)).error?.message).toContain('customer_phone_taken');
    expect((await b.client.rpc('fn_update_my_profile', { ...args, p_phone: 'x' })).error?.message).toContain('customer_invalid_input');
    expect((await b.client.rpc('fn_update_my_profile', { ...args, p_phone: b.phone, p_name: ' ' })).error?.message).toContain('customer_invalid_input');
  });

  test('consent: a customer records only registration/profile sources, the exact version, for their own row', async () => {
    const c = await createConfirmedCustomer();
    const other = await createConfirmedCustomer();
    const call = (args) => c.client.rpc('fn_set_marketing_consent', { p_customer_id: c.userId, p_action: 'granted', p_consent_version: 'marketing-2026-10-v1', p_source: 'registration', ...args });
    expect((await call({ p_source: 'account_deletion' })).error?.message).toContain('consent_source_not_allowed');
    expect((await call({ p_source: 'admin_on_request' })).error?.message).toContain('admin_on_request_requires_admin');
    expect((await call({ p_consent_version: 'marketing-2020-01-v0' })).error?.message).toContain('consent_version_mismatch');
    expect((await call({ p_customer_id: other.userId })).error?.message).toContain('consent_not_own');
    expect((await call({})).data).toBe(true);
    const events = await withClient(async (db) => (await db.query('SELECT action, source, consent_version, customer_email_snapshot FROM consent_events WHERE customer_id = $1', [c.userId])).rows);
    expect(events).toEqual([{ action: 'granted', source: 'registration', consent_version: 'marketing-2026-10-v1', customer_email_snapshot: c.email }]);
  });

  test('the code version of the marketing label equals app_settings.active_marketing_consent_version', async () => {
    const { rows } = await withClient((db) => db.query(`SELECT value #>> '{}' v FROM app_settings WHERE key = 'active_marketing_consent_version'`));
    expect(rows[0].v).toBe('marketing-2026-10-v1'); // TEXT_VERSIONS.marketing in lib/shared/compliance/versions.ts
  });

  test('SEC-003: a customer sees only orders with their own customer_id, never a guest order with their phone', async () => {
    const c = await createConfirmedCustomer();
    const other = await createConfirmedCustomer();
    await withClient(async (db) => {
      const day = await freshDay(db, { oven: 600, work: 600 });
      const product = await freshProduct(db, { oven: 1, work: 1 });
      const guest = await createOrder(db, day, product);
      await db.query('UPDATE orders SET guest_phone = $2 WHERE id = $1', [guest.id, c.phone]);
      const mine = await createOrder(db, day, product);
      await db.query('UPDATE orders SET customer_id = $2 WHERE id = $1', [mine.id, c.userId]);
      const theirs = await createOrder(db, day, product);
      await db.query('UPDATE orders SET customer_id = $2 WHERE id = $1', [theirs.id, other.userId]);
      const { data, error } = await c.client.from('orders').select('order_number');
      expect(error).toBeNull();
      expect((data ?? []).map((o) => o.order_number)).toEqual([mine.order_number]);
    });
  });
});

test.describe('api-010 POST /api/unsubscribe (one click, no sign-in)', () => {
  async function optedInCustomer() {
    const c = await createConfirmedCustomer();
    await c.client.rpc('fn_set_marketing_consent', { p_customer_id: c.userId, p_action: 'granted', p_consent_version: 'marketing-2026-10-v1', p_source: 'profile' });
    await c.client.rpc('fn_update_my_profile', { p_name: c.name, p_phone: c.phone, p_birthday_day: 3, p_birthday_month: 4, p_anniversary_day: null, p_anniversary_month: null });
    const token = (await customerRow(c.email)).unsubscribe_token;
    return { ...c, token };
  }

  test('form post from the page: 303 to the result, consent withdrawn at once, dates erased, logged as unsubscribe_link', async ({ request }) => {
    const c = await optedInCustomer();
    const res = await request.post('/api/unsubscribe', { form: { token: c.token }, maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(new URL(res.headers().location).pathname + new URL(res.headers().location).search).toBe('/unsubscribe/done?result=done');
    expect(await customerRow(c.email)).toMatchObject({ marketing_opt_in: false, birthday_day: null, birthday_month: null });
    const last = await withClient(async (db) => (await db.query('SELECT action, source FROM consent_events WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1', [c.userId])).rows[0]);
    expect(last).toEqual({ action: 'withdrawn', source: 'unsubscribe_link' });
  });

  test('RFC 8058 one-click post with the token in the query: 200; unknown token 404; malformed token 404', async ({ request }) => {
    const c = await optedInCustomer();
    const ok = await request.post(`/api/unsubscribe?token=${c.token}`, { form: { 'List-Unsubscribe': 'One-Click' } });
    expect(ok.status()).toBe(200);
    expect((await customerRow(c.email)).marketing_opt_in).toBe(false);
    expect((await request.post(`/api/unsubscribe?token=${'0'.repeat(32)}`, { form: { 'List-Unsubscribe': 'One-Click' } })).status()).toBe(404);
    expect((await request.post(`/api/unsubscribe?token=abc'--`, { form: { 'List-Unsubscribe': 'One-Click' } })).status()).toBe(404);
    const bad = await request.post('/api/unsubscribe', { form: { token: 'nope' }, maxRedirects: 0 });
    expect(bad.headers().location).toContain('/unsubscribe/done?result=invalid');
  });
});
