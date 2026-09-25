// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// regression.spec.js runs against a local production build + the local stack
// (npm run stack:up first). smoke.spec.js runs against a LIVE url only
// (SMOKE_BASE_URL); without it every smoke test is skipped, i.e. DID NOT RUN.
const PORT = Number(process.env.PORT || 3100);

module.exports = defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  fullyParallel: false,
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
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }, testMatch: /regression\.spec\.js/ },
    { name: 'smoke', use: { ...devices['Desktop Chrome'] }, testMatch: /smoke\.spec\.js/ },
  ],
  webServer: process.env.SKIP_WEBSERVER
    ? undefined
    : { command: `npx next start -p ${PORT}`, cwd: require('node:path').join(__dirname, '..'), port: PORT, reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
