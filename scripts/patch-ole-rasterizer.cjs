const fs = require('fs');
const path = require('path');

console.log('[Patch] Starting OLE2FRAME / EMF high-resolution rasterizer patch...');

const root = path.resolve(__dirname, '..');

// 1. Patch @mlightcad/three-renderer/dist/index.umd.cjs (Used by cad-simple-viewer)
const threeRendererUmd = path.join(root, 'node_modules/@mlightcad/three-renderer/dist/index.umd.cjs');
if (fs.existsSync(threeRendererUmd)) {
  let code = fs.readFileSync(threeRendererUmd, 'utf8');
  let modified = false;

  if (code.includes('maxWidth:4096,maxHeight:4096,dpiScale:1')) {
    code = code.replace(/maxWidth:4096,maxHeight:4096,dpiScale:1/g, 'maxWidth:4096,maxHeight:4096,dpiScale:4');
    modified = true;
    console.log('[Patch] Patched dpiScale: 4 in @mlightcad/three-renderer/dist/index.umd.cjs');
  }

  if (code.includes('applyTexture(e){') && !code.includes('e.anisotropy=8')) {
    code = code.replace(
      'applyTexture(e){',
      'applyTexture(e){if(e){try{e.anisotropy=8;e.generateMipmaps=!0;}catch{}}'
    );
    modified = true;
    console.log('[Patch] Enhanced applyTexture with anisotropy in @mlightcad/three-renderer/dist/index.umd.cjs');
  }

  if (modified) {
    fs.writeFileSync(threeRendererUmd, code, 'utf8');
  }
}

// 2. Patch @mlightcad/three-renderer/dist/index.js
const threeRendererDist = path.join(root, 'node_modules/@mlightcad/three-renderer/dist/index.js');
if (fs.existsSync(threeRendererDist)) {
  let code = fs.readFileSync(threeRendererDist, 'utf8');
  let modified = false;

  if (code.includes('dpiScale: 1')) {
    code = code.replace(/dpiScale:\s*1\b/g, 'dpiScale: 4');
    modified = true;
    console.log('[Patch] Patched dpiScale: 4 in @mlightcad/three-renderer/dist/index.js');
  }

  if (code.includes('applyTexture(e) {') && !code.includes('e.anisotropy = 8')) {
    code = code.replace(
      'applyTexture(e) {',
      'applyTexture(e) { if (e) { try { e.anisotropy = 8; e.generateMipmaps = true; } catch {} }'
    );
    modified = true;
    console.log('[Patch] Enhanced applyTexture with anisotropy in @mlightcad/three-renderer/dist/index.js');
  }

  if (modified) {
    fs.writeFileSync(threeRendererDist, code, 'utf8');
  }
}

// 3. Patch @mlightcad/three-renderer/lib/object/AcTrImage.js
const threeRendererLib = path.join(root, 'node_modules/@mlightcad/three-renderer/lib/object/AcTrImage.js');
if (fs.existsSync(threeRendererLib)) {
  let code = fs.readFileSync(threeRendererLib, 'utf8');
  let modified = false;

  if (code.includes('dpiScale: 1')) {
    code = code.replace(/dpiScale:\s*1\b/g, 'dpiScale: 4');
    modified = true;
    console.log('[Patch] Patched dpiScale: 4 in @mlightcad/three-renderer/lib/object/AcTrImage.js');
  }

  if (code.includes('applyTexture = function (texture) {') && !code.includes('texture.anisotropy = 8')) {
    code = code.replace(
      'applyTexture = function (texture) {',
      'applyTexture = function (texture) { if (texture) { try { texture.anisotropy = 8; texture.generateMipmaps = true; } catch {} }'
    );
    modified = true;
    console.log('[Patch] Enhanced applyTexture with anisotropy in @mlightcad/three-renderer/lib/object/AcTrImage.js');
  }

  if (modified) {
    fs.writeFileSync(threeRendererLib, code, 'utf8');
  }
}

// 4. Patch @mlightcad/data-model/lib/misc/AcDbOleMetafileRasterizer.js
const dataModelRasterizer = path.join(root, 'node_modules/@mlightcad/data-model/lib/misc/AcDbOleMetafileRasterizer.js');
if (fs.existsSync(dataModelRasterizer)) {
  let code = fs.readFileSync(dataModelRasterizer, 'utf8');
  if (code.includes('dpiScale: (_c = options.dpiScale) !== null && _c !== void 0 ? _c : 1,')) {
    code = code.replace(
      'dpiScale: (_c = options.dpiScale) !== null && _c !== void 0 ? _c : 1,',
      'dpiScale: Math.max((_c = options.dpiScale) !== null && _c !== void 0 ? _c : 1, 4),'
    );
    fs.writeFileSync(dataModelRasterizer, code, 'utf8');
    console.log('[Patch] Patched dpiScale clamp in @mlightcad/data-model/lib/misc/AcDbOleMetafileRasterizer.js');
  }
}

// 5. Patch @mlightcad/data-model/dist/data-model.cjs
const dataModelCjs = path.join(root, 'node_modules/@mlightcad/data-model/dist/data-model.cjs');
if (fs.existsSync(dataModelCjs)) {
  let code = fs.readFileSync(dataModelCjs, 'utf8');
  if (code.includes('dpiScale:t.dpiScale??1')) {
    code = code.replace('dpiScale:t.dpiScale??1', 'dpiScale:Math.max(t.dpiScale??1,4)');
    fs.writeFileSync(dataModelCjs, code, 'utf8');
    console.log('[Patch] Patched dpiScale clamp in @mlightcad/data-model/dist/data-model.cjs');
  }
}

// 6. Patch @mlightcad/emf-converter/dist/index.js & index.mjs
const emfDistJs = path.join(root, 'node_modules/@mlightcad/emf-converter/dist/index.js');
if (fs.existsSync(emfDistJs)) {
  let code = fs.readFileSync(emfDistJs, 'utf8');
  if (code.includes('var DEFAULT_DPI_SCALE = 1;')) {
    code = code.replace('var DEFAULT_DPI_SCALE = 1;', 'var DEFAULT_DPI_SCALE = 4;');
    fs.writeFileSync(emfDistJs, code, 'utf8');
    console.log('[Patch] Patched DEFAULT_DPI_SCALE = 4 in @mlightcad/emf-converter/dist/index.js');
  }
}
const emfDistMjs = path.join(root, 'node_modules/@mlightcad/emf-converter/dist/index.mjs');
if (fs.existsSync(emfDistMjs)) {
  let code = fs.readFileSync(emfDistMjs, 'utf8');
  if (code.includes('var DEFAULT_DPI_SCALE = 1;')) {
    code = code.replace('var DEFAULT_DPI_SCALE = 1;', 'var DEFAULT_DPI_SCALE = 4;');
    fs.writeFileSync(emfDistMjs, code, 'utf8');
    console.log('[Patch] Patched DEFAULT_DPI_SCALE = 4 in @mlightcad/emf-converter/dist/index.mjs');
  }
}

// 7. Clean node_modules/.vite to ensure Vite rebuilds deps with new patches
const viteDir = path.join(root, 'node_modules/.vite');
if (fs.existsSync(viteDir)) {
  try {
    fs.rmSync(viteDir, { recursive: true, force: true });
    console.log('[Patch] Cleaned node_modules/.vite cache directory');
  } catch (e) {
    console.warn('[Patch] Warning: could not remove .vite directory directly:', e.message);
  }
}

console.log('[Patch] All OLE2FRAME / EMF high-resolution patches completed successfully!');
