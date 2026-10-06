import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5180, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
});
