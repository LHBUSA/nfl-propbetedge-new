const APP_ORIGIN = 'https://nfl.propbetedge.ai';
const DEFAULT_AUTH_WORKER_URL = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';
const VALID_PLANS = new Set(['season','weekly']);

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  const workerBase = String(process.env.NFL_AUTH_WORKER_URL || DEFAULT_AUTH_WORKER_URL).trim().replace(/\/$/, '');

  if (req.method === 'GET') {
    try {
      const upstream = await fetch(`${workerBase}/health`, { headers: { accept: 'application/json' }, cache: 'no-store' });
      const body = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json({ ...body, transport: 'cloudflare-worker', worker: workerBase });
    } catch (error) {
      console.error('[auth-email] Worker health failed', error?.message || error);
      return res.status(503).json({ enabled: false, provider: 'resend', auth_issuer: 'propbetedge', transport: 'cloudflare-worker', error: 'Auth service unavailable.' });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  const plan = VALID_PLANS.has(String(req.body?.plan || '')) ? String(req.body.plan) : '';
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  try {
    const upstream = await fetch(`${workerBase}/v1/auth/request`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        origin: APP_ORIGIN,
      },
      cache: 'no-store',
      body: JSON.stringify({ email, plan: plan || undefined }),
    });
    const body = await upstream.json().catch(() => ({}));
    return res.status(upstream.status).json({ ...body, transport: 'cloudflare-worker' });
  } catch (error) {
    console.error('[auth-email] Worker request failed', error?.message || error);
    return res.status(503).json({ error: 'PropBetEdge email sign-in is temporarily unavailable.', provider: 'resend', auth_issuer: 'propbetedge', transport: 'cloudflare-worker' });
  }
}