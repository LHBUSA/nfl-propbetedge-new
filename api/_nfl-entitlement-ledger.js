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
 */

import { selectNflEntitlement, ilikeLiteral, normalizeEmail } from './_nfl-entitlement.js';

export const DEFAULT_NFL_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';

/* A slow ledger must never hold an answer open: past this it is unavailable,
   never granted and never "no subscription". */
export const ENTITLEMENT_TIMEOUT_MS = 4000;

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

/** May this email open NFL Pro right now? Owner (server config) or a current
 *  NFL entitlement. Returns { allowed, role, verdict }; throws when the ledger
 *  cannot answer, which every caller must treat as NOT allowed. */
export async function resolveNflAccess(email, { ownerEmails = [], ...ledger } = {}) {
  const verified = normalizeEmail(email);
  if (!verified) return { allowed: false, role: null, verdict: { entitled: false, reason: 'unverified_email', status: null, plan: null } };
  if (ownerEmails.includes(verified)) {
    return { allowed: true, role: 'owner', verdict: { entitled: true, reason: 'owner', plan: 'owner' } };
  }
  const verdict = await lookupNflEntitlement(verified, ledger);
  return { allowed: verdict.entitled === true, role: verdict.entitled === true ? 'subscriber' : null, verdict };
}
