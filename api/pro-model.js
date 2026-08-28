const SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_YkSuX7oXCxyTTMPtPqYIyw_qtbfA5c6';
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

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return send(res, 401, { error: 'sign_in_required', entitlement: 'nfl_pro' });

  const eventId = typeof req.query?.event_id === 'string' ? req.query.event_id.trim() : '';
  if (!eventId) return send(res, 400, { error: 'event_id_required' });

  try {
    const commonHeaders = {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${token}`,
      accept: 'application/json'
    };

    const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: commonHeaders,
      cache: 'no-store'
    });

    if (!userResponse.ok) {
      return send(res, 401, { error: 'invalid_session', entitlement: 'nfl_pro' });
    }

    const accessResponse = await fetch(`${SUPABASE_URL}/rest/v1/rpc/nfl_has_pro_access`, {
      method: 'POST',
      headers: {
        ...commonHeaders,
        'content-type': 'application/json'
      },
      body: '{}',
      cache: 'no-store'
    });

    if (!accessResponse.ok) {
      const detail = await accessResponse.text().catch(() => '');
      console.error('NFL Pro entitlement RPC failed', accessResponse.status, detail.slice(0, 180));
      return send(res, 503, { error: 'entitlement_unavailable' });
    }

    const hasAccess = await accessResponse.json();
    if (hasAccess !== true) {
      return send(res, 403, { error: 'nfl_pro_required', entitlement: 'nfl_pro' });
    }

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
    return send(res, 502, { error: 'model_gate_failed' });
  }
}
