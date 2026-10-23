import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
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
      proxy: {
        '/api/system': {
          target: 'http://192.168.81.163:9008',
          changeOrigin: true,
        },
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
