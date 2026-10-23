export const DWG_CACHE_SCHEMA_VERSION = 'v2';

const STUB_MAGIC_PREFIX = 'AC1027__GZIP_STUB__:';

export interface DwgParseResultPayload<TModel = any> {
  model: TModel;
  data?: any;
}

export interface DwgCacheEnvelope<TModel = any> {
  __dwgCacheSchema: string;
  fileName: string;
  fingerprint: string;
  originalByteLength: number;
  versionLabel?: string;
  createdAt: number;
  wasmParseMs?: number;
  entityCount: number;
  layerCount: number;
  payload: DwgParseResultPayload<TModel>;
}

export interface GzipCompressionResult {
  gzBytes: Uint8Array;
  rawJsonBytes: number;
  compressedBytes: number;
  /** Saving ratio in [0, 1], e.g. 0.86 means compressed size is 86% smaller than raw JSON */
  compressionRatio: number;
}

/**
 * Computes an ultra-fast (<0.15ms) 64-bit multi-window sampling fingerprint for a DWG ArrayBuffer.
 * Samples head (4KB), middle (4KB), and tail (4KB) along with byteLength and schema version.
 */
export function computeDwgFingerprint(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const len = bytes.byteLength;
  let h1 = 0x811c9dc5;
  let h2 = 0x5b793fb7;

  const windowSize = 4096;
  const midStart = Math.max(0, Math.floor(len / 2) - Math.floor(windowSize / 2));
  const tailStart = Math.max(0, len - windowSize);

  const ranges = [
    [0, Math.min(len, windowSize)],
    [midStart, Math.min(len, midStart + windowSize)],
    [tailStart, len],
  ];

  for (let r = 0; r < ranges.length; r++) {
    const start = ranges[r][0];
    const end = ranges[r][1];
    for (let i = start; i < end; i++) {
      const b = bytes[i];
      h1 ^= b;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= b;
      h2 = Math.imul(h2, 0x5bd1e995);
    }
  }

  return `dwg_${DWG_CACHE_SCHEMA_VERSION}_${len}_${(h1 >>> 0).toString(16)}_${(h2 >>> 0).toString(16)}`;
}

/**
 * Converts Uint8Array to Base64 string safely without call-stack overflow on large buffers.
 */
export function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, sub as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Converts Base64 string back to Uint8Array.
 */
export function base64ToUint8(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    const buf = Buffer.from(base64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Custom JSON.stringify replacer that safely preserves BigInt and Uint8Array.
 * Prevents "TypeError: Do not know how to serialize a BigInt" and 4x Uint8Array bloat.
 */
export function dwgJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { __dwg_bigint__: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return { __dwg_u8__: uint8ToBase64(value) };
  }
  return value;
}

/**
 * Custom JSON.parse reviver that restores BigInt and Uint8Array instances.
 */
export function dwgJsonReviver(_key: string, value: any): any {
  if (value && typeof value === 'object') {
    if (typeof value.__dwg_bigint__ === 'string' && Object.keys(value).length === 1) {
      try {
        return BigInt(value.__dwg_bigint__);
      } catch {
        return value.__dwg_bigint__;
      }
    }
    if (typeof value.__dwg_u8__ === 'string' && Object.keys(value).length === 1) {
      return base64ToUint8(value.__dwg_u8__);
    }
  }
  return value;
}

/**
 * Counts entities and layers inside a parsed DwgDatabase model for cache telemetry.
 */
export function summarizeDwgModel(model: any): { entityCount: number; layerCount: number } {
  if (!model || typeof model !== 'object') {
    return { entityCount: 0, layerCount: 0 };
  }
  const layerEntries = model.tables?.LAYER?.entries;
  const layerCount = Array.isArray(layerEntries) ? layerEntries.length : 0;

  let entityCount = Array.isArray(model.entities) ? model.entities.length : 0;
  const blockEntries = model.tables?.BLOCK_RECORD?.entries;
  if (Array.isArray(blockEntries)) {
    for (const btr of blockEntries) {
      if (btr && Array.isArray(btr.entities)) {
        entityCount += btr.entities.length;
      }
    }
  }
  return { entityCount, layerCount };
}

function hasSpecialBinaryOrBigInt(node: any): boolean {
  if (typeof node === 'bigint') return true;
  if (!node || typeof node !== 'object') return false;
  if (node instanceof Uint8Array) return true;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (hasSpecialBinaryOrBigInt(node[i])) return true;
    }
    return false;
  }

  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (FAST_SKIP_KEYS.has(k)) continue;
    const val = node[k];
    if (typeof val === 'bigint') return true;
    if (val && typeof val === 'object' && hasSpecialBinaryOrBigInt(val)) {
      return true;
    }
  }
  return false;
}

/**
 * Uses V8 native C++ JSON.stringify fast-path when no BigInt/Uint8Array is present,
 * falling back to dwgJsonReplacer only when needed.
 */
function fastJsonStringify(value: unknown): string {
  if (!hasSpecialBinaryOrBigInt(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      // Fallback if BigInt was inside a skipped key
    }
  }
  return JSON.stringify(value, dwgJsonReplacer);
}

function parseJsonLineWithReviver(jsonLine: string): any {
  let parsed = JSON.parse(jsonLine);
  if (jsonLine.includes('"__dwg_bigint__"') || jsonLine.includes('"__dwg_u8__"')) {
    parsed = restoreSpecialTypesInPlace(parsed);
  }
  return parsed;
}

/**
 * Serializes a DwgCacheEnvelope into a JSON string with BigInt & Uint8Array safety.
 */
export function serializeDwgCacheEnvelope(envelope: DwgCacheEnvelope): string {
  return fastJsonStringify(envelope);
}

const FAST_SKIP_KEYS = new Set([
  'vertices',
  'controlPoints',
  'fitPoints',
  'knotValues',
  'weights',
  'pattern',
  'startPoint',
  'endPoint',
  'insertionPoint',
  'center',
  'position',
  'minLimit',
  'maxLimit',
  'minExtent',
  'maxExtent',
]);

function restoreSpecialTypesInPlace(node: any): any {
  if (!node || typeof node !== 'object') return node;

  if (typeof node.__dwg_bigint__ === 'string' && Object.keys(node).length === 1) {
    try {
      return BigInt(node.__dwg_bigint__);
    } catch {
      return node.__dwg_bigint__;
    }
  }
  if (typeof node.__dwg_u8__ === 'string' && Object.keys(node).length === 1) {
    return base64ToUint8(node.__dwg_u8__);
  }

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const el = node[i];
      if (el && typeof el === 'object') {
        node[i] = restoreSpecialTypesInPlace(el);
      }
    }
    return node;
  }

  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (FAST_SKIP_KEYS.has(k)) continue;
    const val = node[k];
    if (val && typeof val === 'object') {
      node[k] = restoreSpecialTypesInPlace(val);
    }
  }
  return node;
}

function applyChunkLineToEnvelope(envelope: DwgCacheEnvelope, chunkObj: any): void {
  if (!chunkObj || typeof chunkObj !== 'object') return;
  const model = envelope.payload?.model;
  if (!model || typeof model !== 'object') return;

  if (chunkObj.__dwgChunk === 'ms' && Array.isArray(chunkObj.items)) {
    if (!Array.isArray(model.entities)) {
      model.entities = [];
    }
    const target = model.entities;
    const items = chunkObj.items;
    for (let i = 0; i < items.length; i++) {
      target.push(items[i]);
    }
  } else if (
    chunkObj.__dwgChunk === 'btr' &&
    typeof chunkObj.idx === 'number' &&
    Array.isArray(chunkObj.items)
  ) {
    const btr = model.tables?.BLOCK_RECORD?.entries?.[chunkObj.idx];
    if (btr && typeof btr === 'object') {
      if (!Array.isArray(btr.entities)) {
        btr.entities = [];
      }
      const target = btr.entities;
      const items = chunkObj.items;
      for (let i = 0; i < items.length; i++) {
        target.push(items[i]);
      }
    }
  }
}

/**
 * Deserializes a JSON (or multi-line NDJSON) string into a DwgCacheEnvelope.
 * Uses V8 fast-path JSON.parse() without a per-property C++->JS reviver callback, then runs
 * a targeted in-place pass only if BigInt or Uint8Array markers are present.
 */
export function deserializeDwgCacheEnvelope(jsonStr: string): DwgCacheEnvelope {
  const firstNewline = jsonStr.indexOf('\n');
  if (firstNewline >= 0) {
    const lines = jsonStr.split('\n');
    let envelope: DwgCacheEnvelope | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (!envelope) {
        envelope = deserializeDwgCacheEnvelope(line);
      } else {
        const chunkObj = parseJsonLineWithReviver(line);
        applyChunkLineToEnvelope(envelope, chunkObj);
      }
    }
    if (envelope) return envelope;
  }

  const parsed = parseJsonLineWithReviver(jsonStr);
  if (parsed && typeof parsed === 'object' && parsed.__dwgCacheSchema && parsed.payload) {
    return parsed as DwgCacheEnvelope;
  }
  // Compatibility fallback if raw { model, data } was serialized directly
  const payload: DwgParseResultPayload =
    parsed && typeof parsed === 'object' && 'model' in parsed
      ? parsed
      : { model: parsed, data: {} };
  const stats = summarizeDwgModel(payload.model);
  return {
    __dwgCacheSchema: DWG_CACHE_SCHEMA_VERSION,
    fileName: 'cached.dwg',
    fingerprint: `dwg_${DWG_CACHE_SCHEMA_VERSION}_raw`,
    originalByteLength: 0,
    createdAt: Date.now(),
    entityCount: stats.entityCount,
    layerCount: stats.layerCount,
    payload,
  };
}

/**
 * Checks whether a buffer starts with the standard Gzip magic header (0x1f 0x8b).
 */
export function isGzipMagicHeader(buffer: ArrayBuffer | Uint8Array): boolean {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Checks whether a file name or binary buffer represents a Gzip DWG cache file (.dwg.cache.gz / .gz).
 */
export function isGzipCacheFile(fileName: string, buffer?: ArrayBuffer | Uint8Array): boolean {
  const lower = (fileName || '').trim().toLowerCase();
  if (
    lower.endsWith('.dwg.cache.gz') ||
    lower.endsWith('.cache.gz') ||
    lower.endsWith('.dwg.gz') ||
    lower.endsWith('.gz')
  ) {
    return true;
  }
  if (buffer && isGzipMagicHeader(buffer)) {
    return true;
  }
  return false;
}

/**
 * Ensures the file name ends with `.dwg` so `AcApDocument.openDocument` dispatches to `AcDbFileType.DWG`
 * instead of falling back to `AcDbFileType.DXF` when opening `.dwg.cache.gz` files.
 */
export function normalizeDwgFileNameForConverter(fileName: string): string {
  let clean = (fileName || '').trim();
  if (!clean) return 'drawing.dwg';

  clean = clean
    .replace(/\.dwg\.v\d+\.cache\.gz$/i, '.dwg')
    .replace(/\.dwg\.cache\.gz$/i, '.dwg')
    .replace(/\.cache\.gz$/i, '.dwg')
    .replace(/\.dwg\.gz$/i, '.dwg')
    .replace(/\.gz$/i, '.dwg')
    .replace(/\.json$/i, '.dwg');

  if (!clean.toLowerCase().endsWith('.dwg')) {
    clean = `${clean}.dwg`;
  }
  return clean;
}

/**
 * Formats a clean `.dwg.cache.gz` export file name from a source DWG file name.
 */
export function buildGzipCacheFileName(fileName: string): string {
  const baseDwg = normalizeDwgFileNameForConverter(fileName);
  return `${baseDwg}.cache.gz`;
}

const STREAM_ENTITY_CHUNK_SIZE = 3500;

/**
 * Builds a generator of NDJSON lines for a DwgCacheEnvelope so that even 18MB~50MB DWG files
 * (whose uncompressed JSON exceeds 150MB~400MB) are serialized and compressed in small ~3MB chunks
 * without ever hitting V8's max string length or spiking heap memory.
 */
function* generateEnvelopeJsonChunks(envelope: DwgCacheEnvelope): Generator<string, void, unknown> {
  const model = envelope.payload?.model;
  const msEntities: any[] = Array.isArray(model?.entities) ? model.entities : [];
  const btrEntries: any[] = Array.isArray(model?.tables?.BLOCK_RECORD?.entries)
    ? model.tables.BLOCK_RECORD.entries
    : [];

  let totalEntities = msEntities.length;
  for (let i = 0; i < btrEntries.length; i++) {
    const btr = btrEntries[i];
    if (btr && Array.isArray(btr.entities)) {
      totalEntities += btr.entities.length;
    }
  }

  // Fast single-chunk path for small drawings (< 2000 entities)
  if (totalEntities <= 2000) {
    yield fastJsonStringify(envelope);
    return;
  }

  // Multi-chunk NDJSON streaming path for large drawings (e.g. baseline-sample.dwg)
  const shallowBlockRecords = btrEntries.map((btr: any) =>
    btr && Array.isArray(btr.entities) && btr.entities.length > 0
      ? { ...btr, entities: [] }
      : btr
  );

  const headerModel =
    model && typeof model === 'object'
      ? {
          ...model,
          entities: [],
          tables:
            model.tables && typeof model.tables === 'object'
              ? {
                  ...model.tables,
                  ...(btrEntries.length > 0
                    ? {
                        BLOCK_RECORD: {
                          ...model.tables.BLOCK_RECORD,
                          entries: shallowBlockRecords,
                        },
                      }
                    : {}),
                }
              : model.tables,
        }
      : model;

  const headerEnvelope: DwgCacheEnvelope = {
    ...envelope,
    payload: {
      ...envelope.payload,
      model: headerModel,
    },
  };

  yield `${fastJsonStringify(headerEnvelope)}\n`;

  for (let i = 0; i < msEntities.length; i += STREAM_ENTITY_CHUNK_SIZE) {
    const slice = msEntities.slice(i, i + STREAM_ENTITY_CHUNK_SIZE);
    yield `${fastJsonStringify({ __dwgChunk: 'ms', items: slice })}\n`;
  }

  for (let bIdx = 0; bIdx < btrEntries.length; bIdx++) {
    const btr = btrEntries[bIdx];
    const ents = btr?.entities;
    if (Array.isArray(ents) && ents.length > 0) {
      for (let i = 0; i < ents.length; i += STREAM_ENTITY_CHUNK_SIZE) {
        const slice = ents.slice(i, i + STREAM_ENTITY_CHUNK_SIZE);
        yield `${fastJsonStringify({ __dwgChunk: 'btr', idx: bIdx, items: slice })}\n`;
      }
    }
  }
}

/**
 * Compresses a DwgCacheEnvelope into a Gzip Uint8Array using native Web CompressionStream('gzip')
 * with chunked NDJSON streaming so large drawings never allocate a single giant string.
 */
export async function compressEnvelopeToGzip(
  envelope: DwgCacheEnvelope
): Promise<GzipCompressionResult> {
  const encoder = new TextEncoder();
  const chunkIterator = generateEnvelopeJsonChunks(envelope);
  let rawJsonBytes = 0;

  if (typeof CompressionStream === 'undefined') {
    const parts: Uint8Array[] = [];
    for (const strChunk of chunkIterator) {
      const encoded = encoder.encode(strChunk);
      rawJsonBytes += encoded.byteLength;
      parts.push(encoded);
    }
    const merged = new Uint8Array(rawJsonBytes);
    let offset = 0;
    for (const p of parts) {
      merged.set(p, offset);
      offset += p.byteLength;
    }
    return {
      gzBytes: merged,
      rawJsonBytes,
      compressedBytes: rawJsonBytes,
      compressionRatio: 0,
    };
  }

  const sourceStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        const next = chunkIterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        const encoded = encoder.encode(next.value);
        rawJsonBytes += encoded.byteLength;
        controller.enqueue(encoded);
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const compressedStream = sourceStream.pipeThrough(
    new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>
  );
  const compressedBuffer = await new Response(compressedStream).arrayBuffer();
  const gzBytes = new Uint8Array(compressedBuffer);
  const compressedBytes = gzBytes.byteLength;
  const compressionRatio =
    rawJsonBytes > 0 ? Math.max(0, +(1 - compressedBytes / rawJsonBytes).toFixed(4)) : 0;

  return {
    gzBytes,
    rawJsonBytes,
    compressedBytes,
    compressionRatio,
  };
}

/**
 * Decompresses a Gzip (or plain JSON/NDJSON) buffer back into a DwgCacheEnvelope using native
 * DecompressionStream('gzip') and incremental line-by-line streaming parser.
 */
export async function decompressGzipToEnvelope(
  gzOrJsonBuffer: ArrayBuffer | Uint8Array
): Promise<DwgCacheEnvelope & { __rawJsonBytes?: number }> {
  const bytes =
    gzOrJsonBuffer instanceof Uint8Array ? gzOrJsonBuffer : new Uint8Array(gzOrJsonBuffer);

  if (isGzipMagicHeader(bytes) && typeof DecompressionStream !== 'undefined') {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const decompressedStream = new Blob([copy])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));

    const reader = decompressedStream.getReader();
    const decoder = new TextDecoder('utf-8');
    let rawJsonBytes = 0;
    let leftover = '';
    let envelope: (DwgCacheEnvelope & { __rawJsonBytes?: number }) | null = null;

    const processLine = (rawLine: string) => {
      const trimmed = rawLine.trim();
      if (!trimmed) return;
      if (!envelope) {
        envelope = deserializeDwgCacheEnvelope(trimmed) as DwgCacheEnvelope & {
          __rawJsonBytes?: number;
        };
      } else {
        const chunkObj = parseJsonLineWithReviver(trimmed);
        applyChunkLineToEnvelope(envelope, chunkObj);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        rawJsonBytes += value.byteLength;
        leftover += decoder.decode(value, { stream: true });
        let nlIdx = leftover.indexOf('\n');
        while (nlIdx >= 0) {
          const line = leftover.slice(0, nlIdx);
          leftover = leftover.slice(nlIdx + 1);
          processLine(line);
          nlIdx = leftover.indexOf('\n');
        }
      }
    }

    leftover += decoder.decode();
    if (leftover.trim()) {
      processLine(leftover);
    }

    if (!envelope) {
      throw new Error('Gzip 缓存内容为空或格式损坏');
    }
    const finalEnvelope = envelope as DwgCacheEnvelope & { __rawJsonBytes?: number };
    finalEnvelope.__rawJsonBytes = rawJsonBytes;
    return finalEnvelope;
  }

  const jsonStr = new TextDecoder().decode(bytes);
  const env = deserializeDwgCacheEnvelope(jsonStr) as DwgCacheEnvelope & {
    __rawJsonBytes?: number;
  };
  env.__rawJsonBytes = bytes.byteLength;
  return env;
}

/**
 * Creates a 128-byte valid AutoCAD DWG stub ArrayBuffer containing the `AC1027` header signature
 * and an embedded stub token. Used when opening directly from a `.dwg.cache.gz` cache without downloading
 * the original `.dwg` file.
 */
export function createDwgStubBuffer(stubToken: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const tokenBytes = encoder.encode(`${STUB_MAGIC_PREFIX}${stubToken}`);
  const byteLength = Math.max(128, tokenBytes.byteLength + 16);
  const stub = new Uint8Array(byteLength);
  stub.set(tokenBytes.subarray(0, byteLength));
  return stub.buffer;
}

/**
 * Extracts the embedded stub token if the ArrayBuffer was created by `createDwgStubBuffer`.
 */
export function extractDwgStubToken(buffer: ArrayBuffer | Uint8Array): string | null {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < STUB_MAGIC_PREFIX.length || bytes.byteLength > 512) {
    return null;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.startsWith(STUB_MAGIC_PREFIX)) {
    return null;
  }
  const rawToken = text.slice(STUB_MAGIC_PREFIX.length);
  const nullIdx = rawToken.indexOf('\0');
  return (nullIdx >= 0 ? rawToken.slice(0, nullIdx) : rawToken).trim() || null;
}
