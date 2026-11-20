/**
 * 三模式语义化 URL 路由解析与构建模块
 * 支持：
 * - `/` -> 路由兜底：应用首页工作台 (Home Hub)
 * - `/builtin/:fileName(?dir=...)` -> 方式 1：项目内置或自定义工作区图纸
 * - `/minio/:bucket/...key(?endpoint=...)` -> 方式 2：MinIO S3 远程图纸
 * - `/local/:fileName(?fp=...)` -> 方式 3：本地上传与 Gzip 共享缓存图纸
 * 同时兼容旧版 `?url=...` 查询参数与 Electron `file://` Hash 路由。
 */

export type DwgRouteMode = 'home' | 'builtin' | 'minio' | 'local';

export interface DwgRouteState {
  /** 当前路由模式：home 为首页工作台，builtin/minio/local 为三类图纸源 */
  mode: DwgRouteMode;
  /** 图纸文件名或对象存储路径（如 `canteen.dwg` 或 `drawings/dwg/sample.dwg`） */
  filePath?: string;
  /** 方式 1 自定义工作区目录路径（当非默认 public/samples 时通过 ?dir= 携带） */
  workspaceDir?: string;
  /** 方式 3 本地或缓存文件的 Gzip 指纹（通过 ?fp= 携带，支持局域网 L2 缓存跨机秒开） */
  fingerprint?: string;
  /** 方式 2 自定义 MinIO 服务地址（通过 ?endpoint= 携带） */
  minioEndpoint?: string;
}

/**
 * 安全解码 URL 路径片段，防止非法百分号序列导致 URIError 崩溃。
 */
function safeDecodeURIComponent(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * 判断工作区目录是否为默认的 `public/samples` 目录。
 */
export function isDefaultSamplesWorkspaceDir(dir?: string): boolean {
  if (!dir) return true;
  const normalized = dir.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!normalized || normalized === 'public/samples' || normalized === '/samples') {
    return true;
  }
  return normalized.endsWith('/public/samples');
}

/**
 * 将 MinIO 各种输入格式（如 `/api/minio/stream?path=...`、完整 HTTP URL 或相对路径）
 * 归一化为标准的 `bucket/key` 路径格式。
 */
export function normalizeMinioObjectPath(
  rawInput: string,
  defaultBucket = ''
): string {
  let cleaned = (rawInput || '')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/／/g, '/');

  if (!cleaned) return '';

  // 若是 /api/minio/stream?path=... 格式，提取其中的 path 参数
  if (cleaned.includes('/api/minio/stream')) {
    try {
      const parsed = new URL(cleaned, 'http://localhost');
      const pathParam = parsed.searchParams.get('path');
      if (pathParam) {
        cleaned = safeDecodeURIComponent(pathParam);
      }
    } catch {
      // ignore
    }
  } else if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) {
    // 从完整 S3 或 Console URL 提取存储桶和对象路径。
    const consoleMatch = cleaned.match(/(?:https?:\/\/[^/]+(?::\d+)?)?\/browser\/([^/]+)\/(.+)$/);
    if (consoleMatch) {
      cleaned = `${consoleMatch[1]}/${safeDecodeURIComponent(consoleMatch[2])}`;
    } else {
      try {
        const parsed = new URL(cleaned);
        cleaned = safeDecodeURIComponent(parsed.pathname);
      } catch {
        // ignore
      }
    }
  }

  cleaned = cleaned.replace(/^\/+/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length === 0) return '';

  // 若仅提供了文件名或以 dwg/ 开头，自动补全默认存储桶前缀
  if (defaultBucket && (parts.length === 1 || parts[0].toLowerCase() === 'dwg')) {
    return `${defaultBucket}/${parts.join('/')}`;
  }

  return parts.join('/');
}

/**
 * 从浏览器 Location (`pathname`, `search`, `hash`) 解析出当前路由状态 `DwgRouteState`。
 * 任何空路径 `/` 或未知路径均自动兜底为 `{ mode: 'home' }`（展示首页工作台）。
 */
export function parseDwgRouteFromLocation(
  pathname: string,
  search = '',
  hash = ''
): DwgRouteState {
  let effectivePath = (pathname || '/').trim();
  let effectiveSearch = (search || '').trim();

  // 兼容 Electron 桌面端 file:// 协议下的 Hash 路由（例如 #/builtin/canteen.dwg?dir=...）
  if (hash && hash.startsWith('#/')) {
    const hashContent = hash.slice(1);
    const qIdx = hashContent.indexOf('?');
    if (qIdx >= 0) {
      effectivePath = hashContent.slice(0, qIdx);
      effectiveSearch = hashContent.slice(qIdx);
    } else {
      effectivePath = hashContent;
      effectiveSearch = '';
    }
  }

  const params = new URLSearchParams(
    effectiveSearch.startsWith('?') ? effectiveSearch.slice(1) : effectiveSearch
  );

  // 规范化路径片段
  const segments = effectivePath
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  // 1. 方式 1：/builtin/:fileName(?dir=...)
  if (segments[0] === 'builtin' && segments.length >= 2) {
    const rawFileName = segments.slice(1).map(safeDecodeURIComponent).join('/');
    const dirParam = params.get('dir')?.trim() || undefined;
    if (rawFileName) {
      return {
        mode: 'builtin',
        filePath: rawFileName,
        workspaceDir: dirParam && !isDefaultSamplesWorkspaceDir(dirParam) ? dirParam : undefined,
      };
    }
    return { mode: 'home' };
  }

  // 2. 方式 2：/minio/:bucket/...key(?endpoint=...)
  if (segments[0] === 'minio' && segments.length >= 2) {
    const decodedSegments = segments.slice(1).map(safeDecodeURIComponent);
    const rawMinioPath = decodedSegments.join('/');
    const normalizedPath = normalizeMinioObjectPath(rawMinioPath);
    const endpointParam =
      params.get('endpoint')?.trim() || params.get('minioEndpoint')?.trim() || undefined;
    if (normalizedPath) {
      return {
        mode: 'minio',
        filePath: normalizedPath,
        minioEndpoint: endpointParam,
      };
    }
    return { mode: 'home' };
  }

  // 3. 方式 3：/local/:fileName(?fp=...)
  if (segments[0] === 'local' && segments.length >= 2) {
    const fileName = segments.slice(1).map(safeDecodeURIComponent).join('/');
    const fp = params.get('fp')?.trim() || undefined;
    if (fileName) {
      return {
        mode: 'local',
        filePath: fileName,
        fingerprint: fp,
      };
    }
    return { mode: 'home' };
  }

  // 4. 向下兼容旧版查询参数（?url=... / ?fileUrl=... / ?minioUrl=...）
  const legacyUrl = (
    params.get('url') ||
    params.get('fileUrl') ||
    params.get('minioUrl') ||
    ''
  ).trim();
  if (legacyUrl) {
    if (legacyUrl.startsWith('/samples/') || legacyUrl.startsWith('samples/')) {
      const cleanName = safeDecodeURIComponent(
        legacyUrl.replace(/^\/?samples\//, '').trim()
      );
      if (cleanName) {
        return {
          mode: 'builtin',
          filePath: cleanName,
        };
      }
    } else if (legacyUrl.includes('/api/workspace/file')) {
      try {
        const parsed = new URL(legacyUrl, 'http://localhost');
        const nameParam = parsed.searchParams.get('name');
        const dirParam = parsed.searchParams.get('dir') || undefined;
        if (nameParam) {
          return {
            mode: 'builtin',
            filePath: safeDecodeURIComponent(nameParam),
            workspaceDir:
              dirParam && !isDefaultSamplesWorkspaceDir(dirParam) ? dirParam : undefined,
          };
        }
      } catch {
        // ignore
      }
    } else {
      const normalizedMinio = normalizeMinioObjectPath(legacyUrl);
      const endpointParam =
        params.get('endpoint')?.trim() || params.get('minioEndpoint')?.trim() || undefined;
      if (normalizedMinio) {
        return {
          mode: 'minio',
          filePath: normalizedMinio,
          minioEndpoint: endpointParam,
        };
      }
    }
  }

  // 5. 空路径 `/` 或其它未识别路径统一兜底至应用首页工作台
  return { mode: 'home' };
}

/**
 * 根据路由状态 `DwgRouteState` 生成规范化的浏览器 URL 路径（支持直接复制分享）。
 */
export function buildDwgRouteUrl(state: DwgRouteState): string {
  if (!state || state.mode === 'home') {
    return '/';
  }

  if (state.mode === 'builtin') {
    const cleanName = (state.filePath || '')
      .trim()
      .replace(/^\/?samples\//, '')
      .replace(/^.*[\\/]/, '');
    if (!cleanName) return '/';
    const base = `/builtin/${encodeURIComponent(cleanName)}`;
    if (state.workspaceDir && !isDefaultSamplesWorkspaceDir(state.workspaceDir)) {
      return `${base}?dir=${encodeURIComponent(state.workspaceDir.trim())}`;
    }
    return base;
  }

  if (state.mode === 'minio') {
    const normalizedPath = normalizeMinioObjectPath(state.filePath || '');
    if (!normalizedPath) return '/';
    const encodedSegments = normalizedPath
      .split('/')
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const base = `/minio/${encodedSegments}`;
    const ep = state.minioEndpoint?.trim();
    if (ep) {
      return `${base}?endpoint=${encodeURIComponent(ep)}`;
    }
    return base;
  }

  if (state.mode === 'local') {
    const cleanName = (state.filePath || '').trim().replace(/^.*[\\/]/, '');
    if (!cleanName) return '/';
    const base = `/local/${encodeURIComponent(cleanName)}`;
    if (state.fingerprint?.trim()) {
      return `${base}?fp=${encodeURIComponent(state.fingerprint.trim())}`;
    }
    return base;
  }

  return '/';
}

/**
 * 根据方式 1 的文件名与工作区目录，生成用于引擎加载的实际 HTTP URL。
 */
export function buildBuiltinFetchUrl(fileName: string, workspaceDir?: string): string {
  const cleanName = (fileName || '')
    .trim()
    .replace(/^\/?samples\//, '')
    .replace(/^.*[\\/]/, '');
  if (!cleanName) return '';
  if (!workspaceDir || isDefaultSamplesWorkspaceDir(workspaceDir)) {
    return `/samples/${cleanName}`;
  }
  return `/api/workspace/file?name=${encodeURIComponent(cleanName)}&dir=${encodeURIComponent(
    workspaceDir.trim()
  )}`;
}
