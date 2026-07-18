import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@mat/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) } },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:7788', '/ws': { target: 'ws://127.0.0.1:7788', ws: true } } },
  build: { outDir: 'dist', emptyOutDir: true },
});
