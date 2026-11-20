import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

/**
 * 生产或 Electron 打包环境下，__dirname 位于只读的 asar 归档中，
 * 强制将 Gzip 缓存目录迁移至用户家目录 ~/.dwgViewer/cache/dwg-gzip，避免 ENOTDIR 崩溃。
 */
const isElectronOrProduction =
  Boolean(process.versions?.electron) || process.env.NODE_ENV === 'production';
const CACHE_DIR = isElectronOrProduction
  ? path.join(os.homedir(), '.dwgViewer', 'cache', 'dwg-gzip')
  : path.resolve(__dirname, '.cache', 'dwg-gzip');
const INDEX_FILE = path.join(CACHE_DIR, 'index.json');
const MAX_SERVER_CACHE_ENTRIES = 30;
/**
 * 智能探测系统或打包环境下的内置示例/默认图纸工作区目录
 * 依次尝试源码 public/samples、dist/samples、便携版上级目录及系统用户安全工作区目录
 */
function resolveDefaultWorkspaceDir(): string {
  const candidates = [
    path.resolve(__dirname, 'public', 'samples'),
    path.resolve(__dirname, '..', 'public', 'samples'),
    path.resolve(__dirname, 'dist', 'samples'),
    path.resolve(__dirname, '..', 'dist', 'samples'),
    path.resolve(process.cwd(), 'public', 'samples'),
    path.resolve(process.cwd(), 'samples'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  // 便携版或首次启动且上述目录均不存在时，平滑创建并回退至 ~/.dwgViewer/workspace
  const fallbackUserWorkspace = path.join(os.homedir(), '.dwgViewer', 'workspace');
  try {
    if (!fs.existsSync(fallbackUserWorkspace)) {
      fs.mkdirSync(fallbackUserWorkspace, { recursive: true });
    }
    return fallbackUserWorkspace;
  } catch {
    return process.cwd();
  }
}

const SAMPLES_DIR = resolveDefaultWorkspaceDir();
const PROJECT_ROOT_DIR = path.resolve(__dirname);

/**
 * Windows 用户盘轻量配置目录 (~/.dwgViewer/config.json)
 * 严禁在此目录存放任何 .dwg 或 .dwg.cache.gz 二进制文件，仅允许保存 < 64KB 的纯 JSON 路径与偏好配置，防止占用 C 盘空间。
 */
const USER_CONFIG_DIR = path.join(os.homedir(), '.dwgViewer');
const USER_CONFIG_FILE = path.join(USER_CONFIG_DIR, 'config.json');
const MAX_USER_CONFIG_BYTES = 64 * 1024;
const MAX_WORKSPACE_HISTORY = 12;

// Default MinIO S3 Direct Connection Configuration (Access Key + Secret Key)
const DEFAULT_MINIO_CONFIG = {
  endpoint: process.env.MINIO_ENDPOINT?.trim() || '',
  accessKey: process.env.MINIO_ACCESS_KEY?.trim() || '',
  secretKey: process.env.MINIO_SECRET_KEY?.trim() || '',
  bucket: process.env.MINIO_BUCKET?.trim() || '',
  region: process.env.MINIO_REGION || 'us-east-1',
};

export interface MinioConnectionConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
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

export interface ServerGzipCacheMeta {
  fingerprint: string;
  fileName: string;
  originalByteLength: number;
  rawJsonBytes: number;
  compressedBytes: number;
  compressionRatio: number;
  versionLabel: string;
  entityCount: number;
  layerCount: number;
  wasmParseMs: number;
  createdAt: number;
  updatedAt: number;
}

export interface SampleFileItem {
  name: string;
  url: string;
  size: number;
  sizeLabel: string;
  workspaceDir?: string;
}

export interface DwgViewerUserConfig {
  /** 当前激活的默认工作区目录（方式 1 扫描目录） */
  activeWorkspaceDir: string;
  /** 历史工作区目录记忆列表（去重，最多 12 条） */
  workspaceHistory: string[];
  /** 最近更新时间戳 */
  updatedAt: number;
}

/**
 * Formats byte count into human-readable label (e.g. 2.50 MB, 79.7 KB).
 */
function formatFileSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Resolves effective MinIO credentials from request headers or query params,
 * falling back to DEFAULT_MINIO_CONFIG when omitted.
 */
function resolveMinioConfigFromRequest(req: express.Request): MinioConnectionConfig {
  const headerEndpoint = String(req.headers['x-minio-endpoint'] || '').trim();
  const headerAccessKey = String(req.headers['x-minio-access-key'] || '').trim();
  const headerSecretKey = String(req.headers['x-minio-secret-key'] || '').trim();
  const headerBucket = String(req.headers['x-minio-bucket'] || '').trim();

  const queryEndpoint = String(req.query.endpoint || '').trim();
  const queryAccessKey = String(req.query.accessKey || '').trim();
  const querySecretKey = String(req.query.secretKey || '').trim();
  const queryBucket = String(req.query.bucket || '').trim();

  const rawEndpoint = headerEndpoint || queryEndpoint || DEFAULT_MINIO_CONFIG.endpoint;
  const normalizedEndpoint = rawEndpoint.replace(/\/+$/, '');
  const useServerCredentials = normalizedEndpoint === DEFAULT_MINIO_CONFIG.endpoint.replace(/\/+$/, '');

  return {
    endpoint: normalizedEndpoint,
    accessKey: headerAccessKey || queryAccessKey || (useServerCredentials ? DEFAULT_MINIO_CONFIG.accessKey : ''),
    secretKey: headerSecretKey || querySecretKey || (useServerCredentials ? DEFAULT_MINIO_CONFIG.secretKey : ''),
    bucket: headerBucket || queryBucket || DEFAULT_MINIO_CONFIG.bucket,
    region: DEFAULT_MINIO_CONFIG.region,
  };
}

function hasMinioConnection(config: MinioConnectionConfig, bucket: string): boolean {
  return Boolean(config.endpoint && config.accessKey && config.secretKey && bucket);
}

/**
 * Computes HMAC-SHA256 digest buffer.
 */
function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * Computes SHA-256 hex digest string.
 */
function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Strict RFC 3986 URI encoding required by AWS S3 Signature Version 4.
 */
function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Encodes each segment of an S3 URI path according to AWS Signature V4 CanonicalURI rules.
 */
function buildCanonicalUri(rawPathname: string): string {
  const segments = rawPathname.split('/');
  return segments
    .map((seg) => {
      try {
        return encodeRfc3986(decodeURIComponent(seg));
      } catch {
        return encodeRfc3986(seg);
      }
    })
    .join('/');
}

/**
 * Builds AWS Signature V4 authorization headers for a MinIO S3 request.
 */
function signS3RequestV4(
  method: string,
  canonicalUri: string,
  queryParams: Record<string, string>,
  config: MinioConnectionConfig
): { url: URL; headers: Record<string, string> } {
  const baseUrl = new URL(config.endpoint);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  // Sort query parameters alphabetically by key for CanonicalQueryString
  const sortedKeys = Object.keys(queryParams).sort();
  const canonicalQueryString = sortedKeys
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(queryParams[k])}`)
    .join('&');

  const hostHeader = baseUrl.host;
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const canonicalHeaders =
    `host:${hostHeader}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // Derive signing key
  const kDate = hmacSha256(`AWS4${config.secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, config.region);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  const authorization =
    `${algorithm} Credential=${config.accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const requestPath = canonicalQueryString
    ? `${canonicalUri}?${canonicalQueryString}`
    : canonicalUri;
  const targetUrl = new URL(requestPath, baseUrl);

  return {
    url: targetUrl,
    headers: {
      Host: hostHeader,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      Authorization: authorization,
    },
  };
}

/**
 * Decodes basic XML entities in S3 ListObjectsV2 responses.
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Parses S3 ListObjectsV2 XML body into MinioRemoteFileItem list.
 */
function parseS3ListXml(xml: string, bucket: string): MinioRemoteFileItem[] {
  const items: MinioRemoteFileItem[] = [];
  const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;

  while ((match = contentsRegex.exec(xml)) !== null) {
    const block = match[1];
    const keyMatch = block.match(/<Key>([\s\S]*?)<\/Key>/);
    const sizeMatch = block.match(/<Size>(\d+)<\/Size>/);
    const modifiedMatch = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/);

    if (!keyMatch) continue;
    const key = decodeXmlEntities(keyMatch[1].trim());
    const size = sizeMatch ? Number(sizeMatch[1]) : 0;
    const lastModified = modifiedMatch ? modifiedMatch[1].trim() : '';

    // Skip folder placeholder keys or non-DWG/Gzip objects
    const lower = key.toLowerCase();
    if (
      key.endsWith('/') ||
      (!lower.endsWith('.dwg') && !lower.endsWith('.dwg.gz') && !lower.endsWith('.cache.gz'))
    ) {
      continue;
    }

    const segments = key.split('/').filter(Boolean);
    const name = segments[segments.length - 1] || key;
    const fullPath = `${bucket}/${key}`;

    items.push({
      key,
      name,
      bucket,
      path: fullPath,
      url: `/api/minio/stream?path=${encodeURIComponent(fullPath)}`,
      size,
      sizeLabel: formatFileSizeLabel(size),
      lastModified,
    });
  }

  // Sort by file size ascending so lightweight drawings appear first
  items.sort((a, b) => a.size - b.size);
  return items;
}

/**
 * Resolves user input path into { bucket, objectKey }.
 * Supports both full `drawings/dwg/sample.dwg` and relative `dwg/sample.dwg`.
 */
function parseMinioBucketAndKey(
  rawPath: string,
  defaultBucket: string
): { bucket: string; objectKey: string } {
  const cleaned = rawPath
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/／/g, '/')
    .replace(/^\/+/, '');

  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length === 0) {
    return { bucket: defaultBucket, objectKey: '' };
  }

  // If only file name or starts with known subfolder `dwg/`, use defaultBucket
  if (parts.length === 1 || parts[0].toLowerCase() === 'dwg') {
    return {
      bucket: defaultBucket,
      objectKey: parts.join('/'),
    };
  }

  return {
    bucket: parts[0],
    objectKey: parts.slice(1).join('/'),
  };
}

function ensureCacheDir(): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
  } catch (err) {
    console.warn('[ServerGzipCache] Failed to ensure cache directory:', err);
  }
}

function sanitizeFingerprint(fp: string): string {
  return String(fp || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 128);
}

function getGzFilePath(fingerprint: string): string {
  const safe = sanitizeFingerprint(fingerprint);
  return path.join(CACHE_DIR, `${safe}.dwg.cache.gz`);
}

function readServerCacheIndex(): Record<string, ServerGzipCacheMeta> {
  ensureCacheDir();
  if (!fs.existsSync(INDEX_FILE)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(INDEX_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, ServerGzipCacheMeta>;
    }
  } catch {
    // Ignore corrupted index
  }
  return {};
}

function writeServerCacheIndex(index: Record<string, ServerGzipCacheMeta>): void {
  ensureCacheDir();
  try {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[ServerGzipCache] Failed to write index.json:', err);
  }
}

/**
 * 校验路径是否在本地磁盘上物理存在且为有效目录。
 * [02_dwg_parser] 历史工作区目录失效自愈清理与去重加固
 */
function isExistingDirectory(dirPath: string): boolean {
  if (!dirPath || typeof dirPath !== 'string') return false;
  try {
    const resolved = path.resolve(dirPath.trim());
    return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 归一化并去重工作区历史路径列表（Windows 下忽略大小写与尾部斜杠差异，可配置过滤已失效目录）。
 * [02_dwg_parser] 历史工作区目录失效自愈清理与去重加固
 */
function deduplicateWorkspaceDirs(dirs: string[], filterNonExistent: boolean = true): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of dirs) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) continue;
    // 归一化路径（消除末尾斜杠及正反斜杠差异）
    const resolved = path.resolve(trimmed);

    // 磁盘物理存在性验证：剔除不存在的幽灵路径
    if (filterNonExistent && !isExistingDirectory(resolved)) {
      continue;
    }

    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(resolved);
    }
    if (result.length >= MAX_WORKSPACE_HISTORY) break;
  }
  return result;
}

/**
 * 判断两个目录路径是否指向同一位置。
 */
function isSameDirectoryPath(dirA: string, dirB: string): boolean {
  const resA = path.resolve(String(dirA || '').trim());
  const resB = path.resolve(String(dirB || '').trim());
  return process.platform === 'win32'
    ? resA.toLowerCase() === resB.toLowerCase()
    : resA === resB;
}

/**
 * [02_dwg_parser] 辅助检测某个路径是否为历史/默认样例目录（如 public/samples、dist/samples、samples 或 ~/.dwgViewer/workspace）。
 */
function isSamplesDirectoryPath(dirPath: string): boolean {
  if (!dirPath || typeof dirPath !== 'string') return false;
  const normalized = dirPath.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  return (
    normalized.endsWith('/public/samples') ||
    normalized.endsWith('/dist/samples') ||
    normalized.endsWith('/samples') ||
    normalized.endsWith('/.dwgviewer/workspace')
  );
}

/**
 * 读取用户主目录 `~/.dwgViewer/config.json` 中的轻量工作区配置。
 * 若不存在则初始化默认配置（包含 `public/samples` 与项目根目录）。
 * [02_dwg_parser] 历史工作区目录失效自愈清理与去重加固
 */
function readUserLightweightConfig(): DwgViewerUserConfig {
  const defaultHistory = deduplicateWorkspaceDirs([SAMPLES_DIR, PROJECT_ROOT_DIR], true);
  const fallback: DwgViewerUserConfig = {
    activeWorkspaceDir: SAMPLES_DIR,
    workspaceHistory: defaultHistory,
    updatedAt: Date.now(),
  };

  try {
    if (!fs.existsSync(USER_CONFIG_FILE)) {
      writeUserLightweightConfig(fallback);
      return fallback;
    }
    const stat = fs.statSync(USER_CONFIG_FILE);
    if (stat.size > MAX_USER_CONFIG_BYTES) {
      console.warn('[UserConfig] config.json exceeds 64KB cap, resetting to lightweight defaults.');
      writeUserLightweightConfig(fallback);
      return fallback;
    }
    const raw = fs.readFileSync(USER_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return fallback;
    }

    let activeDir =
      typeof parsed.activeWorkspaceDir === 'string' && parsed.activeWorkspaceDir.trim()
        ? path.resolve(parsed.activeWorkspaceDir.trim())
        : SAMPLES_DIR;

    let configMigrated = false;

    // [02_dwg_parser] 历史工作区目录失效自愈清理与去重加固：
    // 若原配置 activeWorkspaceDir 属于历史默认样例目录（但并非当前实例的 SAMPLES_DIR），
    // 或者该目录在磁盘上已不存在/不可读，自动纠偏迁移为当前实例运行时的 SAMPLES_DIR
    if (
      (isSamplesDirectoryPath(activeDir) && !isSameDirectoryPath(activeDir, SAMPLES_DIR)) ||
      !isExistingDirectory(activeDir)
    ) {
      activeDir = SAMPLES_DIR;
      configMigrated = true;
    }

    const rawHistory = Array.isArray(parsed.workspaceHistory) ? parsed.workspaceHistory : [];
    // 过滤掉所有指向旧实例但不是当前 SAMPLES_DIR 的历史样例目录，以及磁盘上已不存在的失效幽灵目录
    const cleanedHistory: string[] = [];
    for (const item of rawHistory) {
      if (typeof item !== 'string' || !item.trim()) {
        configMigrated = true;
        continue;
      }
      const resolved = path.resolve(item.trim());
      // 1. 旧样例路径过滤
      if (isSamplesDirectoryPath(resolved) && !isSameDirectoryPath(resolved, SAMPLES_DIR)) {
        configMigrated = true;
        continue;
      }
      // 2. 物理失效目录自动探查与剔除
      if (!isExistingDirectory(resolved)) {
        configMigrated = true;
        continue;
      }
      cleanedHistory.push(resolved);
    }

    const mergedHistory = deduplicateWorkspaceDirs([
      activeDir,
      ...cleanedHistory,
      SAMPLES_DIR,
      PROJECT_ROOT_DIR,
    ], true);

    if (rawHistory.length !== mergedHistory.length) {
      configMigrated = true;
    }

    const resultConfig: DwgViewerUserConfig = {
      activeWorkspaceDir: activeDir,
      workspaceHistory: mergedHistory,
      updatedAt: Number(parsed.updatedAt) || Date.now(),
    };

    // 若发生路径自愈纠偏、失效清理或重复去重，立即回写 ~/.dwgViewer/config.json 固化记忆，确保便携版重启或刷新稳定对齐
    if (configMigrated || !isSameDirectoryPath(parsed.activeWorkspaceDir, activeDir)) {
      writeUserLightweightConfig(resultConfig);
    }

    return resultConfig;
  } catch {
    return fallback;
  }
}

/**
 * 将轻量配置写入 `~/.dwgViewer/config.json`。
 * 强制校验序列化后字节数 < 64KB，严禁存入任何图纸或缓存二进制数据。
 * [02_dwg_parser] 历史工作区目录失效自愈清理与去重加固：在落盘前过滤旧实例历史样例目录及失效幽灵目录，防止脏数据污染。
 */
function writeUserLightweightConfig(config: DwgViewerUserConfig): void {
  try {
    if (!fs.existsSync(USER_CONFIG_DIR)) {
      fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
    }

    // 纠偏 activeWorkspaceDir：若为旧样例目录或已失效，则对齐当前 SAMPLES_DIR
    const targetActive =
      config.activeWorkspaceDir &&
      isExistingDirectory(config.activeWorkspaceDir) &&
      (!isSamplesDirectoryPath(config.activeWorkspaceDir) ||
        isSameDirectoryPath(config.activeWorkspaceDir, SAMPLES_DIR))
        ? path.resolve(config.activeWorkspaceDir)
        : SAMPLES_DIR;

    const filteredHistory = (config.workspaceHistory || []).filter(
      (dir) =>
        isExistingDirectory(dir) &&
        (!isSamplesDirectoryPath(dir) || isSameDirectoryPath(dir, SAMPLES_DIR))
    );

    const cleanPayload: DwgViewerUserConfig = {
      activeWorkspaceDir: targetActive,
      workspaceHistory: deduplicateWorkspaceDirs([
        targetActive,
        ...filteredHistory,
        SAMPLES_DIR,
      ], true),
      updatedAt: Date.now(),
    };
    const jsonText = JSON.stringify(cleanPayload, null, 2);
    const byteLen = Buffer.byteLength(jsonText, 'utf-8');
    if (byteLen > MAX_USER_CONFIG_BYTES) {
      throw new Error(`Config payload (${byteLen} bytes) exceeds 64KB safety limit`);
    }
    fs.writeFileSync(USER_CONFIG_FILE, jsonText, 'utf-8');
  } catch (err) {
    console.warn('[UserConfig] Failed to persist ~/.dwgViewer/config.json:', err);
  }
}

/**
 * 扫描指定工作区目录下的所有 `.dwg` / `.dwg.gz` / `.cache.gz` 文件。
 */
function scanWorkspaceDwgFiles(targetDir: string): SampleFileItem[] {
  const resolvedDir = path.resolve(targetDir);
  if (!fs.existsSync(resolvedDir)) {
    return [];
  }
  const stat = fs.statSync(resolvedDir);
  if (!stat.isDirectory()) {
    return [];
  }

  const isDefaultSamples = isSameDirectoryPath(resolvedDir, SAMPLES_DIR);
  const fileNames = fs.readdirSync(resolvedDir);
  const samples: SampleFileItem[] = [];

  for (const fileName of fileNames) {
    const lower = fileName.toLowerCase();
    if (!lower.endsWith('.dwg') && !lower.endsWith('.dwg.gz') && !lower.endsWith('.cache.gz')) {
      continue;
    }

    const fullPath = path.join(resolvedDir, fileName);
    try {
      const fStat = fs.statSync(fullPath);
      if (fStat.isFile()) {
        const fileUrl = isDefaultSamples
          ? `/samples/${fileName}`
          : `/api/workspace/file?name=${encodeURIComponent(fileName)}&dir=${encodeURIComponent(
              resolvedDir
            )}`;
        samples.push({
          name: fileName,
          url: fileUrl,
          size: fStat.size,
          sizeLabel: formatFileSizeLabel(fStat.size),
          workspaceDir: resolvedDir,
        });
      }
    } catch {
      // Skip inaccessible file
    }
  }

  samples.sort((a, b) => a.size - b.size);
  return samples;
}

/**
 * 解析前端传入的工作区路径参数（支持 'default' / 'public/samples' 别名）。
 * [02_dwg_parser] 若前端携带旧实例的历史样例路径，自动纠偏映射为当前实例的 fallbackDir (SAMPLES_DIR)。
 */
function resolveRequestedWorkspaceDir(rawDir: string | undefined, fallbackDir: string): string {
  const trimmed = String(rawDir || '').trim();
  if (!trimmed || trimmed === 'default' || trimmed.replace(/\\/g, '/') === 'public/samples') {
    return fallbackDir;
  }
  const resolved = path.resolve(trimmed);
  if (isSamplesDirectoryPath(resolved) && !isSameDirectoryPath(resolved, fallbackDir)) {
    return fallbackDir;
  }
  return resolved;
}

/**
 * 获取当前主机的首选局域网 IPv4 地址（排除内部回环地址 127.0.0.1，优先匹配 192.168.x.x / 10.x.x.x / 172.16~31.x.x 常见私网段）。
 * [02_dwg_parser] 局域网真实IP探测接口
 */
function getPrimaryLanIpv4(): string {
  const interfaces = os.networkInterfaces();
  const candidates: string[] = [];

  for (const name of Object.keys(interfaces)) {
    const netList = interfaces[name];
    if (!netList) continue;
    for (const net of netList) {
      const isIpv4 = net.family === 'IPv4' || (net as any).family === 4;
      if (!isIpv4 || net.internal) {
        continue;
      }
      candidates.push(net.address);
    }
  }

  // 1. 优先匹配最常见的企业与家庭局域网段 192.168.x.x
  const match192 = candidates.find((ip) => ip.startsWith('192.168.'));
  if (match192) return match192;

  // 2. 匹配企业 10.x.x.x 网段
  const match10 = candidates.find((ip) => ip.startsWith('10.'));
  if (match10) return match10;

  // 3. 匹配 172.16.x.x ~ 172.31.x.x 私网段
  const match172 = candidates.find((ip) => {
    const parts = ip.split('.');
    if (parts.length === 4 && parts[0] === '172') {
      const second = Number(parts[1]);
      return second >= 16 && second <= 31;
    }
    return false;
  });
  if (match172) return match172;

  // 4. 若无标准私网匹配，取第一个有效外部 IPv4
  if (candidates.length > 0) {
    return candidates[0];
  }

  // 5. 离线或无可用物理网卡时平滑回退
  return '127.0.0.1';
}

export async function startServer(customPort?: number): Promise<{ app: express.Express; port: number }> {
  ensureCacheDir();
  const app = express();
  const listenPort = customPort ?? PORT;

  // 0. 全局跨域 (CORS) 与 OPTIONS 预检放行中间件
  // [02_dwg_parser] 解决便携版/跨域及自定义请求头导致的 Failed to fetch 异常
  app.use((req, res, next) => {
    const host = req.headers.host;
    if ((host !== `localhost:${listenPort}` && host !== `127.0.0.1:${listenPort}`) ||
        (req.headers.origin && req.headers.origin !== `http://${host}`)) {
      res.sendStatus(403);
      return;
    }
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH'
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range, ' +
      'x-minio-endpoint, x-minio-access-key, x-minio-secret-key, x-minio-bucket, x-minio-ssl, x-dwg-cache-meta'
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Content-Disposition, ETag, x-dwg-cache-hit, x-dwg-device-profile'
    );

    // 对所有 OPTIONS 预检请求直接响应 204 No Content，彻底杜绝预检失败
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // 0.0b [02_dwg_parser] 局域网真实IP探测接口 (供前端一键分享真实内网链接)
  app.get('/api/network-info', (_req, res) => {
    try {
      const ip = '127.0.0.1';
      const port = listenPort;
      const lanUrl = `http://${ip}:${port}`;
      res.json({
        success: true,
        ip,
        port,
        lanUrl,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || '获取局域网网络信息失败' });
    }
  });

  // 0.1 Static sample drawings middleware
  if (fs.existsSync(SAMPLES_DIR)) {
    app.use('/samples', express.static(SAMPLES_DIR));
  }

  // 0.2 Scan and list DWG drawings in active or requested workspace directory (compatible with /api/samples & /api/workspace)
  const handleGetWorkspaceAndSamples = (req: express.Request, res: express.Response) => {
    try {
      const userConfig = readUserLightweightConfig();
      const queryDir = typeof req.query.dir === 'string' ? req.query.dir.trim() : '';
      let targetDir = queryDir
        ? resolveRequestedWorkspaceDir(queryDir, SAMPLES_DIR)
        : userConfig.activeWorkspaceDir;

      let warning: string | undefined;

      // [02_dwg_parser] 健壮性检查：若目录不存在，尝试自动创建；若无法创建或不可读，平滑 fallback 至默认可用目录
      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        try {
          fs.mkdirSync(targetDir, { recursive: true });
        } catch {
          targetDir = SAMPLES_DIR;
          warning = `指定的工作区目录不可访问，已自动回退至默认工作区: ${targetDir}`;
        }
      }

      const isDefault = isSameDirectoryPath(targetDir, SAMPLES_DIR);
      const samples = scanWorkspaceDwgFiles(targetDir);

      if (samples.length === 0 && !warning) {
        warning = '当前工作区暂无 DWG 图纸，可点击上方「打开图纸」或「切换目录」添加本地图纸';
      }

      res.json({
        activeDir: targetDir,
        defaultDir: SAMPLES_DIR,
        isDefaultDir: isDefault,
        historyDirs: userConfig.workspaceHistory,
        configFilePath: USER_CONFIG_FILE,
        samples,
        ...(warning ? { warning } : {}),
      });
    } catch (err: any) {
      console.error('[DWG Workspace API] Failed to scan workspace directory:', err);
      res.status(500).json({ error: '扫描工作区图纸目录失败' });
    }
  };

  app.get('/api/samples', handleGetWorkspaceAndSamples);
  app.get('/api/workspace', handleGetWorkspaceAndSamples);

  // 0.1b Update active workspace directory and persist to ~/.dwgViewer/config.json
  app.post('/api/workspace', express.json({ limit: '64kb' }), (req, res) => {
    try {
      const rawDir = String(req.body?.dir || '').trim();
      const targetDir = resolveRequestedWorkspaceDir(rawDir, SAMPLES_DIR);

      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        res.status(400).json({
          error: `目录不存在或不是有效的文件夹: ${targetDir}`,
        });
        return;
      }

      const currentConfig = readUserLightweightConfig();
      const updatedConfig: DwgViewerUserConfig = {
        activeWorkspaceDir: targetDir,
        workspaceHistory: deduplicateWorkspaceDirs([
          targetDir,
          ...currentConfig.workspaceHistory,
          SAMPLES_DIR,
        ], true),
        updatedAt: Date.now(),
      };
      writeUserLightweightConfig(updatedConfig);

      const samples = scanWorkspaceDwgFiles(targetDir);
      res.json({
        activeDir: targetDir,
        defaultDir: SAMPLES_DIR,
        isDefaultDir: isSameDirectoryPath(targetDir, SAMPLES_DIR),
        historyDirs: updatedConfig.workspaceHistory,
        configFilePath: USER_CONFIG_FILE,
        samples,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || '切换工作区目录失败' });
    }
  });

  // 0.1c Remove an entry from workspace history in ~/.dwgViewer/config.json
  app.delete('/api/workspace/history', express.json({ limit: '64kb' }), (req, res) => {
    try {
      const dirToRemove = String(req.query.dir || req.body?.dir || '').trim();
      const currentConfig = readUserLightweightConfig();
      const filteredHistory = currentConfig.workspaceHistory.filter(
        (d) => !isSameDirectoryPath(d, dirToRemove) || isSameDirectoryPath(d, SAMPLES_DIR)
      );
      const nextActive = isSameDirectoryPath(currentConfig.activeWorkspaceDir, dirToRemove)
        ? SAMPLES_DIR
        : currentConfig.activeWorkspaceDir;

      const updatedConfig: DwgViewerUserConfig = {
        activeWorkspaceDir: nextActive,
        workspaceHistory: deduplicateWorkspaceDirs([nextActive, ...filteredHistory, SAMPLES_DIR], true),
        updatedAt: Date.now(),
      };
      writeUserLightweightConfig(updatedConfig);

      const samples = scanWorkspaceDwgFiles(nextActive);
      res.json({
        activeDir: nextActive,
        defaultDir: SAMPLES_DIR,
        isDefaultDir: isSameDirectoryPath(nextActive, SAMPLES_DIR),
        historyDirs: updatedConfig.workspaceHistory,
        configFilePath: USER_CONFIG_FILE,
        samples,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || '删除工作区历史记录失败' });
    }
  });

  // 0.1d Stream a DWG or .gz file from a custom workspace directory
  app.get('/api/workspace/file', (req, res) => {
    try {
      const rawName = String(req.query.name || '').trim();
      const safeFileName = path.basename(rawName);
      if (!safeFileName) {
        res.status(400).json({ error: '缺少有效的文件名参数 name' });
        return;
      }

      const lower = safeFileName.toLowerCase();
      if (!lower.endsWith('.dwg') && !lower.endsWith('.dwg.gz') && !lower.endsWith('.cache.gz')) {
        res.status(400).json({ error: '仅允许读取 .dwg 或 .dwg.cache.gz 格式文件' });
        return;
      }

      const userConfig = readUserLightweightConfig();
      const rawDir = typeof req.query.dir === 'string' ? req.query.dir.trim() : '';
      const targetDir = rawDir
        ? resolveRequestedWorkspaceDir(rawDir, userConfig.activeWorkspaceDir)
        : userConfig.activeWorkspaceDir;

      const fullFilePath = path.join(targetDir, safeFileName);
      if (!fs.existsSync(fullFilePath) || !fs.statSync(fullFilePath).isFile()) {
        res.status(404).json({ error: `在工作区 [${targetDir}] 中未找到文件: ${safeFileName}` });
        return;
      }

      const stat = fs.statSync(fullFilePath);
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader(
        'Content-Type',
        lower.endsWith('.gz') ? 'application/gzip' : 'application/acad'
      );
      res.setHeader(
        'Content-Disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(safeFileName)}`
      );
      res.setHeader('Cache-Control', 'no-cache');
      fs.createReadStream(fullFilePath).pipe(res);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || '读取工作区图纸文件失败' });
    }
  });

  // 0.1e [02_dwg_parser] 本地图纸持久化保存至工作区接口
  /**
   * 将本地上传的 DWG 或 .dwg.cache.gz 二进制流持久化写入当前或指定的工作区目录
   * 严守 safeFileName 与目标工作区目录防路径穿越校验，限制 150MB 单文件上限
   */
  app.post(
    '/api/workspace/upload',
    express.raw({ type: '*/*', limit: '150mb' }),
    (req, res) => {
      try {
        const rawName = String(req.query.name || '').trim();
        const safeFileName = path.basename(rawName);
        if (!safeFileName) {
          res.status(400).json({ error: '缺少有效的文件名参数 name' });
          return;
        }

        const lower = safeFileName.toLowerCase();
        if (!lower.endsWith('.dwg') && !lower.endsWith('.dwg.gz') && !lower.endsWith('.cache.gz')) {
          res.status(400).json({ error: '仅允许上传 .dwg 或 .dwg.cache.gz 格式文件' });
          return;
        }

        const buffer = req.body;
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
          res.status(400).json({ error: '上传文件内容为空' });
          return;
        }

        const userConfig = readUserLightweightConfig();
        const rawDir = typeof req.query.dir === 'string' ? req.query.dir.trim() : '';
        const targetDir = rawDir
          ? resolveRequestedWorkspaceDir(rawDir, userConfig.activeWorkspaceDir)
          : userConfig.activeWorkspaceDir;

        if (path.resolve(targetDir) !== path.resolve(userConfig.activeWorkspaceDir)) {
          res.status(409).json({error: '工作区已切换，请刷新后重试'});
          return;
        }
        // 确保工作区目标目录存在
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        } else if (!fs.statSync(targetDir).isDirectory()) {
          res.status(400).json({ error: `目标工作区路径并非目录: ${targetDir}` });
          return;
        }

        const targetFilePath = path.join(targetDir, safeFileName);
        // 执行原子写入落盘
        try {
          fs.writeFileSync(targetFilePath, buffer, { flag: 'wx' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          res.status(409).json({error: '工作区已有同名图纸，请重命名后再保存'});
          return;
        }

        res.json({
          success: true,
          fileName: safeFileName,
          workspaceDir: targetDir,
          bytes: buffer.length,
        });
      } catch (err: any) {
        res.status(500).json({ error: err?.message || '保存文件至工作区失败' });
      }
    }
  );

  // 0.2 MinIO S3 Status & Bucket DWG File Listing API (AWS Signature V4)
  app.get('/api/minio/status', (req, res) => {
    const startTime = Date.now();
    try {
      const config = resolveMinioConfigFromRequest(req);
      let rawPrefix = typeof req.query.prefix === 'string' ? req.query.prefix.trim() : 'dwg/';
      const targetBucket = config.bucket;

      if (!hasMinioConnection(config, targetBucket)) {
        res.json({ configured: false, connected: false, files: [] });
        return;
      }

      // Strip the bucket name when the caller passes a bucket-prefixed path.
      if (rawPrefix.startsWith(`${targetBucket}/`)) {
        rawPrefix = rawPrefix.slice(targetBucket.length + 1);
      }

      const canonicalUri = buildCanonicalUri(`/${targetBucket}`);
      const queryParams: Record<string, string> = {
        'list-type': '2',
      };
      if (rawPrefix) {
        queryParams.prefix = rawPrefix;
      }

      const signed = signS3RequestV4('GET', canonicalUri, queryParams, config);
      const client = signed.url.protocol === 'https:' ? https : http;

      const s3Req = client.request(
        signed.url,
        {
          method: 'GET',
          headers: signed.headers,
          timeout: 8000,
        },
        (s3Res) => {
          const chunks: Buffer[] = [];
          s3Res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          s3Res.on('end', () => {
            const latencyMs = Date.now() - startTime;
            const xmlBody = Buffer.concat(chunks).toString('utf8');

            if ((s3Res.statusCode || 500) >= 400) {
              const codeMatch = xmlBody.match(/<Code>([\s\S]*?)<\/Code>/);
              const msgMatch = xmlBody.match(/<Message>([\s\S]*?)<\/Message>/);
              res.status(s3Res.statusCode || 502).json({
                connected: false,
                latencyMs,
                endpoint: config.endpoint,
                bucket: targetBucket,
                prefix: rawPrefix,
                error:
                  (codeMatch && msgMatch
                    ? `${codeMatch[1]}: ${msgMatch[1]}`
                    : `MinIO S3 响应异常 (HTTP ${s3Res.statusCode})`),
                files: [],
              });
              return;
            }

            const files = parseS3ListXml(xmlBody, targetBucket);
            res.json({
              connected: true,
              latencyMs,
              endpoint: config.endpoint,
              bucket: targetBucket,
              prefix: rawPrefix,
              accessKeyPreview:
                config.accessKey.length > 8
                  ? `${config.accessKey.slice(0, 4)}****${config.accessKey.slice(-4)}`
                  : config.accessKey,
              files,
            });
          });
        }
      );

      s3Req.on('timeout', () => {
        s3Req.destroy(new Error('连接 MinIO S3 超时 (8s)'));
      });

      s3Req.on('error', (err) => {
        res.status(502).json({
          connected: false,
          latencyMs: Date.now() - startTime,
          endpoint: config.endpoint,
          bucket: targetBucket,
          prefix: rawPrefix,
          error: `无法连接 MinIO S3 (${config.endpoint}): ${err.message}`,
          files: [],
        });
      });

      s3Req.end();
    } catch (err: any) {
      res.status(500).json({
        connected: false,
        latencyMs: Date.now() - startTime,
        error: err?.message || 'MinIO 状态探测异常',
        files: [],
      });
    }
  });

  // 0.3 MinIO S3 Direct Streaming Download API (AWS Signature V4)
  app.get('/api/minio/stream', (req, res) => {
    try {
      const rawPath = String(req.query.path || '').trim();
      if (!rawPath) {
        res.status(400).json({ error: '缺少必填查询参数 path' });
        return;
      }

      const config = resolveMinioConfigFromRequest(req);
      const { bucket, objectKey } = parseMinioBucketAndKey(rawPath, config.bucket);
      if (!hasMinioConnection(config, bucket)) {
        res.status(400).json({ error: '请配置 MinIO 连接' });
        return;
      }
      if (!objectKey) {
        res.status(400).json({ error: `无效的 MinIO 对象路径: ${rawPath}` });
        return;
      }

      const canonicalUri = buildCanonicalUri(`/${bucket}/${objectKey}`);
      const signed = signS3RequestV4('GET', canonicalUri, {}, config);
      const client = signed.url.protocol === 'https:' ? https : http;

      // Forward Range header if present for partial stream inspection
      const requestHeaders: Record<string, string> = { ...signed.headers };
      if (typeof req.headers.range === 'string') {
        requestHeaders.Range = req.headers.range;
      }

      const s3Req = client.request(
        signed.url,
        {
          method: 'GET',
          headers: requestHeaders,
          timeout: 30000,
        },
        (s3Res) => {
          const statusCode = s3Res.statusCode || 500;
          if (statusCode >= 400) {
            const errChunks: Buffer[] = [];
            s3Res.on('data', (c) => errChunks.push(Buffer.from(c)));
            s3Res.on('end', () => {
              const xml = Buffer.concat(errChunks).toString('utf8');
              const codeMatch = xml.match(/<Code>([\s\S]*?)<\/Code>/);
              const msgMatch = xml.match(/<Message>([\s\S]*?)<\/Message>/);
              const detail =
                codeMatch && msgMatch
                  ? `${codeMatch[1]} (${msgMatch[1]})`
                  : `HTTP ${statusCode}`;
              res
                .status(statusCode)
                .json({ error: `MinIO S3 读取失败 [${bucket}/${objectKey}]: ${detail}` });
            });
            return;
          }

          res.status(statusCode);
          if (s3Res.headers['content-length']) {
            res.setHeader('Content-Length', s3Res.headers['content-length']);
          }
          if (s3Res.headers['content-range']) {
            res.setHeader('Content-Range', s3Res.headers['content-range']);
          }
          if (s3Res.headers['etag']) {
            res.setHeader('ETag', s3Res.headers['etag']);
          }
          const fileName = objectKey.split('/').pop() || 'drawing.dwg';
          res.setHeader('Content-Type', 'application/acad');
          res.setHeader(
            'Content-Disposition',
            `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`
          );
          res.setHeader('Cache-Control', 'no-cache');

          s3Res.pipe(res);
        }
      );

      s3Req.on('timeout', () => {
        s3Req.destroy(new Error('MinIO S3 流式传输超时'));
      });

      s3Req.on('error', (err) => {
        if (!res.headersSent) {
          res.status(502).json({
            error: `MinIO S3 流式连接失败 (${config.endpoint}): ${err.message}`,
          });
        } else {
          res.destroy();
        }
      });

      req.on('close', () => {
        if (!res.writableEnded) {
          s3Req.destroy();
        }
      });

      s3Req.end();
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({ error: err?.message || 'MinIO S3 流式读取异常' });
      }
    }
  });

  // 1. List all shared Gzip cache entries stored on the local server disk
  app.get('/api/dwg-cache', (_req, res) => {
    const index = readServerCacheIndex();
    const validEntries: ServerGzipCacheMeta[] = [];
    let dirty = false;

    for (const [fp, meta] of Object.entries(index)) {
      const filePath = getGzFilePath(fp);
      if (fs.existsSync(filePath)) {
        validEntries.push(meta);
      } else {
        delete index[fp];
        dirty = true;
      }
    }

    if (dirty) {
      writeServerCacheIndex(index);
    }

    validEntries.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({
      shared: true,
      cacheDir: '.cache/dwg-gzip',
      entries: validEntries,
    });
  });

  // 2. Download a specific .dwg.cache.gz binary stream by fingerprint (shared across all LAN devices)
  app.get('/api/dwg-cache/:fingerprint', (req, res) => {
    const fp = sanitizeFingerprint(req.params.fingerprint);
    const index = readServerCacheIndex();
    const meta = index[fp];
    const filePath = getGzFilePath(fp);

    if (!fs.existsSync(filePath)) {
      res.status(204).end();
      return;
    }

    if (meta) {
      meta.updatedAt = Date.now();
      index[fp] = meta;
      writeServerCacheIndex(index);
      res.setHeader('X-Dwg-Cache-Meta', encodeURIComponent(JSON.stringify(meta)));
    }

    const stat = fs.statSync(filePath);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(filePath).pipe(res);
  });

  // 3. Upload / persist a .dwg.cache.gz binary to the server disk so all devices can share it
  app.post(
    '/api/dwg-cache/:fingerprint',
    express.raw({
      type: ['application/gzip', 'application/octet-stream', '*/*'],
      limit: '150mb',
    }),
    (req, res) => {
      try {
        const fp = sanitizeFingerprint(req.params.fingerprint);
        const body = req.body as Buffer;
        if (!body || !Buffer.isBuffer(body) || body.byteLength < 16) {
          res.status(400).json({ error: 'Invalid or empty Gzip payload' });
          return;
        }

        ensureCacheDir();
        const filePath = getGzFilePath(fp);
        fs.writeFileSync(filePath, body);

        const now = Date.now();
        let clientMeta: Partial<ServerGzipCacheMeta> = {};
        const rawMetaHeader = req.headers['x-dwg-cache-meta'];
        if (typeof rawMetaHeader === 'string' && rawMetaHeader) {
          try {
            clientMeta = JSON.parse(decodeURIComponent(rawMetaHeader));
          } catch {
            // fallback
          }
        }

        const meta: ServerGzipCacheMeta = {
          fingerprint: fp,
          fileName: clientMeta.fileName || `${fp}.dwg`,
          originalByteLength: Number(clientMeta.originalByteLength) || body.byteLength,
          rawJsonBytes: Number(clientMeta.rawJsonBytes) || body.byteLength * 5,
          compressedBytes: body.byteLength,
          compressionRatio: Number(clientMeta.compressionRatio) || 0,
          versionLabel: clientMeta.versionLabel || 'AutoCAD DWG',
          entityCount: Number(clientMeta.entityCount) || 0,
          layerCount: Number(clientMeta.layerCount) || 0,
          wasmParseMs: Number(clientMeta.wasmParseMs) || 0,
          createdAt: Number(clientMeta.createdAt) || now,
          updatedAt: now,
        };

        const index = readServerCacheIndex();
        index[fp] = meta;

        // Enforce LRU limit on server disk
        const allItems = Object.values(index).sort((a, b) => b.updatedAt - a.updatedAt);
        if (allItems.length > MAX_SERVER_CACHE_ENTRIES) {
          const toRemove = allItems.slice(MAX_SERVER_CACHE_ENTRIES);
          for (const oldItem of toRemove) {
            delete index[oldItem.fingerprint];
            const oldPath = getGzFilePath(oldItem.fingerprint);
            if (fs.existsSync(oldPath)) {
              try {
                fs.unlinkSync(oldPath);
              } catch {
                // ignore
              }
            }
          }
        }

        writeServerCacheIndex(index);
        res.json({ ok: true, meta });
      } catch (err: any) {
        res.status(500).json({ error: err?.message || 'Failed to write server cache' });
      }
    }
  );

  // 4. Delete a single shared Gzip cache entry
  app.delete('/api/dwg-cache/:fingerprint', (req, res) => {
    const fp = sanitizeFingerprint(req.params.fingerprint);
    const index = readServerCacheIndex();
    delete index[fp];
    writeServerCacheIndex(index);

    const filePath = getGzFilePath(fp);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
    res.json({ ok: true });
  });

  // 5. Clear all shared Gzip cache entries on server disk
  app.delete('/api/dwg-cache', (_req, res) => {
    ensureCacheDir();
    try {
      const files = fs.readdirSync(CACHE_DIR);
      for (const f of files) {
        if (f.endsWith('.gz') || f === 'index.json') {
          try {
            fs.unlinkSync(path.join(CACHE_DIR, f));
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
    res.json({ ok: true });
  });

  // 6. 多级子路径静态资源智能重定向/映射中间件（防深层图纸路由 SPA 白屏）
  // [02_dwg_parser] 拦截 /minio/.../assets/ 或 /builtin/.../assets/ 等深层静态资源请求，杜绝落入 app.get('*') 返回 HTML
  const distCandidates = [
    path.join(__dirname, 'dist'),
    path.resolve(__dirname, '..', 'dist'),
    path.join(process.cwd(), 'dist'),
  ];
  const distPath = distCandidates.find((p) => fs.existsSync(p)) || path.join(__dirname, 'dist');

  const publicCandidates = [
    path.join(__dirname, 'public'),
    path.resolve(__dirname, '..', 'public'),
    path.join(process.cwd(), 'public'),
  ];
  const publicPath =
    publicCandidates.find((p) => fs.existsSync(p)) || path.join(__dirname, 'public');

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use((req, res, next) => {
      // 忽略所有 API 接口与示例图纸接口
      if (req.path.startsWith('/api/') || req.path.startsWith('/samples/')) {
        next();
        return;
      }

      const staticMarkers = [
        '/assets/',
        '/workers/',
        '/wasm/',
        '/fonts/',
        '/icons/',
        '/templates/',
      ];
      let staticSubPath: string | null = null;
      for (const marker of staticMarkers) {
        const idx = req.path.indexOf(marker);
        if (idx !== -1) {
          // 截取自静态标记起的文件相对路径，如 "assets/index-D7Uq0.js"
          staticSubPath = req.path.slice(idx + 1);
          break;
        }
      }

      if (!staticSubPath) {
        const basename = path.basename(req.path);
        const lower = basename.toLowerCase();
        if (
          lower === 'favicon.ico' ||
          lower.startsWith('logo.') ||
          lower.endsWith('.js') ||
          lower.endsWith('.mjs') ||
          lower.endsWith('.css') ||
          lower.endsWith('.wasm') ||
          lower.endsWith('.map') ||
          lower.endsWith('.png') ||
          lower.endsWith('.jpg') ||
          lower.endsWith('.jpeg') ||
          lower.endsWith('.svg') ||
          lower.endsWith('.woff') ||
          lower.endsWith('.woff2') ||
          lower.endsWith('.ttf')
        ) {
          staticSubPath = basename;
        }
      }

      if (staticSubPath) {
        const targetInDist = path.join(distPath, staticSubPath);
        if (fs.existsSync(targetInDist) && fs.statSync(targetInDist).isFile()) {
          res.sendFile(targetInDist);
          return;
        }
        const targetInPublic = path.join(publicPath, staticSubPath);
        if (fs.existsSync(targetInPublic) && fs.statSync(targetInPublic).isFile()) {
          res.sendFile(targetInPublic);
          return;
        }

        // 静态资源文件未找到，直接返回 404，严禁落入 SPA 单页路由返回 index.html
        res.status(404).type('text/plain').send('Static asset not found');
        return;
      }

      next();
    });

    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      const indexPath = path.join(distPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('DWG Viewer: index.html not found, please run npm run build first.');
      }
    });
  }

  return new Promise((resolve, reject) => {
    app.listen(listenPort, '127.0.0.1', () => {
      console.log(
        `[DWG Viewer Server] Running on http://127.0.0.1:${listenPort} (Shared Gzip Cache: ${CACHE_DIR}, User Config: ${USER_CONFIG_FILE})`
      );
      resolve({ app, port: listenPort });
    }).once('error', reject);
  });
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === __filename.toLowerCase();

if (isDirectExecution) {
  void startServer();
}
