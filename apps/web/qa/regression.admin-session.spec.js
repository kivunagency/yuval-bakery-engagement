// @ts-check
// Admin session hardening regression (security baseline gate 2026-09-30,
// blockers 1 and 2; SEC-013). Real chain: server action login -> Supabase Auth
// -> Set-Cookie. Local stack only (createUser uses the service role).
const { test, expect } = require('@playwright/test');
const { createUser, randomIp, totp } = require('./helpers/admin-ui');
const { localEnv } = require('./helpers/env');

const ACTIVITY = 'yb-admin-activity';
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Logs in through the UI and returns every Set-Cookie header seen on the way. */
async function loginCapturingCookies(page, user) {
  /** @type {string[]} */
  const setCookies = [];
  page.on('response', async (res) => {
    for (const h of await res.headersArray()) if (h.name.toLowerCase() === 'set-cookie') setCookies.push(h.value);
  });
  await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
  await page.goto('/admin/login');
  await page.getByLabel('אימייל').fill(user.email);
  await page.getByLabel('סיסמה').fill(user.password);
  await page.getByRole('button', { name: 'כניסה', exact: true }).click();
  await page.waitForURL('**/admin/login/verify');
  await page.getByLabel('קוד בן 6 ספרות').fill(totp(user.secret));
  await page.getByRole('button', { name: 'אישור' }).click();
  await page.waitForURL('**/admin/orders');
  return setCookies;
}

/** @param {import('@playwright/test').BrowserContext} context */
async function activityCookie(context) {
  return (await context.cookies()).find((c) => c.name === ACTIVITY);
}

/** @param {import('@playwright/test').BrowserContext} context @param {number} secondsAgo */
async function setActivity(context, secondsAgo) {
  await context.addCookies([
    { name: ACTIVITY, value: String(nowSeconds() - secondsAgo), domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  ]);
}

test.describe('auth cookies (B1, B2, G5)', () => {
  test('every auth Set-Cookie after admin login is HttpOnly, Lax, at most 12h, and Secure outside the local stack', async ({ page }) => {
    const user = await createUser({ admin: true, withTotp: true });
    const setCookies = await loginCapturingCookies(page, user);
    const auth = setCookies.filter((c) => /^sb-[^=]*-auth-token/.test(c) && !/Max-Age=0\b/i.test(c));
    expect(auth.length).toBeGreaterThan(0);
    const secureExpected = (process.env.APP_ENV ?? localEnv().APP_ENV) !== 'local';
    for (const c of auth) {
      expect(c, c.slice(0, 40)).toMatch(/;\s*HttpOnly/i);
      expect(c).toMatch(/;\s*SameSite=Lax/i);
      const maxAge = Number(/Max-Age=(\d+)/i.exec(c)?.[1]);
      expect(maxAge).toBeGreaterThan(0);
      expect(maxAge).toBeLessThanOrEqual(43200);
      expect(/;\s*Secure/i.test(c)).toBe(secureExpected);
    }
    // The browser agrees, and no script can read the session.
    const jar = (await page.context().cookies()).filter((c) => c.name.startsWith('sb-'));
    expect(jar.length).toBeGreaterThan(0);
    for (const c of jar) expect(c.httpOnly, c.name).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toMatch(/sb-/);
    const act = await activityCookie(page.context());
    expect(act?.httpOnly).toBe(true);
  });
});

test.describe('admin idle timeout (A1, SEC-013)', () => {
  test('an admin idle for more than 30 minutes is sent to /admin/login with the notice, and is signed out', async ({ page }) => {
    const user = await createUser({ admin: true, withTotp: true });
    await loginCapturingCookies(page, user);
    await setActivity(page.context(), 31 * 60);

    await page.goto('/admin/orders');
    await expect(page).toHaveURL(/\/admin\/login\?reason=idle$/);
    await expect(page.getByTestId('idle-notice')).toHaveText('הכניסה הסתיימה אחרי 30 דקות ללא פעילות. יש להיכנס שוב.');
    // Signed out for real: the session is gone, not just hidden.
    expect((await page.context().cookies()).filter((c) => c.name.startsWith('sb-') && c.value !== '')).toEqual([]);
    await page.goto('/admin/orders');
    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test('the admin API answers 401 to an idle session', async ({ page }) => {
    const user = await createUser({ admin: true, withTotp: true });
    await loginCapturingCookies(page, user);
    await setActivity(page.context(), 45 * 60);
    const res = await page.request.get('/api/admin/delivery-zones');
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('an admin active 29 minutes ago stays in, and the clock restarts', async ({ page }) => {
    const user = await createUser({ admin: true, withTotp: true });
    await loginCapturingCookies(page, user);
    await setActivity(page.context(), 29 * 60);
    await page.goto('/admin/orders');
    await expect(page).toHaveURL(/\/admin\/orders$/);
    const act = await activityCookie(page.context());
    expect(nowSeconds() - Number(act?.value)).toBeLessThan(60);
  });

  test('a public customer page is unaffected by a stale activity cookie', async ({ page }) => {
    await setActivity(page.context(), 5 * 3600);
    const res = await page.goto('/');
    expect(res?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe('/');
    const act = await activityCookie(page.context());
    expect(nowSeconds() - Number(act?.value)).toBeGreaterThan(4 * 3600);
  });
});
