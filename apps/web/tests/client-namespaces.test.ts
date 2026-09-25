import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENT_SCOPES } from '@/i18n/client-namespaces';

// Every namespace a component reads with useTranslations must be sent to the
// browser in each scope that renders it: components/admin/** in the admin
// scope, everything else in the public scope (and so in admin too).
const root = join(__dirname, '..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });

describe('client message scopes', () => {
  const uses = [...files(join(root, 'components')), ...files(join(root, 'app'))].flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/useTranslations\(['"]([a-z_]+)[.'"]/g)].map((m) => ({ file: relative(root, f), ns: m[1]! })),
  );

  it('public components only use public namespaces', () => {
    const missing = uses
      .filter((u) => !u.file.startsWith('components/admin/'))
      .filter((u) => !(CLIENT_SCOPES.public as readonly string[]).includes(u.ns));
    expect(missing).toEqual([]);
  });

  it('admin components only use namespaces of the admin scope', () => {
    const missing = uses
      .filter((u) => u.file.startsWith('components/admin/'))
      .filter((u) => !(CLIENT_SCOPES.admin as readonly string[]).includes(u.ns));
    expect(missing).toEqual([]);
  });

  it('the public scope never includes admin strings', () => {
    expect(CLIENT_SCOPES.public as readonly string[]).not.toContain('admin');
  });
});
