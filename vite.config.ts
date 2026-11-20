import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readdirSync } from 'node:fs';
import {defineConfig} from 'vite';

export default defineConfig(({ command }) => {
  if (command === 'build') {
    const samples = readdirSync(path.resolve(__dirname, 'public/samples'));
    if (samples.length !== 1 || !samples.includes('canteen.dwg')) {
      throw new Error('Release assets must contain only public/samples/canteen.dwg. Store local drawings outside public/.');
    }
  }
  return {
    // [03_ui_design] 统一绝对路径基准，与 HTML5 History 深层路由完全解耦，彻底根除深层子路由下 ./assets 相对路径 404 白屏
    base: '/',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    define: {
      __APP_CACHE_BUSTER__: JSON.stringify('v2_hidpi_ole_table'),
    },
    optimizeDeps: {
      include: ['lodash-es'],
    },
    server: {
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
