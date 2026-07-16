import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard talks to the `omks web` API server (default :4517).
// In dev, Vite serves the SPA on :5178 and proxies /api to the server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5178,
    proxy: {
      '/api': 'http://localhost:4517',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
