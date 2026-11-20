import {
  DWG_CACHE_SCHEMA_VERSION,
  DwgCacheEnvelope,
  DwgParseResultPayload,
  compressEnvelopeToGzip,
  decompressGzipToEnvelope,
  normalizeDwgFileNameForConverter,
  summarizeDwgModel,
} from './dwgGzipCache';
import { DeviceMemoryProfile, getDeviceMemoryProfile } from './deviceProfile';

const DB_NAME = 'cadlight_dwg_gzip_cache_v3';
const DB_VERSION = 1;
const STORE_NAME = 'gzip_entries';
const MAX_CACHE_ENTRIES = 15;
const SERVER_CACHE_API = '/api/dwg-cache';

export type GzipCacheStorageScope = 'both' | 'local-only' | 'server-shared';

export interface LocalGzipCacheMeta {
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
  /** Indicates whether this Gzip cache is stored in browser IndexedDB, server disk, or both */
  storageScope?: GzipCacheStorageScope;
}

export interface LocalGzipCacheRecord extends LocalGzipCacheMeta {
  gzBytes: Uint8Array;
}

export interface DecompressedCacheHit {
  meta: LocalGzipCacheMeta;
  payload: DwgParseResultPayload;
  decompressMs: number;
  gzBytes: Uint8Array;
  hitLayer: 'local-idb' | 'server-shared';
}

export function isMobileOrRestricted(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

const memoryStore = new Map<string, LocalGzipCacheRecord>();

function openGzipCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'fingerprint' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Uploads a Gzip cache record to the local server's L2 disk cache (/api/dwg-cache/:fingerprint)
 * so other devices/browsers on the same LAN or server instance can share it without re-running WASM.
 */
async function syncRecordToServerCache(record: LocalGzipCacheRecord): Promise<boolean> {
  if (typeof fetch === 'undefined') return false;
  try {
    const { gzBytes, ...meta } = record;
    const copy = new Uint8Array(gzBytes.byteLength);
    copy.set(gzBytes);
    const res = await fetch(`${SERVER_CACHE_API}/${encodeURIComponent(record.fingerprint)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        'X-Dwg-Cache-Meta': encodeURIComponent(JSON.stringify(meta)),
      },
      body: copy,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fetches a shared Gzip cache record from the local server's L2 disk cache (/api/dwg-cache/:fingerprint).
 */
async function fetchRecordFromServerCache(
  fingerprint: string
): Promise<LocalGzipCacheRecord | null> {
  if (typeof fetch === 'undefined') return null;
  try {
    const res = await fetch(`${SERVER_CACHE_API}/${encodeURIComponent(fingerprint)}`, {
      method: 'GET',
      headers: { Accept: 'application/gzip' },
    });
    if (!res.ok || res.status === 204) return null;

    const buffer = await res.arrayBuffer();
    if (!buffer || buffer.byteLength < 16) return null;
    const gzBytes = new Uint8Array(buffer);

    let serverMeta: Partial<LocalGzipCacheMeta> = {};
    const metaHeader = res.headers.get('X-Dwg-Cache-Meta');
    if (metaHeader) {
      try {
        serverMeta = JSON.parse(decodeURIComponent(metaHeader));
      } catch {
        // ignore
      }
    }

    const now = Date.now();
    return {
      fingerprint: serverMeta.fingerprint || fingerprint,
      fileName: serverMeta.fileName || `${fingerprint}.dwg`,
      originalByteLength: Number(serverMeta.originalByteLength) || gzBytes.byteLength,
      rawJsonBytes: Number(serverMeta.rawJsonBytes) || gzBytes.byteLength * 5,
      compressedBytes: gzBytes.byteLength,
      compressionRatio: Number(serverMeta.compressionRatio) || 0,
      versionLabel: serverMeta.versionLabel || 'AutoCAD DWG',
      entityCount: Number(serverMeta.entityCount) || 0,
      layerCount: Number(serverMeta.layerCount) || 0,
      wasmParseMs: Number(serverMeta.wasmParseMs) || 0,
      createdAt: Number(serverMeta.createdAt) || now,
      updatedAt: now,
      storageScope: 'both',
      gzBytes,
    };
  } catch {
    return null;
  }
}

async function persistRecordToIdb(record: LocalGzipCacheRecord): Promise<void> {
  const isRestricted = isMobileOrRestricted();
  const gzLen = record.gzBytes?.byteLength ?? 0;

  // 🛡️ iOS / Mobile Jetsam Protection:
  // 1. Never store binary gzBytes in JS heap memoryStore on mobile devices.
  // 2. For heavy drawings (>10MB compressed Gzip) on mobile, skip local IndexedDB persistence
  //    to prevent WebKit's Structured Clone cross-process IPC from duplicating 40MB+ buffers
  //    (large drawings stream directly from the L2 server shared cache).
  if (!isRestricted && gzLen <= 10 * 1024 * 1024) {
    memoryStore.set(record.fingerprint, record);
  }
  if (isRestricted && gzLen > 10 * 1024 * 1024) {
    return;
  }

  const db = await openGzipCacheDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
    await enforceLruLimit(db);
  }
}

/**
 * Saves a parsed DWG intermediate result as a Gzip-compressed binary record (.dwg.cache.gz)
 * into L1 (memory + IndexedDB) AND syncs it to L2 (Server Shared Disk Cache `/api/dwg-cache`)
 * so multiple devices connected to the local service can share the Gzip cache immediately.
 */
export async function saveDwgGzipCache(params: {
  fingerprint: string;
  fileName: string;
  originalByteLength: number;
  versionLabel?: string;
  wasmParseMs?: number;
  payload: DwgParseResultPayload;
}): Promise<LocalGzipCacheRecord> {
  const now = Date.now();
  const stats = summarizeDwgModel(params.payload.model);

  const envelope: DwgCacheEnvelope = {
    __dwgCacheSchema: DWG_CACHE_SCHEMA_VERSION,
    fileName: params.fileName,
    fingerprint: params.fingerprint,
    originalByteLength: params.originalByteLength,
    versionLabel: params.versionLabel || 'AutoCAD DWG',
    createdAt: now,
    wasmParseMs: params.wasmParseMs ?? 0,
    entityCount: stats.entityCount,
    layerCount: stats.layerCount,
    payload: params.payload,
  };

  const compressed = await compressEnvelopeToGzip(envelope);

  const record: LocalGzipCacheRecord = {
    fingerprint: params.fingerprint,
    fileName: params.fileName,
    originalByteLength: params.originalByteLength,
    rawJsonBytes: compressed.rawJsonBytes,
    compressedBytes: compressed.compressedBytes,
    compressionRatio: compressed.compressionRatio,
    versionLabel: params.versionLabel || 'AutoCAD DWG',
    entityCount: stats.entityCount,
    layerCount: stats.layerCount,
    wasmParseMs: params.wasmParseMs ?? 0,
    createdAt: now,
    updatedAt: now,
    storageScope: 'both',
    gzBytes: compressed.gzBytes,
  };

  await persistRecordToIdb(record);
  const synced = await syncRecordToServerCache(record);
  record.storageScope = synced ? 'both' : 'local-only';

  return record;
}

/**
 * Stores an already-compressed .dwg.cache.gz buffer and its decoded envelope into L1 + L2 stores.
 */
export async function saveImportedGzipCache(
  gzBytes: Uint8Array,
  envelope: DwgCacheEnvelope & { __rawJsonBytes?: number },
  rawJsonBytesEstimate?: number
): Promise<LocalGzipCacheRecord> {
  const now = Date.now();
  const stats = summarizeDwgModel(envelope.payload?.model);
  const compressedBytes = gzBytes.byteLength;
  const rawJsonBytes =
    envelope.__rawJsonBytes ||
    rawJsonBytesEstimate ||
    Math.max(compressedBytes * 6, envelope.originalByteLength * 3);
  const compressionRatio =
    rawJsonBytes > compressedBytes
      ? +(1 - compressedBytes / rawJsonBytes).toFixed(4)
      : 0;

  const record: LocalGzipCacheRecord = {
    fingerprint: envelope.fingerprint || `dwg_${DWG_CACHE_SCHEMA_VERSION}_import_${now}`,
    fileName: envelope.fileName || 'imported.dwg',
    originalByteLength: envelope.originalByteLength || compressedBytes,
    rawJsonBytes,
    compressedBytes,
    compressionRatio,
    versionLabel: envelope.versionLabel || 'AutoCAD DWG (Gzip 缓存)',
    entityCount: envelope.entityCount || stats.entityCount,
    layerCount: envelope.layerCount || stats.layerCount,
    wasmParseMs: envelope.wasmParseMs || 0,
    createdAt: envelope.createdAt || now,
    updatedAt: now,
    storageScope: 'both',
    gzBytes,
  };

  await persistRecordToIdb(record);
  const synced = await syncRecordToServerCache(record);
  record.storageScope = synced ? 'both' : 'local-only';

  return record;
}

/**
 * Looks up a Gzip cache record by fingerprint across:
 *   - L1: Browser Memory + IndexedDB
 *   - L2: Local Server Shared Disk Cache (`GET /api/dwg-cache/:fingerprint`)
 * Decompresses it via DecompressionStream('gzip') and returns the ready-to-render DwgParseResultPayload.
 */
export async function getAndDecompressGzipCache(
  fingerprint: string,
  onProgress?: (percent: number, detail: string) => void,
  profile?: DeviceMemoryProfile
): Promise<DecompressedCacheHit | null> {
  const activeProfile = profile ?? getDeviceMemoryProfile();
  const isRestricted = isMobileOrRestricted() || activeProfile.defenseModeEnabled;
  let hitLayer: 'local-idb' | 'server-shared' = 'local-idb';
  let record: LocalGzipCacheRecord | undefined = memoryStore.get(fingerprint);

  if (!record) {
    const db = await openGzipCacheDb();
    if (db) {
      record = await new Promise<LocalGzipCacheRecord | undefined>((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const req = tx.objectStore(STORE_NAME).get(fingerprint);
          req.onsuccess = () => resolve(req.result || undefined);
          req.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      });
      if (
        record &&
        record.gzBytes &&
        !isRestricted &&
        record.gzBytes.byteLength <= 10 * 1024 * 1024
      ) {
        memoryStore.set(fingerprint, record);
      }
    }
  }

  // L2 Fallback: Query local server shared disk cache (enables cross-device & cross-browser sharing)
  if (!record || !record.gzBytes || record.gzBytes.byteLength === 0) {
    // 🛡️ Zero-Copy Network Stream Decompression on iOS / Mobile / Defense Mode:
    // Pipe `res.body` (ReadableStream<Uint8Array>) directly into `decompressGzipToEnvelope`
    // without allocating a contiguous 41MB ArrayBuffer via `res.arrayBuffer()` or cloning into IndexedDB!
    if (isRestricted && typeof fetch !== 'undefined') {
      try {
        const res = await fetch(`${SERVER_CACHE_API}/${encodeURIComponent(fingerprint)}`, {
          method: 'GET',
          headers: { Accept: 'application/gzip' },
        });
        if (res.ok && res.status !== 204 && res.body) {
          let serverMeta: Partial<LocalGzipCacheMeta> = {};
          const metaHeader = res.headers.get('X-Dwg-Cache-Meta');
          if (metaHeader) {
            try {
              serverMeta = JSON.parse(decodeURIComponent(metaHeader));
            } catch {
              // ignore
            }
          }
          const contentLength =
            Number(res.headers.get('content-length')) ||
            Number(serverMeta.compressedBytes) ||
            0;
          const t0 = performance.now();
          const envelope = await decompressGzipToEnvelope(res.body, onProgress, activeProfile);
          const decompressMs = Math.max(1, Math.round(performance.now() - t0));
          const now = Date.now();
          const rawJsonBytes =
            envelope.__rawJsonBytes ||
            Number(serverMeta.rawJsonBytes) ||
            contentLength * 5;
          const compressedBytes = Number(serverMeta.compressedBytes) || contentLength;
          const meta: LocalGzipCacheMeta = {
            fingerprint: serverMeta.fingerprint || envelope.fingerprint || fingerprint,
            fileName: serverMeta.fileName || envelope.fileName || `${fingerprint}.dwg`,
            originalByteLength:
              Number(serverMeta.originalByteLength) ||
              envelope.originalByteLength ||
              compressedBytes,
            rawJsonBytes,
            compressedBytes,
            compressionRatio:
              Number(serverMeta.compressionRatio) ||
              (rawJsonBytes > compressedBytes && rawJsonBytes > 0
                ? +(1 - compressedBytes / rawJsonBytes).toFixed(4)
                : 0),
            versionLabel:
              serverMeta.versionLabel || envelope.versionLabel || 'AutoCAD DWG',
            entityCount:
              Number(serverMeta.entityCount) || envelope.entityCount || 0,
            layerCount:
              Number(serverMeta.layerCount) || envelope.layerCount || 0,
            wasmParseMs:
              Number(serverMeta.wasmParseMs) || envelope.wasmParseMs || 0,
            createdAt: Number(serverMeta.createdAt) || envelope.createdAt || now,
            updatedAt: now,
            storageScope: 'server-shared',
          };
          return {
            meta,
            payload: envelope.payload,
            decompressMs,
            gzBytes: new Uint8Array(0),
            hitLayer: 'server-shared',
          };
        }
      } catch (err) {
        console.warn('[GzipCache] Direct L2 stream decompression failed, falling back:', err);
      }
    }

    const serverRecord = await fetchRecordFromServerCache(fingerprint);
    if (serverRecord && serverRecord.gzBytes) {
      record = serverRecord;
      hitLayer = 'server-shared';
      await persistRecordToIdb(serverRecord);
    }
  }

  if (!record || !record.gzBytes) {
    return null;
  }

  const t0 = performance.now();
  try {
    const envelope = await decompressGzipToEnvelope(record.gzBytes, onProgress, activeProfile);
    const decompressMs = Math.max(1, Math.round(performance.now() - t0));

    record.updatedAt = Date.now();
    if (!isRestricted && record.gzBytes.byteLength <= 10 * 1024 * 1024) {
      void touchRecordTimestamp(record);
    }

    const { gzBytes, ...meta } = record;
    if (isRestricted) {
      (record as any).gzBytes = null;
    }
    return {
      meta,
      payload: envelope.payload,
      decompressMs,
      gzBytes: isRestricted ? new Uint8Array(0) : gzBytes,
      hitLayer,
    };
  } catch (err) {
    console.warn('[GzipCache] Decompression failed, evicting corrupted entry:', err);
    await deleteGzipCacheEntry(fingerprint);
    return null;
  }
}

/**
 * Retrieves the raw Gzip record (including gzBytes) by fingerprint from L1 or L2 without decompressing.
 */
export async function getRawGzipCacheRecord(
  fingerprint: string
): Promise<LocalGzipCacheRecord | null> {
  const inMem = memoryStore.get(fingerprint);
  if (inMem) return inMem;

  const db = await openGzipCacheDb();
  if (db) {
    const fromIdb = await new Promise<LocalGzipCacheRecord | null>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(fingerprint);
        req.onsuccess = () => {
          const res = req.result as LocalGzipCacheRecord | undefined;
          if (res && res.gzBytes) {
            if (!isMobileOrRestricted() && res.gzBytes.byteLength <= 10 * 1024 * 1024) {
              memoryStore.set(fingerprint, res);
            }
            resolve(res);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    if (fromIdb) return fromIdb;
  }

  const fromServer = await fetchRecordFromServerCache(fingerprint);
  if (fromServer) {
    await persistRecordToIdb(fromServer);
    return fromServer;
  }
  return null;
}

/**
 * Lists metadata for all cached Gzip drawings across L1 (Browser IndexedDB) and L2 (Server Disk Cache),
 * sorted by most recently accessed.
 * Uses an IndexedDB cursor (`openCursor`) and immediately releases `gzBytes` per record so multiple
 * large binary blobs never coexist in memory on mobile devices.
 */
export async function listGzipCacheEntries(): Promise<LocalGzipCacheMeta[]> {
  const localMap = new Map<string, LocalGzipCacheMeta>();

  for (const [fp, rec] of memoryStore.entries()) {
    const { gzBytes: _gz, ...meta } = rec;
    localMap.set(fp, { ...meta, storageScope: 'local-only' });
  }

  const db = await openGzipCacheDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        if (typeof store.openCursor === 'function') {
          const req = store.openCursor();
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
              resolve();
              return;
            }
            const rec = cursor.value as LocalGzipCacheRecord | undefined;
            if (rec && rec.fingerprint) {
              (rec as any).gzBytes = null;
              const { gzBytes: _gz, ...meta } = rec;
              localMap.set(rec.fingerprint, { ...meta, storageScope: 'local-only' });
            }
            cursor.continue();
          };
          req.onerror = () => resolve();
        } else {
          const req = store.getAll();
          req.onsuccess = () => {
            const dbRecords = (req.result as LocalGzipCacheRecord[]) || [];
            for (const rec of dbRecords) {
              if (rec && rec.fingerprint) {
                (rec as any).gzBytes = null;
                const { gzBytes: _gz, ...meta } = rec;
                localMap.set(rec.fingerprint, { ...meta, storageScope: 'local-only' });
              }
            }
            resolve();
          };
          req.onerror = () => resolve();
        }
      } catch {
        resolve();
      }
    });
  }

  // Merge with L2 Server Shared Cache entries
  if (typeof fetch !== 'undefined') {
    try {
      const res = await fetch(SERVER_CACHE_API, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        const serverEntries: LocalGzipCacheMeta[] = Array.isArray(data?.entries)
          ? data.entries
          : [];
        for (const srvMeta of serverEntries) {
          if (!srvMeta || !srvMeta.fingerprint) continue;
          const existingLocal = localMap.get(srvMeta.fingerprint);
          if (existingLocal) {
            localMap.set(srvMeta.fingerprint, {
              ...existingLocal,
              updatedAt: Math.max(existingLocal.updatedAt, srvMeta.updatedAt || 0),
              storageScope: 'both',
            });
          } else {
            localMap.set(srvMeta.fingerprint, {
              ...srvMeta,
              storageScope: 'server-shared',
            });
          }
        }
      }
    } catch {
      // Ignore if server API is unreachable
    }
  }

  return Array.from(localMap.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Finds a cached Gzip entry by its DWG file name (case-insensitive, normalized).
 * Implements the "同名匹配法则" (same-name matching rule) to prefer Gzip cache
 * over cold WASM re-parsing when selecting drawings by name or URL.
 * Prioritizes in-memory metadata and the lightweight server metadata endpoint (`GET /api/dwg-cache`)
 * before scanning local IndexedDB records.
 */
export async function findGzipCacheByFileName(
  fileName: string
): Promise<LocalGzipCacheMeta | null> {
  const cleanTarget = normalizeDwgFileNameForConverter(fileName).toLowerCase();

  // 1. Check in-memory cache first (0 I/O overhead)
  for (const [, rec] of memoryStore.entries()) {
    if (normalizeDwgFileNameForConverter(rec.fileName).toLowerCase() === cleanTarget) {
      const { gzBytes: _gz, ...meta } = rec;
      return { ...meta, storageScope: meta.storageScope || 'local-only' };
    }
  }

  // 2. Query lightweight L2 Server metadata JSON list (avoids deserializing local IndexedDB binary blobs)
  if (typeof fetch !== 'undefined') {
    try {
      const res = await fetch(SERVER_CACHE_API, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        const serverEntries: LocalGzipCacheMeta[] = Array.isArray(data?.entries)
          ? data.entries
          : [];
        for (const srvMeta of serverEntries) {
          if (
            srvMeta &&
            srvMeta.fingerprint &&
            normalizeDwgFileNameForConverter(srvMeta.fileName).toLowerCase() === cleanTarget
          ) {
            return { ...srvMeta, storageScope: 'server-shared' };
          }
        }
      }
    } catch {
      // Fallback to full list scan
    }
  }

  // 3. Fallback to full L1 + L2 metadata scan
  const allEntries = await listGzipCacheEntries();
  for (const entry of allEntries) {
    if (normalizeDwgFileNameForConverter(entry.fileName).toLowerCase() === cleanTarget) {
      return entry;
    }
  }
  return null;
}

/**
 * Deletes a single Gzip cache entry by fingerprint from both L1 IndexedDB and L2 Server Disk.
 */
export async function deleteGzipCacheEntry(fingerprint: string): Promise<void> {
  memoryStore.delete(fingerprint);
  const db = await openGzipCacheDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(fingerprint);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  if (typeof fetch !== 'undefined') {
    try {
      await fetch(`${SERVER_CACHE_API}/${encodeURIComponent(fingerprint)}`, {
        method: 'DELETE',
      });
    } catch {
      // ignore
    }
  }
}

/**
 * Clears all Gzip cache entries from memory, IndexedDB, and L2 Server Disk.
 */
export async function clearAllGzipCacheEntries(): Promise<void> {
  memoryStore.clear();
  const db = await openGzipCacheDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  if (typeof fetch !== 'undefined') {
    try {
      await fetch(SERVER_CACHE_API, { method: 'DELETE' });
    } catch {
      // ignore
    }
  }
}

async function touchRecordTimestamp(record: LocalGzipCacheRecord): Promise<void> {
  const db = await openGzipCacheDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
  } catch {
    // ignore
  }
}

async function enforceLruLimit(db: IDBDatabase): Promise<void> {
  const allMeta = await new Promise<Array<{ fingerprint: string; updatedAt: number }>>((resolve) => {
    const items: Array<{ fingerprint: string; updatedAt: number }> = [];
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      if (typeof store.openCursor === 'function') {
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(items);
            return;
          }
          const rec = cursor.value as LocalGzipCacheRecord | undefined;
          if (rec && rec.fingerprint) {
            (rec as any).gzBytes = null;
            items.push({ fingerprint: rec.fingerprint, updatedAt: rec.updatedAt || 0 });
          }
          cursor.continue();
        };
        req.onerror = () => resolve(items);
      } else {
        const req = store.getAll();
        req.onsuccess = () => {
          const list = (req.result as LocalGzipCacheRecord[]) || [];
          for (const rec of list) {
            if (rec && rec.fingerprint) {
              (rec as any).gzBytes = null;
              items.push({ fingerprint: rec.fingerprint, updatedAt: rec.updatedAt || 0 });
            }
          }
          resolve(items);
        };
        req.onerror = () => resolve([]);
      }
    } catch {
      resolve([]);
    }
  });

  if (allMeta.length <= MAX_CACHE_ENTRIES) return;

  allMeta.sort((a, b) => b.updatedAt - a.updatedAt);
  const toEvict = allMeta.slice(MAX_CACHE_ENTRIES);

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const item of toEvict) {
        memoryStore.delete(item.fingerprint);
        store.delete(item.fingerprint);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
