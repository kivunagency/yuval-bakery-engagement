import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)), 'server-only': fileURLToPath(new URL('./tests/server-only-stub.ts', import.meta.url)) } },
  // Automatic JSX runtime, as Next uses, so components render in unit tests.
  esbuild: { jsx: 'automatic' },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
