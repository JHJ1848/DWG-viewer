/**
 * Electron 生产后端打包构建脚本 (electron/build-server.cjs)
 * 将根目录的 server.ts 编译为可在 Electron 生产环境脱离 tsx 独立运行的 CommonJS 模块 (electron/server.cjs)。
 */
const esbuild = require('esbuild');
const path = require('path');

try {
  esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, '../server.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    outfile: path.resolve(__dirname, 'server.cjs'),
    banner: {
      js: 'const __import_meta_url = require("url").pathToFileURL(require("path").resolve(__dirname, "..", "server.js")).href;',
    },
    define: {
      'import.meta.url': '__import_meta_url',
    },
  });
  console.log('[build-server] Successfully compiled server.ts to electron/server.cjs');
} catch (err) {
  console.error('[build-server] Failed to compile server.ts:', err);
  process.exit(1);
}
