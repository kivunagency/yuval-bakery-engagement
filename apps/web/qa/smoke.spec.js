// @ts-check
// Smoke against a LIVE deployment (Rule 5). Set SMOKE_BASE_URL to the real
// DEV or PROD url. Without it these tests are skipped, which means DID NOT
// RUN, never "passed": no "deployed" claim without this suite hitting the url.
const { test, expect } = require('@playwright/test');

const BASE = process.env.SMOKE_BASE_URL;

test.describe('live smoke', () => {
  test.skip(!BASE, 'SMOKE_BASE_URL not set: live smoke DID NOT RUN');

  test('home renders RTL Hebrew over HTTPS', async ({ page }) => {
    const res = await page.goto(BASE + '/');
    expect(res?.status()).toBe(200);
    expect(page.url().startsWith('https://')).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  test('health endpoint reports the DB up', async ({ request }) => {
    const res = await request.get(BASE + '/api/health');
    expect(res.status()).toBe(200);
    expect((await res.json()).db).toBe('up');
  });
});
