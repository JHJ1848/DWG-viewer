import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Upload,
  Scan,
  Link2,
  AlertTriangle,
  X,
  Loader2,
  CheckCircle2,
  Clock,
  Cpu,
  ChevronDown,
  ChevronUp,
  KeyRound,
  Database,
  ShieldCheck,
  HardDriveDownload,
  Zap,
  RotateCcw,
  Trash2,
  FileArchive,
  Play,
} from 'lucide-react';
import {
  DwgViewerEngine,
  DwgLoadedMeta,
  DwgProgressState,
  DwgProgressNode,
} from './core/dwgViewerEngine';
import { formatByteSize, validateDwgOrCacheFileName } from './utils/dwgValidation';
import { detectGpuHardware, GpuHardwareInfo } from './utils/webglCompatibility';
import { LocalGzipCacheMeta } from './utils/dwgLocalCacheStore';

const DEFAULT_DWG_URL = '/samples/canteen.dwg';

const INITIAL_NODES: DwgProgressNode[] = [
  { id: 'FETCH_OR_READ', step: 1, title: '文件读取与校验', status: 'active' },
  { id: 'WASM_DECODE', step: 2, title: 'WASM解码 / Gzip缓存', status: 'pending' },
  { id: 'ENTITY_CONVERSION', step: 3, title: 'CAD 图元模型构建', status: 'pending' },
  { id: 'FONT_LAYOUT', step: 4, title: '矢量字体与排版', status: 'pending' },
  { id: 'WEBGL_RENDER', step: 5, title: 'WebGL 视口呈现', status: 'pending' },
];

function getInitialUrlFromQuery(): string {
  if (typeof window === 'undefined') return DEFAULT_DWG_URL;
  const params = new URLSearchParams(window.location.search);
  return (
    params.get('url') ||
    params.get('fileUrl') ||
    params.get('minioUrl') ||
    DEFAULT_DWG_URL
  );
}

export default function App() {
  const viewportContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const engineRef = useRef<DwgViewerEngine | null>(null);

  const [urlInput, setUrlInput] = useState<string>(() => getInitialUrlFromQuery());
  const [satoken, setSatoken] = useState<string>(() => {
    if (typeof window === 'undefined') return '7e3ee0e3-6041-45f4-9121-9783e7c81a98';
    return (
      localStorage.getItem('cad_satoken') ||
      new URLSearchParams(window.location.search).get('satoken') ||
      '7e3ee0e3-6041-45f4-9121-9783e7c81a98'
    );
  });
  const [showSatokenInput, setShowSatokenInput] = useState<boolean>(false);
  const [gpuInfo] = useState<GpuHardwareInfo>(() => detectGpuHardware());
  const [showGpuModal, setShowGpuModal] = useState<boolean>(false);
  const [showCachePanel, setShowCachePanel] = useState<boolean>(false);
  const [cacheEntries, setCacheEntries] = useState<LocalGzipCacheMeta[]>([]);
  const [loadedMeta, setLoadedMeta] = useState<DwgLoadedMeta>({
    fileName: 'canteen.dwg',
    fileSizeLabel: '2.50 MB',
    versionLabel: 'AutoCAD DWG',
  });
  const [progress, setProgress] = useState<DwgProgressState>({
    isLoading: true,
    percent: 5,
    currentStep: 1,
    totalSteps: 5,
    stageId: 'FETCH_OR_READ',
    stageTitle: '文件读取与校验',
    stageDetail: '正在初始化引擎与加载文件...',
    elapsedMs: 0,
    elapsedSeconds: '0.0s',
    nodes: INITIAL_NODES,
  });
  const [isProgressCollapsed, setIsProgressCollapsed] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);

  const handleUpdateSatoken = useCallback((newToken: string) => {
    const trimmed = newToken.trim();
    setSatoken(trimmed);
    if (typeof window !== 'undefined') {
      localStorage.setItem('cad_satoken', trimmed);
    }
  }, []);

  const handleLoadUrl = useCallback(
    async (
      targetUrl?: string,
      customSatoken?: string,
      headers?: Record<string, string>,
      bypassCache = false
    ) => {
      const finalUrl = (targetUrl ?? urlInput).trim();
      const tokenToUse = customSatoken ?? satoken;
      setErrorBanner(null);
      await engineRef.current?.loadFromUrl(finalUrl, {
        satoken: tokenToUse,
        headers,
        bypassCache,
      });
    },
    [urlInput, satoken]
  );

  const handleLocalFile = useCallback(async (file: File) => {
    setErrorBanner(null);
    const validation = validateDwgOrCacheFileName(file.name);
    if (!validation.valid) {
      setErrorBanner(validation.reason || '仅支持 .dwg 图纸或 .dwg.cache.gz 压缩缓存文件');
      return;
    }
    const buffer = await file.arrayBuffer();
    await engineRef.current?.loadFromBuffer(file.name, buffer);
  }, []);

  const handleDownloadGzipFile = useCallback(async (fingerprint?: string) => {
    const exported = await engineRef.current?.exportGzipCacheFile(fingerprint);
    if (!exported) {
      setErrorBanner('当前图纸尚未生成本地 Gzip 缓存记录');
      return;
    }
    const copyBuffer = new Uint8Array(exported.gzBytes.byteLength);
    copyBuffer.set(exported.gzBytes);
    const blob = new Blob([copyBuffer], { type: 'application/gzip' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = exported.exportFileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 3000);
  }, []);

  useEffect(() => {
    if (engineRef.current || !viewportContainerRef.current) return;

    const engine = new DwgViewerEngine({
      onProgress: (state) => setProgress(state),
      onLoaded: (meta) => {
        setLoadedMeta(meta);
        if (meta.sourceUrl) {
          setUrlInput(meta.sourceUrl);
        }
      },
      onError: (msg) => setErrorBanner(msg),
      onCacheListChanged: (entries) => setCacheEntries(entries),
    });

    engine.mount(viewportContainerRef.current);
    engineRef.current = engine;
    (window as any).__cadEngine = engine;

    const initialUrl = getInitialUrlFromQuery();
    void engine.loadFromUrl(initialUrl, { satoken });

    const onWindowMessage = (event: MessageEvent) => {
      const payload = event.data;
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'LOAD_DWG_URL' && typeof payload.url === 'string') {
        setErrorBanner(null);
        setUrlInput(payload.url);
        if (payload.satoken) {
          handleUpdateSatoken(payload.satoken);
        }
        void engine.loadFromUrl(payload.url, {
          fileName: payload.fileName,
          satoken: payload.satoken || satoken,
          headers: payload.headers,
        });
      } else if (
        payload.type === 'LOAD_DWG_BUFFER' &&
        payload.buffer instanceof ArrayBuffer
      ) {
        setErrorBanner(null);
        void engine.loadFromBuffer(payload.fileName || 'external.dwg', payload.buffer);
      } else if (
        payload.type === 'LOAD_DWG_GZIP_CACHE' &&
        payload.buffer instanceof ArrayBuffer
      ) {
        setErrorBanner(null);
        void engine.loadFromGzipCacheBuffer(
          payload.fileName || 'external.dwg.cache.gz',
          payload.buffer
        );
      }
    };

    window.addEventListener('message', onWindowMessage);
    return () => {
      window.removeEventListener('message', onWindowMessage);
    };
  }, [handleUpdateSatoken, satoken]);

  const activeCache = loadedMeta.cacheInfo;

  return (
    <div
      className="h-screen w-screen flex flex-col bg-[#0B0E17] text-slate-100 overflow-hidden select-none"
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isDraggingOver) setIsDraggingOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.currentTarget === e.target) setIsDraggingOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingOver(false);
        const file = e.dataTransfer?.files?.[0];
        if (file) void handleLocalFile(file);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".dwg,.gz,application/gzip"
        aria-label="上传本地 DWG 或 .dwg.cache.gz 缓存文件"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleLocalFile(file);
          e.target.value = '';
        }}
      />

      {/* Responsive Top Bar */}
      <header className="bg-[#0F1624] border-b border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-1.5 md:gap-2 px-2.5 sm:px-3 py-1.5 md:py-0 md:h-12 shrink-0 z-20">
        {/* Left: File Info & Cache Status Badge */}
        <div className="flex items-center justify-between md:justify-start gap-2 min-w-0 w-full md:w-auto">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className="text-xs font-mono text-slate-200 truncate max-w-[120px] sm:max-w-[170px]"
              title={loadedMeta.fileName}
            >
              {loadedMeta.fileName}
            </span>
            <span className="text-[10px] sm:text-[11px] font-mono text-cyan-400 bg-cyan-950/60 border border-cyan-500/30 px-1.5 py-0.5 rounded shrink-0">
              {loadedMeta.fileSizeLabel}
            </span>

            {activeCache && (
              <button
                type="button"
                onClick={() => setShowCachePanel((v) => !v)}
                data-testid="gzip-status-badge"
                className={`hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono border transition-colors shrink-0 ${
                  activeCache.source === 'wasm-cold'
                    ? 'bg-indigo-950/60 text-indigo-300 border-indigo-500/40 hover:bg-indigo-900/50'
                    : 'bg-emerald-950/70 text-emerald-300 border-emerald-500/40 hover:bg-emerald-900/50'
                }`}
                title="点击打开本地 Gzip 缓存管理与对比面板"
              >
                <Zap className="w-3 h-3 text-amber-400" />
                {activeCache.source === 'wasm-cold' ? (
                  <span>
                    首次解码 {(activeCache.wasmParseMs / 1000).toFixed(1)}s · 已存 Gzip (
                    {formatByteSize(activeCache.compressedBytes)}, -
                    {Math.round(activeCache.compressionRatio * 100)}%)
                  </span>
                ) : activeCache.source === 'local-gzip-file' ? (
                  <span>
                    .gz文件秒开 {(activeCache.totalElapsedMs / 1000).toFixed(1)}s (解压{' '}
                    {activeCache.decompressMs}ms)
                  </span>
                ) : (
                  <span>
                    Gzip缓存秒开 {(activeCache.totalElapsedMs / 1000).toFixed(1)}s (解压{' '}
                    {activeCache.decompressMs}ms)
                  </span>
                )}
              </button>
            )}
          </div>

          {/* Mobile Quick Actions */}
          <div className="flex items-center gap-1.5 md:hidden">
            <button
              type="button"
              onClick={() => setShowCachePanel((v) => !v)}
              className="px-2 py-1 rounded text-[11px] font-mono bg-emerald-950/50 text-emerald-300 border border-emerald-500/40 flex items-center gap-1"
            >
              <FileArchive className="w-3 h-3" />
              <span>Gzip({cacheEntries.length})</span>
            </button>
            <button
              type="button"
              onClick={() => void engineRef.current?.fitToView()}
              title="居中复位图纸"
              className="p-1.5 rounded text-xs bg-slate-800 hover:bg-slate-700 text-cyan-400 border border-slate-700 transition-colors"
            >
              <Scan className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-2 py-1 rounded text-xs font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-950 flex items-center gap-1 transition-colors"
            >
              <Upload className="w-3 h-3" />
              <span>上传</span>
            </button>
          </div>
        </div>

        {/* Center: URL Input & Built-in Sample Presets */}
        <form
          className="w-full md:flex-1 md:max-w-2xl lg:max-w-3xl flex items-center gap-1.5 min-w-0"
          onSubmit={(e) => {
            e.preventDefault();
            void handleLoadUrl();
          }}
        >
          <div className="relative flex-1 min-w-0">
            <Link2 className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="输入本地样图 (/samples/...) 或 MinIO 路径..."
              aria-label="DWG 或 Gzip 缓存文件地址"
              className="w-full pl-8 pr-2.5 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700/80 rounded focus:outline-none focus:border-cyan-400 text-slate-200 placeholder:text-slate-500"
            />
          </div>

          {/* Local Sample Presets (Work directly in AI Studio without intranet MinIO) */}
          <button
            type="button"
            disabled={progress.isLoading}
            onClick={() => {
              const path = '/samples/canteen.dwg';
              setUrlInput(path);
              void handleLoadUrl(path);
            }}
            className="hidden lg:flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium bg-cyan-950/40 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-900/40 disabled:opacity-50 transition-colors shrink-0"
            title="加载内置真实图纸 canteen.dwg (2.5MB)"
          >
            <Database className="w-3 h-3 text-cyan-400" />
            <span>样图1(2.5M)</span>
          </button>

          <button
            type="button"
            disabled={progress.isLoading}
            onClick={() => {
              const path = '/samples/baseline-sample.dwg';
              setUrlInput(path);
              void handleLoadUrl(path);
            }}
            className="hidden xl:flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700/60 disabled:opacity-50 transition-colors shrink-0"
            title="加载内置大型工程总图 baseline-sample.dwg (18MB)"
          >
            <Database className="w-3 h-3 text-slate-400" />
            <span>样图2(18M)</span>
          </button>

          <button
            type="button"
            onClick={() => setShowSatokenInput((v) => !v)}
            className={`hidden md:flex px-2 py-1.5 rounded text-[11px] font-mono items-center gap-1 transition-colors shrink-0 border ${
              showSatokenInput
                ? 'bg-amber-950/40 text-amber-300 border-amber-500/40'
                : 'bg-slate-800 text-slate-400 border-slate-700'
            }`}
            title="配置内网 MinIO Sa-Token 鉴权凭证"
          >
            <KeyRound className="w-3 h-3 text-amber-400" />
            <span className="hidden 2xl:inline">Token</span>
          </button>

          <button
            type="submit"
            disabled={progress.isLoading}
            className="px-2.5 py-1.5 rounded text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-cyan-300 border border-slate-700 transition-colors shrink-0"
          >
            加载
          </button>
        </form>

        {/* Right Desktop Actions */}
        <div className="hidden md:flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            data-testid="toggle-gzip-cache-panel"
            onClick={() => setShowCachePanel((v) => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-mono border transition-colors ${
              showCachePanel
                ? 'bg-emerald-900/50 text-emerald-200 border-emerald-400/60'
                : 'bg-emerald-950/40 text-emerald-300 border-emerald-500/30 hover:bg-emerald-900/40'
            }`}
            title="管理本地 Gzip 压缩缓存 (.dwg.cache.gz) · 导出/直开/对比测试"
          >
            <FileArchive className="w-3.5 h-3.5 text-emerald-400" />
            <span>Gzip缓存库 ({cacheEntries.length})</span>
          </button>

          <button
            type="button"
            disabled={!activeCache || progress.isLoading}
            onClick={() => void handleDownloadGzipFile()}
            data-testid="export-gzip-btn"
            className="hidden xl:flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium bg-indigo-950/50 hover:bg-indigo-900/60 disabled:opacity-40 text-indigo-200 border border-indigo-500/30 transition-colors"
            title="将当前图纸的解码中间结果导出为本地 .dwg.cache.gz 压缩文件"
          >
            <HardDriveDownload className="w-3.5 h-3.5 text-indigo-400" />
            <span>导出 .gz</span>
          </button>

          <button
            type="button"
            onClick={() => setShowGpuModal((v) => !v)}
            className="hidden 2xl:flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-mono border bg-slate-900/80 text-slate-300 border-slate-700 hover:bg-slate-800 transition-colors"
            title="查看当前机器图形硬件探测与 WebGL 兼容守护状态"
          >
            <Cpu className="w-3 h-3 text-cyan-400" />
            <span>
              {gpuInfo.gpuTier === 'dedicated'
                ? '独显'
                : gpuInfo.gpuTier === 'integrated'
                ? '核显'
                : 'WebGL'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => void engineRef.current?.fitToView()}
            aria-label="居中复位"
            title="适应窗口并居中图纸"
            className="px-2.5 py-1.5 rounded text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1.5 transition-colors"
          >
            <Scan className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden lg:inline">居中复位</span>
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 rounded text-xs font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-950 flex items-center gap-1.5 transition-colors"
            title="支持上传原始 .dwg 图纸，或直接上传 .dwg.cache.gz 本地缓存文件秒开"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>上传 DWG / .gz</span>
          </button>
        </div>
      </header>

      {/* Local Gzip Cache Management & Benchmark Panel */}
      {showCachePanel && (
        <section
          data-testid="gzip-cache-panel"
          className="bg-[#0d1526] border-b border-emerald-500/30 px-3 sm:px-4 py-3 text-xs z-20 shadow-xl flex flex-col gap-3 max-h-[52vh] overflow-y-auto"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-mono font-semibold flex items-center gap-1">
                <FileArchive className="w-3.5 h-3.5" />
                双层 Gzip 缓存引擎 (L1 浏览器 IndexedDB + L2 服务端多设备共享 /api/dwg-cache)
              </span>
              <span className="text-slate-400 hidden sm:inline">
                任意一台设备首次解码后自动同步至服务端磁盘 (.cache/dwg-gzip/)，局域网内其他设备或浏览器可直接共享秒开
              </span>
            </div>

            <div className="flex items-center gap-2">
              {activeCache && (
                <>
                  <button
                    type="button"
                    disabled={progress.isLoading}
                    data-testid="reload-from-gzip-btn"
                    onClick={() => {
                      setErrorBanner(null);
                      void engineRef.current?.loadFromCachedFingerprint(activeCache.fingerprint);
                    }}
                    className="px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-semibold flex items-center gap-1 transition-colors"
                    title="直接从 Gzip 缓存解压并渲染当前图纸（0ms 跳过 WASM）"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    <span>测试 Gzip 缓存秒开</span>
                  </button>

                  <button
                    type="button"
                    disabled={progress.isLoading}
                    onClick={() => void handleDownloadGzipFile(activeCache.fingerprint)}
                    className="px-2.5 py-1 rounded bg-indigo-600/80 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium flex items-center gap-1 transition-colors"
                  >
                    <HardDriveDownload className="w-3.5 h-3.5" />
                    <span>下载 .dwg.cache.gz</span>
                  </button>

                  <button
                    type="button"
                    disabled={progress.isLoading}
                    onClick={() => void handleLoadUrl(urlInput, satoken, undefined, true)}
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 border border-slate-700 flex items-center gap-1 transition-colors"
                    title="忽略缓存，强制重新执行 WASM 解码以对比耗时"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>强制重算 WASM</span>
                  </button>
                </>
              )}

              {cacheEntries.length > 0 && (
                <button
                  type="button"
                  disabled={progress.isLoading}
                  onClick={() => void engineRef.current?.clearAllCache()}
                  className="px-2 py-1 rounded bg-rose-950/60 hover:bg-rose-900/70 text-rose-300 border border-rose-500/30 flex items-center gap-1 transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>清空全部</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setShowCachePanel(false)}
                className="p-1 text-slate-400 hover:text-white"
                title="收起缓存面板"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Current Drawing Gzip Compression Metrics */}
          {activeCache && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 font-mono">
              <div className="bg-slate-900/90 border border-slate-800 rounded p-2">
                <div className="text-[10px] text-slate-400">当前加载模式</div>
                <div className="text-xs font-bold text-emerald-300 mt-0.5">
                  {activeCache.source === 'wasm-cold'
                    ? '首次 WASM 解码 -> 已同步共享'
                    : activeCache.source === 'local-gzip-file'
                    ? '⚡ 本地 .gz 文件直开'
                    : activeCache.source === 'server-gzip-shared'
                    ? '⚡ L2 服务端多端共享秒开'
                    : '⚡ L1 IndexedDB Gzip 秒开'}
                </div>
              </div>
              <div className="bg-slate-900/90 border border-slate-800 rounded p-2">
                <div className="text-[10px] text-slate-400">原始 DWG 体积</div>
                <div className="text-xs font-bold text-slate-200 mt-0.5">
                  {formatByteSize(activeCache.originalByteLength)}
                </div>
              </div>
              <div className="bg-slate-900/90 border border-slate-800 rounded p-2">
                <div className="text-[10px] text-slate-400">精简 JSON 中间体积</div>
                <div className="text-xs font-bold text-amber-300 mt-0.5">
                  {formatByteSize(activeCache.rawJsonBytes)}
                </div>
              </div>
              <div className="bg-slate-900/90 border border-slate-800 rounded p-2">
                <div className="text-[10px] text-slate-400">Gzip 压缩后 (.gz)</div>
                <div className="text-xs font-bold text-cyan-300 mt-0.5">
                  {formatByteSize(activeCache.compressedBytes)}{' '}
                  <span className="text-emerald-400">
                    (-{Math.round(activeCache.compressionRatio * 100)}%)
                  </span>
                </div>
              </div>
              <div className="bg-slate-900/90 border border-slate-800 rounded p-2">
                <div className="text-[10px] text-slate-400">WASM 解码 vs Gzip 解压</div>
                <div className="text-xs font-bold text-slate-200 mt-0.5">
                  {(activeCache.wasmParseMs / 1000).toFixed(2)}s vs{' '}
                  <span className="text-emerald-400">
                    {activeCache.decompressMs > 0 ? `${activeCache.decompressMs}ms` : '~35ms'}
                  </span>
                </div>
              </div>
              <div className="bg-slate-900/90 border border-slate-800 rounded p-2">
                <div className="text-[10px] text-slate-400">总图元数 / 图层数</div>
                <div className="text-xs font-bold text-slate-200 mt-0.5">
                  {activeCache.entityCount.toLocaleString()} 图元 / {activeCache.layerCount} 层
                </div>
              </div>
            </div>
          )}

          {/* Cached Gzip Entries Table */}
          <div className="flex flex-col gap-1.5">
            <div className="text-[11px] font-semibold text-slate-300 flex items-center justify-between">
              <span>
                已持久化的 Gzip 缓存记录 ({cacheEntries.length} 个 · 支持本机 IndexedDB 与局域网服务端多设备共享)
              </span>
              <span className="text-slate-400 font-normal">
                其他设备访问同一服务地址即可直接点击「秒开」免原图渲染，或「下载 .gz」离线保存
              </span>
            </div>

            {cacheEntries.length === 0 ? (
              <div className="bg-slate-900/60 border border-slate-800 rounded p-3 text-center text-slate-400">
                暂无 Gzip 缓存记录，加载任意 DWG 图纸后将自动生成并同步至服务端供多设备共享。
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {cacheEntries.map((item) => {
                  const isCurrent = activeCache?.fingerprint === item.fingerprint;
                  const scopeLabel =
                    item.storageScope === 'server-shared'
                      ? '🌐 服务端多端共享'
                      : item.storageScope === 'both'
                      ? '🌐 本机 + 服务端共享'
                      : '💻 仅本机浏览器';
                  return (
                    <div
                      key={item.fingerprint}
                      className={`flex items-center justify-between gap-2 p-2 rounded border font-mono ${
                        isCurrent
                          ? 'bg-emerald-950/30 border-emerald-500/40'
                          : 'bg-slate-900/70 border-slate-800'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs font-semibold text-slate-100 truncate">
                            {item.fileName}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-300 border border-cyan-500/30 shrink-0">
                            .gz: {formatByteSize(item.compressedBytes)} (-
                            {Math.round(item.compressionRatio * 100)}%)
                          </span>
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-950/80 text-indigo-300 border border-indigo-500/30 shrink-0">
                            {scopeLabel}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-400 mt-0.5 truncate">
                          原图 {formatByteSize(item.originalByteLength)} → JSON{' '}
                          {formatByteSize(item.rawJsonBytes)} · {item.entityCount.toLocaleString()}{' '}
                          图元 · 首次解码 {(item.wasmParseMs / 1000).toFixed(1)}s
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          disabled={progress.isLoading}
                          onClick={() =>
                            void engineRef.current?.loadFromCachedFingerprint(item.fingerprint)
                          }
                          className="px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white text-[11px] flex items-center gap-1"
                          title="从 Gzip 缓存直接秒开"
                        >
                          <Play className="w-3 h-3" />
                          <span>秒开</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDownloadGzipFile(item.fingerprint)}
                          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-slate-700 text-[11px] flex items-center gap-1"
                          title="导出为本地 .dwg.cache.gz 文件"
                        >
                          <HardDriveDownload className="w-3 h-3" />
                          <span>.gz</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void engineRef.current?.removeCacheEntry(item.fingerprint)}
                          className="p-1 rounded bg-slate-800 hover:bg-rose-900/60 text-slate-400 hover:text-rose-300 border border-slate-700"
                          title="删除此条缓存"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Expandable Sa-Token Configuration Bar */}
      {showSatokenInput && (
        <div className="bg-[#121a2c] border-b border-amber-500/30 px-3 py-2 flex items-center justify-between gap-3 text-xs z-20">
          <div className="flex items-center gap-2 flex-1 max-w-3xl min-w-0">
            <span className="font-mono text-amber-300 font-semibold flex items-center gap-1 shrink-0">
              <KeyRound className="w-3.5 h-3.5 text-amber-400" />
              Sa-Token:
            </span>
            <input
              type="text"
              value={satoken}
              onChange={(e) => handleUpdateSatoken(e.target.value)}
              placeholder="请输入或粘贴最新的 Sa-Token..."
              aria-label="Sa-Token 凭据"
              className="flex-1 px-2.5 py-1 text-xs font-mono bg-slate-950 border border-slate-700 rounded text-slate-200 focus:outline-none focus:border-amber-400 placeholder:text-slate-500"
            />
            <span className="text-[11px] text-slate-400 hidden lg:inline shrink-0">
              (已自动持久化至本地缓存)
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowSatokenInput(false)}
            className="text-slate-400 hover:text-white p-1"
            title="收起 Token 设置"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Hardware Compatibility Modal / Popover */}
      {showGpuModal && (
        <div className="bg-[#0f172a] border-b border-cyan-500/30 px-4 py-2.5 flex items-center justify-between gap-4 text-xs z-20 shadow-lg">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-slate-300 font-mono">
            <span className="flex items-center gap-1.5 text-white font-semibold">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              硬件兼容模式运行中
            </span>
            <span>
              核心类型:{' '}
              <strong className="text-cyan-300">
                {gpuInfo.gpuTier === 'dedicated'
                  ? '独立显卡 (NVIDIA/AMD)'
                  : gpuInfo.gpuTier === 'integrated'
                  ? '核心显卡 (Intel/AMD 集显)'
                  : 'CPU 软件光栅 / 云桌面模式'}
              </strong>
            </span>
            <span>
              设备内核: <strong className="text-slate-200">{gpuInfo.renderer}</strong>
            </span>
            <span>
              WebGL 规范:{' '}
              <strong className="text-emerald-300">{gpuInfo.webglVersion.toUpperCase()}</strong>
            </span>
            <span>
              最大纹理: <strong className="text-slate-200">{gpuInfo.maxTextureSize}px</strong>
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowGpuModal(false)}
            className="text-slate-400 hover:text-white p-1 shrink-0"
            title="关闭详情"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Error Alert Banner */}
      {errorBanner && (
        <div
          role="alert"
          className="bg-rose-950/95 border-b border-rose-500/40 px-4 py-1.5 flex items-center justify-between gap-3 text-xs text-rose-200 shrink-0 z-20"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{errorBanner}</span>
          </div>
          <button
            type="button"
            aria-label="关闭错误提示"
            onClick={() => setErrorBanner(null)}
            className="p-1 hover:bg-rose-900/60 rounded text-rose-300"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Full-Viewport WebGL CAD Canvas */}
      <main className="flex-1 relative overflow-hidden bg-[#0B0E17]">
        <div
          ref={viewportContainerRef}
          data-testid="mlightcad-viewport"
          className="w-full h-full relative outline-none"
        />

        {/* Multi-Stage Node Progress & Stepper Panel */}
        {progress.isLoading && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 w-[94vw] max-w-xl transition-all duration-300">
            <div className="bg-[#0c1322]/95 backdrop-blur-md border border-cyan-500/40 rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.65)] p-4 sm:p-5 text-slate-100 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shrink-0">
                      节点 {progress.currentStep}/{progress.totalSteps}
                    </span>
                    <span className="text-xs sm:text-sm font-bold text-white tracking-wide truncate">
                      {progress.stageTitle}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 font-mono line-clamp-1">
                    {progress.stageDetail}
                  </p>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <div className="flex flex-col items-end">
                    <span className="text-2xl sm:text-3xl font-black font-mono tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-sky-300 to-indigo-300">
                      {progress.percent}%
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5 text-cyan-400" />
                      耗时 {progress.elapsedSeconds}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsProgressCollapsed((v) => !v)}
                    className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                    title={isProgressCollapsed ? '展开节点详情' : '折叠详情'}
                  >
                    {isProgressCollapsed ? (
                      <ChevronDown className="w-4 h-4" />
                    ) : (
                      <ChevronUp className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              <div className="w-full bg-slate-900/90 h-2 sm:h-2.5 rounded-full overflow-hidden p-0.5 border border-slate-700/60 shadow-inner">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-sky-400 to-indigo-400 transition-all duration-150 ease-out shadow-[0_0_12px_rgba(34,211,238,0.6)]"
                  style={{ width: `${Math.max(4, Math.min(100, progress.percent))}%` }}
                />
              </div>

              {!isProgressCollapsed && (
                <div className="grid grid-cols-5 gap-1 sm:gap-2 pt-1 border-t border-slate-800/80">
                  {progress.nodes.map((node) => {
                    const isDone = node.status === 'completed';
                    const isActive = node.status === 'active';
                    return (
                      <div
                        key={node.id}
                        className={`flex flex-col items-center text-center gap-1 p-1 sm:p-1.5 rounded-lg transition-colors ${
                          isActive
                            ? 'bg-cyan-500/15 border border-cyan-500/30'
                            : isDone
                            ? 'bg-slate-800/40'
                            : 'opacity-40'
                        }`}
                      >
                        <div className="w-4 h-4 sm:w-5 sm:h-5 rounded-full flex items-center justify-center shrink-0">
                          {isDone ? (
                            <CheckCircle2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-400" />
                          ) : isActive ? (
                            <Loader2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-cyan-400 animate-spin" />
                          ) : (
                            <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
                          )}
                        </div>
                        <span
                          className={`text-[10px] sm:text-[11px] font-medium truncate max-w-full ${
                            isActive
                              ? 'text-cyan-300 font-semibold'
                              : isDone
                              ? 'text-slate-300'
                              : 'text-slate-500'
                          }`}
                        >
                          {node.title}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Drag-and-Drop Overlay */}
        {isDraggingOver && (
          <div className="absolute inset-0 z-30 bg-slate-950/85 border-2 border-dashed border-cyan-400 flex flex-col items-center justify-center gap-2 pointer-events-none">
            <Upload className="w-8 h-8 text-cyan-400" />
            <p className="text-sm font-medium text-white">
              释放鼠标以预览 .dwg 图纸，或直接秒开 .dwg.cache.gz 本地压缩缓存文件
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
