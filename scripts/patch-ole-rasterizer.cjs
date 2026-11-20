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

// 8. Patch @mlightcad/cad-simple-viewer: AcTrScene missing layout self-healing patch
// Resolves: [AcTrScene] No layout associated with the specified block table record id '18'!
// Background: In certain survey drawings without standard paper space layouts, modelSpaceBtrId setter
// throws an unhandled error when _layouts.has(e) is false, completely crashing document loading.
const targetRoots = [root];
for (const currentRoot of targetRoots) {
  // 8.1 Patch cad-simple-viewer.js
  const viewerDistJs = path.join(currentRoot, 'node_modules/@mlightcad/cad-simple-viewer/dist/cad-simple-viewer.js');
  if (fs.existsSync(viewerDistJs)) {
    let code = fs.readFileSync(viewerDistJs, 'utf8');
    const targetPattern = 'if (this._modelSpaceBtrId = e, !this._layouts.has(e))';
    const patchedCode = "if (this._modelSpaceBtrId = e, !this._layouts.has(e)) { if (e && typeof this.addEmptyLayout === 'function') { try { this.addEmptyLayout(e); } catch {} } } if (!this._layouts.has(e))";
    if (code.includes(targetPattern) && !code.includes('this.addEmptyLayout(e)')) {
      code = code.replace(targetPattern, patchedCode);
      fs.writeFileSync(viewerDistJs, code, 'utf8');
      console.log(`[Patch] Injected AcTrScene missing layout self-healing in ${viewerDistJs}`);
    }
  }

  // 8.2 Patch cad-simple-viewer.umd.cjs
  const viewerUmdCjs = path.join(currentRoot, 'node_modules/@mlightcad/cad-simple-viewer/dist/cad-simple-viewer.umd.cjs');
  if (fs.existsSync(viewerUmdCjs)) {
    let code = fs.readFileSync(viewerUmdCjs, 'utf8');
    const targetPatternUmd = 'if(this._modelSpaceBtrId=e,!this._layouts.has(e))';
    const patchedCodeUmd = 'if(this._modelSpaceBtrId=e,!this._layouts.has(e)){if(e&&typeof this.addEmptyLayout==="function"){try{this.addEmptyLayout(e);}catch{}}}if(!this._layouts.has(e))';
    if (code.includes(targetPatternUmd) && !code.includes('this.addEmptyLayout(e)')) {
      code = code.replace(targetPatternUmd, patchedCodeUmd);
      fs.writeFileSync(viewerUmdCjs, code, 'utf8');
      console.log(`[Patch] Injected AcTrScene missing layout self-healing in ${viewerUmdCjs}`);
    }
  }

  // 8.3 Patch lib/view/AcTrScene.js
  const sceneLibJs = path.join(currentRoot, 'node_modules/@mlightcad/cad-simple-viewer/lib/view/AcTrScene.js');
  if (fs.existsSync(sceneLibJs)) {
    let code = fs.readFileSync(sceneLibJs, 'utf8');
    const targetPatternLib = 'this._modelSpaceBtrId = value;\n            if (!this._layouts.has(value)) {';
    const patchedCodeLib = 'this._modelSpaceBtrId = value;\n            if (!this._layouts.has(value)) {\n                if (value && typeof this.addEmptyLayout === "function") {\n                    try { this.addEmptyLayout(value); } catch {}\n                }\n            }\n            if (!this._layouts.has(value)) {';
    if (code.includes(targetPatternLib) && !code.includes('this.addEmptyLayout(value)')) {
      code = code.replace(targetPatternLib, patchedCodeLib);
      fs.writeFileSync(sceneLibJs, code, 'utf8');
      console.log(`[Patch] Injected AcTrScene missing layout self-healing in ${sceneLibJs}`);
    }
  }
}

// 9. Patch @mlightcad/cad-simple-viewer: Silence AcApProgress & MLightCAD brand overlays
// Resolves: Open-source spinner and "ML" cloud brand watermark collision during entity construction.
// Completely silences AcApProgress and strips MLightCAD SVG brand icons for commercial privatization.
for (const currentRoot of targetRoots) {
  // 9.1 Patch dist/cad-simple-viewer.js
  const viewerDistJs = path.join(currentRoot, 'node_modules/@mlightcad/cad-simple-viewer/dist/cad-simple-viewer.js');
  if (fs.existsSync(viewerDistJs)) {
    let code = fs.readFileSync(viewerDistJs, 'utf8');
    let modified = false;

    // Silence AcApProgress.prototype.show()
    const targetShow = 'show() {\n    return this.root.style.display = "flex", this;\n  }';
    const patchedShow = 'show() {\n    return this.root && (this.root.style.display = "none"), this;\n  }';
    if (code.includes(targetShow)) {
      code = code.replace(targetShow, patchedShow);
      modified = true;
    }

    // Set default showBrand to false
    if (code.includes('const t = e.showBrand ?? !0;')) {
      code = code.replace('const t = e.showBrand ?? !0;', 'const t = e.showBrand ?? !1;');
      modified = true;
    }

    // Silence initial root overlay display
    if (code.includes('i.className = "ml-ccl-overlay", i.style.display = "flex"')) {
      code = code.replace('i.className = "ml-ccl-overlay", i.style.display = "flex"', 'i.className = "ml-ccl-overlay", i.style.display = "none"');
      modified = true;
    }

    // Strip ML SVG brand watermark
    const svgPattern = /'<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>.*?<text[^>]*>ML<\/text><\/svg>'/g;
    if (svgPattern.test(code)) {
      code = code.replace(svgPattern, "''");
      modified = true;
    }

    if (modified) {
      fs.writeFileSync(viewerDistJs, code, 'utf8');
      console.log(`[Patch] Silenced AcApProgress & MLightCAD brand overlays in ${viewerDistJs}`);
    }
  }

  // 9.2 Patch dist/cad-simple-viewer.umd.cjs
  const viewerUmdCjs = path.join(currentRoot, 'node_modules/@mlightcad/cad-simple-viewer/dist/cad-simple-viewer.umd.cjs');
  if (fs.existsSync(viewerUmdCjs)) {
    let code = fs.readFileSync(viewerUmdCjs, 'utf8');
    let modified = false;

    // Silence AcApProgress.prototype.show()
    const targetShowUmd = 'show(){return this.root.style.display="flex",this}';
    const patchedShowUmd = 'show(){return this.root&&(this.root.style.display="none"),this}';
    if (code.includes(targetShowUmd)) {
      code = code.replace(targetShowUmd, patchedShowUmd);
      modified = true;
    }

    // Set default showBrand to false
    if (code.includes('const t=e.showBrand??!0;')) {
      code = code.replace('const t=e.showBrand??!0;', 'const t=e.showBrand??!1;');
      modified = true;
    }

    // Silence initial root overlay display
    if (code.includes('i.className="ml-ccl-overlay",i.style.display="flex"')) {
      code = code.replace('i.className="ml-ccl-overlay",i.style.display="flex"', 'i.className="ml-ccl-overlay",i.style.display="none"');
      modified = true;
    }

    // Strip ML SVG brand watermark
    const svgPatternUmd = /'<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>.*?<text[^>]*>ML<\/text><\/svg>'/g;
    if (svgPatternUmd.test(code)) {
      code = code.replace(svgPatternUmd, "''");
      modified = true;
    }

    if (modified) {
      fs.writeFileSync(viewerUmdCjs, code, 'utf8');
      console.log(`[Patch] Silenced AcApProgress & MLightCAD brand overlays in ${viewerUmdCjs}`);
    }
  }

  // 9.3 Patch lib/app/AcApProgress.js
  const progressLibJs = path.join(currentRoot, 'node_modules/@mlightcad/cad-simple-viewer/lib/app/AcApProgress.js');
  if (fs.existsSync(progressLibJs)) {
    let code = fs.readFileSync(progressLibJs, 'utf8');
    let modified = false;

    const targetProgressShow = "AcApProgress.prototype.show = function () {\n        this.root.style.display = 'flex';\n        return this;\n    };";
    const patchedProgressShow = "AcApProgress.prototype.show = function () {\n        if (this.root) this.root.style.display = 'none';\n        return this;\n    };";
    if (code.includes(targetProgressShow)) {
      code = code.replace(targetProgressShow, patchedProgressShow);
      modified = true;
    }

    if (code.includes("overlay.style.display = 'flex';")) {
      code = code.replace("overlay.style.display = 'flex';", "overlay.style.display = 'none';");
      modified = true;
    }

    if (code.includes("var showBrand = (_a = options.showBrand) !== null && _a !== void 0 ? _a : true;")) {
      code = code.replace("var showBrand = (_a = options.showBrand) !== null && _a !== void 0 ? _a : true;", "var showBrand = (_a = options.showBrand) !== null && _a !== void 0 ? _a : false;");
      modified = true;
    }

    if (modified) {
      fs.writeFileSync(progressLibJs, code, 'utf8');
      console.log(`[Patch] Silenced AcApProgress in ${progressLibJs}`);
    }
  }

  // 9.4 Patch lib/app/AcApBrand.js
  const brandLibJs = path.join(currentRoot, 'node_modules/@mlightcad/cad-simple-viewer/lib/app/AcApBrand.js');
  if (fs.existsSync(brandLibJs)) {
    let code = fs.readFileSync(brandLibJs, 'utf8');
    if (code.includes("export var MLIGHTCAD_ICON_SVG = '<svg")) {
      code = code.replace(/export var MLIGHTCAD_ICON_SVG = '<svg[\s\S]*?<\/svg>';/, "export var MLIGHTCAD_ICON_SVG = '';");
      fs.writeFileSync(brandLibJs, code, 'utf8');
      console.log(`[Patch] Stripped MLIGHTCAD_ICON_SVG in ${brandLibJs}`);
    }
  }
}

console.log('[Patch] All OLE2FRAME / EMF / AcTrScene / Privatization patches completed successfully!');
