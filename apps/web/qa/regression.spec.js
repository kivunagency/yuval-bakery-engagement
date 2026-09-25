// @ts-check
// Regression suite (Rule 7). Runs against a local production build and the
// local stack. Every task that adds a route or a behaviour adds its checks
// here in the same PR. Screenshots land in test-results/screens/ for the
// "Hebrew is verified rendered" rule.
const { test, expect } = require('@playwright/test');
const { join } = require('node:path');
const { createAdmin } = require('./helpers/admin');

const SCREENS = join(__dirname, '..', 'test-results', 'screens');

const PUBLIC_ROUTES = ['/'];

test.describe('public baseline', () => {
  for (const route of PUBLIC_ROUTES) {
    test(`${route}: RTL Hebrew, CSP without unsafe-inline, no console errors`, async ({ page }) => {
      const errors = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(e.message));

      const res = await page.goto(route);
      expect(res?.status()).toBe(200);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.locator('html')).toHaveAttribute('lang', 'he');

      const csp = res?.headers()['content-security-policy'] ?? '';
      const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
      expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
      expect(scriptSrc).not.toContain('unsafe-inline');
      expect(scriptSrc).not.toContain('unsafe-eval');
      expect(res?.headers()['x-frame-options']).toBe('DENY');

      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.fonts.check('700 32px Karantina'))).toBe(true);
      expect(await page.evaluate(() => document.fonts.check('400 16px "IBM Plex Sans Hebrew"'))).toBe(true);

      // 0 horizontal scroll at 390px
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      // every interactive element that is visible is at least 44x44
      const small = await page.evaluate(() =>
        [...document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="radio"]')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            const visible = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
            const onScreen = r.bottom > 0 && r.top < window.innerHeight * 10;
            return visible && onScreen && (r.width < 44 || r.height < 44);
          })
          .map((el) => el.outerHTML.slice(0, 80)),
      );
      expect(small).toEqual([]);

      await page.screenshot({ path: join(SCREENS, `${route === '/' ? 'home' : route.slice(1).replace(/\//g, '_')}.png`), fullPage: true });
      expect(errors).toEqual([]);
    });
  }

  test('home shows the business name placeholder in Hebrew', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('business-name')).toHaveText('[שם העסק]');
  });

  test('skip link is the first tab stop and moves focus to main', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skip = page.locator('.skip-link');
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
  });

  test('unknown route: 404 page in Hebrew', async ({ page }) => {
    const res = await page.goto('/no-such-page');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('הדף לא נמצא');
  });

  test('/api/health reports the DB up', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'up' });
  });
});

test.describe('auth chain: Supabase Auth -> aal2 JWT -> DB admin check', () => {
  test('admin with verified TOTP is aal2 admin and can set capacity', async () => {
    const { client } = await createAdmin({ withMfa: true });
    const { data: aal } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aal?.currentLevel).toBe('aal2');
    const { data: isAdmin, error } = await client.rpc('is_admin_aal2');
    expect(error).toBeNull();
    expect(isAdmin).toBe(true);
    const day = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
    const { data: row, error: setError } = await client.rpc('fn_admin_set_day_capacity', {
      p_day: day, p_oven_minutes_total: 200, p_work_minutes_total: 300, p_is_blackout: false,
    });
    expect(setError).toBeNull();
    expect(row.day).toBe(day);
  });

  test('admin without MFA (aal1) is refused by the DB', async () => {
    const { client } = await createAdmin({ withMfa: false });
    const { data: isAdmin } = await client.rpc('is_admin_aal2');
    expect(isAdmin).toBe(false);
    const { error } = await client.rpc('fn_admin_set_day_capacity', {
      p_day: '2027-01-05', p_oven_minutes_total: 1, p_work_minutes_total: 1, p_is_blackout: false,
    });
    expect(error?.message).toBe('admin_aal2_required');
  });
});
