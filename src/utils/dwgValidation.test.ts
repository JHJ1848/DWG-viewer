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
  assert.equal(validateDwgFileName('01俄洛镇格巴村总平图.dwg').valid, true);
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

test('extractFileNameFromUrl extracts .dwg file name from MinIO presigned and internal URLs', () => {
  assert.equal(
    extractFileNameFromUrl(
      'http://192.168.1.50:9000/cad-bucket/2026/%E6%80%BB%E5%B9%B3%E5%9B%BE.dwg?X-Amz-Signature=abc123'
    ),
    '总平图.dwg'
  );
  assert.equal(
    extractFileNameFromUrl('/samples/baseline-sample.dwg'),
    'baseline-sample.dwg'
  );
  assert.equal(
    extractFileNameFromUrl('https://api.internal/spring/files/download/9921'),
    '9921.dwg'
  );
  assert.equal(
    extractFileNameFromUrl(
      'http://192.168.81.163:9008/api/minio/get_file?path=nonglintu/dwg/01%E4%BF%84%E6%B4%9B%E9%95%87%E6%A0%BC%E5%B7%B4%E6%9D%91%E6%80%BB%E5%B9%B3%E5%9B%BE.dwg'
    ),
    '01俄洛镇格巴村总平图.dwg'
  );
});

test('resolveMinioDwgUrl normalizes relative paths, console URLs, and legacy URLs', () => {
  assert.equal(
    resolveMinioDwgUrl('/samples/baseline-sample.dwg'),
    '/samples/baseline-sample.dwg'
  );
  assert.equal(
    resolveMinioDwgUrl('samples/canteen.dwg'),
    '/samples/canteen.dwg'
  );
  assert.equal(
    resolveMinioDwgUrl('nonglintu/dwg/01.dwg'),
    'http://192.168.81.163:9008/api/minio/get_file?path=nonglintu%2Fdwg%2F01.dwg&preview=true&inline=true'
  );
  assert.equal(
    resolveMinioDwgUrl('http://minio:9090/browser/nonglintu/dwg%2F01.dwg'),
    'http://192.168.81.163:9008/api/minio/get_file?path=nonglintu%2Fdwg%2F01.dwg&preview=true&inline=true'
  );
  assert.equal(
    resolveMinioDwgUrl('http://192.168.81.163:9008/api/feqi/minio/get_file?path=test.dwg'),
    'http://192.168.81.163:9008/api/minio/get_file?path=test.dwg&preview=true&inline=true'
  );
});


