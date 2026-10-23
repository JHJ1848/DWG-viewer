import {
  AcApDocManager,
  AcApSettingManager,
  AcEdOpenMode,
  AcApOpenViewMode,
} from '@mlightcad/cad-simple-viewer';
import { AcDbLibreDwgConverter } from '@mlightcad/libredwg-converter';
import {
  AcDbDatabaseConverterConfig,
  AcDbDatabaseConverterManager,
  AcDbFileType,
  AcDbParsingTaskResult,
  acdbHostApplicationServices,
} from '@mlightcad/data-model';
import { DwgDatabase } from '@mlightcad/libredwg-web';
import {
  extractFileNameFromUrl,
  formatByteSize,
  inspectDwgHeader,
  resolveMinioDwgUrl,
} from '../utils/dwgValidation';
import {
  detectGpuHardware,
  setupWebGlContextProtection,
  GpuHardwareInfo,
} from '../utils/webglCompatibility';
import {
  buildGzipCacheFileName,
  computeDwgFingerprint,
  createDwgStubBuffer,
  decompressGzipToEnvelope,
  DwgParseResultPayload,
  extractDwgStubToken,
  isGzipCacheFile,
  normalizeDwgFileNameForConverter,
} from '../utils/dwgGzipCache';
import {
  clearAllGzipCacheEntries,
  deleteGzipCacheEntry,
  getAndDecompressGzipCache,
  getRawGzipCacheRecord,
  listGzipCacheEntries,
  LocalGzipCacheMeta,
  saveDwgGzipCache,
  saveImportedGzipCache,
} from '../utils/dwgLocalCacheStore';

export type DwgStageId =
  | 'FETCH_OR_READ'
  | 'WASM_DECODE'
  | 'ENTITY_CONVERSION'
  | 'FONT_LAYOUT'
  | 'WEBGL_RENDER';

export interface DwgProgressNode {
  id: DwgStageId;
  step: number;
  title: string;
  status: 'pending' | 'active' | 'completed';
}

export interface DwgProgressState {
  isLoading: boolean;
  percent: number;
  currentStep: number;
  totalSteps: number;
  stageId: DwgStageId;
  stageTitle: string;
  stageDetail: string;
  elapsedMs: number;
  elapsedSeconds: string;
  fileSizeLabel?: string;
  nodes: DwgProgressNode[];
}

export type DwgCacheSourceType =
  | 'wasm-cold'
  | 'local-gzip-idb'
  | 'server-gzip-shared'
  | 'local-gzip-file';

export interface DwgCacheStatusInfo {
  source: DwgCacheSourceType;
  fingerprint: string;
  fileName: string;
  originalByteLength: number;
  rawJsonBytes: number;
  compressedBytes: number;
  compressionRatio: number;
  wasmParseMs: number;
  decompressMs: number;
  totalElapsedMs: number;
  entityCount: number;
  layerCount: number;
}

export interface DwgLoadedMeta {
  fileName: string;
  fileSizeLabel: string;
  versionLabel: string;
  sourceUrl?: string;
  cacheInfo?: DwgCacheStatusInfo;
}

export interface DwgViewerCallbacks {
  onProgress?: (state: DwgProgressState) => void;
  onLoaded?: (meta: DwgLoadedMeta) => void;
  onError?: (message: string) => void;
  onCacheListChanged?: (entries: LocalGzipCacheMeta[]) => void;
}

export interface LoadFromUrlOptions {
  /** Optional custom file name when URL does not end in .dwg */
  fileName?: string;
  /** Sa-Token credential string for MinIO Spring proxy */
  satoken?: string;
  /** Optional HTTP headers (e.g., satoken or Authorization Bearer token for Spring Boot / MinIO proxy) */
  headers?: Record<string, string>;
  /** Force bypass local Gzip cache and re-run WASM decoding */
  bypassCache?: boolean;
}

const DEFAULT_NODES: DwgProgressNode[] = [
  { id: 'FETCH_OR_READ', step: 1, title: '文件读取与校验', status: 'pending' },
  { id: 'WASM_DECODE', step: 2, title: 'WASM解码 / Gzip缓存', status: 'pending' },
  { id: 'ENTITY_CONVERSION', step: 3, title: 'CAD 图元模型构建', status: 'pending' },
  { id: 'FONT_LAYOUT', step: 4, title: '矢量字体与排版', status: 'pending' },
  { id: 'WEBGL_RENDER', step: 5, title: 'WebGL 视口呈现', status: 'pending' },
];

interface PendingParseContext {
  fileName: string;
  versionLabel: string;
  bypassCache?: boolean;
}

interface ConverterHooks {
  onStageUpdate: (stageId: DwgStageId, minPercent: number, detail: string) => void;
  onCacheResolved: (info: Omit<DwgCacheStatusInfo, 'totalElapsedMs'>) => void;
}

/**
 * Custom LibreDWG converter that intercepts `parse()` to support:
 * 1. Zero-WASM instant loading from pre-decompressed `.dwg.cache.gz` stub buffers.
 * 2. Local IndexedDB Gzip cache lookup (`DecompressionStream('gzip')`) before spawning Web Worker.
 * 3. Automatic Gzip compression (`CompressionStream('gzip')`) and local persistence after cold WASM parse.
 */
class CachedLibreDwgConverter extends AcDbLibreDwgConverter {
  private stubPayloads = new Map<string, DwgParseResultPayload<DwgDatabase>>();
  private pendingContext: PendingParseContext | null = null;
  private hooks: ConverterHooks;

  constructor(config: AcDbDatabaseConverterConfig, hooks: ConverterHooks) {
    super(config);
    this.hooks = hooks;
  }

  public setPendingContext(ctx: PendingParseContext | null): void {
    this.pendingContext = ctx;
  }

  public registerStubPayload(
    token: string,
    payload: DwgParseResultPayload<DwgDatabase>
  ): void {
    this.stubPayloads.set(token, payload);
  }

  protected override async parse(
    data: ArrayBuffer,
    timeout?: number
  ): Promise<AcDbParsingTaskResult<DwgDatabase>> {
    // 1. Check if this buffer is a 128-byte Stub Buffer bound to an already decompressed .dwg.cache.gz payload
    const stubToken = extractDwgStubToken(data);
    if (stubToken) {
      const injected = this.stubPayloads.get(stubToken);
      if (injected) {
        this.stubPayloads.delete(stubToken);
        this.hooks.onStageUpdate(
          'WASM_DECODE',
          52,
          '⚡ 已从 Gzip 压缩缓存直接注入 DwgDatabase 模型，0ms 跳过 WASM 解码...'
        );
        return injected as AcDbParsingTaskResult<DwgDatabase>;
      }
    }

    const ctx = this.pendingContext;
    const fileName = ctx?.fileName || 'drawing.dwg';
    const versionLabel = ctx?.versionLabel || 'AutoCAD DWG';
    const bypassCache = Boolean(ctx?.bypassCache);
    // IMPORTANT: Capture byteLength BEFORE super.parse(data) transfers and detaches the ArrayBuffer to Web Worker!
    const inputByteLength = data.byteLength;
    const fingerprint = computeDwgFingerprint(data);

    // 2. Query L1 (IndexedDB) + L2 (Server Shared Disk) Gzip Cache (unless user requested forced re-parse)
    if (!bypassCache) {
      const hit = await getAndDecompressGzipCache(fingerprint);
      if (hit && hit.payload && hit.payload.model) {
        const ratioPct = Math.round(hit.meta.compressionRatio * 100);
        const isServerHit = hit.hitLayer === 'server-shared';
        this.hooks.onStageUpdate(
          'WASM_DECODE',
          54,
          `⚡ 命中${isServerHit ? '服务端共享' : '本机浏览器'} Gzip 缓存 (${formatByteSize(hit.meta.compressedBytes)}, 压缩率 ${ratioPct}%)，流式解压耗时 ${hit.decompressMs}ms，已跳过 WASM 解码！`
        );
        this.hooks.onCacheResolved({
          source: isServerHit ? 'server-gzip-shared' : 'local-gzip-idb',
          fingerprint,
          fileName: hit.meta.fileName || fileName,
          originalByteLength: hit.meta.originalByteLength || inputByteLength,
          rawJsonBytes: hit.meta.rawJsonBytes,
          compressedBytes: hit.meta.compressedBytes,
          compressionRatio: hit.meta.compressionRatio,
          wasmParseMs: hit.meta.wasmParseMs,
          decompressMs: hit.decompressMs,
          entityCount: hit.meta.entityCount,
          layerCount: hit.meta.layerCount,
        });
        return hit.payload as AcDbParsingTaskResult<DwgDatabase>;
      }
    }

    // 3. Cache miss -> Execute LibreDWG WebAssembly Worker decode
    this.hooks.onStageUpdate(
      'WASM_DECODE',
      22,
      `未命中本地缓存，正在执行 LibreDWG WASM 二进制解码 (${formatByteSize(inputByteLength)})...`
    );
    const parseStart = performance.now();
    const parsedResult = await super.parse(data, timeout);
    const wasmParseMs = Math.max(1, Math.round(performance.now() - parseStart));

    // 4. Compress intermediate result to Gzip (.dwg.cache.gz) and persist in IndexedDB
    this.hooks.onStageUpdate(
      'WASM_DECODE',
      50,
      `WASM 解码完成 (${(wasmParseMs / 1000).toFixed(1)}s)，正在通过 CompressionStream('gzip') 压缩并保存本地缓存...`
    );

    try {
      const record = await saveDwgGzipCache({
        fingerprint,
        fileName,
        originalByteLength: inputByteLength,
        versionLabel,
        wasmParseMs,
        payload: parsedResult as DwgParseResultPayload,
      });

      this.hooks.onCacheResolved({
        source: 'wasm-cold',
        fingerprint: record.fingerprint,
        fileName: record.fileName,
        originalByteLength: record.originalByteLength,
        rawJsonBytes: record.rawJsonBytes,
        compressedBytes: record.compressedBytes,
        compressionRatio: record.compressionRatio,
        wasmParseMs,
        decompressMs: 0,
        entityCount: record.entityCount,
        layerCount: record.layerCount,
      });
    } catch (err) {
      console.warn('[CachedLibreDwgConverter] Failed to save Gzip cache:', err);
    }

    return parsedResult;
  }
}

/**
 * Manages smooth step-based progress interpolation especially for large DWG files (e.g. 50MB taking 15~30s)
 */
class ProgressTracker {
  private currentStage: DwgStageId = 'FETCH_OR_READ';
  private targetPercent = 5;
  private currentPercent = 0;
  private timer: any = null;
  private startTime = 0;
  private fileSizeLabel = '';
  private lastCustomDetail = '';
  private onUpdate: (state: DwgProgressState) => void;

  constructor(onUpdate: (state: DwgProgressState) => void) {
    this.onUpdate = onUpdate;
  }

  public start(fileSizeLabel = '') {
    this.stop();
    this.startTime = Date.now();
    this.fileSizeLabel = fileSizeLabel;
    this.currentPercent = 3;
    this.lastCustomDetail = '';
    this.setStage('FETCH_OR_READ', 5, '正在读取二进制字节流...');

    this.timer = setInterval(() => {
      this.tick();
    }, 100);
  }

  public getElapsedMs(): number {
    return this.startTime ? Math.max(1, Date.now() - this.startTime) : 0;
  }

  public setStage(stageId: DwgStageId, minPercent: number, detail: string) {
    this.currentStage = stageId;
    this.targetPercent = Math.max(this.targetPercent, minPercent);
    this.lastCustomDetail = detail;
    this.tick(detail);
  }

  public advanceTarget(targetPct: number, detail?: string) {
    this.targetPercent = Math.max(this.targetPercent, Math.min(99, targetPct));
    if (detail) {
      this.lastCustomDetail = detail;
      this.tick(detail);
    }
  }

  public finish() {
    this.currentPercent = 100;
    this.targetPercent = 100;
    this.setStage('WEBGL_RENDER', 100, '图纸解析渲染完成');
    this.emit(false);
    this.stop();
  }

  public error() {
    this.stop();
    this.emit(false);
  }

  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(customDetail?: string) {
    if (this.currentPercent < this.targetPercent) {
      const step = Math.max(0.4, (this.targetPercent - this.currentPercent) * 0.18);
      this.currentPercent = Math.min(
        this.targetPercent,
        +(this.currentPercent + step).toFixed(1)
      );
    } else if (this.currentStage === 'WASM_DECODE' && this.currentPercent < 55) {
      this.currentPercent = +(this.currentPercent + 0.15).toFixed(1);
    } else if (this.currentStage === 'ENTITY_CONVERSION' && this.currentPercent < 78) {
      this.currentPercent = +(this.currentPercent + 0.18).toFixed(1);
    }

    this.emit(true, customDetail || this.lastCustomDetail);
  }

  private emit(isLoading: boolean, customDetail?: string) {
    const elapsedMs = this.startTime ? Date.now() - this.startTime : 0;
    const elapsedSeconds = `${(elapsedMs / 1000).toFixed(1)}s`;

    let stepNum = 1;
    let stageTitle = '文件读取与校验';
    let defaultDetail = '正在读取文件字节流...';

    switch (this.currentStage) {
      case 'FETCH_OR_READ':
        stepNum = 1;
        stageTitle = '文件读取与校验';
        defaultDetail = `正在加载文件${this.fileSizeLabel ? ` (${this.fileSizeLabel})` : ''}并校验头部签名...`;
        break;
      case 'WASM_DECODE':
        stepNum = 2;
        stageTitle = 'WASM解码 / Gzip缓存';
        defaultDetail = `正在检索本地 Gzip 缓存或执行 LibreDWG WASM 二进制解码...`;
        break;
      case 'ENTITY_CONVERSION':
        stepNum = 3;
        stageTitle = 'CAD 图元模型构建';
        defaultDetail = `正在批量构建图元实体树、块表记录与图层数据 (Batch Chunk=5000)...`;
        break;
      case 'FONT_LAYOUT':
        stepNum = 4;
        stageTitle = '矢量字体与排版';
        defaultDetail = `正在匹配加载 CAD SHX 矢量字库并排版 MText 文字网格...`;
        break;
      case 'WEBGL_RENDER':
        stepNum = 5;
        stageTitle = 'WebGL 视口呈现';
        defaultDetail = isLoading
          ? `正在计算智能聚簇居中并初始化 2D 正交视口...`
          : `图纸已就绪`;
        break;
    }

    const nodes: DwgProgressNode[] = DEFAULT_NODES.map((node) => {
      let status: 'pending' | 'active' | 'completed' = 'pending';
      if (node.step < stepNum) {
        status = 'completed';
      } else if (node.step === stepNum) {
        status = isLoading ? 'active' : 'completed';
      }
      return { ...node, status };
    });

    this.onUpdate({
      isLoading,
      percent: Math.min(100, Math.round(this.currentPercent)),
      currentStep: stepNum,
      totalSteps: 5,
      stageId: this.currentStage,
      stageTitle,
      stageDetail: customDetail || defaultDetail,
      elapsedMs,
      elapsedSeconds,
      fileSizeLabel: this.fileSizeLabel,
      nodes,
    });
  }
}

/**
 * Clears legacy uncompressed caches in IndexedDB so only the new Gzip cache store is kept.
 */
function cleanLegacyFontCache() {
  if (typeof indexedDB === 'undefined') return;
  const dbNamesToClean = [
    'mlightcad_fonts',
    'mlightcad_font_cache',
    'cad_font_cache',
    'cadlight_dwg_cache_v1',
    'cadlight_dwg_cache_v2',
    'cadlight_dwg_cache_v3',
    'cadlight_dwg_cache_v4',
    'cadlight_dwg_cache_v5',
    'cadlight_dwg_cache_v6',
  ];
  for (const name of dbNamesToClean) {
    try {
      indexedDB.deleteDatabase(name);
    } catch {
      // ignore
    }
  }
}

/**
 * Framework-agnostic DWG WebGL Viewer Engine with built-in Local Gzip Cache (.dwg.cache.gz).
 */
export class DwgViewerEngine {
  private callbacks: DwgViewerCallbacks;
  private tracker: ProgressTracker;
  private mounted = false;
  private gpuInfo: GpuHardwareInfo = detectGpuHardware();
  private unmountProtection: (() => void) | null = null;
  private converter: CachedLibreDwgConverter | null = null;
  private lastResolvedCache: Omit<DwgCacheStatusInfo, 'totalElapsedMs'> | null = null;
  private currentFingerprint: string | null = null;

  constructor(callbacks: DwgViewerCallbacks = {}) {
    this.callbacks = callbacks;
    this.tracker = new ProgressTracker((state) => {
      this.callbacks.onProgress?.(state);
    });
  }

  public getGpuInfo(): GpuHardwareInfo {
    return this.gpuInfo;
  }

  public getCurrentFingerprint(): string | null {
    return this.currentFingerprint;
  }

  /**
   * Refreshes and emits the list of locally cached Gzip drawings.
   */
  public async refreshCacheList(): Promise<LocalGzipCacheMeta[]> {
    const entries = await listGzipCacheEntries();
    this.callbacks.onCacheListChanged?.(entries);
    return entries;
  }

  /**
   * Mounts the WebGL CAD viewport into the target DOM element.
   */
  public mount(container: HTMLElement): void {
    if (this.mounted) return;
    this.mounted = true;
    cleanLegacyFontCache();

    AcApSettingManager.instance.apply(
      {
        isShowCommandLine: false,
        isShowShortCutToolbar: false,
        fontMapping: {
          '*': 'simplex',
          txt: 'simplex',
          TXT: 'simplex',
          simplex: 'simplex',
          SIMPLEX: 'simplex',
          romans: 'simplex',
          ROMANS: 'simplex',
          standard: 'simplex',
          Standard: 'simplex',
          STANDARD: 'simplex',
          arial: 'simplex',
          Arial: 'simplex',
          times: 'simplex',
          Times: 'simplex',
        },
      },
      { persist: false }
    );

    const parserWorkerUrl = new URL(
      '../workers/libredwgParserWorker.ts',
      import.meta.url
    ).href;

    this.converter = new CachedLibreDwgConverter(
      {
        parserWorkerUrl,
        timeout: 180000,
      },
      {
        onStageUpdate: (stageId, minPct, detail) => {
          this.tracker.setStage(stageId, minPct, detail);
        },
        onCacheResolved: (info) => {
          this.lastResolvedCache = info;
          this.currentFingerprint = info.fingerprint;
        },
      }
    );
    AcDbDatabaseConverterManager.instance.register(AcDbFileType.DWG, this.converter);

    const docManager = AcApDocManager.createInstance({
      container,
      busyIndicatorHost: container,
      autoResize: true,
      baseUrl: `${window.location.origin}/`,
      preloadDefaultFonts: false,
      useMainThreadDraw: false,
      builtinOpenFileDialog: false,
      notificationCenter: false,
      webworkerFileUrls: {
        dwgParser: parserWorkerUrl,
        mtextRender: `${window.location.origin}/workers/mtext-renderer-worker.js`,
      },
    });

    if (!docManager) return;
    (window as any).__cadDocManager = docManager;

    const bindProgressEvents = () => {
      const doc = docManager.curDocument;
      if (!doc) return;
      doc.database.events.openProgress.addEventListener((args: any) => {
        const pct = Math.min(99, Math.max(10, Math.round(args.percentage || 0)));
        const stageStr = String(args.stage);
        if (stageStr === 'PARSE') {
          this.tracker.setStage(
            'WASM_DECODE',
            Math.max(20, Math.min(55, pct)),
            '正在检索本地 Gzip 缓存或调用 LibreDWG WASM 解算...'
          );
        } else if (stageStr === 'CONVERSION') {
          const detail = args.subStage
            ? `正在批量构建图元实体索引 (${args.subStage})...`
            : '正在构建图层表与图元实体模型树...';
          this.tracker.setStage(
            'ENTITY_CONVERSION',
            Math.max(55, Math.min(82, pct)),
            detail
          );
        } else if (stageStr === 'FONT') {
          this.tracker.setStage(
            'FONT_LAYOUT',
            Math.max(82, Math.min(92, pct)),
            '正在加载匹配 CAD SHX 矢量字库与排版文本...'
          );
        }
      });
    };

    bindProgressEvents();
    docManager.events.documentActivated.addEventListener(() => {
      bindProgressEvents();
      this.configureInteractiveView();
    });

    this.unmountProtection = setupWebGlContextProtection(container, () => {
      const activeDoc = docManager.curDocument;
      if (activeDoc) {
        docManager.regen();
      }
    });

    void this.refreshCacheList();
  }

  /**
   * Destroys engine event listeners and context protections.
   */
  public destroy(): void {
    if (this.unmountProtection) {
      this.unmountProtection();
      this.unmountProtection = null;
    }
  }

  /**
   * Downloads a DWG or .dwg.cache.gz stream from a URL and renders it.
   */
  public async loadFromUrl(
    rawUrl: string,
    options: LoadFromUrlOptions = {}
  ): Promise<boolean> {
    const trimmedUrl = (rawUrl || '').trim();
    if (!trimmedUrl) {
      this.callbacks.onError?.('请输入有效的 DWG 或 .dwg.cache.gz 文件地址');
      return false;
    }

    const resolvedUrl = resolveMinioDwgUrl(trimmedUrl);
    const fileName = options.fileName || extractFileNameFromUrl(resolvedUrl);
    this.tracker.start();
    this.tracker.setStage(
      'FETCH_OR_READ',
      5,
      `正在从远程或本地静态源拉取 ${fileName}...`
    );

    try {
      const headers: Record<string, string> = { ...(options.headers || {}) };
      if (options.satoken) {
        headers['satoken'] = options.satoken;
      }

      const response = await fetch(resolvedUrl, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        throw new Error(
          `文件读取失败 (HTTP ${response.status} ${response.statusText}) — 当前为 AI Studio 独立环境，如需测试本地 Gzip 缓存可直接切换顶部内置样图或上传本地 .dwg / .dwg.cache.gz 文件`
        );
      }

      const contentLength = Number(response.headers.get('content-length')) || 0;
      let buffer: ArrayBuffer;

      if (response.body && contentLength > 0) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.length;
            const pct = Math.min(
              15,
              Math.max(5, Math.round((received / contentLength) * 15))
            );
            this.tracker.setStage(
              'FETCH_OR_READ',
              pct,
              `读取数据流: ${formatByteSize(received)} / ${formatByteSize(contentLength)}...`
            );
          }
        }
        const fullBuffer = new Uint8Array(received);
        let pos = 0;
        for (const c of chunks) {
          fullBuffer.set(c, pos);
          pos += c.length;
        }
        buffer = fullBuffer.buffer;
      } else {
        buffer = await response.arrayBuffer();
      }

      return await this.loadFromBuffer(fileName, buffer, resolvedUrl, options.bypassCache);
    } catch (err: any) {
      const msg = err?.message || `无法从地址加载图纸: ${trimmedUrl}`;
      this.tracker.error();
      this.callbacks.onError?.(msg);
      return false;
    }
  }

  /**
   * Parses and renders a DWG binary ArrayBuffer (or auto-detected .dwg.cache.gz buffer) in the viewport.
   */
  public async loadFromBuffer(
    fileName: string,
    buffer: ArrayBuffer,
    sourceUrl?: string,
    bypassCache = false
  ): Promise<boolean> {
    // Auto-detect if the buffer or fileName is a Gzip-compressed cache file (.dwg.cache.gz)
    if (isGzipCacheFile(fileName, buffer)) {
      return this.loadFromGzipCacheBuffer(fileName, buffer, sourceUrl);
    }

    const docManager = AcApDocManager.tryGetInstance();
    if (!docManager || !this.converter) {
      this.tracker.error();
      this.callbacks.onError?.('预览引擎尚未完成初始化');
      return false;
    }

    const fileSizeLabel = formatByteSize(buffer.byteLength);
    this.tracker.start(fileSizeLabel);
    this.tracker.setStage(
      'FETCH_OR_READ',
      12,
      `读取文件 ${fileName} (${fileSizeLabel})，校验 DWG 文件头标识...`
    );

    const headerInfo = inspectDwgHeader(buffer);
    if (!headerInfo.isDwg) {
      this.tracker.error();
      this.callbacks.onError?.(
        `文件头校验失败 (${headerInfo.versionLabel})：请确认文件为真实的 AutoCAD .dwg 图纸或 .dwg.cache.gz 压缩缓存文件`
      );
      return false;
    }

    this.lastResolvedCache = null;
    const cleanDwgName = normalizeDwgFileNameForConverter(fileName);
    this.converter.setPendingContext({
      fileName: cleanDwgName,
      versionLabel: headerInfo.versionLabel,
      bypassCache,
    });

    try {
      const ok = await docManager.openDocument(cleanDwgName, buffer, {
        mode: AcEdOpenMode.Read,
        openViewMode: AcApOpenViewMode.Extents,
        progressiveRendering: false,
        cooperativeYield: false,
        skipSpatialIndex: false,
        minimumChunkSize: 5000,
      } as any);

      if (!ok) {
        throw new Error(`无法解析 ${cleanDwgName}，请检查 DWG 图纸版本或数据完整性`);
      }

      this.tracker.setStage(
        'WEBGL_RENDER',
        95,
        '计算智能聚簇居中，构建 WebGL 视口呈现...'
      );
      this.ensureModelSpaceActive();
      this.configureInteractiveView();
      await this.fitToView();

      const totalElapsedMs = this.tracker.getElapsedMs();
      this.tracker.finish();

      const resolvedCache = this.lastResolvedCache as Omit<
        DwgCacheStatusInfo,
        'totalElapsedMs'
      > | null;
      const cacheInfo: DwgCacheStatusInfo | undefined = resolvedCache
        ? {
            ...resolvedCache,
            totalElapsedMs,
          }
        : undefined;

      this.callbacks.onLoaded?.({
        fileName: cleanDwgName,
        fileSizeLabel,
        versionLabel: headerInfo.versionLabel,
        sourceUrl,
        cacheInfo,
      });

      void this.refreshCacheList();
      return true;
    } catch (err: any) {
      this.tracker.error();
      this.callbacks.onError?.(err?.message || `解析 ${fileName} 失败`);
      return false;
    } finally {
      this.converter.setPendingContext(null);
    }
  }

  /**
   * Directly opens a `.dwg.cache.gz` Gzip-compressed intermediate cache file
   * without needing the original `.dwg` file or executing LibreDWG WebAssembly.
   */
  public async loadFromGzipCacheBuffer(
    fileName: string,
    gzBuffer: ArrayBuffer,
    sourceUrl?: string
  ): Promise<boolean> {
    const docManager = AcApDocManager.tryGetInstance();
    if (!docManager || !this.converter) {
      this.tracker.error();
      this.callbacks.onError?.('预览引擎尚未完成初始化');
      return false;
    }

    const gzSizeLabel = formatByteSize(gzBuffer.byteLength);
    this.tracker.start(gzSizeLabel);
    this.tracker.setStage(
      'WASM_DECODE',
      25,
      `正在通过 DecompressionStream('gzip') 解压本地缓存文件 ${fileName} (${gzSizeLabel})...`
    );

    try {
      const t0 = performance.now();
      const envelope = await decompressGzipToEnvelope(gzBuffer);
      const decompressMs = Math.max(1, Math.round(performance.now() - t0));

      const gzBytes = new Uint8Array(gzBuffer);
      const savedRecord = await saveImportedGzipCache(gzBytes, envelope);
      this.currentFingerprint = savedRecord.fingerprint;

      const cleanDwgName = normalizeDwgFileNameForConverter(
        envelope.fileName || fileName
      );
      const stubToken = `gzip_file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.converter.registerStubPayload(stubToken, envelope.payload);
      const stubBuffer = createDwgStubBuffer(stubToken);

      this.tracker.setStage(
        'ENTITY_CONVERSION',
        55,
        `⚡ Gzip 解压完成 (耗时 ${decompressMs}ms)，0ms 跳过 WASM，正在构建 CAD 图元模型...`
      );

      const ok = await docManager.openDocument(cleanDwgName, stubBuffer, {
        mode: AcEdOpenMode.Read,
        openViewMode: AcApOpenViewMode.Extents,
        progressiveRendering: false,
        cooperativeYield: false,
        skipSpatialIndex: false,
        minimumChunkSize: 5000,
      } as any);

      if (!ok) {
        throw new Error(`无法从 Gzip 缓存文件 ${fileName} 构建图纸模型`);
      }

      this.tracker.setStage(
        'WEBGL_RENDER',
        95,
        '计算智能聚簇居中，构建 WebGL 视口呈现...'
      );
      this.ensureModelSpaceActive();
      this.configureInteractiveView();
      await this.fitToView();

      const totalElapsedMs = this.tracker.getElapsedMs();
      this.tracker.finish();

      const cacheInfo: DwgCacheStatusInfo = {
        source: 'local-gzip-file',
        fingerprint: savedRecord.fingerprint,
        fileName: cleanDwgName,
        originalByteLength: savedRecord.originalByteLength,
        rawJsonBytes: savedRecord.rawJsonBytes,
        compressedBytes: savedRecord.compressedBytes,
        compressionRatio: savedRecord.compressionRatio,
        wasmParseMs: savedRecord.wasmParseMs,
        decompressMs,
        totalElapsedMs,
        entityCount: savedRecord.entityCount,
        layerCount: savedRecord.layerCount,
      };

      this.callbacks.onLoaded?.({
        fileName: cleanDwgName,
        fileSizeLabel: `${formatByteSize(savedRecord.originalByteLength)} (Gzip: ${gzSizeLabel})`,
        versionLabel: savedRecord.versionLabel,
        sourceUrl,
        cacheInfo,
      });

      void this.refreshCacheList();
      return true;
    } catch (err: any) {
      this.tracker.error();
      this.callbacks.onError?.(
        err?.message || `解压或加载 Gzip 缓存文件 ${fileName} 失败`
      );
      return false;
    }
  }

  /**
   * Opens a drawing directly from the local IndexedDB Gzip cache store by its fingerprint
   * without needing to re-upload or re-fetch the original .dwg file.
   */
  public async loadFromCachedFingerprint(fingerprint: string): Promise<boolean> {
    const docManager = AcApDocManager.tryGetInstance();
    if (!docManager || !this.converter) {
      this.callbacks.onError?.('预览引擎尚未完成初始化');
      return false;
    }

    this.tracker.start();
    this.tracker.setStage(
      'WASM_DECODE',
      25,
      '正在从浏览器本地 Gzip 缓存库读取并流式解压图纸...'
    );

    try {
      const hit = await getAndDecompressGzipCache(fingerprint);
      if (!hit || !hit.payload?.model) {
        throw new Error('该本地 Gzip 缓存记录不存在或已过期');
      }

      this.currentFingerprint = hit.meta.fingerprint;
      const cleanDwgName = normalizeDwgFileNameForConverter(hit.meta.fileName);
      const stubToken = `idb_hit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.converter.registerStubPayload(stubToken, hit.payload);
      const stubBuffer = createDwgStubBuffer(stubToken);

      this.tracker.setStage(
        'ENTITY_CONVERSION',
        55,
        `⚡ 本地 Gzip 缓存解压完成 (${hit.decompressMs}ms)，正在构建 ${hit.meta.entityCount} 个图元...`
      );

      const ok = await docManager.openDocument(cleanDwgName, stubBuffer, {
        mode: AcEdOpenMode.Read,
        openViewMode: AcApOpenViewMode.Extents,
        progressiveRendering: false,
        cooperativeYield: false,
        skipSpatialIndex: false,
        minimumChunkSize: 5000,
      } as any);

      if (!ok) {
        throw new Error(`无法从缓存渲染图纸 ${cleanDwgName}`);
      }

      this.tracker.setStage(
        'WEBGL_RENDER',
        95,
        '计算智能聚簇居中，构建 WebGL 视口呈现...'
      );
      this.ensureModelSpaceActive();
      this.configureInteractiveView();
      await this.fitToView();

      const totalElapsedMs = this.tracker.getElapsedMs();
      this.tracker.finish();

      const cacheInfo: DwgCacheStatusInfo = {
        source:
          hit.hitLayer === 'server-shared' ? 'server-gzip-shared' : 'local-gzip-idb',
        fingerprint: hit.meta.fingerprint,
        fileName: cleanDwgName,
        originalByteLength: hit.meta.originalByteLength,
        rawJsonBytes: hit.meta.rawJsonBytes,
        compressedBytes: hit.meta.compressedBytes,
        compressionRatio: hit.meta.compressionRatio,
        wasmParseMs: hit.meta.wasmParseMs,
        decompressMs: hit.decompressMs,
        totalElapsedMs,
        entityCount: hit.meta.entityCount,
        layerCount: hit.meta.layerCount,
      };

      this.callbacks.onLoaded?.({
        fileName: cleanDwgName,
        fileSizeLabel: formatByteSize(hit.meta.originalByteLength),
        versionLabel: hit.meta.versionLabel,
        cacheInfo,
      });

      void this.refreshCacheList();
      return true;
    } catch (err: any) {
      this.tracker.error();
      this.callbacks.onError?.(err?.message || '从本地 Gzip 缓存加载失败');
      return false;
    }
  }

  /**
   * Exports the `.dwg.cache.gz` binary file for a specific fingerprint (or the currently active drawing).
   */
  public async exportGzipCacheFile(
    targetFingerprint?: string
  ): Promise<{ exportFileName: string; gzBytes: Uint8Array; meta: LocalGzipCacheMeta } | null> {
    const fp = targetFingerprint || this.currentFingerprint;
    if (!fp) return null;

    const record = await getRawGzipCacheRecord(fp);
    if (!record || !record.gzBytes) return null;

    const { gzBytes, ...meta } = record;
    return {
      exportFileName: buildGzipCacheFileName(record.fileName),
      gzBytes,
      meta,
    };
  }

  /**
   * Deletes a single local Gzip cache entry by fingerprint and refreshes the cache list.
   */
  public async removeCacheEntry(fingerprint: string): Promise<LocalGzipCacheMeta[]> {
    await deleteGzipCacheEntry(fingerprint);
    return this.refreshCacheList();
  }

  /**
   * Clears all local Gzip cache entries and refreshes the cache list.
   */
  public async clearAllCache(): Promise<LocalGzipCacheMeta[]> {
    await clearAllGzipCacheEntries();
    return this.refreshCacheList();
  }

  /**
   * Automatically switches from an empty Paper Space layout to Model Space
   * if the DWG was saved on an unpopulated layout tab.
   */
  private ensureModelSpaceActive(): void {
    const docManager = AcApDocManager.tryGetInstance();
    if (!docManager) return;
    (window as any).__cadDocManager = docManager;

    const db = docManager.curDocument.database;
    const blockTable = db.tables.blockTable;
    const modelSpace = blockTable.modelSpace;
    const modelId = modelSpace.objectId;
    const modelEntityCount = modelSpace ? modelSpace.newIterator().count : 0;

    const activeBtr = db.currentSpaceId || modelId;
    if (activeBtr !== modelId) {
      const currentPaperBtr = blockTable.getIdAt(activeBtr);
      const currentPaperCount = currentPaperBtr ? currentPaperBtr.newIterator().count : 0;
      if (currentPaperCount < 5 && modelEntityCount > currentPaperCount) {
        try {
          acdbHostApplicationServices().layoutManager.setCurrentLayoutBtrId(modelId, db);
        } catch {
          // Ignore if layout switch is not needed
        }
      }
    }
  }

  /**
   * Centers and fits the drawing in the viewport (automatically ignoring stray outlier points).
   */
  public async fitToView(): Promise<void> {
    const docManager = AcApDocManager.tryGetInstance();
    if (!docManager) return;
    (window as any).__cadDocManager = docManager;
    try {
      await docManager.curView.zoomToSmartExtents(15000);
      const smartBox = await (docManager.curView as any).resolveSmartFitBox?.();
      if (smartBox && !smartBox.isEmpty?.()) {
        docManager.curView.zoomTo(smartBox, 1.08);
      }
    } catch {
      try {
        docManager.curView.zoomToFitDrawing();
      } catch {
        // Ignore if view is not yet ready
      }
    }
  }

  /**
   * Configures CAD viewport interactive behavior:
   * Enables entity hover-highlight, sets optimal pick tolerance, and reduces hover response latency.
   */
  public configureInteractiveView(): void {
    const docManager = AcApDocManager.tryGetInstance();
    if (!docManager) return;
    (window as any).__cadDocManager = docManager;
    const view = docManager.curView;
    if (!view) return;

    view.entitySelectionEnabled = true;
    (view as any).mode = 0; // AcEdViewMode.SELECTION
    view.selectionBoxSize = 6;

    const hoverCtrl = (view as any)._hoverController;
    if (hoverCtrl) {
      hoverCtrl.hoverDelay = 80;
      hoverCtrl.pauseDelay = 100;
    }
  }
}
