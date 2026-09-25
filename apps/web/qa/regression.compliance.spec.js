// @ts-check
// Regression: compliance domain (compliance-001..004, US-0b contact block).
// Runs against a local production build + the local stack.
const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { localEnv } = require('./helpers/env');
const { createAdmin } = require('./helpers/admin');
const { checkPublicBaseline } = require('./helpers/baseline');

// Tests below change business_* settings and restore them: run in order.
test.describe.configure({ mode: 'serial' });

const COMPLIANCE_ROUTES = [{ route: '/business', shot: 'business' }];

const BUSINESS_KEYS = ['business_name', 'business_owner_name', 'business_registration_number', 'business_address', 'business_phone', 'business_whatsapp', 'business_email'];

async function withDb(fn) {
  const db = new Client({ connectionString: localEnv().DATABASE_URL_TEST });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}
async function setSettings(values) {
  await withDb(async (db) => {
    for (const [key, value] of Object.entries(values)) {
      await db.query('UPDATE app_settings SET value = $2::jsonb WHERE key = $1', [key, JSON.stringify(value)]);
    }
  });
}
const resetBusiness = () => setSettings(Object.fromEntries(BUSINESS_KEYS.map((k) => [k, null])));

function anon() {
  const env = localEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
}

test.beforeAll(resetBusiness);
test.afterAll(resetBusiness);

test.describe('compliance pages: public baseline', () => {
  for (const { route, shot } of COMPLIANCE_ROUTES) {
    test(`${route}: baseline (RTL, CSP, 44px, 390px, no console errors)`, async ({ page }) => {
      await checkPublicBaseline(page, route, `${shot}-placeholders`);
      await expect(page.getByTestId('legal-draft-notice')).toBeVisible();
      await expect(page.getByTestId('site-footer')).toBeVisible();
    });
  }
});

test.describe('site footer + contact block (US-0b, s.14C)', () => {
  test('every public page has the footer; unset values show visible placeholders, no links to guessed numbers', async ({ page }) => {
    for (const route of ['/', ...COMPLIANCE_ROUTES.map((r) => r.route)]) {
      await page.goto(route);
      const footer = page.getByTestId('site-footer');
      await expect(footer.getByTestId('footer-business-name')).toHaveText('[שם העסק]');
      await expect(footer.getByTestId('contact-call-placeholder')).toContainText('[טלפון העסק]');
      await expect(footer.getByTestId('contact-whatsapp-placeholder')).toContainText('[מספר וואטסאפ]');
      await expect(footer.locator('a[href^="tel:"], a[href*="wa.me"]')).toHaveCount(0);
      await expect(footer.getByRole('link', { name: 'פרטי העסק' })).toHaveAttribute('href', '/business');
    }
  });

  test('values set by Yuval: tap-to-call, wa.me link, business name; osek number on /business only', async ({ page }) => {
    await setSettings({
      business_name: 'מאפיית בדיקה',
      business_owner_name: 'בודקת בדיקה',
      business_registration_number: '000000018',
      business_address: 'רחוב הבדיקה 1, עיר בדיקה',
      business_phone: '050-0000000',
      business_whatsapp: '+972500000000',
      business_email: 'qa@example.test',
    });
    try {
      await page.goto('/');
      const footer = page.getByTestId('site-footer');
      await expect(footer.getByTestId('footer-business-name')).toHaveText('מאפיית בדיקה');
      await expect(footer.getByTestId('contact-call')).toHaveAttribute('href', 'tel:+972500000000');
      await expect(footer.getByTestId('contact-call')).toContainText('050-000-0000');
      await expect(footer.getByTestId('contact-whatsapp')).toHaveAttribute('href', 'https://wa.me/972500000000');
      await expect(footer).not.toContainText('000000018');

      await checkPublicBaseline(page, '/business', 'business-values');
      await expect(page.getByTestId('business-registration')).toContainText('עוסק פטור מס׳');
      await expect(page.getByTestId('business-registration')).toContainText('000000018');
      await expect(page.getByTestId('business-owner')).toContainText('בודקת בדיקה');
      await expect(page.getByTestId('business-email').locator('a')).toHaveAttribute('href', 'mailto:qa@example.test');
      // bidi: the phone renders inside an LTR isolate, digits in order
      const dir = await page.getByTestId('business-phone').locator('.ltr').evaluate((el) => getComputedStyle(el).direction);
      expect(dir).toBe('ltr');
    } finally {
      await resetBusiness();
    }
  });

  test('an invalid phone in settings renders the placeholder, not a broken link', async ({ page }) => {
    await setSettings({ business_phone: '12345', business_whatsapp: 'abc' });
    try {
      await page.goto('/business');
      await expect(page.getByTestId('site-footer').getByTestId('contact-call-placeholder')).toBeVisible();
      await expect(page.locator('a[href^="tel:"], a[href*="wa.me"]')).toHaveCount(0);
    } finally {
      await resetBusiness();
    }
  });

  test('/business shows the cancellation exemption notice in full, with its version', async ({ page }) => {
    await page.goto('/business');
    const notice = page.getByTestId('cancellation-exemption-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('לא ניתן לבטל לאחר אישור ההזמנה לפי חוק הגנת הצרכן');
    await expect(notice).toContainText('פגום');
    await expect(notice).toContainText('cancellation-2026-10-v1');
  });
});

test.describe('DB: public business settings read path', () => {
  test('anon gets the whitelist from fn_public_site_settings, nothing else', async () => {
    const client = anon();
    const { data, error } = await client.rpc('fn_public_site_settings');
    expect(error).toBeNull();
    expect(Object.keys(data).sort()).toEqual(
      [...BUSINESS_KEYS, 'vat_status', 'active_privacy_notice_version', 'active_terms_version', 'active_cancellation_notice_version', 'guest_pii_months', 'photo_retention_days', 'inactive_profile_months'].sort(),
    );
    for (const k of BUSINESS_KEYS) expect(data[k]).toBeNull();
  });

  test('anon cannot read business_* rows directly, nor call the internal helper', async () => {
    const client = anon();
    const { data: rows, error } = await client.from('app_settings').select('key').like('key', 'business%');
    expect(error).toBeNull();
    expect(rows).toEqual([]);
    const { data: vat } = await client.from('app_settings').select('key').eq('key', 'vat_status');
    expect(vat).toEqual([{ key: 'vat_status' }]); // other keys keep their visibility
    const { error: helperError } = await client.rpc('fn_setting_text', { p_key: 'vat_status' });
    expect(helperError?.message).toContain('permission denied');
  });

  test('admin at aal2 still reads business_* rows', async () => {
    const { client } = await createAdmin({ withMfa: true });
    const { data, error } = await client.from('app_settings').select('key').like('key', 'business%');
    expect(error).toBeNull();
    expect(data?.length).toBe(BUSINESS_KEYS.length);
  });

  test('the versions the pages render equal app_settings.active_*_version', async () => {
    const src = readFileSync(join(__dirname, '..', 'lib', 'shared', 'compliance', 'versions.ts'), 'utf8');
    const code = Object.fromEntries([...src.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]));
    const { data } = await anon().rpc('fn_public_site_settings');
    expect(data.active_privacy_notice_version).toBe(code.privacy);
    expect(data.active_terms_version).toBe(code.terms);
    expect(data.active_cancellation_notice_version).toBe(code.cancellation);
  });
});
