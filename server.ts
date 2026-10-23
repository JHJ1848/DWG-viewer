import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const CACHE_DIR = path.resolve(__dirname, '.cache', 'dwg-gzip');
const INDEX_FILE = path.join(CACHE_DIR, 'index.json');
const MAX_SERVER_CACHE_ENTRIES = 30;

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

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
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

async function startServer() {
  ensureCacheDir();
  const app = express();

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

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[DWG Viewer Server] Running on http://0.0.0.0:${PORT} (Shared Gzip Cache: ${CACHE_DIR})`);
  });
}

void startServer();
