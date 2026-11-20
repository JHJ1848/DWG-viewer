import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DWG_CACHE_SCHEMA_VERSION,
  computeDwgFingerprint,
  serializeDwgCacheEnvelope,
  deserializeDwgCacheEnvelope,
  compressEnvelopeToGzip,
  decompressGzipToEnvelope,
  isGzipMagicHeader,
  isGzipCacheFile,
  normalizeDwgFileNameForConverter,
  buildGzipCacheFileName,
  createDwgStubBuffer,
  extractDwgStubToken,
  summarizeDwgModel,
  DwgCacheEnvelope,
} from './dwgGzipCache.ts';
import { inspectDwgHeader } from './dwgValidation.ts';

test('computeDwgFingerprint produces deterministic fingerprint and detects byte changes', () => {
  const bufA = new Uint8Array(16384);
  bufA[0] = 0x41;
  bufA[8192] = 0x55;
  bufA[16383] = 0x99;

  const bufB = new Uint8Array(bufA);
  assert.equal(computeDwgFingerprint(bufA.buffer), computeDwgFingerprint(bufB.buffer));

  // Mutate a byte in the middle sampling window
  bufB[8192] = 0x56;
  assert.notEqual(computeDwgFingerprint(bufA.buffer), computeDwgFingerprint(bufB.buffer));
});

test('BigInt and Uint8Array survive JSON serialization and Gzip stream compression/decompression', async () => {
  const sampleModel = {
    header: {
      EXTMIN: { x: 100.5, y: 200.25, z: 0 },
      HANDLE_SEED: BigInt('9007199254740993123'),
    },
    thumbnailImage: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    tables: {
      LAYER: {
        entries: [
          { name: '0', handle: BigInt(16), plotFlag: 1 },
          { name: 'CONTOUR', handle: BigInt(32), plotFlag: 1 },
        ],
      },
      BLOCK_RECORD: {
        entries: [
          {
            name: '*MODEL_SPACE',
            entities: Array.from({ length: 50 }, (_, idx) => ({
              type: 'LWPOLYLINE',
              handle: BigInt(1000 + idx),
              elevation: 0,
              vertices: [
                { x: idx * 10, y: idx * 20 },
                { x: idx * 10 + 5, y: idx * 20 + 5 },
              ],
            })),
          },
        ],
      },
    },
    entities: [
      { type: 'TEXT', text: '测试高程点{\\S3^;}', handle: BigInt(9999) },
    ],
  };

  const stats = summarizeDwgModel(sampleModel);
  assert.equal(stats.layerCount, 2);
  assert.equal(stats.entityCount, 51);

  const envelope: DwgCacheEnvelope = {
    __dwgCacheSchema: DWG_CACHE_SCHEMA_VERSION,
    fileName: 'canteen.dwg',
    fingerprint: 'dwg_v2_2621440_abc_def',
    originalByteLength: 2621440,
    versionLabel: 'AutoCAD 2013/2017 DWG',
    createdAt: 1710000000000,
    wasmParseMs: 4250,
    entityCount: stats.entityCount,
    layerCount: stats.layerCount,
    payload: {
      model: sampleModel,
      data: { unknownEntityCount: 0 },
    },
  };

  // 1. Test JSON round-trip
  const json = serializeDwgCacheEnvelope(envelope);
  const restoredFromJson = deserializeDwgCacheEnvelope(json);
  assert.equal(restoredFromJson.payload.model.header.HANDLE_SEED, BigInt('9007199254740993123'));
  assert.equal(restoredFromJson.payload.model.tables.LAYER.entries[0].handle, BigInt(16));
  assert.ok(restoredFromJson.payload.model.thumbnailImage instanceof Uint8Array);
  assert.deepEqual(
    Array.from(restoredFromJson.payload.model.thumbnailImage),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  );

  // 2. Test Gzip stream compression & decompression
  const compressed = await compressEnvelopeToGzip(envelope);
  assert.equal(isGzipMagicHeader(compressed.gzBytes), true);
  assert.ok(compressed.compressedBytes < compressed.rawJsonBytes);
  assert.ok(compressed.compressionRatio > 0.3);

  const decompressed = await decompressGzipToEnvelope(compressed.gzBytes);
  assert.equal(decompressed.fileName, 'canteen.dwg');
  assert.equal(decompressed.entityCount, 51);
  assert.equal(decompressed.payload.model.header.HANDLE_SEED, BigInt('9007199254740993123'));
  assert.ok(decompressed.payload.model.thumbnailImage instanceof Uint8Array);
  assert.equal(decompressed.payload.model.entities[0].text, '测试高程点{\\S3^;}');
});

test('createDwgStubBuffer passes inspectDwgHeader and embeds recoverable token even after slice()', () => {
  const token = 'stub_canteen_12345';
  const stubBuffer = createDwgStubBuffer(token);

  // Must pass standard DWG header inspection as AC1027
  const headerInfo = inspectDwgHeader(stubBuffer);
  assert.equal(headerInfo.isDwg, true);
  assert.equal(headerInfo.versionCode, 'AC1027');

  // Must recover token even when sliced (simulating AcDbDatabase.read slicing ArrayBufferView)
  const clonedBuffer = stubBuffer.slice(0);
  assert.equal(extractDwgStubToken(clonedBuffer), token);

  // Normal DWG buffer should return null stub token
  const realDwgHeader = new Uint8Array([0x41, 0x43, 0x31, 0x30, 0x32, 0x37, 0x00, 0x00]);
  assert.equal(extractDwgStubToken(realDwgHeader.buffer), null);
});

test('normalizeDwgFileNameForConverter and isGzipCacheFile handle .dwg.cache.gz extensions accurately', () => {
  assert.equal(isGzipCacheFile('canteen.dwg.cache.gz'), true);
  assert.equal(isGzipCacheFile('canteen.dwg.v2.cache.gz'), true);
  assert.equal(isGzipCacheFile('canteen.dwg'), false);

  assert.equal(normalizeDwgFileNameForConverter('canteen.dwg.cache.gz'), 'canteen.dwg');
  assert.equal(normalizeDwgFileNameForConverter('canteen.dwg.v2.cache.gz'), 'canteen.dwg');
  assert.equal(normalizeDwgFileNameForConverter('site-plan.cache.gz'), 'site-plan.dwg');
  assert.equal(normalizeDwgFileNameForConverter('canteen.dwg'), 'canteen.dwg');

  assert.equal(buildGzipCacheFileName('canteen.dwg'), 'canteen.dwg.cache.gz');
  assert.equal(buildGzipCacheFileName('canteen.dwg.cache.gz'), 'canteen.dwg.cache.gz');
});

test('decompressGzipToEnvelope supports ReadableStream<Uint8Array> and byte-level 0x0A NDJSON streaming across fragmented UTF-8 chunks', async () => {
  const msEntities = Array.from({ length: 4200 }, (_, i) => ({
    type: 'MTEXT',
    layer: '01-中文地形图高程注记层',
    text: `样例工程区测绘控制点_${i}_高程2850.5m`,
    handle: BigInt(100000 + i),
    insertionPoint: { x: 32600000 + i, y: 3100000 + i, z: 0 },
  }));
  const btrEntities = Array.from({ length: 600 }, (_, i) => ({
    type: 'LINE',
    layer: '02-建筑物轮廓线',
    handle: BigInt(500000 + i),
    startPoint: { x: i, y: i },
    endPoint: { x: i + 10, y: i + 10 },
  }));

  const envelope: DwgCacheEnvelope = {
    __dwgCacheSchema: DWG_CACHE_SCHEMA_VERSION,
    fileName: '示例图纸一.dwg',
    fingerprint: 'dwg_v2_69334172_test',
    originalByteLength: 69334172,
    versionLabel: 'AutoCAD 2018 DWG',
    createdAt: 1710000000000,
    wasmParseMs: 12000,
    entityCount: msEntities.length + btrEntities.length,
    layerCount: 2,
    payload: {
      model: {
        header: { EXTMIN: { x: 0, y: 0, z: 0 } },
        tables: {
          LAYER: { entries: [{ name: '01-中文地形图高程注记层' }, { name: '02-建筑物轮廓线' }] },
          BLOCK_RECORD: {
            entries: [{ name: '*MODEL_SPACE', entities: btrEntities }],
          },
        },
        entities: msEntities,
      },
    },
  };

  const compressed = await compressEnvelopeToGzip(envelope);
  assert.equal(isGzipMagicHeader(compressed.gzBytes), true);

  // Create a fragmented ReadableStream that yields tiny 97-byte slices to stress-test cross-chunk UTF-8 and 0x0A boundary handling
  let offset = 0;
  const step = 97;
  const fragmentedStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= compressed.gzBytes.byteLength) {
        controller.close();
        return;
      }
      const slice = compressed.gzBytes.subarray(
        offset,
        Math.min(compressed.gzBytes.byteLength, offset + step)
      );
      offset += step;
      controller.enqueue(slice);
    },
  });

  const restored = await decompressGzipToEnvelope(fragmentedStream);
  assert.equal(restored.fileName, '示例图纸一.dwg');
  assert.equal(restored.__rawJsonBytes, compressed.rawJsonBytes);
  assert.equal(restored.payload.model.entities.length, 4200);
  assert.equal(restored.payload.model.tables.BLOCK_RECORD.entries[0].entities.length, 600);
  assert.equal(
    restored.payload.model.entities[4199].text,
    '样例工程区测绘控制点_4199_高程2850.5m'
  );
  assert.equal(restored.payload.model.entities[4199].handle, BigInt(104199));
});
