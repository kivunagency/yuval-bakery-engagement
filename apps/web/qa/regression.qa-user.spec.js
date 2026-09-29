// @ts-check
// qa-005: the managed QA user (Rule 22). The credential file is gitignored, the
// template carries no values, a missing file is DID NOT RUN (never a pass), and
// the local user the script creates really logs in through /admin/login.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const { readFileSync, statSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { loadQaUser, parseQaEnv, REQUIRED_QA_KEYS } = require('./helpers/qa-user');
const { uiLogin } = require('./helpers/admin-ui');

const APP = join(__dirname, '..');

test.describe('managed QA user (qa-005)', () => {
  test('.qa.env is gitignored; .qa.env.example is tracked and holds no values', async () => {
    // check-ignore exits 0 when the path IS ignored, 1 when it is not
    expect(() => execFileSync('git', ['check-ignore', '--no-index', '-q', '.qa.env'], { cwd: APP })).not.toThrow();
    expect(() => execFileSync('git', ['check-ignore', '--no-index', '-q', '.qa.env.example'], { cwd: APP })).toThrow();
    const example = parseQaEnv(readFileSync(join(APP, '.qa.env.example'), 'utf8'));
    for (const k of REQUIRED_QA_KEYS) expect(example[k], k).toBe('');
  });

  test('a missing or incomplete file is reported as not available, with the reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-user-'));
    const missing = loadQaUser(join(dir, 'none.env'));
    expect(missing.ok).toBe(false);
    const partial = join(dir, 'partial.env');
    require('node:fs').writeFileSync(partial, 'QA_ENV=local\nQA_ADMIN_EMAIL=x@example.test\n');
    const r = loadQaUser(partial);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('QA_ADMIN_PASSWORD') });
  });

  test('npm run qa:user creates a local admin that logs in with password and TOTP; nothing secret is printed', async ({ page }) => {
    const out = join(mkdtempSync(join(tmpdir(), 'qa-user-')), '.qa.env');
    const printed = execFileSync('node', ['scripts/qa-user.mjs', '--out', out, '--email', `qa-admin-${Date.now()}@example.test`], { cwd: APP, encoding: 'utf8' });
    expect((statSync(out).mode & 0o777).toString(8)).toBe('600');
    const loaded = loadQaUser(out);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(printed).toContain(loaded.user.email);
    expect(printed).not.toContain(loaded.user.password);
    expect(printed).not.toContain(loaded.user.secret);

    await uiLogin(page, loaded.user);
    await expect(page).toHaveURL(/\/admin\/orders/);

    // running it again replaces the user: the old password stops working
    execFileSync('node', ['scripts/qa-user.mjs', '--out', out, '--email', loaded.user.email], { cwd: APP, encoding: 'utf8' });
    const again = loadQaUser(out);
    expect(again.ok && again.user.password).not.toBe(loaded.user.password);
  });
});
