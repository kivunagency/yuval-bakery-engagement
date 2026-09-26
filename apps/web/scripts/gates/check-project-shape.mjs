#!/usr/bin/env node
/**
 * The house shape: one layout, one vocabulary, across every project we build.
 *
 * WHY THIS EXISTS. We have a house style and it has never been written down, so every
 * project reinvents it and only one of them got it right. Measured across all three on
 * 2026-09-16:
 *
 *                      where the app lives        lib layering              stray files
 *   mishkei-lev        repo root                  client / server / shared       0
 *   egoz-maniv         output/frontend/src        lib/, flat, no server/        ~25 at the app root
 *   KivunOS            frontend/src + backend/    none (different framework)     0
 *
 * mishkei-lev is the shape, and the reason it is the shape is measurable: 39 routes and
 * ZERO of them query the database, against egoz's 85 of 115. It has somewhere to delegate
 * TO. egoz has 85 routes querying directly in large part because there is no lib/server for
 * them to call. The layering is not bureaucracy, it is the thing that makes Rule 2 possible
 * to obey. Seventeen of seventeen mishkei-lev server modules open with `import 'server-only'`.
 *
 * WHAT IT CHECKS, and each one is a real failure this agency has paid for:
 *
 *   server-only      a module under lib/server that does not declare `import 'server-only'`
 *                    is a module a client component can import, and secrets follow it into
 *                    the browser (Rule 2).
 *   layer direction  lib/client or lib/shared importing from lib/server. The import graph
 *                    only points one way; the moment it does not, the layering is a naming
 *                    convention rather than a boundary.
 *   stray scripts    a loose .mjs/.js debug script sitting in the app root. egoz has about
 *                    twenty-five, every one of them a one-off verification from a closed
 *                    ticket, several containing a plaintext production credential. They are
 *                    not harmless clutter; they are where credentials went to live.
 *   domain modules   lib/server/<domain>/index.ts, one directory per bounded context. A
 *                    file directly under lib/server is a context with no name.
 *
 * WHAT IT DOES NOT CHECK, on purpose. It does not require Next.js and it does not fail a
 * project that has no lib/ at all. A Vite SPA with a separate backend is a legitimate
 * choice; what is not legitimate is claiming a layer and not having one. If lib/server
 * does not exist, the layer checks are reported as not applicable, out loud, rather than
 * counted as clean.
 *
 * Exit codes
 *   0  ran, nothing got worse     1  ran, something got worse     2  DID NOT RUN
 *
 * Usage
 *   node check-project-shape.mjs --report [--json]
 *   node check-project-shape.mjs --write-baseline <file>
 *   node check-project-shape.mjs --ratchet --baseline <file> [--json]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { runRatchet } from './lib/ratchet.mjs';

const SKIP = new Set([
  // YuvalBakery adaptation (wave-3 integration): gitignored build output, not
  // source. netlify/functions is the esbuild bundle of netlify/src; the gates
  // saw the bundled dependencies' catches when a build had run first.
  'test-results',
  'playwright-report',
  'functions',
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.vercel',
  'coverage',
  '.worktrees',
  'supabase',
  'public',
]);
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (CODE.test(e.name)) out.push(p);
  }
  return out;
}

// where the application actually lives: the directory holding app/ or src/app/
function appRoot(root) {
  for (const c of [
    '',
    'src',
    'output/frontend',
    'output/frontend/src',
    'frontend',
    'frontend/src',
    'apps/web',
  ]) {
    const base = c ? join(root, c) : root;
    if (existsSync(join(base, 'app')) || existsSync(join(base, 'lib'))) return base;
  }
  return null;
}

// a loose script at the app root is not a source file, it is a leftover
const ALLOWED_ROOT =
  /^(next|vite|tailwind|postcss|eslint|jest|vitest|playwright|middleware|instrumentation|sentry[.\w-]*)\.config\.(ts|js|mjs|cjs)$|^(middleware|instrumentation)\.(ts|js)$|^next-env\.d\.ts$/;

function scan(root, dnr) {
  const base = appRoot(root);
  if (!base) {
    dnr(
      `no app/ or lib/ directory found under ${root}. Nothing was scanned, and that is ` +
        `not "the shape is fine". Pass --root at the directory that holds the application.`
    );
  }

  const items = {};
  const bump = (file, metric) => {
    const k = relative(root, file) || basename(file);
    items[k] ||= {};
    items[k][metric] = (items[k][metric] || 0) + 1;
  };

  const serverDir = join(base, 'lib', 'server');
  const hasServerLayer = existsSync(serverDir);

  let serverModules = 0,
    missingServerOnly = 0,
    wrongDirection = 0,
    stray = 0,
    unnamedContext = 0;

  if (hasServerLayer) {
    // domain modules: lib/server/<domain>/index.ts. A file sitting directly under
    // lib/server is a bounded context nobody named.
    for (const e of readdirSync(serverDir, { withFileTypes: true })) {
      if (e.isFile() && CODE.test(e.name)) {
        unnamedContext++;
        bump(join(serverDir, e.name), 'unnamedContext');
      }
    }
    for (const f of walk(serverDir)) {
      serverModules++;
      const head = readFileSync(f, 'utf8').slice(0, 2000);
      if (!/^\s*import\s+['"]server-only['"]/m.test(head)) {
        missingServerOnly++;
        bump(f, 'missingServerOnly');
      }
    }
    // the import graph points one way only
    for (const layer of ['client', 'shared']) {
      const d = join(base, 'lib', layer);
      if (!existsSync(d)) continue;
      for (const f of walk(d)) {
        const src = readFileSync(f, 'utf8');
        if (/from\s+['"](?:@\/lib\/server|\.\.\/server|\.\.\/\.\.\/lib\/server)/.test(src)) {
          wrongDirection++;
          bump(f, 'clientImportsServer');
        }
      }
    }
  }

  // Stray scripts, at the PACKAGE root as well as the app root.
  //
  // This check reported ZERO on egoz-maniv the first time it ran, while 32 loose scripts
  // sat one directory above the one it looked in: appRoot resolves to src/ (that is where
  // app/ and lib/ are) and the strays live beside package.json. A check that cannot see
  // does not get to say clean, so both roots are scanned and the count is the union.
  const roots = new Set([base]);
  for (const c of ['', 'src', 'output/frontend', 'frontend', 'apps/web']) {
    const d = c ? join(root, c) : root;
    if (existsSync(join(d, 'package.json'))) roots.add(d);
  }
  let pkgRoot = null;
  for (const d of roots) {
    if (existsSync(join(d, 'package.json'))) pkgRoot = relative(root, d) || '.';
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isFile() || !CODE.test(e.name)) continue;
      if (ALLOWED_ROOT.test(e.name)) continue;
      stray++;
      bump(join(d, e.name), 'strayRootScript');
    }
  }

  return {
    items,
    summary: {
      appRoot: relative(root, base) || '.',
      packageRoot: pkgRoot || '(none found)',
      serverLayer: hasServerLayer ? 'present' : 'ABSENT (layer checks not applicable)',
      serverModules,
      missingServerOnly,
      clientImportsServer: wrongDirection,
      unnamedContext,
      strayRootScripts: stray,
    },
  };
}

runRatchet({
  tool: 'check-project-shape',
  rule: 'House shape (Rule 2, Rule 24)',
  headline: (s) =>
    `${s.serverModules} server module(s) in ${s.appRoot}; ${s.missingServerOnly} without server-only, ` +
    `${s.clientImportsServer} importing server from a client layer, ${s.unnamedContext} unnamed context(s), ` +
    `${s.strayRootScripts} stray root script(s)`,
  scan,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
});
