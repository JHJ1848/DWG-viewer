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
  ExternalLink,
  ShieldCheck,
} from 'lucide-react';
import {
  DwgViewerEngine,
  DwgLoadedMeta,
  DwgProgressState,
  DwgProgressNode,
} from './core/dwgViewerEngine';
import { validateDwgFileName } from './utils/dwgValidation';
import { detectGpuHardware, GpuHardwareInfo } from './utils/webglCompatibility';

const DEFAULT_DWG_URL = '/samples/baseline-sample.dwg';

const INITIAL_NODES: DwgProgressNode[] = [
  { id: 'FETCH_OR_READ', step: 1, title: '文件读取', status: 'active' },
  { id: 'WASM_DECODE', step: 2, title: 'WASM解码', status: 'pending' },
  { id: 'ENTITY_CONVERSION', step: 3, title: '图元构建', status: 'pending' },
  { id: 'FONT_LAYOUT', step: 4, title: '字体排版', status: 'pending' },
  { id: 'WEBGL_RENDER', step: 5, title: '视口呈现', status: 'pending' },
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
  const [gpuInfo, setGpuInfo] = useState<GpuHardwareInfo>(() => detectGpuHardware());
  const [showGpuModal, setShowGpuModal] = useState<boolean>(false);
  const [loadedMeta, setLoadedMeta] = useState<DwgLoadedMeta>({
    fileName: 'baseline-sample.dwg',
    fileSizeLabel: '87.0 KB',
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
      headers?: Record<string, string>
    ) => {
      const finalUrl = (targetUrl ?? urlInput).trim();
      const tokenToUse = customSatoken ?? satoken;
      setErrorBanner(null);
      await engineRef.current?.loadFromUrl(finalUrl, {
        satoken: tokenToUse,
        headers,
      });
    },
    [urlInput, satoken]
  );

  const handleLocalFile = useCallback(async (file: File) => {
    setErrorBanner(null);
    const validation = validateDwgFileName(file.name);
    if (!validation.valid) {
      setErrorBanner(validation.reason || '仅支持 .dwg 格式图纸');
      return;
    }
    const buffer = await file.arrayBuffer();
    await engineRef.current?.loadFromBuffer(file.name, buffer);
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
    });

    engine.mount(viewportContainerRef.current);
    engineRef.current = engine;
    (window as any).__cadEngine = engine;

    const initialUrl = getInitialUrlFromQuery();
    void engine.loadFromUrl(initialUrl, { satoken });

    // Support postMessage integration for parent Vue + Spring + MinIO system
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
      }
    };

    window.addEventListener('message', onWindowMessage);
    return () => {
      window.removeEventListener('message', onWindowMessage);
    };
  }, [handleUpdateSatoken, satoken]);

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
        accept=".dwg"
        aria-label="上传本地 DWG 文件"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleLocalFile(file);
          e.target.value = '';
        }}
      />

      {/* Responsive Top Bar: Adapts to Desktop Single-Row and Mobile Two-Row */}
      <header className="bg-[#0F1624] border-b border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-1.5 md:gap-2 px-2.5 sm:px-3 py-1.5 md:py-0 md:h-12 shrink-0 z-20">
        {/* Row 1 on mobile / Left group on desktop: File Info & Mobile Action Buttons */}
        <div className="flex items-center justify-between md:justify-start gap-2 min-w-0 w-full md:w-auto">
          {/* File Name & Size */}
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className="text-xs font-mono text-slate-200 truncate max-w-[120px] sm:max-w-[200px]"
              title={loadedMeta.fileName}
            >
              {loadedMeta.fileName}
            </span>
            <span className="text-[10px] sm:text-[11px] font-mono text-cyan-400 bg-cyan-950/60 border border-cyan-500/30 px-1.5 py-0.5 rounded shrink-0">
              {loadedMeta.fileSizeLabel}
            </span>
          </div>

          {/* Quick Actions on Mobile (Right of Row 1) */}
          <div className="flex items-center gap-1.5 md:hidden">
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
              onClick={() => setShowSatokenInput((v) => !v)}
              className={`p-1.5 rounded text-xs font-mono flex items-center transition-colors border ${
                showSatokenInput || satoken
                  ? 'bg-amber-950/40 text-amber-300 border-amber-500/40'
                  : 'bg-slate-800 text-slate-400 border-slate-700'
              }`}
              title="配置 Sa-Token"
            >
              <KeyRound className="w-3.5 h-3.5 text-amber-400" />
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

        {/* Row 2 on mobile / Center on desktop: URL input form */}
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
              placeholder="输入 MinIO 路径 (如 nonglintu/dwg/...) 或远程 URL..."
              aria-label="MinIO 或内部 DWG 文件地址"
              className="w-full pl-8 pr-2.5 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700/80 rounded focus:outline-none focus:border-cyan-400 text-slate-200 placeholder:text-slate-500"
            />
          </div>

          {/* Quick preset buttons */}
          <button
            type="button"
            onClick={() => {
              const path = 'nonglintu/dwg/1如意乡平图1.dwg';
              setUrlInput(path);
              void handleLoadUrl(path);
            }}
            className="hidden xl:flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium bg-cyan-950/40 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-900/40 transition-colors shrink-0"
            title="一键填入并加载 如意乡平图1.dwg"
          >
            <Database className="w-3 h-3 text-cyan-400" />
            <span>如意乡平图1</span>
          </button>
          <button
            type="button"
            onClick={() => {
              const farmlandPath = 'nonglintu/dwg/01俄洛镇格巴村总平图.dwg';
              setUrlInput(farmlandPath);
              void handleLoadUrl(farmlandPath);
            }}
            className="hidden 2xl:flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700/60 transition-colors shrink-0"
            title="一键填入农田 MinIO 总平图并加载"
          >
            <Database className="w-3 h-3 text-slate-400" />
            <span>俄洛镇总平图</span>
          </button>

          {/* Sa-Token Toggle Button (Desktop only) */}
          <button
            type="button"
            onClick={() => setShowSatokenInput((v) => !v)}
            className={`hidden md:flex px-2 py-1.5 rounded text-[11px] font-mono items-center gap-1 transition-colors shrink-0 border ${
              showSatokenInput || satoken
                ? 'bg-amber-950/40 text-amber-300 border-amber-500/40'
                : 'bg-slate-800 text-slate-400 border-slate-700'
            }`}
            title="配置 Sa-Token 鉴权凭证（支持随时替换并自动持久化保存）"
          >
            <KeyRound className="w-3 h-3 text-amber-400" />
            <span className="hidden lg:inline">Token</span>
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
            onClick={() => setShowGpuModal((v) => !v)}
            className={`hidden lg:flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-mono border transition-colors ${
              gpuInfo.gpuTier === 'dedicated'
                ? 'bg-emerald-950/40 text-emerald-300 border-emerald-500/40 hover:bg-emerald-900/50'
                : gpuInfo.gpuTier === 'integrated'
                ? 'bg-amber-950/40 text-amber-300 border-amber-500/40 hover:bg-amber-900/50'
                : 'bg-sky-950/40 text-sky-300 border-sky-500/40 hover:bg-sky-900/50'
            }`}
            title="查看当前机器图形硬件探测与 WebGL 兼容守护状态"
          >
            <Cpu className="w-3 h-3 text-cyan-400" />
            <span className="truncate max-w-[150px]">
              {gpuInfo.gpuTier === 'dedicated'
                ? '独显就绪'
                : gpuInfo.gpuTier === 'integrated'
                ? '核显兼容'
                : '通用兼容'}
              : {gpuInfo.renderer.split('(')[0].replace(/ANGLE|Direct3D11|vs_\d+_\d+|ps_\d+_\d+/gi, '').trim() || 'WebGL'}
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
            <span className="hidden sm:inline">居中复位</span>
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 rounded text-xs font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-950 flex items-center gap-1.5 transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>上传 DWG</span>
          </button>
        </div>
      </header>

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
              placeholder="请输入或粘贴最新的 Sa-Token (如 7e3ee0e3-6041-45f4-9121-9783e7c81a98)..."
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
              WebGL 规范: <strong className="text-emerald-300">{gpuInfo.webglVersion.toUpperCase()}</strong>
            </span>
            <span>
              最大纹理: <strong className="text-slate-200">{gpuInfo.maxTextureSize}px</strong>
            </span>
            <span className="text-emerald-400 text-[11px]">
              ✔ 全图元 100% 原始矢量呈现 · TDR 驱动自愈守护就绪
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

      {/* Full-Viewport WebGL CAD Canvas (Supports Wheel Zoom & Drag Pan) */}
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
              {/* Header: Stage Badge + Elapsed Time + Large Percent */}
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

              {/* Glowing Dynamic Progress Bar */}
              <div className="w-full bg-slate-900/90 h-2 sm:h-2.5 rounded-full overflow-hidden p-0.5 border border-slate-700/60 shadow-inner">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-sky-400 to-indigo-400 transition-all duration-150 ease-out shadow-[0_0_12px_rgba(34,211,238,0.6)]"
                  style={{ width: `${Math.max(4, Math.min(100, progress.percent))}%` }}
                />
              </div>

              {/* 5-Step Stepper List */}
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
            <p className="text-sm font-medium text-white">释放鼠标以解析并预览该 .dwg 图纸</p>
          </div>
        )}
      </main>
    </div>
  );
}
