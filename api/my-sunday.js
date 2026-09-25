/* My Sunday — the session boundary (pbe-my-sunday/v1).
 *
 *   GET  /api/my-sunday                      saved items + alerts
 *   POST /api/my-sunday?op=save    {item}
 *   POST /api/my-sunday?op=remove  {item_key}
 *   POST /api/my-sunday?op=import  {items}   explicit device import only
 *   POST /api/my-sunday?op=read    {ids}     mark alerts read
 *
 * WHO. Ownership comes from the verified NFL session (getNflSession — the one
 * session authority), never from the request: the owner key is an HMAC of the
 * verified email under MY_SUNDAY_OWNER_SECRET, so the storage Worker never
 * sees an email and no client value can name another account. Saving research
 * is an NFL Pro / All Access / Owner capability (access === 'granted'): the NFL
 * auth path only issues sessions to entitled readers — a verified email
 * without an entitlement is paywalled and its cookie cleared — so there is no
 * signed-in free state to serve. Signed-out readers keep a device-only list in
 * the browser, and moving it into an account is an explicit import.
 *
 * WRITES are POST only, must carry `content-type: application/json` and
 * `x-pbe-csrf: 1` (neither can be sent cross-site without a preflight this
 * endpoint never grants), and must come from this host's own Origin. The
 * session cookie is SameSite=Lax as well.
 *
 * CACHE. Every answer is private, no-store, and varies on Cookie.
 *
 * FLAG. MY_SUNDAY_ENABLED must be '1'; otherwise 404 feature_disabled and the
 * client hides every My Sunday control.
 */
import { createHmac } from 'node:crypto';
import { getNflSession, verifiedEmail } from './_nfl-auth.js';

const TIMEOUT_MS = 8000;
const OPS = { save: '/v1/items', remove: '/v1/items/delete', import: '/v1/import', read: '/v1/alerts/read' };

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'private, no-store, max-age=0');
  res.setHeader('vary', 'Cookie');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export function ownerKey(email, secret) {
  return createHmac('sha256', secret).update(`nfl-my-sunday:v1:${String(email).trim().toLowerCase()}`).digest('hex');
}

/* Same-origin proof for a cookie-authenticated write. */
export function csrfOk(req) {
  const h = req.headers || {};
  if (String(h['x-pbe-csrf'] || '') !== '1') return false;
  if (!/^application\/json\b/i.test(String(h['content-type'] || ''))) return false;
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim().toLowerCase();
  const origin = String(h.origin || '');
  if (!host || !origin) return false;
  try { return new URL(origin).host.toLowerCase() === host; } catch (_) { return false; }
}

export function accessDenial(session) {
  if (session.access === 'granted' && verifiedEmail(session)) return null;
  if (session.access === 'unavailable') return { status: 503, error: 'access_check_unavailable' };
  if (session.access === 'no_entitlement') return { status: 403, error: 'nfl_pro_required' };
  return { status: 401, error: 'sign_in_required' };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) { return null; } }
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 65536) return null; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { return null; }
}

export default async function handler(req, res, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || fetch;
  const session = deps.session || getNflSession;
  if (env.MY_SUNDAY_ENABLED !== '1') return send(res, 404, { error: 'feature_disabled' });
  if (req.method !== 'GET' && req.method !== 'POST') { res.setHeader('allow', 'GET, POST'); return send(res, 405, { error: 'method_not_allowed' }); }

  const op = String(req.query?.op || '');
  if (req.method === 'POST') {
    if (!OPS[op]) return send(res, 400, { error: 'unknown_op' });
    if (!csrfOk(req)) return send(res, 403, { error: 'csrf_rejected' });
  }

  const s = await session(req);
  const denied = accessDenial(s);
  if (denied) return send(res, denied.status, { error: denied.error, access: s.access });

  const origin = String(env.MY_SUNDAY_ORIGIN || '');
  const token = String(env.MY_SUNDAY_INTERNAL_TOKEN || '');
  const secret = String(env.MY_SUNDAY_OWNER_SECRET || '');
  if (!origin || !token || secret.length < 32) return send(res, 503, { error: 'my_sunday_not_configured' });

  let payload = null;
  if (req.method === 'POST') {
    payload = await readBody(req);
    if (!payload || typeof payload !== 'object') return send(res, 400, { error: 'bad_json' });
    /* Anything that looks like an identity claim is dropped, not trusted. */
    delete payload.owner; delete payload.owner_key; delete payload.email; delete payload.account_id;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(new URL(req.method === 'GET' ? '/v1/items' : OPS[op], origin).toString(), {
      method: req.method,
      headers: { authorization: `Bearer ${token}`, 'x-pbe-owner': ownerKey(verifiedEmail(s), secret), 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'pbe-nfl-web/my-sunday' },
      body: req.method === 'POST' ? JSON.stringify(payload) : undefined,
      signal: ctl.signal
    });
    const text = await r.text();
    if (r.status >= 500) return send(res, 503, { error: 'my_sunday_unavailable' });
    return send(res, r.status, text);
  } catch (error) {
    return send(res, 503, { error: error?.name === 'AbortError' ? 'my_sunday_timeout' : 'my_sunday_unreachable' });
  } finally {
    clearTimeout(timer);
  }
}
