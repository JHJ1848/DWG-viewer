import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDwgFileName,
  inspectDwgHeader,
  formatByteSize,
  extractFileNameFromUrl,
  resolveMinioDwgUrl,
} from './dwgValidation.ts';

test('validateDwgFileName strictly accepts .dwg and rejects non-dwg extensions', () => {
  assert.equal(validateDwgFileName('示例总平面图.dwg').valid, true);
  assert.equal(validateDwgFileName('SITE_PLAN.DWG').valid, true);
  assert.equal(validateDwgFileName('building.rvt').valid, false);
  assert.equal(validateDwgFileName('drawing.dxf').valid, false);
  assert.equal(validateDwgFileName('').valid, false);
});

test('inspectDwgHeader identifies AutoCAD AC10xx binary signatures', () => {
  const ac1027 = new Uint8Array([0x41, 0x43, 0x31, 0x30, 0x32, 0x37, 0x00, 0x00]);
  const info = inspectDwgHeader(ac1027);
  assert.equal(info.isDwg, true);
  assert.equal(info.versionCode, 'AC1027');
  assert.equal(info.versionLabel, 'AutoCAD 2013/2017 DWG');

  const invalid = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
  assert.equal(inspectDwgHeader(invalid).isDwg, false);
});

test('formatByteSize formats KB and MB accurately', () => {
  assert.equal(formatByteSize(52743372), '50.30 MB');
  assert.equal(formatByteSize(92160), '90.0 KB');
  assert.equal(formatByteSize(0), '0 B');
});

test('extractFileNameFromUrl extracts .dwg file name from MinIO presigned and stream URLs', () => {
  assert.equal(
    extractFileNameFromUrl(
      'http://storage.example.invalid:9000/drawings/dwg/%E6%80%BB%E5%B9%B3%E5%9B%BE.dwg?X-Amz-Signature=abc123'
    ),
    '总平图.dwg'
  );
  assert.equal(
    extractFileNameFromUrl('/samples/canteen.dwg'),
    'canteen.dwg'
  );
  assert.equal(
    extractFileNameFromUrl('https://api.internal/files/download/9921'),
    '9921.dwg'
  );
  assert.equal(
    extractFileNameFromUrl(
      '/api/minio/stream?path=drawings%2Fdwg%2F%E7%A4%BA%E4%BE%8B%E6%80%BB%E5%B9%B3%E9%9D%A2%E5%9B%BE.dwg'
    ),
    '示例总平面图.dwg'
  );
});

test('resolveMinioDwgUrl normalizes relative paths, MinIO console URLs, and S3 direct URLs', () => {
  assert.equal(
    resolveMinioDwgUrl('/samples/canteen.dwg'),
    '/samples/canteen.dwg'
  );
  assert.equal(
    resolveMinioDwgUrl('samples/canteen.dwg'),
    '/samples/canteen.dwg'
  );
  assert.equal(
    resolveMinioDwgUrl('drawings/dwg/01.dwg'),
    '/api/minio/stream?path=drawings%2Fdwg%2F01.dwg'
  );
  assert.equal(
    resolveMinioDwgUrl('http://storage.example.invalid:9090/browser/drawings/dwg%2F01.dwg'),
    '/api/minio/stream?path=drawings%2Fdwg%2F01.dwg'
  );
  assert.equal(
    resolveMinioDwgUrl('http://storage.example.invalid:9000/drawings/dwg/01.dwg'),
    '/api/minio/stream?path=drawings%2Fdwg%2F01.dwg'
  );
  assert.equal(
    resolveMinioDwgUrl('/api/minio/stream?path=drawings%2Fdwg%2F01.dwg'),
    '/api/minio/stream?path=drawings%2Fdwg%2F01.dwg'
  );
});


