import parserWorkerUrl from '../workers/libredwgParserWorker.ts?worker&url';
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
  findGzipCacheByFileName,
  getAndDecompressGzipCache,
  getRawGzipCacheRecord,
  listGzipCacheEntries,
  LocalGzipCacheMeta,
  saveDwgGzipCache,
  saveImportedGzipCache,
} from '../utils/dwgLocalCacheStore';
import {
  calculateAdaptiveChunkSize,
  getDeviceMemoryProfile,
  DeviceMemoryProfile,
} from '../utils/deviceProfile';

export type DwgPipelineMode = 'detecting' | 'gzip_cache' | 'dwg_full_parse';

/**
 * [09_viewport_interaction] 视口交互模式枚举（对齐 @mlightcad/cad-simple-viewer 底层 AcEdViewMode）
 */
export enum AcEdViewMode {
  SELECTION = 0,
  PAN = 1,
}

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
  pipelineMode: DwgPipelineMode;
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
  /** Optional custom HTTP headers */
  headers?: Record<string, string>;
  /** Force bypass local Gzip cache and re-run WASM decoding */
  bypassCache?: boolean;
}

export const DETECTING_NODES: DwgProgressNode[] = [
  { id: 'FETCH_OR_READ', step: 1, title: '文件读取与校验', status: 'pending' },
  { id: 'WASM_DECODE', step: 2, title: '图纸解码', status: 'pending' },
  { id: 'ENTITY_CONVERSION', step: 3, title: '图元模型构建', status: 'pending' },
  { id: 'FONT_LAYOUT', step: 4, title: '文字排版与样式', status: 'pending' },
  { id: 'WEBGL_RENDER', step: 5, title: '视口渲染呈现', status: 'pending' },
];

export const GZIP_CACHE_NODES: DwgProgressNode[] = [
  { id: 'FETCH_OR_READ', step: 1, title: '文件读取与校验', status: 'pending' },
  { id: 'WASM_DECODE', step: 2, title: '缓存流式解压', status: 'pending' },
  { id: 'ENTITY_CONVERSION', step: 3, title: '图元模型构建', status: 'pending' },
  { id: 'FONT_LAYOUT', step: 4, title: '文字排版与样式', status: 'pending' },
  { id: 'WEBGL_RENDER', step: 5, title: '视口渲染呈现', status: 'pending' },
];

export const DWG_FULL_PARSE_NODES: DwgProgressNode[] = [
  { id: 'FETCH_OR_READ', step: 1, title: '文件读取与校验', status: 'pending' },
  { id: 'WASM_DECODE', step: 2, title: '图纸核心解码', status: 'pending' },
  { id: 'ENTITY_CONVERSION', step: 3, title: '图元模型构建', status: 'pending' },
  { id: 'FONT_LAYOUT', step: 4, title: '文字排版与样式', status: 'pending' },
  { id: 'WEBGL_RENDER', step: 5, title: '视口渲染呈现', status: 'pending' },
];

export const DEFAULT_NODES: DwgProgressNode[] = DETECTING_NODES;

export { calculateAdaptiveChunkSize } from '../utils/deviceProfile';

interface PendingParseContext {
  fileName: string;
  versionLabel: string;
  bypassCache?: boolean;
}

interface ConverterHooks {
  onStageUpdate: (stageId: DwgStageId, minPercent: number, detail: string) => void;
  onCacheResolved: (info: Omit<DwgCacheStatusInfo, 'totalElapsedMs'>) => void;
  getProfile?: () => DeviceMemoryProfile;
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
  private tracker: ProgressTracker;

  constructor(
    config: AcDbDatabaseConverterConfig,
    hooks: ConverterHooks,
    tracker: ProgressTracker
  ) {
    super(config);
    this.hooks = hooks;
    this.tracker = tracker;
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
        this.tracker.setPipelineMode('gzip_cache');
        this.hooks.onStageUpdate(
          'WASM_DECODE',
          52,
          '已从图纸缓存载入模型数据...'
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
      const currentProfile = this.hooks.getProfile?.();
      const hit = await getAndDecompressGzipCache(
        fingerprint,
        (pct, detail) => {
          this.hooks.onStageUpdate('WASM_DECODE', pct, detail);
        },
        currentProfile
      );
      if (hit && hit.payload && hit.payload.model) {
        const ratioPct = Math.round(hit.meta.compressionRatio * 100);
        const isServerHit = hit.hitLayer === 'server-shared';
        this.tracker.setPipelineMode('gzip_cache');
        this.hooks.onStageUpdate(
          'WASM_DECODE',
          54,
          `已命中${isServerHit ? '服务端共享' : '本地'}缓存 (${formatByteSize(hit.meta.compressedBytes)})，解压耗时 ${hit.decompressMs}ms`
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
    this.tracker.setPipelineMode('dwg_full_parse');
    this.hooks.onStageUpdate(
      'WASM_DECODE',
      22,
      `正在解析图纸二进制结构 (${formatByteSize(inputByteLength)})...`
    );
    const parseStart = performance.now();
    const parsedResult = await super.parse(data, timeout);
    const wasmParseMs = Math.max(1, Math.round(performance.now() - parseStart));

    // 4. Asynchronous decoupled Gzip cache persistence:
    // =========================================================================
    // CRITICAL PERFORMANCE SAFEGUARD - NEVER AWAIT GZIP COMPRESSION IN RENDERING PATH:
    //
    // For large drawings (50MB+ DWG, ~200MB JSON), Gzip serialization and compression
    // takes 1.5~3 seconds of intensive CPU work.
    // If we await saveDwgGzipCache() here synchronously, the user is forced to wait for
    // Gzip compression before entity conversion and WebGL rendering can even start!
    //
    // Instead, we immediately return parsedResult to hand over the CAD database model
    // to openDocument() for immediate rendering, and dispatch saveDwgGzipCache() to run
    // in the background via setTimeout(..., 50) without blocking the rendering pipeline.
    // =========================================================================
    this.hooks.onStageUpdate(
      'ENTITY_CONVERSION',
      52,
      `图纸解码完成 (${(wasmParseMs / 1000).toFixed(1)}s)，正在构建渲染模型...`
    );

    setTimeout(() => {
      void (async () => {
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
          console.warn('[CachedLibreDwgConverter] Background Gzip cache persistence failed:', err);
        }
      })();
    }, 50);

    return parsedResult;
  }
}

/**
 * Manages smooth step-based progress interpolation especially for large DWG files (e.g. 50MB taking 15~30s)
 */
class ProgressTracker {
  private currentStage: DwgStageId = 'FETCH_OR_READ';
  private pipelineMode: DwgPipelineMode = 'detecting';
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

  public setPipelineMode(mode: DwgPipelineMode): void {
    if (!this.timer) return;
    this.pipelineMode = mode;
    this.emit(true, this.lastCustomDetail);
  }

  public getPipelineMode(): DwgPipelineMode {
    return this.pipelineMode;
  }

  public start(fileSizeLabel = '', mode: DwgPipelineMode = 'detecting'): void {
    this.stop();
    this.startTime = Date.now();
    this.fileSizeLabel = fileSizeLabel;
    this.pipelineMode = mode;
    this.currentPercent = 3;
    this.lastCustomDetail = '';
    this.targetPercent = 5;

    this.timer = setInterval(() => {
      this.tick();
    }, 100);
    this.setStage('FETCH_OR_READ', 5, '正在读取二进制字节流...');
  }

  public getElapsedMs(): number {
    return this.startTime ? Math.max(1, Date.now() - this.startTime) : 0;
  }

  public setStage(stageId: DwgStageId, minPercent: number, detail: string): void {
    if (!this.timer) return;
    this.currentStage = stageId;
    this.targetPercent = Math.max(this.targetPercent, minPercent);
    this.lastCustomDetail = detail;
    this.tick(detail);
  }

  public advanceTarget(targetPct: number, detail?: string): void {
    if (!this.timer) return;
    this.targetPercent = Math.max(this.targetPercent, Math.min(99, targetPct));
    if (detail) {
      this.lastCustomDetail = detail;
      this.tick(detail);
    }
  }

  public finish(): void {
    this.currentPercent = 100;
    this.targetPercent = 100;
    this.setStage('WEBGL_RENDER', 100, '图纸解析渲染完成');
    this.emit(false);
    this.stop();
  }

  public error(): void {
    this.stop();
    this.emit(false);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(customDetail?: string): void {
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

  private emit(isLoading: boolean, customDetail?: string): void {
    const elapsedMs = this.startTime ? Date.now() - this.startTime : 0;
    const elapsedSeconds = `${(elapsedMs / 1000).toFixed(1)}s`;

    let stepNum = 1;
    let stageTitle = '文件读取与校验';
    let defaultDetail = '正在读取文件字节流...';

    if (this.pipelineMode === 'gzip_cache') {
      switch (this.currentStage) {
        case 'FETCH_OR_READ':
          stepNum = 1;
          stageTitle = '文件读取与校验';
          defaultDetail = `正在加载文件${this.fileSizeLabel ? ` (${this.fileSizeLabel})` : ''}...`;
          break;
        case 'WASM_DECODE':
          stepNum = 2;
          stageTitle = '缓存流式解压';
          defaultDetail = '正在解压图纸缓存数据...';
          break;
        case 'ENTITY_CONVERSION':
          stepNum = 3;
          stageTitle = '图元模型构建';
          defaultDetail = '正在加载图元实体与图层结构...';
          break;
        case 'FONT_LAYOUT':
          stepNum = 4;
          stageTitle = '文字排版与样式';
          defaultDetail = '正在加载矢量字库与文本排版...';
          break;
        case 'WEBGL_RENDER':
          stepNum = 5;
          stageTitle = '视口渲染呈现';
          defaultDetail = isLoading
            ? '正在计算视图范围并初始化视口...'
            : '图纸加载完成';
          break;
      }
    } else if (this.pipelineMode === 'dwg_full_parse') {
      switch (this.currentStage) {
        case 'FETCH_OR_READ':
          stepNum = 1;
          stageTitle = '文件读取与校验';
          defaultDetail = `正在加载 DWG 文件${this.fileSizeLabel ? ` (${this.fileSizeLabel})` : ''}并校验格式...`;
          break;
        case 'WASM_DECODE':
          stepNum = 2;
          stageTitle = '图纸核心解码';
          defaultDetail = '正在解析 DWG 二进制数据...';
          break;
        case 'ENTITY_CONVERSION':
          stepNum = 3;
          stageTitle = '图元模型构建';
          defaultDetail = '正在提取图元数据并构建模型树与图层索引...';
          break;
        case 'FONT_LAYOUT':
          stepNum = 4;
          stageTitle = '文字排版与样式';
          defaultDetail = '正在加载矢量字库与文本排版...';
          break;
        case 'WEBGL_RENDER':
          stepNum = 5;
          stageTitle = '视口渲染呈现';
          defaultDetail = isLoading
            ? '正在初始化视口并生成加速缓存...'
            : '图纸解析完成';
          break;
      }
    } else {
      switch (this.currentStage) {
        case 'FETCH_OR_READ':
          stepNum = 1;
          stageTitle = '文件读取与校验';
          defaultDetail = `正在加载文件${this.fileSizeLabel ? ` (${this.fileSizeLabel})` : ''}并校验格式...`;
          break;
        case 'WASM_DECODE':
          stepNum = 2;
          stageTitle = '图纸解码';
          defaultDetail = '正在检查缓存并准备图纸解码...';
          break;
        case 'ENTITY_CONVERSION':
          stepNum = 3;
          stageTitle = '图元模型构建';
          defaultDetail = '正在构建图元实体树、块表与图层数据...';
          break;
        case 'FONT_LAYOUT':
          stepNum = 4;
          stageTitle = '文字排版与样式';
          defaultDetail = '正在加载矢量字库与文本排版...';
          break;
        case 'WEBGL_RENDER':
          stepNum = 5;
          stageTitle = '视口渲染呈现';
          defaultDetail = isLoading
            ? '正在计算视图范围并初始化视口...'
            : '图纸已就绪';
          break;
      }
    }

    const templateNodes =
      this.pipelineMode === 'gzip_cache'
        ? GZIP_CACHE_NODES
        : this.pipelineMode === 'dwg_full_parse'
        ? DWG_FULL_PARSE_NODES
        : DETECTING_NODES;

    const nodes: DwgProgressNode[] = templateNodes.map((node) => {
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
      pipelineMode: this.pipelineMode,
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
  private resizeCleanup: (() => void) | null = null;
  private converter: CachedLibreDwgConverter | null = null;
  private lastResolvedCache: Omit<DwgCacheStatusInfo, 'totalElapsedMs'> | null = null;
  private currentFingerprint: string | null = null;
  private memoryProfile: DeviceMemoryProfile;

  constructor(callbacks: DwgViewerCallbacks = {}) {
    this.callbacks = callbacks;
    this.memoryProfile = getDeviceMemoryProfile();
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

  public getMemoryProfile(): DeviceMemoryProfile {
    return this.memoryProfile;
  }

  /**
   * Toggles the low-memory / anti-crash defense mode dynamically.
   * Updates device memory profile, reconfigures WebGL pixelRatio, and schedules a view re-render.
   */
  public setDefenseMode(enabled: boolean): void {
    this.memoryProfile = getDeviceMemoryProfile(enabled);
    this.applyPixelRatioToView();
  }

  /**
   * Applies the target pixel ratio from memory profile to the Three.js WebGL renderer
   * to strictly prevent multi-hundred megabyte renderbuffer allocations on Retina screens.
   */
  private applyPixelRatioToView(view?: any): void {
    const targetView = view || AcApDocManager.tryGetInstance()?.curView;
    if (!targetView) return;
    const threeRenderer =
      targetView._renderer?._renderer ||
      targetView._renderer?.renderer ||
      targetView._renderer;
    if (threeRenderer?.setPixelRatio) {
      const dpr = Math.min(
        typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
        this.memoryProfile.targetPixelRatio
      );
      threeRenderer.setPixelRatio(dpr);
      const w =
        targetView.width ||
        targetView._container?.clientWidth ||
        parseInt(threeRenderer.domElement?.style?.width || '0', 10);
      const h =
        targetView.height ||
        targetView._container?.clientHeight ||
        parseInt(threeRenderer.domElement?.style?.height || '0', 10);
      if (w && h && typeof threeRenderer.setSize === 'function') {
        threeRenderer.setSize(w, h, false);
      }
      targetView._isDirty = true;
      if (typeof targetView.render === 'function') {
        try {
          targetView.render();
        } catch {
          // Handled by continuous animation frame loop
        }
      }
    }
  }

  /**
   * Proactively aborts any ongoing background entity conversion and clears the previous drawing's
   * Three.js scene and GPU buffers BEFORE decompressing or parsing a new drawing.
   * Prevents the previous drawing (~150-200MB of WebGL geometries) from overlapping with the new
   * drawing's decompression/model construction on iOS WebKit.
   */
  private async releasePreviousSceneBeforeLoad(): Promise<void> {
    try {
      const curView = AcApDocManager.tryGetInstance()?.curView as any;
      if (!curView) return;
      if (typeof curView.abortConversion === 'function') {
        curView.abortConversion();
      }
      if (curView._scene && typeof curView._scene.clear === 'function') {
        curView._scene.clear();
      }
      if (this.memoryProfile.defenseModeEnabled || this.memoryProfile.isMobile) {
        await new Promise((r) => setTimeout(r, 25));
      }
    } catch {
      // Ignore scene cleanup errors before load
    }
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
        getProfile: () => this.memoryProfile,
      },
      this.tracker
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

    // 🛡️ WebGL Framebuffer Initialization & iOS Safari Resize Guard:
    // Respect active profile pixelRatio (1.25 on iOS/defense mode) immediately
    // and guard against window resize events (e.g., iOS URL bar collapse) resetting DPR to 3.0.
    if (docManager.curView) {
      this.applyPixelRatioToView(docManager.curView);
    }

    if (typeof window !== 'undefined') {
      const onWindowResize = () => {
        if (this.memoryProfile.defenseModeEnabled || this.memoryProfile.isMobile) {
          this.applyPixelRatioToView();
        }
      };
      window.addEventListener('resize', onWindowResize, { passive: true });
      this.resizeCleanup = () => {
        window.removeEventListener('resize', onWindowResize);
      };
    }

    const bindProgressEvents = () => {
      const doc = docManager.curDocument;
      if (!doc) return;
      doc.database.events.openProgress.addEventListener((args: any) => {
        const pct = Math.min(99, Math.max(10, Math.round(args.percentage || 0)));
        const stageStr = String(args.stage);
        const mode = this.tracker.getPipelineMode();
        if (stageStr === 'PARSE') {
          if (mode === 'gzip_cache') {
            this.tracker.setStage(
              'WASM_DECODE',
              Math.max(20, Math.min(55, pct)),
              '已解压缓存，正在加载模型数据...'
            );
          } else {
            this.tracker.setStage(
              'WASM_DECODE',
              Math.max(20, Math.min(55, pct)),
              '正在解析图纸二进制结构...'
            );
          }
        } else if (stageStr === 'CONVERSION') {
          const detail =
            mode === 'gzip_cache'
              ? (args.subStage
                  ? `正在加载图元实体 (${args.subStage})...`
                  : '正在构建图层与实体模型...')
              : (args.subStage
                  ? `正在构建实体索引 (${args.subStage})...`
                  : '正在提取图元并构建模型树...');
          this.tracker.setStage(
            'ENTITY_CONVERSION',
            Math.max(55, Math.min(82, pct)),
            detail
          );
        } else if (stageStr === 'FONT') {
          this.tracker.setStage(
            'FONT_LAYOUT',
            Math.max(82, Math.min(92, pct)),
            '正在加载矢量字库与文本排版...'
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
    if (this.resizeCleanup) {
      this.resizeCleanup();
      this.resizeCleanup = null;
    }
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

    // =========================================================================
    // 🛡️ 同名匹配优先法则 (Same-name Matching Rule Safeguard):
    // 若目标是标准 .dwg 文件且未开启强制重新解析 (bypassCache !== true)：
    // 先检查 L1 (IndexedDB) 与 L2 (服务端共享) 中是否存在同名 DWG 的 Gzip 缓存。
    // 若命中，直接路由至 loadFromCachedFingerprint 进行极速加载，彻底免去大文件网络传输与 WASM 二进制解码！
    // =========================================================================
    if (!options.bypassCache && !isGzipCacheFile(fileName)) {
      try {
        const matchedCache = await findGzipCacheByFileName(fileName);
        if (matchedCache && matchedCache.fingerprint) {
          return await this.loadFromCachedFingerprint(matchedCache.fingerprint);
        }
      } catch {
        // Fallback to standard network fetch
      }
    }

    this.tracker.start('', 'detecting');
    this.tracker.setStage(
      'FETCH_OR_READ',
      5,
      `正在获取图纸文件 ${fileName}...`
    );

    try {
      const headers: Record<string, string> = { ...(options.headers || {}) };
      const requestUrl = new URL(resolvedUrl, window.location.href);
      if (requestUrl.origin !== window.location.origin) {
        // Presigned URLs are fetched directly. MinIO credentials belong to the local proxy only.
        for (const header of Object.keys(headers)) {
          if (header.toLowerCase().startsWith('x-minio-')) delete headers[header];
        }
      }

      const fetchUrl =
        resolvedUrl.startsWith('/') && !resolvedUrl.includes('?')
          ? encodeURI(resolvedUrl)
          : resolvedUrl;
      const response = await fetch(fetchUrl, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        throw new Error(
          `文件读取失败 (HTTP ${response.status} ${response.statusText})：请检查文件地址或网络连接`
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
              `正在下载数据: ${formatByteSize(received)} / ${formatByteSize(contentLength)}...`
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
    this.tracker.start(fileSizeLabel, bypassCache ? 'dwg_full_parse' : 'detecting');
    this.tracker.setStage(
      'FETCH_OR_READ',
      12,
      `正在读取文件 ${fileName} (${fileSizeLabel}) 并校验格式...`
    );

    const headerInfo = inspectDwgHeader(buffer);
    if (!headerInfo.isDwg) {
      this.tracker.error();
      this.callbacks.onError?.(
        `文件头校验失败 (${headerInfo.versionLabel})：请确认为有效的 AutoCAD .dwg 图纸或 .dwg.cache.gz 缓存文件`
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
      await this.releasePreviousSceneBeforeLoad();
      // =========================================================================
      // 🛡️ 架构防卡死与防 OOM 核心配置 (DO NOT MODIFY / 严禁篡改):
      // 【背景与痛点】:
      // 针对 50MB+ 超大 DWG（如 66MB 和 50MB 样图等数十万图元图纸）：
      // 1. 若 cooperativeYield=false 或 minimumChunkSize 过大(如 5000)，SDK 会在单个 JS 同步宏任务
      //    中持续运行 30~50 秒，完全剥夺浏览器主线程让出机制，直接触发 Chrome "页面无响应" 弹窗！
      // 2. 连续同步执行阻止了 V8 引擎进行增量垃圾回收 (GC)，导致数十万瞬时图元对象瞬间挤爆内存，
      //    在手机端浏览器（iOS WebKit / Android Chrome 内存上限通常 1.0~1.5GB）引发致命 OOM 闪退！
      // 【解决方案】:
      // 1. cooperativeYield: 强制设为 true，驱动 AcDbBatchProcessing 定期调用 accmYieldToUi() 让出主线程。
      // 2. progressiveRendering: 设为 true，实现渐进式增量渲染，保持 UI 60fps 顺畅刷新。
      // 3. minimumChunkSize: 基于文件大小自适应计算 (大图 200~300，小图 1000)，平衡吞吐量与线程响应度。
      // =========================================================================
      const adaptiveChunkSize = calculateAdaptiveChunkSize(
        {
          byteLength: buffer.byteLength,
        },
        this.memoryProfile
      );

      let ok: boolean;
      try {
        ok = await docManager.openDocument(cleanDwgName, buffer, {
          mode: AcEdOpenMode.Read,
          openViewMode: AcApOpenViewMode.Extents,
          progressiveRendering: true,
          cooperativeYield: true,
          skipSpatialIndex: false,
          minimumChunkSize: adaptiveChunkSize,
        } as any);
      } catch (openErr: any) {
        // 🛡️ 平滑降级 (AcTrScene No Layout Fallback):
        // 针对部分缺乏图纸空间或 modelSpaceBtrId 未完成映射的异常，若当前文档已就绪则平滑放行，避免阻断渲染
        const msg = String(openErr?.message || openErr);
        if (msg.includes('No layout') || msg.includes('AcTrScene')) {
          console.warn('[dwgViewerEngine] Suppressed AcTrScene layout warning during openDocument, continuing gracefully:', openErr);
          ok = Boolean(docManager.curDocument);
        } else {
          throw openErr;
        }
      }

      if (!ok) {
        throw new Error(`无法解析 ${cleanDwgName}，请检查 DWG 图纸版本或数据完整性`);
      }

      this.tracker.setStage(
        'WEBGL_RENDER',
        95,
        '正在初始化视图范围并呈现图纸...'
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
    this.tracker.start(gzSizeLabel, 'gzip_cache');
    this.tracker.setStage(
      'WASM_DECODE',
      25,
      `正在解压图纸缓存文件 ${fileName} (${gzSizeLabel})...`
    );

    try {
      await this.releasePreviousSceneBeforeLoad();
      const t0 = performance.now();
      const envelope = await decompressGzipToEnvelope(
        gzBuffer,
        (pct, detail) => {
          this.tracker.setStage('WASM_DECODE', pct, detail);
        },
        this.memoryProfile
      );
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
        `缓存解压完成 (${decompressMs}ms)，正在加载图纸模型...`
      );

      // =========================================================================
      // 🛡️ 架构防卡死与防 OOM 核心配置 (DO NOT MODIFY / 严禁篡改):
      // Gzip 缓存流式解压后注入 CAD 模型时，同样涉及数十万图元的批量解析与挂载，
      // 必须开启 cooperativeYield 与自适应分片，防止手机端解压后注入阶段 OOM 闪退。
      // =========================================================================
      const adaptiveChunkSize = calculateAdaptiveChunkSize(
        {
          byteLength: envelope.originalByteLength,
          entityCount: envelope.entityCount,
        },
        this.memoryProfile
      );

      let ok: boolean;
      try {
        ok = await docManager.openDocument(cleanDwgName, stubBuffer, {
          mode: AcEdOpenMode.Read,
          openViewMode: AcApOpenViewMode.Extents,
          progressiveRendering: true,
          cooperativeYield: true,
          skipSpatialIndex: false,
          minimumChunkSize: adaptiveChunkSize,
        } as any);
      } catch (openErr: any) {
        // 🛡️ 平滑降级 (AcTrScene No Layout Fallback):
        // 针对部分缺乏图纸空间或 modelSpaceBtrId 未完成映射的异常，若当前文档已就绪则平滑放行，避免阻断渲染
        const msg = String(openErr?.message || openErr);
        if (msg.includes('No layout') || msg.includes('AcTrScene')) {
          console.warn('[dwgViewerEngine] Suppressed AcTrScene layout warning during gzip cache openDocument, continuing gracefully:', openErr);
          ok = Boolean(docManager.curDocument);
        } else {
          throw openErr;
        }
      }

      if (!ok) {
        throw new Error(`无法从 Gzip 缓存文件 ${fileName} 构建图纸模型`);
      }

      this.tracker.setStage(
        'WEBGL_RENDER',
        95,
        '正在初始化视图范围并呈现图纸...'
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
   * Alias for loadFromGzipCacheBuffer for compatibility
   */
  public async loadFromCacheBuffer(
    fileName: string,
    gzBuffer: ArrayBuffer,
    sourceUrl?: string
  ): Promise<boolean> {
    return this.loadFromGzipCacheBuffer(fileName, gzBuffer, sourceUrl);
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

    this.tracker.start('', 'gzip_cache');
    this.tracker.setStage(
      'WASM_DECODE',
      25,
      '正在读取并解压本地缓存...'
    );

    try {
      await this.releasePreviousSceneBeforeLoad();
      const hit = await getAndDecompressGzipCache(
        fingerprint,
        (pct, detail) => {
          this.tracker.setStage('WASM_DECODE', pct, detail);
        },
        this.memoryProfile
      );
      if (!hit || !hit.payload?.model) {
        throw new Error('该图纸缓存记录不存在或已过期');
      }

      const meta = hit.meta;
      const decompressMs = hit.decompressMs;
      const hitLayer = hit.hitLayer;
      const payload = hit.payload;

      // =========================================================================
      // 🛡️ CRITICAL iOS JETSAM & WEBKIT GC SAFEGUARD (防 iPhone 闪退核心):
      // 显式斩断 40MB+ gzBytes 二进制缓冲与中间包装引用，并主动微让出 20ms，
      // 确保在进入 openDocument 创建 CAD 图元模型前，JavaScriptCore 能够完整回收瞬时内存！
      // =========================================================================
      (hit as any).gzBytes = null;
      (hit as any).payload = null;

      this.currentFingerprint = meta.fingerprint;
      const cleanDwgName = normalizeDwgFileNameForConverter(meta.fileName);
      const stubToken = `idb_hit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.converter.registerStubPayload(stubToken, payload);
      const stubBuffer = createDwgStubBuffer(stubToken);

      // Brief yield to allow GC to sweep transient allocations
      await new Promise((r) => setTimeout(r, 20));

      this.tracker.setStage(
        'ENTITY_CONVERSION',
        55,
        `缓存解压完成 (${decompressMs}ms)，正在构建 ${meta.entityCount} 个图元...`
      );

      // =========================================================================
      // 🛡️ 架构防卡死与防 OOM 核心配置 (DO NOT MODIFY / 严禁篡改):
      // 从本地/共享 IndexedDB 读取 Gzip 缓存反序列化注入时，必须开启协作式让出与自适应分片。
      // =========================================================================
      const adaptiveChunkSize = calculateAdaptiveChunkSize(
        {
          byteLength: meta.originalByteLength,
          entityCount: meta.entityCount,
        },
        this.memoryProfile
      );

      let ok: boolean;
      try {
        ok = await docManager.openDocument(cleanDwgName, stubBuffer, {
          mode: AcEdOpenMode.Read,
          openViewMode: AcApOpenViewMode.Extents,
          progressiveRendering: true,
          cooperativeYield: true,
          skipSpatialIndex: false,
          minimumChunkSize: adaptiveChunkSize,
        } as any);
      } catch (openErr: any) {
        // 🛡️ 平滑降级 (AcTrScene No Layout Fallback):
        // 针对部分缺乏图纸空间或 modelSpaceBtrId 未完成映射的异常，若当前文档已就绪则平滑放行，避免阻断渲染
        const msg = String(openErr?.message || openErr);
        if (msg.includes('No layout') || msg.includes('AcTrScene')) {
          console.warn('[dwgViewerEngine] Suppressed AcTrScene layout warning during gzip cache openDocument, continuing gracefully:', openErr);
          ok = Boolean(docManager.curDocument);
        } else {
          throw openErr;
        }
      }

      if (!ok) {
        throw new Error(`无法从缓存渲染图纸 ${cleanDwgName}`);
      }

      this.tracker.setStage(
        'WEBGL_RENDER',
        95,
        '正在初始化视图范围并呈现图纸...'
      );
      this.ensureModelSpaceActive();
      this.configureInteractiveView();
      await this.fitToView();

      const totalElapsedMs = this.tracker.getElapsedMs();
      this.tracker.finish();

      const cacheInfo: DwgCacheStatusInfo = {
        source:
          hitLayer === 'server-shared' ? 'server-gzip-shared' : 'local-gzip-idb',
        fingerprint: meta.fingerprint,
        fileName: cleanDwgName,
        originalByteLength: meta.originalByteLength,
        rawJsonBytes: meta.rawJsonBytes,
        compressedBytes: meta.compressedBytes,
        compressionRatio: meta.compressionRatio,
        wasmParseMs: meta.wasmParseMs,
        decompressMs,
        totalElapsedMs,
        entityCount: meta.entityCount,
        layerCount: meta.layerCount,
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
      this.callbacks.onError?.(err?.message || '从图纸缓存加载失败');
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
   *
   * 🛡️ 防御加固 (AcTrScene No Layout Defense):
   * 1. 判空防崩：严格校验 docManager.curDocument、database、tables 及 blockTable 存在性；
   * 2. 安全短路：若当前激活空间已经是模型空间（activeBtr === modelId），或当前图纸空间已包含实体（>= 5），安全短路；
   * 3. 布局有效性校验：校验 layoutManager 存在性，防止未就绪时调用抛出致命未捕获异常。
   */
  private ensureModelSpaceActive(): void {
    const docManager = AcApDocManager.tryGetInstance();
    if (!docManager || !docManager.curDocument) return;
    (window as any).__cadDocManager = docManager;

    const db = docManager.curDocument.database;
    if (!db || !db.tables || !db.tables.blockTable) return;

    const blockTable = db.tables.blockTable;
    const modelSpace = blockTable.modelSpace;
    if (!modelSpace) return;

    const modelId = modelSpace.objectId;
    const activeBtr = db.currentSpaceId || modelId;

    // 🛡️ 空间短路：如果当前激活空间已经是模型空间，无需任何切换，避免引发事件乱序与重复布局校验
    if (activeBtr === modelId) {
      return;
    }

    const modelEntityCount = modelSpace.newIterator ? modelSpace.newIterator().count : 0;
    const currentPaperBtr = blockTable.getIdAt ? blockTable.getIdAt(activeBtr) : null;
    const currentPaperCount = currentPaperBtr && currentPaperBtr.newIterator ? currentPaperBtr.newIterator().count : 0;

    // 🛡️ 防御短路：仅当当前图纸空间为空（图元数极少 < 5）且模型空间有实质图元时，才安全切换至模型空间
    if (currentPaperCount < 5 && modelEntityCount > currentPaperCount) {
      try {
        const layoutMgr = acdbHostApplicationServices()?.layoutManager;
        if (layoutMgr && typeof layoutMgr.setCurrentLayoutBtrId === 'function') {
          layoutMgr.setCurrentLayoutBtrId(modelId, db);
        }
      } catch (err) {
        // Safe fallback: 降级告警并安全跳过，防止布局管理器未完成初始化时抛出致命异常
        console.warn('[dwgViewerEngine] Safe warning: setCurrentLayoutBtrId skipped:', err);
      }
    }
  }

  /**
   * Centers and fits the drawing in the viewport (automatically ignoring stray outlier points).
   *
   * 🌟 深度工程背景与离散图元智能聚焦防御 (Statistical Cluster Framing):
   * 1. 痛点：许多工程 DWG（如 66MB 工程图等高斯/CGCS2000 大地测量坐标图）在图层 "0" 或历史模板中残留了极端离散图元/孤立孤点
   *    （如坐标高达 6500万，而真实图层集中在 3260万）；同时 DWG 文件头自带被污染的 $EXTMIN/$EXTMAX。
   * 2. SDK 缺陷：SDK 内部 `applyInitialZoom` 会无脑读取 dirty $EXTMIN/$EXTMAX，将视口拉到几万公里高空；
   *    且其 `resolveSmartFitBox` 内置了 1e10 (100亿) 宽容度阈值，无法过滤千万级离散图层。
   * 3. 解决策略：
   *    - 遍历 `activeLayout.layers` 中所有非空图层包围盒；
   *    - 采用中位数统计法（Median Center & Median Span），动态识别并剔除偏离主体坐标系超限的极端离散图层；
   *    - 构造满足 Three-Renderer 契约的 Vector 结果盒（实现 getSize/getCenter 写入回传），调用 view.zoomTo(box, 1.08)；
   *    - 标记 `view.markLayoutAsInitialized` 与 `_externallyFramedLayouts`，阻断 SDK 异步定时器回弹重置视口；
   *    - 若图元正在流式分批转换中（`view.isProcessingEntities`），启动自适应监听，在全部图元转换完毕后自动再次执行精细聚焦。
   */
  public async fitToView(): Promise<void> {
    const docManager = AcApDocManager.tryGetInstance();
    if (!docManager) return;
    (window as any).__cadDocManager = docManager;
    const view = docManager.curView;
    if (!view) return;

    this.applyClusterFraming(view);

    // If progressive conversion is still processing in background, schedule a final fit when idle
    if (typeof (view as any).isProcessingEntities === 'function' && (view as any).isProcessingEntities()) {
      const btrId = (view as any).activeLayoutBtrId;
      if (btrId && (view as any)._externallyFramedLayouts) {
        (view as any)._externallyFramedLayouts.add(btrId);
      }
      this.schedulePostConvertRefit(view);
    }
  }

  /**
   * Schedules a one-time refit when background entity conversion completely drains.
   */
  private schedulePostConvertRefit(view: any): void {
    let attempts = 0;
    const maxAttempts = 120; // 60 seconds (500ms intervals)
    const checkInterval = setInterval(() => {
      attempts++;
      if (!view || !view._scene) {
        clearInterval(checkInterval);
        return;
      }
      const isProcessing = typeof view.isProcessingEntities === 'function' && view.isProcessingEntities();
      if (!isProcessing || attempts >= maxAttempts) {
        clearInterval(checkInterval);
        this.applyClusterFraming(view);
      }
    }, 500);
  }

  /**
   * Calculates dominant cluster bounding box across all active layers using statistical median filtering,
   * completely ignoring astronomical coordinate outliers (e.g. layer "0" at 65,000,000 while drawing is at 32,600,000).
   */
  private applyClusterFraming(view: any): boolean {
    const layout = view._scene?.activeLayout;
    if (!layout) {
      try {
        view.zoomToFitDrawing?.();
        return true;
      } catch {
        return false;
      }
    }

    const layerBoxes: Array<{
      name: string;
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
      centerX: number;
      centerY: number;
      spanX: number;
      spanY: number;
    }> = [];

    if (layout.layers) {
      layout.layers.forEach((layer: any, name: string) => {
        if (layer.box && !layer.box.isEmpty()) {
          const b = layer.box;
          layerBoxes.push({
            name,
            minX: b.min.x,
            minY: b.min.y,
            maxX: b.max.x,
            maxY: b.max.y,
            centerX: (b.min.x + b.max.x) / 2,
            centerY: (b.min.y + b.max.y) / 2,
            spanX: b.max.x - b.min.x,
            spanY: b.max.y - b.min.y,
          });
        }
      });
    }

    // Fallback if no layer boxes exist yet
    if (layerBoxes.length === 0) {
      try {
        view.zoomToFitDrawing?.();
        return true;
      } catch {
        return false;
      }
    }

    // 1. Calculate statistical medians across all layers
    const sortedX = layerBoxes.map((b) => b.centerX).sort((a, b) => a - b);
    const sortedY = layerBoxes.map((b) => b.centerY).sort((a, b) => a - b);
    const medX = sortedX[Math.floor(sortedX.length / 2)];
    const medY = sortedY[Math.floor(sortedY.length / 2)];

    const sortedSpans = layerBoxes.map((b) => Math.max(b.spanX, b.spanY)).sort((a, b) => a - b);
    const medSpan = sortedSpans[Math.floor(sortedSpans.length / 2)] || 1000;

    // 2. Reject outlier layers whose center deviates wildly from cluster median
    // (e.g. layer "0" at 6500万 vs drawing at 3260万)
    const maxAllowedDist = Math.max(medSpan * 15, 60000);
    const kept = layerBoxes.filter((b) => {
      const dist = Math.hypot(b.centerX - medX, b.centerY - medY);
      return dist <= maxAllowedDist;
    });

    const activeLayers = kept.length > 0 ? kept : layerBoxes;

    // 3. Union filtered layers
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const b of activeLayers) {
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }

    // 4. Construct Three-Renderer compatible Box with vector-writing getSize & getCenter
    const targetBox = {
      min: { x: minX, y: minY },
      max: { x: maxX, y: maxY },
      getSize: (out?: any) => {
        if (out) {
          out.x = maxX - minX;
          out.y = maxY - minY;
        }
        return out || { x: maxX - minX, y: maxY - minY };
      },
      getCenter: (out?: any) => {
        if (out) {
          out.x = (minX + maxX) / 2;
          out.y = (minY + maxY) / 2;
        }
        return out || { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      },
      isEmpty: () => false,
    };

    try {
      view.zoomTo(targetBox, 1.08);
      const btrId = view.activeLayoutBtrId;
      if (btrId) {
        if (typeof view.markLayoutAsInitialized === 'function') {
          view.markLayoutAsInitialized(btrId);
        }
        if (view._externallyFramedLayouts) {
          view._externallyFramedLayouts.add(btrId);
        }
      }
      view._isDirty = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Configures CAD viewport interactive behavior:
   * Enables entity hover-highlight, sets optimal pick tolerance, and reduces hover response latency.
   * [09_viewport_interaction] 默认鼠标左键拖拽平移与空格抓手映射：默认模式配置为平移漫游 (AcEdViewMode.PAN = 1)
   */
  public configureInteractiveView(): void {
    const docManager = AcApDocManager.tryGetInstance();
    if (!docManager) return;
    (window as any).__cadDocManager = docManager;
    const view = docManager.curView;
    if (!view) return;

    view.entitySelectionEnabled = true;
    // [09_viewport_interaction] 默认鼠标左键拖拽平移与空格抓手映射：默认模式设为平移漫游 (PAN = 1)
    this.setViewMode('pan');
    view.selectionBoxSize = 6;

    const hoverCtrl = (view as any)._hoverController;
    if (hoverCtrl) {
      hoverCtrl.hoverDelay = 80;
      hoverCtrl.pauseDelay = 100;
    }

    // 🛡️ WebGL Framebuffer & Jetsam Memory Protection:
    // Strictly adhere to targetPixelRatio (1.25 on iOS/defense mode, 1.5 on mobile, 2.0 on desktop)
    // to prevent 100MB+ WebGL renderbuffers causing out-of-memory WebGL context loss.
    this.applyPixelRatioToView(view);
  }

  /**
   * [09_viewport_interaction] 动态切换视口交互模式（平移漫游 vs 框选）
   * @param mode 'pan' 为平移漫游模式 (AcEdViewMode.PAN = 1)，'select' 为框选模式 (AcEdViewMode.SELECTION = 0)
   */
  public setViewMode(mode: 'pan' | 'select'): void {
    const docManager = AcApDocManager.tryGetInstance();
    if (!docManager) return;
    const view = docManager.curView;
    if (!view) return;
    (view as any).mode = mode === 'pan' ? AcEdViewMode.PAN : AcEdViewMode.SELECTION;

    // [09_viewport_interaction] 加固底层相机控制器鼠标映射，确保平移模式下左键与中键双通道平移
    const activeLayoutView = (view as any).activeLayoutView;
    const controls = activeLayoutView?._cameraControls || (view as any)._cameraControls;
    if (controls && controls.mouseButtons) {
      if (mode === 'pan') {
        controls.mouseButtons.LEFT = 2; // THREE.MOUSE.PAN (2)
        controls.mouseButtons.MIDDLE = 2; // THREE.MOUSE.PAN (2)
      } else {
        delete controls.mouseButtons.LEFT;
        controls.mouseButtons.MIDDLE = 2;
      }
      controls.update?.();
    }
  }

  /**
   * [09_viewport_interaction] 查询当前视口是否处于平移漫游模式
   */
  public isPanMode(): boolean {
    const docManager = AcApDocManager.tryGetInstance();
    if (!docManager) return true;
    const view = docManager.curView;
    if (!view) return true;
    return (view as any).mode === AcEdViewMode.PAN;
  }
}
