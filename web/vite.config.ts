// Dev server for the new launch page. Binds 127.0.0.1 only (README: the page must not be exposed or hosted).
// /api is proxied to the existing backend (app/server.ts, `pnpm page`). `--mode fixtures` runs without a backend.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5176,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:5175' },
    fs: { allow: ['..'] }, // shared modules live in ../sdk, ../app/public and ../research
  },
  preview: { host: '127.0.0.1', port: 5177 },
});
