// @ts-check
// Smoke against a LIVE deployment (Rule 5). Set SMOKE_BASE_URL to the real
// DEV or PROD url. Without it these tests are skipped, which means DID NOT
// RUN, never "passed": no "deployed" claim without this suite hitting the url.
const { test, expect } = require('@playwright/test');
const { loadQaUser } = require('./helpers/qa-user');
const { totp } = require('./helpers/admin');

const BASE = process.env.SMOKE_BASE_URL;

test.describe('live smoke', () => {
  test.skip(!BASE, 'SMOKE_BASE_URL not set: live smoke DID NOT RUN');

  test('home renders RTL Hebrew over HTTPS', async ({ page }) => {
    const res = await page.goto(BASE + '/');
    expect(res?.status()).toBe(200);
    expect(page.url().startsWith('https://')).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  // qa-005: the managed QA user of THIS environment (apps/web/.qa.env, gitignored)
  // signs in with password and TOTP. No file, or a file for another url: DID NOT RUN.
  test('managed QA user signs in to the admin (password + TOTP)', async ({ page }) => {
    const qa = loadQaUser();
    test.skip(!qa.ok, `QA user DID NOT RUN: ${qa.ok ? '' : qa.reason}`);
    if (!qa.ok) return;
    test.skip(qa.user.baseUrl !== BASE?.replace(/\/+$/, ''), `QA user DID NOT RUN: .qa.env is for ${qa.user.baseUrl}, not ${BASE}`);
    await page.goto(BASE + '/admin/login');
    await page.getByLabel('אימייל').fill(qa.user.email);
    await page.getByLabel('סיסמה').fill(qa.user.password);
    await page.getByRole('button', { name: 'כניסה', exact: true }).click();
    await page.waitForURL('**/admin/login/verify');
    await page.getByLabel('קוד בן 6 ספרות').fill(totp(qa.user.secret));
    await page.getByRole('button', { name: 'אישור' }).click();
    await page.waitForURL('**/admin/orders');
  });

  test('health endpoint reports the DB up', async ({ request }) => {
    const res = await request.get(BASE + '/api/health');
    expect(res.status()).toBe(200);
    expect((await res.json()).db).toBe('up');
  });
});
