import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@omakase/daemon/testing': fileURLToPath(
        new URL('../daemon/src/testing/index.ts', import.meta.url),
      ),
      '@omakase/daemon': fileURLToPath(
        new URL('../daemon/src/index.ts', import.meta.url),
      ),
      '@omakase/core': fileURLToPath(
        new URL('../core/src/index.ts', import.meta.url),
      ),
      '@omakase/storage': fileURLToPath(
        new URL('../storage/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--experimental-sqlite'] } },
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
    environment: 'node',
  },
});
