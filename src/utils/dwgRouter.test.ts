import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBuiltinFetchUrl,
  buildDwgRouteUrl,
  isDefaultSamplesWorkspaceDir,
  normalizeMinioObjectPath,
  parseDwgRouteFromLocation,
} from './dwgRouter';

test('parseDwgRouteFromLocation falls back to home mode on root or unknown paths', () => {
  assert.deepEqual(parseDwgRouteFromLocation('/', ''), { mode: 'home' });
  assert.deepEqual(parseDwgRouteFromLocation('', ''), { mode: 'home' });
  assert.deepEqual(parseDwgRouteFromLocation('/unknown/route', ''), { mode: 'home' });
  assert.deepEqual(parseDwgRouteFromLocation('/builtin', ''), { mode: 'home' });
  assert.deepEqual(parseDwgRouteFromLocation('/minio', ''), { mode: 'home' });
  assert.deepEqual(parseDwgRouteFromLocation('/local', ''), { mode: 'home' });
});

test('parseDwgRouteFromLocation and buildDwgRouteUrl handle builtin mode and custom workspace dir', () => {
  const route1 = parseDwgRouteFromLocation(
    '/builtin/' + encodeURIComponent('示例图纸一.dwg'),
    ''
  );
  assert.deepEqual(route1, {
    mode: 'builtin',
    filePath: '示例图纸一.dwg',
    workspaceDir: undefined,
  });
  assert.equal(
    buildDwgRouteUrl(route1),
    '/builtin/' + encodeURIComponent('示例图纸一.dwg')
  );
  assert.equal(buildBuiltinFetchUrl('示例图纸一.dwg'), '/samples/示例图纸一.dwg');

  // With custom workspace directory
  const customDir = 'D:\\CAD_Drawings\\2026';
  const route2 = parseDwgRouteFromLocation(
    '/builtin/' + encodeURIComponent('canteen.dwg'),
    `?dir=${encodeURIComponent(customDir)}`
  );
  assert.deepEqual(route2, {
    mode: 'builtin',
    filePath: 'canteen.dwg',
    workspaceDir: customDir,
  });
  assert.equal(
    buildDwgRouteUrl(route2),
    `/builtin/canteen.dwg?dir=${encodeURIComponent(customDir)}`
  );
  assert.equal(
    buildBuiltinFetchUrl('canteen.dwg', customDir),
    `/api/workspace/file?name=canteen.dwg&dir=${encodeURIComponent(customDir)}`
  );
});

test('parseDwgRouteFromLocation and buildDwgRouteUrl handle minio mode and custom endpoint', () => {
  const encodedPath =
    '/minio/drawings/dwg/' + encodeURIComponent('示例总平面图.dwg');
  const route1 = parseDwgRouteFromLocation(encodedPath, '');
  assert.deepEqual(route1, {
    mode: 'minio',
    filePath: 'drawings/dwg/示例总平面图.dwg',
    minioEndpoint: undefined,
  });
  assert.equal(buildDwgRouteUrl(route1), encodedPath);

  const customEndpoint = 'http://storage.example.invalid:9000';
  const route2 = parseDwgRouteFromLocation(
    encodedPath,
    `?endpoint=${encodeURIComponent(customEndpoint)}`
  );
  assert.deepEqual(route2, {
    mode: 'minio',
    filePath: 'drawings/dwg/示例总平面图.dwg',
    minioEndpoint: customEndpoint,
  });
  assert.equal(
    buildDwgRouteUrl(route2),
    `${encodedPath}?endpoint=${encodeURIComponent(customEndpoint)}`
  );
});

test('parseDwgRouteFromLocation and buildDwgRouteUrl handle local mode with fingerprint', () => {
  const fp = 'dwg_v2_69414024_a1b2c3d4_e5f60718';
  const route = parseDwgRouteFromLocation(
    '/local/' + encodeURIComponent('示例图集.dwg'),
    `?fp=${fp}`
  );
  assert.deepEqual(route, {
    mode: 'local',
    filePath: '示例图集.dwg',
    fingerprint: fp,
  });
  assert.equal(
    buildDwgRouteUrl(route),
    `/local/${encodeURIComponent('示例图集.dwg')}?fp=${fp}`
  );
});

test('parseDwgRouteFromLocation supports legacy query params and Electron hash routes', () => {
  const legacySample = parseDwgRouteFromLocation(
    '/',
    '?url=%2Fsamples%2Fcanteen.dwg'
  );
  assert.deepEqual(legacySample, {
    mode: 'builtin',
    filePath: 'canteen.dwg',
  });

  const legacyMinio = parseDwgRouteFromLocation(
    '/',
    '?minioUrl=drawings%2Fdwg%2F%E7%A4%BA%E4%BE%8B%E6%80%BB%E5%B9%B3%E9%9D%A2%E5%9B%BE.dwg'
  );
  assert.deepEqual(legacyMinio, {
    mode: 'minio',
    filePath: 'drawings/dwg/示例总平面图.dwg',
    minioEndpoint: undefined,
  });

  const electronHash = parseDwgRouteFromLocation(
    '/C:/app/index.html',
    '',
    '#/builtin/canteen.dwg?dir=D%3A%5CCAD'
  );
  assert.deepEqual(electronHash, {
    mode: 'builtin',
    filePath: 'canteen.dwg',
    workspaceDir: 'D:\\CAD',
  });
});

test('isDefaultSamplesWorkspaceDir and normalizeMinioObjectPath utility checks', () => {
  assert.equal(isDefaultSamplesWorkspaceDir(undefined), true);
  assert.equal(isDefaultSamplesWorkspaceDir('public/samples'), true);
  assert.equal(isDefaultSamplesWorkspaceDir('D:\\DWG-viewer\\public\\samples'), true);
  assert.equal(isDefaultSamplesWorkspaceDir('/opt/dwg-viewer/public/samples'), true);
  assert.equal(isDefaultSamplesWorkspaceDir('D:\\DWG-viewer'), false);
  assert.equal(isDefaultSamplesWorkspaceDir('D:\\CAD图纸'), false);

  assert.equal(
    normalizeMinioObjectPath('/api/minio/stream?path=drawings%2Fdwg%2F01.dwg'),
    'drawings/dwg/01.dwg'
  );
  assert.equal(normalizeMinioObjectPath('dwg/02.dwg'), 'dwg/02.dwg');
  assert.equal(normalizeMinioObjectPath('dwg/02.dwg', 'drawings'), 'drawings/dwg/02.dwg');
});
