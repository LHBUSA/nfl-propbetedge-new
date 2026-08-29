import { getNflSession, verifiedEmail } from './_nfl-auth.js';

const UPSTREAM = 'https://nfl-api.propbetedge.ai/api/picks/pass';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'private, no-store, max-age=0');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });

  const eventId = typeof req.query?.event_id === 'string' ? req.query.event_id.trim() : '';
  if (!eventId) return send(res, 400, { error: 'event_id_required' });

  try {
    const auth = await getNflSession(req);
    const email = verifiedEmail(auth);
    if (!email) return send(res, 401, { error: 'sign_in_required', entitlement: 'nfl_pro' });
    if (auth.pro !== true) return send(res, 403, { error: 'nfl_pro_required', entitlement: 'nfl_pro' });

    const upstreamResponse = await fetch(`${UPSTREAM}?event_id=${encodeURIComponent(eventId)}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store'
    });

    const text = await upstreamResponse.text();
    res.statusCode = upstreamResponse.status;
    res.setHeader('content-type', upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'private, no-store, max-age=0');
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(text);
  } catch (error) {
    console.error('NFL Pro model gate failed', error instanceof Error ? error.message : String(error));
    return send(res, 503, { error: 'entitlement_unavailable' });
  }
}
