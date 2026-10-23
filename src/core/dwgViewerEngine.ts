import {
  AcApDocManager,
  AcApSettingManager,
  AcEdOpenMode,
  AcApOpenViewMode,
} from '@mlightcad/cad-simple-viewer';
import { AcDbLibreDwgConverter } from '@mlightcad/libredwg-converter';
import {
  AcDbDatabaseConverterManager,
  AcDbFileType,
  acdbHostApplicationServices,
} from '@mlightcad/data-model';
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

export interface DwgLoadedMeta {
  fileName: string;
  fileSizeLabel: string;
  versionLabel: string;
  sourceUrl?: string;
}

export interface DwgViewerCallbacks {
  onProgress?: (state: DwgProgressState) => void;
  onLoaded?: (meta: DwgLoadedMeta) => void;
  onError?: (message: string) => void;
}

export interface LoadFromUrlOptions {
  /** Optional custom file name when URL does not end in .dwg */
  fileName?: string;
  /** Sa-Token credential string for MinIO Spring proxy */
  satoken?: string;
  /** Optional HTTP headers (e.g., satoken or Authorization Bearer token for Spring Boot / MinIO proxy) */
  headers?: Record<string, string>;
}

const DEFAULT_NODES: DwgProgressNode[] = [
  { id: 'FETCH_OR_READ', step: 1, title: '文件读取与校验', status: 'pending' },
  { id: 'WASM_DECODE', step: 2, title: 'WASM 核心解码', status: 'pending' },
  { id: 'ENTITY_CONVERSION', step: 3, title: 'CAD 图元模型构建', status: 'pending' },
  { id: 'FONT_LAYOUT', step: 4, title: '矢量字体与排版', status: 'pending' },
  { id: 'WEBGL_RENDER', step: 5, title: 'WebGL 视口呈现', status: 'pending' },
];

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
  private onUpdate: (state: DwgProgressState) => void;

  constructor(onUpdate: (state: DwgProgressState) => void) {
    this.onUpdate = onUpdate;
  }

  public start(fileSizeLabel = '') {
    this.stop();
    this.startTime = Date.now();
    this.fileSizeLabel = fileSizeLabel;
    this.currentPercent = 3;
    this.setStage('FETCH_OR_READ', 5, '正在读取 DWG 二进制字节流...');

    // 100ms ticker for smooth visual interpolation
    this.timer = setInterval(() => {
      this.tick();
    }, 100);
  }

  public setStage(stageId: DwgStageId, minPercent: number, detail: string) {
    this.currentStage = stageId;
    this.targetPercent = Math.max(this.targetPercent, minPercent);
    this.tick(detail);
  }

  public advanceTarget(targetPct: number, detail?: string) {
    this.targetPercent = Math.max(this.targetPercent, Math.min(99, targetPct));
    if (detail) {
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
    // Smooth ease-towards target
    if (this.currentPercent < this.targetPercent) {
      const step = Math.max(0.4, (this.targetPercent - this.currentPercent) * 0.15);
      this.currentPercent = Math.min(this.targetPercent, +(this.currentPercent + step).toFixed(1));
    } else if (this.currentStage === 'WASM_DECODE' && this.currentPercent < 55) {
      // For large 50MB files in WASM stage (~15-20s), gently crawl forward to avoid looking frozen
      this.currentPercent = +(this.currentPercent + 0.15).toFixed(1);
    } else if (this.currentStage === 'ENTITY_CONVERSION' && this.currentPercent < 78) {
      this.currentPercent = +(this.currentPercent + 0.18).toFixed(1);
    }

    this.emit(true, customDetail);
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
        defaultDetail = `正在加载文件${this.fileSizeLabel ? ` (${this.fileSizeLabel})` : ''}并校验 AutoCAD DWG 头标识...`;
        break;
      case 'WASM_DECODE':
        stepNum = 2;
        stageTitle = 'WASM 核心解码';
        defaultDetail = `LibreDWG WebAssembly 正在多线程解算 DWG 原始二进制流 (约 10~20s)...`;
        break;
      case 'ENTITY_CONVERSION':
        stepNum = 3;
        stageTitle = 'CAD 图元模型构建';
        defaultDetail = `正在构建图元实体树、块表记录与图层数据归一化...`;
        break;
      case 'FONT_LAYOUT':
        stepNum = 4;
        stageTitle = '矢量字体与排版';
        defaultDetail = `正在匹配加载 CAD SHX 矢量字库并排版 MText 文字网格...`;
        break;
      case 'WEBGL_RENDER':
        stepNum = 5;
        stageTitle = 'WebGL 视口呈现';
        defaultDetail = isLoading ? `正在计算智能聚簇居中并初始化 2D 正交视口...` : `图纸已就绪`;
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
 * Clears legacy font alias caches in IndexedDB (from earlier mlightcad sessions)
 * so that new mesh TrueType font definitions in fonts.json are freshly loaded.
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
 * Framework-agnostic DWG WebGL Viewer Engine.
 * Can be mounted directly in React, Vue 2/3, or vanilla DOM containers,
 * and supports loading DWG files from MinIO presigned URLs, Spring Boot file streams, or local File buffers.
 */
export class DwgViewerEngine {
  private callbacks: DwgViewerCallbacks;
  private tracker: ProgressTracker;
  private mounted = false;
  private gpuInfo: GpuHardwareInfo = detectGpuHardware();
  private unmountProtection: (() => void) | null = null;

  constructor(callbacks: DwgViewerCallbacks = {}) {
    this.callbacks = callbacks;
    this.tracker = new ProgressTracker((state) => {
      this.callbacks.onProgress?.(state);
    });
  }

  public getGpuInfo(): GpuHardwareInfo {
    return this.gpuInfo;
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

    const dwgConverter = new AcDbLibreDwgConverter({
      parserWorkerUrl,
      timeout: 180000,
    });
    AcDbDatabaseConverterManager.instance.register(AcDbFileType.DWG, dwgConverter);

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
            'LibreDWG WebAssembly 正在多线程解算 DWG 原始二进制流...'
          );
        } else if (stageStr === 'CONVERSION') {
          const detail = args.subStage
            ? `正在构建图元实体索引 (${args.subStage})...`
            : '正在构建图层表与图元实体模型树...';
          this.tracker.setStage(
            'ENTITY_CONVERSION',
            Math.max(55, Math.min(80, pct)),
            detail
          );
        } else if (stageStr === 'FONT') {
          this.tracker.setStage(
            'FONT_LAYOUT',
            Math.max(80, Math.min(92, pct)),
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
   * Downloads a DWG binary stream from a MinIO presigned URL or Spring Boot endpoint,
   * then parses and renders it in the WebGL viewport.
   */
  public async loadFromUrl(
    rawUrl: string,
    options: LoadFromUrlOptions = {}
  ): Promise<boolean> {
    const trimmedUrl = (rawUrl || '').trim();
    if (!trimmedUrl) {
      this.callbacks.onError?.('请输入有效的 MinIO 或内部 DWG 文件地址');
      return false;
    }

    const resolvedUrl = resolveMinioDwgUrl(trimmedUrl);
    const fileName = options.fileName || extractFileNameFromUrl(resolvedUrl);
    this.tracker.start();
    this.tracker.setStage(
      'FETCH_OR_READ',
      5,
      `正在从 MinIO / 远程地址拉取 ${fileName}...`
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
          `远程文件读取失败 (HTTP ${response.status} ${response.statusText})`
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
              `从 MinIO 下载流: ${formatByteSize(received)} / ${formatByteSize(contentLength)}...`
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

      return await this.loadFromBuffer(fileName, buffer, resolvedUrl);
    } catch (err: any) {
      const msg = err?.message || `无法从地址加载图纸: ${trimmedUrl}`;
      this.tracker.error();
      this.callbacks.onError?.(msg);
      return false;
    }
  }

  /**
   * Parses and renders a DWG binary ArrayBuffer directly in the viewport.
   */
  public async loadFromBuffer(
    fileName: string,
    buffer: ArrayBuffer,
    sourceUrl?: string
  ): Promise<boolean> {
    const docManager = AcApDocManager.tryGetInstance();
    if (!docManager) {
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
        `文件头校验失败 (${headerInfo.versionLabel})：请确认地址或文件为真实的 AutoCAD .dwg 二维图纸`
      );
      return false;
    }

    this.tracker.setStage(
      'WASM_DECODE',
      20,
      `提交后台 Web Worker 执行 LibreDWG WASM 核心解算 (${headerInfo.versionLabel})...`
    );

    try {
      const ok = await docManager.openDocument(fileName, buffer, {
        mode: AcEdOpenMode.Read,
        openViewMode: AcApOpenViewMode.Extents,
        progressiveRendering: false,
        cooperativeYield: false,
        skipSpatialIndex: false,
      } as any);

      if (!ok) {
        throw new Error(`无法解析 ${fileName}，请检查 DWG 图纸版本或数据完整性`);
      }

      this.tracker.setStage(
        'WEBGL_RENDER',
        95,
        '计算智能聚簇居中，构建 WebGL 视口呈现...'
      );
      this.ensureModelSpaceActive();
      this.configureInteractiveView();
      await this.fitToView();

      this.tracker.finish();
      this.callbacks.onLoaded?.({
        fileName,
        fileSizeLabel,
        versionLabel: headerInfo.versionLabel,
        sourceUrl,
      });
      return true;
    } catch (err: any) {
      this.tracker.error();
      this.callbacks.onError?.(err?.message || `解析 ${fileName} 失败`);
      return false;
    }
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

    // 1. Ensure selection and hover-highlighting are active
    view.entitySelectionEnabled = true;
    (view as any).mode = 0; // AcEdViewMode.SELECTION

    // 2. Adjust hit tolerance (default is 4px, set to 6px for easier cursor snapping on lines)
    view.selectionBoxSize = 6;

    // 3. Accelerate hover reaction time (default is 500ms, reduce to 80ms for instant feedback)
    const hoverCtrl = (view as any)._hoverController;
    if (hoverCtrl) {
      hoverCtrl.hoverDelay = 80;
      hoverCtrl.pauseDelay = 100;
    }
  }
}
