import { version as appVersion } from '../package.json';
import { Capacitor } from '@capacitor/core';
import { useLanguage, setLanguage } from './utils/language';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ResourceMeter } from './components/ResourceMeter';
import { AboutDialog, DrawingRow, IconButton, ValueTag } from './components/WorkspaceUI';
import {
  Upload,
  Scan,
  AlertTriangle,
  X,
  Loader2,
  CheckCircle2,
  Clock,
  Cpu,
  ChevronDown,
  ChevronUp,
  Database,
  ShieldCheck,
  HardDriveDownload,
  Zap,
  RotateCcw,
  Trash2,
  FileArchive,
  Play,
  Cloud,
  FolderOpen,
  RefreshCw,
  SlidersHorizontal,
  Eye,
  EyeOff,
  Home,
  Share2,
  Check,
  History,
  ArrowUpRight,
  Info,
  Hand,
  BoxSelect,
} from 'lucide-react';
import {
  DwgViewerEngine,
  DwgLoadedMeta,
  DwgProgressState,
  DwgProgressNode,
} from './core/dwgViewerEngine';
import { formatByteSize, validateDwgOrCacheFileName } from './utils/dwgValidation';
import { detectGpuHardware, GpuHardwareInfo } from './utils/webglCompatibility';
import {
  findGzipCacheByFileName,
  LocalGzipCacheMeta,
} from './utils/dwgLocalCacheStore';
import { normalizeDwgFileNameForConverter } from './utils/dwgGzipCache';
import { getDeviceMemoryProfile } from './utils/deviceProfile';
import {
  buildBuiltinFetchUrl,
  buildDwgRouteUrl,
  DwgRouteState,
  isDefaultSamplesWorkspaceDir,
  normalizeMinioObjectPath,
  parseDwgRouteFromLocation,
} from './utils/dwgRouter';

export type DwgSourceMode = 'builtin' | 'minio' | 'local';
export type AppViewMode = 'home' | 'viewer';

export interface SampleFileItem {
  name: string;
  url: string;
  size: number;
  sizeLabel: string;
  workspaceDir?: string;
}

export interface MinioRemoteFileItem {
  key: string;
  name: string;
  bucket: string;
  path: string;
  url: string;
  size: number;
  sizeLabel: string;
  lastModified: string;
}

export interface MinioStatusState {
  checking: boolean;
  connected: boolean;
  latencyMs?: number;
  endpoint: string;
  bucket: string;
  prefix: string;
  error?: string;
  files: MinioRemoteFileItem[];
}

const FALLBACK_SAMPLES: SampleFileItem[] = [
  {
    name: 'canteen.dwg',
    url: '/samples/canteen.dwg',
    size: 2618816,
    sizeLabel: '2.50 MB',
  },
];

// [03_ui_design] MinIO 凭据代码脱敏与纯本地存储：严禁在代码库硬编码敏感密钥，所有配置仅保存在客户端 localStorage
const DEFAULT_MINIO_ENDPOINT = '';
const DEFAULT_MINIO_ACCESS_KEY = '';
const DEFAULT_MINIO_SECRET_KEY = '';
const DEFAULT_MINIO_BUCKET = '';
const DEFAULT_MINIO_PATH = '';

const INITIAL_NODES: DwgProgressNode[] = [
  { id: 'FETCH_OR_READ', step: 1, title: '文件读取与校验', status: 'active' },
  { id: 'WASM_DECODE', step: 2, title: '图纸解码 / 缓存读取', status: 'pending' },
  { id: 'ENTITY_CONVERSION', step: 3, title: 'CAD 图元模型构建', status: 'pending' },
  { id: 'FONT_LAYOUT', step: 4, title: '矢量字体与排版', status: 'pending' },
  { id: 'WEBGL_RENDER', step: 5, title: 'WebGL 视口呈现', status: 'pending' },
];

/**
 * 定制 CAD 几何品牌徽标矢量 SVG（克制简约线性工程风格）
 */
function CadBrandLogoSvg({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="4" className="stroke-slate-400" />
      <path d="M3 9h18M9 3v18" className="stroke-slate-600" />
      <circle cx="14.5" cy="14.5" r="3.2" className="stroke-sky-400" />
      <path d="M14.5 9.5v2M14.5 17.5v2M9.5 14.5h2M17.5 14.5h2" className="stroke-sky-400" />
    </svg>
  );
}

function getInitialRouteState(): DwgRouteState {
  if (typeof window === 'undefined') {
    return { mode: 'home' };
  }
  return parseDwgRouteFromLocation(
    window.location.pathname,
    window.location.search,
    window.location.hash
  );
}

/**
 * 缩短长文件夹路径以便在紧凑下拉按钮中展示，同时保留首尾可读关键信息。
 */
function formatShortDirLabel(dirPath: string): string {
  const cleaned = (dirPath || '').trim();
  if (!cleaned || isDefaultSamplesWorkspaceDir(cleaned)) {
    return 'public/samples (默认)';
  }
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return cleaned;
  return `${parts[0]}\\...\\${parts.slice(-2).join('\\')}`;
}

export default function App() {
  const { language, t } = useLanguage();
  const viewportContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const engineRef = useRef<DwgViewerEngine | null>(null);

  const initialRoute = getInitialRouteState();

  // 视图层级：'home' 展示首页三组文件工作台，'viewer' 展示全屏 CAD 预览画布
  const [viewMode, setViewMode] = useState<AppViewMode>(() =>
    initialRoute.mode === 'home' ? 'home' : 'viewer'
  );
  const [hasLoadedAnyDrawing, setHasLoadedAnyDrawing] = useState<boolean>(false);

  // 三模式状态：'builtin' | 'minio' | 'local'
  const [sourceMode, setSourceMode] = useState<DwgSourceMode>(() =>
    initialRoute.mode === 'minio'
      ? 'minio'
      : initialRoute.mode === 'local'
      ? 'local'
      : 'builtin'
  );
  const sourceModeRef = useRef<DwgSourceMode>(sourceMode);
  useEffect(() => {
    sourceModeRef.current = sourceMode;
  }, [sourceMode]);

  const [urlInput, setUrlInput] = useState<string>(() => {
    if (initialRoute.mode === 'builtin' && initialRoute.filePath) {
      return buildBuiltinFetchUrl(initialRoute.filePath, initialRoute.workspaceDir);
    }
    if (initialRoute.mode === 'minio' && initialRoute.filePath) {
      return initialRoute.filePath;
    }
    return FALLBACK_SAMPLES[0].url;
  });

  // 方式 1：项目内置 / 自定义工作区（~/.dwgViewer/config.json 持久化记忆）
  const [samples, setSamples] = useState<SampleFileItem[]>(FALLBACK_SAMPLES);
  const [activeWorkspaceDir, setActiveWorkspaceDir] = useState<string>(
    () => initialRoute.workspaceDir || 'public/samples'
  );
  const activeWorkspaceDirRef = useRef<string>(activeWorkspaceDir);
  useEffect(() => {
    activeWorkspaceDirRef.current = activeWorkspaceDir;
  }, [activeWorkspaceDir]);

  const [isDefaultWorkspace, setIsDefaultWorkspace] = useState<boolean>(() =>
    isDefaultSamplesWorkspaceDir(initialRoute.workspaceDir)
  );
  const [workspaceHistory, setWorkspaceHistory] = useState<string[]>(['public/samples']);
  const [workspaceConfigFile, setWorkspaceConfigFile] = useState<string>(
    '~/.dwgViewer/config.json'
  );
  const [customWorkspaceInput, setCustomWorkspaceInput] = useState<string>(
    () => initialRoute.workspaceDir || ''
  );
  const [showWorkspaceModal, setShowWorkspaceModal] = useState<boolean>(false);
  const [isScanningSamples, setIsScanningSamples] = useState<boolean>(false);
  const [showSampleDropdown, setShowSampleDropdown] = useState<boolean>(false);
  const sampleDropdownRef = useRef<HTMLDivElement | null>(null);

  // 方式 2：MinIO 直连（支持自定义 Endpoint URL + AccessKey + SecretKey + Bucket，纯本地存储脱敏）
  const [savedMinio] = useState(() => {
    try {
      const raw = localStorage.getItem('dwg_minio_config');
      if (raw) return JSON.parse(raw) || {};
      return Object.fromEntries(Object.entries({
        endpoint: 'endpoint', accessKey: 'access_key', secretKey: 'secret_key', bucket: 'bucket'
      }).map(([key, suffix]) => [key, localStorage.getItem('cad_minio_' + suffix) || '']));
    } catch { return {}; }
  });
  const initialEndpoint = initialRoute.minioEndpoint || savedMinio.endpoint || '';
  const sameEndpoint = initialEndpoint === savedMinio.endpoint;
  const [minioEndpoint, setMinioEndpoint] = useState<string>(initialEndpoint);
  const minioEndpointRef = useRef(minioEndpoint);
  useEffect(() => { minioEndpointRef.current = minioEndpoint; }, [minioEndpoint]);
  const [minioAccessKey, setMinioAccessKey] = useState<string>(sameEndpoint ? savedMinio.accessKey || '' : '');
  const [minioSecretKey, setMinioSecretKey] = useState<string>(sameEndpoint ? savedMinio.secretKey || '' : '');
  const [minioBucket, setMinioBucket] = useState<string>(sameEndpoint ? savedMinio.bucket || '' : '');
  const [minioPathInput, setMinioPathInput] = useState<string>(() => {
    if (initialRoute.mode === 'minio' && initialRoute.filePath) {
      return initialRoute.filePath;
    }
    return DEFAULT_MINIO_PATH;
  });
  const [showMinioConfigBar, setShowMinioConfigBar] = useState<boolean>(false);
  const [showSecretKeyPlain, setShowSecretKeyPlain] = useState<boolean>(false);
  const [showMinioDropdown, setShowMinioDropdown] = useState<boolean>(false);
  const minioDropdownRef = useRef<HTMLDivElement | null>(null);
  // [03_ui_design] MinIO 成功读取图纸本地历史记忆与下拉列表
  const [minioHistoryPaths, setMinioHistoryPaths] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem('dwg_minio_history_paths');
      return stored ? (JSON.parse(stored) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [showMinioHistoryDropdown, setShowMinioHistoryDropdown] = useState<boolean>(false);
  const minioHistoryDropdownRef = useRef<HTMLDivElement | null>(null);

  // [03_ui_design] 本地上传持久化保存至当前工作区勾选状态 (默认记忆上次偏好)
  const [saveToWorkspace, setSaveToWorkspace] = useState<boolean>(() => {
    try {
      return localStorage.getItem('dwg_save_to_workspace') === 'true';
    } catch {
      return false;
    }
  });

  // [03_ui_design] 本地上传独立下拉浮层
  const [showLocalDropdown, setShowLocalDropdown] = useState<boolean>(false);
  const localDropdownRef = useRef<HTMLDivElement | null>(null);

  // [09_viewport_interaction] 视口交互操控体系：默认平移漫游模式、空格抓手映射与视口按下状态
  const [activeViewerTool, setActiveViewerTool] = useState<'pan' | 'select' | 'edit'>('pan');
  const [isSpacePressed, setIsSpacePressed] = useState<boolean>(false);
  const prevToolBeforeSpaceRef = useRef<'pan' | 'select' | null>(null);

  /**
   * [09_viewport_interaction] 视口交互模式切换（平移漫游 / 框选查看 / 编辑模式预留）
   * 默认平移漫游 (AcEdViewMode.PAN = 1)，协同底层 dwgViewerEngine 设置 view.mode
   */
  const handleSwitchViewerTool = useCallback((tool: 'pan' | 'select' | 'edit') => {
    if (tool === 'edit') return;
    setActiveViewerTool(tool);
    try {
      engineRef.current?.setViewMode(tool);
      const docManager = (window as any).__cadDocManager;
      if (docManager) {
        if (tool === 'select') {
          docManager.editor?.handleEscape?.();
        }
      }
    } catch (err) {
      console.warn('[ViewerTool] Failed to switch viewer tool:', err);
    }
  }, []);

  // [09_viewport_interaction] 全局空格键抓手映射与视口光标状态联动（捕获阶段拦截 + 按钮焦点剥夺防污染）
  useEffect(() => {
    const isTypingInInput = () => {
      const activeEl = document.activeElement;
      if (!activeEl) return false;
      const tagName = activeEl.tagName;
      return (
        tagName === 'INPUT' ||
        tagName === 'TEXTAREA' ||
        (activeEl as HTMLElement).isContentEditable
      );
    };

    const handleKeyDownCapture = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]') || e.target instanceof HTMLElement && e.target.closest('button, summary, [role="dialog"]')) return;
      if (e.code === 'Space') {
        if (isTypingInInput()) return;

        // [09_viewport_interaction] 核心焦点防护：立即强行剥夺聚焦按钮的焦点，彻底杜绝空格键触发按钮 click 污染！
        if (document.activeElement && document.activeElement !== document.body) {
          (document.activeElement as HTMLElement)?.blur?.();
        }

        // 强行阻止浏览器默认向下滚动及事件向下乱穿
        e.preventDefault();
        e.stopPropagation();

        if (e.repeat) return;

        // 记录按住空格前的工具状态（例如当时处于框选模式）
        if (prevToolBeforeSpaceRef.current === null) {
          prevToolBeforeSpaceRef.current = activeViewerTool === 'edit' ? 'pan' : activeViewerTool;
        }

        setIsSpacePressed(true);
        // 临时切至底层平移漫游模式
        engineRef.current?.setViewMode('pan');
        setActiveViewerTool('pan');
      } else if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingInInput()) {
        handleSwitchViewerTool('select');
      } else if (e.code === 'KeyH' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingInInput()) {
        handleSwitchViewerTool('pan');
      }
    };

    const handleKeyUpCapture = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        if (isTypingInInput()) return;

        e.preventDefault();
        e.stopPropagation();

        setIsSpacePressed(false);
        // 松开空格键时恢复之前的工具模式
        if (prevToolBeforeSpaceRef.current) {
          const prevTool = prevToolBeforeSpaceRef.current;
          prevToolBeforeSpaceRef.current = null;
          setActiveViewerTool(prevTool);
          engineRef.current?.setViewMode(prevTool);
        }
      }
    };

    const handleBlur = () => {
      // 窗口失焦安全兜底：防止用户切窗口时遗留空格按下状态
      setIsSpacePressed(false);
      if (prevToolBeforeSpaceRef.current) {
        const prevTool = prevToolBeforeSpaceRef.current;
        prevToolBeforeSpaceRef.current = null;
        setActiveViewerTool(prevTool);
        engineRef.current?.setViewMode(prevTool);
      }
    };

    window.addEventListener('keydown', handleKeyDownCapture, { capture: true });
    window.addEventListener('keyup', handleKeyUpCapture, { capture: true });
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDownCapture, { capture: true });
      window.removeEventListener('keyup', handleKeyUpCapture, { capture: true });
      window.removeEventListener('blur', handleBlur);
    };
  }, [activeViewerTool, handleSwitchViewerTool]);

  const [minioStatus, setMinioStatus] = useState<MinioStatusState>({
    checking: false,
    connected: false,
    endpoint: DEFAULT_MINIO_ENDPOINT,
    bucket: DEFAULT_MINIO_BUCKET,
    prefix: 'dwg/',
    files: [],
  });

  // 分享链接复制反馈
  const [copiedShareUrl, setCopiedShareUrl] = useState<boolean>(false);

  // 画布、GPU 与 Gzip 缓存状态
  const [gpuInfo] = useState<GpuHardwareInfo>(() => detectGpuHardware());
  const [showMemoryTip, setShowMemoryTip] = useState(false);
  const [showGpuModal, setShowGpuModal] = useState<boolean>(false);
  // [03_ui_design] 版本查看与关于弹窗交互状态
  const [showAboutModal, setShowAboutModal] = useState<boolean>(false);
  const [defenseMode, setDefenseMode] = useState<boolean>(() => {
    return getDeviceMemoryProfile().defenseModeEnabled;
  });
  const [showCachePanel, setShowCachePanel] = useState<boolean>(false);
  const [cacheEntries, setCacheEntries] = useState<LocalGzipCacheMeta[]>([]);
  const [loadedMeta, setLoadedMeta] = useState<DwgLoadedMeta>({
    fileName: initialRoute.filePath || '未选择图纸',
    fileSizeLabel: '--',
    versionLabel: 'AutoCAD DWG',
  });
  const [progress, setProgress] = useState<DwgProgressState>({
    isLoading: initialRoute.mode !== 'home',
    percent: 5,
    currentStep: 1,
    totalSteps: 5,
    stageId: 'FETCH_OR_READ',
    stageTitle: t("文件读取与校验"),
    stageDetail: '正在初始化引擎与加载文件...',
    elapsedMs: 0,
    elapsedSeconds: '0.0s',
    pipelineMode: 'detecting',
    nodes: INITIAL_NODES,
  });
  const [isProgressCollapsed, setIsProgressCollapsed] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);

  /**
   * 同步更新浏览器 URL 地址栏（支持复制 URL 直接分享当前图纸路径）。
   */
  const detailRoute = useRef<DwgRouteState | null>(null);
  const detailReady = useRef(false);
  const syncBrowserRouteUrl = useCallback(
    (route: DwgRouteState, replace = false) => {
      if (typeof window === 'undefined') return;
      const targetUrl = buildDwgRouteUrl(route);
      if (route.mode !== 'home') {
        if (!replace && (!detailRoute.current || buildDwgRouteUrl(detailRoute.current) !== targetUrl)) {
          detailReady.current = false;
          setHasLoadedAnyDrawing(false);
        }
        detailRoute.current = route;
      }
      const currentFull = `${window.location.pathname}${window.location.search}`;
      if (currentFull === targetUrl) return;
      if (replace) {
        window.history.replaceState(route, '', targetUrl);
      } else {
        window.history.pushState(route, '', targetUrl);
      }
    },
    []
  );

  const resumeDetail = useCallback((route = detailRoute.current) => {
    if (!detailReady.current || !route || !detailRoute.current ||
        buildDwgRouteUrl(route) !== buildDwgRouteUrl(detailRoute.current)) return false;
    setViewMode('viewer');
    syncBrowserRouteUrl(route);
    return true;
  }, [syncBrowserRouteUrl]);

  /**
   * [03_ui_design] 复制当前图纸分享链接至剪贴板，自动解析真实局域网 IP+Port 杜绝 localhost / file://
   */
  const handleCopyShareUrl = useCallback(async () => {
    if (typeof window === 'undefined') return;
    let shareUrl = window.location.href;
    try {
      const res = await fetch('/api/network-info');
      if (res.ok) {
        const info = await res.json();
        if (info?.ip && info.ip !== '127.0.0.1') {
          try {
            const u = new URL(shareUrl);
            u.hostname = info.ip;
            if (info.port) u.port = String(info.port);
            shareUrl = u.toString();
          } catch {
            const path = window.location.pathname.startsWith('/')
              ? window.location.pathname
              : `/${window.location.pathname}`;
            shareUrl = `http://${info.ip}:${info.port || 3000}${path}${window.location.search}`;
          }
        }
      }
    } catch (err) {
      console.warn('[Share] Failed to resolve LAN IP, fallback to current URL:', err);
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedShareUrl(true);
      setTimeout(() => setCopiedShareUrl(false), 2000);
    } catch {
      // Fallback textarea copy
      const input = document.createElement('input');
      input.value = shareUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      setCopiedShareUrl(true);
      setTimeout(() => setCopiedShareUrl(false), 2000);
    }
  }, []);

  /**
   * 构造 MinIO S3 自定义连接请求头。只有主动保存设置时才持久化配置。
   */
  const getMinioHeaders = useCallback(
    (overrideUrlOrPath?: string, customEndpointOverride?: string, save = false): Record<string, string> => {
      let effectiveEndpoint = (customEndpointOverride ?? minioEndpointRef.current).trim();
      if (
        overrideUrlOrPath &&
        (overrideUrlOrPath.startsWith('http://') || overrideUrlOrPath.startsWith('https://')) &&
        !overrideUrlOrPath.includes(':9090/browser/')
      ) {
        try {
          const parsed = new URL(overrideUrlOrPath);
          if (parsed.origin) {
            effectiveEndpoint = parsed.origin;
          }
        } catch {
          // Keep configured minioEndpoint
        }
      }
      if (save && typeof window !== 'undefined') {
        try {
          localStorage.setItem(
            'dwg_minio_config',
            JSON.stringify({
              endpoint: effectiveEndpoint,
              accessKey: minioAccessKey.trim(),
              secretKey: minioSecretKey.trim(),
              bucket: minioBucket.trim(),
            })
          );
        } catch {}
        localStorage.setItem('cad_minio_endpoint', effectiveEndpoint);
        localStorage.setItem(
          'cad_minio_access_key',
          minioAccessKey.trim()
        );
        localStorage.setItem(
          'cad_minio_secret_key',
          minioSecretKey.trim()
        );
        localStorage.setItem('cad_minio_bucket', minioBucket.trim());
      }
      return {
        'x-minio-endpoint': effectiveEndpoint,
        'x-minio-access-key': effectiveEndpoint === minioEndpoint ? minioAccessKey.trim() : '',
        'x-minio-secret-key': effectiveEndpoint === minioEndpoint ? minioSecretKey.trim() : '',
        'x-minio-bucket': minioBucket.trim(),
      };
    },
    [minioEndpoint, minioAccessKey, minioSecretKey, minioBucket]
  );

  const handleResetMinioConfig = useCallback(() => {
    setMinioEndpoint(DEFAULT_MINIO_ENDPOINT);
    setMinioAccessKey(DEFAULT_MINIO_ACCESS_KEY);
    setMinioSecretKey(DEFAULT_MINIO_SECRET_KEY);
    setMinioBucket(DEFAULT_MINIO_BUCKET);
    setMinioStatus({ checking: false, connected: false, endpoint: '', bucket: '', prefix: 'dwg/', files: [] });
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem('dwg_minio_config');
      } catch {}
      localStorage.removeItem('cad_minio_endpoint');
      localStorage.removeItem('cad_minio_access_key');
      localStorage.removeItem('cad_minio_secret_key');
      localStorage.removeItem('cad_minio_bucket');
    }
  }, []);

  const toggleDefenseMode = useCallback(() => {
    setDefenseMode((prev) => {
      const next = !prev;
      engineRef.current?.setDefenseMode(next);
      return next;
    });
  }, []);

  /**
   * 方式 1：扫描内置 `public/samples` 或用户在 `~/.dwgViewer/config.json` 中配置的自定义工作区目录。
   */
  const fetchSamples = useCallback(async (overrideDir?: string) => {
    setIsScanningSamples(true);
    try {
      const query = overrideDir ? `?dir=${encodeURIComponent(overrideDir)}` : '';
      const res = await fetch(`/api/workspace${query}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      if (Array.isArray(data)) {
        setSamples(data);
      } else if (data && typeof data === 'object') {
        if (Array.isArray(data.samples)) {
          setSamples(data.samples);
        }
        if (typeof data.activeDir === 'string') {
          setActiveWorkspaceDir(data.activeDir);
          setCustomWorkspaceInput(data.activeDir);
          setIsDefaultWorkspace(Boolean(data.isDefaultDir));
        }
        if (Array.isArray(data.historyDirs) && data.historyDirs.length > 0) {
          setWorkspaceHistory(data.historyDirs);
        }
        if (typeof data.configFilePath === 'string') {
          setWorkspaceConfigFile(data.configFilePath);
        }
      }
    } catch (err) {
      console.warn('[App] Failed to fetch workspace samples, using fallback:', err);
    } finally {
      setIsScanningSamples(false);
    }
  }, []);

  /**
   * 切换方式 1 的默认工作区目录并写入 `~/.dwgViewer/config.json`。
   */
  const handleSwitchWorkspaceDir = useCallback(async (targetDir: string) => {
    const trimmed = targetDir.trim();
    if (!trimmed) return;
    setIsScanningSamples(true);
    setErrorBanner(null);
    try {
      const res = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorBanner(data?.error || '切换工作区目录失败');
        return;
      }
      if (Array.isArray(data.samples)) {
        setSamples(data.samples);
      }
      if (typeof data.activeDir === 'string') {
        setActiveWorkspaceDir(data.activeDir);
        setCustomWorkspaceInput(data.activeDir);
        setIsDefaultWorkspace(Boolean(data.isDefaultDir));
      }
      if (Array.isArray(data.historyDirs)) {
        setWorkspaceHistory(data.historyDirs);
      }
      if (typeof data.configFilePath === 'string') {
        setWorkspaceConfigFile(data.configFilePath);
      }
      setShowWorkspaceModal(false);
    } catch (err: any) {
      const isFailedToFetch =
        err?.message?.includes('Failed to fetch') || err?.message?.includes('NetworkError');
      setErrorBanner(
        isFailedToFetch
          ? '无法连接本地后台服务（请检查 3000 端口或确认服务已启动）'
          : err?.message || '切换工作区目录请求异常'
      );
    } finally {
      setIsScanningSamples(false);
    }
  }, []);

  /**
   * [03_ui_design] 便携式/桌面端一键选择本地图纸文件夹，Web 端自动聚焦输入框
   */
  const handleSelectWorkspaceFolder = useCallback(async () => {
    if (typeof window !== 'undefined' && window.electronAPI?.selectDirectory) {
      try {
        const picked = await window.electronAPI.selectDirectory();
        if (picked) {
          setCustomWorkspaceInput(picked);
          void handleSwitchWorkspaceDir(picked);
        }
      } catch (err) {
        console.warn('[Workspace] selectDirectory cancelled or failed:', err);
      }
    } else {
      // 纯 Web 环境：聚焦工作台自定义路径输入框或展开面板
      const el = document.getElementById('home-custom-workspace-input');
      if (el) {
        el.focus();
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        setShowWorkspaceModal(true);
      }
    }
  }, [handleSwitchWorkspaceDir]);

  /**
   * 从 `~/.dwgViewer/config.json` 历史记忆中删除指定工作区目录。
   */
  const handleRemoveWorkspaceHistory = useCallback(async (dirToRemove: string) => {
    try {
      const res = await fetch(
        `/api/workspace/history?dir=${encodeURIComponent(dirToRemove)}`,
        { method: 'DELETE' }
      );
      const data = await res.json();
      if (res.ok && data) {
        if (Array.isArray(data.samples)) setSamples(data.samples);
        if (typeof data.activeDir === 'string') {
          setActiveWorkspaceDir(data.activeDir);
          setCustomWorkspaceInput(data.activeDir);
          setIsDefaultWorkspace(Boolean(data.isDefaultDir));
        }
        if (Array.isArray(data.historyDirs)) {
          setWorkspaceHistory(data.historyDirs);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  /**
   * 方式 2：探测 MinIO S3 连通性并列出桶内 `.dwg` 图纸列表。
   */
  const checkMinioStatus = useCallback(
    async (customEndpointOverride?: string, save = false) => {
      setMinioStatus((prev) => ({ ...prev, checking: true, error: undefined }));
      try {
        const headers = getMinioHeaders(undefined, customEndpointOverride, save);
        const res = await fetch('/api/minio/status?prefix=dwg/', { headers });
        const data = await res.json();
        if (!res.ok || !data.connected) {
          setMinioStatus({
            checking: false,
            connected: false,
            latencyMs: data.latencyMs,
            endpoint: data.endpoint || customEndpointOverride || minioEndpointRef.current,
            bucket: data.bucket || minioBucket,
            prefix: data.prefix || 'dwg/',
            error: data.configured === false ? undefined : data.error || `HTTP ${res.status}`,
            files: [],
          });
          return;
        }

        const remoteFiles: MinioRemoteFileItem[] = Array.isArray(data.files) ? data.files : [];
        setMinioStatus({
          checking: false,
          connected: true,
          latencyMs: data.latencyMs,
          endpoint: data.endpoint || customEndpointOverride || minioEndpointRef.current,
          bucket: data.bucket || minioBucket,
          prefix: data.prefix || 'dwg/',
          files: remoteFiles,
        });
      } catch (err: any) {
        const isFailedToFetch =
          err?.message?.includes('Failed to fetch') || err?.message?.includes('NetworkError');
        const errorDesc = isFailedToFetch
          ? '本地后端服务通信异常或未就绪（请检查 3000 端口）'
          : err?.message || 'MinIO 连通性探测失败';
        setMinioStatus((prev) => ({
          ...prev,
          checking: false,
          connected: false,
          error: errorDesc,
          files: [],
        }));
      }
    },
    [getMinioHeaders, minioBucket]
  );

  /**
   * 加载内置/工作区 URL 或 MinIO 远程图纸。
   */
  const handleLoadUrl = useCallback(
    async (
      targetUrl?: string,
      customHeaders?: Record<string, string>,
      bypassCache = false
    ) => {
      const finalUrl = (targetUrl ?? urlInput).trim();
      if (!finalUrl) return;
      setErrorBanner(null);
      setViewMode('viewer');
      const isSampleOrWorkspace =
        finalUrl.startsWith('/samples/') ||
        finalUrl.startsWith('samples/') ||
        finalUrl.startsWith('/api/workspace/file');
      const mergedHeaders = isSampleOrWorkspace
        ? customHeaders
        : { ...getMinioHeaders(finalUrl), ...(customHeaders || {}) };

      await engineRef.current?.loadFromUrl(finalUrl, {
        headers: mergedHeaders,
        bypassCache,
      });
    },
    [urlInput, getMinioHeaders]
  );

  /**
   * 方式 1 快捷打开：打开内置或自定义工作区图纸，并实时将 URL 更新为 `/builtin/:fileName(?dir=...)`。
   */
  const handleOpenBuiltinDrawing = useCallback(
    async (item: SampleFileItem, matchedCache?: LocalGzipCacheMeta) => {
      const dir = item.workspaceDir || activeWorkspaceDirRef.current;
      const isDef = isDefaultSamplesWorkspaceDir(dir);
      setErrorBanner(null);
      setSourceMode('builtin');
      setViewMode('viewer');
      setUrlInput(item.url);
      setShowSampleDropdown(false);

      const route: DwgRouteState = {
        mode: 'builtin',
        filePath: item.name,
        workspaceDir: isDef ? undefined : dir,
      };
      if (resumeDetail(route)) return;
      syncBrowserRouteUrl(route);

      if (matchedCache) {
        await engineRef.current?.loadFromCachedFingerprint(matchedCache.fingerprint);
      } else {
        await handleLoadUrl(item.url);
      }
    },
    [handleLoadUrl, syncBrowserRouteUrl]
  );

  /**
   * [03_ui_design] 记录成功访问的 MinIO 图纸路径至 LocalStorage 历史记忆
   */
  const recordMinioHistoryPath = useCallback((path: string) => {
    const clean = path.trim();
    if (!clean) return;
    setMinioHistoryPaths((prev) => {
      const next = [clean, ...prev.filter((p) => p !== clean)].slice(0, 15);
      try {
        localStorage.setItem('dwg_minio_history_paths', JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  /**
   * [03_ui_design] 清除某条或全量 MinIO 历史记录
   */
  const handleClearMinioHistory = useCallback((pathToRemove?: string) => {
    setMinioHistoryPaths((prev) => {
      const next = pathToRemove ? prev.filter((p) => p !== pathToRemove) : [];
      try {
        localStorage.setItem('dwg_minio_history_paths', JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  /**
   * [03_ui_design] 切换是否将本地上传图纸持久化保存至工作区
   */
  const handleToggleSaveToWorkspace = useCallback((checked: boolean) => {
    setSaveToWorkspace(checked);
    try {
      localStorage.setItem('dwg_save_to_workspace', String(checked));
    } catch {
      // ignore
    }
  }, []);

  /**
   * 方式 2 快捷打开：打开 MinIO 远程图纸，并实时将 URL 更新为 `/minio/:bucket/...key(?endpoint=...)`。
   */
  const handleOpenMinioDrawing = useCallback(
    async (rawPathOrUrl: string, matchedCache?: LocalGzipCacheMeta) => {
      const cleanMinioPath = normalizeMinioObjectPath(rawPathOrUrl, minioBucket);
      if (!cleanMinioPath) return;
      setErrorBanner(null);
      setSourceMode('minio');
      setViewMode('viewer');
      setMinioPathInput(cleanMinioPath);
      setUrlInput(cleanMinioPath);
      setShowMinioDropdown(false);
      setShowMinioHistoryDropdown(false);
      // [03_ui_design] 记录到浏览器本地历史记忆
      recordMinioHistoryPath(cleanMinioPath);

      const route: DwgRouteState = {
        mode: 'minio',
        filePath: cleanMinioPath,
        minioEndpoint: minioEndpointRef.current,
      };
      if (resumeDetail(route)) return;
      syncBrowserRouteUrl(route);

      if (matchedCache) {
        await engineRef.current?.loadFromCachedFingerprint(matchedCache.fingerprint);
      } else {
        await handleLoadUrl(cleanMinioPath);
      }
    },
    [handleLoadUrl, minioBucket, recordMinioHistoryPath, syncBrowserRouteUrl]
  );

  /**
   * 方式 3 快捷打开：从已缓存的 Gzip 指纹记录直接秒开图纸，并将 URL 更新为 `/local/:fileName?fp=...`。
   */
  const handleOpenCachedDrawing = useCallback(
    async (cacheItem: LocalGzipCacheMeta) => {
      setErrorBanner(null);
      setSourceMode('local');
      setViewMode('viewer');
      setShowCachePanel(false);

      const cleanName = normalizeDwgFileNameForConverter(cacheItem.fileName);
      const route: DwgRouteState = {
        mode: 'local',
        filePath: cleanName,
        fingerprint: cacheItem.fingerprint,
      };
      if (resumeDetail(route)) return;
      syncBrowserRouteUrl(route);

      await engineRef.current?.loadFromCachedFingerprint(cacheItem.fingerprint);
    },
    [syncBrowserRouteUrl]
  );

  /**
   * 方式 3：选择或拖拽上传本地 `.dwg` 或 `.dwg.cache.gz` 文件。
   */
  const handleLocalFile = useCallback(
    async (file: File) => {
      setErrorBanner(null);
      setSourceMode('local');
      const validation = validateDwgOrCacheFileName(file.name);
      if (!validation.valid) {
        setErrorBanner(validation.reason || '仅支持 .dwg 图纸或 .dwg.cache.gz 压缩缓存文件');
        return;
      }
      setViewMode('viewer');
      const cleanName = normalizeDwgFileNameForConverter(file.name);
      syncBrowserRouteUrl({
        mode: 'local',
        filePath: cleanName,
      });

      const buffer = await file.arrayBuffer();
      // [03_ui_design] 若用户勾选「加入工作区 (持久化)」，调用后端接口原子写入当前工作区目录
      if (saveToWorkspace) {
        try {
          const uploadUrl = `/api/workspace/upload?name=${encodeURIComponent(
            file.name
          )}&dir=${encodeURIComponent(activeWorkspaceDirRef.current)}`;
          const resp = await fetch(uploadUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: buffer,
          });
          if (resp.ok) {
            void fetchSamples(activeWorkspaceDirRef.current);
          } else {
              setErrorBanner((await resp.json()).error || '工作区保存失败');
            }
        } catch (uploadErr) {
          console.warn('[LocalUpload] Failed to persist file to workspace:', uploadErr);
        }
      }
      await engineRef.current?.loadFromBuffer(file.name, buffer);
    },
    [fetchSamples, saveToWorkspace, syncBrowserRouteUrl]
  );

  /**
   * Electron 桌面端或 Web 端触发本地文件选择。
   */
  const handleTriggerLocalUpload = useCallback(async () => {
    if (typeof window !== 'undefined' && window.electronAPI?.openDwgFileDialog) {
      try {
        const opened = await window.electronAPI.openDwgFileDialog();
        if (!opened) return;
        setErrorBanner(null);
        setSourceMode('local');
        setViewMode('viewer');
        const cleanName = normalizeDwgFileNameForConverter(opened.fileName);
        syncBrowserRouteUrl({
          mode: 'local',
          filePath: cleanName,
        });
        if (saveToWorkspace && opened.buffer) {
          try {
            const uploadUrl = `/api/workspace/upload?name=${encodeURIComponent(
              opened.fileName
            )}&dir=${encodeURIComponent(activeWorkspaceDirRef.current)}`;
            const resp = await fetch(uploadUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: opened.buffer,
            });
            if (resp.ok) {
              void fetchSamples(activeWorkspaceDirRef.current);
            } else {
              setErrorBanner((await resp.json()).error || '工作区保存失败');
            }
          } catch (uploadErr) {
            console.warn('[LocalUpload] Failed to persist electron file to workspace:', uploadErr);
          }
        }
        await engineRef.current?.loadFromBuffer(opened.fileName, opened.buffer);
        return;
      } catch {
        // Fallback to standard input
      }
    }
    fileInputRef.current?.click();
  }, [fetchSamples, saveToWorkspace, syncBrowserRouteUrl]);

  /**
   * 导出 `.dwg.cache.gz` 离线缓存包。
   */
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

  /**
   * 执行给定路由状态 `DwgRouteState` 对应的视图切换与图纸加载。
   */
  const executeRouteState = useCallback(
    async (route: DwgRouteState, isInitialMount = false) => {
      if (route.mode === 'home') {
        setViewMode('home');
        if (isInitialMount) {
          syncBrowserRouteUrl({ mode: 'home' }, true);
        }
        return;
      }

      if (resumeDetail(route)) return;
      detailRoute.current = route;
      detailReady.current = false;
      setHasLoadedAnyDrawing(false);
      setViewMode('viewer');
      setErrorBanner(null);

      if (route.mode === 'builtin' && route.filePath) {
        setSourceMode('builtin');
        if (route.workspaceDir) {
          setActiveWorkspaceDir(route.workspaceDir);
          setCustomWorkspaceInput(route.workspaceDir);
          setIsDefaultWorkspace(isDefaultSamplesWorkspaceDir(route.workspaceDir));
        }
        const fetchUrl = buildBuiltinFetchUrl(route.filePath, route.workspaceDir);
        setUrlInput(fetchUrl);
        if (isInitialMount) {
          syncBrowserRouteUrl(route, true);
        }
        await engineRef.current?.loadFromUrl(fetchUrl);
        return;
      }

      if (route.mode === 'minio' && route.filePath) {
        setSourceMode('minio');
        const effectiveEp = route.minioEndpoint || minioEndpointRef.current;
        if (route.minioEndpoint && route.minioEndpoint !== minioEndpointRef.current) {
          setMinioAccessKey('');
          setMinioSecretKey('');
          setMinioEndpoint(route.minioEndpoint);
        }
        setMinioPathInput(route.filePath);
        setUrlInput(route.filePath);
        if (isInitialMount) {
          syncBrowserRouteUrl(route, true);
        }
        const headers = getMinioHeaders(route.filePath, effectiveEp);
        await engineRef.current?.loadFromUrl(route.filePath, { headers });
        return;
      }

      if (route.mode === 'local' && route.filePath) {
        setSourceMode('local');
        if (isInitialMount) {
          syncBrowserRouteUrl(route, true);
        }
        if (route.fingerprint) {
          const ok = await engineRef.current?.loadFromCachedFingerprint(route.fingerprint);
          if (ok) return;
        }
        const matched = await findGzipCacheByFileName(route.filePath);
        if (matched && matched.fingerprint) {
          syncBrowserRouteUrl(
            {
              mode: 'local',
              filePath: route.filePath,
              fingerprint: matched.fingerprint,
            },
            true
          );
          const ok = await engineRef.current?.loadFromCachedFingerprint(matched.fingerprint);
          if (ok) return;
        }
        setProgress((prev) => ({ ...prev, isLoading: false }));
        setErrorBanner(
          `未找到本地图纸 "${route.filePath}" 的共享缓存记录，请点击「选择本地文件」重新上传该图纸。`
        );
      }
    },
    [getMinioHeaders, syncBrowserRouteUrl]
  );

  // 挂载 WebGL CAD 预览引擎、处理初始 URL 路由、监听 popstate 与 postMessage
  useEffect(() => {
    if (engineRef.current || !viewportContainerRef.current) return;

    const engine = new DwgViewerEngine({
      onProgress: (state) => setProgress(state),
      onLoaded: (meta) => {
        detailReady.current = true;
        setLoadedMeta(meta);
        setHasLoadedAnyDrawing(true);
        if (meta.sourceUrl) {
          setUrlInput(meta.sourceUrl);
        }
        // 当处于 local 模式且解析/解压完成获得 fingerprint 时，自动将 ?fp= 补齐到地址栏以便分享
        if (detailRoute.current?.mode === 'local' && meta.cacheInfo?.fingerprint) {
          if (getInitialRouteState().mode === 'home') {
            detailRoute.current = { ...detailRoute.current, fingerprint: meta.cacheInfo.fingerprint };
            return;
          }
          syncBrowserRouteUrl(
            {
              mode: 'local',
              filePath: meta.fileName,
              fingerprint: meta.cacheInfo.fingerprint,
            },
            true
          );
        }
      },
      onError: (msg) => {
        const isFailedToFetch =
          msg?.includes('Failed to fetch') || msg?.includes('NetworkError');
        setErrorBanner(
          isFailedToFetch
            ? '图纸读取或后台通信异常（请确认后端服务已启动且 3000 端口正常连接）'
            : msg
        );
      },
      onCacheListChanged: (entries) => {
        setCacheEntries(entries);
        // 若刚刚冷启动解析完本地上传的文件，后台异步生成 Gzip 缓存后补齐 URL 中的 ?fp=
        if (sourceModeRef.current === 'local' && entries.length > 0 && typeof window !== 'undefined') {
          const curRoute = parseDwgRouteFromLocation(
            window.location.pathname,
            window.location.search,
            window.location.hash
          );
          if (curRoute.mode === 'local' && curRoute.filePath && !curRoute.fingerprint) {
            const targetClean = normalizeDwgFileNameForConverter(curRoute.filePath).toLowerCase();
            const matched = entries.find(
              (e) => normalizeDwgFileNameForConverter(e.fileName).toLowerCase() === targetClean
            );
            if (matched?.fingerprint) {
              syncBrowserRouteUrl(
                {
                  mode: 'local',
                  filePath: curRoute.filePath,
                  fingerprint: matched.fingerprint,
                },
                true
              );
            }
          }
        }
      },
    });

    engine.setDefenseMode(defenseMode);
    engine.mount(viewportContainerRef.current);
    engineRef.current = engine;
    (window as any).__cadEngine = engine;

    const startRoute = getInitialRouteState();
    void executeRouteState(startRoute, true);

    const onPopState = () => {
      const nextRoute = getInitialRouteState();
      void executeRouteState(nextRoute, false);
    };

    const onWindowMessage = (event: MessageEvent) => {
      const payload = event.data;
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'LOAD_DWG_URL' && typeof payload.url === 'string') {
        setErrorBanner(null);
        setViewMode('viewer');
        setUrlInput(payload.url);
        if (payload.url.startsWith('/samples/')) {
          setSourceMode('builtin');
          const fileName = payload.url.replace(/^\/?samples\//, '');
          syncBrowserRouteUrl({ mode: 'builtin', filePath: fileName });
        } else {
          setSourceMode('minio');
          setMinioPathInput(payload.url);
          syncBrowserRouteUrl({
            mode: 'minio',
            filePath: payload.url,
            minioEndpoint: minioEndpointRef.current,
          });
        }
        void engine.loadFromUrl(payload.url, {
          fileName: payload.fileName,
          headers: payload.headers,
        });
      } else if (
        payload.type === 'LOAD_DWG_BUFFER' &&
        payload.buffer instanceof ArrayBuffer
      ) {
        setErrorBanner(null);
        setSourceMode('local');
        setViewMode('viewer');
        const name = payload.fileName || 'external.dwg';
        syncBrowserRouteUrl({ mode: 'local', filePath: name });
        void engine.loadFromBuffer(name, payload.buffer);
      } else if (
        payload.type === 'LOAD_DWG_GZIP_CACHE' &&
        payload.buffer instanceof ArrayBuffer
      ) {
        setErrorBanner(null);
        setSourceMode('local');
        setViewMode('viewer');
        const name = payload.fileName || 'external.dwg.cache.gz';
        syncBrowserRouteUrl({
          mode: 'local',
          filePath: normalizeDwgFileNameForConverter(name),
        });
        void engine.loadFromGzipCacheBuffer(name, payload.buffer);
      }
    };

    window.addEventListener('popstate', onPopState);
    window.addEventListener('message', onWindowMessage);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('message', onWindowMessage);
    };
  }, []);

  // 初次扫描工作区图纸与 MinIO 状态
  useEffect(() => {
    void fetchSamples(initialRoute.workspaceDir);
    void checkMinioStatus(initialRoute.minioEndpoint);
  }, [fetchSamples, checkMinioStatus]);

  // 点击外部或按 Escape 关闭下拉菜单
  useEffect(() => {
    if (!showSampleDropdown && !showMinioDropdown && !showMinioHistoryDropdown && !showLocalDropdown) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        showSampleDropdown &&
        sampleDropdownRef.current &&
        !sampleDropdownRef.current.contains(e.target as Node)
      ) {
        setShowSampleDropdown(false);
      }
      if (
        showMinioDropdown &&
        minioDropdownRef.current &&
        !minioDropdownRef.current.contains(e.target as Node)
      ) {
        setShowMinioDropdown(false);
      }
      if (
        showMinioHistoryDropdown &&
        minioHistoryDropdownRef.current &&
        !minioHistoryDropdownRef.current.contains(e.target as Node)
      ) {
        setShowMinioHistoryDropdown(false);
      }
      if (
        showLocalDropdown &&
        localDropdownRef.current &&
        !localDropdownRef.current.contains(e.target as Node)
      ) {
        setShowLocalDropdown(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowSampleDropdown(false);
        setShowMinioDropdown(false);
        setShowMinioHistoryDropdown(false);
        setShowLocalDropdown(false);
        setShowWorkspaceModal(false);
        setShowMinioConfigBar(false);
      }
    };
    window.addEventListener('mousedown', handleOutsideClick);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleOutsideClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showSampleDropdown, showMinioDropdown, showMinioHistoryDropdown, showLocalDropdown]);

  // [03_ui_design] 动态协同浏览器标签页标题：统一项目品牌为 DWG-viewer
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (viewMode === 'viewer' && loadedMeta.fileName && loadedMeta.fileName !== '未选择图纸') {
      document.title = `${loadedMeta.fileName} - DWG-viewer`;
    } else {
      document.title = 'DWG-viewer';
    }
  }, [viewMode, loadedMeta.fileName]);

  // [03_ui_design] 首屏渐进式启动完成，驱动启动骨架走完 100% 并平滑淡出
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __finishSplash?: () => void };
    w.__finishSplash?.();
  }, []);

  useEffect(() => {
    if (!showCachePanel && !showGpuModal) return;
    const close = () => { setShowCachePanel(false); setShowGpuModal(false); };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.utility-popover, [data-utility-trigger]')) close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [showCachePanel, showGpuModal]);

  const activeCache = loadedMeta.cacheInfo;

  const findCachedDrawing = (name: string) => {
    const normalized = normalizeDwgFileNameForConverter(name).toLowerCase();
    return cacheEntries.find(entry => normalizeDwgFileNameForConverter(entry.fileName).toLowerCase() === normalized);
  };
  return (
    <div
      className="h-dvh-safe w-screen flex flex-col bg-[#111112] text-slate-100 overflow-hidden select-none"
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
        aria-label={t("上传本地 DWG 或 .dwg.cache.gz 缓存文件")}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleLocalFile(file);
          e.target.value = '';
        }}
      />

      {/* 顶部导航栏：单行固定比例弹性缩放（绝对杜绝 flex-wrap 换行），三大板块各司其职 */}
      {/* [03_ui_design] 强制 flex-nowrap 单行锁定，右侧配置区永久靠右（ml-auto shrink-0），文字小屏退避为精致图标 */}
      <header className="app-toolbar relative z-40 bg-[#1b1b1d] border-b border-white/[0.08] w-full flex items-center justify-between gap-1.5 sm:gap-2 flex-nowrap overflow-x-auto no-scrollbar h-[48px] sm:h-[52px] px-safe pt-safe px-2 sm:px-4 shrink-0">
        {/* === 1. 展示组 (Brand & Status)：品牌 Logo + 图纸状态 + 性能状态 (左侧锁定，最大 28%，文件名 truncate) === */}
        <div
          data-section="display"
          className="bg-[#19191b] border border-white/[0.06] p-1 rounded-xl flex items-center gap-1 sm:gap-1.5 shrink-0 max-w-[28%] min-w-0 flex-nowrap"
        >
          {/* 产品首页入口 */}
          <button
            type="button"
            data-testid="nav-home-btn"
            onClick={() => {
              setViewMode('home');
              syncBrowserRouteUrl({ mode: 'home' });
            }}
            className={`min-h-[32px] sm:min-h-[34px] inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium border transition-colors shrink-0 ${
              viewMode === 'home'
                ? 'bg-slate-800 text-white border-white/15'
                : 'bg-[#242426] hover:bg-[#303033] text-slate-300 border-white/[0.08]'
            }`}
            title={t("返回工作台")} aria-label={t("返回工作台")}
          >
            {/* [03_ui_design] 零破损纯矢量工程徽标，天然免疫生产打包路径与 file:/// 协议图片加载失败 */}
            <div className="w-5 h-5 flex items-center justify-center shrink-0">
              <CadBrandLogoSvg className="w-5 h-5 text-sky-400" />
            </div>
            <span className="font-semibold text-white tracking-tight hidden xs:inline">
              DWG-viewer
            </span>
          </button>

            {hasLoadedAnyDrawing && <>
              <IconButton label={t("当前图纸")} onClick={() => resumeDetail()}><ArrowUpRight /></IconButton>

          {/* 图纸文件名与大小 Badge */}
          <div className="flex items-center gap-1.5 min-w-0 max-w-[120px] xs:max-w-[160px] sm:max-w-[200px] md:max-w-[240px] shrink">
            <span
              className="value-tag truncate"
              title={loadedMeta.fileName}
            >
              {loadedMeta.fileName}
            </span>
            {loadedMeta.fileSizeLabel && loadedMeta.fileSizeLabel !== '--' && (
              <span className="hidden sm:inline-block text-[10px] font-mono text-slate-400 bg-[#242426] border border-white/[0.08] px-1.5 py-0.5 rounded shrink-0">
                {loadedMeta.fileSizeLabel}
              </span>
            )}
            </div></>}

          {/* 图纸 Gzip 缓存性能状态 Badge（专业精炼工程术语，去除秒开等营销用语） */}
          {activeCache && (
            <button
              type="button"
              data-utility-trigger aria-expanded={showCachePanel} onClick={() => { setShowGpuModal(false); setShowCachePanel(v => !v); }}
              data-testid="gzip-status-badge"
              className="inline-flex min-h-[32px] items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-mono bg-[#242426] hover:bg-[#303033] text-emerald-300 border border-white/[0.08] transition-colors shrink-0"
              title={`缓存与性能详情: ${
                activeCache.source === 'wasm-cold'
                  ? `解析耗时 ${(activeCache.wasmParseMs / 1000).toFixed(1)}s，缓存包 ${formatByteSize(activeCache.compressedBytes)}`
                  : `缓存载入 ${(activeCache.totalElapsedMs / 1000).toFixed(1)}s (解压 ${activeCache.decompressMs}ms)`
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
              <span className="hidden md:inline">
                {activeCache.source === 'wasm-cold'
                  ? `解析 ${(activeCache.wasmParseMs / 1000).toFixed(1)}s`
                  : `耗时 ${(activeCache.totalElapsedMs / 1000).toFixed(1)}s`}
              </span>
              <span className="md:hidden">{t("缓存")}</span>
            </button>
          )}
        </div>

        {/* === 2. 交互组 (Core Interaction & Drawings)：三大数据源向下独立展开 + 画布动作 (居中锁定，flex-nowrap) === */}
        {/* [03_ui_design] 三大数据源向下独立浮层，小宽度下文字自适应退避为图标，flex-nowrap 绝对禁止换行 */}
        <div
          data-section="interaction"
          className="bg-[#19191b] border border-white/[0.06] p-1 rounded-xl flex items-center gap-1 sm:gap-1.5 shrink-0 flex-nowrap"
        >
          {/* 数据源 1：工作区图纸（独立向下展开图纸列表与工作区设置） */}
          <div className="relative shrink-0" ref={sampleDropdownRef}>
            <button
              type="button"
              data-testid="source-tab-builtin"
              onClick={() => {
                setSourceMode('builtin');
                setShowSampleDropdown((v) => !v);
                setShowMinioDropdown(false);
                setShowLocalDropdown(false);
              }}
              className={`min-h-[32px] sm:min-h-[34px] flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 ${
                sourceMode === 'builtin' || showSampleDropdown
                  ? 'bg-[#303033] text-white border border-white/10'
                  : 'bg-[#242426] hover:bg-[#303033] text-slate-300 border border-white/[0.08]'
              }`}
              title={t("工作区图纸")} aria-label={t("工作区图纸")} aria-expanded={showSampleDropdown}
            >
              <FolderOpen className="w-3.5 h-3.5 text-sky-400 shrink-0" />

            </button>

            {/* 工作区向下独立下拉菜单 */}
            {showSampleDropdown && (
              <div className="source-menu absolute left-0 top-full mt-1.5 w-72 sm:w-96 max-h-80 overflow-y-auto bg-[#252527] border border-white/15 rounded-xl shadow-2xl shadow-black/80 z-50 p-1.5 divide-y divide-white/[0.08] animate-dropdown-fade">
                <div className="px-2.5 py-1.5 text-[11px] text-slate-400 flex items-center justify-between gap-2">
                  <ValueTag label={t("目录")}>{activeWorkspaceDir}</ValueTag>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      disabled={isScanningSamples}
                      onClick={(e) => {
                        e.stopPropagation();
                        void fetchSamples(activeWorkspaceDir);
                      }}
                      className="p-1 rounded hover:bg-white/10 text-slate-300 hover:text-white transition-colors"
                      title={t("刷新图纸")}
                    >
                      <RefreshCw className={`w-3 h-3 ${isScanningSamples ? 'animate-spin text-sky-400' : ''}`} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowSampleDropdown(false);
                        setShowWorkspaceModal((v) => !v);
                      }}
                      className="text-sky-400 hover:text-sky-300 font-medium text-[11px]"
                    >
                      {t("切换目录")}
                    </button>
                  </div>
                </div>
                <div className="py-1">
                  {samples.length === 0 ? (
                    <div className="p-3 text-center text-xs text-slate-400">
                      {t("当前工作区目录下暂无 .dwg 图纸")}
                    </div>
                  ) : (
                    samples.map((item) => {
                      const isSelected = loadedMeta.fileName === item.name;
                      const sampleName = normalizeDwgFileNameForConverter(item.name);
                      const matchedCache = cacheEntries.find(
                        (c) =>
                          normalizeDwgFileNameForConverter(c.fileName).toLowerCase() ===
                          sampleName.toLowerCase()
                      );
                      return (
                        <button
                          key={item.url}
                          type="button"
                          onClick={() => {
                            setShowSampleDropdown(false);
                            void handleOpenBuiltinDrawing(item, matchedCache);
                          }}
                          className={`w-full text-left px-2.5 py-2 rounded-lg text-xs flex items-center justify-between gap-2 transition-colors ${
                            isSelected
                              ? 'bg-[#303033] text-white font-medium'
                              : 'text-slate-300 hover:bg-[#282F40] hover:text-white'
                          }`}
                        >
                          <span className="truncate flex-1 font-mono text-[11px] flex items-center gap-1.5">
                            {matchedCache && (
                              <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-950/80 text-emerald-300 border border-emerald-500/30 shrink-0 font-sans">
                                {t("已缓存")}
                              </span>
                            )}
                            {item.name}
                          </span>
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-black/30 text-slate-400 font-mono">
                            {item.sizeLabel}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>



          {/* 数据源 2：MinIO 直连（独立向下展开桶内文件、路径直读与配置） */}
          <div className="relative shrink-0" ref={minioDropdownRef}>
            <button
              type="button"
              data-testid="source-tab-minio"
              onClick={() => {
                setSourceMode('minio');
                setShowMinioDropdown((v) => !v);
                setShowSampleDropdown(false);
                setShowLocalDropdown(false);
              }}
              className={`min-h-[32px] sm:min-h-[34px] flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 ${
                sourceMode === 'minio' || showMinioDropdown
                  ? 'bg-[#303033] text-white border border-white/10'
                  : 'bg-[#242426] hover:bg-[#303033] text-slate-300 border border-white/[0.08]'
              }`}
              title={t("MinIO 图纸")} aria-label={t("MinIO 图纸")} aria-expanded={showMinioDropdown}
            >
              <Cloud className="w-3.5 h-3.5 text-sky-400 shrink-0" />

            </button>

            {/* MinIO 向下独立浮层面板 */}
            {showMinioDropdown && (
              <div className="source-menu absolute left-0 sm:left-auto top-full mt-1.5 w-[330px] sm:w-[410px] max-h-[460px] overflow-y-auto bg-[#252527] border border-white/15 rounded-xl shadow-2xl shadow-black/80 z-50 p-2.5 divide-y divide-white/[0.08] animate-dropdown-fade space-y-2">
                <div className="pb-1.5 flex items-center justify-between text-[11px] font-mono text-slate-400">
                  <div className="flex items-center gap-1.5 truncate">
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        minioStatus.connected ? 'bg-emerald-400' : 'bg-rose-400'
                      }`}
                    />
                    <span className="truncate">
                      <ValueTag label={t("桶")} tone="info">{minioStatus.bucket}</ValueTag>
                    </span>
                    {minioStatus.connected && (
                      <span className="text-emerald-400 text-[10px]">({minioStatus.latencyMs ?? 0}ms)</span>
                    )}
                  </div>
                  <button
                    type="button"
                    data-testid="toggle-minio-config-btn"
                    onClick={() => {
                      setShowMinioDropdown(false);
                      setShowMinioConfigBar(true);
                    }}
                    className="text-sky-400 hover:text-sky-300 font-medium text-[11px] flex items-center gap-1 shrink-0"
                  >
                    <SlidersHorizontal className="w-3 h-3" />
                    配置
                  </button>
                </div>

                {/* 快速路径输入与读取 */}
                <form
                  className="pt-2 flex items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setShowMinioDropdown(false);
                    void handleOpenMinioDrawing(minioPathInput);
                  }}
                >
                  <input
                    type="text"
                    value={minioPathInput}
                    onChange={(e) => {
                      setMinioPathInput(e.target.value);
                      setUrlInput(e.target.value);
                    }}
                    placeholder={t("输入 MinIO 对象路径...")}
                    aria-label={t("MinIO DWG 对象路径")}
                    data-testid="minio-path-input"
                    className="min-h-[30px] flex-1 min-w-0 px-2.5 py-1 text-xs font-mono bg-[#212123] border border-white/[0.08] rounded-lg focus:outline-none focus:border-sky-400/60 text-slate-200 placeholder:text-slate-500"
                  />
                  {minioHistoryPaths.length > 0 && (
                    <button
                      type="button"
                      data-testid="minio-history-dropdown-btn"
                      onClick={() => setShowMinioHistoryDropdown((v) => !v)}
                      className="min-h-[30px] px-2 rounded-lg bg-[#212123] hover:bg-[#303033] text-sky-400 border border-white/[0.08] text-xs flex items-center shrink-0"
                      title={`历史路径 (${minioHistoryPaths.length})`}
                    >
                      <History className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    type="submit"
                    className="min-h-[30px] px-3 py-1 rounded-lg text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 transition-colors shrink-0"
                  >
                    读取
                  </button>
                </form>

                {/* MinIO 历史记录浮动 */}
                {showMinioHistoryDropdown && minioHistoryPaths.length > 0 && (
                  <div className="pt-2">
                    <div className="flex items-center justify-between text-[10px] text-slate-400 pb-1">
                      <span>历史读取 ({minioHistoryPaths.length})</span>
                      <button
                        type="button"
                        onClick={() => handleClearMinioHistory()}
                        className="text-rose-400 hover:text-rose-300"
                      >
                        清空
                      </button>
                    </div>
                    <div className="max-h-32 overflow-y-auto space-y-1">
                      {minioHistoryPaths.map((hist) => (
                        <div
                          key={hist}
                          className="flex items-center justify-between text-xs px-2 py-1 rounded bg-[#212123] hover:bg-[#303033] cursor-pointer"
                          onClick={() => {
                            setMinioPathInput(hist);
                            setShowMinioHistoryDropdown(false);
                            setShowMinioDropdown(false);
                            void handleOpenMinioDrawing(hist);
                          }}
                        >
                          <span className="font-mono text-[11px] text-slate-200 truncate flex-1">{hist}</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleClearMinioHistory(hist);
                            }}
                            className="p-0.5 text-slate-500 hover:text-rose-400 ml-1"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 存储桶图纸直选 */}
                <div className="pt-2">
                  <div className="text-[11px] font-mono text-slate-400 mb-1 flex items-center justify-between">
                    <span>{t("桶内图纸列表")}</span>
                    <span className="text-[10px] text-slate-500">{minioStatus.files.length} 个文件</span>
                  </div>
                  {minioStatus.files.length === 0 ? (
                    <div className="p-3 text-center text-xs text-slate-400">
                      {minioStatus.error || '当前路径下未检测到 .dwg 图纸'}
                    </div>
                  ) : (
                    <div className="max-h-48 overflow-y-auto space-y-1">
                      {minioStatus.files.map((item) => {
                        const isSelected = minioPathInput === item.path;
                        const cleanName = normalizeDwgFileNameForConverter(item.name);
                        const matchedCache = cacheEntries.find(
                          (c) =>
                            normalizeDwgFileNameForConverter(c.fileName).toLowerCase() ===
                            cleanName.toLowerCase()
                        );
                        return (
                          <button
                            key={item.path}
                            type="button"
                            onClick={() => {
                              setMinioPathInput(item.path);
                              setShowMinioDropdown(false);
                              void handleOpenMinioDrawing(item.path, matchedCache);
                            }}
                            className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between gap-2 transition-colors ${
                              isSelected
                                ? 'bg-[#303033] text-white font-medium'
                                : 'text-slate-300 hover:bg-[#282F40] hover:text-white'
                            }`}
                          >
                            <span className="truncate flex-1 font-mono text-[11px] flex items-center gap-1.5">
                              {matchedCache && (
                                <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-950/80 text-emerald-300 border border-emerald-500/30 shrink-0 font-sans">
                                  {t("已缓存")}
                                </span>
                              )}
                              {item.name}
                            </span>
                            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-black/30 text-slate-400 font-mono">
                              {item.sizeLabel}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 数据源 3：本地上传（独立向下展开上传按钮与工作区持久化复选框） */}
          <div className="relative shrink-0" ref={localDropdownRef}>
            <button
              type="button"
              data-testid="source-tab-local"
              onClick={() => {
                setSourceMode('local');
                setShowLocalDropdown((v) => !v);
                setShowSampleDropdown(false);
                setShowMinioDropdown(false);
              }}
              className={`min-h-[32px] sm:min-h-[34px] flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 ${
                sourceMode === 'local' || showLocalDropdown
                  ? 'bg-[#303033] text-white border border-white/10'
                  : 'bg-[#242426] hover:bg-[#303033] text-slate-300 border border-white/[0.08]'
              }`}
              title={t("本地上传")} aria-label={t("本地上传")} aria-expanded={showLocalDropdown}
            >
              <Upload className="w-3.5 h-3.5 text-sky-400 shrink-0" />

            </button>

            {/* 本地上传向下独立浮层 */}
            {showLocalDropdown && (
              <div className="source-menu absolute right-0 sm:left-0 top-full mt-1.5 w-72 sm:w-80 bg-[#252527] border border-white/15 rounded-xl shadow-2xl shadow-black/80 z-50 p-3 space-y-2.5 animate-dropdown-fade">
                <button
                  type="button"
                  data-testid="local-upload-trigger-btn"
                  onClick={() => {
                    setShowLocalDropdown(false);
                    void handleTriggerLocalUpload();
                  }}
                  className="w-full min-h-[34px] px-3 py-2 rounded-lg text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 flex items-center justify-center gap-2 transition-colors"
                >
                  <Upload className="w-4 h-4 shrink-0" />
                  <span>{t("选择本地 .dwg / .dwg.cache.gz")}</span>
                </button>

                <div className="pt-1 border-t border-white/[0.08] flex items-center justify-between">
                  <label
                    className="inline-flex items-center gap-1.5 cursor-pointer text-xs text-slate-300 select-none"
                    title="勾选后将自动将上传的图纸写入当前工作区目录，页面刷新后仍可读取；不勾选则仅作为浏览器临时内存"
                  >
                    <input
                      type="checkbox"
                      data-testid="save-to-workspace-checkbox"
                      checked={saveToWorkspace}
                      onChange={(e) => handleToggleSaveToWorkspace(e.target.checked)}
                      className="rounded border-white/20 bg-[#212123] text-sky-500 focus:ring-0 w-3.5 h-3.5 cursor-pointer"
                    />
                    <span className="text-[11px]">{t("持久化保存至工作区")}</span>
                  </label>
                </div>

                <p className="text-[10px] text-slate-500 leading-relaxed">
                  也可拖入图纸打开
                </p>
              </div>
            )}
          </div>

          <div className="h-4 w-px bg-white/[0.08] mx-0.5 shrink-0" />

          {/* 画布动作：分享链接与全图居中 */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              data-testid="share-route-url-btn"
              onClick={() => void handleCopyShareUrl()}
              className={`min-h-[32px] sm:min-h-[34px] inline-flex items-center justify-center gap-1 px-2 sm:px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors shrink-0 ${
                copiedShareUrl
                  ? 'bg-emerald-950/60 text-emerald-300 border-emerald-500/40'
                  : 'bg-[#242426] hover:bg-[#303033] text-slate-300 border-white/[0.08]'
              }`}
              aria-label={t("复制分享链接")} title={copiedShareUrl ? "已复制" : "复制分享链接"}
            >
              {copiedShareUrl ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />

                </>
              ) : (
                <>
                  <Share2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />

                </>
              )}
            </button>

            {viewMode === 'viewer' && (
              <button
                type="button"
                data-testid="reset-viewport-btn"
                onClick={() => void engineRef.current?.fitToView()}
                aria-label={t("居中复位")}
                title={t("全图居中显示")}
                className="min-h-[32px] sm:min-h-[34px] px-2 sm:px-2.5 py-1 rounded-lg text-xs font-medium bg-[#242426] hover:bg-[#303033] text-slate-200 border border-white/[0.08] flex items-center gap-1 transition-colors shrink-0"
              >
                <Scan className="w-3.5 h-3.5 text-sky-400" />

              </button>
            )}
          </div>
        </div>

        {/* === 3. 配置与系统组 (Config & Optimization)：工作区配置 + 内存优化 + 缓存管理 + 导出缓存 + 硬件状态 (ml-auto shrink-0 flex-nowrap 绝对禁止换行) === */}
        {/* [03_ui_design] 永久锁定在最右上角，无论窗口如何拉窄或缩放，严禁折行下掉到第二行 */}
        <div
          data-section="config"
          className="bg-[#19191b] border border-white/[0.06] p-1 rounded-xl flex items-center gap-1 sm:gap-1.5 shrink-0 flex-nowrap ml-auto"
        >
          <ResourceMeter />
          {/* 工作区目录配置面板开关 */}
          <button
            type="button"
            data-testid="toggle-workspace-config-btn"
            onClick={() => setShowWorkspaceModal((v) => !v)}
            className={`min-h-[32px] sm:min-h-[34px] px-2 py-1 rounded-lg text-xs font-medium border flex items-center justify-center gap-1 transition-colors shrink-0 ${
              showWorkspaceModal
                ? 'bg-[#303033] text-white border-white/20'
                : 'bg-[#242426] hover:bg-[#303033] text-slate-300 border-white/[0.08]'
            }`}
            title={`工作区目录配置 (当前: ${activeWorkspaceDir})`}
          >
            <History className="w-3.5 h-3.5 text-sky-400 shrink-0" />

          </button>

          {/* 内存优化模式开关 */}
          <div className="memory-tip-host" onMouseEnter={() => setShowMemoryTip(true)}
            onMouseLeave={() => setShowMemoryTip(false)} onFocus={() => setShowMemoryTip(true)}
            onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setShowMemoryTip(false); }}
            onKeyDown={e => { if (e.key === 'Escape') setShowMemoryTip(false); }}>
          <button
            type="button"
            data-testid="toggle-defense-mode-btn"
            onClick={toggleDefenseMode}
            className={`min-h-[32px] sm:min-h-[34px] flex items-center gap-1 sm:gap-1.5 px-2 py-1 rounded-lg text-xs font-mono border transition-colors shrink-0 ${
              defenseMode
                ? 'bg-amber-950/50 text-amber-200 border-amber-500/40 hover:bg-amber-900/50'
                : 'bg-[#242426] text-slate-400 border-white/[0.08] hover:bg-[#303033] hover:text-slate-200'
            }`}
            aria-label={t("内存优化")}
            aria-pressed={defenseMode}
            aria-describedby={showMemoryTip ? "memory-mode-tip" : undefined}
          >
            <ShieldCheck className={`w-3.5 h-3.5 shrink-0 ${defenseMode ? 'text-amber-400' : 'text-slate-500'}`} />

          </button>
            {showMemoryTip && <div className="utility-popover memory-tip">
              <div className="flex items-center gap-2">
                <ShieldCheck size={16} /><strong>{t("内存优化")}</strong>
                <ValueTag tone={defenseMode ? "ready" : "neutral"}>{t(defenseMode ? "已开启" : "已关闭")}</ValueTag>
                <button type="button" className="icon-action ml-auto" aria-label={t("关闭")} onClick={() => setShowMemoryTip(false)}><X size={15} /></button>
              </div>
              <p id="memory-mode-tip" role="tooltip">{t("适合 iOS 和低内存设备。开启后会分批处理图元，并限制高分屏渲染精度，以降低打开大图时的峰值内存。加载可能更慢，细线可能略显模糊。")}</p>
            </div>}
          </div>

          {/* 缓存管理面板开关 */}
          <button
            type="button"
            data-testid="toggle-gzip-cache-panel"
            data-utility-trigger aria-expanded={showCachePanel} onClick={() => { setShowGpuModal(false); setShowCachePanel(v => !v); }}
            className={`min-h-[32px] sm:min-h-[34px] flex items-center gap-1 sm:gap-1.5 px-2 py-1 rounded-lg text-xs font-mono border transition-colors shrink-0 ${
              showCachePanel
                ? 'bg-[#303033] text-white border-white/20'
                : 'bg-[#242426] text-slate-300 border-white/[0.08] hover:bg-[#303033]'
            }`}
            title={t("管理图纸缓存 (.dwg.cache.gz)")}
          >
            <FileArchive className="w-3.5 h-3.5 text-emerald-400 shrink-0" />

          </button>

          {/* 导出缓存按钮：取消粗暴 hidden xl:flex，小屏自适应文案退避 */}
          <button
            type="button"
            disabled={!activeCache || progress.isLoading}
            onClick={() => void handleDownloadGzipFile()}
            data-testid="export-gzip-btn"
            className="min-h-[32px] sm:min-h-[34px] flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-[#242426] hover:bg-[#303033] disabled:opacity-40 text-slate-200 border border-white/[0.08] transition-colors shrink-0"
            title={t("导出当前图纸缓存包 (.dwg.cache.gz)")}
          >
            <HardDriveDownload className="w-3.5 h-3.5 text-sky-400 shrink-0" />

          </button>

          {/* 最右侧整合胶囊：GPU 硬件加速状态与版本信息 (一体化收拢) */}
          <div className="flex items-center bg-[#242426] border border-white/[0.08] rounded-lg p-0.5 text-xs font-mono shrink-0">
            <button
              type="button"
              data-utility-trigger aria-expanded={showGpuModal} onClick={() => { setShowCachePanel(false); setShowGpuModal(v => !v); }}
              className="min-h-[30px] flex items-center gap-1 px-2 py-1 rounded-md text-slate-300 hover:bg-[#303033] hover:text-white transition-colors"
              title={`图形硬件与 WebGL 运行状态: ${gpuInfo.renderer} (${gpuInfo.webglVersion})`}
            >
              <Cpu className="w-3.5 h-3.5 text-sky-400 shrink-0" />

            </button>

            <div className="h-3 w-px bg-white/[0.12] mx-0.5 shrink-0" />

            <button
              type="button"
              data-testid="header-about-btn"
              onClick={() => setShowAboutModal(true)}
              className="min-h-[30px] flex items-center gap-1 px-2 py-1 rounded-md text-slate-300 hover:bg-[#303033] hover:text-white transition-colors"
                title={t("关于 DWG-viewer")} aria-label={t("关于 DWG-viewer")}
            >
              <Info className="w-3.5 h-3.5 text-sky-400 shrink-0" />

            </button>
          </div>
        </div>
      {/* 可折叠面板 3：Gzip 缓存管理面板 */}
      {showCachePanel && (
        <section
          data-testid="gzip-cache-panel"
          className="utility-popover cache-popover z-30 bg-[#252527] border-b border-white/15 shadow-2xl shadow-black/80 px-safe py-3 text-xs flex flex-col gap-3 max-h-[75dvh] overflow-y-auto animate-panel-slide"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-2">
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-md bg-[#303033] text-emerald-300 border border-white/10 font-mono font-semibold flex items-center gap-1.5">
                <FileArchive className="w-3.5 h-3.5" />
                {t("图纸缓存")}
              </span>
              <span className="text-slate-400 hidden sm:inline">

              </span>
            </div>

            <div className="cache-actions flex flex-wrap items-center gap-2">
              {activeCache && (
                <>
                  <button
                    type="button"
                    disabled={progress.isLoading}
                    data-testid="reload-from-gzip-btn"
                    onClick={() => {
                      setErrorBanner(null);
                      setViewMode('viewer');
                      void engineRef.current?.loadFromCachedFingerprint(activeCache.fingerprint);
                    }}
                    className="px-2.5 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-semibold flex items-center gap-1 transition-colors"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    <span>{t("从缓存载入")}</span>
                  </button>

                  <button
                    type="button"
                    disabled={progress.isLoading}
                    onClick={() => void handleDownloadGzipFile(activeCache.fingerprint)}
                    className="px-2.5 py-1 rounded-lg bg-[#242426] hover:bg-[#303033] disabled:opacity-50 text-slate-200 border border-white/10 font-medium flex items-center gap-1 transition-colors"
                  >
                    <HardDriveDownload className="w-3.5 h-3.5 text-sky-400" />
                    <span>{t("下载缓存包")}</span>
                  </button>

                  <button
                    type="button"
                    disabled={progress.isLoading}
                    onClick={() => void handleLoadUrl(urlInput, undefined, true)}
                    className="px-2.5 py-1 rounded-lg bg-[#242426] hover:bg-[#303033] disabled:opacity-50 text-slate-300 border border-white/[0.08] flex items-center gap-1 transition-colors"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>{t("重新解析")}</span>
                  </button>
                </>
              )}

              {cacheEntries.length > 0 && (
                <button
                  type="button"
                  disabled={progress.isLoading}
                  onClick={() => void engineRef.current?.clearAllCache()}
                  className="px-2.5 py-1 rounded-lg bg-rose-950/50 hover:bg-rose-900/60 text-rose-300 border border-rose-500/30 flex items-center gap-1 transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>{t("清空全部")}</span>
                </button>
              )}

              <button
                type="button"
                title={t("关闭")} aria-label={t("关闭")} onClick={() => setShowCachePanel(false)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {activeCache && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono">
              <div className="bg-[#111112] border border-white/[0.06] rounded-lg p-2.5">
                <div className="text-[10px] text-slate-400">{t("当前加载模式")}</div>
                <div className="text-xs font-semibold text-emerald-300 mt-0.5">
                  {activeCache.source === 'wasm-cold'
                    ? t("完整解析 (已存缓存)")
                    : activeCache.source === 'local-gzip-file'
                    ? t("导入缓存包载入")
                    : activeCache.source === 'server-gzip-shared'
                    ? t("服务端共享缓存")
                    : t("本地缓存载入")}
                </div>
              </div>
              <div className="bg-[#111112] border border-white/[0.06] rounded-lg p-2.5">
                <div className="text-[10px] text-slate-400">{t("原始 DWG 大小")}</div>
                <div className="text-xs font-semibold text-slate-200 mt-0.5">
                  {formatByteSize(activeCache.originalByteLength)}
                </div>
              </div>
              <div className="bg-[#111112] border border-white/[0.06] rounded-lg p-2.5">
                <div className="text-[10px] text-slate-400">{t("数据模型大小")}</div>
                <div className="text-xs font-semibold text-slate-200 mt-0.5">
                  {formatByteSize(activeCache.rawJsonBytes)}
                </div>
              </div>
              <div className="bg-[#111112] border border-white/[0.06] rounded-lg p-2.5">
                <div className="text-[10px] text-slate-400">{t("压缩缓存大小 (.gz)")}</div>
                <div className="text-xs font-semibold text-sky-300 mt-0.5">
                  {formatByteSize(activeCache.compressedBytes)}{' '}
                  <span className="text-emerald-400">
                    (-{Math.round(activeCache.compressionRatio * 100)}%)
                  </span>
                </div>
              </div>
              <div className="bg-[#111112] border border-white/[0.06] rounded-lg p-2.5">
                <div className="text-[10px] text-slate-400">{t("解析 / 解压耗时")}</div>
                <div className="text-xs font-semibold text-slate-200 mt-0.5">
                  {(activeCache.wasmParseMs / 1000).toFixed(2)}s vs{' '}
                  <span className="text-emerald-400">
                    {activeCache.decompressMs > 0 ? `${activeCache.decompressMs}ms` : '~35ms'}
                  </span>
                </div>
              </div>
              <div className="bg-[#111112] border border-white/[0.06] rounded-lg p-2.5">
                <div className="text-[10px] text-slate-400">{t("总图元数 / 图层数")}</div>
                <div className="text-xs font-semibold text-slate-200 mt-0.5">
                  {activeCache.entityCount.toLocaleString()} / {activeCache.layerCount} {t("层")}
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-2">
            {cacheEntries.map((item) => {
              const isCurrent = activeCache?.fingerprint === item.fingerprint;
              const scopeLabel =
                item.storageScope === 'server-shared'
                  ? t("服务端共享")
                  : item.storageScope === 'both'
                  ? t("本地与服务端")
                  : t("仅本地存储");
              return (
                <div
                  key={item.fingerprint}
                  data-filename={item.fileName}
                  className={`flex items-center justify-between gap-2 p-2.5 rounded-xl border font-mono ${
                    isCurrent
                      ? 'bg-[#242426] border-emerald-500/40'
                      : 'bg-[#111112] border-white/[0.06]'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-semibold text-slate-100 truncate">
                        {item.fileName}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#242426] text-sky-300 border border-white/[0.08] shrink-0">
                        {formatByteSize(item.compressedBytes)}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#242426] text-slate-300 border border-white/[0.08] shrink-0">
                        {scopeLabel}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5 truncate">
                      {t("原图")} {formatByteSize(item.originalByteLength)} ·{' '}
                      {item.entityCount.toLocaleString()} {t("图元")}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      disabled={progress.isLoading}
                      onClick={() => void handleOpenCachedDrawing(item)}
                      className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] flex items-center gap-1"
                    >
                      <Play className="w-3 h-3" />
                      <span>{t("载入")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDownloadGzipFile(item.fingerprint)}
                      className="px-2 py-1 rounded-lg bg-[#242426] hover:bg-[#303033] text-slate-300 border border-white/[0.08] text-[11px]"
                      title={t("导出缓存包 (.dwg.cache.gz)")}
                    >
                      .gz
                    </button>
                    <button
                      type="button"
                      onClick={() => void engineRef.current?.removeCacheEntry(item.fingerprint)}
                      className="p-1.5 rounded-lg bg-[#242426] hover:bg-rose-950/60 text-slate-400 hover:text-rose-300 border border-white/[0.08]"
                      title={t("删除此条记录")}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* GPU 硬件状态栏 */}
      {showGpuModal && (
        <div className="utility-popover gpu-popover bg-[#252527] border-b border-white/[0.08] px-4 py-2.5 flex items-center justify-between gap-4 text-xs z-20">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-slate-300 font-mono">
            <span className="flex items-center gap-1.5 text-white font-semibold">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              {t("图形硬件状态")}
            </span>
            <ValueTag label={t("显卡")}>{({ dedicated: t("独立显卡"), integrated: t("集成显卡"), software: t("软件渲染"), unknown: t("未知") })[gpuInfo.gpuTier]}</ValueTag>
            <ValueTag label={t("渲染器")}>{gpuInfo.renderer}</ValueTag>
            <ValueTag label={t("接口")}>{gpuInfo.webglVersion.toUpperCase()}</ValueTag>
          </div>
          <button
            type="button"
            aria-label={t("关闭硬件信息")} title={t("关闭硬件信息")} onClick={() => setShowGpuModal(false)}
            className="text-slate-400 hover:text-white p-1 shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      </header>

      {/* [03_ui_design] 子级微型窗口 1：工作区设置 (取消满横排 Banner，改用优雅居中小弹窗) */}
      {showWorkspaceModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="workspace-modal-title"
          data-testid="workspace-config-panel"
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-dropdown-fade"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowWorkspaceModal(false);
          }}
        >
          <div className="max-w-md w-full rounded-2xl bg-[#212123] border border-white/10 shadow-2xl p-5 flex flex-col gap-4 text-xs">
            {/* 弹窗标题栏 */}
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-3">
              <div className="flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-sky-400" />
                <h3 id="workspace-modal-title" className="text-sm font-semibold text-white">{t("工作区设置")}</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowWorkspaceModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                title={t("关闭 (Esc)")}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 常用目录快捷选择 */}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-slate-300">{t("常用目录")}</span>
              <select
                aria-label={t("常用目录选择")}
                data-testid="workspace-history-select"
                value={activeWorkspaceDir}
                onChange={(e) => void handleSwitchWorkspaceDir(e.target.value)}
                className="px-3 py-2 text-xs font-mono bg-[#252527] border border-white/15 rounded-lg text-slate-200 focus:outline-none focus:border-sky-400/60"
              >
                {workspaceHistory.map((dir) => (
                  <option key={dir} value={dir}>
                    {isDefaultSamplesWorkspaceDir(dir) ? `${dir} (默认)` : dir}
                  </option>
                ))}
              </select>
            </div>

            {/* 自定义路径输入框（输入框末尾配备文件夹选择图标，点击唤起原生资源管理器） */}
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSwitchWorkspaceDir(customWorkspaceInput);
                setShowWorkspaceModal(false);
              }}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-300">{t("自定义路径")}</span>

              </div>
              <div className="relative flex items-center">
                <input
                  type="text"
                  data-testid="workspace-custom-dir-input"
                  value={customWorkspaceInput}
                  onChange={(e) => setCustomWorkspaceInput(e.target.value)}
                  placeholder={t("输入文件夹绝对路径...")}
                  className="w-full pl-3 pr-10 py-2 text-xs font-mono bg-[#252527] border border-white/15 rounded-lg text-slate-200 focus:outline-none focus:border-sky-400/60"
                />
                {/* 输入框末尾内嵌文件夹图标按钮 */}
                <button
                  type="button"
                  onClick={async () => {
                    if (typeof window !== 'undefined' && window.electronAPI?.selectDirectory) {
                      const picked = await window.electronAPI.selectDirectory();
                      if (picked) {
                        setCustomWorkspaceInput(picked);
                        void handleSwitchWorkspaceDir(picked);
                      }
                    } else {
                      void handleSelectWorkspaceFolder();
                    }
                  }}
                  className="absolute right-1.5 p-1 rounded-md text-slate-400 hover:text-sky-400 hover:bg-white/10 transition-colors"
                  title={t("浏览文件夹 (调用系统文件管理器)")}
                >
                  <FolderOpen className="w-4 h-4" />
                </button>
              </div>

              {/* 底部按钮栏 */}
              <div className="flex items-center justify-between pt-3 mt-1 border-t border-white/[0.08]">
                {!isDefaultWorkspace ? (
                  <button
                    type="button"
                    onClick={() => {
                      void handleSwitchWorkspaceDir('default');
                      setShowWorkspaceModal(false);
                    }}
                    className="px-2.5 py-1.5 rounded-lg bg-transparent hover:bg-white/5 text-slate-400 hover:text-slate-200 text-xs flex items-center gap-1 transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>{t("恢复默认")}</span>
                  </button>
                ) : (
                  <div />
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowWorkspaceModal(false)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 hover:bg-white/10 transition-colors"
                  >
                    {t("取消")}
                  </button>
                  <button
                    type="submit"
                    disabled={isScanningSamples}
                    data-testid="workspace-apply-btn"
                    className="px-4 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold text-xs transition-colors"
                  >
                    {t("应用并扫描")}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* [03_ui_design] 子级微型窗口 2：MinIO 服务配置 (取消满横排 Banner，改用优雅居中小弹窗) */}
      {showMinioConfigBar && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="minio-modal-title"
          data-testid="minio-config-panel"
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-dropdown-fade"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowMinioConfigBar(false);
          }}
        >
          <div className="max-w-md w-full rounded-2xl bg-[#212123] border border-white/10 shadow-2xl p-5 flex flex-col gap-4 text-xs">
            {/* 弹窗标题栏 */}
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-3">
              <div className="flex items-center gap-2">
                <Cloud className="w-4 h-4 text-sky-400" />
                <h3 id="minio-modal-title" className="text-sm font-semibold text-white">{t("MinIO 服务配置")}</h3>
                <span
                  className={`text-[10px] font-mono px-2 py-0.5 rounded-md border ${
                    minioStatus.connected
                      ? 'bg-emerald-950/40 text-emerald-300 border-emerald-500/30'
                      : 'bg-rose-950/40 text-rose-300 border-rose-500/30'
                  }`}
                >
                  {minioStatus.checking
                    ? '连接中...'
                    : minioStatus.connected
                    ? `${minioStatus.latencyMs ?? 0}ms`
                    : '连接异常'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowMinioConfigBar(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                title={t("关闭 (Esc)")}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 表单字段垂直排布 */}
            <div className="flex flex-col gap-3 font-mono text-xs">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-sans font-medium text-slate-300">{t("服务地址 (Endpoint URL)")}</span>
                <input
                  type="text"
                  data-testid="minio-endpoint-input"
                  value={minioEndpoint}
                  onChange={(e) => {
                    setMinioAccessKey('');
                    setMinioSecretKey('');
                    setMinioEndpoint(e.target.value);
                  }}
                  className="px-3 py-2 text-xs bg-[#252527] border border-white/15 rounded-lg text-slate-200 focus:outline-none focus:border-sky-400/60"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-sans font-medium text-slate-300">{t("访问密钥 (Access Key)")}</span>
                <input
                  type="text"
                  data-testid="minio-access-key-input"
                  value={minioAccessKey}
                  onChange={(e) => setMinioAccessKey(e.target.value)}
                  placeholder="Access Key"
                  className="px-3 py-2 text-xs bg-[#252527] border border-white/15 rounded-lg text-slate-200 focus:outline-none focus:border-sky-400/60"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-sans font-medium text-slate-300 flex items-center justify-between">
                  <span>{t("私有密钥 (Secret Key)")}</span>
                  <button
                    type="button"
                    onClick={() => setShowSecretKeyPlain((v) => !v)}
                    className="text-sky-400 hover:text-sky-300 flex items-center gap-1 text-[11px]"
                  >
                    {showSecretKeyPlain ? <><EyeOff className="w-3 h-3" /> {t("隐藏")}</> : <><Eye className="w-3 h-3" /> {t("显示")}</>}
                  </button>
                </span>
                <input
                  type={showSecretKeyPlain ? 'text' : 'password'}
                  data-testid="minio-secret-key-input"
                  value={minioSecretKey}
                  onChange={(e) => setMinioSecretKey(e.target.value)}
                  placeholder="Secret Key"
                  className="px-3 py-2 text-xs bg-[#252527] border border-white/15 rounded-lg text-slate-200 focus:outline-none focus:border-sky-400/60"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-sans font-medium text-slate-300">{t("存储桶 (Bucket)")}</span>
                <input
                  type="text"
                  data-testid="minio-bucket-input"
                  value={minioBucket}
                  onChange={(e) => setMinioBucket(e.target.value)}
                  className="px-3 py-2 text-xs bg-[#252527] border border-white/15 rounded-lg text-slate-200 focus:outline-none focus:border-sky-400/60"
                />
              </label>
            </div>

            {/* 底部按钮栏 */}
            <div className="flex items-center justify-between pt-3 border-t border-white/[0.08]">
              <button
                type="button"
                onClick={handleResetMinioConfig}
                className="px-2.5 py-1.5 rounded-lg bg-transparent hover:bg-white/5 text-slate-400 hover:text-slate-200 text-xs flex items-center gap-1 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{t("恢复默认")}</span>
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowMinioConfigBar(false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 hover:bg-white/10 transition-colors"
                >
                  {t("取消")}
                </button>
                <button
                  type="button"
                  disabled={minioStatus.checking}
                  onClick={() => {
                    void checkMinioStatus(undefined, true);
                    setShowMinioConfigBar(false);
                  }}
                  className="px-4 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold text-xs flex items-center gap-1.5 transition-colors"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${minioStatus.checking ? 'animate-spin' : ''}`} />
                  <span>{t("测试并保存")}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 错误横幅提示 */}
      {errorBanner && (
        <div
          role="alert"
          className="bg-rose-950/90 border-b border-rose-500/30 px-4 py-2 flex items-center justify-between gap-3 text-xs text-rose-200 shrink-0 z-30"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{errorBanner}</span>
          </div>
          <button
            type="button"
            aria-label={t("关闭错误提示")}
            onClick={() => setErrorBanner(null)}
            className="p-1 hover:bg-rose-900/50 rounded-lg text-rose-300"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 主体区域：底层常驻 WebGL 画布 + 顶层可切换的「首页三组文件工作台」 */}
      {/* [03_ui_design] 将 main 设置为 relative z-10，低于 Header 的 relative z-40，彻底杜绝下拉框被主卡片遮挡 */}
      <main className="flex-1 relative z-10 overflow-hidden bg-[#111112]">
        {/* WebGL CAD 视口容器（始终保持挂载以保护 WebGL 上下文单例） */}
        {/* [09_viewport_interaction] 默认平移抓手光标与拖拽抓紧光标穿透 */}
        <div
          ref={viewportContainerRef}
          data-testid="mlightcad-viewport"
          className={`w-full h-full relative outline-none ${
            isSpacePressed || activeViewerTool === 'pan'
              ? 'cursor-grab active:cursor-grabbing [&_canvas]:!cursor-grab active:[&_canvas]:!cursor-grabbing'
              : 'cursor-crosshair [&>canvas]:!cursor-crosshair'
          }`}
        />

        {/* === 路由兜底视图 (`/`)：应用首页工作台 (Home Hub) === */}
        {viewMode === 'home' && (
          <div data-testid="home-workspace-hub" className="workbench">
            <div className="workbench-inner">
              <div className="desk-heading">
                <h1>{t("图纸工作台")}</h1>
                {Capacitor.isNativePlatform() && <span role="note">{t("移动端支持本地文件。工作区与 MinIO 需在桌面端使用。")}</span>}
                {hasLoadedAnyDrawing && <IconButton label={`返回画布 · ${loadedMeta.fileName}`} data-testid="return-active-canvas-btn" onClick={() => resumeDetail()}><ArrowUpRight /></IconButton>}
              </div>
              <div className="source-grid">
                <section className="source-panel" data-testid="home-card-builtin">
                  <div className="source-heading"><FolderOpen /><h2>{t("工作区图纸")}</h2><ValueTag>{samples.length}</ValueTag>
                    <div className="source-actions">
                      <IconButton label={t("工作区设置")} onClick={() => setShowWorkspaceModal(true)}><SlidersHorizontal /></IconButton>
                      <IconButton label={t("刷新工作区")} disabled={isScanningSamples} onClick={() => void fetchSamples(activeWorkspaceDir)}><RefreshCw /></IconButton>
                    </div>
                  </div>
                  <div className="source-controls">
                    <div className="source-values"><ValueTag label={t("目录")}>{activeWorkspaceDir}</ValueTag>
                      <IconButton label={t("选择工作区目录")} data-testid="choose-local-workspace-btn" onClick={() => void handleSelectWorkspaceFolder()}><FolderOpen /></IconButton>
                    </div>
                  </div>
                  <div className="drawing-list">
                    {samples.map(item => {
                      const hit = findCachedDrawing(item.name);
                      return <DrawingRow key={item.url} name={item.name} size={item.sizeLabel} cached={Boolean(hit)} onOpen={() => void handleOpenBuiltinDrawing(item, hit)} />;
                    })}
                    {!samples.length && <p className="empty-list">{t("目录中暂无图纸")}</p>}
                  </div>
                </section>
                <section className="source-panel" data-testid="home-card-minio">
                  <div className="source-heading"><Cloud /><h2>MinIO</h2>
                    <ValueTag tone={minioStatus.checking ? 'neutral' : minioStatus.connected ? 'ready' : 'warning'}>{minioStatus.checking ? t("连接中") : minioStatus.connected ? t("已连接") : t("未连接")}</ValueTag>
                    <div className="source-actions">
                      <IconButton label={t("MinIO 连接设置")} onClick={() => setShowMinioConfigBar(true)}><SlidersHorizontal /></IconButton>
                      <IconButton label={t("刷新存储桶")} disabled={minioStatus.checking} onClick={() => void checkMinioStatus()}><RefreshCw /></IconButton>
                    </div>
                  </div>
                  <div className="source-controls">
                    <div className="source-values">{(minioStatus.endpoint || minioEndpoint) && <ValueTag label={t("节点")}>{minioStatus.endpoint || minioEndpoint}</ValueTag>}{(minioStatus.bucket || minioBucket) && <ValueTag label={t("桶")} tone="info">{minioStatus.bucket || minioBucket}</ValueTag>}
                      {minioStatus.connected && minioStatus.latencyMs != null && <ValueTag>{minioStatus.latencyMs} ms</ValueTag>}
                    </div>
                    <form className="object-input" onSubmit={e => { e.preventDefault(); void handleOpenMinioDrawing(minioPathInput); }}>
                      <input aria-label={t("MinIO 对象路径")} placeholder={t("对象路径")} value={minioPathInput} onChange={e => setMinioPathInput(e.target.value)} />
                      <IconButton label={t("打开对象")} type="submit"><ArrowUpRight /></IconButton>
                    </form>
                    {!!minioHistoryPaths.length && <details className="recent-paths"><summary>{t("最近访问")}</summary>
                      {minioHistoryPaths.slice(0, 5).map(path => <button key={path} title={path} onClick={() => { setMinioPathInput(path); void handleOpenMinioDrawing(path); }}>{path}</button>)}
                    </details>}
                  </div>
                  <div className="drawing-list">
                    {minioStatus.files.map(item => {
                      const hit = findCachedDrawing(item.name);
                      return <DrawingRow key={item.path} name={item.name} size={item.sizeLabel} path={item.path} cached={Boolean(hit)} onOpen={() => void handleOpenMinioDrawing(item.path, hit)} />;
                    })}
                    {!minioStatus.files.length && <p className="empty-list" title={minioStatus.error || undefined}>{minioStatus.checking ? t("正在读取图纸…") : minioStatus.error ? t("连接失败，请检查连接设置") : minioStatus.connected ? t("存储桶中暂无图纸") : t("请配置 MinIO 连接")}</p>}
                  </div>
                </section>
                <section className="source-panel" data-testid="home-card-local">
                  <div className="source-heading"><Upload /><h2>{t("本地文件")}</h2></div>
                  <div className="source-controls">
                    <button type="button" className="file-drop" data-testid="home-local-upload-dropzone" onClick={() => void handleTriggerLocalUpload()}>
                      <Upload size={25} /><strong>{t("选择或拖入图纸")}</strong><span>.dwg · .dwg.cache.gz</span>
                    </button>
                    <label className="save-choice"><input type="checkbox" checked={saveToWorkspace} onChange={e => handleToggleSaveToWorkspace(e.target.checked)} />{t("保存至工作区")}</label>
                  </div>
                  <div className="cache-heading"><h3>{t("图纸缓存")}</h3><ValueTag>{cacheEntries.length}</ValueTag><IconButton label={t("管理缓存")} onClick={() => setShowCachePanel(true)}><FileArchive /></IconButton></div>
                  <div className="drawing-list">
                    {cacheEntries.map(item => <DrawingRow key={item.fingerprint} cached name={item.fileName} size={formatByteSize(item.compressedBytes)} onOpen={() => void handleOpenCachedDrawing(item)} />)}
                    {!cacheEntries.length && <p className="empty-list">{t("暂无缓存")}</p>}
                  </div>
                </section>
              </div>
            </div>
          </div>
        )}

        {/* 画布加载多节点进度面板（去光污染圆角简约版） */}
        {viewMode === 'viewer' && progress.isLoading && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 w-[94vw] max-w-xl transition-all duration-300">
            <div className="bg-[#1b1b1d]/95 backdrop-blur-md border border-white/10 rounded-2xl shadow-2xl p-4 sm:p-5 text-slate-100 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded-md text-[11px] font-mono font-medium bg-[#303033] text-sky-300 border border-white/10 shrink-0">
                      {t("步骤")} {progress.currentStep}/{progress.totalSteps}
                    </span>
                    <span className="text-xs sm:text-sm font-semibold text-white truncate">
                      {t(progress.stageTitle)}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 font-mono line-clamp-1">
                    {progress.stageDetail}
                  </p>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <div className="flex flex-col items-end">
                    <span className="text-2xl sm:text-3xl font-bold font-mono tracking-tight text-white">
                      {progress.percent}%
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5 text-sky-400" />
                      {t("耗时")} {progress.elapsedSeconds}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsProgressCollapsed((v) => !v)}
                    className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-[#303033] transition-colors"
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

              <div className="w-full bg-[#111112] h-2 rounded-full overflow-hidden border border-white/[0.06]">
                <div
                  className="h-full rounded-full bg-sky-500 transition-all duration-150 ease-out"
                  style={{ width: `${Math.max(4, Math.min(100, progress.percent))}%` }}
                />
              </div>

              {!isProgressCollapsed && (
                <div className="grid grid-cols-5 gap-1.5 pt-2 border-t border-white/[0.06]">
                  {progress.nodes.map((node) => {
                    const isDone = node.status === 'completed';
                    const isActive = node.status === 'active';
                    return (
                      <div
                        key={node.id}
                        className={`flex flex-col items-center text-center gap-1 p-1.5 rounded-xl transition-colors ${
                          isActive
                            ? 'bg-[#303033] border border-white/10'
                            : isDone
                            ? 'bg-[#242426]/60'
                            : 'opacity-40'
                        }`}
                      >
                        <div className="w-4 h-4 rounded-full flex items-center justify-center shrink-0">
                          {isDone ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          ) : isActive ? (
                            <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" />
                          ) : (
                            <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
                          )}
                        </div>
                        <span
                          className={`text-[10px] sm:text-[11px] font-medium truncate max-w-full ${
                            isActive
                              ? 'text-white font-semibold'
                              : isDone
                              ? 'text-slate-300'
                              : 'text-slate-500'
                          }`}
                        >
                          {t(node.title)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 全局拖拽上传遮罩层 */}
        {isDraggingOver && (
          <div className="absolute inset-0 z-30 bg-[#111112]/90 border-2 border-dashed border-sky-400/70 rounded-2xl m-2 flex flex-col items-center justify-center gap-2 pointer-events-none">
            <Upload className="w-8 h-8 text-sky-400" />
            <p className="text-sm font-medium text-white">
              释放以打开 DWG 图纸或缓存文件 (.dwg / .dwg.cache.gz)
            </p>
          </div>
        )}

        {/* === 页面下方三大操作组件（拖动查看 / 框选 / 编辑预留）=== */}
        {/* [03_ui_design] 视口悬浮工具栏：区分 APP 移动端大触控区（min-h-[44px]）与桌面端快捷键与悬停反馈 */}
        {viewMode === 'viewer' && (
          <aside
            role="toolbar"
            aria-label={t("画布交互工具栏")}
            className="fixed bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 z-30 pointer-events-auto select-none"
          >
            <div className="flex items-center gap-1 sm:gap-1.5 p-1 sm:p-1.5 bg-[#1b1b1d]/90 backdrop-blur-md border border-white/[0.12] rounded-2xl shadow-2xl shadow-black/70">
              {/* 1. 拖动查看 (平移模式) */}
              <button
                type="button"
                data-testid="tool-pan-btn"
                onClick={() => handleSwitchViewerTool('pan')}
                className={`flex items-center gap-1.5 px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-medium transition-all ${
                  activeViewerTool === 'pan'
                    ? 'bg-sky-500/20 text-sky-400 border border-sky-500/40 shadow-sm shadow-sky-500/20'
                    : 'text-slate-300 hover:text-white hover:bg-white/[0.06] border border-transparent'
                } min-h-[44px] min-w-[44px] sm:min-w-0`}
                aria-pressed={activeViewerTool === "pan"} aria-label={t("平移")} title={t("平移 · H / 空格")}
              >
                <Hand className="w-4 h-4 sm:w-4.5 sm:h-4.5 shrink-0" />

              </button>

              {/* 2. 框选 (图元框选) */}
              <button
                type="button"
                data-testid="tool-select-btn"
                onClick={() => handleSwitchViewerTool('select')}
                className={`flex items-center gap-1.5 px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-medium transition-all ${
                  activeViewerTool === 'select'
                    ? 'bg-sky-500/20 text-sky-400 border border-sky-500/40 shadow-sm shadow-sky-500/20'
                    : 'text-slate-300 hover:text-white hover:bg-white/[0.06] border border-transparent'
                } min-h-[44px] min-w-[44px] sm:min-w-0`}
                aria-pressed={activeViewerTool === "select"} aria-label={t("框选")} title={t("框选 · S")}
              >
                <BoxSelect className="size-4" />
              </button>
            </div>
          </aside>
        )}
      </main>
        {/* [03_ui_design] 关于 DWG-viewer 与版本信息查看弹窗 */}
        {showAboutModal && (
          <AboutDialog onDismiss={() => setShowAboutModal(false)}>
              <div className="about-heading"><CadBrandLogoSvg className="size-8" /><h2 id="about-dialog-title">DWG-viewer</h2>
                <IconButton label={t("关闭关于")} data-testid="close-about-modal-btn" onClick={() => setShowAboutModal(false)}><X /></IconButton>
              </div>
              <dl className="about-details">
                <div><dt>{t("语言")}</dt><dd><select className="rounded bg-neutral-700 px-2 py-1" aria-label={t("语言")} value={language} onChange={e => setLanguage(e.target.value === 'en' ? 'en' : 'zh')}><option value="zh">简体中文</option><option value="en">English</option></select></dd></div>
                <div><dt>{t("版本")}</dt><dd><ValueTag>v{appVersion}</ValueTag></dd></div>
                <div><dt>{t("运行环境")}</dt><dd><ValueTag>{window.electronAPI ? t("Windows 桌面端") : t("浏览器")}</ValueTag></dd></div>
                <div><dt>{t("图形接口")}</dt><dd><ValueTag>{gpuInfo.webglVersion.toUpperCase()}</ValueTag></dd></div>
              </dl>
          </AboutDialog>
        )}


    </div>
  );
}
