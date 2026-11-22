import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 離線播放器：打包成單一 HTML（JS/CSS 全部內嵌），匯出 .olt.html 時當作範本
export default defineConfig({
  base: './',
  plugins: [preact(), viteSingleFile()],
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: 'player.html' },
  },
});
