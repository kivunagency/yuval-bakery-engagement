// The public-page baseline from qa/regression.spec.js, as a function so domain
// files (regression.<domain>.spec.js) run the same checks on their routes:
// 200, RTL Hebrew, CSP nonce without unsafe-inline/eval, fonts, no horizontal
// scroll at 390px, every visible interactive element >= 44x44, no console
// errors, and a full-page screenshot in test-results/screens/.
const { expect } = require('@playwright/test');
const { join } = require('node:path');

const SCREENS = join(__dirname, '..', '..', 'test-results', 'screens');

async function checkPublicBaseline(page, route, screenshotName) {
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
  expect(await page.evaluate(() => document.fonts.check('400 16px "IBM Plex Sans Hebrew"'))).toBe(true);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const small = await page.evaluate(() =>
    [...document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="radio"]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const visible = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        return visible && (r.width < 44 || r.height < 44);
      })
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(small).toEqual([]);

  await page.screenshot({ path: join(SCREENS, `${screenshotName}.png`), fullPage: true });
  expect(errors).toEqual([]);
  return res;
}

module.exports = { checkPublicBaseline, SCREENS };
