import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const sharedAlias = { '@shared': resolve('src/shared') };

// Bundle the pure-TS @omakase packages into the main bundle (so a CJS main can
// use these ESM-only packages), while keeping their native deps (better-sqlite3,
// node-pty) external + asarUnpacked.
const omakasePackages = ['@omakase/core', '@omakase/daemon', '@omakase/storage'];

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    plugins: [externalizeDepsPlugin({ exclude: omakasePackages })],
  },
  preload: {
    resolve: { alias: sharedAlias },
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer/src'), ...sharedAlias } },
    server: { port: 5190 },
    plugins: [react(), tailwindcss()],
  },
});
