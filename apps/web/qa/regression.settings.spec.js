// @ts-check
// Settings domain regression (wave 3, session N): business details (s.14C),
// and the app_settings write lockdown + floors/ceilings (N11) under them.
// Real chain: browser session (password + TOTP) -> Next.js route -> PostgREST
// as the admin's own aal2 JWT -> SECURITY DEFINER function -> app_settings +
// audit_log -> the public site reading fn_public_site_settings().
//
// Business details are global: every test that sets them restores JSON null
// in `finally`, because other specs (compliance) expect the placeholders.
const { test, expect } = require('@playwright/test');
const { join } = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { createUser, db, randomIp, uiLogin } = require('./helpers/admin-ui');
const { createAdmin } = require('./helpers/admin');
const { localEnv } = require('./helpers/env');
const { SCREENS } = require('./helpers/baseline');
const { capturedTo } = require('./helpers/notification');
const { totp } = require('./helpers/admin');

const BUSINESS_KEYS = ['business_name', 'business_owner_name', 'business_registration_number', 'business_address', 'business_phone', 'business_whatsapp', 'business_email'];

/** Everything this spec changes, back to what a fresh database has. */
async function resetSettings() {
  await db(`UPDATE app_settings SET value = 'null'::jsonb, updated_by = NULL WHERE key IN ('payment_link_bit', 'payment_link_paybox')`);
  for (const k of BUSINESS_KEYS) await db(`UPDATE app_settings SET value = 'null'::jsonb, updated_by = NULL WHERE key = $1`, [k]);
  await db(`UPDATE app_settings SET value = '"exempt"'::jsonb, updated_by = NULL WHERE key = 'vat_status'`);
}

const settingsRows = async () =>
  Object.fromEntries((await db(`SELECT key, value, updated_by::text AS by FROM app_settings WHERE key LIKE 'business\\_%' OR key = 'vat_status'`)).map((r) => [r.key, r]));

function collectErrors(page) {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** Baseline every admin screen shares (as regression.delivery.spec.js), plus a screenshot. */
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
        const visible = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && el.getAttribute('type') !== 'hidden';
        return visible && (r.width < 44 || r.height < 44);
      })
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(small).toEqual([]);
  await page.screenshot({ path: join(SCREENS, `admin-${name}.png`), fullPage: true });
  expect(errors).toEqual([]);
}

test.describe('app_settings: no direct writes, floors and ceilings (N11)', () => {
  test('an aal2 admin can no longer UPDATE app_settings through PostgREST; anon neither', async () => {
    const { client } = await createAdmin();
    const before = await db(`SELECT value FROM app_settings WHERE key = 'payment_link_bit'`);
    const upd = await client.from('app_settings').update({ value: 'https://evil.example/pay' }).eq('key', 'payment_link_bit').select();
    expect(upd.error?.message ?? '').toContain('permission denied');
    const anon = createClient(localEnv().NEXT_PUBLIC_SUPABASE_URL, localEnv().NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    expect((await anon.from('app_settings').update({ value: '1' }).eq('key', 'guest_pii_months').select()).error?.message ?? '').toContain('permission denied');
    expect(await db(`SELECT value FROM app_settings WHERE key = 'payment_link_bit'`)).toEqual(before);
    // The privilege itself, not only the policy.
    const [priv] = await db(`SELECT has_table_privilege('authenticated', 'app_settings', 'UPDATE') AS u, has_table_privilege('authenticated', 'app_settings', 'INSERT') AS i`);
    expect(priv).toEqual({ u: false, i: false });
  });

  test('floors and ceilings hold for every writer, even the superuser', async () => {
    const cases = [
      ['guest_pii_months', '5'], ['guest_pii_months', '85'], ['guest_pii_months', '"24"'],
      ['photo_retention_days', '0'], ['photo_retention_days', '366'],
      ['inactive_profile_months', '11'], ['inactive_profile_months', '121'],
      ['payment_pending_expiry_hours_standard', '0'], ['payment_pending_expiry_hours_standard', '73'], ['payment_pending_expiry_hours_standard', '2.5'],
      ['payment_pending_expiry_hours_custom_cake', '169'],
      ['day_limited_threshold_pct', '0'], ['day_limited_threshold_pct', '100'],
      ['vat_status', '"other"'], ['vat_status', 'null'],
      ['earliest_slot_time', '"25:00"'], ['earliest_slot_time', '"9:00"'],
      ['business_name', '42'], ['payment_link_bit', `"${'x'.repeat(501)}"`],
    ];
    for (const [key, value] of cases) {
      await expect(db(`UPDATE app_settings SET value = $2::jsonb WHERE key = $1`, [key, value]), `${key}=${value}`).rejects.toThrow(`setting_out_of_range: ${key}`);
    }
    // The edges are accepted (and put back).
    for (const [key, edge, back] of [['guest_pii_months', '84', null], ['payment_pending_expiry_hours_standard', '1', null], ['day_limited_threshold_pct', '99', null]]) {
      const [saved] = await db(`SELECT value FROM app_settings WHERE key = $1`, [key]);
      await db(`UPDATE app_settings SET value = $2::jsonb WHERE key = $1`, [key, edge]);
      await db(`UPDATE app_settings SET value = $2::jsonb WHERE key = $1`, [key, back ?? JSON.stringify(saved.value)]);
    }
  });
});

test.describe('business details API (settings-business)', () => {
  test('anonymous visitor and an aal1 session get 401; nothing written', async ({ request }) => {
    for (const res of [await request.get('/api/admin/settings/business'), await request.put('/api/admin/settings/business', { data: { name: 'x' } })]) {
      expect(res.status()).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    // The DB refuses a non-aal2 caller on its own too.
    const { client } = await createAdmin({ withMfa: false });
    const r = await client.rpc('fn_admin_set_business_details', { p_values: { business_name: 'QA aal1' } });
    expect(r.error?.message).toBe('admin_aal2_required');
    expect((await settingsRows()).business_name.value).toBeNull();
  });

  test('admin at aal2: Origin required, 400 per bad field (named), set, normalize, unset, audited with from/to; the site shows it', async ({ page, baseURL }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const api = page.request;
    const headers = { origin: baseURL ?? '' };
    try {
      expect((await api.put('/api/admin/settings/business', { data: { name: 'QA עסק' } })).status()).toBe(403);
      expect((await api.put('/api/admin/settings/business', { headers: { origin: 'https://evil.example' }, data: { name: 'QA עסק' } })).status()).toBe(403);

      for (const [data, fields] of [
        [{ name: 'x' }, ['name']],
        [{ registrationNumber: '123456789' }, ['registrationNumber']],
        [{ phone: '12345' }, ['phone']],
        [{ whatsapp: '+1 212 555 0100' }, ['whatsapp']],
        [{ email: 'nope' }, ['email']],
        [{ address: 'a' }, ['address']],
        [{ vatStatus: 'other' }, ['vatStatus']],
        [{ vatStatus: null }, ['vatStatus']],
        [{ business_name: 'direct key' }, []],
        [{}, []],
      ]) {
        const r = await api.put('/api/admin/settings/business', { headers, data });
        expect(r.status(), JSON.stringify(data)).toBe(400);
        const body = await r.json();
        expect(body.error).toBe('invalid_input');
        expect(body.fields ?? []).toEqual(fields);
      }
      // The DB repeats the rules for a caller that skips the API.
      const { client } = await createAdmin();
      for (const [values, code] of [
        [{ business_registration_number: '123456789' }, 'settings_invalid_value: business_registration_number'],
        [{ business_phone: '050-123-4567' }, 'settings_invalid_value: business_phone'],
        [{ business_name: '  padded ' }, 'settings_invalid_value: business_name'],
        [{ payment_link_bit: 'https://bitpay.co.il/x' }, 'settings_invalid_input'],
        [{ vat_status: null }, 'settings_invalid_value: vat_status'],
      ]) {
        expect((await client.rpc('fn_admin_set_business_details', { p_values: values })).error?.message).toBe(code);
      }
      expect(Object.values(await settingsRows()).filter((r) => r.key !== 'vat_status').every((r) => r.value === null)).toBe(true);

      const auditBefore = (await db(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'settings.business_details_updated'`))[0].n;
      const res = await api.put('/api/admin/settings/business', {
        headers,
        data: {
          name: '  QA  קונדיטוריה ',
          ownerName: 'QA בעלים',
          registrationNumber: '12345-6782',
          address: 'QA רחוב הבדיקה 1, עיר',
          phone: '050-123-4567',
          whatsapp: '052 765 4321',
          email: 'qa-shop@example.test',
          vatStatus: 'licensed',
        },
      });
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({
        name: 'QA קונדיטוריה',
        ownerName: 'QA בעלים',
        registrationNumber: '123456782',
        address: 'QA רחוב הבדיקה 1, עיר',
        phone: '+972501234567',
        whatsapp: '+972527654321',
        email: 'qa-shop@example.test',
        vatStatus: 'licensed',
        vatStatusConfirmed: true,
      });
      const rows = await settingsRows();
      expect(rows.business_phone.value).toBe('+972501234567');
      expect(rows.business_name.by).toBe(admin.userId);
      expect(rows.vat_status.by).toBe(admin.userId);

      const [audit] = await db(
        `SELECT actor_type, actor_id, metadata FROM audit_log WHERE action = 'settings.business_details_updated' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit.actor_type).toBe('admin');
      expect(audit.actor_id).toBe(admin.userId);
      expect(audit.metadata.changed.business_name).toEqual({ from: null, to: 'QA קונדיטוריה' });
      expect(audit.metadata.changed.vat_status).toEqual({ from: 'exempt', to: 'licensed' });

      // The same values again: nothing changes, no second audit row.
      expect((await api.put('/api/admin/settings/business', { headers, data: { name: 'QA קונדיטוריה', vatStatus: 'licensed' } })).status()).toBe(200);
      expect((await db(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'settings.business_details_updated'`))[0].n).toBe(auditBefore + 1);

      // The public site reads it through fn_public_site_settings (footer, /business).
      await page.goto('/business');
      await expect(page.locator('body')).toContainText('QA קונדיטוריה');
      await expect(page.locator('body')).toContainText('123456782');
      await expect(page.locator('a[href="tel:+972501234567"]').first()).toBeVisible();
      await expect(page.locator('a[href^="https://wa.me/972527654321"]').first()).toBeVisible();

      // Unset: "" and null both mean unset; the placeholder comes back.
      const unset = await api.put('/api/admin/settings/business', { headers, data: { name: '', phone: null } });
      expect(unset.status()).toBe(200);
      expect(await unset.json()).toMatchObject({ name: null, phone: null, ownerName: 'QA בעלים' });
      await page.goto('/business');
      await expect(page.locator('body')).toContainText('[שם העסק]');
      await expect(page.locator('body')).toContainText('[טלפון העסק]');
      expect(await page.locator('a[href^="tel:"]').count()).toBe(0);
    } finally {
      await resetSettings();
    }
  });
});

test.describe('business details screen (settings-business)', () => {
  test('arrives with its data, shows what the site shows when empty, marks bad fields, saves only changes, confirms the osek type', async ({ page }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    try {
      await uiLogin(page, admin);
      const errors = collectErrors(page);
      await page.goto('/admin/settings');
      const link = page.getByTestId('settings-link-business');
      await expect(link).toContainText('פרטי העסק');
      await expect(link).toContainText('7 פרטים עוד לא מולאו');
      await expect(link).toContainText('סוג העוסק עוד לא אושר.');
      // The other Settings sections are still there.
      await expect(page.getByRole('heading', { name: 'אזורי משלוח' })).toBeVisible();
      await adminBaseline(page, 'settings-hub', errors);

      const requests = [];
      page.on('request', (r) => r.resourceType() === 'fetch' && requests.push(r.url()));
      await link.click();
      await page.waitForURL('**/admin/settings/business');
      await expect(page.getByRole('heading', { level: 1, name: 'פרטי העסק' })).toBeVisible();
      expect(requests.filter((u) => u.includes('/api/'))).toEqual([]); // arrives with its data
      await expect(page.getByTestId('business-name')).toHaveValue('');
      await expect(page.getByText('ריק: באתר מופיע [שם העסק].')).toBeVisible();
      await expect(page.getByTestId('business-vat-unconfirmed')).toContainText('עוסק פטור');
      await expect(page.getByTestId('business-vat-exempt')).not.toBeChecked();
      await expect(page.getByTestId('business-vat-licensed')).not.toBeChecked();
      // LTR fields are LTR.
      for (const f of ['registrationNumber', 'phone', 'whatsapp', 'email']) await expect(page.getByTestId(`business-${f}`)).toHaveAttribute('dir', 'ltr');
      await adminBaseline(page, 'settings-business-empty', errors);

      // Bad values: marked in words, nothing sent.
      await page.getByTestId('business-registrationNumber').fill('123456789');
      await page.getByTestId('business-phone').fill('123');
      await page.getByRole('button', { name: 'שמירת הפרטים' }).click();
      await expect(page.getByTestId('business-message')).toHaveText('חלק מהפרטים לא תקינים. בשדות המסומנים כתוב מה לתקן.');
      await expect(page.getByTestId('business-registrationNumber')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByText('למספר עוסק יש 9 ספרות וספרת ביקורת תקינה, כמו מספר תעודת זהות.')).toBeVisible();
      await expect(page.getByTestId('business-registrationNumber')).toBeFocused();
      await page.screenshot({ path: join(SCREENS, 'admin-settings-business-invalid.png'), fullPage: true });
      expect((await settingsRows()).business_registration_number.value).toBeNull();

      await page.getByTestId('business-registrationNumber').fill('123456782');
      await page.getByTestId('business-phone').fill('050-123-4567');
      await page.getByTestId('business-name').fill('QA מאפה בדיקה');
      await page.getByTestId('business-email').fill('qa-ui@example.test');
      await page.getByTestId('business-vat-exempt').check();
      await page.getByRole('button', { name: 'שמירת הפרטים' }).click();
      await expect(page.getByTestId('business-message')).toHaveText('נשמר. האתר מציג את הפרטים החדשים.');

      const rows = await settingsRows();
      expect(rows.business_name.value).toBe('QA מאפה בדיקה');
      expect(rows.business_phone.value).toBe('+972501234567');
      expect(rows.business_owner_name.value).toBeNull(); // untouched: not sent
      expect(rows.vat_status).toMatchObject({ value: 'exempt', by: admin.userId }); // confirming the default is recorded
      const [audit] = await db(`SELECT metadata FROM audit_log WHERE action = 'settings.business_details_updated' AND actor_id = $1 ORDER BY id DESC LIMIT 1`, [admin.userId]);
      expect(Object.keys(audit.metadata.changed).sort()).toEqual(['business_email', 'business_name', 'business_phone', 'business_registration_number', 'vat_status']);

      // After the refresh: the phone in local form, the osek type confirmed.
      await expect(page.getByTestId('business-phone')).toHaveValue('050-123-4567');
      await expect(page.getByTestId('business-vat-exempt')).toBeChecked();
      await expect(page.getByTestId('business-vat-unconfirmed')).toHaveCount(0);
      await expect(page.locator('.admin-brand small')).toHaveText('QA מאפה בדיקה'); // the shell shows the saved name, not the placeholder
      await adminBaseline(page, 'settings-business-filled', errors);

      await page.goto('/admin/settings');
      await expect(page.getByTestId('settings-link-business')).toContainText('3 פרטים עוד לא מולאו');
      await expect(page.getByTestId('settings-link-business')).not.toContainText('סוג העוסק');
    } finally {
      await resetSettings();
    }
  });
});

// ---------------------------------------------------------------- payment links (SEC-009)

/** A TOTP code from a 30-second step later than `after` (Auth may refuse a code already used in its step). */
async function freshCode(secret, after = Date.now()) {
  const step = (t) => Math.floor(t / 30000);
  while (step(Date.now()) === step(after)) await new Promise((r) => setTimeout(r, 500));
  return totp(secret);
}

/** An HS256 access token for `sub` signed with the local stack's JWT secret, with a TOTP step `totpAgeSeconds` ago. */
function signedAdminToken(sub, totpAgeSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    sub, role: 'authenticated', aud: 'authenticated', aal: 'aal2', iat: now, exp: now + 600,
    amr: [{ method: 'totp', timestamp: now - totpAgeSeconds }, { method: 'password', timestamp: now - totpAgeSeconds }],
  })}`;
  const sig = require('node:crypto').createHmac('sha256', localEnv().SUPABASE_JWT_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

const BIT = 'https://www.bitpay.co.il/app/me/QA-TEST-LINK';
const PAYBOX = 'https://links.payboxapp.com/QA-TEST-LINK';
const paymentRows = async () =>
  Object.fromEntries((await db(`SELECT key, value, updated_by::text AS by FROM app_settings WHERE key LIKE 'payment\\_link\\_%'`)).map((r) => [r.key, r]));

test.describe('payment links (settings-payment, SEC-009)', () => {
  // freshCode() may wait up to 30 s for the next TOTP step; a killed test would skip its reset.
  test.describe.configure({ timeout: 120_000 });
  test.beforeEach(resetSettings);
  test('the DB itself refuses a change without a TOTP step from the last 5 minutes; allowlist in the DB too', async () => {
    const { userId } = await createAdmin();
    const env = localEnv();
    const as = (token) => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
    try {
      const stale = as(signedAdminToken(userId, 301));
      expect((await stale.rpc('fn_admin_set_payment_links', { p_values: { payment_link_bit: BIT } })).error?.message).toBe('step_up_required');
      expect((await paymentRows()).payment_link_bit.value).toBeNull();

      const fresh = as(signedAdminToken(userId, 10));
      for (const [values, code] of [
        [{ payment_link_bit: 'http://www.bitpay.co.il/x' }, 'settings_invalid_value: payment_link_bit'],
        [{ payment_link_bit: 'https://evil.example/x' }, 'settings_invalid_value: payment_link_bit'],
        [{ payment_link_bit: 'https://www.bitpay.co.il.evil.example/x' }, 'settings_invalid_value: payment_link_bit'],
        [{ payment_link_bit: 'https://user@www.bitpay.co.il/x' }, 'settings_invalid_value: payment_link_bit'],
        [{ payment_link_paybox: BIT }, 'settings_invalid_value: payment_link_paybox'],
        [{ business_name: 'x' }, 'settings_invalid_input'],
      ]) {
        expect((await fresh.rpc('fn_admin_set_payment_links', { p_values: values })).error?.message, JSON.stringify(values)).toBe(code);
      }
      const ok = await fresh.rpc('fn_admin_set_payment_links', { p_values: { payment_link_bit: BIT } });
      expect(ok.error).toBeNull();
      expect(ok.data).toMatchObject({ changed: ['payment_link_bit'], bit: BIT, paybox: null, change_id: expect.any(String) });
      const [audit] = await db(`SELECT actor_id, entity_id, metadata FROM audit_log WHERE action = 'settings.payment_links_updated' ORDER BY id DESC LIMIT 1`);
      expect(audit.actor_id).toBe(userId);
      expect(audit.entity_id).toBe(ok.data.change_id);
      expect(audit.metadata.changed).toEqual({ payment_link_bit: { from: null, to: BIT } });
      expect(audit.metadata.totp_verified_at).toBeTruthy();
      // The business-details function cannot write payment links.
      expect((await fresh.rpc('fn_admin_set_business_details', { p_values: { payment_link_bit: null } })).error?.message).toBe('settings_invalid_input');
      // anon cannot call it, nor read the facts function.
      const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      expect((await anon.rpc('fn_admin_set_payment_links', { p_values: { payment_link_bit: null } })).error?.message ?? '').toContain('permission denied');
      expect((await fresh.rpc('fn_notification_payment_links_facts', { p_change_id: ok.data.change_id })).error?.message ?? '').toContain('permission denied');
    } finally {
      await resetSettings();
    }
  });

  test('API: 401 anon; 403 Origin; 400 names the field (http, other host, missing code); wrong code 401 and nothing written; fresh code saves, audits and emails every admin', async ({ page, request, baseURL }) => {
    expect((await request.put('/api/admin/settings/payment-links', { data: { bit: BIT, code: '123456' } })).status()).toBe(401);
    // The daily email cap (Rule 30) counts every admin mail of the whole suite; this test is about the
    // mail being sent, not the cap (regression.notifications owns that), so it gets room and puts the cap back.
    const [cap] = await db(`SELECT value FROM app_settings WHERE key = 'email_daily_hard_cap'`);
    await db(`UPDATE app_settings SET value = '100000'::jsonb WHERE key = 'email_daily_hard_cap'`);
    const other = await createUser({ admin: true, withTotp: false }); // a second admin: must get the email too
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const loggedInAt = Date.now();
    const api = page.request;
    const headers = { origin: baseURL ?? '', 'x-nf-client-connection-ip': randomIp() }; // own IP: the step-up shares the TOTP rate limit
    try {
      expect((await api.put('/api/admin/settings/payment-links', { data: { bit: BIT, code: '123456' } })).status()).toBe(403);
      for (const [data, fields] of [
        [{ bit: BIT }, ['code']],
        [{ bit: BIT, code: '12345' }, ['code']],
        [{ bit: 'http://www.bitpay.co.il/x', code: '123456' }, ['bit']],
        [{ bit: 'https://evil.example/pay', code: '123456' }, ['bit']],
        [{ paybox: BIT, code: '123456' }, ['paybox']],
        [{ code: '123456' }, []],
        [{ bit: BIT, code: '123456', actor: 'x' }, []],
      ]) {
        const r = await api.put('/api/admin/settings/payment-links', { headers, data });
        expect(r.status(), JSON.stringify(data)).toBe(400);
        const body = await r.json();
        expect(body.error).toBe('invalid_input');
        expect(body.fields ?? []).toEqual(fields);
      }
      const wrong = String((Number(totp(admin.secret)) + 1) % 1_000_000).padStart(6, '0');
      const bad = await api.put('/api/admin/settings/payment-links', { headers, data: { bit: BIT, code: wrong } });
      expect(bad.status()).toBe(401);
      expect(await bad.json()).toEqual({ error: 'invalid_code' });
      expect((await paymentRows()).payment_link_bit.value).toBeNull();

      const res = await api.put('/api/admin/settings/payment-links', { headers, data: { bit: ` ${BIT} `, paybox: PAYBOX, code: await freshCode(admin.secret, loggedInAt) } });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.changed).toEqual(['bit', 'paybox']);
      expect(body.bit).toMatchObject({ value: BIT, shownToCustomers: true });
      expect(body.paybox).toMatchObject({ value: PAYBOX, shownToCustomers: true });
      const rows = await paymentRows();
      expect(rows.payment_link_bit).toMatchObject({ value: BIT, by: admin.userId });
      expect(rows.payment_link_paybox.value).toBe(PAYBOX);

      // Every admin is emailed (after the response: poll), with the new links as text.
      for (const to of [admin.email, other.email]) {
        await expect.poll(() => capturedTo(to).filter((m) => m.subject === 'קישורי התשלום שונו').length, { timeout: 10_000 }).toBe(1);
        const [mail] = capturedTo(to).filter((m) => m.subject === 'קישורי התשלום שונו');
        expect(mail.text).toContain(BIT);
        expect(mail.text).toContain(PAYBOX);
        expect(mail.text).toContain('/admin/settings/payment');
      }
      const [attempt] = await db(`SELECT count(*)::int AS n FROM notification_attempts WHERE event = 'payment_links_changed' AND entity_type = 'setting_change' AND channel = 'email' AND status = 'sent'`);
      expect(attempt.n).toBeGreaterThanOrEqual(2);

      // The order page's read path (service role, allowlist) now returns them.
      const service = createClient(localEnv().NEXT_PUBLIC_SUPABASE_URL, localEnv().SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      expect((await service.rpc('fn_payment_link_settings')).data).toEqual({ bit: BIT, paybox: PAYBOX });

      // Unset one: null; audited; the same code step is still fresh (within 5 minutes).
      const unset = await api.put('/api/admin/settings/payment-links', { headers, data: { paybox: '', code: await freshCode(admin.secret) } });
      expect(unset.status()).toBe(200);
      expect((await unset.json()).paybox).toEqual({ value: null, shownToCustomers: false, updatedAt: expect.any(String) });
      const [last] = await db(`SELECT metadata FROM audit_log WHERE action = 'settings.payment_links_updated' ORDER BY id DESC LIMIT 1`);
      expect(last.metadata.changed).toEqual({ payment_link_paybox: { from: PAYBOX, to: null } });
    } finally {
      await db(`UPDATE app_settings SET value = $1::jsonb WHERE key = 'email_daily_hard_cap'`, [JSON.stringify(cap.value)]);
      await resetSettings();
    }
  });

  test('screen: arrives with its data, asks for the code, wrong code says so, right code saves and says every admin was emailed', async ({ page }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    try {
      await db(`UPDATE app_settings SET value = '"https://evil.example/pay"'::jsonb WHERE key = 'payment_link_paybox'`); // a value the order page refuses
      await uiLogin(page, admin);
      const loggedInAt = Date.now();
      const errors = collectErrors(page);
      await page.goto('/admin/settings');
      const link = page.getByTestId('settings-link-payment');
      await expect(link).toContainText('קישורי תשלום');
      await expect(link).toContainText('2 קישורים לא מוצגים ללקוחות');
      const requests = [];
      page.on('request', (r) => r.resourceType() === 'fetch' && requests.push(r.url()));
      await link.click();
      await page.waitForURL('**/admin/settings/payment');
      expect(requests.filter((u) => u.includes('/api/'))).toEqual([]);
      await expect(page.getByTestId('payment-bit-state')).toHaveAttribute('data-state', 'unset');
      await expect(page.getByTestId('payment-paybox-state')).toHaveAttribute('data-state', 'refused');
      await expect(page.getByTestId('payment-paybox')).toHaveValue('https://evil.example/pay');
      await expect(page.getByTestId('payment-bit')).toHaveAttribute('dir', 'ltr');
      await adminBaseline(page, 'settings-payment', errors);

      await page.getByTestId('payment-bit').fill(BIT);
      await page.getByRole('button', { name: 'שמירת הקישורים' }).click();
      await expect(page.getByTestId('payment-message')).toHaveText('צריך להקליד את הקוד בן 6 הספרות מאפליקציית האימות.');
      await expect(page.getByTestId('payment-code')).toBeFocused();

      const wrong = String((Number(totp(admin.secret)) + 1) % 1_000_000).padStart(6, '0');
      await page.getByTestId('payment-code').fill(wrong);
      await page.getByRole('button', { name: 'שמירת הקישורים' }).click();
      await expect(page.getByTestId('payment-message')).toHaveText('הקוד שגוי או שפג תוקפו. אפשר לנסות שוב עם הקוד הבא.');
      await expect(page.getByTestId('payment-code')).toHaveValue('');
      // Chrome logs the intended 401 of the wrong code as a console error; that one is expected.
      errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('status of 401')));
      await page.screenshot({ path: join(SCREENS, 'admin-settings-payment-wrong-code.png'), fullPage: true });
      expect((await paymentRows()).payment_link_bit.value).toBeNull();

      await page.getByTestId('payment-code').fill(await freshCode(admin.secret, loggedInAt));
      await page.getByRole('button', { name: 'שמירת הקישורים' }).click();
      await expect(page.getByTestId('payment-message')).toHaveText('נשמר. מייל על השינוי נשלח לכל המנהלים.');
      await expect(page.getByTestId('payment-bit-state')).toHaveAttribute('data-state', 'shown');
      await expect(page.getByTestId('payment-bit-state')).toContainText('שונה לאחרונה ב־');
      expect((await paymentRows()).payment_link_bit).toMatchObject({ value: BIT, by: admin.userId });
      expect((await paymentRows()).payment_link_paybox.value).toBe('https://evil.example/pay'); // untouched: not sent
      await adminBaseline(page, 'settings-payment-saved', errors);
    } finally {
      await resetSettings();
    }
  });
});
