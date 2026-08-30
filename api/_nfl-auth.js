/* PropBetEdge NFL — single session authority.
 *
 * ONE cookie name, ONE scope, ONE verifier.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

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

async function entitlementByEmail(email, secret) {
  const base = String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
  const q = `customer_email=ilike.${encodeURIComponent(email)}&select=status,current_period_end,cancel_at_period_end,stripe_price_id,created_at&order=created_at.desc&limit=10`;
  const response = await fetch(`${base}/rest/v1/nfl_subscriptions?${q}`, {
    headers: supabaseAdminHeaders(secret),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`entitlement_${response.status}`);
  const rows = await response.json().catch(() => []);
  const now = Date.now();
  const row = (Array.isArray(rows) ? rows : []).find(item => {
    const status = String(item?.status || '').toLowerCase();
    return ['active', 'trialing'].includes(status)
      && (!item?.current_period_end || Date.parse(item.current_period_end) > now);
  });
  return row ? {
    status: row.status,
    current_period_end: row.current_period_end || null,
    cancel_at_period_end: Boolean(row.cancel_at_period_end),
    stripe_price_id: row.stripe_price_id || null,
  } : null;
}

const SIGNED_OUT = {
  valid: false, pro: false, user: null, subscription: null,
  authority: 'vercel-local', degraded: false,
};

export async function getNflSession(req) {
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
      ...SIGNED_OUT, stage: 'secret_missing', cookies,
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

  const entitlementSecret = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!entitlementSecret) {
    return {
      valid: true, pro: false, user: { email: payload.email }, subscription: null,
      authority: 'vercel-local', stage: 'entitlement_secret_missing', cookies,
      degraded: true, error: 'entitlement_secret_not_configured',
      signing: { mode: signing.mode, verified_by: signatureSource },
    };
  }

  let subscription = null;
  try {
    subscription = await entitlementByEmail(payload.email, entitlementSecret);
  } catch (error) {
    return {
      valid: true, pro: false, user: { email: payload.email }, subscription: null,
      authority: 'vercel-local', stage: 'entitlement_lookup_failed', cookies,
      degraded: true, error: String(error?.message || 'entitlement_unavailable'),
      signing: { mode: signing.mode, verified_by: signatureSource },
    };
  }

  return {
    valid: true,
    pro: Boolean(subscription),
    user: { email: payload.email },
    subscription,
    authority: 'vercel-local',
    stage: subscription ? 'entitlement_active' : 'entitlement_missing',
    cookies,
    degraded: false,
    signing: { mode: signing.mode, verified_by: signatureSource },
  };
}

export function verifiedEmail(session) {
  const email = String(session?.user?.email || '').trim().toLowerCase();
  return session?.valid && /^\S+@\S+\.\S+$/.test(email) ? email : '';
}
