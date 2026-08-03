import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve zalo_service dir — used to scope vite root so it does not pick up
// Chatwoot's parent postcss.config.js which needs packages not installed here.
const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: rootDir,
  css: {
    postcss: { plugins: [] },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    testTimeout: 10_000,
    css: false,
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['tests/**', 'dist/**', '**/*.config.ts'],
    },
  },
  resolve: {
    alias: {
      '@': `${rootDir}src/`,
    },
  },
});
