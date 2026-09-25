// @ts-check
// Admin domain regression (db-005 admin access, api-009, client-007).
// Real chain: Next.js server actions -> Supabase Auth (password, TOTP) ->
// aal2 JWT -> DB functions. Screenshots land in test-results/screens/.
const { test, expect } = require('@playwright/test');
const { join } = require('node:path');
const { createUser, db, randomIp, uiLogin, totp } = require('./helpers/admin-ui');

const SCREENS = join(__dirname, '..', 'test-results', 'screens');

/** Baseline checks every admin screen shares with qa/regression.spec.js. */
async function baseline(page, name, errors) {
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

function collectErrors(page) {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test.describe('admin login (db-005)', () => {
  test('/admin/login: RTL, CSP nonce, noindex, 44px, no scroll, no console errors', async ({ page }) => {
    const errors = collectErrors(page);
    const res = await page.goto('/admin/login');
    expect(res?.status()).toBe(200);
    const csp = res?.headers()['content-security-policy'] ?? '';
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(scriptSrc).not.toContain('unsafe-inline');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('כניסה לניהול');
    await baseline(page, 'login', errors);
  });

  test('every admin screen and admin API refuses an anonymous visitor', async ({ page, request }) => {
    for (const path of ['/admin', '/admin/orders', '/admin/custom-cakes', '/admin/capacity', '/admin/catalog', '/admin/settings', '/admin/login/enroll', '/admin/login/verify']) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/admin\/login$/);
    }
    const res = await request.patch('/api/admin/capacity/2027-01-05', { data: { ovenMinutesTotal: 1, workMinutesTotal: 1, isBlackout: false } });
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('same error for wrong password, unknown email, and a non-admin with the right password', async ({ page }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    const customer = await createUser({ admin: false });
    await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
    const tries = [
      { email: admin.email, password: 'wrong-password-123' },
      { email: `nobody-${Date.now()}@example.test`, password: 'whatever-123' },
      { email: customer.email, password: customer.password },
    ];
    for (const t of tries) {
      await page.goto('/admin/login');
      await page.getByLabel('אימייל').fill(t.email);
      await page.getByLabel('סיסמה').fill(t.password);
      await page.getByRole('button', { name: 'כניסה', exact: true }).click();
      await expect(page.getByTestId('login-error')).toHaveText('האימייל או הסיסמה שגויים.');
      await expect(page).toHaveURL(/\/admin\/login$/);
    }
    // The customer's valid password did not leave a session behind.
    await page.goto('/admin/login/verify');
    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test('rate limit: after 5 failures from one IP, even the right password is refused for now', async ({ page }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
    for (let i = 0; i < 5; i++) {
      await page.goto('/admin/login');
      await page.getByLabel('אימייל').fill(admin.email);
      await page.getByLabel('סיסמה').fill(`wrong-${i}`);
      await page.getByRole('button', { name: 'כניסה', exact: true }).click();
      await expect(page.getByTestId('login-error')).toHaveText('האימייל או הסיסמה שגויים.');
    }
    await page.goto('/admin/login');
    await page.getByLabel('אימייל').fill(admin.email);
    await page.getByLabel('סיסמה').fill(admin.password);
    await page.getByRole('button', { name: 'כניסה', exact: true }).click();
    await expect(page.getByTestId('login-error')).toHaveText('יותר מדי ניסיונות. אפשר לנסות שוב בעוד 15 דקות.');
    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test('first login: enrol TOTP (QR + key), reach the shell, tabs, sign out', async ({ page }) => {
    const errors = collectErrors(page);
    const admin = await createUser({ admin: true, withTotp: false });
    await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
    await page.goto('/admin/login');
    await page.getByLabel('אימייל').fill(admin.email);
    await page.getByLabel('סיסמה').fill(admin.password);
    await page.getByRole('button', { name: 'כניסה', exact: true }).click();
    await page.waitForURL('**/admin/login/enroll');

    // aal1 is not enough for the shell: straight back into the login flow.
    await page.goto('/admin/capacity');
    await page.waitForURL('**/admin/login/enroll');

    const qr = page.getByRole('img', { name: 'קוד QR להוספת החשבון לאפליקציית האימות' });
    await expect(qr).toBeVisible();
    expect(await qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    const secret = (await page.getByTestId('totp-secret').innerText()).replace(/\s/g, '');
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    // The key wraps by groups inside its box, never past the card edge.
    expect(await page.getByTestId('totp-secret').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await baseline(page, 'login-enroll', errors);

    await page.getByLabel('קוד בן 6 ספרות').fill('000000' === totp(secret) ? '111111' : '000000');
    await page.getByRole('button', { name: 'סיום ההגדרה' }).click();
    await expect(page.getByTestId('totp-error')).toHaveText('הקוד שגוי או שפג תוקפו. מקלידים את הקוד שמופיע עכשיו באפליקציה.');

    await page.getByLabel('קוד בן 6 ספרות').fill(totp(secret));
    await page.getByRole('button', { name: 'סיום ההגדרה' }).click();
    await page.waitForURL('**/admin/orders');

    const nav = page.getByRole('navigation', { name: 'ניווט ניהול' });
    await expect(nav.getByRole('link')).toHaveText(['הזמנות', 'יומן', 'מוצרים', 'הגדרות']);
    await expect(nav.getByRole('link', { name: 'הזמנות' })).toHaveAttribute('aria-current', 'page');
    const tabBox = await nav.getByRole('link', { name: 'הזמנות' }).boundingBox();
    expect(Math.round(tabBox?.height ?? 0)).toBe(56);
    const bar = await nav.getByRole('link', { name: 'הזמנות' }).evaluate((el) => {
      const s = getComputedStyle(el, '::before');
      return { h: s.height, bg: s.backgroundColor };
    });
    expect(bar.h).toBe('3px');
    expect(bar.bg).toBe('rgb(163, 18, 63)'); // --accent
    await expect(page.getByTestId('coming-soon')).toContainText('בקרוב');
    await baseline(page, 'shell-orders', errors);

    for (const [name, path] of [['מוצרים', '/admin/catalog'], ['הגדרות', '/admin/settings'], ['יומן', '/admin/capacity']]) {
      await nav.getByRole('link', { name }).click();
      await page.waitForURL(`**${path}`);
      await expect(nav.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    }
    await page.goto('/admin/custom-cakes');
    await expect(nav.getByRole('link', { name: 'הזמנות' })).toHaveAttribute('aria-current', 'page');

    // Audit trail and the enrolment stamp (SEC-017).
    const actions = (await db('SELECT action FROM audit_log WHERE actor_id = $1 ORDER BY id', [admin.userId])).map((r) => r.action);
    expect(actions).toEqual(['admin.login_password_ok', 'admin.mfa_enrolled']);
    const [row] = await db('SELECT mfa_enrolled_at FROM admins WHERE id = $1', [admin.userId]);
    expect(row.mfa_enrolled_at).not.toBeNull();

    await page.getByTestId('admin-sign-out').click();
    await page.waitForURL('**/admin/login');
    await page.goto('/admin/orders');
    await expect(page).toHaveURL(/\/admin\/login$/);
    expect((await db('SELECT action FROM audit_log WHERE actor_id = $1 ORDER BY id DESC LIMIT 1', [admin.userId]))[0].action).toBe('admin.signed_out');
  });

  test('later login: password then the code from the enrolled factor', async ({ page }) => {
    const errors = collectErrors(page);
    const admin = await createUser({ admin: true, withTotp: true });
    await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
    await page.goto('/admin/login');
    await page.getByLabel('אימייל').fill(admin.email);
    await page.getByLabel('סיסמה').fill(admin.password);
    await page.getByRole('button', { name: 'כניסה', exact: true }).click();
    await page.waitForURL('**/admin/login/verify');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('קוד מאפליקציית האימות');
    await baseline(page, 'login-verify', errors);
    await page.getByLabel('קוד בן 6 ספרות').fill(totp(admin.secret));
    await page.getByRole('button', { name: 'אישור' }).click();
    await page.waitForURL('**/admin/orders');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('הזמנות');
  });

  test('"sign in with another account" leaves a half-finished login', async ({ page }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
    await page.goto('/admin/login');
    await page.getByLabel('אימייל').fill(admin.email);
    await page.getByLabel('סיסמה').fill(admin.password);
    await page.getByRole('button', { name: 'כניסה', exact: true }).click();
    await page.waitForURL('**/admin/login/verify');
    await page.getByRole('button', { name: 'יציאה וכניסה עם חשבון אחר' }).click();
    await page.waitForURL('**/admin/login');
    await expect(page.getByLabel('אימייל')).toBeVisible();
  });

  test('uiLogin helper works end to end (used by the capacity tests)', async ({ page }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    await expect(page.getByRole('navigation', { name: 'ניווט ניהול' })).toBeVisible();
  });
});

test.describe('PATCH /api/admin/capacity/[date] (api-009)', () => {
  // A day far enough ahead that no other test or the seed uses it.
  const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

  test('admin at aal2: validates, writes through the DB, refuses totals below reserved with a clear 409', async ({ page, baseURL }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const api = page.request;
    const headers = { origin: baseURL ?? '' };
    const d = day(200 + Math.floor(Math.random() * 300));

    // CSRF: no Origin, or a foreign one, is refused even with a valid session.
    expect((await api.patch(`/api/admin/capacity/${d}`, { data: { ovenMinutesTotal: 10, workMinutesTotal: 10, isBlackout: false } })).status()).toBe(403);
    expect((await api.patch(`/api/admin/capacity/${d}`, { headers: { origin: 'https://evil.example' }, data: { ovenMinutesTotal: 10, workMinutesTotal: 10, isBlackout: false } })).status()).toBe(403);

    // Zod: bad date, negative, fractional, over 1440, unknown key, not JSON.
    for (const [path, data] of [
      [`/api/admin/capacity/2026-02-30`, { ovenMinutesTotal: 10, workMinutesTotal: 10, isBlackout: false }],
      [`/api/admin/capacity/${d}`, { ovenMinutesTotal: -5, workMinutesTotal: 10, isBlackout: false }],
      [`/api/admin/capacity/${d}`, { ovenMinutesTotal: 1.5, workMinutesTotal: 10, isBlackout: false }],
      [`/api/admin/capacity/${d}`, { ovenMinutesTotal: 1441, workMinutesTotal: 10, isBlackout: false }],
      [`/api/admin/capacity/${d}`, { ovenMinutesTotal: 10, workMinutesTotal: 10, isBlackout: false, ovenMinutesReserved: 0 }],
    ]) {
      const r = await api.patch(path, { headers, data });
      expect(r.status(), JSON.stringify(data)).toBe(400);
      expect(await r.json()).toEqual({ error: 'invalid_input' });
    }
    expect((await api.patch(`/api/admin/capacity/${d}`, { headers: { ...headers, 'content-type': 'application/json' }, data: 'not json' })).status()).toBe(400);

    const ok = await api.patch(`/api/admin/capacity/${d}`, { headers, data: { ovenMinutesTotal: 300, workMinutesTotal: 420, isBlackout: false } });
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toEqual({
      day: d, ovenMinutesTotal: 300, ovenMinutesReserved: 0, ovenMinutesUnpaidReserved: 0,
      workMinutesTotal: 420, workMinutesReserved: 0, workMinutesUnpaidReserved: 0, isBlackout: false, source: 'manual',
    });
    const [audit] = await db("SELECT actor_id, metadata FROM audit_log WHERE action = 'capacity.day_updated' AND entity_id = $1 ORDER BY id DESC LIMIT 1", [d]);
    expect(audit.actor_id).toBe(admin.userId);
    expect(audit.metadata.oven_minutes_total).toBe(300);

    // Orders already hold 120 oven / 90 work minutes of that day.
    await db('UPDATE capacity_day_ledger SET oven_minutes_reserved = 120, work_minutes_reserved = 90 WHERE day = $1', [d]);
    const below = await api.patch(`/api/admin/capacity/${d}`, { headers, data: { ovenMinutesTotal: 100, workMinutesTotal: 420, isBlackout: false } });
    expect(below.status()).toBe(409);
    expect(await below.json()).toEqual({ error: 'below_reserved', reserved: { ovenMinutes: 120, workMinutes: 90 } });
    const [row] = await db('SELECT oven_minutes_total FROM capacity_day_ledger WHERE day = $1', [d]);
    expect(row.oven_minutes_total).toBe(300); // unchanged

    // Blackout keeps the numbers and the existing orders; it only closes the day to new ones.
    const closed = await api.patch(`/api/admin/capacity/${d}`, { headers, data: { ovenMinutesTotal: 120, workMinutesTotal: 90, isBlackout: true } });
    expect(closed.status()).toBe(200);
    expect((await closed.json()).isBlackout).toBe(true);
  });

  test('admin session without TOTP (aal1) gets 401', async ({ page, baseURL }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
    await page.goto('/admin/login');
    await page.getByLabel('אימייל').fill(admin.email);
    await page.getByLabel('סיסמה').fill(admin.password);
    await page.getByRole('button', { name: 'כניסה', exact: true }).click();
    await page.waitForURL('**/admin/login/verify');
    const r = await page.request.patch(`/api/admin/capacity/${day(250)}`, { headers: { origin: baseURL ?? '' }, data: { ovenMinutesTotal: 1, workMinutesTotal: 1, isBlackout: false } });
    expect(r.status()).toBe(401);
  });
});
