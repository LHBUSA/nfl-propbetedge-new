/* PropBetEdge NFL — the one server-side NFL access lookup.
 *
 * Shared, byte-for-byte, by BOTH runtimes that decide NFL access:
 *   · Vercel  api/_nfl-auth.js          (session answer + premium routes)
 *   · Worker  workers/nfl-auth          (magic-link request + exchange)
 * so the question "may this email open NFL Pro right now?" has one answer and
 * the two cannot drift. No Node built-ins, no process.env: callers pass config.
 *
 * NFL means NFL. The answer comes only from nfl_subscriptions rows judged by
 * the strict predicate in _nfl-entitlement.js (exact NFL price ids, exact
 * normalized email, active/trialing recurring with Stripe ids and a bounded
 * future period, or a valid NFL season pass), or from an owner email named in
 * server configuration. Any other sport's subscription, a known customer, an
 * existing identity or a bare status=active row grants nothing.
 *
 * PropBetEdge All Access (2026-09-24) is the one ADDITIVE source on top of that:
 * when, and only when, the NFL ledger denies, the shared billing Worker
 * (propbetedge-sports-billing POST /v1/entitlement) is asked whether the same
 * verified email holds an active pbe_all_access subscription. That ledger stays
 * the source of truth: nothing is copied into nfl_subscriptions. The NFL
 * predicate itself is never weakened, and an All Access service that cannot
 * answer grants nothing (the NFL denial stands exactly as before).
 */

import { selectNflEntitlement, ilikeLiteral, normalizeEmail } from './_nfl-entitlement.js';

export const DEFAULT_NFL_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';

/* A slow ledger must never hold an answer open: past this it is unavailable,
   never granted and never "no subscription". */
export const ENTITLEMENT_TIMEOUT_MS = 4000;

/* PropBetEdge All Access: read through the shared billing Worker, server to
   server, with its bearer read token. Never a browser, never a Supabase key. */
export const ALL_ACCESS_PRODUCT_KEY = 'pbe_all_access';
export const DEFAULT_PBE_BILLING_URL = 'https://propbetedge-sports-billing.sales-fd3.workers.dev';
export const ALL_ACCESS_TIMEOUT_MS = 2500;
const ALL_ACCESS_GRANTING_STATUS = new Set(['active', 'trialing']);

export const ENTITLEMENT_ROW_FIELDS = 'customer_email,status,current_period_end,cancel_at_period_end,stripe_price_id,stripe_subscription_id,stripe_customer_id,stripe_checkout_session_id,created_at';

/* Supabase's modern sb_secret_* keys are API keys, not JWTs. They must be sent
 * on `apikey` only. Legacy service_role JWTs still use both apikey and Bearer. */
export function supabaseAdminHeaders(secret) {
  const key = String(secret || '').trim();
  const headers = { apikey: key, accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  return headers;
}

/* Owners are named only in server configuration (NFL_OWNER_EMAILS). */
export function parseOwnerEmails(value) {
  return String(value || '').split(',').map(normalizeEmail).filter(Boolean);
}

/** Every nfl_subscriptions row for the email, judged by the strict predicate.
 *  Throws `entitlement_*` when the ledger cannot answer. */
export async function lookupNflEntitlement(email, { supabaseUrl, serviceKey, fetchImpl = fetch, timeoutMs = ENTITLEMENT_TIMEOUT_MS, nowMs } = {}) {
  const verified = normalizeEmail(email);
  if (!verified) return { entitled: false, reason: 'unverified_email', status: null, plan: null };
  const key = String(serviceKey || '').trim();
  if (!key) throw new Error('entitlement_secret_missing');
  const base = String(supabaseUrl || DEFAULT_NFL_SUPABASE_URL).replace(/\/$/, '');
  const q = `customer_email=ilike.${encodeURIComponent(ilikeLiteral(verified))}&select=${ENTITLEMENT_ROW_FIELDS}&order=created_at.desc&limit=25`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${base}/rest/v1/nfl_subscriptions?${q}`, {
      headers: supabaseAdminHeaders(key),
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
  return selectNflEntitlement(rows, verified, nowMs ?? Date.now());
}

/** Does this verified email hold an ACTIVE PropBetEdge All Access subscription?
 *  Asks the shared billing Worker for product_key pbe_all_access. Returns an
 *  entitlement verdict shaped like the NFL one (plan 'all_access'); throws
 *  `all_access_*` when the service cannot answer. Identity exceptions the
 *  billing Worker makes for its own owner list are NOT accepted here: only a
 *  real active/trialing pbe_all_access subscription with a future period end. */
export async function lookupAllAccess(email, { billingUrl, readToken, fetchImpl = fetch, timeoutMs = ALL_ACCESS_TIMEOUT_MS, nowMs } = {}) {
  const verified = normalizeEmail(email);
  if (!verified) return { entitled: false, reason: 'unverified_email', status: null, plan: null };
  const token = String(readToken || '').trim();
  if (!token) throw new Error('all_access_not_configured');
  const base = String(billingUrl || DEFAULT_PBE_BILLING_URL).replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${base}/v1/entitlement`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email: verified, product_key: ALL_ACCESS_PRODUCT_KEY }),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(error?.name === 'AbortError' ? 'all_access_timeout' : 'all_access_network');
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`all_access_${response.status}`);
  const body = await response.json().catch(() => { throw new Error('all_access_unreadable'); });
  if (!body || body.product_key !== ALL_ACCESS_PRODUCT_KEY || typeof body.entitled !== 'boolean') throw new Error('all_access_unreadable');
  const sub = body.subscription;
  const status = String(sub?.status || '').trim().toLowerCase();
  if (body.entitled !== true) return { entitled: false, reason: sub ? 'all_access_inactive' : 'no_all_access', status: status || null, plan: sub ? 'all_access' : null };
  if (body.access_source === 'owner' || !sub || sub.product_key !== ALL_ACCESS_PRODUCT_KEY) {
    return { entitled: false, reason: 'all_access_without_subscription', status: status || null, plan: null };
  }
  const now = nowMs ?? Date.now();
  const end = sub.current_period_end ? Date.parse(sub.current_period_end) : NaN;
  if (!ALL_ACCESS_GRANTING_STATUS.has(status)) return { entitled: false, reason: 'all_access_inactive', status, plan: 'all_access' };
  if (!Number.isFinite(end)) return { entitled: false, reason: 'all_access_invalid_expiry', status, plan: 'all_access' };
  if (end <= now) return { entitled: false, reason: 'all_access_expired', status, plan: 'all_access' };
  return {
    entitled: true,
    reason: 'all_access',
    product: 'nfl',
    plan: 'all_access',
    billing: 'recurring',
    source: ALL_ACCESS_PRODUCT_KEY,
    status,
    current_period_end: new Date(end).toISOString(),
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    stripe_price_id: null,
  };
}

/** The NFL verdict for a verified email, then, only when it denies and the
 *  All Access bridge is configured, the All Access verdict. The NFL ledger
 *  failing still throws (unavailable, as before). The All Access service
 *  failing never grants and never turns the NFL denial into an outage: the
 *  denial is returned as it stands, annotated with why All Access was not
 *  consulted or could not answer. Shared by Vercel and the auth Worker. */
export async function lookupNflAccessVerdict(email, { allAccess, ...ledger } = {}) {
  const verdict = await lookupNflEntitlement(email, ledger);
  if (verdict.entitled === true) return verdict;
  if (!allAccess || !String(allAccess.readToken || '').trim()) return { ...verdict, all_access: 'not_configured' };
  try {
    const all = await lookupAllAccess(email, { ...allAccess, nowMs: ledger.nowMs });
    if (all.entitled === true) return all;
    return { ...verdict, all_access: all.reason };
  } catch (error) {
    return { ...verdict, all_access: 'unavailable', all_access_error: String(error?.message || 'all_access_unavailable') };
  }
}

/** May this email open NFL Pro right now? Owner (server config), a current
 *  NFL entitlement, or a current PropBetEdge All Access subscription. Returns
 *  { allowed, role, verdict }; throws when the NFL ledger cannot answer, which
 *  every caller must treat as NOT allowed. */
export async function resolveNflAccess(email, { ownerEmails = [], ...access } = {}) {
  const verified = normalizeEmail(email);
  if (!verified) return { allowed: false, role: null, verdict: { entitled: false, reason: 'unverified_email', status: null, plan: null } };
  if (ownerEmails.includes(verified)) {
    return { allowed: true, role: 'owner', verdict: { entitled: true, reason: 'owner', plan: 'owner' } };
  }
  const verdict = await lookupNflAccessVerdict(verified, access);
  return { allowed: verdict.entitled === true, role: verdict.entitled === true ? 'subscriber' : null, verdict };
}
