/* PropBetEdge NFL — auth self-diagnosis.
 *
 * Proves the whole chain without ever emitting a secret or a token:
 *   worker_reachable   Worker answers /v1/auth/selftest
 *   secret_parity      the probe JWT the Worker signed verifies with THIS
 *                      deployment's SUPABASE_SERVICE_ROLE_KEY, i.e. both sides
 *                      hold the identical key under the identical namespace
 *   entitlement_store  Supabase REST accepts this deployment's key
 *   cookies            how many `pbe_nfl_session_v2` / legacy `pbe_nfl_session`
 *                      values this browser actually sent, and whether any of
 *                      them verifies as a session
 *
 * Nothing here echoes the probe token, the service-role key, the Resend key or
 * the Stripe key. Cookie values are reported only as counts and verdicts. */

import {
  SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
  HMAC_NAMESPACE,
  readCookieValues,
  verifyWorkerJwt,
} from './_nfl-auth.js';

const APP_ORIGIN = 'https://nfl.propbetedge.ai';
const DEFAULT_AUTH_WORKER = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';
const DEFAULT_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const workerBase = String(process.env.NFL_AUTH_WORKER_URL || DEFAULT_AUTH_WORKER).trim().replace(/\/$/, '');

  const report = {
    app_origin: APP_ORIGIN,
    hmac_namespace: HMAC_NAMESPACE,
    session_cookie: SESSION_COOKIE,
    service_role_key_present: Boolean(secret),
    worker: { base: workerBase, reachable: false, version: null, status: null },
    secret_parity: null,
    entitlement_store: { reachable: false, status: null },
    cookies: {
      [SESSION_COOKIE]: { count: 0, verifies: false, reason: null },
      [LEGACY_SESSION_COOKIE]: { count: 0, verifies: false, reason: null },
    },
  };

  /* 1. Worker reachability + secret parity via a non-session probe token. */
  let probeToken = '';
  try {
    const response = await fetch(`${workerBase}/v1/auth/selftest`, {
      headers: { accept: 'application/json', origin: APP_ORIGIN },
      cache: 'no-store',
    });
    report.worker.status = response.status;
    const body = await response.json().catch(() => ({}));
    report.worker.reachable = response.ok;
    report.worker.version = body?.version || null;
    probeToken = String(body?.probe_token || '');
  } catch (error) {
    report.worker.error = String(error?.message || 'worker_unreachable').slice(0, 120);
  }

  if (!secret) {
    report.secret_parity = 'unknown_no_local_key';
  } else if (!probeToken) {
    report.secret_parity = 'unknown_no_probe';
  } else {
    try {
      verifyWorkerJwt(probeToken, secret, 'probe');
      report.secret_parity = 'match';
    } catch (error) {
      report.secret_parity = `mismatch:${String(error?.message || 'verify_failed')}`;
    }
  }

  /* 2. Does Supabase accept this deployment's key? No row data is returned.
   *
   * Probes BOTH the SUPABASE_URL env value and the hardcoded project URL that
   * api/stripe-webhook.js already uses, because a wrong env URL and a rotated
   * key produce the same 401 and are otherwise indistinguishable. The project
   * URL and Supabase's own error text are not secrets; the key never is. */
  const envBase = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const bases = [
    { label: 'env', url: envBase || null },
    { label: 'repo_default', url: DEFAULT_SUPABASE_URL },
  ];

  async function probeSupabase(url) {
    try {
      const response = await fetch(`${url}/rest/v1/nfl_subscriptions?select=status&limit=1`, {
        headers: { apikey: secret, authorization: `Bearer ${secret}`, accept: 'application/json' },
        cache: 'no-store',
      });
      const detail = response.ok ? '' : await response.text().catch(() => '');
      let message = '';
      if (detail) {
        try { const body = JSON.parse(detail); message = String(body?.message || body?.msg || body?.error || detail); }
        catch (_) { message = detail; }
      }
      return { status: response.status, ok: response.ok, message: message.slice(0, 160) || null };
    } catch (error) {
      return { status: null, ok: false, message: String(error?.message || 'unreachable').slice(0, 160) };
    }
  }

  if (secret) {
    /* Shape only, never the value. Distinguishes a legacy service_role JWT from
     * the newer sb_secret_ format, which is what a key rotation looks like. */
    report.service_role_key_format = secret.startsWith('eyJ') ? 'legacy_jwt'
      : secret.startsWith('sb_secret_') ? 'sb_secret'
      : secret.startsWith('sb_publishable_') ? 'sb_publishable_WRONG_KEY'
      : 'unrecognized';

    report.entitlement_store.probes = {};
    for (const { label, url } of bases) {
      if (!url) { report.entitlement_store.probes[label] = { configured: false }; continue; }
      const result = await probeSupabase(url);
      report.entitlement_store.probes[label] = { url, ...result };
      if (result.ok && !report.entitlement_store.reachable) {
        report.entitlement_store.reachable = true;
        report.entitlement_store.status = result.status;
        report.entitlement_store.working_base = url;
      }
    }
    if (!report.entitlement_store.reachable) {
      const primary = report.entitlement_store.probes.env?.configured === false
        ? report.entitlement_store.probes.repo_default
        : report.entitlement_store.probes.env;
      report.entitlement_store.status = primary?.status ?? null;
      report.entitlement_store.error = primary?.message || 'supabase_rejected_key';
    }
  }

  /* 3. What this browser actually sent. Counts and verdicts only. */
  const header = req.headers?.cookie || '';
  for (const name of [SESSION_COOKIE, LEGACY_SESSION_COOKIE]) {
    const values = readCookieValues(header, name);
    report.cookies[name].count = values.length;
    if (!secret || !values.length) continue;
    let reason = null;
    for (const value of values) {
      try {
        verifyWorkerJwt(value, secret, 'session');
        report.cookies[name].verifies = true;
        reason = null;
        break;
      } catch (error) {
        reason = String(error?.message || 'token_invalid');
      }
    }
    report.cookies[name].reason = reason;
  }

  report.verdict = report.secret_parity === 'match' && report.entitlement_store.reachable
    ? 'auth_backend_healthy'
    : 'auth_backend_misconfigured';

  console.log(
    '[auth-diag] parity=%s worker=%s entitlement=%s cookies_v2=%d cookies_legacy=%d',
    report.secret_parity,
    report.worker.reachable,
    report.entitlement_store.reachable,
    report.cookies[SESSION_COOKIE].count,
    report.cookies[LEGACY_SESSION_COOKIE].count
  );

  return res.status(200).json(report);
}
