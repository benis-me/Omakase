import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@omakase/daemon/testing': fileURLToPath(
        new URL('../../packages/daemon/src/testing/index.ts', import.meta.url),
      ),
      '@omakase/daemon': fileURLToPath(
        new URL('../../packages/daemon/src/index.ts', import.meta.url),
      ),
      '@omakase/core': fileURLToPath(
        new URL('../../packages/core/src/index.ts', import.meta.url),
      ),
    },
  },
  test: { include: ['*.test.ts'], passWithNoTests: true, environment: 'node' },
});
