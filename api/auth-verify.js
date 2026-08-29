const APP_ORIGIN = 'https://nfl.propbetedge.ai';
const AUTH_WORKER = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';
const COOKIE_NAME = 'pbe_nfl_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

function clearLegacyDomainCookie() {
  return `${COOKIE_NAME}=; Domain=.propbetedge.ai; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method not allowed');
  }

  const token = typeof req.query?.token === 'string' ? req.query.token.trim() : '';
  if (!token || token.length > 1200) return res.redirect(302, `${APP_ORIGIN}/?auth=invalid`);

  try {
    const response = await fetch(`${AUTH_WORKER}/v1/auth/exchange`, {
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
    if (!response.ok || !sessionToken || sessionToken.length < 40) {
      const reason = String(body?.error || `exchange_${response.status}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
      console.error('[auth-verify] exchange failed', response.status, reason);
      return res.redirect(302, `${APP_ORIGIN}/?auth=${encodeURIComponent(reason || 'exchange_failed')}`);
    }

    res.setHeader('Set-Cookie', [
      clearLegacyDomainCookie(),
      sessionCookie(sessionToken),
    ]);
    return res.redirect(302, `${APP_ORIGIN}/?auth=complete&session=established`);
  } catch (error) {
    console.error('[auth-verify] exchange unavailable', error?.message || error);
    return res.redirect(302, `${APP_ORIGIN}/?auth=exchange_unavailable`);
  }
}
