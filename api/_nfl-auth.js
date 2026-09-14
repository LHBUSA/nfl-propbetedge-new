/* PropBetEdge NFL — single session authority.
 *
 * ONE cookie name, ONE scope, ONE verifier.
 *
 * Identity != entitlement. The session cookie proves who the reader is. Access
 * to the paid NFL product is decided only by a verifiable NFL purchase
 * (_nfl-entitlement.js). Every session reports `access`:
 *
 *   anonymous       no usable session
 *   no_entitlement  signed in, no current verified NFL purchase
 *   unavailable     the entitlement authority could not answer (fail closed)
 *   granted         signed in with a current verified NFL purchase, or the
 *                   verified owner account
 *
 * Owner access. The owner designation lives in trusted server configuration
 * (NFL_OWNER_EMAILS on the Vercel project), never in the browser. It applies
 * only to a session the auth Worker issued after a Resend-delivered, single-
 * use magic link proved mailbox ownership; the session's verified email is the
 * account principal in this auth system. Typing the email, a request field, a
 * client cookie or storage value grants nothing. Admin routes keep their own
 * tokens and never honour the owner role.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { selectNflEntitlement, ilikeLiteral, NFL_PRODUCT } from './_nfl-entitlement.js';

const DEFAULT_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';

export const SESSION_COOKIE = 'pbe_nfl_session_v2';
export const LEGACY_SESSION_COOKIE = 'pbe_nfl_session';
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
export const HMAC_NAMESPACE = 'pbe-nfl-auth-v5';

export function readCookieValues(header, name) {
  const out = [];
  for (const part of String(header || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    const value = trimmed.slice(eq + 1);
    if (value) out.push(value);
  }
  return out;
}

export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

export function purgeCookies({ includeCurrent = false } = {}) {
  const names = includeCurrent ? [SESSION_COOKIE, LEGACY_SESSION_COOKIE] : [LEGACY_SESSION_COOKIE];
  const out = [];
  for (const name of names) {
    out.push(`${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    out.push(`${name}=; Domain=.propbetedge.ai; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  }
  return out;
}

function decodeBase64Url(value) {
  let s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

export function verifyWorkerJwt(token, secret, expectedType = 'session') {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('token_shape');
  const data = `${parts[0]}.${parts[1]}`;
  const actual = decodeBase64Url(parts[2]);
  const expected = createHmac('sha256', `${HMAC_NAMESPACE}:${secret}`).update(data).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('token_signature');

  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(parts[1]).toString('utf8'));
  } catch (_) {
    throw new Error('token_payload');
  }
  if (payload?.type !== expectedType) throw new Error('token_type');
  if (!payload?.exp || Math.floor(Date.now() / 1000) >= Number(payload.exp)) throw new Error('token_expired');

  if (expectedType !== 'session') return payload;
  const email = String(payload?.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('token_email');
  return { ...payload, email };
}

/* Session signing is deliberately separate from database authorization.
 * Until NFL_SESSION_SIGNING_SECRET is configured on BOTH Vercel and the auth
 * Worker, the existing service-role key remains the primary signing key.
 * After cutover, the service-role key stays verify-only as a migration fallback
 * so existing 30-day sessions and recently issued magic links keep working. */
export function getSessionSigningSecrets() {
  const dedicated = String(process.env.NFL_SESSION_SIGNING_SECRET || '').trim();
  const legacy = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return {
    primary: dedicated || legacy,
    fallback: dedicated && legacy && dedicated !== legacy ? legacy : '',
    mode: dedicated ? 'dedicated' : 'legacy_service_role',
    dedicatedConfigured: Boolean(dedicated),
    legacyConfigured: Boolean(legacy),
  };
}

export function verifyWorkerJwtWithSecrets(token, secrets, expectedType = 'session') {
  const candidates = [secrets?.primary, secrets?.fallback].filter(Boolean);
  let reason = 'token_invalid';
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      return {
        payload: verifyWorkerJwt(token, candidates[i], expectedType),
        matched: i === 0 ? 'primary' : 'fallback',
      };
    } catch (error) {
      reason = error?.message || reason;
    }
  }
  throw new Error(reason);
}

/* Supabase's modern sb_secret_* keys are API keys, not JWTs. They must be sent
 * on `apikey` only. Legacy service_role JWTs still use both apikey and Bearer.
 * This lets the NFL backend migrate keys without breaking PostgREST. */
export function supabaseAdminHeaders(secret) {
  const key = String(secret || '').trim();
  const headers = { apikey: key, accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  return headers;
}

/* The rows for one email, from the NFL ledger only. Other sports' ledgers
 * (MLB pbe_subscribers, UFC, NBA, NHL) are never consulted, and a row here
 * still has to carry a recognized NFL price to count. */
async function nflSubscriptionRows(email, secret) {
  const base = String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
  const select = 'status,customer_email,current_period_end,cancel_at_period_end,stripe_price_id,stripe_subscription_id,stripe_customer_id,stripe_checkout_session_id,created_at';
  const q = `customer_email=ilike.${encodeURIComponent(ilikeLiteral(email))}&select=${select}&order=created_at.desc&limit=25`;
  const response = await fetch(`${base}/rest/v1/nfl_subscriptions?${q}`, {
    headers: supabaseAdminHeaders(secret),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`entitlement_${response.status}`);
  const rows = await response.json().catch(() => { throw new Error('entitlement_bad_json'); });
  if (!Array.isArray(rows)) throw new Error('entitlement_bad_shape');
  return rows;
}

/* Positive grants only, per warm function instance, for data routes that are
 * called many times per page. A denial or a failure is never cached, and any
 * fresh lookup that denies clears the entry, so /api/auth-session (always
 * fresh) revokes it for this instance immediately. */
const GRANT_CACHE_MS = 60 * 1000;
const grantCache = new Map();
export function clearEntitlementCache() { grantCache.clear(); }

async function entitlementByEmail(email, secret, { allowCachedGrant = false } = {}) {
  const now = Date.now();
  if (allowCachedGrant) {
    const hit = grantCache.get(email);
    if (hit && hit.expires > now && Date.parse(hit.entitlement.current_period_end) > now) return { ...hit.entitlement, cached: true };
  }
  const rows = await nflSubscriptionRows(email, secret);
  const entitlement = selectNflEntitlement(rows, email, Date.now());
  if (entitlement.entitled) grantCache.set(email, { expires: now + GRANT_CACHE_MS, entitlement });
  else grantCache.delete(email);
  return entitlement;
}

export function ownerEmails() {
  return String(process.env.NFL_OWNER_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}
export function isOwnerEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return Boolean(e) && ownerEmails().includes(e);
}

const SIGNED_OUT = {
  valid: false, pro: false, access: 'anonymous', entitlement: null, user: null, subscription: null,
  authority: 'vercel-local', degraded: false,
};

export const ACCESS = Object.freeze({ anonymous: 'anonymous', none: 'no_entitlement', unavailable: 'unavailable', granted: 'granted' });

export async function getNflSession(req, { allowCachedGrant = false } = {}) {
  const header = req.headers?.cookie || '';
  const current = readCookieValues(header, SESSION_COOKIE);
  const legacy = readCookieValues(header, LEGACY_SESSION_COOKIE);
  const cookies = { current: current.length, legacy: legacy.length };

  if (!current.length && !legacy.length) {
    return { ...SIGNED_OUT, stage: 'no_cookie', cookies };
  }

  const signing = getSessionSigningSecrets();
  if (!signing.primary) {
    return {
      ...SIGNED_OUT, access: ACCESS.unavailable, stage: 'secret_missing', cookies,
      degraded: true, error: 'session_secret_not_configured',
    };
  }

  let payload = null;
  let reason = '';
  let signatureSource = null;
  for (const token of [...current, ...legacy]) {
    try {
      const verified = verifyWorkerJwtWithSecrets(token, signing, 'session');
      payload = verified.payload;
      signatureSource = verified.matched;
      break;
    } catch (error) {
      reason = error?.message || 'token_invalid';
    }
  }

  if (!payload) {
    return { ...SIGNED_OUT, stage: 'cookie_present_invalid', cookies, reason };
  }

  if (isOwnerEmail(payload.email)) {
    return {
      valid: true, pro: true, access: ACCESS.granted, role: 'owner',
      entitlement: { product: NFL_PRODUCT, entitled: true, reason: 'owner', plan: 'owner', billing: 'owner', status: 'owner', expires_at: null },
      user: { email: payload.email }, subscription: null,
      authority: 'vercel-local', stage: 'owner_verified', cookies, degraded: false,
      signing: { mode: signing.mode, verified_by: signatureSource },
    };
  }

  const entitlementSecret = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!entitlementSecret) {
    return {
      valid: true, pro: false, access: ACCESS.unavailable, entitlement: null, user: { email: payload.email }, subscription: null,
      authority: 'vercel-local', stage: 'entitlement_secret_missing', cookies,
      degraded: true, error: 'entitlement_secret_not_configured',
      signing: { mode: signing.mode, verified_by: signatureSource },
    };
  }

  let entitlement = null;
  try {
    entitlement = await entitlementByEmail(payload.email, entitlementSecret, { allowCachedGrant });
  } catch (error) {
    return {
      valid: true, pro: false, access: ACCESS.unavailable, entitlement: null, user: { email: payload.email }, subscription: null,
      authority: 'vercel-local', stage: 'entitlement_lookup_failed', cookies,
      degraded: true, error: String(error?.message || 'entitlement_unavailable'),
      signing: { mode: signing.mode, verified_by: signatureSource },
    };
  }

  const granted = entitlement?.entitled === true;
  return {
    valid: true,
    pro: granted,
    access: granted ? ACCESS.granted : ACCESS.none,
    entitlement: {
      product: NFL_PRODUCT,
      entitled: granted,
      reason: entitlement?.reason || 'no_subscription',
      plan: entitlement?.plan || null,
      billing: granted ? entitlement.billing : null,
      status: entitlement?.status || null,
      expires_at: granted ? entitlement.current_period_end : null,
    },
    user: { email: payload.email },
    subscription: granted ? {
      status: entitlement.status,
      current_period_end: entitlement.current_period_end,
      cancel_at_period_end: entitlement.cancel_at_period_end,
      stripe_price_id: entitlement.stripe_price_id,
    } : null,
    authority: 'vercel-local',
    stage: granted ? 'entitlement_active' : 'entitlement_missing',
    cookies,
    degraded: false,
    signing: { mode: signing.mode, verified_by: signatureSource },
  };
}

export function verifiedEmail(session) {
  const email = String(session?.user?.email || '').trim().toLowerCase();
  return session?.valid && /^\S+@\S+\.\S+$/.test(email) ? email : '';
}
