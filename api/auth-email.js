const SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const PBE_LOGO = 'https://propbetedge.ai/logo/pbe-full-400.png';
const APP_ORIGIN = 'https://nfl.propbetedge.ai';
const DEFAULT_AUTH_WORKER_URL = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  const workerBase = String(process.env.NFL_AUTH_WORKER_URL || DEFAULT_AUTH_WORKER_URL).trim().replace(/\/$/, '');

  /* Cloudflare is canonical. The Vercel endpoint is only a same-origin gateway.
   * NFL_AUTH_WORKER_URL remains an optional override for future Worker moves. */
  return proxyToWorker(req, res, workerBase);
}

async function proxyToWorker(req, res, workerBase) {
  if (req.method === 'GET') {
    try {
      const upstream = await fetch(`${workerBase}/health`, { headers: { accept: 'application/json' }, cache: 'no-store' });
      const body = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json({ ...body, transport: 'cloudflare-worker', worker: workerBase });
    } catch (error) {
      console.error('[auth-email] Worker health failed', error?.message || error);
      return res.status(503).json({ enabled: false, provider: 'resend', transport: 'cloudflare-worker', error: 'Auth service unavailable.' });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  try {
    const upstream = await fetch(`${workerBase}/v1/auth/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: APP_ORIGIN,
      },
      body: JSON.stringify({ email }),
    });
    const body = await upstream.json().catch(() => ({}));
    return res.status(upstream.status).json({ ...body, transport: 'cloudflare-worker' });
  } catch (error) {
    console.error('[auth-email] Worker request failed', error?.message || error);
    return res.status(503).json({ error: 'PropBetEdge email sign-in is temporarily unavailable.', provider: 'resend', transport: 'cloudflare-worker' });
  }
}
