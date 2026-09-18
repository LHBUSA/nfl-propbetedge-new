/* A local static + api server, for visual gates that must not hit production.
 *
 *   node scripts/local-serve.mjs [--port=8899]
 *
 * Serves the repository root as the deployment does, and routes /api/<name> to
 * the default export of api/<name>.js with the same (req, res) shape Vercel
 * gives it. It exists so a screenshot gate can exercise the real handler and
 * the real dataset rather than a mock, without the Vercel CLI and without
 * reaching the live site.
 *
 * Development only. Never imported by anything the product ships.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();
const PORT = Number((process.argv.find(a => a.startsWith('--port=')) || '--port=8899').split('=')[1]);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webp': 'image/webp',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let path = decodeURIComponent(url.pathname);

  if (path.startsWith('/api/')) {
    const name = path.slice(5).replace(/\/$/, '');
    // Guard the obvious traversal before it becomes an import.
    if (!/^[a-z0-9\-/]+$/i.test(name) || name.includes('..')) {
      res.statusCode = 400; res.end('{"error":"bad_api_path"}'); return;
    }
    try {
      const mod = await import(pathToFileURL(join(REPO, 'api', `${name}.js`)).href);
      const query = Object.fromEntries(url.searchParams);
      await mod.default({ method: req.method, query, url: req.url, headers: req.headers }, res);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'handler_failed', detail: String(error.message || error) }));
    }
    return;
  }

  if (path === '/' || path === '') path = '/index.html';
  const file = normalize(join(REPO, path));
  if (!file.startsWith(REPO)) { res.statusCode = 403; res.end('forbidden'); return; }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.statusCode = 200;
    res.setHeader('content-type', TYPES[extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});

server.listen(PORT, () => console.log(`local-serve on http://localhost:${PORT}`));
