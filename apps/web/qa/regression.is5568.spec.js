// @ts-check
// compliance-005: IS 5568 (WCAG 2.0 AA as adopted in Israel) and the Equal
// Rights for Persons with Disabilities (Service Accessibility) Regulations,
// checked on the local build. The agency's shared/scripts/check-public-site.mjs
// is not in this repo; this is the equivalent for what a headless browser can
// decide. Three outcomes, never merged:
//   PASS         measured and holds on every public page
//   FAIL         measured and does not hold (fails this test)
//   NEEDS-HUMAN  a person has to decide it (listed in the report, never a pass)
// The report is written to test-results/is5568-report.md; a snapshot of the
// last local run is committed as output/qa/is5568-report.md.
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const ALL_PAGES = ['/', '/business', '/privacy', '/terms', '/returns', '/accessibility', '/custom-cake', '/custom-cake/sent', '/register', '/account/login', '/unsubscribe/done?result=done', '/checkout'];
// Customer account pages answer 404 while CUSTOMER_ACCOUNTS_ENABLED is off
// (DEV/PROD until there is a sending domain): reported as DID NOT RUN, not checked.
const ACCOUNT_PAGES = new Set(['/register', '/account/login']);

const NEEDS_HUMAN = [
  ['Screen reader (NVDA on Windows, VoiceOver on iPhone): order a cake end to end by listening only', 'no screen reader in a headless browser; qa-006 lists it as DID NOT RUN'],
  ['Alt text says what the photo shows (1.1.1): the text exists on every product (checked), whether it is meaningful is not', 'product photos and their descriptions are Yuval\'s content, not uploaded yet'],
  ['Accessibility coordinator / contact person named in the statement, with a working email and phone (Regulation 35)', 'the statement shows the placeholder [אימייל העסק]; Yuval\'s details are open'],
  ['Whether the small-business exemption applies (turnover threshold)', 'legal question for Yuval and her accountant (compliance-spec 13 q4)'],
  ['Plain language and instructions a first-time customer understands (3.3.2)', 'judgment of a reader, ideally one of Yuval\'s customers'],
  ['Third-party steps: Bit, PayBox and WhatsApp are reachable and usable with assistive technology', 'outside this site; the statement names them as a known limit'],
  ['The order confirmation PDF is tagged and readable (when US-0c ships)', 'the PDF is not built yet (wave 3)'],
  ['Colour is never the only carrier of meaning (1.4.1) beyond the day states that the regression tests check by text', 'visual review of every state on every screen'],
  ['Real 200% browser zoom on a phone and desktop, and the iOS text-size setting', 'emulated here by viewport width only'],
];

test('IS 5568 public-site check (PASS / FAIL / NEEDS-HUMAN)', async ({ page }) => {
  test.setTimeout(180_000);
  const rows = [];
  const check = (id, what, failures) => rows.push({ id, what, result: failures.length ? 'FAIL' : 'PASS', detail: failures.slice(0, 6).join('; ') });

  const PAGES = [];
  const notRun = [];
  for (const route of ALL_PAGES) {
    if (ACCOUNT_PAGES.has(route) && (await page.request.get(route)).status() === 404) notRun.push(route);
    else PAGES.push(route);
  }

  const lang = [], titles = new Map(), h1 = [], skip = [], footer = [], alt = [], media = [], labels = [], contrast = [], targets = [], reflow = [], motion = [];
  for (const scheme of /** @type {const} */ (['light', 'dark'])) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const route of PAGES) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(route);
      const axe = await new AxeBuilder({ page }).withRules(['color-contrast', 'label', 'image-alt', 'button-name', 'link-name', 'select-name', 'aria-input-field-name']).analyze();
      for (const v of axe.violations) (v.id === 'color-contrast' ? contrast : labels).push(`${route} ${scheme}: ${v.id} x${v.nodes.length}`);
      if (scheme === 'dark') continue;

      const facts = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        title: document.title.trim(),
        h1: document.querySelectorAll('h1').length,
        footerStatement: !!document.querySelector('footer a[href="/accessibility"]'),
        imgNoAlt: [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).length,
        media: [...document.querySelectorAll('video, audio, iframe')].map((m) => `${m.tagName.toLowerCase()}${m.hasAttribute('autoplay') ? '[autoplay]' : ''}`),
        small: [...document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="radio"]')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && (r.width < 44 || r.height < 44);
        }).length,
      }));
      if (facts.lang !== 'he' || facts.dir !== 'rtl') lang.push(`${route}: lang=${facts.lang} dir=${facts.dir}`);
      if (!facts.title) titles.set(route, '(empty)'); else titles.set(route, facts.title);
      if (facts.h1 !== 1) h1.push(`${route}: ${facts.h1} h1`);
      if (!facts.footerStatement) footer.push(route);
      if (facts.imgNoAlt) alt.push(`${route}: ${facts.imgNoAlt}`);
      if (facts.media.length) media.push(`${route}: ${facts.media.join(',')}`);
      if (facts.small) targets.push(`${route}: ${facts.small}`);

      await page.keyboard.press('Tab');
      const first = await page.evaluate(() => ({ cls: document.activeElement?.className ?? '', href: document.activeElement?.getAttribute('href') ?? '' }));
      if (!String(first.cls).includes('skip-link') || first.href !== '#main') skip.push(`${route}: first stop ${first.cls || first.href || 'none'}`);

      await page.setViewportSize({ width: 320, height: 700 });
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 0) reflow.push(`${route}: ${over}px`);

      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const moving = await page.evaluate(() => {
        const secs = (v) => Math.max(...v.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) / 1000 : parseFloat(x))));
        return [...document.querySelectorAll('*')].filter((el) => { const s = getComputedStyle(el); return secs(s.animationDuration) > 0.01 || secs(s.transitionDuration) > 0.01; }).length;
      });
      if (moving) motion.push(`${route}: ${moving}`);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'no-preference' });
    }
  }
  const dupTitles = [...titles.entries()].filter(([, t], _i, all) => t === '(empty)' || all.filter(([, u]) => u === t).length > 1).map(([r, t]) => `${r}: ${t}`);

  // the statement itself (Regulation 35)
  await page.goto('/accessibility');
  const statement = await page.evaluate(() => document.querySelector('main')?.textContent ?? '');
  const stmt = [];
  if (!/5568/.test(statement)) stmt.push('does not name IS 5568');
  if (!/עדכון אחרון/.test(statement)) stmt.push('no last-updated date');
  if (!/מגבלות ידועות/.test(statement)) stmt.push('no known-limits section');
  if (!/פניות בנושא נגישות/.test(statement)) stmt.push('no contact section');

  check('3.1.1', 'Page language and direction: lang="he", dir="rtl"', lang);
  check('2.4.2', 'Every page has a title, and titles differ', dupTitles);
  check('1.3.1', 'Exactly one h1 per page', h1);
  check('2.4.1', 'Skip link is the first Tab stop and targets #main', skip);
  check('Reg. 35', 'Accessibility statement linked from the footer of every page', footer);
  check('Reg. 35', 'Statement names the standard, a date, known limits and a contact section', stmt);
  check('1.1.1', 'Every <img> has an alt attribute', alt);
  check('1.4.2', 'No audio, video or embedded frame (nothing auto-plays)', media);
  check('1.3.1 / 4.1.2', 'Form fields, buttons and links have accessible names (axe: label, button-name, link-name, select-name)', labels);
  check('1.4.3', 'Text contrast AA, light and dark (axe color-contrast)', contrast);
  check('2.5.5 (house rule)', 'Every visible interactive element is at least 44x44 px at 390px', targets);
  check('1.4.10 / 1.4.4', 'No horizontal scroll at 320 CSS px (400% reflow; covers 200% zoom)', reflow);
  check('2.3.3 (house rule)', 'prefers-reduced-motion: nothing animates longer than 0.01s', motion);

  const lines = [
    '# IS 5568 public-site check (compliance-005)',
    '',
    `${test.info().project.use.baseURL}, ${PAGES.length} public pages, light and dark, 390px (320px for reflow). Generated by \`apps/web/qa/regression.is5568.spec.js\`.`,
    'Keyboard-only flows, focus visibility and full axe WCAG 2.1 AA runs are in `regression.a11y.spec.js` (qa-006).',
    '',
    '| Criterion | Check | Result | Detail |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.what} | ${r.result} | ${r.detail || ''} |`),
    ...NEEDS_HUMAN.map(([what, why]) => `| | ${what} | NEEDS-HUMAN | ${why} |`),
    ...notRun.map((route) => `| | ${route} | DID NOT RUN | 404: customer accounts are off on this site (CUSTOMER_ACCOUNTS_ENABLED) |`),
    '',
    `PASS ${rows.filter((r) => r.result === 'PASS').length}, FAIL ${rows.filter((r) => r.result === 'FAIL').length}, NEEDS-HUMAN ${NEEDS_HUMAN.length}, DID NOT RUN ${notRun.length}. Neither NEEDS-HUMAN nor DID NOT RUN is a pass.`,
    '',
  ];
  const out = join(__dirname, '..', 'test-results');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'is5568-report.md'), lines.join('\n'));
  expect(rows.filter((r) => r.result === 'FAIL').map((r) => `${r.id} ${r.what}: ${r.detail}`)).toEqual([]);
});
