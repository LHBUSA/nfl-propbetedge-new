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

  const token = req.method === 'POST'
    ? String(req.body?.token || '').trim()
    : typeof req.query?.token === 'string' ? req.query.token.trim() : '';

  if (!token || token.length > 1200) {
    console.error('[auth-verify] stage=bad_request token_present=%s', Boolean(token));
    return res.redirect(302, `${APP_ORIGIN}/?auth=invalid`);
  }

  /* GET is intentionally read-only. Mobile mail apps and security scanners
     routinely pre-open links; only the explicit form POST below may exchange
     the one-time token for a session. */
  if (req.method === 'GET') {
    const safe = token.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(200).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><title>Continue sign-in · PropBetEdge</title><style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#090b0d;color:#f5f2e8}body{min-height:100dvh;display:grid;place-items:center;padding:20px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif}.card{width:min(100%,460px);padding:28px 22px;border:1px solid #393628;border-radius:18px;background:linear-gradient(180deg,#151914,#0e110f);box-shadow:0 24px 70px rgba(0,0,0,.45)}.brand{font:700 24px/1 Georgia,serif}.brand b{color:#d4af37}.eyebrow{margin-top:8px;font:700 10px/1.4 monospace;letter-spacing:.16em;color:#d4af37}h1{margin:30px 0 10px;font-size:30px;line-height:1.05}p{margin:0;color:#b8c0ba;font-size:15px;line-height:1.6}form{margin-top:24px}button{display:block;width:100%;min-height:56px;border:1px solid #e0c45a;border-radius:11px;background:#d4af37;color:#090b0d;font:800 16px/1.1 inherit;cursor:pointer}</style></head><body><main class="card"><div class="brand">PROPBETEDGE <b>/</b></div><div class="eyebrow">NFL · SECURE MEMBER ACCESS</div><h1>Finish signing in.</h1><p>This final tap confirms it is really you opening the email. Your link has not been used yet.</p><form method="post" action="/api/auth-verify"><input type="hidden" name="token" value="${safe}"><button type="submit">Continue to PropBetEdge</button></form></main></body></html>`);
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).send('Method not allowed');
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
