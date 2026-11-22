import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// 主網站。先由 vite.player.config.ts 產生 dist/player.html，這裡不清空 dist。
export default defineConfig({
  base: './',
  plugins: [preact()],
  build: { outDir: 'dist', emptyOutDir: false, target: 'es2022' },
});
