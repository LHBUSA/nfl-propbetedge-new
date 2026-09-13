/* PropBetEdge NFL — the passing model for one event (Pro).
 * Gated by the one NFL entitlement check (api/_nfl-access.js); the upstream
 * read carries the server-only gateway token. */
import { withNflEntitlement } from './_nfl-access.js';
import { gatewayBase, gatewayHeaders } from './_nfl-gateway.js';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'private, no-store, max-age=0');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}

async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });

  const eventId = typeof req.query?.event_id === 'string' ? req.query.event_id.trim() : '';
  if (!eventId) return send(res, 400, { error: 'event_id_required' });

  try {
    const upstreamResponse = await fetch(`${gatewayBase()}/api/picks/pass?event_id=${encodeURIComponent(eventId)}`, {
      headers: gatewayHeaders({ accept: 'application/json' }),
      cache: 'no-store'
    });

    const text = await upstreamResponse.text();
    res.statusCode = upstreamResponse.status;
    res.setHeader('content-type', upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'private, no-store, max-age=0');
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(text);
  } catch (error) {
    console.error('NFL Pro model upstream failed', error instanceof Error ? error.message : String(error));
    return send(res, 503, { error: 'model_unavailable' });
  }
}

export { handler };
export default withNflEntitlement(handler);
