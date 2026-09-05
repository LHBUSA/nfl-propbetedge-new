/* Minimal local server: static files + the QB DNA API routes.
 * node scripts/qbdna-dev-server.mjs [port]
 * Mirrors Vercel's file-routing for /api/** so the UI can be exercised offline.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const PORT = Number(process.argv[2] || 4321);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const API = {
  '/api/qb-dna': 'api/qb-dna.js',
  '/api/qb-dna/prop-history': 'api/qb-dna/prop-history.js',
  '/api/qb-dna/compare': 'api/qb-dna/compare.js',
  '/api/qb-dna/game-context': 'api/qb-dna/game-context.js'
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const handlerPath = API[url.pathname];

  if (handlerPath) {
    try {
      const mod = await import(pathToFileURL(resolve(ROOT, handlerPath)).href);
      const query = Object.fromEntries(url.searchParams);
      await mod.default({ query, method: req.method, url: req.url }, res);
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'handler_threw', detail: String(e && e.stack || e) }));
    }
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: 'not_implemented_locally', path: url.pathname }));
  }

  let file = join(ROOT, decodeURIComponent(url.pathname));
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = join(file, 'index.html');
  } catch { file = join(ROOT, 'index.html'); }   // SPA fallback
  try {
    const buf = await readFile(file);
    res.setHeader('content-type', TYPES[extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(PORT, () => console.log(`qbdna dev server on http://localhost:${PORT}/#qbdna`));
