/* PropBetEdge NFL — magic link landing.
 * Exchanges the Worker-signed magic JWT for a session JWT, then writes ONE
 * host-only session cookie and purges every historical `pbe_nfl_session`
 * variant (host-only and `.propbetedge.ai`) that could otherwise shadow it.
 * Never logs the token. */

import { sessionCookie, purgeCookies } from './_nfl-auth.js';

const APP_ORIGIN = 'https://nfl.propbetedge.ai';
const DEFAULT_AUTH_WORKER = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';

function safeReason(value, fallback) {
  return String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || fallback;
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method not allowed');
  }

  const token = typeof req.query?.token === 'string' ? req.query.token.trim() : '';
  if (!token || token.length > 1200) {
    console.error('[auth-verify] stage=bad_request token_present=%s', Boolean(token));
    return res.redirect(302, `${APP_ORIGIN}/?auth=invalid`);
  }

  const workerBase = String(process.env.NFL_AUTH_WORKER_URL || DEFAULT_AUTH_WORKER).trim().replace(/\/$/, '');

  try {
    const response = await fetch(`${workerBase}/v1/auth/exchange`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        origin: APP_ORIGIN,
      },
      cache: 'no-store',
      body: JSON.stringify({ token }),
    });

    const body = await response.json().catch(() => ({}));
    const sessionToken = String(body?.session_token || '');

    if (!response.ok || sessionToken.length < 40) {
      const reason = safeReason(body?.error, `exchange_${response.status}`);
      console.error('[auth-verify] stage=exchange_failed status=%s reason=%s', response.status, reason);
      return res.redirect(302, `${APP_ORIGIN}/?auth=${encodeURIComponent(reason)}`);
    }

    /* Purge first, set last: the browser applies these in order, so the
     * authoritative cookie is always the survivor. */
    const cookies = [...purgeCookies(), sessionCookie(sessionToken)];
    res.setHeader('Set-Cookie', cookies);

    console.log(
      '[auth-verify] stage=session_established exchange=200 token_bytes=%d cookies_emitted=%d',
      sessionToken.length,
      cookies.length
    );
    return res.redirect(302, `${APP_ORIGIN}/?auth=complete&session=established`);
  } catch (error) {
    console.error('[auth-verify] stage=exchange_unavailable reason=%s', safeReason(error?.message, 'network'));
    return res.redirect(302, `${APP_ORIGIN}/?auth=exchange_unavailable`);
  }
}
