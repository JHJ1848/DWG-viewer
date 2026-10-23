import { AcDbBaseWorker } from '@mlightcad/data-model';
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';

const BIG_FONTS = new Set([
  'hztxt',
  'gbcbig',
  'gbhzfs',
  'tssdchn',
  'pkpmeng',
  'intecad',
  'hzfs',
  'china',
  'hz',
  'dxf_hztxt',
]);

/**
 * Strips path and extension, returning lowercase base font name
 */
function cleanFontName(name?: string): string {
  if (!name || typeof name !== 'string') return '';
  let str = name.trim();
  const lastSlash = Math.max(str.lastIndexOf('/'), str.lastIndexOf('\\'));
  if (lastSlash >= 0) {
    str = str.substring(lastSlash + 1);
  }
  const dotIndex = str.lastIndexOf('.');
  if (dotIndex > 0) {
    str = str.substring(0, dotIndex);
  }
  return str.toLowerCase().trim();
}

/**
 * Extracts TrueType font name from ACAD XData (Group 1000)
 */
function extractExtendedFontFromXData(xdata: any): string | undefined {
  if (!xdata || typeof xdata !== 'object') return undefined;

  const acad = xdata['ACAD'] || xdata['acad'];
  if (acad) {
    if (Array.isArray(acad)) {
      for (const item of acad) {
        if (!item) continue;
        if (
          (item.code === 1000 || item.group === 1000) &&
          typeof item.value === 'string' &&
          item.value.trim()
        ) {
          return item.value.trim();
        }
        if (typeof item === 'string' && item.trim()) {
          return item.trim();
        }
      }
    } else if (typeof acad === 'string' && acad.trim()) {
      return acad.trim();
    }
  }

  for (const key of Object.keys(xdata)) {
    const val = xdata[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (!item) continue;
        if (
          (item.code === 1000 || item.group === 1000) &&
          typeof item.value === 'string' &&
          item.value.trim()
        ) {
          return item.value.trim();
        }
      }
    }
  }
  return undefined;
}

/**
 * Enriches STYLE table entries directly from raw DWG objects in WASM memory before freeing:
 * 1. Reads TrueType extendedFont from ACAD XData (Group 1000).
 * 2. Reads fixed text height from DWG_TYPE_STYLE text_size.
 */
function enrichStylesFromRawDwg(instance: any, dwg: any, database: any) {
  if (!instance || !dwg || !database?.tables?.STYLE?.entries) return;
  const styleEntries = database.tables.STYLE.entries as any[];
  if (!Array.isArray(styleEntries) || styleEntries.length === 0) return;

  try {
    const wasm = instance.wasmInstance || instance;
    const getNumObjects = wasm.dwg_get_num_objects || instance.dwg_get_num_objects;
    const getObject = wasm.dwg_get_object || instance.dwg_get_object;
    const getFixedType = wasm.dwg_object_get_fixedtype || instance.dwg_object_get_fixedtype;
    const toObjectTio = wasm.dwg_object_to_object_tio || instance.dwg_object_to_object_tio;
    const getXData = wasm.dwg_object_entity_get_xdata || instance.dwg_object_entity_get_xdata;
    const dynApi =
      instance.dwg_dynapi_entity_data?.bind(instance) ||
      wasm.dwg_dynapi_entity_data?.bind(wasm);

    if (typeof getNumObjects !== 'function' || typeof getObject !== 'function') {
      return;
    }

    const numObjects = getNumObjects.call(wasm, dwg);
    const styleMap = new Map<string, any>();
    for (const entry of styleEntries) {
      if (entry.handle) styleMap.set(String(entry.handle).toUpperCase(), entry);
      if (entry.name) styleMap.set(String(entry.name).toUpperCase(), entry);
    }

    for (let i = 0; i < numObjects; i++) {
      const obj = getObject.call(wasm, dwg, i);
      if (!obj) continue;
      const fixedType = getFixedType ? getFixedType.call(wasm, obj) : 0;
      if (fixedType === 53) {
        // DWG_TYPE_STYLE
        const tio = toObjectTio ? toObjectTio.call(wasm, obj) : obj;
        let styleName = '';
        let fixedHeight = 0;
        if (dynApi && tio) {
          try {
            styleName = dynApi(tio, 'name') || '';
            fixedHeight = Number(dynApi(tio, 'text_size')) || 0;
          } catch {
            // ignore
          }
        }

        let extendedFont: string | undefined;
        if (getXData) {
          try {
            const xdata = getXData.call(wasm, obj);
            extendedFont = extractExtendedFontFromXData(xdata);
          } catch {
            // ignore
          }
        }

        const matched = styleMap.get(String(styleName).toUpperCase());
        if (matched) {
          if (extendedFont && !matched.extendedFont) {
            matched.extendedFont = extendedFont;
          }
          if (fixedHeight > 0 && (!matched.fixedTextHeight || matched.fixedTextHeight === 0)) {
            matched.fixedTextHeight = fixedHeight;
          }
        }
      }
    }
  } catch (err) {
    console.warn('[ParserWorker] enrichStylesFromRawDwg skipped:', err);
  }
}

/**
 * Normalizes font settings in STYLE table:
 * Enforces unified pure single-line vector font (simplex.shx) for ALL western/numeric text,
 * paired with standard single-line Chinese bigfont (hztxt.shx).
 * Ensures numbers and letters are pure lines (not filled solid meshes) and have 100% consistent height with Chinese characters.
 */
function normalizeStyleEntries(styles: any[] | undefined) {
  if (!Array.isArray(styles)) return;
  for (const style of styles) {
    if (!style || typeof style !== 'object') continue;

    const fontClean = cleanFontName(style.font);
    const bigFontClean = cleanFontName(style.bigFont);

    // 1. Unify western/numeric font to 'simplex' (standard single-line vector font, pure stroke, no mesh fill)
    style.font = 'simplex';
    style.extendedFont = 'simplex';

    // 2. Ensure standard Chinese single-line BigFont (hztxt / gbcbig)
    if (BIG_FONTS.has(fontClean) && !bigFontClean) {
      style.bigFont = fontClean;
    } else if (bigFontClean) {
      style.bigFont = bigFontClean;
    } else {
      style.bigFont = 'hztxt';
    }
  }
}

/**
 * Converts Unicode superscript characters (³, ², ¹, ⁰) and legacy AutoCAD symbol codes (%%179, %%178)
 * into native AutoCAD MText single-line stacking syntax (e.g. m³ -> m{\S3^;}).
 * This ensures they are rendered directly by simplex.shx using pure vector single-stroke numbers,
 * completely preventing glyph-miss fallback to right arrows (→).
 */
function normalizeSpecialTextSymbols(str: string): string {
  if (!str || typeof str !== 'string') return str;

  return str
    // 立方米上标 ³ (\u00B3, \u2073, %%179) -> {\S3^;}
    .replace(/(?:[\u00B3\u2073]|%%179)/g, '{\\S3^;}')
    // 平方米上标 ² (\u00B2, \u2072, %%178) -> {\S2^;}
    .replace(/(?:[\u00B2\u2072]|%%178)/g, '{\\S2^;}')
    // 上标 ¹ (\u00B9, \u2071) -> {\S1^;}
    .replace(/[\u00B9\u2071]/g, '{\\S1^;}')
    // 上标 ⁰ (\u2070) -> {\S0^;}
    .replace(/\u2070/g, '{\\S0^;}')
    // 矫正若图纸中已存在的下标写法 \S^3; -> {\S3^;}
    .replace(/\\S\^([0-9]+);/g, '{\\S$1^;}');
}

/**
 * Normalizes inline font override codes and special symbols in MTEXT, TEXT, and ATTRIB strings.
 * 1. Converts superscript symbols (³, ²) to native AutoCAD single-line stacking syntax ({\S3^;}).
 * 2. Redirects all inline font overrides to pure single-line vector font \Fsimplex;.
 */
function normalizeInlineMTextFontCodes(ent: any) {
  if (!ent) return;
  const fields = ['text', 'value', 'dimensionText'];
  for (const field of fields) {
    let val = ent[field];
    if (typeof val === 'string' && val.length > 0) {
      // 1. 转义立方米/平方米等上标字符为 AutoCAD 原生纯单线上标堆叠语法
      val = normalizeSpecialTextSymbols(val);

      // 2. 将内联字体全部替换为纯单线西文字体 simplex
      if (/\\[Ff]/i.test(val)) {
        val = val.replace(/\\[Ff][^;]*;/gi, '\\Fsimplex;');
      }
      ent[field] = val;
    }
  }

  if (Array.isArray(ent.attribs)) {
    for (const attr of ent.attribs) {
      normalizeInlineMTextFontCodes(attr);
    }
  }
}

/**

 * Normalizes a parsed LibreDWG database for 2D CAD viewport rendering:
 * 1. Keeps non-plottable layers (plotFlag = 0, commonly used for coordinate grids,
 *    construction lines, and Defpoints) visible on screen just like AutoCAD's viewport.
 * 2. Flattens surveying/topographic Z elevations (e.g., contour lines at Z = 500m~3000m)
 *    to Z = 0 so Three.js OrthographicCamera (z=500, near=0.1, far=1000) never clips them.
 * 3. Maps LibreDWG LWPOLYLINE closed bit (512) to standard DXF closed bit (1).
 * 4. Prevents spline-control-only POLYLINE2D contour lines from being filtered to 0 vertices.
 */
function normalizeEntityList(entities: any[] | undefined) {
  if (!Array.isArray(entities)) return;
  for (let i = 0; i < entities.length; i++) {
    const ent = entities[i];
    if (!ent || typeof ent !== 'object') continue;

    // Strip entity-level XData (Extended Data binary/handle blobs).
    // AcDbLibreDwgConverter only copies entity.xdata for DXF export and never uses it for 2D WebGL rendering.
    // Removing entity.xdata eliminates >60% of JSON bloat and BigInt/Uint8Array allocations on large drawings.
    if ('xdata' in ent) {
      delete ent.xdata;
    }

    if (typeof ent.elevation === 'number') {
      ent.elevation = 0;
    }

    switch (ent.type) {
      case 'LWPOLYLINE': {
        if (typeof ent.flag === 'number' && (ent.flag & 512) !== 0) {
          ent.flag |= 1;
        }
        break;
      }
      case 'POLYLINE2D':
      case 'POLYLINE3D': {
        const verts = ent.vertices;
        if (Array.isArray(verts) && verts.length > 0) {
          let hasNonControl = false;
          for (let vIdx = 0; vIdx < verts.length; vIdx++) {
            const v = verts[vIdx];
            if (v && ((v.flag ?? 0) & 16) === 0) {
              hasNonControl = true;
              break;
            }
          }
          for (let vIdx = 0; vIdx < verts.length; vIdx++) {
            const v = verts[vIdx];
            if (!v) continue;
            if (!hasNonControl && typeof v.flag === 'number') {
              v.flag &= ~16;
            }
            if (typeof v.z === 'number') v.z = 0;
            if (v.point && typeof v.point.z === 'number') v.point.z = 0;
          }
        }
        break;
      }
      case 'LINE': {
        if (ent.startPoint && typeof ent.startPoint.z === 'number') ent.startPoint.z = 0;
        if (ent.endPoint && typeof ent.endPoint.z === 'number') ent.endPoint.z = 0;
        break;
      }
      case 'SPLINE': {
        if (Array.isArray(ent.controlPoints)) {
          for (const pt of ent.controlPoints) {
            if (pt && typeof pt.z === 'number') pt.z = 0;
          }
        }
        if (Array.isArray(ent.fitPoints)) {
          for (const pt of ent.fitPoints) {
            if (pt && typeof pt.z === 'number') pt.z = 0;
          }
        }
        break;
      }
      case 'ARC':
      case 'CIRCLE':
      case 'ELLIPSE': {
        if (ent.center && typeof ent.center.z === 'number') ent.center.z = 0;
        break;
      }
      case 'INSERT': {
        if (ent.insertionPoint && typeof ent.insertionPoint.z === 'number') {
          ent.insertionPoint.z = 0;
        }
        if (Array.isArray(ent.attribs)) {
          for (const attr of ent.attribs) {
            normalizeInlineMTextFontCodes(attr);
          }
        }
        break;
      }
      case 'DIMENSION':
      case 'ARC_DIMENSION':
      case 'LARGE_RAD_DIMENSION': {
        normalizeInlineMTextFontCodes(ent);
        break;
      }
      case 'TEXT':
      case 'MTEXT': {
        if (ent.startPoint && typeof ent.startPoint.z === 'number') ent.startPoint.z = 0;
        if (ent.endPoint && typeof ent.endPoint.z === 'number') ent.endPoint.z = 0;
        if (ent.insertionPoint && typeof ent.insertionPoint.z === 'number') {
          ent.insertionPoint.z = 0;
        }
        normalizeInlineMTextFontCodes(ent);
        break;
      }
      case 'POINT': {
        if (ent.position && typeof ent.position.z === 'number') ent.position.z = 0;
        break;
      }
      default:
        break;
    }
  }
}

function normalizeDwgDatabaseFor2DPreview(db: any) {
  if (!db || typeof db !== 'object') return;

  // 1. Ensure non-plottable layers (plotFlag === 0) are still visible on screen
  const layerEntries = db.tables?.LAYER?.entries;
  if (Array.isArray(layerEntries)) {
    for (const layer of layerEntries) {
      if (layer && typeof layer === 'object') {
        layer.plotFlag = 1;
      }
    }
  }

  // 2. Normalize text styles: strip path/extension, fix bigfont hijacking, fallback to simplex
  normalizeStyleEntries(db.tables?.STYLE?.entries);

  // 3. Normalize Block table records and deduplicate top-level db.entities
  // LibreDWG's convertEx populates ModelSpace entities into BOTH db.entities AND
  // db.tables.BLOCK_RECORD.entries['*Model_Space'].entities, while AcDbLibreDwgConverter
  // ONLY reads db.tables.BLOCK_RECORD.entries. Clearing db.entities when *Model_Space
  // is present cuts serialized JSON & memory size in half (2x reduction).
  const blockEntries = db.tables?.BLOCK_RECORD?.entries;
  let hasModelSpaceBlockEntities = false;
  if (Array.isArray(blockEntries)) {
    for (const block of blockEntries) {
      if (block && Array.isArray(block.entities)) {
        normalizeEntityList(block.entities);
        const bName = String(block.name || '').toUpperCase();
        if (bName.includes('MODEL_SPACE') && block.entities.length > 0) {
          hasModelSpaceBlockEntities = true;
        }
      }
    }
  }

  if (hasModelSpaceBlockEntities) {
    db.entities = [];
  } else {
    normalizeEntityList(db.entities);
  }
}

let libreDwgInstancePromise: Promise<any> | null = null;

function getLibreDwgInstance() {
  if (!libreDwgInstancePromise) {
    libreDwgInstancePromise = LibreDwg.create('/wasm');
  }
  return libreDwgInstancePromise;
}

/**
 * Official @mlightcad/libredwg-converter Web Worker entry point
 * configured to load libredwg-web.wasm from the local /wasm directory.
 * Note: Gzip persistent caching (IndexedDB + .dwg.cache.gz file export/import)
 * is intercepted upstream in CachedLibreDwgConverter before worker invocation.
 */
class AcDbLibreDwgParserWorker extends AcDbBaseWorker<ArrayBuffer, unknown> {
  protected async executeTask(data: ArrayBuffer) {
    const instance = await getLibreDwgInstance();
    const dwg = instance.dwg_read_data(data, Dwg_File_Type.DWG);
    if (dwg == null) {
      throw new Error('LibreDWG 无法解析该 DWG 文件头或实体结构。');
    }
    const result = instance.convertEx(dwg);
    enrichStylesFromRawDwg(instance, dwg, result.database);
    instance.dwg_free(dwg);
    normalizeDwgDatabaseFor2DPreview(result.database);
    return {
      model: result.database,
      data: result.stats,
    };
  }
}

new AcDbLibreDwgParserWorker();


