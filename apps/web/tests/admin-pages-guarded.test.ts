import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Next.js does not re-run a layout on client navigation between its pages, so
// the admin shell's check alone does not protect a page. Every page under
// app/(admin) must call requireAdminPage() itself, and every admin API route
// must call getAdminSession().
function files(dir: string, name: RegExp): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p, name) : name.test(f) ? [p] : [];
  });
}

const root = join(__dirname, '..', 'app');

describe('admin guard', () => {
  it('every admin page calls requireAdminPage()', () => {
    const pages = files(join(root, '(admin)'), /^(page|layout)\.tsx$/);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.filter((p) => !/await requireAdminPage\(\)/.test(readFileSync(p, 'utf8')))).toEqual([]);
  });

  it('every admin API route calls getAdminSession()', () => {
    let routes: string[] = [];
    try {
      routes = files(join(root, 'api', 'admin'), /^route\.ts$/);
    } catch {
      routes = [];
    }
    expect(routes.filter((p) => !/await getAdminSession\(\)/.test(readFileSync(p, 'utf8')))).toEqual([]);
  });
});
