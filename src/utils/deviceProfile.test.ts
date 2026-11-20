import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAdaptiveChunkSize, getDeviceMemoryProfile } from './deviceProfile';
import {
  compressEnvelopeToGzip,
  decompressGzipToEnvelope,
  DwgCacheEnvelope,
  DWG_CACHE_SCHEMA_VERSION,
} from './dwgGzipCache';

test('getDeviceMemoryProfile: returns strict memory-saving limits when defense mode is enabled', () => {
  const defenseProfile = getDeviceMemoryProfile(true);
  assert.equal(defenseProfile.defenseModeEnabled, true);
  assert.equal(defenseProfile.targetPixelRatio, 1.25);
  assert.equal(defenseProfile.adaptiveChunkSize, 600);
  assert.equal(defenseProfile.streamChunkInterval, 12);
  assert.equal(defenseProfile.streamYieldMs, 8);

  const standardProfile = getDeviceMemoryProfile(false);
  assert.equal(standardProfile.defenseModeEnabled, false);
  assert.equal(standardProfile.streamYieldMs, 0);
  assert.equal(standardProfile.adaptiveChunkSize, 1500);
  assert.equal(standardProfile.streamChunkInterval, 25);
});

test('calculateAdaptiveChunkSize: strictly respects profile in defense mode', () => {
  const defenseProfile = getDeviceMemoryProfile(true);
  const standardProfile = getDeviceMemoryProfile(false);

  // In defense mode, always return adaptiveChunkSize (600)
  const chunkUnderDefense = calculateAdaptiveChunkSize(
    { byteLength: 50 * 1024 * 1024, entityCount: 80000 },
    defenseProfile
  );
  assert.equal(chunkUnderDefense, 600);

  // In standard mode, heavy drawing returns standard profile adaptiveChunkSize (1500)
  const chunkUnderStandard = calculateAdaptiveChunkSize(
    { byteLength: 50 * 1024 * 1024, entityCount: 80000 },
    standardProfile
  );
  assert.equal(chunkUnderStandard, 1500);
});

test('decompressGzipToEnvelope: integrates profile and defense mode badge prefix in progress telemetry', async () => {
  const sampleEnvelope: DwgCacheEnvelope = {
    __dwgCacheSchema: DWG_CACHE_SCHEMA_VERSION,
    fileName: 'test-drawing.dwg',
    fingerprint: 'test_defense_001',
    originalByteLength: 1024,
    createdAt: Date.now(),
    entityCount: 1,
    layerCount: 1,
    payload: {
      model: {
        entities: [{ type: 'LINE', start: [0, 0, 0], end: [10, 10, 0] }],
        tables: {
          LAYER: { entries: [{ name: '0', color: 7 }] },
          BLOCK_RECORD: { entries: [] },
        },
      },
    },
  };

  const compressed = await compressEnvelopeToGzip(sampleEnvelope);
  const progressMessages: string[] = [];

  const defenseProfile = getDeviceMemoryProfile(true);
  const decompressed = await decompressGzipToEnvelope(
    compressed.gzBytes,
    (_pct, detail) => {
      progressMessages.push(detail);
    },
    defenseProfile
  );

  assert.equal(decompressed.fingerprint, 'test_defense_001');
  assert.ok(progressMessages.length > 0);
  // Verify defense mode badge prefix is present
  const hasBadge = progressMessages.some((msg) => msg.includes('🛡️ [低内存防御模式]'));
  assert.equal(hasBadge, true);
});
