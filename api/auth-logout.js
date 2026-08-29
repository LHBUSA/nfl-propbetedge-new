const APP_ORIGIN = 'https://nfl.propbetedge.ai';
const DEFAULT_AUTH_WORKER_URL = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const workerBase = String(process.env.NFL_AUTH_WORKER_URL || DEFAULT_AUTH_WORKER_URL).trim().replace(/\/$/, '');

  try {
    const upstream = await fetch(`${workerBase}/v1/auth/logout`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        origin: APP_ORIGIN,
        cookie: req.headers.cookie || '',
      },
      cache: 'no-store',
    });

    const setCookie = upstream.headers.get('set-cookie');
    if (setCookie) res.setHeader('Set-Cookie', setCookie);
    const body = await upstream.json().catch(() => ({ ok: upstream.ok }));
    return res.status(upstream.status).json(body);
  } catch (error) {
    console.error('[auth-logout] Worker logout failed', error?.message || error);
    res.setHeader('Set-Cookie', 'pbe_nfl_session=; Domain=.propbetedge.ai; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    return res.status(200).json({ ok: true, degraded: true });
  }
}
