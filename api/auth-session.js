const APP_ORIGIN = 'https://nfl.propbetedge.ai';
const DEFAULT_AUTH_WORKER_URL = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const workerBase = String(process.env.NFL_AUTH_WORKER_URL || DEFAULT_AUTH_WORKER_URL).trim().replace(/\/$/, '');

  try {
    const upstream = await fetch(`${workerBase}/v1/auth/session`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        origin: APP_ORIGIN,
        cookie: req.headers.cookie || '',
      },
      cache: 'no-store',
    });

    const setCookie = upstream.headers.get('set-cookie');
    if (setCookie) res.setHeader('Set-Cookie', setCookie);
    const body = await upstream.json().catch(() => ({}));
    return res.status(upstream.status).json({ ...body, transport: 'cloudflare-worker' });
  } catch (error) {
    console.error('[auth-session] Worker session check failed', error?.message || error);
    return res.status(503).json({ error: 'session_unavailable', valid: false, pro: false, user: null, subscription: null });
  }
}
