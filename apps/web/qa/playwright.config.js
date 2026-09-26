// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// regression.spec.js and regression.<domain>.spec.js (one file per domain, so
// parallel PRs do not collide) run against a local production build + the local stack
// (npm run stack:up first). smoke.spec.js runs against a LIVE url only
// (SMOKE_BASE_URL); without it every smoke test is skipped, i.e. DID NOT RUN.
const PORT = Number(process.env.PORT || 3100);

module.exports = defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  fullyParallel: false,
  // One worker: every spec shares one local database (admins, capacity days,
  // notification recipients). Parallel files raced on that shared state
  // (wave-2 integration: a new admin appeared between a send and its retry).
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }, testMatch: /regression(\.[a-z0-9-]+)?\.spec\.js/ },
    { name: 'smoke', use: { ...devices['Desktop Chrome'] }, testMatch: /smoke\.spec\.js/ },
    // docs-001: screenshots for docs/guide-yuval, run by hand (never part of the regression run)
    { name: 'docs', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }, testMatch: /guide-screens\.spec\.js/ },
  ],
  webServer: process.env.SKIP_WEBSERVER
    ? undefined
    : { command: `npx next start -p ${PORT}`, cwd: require('node:path').join(__dirname, '..'), port: PORT, reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
