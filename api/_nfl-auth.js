const APP_ORIGIN = 'https://nfl.propbetedge.ai';
const DEFAULT_AUTH_WORKER_URL = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';

export async function getNflSession(req) {
  const workerBase = String(process.env.NFL_AUTH_WORKER_URL || DEFAULT_AUTH_WORKER_URL).trim().replace(/\/$/, '');
  const response = await fetch(`${workerBase}/v1/auth/session`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      origin: APP_ORIGIN,
      cookie: req.headers.cookie || '',
    },
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error || `auth_session_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export function verifiedEmail(session) {
  const email = String(session?.user?.email || '').trim().toLowerCase();
  return session?.valid && /^\S+@\S+\.\S+$/.test(email) ? email : '';
}
