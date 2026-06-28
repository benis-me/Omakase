import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@omakase/daemon/testing': fileURLToPath(
        new URL('../daemon/src/testing/index.ts', import.meta.url),
      ),
      '@omakase/daemon': fileURLToPath(new URL('../daemon/src/index.ts', import.meta.url)),
      '@omakase/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    passWithNoTests: true,
    environment: 'node',
    // node:sqlite is built in (no native ABI to heal); on the repo's Node 22 it needs
    // this flag (unflagged in Electron's Node 24). Replaces the old better-sqlite3 rebuild.
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--experimental-sqlite'] } },
  },
});
