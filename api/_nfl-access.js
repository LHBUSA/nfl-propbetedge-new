/* PropBetEdge NFL — the one server-side paywall gate.
 *
 * Every paid NFL API route is wrapped with withNflEntitlement(). It reuses the
 * session verifier and the entitlement predicate, and it fails closed:
 *
 *   401  no valid identity                     x-pbe-access: anonymous
 *   403  signed in, no current NFL entitlement  x-pbe-access: no_entitlement
 *   503  entitlement authority unavailable      x-pbe-access: unavailable
 *
 * A granted response can never be shared: whatever cache policy the wrapped
 * handler sets is replaced with `private, no-store`, the response varies on
 * Cookie, and a wildcard CORS header is dropped. Without this a CDN would hand
 * one subscriber's cached `public, s-maxage` answer to an anonymous caller.
 *
 * Nothing the browser supplies decides access: not localStorage, not a query
 * parameter, not a cookie set by client script, not a "subscribed" flag. Only
 * the HttpOnly session cookie, verified here, and the NFL ledger row behind it.
 */

import { getNflSession, ACCESS } from './_nfl-auth.js';

export const PRIVATE_CACHE = 'private, no-store, max-age=0';

function write(res, status, body, access) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', PRIVATE_CACHE);
  res.setHeader('vary', 'Cookie');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-pbe-access', access);
  res.end(JSON.stringify(body));
}

/** Decide one request. Never throws. */
export async function authorizeNflRequest(req) {
  let session;
  try {
    session = await getNflSession(req, { allowCachedGrant: true });
  } catch (error) {
    return { ok: false, status: 503, access: ACCESS.unavailable, stage: 'session_exception' };
  }
  const access = session?.access;
  if (access === ACCESS.granted && session.valid === true && session.pro === true) {
    return { ok: true, status: 200, access, session };
  }
  if (access === ACCESS.none && session.valid === true) {
    return { ok: false, status: 403, access, stage: session.stage, reason: session.entitlement?.reason || 'no_subscription' };
  }
  if (access === ACCESS.anonymous && session.valid !== true && !session.degraded) {
    return { ok: false, status: 401, access, stage: session.stage };
  }
  /* degraded, unknown, or internally inconsistent: never grant */
  return { ok: false, status: 503, access: ACCESS.unavailable, stage: session?.stage || 'unknown' };
}

export function denyNflRequest(res, decision) {
  if (decision.status === 401) {
    return write(res, 401, { error: 'sign_in_required', access: ACCESS.anonymous, product: 'nfl', entitlement: 'nfl_subscription' }, ACCESS.anonymous);
  }
  if (decision.status === 403) {
    return write(res, 403, { error: 'nfl_subscription_required', access: ACCESS.none, product: 'nfl', reason: decision.reason }, ACCESS.none);
  }
  return write(res, 503, { error: 'entitlement_unavailable', access: ACCESS.unavailable, product: 'nfl', stage: decision.stage }, ACCESS.unavailable);
}

/* From here on the handler may set any header it likes; caching and CORS are
   pinned to private, same-origin semantics. */
function privatize(res) {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    const key = String(name).toLowerCase();
    if (key === 'cache-control') return setHeader(name, PRIVATE_CACHE);
    if (key === 'access-control-allow-origin' || key === 'access-control-allow-credentials') return res;
    if (key === 'vary') return setHeader(name, /cookie/i.test(String(value)) ? value : `${value}, Cookie`);
    return setHeader(name, value);
  };
  setHeader('cache-control', PRIVATE_CACHE);
  setHeader('vary', 'Cookie');
  setHeader('x-pbe-access', ACCESS.granted);
  return res;
}

/**
 * Wrap a paid route. `isPublic(req)` may exempt an explicitly public variant
 * of a route (for example PBE Picks' locked preview, which carries no
 * selections); everything else requires a current NFL entitlement.
 */
export function withNflEntitlement(handler, { isPublic = null } = {}) {
  return async function nflEntitled(req, res) {
    if (typeof isPublic === 'function' && isPublic(req) === true) return handler(req, res);
    const decision = await authorizeNflRequest(req);
    if (!decision.ok) return denyNflRequest(res, decision);
    privatize(res);
    req.nflSession = decision.session;
    return handler(req, res);
  };
}
