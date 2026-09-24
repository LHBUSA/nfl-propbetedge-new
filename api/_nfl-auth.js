/* PropBetEdge NFL — single session authority.
 *
 * ONE cookie name, ONE scope, ONE verifier.
 *
 * Every session answer carries an `access` verdict for the NFL Pro layer:
 *   anonymous       no verified session
 *   no_entitlement  verified email, no qualifying NFL purchase
 *   granted         a qualifying NFL purchase (_nfl-entitlement.js), an active
 *                   PropBetEdge All Access subscription (shared billing ledger,
 *                   additive, fail closed), or the verified owner
 *                   (NFL_OWNER_EMAILS, server env only)
 *   unavailable     the check could not be completed; never read as granted
 *
 * Access is additive: the public NFL site never waits on this answer. Only
 * premium routes (pro-model, pbe-picks current/decision/history/receipt,
 * pbe-prop-picks current) refuse without `pro === true`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeEmail } from './_nfl-entitlement.js';
import { lookupNflAccessVerdict, parseOwnerEmails, supabaseAdminHeaders, ENTITLEMENT_TIMEOUT_MS, DEFAULT_NFL_SUPABASE_URL, DEFAULT_PBE_BILLING_URL } from './_nfl-entitlement-ledger.js';
import { deriveMembership } from './_pbe-membership.js';

export { supabaseAdminHeaders, ENTITLEMENT_TIMEOUT_MS };

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

/* PropBetEdge All Access bridge configuration: server env only. Without the
   read token the bridge is off and NFL decides exactly as before. */
export function allAccessConfig() {
  return {
    billingUrl: process.env.PBE_BILLING_URL || DEFAULT_PBE_BILLING_URL,
    readToken: String(process.env.PBE_ENTITLEMENT_READ_TOKEN || '').trim(),
  };
}

/* Every nfl_subscriptions row for the email, judged by the pure predicate in
   _nfl-entitlement.js through the lookup the auth Worker shares
   (_nfl-entitlement-ledger.js); when NFL denies, the shared All Access ledger
   is asked (additive, fail closed). Throws when the NFL ledger cannot answer. */
function entitlementByEmail(email, secret) {
  return lookupNflAccessVerdict(email, {
    supabaseUrl: process.env.SUPABASE_URL || DEFAULT_NFL_SUPABASE_URL,
    serviceKey: secret,
    allAccess: allAccessConfig(),
  });
}

/* The owner is named only in server env. It is honoured only for an email the
   session signature proves (a Resend magic link exchanged by the auth Worker);
   nothing a browser sends can name it. */
export function ownerEmails() {
  return parseOwnerEmails(process.env.NFL_OWNER_EMAILS);
}

export function isOwnerEmail(email) {
  const e = normalizeEmail(email);
  return Boolean(e) && ownerEmails().includes(e);
}

/* The shared PropBetEdge membership contract (api/_pbe-membership.js, a
 * byte-identical copy of propbetedge-workers shared/membership). It is derived
 * here, once, from the verdict this file already reached; it never changes a
 * grant or denial. Anything that is not a granted NFL verdict is FREE. */
export function nflMembership({ entitled = false, accessSource = null, plan = null, email = null, currentPeriodEnd = null, cancelAtPeriodEnd = false, legacyTier = null } = {}) {
  const allAccess = accessSource === 'all_access';
  return deriveMembership({
    sport: 'nfl', entitled: Boolean(entitled), accessSource,
    productKey: allAccess ? 'pbe_all_access' : 'nfl_pro',
    plan, email, currentPeriodEnd, cancelAtPeriodEnd, legacyTier,
  });
}

const FREE_MEMBERSHIP = Object.freeze(nflMembership({ entitled: false }));

const SIGNED_OUT = {
  valid: false, pro: false, access: 'anonymous', role: null, entitlement: null,
  user: null, subscription: null, authority: 'vercel-local', degraded: false,
  membership: FREE_MEMBERSHIP,
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
  const freeMembership = nflMembership({ entitled: false, email: payload.email });

  if (isOwnerEmail(payload.email)) {
    return {
      valid: true, pro: true, access: 'granted', role: 'owner',
      entitlement: { reason: 'owner', plan: 'owner' },
      user, subscription: null, authority: 'vercel-local', stage: 'owner_verified',
      cookies, degraded: false, signing: signingInfo,
      membership: nflMembership({ entitled: true, accessSource: 'owner', plan: 'owner', email: payload.email }),
    };
  }

  const entitlementSecret = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!entitlementSecret) {
    return {
      valid: true, pro: false, access: 'unavailable', role: null, entitlement: null,
      user, subscription: null, authority: 'vercel-local', stage: 'entitlement_secret_missing', cookies,
      degraded: true, error: 'entitlement_secret_not_configured', signing: signingInfo,
      membership: freeMembership,
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
      membership: freeMembership,
    };
  }

  if (verdict.entitled) {
    /* pbe_all_access is the shared network umbrella; every other granted NFL
       verdict is the sport's own plan. */
    const accessSource = verdict.source === 'pbe_all_access' ? 'all_access' : 'sport';
    return {
      valid: true, pro: true, access: 'granted', role: 'subscriber',
      entitlement: { reason: 'entitled', plan: verdict.plan, billing: verdict.billing, source: verdict.source || 'nfl' },
      user,
      subscription: {
        status: verdict.status,
        plan: verdict.plan,
        current_period_end: verdict.current_period_end,
        cancel_at_period_end: verdict.cancel_at_period_end,
        stripe_price_id: verdict.stripe_price_id,
        source: verdict.source || 'nfl',
      },
      authority: 'vercel-local', stage: 'entitlement_active', cookies, degraded: false, signing: signingInfo,
      membership: nflMembership({
        entitled: true, accessSource, plan: verdict.plan, email: payload.email,
        currentPeriodEnd: verdict.current_period_end, cancelAtPeriodEnd: verdict.cancel_at_period_end,
        /* The legacy one-time NFL pass (never sold any more) is a sport_pro
           legacy tier in the contract: nothing to manage, no renewal. */
        legacyTier: accessSource === 'sport' && verdict.billing === 'one_time' ? 'season_pass' : null,
      }),
    };
  }

  return {
    valid: true, pro: false, access: 'no_entitlement', role: null,
    entitlement: { reason: verdict.reason, plan: verdict.plan || null, status: verdict.status || null, all_access: verdict.all_access || null },
    user, subscription: null, authority: 'vercel-local', stage: 'entitlement_missing', cookies,
    degraded: false, signing: signingInfo, membership: freeMembership,
  };
}

export function verifiedEmail(session) {
  const email = String(session?.user?.email || '').trim().toLowerCase();
  return session?.valid && /^\S+@\S+\.\S+$/.test(email) ? email : '';
}
