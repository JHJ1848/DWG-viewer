export interface DwgValidationResult {
  valid: boolean;
  reason?: string;
}

export interface DwgHeaderInfo {
  isDwg: boolean;
  versionCode: string;
  versionLabel: string;
}

const DWG_VERSION_MAP: Record<string, string> = {
  AC1012: 'AutoCAD R13 DWG',
  AC1014: 'AutoCAD R14 DWG',
  AC1015: 'AutoCAD 2000/2002 DWG',
  AC1018: 'AutoCAD 2004/2006 DWG',
  AC1021: 'AutoCAD 2007/2009 DWG',
  AC1024: 'AutoCAD 2010/2012 DWG',
  AC1027: 'AutoCAD 2013/2017 DWG',
  AC1032: 'AutoCAD 2018+ DWG',
};

/**
 * Validates that a file name strictly has the .dwg extension.
 */
export function validateDwgFileName(fileName: string): DwgValidationResult {
  const trimmed = (fileName || '').trim();
  if (!trimmed) {
    return { valid: false, reason: '文件名不能为空' };
  }
  const lower = trimmed.toLowerCase();
  if (!lower.endsWith('.dwg')) {
    const ext = trimmed.includes('.') ? `.${trimmed.split('.').pop()}` : '未知格式';
    return {
      valid: false,
      reason: `格式不受支持 (${ext})：本工具专用于 AutoCAD .dwg 二维工程图纸预览`,
    };
  }
  return { valid: true };
}

/**
 * Validates that a file name is either a standard .dwg drawing or a Gzip-compressed DWG cache (.dwg.cache.gz / .gz).
 */
export function validateDwgOrCacheFileName(fileName: string): DwgValidationResult {
  const trimmed = (fileName || '').trim();
  if (!trimmed) {
    return { valid: false, reason: '文件名不能为空' };
  }
  const lower = trimmed.toLowerCase();
  if (
    lower.endsWith('.dwg') ||
    lower.endsWith('.dwg.cache.gz') ||
    lower.endsWith('.cache.gz') ||
    lower.endsWith('.dwg.gz') ||
    lower.endsWith('.gz')
  ) {
    return { valid: true };
  }
  const ext = trimmed.includes('.') ? `.${trimmed.split('.').pop()}` : '未知格式';
  return {
    valid: false,
    reason: `格式不受支持 (${ext})：仅支持 AutoCAD .dwg 图纸或 .dwg.cache.gz 本地压缩缓存文件`,
  };
}

/**
 * Reads the first 6 bytes of a DWG binary buffer to identify its AutoCAD version signature.
 */
export function inspectDwgHeader(buffer: ArrayBuffer | Uint8Array): DwgHeaderInfo {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 6) {
    return {
      isDwg: false,
      versionCode: 'UNKNOWN',
      versionLabel: '非标准或过短文件',
    };
  }

  let code = '';
  for (let i = 0; i < 6; i++) {
    code += String.fromCharCode(bytes[i]);
  }

  if (code.startsWith('AC10')) {
    return {
      isDwg: true,
      versionCode: code,
      versionLabel: DWG_VERSION_MAP[code] || `AutoCAD DWG (${code})`,
    };
  }

  return {
    isDwg: false,
    versionCode: code,
    versionLabel: '非标准 DWG 文件头',
  };
}

/**
 * Formats byte count into human-readable KB / MB string.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Extracts a clean .dwg file name from a MinIO S3 URL, `/api/minio/stream` URL, or relative path.
 */
export function extractFileNameFromUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return 'remote.dwg';
  try {
    const parsed = new URL(trimmed, 'http://localhost');

    // 1. If URL has a 'name' or 'path' query parameter (e.g. /api/workspace/file?name=test.dwg or /api/minio/stream?path=drawings/dwg/test.dwg)
    const queryName = parsed.searchParams.get('name') || parsed.searchParams.get('path');
    if (queryName) {
      const decodedQuery = decodeURIComponent(queryName);
      const segments = decodedQuery.split(/[\\/]/).filter(Boolean);
      const last = segments[segments.length - 1];
      if (last) {
        return last.toLowerCase().endsWith('.dwg') || last.toLowerCase().endsWith('.gz')
          ? last
          : `${last}.dwg`;
      }
    }

    // 2. Fallback to pathname segments
    const segments = parsed.pathname.split('/').filter(Boolean);
    const lastSegment = segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]) : '';
    if (lastSegment && lastSegment !== 'stream') {
      return lastSegment.toLowerCase().endsWith('.dwg') ? lastSegment : `${lastSegment}.dwg`;
    }
  } catch {
    const cleanPath = trimmed.split('?')[0].split('#')[0];
    const parts = cleanPath.split('/').filter(Boolean);
    if (parts.length > 0) {
      const name = parts[parts.length - 1];
      return name.toLowerCase().endsWith('.dwg') ? name : `${name}.dwg`;
    }
  }
  return 'remote.dwg';
}

export const DEFAULT_MINIO_API_BASE = '';

/**
 * Normalizes user input (MinIO Console URL, S3 object URL, relative object path, or `/api/minio/stream` URL)
 * into a standardized `/api/minio/stream?path=...` streaming URL.
 * Automatically handles mobile input anomalies: full-width slashes (／), surrounding quotes, and missing .dwg extension.
 */
export function resolveMinioDwgUrl(
  inputUrl: string,
  apiBaseUrl = DEFAULT_MINIO_API_BASE
): string {
  let trimmed = (inputUrl || '').trim();
  if (!trimmed) return '';

  // 1. Strip surrounding quotes (often introduced by mobile copy-paste)
  trimmed = trimmed.replace(/^["'“”‘’]/, '').replace(/["'“”‘’]$/, '').trim();

  // 2. Normalize full-width slashes commonly typed on mobile keyboards
  trimmed = trimmed.replace(/／/g, '/');

  // 3. Local static sample drawings or public assets: preserve as local relative path
  if (trimmed.startsWith('/samples/') || trimmed.startsWith('samples/')) {
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }

  // 4. Already a local `/api/minio/stream` or `/api/workspace/file` URL: return as-is
  if (trimmed.includes('/api/minio/stream') || trimmed.includes('/api/workspace/file')) {
    return trimmed;
  }

  // 5. Auto-append .dwg extension if missing for relative paths (e.g. drawings/dwg/示例图纸一 -> .dwg)
  if (
    trimmed.includes('/') &&
    !trimmed.startsWith('http://') &&
    !trimmed.startsWith('https://') &&
    !trimmed.toLowerCase().endsWith('.dwg') &&
    !trimmed.toLowerCase().endsWith('.gz') &&
    !trimmed.includes('?')
  ) {
    trimmed = `${trimmed}.dwg`;
  }

  const base = apiBaseUrl || '';

  // 6. MinIO Console URL: :9090/browser/:bucket/:encodedObjectKey
  const consoleMatch = trimmed.match(/(?:https?:\/\/[^/]+(?::\d+)?)?\/browser\/([^/]+)\/(.+)$/);
  if (consoleMatch) {
    const bucket = consoleMatch[1];
    const objectKey = decodeURIComponent(consoleMatch[2]);
    const fullPath = `${bucket}/${objectKey}`;
    return `${base}/api/minio/stream?path=${encodeURIComponent(fullPath)}`;
  }

  // 7. Direct MinIO S3 URL (e.g. http://storage.example.invalid:9000/drawings/dwg/01.dwg or any custom http(s)://host:port/bucket/key.dwg)
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    // Preserve presigned S3 URLs directly
    if (trimmed.includes('X-Amz-Signature=')) {
      return trimmed;
    }
    try {
      const parsed = new URL(trimmed);
      const cleanPath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
      if (cleanPath && cleanPath.includes('/')) {
        return `${base}/api/minio/stream?path=${encodeURIComponent(cleanPath)}`;
      }
    } catch {
      // Fallback to returning original URL
    }
    return trimmed;
  }

  // 8. MinIO relative object path: e.g. drawings/dwg/示例总平面图.dwg or dwg/01.dwg
  const cleanPath = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  return `${base}/api/minio/stream?path=${encodeURIComponent(cleanPath)}`;
}
