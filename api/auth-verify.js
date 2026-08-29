const APP_ORIGIN = 'https://nfl.propbetedge.ai';
const DEFAULT_AUTH_WORKER_URL = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';
const VALID_PLANS = new Set(['season','weekly']);

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

    const setCookie = upstream.headers.get('set-cookie');
    if (setCookie) res.setHeader('Set-Cookie', setCookie);

    const location = upstream.headers.get('location');
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      return res.redirect(upstream.status, location);
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