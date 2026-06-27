import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': r('src/shared'),
      '@omakase/storage': r('../../packages/storage/src/index.ts'),
      '@omakase/core': r('../../packages/core/src/index.ts'),
      '@omakase/daemon/testing': r('../../packages/daemon/src/testing/index.ts'),
      '@omakase/daemon': r('../../packages/daemon/src/index.ts'),
    },
  },
  test: {
    include: ['src/main/**/*.test.ts', 'src/renderer/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    globalSetup: ['../../scripts/ensure-node-sqlite.mjs'],
  },
});
