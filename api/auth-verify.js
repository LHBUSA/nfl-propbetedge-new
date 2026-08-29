const APP_ORIGIN = 'https://nfl.propbetedge.ai';
const DEFAULT_AUTH_WORKER_URL = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';
const COOKIE_NAME = 'pbe_nfl_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const VALID_PLANS = new Set(['season','weekly']);

function extractSessionToken(setCookie) {
  const raw = String(setCookie || '');
  const match = raw.match(/(?:^|[,;]\s*)pbe_nfl_session=([^;,"]+)/i);
  return match?.[1] ? match[1].trim() : '';
}

function hostCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

function clearLegacyDomainCookie() {
  return `${COOKIE_NAME}=; Domain=.propbetedge.ai; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method not allowed');
  }

  const token = typeof req.query?.token === 'string' ? req.query.token.trim() : '';
  const plan = VALID_PLANS.has(String(req.query?.plan || '')) ? String(req.query.plan) : '';
  if (!token || token.length > 500) return res.redirect(302, `${APP_ORIGIN}/?auth=invalid`);

  const workerBase = String(process.env.NFL_AUTH_WORKER_URL || DEFAULT_AUTH_WORKER_URL).trim().replace(/\/$/, '');

  try {
    const params = new URLSearchParams({ token });
    if (plan) params.set('plan', plan);

    const upstream = await fetch(`${workerBase}/v1/auth/verify?${params.toString()}`, {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml' },
      redirect: 'manual',
      cache: 'no-store',
    });

    const location = upstream.headers.get('location');
    const upstreamCookie = upstream.headers.get('set-cookie');
    const sessionToken = extractSessionToken(upstreamCookie);

    if (upstream.status >= 300 && upstream.status < 400 && location && sessionToken) {
      // Important: set the authenticated session from nfl.propbetedge.ai itself.
      // First remove the legacy domain-scoped copy to prevent duplicate cookies
      // with the same name, then install one host-only cookie.
      res.setHeader('Set-Cookie', [
        clearLegacyDomainCookie(),
        hostCookie(sessionToken),
      ]);
      return res.redirect(302, `${APP_ORIGIN}/?auth=complete&session=established`);
    }

    // Do not silently bounce back into the sign-in modal if the Worker failed
    // to issue a session. Surface an explicit auth state instead.
    if (upstream.status >= 300 && upstream.status < 400 && location && !sessionToken) {
      console.error('[auth-verify] Worker verified link but did not expose session cookie');
      return res.redirect(302, `${APP_ORIGIN}/?auth=session_missing`);
    }

    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/html; charset=utf-8');
    return res.send(body);
  } catch (error) {
    console.error('[auth-verify] Worker verification failed', error?.message || error);
    return res.redirect(302, `${APP_ORIGIN}/?auth=unavailable`);
  }
}
