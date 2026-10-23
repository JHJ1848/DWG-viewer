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
 * Extracts a clean .dwg file name from a MinIO presigned URL, Spring proxy URL, or relative path.
 */
export function extractFileNameFromUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return 'remote.dwg';
  try {
    const parsed = new URL(trimmed, 'http://localhost');

    // 1. If URL has a 'path' query parameter (e.g. /api/minio/get_file?path=nonglintu/dwg/test.dwg)
    const queryPath = parsed.searchParams.get('path');
    if (queryPath) {
      const decodedQuery = decodeURIComponent(queryPath);
      const segments = decodedQuery.split('/').filter(Boolean);
      const last = segments[segments.length - 1];
      if (last) {
        return last.toLowerCase().endsWith('.dwg') ? last : `${last}.dwg`;
      }
    }

    // 2. Fallback to pathname segments
    const segments = parsed.pathname.split('/').filter(Boolean);
    const lastSegment = segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]) : '';
    if (lastSegment && lastSegment !== 'get_file') {
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

export const DEFAULT_MINIO_API_BASE =
  typeof window !== 'undefined' && window.location && window.location.origin
    ? ''
    : 'http://192.168.81.163:9008';

/**
 * Normalizes user input (MinIO console URL, relative object path, or direct proxy URL)
 * into a standardized Spring Boot MinIO proxy URL.
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

  // 4. Auto-append .dwg extension if missing for relative paths (e.g. nonglintu/dwg/1如意乡平图1 -> .dwg)
  if (
    trimmed.includes('/') &&
    !trimmed.startsWith('http://') &&
    !trimmed.startsWith('https://') &&
    !trimmed.toLowerCase().endsWith('.dwg') &&
    !trimmed.includes('?')
  ) {
    trimmed = `${trimmed}.dwg`;
  }

  // 5. MinIO Console URL: :9090/browser/:bucket/:encodedObjectKey
  const consoleMatch = trimmed.match(/(?:https?:\/\/[^/]+(?::\d+)?)?\/browser\/([^/]+)\/(.+)$/);
  if (consoleMatch) {
    const bucket = consoleMatch[1];
    const objectKey = decodeURIComponent(consoleMatch[2]);
    const fullPath = `${bucket}/${objectKey}`;
    const base = apiBaseUrl || '';
    return `${base}/api/minio/get_file?path=${encodeURIComponent(fullPath)}&preview=true&inline=true`;
  }

  // 6. Already full proxy URL: replace legacy /api/feqi/minio/get_file if present
  if (trimmed.includes('/minio/get_file')) {
    let normalized = trimmed.replace('/api/feqi/minio/get_file', '/api/minio/get_file');
    if (!normalized.includes('preview=')) {
      normalized += `${normalized.includes('?') ? '&' : '?'}preview=true&inline=true`;
    }
    return normalized;
  }

  // 7. MinIO relative object path: e.g. nonglintu/dwg/1如意乡平图1.dwg
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    const cleanPath = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
    const base = apiBaseUrl || '';
    return `${base}/api/minio/get_file?path=${encodeURIComponent(cleanPath)}&preview=true&inline=true`;
  }

  return trimmed;
}

