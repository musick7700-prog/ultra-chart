import { defineConfig } from 'vite';
export default defineConfig({
  base: '/ultra-chart/',
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
