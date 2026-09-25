import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENT_SCOPES } from '@/i18n/client-namespaces';

// Every namespace a component reads with useTranslations must be sent to the
// browser by some scope: components/admin/** by the admin scope, components
// under components/<dir>/ by a public scope. The route layouts pick the scope
// (app/(public)/*/layout.tsx); a missing namespace fails the regression specs
// at render.
const root = join(__dirname, '..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
const nonAdmin = new Set<string>(Object.entries(CLIENT_SCOPES).filter(([k]) => k !== 'admin').flatMap(([, v]) => [...v]));

describe('client message scopes', () => {
  const uses = [...files(join(root, 'components')), ...files(join(root, 'app'))].flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/useTranslations\(['"]([a-z_]+)[.'"]/g)].map((m) => ({ file: relative(root, f), ns: m[1]! })),
  );

  it('public components only use namespaces some public scope sends', () => {
    expect(uses.filter((u) => !u.file.startsWith('components/admin/') && !nonAdmin.has(u.ns))).toEqual([]);
  });

  it('admin components only use namespaces of the admin scope', () => {
    expect(uses.filter((u) => u.file.startsWith('components/admin/') && !(CLIENT_SCOPES.admin as readonly string[]).includes(u.ns))).toEqual([]);
  });

  it('no public scope includes admin strings, and the base public scope stays small', () => {
    for (const [k, v] of Object.entries(CLIENT_SCOPES)) if (k !== 'admin') expect(v as readonly string[]).not.toContain('admin');
    for (const ns of ['checkout', 'payment', 'custom_cake', 'registration', 'account']) expect(CLIENT_SCOPES.public as readonly string[]).not.toContain(ns);
  });
});
