/* PropBetEdge NFL — same-origin gateway data route (BFF).
 *
 *   browser ── /api/gw/<gateway path> ──> this function
 *     public paths (market snapshot, best line, changes, season …): forwarded
 *     premium paths (PREMIUM_GATEWAY_ROUTES — the PBE passing model):
 *       1. verify the HttpOnly NFL session            (401)
 *       2. verify a current NFL entitlement or owner   (403 / 503, fail closed)
 *     then an allow-listed GET goes to nfl-api.propbetedge.ai with the
 *     server-only gateway token
 *
 * vercel.json rewrites /api/gw/:path* here as ?__gw_path=:path*. The browser
 * never holds the gateway token or any service credential; responses are
 * private and never cached by a shared cache.
 *
 * Only read routes the product actually renders are forwarded. Admin and
 * maintenance routes (odds ingest, snapshot internals, current/refresh,
 * intel run) are not reachable through here at all.
 */

import { withNflEntitlement, PRIVATE_CACHE } from './_nfl-access.js';
import { gatewayBase, gatewayHeaders } from './_nfl-gateway.js';

export const GATEWAY_READ_ROUTES = Object.freeze([
  /^\/api\/odds$/,
  /^\/api\/odds\/board$/,
  /^\/api\/odds\/events$/,
  /^\/api\/odds\/prop-coverage$/,
  /^\/api\/picks\/pass$/,
  /^\/api\/best-line$/,
  /^\/api\/changes$/,
  /^\/api\/injuries$/,
  /^\/api\/season$/,
  /^\/api\/standings$/,
  /^\/api\/current-stats$/,
  /^\/api\/current-player$/,
  /^\/api\/scores$/,
  /^\/api\/schedule$/,
  /^\/api\/replay\/enrich$/,
]);

/* Proprietary model output: subscribers and the owner only. */
export const PREMIUM_GATEWAY_ROUTES = Object.freeze([/^\/api\/picks\/pass$/]);
export function isPremiumPath(path) { return Boolean(path) && PREMIUM_GATEWAY_ROUTES.some(rx => rx.test(path)); }

const UPSTREAM_TIMEOUT_MS = 15000;

function fail(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', PRIVATE_CACHE);
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}

/** The gateway path a request asks for, or null when it is not forwardable. */
export function forwardablePath(raw) {
  const value = Array.isArray(raw) ? raw.join('/') : String(raw || '');
  if (!value || value.length > 200) return null;
  let decoded;
  try { decoded = decodeURIComponent(value); } catch (_) { return null; }
  if (/[\\?#]|\.\.|\/\/|%/.test(decoded)) return null;
  const path = `/${decoded.replace(/^\/+/, '')}`.replace(/\/+$/, '');
  return GATEWAY_READ_ROUTES.some(rx => rx.test(path)) ? path : null;
}

function upstreamQuery(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (key === '__gw_path') continue;
    for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined && v !== null) params.append(key, String(v));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    return fail(res, 405, { error: 'method_not_allowed' });
  }
  const path = forwardablePath(req.query?.__gw_path);
  if (!path) return fail(res, 404, { error: 'route_not_available' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${gatewayBase()}${path}${upstreamQuery(req.query)}`, {
      method: 'GET',
      headers: gatewayHeaders({ accept: 'application/json' }),
      cache: 'no-store',
      signal: controller.signal,
    });
    const body = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    /* public reads are identical for every visitor and may be shared-cached
       briefly; a premium read is private (the gate also forces this) */
    res.setHeader('cache-control', isPremiumPath(path) || upstream.status !== 200 ? PRIVATE_CACHE : 'public, max-age=30, s-maxage=60');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-pbe-gateway-path', path);
    return res.end(req.method === 'HEAD' ? '' : body);
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return fail(res, aborted ? 504 : 502, { error: aborted ? 'gateway_timeout' : 'gateway_unreachable', path });
  } finally {
    clearTimeout(timer);
  }
}

export default withNflEntitlement(handler, { isPublic: req => !isPremiumPath(forwardablePath(req.query?.__gw_path)) });
