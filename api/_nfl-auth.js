/* PropBetEdge NFL — single session authority.
 *
 * ONE cookie name, ONE scope, ONE verifier.
 *
 * Every session answer carries an `access` verdict for the NFL Pro layer:
 *   anonymous       no verified session
 *   no_entitlement  verified email, no qualifying NFL purchase
 *   granted         a qualifying NFL purchase (_nfl-entitlement.js), or the
 *                   verified owner (NFL_OWNER_EMAILS, server env only)
 *   unavailable     the check could not be completed; never read as granted
 *
 * Access is additive: the public NFL site never waits on this answer. Only
 * premium routes (pro-model, pbe-picks current/decision/history/receipt,
 * pbe-prop-picks current) refuse without `pro === true`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { selectNflEntitlement, ilikeLiteral, normalizeEmail } from './_nfl-entitlement.js';

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

/* A slow ledger must never hold the session answer (or a premium route) open:
   past this it is `unavailable`, not granted and not "no subscription". */
export const ENTITLEMENT_TIMEOUT_MS = 4000;

const ROW_FIELDS = 'customer_email,status,current_period_end,cancel_at_period_end,stripe_price_id,stripe_subscription_id,stripe_customer_id,stripe_checkout_session_id,created_at';

/* Every nfl_subscriptions row for the email, judged by the pure predicate in
   _nfl-entitlement.js. Throws when the ledger cannot answer. */
async function entitlementByEmail(email, secret) {
  const base = String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
  const q = `customer_email=ilike.${encodeURIComponent(ilikeLiteral(email))}&select=${ROW_FIELDS}&order=created_at.desc&limit=25`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENTITLEMENT_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${base}/rest/v1/nfl_subscriptions?${q}`, {
      headers: supabaseAdminHeaders(secret),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(error?.name === 'AbortError' ? 'entitlement_timeout' : 'entitlement_network');
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`entitlement_${response.status}`);
  const rows = await response.json().catch(() => { throw new Error('entitlement_unreadable'); });
  if (!Array.isArray(rows)) throw new Error('entitlement_unreadable');
  return selectNflEntitlement(rows, email);
}

/* The owner is named only in server env. It is honoured only for an email the
   session signature proves (a Resend magic link exchanged by the auth Worker);
   nothing a browser sends can name it. */
export function ownerEmails() {
  return String(process.env.NFL_OWNER_EMAILS || '').split(',').map(normalizeEmail).filter(Boolean);
}

export function isOwnerEmail(email) {
  const e = normalizeEmail(email);
  return Boolean(e) && ownerEmails().includes(e);
}

const SIGNED_OUT = {
  valid: false, pro: false, access: 'anonymous', role: null, entitlement: null,
  user: null, subscription: null, authority: 'vercel-local', degraded: false,
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
      ...SIGNED_OUT, access: 'unavailable', stage: 'secret_missing', cookies,
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

  const signingInfo = { mode: signing.mode, verified_by: signatureSource };
  const user = { email: payload.email };

  if (isOwnerEmail(payload.email)) {
    return {
      valid: true, pro: true, access: 'granted', role: 'owner',
      entitlement: { reason: 'owner', plan: 'owner' },
      user, subscription: null, authority: 'vercel-local', stage: 'owner_verified',
      cookies, degraded: false, signing: signingInfo,
    };
  }

  const entitlementSecret = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!entitlementSecret) {
    return {
      valid: true, pro: false, access: 'unavailable', role: null, entitlement: null,
      user, subscription: null, authority: 'vercel-local', stage: 'entitlement_secret_missing', cookies,
      degraded: true, error: 'entitlement_secret_not_configured', signing: signingInfo,
    };
  }

  let verdict;
  try {
    verdict = await entitlementByEmail(payload.email, entitlementSecret);
  } catch (error) {
    return {
      valid: true, pro: false, access: 'unavailable', role: null, entitlement: null,
      user, subscription: null, authority: 'vercel-local', stage: 'entitlement_lookup_failed', cookies,
      degraded: true, error: String(error?.message || 'entitlement_unavailable'), signing: signingInfo,
    };
  }

  if (verdict.entitled) {
    return {
      valid: true, pro: true, access: 'granted', role: 'subscriber',
      entitlement: { reason: 'entitled', plan: verdict.plan, billing: verdict.billing },
      user,
      subscription: {
        status: verdict.status,
        plan: verdict.plan,
        current_period_end: verdict.current_period_end,
        cancel_at_period_end: verdict.cancel_at_period_end,
        stripe_price_id: verdict.stripe_price_id,
      },
      authority: 'vercel-local', stage: 'entitlement_active', cookies, degraded: false, signing: signingInfo,
    };
  }

  return {
    valid: true, pro: false, access: 'no_entitlement', role: null,
    entitlement: { reason: verdict.reason, plan: verdict.plan || null, status: verdict.status || null },
    user, subscription: null, authority: 'vercel-local', stage: 'entitlement_missing', cookies,
    degraded: false, signing: signingInfo,
  };
}

export function verifiedEmail(session) {
  const email = String(session?.user?.email || '').trim().toLowerCase();
  return session?.valid && /^\S+@\S+\.\S+$/.test(email) ? email : '';
}
