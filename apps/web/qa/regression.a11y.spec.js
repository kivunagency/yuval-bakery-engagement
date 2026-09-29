// @ts-check
// qa-006 accessibility pass (IS 5568 / WCAG 2.1 AA; accessibility statement).
//   1. axe-core (wcag2a, wcag2aa, wcag21a, wcag21aa) on every public and admin
//      screen, light and dark. Automation covers roughly a third of WCAG; the
//      rest is below, and screen-reader listening is DID NOT RUN (no screen
//      reader in a headless browser), see SYSTEM-CONTRACT.md.
//   2. Keyboard only: catalog -> checkout -> order page, custom cake, admin login.
//      Every stop on the way must show a visible focus indicator.
//   3. 200% zoom (a 1280px desktop at 200% lays out at 640 CSS px) and the
//      400% reflow width (320 CSS px): no horizontal scroll.
//   4. prefers-reduced-motion: no animation or transition longer than 0.01s.
// Days 2..3 of the 14-day strip are reshaped for the keyboard checkout and
// restored (checkout uses 4..7, catalog 9..12).
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const crypto = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const db = require('./helpers/db');
const { createUser, uiLogin, randomIp, totp } = require('./helpers/admin-ui');
const { createConfirmedCustomer } = require('./helpers/customer');

const OUT = join(__dirname, '..', 'test-results', 'a11y');
mkdirSync(OUT, { recursive: true });
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const CART_KEY = 'yb.cart.v1';

/** axe on the current page; writes the full result, returns one line per violation. */
async function axe(page, name) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(result.violations, null, 2));
  return result.violations.map(
    (v) => `${name}: ${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`,
  );
}

/** Does the focused element show a focus indicator (outline, ring or border change)? */
async function focusShown(page) {
  return page.evaluate(() => {
    const el = /** @type {HTMLElement} */ (document.activeElement);
    if (!el || el === document.body) return { ok: true, what: 'body' };
    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2;
    const ring = s.boxShadow && s.boxShadow !== 'none';
    return { ok: outline || !!ring, what: el.outerHTML.slice(0, 90) };
  });
}

/**
 * Tab (or Shift+Tab) until `match(activeElement)` is true, checking the focus
 * indicator at every stop. Throws if it is not reached in `max` presses.
 */
async function tabTo(page, match, { back = false, max = 80, noFocus = [], arg } = {}) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    const f = await focusShown(page);
    if (!f.ok) noFocus.push(f.what);
    if (await page.evaluate(match, arg)) return;
  }
  throw new Error(`keyboard: target not reached in ${max} presses (${match})`);
}

async function withStripDays(fn) {
  const setup = await db.withClient(async (c) => {
    const today = (await c.query(`SELECT fn_business_date(now())::text AS d`)).rows[0].d;
    const days = [2, 3].map((n) => {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    });
    const saved = (await c.query('SELECT * FROM capacity_day_ledger WHERE day = ANY($1::date[])', [days])).rows;
    await c.query('DELETE FROM capacity_day_ledger WHERE day = ANY($1::date[])', [days]);
    for (const d of days) await c.query(`INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total) VALUES ($1, 300, 300)`, [d]);
    const name = `qa a11y ${crypto.randomUUID().slice(0, 8)}`;
    const p = (await c.query(
      `INSERT INTO products (name, price_displayed, cost_basis, oven_minutes_cost, work_minutes_cost, allergens, allergens_confirmed, photo_alt, is_available, is_published)
       VALUES ($1, 16, 'per_unit', 5, 5, ARRAY['gluten'], true, 'qa a11y product', true, true) RETURNING id, name`, [name])).rows[0];
    return { days, saved, p };
  });
  try {
    return await fn(setup);
  } finally {
    await db.withClient(async (c) => {
      await c.query(`DELETE FROM orders WHERE delivery_date = ANY($1::date[]) AND guest_name LIKE 'QA %'`, [setup.days]);
      await c.query('DELETE FROM capacity_day_ledger WHERE day = ANY($1::date[])', [setup.days]);
      for (const r of setup.saved) {
        await c.query(
          `INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total, oven_minutes_reserved, work_minutes_reserved,
             oven_minutes_unpaid_reserved, work_minutes_unpaid_reserved, is_blackout, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [r.day, r.oven_minutes_total, r.work_minutes_total, r.oven_minutes_reserved, r.work_minutes_reserved,
            r.oven_minutes_unpaid_reserved, r.work_minutes_unpaid_reserved, r.is_blackout, r.source],
        );
      }
      await c.query('UPDATE products SET is_published = false WHERE id = $1', [setup.p.id]);
    });
  }
}

/** An order of its own through the API, for /order/<token>. */
async function orderToken(request) {
  const made = await db.withClient(async (c) => {
    const day = await db.freshDay(c, { oven: 100, work: 100 });
    const p = await db.freshProduct(c, { oven: 5, work: 5, price: 12 });
    const slot = (await c.query(`SELECT id::text FROM time_slots WHERE is_active ORDER BY start_time DESC LIMIT 1`)).rows[0].id;
    return { day, p, slot };
  });
  const res = await request.post('/api/orders', {
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3100', 'x-nf-client-connection-ip': randomIp() },
    data: { items: [{ productId: made.p, quantity: 1 }], day: made.day, slotId: made.slot, fulfillment: 'pickup', name: 'QA A11y', phone: `050${crypto.randomInt(1000000, 9999999)}` },
  });
  expect(res.status()).toBe(201);
  await db.withClient((c) => c.query('UPDATE products SET is_published = false WHERE id = $1', [made.p]));
  return (await res.json()).token;
}

const PUBLIC_STATIC = [
  ['/', 'home'],
  ['/business', 'business'],
  ['/privacy', 'privacy'],
  ['/terms', 'terms'],
  ['/returns', 'returns'],
  ['/accessibility', 'accessibility'],
  ['/custom-cake', 'custom-cake'],
  ['/custom-cake/sent', 'custom-cake-sent'],
  ['/register', 'register'],
  ['/account/login', 'account-login'],
  ['/unsubscribe/done?result=done', 'unsubscribe-done'],
  ['/checkout', 'checkout-empty'],
  ['/no-such-page', 'not-found'],
];
const ADMIN = [
  ['/admin/orders', 'admin-orders'],
  ['/admin/capacity', 'admin-capacity'],
  ['/admin/catalog', 'admin-catalog'],
  ['/admin/custom-cakes', 'admin-custom-cakes'],
  ['/admin/delivery', 'admin-delivery'],
  ['/admin/settings', 'admin-settings'],
];

test.describe('qa-006 axe (WCAG 2.1 A + AA rules)', () => {
  for (const scheme of /** @type {const} */ (['light', 'dark'])) {
    test(`public screens, ${scheme}`, async ({ page, request }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const found = [];
      for (const [route, name] of PUBLIC_STATIC) {
        await page.goto(route);
        found.push(...(await axe(page, `${name}-${scheme}`)));
      }
      await page.goto(`/order/${await orderToken(request)}`);
      found.push(...(await axe(page, `order-${scheme}`)));
      await withStripDays(async ({ days, p }) => {
        await page.addInitScript(([key, value]) => window.sessionStorage.setItem(key, value), [CART_KEY, JSON.stringify({ day: days[0], lines: [{ productId: p.id, quantity: 1 }] })]);
        await page.goto('/checkout');
        found.push(...(await axe(page, `checkout-${scheme}`)));
        await page.getByTestId('checkout-submit').click(); // every field error shown
        found.push(...(await axe(page, `checkout-errors-${scheme}`)));
      });
      await page.goto('/custom-cake');
      await page.getByRole('button', { name: 'שליחת הבקשה' }).click();
      found.push(...(await axe(page, `custom-cake-errors-${scheme}`)));
      expect(found).toEqual([]);
    });

    test(`signed-in customer screens, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const c = await createConfirmedCustomer();
      await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
      await page.goto('/account/login');
      await page.locator('input[type=email]').fill(c.email);
      await page.locator('input[type=password]').fill(c.password);
      await page.locator('form button[type=submit]').click();
      await page.waitForURL(/\/account(\?|$)/);
      const found = [...(await axe(page, `account-${scheme}`))];
      await page.goto('/account/welcome');
      found.push(...(await axe(page, `account-welcome-${scheme}`)));
      expect(found).toEqual([]);
    });

    test(`admin login and admin screens, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const found = [];
      await page.goto('/admin/login');
      found.push(...(await axe(page, `admin-login-${scheme}`)));
      const fresh = await createUser({ withTotp: false });
      await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
      await page.getByLabel('אימייל').fill(fresh.email);
      await page.getByLabel('סיסמה').fill(fresh.password);
      await page.getByRole('button', { name: 'כניסה', exact: true }).click();
      await page.waitForURL('**/admin/login/enroll');
      found.push(...(await axe(page, `admin-enroll-${scheme}`)));
      await page.context().clearCookies();

      const user = await createUser({ withTotp: true });
      await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
      await page.goto('/admin/login');
      await page.getByLabel('אימייל').fill(user.email);
      await page.getByLabel('סיסמה').fill(user.password);
      await page.getByRole('button', { name: 'כניסה', exact: true }).click();
      await page.waitForURL('**/admin/login/verify');
      found.push(...(await axe(page, `admin-verify-${scheme}`)));
      await page.getByLabel('קוד בן 6 ספרות').fill(totp(user.secret));
      await page.getByRole('button', { name: 'אישור' }).click();
      await page.waitForURL('**/admin/orders');
      for (const [route, name] of ADMIN) {
        await page.goto(route);
        found.push(...(await axe(page, `${name}-${scheme}`)));
      }
      expect(found).toEqual([]);
    });
  }
});

test.describe('qa-006 keyboard only, focus always visible', () => {
  test('catalog: skip link, pick a day, add a product, open the cart, place a pickup order, land on the order page', async ({ page }) => {
    await withStripDays(async ({ p }) => {
      await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
      const noFocus = [];
      await page.goto('/');
      await page.keyboard.press('Tab');
      await expect(page.locator('.skip-link')).toBeFocused();
      await page.keyboard.press('Enter');

      await tabTo(page, () => document.activeElement?.getAttribute('role') === 'radio', { noFocus });
      await page.keyboard.press('Space');
      await expect(page.locator('[role=radio][aria-checked=true]')).toHaveCount(1);

      const name = p.name;
      await tabTo(page, (productName) => {
        const el = document.activeElement;
        const h = el && el.getAttribute('aria-describedby');
        return el?.tagName === 'BUTTON' && !!h && !!document.getElementById(h)?.textContent?.includes(productName);
      }, { noFocus, max: 200, arg: name });
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('cart-button')).toContainText('1');

      await tabTo(page, () => document.activeElement?.getAttribute('data-testid') === 'cart-button', { back: true, noFocus, max: 200 });
      await page.keyboard.press('Enter');
      await page.waitForURL('**/checkout');

      await tabTo(page, () => /איסוף עצמי/.test(document.activeElement?.textContent ?? ''), { noFocus });
      await page.keyboard.press('Enter');
      await tabTo(page, () => !!document.activeElement?.closest('[data-testid="slots"]') && !(/** @type {HTMLButtonElement} */ (document.activeElement)).disabled, { noFocus });
      await page.keyboard.press('Enter');
      await tabTo(page, () => document.activeElement?.id === 'name', { noFocus });
      await page.keyboard.type('QA Keyboard');
      await tabTo(page, () => document.activeElement?.id === 'phone', { noFocus });
      await page.keyboard.type(`050${crypto.randomInt(1000000, 9999999)}`);
      await tabTo(page, () => document.activeElement?.getAttribute('data-testid') === 'checkout-submit', { noFocus });
      await page.keyboard.press('Enter');
      await page.waitForURL('**/order/**');
      await tabTo(page, () => document.activeElement?.tagName === 'A', { noFocus });
      expect(noFocus).toEqual([]);
    });
  });

  test('custom cake: the whole form by keyboard, errors reachable, request sent', async ({ page }) => {
    const noFocus = [];
    await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
    const date = await db.withClient(async (c) => (await c.query(`SELECT (fn_earliest_delivery_date(now()) + 40)::text AS d`)).rows[0].d);
    await page.goto('/custom-cake');
    // submit empty: focus goes to the first field in error (or the error summary)
    await tabTo(page, () => document.activeElement?.getAttribute('type') === 'submit', { noFocus });
    await page.keyboard.press('Enter');
    await expect(page.locator('[aria-invalid=true]').first()).toBeVisible();

    // A native date field takes its segment order from the browser build's locale
    // (headless Chromium: mm/dd/yyyy; a Hebrew phone: dd/mm/yyyy). Find it on a
    // scratch visit, still typing with the keyboard only.
    const [y, m, d] = date.split('-');
    await page.goto('/custom-cake');
    await tabTo(page, () => document.activeElement?.getAttribute('name') === 'desiredDate');
    await page.keyboard.type(`${m}${d}${y}`);
    const dateOrder = (await page.locator('input[name=desiredDate]').inputValue()) === date ? 'mdy' : 'dmy';

    await page.goto('/custom-cake');
    await tabTo(page, () => document.activeElement?.getAttribute('name') === 'name', { noFocus });
    await page.keyboard.type('QA Keyboard Cake');
    await tabTo(page, () => document.activeElement?.getAttribute('name') === 'phone', { noFocus });
    await page.keyboard.type(`050${crypto.randomInt(1000000, 9999999)}`);
    await tabTo(page, () => document.activeElement?.getAttribute('name') === 'desiredDate', { noFocus });
    await page.keyboard.type(dateOrder === 'mdy' ? `${m}${d}${y}` : `${d}${m}${y}`);
    await expect(page.locator('input[name=desiredDate]')).toHaveValue(date);
    await tabTo(page, () => document.activeElement?.getAttribute('type') === 'checkbox' && document.activeElement?.hasAttribute('required'), { noFocus });
    await page.keyboard.press('Space');
    await tabTo(page, () => document.activeElement?.getAttribute('type') === 'submit', { noFocus });
    await page.keyboard.press('Enter');
    await page.waitForURL('**/custom-cake/sent**');
    expect(noFocus).toEqual([]);
  });

  test('admin login: password, TOTP code and the admin tabs by keyboard', async ({ page }) => {
    const noFocus = [];
    const user = await createUser({ withTotp: true });
    await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
    await page.goto('/admin/login');
    await tabTo(page, () => document.activeElement?.getAttribute('type') === 'email', { noFocus });
    await page.keyboard.type(user.email);
    await tabTo(page, () => document.activeElement?.getAttribute('type') === 'password', { noFocus });
    await page.keyboard.type(user.password);
    await page.keyboard.press('Enter');
    await page.waitForURL('**/admin/login/verify');
    await tabTo(page, () => document.activeElement?.tagName === 'INPUT', { noFocus });
    await page.keyboard.type(totp(user.secret));
    await page.keyboard.press('Enter');
    await page.waitForURL('**/admin/orders');
    await tabTo(page, () => (document.activeElement?.getAttribute('href') ?? '').startsWith('/admin/capacity'), { noFocus, max: 150 });
    await page.keyboard.press('Enter');
    await page.waitForURL('**/admin/capacity**');
    expect(noFocus).toEqual([]);
  });
});

test.describe('qa-006 zoom and reflow', () => {
  const ROUTES = [...PUBLIC_STATIC.map(([r]) => r)];
  for (const width of [640, 320]) {
    test(`no horizontal scroll at ${width} CSS px (${width === 640 ? '200% zoom of 1280' : '400% reflow'}), public screens`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const wide = [];
      for (const route of ROUTES) {
        await page.goto(route);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (over > 0) wide.push(`${route}: ${over}px`);
      }
      expect(wide).toEqual([]);
    });
  }

  test('200% zoom of 1280, admin screens: no horizontal scroll', async ({ page }) => {
    const user = await createUser({ withTotp: true });
    await uiLogin(page, user);
    await page.setViewportSize({ width: 640, height: 800 });
    const wide = [];
    for (const [route] of ADMIN) {
      await page.goto(route);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 0) wide.push(`${route}: ${over}px`);
    }
    expect(wide).toEqual([]);
  });

  test('text spacing (WCAG 1.4.12) on the home page: nothing is clipped', async ({ page }) => {
    await page.goto('/');
    // CSP refuses an injected <style> (good); CSSOM writes are not inline styles, so set the spacing per element
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        const st = /** @type {HTMLElement} */ (el).style;
        st.setProperty('line-height', '1.5', 'important');
        st.setProperty('letter-spacing', '0.12em', 'important');
        st.setProperty('word-spacing', '0.16em', 'important');
        if (el.tagName === 'P') st.setProperty('margin-bottom', '2em', 'important');
      }
    });
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll('h1, h2, h3, p, a, button, label')]
        .filter((el) => !el.closest('.visually-hidden')) // clipped on purpose: read by screen readers only
        .filter((el) => { const s = getComputedStyle(el); return (s.overflow === 'hidden' || s.overflowX === 'hidden') && el.scrollWidth > el.clientWidth + 1; })
        .map((el) => el.outerHTML.slice(0, 80)));
    expect(clipped).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test.describe('qa-006 prefers-reduced-motion', () => {
  test('with reduce, no animation or transition runs longer than 0.01s on public screens', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const moving = [];
    for (const [route] of PUBLIC_STATIC) {
      await page.goto(route);
      moving.push(...(await page.evaluate((r) => {
        const secs = (v) => Math.max(...v.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) / 1000 : parseFloat(x))));
        return [...document.querySelectorAll('*')]
          .filter((el) => { const s = getComputedStyle(el); return secs(s.animationDuration) > 0.01 || secs(s.transitionDuration) > 0.01; })
          .map((el) => `${r}: ${el.tagName.toLowerCase()}.${el.className}`.slice(0, 100));
      }, route)));
    }
    expect(moving).toEqual([]);
  });
});
