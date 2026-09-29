// Bundles netlify/src/*.ts into netlify/functions/*.mjs (Netlify Functions v2).
// Why a pre-bundle: lib/server/* starts with `import 'server-only'`, whose
// default export throws unless the "react-server" condition resolves it to
// the empty module. Next.js sets that condition; Netlify's own function
// bundler does not (reproduced: the unbundled function threw at import).
// Bundling here with conditions: ['react-server'] keeps the guard in lib/server
// and ships a function that loads. Run: npm run build:functions
import { build } from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(app, 'netlify', 'src');
const out = join(app, 'netlify', 'functions');
rmSync(out, { recursive: true, force: true });

await build({
  absWorkingDir: app,
  entryPoints: readdirSync(src).filter((f) => f.endsWith('.ts')).map((f) => join(src, f)),
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  conditions: ['react-server'],
  tsconfig: join(app, 'tsconfig.json'),
  // CommonJS dependencies inside an ESM bundle still call require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
console.log(`built ${readdirSync(out).join(', ')} into netlify/functions/`);
