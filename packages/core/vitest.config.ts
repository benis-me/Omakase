import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@omakase/daemon/testing': fileURLToPath(
        new URL('../daemon/src/testing/index.ts', import.meta.url),
      ),
      '@omakase/daemon': fileURLToPath(
        new URL('../daemon/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    passWithNoTests: true,
    environment: 'node',
  },
});
